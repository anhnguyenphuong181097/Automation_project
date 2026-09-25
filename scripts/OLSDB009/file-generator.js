// scripts/OLSDB009/file-generator.js
// Batch     : OLSDB009
// File type : OLSTXN (transaction)
// Format ref: OLSTXN-SICS-20250829-50.dat
//
// ============ FILE FORMAT ============
// Four record types, fields separated by '|', lines terminated with CRLF:
//
//   HD | fileId | receivingSystem | createDate | batchDate | fileNumber | filler
//   FN | DT | <field name guide>   <-- NOT read by the system, documentation only
//   FN | TR | <field name guide>   <-- NOT read by the system
//   DT | <47 transaction fields> | <20 dynamic slots> | filler
//   TR | ... | hash1 | ... | hash2 | ... | hash3 | ... | recordCount | filler
//
// recordCount = 1 (HD) + 2 (FN) + N (DT) + 1 (TR) = N + 4
// TR hashes are NOT validated - leaving them empty is accepted.
//
// ============ REFERENCE DATA ============
// CIF / product account / card / terminal / transaction code all come from the
// DB via data-pool. Nothing is hardcoded, so pointing at another DB changes the
// generated files without touching this code.
//
// txnTranCode in particular MUST come from the pool: a code that does not link
// to a live scheme gets the record rejected with BE654.
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getPool,
  testCampaignCode,
  hitCode,
  codeWithoutScheme,
  accountWithCard,
  accountNoCard,
  accountInactive,
  terminal,
  branch,
  campaign,
  adjReason,
  cifFor,
  nonexistent,
  cardNotLinkedTo,
} from './data-pool.js';

// ============ FORMAT CONSTANTS ============
const FILE_ID = 'OLSTXN';
const RECEIVING_SYSTEM = 'OLS';
const SOURCE_SYSTEM = 'OLS'; // the <SOURCE> segment in OLSTXN-<SOURCE>-YYYYMMDD-NN.dat
const HD_FILLER_LEN = 1608; // measured: HD line is 1656 chars total

// The 47 transaction fields in exact DT order (field index 1..47).
const TXN_FIELDS = [
  'txnTranType',          // 1   X(02)  Mandatory
  'txnTranCode',          // 2   X(10)  Mandatory - decides campaign hit
  'txnChannelId',         // 3   X(10)
  'txnCifNbr',            // 4   X(20)  Required if no Acct & no Card Nbr
  'txnProdAcctNbr',       // 5   X(20)  Required if no Card Nbr
  'txnProdAcctType',      // 6   X(08)  Required if no Card Nbr
  'txnProdAcctLevel',     // 7   X(08)  Required if no Card Nbr
  'txnCardNbr',           // 8   X(19)  Required if no Acct Nbr
  'txnAcctCurrCode',      // 9   X(08)  Required if multi-curr acct
  'txnTranDate',          // 10  X(08)  Required if authorised
  'txnTxnTime',           // 11  X(08)  Required if authorised
  'txnSrcPostDate',       // 12  X(08)  Required if settled
  'txnSrcPostTime',       // 13  X(06)  Required if settled
  'txnRefNbr',            // 14  X(23)
  'txnAuthCode',          // 15  X(06)
  'txnBranchId',          // 16  X(15)  Mandatory (MID/StoreId)
  'txnTerminalId',        // 17  X(08)
  'txnAcceptorId',        // 18  X(15)
  'txnAcceptorName',      // 19  X(40)
  'txnBatchNbr',          // 20  9(06)
  'txnTranSign',          // 21  X(01)  Mandatory
  'txnTranAmt',           // 22  9(14,2) Mandatory
  'txnShopName',          // 23  X(30)
  'txnCountryCode',       // 24  X(03)
  'txnTranMcc',           // 25  X(05)
  'txnTranMode',          // 26  X(01)
  'txnDccInd',            // 27  X(01)
  'txnTap2payInd',        // 28  X(01)
  'txnTokenReqId',        // 29  X(11)
  'txnFcyAcctInd',        // 30  X(01)
  'txnPoolId',            // 31  X(10)
  'txnAdjReason',         // 32  X(10)
  'txnCurrencyCode',      // 33  X(03)
  'txnOrigTxnAmt',        // 34  9(14,2)
  'txnSalaryCredit',      // 35  X(01)
  'txnPosEntryMode',      // 36  X(06)
  'txnPosConditionCode',  // 37  X(02)
  'txnServiceCode',       // 38  X(03)
  'txnEcommIndicator',    // 39  X(03)
  'txnMastCardAssignId',  // 40  X(06)  must be empty
  'txnTransactionSource', // 41  X(?)   (absent from the template xlsx)
  'txnTransactionStatus', // 42  X(?)
  'txnT1MOTO',            // 43  X(?)
  'txnVMT',               // 44  X(?)
  'txnFPI',               // 45  X(?)
  'txnRdmPoolUnits',      // 46  9(07)  must be empty
  'txnResponseCode',      // 47  X(02)  must be empty
];

