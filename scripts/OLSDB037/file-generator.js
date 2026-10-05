// scripts/OLSDB037/file-generator.js
// Prepare the input data of OLSDB037 through the REP batch OLSDB040.
//
// OLSDB037 has no input .dat file: it exports the cash rebate rows that OLSDB040 (REP Batch
// Process) already wrote into OUTPUT_CASH_REBATE. "Preparing" therefore means creating the
// conditions OLSDB040 needs, then running it:
//
//   STEP 0  batch_date (the batch date used by the run and by the expected query)
//   STEP 0b high water mark of output_cash_rebate (nothing below it can belong to this run)
//   STEP 1  resolve the REP rule that the REP batch evaluates (scheme.rule_type = 'REP') and the
//           pool it extracts. OLSDB037_RULE_ID / OLSDB037_POOL_ID pin them.
//   STEP 2  pick the two target accounts (case 1 = negative pool balance, case 2 = positive)
//   STEP 3  post the pool movement through the OLSTXN interface (OLSDB009 owns that layout - the
//           record builder is imported, not copied) and run ./OLSDB009
//   STEP 4  check the pool balance really is < 0 / > 0 before the REP batch runs
//   STEP 5  run ./OLSDB040
//   STEP 6  capture what it generated: the OCR rows of this run (fulfillment_status '01'), with
//           their REDEEMED_POINT source checked against the case (POINT_ADJUSTED / POINT_REDEEM)
//           and their REDEMPTION_FULFILMENT_STATUS row (which may legitimately not exist)
//
// Scope note (requirement 7/8): this file does NOT implement OLSDB040. It only creates realistic
// input for OLSDB037; OLSDB043 (the other upstream job) is out of scope.
//
// Environment switches
//   OLSDB037_SKIP_PREPARE=1     use the cash rebate rows already in the database
//   OLSDB037_POOL_DRYRUN=1      build the OLSTXN file but do not upload / run anything
//   OLSDB037_SKIP_POOL_MOVE=1   do not touch pool balances, just run OLSDB040
//   OLSDB037_SKIP_OLSDB040=1    do not run the REP batch (only move the balances)
//   OLSDB037_RULE_ID / OLSDB037_POOL_ID / OLSDB037_CASE1_ACCOUNT / OLSDB037_CASE2_ACCOUNT
//   OLSDB037_CASE1_AMOUNT / OLSDB037_CASE2_AMOUNT   pool units added / removed (14 digits, 2 dec.)
//
// Manual run:  node scripts/OLSDB037/file-generator.js
// In the suite: called by test.beforeAll of test-runner.spec.js.

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import pg from 'pg';
import {
  CONFIG, SCHEMA, CASES, OCR_TABLE, RFS_TABLE, STATUS_NEW, BATCH_DATE_QUERY,
  REP_BATCH_RUN_FOR_DATE_QUERY,
  OCR_HIGH_WATER_QUERY, TEST_RECORDS_QUERY, RFS_BY_REFERENCES_QUERY, col,
  REP_RULE_QUERY, REP_RULE_BY_ID_QUERY, REP_RULE_BY_POOL_QUERY, POOL_QUERY, BALANCE_BY_ACCOUNT_QUERY,
  PREPARE_ACCOUNT_QUERY, CARD_SYSTEM_OUTPUT_TYPE, NEGATIVE_BALANCE_POOL_QUERY, trimValue,
  TRANSACTION_BY_REFERENCE_QUERY, LAB_BY_ACCOUNT_POOL_QUERY,
} from './test-data.js';
import { adjustTxn, buildFile, generateFileName } from '../OLSDB009/file-generator.js';
// The project already solved the OLSTXN date problem in OLSD134R (BE301 "CreateDate is before last
// run date", BE302 "File Id with number ... is duplicated with same date"): its getHeaderDates()
// reads the dates back from batch_header and pushes them forward. Reused instead of re-inventing it.
import { getHeaderDates } from '../OLSD134R/file-generator.js';

const execAsync = promisify(exec);

