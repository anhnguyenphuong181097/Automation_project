// scripts/OLSDB028/test-runner.spec.js
// Batch : OLSDB028 (job redeemItemExportJob)  ->  output OLSITRED.dat
// Host  : 192.168.99.83 (MY-dev), DB ols_my / schema ols_schema
//
// Same 4-file pattern as OLSDB024 / OLSD133R / OLSD134R / OLSD141R:
//   test-data.js        : CONFIG + layout + expected-data query + field mapping
//   file-naming.js      : naming / glob of OLSITRED.dat
//   test-runner.spec.js : run the batch, download + parse the export, compare with the DB
//   (file-generator.js  : data preparation - DEFERRED, see "SCOPE" below)
//
// SCOPE (agreed with the requester):
//   * This spec does NOT prepare data and does NOT call the Item Redemption API. The input of
//     OLSDB028 is whatever the API already stored in ITEM_FULFILMENT_STATUS (+ _HIS).
//   * The API-driven data preparation (OL59 -> capture REFERENCE_NO / EXTRACTED_DATE_TIME) is
//     intentionally left out for now; the API contract is already captured in this session
//     (endpoint, ReturnCode '00000' = success, success reference at itemRedeem.itmRdmRefNbr).
//
// Flow:
//   0 PREFLIGHT : batch_date + oe_cutofftime_control (module OLSDB028) BEFORE the run
//   1 RUN       : ./OLSDB028 on the batch server
//   2 WAIT      : a fresh OLSITRED* file appears in USER_OUTPUT/OLSDB028
//   3 LOAD      : download to reports\OLSDB028\ with WinSCP (binary)
//   4 PARSE     : HD / FN / DT / TR pipe records
//   5 EXPECTED  : query ITEM_FULFILMENT_STATUS (+ _HIS) for the cut-off window of this run
//   6 VERIFY    : header / detail / trailer / cut-off control / extraction window
//
// Environment flags:
//   OLSDB028_SKIP_BATCH=1        do not run ./OLSDB028; verify the file already on the server
//   OLSDB028_WINDOW_START=...    before the run, force last_cutoff_time = current_cutoff_time =
//                                this timestamp ('YYYY-MM-DD HH24:MI:SS') to keep the export small.
//                                The batch then advances the row normally (last = the forced value,
//                                current = MAX(extracted_date_time)), exactly like a run at that
//                                time, so the ledger stays consistent - nothing is restored.
//   OLSDB028_OUTPUT_DIR=...      override the remote output folder
//   OLSDB028_FILE_NAME=...       override the local/remote file name used when downloading
//   OLSDB028_LOCAL_FILE=...      verify an OLSITRED file already on disk instead of downloading
//   OLSDB028_OFFLINE=1           with OLSDB028_LOCAL_FILE: no SSH and no DB access at all
//   OLSDB028_BATCH_DATE=...      expected value of HD.batchDate (used with OLSDB028_OFFLINE=1)

import { test, expect } from '@playwright/test';
import fs from 'fs-extra';
import crypto from 'crypto';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import pg from 'pg';
import {
  CONFIG, SCHEMA, BATCH_ID, JOB_NAME, OUTPUT_ID, CUTOFF_MODULE_ID, SUPPORTED_ITEM_TYPES,
  HEADER_FIELDS, DETAIL_FIELDS, TRAILER_FIELDS, INITIAL_LAST_CUTOFF_TIME,
  CUTOFF_TOLERANCE_MS, EXPECTED_QUERY, OVERLAP_QUERY, MAX_EXTRACTED_QUERY, CUTOFF_QUERY,
  MAX_EXTRACTED_FILTERED_QUERY, CUTOFF_HIS_QUERY, BATCH_DATE_QUERY, SOFT_FIELDS, FILLER_FIELD,
  formatWindowParam,
} from './test-data.js';
import {
  outputFileName, outputFileGlob, outputLocalPathForName, parseOutputFileName,
} from './file-naming.js';
import { prepareData, preflightRegion } from './file-generator.js';

const execAsync = promisify(exec);

// OLSDB028_LOCAL_FILE : verify an OLSITRED file already on disk (no SSH, no download).
// OLSDB028_OFFLINE=1  : additionally skip every database call (header/structure checks only).
const LOCAL_FILE = (process.env.OLSDB028_LOCAL_FILE || '').trim();
const OFFLINE = process.env.OLSDB028_OFFLINE === '1';

// ============ DASHBOARD DATA ============
const STEP_LEGEND = [
  ['0', 'Read batch_date + oe_cutofftime_control (module OLSDB028) BEFORE the run'],
  ['1', 'Run ./OLSDB028 (redeemItemExportJob) on 192.168.99.83'],
  ['2', 'Wait for a fresh OLSITRED* file in USER_OUTPUT/OLSDB028'],
  ['3', 'Download OLSITRED.dat to reports\\OLSDB028\\'],
  ['4', 'Parse HD / FN / DT / TR records'],
  ['5', 'Query ITEM_FULFILMENT_STATUS (+_HIS) for the cut-off window'],
  ['6', 'Verify header / detail / trailer / cut-off control'],
];

const steps = [];
const runContext = {
  batchDateYmd: null, cutoffBefore: null, cutoffAfter: null, cutoffHisBefore: null,
  cutoffHisAfter: null, file: null, window: null,
};
let parsed = null;
let expected = null;
let comparison = null;
let trailerCheck = null;
let cutoffCheck = null;
let rawExportText = '';

function addStep(no, name, ok, note = '') {
  steps.push({ no: String(no), name, ok: Boolean(ok), note });
  log(`[STEP ${no}] ${ok ? 'OK  ' : 'FAIL'} ${name}${note ? ' - ' + note : ''}`);
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

// ============ SAVE TEST RESULTS (same template as OLSDB024 / OLSD133R / OLSD134R / OLSD141R) ============
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
    maxBuffer: 1024 * 1024 * 16,
  });
  return { stdout, stderr };
}

/** Run the export batch. Throws if the command cannot run (so it is not mixed up with an empty file). */
async function executeBatch(testCase) {
  const command = `cd ${CONFIG.batch.scriptPath} && ${CONFIG.batch.command}`;
  log(`[${testCase}] Run batch: ${command}`);

  try {
    const { stdout, stderr } = await execAsync(plinkCommand(command), {
      timeout: CONFIG.batch.timeout,
      maxBuffer: 1024 * 1024 * 16,
    });
    log(`[${testCase}] Batch finished (exit 0)`);
    return { success: true, stdout, stderr };
  } catch (error) {
    // The OLSDB028 wrapper exits 10 when the job fails; that is still "the batch ran", but with a
    // verdict we must not hide. Keep the exit info in the message and rethrow.
    throw new Error(`[${testCase}] Batch ${CONFIG.batch.command} failed to run: ` +
      `${maskSecret(error.message)}`);
  }
}

/**
 * Files of the output folder matching *OLSITRED*.
 * signature = name|mtime|size identifies the file that was just regenerated.
 */
