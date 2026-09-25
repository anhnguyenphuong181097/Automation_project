// scripts/OLSD133R/test-runner.spec.js
// Batch   : OLSDR133  ->  report OLSD133R "Point Adjustment Exception Report"
// Host    : 192.168.99.83 (MY-dev), DB ols_my / schema ols_schema
//
// This folder follows the same 4-file pattern as OLSDB024:
//   test-data.js        : CONFIG + 7 section definitions + seed-batch list
//   file-naming.js      : naming convention for report file MYOLSD133R<batchdate>.txt
//   file-generator.js   : prepares input data (OLSDB009 + 6 forfeit batches)
//   test-runner.spec.js : this file - runs the batch, downloads the report, compares with DB
// Manual data-prep run: node scripts/OLSD133R/file-generator.js
//
// One execution flow:
//   1. PREPARE : OLSDB009 -> DWH_TEMP_TXN, 6 forfeit batches -> TEMP_*
//   2. RUN     : ./OLSDR133  ->  MYOLSD133R<batch date>.txt
//   3. LOAD    : download the report to reports\OLSD133R\ and parse it
//   4. VERIFY  : query DB per section -> compare each field -> log [FAIL]
//
// Optional environment flags:
//   OLSDR133R_SKIP_PREPARE=1  skip the seed step (use existing DB data)
//   OLSDR133R_SKIP_BATCH=1    do not rerun OLSDR133; reuse the report file already on server

import { test, expect } from '@playwright/test';
import fs from 'fs-extra';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import pg from 'pg';
import {
  CONFIG, SCHEMA, SECTIONS, COLUMN_LAYOUT, FIELD_LABELS, ROW_FIELDS,
} from './test-data.js';
import { reportFileName, reportRemotePath, reportLocalPath } from './file-naming.js';
import { prepareData, getBatchContext } from './file-generator.js';

const execAsync = promisify(exec);