// ============ HELPERS ============
function log(message, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`, Object.keys(data).length ? data : '');
}

/** Never let a password reach the log through an error message. */
function maskSecret(text) {
  let out = String(text ?? '');
  for (const secret of [CONFIG.database.password, CONFIG.putty.password, CONFIG.winscp.password]) {
    if (secret && secret.length >= 3) out = out.split(secret).join('****');
  }
  return out;
}

// ============ DATABASE ============
async function executeDbQuery(query, params = [], testCase = 'OLSDB037') {
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

/** Batch date of the environment (the batch and the expected query both use it). */
export async function readBatchDate(testCase = 'OLSDB037') {
  const rows = await executeDbQuery(BATCH_DATE_QUERY, [], testCase);
  if (!rows.length) throw new Error(`[${testCase}] ${SCHEMA}.batch_date has no row`);
  return rows[0];
}

/** YYYY-MM-DD +/- N days (date arithmetic without a library). */
function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * STEP 0 - set the batch date to the run date before anything else.
 *
 * Same pattern as OLSD134R (scripts\OLSD134R\file-generator.js updateBatchDate) and OLSD141R:
 *
 *   UPDATE ols_schema.batch_date
 *      SET batch_date      = CURRENT_DATE,
 *          processing_date = CURRENT_DATE - 1,
 *          last_update_date = now(),
 *          last_update_by   = '<TEST CASE>'
 *    WHERE record_no = (SELECT MAX(record_no) FROM ols_schema.batch_date)
 *
 * Why OLSDB037 needs it: the REP batch evaluates the REP rules against the BATCH DATE, and the
 * OLSDB037 selection rule and the file header (A0PDTE) use it as well. On dev the control date was
 * 2026-08-06 while the REP rule PACR is effective from 2026-10-02, so OLSDB040 processed nothing
 * until the batch date was moved to the run date.
 *
 * Switches (same as OLSD134R/OLSD141R):
 *   OLSDB037_SKIP_BATCHDATE_UPDATE=1  do not touch batch_date
 *   OLSDB037_BATCH_DATE=YYYY-MM-DD    use that date instead of CURRENT_DATE
 *   OLSDB037_BATCH_DATE_AUTO_ADVANCE=1  only when the run date was already consumed: keep adding one
 *                                      day until the REP batch has not processed that date yet
 * There is no automatic restore: batch_date is a shared control table, exactly like OLSD134R/OLSD141R.
 */
export async function updateBatchDate(testCase = 'OLSDB037') {
  if (process.env.OLSDB037_SKIP_BATCHDATE_UPDATE === '1') {
    log(`[${testCase}] Skip batch_date update (OLSDB037_SKIP_BATCHDATE_UPDATE=1)`);
    return null;
  }

  const override = trimValue(process.env.OLSDB037_BATCH_DATE);
  const before = await executeDbQuery(BATCH_DATE_QUERY, [], testCase);
  if (!before.length) throw new Error(`[${testCase}] ${SCHEMA}.batch_date has no row.`);
  log(`[${testCase}] batch_date before the update: batch_date = ${before[0].batch_date}, ` +
    `processing_date = ${before[0].processing_date}`);

  // The REP batch processes every due REP rule ONCE per batch date, so a batch date that has already
  // been processed produces no new cash rebate rows.
  //
  // DEFAULT = project convention (OLSD134R / OLSD141R): batch date = CURRENT_DATE. Moving the shared
  // control date days ahead is opt-in (OLSDB037_BATCH_DATE_AUTO_ADVANCE=1) because it affects every
  // other session on the dev database; when the date is already consumed the run reports it and tells
  // how to get fresh data (pin OLSDB037_BATCH_DATE or switch the auto-advance on).
  const maxSteps = Number(process.env.OLSDB037_BATCH_DATE_MAX_STEPS || 10);
  let targetDate = override || (await executeDbQuery(
    `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today`, [], testCase))[0].today;
  const today = targetDate;
  const autoAdvance = process.env.OLSDB037_BATCH_DATE_AUTO_ADVANCE === '1';

  if (!override && autoAdvance) {
    for (let step = 0; step < maxSteps; step += 1) {
      const runs = await executeDbQuery(REP_BATCH_RUN_FOR_DATE_QUERY, [CONFIG.prepare.jobName, targetDate], testCase);
      if (Number(trimValue(runs[0] && runs[0].runs) || 0) === 0) break;
      const next = addDays(targetDate, 1);
      log(`[${testCase}] the REP batch (${CONFIG.prepare.jobName}) already ran for batch date ` +
        `${targetDate} - moving the batch date to ${next} (each rule is processed once per batch date)`);
      targetDate = next;
    }
  } else if (!override) {
    const runs = await executeDbQuery(REP_BATCH_RUN_FOR_DATE_QUERY, [CONFIG.prepare.jobName, targetDate], testCase);
    if (Number(trimValue(runs[0] && runs[0].runs) || 0) > 0) {
      // Stop here instead of posting pool movements that the REP batch would ignore: the balance
      // would stay on the account and the case would report "no cash rebate row".
      throw new Error(
        `[${testCase}] the REP batch (${CONFIG.prepare.jobName}) already ran for batch date ` +
        `${targetDate}, so OLSDB040 cannot create new cash rebate rows for it (it processes every due ` +
        'REP rule once per batch date).\n' +
        '  -> OLSDB037_BATCH_DATE=<YYYY-MM-DD>  run another batch date (pin it explicitly), or\n' +
        '  -> OLSDB037_BATCH_DATE_AUTO_ADVANCE=1  let the run pick the next date the REP batch has ' +
        'not processed (it moves the shared control table - announce it to the other testers), or\n' +
        '  -> OLSDB037_SKIP_PREPARE=1  skip the preparation and verify the rows already in the database.'
      );
    }
  }

  if (targetDate !== today) {
    log(`[${testCase}] batch date of this run: ${targetDate} (run date was ${today})`);
  }

  await executeDbQuery(
    `UPDATE ${SCHEMA}.batch_date
        SET batch_date      = $2::date,
            processing_date = $2::date - 1,
            last_update_date = now(),
            last_update_by   = $1
      WHERE record_no = (SELECT MAX(record_no) FROM ${SCHEMA}.batch_date)`,
    [testCase, targetDate],
    testCase
  );

  const after = await executeDbQuery(
    `SELECT record_no,
            to_char(batch_date, 'YYYY-MM-DD')      AS batch_date,
            to_char(processing_date, 'YYYY-MM-DD') AS processing_date,
            to_char($1::date, 'YYYY-MM-DD') AS expected_batch_date
       FROM ${SCHEMA}.batch_date ORDER BY record_no DESC LIMIT 1`,
    [targetDate],
    testCase
  );

  const expectedProcessing = addDays(after[0].expected_batch_date, -1);
  const verified = after[0].batch_date === after[0].expected_batch_date &&
    after[0].processing_date === expectedProcessing;
  log(`[${testCase}] Update batch_date: ${before[0].batch_date} -> ${after[0].batch_date} ` +
    `(processing_date ${after[0].processing_date}${verified ? '' : ' - NOT VERIFIED'})` +
    `${override ? ` [OLSDB037_BATCH_DATE=${override}]` : (targetDate !== today ? ' [auto-advanced]' : '')}`);

  if (!verified) {
    throw new Error(
      `[${testCase}] batch_date update not verified: expected batch_date ${after[0].expected_batch_date} ` +
      `and processing_date ${expectedProcessing}, got batch_date ${after[0].batch_date} / ` +
      `processing_date ${after[0].processing_date}`
    );
  }
  return {
    before: before[0] || null, after: after[0] || null, verified,
    expectedBatchDate: after[0].expected_batch_date, expectedProcessingDate: expectedProcessing,
    override: override || null,
  };
}

// ============ SSH / SFTP ============
// -batch and -hostkey are required, otherwise plink hangs at the host key prompt (AGENTS.md 4.4).
function plinkCommand(remoteCommand) {
  return `"${CONFIG.putty.path}" -batch ` +
    `-hostkey "${CONFIG.putty.hostKey}" ` +
    `-ssh ${CONFIG.putty.username}@${CONFIG.putty.host} ` +
    `-pw ${CONFIG.putty.password} ` +
    `"${remoteCommand}"`;
}

export async function runRemoteBatch({ scriptPath, command, timeout, testCase, remotePath, allowFailure = false }) {
  const full = `cd ${scriptPath} && ${command}${remotePath ? ` ${remotePath}` : ''}`;
  log(`[${testCase}] Run batch: ${full}`);
  try {
    const { stdout, stderr } = await execAsync(plinkCommand(full), {
      timeout,
      maxBuffer: 1024 * 1024 * 16,
    });
    return { success: true, stdout, stderr };
  } catch (error) {
    // Exit code 20 means the batch ran and refused something (AGENTS.md 4.2): surface the reason
    // from the job error log instead of leaving the caller with an exit code only.
    const reason = await readLatestBatchError(command.replace('./', ''), testCase);
    if (allowFailure) {
      return { success: false, reason, message: maskSecret(error.message) };
    }
    throw new Error(`[${testCase}] batch ${command} failed to run: ${maskSecret(error.message)}` +
      (reason ? `\nREASON FROM THE SERVER: ${reason}` : ''));
  }
}

/**
 * Last line of the newest <BATCH>_*.err of the input folder of a batch, i.e. the real reason why a
 * file was refused (BE301 createDate in the past, BE051/duplicate file number, E910 ...).
 * Best effort: when the folder or the file cannot be read, the caller keeps the exit code only.
 */
async function readLatestBatchError(batchId, testCase) {
  try {
    const folder = CONFIG.prepare.poolRemotePath;
    // No quotes inside the remote command: plinkCommand already wraps it in double quotes, so the
    // message is extracted here in JavaScript from the last lines of the error log.
    const command = `ls -t ${folder}${batchId}_*.err | head -1 | xargs -r tail -3`;
    const { stdout } = await execAsync(plinkCommand(command), { timeout: 60000, maxBuffer: 1024 * 1024 });
    const messages = [...String(stdout).matchAll(/"message":"([^"]*)"/g)].map((m) => m[1]);
    return messages.length ? messages[messages.length - 1] : trimValue(stdout).split('\n').pop();
  } catch (error) {
    return '';
  }
}

/**
 * Per-record result of the OLSTXN file that was just processed.
 *
 * OLSDB009 writes every DT record it read into <file>_<jobId>_<batchDate>.out with the processing
 * verdict appended (`true` / `false|<CODE>|<message>`), and the rejected ones into the matching
 * .rej. Reading it back turns "no balance row after the movement" into the real reason, for example
 *   BE678 "The transaction has already been processed"   (same account + pool posted twice in a day)
 *   BE108 "This Product Account does not exist"
 * @returns {Promise<Map<string, string>>} key = txnProdAcctNbr (the 3rd customer field), value = the code
 */
async function readOlstxnRecordResults(fileName, testCase) {
  const results = new Map();
  try {
    const folder = CONFIG.prepare.poolRemotePath;
    const command = `cat ${folder}${fileName.replace(/\.dat$/, '')}*.out ` +
      `${folder}${fileName.replace(/\.dat$/, '')}*.rej 2>/dev/null | grep -a DT | cut -c1-700`;
    const { stdout } = await execAsync(plinkCommand(command), { timeout: 60000, maxBuffer: 1024 * 1024 * 8 });

    for (const line of String(stdout).split(/\r?\n/)) {
      if (!line.startsWith('DT|')) continue;
      const cells = line.split('|');
      const accountNo = cells[5];
      const tail = cells.slice(-3).join('|');
      const code = (tail.match(/(BE\d+|[A-Z]{1,3}\d{3,5})/) || [])[1] || 'OK';
      if (!accountNo) continue;
      // A record that was accepted shows up as `true`; keep the first verdict per account.
      if (!results.has(accountNo) || code !== 'OK') results.set(accountNo, code);
    }
  } catch (error) {
    log(`[${testCase}] could not read the OLSTXN record results: ${maskSecret(error.message)}`);
  }
  return results;
}

async function uploadFile(localPath, remoteDir, testCase) {
  // Host key pinned exactly like plink's -hostkey (AGENTS.md 4.4): without it WinSCP waits for an
  // answer at the "unknown server" prompt and, with no stdin, the run hangs.
  // The whole `open` cell is already wrapped in one pair of quotes, so the value needs two more at
  // the end - the exact shape WinSCP prints on its prompt and expects back.
  const hostKey = CONFIG.winscp.hostKey ? ` -hostkey=""${CONFIG.winscp.hostKey}""` : '';
  const command = `"${CONFIG.winscp.path}" /command ` +
    `"option batch abort" ` +
    `"option confirm off" ` +
    `"option transfer binary" ` +
    `"open sftp://${CONFIG.winscp.username}:${CONFIG.winscp.password}@${CONFIG.winscp.host}/${hostKey}" ` +
    `"cd ${remoteDir}" ` +
    `"put ""${localPath}""" ` +
    `"exit"`;
  try {
    await execAsync(command, { timeout: 120000, maxBuffer: 1024 * 1024 * 10 });
  } catch (error) {
    throw new Error(`[${testCase}] upload of ${path.basename(localPath)} failed: ${maskSecret(error.message)}`);
  }
  log(`[${testCase}] uploaded ${path.basename(localPath)} to ${remoteDir}`);
}

/**
 * Wait until the uploaded file is complete and readable on the server.
 *
 * Uploading and immediately running the batch can catch the file while the SFTP session is still
 * closing it: OLSDB009 then answers
 *   "Can not access file OLSTXN-...-08.dat ... Please give access right for this file"
 * (measured on dev 2026-10-05). The remote size is compared with the local size until they match.
 */
async function waitForRemoteFile(localPath, fileName, testCase, timeoutMs = 30000) {
  const expected = fs.statSync(localPath).size;
  const start = Date.now();
  let lastSize = -1;

  while (Date.now() - start < timeoutMs) {
    try {
      const { stdout } = await execAsync(
        plinkCommand(`stat -c %s ${CONFIG.prepare.poolRemotePath}${fileName}`),
        { timeout: 30000, maxBuffer: 1024 * 1024 }
      );
      const size = Number(trimValue(stdout));
      if (size === expected && size === lastSize) return size; // stable for two reads
      lastSize = size;
    } catch (error) {
      // file not visible yet - keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  log(`[${testCase}] WARNING: could not confirm the size of ${fileName} on the server within ` +
    `${timeoutMs / 1000}s (local size ${expected}) - continuing`);
  return null;
}

// ============ DISCOVERY: REP RULE / POOL / ACCOUNTS ============
/**
 * The REP rule the batch will evaluate. scheme.rule_type = 'REP' is the key the BA uses for the
 * cash rebate flow (F:\SQL\Script run batch.sql). OLSDB037_RULE_ID pins one rule.
 */
export async function resolveRepRule(testCase = 'OLSDB037') {
  // 1. the rule given for this automation (env, then the documented default of the project)
  // 2. discovery: any active REP rule that outputs to the card system, daily rules first
  const preferred = (process.env.OLSDB037_RULE_ID || CONFIG.prepare.defaultRuleId || '').trim();
  let rows = [];
  let usedPreferred = false;

  if (preferred) {
    rows = await executeDbQuery(REP_RULE_BY_ID_QUERY, [preferred], testCase);
    if (rows.length) {
      usedPreferred = true;
      // The REP batch evaluates the effective dates against the BATCH DATE, not the wall clock.
      if (String(rows[0].effective_on_batch_date) === 'false') {
        log(`[${testCase}] WARNING: rule ${preferred} is NOT effective on batch date ` +
          `${trimValue(rows[0].current_batch_date)} (rule runs ${rows[0].scheme_start_date} .. ` +
          `${rows[0].scheme_end_date}). The REP batch evaluates the rules against the batch date, ` +
          'so OLSDB040 will not process this rule until the batch date falls inside that window ' +
          '(or the rule dates are changed).');
      }
    } else {
      log(`[${testCase}] the preferred REP rule "${preferred}" is not in ${SCHEMA}.scheme - ` +
        'falling back to discovery (set OLSDB037_RULE_ID to pin another one)');
    }
  }

  if (!rows.length) {
    rows = await executeDbQuery(REP_RULE_QUERY, [CARD_SYSTEM_OUTPUT_TYPE], testCase);
    if (rows.length && preferred) {
      log(`[${testCase}] NOTE: "${preferred}" was not available, using the discovered rule ` +
        `${rows[0].scheme_id} instead`);
    }
  }

  if (!rows.length) {
    throw new Error(
      `[${testCase}] no active REP rule found in ${SCHEMA}.scheme (rule_type = 'REP', ` +
      `status = 'A', output_redemption_as = '${CARD_SYSTEM_OUTPUT_TYPE}', effective today).\n` +
      '  -> OLSDB040 only extracts pools configured through a REP rule, so there is nothing to\n' +
      '     prepare until one exists. Set OLSDB037_RULE_ID to check one specific rule.'
    );
  }
  if (rows.length > 1 && !usedPreferred) {
    log(`[${testCase}] ${rows.length} active REP rules with output ${CARD_SYSTEM_OUTPUT_TYPE}; ` +
      `using ${rows[0].scheme_id} (${trimValue(rows[0].rule_name)}, schedule ` +
      `${trimValue(rows[0].run_schedule) || 'n/a'}). Other candidates: ` +
      `${rows.slice(1).map((r) => r.scheme_id).join(', ')} - set OLSDB037_RULE_ID to pin one`);
  }
  const rule = rows[0];
  log(`[${testCase}] REP rule ${rule.scheme_id} "${trimValue(rule.rule_name)}" ` +
    `(campaign ${rule.campaign_id}, schedule ${trimValue(rule.run_schedule) || 'n/a'}) extracts ` +
    `pool ${rule.pool_id} as ${trimValue(rule.output_redemption_as)} with TC ` +
    `${trimValue(rule.red_txn_code) || 'n/a'}, effective ${rule.scheme_start_date} .. ` +
    `${rule.scheme_end_date}`);
  if (!trimValue(rule.adj_txn_code)) {
    log(`[${testCase}] NOTE: rule ${rule.scheme_id} has no "-ve Bal. Adjust. Transaction Code" ` +
      '(adj_txn_code is empty), so a pool balance below zero is NOT extracted by the REP batch ' +
      '(FSD 7.9: such accounts are excluded and reported).');
  }
  return rule;
}

/**
 * Resolve the pool of every case.
 *
 * Positive case  : the pool of the REP rule (the rule the REP batch evaluates).
 * Negative case  : per the agreement with the BA, a CASH REBATE pool that accepts a negative balance
 *                  (pool_type 'CR' + allow_negative_balance 'Y'), together with the REP rule that
 *                  extracts it and is effective on the batch date - see NEGATIVE_BALANCE_POOL_QUERY.
 *                  OLSDB037_CASE1_POOL / OLSDB037_CASE2_POOL pin one pool instead.
 *
 * A pool that no effective REP rule extracts is useless for this automation: OLSDB040 would never
 * turn its balance into a cash rebate row, so such a pool is reported as not preparable.
 *
 * @returns {Promise<Array<{caseId, poolId, pool, rule, resolvedBy, warnings, reasons, ok}>>}
 */
export async function resolveCasePools(rule, defaultPoolRow, testCase = 'OLSDB037') {
  const out = [];

  for (const caseDef of CASES) {
    const entry = {
      caseId: caseDef.id, poolId: null, pool: defaultPoolRow, rule: null,
      resolvedBy: '', warnings: [], reasons: [], ok: true,
    };

    // 0. a rule pinned for this case wins: the pool is the one that rule extracts.
    if (caseDef.rule) {
      const ruleRows = await executeDbQuery(REP_RULE_BY_ID_QUERY, [caseDef.rule], testCase);
      if (!ruleRows.length) {
        entry.ok = false;
        entry.reasons.push(`rule ${caseDef.rule} (pinned for ${caseDef.id}) is not an active REP rule`);
        out.push(entry);
        continue;
      }
      entry.rule = ruleRows[0];
      entry.poolId = trimValue(ruleRows[0].pool_id);
      entry.pool = (await executeDbQuery(POOL_QUERY, [entry.poolId], testCase))[0] || null;
      entry.resolvedBy = `rule ${caseDef.rule} (${trimValue(ruleRows[0].rule_name)}, schedule ` +
        `${trimValue(ruleRows[0].run_schedule) || 'n/a'}, adj_txn_code ` +
        `${trimValue(ruleRows[0].adj_txn_code) || 'empty'})`;
      if (caseDef.poolBalance === 'negative') {
        // A negative pool balance is only extracted by the REP batch when the pool accepts the
        // negative balance AND charges it to the card (BA rule), and the rule carries the
        // "-ve Bal. Adjust. Transaction Code" (FSD 7.9).
        const allowNegative = entry.pool
          ? trimValue(entry.pool.allow_negative_balance).toUpperCase() : '';
        const chargeNegative = entry.pool
          ? trimValue(entry.pool.charge_negative_balance).toUpperCase() : '';
        if (allowNegative !== 'Y') {
          entry.ok = false;
          entry.reasons.push(`pool ${entry.poolId} of rule ${caseDef.rule} has allow_negative_balance = ` +
            `"${allowNegative || 'null'}" (a negative balance cannot be posted)`);
        }
        if (entry.ok && chargeNegative !== 'Y') {
          entry.ok = false;
          entry.reasons.push(`pool ${entry.poolId} has charge_negative_balance = ` +
            `"${chargeNegative || 'null'}" ("Charge Negative Balance to Card" must be Yes for the REP ` +
            'batch to extract an account whose pool balance is negative)');
        }
        if (entry.ok && !trimValue(entry.rule.adj_txn_code)) {
          entry.warnings.push(
            `REP rule ${caseDef.rule} has no "-ve Bal. Adjust. Transaction Code" (adj_txn_code), so ` +
            'FSD 7.9 says the REP batch only reports accounts with a negative pool balance');
        }
      }
      out.push(entry);
      continue;
    }

    if (caseDef.poolBalance !== 'negative') {
      // Positive case -> the pool of the rule that was resolved (PACR -> L3ZE by default).
      entry.poolId = caseDef.pool || trimValue(rule.pool_id);
      entry.resolvedBy = caseDef.pool ? 'OLSDB037_CASE2_POOL' : `rule ${trimValue(rule.scheme_id)}`;
      entry.rule = rule;
      if (caseDef.pool && caseDef.pool !== trimValue(rule.pool_id)) {
        entry.pool = (await executeDbQuery(POOL_QUERY, [entry.poolId], testCase))[0] || null;
      }
      out.push(entry);
      continue;
    }

    // Negative case -> a cash rebate pool that accepts a negative balance, plus its REP rule.
    if (caseDef.pool) {
      const rows = await executeDbQuery(POOL_QUERY, [caseDef.pool], testCase);
      entry.poolId = caseDef.pool;
      entry.pool = rows[0] || null;
      entry.resolvedBy = 'OLSDB037_CASE1_POOL';
      const extracting = await executeDbQuery(
        REP_RULE_BY_POOL_QUERY, [entry.poolId, CARD_SYSTEM_OUTPUT_TYPE], testCase
      );
      entry.rule = extracting[0] || null;
      if (!entry.rule) {
        entry.warnings.push(
          `no active REP rule with output ${CARD_SYSTEM_OUTPUT_TYPE} extracts pool ${entry.poolId}, ` +
          'so the REP batch will never turn its balance into a cash rebate row');
      }
    } else {
      const rows = await executeDbQuery(NEGATIVE_BALANCE_POOL_QUERY, [CARD_SYSTEM_OUTPUT_TYPE, 1], testCase);
      if (rows.length) {
        const row = rows[0];
        entry.poolId = trimValue(row.pool_id);
        entry.pool = row;
        entry.rule = {
          scheme_id: trimValue(row.scheme_id), rule_name: trimValue(row.rule_name),
          run_schedule: trimValue(row.run_schedule), adj_txn_code: trimValue(row.adj_txn_code),
          adj_txn_reason: trimValue(row.adj_txn_reason), red_txn_code: trimValue(row.red_txn_code),
          pool_id: entry.poolId,
        };
        entry.resolvedBy = `cash rebate pool with a negative balance allowed (rule ${entry.rule.scheme_id}, ` +
          `schedule ${entry.rule.run_schedule || 'n/a'}, ${row.balances} balance(s) on dev)`;
      }
    }

    if (!entry.poolId || !entry.pool) {
      entry.ok = false;
      entry.reasons.push(
        'no CASH REBATE pool with allow_negative_balance = Y and charge_negative_balance = Y is ' +
        'extracted by an active REP rule that outputs the card system file on this batch date');
    } else {
      if (trimValue(entry.pool.allow_negative_balance).toUpperCase() !== 'Y') {
        entry.ok = false;
        entry.reasons.push(`pool ${entry.poolId} has allow_negative_balance = ` +
          `"${trimValue(entry.pool.allow_negative_balance) || 'null'}", a negative balance cannot be posted`);
      }
      if (trimValue(entry.pool.charge_negative_balance).toUpperCase() !== 'Y') {
        entry.ok = false;
        entry.reasons.push(`pool ${entry.poolId} has charge_negative_balance = ` +
          `"${trimValue(entry.pool.charge_negative_balance) || 'null'}" - "Charge Negative Balance to ` +
          'Card" must be Yes for the REP batch to extract a negative pool balance');
      }
    }

    if (entry.ok && !trimValue(entry.rule && entry.rule.adj_txn_code)) {
      entry.warnings.push(
        `REP rule ${trimValue(entry.rule && entry.rule.scheme_id)} has no "-ve Bal. Adjust. Transaction ` +
        'Code" (adj_txn_code), so FSD 7.9 says the REP batch only reports accounts with a negative ' +
        'pool balance instead of extracting them - the negative balance is still posted here, and ' +
        'whether it produces a cash rebate row is reported by the run');
    }
    out.push(entry);
  }

  return out;
}

