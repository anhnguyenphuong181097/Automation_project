// scripts/OLSD133R/file-generator.js
// Prepare input data for report OLSD133R (similar role to the file-generator.js of OLSDB024,
// but different in one important aspect: this batch does not have an input file to upload for itself).
//
// Report OLSD133R only reads data previously written by earlier batches into DWH_TEMP_TXN and 6
// TEMP_* tables. Therefore, the "file generation" here means preparing the data for those batches:
//
//   1. OLSDB009  : generate a .dat file using the OLSDB009 generator itself (do not rewrite the format)
//                  -> copy to src\ -> upload via SFTP -> run batch -> DWH_TEMP_TXN
//   2. OLSDB001 -> 023 -> 002 -> 003 -> 005 -> 051
//                  -> TEMP_LOYALTY_ACCOUNT_STATUS / TEMP_CUSTOMER_STATUS / TEMP_ACCOUNT_STATUS /
//                     TEMP_ACCOUNT_BLOCK / TEMP_POINT_EXPIRE / TEMP_CLOSED_ACCOUNT
//   3. Count rows in each source table for the current batch date (warn which section will be empty)
//
// Manual run:    node scripts/OLSD133R/file-generator.js
// Auto run:      called from the test.beforeAll of the test-runner.spec.js

import fs from 'fs-extra';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { generateTestCase } from '../OLSDB009/file-generator.js';
import {
  CONFIG, SCHEMA, SECTIONS, FORFEIT_BATCHES, ADJUSTMENT_SOURCE, CUTOFF_MODULE_ID,
} from './test-data.js';
import { stagingPath } from './file-naming.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============ HELPER FUNCTIONS ============
function log(message, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`, Object.keys(data).length ? data : '');
}

// -batch -hostkey are required: without -batch, plink stops at the prompt
// "Store key in cache? (y/n)" and hangs until killed (no stdin available).
function plinkCommand(remoteCommand) {
  return `"${CONFIG.putty.path}" ` +
    `-batch ` +
    `-hostkey "${CONFIG.putty.hostKey}" ` +
    `-ssh ${CONFIG.putty.username}@${CONFIG.putty.host} ` +
    `-pw ${CONFIG.putty.password} ` +
    `"${remoteCommand}"`;
}

/**
 * Run one batch on the server: cd <scriptPath> && ./<batchId>
 * Throw immediately if the command cannot run so it is not confused with the case where
 * the batch starts but produces no data.
 */
export async function runRemoteBatch(batchId, testCase = 'PREPARE') {
  const command = `cd ${CONFIG.batch.scriptPath} && ./${batchId}`;
  log(`[${testCase}] Run batch: ${command}`);

  try {
    const { stdout, stderr } = await execAsync(plinkCommand(command), {
      timeout: CONFIG.batch.timeout,
      maxBuffer: 1024 * 1024 * 10,
    });
    log(`[${testCase}] ${batchId} completed`);
    return { success: true, stdout, stderr };
  } catch (error) {
    throw new Error(
      `[${testCase}] Batch ${batchId} could not run: ${error.message}\n` +
      `(check VPN, plink.exe, host key, or ${CONFIG.batch.scriptPath}/${batchId})`
    );
  }
}

async function uploadFiles(fileNames, testCase = 'PREPARE') {
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
      log(`[${testCase}] Upload successful: ${name}`);
    } catch (error) {
      throw new Error(`[${testCase}] Upload failed ${name}: ${error.message}`);
    }
  }
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

async function executeDbQuery(query, params = [], testCase = 'PREPARE') {
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

// File names already in the ledger mean the batch has already imported them => uploading the same file again will fail with BE051.
// File name (sequence) is a one-time resource each day (AGENTS.md section 4.1).
async function findAlreadyImportedNames(fileNames) {
  const rows = await executeDbQuery(
    `SELECT DISTINCT logical_filename FROM ${SCHEMA}.batch_resource WHERE logical_filename = ANY($1)`,
    [fileNames]
  );
  return rows.map((r) => r.logical_filename);
}

// ============ NGAY THANG ============
function toYmd(value) {
  if (value instanceof Date) {
    return `${value.getFullYear()}${String(value.getMonth() + 1).padStart(2, '0')}${String(value.getDate()).padStart(2, '0')}`;
  }
  const s = String(value ?? '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}${m[2]}${m[3]}` : s.slice(0, 10).replace(/-/g, '');
}