// ============ HELPER FUNCTIONS ============
function log(message, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`, Object.keys(data).length ? data : '');
}

// ============ SAVE TEST RESULTS - same template as OLSDB024 ============
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
// -batch -hostkey are required, not just cosmetic (see AGENTS.md section 4.4)
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
// confused with the case where the batch completed but produced no output.
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
    throw new Error(`[${testCase}] Batch ${CONFIG.batch.command} could not run: ${error.message}`);
  }
}

async function getRemoteFileStamp(filePath, testCase) {
  try {
    const { stdout } = await executeCustomCommand(
      `stat -c '%Y %s' ${filePath} 2>/dev/null || echo MISSING`,
      testCase
    );
    return stdout.trim();
  } catch (error) {
    return 'MISSING';
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

// Detect a newly generated report by comparing fingerprints (mtime + size) before and after
// running the batch so a file from an earlier run is not mistaken for the current run.
async function waitForFreshReport(filePath, previousStamp, testCase, timeout = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const stamp = await getRemoteFileStamp(filePath, testCase);
    if (stamp !== 'MISSING' && stamp !== previousStamp) {
      log(`[${testCase}] ✅ Report moi: ${filePath} (${stamp})`);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(
    `[${testCase}] No new ${filePath} was generated after ${timeout / 1000}s.\n` +
    `Folder content:\n${await listRemoteDir(CONFIG.report.remoteDir, testCase)}`
  );
}

// Download the report to the local machine (WinSCP get) while preserving the original
// byte content and CRLF layout of the file on the server.
async function downloadReport(batchDateYmd, testCase) {
  fs.ensureDirSync(CONFIG.report.localDir);

  const fileName = reportFileName(batchDateYmd);
  const localFile = reportLocalPath(batchDateYmd);

  const command = `"${CONFIG.winscp.path}" /command ` +
    `"option batch abort" ` +
    `"option confirm off" ` +
    `"option transfer binary" ` +
    `"open sftp://${CONFIG.winscp.username}:${CONFIG.winscp.password}@${CONFIG.winscp.host}/" ` +
    `"cd ${CONFIG.report.remoteDir}" ` +
    `"get ""${fileName}"" ""${localFile}""" ` +
    `"exit"`;

  await execAsync(command, { timeout: 120000, maxBuffer: 1024 * 1024 * 10 });
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

// Ghep Chain Id & Name theo mapping:
//   <bang>.branch_id -> branch.branch_id -> branch.establishment_id -> establishment
const CHAIN_JOIN = `
  LEFT JOIN ${SCHEMA}.branch b        ON b.branch_id = t.branch_id
  LEFT JOIN ${SCHEMA}.establishment e ON e.establishment_id = b.establishment_id`;

const CHAIN_COLUMNS = `
  b.establishment_id             AS chain_id,
  e.establishment_name_english_1 AS chain_name`;

function selectColumns(section) {
  return section.key === 'adjustment'
    ? `t.txn_date, t.txn_time, t.batch_id, t.prod_acct_nbr,
       t.prod_acct_level, t.prod_acct_type, t.acct_curr_code,
       t.txn_code, t.txn_sign, t.txn_amt, t.branch_id,
       t.error_code, t.error_message,`
    : `t.pool_id, t.txn_datetime, t.batch_id, t.product_account_no,
       t.product_account_level, t.product_account_type, t.product_code,
       t.balance, t.branch_id, t.error_code, t.error_message,`;
}

// Sort Sequence theo spec: Chain Id, Date/Time of transaction, Batch Id
// (section forfeit co them break key Pool ID - Group By: Pool ID + Chain ID)
function orderBy(section) {
  return section.key === 'adjustment'
    ? 'b.establishment_id, t.txn_date, t.txn_time, t.batch_id'
    : 't.pool_id, b.establishment_id, t.txn_datetime, t.batch_id';
}

// Cua so thoi gian dung chung: > windowStart VA <= windowEnd
function sectionWhere(section) {
  return `${section.filter}
    AND ${section.txnExpr} >  $1::timestamp
    AND ${section.txnExpr} <= $2::timestamp`;
}

async function fetchSectionRows(section, ctx, testCase) {
  const sql = `SELECT ${selectColumns(section)} ${CHAIN_COLUMNS}
    FROM ${SCHEMA}.${section.table} t
    ${CHAIN_JOIN}
    WHERE ${sectionWhere(section)}
    ORDER BY ${orderBy(section)}`;

  return executeDbQuery(sql, [ctx.windowStart, ctx.windowEnd], testCase);
}

// ============ FIELD MAPPING (DB -> gia tri tren report) ============
function toNumber(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (typeof value === 'number') return value;
  return Number(String(value).trim().replace(/[,\s]/g, ''));
}

// So sanh so: bo dau phan cach nghin, cho phep sai lech 0.001
// (report in '100.5' trong khi DB tra ve 100.50 van phai khop)
function sameNumber(a, b) {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return false;
  return Math.abs(na - nb) < 0.001;
}

function formatNumber(value) {
  const n = toNumber(value);
  if (Number.isNaN(n)) return '';
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

const pad2 = (n) => String(n).padStart(2, '0');

// node-postgres tra ve Date cho kieu date/timestamp; doc lai bang gio local nen
// round-trip dung voi kieu timestamp (khong timezone) - kieu dang dung o cac bang TEMP_*.
function formatDate(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    return `${pad2(value.getDate())}-${pad2(value.getMonth() + 1)}-${value.getFullYear()}`;
  }

  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (m) return s.slice(0, 10);
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return s;
}

function formatTime(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    return `${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}`;
  }

  const s = String(value).trim();
  let m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return `${pad2(m[1])}:${m[2]}:${m[3] || '00'}`;
  m = s.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}:${m[2]}:${m[3]}`;
  return s;
}

