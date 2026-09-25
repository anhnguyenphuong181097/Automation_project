// scripts/OLSD134R/test-runner.spec.js
// Batch   : OLSDR134  ->  report OLSD134R "Batch Redemption Exception Report"
// Host    : 192.168.99.83 (MY-dev), DB ols_my / schema ols_schema
//
// This folder follows the same 4-file pattern as OLSDB024 / OLSD133R:
//   test-data.js        : CONFIG + report filters + fixed-width column positions
//   file-naming.js      : naming convention for report file MYOLSD134R<batchdate>.txt
//   file-generator.js   : prepares input data (OLSTXN -> OLSDB009 -> dwh_temp_txn)
//   test-runner.spec.js : this file - runs the report batch, downloads the report, compares with DB
// Manual data prep can be run with: node scripts/OLSD134R/file-generator.js
//
// One execution flow (real flow, no fake data):
//   STEP 1: PREPARE -> OLSTXN (txnTranType = '01', created by the OLSDB009 generator) -> upload -> ./OLSDB009
//   STEP 2: VERIFY  -> dwh_temp_txn contains record txn_type='01' AND error_code IS NOT NULL
//                    (Batch ID / Batch Date / error code are read from DB, not hard-coded)
//   STEP 3: RUN     -> ./OLSDR134 -> MYOLSD134R<batch date>.txt
//   STEP 4: LOAD    -> download report to reports\OLSD134R\ and parse it
//   STEP 5: VERIFY  -> query DB with the correct mapping -> compare fields -> log [FAIL]
//
// Optional environment flags:
//   OLSDR134R_SKIP_PREPARE=1  skip the seed step (use existing DB data)
//   OLSDR134R_SKIP_BATCH=1    skip re-running OLSDR134 and reuse the report file already on server

import { test, expect } from '@playwright/test';
import fs from 'fs-extra';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import pg from 'pg';
import {
  CONFIG, SCHEMA, SECTION, COLUMN_LAYOUT, FIELD_LABELS, ROW_FIELDS, TXN_TYPE_REDEMPTION,
} from './test-data.js';
import {
  reportFileName, reportFileGlob, reportLocalPathForName, parseReportFileName,
} from './file-naming.js';
import {
  prepareData, getBatchContext, fetchRejectedRedemptions, getCutoffTimes,
} from './file-generator.js';

const execAsync = promisify(exec);

// ============ REPORT/DASHBOARD (same as the project reporting format) ============
// Steps are recorded during execution (steps 1..8 from file-generator.js, 9..14b here),
// then exported to a single HTML file: reports\OLSD134R\dashboard.html
//
// STEP 1: seed OLSDB009 input data
// STEP 2: upload OLSTXN to SFTP and run OLSDB009
// STEP 3: verify DWH_TEMP_TXN rows and capture DB metadata
// STEP 4: run OLSDR134 and download the report
// STEP 5: parse and compare report output against DB
const STEP_LEGEND = [
  ['0', 'Update batch_date = current date (before OLSDB009)'],
  ['1', 'Copy OLSTXN file to local src folder'],
  ['2', 'Upload file to SFTP (WinSCP)'],
  ['3', 'Run OLSDB009 batch'],
  ['4', 'Wait for OLSDB009 to complete'],
  ['5', 'Wait for OLSDB009 output files'],
  ['6', 'Verify OLSDB009 output files (.out/.rej/.err)'],
  ['7', 'Check DWH_TEMP_TXN rows of this file & save Post_Date'],
  ['8a', 'Update oe_cutofftime_control (last_cutoff_time=BD-2, current_cutoff_time=BD-1)'],
  ['8', "Read cutoff times (module_id='OLSDR134')"],
  ['9', 'Verify Post_Date > last_cutoff_time and > current_cutoff_time'],
  ['10', 'Run OLSD134R batch'],
  ['11', 'Wait for OLSD134R report file'],
  ['12', 'Download report to local'],
  ['13', 'Verify report: parse + compare DB vs report'],
  ['14a', 'Check DWH_TEMP_TXN rows in the report date range'],
  ['14b', 'Check report rows (all records)'],
];

const steps = [];
const testCaseResults = [];
let compareSummary = null;
// Raw content of the MAIN (phase-1) report, kept for the dashboard "Report Layout" section
// (the phase-2 report of TC06 has the same file name and would overwrite the local file).
let rawReportText = '';
let seedFileNames = [];                      // file(s) OLSTXN uploaded by THIS run (used to scope asserts)
const seedInfo = { outputs: null, postDate: null, cutoffs: null, dtOutRows: 0, dtRejRows: 0 };
const runContext = { batchDateYmd: null };   // information for the dashboard header section

function addStep(no, name, ok, note = '', extra = {}) {
  const entry = { no: String(no), name, ok: Boolean(ok), note, ...extra };
  steps.push(entry);
  log(`[STEP ${no}] ${ok ? '✅' : '❌'} ${name}${note ? ' — ' + note : ''}`);
  return entry;
}

