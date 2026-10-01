// scripts/OLSD141R/file-generator.js
// Prepare the input data of the OLSD141R report ("CIF Merge File Report"):
//
//   OLSCUST (7 new CIFs) -> OLSDB012 -> 7 CLIENT records
//     -> OLSMECIF (4 merge records) -> OLSDB057 -> DWH_TEMP_CIF_MERGE
//     -> OLSDR141 expected data (query provided by the BA)
//
// Both input files are cloned from the BA samples (CONFIG.templates): only the CIF numbers,
// the OLSCUST recordAction / dates and the OLSMECIF statuses are patched, so the layout of the
// sample files is preserved byte for byte.
//
// Manual run: node scripts/OLSD141R/file-generator.js (also called by test.beforeAll)

import fs from 'fs-extra';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import pg from 'pg';
import {
  CONFIG, SCHEMA, CIF_COUNT, MERGE_PAIRS, INDICATOR_DESC, mergeStatusOf,
  CUST_ACTION, CUST_FIELDS, MERGE_FILE_LAYOUT, EXPECTED_QUERY, cifName,
} from './test-data.js';
import { custFileName, mergeFileName, stagingPath } from './file-naming.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============ HELPERS ============
function log(message, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`, Object.keys(data).length ? data : {});
}

// child_process errors may include the full command, including -pw <password>.
function maskSecret(text) {
  let out = String(text ?? '');
  for (const secret of [CONFIG.putty.password, CONFIG.winscp.password]) {
    if (secret && secret.length >= 3) out = out.split(secret).join('****');
  }
  return out;
}

// -batch and -hostkey are required, otherwise plink hangs at the host key prompt (AGENTS.md 4.4).
function plinkCommand(remoteCommand) {
  return `"${CONFIG.putty.path}" -batch ` +
    `-hostkey "${CONFIG.putty.hostKey}" ` +
    `-ssh ${CONFIG.putty.username}@${CONFIG.putty.host} ` +
    `-pw ${CONFIG.putty.password} ` +
    `"${remoteCommand}"`;
}

/** Run one batch: cd <scriptPath> && ./<batchId>. Throws if the command cannot run at all. */
export async function runRemoteBatch(batchId, testCase = batchId) {
  const command = `cd ${CONFIG.batch.scriptPath} && ./${batchId}`;
  log(`[${testCase}] Run batch: ${command}`);

  try {
    const { stdout, stderr } = await execAsync(plinkCommand(command), {
      timeout: CONFIG.batch.timeout,
      maxBuffer: 1024 * 1024 * 10,
    });
    log(`[${testCase}] ${batchId} finished`);
    return { success: true, stdout, stderr };
  } catch (error) {
    throw new Error(
      `[${testCase}] Batch ${batchId} could not run: ${maskSecret(error.message)}\n` +
      `(check VPN, plink.exe, host key, or ${CONFIG.batch.scriptPath}/${batchId})`
    );
  }
}

/**
 * Keep only the newest generated input file of a batch in a folder: every run produces a new file
 * name (BE051/BE302 require an unused name), so the older copies pile up in
 * scripts\test-data\generated\OLSD141R\* and in the local staging folder (LOCAL_PATH).
 * Only files matching `<prefix>*.dat` are touched; other batches' files (OLSTERM, OLSTXN, ...) are
 * left alone.
 *
 * @returns {string[]} names of the removed files
 */
function pruneOldInputFiles(dir, keepFileName, prefix, testCase = 'OLSD141R') {
  if (!fs.existsSync(dir)) return [];

  const removed = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === keepFileName) continue;
    if (!name.startsWith(prefix) || !name.endsWith('.dat')) continue;
    try {
      fs.removeSync(path.join(dir, name));
      removed.push(name);
    } catch (error) {
      log(`[${testCase}] ⚠️ Cannot remove old file ${name}: ${maskSecret(error.message)}`);
    }
  }
  if (removed.length) {
    log(`[${testCase}] Kept ${keepFileName}, removed ${removed.length} older ${prefix}*.dat: ` +
      `${removed.join(', ')}`);
  }
  return removed;
}

async function uploadFiles(fileNames, remotePath, testCase) {
  for (const name of fileNames) {
    const command = `"${CONFIG.winscp.path}" /command ` +
      `"option batch abort" ` +
      `"option confirm off" ` +
      `"option transfer binary" ` +
      `"open sftp://${CONFIG.winscp.username}:${CONFIG.winscp.password}@${CONFIG.winscp.host}/" ` +
      `"cd ${remotePath}" ` +
      `"put ""${stagingPath(name)}""" ` +
      `"exit"`;

    try {
      await execAsync(command, { timeout: 60000, maxBuffer: 1024 * 1024 * 10 });
      log(`[${testCase}] Upload OK: ${name} -> ${remotePath}`);
    } catch (error) {
      throw new Error(`[${testCase}] Upload failed ${name} to ${remotePath}: ` +
        `${maskSecret(error.message)}`);
    }
  }
}

/** Read-only remote command (ls, grep, wc, ...). */
async function executeRemoteCommand(command, testCase = 'OLSD141R') {
  const { stdout } = await execAsync(plinkCommand(command), {
    timeout: 120000,
    maxBuffer: 1024 * 1024 * 10,
  });
  return stdout;
}

// ============ DATABASE ============
// Local helpers: scripts/database_helper.js uses globals and exports nothing.
async function getDbConnection() {
  const client = new pg.Client({
    host: CONFIG.database.host,
    port: CONFIG.database.port,
    user: CONFIG.database.username,
    password: CONFIG.database.password,
    database: CONFIG.database.database,
  });
  await client.connect();
  // Same convention as scripts/database_helper.js and OLSDB020: the expected-data query provided
  // by the BA uses unqualified table names (dwh_temp_cif_merge), so the schema must be on the
  // connection's search_path.
  await client.query(`SET search_path TO ${SCHEMA}`);
  return client;
}

async function executeDbQuery(query, params = [], testCase = 'OLSD141R') {
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

function toYmd(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return `${value.getFullYear()}${String(value.getMonth() + 1).padStart(2, '0')}` +
      `${String(value.getDate()).padStart(2, '0')}`;
  }
  const s = String(value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}${m[2]}${m[3]}` : s.replace(/\D/g, '').slice(0, 8);
}