async function listRemoteOutputs(testCase = 'OUTPUT') {
  try {
    const { stdout } = await executeCustomCommand(
      `ls -l --time-style=+%s ${CONFIG.output.remoteDir}/${outputFileGlob()} 2>/dev/null || true`,
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
      .filter((r) => parseOutputFileName(r.name) !== null);
  } catch (error) {
    return [];
  }
}

async function listRemoteDir(dir, testCase) {
  try {
    const { stdout } = await executeCustomCommand(`ls -lt ${dir} 2>&1 | head -20`, testCase);
    return stdout.trim();
  } catch (error) {
    return '(cannot list folder)';
  }
}

/** Wait until an OLSITRED file appears that was not there before the batch run. */
async function waitForFreshOutput(previousSignatures, testCase, timeout = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const files = await listRemoteOutputs(testCase);
    const fresh = files.find((f) => !previousSignatures.includes(f.signature));
    if (fresh) {
      log(`[${testCase}] New output: ${CONFIG.output.remoteDir}/${fresh.name} ` +
        `(${fresh.size} bytes, mtime ${fresh.mtime})`);
      return fresh;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(
    `[${testCase}] No new file matching ${outputFileGlob()} within ${timeout / 1000}s in ` +
    `${CONFIG.output.remoteDir}\nFolder content:\n${await listRemoteDir(CONFIG.output.remoteDir, testCase)}`
  );
}

/** Download the export with WinSCP (binary, to keep the CRLF layout of the server file). */
async function downloadOutput(fileName, testCase) {
  fs.ensureDirSync(CONFIG.output.localDir);
  const localFile = outputLocalPathForName(fileName);

  const command = `"${CONFIG.winscp.path}" /command ` +
    `"option batch abort" ` +
    `"option confirm off" ` +
    `"option transfer binary" ` +
    `"open sftp://${CONFIG.winscp.username}:${CONFIG.winscp.password}@${CONFIG.winscp.host}/" ` +
    `"cd ${CONFIG.output.remoteDir}" ` +
    `"get ""${fileName}"" ""${localFile}""" ` +
    `"exit"`;

  try {
    await execAsync(command, { timeout: 180000, maxBuffer: 1024 * 1024 * 16 });
  } catch (error) {
    throw new Error(`[${testCase}] Download failed ${fileName}: ${maskSecret(error.message)}`);
  }
  log(`[${testCase}] Downloaded ${localFile}`);
  return localFile;
}

/** Size + md5 + mtime of the downloaded file - identifies exactly the file of this run. */
function fileFingerprint(filePath) {
  const buffer = fs.readFileSync(filePath);
  return {
    size: buffer.length,
    md5: crypto.createHash('md5').update(buffer).digest('hex'),
    mtime: fs.statSync(filePath).mtime.toISOString(),
  };
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
  await client.query(`SET search_path TO ${SCHEMA}`);
  try {
    const result = await client.query(query, params);
    return result.rows;
  } catch (error) {
    throw new Error(`[${testCase}] DB query failed: ${error.message}\nSQL: ${query.trim()}`);
  } finally {
    await client.end();
  }
}

async function readCutoff(testCase) {
  const rows = await executeDbQuery(CUTOFF_QUERY, [CUTOFF_MODULE_ID], testCase);
  return rows.length ? rows[0] : null;
}

async function readCutoffHis(testCase) {
  const rows = await executeDbQuery(CUTOFF_HIS_QUERY, [CUTOFF_MODULE_ID], testCase);
  return rows.length ? rows[0] : null;
}

async function readBatchDate(testCase) {
  const rows = await executeDbQuery(BATCH_DATE_QUERY, [], testCase);
  if (!rows.length) throw new Error(`[${testCase}] ${SCHEMA}.batch_date has no row.`);
  return rows[0];
}

// ============ VALUE HELPERS ============
function trimValue(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

/** YYYYMMDD of a timestamp coming from the DB through node-postgres (Date) or as text. */
function toYmd(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    return value.getFullYear() +
      String(value.getMonth() + 1).padStart(2, '0') +
      String(value.getDate()).padStart(2, '0');
  }
  const text = String(value).trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;
  const digits = text.replace(/\D/g, '');
  return digits.slice(0, 8);
}

function msOf(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value).replace(' ', 'T'));
  return Number.isNaN(parsed) ? null : parsed;
}

/** Numeric comparison: the sheet fixes the data type (9(n[,m])) but not the padding. */
function sameNumber(actual, expectedNumber, scale = 2) {
  const a = Number(String(actual ?? '').replace(/\s/g, ''));
  if (!Number.isFinite(a)) return false;
  const factor = 10 ** scale;
  return Math.round(a * factor) === Math.round(Number(expectedNumber) * factor);
}

// ============ OUTPUT PARSER ============
function mapRecord(fields, cells) {
  const out = {};
  fields.forEach((field, index) => {
    out[field.name] = cells[index] === undefined ? '' : cells[index];
  });
  return out;
}

/**
 * OLSITRED is a pipe delimited file: HD first, then the FN definition records (FN|DT|... and
 * FN|TR|...), then one DT record per extracted row, then TR.
 * The FN records carry the field names of the spec sheet; DT/TR values follow the same order.
 */
function parseOlsitred(text) {
  const warnings = [];
  const fnRecords = {};
  const details = [];
  let header = null;
  let trailer = null;

  const lines = String(text).split(/\r?\n/);
  lines.forEach((raw, index) => {
    if (raw.trim() === '') return;
    const cells = raw.split('|');
    const tag = trimValue(cells[0]).toUpperCase();
    const meta = { cells, raw, line: index + 1 };

    if (tag === 'HD') {
      if (header) warnings.push(`Line ${index + 1}: more than one HD record`);
      header = meta;
    } else if (tag === 'FN') {
      const group = trimValue(cells[1]).toUpperCase();
      fnRecords[group] = meta;
    } else if (tag === 'DT') {
      details.push(meta);
    } else if (tag === 'TR') {
      if (trailer) warnings.push(`Line ${index + 1}: more than one TR record`);
      trailer = meta;
    } else {
      warnings.push(`Line ${index + 1}: unknown record tag "${cells[0]}"`);
    }
  });

  if (!header) warnings.push('No HD (header) record found');
  if (!trailer) warnings.push('No TR (trailer) record found');
  if (details.length === 0) warnings.push('No DT (detail) record found');

  const headerRecord = header ? mapRecord(HEADER_FIELDS, header.cells) : null;
  const trailerRecord = trailer ? mapRecord(TRAILER_FIELDS, trailer.cells) : null;
  const detailRecords = details.map((d) => ({
    line: d.line,
    raw: d.raw,
    cells: d.cells,
    record: mapRecord(DETAIL_FIELDS, d.cells),
  }));

  if (header && header.cells.length !== HEADER_FIELDS.length) {
    warnings.push(`HD has ${header.cells.length} cells, the sheet declares ${HEADER_FIELDS.length}`);
  }
  if (trailer && trailer.cells.length !== TRAILER_FIELDS.length) {
    warnings.push(`TR has ${trailer.cells.length} cells, the sheet declares ${TRAILER_FIELDS.length}`);
  }
  const wrongDetailWidth = detailRecords.filter((d) => d.cells.length !== DETAIL_FIELDS.length);
  if (wrongDetailWidth.length) {
    warnings.push(`${wrongDetailWidth.length} DT record(s) do not have ${DETAIL_FIELDS.length} cells ` +
      `(first at line ${wrongDetailWidth[0].line}: ${wrongDetailWidth[0].raw.slice(0, 120)})`);
  }

  // FN|DT / FN|TR are the field-name records of the sheet (TC_01_12 / TC_01_13).
  // FN|DT||itmRdmDate|... -> drop the leading 'FN' + group cells and keep the field names.
  const fnDetail = fnRecords.DT ? fnRecords.DT.cells.slice(2).map(trimValue).filter(Boolean) : [];
  const fnTrailer = fnRecords.TR ? fnRecords.TR.cells.slice(2).map(trimValue).filter(Boolean) : [];
  const declaredDetail = DETAIL_FIELDS
    .filter((f) => f.name !== 'recordTag' && f.declared !== null)
    .map((f) => f.declared || f.name);
  // The sheet prints the trailer columns as itmRdmCardNumber / itmRdmPoints / itmRdmQuantity /
  // recordCount even though the values are hashes - see `declared` in TRAILER_FIELDS.
  const declaredTrailer = TRAILER_FIELDS
    .filter((f) => f.name !== 'recordTag' && f.declared !== null)
    .map((f) => f.declared || f.name);
  const declaredSet = new Set([...fnDetail, ...fnTrailer].map((n) => n.toLowerCase()));

  for (const name of declaredDetail) {
    // The real file spells some columns differently (itmPartnercode, itmRdmFulfillmentStatusDesc)
    // and lower-cases 'filler', so the comparison is case-insensitive.
    if (fnDetail.length && !declaredSet.has(name.toLowerCase())) {
      warnings.push(`FN|DT does not declare the field ${name}`);
    }
  }
  for (const name of declaredTrailer) {
    if (fnTrailer.length && !declaredSet.has(name.toLowerCase())) {
      warnings.push(`FN|TR does not declare the field ${name}`);
    }
  }

  return {
    header: headerRecord,
    trailer: trailerRecord,
    details: detailRecords,
    fnDetail,
    fnTrailer,
    rawLines: lines.length,
    warnings,
  };
}