// ============ HELPER FUNCTIONS ============
function log(message, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`, Object.keys(data).length ? data : '');
}

// child_process errors return the full command that was executed, including -pw <password> /
// sftp://user:password@host. Do not let credentials leak into logs (AGENTS.md section 3.1).
function maskSecret(text) {
  let out = String(text ?? '');
  for (const secret of [CONFIG.putty.password, CONFIG.winscp.password]) {
    if (secret && secret.length >= 3) out = out.split(secret).join('****');
  }
  return out;
}

// ============ SAVE TEST RESULTS - same template as OLSDB024 / OLSD133R ============
const EXECUTION_TRACKER_PATH = path.join(process.cwd(), '.execution-tracker.json');

async function saveTestResults(testCase, verification, fileRange, duration = 0) {
  try {
    const masterPath = path.join(process.cwd(), 'batch-results.json');

    const results = {
      testCase,
      fileRange,
      date: new Date().toISOString(),
      duration,
      success: verification.success || false,
      results: {
        totalRecords: verification.totalRecords || 0,
        trueCount: verification.trueCount || 0,
        falseCount: verification.falseCount || 0,
        details: verification.details || [],
      },
    };

    let tracker;
    if (fs.existsSync(EXECUTION_TRACKER_PATH)) {
      tracker = JSON.parse(fs.readFileSync(EXECUTION_TRACKER_PATH, 'utf8'));
    } else {
      tracker = { executionId: Date.now().toString(), testCases: [] };
    }

    let existingResults = [];
    if (fs.existsSync(masterPath)) {
      existingResults = JSON.parse(fs.readFileSync(masterPath, 'utf8'));
      if (!Array.isArray(existingResults)) existingResults = [];
    }

    const index = existingResults.findIndex((r) => r.testCase === testCase);
    if (index >= 0) existingResults[index] = results;
    else existingResults.push(results);

    if (!tracker.testCases.includes(testCase)) tracker.testCases.push(testCase);
    existingResults.sort((a, b) => a.testCase.localeCompare(b.testCase));

    fs.writeFileSync(masterPath, JSON.stringify(existingResults, null, 2));
    fs.writeFileSync(EXECUTION_TRACKER_PATH, JSON.stringify(tracker, null, 2));

    return masterPath;
  } catch (err) {
    console.error(err);
    return null;
  }
}

// ============ SSH (plink) ============
// -batch -hostkey are required; this is not just for appearance (see AGENTS.md section 4.4)
function plinkCommand(remoteCommand) {
  return `"${CONFIG.putty.path}" ` +
    `-batch ` +
    `-hostkey "${CONFIG.putty.hostKey}" ` +
    `-ssh ${CONFIG.putty.username}@${CONFIG.putty.host} ` +
    `-pw ${CONFIG.putty.password} ` +
    `"${remoteCommand}"`;
}

async function executeCustomCommand(command, testCase) {
  const { stdout, stderr } = await execAsync(plinkCommand(command), {
    timeout: 60000,
    maxBuffer: 1024 * 1024 * 10,
  });
  return { stdout, stderr };
}

// Run the batch on the server. Throw immediately if the command cannot run so it is not
// confused with the case where the batch finishes but produces no output.
async function executeBatch(testCase) {
  const command = `cd ${CONFIG.batch.scriptPath} && ${CONFIG.batch.command}`;
  log(`[${testCase}] Executing batch: ${command}`);

  try {
    const { stdout, stderr } = await execAsync(plinkCommand(command), {
      timeout: CONFIG.batch.timeout,
      maxBuffer: 1024 * 1024 * 10,
    });
    log(`[${testCase}] ✅ Batch executed`);
    return { success: true, stdout, stderr };
  } catch (error) {
    throw new Error(`[${testCase}] Batch ${CONFIG.batch.command} could not run: ${maskSecret(error.message)}`);
  }
}

/**
 * List report files matching *<reportId><report date>*.txt in the output directory.
 * Returns { name, size, mtime, signature } — signature = name|mtime|size to identify
 * the file that was newly generated (independent of the MY/ID region naming variant).
 */
async function listRemoteReports(batchDateYmd, testCase = 'REPORT') {
  try {
    const { stdout } = await executeCustomCommand(
      `ls -l --time-style=+%s ${CONFIG.report.remoteDir}/${reportFileGlob(batchDateYmd)} 2>/dev/null || true`,
      testCase
    );

    return String(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s+/);
        // ls tra ve duong dan day du -> chi lay ten file de parse
        const fullPath = parts[parts.length - 1];
        const name = fullPath.split('/').pop();
        const mtime = Number(parts[parts.length - 2]) || 0;
        const size = Number(parts[parts.length - 3]) || 0;
        return { name, size, mtime, signature: `${name}|${mtime}|${size}` };
      })
      .filter((r) => parseReportFileName(r.name) !== null);
  } catch (error) {
    return [];
  }
}

async function listRemoteDir(dir, testCase) {
  try {
    const { stdout } = await executeCustomCommand(`ls -lt ${dir} | head -20`, testCase);
    return stdout.trim();
  } catch (error) {
    return '(cannot list folder)';
  }
}

// Detect a newly generated report by comparing fingerprints (name + mtime + size) before and
// after running the batch so the old file from a previous run does not get mistaken for the
// current run. Do not hard-code the file prefix.
async function waitForFreshReport(batchDateYmd, previousSignatures, testCase, timeout = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const reports = await listRemoteReports(batchDateYmd, testCase);
    const fresh = reports.find((r) => !previousSignatures.includes(r.signature));
    if (fresh) {
      log(`[${testCase}] ✅ New report: ${CONFIG.report.remoteDir}/${fresh.name} ` +
        `(${fresh.size} bytes, mtime ${fresh.mtime})`);
      return fresh;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(
    `[${testCase}] No new report matching ${reportFileGlob(batchDateYmd)} within ${timeout / 1000}s ` +
    `in ${CONFIG.report.remoteDir}\n` +
    `Folder content:\n${await listRemoteDir(CONFIG.report.remoteDir, testCase)}`
  );
}

// Download the report to the local machine (WinSCP get) while preserving the original
// byte content and CRLF layout of the file on the server.
async function downloadReport(fileName, testCase) {
  fs.ensureDirSync(CONFIG.report.localDir);

  const localFile = reportLocalPathForName(fileName);

  const command = `"${CONFIG.winscp.path}" /command ` +
    `"option batch abort" ` +
    `"option confirm off" ` +
    `"option transfer binary" ` +
    `"open sftp://${CONFIG.winscp.username}:${CONFIG.winscp.password}@${CONFIG.winscp.host}/" ` +
    `"cd ${CONFIG.report.remoteDir}" ` +
    `"get ""${fileName}"" ""${localFile}""" ` +
    `"exit"`;

  try {
    await execAsync(command, { timeout: 120000, maxBuffer: 1024 * 1024 * 10 });
  } catch (error) {
    throw new Error(`[${testCase}] Download report failed ${fileName}: ${maskSecret(error.message)}`);
  }
  log(`[${testCase}] ✅ Downloaded ${localFile}`);
  return localFile;
}

// ============ DATABASE HELPERS ============
async function getDbConnection() {
  const client = new pg.Client({
    host: CONFIG.database.host,
    port: CONFIG.database.port,
    user: CONFIG.database.username,
    password: CONFIG.database.password,
    database: CONFIG.database.database,
  });
  await client.connect();
  return client;
}

async function executeDbQuery(query, params = [], testCase = 'DB') {
  const client = await getDbConnection();
  try {
    const result = await client.query(query, params);
    return result.rows;
  } catch (error) {
    throw new Error(`[${testCase}] DB query failed: ${error.message}\nSQL: ${query.trim()}`);
  } finally {
    await client.end();
  }
}

/**
 * Query expected data - kept aligned with the OLSD134R requirement (section 7), with only one change:
 *   1. Batch ID is passed from DB (not hard-coded) - the query still uses `dtt.batch_id = $1`.
 * All other filters (txn_type = '01', error_code IS NOT NULL, process_date window,
 * join branch/establishment) remain unchanged.
 */
const EXPECTED_QUERY = `
select b.establishment_id
           as chain_id,
       e.establishment_name_english_1
           as chain_name,
       to_char(
           dtt.maintenance_date,
           'dd-mm-yyyy hh24:mi:ss'
       ) as transaction_datetime,
       dtt.batch_id
           as batch_id,
       dtt.prod_acct_nbr
           as product_acct_number,
       dtt.prod_acct_level ||
       prod_acct_type ||
       acct_curr_code
           as account_type,
       dtt.txn_sign
           as sign,
       case
           when dtt.txn_amt ~ '^[+-]?([0-9]*[.])?[0-9]+$'
               then to_char(
                   dtt.txn_amt::double precision / 100,
                   'FM999,999,999,990.00'
               )
           else dtt.txn_amt
       end as bill_fee,
       dtt.error_code ||
       case
           when coalesce(dtt.error_code, '') != ''
               then ' - '
       end ||
       dtt.error_message
           as exception_code_reason
from ${SCHEMA}.dwh_temp_txn dtt
inner join ${SCHEMA}.branch b
        on b.branch_id = dtt.branch_id
       and b.status = 'A'
left join ${SCHEMA}.establishment e
       on e.establishment_id = b.establishment_id
      and e.status = 'A'
where dtt.batch_id = $1::text
  and dtt.process_date::date > $2::date
  and dtt.process_date::date <= $3::date
  and dtt.txn_type = $4
  and dtt.error_code is not null
  -- report rule: do NOT show transactions with process_date <= last_cutoff_time
  and dtt.process_date > $5::timestamp
order by dtt.establishment_id,
         dtt.maintenance_date`;

async function fetchExpectedRows(batchIds, windowRange, lastCutoffTime, testCase) {
  // Query follows the actual business rule: dtt.batch_id = ? (single value). Batch ID is taken from DB
  // (not hard-coded); if multiple batch_id values exist in the window, warn to know which one is used.
  if (batchIds.length > 1) {
    log(`⚠️ [${testCase}] Co ${batchIds.length} batch_id trong window: ` +
      `${batchIds.join(', ')} - query expected chi dung batch_id dau tien`);
  }
  return executeDbQuery(
    EXPECTED_QUERY,
    [batchIds[0] || null, windowRange.fromDate, windowRange.toDate, TXN_TYPE_REDEMPTION, lastCutoffTime],
    testCase
  );
}

// Count redemption records in the data window (used to validate the report filter:
// records with error_code IS NULL must not appear, and the report only includes txn_type = '01').
async function countRedemptions(windowRange, { errorCodeNotNull = true } = {}, testCase = 'DB') {
  const sql = `SELECT COUNT(*)::int AS total
    FROM ${SCHEMA}.dwh_temp_txn dtt
    WHERE dtt.txn_type = $1
      AND dtt.error_code IS ${errorCodeNotNull ? 'NOT NULL' : 'NULL'}
      AND dtt.process_date::date >  $2::date
      AND dtt.process_date::date <= $3::date`;

  const rows = await executeDbQuery(
    sql,
    [TXN_TYPE_REDEMPTION, windowRange.fromDate, windowRange.toDate],
    testCase
  );
  return rows.length ? Number(rows[0].total) : 0;
}

async function fetchExcludedRows(windowRange, cutoffTime, testCase = 'TC04', fileNames = []) {
  const sql = `
    SELECT
      dtt.batch_id,
      dtt.prod_acct_nbr,
      to_char(dtt.maintenance_date, 'dd-mm-yyyy hh24:mi:ss') AS transaction_datetime,
      dtt.txn_type,
      dtt.error_code,
      dtt.process_date,
      CASE
        WHEN dtt.txn_type = '03' AND dtt.error_code IS NOT NULL
          THEN 'txn_type=03'
        WHEN dtt.txn_type = '01' AND dtt.error_code IS NULL
          THEN 'error_code IS NULL'
        WHEN dtt.txn_type = '01' AND dtt.error_code IS NOT NULL
             AND dtt.process_date <= $1::timestamp
          THEN 'process_date <= last_cutoff_time'
      END AS exclusion_reason
    FROM ${SCHEMA}.dwh_temp_txn dtt
    WHERE dtt.process_date::date > $2::date
      AND dtt.process_date::date <= $3::date
      AND (
        (dtt.txn_type = '03' AND dtt.error_code IS NOT NULL)
        OR (dtt.txn_type = '01' AND dtt.error_code IS NULL)
        OR (dtt.txn_type = '01' AND dtt.error_code IS NOT NULL
            AND dtt.process_date <= $1::timestamp)
      )
      -- scope to the seed file(s) of this run when provided (other testers may upload the same day)
      AND ($4::text[] IS NULL OR cardinality($4::text[]) = 0 OR dtt.file_name = ANY($4::text[]))
    ORDER BY exclusion_reason, dtt.batch_id, dtt.maintenance_date`;

  return executeDbQuery(sql, [cutoffTime, windowRange.fromDate, windowRange.toDate, fileNames], testCase);
}

// Ngay process_date moi nhat cua record txn_type='01' - dung cho thong bao loi khi report
// rong, de biet ngay nao con thieu so voi date range cua report.
// Tinh ::date ngay trong SQL: cung mot phep ep kieu nhu query expected va nhu report, tranh
// lech ngay do timezone cua may chay test (process_date la timestamp without time zone).
async function latestRedemptionProcessDate(testCase = 'DB') {
  const rows = await executeDbQuery(
    `SELECT MAX(dtt.process_date)::date AS max_pd FROM ${SCHEMA}.dwh_temp_txn dtt WHERE dtt.txn_type = $1`,
    [TXN_TYPE_REDEMPTION],
    testCase
  );
  const value = rows.length ? rows[0].max_pd : null;
  if (!value) return `(no txn_type=${TXN_TYPE_REDEMPTION} row)`;
  return formatDate(String(value).slice(0, 10)); // pg tra ve DATE dang yyyy-mm-dd
}

// The actual data window covered by the report = Report Date on the report:
//   - 2026 build prints 'Report Date: ddmmyyyy' -> yyyymmdd
//   - 2020 build prints 'BATCH DATE: yyyymmdd'
// If the report does not print a date, fall back to batch date in DB (ctx).
function windowFromReport(header, ctx) {
  const rawReportDate = header.reportDate;
  const rawBatchDate = header.batchDate;

  let toDate = null;
  let source = '';
  if (rawReportDate && /^\d{8}$/.test(rawReportDate)) {
    toDate = `${rawReportDate.slice(4)}${rawReportDate.slice(2, 4)}${rawReportDate.slice(0, 2)}`;
    source = `Report Date tren report (${rawReportDate})`;
  } else if (rawBatchDate && /^\d{8}$/.test(rawBatchDate)) {
    toDate = rawBatchDate;
    source = `Batch Date tren report (${rawBatchDate})`;
  }

  if (!toDate) {
    return { fromDate: ctx.fromDate, toDate: ctx.toDate, source: 'batch_date trong DB' };
  }

  // Chuan hoa ve ISO yyyy-mm-dd de dung truc tiep cho tham so ::date cua query expected
  const isoToDate = `${toDate.slice(0, 4)}-${toDate.slice(4, 6)}-${toDate.slice(6, 8)}`;
  const d = new Date(`${isoToDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return { fromDate: d.toISOString().slice(0, 10), toDate: isoToDate, source };
}

// ============ FIELD MAPPING (DB -> value on the report) ============
function toNumber(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (typeof value === 'number') return value;
  return Number(String(value).trim().replace(/[,\s]/g, ''));
}

// Compare numbers by stripping thousands separators and allowing a tolerance of 0.001
// (report prints '100.50' while DB returns 100.5, which should still match)
function sameNumber(a, b) {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return false;
  return Math.abs(na - nb) < 0.001;
}

// Bill Fee: report prints in FM999,999,999,990.00 format (for example 9,500.00 / 500.00)
function formatBillFee(value) {
  const n = toNumber(value);
  if (Number.isNaN(n)) return normalizeText(value);
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function sameNumberOrText(a, b) {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return Math.abs(na - nb) < 0.001;
  return normalizeText(a) === normalizeText(b);
}

const pad2 = (n) => String(n).padStart(2, '0');

// node-postgres returns Date for date/timestamp types; read them in local time so they
// round-trip correctly for timestamp values without timezone.
function formatDate(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    return `${pad2(value.getDate())}-${pad2(value.getMonth() + 1)}-${value.getFullYear()}`;
  }

  const s = String(value).trim();
  let m = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (m) return s.slice(0, 10);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return s;
}

function formatTime(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    return `${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}`;
  }

  const s = String(value).trim();
  const m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return `${pad2(m[1])}:${m[2]}:${m[3] || '00'}`;
  return '';
}

