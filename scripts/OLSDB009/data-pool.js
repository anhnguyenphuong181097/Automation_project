// scripts/OLSDB009/data-pool.js
// Batch     : OLSDB009
// Purpose   : Supply REAL reference data from the DB to the file generator,
//             instead of hardcoding CIF / account / card / transaction code.
//
// ============ HOW IT WORKS (option C) ============
//   1. Query the DB (SELECT only) for transaction codes, accounts, cards,
//      terminals that already exist and match each other.
//   2. Write a snapshot to scripts/test-data/pool/OLSDB009-pool.json
//   3. Later runs read the snapshot (offline, reproducible).
//   4. Fallback behaviour:
//        - DB up,   no snapshot -> query and write snapshot
//        - DB up,   snapshot    -> use snapshot (unless refresh: true)
//        - DB down, snapshot    -> use snapshot, warn
//        - DB down, no snapshot -> throw
//
// Refresh manually: npm run refresh:pool:olsdb009
//
// ============ WHY A TRANSACTION CODE MATTERS MOST ============
// A transaction is only accepted when it HITS a campaign. The hit path is:
//
//   DT.txnTranCode
//     -> transaction_code     (status 'A')
//     -> tc_scheme_linkage    (status 'A')
//     -> scheme               (status 'A', now between start/end date)
//     -> campaign             (status 'A')
//     -> row written to transaction_reward_detail (last_update_by = 'OLSDB009')
//
// If it does not hit, the batch rejects the record with
// BE654 "Transaction does not hit campaign".
//
// Note: scheme AWOE of the OEOC test campaign has NO rows in
// transaction_criteria or scheme_criteria, so mcc / amount / date / channel do
// NOT take part in the hit decision. Only txnTranCode does.
//
// ============ DB JOIN RELATIONSHIPS ============
//   product_account.product_account_no    -> txnProdAcctNbr    ┐
//   product_account.product_account_type  -> txnProdAcctType   │ card_product_account_rel
//   product_account.product_account_level -> txnProdAcctLevel  │   .product_account_no
//   product_account.product_code          -> txnAcctCurrCode   ┘   .product_account_type
//   card_product_account_rel.card_no      -> txnCardNbr
//   eft_pos.terminal_id / branch_id       -> txnTerminalId / txnBranchId
//   reason_code.reason_code               -> txnAdjReason   (id_level = 'ADJ')
//
// ============ CIF: WHY IT IS NOT cust_cif_nbr ============
// The account that actually works in production is product_account_no '200'
// (csn 1429681, account_serial_no 3200651, 1259 linked cards). Every row in
// transactions with transaction_type = 'ADJ' uses it. But its
// product_account.cust_cif_nbr is NULL, so filtering on that column silently
// drops the one proven account and keeps only synthetic ones.
//
// The CIF-like value that IS attached to that customer in the DB lives on
// card.customer_id ('0000001100107653' for csn 1429681). The pool therefore
// resolves txnCifNbr as: cust_cif_nbr, else card.customer_id.
//
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(__dirname, '..', 'test-data', 'pool', 'OLSDB009-pool.json');

// Cap per bucket. The DB holds ~2500 active accounts but tests do not need
// that many; trimming keeps the snapshot small.
const MAX_PER_BUCKET = 300;
const MAX_NONEXISTENT = 5;

// ============ TEST CAMPAIGN ============
// Campaign reserved for automation testing. Set OLSDB009_TEST_CAMPAIGN_ID to
// the campaign_id once it has been created. Everything else in the pool is
// campaign-independent, so changing this only affects hitCodes.testCampaign.
//
// Only purchase records (txnTranType '02') need it - they must carry a code
// that hits a live scheme. Adjustments ('03') carry no code and are not subject
// to the rule, so the current test cases do not need this campaign yet.
const TEST_CAMPAIGN_ID = process.env.OLSDB009_TEST_CAMPAIGN_ID || 'OEOC';