// ============ EXPECTED DATA (DB = source of truth) ============
/**
 * EXPECTED_QUERY is the BA query, and it is already GROUPED: one result row = one OLSITRED Detail
 * record (quantity = COUNT(*), redeemed_point = SUM(redeemed_point) * 100). Do NOT regroup here.
 */
function buildExpectedRows(dbRows) {
  return dbRows.map((row) => ({
    source_table: trimValue(row.temp_column),      // 'MAIN' (IFS) / 'HIS' (IFS_HIS)
    reference_no: trimValue(row.reference_no),
    itmRdmDate: toYmd(row.transaction_date),
    itmRdmCardNumber: trimValue(row.card_no),
    itmRdmPool: trimValue(row.pool_id),
    itmPartnerCode: trimValue(row.supplier_id),
    itmRdmItemCode: trimValue(row.item_code),
    itmRdmItemDescription: trimValue(row.item_name),
    // SUM(redeemed_point) * 100 - already the value printed in the file (TC_01_23)
    itmRdmPoints: Number(row.redeemed_point),
    itmRdmQuantity: Number(row.quantity),
    itmRdmFulfillmentStatus: trimValue(row.fulfillment_status),
    // TC_01_26: fulfillment_status.description (LEFT JOIN, status 'A')
    itmRdmFulfillmentStatusDescription: trimValue(row.description),
    // TC_01_27 is NOT part of the BA query -> soft comparison (see SOFT_FIELDS)
    itmRdmStatusUpdateDate: toYmd(row.min_status_update_date),
    // TC_01_28: cat_catalogue_trans_details.last_approve_by
    itmRdmUserId: trimValue(row.last_approve_by),
    extracted_date_time: row.min_extracted_date_time || row.extracted_date_time,
    item_type: trimValue(row.item_type),
    matchKey: `${trimValue(row.reference_no)}|${trimValue(row.item_code)}|` +
      `${trimValue(row.fulfillment_status)}|${trimValue(row.card_no)}|${trimValue(row.pool_id)}|` +
      `${toYmd(row.transaction_date)}`,
    _db: row,
  }));
}

/** Rightmost 10 digits of a BigInt sum (spec TC_01_30 / TC_01_31 / TC_01_32). */
function rightmost10(sum) {
  const digits = sum.toString().replace('-', '');
  return digits.length <= 10 ? digits.padStart(10, '0') : digits.slice(-10);
}

function sumBigInt(values) {
  return values.reduce((acc, value) => acc + BigInt(value), 0n);
}

/**
 * Trailer per the sheet: the three hashes are the rightmost 10 digits of the sum of ALL values
 * printed in the Detail records, and recordCount counts the records of the file including the
 * header and the trailer (TC_01_29 .. TC_01_33). It is computed from the file itself, so it checks
 * the batch's own consistency.
 */
function trailerFromFile(fileDetails) {
  let cardSum = 0n;
  let pointSum = 0n;
  let quantitySum = 0n;

  for (const detail of fileDetails) {
    const card = trimValue(detail.record.itmRdmCardNumber).replace(/\D/g, '');
    cardSum += card === '' ? 0n : BigInt(card);
    // itmRdmPoints is already the printed value (DB value * 100), so the digits are summed as is.
    const points = trimValue(detail.record.itmRdmPoints).replace(/\D/g, '');
    pointSum += points === '' ? 0n : BigInt(points);
    const quantity = trimValue(detail.record.itmRdmQuantity).replace(/\D/g, '');
    quantitySum += quantity === '' ? 0n : BigInt(quantity);
  }

  return {
    hashItmRdmCardNumber: rightmost10(cardSum),
    hashItmRdmPoints: rightmost10(pointSum),
    hashItmRdmQuantity: rightmost10(quantitySum),
    // TC_01_33 says "number of records in the file including Header and Trailer". The file also
    // carries the two FN definition records, and the batch counts them: verified twice on
    // 29/09/2026 - 17 DT -> 21 and 2 DT -> 6, i.e. N + 4 (HD + FN|DT + FN|TR + N DT + TR).
    recordCount: fileDetails.length + 4,
  };
}

/** Same numbers computed from the DB rows of the BA query (informational cross-check). */
function trailerFromExpected(rows) {
  return trailerFromFile(rows.map((r) => ({
    record: {
      itmRdmCardNumber: r.itmRdmCardNumber,
      itmRdmPoints: String(r.itmRdmPoints),   // SUM(redeemed_point) * 100
      itmRdmQuantity: String(r.itmRdmQuantity),
    },
  })));
}