// maintenance_date may be a Date (timestamp type) or a string 'dd-mm-yyyy hh24:mi:ss'
// returned by to_char() - split once for both date and time.
function splitDateTime(value) {
  if (value === null || value === undefined || value === '') return { date: '', time: '' };
  if (value instanceof Date) return { date: formatDate(value), time: formatTime(value) };

  const s = String(value).trim();
  const m = s.match(/^(\d{2}-\d{2}-\d{4})(?:[ T](\d{2}:\d{2}:\d{2}))?/);
  if (m) return { date: m[1], time: m[2] || '' };

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?/);
  if (iso) return { date: `${iso[3]}-${iso[2]}-${iso[1]}`, time: iso[4] || '' };

  return { date: formatDate(s), time: formatTime(s) };
}

function normalizeText(value) {
  return String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
}

// Report sign mapping: OLSD133R confirmed that DB stores '1' = '+', '0' = '-' -> keep the same
// mapping (report prints '+/-').
function signFor(dbRow) {
  const raw = dbRow.sign ?? dbRow.txn_sign;
  const s = raw === null || raw === undefined ? '' : String(raw).trim();
  if (s === '1') return '+';
  if (s === '0') return '-';
  return s;
}

function errorText(code, message) {
  const c = code === null || code === undefined ? '' : String(code).trim();
  const msg = message === null || message === undefined ? '' : String(message).trim();
  if (!c) return msg;
  if (!msg) return c;
  return `${c} - ${msg}`;
}

function expectedRowFor(dbRow) {
  const when = splitDateTime(dbRow.transaction_datetime ?? dbRow.maintenance_date);

  return {
    chainId: normalizeText(dbRow.chain_id),
    chainName: normalizeText(dbRow.chain_name),
    txnDate: when.date,
    txnTime: when.time,
    batchId: normalizeText(dbRow.batch_id),
    prodAcctNbr: normalizeText(dbRow.product_acct_number ?? dbRow.prod_acct_nbr),
    accountType: normalizeText(dbRow.account_type),
    sign: signFor(dbRow),
    billFee: formatBillFee(dbRow.bill_fee ?? dbRow.txn_amt),
    error: normalizeText(dbRow.exception_code_reason) || errorText(dbRow.error_code, dbRow.error_message),
  };
}

// Group by Chain ID in the same order as the report output (query already orders by chain, maintenance_date)
function buildExpectedGroups(dbRows) {
  const groups = [];
  let current = null;

  for (const dbRow of dbRows) {
    const row = expectedRowFor(dbRow);

    if (!current || current.chainId !== row.chainId) {
      current = { chainId: row.chainId, chainName: row.chainName, rows: [] };
      groups.push(current);
    }
    current.rows.push(row);
  }
  return groups;
}

// ============ REPORT PARSER ============
const SEPARATOR_RE = /^=+\s*$/;
const END_OF_REPORT_RE = /END OF REPORT/;
const TITLE_RE = /BATCH\s+REDEMPTION\s+EXCEPTION\s+REPORT/i;
const REPORT_ID_RE = /Report ID:\s*(\S+)/i;
const RUN_DATE_RE = /Report Run Date:\s*(\d{8})/i;
const REPORT_DATE_RE = /Report Date:\s*(\d{8})/i;
const BATCH_DATE_RE = /Batch Date:\s*(\d{8})/i;
const PROC_DATE_RE = /PROC DATE\s*:\s*([\d/]+)/i;
const PAGE_RE = /PAGE:\s*(\d+)/i;
const COLUMN_HEADER_RE = /Exception Code\s*&\s*(Reason|Message)/i;
// Headers repeat when the report advances to a new page - ignore them and do not treat them as data rows
const PAGE_HEADER_RE = /OCBC CARD CENTRE|Report ID:|Report Run Date:|Report Date:|BATCH DATE:|PROC DATE|TIME OF REPORT|PAGE:/i;

const GAP = '(?:\\s{2,}|\\t)';
const CHAIN_RE = new RegExp(`^\\s*Chain\\s*I[dD]\\s*:\\s*(.*?)${GAP}Chain Name\\s*:\\s*(.*?)\\s*$`, 'i');
// Detail rows always start with a date DD-MM-YYYY, followed by the time HH:MM:SS if present
const ROW_START_RE = /^\s*\d{2}-\d{2}-\d{4}(\s+\d{2}:\d{2}:\d{2})?/;
// 2020 layout prints totals on the same line: 'Total Failed Records:  2      10,000.00'
const TOTAL_FAILED_RE = /^\s*Total Failed Records:?\s*(-?[\d.,]+)(?:\s+(-?[\d.,]+))?\s*$/i;
const TOTAL_BILL_FEE_RE = /^\s*Total (?:Bill Fee|Fee|Amount):?\s*(-?[\d.,]+)\s*$/i;

const ERROR_COLUMN_START = COLUMN_LAYOUT.error[0];

function parseHeader(text) {
  const pick = (re) => {
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };

  return {
    reportId: pick(REPORT_ID_RE),
    titleFound: TITLE_RE.test(text),
    runDate: pick(RUN_DATE_RE),
    // 2026 build (ISTOR ready): Report Run Date / Report Date
    reportDate: pick(REPORT_DATE_RE),
    // 2020 build: BATCH DATE: YYYYMMDD / PROC DATE : dd/mm/yyyy
    batchDate: pick(BATCH_DATE_RE),
    procDate: pick(PROC_DATE_RE),
    page: pick(PAGE_RE),
    hasEndOfReport: END_OF_REPORT_RE.test(text),
  };
}

function sliceByLayout(line) {
  const cut = (key) => String(line.slice(COLUMN_LAYOUT[key][0], COLUMN_LAYOUT[key][1])).trim();
  const dateTime = cut('txnDateTime');
  const m = dateTime.match(/^(\d{2}-\d{2}-\d{4})(?:\s+(\d{2}:\d{2}:\d{2}))?$/);

  return {
    txnDate: m ? m[1] : '',
    txnTime: m && m[2] ? m[2] : '',
    batchId: cut('batchId'),
    prodAcctNbr: cut('prodAcctNbr'),
    accountType: cut('accountType'),
    sign: cut('sign'),
    billFee: cut('billFee'),
    error: cut('error'),
  };
}

function looksSane(f) {
  return Boolean(
    f.txnDate && f.batchId &&
    /^[+\-]$/.test(f.sign) &&
    /^-?[\d.,]+$/.test(f.billFee) &&
    /^[A-Za-z0-9]/.test(f.error)
  );
}

