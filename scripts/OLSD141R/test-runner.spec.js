// scripts/OLSD141R/test-runner.spec.js
// Batch   : OLSDR141  ->  report OLSD141R "CIF Merge File Report"
// Host    : 192.168.99.83 (MY-dev), DB ols_my / schema ols_schema
//
// Same 4-file pattern as OLSDB024 / OLSD133R / OLSD134R:
//   test-data.js        : CONFIG + expected query + fixed-width column positions
//   file-naming.js      : naming for the report file and the OLSMECIF seed file
//   file-generator.js   : seed data (OLSMECIF -> OLSDB057 -> DWH_TEMP_CIF_MERGE)
//   test-runner.spec.js : run the report batch, download + parse the report, compare with DB
//
// Flow:
//   1 PREPARE : OLSMECIF -> upload -> ./OLSDB057
//   2 CHECK   : DWH_TEMP_CIF_MERGE rows of that job_id
//   3 RUN     : ./OLSDR141 -> MYOLSD141R<batch date>.txt
//   4 LOAD    : download to reports\OLSD141R\ and parse
//   5 VERIFY  : query by job_id -> compare -> log [FAIL]
//
// Environment flags:
//   OLSD141R_SKIP_PREPARE=1  skip seeding (reuse existing DB data)
//   OLSD141R_SKIP_BATCH=1    do not rerun OLSDR141; reuse the report already on the server
//   OLSD141R_JOB_ID=...      use a specific job_id instead of discovering the newest one

import { test, expect } from '@playwright/test';
import fs from 'fs-extra';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import pg from 'pg';
import {
  CONFIG, SCHEMA, REPORT_ID, TITLE_RE, INDICATOR_DESC, COLUMN_LAYOUT, ROW_LENGTH,
  FIELD_LABELS, ROW_FIELDS,
} from './test-data.js';
import {
  reportFileName, reportFileGlob, reportLocalPathForName, parseReportFileName,
} from './file-naming.js';
import {
  prepareData, getBatchContext, fetchExpectedRows, resolveJobId,
} from './file-generator.js';

const execAsync = promisify(exec);

// ============ DASHBOARD DATA ============
const STEP_LEGEND = [
  ['1', 'Build OLSMECIF input file'],
  ['2', 'Upload file to SFTP (WinSCP)'],
  ['3', 'Run OLSDB057'],
  ['4', 'Wait for OLSDB057 to complete'],
  ['5', 'Wait for OLSDB057 output files'],
  ['6', 'Check DWH_TEMP_CIF_MERGE rows of this run'],
  ['10', 'Run OLSDR141'],
  ['11', 'Wait for OLSD141R report file'],
  ['12', 'Download report to local'],
  ['13', 'Parse report'],
  ['14', 'Compare report vs DB'],
];

const steps = [];
const testCaseResults = [];
const runContext = { batchDateYmd: null, jobId: null };
let comparison = null;
let headerCheck = null;

function addStep(no, name, ok, note = '') {
  steps.push({ no: String(no), name, ok: Boolean(ok), note });
  log(`[STEP ${no}] ${ok ? '✅' : '❌'} ${name}${note ? ' — ' + note : ''}`);
}

