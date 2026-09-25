// scripts/test-runner.spec.js
import { test, expect } from '@playwright/test';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import pg from 'pg'; // PostgreSQL driver

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============ CONFIGURATION ============
const CONFIG = {
  winscp: {
    path: process.env.WINSCP_PATH || 'C:\\Program Files (x86)\\WinSCP\\WinSCP.com',
    host: process.env.SFTP_HOST || '192.168.99.83',
    port: process.env.SFTP_PORT || '22',
    username: process.env.SFTP_USERNAME || 'root',
    password: process.env.SFTP_PASSWORD || 'oev123',
    remotePath: process.env.SFTP_REMOTE_PATH || '/apps/MY-dev/OE/cls/USER_INPUT/OLSDB024/',
    localPath: process.env.LOCAL_PATH || 'C:\\BATCH-OCBC-PW1\\src\\',
  },

  putty: {
    path: process.env.PUTTY_PATH || 'C:\\Program Files\\PuTTY\\plink.exe',
    host: process.env.SSH_HOST || '192.168.99.83',
    username: process.env.SSH_USERNAME || 'root',
    password: process.env.SSH_PASSWORD || 'oev123',
    hostKey: process.env.SSH_HOST_KEY || 'SHA256:kGbLBMkLSnBoYmLg10qgHfmQmtUbawS69GYysVLkXu4',
  },

  batch: {
    scriptPath: process.env.BATCH_SCRIPT_PATH || '/apps/MY-dev/scripts',
    command: process.env.BATCH_COMMAND || './OLSDB024',
    retryAttempts: 3,
    retryDelay: 2000,
  },

  // POSTGRESQL DATABASE CONFIG
  database: {
    host: process.env.DB_HOST || '192.168.99.83',
    port: process.env.DB_PORT || '5432',
    database: process.env.DB_NAME || 'ols_my',
    username: process.env.DB_USERNAME || 'ols_user',
    password: process.env.DB_PASSWORD || 'ols168',
    schema: process.env.DB_SCHEMA || 'ols_schema',
  }
};

function getCurrentDate() {
  const now = new Date();
  return now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
}

const date = getCurrentDate();

// ============ HELPER FUNCTIONS ============