// ============ TEST SUITE ============
test.describe('OLSDB028 - Item Redemption export (OLSITRED.dat)', () => {
  test.beforeAll(async () => {
    log(`===== OLSDB028 preflight (job ${JOB_NAME}) =====`);

    // ---- Step 0: batch date + cut-off BEFORE the run ----
    const batchDateOverride = (process.env.OLSDB028_BATCH_DATE || '').trim().replace(/\D/g, '');

    if (OFFLINE) {
      runContext.batchDateYmd = batchDateOverride || null;
      addStep('0', 'batch_date + cut-off (offline mode)',
        Boolean(batchDateOverride),
        batchDateOverride
          ? `batchDate=${batchDateOverride} (OLSDB028_BATCH_DATE)`
          : 'not provided - set OLSDB028_BATCH_DATE=YYYYMMDD');
    } else {
      const batchRow = await readBatchDate('PREFLIGHT');
      runContext.batchRow = batchRow;
      runContext.batchDateYmd = batchDateOverride || batchRow.batch_date.replace(/-/g, '');
      log(`batch_date = ${batchRow.batch_date} (processing_date ${batchRow.processing_date})`);

      runContext.cutoffBefore = await readCutoff('PREFLIGHT');
      runContext.cutoffHisBefore = await readCutoffHis('PREFLIGHT');
      addStep('0', 'Read batch_date + oe_cutofftime_control (module OLSDB028)',
        Boolean(runContext.cutoffBefore),
        runContext.cutoffBefore
          ? `last=${runContext.cutoffBefore.last_cutoff_time}, current=${runContext.cutoffBefore.current_cutoff_time}, ` +
            `his rows=${runContext.cutoffHisBefore ? runContext.cutoffHisBefore.row_count : 'n/a'}`
          : `no row for module_id=${CUTOFF_MODULE_ID}`);
    }

    // Optional: narrow the window before the run (keeps the export small on a shared dev DB).
    const windowStart = (process.env.OLSDB028_WINDOW_START || '').trim();
    if (windowStart && !OFFLINE && !LOCAL_FILE) {
      await executeDbQuery(
        `UPDATE ${SCHEMA}.oe_cutofftime_control
            SET last_cutoff_time    = $1::timestamp,
                current_cutoff_time = $1::timestamp,
                last_cutoff_by      = $2,
                current_cutoff_by   = $2
          WHERE record_no = $3::bigint`,
        [windowStart, BATCH_ID, runContext.cutoffBefore.record_no],
        'PREFLIGHT'
      );
      runContext.cutoffBefore = await readCutoff('PREFLIGHT');
      log(`cut-off forced to ${windowStart} (OLSDB028_WINDOW_START); the batch advances it normally`);
    }

    // ---- Step 0b: prepare the input data through the Item Redemption API (OL59) ----
    // The payload comes from scripts/OLSDB028/api-data/OL59-itemRedeem.json, not from this file.
    // ---- Step 0a: API region pre-flight (before any redemption is created) ----
    if (OFFLINE || LOCAL_FILE || process.env.OLSDB028_SKIP_PREPARE === '1' ||
        process.env.OLSDB028_SKIP_BATCH === '1') {
      addStep('0a', 'API region pre-flight', false, 'skipped (no API call in this mode)');
    } else {
      const region = await preflightRegion('OLSDB028');
      runContext.region = region;
      addStep('0a', 'API region pre-flight', region.ok,
        `API accepts Region=${region.acceptedRegion} (channel ${region.acceptedChannel}, ` +
        `probe ${region.evidence}); environment expects Region=${region.expectedRegion}` +
        (region.ok ? '' : ' - MISMATCH: fix the API/deployment configuration, not the payload'));
      if (!region.ok) {
        log(`[OLSDB028] REGION NOTE: API accepts Region="${region.acceptedRegion}" while the ` +
          `environment expects "${region.expectedRegion}" (probes: ${region.tried.join(', ')}). ` +
          'Step 1 = check region, step 2 = send the request with the accepted region.');
      }
      if (!region.ok && process.env.OLSDB028_REQUIRE_REGION === '1') {
        throw new Error(`[OLSDB028] REGION MISMATCH: API accepts "${region.acceptedRegion}" but the ` +
          `environment expects "${region.expectedRegion}". Probes: ${region.tried.join(', ')}\n` +
          '(OLSDB028_REQUIRE_REGION=1 is set, so the run stops here.)');
      }
    }

    if (OFFLINE || LOCAL_FILE || process.env.OLSDB028_SKIP_PREPARE === '1') {
      addStep('0b', 'Prepare input data via OL59 (Item Redemption API)', false,
        OFFLINE || LOCAL_FILE ? 'skipped (offline / local file)' : 'skipped (OLSDB028_SKIP_PREPARE=1)');
    } else if (process.env.OLSDB028_SKIP_BATCH === '1') {
      addStep('0b', 'Prepare input data via OL59 (Item Redemption API)', false,
        'skipped (OLSDB028_SKIP_BATCH=1 - verifying the existing file)');
    } else {
      const prepared = await prepareData('OLSDB028');
      runContext.prepared = prepared;
      addStep('0b', 'Prepare input data via OL59 (Item Redemption API)', prepared.cases.length > 0,
        prepared.cases.map((entry) =>
          `${entry.id}: ref ${entry.referenceNo} (${entry.itemCode} x${entry.quantity}, ` +
          `${entry.points} points, extracted ${entry.extractedDateTime})`).join(' | '));
    }

    // ---- Step 1: run the export batch ----
    const skipBatch = process.env.OLSDB028_SKIP_BATCH === '1' || Boolean(LOCAL_FILE) || OFFLINE;
    let remoteFile = outputFileName();

    if (LOCAL_FILE || OFFLINE) {
      remoteFile = path.basename(LOCAL_FILE || CONFIG.output.fileName);
      addStep('1', `Run ${BATCH_ID}`, false, LOCAL_FILE ? `skipped - local file ${LOCAL_FILE}` : 'skipped (OLSDB028_OFFLINE=1)');
      addStep('2', 'Wait for a fresh OLSITRED file', false, 'skipped');
    } else if (skipBatch) {
      const existing = await listRemoteOutputs('RUN');
      if (!existing.length) {
        throw new Error(`OLSDB028_SKIP_BATCH=1 but no OLSITRED file exists in ${CONFIG.output.remoteDir}`);
      }
      existing.sort((a, b) => b.mtime - a.mtime);
      remoteFile = existing[0].name;
      addStep('1', `Run ${BATCH_ID}`, false, `skipped (OLSDB028_SKIP_BATCH=1), using ${remoteFile}`);
      addStep('2', 'Wait for a fresh OLSITRED file', false, `skipped - ${remoteFile}`);
    } else {
      const before = (await listRemoteOutputs('RUN')).map((f) => f.signature);
      await executeBatch('RUN');
      addStep('1', `Run ${BATCH_ID}`, true, `cd ${CONFIG.batch.scriptPath} && ${CONFIG.batch.command}`);
      const fresh = await waitForFreshOutput(before, 'RUN');
      remoteFile = fresh.name;
      addStep('2', 'Wait for a fresh OLSITRED file', true,
        `${CONFIG.output.remoteDir}/${remoteFile} (${fresh.size} bytes)`);
    }

    // ---- Step 3: download + parse ----
    let localFile;
    if (LOCAL_FILE) {
      fs.ensureDirSync(CONFIG.output.localDir);
      localFile = path.join(CONFIG.output.localDir, path.basename(LOCAL_FILE));
      if (path.resolve(localFile) !== path.resolve(LOCAL_FILE)) {
        fs.copyFileSync(LOCAL_FILE, localFile);
      }
      addStep('3', 'Load OLSITRED from disk (OLSDB028_LOCAL_FILE)', true, localFile);
    } else {
      localFile = await downloadOutput(remoteFile, 'LOAD');
      addStep('3', 'Download OLSITRED to reports\\OLSDB028\\', true,
        `${remoteFile} | ${fileFingerprint(localFile).size} bytes`);
    }
    runContext.file = { name: remoteFile, path: localFile, ...fileFingerprint(localFile) };
    log(`Loaded ${localFile} (${runContext.file.size} bytes, md5 ${runContext.file.md5})`);

    rawExportText = fs.readFileSync(localFile, 'utf8');
    parsed = parseOlsitred(rawExportText);
    addStep('4', 'Parse HD / FN / DT / TR records', parsed.warnings.length === 0,
      `header=${parsed.header ? 'yes' : 'no'}, details=${parsed.details.length}, ` +
      `trailer=${parsed.trailer ? 'yes' : 'no'}, warnings=${parsed.warnings.length}`);
    for (const warning of parsed.warnings) log(`Parser warning: ${warning}`);

    // ---- Step 5: cut-off AFTER the run + expected rows of the window ----
    if (OFFLINE) {
      expected = { rows: [], overlaps: [], maxExtracted: null, minExtracted: null, sourceRowCount: 0 };
      runContext.window = { from: null, to: null };
      comparison = compareDetails(parsed.details, expected.rows);
      trailerCheck = compareTrailer(parsed.trailer, trailerFromFile(parsed.details));
      cutoffCheck = { issues: ['offline mode - cut-off control not verified'], checks: [] };
      addStep('5', 'Query ITEM_FULFILMENT_STATUS (+_HIS)', false, 'skipped (OLSDB028_OFFLINE=1)');
      addStep('6', 'Verify header / detail / trailer / cut-off control', parsed.warnings.length === 0,
        'offline mode: only TC01 / TC02 are meaningful');
      log(`[OLSDB028] Actual OLSITRED detail records: ${parsed.details.length}`);
      return;
    }

    runContext.cutoffAfter = await readCutoff('POSTFLIGHT');
    runContext.cutoffHisAfter = await readCutoffHis('POSTFLIGHT');
    const maxExtracted = (await executeDbQuery(MAX_EXTRACTED_QUERY, [], 'POSTFLIGHT'))[0];
    const maxExtractedFiltered =
      (await executeDbQuery(MAX_EXTRACTED_FILTERED_QUERY, [], 'POSTFLIGHT'))[0];

    // The batch extracts last_cutoff_time < extracted_date_time <= current_cutoff_time, and it
    // sets last_cutoff_time = the previous current_cutoff_time. The window of this run is
    // therefore (current_cutoff_time BEFORE the run, current_cutoff_time AFTER the run].
    // OLSDB028_WINDOW_FROM / OLSDB028_WINDOW_TO override it (e.g. to re-verify a saved file).
    const windowStartValue = (process.env.OLSDB028_WINDOW_FROM || '').trim() ||
      (runContext.cutoffBefore
        ? (runContext.cutoffBefore.current_cutoff_time || INITIAL_LAST_CUTOFF_TIME)
        : INITIAL_LAST_CUTOFF_TIME);
    const windowEndValue = (process.env.OLSDB028_WINDOW_TO || '').trim() ||
      (runContext.cutoffAfter ? runContext.cutoffAfter.current_cutoff_time : maxExtracted.max_extracted);
    runContext.window = { from: windowStartValue, to: windowEndValue };

    // The BA query takes 'DD-MM-YYYY HH24:MI:SS' timestamps.
    const windowParams = [formatWindowParam(windowStartValue), formatWindowParam(windowEndValue)];
    const dbRows = await executeDbQuery(EXPECTED_QUERY, windowParams, 'EXPECTED');
    const overlaps = await executeDbQuery(OVERLAP_QUERY, windowParams, 'EXPECTED');
    expected = {
      rows: buildExpectedRows(dbRows),
      overlaps,
      maxExtracted: maxExtracted.max_extracted,
      maxExtractedFiltered: maxExtractedFiltered.max_extracted_filtered,
      minExtracted: maxExtracted.min_extracted,
      sourceRowCount: Number(maxExtracted.row_count),
    };
    addStep('5', 'Query ITEM_FULFILMENT_STATUS (+_HIS) for the cut-off window', true,
      `window (${windowStartValue} , ${windowEndValue}] -> ${expected.rows.length} expected row(s), ` +
      `max(extracted)=${expected.maxExtracted} (filtered ${expected.maxExtractedFiltered}), ` +
      `overlap IFS/IFS_HIS=${overlaps.length}`);

    comparison = compareDetails(parsed.details, expected.rows);
    trailerCheck = compareTrailer(parsed.trailer, trailerFromFile(parsed.details),
      trailerFromExpected(expected.rows));
    cutoffCheck = buildCutoffCheck(runContext, expected, runContext.batchRow);
    addStep('6', 'Verify header / detail / trailer / cut-off control',
      comparison.mismatchCount === 0 && comparison.missingReferences.length === 0 &&
      comparison.extraReferences.length === 0,
      `${comparison.matchedReferences}/${expected.rows.length} detail row(s) match by ` +
      `itmRdmReferenceNo, ${comparison.mismatchCount} field mismatch(es)`);

    log(`[OLSDB028] Actual OLSITRED detail records: ${parsed.details.length}`);
  });

  // ---------------------------------------------------------------- TC01
  test('TC01: OLSITRED.dat exists, is pipe delimited and every record was parsed', async () => {
    const issues = [];

    if (!runContext.file) issues.push('OLSITRED file was not downloaded');
    if (!parsed) issues.push('OLSITRED file was not parsed');
    if (parsed && !parsed.header) issues.push('Missing HD record (TC_01_6/TC_01_18)');
    if (parsed && !parsed.trailer) issues.push('Missing TR record (TC_01_29/TC_01_44)');
    if (parsed && parsed.details.length === 0) issues.push('No DT record (TC_01_14)');
    if (parsed) {
      for (const warning of parsed.warnings) issues.push(warning);
    }

    expect(issues, issues.join('\n')).toEqual([]);

    addStep('7a', 'TC01 - output file + record structure', true,
      `${runContext.file.name}: details=${parsed.details.length}, ` +
      `FN|DT fields=[${parsed.fnDetail.join(', ')}], FN|TR fields=[${parsed.fnTrailer.join(', ')}]`);

    await saveTestResults('TC01-STRUCTURE', {
      success: true,
      totalRecords: parsed.details.length + 2,
      trueCount: parsed.details.length + 2,
      falseCount: 0,
      details: [`${runContext.file.name} (${runContext.file.size} bytes)`],
    }, { start: 1, end: 1 });
  });

  // ---------------------------------------------------------------- TC02
  test('TC02: header record fields (HD)', async () => {
    const issues = [];
    const header = parsed.header || {};
    const batchDateYmd = runContext.batchDateYmd;

    if (trimValue(header.recordType) !== 'HD') issues.push(`recordType must be "HD", got "${trimValue(header.recordType)}" (TC_01_6)`);
    if (trimValue(header.fileId) !== OUTPUT_ID) issues.push(`fileId must be "${OUTPUT_ID}", got "${trimValue(header.fileId)}" (TC_01_7)`);
    if (trimValue(header.receivingSystem) !== 'CLK') issues.push(`receivingSystem must be "CLK", got "${trimValue(header.receivingSystem)}" (TC_01_8)`);
    if (trimValue(header.batchDate) !== batchDateYmd) issues.push(`batchDate must be the batch date ${batchDateYmd}, got "${trimValue(header.batchDate)}" (TC_01_9)`);
    if (!/^\d{8}$/.test(trimValue(header.createDate))) issues.push(`createDate must be YYYYMMDD, got "${trimValue(header.createDate)}" (TC_01_10)`);
    if (trimValue(header.fileNumber) !== '' && !/^\d+$/.test(trimValue(header.fileNumber))) {
      issues.push(`fileNumber must be numeric, got "${trimValue(header.fileNumber)}" (TC_01_11)`);
    }

    expect(issues, issues.join('\n')).toEqual([]);

    addStep('7b', 'TC02 - header fields', true,
      `HD: fileId=${trimValue(header.fileId)}, receivingSystem=${trimValue(header.receivingSystem)}, ` +
      `batchDate=${trimValue(header.batchDate)}, createDate=${trimValue(header.createDate)}, ` +
      `fileNumber=${trimValue(header.fileNumber)}`);

    await saveTestResults('TC02-HEADER', {
      success: true, totalRecords: 1, trueCount: 6, falseCount: 0,
      details: [`batchDate=${trimValue(header.batchDate)}, createDate=${trimValue(header.createDate)}`],
    }, { start: 1, end: 1 });
  });

  // ---------------------------------------------------------------- TC03
  test('TC03: every DT record matches the ITEM_FULFILMENT_STATUS row (reference_no traceability)', async () => {
    test.skip(OFFLINE, 'OLSDB028_OFFLINE=1 - no database expectations');
    const issues = [];

    // An empty export is valid business behaviour when the window contains no fulfillment record
    // (same rule as OLSD134R): the missing/extra reference checks below accept "empty vs empty".
    if (comparison.missingReferences.length) {
      issues.push(`${comparison.missingReferences.length} expected reference(s) are missing from the file: ` +
        `${comparison.missingReferences.slice(0, 5).join(', ')}`);
    }
    if (comparison.extraReferences.length) {
      issues.push(`${comparison.extraReferences.length} file reference(s) are not in the cut-off window: ` +
        `${comparison.extraReferences.slice(0, 5).join(', ')}`);
    }
    if (comparison.mismatchCount) {
      issues.push(`${comparison.mismatchCount} field mismatch(es), first: ` +
        JSON.stringify(comparison.mismatches.slice(0, 3)));
    }
    if (comparison.unmatchedCount) {
      issues.push(`${comparison.unmatchedCount} expected row(s) were not matched by any DT record ` +
        `(first reference ${comparison.unmatchedExpected[0].reference_no})`);
    }

    // Informational only: /apps/MY-dev/OE/onebatch/config/properties/OLSDB028.properties lists
    // batch.OLSDB028.item.type, but the 29/09/2026 run exported rows of other item types as well
    // (all of them matched the file), so the property is NOT the export filter.
    const outsidePropertyList = expected.rows
      .filter((row) => row.item_type && !SUPPORTED_ITEM_TYPES.includes(row.item_type));
    if (outsidePropertyList.length) {
      log(`[TC03] note: ${outsidePropertyList.length} exported row(s) have an item_type outside ` +
        `batch.OLSDB028.item.type (${[...new Set(outsidePropertyList.map((r) => r.item_type))].join(', ')}) ` +
        `- the property is not the export filter.`);
    }

    expect(issues, issues.join('\n')).toEqual([]);

    log(`[TC03] ${comparison.matchedReferences} detail row(s) matched by itmRdmReferenceNo, ` +
      `${comparison.comparedFields} field(s) compared, ${comparison.mismatchCount} mismatch(es)`);
    if (comparison.softMismatches.length) {
      log(`[TC03] soft/unverified difference(s) - ${comparison.softMismatches.length}, first: ` +
        JSON.stringify(comparison.softMismatches.slice(0, 3)));
    }

    await saveTestResults('TC03-DETAIL-VS-DB', {
      success: true,
      totalRecords: expected.rows.length,
      trueCount: comparison.comparedFields - comparison.mismatchCount,
      falseCount: comparison.mismatchCount,
      details: [],
    }, { start: 1, end: 1 });
  });

  // ---------------------------------------------------------------- TC04
  test('TC04: oe_cutofftime_control updated by the batch', async () => {
    // The transition (last = previous current, current = MAX(extracted)) can only be verified when
    // this run actually executed the batch: with SKIP_BATCH / explicit window we only have the
    // cut-off row that the earlier run left behind.
    test.skip(OFFLINE, 'OLSDB028_OFFLINE=1 - no database expectations');
    test.skip(process.env.OLSDB028_SKIP_BATCH === '1' ||
      Boolean(process.env.OLSDB028_WINDOW_FROM || process.env.OLSDB028_WINDOW_TO),
      'batch not run by this spec (SKIP_BATCH / window override) - cut-off transition not verifiable');
    expect(cutoffCheck.issues, cutoffCheck.issues.join('\n')).toEqual([]);

    addStep('7c', 'TC04 - cut-off control', true,
      `last: ${runContext.cutoffBefore ? runContext.cutoffBefore.current_cutoff_time : 'n/a'} -> ` +
      `${runContext.cutoffAfter ? runContext.cutoffAfter.last_cutoff_time : 'n/a'} | ` +
      `current: ${runContext.cutoffAfter ? runContext.cutoffAfter.current_cutoff_time : 'n/a'} ` +
      `(max extracted ${expected.maxExtracted})`);

    await saveTestResults('TC04-CUTOFF-CONTROL', {
      success: true, totalRecords: 1, trueCount: cutoffCheck.checks.length, falseCount: 0,
      details: cutoffCheck.checks,
    }, { start: 1, end: 1 });
  });

  // ---------------------------------------------------------------- TC05
  test('TC05: extraction window - last_cutoff_time < extracted_date_time <= current_cutoff_time', async () => {
    test.skip(OFFLINE, 'OLSDB028_OFFLINE=1 - no database expectations');
    const issues = [];
    const from = msOf(runContext.window.from);
    const to = msOf(runContext.window.to);

    for (const row of expected.rows) {
      const at = msOf(row.extracted_date_time);
      if (at === null) {
        issues.push(`reference ${row.reference_no}: extracted_date_time is null`);
        continue;
      }
      if (from !== null && at <= from) {
        issues.push(`reference ${row.reference_no}: extracted_date_time is <= last_cutoff_time ` +
          `(${runContext.window.from})`);
      }
      if (to !== null && at > to) {
        issues.push(`reference ${row.reference_no}: extracted_date_time is > current_cutoff_time ` +
          `(${runContext.window.to})`);
      }
    }

    // The file must contain exactly the rows of the window: nothing missing, nothing extra.
    const fileReferences = new Set(parsed.details.map((d) => trimValue(d.record.itmRdmReferenceNo)));
    const windowReferences = new Set(expected.rows.map((r) => r.reference_no));
    for (const reference of windowReferences) {
      if (!fileReferences.has(reference)) issues.push(`reference ${reference} is in the window but not in the file`);
    }
    for (const reference of fileReferences) {
      if (!windowReferences.has(reference)) issues.push(`reference ${reference} is in the file but not in the window`);
    }

    expect(issues, issues.slice(0, 20).join('\n')).toEqual([]);

    await saveTestResults('TC05-CUTOFF-WINDOW', {
      success: true, totalRecords: expected.rows.length,
      trueCount: expected.rows.length, falseCount: 0,
      details: [`window (${runContext.window.from} , ${runContext.window.to}]`],
    }, { start: 1, end: 1 });
  });

  // ---------------------------------------------------------------- TC06
  test('TC06: trailer hashes and recordCount', async () => {
    test.skip(OFFLINE, 'OLSDB028_OFFLINE=1 - no database expectations');
    expect(trailerCheck.issues, trailerCheck.issues.join('\n')).toEqual([]);

    await saveTestResults('TC06-TRAILER', {
      success: true, totalRecords: 1, trueCount: trailerCheck.compared, falseCount: 0,
      details: [`recordCount=${trailerCheck.actual.recordCount} (header + details + trailer)`],
    }, { start: 1, end: 1 });
  });

  // ---------------------------------------------------------------- dashboard
  test.afterAll(async () => {
    try {
      await writeDashboard();
    } catch (error) {
      log(`Dashboard write failed: ${error.message}`);
    }
  });
});

