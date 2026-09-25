// scripts/OLSD141R/test-data.js
// Test data + configuration for report OLSD141R "CIF Merge File Report".
//
// The report has no input file: it reads DWH_TEMP_CIF_MERGE, written by the CIF Merge batch
// OLSDB057 (confirmed with the BA):
//   OLSMECIF-YYYYMMDD-NN.dat -> OLSDB057 -> DWH_TEMP_CIF_MERGE -> OLSDR141 -> OLSD141R report
//
// CONFIG lives here (not in the spec) because both the seed step and the spec need it - same
// approach as OLSD133R / OLSD134R.
// DO NOT import config/test-config.js (it calls dotenv.config() and overrides BATCH_COMMAND with
// the non-existent process_batch.sh - AGENTS.md 6.1). Credentials are read from .env, never
// hard-coded (AGENTS.md 3.1).

import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = process.cwd();

/** Read .env without dotenv - only credentials / paths are needed. */
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
    // Input folder of OLSDB057 - the OLSMECIF file is uploaded here.
    // TODO: confirm the dev path (override with OLSD141R_SEED_REMOTE_PATH).
    remotePath: process.env.OLSD141R_SEED_REMOTE_PATH || '/apps/MY-dev/OE/cls/USER_INPUT/OLSDB057/',
    localPath: cred('LOCAL_PATH', 'C:\\BATCH-OCBC-PW1\\src\\'),
  },

  putty: {
    path: process.env.PUTTY_PATH || 'C:\\Program Files\\PuTTY\\plink.exe',
    host: '192.168.99.83',
    username: cred('SSH_USERNAME', 'root'),
    password: cred('SSH_PASSWORD', ''),
    // -hostkey is required: without it plink hangs at the "Store key in cache?" prompt
    // because there is no stdin (AGENTS.md 4.4).
    hostKey: process.env.SSH_HOST_KEY || 'SHA256:kGbLBMkLSnBoYmLg10qgHfmQmtUbawS69GYysVLkXu4',
  },

  batch: {
    scriptPath: '/apps/MY-dev/scripts',
    // Batch = OLSDR141, report ID / file name = OLSD141R
    command: './OLSDR141',
    // Java batch: allow JVM startup time (AGENTS.md 4.5)
    timeout: 600000,
  },

  // Upstream batch that creates the report data
  seed: {
    batchId: 'OLSDB057',
    scriptPath: '/apps/MY-dev/scripts',
    fileId: 'OLSMECIF',
    fileNamePrefix: 'OLSMECIF',
    extension: '.dat',
    seedDir: path.join(PROJECT_ROOT, 'scripts', 'test-data', 'generated', 'OLSD141R', 'seed'),
  },

  report: {
    // Dev MY: /apps/MY-dev/OE/cls/USER_OUTPUT/OLSD141R (same pattern as OLSD133R/134R)
    remoteDir: process.env.OLSD141R_REPORT_DIR || '/apps/MY-dev/OE/cls/USER_OUTPUT/OLSD141R',
    reportId: 'OLSD141R',
    // Country code may vary (MY/ID), so the file is found by reportFileGlob(), not by a
    // fixed prefix.
    prefix: 'MYOLSD141R',
    extension: '.txt',
    localDir: path.join(PROJECT_ROOT, 'reports', 'OLSD141R'),
    // "File Name" printed in the report header
    fileNamePrefix: 'OLSMECIF',
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

// ============ REPORT IDENTITY ============
export const REPORT_ID = 'OLSD141R';
// 2025 build (dev sample OLSD141R_01.txt): 'OLSD141R - CIF Merge File Report'
// 2020 build (report spec section 23)     : 'CIF MERGE FILE REPORT (OLSD141R)'
export const TITLE_RE = /CIF\s+MERGE\s+FILE\s+REPORT/i;

// module_id in oe_cutofftime_control. The BA removed the cut-off condition from this validation
// turn, so it is only read for logging - expected data is selected by the OLSDB057 job_id.
export const CUTOFF_MODULE_IDS = ['OLSDR141'];

// Report spec section 23: Y = Successful, N = Not Successful, Z = Not Found.
export const INDICATOR_DESC = { Y: 'Successful', N: 'Not Successful', Z: 'Not Found' };

// ============ REPORT COLUMN LAYOUT (fixed width, 413 chars per printed line) ============
// Measured on the real layout file OLSD141R_01.txt. Declared widths: X(19) / X(35) / X(35) /
// X(19) / X(35) / X(35) / X(1) / X(40); "Error Code" and "Error Description" are printed in the
// layout but are not part of the original field definition.
// If the printed width changes, update only this table: the parser falls back to token splitting.
export const COLUMN_LAYOUT = {
  cifA: [1, 32],
  name1A: [32, 83],
  name2A: [83, 134],
  cifB: [134, 165],
  name1B: [165, 216],
  name2B: [216, 267],
  indicator: [267, 298],
  errorDesc: [298, 349],
  errorCode: [349, 362],
  errorMessage: [362, 413],
};

export const ROW_LENGTH = 413;

// Field names used in the [FAIL] log
export const FIELD_LABELS = {
  cifA: 'CIF# A',
  name1A: 'CIF A Name 1',
  name2A: 'CIF A Name 2',
  cifB: 'CIF# B',
  name1B: 'CIF B Name 1',
  name2B: 'CIF B Name 2',
  indicator: 'SUCCESSFUL_INDICATOR',
  errorDesc: 'UNSUCCESSFUL_ERROR_DESCRIPTION',
  errorCode: 'ERROR_CODE',
  errorMessage: 'ERROR_DESCRIPTION',
};

// Field order per detail row. 'valid' is selected by the expected query but is not printed on
// the report, so it is not compared.
export const ROW_FIELDS = [
  'cifA', 'name1A', 'name2A', 'cifB', 'name1B', 'name2B',
  'indicator', 'errorDesc', 'errorCode', 'errorMessage',
];

// ============ EXPECTED DATA (DWH_TEMP_CIF_MERGE) ============
// Query and column mapping provided by the BA - do not rename these columns.
export const EXPECTED_QUERY = `
  SELECT dtcm.cif_nbr_a,
         dtcm.customer_name_1_a,
         dtcm.customer_name_2_a,
         dtcm.cif_nbr_b,
         dtcm.customer_name_1_b,
         dtcm.customer_name_2_b,
         dtcm.valid,
         dtcm.successful_indicator,
         dtcm.unsuccessful_error_desc,
         dtcm.error_code,
         dtcm.error_message
    FROM dwh_temp_cif_merge dtcm
   WHERE dtcm.job_id = $1
   ORDER BY cif_nbr_a, cif_nbr_b`;

// ============ OLSMECIF INPUT FILE (340 chars per record) ============
// OLS Batch Interface (Input to OLS) Specifications v1.75, section 2.12 "OLSMECIF - CIF Merge".
// Header A + Processing Date X(8) + Filler X(331); Trailer T + Total records 9(5) + Filler X(334).
// OLS ignores every detail field except the two CIF numbers.
export const MERGE_FILE_LAYOUT = {
  recordLength: 340,
  header: [
    ['recordType', 1],      // 'A'
    ['processingDate', 8],  // YYYYMMDD
    ['filler', 331],
  ],
  detail: [
    ['recordType', 1],             // 'D'
    ['cifNumberA', 19],            // Transfer FROM (old CIF#) - mandatory
    ['aIdNumber', 30],
    ['aIdTypeCode', 2],
    ['aIdOwnerCtyCode', 3],
    ['aName1', 35],
    ['aName2', 35],
    ['cifNumberB', 19],            // Transfer TO (new CIF#) - mandatory
    ['bIdNumber', 30],
    ['bIdTypeCode', 2],
    ['bIdOwnerCtyCode', 3],
    ['bName1', 35],
    ['bName2', 35],
    ['createUserId', 10],
    ['createWorkstation', 10],
    ['createDate', 7],
    ['createDateDmy', 6],
    ['createTime', 6],
    ['successfulIndicator', 1],    // ignored on input
    ['unsuccessfulErrorDesc', 40], // ignored on input
    ['corpPersonalIndicator', 1],  // C = Corporate, P = Personal
    ['filler', 10],
  ],
  trailer: [
    ['recordType', 1],      // 'T'
    ['totalRecords', 5],
    ['filler', 334],
  ],
};

/** Total length of a record definition - asserts the 340-char contract. */
export function recordLengthOf(fields) {
  return fields.reduce((total, [, width]) => total + width, 0);
}
