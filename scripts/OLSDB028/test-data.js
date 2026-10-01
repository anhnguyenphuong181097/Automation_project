// scripts/OLSDB028/test-data.js
// Test data + configuration for batch OLSDB028 (job name: redeemItemExportJob).
//
// OLSDB028 is an EXPORT batch: it has no input .dat file. It reads the fulfillment records that
// the Item Redemption API (OL59) already created in item_fulfilment_status / _his, and writes the
// "fixed pipe delimiter" file OLSITRED.dat for the receiving system CLK.
//
//   Item Redemption API (OL59)  ->  ITEM_FULFILMENT_STATUS (+ ITEM_FULFILMENT_STATUS_HIS)
//     -> ./OLSDB028 (redeemItemExportJob)
//     -> /apps/MY-dev/OE/cls/USER_OUTPUT/OLSDB028/OLSITRED.dat
//
// Sources of truth used for this implementation (read-only inspection, nothing guessed):
//   * Layout / test cases : F:\OCBC\pms28251_[CRRR-553] - [OLSDB028] Amend column name and
//                           length.xlsx  (25 TCs, adds itmRdmReferenceNo X(15))
//                           F:\OCBC\pms26632_CRRR-553 - OLSDB028_Add new output file
//                           OLSITRED.xlsx  (original 19 TCs)
//   * Batch wrapper       : /apps/MY-dev/scripts/OLSDB028 -> /apps/MY-dev/OE/onebatch/bin/
//                           OLSDB028.sh  (JOB_NAME=redeemItemExportJob)
//   * Item types accepted : /apps/MY-dev/OE/onebatch/config/properties/OLSDB028.properties
//   * Cut-off row         : ols_schema.oe_cutofftime_control.module_id = 'OLSDB028'
//   * DB columns          : information_schema.columns of item_fulfilment_status / _his
//
// CONFIG lives here (not in the spec) because both the spec and any future data-preparation step
// need it - same approach as OLSD133R / OLSD134R / OLSD141R.
// DO NOT import config/test-config.js (it calls dotenv.config() and overrides BATCH_COMMAND with
// the non-existent process_batch.sh - AGENTS.md 6.1). Credentials come from .env (AGENTS.md 3.1);
// nothing from .env is printed or written back.

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
    // -hostkey is required: without it plink hangs at the "Store key in cache?" prompt because
    // there is no stdin (AGENTS.md 4.4). Empty .env value -> the dev server key.
    hostKey: cred('SSH_HOST_KEY', 'SHA256:kGbLBMkLSnBoYmLg10qgHfmQmtUbawS69GYysVLkXu4'),
  },

  batch: {
    scriptPath: '/apps/MY-dev/scripts',
    // /apps/MY-dev/scripts/OLSDB028 -> $BIN_DIR/OLSDB028.sh -> jobName=redeemItemExportJob
    command: './OLSDB028',
    batchId: 'OLSDB028',
    jobName: 'redeemItemExportJob',
    // Java batch: allow JVM startup time (AGENTS.md 4.5).
    timeout: 600000,
    // Unwind job of the export (only used by the optional unwind check).
    unwindCommand: './OLSRB028',
  },

  output: {
    // Folder named by the BA in TC_01_1 of the spec sheet.
    remoteDir: process.env.OLSDB028_OUTPUT_DIR || '/apps/MY-dev/OE/cls/USER_OUTPUT/OLSDB028',
    // TC_01_1: "Filename output is OLSITRED.dat" (no date / sequence in the name).
    fileName: process.env.OLSDB028_FILE_NAME || 'OLSITRED.dat',
    extension: '.dat',
    localDir: path.join(PROJECT_ROOT, 'reports', 'OLSDB028'),
  },

  // Item Redemption API (OL59) used to prepare the input data of OLSDB028. The request itself is
  // NOT hard-coded in the code: it lives in the data file below (baseline template + one entry per
  // redemption). See file-generator.js.
  itemRedemptionApi: {
    url: process.env.OLSDB028_API_URL ||
      'https://dev-my.ocbc.apps.okd.oneempower.com.vn/ols-one-channels/api/item/itemRedeem',
    dataFile: process.env.OLSDB028_API_DATA ||
      path.join(PROJECT_ROOT, 'scripts', 'OLSDB028', 'api-data', 'OL59-itemRedeem.json'),
    timeoutMs: Number(process.env.OLSDB028_API_TIMEOUT_MS || 60000),
    // The dev gateway serves a self-signed certificate. Set OLSDB028_INSECURE_TLS=0 to refuse it.
    insecureTls: process.env.OLSDB028_INSECURE_TLS !== '0',
    // SvcRq.ChannelId / OLSRq.Region are NOT trusted from the data file: the dev environment
    // changed its Region configuration on 29/09/2026 (MB+MY worked at 16:06 and answered
    // E0003 "Invalid Region" one hour later, while MB+ID passed). The generator therefore probes
    // these candidates with an impossible price (which can never create data) and keeps the first
    // pair the API accepts. Pin them with OLSDB028_CHANNEL / OLSDB028_REGION when needed.
    channelOverride: process.env.OLSDB028_CHANNEL || null,
    regionOverride: process.env.OLSDB028_REGION || null,
    // Region this environment MUST serve: dev-my + DB ols_my + the BA payloads are all MY.
    // The generator compares it with the region the API actually accepts (probed) and fails when
    // they differ - the fix then belongs to the API/deployment config, not to the payload.
    expectedRegion: (process.env.OLSDB028_EXPECTED_REGION || 'MY').toUpperCase(),
    regionCandidates: (process.env.OLSDB028_REGIONS || 'MY,ID,SG,HK,MO,TH,VN')
      .split(',').map((value) => value.trim()).filter(Boolean),
  },

  database: {
    host: '192.168.99.83',
    port: 5432,
    database: 'ols_my',
    username: cred('DB_USERNAME', 'ols_user'),
    password: cred('DB_PASSWORD', ''),
    schema: 'ols_schema',
  },

  // Fallback when OL59 answers "not enough points": top the pool up with an ADJUSTMENT
  // transaction (OLSTXN, txnTranType '03') processed by the OLSDB009 batch - the same mechanism
  // the OLSD134R seeding uses. Only the shortfall is added, and the account is resolved from the
  // CIF + the statement_output_pool configuration of the redeemed pool.
  adjustment: {
    batchId: 'OLSDB009',
    command: './OLSDB009',
    remotePath: process.env.OLSDB028_ADJ_REMOTE_PATH || '/apps/MY-dev/OE/cls/USER_INPUT/OLSDB009/',
    localDir: path.join(PROJECT_ROOT, 'scripts', 'test-data', 'generated', 'OLSDB028', 'adjust'),
    // Java batch: allow JVM startup time (AGENTS.md 4.5)
    timeout: 600000,
    reasonIndex: Number(process.env.OLSDB028_ADJ_REASON_INDEX || 0),
  },

  // The API has no error catalogue in the database (ols_schema.error_code is empty). The BA/dev
  // confirmed the code: E5922 "Insuffient point balance" (sic). The message pattern is kept as a
  // second trigger because the API message has a typo; extend with
  // OLSDB028_INSUFFICIENT_CODES="E5922,E59xx" when more codes appear.
  insufficientPoint: {
    codes: (process.env.OLSDB028_INSUFFICIENT_CODES || 'E5922')
      .split(',').map((value) => value.trim()).filter(Boolean),
    pattern: new RegExp(process.env.OLSDB028_INSUFFICIENT_PATTERN ||
      'insuff|not enough|exceed[s]?\\s+(the\\s+)?balance|no\\s+sufficient',
      'i'),
  },
};