/** Configuration row of the extracted pool (reported in the dashboard, never assumed). */
export async function resolvePool(poolId, testCase = 'OLSDB037') {
  const rows = await executeDbQuery(POOL_QUERY, [poolId], testCase);
  if (!rows.length) {
    throw new Error(`[${testCase}] pool ${poolId} of the REP rule does not exist in ${SCHEMA}.pool`);
  }
  return rows[0];
}

/**
 * Accounts used by the two cases: active product accounts with a card (the output file carries
 * A1KRTN / A1KNTN) and a balance row in the extracted pool. The CSN is what balance_detail_view
 * and the OLSTXN adjustment use; the account number / type / level are what the file carries.
 */
export async function resolvePrepareAccounts(
  poolId, wanted, testCase = 'OLSDB037', pinnedAccount = null, excludeCsns = []
) {
  const rows = await executeDbQuery(PREPARE_ACCOUNT_QUERY, [poolId, Math.max(wanted * 10, 20)], testCase);

  // The candidate query joins the card link table, so one account appears once per account serial
  // number it has. The two cases must use DIFFERENT CSNs: a pool balance belongs to a CSN, and two
  // adjustments on the same CSN would fight over the same balance.
  const seen = new Set();
  const pool = [];
  for (const row of rows) {
    const account = {
      productAccountNo: trimValue(row.product_account_no),
      productAccountType: trimValue(row.product_account_type),
      productAccountLevel: trimValue(row.product_account_level),
      csn: trimValue(row.csn),
      accountSerialNo: trimValue(row.account_serial_no),
      cardNo: trimValue(row.card_no),
      loyaltyAccountNo: trimValue(row.loyalty_account_no),
      balanceUpdatedAt: trimValue(row.lab_last_update),
      // CIF sent in txnCifNbr: the OLSDB009 generator resolves it as cust_cif_nbr, else the
      // CIF-like card.customer_id (the production accounts only carry the latter).
      cif: trimValue(row.customer_id),
      poolBalance: row.pool_balance === null ? null : Number(row.pool_balance),
    };
    const key = `${account.productAccountNo}|${account.csn}`;
    if (!account.productAccountNo || !account.csn || seen.has(key)) continue;
    seen.add(key);
    pool.push(account);
  }
  // Accounts that already carry a balance row in this pool are the safest targets.
  pool.sort((a, b) => Number(a.poolBalance === null) - Number(b.poolBalance === null));

  // When both cases use the same pool they still need different CSNs: a pool balance belongs to a
  // CSN, so two adjustments on the same CSN would fight over one balance row.
  const excluded = new Set(excludeCsns.map((value) => trimValue(value)).filter(Boolean));
  const available = pool.filter((row) => !excluded.has(row.csn));
  if (excluded.size && available.length < wanted) {
    throw new Error(
      `[${testCase}] only ${available.length} candidate account(s) left for pool ${poolId} after ` +
      `excluding the CSN(s) already used by another case (${[...excluded].join(', ')}).\n` +
      '  -> pin OLSDB037_CASE1_ACCOUNT / OLSDB037_CASE2_ACCOUNT, or let the cases use different pools.'
    );
  }
  const candidates = available.length >= wanted ? available : pool;

  if (pinnedAccount) {
    const found = candidates.find((row) => row.productAccountNo === trimValue(pinnedAccount));
    if (found) return [found];
    // The pinned account is not in the candidate list (no RWD/OCR row, no card, or no loyalty link):
    // keep it, but flag that the preparation could not be checked beforehand.
    return [{
      productAccountNo: trimValue(pinnedAccount), productAccountType: '', productAccountLevel: '',
      csn: '', accountSerialNo: '', cardNo: '', loyaltyAccountNo: '', cif: '',
      poolBalance: null, unverified: true,
    }];
  }

  const picked = [];
  const usedCsn = new Set();
  for (let index = 0; index < wanted; index += 1) {
    const account = candidates.find((row) => !usedCsn.has(row.csn));
    if (!account) {
      throw new Error(
        `[${testCase}] only ${candidates.length} distinct RWD/OCR candidate account(s) in ` +
        `${SCHEMA}.product_account for pool ${poolId}, but ${wanted} case(s) need different CSNs.\n` +
        '  -> set OLSDB037_CASE1_ACCOUNT / OLSDB037_CASE2_ACCOUNT to pin the accounts.'
      );
    }
    usedCsn.add(account.csn);
    picked.push(account);
  }
  return picked;
}