// Guide lines copied verbatim from the reference file. The system does not read
// either of them. The source system's own 'fieldNameName10|value1' typo is kept
// so the generated file stays identical to a real one.
//
// 70 fields, i.e. 47 field names + 20 dynamic name/value slots + 'filler',
// with NO extra empty cell after 'DT'. The reference file used to carry a stray
// empty field there (71 fields) which shifted every name one cell to the right
// of its DT value; it was corrected on 2026-09-11.
const FN_DT_LINE =
  'FN|DT|txnTranType|txnTranCode|txnChannelId|txnCifNbr|txnProdAcctNbr|txnProdAcctType|' +
  'txnProdAcctLevel|txnCardNbr|txnAcctCurrCode|txnTranDate|txnTxnTime|txnSrcPostDate|' +
  'txnSrcPostTime|txnRefNbr|txnAuthCode|txnBranchId|txnTerminalId|txnAcceptorId|' +
  'txnAcceptorName|txnBatchNbr|txnTranSign|txnTranAmt|txnShopName|txnCountryCode|txnTranMcc|' +
  'txnTranMode|txnDccInd|txnTap2payInd|txnTokenReqId|txnFcyAcctInd|txnPoolId|txnAdjReason|' +
  'txnCurrencyCode|txnOrigTxnAmt|txnSalaryCredit|txnPosEntryMode|txnPosConditionCode|' +
  'txnServiceCode|txnEcommIndicator|txnMastCardAssignId|txnTransactionSource|' +
  'txnTransactionStatus|txnT1MOTO|txnVMT|txnFPI|txnRdmPoolUnits|txnResponseCode|' +
  'fieldNameName1|value1|fieldNameName2|value2|fieldNameName3|value3|fieldNameName4|value4|' +
  'fieldNameName5|value5|fieldNameName6|value6|fieldNameName7|value7|fieldNameName8|value8|' +
  'fieldNameName9|value9|fieldNameName10|value1|filler';

const FN_TR_LINE =
  'FN|TR||||||hash(txnProdAcctNbr)||||||hash(txnRefNbr)||||||hash(txnTranAmt)||||||||||||||||recordCount|filler';

const EOL = '\r\n';

// ============ DATE HELPERS ============
export function getCurrentDate() {
  const now = new Date();
  return (
    now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0')
  );
}

export function getDateWithOffset(offsetDays = 0) {
  const now = new Date();
  now.setDate(now.getDate() + offsetDays);
  return (
    now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0')
  );
}

// ============ FILE NAME ============
// OLSTXN-<SOURCE>-YYYYMMDD-NN.dat
export function generateFileName(seq, date = null) {
  const d = date || getCurrentDate();
  return `${FILE_ID}-${SOURCE_SYSTEM}-${d}-${String(seq).padStart(2, '0')}.dat`;
}

// ============ BUILDERS ============
function buildHeader(date, fileNumber) {
  const fn = String(fileNumber).padStart(4, '0');
  return (
    `HD|${FILE_ID.padEnd(10)}|${RECEIVING_SYSTEM.padEnd(10)}|${date}|` +
    `${' '.repeat(8)}|${fn}|${' '.repeat(HD_FILLER_LEN)}${EOL}`
  );
}