export const SCHEMA = CONFIG.database.schema;

// ============ BATCH IDENTITY ============
export const BATCH_ID = 'OLSDB028';
export const JOB_NAME = 'redeemItemExportJob';
export const OUTPUT_ID = 'OLSITRED';
// ols_schema.oe_cutofftime_control.module_id used by OLSDB028 (verified on dev).
export const CUTOFF_MODULE_ID = 'OLSDB028';

// ============ ITEM TYPES ACCEPTED BY OLSDB028 ============
// /apps/MY-dev/OE/onebatch/config/properties/OLSDB028.properties
//   batch.OLSDB028.item.type=LD,GT,DN,PI,KF,CT,EV,FB,EY,BA,CX,AC,MR,IH,UA,AA,OV,GA,TL,IG,DM,BB,CC,GE,MM
export const SUPPORTED_ITEM_TYPES = [
  'LD', 'GT', 'DN', 'PI', 'KF', 'CT', 'EV', 'FB', 'EY', 'BA', 'CX', 'AC', 'MR',
  'IH', 'UA', 'AA', 'OV', 'GA', 'TL', 'IG', 'DM', 'BB', 'CC', 'GE', 'MM',
];

// ============ CUT-OFF RULES ============
// TC_01_3 : first run  -> last_cutoff_time = 2021-01-01 (properties initialLastCutOffTime),
//                        current_cutoff_time = MAX(item_fulfilment_status.extracted_date_time)
// TC_01_4 : next runs  -> last_cutoff_time = previous current_cutoff_time,
//                        current_cutoff_time = MAX(extracted_date_time);
//                        the previous pair is archived in oe_cutofftime_control_his (status 'I').
// TC_01_5 : the extracted rows must satisfy
//                        last_cutoff_time < extracted_date_time <= current_cutoff_time
// The exact moment when the batch captures MAX(extracted_date_time) is not documented, so the
// spec compares with a tolerance (see CUTOFF_TOLERANCE_MS) instead of asserting equality.
export const INITIAL_LAST_CUTOFF_TIME = '2021-01-01';
export const CUTOFF_TOLERANCE_MS = 2000;
export const CUTOFF_HIS_STATUS = 'I';

