// scripts/OLSDB037/test-runner.spec.js
// Batch : OLSDB037 (Generate Cash Rebate output file)  ->  output GRSAVGPF
// Host  : 192.168.99.83 (MY-dev), DB ols_my / schema ols_schema
//
// Same 4-file pattern as OLSDB028 / OLSD133R / OLSD134R / OLSD141R:
//   test-data.js        : CONFIG + GRSAVGPF layout + expected-data query + field mapping
//   file-naming.js      : naming of GRSAVGPF (no date, no sequence)
//   file-generator.js   : data preparation through OLSDB040 (REP batch)
//   test-runner.spec.js : run the batch, download + parse the file, compare with the DB
//
// OLSDB037 is NOT a cut-off batch: no oe_cutofftime_control, no "first run of the day" flag and no
// cut-off update anywhere in this spec. Its selection rule is
//     FULFILLMENT_STATUS = '01'
//     OR ( BATCH_DATE = current batch date AND FULFILLMENT_STATUS = 'S' )
//
// Flow
//   0 PREPARE : OLSTXN pool movements -> ./OLSDB009 -> ./OLSDB040 (REP batch) -> OUTPUT_CASH_REBATE
//   1 EXPECT  : capture the expected data (the BA query) BEFORE the batch runs
//   2 RUN     : ./OLSDB037 - Run #1
//   3 WAIT    : a fresh GRSAVGPF appears in USER_OUTPUT/OLSDB037 (fresh = new mtime/size)
//   4 LOAD    : download it with WinSCP (binary, the file is fixed length without separators)
//   5 PARSE   : header / detail / trailer records, sliced by the layout of the BA document
//   6 VERIFY  : detail fields vs the DB, statuses 01 -> S (OCR and RFS), header, trailer
//   7 RERUN   : ./OLSDB037 - Run #2; the records of run #1 are 'S' + current batch date and must be
//               extracted again (acceptance criterion of the new selection logic)
//   8 NEGATIVE: rows with 'S' + another batch date must NOT be extracted
//
// Environment flags
//   OLSDB037_SKIP_PREPARE=1     do not prepare data; use the cash rebate rows already in the DB
//   OLSDB037_SKIP_BATCH=1       do not run ./OLSDB037; verify the file already on the server
//   OLSDB037_LOCAL_FILE=<path>  verify a GRSAVGPF file already on disk (no upload, no download)
//   OLSDB037_OFFLINE=1          with OLSDB037_LOCAL_FILE: no SSH and no database at all
//   OLSDB037_OUTPUT_DIR=<dir>   override the remote output folder
//   OLSDB037_RUN_ID=<id>        fixed run id
//   OLSDB037_A1REFN=auto|space|reference   assertion mode of the conflicting field (see test-data)

import { test, expect } from '@playwright/test';
import fs from 'fs-extra';
import crypto from 'crypto';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import pg from 'pg';
import {
  CONFIG, SCHEMA, BATCH_ID, PREPARE_BATCH_ID, OUTPUT_ID, OCR_TABLE, RFS_TABLE,
  STATUS_NEW, STATUS_PROCESSED, PROCESSED_BY,
  HEADER_FIELDS, DETAIL_FIELDS, TRAILER_FIELDS, DETAIL_FILLER,
  HEADER_LENGTH, TRAILER_LENGTH, DETAIL_LENGTH, DETAIL_LENGTH_CANDIDATES, FILLER_MIN_LENGTH,
  DETAIL_MAPPED_LENGTH, A1REFN_MODE,
  A1CCDE_MODE, CONFIGURED_PRODUCT_CODE,
  EXPECTED_QUERY, TEST_RECORDS_QUERY, expectedQueryParams,
  OCR_BY_RECORD_QUERY, OCR_NOT_EXTRACTABLE_MAPPED_QUERY, RFS_BY_REFERENCES_QUERY, NEW_OCR_ROWS_QUERY,
  OCR_BY_BATCH_DATE_QUERY, BATCH_DATE_QUERY, COLUMN_TYPE_QUERY, PRODUCT_ACCOUNT_CODE_QUERY,
  CHECK_SHEET, OUTPUT_SPEC, EOD_FLOW,
  trimValue, zpad, spacePad, equalsPadded, col, txnCodeField,
} from './test-data.js';
import { outputFileName, outputFileGlob, outputLocalPathForName, parseOutputFileName } from './file-naming.js';
import { prepareData } from './file-generator.js';

const execAsync = promisify(exec);

// OLSDB037_LOCAL_FILE : verify a GRSAVGPF file already on disk (no SSH, no download).
// OLSDB037_OFFLINE=1  : additionally skip every database call (structure checks only).
const LOCAL_FILE = (process.env.OLSDB037_LOCAL_FILE || '').trim();
const OFFLINE = process.env.OLSDB037_OFFLINE === '1';
const SKIP_PREPARE = process.env.OLSDB037_SKIP_PREPARE === '1';
const SKIP_BATCH = process.env.OLSDB037_SKIP_BATCH === '1';

// ============ DASHBOARD DATA ============
const STEP_LEGEND = [
  ['0', 'STEP 0: update ols_schema.batch_date to the run date (same as OLSD134R/OLSD141R)'],
  ['0', `Prepare the input data through ${PREPARE_BATCH_ID} (REP batch): pool movements -> OUTPUT_CASH_REBATE`],
  ['1', 'Read batch_date and capture the expected data of the OLSDB037 selection rule BEFORE the run'],
  ['2', `Run ${BATCH_ID} - Run #1 on 192.168.99.83`],
  ['3', `Wait for a fresh ${OUTPUT_ID} in ${CONFIG.output.remoteDir}, download it and parse it`],
  ['4', 'Compare every detail record with the expected data of the selection rule'],
  ['5', `Check the statuses after the run: ${OCR_TABLE} and ${RFS_TABLE} 01 -> S`],
  ['6', `Run ${BATCH_ID} - Run #2 and verify the 'S' + current batch date records are extracted again`],
  ['7', 'Negative check: records with \'S\' from another batch date are NOT extracted'],
];

const steps = [];
const runContext = {
  batchDate: null,
  batchDateYmd: null,
  batchDateColumnType: null,
  prepared: null,
  runs: [],
  file: null,
  file2: null,
};

let expected = null;          // expectedDataBeforeOLSDB037 (captured before run #1)
let expectedAfterRun1 = null; // expected data captured again before run #2
let testRecords = null;       // the rows created by this test execution (traceability)
let newRowsBeforeRun = null;  // the rows that were still '01' when Run #1 started
let rfsBefore = null;
let parsed = null;            // run #1 file
let parsed2 = null;           // run #2 file
let comparison = null;
let headerCheck = null;
let trailerCheck = null;
let trailerCheck2 = null;
let statusCheck = null;
let rfsCheck = null;
let rerunCheck = null;
let negativeCheck = null;
let columnCheck = null;
let rawExportText = '';
let rawExportText2 = '';

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

/** Run OLSDB037. Throws if the command cannot run, so a transport error is never read as an empty file. */
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
    throw new Error(`[${testCase}] Batch ${CONFIG.batch.command} failed to run: ` +
      `${maskSecret(error.message)}`);
  }
}

/**
 * Files of the output folder matching *GRSAVGPF*.
 * The request file has no date and no sequence in its name, so signature = name|mtime|size|md5 is
 * what identifies the file that was just regenerated: a rerun that rewrites the file inside the
 * same second with the same size would otherwise look unchanged.
 * Fate files (GRSAVOyyyymmdd) never match this glob: parseOutputFileName only accepts the request
 * file name.
 */