const DB = {
  host: process.env.DB_HOST || '192.168.99.83',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USERNAME || 'ols_user',
  password: process.env.DB_PASSWORD || 'ols168',
  database: process.env.DB_NAME || 'ols_my',
  schema: process.env.DB_SCHEMA || 'ols_schema',
};

// ============ QUERIES ============
// Every query is ordered by a stable key so that the same DB yields the same
// snapshot, which in turn yields identical .dat files between runs.
const S = DB.schema;

// One row PER ACCOUNT (not per card). An account can carry over a thousand
// cards, so a row-per-card join would let a single account swallow the whole
// LIMIT. card_count is the useful signal: the production account has 1259.
//
// Deliberately NOT filtered on cust_cif_nbr - see the CIF note in the header.
const Q_ACCOUNTS_WITH_CARD = `
  SELECT pa.product_account_no, pa.product_account_type,
         pa.product_account_level, pa.cust_cif_nbr, pa.csn,
         pa.account_serial_no, pa.product_code AS acct_curr_code, pa.status,
         pa.product_account_status, pa.product_account_ind,
         COUNT(DISTINCT r.card_no) AS card_count,
         MIN(r.card_no)            AS card_no,
         MIN(r.expiry_date)        AS expiry_date,
         MIN(c.customer_id)        AS customer_id
    FROM ${S}.product_account pa
    JOIN ${S}.card_product_account_rel r
      ON r.product_account_no = pa.product_account_no
     AND r.product_account_type = pa.product_account_type
    LEFT JOIN ${S}.card c
      ON c.card_no = r.card_no
   WHERE pa.product_account_no IS NOT NULL AND pa.product_account_no <> ''
     AND r.card_no IS NOT NULL AND r.card_no <> ''
   GROUP BY pa.product_account_no, pa.product_account_type,
            pa.product_account_level, pa.cust_cif_nbr, pa.csn,
            pa.account_serial_no, pa.product_code, pa.status,
            pa.product_account_status, pa.product_account_ind
   ORDER BY card_count DESC, pa.product_account_no
   LIMIT ${MAX_PER_BUCKET}`;

// Active accounts with NO card link (for account-only scenarios)
const Q_ACCOUNTS_NO_CARD = `
  SELECT pa.product_account_no, pa.product_account_type,
         pa.product_account_level, pa.cust_cif_nbr, pa.csn,
         pa.account_serial_no, pa.product_code AS acct_curr_code, pa.status,
         pa.product_account_status, pa.product_account_ind
    FROM ${S}.product_account pa
   WHERE pa.product_account_no IS NOT NULL AND pa.product_account_no <> ''
     AND NOT EXISTS (
           SELECT 1 FROM ${S}.card_product_account_rel r
            WHERE r.product_account_no = pa.product_account_no
              AND r.product_account_type = pa.product_account_type)
   ORDER BY pa.product_account_no
   LIMIT ${MAX_PER_BUCKET}`;

// Inactive accounts (status 'I') - for closed-account scenarios
const Q_ACCOUNTS_INACTIVE = `
  SELECT pa.product_account_no, pa.product_account_type,
         pa.product_account_level, pa.cust_cif_nbr, pa.csn,
         pa.account_serial_no, pa.product_code AS acct_curr_code, pa.status,
         pa.product_account_status
    FROM ${S}.product_account pa
   WHERE pa.status = 'I'
     AND pa.product_account_no IS NOT NULL AND pa.product_account_no <> ''
   ORDER BY pa.product_account_no
   LIMIT ${MAX_PER_BUCKET}`;

// Adjustment reason codes -> DT.txnAdjReason.
// reason_code.id_level discriminates the usage: 'ADJ' is the adjustment set.
// Only status 'A' (active/approved) codes are accepted by the batch.
const Q_ADJ_REASONS = `
  SELECT reason_code, description_english, id_level, status
    FROM ${S}.reason_code
   WHERE id_level = 'ADJ'
     AND status = 'A'
     AND reason_code IS NOT NULL AND reason_code <> ''
   ORDER BY reason_code
   LIMIT ${MAX_PER_BUCKET}`;