// ============ OLSITRED FILE LAYOUT ============
// Field order verified field by field against the spec sheet. Only the order and the lengths from
// the sheet are encoded here; the file itself is a "fixed pipe delimiter" file (HD, then the FN
// definition lines, then DT records, then TR), so the parser splits on '|' and uses this order.
//
// Header  : HD + fileId + receivingSystem + batchDate + createDate + fileNumber
// Detail  : DT + itmRdmDate + itmRdmReferenceNo + itmRdmCardNumber + itmRdmPool + Filler +
//           itmPartnerCode + itmRdmItemCode + itmRdmItemDescription + itmRdmPoints +
//           itmRdmQuantity + itmRdmFulfillmentStatus + itmRdmFulfillmentStatusDescription +
//           itmRdmStatusUpdateDate + itmRdmUserId
// Trailer : TR + hash(itmRdmCardNumber) + hash(itmRdmPoints) + hash(itmRdmQuantity) + recordCount
export const HEADER_FIELDS = [
  { name: 'recordType', label: 'recordType', type: 'X', length: 2 },            // 'HD'
  { name: 'fileId', label: 'fileId', type: 'X', length: 10 },                   // 'OLSITRED  '
  { name: 'receivingSystem', label: 'receivingSystem', type: 'X', length: 10 }, // 'CLK       '
  { name: 'batchDate', label: 'batchDate', type: 'X', length: 8 },              // YYYYMMDD
  { name: 'createDate', label: 'createDate', type: 'X', length: 8 },            // YYYYMMDD
  { name: 'fileNumber', label: 'fileNumber', type: '9', length: 4 },            // 9(04)
];

export const DETAIL_FIELDS = [
  { name: 'recordTag', label: 'recordTag', type: 'X', length: 2 },                 // 'DT'
  { name: 'itmRdmDate', label: 'itmRdmDate', type: 'X', length: 8 },               // YYYYMMDD
  { name: 'itmRdmReferenceNo', label: 'itmRdmReferenceNo', type: 'X', length: 15 }, // REFERENCE_NO
  { name: 'itmRdmCardNumber', label: 'itmRdmCardNumber', type: 'X', length: 20 },
  { name: 'itmRdmPool', label: 'itmRdmPool', type: 'X', length: 5 },
  // Real file (dev, 29/09/2026): 'DT|...|90KO|||LINHX2|LINHX2|...' - two empty cells here are
  // 'filler' (always spaces) followed by 'itmPartnercode', which is empty when the DB column
  // item_fulfilment_status.supplier_id is NULL (the case for most rows on dev).
  { name: 'Filler', label: 'Filler', type: 'X', length: 21, declared: 'filler' },
  { name: 'itmPartnerCode', label: 'itmPartnerCode', type: 'X', length: 2, declared: 'itmPartnercode' },
  { name: 'itmRdmItemCode', label: 'itmRdmItemCode', type: 'X', length: 30 },
  { name: 'itmRdmItemDescription', label: 'itmRdmItemDescription', type: 'X', length: 100 },
  { name: 'itmRdmPoints', label: 'itmRdmPoints', type: '9', length: 14, scale: 2 }, // DB * 100
  { name: 'itmRdmQuantity', label: 'itmRdmQuantity', type: '9', length: 8 },
  { name: 'itmRdmFulfillmentStatus', label: 'itmRdmFulfillmentStatus', type: 'X', length: 2 },
  { name: 'itmRdmFulfillmentStatusDescription', label: 'itmRdmFulfillmentStatusDescription', type: 'X', length: 30, declared: 'itmRdmFulfillmentStatusDesc' },
  { name: 'itmRdmStatusUpdateDate', label: 'itmRdmStatusUpdateDate', type: 'X', length: 8 }, // YYYYMMDD
  { name: 'itmRdmUserId', label: 'itmRdmUserId', type: 'X', length: 10 },
];