// Account Type = ghep cac phan theo mapping, bo qua phan null/rong
function joinParts(...parts) {
  return parts
    .map((p) => (p === null || p === undefined ? '' : String(p).trim()))
    .filter((p) => p !== '')
    .join(' ');
}

function errorText(code, message) {
  const c = code === null || code === undefined ? '' : String(code).trim();
  const msg = message === null || message === undefined ? '' : String(message).trim();
  if (!c) return msg;
  if (!msg) return c;
  return `${c} - ${msg}`;
}

// Cot T: section 1 lay tu txn_sign, 6 section forfeit la hang so '-'
function signFor(section, dbRow) {
  if (section.key !== 'adjustment') return '-';
  const raw = dbRow.txn_sign === null || dbRow.txn_sign === undefined ? '' : String(dbRow.txn_sign).trim();
  if (raw === '1') return '+';
  if (raw === '0') return '-';
  return raw; // gia tri khac => de nguyen cho buoc so sanh bao mismatch
}

function expectedRowFor(section, dbRow, ctx) {
  const isAdjustment = section.key === 'adjustment';

  return {
    chainId: dbRow.chain_id === null || dbRow.chain_id === undefined ? '' : String(dbRow.chain_id).trim(),
    chainName: String(dbRow.chain_name || '').trim(),
    poolId: isAdjustment
      ? null
      : (dbRow.pool_id === null || dbRow.pool_id === undefined ? '' : String(dbRow.pool_id).trim()),
    txnDate: formatDate(isAdjustment ? dbRow.txn_date : dbRow.txn_datetime),
    txnTime: isAdjustment
      ? formatTime(dbRow.txn_time)
      : (section.printsTime ? formatTime(dbRow.txn_datetime) : ''),
    batchId: dbRow.batch_id === null || dbRow.batch_id === undefined ? '' : String(dbRow.batch_id).trim(),
    prodAcctNbr: String(dbRow.prod_acct_nbr ?? dbRow.product_account_no ?? '').trim(),
    accountType: isAdjustment
      ? joinParts(dbRow.prod_acct_level, dbRow.prod_acct_type, dbRow.acct_curr_code)
      : joinParts(dbRow.product_account_level, dbRow.product_account_type, dbRow.product_code),
    txnCode: isAdjustment
      ? String(dbRow.txn_code || '').trim()
      : String(ctx.forfeitTranCode || '').trim(),
    t: signFor(section, dbRow),
    points: isAdjustment ? formatNumber(toNumber(dbRow.txn_amt) / 100) : formatNumber(dbRow.balance),
    storeId: dbRow.branch_id === null || dbRow.branch_id === undefined ? '' : String(dbRow.branch_id).trim(),
    error: errorText(dbRow.error_code, dbRow.error_message),
  };
}

// Nhom theo (Pool ID, Chain ID) dung thu tu report in ra
function buildExpectedGroups(section, dbRows, ctx) {
  const groups = [];
  let current = null;

  for (const dbRow of dbRows) {
    const row = expectedRowFor(section, dbRow, ctx);
    const key = `${row.poolId ?? ''}|${row.chainId}`;

    if (!current || current.key !== key) {
      current = {
        key,
        poolId: row.poolId,
        chainId: row.chainId,
        chainName: row.chainName,
        rows: [],
      };
      groups.push(current);
    }
    current.rows.push(row);
  }
  return groups;
}

// ============ REPORT PARSER ============
const SEPARATOR_RE = /^=+\s*$/;
const TOTAL_FAILED_RE = /^\s*Total Failed Records:\s*(-?[\d.,]+)\s*$/;
const TOTAL_POINTS_RE = /^\s*Total Points Adjusted:\s*(-?[\d.,]+)\s*$/;
const END_OF_REPORT_RE = /END OF REPORT/;
const COLUMN_HEADER_RE = /Error Code & Message/;
// Header lap lai khi report sang trang - bo qua, khong tinh la dong la
const PAGE_HEADER_RE = /OCBC CARD CENTRE|POINT ADJUSTMENT EXCEPTION REPORT|Batch Date:|Report Date:|Report Run Date:|PROC DATE|TIME OF REPORT|PAGE:/;