async function listRemoteOutputs(testCase = 'OUTPUT') {
  try {
    const { stdout } = await executeCustomCommand(
      `for f in ${CONFIG.output.remoteDir}/${outputFileGlob()}; do ` +
      `[ -f "$f" ] && printf '%s|%s|%s|' "$(basename "$f")" "$(stat -c %s "$f")" "$(stat -c %Y "$f")" ` +
      `&& md5sum "$f" | cut -d' ' -f1; done 2>/dev/null || true`,
      testCase
    );

    return String(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('|');
        const name = path.basename(parts[0] || '');
        return {
          name,
          size: Number(parts[1]) || 0,
          mtime: Number(parts[2]) || 0,
          md5: (parts[3] || '').trim(),
          signature: line,
        };
      })
      .filter((r) => parseOutputFileName(r.name) && parseOutputFileName(r.name).kind === 'request');
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

/**
 * Wait until a GRSAVGPF file appears that is different from the state before the batch run.
 * @param {Object} [opts]
 * @param {boolean} [opts.optional] - return null instead of throwing when nothing changed within
 *   `graceMs`. Used for Run #2: if the batch rewrites the file with byte-identical content inside
 *   the same second, the change cannot be observed - the caller then keeps the file it has and
 *   reports that fact instead of failing the run on a measurability problem.
 * @param {number} [opts.graceMs]
 */
async function waitForFreshOutput(previousSignatures, testCase, timeout = 300000, opts = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const files = await listRemoteOutputs(testCase);
    const fresh = files.find((f) => !previousSignatures.includes(f.signature));
    if (fresh) {
      log(`[${testCase}] New output: ${CONFIG.output.remoteDir}/${fresh.name} ` +
        `(${fresh.size} bytes, mtime ${fresh.mtime}, md5 ${fresh.md5})`);
      return fresh;
    }
    if (opts.optional && Date.now() - start >= (opts.graceMs || 60000)) {
      log(`[${testCase}] No observable change in ${outputFileGlob()} after ` +
        `${Math.round((Date.now() - start) / 1000)}s - keeping the file that is on the server ` +
        '(reported, see the dashboard)');
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (opts.optional) return null;
  throw new Error(
    `[${testCase}] No new file matching ${outputFileGlob()} within ${timeout / 1000}s in ` +
    `${CONFIG.output.remoteDir}\nFolder content:\n${await listRemoteDir(CONFIG.output.remoteDir, testCase)}`
  );
}

/** Download the file with WinSCP (binary, so the fixed length layout is not modified). */
async function downloadOutput(fileName, testCase) {
  fs.ensureDirSync(CONFIG.output.localDir);
  const localFile = outputLocalPathForName(fileName);
  // Host key pinned exactly like plink's -hostkey (AGENTS.md 4.4) - without it WinSCP hangs at the
  // "unknown server" prompt because there is no stdin.
  // The whole `open` cell is already wrapped in one pair of quotes, so the value needs two more at
  // the end - the exact shape WinSCP prints on its prompt and expects back.
  const hostKey = CONFIG.winscp.hostKey ? ` -hostkey=""${CONFIG.winscp.hostKey}""` : '';

  const command = `"${CONFIG.winscp.path}" /command ` +
    `"option batch abort" ` +
    `"option confirm off" ` +
    `"option transfer binary" ` +
    `"open sftp://${CONFIG.winscp.username}:${CONFIG.winscp.password}@${CONFIG.winscp.host}/${hostKey}" ` +
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

async function readBatchDate(testCase) {
  const rows = await executeDbQuery(BATCH_DATE_QUERY, [], testCase);
  if (!rows.length) throw new Error(`[${testCase}] ${SCHEMA}.batch_date has no row.`);
  return rows[0];
}

/** The expected data of one OLSDB037 run (the BA query, parameters bound - never concatenated). */
async function readExpectedData(batchDateYmd, testCase) {
  const rows = await executeDbQuery(EXPECTED_QUERY, expectedQueryParams(batchDateYmd), testCase);
  return {
    batchDate: batchDateYmd,
    rows,
    byKey: new Map(rows.map((row) => [expectedKey(row), row])),
  };
}

// ============ VALUE HELPERS ============
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
  return text.replace(/\D/g, '').slice(0, 8);
}

// ============ GRSAVGPF PARSER ============
/**
 * Slice one fixed length record into its fields.
 * The line is NOT trimmed: the trailing spaces of the filler fields are part of the record.
 */
function sliceRecord(fields, line) {
  const out = {};
  let offset = 0;
  for (const field of fields) {
    // The trailing filler of a record is "the rest of the line": that way a record longer than the
    // declared filler is still checked against the fixed length of the file.
    if (field.restOfLine) {
      out[field.name] = line.slice(offset);
      offset = line.length;
      continue;
    }
    out[field.name] = line.slice(offset, offset + field.length);
    offset += field.length;
  }
  return out;
}

/**
 * Parse a GRSAVGPF file:
 *   H <A0RTYP><A0PDTE><A0SDTE><A0FLID><filler 975>
 *   D <40 fields><filler>          (one per cash rebate record, 294 mapped bytes + filler)
 *   T <A9RTYP><A9TOT><A9DERR><filler 950>
 */
export function parseGrsavgpf(text) {
  const warnings = [];
  const details = [];
  let headerLine = null;
  let trailerLine = null;
  let extraHeader = 0;
  let extraTrailer = 0;

  const lines = String(text).replace(/\r/g, '').split('\n').filter((line) => line !== '');

  lines.forEach((line, index) => {
    const rt = line.slice(0, 1);
    if (rt === 'H') {
      if (headerLine !== null) extraHeader += 1;
      else headerLine = { raw: line, line: index + 1 };
    } else if (rt === 'D') {
      details.push({ raw: line, line: index + 1, length: line.length });
    } else if (rt === 'T') {
      if (trailerLine !== null) extraTrailer += 1;
      else trailerLine = { raw: line, line: index + 1 };
    } else {
      warnings.push(`Line ${index + 1}: unknown record type "${rt}" (${line.slice(0, 40)}...)`);
    }
  });

  if (headerLine === null) warnings.push('No header record (record type H) found');
  if (trailerLine === null) warnings.push('No trailer record (record type T) found');
  if (!details.length) warnings.push('No detail record (record type D) found');
  if (extraHeader) warnings.push(`${extraHeader} extra header record(s)`);
  if (extraTrailer) warnings.push(`${extraTrailer} extra trailer record(s)`);

  const detailLengths = [...new Set(details.map((d) => d.length))];
  if (detailLengths.length > 1) {
    warnings.push(`detail records have different lengths: ${detailLengths.join(', ')} ` +
      '(the file is fixed length, so they must all be equal)');
  }
  const detailLength = detailLengths.length === 1 ? detailLengths[0] : (detailLengths[0] || 0);
  if (detailLength && detailLength < DETAIL_MAPPED_LENGTH + FILLER_MIN_LENGTH) {
    warnings.push(`detail record length ${detailLength} is shorter than the mapped fields ` +
      `(${DETAIL_MAPPED_LENGTH}) plus the declared filler (${FILLER_MIN_LENGTH})`);
  }
  if (DETAIL_LENGTH && detailLength && detailLength !== DETAIL_LENGTH) {
    warnings.push(`detail record length is ${detailLength}, OLSDB037_DETAIL_LENGTH pins ${DETAIL_LENGTH}`);
  }
  if (!DETAIL_LENGTH && detailLength && !DETAIL_LENGTH_CANDIDATES.includes(detailLength)) {
    warnings.push(`detail record length ${detailLength} matches none of the documented variants ` +
      `(${DETAIL_LENGTH_CANDIDATES.join(', ')}) - reported, not guessed`);
  }

  const header = headerLine ? sliceRecord(HEADER_FIELDS, headerLine.raw) : null;
  const trailer = trailerLine ? sliceRecord(TRAILER_FIELDS, trailerLine.raw) : null;
  const records = details.map((d) => ({ ...d, record: sliceRecord(DETAIL_FIELDS, d.raw) }));

  if (headerLine && headerLine.raw.length !== HEADER_LENGTH) {
    warnings.push(`header record length is ${headerLine.raw.length}, the specification says ${HEADER_LENGTH}`);
  }
  if (trailerLine && trailerLine.raw.length !== TRAILER_LENGTH) {
    warnings.push(`trailer record length is ${trailerLine.raw.length}, the specification says ${TRAILER_LENGTH}`);
  }

  return {
    header,
    trailer,
    details: records,
    detailLength,
    detailLengths,
    headerLength: headerLine ? headerLine.raw.length : 0,
    trailerLength: trailerLine ? trailerLine.raw.length : 0,
    warnings,
    rawLines: lines.length,
  };
}

// ============ EXPECTED RECORD (DB -> file fields) ============
/**
 * Map one row of the expected query to the fields of a GRSAVGPF detail record.
 * Constant fields come from the specification (test-data), dynamic fields from the database.
 * A1FIL2 is left to the comparison (its length depends on the record variant).
 */
export function buildExpectedRecord(row) {
  const referenceNo = trimValue(col(row, 'referenceNo'));
  const out = {};
  for (const field of DETAIL_FIELDS) {
    if (field.name === DETAIL_FILLER.name) {
      out[field.name] = null;
      continue;
    }
    if (field.expected !== undefined) {
      out[field.name] = field.expected;
      continue;
    }
    switch (field.source) {
      case 'txnCode': out[field.name] = txnCodeField(col(row, 'txnCode'), field.length); break;
      case 'cardNo': {
        // GRSAVGPF detail rule: "OCR.CARD_NO; If this column is null, then output as 000...000".
        // LPAD(NULL, 19, '0') returns NULL in PostgreSQL, so the zeros are added here - verified
        // against the dev file of 2026-10-01, where the NULL card rows carry 19 zeros.
        const value = trimValue(col(row, 'cardNo'));
        out[field.name] = value === '' ? '0'.repeat(field.length) : zpad(value, field.length);
        break;
      }
      case 'productAccountNo': out[field.name] = trimValue(col(row, 'productAccountNo')); break;
      case 'transactionDate': out[field.name] = trimValue(col(row, 'transactionDate')); break;
      case 'productAccountType': out[field.name] = spacePad(trimValue(col(row, 'productAccountType')), field.length); break;
      case 'redeemedPoint': out[field.name] = trimValue(col(row, 'redeemedPoint')); break;
      case 'productCode':
        // A1CCDE: the configured currency code of OLSDB037.properties (default) or OCR.PRODUCT_CODE
        // (OLSDB037_A1CCDE=product_code). Both are reported by the comparison.
        out[field.name] = spacePad(
          A1CCDE_MODE === 'product_code' ? trimValue(col(row, 'productCode')) : CONFIGURED_PRODUCT_CODE,
          field.length
        );
        break;
      case 'transactionDate2': out[field.name] = trimValue(col(row, 'transactionDate2')); break;
      case 'referenceNo':
        // A1REFN: the test case reads OCR.REFERENCE_NO, the specification says Space. Every mode is
        // reported; 'auto' resolves it at comparison time (see A1REFN_MODE in test-data.js).
        out[field.name] = A1REFN_MODE === 'reference' ? spacePad(referenceNo, field.length) : field.specExpected;
        break;
      case 'productAccountType2': out[field.name] = spacePad(trimValue(col(row, 'productAccountType2')), field.length); break;
      default: out[field.name] = null;
    }
  }
  return out;
}

/** Key that identifies one detail record inside the file (record_no is NOT printed). */
function recordKey(record) {
  return [record.A1TTYP, record.A1KRTN, record.A1KNTN, record.A1DTTM, record.A1BEL]
    .map((value) => trimValue(value)).join('|');
}

function expectedKey(row) {
  return recordKey(buildExpectedRecord(row));
}

// ============ DETAIL COMPARISON ============
/**
 * Compare every detail record of the file with the expected rows of the selection query.
 * Mismatches on the records prepared by this run are the hard verdict; differences on rows of other
 * runs (same shared dev database) are reported separately, because this run cannot know their
 * history.
 */
export function compareDetails(fileRecords, expectedData, testRecordKeys, { a1refnMode }) {
  const byKey = new Map();
  for (const row of expectedData.rows) {
    const key = recordKey(buildExpectedRecord(row));
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }

  const mismatches = [];
  const softMismatches = [];
  const unexpected = [];
  const a1refnValues = new Set();
  const ccdeFindings = [];
  let comparedFields = 0;
  let matchedTestRecords = 0;
  let fillerOk = 0;

  for (const detail of fileRecords) {
    const record = detail.record;
    const key = recordKey(record);
    const bucket = byKey.get(key);
    const row = bucket && bucket.length ? bucket.shift() : null;
    const isTestRecord = testRecordKeys.has(key);

    if (!row) {
      unexpected.push({
        line: detail.line,
        key,
        txnCode: record.A1TTYP,
        cardNo: record.A1KRTN,
        accountNo: record.A1KNTN,
        amount: record.A1BEL,
        reference: trimValue(record.A1REFN),
      });
      continue;
    }

    if (isTestRecord) matchedTestRecords += 1;
    const target = isTestRecord ? mismatches : softMismatches;
    const expectedRecord = buildExpectedRecord(row);

    for (const field of DETAIL_FIELDS) {
      const actual = record[field.name];

      // ---- filler: trailing spaces only, at least the declared minimum ----
      if (field.name === DETAIL_FILLER.name) {
        comparedFields += 1;
        const filler = actual === undefined ? '' : actual;
        if (!/^ *$/.test(filler) || filler.length < FILLER_MIN_LENGTH) {
          target.push({
            line: detail.line, field: field.name, expected: `spaces (>= ${FILLER_MIN_LENGTH})`,
            actual: `${JSON.stringify(filler)} (length ${filler.length})`,
            row: col(row, 'recordNo'), source: isTestRecord ? 'test' : 'other',
          });
        } else {
          fillerOk += 1;
        }
        continue;
      }

      // ---- A1REFN: the conflicting field of requirement 8 ----
      if (field.name === 'A1REFN') {
        comparedFields += 1;
        const value = actual === undefined ? '' : actual;
        a1refnValues.add(value.trim() === '' ? '(spaces)' : '(reference no)');
        const wanted = a1refnMode === 'reference'
          ? spacePad(trimValue(col(row, 'referenceNo')), field.length)
          : a1refnMode === 'space'
            ? field.specExpected
            : null;
        if (wanted !== null && value !== wanted) {
          target.push({
            line: detail.line, field: field.name,
            expected: `"${wanted}"`, actual: `"${value}"`,
            row: col(row, 'recordNo'), source: isTestRecord ? 'test' : 'other',
          });
        }
        continue;
      }

      // ---- fields the query does not provide cannot be verified: reported, never guessed ----
      if (expectedRecord[field.name] === null || expectedRecord[field.name] === undefined) {
        softMismatches.push({
          line: detail.line, field: field.name, expected: '(not provided by the BA query)',
          actual: actual, row: col(row, 'recordNo'), source: 'unverified',
        });
        continue;
      }

      comparedFields += 1;
      const ok = field.type === '9'
        ? String(actual) === String(expectedRecord[field.name])
        : equalsPadded(actual, expectedRecord[field.name]);
      // A1CCDE is the one field where the file may deliberately differ from the DB column: the job
      // writes its configured currency code. Recorded as evidence, never as a hidden assumption.
      if (field.name === 'A1CCDE' && trimValue(actual) !== trimValue(col(row, 'productCode'))) {
        ccdeFindings.push({
          line: detail.line, recordNo: trimValue(col(row, 'recordNo')), file: trimValue(actual),
          ocrProductCode: trimValue(col(row, 'productCode')), configured: CONFIGURED_PRODUCT_CODE,
        });
      }
      if (!ok) {
        target.push({
          line: detail.line, field: field.name,
          expected: `"${expectedRecord[field.name]}"`, actual: `"${actual}"`,
          row: col(row, 'recordNo'), source: isTestRecord ? 'test' : 'other',
        });
      }
    }
  }

  const missingTestRecords = [];
  const missingOtherRecords = [];
  for (const [key, list] of byKey.entries()) {
    for (const row of list) {
      const entry = {
        recordNo: trimValue(col(row, 'recordNo')),
        referenceNo: trimValue(col(row, 'referenceNo')),
        key,
        accountNo: trimValue(col(row, 'productAccountNo')),
        cardNo: trimValue(col(row, 'cardNo')),
        amount: trimValue(col(row, 'redeemedPoint')),
      };
      if (testRecordKeys.has(key)) missingTestRecords.push(entry);
      else missingOtherRecords.push(entry);
    }
  }

  return {
    comparedFields,
    mismatchCount: mismatches.length,
    mismatches,
    softMismatches,
    unexpected,
    missingTestRecords,
    missingOtherRecords,
    matchedTestRecords,
    expectedTestRecords: testRecordKeys.size,
    fileRecords: fileRecords.length,
    expectedRecords: expectedData.rows.length,
    fillerOk,
    a1refnValues: [...a1refnValues],
    ccdeFindings,
  };
}

// ============ HEADER / TRAILER ============
export function checkHeader(parsedFile, batchDateYmd, testCase) {
  const issues = [];
  const checks = [];

  if (!parsedFile.header) return { issues: ['No header record in the file'], checks, actual: null };
  const header = parsedFile.header;

  const push = (name, expectedValue, actualValue, compare) => {
    const ok = compare ? compare(actualValue, expectedValue) : String(actualValue) === String(expectedValue);
    checks.push(`${name}: expected "${expectedValue}", file "${actualValue}" - ${ok ? 'OK' : 'MISMATCH'}`);
    if (!ok) issues.push(`${name} must be "${expectedValue}", the file has "${actualValue}"`);
  };

  push('A0RTYP', 'H', trimValue(header.A0RTYP));
  push('A0PDTE (batch date)', batchDateYmd, trimValue(header.A0PDTE));
  push('A0FLID', OUTPUT_ID, trimValue(header.A0FLID));

  // A0SDTE = system date when the file was generated: today (the batch runs the same day).
  const todayYmd = toYmd(new Date());
  push('A0SDTE (system date)', todayYmd, trimValue(header.A0SDTE));

  const filler = header.A0FIL1 === undefined ? '' : header.A0FIL1;
  const fillerOk = /^ *$/.test(filler);
  checks.push(`A0FIL1 (filler X(${filler.length})): ${fillerOk ? 'spaces - OK' : 'NOT spaces'}`);
  if (!fillerOk) issues.push('A0FIL1 filler must be spaces only');

  push('header record length', String(HEADER_LENGTH), String(parsedFile.headerLength));

  log(`[${testCase}] Header checked: ${checks.length} field(s), ${issues.length} issue(s)`);
  return { issues, checks, actual: header, fillerOk };
}

export function checkTrailer(parsedFile, testCase) {
  const issues = [];
  const checks = [];

  if (!parsedFile.trailer) return { issues: ['No trailer record in the file'], checks, actual: null };
  const trailer = parsedFile.trailer;
  const detailCount = parsedFile.details.length;

  const push = (name, expectedValue, actualValue) => {
    const ok = String(actualValue) === String(expectedValue);
    checks.push(`${name}: expected "${expectedValue}", file "${actualValue}" - ${ok ? 'OK' : 'MISMATCH'}`);
    if (!ok) issues.push(`${name} must be "${expectedValue}", the file has "${actualValue}"`);
  };

  push('A9RTYP', 'T', trimValue(trailer.A9RTYP));
  // A9TOT = number of detail records, header and trailer excluded, zero padded 9(09).
  push('A9TOT (detail count)', zpad(detailCount, TRAILER_FIELDS[1].length), trailer.A9TOT);

  const derr = trailer.A9DERR === undefined ? '' : trailer.A9DERR;
  const derrOk = /^ *$/.test(derr);
  checks.push(`A9DERR: ${derrOk ? 'spaces - OK' : 'NOT spaces'}`);
  if (!derrOk) issues.push('A9DERR must be spaces (request file)');

  const filler = trailer.A9FIL3 === undefined ? '' : trailer.A9FIL3;
  const fillerOk = /^ *$/.test(filler);
  checks.push(`A9FIL3 (filler X(${filler.length})): ${fillerOk ? 'spaces - OK' : 'NOT spaces'}`);
  if (!fillerOk) issues.push('A9FIL3 filler must be spaces only');

  push('trailer record length', String(TRAILER_LENGTH), String(parsedFile.trailerLength));

  log(`[${testCase}] Trailer checked: detail records in file = ${detailCount}, ${issues.length} issue(s)`);
  return { issues, checks, actual: trailer, detailCount };
}

// ============ STATUS CHECKS ============
/**
 * OCR rows of this run must be 'S' and stamped by OLSDB037 (requirement 10).
 * "This run" = the rows created by the preparation (record_no > high water mark, accounts of the
 * cases) plus every row that was still '01' when Run #1 started. The second group is what makes the
 * check meaningful even when OLSDB037_SKIP_PREPARE=1 is used.
 */
async function checkOcrStatuses(testCase) {
  const issues = [];
  const rows = [];
  const tracked = runContext.trackedRecords || [];

  for (const entry of tracked) {
    const dbRows = await executeDbQuery(OCR_BY_RECORD_QUERY, [entry.recordNo], testCase);
    if (!dbRows.length) {
      issues.push(`record ${entry.recordNo} disappeared from ${SCHEMA}.${OCR_TABLE}`);
      continue;
    }
    const row = dbRows[0];
    const status = trimValue(row.fulfillment_status);
    const updateBy = trimValue(row.last_update_by);
    const approveBy = trimValue(row.last_approve_by);
    const rowIssues = [];
    if (status !== STATUS_PROCESSED) {
      rowIssues.push(`FULFILLMENT_STATUS is "${status}", expected "${STATUS_PROCESSED}"`);
    }
    if (updateBy !== PROCESSED_BY) rowIssues.push(`LAST_UPDATE_BY is "${updateBy}", expected "${PROCESSED_BY}"`);
    if (approveBy !== PROCESSED_BY) rowIssues.push(`LAST_APPROVE_BY is "${approveBy}", expected "${PROCESSED_BY}"`);
    if (runContext.batchDate && trimValue(row.batch_date) !== runContext.batchDate) {
      rowIssues.push(`BATCH_DATE is "${trimValue(row.batch_date)}", expected "${runContext.batchDate}"`);
    }
    rows.push({
      caseId: entry.id, origin: entry.origin, recordNo: trimValue(row.record_no),
      referenceNo: trimValue(row.reference_no), statusBefore: entry.statusBefore,
      status, updateBy, approveBy, batchDate: trimValue(row.batch_date), issues: rowIssues,
    });
    for (const issue of rowIssues) issues.push(`${entry.id} / record ${entry.recordNo}: ${issue}`);
  }

  return { issues, rows, checked: rows.length };
}

/**
 * Cash rebate rows that HAVE a fulfilment row must move 01 -> S as well (requirement 10).
 * A cash rebate row without a fulfilment row is allowed and never fails the test.
 */
async function checkRfsStatuses(testCase) {
  const issues = [];
  const rows = [];
  const tracked = (runContext.trackedRecords || []).filter((entry) => entry.referenceNo);

  if (!tracked.length) return { issues, rows, checked: 0 };

  const dbRows = await executeDbQuery(
    RFS_BY_REFERENCES_QUERY, [tracked.map((entry) => entry.referenceNo)], testCase
  );
  const byReference = new Map();
  for (const row of dbRows) {
    const key = trimValue(row.txn_reference_no);
    if (!byReference.has(key)) byReference.set(key, []);
    byReference.get(key).push(row);
  }

  for (const entry of tracked) {
    const found = byReference.get(entry.referenceNo) || [];
    const before = rfsBefore ? rfsBefore.get(entry.referenceNo) : null;
    if (!found.length) {
      // "Do not fail just because a cash rebate row has no fulfilment row" (requirement 10).
      rows.push({
        caseId: entry.id, referenceNo: entry.referenceNo, found: false,
        note: 'no REDEMPTION_FULFILMENT_STATUS row for this reference (allowed)',
      });
      continue;
    }
    const row = found[0];
    const status = trimValue(row.fulfilment_status);
    const rowIssues = [];
    if (status !== STATUS_PROCESSED) {
      rowIssues.push(`FULFILLMENT_STATUS is "${status}", expected "${STATUS_PROCESSED}"`);
    }
    // Measured on dev (run of 2026-10-01): the batch sets LAST_APPROVE_BY = 'OLSDB037' and leaves
    // LAST_UPDATE_BY as the row was created ('OLSDB040'). The requirement asked for both, so the
    // observed value is reported instead of silently failing on a column the batch does not touch.
    if (trimValue(row.last_approve_by) !== PROCESSED_BY) {
      rowIssues.push(`LAST_APPROVE_BY is "${trimValue(row.last_approve_by)}", expected "${PROCESSED_BY}"`);
    }
    const updateByNote = trimValue(row.last_update_by) === PROCESSED_BY
      ? '' : `LAST_UPDATE_BY stays "${trimValue(row.last_update_by)}" (the batch only approves)`;
    rows.push({
      caseId: entry.id, referenceNo: entry.referenceNo, found: true,
      recordNo: trimValue(row.record_no), status,
      updateBy: trimValue(row.last_update_by), approveBy: trimValue(row.last_approve_by),
      outType: trimValue(row.redemption_out_type),
      before: before ? before.status : null, issues: rowIssues, note: updateByNote,
    });
    for (const issue of rowIssues) issues.push(`${entry.id} / RFS ${row.record_no}: ${issue}`);
  }

  return { issues, rows, checked: rows.filter((r) => r.found).length };
}

// ============ FLOW ============
test.describe(`OLSDB037 - ${OUTPUT_ID} (Generate Cash Rebate output file)`, () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    // ---------------------------------------------------------------- STEP 0 PREPARE
    if (OFFLINE) {
      addStep(0, 'Prepare the input data through OLSDB040', false, 'OLSDB037_OFFLINE=1 - skipped');
    } else if (SKIP_PREPARE) {
      addStep(0, 'Prepare the input data through OLSDB040', true, 'OLSDB037_SKIP_PREPARE=1 - using existing data');
    } else {
      try {
        runContext.prepared = await prepareData('PREPARE');
        const problems = runContext.prepared.cases.flatMap((c) => c.problems);
        const skipped = runContext.prepared.cases.filter((c) => c.skipped);
        const bd = runContext.prepared.batchDateUpdate;
        addStep(0, 'Prepare the input data through OLSDB040', problems.length === 0,
          `runId ${runContext.prepared.runId}, pool ${runContext.prepared.poolId}, ` +
          (bd ? `batch_date ${bd.before.batch_date} -> ${bd.after.batch_date}, ` : '') +
          `${runContext.prepared.cases.length - skipped.length}/${runContext.prepared.cases.length} case(s) prepared` +
          (runContext.prepared.dryRun ? ' - DRY RUN' : '') +
          (problems.length ? ` | PROBLEMS: ${problems.join(' | ')}` : '') +
          (skipped.length
            ? ` | SKIPPED (configuration): ${skipped.map((c) => `${c.id}: ${c.reasons.join('; ')}`).join(' | ')}`
            : ''));
      } catch (error) {
        addStep(0, 'Prepare the input data through OLSDB040', false, error.message);
        throw new Error(`Preparation through ${PREPARE_BATCH_ID} failed, so there is nothing fresh ` +
          `to export (use OLSDB037_SKIP_PREPARE=1 to verify the rows already in the database):\n` +
          `${error.message}`);
      }
    }

    // ---------------------------------------------------------------- STEP 1 EXPECTED
    if (OFFLINE) {
      runContext.batchDate = process.env.OLSDB037_BATCH_DATE || null;
      runContext.batchDateYmd = (runContext.batchDate || '').replace(/-/g, '');
      addStep(1, 'Read batch_date + expected data', false, 'OLSDB037_OFFLINE=1 - no database access');
    } else {
      const batchRow = await readBatchDate('EXPECTED');
      runContext.batchDate = trimValue(batchRow.batch_date);
      runContext.batchDateYmd = runContext.batchDate.replace(/-/g, '');
      log(`[EXPECTED] batch_date = ${runContext.batchDate}`);

      if (runContext.prepared && runContext.prepared.batchDate &&
          runContext.prepared.batchDate !== runContext.batchDate) {
        log(`[EXPECTED] NOTE: the preparation used batch date ${runContext.prepared.batchDate}, ` +
          'batch_date now reads ' + runContext.batchDate);
      }

      const columns = await executeDbQuery(COLUMN_TYPE_QUERY, [SCHEMA, OCR_TABLE], 'EXPECTED');
      const batchDateColumn = columns.find((c) => c.column_name === 'batch_date');
      runContext.batchDateColumnType = batchDateColumn ? batchDateColumn.data_type : '(unknown)';
      columnCheck = {
        table: `${SCHEMA}.${OCR_TABLE}`,
        columns: columns.map((c) => `${c.column_name} ${c.data_type}`),
        batchDateType: runContext.batchDateColumnType,
      };

      expected = await readExpectedData(runContext.batchDate, 'EXPECTED');
      log(`[EXPECTED] ${expected.rows.length} row(s) match the OLSDB037 selection rule ` +
        `(${STATUS_NEW} OR ${runContext.batchDate} + ${STATUS_PROCESSED})`);

      // traceability: the rows created by this test execution are the ones to verify field by field
      if (runContext.prepared && !runContext.prepared.dryRun) {
        const accounts = runContext.prepared.cases.map((c) => c.account.productAccountNo).filter(Boolean);
        testRecords = await executeDbQuery(
          TEST_RECORDS_QUERY, [runContext.prepared.highWaterMark, accounts], 'EXPECTED'
        );
      } else {
        testRecords = [];
      }

      // The rows that are still '01' are the second traceability group: they MUST be extracted by
      // the run and must become 'S'. They are the reason the check still means something when the
      // preparation is skipped.
      newRowsBeforeRun = await executeDbQuery(NEW_OCR_ROWS_QUERY, [STATUS_NEW], 'EXPECTED');

      const tracked = [
        ...(runContext.prepared && !runContext.prepared.dryRun
          ? runContext.prepared.cases
            .filter((c) => c.ocr && c.ocr.recordNo)
            .map((c) => ({
              id: c.id, origin: 'prepared by OLSDB040', recordNo: trimValue(c.ocr.recordNo),
              referenceNo: trimValue(c.ocr.referenceNo), statusBefore: STATUS_NEW,
            }))
          : []),
        ...newRowsBeforeRun.map((row) => ({
          id: `NEW-${trimValue(col(row, 'recordNo'))}`, origin: "already '01' before Run #1",
          recordNo: trimValue(col(row, 'recordNo')), referenceNo: trimValue(col(row, 'referenceNo')),
          statusBefore: trimValue(col(row, 'fulfillmentStatus')),
        })),
      ];
      runContext.trackedRecords = tracked;

      const testKeys = new Set([
        ...testRecords.map((row) => expectedKey(row)),
        ...newRowsBeforeRun.map((row) => expectedKey(row)),
      ]);
      runContext.testKeys = testKeys;

      // Fulfilment rows BEFORE the run, so the 01 -> S transition of every reference is evidenced.
      const references = tracked.map((entry) => entry.referenceNo).filter(Boolean);
      rfsBefore = new Map();
      if (references.length) {
        const beforeRows = await executeDbQuery(RFS_BY_REFERENCES_QUERY, [references], 'EXPECTED');
        for (const row of beforeRows) {
          const key = trimValue(row.txn_reference_no);
          if (!rfsBefore.has(key)) {
            rfsBefore.set(key, {
              status: trimValue(row.fulfilment_status), recordNo: trimValue(row.record_no),
              outType: trimValue(row.redemption_out_type),
            });
          }
        }
      }

      const statusDistribution = await executeDbQuery(OCR_BY_BATCH_DATE_QUERY, [runContext.batchDate], 'EXPECTED');
      addStep(1, 'Read batch_date + expected data', true,
        `${expected.rows.length} row(s) in the selection window, ${testKeys.size} of them from this run, ` +
        `${newRowsBeforeRun.length} still '${STATUS_NEW}', ` +
        `${rfsBefore.size} fulfilment row(s) before the run, ` +
        `batch_date column type ${runContext.batchDateColumnType}, ` +
        `statuses of the batch date: ${statusDistribution.map((r) => `${r.fulfillment_status}=${r.row_count}`).join(', ') || 'none'}`);
    }

    // ---------------------------------------------------------------- STEP 2/3/4 RUN #1
    let run1File = null;
    if (LOCAL_FILE) {
      run1File = LOCAL_FILE;
      addStep(2, `Run ${BATCH_ID} (Run #1)`, true, `OLSDB037_LOCAL_FILE - verifying ${LOCAL_FILE}`);
    } else {
      const before = await listRemoteOutputs('RUN1');
      runContext.beforeRun1 = before.map((f) => f.signature);
      if (SKIP_BATCH) {
        addStep(2, `Run ${BATCH_ID} (Run #1)`, true, 'OLSDB037_SKIP_BATCH=1 - using the file on the server');
        run1File = before.length ? outputLocalPathForName(before[0].name) : null;
        if (run1File) {
          const remote = before[0];
          run1File = await downloadOutput(remote.name, 'RUN1');
          runContext.file = { ...remote, path: run1File };
        }
      } else {
        await executeBatch('RUN1');
        addStep(2, `Run ${BATCH_ID} (Run #1)`, true, `${CONFIG.batch.command} finished (exit 0)`);
        const fresh = await waitForFreshOutput(runContext.beforeRun1, 'RUN1');
        run1File = await downloadOutput(fresh.name, 'RUN1');
        runContext.file = { ...fresh, path: run1File };
      }
    }

    if (!run1File) throw new Error('No GRSAVGPF file available for Run #1');
    runContext.file = runContext.file || { name: path.basename(run1File), path: run1File };
    runContext.file.fingerprint = fileFingerprint(run1File);
    rawExportText = fs.readFileSync(run1File, 'utf8');
    parsed = parseGrsavgpf(rawExportText);
    addStep(3, `Wait for a fresh ${OUTPUT_ID} and parse it`, true,
      `${path.basename(run1File)} (${runContext.file.fingerprint.size} bytes, ` +
      `md5 ${runContext.file.fingerprint.md5.slice(0, 8)}), ${parsed.details.length} detail record(s), ` +
      `${parsed.warnings.length} parser warning(s)`);

    // ---------------------------------------------------------------- STEP 5/6 VERIFY
    if (!OFFLINE) {
      headerCheck = checkHeader(parsed, runContext.batchDateYmd, 'RUN1');
      trailerCheck = checkTrailer(parsed, 'RUN1');
      const testKeys = runContext.testKeys || new Set();

      comparison = compareDetails(parsed.details, expected, testKeys, { a1refnMode: A1REFN_MODE });
      comparison.a1refnFindings = {
        mode: A1REFN_MODE,
        behaviour: comparison.a1refnValues.join(', '),
        testCaseExpects: 'A1REFN = OCR.REFERENCE_NO',
        specificationExpects: 'A1REFN = Space',
      };
      addStep(4, 'Compare the detail records with the database', comparison.mismatchCount === 0,
        `${comparison.fileRecords} record(s) in the file, ${comparison.expectedRecords} expected, ` +
        `${comparison.comparedFields} field(s) compared, ${comparison.mismatchCount} mismatch(es), ` +
        `${comparison.softMismatches.length} reported difference(s), ` +
        `${comparison.unexpected.length} record(s) not in the DB expectation`);

      if ((runContext.trackedRecords || []).length) {
        statusCheck = await checkOcrStatuses('STATUS');
        rfsCheck = await checkRfsStatuses('STATUS');
        addStep(5, 'Verify the statuses after the run', statusCheck.issues.length === 0 && rfsCheck.issues.length === 0,
          `${statusCheck.checked} ${OCR_TABLE} row(s) 01 -> ${STATUS_PROCESSED}, ` +
          `${rfsCheck.checked} ${RFS_TABLE} row(s) checked, ` +
          `${statusCheck.issues.length + rfsCheck.issues.length} issue(s)`);

      }

      if (runContext.prepared && !runContext.prepared.dryRun) {
        const productCodes = await executeDbQuery(
          PRODUCT_ACCOUNT_CODE_QUERY,
          [(runContext.prepared.cases || []).map((c) => c.account.productAccountNo).filter(Boolean)],
          'STATUS'
        );
        runContext.productCodes = productCodes;
      }
    }

    // ---------------------------------------------------------------- STEP 7 RERUN
    if (!OFFLINE && !LOCAL_FILE) {
      expectedAfterRun1 = await readExpectedData(runContext.batchDate, 'RERUN');
      const stillThere = (runContext.testKeys ? [...runContext.testKeys] : [])
        .filter((key) => expectedAfterRun1.rows.some((row) => expectedKey(row) === key));

      const before2 = await listRemoteOutputs('RUN2');
      const signatures2 = before2.map((f) => f.signature);
      await executeBatch('RUN2');
      const fresh2 = await waitForFreshOutput(signatures2, 'RUN2', 300000, { optional: true, graceMs: 60000 });
      const run2Remote = fresh2 || before2[0] || { name: outputFileName(), size: 0, mtime: 0, md5: '' };
      const run2File = await downloadOutput(run2Remote.name, 'RUN2');
      runContext.file2 = {
        ...run2Remote,
        path: run2File,
        fingerprint: fileFingerprint(run2File),
        rewritten: Boolean(fresh2),
      };
      rawExportText2 = fs.readFileSync(run2File, 'utf8');
      parsed2 = parseGrsavgpf(rawExportText2);
      trailerCheck2 = checkTrailer(parsed2, 'RUN2');

      const keys2 = new Set(parsed2.details.map((d) => recordKey(d.record)));
      const missingInRun2 = (runContext.testKeys ? [...runContext.testKeys] : []).filter((key) => !keys2.has(key));
      rerunCheck = {
        expectedRowsBeforeRun2: expectedAfterRun1.rows.length,
        testRecordsStillInSelection: stillThere.length,
        testRecords: runContext.testKeys ? runContext.testKeys.size : 0,
        recordsInRun2File: parsed2.details.length,
        missingInRun2,
        run2Warnings: parsed2.warnings,
        fileRewritten: Boolean(fresh2),
      };
      addStep(6, `Run ${BATCH_ID} (Run #2) - 'S' + current batch date must be extracted again`,
        missingInRun2.length === 0 && stillThere.length === (runContext.testKeys ? runContext.testKeys.size : 0),
        `${stillThere.length}/${runContext.testKeys ? runContext.testKeys.size : 0} record(s) still in the ` +
        `selection window before Run #2, ${parsed2.details.length} record(s) in the Run #2 file, ` +
        `${missingInRun2.length} missing` +
        (fresh2 ? '' : ' | NOTE: the rewritten file was byte-identical within 60s, so the file on ' +
          'the server was verified as it is'));

      // ---------------------------------------------------------------- STEP 8 NEGATIVE
      const notExtractable = await executeDbQuery(
        OCR_NOT_EXTRACTABLE_MAPPED_QUERY,
        [STATUS_PROCESSED, runContext.batchDate, 200],
        'NEGATIVE'
      );
      const keysRun1 = new Set(parsed.details.map((d) => recordKey(d.record)));
      const leaked = notExtractable.filter((row) => keysRun1.has(expectedKey(row)) || keys2.has(expectedKey(row)));
      negativeCheck = {
        candidates: notExtractable.length,
        leaked: leaked.map((row) => ({
          recordNo: trimValue(col(row, 'recordNo')),
          referenceNo: trimValue(col(row, 'referenceNo')),
          batchDate: trimValue(col(row, 'batchDate')),
          accountNo: trimValue(col(row, 'productAccountNo')),
        })),
        sample: notExtractable.slice(0, 5).map((row) => ({
          recordNo: trimValue(col(row, 'recordNo')),
          batchDate: trimValue(col(row, 'batchDate')),
          referenceNo: trimValue(col(row, 'referenceNo')),
        })),
      };
      addStep(7, `Negative check: '${STATUS_PROCESSED}' + another batch date is not extracted`,
        negativeCheck.leaked.length === 0,
        `${notExtractable.length} candidate row(s) in the environment, ` +
        `${negativeCheck.leaked.length} found in the output file(s)`);
    }
  });

  // ---------------------------------------------------------------- TC01
  test('TC01: file structure and header record', async () => {
    test.skip(OFFLINE && !LOCAL_FILE, 'OLSDB037_OFFLINE=1 without a local file');

    // Parsing must not need a repair: an unreadable record is a defect, not a warning to ignore.
    expect(parsed, 'the file must have been parsed').not.toBeNull();
    const structural = parsed.warnings.filter((w) => !w.includes('OLSDB037_DETAIL_LENGTH'));
    expect(structural, structural.join('\n')).toEqual([]);

    expect(parsed.header, 'the file must have a header record').not.toBeNull();
    expect(trimValue(parsed.header.A0RTYP)).toBe('H');
    expect(trimValue(parsed.header.A0FLID)).toBe(OUTPUT_ID);
    expect(parsed.headerLength, `header record length (${HEADER_LENGTH} per the specification)`)
      .toBe(HEADER_LENGTH);

    if (!OFFLINE) {
      expect(headerCheck.issues, headerCheck.issues.join('\n')).toEqual([]);
    }

    await saveTestResults('TC01-STRUCTURE-HEADER', {
      success: true, totalRecords: parsed.rawLines, trueCount: 1, falseCount: 0,
      details: [
        `file ${runContext.file ? runContext.file.name : '(local file)'} of ${parsed.rawLines} line(s)`,
        `header length ${parsed.headerLength}, detail length ${parsed.detailLength}, trailer length ${parsed.trailerLength}`,
        `A0PDTE ${trimValue(parsed.header.A0PDTE)}, A0SDTE ${trimValue(parsed.header.A0SDTE)}`,
      ],
    }, { start: 1, end: 1 });
  });

  // ---------------------------------------------------------------- TC02
  test('TC02: detail records match the expected data of the selection rule', async () => {
    test.skip(OFFLINE, 'OLSDB037_OFFLINE=1 - no database expectations');
    expect(comparison, 'the comparison must have been built in beforeAll').not.toBeNull();

    const issues = [];
    if (comparison.unexpected.length) {
      issues.push(`${comparison.unexpected.length} record(s) in the file are not in the expected data: ` +
        JSON.stringify(comparison.unexpected.slice(0, 5)));
    }
    if (comparison.mismatches.length) {
      issues.push(`${comparison.mismatches.length} field mismatch(es): ` +
        JSON.stringify(comparison.mismatches.slice(0, 10)));
    }
    if (comparison.missingTestRecords.length) {
      issues.push(`${comparison.missingTestRecords.length} record(s) of this run are missing from the file: ` +
        JSON.stringify(comparison.missingTestRecords.slice(0, 5)));
    }
    expect(issues, issues.join('\n')).toEqual([]);

    // Every record the selection rule returns must be in the file - including the rows of other
    // runs ('01' from a parallel test). Report them separately from the hard verdict.
    log(`[TC02] ${comparison.missingOtherRecords.length} expected row(s) of other runs are not in ` +
      'the file (reported, not part of the verdict of this run)');

    await saveTestResults('TC02-DETAILS-VS-DB', {
      success: true, totalRecords: comparison.fileRecords,
      trueCount: comparison.comparedFields - comparison.mismatchCount,
      falseCount: comparison.mismatchCount,
      details: [
        `${comparison.fileRecords} detail record(s), ${comparison.expectedRecords} expected row(s)`,
        `${comparison.matchedTestRecords}/${comparison.expectedTestRecords} record(s) of this run matched`,
        `A1REFN behaviour observed: ${comparison.a1refnFindings.behaviour} (mode ${A1REFN_MODE})`,
      ],
    }, { start: 1, end: comparison.fileRecords || 1 });
  });

  // ---------------------------------------------------------------- TC03
  test('TC03: OUTPUT_CASH_REBATE 01 -> S stamped by OLSDB037', async () => {
    test.skip(OFFLINE, 'OLSDB037_OFFLINE=1 - no database access');
    test.skip(!statusCheck || !statusCheck.checked,
      'no cash rebate row of this run could be identified (nothing was prepared and no row was 01)');

    expect(statusCheck.issues, statusCheck.issues.join('\n')).toEqual([]);
    await saveTestResults('TC03-OCR-01-TO-S', {
      success: true, totalRecords: statusCheck.rows.length, trueCount: statusCheck.rows.length,
      falseCount: 0,
      details: statusCheck.rows.map((r) =>
        `${r.caseId} (${r.origin}) record ${r.recordNo}: ${r.statusBefore} -> ${r.status} / ` +
        `${r.updateBy} / ${r.approveBy} / ${r.batchDate}`),
    }, { start: 1, end: 1 });
  });

  // ---------------------------------------------------------------- TC04
  test('TC04: REDEMPTION_FULFILMENT_STATUS 01 -> S when the row exists', async () => {
    test.skip(OFFLINE, 'OLSDB037_OFFLINE=1 - no database access');
    test.skip(!rfsCheck, 'no preparation in this run');

    expect(rfsCheck.issues, rfsCheck.issues.join('\n')).toEqual([]);
    const withoutRfs = rfsCheck.rows.filter((r) => !r.found);
    log(`[TC04] ${withoutRfs.length} cash rebate row(s) have no REDEMPTION_FULFILMENT_STATUS row ` +
      '(allowed by the requirement)');

    await saveTestResults('TC04-RFS-01-TO-S', {
      success: true, totalRecords: rfsCheck.rows.length, trueCount: rfsCheck.checked,
      falseCount: 0,
      details: rfsCheck.rows.map((r) => r.found
        ? `${r.caseId} ref ${r.referenceNo}: ${r.status} / ${r.updateBy} / ${r.approveBy}`
        : `${r.caseId} ref ${r.referenceNo}: no fulfilment row (allowed)`),
    }, { start: 1, end: 1 });
  });

  // ---------------------------------------------------------------- TC05
  test('TC05: rerun still extracts the S + current batch date records', async () => {
    test.skip(OFFLINE, 'OLSDB037_OFFLINE=1 - no database access');
    test.skip(SKIP_BATCH || LOCAL_FILE, 'the batch was not run twice in this session');
    expect(rerunCheck, 'the rerun must have happened in beforeAll').not.toBeNull();

    const issues = [];
    if (rerunCheck.testRecordsStillInSelection !== rerunCheck.testRecords) {
      issues.push(`${rerunCheck.testRecords - rerunCheck.testRecordsStillInSelection} record(s) of Run #1 ` +
        `are no longer returned by the selection rule before Run #2 ` +
        `(${rerunCheck.testRecordsStillInSelection}/${rerunCheck.testRecords})`);
    }
    if (rerunCheck.missingInRun2.length) {
      issues.push(`${rerunCheck.missingInRun2.length} record(s) are missing from the Run #2 file`);
    }
    expect(issues, issues.join('\n')).toEqual([]);
    expect(trailerCheck2.issues, trailerCheck2.issues.join('\n')).toEqual([]);

    await saveTestResults('TC05-RERUN-S-CURRENT-BD', {
      success: true, totalRecords: rerunCheck.recordsInRun2File,
      trueCount: rerunCheck.testRecordsStillInSelection, falseCount: 0,
      details: [
        `expected rows before Run #2: ${rerunCheck.expectedRowsBeforeRun2}`,
        `records of this run still extractable: ${rerunCheck.testRecordsStillInSelection}/${rerunCheck.testRecords}`,
        `records in the Run #2 file: ${rerunCheck.recordsInRun2File}`,
      ],
    }, { start: 1, end: 1 });
  });

  // ---------------------------------------------------------------- TC06
  test("TC06: negative selection - 'S' from another batch date is not extracted", async () => {
    test.skip(OFFLINE, 'OLSDB037_OFFLINE=1 - no database access');
    test.skip(!negativeCheck, 'the second run was not executed in this session');
    expect(negativeCheck.leaked, JSON.stringify(negativeCheck.leaked)).toEqual([]);
    log(`[TC06] ${negativeCheck.candidates} candidate row(s) with '${STATUS_PROCESSED}' from another ` +
      'batch date; none of them appears in the output file');

    await saveTestResults('TC06-NEGATIVE-OTHER-BATCH-DATE', {
      success: true, totalRecords: negativeCheck.candidates,
      trueCount: negativeCheck.candidates, falseCount: 0,
      details: negativeCheck.sample.map((r) =>
        `record ${r.recordNo} of batch date ${r.batchDate} (not in the file)`),
    }, { start: 1, end: 1 });
  });

  // ---------------------------------------------------------------- TC07
  test('TC07: trailer record (record count exclude header and trailer)', async () => {
    test.skip(OFFLINE && !LOCAL_FILE, 'OLSDB037_OFFLINE=1 without a local file');
    expect(parsed.trailer, 'the file must have a trailer record').not.toBeNull();
    expect(trimValue(parsed.trailer.A9RTYP)).toBe('T');
    // In offline mode the trailer is still checked - against the file itself, without the DB.
    const trailer = trailerCheck || checkTrailer(parsed, 'TC07');
    expect(trailer.issues, trailer.issues.join('\n')).toEqual([]);
    // An empty file is legitimate (specification: "if file has no error, the file will only contain
    // header and trailer"), so A9TOT = 0 with no detail record is not a failure - it is reported.
    log(`[TC07] A9TOT=${trimValue(parsed.trailer.A9TOT)} for ${parsed.details.length} detail record(s)`);

    await saveTestResults('TC07-TRAILER', {
      success: true, totalRecords: 1, trueCount: 1, falseCount: 0,
      details: [`A9TOT=${parsed.trailer.A9TOT}, detail records in the file=${parsed.details.length}`],
    }, { start: 1, end: 1 });
  });

  // ---------------------------------------------------------------- TC08
  test('TC08: the data prepared through OLSDB040 (two pool balance cases)', async () => {
    test.skip(OFFLINE, 'OLSDB037_OFFLINE=1 - no database access');
    test.skip(!runContext.prepared || runContext.prepared.dryRun, 'no fresh preparation in this run');

    const issues = [];
    const skipped = [];
    for (const entry of runContext.prepared.cases) {
      // A case that cannot be prepared with the configured rule/pool is reported, not failed: the
      // reason lives on the dashboard and the other case still runs.
      if (entry.skipped) {
        skipped.push(`${entry.id} (${entry.poolBalance} pool balance): ${entry.reasons.join('; ')}`);
        log(`[TC08] ${entry.id} could not be prepared: ${entry.reasons.join('; ')}`);
        continue;
      }
      for (const problem of entry.problems) issues.push(`${entry.id}: ${problem}`);
      if (!entry.ocr) continue;
      if (trimValue(entry.ocr.txnCode) === '') issues.push(`${entry.id}: the cash rebate row has no TXN_CODE`);
      if (!trimValue(entry.ocr.redeemedPoint)) {
        issues.push(`${entry.id}: REDEEMED_POINT is empty (expected the ${entry.amountSource} of the transaction)`);
      }
    }
    expect(issues, issues.join('\n')).toEqual([]);

    await saveTestResults('TC08-PREPARED-CASES', {
      success: true, totalRecords: runContext.prepared.cases.length,
      trueCount: runContext.prepared.cases.filter((c) => c.ocr).length, falseCount: 0,
      details: [
        ...runContext.prepared.cases.filter((c) => !c.skipped).map((c) =>
          `${c.id} (${c.poolBalance} pool balance): OCR ${c.ocr ? c.ocr.recordNo : '-'} ` +
          `ref ${c.ocr ? c.ocr.referenceNo : '-'} amount source ${c.amountSource} ` +
          `| RFS ${c.rfs ? c.rfs.record_no : 'none'}`),
        ...skipped.map((text) => `SKIPPED - ${text}`),
      ],
    }, { start: 1, end: runContext.prepared.cases.length });
  });

  // ---------------------------------------------------------------- TC10 (removed from the verdict)
  // The TRANSACTIONS row and the loyalty_account_balance of each prepared case are captured by
  // file-generator.js and shown on the dashboard, but they are NOT asserted: they belong to the test
  // case of OLSDB040 (the job that creates the data). This suite only verifies what OLSDB037 does with
  // the cash rebate rows - file content, status transitions and the rerun behaviour.
  // ---------------------------------------------------------------- TC09
  test('TC09: constant fields and fixed lengths of every detail record', async () => {
    test.skip(OFFLINE && !LOCAL_FILE, 'OLSDB037_OFFLINE=1 without a local file');
    expect(parsed.details.length).toBeGreaterThan(0);

    const issues = [];
    for (const detail of parsed.details) {
      if (detail.length !== parsed.detailLength) {
        issues.push(`line ${detail.line}: record length ${detail.length} != ${parsed.detailLength}`);
      }
      for (const field of DETAIL_FIELDS) {
        if (field.expected === undefined) continue;
        const actual = detail.record[field.name];
        if (String(actual) !== String(field.expected)) {
          issues.push(`line ${detail.line}: ${field.name} must be "${
            field.expected === ' ' * field.length ? 'spaces' : field.expected.trim() || 'spaces'
          }" (${field.length} bytes), the file has "${actual}" (${String(actual).length} bytes)`);
        }
      }
    }
    expect(issues, issues.slice(0, 30).join('\n')).toEqual([]);

    await saveTestResults('TC09-CONSTANT-FIELDS', {
      success: true, totalRecords: parsed.details.length,
      trueCount: parsed.details.length, falseCount: 0,
      details: [
        `detail record length ${parsed.detailLength} (documented variants: ${DETAIL_LENGTH_CANDIDATES.join(', ')})`,
        `${DETAIL_FIELDS.filter((f) => f.expected !== undefined).length} constant field(s) checked per record`,
      ],
    }, { start: 1, end: parsed.details.length });
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
        <td>${escape(m.row)}</td>
        <td>${escape(m.field)}</td>
        <td>${escape(m.expected)}</td>
        <td>${escape(m.actual)}</td>
      </tr>`).join('')
    : '<tr><td colspan="5">No mismatch</td></tr>';

  const unexpectedRows = (comparison && comparison.unexpected.length)
    ? comparison.unexpected.slice(0, 50).map((u) => `
      <tr>
        <td>${escape(u.line)}</td>
        <td>${escape(u.txnCode)}</td>
        <td>${escape(u.cardNo)}</td>
        <td>${escape(u.accountNo)}</td>
        <td>${escape(u.amount)}</td>
        <td>${escape(u.reference)}</td>
      </tr>`).join('')
    : '<tr><td colspan="6">Every detail record matches an expected row</td></tr>';

  const exportLines = String(rawExportText || '').replace(/\r/g, '').split('\n')
    .filter((line) => line !== '');
  const MAX_RAW_LINES = 100;
  const countByTag = exportLines.reduce((acc, line) => {
    const tag = line.slice(0, 1);
    acc[tag] = (acc[tag] || 0) + 1;
    return acc;
  }, {});

  const preparedRows = (runContext.prepared && runContext.prepared.cases.length)
    ? runContext.prepared.cases.map((c) => `
      <tr class="${c.skipped ? 'fail' : 'ok'}">
        <td>${escape(c.id)}</td>
        <td>${escape(c.poolBalance)}</td>
        <td>${escape(c.account.productAccountNo)}</td>
        <td>${escape(c.account.csn)}</td>
        <td>${escape(c.before && c.before.found ? c.before.balance : 'n/a')}</td>
        <td>${escape(c.after && c.after.found ? c.after.balance : 'n/a')}</td>
        <td>${escape(c.file ? c.file.name : '(no file)')}</td>
        <td>${escape(c.ocr ? c.ocr.recordNo : '-')}</td>
        <td>${escape(c.ocr ? c.ocr.referenceNo : '-')}</td>
        <td>${escape(c.ocr ? trimValue(c.ocr.txnCode) : '-')}</td>
        <td>${escape(c.ocr ? trimValue(c.ocr.redeemedPoint) : '-')}</td>
        <td>${escape(c.amountSource)}</td>
        <td>${escape(c.rfs ? `${c.rfs.record_no} (${c.rfs.fulfillment_status})` : 'none')}</td>
        <td>${escape(c.transaction
          ? `${c.transaction.transactionCode}/${c.transaction.transactionType}/${c.transaction.txnSign} ` +
            `adj ${c.transaction.pointAdjusted} redeem ${c.transaction.pointRedeemed}`
          : 'n/a')}</td>
        <td>${escape(c.labAfter === null || c.labAfter === undefined ? 'n/a' : c.labAfter)}</td>
        <td>${escape(c.skipped ? `SKIPPED - ${c.reasons.join('; ')}` : c.problems.join('; '))}</td>
      </tr>`).join('')
    : '<tr><td colspan="14">no preparation in this run</td></tr>';

  const statusRows = (statusCheck && statusCheck.rows.length)
    ? statusCheck.rows.map((r) => `
      <tr class="${r.issues.length ? 'fail' : 'ok'}">
        <td>${escape(r.caseId)}</td>
        <td>${escape(r.origin)}</td>
        <td>${escape(r.recordNo)}</td>
        <td>${escape(r.referenceNo)}</td>
        <td>${escape(r.statusBefore)} -> ${escape(r.status)}</td>
        <td>${escape(r.updateBy)}</td>
        <td>${escape(r.approveBy)}</td>
        <td>${escape(r.batchDate)}</td>
        <td>${escape(r.issues.join('; '))}</td>
      </tr>`).join('')
    : '<tr><td colspan="9">not checked</td></tr>';

  const rfsRows = (rfsCheck && rfsCheck.rows.length)
    ? rfsCheck.rows.map((r) => `
      <tr class="${r.issues && r.issues.length ? 'fail' : 'ok'}">
        <td>${escape(r.caseId)}</td>
        <td>${escape(r.referenceNo)}</td>
        <td>${escape(r.found ? r.recordNo : '(no row)')}</td>
        <td>${escape(r.found ? `${r.before || '(none)'} -> ${r.status}` : '-')}</td>
        <td>${escape(r.outType || (r.note || ''))}</td>
        <td>${escape(r.updateBy || '')}</td>
        <td>${escape(r.approveBy || '')}</td>
        <td>${escape(r.issues ? r.issues.join('; ') : '')}</td>
      </tr>`).join('')
    : '<tr><td colspan="8">not checked</td></tr>';

  const detailSample = parsed && parsed.details.length
    ? parsed.details.slice(0, 20).map((d) => `
      <tr>
        <td>${escape(d.line)}</td>
        <td>${escape(trimValue(d.record.A1TTYP))}</td>
        <td>${escape(trimValue(d.record.A1KRTN))}</td>
        <td>${escape(trimValue(d.record.A1KNTN))}</td>
        <td>${escape(trimValue(d.record.A1TRDT))}</td>
        <td>${escape(trimValue(d.record.A1RKID))}</td>
        <td>${escape(trimValue(d.record.A1BEL))}</td>
        <td>${escape(trimValue(d.record.A1CCDE))}</td>
        <td>${escape(trimValue(d.record.A1DTTM))}</td>
        <td>${escape(trimValue(d.record.A1REFN))}</td>
        <td>${escape(trimValue(d.record.ProdID10Len))}</td>
      </tr>`).join('')
    : '<tr><td colspan="11">no detail record</td></tr>';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>OLSDB037 - ${escape(OUTPUT_ID)} verification</title>
<style>
  body { font-family: Segoe UI, Arial, sans-serif; margin: 24px; color: #1f2933; }
  h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 28px; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; font-size: 13px; }
  th, td { border: 1px solid #d2d6dc; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f4f6f8; }
  tr.ok td:nth-child(3) { color: #0b7a3b; font-weight: 600; }
  tr.fail td:nth-child(3) { color: #b42318; font-weight: 600; }
  code { background: #f4f6f8; padding: 1px 4px; }
  .note { background: #fff8e1; border: 1px solid #f0d9a0; padding: 10px; }
</style></head><body>
  <h1>OLSDB037 - Generate Cash Rebate output file (${escape(OUTPUT_ID)})</h1>
  <p>Batch <code>${escape(BATCH_ID)}</code>${CONFIG.batch.jobName ? ` / job <code>${escape(CONFIG.batch.jobName)}</code>` : ''}
     - host <code>${escape(CONFIG.putty.host)}</code> -
     DB <code>${escape(CONFIG.database.database)}.${escape(SCHEMA)}</code></p>
  <p>Batch date: <code>${escape(runContext.batchDate || '(unknown)')}</code>
     ${runContext.prepared && runContext.prepared.batchDateUpdate
      ? `(STEP 0: <code>${escape(runContext.prepared.batchDateUpdate.before.batch_date)}</code> ->
         <code>${escape(runContext.prepared.batchDateUpdate.after.batch_date)}</code>,
         processing_date <code>${escape(runContext.prepared.batchDateUpdate.after.processing_date)}</code>)`
      : '(batch_date not updated in this run)'}
     | input prepared through <code>${escape(PREPARE_BATCH_ID)}</code>
     ${runContext.prepared ? `(REP rule ${escape(runContext.prepared.rule.scheme_id)}, pool ${escape(runContext.prepared.poolId)})` : ''}</p>
  <p>Output file: <code>${escape(runContext.file ? runContext.file.name : '(none)')}</code>
     ${runContext.file && runContext.file.fingerprint
      ? `(${runContext.file.fingerprint.size} bytes, md5 ${escape(runContext.file.fingerprint.md5)})` : ''}
     | Run #2: <code>${escape(runContext.file2 ? runContext.file2.name : '(not run)')}</code>
     ${runContext.file2 && runContext.file2.fingerprint
      ? `(${runContext.file2.fingerprint.size} bytes, md5 ${escape(runContext.file2.fingerprint.md5)})` : ''}</p>

  <h2>Steps</h2>
  <table>
    <thead><tr><th>Step</th><th>Description</th><th>Result</th><th>Note</th></tr></thead>
    <tbody>${stepRows}</tbody>
  </table>

  <h2>Selection rule of OLSDB037</h2>
  <div class="note">
    OCR.STATUS = 'A' AND ( FULFILLMENT_STATUS = '${escape(STATUS_NEW)}'
    OR ( BATCH_DATE = ${escape(runContext.batchDate || 'currentBD')} AND FULFILLMENT_STATUS = '${escape(STATUS_PROCESSED)}' ) )
    - no cut-off table is read and no cut-off value is written.
  </div>

  <h2>The two prepared cases</h2>
  <table>
    <thead><tr><th>Case</th><th>Pool balance</th><th>Account</th><th>CSN</th><th>Balance before</th>
      <th>Balance after</th><th>OLSTXN</th><th>OCR record</th><th>Reference</th><th>TXN code</th>
      <th>Redeemed point</th><th>Amount source</th><th>RFS row</th>
      <th>TRANSACTIONS (evidence)</th><th>LAB after (evidence)</th><th>Problems / notes</th></tr></thead>
    <tbody>${preparedRows}</tbody>
  </table>

  <h2>Statuses after the run</h2>
  <table>
    <thead><tr><th>Case</th><th>Origin</th><th>OCR record</th><th>Reference</th><th>Status</th>
      <th>Last update by</th><th>Last approve by</th><th>Batch date</th><th>Issues</th></tr></thead>
    <tbody>${statusRows}</tbody>
  </table>

  <h2>REDEMPTION_FULFILMENT_STATUS</h2>
  <table>
    <thead><tr><th>Case</th><th>Reference</th><th>RFS record</th><th>Status</th><th>Output type</th>
      <th>Last update by</th><th>Last approve by</th><th>Issues</th></tr></thead>
    <tbody>${rfsRows}</tbody>
  </table>

  <h2>Comparison</h2>
  <table>
    <thead><tr><th>Metric</th><th>Value</th></tr></thead>
    <tbody>
      <tr><td>Detail records in the file</td><td>${escape(comparison ? comparison.fileRecords : 'n/a')}</td></tr>
      <tr><td>Expected rows (selection rule)</td><td>${escape(comparison ? comparison.expectedRecords : 'n/a')}</td></tr>
      <tr><td>Records of this run</td><td>${escape(comparison ? `${comparison.matchedTestRecords}/${comparison.expectedTestRecords}` : 'n/a')}</td></tr>
      <tr><td>Fields compared</td><td>${escape(comparison ? comparison.comparedFields : 'n/a')}</td></tr>
      <tr><td>Field mismatches (this run)</td><td>${escape(comparison ? comparison.mismatchCount : 'n/a')}</td></tr>
      <tr><td>Difference on rows of other runs (reported)</td><td>${escape(comparison ? comparison.softMismatches.length : 'n/a')}</td></tr>
      <tr><td>Record(s) in the file without an expected row</td><td>${escape(comparison ? comparison.unexpected.length : 'n/a')}</td></tr>
      <tr><td>Expected row(s) of this run missing from the file</td><td>${escape(comparison ? comparison.missingTestRecords.length : 'n/a')}</td></tr>
      <tr><td>Expected row(s) of other runs missing from the file</td><td>${escape(comparison ? comparison.missingOtherRecords.length : 'n/a')}</td></tr>
      <tr><td>Detail record length observed</td><td>${escape(parsed ? parsed.detailLength : 'n/a')} bytes
          (documented variants: ${escape(DETAIL_LENGTH_CANDIDATES.join(', '))})</td></tr>
    </tbody>
  </table>

  <h2>A1REFN - conflict between the test case and the specification</h2>
  <table>
    <thead><tr><th>Source</th><th>Expectation</th></tr></thead>
    <tbody>
      <tr><td>Test case (requirement 8)</td><td>A1REFN = OCR.REFERENCE_NO</td></tr>
      <tr><td>GRSAVGPF.docx + Output spec v1.16</td><td>A1REFN = Space</td></tr>
      <tr><td>Behaviour observed in this run (mode <code>${escape(A1REFN_MODE)}</code>)</td>
          <td>${escape(comparison && comparison.a1refnFindings ? comparison.a1refnFindings.behaviour : 'not observed')}</td></tr>
    </tbody>
  </table>

  <h2>Mismatches (records of this run)</h2>
  <table>
    <thead><tr><th>Line</th><th>OCR record</th><th>Field</th><th>Expected</th><th>Actual</th></tr></thead>
    <tbody>${mismatchRows}</tbody>
  </table>

  <h2>Records in the file without an expected row</h2>
  <table>
    <thead><tr><th>Line</th><th>A1TTYP</th><th>A1KRTN</th><th>A1KNTN</th><th>A1BEL</th><th>A1REFN</th></tr></thead>
    <tbody>${unexpectedRows}</tbody>
  </table>

  <h2>Output file</h2>
  <table>
    <thead><tr><th>Attribute</th><th>Value</th></tr></thead>
    <tbody>
      <tr><td>File name</td><td>${escape(runContext.file ? runContext.file.name : '(not downloaded)')}</td></tr>
      <tr><td>Remote path</td><td><code>${escape(`${CONFIG.output.remoteDir}/${outputFileName()}`)}</code></td></tr>
      <tr><td>Local path</td><td>${escape(runContext.file && runContext.file.path ? runContext.file.path : '(not downloaded)')}</td></tr>
      <tr><td>Records</td><td>H ${escape(countByTag.H || 0)} | D ${escape(countByTag.D || 0)} |
          T ${escape(countByTag.T || 0)} (total lines ${escape(exportLines.length)})</td></tr>
      <tr><td>Header</td><td><code>${escape(parsed && parsed.header
        ? `A0RTYP=${trimValue(parsed.header.A0RTYP)} A0PDTE=${trimValue(parsed.header.A0PDTE)} A0SDTE=${trimValue(parsed.header.A0SDTE)} A0FLID=${trimValue(parsed.header.A0FLID)}`
        : '(no header)')}</code></td></tr>
      <tr><td>Trailer</td><td><code>${escape(parsed && parsed.trailer
        ? `A9RTYP=${trimValue(parsed.trailer.A9RTYP)} A9TOT=${trimValue(parsed.trailer.A9TOT)}`
        : '(no trailer)')}</code></td></tr>
      <tr><td>Run #2 trailer</td><td><code>${escape(parsed2 && parsed2.trailer
        ? `A9TOT=${trimValue(parsed2.trailer.A9TOT)}`
        : '(no second run)')}</code></td></tr>
    </tbody>
  </table>

  <h3>Detail records (first 20 of ${escape(parsed ? parsed.details.length : 0)})</h3>
  <table>
    <thead><tr><th>line</th><th>A1TTYP</th><th>A1KRTN</th><th>A1KNTN</th><th>A1TRDT</th><th>A1RKID</th>
      <th>A1BEL</th><th>A1CCDE</th><th>A1DTTM</th><th>A1REFN</th><th>ProdID10Len</th></tr></thead>
    <tbody>${detailSample}</tbody>
  </table>

  <h3>Raw content${exportLines.length > MAX_RAW_LINES ? ` (first ${MAX_RAW_LINES} of ${exportLines.length} lines)` : ''}</h3>
  <pre style="max-height:420px;overflow:auto;background:#f4f6f8;border:1px solid #d2d6dc;padding:8px;font-size:12px">${escape(exportLines.slice(0, MAX_RAW_LINES).join('\n'))}</pre>

  <h2>Parser warnings</h2>
  <ul>${parsed && parsed.warnings.length
    ? parsed.warnings.map((w) => `<li>${escape(w)}</li>`).join('')
    : '<li>none</li>'}</ul>

  <h2>Environment</h2>
  <table>
    <thead><tr><th>Item</th><th>Value</th></tr></thead>
    <tbody>
      <tr><td>Detail layout source</td><td>${escape(CHECK_SHEET)}</td></tr>
      <tr><td>Header / trailer source</td><td>${escape(OUTPUT_SPEC)}</td></tr>
      <tr><td>Batch order source</td><td>${escape(EOD_FLOW)}</td></tr>
      <tr><td>output_cash_rebate.batch_date</td><td>${escape(runContext.batchDateColumnType || 'n/a')}</td></tr>
      <tr><td>OCR columns read</td><td>${escape(columnCheck ? columnCheck.columns.join(', ') : 'n/a')}</td></tr>
      <tr><td>Product accounts of this run</td><td>${escape(runContext.productCodes
        ? runContext.productCodes.map((r) => `${r.product_account_no} ${r.product_account_type}/${r.product_code}`).join(' | ')
        : 'n/a')}</td></tr>
    </tbody>
  </table>
</body></html>`;

  fs.writeFileSync(out, html);
  log(`Dashboard written: ${out}`);
}
