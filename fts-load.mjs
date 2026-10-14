// scripts/fts-load.mjs
// Usage:
//   node scripts/fts-load.mjs ./data/policies --collection hr-2025-v1
//   node scripts/fts-load.mjs ./data/policies --collection hr-2025-v1 --purge

import fs, { statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mammoth from "mammoth";
import * as cheerio from "cheerio";
import { ensureChunksTable, pool, sqlInsertChunk } from "../api/search.mjs";

// ---- pdf.js (ESM / Node) ----
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
const INGEST_PDF = process.env.INGEST_PDF === "1"; // default: skip PDFs on Windows

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Where pdf.js lives (fonts, worker)
const pdfjsNodeRoot = path.join(process.cwd(), "node_modules", "pdfjs-dist");
try {
  // setting workerSrc is best-effort; we still fall back to no worker below
  pdfjsLib.GlobalWorkerOptions.workerSrc = path.join(pdfjsNodeRoot, "build", "pdf.worker.mjs");
} catch { /* ignore */ }

const PDF_OPTS = {
  // Silence "standardFontDataUrl" warnings in Node
  standardFontDataUrl: path.join(pdfjsNodeRoot, "standard_fonts") + path.sep,
  disableFontFace: true,
  useSystemFonts: true,
  useXfa: false,
};

// -------- CLI args --------
const argv = process.argv.slice(2);
if (!argv[0]) {
  console.error("Please pass a folder. Example: node scripts/fts-load.mjs ./data/policies --collection hr-2025-v1");
  process.exit(1);
}
const folder = abs(argv[0]);
const collection = (() => {
  const i = argv.indexOf("--collection");
  return i >= 0 ? argv[i + 1] : "default";
})();
const PURGE = argv.includes("--purge");

// -------- helpers --------
function abs(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.resolve(__dirname, "..", p);
}
function cleanText(s) {
  return (s || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
/** Chunk by chars with overlap; 1200/200 works well for retrieval. */
function chunk(text, size = 1200, overlap = 200) {
  const t = cleanText(text);
  if (!t) return [];
  const out = [];
  let i = 0;
  while (i < t.length) {
    out.push(t.slice(i, i + size));
    i += Math.max(1, size - overlap);
  }
  return out;
}

async function readPdfText(buf) {
  // Ensure plain Uint8Array
  let data;
  if (Buffer.isBuffer(buf)) data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  else if (buf instanceof Uint8Array) data = new Uint8Array(buf);
  else data = new Uint8Array(buf);

  // Try worker first, then fallback w/out worker if environment blocks workers
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data, useWorker: true, ...PDF_OPTS }).promise;
  } catch {
    doc = await pdfjsLib.getDocument({ data, useWorker: false, ...PDF_OPTS }).promise;
  }

  let full = "";
  for (let p = 1; p <= doc.numPages; p++) {
    try {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
      const text = tc.items.map((it) => it.str || "").join(" ");
      if (text && text.trim()) full += text + "\n\n";
    } catch (e) {
      console.warn(`  (warn) PDF page ${p} failed: ${e.message}`);
    }
  }
  return { text: full, pages: doc.numPages };
}

async function readFileText(fp) {
  const absPath = abs(fp);
  let buf;
  try {
    const st = statSync(absPath);
    if (!st.isFile()) throw new Error("Not a file");
    buf = fs.readFileSync(absPath);
  } catch (e) {
    throw new Error(`Cannot read file: ${absPath} (${e.message})`);
  }

  const ext = path.extname(absPath).toLowerCase();

  if (ext === ".pdf") {
    try {
      return await readPdfText(buf);
    } catch (e) {
      throw new Error(`pdf parse failed for ${absPath}: ${e.message}`);
    }
  }
  if (ext === ".docx") {
    try {
      const r = await mammoth.extractRawText({ buffer: buf });
      return { text: r.value || "" };
    } catch (e) {
      throw new Error(`docx parse failed for ${absPath}: ${e.message}`);
    }
  }
  if (ext === ".html" || ext === ".htm") {
    try {
      const $ = cheerio.load(buf.toString("utf8"));
      $("script,style,noscript").remove();
      const text = $("body").text();
      return { text };
    } catch (e) {
      throw new Error(`html parse failed for ${absPath}: ${e.message}`);
    }
  }

  // txt/md/markdown and everything else we treat as plain text
  return { text: buf.toString("utf8") };
}

// -------- main --------
async function main() {
  console.log("Ensuring FTS schema…");
  await ensureChunksTable();

  if (PURGE) {
    console.log(`Purging existing chunks in collection "${collection}"…`);
    await pool.query(`DELETE FROM chunks WHERE (metadata->>'collection') = $1`, [collection]);
  }

  if (!fs.existsSync(folder) || !statSync(folder).isDirectory()) {
    console.error("Not a folder:", folder);
    process.exit(1);
  }

  const files = fs
    .readdirSync(folder)
    .map((f) => path.join(folder, f))
    .filter(f => {
  const ok = /\.(docx|txt|md|markdown|html|htm)$/i.test(f) || (INGEST_PDF && /\.pdf$/i.test(f));
  return ok;
})


  if (!files.length) {
    console.log("No supported files found in", folder);
    process.exit(0);
  }

  let totalChunks = 0;

  for (const fp of files) {
    console.log("• Reading", fp);
    try {
      const base = path.basename(fp);
      const { text, pages } = await readFileText(fp);
      const cleaned = cleanText(text);
      if (!cleaned) {
        console.warn("  (empty text) — skipped");
        continue;
      }

      const parts = chunk(cleaned);
      for (let idx = 0; idx < parts.length; idx++) {
        const part = parts[idx];
        await sqlInsertChunk({
          text: part,
          metadata: {
            title: base,
            source: fp,
            collection,
            page: pages ? Math.ceil(((idx + 1) / parts.length) * pages) : undefined,
          },
          // embedding created server-side in sqlInsertChunk()
        });
      }
      totalChunks += parts.length;
      console.log(`  inserted ${parts.length} chunks`);
    } catch (e) {
      console.error("  failed:", e.message);
    }
  }

  console.log(`Done. Inserted ${totalChunks} chunks into collection "${collection}".`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