/** Live balance of one CSN in the extracted pool. */
export async function getPoolBalance(csn, poolId, testCase = 'OLSDB037') {
  if (!csn) return { found: false, balance: null };
  const rows = await executeDbQuery(BALANCE_BY_ACCOUNT_QUERY, [csn, poolId], testCase);
  if (!rows.length) return { found: false, balance: null, csn, poolId };
  return {
    found: true,
    csn,
    poolId,
    balance: Number(rows[0].balance),
    redeemable: Number(rows[0].redeemable_bal),
  };
}

// ============ OLSTXN POOL MOVEMENT ============
/**
 * OLSTXN file number, same rule as OLSD134R (scripts\OLSD134R\file-generator.js):
 * the batch checks (file_id + file_number + source_create_date) - BE302 "File Id with number
 * OLSTXN@0001 is duplicated with same date 2026-09-21" - so the number comes from
 * batch_header for that createDate, not from the file name.
 */
async function getNextOlsTxnFileNumber(createDateYmd, testCase) {
  const iso = `${createDateYmd.slice(0, 4)}-${createDateYmd.slice(4, 6)}-${createDateYmd.slice(6, 8)}`;
  const rows = await executeDbQuery(
    `SELECT MAX(NULLIF(regexp_replace(file_number, '\\D', '', 'g'), '')::bigint) AS max_no
       FROM ${SCHEMA}.batch_header
      WHERE file_id = $1 AND source_create_date::date = $2::date`,
    ['OLSTXN', iso],
    testCase
  );
  const maxNo = rows.length && rows[0].max_no ? Number(rows[0].max_no) : 0;
  return maxNo + 1;
}

