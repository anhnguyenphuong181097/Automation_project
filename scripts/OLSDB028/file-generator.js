// scripts/OLSDB028/file-generator.js
// Prepare the input data of OLSDB028 through the Item Redemption API (OL59).
//
// OLSDB028 has no input .dat file: its input is what the Item Redemption API stored in
// item_fulfilment_status / item_fulfilment_status_his. So this generator does NOT write a file -
// it plays the role of "call the API N times, then capture what the system generated":
//
//   file dữ liệu (api-data/OL59-itemRedeem.json)
//     -> 1 API call per case (dynamic timestamp / message number / computed price)
//     -> itemRedeem.itmRdmRefNbr
//     -> ITEM_FULFILMENT_STATUS.REFERENCE_NO + EXTRACTED_DATE_TIME   (nguồn sự thật cho expected)
//     -> cat_catalogue_trans_details (status 'A')                    (điều kiện export của BA query)
//
// The request payload is NOT hard-coded here: it comes from the data file
//   scripts/OLSDB028/api-data/OL59-itemRedeem.json   (override: OLSDB028_API_DATA)
// The data file holds the baseline template plus one entry per redemption, and supports
// placeholders ({{timestamp}}, {{messageNum}}, {{msgSqNum}}, {{runId}}, ...) so the dynamic parts
// stay data-driven instead of being duplicated in code.
//
// Manual run:  node scripts/OLSDB028/file-generator.js
// In the suite: called by test.beforeAll of test-runner.spec.js (skip with OLSDB028_SKIP_PREPARE=1)

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import pg from 'pg';
import {
  CONFIG, SCHEMA, ITEM_PRICE_QUERY, SOPC_QUERY, SOPC_TABLE, parseSopcLevelList,
  PRODUCT_ACCOUNT_QUERY, PRODUCT_ACCOUNT_TABLE, ITEM_STOCK_QUERY, ITEM_MIN_QTY_ERROR,
  MIN_QTY_CANDIDATES,
  BALANCE_QUERY, TOPUP_ACCOUNT_QUERY,
} from './test-data.js';
import { getPool } from '../OLSDB009/data-pool.js';
import { adjustTxn, buildFile, generateFileName } from '../OLSDB009/file-generator.js';

const __filename = fileURLToPath(import.meta.url);
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

// ============ INPUT DATA FILE ============
export function loadApiData(filePath = CONFIG.itemRedemptionApi.dataFile) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`OLSDB028 API data file not found: ${filePath}\n` +
      'Set OLSDB028_API_DATA to another file.');
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`OLSDB028 API data file is not valid JSON: ${filePath}\n${error.message}`);
  }

  if (!data || typeof data.template !== 'object') {
    throw new Error(`OLSDB028 API data file has no "template" object: ${filePath}`);
  }
  if (!Array.isArray(data.cases) || data.cases.length === 0) {
    throw new Error(`OLSDB028 API data file has no "cases" array: ${filePath}`);
  }
  return { ...data, filePath };
}