export const TRAILER_FIELDS = [
  { name: 'recordTag', label: 'recordTag', type: 'X', length: 2 },                  // 'TR'
  { name: 'hashItmRdmCardNumber', label: 'Hash(itmRdmCardNumber)', type: '9', length: 10, declared: 'itmRdmCardNumber' },
  { name: 'hashItmRdmPoints', label: 'Hash(itmRdmPoints)', type: '9', length: 10, declared: 'itmRdmPoints' },
  { name: 'hashItmRdmQuantity', label: 'Hash(itmRdmQuantity)', type: '9', length: 10, declared: 'itmRdmQuantity' },
  { name: 'recordCount', label: 'recordCount', type: '9', length: 10, declared: 'recordCount' },
];

// Filler is always spaces (TC_01_19); it is never compared against the database.
export const FILLER_FIELD = 'Filler';

// ============ EXPECTED OUTPUT (BUILT FROM THE DATABASE, NOT FROM THE REQUEST) ============
// The requirement is explicit: the DB record created by the API is the source of truth for the
// expected OLSITRED row (the system may transform / enrich data). Never compare the raw API
// payload with the file.
//
// EXPECTED_QUERY below is the query the BA provided for OLSDB028 (kept verbatim, only the two
// timestamps are parameterised as $1 / $2, both in 'DD-MM-YYYY HH24:MI:SS').
//
// Two things about it matter for the comparison:
//   1. It is GROUPED, so one result row = one OLSITRED Detail record:
//        quantity     = COUNT(*) of the source rows of the group (TC_01_24)
//        redeemed_point = SUM(redeemed_point) * 100, i.e. already the printed value (TC_01_23)
//      Group key: transaction_date(day), extracted_date_time(day), pool_id, item_code, item_name,
//      fulfillment_status, description, card_no, reference_no, last_approve_by, temp_column
//      ('MAIN' = item_fulfilment_status, 'HIS' = item_fulfilment_status_his), supplier_id.
//   2. Field mapping of the printed Detail record:
//        itmRdmDate                  <- DATE_TRUNC('day', transaction_date)          (TC_01_15)
//        itmRdmReferenceNo           <- reference_no                                 (TC_01_16)
//        itmRdmCardNumber            <- card_no                                      (TC_01_17)
//        itmRdmPool                  <- pool_id                                      (TC_01_18)
//        itmPartnerCode              <- supplier_id                                  (TC_01_20)
//        itmRdmItemCode              <- item_code                                    (TC_01_21)
//        itmRdmItemDescription       <- item_name                                    (TC_01_22)
//        itmRdmPoints                <- SUM(redeemed_point) * 100                    (TC_01_23)
//        itmRdmQuantity              <- COUNT(*)                                     (TC_01_24)
//        itmRdmFulfillmentStatus     <- fulfillment_status                           (TC_01_25)
//        itmRdmFulfillmentStatusDesc <- fulfillment_status.description (status 'A')   (TC_01_26)
//        itmRdmUserId                <- cat_catalogue_trans_details.last_approve_by   (TC_01_28)
//        itmRdmStatusUpdateDate      <- NOT in the BA query (see SOFT_FIELDS, TC_01_27)
//
// The BA query also fixes the source filters that my first version was missing:
//   * item_fulfilment_status     : status = 'A'
//   * item_fulfilment_status_his : status = 'I'
//   * last_update_by NOT LIKE '%OLSRB%'   -> records touched by the OLSRB028 unwind are excluded
//   * INNER JOIN cat_catalogue_trans_details (status 'A') -> a reference is only exported when the
//     redemption also exists in the catalogue transaction table (this is where last_approve_by,
//     i.e. itmRdmUserId, comes from)
export const SOURCE_TABLE = 'item_fulfilment_status';
export const SOURCE_TABLE_HIS = 'item_fulfilment_status_his';

// Timestamps are passed to the BA query in its own format.
export const SQL_TIMESTAMP_FORMAT = 'DD-MM-YYYY HH24:MI:SS';