/** A file name already used (any status except the rejected 'R') would get BE051 - OLSD134R rule. */
async function isFileNameUsed(fileName, testCase) {
  const rows = await executeDbQuery(
    `SELECT process_status FROM ${SCHEMA}.batch_resource WHERE logical_filename = $1 LIMIT 1`,
    [fileName],
    testCase
  );
  if (!rows.length) return false;
  return trimValue(rows[0].process_status).toUpperCase() !== 'R';
}

/** HD cell[3]/[4]/[5] = source_create_date / source_batch_date / file_number (verified on dev). */
function setOlstxnHeaderDates(content, { createDate, batchDate, fileNumber }) {
  const lines = String(content).split(/\r?\n/).map((line) => {
    if (!line.startsWith('HD|')) return line;
    const cells = line.split('|');
    if (cells.length > 5) {
      cells[3] = createDate;
      cells[4] = batchDate;
      if (fileNumber) cells[5] = fileNumber;
    }
    return cells.join('|');
  });
  return lines.join('\r\n');
}

/** DT cell[10]/[12] = txnTranDate / txnSrcPostDate (the OLSDB009 generator writes getCurrentDate()). */
function setOlstxnDetailDates(content, dateYmd) {
  let changed = 0;
  const lines = String(content).split(/\r?\n/).map((line) => {
    if (!line.startsWith('DT|')) return line;
    const cells = line.split('|');
    if (cells.length > 12) {
      cells[10] = dateYmd;
      cells[12] = dateYmd;
      changed += 1;
    }
    return cells.join('|');
  });
  return { content: lines.join('\r\n'), changed };
}

/**
 * Move the pool balance of every case so that it has the sign the case needs, in ONE OLSTXN file
 * (one upload, one OLSDB009 run - the batch is a Java job, so one run per preparation is enough).
 *
 * The amount is computed from the live balance, so the case holds whatever the environment had
 * before:
 *   positive case: balance + delta >= delta > 0
 *   negative case: balance - delta <= -delta < 0
 *
 * The records are built by the OLSDB009 generator (adjustTxn / buildFile): that module owns the
 * OLSTXN layout, the hashes and the file naming, so the format is never duplicated here.
 *
 * Dates (same scheme as OLSD134R):
 *   file name                                 -> the RUN date (OLSDB009 refuses a file whose name date
 *                                                is greater than the current date: "The date of file
 *                                                name must not be greater than current date", measured
 *                                                on dev 2026-10-05 when the batch date was advanced)
 *   DT txnTranDate/txnSrcPostDate             -> the BATCH date under test
 *   HD createDate                             -> MAX(today, MAX(batch_header.source_create_date))
 *   HD batchDate                              -> MAX(today, MAX(source_batch_date) + 1 day)
 * The HD dates come from getHeaderDates() of OLSD134R, because a createDate before the last run date
 * is refused with BE301 "CreateDate 2026-08-06 is before last run date of 2026-10-02" (measured on
 * dev 2026-10-02 when the batch date had been moved back to 2026-08-06).
 *
 * @returns {Promise<{fileName: string, localPath: string, movements: object[]}>}
 */
