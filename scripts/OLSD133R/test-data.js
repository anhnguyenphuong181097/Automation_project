// scripts/OLSD133R/test-data.js
// Test data and configuration for batch OLSD133R (same role as test-data.js in OLSDB024,
// but this batch has no input file, so the "test data" here defines the 7 report sections
// plus the list of upstream batches that must run before the report has data).
//
// CONFIG NOTE: unlike OLSDB024 (where CONFIG sits in the spec), this file holds CONFIG because
// both test-runner.spec.js and file-generator.js (the seed step) need the same host/paths/DB
// settings. This keeps the seed and validate phases aligned.
//
// DO NOT import config/test-config.js: that file calls dotenv.config() and overrides
// BATCH_COMMAND to 'process_batch.sh' (which does not exist) - see AGENTS.md section 6.1.
// DO NOT hard-code credentials (AGENTS.md section 3.1): username/password must be read from .env.

import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = process.cwd();

/** Read .env without dotenv or extra dependencies - only credentials are needed */
function readEnvFile() {
  const out = {};
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(envPath)) return out;

  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

const ENV = readEnvFile();
const cred = (key, fallback) => process.env[key] || ENV[key] || fallback;

// ============ CONFIGURATION ============
export const CONFIG = {
  winscp: {
    path: process.env.WINSCP_PATH || 'C:\\Program Files (x86)\\WinSCP\\WinSCP.com',
    host: '192.168.99.83',
    port: '22',
    username: cred('SFTP_USERNAME', 'root'),
    password: cred('SFTP_PASSWORD', ''),
    // Input folder for OLSDB009 - source data for DWH_TEMP_TXN (section 1)
    remotePath: '/apps/MY-dev/OE/cls/USER_INPUT/OLSDB009/',
    // Local staging folder (same as LOCAL_PATH in the other batches)
    localPath: 'C:\\BATCH-OCBC-PW1\\src\\',
  },

  putty: {
    path: process.env.PUTTY_PATH || 'C:\\Program Files\\PuTTY\\plink.exe',
    host: '192.168.99.83',
    username: cred('SSH_USERNAME', 'root'),
    password: cred('SSH_PASSWORD', ''),
    // plink stores the host key separately in the registry: successful WinSCP upload does NOT
    // mean plink already trusts this host. Without -hostkey, plink stops at the prompt
    // "Store key in cache? (y/n)" and hangs until killed (see AGENTS.md section 4.4).
    hostKey: process.env.SSH_HOST_KEY || 'SHA256:kGbLBMkLSnBoYmLg10qgHfmQmtUbawS69GYysVLkXu4',
  },

  batch: {
    // Server folder containing the batch scripts (all batches in this suite live in the same directory)
    scriptPath: '/apps/MY-dev/scripts',
    command: './OLSDR133',
    // Java batch: allow JVM startup time; do not reduce the timeout to only a few dozen seconds
    timeout: 600000,
  },

  report: {
    remoteDir: '/apps/MY-dev/OE/cls/USER_OUTPUT/OLSD133R',
    // Report filename on dev: MYOLSD133R<batch date YYYYMMDD>.txt
    // (confirmed by file MYOLSD133R20260922.txt; header line is 'Report Date: 22092026')
    prefix: 'MYOLSD133R',
    extension: '.txt',
    localDir: path.join(PROJECT_ROOT, 'reports', 'OLSD133R'),
  },

  database: {
    host: '192.168.99.83',
    port: 5432,
    database: 'ols_my',
    username: cred('DB_USERNAME', 'ols_user'),
    password: cred('DB_PASSWORD', ''),
    schema: 'ols_schema',
  },
};

export const SCHEMA = CONFIG.database.schema;

// module_id in table oe_cutofftime_control (cut-off time used by this report)
export const CUTOFF_MODULE_ID = 'OLSDR133';

// 6 forfeit batches must run before the report, in EOD Batch flow order:
// 001 -> 023 -> 002 -> 003 -> 005 -> 051
export const FORFEIT_BATCHES = [
  'OLSDB001', // TEMP_LOYALTY_ACCOUNT_STATUS  (section 6)
  'OLSDB023', // TEMP_CUSTOMER_STATUS          (section 5)
  'OLSDB002', // TEMP_ACCOUNT_STATUS           (section 4)
  'OLSDB003', // TEMP_ACCOUNT_BLOCK            (section 3)
  'OLSDB005', // TEMP_POINT_EXPIRE             (section 2)
  'OLSDB051', // TEMP_CLOSED_ACCOUNT           (section 7)
];

// Source data for section 1 (adjustment) - written by OLSDB009
export const ADJUSTMENT_SOURCE = {
  batch: 'OLSDB009',
  testCase: 'tc1', // test case trong scripts/OLSDB009/file-generator.js
};

