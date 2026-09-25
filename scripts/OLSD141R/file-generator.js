// scripts/OLSD141R/file-generator.js
// Prepare the input data for report OLSD141R ("CIF Merge File Report").
//
//   OLSMECIF-YYYYMMDD-NN.dat (built here, 340-char records)
//     -> copy to src\ -> upload via SFTP -> run ./OLSDB057 (CIF Merge Process)
//     -> DWH_TEMP_CIF_MERGE rows of this job_id -> OLSD141R expected data
//
// Manual run: node scripts/OLSD141R/file-generator.js (also called by test.beforeAll)

import fs from 'fs-extra';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import pg from 'pg';
import {
  CONFIG, SCHEMA, CUTOFF_MODULE_IDS, MERGE_FILE_LAYOUT, EXPECTED_QUERY, recordLengthOf,
} from './test-data.js';
import { mergeFileName, stagingPath } from './file-naming.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EOL = '\r\n';

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

// -batch and -hostkey are required, otherwise plink hangs at the host key prompt (AGENTS.md 4.4).
function plinkCommand(remoteCommand) {
  return `"${CONFIG.putty.path}" -batch ` +
    `-hostkey "${CONFIG.putty.hostKey}" ` +
    `-ssh ${CONFIG.putty.username}@${CONFIG.putty.host} ` +
    `-pw ${CONFIG.putty.password} ` +
    `"${remoteCommand}"`;
}

