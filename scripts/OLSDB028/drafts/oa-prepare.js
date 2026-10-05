// scripts/OLSDB028/drafts/oa-prepare.js
// PROTOTYPE (khong thuoc automation) - chay thu luong OA Item Redemption Entry qua HTTP:
//   login -> create screen -> Save (actionId=C) -> doc record -> Approve (actionId=A) -> verify IFS
//
// Muc dich: nghien cuu kha nang dung OA lam nguon input cho OLSDB028.
// KHONG duoc import boi test-runner.spec.js / file-generator.js.
//
// Chay:  node scripts/OLSDB028/drafts/oa-prepare.js
// Credential: doc tu file login cua project khac (khong luu vao repo):
//   OA_LOGIN_DATA=C:/CSR-OCBC-PW/src/login/loginData.ts (mac dinh)

import fs from 'fs-extra';
import pg from 'pg';
import { CONFIG, SCHEMA, BALANCE_QUERY } from '../test-data.js';

const BASE = process.env.OA_BASE_URL || 'https://dev-my.ocbc.apps.okd.oneempower.com.vn/oneadmin';
const LOGIN_DATA = process.env.OA_LOGIN_DATA || 'C:/CSR-OCBC-PW/src/login/loginData.ts';
const BRANCH_ID = process.env.OA_BRANCH_ID || '000001075000032';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // dev self-signed certificate

// ---------------------------------------------------------------- session
function readLogin() {
  const txt = fs.readFileSync(LOGIN_DATA, 'utf8');
  return {
    user: (txt.match(/username:\s*'([^']+)'/) || [])[1],
    pass: (txt.match(/password:\s*'([^']+)'/) || [])[1],
  };
}

export function makeSession() {
  const jar = new Map();
  const setCookies = (res) => {
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const req = async (url, opts = {}) => {
    const res = await fetch(url, { redirect: 'manual', ...opts, headers: { Cookie: cookie(), ...(opts.headers || {}) } });
    setCookies(res);
    return res;
  };
  return { req, cookie };
}

export async function loginOa(session) {
  const { user, pass } = readLogin();
  const page = await (await session.req(`${BASE}/login`)).text();
  const csrf = (page.match(/name="_csrf"[^>]*value="([^"]+)"/i) || [])[1] || '';
  const res = await session.req(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ userid: user, pwd: pass, bizid: '', _csrf: csrf }),
  });
  log(`login: ${res.status} (user ${user})`);
  const screen = await (await session.req(`${BASE}/loadDetails?moduleId=6412&groupId=6406&retModuleId=undefined&mode=create`)).text();
  const meta = (screen.match(/name="_csrf"\s+content="([^"]+)"/i) || [])[1] || csrf;
  return { user, csrf: meta };
}

// ---------------------------------------------------------------- payload
const dt = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/**
 * Dung payload y nhu framework OA gui (field R_6412xx + R_641222 listing JSON).
 * record: null -> create (actionId C); record -> approve (actionId A).
 */