/** Values generated once per run (execution time, unique message number, sequence). */
function makeRunContext(runId) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return {
    runId,
    now,
    timestamp: `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())} ` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
    todayYmd: `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    nowIso: now.toISOString(),
    // Unique per request; 6 characters like the BA sample ("E99999").
    messageNumber: (index) => `E${String((now.getTime() + index * 7919) % 100000).padStart(5, '0')}`,
    msgSqNum: (index) => String(index + 1),
  };
}

/** Replace every {{placeholder}} of a string using ctx. */
function substitute(value, ctx) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, key) =>
      (ctx[key] === undefined || ctx[key] === null ? whole : String(ctx[key])));
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, ctx));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, ctx)]));
  }
  return value;
}

/** Deep merge: values of `override` win, nested objects are merged, arrays are replaced. */
function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override === undefined ? base : override;
  if (base && typeof base === 'object' && override && typeof override === 'object') {
    const out = { ...base };
    for (const [key, value] of Object.entries(override)) {
      out[key] = key in base ? deepMerge(base[key], value) : value;
    }
    return out;
  }
  return override === undefined ? base : override;
}

/**
 * Build the request of one case: template + case override, placeholders resolved and the price
 * fields computed from unitPriceInPoints * quantity when the case does not spell them out.
 */
export function buildRequest(apiData, caseDef, ctx) {
  const caseRequest = caseDef.request || {};
  const caseItem = caseDef.itemRedeem || {};
  const request = deepMerge(apiData.template, caseRequest);
  request.itemRedeem = deepMerge(request.itemRedeem || {}, caseItem);

  // Price / quantity of the redemption. An explicit value of the case wins, otherwise the value is
  // computed from the unit price (case, then item_price from the database) * quantity.
  const item = request.itemRedeem;
  const unitPrice = caseDef.unitPriceInPoints !== undefined
    ? Number(caseDef.unitPriceInPoints)
    : (caseItem.itmRdmUnitPriceInPoints !== undefined
      ? Number(caseItem.itmRdmUnitPriceInPoints)
      : (ctx.unitPriceInPoints !== undefined ? Number(ctx.unitPriceInPoints) : null));
  const quantity = caseDef.quantity !== undefined
    ? Number(caseDef.quantity)
    : (caseItem.itmRdmQuantity !== undefined ? Number(caseItem.itmRdmQuantity) : null);

  if (unitPrice !== null && quantity !== null) {
    const total = unitPrice * quantity; // API expects the whole redemption, not the unit price
    if (caseItem.itmRdmFullPriceInPoints === undefined) item.itmRdmFullPriceInPoints = total;
    if (caseItem.itmRdmPoolUnitsRequired === undefined) item.itmRdmPoolUnitsRequired = total;
    if (caseItem.itmRdmQuantityItem === undefined) item.itmRdmQuantityItem = String(quantity);
    if (caseItem.itmRdmReceiveQuantity === undefined) item.itmRdmReceiveQuantity = String(quantity);
  }
  delete item.itmRdmUnitPriceInPoints;
  return substitute(request, {
    ...ctx,
    runId: ctx.runId,
    caseId: caseDef.id,
  });
}

// ============ API CALL ============
let tlsWarningShown = false;

/**
 * Find a (SvcRq.ChannelId, OLSRq.Region) pair the current environment accepts.
 * The probe keeps everything else of the real request but sends an impossible price
 * (itmRdmFullPriceInPoints = 1), so the API answers the business error E5903
 * "Pool Units + Cash Required do not match Item Price" for a pair that is valid AND priced for the
 * item - and that probe can never create a redemption.
 */
export async function discoverChannelRegion(request, { channels = [], testCase = 'OL59' } = {}) {
  const { channelOverride, regionOverride, regionCandidates } = CONFIG.itemRedemptionApi;
  const channelList = [...new Set([channelOverride, ...channels, 'MB', 'INB'].filter(Boolean))];
  const regionList = [...new Set([regionOverride, ...regionCandidates].filter(Boolean))];

  const tried = [];
  let fallback = null;

  for (const channel of channelList) {
    for (const region of regionList) {
      const probe = JSON.parse(JSON.stringify(request));
      probe.SvcRq.ChannelId = channel;
      probe.OLSRq.Region = region;
      probe.itemRedeem.itmRdmFullPriceInPoints = 1;      // impossible price -> no data is created
      probe.itemRedeem.itmRdmPoolUnitsRequired = 1;

      const { body } = await callItemRedemption(probe, testCase);
      const code = String((body.OLSRs || {}).ReturnCode);
      const message = (body.itemRedeem || {}).itmRdmDisplayMessage || body.errorMessage || '';
      tried.push(`${channel}/${region}=${code}`);

      // E5918 "Incorrect full price in points" / E5903 "Pool Units + Cash Required do not match
      // Item Price" / E5917 "For point transfer, item quantity must be 1": the pair is valid AND
      // the item is priced for it (only the probe price - or the point-transfer rule - is hit).
      if (code === 'E5918' || code === 'E5903' || code === 'E5917') {
        log(`[${testCase}] channel/region discovered: ${channel} / ${region} (probe answered ${code})`);
        return { channel, region, evidence: code, tried };
      }
      // The pair is accepted but the price lookup failed for another reason: keep it as a fallback.
      if (!fallback && (code === ITEM_MIN_QTY_ERROR || code === 'E5921')) {
        fallback = { channel, region, evidence: code, tried };
      }
    }
  }

  if (fallback) {
    log(`[${testCase}] channel/region fallback: ${fallback.channel} / ${fallback.region} ` +
      `(probe answered ${fallback.evidence}); probes: ${tried.join(', ')}`);
    return fallback;
  }

  throw new Error(`[${testCase}] no (ChannelId, Region) accepted by the API for this item. ` +
    `Probes: ${tried.join(', ')}\n` +
    'Set OLSDB028_CHANNEL / OLSDB028_REGION to pin them manually.');
}

/**
 * Quantity check (before calling OL59): the quantity must not exceed the stock the database
 * exposes. The API's own minimum is reported when it answers E5908.
 */
export async function checkQuantity(itemCode, quantity, testCase = 'OL59') {
  const wanted = Number(quantity);
  const rows = await executeDbQuery(ITEM_STOCK_QUERY, [itemCode], testCase);
  if (!rows.length) {
    return { ok: false, reasons: [`item ${itemCode} has no active row in ${SCHEMA}.item`] };
  }

  const item = rows[0];
  const onHand = item.qty_on_hand === null ? null : Number(item.qty_on_hand);
  const reserved = item.qty_reserved === null ? 0 : Number(item.qty_reserved);
  const redeemed = item.qty_redeem === null ? 0 : Number(item.qty_redeem);
  const maxPerTxn = item.max_qty_allow_per_item_per_txn === null
    ? null
    : Number(item.max_qty_allow_per_item_per_txn);
  const available = onHand === null ? null : onHand - reserved - redeemed;
  const tracksStock = String(item.track_stock_quantity ?? '').trim().toUpperCase() === 'Y';
  const reasons = [];
  // Verified on dev 29/09/2026: the API accepted quantity 100 twice while qty_on_hand was 48 and
  // qty_redeem 2, and neither counter moved afterwards - the redemption service does NOT enforce
  // the stock of the item, so a shortage is only reported, never used to fail the run.
  const warnings = [];

  if (!Number.isFinite(wanted) || wanted <= 0) reasons.push(`quantity "${quantity}" is not a positive number`);
  if (maxPerTxn !== null && wanted > maxPerTxn) {
    reasons.push(`quantity ${wanted} is above max_qty_allow_per_item_per_txn (${maxPerTxn})`);
  }
  if (tracksStock && available !== null && wanted > available) {
    warnings.push(`quantity ${wanted} is above the available stock (qty_on_hand ${onHand} - ` +
      `qty_reserved ${reserved} - qty_redeem ${redeemed} = ${available})`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    warnings,
    itemCode,
    quantity: wanted,
    qtyOnHand: onHand,
    qtyReserved: reserved,
    qtyRedeem: redeemed,
    availableStock: available,
    maxPerTxn,
    tracksStock,
  };
}

export async function callItemRedemption(request, testCase = 'OL59') {
  const { url, headers, timeoutMs, insecureTls } = CONFIG.itemRedemptionApi;

  if (insecureTls && !tlsWarningShown) {
    // The dev gateway uses a self-signed certificate; without this the fetch fails with
    // "self-signed certificate in certificate chain". Set OLSDB028_INSECURE_TLS=0 to refuse it.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    tlsWarningShown = true;
    log(`[${testCase}] note: TLS verification disabled for ${new URL(url).host} (dev self-signed certificate)`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let text;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { ...(headers || { 'Content-Type': 'application/json' }) },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    throw new Error(`[${testCase}] OL59 request failed: ${maskSecret(error.message)}` +
      (error.cause ? ` (${maskSecret(error.cause.message)})` : ''));
  } finally {
    clearTimeout(timer);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(`[${testCase}] OL59 returned HTTP ${response.status} with a non-JSON body: ` +
      `${text.slice(0, 300)}`);
  }

  return { httpStatus: response.status, body };
}

// ============ DATABASE ============
async function executeDbQuery(query, params = [], testCase = 'OL59') {
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
    throw new Error(`[${testCase}] DB query failed: ${maskSecret(error.message)}\nSQL: ${query.trim()}`);
  } finally {
    await client.end();
  }
}

/** The fulfilment the API just created - REFERENCE_NO / EXTRACTED_DATE_TIME are the source of truth. */
export async function fetchFulfilmentRows(referenceNo, testCase = 'OL59') {
  return executeDbQuery(
    `SELECT record_no::text                                          AS record_no,
            reference_no,
            item_code,
            item_type,
            pool_id,
            supplier_id,
            csn,
            status,
            fulfillment_status,
            redeemed_point::text                                     AS redeemed_point,
            card_no,
            item_name,
            product_account_no,
            product_account_type,
            product_account_level,
            product_code,
            to_char(transaction_date, 'YYYY-MM-DD HH24:MI:SS.MS')     AS transaction_date,
            to_char(fulfill_status_update_date, 'YYYY-MM-DD HH24:MI:SS.MS') AS fulfill_status_update_date,
            to_char(extracted_date_time, 'YYYY-MM-DD HH24:MI:SS.MS')  AS extracted_date_time,
            last_update_by,
            last_approve_by
       FROM ${SCHEMA}.item_fulfilment_status
      WHERE reference_no = $1
      ORDER BY record_no`,
    [referenceNo],
    testCase
  );
}

/** Export gate of the BA query: the reference must exist in cat_catalogue_trans_details (status 'A'). */
export async function checkExportGate(referenceNo, testCase = 'OL59') {
  const rows = await executeDbQuery(
    `SELECT record_no::text AS record_no, status, last_approve_by, pool_id,
            to_char(last_update_date, 'YYYY-MM-DD HH24:MI:SS.MS') AS last_update_date
       FROM ${SCHEMA}.cat_catalogue_trans_details
      WHERE reference_no = $1 AND status = 'A'`,
    [referenceNo],
    testCase
  );
  return { found: rows.length > 0, rows };
}

/**
 * Channel of an item price row.
 * item_price.redemption_channel on dev is either a single value ('MB') or an array-ish string
 * ('[MB]'), and redemption_channel_arr is a real PostgreSQL array - normalise all three to 'MB'.
 */
export function normalizeChannel(row) {
  const arrayValue = Array.isArray(row.redemption_channel_arr)
    ? row.redemption_channel_arr.map((value) => String(value).trim()).filter(Boolean)[0]
    : null;
  if (arrayValue) return arrayValue;

  const raw = String(row.redemption_channel ?? '').trim();
  const bracketed = raw.match(/\[([^\]]+)\]/);
  return (bracketed ? bracketed[1] : raw).trim();
}

/**
 * The active price row of an item, taken from the database so the request does not hard-code
 * SvcRq.ChannelId / the unit price / the pool.
 * One item can have several active prices (UG7814: ENQ1/0VN/12 and HT4/3CC/119), so the row is
 * selected by priceId, pool_id or reward_currency_code (the field the request itself carries) and
 * the selection must be unambiguous.
 */
export async function resolveItemPrice(itemCode, { rewardCurrency = null, poolId = null, priceId = null } = {}, testCase = 'OL59') {
  if (!itemCode) throw new Error(`[${testCase}] no item code to resolve the item price from`); 

  const rows = await executeDbQuery(ITEM_PRICE_QUERY, [itemCode], testCase);
  if (!rows.length) {
    throw new Error(`[${testCase}] item ${itemCode} has no active row in ${SCHEMA}.item_price ` +
      '(so neither SvcRq.ChannelId nor the unit price can be derived)');
  }

  let candidates = rows;
  if (priceId) {
    candidates = rows.filter((row) => String(row.price_id) === String(priceId));
  } else if (poolId) {
    candidates = rows.filter((row) => String(row.pool_id).trim() === String(poolId).trim());
  } else if (rewardCurrency) {
    candidates = rows.filter((row) =>
      String(row.reward_currency_code ?? '').trim() === String(rewardCurrency).trim());
  }

  if (candidates.length !== 1) {
    const list = (candidates.length ? candidates : rows).map((row) =>
      `price_id=${row.price_id} pool=${row.pool_id} rewardCurrency=${row.reward_currency_code} ` +
      `channel=${normalizeChannel(row)} unitPrice=${row.price_in_point}`).join(' | ');
    throw new Error(`[${testCase}] item ${itemCode}: cannot pick a single active item_price row ` +
      `with rewardCurrency=${rewardCurrency} / poolId=${poolId} / priceId=${priceId}. ` +
      `Candidates: ${list}. Add "priceId" (or "unitPriceInPoints") to the case to disambiguate.`);
  }

  const row = candidates[0];
  return {
    priceId: row.price_id,
    itemCode: row.item_code,
    poolId: row.pool_id,
    rewardCurrency: String(row.reward_currency_code ?? '').trim(),
    channelId: normalizeChannel(row),
    unitPriceInPoints: Number(row.price_in_point),
    itemCurrency: row.item_currency,
    startDate: row.start_date,
    endDate: row.end_date,
    allActivePrices: rows.length,
  };
}

/**
 * Statement Output Pool (SOPC) check of one fulfilment row - i.e. "would OLSDB028 statement this
 * redemption?":
 *   1. the pool of the redemption must exist in ols_schema.statement_output_pool,
 *   2. with status 'A' and pool_start_date <= reference date <= pool_end_date (end_date never null),
 *   3. and the product account level (PAL) of the row must be one of the levels listed for the pool
 *      ('[PARTNER, OCR, 802, 500, ...]'). The match key is the PAL, not the PAT - verified against
 *      the rows the batch exported on 29/09/2026.
 */
export async function checkStatementOutputPool(poolId, pal, { referenceDate = null } = {}, testCase = 'OL59') {
  if (!poolId) return { ok: false, reasons: ['the fulfilment row has no pool_id'] };

  const rows = await executeDbQuery(SOPC_QUERY, [poolId], testCase);
  if (!rows.length) {
    return { ok: false, poolId, reasons: [`pool ${poolId} is not configured in ${SCHEMA}.${SOPC_TABLE}`] };
  }

  const active = rows.filter((row) => String(row.status ?? '').trim().toUpperCase() === 'A');
  if (!active.length) {
    return {
      ok: false, poolId,
      reasons: [`pool ${poolId} has no active row (status 'A') in ${SCHEMA}.${SOPC_TABLE}`],
      allRows: rows.map((row) => `status=${row.status} ${row.pool_start_date}..${row.pool_end_date}`),
    };
  }

  const row = active[0];
  const asDate = (value) => (value ? new Date(String(value).replace(' ', 'T')) : null);
  const now = referenceDate ? new Date(referenceDate) : new Date();
  const from = asDate(row.pool_start_date);
  const to = asDate(row.pool_end_date);
  const levels = parseSopcLevelList(row.product_account_level);
  const reasons = [];

  if (from && now < from) reasons.push(`pool ${poolId} is not effective yet (starts ${row.pool_start_date})`);
  if (to && now > to) reasons.push(`pool ${poolId} expired on ${row.pool_end_date}`);
  if (!levels.length) reasons.push(`pool ${poolId} has an empty product_account_level list`);
  if (levels.length && pal && !levels.includes(String(pal).trim())) {
    reasons.push(`PAL ${pal} is not in the SOPC list of pool ${poolId} (${row.product_account_level})`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    poolId,
    status: row.status,
    validFrom: row.pool_start_date,
    validTo: row.pool_end_date,
    levels,
    pal,
    checkedAt: now.toISOString(),
  };
}

/**
 * CIF -> account check of one fulfilment row.
 * The CIF key is `csn`; its accounts are the rows of ols_schema.product_account with that csn.
 * The redeemed account (product_account_no) must belong to the CIF and must carry the product
 * (PAL = product_account_level) and brand (PAT = product_account_type) of the transaction, all
 * with status 'A'.
 */
export async function checkCifAccount({ csn, productAccountNo, pal, pat } = {}, testCase = 'OL59') {
  if (!csn) return { ok: false, reasons: ['the fulfilment row has no csn, so the CIF cannot be resolved'] };

  const rows = await executeDbQuery(
    PRODUCT_ACCOUNT_QUERY,
    [csn, productAccountNo, pal, pat],
    testCase
  );
  const stats = rows[0] || {};
  const reasons = [];

  if (Number(stats.active_rows) === 0) {
    reasons.push(`CIF ${csn} has no active account in ${SCHEMA}.${PRODUCT_ACCOUNT_TABLE}`);
  } else if (Number(stats.same_account) === 0) {
    reasons.push(`account ${productAccountNo} does not belong to CIF ${csn} (its active accounts: ` +
      `${stats.active_accounts})`);
  } else if (Number(stats.same_account_pal_pat) === 0) {
    reasons.push(`account ${productAccountNo} of CIF ${csn} does not carry PAL ${pal} / PAT ${pat}`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    csn,
    productAccountNo,
    pal,
    pat,
    activeRows: Number(stats.active_rows) || 0,
    sameAccount: Number(stats.same_account) || 0,
    sameAccountPalPat: Number(stats.same_account_pal_pat) || 0,
    activeAccounts: stats.active_accounts || '',
  };
}

// ============ MAIN ============

// ============ FALLBACK: NOT ENOUGH POINTS ============
// -batch and -hostkey are required, otherwise plink hangs at the host key prompt (AGENTS.md 4.4).
function plinkCommand(remoteCommand) {
  return `"${CONFIG.putty.path}" -batch ` +
    `-hostkey "${CONFIG.putty.hostKey}" ` +
    `-ssh ${CONFIG.putty.username}@${CONFIG.putty.host} ` +
    `-pw ${CONFIG.putty.password} ` +
    `"${remoteCommand}"`;
}

/** Upload the OLSTXN adjustment file to the OLSDB009 input folder (WinSCP, binary). */
async function uploadToOlsDb009(localPath, testCase) {
  const command = `"${CONFIG.winscp.path}" /command ` +
    `"option batch abort" ` +
    `"option confirm off" ` +
    `"option transfer binary" ` +
    `"open sftp://${CONFIG.winscp.username}:${CONFIG.winscp.password}@${CONFIG.winscp.host}/" ` +
    `"cd ${CONFIG.adjustment.remotePath}" ` +
    `"put ""${localPath}""" ` +
    `"exit"`;
  try {
    await execAsync(command, { timeout: 120000, maxBuffer: 1024 * 1024 * 10 });
  } catch (error) {
    throw new Error(`[${testCase}] upload of ${path.basename(localPath)} failed: ${maskSecret(error.message)}`);
  }
  log(`[${testCase}] uploaded ${path.basename(localPath)} to ${CONFIG.adjustment.remotePath}`);
}

/** Run the OLSDB009 batch that processes the adjustment (Java job - allow JVM startup). */
async function runOlsDb009(testCase) {
  const command = `cd ${CONFIG.batch.scriptPath} && ${CONFIG.adjustment.command}`;
  try {
    await execAsync(plinkCommand(command), { timeout: CONFIG.adjustment.timeout, maxBuffer: 1024 * 1024 * 16 });
  } catch (error) {
    throw new Error(`[${testCase}] ${CONFIG.adjustment.batchId} failed: ${maskSecret(error.message)}`);
  }
  log(`[${testCase}] ${CONFIG.adjustment.batchId} finished`);
}

/** csn of a CIF number (balance_detail_view / product_account are keyed by csn). */
export async function resolveCsnByCif(cif, testCase = 'OL59') {
  const rows = await executeDbQuery(
    `SELECT csn FROM ${SCHEMA}.client WHERE external_reference_no = $1 AND status = 'A' ORDER BY record_no DESC LIMIT 1`,
    [cif],
    testCase
  );
  if (!rows.length) throw new Error(`[${testCase}] no client (csn) found for CIF ${cif}`);
  return String(rows[0].csn).trim();
}

/** Available points of one CIF in one pool (balance_detail_view). */
export async function getPoolBalance(csn, poolId, testCase = 'OL59') {
  const rows = await executeDbQuery(BALANCE_QUERY, [csn, poolId], testCase);
  if (!rows.length) return { found: false, balance: 0, redeemable: 0, poolId, csn };
  const row = rows[0];
  return {
    found: true,
    csn,
    poolId: row.pool_id,
    poolName: row.pool_name,
    balance: Number(row.balance),
    redeemable: Number(row.redeemable_bal),
    nextExpiry: row.next_expiry_date,
  };
}

/**
 * Does this OL59 answer mean "the CIF does not have enough points"?
 * The database carries no error catalogue (ols_schema.error_code is empty), so the trigger is the
 * business code (OLSDB028_INSUFFICIENT_CODES) and/or the display message pattern.
 */
export function isInsufficientPointFailure(returnCode, message) {
  const code = String(returnCode ?? '').trim();
  const text = String(message ?? '');
  if (CONFIG.insufficientPoint.codes.includes(code)) return true;
  return CONFIG.insufficientPoint.pattern.test(text);
}

/** Accounts of the CIF that may take the adjustment (PAL listed in statement_output_pool). */
export async function resolveTopUpAccount(csn, poolId, testCase = 'OL59') {
  const sopc = await executeDbQuery(SOPC_QUERY, [poolId], testCase);
  const active = sopc.find((row) => String(row.status ?? '').trim().toUpperCase() === 'A');
  const levels = active ? parseSopcLevelList(active.product_account_level) : [];
  if (!levels.length) {
    throw new Error(`[${testCase}] pool ${poolId} is not configured in ${SCHEMA}.${SOPC_TABLE} ` +
      '(or its product_account_level list is empty), so the adjustment account cannot be resolved');
  }
  const rows = await executeDbQuery(TOPUP_ACCOUNT_QUERY, [csn, levels], testCase);
  if (!rows.length) {
    throw new Error(`[${testCase}] CIF ${csn} has no active account whose PAL is in the ` +
      `${SOPC_TABLE} list of pool ${poolId} (${active.product_account_level})`);
  }
  // Prefer the account the successful redemptions use (OCR/RWD), else the first one.
  const account = rows.find((row) => String(row.product_account_level).trim() === 'OCR') || rows[0];
  return { account, levels, poolRow: active, candidates: rows.length };
}

/** Free OLSTXN sequence for one batch date (batch_resource keeps the ledger). */
async function nextFreeOlsTxnSequence(dateYmd, testCase = 'OL59') {
  const rows = await executeDbQuery(
    `SELECT logical_filename FROM ${SCHEMA}.batch_resource
      WHERE logical_filename LIKE 'OLSTXN-%-${dateYmd}-%.dat'`,
    [],
    testCase
  );
  const used = new Set(rows.map((row) => String(row.logical_filename)));
  for (let seq = 1; seq <= 99; seq += 1) {
    const name = generateFileName(seq, dateYmd);
    if (!used.has(name)) return seq;
  }
  throw new Error(`[${testCase}] no free OLSTXN sequence left for ${dateYmd}`);
}

/**
 * Build an OLSTXN file with ONE adjustment record (txnTranType '03') for the shortfall, upload it
 * to the OLSDB009 input folder and run ./OLSDB009 so the points are added to the pool.
 */
export async function topUpPool({ csn, cif, poolId, points, productAccountNo = null, testCase = 'OL59', dryRun = process.env.OLSDB028_TOPUP_DRYRUN === '1' }) {
  const amount = Math.round(Number(points));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`[${testCase}] top-up amount must be a positive number of points, got "${points}"`);
  }

  // BA rule: the pool must be configured for statement output before it can be adjusted.
  const target = await resolveTopUpAccount(csn, poolId, testCase);
  const account = productAccountNo
    ? (target.account.product_account_no === productAccountNo
      ? target.account
      : { ...target.account, product_account_no: productAccountNo })
    : target.account;

  const pool = await getPool();
  const reasonIdx = CONFIG.adjustment.reasonIndex;
  const padded = String(amount * 100).padStart(14, '0'); // 9(14,2)
  const detail = adjustTxn(pool, {
    txnCifNbr: cif,
    txnProdAcctNbr: account.product_account_no,
    txnProdAcctType: account.product_account_type,
    txnProdAcctLevel: account.product_account_level,
    txnPoolId: poolId,
    txnTranAmt: padded,
    txnOrigTxnAmt: padded,
    txnTranSign: '+',
  }, { reasonIndex: reasonIdx });

  const dateYmd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const seq = await nextFreeOlsTxnSequence(dateYmd, testCase);
  const fileName = generateFileName(seq, dateYmd);
  const content = buildFile({ date: dateYmd, fileNumber: seq, details: [detail] });

  fs.ensureDirSync(CONFIG.adjustment.localDir);
  const localPath = path.join(CONFIG.adjustment.localDir, fileName);
  fs.writeFileSync(localPath, content);
  log(`[${testCase}] adjustment file ${fileName}: pool ${poolId}, account ${account.product_account_no} ` +
    `(${account.product_account_level}/${account.product_account_type}), +${amount} points, ` +
    `reason ${detail.txnAdjReason}`);

  if (dryRun) {
    log(`[${testCase}] DRY RUN - ${fileName} written to ${localPath}, upload + ${CONFIG.adjustment.batchId} skipped`);
    return { fileName, localPath, amount, account: account.product_account_no, poolId, dryRun: true };
  }

  await uploadToOlsDb009(localPath, testCase);
  await runOlsDb009(testCase);

  const after = await getPoolBalance(csn, poolId, testCase);
  log(`[${testCase}] balance of pool ${poolId} after adjustment: ${after.balance} (redeemable ${after.redeemable})`);

  return { fileName, amount, account: account.product_account_no, poolId, balanceAfter: after };
}

/**
 * Region pre-flight - run BEFORE anything else.
 * It probes the API with an impossible price (so no redemption can be created) and reports which
 * region the service accepts today versus the region this environment is supposed to serve.
 * A mismatch is an API/deployment problem, not a payload problem.
 */
export async function preflightRegion(testCase = 'OLSDB028') {
  const apiData = loadApiData();
  const caseDef = apiData.cases.find((entry) => entry.disabled !== true);
  if (!caseDef) throw new Error(`[${testCase}] every case of ${apiData.filePath} is disabled`);

  const ctx = makeRunContext(process.env.OLSDB028_RUN_ID || `preflight-${Date.now()}`);
  const probe = buildRequest(apiData, caseDef, {
    ...ctx,
    messageNum: ctx.messageNumber(0),
    msgSqNum: ctx.msgSqNum(0),
    channelId: 'MB',
  });
  // Impossible price: the probe must never be able to redeem anything.
  probe.itemRedeem.itmRdmFullPriceInPoints = 1;
  probe.itemRedeem.itmRdmPoolUnitsRequired = 1;

  const target = await discoverChannelRegion(probe, { channels: ['MB', 'INB'], testCase });
  const expected = CONFIG.itemRedemptionApi.expectedRegion;
  const ok = !expected || String(target.region).toUpperCase() === expected;

  return {
    ok,
    acceptedRegion: target.region,
    acceptedChannel: target.channel,
    expectedRegion: expected,
    evidence: target.evidence,
    tried: target.tried,
    item: probe.itemRedeem.itmRdmItemCode,
  };
}

/**
 * Call OL59 once per case of the data file and capture what the system generated.
 * @returns {Promise<{runId: string, file: string, cases: object[]}>}
 */
export async function prepareData(testCase = 'OLSDB028') {
  const apiData = loadApiData();
  const runId = process.env.OLSDB028_RUN_ID || `OLSDB028-${Date.now()}`;
  const ctx = makeRunContext(runId);
  const cases = apiData.cases.filter((entry) => entry.disabled !== true);

  if (!cases.length) throw new Error(`[${testCase}] every case of ${apiData.filePath} is disabled`);

  log(`[${testCase}] Prepare input data via OL59 - ${cases.length} case(s) from ` +
    `${path.relative(process.cwd(), apiData.filePath)} (runId ${runId})`);

  const prepared = [];
  const topUps = [];
  for (const [index, caseDef] of cases.entries()) {
    const id = caseDef.id || `case-${index + 1}`;

    // Channel + unit price come from item_price (database), never from a hard-coded literal.
    const mergedItem = { ...(apiData.template.itemRedeem || {}), ...(caseDef.itemRedeem || {}) };
    const price = await resolveItemPrice(
      mergedItem.itmRdmItemCode,
      {
        rewardCurrency: mergedItem.itmRdmRewardCurrency,
        poolId: caseDef.poolId,
        priceId: caseDef.priceId,
      },
      testCase
    );
    log(`[${testCase}] ${id}: item_price ${price.priceId} (${price.itemCode}/${price.poolId}/` +
      `${price.rewardCurrency}) -> ChannelId=${price.channelId}, unitPrice=${price.unitPriceInPoints}`);

    const request = buildRequest(apiData, caseDef, {
      ...ctx,
      messageNum: ctx.messageNumber(index),
      msgSqNum: ctx.msgSqNum(index),
      channelId: price.channelId,
      unitPriceInPoints: price.unitPriceInPoints,
    });

    // Quantity: a failed redemption creates nothing, but a quantity the item cannot serve wastes a
    // run - check it against the stock the database exposes first.
    const quantityCheck = await checkQuantity(
      request.itemRedeem.itmRdmItemCode,
      request.itemRedeem.itmRdmQuantityItem,
      testCase
    );
    if (!quantityCheck.ok) {
      throw new Error(`[${testCase}] ${id}: quantity check failed: ${quantityCheck.reasons.join('; ')}`);
    }
    for (const warning of quantityCheck.warnings) log(`[${testCase}] ${id}: quantity warning - ${warning}`);
    log(`[${testCase}] ${id}: quantity ${quantityCheck.quantity} ok ` +
      `(stock: on_hand ${quantityCheck.qtyOnHand}, reserved ${quantityCheck.qtyReserved}, ` +
      `redeemed ${quantityCheck.qtyRedeem}, available ${quantityCheck.availableStock}, ` +
      `track_stock=${quantityCheck.tracksStock}, max_per_txn ${quantityCheck.maxPerTxn ?? 'n/a'})`);

    // Channel/region: taken from the environment, not from the data file.
    const target = await discoverChannelRegion(request, { channels: [price.channelId], testCase });

    // Step 1 (region) -> step 2 (send with that region).
    // The request is always sent with the channel/region the API actually accepts; when that is not
    // the region this environment is supposed to serve (dev-my / ols_my / BA payload = MY), it is
    // reported as a NOTE so the run continues against the real behaviour of the environment.
    // OLSDB028_REQUIRE_REGION=1 restores the hard failure.
    const expectedRegion = CONFIG.itemRedemptionApi.expectedRegion;
    if (expectedRegion && String(target.region).toUpperCase() !== expectedRegion) {
      const note = `REGION NOTE - the API accepts Region="${target.region}" while this environment ` +
        `expects "${expectedRegion}" (probes: ${target.tried.join(', ')}). Sending the request with ` +
        `Region="${target.region}" (step 1 check -> step 2 send).`;
      if (process.env.OLSDB028_REQUIRE_REGION === '1') {
        throw new Error(`[${testCase}] ${id}: ${note}\n` +
          'OLSDB028_REQUIRE_REGION=1 is set, so the run stops here.');
      }
      log(`[${testCase}] ${id}: ${note}`);
    }

    request.SvcRq.ChannelId = target.channel;
    request.OLSRq.Region = target.region;
    // Optional: point the run at another CIF without editing the data file (used to exercise the
    // "not enough points" fallback with a CIF that has a low balance).
    const cifOverride = (process.env.OLSDB028_CIF_NUM || '').trim();
    if (cifOverride) {
      log(`[${testCase}] ${id}: CIF override ${request.itemRedeem.itmRdmCIFNum} -> ${cifOverride}`);
      request.itemRedeem.itmRdmCIFNum = cifOverride;
    }
    log(`[${testCase}] ${id}: price = ${price.unitPriceInPoints} x ` +
      `${request.itemRedeem.itmRdmQuantityItem} = ${request.itemRedeem.itmRdmFullPriceInPoints} points ` +
      `| ChannelId ${target.channel} / Region ${target.region}`);

    let { httpStatus, body } = await callItemRedemption(request, id);
    let olsRs = body.OLSRs || {};
    let itemRedeem = body.itemRedeem || {};

    // ---- Fallback: the CIF does not have enough points -> adjust the pool, then retry once ----
    const failureText = itemRedeem.itmRdmDisplayMessage || body.errorMessage || '';
    if (String(olsRs.ReturnCode) !== '00000' &&
        isInsufficientPointFailure(olsRs.ReturnCode, failureText) &&
        process.env.OLSDB028_SKIP_TOPUP !== '1') {
      const wantedPoints = Math.round(Number(request.itemRedeem.itmRdmFullPriceInPoints) / 100);
      const csn = await resolveCsnByCif(request.itemRedeem.itmRdmCIFNum, testCase);
      const before = await getPoolBalance(csn, price.poolId, testCase);
      const shortfall = Math.max(wantedPoints - (before.redeemable || 0), 0);
      log(`[${testCase}] ${id}: ${olsRs.ReturnCode} "${failureText}" - need ${wantedPoints} points, ` +
        `pool ${price.poolId} has ${before.redeemable} redeemable -> shortfall ${shortfall}`);
      if (shortfall > 0) {
        const topUp = await topUpPool({
          csn,
          cif: request.itemRedeem.itmRdmCIFNum,
          poolId: price.poolId,
          points: shortfall,
          testCase,
        });
        topUps.push(topUp);
      }
      ({ httpStatus, body } = await callItemRedemption(request, id));
      olsRs = body.OLSRs || {};
      itemRedeem = body.itemRedeem || {};
      log(`[${testCase}] ${id}: retry after adjustment -> ${olsRs.ReturnCode} ref ${itemRedeem.itmRdmRefNbr}`);
    }

    // The service enforces a minimum quantity that no table carries (probed on dev: 100 for
    // UG7814, everything below answered E5908). When it is hit, retry with the next candidate
    // (price recomputed as unit price * quantity) so the run still produces data, and report the
    // minimum that worked. Disable with OLSDB028_AUTO_MIN_QTY=0.
    if (String(olsRs.ReturnCode) === ITEM_MIN_QTY_ERROR && process.env.OLSDB028_AUTO_MIN_QTY !== '0') {
      const asked = Number(request.itemRedeem.itmRdmQuantityItem);
      for (const next of MIN_QTY_CANDIDATES.filter((value) => value > asked)) {
        log(`[${testCase}] ${id}: the API requires a quantity above ${asked} (E5908), retrying with ${next}`);
        request.itemRedeem.itmRdmQuantityItem = String(next);
        request.itemRedeem.itmRdmReceiveQuantity = String(next);
        request.itemRedeem.itmRdmFullPriceInPoints = price.unitPriceInPoints * next;
        request.itemRedeem.itmRdmPoolUnitsRequired = price.unitPriceInPoints * next;
        ({ httpStatus, body } = await callItemRedemption(request, id));
        olsRs = body.OLSRs || {};
        itemRedeem = body.itemRedeem || {};
        if (String(olsRs.ReturnCode) !== ITEM_MIN_QTY_ERROR) break;
      }
    }

    log(`[${testCase}] ${id}: HTTP ${httpStatus} | ReturnCode ${olsRs.ReturnCode} | ` +
      `ref ${itemRedeem.itmRdmRefNbr} | ${itemRedeem.itmRdmDisplayMessage || body.errorMessage || ''}`);

    // Business response, not just HTTP 200 (the gateway answers 200 even for E59xx failures).
    if (String(olsRs.ReturnCode) !== '00000') {
      const hint = String(olsRs.ReturnCode) === ITEM_MIN_QTY_ERROR
        ? `\n  -> the API enforces a minimum quantity for ${request.itemRedeem.itmRdmItemCode}; ` +
          'raise "quantity" of this case in the data file (dev accepted 100, rejected <100).'
        : `\n  -> price sent = item_price.price_in_point x quantity = ` +
          `${request.itemRedeem.itmRdmFullPriceInPoints}, ChannelId=${request.SvcRq.ChannelId}, ` +
          `Region=${request.OLSRq.Region} (both discovered, see the probe log above).`;
      throw new Error(`[${testCase}] ${id}: OL59 business failure ReturnCode=${olsRs.ReturnCode} ` +
        `"${itemRedeem.itmRdmDisplayMessage || body.errorMessage || ''}" ` +
        `(request: item ${request.itemRedeem.itmRdmItemCode}, qty ` +
        `${request.itemRedeem.itmRdmQuantityItem}, price ${request.itemRedeem.itmRdmFullPriceInPoints})` +
        hint);
    }

    const referenceNo = itemRedeem.itmRdmRefNbr;
    if (!referenceNo) throw new Error(`[${testCase}] ${id}: OL59 succeeded but returned no itmRdmRefNbr`);

    const fulfilmentRows = await fetchFulfilmentRows(referenceNo, testCase);
    if (!fulfilmentRows.length) {
      throw new Error(`[${testCase}] ${id}: no ITEM_FULFILMENT_STATUS row for reference ${referenceNo} ` +
        '(the API answered success, so this is an infrastructure problem)');
    }

    const gate = await checkExportGate(referenceNo, testCase);
    if (!gate.found) {
      log(`[${testCase}] ${id}: WARNING - reference ${referenceNo} is not in ` +
        `cat_catalogue_trans_details (status 'A'), so OLSDB028 will not export it`);
    }

    // SOPC rule: pool configured for statement output + still effective + PAL listed for the pool.
    const fulfilment = fulfilmentRows[0];
    const sopc = await checkStatementOutputPool(
      fulfilment.pool_id,
      fulfilment.product_account_level,
      {},
      testCase
    );
    if (sopc.ok) {
      log(`[${testCase}] ${id}: SOPC OK - pool ${sopc.poolId} valid ${sopc.validFrom}..${sopc.validTo}, ` +
        `PAL ${sopc.pal} in ${JSON.stringify(sopc.levels)}`);
    } else {
      log(`[${testCase}] ${id}: SOPC FAILED - ${sopc.reasons.join('; ')}`);
      if (process.env.OLSDB028_SKIP_SOPC_CHECK !== '1') {
        throw new Error(`[${testCase}] ${id}: the redemption ${referenceNo} would NOT be statemented ` +
          `by OLSDB028, so it is not usable test data: ${sopc.reasons.join('; ')}\n` +
          '(set OLSDB028_SKIP_SOPC_CHECK=1 to ignore this rule)');
      }
    }

    // CIF -> account: the CIF (csn) must own the redeemed account with the same product/brand.
    const account = await checkCifAccount({
      csn: fulfilment.csn,
      productAccountNo: fulfilment.product_account_no,
      pal: fulfilment.product_account_level,
      pat: fulfilment.product_account_type,
    }, testCase);
    if (account.ok) {
      log(`[${testCase}] ${id}: CIF ${account.csn} owns account ${account.productAccountNo} ` +
        `(${account.pal}/${account.pat}) - ${account.activeRows} active account(s)`);
    } else {
      log(`[${testCase}] ${id}: CIF ACCOUNT CHECK FAILED - ${account.reasons.join('; ')}`);
      if (process.env.OLSDB028_SKIP_ACCOUNT_CHECK !== '1') {
        throw new Error(`[${testCase}] ${id}: the redemption ${referenceNo} does not satisfy the ` +
          `CIF/account rule: ${account.reasons.join('; ')}\n` +
          '(set OLSDB028_SKIP_ACCOUNT_CHECK=1 to ignore this rule)');
      }
    }

    prepared.push({
      id,
      description: caseDef.description || null,
      referenceNo,
      recordNo: fulfilmentRows[0].record_no,
      extractedDateTime: fulfilmentRows[0].extracted_date_time,
      referenceNoLength: String(referenceNo).length,   // sheet declares X(15)
      itemCode: request.itemRedeem.itmRdmItemCode,
      itemType: fulfilmentRows[0].item_type,
      poolId: fulfilmentRows[0].pool_id,
      supplierId: fulfilmentRows[0].supplier_id,
      quantity: request.itemRedeem.itmRdmQuantityItem,
      points: request.itemRedeem.itmRdmFullPriceInPoints,
      channelId: request.SvcRq.ChannelId,
      region: request.OLSRq.Region,
      priceId: price.priceId,
      unitPriceInPoints: price.unitPriceInPoints,
      fulfilmentStatus: fulfilmentRows[0].fulfillment_status,
      fulfilmentRows: fulfilmentRows.length,
      exportGate: gate.found,
      productAccountLevel: fulfilment.product_account_level,
      productAccountType: fulfilment.product_account_type,
      sopc,
      account,
      request,
      response: body,
    });

    log(`[${testCase}] ${id}: DB row record_no=${fulfilmentRows[0].record_no} ` +
      `status=${fulfilmentRows[0].fulfillment_status} extracted=${fulfilmentRows[0].extracted_date_time} ` +
      `| export gate ${gate.found ? 'OK' : 'MISSING'}`);
  }

  log(`[${testCase}] Prepared ${prepared.length} redemption(s): ` +
    prepared.map((entry) => `${entry.id}=${entry.referenceNo}`).join(', '));

  return { runId, file: apiData.filePath, cases: prepared, topUps };
}

// CLI: node scripts/OLSDB028/file-generator.js
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  prepareData('OLSDB028')
    .then((result) => {
      log('Summary', { runId: result.runId, cases: result.cases.map((c) => `${c.id}->${c.referenceNo}`) });
      process.exit(0);
    })
    .catch((error) => {
      console.error(maskSecret(error.message));
      process.exit(1);
    });
}