// Branches -> DT.txnBranchId, which is mandatory.
// Sourced from the branch master itself (631 active rows on dev-my), not from
// eft_pos: txnTerminalId is left blank, so borrowing a branch off a terminal
// would tie the file to a terminal that has nothing to do with the account.
const Q_BRANCHES = `
  SELECT branch_id, branch_name_english_1, corporate_id, country_code,
         branch_status, status, mcc, source
    FROM ${S}.branch
   WHERE status = 'A'
     AND branch_id IS NOT NULL AND branch_id <> ''
   ORDER BY branch_id
   LIMIT ${MAX_PER_BUCKET}`;

const Q_TERMINALS = `
  SELECT terminal_id, branch_id, terminal_name, terminal_type,
         terminal_status, status, currency_code, eft_pos_group
    FROM ${S}.eft_pos
   WHERE terminal_id IS NOT NULL AND terminal_id <> ''
   ORDER BY terminal_id, branch_id
   LIMIT ${MAX_PER_BUCKET}`;

const Q_CAMPAIGNS = `
  SELECT campaign_id, campaign_name, campaign_type, status,
         start_date, end_date, priority_sequence
    FROM ${S}.campaign
   WHERE campaign_id IS NOT NULL AND campaign_id <> ''
   ORDER BY campaign_id
   LIMIT ${MAX_PER_BUCKET}`;

// Transaction codes that currently HIT a live scheme -> live campaign.
// This is the single most important bucket: a record using any other code is
// rejected with BE654.
const Q_HIT_CODES = `
  SELECT l.transaction_code, l.scheme_id, l.execution_seq,
         s.campaign_id, s.pool_id,
         s.scheme_start_date, s.scheme_end_date
    FROM ${S}.tc_scheme_linkage l
    JOIN ${S}.scheme s   ON s.scheme_id   = l.scheme_id
    JOIN ${S}.campaign c ON c.campaign_id = s.campaign_id
   WHERE l.status = 'A'
     AND s.status = 'A'
     AND c.status = 'A'
     AND s.scheme_start_date <= NOW()
     AND s.scheme_end_date   >= NOW()
   ORDER BY l.transaction_code, l.scheme_id`;

// Transaction codes that EXIST and are active, but link to no live scheme.
// Produces the "rule not hit" rejection (BE654) rather than a format error.
const Q_CODES_NO_HIT = `
  SELECT tc.transaction_code, tc.description_english, tc.channel_id
    FROM ${S}.transaction_code tc
   WHERE tc.status = 'A'
     AND tc.transaction_code IS NOT NULL AND tc.transaction_code <> ''
     AND NOT EXISTS (
           SELECT 1 FROM ${S}.tc_scheme_linkage l
             JOIN ${S}.scheme s ON s.scheme_id = l.scheme_id
            WHERE l.transaction_code = tc.transaction_code
              AND l.status = 'A'
              AND s.status = 'A'
              AND s.scheme_start_date <= NOW()
              AND s.scheme_end_date   >= NOW())
   ORDER BY tc.transaction_code
   LIMIT ${MAX_PER_BUCKET}`;