/** 'DD-MM-YYYY HH24:MI:SS' of a Date / ISO / 'YYYY-MM-DD HH24:MI:SS' value (for $1 and $2). */
export function formatWindowParam(value) {
  if (!value) return null;
  const date = value instanceof Date
    ? value
    : new Date(String(value).replace(' ', 'T') + (String(value).includes('T') ? '' : ''));
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Expected rows of one export run (BA query for OLSDB028).
 * $1 = last_cutoff_time of the run (the value BEFORE the run), $2 = current_cutoff_time of the run
 * (the value AFTER the run), both 'DD-MM-YYYY HH24:MI:SS'. The extraction rule (TC_01_5) is
 *   last_cutoff_time < extracted_date_time <= current_cutoff_time
 *
 * Only one column was added to the BA query: MIN(a.fulfill_status_update_date) AS
 * min_status_update_date - it is not in the reference query and is used only as a SOFT comparison
 * for TC_01_27 (see SOFT_FIELDS). Everything else is byte for byte the reference query.
 */
export const EXPECTED_QUERY = `
SELECT
    DATE_TRUNC('day', a.transaction_date)      AS transaction_date,
    DATE_TRUNC('day', a.extracted_date_time)   AS extracted_date_time,
    COUNT(*)                                   AS quantity,
    SUM(a.redeemed_point) * 100                AS redeemed_point,
    a.pool_id,
    a.item_code,
    a.item_name,
    MIN(a.item_type)                           AS item_type,
    a.fulfillment_status,
    a.description,
    a.card_no,
    a.reference_no,
    a.last_approve_by,
    a.temp_column,
    MIN(a.extracted_date_time)                 AS min_extracted_date_time,
    a.supplier_id,
    MIN(a.fulfill_status_update_date)          AS min_status_update_date
FROM (
    SELECT
        ifs.transaction_date,
        ifs.extracted_date_time,
        ifs.pool_id,
        ifs.item_code,
        ifs.item_name,
        ifs.item_type,
        ifs.redeemed_point,
        ifs.fulfillment_status,
        fs.description,
        ifs.card_no,
        ifs.reference_no,
        ctdt.last_approve_by,
        ifs.supplier_id,
        ifs.fulfill_status_update_date,
        'MAIN' AS temp_column
    FROM ${SCHEMA}.item_fulfilment_status ifs
        LEFT JOIN ${SCHEMA}.fulfillment_status fs
            ON ifs.fulfillment_status = fs.fulfillment_status
            AND fs.status = 'A'
        INNER JOIN (
            SELECT DISTINCT reference_no, last_approve_by
            FROM ${SCHEMA}.cat_catalogue_trans_details
            WHERE status = 'A'
        ) ctdt ON ifs.reference_no = ctdt.reference_no
    WHERE ifs.status = 'A'
        AND ifs.last_update_by NOT LIKE '%OLSRB%'
        AND ifs.extracted_date_time >  TO_TIMESTAMP($1, 'DD-MM-YYYY HH24:MI:SS')::timestamp
        AND ifs.extracted_date_time <= TO_TIMESTAMP($2, 'DD-MM-YYYY HH24:MI:SS')::timestamp
    UNION ALL
    SELECT
        his.transaction_date,
        his.extracted_date_time,
        his.pool_id,
        his.item_code,
        his.item_name,
        his.item_type,
        his.redeemed_point,
        his.fulfillment_status,
        fs.description,
        his.card_no,
        his.reference_no,
        ctdt.last_approve_by,
        his.supplier_id,
        his.fulfill_status_update_date,
        'HIS' AS temp_column
    FROM ${SCHEMA}.item_fulfilment_status_his his
        LEFT JOIN ${SCHEMA}.fulfillment_status fs
            ON his.fulfillment_status = fs.fulfillment_status
            AND fs.status = 'A'
        INNER JOIN (
            SELECT DISTINCT reference_no, last_approve_by
            FROM ${SCHEMA}.cat_catalogue_trans_details
            WHERE status = 'A'
        ) ctdt ON his.reference_no = ctdt.reference_no
    WHERE his.status = 'I'
        AND his.last_update_by NOT LIKE '%OLSRB%'
        AND his.extracted_date_time >  TO_TIMESTAMP($1, 'DD-MM-YYYY HH24:MI:SS')::timestamp
        AND his.extracted_date_time <= TO_TIMESTAMP($2, 'DD-MM-YYYY HH24:MI:SS')::timestamp
) a
GROUP BY
    DATE_TRUNC('day', a.transaction_date),
    DATE_TRUNC('day', a.extracted_date_time),
    a.pool_id,
    a.item_code,
    a.item_name,
    a.fulfillment_status,
    a.description,
    a.card_no,
    a.reference_no,
    a.last_approve_by,
    a.temp_column,
    a.supplier_id
ORDER BY
    MIN(a.extracted_date_time),
    a.item_code,
    DATE_TRUNC('day', a.transaction_date)`;

// itmRdmStatusUpdateDate (TC_01_27) is NOT part of the BA query, so a mismatch is reported as a
// soft/unverified difference instead of failing TC03.
export const SOFT_FIELDS = ['itmRdmStatusUpdateDate'];

/** record_no still present in item_fulfilment_status while the _his copy exists (reported only). */
export const OVERLAP_QUERY = `
  SELECT a.record_no::text AS record_no, a.reference_no
    FROM ${SCHEMA}.${SOURCE_TABLE} a
    JOIN ${SCHEMA}.${SOURCE_TABLE_HIS} b ON b.record_no = a.record_no
   WHERE a.extracted_date_time >  TO_TIMESTAMP($1, 'DD-MM-YYYY HH24:MI:SS')::timestamp
     AND a.extracted_date_time <= TO_TIMESTAMP($2, 'DD-MM-YYYY HH24:MI:SS')::timestamp`;

/** TC_01_3 / TC_01_4: MAX(extracted_date_time) of the source tables (the expected new cutoff). */
export const MAX_EXTRACTED_QUERY = `
  SELECT to_char(MAX(extracted_date_time), 'YYYY-MM-DD HH24:MI:SS.MS') AS max_extracted,
         to_char(MIN(extracted_date_time), 'YYYY-MM-DD HH24:MI:SS.MS') AS min_extracted,
         COUNT(*)::text AS row_count
    FROM (
      SELECT extracted_date_time FROM ${SCHEMA}.${SOURCE_TABLE}
      UNION ALL
      SELECT extracted_date_time FROM ${SCHEMA}.${SOURCE_TABLE_HIS}
    ) s`;

/**
 * Same MAX(extracted_date_time) but restricted to the rows the BA query can export (status /
 * OLSRB028-unwind filter / cat_catalogue_trans_details join, no time window). The batch may use
 * this value as the new current_cutoff_time, so TC04 accepts either MAX.
 */
export const MAX_EXTRACTED_FILTERED_QUERY = `
  SELECT to_char(MAX(a.extracted_date_time), 'YYYY-MM-DD HH24:MI:SS.MS') AS max_extracted_filtered
    FROM (
      SELECT ifs.extracted_date_time
        FROM ${SCHEMA}.item_fulfilment_status ifs
        INNER JOIN (
            SELECT DISTINCT reference_no FROM ${SCHEMA}.cat_catalogue_trans_details WHERE status = 'A'
        ) ctdt ON ifs.reference_no = ctdt.reference_no
       WHERE ifs.status = 'A' AND ifs.last_update_by NOT LIKE '%OLSRB%'
      UNION ALL
      SELECT his.extracted_date_time
        FROM ${SCHEMA}.item_fulfilment_status_his his
        INNER JOIN (
            SELECT DISTINCT reference_no FROM ${SCHEMA}.cat_catalogue_trans_details WHERE status = 'A'
        ) ctdt ON his.reference_no = ctdt.reference_no
       WHERE his.status = 'I' AND his.last_update_by NOT LIKE '%OLSRB%'
    ) a`;

/** Current cut-off control row of OLSDB028. */
export const CUTOFF_QUERY = `
  SELECT record_no::text                                           AS record_no,
         module_id,
         to_char(last_cutoff_time, 'YYYY-MM-DD HH24:MI:SS.MS')     AS last_cutoff_time,
         to_char(current_cutoff_time, 'YYYY-MM-DD HH24:MI:SS.MS')  AS current_cutoff_time,
         control_cutoff_time,
         status
    FROM ${SCHEMA}.oe_cutofftime_control
   WHERE module_id = $1
   ORDER BY record_no DESC
   LIMIT 1`;

/** Cut-off archive rows of OLSDB028 (TC_01_4 expects one more row after the 2nd run). */
export const CUTOFF_HIS_QUERY = `
  SELECT COUNT(*)::text                                         AS row_count,
         to_char(MAX(last_cutoff_time), 'YYYY-MM-DD HH24:MI:SS.MS')    AS max_last_cutoff_time,
         to_char(MAX(current_cutoff_time), 'YYYY-MM-DD HH24:MI:SS.MS') AS max_current_cutoff_time
    FROM ${SCHEMA}.oe_cutofftime_control_his
   WHERE module_id = $1`;

/** batch_date used by the batch for the header fields (TC_01_9 / TC_01_10). */
export const BATCH_DATE_QUERY = `
  SELECT record_no::text AS record_no,
         to_char(batch_date, 'YYYY-MM-DD')      AS batch_date,
         to_char(processing_date, 'YYYY-MM-DD') AS processing_date
    FROM ${SCHEMA}.batch_date
   ORDER BY record_no DESC
   LIMIT 1`;

// Description of a fulfillment status (TC_01_26). The source table has not been confirmed with
// the BA, so the spec resolves it when possible and reports it as unverified otherwise.
export const FULFILLMENT_STATUS_TABLE = 'fulfillment_status';

/**
 * Active price rows of an item. The Item Redemption API request must be filled from the database,
 * not from hard-coded literals (SvcRq.ChannelId, unit price, pool, reward currency):
 *   SvcRq.ChannelId            <- item_price.redemption_channel        ('[MB]' / 'MB' -> 'MB')
 *   itmRdmRewardCurrency       <- item_price.reward_currency_code      (matcher)
 *   itmRdmFullPriceInPoints    <- item_price.price_in_point * quantity
 *   itmRdmPoolUnitsRequired    <- same as the price
 *   pool                        item_price.pool_id
 * One item can have several active prices (UG7814: ENQ1/0VN/12 and HT4/3CC/119), so the row is
 * selected by reward_currency_code (the field the request itself carries) and must be unique.
 */
export const ITEM_PRICE_QUERY = `
  SELECT price_id::text              AS price_id,
         item_code,
         pool_id,
         sub_pool_id,
         reward_currency_code,
         redemption_channel,
         redemption_channel_arr,
         price_in_point::text        AS price_in_point,
         item_currency,
         to_char(start_date, 'YYYY-MM-DD') AS start_date,
         to_char(end_date, 'YYYY-MM-DD')   AS end_date
    FROM ${SCHEMA}.item_price
   WHERE item_code = $1
     AND status = 'A'
   ORDER BY price_id`;

export const CHECK_SHEET =
  'F:\\OCBC\\pms28251_[CRRR-553] - [OLSDB028] Amend column name and length.xlsx';

// ============ STATEMENT OUTPUT POOL (SOPC) ============
// Rule from the BA: the pool of the redeemed item must be configured for statement output, that
// configuration must still be effective, and the account behind the redemption must belong to a
// product account level (PAL) listed for the pool.
//
// ols_schema.statement_output_pool (49 rows on dev, one per pool - verified 29/09/2026):
//   pool_id                varchar(10)   'ENQ1'
//   pool_start_date/end_date timestamp   end_date has NO null rows (confirmed by the BA)
//   status                 char(1)       'A'
//   product_account_level  varchar(4000) a LIST of allowed levels: '[PARTNER, OCR, 802, 500, ...]'
//
// The key of the match is item_fulfilment_status.product_account_level (PAL), NOT
// product_account_type (PAT). Proof from the exported rows of the 29/09/2026 run:
//   pool ENQ1, PAL=OCR, PAT=RWD  -> list '[PARTNER, OCR, 802, 500, 501, CCC]' -> PAL in list,
//   pool HT,   PAL=OCR, PAT=MIG  -> list '[OCR, PARTNER, 802]'                -> PAL in list.
// (Every exported row had its PAL in the list and its PAT outside it.)
export const SOPC_TABLE = 'statement_output_pool';

export const SOPC_QUERY = `
  SELECT record_no::text                                            AS record_no,
         pool_id,
         status,
         to_char(pool_start_date, 'YYYY-MM-DD HH24:MI:SS')          AS pool_start_date,
         to_char(pool_end_date,   'YYYY-MM-DD HH24:MI:SS')          AS pool_end_date,
         product_account_level
    FROM ${SCHEMA}.${SOPC_TABLE}
   WHERE pool_id = $1
   ORDER BY record_no DESC`;

/** '[PARTNER, OCR, 802]' -> ['PARTNER','OCR','802'] */
export function parseSopcLevelList(raw) {
  return String(raw ?? '')
    .replace(/[[\]]/g, '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

// ============ CIF -> ACCOUNT (product_account) ============
// The CIF key of a redemption is item_fulfilment_status.csn; the accounts of that CIF live in
// ols_schema.product_account keyed by csn (verified 29/09/2026):
//   product_account(csn, product_account_no, product_account_level, product_account_type, status,
//                   termination_date, registration_date, ...)
// The rule: the CIF must own the redeemed account, and that account must carry the product
// (PAL = product_account_level) and brand (PAT = product_account_type) of the transaction.
// On all 14 rows exported by the 29/09/2026 run the three checks below held 14/14, so the spec
// asserts the strongest one (csn + account no + PAL + PAT) and reports which part failed.
export const PRODUCT_ACCOUNT_TABLE = 'product_account';

// Pool balance of one CIF (used by the "not enough points" fallback).
export const BALANCE_VIEW = 'balance_detail_view';

export const BALANCE_QUERY = `
  SELECT pool_id,
         pool_name,
         balance::text          AS balance,
         redeemable_bal::text   AS redeemable_bal,
         next_expiry_bal::text  AS next_expiry_bal,
         next_expiry_date,      -- text in this view, not a timestamp
         status
    FROM ${SCHEMA}.${BALANCE_VIEW}
   WHERE csn = $1 AND pool_id = $2 AND status = 'A'`;

/**
 * Accounts of a CIF that may receive the adjustment: their product account level must be one of
 * the levels configured for that pool in statement_output_pool (BA rule: the adjustment is for the
 * account of the pool, and the pool must be part of the statement output configuration).
 */
export const TOPUP_ACCOUNT_QUERY = `
  SELECT product_account_no, product_account_type, product_account_level, product_code, status
    FROM ${SCHEMA}.${PRODUCT_ACCOUNT_TABLE}
   WHERE csn = $1
     AND status = 'A'
     AND product_account_level = ANY($2::text[])
   ORDER BY product_account_no`;

// Stock / quantity limits of an item (used to check the quantity before calling OL59).
export const ITEM_STOCK_QUERY = `
  SELECT item_code,
         item_type,
         status,
         qty_on_hand::text                     AS qty_on_hand,
         qty_reserved::text                    AS qty_reserved,
         qty_redeem::text                      AS qty_redeem,
         track_stock_quantity,
         max_qty_allow_per_item_per_txn::text  AS max_qty_allow_per_item_per_txn,
         item_warning_qty::text                AS item_warning_qty
    FROM ${SCHEMA}.item
   WHERE item_code = $1 AND status = 'A'`;

// Quantity rules of the redemption service (probed on dev 29/09/2026, channel MB / region ID):
//   price = item_price.price_in_point * quantity  -> wrong total: E5918 "Incorrect full price in
//   points"; pool units vs cash mismatch: E5903.
//   quantity 1, 2, 3, 5, 10, 20, 50 -> E5908 "Item Quantity is below minimum required"
//   quantity 100                    -> success (reference created)
// so the minimum is 100 for this item/price, it is NOT stored in item / item_price / app_param /
// cat_catalogue_trans_price but enforced by the service. Keep the data file quantity >= the minimum; when the API answers E5908
// the generator retries with the next candidate of OLSDB028_MIN_QTY_CANDIDATES and reports the
// minimum it discovered. Stock of the item is NOT enforced (quantity 100 was accepted while
// qty_on_hand was 48), so a stock shortage is only logged as a warning.
export const ITEM_MIN_QTY_ERROR = 'E5908';

export const MIN_QTY_CANDIDATES = (process.env.OLSDB028_MIN_QTY_CANDIDATES || '100,150,200,500')
  .split(',').map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value > 0);

// NOTE (open, not implemented yet): for e-voucher (item_type 'EV') the quantity should also fit in
// item.qty_on_hand. Probed on dev 29/09/2026 and NOT yet enforceable: UG7814 is the only usable EV
// item and it has 48 units on hand while the API rejects any quantity below 100, so both rules
// cannot be satisfied at the same time. No EV item with qty_on_hand >= 100 has a valid price.

export const PRODUCT_ACCOUNT_QUERY = `
  SELECT COUNT(*) FILTER (WHERE status = 'A')::text                          AS active_rows,
         COUNT(*) FILTER (WHERE status = 'A' AND product_account_no = $2)::text AS same_account,
         COUNT(*) FILTER (WHERE status = 'A' AND product_account_no = $2
                            AND product_account_level = $3
                            AND product_account_type  = $4)::text               AS same_account_pal_pat,
         COUNT(*) FILTER (WHERE status = 'A' AND product_account_level = $3)::text AS same_pal,
         string_agg(DISTINCT product_account_level || '/' || product_account_type || '/' ||
                    product_account_no || '(' || status || ')', ', ')
           FILTER (WHERE status = 'A')                                          AS active_accounts
    FROM ${SCHEMA}.${PRODUCT_ACCOUNT_TABLE}
   WHERE csn = $1`;