function toIsoDate(value) {
  const ymd = toYmd(value);
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

function shiftIsoDate(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function normalizeCutOff(value) {
  if (value instanceof Date) {
    return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}:${String(value.getSeconds()).padStart(2, '0')}`;
  }
  const s = String(value ?? '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return `${String(m[1]).padStart(2, '0')}:${m[2]}:${m[3] || '00'}`;
  const digits = s.match(/^(\d{2})(\d{2})(\d{2})$/);
  return digits ? `${digits[1]}:${digits[2]}:${digits[3]}` : s;
}

/**
 * Batch date + time window read from DB (shared for both seed and validation):
 *   batch date      : ols_schema.batch_date.batch_date
 *   current_cut_off : ols_schema.oe_cutofftime_control WHERE module_id='OLSDR133'
 *   time window     : (BD - 1 day) + cut_off  ->  BD + cut_off
 *                     (cut_off = 23:59:59 => ends exactly at the end of the batch date)
 */
export async function getBatchContext(testCase = 'PREPARE') {
  const batchRows = await executeDbQuery(
    `SELECT batch_date FROM ${SCHEMA}.batch_date ORDER BY batch_date DESC LIMIT 1`,
    [],
    testCase
  );
  if (!batchRows.length) {
      throw new Error(`[${testCase}] Table ${SCHEMA}.batch_date has no rows.`);

  const batchDate = toIsoDate(batchRows[0].batch_date);

  const cutoffRows = await executeDbQuery(
    `SELECT current_cut_off_time FROM ${SCHEMA}.oe_cutofftime_control WHERE module_id = $1 LIMIT 1`,
    [CUTOFF_MODULE_ID],
    testCase
  );
  if (!cutoffRows.length) {
    throw new Error(`[${testCase}] No cut-off time found for module_id = '${CUTOFF_MODULE_ID}'.`);
  }

  const cutOffTime = normalizeCutOff(cutoffRows[0].current_cut_off_time);

  return {
    batchDate,
    batchDateYmd: toYmd(batchDate),
    cutOffTime,
    windowStart: `${shiftIsoDate(batchDate, -1)} ${cutOffTime}`,
    windowEnd: `${batchDate} ${cutOffTime}`,
  };
}

/** Count rows in one source table within the current batch time window */
export async function countSectionRows(section, ctx, testCase = 'SEED-CHECK') {
  const sql = `SELECT COUNT(*)::int AS total
    FROM ${SCHEMA}.${section.table} t
    WHERE ${section.filter}
      AND ${section.txnExpr} >  $1::timestamp
      AND ${section.txnExpr} <= $2::timestamp`;

  const rows = await executeDbQuery(sql, [ctx.windowStart, ctx.windowEnd], testCase);
  return rows.length ? Number(rows[0].total) : 0;
}

// ============ SEED STEPS ============
/**
 * Section 1 - load data into DWH_TEMP_TXN via OLSDB009.
 * The .dat file is generated by the OLSDB009 generator itself (do not rewrite the format).
 */
export async function prepareAdjustmentData(ctx, testCase = 'PREPARE') {
  log(`[${testCase}] Generate input file ${ADJUSTMENT_SOURCE.batch} for batch date ${ctx.batchDateYmd}`);
  const fileNames = await generateTestCase(ADJUSTMENT_SOURCE.testCase, {
    date: ctx.batchDateYmd,
    quiet: true,
  });

  // File names are a one-time daily resource: if already in the ledger, upload will fail with
  // BE051 and the job will throw, producing no additional data. Warn clearly instead of failing silently.
  const used = await findAlreadyImportedNames(fileNames);
  if (used.length) {
    log(`[${testCase}] ⚠️ File names already exist in batch_resource: ${used.join(', ')}`);
    log(`[${testCase}] ⚠️ Skip upload (avoid BE051). DWH_TEMP_TXN keeps data from the previous run.`);
    return { uploaded: [], skipped: used };
  }

  fs.ensureDirSync(CONFIG.winscp.localPath);
  const sourceDir = path.join(__dirname, '..', 'test-data', 'generated', 'OLSDB009', ADJUSTMENT_SOURCE.testCase);

  for (const name of fileNames) {
    fs.copyFileSync(path.join(sourceDir, name), stagingPath(name));
    log(`[${testCase}] Copy ${name} -> ${CONFIG.winscp.localPath}`);
  }

  await uploadFiles(fileNames, testCase);
  await runRemoteBatch(ADJUSTMENT_SOURCE.batch, testCase);

  return { uploaded: fileNames, skipped: [] };
}

/** 6 forfeit sections - run the 6 batches in EOD sequence */
export async function runForfeitBatches(testCase = 'PREPARE') {
  for (const batchId of FORFEIT_BATCHES) {
    await runRemoteBatch(batchId, testCase);
  }
}

/** Count data in each source table after seeding (sections with 0 rows will be empty in the report) */
export async function verifySeedData(ctx, testCase = 'SEED-CHECK') {
  const counts = {};
  for (const section of SECTIONS) {
    counts[section.key] = await countSectionRows(section, ctx, testCase);
    const note = counts[section.key] === 0 ? ' (this section will be empty in the report)' : '';
    log(`[${testCase}] ${section.table}: ${counts[section.key]} row(s)${note}`);
  }
  return counts;
}

/**
 * Run the full data-preparation flow: OLSDB009 -> 6 forfeit batches -> verification.
 * @returns {Promise<{ctx: Object, counts: Object}>}
 */
export async function prepareData(testCase = 'PREPARE') {
  log(`[${testCase}] === Start preparing data for OLSD133R ===`);
  const ctx = await getBatchContext(testCase);
  log(`[${testCase}] batch date = ${ctx.batchDateYmd}, cut-off = ${ctx.cutOffTime}`);
  log(`[${testCase}] data window = ${ctx.windowStart} -> ${ctx.windowEnd}`);

  await prepareAdjustmentData(ctx, testCase);
  await runForfeitBatches(testCase);

  const counts = await verifySeedData(ctx, testCase);
  log(`[${testCase}] === Finished preparing data ===`);
  return { ctx, counts };
}

// ============ CLI ============
// Run directly: node scripts/OLSD133R/file-generator.js
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  prepareData('CLI')
    .then(({ ctx, counts }) => {
      log('Completed. Data is ready for OLSD133R report generation.', { batchDate: ctx.batchDateYmd, counts });
      process.exit(0);
    })
    .catch((error) => {
      console.error(`❌ ${error.message}`);
      process.exit(1);
    });
}