// ============ GENERATE VALUES THAT PROVABLY DO NOT EXIST ============
// Negative tests need data that is NOT in the DB. Every candidate is verified
// with a query before being stored - guessing a value risks picking a real one
// and silently turning a negative case into a positive one.
async function buildNonexistent(client) {
  const out = { cif: [], acct: [], card: [], terminal: [], tranCode: [] };

  const probe = async (label, table, column, makeCandidate, n = MAX_NONEXISTENT) => {
    const found = [];
    let salt = 0;
    while (found.length < n && salt < 200) {
      const cand = makeCandidate(salt++);
      const r = await client.query(
        `SELECT 1 FROM ${S}.${table} WHERE ${column} = $1 LIMIT 1`, [cand]);
      if (r.rowCount === 0) found.push(cand);
    }
    if (found.length === 0) {
      throw new Error(`Could not build a ${label} value absent from the DB`);
    }
    out[label] = found;
  };

  // Lengths taken from the real columns (measured 2026-09-11):
  //   cust_cif_nbr 7 | product_account_no up to 18 | card_no up to 19 | terminal_id 4-8
  // Prefix 99/98 is outside the real numeric range, and each candidate is
  // verified anyway.
  // NOTE: build the string with padStart, never by adding to a number - values
  // of 17-19 digits exceed Number.MAX_SAFE_INTEGER, so addition rounds and
  // produces duplicates.
  await probe('cif', 'product_account', 'cust_cif_nbr', (i) => `99${String(i).padStart(5, '0')}`);
  await probe('acct', 'product_account', 'product_account_no', (i) => `99${String(i).padStart(16, '0')}`);
  await probe('card', 'card_product_account_rel', 'card_no', (i) => `98${String(i).padStart(17, '0')}`);
  await probe('terminal', 'eft_pos', 'terminal_id', (i) => `ZZ${String(10 + i).padStart(2, '0')}`);
  await probe('tranCode', 'transaction_code', 'transaction_code', (i) => `ZZ${String(900 + i)}`);

  return out;
}

// ============ BUILD SNAPSHOT ============
export async function buildSnapshot() {
  const client = new pg.Client(DB);
  await client.connect();
  try {
    console.log(`   Connected ${DB.host}:${DB.port}/${DB.database} (schema ${S})`);

    // A pg client cannot run queries concurrently on one connection.
    const withCard = await client.query(Q_ACCOUNTS_WITH_CARD);
    const noCard = await client.query(Q_ACCOUNTS_NO_CARD);
    const inactive = await client.query(Q_ACCOUNTS_INACTIVE);
    const branches = await client.query(Q_BRANCHES);
    const terminals = await client.query(Q_TERMINALS);
    const campaigns = await client.query(Q_CAMPAIGNS);
    const hitCodes = await client.query(Q_HIT_CODES);
    const noHitCodes = await client.query(Q_CODES_NO_HIT);
    const adjReasons = await client.query(Q_ADJ_REASONS);

    const nonexistent = await buildNonexistent(client);

    const testCampaignCodes = hitCodes.rows.filter(
      (r) => r.campaign_id === TEST_CAMPAIGN_ID);

    const snapshot = {
      meta: {
        batch: 'OLSDB009',
        createdAt: new Date().toISOString(),
        source: `${DB.host}:${DB.port}/${DB.database}`,
        schema: S,
        testCampaignId: TEST_CAMPAIGN_ID,
        counts: {
          hitCodes: hitCodes.rowCount,
          hitCodesForTestCampaign: testCampaignCodes.length,
          accountsWithCard: withCard.rowCount,
          accountsNoCard: noCard.rowCount,
          accountsInactive: inactive.rowCount,
          branches: branches.rowCount,
          terminals: terminals.rowCount,
          campaigns: campaigns.rowCount,
          codesNoHit: noHitCodes.rowCount,
          adjReasons: adjReasons.rowCount,
        },
      },
      hitCodes: hitCodes.rows,
      codesNoHit: noHitCodes.rows,
      adjReasons: adjReasons.rows,
      accountsWithCard: withCard.rows,
      accountsNoCard: noCard.rows,
      accountsInactive: inactive.rows,
      branches: branches.rows,
      terminals: terminals.rows,
      campaigns: campaigns.rows,
      nonexistent,
    };

    console.log('   Snapshot:', JSON.stringify(snapshot.meta.counts));
    if (testCampaignCodes.length === 0) {
      console.warn(
        `   WARNING: campaign "${TEST_CAMPAIGN_ID}" has no live transaction code.\n` +
        `            Create the campaign, or set OLSDB009_TEST_CAMPAIGN_ID.`);
    }
    return snapshot;
  } finally {
    await client.end();
  }
}