// ---------------------------------------------------------------------------
// 7 sections of the report, in the order they are printed (verified on the real file
// MYOLSD133R20260922.txt + OLSD133R.xlsx + sample images).
//   - section 1 : filter txn_type = '03' AND error_code IS NOT NULL
//   - 6 forfeit : filter error_code IS NOT NULL
//   - shared time window: > current_cut_off_time and <= batch date
//
// Table names are written in uppercase: PostgreSQL folds unquoted identifiers to lowercase,
// so 'temp_point_expire' is really TEMP_POINT_EXPIRE.
// Note: the actual expired-point table is TEMP_POINT_EXPIRE (without a trailing 'D') -
// this was confirmed with the business team. The mapping file OLSD133R_v0.1.xlsx lists
// TEMP_POINT_EXPIRED, which is incorrect and must be fixed in the mapping.
// ---------------------------------------------------------------------------
export const SECTIONS = [
  {
    key: 'adjustment',
    title: 'Adjustment Transaction Exception',
    // Build 2025 in 'Adjust Transaction Exception', build 2026 in 'Adjustment ...'
    titleRegex: /^Adjust(ment)? Transaction Exception$/,
    table: 'dwh_temp_txn',
    txnExpr: 't.txn_date + t.txn_time',
    filter: "t.txn_type = '03' AND t.error_code IS NOT NULL",
    poolHeader: false,   // section 1 khong in Pool ID / Pool Name
    printsTime: true,    // in ca gio: DD-MM-YYYY HH:MM:SS
  },
  { key: 'expired', title: 'Expired Forfeit Point Exception', titleRegex: /^Expired Forfeit Point Exception$/, table: 'temp_point_expire', txnExpr: 't.txn_datetime', filter: 't.error_code IS NOT NULL', poolHeader: true, printsTime: false },
  { key: 'blockCode', title: 'Block Code Forfeit Exception', titleRegex: /^Block Code Forfeit Exception$/, table: 'temp_account_block', txnExpr: 't.txn_datetime', filter: 't.error_code IS NOT NULL', poolHeader: true, printsTime: false },
  { key: 'accountStatus', title: 'Account Status Forfeit Exception', titleRegex: /^Account Status Forfeit Exception$/, table: 'temp_account_status', txnExpr: 't.txn_datetime', filter: 't.error_code IS NOT NULL', poolHeader: true, printsTime: false },
  { key: 'customerStatus', title: 'Customer Status Forfeit Exception', titleRegex: /^Customer Status Forfeit Exception$/, table: 'temp_customer_status', txnExpr: 't.txn_datetime', filter: 't.error_code IS NOT NULL', poolHeader: true, printsTime: false },
  { key: 'loyaltyAccountStatus', title: 'Loyalty Account Status Forfeit Exception', titleRegex: /^Loyalty Account Status Forfeit Exception$/, table: 'temp_loyalty_account_status', txnExpr: 't.txn_datetime', filter: 't.error_code IS NOT NULL', poolHeader: true, printsTime: false },
  { key: 'customerAccountDeletion', title: 'Customer Account Deletion Forfeit Exception', titleRegex: /^Customer Account Deletion Forfeit Exception$/, table: 'temp_closed_account', txnExpr: 't.txn_datetime', filter: 't.error_code IS NOT NULL', poolHeader: true, printsTime: false },
];

export const SECTION_BY_KEY = Object.fromEntries(SECTIONS.map((s) => [s.key, s]));

// ---------------------------------------------------------------------------
// Column positions of the report (fixed-width), measured directly from the real report:
//   'Transaction Date/Time  Batch Id  Product Account Nbr  Account Type  Txn Code
//    T  Points  Store Id  Error Code & Message'
// If dev changes the printed width, edit this mapping and the parser will fall back to
// token-based parsing and record a warning - see test-runner.spec.js.
// ---------------------------------------------------------------------------
export const COLUMN_LAYOUT = {
  txnDateTime: [0, 26],
  batchId: [26, 42],
  prodAcctNbr: [42, 63],
  accountType: [63, 79],
  txnCode: [79, 94],
  t: [94, 104],
  points: [104, 116],
  storeId: [116, 134],
  error: [134, 400],
};

// Field names used in log output [FAIL]
export const FIELD_LABELS = {
  txnDate: 'TRANSACTION_DATE',
  txnTime: 'TRANSACTION_TIME',
  batchId: 'BATCH_ID',
  prodAcctNbr: 'PRODUCT_ACCOUNT_NBR',
  accountType: 'ACCOUNT_TYPE',
  txnCode: 'TXN_CODE',
  t: 'T',
  points: 'POINTS',
  storeId: 'STORE_ID',
  error: 'ERROR_CODE_MESSAGE',
};

// Field order for a detail row - used during comparison
export const ROW_FIELDS = [
  'txnDate', 'txnTime', 'batchId', 'prodAcctNbr', 'accountType',
  'txnCode', 't', 'points', 'storeId', 'error',
];
