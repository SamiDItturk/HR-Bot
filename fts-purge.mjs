// Usage: node scripts/fts-purge.mjs --collection hr-2025-v1
import { pool } from "../api/search.mjs";

const i = process.argv.indexOf("--collection");
if (i < 0 || !process.argv[i+1]) {
  console.error("Usage: node scripts/fts-purge.mjs --collection <name>");
  process.exit(1);
}
const collection = process.argv[i+1];

const sql = `DELETE FROM chunks WHERE (metadata->>'collection') = $1`;

(async () => {
  const r = await pool.query(sql, [collection]);
  console.log(`Deleted ${r.rowCount} rows from collection "${collection}".`);
  await pool.end();
})().catch(e => {
  console.error(e);
  process.exit(1);
});