// ============ DETAIL COMPARISON ============
/**
 * One file row = one expected row (the BA query is grouped the same way).
 * The row is located by itmRdmReferenceNo first (the traceability field of the requirement) and
 * then by the rest of the group key, because several groups can share one reference_no (one
 * redemption = N fulfilment rows, and IFS and IFS_HIS may hold the same reference).
 */
function compareDetails(fileDetails, expectedRows) {
  // O(1) lookup by group key, then by reference only (one redemption = N groups).
  const byKey = new Map();
  const byReference = new Map();
  for (const row of expectedRows) {
    if (!byKey.has(row.matchKey)) byKey.set(row.matchKey, []);
    byKey.get(row.matchKey).push(row);
    if (!byReference.has(row.reference_no)) byReference.set(row.reference_no, []);
    byReference.get(row.reference_no).push(row);
  }
  const takeFrom = (map, key) => {
    const list = map.get(key);
    return list && list.length ? list.shift() : null;
  };

  const mismatches = [];
  const softMismatches = [];
  let comparedFields = 0;

  for (const detail of fileDetails) {
    const record = detail.record;
    const reference = trimValue(record.itmRdmReferenceNo);
    const matchKey = `${reference}|${trimValue(record.itmRdmItemCode)}|` +
      `${trimValue(record.itmRdmFulfillmentStatus)}|${trimValue(record.itmRdmCardNumber)}|` +
      `${trimValue(record.itmRdmPool)}|${trimValue(record.itmRdmDate)}`;

    const candidate = takeFrom(byKey, matchKey) || takeFrom(byReference, reference);

    if (!candidate) {
      mismatches.push({ line: detail.line, reference, field: 'itmRdmReferenceNo', expected: '(no matching DB row)', actual: reference });
      continue;
    }

    const checks = [
      ['itmRdmDate', candidate.itmRdmDate, trimValue(record.itmRdmDate), 'text'],
      ['itmRdmReferenceNo', candidate.reference_no, reference, 'text'],
      ['itmRdmCardNumber', candidate.itmRdmCardNumber, trimValue(record.itmRdmCardNumber), 'text'],
      ['itmRdmPool', candidate.itmRdmPool, trimValue(record.itmRdmPool), 'text'],
      ['itmPartnerCode', candidate.itmPartnerCode, trimValue(record.itmPartnerCode), 'text'],
      ['itmRdmItemCode', candidate.itmRdmItemCode, trimValue(record.itmRdmItemCode), 'text'],
      ['itmRdmItemDescription', candidate.itmRdmItemDescription, trimValue(record.itmRdmItemDescription), 'text'],
      ['itmRdmPoints', candidate.itmRdmPoints, trimValue(record.itmRdmPoints), 'number'],
      ['itmRdmQuantity', candidate.itmRdmQuantity, trimValue(record.itmRdmQuantity), 'number'],
      ['itmRdmFulfillmentStatus', candidate.itmRdmFulfillmentStatus, trimValue(record.itmRdmFulfillmentStatus), 'text'],
      ['itmRdmFulfillmentStatusDescription', candidate.itmRdmFulfillmentStatusDescription, trimValue(record.itmRdmFulfillmentStatusDescription), 'text'],
      ['itmRdmStatusUpdateDate', candidate.itmRdmStatusUpdateDate, trimValue(record.itmRdmStatusUpdateDate), 'text'],
      ['itmRdmUserId', candidate.itmRdmUserId, trimValue(record.itmRdmUserId), 'text'],
    ];

    for (const [field, expectedValue, actualValue, kind] of checks) {
      const soft = SOFT_FIELDS.includes(field);
      // A soft field that the reference query does not provide cannot be verified: skip it.
      if (soft && (expectedValue === '' || expectedValue === null || expectedValue === undefined)) continue;
      comparedFields += 1;
      const ok = kind === 'number'
        ? sameNumber(actualValue, expectedValue)
        : String(expectedValue) === String(actualValue);
      if (!ok) {
        const entry = { line: detail.line, reference, field, expected: expectedValue, actual: actualValue };
        if (soft) softMismatches.push(entry);
        else mismatches.push(entry);
      }
    }

    // TC_01_19: the filler cell is spaces only.
    comparedFields += 1;
    if (trimValue(record[FILLER_FIELD]) !== '') {
      mismatches.push({ line: detail.line, reference, field: FILLER_FIELD, expected: 'spaces', actual: record[FILLER_FIELD] });
    }
  }

  const fileReferences = new Set(fileDetails.map((d) => trimValue(d.record.itmRdmReferenceNo)));
  const expectedReferences = new Set(expectedRows.map((r) => r.reference_no));
  const missingReferences = [...expectedReferences].filter((r) => !fileReferences.has(r));
  const extraReferences = [...fileReferences].filter((r) => !expectedReferences.has(r));
  const remaining = [...byKey.values()].reduce((sum, list) => sum + list.length, 0);

  return {
    comparedFields,
    mismatchCount: mismatches.length,
    mismatches,
    softMismatches,
    matchedReferences: expectedRows.length - remaining,
    unmatchedExpected: [...byKey.values()].flat().slice(0, 20),
    unmatchedCount: remaining,
    missingReferences,
    extraReferences,
  };
}