// ============ HELPERS ============
function log(message, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`, Object.keys(data).length ? data : '');
}

// child_process errors may include the full command, including -pw <password>.
function maskSecret(text) {
  let out = String(text ?? '');
  for (const secret of [CONFIG.putty.password, CONFIG.winscp.password]) {
    if (secret && secret.length >= 3) out = out.split(secret).join('****');
  }
  return out;
}

// ============ SAVE TEST RESULTS (same template as OLSDB024 / OLSD133R / OLSD134R) ============
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

    const tracker = fs.existsSync(EXECUTION_TRACKER_PATH)
      ? JSON.parse(fs.readFileSync(EXECUTION_TRACKER_PATH, 'utf8'))
      : { executionId: Date.now().toString(), testCases: [] };

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
// -batch and -hostkey are required, otherwise plink hangs at the host key prompt (AGENTS.md 4.4).
function plinkCommand(remoteCommand) {
  return `"${CONFIG.putty.path}" -batch ` +
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

/** Run the report batch. Throws if the command cannot run, so it is not mixed up with an empty report. */
async function executeBatch(testCase) {
  const command = `cd ${CONFIG.batch.scriptPath} && ${CONFIG.batch.command}`;
  log(`[${testCase}] Run batch: ${command}`);

  try {
    const { stdout, stderr } = await execAsync(plinkCommand(command), {
      timeout: CONFIG.batch.timeout,
      maxBuffer: 1024 * 1024 * 10,
    });
    log(`[${testCase}] ✅ Batch finished`);
    return { success: true, stdout, stderr };
  } catch (error) {
    throw new Error(`[${testCase}] Batch ${CONFIG.batch.command} could not run: ` +
      `${maskSecret(error.message)}`);
  }
}

/**
 * Reports of one batch date on the server.
 * signature = name|mtime|size identifies the file that was just regenerated, independently of
 * the MY/ID naming variant.
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
        const name = parts[parts.length - 1].split('/').pop();
        return {
          name,
          size: Number(parts[parts.length - 3]) || 0,
          mtime: Number(parts[parts.length - 2]) || 0,
          signature: `${name}|${parts[parts.length - 2]}|${parts[parts.length - 3]}`,
        };
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

/** Wait until a report file appears that was not there before the batch run. */
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

/** Download the report with WinSCP (binary, to keep the CRLF layout of the server file). */
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

// ============ DATABASE ============
async function executeDbQuery(query, params = [], testCase = 'DB') {
  const client = new pg.Client({
    host: CONFIG.database.host,
    port: CONFIG.database.port,
    user: CONFIG.database.username,
    password: CONFIG.database.password,
    database: CONFIG.database.database,
  });
  await client.connect();
  try {
    const result = await client.query(query, params);
    return result.rows;
  } catch (error) {
    throw new Error(`[${testCase}] DB query failed: ${error.message}\nSQL: ${query.trim()}`);
  } finally {
    await client.end();
  }
}

// ============ REPORT PARSER ============
const SEPARATOR_RE = /^=+\s*$/;
const END_OF_REPORT_RE = /END OF REPORT/;
const COLUMN_HEADER_RE = /CIF#\s*A\b/;
// Page headers repeat on every page - never treat them as detail rows.
const PAGE_HEADER_RE = new RegExp(
  [REPORT_ID, 'CIF MERGE FILE REPORT', 'FILE DATE', 'PROC DATE', 'BATCH DATE',
    'TIME OF REPORT', 'PAGE:', 'File Name:', 'OCBC CARD CENTRE'].join('|'), 'i'
);

const FILE_DATE_RE = /FILE DATE\s*:\s*(\d{2}\/\d{2}\/\d{4})(?:\s+(\d{2}:\d{2}:\d{2}))?/i;
const PROC_DATE_RE = /PROC DATE\s*:\s*(\d{2}\/\d{2}\/\d{4})(?:\s+(\d{2}:\d{2}:\d{2}))?/i;
const BATCH_DATE_RE = /BATCH DATE\s*:\s*(\d{8})/i;           // 2020 build
const TIME_OF_REPORT_RE = /TIME OF REPORT\s*:\s*([\d:]+)/i;   // 2020 build
const PAGE_RE = /PAGE\s*:\s*(\d+)/i;
const FILE_NAME_RE = /File Name\s*:\s*(\S+)/i;
const TOTAL_ACCEPTED_RE = /Total number of records accepted\s*:?\s*(-?[\d.,]+)/i;
const TOTAL_REJECTED_RE = /Total number of records rejected\s*:\s*(-?[\d.,]+)/i;

function parseHeader(text) {
  const pick = (re, group = 1) => {
    const m = text.match(re);
    return m ? String(m[group]).trim() : null;
  };
  const idMatch = text.match(new RegExp(`(${REPORT_ID})`, 'i'));

  return {
    reportId: idMatch ? idMatch[1] : null,
    titleFound: TITLE_RE.test(text),
    // 2025 build: FILE DATE / PROC DATE (dd/mm/yyyy hh:mm:ss)
    fileDate: pick(FILE_DATE_RE),
    fileTime: pick(FILE_DATE_RE, 2),
    procDate: pick(PROC_DATE_RE),
    procTime: pick(PROC_DATE_RE, 2),
    // 2020 build: BATCH DATE yyyymmdd + TIME OF REPORT
    batchDate: pick(BATCH_DATE_RE),
    timeOfReport: pick(TIME_OF_REPORT_RE),
    page: pick(PAGE_RE),
    fileName: pick(FILE_NAME_RE),
    hasEndOfReport: END_OF_REPORT_RE.test(text),
  };
}

function sliceByLayout(line) {
  const padded = String(line).padEnd(ROW_LENGTH, ' ');
  const cut = (key) => padded.slice(COLUMN_LAYOUT[key][0], COLUMN_LAYOUT[key][1]).trim();

  return {
    cifA: cut('cifA'),
    name1A: cut('name1A'),
    name2A: cut('name2A'),
    cifB: cut('cifB'),
    name1B: cut('name1B'),
    name2B: cut('name2B'),
    indicator: cut('indicator'),
    errorDesc: cut('errorDesc'),
    errorCode: cut('errorCode'),
    errorMessage: cut('errorMessage'),
  };
}

const KNOWN_DESCRIPTIONS = Object.values(INDICATOR_DESC);

function looksSane(f) {
  return Boolean(
    f.cifA &&
    /^[NYZ]$/i.test(f.indicator) &&
    (f.errorDesc === '' || KNOWN_DESCRIPTIONS.some((d) => d.toLowerCase() === f.errorDesc.toLowerCase()))
  );
}

// Fallback when the fixed-width positions no longer match the printed width: columns are always
// separated by at least 2 spaces.
function parseRowByTokens(line) {
  const parts = String(line).trim().split(/\s{2,}|\t/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const descIdx = parts.findIndex((p, i) => i > 0 && KNOWN_DESCRIPTIONS.some(
    (d) => d.toLowerCase() === p.toLowerCase()
  ));
  if (descIdx <= 0) return null;

  const before = parts.slice(0, descIdx);
  const head = before.slice(0, -1);
  const row = {
    cifA: head[0] || '',
    name1A: head[1] || '',
    name2A: head[2] || '',
    cifB: head[3] || '',
    name1B: head[4] || '',
    name2B: head[5] || '',
    indicator: before[before.length - 1] || '',
    errorDesc: parts[descIdx],
    errorCode: parts[descIdx + 1] || '',
    errorMessage: parts.slice(descIdx + 2).join(' '),
  };
  return /^[NYZ]$/i.test(row.indicator) ? row : null;
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

/** A detail row always carries a Successful Indicator (Y/N/Z). */
function isDetailRow(line) {
  return line.length >= 60 && looksSane(sliceByLayout(line));
}

function parseReport(text) {
  const warnings = [];
  const lines = text.split(/\r?\n/);
  const header = parseHeader(text);
  const rows = [];
  const totals = { accepted: null, rejected: null };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (END_OF_REPORT_RE.test(trimmed)) break;
    if (!trimmed || SEPARATOR_RE.test(trimmed)) continue;
    if (PAGE_HEADER_RE.test(trimmed) || COLUMN_HEADER_RE.test(trimmed)) continue;

    let m = trimmed.match(TOTAL_ACCEPTED_RE);
    if (m) {
      totals.accepted = m[1];
      continue;
    }
    m = trimmed.match(TOTAL_REJECTED_RE);
    if (m) {
      totals.rejected = m[1];
      continue;
    }

    if (isDetailRow(line)) {
      rows.push(parseRow(line, warnings));
      continue;
    }

    warnings.push(`Unrecognized line (line ${i + 1}): "${trimmed.slice(0, 100)}"`);
  }

  return { header, rows, totals, warnings };
}

// ============ COMPARISON ============
function normalizeText(value) {
  return String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
}

function sameNumber(a, b) {
  const na = Number(String(a === null || a === undefined ? '' : a).replace(/[,\s]/g, ''));
  const nb = Number(String(b === null || b === undefined ? '' : b).replace(/[,\s]/g, ''));
  if (Number.isNaN(na) || Number.isNaN(nb)) return normalizeText(a) === normalizeText(b);
  return Math.abs(na - nb) < 0.001;
}

// All OLSD141R fields are text (CIF numbers are 19-digit strings, not quantities).
function fieldMatches(actual, expected) {
  return normalizeText(actual) === normalizeText(expected);
}

/** Trace key of one record: CIF# A + CIF# B (the report sort key). */
function recordIdOf(row) {
  return row.cifB
    ? `CIF# A ${row.cifA || '(blank)'} | CIF# B ${row.cifB}`
    : `CIF# A ${row.cifA || '(blank)'}`;
}