/**
 * Build one DT record.
 * @param {Object} values - map of field name to value. Omitted fields are blank.
 *   e.g. { txnTranType: '02', txnTranCode: '10096', txnTranAmt: '00000000010000' }
 * @returns {string} DT record (69 fields) + CRLF
 */
export function buildDetail(values = {}) {
  const cells = ['DT'];
  for (const f of TXN_FIELDS) {
    cells.push(values[f] === undefined || values[f] === null ? '' : String(values[f]));
  }
  // 20 dynamic slots (10 fieldName/value pairs) - always blank in test data
  for (let i = 0; i < 10; i++) {
    cells.push('');
    cells.push('');
  }
  cells.push(''); // filler
  return cells.join('|') + EOL;
}

// The three trailer hashes. The batch does not recompute or validate them, but
// it expects the cells to be populated. Every reference file carries these same
// three constants regardless of the data in the file, which is what proves they
// are placeholders rather than derived values. Reproduced verbatim.
export const TR_HASHES = ['1234567890', '1234554321', '1987654321'];

/**
 * Build the TR record.
 * @param {number} recordCount - total records in the file = N(DT) + 4
 * @param {string[]} hashes - 3 hashes; defaults to the reference placeholders
 */
export function buildTrailer(recordCount, hashes = TR_HASHES) {
  const cells = new Array(70).fill('');
  cells[0] = 'TR';
  cells[5] = hashes[0] || '';   // hash(txnProdAcctNbr)
  cells[14] = hashes[1] || '';  // hash(txnRefNbr)
  cells[22] = hashes[2] || '';  // hash(txnTranAmt)
  cells[68] = String(recordCount).padStart(9, '0');
  cells[69] = 'b';
  return cells.join('|') + EOL;
}

/**
 * Build a complete OLSTXN file.
 * @param {Object} opts
 * @param {string} opts.date - YYYYMMDD
 * @param {number} opts.fileNumber - file sequence number, written into HD
 * @param {Array<Object>} opts.details - array of DT field maps
 * @param {Array<string>} [opts.rawDetails] - raw DT lines, for malformed data
 * @returns {string}
 */
export function buildFile({ date, fileNumber, details = [], rawDetails = [] }) {
  const dtRecords = [
    ...details.map((d) => buildDetail(d)),
    ...rawDetails.map((r) => (r.endsWith(EOL) ? r : r + EOL)),
  ];
  const recordCount = 1 + 2 + dtRecords.length + 1;

  return (
    buildHeader(date, fileNumber) +
    FN_DT_LINE + EOL +
    FN_TR_LINE + EOL +
    dtRecords.join('') +
    buildTrailer(recordCount)
  );
}

// ============ OUTPUT DIR ============
async function cleanOldFiles(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.removeSync(dir);
      console.log(`Cleared previous output: ${dir}`);
    }
  } catch (error) {
    console.error('Failed to clear previous output:', error.message);
    throw error;
  }
}

// ============ SHARED TEST DATA ============
// Reference data (CIF, account, card, terminal, transaction code) is resolved
// from the DB through the pool. Scenario data (transaction type, amount, sign,
// dates) stays fixed on purpose - that is a test design choice, not a lookup.

/**
 * Customer-side fields common to every transaction type, resolved from the DB.
 * @param {Object} pool
 * @param {number} index - pick the Nth record in the pool
 */
function customerFields(pool, index = 0) {
  // Ordered by card_count DESC, so index 0 is the account carrying the most
  // cards - the shape a real rewards account has.
  const acct = accountWithCard(pool, { status: 'A' }, index);
  // txnBranchId is mandatory, so it comes from the branch master (631 active
  // rows on dev-my) rather than off a terminal.
  const br = branch(pool, { status: 'A' }, index);

  return {
    txnChannelId: 'BATCH',
    // cust_cif_nbr is NULL on many accounts; cifFor falls back to
    // card.customer_id, the CIF-like value the DB actually holds.
    txnCifNbr: cifFor(acct),
    txnProdAcctNbr: acct.product_account_no,
    txnProdAcctType: acct.product_account_type,
    txnProdAcctLevel: acct.product_account_level,
    txnAcctCurrCode: acct.acct_curr_code || 'SGD', // DB column is NULL -> default SGD
    txnBranchId: br.branch_id,

    // Blank by design - see the header note. The reference file leaves both
    // blank too: the file carries a batch channel, not a terminal transaction.
    txnTerminalId: '',

    // Blank by default. The spec says card is "Required if no Acct Nbr" and the
    // reference file leaves it blank. Override it to exercise the card path.
    txnCardNbr: '',
  };
}