const GAP = '(?:\\s{2,}|\\t)';
const POOL_RE = new RegExp(`^\\s*Pool ID\\s*:\\s*(.*?)${GAP}Pool Name\\s*:\\s*(.*?)\\s*$`);
const CHAIN_RE = new RegExp(`^\\s*Chain ID\\s*:\\s*(.*?)${GAP}Chain Name\\s*:\\s*(.*?)\\s*$`);

// Dong detail luon bat dau bang ngay DD-MM-YYYY (section 1 in them HH:MM:SS)
const ROW_START_RE = /^\s*\d{2}-\d{2}-\d{4}(\s+\d{2}:\d{2}:\d{2})?/;

// Fallback khi doc theo vi tri cot khong dung (dev doi do rong in)
const ROW_FALLBACK_RE =
  /^\s*(\d{2}-\d{2}-\d{4})(?:\s+(\d{2}:\d{2}:\d{2}))?\s+(\S+)\s+(.*?)\s+([+-])\s+(-?[\d.,]+)\s+(\S+)\s+(\S.*?)\s*$/;

const ERROR_COLUMN_START = COLUMN_LAYOUT.error[0];

function parseHeader(text) {
  const pick = (re) => {
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };

  return {
    reportId: pick(/Report ID:\s*(\S+)/),
    titleFound: /POINT ADJUSTMENT EXCEPTION REPORT/.test(text),
    // Format moi (ISTOR ready): Report Run Date / Report Date
    runDate: pick(/Report Run Date:\s*(\d{8})/),
    reportDate: pick(/Report Date:\s*(\d{8})/),
    // Format cu (build 2025): PROC DATE / Batch Date
    procDate: pick(/PROC DATE\s*:\s*([\d/]+)/),
    batchDate: pick(/Batch Date:\s*(\d{8})/),
    page: pick(/PAGE:\s*(\d+)/),
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
    txnCode: cut('txnCode'),
    t: cut('t'),
    points: cut('points'),
    storeId: cut('storeId'),
    error: cut('error'),
  };
}

function looksSane(f) {
  return Boolean(
    f.txnDate && f.batchId &&
    /^[+\-]$/.test(f.t) &&
    /^-?[\d.,]+$/.test(f.points) &&
    /^[A-Za-z0-9]/.test(f.error) &&
    /^[A-Za-z0-9]/.test(f.storeId)
  );
}

// Fallback: tach theo token. Phan giua (sau Batch Id, truoc T) gom toi da 3 cot co the
// trong: Product Account Nbr | Account Type | Txn Code.
function parseRowByTokens(line) {
  const m = line.match(ROW_FALLBACK_RE);
  if (!m) return null;

  const [, txnDate, txnTime, batchId, mid, t, points, storeId, error] = m;
  const parts = mid.split(/\s{2,}|\t/).map((p) => p.trim()).filter(Boolean);

  let prodAcctNbr = '';
  let accountType = '';
  let txnCode = '';

  if (parts.length >= 3) {
    [prodAcctNbr, accountType, txnCode] = parts.slice(-3);
  } else if (parts.length === 2) {
    if (/^\d+$/.test(parts[0])) [prodAcctNbr, txnCode] = parts;
    else [accountType, txnCode] = parts;
  } else if (parts.length === 1) {
    if (/^\d+$/.test(parts[0])) txnCode = parts[0];
    else accountType = parts[0];
  }

  return { txnDate, txnTime: txnTime || '', batchId, prodAcctNbr, accountType, txnCode, t, points, storeId, error };
}

