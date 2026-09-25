// scripts/test-data.js
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============ HELPER FUNCTIONS ============

export function getCurrentDate() {
  const now = new Date();
  return now.getFullYear() + 
         String(now.getMonth() + 1).padStart(2, '0') + 
         String(now.getDate()).padStart(2, '0');
}

export function getDateWithOffset(offsetDays = 0) {
  const now = new Date();
  now.setDate(now.getDate() + offsetDays);
  return now.getFullYear() + 
         String(now.getMonth() + 1).padStart(2, '0') + 
         String(now.getDate()).padStart(2, '0');
}

export function generateFileName(sequenceNo, suffix = '', date = null) {
  const currentDate = date || getCurrentDate();
  const seq = String(sequenceNo).padStart(4, '0');
  const suffixPart = suffix ? `-${suffix}` : '';
  return `OLSTERM-${currentDate}-${seq}${suffixPart}.dat`;
}

export function generateFilePattern(sequenceNo, suffix = '', date = null) {
  const currentDate = date || getCurrentDate();
  const seq = String(sequenceNo).padStart(4, '0');
  const suffixPart = suffix ? `-${suffix}` : '';
  return `OLSTERM-${currentDate}-${seq}${suffixPart}*.dat`;
}

// ============ TC1: All Valid Files (10 files) ============
export function generateTC1Files() {
  const files = [];
  const date = getCurrentDate();
  
  for (let i = 0; i < 10; i++) {
    const seq = String(i + 1).padStart(4, '0');
    const fileName = `OLSTERM-${date}-${seq}-valid${i+1}.dat`;
    const recordCount = i + 1;
    
    let content = `HD|OLSTERM |OLS       |${date}|        |TC1-${seq}|           \n`;
    content += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
    content += `FN|TR|recordCount|filler \n`;
    
    for (let j = 0; j < recordCount; j++) {
      const flag = j % 3 === 0 ? 'A' : (j % 3 === 1 ? 'U' : 'D');
      const status = j % 2 === 0 ? 'A' : 'I';
      content += `DT|${flag}|V${String(j+1).padStart(3, '0')}|TERM${String(j+1).padStart(3, '0')}|${status}|\n`;
    }
    
    content += `TR|||||${recordCount}|\n`;
    files.push({ 
      name: fileName, 
      content, 
      description: `Valid file with ${recordCount} records`,
      testCase: 'TC1',
      expectedResult: 'PASS'
    });
  }
  
  return files;
}

// ============ TC2: 5 Valid + 5 Invalid Files ============
export function generateTC2Files() {
  const files = [];
  const date = getCurrentDate();
  
  // 5 Valid files
  for (let i = 0; i < 5; i++) {
    const seq = String(i + 1).padStart(4, '0');
    const fileName = `OLSTERM-${date}-${seq}-valid${i+1}.dat`;
    const count = i + 1;
    
    let content = `HD|OLSTERM |OLS       |${date}|        |TC2-V${seq}|           \n`;
    content += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
    content += `FN|TR|recordCount|filler \n`;
    
    for (let j = 0; j < count; j++) {
      const flag = j % 2 === 0 ? 'A' : 'U';
      content += `DT|${flag}|VAL${String(j+1).padStart(3, '0')}|TERM${String(j+1).padStart(3, '0')}|A|\n`;
    }
    
    content += `TR|||||${count}|\n`;
    files.push({ 
      name: fileName, 
      content, 
      description: `Valid file ${i+1} with ${count} records`,
      testCase: 'TC2',
      expectedResult: 'PASS'
    });
  }

  // 5 Invalid files
  const invalidFiles = [
    {
      suffix: 'invalid1',
      description: 'Missing header',
      content: `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nFN|TR|recordCount|filler \nDT|A|INV01|TERM01|A|\nTR|||||1|\n`
    },
    {
      suffix: 'invalid2',
      description: 'Missing trailer',
      content: `HD|OLSTERM |OLS       |${date}|        |TC2-I2|           \nFN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nFN|TR|recordCount|filler \nDT|A|INV02|TERM02|A|\nDT|U|INV03|TERM03|I|\n`
    },
    {
      suffix: 'invalid3',
      description: 'Count mismatch',
      content: `HD|OLSTERM |OLS       |${date}|        |TC2-I3|           \nFN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nFN|TR|recordCount|filler \nDT|A|INV04|TERM04|A|\nDT|U|INV05|TERM05|I|\nDT|D|INV06|TERM06|A|\nTR|||||5|\n`
    },
    {
      suffix: 'invalid4',
      description: 'Invalid update flag X',
      content: `HD|OLSTERM |OLS       |${date}|        |TC2-I4|           \nFN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nFN|TR|recordCount|filler \nDT|X|INV07|TERM07|A|\nTR|||||1|\n`
    },
    {
      suffix: 'invalid5',
      description: 'Invalid terminal status Z',
      content: `HD|OLSTERM |OLS       |${date}|        |TC2-I5|           \nFN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nFN|TR|recordCount|filler \nDT|A|INV08|TERM08|Z|\nTR|||||1|\n`
    }
  ];

  for (let i = 0; i < invalidFiles.length; i++) {
    const seq = String(i + 6).padStart(4, '0');
    const fileName = `OLSTERM-${date}-${seq}-${invalidFiles[i].suffix}.dat`;
    files.push({ 
      name: fileName, 
      content: invalidFiles[i].content, 
      description: invalidFiles[i].description,
      testCase: 'TC2',
      expectedResult: 'FAIL'
    });
  }

  return files;
}