function toIsoDate(value) {
  if (!value) return null;
  if (value instanceof Date) return toYmd(value).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  const s = String(value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const ymd = s.replace(/\D/g, '').slice(0, 8);
  return ymd.length === 8 ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : s;
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function addDays(isoDate, offset) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/**
 * STEP 0 - prepare ols_schema.batch_date before running OLSDB012.
 *
 * Same pattern as OLSD134R (scripts/OLSD134R/file-generator.js updateBatchDate):
 *   batch_date = CURRENT_DATE, processing_date = CURRENT_DATE - 1,
 *   last_update_date = now(), last_update_by = <testCase>,
 *   WHERE record_no = (SELECT MAX(record_no) FROM batch_date).
 * No auto restore: batch_date is a shared control table (same as OLSD134R).
 *
 * Overrides:
 *   OLSD141R_BATCH_DATE=YYYY-MM-DD  -> batch_date = that date, processing_date = date - 1
 *                                      (validated before any DB write; invalid -> fail)
 *   OLSD141R_SKIP_BATCHDATE_UPDATE=1 -> skip the update (ignored when OLSD141R_BATCH_DATE is set)
 *
 * Unlike OLSD134R, the row is re-read after the UPDATE and verified; a mismatch throws before
 * OLSDB012 runs.
 */
export async function updateBatchDate(testCase = 'OLSD141R') {
  const override = (process.env.OLSD141R_BATCH_DATE || '').trim();
  if (override && !isIsoDate(override)) {
    throw new Error(
      `[${testCase}] OLSD141R_BATCH_DATE must be a valid YYYY-MM-DD date, got "${override}" ` +
      '(no DB write performed)'
    );
  }
  if (!override && process.env.OLSD141R_SKIP_BATCHDATE_UPDATE === '1') {
    log(`[${testCase}] Skip batch_date update (OLSD141R_SKIP_BATCHDATE_UPDATE=1)`);
    return null;
  }

  const sel = `SELECT record_no,
                      to_char(batch_date, 'YYYY-MM-DD')      AS batch_date,
                      to_char(processing_date, 'YYYY-MM-DD') AS processing_date
                 FROM ${SCHEMA}.batch_date ORDER BY record_no DESC LIMIT 1`;
  const before = await executeDbQuery(sel, [], testCase);
  if (!before.length) throw new Error(`[${testCase}] Table ${SCHEMA}.batch_date has no row.`);
  log(`[${testCase}] Batch date before update: record_no = ${before[0].record_no}, ` +
    `batch_date = ${before[0].batch_date}, processing_date = ${before[0].processing_date}`);

  const sql = override
    ? `UPDATE ${SCHEMA}.batch_date
          SET batch_date      = $2::date,
              processing_date = $2::date - 1,
              last_update_date = now(),
              last_update_by   = $1
        WHERE record_no = (SELECT MAX(record_no) FROM ${SCHEMA}.batch_date)`
    : `UPDATE ${SCHEMA}.batch_date
          SET batch_date      = CURRENT_DATE,
              processing_date = CURRENT_DATE - 1,
              last_update_date = now(),
              last_update_by   = $1
        WHERE record_no = (SELECT MAX(record_no) FROM ${SCHEMA}.batch_date)`;
  await executeDbQuery(sql, override ? [testCase, override] : [testCase], testCase);

  // Verify by re-reading the row (expected batch date = override, else the DB CURRENT_DATE).
  const check = await executeDbQuery(
    `SELECT record_no,
            to_char(batch_date, 'YYYY-MM-DD')      AS batch_date,
            to_char(processing_date, 'YYYY-MM-DD') AS processing_date,
            to_char(${override ? '$1::date' : 'CURRENT_DATE'}, 'YYYY-MM-DD') AS expected_batch_date
       FROM ${SCHEMA}.batch_date ORDER BY record_no DESC LIMIT 1`,
    override ? [override] : [],
    testCase
  );
  const after = check[0];
  const expectedProcessing = addDays(after.expected_batch_date, -1);
  const verified = after.batch_date === after.expected_batch_date
    && after.processing_date === expectedProcessing;

  log(`[${testCase}] Batch date after update: record_no = ${after.record_no}, ` +
    `batch_date = ${after.batch_date}, processing_date = ${after.processing_date}, ` +
    `verified = ${verified ? 'YES' : 'NO'}`);
  if (!verified) {
    throw new Error(
      `[${testCase}] batch_date update not verified: expected batch_date ` +
      `${after.expected_batch_date} / processing_date ${expectedProcessing}, got ` +
      `${after.batch_date} / ${after.processing_date}`
    );
  }

  return { before: before[0], after, sql };
}

/**
 * Batch date of the current run (ols_schema.batch_date.batch_date).
 * OLSD141R needs no cut-off time: the data of this run is identified by the job_id of the
 * OLSDB057 run (see resolveJobId).
 */
export async function getBatchContext(testCase = 'OLSD141R') {
  const batchRows = await executeDbQuery(
    `SELECT batch_date FROM ${SCHEMA}.batch_date ORDER BY batch_date DESC LIMIT 1`,
    [],
    testCase
  );
  if (!batchRows.length) throw new Error(`[${testCase}] Table ${SCHEMA}.batch_date has no row.`);

  const batchDate = toIsoDate(batchRows[0].batch_date);
  return { batchDate, batchDateYmd: toYmd(batchDate) };
}

// ============ TEMPLATES ============
/** Read a BA sample and keep its line ending / trailing newline untouched. */
function loadTemplate(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Sample file not found: ${filePath}\n` +
      `Set OLSD141R_CUST_TEMPLATE / OLSD141R_MECIF_TEMPLATE to the sample locations.`
    );
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailingEol = /\r?\n$/.test(text);
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { path: filePath, eol, trailingEol, lines };
}

function renderTemplate(template, lines) {
  return lines.join(template.eol) + (template.trailingEol ? template.eol : '');
}

// ============ OLSCUST BUILDER (OLSDB012 input) ============
/**
 * Clone the OLSCUST sample into one file with a detail record per generated CIF.
 * Only the DT recordAction / custCifNbr cells, the HD createDate / fileNumber cells and the TR
 * recordCount cell are patched - every other cell keeps the sample value.
 */
export function buildCustFile({ template, cifs, action = CUST_ACTION, createDate, fileNumber }) {
  const nameCells = (template.lines.find((l) => l.startsWith('FN|DT|')) || '').split('|');
  const valueIndex = (name) => nameCells.indexOf(name) + CUST_FIELDS.dtValueOffset;
  const cifIdx = valueIndex(CUST_FIELDS.detail.cif);
  const actionIdx = valueIndex(CUST_FIELDS.detail.action);

  if (cifIdx < 0 || actionIdx < 0) {
    throw new Error(`Cannot locate ${CUST_FIELDS.detail.cif} / ${CUST_FIELDS.detail.action} ` +
      `in the FN|DT row of ${template.path}`);
  }

  const dtTemplate = template.lines.find((l) => l.startsWith('DT|'));
  if (!dtTemplate) throw new Error(`No DT record in the OLSCUST sample ${template.path}`);

  const hdIdx = template.lines.findIndex((l) => l.startsWith('HD|'));
  const trIdx = template.lines.findIndex((l) => l.startsWith('TR|'));
  const dtIdx = template.lines.indexOf(dtTemplate);

  const details = cifs.map((cif) => {
    const cells = dtTemplate.split('|');
    cells[actionIdx] = action;
    cells[cifIdx] = cif;
    return cells.join('|');
  });

  const recordCount = cifs.length + template.lines.length - 1; // header + FN rows + trailer included
  const out = template.lines.slice();
  out[dtIdx] = details.join(template.eol);
  if (hdIdx >= 0) {
    const hd = out[hdIdx].split('|');
    hd[3] = createDate;               // createDate X(08) YYYYMMDD
    // fileNumber 9(04): the OLSCUST files accepted by OLSDB012 on dev use '0020' (4 digits),
    // while the BA sample carries '1' - follow the accepted files.
    hd[5] = String(fileNumber).padStart(4, '0');
    out[hdIdx] = hd.join('|');
  }
  if (trIdx >= 0) {
    const tr = out[trIdx].split('|');
    let countIdx = -1;
    tr.forEach((cell, i) => { if (/^\d{10}$/.test(cell)) countIdx = i; }); // last 10-digit cell
    if (countIdx >= 0) tr[countIdx] = String(recordCount).padStart(10, '0');
    out[trIdx] = tr.join('|');
  }

  return { content: renderTemplate(template, out), recordCount, cifIdx, actionIdx };
}

// ============ OLSMECIF BUILDER (OLSDB057 input) ============
/** Write one fixed-width cell (left aligned, blank padded). */
function patchFixedWidth(line, fields, values) {
  let out = line.padEnd(MERGE_FILE_LAYOUT.recordLength, ' ');
  let pos = 0;
  for (const [name, width] of fields) {
    if (values[name] !== undefined) {
      const value = String(values[name]).slice(0, width).padEnd(width, ' ');
      out = out.slice(0, pos) + value + out.slice(pos + width);
    }
    pos += width;
  }
  return out;
}

/**
 * Clone the OLSMECIF sample into one file with a detail record per merge pair.
 * Only the two CIF numbers, the Successful Indicator and the status description are patched;
 * positions, lengths and every following field stay exactly as in the sample.
 */
export function buildMergeFile({ template, merges, processingDate }) {
  const header = template.lines.find((l) => l.startsWith('A'));
  const detail = template.lines.find((l) => l.startsWith('D'));
  const trailer = template.lines.find((l) => l.startsWith('T'));
  if (!header || !detail || !trailer) {
    throw new Error(`Unexpected OLSMECIF sample layout: ${template.path}`);
  }

  const details = merges.map((m) => patchFixedWidth(detail, MERGE_FILE_LAYOUT.detail, {
    cifNumberA: m.cifA,
    cifNumberB: m.cifB,
    aName1: m.aName1,
    aName2: m.aName2,
    bName1: m.bName1,
    bName2: m.bName2,
    successfulIndicator: m.status,
    unsuccessfulErrorDesc: INDICATOR_DESC[m.status] || INDICATOR_DESC.Y,
  }));

  const patchedHeader = processingDate
    ? patchFixedWidth(header, MERGE_FILE_LAYOUT.header, { processingDate })
    : header;
  const patchedTrailer = patchFixedWidth(trailer, MERGE_FILE_LAYOUT.trailer, {
    totalRecords: String(details.length + 2).padStart(5, '0'), // header + details + trailer
  });

  return { content: renderTemplate(template, [patchedHeader, ...details, patchedTrailer]) };
}

// ============ LEDGER CHECKS (BE051 / BE302) ============
/**
 * Next free file number for (file_id + source_create_date). File names already present in
 * batch_resource are rejected with BE051, so the caller loops until isFileNameUsed() is false.
 */
async function getNextFileNumber(fileId, isoCreateDate, testCase = 'OLSD141R') {
  const rows = await executeDbQuery(
    `SELECT MAX(NULLIF(regexp_replace(file_number, '\\D', '', 'g'), '')::bigint) AS max_no
       FROM ${SCHEMA}.batch_header
      WHERE file_id = $1 AND source_create_date::date = $2::date`,
    [fileId, isoCreateDate],
    testCase
  ).catch(() => []);
  return (rows.length && rows[0].max_no ? Number(rows[0].max_no) : 0) + 1;
}

async function isFileNameUsed(fileName, testCase = 'OLSD141R') {
  const rows = await executeDbQuery(
    `SELECT 1 FROM ${SCHEMA}.batch_resource WHERE logical_filename = $1 LIMIT 1`,
    [fileName],
    testCase
  );
  return rows.length > 0;
}

/** Next free sequence for <FILE_ID>-<date>-NN.dat (AGENTS.md 4.1). */
async function nextFreeSequence(fileId, batchDateYmd, nameBuilder, testCase = 'OLSD141R') {
  const isoDate = `${batchDateYmd.slice(0, 4)}-${batchDateYmd.slice(4, 6)}-${batchDateYmd.slice(6, 8)}`;
  let seq = await getNextFileNumber(fileId, isoDate, testCase);
  for (;;) {
    const candidate = nameBuilder(seq);
    if (!(await isFileNameUsed(candidate, testCase))) return { seq, fileName: candidate };
    seq += 1;
  }
}

/**
 * Processing Date of the OLSMECIF header (DDMMYYYY).
 *
 * Two rules were confirmed from the job error log (<FILE>_<pid>_<date>.err) of OLSDB057:
 *   "Duplicate file processed with same date 2026-09-25"        -> the date must not repeat
 *   "CreateDate 2026-09-24 is before last run date of 2026-09-25" -> it must be later than the
 *                                                                   last received file
 * The real dev files follow the same pattern, one day per file:
 *   OLSMECIF-20260903-02 -> CreateDate 12/08/2026, OLSMECIF-20260903-03 -> 13/08/2026.
 * batch_header (file_id = OLSMECIF) is the ledger of received files (it also records rejected
 * ones), so the next CreateDate = max(batch date, MAX(source_create_date) + 1 day).
 * Override with OLSD141R_PROCESSING_DATE.
 */
async function resolveProcessingDate(ctx, testCase = 'OLSD141R') {
  const fromEnv = process.env.OLSD141R_PROCESSING_DATE || null;
  if (fromEnv) {
    log(`[${testCase}] Processing Date from environment: ${fromEnv}`);
    return fromEnv;
  }

  const rows = await executeDbQuery(
    `SELECT to_char(MAX(source_create_date), 'YYYYMMDD') AS last_ymd
       FROM ${SCHEMA}.batch_header WHERE file_id = $1`,
    [CONFIG.seedMerge.fileId],
    testCase
  );
  const lastYmd = (rows[0] && rows[0].last_ymd) || null;

  const day = (ymd, offset) => {
    const d = new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
      `${String(d.getUTCDate()).padStart(2, '0')}`;
  };

  let ymd = ctx.batchDateYmd;
  if (lastYmd && lastYmd >= ymd) ymd = day(lastYmd, 1);

  // Safety net: never send a date that is already in the ledger.
  while (await executeDbQuery(
    `SELECT 1 FROM ${SCHEMA}.batch_header WHERE file_id = $1 AND source_create_date::date = $2::date LIMIT 1`,
    [CONFIG.seedMerge.fileId, `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`],
    testCase
  ).then((r) => r.length > 0)) {
    ymd = day(ymd, 1);
  }

  if (ymd !== ctx.batchDateYmd) {
    log(`[${testCase}] Last ${CONFIG.seedMerge.fileId} CreateDate in ${SCHEMA}.batch_header = ` +
      `${lastYmd || '-'} - new file uses CreateDate ${ymd} (must be later and not repeat)`);
  }
  return `${ymd.slice(6, 8)}${ymd.slice(4, 6)}${ymd.slice(0, 4)}`;
}

// ============ CIF NUMBERS (STEP 1) ============
/** Random 19-digit CIF (first digit not zero). */
function randomCif() {
  let out = String(1 + Math.floor(Math.random() * 9));
  while (out.length < 19) out += String(Math.floor(Math.random() * 10));
  return out;
}

/** Does the CIF already exist in CLIENT? (requirement: the generated CIFs must not exist) */
export async function cifExistsInClient(cif, testCase = 'OLSD141R') {
  const rows = await executeDbQuery(
    `SELECT 1 FROM ${SCHEMA}.client WHERE ${CONFIG.database.cifColumn} = $1 LIMIT 1`,
    [cif],
    testCase
  );
  return rows.length > 0;
}

/** Generate `count` distinct CIF numbers that do not exist in CLIENT yet. */
export async function generateUniqueCifs(count = CIF_COUNT, testCase = 'OLSD141R') {
  const cifs = [];
  while (cifs.length < count) {
    let accepted = false;
    for (let attempt = 0; attempt < 100 && !accepted; attempt += 1) {
      const candidate = randomCif();
      if (cifs.includes(candidate)) continue;
      if (await cifExistsInClient(candidate, testCase)) {
        log(`[${testCase}] CIF ${candidate} already exists in ${SCHEMA}.client - regenerating`);
        continue;
      }
      cifs.push(candidate);
      accepted = true;
    }
    if (!accepted) throw new Error(`[${testCase}] Cannot generate an unused CIF number.`);
  }
  log(`[${testCase}] Generated ${cifs.length} new CIF number(s) not present in ${SCHEMA}.client`);
  return cifs;
}

/** Which of the given CIFs exist in CLIENT (used to verify OLSDB012). */
export async function findCifsInClient(cifs, testCase = 'OLSD141R') {
  const rows = await executeDbQuery(
    `SELECT ${CONFIG.database.cifColumn} AS cif FROM ${SCHEMA}.client
      WHERE ${CONFIG.database.cifColumn} = ANY($1)`,
    [cifs],
    testCase
  );
  return rows.map((r) => String(r.cif).trim());
}

// ============ EXPECTED DATA / JOB ID ============
/**
 * job_id of the OLSDB057 run printed on the report.
 * Priority: OLSD141R_JOB_ID -> argument -> newest job_id in dwh_temp_cif_merge.
 * TODO: confirm the official source of job_id with dev (batch_header / batch log).
 */
export async function resolveJobId(explicitJobId = null, testCase = 'OLSD141R') {
  const fromEnv = process.env.OLSD141R_JOB_ID || null;
  if (fromEnv) {
    log(`[${testCase}] job_id from environment: ${fromEnv}`);
    return fromEnv;
  }
  if (explicitJobId) return String(explicitJobId);

  const rows = await executeDbQuery(
    `SELECT job_id, count(*) AS rows FROM ${SCHEMA}.dwh_temp_cif_merge
      WHERE job_id IS NOT NULL
      GROUP BY job_id
      ORDER BY length(job_id::text) DESC, job_id::text DESC
      LIMIT 5`,
    [],
    testCase
  );
  if (!rows.length) return null;

  log(`[${testCase}] Candidate job_id values: ` +
    rows.map((r) => `${r.job_id} (${r.rows} rows)`).join(', '));
  return String(rows[0].job_id);
}

/** Map one DB row to one expected report record. */
function expectedRowOf(dbRow) {
  const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
  return {
    cifA: text(dbRow.cif_nbr_a),
    name1A: text(dbRow.customer_name_1_a),
    name2A: text(dbRow.customer_name_2_a),
    cifB: text(dbRow.cif_nbr_b),
    name1B: text(dbRow.customer_name_1_b),
    name2B: text(dbRow.customer_name_2_b),
    indicator: text(dbRow.successful_indicator),
    errorDesc: text(dbRow.unsuccessful_error_desc),
    errorCode: text(dbRow.error_code),
    errorMessage: text(dbRow.error_message),
    // Not printed on the report - logging only.
    valid: dbRow.valid,
  };
}

/** Expected report data = DWH_TEMP_CIF_MERGE rows of one OLSDB057 run (query from the BA). */
export async function fetchExpectedRows(jobId, testCase = 'OLSD141R') {
  const rows = await executeDbQuery(EXPECTED_QUERY, [jobId], testCase);
  return rows.map(expectedRowOf);
}

/** Number of DWH_TEMP_CIF_MERGE rows of one job. */
export async function countMergeRows(jobId, testCase = 'OLSD141R') {
  const rows = await executeDbQuery(
    `SELECT count(*) AS rows FROM ${SCHEMA}.dwh_temp_cif_merge WHERE job_id = $1`,
    [jobId],
    testCase
  );
  return Number(rows[0] ? rows[0].rows : 0);
}

// ============ BATCH OUTPUT ============
/** .out / .rej / .err files written by a batch for the uploaded file. */
async function listOutputs(remotePath, fileName, testCase) {
  try {
    const stdout = await executeRemoteCommand(
      `ls -1 ${remotePath}${fileName.replace(/\.dat$/, '')}* 2>/dev/null || true`,
      testCase
    );
    const files = String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      .map((p) => p.split('/').pop());
    return {
      files,
      out: files.filter((f) => f.endsWith('.out')),
      rej: files.filter((f) => f.endsWith('.rej')),
      err: files.filter((f) => f.endsWith('.err')),
    };
  } catch (error) {
    return { files: [], out: [], rej: [], err: [] };
  }
}

async function waitForOutputs(remotePath, fileName, batchId, {
  timeoutMs = 180000, intervalMs = 5000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let outputs = await listOutputs(remotePath, fileName, batchId);
  while (!outputs.files.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    outputs = await listOutputs(remotePath, fileName, batchId);
  }
  return outputs;
}

// ============ PREPARE DATA ============
/**
 * Full data preparation: OLSDB012 (7 CIFs) -> OLSDB057 (4 merge records) -> job_id.
 * @returns {Promise<{ctx: Object, cifs: string[], merges: Array, jobId: string|null, steps: Array}>}
 */
export async function prepareData(testCase = 'OLSD141R') {
  const steps = [];
  const add = (no, name, ok, note = '') => {
    steps.push({ no: String(no), name, ok: Boolean(ok), note });
    log(`[STEP ${no}] ${ok ? '✅' : '❌'} ${name}${note ? ' — ' + note : ''}`);
  };

  log(`[${testCase}] === Prepare data for OLSD141R ===`);

  // STEP 0 - prepare ols_schema.batch_date before OLSDB012 (same pattern as OLSD134R).
  const batchDateUpdate = await updateBatchDate(testCase);
  if (batchDateUpdate) {
    add('0', 'Update batch_date (STEP 0, before OLSDB012)', true,
      `record_no=${batchDateUpdate.after.record_no} | before: ` +
      `batch_date=${batchDateUpdate.before.batch_date}, ` +
      `processing_date=${batchDateUpdate.before.processing_date} -> after: ` +
      `batch_date=${batchDateUpdate.after.batch_date}, ` +
      `processing_date=${batchDateUpdate.after.processing_date} | verified=YES`,
      { sql: batchDateUpdate.sql });
  } else {
    add('0', 'Update batch_date (STEP 0, before OLSDB012)', false,
      'skipped (OLSD141R_SKIP_BATCHDATE_UPDATE=1)');
  }

  const ctx = await getBatchContext(testCase);
  log(`[${testCase}] batch date = ${ctx.batchDateYmd}`);

  // ---- Step 1: OLSCUST input with 7 new CIF numbers ----
  const cifs = await generateUniqueCifs(CIF_COUNT, testCase);
  const custTemplate = loadTemplate(CONFIG.templates.olscust);
  const custNameInfo = await nextFreeSequence(
    CONFIG.seedCust.fileId, ctx.batchDateYmd, (seq) => custFileName(ctx.batchDateYmd, seq), testCase
  );
  const cust = buildCustFile({
    template: custTemplate,
    cifs,
    createDate: ctx.batchDateYmd,
    fileNumber: custNameInfo.seq,
  });

  fs.ensureDirSync(CONFIG.seedCust.seedDir);
  fs.ensureDirSync(CONFIG.winscp.localPath);
  fs.writeFileSync(path.join(CONFIG.seedCust.seedDir, custNameInfo.fileName), cust.content);
  fs.writeFileSync(stagingPath(custNameInfo.fileName), cust.content);
  // Keep only the newest OLSCUST file (seed folder + local staging folder).
  const prunedCust = [
    ...pruneOldInputFiles(CONFIG.seedCust.seedDir, custNameInfo.fileName, CONFIG.seedCust.fileId),
    ...pruneOldInputFiles(CONFIG.winscp.localPath, custNameInfo.fileName, CONFIG.seedCust.fileId),
  ];

  add('1', `Generate ${CIF_COUNT} new CIF numbers (checked against ${SCHEMA}.client)`, true,
    `${cifs.join(', ')} (saved as cif1..cif${CIF_COUNT})`);
  add('2', `Build ${CONFIG.seedCust.fileId} input (recordAction='${CUST_ACTION}')`, true,
    `${custNameInfo.fileName}: ${cifs.length} detail record(s), ` +
    `recordCount=${cust.recordCount}, createDate=${ctx.batchDateYmd}` +
    ` | removed ${prunedCust.length} older ${CONFIG.seedCust.fileId}*.dat`);

  // ---- Step 2: run OLSDB012 ----
  await uploadFiles([custNameInfo.fileName], CONFIG.seedCust.remotePath, 'OLSDB012');
  add('3', `Upload ${custNameInfo.fileName} to SFTP`, true,
    `${custNameInfo.fileName} -> ${CONFIG.seedCust.remotePath}`);

  await runRemoteBatch(CONFIG.seedCust.batchId, 'OLSDB012');
  add('4', `Run ${CONFIG.seedCust.batchId} batch`, true,
    `cd ${CONFIG.batch.scriptPath} && ./${CONFIG.seedCust.batchId}`);

  const custOutputs = await waitForOutputs(
    CONFIG.seedCust.remotePath, custNameInfo.fileName, 'OLSDB012'
  );
  add('5', `Wait for ${CONFIG.seedCust.batchId} output files`, custOutputs.files.length > 0,
    custOutputs.files.length ? custOutputs.files.join(', ') : 'no .out/.rej/.err found');

  const foundCifs = await findCifsInClient(cifs, testCase);
  const missingCifs = cifs.filter((c) => !foundCifs.includes(c));
  add('6', `Verify ${CIF_COUNT} CIFs exist in ${SCHEMA}.client`, missingCifs.length === 0,
    missingCifs.length ? `missing: ${missingCifs.join(', ')}` : `all ${CIF_COUNT} CIFs created`);

  if (missingCifs.length) {
    throw new Error(`[${testCase}] ${CONFIG.seedCust.batchId} did not create CIF(s): ` +
      `${missingCifs.join(', ')} - stopping before ${CONFIG.seedMerge.batchId}`);
  }

  // ---- Step 3: OLSMECIF input with the 4 merge records ----
  const merges = MERGE_PAIRS.map((pair, i) => ({
    cifA: cifs[pair.source - 1],
    cifB: cifs[pair.target - 1],
    status: mergeStatusOf(i),
    // Every CIF carries its own name so the report can be verified per CIF.
    aName1: cifName(pair.source, 1),
    aName2: cifName(pair.source, 2),
    bName1: cifName(pair.target, 1),
    bName2: cifName(pair.target, 2),
  }));
  const mergeTemplate = loadTemplate(CONFIG.templates.olmecif);
  const mergeInfo = await nextFreeSequence(
    CONFIG.seedMerge.fileId, ctx.batchDateYmd, (seq) => mergeFileName(ctx.batchDateYmd, seq), testCase
  );
  const processingDate = await resolveProcessingDate(ctx, testCase);
  const merge = buildMergeFile({
    template: mergeTemplate,
    merges,
    processingDate,
  });

  fs.ensureDirSync(CONFIG.seedMerge.seedDir);
  fs.writeFileSync(path.join(CONFIG.seedMerge.seedDir, mergeInfo.fileName), merge.content);
  fs.writeFileSync(stagingPath(mergeInfo.fileName), merge.content);
  // Keep only the newest OLSMECIF file (seed folder + local staging folder).
  const prunedMerge = [
    ...pruneOldInputFiles(CONFIG.seedMerge.seedDir, mergeInfo.fileName, CONFIG.seedMerge.fileId),
    ...pruneOldInputFiles(CONFIG.winscp.localPath, mergeInfo.fileName, CONFIG.seedMerge.fileId),
  ];

  add('7', `Build ${CONFIG.seedMerge.fileId} input (${merges.length} merge records)`, true,
    `${mergeInfo.fileName} (Processing Date ${processingDate}): ` +
    merges.map((m, i) => `cif${MERGE_PAIRS[i].source}->cif${MERGE_PAIRS[i].target}(${m.status})`).join(', ') +
    ` | removed ${prunedMerge.length} older ${CONFIG.seedMerge.fileId}*.dat`);

  // ---- Step 4: run OLSDB057 ----
  await uploadFiles([mergeInfo.fileName], CONFIG.seedMerge.remotePath, 'OLSDB057');
  add('8', `Upload ${mergeInfo.fileName} to SFTP`, true,
    `${mergeInfo.fileName} -> ${CONFIG.seedMerge.remotePath}`);

  await runRemoteBatch(CONFIG.seedMerge.batchId, 'OLSDB057');
  add('9', `Run ${CONFIG.seedMerge.batchId} batch`, true,
    `cd ${CONFIG.batch.scriptPath} && ./${CONFIG.seedMerge.batchId}`);

  const mergeOutputs = await waitForOutputs(
    CONFIG.seedMerge.remotePath, mergeInfo.fileName, 'OLSDB057'
  );
  add('10', `Wait for ${CONFIG.seedMerge.batchId} output files`, mergeOutputs.files.length > 0,
    mergeOutputs.files.length ? mergeOutputs.files.join(', ') : 'no .out/.rej/.err found');

  const jobId = await resolveJobId(null, testCase);
  if (!jobId) {
    add('11', `Check ${SCHEMA}.dwh_temp_cif_merge rows of this run`, false,
      'no job_id found after OLSDB057 (the file may have been rejected)');
    return { ctx, cifs, merges, custFile: custNameInfo.fileName, mergeFile: mergeInfo.fileName,
      jobId: null, steps };
  }

  const rowCount = await countMergeRows(jobId, testCase);
  add('11', `Check ${SCHEMA}.dwh_temp_cif_merge rows of this run`, rowCount > 0,
    `job_id=${jobId}, rows=${rowCount}`);

  log(`[${testCase}] Seed done: ${CIF_COUNT} CIFs, ${merges.length} merge records, ` +
    `job_id=${jobId}, merge rows=${rowCount}`);
  return {
    ctx,
    cifs,
    // Verified right after OLSDB012, before the merge inactivates the source CIFs.
    cifsFound: foundCifs,
    merges,
    custFile: custNameInfo.fileName,
    mergeFile: mergeInfo.fileName,
    jobId,
    rowCount,
    steps,
  };
}

// Direct run: node scripts/OLSD141R/file-generator.js
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__dirname, 'file-generator.js')) {
  prepareData()
    .then((result) => log('Done', {
      cifs: (result.cifs || []).length, jobId: result.jobId, steps: (result.steps || []).length,
    }))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