function parseRow(line, warnings) {
  const sliced = sliceByLayout(line);
  if (looksSane(sliced)) return sliced;

  const fallback = parseRowByTokens(line);
  if (fallback) {
    warnings.push(`Doc theo vi tri cot that bai, dung fallback token: "${line.trim().slice(0, 100)}"`);
    return fallback;
  }

  warnings.push(`Khong doc duoc dong detail: "${line.trim().slice(0, 100)}"`);
  return sliced;
}

function newGroup(section, pool) {
  return {
    poolId: pool ? pool.poolId : null,
    poolName: pool ? pool.poolName : null,
    chainId: null,
    chainName: null,
    rows: [],
    totals: { failedRecords: null, pointsAdjusted: null },
    sectionKey: section.key,
    title: section.title,
  };
}

function parseReport(text) {
  const warnings = [];
  const lines = text.split(/\r?\n/);
  const header = parseHeader(text);

  const sections = {};
  for (const s of SECTIONS) sections[s.key] = { key: s.key, title: s.title, groups: [], found: false };

  let currentSection = null;
  let currentGroup = null;
  let lastRow = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (END_OF_REPORT_RE.test(trimmed)) break;
    if (!trimmed) { lastRow = null; continue; }
    if (SEPARATOR_RE.test(trimmed)) { lastRow = null; continue; }
    if (PAGE_HEADER_RE.test(trimmed)) { lastRow = null; continue; }

    // ---- section title ----
    const section = SECTIONS.find((s) => s.titleRegex.test(trimmed));
    if (section) {
      currentSection = section;
      sections[section.key].found = true;
      currentGroup = null;
      lastRow = null;
      continue;
    }

    if (!currentSection) continue;
    const bucket = sections[currentSection.key];

    if (COLUMN_HEADER_RE.test(trimmed)) { lastRow = null; continue; }

    // ---- trailer ----
    let m = trimmed.match(TOTAL_FAILED_RE);
    if (m) {
      if (!currentGroup) { currentGroup = newGroup(currentSection, null); bucket.groups.push(currentGroup); }
      currentGroup.totals.failedRecords = m[1];
      lastRow = null;
      continue;
    }
    m = trimmed.match(TOTAL_POINTS_RE);
    if (m) {
      if (!currentGroup) { currentGroup = newGroup(currentSection, null); bucket.groups.push(currentGroup); }
      currentGroup.totals.pointsAdjusted = m[1];
      lastRow = null;
      continue;
    }

    // ---- header nhom ----
    m = trimmed.match(POOL_RE);
    if (m) {
      currentGroup = newGroup(currentSection, { poolId: m[1].trim(), poolName: m[2].trim() });
      bucket.groups.push(currentGroup);
      lastRow = null;
      continue;
    }
    m = trimmed.match(CHAIN_RE);
    if (m) {
      const pool = currentGroup ? { poolId: currentGroup.poolId, poolName: currentGroup.poolName } : null;
      if (!currentGroup || currentGroup.chainId) {
        currentGroup = newGroup(currentSection, pool);
        bucket.groups.push(currentGroup);
      }
      currentGroup.chainId = m[1].trim();
      currentGroup.chainName = m[2].trim();
      lastRow = null;
      continue;
    }

    // ---- dong detail ----
    if (ROW_START_RE.test(line)) {
      const row = parseRow(line, warnings);
      if (!currentGroup) { currentGroup = newGroup(currentSection, null); bucket.groups.push(currentGroup); }
      currentGroup.rows.push(row);
      lastRow = row;
      continue;
    }

    // ---- dong tiep noi cua Error Message (bi wrap sang dong duoi) ----
    if (lastRow && line.length > ERROR_COLUMN_START && !line.slice(0, ERROR_COLUMN_START).trim()) {
      lastRow.error = `${lastRow.error} ${trimmed}`.trim();
      continue;
    }

    warnings.push(`Dong khong nhan dang duoc (line ${i + 1}): "${trimmed.slice(0, 100)}"`);
  }

  return { header, sections, warnings };
}