/** Run one batch: cd <scriptPath> && ./<batchId>. Throws if the command cannot run at all. */
async function runRemoteBatch(batchId, testCase = batchId) {
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

async function uploadFiles(fileNames, testCase = 'OLSDB057') {
  for (const name of fileNames) {
    const command = `"${CONFIG.winscp.path}" /command ` +
      `"option batch abort" ` +
      `"option confirm off" ` +
      `"open sftp://${CONFIG.winscp.username}:${CONFIG.winscp.password}@${CONFIG.winscp.host}/" ` +
      `"cd ${CONFIG.winscp.remotePath}" ` +
      `"put ""${stagingPath(name)}""" ` +
      `"exit"`;

    try {
      await execAsync(command, { timeout: 60000, maxBuffer: 1024 * 1024 * 10 });
      log(`[${testCase}] Upload OK: ${name}`);
    } catch (error) {
      throw new Error(`[${testCase}] Upload failed ${name}: ${maskSecret(error.message)}`);
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

function normalizeCutOff(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  const m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}:${m[3] || '00'}`;
  const digits = s.replace(/\D/g, '');
  return digits.length === 6
    ? `${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4, 6)}`
    : s;
}

/** Batch date (batch_date.batch_date) + cut-off of module OLSDR141 (logging only). */
export async function getBatchContext(testCase = 'OLSD141R') {
  const batchRows = await executeDbQuery(
    `SELECT batch_date FROM ${SCHEMA}.batch_date ORDER BY batch_date DESC LIMIT 1`,
    [],
    testCase
  );
  if (!batchRows.length) throw new Error(`[${testCase}] Table ${SCHEMA}.batch_date has no row.`);

  const batchDate = toIsoDate(batchRows[0].batch_date);
  const cutoffRows = await executeDbQuery(
    `SELECT module_id, current_cutoff_time, control_cutoff_time
       FROM ${SCHEMA}.oe_cutofftime_control WHERE module_id = ANY($1)`,
    [CUTOFF_MODULE_IDS],
    testCase
  );

  const picked = cutoffRows.find(
    (r) => String(r.module_id).trim() === CUTOFF_MODULE_IDS[0]
  ) || null;
  const cutOffTime = picked
    ? normalizeCutOff(picked.control_cutoff_time || picked.current_cutoff_time) || '23:59:59'
    : '23:59:59';

  return {
    batchDate,
    batchDateYmd: toYmd(batchDate),
    cutOffTime,
    cutOffModuleId: picked ? String(picked.module_id).trim() : '(no cut-off row)',
  };
}

// ============ OLSMECIF FILE BUILDER ============
/** Pad/truncate a fixed-length field (left aligned, blank padded). */
function cell(value, width) {
  const s = value === null || value === undefined ? '' : String(value);
  return s.length > width ? s.slice(0, width) : s.padEnd(width);
}

function buildRecord(definition, values) {
  return `${definition.map(([name, width]) => cell(values[name], width)).join('')}${EOL}`;
}

/**
 * Build the whole OLSMECIF file: header + one detail per merge instruction + trailer.
 * The trailer counter is the total number of records in the file.
 */
function buildMergeFile({ processingDateYmd, details }) {
  const lines = [buildRecord(MERGE_FILE_LAYOUT.header, {
    recordType: 'A', processingDate: processingDateYmd,
  })];
  for (const detail of details) {
    lines.push(buildRecord(MERGE_FILE_LAYOUT.detail, { recordType: 'D', ...detail }));
  }
  lines.push(buildRecord(MERGE_FILE_LAYOUT.trailer, {
    recordType: 'T', totalRecords: String(lines.length + 1).padStart(5, '0'),
  }));
  return lines.join('');
}

// ============ LEDGER CHECKS (BE051 / BE302) ============
/**
 * Next free file number for (file_id + source_create_date) - the same rule that produced BE302
 * for OLSTXN. TODO: confirm that OLSDB057 writes batch_header rows with file_id = 'OLSMECIF';
 * if it does not, this returns 1 and the isFileNameUsed() loop below still finds a free number.
 */
async function getNextFileNumber(isoCreateDate, testCase = 'OLSD141R') {
  const rows = await executeDbQuery(
    `SELECT MAX(NULLIF(regexp_replace(file_number, '\\D', '', 'g'), '')::bigint) AS max_no
       FROM ${SCHEMA}.batch_header
      WHERE file_id = $1 AND source_create_date::date = $2::date`,
    [CONFIG.seed.fileId, isoCreateDate],
    testCase
  );
  return (rows.length && rows[0].max_no ? Number(rows[0].max_no) : 0) + 1;
}

/** A file name already present in the ledger is rejected with BE051 (AGENTS.md 4.1). */
async function isFileNameUsed(fileName, testCase = 'OLSD141R') {
  const rows = await executeDbQuery(
    `SELECT 1 FROM ${SCHEMA}.batch_resource WHERE logical_filename = $1 LIMIT 1`,
    [fileName],
    testCase
  );
  return rows.length > 0;
}

// ============ SEED DATA ============
/** 19-digit CIF that must not exist yet, used as the "new" CIF of the merge. */
function syntheticUnusedCif(cifA) {
  const base = String(cifA).replace(/\D/g, '').padStart(19, '0').slice(-19);
  const tail = ((Number(base.slice(15)) + 7) % 10000).toString().padStart(4, '0');
  return `${base.slice(0, 15)}${tail}`;
}

/**
 * Pick the CIF pair of the merge instruction (interface spec section 2.12):
 *   CIF A not found                -> 'Z' (Not Found)
 *   CIF A found, CIF B not found   -> inactivate A, copy A to B -> 'Y'
 *   both found                     -> accounts of A move to B   -> 'Y'
 * Default: an existing CIF A + a synthetic CIF B (the normal successful merge).
 *
 * TODO: confirm the source of the seed CIF with dev. Priority:
 *   1. OLSD141R_CIF_A / OLSD141R_CIF_B, or
 *   2. CLIENT.external_reference_no (column name not confirmed - set
 *      OLSD141R_SKIP_CIF_DISCOVERY=1 to disable this query).
 */
async function resolveMergeCifPair(testCase = 'OLSD141R') {
  const envA = process.env.OLSD141R_CIF_A || null;
  const envB = process.env.OLSD141R_CIF_B || null;
  if (envA) {
    log(`[${testCase}] Seed CIF pair from environment: A=${envA}, B=${envB || '(synthetic)'}`);
    return { cifA: envA, cifB: envB || syntheticUnusedCif(envA) };
  }
  if (process.env.OLSD141R_SKIP_CIF_DISCOVERY === '1') {
    throw new Error(`[${testCase}] Set OLSD141R_CIF_A (CIF discovery is disabled).`);
  }

  const rows = await executeDbQuery(
    `SELECT c.external_reference_no AS cif_nbr
       FROM ${SCHEMA}.client c
      WHERE c.external_reference_no IS NOT NULL
        AND length(c.external_reference_no) = 19
      ORDER BY c.external_reference_no DESC
      LIMIT 1`,
    [],
    testCase
  ).catch((error) => {
    log(`[${testCase}] ⚠️ Cannot discover a CIF from ${SCHEMA}.client: ${maskSecret(error.message)}`);
    return [];
  });

  if (!rows.length) {
    throw new Error(
      `[${testCase}] No 19-digit CIF found in ${SCHEMA}.client - set OLSD141R_CIF_A and rerun.`
    );
  }

  const cifA = String(rows[0].cif_nbr).trim();
  const cifB = envB || syntheticUnusedCif(cifA);
  log(`[${testCase}] Seed CIF pair from ${SCHEMA}.client: A=${cifA}, B=${cifB} (synthetic)`);
  return { cifA, cifB };
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
/** .out / .rej / .err files written by OLSDB057 for the uploaded file. */
async function listSeedOutputs(fileName, testCase = 'OLSDB057') {
  try {
    const stdout = await executeRemoteCommand(
      `ls -1 ${CONFIG.winscp.remotePath}${fileName.replace(/\.dat$/, '')}* 2>/dev/null || true`,
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

async function waitForSeedOutputs(fileName, { add, timeoutMs = 180000, intervalMs = 5000 }) {
  const deadline = Date.now() + timeoutMs;
  let outputs = await listSeedOutputs(fileName);
  while (!outputs.files.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    outputs = await listSeedOutputs(fileName);
  }

  add('5', 'Wait for OLSDB057 output files (.out/.rej/.err)', outputs.files.length > 0,
    outputs.files.length
      ? `${outputs.files.length} output file(s): ${outputs.files.join(', ')}`
      : 'none found - the file may have been rejected before import');
  return outputs;
}

/** Poll dwh_temp_cif_merge until the run has rows (the batch may still be committing). */
async function waitForMergeRows(jobId, { timeoutMs = 180000, intervalMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let rows = 0;
  for (;;) {
    rows = await countMergeRows(jobId);
    if (rows > 0 || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return rows;
}

// ============ PREPARE DATA ============
/**
 * Full data-preparation flow: OLSMECIF -> upload -> OLSDB057 -> DWH_TEMP_CIF_MERGE -> job_id.
 * @returns {Promise<{ctx: Object, jobId: string|null, fileName: string, steps: Array}>}
 */
export async function prepareData(testCase = 'OLSD141R') {
  const steps = [];
  const add = (no, name, ok, note = '', extra = {}) => {
    steps.push({ no: String(no), name, ok: Boolean(ok), note, ...extra });
    log(`[STEP ${no}] ${ok ? '✅' : '❌'} ${name}${note ? ' — ' + note : ''}`);
  };

  log(`[${testCase}] === Prepare data for OLSD141R (CIF Merge) ===`);
  const ctx = await getBatchContext(testCase);
  log(`[${testCase}] batch date = ${ctx.batchDateYmd}, cut-off = ${ctx.cutOffTime} ` +
    `(module ${ctx.cutOffModuleId}) - cut-off is NOT a filter`);

  // ---- Step 1: build the OLSMECIF seed file ----
  const pair = await resolveMergeCifPair(testCase);
  const processingDate = process.env.OLSD141R_PROCESSING_DATE || ctx.batchDateYmd;
  const createIso = `${processingDate.slice(0, 4)}-${processingDate.slice(4, 6)}-${processingDate.slice(6, 8)}`;

  // BE051: a name already in batch_resource is rejected -> take the next free sequence.
  let seq = await getNextFileNumber(createIso, testCase);
  for (;;) {
    if (!(await isFileNameUsed(mergeFileName(processingDate, seq), testCase))) break;
    seq += 1;
  }
  const fileName = mergeFileName(processingDate, seq);

  const content = buildMergeFile({
    processingDateYmd: processingDate,
    details: [{ cifNumberA: pair.cifA, cifNumberB: pair.cifB, corpPersonalIndicator: 'P' }],
  });

  const seedCopy = path.join(CONFIG.seed.seedDir, fileName);
  fs.ensureDirSync(CONFIG.seed.seedDir);
  fs.ensureDirSync(CONFIG.winscp.localPath);
  fs.writeFileSync(seedCopy, content);
  fs.writeFileSync(stagingPath(fileName), content);

  const recordLength = recordLengthOf(MERGE_FILE_LAYOUT.detail);
  add('1', `Build ${CONFIG.seed.fileId} input file (CIF Merge)`,
    content.length === (recordLength + EOL.length) * 3,
    `${fileName}: CIF A=${pair.cifA} -> CIF B=${pair.cifB}, ${recordLength} chars/record, ` +
    `${content.length} bytes (header + 1 detail + trailer) - copy: ${seedCopy}`);

  // ---- Step 2: upload ----
  await uploadFiles([fileName], 'OLSDB057');
  add('2', 'Upload file via WinSCP to SFTP', true, `${fileName} -> ${CONFIG.winscp.remotePath}`);

  // ---- Step 3/4: run the CIF Merge batch ----
  add('3', 'Run OLSDB057 batch (CIF Merge Process)', true,
    `cd ${CONFIG.seed.scriptPath} && ./${CONFIG.seed.batchId}`);
  await runRemoteBatch(CONFIG.seed.batchId, 'OLSDB057');
  add('4', 'Wait for OLSDB057 to complete', true, 'batch finished (exit code 0)');

  // ---- Step 5/6: output files + merge rows ----
  const outputs = await waitForSeedOutputs(fileName, { add });

  const jobId = await resolveJobId(null, testCase);
  if (!jobId) {
    add('6', `Check ${SCHEMA}.dwh_temp_cif_merge rows of this run`, false,
      'no job_id found after OLSDB057 (the file may have been rejected)');
    return { ctx, jobId: null, fileName, steps };
  }

  const rowCount = await waitForMergeRows(jobId);
  const validRows = await executeDbQuery(
    `SELECT valid, count(*) AS rows FROM ${SCHEMA}.dwh_temp_cif_merge
      WHERE job_id = $1 GROUP BY valid ORDER BY valid NULLS LAST`,
    [jobId],
    testCase
  ).catch(() => []); // 'valid' is logging only

  add('6', `Check ${SCHEMA}.dwh_temp_cif_merge rows of this run`, rowCount > 0,
    `job_id=${jobId}, rows=${rowCount}` +
    (validRows.length ? ` | valid: ${validRows.map((r) => `${r.valid}=${r.rows}`).join(', ')}` : ''),
    { sql: `SELECT * FROM ${SCHEMA}.dwh_temp_cif_merge WHERE job_id = '${jobId}';` });

  log(`[${testCase}] Seed done: file=${fileName}, job_id=${jobId}, merge rows=${rowCount}`);
  return { ctx, jobId, fileName, rowCount, outputs, steps };
}

// Direct run: node scripts/OLSD141R/file-generator.js
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__dirname, 'file-generator.js')) {
  prepareData()
    .then((result) => log('Done', { steps: (result.steps || []).length, jobId: result.jobId }))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