// Fallback when the fixed-width positions are not correct (dev changed the output width): split by
// groups of at least 2 spaces (fixed-width columns are always separated by at least 2 spaces).
function parseRowByTokens(line) {
  const head = line.match(/^\s*(\d{2}-\d{2}-\d{4})(?:\s+(\d{2}:\d{2}:\d{2}))?\s*(.*)$/);
  if (!head) return null;

  const [, txnDate, txnTime, rest] = head;
  let parts = rest.split(/\s{2,}|\t/).map((p) => p.trim()).filter(Boolean);
  if (!parts.some((p) => /^[+-]$/.test(p))) parts = rest.split(/\s+/).map((p) => p.trim()).filter(Boolean);

  let signIdx = -1;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (/^[+-]$/.test(parts[i])) { signIdx = i; break; }
  }
  if (signIdx < 0) return null;

  const before = parts.slice(0, signIdx);
  const sign = parts[signIdx];
  const after = parts.slice(signIdx + 1);

  let billFee = '';
  let error = '';
  if (after.length && /^-?[\d.,]+$/.test(after[0])) {
    billFee = after[0];
    error = after.slice(1).join(' ');
  } else {
    error = after.join(' ');
  }

  // Fields before Sign: Batch Id | Product Account Nbr | Account Type (may contain spaces)
  const batchId = before.length ? before[0] : '';
  const prodAcctNbr = before.length >= 2 ? before[1] : '';
  const accountType = before.length >= 3 ? before.slice(2).join(' ') : '';

  return { txnDate, txnTime: txnTime || '', batchId, prodAcctNbr, accountType, sign, billFee, error };
}

function parseRow(line, warnings) {
  const sliced = sliceByLayout(line);
  if (looksSane(sliced)) return sliced;

  const fallback = parseRowByTokens(line);
  if (fallback) {
    warnings.push(`Column-position parse failed, used token fallback: "${line.trim().slice(0, 100)}"`);
    return fallback;
  }

    warnings.push(`Cannot parse detail line: "${line.trim().slice(0, 100)}"`);
  return sliced;
}

function newGroup() {
  return {
    chainId: null,
    chainName: null,
    rows: [],
    totals: { failedRecords: null, billFee: null },
  };
}

function parseReport(text) {
  const warnings = [];
  const lines = text.split(/\r?\n/);
  const header = parseHeader(text);

  const section = {
    key: SECTION.key,
    title: SECTION.title,
    found: false,
    titleFound: false,
    sawColumnHeader: false,
    groups: [],
  };

  let currentGroup = null;
  let lastRow = null;

  const ensureGroup = () => {
    if (!currentGroup) {
      currentGroup = newGroup();
      section.groups.push(currentGroup);
    }
    return currentGroup;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (END_OF_REPORT_RE.test(trimmed)) break;
    if (!trimmed) { lastRow = null; continue; }
    if (SEPARATOR_RE.test(trimmed)) { lastRow = null; continue; }
    if (PAGE_HEADER_RE.test(trimmed)) { lastRow = null; continue; }

    // ---- section title (2026 build includes it; 2020 build does not) ----
    if (SECTION.titleRegex.test(trimmed)) {
      section.titleFound = true;
      section.found = true;
      currentGroup = null;
      lastRow = null;
      continue;
    }

    // ---- section column header row ----
    if (COLUMN_HEADER_RE.test(trimmed)) {
      section.sawColumnHeader = true;
      section.found = true;
      lastRow = null;
      continue;
    }

    // ---- group header: Chain ID / Chain Name ----
    let m = trimmed.match(CHAIN_RE);
    if (m) {
      currentGroup = newGroup();
      currentGroup.chainId = m[1].trim();
      currentGroup.chainName = m[2].trim();
      section.groups.push(currentGroup);
      section.found = true;
      lastRow = null;
      continue;
    }

    // ---- trailer for each chain ----
    m = trimmed.match(TOTAL_FAILED_RE);
    if (m) {
      const group = ensureGroup();
      group.totals.failedRecords = m[1];
      if (m[2]) group.totals.billFee = m[2];
      lastRow = null;
      continue;
    }
    m = trimmed.match(TOTAL_BILL_FEE_RE);
    if (m) {
      ensureGroup().totals.billFee = m[1];
      lastRow = null;
      continue;
    }

    // ---- detail row ----
    if (ROW_START_RE.test(line)) {
      const row = parseRow(line, warnings);
      ensureGroup().rows.push(row);
      section.found = true;
      lastRow = row;
      continue;
    }

    // ---- continuation line for Exception Code & Reason (wrapped onto the next line) ----
    if (lastRow && line.length > ERROR_COLUMN_START && !line.slice(0, ERROR_COLUMN_START).trim()) {
      lastRow.error = `${lastRow.error} ${trimmed}`.trim();
      continue;
    }

    warnings.push(`Unrecognized line (line ${i + 1}): "${trimmed.slice(0, 100)}"`);
  }

  return { header, section, warnings };
}

// ============ COMPARISON ============
function fieldMatches(field, actual, expected) {
  // Bill Fee: compare by numeric value (report prints 9,500.00 - DB also uses that format,
  // but we still compare as numbers to avoid depending on thousands separators)
  if (field === 'billFee') return sameNumberOrText(actual, expected);

  // Account Type on the report is printed in fixed-width form (for example '830 12'), while the
  // expected query concatenates prod_acct_level || prod_acct_type || acct_curr_code (without spaces).
  // Ignore spaces for this field during comparison.
  if (field === 'accountType') {
    return normalizeText(actual).replace(/\s+/g, '') === normalizeText(expected).replace(/\s+/g, '');
  }

  // Legacy format (2020) may print both date and time; if the build does not print time, ignore this field
  if (field === 'txnTime' && normalizeText(actual) === '') return true;

  return normalizeText(actual) === normalizeText(expected);
}

function recordIdOf(row) {
  return [row.chainId, normalizeText(`${row.txnDate} ${row.txnTime}`), row.batchId, row.prodAcctNbr]
    .filter((p) => p !== null && p !== undefined && String(p) !== '')
    .join(' | ');
}

function groupLabel(group) {
  return `Chain ${group.chainId || '(rong)'}`;
}

// Log in the required format: Record / Field / Expected / Actual
function logMismatch(mismatch) {
  log('[FAIL]');
  log(`  Record: ${mismatch.recordId}`);
  log(`  Field: ${FIELD_LABELS[mismatch.field] || mismatch.field}`);
  log(`  Expected (DB): ${mismatch.expected}`);
  log(`  Actual (report): ${mismatch.actual}`);
  log(`  Group: ${mismatch.group}`);
}

// Total Bill Fee for a group: add according to sign (Sign), while also calculating the absolute total
// because the 2020 report does not clearly record whether the sum is signed or absolute.
function feeTotals(rows) {
  let signed = 0;
  let absolute = 0;
  for (const r of rows) {
    const n = toNumber(r.billFee);
    if (Number.isNaN(n)) continue;
    signed += r.sign === '-' ? -n : n;
    absolute += n;
  }
  return { signed, absolute };
}

function compareReport(actualSection, expectedGroups) {
  const mismatches = [];
  const issues = [];
  const notes = [];
  let fieldsChecked = 0;
  let matchedFields = 0;
  let rowsChecked = 0;
  let matchedRows = 0;
  let mismatchedRows = 0;

  const actualGroups = actualSection ? actualSection.groups : [];
  const actualRecords = actualGroups.reduce((n, g) => n + g.rows.length, 0);
  const expectedRecords = expectedGroups.reduce((n, g) => n + g.rows.length, 0);

  if (actualRecords !== expectedRecords) {
    issues.push(`Detail row count mismatch: report = ${actualRecords}, DB = ${expectedRecords}`);
  }
  if (actualGroups.length !== expectedGroups.length) {
    issues.push(`Chain group count mismatch: report = ${actualGroups.length}, DB = ${expectedGroups.length}`);
  }

  for (let gi = 0; gi < Math.max(actualGroups.length, expectedGroups.length); gi += 1) {
    const actual = actualGroups[gi];
    const expected = expectedGroups[gi];

    if (!actual || !expected) {
      issues.push(`Missing group #${gi + 1} in ${actual ? 'DB' : 'report'}`);
      continue;
    }


const headerChecks = [
      ['chainId', actual.chainId || '', expected.chainId || ''],
      ['chainName', actual.chainName || '', expected.chainName || ''],
    ];

    for (const [field, act, exp] of headerChecks) {
      fieldsChecked += 1;
      if (fieldMatches(field, act, exp)) matchedFields += 1;
      else {
        mismatches.push({
          group: groupLabel(actual),
          recordId: '(group header)',
          field,
          expected: exp,
          actual: act,
        });
      }
    }

    if (actual.rows.length !== expected.rows.length) {
      issues.push(`${groupLabel(actual)}: detail row count mismatch - report = ${actual.rows.length}, DB = ${expected.rows.length}`);
    }

    for (let ri = 0; ri < Math.max(actual.rows.length, expected.rows.length); ri += 1) {
      const actRow = actual.rows[ri];
      const expRow = expected.rows[ri];
      if (!actRow || !expRow) continue;

      const recordId = recordIdOf(actRow);
      rowsChecked += 1;
      let rowOk = true;
      for (const field of ROW_FIELDS) {
        fieldsChecked += 1;
        if (fieldMatches(field, actRow[field], expRow[field])) matchedFields += 1;
        else {
          rowOk = false;
          mismatches.push({
            group: groupLabel(actual),
            recordId,
            field,
            expected: expRow[field],
            actual: actRow[field],
          });
        }
      }
      if (rowOk) matchedRows += 1; else mismatchedRows += 1;
    }

    // ---- trailer cua chain: Total Failed Records [+ tong Bill Fee] ----
    const expCount = expected.rows.length;
    const fees = feeTotals(expected.rows);

    fieldsChecked += 1;
    if (sameNumber(actual.totals.failedRecords, expCount)) matchedFields += 1;
    else {
      mismatches.push({
        group: groupLabel(actual),
        recordId: '(total)',
        field: 'TOTAL_FAILED_RECORDS',
        expected: String(expCount),
        actual: String(actual.totals.failedRecords),
      });
    }

    if (actual.totals.billFee === null || actual.totals.billFee === '') {
      notes.push(`${groupLabel(actual)}: report does not print the total Bill Fee - check skipped`);
    } else {
      fieldsChecked += 1;
      if (sameNumberOrText(actual.totals.billFee, fees.signed) ||
          sameNumberOrText(actual.totals.billFee, fees.absolute)) {
        matchedFields += 1;
      } else {
        mismatches.push({
          group: groupLabel(actual),
          recordId: '(total)',
          field: 'TOTAL_BILL_FEE',
          expected: formatBillFee(fees.signed),
          actual: String(actual.totals.billFee),
        });
      }
    }
  }

  for (const mismatch of mismatches) logMismatch(mismatch);

  return {
    actualRecords,
    expectedRecords,
    fieldsChecked,
    matchedFields,
    rowsChecked,
    matchedRows,
    mismatchedRows,
    mismatchedFields: mismatches.length,
    mismatches,
    issues,
    notes,
    success: mismatches.length === 0 && issues.length === 0,
  };
}