// ============ TC3: All Invalid Files (10 files) ============
export function generateTC3Files() {
  const files = [];
  const date = getCurrentDate();
  
  const invalidFiles = [
    { 
      suffix: 'empty', 
      description: 'Empty file',
      content: '' 
    },
    { 
      suffix: 'only-header', 
      description: 'Only header',
      content: `HD|OLSTERM |OLS       |${date}|        |TC3-F2|           \n` 
    },
    { 
      suffix: 'no-data', 
      description: 'Header + field names only',
      content: `HD|OLSTERM |OLS       |${date}|        |TC3-F3|           \nFN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nFN|TR|recordCount|filler \n` 
    },
    { 
      suffix: 'no-trailer', 
      description: 'No trailer',
      content: `HD|OLSTERM |OLS       |${date}|        |TC3-F4|           \nFN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nFN|TR|recordCount|filler \nDT|A|ERR01|TERM01|A|\nDT|U|ERR02|TERM02|I|\n` 
    },
    { 
      suffix: 'no-fields', 
      description: 'No field names',
      content: `HD|OLSTERM |OLS       |${date}|        |TC3-F5|           \nDT|A|ERR03|TERM03|A|\nTR|||||1|\n` 
    },
    { 
      suffix: 'wrong-date', 
      description: 'Wrong date format',
      content: `HD|OLSTERM |OLS       |2026-06-25|        |TC3-F6|           \nFN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nFN|TR|recordCount|filler \nDT|A|ERR04|TERM04|A|\nTR|||||1|\n` 
    },
    { 
      suffix: 'wrong-delimiter', 
      description: 'Wrong delimiter',
      content: `HD|OLSTERM |OLS       |${date}#        #TC3-F7#           \nFN|DT||atypUpdateFlag#aStoreId#aTerminalId#aTermSts#filler\nFN|TR|recordCount|filler \nDT|A|ERR05|TERM05|A|\nTR|||||1|\n` 
    },
    { 
      suffix: 'wrong-record-type', 
      description: 'Wrong record type',
      content: `HD|OLSTERM |OLS       |${date}|        |TC3-F8|           \nXX|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nXX|TR|recordCount|filler \nDT|A|ERR06|TERM06|A|\nTR|||||1|\n` 
    },
    { 
      suffix: 'negative-count', 
      description: 'Negative record count',
      content: `HD|OLSTERM |OLS       |${date}|        |TC3-F9|           \nFN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nFN|TR|recordCount|filler \nDT|A|ERR07|TERM07|A|\nTR|||||-1|\n` 
    },
    { 
      suffix: 'missing-fields', 
      description: 'Missing fields',
      content: `HD|OLSTERM |OLS       |${date}|        |TC3-F10|           \nFN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\nFN|TR|recordCount|filler \nDT|A|ERR08|TERM08|\nTR|||||1|\n` 
    }
  ];

  for (let i = 0; i < invalidFiles.length; i++) {
    const seq = String(i + 1).padStart(4, '0');
    const fileName = `OLSTERM-${date}-${seq}-${invalidFiles[i].suffix}.dat`;
    files.push({ 
      name: fileName, 
      content: invalidFiles[i].content, 
      description: invalidFiles[i].description,
      testCase: 'TC3',
      expectedResult: 'FAIL'
    });
  }

  return files;
}

