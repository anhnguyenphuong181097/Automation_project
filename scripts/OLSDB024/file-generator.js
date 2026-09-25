// scripts/file-generator.js
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('========================================');
console.log('FILE GENERATOR STARTED');
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

// ============ GENERATE UNIQUE STARTING OFFSET ============
function getTerminalOffset() {
  // Use timestamp to ensure unique IDs for every run
  const timestamp = Date.now();
  // Take last 6 digits of timestamp (range: 000000-999999)
  const offset = timestamp % 1000000;
  console.log(`🕐 Timestamp: ${timestamp}, Offset: ${offset}`);
  return offset;
}

// ============ FILE NAME: 2-digit sequence (01-99) ============
export function generateFileName(sequenceNo, date = null) {
  const currentDate = date || getCurrentDate();
  const seq = String(sequenceNo).padStart(2, '0');
  return `OLSTERM-${currentDate}-${seq}.dat`;
}

// ============ HEADER SEQUENCE: 4-digit (0001-9999) ============
function generateHeaderSeq(sequenceNo) {
  return String(sequenceNo).padStart(4, '0');
}

// ============ TERMINAL ID: Unique 8-character ID ============
function generateTerminalId(counter) {
  // Format: TM + 6 digits (TM000001, TM000002, ..., TM999999)
  // Total: 8 characters (TM + 6 digits = 8)
  return `TM${String(counter).padStart(6, '0')}`;
}

// ============ CONSTANT: Store ID ============
const STORE_ID = 'DONOTDELETE';

// ============ CLEAN OLD FILES ============
async function cleanOldFiles(testDataPath) {
  console.log('\n🧹 Cleaning old generated files...');
  
  try {
    // Check if the directory exists
    if (await fs.pathExists(testDataPath)) {
      // Get all items in the directory
      const items = await fs.readdir(testDataPath);
      
      if (items.length === 0) {
        console.log('📁 No old files to clean.\n');
        return;
      }
      
      // Remove all subdirectories and their contents
      let removedCount = 0;
      for (const item of items) {
        const itemPath = path.join(testDataPath, item);
        const stats = await fs.stat(itemPath);
        
        if (stats.isDirectory()) {
          await fs.remove(itemPath);
          console.log(`   ✅ Removed directory: ${item}`);
          removedCount++;
        } else {
          // Remove any stray files
          await fs.remove(itemPath);
          console.log(`   ✅ Removed file: ${item}`);
          removedCount++;
        }
      }
      
      console.log(`✅ Cleaned ${removedCount} old items successfully!\n`);
    } else {
      console.log('📁 No existing generated files to clean.\n');
    }
  } catch (error) {
    console.error('❌ Error cleaning old files:', error.message);
    throw error;
  }
}