function log(message, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`, Object.keys(data).length ? data : '');
}

// ============ SAVE TEST RESULTS FUNCTION - GUARANTEED WORKING ============
// This uses a separate tracking file to reliably detect new executions
 
const EXECUTION_TRACKER_PATH = path.join(process.cwd(), '.execution-tracker.json');
 
async function saveTestResults(testCase, verification, fileRange, duration = 0) {
 
  try {
 
    const masterPath = path.join(process.cwd(), 'batch-results.json');
 
    const results = {
      testCase,
      fileRange,
      date: new Date().toISOString(),
      duration,
      success: verification.success || false,
 
      results: {
        totalFiles: verification.totalFiles || 0,
        passedFiles: verification.passedFiles || 0,
        partialPassFiles: verification.partialPassFiles || 0,
        failedFiles: verification.failedFiles || 0,
        rejectedFiles: verification.rejectedFiles || 0,
        errorFiles: verification.errorFiles || 0,
 
        totalRecords: verification.totalRecords || 0,
        trueCount: verification.trueCount || 0,
        falseCount: verification.falseCount || 0,
 
        outOnlyFiles: verification.outOnlyFiles || [],
        outAndRejFiles: verification.outAndRejFiles || [],
        rejOnlyFiles: verification.rejOnlyFiles || [],
        failedFilesList: verification.failedFilesList || [],
        errOnlyFiles: verification.errOnlyFiles || [],
 
        rejDetails: verification.rejDetails || [],
        errDetails: verification.errDetails || [],
        details: verification.details || []
      }
    };
 
    //------------------------------------------
    // Read tracker
    //------------------------------------------
 
    let tracker;
 
    if (fs.existsSync(EXECUTION_TRACKER_PATH)) {
 
      tracker = JSON.parse(
        fs.readFileSync(EXECUTION_TRACKER_PATH, 'utf8')
      );
 
    } else {
 
      tracker = {
        executionId: Date.now().toString(),
        testCases: []
      };
 
    }
 
    //------------------------------------------
    // Read existing results
    //------------------------------------------
 
    let existingResults = [];
 
    if (fs.existsSync(masterPath)) {
 
      existingResults = JSON.parse(
        fs.readFileSync(masterPath, 'utf8')
      );
 
      if (!Array.isArray(existingResults))
        existingResults = [];
 
    }
 
    //------------------------------------------
    // Update or Add
    //------------------------------------------
 
    const index = existingResults.findIndex(
      r => r.testCase === testCase
    );
 
    if (index >= 0) {
 
      existingResults[index] = results;
      console.log(`🔄 Updated ${testCase}`);
 
    } else {
 
      existingResults.push(results);
      console.log(`➕ Added ${testCase}`);
 
    }
 
    //------------------------------------------
    // Update tracker
    //------------------------------------------
 
    if (!tracker.testCases.includes(testCase))
      tracker.testCases.push(testCase);
 
    //------------------------------------------
    // Sort
    //------------------------------------------
 
    existingResults.sort((a, b) =>
      a.testCase.localeCompare(b.testCase)
    );
 
    //------------------------------------------
    // Save
    //------------------------------------------
 
    fs.writeFileSync(
      masterPath,
      JSON.stringify(existingResults, null, 2)
    );
 
    fs.writeFileSync(
      EXECUTION_TRACKER_PATH,
      JSON.stringify(tracker, null, 2)
    );
 
    console.log("====================================");
    console.log(`Saved ${testCase}`);
    console.log("Current Results:",
      existingResults.map(x => x.testCase));
    console.log("====================================");
 
    return masterPath;
 
  }
  catch (err) {
 
    console.error(err);
 
    return null;
 
  }
 
}

// Upload files via WinSCP
async function uploadFiles(filePatterns, testCase) {
  const results = [];
  const files = Array.isArray(filePatterns) ? filePatterns : [filePatterns];

  for (const filePattern of files) {
    try {
      log(`[${testCase}] Uploading: ${filePattern}`);

      const command = `"${CONFIG.winscp.path}" /command ` +
        `"option batch abort" ` +
        `"option confirm off" ` +
        `"open sftp://${CONFIG.winscp.username}:${CONFIG.winscp.password}@${CONFIG.winscp.host}/" ` +
        `"cd ${CONFIG.winscp.remotePath}" ` +
        `"put ""${CONFIG.winscp.localPath}${filePattern}""" ` +
        `"exit"`;

      const { stdout, stderr } = await execAsync(command, { timeout: 60000 });

      results.push({ filePattern, success: true, stdout, stderr });
      log(`[${testCase}] ✅ Upload successful: ${filePattern}`);

    } catch (error) {
      log(`[${testCase}] ❌ Upload failed: ${filePattern}`, { error: error.message });
      results.push({ filePattern, success: false, error: error.message });
    }
  }

  return results;
}

async function uploadSingleFile(fileName, testCase) {
  const result = await uploadFiles(fileName, testCase);
  return result[0];
}

// Execute batch via PuTTY.
//
// -batch -hostkey: bat buoc, khong phai cho dep. plink luu host key rieng trong registry
//   (khac WinSCP), nen lan dau SSH vao mot host no se dung o prompt
//   "Store key in cache? (y/n)" - khong co stdin thi bi treo hoac ngat giua handshake.
// timeout 600000: batch la job Java, phai cho JVM khoi dong; 30s la qua ngan.
// Khong nuot loi: batch khong chay duoc phai fail ngay tai day, thay vi de test fail muon
//   o buoc verify voi thong bao "no files found" khong lien quan gi den nguyen nhan that.
async function executeBatch(testCase) {
  const command = `cd ${CONFIG.batch.scriptPath} && ${CONFIG.batch.command}`;

  log(`[${testCase}] Executing batch...`);

  const plinkCommand = `"${CONFIG.putty.path}" ` +
    `-batch -hostkey "${CONFIG.putty.hostKey}" ` +
    `-ssh ${CONFIG.putty.username}@${CONFIG.putty.host} ` +
    `-pw ${CONFIG.putty.password} ` +
    `"${command}"`;

  try {
    const { stdout, stderr } = await execAsync(plinkCommand, {
      timeout: 600000,
      maxBuffer: 1024 * 1024 * 10
    });

    log(`[${testCase}] ✅ Batch executed`);
    return { success: true, stdout, stderr };

  } catch (error) {
    // Truoc day cho nay luon tra success:true va cac test khong he kiem tra gia tri do,
    // nen batch khong chay duoc trong y het batch chay xong ma khong sinh output nao.
    log(`[${testCase}] ❌ Batch execution FAILED: ${error.message}`);
    throw error;
  }
}

// Execute custom command
async function executeCustomCommand(command, testCase) {
  try {
    log(`[${testCase}] Executing: ${command}`);

    const plinkCommand = `"${CONFIG.putty.path}" ` +
      `-batch -hostkey "${CONFIG.putty.hostKey}" ` +
      `-ssh ${CONFIG.putty.username}@${CONFIG.putty.host} ` +
      `-pw ${CONFIG.putty.password} ` +
      `"${command}"`;

    const { stdout, stderr } = await execAsync(plinkCommand, {
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 10
    });

    return { success: true, stdout, stderr };

  } catch (error) {
    log(`[${testCase}] ❌ Command failed: ${command}`, { error: error.message });
    throw error;
  }
}

// Check if file exists on remote
async function checkRemoteFileExists(filePath, testCase) {
  try {
    const command = `test -f ${filePath} && echo "EXISTS" || echo "NOT_EXISTS"`;
    const result = await executeCustomCommand(command, testCase);
    return result.stdout.trim() === 'EXISTS';
  } catch (error) {
    return false;
  }
}

// Get remote file content
async function getRemoteFileContent(filePath, testCase) {
  try {
    const command = `cat ${filePath}`;
    const result = await executeCustomCommand(command, testCase);
    return result.stdout;
  } catch (error) {
    return '';
  }
}

// Check batch status
async function checkBatchStatus(testCase) {
  try {
    const statusCommand = 'ps aux | grep -E "OLSDB024|OLSDB" | grep -v grep | grep -v plink';
    const result = await executeCustomCommand(statusCommand, testCase);
    return result.stdout.trim().length > 0;
  } catch (error) {
    return false;
  }
}

// Wait for batch completion
async function waitForBatchCompletion(testCase, timeout = 120000) {
  const startTime = Date.now();
  log(`[${testCase}] Waiting for batch to complete (timeout: ${timeout}ms)`);

  const isRunning = await checkBatchStatus(testCase);
  if (!isRunning) {
    log(`[${testCase}] Batch not running. Assuming completed.`);
    return true;
  }

  while (Date.now() - startTime < timeout) {
    const stillRunning = await checkBatchStatus(testCase);
    if (!stillRunning) {
      log(`[${testCase}] ✅ Batch process ended`);
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  throw new Error(`Timeout waiting for batch to complete after ${timeout}ms`);
}

// Clean local source folder
async function cleanLocalFolder(testCase) {
  try {
    log(`[${testCase}] Cleaning local source folder...`);
    const files = fs.readdirSync(CONFIG.winscp.localPath);
    let deletedCount = 0;

    for (const file of files) {
      if (file.endsWith('.dat')) {
        const filePath = path.join(CONFIG.winscp.localPath, file);
        fs.unlinkSync(filePath);
        deletedCount++;
      }
    }
    log(`[${testCase}] ✅ Deleted ${deletedCount} local files`);
    return { success: true, deletedCount };
  } catch (error) {
    log(`[${testCase}] ⚠️ Cleanup warning`, { error: error.message });
    return { success: false, error: error.message };
  }
}


// ============ Cleanup remote files ============
async function cleanupRemoteFiles(testCase) {
  try {
    log(`[${testCase}] Cleaning up remote files`);

    const command = `"${CONFIG.winscp.path}" /command ` +
      `"option batch abort" ` +
      `"option confirm off" ` +
      `"open sftp://${CONFIG.winscp.username}:${CONFIG.winscp.password}@${CONFIG.winscp.host}/" ` +
      `"cd ${CONFIG.winscp.remotePath}" ` +
      `"rm OLSTERM-*.dat" ` +
      `"exit"`;

    await execAsync(command, { timeout: 30000 });
    log(`[${testCase}] ✅ Cleanup successful`);

  } catch (error) {
    if (!error.message.includes('No files matching')) {
      log(`[${testCase}] ⚠️ Cleanup warning`, { error: error.message });
    }
  }
}


// ============ VERIFY RESULTS - HANDLES .out, .rej, AND .err FILES ============
async function verifyResults(testCase, expectedResult = 'true', fileNumberRange = null) {
  const results = {
    success: false,
    filesFound: [],
    outFiles: [],
    rejFiles: [],
    errFiles: [],
    totalRecords: 0,
    trueCount: 0,
    falseCount: 0,
    totalFiles: 0,
    passedFiles: 0,
    partialPassFiles: 0,
    rejectedFiles: 0,
    failedFiles: 0,
    errorFiles: 0,
    outOnlyFiles: [],
    outAndRejFiles: [],
    rejOnlyFiles: [],
    failedFilesList: [],
    errOnlyFiles: [],
    rejDetails: [],
    errDetails: [],
    details: []
  };
 
  try {
    const currentDate = getCurrentDate();
    const baseDir = '/apps/MY-dev/OE/cls/USER_INPUT/OLSDB024/';
   
    log(`[${testCase}] 🔍 Looking for files with date: ${currentDate}`);
    log(`[${testCase}] 🔍 Directory: ${baseDir}`);
   
    const findCommand = `find ${baseDir} -maxdepth 1 -type f \\( -name "OLSTERM-${currentDate}-*.out" -o -name "OLSTERM-${currentDate}-*.rej" -o -name "*.err" \\) 2>/dev/null`;
    log(`[${testCase}] 🔍 Running: ${findCommand}`);
   


    const findResult = await executeCustomCommand(findCommand, testCase);
    let outputFiles = findResult.stdout.trim().split('\n').filter(f => f.trim() !== '');
    log(`[${testCase}] 📁 Found ${outputFiles.length} total output files in directory`);
   
    if (outputFiles.length === 0) {
      log(`[${testCase}] ⚠️ No files found with find, trying ls...`);
      const lsCommand = `ls ${baseDir}OLSTERM-${currentDate}-*.{out,rej} ${baseDir}*.err 2>/dev/null`;
      const lsResult = await executeCustomCommand(lsCommand, testCase);
      outputFiles = lsResult.stdout.trim().split('\n').filter(f => f.trim() !== '');
      log(`[${testCase}] 📁 LS found ${outputFiles.length} files`);
    }
   
    const fileGroups = {};
    for (const file of outputFiles) {
      let fileNum = null;
      let fileType = 'unknown';
     
      if (file.endsWith('.out')) fileType = 'out';
      else if (file.endsWith('.rej')) fileType = 'rej';
      else if (file.endsWith('.err')) fileType = 'err';
     
      let match = file.match(/OLSTERM-\d{8}-(\d{2})_/);
      if (match) {
        fileNum = parseInt(match[1], 10);
      }
     
      if (!match) {
        match = file.match(/OLSTERM-\d{8}-(\d{3})_/);
        if (match) {
          fileNum = parseInt(match[1], 10);
        }
      }
     
      if (!match && fileType === 'err') {
        match = file.match(/OLSDB024_(\d+)_\d{8}\.err/);
        if (match) {
          fileNum = parseInt(match[1], 10);
        }
      }
     
      if (fileNum !== null) {
        if (!fileGroups[fileNum]) {
          fileGroups[fileNum] = [];
        }
        fileGroups[fileNum].push({ file, type: fileType });
      } else {
        log(`[${testCase}] ⚠️ Could not extract file number from: ${file}`);
      }
    }
   
    log(`[${testCase}] 📁 Found ${Object.keys(fileGroups).length} unique file numbers`);
   
    let filteredGroups = fileGroups;
    if (fileNumberRange) {
      const { start, end } = fileNumberRange;
      filteredGroups = {};
      for (const [fileNum, files] of Object.entries(fileGroups)) {
        const num = parseInt(fileNum, 10);
        if (num >= start && num <= end) {
          filteredGroups[fileNum] = files;
        }
      }
      log(`[${testCase}] 📁 Filtered to ${Object.keys(filteredGroups).length} files in range ${start}-${end}`);
    }
   
    const fileNumbers = Object.keys(filteredGroups).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    results.totalFiles = fileNumbers.length;
   
    log(`[${testCase}] 📁 Processing ${results.totalFiles} file numbers in range`);
   
    for (const fileNum of fileNumbers) {
      const files = filteredGroups[fileNum];
      const hasOut = files.some(f => f.type === 'out');
      const hasRej = files.some(f => f.type === 'rej');
      const hasErr = files.some(f => f.type === 'err');
     
      const fileResult = {
        fileNumber: fileNum,
        hasOut: hasOut,
        hasRej: hasRej,
        hasErr: hasErr,
        recordCount: 0,
        trueCount: 0,
        falseCount: 0,
        status: 'unknown',
        rejectionReason: null,
        errorMessage: null
      };
     
      if (hasErr) {
        const errFile = files.find(f => f.type === 'err');
        results.errFiles.push(errFile.file);
       
        const readErrCommand = `cat ${errFile.file}`;
        const errResult = await executeCustomCommand(readErrCommand, testCase);
        fileResult.errorMessage = errResult.stdout.trim();
        results.errDetails.push({
          fileNumber: fileNum,
          message: fileResult.errorMessage
        });
      }
     
      if (hasRej) {
        const rejFile = files.find(f => f.type === 'rej');
        results.rejFiles.push(rejFile.file);
       
        const readRejCommand = `cat ${rejFile.file}`;
        const rejResult = await executeCustomCommand(readRejCommand, testCase);
        fileResult.rejectionReason = rejResult.stdout.trim();
        results.rejDetails.push({
          fileNumber: fileNum,
          message: fileResult.rejectionReason
        });
      }
     
      if (hasOut) {
        const outFile = files.find(f => f.type === 'out');
        results.outFiles.push(outFile.file);
       
        const readCommand = `cat ${outFile.file}`;
        const readResult = await executeCustomCommand(readCommand, testCase);
        let content = readResult.stdout;
       
        if (content) {
          content = content.replace(/\r/g, '');
          const lines = content.split('\n');
         
          for (const line of lines) {
            if (!line.trim()) continue;
            // ✅ FIX: Also detect non-DT records (like XX, which is used in TS80)
            if (line.startsWith('DT|') || line.includes('|A|') || line.includes('|C|') || line.includes('|D|')) {
              fileResult.recordCount++;
             
              const trimmedLine = line.trim();
              if (trimmedLine.endsWith('|true|') || trimmedLine.includes('|true|')) {
                fileResult.trueCount++;
                results.trueCount++;
              } else if (trimmedLine.endsWith('|false|') || trimmedLine.includes('|false|')) {
                fileResult.falseCount++;
                results.falseCount++;
              }
            }
          }
        }
      }
     
      // ============================================================
      // DETERMINE STATUS
      // ============================================================
      if (hasErr && !hasOut) {
        fileResult.status = 'ERROR';
        results.errorFiles++;
        results.errOnlyFiles.push(fileNum);
      } else if (hasOut && !hasRej && fileResult.falseCount === 0 && fileResult.recordCount > 0) {
        fileResult.status = 'PASS';
        results.passedFiles++;
        results.outOnlyFiles.push(fileNum);
      } else if (hasOut && hasRej && fileResult.trueCount === 0 && fileResult.falseCount > 0) {
        fileResult.status = 'FAILED';
        results.failedFiles++;
        results.failedFilesList.push(fileNum);
      } else if (hasOut && hasRej && fileResult.trueCount > 0 && fileResult.falseCount > 0) {
        fileResult.status = 'PARTIAL';
        results.partialPassFiles++;
        results.outAndRejFiles.push(fileNum);
      } else if (!hasOut && hasRej) {
        fileResult.status = 'REJECTED';
        results.rejectedFiles++;
        results.rejOnlyFiles.push(fileNum);
      } else if (hasOut && !hasRej && fileResult.trueCount === 0 && fileResult.falseCount === 0) {
        fileResult.status = 'EMPTY';
      }
     
      results.details.push(fileResult);
      results.totalRecords += fileResult.recordCount;
     
      let logMsg = `   📄 File ${fileNum}: ${fileResult.status} | Records: ${fileResult.recordCount} | True: ${fileResult.trueCount} | False: ${fileResult.falseCount} | Out: ${hasOut ? '✅' : '❌'} | Rej: ${hasRej ? '✅' : '❌'} | Err: ${hasErr ? '⚠️' : '❌'}`;
     
      if (fileResult.rejectionReason) {
        const shortReason = fileResult.rejectionReason.substring(0, 100) + (fileResult.rejectionReason.length > 100 ? '...' : '');
        logMsg += `\n   📄 Rejection Reason: ${shortReason}`;
      }
     
      if (fileResult.errorMessage) {
        const shortError = fileResult.errorMessage.substring(0, 100) + (fileResult.errorMessage.length > 100 ? '...' : '');
        logMsg += `\n   📄 Error Message: ${shortError}`;
      }
     
      log(`[${testCase}] ${logMsg}`);
    }
   
    log(`[${testCase}] 📊 SUMMARY:`);
    log(`[${testCase}]   - Total Files: ${results.totalFiles}`);
    log(`[${testCase}]   - ✅ Fully Passed: ${results.passedFiles} files`);
    log(`[${testCase}]   - ⚠️  Partial Pass: ${results.partialPassFiles} files`);
    log(`[${testCase}]   - ❌ Failed: ${results.failedFiles} files`);
    log(`[${testCase}]   - 🚫 Fully Rejected: ${results.rejectedFiles} files`);
    log(`[${testCase}]   - 🔴 System Error: ${results.errorFiles} files`);
    log(`[${testCase}]   - Total Records: ${results.totalRecords}`);
    log(`[${testCase}]   - |true| records: ${results.trueCount}`);
    log(`[${testCase}]   - |false| records: ${results.falseCount}`);
   
    if (results.passedFiles > 0) {
      log(`[${testCase}]   - ✅ Fully Passed Files: ${results.outOnlyFiles.join(', ')}`);
    }
    if (results.partialPassFiles > 0) {
      log(`[${testCase}]   - ⚠️  Partial Pass Files: ${results.outAndRejFiles.join(', ')}`);
    }
    if (results.failedFiles > 0) {
      log(`[${testCase}]   - ❌ Failed Files: ${results.failedFilesList.join(', ')}`);
      for (const rej of results.rejDetails) {
        if (results.failedFilesList.includes(rej.fileNumber)) {
          log(`[${testCase}]   - 📄 File ${rej.fileNumber} Rejection: ${rej.message.substring(0, 200)}${rej.message.length > 200 ? '...' : ''}`);
        }
      }
    }
    if (results.rejectedFiles > 0) {
      log(`[${testCase}]   - 🚫 Fully Rejected Files: ${results.rejOnlyFiles.join(', ')}`);
      for (const rej of results.rejDetails) {
        if (results.rejOnlyFiles.includes(rej.fileNumber)) {
          log(`[${testCase}]   - 📄 File ${rej.fileNumber} Rejection: ${rej.message.substring(0, 200)}${rej.message.length > 200 ? '...' : ''}`);
        }
      }
    }
    if (results.errorFiles > 0) {
      log(`[${testCase}]   - 🔴 System Error Files: ${results.errOnlyFiles.join(', ')}`);
      for (const err of results.errDetails) {
        log(`[${testCase}]   - 📄 File ${err.fileNumber} Error: ${err.message.substring(0, 200)}${err.message.length > 200 ? '...' : ''}`);
      }
    }
   
    if (expectedResult === 'true') {
      results.success = (results.rejectedFiles === 0 && results.failedFiles === 0 && results.errorFiles === 0 && results.totalFiles > 0);
    } else if (expectedResult === 'false') {
      results.success = (results.rejectedFiles > 0 || results.failedFiles > 0 || results.falseCount > 0);
    } else if (expectedResult === 'error') {
      results.success = (results.errorFiles > 0);
    }
   
    if (results.success) {
      log(`[${testCase}] ✅ Verification passed`);
    } else {
      log(`[${testCase}] ❌ Verification failed`);
    }
   
    return results;
 
  } catch (error) {
    log(`[${testCase}] ❌ Verification failed`, { error: error.message });
    results.success = false;
    return results;
  }
}

// ============ VERIFY RESULTS - HANDLES .out, .rej, AND .err FILES for Future/ Past Dates ============
async function verifyResults2(testCase, expectedResult = 'true', fileNumberRange = null) {
  const results = {
    success: false,
    filesFound: [],
    outFiles: [],
    rejFiles: [],
    errFiles: [],
    totalRecords: 0,
    trueCount: 0,
    falseCount: 0,
    totalFiles: 0,
    passedFiles: 0,
    partialPassFiles: 0,
    rejectedFiles: 0,
    failedFiles: 0,
    errorFiles: 0,
    outOnlyFiles: [],
    outAndRejFiles: [],
    rejOnlyFiles: [],
    failedFilesList: [],
    errOnlyFiles: [],
    rejDetails: [],
    errDetails: [],
    details: []
  };
 
  try {
    const currentDate = getCurrentDate();
    const baseDir = '/apps/MY-dev/OE/cls/USER_INPUT/OLSDB024/';
   
    log(`[${testCase}] 🔍 Looking for files with date: ${currentDate}`);
    log(`[${testCase}] 🔍 Directory: ${baseDir}`);
   
    const findCommand = `find ${baseDir} -maxdepth 1 -type f \\( -name "OLSTERM-*-*_${currentDate}.out" -o -name "OLSTERM-*-*_${currentDate}.rej" -o -name "OLSDB024_*_${currentDate}.err" \\) 2>/dev/null`;
    log(`[${testCase}] 🔍 Running: ${findCommand}`);
   

    const findResult = await executeCustomCommand(findCommand, testCase);
    let outputFiles = findResult.stdout.trim().split('\n').filter(f => f.trim() !== '');
    log(`[${testCase}] 📁 Found ${outputFiles.length} total output files in directory`);
   
    if (outputFiles.length === 0) {
      log(`[${testCase}] ⚠️ No files found with find, trying ls...`);
//const lsCommand = `ls ${baseDir}OLSTERM-${currentDate}-*.{out,rej} ${baseDir}*.err 2>/dev/null`;

const lsCommand = `ls ${baseDir}OLSTERM-*-*_${currentDate}.{out,rej} ${baseDir}OLSDB024_*_${currentDate}.err 2>/dev/null`;


      const lsResult = await executeCustomCommand(lsCommand, testCase);
      outputFiles = lsResult.stdout.trim().split('\n').filter(f => f.trim() !== '');
      log(`[${testCase}] 📁 LS found ${outputFiles.length} files`);
    }
   
    const fileGroups = {};
    for (const file of outputFiles) {
      let fileNum = null;
      let fileType = 'unknown';
     
      if (file.endsWith('.out')) fileType = 'out';
      else if (file.endsWith('.rej')) fileType = 'rej';
      else if (file.endsWith('.err')) fileType = 'err';
     
      let match = file.match(/OLSTERM-\d{8}-(\d{2})_/);
      if (match) {
        fileNum = parseInt(match[1], 10);
      }
     
      if (!match) {
        match = file.match(/OLSTERM-\d{8}-(\d{3})_/);
        if (match) {
          fileNum = parseInt(match[1], 10);
        }
      }
     
      if (!match && fileType === 'err') {
        match = file.match(/OLSDB024_(\d+)_\d{8}\.err/);
        if (match) {
          fileNum = parseInt(match[1], 10);
        }
      }
     
      if (fileNum !== null) {
        if (!fileGroups[fileNum]) {
          fileGroups[fileNum] = [];
        }
        fileGroups[fileNum].push({ file, type: fileType });
      } else {
        log(`[${testCase}] ⚠️ Could not extract file number from: ${file}`);
      }
    }
   
    log(`[${testCase}] 📁 Found ${Object.keys(fileGroups).length} unique file numbers`);
   
    let filteredGroups = fileGroups;
    if (fileNumberRange) {
      const { start, end } = fileNumberRange;
      filteredGroups = {};
      for (const [fileNum, files] of Object.entries(fileGroups)) {
        const num = parseInt(fileNum, 10);
        if (num >= start && num <= end) {
          filteredGroups[fileNum] = files;
        }
      }
      log(`[${testCase}] 📁 Filtered to ${Object.keys(filteredGroups).length} files in range ${start}-${end}`);
    }
   
    const fileNumbers = Object.keys(filteredGroups).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    results.totalFiles = fileNumbers.length;
   
    log(`[${testCase}] 📁 Processing ${results.totalFiles} file numbers in range`);
   
    for (const fileNum of fileNumbers) {
      const files = filteredGroups[fileNum];
      const hasOut = files.some(f => f.type === 'out');
      const hasRej = files.some(f => f.type === 'rej');
      const hasErr = files.some(f => f.type === 'err');
     
      const fileResult = {
        fileNumber: fileNum,
        hasOut: hasOut,
        hasRej: hasRej,
        hasErr: hasErr,
        recordCount: 0,
        trueCount: 0,
        falseCount: 0,
        status: 'unknown',
        rejectionReason: null,
        errorMessage: null
      };
     
      if (hasErr) {
        const errFile = files.find(f => f.type === 'err');
        results.errFiles.push(errFile.file);
       
        const readErrCommand = `cat ${errFile.file}`;
        const errResult = await executeCustomCommand(readErrCommand, testCase);
        fileResult.errorMessage = errResult.stdout.trim();
        results.errDetails.push({
          fileNumber: fileNum,
          message: fileResult.errorMessage
        });
      }
     
      if (hasRej) {
        const rejFile = files.find(f => f.type === 'rej');
        results.rejFiles.push(rejFile.file);
       
        const readRejCommand = `cat ${rejFile.file}`;
        const rejResult = await executeCustomCommand(readRejCommand, testCase);
        fileResult.rejectionReason = rejResult.stdout.trim();
        results.rejDetails.push({
          fileNumber: fileNum,
          message: fileResult.rejectionReason
        });
      }
     
      if (hasOut) {
        const outFile = files.find(f => f.type === 'out');
        results.outFiles.push(outFile.file);
       
        const readCommand = `cat ${outFile.file}`;
        const readResult = await executeCustomCommand(readCommand, testCase);
        let content = readResult.stdout;
       
        if (content) {
          content = content.replace(/\r/g, '');
          const lines = content.split('\n');
         
          for (const line of lines) {
            if (!line.trim()) continue;
            // ✅ FIX: Also detect non-DT records (like XX, which is used in TS80)
            if (line.startsWith('DT|') || line.includes('|A|') || line.includes('|C|') || line.includes('|D|')) {
              fileResult.recordCount++;
             
              const trimmedLine = line.trim();
              if (trimmedLine.endsWith('|true|') || trimmedLine.includes('|true|')) {
                fileResult.trueCount++;
                results.trueCount++;
              } else if (trimmedLine.endsWith('|false|') || trimmedLine.includes('|false|')) {
                fileResult.falseCount++;
                results.falseCount++;
              }
            }
          }
        }
      }
     
      // ============================================================
      // DETERMINE STATUS
      // ============================================================
      if (hasErr && !hasOut) {
        fileResult.status = 'ERROR';
        results.errorFiles++;
        results.errOnlyFiles.push(fileNum);
      } else if (hasOut && !hasRej && fileResult.falseCount === 0 && fileResult.recordCount > 0) {
        fileResult.status = 'PASS';
        results.passedFiles++;
        results.outOnlyFiles.push(fileNum);
      } else if (hasOut && hasRej && fileResult.trueCount === 0 && fileResult.falseCount > 0) {
        fileResult.status = 'FAILED';
        results.failedFiles++;
        results.failedFilesList.push(fileNum);
      } else if (hasOut && hasRej && fileResult.trueCount > 0 && fileResult.falseCount > 0) {
        fileResult.status = 'PARTIAL';
        results.partialPassFiles++;
        results.outAndRejFiles.push(fileNum);
      } else if (!hasOut && hasRej) {
        fileResult.status = 'REJECTED';
        results.rejectedFiles++;
        results.rejOnlyFiles.push(fileNum);
      } else if (hasOut && !hasRej && fileResult.trueCount === 0 && fileResult.falseCount === 0) {
        fileResult.status = 'EMPTY';
      }
     
      results.details.push(fileResult);
      results.totalRecords += fileResult.recordCount;
     
      let logMsg = `   📄 File ${fileNum}: ${fileResult.status} | Records: ${fileResult.recordCount} | True: ${fileResult.trueCount} | False: ${fileResult.falseCount} | Out: ${hasOut ? '✅' : '❌'} | Rej: ${hasRej ? '✅' : '❌'} | Err: ${hasErr ? '⚠️' : '❌'}`;
     
      if (fileResult.rejectionReason) {
        const shortReason = fileResult.rejectionReason.substring(0, 100) + (fileResult.rejectionReason.length > 100 ? '...' : '');
        logMsg += `\n   📄 Rejection Reason: ${shortReason}`;
      }
     
      if (fileResult.errorMessage) {
        const shortError = fileResult.errorMessage.substring(0, 100) + (fileResult.errorMessage.length > 100 ? '...' : '');
        logMsg += `\n   📄 Error Message: ${shortError}`;
      }
     
      log(`[${testCase}] ${logMsg}`);
    }
   
    log(`[${testCase}] 📊 SUMMARY:`);
    log(`[${testCase}]   - Total Files: ${results.totalFiles}`);
    log(`[${testCase}]   - ✅ Fully Passed: ${results.passedFiles} files`);
    log(`[${testCase}]   - ⚠️  Partial Pass: ${results.partialPassFiles} files`);
    log(`[${testCase}]   - ❌ Failed: ${results.failedFiles} files`);
    log(`[${testCase}]   - 🚫 Fully Rejected: ${results.rejectedFiles} files`);
    log(`[${testCase}]   - 🔴 System Error: ${results.errorFiles} files`);
    log(`[${testCase}]   - Total Records: ${results.totalRecords}`);
    log(`[${testCase}]   - |true| records: ${results.trueCount}`);
    log(`[${testCase}]   - |false| records: ${results.falseCount}`);
   
    if (results.passedFiles > 0) {
      log(`[${testCase}]   - ✅ Fully Passed Files: ${results.outOnlyFiles.join(', ')}`);
    }
    if (results.partialPassFiles > 0) {
      log(`[${testCase}]   - ⚠️  Partial Pass Files: ${results.outAndRejFiles.join(', ')}`);
    }
    if (results.failedFiles > 0) {
      log(`[${testCase}]   - ❌ Failed Files: ${results.failedFilesList.join(', ')}`);
      for (const rej of results.rejDetails) {
        if (results.failedFilesList.includes(rej.fileNumber)) {
          log(`[${testCase}]   - 📄 File ${rej.fileNumber} Rejection: ${rej.message.substring(0, 200)}${rej.message.length > 200 ? '...' : ''}`);
        }
      }
    }
    if (results.rejectedFiles > 0) {
      log(`[${testCase}]   - 🚫 Fully Rejected Files: ${results.rejOnlyFiles.join(', ')}`);
      for (const rej of results.rejDetails) {
        if (results.rejOnlyFiles.includes(rej.fileNumber)) {
          log(`[${testCase}]   - 📄 File ${rej.fileNumber} Rejection: ${rej.message.substring(0, 200)}${rej.message.length > 200 ? '...' : ''}`);
        }
      }
    }
    if (results.errorFiles > 0) {
      log(`[${testCase}]   - 🔴 System Error Files: ${results.errOnlyFiles.join(', ')}`);
      for (const err of results.errDetails) {
        log(`[${testCase}]   - 📄 File ${err.fileNumber} Error: ${err.message.substring(0, 200)}${err.message.length > 200 ? '...' : ''}`);
      }
    }
   
    if (expectedResult === 'true') {
      results.success = (results.rejectedFiles === 0 && results.failedFiles === 0 && results.errorFiles === 0 && results.totalFiles > 0);
    } else if (expectedResult === 'false') {
      results.success = (results.rejectedFiles > 0 || results.failedFiles > 0 || results.falseCount > 0);
    } else if (expectedResult === 'error') {
      results.success = (results.errorFiles > 0);
    }
   
    if (results.success) {
      log(`[${testCase}] ✅ Verification passed`);
    } else {
      log(`[${testCase}] ❌ Verification failed`);
    }
   
    return results;
 
  } catch (error) {
    log(`[${testCase}] ❌ Verification failed`, { error: error.message });
    results.success = false;
    return results;
  }
}


// ============ Copy files to local source folder ============
async function copyFilesToLocal(tcId) {
  const sourcePath = path.join(__dirname, '../test-data/generated/OLSDB024', `tc${tcId}`);
  const destPath = CONFIG.winscp.localPath;

  log(`📁 Looking for source: ${sourcePath}`);
  fs.ensureDirSync(destPath);

  if (!fs.existsSync(sourcePath)) {
    log(`⚠️ Source path not found: ${sourcePath}`);
    return [];
  }

  const files = fs.readdirSync(sourcePath);
  const datFiles = files.filter(file => file.endsWith('.dat'));
  log(`📁 Found ${datFiles.length} .dat files in source`);

  const copiedFiles = [];

  for (const file of datFiles) {
    const srcFile = path.join(sourcePath, file);
    const destFile = path.join(destPath, file);

    try {
      fs.copyFileSync(srcFile, destFile);
      copiedFiles.push(file);
      log(`📁 Copied: ${file} -> ${destPath}`);
    } catch (error) {
      log(`❌ Failed to copy ${file}: ${error.message}`);
    }
  }

  log(`📊 Total files copied: ${copiedFiles.length}`);
  return copiedFiles;
}


// ============ POSTGRESQL DATABASE HELPER FUNCTIONS (OPTION B) ============

// Database connection function for PostgreSQL
async function getDbConnection() {
  const client = new pg.Client({
    host: CONFIG.database.host,
    port: CONFIG.database.port,
    user: CONFIG.database.username,
    password: CONFIG.database.password,
    database: CONFIG.database.database,
    schema: CONFIG.database.schema,
  });

  try {
    await client.connect();
    log('✅ PostgreSQL connected successfully');
    return client;
  } catch (error) {
    log('❌ PostgreSQL connection failed', { error: error.message });
    throw error;
  }
}

// Execute database query
async function executeDbQuery(query, testCase) {
  let client;
  try {
    client = await getDbConnection();
    log(`[${testCase}] Executing DB query: ${query.substring(0, 100)}...`);

    const result = await client.query(query);
    return {
      success: true,
      rows: result.rows,
      count: result.rowCount || result.rows.length
    };

  } catch (error) {
    log(`[${testCase}] ❌ DB query failed`, { error: error.message });
    return { success: false, error: error.message, rows: [] };
  } finally {
    if (client) {
      await client.end();
      log(`[${testCase}] PostgreSQL connection closed`);
    }
  }
}

// Verify database results for batch_resource
async function verifyBatchResource(batchId, testCase) {
  const query = `
    SELECT * FROM batch_resource 
    WHERE batch_id = '${batchId}' 
    ORDER BY record_no DESC 
    LIMIT 20
  `;

  const result = await executeDbQuery(query, testCase);

  if (result.success && result.rows.length > 0) {
    log(`[${testCase}] 📊 Batch Resource Results:`, {
      count: result.rows.length,
      latestRecords: result.rows.slice(0, 5).map(r => ({
        record_no: r.record_no,
        terminal_name: r.terminal_name,
        status: r.status,
        created_date: r.created_date
      }))
    });
  } else {
    log(`[${testCase}] ⚠️ No records found in batch_resource`);
  }

  return result;
}

// Verify database results for eft_pos
async function verifyEftPos(testCase) {
  const query = `
    SELECT terminal_name, * FROM eft_pos 
    ORDER BY record_no DESC 
    LIMIT 20
  `;

  const result = await executeDbQuery(query, testCase);

  if (result.success && result.rows.length > 0) {
    log(`[${testCase}] 📊 EFT POS Results:`, {
      count: result.rows.length,
      latestRecords: result.rows.slice(0, 5).map(r => ({
        record_no: r.record_no,
        terminal_name: r.terminal_name,
        status: r.status,
        updated_date: r.updated_date
      }))
    });
  } else {
    log(`[${testCase}] ⚠️ No records found in eft_pos`);
  }

  return result;
}

// Comprehensive database verification
async function verifyDatabaseResults(testCase, batchId = 'OLSDB024') {
  log(`[${testCase}] 🔍 Starting PostgreSQL verification...`);

  const results = {
    batchResource: null,
    eftPos: null,
    success: false,
    summary: {}
  };

  try {
    // Verify batch_resource
    results.batchResource = await verifyBatchResource(batchId, testCase);

    // Verify eft_pos
    results.eftPos = await verifyEftPos(testCase);

    // Determine overall success
    results.success = results.batchResource.success && results.eftPos.success;

    // Create summary
    results.summary = {
      batchResourceCount: results.batchResource?.rows?.length || 0,
      eftPosCount: results.eftPos?.rows?.length || 0,
      timestamp: new Date().toISOString()
    };

    log(`[${testCase}] ✅ PostgreSQL verification complete`, results.summary);

  } catch (error) {
    log(`[${testCase}] ❌ PostgreSQL verification failed`, { error: error.message });
    results.success = false;
  }

  return results;
}

// Format and display results in a readable table
function displayResultsTable(results, testCase) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`📊 POSTGRESQL VERIFICATION RESULTS - ${testCase}`);
  console.log(`${'='.repeat(80)}`);

  if (results.batchResource?.rows?.length > 0) {
    console.log('\n📋 BATCH_RESOURCE TABLE:');
    console.log('-'.repeat(80));
    console.log('Record No | Terminal Name | Status | Created Date');
    console.log('-'.repeat(80));

    results.batchResource.rows.slice(0, 10).forEach(row => {
      console.log(
        `${String(row.record_no || '').padEnd(9)} | ` +
        `${String(row.terminal_name || '').padEnd(13)} | ` +
        `${String(row.status || '').padEnd(6)} | ` +
        `${row.created_date || ''}`
      );
    });
    console.log('-'.repeat(80));
    console.log(`Total records: ${results.batchResource.rows.length}`);
  } else {
    console.log('\n📋 BATCH_RESOURCE TABLE: No records found');
  }

  if (results.eftPos?.rows?.length > 0) {
    console.log('\n📋 EFT_POS TABLE:');
    console.log('-'.repeat(80));
    console.log('Record No | Terminal Name | Status | Updated Date');
    console.log('-'.repeat(80));

    results.eftPos.rows.slice(0, 10).forEach(row => {
      console.log(
        `${String(row.record_no || '').padEnd(9)} | ` +
        `${String(row.terminal_name || '').padEnd(13)} | ` +
        `${String(row.status || '').padEnd(6)} | ` +
        `${row.updated_date || ''}`
      );
    });
    console.log('-'.repeat(80));
    console.log(`Total records: ${results.eftPos.rows.length}`);
  } else {
    console.log('\n📋 EFT_POS TABLE: No records found');
  }

  console.log(`\n📈 Summary:`, results.summary);
  console.log(`${'='.repeat(80)}\n`);
}

// Execute a custom SQL query (for flexibility)
async function executeCustomQuery(query, testCase) {
  return await executeDbQuery(query, testCase);
}

// Get the latest records from batch_resource
async function getLatestBatchRecords(limit = 10, testCase) {
  const query = `
    SELECT * FROM batch_resource 
    ORDER BY record_no DESC 
    LIMIT ${limit}
  `;
  return await executeDbQuery(query, testCase);
}

// Get the latest records from eft_pos
async function getLatestEftPosRecords(limit = 10, testCase) {
  const query = `
    SELECT terminal_name, * FROM eft_pos 
    ORDER BY record_no DESC 
    LIMIT ${limit}
  `;
  return await executeDbQuery(query, testCase);
}

// Get record count from batch_resource
async function getBatchResourceCount(batchId, testCase) {
  const query = `
    SELECT COUNT(*) as total FROM batch_resource 
    WHERE batch_id = '${batchId}'
  `;
  const result = await executeDbQuery(query, testCase);
  return result.success ? parseInt(result.rows[0]?.total || 0) : 0;
}

// Get record count from eft_pos
async function getEftPosCount(testCase) {
  const query = `
    SELECT COUNT(*) as total FROM eft_pos
  `;
  const result = await executeDbQuery(query, testCase);
  return result.success ? parseInt(result.rows[0]?.total || 0) : 0;
}

// Comprehensive verification with counts
async function verifyDatabaseWithCounts(testCase, batchId = 'OLSDB024') {
  const results = await verifyDatabaseResults(testCase, batchId);

  // Add counts
  results.counts = {
    batchResourceTotal: await getBatchResourceCount(batchId, testCase),
    eftPosTotal: await getEftPosCount(testCase),
  };

  results.summary = {
    ...results.summary,
    batchResourceTotal: results.counts.batchResourceTotal,
    eftPosTotal: results.counts.eftPosTotal,
  };

  return results;
}

// Test database connection
async function testDatabaseConnection() {
  let client;
  try {
    client = await getDbConnection();
    const result = await client.query('SELECT NOW() as current_time, version() as pg_version');
    log('✅ PostgreSQL Connection Successful', {
      time: result.rows[0].current_time,
      version: result.rows[0].pg_version
    });
    return true;
  } catch (error) {
    log('❌ PostgreSQL Connection Failed', { error: error.message });
    return false;
  } finally {
    if (client) {
      await client.end();
    }
  }
}

// ============ TEST SUITE ============

test.describe('Terminal Batch Processing - Complete Test Suite', () => {

  test.beforeAll(async () => {
    log('🚀 Starting test suite setup...');
    log(`📅 Current date for files: ${date}`);

    fs.ensureDirSync('./test-data/generated');
    fs.ensureDirSync('./logs');
    fs.ensureDirSync('./reports');

    // Start each Playwright execution with a clean dashboard
    const masterPath = path.join(process.cwd(), 'batch-results.json');

    if (fs.existsSync(masterPath)) {
      fs.removeSync(masterPath);
    }

    if (fs.existsSync(EXECUTION_TRACKER_PATH)) {
      fs.removeSync(EXECUTION_TRACKER_PATH);
    }

    log('✅ Setup complete');
  });


 // ============================================================
  // TC1 - 10 FILES (01-10) - ALL VALID - Expected: TRUE
  // ============================================================
  test.describe('TC1 10 Files All Valid', () => {
  
  test('TC1: Process 10 files)', { tag: ['@critical', '@smoke'] }, async () => {
    const tcId = '1';
    log(`\n${'='.repeat(60)}`);
    log(`🚀 STARTING TC${tcId} - All Valid`);
    log(`${'='.repeat(60)}`);
  
    const startTime = Date.now();
  
    try {
      await cleanLocalFolder(`TC${tcId}`);
  
      log('\n📋 Step 1: Copying files to local...');
      const copiedFiles = await copyFilesToLocal(tcId);
      log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
      log('\n📋 Step 2: Uploading files...');
      const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
      log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
      log('\n📋 Step 3: Executing batch...');
      const batchResult = await executeBatch(`TC${tcId}`);
      log(`✅ Batch executed successfully`);
  
      // STEP 4: SMART WAIT - Wait for ALL files to be generated
      log('\n📋 Step 4: Waiting for output files to be generated...');
      
      const expectedFiles = 10; // Number of files you're processing (42-51)
      const maxWaitTime = 300000; // Maximum wait: 5 minutes
      const checkInterval = 3000; // Check every 3 seconds
      let verification = null;
      let filesFound = 0;
      const waitStartTime = Date.now();
  
      while (Date.now() - waitStartTime < maxWaitTime) {
          // Check current files
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 1, end: 10 });
          filesFound = verification.totalFiles;
          
          const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
          log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
          if (filesFound === expectedFiles) {
              log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
              break;
          }
          
          // Wait before checking again
          await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
  
      // After waiting, show final status
      const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
      if (filesFound < expectedFiles) {
          log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
          if (verification) {
              log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
              if (verification.rejOnlyFiles.length > 0) {
                  log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
              }
          }
      } else {
          log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
      }
  
      // STEP 5: FINAL VERIFICATION (uses the last verification result)
      log('\n📋 Step 5: Final verification...');
      
      // If verification is null (shouldn't happen), run it one more time
      if (!verification) {
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 1, end: 10 });
      }
      
      // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
      const duration = Date.now() - startTime;
      await saveTestResults(`TC${tcId}`, verification, {start: 1, end: 10 }, duration);
      
      log(`\n📊 TC${tcId} Results:`);
      log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
      log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
      if (verification.partialPassFiles > 0) {
        log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
      }
      if (verification.rejectedFiles > 0) {
        log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
      }
      if (verification.errorFiles > 0) {
        log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
      }
      log(`   📝 Total Records: ${verification.totalRecords}`);
      log(`   ✅ |true|: ${verification.trueCount}`);
      log(`   ❌ |false|: ${verification.falseCount}`);
  
      log(`\n✅ TC${tcId} COMPLETED`);
  
    } catch (error) {
      log(`\n❌ TC${tcId} FAILED`, { error: error.message });
      throw error;
    }
  });
  });
  

  // // // ============================================
  // // // TC2: 5 Valid + 5 Invalid Files (11-20)
  // // // ============================================
  test.describe('TC2: 5 Valid + 5 Invalid Files (11-20)', () => {
  
  test('TC2: Process 5 Valid + 5 Invalid Files)', { tag: ['@critical', '@smoke'] }, async () => {
    const tcId = '2';
    log(`\n${'='.repeat(60)}`);
    log(`🚀 STARTING TC${tcId} - All Valid`);
    log(`${'='.repeat(60)}`);
  
    const startTime = Date.now();
  
    try {
      await cleanLocalFolder(`TC${tcId}`);
  
      log('\n📋 Step 1: Copying files to local...');
      const copiedFiles = await copyFilesToLocal(tcId);
      log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
      log('\n📋 Step 2: Uploading files...');
      const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
      log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
      log('\n📋 Step 3: Executing batch...');
      const batchResult = await executeBatch(`TC${tcId}`);
      log(`✅ Batch executed successfully`);
  
      // STEP 4: SMART WAIT - Wait for ALL files to be generated
      log('\n📋 Step 4: Waiting for output files to be generated...');
      
      const expectedFiles = 10; // Number of files you're processing (42-51)
      const maxWaitTime = 300000; // Maximum wait: 2 minutes
      const checkInterval = 3000; // Check every 3 seconds
      let verification = null;
      let filesFound = 0;
      const waitStartTime = Date.now();
  
      while (Date.now() - waitStartTime < maxWaitTime) {
          // Check current files
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 11, end: 20 });
          filesFound = verification.totalFiles;
          
          const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
          log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
          if (filesFound === expectedFiles) {
              log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
              break;
          }
          
          // Wait before checking again
          await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
  
      // After waiting, show final status
      const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
      if (filesFound < expectedFiles) {
          log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
          if (verification) {
              log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
              if (verification.rejOnlyFiles.length > 0) {
                  log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
              }
          }
      } else {
          log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
      }
  
      // STEP 5: FINAL VERIFICATION (uses the last verification result)
      log('\n📋 Step 5: Final verification...');
      
      // If verification is null (shouldn't happen), run it one more time
      if (!verification) {
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 11, end: 20 });
      }
      
      // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
      const duration = Date.now() - startTime;
      await saveTestResults(`TC${tcId}`, verification, {start: 11, end: 20 }, duration);
      
      log(`\n📊 TC${tcId} Results:`);
      log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
      log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
      if (verification.partialPassFiles > 0) {
        log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
      }
      if (verification.rejectedFiles > 0) {
        log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
      }
      if (verification.errorFiles > 0) {
        log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
      }
      log(`   📝 Total Records: ${verification.totalRecords}`);
      log(`   ✅ |true|: ${verification.trueCount}`);
      log(`   ❌ |false|: ${verification.falseCount}`);
  
      log(`\n✅ TC${tcId} COMPLETED`);
  
    } catch (error) {
      log(`\n❌ TC${tcId} FAILED`, { error: error.message });
      throw error;
    }
  });
  });


  // ============================================
  // TC3: All Invalid Files (21-30)
  // ============================================
  test.describe(' TC3: All Invalid Files (21-30)', () => {
  
  test('TC3: All Invalid Files)', { tag: ['@critical', '@smoke'] }, async () => {
    const tcId = '3';
    log(`\n${'='.repeat(60)}`);
    log(`🚀 STARTING TC${tcId} - All Valid`);
    log(`${'='.repeat(60)}`);
  
    const startTime = Date.now();
  
    try {
      await cleanLocalFolder(`TC${tcId}`);
  
      log('\n📋 Step 1: Copying files to local...');
      const copiedFiles = await copyFilesToLocal(tcId);
      log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
      log('\n📋 Step 2: Uploading files...');
      const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
      log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
      log('\n📋 Step 3: Executing batch...');
      const batchResult = await executeBatch(`TC${tcId}`);
      log(`✅ Batch executed successfully`);
  
      // STEP 4: SMART WAIT - Wait for ALL files to be generated
      log('\n📋 Step 4: Waiting for output files to be generated...');
      
      const expectedFiles = 10; // Number of files you're processing (42-51)
      const maxWaitTime = 300000; // Maximum wait: 2 minutes
      const checkInterval = 3000; // Check every 3 seconds
      let verification = null;
      let filesFound = 0;
      const waitStartTime = Date.now();
  
      while (Date.now() - waitStartTime < maxWaitTime) {
          // Check current files
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 21, end: 30 });
          filesFound = verification.totalFiles;
          
          const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
          log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
          if (filesFound === expectedFiles) {
              log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
              break;
          }
          
          // Wait before checking again
          await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
  
      // After waiting, show final status
      const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
      if (filesFound < expectedFiles) {
          log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
          if (verification) {
              log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
              if (verification.rejOnlyFiles.length > 0) {
                  log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
              }
          }
      } else {
          log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
      }
  
      // STEP 5: FINAL VERIFICATION (uses the last verification result)
      log('\n📋 Step 5: Final verification...');
      
      // If verification is null (shouldn't happen), run it one more time
      if (!verification) {
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 21, end: 30 });
      }
      
      // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
      const duration = Date.now() - startTime;
      await saveTestResults(`TC${tcId}`, verification, { start: 21, end: 30}, duration);
      
      log(`\n📊 TC${tcId} Results:`);
      log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
      log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
      if (verification.partialPassFiles > 0) {
        log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
      }
      if (verification.rejectedFiles > 0) {
        log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
      }
      if (verification.errorFiles > 0) {
        log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
      }
      log(`   📝 Total Records: ${verification.totalRecords}`);
      log(`   ✅ |true|: ${verification.trueCount}`);
      log(`   ❌ |false|: ${verification.falseCount}`);
  
      log(`\n✅ TC${tcId} COMPLETED`);
  
    } catch (error) {
      log(`\n❌ TC${tcId} FAILED`, { error: error.message });
      throw error;
    }
  });
  });

  // // // ============================================
  // // // TC4A: 10 Valid + 10 Invalid (31)
  // // // ============================================
  test.describe(' TC4A: 10 Valid + 10 Invalid (31)', () => {
  
  test('TC4A: 10 Valid + 10 Invalid )', { tag: ['@critical', '@smoke'] }, async () => {
    const tcId = '4A';
    log(`\n${'='.repeat(60)}`);
    log(`🚀 STARTING TC${tcId} - All Valid`);
    log(`${'='.repeat(60)}`);
  
    const startTime = Date.now();
  
    try {
      await cleanLocalFolder(`TC${tcId}`);
  
      log('\n📋 Step 1: Copying files to local...');
      const copiedFiles = await copyFilesToLocal(tcId);
      log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
      log('\n📋 Step 2: Uploading files...');
      const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
      log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
      log('\n📋 Step 3: Executing batch...');
      const batchResult = await executeBatch(`TC${tcId}`);
      log(`✅ Batch executed successfully`);
  
      // STEP 4: SMART WAIT - Wait for ALL files to be generated
      log('\n📋 Step 4: Waiting for output files to be generated...');
      
      const expectedFiles = 1; // Number of files you're processing (42-51)
      const maxWaitTime = 300000; // Maximum wait: 2 minutes
      const checkInterval = 3000; // Check every 3 seconds
      let verification = null;
      let filesFound = 0;
      const waitStartTime = Date.now();
  
      while (Date.now() - waitStartTime < maxWaitTime) {
          // Check current files
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 31, end: 31 });
          filesFound = verification.totalFiles;
          
          const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
          log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
          if (filesFound === expectedFiles) {
              log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
              break;
          }
          
          // Wait before checking again
          await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
  
      // After waiting, show final status
      const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
      if (filesFound < expectedFiles) {
          log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
          if (verification) {
              log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
              if (verification.rejOnlyFiles.length > 0) {
                  log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
              }
          }
      } else {
          log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
      }
  
      // STEP 5: FINAL VERIFICATION (uses the last verification result)
      log('\n📋 Step 5: Final verification...');
      
      // If verification is null (shouldn't happen), run it one more time
      if (!verification) {
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 31, end: 31 });
      }
      
      // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
      const duration = Date.now() - startTime;
      await saveTestResults(`TC${tcId}`, verification, { start: 31, end: 31}, duration);
      
      log(`\n📊 TC${tcId} Results:`);
      log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
      log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
      if (verification.partialPassFiles > 0) {
        log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
      }
      if (verification.rejectedFiles > 0) {
        log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
      }
      if (verification.errorFiles > 0) {
        log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
      }
      log(`   📝 Total Records: ${verification.totalRecords}`);
      log(`   ✅ |true|: ${verification.trueCount}`);
      log(`   ❌ |false|: ${verification.falseCount}`);
  
      log(`\n✅ TC${tcId} COMPLETED`);
  
    } catch (error) {
      log(`\n❌ TC${tcId} FAILED`, { error: error.message });
      throw error;
    }
  });
  });

  // // // ============================================
  // // // TC4B: Alternating Pattern (32)
  // // // ============================================
   test.describe('TC4B: Alternating Pattern (32)', () => {
  
  test('TC4A: Alternating Pattern - 6 Valid 4 Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
    const tcId = '4B';
    log(`\n${'='.repeat(60)}`);
    log(`🚀 STARTING TC${tcId} - All Valid`);
    log(`${'='.repeat(60)}`);
  
    const startTime = Date.now();
  
    try {
      await cleanLocalFolder(`TC${tcId}`);
  
      log('\n📋 Step 1: Copying files to local...');
      const copiedFiles = await copyFilesToLocal(tcId);
      log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
      log('\n📋 Step 2: Uploading files...');
      const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
      log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
      log('\n📋 Step 3: Executing batch...');
      const batchResult = await executeBatch(`TC${tcId}`);
      log(`✅ Batch executed successfully`);
  
      // STEP 4: SMART WAIT - Wait for ALL files to be generated
      log('\n📋 Step 4: Waiting for output files to be generated...');
      
      const expectedFiles = 1; // Number of files you're processing (42-51)
      const maxWaitTime = 300000; // Maximum wait: 2 minutes
      const checkInterval = 3000; // Check every 3 seconds
      let verification = null;
      let filesFound = 0;
      const waitStartTime = Date.now();
  
      while (Date.now() - waitStartTime < maxWaitTime) {
          // Check current files
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 32, end: 32 });
          filesFound = verification.totalFiles;
          
          const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
          log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
          if (filesFound === expectedFiles) {
              log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
              break;
          }
          
          // Wait before checking again
          await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
  
      // After waiting, show final status
      const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
      if (filesFound < expectedFiles) {
          log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
          if (verification) {
              log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
              if (verification.rejOnlyFiles.length > 0) {
                  log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
              }
          }
      } else {
          log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
      }
  
      // STEP 5: FINAL VERIFICATION (uses the last verification result)
      log('\n📋 Step 5: Final verification...');
      
      // If verification is null (shouldn't happen), run it one more time
      if (!verification) {
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 32, end: 32 });
      }
      
      // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
      const duration = Date.now() - startTime;
      await saveTestResults(`TC${tcId}`, verification, { start: 32, end: 32}, duration);
      
      log(`\n📊 TC${tcId} Results:`);
      log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
      log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
      if (verification.partialPassFiles > 0) {
        log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
      }
      if (verification.rejectedFiles > 0) {
        log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
      }
      if (verification.errorFiles > 0) {
        log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
      }
      log(`   📝 Total Records: ${verification.totalRecords}`);
      log(`   ✅ |true|: ${verification.trueCount}`);
      log(`   ❌ |false|: ${verification.falseCount}`);
  
      log(`\n✅ TC${tcId} COMPLETED`);
  
    } catch (error) {
      log(`\n❌ TC${tcId} FAILED`, { error: error.message });
      throw error;
    }
  });
  });

  // // // ============================================
  // // // TC4C: Boundary + Invalid Combo (33)
  // // // ============================================
   test.describe('TC4C: Boundary + Invalid Combo', () => {
  
  test('TC4C: Boundary + Invalid Combo - 4 Valid 4 Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
    const tcId = '4C';
    log(`\n${'='.repeat(60)}`);
    log(`🚀 STARTING TC${tcId} - All Valid`);
    log(`${'='.repeat(60)}`);
  
    const startTime = Date.now();
  
    try {
      await cleanLocalFolder(`TC${tcId}`);
  
      log('\n📋 Step 1: Copying files to local...');
      const copiedFiles = await copyFilesToLocal(tcId);
      log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
      log('\n📋 Step 2: Uploading files...');
      const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
      log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
      log('\n📋 Step 3: Executing batch...');
      const batchResult = await executeBatch(`TC${tcId}`);
      log(`✅ Batch executed successfully`);
  
      // STEP 4: SMART WAIT - Wait for ALL files to be generated
      log('\n📋 Step 4: Waiting for output files to be generated...');
      
      const expectedFiles = 1; // Number of files you're processing (42-51)
      const maxWaitTime = 300000; // Maximum wait: 2 minutes
      const checkInterval = 3000; // Check every 3 seconds
      let verification = null;
      let filesFound = 0;
      const waitStartTime = Date.now();
  
      while (Date.now() - waitStartTime < maxWaitTime) {
          // Check current files
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 33, end: 33 });
          filesFound = verification.totalFiles;
          
          const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
          log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
          if (filesFound === expectedFiles) {
              log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
              break;
          }
          
          // Wait before checking again
          await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
  
      // After waiting, show final status
      const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
      if (filesFound < expectedFiles) {
          log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
          if (verification) {
              log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
              if (verification.rejOnlyFiles.length > 0) {
                  log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
              }
          }
      } else {
          log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
      }
  
      // STEP 5: FINAL VERIFICATION (uses the last verification result)
      log('\n📋 Step 5: Final verification...');
      
      // If verification is null (shouldn't happen), run it one more time
      if (!verification) {
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 33, end: 33 });
      }
      
      // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
      const duration = Date.now() - startTime;
      await saveTestResults(`TC${tcId}`, verification, { start: 33, end: 33}, duration);
      
      log(`\n📊 TC${tcId} Results:`);
      log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
      log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
      if (verification.partialPassFiles > 0) {
        log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
      }
      if (verification.rejectedFiles > 0) {
        log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
      }
      if (verification.errorFiles > 0) {
        log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
      }
      log(`   📝 Total Records: ${verification.totalRecords}`);
      log(`   ✅ |true|: ${verification.trueCount}`);
      log(`   ❌ |false|: ${verification.falseCount}`);
  
      log(`\n✅ TC${tcId} COMPLETED`);
  
    } catch (error) {
      log(`\n❌ TC${tcId} FAILED`, { error: error.message });
      throw error;
    }
  });
  });

  // // // ============================================
  // // // TC4D: Business Rule Violations (34)
  // // // ============================================
  test.describe('TC4D: Business Rule Violations (34)', () => {
  
  test('TC4D: Business Rule Violations - 3 Valid 8 Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
    const tcId = '4D';
    log(`\n${'='.repeat(60)}`);
    log(`🚀 STARTING TC${tcId} - All Valid`);
    log(`${'='.repeat(60)}`);
  
    const startTime = Date.now();
  
    try {
      await cleanLocalFolder(`TC${tcId}`);
  
      log('\n📋 Step 1: Copying files to local...');
      const copiedFiles = await copyFilesToLocal(tcId);
      log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
      log('\n📋 Step 2: Uploading files...');
      const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
      log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
      log('\n📋 Step 3: Executing batch...');
      const batchResult = await executeBatch(`TC${tcId}`);
      log(`✅ Batch executed successfully`);
  
      // STEP 4: SMART WAIT - Wait for ALL files to be generated
      log('\n📋 Step 4: Waiting for output files to be generated...');
      
      const expectedFiles = 1; // Number of files you're processing (42-51)
      const maxWaitTime = 300000; // Maximum wait: 2 minutes
      const checkInterval = 3000; // Check every 3 seconds
      let verification = null;
      let filesFound = 0;
      const waitStartTime = Date.now();
  
      while (Date.now() - waitStartTime < maxWaitTime) {
          // Check current files
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 34, end: 34 });
          filesFound = verification.totalFiles;
          
          const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
          log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
          if (filesFound === expectedFiles) {
              log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
              break;
          }
          
          // Wait before checking again
          await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
  
      // After waiting, show final status
      const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
      if (filesFound < expectedFiles) {
          log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
          if (verification) {
              log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
              if (verification.rejOnlyFiles.length > 0) {
                  log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
              }
          }
      } else {
          log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
      }
  
      // STEP 5: FINAL VERIFICATION (uses the last verification result)
      log('\n📋 Step 5: Final verification...');
      
      // If verification is null (shouldn't happen), run it one more time
      if (!verification) {
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 34, end: 34 });
      }
      
      // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
      const duration = Date.now() - startTime;
      await saveTestResults(`TC${tcId}`, verification, { start: 34, end: 34}, duration);
      
      log(`\n📊 TC${tcId} Results:`);
      log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
      log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
      if (verification.partialPassFiles > 0) {
        log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
      }
      if (verification.rejectedFiles > 0) {
        log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
      }
      if (verification.errorFiles > 0) {
        log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
      }
      log(`   📝 Total Records: ${verification.totalRecords}`);
      log(`   ✅ |true|: ${verification.trueCount}`);
      log(`   ❌ |false|: ${verification.falseCount}`);
  
      log(`\n✅ TC${tcId} COMPLETED`);
  
    } catch (error) {
      log(`\n❌ TC${tcId} FAILED`, { error: error.message });
      throw error;
    }
  });
  });

  
  // // // ============================================
  // // // TC6A: Recovery (35)
  // // // ============================================
 test.describe('TC6A: Recovery (35))', () => {
  
  test('TC6A: Recovery - 5 Valid 3 Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
    const tcId = '6A';
    log(`\n${'='.repeat(60)}`);
    log(`🚀 STARTING TC${tcId} - All Valid`);
    log(`${'='.repeat(60)}`);
  
    const startTime = Date.now();
  
    try {
      await cleanLocalFolder(`TC${tcId}`);
  
      log('\n📋 Step 1: Copying files to local...');
      const copiedFiles = await copyFilesToLocal(tcId);
      log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
      log('\n📋 Step 2: Uploading files...');
      const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
      log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
      log('\n📋 Step 3: Executing batch...');
      const batchResult = await executeBatch(`TC${tcId}`);
      log(`✅ Batch executed successfully`);
  
      // STEP 4: SMART WAIT - Wait for ALL files to be generated
      log('\n📋 Step 4: Waiting for output files to be generated...');
      
      const expectedFiles = 1; // Number of files you're processing (42-51)
      const maxWaitTime = 300000; // Maximum wait: 2 minutes
      const checkInterval = 3000; // Check every 3 seconds
      let verification = null;
      let filesFound = 0;
      const waitStartTime = Date.now();
  
      while (Date.now() - waitStartTime < maxWaitTime) {
          // Check current files
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 35, end: 35 });
          filesFound = verification.totalFiles;
          
          const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
          log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
          if (filesFound === expectedFiles) {
              log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
              break;
          }
          
          // Wait before checking again
          await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
  
      // After waiting, show final status
      const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
      if (filesFound < expectedFiles) {
          log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
          if (verification) {
              log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
              if (verification.rejOnlyFiles.length > 0) {
                  log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
              }
          }
      } else {
          log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
      }
  
      // STEP 5: FINAL VERIFICATION (uses the last verification result)
      log('\n📋 Step 5: Final verification...');
      
      // If verification is null (shouldn't happen), run it one more time
      if (!verification) {
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 35, end: 35 });
      }
      
      // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
      const duration = Date.now() - startTime;
      await saveTestResults(`TC${tcId}`, verification, { start: 35, end: 35}, duration);
      
      log(`\n📊 TC${tcId} Results:`);
      log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
      log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
      if (verification.partialPassFiles > 0) {
        log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
      }
      if (verification.rejectedFiles > 0) {
        log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
      }
      if (verification.errorFiles > 0) {
        log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
      }
      log(`   📝 Total Records: ${verification.totalRecords}`);
      log(`   ✅ |true|: ${verification.trueCount}`);
      log(`   ❌ |false|: ${verification.falseCount}`);
  
      log(`\n✅ TC${tcId} COMPLETED`);
  
    } catch (error) {
      log(`\n❌ TC${tcId} FAILED`, { error: error.message });
      throw error;
    }
  });
  });

// // ============================================
// TC7A: Invalid Flags (36)
// ============================================
test.describe('TC7A: Invalid Flags (36) )', () => {
  
  test('TC7A: Invalid Flags - 5 Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
    const tcId = '7A';
    log(`\n${'='.repeat(60)}`);
    log(`🚀 STARTING TC${tcId} - All Valid`);
    log(`${'='.repeat(60)}`);
  
    const startTime = Date.now();
  
    try {
      await cleanLocalFolder(`TC${tcId}`);
  
      log('\n📋 Step 1: Copying files to local...');
      const copiedFiles = await copyFilesToLocal(tcId);
      log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
      log('\n📋 Step 2: Uploading files...');
      const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
      log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
      log('\n📋 Step 3: Executing batch...');
      const batchResult = await executeBatch(`TC${tcId}`);
      log(`✅ Batch executed successfully`);
  
      // STEP 4: SMART WAIT - Wait for ALL files to be generated
      log('\n📋 Step 4: Waiting for output files to be generated...');
      
      const expectedFiles = 1; // Number of files you're processing (42-51)
      const maxWaitTime = 300000; // Maximum wait: 2 minutes
      const checkInterval = 3000; // Check every 3 seconds
      let verification = null;
      let filesFound = 0;
      const waitStartTime = Date.now();
  
      while (Date.now() - waitStartTime < maxWaitTime) {
          // Check current files
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 36, end: 36 });
          filesFound = verification.totalFiles;
          
          const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
          log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
          if (filesFound === expectedFiles) {
              log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
              break;
          }
          
          // Wait before checking again
          await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
  
      // After waiting, show final status
      const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
      if (filesFound < expectedFiles) {
          log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
          if (verification) {
              log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
              if (verification.rejOnlyFiles.length > 0) {
                  log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
              }
          }
      } else {
          log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
      }
  
      // STEP 5: FINAL VERIFICATION (uses the last verification result)
      log('\n📋 Step 5: Final verification...');
      
      // If verification is null (shouldn't happen), run it one more time
      if (!verification) {
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 36, end: 36 });
      }
      
      // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
      const duration = Date.now() - startTime;
      await saveTestResults(`TC${tcId}`, verification, { start: 36, end: 36}, duration);
      
      log(`\n📊 TC${tcId} Results:`);
      log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
      log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
      if (verification.partialPassFiles > 0) {
        log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
      }
      if (verification.rejectedFiles > 0) {
        log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
      }
      if (verification.errorFiles > 0) {
        log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
      }
      log(`   📝 Total Records: ${verification.totalRecords}`);
      log(`   ✅ |true|: ${verification.trueCount}`);
      log(`   ❌ |false|: ${verification.falseCount}`);
  
      log(`\n✅ TC${tcId} COMPLETED`);
  
    } catch (error) {
      log(`\n❌ TC${tcId} FAILED`, { error: error.message });
      throw error;
    }
  });
  });


  // // ============================================
  // // TC7B: Invalid Statuses (37)
  // // ============================================
  test.describe('TC7B: Invalid Statuses (37) )', () => {
  
  test('TC7B: Invalid Statuses - 2 Valid 3 Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
    const tcId = '7B';
    log(`\n${'='.repeat(60)}`);
    log(`🚀 STARTING TC${tcId} - All Valid`);
    log(`${'='.repeat(60)}`);
  
    const startTime = Date.now();
  
    try {
      await cleanLocalFolder(`TC${tcId}`);
  
      log('\n📋 Step 1: Copying files to local...');
      const copiedFiles = await copyFilesToLocal(tcId);
      log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
      log('\n📋 Step 2: Uploading files...');
      const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
      log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
      log('\n📋 Step 3: Executing batch...');
      const batchResult = await executeBatch(`TC${tcId}`);
      log(`✅ Batch executed successfully`);
  
      // STEP 4: SMART WAIT - Wait for ALL files to be generated
      log('\n📋 Step 4: Waiting for output files to be generated...');
      
      const expectedFiles = 1; // Number of files you're processing (42-51)
      const maxWaitTime = 300000; // Maximum wait: 2 minutes
      const checkInterval = 3000; // Check every 3 seconds
      let verification = null;
      let filesFound = 0;
      const waitStartTime = Date.now();
  
      while (Date.now() - waitStartTime < maxWaitTime) {
          // Check current files
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 37, end: 37 });
          filesFound = verification.totalFiles;
          
          const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
          log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
          if (filesFound === expectedFiles) {
              log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
              break;
          }
          
          // Wait before checking again
          await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
  
      // After waiting, show final status
      const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
      if (filesFound < expectedFiles) {
          log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
          if (verification) {
              log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
              if (verification.rejOnlyFiles.length > 0) {
                  log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
              }
          }
      } else {
          log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
      }
  
      // STEP 5: FINAL VERIFICATION (uses the last verification result)
      log('\n📋 Step 5: Final verification...');
      
      // If verification is null (shouldn't happen), run it one more time
      if (!verification) {
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 37, end: 37 });
      }
      
      // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
      const duration = Date.now() - startTime;
      await saveTestResults(`TC${tcId}`, verification, { start: 37, end: 37}, duration);
      
      log(`\n📊 TC${tcId} Results:`);
      log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
      log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
      if (verification.partialPassFiles > 0) {
        log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
      }
      if (verification.rejectedFiles > 0) {
        log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
      }
      if (verification.errorFiles > 0) {
        log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
      }
      log(`   📝 Total Records: ${verification.totalRecords}`);
      log(`   ✅ |true|: ${verification.trueCount}`);
      log(`   ❌ |false|: ${verification.falseCount}`);
  
      log(`\n✅ TC${tcId} COMPLETED`);
  
    } catch (error) {
      log(`\n❌ TC${tcId} FAILED`, { error: error.message });
      throw error;
    }
  });
  });

  // // ============================================
  // // TC7C: Length Validation (38)
  // // ============================================
  test.describe('TC7C: Length Validation (38) )', () => {
  
  test('TC7C: Length Validation - 2 Valid 6 Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
    const tcId = '7C';
    log(`\n${'='.repeat(60)}`);
    log(`🚀 STARTING TC${tcId} - All Valid`);
    log(`${'='.repeat(60)}`);
  
    const startTime = Date.now();
  
    try {
      await cleanLocalFolder(`TC${tcId}`);
  
      log('\n📋 Step 1: Copying files to local...');
      const copiedFiles = await copyFilesToLocal(tcId);
      log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
      log('\n📋 Step 2: Uploading files...');
      const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
      log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
      log('\n📋 Step 3: Executing batch...');
      const batchResult = await executeBatch(`TC${tcId}`);
      log(`✅ Batch executed successfully`);
  
      // STEP 4: SMART WAIT - Wait for ALL files to be generated
      log('\n📋 Step 4: Waiting for output files to be generated...');
      
      const expectedFiles = 1; // Number of files you're processing (42-51)
      const maxWaitTime = 300000; // Maximum wait: 2 minutes
      const checkInterval = 3000; // Check every 3 seconds
      let verification = null;
      let filesFound = 0;
      const waitStartTime = Date.now();
  
      while (Date.now() - waitStartTime < maxWaitTime) {
          // Check current files
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 38, end: 38 });
          filesFound = verification.totalFiles;
          
          const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
          log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
          if (filesFound === expectedFiles) {
              log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
              break;
          }
          
          // Wait before checking again
          await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
  
      // After waiting, show final status
      const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
      if (filesFound < expectedFiles) {
          log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
          if (verification) {
              log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
              if (verification.rejOnlyFiles.length > 0) {
                  log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
              }
          }
      } else {
          log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
      }
  
      // STEP 5: FINAL VERIFICATION (uses the last verification result)
      log('\n📋 Step 5: Final verification...');
      
      // If verification is null (shouldn't happen), run it one more time
      if (!verification) {
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 38, end: 38 });
      }
      
      // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
      const duration = Date.now() - startTime;
      await saveTestResults(`TC${tcId}`, verification, { start: 38, end: 38}, duration);
      
      log(`\n📊 TC${tcId} Results:`);
      log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
      log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
      if (verification.partialPassFiles > 0) {
        log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
      }
      if (verification.rejectedFiles > 0) {
        log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
      }
      if (verification.errorFiles > 0) {
        log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
      }
      log(`   📝 Total Records: ${verification.totalRecords}`);
      log(`   ✅ |true|: ${verification.trueCount}`);
      log(`   ❌ |false|: ${verification.falseCount}`);
  
      log(`\n✅ TC${tcId} COMPLETED`);
  
    } catch (error) {
      log(`\n❌ TC${tcId} FAILED`, { error: error.message });
      throw error;
    }
  });
  });

  // // ============================================
  // // TC8A: Sequential Operations (39)
  // // ============================================
 test.describe('TC8A: Sequential Operations (39) )', () => {
  
  test('TC8A: Sequential Operations - 3 Valid 5 Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
    const tcId = '8A';
    log(`\n${'='.repeat(60)}`);
    log(`🚀 STARTING TC${tcId} - All Valid`);
    log(`${'='.repeat(60)}`);
  
    const startTime = Date.now();
  
    try {
      await cleanLocalFolder(`TC${tcId}`);
  
      log('\n📋 Step 1: Copying files to local...');
      const copiedFiles = await copyFilesToLocal(tcId);
      log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
      log('\n📋 Step 2: Uploading files...');
      const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
      log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
      log('\n📋 Step 3: Executing batch...');
      const batchResult = await executeBatch(`TC${tcId}`);
      log(`✅ Batch executed successfully`);
  
      // STEP 4: SMART WAIT - Wait for ALL files to be generated
      log('\n📋 Step 4: Waiting for output files to be generated...');
      
      const expectedFiles = 1; // Number of files you're processing (42-51)
      const maxWaitTime = 300000; // Maximum wait: 2 minutes
      const checkInterval = 3000; // Check every 3 seconds
      let verification = null;
      let filesFound = 0;
      const waitStartTime = Date.now();
  
      while (Date.now() - waitStartTime < maxWaitTime) {
          // Check current files
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 39, end: 39 });
          filesFound = verification.totalFiles;
          
          const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
          log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
          if (filesFound === expectedFiles) {
              log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
              break;
          }
          
          // Wait before checking again
          await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
  
      // After waiting, show final status
      const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
      if (filesFound < expectedFiles) {
          log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
          if (verification) {
              log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
              if (verification.rejOnlyFiles.length > 0) {
                  log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
              }
          }
      } else {
          log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
      }
  
      // STEP 5: FINAL VERIFICATION (uses the last verification result)
      log('\n📋 Step 5: Final verification...');
      
      // If verification is null (shouldn't happen), run it one more time
      if (!verification) {
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 39, end: 39 });
      }
      
      // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
      const duration = Date.now() - startTime;
      await saveTestResults(`TC${tcId}`, verification, { start: 39, end: 39}, duration);
      
      log(`\n📊 TC${tcId} Results:`);
      log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
      log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
      if (verification.partialPassFiles > 0) {
        log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
      }
      if (verification.rejectedFiles > 0) {
        log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
      }
      if (verification.errorFiles > 0) {
        log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
      }
      log(`   📝 Total Records: ${verification.totalRecords}`);
      log(`   ✅ |true|: ${verification.trueCount}`);
      log(`   ❌ |false|: ${verification.falseCount}`);
  
      log(`\n✅ TC${tcId} COMPLETED`);
  
    } catch (error) {
      log(`\n❌ TC${tcId} FAILED`, { error: error.message });
      throw error;
    }
  });
  });

  // // ============================================
  // // TC8B: Duplicate Records (40)
  // // ============================================
   test.describe('TC8B: Duplicate Records (40) )', () => {
  
  test('TC8B: Duplicate Records - 4 Valid 4 Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
    const tcId = '8B';
    log(`\n${'='.repeat(60)}`);
    log(`🚀 STARTING TC${tcId} - All Valid`);
    log(`${'='.repeat(60)}`);
  
    const startTime = Date.now();
  
    try {
      await cleanLocalFolder(`TC${tcId}`);
  
      log('\n📋 Step 1: Copying files to local...');
      const copiedFiles = await copyFilesToLocal(tcId);
      log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
      log('\n📋 Step 2: Uploading files...');
      const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
      log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
      log('\n📋 Step 3: Executing batch...');
      const batchResult = await executeBatch(`TC${tcId}`);
      log(`✅ Batch executed successfully`);
  
      // STEP 4: SMART WAIT - Wait for ALL files to be generated
      log('\n📋 Step 4: Waiting for output files to be generated...');
      
      const expectedFiles = 1; // Number of files you're processing (42-51)
      const maxWaitTime = 300000; // Maximum wait: 2 minutes
      const checkInterval = 3000; // Check every 3 seconds
      let verification = null;
      let filesFound = 0;
      const waitStartTime = Date.now();
  
      while (Date.now() - waitStartTime < maxWaitTime) {
          // Check current files
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 40, end: 40 });
          filesFound = verification.totalFiles;
          
          const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
          log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
          if (filesFound === expectedFiles) {
              log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
              break;
          }
          
          // Wait before checking again
          await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
  
      // After waiting, show final status
      const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
      if (filesFound < expectedFiles) {
          log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
          if (verification) {
              log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
              if (verification.rejOnlyFiles.length > 0) {
                  log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
              }
          }
      } else {
          log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
      }
  
      // STEP 5: FINAL VERIFICATION (uses the last verification result)
      log('\n📋 Step 5: Final verification...');
      
      // If verification is null (shouldn't happen), run it one more time
      if (!verification) {
          verification = await verifyResults(`TC${tcId}`, 'true', { start: 40, end: 40 });
      }
      
      // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
      const duration = Date.now() - startTime;
      await saveTestResults(`TC${tcId}`, verification, { start: 40, end: 40}, duration);
      
      log(`\n📊 TC${tcId} Results:`);
      log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
      log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
      if (verification.partialPassFiles > 0) {
        log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
      }
      if (verification.rejectedFiles > 0) {
        log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
      }
      if (verification.errorFiles > 0) {
        log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
      }
      log(`   📝 Total Records: ${verification.totalRecords}`);
      log(`   ✅ |true|: ${verification.trueCount}`);
      log(`   ❌ |false|: ${verification.falseCount}`);
  
      log(`\n✅ TC${tcId} COMPLETED`);
  
    } catch (error) {
      log(`\n❌ TC${tcId} FAILED`, { error: error.message });
      throw error;
    }
  });
  });

  // // ============================================
  // // TC9A: Future Dates (41)
  // // ============================================
  test.describe('TC9A: Future Dates (41) )', () => {
  
  test('TC9A: Future Dates - All Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
    const tcId = '9A';
    log(`\n${'='.repeat(60)}`);
    log(`🚀 STARTING TC${tcId} - All Invalid`);
    log(`${'='.repeat(60)}`);
  
    const startTime = Date.now();
  
    try {
      await cleanLocalFolder(`TC${tcId}`);
  
      log('\n📋 Step 1: Copying files to local...');
      const copiedFiles = await copyFilesToLocal(tcId);
      log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
      log('\n📋 Step 2: Uploading files...');
      const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
      log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
      log('\n📋 Step 3: Executing batch...');
      const batchResult = await executeBatch(`TC${tcId}`);
      log(`✅ Batch executed successfully`);
  
      // STEP 4: SMART WAIT - Wait for ALL files to be generated
      log('\n📋 Step 4: Waiting for output files to be generated...');
      
      const expectedFiles = 1; // Number of files you're processing (42-51)
      const maxWaitTime = 300000; // Maximum wait: 2 minutes
      const checkInterval = 3000; // Check every 3 seconds
      let verification = null;
      let filesFound = 0;
      const waitStartTime = Date.now();
  
      while (Date.now() - waitStartTime < maxWaitTime) {
          // Check current files
          verification = await verifyResults2(`TC${tcId}`, 'true', { start: 41, end: 41 });
          filesFound = verification.totalFiles;
          
          const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
          log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
          if (filesFound === expectedFiles) {
              log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
              break;
          }
          
          // Wait before checking again
          await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
  
      // After waiting, show final status
      const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
      if (filesFound < expectedFiles) {
          log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
          if (verification) {
              log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
              if (verification.rejOnlyFiles.length > 0) {
                  log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
              }
          }
      } else {
          log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
      }
  
      // STEP 5: FINAL VERIFICATION (uses the last verification result)
      log('\n📋 Step 5: Final verification...');
      
      // If verification is null (shouldn't happen), run it one more time
      if (!verification) {
          verification = await verifyResults2(`TC${tcId}`, 'true', { start: 41, end: 41 });
      }
      
      // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
      const duration = Date.now() - startTime;
      await saveTestResults(`TC${tcId}`, verification, { start: 41, end: 41}, duration);
      
      log(`\n📊 TC${tcId} Results:`);
      log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
      log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
      if (verification.partialPassFiles > 0) {
        log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
      }
      if (verification.rejectedFiles > 0) {
        log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
      }
      if (verification.errorFiles > 0) {
        log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
      }
      log(`   📝 Total Records: ${verification.totalRecords}`);
      log(`   ✅ |true|: ${verification.trueCount}`);
      log(`   ❌ |false|: ${verification.falseCount}`);
  
      log(`\n✅ TC${tcId} COMPLETED`);
  
    } catch (error) {
      log(`\n❌ TC${tcId} FAILED`, { error: error.message });
      throw error;
    }
  });
  });


  // // ============================================
  // // TC9B: Past Dates (42)
  // // ============================================
  test.describe('TC9B: Past Dates (42) )', () => {
  
  test('TC9B: Past Date - All Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
    const tcId = '9B';
    log(`\n${'='.repeat(60)}`);
    log(`🚀 STARTING TC${tcId} - All Invalid`);
    log(`${'='.repeat(60)}`);
  
    const startTime = Date.now();
  
    try {
      await cleanLocalFolder(`TC${tcId}`);
  
      log('\n📋 Step 1: Copying files to local...');
      const copiedFiles = await copyFilesToLocal(tcId);
      log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
      log('\n📋 Step 2: Uploading files...');
      const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
      log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
      log('\n📋 Step 3: Executing batch...');
      const batchResult = await executeBatch(`TC${tcId}`);
      log(`✅ Batch executed successfully`);
  
      // STEP 4: SMART WAIT - Wait for ALL files to be generated
      log('\n📋 Step 4: Waiting for output files to be generated...');
      
      const expectedFiles = 1; // Number of files you're processing (42-51)
      const maxWaitTime = 300000; // Maximum wait: 2 minutes
      const checkInterval = 3000; // Check every 3 seconds
      let verification = null;
      let filesFound = 0;
      const waitStartTime = Date.now();
  
      while (Date.now() - waitStartTime < maxWaitTime) {
          // Check current files
         verification = await verifyResults2(`TC${tcId}`, 'true', { start: 42, end: 42 });
          filesFound = verification.totalFiles;
          
          const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
          log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
          if (filesFound === expectedFiles) {
              log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
              break;
          }
          
          // Wait before checking again
          await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
  
      // After waiting, show final status
      const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
      if (filesFound < expectedFiles) {
          log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
          if (verification) {
              log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
              if (verification.rejOnlyFiles.length > 0) {
                  log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
              }
          }
      } else {
          log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
      }
  
      // STEP 5: FINAL VERIFICATION (uses the last verification result)
      log('\n📋 Step 5: Final verification...');
      
      // If verification is null (shouldn't happen), run it one more time
      if (!verification) {
         verification = await verifyResults2(`TC${tcId}`, 'true', { start: 42, end: 42 });
      }
      
      // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
      const duration = Date.now() - startTime;
      await saveTestResults(`TC${tcId}`, verification, { start: 42, end: 42}, duration);
      
      log(`\n📊 TC${tcId} Results:`);
      log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
      log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
      if (verification.partialPassFiles > 0) {
        log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
      }
      if (verification.rejectedFiles > 0) {
        log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
      }
      if (verification.errorFiles > 0) {
        log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
      }
      log(`   📝 Total Records: ${verification.totalRecords}`);
      log(`   ✅ |true|: ${verification.trueCount}`);
      log(`   ❌ |false|: ${verification.falseCount}`);
  
      log(`\n✅ TC${tcId} COMPLETED`);
  
    } catch (error) {
      log(`\n❌ TC${tcId} FAILED`, { error: error.message });
      throw error;
    }
  });
  });

}); // End of test suite