// ============ TC4A: 10 Valid + 10 Invalid in One File ============
export function generateTC4AFiles() {
  const files = [];
  const date = getCurrentDate();
  const fileName = `OLSTERM-${date}-0001-tc4a.dat`;
  
  let content = `HD|OLSTERM |OLS       |${date}|        |TC4A|           \n`;
  content += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
  content += `FN|TR|recordCount|filler \n`;
  
  // 10 Valid records
  for (let i = 0; i < 10; i++) {
    const flag = i % 3 === 0 ? 'A' : (i % 3 === 1 ? 'U' : 'D');
    const status = i % 2 === 0 ? 'A' : 'I';
    content += `DT|${flag}|V${String(i+1).padStart(3, '0')}|TERM${String(i+1).padStart(3, '0')}|${status}|\n`;
  }
  
  // 10 Invalid records
  content += `DT|X|I1|TERM1|A|\n`; // Invalid flag
  content += `DT|A||TERM2|A|\n`; // Empty store ID
  content += `DT|A|I3||A|\n`; // Empty terminal ID
  content += `DT|A|I4|TERM4|Z|\n`; // Invalid status
  content += `DT|A|I5|TERM5|A|\n`; // Valid (place holder)
  content += `DT|A|I6|TERM6|A|\n`; // Duplicate
  content += `DT|A|I7|TERM7|A|\n`; // Duplicate
  content += `DT|A|I8|TERM8|A|\n`; // Duplicate
  content += `DT|A|I9|TERM9|A|\n`; // Duplicate
  content += `DT|A|I10|TERM10|A|\n`; // Duplicate
  
  content += `TR|||||20|\n`;
  
  files.push({ 
    name: fileName, 
    content, 
    description: '10 valid + 10 invalid records in one file',
    testCase: 'TC4A',
    expectedResult: 'PARTIAL'
  });
  
  return files;
}

// ============ TC4B: Alternating Valid/Invalid Pattern ============
export function generateTC4BFiles() {
  const files = [];
  const date = getCurrentDate();
  const fileName = `OLSTERM-${date}-0001-tc4b.dat`;
  
  let content = `HD|OLSTERM |OLS       |${date}|        |TC4B|           \n`;
  content += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
  content += `FN|TR|recordCount|filler \n`;
  
  const records = [
    { flag: 'A', store: 'V1', terminal: 'TERM1', status: 'A', valid: true },
    { flag: 'X', store: 'I1', terminal: 'TERM2', status: 'A', valid: false },
    { flag: 'A', store: 'V2', terminal: 'TERM3', status: 'I', valid: true },
    { flag: 'U', store: 'I2', terminal: 'TERM4', status: 'Z', valid: false },
    { flag: 'A', store: 'V3', terminal: 'TERM5', status: 'A', valid: true },
    { flag: 'D', store: 'I3', terminal: 'TERM6', status: 'A', valid: false },
    { flag: 'A', store: 'V4', terminal: 'TERM7', status: 'I', valid: true },
    { flag: 'A', store: '', terminal: 'TERM8', status: 'A', valid: false },
    { flag: 'A', store: 'V5', terminal: 'TERM9', status: 'A', valid: true },
    { flag: 'U', store: 'I5', terminal: '', status: 'I', valid: false }
  ];

  for (const record of records) {
    content += `DT|${record.flag}|${record.store}|${record.terminal}|${record.status}|\n`;
  }
  
  content += `TR|||||5|\n`; // Count mismatch
  
  files.push({ 
    name: fileName, 
    content, 
    description: 'Alternating valid/invalid pattern',
    testCase: 'TC4B',
    expectedResult: 'PARTIAL'
  });
  
  return files;
}