export async function buildPoolMovements({
  items, batchDateYmd, runDateYmd, testCase = 'OLSDB037', dryRun = false, maxAttempts = 8,
}) {
  const dateYmd = batchDateYmd;      // DT transaction dates
  const fileDateYmd = runDateYmd || batchDateYmd; // file name date
  const { getPool } = await import('../OLSDB009/data-pool.js');
  const pool = await getPool();
  const details = [];
  const movements = [];

  for (const { caseDef, account, poolId } of items) {
    const before = await getPoolBalance(account.csn, poolId, testCase);
    const current = Number.isFinite(before.balance) ? before.balance : 0;
    const requested = Number(String(caseDef.adjustAmount).replace(/[^0-9]/g, '')) / 100; // 9(14,2)
    const sign = caseDef.adjustSign === '-' ? -1 : 1;

    // delta that guarantees the sign even when the account already has a balance of the other sign.
    const delta = sign > 0
      ? requested + Math.max(0, -current)
      : requested + Math.max(0, current);

    const minor = String(Math.round(delta * 100)).padStart(14, '0'); // 9(14,2)
    // The adjustment is keyed by the product account (txnCifNbr stays empty: only one of the three
    // identifiers must be sent, see the OLSTXN detail record rule).
    details.push(adjustTxn(pool, {
      txnCifNbr: account.cif || '',
      txnProdAcctNbr: account.productAccountNo,
      txnProdAcctType: account.productAccountType,
      txnProdAcctLevel: account.productAccountLevel,
      txnPoolId: poolId,
      txnTranAmt: minor,
      txnOrigTxnAmt: minor,
      txnTranSign: sign > 0 ? '+' : '-',
    }));

    movements.push({
      caseId: caseDef.id, poolId, account: account.productAccountNo, csn: account.csn,
      sign, delta, requested, balanceBefore: before.found ? current : null,
      expectedAfter: sign > 0 ? current + delta : current - delta,
    });
    log(`[${testCase}] ${caseDef.id}: pool ${poolId}, account ${account.productAccountNo} ` +
      `(csn ${account.csn}) ${sign > 0 ? '+' : '-'}${delta} pool units ` +
      `(balance before: ${before.found ? current : 'no balance row'})`);
  }

  // The sequence number is a one-shot resource shared with every other session on this dev server:
  // another run can take the number between the ledger read and the upload. The batch answers
  //   "File Id with number OLSTXN@0051 is duplicated with same date <date>"   (measured on dev)
  // so the file is rebuilt with the next free number instead of failing the whole preparation.
  // Header dates exactly like OLSD134R: createDate must not be before the last run date (BE301) and
  // each file needs its own batch date, both read back from batch_header.
  const headerDates = await getHeaderDates(testCase);
  const attempts = dryRun ? 1 : maxAttempts;
  let lastReason = '';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // File number for (file_id + file_number + createDate) - BE302.
    let seq = await getNextOlsTxnFileNumber(headerDates.createDate, testCase);
    let fileName = generateFileName(seq, fileDateYmd);
    while (await isFileNameUsed(fileName, testCase)) {
      seq += 1;
      fileName = generateFileName(seq, fileDateYmd);
    }

    // The OLSDB009 generator builds the whole record set; the dates are then patched the way
    // OLSD134R does it (HD createDate/batchDate + DT transaction dates).
    let content = buildFile({ date: dateYmd, fileNumber: seq, details });
    content = setOlstxnHeaderDates(content, {
      createDate: headerDates.createDate,
      batchDate: headerDates.batchDate,
      fileNumber: String(seq).padStart(4, '0'),
    });
    const dated = setOlstxnDetailDates(content, dateYmd);
    content = dated.content;
    log(`[${testCase}] ${fileName}: HD createDate=${headerDates.createDate} ` +
      `(MAX(source_create_date)=${headerDates.maxCreateDate || '-'}), ` +
      `HD batchDate=${headerDates.batchDate} (MAX(source_batch_date)=${headerDates.maxBatchDate || '-'} + 1), ` +
      `file_number=${String(seq).padStart(4, '0')}, ${dated.changed} DT record(s) dated ${dateYmd}`);

    fs.ensureDirSync(CONFIG.prepare.localDir);
    const localPath = path.join(CONFIG.prepare.localDir, fileName);
    fs.writeFileSync(localPath, content);
    log(`[${testCase}] ${fileName} written with ${details.length} adjustment record(s): ${localPath}` +
      (attempt > 1 ? ` (attempt ${attempt}/${attempts})` : ''));

    if (dryRun) return { fileName, localPath, movements, dryRun: true };

    await uploadFile(localPath, CONFIG.prepare.poolRemotePath, testCase);
    await waitForRemoteFile(localPath, fileName, testCase);
    const run = await runRemoteBatch({
      scriptPath: CONFIG.prepare.poolScriptPath,
      command: CONFIG.prepare.poolCommand,
      timeout: CONFIG.prepare.poolTimeout,
      testCase,
      allowFailure: true,
    });
    if (run.success) {
      log(`[${testCase}] ${CONFIG.prepare.poolBatchId} finished (pool movements posted)`);
      // Per-record verdict: a file can be accepted while a single adjustment is refused (BE678, BE108,
      // E910 ...). The reasons are attached to the movements so the caller can report them per case.
      const recordResults = await readOlstxnRecordResults(fileName, testCase);
      for (const movement of movements) {
        const code = recordResults.get(movement.account);
        if (code && code !== 'OK') {
          movement.rejected = code;
          log(`[${testCase}] ${movement.caseId}: the adjustment for account ${movement.account} was ` +
            `refused with ${code}`);
        }
      }
      return { fileName, localPath, movements };
    }

    lastReason = run.reason || run.message || 'unknown reason';
    if (/duplicat/i.test(lastReason) && attempt < attempts) {
      log(`[${testCase}] ${fileName} was refused ("${lastReason}") - another session took that ` +
        'number, retrying with the next one');
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    throw new Error(`[${testCase}] ${CONFIG.prepare.poolBatchId} refused ${fileName}: ` +
      `${lastReason}\n  -> the OLSTXN file was left on the server as a .rej; fix the reason and ` +
      'run the preparation again.');
  }
  throw new Error(`[${testCase}] ${CONFIG.prepare.poolBatchId} kept refusing the file: ${lastReason}`);
}

// ============ CASH REBATE LEDGER ============
/** Highest record_no of output_cash_rebate before OLSDB040 runs. */
export async function ocrHighWaterMark(testCase = 'OLSDB037') {
  const rows = await executeDbQuery(OCR_HIGH_WATER_QUERY, [], testCase);
  return trimValue(rows[0] && rows[0].max_record_no) || '0';
}

/** Cash rebate rows created after the high water mark for the accounts of this run. */
export async function fetchTestRecords(highWaterMark, accounts, testCase = 'OLSDB037') {
  const numbers = accounts.map((a) => a.productAccountNo).filter(Boolean);
  if (!numbers.length) return [];
  return executeDbQuery(TEST_RECORDS_QUERY, [highWaterMark, numbers], testCase);
}

/**
 * Fulfilment rows of the cash rebate references of this run, keyed by txn_reference_no.
 * A cash rebate row may legitimately have no fulfilment row (requirement 3).
 */