function reportRecordKey(row) {
  return [
    normalizeText(row.batchId),
    normalizeText(row.prodAcctNbr),
    normalizeText(`${row.txnDate} ${row.txnTime}`),
    // Discriminator: report prints 'BE647 - message', DB stores error_code 'BE647'.
    // Without it, an excluded row collides with a valid row sharing account + datetime.
    (normalizeText(row.error).split(' ')[0] || ''),
  ].join('|');
}

function excludedDbRecordKey(row) {
  return [
    normalizeText(row.batch_id),
    normalizeText(row.prod_acct_nbr),
    normalizeText(row.transaction_datetime),
    normalizeText(row.error_code),
  ].join('|');
}

function flattenReportRows(report) {
  return report.section.groups.flatMap((group) =>
    group.rows.map((row) => ({ ...row, chainId: group.chainId }))
  );
}

// ============ TEST SUITE ============
// ============ XUAT REPORT HTML (dashboard + chi tiet tung step) ============
function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function rowsTable(rows, maxRows = 100) {
  if (!rows || !rows.length) return '<div class="db-empty">(no data)</div>';
  const columns = Object.keys(rows[0]);
  const shown = rows.slice(0, maxRows);
  let html = '<div class="tablewrap"><table class="db-table"><thead><tr><th>#</th>';
  for (const c of columns) html += `<th>${escapeHtml(c)}</th>`;
  html += '</tr></thead><tbody>';
  shown.forEach((row, index) => {
    html += `<tr><td>${index + 1}</td>`;
    for (const c of columns) html += `<td>${escapeHtml(row[c])}</td>`;
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  if (rows.length > shown.length) {
    html += `<div class="db-empty">... and ${rows.length - shown.length} more row(s)</div>`;
  }
  return html;
}

function stepCell(legendNo) {
  const found = steps.find((s) => s.no === legendNo);
  if (!found) return '<td class="na">·</td>';
  return `<td class="${found.ok ? 'ok' : 'bad'}" title="${escapeHtml(found.note)}">${found.ok ? '✔' : '✘'}</td>`;
}

function writeDashboard(reportFilePath = null, rawText = null) {
  let rawReport = rawText || '';
  try {
    if (!rawReport && reportFilePath) rawReport = fs.readFileSync(reportFilePath, 'utf8');
  } catch (error) {
    rawReport = `(cannot read report file: ${error.message})`;
  }
  const totalTests = testCaseResults.length;
  const passed = testCaseResults.filter((t) => t.ok).length;
  const failed = totalTests - passed;
  const passRate = totalTests ? ((passed / totalTests) * 100).toFixed(1) : '0.0';
  const stepList = STEP_LEGEND.map(([no]) => no);
  const stepHeaders = stepList.map((no) => `<th>${escapeHtml(no)}</th>`).join('');
  const stepCells = stepList.map(stepCell).join('');

  const outputs = seedInfo.outputs || { out: [], rej: [], err: [], files: [] };
  const b009Total = outputs.out.length + outputs.rej.length + outputs.err.length;
  const b134Total = compareSummary ? compareSummary.actualRecords : 0;
  const b134Pass = compareSummary ? compareSummary.matchedRows : 0;
  const b134Fail = compareSummary ? compareSummary.mismatchedRows : 0;
  const cutoffRow = seedInfo.cutoffs || null;
  const postDateGreater = Boolean(
    seedInfo.postDate && cutoffRow &&
    seedInfo.postDate > cutoffRow.last_cutoff_time &&
    seedInfo.postDate > cutoffRow.current_cutoff_time
  );

  const testRows = testCaseResults.map((t) => `
      <tr>
        <td>${escapeHtml(t.id)}</td>
        <td class="${t.ok ? 'pass' : 'fail'}">${t.ok ? 'PASS' : 'FAIL'}</td>
        <td>${escapeHtml(t.label || '')}</td>
        <td>${escapeHtml(t.note || '')}</td>
      </tr>`).join('');

  const detailSections = steps.map((s) => `
        <div class="db-block">
          <div class="db-header">
            <span class="${s.ok ? 'ok' : 'bad'}">${s.ok ? '✔' : '✘'}</span>
            <strong>Step ${escapeHtml(s.no)} — ${escapeHtml(s.name)}</strong>
          </div>
          <div class="db-note">${escapeHtml(s.note)}</div>
          ${s.sql ? `<div class="db-query"><code>${escapeHtml(s.sql.trim())}</code></div>` : ''}
          ${s.rows ? `<div class="rec-note">${escapeHtml(s.rowsLabel || `${s.rows.length} row(s)`)}</div>${rowsTable(s.rows, 500)}` : ''}
        </div>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>OLSDB009 -&gt; OLSD134R &mdash; Dashboard</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 24px; background: #f7f8fa; color: #1f2933; }
    h1 { margin-top: 0; }
    h2 { margin-top: 32px; font-size: 18px; }
    .meta { color: #52606d; font-size: 13px; margin-bottom: 20px; }
    .summary { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
    .card { background: #fff; border-radius: 8px; padding: 16px 24px; box-shadow: 0 1px 3px rgba(0,0,0,.08); min-width: 140px; }
    .card .label { font-size: 12px; text-transform: uppercase; color: #52606d; letter-spacing: .05em; }
    .card .value { font-size: 24px; font-weight: 700; margin-top: 4px; }
    .card.pass .value { color: #0b8f4b; }
    .card.fail .value { color: #c62828; }
    .tablewrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); font-size: 13px; min-width: 2000px; }
    th, td { padding: 8px 10px; text-align: center; border-bottom: 1px solid #e4e7eb; white-space: nowrap; }
    th { background: #1f2933; color: #f5f7fa; font-weight: 600; font-size: 12px; }
    td.left, th.left { text-align: left; }
    tr:hover td { background: #f0f4f8; }
    td.ok { color: #0b8f4b; font-weight: 700; }
    td.bad { color: #c62828; font-weight: 700; }
    td.na { color: #9ca3af; }
    .legend-table { min-width: 0; width: auto; margin-top: 8px; font-size: 13px; }
    .legend-table th { background: #2e3a46; font-size: 12px; }
    .legend-table td { white-space: normal; }
    .legend-num { font-weight: 700; color: #1f2933; text-align: center; width: 40px; background: #f0f4f8; }
    .legend-desc { color: #3e4c59; }
    .legend { margin-top: 20px; font-size: 12px; color: #52606d; }
    .legend .chip { display: inline-block; padding: 2px 8px; border-radius: 4px; color: #fff; margin-right: 4px; }
    .legend .chip.ok { background: #0b8f4b; }
    .legend .chip.bad { background: #c62828; }
    .db-section { display: flex; flex-direction: column; gap: 24px; margin-top: 8px; }
    .db-test { background: #fff; border-radius: 8px; padding: 16px 20px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .db-test h3 { margin: 0 0 12px; font-size: 15px; color: #1f2933; }
    .db-block { margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #e4e7eb; }
    .db-block:last-child { border-bottom: none; padding-bottom: 0; margin-bottom: 0; }
    .db-header { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-bottom: 6px; }
    .db-header .ok { color: #0b8f4b; font-weight: 700; }
    .db-header .bad { color: #c62828; font-weight: 700; }
    .db-query { font-size: 12px; color: #52606d; margin-bottom: 6px; }
    .db-query code { background: #f0f4f8; padding: 2px 6px; border-radius: 4px; display: inline-block; white-space: pre-wrap; }
    .db-note { font-size: 12px; color: #3e4c59; margin-bottom: 8px; font-style: italic; }
    .db-table { width: 100%; min-width: 0; font-size: 12px; margin-top: 4px; box-shadow: none; border: 1px solid #e4e7eb; }
    .db-table th { background: #2e3a46; color: #f5f7fa; font-size: 11px; padding: 6px 8px; text-align: left; }
    .db-table td { padding: 6px 8px; text-align: left; color: #1f2933; border-bottom: 1px solid #eef1f5; white-space: normal; word-break: break-word; }
    .db-table tr:hover td { background: #f0f4f8; }
    .db-empty { font-size: 12px; color: #829ab1; font-style: italic; }
    .rec-note { font-size: 12px; color: #3e4c59; margin-bottom: 6px; }
    .rec-grid th { white-space: nowrap; }
    .rec-grid td { font-family: Consolas, Menlo, monospace; font-size: 11px; color: #102a43; text-align: left; white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
    .rec-grid td.rec-idx, .rec-grid th.rec-idx { width: 40px; text-align: center; font-weight: 700; color: #334e68; background: #f8fafc; position: sticky; left: 0; }
    .rec-horizontal { table-layout: auto; min-width: 0; }
    pre.report-raw { background: #fff; border: 1px solid #e4e7eb; border-radius: 8px; padding: 12px; margin: 0; font-family: Consolas, Menlo, monospace; font-size: 12px; line-height: 1.35; overflow-x: auto; white-space: pre; }
  </style>
</head>
<body>
  <h1>OLSDB009 &#8594; OLSD134R &mdash; Dashboard</h1>
  <div class="meta">Generated: ${escapeHtml(new Date().toISOString())} | Batch date: ${escapeHtml(runContext.batchDateYmd || 'n/a')} | Host: ${escapeHtml(CONFIG.winscp.host)} | DB: ${escapeHtml(CONFIG.database.database)}</div>

  <div class="summary">
    <div class="card"><div class="label">Test Cases</div><div class="value">${totalTests}</div></div>
    <div class="card pass"><div class="label">Passed</div><div class="value">${passed}</div></div>
    <div class="card fail"><div class="label">Failed</div><div class="value">${failed}</div></div>
    <div class="card"><div class="label">Pass Rate</div><div class="value">${passRate}%</div></div>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th rowspan="2">Test</th><th rowspan="2">Overall</th>
          <th colspan="${stepList.length}">Steps</th>
          <th colspan="5">OLSDB009 Output</th>
          <th colspan="5">OLSD134R Output</th>
          <th colspan="3">Post_Date / Cutoff</th>
          <th rowspan="2">Post_Date &gt; Cutoff</th>
          <th rowspan="2">Transactions (14a)</th>
          <th rowspan="2">Report rows (14b)</th>
          <th rowspan="2">Report Rows</th>
        </tr>
        <tr>
          ${stepHeaders}
          <th>Total</th><th>Out</th><th>Rej</th><th>Err</th><th>DT rows</th>
          <th>Total</th><th>Pass</th><th>Fail</th><th>Rej</th><th>Err</th>
          <th>Post_Date</th><th>Last Cutoff</th><th>Current Cutoff</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>TC01-TC03</td>
          <td class="${failed ? 'fail' : 'pass'}">${failed ? 'FAIL' : 'PASS'}</td>
          ${stepCells}
          <td>${b009Total}</td><td>${outputs.out.length}</td><td>${outputs.rej.length}</td><td>${outputs.err.length}</td>
          <td>${seedInfo.dtOutRows || 0}/${seedInfo.dtRejRows || 0}</td>
          <td>${b134Total}</td><td>${b134Pass}</td><td>${b134Fail}</td><td>0</td><td>0</td>
          <td>${escapeHtml(seedInfo.postDate || 'n/a')}</td>
          <td>${escapeHtml(seedInfo.cutoffs ? seedInfo.cutoffs.last_cutoff_time : 'n/a')}</td>
          <td>${escapeHtml(seedInfo.cutoffs ? seedInfo.cutoffs.current_cutoff_time : 'n/a')}</td>
          <td class="${postDateGreater ? 'ok' : 'bad'}">${postDateGreater ? '✔' : '✘'}</td>
          <td class="${(seedInfo.transactions || []).length ? 'ok' : 'bad'}">${(seedInfo.transactions || []).length ? '✔' : '✘'}</td>
          <td class="${b134Total ? 'ok' : 'bad'}">${b134Total ? '✔' : '✘'}</td>
          <td>${b134Total}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="legend">
    <span><span class="chip ok">✔</span>Pass</span>
    <span><span class="chip bad">✘</span>Fail</span>
    <span>Hover any step cell to see its description</span>
  </div>

  <h2>Test cases</h2>
  <div class="table-wrap"><table><thead><tr><th>Test</th><th>Overall</th><th>Result</th><th>Note</th></tr></thead><tbody>${testRows}</tbody></table></div>

  <h2>Step Legend</h2>
  <div class="tablewrap"><table class="legend-table"><thead><tr><th>#</th><th class="left">Description</th></tr></thead><tbody>
    ${STEP_LEGEND.map(([no, desc]) => `<tr><td class="legend-num">${escapeHtml(no)}</td><td class="legend-desc left">${escapeHtml(desc)}</td></tr>`).join('')}
  </tbody></table></div>

  <h2>Report Layout</h2>
  <p class="muted">Raw report file exactly as generated (fixed-width, ${rawReport.split(/\r?\n/).length - 1} lines):
    <code>${escapeHtml(reportFilePath ? reportFilePath.split('\\').pop() : 'n/a')}</code></p>
  <div class="tablewrap"><pre class="report-raw">${escapeHtml(rawReport)}</pre></div>

  <h2>DB Verification Details</h2>
  <div class="db-section">
    <div class="db-test">
      <h3>TC001 - OLSD134R</h3>
      ${detailSections}
    </div>
  </div>
</body>
</html>`;

  fs.ensureDirSync(CONFIG.report.localDir);
  const outPath = path.join(CONFIG.report.localDir, 'dashboard.html');
  fs.writeFileSync(outPath, html);
  log(`📄 Dashboard: ${outPath}`);
  return outPath;
}

test.describe('OLSD134R - Batch Redemption Exception Report', () => {
  let ctx;                        // batch date / cutoff / process_date window
  let parsed;                     // report already parsed
  let reportPath;                 // report file on the server/local machine
  let reportWindow;               // date range used by the report (from Report Date)
  let seedRejected = [];          // rejected redemption records created by OLSDB009 for the uploaded file
  let sourceRows = [];            // rejected redemption records in the report date range
  let targetBatchIds = [];        // Batch IDs read from DB (not hard-coded)
  let nullErrorCount = 0;         // txn_type=01 rows with error_code IS NULL in the window
  let lastCutoffTime = null;      // last_cutoff_time for module OLSDR134 (used by the report filter)
  let rowsBeforeCutoff = [];      // rows in the window that do not meet the cutoff condition

  test.beforeAll(async () => {
    // Two Java batches (OLSDB009 + OLSDR134) require a longer runtime
    test.setTimeout(90 * 60 * 1000);

    // ---- 1. Read batch date + cutoff time ----
    log('📋 Step 1: Read batch_date + cut-off from DB');
    ctx = await getBatchContext('PREFLIGHT');
    runContext.batchDateYmd = ctx.batchDateYmd;
    log(`📊 batch date = ${ctx.batchDateYmd}, cut-off = ${ctx.cutOffTime} (module ${ctx.cutOffModuleId})`);
    log(`📊 data window (process_date): > ${ctx.fromDate} AND <= ${ctx.toDate}`);

    // ---- 2. Prepare data: OLSTXN (txnTranType 01) -> OLSDB009 ----
    if (process.env.OLSDR134R_SKIP_PREPARE === '1') {
      log('📋 Step 2: Skip seeding (OLSDR134R_SKIP_PREPARE=1)');
    } else {
      log('📋 Step 2: Seed data (OLSTXN -> OLSDB009)');
      const prepared = await prepareData('OLSD134R');
      // prepareData may update batch_date -> keep the refreshed ctx (updated BD)
      if (prepared.ctx) {
        ctx = prepared.ctx;
        runContext.batchDateYmd = ctx.batchDateYmd;
        log(`📊 BD sau update batch_date = ${ctx.batchDateYmd}`);
      }
      seedRejected = prepared.rejected || [];
      seedFileNames = prepared.fileNames || [];
      steps.push(...(prepared.steps || []));
      seedInfo.outputs = prepared.outputs || null;
      seedInfo.postDate = prepared.postDate || null;
      seedInfo.cutoffs = prepared.cutoffs || null;
      seedInfo.dtOutRows = (prepared.outputs && prepared.outputs.dtOutRows) || 0;
      seedInfo.dtRejRows = (prepared.outputs && prepared.outputs.dtRejRows) || 0;
      seedInfo.transactions = prepared.transactions || [];
      log(`[OLSD134R] OLSDB009 created ${seedRejected.length} rejected redemption row(s) for the uploaded file`);
    }

    // ---- 3. Run report ----
    const expectedReport = reportFileName(ctx.batchDateYmd);
    log(`📋 Step 3: Run OLSD134R report (expected ${expectedReport}; discovered by glob ` +
      `${reportFileGlob(ctx.batchDateYmd)})`);

    let remoteReportName = expectedReport;
    if (process.env.OLSDR134R_SKIP_BATCH === '1') {
      log('⏭️ Skip report batch (OLSDR134R_SKIP_BATCH=1) - use the existing file on server');
      const existing = await listRemoteReports(ctx.batchDateYmd, 'REPORT');
      if (existing.length) {
        existing.sort((a, b) => b.mtime - a.mtime);
        remoteReportName = existing[0].name;
      }
      addStep('10', 'Run OLSD134R batch', false, 'skipped (OLSDR134R_SKIP_BATCH=1)');
      addStep('11', 'Wait for OLSD134R report file', false, `skipped - use ${remoteReportName} on server`);
    } else {
      log('[OLSD134R] Start report batch');
      const before = (await listRemoteReports(ctx.batchDateYmd, 'REPORT')).map((r) => r.signature);
      await executeBatch('REPORT');
      addStep('10', 'Run OLSD134R batch', true, `cd ${CONFIG.batch.scriptPath} && ${CONFIG.batch.command}`);
      const fresh = await waitForFreshReport(ctx.batchDateYmd, before, 'REPORT');
      remoteReportName = fresh.name;
      addStep('11', 'Wait for OLSD134R report file', true,
        `${CONFIG.report.remoteDir}/${remoteReportName} regenerated (${fresh.size} bytes)`);
      log('[OLSD134R] Report generated successfully');
    }

    // ---- 4. Download report + parse ----
    log('📋 Step 4: Download report and parse');
    reportPath = await downloadReport(remoteReportName, 'REPORT');
    addStep('12', 'Download report to local', true, reportPath);
    parsed = parseReport(fs.readFileSync(reportPath, 'utf8'));
    rawReportText = fs.readFileSync(reportPath, 'utf8');
    const parseNote = `parse: records=${parsed.section.groups.reduce((n, g) => n + g.rows.length, 0)}, ` +
      `warnings=${parsed.warnings.length}, Report Date=${parsed.header.reportDate || parsed.header.batchDate || 'n/a'}`;
    addStep('13', 'Verify report: parse + compare DB vs report', parsed.warnings.length === 0,
      parseNote);

    if (parsed.warnings.length) {
      log(`⚠️ Parser warning(s) [${parsed.warnings.length}]:`);
      for (const w of parsed.warnings) log(`   - ${w}`);
    }

    log(`[OLSD134R] Actual report records: ${parsed.section.groups.reduce((n, g) => n + g.rows.length, 0)}`);

    // ---- 5. Report data window + expected data ----
    // The report takes data based on its own Report Date (the dev batch_date can differ from the
    // OLSTXN file run date), so the expected query must use the correct date range.
    reportWindow = windowFromReport(parsed.header, ctx);
    log(`[OLSD134R] Report data range (${reportWindow.source}): ` +
      `process_date > ${reportWindow.fromDate} AND <= ${reportWindow.toDate}`);

    if (!lastCutoffTime) {
      const cutoffs = await getCutoffTimes('PREFLIGHT');
      lastCutoffTime = cutoffs ? cutoffs.last_cutoff_time : null;
    }
    log(`[OLSD134R] Report extra filter: process_date > last_cutoff_time (${lastCutoffTime || 'n/a'})`);

    sourceRows = await fetchRejectedRedemptions(reportWindow, 'PREFLIGHT', lastCutoffTime);
    // Run the same query without the cutoff condition to tell whether the report is empty because of the cutoff or because there is no data
    rowsBeforeCutoff = await fetchRejectedRedemptions(reportWindow, 'PREFLIGHT', null);
    targetBatchIds = [...new Set(
      sourceRows.map((r) => String(r.batch_id === null || r.batch_id === undefined ? '' : r.batch_id).trim())
        .filter(Boolean)
    )];
    log(`[OLSD134R] Batch IDs from DB: ${targetBatchIds.join(', ') || '(none)'}`);

    nullErrorCount = await countRedemptions(reportWindow, { errorCodeNotNull: false }, 'PREFLIGHT');
    log(`[OLSD134R] txn_type='${TXN_TYPE_REDEMPTION}' rows with error_code IS NULL in range ` +
      `(must NOT appear in report): ${nullErrorCount}`);
  });

  test('TC01: Report structure (title + batch date + END OF REPORT)', async () => {
    const issues = [];

    if (!parsed.header.titleFound) {
      issues.push('Missing title line "BATCH REDEMPTION EXCEPTION REPORT"');
    }
    if (!parsed.header.hasEndOfReport) issues.push('Missing "*** END OF REPORT ***"');

    // 2026 build does not print the section title / column header when the section is empty (verified
    // with real file MYOLSD134R20260915.txt: it contains only the header + END OF REPORT), so only
    // raise an error when the parser cannot read any rows in the report.
    if (parsed.warnings.length) {
      issues.push(`Parser warning(s) [${parsed.warnings.length}]: ${parsed.warnings[0]}`);
    }

    // The batch date on the report must match the batch date in DB.
    // 2026 build prints 'Report Date: ddmmyyyy'; 2020 build prints 'BATCH DATE: yyyymmdd'.
    const rawDate = parsed.header.reportDate || parsed.header.batchDate;
    const reportBatchDate = rawDate
      ? (parsed.header.reportDate
        ? `${rawDate.slice(4)}${rawDate.slice(2, 4)}${rawDate.slice(0, 2)}`
        : rawDate)
      : null;

    if (!reportBatchDate) issues.push('Cannot read Report Date / Batch Date from report');
    else if (reportBatchDate !== ctx.batchDateYmd) {
      issues.push(`Report batch date (${reportBatchDate}) differs from DB (${ctx.batchDateYmd})`);
    }

    if (issues.length) log(`❌ TC01: ${issues.join(' | ')}`);

    testCaseResults.push({
      id: 'TC01',
      ok: issues.length === 0,
      label: 'Report structure (title + batch date + END OF REPORT)',
      note: issues.join(' | ') || `Report Date = ${parsed.header.reportDate || parsed.header.batchDate || 'n/a'}`,
    });

    await saveTestResults('TC01-STRUCTURE', {
      success: issues.length === 0,
      totalRecords: 1,
      trueCount: issues.length === 0 ? 1 : 0,
      falseCount: issues.length,
      details: issues,
    }, { start: 1, end: 1 });

    expect(issues, `Invalid report structure:\n${issues.join('\n')}`).toEqual([]);
  });

  test('TC02: OLSDB009 - rejected redemption transactions in DWH_TEMP_TXN', async () => {
    const issues = [];

    if (!sourceRows.length) {
      const latest = await latestRedemptionProcessDate('TC02');
      if (rowsBeforeCutoff.length) {
        // An empty report is valid business behavior: every record is <= last_cutoff_time
        log(`ℹ️ [TC02] Report is legitimately empty: ${rowsBeforeCutoff.length} row(s) in range ` +
          `but all have process_date <= last_cutoff_time (${lastCutoffTime || 'n/a'})`);
        seedInfo.reportEmptyByCutoff = {
          rows: rowsBeforeCutoff.length,
          lastCutoffTime,
        };
      } else {
        issues.push(
          `No row in ${SCHEMA}.dwh_temp_txn matches txn_type='${TXN_TYPE_REDEMPTION}' AND error_code IS NOT NULL ` +
          `within the report date range (process_date > ${reportWindow.fromDate} AND <= ${reportWindow.toDate}) ` +
          `-> OLSD134R report is empty, nothing to verify. ` +
          `Latest process_date of txn_type='${TXN_TYPE_REDEMPTION}' rows = ${latest}. ` +
          `If that date is outside the report range, batch_date is behind the data date ` +
          `(run EOD / OLSDB000 to refresh batch_date, then rerun).`
        );
      }
    }
    if (!targetBatchIds.length) {
      issues.push('No Batch ID found in DB - cannot query expected data by Batch ID.');
    }

    log(`📊 [TC02] Rejected redemption records trong date range cua report = ${sourceRows.length} ` +
      `(OLSD009 tao cho file vua upload: ${seedRejected.length}), ` +
      `Batch ID = ${targetBatchIds.join(', ') || '(none)'}, ` +
      `rows with error_code IS NULL (must NOT appear in report) = ${nullErrorCount}`);

    if (issues.length) for (const issue of issues) log(`❌ [TC02] ${issue}`);

    testCaseResults.push({
      id: 'TC02',
      ok: issues.length === 0,
      label: 'OLSDB009 source data in DWH_TEMP_TXN',
      note: issues.join(' | ') ||
        `${sourceRows.length} rejected record trong date range cua report, Batch ID = ${targetBatchIds.join(', ')}`,
    });

    await saveTestResults('TC02-SOURCE-DATA', {
      success: issues.length === 0,
      totalRecords: sourceRows.length,
      trueCount: sourceRows.length,
      falseCount: issues.length,
      details: issues,
    }, { start: 1, end: 1 });

    expect(issues, `Invalid source data for OLSD134R:\n${issues.join('\n')}`).toEqual([]);
  });

  test('TC03: Report vs DB (field mapping + ordering + totals)', async () => {
    const started = Date.now();

    const dbRows = await fetchExpectedRows(targetBatchIds, reportWindow, lastCutoffTime, 'TC03');
    const expectedGroups = buildExpectedGroups(dbRows);

    log(`[OLSD134R] Expected DB records: ${expectedGroups.reduce((n, g) => n + g.rows.length, 0)}`);
    log(`[OLSD134R] Actual report records: ${parsed.section.groups.reduce((n, g) => n + g.rows.length, 0)}`);
    log('[OLSD134R] Compare report data with database');

    const result = compareReport(parsed.section, expectedGroups);
    compareSummary = {
      actualRecords: result.actualRecords,
      expectedRecords: result.expectedRecords,
      matchedRows: result.matchedRows,
      mismatchedRows: result.mismatchedRows,
      fieldsChecked: result.fieldsChecked,
      mismatchedFields: result.mismatchedFields,
    };

    addStep('13', 'Compare DB vs report (field by field)', result.success,
      `report=${result.actualRecords} row(s), DB=${result.expectedRecords} row(s), ` +
      `fields checked=${result.fieldsChecked}, mismatched fields=${result.mismatchedFields}`);
    addStep('14a', 'Check DWH_TEMP_TXN rows in the report date range', dbRows.length > 0,
      `process_date > ${reportWindow.fromDate} AND <= ${reportWindow.toDate} (${reportWindow.source}) — ${dbRows.length} row(s)`,
      {
        sql: EXPECTED_QUERY,
        rows: dbRows,
        rowsLabel: `Expected (DB): ${dbRows.length} row(s) — report filter included: ` +
          `process_date > last_cutoff_time (${lastCutoffTime || 'n/a'})`,
      });
    addStep('14b', 'Check report rows (all records)', true,
      `${parsed.section.groups.reduce((n, g) => n + g.rows.length, 0)} row(s) read from ${path.basename(reportPath)}`,
      {
        rows: parsed.section.groups.flatMap((g) => g.rows.map((r) => ({
          chain_id: g.chainId, chain_name: g.chainName, ...r,
        }))),
        rowsLabel: 'Actual (report)',
      });

    testCaseResults.push({
      id: 'TC03',
      ok: result.success,
      label: 'Report vs DB (mapping + ordering + total)',
      note: `${result.mismatchedFields} field lech, ${result.issues.length} van de so luong/nhom`,
    });

    log(`📊 [TC03] report = ${result.actualRecords} row(s), DB = ${result.expectedRecords} row(s), ` +
      `fields checked = ${result.fieldsChecked}, mismatched fields = ${result.mismatchedFields}`);
    for (const note of result.notes) log(`ℹ️ [TC03] ${note}`);
    for (const issue of result.issues) log(`⚠️ [TC03] ${issue}`);

    log(`[OLSD134R] Validation ${result.success ? 'PASSED' : 'FAILED'}`);

    await saveTestResults('TC03-REPORT-VS-DB', {
      success: result.success,
      totalRecords: result.actualRecords,
      trueCount: result.matchedFields,
      falseCount: result.mismatchedFields,
      details: result.mismatches,
    }, { start: 1, end: 1 }, Date.now() - started);

    expect(
      result.success,
      `OLSD134R report: ${result.mismatchedFields} mismatched field(s), ` +
      `${result.issues.length} count/group issue(s): ${result.issues.join(' | ')}`
    ).toBe(true);
  });

  test('TC04: Negative cases - excluded rows must not appear in report', async () => {
    // Scope the negative fixtures to the file(s) uploaded by THIS run, so that files uploaded
    // by other testers on the same day cannot make the negative assertion flaky.
    const excludedRows = await fetchExcludedRows(reportWindow, lastCutoffTime, 'TC04', seedFileNames);
    const actualKeys = new Set(flattenReportRows(parsed).map(reportRecordKey));
    const requiredReasons = [
      'txn_type=03',
      'error_code IS NULL',
    ];
    const issues = [];

    // Rows that the report is EXPECTED to print (txn_type='01' with error_code). An excluded
    // fixture can legitimately share the same report key (account + datetime + error_code)
    // with an included row, so those ambiguous keys must not be reported as violations.
    // Rows the report is EXPECTED to print: the same expected query TC03 uses
    // (txn_type='01', error_code IS NOT NULL, report date range, process_date > last_cutoff_time)
    // but taken over the whole window, not only the seed file of this run.
    const expectedRows = await fetchExpectedRows(targetBatchIds, reportWindow, lastCutoffTime, 'TC04');
    const includedKeys = new Set(expectedRows.map((r) => excludedDbRecordKey({
      batch_id: r.batch_id,
      prod_acct_nbr: r.product_acct_number,
      transaction_datetime: r.transaction_datetime,
      // report prints 'BE678 - message' while the DB key uses the bare error code
      error_code: normalizeText(r.exception_code_reason).split(' ')[0],
    })));

    for (const reason of requiredReasons) {
      const rows = excludedRows.filter((row) => row.exclusion_reason === reason);
      if (!rows.length) {
        issues.push(`No fixture row found for exclusion rule: ${reason}`);
      }

      for (const row of rows) {
        const key = excludedDbRecordKey(row);
        if (actualKeys.has(key) && !includedKeys.has(key)) {
          issues.push(
            `Excluded row appears in report: ${key} ` +
            `(reason=${reason}, error_code=${row.error_code || 'NULL'}, ` +
            `process_date=${row.process_date})`
          );
        }
      }
    }

    const reasonSummary = requiredReasons
      .map((reason) => `${reason}: ${excludedRows.filter((row) => row.exclusion_reason === reason).length}`)
      .join('; ');
    log(`[TC04] Negative fixtures: ${reasonSummary}`);
    for (const issue of issues) log(`❌ [TC04] ${issue}`);

    testCaseResults.push({
      id: 'TC04',
      ok: issues.length === 0,
      label: 'Negative cases - excluded rows absent from report',
      note: issues.join(' | ') || reasonSummary,
    });

    await saveTestResults('TC04-NEGATIVE-CASES', {
      success: issues.length === 0,
      totalRecords: excludedRows.length,
      trueCount: excludedRows.length - issues.length,
      falseCount: issues.length,
      details: issues,
    }, { start: 1, end: 1 });

    expect(issues, `Negative-case validation failed:\n${issues.join('\n')}`).toEqual([]);
  });

  // Phase 2 negative case: a record with process_date <= last_cutoff_time must not be printed.
  test('TC06: Negative - process_date <= last_cutoff_time is not printed', async () => {
    const cutoffModule = 'OLSDR134';
    const includedRows = (seedInfo.transactions || []).filter(
      (r) => normalizeText(r.txn_type) === normalizeText(TXN_TYPE_REDEMPTION)
        && normalizeText(r.error_code) !== ''
    );
    const issues = [];

    if (!includedRows.length) {
      issues.push('No txn_type=01 row with error_code found for the seed file - nothing to re-check');
    }

    // Make every seeded record fall at/below the last cut-off time (process_date is BD 00:00:00).
    await executeDbQuery(
      `UPDATE ${SCHEMA}.oe_cutofftime_control
          SET last_cutoff_time    = $1::date,
              last_cutoff_by      = 'OLSD134R',
              current_cutoff_time = $1::date + time '23:59:59',
              current_cutoff_by   = 'OLSD134R'
        WHERE module_id = $2`,
      [ctx.batchDate, cutoffModule],
      'TC06'
    );
    log(`[TC06] Phase 2: last_cutoff_time = ${ctx.batchDate} 00:00:00 (records are now <= last cut-off)`);

    const before = (await listRemoteReports(ctx.batchDateYmd, 'TC06')).map((r) => r.signature);
    await executeBatch('TC06');
    const fresh = await waitForFreshReport(ctx.batchDateYmd, before, 'TC06');
    const phase2Path = await downloadReport(fresh.name, 'TC06');
    const phase2 = parseReport(fs.readFileSync(phase2Path, 'utf8'));
    const phase2Keys = new Set(flattenReportRows(phase2).map(reportRecordKey));

    for (const row of includedRows) {
      if (phase2Keys.has(excludedDbRecordKey(row))) {
        issues.push(`Phase-2 report must NOT contain a record with process_date <= last_cutoff_time ` +
          `(acct=${row.prod_acct_nbr}, process_date=${row.process_date})`);
      }
    }
    log(`[TC06] Phase-2 report rows = ${flattenReportRows(phase2).length} ` +
      `(records checked = ${includedRows.length}, violations = ${issues.length})`);

    // Restore the standard cut-off used by the positive cases (BD-2 / BD-1).
    await executeDbQuery(
      `UPDATE ${SCHEMA}.oe_cutofftime_control
          SET last_cutoff_time    = ($1::date - 2) + time '23:59:59',
              last_cutoff_by      = 'OLSD134R',
              current_cutoff_time = ($1::date - 1) + time '23:59:59',
              current_cutoff_by   = 'OLSD134R'
        WHERE module_id = $2`,
      [ctx.batchDate, cutoffModule],
      'TC06'
    );

    addStep('15b', 'Negative case: process_date <= last_cutoff_time is not printed', issues.length === 0,
      `phase-2 report rows = ${flattenReportRows(phase2).length}, records checked = ${includedRows.length}`,
      { rows: includedRows, rowsLabel: 'Rows in dwh_temp_txn (ignoring cut-off) that must be hidden' });

    testCaseResults.push({
      id: 'TC06',
      ok: issues.length === 0,
      label: 'Negative: process_date <= last_cutoff_time must not be printed',
      note: issues.join(' | ') || `${includedRows.length} record(s) hidden by cut-off, 0 printed`,
    });
    await saveTestResults('TC06-NEG-CUTOFF', {
      success: issues.length === 0,
      totalRecords: includedRows.length,
      trueCount: includedRows.length - issues.length,
      falseCount: issues.length,
      details: issues,
    }, { start: 1, end: 1 });
    expect(issues, `Negative case TC06 failed:\n${issues.join('\n')}`).toEqual([]);
  });

  // Write the HTML dashboard (step-by-step details) after execution for reporting.
  test.afterAll(async () => {
    // Safety net: the module cut-off is GLOBAL for all report runs, so make sure it is back to
    // the standard values (BD-2 / BD-1) even when TC06 phase 2 failed before restoring it.
    try {
      if (ctx && ctx.batchDate) {
        await executeDbQuery(
          `UPDATE ${SCHEMA}.oe_cutofftime_control
              SET last_cutoff_time    = ($1::date - 2) + time '23:59:59',
                  last_cutoff_by      = 'OLSD134R',
                  current_cutoff_time = ($1::date - 1) + time '23:59:59',
                  current_cutoff_by   = 'OLSD134R'
            WHERE module_id = 'OLSDR134'`,
          [ctx.batchDate],
          'AFTER-ALL'
        );
      }
    } catch (error) {
      log(`⚠️ Cannot restore cut-off in afterAll: ${error.message}`);
    }
    try {
      writeDashboard(reportPath, rawReportText);
    } catch (error) {
      log(`⚠️ Cannot write dashboard: ${error.message}`);
    }
  });
});