// ============ TC4C: Boundary + Invalid Combo ============
export function generateTC4CFiles() {
  const files = [];
  const date = getCurrentDate();
  const fileName = `OLSTERM-${date}-0001-tc4c.dat`;
  
  let content = `HD|OLSTERM |OLS       |${date}|        |TC4C|           \n`;
  content += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
  content += `FN|TR|recordCount|filler \n`;
  
  // Edge - Single character (Valid)
  content += `DT|A|A|B|A|\n`;
  content += `DT|U|C|D|I|\n`;
  
  // Invalid - Empty fields
  content += `DT|A|||A|\n`;
  content += `DT|U|||I|\n`;
  
  // Boundary - Max length (Valid)
  content += `DT|A|ABCDEFGHIJ|KLMNOPQRST|A|\n`;
  
  // Invalid - Special characters
  content += `DT|A|STORE@#$|TERM!@#|A|\n`;
  content += `DT|U|STORE%^&|TERM*()|I|\n`;
  
  // Boundary - Zero records in middle (Invalid)
  content += `DT|A|ZERO|TERM|A|\n`;
  
  content += `TR|||||5|\n`; // Count mismatch
  
  files.push({ 
    name: fileName, 
    content, 
    description: 'Boundary + invalid combo',
    testCase: 'TC4C',
    expectedResult: 'PARTIAL'
  });
  
  return files;
}

// ============ TC4D: Critical Business Rule Violations ============
export function generateTC4DFiles() {
  const files = [];
  const date = getCurrentDate();
  const fileName = `OLSTERM-${date}-0001-tc4d.dat`;
  
  let content = `HD|OLSTERM |OLS       |${date}|        |TC4D|           \n`;
  content += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
  content += `FN|TR|recordCount|filler \n`;
  
  // Valid - Different stores
  content += `DT|A|S1|T1|A|\n`;
  content += `DT|U|S2|T2|I|\n`;
  content += `DT|D|S3|T3|A|\n`;
  
  // Invalid - Duplicate store/terminal combinations
  content += `DT|A|S1|T1|A|\n`; // Duplicate
  content += `DT|U|S2|T2|I|\n`; // Duplicate
  
  // Valid - Different terminals same store
  content += `DT|A|S1|T4|A|\n`;
  content += `DT|U|S2|T5|I|\n`;
  
  // Invalid - Update without prior add
  content += `DT|U|S9|T9|A|\n`;
  
  // Invalid - Delete without prior add
  content += `DT|D|S10|T10|A|\n`;
  
  // Valid - Mix
  content += `DT|A|S4|T6|I|\n`;
  content += `DT|D|S5|T7|A|\n`;
  
  content += `TR|||||12|\n`;
  
  files.push({ 
    name: fileName, 
    content, 
    description: 'Critical business rule violations',
    testCase: 'TC4D',
    expectedResult: 'PARTIAL'
  });
  
  return files;
}

// ============ TC5A: Large File with 1000 Records ============
export function generateTC5AFiles() {
  const files = [];
  const date = getCurrentDate();
  const fileName = `OLSTERM-${date}-0001-large.dat`;
  
  let content = `HD|OLSTERM |OLS       |${date}|        |TC5A|           \n`;
  content += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
  content += `FN|TR|recordCount|filler \n`;
  
  // 900 Valid records (A, U, D pattern)
  for (let i = 0; i < 900; i++) {
    const flag = i % 3 === 0 ? 'A' : (i % 3 === 1 ? 'U' : 'D');
    const status = i % 2 === 0 ? 'A' : 'I';
    content += `DT|${flag}|STORE${String(i+1).padStart(5, '0')}|TERM${String(i+1).padStart(5, '0')}|${status}|\n`;
  }
  
  // 50 Invalid records
  for (let i = 0; i < 25; i++) {
    content += `DT|X|ERR${String(i+1).padStart(3, '0')}|TERM${String(i+1).padStart(3, '0')}|A|\n`;
    content += `DT|A|ERR${String(i+26).padStart(3, '0')}|TERM${String(i+26).padStart(3, '0')}|Z|\n`;
  }
  
  // 50 Boundary records
  for (let i = 0; i < 25; i++) {
    content += `DT|A|${String(i+1)}|${String(i+1)}|A|\n`;
    content += `DT|A|ABCDEFGHIJKLMNOPQRST|ABCDEFGHIJKLMNOPQRST|A|\n`;
  }
  
  content += `TR|||||1000|\n`;
  
  files.push({ 
    name: fileName, 
    content, 
    description: 'Large file with 1000 records (900 valid, 100 invalid)',
    testCase: 'TC5A',
    expectedResult: 'PASS'
  });
  
  return files;
}