// ============ TRAILER COMPARISON ============
function compareTrailer(trailerRecord, expectedValues, expectedFromDb = null) {
  const issues = [];
  const actual = {};
  let compared = 0;

  if (!trailerRecord) {
    return { issues: ['No TR record to compare'], actual, expected: expectedValues, compared: 0 };
  }

  for (const field of TRAILER_FIELDS) {
    actual[field.name] = trimValue(trailerRecord[field.name]);
  }

  if (actual.recordTag.toUpperCase() !== 'TR') issues.push(`TR recordTag must be "TR", got "${actual.recordTag}"`);

  for (const name of ['hashItmRdmCardNumber', 'hashItmRdmPoints', 'hashItmRdmQuantity', 'recordCount']) {
    compared += 1;
    const want = String(expectedValues[name]);
    // Compare numerically: the sheet fixes 9(10) but not the padding.
    if (!sameNumber(actual[name], want, 0)) {
      const fromDb = expectedFromDb ? ` (from the DB rows of the BA query: ${expectedFromDb[name]})` : '';
      issues.push(`${name}: computed from the Detail records of this file = ${want}, ` +
        `trailer says "${actual[name]}"${fromDb}`);
    }
  }

  return { issues, actual, expected: expectedValues, expectedFromDb, compared };
}

