import pg from "pg";
import "dotenv/config";

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

const { rows } = await pool.query("SELECT count(*) FROM chunks;");
console.log("Chunks count:", rows[0].count);
process.exit(0);