// ============ SNAPSHOT IO ============
function readSnapshot() {
  if (!fs.existsSync(SNAPSHOT_PATH)) return null;
  try {
    return fs.readJsonSync(SNAPSHOT_PATH);
  } catch (e) {
    console.warn(`   WARNING: unreadable snapshot, ignoring: ${e.message}`);
    return null;
  }
}

function writeSnapshot(snap) {
  fs.ensureDirSync(path.dirname(SNAPSHOT_PATH));
  fs.writeJsonSync(SNAPSHOT_PATH, snap, { spaces: 2 });
  console.log(`   Snapshot written: ${SNAPSHOT_PATH}`);
}

/**
 * Load the pool. By default uses the snapshot when present, otherwise queries
 * the DB. Falls back to a stale snapshot when the DB is unreachable.
 * @param {Object}  opts
 * @param {boolean} opts.refresh - force a fresh DB query
 * @param {boolean} opts.offline - never touch the DB, snapshot only
 * @returns {Promise<Object>} snapshot
 */
export async function getPool({ refresh = false, offline = false } = {}) {
  if (!refresh) {
    const cached = readSnapshot();
    if (cached) {
      console.log(`   Using snapshot from ${cached.meta.createdAt}`);
      return cached;
    }
    if (offline) {
      throw new Error(`No snapshot at ${SNAPSHOT_PATH} and offline mode is on`);
    }
  }

  if (offline) {
    throw new Error('Cannot refresh while offline');
  }

  try {
    const snap = await buildSnapshot();
    writeSnapshot(snap);
    return snap;
  } catch (err) {
    const cached = readSnapshot();
    if (cached) {
      console.warn(`   WARNING: DB query failed (${err.message}) - using cached snapshot`);
      return cached;
    }
    throw new Error(`DB query failed and no snapshot available: ${err.message}`);
  }
}

// ============ POOL LOOKUPS ============
// These are what file-generator calls. A test case declares its INTENT and the
// pool resolves it to a REAL value - no literal ever appears in a test case.

function matches(row, filter) {
  return Object.entries(filter).every(([k, v]) => v === undefined || row[k] === v);
}

function pickFrom(rows, filter, label, index = 0) {
  const hits = filter ? rows.filter((r) => matches(r, filter)) : rows;
  if (hits.length === 0) {
    throw new Error(`Pool: no ${label} matches filter ${JSON.stringify(filter)}`);
  }
  return hits[index % hits.length];
}

/** Row of { transaction_code, scheme_id, campaign_id, pool_id, ... } that hits a live campaign. */
export function hitCode(pool, filter = {}, index = 0) {
  return pickFrom(pool.hitCodes, filter, 'hitting transaction code', index);
}

/**
 * Hitting code restricted to the campaign reserved for automation testing.
 *
 * Only purchase records (txnTranType '02') need a code that hits a campaign.
 * Adjustments ('03') carry no code, so no test case uses this yet.
 */
export function testCampaignCode(pool, index = 0) {
  const id = pool.meta.testCampaignId;
  const rows = pool.hitCodes.filter((r) => r.campaign_id === id);
  if (rows.length === 0) {
    throw new Error(
      `Pool: campaign "${id}" has no live transaction code. ` +
      `Create it, or set OLSDB009_TEST_CAMPAIGN_ID and refresh the pool.`);
  }
  return rows[index % rows.length];
}

/** Code that exists and is active but hits no live scheme -> BE654. */
export function codeWithoutScheme(pool, index = 0) {
  return pickFrom(pool.codesNoHit, null, 'code with no scheme', index);
}

/** Account that has a linked card. e.g. filter { status: 'A' } */
export function accountWithCard(pool, filter = {}, index = 0) {
  return pickFrom(pool.accountsWithCard, filter, 'account+card', index);
}

/** Active account with no card link. */
export function accountNoCard(pool, filter = {}, index = 0) {
  return pickFrom(pool.accountsNoCard, filter, 'account (no card)', index);
}