// ============ CUT-OFF COMPARISON ============
function buildCutoffCheck(context, expectedData, batchRow) {
  const issues = [];
  const checks = [];
  const after = context.cutoffAfter;
  const before = context.cutoffBefore;

  if (!after) {
    return { issues: [`No oe_cutofftime_control row for module_id=${CUTOFF_MODULE_ID} after the run`], checks };
  }

  // TC_01_4: last_cutoff_time = the current_cutoff_time of the previous run.
  if (before) {
    const same = msOf(after.last_cutoff_time) === msOf(before.current_cutoff_time);
    checks.push(`last_cutoff_time=${after.last_cutoff_time} (previous current=${before.current_cutoff_time})`);
    if (!same) {
      issues.push(`last_cutoff_time must be the previous current_cutoff_time (${before.current_cutoff_time}), ` +
        `got ${after.last_cutoff_time}`);
    }
  }

  // TC_01_3 / TC_01_4: current_cutoff_time = MAX(extracted_date_time).
  // The batch may take MAX over the whole source table or over the rows the BA query can export,
  // so both candidates are accepted.
  const candidates = [expectedData.maxExtracted, expectedData.maxExtractedFiltered]
    .filter((value) => value !== null && value !== undefined);
  const actualCurrent = msOf(after.current_cutoff_time);
  checks.push(`current_cutoff_time=${after.current_cutoff_time} ` +
    `(max(extracted)=${expectedData.maxExtracted}, filtered=${expectedData.maxExtractedFiltered})`);
  if (candidates.length && actualCurrent !== null) {
    const matched = candidates.some((value) => Math.abs(msOf(value) - actualCurrent) <= CUTOFF_TOLERANCE_MS);
    if (!matched) {
      issues.push(`current_cutoff_time must be MAX(extracted_date_time) ` +
        `${candidates.join(' or ')} (tolerance ${CUTOFF_TOLERANCE_MS} ms), got ${after.current_cutoff_time}`);
    }
  }

  // TC_01_4: after a non-first run the previous pair is archived in oe_cutofftime_control_his.
  const hisBefore = context.cutoffHisBefore;
  const hisAfter = context.cutoffHisAfter;
  if (hisBefore && hisAfter) {
    const grew = Number(hisAfter.row_count) > Number(hisBefore.row_count);
    checks.push(`oe_cutofftime_control_his rows ${hisBefore.row_count} -> ${hisAfter.row_count}`);
    if (before && before.last_cutoff_time !== INITIAL_LAST_CUTOFF_TIME && !grew) {
      issues.push('oe_cutofftime_control_his did not receive a new row for this run (TC_01_4)');
    }
  }

  checks.push(`batch_date=${batchRow.batch_date}`);
  return { issues, checks };
}