function logMismatch(mismatch) {
  log('[FAIL]');
  log(`  Record: ${mismatch.recordId}`);
  log(`  Field: ${FIELD_LABELS[mismatch.field] || mismatch.field}`);
  log(`  Expected (DB): ${mismatch.expected}`);
  log(`  Actual (report): ${mismatch.actual}`);
}

function rowSortKey(row) {
  return `${normalizeText(row.cifA)}|${normalizeText(row.cifB)}`;
}

/**
 * Compare report rows with the DWH_TEMP_CIF_MERGE rows of the run. The report is sorted by CIF#
 * and the query is ordered by cif_nbr_a, cif_nbr_b, so both lists are compared position by position.
 */
function compareRows(actualRows, expectedRows) {
  const mismatches = [];
  const issues = [];
  const notes = [];

  if (actualRows.length !== expectedRows.length) {
    issues.push(`Detail row count differs: report = ${actualRows.length}, DB = ${expectedRows.length}`);
  }

  for (let i = 0; i < Math.max(actualRows.length, expectedRows.length); i += 1) {
    const actual = actualRows[i];
    const expected = expectedRows[i];

    if (!actual || !expected) {
      const missing = expected ? recordIdOf(expected) : recordIdOf(actual);
      issues.push(expected
        ? `Missing row ${i + 1} on the report: DB has ${missing}`
        : `Extra row ${i + 1} on the report: not in DB (${missing})`);
      mismatches.push({
        recordId: missing,
        field: expected ? '(missing row on report)' : '(extra row on report)',
        expected: expected ? JSON.stringify(expected) : '(none)',
        actual: expected ? '(none)' : JSON.stringify(actual),
      });
      continue;
    }

    const recordId = recordIdOf(actual);
    if (rowSortKey(actual) !== rowSortKey(expected)) {
      notes.push(`Order differs at row ${i + 1}: report = ${recordId}, DB = ${recordIdOf(expected)}`);
    }

    for (const field of ROW_FIELDS) {
      if (!fieldMatches(actual[field], expected[field])) {
        mismatches.push({ recordId, field, expected: expected[field], actual: actual[field] });
      }
    }
  }

  // Sort Sequence of the report: CIF# (ascending)
  for (let i = 1; i < actualRows.length; i += 1) {
    if (rowSortKey(actualRows[i - 1]) > rowSortKey(actualRows[i])) {
      issues.push(`Report is not sorted by CIF# at row ${i + 1}: ` +
        `${rowSortKey(actualRows[i - 1])} > ${rowSortKey(actualRows[i])}`);
    }
  }

  for (const mismatch of mismatches) logMismatch(mismatch);

  return {
    actualRecords: actualRows.length,
    expectedRecords: expectedRows.length,
    fieldsChecked: actualRows.length * ROW_FIELDS.length,
    matchedFields: (actualRows.length * ROW_FIELDS.length) - mismatches.length,
    mismatchedFields: mismatches.length,
    mismatches,
    issues,
    notes,
    success: mismatches.length === 0 && issues.length === 0,
  };
}

