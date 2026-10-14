// scripts/db-init.mjs
// Run: npm run db:init
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

async function columnExists(table, column) {
  const q = `
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = $1 AND column_name = $2
    LIMIT 1`;
  const { rows } = await pool.query(q, [table, column]);
  return rows.length > 0;
}

async function typeExists(typname) {
  const { rows } = await pool.query(
    `SELECT 1 FROM pg_type WHERE typname = $1 LIMIT 1`,
    [typname]
  );
  return rows.length > 0;
}

async function extensionExists(extname) {
  const { rows } = await pool.query(
    `SELECT 1 FROM pg_extension WHERE extname = $1 LIMIT 1`,
    [extname]
  );
  return rows.length > 0;
}

async function ensureExtensionVector() {
  const hasExt = await extensionExists("vector");
  if (hasExt) return true;

  try {
    // CREATE EXTENSION IF NOT EXISTS vector;
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    return true;
  } catch (e) {
    console.warn(
      "pgvector not installed or no permission to install extension (skipping embedding column):",
      e.message
    );
    return false;
  }
}

async function main() {
  // 1) Base table (no pgvector requirement here)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chunks (
      id BIGSERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      metadata JSONB
    );
  `);

  // 2) Ensure tsv column exists (use trigger approach for broad PG compatibility)
  const hasTsv = await columnExists("chunks", "tsv");
  if (!hasTsv) {
    await pool.query(`ALTER TABLE chunks ADD COLUMN tsv tsvector;`);
  }

  // 2a) Backfill tsv once
  await pool.query(`
    UPDATE chunks
    SET tsv = to_tsvector('simple', coalesce(text,''))
    WHERE tsv IS NULL;
  `);

  // 2b) Create or replace trigger function + trigger to keep tsv up to date
  await pool.query(`
    CREATE OR REPLACE FUNCTION chunks_tsv_update() RETURNS trigger AS $$
    BEGIN
      NEW.tsv := to_tsvector('simple', coalesce(NEW.text,''));
      RETURN NEW;
    END
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_chunks_tsv_update ON chunks;
    CREATE TRIGGER trg_chunks_tsv_update
    BEFORE INSERT OR UPDATE OF text ON chunks
    FOR EACH ROW
    EXECUTE FUNCTION chunks_tsv_update();
  `);

  // 2c) GIN index on tsv (safe IF NOT EXISTS is available in modern PG)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON chunks USING GIN (tsv);
  `);

  // 3) Try to ensure pgvector + embedding column
  const hasVectorExt = await ensureExtensionVector();
  if (hasVectorExt) {
    const hasVectorType = await typeExists("vector");

    if (hasVectorType) {
      const hasEmbedding = await columnExists("chunks", "embedding");
      if (!hasEmbedding) {
        await pool.query(`ALTER TABLE chunks ADD COLUMN embedding vector(384);`);
      }

      // ANN index for embeddings (requires pgvector)
      try {
        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_chunks_embedding
          ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
        `);
      } catch (e) {
        console.warn("Could not create ivfflat index (pgvector < 0.5 or permissions):", e.message);
      }
    } else {
      console.warn("vector type not available even after attempting extension install. Skipping embedding column.");
    }
  }

  // 4) JSONB index (handy for filtering collections)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_chunks_metadata ON chunks USING GIN (metadata);
  `);

  console.log("db-init: OK — table/columns/triggers/indexes are ready.");
}

main()
  .catch((e) => {
    console.error("db-init error:", e.message);
  })
  .finally(async () => {
    await pool.end();
  });
