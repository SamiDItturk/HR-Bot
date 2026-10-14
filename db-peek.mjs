import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool();
const q = (sql,params)=>pool.query(sql,params).then(r=>r.rows);

console.log('count:', (await q('SELECT count(*) FROM chunks'))[0].count);
console.log('by collection:', await q(
  "SELECT metadata->>'collection' AS collection, count(*) FROM chunks GROUP BY 1 ORDER BY 2 DESC"
));
console.log('sample hits:', await q(
  "SELECT metadata->>'title' AS title, left(text,200) AS snip \
   FROM chunks \
   WHERE to_tsvector('simple',text) @@ to_tsquery('simple','maternity|bereavement|annual & leave|Saudi') \
   LIMIT 10"
));
await pool.end();