// ============ SO SANH ============
function normalizeText(value) {
  return String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
}

function fieldMatches(field, actual, expected) {
  if (field === 'points') return sameNumber(actual, expected);
  // Report cu chi in ngay cho 6 section forfeit => khong in gio thi bo qua field nay
  if (field === 'txnTime' && normalizeText(actual) === '') return true;
  return normalizeText(actual) === normalizeText(expected);
}

function recordIdOf(row) {
  return [row.chainId, normalizeText(`${row.txnDate} ${row.txnTime}`), row.batchId, row.prodAcctNbr]
    .filter((p) => p !== null && p !== undefined && String(p) !== '')
    .join(' | ');
}

// Log dung format yeu cau: Record / Field / Expected / Actual
function logMismatch(mismatch) {
  log('[FAIL]');
  log(`  Record: ${mismatch.recordId}`);
  log(`  Field: ${FIELD_LABELS[mismatch.field] || mismatch.field}`);
  log(`  Expected (DB): ${mismatch.expected}`);
  log(`  Actual (report): ${mismatch.actual}`);
  log(`  Section: ${mismatch.sectionTitle}`);
  if (mismatch.group) log(`  Group: ${mismatch.group}`);
}

function groupLabel(group) {
  const parts = [];
  if (group.poolId !== null && group.poolId !== undefined && group.poolId !== '') parts.push(`Pool ${group.poolId}`);
  parts.push(`Chain ${group.chainId || '(rong)'}`);
  return parts.join(' / ');
}

// Tong diem cua nhom: cong theo dau T (report that: forfeit ra so am, vd -300)
function expectedPointsTotal(rows) {
  return rows.reduce((acc, r) => {
    const n = toNumber(r.points);
    if (Number.isNaN(n)) return acc;
    return acc + (r.t === '-' ? -n : n);
  }, 0);
}

function compareSection(section, actualAst, expectedGroups) {
  const mismatches = [];
  const issues = [];
  let fieldsChecked = 0;
  let matchedFields = 0;

  const actualGroups = actualAst ? actualAst.groups : [];
  const actualRecords = actualGroups.reduce((n, g) => n + g.rows.length, 0);
  const expectedRecords = expectedGroups.reduce((n, g) => n + g.rows.length, 0);

  if (actualGroups.length !== expectedGroups.length) {
    issues.push(`So nhom (Pool/Chain) khong khop: report = ${actualGroups.length}, DB = ${expectedGroups.length}`);
  }

  for (let gi = 0; gi < Math.max(actualGroups.length, expectedGroups.length); gi += 1) {
    const actual = actualGroups[gi];
    const expected = expectedGroups[gi];

    if (!actual || !expected) {
      issues.push(`Thieu nhom thu ${gi + 1} o ${actual ? 'DB' : 'report'}`);
      continue;
    }

    const headerChecks = [
      ['CHAIN_ID', actual.chainId || '', expected.chainId || ''],
      ['CHAIN_NAME', actual.chainName || '', expected.chainName || ''],
    ];
    if (section.poolHeader) headerChecks.push(['POOL_ID', actual.poolId || '', expected.poolId || '']);

    for (const [field, act, exp] of headerChecks) {
      fieldsChecked += 1;
      if (normalizeText(act) === normalizeText(exp)) matchedFields += 1;
      else {
        mismatches.push({
          sectionTitle: section.title,
          group: groupLabel(actual),
          recordId: '(group header)',
          field,
          expected: exp,
          actual: act,
        });
      }
    }

    if (actual.rows.length !== expected.rows.length) {
      issues.push(`${groupLabel(actual)}: so dong detail khong khop - report = ${actual.rows.length}, DB = ${expected.rows.length}`);
    }

    for (let ri = 0; ri < Math.max(actual.rows.length, expected.rows.length); ri += 1) {
      const actRow = actual.rows[ri];
      const expRow = expected.rows[ri];
      if (!actRow || !expRow) continue;

      const recordId = recordIdOf(actRow);
      for (const field of ROW_FIELDS) {
        fieldsChecked += 1;
        if (fieldMatches(field, actRow[field], expRow[field])) matchedFields += 1;
        else {
          mismatches.push({
            sectionTitle: section.title,
            group: groupLabel(actual),
            recordId,
            field,
            expected: expRow[field],
            actual: actRow[field],
          });
        }
      }
    }

    const expFailed = expected.rows.length;
    const expPoints = expectedPointsTotal(expected.rows);

    fieldsChecked += 2;
    if (sameNumber(actual.totals.failedRecords, expFailed)) matchedFields += 1;
    else {
      mismatches.push({
        sectionTitle: section.title, group: groupLabel(actual), recordId: '(total)',
        field: 'TOTAL_FAILED_RECORDS', expected: String(expFailed), actual: String(actual.totals.failedRecords),
      });
    }

    if (sameNumber(actual.totals.pointsAdjusted, expPoints)) matchedFields += 1;
    else {
      mismatches.push({
        sectionTitle: section.title, group: groupLabel(actual), recordId: '(total)',
        field: 'TOTAL_POINTS_ADJUSTED', expected: String(expPoints), actual: String(actual.totals.pointsAdjusted),
      });
    }
  }

  for (const mismatch of mismatches) logMismatch(mismatch);

  return {
    sectionKey: section.key,
    sectionTitle: section.title,
    actualRecords,
    expectedRecords,
    fieldsChecked,
    matchedFields,
    mismatchedFields: mismatches.length,
    mismatches,
    issues,
    success: mismatches.length === 0 && issues.length === 0,
  };
}

