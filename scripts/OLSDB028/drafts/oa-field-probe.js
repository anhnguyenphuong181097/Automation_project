// scripts/OLSDB028/drafts/oa-field-probe.js
// DRAFT (khong thuoc automation). Muc dich: doc trang Create cua module 6412 (Item Redemption Entry)
// va tim ra cac field trong form: ten field -> ma R_6413xx, dac biet la field Email (item type EV/Traveloka).
//
// Chay: node scripts/OLSDB028/drafts/oa-field-probe.js

import fs from 'fs-extra';
import path from 'path';
import { loginOa, makeSession } from './oa-prepare.js';

const BASE = process.env.OA_BASE_URL || 'https://dev-my.ocbc.apps.okd.oneempower.com.vn/oneadmin';
const OUT_DIR = path.join(process.cwd(), 'scripts', 'test-data', 'generated', 'OLSDB028', 'oa');
const URL_CREATE = `${BASE}/loadDetails?moduleId=6412&groupId=6406&retModuleId=undefined&mode=create`;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// loginOa da lay CSRF; ham nay tra ve them phien de fetch tiep
export async function openCreateScreen() {
  const session = makeSession();
  await loginOa(session);
  const res = await session.req(URL_CREATE, {
    headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: URL_CREATE },
  });
  const html = await res.text();
  await fs.ensureDir(OUT_DIR);
  await fs.writeFile(path.join(OUT_DIR, 'create-6412.html'), html, 'utf8');
  return { session, html, status: res.status };
}

/** Nap phan "Item Listing" (sub-module 6413) - day la bang chua cac field nhu Email / Member Id. */
export async function openItemListing(session, csrf = '') {
  const url = `${BASE}/loadSubModuleSection?moduleId=6412&subModuleId=6413&mainRecNo=&uiidPk=641201&uiidFk=641327&uiid=641222&pkOtherValue=&status=`;
  const res = await session.req(url, {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: URL_CREATE, 'X-CSRF-TOKEN': csrf },
  });
  const html = await res.text();
  await fs.ensureDir(OUT_DIR);
  await fs.writeFile(path.join(OUT_DIR, 'submodule-6413.html'), html, 'utf8');
  return { html, status: res.status };
}

/** Map nhan (label) -> ma field R_xxxxxx dua tren cac the form-group trong HTML. */
function labelFieldMap(html) {
  const out = [];
  const re = /id='formGroup(\d+)'[\s\S]{0,600}?<label[^>]*>([^<]*)</g;
  let m;
  while ((m = re.exec(html))) out.push({ uiid: m[1], label: m[2].trim() });
  return out;
}

/** In ra moi dong chua 'mail' (khong phan biet hoa thuong) de tim field Email. */
function linesWith(html, needle) {
  const out = [];
  const lines = html.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.toLowerCase().includes(needle.toLowerCase())) out.push(`${i + 1}: ${line.trim().slice(0, 400)}`);
  });
  return out;
}

/** Liet ke cac input/select/textarea trong HTML kem id/name/value. */
function listControls(html) {
  const re = /<(input|select|textarea)\b([^>]*)>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[2];
    const get = (a) => (attrs.match(new RegExp(`${a}\\s*=\\s*"([^"]*)"`, 'i')) || [])[1] || '';
    out.push({ tag: m[1].toLowerCase(), name: get('name'), id: get('id'), type: get('type'), value: get('value') });
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('oa-field-probe.js')) {
  const { html, status } = await openCreateScreen();
  console.log(`create screen: HTTP ${status}, ${html.length} bytes`);

  console.log('\n=== dong chua "mail" ===');
  const mailLines = linesWith(html, 'mail');
  console.log(mailLines.length ? mailLines.join('\n') : '(khong tim thay)');

  const controls = listControls(html);
  console.log(`\n=== controls: ${controls.length} ===`);
  for (const c of controls) console.log(`${c.tag}\tname=${c.name}\tid=${c.id}\ttype=${c.type}\tvalue=${String(c.value).slice(0, 40)}`);
}

if (process.argv[1] && process.argv[1].endsWith('oa-field-probe.js') && process.argv.includes('--sub')) {
  const session = makeSession();
  const { csrf } = await loginOa(session);
  const { html, status } = await openItemListing(session, csrf);
  console.log(`\nsubmodule 6413: HTTP ${status}, ${html.length} bytes`);
  console.log('\n=== label -> field ===');
  for (const f of labelFieldMap(html)) console.log(`${f.uiid}\t${f.label}`);
}

if (process.argv[1] && process.argv[1].endsWith('oa-field-probe.js') && process.argv.includes('--fields')) {
  const session = makeSession();
  const { csrf } = await loginOa(session);
  const { html, status } = await openItemFields(session, csrf);
  console.log(`\nloadSubModule: HTTP ${status}, ${html.length} bytes`);
  console.log('\n=== label -> field ===');
  for (const f of labelFieldMap(html)) console.log(`${f.uiid}\t${f.label}`);
  console.log('\n=== dong chua "mail" ===');
  console.log(linesWith(html, 'mail').join('\n') || '(khong tim thay)');
}
/** Nap bang field that su cua dong item (loadSubModule) - day moi la noi co Email / Member Id. */
export async function openItemFields(session, csrf = '') {
  const url = `${BASE}/loadSubModule`;
  const body = new URLSearchParams({
    moduleId: '6412', subModuleId: '6413', mainRecNo: '0', pkOtherValue: '', uiidPk: '641201',
    uiidFk: '641327', uiid: '641222', status: '', mode: 'CREATE',
  });
  const res = await session.req(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
      Referer: URL_CREATE, 'X-CSRF-TOKEN': csrf },
    body,
  });
  const html = await res.text();
  await fs.ensureDir(OUT_DIR);
  await fs.writeFile(path.join(OUT_DIR, 'submodule-fields-6413.html'), html, 'utf8');
  return { html, status: res.status };
}

