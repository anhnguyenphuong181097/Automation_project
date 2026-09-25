// scripts/OLSMCC/file-generator.js
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============ SEQUENCE NUMBER ============
// ols_schema.batch_resource is the batch's ledger of every file it has ever
// accepted - one row per logical_filename. A name that is already in it is refused
// outright ("File 'OLSMCC-<date>-01.dat' already exist", error BE051); the job then
// throws JobInterruptedException and the batch stops with exit code 20 without
// producing a single .out file. Names 01..04 therefore work exactly once per day.
// The team's own usage of that table shows the convention: advance the sequence
// number on every run (one day used 21-25, another used 03/05/07/08/09). So the
// generator asks the ledger which numbers today has already consumed and starts
// after the highest one, which makes regeneration repeatable within the same day.
const DB_CONFIG = {
  host: process.env.DB_HOST || '192.168.99.83',
  port: process.env.DB_PORT || '5432',
  database: process.env.DB_NAME || 'ols_my',
  username: process.env.DB_USERNAME || 'ols_user',
  password: process.env.DB_PASSWORD || 'ols168',
  schema: process.env.DB_SCHEMA || 'ols_schema'
};

// generateAllTestFiles() writes this many .dat files across all tc folders. The
// sequence number is two digits, so a day can host 99 files and no more.
//
// TC3 is the only case that changed size: it used to hold 8 files with no clear
// structure and is now 12 - nine files each carrying exactly one defect of the file
// itself, one file whose name is deliberately wrong, one file whose name has already
// been imported, and one shared file carrying every record-level defect. TC2's 10 files
// are gone: they were 5 valid files (already covered by TC1) plus 5 file-level defects
// (already covered by TC3), and they were never read by any test.
const TOTAL_GENERATED_FILES = 47;
const MAX_SEQUENCE = 99;

// ============ FRESH RECORDS FOR TC1 ============
// TC1 used to replay a hardcoded list, so every run sent the same 17 records and
// passed for the same reason: mcc already held all of them. Randomising alone would
// not help either - the run has to PROVE something, so the records are now new codes
// that mcc does not contain yet, and the batch has to insert them. The seed is
// printed so a run can be replayed exactly with TEST_SEED=<seed>.
function makeRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TC1_RECORD_COUNT = 17;

// Schemes the batch has accepted before. Cycled so that every code below appears
// under exactly one scheme: an input carrying the same code under several schemes
// is what produced the unexplained A/5814 result, and that question is still open.
const TC1_SCHEMES = ['M', 'V', 'C', 'E', 'Z', 'W', 'A'];

// mcc.code is varchar(10) and already carries a synthetic band of 3234 PLC6xxxxxxx
// rows written by this batch. OLST is unused, so new rows are both recognisable as
// test data and certain not to collide.
const TC1_CODE_PREFIX = 'OLST';

async function buildFreshRecords(client, count, random) {
  const { rows } = await client.query(
    'SELECT DISTINCT code FROM mcc WHERE code LIKE $1',
    [`${TC1_CODE_PREFIX}%`]
  );
  const taken = new Set(rows.map(row => row.code));

  const records = [];
  for (let i = 0; i < count; i++) {
    let code;
    do {
      code = TC1_CODE_PREFIX + String(Math.floor(random() * 1000000)).padStart(6, '0');
    } while (taken.has(code));
    taken.add(code);

    records.push({
      scheme: TC1_SCHEMES[i % TC1_SCHEMES.length],
      code,
      desc: `${code} OLSDB020 test`
    });
  }

  return records;
}

// One connection for both reads. Called before cleanOldFiles() on purpose: if the
// ledger cannot be read the run stops here, while the folders from the previous run
// are still intact.
async function readBatchLedger(date, random) {
  const client = new pg.Client({
    host: DB_CONFIG.host,
    port: DB_CONFIG.port,
    user: DB_CONFIG.username,
    password: DB_CONFIG.password,
    database: DB_CONFIG.database
  });

  await client.connect();
  try {
    await client.query(`SET search_path TO ${DB_CONFIG.schema}`);

    const { rows } = await client.query(
      `SELECT max(substring(logical_filename from 'OLSMCC-[0-9]{8}-([0-9]{2})')::int) AS max_seq
         FROM batch_resource
        WHERE logical_filename LIKE $1`,
      [`OLSMCC-${date}-%`]
    );

    const maxSeq = rows[0].max_seq === null ? 0 : Number(rows[0].max_seq);
    const firstSeq = maxSeq + 1;

    console.log(`📒 OLSMCC-${date}-*: highest sequence already imported = ${maxSeq}, starting at ${firstSeq}`);

    if (firstSeq + TOTAL_GENERATED_FILES - 1 > MAX_SEQUENCE) {
      throw new Error(
        `No free file numbers left for ${date}: the generator needs up to ${TOTAL_GENERATED_FILES} ` +
        `numbers starting at ${firstSeq}, but they only go up to ${MAX_SEQUENCE}. ` +
        `Wait for the next day, or ask the batch team to clear today's rows from batch_resource.`
      );
    }

    const records = await buildFreshRecords(client, TC1_RECORD_COUNT, random);
    console.log(`🎲 TC1 records: ${records[0].code} .. ${records[records.length - 1].code} (none of them exist in mcc yet)`);

    return { firstSeq, maxSeq, records };
  } finally {
    await client.end();
  }
}