export async function fetchRfs(txnReferenceNos, testCase = 'OLSDB037') {
  const references = (Array.isArray(txnReferenceNos) ? txnReferenceNos : [txnReferenceNos])
    .map((value) => trimValue(value)).filter(Boolean);
  if (!references.length) return new Map();
  const rows = await executeDbQuery(RFS_BY_REFERENCES_QUERY, [references], testCase);
  const byReference = new Map();
  for (const row of rows) {
    const key = trimValue(row.txn_reference_no);
    if (!byReference.has(key)) byReference.set(key, row);
  }
  return byReference;
}

// ============ MAIN ============
/**
 * Prepare the input data of OLSDB037 through OLSDB040.
 *
 * @returns {Promise<Object>} everything the spec needs to know about this run: the batch date, the
 *   REP rule / pool, the two cases with their accounts, the OLSTXN files, the OCR rows OLSDB040
 *   created and the fulfilment rows of those references.
 */
export async function prepareData(testCase = 'OLSDB037') {
  const runId = process.env.OLSDB037_RUN_ID || `OLSDB037-${Date.now()}`;
  const dryRun = process.env.OLSDB037_POOL_DRYRUN === '1';
  const skipPoolMove = process.env.OLSDB037_SKIP_POOL_MOVE === '1';
  const skipRepBatch = process.env.OLSDB037_SKIP_OLSDB040 === '1';

  // ---- STEP 0: batch date = run date (same as OLSD134R / OLSD141R) ----
  let batchDateUpdate = null;
  if (dryRun) {
    log(`[${testCase}] STEP 0 skipped: dry run does not change ols_schema.batch_date`);
  } else {
    batchDateUpdate = await updateBatchDate(testCase);
  }

  const batchRow = await readBatchDate(testCase);
  const batchDate = trimValue(batchRow.batch_date);
  // Batch date (the business day the batches process) and run date (today) are two different things,
  // and the OLSTXN file needs both (scheme of OLSD134R):
  //   * batch date -> the file name, the DT transaction dates, the OLSDB037 selection, A0PDTE
  //   * run date   -> only indirectly: the HD createDate/batchDate come from getHeaderDates(),
  //                   which reads MAX(source_create_date)/MAX(source_batch_date) from batch_header
  //                   and never goes back in time (otherwise BE301).
  const dateYmd = batchDate.replace(/-/g, '');
  const runDateYmd = (await executeDbQuery(
    `SELECT to_char(CURRENT_DATE, 'YYYYMMDD') AS today`, [], testCase))[0].today;
  const highWaterMark = await ocrHighWaterMark(testCase);

  log(`[${testCase}] Prepare input via ${CONFIG.prepare.batchId} (REP batch) - runId ${runId}, ` +
    `batch date ${batchDate}, output_cash_rebate high water mark ${highWaterMark}`);

  const rule = await resolveRepRule(testCase);
  const poolId = (process.env.OLSDB037_POOL_ID || trimValue(rule.pool_id)).trim();
  const poolRow = await resolvePool(poolId, testCase);

  // One pool per case: the positive case uses the pool of the REP rule, the negative case looks for a
  // cash rebate pool that accepts a negative balance (see resolveCasePools).
  const casePools = await resolveCasePools(rule, poolRow, testCase);

  const prepared = [];
  let movement = null;
  const usedCsn = [];

  for (const [index, caseDef] of CASES.entries()) {
    const casePool = casePools[index];
    const account = casePool.ok
      ? (await resolvePrepareAccounts(casePool.poolId, 1, testCase, caseDef.account, usedCsn))[0]
      : { productAccountNo: '', productAccountType: '', productAccountLevel: '', csn: '',
        accountSerialNo: '', cardNo: '', poolBalance: null, unverified: true };
    if (account.csn) usedCsn.push(account.csn);
    const entry = {
      id: caseDef.id,
      description: caseDef.description,
      poolBalance: caseDef.poolBalance,
      amountSource: caseDef.amountSource,
      poolId: casePool.poolId,
      pool: casePool.pool,
      resolvedBy: casePool.resolvedBy,
      extractingRule: casePool.rule
        ? {
          schemeId: trimValue(casePool.rule.scheme_id),
          runSchedule: trimValue(casePool.rule.run_schedule),
          adjTxnCode: trimValue(casePool.rule.adj_txn_code),
          redTxnCode: trimValue(casePool.rule.red_txn_code),
        }
        : null,
      account,
      feasible: casePool.ok,
      reasons: casePool.reasons,
      warnings: casePool.warnings,
      notes: [],
      skipped: !casePool.ok,
      before: null,
      after: null,
      file: null,
      ocr: null,
      rfs: null,
      problems: [],
    };

    for (const warning of entry.warnings) {
      log(`[${testCase}] ${caseDef.id} WARNING - ${warning}`);
    }
    if (!casePool.ok) {
      log(`[${testCase}] ${caseDef.id} SKIPPED - cannot be prepared in this configuration: ` +
        casePool.reasons.join(' | '));
    } else if (!account.unverified) {
      log(`[${testCase}] ${caseDef.id}: pool ${entry.poolId} ` +
        `("${trimValue(casePool.pool && casePool.pool.pool_name)}", balance rule ` +
        `${entry.extractingRule ? entry.extractingRule.schemeId : 'n/a'}, allow_negative ` +
        `${trimValue(casePool.pool && casePool.pool.allow_negative_balance) || 'n/a'}, ` +
        `charge_negative ${trimValue(casePool.pool && casePool.pool.charge_negative_balance) || 'n/a'}) ` +
        `via ${entry.resolvedBy}`);
      entry.before = await getPoolBalance(account.csn, entry.poolId, testCase);
    } else {
      entry.problems.push('the pinned account row could not be read from product_account');
    }
    prepared.push(entry);
  }

  const movable = prepared
    .filter((entry) => !entry.skipped && !entry.account.unverified && entry.account.csn)
    .map((entry) => ({
      caseDef: CASES.find((c) => c.id === entry.id),
      account: entry.account,
      poolId: entry.poolId,
    }));

  if (!skipPoolMove && movable.length) {
    // buildPoolMovements also uploads the file and runs OLSDB009 when dryRun is false.
    movement = await buildPoolMovements({
      items: movable, batchDateYmd: dateYmd, runDateYmd, testCase, dryRun,
    });
    for (const record of movement.movements) {
      const entry = prepared.find((e) => e.id === record.caseId);
      if (!entry) continue;
      entry.file = {
        name: movement.fileName, localPath: movement.localPath,
        delta: record.delta, sign: record.sign, rejected: record.rejected || null,
      };
      if (record.rejected) {
        entry.problems.push(
          `OLSDB009 refused the adjustment for account ${record.account} with ${record.rejected}` +
          (record.rejected === 'BE678'
            ? ' (the same account + pool was already adjusted today - the automation avoids those ' +
              'accounts with the loyalty_account_balance preference, but another session may have used it)'
            : ''));
      }
    }
  } else if (!skipPoolMove) {
    log(`[${testCase}] no pool movement to post (no case can be prepared with this rule/pool)`);
  }

  if (dryRun) {
    log(`[${testCase}] DRY RUN - ${movement ? movement.fileName : 'no file'} written, nothing ` +
      'uploaded and no batch executed');
    return {
      runId, batchDate, dateYmd, highWaterMark, rule, poolId, pool: poolRow,
      cases: prepared, dryRun: true, batchDateUpdate,
      olsTxnFiles: movement ? [movement.fileName] : [],
    };
  }

  // ---- Balance must have the sign the case needs, BEFORE the REP batch runs ----
  for (const entry of prepared) {
    if (entry.skipped || !entry.account.csn || entry.account.unverified) continue;
    const after = await getPoolBalance(entry.account.csn, entry.poolId, testCase);
    entry.after = after;
    const wanted = entry.poolBalance === 'negative' ? -1 : 1;
    if (!after.found) {
      entry.problems.push(`no balance row for csn ${entry.account.csn} in pool ${entry.poolId} after the movement`);
    } else if (Math.sign(after.balance) !== wanted) {
      entry.problems.push(
        `pool balance is ${after.balance} but ${entry.id} needs it ` +
        `${entry.poolBalance === 'negative' ? '< 0' : '> 0'}`);
    }
    log(`[${testCase}] ${entry.id}: pool ${entry.poolId} balance after the movement = ` +
      `${after.found ? after.balance : '(no row)'} (wanted ${entry.poolBalance})`);
  }

  // ---- Run the REP batch that writes OUTPUT_CASH_REBATE ----
  if (!skipRepBatch) {
    await runRemoteBatch({
      scriptPath: CONFIG.batch.scriptPath,
      command: CONFIG.prepare.command,
      timeout: CONFIG.prepare.timeout,
      testCase,
    });
    log(`[${testCase}] ${CONFIG.prepare.batchId} finished`);
  } else {
    log(`[${testCase}] ${CONFIG.prepare.batchId} skipped (OLSDB037_SKIP_OLSDB040=1)`);
  }

  // ---- Capture what the REP batch generated for the accounts of this run ----
  // PostgreSQL folds unquoted aliases to lower case, so the rows are normalised once here and the
  // rest of the function works with plain camelCase JavaScript fields.
  const accounts = prepared.map((entry) => entry.account).filter((a) => a && a.productAccountNo);
  const rows = (await fetchTestRecords(highWaterMark, accounts, testCase)).map((row) => ({
    recordNo: trimValue(col(row, 'recordNo')),
    referenceNo: trimValue(col(row, 'referenceNo')),
    txnCode: trimValue(col(row, 'txnCode')),
    cardNo: trimValue(col(row, 'cardNo')),
    productAccountNo: trimValue(col(row, 'productAccountNo')),
    redeemedPoint: trimValue(col(row, 'redeemedPoint')),
    fulfillmentStatus: trimValue(col(row, 'fulfillmentStatus')),
  }));
  const byAccount = new Map();
  for (const row of rows) {
    const key = row.productAccountNo.replace(/^0+/, '');
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key).push(row);
  }

  // One query for every reference the REP batch created for the accounts of this run.
  const rfsByReference = await fetchRfs(rows.map((row) => row.referenceNo), testCase);

  for (const entry of prepared) {
    if (entry.skipped) {
      // No adjustment was posted for this case, so no cash rebate row is expected for it.
      log(`[${testCase}] ${entry.id}: skipped - ${entry.reasons.join(' | ')}`);
      continue;
    }
    const key = trimValue(entry.account.productAccountNo).replace(/^0+/, '');
    const found = byAccount.get(key) || [];
    const newest = found[found.length - 1] || null;
    entry.ocr = newest;
    if (!newest) {
        entry.problems.push(
        `OLSDB040 created no output_cash_rebate row for account ${entry.account.productAccountNo} ` +
        `(record_no > ${highWaterMark})`);
      continue;
    }
    const status = newest.fulfillmentStatus;
    if (status !== STATUS_NEW) {
      entry.problems.push(`new row ${newest.recordNo} has fulfillment_status "${status}", ` +
        `expected "${STATUS_NEW}" before OLSDB037 runs`);
    }
    const rfs = rfsByReference.get(trimValue(newest.referenceNo)) || null;
    entry.rfs = rfs;

    // BA test case, steps 3-5: the TRANSACTIONS row behind the reference and the balance bucket that
    // the REP batch must have zeroed.
    const transaction = (await executeDbQuery(
      TRANSACTION_BY_REFERENCE_QUERY, [newest.referenceNo], testCase))[0] || null;
    entry.transaction = transaction
      ? {
        recordNo: trimValue(transaction.record_no),
        transactionCode: trimValue(transaction.transaction_code),
        transactionType: trimValue(transaction.transaction_type),
        txnSign: trimValue(transaction.txn_sign),
        pointAdjusted: trimValue(transaction.point_adjusted),
        pointRedeemed: trimValue(transaction.point_redeemed),
        poolId: trimValue(transaction.pool_id),
      }
      : null;

    const lab = entry.account.loyaltyAccountNo
      ? (await executeDbQuery(
        LAB_BY_ACCOUNT_POOL_QUERY, [entry.account.loyaltyAccountNo, entry.poolId], testCase))[0]
      : null;
    entry.labAfter = lab ? trimValue(lab.balance) : null;

    // NOTE: the TRANSACTIONS row and the balance bucket are captured as EVIDENCE for the data the flow
    // created - they are NOT part of the verdict of this suite. Checking that the cash rebate row took
    // its amount from txns.point_adjusted / txns.point_redeem and that loyalty_account_balance went
    // back to 0 belongs to the test case of OLSDB040; OLSDB037 only has to export what OLSDB040 wrote
    // and flip the status to 'S'.
    if (!entry.transaction) {
      entry.notes.push(`no TRANSACTIONS row for reference ${newest.referenceNo}`);
    } else {
      const expectedAmount = entry.amountSource === 'POINT_ADJUSTED'
        ? entry.transaction.pointAdjusted
        : entry.transaction.pointRedeemed;
      if (Math.abs(Number(expectedAmount)) !== Math.abs(Number(newest.redeemedPoint))) {
        entry.notes.push(
          `OCR.REDEEMED_POINT ${newest.redeemedPoint} vs transaction.${entry.amountSource} ` +
          `${expectedAmount} (reference ${newest.referenceNo}, OLSDB040's own expectation)`);
      }
    }
    if (entry.labAfter !== null && Number(entry.labAfter) !== 0) {
      entry.notes.push(`loyalty_account_balance of account ${entry.account.productAccountNo} in pool ` +
        `${entry.poolId} is ${entry.labAfter} (OLSDB040's own expectation: 0)`);
    }

    log(`[${testCase}] ${entry.id}: OCR ${newest.recordNo} ref ${newest.referenceNo} ` +
      `txnCode ${newest.txnCode} account ${trimValue(newest.productAccountNo)} ` +
      `points ${newest.redeemedPoint} status ${status}` +
      ` | RFS ${entry.rfs ? `${entry.rfs.fulfilment_status} (${entry.rfs.record_no})` : 'none'}` +
      ` | TXN ${entry.transaction ? `${entry.transaction.transactionCode}/${entry.transaction.transactionType} ` +
        `adj ${entry.transaction.pointAdjusted} redeem ${entry.transaction.pointRedeemed}` : 'none'}` +
      ` | LAB ${entry.labAfter}`);
  }

  return {
    runId,
    batchDate,
    dateYmd,
    highWaterMark,
    rule,
    poolId,
    pool: poolRow,
    cases: prepared,
    dryRun: false,
    batchDateUpdate,
    olsTxnFiles: movement ? [movement.fileName] : [],
    ocrTable: `${SCHEMA}.${OCR_TABLE}`,
    rfsTable: `${SCHEMA}.${RFS_TABLE}`,
  };
}

// ============ CLI ENTRY ============
const isDirectRun = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  console.log('Preparing OLSDB037 input data through OLSDB040 (REP batch)...\n');
  prepareData()
    .then((result) => {
      console.log('\nPreparation finished:', JSON.stringify({
        runId: result.runId, batchDate: result.batchDate, poolId: result.poolId,
        batchDateUpdate: result.batchDateUpdate
          ? `${result.batchDateUpdate.before.batch_date} -> ${result.batchDateUpdate.after.batch_date}` : 'skipped',
        dryRun: result.dryRun, files: result.olsTxnFiles,
        cases: result.cases.map((c) => ({
          id: c.id, account: c.account.productAccountNo, poolBalance: c.poolBalance,
          ocr: c.ocr ? c.ocr.recordNo : null, problems: c.problems,
        })),
      }, null, 2));
    })
    .catch((error) => {
      console.error('\nPreparation failed:', error.message);
      process.exit(1);
    });
}

export default { prepareData, resolveRepRule, resolvePool, resolvePrepareAccounts, getPoolBalance };