// ============ GENERATE ALL TEST FILES ============
export async function generateAllTestFiles() {
  console.log('📁 Starting file generation...\n');

  const projectRoot = process.cwd();
  const testDataPath = path.join(projectRoot, 'scripts' ,'test-data', 'generated', 'OLSDB024');

  console.log(`📂 Project Root: ${projectRoot}`);
  console.log(`📂 Output Path: ${testDataPath}`);
  console.log('='.repeat(60));

  try {
    // ============ CLEAN OLD FILES FIRST ============
    await cleanOldFiles(testDataPath);
    
    // Ensure the directory exists (it will be created fresh)
    fs.ensureDirSync(testDataPath);
    console.log('✅ Directory created/verified');

    const date = getCurrentDate();
    console.log(`📅 Date: ${date}`);

    let totalFiles = 0;
    let seqCounter = 0;
    
    // 🔥 FIX: Start terminal counter from a unique offset
    const offset = getTerminalOffset();
    let terminalCounter = offset;
    console.log(`🔢 Terminal ID starting offset: ${offset} (TM${String(offset).padStart(6, '0')})`);
    console.log(`🔢 This run will generate IDs from TM${String(offset + 1).padStart(6, '0')} onwards`);
    console.log('='.repeat(60));

    // ============ HELPER: Build Trailer with Total Records ============
    function buildTrailer(recordCount) {
      const totalRecords = 1 + 2 + recordCount + 1;
      return `TR|||||${totalRecords}|\n`;
    }

    // ============================================================
    // TC1: All Valid Files (seq 01-10) - 10 files
    // Header: 0001-0010
    // ============================================================
    console.log('\n📝 TC1: All Valid Files (01-10)...');
    const tc1Path = path.join(testDataPath, 'tc1');
    fs.ensureDirSync(tc1Path);

    for (let i = 1; i <= 10; i++) {
      seqCounter++;
      const fileSeq = String(seqCounter).padStart(2, '0');
      const headerSeq = String(seqCounter).padStart(4, '0');
      const fileName = `OLSTERM-${date}-${fileSeq}.dat`;
      const filePath = path.join(tc1Path, fileName);
      const recordCount = i;

      let content = `HD|OLSTERM |OLS       |${date}|        |${headerSeq}|           \n`;
      content += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
      content += `FN|TR|recordCount|filler \n`;

      for (let j = 0; j < recordCount; j++) {
        terminalCounter++;
        const flag = j % 3 === 0 ? 'A' : (j % 3 === 1 ? 'U' : 'D');
        const status = j % 2 === 0 ? 'A' : 'I';
        const terminalId = generateTerminalId(terminalCounter);
        content += `DT|${flag}|${STORE_ID}|${terminalId}|${status}|\n`;
      }

      content += buildTrailer(recordCount);

      fs.writeFileSync(filePath, content);
      console.log(`   ✅ TC1: ${fileName} (Header: ${headerSeq}, ${recordCount} DT records, Terminal IDs: TM${String(terminalCounter - recordCount + 1).padStart(6, '0')}-TM${String(terminalCounter).padStart(6, '0')})`);
      totalFiles++;
    }

    // ============================================================
    // TC2: 5 Valid + 5 Invalid Files (seq 11-20) - 10 files
    // Header: 0011-0020
    // ============================================================
    console.log('\n📝 TC2: 5 Valid + 5 Invalid Files (11-20)...');
    const tc2Path = path.join(testDataPath, 'tc2');
    fs.ensureDirSync(tc2Path);

    // 5 Valid files (seq 11-15)
    for (let i = 1; i <= 5; i++) {
      seqCounter++;
      const fileSeq = String(seqCounter).padStart(2, '0');
      const headerSeq = String(seqCounter).padStart(4, '0');
      const fileName = `OLSTERM-${date}-${fileSeq}.dat`;
      const filePath = path.join(tc2Path, fileName);
      const count = i;

      let content = `HD|OLSTERM |OLS       |${date}|        |${headerSeq}|           \n`;
      content += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
      content += `FN|TR|recordCount|filler \n`;

      for (let j = 0; j < count; j++) {
        terminalCounter++;
        const flag = j % 2 === 0 ? 'A' : 'U';
        const terminalId = generateTerminalId(terminalCounter);
        content += `DT|${flag}|${STORE_ID}|${terminalId}|A|\n`;
      }

      content += buildTrailer(count);

      fs.writeFileSync(filePath, content);
      console.log(`   ✅ TC2: ${fileName} (Header: ${headerSeq}, ${count} DT records - VALID)`);
      totalFiles++;
    }

    // 5 Invalid files (seq 16-20)
    const invalidContents = [
      {
        desc: 'Missing header',
        content: (tc) => `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nFN|TR|recordCount|filler \nDT|A|${STORE_ID}|${generateTerminalId(tc)}|A|\nTR|||||3|\n`
      },
      {
        desc: 'Missing trailer',
        content: (tc) => `HD|OLSTERM |OLS       |${date}|        |${String(tc).padStart(4, '0')}|           \nFN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nFN|TR|recordCount|filler \nDT|A|${STORE_ID}|${generateTerminalId(tc)}|A|\nDT|U|${STORE_ID}|${generateTerminalId(tc + 1)}|I|\n`
      },
      {
        desc: 'Count mismatch',
        content: (tc) => `HD|OLSTERM |OLS       |${date}|        |${String(tc).padStart(4, '0')}|           \nFN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nFN|TR|recordCount|filler \nDT|A|${STORE_ID}|${generateTerminalId(tc)}|A|\nDT|U|${STORE_ID}|${generateTerminalId(tc + 1)}|I|\nDT|D|${STORE_ID}|${generateTerminalId(tc + 2)}|A|\nTR|||||9|\n`
      },
      {
        desc: 'Invalid flag X',
        content: (tc) => `HD|OLSTERM |OLS       |${date}|        |${String(tc).padStart(4, '0')}|           \nFN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nFN|TR|recordCount|filler \nDT|X|${STORE_ID}|${generateTerminalId(tc)}|A|\nTR|||||4|\n`
      },
      {
        desc: 'Invalid status Z',
        content: (tc) => `HD|OLSTERM |OLS       |${date}|        |${String(tc).padStart(4, '0')}|           \nFN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nFN|TR|recordCount|filler \nDT|A|${STORE_ID}|${generateTerminalId(tc)}|Z|\nTR|||||4|\n`
      }
    ];

    for (let i = 0; i < invalidContents.length; i++) {
      seqCounter++;
      const fileSeq = String(seqCounter).padStart(2, '0');
      const headerSeq = String(seqCounter).padStart(4, '0');
      const fileName = `OLSTERM-${date}-${fileSeq}.dat`;
      const filePath = path.join(tc2Path, fileName);

      terminalCounter++;
      const content = invalidContents[i].content(terminalCounter);

      fs.writeFileSync(filePath, content);
      console.log(`   ✅ TC2: ${fileName} (Header: ${headerSeq}, ${invalidContents[i].desc} - INVALID)`);
      totalFiles++;
    }

    // ============================================================
    // TC3: All Invalid Files (seq 21-30)
    // ============================================================
    console.log('\n📝 TC3: All Invalid Files (21-30)...');
    const tc3Path = path.join(testDataPath, 'tc3');
    fs.ensureDirSync(tc3Path);

    const invalidFileContents = [
      {
        desc: 'Empty file',
        content: () => ''
      },
      {
        desc: 'Only header',
        content: (seq) => `HD|OLSTERM |OLS       |${date}|        |${seq}|           \n`
      },
      {
        desc: 'Header + field names',
        content: (seq) => `HD|OLSTERM |OLS       |${date}|        |${seq}|           \nFN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nFN|TR|recordCount|filler \n`
      },
      {
        desc: 'No trailer',
        content: (seq, term1, term2) => `HD|OLSTERM |OLS       |${date}|        |${seq}|           \nFN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nFN|TR|recordCount|filler \nDT|A|${STORE_ID}|${term1}|A|\nDT|U|${STORE_ID}|${term2}|I|\n`
      },
      {
        desc: 'No field names',
        content: (seq, term1) => `HD|OLSTERM |OLS       |${date}|        |${seq}|           \nDT|A|${STORE_ID}|${term1}|A|\nTR|||||4|\n`
      },
      {
        desc: 'Wrong date',
        content: (seq, term1) => `HD|OLSTERM |OLS       |2026-06-25|        |${seq}|           \nFN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nFN|TR|recordCount|filler \nDT|A|${STORE_ID}|${term1}|A|\nTR|||||4|\n`
      },
      {
        desc: 'Wrong delimiter',
        content: (seq, term1) => `HD|OLSTERM |OLS       |${date}#        #${seq}#           \nFN|DT||atypUpdateFlag#aStoreId#aTerminalId#aTermSts#filler\nFN|TR|recordCount|filler \nDT|A|${STORE_ID}|${term1}|A|\nTR|||||4|\n`
      },
      {
        desc: 'Wrong record type',
        content: (seq, term1) => `HD|OLSTERM |OLS       |${date}|        |${seq}|           \nXX|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nXX|TR|recordCount|filler \nDT|A|${STORE_ID}|${term1}|A|\nTR|||||4|\n`
      },
      {
        desc: 'Negative count',
        content: (seq, term1) => `HD|OLSTERM |OLS       |${date}|        |${seq}|           \nFN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nFN|TR|recordCount|filler \nDT|A|${STORE_ID}|${term1}|A|\nTR|||||-1|\n`
      },
      {
        desc: 'Missing fields',
        content: (seq, term1) => `HD|OLSTERM |OLS       |${date}|        |${seq}|           \nFN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nFN|TR|recordCount|filler \nDT|A|${STORE_ID}|${term1}|\nTR|||||4|\n`
      }
    ];

    for (let i = 0; i < invalidFileContents.length; i++) {
      seqCounter++;
      const fileSeq = String(seqCounter).padStart(2, '0');
      const headerSeq = String(seqCounter).padStart(4, '0');
      const fileName = `OLSTERM-${date}-${fileSeq}.dat`;
      const filePath = path.join(tc3Path, fileName);

      terminalCounter++;
      const term1 = generateTerminalId(terminalCounter);
      terminalCounter++;
      const term2 = generateTerminalId(terminalCounter);

      let content;
      if (i === 3) {
        content = invalidFileContents[i].content(headerSeq, term1, term2);
      } else if (i === 0) {
        content = invalidFileContents[i].content();
      } else {
        content = invalidFileContents[i].content(headerSeq, term1);
      }

      fs.writeFileSync(filePath, content);
      console.log(`   ✅ TC3: ${fileName} (Header: ${headerSeq}, ${invalidFileContents[i].desc})`);
      totalFiles++;
    }

    // ============================================================
    // TC4A: 10 Valid + 10 Invalid (seq 31)
    // Header: 0031
    // ============================================================
    console.log('\n📝 TC4A: Valid + Invalid in Same File (31)...');
    const tc4aPath = path.join(testDataPath, 'tc4A');
    fs.ensureDirSync(tc4aPath);

    seqCounter++;
    const fileSeq31 = String(seqCounter).padStart(2, '0');
    const headerSeq31 = String(seqCounter).padStart(4, '0');
    const filePath31 = path.join(tc4aPath, `OLSTERM-${date}-${fileSeq31}.dat`);

    let content4a = `HD|OLSTERM |OLS       |${date}|        |${headerSeq31}|           \n`;
    content4a += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
    content4a += `FN|TR|recordCount|filler \n`;

    for (let i = 0; i < 10; i++) {
      terminalCounter++;
      const flag = i % 3 === 0 ? 'A' : (i % 3 === 1 ? 'U' : 'D');
      const status = i % 2 === 0 ? 'A' : 'I';
      const terminalId = generateTerminalId(terminalCounter);
      content4a += `DT|${flag}|${STORE_ID}|${terminalId}|${status}|\n`;
    }

    for (let i = 0; i < 10; i++) {
      terminalCounter++;
      const terminalId = generateTerminalId(terminalCounter);
      if (i === 0) {
        content4a += `DT|X|${STORE_ID}|${terminalId}|A|\n`;
      } else if (i === 1) {
        content4a += `DT|A||${terminalId}|A|\n`;
      } else if (i === 2) {
        content4a += `DT|A|${STORE_ID}||A|\n`;
      } else if (i === 3) {
        content4a += `DT|A|${STORE_ID}|${terminalId}|Z|\n`;
      } else {
        content4a += `DT|A|${STORE_ID}|${terminalId}|A|\n`;
      }
    }

    content4a += buildTrailer(20);

    fs.writeFileSync(filePath31, content4a);
    console.log(`   ✅ TC4A: OLSTERM-${date}-${fileSeq31}.dat (Header: ${headerSeq31}, 20 DT records)`);
    totalFiles++;

    // ============================================================
    // TC4B: Alternating Pattern (seq 32)
    // Header: 0032
    // ============================================================
    console.log('\n📝 TC4B: Alternating Pattern (32)...');
    const tc4bPath = path.join(testDataPath, 'tc4B');
    fs.ensureDirSync(tc4bPath);

    seqCounter++;
    const fileSeq32 = String(seqCounter).padStart(2, '0');
    const headerSeq32 = String(seqCounter).padStart(4, '0');
    const filePath32 = path.join(tc4bPath, `OLSTERM-${date}-${fileSeq32}.dat`);

    let content4b = `HD|OLSTERM |OLS       |${date}|        |${headerSeq32}|           \n`;
    content4b += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
    content4b += `FN|TR|recordCount|filler \n`;

    const records4b = [
      { flag: 'A', status: 'A' },
      { flag: 'X', status: 'A' },
      { flag: 'A', status: 'I' },
      { flag: 'U', status: 'Z' },
      { flag: 'A', status: 'A' },
      { flag: 'D', status: 'A' },
      { flag: 'A', status: 'I' },
      { flag: 'A', status: 'A' },
      { flag: 'A', status: 'A' },
      { flag: 'U', status: 'I' }
    ];

    for (const record of records4b) {
      terminalCounter++;
      const terminalId = generateTerminalId(terminalCounter);
      const storeId = record.flag === 'X' ? '' : STORE_ID;
      content4b += `DT|${record.flag}|${storeId}|${terminalId}|${record.status}|\n`;
    }

    content4b += buildTrailer(10);

    fs.writeFileSync(filePath32, content4b);
    console.log(`   ✅ TC4B: OLSTERM-${date}-${fileSeq32}.dat (Header: ${headerSeq32}, 10 DT records)`);
    totalFiles++;

    // ============================================================
    // TC4C: Boundary + Invalid (seq 33)
    // Header: 0033
    // ============================================================
    console.log('\n📝 TC4C: Boundary + Invalid Combo (33)...');
    const tc4cPath = path.join(testDataPath, 'tc4C');
    fs.ensureDirSync(tc4cPath);

    seqCounter++;
    const fileSeq33 = String(seqCounter).padStart(2, '0');
    const headerSeq33 = String(seqCounter).padStart(4, '0');
    const filePath33 = path.join(tc4cPath, `OLSTERM-${date}-${fileSeq33}.dat`);

    let content4c = `HD|OLSTERM |OLS       |${date}|        |${headerSeq33}|           \n`;
    content4c += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
    content4c += `FN|TR|recordCount|filler \n`;

    terminalCounter++;
    content4c += `DT|A|${STORE_ID}|${generateTerminalId(terminalCounter)}|A|\n`;
    terminalCounter++;
    content4c += `DT|U|${STORE_ID}|${generateTerminalId(terminalCounter)}|I|\n`;
    content4c += `DT|A|||A|\n`;
    content4c += `DT|U|||I|\n`;
    terminalCounter++;
    content4c += `DT|A|${STORE_ID}|${generateTerminalId(terminalCounter)}|A|\n`;
    terminalCounter++;
    content4c += `DT|A|${STORE_ID}|${generateTerminalId(terminalCounter)}|A|\n`;
    terminalCounter++;
    content4c += `DT|U|${STORE_ID}|${generateTerminalId(terminalCounter)}|I|\n`;
    terminalCounter++;
    content4c += `DT|A|${STORE_ID}|${generateTerminalId(terminalCounter)}|A|\n`;

    content4c += buildTrailer(8);

    fs.writeFileSync(filePath33, content4c);
    console.log(`   ✅ TC4C: OLSTERM-${date}-${fileSeq33}.dat (Header: ${headerSeq33}, 8 DT records)`);
    totalFiles++;

    // ============================================================
    // TC4D: Business Rule Violations (seq 34)
    // Header: 0034
    // ============================================================
    console.log('\n📝 TC4D: Business Rule Violations (34)...');
    const tc4dPath = path.join(testDataPath, 'tc4D');
    fs.ensureDirSync(tc4dPath);

    seqCounter++;
    const fileSeq34 = String(seqCounter).padStart(2, '0');
    const headerSeq34 = String(seqCounter).padStart(4, '0');
    const filePath34 = path.join(tc4dPath, `OLSTERM-${date}-${fileSeq34}.dat`);

    let content4d = `HD|OLSTERM |OLS       |${date}|        |${headerSeq34}|           \n`;
    content4d += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
    content4d += `FN|TR|recordCount|filler \n`;

    const terminalIds4d = [];
    for (let i = 0; i < 12; i++) {
      terminalCounter++;
      terminalIds4d.push(generateTerminalId(terminalCounter));
    }

    content4d += `DT|A|${STORE_ID}|${terminalIds4d[0]}|A|\n`;
    content4d += `DT|U|${STORE_ID}|${terminalIds4d[1]}|I|\n`;
    content4d += `DT|D|${STORE_ID}|${terminalIds4d[2]}|A|\n`;
    content4d += `DT|A|${STORE_ID}|${terminalIds4d[0]}|A|\n`;
    content4d += `DT|U|${STORE_ID}|${terminalIds4d[1]}|I|\n`;
    content4d += `DT|A|${STORE_ID}|${terminalIds4d[3]}|A|\n`;
    content4d += `DT|U|${STORE_ID}|${terminalIds4d[4]}|I|\n`;
    content4d += `DT|U|${STORE_ID}|${terminalIds4d[5]}|A|\n`;
    content4d += `DT|D|${STORE_ID}|${terminalIds4d[6]}|A|\n`;
    content4d += `DT|A|${STORE_ID}|${terminalIds4d[7]}|I|\n`;
    content4d += `DT|D|${STORE_ID}|${terminalIds4d[8]}|A|\n`;

    content4d += buildTrailer(11);

    fs.writeFileSync(filePath34, content4d);
    console.log(`   ✅ TC4D: OLSTERM-${date}-${fileSeq34}.dat (Header: ${headerSeq34}, 11 DT records)`);
    totalFiles++;

    // ============================================================
    // TC6A: Recovery (seq 41)
    // Header: 0041
    // ============================================================
    console.log('\n📝 TC6A: Recovery (41)...');
    const tc6aPath = path.join(testDataPath, 'tc6A');
    fs.ensureDirSync(tc6aPath);

    seqCounter++;
    const fileSeq41 = String(seqCounter).padStart(2, '0');
    const headerSeq41 = String(seqCounter).padStart(4, '0');
    const filePath41 = path.join(tc6aPath, `OLSTERM-${date}-${fileSeq41}.dat`);

    let content6a = `HD|OLSTERM |OLS       |${date}|        |${headerSeq41}|           \n`;
    content6a += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
    content6a += `FN|TR|recordCount|filler \n`;

    for (let i = 0; i < 8; i++) {
      terminalCounter++;
      const terminalId = generateTerminalId(terminalCounter);
      const flags = ['A', 'X', 'A', 'A', 'A', 'D', 'A', 'U'];
      const statuses = ['A', 'A', 'I', 'Z', 'A', 'A', 'I', 'A'];
      content6a += `DT|${flags[i]}|${flags[i] === 'X' ? '' : STORE_ID}|${terminalId}|${statuses[i]}|\n`;
    }

    content6a += buildTrailer(8);

    fs.writeFileSync(filePath41, content6a);
    console.log(`   ✅ TC6A: OLSTERM-${date}-${fileSeq41}.dat (Header: ${headerSeq41}, 8 DT records)`);
    totalFiles++;

    // ============================================================
    // TC7A: Invalid Flags (seq 43)
    // Header: 0043
    // ============================================================
    console.log('\n📝 TC7A: Invalid Flags (43)...');
    const tc7aPath = path.join(testDataPath, 'tc7A');
    fs.ensureDirSync(tc7aPath);

    seqCounter++;
    const fileSeq43 = String(seqCounter).padStart(2, '0');
    const headerSeq43 = String(seqCounter).padStart(4, '0');
    const filePath43 = path.join(tc7aPath, `OLSTERM-${date}-${fileSeq43}.dat`);

    let content7a = `HD|OLSTERM |OLS       |${date}|        |${headerSeq43}|           \n`;
    content7a += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
    content7a += `FN|TR|recordCount|filler \n`;

    const flags7a = ['X', 'Y', 'Z', '!', '@'];
    for (let i = 0; i < 5; i++) {
      terminalCounter++;
      const terminalId = generateTerminalId(terminalCounter);
      content7a += `DT|${flags7a[i]}|${STORE_ID}|${terminalId}|${i % 2 === 0 ? 'A' : 'I'}|\n`;
    }

    content7a += buildTrailer(5);

    fs.writeFileSync(filePath43, content7a);
    console.log(`   ✅ TC7A: OLSTERM-${date}-${fileSeq43}.dat (Header: ${headerSeq43}, 5 DT records)`);
    totalFiles++;

    // ============================================================
    // TC7B: Invalid Statuses (seq 44)
    // Header: 0044
    // ============================================================
    console.log('\n📝 TC7B: Invalid Statuses (44)...');
    const tc7bPath = path.join(testDataPath, 'tc7B');
    fs.ensureDirSync(tc7bPath);

    seqCounter++;
    const fileSeq44 = String(seqCounter).padStart(2, '0');
    const headerSeq44 = String(seqCounter).padStart(4, '0');
    const filePath44 = path.join(tc7bPath, `OLSTERM-${date}-${fileSeq44}.dat`);

    let content7b = `HD|OLSTERM |OLS       |${date}|        |${headerSeq44}|           \n`;
    content7b += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
    content7b += `FN|TR|recordCount|filler \n`;

    const statuses7b = ['X', 'Y', 'Z', '!', '@'];
    const flags7b = ['A', 'U', 'D', 'A', 'U'];
    for (let i = 0; i < 5; i++) {
      terminalCounter++;
      const terminalId = generateTerminalId(terminalCounter);
      content7b += `DT|${flags7b[i]}|${STORE_ID}|${terminalId}|${statuses7b[i]}|\n`;
    }

    content7b += buildTrailer(5);

    fs.writeFileSync(filePath44, content7b);
    console.log(`   ✅ TC7B: OLSTERM-${date}-${fileSeq44}.dat (Header: ${headerSeq44}, 5 DT records)`);
    totalFiles++;

    // ============================================================
    // TC7C: Length Validation (seq 45)
    // Header: 0045
    // ============================================================
    console.log('\n📝 TC7C: Length Validation (45)...');
    const tc7cPath = path.join(testDataPath, 'tc7C');
    fs.ensureDirSync(tc7cPath);

    seqCounter++;
    const fileSeq45 = String(seqCounter).padStart(2, '0');
    const headerSeq45 = String(seqCounter).padStart(4, '0');
    const filePath45 = path.join(tc7cPath, `OLSTERM-${date}-${fileSeq45}.dat`);

    let content7c = `HD|OLSTERM |OLS       |${date}|        |${headerSeq45}|           \n`;
    content7c += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
    content7c += `FN|TR|recordCount|filler \n`;

    terminalCounter++;
    content7c += `DT|A|${STORE_ID}|${generateTerminalId(terminalCounter)}|A|\n`;
    terminalCounter++;
    content7c += `DT|U|${STORE_ID}|${generateTerminalId(terminalCounter)}|I|\n`;
    content7c += `DT|A||TERM0001|A|\n`;
    content7c += `DT|U|${STORE_ID}| |I|\n`;
    terminalCounter++;
    content7c += `DT|D|${STORE_ID}|${generateTerminalId(terminalCounter)}|A|\n`;
    terminalCounter++;
    content7c += `DT|A|${STORE_ID}|${generateTerminalId(terminalCounter)}|I|\n`;
    terminalCounter++;
    content7c += `DT|U|${STORE_ID}|${generateTerminalId(terminalCounter)}|A|\n`;
    terminalCounter++;
    content7c += `DT|D|${STORE_ID}|${generateTerminalId(terminalCounter)}|I|\n`;

    content7c += buildTrailer(8);

    fs.writeFileSync(filePath45, content7c);
    console.log(`   ✅ TC7C: OLSTERM-${date}-${fileSeq45}.dat (Header: ${headerSeq45}, 8 DT records)`);
    totalFiles++;

    // ============================================================
    // TC8A: Sequential Operations (seq 46)
    // Header: 0046
    // ============================================================
    console.log('\n📝 TC8A: Sequential Operations (46)...');
    const tc8aPath = path.join(testDataPath, 'tc8A');
    fs.ensureDirSync(tc8aPath);

    seqCounter++;
    const fileSeq46 = String(seqCounter).padStart(2, '0');
    const headerSeq46 = String(seqCounter).padStart(4, '0');
    const filePath46 = path.join(tc8aPath, `OLSTERM-${date}-${fileSeq46}.dat`);

    let content8a = `HD|OLSTERM |OLS       |${date}|        |${headerSeq46}|           \n`;
    content8a += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
    content8a += `FN|TR|recordCount|filler \n`;

    const terminalId1 = generateTerminalId(++terminalCounter);
    const terminalId2 = generateTerminalId(++terminalCounter);
    const terminalId3 = generateTerminalId(++terminalCounter);
    const terminalId4 = generateTerminalId(++terminalCounter);

    content8a += `DT|A|${STORE_ID}|${terminalId1}|A|\n`;
    content8a += `DT|U|${STORE_ID}|${terminalId1}|I|\n`;
    content8a += `DT|D|${STORE_ID}|${terminalId1}|A|\n`;
    content8a += `DT|U|${STORE_ID}|${terminalId2}|A|\n`;
    content8a += `DT|D|${STORE_ID}|${terminalId3}|I|\n`;
    content8a += `DT|A|${STORE_ID}|${terminalId2}|A|\n`;
    content8a += `DT|U|${STORE_ID}|${terminalId2}|I|\n`;
    content8a += `DT|A|${STORE_ID}|${terminalId4}|A|\n`;

    content8a += buildTrailer(8);

    fs.writeFileSync(filePath46, content8a);
    console.log(`   ✅ TC8A: OLSTERM-${date}-${fileSeq46}.dat (Header: ${headerSeq46}, 8 DT records)`);
    totalFiles++;

    // ============================================================
    // TC8B: Duplicate Records (seq 47)
    // Header: 0047
    // ============================================================
    console.log('\n📝 TC8B: Duplicate Records (47)...');
    const tc8bPath = path.join(testDataPath, 'tc8B');
    fs.ensureDirSync(tc8bPath);

    seqCounter++;
    const fileSeq47 = String(seqCounter).padStart(2, '0');
    const headerSeq47 = String(seqCounter).padStart(4, '0');
    const filePath47 = path.join(tc8bPath, `OLSTERM-${date}-${fileSeq47}.dat`);

    let content8b = `HD|OLSTERM |OLS       |${date}|        |${headerSeq47}|           \n`;
    content8b += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
    content8b += `FN|TR|recordCount|filler \n`;

    const term1 = generateTerminalId(++terminalCounter);
    const term2 = generateTerminalId(++terminalCounter);
    const term3 = generateTerminalId(++terminalCounter);
    const term4 = generateTerminalId(++terminalCounter);
    const term5 = generateTerminalId(++terminalCounter);

    content8b += `DT|A|${STORE_ID}|${term1}|A|\n`;
    content8b += `DT|A|${STORE_ID}|${term2}|I|\n`;
    content8b += `DT|A|${STORE_ID}|${term3}|A|\n`;
    content8b += `DT|A|${STORE_ID}|${term1}|A|\n`;
    content8b += `DT|U|${STORE_ID}|${term2}|I|\n`;
    content8b += `DT|D|${STORE_ID}|${term3}|A|\n`;
    content8b += `DT|A|${STORE_ID}|${term4}|A|\n`;
    content8b += `DT|A|${STORE_ID}|${term4}|A|\n`;

    content8b += buildTrailer(8);

    fs.writeFileSync(filePath47, content8b);
    console.log(`   ✅ TC8B: OLSTERM-${date}-${fileSeq47}.dat (Header: ${headerSeq47}, 8 DT records)`);
    totalFiles++;

    // ============================================================
    // TC9A: Future Dates (seq 48)
    // Header: 0048
    // ============================================================
    console.log('\n📝 TC9A: Future Dates (48)...');
    const tc9aPath = path.join(testDataPath, 'tc9A');
    fs.ensureDirSync(tc9aPath);

    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);
    const dateStr = futureDate.getFullYear() +
      String(futureDate.getMonth() + 1).padStart(2, '0') +
      String(futureDate.getDate()).padStart(2, '0');

    seqCounter++;
    const fileSeq48 = String(seqCounter).padStart(2, '0');
    const headerSeq48 = String(seqCounter).padStart(4, '0');
    const filePath48 = path.join(tc9aPath, `OLSTERM-${dateStr}-${fileSeq48}.dat`);

    let content9a = `HD|OLSTERM |OLS       |${dateStr}|        |${headerSeq48}|           \n`;
    content9a += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
    content9a += `FN|TR|recordCount|filler \n`;

    for (let i = 0; i < 3; i++) {
      terminalCounter++;
      const terminalId = generateTerminalId(terminalCounter);
      const flags = ['A', 'U', 'D'];
      const statuses = ['A', 'I', 'A'];
      content9a += `DT|${flags[i]}|${STORE_ID}|${terminalId}|${statuses[i]}|\n`;
    }

    content9a += buildTrailer(3);

    fs.writeFileSync(filePath48, content9a);
    console.log(`   ✅ TC9A: OLSTERM-${dateStr}-${fileSeq48}.dat (Header: ${headerSeq48}, 3 DT records)`);
    totalFiles++;

    // ============================================================
    // TC9B: Past Dates (seq 49)
    // Header: 0049
    // ============================================================
    console.log('\n📝 TC9B: Past Dates (49)...');
    const tc9bPath = path.join(testDataPath, 'tc9B');
    fs.ensureDirSync(tc9bPath);

    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 30);
    const pastDateStr = pastDate.getFullYear() +
      String(pastDate.getMonth() + 1).padStart(2, '0') +
      String(pastDate.getDate()).padStart(2, '0');

    seqCounter++;
    const fileSeq49 = String(seqCounter).padStart(2, '0');
    const headerSeq49 = String(seqCounter).padStart(4, '0');
    const filePath49 = path.join(tc9bPath, `OLSTERM-${pastDateStr}-${fileSeq49}.dat`);

    let content9b = `HD|OLSTERM |OLS       |${pastDateStr}|        |${headerSeq49}|           \n`;
    content9b += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
    content9b += `FN|TR|recordCount|filler \n`;

    for (let i = 0; i < 2; i++) {
      terminalCounter++;
      const terminalId = generateTerminalId(terminalCounter);
      const flags = ['A', 'U'];
      const statuses = ['A', 'I'];
      content9b += `DT|${flags[i]}|${STORE_ID}|${terminalId}|${statuses[i]}|\n`;
    }

    content9b += buildTrailer(2);

    fs.writeFileSync(filePath49, content9b);
    console.log(`   ✅ TC9B: OLSTERM-${pastDateStr}-${fileSeq49}.dat (Header: ${headerSeq49}, 2 DT records)`);
    totalFiles++;

    // ============================================================
    // SUMMARY
    // ============================================================
    console.log('\n' + '='.repeat(60));
    console.log(`\n📊 Total files generated: ${totalFiles}`);
    console.log(`📊 Total unique Terminal IDs generated: ${terminalCounter - offset}`);
    console.log(`📊 Terminal ID range: TM${String(offset + 1).padStart(6, '0')} to TM${String(terminalCounter).padStart(6, '0')}`);
    console.log(`📁 Location: ${testDataPath}`);
    console.log(`\n📂 Folder Structure:`);
    console.log(`   ├── tc1/  (10 files: 01-10, Header: 0001-0010)`);
    console.log(`   ├── tc2/  (10 files: 11-20, Header: 0011-0020)`);
    console.log(`   ├── tc3/  (10 files: 21-30, Header: 0021-0030)`);
    console.log(`   ├── tc4A/ (1 file: 31, Header: 0031)`);
    console.log(`   ├── tc4B/ (1 file: 32, Header: 0032)`);
    console.log(`   ├── tc4C/ (1 file: 33, Header: 0033)`);
    console.log(`   ├── tc4D/ (1 file: 34, Header: 0034)`);
    console.log(`   ├── tc6A/ (1 file: 41, Header: 0041)`);
    console.log(`   ├── tc7A/ (1 file: 43, Header: 0043)`);
    console.log(`   ├── tc7B/ (1 file: 44, Header: 0044)`);
    console.log(`   ├── tc7C/ (1 file: 45, Header: 0045)`);
    console.log(`   ├── tc8A/ (1 file: 46, Header: 0046)`);
    console.log(`   ├── tc8B/ (1 file: 47, Header: 0047)`);
    console.log(`   ├── tc9A/ (1 file: 48, Header: 0048)`);
    console.log(`   ├── tc9B/ (1 file: 49, Header: 0049)`);
    console.log('\n✅ All files generated successfully!\n');

    return totalFiles;

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error.stack);
    throw error;
  }
}

// ============ RUN ALWAYS ============
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