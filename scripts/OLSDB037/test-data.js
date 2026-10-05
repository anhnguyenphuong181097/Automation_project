// scripts/OLSDB037/test-data.js
// Test data + configuration for batch OLSDB037 (Generate Cash Rebate output file -> GRSAVGPF).
//
// OLSDB037 is an EXPORT batch driven by the ledger table OUTPUT_CASH_REBATE (OCR): it has no input
// .dat file. The cash rebate rows are created upstream by OLSDB040 (REP Batch Process) or
// OLSDB043 (Extract Cash rebate). This automation prepares its input through OLSDB040 only.
//
//   (pool movements / campaign conditions)
//        -> ./OLSDB040  (REP Batch Process)
//        -> ols_schema.output_cash_rebate (+ redemption_fulfilment_status)
//        -> ./OLSDB037  (Generate Cash Rebate output file)
//        -> /apps/MY-dev/OE/cls/USER_OUTPUT/OLSDB037/GRSAVGPF   (fixed length, no extension)
//
// Sources of truth used for this implementation (read-only inspection, nothing invented):
//   * Detail record layout : F:\OCBC\GRSAVGPF.docx (RECORD DEFINITION(2) - Detail Record)
//   * Header / trailer     : F:\OCBC\OLS Batch Interface (Output from OLS) Specifications v1.16.docx
//                            section 2.3 "GRSAVGPF / GRSAVOyyyymmdd - Cash Rebate Crediting File"
//   * Batch order / output : F:\OCBC\OCBC EOD Batch flow v1.10 (SG).xlsx
//                            - step 29 OLSDB040 "REP Batch Process", script /apps/RLMS/scripts/OLSDB040
//                            - step 30 OLSDB043 "Extract Cash rebate"
//                            - step 31 OLSDB037 "Generate Cash Rebate output file", OUT file GRSAVGPF,
//                              output folder .../OE/cls/USER_OUTPUT/OLSDB037
//   * REP rule semantics   : F:\OCBC\OLS Product FSD 1.15.docx s.7.9 (REP = "Redeem, Extract &
//                            Process": extracts the pool balance, "-ve Bal. Adjust. Transaction Code",
//                            "Output Redemption As" = "Cash Rebate to Card System" -> File ID GRSAVGPF)
//   * OCR columns          : F:\OCBC\CRRR OLS Report Specs 3.9 (sent).docx -> OLSD523R / OLSD308R
//                            (OCR.REFERENCE_NO, OCR.TRANSACTION_DATE, OCR.PRODUCT_ACCOUNT_NO,
//                             OCR.ITEM_TYPE, OCR.CRB_AMOUNT, OCR.FULFILLMENT_STATUS,
//                             OCR.FULFILL_STATUS_UPDATE_DATE, OCR.BATCH_DATE)
//
// CONFIG lives here (not in the spec) so that the spec and the data-preparation step share one
// definition - same approach as OLSDB028 / OLSD133R / OLSD134R / OLSD141R.
// Credentials come from .env; nothing from .env is printed or written back. DO NOT import
// config/test-config.js (AGENTS.md 6.1).

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
const num = (key, fallback) => {
  const raw = process.env[key];
  const value = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(value) ? value : fallback;
};