/** Y = accepted, N/Z = rejected. */
function countByIndicator(rows) {
  const counts = { Y: 0, N: 0, Z: 0, other: [] };
  for (const row of rows) {
    const ind = normalizeText(row.indicator).toUpperCase();
    if (ind === 'Y' || ind === 'N' || ind === 'Z') counts[ind] += 1;
    else counts.other.push(row);
  }
  return counts;
}

// ============ DASHBOARD ============
function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function rowsTable(rows, maxRows = 100) {
  if (!rows || !rows.length) return '<p class="muted">(no data)</p>';
  const keys = Object.keys(rows[0]);
  const head = keys.map((k) => `<th>${escapeHtml(k)}</th>`).join('');
  const body = rows.slice(0, maxRows).map((r) => `<tr>${keys.map(
    (k) => `<td>${escapeHtml(r[k])}</td>`
  ).join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function writeDashboard(reportPath, reportFileNameOnServer) {
  try {
    fs.ensureDirSync(CONFIG.report.localDir);
    const out = path.join(CONFIG.report.localDir, 'dashboard.html');

    const stepRows = steps.map((s) => `<tr><td>${escapeHtml(s.no)}</td>` +
      `<td>${escapeHtml(s.name)}</td>` +
      `<td class="${s.ok ? 'ok' : 'fail'}">${s.ok ? 'PASS' : 'FAIL'}</td>` +
      `<td>${escapeHtml(s.note)}</td></tr>`).join('');

    const tcRows = testCaseResults.map((t) => `<tr><td>${escapeHtml(t.id)}</td>` +
      `<td>${escapeHtml(t.label)}</td>` +
      `<td class="${t.ok ? 'ok' : 'fail'}">${t.ok ? 'PASS' : 'FAIL'}</td>` +
      `<td>${escapeHtml(t.note)}</td></tr>`).join('');

    const legendRows = STEP_LEGEND.map(([no, name]) =>
      `<tr><td>${no}</td><td>${escapeHtml(name)}</td></tr>`).join('');

    const headerCompare = headerCheck ? `
      <h2>FILE DATE vs PROC DATE</h2>
      <table><thead><tr><th>Source</th><th>Value</th><th>Date (YYYYMMDD)</th></tr></thead><tbody>
        <tr><td>FILE DATE</td><td>${escapeHtml(headerCheck.fileDate)} ${escapeHtml(headerCheck.fileTime)}</td><td>${escapeHtml(headerCheck.fileDateYmd)}</td></tr>
        <tr><td>PROC DATE</td><td>${escapeHtml(headerCheck.procDate)} ${escapeHtml(headerCheck.procTime)}</td><td>${escapeHtml(headerCheck.procDateYmd)}</td></tr>
        <tr><td>File Name (report)</td><td>${escapeHtml(headerCheck.fileName)}</td><td>${escapeHtml(headerCheck.fileNameDateYmd)}</td></tr>
        <tr><td>Batch date (DB)</td><td>${escapeHtml(headerCheck.batchDateYmd)}</td><td>${escapeHtml(headerCheck.batchDateYmd)}</td></tr>
      </tbody></table>
      <p>${escapeHtml(headerCheck.verdict)}</p>` : '';

    const compareHtml = comparison ? `
      <h2>Report vs DB (job_id = ${escapeHtml(runContext.jobId || 'n/a')})</h2>
      <p>Report rows: ${comparison.actualRecords} | DB rows: ${comparison.expectedRecords} |
         Fields checked: ${comparison.fieldsChecked} | Matched: ${comparison.matchedFields} |
         Mismatched: ${comparison.mismatchedFields}</p>
      ${comparison.issues.length ? `<ul>${comparison.issues.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''}
      ${comparison.notes.length ? `<ul>${comparison.notes.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''}
      <h3>Mismatched fields</h3>
      ${rowsTable(comparison.mismatches)}` : '';

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>OLSD141R - CIF Merge File Report</title>
<style>
  body { font-family: Consolas, monospace; background:#0f1419; color:#e6e6e6; padding:24px; }
  h1 { font-size:20px; } h2 { font-size:16px; margin-top:28px; }
  table { border-collapse: collapse; margin:8px 0 16px; font-size:12px; }
  th, td { border:1px solid #2c3a47; padding:4px 8px; text-align:left; vertical-align:top; }
  th { background:#1a2430; }
  .ok { color:#4ade80; font-weight:bold; } .fail { color:#f87171; font-weight:bold; }
  .muted { color:#8b9aa8; }
</style></head><body>
<h1>OLSD141R - CIF Merge File Report</h1>
<p>Batch date: ${escapeHtml(runContext.batchDateYmd || 'n/a')} |
   job_id: ${escapeHtml(runContext.jobId || 'n/a')} |
   Report file: ${escapeHtml(reportFileNameOnServer || 'n/a')} |
   Local copy: ${escapeHtml(reportPath || 'n/a')}</p>

<h2>Steps</h2>
<table><thead><tr><th>#</th><th>Step</th><th>Result</th><th>Note</th></tr></thead><tbody>${stepRows}</tbody></table>

<h2>Test cases</h2>
<table><thead><tr><th>ID</th><th>Check</th><th>Result</th><th>Note</th></tr></thead><tbody>${tcRows}</tbody></table>

${headerCompare}
${compareHtml}

<h2>Step legend</h2>
<table><thead><tr><th>#</th><th>Step</th></tr></thead><tbody>${legendRows}</tbody></table>
</body></html>`;

    fs.writeFileSync(out, html);
    log(`📄 Dashboard: ${out}`);
  } catch (error) {
    log(`⚠️ Cannot write dashboard: ${error.message}`);
  }
}

// ============ TEST SUITE ============
test.describe('OLSD141R - CIF Merge File Report', () => {
  let ctx;            // batch date / cut-off
  let parsed;         // parsed report
  let reportPath;     // local report file
  let remoteReport;   // report file name on the server
  let expectedRows;   // DWH_TEMP_CIF_MERGE rows of the run
  let seedJobId;      // job_id discovered by the seed step

  test.beforeAll(async () => {
    // Two Java batches (OLSDB057 + OLSDR141) need a long runtime
    test.setTimeout(90 * 60 * 1000);

    log('📋 Step 1: Read batch_date (and cut-off for logging) from DB');
    ctx = await getBatchContext('PREFLIGHT');
    runContext.batchDateYmd = ctx.batchDateYmd;
    log(`📊 batch date = ${ctx.batchDateYmd}, cut-off = ${ctx.cutOffTime} (module ${ctx.cutOffModuleId})`);
    log('📊 Cut-off is NOT used as a filter - expected data is selected by job_id');

    if (process.env.OLSD141R_SKIP_PREPARE === '1') {
      log('📋 Step 2: Skip seeding (OLSD141R_SKIP_PREPARE=1)');
    } else {
      log('📋 Step 2: Seed data (OLSMECIF -> OLSDB057)');
      const prepared = await prepareData('OLSD141R');
      steps.push(...(prepared.steps || []));
      seedJobId = prepared.jobId || null;
      runContext.jobId = seedJobId;
      if (prepared.ctx) {
        ctx = prepared.ctx;
        runContext.batchDateYmd = ctx.batchDateYmd;
      }
      log(`[OLSD141R] Seed file ${prepared.fileName} -> job_id ${seedJobId || 'n/a'}`);
    }

    log(`📋 Step 3: Run OLSD141R (find file by glob ${reportFileGlob(ctx.batchDateYmd)})`);
    remoteReport = reportFileName(ctx.batchDateYmd);

    if (process.env.OLSD141R_SKIP_BATCH === '1') {
      log('⏭️ Skip report batch (OLSD141R_SKIP_BATCH=1) - use the file already on the server');
      const existing = await listRemoteReports(ctx.batchDateYmd, 'REPORT');
      if (existing.length) {
        existing.sort((a, b) => b.mtime - a.mtime);
        remoteReport = existing[0].name;
      }
      addStep('10', 'Run OLSDR141 batch', false, 'skipped (OLSD141R_SKIP_BATCH=1)');
      addStep('11', 'Wait for OLSD141R report file', false, `skipped - using ${remoteReport}`);
    } else {
      const before = (await listRemoteReports(ctx.batchDateYmd, 'REPORT')).map((r) => r.signature);
      await executeBatch('REPORT');
      addStep('10', 'Run OLSDR141 batch', true, `cd ${CONFIG.batch.scriptPath} && ${CONFIG.batch.command}`);
      const fresh = await waitForFreshReport(ctx.batchDateYmd, before, 'REPORT');
      remoteReport = fresh.name;
      addStep('11', 'Wait for OLSD141R report file', true,
        `${CONFIG.report.remoteDir}/${remoteReport} regenerated (${fresh.size} bytes)`);
    }

    log('📋 Step 4: Download the report and parse it');
    reportPath = await downloadReport(remoteReport, 'REPORT');
    addStep('12', 'Download report to local', true, reportPath);

    parsed = parseReport(fs.readFileSync(reportPath, 'utf8'));
    addStep('13', 'Parse report (header / detail / summary / footer)', parsed.warnings.length === 0,
      `FILE DATE=${parsed.header.fileDate || 'n/a'}, PROC DATE=${parsed.header.procDate || 'n/a'}, ` +
      `File Name=${parsed.header.fileName || 'n/a'}, rows=${parsed.rows.length}, ` +
      `warnings=${parsed.warnings.length}`);

    for (const w of parsed.warnings) log(`⚠️ Parser warning: ${w}`);
    log(`[OLSD141R] Actual report records: ${parsed.rows.length}`);

    const resolvedJobId = await resolveJobId(seedJobId, 'PREFLIGHT');
    runContext.jobId = resolvedJobId;
    if (resolvedJobId) {
      expectedRows = await fetchExpectedRows(resolvedJobId, 'PREFLIGHT');
      log(`[OLSD141R] Expected DB records for job_id=${resolvedJobId}: ${expectedRows.length}`);
    } else {
      expectedRows = null;
      log('⚠️ [OLSD141R] Cannot resolve the job_id of the OLSDB057 run (set OLSD141R_JOB_ID).');
    }
  });

  test('TC01: Report structure (Report ID + title + END OF REPORT)', async () => {
    const issues = [];

    if (!parsed.header.titleFound) issues.push('Missing title line "CIF Merge File Report"');
    if (!parsed.header.reportId) issues.push(`Missing Report ID "${REPORT_ID}"`);
    if (!parsed.header.hasEndOfReport) issues.push('Missing "*** END OF REPORT ***"');
    if (parsed.warnings.length) {
      issues.push(`Parser warning(s) [${parsed.warnings.length}]: ${parsed.warnings[0]}`);
    }

    if (issues.length) log(`❌ TC01: ${issues.join(' | ')}`);
    testCaseResults.push({
      id: 'TC01', ok: issues.length === 0, label: 'Report structure',
      note: issues.join(' | ') || `Report ID=${parsed.header.reportId}, rows=${parsed.rows.length}`,
    });

    await saveTestResults('TC01-STRUCTURE', {
      success: issues.length === 0,
      totalRecords: parsed.rows.length,
      trueCount: issues.length === 0 ? 1 : 0,
      falseCount: issues.length,
      details: issues,
    }, { start: 1, end: 1 });

    expect(issues, `Invalid report structure:\n${issues.join('\n')}`).toEqual([]);
  });

  // FILE DATE vs PROC DATE (BA request) and the "File Name" line of the header.
  test('TC02: Header - FILE DATE vs PROC DATE vs File Name', async () => {
    const issues = [];
    const h = parsed.header;
    const ymdOf = (ddmmyyyy) => {
      const m = String(ddmmyyyy || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      return m ? `${m[3]}${m[2]}${m[1]}` : null;
    };

    if (!h.fileDate && !h.batchDate) issues.push('Cannot read FILE DATE / BATCH DATE from the report');
    if (!h.procDate) issues.push('Cannot read PROC DATE from the report');
    if (!h.fileName) issues.push('Cannot read the "File Name" line from the report');

    const fileDateYmd = ymdOf(h.fileDate);
    const procDateYmd = ymdOf(h.procDate);
    const nameMatch = String(h.fileName || '').match(
      new RegExp(`^${CONFIG.report.fileNamePrefix}-(\\d{4})(\\d{2})(\\d{2})-(\\d{2})\\.dat$`)
    );
    const fileNameDateYmd = nameMatch ? `${nameMatch[1]}${nameMatch[2]}${nameMatch[3]}` : null;

    if (h.fileName && !nameMatch) {
      issues.push(`File Name "${h.fileName}" does not match ` +
        `${CONFIG.report.fileNamePrefix}-YYYYMMDD-NN.dat`);
    }

    if (fileNameDateYmd) {
      const candidates = [fileDateYmd, procDateYmd, ctx.batchDateYmd].filter(Boolean);
      if (!candidates.includes(fileNameDateYmd)) {
        issues.push(`File Name date (${fileNameDateYmd}) does not match FILE DATE ` +
          `(${fileDateYmd || '-'}), PROC DATE (${procDateYmd || '-'}) or batch date (${ctx.batchDateYmd})`);
      }
    }

    const sameDate = Boolean(fileDateYmd && procDateYmd && fileDateYmd === procDateYmd);
    const verdict = [
      `FILE DATE=${h.fileDate || '-'} (${fileDateYmd || '-'})`,
      `PROC DATE=${h.procDate || '-'} (${procDateYmd || '-'})`,
      `File Name=${h.fileName || '-'} (date ${fileNameDateYmd || '-'}, seq ${nameMatch ? nameMatch[4] : '-'})`,
      `batch date=${ctx.batchDateYmd}`,
      `FILE DATE ${sameDate ? '==' : '!='} PROC DATE`,
    ].join(' | ');

    headerCheck = {
      fileDate: h.fileDate || '', fileTime: h.fileTime || '', fileDateYmd: fileDateYmd || '',
      procDate: h.procDate || '', procTime: h.procTime || '', procDateYmd: procDateYmd || '',
      fileName: h.fileName || '', fileNameDateYmd: fileNameDateYmd || '',
      batchDateYmd: ctx.batchDateYmd, verdict,
    };

    log(`📊 [TC02] ${verdict}`);
    for (const issue of issues) log(`⚠️ [TC02] ${issue}`);
    testCaseResults.push({
      id: 'TC02', ok: issues.length === 0,
      label: 'Header (FILE DATE vs PROC DATE vs File Name)',
      note: issues.join(' | ') || verdict,
    });

    await saveTestResults('TC02-HEADER', {
      success: issues.length === 0,
      totalRecords: 1,
      trueCount: issues.length === 0 ? 1 : 0,
      falseCount: issues.length,
      details: issues.length ? issues : [verdict],
    }, { start: 1, end: 1 });

    expect(issues, `Invalid report header:\n${issues.join('\n')}`).toEqual([]);
  });

  test('TC03: Report detail vs DWH_TEMP_CIF_MERGE (by job_id)', async () => {
    const started = Date.now();

    if (!expectedRows) {
      const issues = ['Cannot resolve the job_id of the OLSDB057 run, so there is no expected ' +
        'data to compare (set OLSD141R_JOB_ID to validate a specific run)'];
      testCaseResults.push({
        id: 'TC03', ok: false, label: 'Report vs DB (DWH_TEMP_CIF_MERGE)', note: issues[0],
      });
      await saveTestResults('TC03-REPORT-VS-DB', {
        success: false, totalRecords: parsed.rows.length, trueCount: 0,
        falseCount: 1, details: issues,
      }, { start: 1, end: 1 }, Date.now() - started);
      expect(issues, issues.join('\n')).toEqual([]);
      return;
    }

    comparison = compareRows(parsed.rows, expectedRows);
    addStep('14', 'Compare report vs DWH_TEMP_CIF_MERGE (by job_id)', comparison.success,
      `report=${comparison.actualRecords} rows, DB=${comparison.expectedRecords} rows, ` +
      `mismatched fields=${comparison.mismatchedFields}`);

    log(`📊 [TC03] report = ${comparison.actualRecords} row(s), DB = ${comparison.expectedRecords} row(s), ` +
      `fields checked = ${comparison.fieldsChecked}, mismatched fields = ${comparison.mismatchedFields}`);
    for (const note of comparison.notes) log(`ℹ️ [TC03] ${note}`);
    for (const issue of comparison.issues) log(`⚠️ [TC03] ${issue}`);
    log(`[OLSD141R] Validation ${comparison.success ? 'PASSED' : 'FAILED'}`);

    testCaseResults.push({
      id: 'TC03', ok: comparison.success, label: 'Report vs DB (mapping + ordering)',
      note: `${comparison.mismatchedFields} mismatched field(s), ${comparison.issues.length} count/order issue(s)`,
    });

    await saveTestResults('TC03-REPORT-VS-DB', {
      success: comparison.success,
      totalRecords: comparison.actualRecords,
      trueCount: comparison.matchedFields,
      falseCount: comparison.mismatchedFields,
      details: comparison.mismatches,
    }, { start: 1, end: 1 }, Date.now() - started);

    expect(
      comparison.success,
      `OLSD141R report: ${comparison.mismatchedFields} mismatched field(s), ` +
      `${comparison.issues.length} issue(s): ${comparison.issues.join(' | ')}`
    ).toBe(true);
  });

  test('TC04: Successful Indicator / Unsuccessful Error Description are valid', async () => {
    const issues = [];
    const observed = new Map();

    for (const row of parsed.rows) {
      const ind = normalizeText(row.indicator).toUpperCase();
      const desc = normalizeText(row.errorDesc);
      const recordId = recordIdOf(row);

      if (!INDICATOR_DESC[ind]) {
        issues.push(`${recordId}: Successful Indicator "${row.indicator}" is not Y/N/Z`);
        continue;
      }

      // The description column only accepts the three return-file descriptions. It is NOT
      // asserted that N prints "Not Successful": the real layout sample (OLSD141R_01.txt) prints
      // "Successful" on an 'N' row, so the description is validated against DB data in TC03.
      if (desc && !KNOWN_DESCRIPTIONS.some((d) => d.toLowerCase() === desc.toLowerCase())) {
        issues.push(`${recordId}: Unsuccessful Error Description "${desc}" is not one of ` +
          `${KNOWN_DESCRIPTIONS.join(' / ')}`);
      }

      const key = `${ind} -> ${desc || '(blank)'}`;
      observed.set(key, (observed.get(key) || 0) + 1);
    }

    const mapping = [...observed.entries()].map(([k, n]) => `${k} (${n})`).join('; ');
    log(`📊 [TC04] Indicator -> Description in the report: ${mapping || '(no rows)'}`);
    for (const issue of issues) log(`⚠️ [TC04] ${issue}`);

    testCaseResults.push({
      id: 'TC04', ok: issues.length === 0,
      label: 'Successful Indicator / Error Description valid',
      note: issues.join(' | ') || `${parsed.rows.length} row(s) | ${mapping}`,
    });

    await saveTestResults('TC04-INDICATOR', {
      success: issues.length === 0,
      totalRecords: parsed.rows.length,
      trueCount: parsed.rows.length - issues.length,
      falseCount: issues.length,
      details: issues,
    }, { start: 1, end: 1 });

    expect(issues, `Invalid indicator/error description:\n${issues.join('\n')}`).toEqual([]);
  });

  test('TC05: Summary - accepted / rejected totals', async () => {
    const issues = [];
    const counts = countByIndicator(parsed.rows);
    const expectedAccepted = counts.Y;
    const expectedRejected = counts.N + counts.Z;

    if (counts.other.length) {
      issues.push(`${counts.other.length} row(s) without a valid Successful Indicator`);
    }
    if (parsed.totals.accepted === null) issues.push('Missing "Total number of records accepted"');
    else if (!sameNumber(parsed.totals.accepted, expectedAccepted)) {
      issues.push(`Report total accepted = ${parsed.totals.accepted}, Indicator=Y rows = ${expectedAccepted}`);
    }
    if (parsed.totals.rejected === null) issues.push('Missing "Total number of records rejected"');
    else if (!sameNumber(parsed.totals.rejected, expectedRejected)) {
      issues.push(`Report total rejected = ${parsed.totals.rejected}, Indicator=N/Z rows = ${expectedRejected}`);
    }

    // total detail records = accepted + rejected
    if (parsed.rows.length !== expectedAccepted + expectedRejected) {
      issues.push(`Detail rows (${parsed.rows.length}) != accepted + rejected ` +
        `(${expectedAccepted} + ${expectedRejected})`);
    }

    if (expectedRows) {
      const dbCounts = countByIndicator(expectedRows);
      if (dbCounts.Y !== expectedAccepted) {
        issues.push(`DB has ${dbCounts.Y} Indicator=Y row(s), report has ${expectedAccepted}`);
      }
      if (dbCounts.N + dbCounts.Z !== expectedRejected) {
        issues.push(`DB has ${dbCounts.N + dbCounts.Z} Indicator=N/Z row(s), report has ${expectedRejected}`);
      }
    }

    const note = `accepted=${parsed.totals.accepted}/${expectedAccepted} (Y), ` +
      `rejected=${parsed.totals.rejected}/${expectedRejected} (N+Z), detail rows=${parsed.rows.length}`;
    log(`📊 [TC05] ${note}`);
    for (const issue of issues) log(`⚠️ [TC05] ${issue}`);

    testCaseResults.push({
      id: 'TC05', ok: issues.length === 0, label: 'Summary accepted / rejected totals',
      note: issues.join(' | ') || note,
    });

    await saveTestResults('TC05-SUMMARY', {
      success: issues.length === 0,
      totalRecords: parsed.rows.length,
      trueCount: Math.max(0, 3 - issues.length),
      falseCount: issues.length,
      details: issues.length ? issues : [note],
    }, { start: 1, end: 1 });

    expect(issues, `Invalid summary:\n${issues.join('\n')}`).toEqual([]);
  });

  test('TC06: Sort sequence by CIF#', async () => {
    const issues = [];
    const keys = parsed.rows.map(rowSortKey);
    const sorted = [...keys].sort();

    for (let i = 0; i < keys.length; i += 1) {
      if (keys[i] !== sorted[i]) {
        issues.push(`Row ${i + 1} out of order: report = ${keys[i]}, expected = ${sorted[i]}`);
        break;
      }
    }

    for (const issue of issues) log(`⚠️ [TC06] ${issue}`);

    testCaseResults.push({
      id: 'TC06', ok: issues.length === 0, label: 'Sort sequence by CIF#',
      note: issues.join(' | ') || `${keys.length} row(s) sorted ascending by CIF#`,
    });

    await saveTestResults('TC06-SORT', {
      success: issues.length === 0,
      totalRecords: keys.length,
      trueCount: keys.length - issues.length,
      falseCount: issues.length,
      details: issues,
    }, { start: 1, end: 1 });

    expect(issues, `Invalid report order:\n${issues.join('\n')}`).toEqual([]);
  });

  test.afterAll(async () => {
    writeDashboard(reportPath, remoteReport);
  });
});