// ============ TC5B: 5 Large Files Concurrent ============
export function generateTC5BFiles() {
  const files = [];
  const date = getCurrentDate();
  
  for (let f = 0; f < 5; f++) {
    const seq = String(f + 1).padStart(4, '0');
    const fileName = `OLSTERM-${date}-${seq}-concurrent${f+1}.dat`;
    
    let content = `HD|OLSTERM |OLS       |${date}|        |TC5B-${f+1}|           \n`;
    content += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
    content += `FN|TR|recordCount|filler \n`;
    
    // 400 Valid records
    for (let i = 0; i < 400; i++) {
      const flag = i % 3 === 0 ? 'A' : (i % 3 === 1 ? 'U' : 'D');
      const status = i % 2 === 0 ? 'A' : 'I';
      content += `DT|${flag}|CONC${String(f+1).padStart(2,'0')}${String(i+1).padStart(4,'0')}|TERM${String(i+1).padStart(4,'0')}|${status}|\n`;
    }
    
    // 100 Invalid records
    for (let i = 0; i < 50; i++) {
      content += `DT|X|ERR${String(i+1).padStart(3,'0')}|TERM${String(i+1).padStart(3,'0')}|A|\n`;
      content += `DT|A|ERR${String(i+51).padStart(3,'0')}|TERM${String(i+51).padStart(3,'0')}|Z|\n`;
    }
    
    content += `TR|||||500|\n`;
    
    files.push({ 
      name: fileName, 
      content, 
      description: `Concurrent file ${f+1} with 500 records`,
      testCase: 'TC5B',
      expectedResult: 'PASS'
    });
  }
  
  return files;
}

// ============ TC6A: Sequential Errors then Recovery ============
export function generateTC6AFiles() {
  const files = [];
  const date = getCurrentDate();
  const fileName = `OLSTERM-${date}-0001-recovery.dat`;
  
  let content = `HD|OLSTERM |OLS       |${date}|        |TC6A|           \n`;
  content += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
  content += `FN|TR|recordCount|filler \n`;
  
  content += `DT|A|R1|T1|A|\n`; // Valid
  content += `DT|X|E1|T2|A|\n`; // Error - Invalid flag
  content += `DT|A|R2|T3|I|\n`; // Valid - Should continue
  content += `DT|A|E2|T4|Z|\n`; // Error - Invalid status
  content += `DT|A|R3|T5|A|\n`; // Valid - Should continue
  content += `DT|D|E3|T6|A|\n`; // Error - No matching add
  content += `DT|A|R4|T7|I|\n`; // Valid - Should continue
  content += `DT|U|R5|T8|A|\n`; // Valid
  
  content += `TR|||||8|\n`;
  
  files.push({ 
    name: fileName, 
    content, 
    description: 'Sequential errors then recovery',
    testCase: 'TC6A',
    expectedResult: 'PARTIAL'
  });
  
  return files;
}

// ============ TC6B: System Resource Errors ============
export function generateTC6BFiles() {
  const files = [];
  const date = getCurrentDate();
  const fileName = `OLSTERM-${date}-0001-resource.dat`;
  
  let content = `HD|OLSTERM |OLS       |${date}|        |TC6B|           \n`;
  content += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
  content += `FN|TR|recordCount|filler \n`;
  
  // 500 Add operations
  for (let i = 0; i < 500; i++) {
    content += `DT|A|ADD${String(i+1).padStart(5,'0')}|TERM${String(i+1).padStart(5,'0')}|A|\n`;
  }
  
  // 500 Update operations
  for (let i = 0; i < 500; i++) {
    content += `DT|U|UPD${String(i+1).padStart(5,'0')}|TERM${String(i+1).padStart(5,'0')}|I|\n`;
  }
  
  // 500 Delete operations
  for (let i = 0; i < 500; i++) {
    content += `DT|D|DEL${String(i+1).padStart(5,'0')}|TERM${String(i+1).padStart(5,'0')}|A|\n`;
  }
  
  content += `TR|||||1500|\n`;
  
  files.push({ 
    name: fileName, 
    content, 
    description: 'System resource errors - 1500 records',
    testCase: 'TC6B',
    expectedResult: 'PASS'
  });
  
  return files;
}