console.log('========================================');
console.log('FILE GENERATOR STARTED - OLSMCC');
console.log('========================================');
console.log('Current directory:', process.cwd());
console.log('========================================\n');

// ============ HELPER FUNCTIONS ============
export function getCurrentDate() {
  const now = new Date();
  return now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
}

function getDateWithOffset(offsetDays = 0) {
  const now = new Date();
  now.setDate(now.getDate() + offsetDays);
  return now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
}

function getMccOffset() {
  const timestamp = Date.now();
  const offset = timestamp % 1000000;
  console.log(`🕐 Timestamp: ${timestamp}, Offset: ${offset}`);
  return offset;
}

export function generateFileName(sequenceNo, date = null) {
  const currentDate = date || getCurrentDate();
  const seq = String(sequenceNo).padStart(2, '0');
  return `OLSMCC-${currentDate}-${seq}.dat`;
}

function generateHeaderSeq(sequenceNo) {
  return String(sequenceNo).padStart(4, '0');
}

function generateMcc(counter) {
  return String(1000 + (counter % 9000));
}

const SCHEMES = ['???', 'J', 'M', 'V', 'C', 'GPN', 'QRIS'];

const MCC_DESCRIPTIONS = {
  '5411': 'Grocery stores, supermarkets',
  '5812': 'Eating places, restaurants',
  '5541': 'Service stations',
  '4121': 'Taxicabs and limousines',
  '0742': 'Veterinary services',
  '5732': 'Electronic sales',
  '5814': 'Fast food restaurants',
  '5912': 'Drug stores, pharmacies',
  '5942': 'Book stores',
  '7011': 'Lodging, hotels, motels'
};

function getMccDescription(mcc) {
  return MCC_DESCRIPTIONS[mcc] || `MCC ${mcc}`;
}

const FILE_ID = 'OLSMCC';
const RECEIVING_SYSTEM = 'OLS';
const CRLF = '\r\n';

// Only the files are deleted - the tc1..tc10 folders are left in place and simply
// written over. Removing the folders is what kept breaking the run: deleting a
// folder is a two step operation (empty it, then rmdir it) and the second step can
// fail with EPERM on Windows, so tc1 ended up empty while tc2..tc10 still held the
// previous run's files. The generator then died, the test found 0 .dat files in tc1,
// uploaded nothing, and the batch re-processed whatever was still on the server.
// writeFile() calls ensureDirSync on every write, so the folders do not need to be
// recreated here.
async function cleanOldFiles(testDataPath) {
  console.log('\n🧹 Cleaning old generated files...');

  if (!(await fs.pathExists(testDataPath))) {
    console.log('📁 No existing generated files to clean.\n');
    return;
  }

  let removed = 0;
  const leftovers = [];

  async function emptyDirectory(dir) {
    for (const entry of await fs.readdir(dir)) {
      const entryPath = path.join(dir, entry);
      if ((await fs.stat(entryPath)).isDirectory()) {
        await emptyDirectory(entryPath);
        continue;
      }

      try {
        await fs.remove(entryPath);
        removed++;
      } catch (error) {
        // A held handle (antivirus, an editor) clears on its own, so one retry.
        try {
          await fs.remove(entryPath);
          removed++;
        } catch {
          leftovers.push(path.relative(testDataPath, entryPath));
        }
      }
    }
  }

  await emptyDirectory(testDataPath);

  // A file that survived both attempts would be picked up by the next test run as an
  // extra input file, and the failure it causes points nowhere near the real cause.
  if (leftovers.length > 0) {
    throw new Error(
      `Could not delete ${leftovers.length} file(s), still locked by another process: ` +
      `${leftovers.join(', ')}. Close anything holding them (editor, antivirus scan) and run again.`
    );
  }

  console.log(`✅ Cleaned ${removed} old file(s) successfully!\n`);
}

