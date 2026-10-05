// scripts/OLSDB028/drafts/db-peek.js
// DRAFT: xem nhanh 1 row IFS theo reference_no + pool tuong ung trong statement_output_pool.
// Chay: node scripts/OLSDB028/drafts/db-peek.js <reference_no>

import pg from 'pg';
import { CONFIG, SCHEMA } from '../test-data.js';

const ref = process.argv[2];

const client = new pg.Client({ host: CONFIG.database.host, port: CONFIG.database.port, user: CONFIG.database.username,
  password: CONFIG.database.password, database: CONFIG.database.database });
await client.connect();

if (ref) {
  const r = await client.query(
    `SELECT record_no::text, reference_no, item_code, item_name, item_type, pool_id, redeemed_point::text AS points,
            fulfillment_status, csn, product_account_level, product_account_type,
            last_update_by, extracted_date_time::text AS extracted
       FROM ${SCHEMA}.item_fulfilment_status WHERE reference_no = $1`, [ref]);
  console.log('IFS rows:', JSON.stringify(r.rows, null, 1));
  const pool = r.rows[0]?.pool_id;
  if (pool) {
    const p = await client.query(
      `SELECT pool_id, product_account_type, product_account_level, status,
              to_char(pool_start_date,'YYYY-MM-DD HH24:MI:SS') AS pool_start_date,
              to_char(pool_end_date,'YYYY-MM-DD HH24:MI:SS')   AS pool_end_date
         FROM ${SCHEMA}.statement_output_pool WHERE pool_id = $1`, [pool]);
    console.log(`statement_output_pool(${pool}):`, JSON.stringify(p.rows, null, 1));
  }
}

await client.end();