// ============ TC7A: All Invalid Flags ============
export function generateTC7AFiles() {
  const files = [];
  const date = getCurrentDate();
  const fileName = `OLSTERM-${date}-0001-invalid-flags.dat`;
  
  let content = `HD|OLSTERM |OLS       |${date}|        |TC7A|           \n`;
  content += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
  content += `FN|TR|recordCount|filler \n`;
  
  content += `DT|X|STORE1|TERM1|A|\n`;
  content += `DT|Y|STORE2|TERM2|I|\n`;
  content += `DT|Z|STORE3|TERM3|A|\n`;
  content += `DT|!|STORE4|TERM4|I|\n`;
  content += `DT|@|STORE5|TERM5|A|\n`;
  
  content += `TR|||||5|\n`;
  
  files.push({ 
    name: fileName, 
    content, 
    description: 'All invalid update flags',
    testCase: 'TC7A',
    expectedResult: 'FAIL'
  });
  
  return files;
}

// ============ TC7B: All Invalid Statuses ============
export function generateTC7BFiles() {
  const files = [];
  const date = getCurrentDate();
  const fileName = `OLSTERM-${date}-0001-invalid-statuses.dat`;
  
  let content = `HD|OLSTERM |OLS       |${date}|        |TC7B|           \n`;
  content += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
  content += `FN|TR|recordCount|filler \n`;
  
  content += `DT|A|STORE1|TERM1|X|\n`;
  content += `DT|U|STORE2|TERM2|Y|\n`;
  content += `DT|D|STORE3|TERM3|Z|\n`;
  content += `DT|A|STORE4|TERM4|!|\n`;
  content += `DT|U|STORE5|TERM5|@|\n`;
  
  content += `TR|||||5|\n`;
  
  files.push({ 
    name: fileName, 
    content, 
    description: 'All invalid terminal statuses',
    testCase: 'TC7B',
    expectedResult: 'FAIL'
  });
  
  return files;
}

// ============ TC7C: Mixed Length Validation ============
export function generateTC7CFiles() {
  const files = [];
  const date = getCurrentDate();
  const fileName = `OLSTERM-${date}-0001-length-validation.dat`;
  
  let content = `HD|OLSTERM |OLS       |${date}|        |TC7C|           \n`;
  content += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
  content += `FN|TR|recordCount|filler \n`;
  
  // Valid - Min lengths
  content += `DT|A|A|B|A|\n`;
  content += `DT|U|C|D|I|\n`;
  
  // Invalid - Empty
  content += `DT|A||TERM1|A|\n`;
  content += `DT|U|STORE| |I|\n`;
  
  // Valid - Normal lengths
  content += `DT|D|STORE01|TERM01|A|\n`;
  content += `DT|A|STORE02|TERM02|I|\n`;
  
  // Invalid - Excessive lengths (>20 chars)
  content += `DT|U|ABCDEFGHIJKLMNOPQRSTUVWXYZ|ABCDEFGHIJKLMNOPQRSTUVWXYZ|A|\n`;
  
  // Valid - Special characters allowed?
  content += `DT|D|STORE-01|TERM-01|I|\n`;
  
  content += `TR|||||9|\n`;
  
  files.push({ 
    name: fileName, 
    content, 
    description: 'Mixed length validation',
    testCase: 'TC7C',
    expectedResult: 'PARTIAL'
  });
  
  return files;
}

// ============ TC8A: Sequential Operations ============
export function generateTC8AFiles() {
  const files = [];
  const date = getCurrentDate();
  const fileName = `OLSTERM-${date}-0001-sequential.dat`;
  
  let content = `HD|OLSTERM |OLS       |${date}|        |TC8A|           \n`;
  content += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
  content += `FN|TR|recordCount|filler \n`;
  
  // Valid - Proper sequence
  content += `DT|A|S1|T1|A|\n`;
  content += `DT|U|S1|T1|I|\n`;
  content += `DT|D|S1|T1|A|\n`;
  
  // Invalid - Update before Add
  content += `DT|U|S2|T2|A|\n`;
  
  // Invalid - Delete before Add
  content += `DT|D|S3|T3|I|\n`;
  
  // Valid - Proper sequence
  content += `DT|A|S2|T2|A|\n`;
  content += `DT|U|S2|T2|I|\n`;
  
  // Valid - Add same store different terminal
  content += `DT|A|S1|T2|A|\n`;
  
  content += `TR|||||8|\n`;
  
  files.push({ 
    name: fileName, 
    content, 
    description: 'Sequential operations',
    testCase: 'TC8A',
    expectedResult: 'PARTIAL'
  });
  
  return files;
}

