// scripts/OLSD134R/test-data.js
// Test data and configuration for report OLSD134R "Batch Redemption Exception Report".
//
// This report does not have an input file to upload by itself: the data is written by
// OLSDB009 into the dwh_temp_txn table. Therefore, the "test data" here includes:
//   - CONFIG (host / path / DB) shared between the seed and validation steps
//   - report filters (txn_type = '01', error_code IS NOT NULL, process_date window)
//   - report column positions (fixed-width) used to parse the generated .txt file on the server
//
// IMPORTANT NOTE ON CONFIG: unlike OLSDB024 (where CONFIG is in the spec), here CONFIG is
// kept in this file because both test-runner.spec.js and file-generator.js (seed step) need
// host / path / DB. This is a single source of truth to avoid drift between the seed and
// validation steps. Same approach as OLSD133R - both reports use the MY-dev host and the
// ols_schema schema.
//
// DO NOT import config/test-config.js: that file calls dotenv.config() and overrides
// BATCH_COMMAND to 'process_batch.sh' (which does not exist) - see AGENTS.md section 6.1.
// DO NOT hard-code credentials (AGENTS.md section 3.1): username/password must be read from .env.

import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = process.cwd();

/** Read .env without dotenv or additional dependency - only loads credentials / paths */
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
    // Input directory for OLSDB009 - source data for dwh_temp_txn
    // (same directory currently used by OLSD133R; not the report's input directory)
    remotePath: '/apps/MY-dev/OE/cls/USER_INPUT/OLSDB009/',
    // Staging directory on the server (same as LOCAL_PATH used by other batches)
    localPath: cred('LOCAL_PATH', 'C:\\BATCH-OCBC-PW1\\src\\'),
    // SOURCE segment in the file name OLSTXN-<SOURCE>-YYYYMMDD-NN.dat.
    // Tested on dev: using 'D134R' causes the batch to reject with
    //   "The Source System in the file name does not exist in OLS system"
    // => the source system must be valid ('OLS'). The seed/push file for OLSD134R is marked
    // via the local artifact (see CONFIG.report.seedDir) and by log [OLSD134R].
    fileNameSource: process.env.OLSD134R_FILE_SOURCE || 'OLS',
  },

  putty: {
    path: process.env.PUTTY_PATH || 'C:\\Program Files\\PuTTY\\plink.exe',
    host: '192.168.99.83',
    username: cred('SSH_USERNAME', 'root'),
    password: cred('SSH_PASSWORD', ''),
    // plink stores the host key in the registry: a successful WinSCP upload does NOT
    // mean plink has already trusted this host. If -hostkey is missing, plink stops at
    // the prompt "Store key in cache? (y/n)" and hangs until killed (see AGENTS.md 4.4).
    hostKey: process.env.SSH_HOST_KEY || 'SHA256:kGbLBMkLSnBoYmLg10qgHfmQmtUbawS69GYysVLkXu4',
  },

  batch: {
    // Server-side batch script directory - used by both OLSDB009 (seed) and OLSDR134 (report)
    scriptPath: '/apps/MY-dev/scripts',
    // Batch ID taken from EOD Batch flow v1.10 (SG) row 80: batch = OLSDR134
    // (the batch name is OLSDR134, while the report ID / file name is OLSD134R)
    command: './OLSDR134',
    // Java batch: JVM must start, so do not reduce timeout to a few tens of seconds
    timeout: 600000,
  },

  report: {
    // Dev MY: /apps/MY-dev/OE/cls/USER_OUTPUT/OLSD134R
    // (EOD Batch flow row 80 records the prod path /prodlib/OLSSG/OE/cls/USER_OUTPUT/OLSDR134;
    //  other batches in this project use prod -> /apps/MY-dev/... while keeping the report ID)
    remoteDir: '/apps/MY-dev/OE/cls/USER_OUTPUT/OLSD134R',
    // File name on dev: <country code><reportId><report date>.txt
    //   example: MYOLSD134R20260922.txt (MY). Country code may vary by region
    //   (MY -> ID ...), so it must not be fixed: automation detects files via reportFileGlob().
    reportId: 'OLSD134R',
    prefix: 'MYOLSD134R',
    extension: '.txt',
    localDir: path.join(PROJECT_ROOT, 'reports', 'OLSD134R'),
    // Save a clear copy of the "seed/push file for OLSD134R" (the file uploaded to the server
    // must follow the OLSTXN-OLS-... naming convention, so it cannot be renamed; marked in local artifact)
    seedDir: path.join(PROJECT_ROOT, 'scripts', 'test-data', 'generated', 'OLSD134R', 'seed-push'),
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

// File ID in batch_header/dwh_temp_txn for the OLSTXN process (OLSD134R reads data from here)
export const FILE_ID = 'OLSTXN';

// Receiving system written in HD cell 2 of the pushed OLSTXN file.
// Evidence from the batch (.err): "Invalid Data Receiving System, Accepted Values (OLS)"
// -> OLSTXN files must always declare receiving system 'OLS'.
export const HD_RECEIVING_SYSTEM = process.env.OLSD134R_RECEIVING_SYSTEM || 'OLS';

// module_id in the oe_cutofftime_control table (cut-off time used by this report).
// EOD Batch flow v1.10 row 80 records the cut-off for OLSDR134 = 235959. The order in the
// list reflects the priority when the cut-off for this report has not yet been set on dev -
// every EOD module shares the same cut-off 235959, so the fallback does not change the time window.
export const CUTOFF_MODULE_IDS = ['OLSDR134'];

// txn_type used by the OLSD134R query/report on dwh_temp_txn.
// On dev (22-09-2026, process_date window 2026-09-21 to 2026-09-22):
//   txn_type = '01' -> 6 rows, matching the 6 rows printed in the report (BE654/BE108)
//   txn_type = '03' -> adjustment rows, which are not part of this redemption report
// => the report value is '01' (same as txnTranType stored in the OLSTXN file for OLSD134R).
export const TXN_TYPE_REDEMPTION = process.env.OLSD134R_TXN_TYPE_REPORT || '01';

// txn type recorded in the OLSTXN file (field 1 txnTranType) generated by OLSDB009.
// According to business rules, the OLSTXN file uses '01' (different from '03', which is the value used by the report query on dwh_temp_txn).
export const TXN_TYPE_FILE = process.env.OLSD134R_TXN_TYPE_FILE || '01';

// Source data for the report: OLSTXN generated by OLSDB009 (test case tc1 is reused as a
// template, then file-generator.js rewrites txnTranType to '01' for this redemption report).
export const ADJUSTMENT_SOURCE = {
  batch: 'OLSDB009',
  testCase: 'tc1',
};

// ---------------------------------------------------------------------------
// The report has a single section: redemption transactions rejected by back-end scoring.
//   - filter on dwh_temp_txn: txn_type = '01' AND error_code IS NOT NULL
//   - time window: > previous day cut-off, <= batch date cut-off
//   - group by Chain ID, sorted by Chain ID + Date/Time of transaction
// ---------------------------------------------------------------------------
export const SECTION = {
  key: 'redemption',
  title: 'Batch Redemption Exception',
  titleRegex: /^(Batch\s+Redemption\s+Exception|Redemption\s+Transaction\s+Exception)(\s+Report)?$/i,
  table: 'dwh_temp_txn',
  filter: "t.txn_type = '01' AND t.error_code IS NOT NULL",
  groupHeader: 'chain',
};

// ---------------------------------------------------------------------------
// Column positions in the report (fixed-width), based on the Report Layout for
// 'CRRR OLS Report Specs 3.9 (sent).docx' - section OLSD134R:
//
//   Date Time            Batch Id             Product Account Nbr     Account Type    Sign           Bill Fee    Exception Code & Reason
//   31-12-2020 23:59:59  OLSDB009             PD010                         830 12     +               500.00    BE654 - Transaction does not hit campaign.
//
// If the dev output width changes, only this table needs to be updated (the parser
// falls back to token-based splitting and logs a warning - see test-runner.spec.js).
// ---------------------------------------------------------------------------
export const COLUMN_LAYOUT = {
  // The 2026 report output is wider (MYOLSD134R/IDOLSD134R<date>.txt, 212 chars long);
  // the legacy layout from the 2020 spec (171 chars) is offset, so the parser must fall back to token parsing.
  txnDateTime: [6, 34],   // '22-09-2026 00:00:00'
  batchId: [34, 57],      // 'OLSDB009'
  prodAcctNbr: [57, 90],  // '01052342319997'
  accountType: [90, 123], // '500500MYR'
  sign: [123, 148],       // '+'
  billFee: [148, 159],    // '100.00' (must be exact)
  error: [159, 400],      // 'BE654 - Transaction does not hit campaign.'
};

// Field names used when logging [FAIL]
export const FIELD_LABELS = {
  chainId: 'CHAIN_ID',
  chainName: 'CHAIN_NAME',
  txnDate: 'TRANSACTION_DATE',
  txnTime: 'TRANSACTION_TIME',
  batchId: 'BATCH_ID',
  prodAcctNbr: 'PRODUCT_ACCOUNT_NBR',
  accountType: 'ACCOUNT_TYPE',
  sign: 'SIGN',
  billFee: 'BILL_FEE',
  error: 'EXCEPTION_CODE_REASON',
};

// Field order on each detail row - used for comparison
export const ROW_FIELDS = [
  'txnDate', 'txnTime', 'batchId', 'prodAcctNbr', 'accountType', 'sign', 'billFee', 'error',
];