export async function generateAllTestFiles() {
  console.log('📁 Starting file generation...\n');

  const projectRoot = process.cwd();
  const testDataPath = path.join(projectRoot, 'scripts', 'test-data', 'generated', 'OLSDB020');

  console.log(`📂 Project Root: ${projectRoot}`);
  console.log(`📂 Output Path: ${testDataPath}`);
  console.log('='.repeat(60));

  try {
    // Resolved before cleanOldFiles() on purpose: if the ledger cannot be read the
    // run stops here, while the folders from the previous run are still intact.
    const date = getCurrentDate();
    // Different every run, so the records are new every run. TEST_SEED replays a run
    // that failed, which is the only reason the seed is printed at all.
    const seed = Number(process.env.TEST_SEED) || Date.now();
    console.log(`🌱 Seed: ${seed} (replay with TEST_SEED=${seed})`);
    const { firstSeq, maxSeq, records: validRecords } = await readBatchLedger(date, makeRandom(seed));

    await cleanOldFiles(testDataPath);
    fs.ensureDirSync(testDataPath);
    console.log('✅ Directory created/verified');

    console.log(`📅 Date: ${date}`);

    let totalFiles = 0;
    let seqCounter = firstSeq - 1;

    const offset = getMccOffset();
    let mccCounter = offset;
    console.log(`🔢 MCC starting offset: ${offset}`);
    console.log('='.repeat(60));

    // Layout follows the real sample OLSMCC-20250429-03.dat: pipe delimited, CRLF line endings.
    const padTo = (value, width) => String(value).padEnd(width, ' ');
    const padNum = (value, width) => String(value).padStart(width, '0');

    // HD, followed by the two mandatory FN records that declare the DT/TR field names.
    // A file without these two FN records is rejected by the batch.
    function buildFieldNames() {
      return `FN|DT||MCCSCHEME|MERCHANTCATEGORYCODE|MCCDESCRIPTION|${padTo('', 14)}${CRLF}` +
        `FN|TR|||MCC||RECORDCOUNT|${padTo('', 36)}${CRLF}`;
    }

    // Only the HD line, with every field overridable and the delimiter swappable, so a
    // file-level case can make exactly one field wrong and leave the rest well formed.
    function buildHdLine(fileId, receivingSystem, headerSeq, headerDate = null, delimiter = '|') {
      const d = headerDate || date;
      return [
        'HD', padTo(fileId, 10), padTo(receivingSystem, 10), d, padTo('', 8),
        headerSeq, padTo('', 12)
      ].join(delimiter) + CRLF;
    }

    function buildHeader(headerSeq, headerDate = null, fileId = FILE_ID, receivingSystem = RECEIVING_SYSTEM) {
      return buildHdLine(fileId, receivingSystem, headerSeq, headerDate) + buildFieldNames();
    }

    function buildDetail(scheme, mcc, desc = null) {
      const d = (desc !== null && desc !== undefined) ? desc : getMccDescription(mcc);
      return `DT|${scheme}|${mcc}|${d}|${CRLF}`;
    }

    function buildTrailer(recordCount, hash = '0000000000') {
      return `TR||${hash}||${padNum(recordCount, 10)}|${padTo('', 34)}${CRLF}`;
    }

    // The trailer counts every record in the file, not only the DT records:
    // HD + FN|DT + FN|TR + TR = 4 fixed records.
    function totalRecordCount(detailCount) {
      return 4 + detailCount;
    }

    function writeFile(dir, seq, fileDate, content, label) {
      const fileSeq = String(seq).padStart(2, '0');
      const headerSeq = generateHeaderSeq(seq);
      fs.ensureDirSync(dir);
      const filePath = path.join(dir, `OLSMCC-${fileDate}-${fileSeq}.dat`);
      fs.writeFileSync(filePath, content);
      console.log(`   ✅ ${label}: OLSMCC-${fileDate}-${fileSeq}.dat (Header: ${headerSeq})`);
    }

    // ============================================================
    // TC1: All Valid Files (seq 01-04)
    // ============================================================
    // Four files, all valid, each carrying a different set of MCCs (1 + 5 + 4 + 7 = 17
    // distinct codes). Confirmed with the BA: an MCC file is a full refresh, so the LAST
    // file of a run is the one whose contents the system keeps, and every row of mcc that
    // the file being processed does not carry is moved to mcc_his. The three earlier
    // files' records are therefore archived during the same run - by design, and the DB
    // check asserts exactly that rather than treating it as a failure.
    console.log('\n📝 TC1: All Valid Files (01-04)...');
    const tc1Path = path.join(testDataPath, 'tc1');

    // Disjoint slices - no record appears in two files, so the archive step has to move
    // each of the first three files' records on, and only the fourth file's 7 stay live.
    const TC1_FILE_SLICES = [[0, 1], [1, 6], [6, 10], [10, 17]];
    const TC1_FILE_LABELS = [
      'TC1.1 1 record',
      'TC1.2 5 records',
      'TC1.3 4 records',
      'TC1.4 7 records (last file - these stay live)'
    ];

    // Declared here rather than inside the loop: the TC blocks below reuse this variable.
    let content;
    for (let i = 0; i < TC1_FILE_SLICES.length; i++) {
      seqCounter++;
      const [from, to] = TC1_FILE_SLICES[i];
      const recordsForFile = validRecords.slice(from, to);
      content = buildHeader(generateHeaderSeq(seqCounter));
      for (const r of recordsForFile) content += buildDetail(r.scheme, r.code, r.desc);
      content += buildTrailer(totalRecordCount(recordsForFile.length));
      writeFile(tc1Path, seqCounter, date, content, TC1_FILE_LABELS[i]);
      totalFiles++;
    }

    // ============================================================
    // TC3: File-level defects (one file each) and record-level defects (one file)
    // ============================================================
    // Everything here is meant to be refused, so the point is not that the batch says
    // no - it is that it says no to the right thing. A file-level defect has to cost
    // the whole file; a record-level defect has to cost only its own line, with the
    // rest of the file still imported.
    //
    // The record-level file is therefore structurally valid - header, trailer and a
    // matching count - so nothing is refused at file level and every DT line is judged
    // on its own. It also carries valid lines on purpose, including the two duplicate
    // shapes the spec calls legal (TC_01_29, TC_01_30); without them a batch that
    // refused every line would look like a pass.
    console.log('\n📝 TC3: File-level + record-level defects...');
    const tc3Path = path.join(testDataPath, 'tc3');

    // One defect per file, so a rejection can be attributed to it and to nothing else.
    // buildHeader() takes fileId and receivingSystem as arguments precisely so these
    // cases can wrong exactly one of them and leave the rest well formed.
    //
    // Every case here is a defect of the file itself - its header, its trailer or its
    // structure. A defect that belongs to a single line goes in the record-level file
    // below instead, and the batch confirms that split: a truncated detail line and an
    // unknown record type are both judged line by line (BE02 and BE03, the file still
    // accepted and written out), not refused as files.
    //
    // One case per defect, and no two cases may produce the same error code. A file of
    // nothing but a header used to sit here next to the file with a detail line and no
    // trailer; both are missing their TR, so the batch answered BE350 to each and the
    // second file bought nothing. The surviving one is the one that proves more: the
    // batch has to read the detail line and only then find the trailer gone.
    const tc3FileCases = [
      { label: 'empty file', build: () => '' },
      { label: 'header + detail, no trailer', build: (seq) => buildHeader(generateHeaderSeq(seq)) + buildDetail('V', '5411') },
      { label: 'missing header', build: () => buildDetail('V', '5411') + buildTrailer(totalRecordCount(1)) },
      { label: 'wrong fileId', build: (seq) => buildHeader(generateHeaderSeq(seq), null, 'OLSTERM') + buildDetail('V', '5411') + buildTrailer(totalRecordCount(1)) },
      { label: 'wrong receivingSystem', build: (seq) => buildHeader(generateHeaderSeq(seq), null, FILE_ID, 'TOOLS') + buildDetail('V', '5411') + buildTrailer(totalRecordCount(1)) },
      { label: 'wrong delimiter in header', build: (seq) => buildHdLine(FILE_ID, RECEIVING_SYSTEM, generateHeaderSeq(seq), null, '#') + buildFieldNames() + buildDetail('V', '5411') + buildTrailer(totalRecordCount(1)) },
      // These two carry a count that is wrong on purpose, and that wrongness is the whole
      // defect. They call buildTrailer() with a raw number instead of going through
      // totalRecordCount(), so the value they write does not follow the n + 4 rule every
      // well-formed file in the folder follows - which is exactly what makes "0" and "12"
      // look arbitrary next to the "5"s around them.
      //
      // The batch compares the trailer against the number of lines it read, not against
      // the number of DT records (a file of DT + TR only, no header, was told
      // "expected: 2"). So the correct value is always the line count, which for a
      // well-formed file is the record count plus four: HD, the two FN lines and TR.
      { label: 'trailer count 0, should be 5', build: (seq) => buildHeader(generateHeaderSeq(seq)) + buildDetail('V', '5411') + buildTrailer(0) },
      { label: 'trailer count 12, should be 7', build: (seq) => buildHeader(generateHeaderSeq(seq)) + buildDetail('V', '5411') + buildDetail('M', '5812') + buildDetail('J', '5541') + buildTrailer(12) },
      { label: 'invalid createDate format', build: (seq) => buildHeader(generateHeaderSeq(seq), '2026-06-25') + buildDetail('V', '5411') + buildTrailer(totalRecordCount(1)) }
    ];

    for (const c of tc3FileCases) {
      seqCounter++;
      writeFile(tc3Path, seqCounter, date, c.build(seqCounter), `TC3 ${c.label}`);
      totalFiles++;
    }

    // The file name is the defect: OLSMCC-YYYYMMDD.dat carries no -nn sequence number.
    // Written by hand because writeFile() always builds the OLSMCC-<date>-<nn>.dat
    // shape, and no sequence number is consumed for the same reason - the batch never
    // sees this as a numbered file.
    //
    // Its header number has to be one no other file in this run uses. The batch rejected
    // an earlier version of this file with "File Id with number OLSMCC@0033 is duplicated
    // with same date" - the number had been left equal to the record-level file's, so the
    // file was refused for the wrong reason and the name-format case never got tested.
    // Skipping a number leaves the name as the only thing wrong with it.
    {
      const fileName = `OLSMCC-${date}.dat`;
      fs.ensureDirSync(tc3Path);
      fs.writeFileSync(
        path.join(tc3Path, fileName),
        buildHeader(generateHeaderSeq(seqCounter + 2)) + buildDetail('V', '5411') + buildTrailer(totalRecordCount(1))
      );
      console.log(`   ✅ TC3 wrong file name: ${fileName} (header seq ${String(seqCounter + 2).padStart(4, '0')}, unused by any other file)`);
      totalFiles++;
    }

    // The file name has already been imported. maxSeq is the highest number
    // batch_resource holds for today, so that name is guaranteed to be in the ledger
    // and the batch answers it with BE051 ("File ... already exist"). The content is
    // valid on purpose - the name is the only thing under test. No sequence number is
    // consumed either: the whole point is to re-use one, not to take a new one.
    //
    // This is also why the test tolerates a non-zero batch exit. BE051 makes the job
    // throw and the run exit 20, which is exactly the rejection this case is after;
    // see the allowFailure flag on executeBatch() in test-runner.spec.js.
    if (maxSeq < 1) {
      throw new Error(
        `Cannot build the duplicate-name file for ${date}: batch_resource holds no OLSMCC file ` +
        `for today yet, so there is no name to duplicate. Put one file through the batch first ` +
        `(e.g. npx playwright test scripts/OLSDB020/test-runner.spec.js --grep "TC1"), then regenerate.`
      );
    }
    writeFile(
      tc3Path, maxSeq, date,
      buildHeader(generateHeaderSeq(maxSeq)) + buildDetail('V', '5411') + buildTrailer(totalRecordCount(1)),
      `TC3 duplicate file name, re-using the already imported ${maxSeq}`
    );
    totalFiles++;

    // The shared record-level file. Each entry is one line with one defect, except the
    // one marked below, which carries three at once - the batch has to report more than
    // one problem for a single line. Entries holding two lines are the duplicate shapes
    // from TC_01_29 and TC_01_30.
    const tc3RecordLines = [
      // --- one defect per line ---
      { note: 'mccScheme empty (TC_01_10)', line: `DT||5411|Grocery stores|${CRLF}` },
      { note: 'mccScheme longer than 10 (TC_01_12)', line: `DT|1234567890X|5411|Grocery stores|${CRLF}` },
      { note: 'mccScheme wrong case (TC_01_28)', line: `DT|abc|5411|Grocery stores|${CRLF}` },
      { note: 'mccScheme not in master data (TC_01_15)', line: `DT|A2|5411|Grocery stores|${CRLF}` },
      { note: 'hash field missing, no trailing pipe (TC_01_31)', line: `DT|V|5411|Grocery stores${CRLF}` },
      { note: 'code empty', line: `DT|V||Grocery stores|${CRLF}` },
      { note: 'code longer than 10', line: `DT|V|12345678901|Grocery stores|${CRLF}` },
      { note: 'description empty', line: `DT|V|5411||${CRLF}` },
      { note: 'truncated line, one field short (BE02)', line: `DT|V|5411${CRLF}` },
      { note: 'invalid record type XX (BE03)', line: `XX|V|5411|Grocery stores|${CRLF}` },
      // --- three defects on one line ---
      { note: 'mccScheme empty + code longer than 10 + description empty', line: `DT||1234567890X||${CRLF}` },
      // --- valid lines: the control ---
      { note: 'valid: code fills its 10 characters (TC_01_11)', line: `DT|V|1234567890|Ten digit code|${CRLF}` },
      { note: 'valid: same code under two schemes (TC_01_29)', line: `DT|V|OLSR0001|Shared code|${CRLF}DT|M|OLSR0001|Shared code|${CRLF}` },
      { note: 'valid: same scheme with two codes (TC_01_30)', line: `DT|J|OLSR0002|Shared scheme|${CRLF}DT|J|OLSR0003|Shared scheme|${CRLF}` }
    ];

    // Every line the batch judges, not only the DT ones: the XX line is judged like any
    // other record and the trailer count has to include it, or the file fails its own
    // record-count check and nothing inside it gets judged at all.
    const judgedLineCount = tc3RecordLines.reduce((n, r) => n + r.line.split(CRLF).length - 1, 0);

    seqCounter++;
    content = buildHeader(generateHeaderSeq(seqCounter));
    for (const r of tc3RecordLines) content += r.line;
    content += buildTrailer(totalRecordCount(judgedLineCount));
    writeFile(tc3Path, seqCounter, date, content, `TC3 record-level defects (${judgedLineCount} judged lines)`);
    totalFiles++;

    console.log(`   📋 The ${judgedLineCount} judged lines in that file, in order:`);
    for (const r of tc3RecordLines) console.log(`      • ${r.note}`);

    // ============================================================
    // TC4: Parameter/Field Validation
    // ============================================================
    console.log('\n📝 TC4: Parameter/Field Validation...');
    const tc4Path = path.join(testDataPath, 'tc4');

    seqCounter++;
    content = buildHeader(generateHeaderSeq(seqCounter));
    for (const s of SCHEMES) content += buildDetail(s, generateMcc(mccCounter++));
    content += buildTrailer(totalRecordCount(SCHEMES.length));
    writeFile(tc4Path, seqCounter, date, content, 'TC4.1 all schemes');
    totalFiles++;

    seqCounter++;
    writeFile(tc4Path, seqCounter, date, buildHeader(generateHeaderSeq(seqCounter)) + buildDetail('X', '5411') + buildTrailer(totalRecordCount(1)), 'TC4.2 invalid scheme');
    totalFiles++;

    seqCounter++;
    writeFile(tc4Path, seqCounter, date, buildHeader(generateHeaderSeq(seqCounter)) + `DT|V||Grocery stores                                    |     \n` + buildTrailer(totalRecordCount(1)), 'TC4.3 empty MCC');
    totalFiles++;

    seqCounter++;
    writeFile(tc4Path, seqCounter, date, buildHeader(generateHeaderSeq(seqCounter)) + `DT|V|5411|                                        |     \n` + buildTrailer(totalRecordCount(1)), 'TC4.4 empty desc');
    totalFiles++;

    seqCounter++;
    writeFile(tc4Path, seqCounter, date, buildHeader(generateHeaderSeq(seqCounter)) + `DT|V|5411|                                         |     \n` + buildTrailer(totalRecordCount(1)), 'TC4.5 single space');
    totalFiles++;

    seqCounter++;
    writeFile(tc4Path, seqCounter, date, buildHeader(generateHeaderSeq(seqCounter)) + `DT|V|5411|5411                                        |     \n` + buildTrailer(totalRecordCount(1)), 'TC4.6 desc copy');
    totalFiles++;

    seqCounter++;
    content = buildHeader(generateHeaderSeq(seqCounter));
    for (let i = 0; i < 6; i++) content += buildDetail(SCHEMES[i % SCHEMES.length], generateMcc(mccCounter++));
    content += `DT|X|5732|Invalid scheme                                  |     \n`;
    content += `DT|V||Invalid empty MCC                               |     \n`;
    content += `DT|V|5912|                                        |     \n`;
    content += `DT|M|7011|                                          |     \n`;
    content += buildTrailer(totalRecordCount(10));
    writeFile(tc4Path, seqCounter, date, content, 'TC4.7 mixed 6v+4i');
    totalFiles++;

    // ============================================================
    // TC5: 10 Valid + 10 Invalid in One File
    // ============================================================
    console.log('\n📝 TC5: 10 Valid + 10 Invalid in One File...');
    const tc5Path = path.join(testDataPath, 'tc5');

    seqCounter++;
    content = buildHeader(generateHeaderSeq(seqCounter));
    for (let i = 0; i < 10; i++) {
      content += buildDetail(SCHEMES[i % SCHEMES.length], generateMcc(mccCounter++));
    }
    content += `DT|X|5732|Invalid scheme                                  |     \n`;   // I1 invalid scheme
    content += `DT||7011|Missing scheme                                  |     \n`;   // I2 missing scheme
    content += `DT|V||Missing MCC                                     |     \n`;   // I3 empty MCC
    content += `DT|V|5912|                                        |     \n`;   // I4 empty desc
    content += `DT|V|ABCD|Non-numeric MCC                               |     \n`;   // I5 non-numeric
    content += `DT|V|12345678901|MCC too long                                   |     \n`;   // I6 MCC>10
    content += `DT|V|5541|This description is intentionally far too long to fit in 40 char|     \n`;   // I7 desc>40
    content += `DT|V|5411|Duplicate MCC                                    |     \n`;   // I8 duplicate
    content += `DT|MASTER|0742|Unsupported scheme                               |     \n`;   // I9 unsupported
    content += `DT|V|4121|Truncated                                      |     \n`;   // I10 truncated
    content += buildTrailer(22);
    writeFile(tc5Path, seqCounter, date, content, 'TC5 10 valid + 10 invalid');
    totalFiles++;

    // ============================================================
    // TC6: Error Recovery
    // ============================================================
    console.log('\n📝 TC6: Error Recovery...');
    const tc6Path = path.join(testDataPath, 'tc6');

    seqCounter++;
    content = buildHeader(generateHeaderSeq(seqCounter));
    content += buildDetail('V', '5411');                              // valid
    content += `DT|X|5732|Invalid scheme                                  |     \n`;  // invalid
    content += buildDetail('M', '5812');                              // valid - continue
    content += `DT|V||Empty MCC                                      |     \n`;  // invalid
    content += buildDetail('J', '5541');                              // valid - continue
    content += `DT|V|ABCD|Non-numeric                                  |     \n`;  // invalid
    content += buildDetail('C', '0742');                              // valid - continue
    content += buildDetail('GPN', '5732');                            // valid
    content += buildTrailer(totalRecordCount(8));
    writeFile(tc6Path, seqCounter, date, content, 'TC6.1 error then recovery');
    totalFiles++;

    seqCounter++;
    content = buildHeader(generateHeaderSeq(seqCounter));
    content += buildDetail('V', '5411');
    content += buildDetail('M', '5812');
    content += buildDetail('V', '5411'); // duplicate
    content += buildDetail('J', '5541');
    content += buildTrailer(totalRecordCount(4));
    writeFile(tc6Path, seqCounter, date, content, 'TC6.2 duplicate MCC in file');
    totalFiles++;

    // ============================================================
    // TC7: Boundary & Length Validation
    // ============================================================
    console.log('\n📝 TC7: Boundary & Length Validation...');
    const tc7Path = path.join(testDataPath, 'tc7');

    const tc7Records = [
      { label: 'TC7.1 max length', line: `DT|QRIS|1234|1234567890123456789012345678901234567890|     \n` },
      { label: 'TC7.2 desc > 40', line: `DT|V|5411|This description is way too long and exceeds forty characters limit here!!|     \n` },
      { label: 'TC7.3 MCC 10 chars', line: `DT|V|1234567890|Ten digit MCC                                 |     \n` },
      { label: 'TC7.4 MCC > 10', line: `DT|V|12345678901|Over ten digits                                 |     \n` },
      { label: 'TC7.5 desc 40 chars', line: `DT|V|5411|1234567890123456789012345678901234567890|     \n` },
      { label: 'TC7.6 special chars', line: `DT|V|5411|Special @#$%^&* characters                       |     \n` },
      { label: 'TC7.7 filler non-space', line: `DT|V|5411|Grocery stores                                    |XXXXX\n` },
      { label: 'TC7.8 special desc', line: `DT|V|5411|Special @#$% characters                            |     \n` }
    ];

    for (const rec of tc7Records) {
      seqCounter++;
      writeFile(tc7Path, seqCounter, date, buildHeader(generateHeaderSeq(seqCounter)) + rec.line + buildTrailer(totalRecordCount(1)), rec.label);
      totalFiles++;
    }

    // ============================================================
    // TC8: Data Integrity & Duplicates
    // ============================================================
    console.log('\n📝 TC8: Data Integrity & Duplicates...');
    const tc8Path = path.join(testDataPath, 'tc8');

    seqCounter++;
    writeFile(tc8Path, seqCounter, date, buildHeader(generateHeaderSeq(seqCounter)) + buildDetail('V', '5411') + buildDetail('M', '5812') + buildDetail('V', '5411') + buildTrailer(totalRecordCount(3)), 'TC8.1 dup same scheme');
    totalFiles++;

    seqCounter++;
    writeFile(tc8Path, seqCounter, date, buildHeader(generateHeaderSeq(seqCounter)) + buildDetail('V', '5411') + buildDetail('M', '5411') + buildTrailer(totalRecordCount(2)), 'TC8.2 same MCC diff scheme');
    totalFiles++;

    seqCounter++;
    writeFile(tc8Path, seqCounter, date, buildHeader(generateHeaderSeq(seqCounter)) + buildDetail('V', '5411', 'Updated grocery description') + buildTrailer(totalRecordCount(1)), 'TC8.3 update desc');
    totalFiles++;

    seqCounter++;
    writeFile(tc8Path, seqCounter, date, buildHeader(generateHeaderSeq(seqCounter)) + buildDetail('V', '5411') + buildDetail('M', '5411') + buildDetail('J', '5411') + buildTrailer(totalRecordCount(3)), 'TC8.4 re-add existing');
    totalFiles++;

    // ============================================================
    // TC9: Date Validation
    // ============================================================
    console.log('\n📝 TC9: Date Validation...');
    const tc9Path = path.join(testDataPath, 'tc9');

    const today = date;
    const tomorrow = getDateWithOffset(1);
    const pastDate = getDateWithOffset(-30);
    const futureDate = getDateWithOffset(30);

    seqCounter++;
    writeFile(tc9Path, seqCounter, today, buildHeader(generateHeaderSeq(seqCounter), today) + buildDetail('V', '5411') + buildDetail('M', '5812') + buildTrailer(totalRecordCount(2)), 'TC9.1 equal date');
    totalFiles++;

    seqCounter++;
    writeFile(tc9Path, seqCounter, tomorrow, buildHeader(generateHeaderSeq(seqCounter), tomorrow) + buildDetail('J', '5541') + buildDetail('C', '0742') + buildTrailer(totalRecordCount(2)), 'TC9.2 larger date');
    totalFiles++;

    seqCounter++;
    writeFile(tc9Path, seqCounter, pastDate, buildHeader(generateHeaderSeq(seqCounter), pastDate) + buildDetail('V', '5411') + buildDetail('M', '5812') + buildTrailer(totalRecordCount(2)), 'TC9.3 smaller date');
    totalFiles++;

    seqCounter++;
    writeFile(tc9Path, seqCounter, futureDate, buildHeader(generateHeaderSeq(seqCounter), futureDate) + buildDetail('GPN', '5732') + buildDetail('QRIS', '5814') + buildTrailer(totalRecordCount(2)), 'TC9.4 future date');
    totalFiles++;

    // ============================================================
    // TC10: File Naming Convention
    // ============================================================
    console.log('\n📝 TC10: File Naming Convention...');
    const tc10Path = path.join(testDataPath, 'tc10');

    seqCounter++;
    writeFile(tc10Path, seqCounter, date, buildHeader(generateHeaderSeq(seqCounter)) + buildDetail('V', '5411') + buildDetail('M', '5812') + buildTrailer(totalRecordCount(2)), 'TC10.1 correct name');
    totalFiles++;

    seqCounter++;
    {
      const fileSeq = String(seqCounter).padStart(2, '0');
      fs.ensureDirSync(tc10Path);
      const filePath = path.join(tc10Path, `OLSTERM-${date}-${fileSeq}.dat`);
      const c = buildHeader(generateHeaderSeq(seqCounter)) + buildDetail('V', '5411') + buildDetail('M', '5812') + buildTrailer(totalRecordCount(2));
      fs.writeFileSync(filePath, c);
      console.log(`   ✅ TC10.2 wrong prefix: OLSTERM-${date}-${fileSeq}.dat`);
    }
    totalFiles++;

    seqCounter++;
    {
      const filePath = path.join(tc10Path, `OLSMCC-${date}-.dat`);
      const c = buildHeader(generateHeaderSeq(seqCounter)) + buildDetail('V', '5411') + buildDetail('M', '5812') + buildTrailer(totalRecordCount(2));
      fs.writeFileSync(filePath, c);
      console.log(`   ✅ TC10.3 missing seq: OLSMCC-${date}-.dat`);
    }
    totalFiles++;

    seqCounter++;
    {
      fs.ensureDirSync(tc10Path);
      const filePath = path.join(tc10Path, `OLSMCC-2026-06-25-${String(seqCounter).padStart(2, '0')}.dat`);
      const c = buildHeader(generateHeaderSeq(seqCounter)) + buildDetail('V', '5411') + buildDetail('M', '5812') + buildTrailer(totalRecordCount(2));
      fs.writeFileSync(filePath, c);
      console.log(`   ✅ TC10.4 wrong date: OLSMCC-2026-06-25-${String(seqCounter).padStart(2, '0')}.dat`);
    }
    totalFiles++;

    seqCounter++;
    {
      const fileSeq = String(seqCounter).padStart(2, '0');
      const fileName = `OLSMCC-${date}-${fileSeq}.dat`;
      const filePath = path.join(tc10Path, fileName);
      const c = buildHeader(generateHeaderSeq(seqCounter)) + buildDetail('V', '5411') + buildDetail('M', '5812') + buildTrailer(totalRecordCount(2));
      fs.writeFileSync(filePath, c);
      console.log(`   ✅ TC10.5 seq ${fileSeq}: ${fileName}`);
    }
    totalFiles++;

    // ============================================================
    // SUMMARY
    // ============================================================
    console.log('\n' + '='.repeat(60));
    console.log(`\n📊 Total files generated: ${totalFiles}`);
    console.log(`📊 Total unique MCCs generated: ${mccCounter - offset}`);
    console.log(`📁 Location: ${testDataPath}`);
    console.log(`\n📂 Folder Structure:`);
    // The counts are of files that take a fresh sequence number, which is not the same
    // as the number of files in the folder: tc3 also holds one file whose name re-uses
    // an already imported number (so it takes none) and one whose name has no number in
    // it at all.
    const folderLayout = [
      ['tc1', 4], ['tc3', 10], ['tc4', 7], ['tc5', 1],
      ['tc6', 2], ['tc7', 8], ['tc8', 4], ['tc9', 4], ['tc10', 5]
    ];
    let nextSeq = firstSeq;
    for (const [folder, count] of folderLayout) {
      const from = String(nextSeq).padStart(2, '0');
      const to = String(nextSeq + count - 1).padStart(2, '0');
      console.log(`   ├── ${folder}/  (${count} numbered file${count > 1 ? 's' : ''}: ${from}-${to})`);
      nextSeq += count;
    }
    console.log(`   ├── tc3/  also holds OLSMCC-${date}-${String(maxSeq).padStart(2, '0')}.dat (duplicate name, re-uses ${maxSeq})`);
    console.log(`   └── tc3/  also holds OLSMCC-${date}.dat (no sequence number)`);
    console.log('\n✅ All files generated successfully!\n');

    return totalFiles;

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error.stack);
    throw error;
  }
}

console.log('🚀 Starting file generator (always runs)...');

generateAllTestFiles()
  .then(() => {
    console.log('✅ Generation completed successfully!');
  })
  .catch((error) => {
    console.error('❌ Generation failed:', error);
    process.exit(1);
  });

export default {
  getCurrentDate,
  generateFileName,
  generateAllTestFiles
};