// ============ TEST SUITE ============
test.describe('OLSD133R - Point Adjustment Exception Report', () => {
  let ctx;          // batch date / cut-off / cua so thoi gian
  let parsed;       // report da parse
  let reportPath;   // file report tren may
  let seedCounts;   // so dong moi bang sau khi seed

  test.beforeAll(async () => {
    // 7 batch Java (OLSDB009 + 6 forfeit + report) => can thoi gian dai
    test.setTimeout(90 * 60 * 1000);

    // ---- 1. Doc batch date + cut-off time ----
    log('📋 Step 1: Doc batch date + cut-off time tu DB');
    ctx = await getBatchContext('PREFLIGHT');
    log(`📊 batch date = ${ctx.batchDateYmd}, cut-off = ${ctx.cutOffTime}`);
    log(`📊 cua so du lieu = ${ctx.windowStart} -> ${ctx.windowEnd}`);

    // ---- 2. Tao du lieu dau vao ----
    if (process.env.OLSDR133R_SKIP_PREPARE === '1') {
      log('📋 Step 2: Bo qua seed du lieu (OLSDR133R_SKIP_PREPARE=1)');
    } else {
      log('📋 Step 2: Seed du lieu (OLSDB009 + 6 batch forfeit)');
      const prepared = await prepareData('PREPARE');
      seedCounts = prepared.counts;
    }

    // ---- 3. Chay report ----
    const remoteReport = reportRemotePath(ctx.batchDateYmd);
    log(`📋 Step 3: Chay report OLSD133R -> ${remoteReport}`);

    if (process.env.OLSDR133R_SKIP_BATCH === '1') {
      log('⏭️ Bo qua chay batch (OLSDR133R_SKIP_BATCH=1) - dung file dang co tren server');
    } else {
      const stampBefore = await getRemoteFileStamp(remoteReport, 'REPORT');
      await executeBatch('REPORT');
      await waitForFreshReport(remoteReport, stampBefore, 'REPORT');
    }

    // ---- 4. Tai report ve + parse ----
    log('📋 Step 4: Tai report ve may va parse');
    reportPath = await downloadReport(ctx.batchDateYmd, 'REPORT');
    parsed = parseReport(fs.readFileSync(reportPath, 'utf8'));

    if (parsed.warnings.length) {
      log(`⚠️ Parser co ${parsed.warnings.length} canh bao:`);
      for (const w of parsed.warnings) log(`   - ${w}`);
    }
  });

  test('TC01: Cau truc report (header + 7 section + END OF REPORT)', async () => {
    const issues = [];

    if (!parsed.header.titleFound) issues.push('Thieu dong tieu de "POINT ADJUSTMENT EXCEPTION REPORT"');
    if (!parsed.header.hasEndOfReport) issues.push('Thieu dong "*** END OF REPORT ***"');

    const missing = SECTIONS.filter((s) => !parsed.sections[s.key].found);
    if (missing.length) issues.push(`Thieu section: ${missing.map((s) => s.title).join('; ')}`);

    // Batch date tren report phai khop batch date trong DB.
    // Build 2026 in 'Report Date: ddmmyyyy'; build 2025 in 'Batch Date: yyyymmdd'.
    const rawDate = parsed.header.reportDate || parsed.header.batchDate;
    const reportBatchDate = rawDate
      ? (parsed.header.reportDate
        ? `${rawDate.slice(4)}${rawDate.slice(2, 4)}${rawDate.slice(0, 2)}`
        : rawDate)
      : null;

    if (!reportBatchDate) issues.push('Khong doc duoc Report Date / Batch Date tren report');
    else if (reportBatchDate !== ctx.batchDateYmd) {
      issues.push(`Batch date tren report (${reportBatchDate}) khac DB (${ctx.batchDateYmd})`);
    }

    if (issues.length) log(`❌ TC01: ${issues.join(' | ')}`);

    await saveTestResults('TC01-STRUCTURE', {
      success: issues.length === 0,
      totalRecords: SECTIONS.length,
      trueCount: SECTIONS.length - missing.length,
      falseCount: issues.length,
      details: issues,
    }, { start: 1, end: 1 });

    expect(issues, `Cau truc report sai:\n${issues.join('\n')}`).toEqual([]);
  });

  // Moi section 1 test: lay du lieu DB -> so sanh voi report -> in [FAIL] tung field
  const sectionCases = [
    ['TC02', 'adjustment'],
    ['TC03', 'expired'],
    ['TC04', 'blockCode'],
    ['TC05', 'accountStatus'],
    ['TC06', 'customerStatus'],
    ['TC07', 'loyaltyAccountStatus'],
    ['TC08', 'customerAccountDeletion'],
  ];

  for (const [tcId, sectionKey] of sectionCases) {
    const section = SECTIONS.find((s) => s.key === sectionKey);

    test(`${tcId}: ${section.title} - DB vs report`, async () => {
      const started = Date.now();

      const dbRows = await fetchSectionRows(section, ctx, tcId);
      const expectedGroups = buildExpectedGroups(section, dbRows, ctx);
      const result = compareSection(section, parsed.sections[section.key], expectedGroups);

      const seedNote = seedCounts ? ` (seed: ${seedCounts[section.key] ?? 'n/a'} dong)` : '';
      log(
        `📊 [${tcId}] ${section.title}${seedNote}: report = ${result.actualRecords} dong, ` +
        `DB = ${result.expectedRecords} dong, field lech = ${result.mismatchedFields}`
      );
      for (const issue of result.issues) log(`⚠️ [${tcId}] ${issue}`);

      await saveTestResults(tcId, {
        success: result.success,
        totalRecords: result.actualRecords,
        trueCount: result.matchedFields,
        falseCount: result.mismatchedFields,
        details: result.mismatches,
      }, { start: 1, end: 1 }, Date.now() - started);

      expect(
        result.success,
        `${section.title}: ${result.mismatchedFields} field lech, ${result.issues.length} van de ve so luong/nhom`
      ).toBe(true);
    });
  }
});