export function buildOaPayload({ cif, catalogue, item, itemName, catalogueName, rewardCurrency, quantity = 1,
  listPrice = '10.00', faceValue = '10', totalPoints = 10, priceSeqNo = '130362', memberId = '180241',
  firstName = 'abc', lastName = 'd', channel = 'INB', redemptionDate = new Date(), record = null, createdBy = 'olsadmin2',
  email = '' }) {
  const totalPrice = Number(listPrice).toFixed(2);
  const row = {
    R_641327: record ? String(record.recordNo) : '',
    R_641309Val: `${catalogueName || catalogue} [${catalogue}]`,
    R_641309: catalogue,
    R_641308Val: `${itemName || item} [${item}]`,
    R_641308: item,
    R_641340Val: `${rewardCurrency} [${rewardCurrency}]`,
    R_641340: rewardCurrency,
    R_641330: '', R_641325: '0', R_641324: totalPrice, R_641323: faceValue, R_641337: '0',
    R_641339: String(totalPoints), R_641338: '0', R_641349: '', R_641310: String(quantity),
    R_641346: `${totalPrice} ${itemName || item}`, R_641316: totalPrice, R_641326: '0', R_641328: '0',
    R_641301: record ? String(record.recordNo) : 0, R_641341: `0 ${rewardCurrency} per $0`, R_641343: '0',
    R_641344: totalPrice, R_641319: '', R_641347: String(totalPoints), R_641348: '0', R_641322: '',
    R_641320: '', R_641321: email, R_641351Val: '', R_641351: '', R_641350Val: '', R_641350: '',
    R_641334Val: '', R_641334: '', R_641329: '', R_641332: '', R_641317: '', R_641335: '', R_641336: '',
    R_641352: '', R_641353: '', R_641312: memberId, R_641313: firstName, R_641314: lastName,
    R_641360: '', R_641361: '', R_641362: '', R_641363: '', R_641364: '', R_641365: '',
    R_641331: priceSeqNo,
  };
  // Nhom "gui cho khach" (delivery / e-voucher). Ten field lay tu form that (loadSubModule 6413):
  //   641320 Mobile | 641321 Email | 641317 Delivery Address 1 | 641335 Zip Code | 641336 Area
  //   641334 City   | 641350 Province | 641351 Country
  //   641312 Member Id | 641313 Member First Name | 641314 Member Last Name
  // Item EV (vi du Traveloka) bat buoc phai co Email: user xac nhan dung tvlk.coupon@gmail.com.
  if (record) Object.assign(row, { R_641303: 'C', R_641304: record.createdBy || createdBy, R_641305: record.createdAt, R_641303Val: 'Created' });

  const fields = {
    R_641225: record ? String(record.seqNo) : '',
    R_641231: record ? 'AC' : 'CIF',
    R_641232: cif, R_641220: '', R_641223: 'false',
    R_641201: record ? String(record.recordNo) : '',
    R_641221: '', R_641209: channel, R_641213: dt(redemptionDate), R_641218: BRANCH_ID,
    R_641222: JSON.stringify({ listing: [row], removed: [], validationRule: '1n' }),
    // cac o "trong" ma framework van gui kem
    R_641327: '', R_641309: '', R_641308: '', R_641340: '', R_641330: '', R_641325: '0', R_641324: '',
    R_641323: '0', R_641337: '0', R_641339: '0', R_641338: '0', R_641349: '', R_641310: '', R_641346: '',
    R_641316: '0', R_641326: '0', R_641328: '0', R_641301: '', R_641341: '', R_641343: '', R_641344: '',
    R_641319: '', R_641347: '0', R_641348: '0', R_641322: '', R_641320: '', R_641321: '', R_641351: '',
    R_641350: '', R_641334: '', R_641329: '', R_641332: '', R_641317: '', R_641335: '', R_641336: '',
    R_641352: '', R_641353: '', R_641312: '', R_641313: '', R_641314: '', R_641360: '', R_641361: '',
    R_641362: '', R_641363: '', R_641364: '', R_641365: '', R_641331: '',
  };
  if (record) Object.assign(fields, { R_641203: 'C', R_641204: record.createdBy || createdBy, R_641205: record.createdAt, R_641206: '', R_641207: '' });
  fields.actionId = record ? 'A' : 'C';
  fields.moduleId = '6412';
  return fields;
}