/** Inactive account. */
export function accountInactive(pool, filter = {}, index = 0) {
  return pickFrom(pool.accountsInactive, filter, 'inactive account', index);
}

/** Terminal. */
export function terminal(pool, filter = {}, index = 0) {
  return pickFrom(pool.terminals, filter, 'terminal', index);
}

/** Branch from the branch master -> DT.txnBranchId (mandatory). */
export function branch(pool, filter = { status: 'A' }, index = 0) {
  return pickFrom(pool.branches, filter, 'branch', index);
}

/** Campaign. */
export function campaign(pool, filter = {}, index = 0) {
  return pickFrom(pool.campaigns, filter, 'campaign', index);
}

/**
 * Active adjustment reason code -> DT.txnAdjReason.
 * @param {Object} pool
 * @param {number} index
 * @returns {string} e.g. 'TJJ'
 */
export function adjReason(pool, index = 0) {
  const row = pickFrom(pool.adjReasons, { status: 'A' }, 'adjustment reason code', index);
  return row.reason_code;
}

/**
 * CIF to write into the file for an account row from the pool.
 *
 * Tries product_account.cust_cif_nbr first, then falls back to the CIF-like
 * card.customer_id. The production account (product_account_no '200') only has
 * the latter, so a cust_cif_nbr-only lookup would come back empty.
 *
 * @param {Object} acct - one row of pool.accountsWithCard
 * @returns {string} '' when the DB holds neither
 */
export function cifFor(acct) {
  return acct.cust_cif_nbr || acct.customer_id || '';
}

/** A value verified absent from the DB. kind: cif | acct | card | terminal | tranCode */
export function nonexistent(pool, kind, index = 0) {
  const arr = pool.nonexistent?.[kind];
  if (!arr || arr.length === 0) {
    throw new Error(`Pool: no known-absent value for "${kind}"`);
  }
  return arr[index % arr.length];
}

/** A REAL card that is not linked to the given account. */
export function cardNotLinkedTo(pool, acctNbr) {
  const linked = new Set(
    pool.accountsWithCard
      .filter((r) => r.product_account_no === acctNbr)
      .map((r) => r.card_no),
  );
  const hit = pool.accountsWithCard.find((r) => !linked.has(r.card_no));
  if (!hit) throw new Error('Pool: no card found that is unlinked to that account');
  return hit.card_no;
}

// ============ CLI ============
// node scripts/OLSDB009/data-pool.js            -> show the current snapshot
// node scripts/OLSDB009/data-pool.js --refresh  -> re-query the DB and rewrite it
if (process.argv[1] && process.argv[1].endsWith('data-pool.js')) {
  const refresh = process.argv.includes('--refresh');
  console.log('OLSDB009 data pool');
  const pool = await getPool({ refresh });
  console.log(`\nSnapshot   : ${pool.meta.source}`);
  console.log(`Created    : ${pool.meta.createdAt}`);
  console.log(`Test campaign: ${pool.meta.testCampaignId}`);
  console.table(pool.meta.counts);

  console.log('\nHitting transaction codes for the test campaign:');
  const tc = pool.hitCodes.filter((r) => r.campaign_id === pool.meta.testCampaignId);
  console.table(tc.length ? tc : [['none']]);

  console.log('\nAccounts (top 5 by card count - the production account leads):');
  console.table(pool.accountsWithCard.slice(0, 5));

  console.log(`\nActive adjustment reason codes: ${pool.adjReasons.length} (showing 5)`);
  console.table(pool.adjReasons.slice(0, 5));

  console.log('\nValues guaranteed absent from the DB (for negative tests):');
  console.table(pool.nonexistent);
}

export default {
  buildSnapshot,
  getPool,
  hitCode,
  testCampaignCode,
  codeWithoutScheme,
  accountWithCard,
  accountNoCard,
  accountInactive,
  terminal,
  branch,
  campaign,
  adjReason,
  cifFor,
  nonexistent,
  cardNotLinkedTo,
};