/**
 * Scenario fields shared by every transaction type. These stay fixed on purpose:
 * they describe the test scenario, they are not DB lookups.
 */
function scenarioFields() {
  return {
    txnTxnTime: '000000',
    txnAuthCode: '413708',
    txnAcceptorName: 'PAY+EARN SINGAPORE SG',
    txnBatchNbr: '000000',
    txnShopName: 'PAY+EARN SINGAP',
    txnCountryCode: 'SG',
    txnTranMcc: 'M3',
    txnTranMode: '0',
    txnCurrencyCode: 'SGD',
    txnPosEntryMode: '00',
    txnServiceCode: '000',
    txnTransactionSource: 'L',
    txnTransactionStatus: '000',
    txnRdmPoolUnits: '0000000',
  };
}

/**
 * A valid purchase transaction (txnTranType '02') built from a real account.
 * @param {Object} pool - snapshot from data-pool
 * @param {Object} overrides - override any field
 * @param {Object} [opts]
 * @param {number} [opts.index] - pick the Nth record in the pool
 * @param {boolean} [opts.testCampaignOnly] - restrict the code to the automation test campaign
 */
export function validTxn(pool, overrides = {}, { index = 0, testCampaignOnly = true } = {}) {
  const code = testCampaignOnly ? testCampaignCode(pool, index) : hitCode(pool, {}, index);

  return {
    txnTranType: '02',
    txnTranCode: code.transaction_code, // decides whether the campaign is hit
    ...customerFields(pool, index),
    ...scenarioFields(),
    txnTranDate: getCurrentDate(),
    txnSrcPostDate: getCurrentDate(),
    txnSrcPostTime: '184232',
    txnRefNbr: '', // optional field - left blank rather than faked
    txnTranSign: '+',
    txnTranAmt: '00000000010000',
    txnOrigTxnAmt: '00000000010000',
    ...overrides,
  };
}

/**
 * An adjustment transaction (txnTranType '03').
 *
 * Two fields are set by test design, the rest come from the DB:
 *   txnTranType  '03'    - the adjustment record type
 *   txnTranCode  ''      - an adjustment carries no code of its own
 *   txnAdjReason         - resolved from reason_code (id_level 'ADJ', status 'A')
 *
 * @param {Object} pool - snapshot from data-pool
 * @param {Object} overrides - override any field
 * @param {Object} [opts]
 * @param {number} [opts.index] - pick the Nth record in the pool
 * @param {number} [opts.reasonIndex] - pick the Nth active adjustment reason
 */
export function adjustTxn(pool, overrides = {}, { index = 0, reasonIndex = 0 } = {}) {
  return {
    txnTranType: '03',
    txnTranCode: '',
    ...customerFields(pool, index),
    ...scenarioFields(),
    txnAdjReason: adjReason(pool, reasonIndex),
    txnTranDate: getCurrentDate(),
    txnSrcPostDate: getCurrentDate(),
    txnSrcPostTime: '184232',
    txnRefNbr: '', // optional field - left blank rather than faked
    txnTranSign: '+',
    txnTranAmt: '00000000010000',
    txnOrigTxnAmt: '00000000010000',
    ...overrides,
  };
}

// ============ TEST CASE REGISTRY ============
// Each case owns one folder: generated/OLSDB009/<id>/ holding its .dat files.
// Adding a case means adding one entry here. Every entry declares its INTENT and
// lets the pool resolve real values; no literal reference data belongs here.
const TEST_CASES = [
  {
    id: 'tc1',
    description: 'Adjust transaction - 1 DT record',
    // HD sequence number starts at 0001 and increments per file.
    build: (date, pool) => [
      { seq: 1, fileNumber: 1, details: [adjustTxn(pool)] },
    ],
  },

  // ============================================================
  // NEXT CASES - to be added one at a time
  // ============================================================
];