// ---------------------------------------------------------------- DB helpers
async function withDb(fn) {
  const client = new pg.Client({ host: CONFIG.database.host, port: CONFIG.database.port, user: CONFIG.database.username,
    password: CONFIG.database.password, database: CONFIG.database.database });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

/** Record OA moi nhat cua mot CIF (de lay RECORD_NO / SEQ_NO / STATUS). */
export async function latestOaRecord(cif) {
  return withDb(async (c) => (await c.query(
    `SELECT record_no, seq_no, status, to_char(last_update_date,'DD-MM-YYYY HH24:MI:SS') AS created_at, last_update_by AS created_by
       FROM ${SCHEMA}.w_cat_catalogue_trans WHERE cif_no = $1 ORDER BY record_no DESC LIMIT 1`, [cif])).rows[0]);
}

/** IFS rows cua mot CIF, moi nhat truoc. */
export async function latestIffRows(csn, limit = 3) {
  return withDb(async (c) => (await c.query(
    `SELECT record_no::text, reference_no, item_code, pool_id, redeemed_point::text, fulfillment_status, last_update_by,
            extracted_date_time::text
       FROM ${SCHEMA}.item_fulfilment_status WHERE csn = $1 ORDER BY record_no DESC LIMIT ${Number(limit)}`, [csn])).rows);
}

export async function csnOf(cif) {
  return withDb(async (c) => (await c.query(
    `SELECT csn FROM ${SCHEMA}.client WHERE external_reference_no = $1 AND status='A' ORDER BY record_no DESC LIMIT 1`, [cif])).rows[0]?.csn);
}

// ---------------------------------------------------------------- actions
async function post(session, fields, csrf) {
  const body = Object.entries(fields).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const res = await session.req(`${BASE}/controller`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-TOKEN': csrf, 'X-Requested-With': 'XMLHttpRequest',
      Referer: `${BASE}/loadDetails?moduleId=6412&groupId=6406&retModuleId=undefined&mode=create` },
    body,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

/**
 * Goi API quote cua OA de lay cac gia tri auto-populate (item name, price, points, seq, pool...).
 * Day chinh la nguon ma man hinh Create dung de dien cac field R_6413xx.
 */
export async function quoteItem(session, { cif, itemCode, rewardCurrency = '0VN', channel = 'INB', cardNo = '',
  product = 'undefined', brand = 'undefined', currency = 'undefined', csrf = '' }) {
  const fd = new URLSearchParams({ itemCode, redemptionChannel: channel, cardNo, redemptionDate: dt(new Date()),
    cif, paNo: 'undefined', product, brand, currency, rewardCurrency });
  const res = await session.req(`${BASE}/ajax/getItemPriceForItemRedeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
      'X-CSRF-TOKEN': csrf,
      Referer: `${BASE}/loadDetails?moduleId=6412&groupId=6406&retModuleId=undefined&mode=create` },
    body: fd,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  if (!json || json.itemCode === undefined) {
    throw new Error(`quote ${itemCode} failed: HTTP ${res.status} ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
  }
  log(`quote ${itemCode}: pool=${json.poolId} cur=${json.rewardCurrencyCode} fullPrice=${json.fullRedeemPrice} ` +
    `itemValue=${json.itemValue} listPrice=${json.listPrice} seq=${json.itemPriceSeqNo} minQty=${json.minQty} type=${json.itemType}`);
  return json;
}

/** Chay 1 vong OA cho nhieu item type: quote -> Save -> Approve -> verify IFS. */
export async function runOaForItems(items) {
  const session = makeSession();
  const { csrf } = await loginOa(session);
  const results = [];

  for (const spec of items) {
    const cif = spec.cif || '002222300006877';
    const csn = await csnOf(cif);
    try {
      const q = await quoteItem(session, { cif, itemCode: spec.item, rewardCurrency: spec.rewardCurrency || '0VN', channel: spec.channel || 'INB', csrf });
      const quantity = Number(spec.quantity || q.minQty || 1);
      const before = await latestIffRows(csn, 1);
      const save = await post(session, buildOaPayload({
        cif,
        catalogue: q.catalogueCode || spec.catalogue,
        catalogueName: q.catalogueName || spec.catalogue,
        item: q.itemCode,
        itemName: q.itemName,
        rewardCurrency: q.rewardCurrencyCode,
        quantity,
        listPrice: String(q.listPrice ?? q.fullRedeemPrice),
        faceValue: String(Math.round(Number(q.itemValue ?? q.fullRedeemPrice))),
        totalPoints: Math.round(Number(q.fullRedeemPrice)),
        priceSeqNo: String(q.itemPriceSeqNo),
        memberId: q.ffpMemberNbr || spec.memberId || '180241',
        firstName: q.ffpFirstName || spec.firstName || 'abc',
        lastName: q.ffpLastName || spec.lastName || 'd',
        email: spec.email || '',
        channel: spec.channel || 'INB',
      }), csrf);
      const created = await latestOaRecord(cif);
      const approve = await post(session, buildOaPayload({
        cif,
        catalogue: q.catalogueCode || spec.catalogue,
        catalogueName: q.catalogueName || spec.catalogue,
        item: q.itemCode,
        itemName: q.itemName,
        rewardCurrency: q.rewardCurrencyCode,
        quantity,
        listPrice: String(q.listPrice ?? q.fullRedeemPrice),
        faceValue: String(Math.round(Number(q.itemValue ?? q.fullRedeemPrice))),
        totalPoints: Math.round(Number(q.fullRedeemPrice)),
        priceSeqNo: String(q.itemPriceSeqNo),
        memberId: q.ffpMemberNbr || spec.memberId || '180241',
        firstName: q.ffpFirstName || spec.firstName || 'abc',
        lastName: q.ffpLastName || spec.lastName || 'd',
        email: spec.email || '',
        channel: spec.channel || 'INB',
        record: { recordNo: created.record_no, seqNo: created.seq_no, createdAt: created.created_at, createdBy: created.created_by },
      }), csrf);
      const rows = await latestIffRows(csn, 3);
      const fresh = rows.find((r) => r.item_code === q.itemCode && !before.some((b) => b.reference_no === r.reference_no));
      results.push({
        item: spec.item, itemType: q.itemType, pool: q.poolId, rewardCurrency: q.rewardCurrencyCode,
        quantity, priceSeqNo: q.itemPriceSeqNo,
        save: save.json && save.json.messages, approve: approve.json && approve.json.messages,
        oaRecord: `${created.record_no}/${created.seq_no}`, oaStatus: (await latestOaRecord(cif)).status,
        ifs: fresh ? `${fresh.reference_no} (extracted ${fresh.extracted_date_time}, by ${fresh.last_update_by})` : 'KHONG THAY ROW MOI',
      });
      log(`${spec.item}: Save="${save.json && save.json.messages}" | Approve="${approve.json && approve.json.messages}" | IFS ${fresh ? fresh.reference_no : '(none)'}`);
    } catch (e) {
      results.push({ item: spec.item, error: e.message });
      log(`${spec.item}: ERROR ${e.message}`);
    }
  }
  return results;
}

/** Chay 1 vong: login -> Save -> (doc record) -> Approve -> verify IFS. */
export async function runOaRedemption({ cif = '002222300006877', catalogue = 'TRANG', catalogueName = 'trang test',
  item = 'ITER', itemName = 'item code enrich', rewardCurrency = '0VN', quantity = 1 } = {}) {
  const session = makeSession();
  const { csrf } = await loginOa(session);
  const csn = await csnOf(cif);
  log(`CIF ${cif} -> csn ${csn}`);

  const before = await latestOaRecord(cif);
  log(`OA record moi nhat TRUOC: ${before ? `${before.record_no}/${before.seq_no} status ${before.status}` : '(none)'}`);

  const save = await post(session, buildOaPayload({ cif, catalogue, catalogueName, item, itemName, rewardCurrency, quantity }), csrf);
  log(`SAVE -> HTTP ${save.status} ${JSON.stringify(save.json || save.text).slice(0, 200)}`);

  const created = await latestOaRecord(cif);
  log(`OA record SAU Save: ${created.record_no}/${created.seq_no} status ${created.status} by ${created.created_by}`);
  const ifsAfterSave = await latestIffRows(csn, 1);
  log(`IFS sau Save: ${ifsAfterSave.length ? `ref ${ifsAfterSave[0].reference_no} (${ifsAfterSave[0].extracted_date_time})` : '(khong co row moi)'}`);

  const approve = await post(session, buildOaPayload({ cif, catalogue, catalogueName, item, itemName, rewardCurrency, quantity,
    record: { recordNo: created.record_no, seqNo: created.seq_no, createdAt: created.created_at, createdBy: created.created_by } }), csrf);
  log(`APPROVE -> HTTP ${approve.status} ${JSON.stringify(approve.json || approve.text).slice(0, 200)}`);

  const after = await latestOaRecord(cif);
  log(`OA record SAU Approve: ${after.record_no}/${after.seq_no} status ${after.status}`);
  const ifs = await latestIffRows(csn, 2);
  console.log('IFS sau Approve:');
  for (const r of ifs) console.log('   ' + JSON.stringify(r));

  return { csn, saved: created, approved: after, ifs };
}

if (process.argv[1] && process.argv[1].endsWith('oa-prepare.js') && process.argv[2] === '--quote') {
  const session = makeSession();
  const { csrf } = await loginOa(session);
  const cif = process.argv[4] || '002222300006877';
  const q = await quoteItem(session, { cif, itemCode: process.argv[3], rewardCurrency: process.argv[5] || '0VN', csrf });
  console.log(JSON.stringify(q, null, 1));
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith('oa-prepare.js') && process.argv[2] !== '--quote') {
  const items = [
    // Traveloka (item type EV): field bat buoc la Email (R_641321) = tvlk.coupon@gmail.com
    { item: 'ITTL1', catalogue: 'TRANG', rewardCurrency: '0VN', quantity: 1,
      email: 'tvlk.coupon@gmail.com' },
  ];
  runOaForItems(items)
    .then((r) => { log('=== SUMMARY ==='); console.log(JSON.stringify(r, null, 1)); process.exit(0); })
    .catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}