// ============ DASHBOARD ============
async function writeDashboard() {
  fs.ensureDirSync(CONFIG.output.localDir);
  const out = path.join(CONFIG.output.localDir, 'dashboard.html');

  const escape = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const stepRows = steps.map((step) => `
      <tr class="${step.ok ? 'ok' : 'fail'}">
        <td>${escape(step.no)}</td>
        <td>${escape(step.name)}</td>
        <td>${step.ok ? 'OK' : 'FAIL'}</td>
        <td>${escape(step.note)}</td>
      </tr>`).join('');

  const mismatchRows = (comparison && comparison.mismatches.length)
    ? comparison.mismatches.slice(0, 200).map((m) => `
      <tr>
        <td>${escape(m.line)}</td>
        <td>${escape(m.reference)}</td>
        <td>${escape(m.field)}</td>
        <td>${escape(m.expected)}</td>
        <td>${escape(m.actual)}</td>
      </tr>`).join('')
    : '<tr><td colspan="5">No mismatch</td></tr>';

  // ---- Output file (OLSITRED.dat) produced by the batch ----
  const exportLines = String(rawExportText || '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line.trim() !== '');
  const MAX_RAW_LINES = 300;
  const rawShown = exportLines.slice(0, MAX_RAW_LINES);
  const countByTag = exportLines.reduce((acc, line) => {
    const tag = line.slice(0, 2);
    acc[tag] = (acc[tag] || 0) + 1;
    return acc;
  }, {});
  const localLink = runContext.file
    ? `file:///${runContext.file.path.replace(/\\/g, '/').replace(/^\/+/, '')}`
    : null;
  const remotePath = `${CONFIG.output.remoteDir}/${runContext.file ? runContext.file.name : outputFileName()}`;

  const detailSampleRows = parsed && parsed.details.length
    ? parsed.details.slice(0, 20).map((detail) => `
      <tr>
        <td>${escape(detail.line)}</td>
        <td>${escape(trimValue(detail.record.itmRdmDate))}</td>
        <td>${escape(trimValue(detail.record.itmRdmReferenceNo))}</td>
        <td>${escape(trimValue(detail.record.itmRdmCardNumber))}</td>
        <td>${escape(trimValue(detail.record.itmRdmPool))}</td>
        <td>${escape(trimValue(detail.record.itmPartnerCode))}</td>
        <td>${escape(trimValue(detail.record.itmRdmItemCode))}</td>
        <td>${escape(trimValue(detail.record.itmRdmPoints))}</td>
        <td>${escape(trimValue(detail.record.itmRdmQuantity))}</td>
        <td>${escape(trimValue(detail.record.itmRdmFulfillmentStatus))}</td>
        <td>${escape(trimValue(detail.record.itmRdmFulfillmentStatusDescription))}</td>
        <td>${escape(trimValue(detail.record.itmRdmStatusUpdateDate))}</td>
        <td>${escape(trimValue(detail.record.itmRdmUserId))}</td>
      </tr>`).join('')
    : '<tr><td colspan="13">no DT record</td></tr>';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>OLSDB028 - OLSITRED verification</title>
<style>
  body { font-family: Segoe UI, Arial, sans-serif; margin: 24px; color: #1f2933; }
  h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 28px; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; font-size: 13px; }
  th, td { border: 1px solid #d2d6dc; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f4f6f8; }
  tr.ok td:nth-child(3) { color: #0b7a3b; font-weight: 600; }
  tr.fail td:nth-child(3) { color: #b42318; font-weight: 600; }
  code { background: #f4f6f8; padding: 1px 4px; }
</style></head><body>
  <h1>OLSDB028 - Item Redemption export (OLSITRED.dat)</h1>
  <p>Batch <code>${escape(BATCH_ID)}</code> / job <code>${escape(JOB_NAME)}</code> -
     host <code>${escape(CONFIG.putty.host)}</code> - DB <code>${escape(CONFIG.database.database)}.${escape(SCHEMA)}</code></p>
  <p>Output file: <code>${escape(runContext.file ? runContext.file.name : '(none)')}</code>
     ${runContext.file ? `(${runContext.file.size} bytes, md5 ${escape(runContext.file.md5)})` : ''}</p>

  <h2>Steps</h2>
  <table>
    <thead><tr><th>Step</th><th>Description</th><th>Result</th><th>Note</th></tr></thead>
    <tbody>${stepRows}</tbody>
  </table>

  <h2>Input data prepared via OL59</h2>
  <table>
    <thead><tr><th>Case</th><th>Reference</th><th>record_no</th><th>item</th><th>qty</th><th>points</th><th>extracted_date_time</th><th>export gate</th><th>SOPC (pool / PAL)</th><th>CIF account (csn)</th></tr></thead>
    <tbody>${(runContext.prepared && runContext.prepared.cases.length)
      ? runContext.prepared.cases.map((c) => `
      <tr><td>${escape(c.id)}</td><td>${escape(c.referenceNo)}</td><td>${escape(c.recordNo)}</td>
          <td>${escape(c.itemCode)} (${escape(c.itemType)})</td><td>${escape(c.quantity)}</td>
          <td>${escape(c.points)}</td><td>${escape(c.extractedDateTime)}</td>
          <td>${c.exportGate ? 'cat_catalogue_trans_details OK' : 'MISSING'}</td>
          <td>${c.sopc && c.sopc.ok
            ? `pool ${escape(c.sopc.poolId)} OK (${escape(c.sopc.validFrom)} .. ${escape(c.sopc.validTo)}), PAL ${escape(c.sopc.pal)}`
            : `NOT STATEMENTED - ${escape(c.sopc ? c.sopc.reasons.join('; ') : 'not checked')}`}</td>
          <td>${c.account && c.account.ok
            ? `csn ${escape(c.account.csn)} owns ${escape(c.account.productAccountNo)} (${escape(c.account.pal)}/${escape(c.account.pat)})`
            : `FAILED - ${escape(c.account ? c.account.reasons.join('; ') : 'not checked')}`}</td></tr>`).join('')
      : '<tr><td colspan="10">no API call in this run (skip prepare / verify existing file)</td></tr>'}</tbody>
  </table>

  <h2>Cut-off</h2>
  <table>
    <thead><tr><th>Phase</th><th>last_cutoff_time</th><th>current_cutoff_time</th></tr></thead>
    <tbody>
      <tr><td>before</td><td>${escape(runContext.cutoffBefore && runContext.cutoffBefore.last_cutoff_time)}</td>
          <td>${escape(runContext.cutoffBefore && runContext.cutoffBefore.current_cutoff_time)}</td></tr>
      <tr><td>after</td><td>${escape(runContext.cutoffAfter && runContext.cutoffAfter.last_cutoff_time)}</td>
          <td>${escape(runContext.cutoffAfter && runContext.cutoffAfter.current_cutoff_time)}</td></tr>
    </tbody>
  </table>

  <h2>Detail rows</h2>
  <table>
    <thead><tr><th>Metric</th><th>Value</th></tr></thead>
    <tbody>
      <tr><td>DT records in file</td><td>${escape(parsed ? parsed.details.length : 'n/a')}</td></tr>
      <tr><td>Expected rows in the cut-off window</td><td>${escape(expected ? expected.rows.length : 'n/a')}</td></tr>
      <tr><td>Fields compared</td><td>${escape(comparison ? comparison.comparedFields : 'n/a')}</td></tr>
      <tr><td>Field mismatches</td><td>${escape(comparison ? comparison.mismatchCount : 'n/a')}</td></tr>
      <tr><td>Soft / unverified differences (TC_01_27)</td><td>${escape(comparison ? comparison.softMismatches.length : 'n/a')}</td></tr>
      <tr><td>Missing references</td><td>${escape(comparison ? comparison.missingReferences.length : 'n/a')}</td></tr>
      <tr><td>Extra references</td><td>${escape(comparison ? comparison.extraReferences.length : 'n/a')}</td></tr>
      <tr><td>Unmatched expected rows</td><td>${escape(comparison ? comparison.unmatchedCount : 'n/a')}</td></tr>
      <tr><td>IFS/IFS_HIS overlap (reported)</td><td>${escape(expected ? expected.overlaps.length : 'n/a')}</td></tr>
    </tbody>
  </table>

  <h2>Mismatches</h2>
  <table>
    <thead><tr><th>Line</th><th>Reference</th><th>Field</th><th>Expected (DB)</th><th>Actual (file)</th></tr></thead>
    <tbody>${mismatchRows}</tbody>
  </table>

  <h2>Output file (OLSITRED.dat)</h2>
  <table>
    <thead><tr><th>Thuộc tính</th><th>Giá trị</th></tr></thead>
    <tbody>
      <tr><td>File name</td><td>${escape(runContext.file ? runContext.file.name : '(not downloaded)')}</td></tr>
      <tr><td>Remote path</td><td><code>${escape(remotePath)}</code></td></tr>
      <tr><td>Local path</td><td>${localLink
        ? `<a href="${escape(localLink)}">${escape(runContext.file.path)}</a>`
        : '(not downloaded)'}</td></tr>
      <tr><td>Size / md5</td><td>${escape(runContext.file ? runContext.file.size : 'n/a')} bytes
          ${runContext.file ? ' / ' + escape(runContext.file.md5) : ''}</td></tr>
      <tr><td>Records</td><td>HD ${escape(countByTag.HD || 0)} | FN ${escape(countByTag.FN || 0)} |
          DT ${escape(countByTag.DT || 0)} | TR ${escape(countByTag.TR || 0)}
          (total lines ${escape(exportLines.length)})</td></tr>
      <tr><td>Trailer in file</td><td><code>${escape(parsed && parsed.trailer
        ? exportLines.find((line) => line.startsWith('TR|')) || ''
        : '(no TR record)')}</code></td></tr>
      <tr><td>Trailer computed from the DT records</td><td><code>TR|${escape(trailerCheck ? trailerCheck.expected.hashItmRdmCardNumber : '')}|${escape(trailerCheck ? trailerCheck.expected.hashItmRdmPoints : '')}|${escape(trailerCheck ? trailerCheck.expected.hashItmRdmQuantity : '')}|${escape(trailerCheck ? String(trailerCheck.expected.recordCount).padStart(10, '0') : '')}</code></td></tr>
    </tbody>
  </table>

  <h3>DT records (first 20 of ${escape(parsed ? parsed.details.length : 0)})</h3>
  <table>
    <thead><tr><th>line</th><th>itmRdmDate</th><th>Reference</th><th>Card</th><th>Pool</th>
      <th>Partner</th><th>ItemCode</th><th>Points</th><th>Qty</th><th>Status</th><th>StatusDesc</th>
      <th>StatusUpdate</th><th>UserId</th></tr></thead>
    <tbody>${detailSampleRows}</tbody>
  </table>

  <h3>Raw content${exportLines.length > MAX_RAW_LINES
    ? ` (first ${MAX_RAW_LINES} of ${exportLines.length} lines)` : ''}</h3>
  <pre style="max-height:420px;overflow:auto;background:#f4f6f8;border:1px solid #d2d6dc;padding:8px;font-size:12px">${escape(rawShown.join('\n'))}</pre>

  <h2>Parser warnings</h2>
  <ul>${parsed && parsed.warnings.length
    ? parsed.warnings.map((w) => `<li>${escape(w)}</li>`).join('')
    : '<li>none</li>'}</ul>
</body></html>`;

  fs.writeFileSync(out, html);
  log(`Dashboard written: ${out}`);
}