// ============ OUTPUT LOCATION ============
const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GENERATED_ROOT = path.join(PROJECT_ROOT, 'scripts', 'test-data', 'generated', 'OLSDB009');

// ============ GENERATE ONE CASE ============
/**
 * Write every .dat file belonging to one test case into that case's own folder,
 * and return the file names written (so a caller can assert on them).
 *
 * Only this case's folder is cleared, so generating one case never disturbs
 * another. The data pool is fetched once per call unless the caller passes one.
 *
 * @param {string} tcId - a TEST_CASES id, e.g. 'tc1'
 * @param {Object} [opts]
 * @param {string} [opts.date] - batch date, defaults to today
 * @param {Object} [opts.pool] - reuse an already-loaded pool
 * @param {boolean} [opts.quiet] - suppress progress output
 * @returns {Promise<string[]>} names of the files written
 */
export async function generateTestCase(tcId, { date, pool, quiet = false } = {}) {
  const tc = TEST_CASES.find((c) => c.id === tcId);
  if (!tc) {
    throw new Error(
      `Unknown test case "${tcId}". Known cases: ${TEST_CASES.map((c) => c.id).join(', ')}`);
  }

  const say = quiet ? () => {} : (msg) => console.log(msg);
  const batchDate = date || getCurrentDate();
  const tcPath = path.join(GENERATED_ROOT, tc.id);

  await cleanOldFiles(tcPath);
  fs.ensureDirSync(tcPath);

  const dataPool = pool || await getPool();
  const names = [];

  for (const f of tc.build(batchDate, dataPool)) {
    const name = generateFileName(f.seq, f.date || batchDate);
    const content = buildFile({
      date: f.date || batchDate,
      fileNumber: f.fileNumber !== undefined ? f.fileNumber : f.seq,
      details: f.details || [],
      rawDetails: f.rawDetails || [],
    });
    fs.writeFileSync(path.join(tcPath, name), content);
    const dtCount = (f.details || []).length + (f.rawDetails || []).length;
    say(`   OK ${name} (${dtCount} DT record)`);
    names.push(name);
  }

  return names;
}

// ============ GENERATE ALL ============
export async function generateAllTestFiles() {
  console.log('Generating OLSDB009 test files (OLSTXN)...\n');
  console.log(`Output path: ${GENERATED_ROOT}`);
  console.log('='.repeat(60));

  try {
    const date = getCurrentDate();
    console.log(`Date: ${date}`);

    console.log('\nLoading data pool...');
    const pool = await getPool();
    console.log(`Transaction codes hitting campaign "${pool.meta.testCampaignId}": ` +
      `${pool.meta.counts.hitCodesForTestCampaign}`);
    console.log('='.repeat(60));

    let totalFiles = 0;

    for (const tc of TEST_CASES) {
      console.log(`\n${tc.id.toUpperCase()}: ${tc.description}`);
      const names = await generateTestCase(tc.id, { date, pool });
      totalFiles += names.length;
    }

    console.log('\n' + '='.repeat(60));
    console.log(`Done: ${totalFiles} file(s) across ${TEST_CASES.length} case(s)`);
    console.log('='.repeat(60));
  } catch (error) {
    console.error('\nERROR:', error.message);
    console.error(error.stack);
    throw error;
  }
}

// ============ CLI ENTRY ============
// Only when run directly (npm run generate:olsdb009). Importing this module from
// a test must not regenerate files or call process.exit().
const isDirectRun = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  console.log('Starting file generator...');
  generateAllTestFiles()
    .then(() => {
      console.log('Generation completed successfully!');
    })
    .catch((error) => {
      console.error('Generation failed:', error);
      process.exit(1);
    });
}

export default {
  getCurrentDate,
  getDateWithOffset,
  generateFileName,
  buildDetail,
  buildTrailer,
  buildFile,
  validTxn,
  adjustTxn,
  generateTestCase,
  generateAllTestFiles,
};
