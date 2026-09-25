// scripts/OLSD141R/test-data.js
// Test data + configuration for report OLSD141R "CIF Merge File Report".
//
// Flow (BA requirement):
//   OLSCUST (7 new CIFs) -> OLSDB012 -> 7 CLIENT records
//     -> OLSMECIF (4 merge records, CIF# A -> CIF# B) -> OLSDB057 -> DWH_TEMP_CIF_MERGE
//     -> OLSDR141 -> OLSD141R report
//
// CONFIG lives here (not in the spec) because both the seed step and the spec need it - same
// approach as OLSD133R / OLSD134R.
// DO NOT import config/test-config.js (it calls dotenv.config() and overrides BATCH_COMMAND with
// the non-existent process_batch.sh - AGENTS.md 6.1). Credentials come from .env (AGENTS.md 3.1).

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
    // Report batch = OLSDR141, report ID / file name = OLSD141R
    command: './OLSDR141',
    // Java batch: allow JVM startup time (AGENTS.md 4.5)
    timeout: 600000,
  },

  // Step 1: customer maintenance - creates the CIFs used by the merge
  seedCust: {
    batchId: 'OLSDB012',
    fileId: 'OLSCUST',
    receivingSystem: 'OLS',
    // TODO: confirm the dev input folder (EOD flow row 12 lists OLSDB012 with OLSCUST).
    remotePath: process.env.OLSD141R_CUST_REMOTE_PATH || '/apps/MY-dev/OE/cls/USER_INPUT/OLSDB012/',
    seedDir: path.join(PROJECT_ROOT, 'scripts', 'test-data', 'generated', 'OLSD141R', 'seed-cust'),
  },

  // Step 2: CIF merge - creates DWH_TEMP_CIF_MERGE rows read by the report
  seedMerge: {
    batchId: 'OLSDB057',
    fileId: 'OLSMECIF',
    // TODO: confirm the dev input folder (SG EOD flow row 18 = OLSDB057 CIF Merge Process).
    remotePath: process.env.OLSD141R_MERGE_REMOTE_PATH || '/apps/MY-dev/OE/cls/USER_INPUT/OLSDB057/',
    seedDir: path.join(PROJECT_ROOT, 'scripts', 'test-data', 'generated', 'OLSD141R', 'seed-merge'),
  },

  // Sample files provided by the BA - used as the layout template of the generated input files
  // (only the fields listed in MERGE_PAIRS / CIF numbers are patched).
  // The samples are not copied into the repo; override the paths if they move.
  templates: {
    olscust: process.env.OLSD141R_CUST_TEMPLATE || 'F:\\OCBC\\OLSCUST-20260728-01.dat',
    olmecif: process.env.OLSD141R_MECIF_TEMPLATE || 'F:\\OCBC\\OLSMECIF-20260907-01.dat',
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
    // "File Name" printed in the report header = the OLSMECIF file processed by OLSDB057
    fileNamePrefix: 'OLSMECIF',
  },

  database: {
    host: '192.168.99.83',
    port: 5432,
    database: 'ols_my',
    username: cred('DB_USERNAME', 'ols_user'),
    password: cred('DB_PASSWORD', ''),
    schema: 'ols_schema',
    // Column of ols_schema.client that holds the CIF number (confirmed with the BA).
    cifColumn: 'external_reference_no',
  },
};

export const SCHEMA = CONFIG.database.schema;

// ============ REPORT IDENTITY ============
export const REPORT_ID = 'OLSD141R';
// 2025 build (dev sample OLSD141R_01.txt): 'OLSD141R - CIF Merge File Report'
// 2020 build (report spec section 23)     : 'CIF MERGE FILE REPORT (OLSD141R)'
export const TITLE_RE = /CIF\s+MERGE\s+FILE\s+REPORT/i;

// No cut-off time is used for OLSD141R (confirmed with the BA). The expected data of one run is
// selected by the job_id of that OLSDB057 run - see EXPECTED_QUERY.

// Report spec section 23: Y = Successful, N = Not Successful, Z = Not Found.
// The same descriptions are used by the OLSMECIF "Unsuccessful Error Description" field.
export const INDICATOR_DESC = { Y: 'Successful', N: 'Not Successful', Z: 'Not Found' };

// ============ CIF MERGE RECORDS (STEP 2) ============
// 7 CIFs are created by OLSDB012 and referenced by index (1..7 = cif1..cif7).
export const CIF_COUNT = 7;

// Merge records required by the BA: CIF1->CIF2, CIF2->CIF3, CIF4->CIF5, CIF6->CIF7.
// Source/old CIF -> CIF# A, target/new CIF -> CIF# B.
export const MERGE_PAIRS = [
  { source: 1, target: 2 },
  { source: 2, target: 3 },
  { source: 4, target: 5 },
  { source: 6, target: 7 },
];

// Successful Indicator written into the OLSMECIF records.
// The BA did not define which merge record gets Y/N/Z, so the value is configurable:
//   OLSD141R_MERGE_STATUSES="Y,N,Y,Z" (one letter per merge record)
// Default: every record is sent as 'Y'.
export const MERGE_STATUSES = (process.env.OLSD141R_MERGE_STATUSES || '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter((s) => s in INDICATOR_DESC);

/** Status of merge record i (0-based); falls back to 'Y'. */
export function mergeStatusOf(index) {
  return MERGE_STATUSES[index] || 'Y';
}

// recordAction of the OLSCUST detail records: 'A' (Add) - confirmed with the BA, the flow creates
// 7 new CIFs. The provided sample carries 'D' (delete), which is not used.
export const CUST_ACTION = 'A';

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
// Verified field by field against the sample OLSMECIF-20260907-01.dat.
// Header A + Processing Date X(8) + Filler X(331); Trailer T + Total records 9(5) + Filler X(334).
// OLS ignores every detail field except the two CIF numbers.
export const MERGE_FILE_LAYOUT = {
  recordLength: 340,
  header: [
    ['recordType', 1],      // 'A'
    ['processingDate', 8],  // DDMMYYYY (sample: '15082026' for file OLSMECIF-20260907-01.dat)
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
    ['successfulIndicator', 1],    // Y / N / Z (ignored by OLS on input)
    ['unsuccessfulErrorDesc', 40], // Successful / Not Successful / Not Found
    ['corpPersonalIndicator', 1],  // C = Corporate, P = Personal
    ['filler', 10],
  ],
  trailer: [
    ['recordType', 1],      // 'T'
    ['totalRecords', 5],    // header + details + trailer
    ['filler', 334],
  ],
};

// ============ OLSCUST INPUT FILE (pipe delimited) ============
// OLS Batch Interface (Input to OLS) Specifications v1.75, section 2.3 "OLSCUST".
// The generated file is cloned from the sample, so only the cells below are patched:
//   HD : createDate (X(08) YYYYMMDD) + fileNumber 9(04)
//   DT : recordAction X(01) + custCifNbr X(19)     <- cloned once per generated CIF
//   TR : recordCount 9(10) = number of records in the file (header + trailer included)
// The DT/TR cells are located through the FN|DT / FN|TR rows of the sample itself.
export const CUST_FIELDS = {
  detail: { action: 'recordAction', cif: 'custCifNbr' },
  trailer: { count: 'recordCount' },
  // The value cells of a DT record are shifted by 1 against the FN|DT name row (the name row
  // carries the extra 'FN' cell), so valueIndex = nameIndex - 1.
  dtValueOffset: -1,
};