// ============ TC8B: Duplicate Records ============
export function generateTC8BFiles() {
  const files = [];
  const date = getCurrentDate();
  const fileName = `OLSTERM-${date}-0001-duplicates.dat`;
  
  let content = `HD|OLSTERM |OLS       |${date}|        |TC8B|           \n`;
  content += `FN|DT||atypUpdateFlag|aStoreId|aTerminalId|aTermSts|filler\n`;
  content += `FN|TR|recordCount|filler \n`;
  
  // Valid - Unique combinations
  content += `DT|A|S1|T1|A|\n`;
  content += `DT|A|S2|T2|I|\n`;
  content += `DT|A|S3|T3|A|\n`;
  
  // Invalid - Exact duplicates
  content += `DT|A|S1|T1|A|\n`;
  content += `DT|U|S2|T2|I|\n`;
  content += `DT|D|S3|T3|A|\n`;
  
  // Invalid - Same store different terminal but duplicate terminal
  content += `DT|A|S1|T4|A|\n`;
  content += `DT|A|S1|T4|A|\n`;
  
  content += `TR|||||8|\n`;
  
  files.push({ 
    name: fileName, 
    content, 
    description: 'Duplicate records',
    testCase: 'TC8B',
    expectedResult: 'PARTIAL'
  });
  
  return files;
}

// ============ EXPORT ALL TEST CASES ============
export function getAllTestCases() {
  return [
    { id: '1', name: 'TC1 - All Valid Files', generator: generateTC1Files, priority: 'critical' },
    { id: '2', name: 'TC2 - 5 Valid + 5 Invalid Files', generator: generateTC2Files, priority: 'critical' },
    { id: '3', name: 'TC3 - All Invalid Files', generator: generateTC3Files, priority: 'critical' },
    { id: '4A', name: 'TC4A - Valid + Invalid in Same File', generator: generateTC4AFiles, priority: 'high' },
    { id: '4B', name: 'TC4B - Alternating Pattern', generator: generateTC4BFiles, priority: 'high' },
    { id: '4C', name: 'TC4C - Boundary + Invalid Combo', generator: generateTC4CFiles, priority: 'high' },
    { id: '4D', name: 'TC4D - Business Rule Violations', generator: generateTC4DFiles, priority: 'high' },
    { id: '5A', name: 'TC5A - Large File Processing', generator: generateTC5AFiles, priority: 'high' },
    { id: '5B', name: 'TC5B - Concurrent Processing', generator: generateTC5BFiles, priority: 'medium' },
    { id: '6A', name: 'TC6A - Sequential Errors + Recovery', generator: generateTC6AFiles, priority: 'high' },
    { id: '6B', name: 'TC6B - System Resource Errors', generator: generateTC6BFiles, priority: 'medium' },
    { id: '7A', name: 'TC7A - All Invalid Flags', generator: generateTC7AFiles, priority: 'high' },
    { id: '7B', name: 'TC7B - All Invalid Statuses', generator: generateTC7BFiles, priority: 'high' },
    { id: '7C', name: 'TC7C - Mixed Length Validation', generator: generateTC7CFiles, priority: 'high' },
    { id: '8A', name: 'TC8A - Sequential Operations', generator: generateTC8AFiles, priority: 'high' },
    { id: '8B', name: 'TC8B - Duplicate Records', generator: generateTC8BFiles, priority: 'high' },
  ];
}

// ============ MAIN GENERATOR FUNCTION ============
export async function generateAllTestFiles() {
  const testDataPath = './test-data/generated';
  fs.ensureDirSync(testDataPath);
  
  const allTestCases = getAllTestCases();
  let totalFiles = 0;
  
  for (const tc of allTestCases) {
    const tcPath = path.join(testDataPath, `tc${tc.id}`);
    fs.ensureDirSync(tcPath);
    
    const files = tc.generator();
    for (const file of files) {
      const filePath = path.join(tcPath, file.name);
      fs.writeFileSync(filePath, file.content);
      console.log(`✅ Created: ${file.name} (${file.description})`);
      totalFiles++;
    }
  }
  
  console.log(`\n📊 Total files generated: ${totalFiles}`);
  return totalFiles;
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateAllTestFiles().catch(console.error);
}