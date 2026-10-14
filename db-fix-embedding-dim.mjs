// Run: node scripts/db-fix-embedding-dim.mjs
import pg from "pg";
import "dotenv/config";

const pool = new pg.Pool({
  host: process.env.PGHOST || "127.0.0.1",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "hrbot",
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD,
  ssl: false,
});

async function getCurrentVectorDim() {
  const sql = `
    SELECT
      CASE WHEN t.typname = 'vector' AND a.atttypmod > 0
           THEN a.atttypmod - 4
           ELSE NULL
      END AS dims
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = 'public'
      AND c.relname = 'chunks'
      AND a.attname = 'embedding'
      AND a.attisdropped = false
    LIMIT 1;
  `;
  const r = await pool.query(sql);
  return r.rows?.[0]?.dims ?? null;
}

async function ensureBasics() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chunks (
      id BIGSERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      metadata JSONB DEFAULT '{}'::jsonb
    );
  `);
}

async function recreateEmbeddingColumn384() {
  // remove any dependent index first
  await pool.query(`DROP INDEX IF EXISTS idx_chunks_embedding;`);
  // drop column if exists (safe if it doesn't)
  await pool.query(`ALTER TABLE chunks DROP COLUMN IF EXISTS embedding;`);
  // add fresh 384-dim column
  await pool.query(`ALTER TABLE chunks ADD COLUMN embedding vector(384);`);
  // recreate index
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_chunks_embedding
      ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
  `);
  await pool.query(`ANALYZE chunks;`);
}

async function main() {
  await ensureBasics();

  const dims = await getCurrentVectorDim();
  console.log("Current embedding dimension:", dims === null ? "(none)" : dims);

  if (dims === 384) {
    console.log("Embedding already vector(384) — OK. Ensuring index…");
    await recreateEmbeddingColumn384(); // harmless if already 384; keeps index fresh
  } else {
    console.log("Resetting embedding column to vector(384) (dropping old data) …");
    await recreateEmbeddingColumn384();
  }

  console.log("Done. Embedding column is vector(384). Re-ingest next.");
}

main()
  .catch(e => console.error("db-fix-embedding-dim error:", e.message))
  .finally(async () => { try { await pool.end(); } catch {} });