// ============ CONFIGURATION ============
export const CONFIG = {
  winscp: {
    path: process.env.WINSCP_PATH || ENV.WINSCP_PATH || 'C:\\Program Files (x86)\\WinSCP\\WinSCP.com',
    // Dev-my host, the same one OLSDB009 / OLSDB020 / OLSDB028 / OLSD134R use.
    host: '192.168.99.83',
    port: '22',
    username: cred('SFTP_USERNAME', 'root'),
    password: cred('SFTP_PASSWORD', ''),
    localPath: cred('LOCAL_PATH', 'C:\\BATCH-OCBC-PW1\\src\\'),
    // WinSCP needs the same treatment as plink (AGENTS.md 4.4): without an expected host key it
    // stops at "Continue connecting to an unknown server and add its host key to a cache?" and,
    // with no stdin, hangs until the caller kills it. The value is the fingerprint WinSCP itself
    // prints ("ssh-ed25519 255 <base64>"); override it with WINSCP_HOSTKEY in .env.
    hostKey: cred('WINSCP_HOSTKEY', 'ssh-ed25519 255 kGbLBMkLSnBoYmLg10qgHfmQmtUbawS69GYysVLkXu4'),
  },

  putty: {
    path: process.env.PUTTY_PATH || ENV.PUTTY_PATH || 'C:\\Program Files\\PuTTY\\plink.exe',
    host: '192.168.99.83',
    username: cred('SSH_USERNAME', 'root'),
    password: cred('SSH_PASSWORD', ''),
    // -batch and -hostkey are mandatory, otherwise plink hangs at the host key prompt
    // (AGENTS.md 4.4): there is no stdin to answer it.
    hostKey: cred('SSH_HOST_KEY', 'SHA256:kGbLBMkLSnBoYmLg10qgHfmQmtUbawS69GYysVLkXu4'),
  },

  batch: {
    scriptPath: '/apps/MY-dev/scripts',
    command: './OLSDB037',
    batchId: 'OLSDB037',
    // Job name read from /apps/MY-dev/OE/onebatch/bin/OLSDB037.sh (dev, verified):
    //   JOB_NAME=cashRebateExportJob   BATCH_ID=OLSDB037
    jobName: process.env.OLSDB037_JOB_NAME || 'cashRebateExportJob',
    // Java batch: allow JVM startup time (AGENTS.md 4.5).
    timeout: 600000,
  },

  // Upstream batch that creates the OUTPUT_CASH_REBATE rows used as input of OLSDB037.
  prepare: {
    batchId: 'OLSDB040',
    // /apps/MY-dev/OE/onebatch/bin/OLSDB040.sh: JOB_NAME=repBatchJob (dev, verified).
    jobName: process.env.OLSDB040_JOB_NAME || 'repBatchJob',
    command: './OLSDB040',
    timeout: 600000,
    // Pool movements are posted through the OLSTXN interface, which is processed by OLSDB009 -
    // the batch that owns that file format in this project (reuse, do not clone).
    poolBatchId: 'OLSDB009',
    poolCommand: './OLSDB009',
    poolScriptPath: '/apps/MY-dev/scripts',
    poolRemotePath: process.env.OLSDB037_POOL_REMOTE_PATH ||
      '/apps/MY-dev/OE/cls/USER_INPUT/OLSDB009/',
    poolTimeout: 600000,
    // Folder the generated OLSTXN file is written to before the upload (project convention
    // scripts\test-data\generated\<BATCH>\prepare). OLSDB037_PREPARE_DIR redirects it, which is what
    // allows the suite to run against a project checkout that is not writeable.
    localDir: process.env.OLSDB037_PREPARE_DIR ||
      path.join(PROJECT_ROOT, 'scripts', 'test-data', 'generated', 'OLSDB037', 'prepare'),
    // REP rule of this batch, provided by the BA for the OLSDB037 automation:
    //   scheme_id 'PACR' ("REP pool PACR") -> pool_id 'L3ZE' (pool_name 'PACR'),
    //   campaign DTTT, rule_type REP, output_redemption_as O2CS, run_schedule D (daily),
    //   red_txn_code '8A', effective 2026-10-02 .. 2029-10-31, status 'A'.
    // It is only a preference: when it cannot be used, the generator falls back to discovery and
    // says why. OLSDB037_RULE_ID (env) always wins.
    defaultRuleId: process.env.OLSDB037_RULE_ID || 'PACR',
  },

  output: {
    remoteDir: process.env.OLSDB037_OUTPUT_DIR ||
      '/apps/MY-dev/OE/cls/USER_OUTPUT/OLSDB037',
    // "Request file name: GRSAVGPF (no extension)" - no date and no sequence in the name, so the
    // file of one run can only be told apart by its mtime/size (see waitForFreshOutput).
    fileName: process.env.OLSDB037_FILE_NAME || 'GRSAVGPF',
    extension: '',
    // Folder the spec downloads the file into and writes dashboard.html to. Defaults to the project
    // convention reports\OLSDB037; OLSDB037_REPORT_DIR redirects it (used when the suite is driven
    // from a checkout that is not writeable, e.g. a read-only project folder).
    localDir: process.env.OLSDB037_REPORT_DIR || path.join(PROJECT_ROOT, 'reports', 'OLSDB037'),
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

// ============ BATCH IDENTITY ============
export const BATCH_ID = 'OLSDB037';
export const PREPARE_BATCH_ID = 'OLSDB040';
export const OUTPUT_ID = 'GRSAVGPF';
export const OCR_TABLE = 'output_cash_rebate';
export const RFS_TABLE = 'redemption_fulfilment_status';

// /apps/MY-dev/OE/onebatch/config/properties/OLSDB037.properties (dev, verified):
//   batch.OLSDB037.productCode=RM
//   batch.OLSDB037.gatherStats.tables=OUTPUT_CASH_REBATE,REDEMPTION_FULFILMENT_STATUS
export const CONFIGURED_PRODUCT_CODE = process.env.OLSDB037_CURRENCY_CODE || 'RM';

// ============ OLSDB037 SELECTION RULE ============
// OLSDB037 is NOT a cut-off batch: it must never read oe_cutofftime_control, must never use a
// "first run of the day" flag and must never update the cut-off ledger. The selection rule is:
//
//     FULFILLMENT_STATUS = '01'
//     OR
//     ( BATCH_DATE = current batch date AND FULFILLMENT_STATUS = 'S' )
//
// '01' = new / not yet processed  -> extracted
// 'S' + current batch date        -> extracted again (this is the behaviour the rerun asserts)
// 'S' + another batch date        -> NOT extracted
export const STATUS_NEW = '01';        // $1
export const STATUS_PROCESSED = 'S';   // $3
export const PROCESSED_BY = 'OLSDB037';

/** Status values of a cash rebate row, as used by OLSD523R (fulfillment status of OCR). */
export const OCR_STATUS = {
  NEW: '01',
  SENT: 'S',
  REJECTED: 'R',
};

// ============ EXPECTED DATA (DB IS THE SOURCE OF TRUTH) ============
// The BA query for OLSDB037, verbatim except for two things:
//   * the three ? placeholders became $1 / $2 / $3 (parameter binding, never concatenation);
//   * ocr.batch_date::date = $2::date, because batch_date is a timestamp column in dev and a plain
//     'BATCH_DATE = <text>' would then only match a midnight timestamp. The business condition is
//     unchanged (same day).
//
// Parameters: $1 = '01' (STATUS_NEW), $2 = current batch date (YYYY-MM-DD), $3 = 'S'
//             (STATUS_PROCESSED).
//
// One result row = one GRSAVGPF Detail record, already transformed into the file format:
//   recordNo / cardNo (LPAD 19) / productAccountNo (LPAD 19) / transactionDate (1YYMMDD) /
//   productAccountType (LEFT 6) / redeemedPoint (* 100, bigint, LPAD 15) / transactionDate2
//   (YYYYMMDDHH24MISS) / referenceNo / productAccountType2.
export const EXPECTED_QUERY = `
select
    ocr.record_no as recordNo,
    ocr.txn_code as txnCode,
    LPAD(ocr.card_no, 19, '0') as cardNo,
    LPAD(ocr.product_account_no, 19, '0') as productAccountNo,
    TO_CHAR(ocr.transaction_date, '"1"YYMMDD') as transactionDate,
    LEFT(product_account_type, 6) AS productAccountType,
    LPAD(CAST((redeemed_point * 100)::bigint AS TEXT), 15, '0') as redeemedPoint,
    ocr.product_code as productCode,
    TO_CHAR(ocr.transaction_date, 'YYYYMMDDHH24MISS') as transactionDate2,
    ocr.reference_no as referenceNo,
    ocr.product_account_type as productAccountType2
from output_cash_rebate ocr
where ocr.status = 'A'
  and (
        ocr.fulfillment_status = $1
        or (
            ocr.batch_date::date = $2::date
            and ocr.fulfillment_status = $3
        )
      )
`;

/** Parameters of EXPECTED_QUERY, in binding order. */
export function expectedQueryParams(batchDateYmd) {
  return [STATUS_NEW, batchDateYmd, STATUS_PROCESSED];
}

/**
 * Same rule, but scoped to the records created by THIS test execution (traceability, requirement
 * 15). The business rule is untouched - the extra predicate only narrows the result to the accounts
 * prepared by this run and to the rows that appeared after the OLSDB040 run started
 * (record_no > high water mark). Used to decide which rows must be verified field by field; the
 * whole-environment query above is still used to prove the file has no unexpected rows.
 */
export const TEST_RECORDS_QUERY = `
select ocr.record_no as recordNo,
       ocr.txn_code as txnCode,
       LPAD(ocr.card_no, 19, '0') as cardNo,
       LPAD(ocr.product_account_no, 19, '0') as productAccountNo,
       TO_CHAR(ocr.transaction_date, '"1"YYMMDD') as transactionDate,
       LEFT(ocr.product_account_type, 6) AS productAccountType,
       LPAD(CAST((ocr.redeemed_point * 100)::bigint AS TEXT), 15, '0') as redeemedPoint,
       ocr.product_code as productCode,
       TO_CHAR(ocr.transaction_date, 'YYYYMMDDHH24MISS') as transactionDate2,
       ocr.reference_no as referenceNo,
       ocr.product_account_type as productAccountType2,
       ocr.fulfillment_status as fulfillmentStatus
  from output_cash_rebate ocr
 where ocr.status = 'A'
   and ocr.record_no > $1
   and ocr.product_account_no = ANY($2::text[])
 order by ocr.record_no
`;

/** High water mark of the ledger before OLSDB040 runs (nothing of ours can be below it). */
export const OCR_HIGH_WATER_QUERY = `
  SELECT COALESCE(MAX(record_no::bigint), 0)::text AS max_record_no
    FROM ${SCHEMA}.${OCR_TABLE}`;

/** OCR row of one record - the after-run status check (TC03). */
export const OCR_BY_RECORD_QUERY = `
  SELECT record_no::text            AS record_no,
         reference_no,
         product_account_no,
         product_account_type,
         card_no,
         txn_code,
         redeemed_point::text       AS redeemed_point,
         product_code,
         fulfillment_status,
         last_update_by,
         last_approve_by,
         to_char(batch_date, 'YYYY-MM-DD') AS batch_date,
         status
    FROM ${SCHEMA}.${OCR_TABLE}
   WHERE record_no = $1`;

/**
 * The rows that MUST NOT be extracted (requirement 12): 'S' from another batch date.
 * Mapped exactly like EXPECTED_QUERY so that a row found in the file can be recognised without the
 * record_no (which the output file does not carry).
 */
export const OCR_NOT_EXTRACTABLE_MAPPED_QUERY = `
select ocr.record_no as recordNo,
       ocr.txn_code as txnCode,
       LPAD(ocr.card_no, 19, '0') as cardNo,
       LPAD(ocr.product_account_no, 19, '0') as productAccountNo,
       TO_CHAR(ocr.transaction_date, '"1"YYMMDD') as transactionDate,
       LEFT(ocr.product_account_type, 6) AS productAccountType,
       LPAD(CAST((ocr.redeemed_point * 100)::bigint AS TEXT), 15, '0') as redeemedPoint,
       ocr.product_code as productCode,
       TO_CHAR(ocr.transaction_date, 'YYYYMMDDHH24MISS') as transactionDate2,
       ocr.reference_no as referenceNo,
       ocr.product_account_type as productAccountType2,
       ocr.fulfillment_status as fulfillmentStatus,
       to_char(ocr.batch_date, 'YYYY-MM-DD') as batchDate
  from output_cash_rebate ocr
 where ocr.status = 'A'
   and ocr.fulfillment_status = $1
   and ocr.batch_date::date <> $2::date
 order by ocr.record_no desc
 limit $3`;

/**
 * Product account of the accounts used by this run: product_code is the value the currency code
 * field (A1CCDE) is checked against, product_account_type is the product id (A1RKID / ProdID10Len).
 * Reported so that the "product code -> currency code" mapping question is answered by evidence.
 */
export const PRODUCT_ACCOUNT_CODE_QUERY = `
  SELECT product_account_no, product_account_type, product_code, status
    FROM ${SCHEMA}.product_account
   WHERE product_account_no = ANY($1::text[])
   ORDER BY product_account_no`;

/**
 * Corresponding fulfilment rows of the cash rebate references of one run (may not exist -
 * requirement 3). The column is spelled `fulfilment_status` in redemption_fulfilment_status
 * (verified against the dev database: redemption_fulfilment_status.fulfilment_status), while
 * output_cash_rebate spells it `fulfillment_status`.
 */
export const RFS_BY_REFERENCES_QUERY = `
  SELECT record_no::text AS record_no,
         txn_reference_no,
         txn_code,
         txn_type,
         redemption_out_type,
         txn_amt::text   AS txn_amt,
         fulfilment_status,          -- spelling of this table (output_cash_rebate uses fulfillment_status)
         last_update_by,
         last_approve_by,
         batch_id,
         status
    FROM ${SCHEMA}.${RFS_TABLE}
   WHERE txn_reference_no = ANY($1::text[])
   ORDER BY record_no DESC`;

/**
 * The rows that are still '01' when the run starts: the new, unprocessed cash rebate records.
 * They MUST end up in the output file and become 'S' - this is the traceability source that works
 * even when the preparation is skipped (OLSDB037_SKIP_PREPARE=1).
 */
/**
 * The TRANSACTIONS row behind one cash rebate / fulfilment reference - step 4 ("Check data
 * Transactions table") and step 5 of the BA test case:
 *
 *   Case Pool balance < 0 : OCR.redeemed_point = txns.point_adjusted   (positive adjustment that
 *                                                                      zeroes the negative balance)
 *   Case Pool balance > 0 : OCR.redeemed_point = txns.point_redeem     (column `point_redeemed` on dev)
 *   both cases            : OCR.txn_code = txns.transaction_code, OCR.fulfilment_status = '01'
 *
 * Verified on dev: OCR 170601 (txn_code 8A, RED, redeemed_point 200.00) -> transactions ref 58374461,
 * transaction_code 8A, transaction_type RED, point_redeemed 200.000; a negative balance adjustment is
 * stored with txn_sign '-' and point_adjusted -100.000 (transactions ref 58373459, code OLSTC).
 */
export const TRANSACTION_BY_REFERENCE_QUERY = `
  SELECT record_no::text      AS record_no,
         reference_no,
         pool_id,
         loyalty_account_no,
         account_serial_no,
         transaction_code,
         transaction_type,
         txn_sign,
         point_adjusted::text AS point_adjusted,
         point_redeemed::text AS point_redeemed,
         point_earned::text   AS point_earned,
         status,
         last_update_by
    FROM ${SCHEMA}.transactions
   WHERE reference_no = $1
   ORDER BY record_no DESC`;

/** Balance bucket of one loyalty account in one pool (step 3 - "Check loyalty_account_balance"). */
export const LAB_BY_ACCOUNT_POOL_QUERY = `
  SELECT record_no::text AS record_no,
         loyalty_account_no,
         pool_id,
         balance::text   AS balance,
         status,
         last_update_by,
         to_char(last_update_date, 'YYYY-MM-DD HH24:MI:SS') AS last_update_date
    FROM ${SCHEMA}.loyalty_account_balance
   WHERE loyalty_account_no = $1 AND pool_id = $2 AND status = 'A'
   ORDER BY record_no DESC`;

export const NEW_OCR_ROWS_QUERY = `
select ocr.record_no as recordNo,
       ocr.txn_code as txnCode,
       LPAD(ocr.card_no, 19, '0') as cardNo,
       LPAD(ocr.product_account_no, 19, '0') as productAccountNo,
       TO_CHAR(ocr.transaction_date, '"1"YYMMDD') as transactionDate,
       LEFT(ocr.product_account_type, 6) AS productAccountType,
       LPAD(CAST((ocr.redeemed_point * 100)::bigint AS TEXT), 15, '0') as redeemedPoint,
       ocr.product_code as productCode,
       TO_CHAR(ocr.transaction_date, 'YYYYMMDDHH24MISS') as transactionDate2,
       ocr.reference_no as referenceNo,
       ocr.product_account_type as productAccountType2,
       ocr.fulfillment_status as fulfillmentStatus,
       ocr.pool_id as poolId,
       ocr.rule_id as ruleId,
       to_char(ocr.batch_date, 'YYYY-MM-DD') as batchDate
  from output_cash_rebate ocr
 where ocr.status = 'A'
   and ocr.fulfillment_status = $1
 order by ocr.record_no`;

/** Rows of the ledger for one batch date (used to report what the batch saw). */
export const OCR_BY_BATCH_DATE_QUERY = `
  SELECT fulfillment_status, COUNT(*)::text AS row_count
    FROM ${SCHEMA}.${OCR_TABLE}
   WHERE status = 'A' AND batch_date::date = $1::date
   GROUP BY fulfillment_status
   ORDER BY fulfillment_status`;

/** batch_date used by the batches for the header fields (TC01). */
export const BATCH_DATE_QUERY = `
  SELECT record_no::text AS record_no,
         to_char(batch_date, 'YYYY-MM-DD')      AS batch_date,
         to_char(processing_date, 'YYYY-MM-DD') AS processing_date
    FROM ${SCHEMA}.batch_date
   ORDER BY record_no DESC
   LIMIT 1`;

/** Column list of a table - reported so that the ::date cast is never a guess. */
export const COLUMN_TYPE_QUERY = `
  SELECT column_name, data_type
    FROM information_schema.columns
   WHERE table_schema = $1 AND table_name = $2
   ORDER BY ordinal_position`;

/**
 * Has the REP batch already been executed for one batch date?
 *
 * The REP batch processes every due REP rule once per batch date, so a rule produces a cash rebate
 * row only for a batch date it has not seen yet. Measured on dev 2026-10-05: with batch_date
 * 2026-10-05 (already processed at 11:14) OLSDB040 created nothing, while the same run with
 * batch_date 2026-10-06 created the row for the balance immediately.
 *
 * The batch date is stored in batch_job_execution_params as a UTC timestamp
 * ("2026-10-05T16:00:00Z" = 2026-10-06 00:00 Asia/Singapore), hence the conversion below.
 */
export const REP_BATCH_RUN_FOR_DATE_QUERY = `
  SELECT COUNT(*)::text AS runs
    FROM ${SCHEMA}.batch_job_instance ji
    JOIN ${SCHEMA}.batch_job_execution je
      ON je.job_instance_id = ji.job_instance_id
    JOIN ${SCHEMA}.batch_job_execution_params p
      ON p.job_execution_id = je.job_execution_id
   WHERE ji.job_name = $1
     AND p.parameter_name = 'batchDate'
     AND je.status = 'COMPLETED'
     AND ((p.parameter_value)::timestamptz AT TIME ZONE 'Asia/Singapore')::date = $2::date`;

// ============ DATA PREPARATION (REP RULE / POOL / BALANCE) ============
// OLSDB040 is the REP Batch (FSD 7.9): for every active REP rule that is due today it extracts the
// balance of the rule's pool, posts the redemption transaction and writes the cash rebate row.
// "Prepare input data" therefore means: make sure a REP rule with output GRSAVGPF is live for a
// cash rebate pool, and give two target accounts a pool balance that is negative (case 1) and
// positive (case 2).
export const SCHEME_TABLE = 'scheme';
export const BALANCE_VIEW = 'balance_detail_view';
export const POOL_TABLE = 'pool_definition';

/**
 * Output type of a REP rule that produces the cash rebate crediting file. Verified on dev:
 *   /apps/MY-dev/OE/onebatch/config/properties/OLSDB040.properties
 *     batch.rep.output.type.card.system=O2CS      <- GRSAVGPF (this batch)
 *     batch.rep.output.type.transfer.pool=O2PD    <- pool transfer, not this file
 * The 19 active O2CS REP rules on dev carry redemption_out_type 'O2CS' in the exported rows, which
 * is how the cash rebate rows of OLSD523R are separated from the pool transfers.
 */
export const CARD_SYSTEM_OUTPUT_TYPE = process.env.OLSDB037_OUTPUT_TYPE || 'O2CS';

/**
 * REP rules that the REP batch will evaluate ("Redeem, Extract & Process").
 * scheme.rule_type = 'REP' is the same key the BA uses in the OLSD523R queries
 * (F:\SQL\Script run batch.sql: INNER JOIN SCHEME S ON S.SCHEME_ID = R.RULE_ID AND S.RULE_TYPE='REP').
 * Only the rules that output to the card system (O2CS -> GRSAVGPF) are candidates; a daily rule is
 * preferred because the REP batch executes daily rules on every run.
 *
 * IMPORTANT: the REP batch evaluates the effective dates against the BATCH DATE, not the wall clock.
 * On dev 2026-10-02 the batch date was 2026-08-06; rule PACR (effective from 2026-10-02 15:23) was
 * therefore out of scope and OLSDB040 processed nothing for its pool. The comparison below follows
 * the batch.
 */
export const REP_RULE_QUERY = `
  SELECT s.scheme_id,
         s.rule_name,
         s.campaign_id,
         s.pool_id,
         s.run_schedule,
         s.output_redemption_as,
         s.red_txn_code,
         s.adj_txn_code,
         s.adj_txn_reason,
         s.min_pool_balance::text AS min_pool_balance,
         s.status,
         to_char((SELECT batch_date FROM ${SCHEMA}.batch_date), 'YYYY-MM-DD') AS current_batch_date,
         (s.scheme_start_date <= (SELECT batch_date FROM ${SCHEMA}.batch_date)
          AND s.scheme_end_date >= (SELECT batch_date FROM ${SCHEMA}.batch_date)) AS effective_on_batch_date,
         to_char(s.scheme_start_date, 'YYYY-MM-DD HH24:MI:SS') AS scheme_start_date,
         to_char(s.scheme_end_date,   'YYYY-MM-DD HH24:MI:SS') AS scheme_end_date
    FROM ${SCHEMA}.${SCHEME_TABLE} s
   WHERE s.status = 'A'
     AND s.rule_type = 'REP'
     AND s.output_redemption_as = $1
     AND s.scheme_start_date <= (SELECT batch_date FROM ${SCHEMA}.batch_date)
     AND s.scheme_end_date   >= (SELECT batch_date FROM ${SCHEMA}.batch_date)
   ORDER BY CASE WHEN s.run_schedule = 'D' THEN 0 ELSE 1 END, s.scheme_id`;

/** One rule, when OLSDB037_RULE_ID is pinned (or when the discovery query returns several). */
export const REP_RULE_BY_ID_QUERY = `
  SELECT s.scheme_id,
         s.rule_name,
         s.campaign_id,
         s.pool_id,
         s.run_schedule,
         s.output_redemption_as,
         s.red_txn_code,
         s.adj_txn_code,
         s.adj_txn_reason,
         s.min_pool_balance::text AS min_pool_balance,
         s.status,
         to_char((SELECT batch_date FROM ${SCHEMA}.batch_date), 'YYYY-MM-DD') AS current_batch_date,
         (s.scheme_start_date <= (SELECT batch_date FROM ${SCHEMA}.batch_date)
          AND s.scheme_end_date >= (SELECT batch_date FROM ${SCHEMA}.batch_date)) AS effective_on_batch_date,
         to_char(s.scheme_start_date, 'YYYY-MM-DD HH24:MI:SS') AS scheme_start_date,
         to_char(s.scheme_end_date,   'YYYY-MM-DD HH24:MI:SS') AS scheme_end_date
    FROM ${SCHEMA}.${SCHEME_TABLE} s
   WHERE s.scheme_id = $1
     AND s.status = 'A'
   ORDER BY s.scheme_id`;

/**
 * The active REP rule(s) that extract one specific pool (used when the pool of a case is pinned and
 * the run has to report which rule turns that pool balance into a cash rebate row).
 */
export const REP_RULE_BY_POOL_QUERY = `
  SELECT s.scheme_id,
         s.rule_name,
         s.pool_id,
         s.run_schedule,
         s.output_redemption_as,
         s.red_txn_code,
         s.adj_txn_code,
         s.adj_txn_reason,
         to_char(s.scheme_start_date, 'YYYY-MM-DD HH24:MI:SS') AS scheme_start_date,
         to_char(s.scheme_end_date,   'YYYY-MM-DD HH24:MI:SS') AS scheme_end_date,
         (s.scheme_start_date <= (SELECT batch_date FROM ${SCHEMA}.batch_date)
          AND s.scheme_end_date >= (SELECT batch_date FROM ${SCHEMA}.batch_date)) AS effective_on_batch_date
    FROM ${SCHEMA}.${SCHEME_TABLE} s
   WHERE s.pool_id = $1
     AND s.rule_type = 'REP'
     AND s.status = 'A'
     AND s.output_redemption_as = $2
   ORDER BY (s.scheme_start_date <= (SELECT batch_date FROM ${SCHEMA}.batch_date)) DESC, s.scheme_id`;

/**
 * Pool of a rule - the pool whose balance the REP batch extracts (and deducts).
 * Verified on dev: the pool master table is ols_schema.pool_definition (there is no `pool` table),
 * with pool_id / pool_name / pool_type / currency_code / status / allow_negative_balance /
 * threshold_balance / red_txn_code.
 */
export const POOL_QUERY = `
  SELECT p.pool_id,
         p.pool_name,
         p.pool_type,
         p.currency_code,
         p.number_of_decimal_places,
         p.allow_negative_balance,
         p.charge_negative_balance,
         p.threshold_balance,
         p.red_txn_code,
         p.award_txn_code,
         p.status
    FROM ${SCHEMA}.${POOL_TABLE} p
   WHERE p.pool_id = $1`;

/** Live balance of one CIF + pool. */
export const BALANCE_QUERY = `
  SELECT pool_id,
         pool_name,
         balance::text        AS balance,
         redeemable_bal::text AS redeemable_bal,
         status
    FROM ${SCHEMA}.${BALANCE_VIEW}
   WHERE csn = $1 AND pool_id = $2 AND status = 'A'`;

/**
 * Candidate accounts for the two cases.
 *
 * The shape is not free: an OLSTXN adjustment is only accepted for an account the OLS batch
 * recognises as a loyalty product account. Measured on dev 2026-10-02 (BE108 "This Product Account
 * does not exist"): a product account of type '801' / level 'CCC' was refused although it exists in
 * product_account, while every accepted adjustment of the dev environment uses
 * type 'RWD' / level 'OCR' (e.g. 980915164091 for csn 832341). The candidate list therefore requires
 *   * product_account.status = 'A' and type/level RWD/OCR,
 *   * an active row in loyalty_account_product for that account + type,
 *   * a card link (the output file carries A1KRTN / A1KNTN),
 * and prefers accounts that already have a balance row in the pool.
 */
export const PREPARE_ACCOUNT_QUERY = `
  SELECT pa.product_account_no,
         pa.product_account_type,
         pa.product_account_level,
         pa.csn,
         pa.account_serial_no,
         MIN(cpar.card_no)            AS card_no,
         MAX(bd.balance::text)        AS pool_balance,
         MAX(lap.loyalty_account_no)  AS loyalty_account_no,
         MAX(to_char(lab.last_update_date, 'YYYY-MM-DD HH24:MI:SS')) AS lab_last_update,
         MAX(c.customer_id)           AS customer_id
    FROM ${SCHEMA}.product_account pa
    JOIN ${SCHEMA}.loyalty_account_product lap
      ON lap.product_account_no = pa.product_account_no
     AND lap.product_account_type = pa.product_account_type
     AND lap.status = 'A'
    -- INNER JOIN: on dev the accounts without a card link are the synthetic ones that OLSDB009
    -- refuses with BE108 "This Product Account does not exist" (measured 2026-10-05), so the card
    -- link is the discriminator between a real product account and a test row.
    JOIN ${SCHEMA}.card_product_account_rel cpar
      ON cpar.product_account_no = pa.product_account_no
     AND cpar.product_account_type = pa.product_account_type
    LEFT JOIN ${SCHEMA}.card c
      ON c.card_no = cpar.card_no
    -- Balance bucket of that loyalty account in the pool of the rule, used to avoid an account that
    -- was already adjusted TODAY: OLSDB009 answers BE678 "The transaction has already been processed"
    -- when the same account + pool is posted twice on the same day (measured on dev 2026-10-05).
    LEFT JOIN ${SCHEMA}.loyalty_account_balance lab
      ON lab.loyalty_account_no = lap.loyalty_account_no
     AND lab.pool_id = $1
     AND lab.status = 'A'
    LEFT JOIN ${SCHEMA}.${BALANCE_VIEW} bd
      ON bd.csn = pa.csn
     AND bd.pool_id = $1
     AND bd.status = 'A'
   WHERE pa.status = 'A'
     AND pa.product_account_type = 'RWD'
     AND pa.product_account_level = 'OCR'
     AND pa.product_account_no IS NOT NULL
     AND pa.product_account_no <> ''
     -- OLSDB009 answers BE678 "The transaction has already been processed" when the same account +
     -- pool is adjusted twice for the same PROCESS DATE, and the process date of a file is the
     -- batch date of the run (measured on dev 2026-10-05: the same account was refused for batch
     -- date 2026-10-05 and accepted again for 2026-10-06/07). STEP 0 advances the batch date to a
     -- date the REP batch has not seen, so only the accounts already used for THAT date are skipped.
     AND NOT EXISTS (
           SELECT 1 FROM ${SCHEMA}.dwh_temp_txn d
            WHERE d.prod_acct_nbr = pa.product_account_no
              AND d.pool_id = $1
              AND d.txn_type = '03'
              AND d.process_date::date = (SELECT batch_date FROM ${SCHEMA}.batch_date))
   GROUP BY pa.product_account_no, pa.product_account_type, pa.product_account_level,
            pa.csn, pa.account_serial_no
   ORDER BY (MAX(lab.last_update_date)::date = CURRENT_DATE) NULLS FIRST,
            (MAX(bd.balance) IS NULL),
            pa.product_account_no
   LIMIT $2`;

/** Balance of one account (after the pool movement, before OLSDB040). */
export const BALANCE_BY_ACCOUNT_QUERY = `
  SELECT bd.csn,
         bd.pool_id,
         bd.balance::text        AS balance,
         bd.redeemable_bal::text AS redeemable_bal
    FROM ${SCHEMA}.${BALANCE_VIEW} bd
   WHERE bd.csn = $1 AND bd.pool_id = $2 AND bd.status = 'A'`;

/**
 * Pool for the NEGATIVE balance case (agreed with the BA): a cash rebate pool - pool_type 'CR' -
 * that accepts a negative balance, together with the REP rule that extracts it. The rule has to be
 * effective on the BATCH DATE, otherwise OLSDB040 never reads the pool and no cash rebate row is
 * produced for the case.
 *
 * Preference order:
 *   1. the rule carries the "-ve Bal. Adjust. Transaction Code" (scheme.adj_txn_code): without it the
 *      REP batch excludes accounts whose pool balance is negative (FSD 7.9) and only reports them;
 *   2. a daily rule (run_schedule 'D'), so the rule is really evaluated on the next run;
 *   3. the pool with the fewest balances - smallest blast radius on the shared dev database.
 *
 * The pool must accept a negative balance AND charge it to the card:
 *   allow_negative_balance = 'Y'   the balance may go below zero at all
 *   charge_negative_balance = 'Y'  "Charge Negative Balance to Card" - with a negative pool balance
 *                                  this is what makes the REP batch extract the account
 *                                  (confirmed by the BA; on dev only pool GSZ1 of rule 2REP has both
 *                                  flags plus an adj_txn_code - the shape of the historical
 *                                  OCR 3801 ADJ row)
 */
export const NEGATIVE_BALANCE_POOL_QUERY = `
  SELECT p.pool_id,
         p.pool_name,
         p.pool_type,
         p.currency_code,
         p.allow_negative_balance,
         p.charge_negative_balance,
         p.status,
         s.scheme_id,
         s.rule_name,
         s.run_schedule,
         s.adj_txn_code,
         s.adj_txn_reason,
         s.red_txn_code,
         (SELECT count(*) FROM ${SCHEMA}.${BALANCE_VIEW} b
          WHERE b.pool_id = p.pool_id AND b.status = 'A') AS balances
    FROM ${SCHEMA}.${POOL_TABLE} p
    JOIN ${SCHEMA}.${SCHEME_TABLE} s
      ON s.pool_id = p.pool_id
     AND s.rule_type = 'REP'
     AND s.status = 'A'
     AND s.output_redemption_as = $1
     AND s.scheme_start_date <= (SELECT batch_date FROM ${SCHEMA}.batch_date)
     AND s.scheme_end_date   >= (SELECT batch_date FROM ${SCHEMA}.batch_date)
   WHERE p.status = 'A'
     AND upper(p.pool_type) = 'CR'
     AND upper(coalesce(p.allow_negative_balance, 'N')) = 'Y'
     AND upper(coalesce(p.charge_negative_balance, 'N')) = 'Y'
   ORDER BY (NULLIF(s.adj_txn_code, '') IS NOT NULL) DESC,
            (s.run_schedule = 'D') DESC,
            balances ASC,
            p.pool_id
   LIMIT $2`;

// ============ GRSAVGPF FILE LAYOUT ============
// Fixed length file, one record = one line, no separator. The record type is the FIRST character
// ('H' header / 'D' detail / 'T' trailer); the field order below is the order of the BA document, so
// the parser slices the line by the cumulative lengths.
//
// Record sizes. The documents disagree, so this was measured on the real dev file
// /apps/MY-dev/OE/cls/ARCHIVE/OLSDB037/GRSAVGPF_20260921 (3002 bytes, 3 records, verified):
//   * header 1000, detail 1000, trailer 1000 -> the detail filler is 706 bytes
//     (294 mapped + 706 = 1000, which is also the "Max Detail record size = 1000" of v1.16).
//   * v1.16 output spec: header filler X(975) -> 1000, trailer filler X(950) -> 1000,
//                        detail filler X(704) -> 998 (2 bytes short of the real record).
//   * GRSAVGPF.docx    : detail filler X(25)  -> 319 (an older definition, not what dev writes).
// The parser accepts the documented variants, requires every record of one file to have the SAME
// length and reports which one it found. The default below is the measured 1000.
// The filler of every record is the REST of the line (the declared length is the minimum of its
// document), so a filler that is longer than declared is still checked instead of being ignored.
export const DETAIL_FILLER = { name: 'A1FIL2', label: 'FILLER', type: 'X', length: 25, restOfLine: true };
export const HEADER_FILLER = { name: 'A0FIL1', label: 'FILLER', type: 'X', length: 975, restOfLine: true };
export const TRAILER_FILLER = { name: 'A9FIL3', label: 'FILLER', type: 'X', length: 950, restOfLine: true };

export const HEADER_FIELDS = [
  { name: 'A0RTYP', label: 'RECORD TYPE', type: 'X', length: 1, expected: 'H' },
  { name: 'A0PDTE', label: 'PROC DATE', type: '9', length: 8, format: 'YYYYMMDD', source: 'batch_date' },
  { name: 'A0SDTE', label: 'SYSTEM DATE', type: '9', length: 8, format: 'YYYYMMDD', source: 'system_date' },
  { name: 'A0FLID', label: 'FILE ID', type: 'X', length: 8, expected: 'GRSAVGPF' },
  HEADER_FILLER,
];

// Detail record - Record Definition (2). `expected` = constant field of the specification,
// `source` = field of the expected query result the value comes from (see EXPECTED_QUERY).
export const DETAIL_FIELDS = [
  { name: 'A1RTYP', label: 'RECORD TYPE', type: 'X', length: 1, expected: 'D' },
  { name: 'A1BNTN', label: 'BATCH NUMBER', type: '9', length: 9, expected: '000000000' },
  { name: 'A1BLON', label: 'BATCH SEQUENCE NUMBER', type: '9', length: 7, expected: '0000000' },
  { name: 'A1PEK', label: 'SUB BATCH', type: '9', length: 7, expected: '0000000' },
  { name: 'A1TTYP', label: 'TRANSACTION CODE', type: '9', length: 3, source: 'txnCode', numeric: true,
    note: 'LEFT(OCR.TXN_CODE, 3) - "102A" is printed as "102", "F12" as "F12" (verified on dev)' },
  { name: 'A1KRTN', label: 'CARD NUMBER', type: '9', length: 19, source: 'cardNo', numeric: true,
    note: 'LPAD(OCR.CARD_NO, 19) - all zeroes when OCR.CARD_NO is null' },
  { name: 'A1KNTN', label: 'ACCOUNT NUMBER', type: '9', length: 19, source: 'productAccountNo', numeric: true },
  { name: 'A1TRDT', label: 'TRANSACTION DATE', type: '9', length: 7, source: 'transactionDate', format: '1YYMMDD' },
  { name: 'A1VLDT', label: 'VALUE DATE', type: '9', length: 7, expected: '0000000' },
  { name: 'A1BDAT', label: 'ENTRY DATE', type: '9', length: 7, expected: '0000000' },
  { name: 'A1PERI', label: 'PERIOD', type: '9', length: 5, expected: '00000' },
  { name: 'A1TRST', label: 'TRANSACTION STATUS', type: '9', length: 3, expected: '000' },
  { name: 'A1BUST', label: 'PAYMENT STATUS', type: '9', length: 3, expected: '000' },
  { name: 'A1KORR', label: 'RECTIFICATION MARK', type: 'X', length: 1, expected: ' ' },
  { name: 'A1FKDR', label: 'CHARGE ERROR CODE', type: 'X', length: 5, expected: '     ' },
  { name: 'A1BKID', label: 'MERCHANT ID', type: '9', length: 11, expected: '00000000000' },
  { name: 'A1MEAC', label: 'MERCHANT ACCOUNT NUMBER', type: '9', length: 5, expected: '00000' },
  { name: 'A1RKID', label: 'PRODUCT ID', type: 'X', length: 6, source: 'productAccountType',
    note: 'LEFT(OCR.PRODUCT_ACCOUNT_TYPE, 6)' },
  { name: 'A1BEL', label: 'TRANSACTION AMOUNT', type: '9', length: 15, source: 'redeemedPoint', numeric: true,
    note: 'redeemed_point * 100, bigint, LPAD to 15 (32 -> 000000000003200, 32.01 -> 000000000003201)' },
  { name: 'A1CCDE', label: 'CURRENCY CODE', type: 'X', length: 3, source: 'productCode',
    note: 'OLSDB037.properties batch.OLSDB037.productCode (RM), not OCR.PRODUCT_CODE - see A1CCDE_MODE' },
  { name: 'A1NOD', label: 'NUMBER OF DECIMALS', type: '9', length: 1, expected: '2' },
  { name: 'A1BELR', label: 'RETURN FEE AMOUNT', type: '9', length: 15, expected: '000000000000000' },
  { name: 'A1CCDR', label: 'RECONCILIATION CURRENCY', type: 'X', length: 3, expected: '   ' },
  { name: 'A1NODR', label: 'DECIMAL, RECONCILIATION CURRENCY', type: '9', length: 1, expected: '0' },
  { name: 'A1DSCC', label: 'DISCOUNT Y/N', type: 'X', length: 1, expected: ' ' },
  { name: 'A1UBNT', label: 'ORIGINAL BATCH NUMBER', type: '9', length: 9, expected: '000000000' },
  { name: 'A1UBLO', label: 'ORIGINAL BATCH SEQUENCE NUMBER', type: '9', length: 7, expected: '0000000' },
  { name: 'A1UTBN', label: 'PAYMENT BATCH NUMBER', type: '9', length: 9, expected: '000000000' },
  { name: 'A1UTBL', label: 'PAYMENT BATCH SEQUENCE NUMBER', type: '9', length: 7, expected: '0000000' },
  { name: 'A1RGKR', label: 'UPDATE CUSTOMER ACCOUNT', type: 'X', length: 1, expected: ' ' },
  { name: 'A1RGAR', label: 'UPDATE MERCHANT ACCOUNT', type: 'X', length: 1, expected: ' ' },
  { name: 'A1DTTM', label: 'DATE & TIME', type: '9', length: 14, source: 'transactionDate2', format: 'YYYYMMDDHHMMSS' },
  { name: 'A1TSRC', label: 'TRANSACTION SOURCE', type: 'X', length: 1, expected: ' ' },
  { name: 'A1SSID', label: 'SOURCE SYSTEM ID', type: 'X', length: 4, expected: '    ' },
  { name: 'A1GLRR', label: 'G/L RECON REFERENCE', type: '9', length: 13, expected: '0000000000000' },
  { name: 'A1BNID', label: 'BONUS PROGRAM', type: 'X', length: 6, expected: '      ' },
  // A1REFN conflict (requirement 8): the test case expects OCR.REFERENCE_NO, both specification
  // documents say "Space". The archived dev file (/apps/MY-dev/OE/cls/ARCHIVE/OLSDB037/
  // GRSAVGPF_20260921, verified) carries the reference number "50120449", which is the
  // OCR.REFERENCE_NO of its source row -> the TEST CASE is right and the documents are wrong.
  // The assertion follows whichever behaviour the dev build implements and reports the finding -
  // see A1REFN_MODE.
  { name: 'A1REFN', label: 'REFERENCE NUMBER', type: 'X', length: 15, conflicting: true,
    source: 'referenceNo', specExpected: ' '.repeat(15) },
  { name: 'A1PCOD', label: 'EXCEPTION TYPE', type: '9', length: 3, expected: '   ' },
  { name: 'A1PDSC', label: 'DESCRIPTION', type: 'X', length: 30, expected: ' '.repeat(30) },
  { name: 'ProdID10Len', label: 'Product ID in 10 char len', type: 'X', length: 10,
    source: 'productAccountType2' },
  DETAIL_FILLER,
];

export const TRAILER_FIELDS = [
  { name: 'A9RTYP', label: 'RECORD TYPE', type: 'X', length: 1, expected: 'T' },
  { name: 'A9TOT', label: 'TOTAL NUMBER OF RECORDS', type: '9', length: 9, numeric: true,
    note: 'record count excluding header and trailer' },
  { name: 'A9DERR', label: 'TOTAL EXCEPTION MESSAGE', type: 'X', length: 40, expected: ' '.repeat(40) },
  TRAILER_FILLER,
];

/** Sum of the mapped fields (before the trailing filler) of the detail record: 294 bytes. */
export const DETAIL_MAPPED_LENGTH = DETAIL_FIELDS
  .filter((f) => f.name !== DETAIL_FILLER.name)
  .reduce((sum, f) => sum + f.length, 0);

export const HEADER_LENGTH = HEADER_FIELDS.reduce((sum, f) => sum + f.length, 0);   // 1000
export const TRAILER_LENGTH = TRAILER_FIELDS.reduce((sum, f) => sum + f.length, 0); // 1000

/**
 * Documented detail record lengths: 1000 (fixed length record size of the file), 998 (v1.16 filler
 * X(704)) and 319 (GRSAVGPF.docx filler X(25)). 0 = auto-detect from the file on the first run.
 */
export const DETAIL_LENGTH = num('OLSDB037_DETAIL_LENGTH', 1000);
export const DETAIL_LENGTH_CANDIDATES = [1000, 998, 319];
export const FILLER_MIN_LENGTH = 25;

// ============ A1REFN ============
// 'auto'     : assert the behaviour the dev build actually implements and require every detail
//              record to follow it. Default; on dev the file carries the reference number (verified
//              against the archived file of 2026-09-21).
// 'space'    : assert the specification (A1REFN = spaces).
// 'reference': assert the test case (A1REFN = OCR.REFERENCE_NO, X(15)).
export const A1REFN_MODE = (process.env.OLSDB037_A1REFN || 'auto').toLowerCase();

// ============ A1CCDE (CURRENCY CODE) ============
// The detail document says "OCR.PRODUCT_CODE / output currency code based on the account's
// prodProdCode", but the dev job does NOT copy OCR.PRODUCT_CODE: the archived file of 2026-09-21
// was built from an OCR row with product_code 'MYR' and its record carries 'RM ' - which is exactly
// batch.OLSDB037.productCode=RM in OLSDB037.properties. Default: use the configured code.
// 'product_code' asserts OCR.PRODUCT_CODE instead; both values are reported on the dashboard.
export const A1CCDE_MODE = (process.env.OLSDB037_A1CCDE || 'config').toLowerCase();

// ============ TEST DESIGN: THE TWO PREPARED CASES ============
// Pool balance < 0 : the REP batch posts the "-ve Bal. Adjust." transaction, and the credit row
//                    takes its amount from the adjustment (transaction.POINT_ADJUSTED).
// Pool balance > 0 : the REP batch redeems the pool balance (transaction.POINT_REDEEM).
export const CASES = [
  {
    id: 'CASE1',
    poolBalance: 'negative',
    description: 'Pool balance < 0 -> OCR.REDEEMED_POINT = transaction.POINT_ADJUSTED',
    amountSource: 'POINT_ADJUSTED',
    adjustSign: '-',
    adjustAmount: process.env.OLSDB037_CASE1_AMOUNT || '00000000010000', // 100.00 pool units
    account: process.env.OLSDB037_CASE1_ACCOUNT || null,
    // Rule that creates the negative-balance row. The BA designated 2REP (pool GSZ1, cash rebate pool
    // that accepts a negative balance); OLSDB037_CASE1_RULE overrides it.
    rule: process.env.OLSDB037_CASE1_RULE || '2REP',
    // Pool of the negative case: discovered as a cash rebate pool that accepts a negative balance
    // (OLSDB037_CASE1_POOL pins one instead).
    pool: process.env.OLSDB037_CASE1_POOL || null,
  },
  {
    id: 'CASE2',
    poolBalance: 'positive',
    description: 'Pool balance > 0 -> OCR.REDEEMED_POINT = transaction.POINT_REDEEM',
    amountSource: 'POINT_REDEEM',
    adjustSign: '+',
    adjustAmount: process.env.OLSDB037_CASE2_AMOUNT || '00000000020000', // 200.00 pool units
    account: process.env.OLSDB037_CASE2_ACCOUNT || null,
    rule: process.env.OLSDB037_CASE2_RULE || null,
    // Default: the pool of the REP rule (PACR -> L3ZE); OLSDB037_CASE2_POOL overrides it.
    pool: process.env.OLSDB037_CASE2_POOL || null,
  },
];

// ============ REFERENCE DOCUMENTS ============
export const CHECK_SHEET = 'F:\\OCBC\\GRSAVGPF.docx';
export const OUTPUT_SPEC =
  'F:\\OCBC\\OLS Batch Interface (Output from OLS) Specifications v1.16.docx (section 2.3)';
export const EOD_FLOW = 'F:\\OCBC\\OCBC EOD Batch flow v1.10 (SG).xlsx (steps 29-31)';

// ============ VALUE HELPERS ============
/** Trim a DB value to '' when it is null/undefined. */
export function trimValue(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

/**
 * Read a column of a result row by the alias written in the SQL.
 *
 * PostgreSQL folds UNQUOTED aliases to lower case, so `ocr.record_no as recordNo` comes back as
 * `recordno`. Every query of this batch keeps the alias spelled the way the BA wrote it, and this
 * accessor accepts both spellings so the mapping stays readable and never silently reads undefined.
 */
export function col(row, name) {
  if (!row) return undefined;
  if (row[name] !== undefined) return row[name];
  return row[String(name).toLowerCase()];
}

/** Left pad (numeric fields are right aligned with leading zeroes). */
export function zpad(value, length) {
  const raw = String(value ?? '').trim();
  const negative = raw.startsWith('-');
  const body = raw.replace(/[^0-9]/g, '');
  const sign = negative ? '-' : '';
  return sign + body.padStart(length - sign.length, '0');
}

/**
 * A1TTYP (TRANSACTION CODE, 9(03)): the dev batch writes the LEFT-MOST 3 characters of
 * OCR.TXN_CODE, it does not zero-pad it - verified on the run of 2026-10-01, where txn_code '102A'
 * is printed as "102" and txn_code 'F12' as "F12" (the archived file of 2026-09-21 prints "673").
 * A shorter numeric code is still zero padded (the field is numeric); a shorter alphanumeric code
 * is left aligned. Neither short case exists on dev, and the comparison reports whatever it finds.
 */
export function txnCodeField(value, length) {
  const text = trimValue(value);
  if (text === '') return '0'.repeat(length);
  const cut = text.slice(0, length);
  if (cut.length === length) return cut;
  return /^[0-9]+$/.test(cut) ? cut.padStart(length, '0') : cut.padEnd(length, ' ');
}

/** Right pad with spaces (alphanumeric fixed length fields). */
export function spacePad(value, length) {
  return String(value ?? '').slice(0, length).padEnd(length, ' ');
}

/** Compare two values after trailing spaces of both sides are stripped. */
export function equalsPadded(actual, expected) {
  return String(actual ?? '').replace(/\s+$/, '') === String(expected ?? '').replace(/\s+$/, '');
}

export default {
  CONFIG,
  EXPECTED_QUERY,
  expectedQueryParams,
  HEADER_FIELDS,
  DETAIL_FIELDS,
  TRAILER_FIELDS,
  CASES,
};
