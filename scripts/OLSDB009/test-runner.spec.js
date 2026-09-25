// scripts/test-runner.spec.js
import { test, expect } from '@playwright/test';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import pg from 'pg'; // PostgreSQL driver
import { generateTestCase } from './file-generator.js'; // input files for each case

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
    remotePath: process.env.SFTP_REMOTE_PATH || '/apps/MY-dev/OE/cls/USER_INPUT/OLSDB009/',
    localPath: process.env.LOCAL_PATH || 'C:\\BATCH-OCBC-PW1\\src\\',
  },

  putty: {
    path: process.env.PUTTY_PATH || 'C:\\Program Files\\PuTTY\\plink.exe',
    host: process.env.SSH_HOST || '192.168.99.83',
    username: process.env.SSH_USERNAME || 'root',
    password: process.env.SSH_PASSWORD || 'oev123',
    // plink stores host keys in the registry, separately from WinSCP - having
    // uploaded via WinSCP does NOT mean plink trusts this host. Until the key is
    // cached, plink stops on a "Store key in cache? (y/n)" prompt; with no stdin
    // that just hangs until execAsync kills it. Pinning the key here skips the
    // prompt entirely. To use a different host, run `plink -ssh <user>@<host>`
    // once and answer y, or set SSH_HOST_KEY.
    hostKey: process.env.SSH_HOST_KEY || 'SHA256:kGbLBMkLSnBoYmLg10qgHfmQmtUbawS69GYysVLkXu4',
  },

  batch: {
    scriptPath: process.env.BATCH_SCRIPT_PATH || '/apps/MY-dev/scripts',
    command: process.env.BATCH_COMMAND || './OLSDB009',
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

// Build a non-interactive plink invocation.
// -batch is REQUIRED, not cosmetic: without it plink stops on the
// "Store key in cache? (y/n)" prompt when the host key is not cached, and with
// no stdin attached it hangs until execAsync's timeout kills it. That failure is
// invisible - it looks exactly like "batch ran but produced no output".
function plinkCommand(remoteCommand) {
  return `"${CONFIG.putty.path}" ` +
    `-batch ` +
    `-hostkey "${CONFIG.putty.hostKey}" ` +
    `-ssh ${CONFIG.putty.username}@${CONFIG.putty.host} ` +
    `-pw ${CONFIG.putty.password} ` +
    `"${remoteCommand}"`;
}

// Execute batch via PuTTY
async function executeBatch(testCase) {
  const command = `cd ${CONFIG.batch.scriptPath} && ${CONFIG.batch.command}`;

  log(`[${testCase}] Executing batch: ${command}`);

  try {
    const { stdout, stderr } = await execAsync(plinkCommand(command), {
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 10
    });

    log(`[${testCase}] ✅ Batch executed`);
    return { success: true, stdout, stderr };

  } catch (error) {
    // Report the failure instead of swallowing it: a batch that never ran must
    // not look the same as a batch that ran and produced nothing.
    log(`[${testCase}] ❌ Batch execution FAILED: ${error.message}`);
    return {
      success: false,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      error: error.message
    };
  }
}

// Execute custom command
async function executeCustomCommand(command, testCase) {
  try {
    log(`[${testCase}] Executing: ${command}`);

    const { stdout, stderr } = await execAsync(plinkCommand(command), {
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
    const statusCommand = 'ps aux | grep -E "OLSDB009|OLSDB" | grep -v grep | grep -v plink';
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
      `"rm OLSTXN-*.dat" ` +
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
    const baseDir = CONFIG.winscp.remotePath;
   
    log(`[${testCase}] 🔍 Looking for files with date: ${currentDate}`);
    log(`[${testCase}] 🔍 Directory: ${baseDir}`);
   
    const findCommand = `find ${baseDir} -maxdepth 1 -type f \\( -name "OLSTXN-*-${currentDate}-*.out" -o -name "OLSTXN-*-${currentDate}-*.rej" -o -name "*.err" \\) 2>/dev/null`;
    log(`[${testCase}] 🔍 Running: ${findCommand}`);
   


    const findResult = await executeCustomCommand(findCommand, testCase);
    let outputFiles = findResult.stdout.trim().split('\n').filter(f => f.trim() !== '');
    log(`[${testCase}] 📁 Found ${outputFiles.length} total output files in directory`);
   
    if (outputFiles.length === 0) {
      log(`[${testCase}] ⚠️ No files found with find, trying ls...`);
      const lsCommand = `ls ${baseDir}OLSTXN-*-${currentDate}-*.{out,rej} ${baseDir}*.err 2>/dev/null`;
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
     
      let match = file.match(/OLSTXN-\w+-\d{8}-(\d{2})_/);
      if (match) {
        fileNum = parseInt(match[1], 10);
      }
     
      if (!match) {
        match = file.match(/OLSTXN-\w+-\d{8}-(\d{3})_/);
        if (match) {
          fileNum = parseInt(match[1], 10);
        }
      }
     
      if (!match && fileType === 'err') {
        match = file.match(/OLSDB009_(\d+)_\d{8}\.err/);
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
    const baseDir = CONFIG.winscp.remotePath;
   
    log(`[${testCase}] 🔍 Looking for files with date: ${currentDate}`);
    log(`[${testCase}] 🔍 Directory: ${baseDir}`);
   
    const findCommand = `find ${baseDir} -maxdepth 1 -type f \\( -name "OLSTXN-*-*-*_${currentDate}.out" -o -name "OLSTXN-*-*-*_${currentDate}.rej" -o -name "OLSDB009_*_${currentDate}.err" \\) 2>/dev/null`;
    log(`[${testCase}] 🔍 Running: ${findCommand}`);
   

    const findResult = await executeCustomCommand(findCommand, testCase);
    let outputFiles = findResult.stdout.trim().split('\n').filter(f => f.trim() !== '');
    log(`[${testCase}] 📁 Found ${outputFiles.length} total output files in directory`);
   
    if (outputFiles.length === 0) {
      log(`[${testCase}] ⚠️ No files found with find, trying ls...`);
//const lsCommand = `ls ${baseDir}OLSTXN-*-${currentDate}-*.{out,rej} ${baseDir}*.err 2>/dev/null`;

const lsCommand = `ls ${baseDir}OLSTXN-*-*-*_${currentDate}.{out,rej} ${baseDir}OLSDB009_*_${currentDate}.err 2>/dev/null`;


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
     
      let match = file.match(/OLSTXN-\w+-\d{8}-(\d{2})_/);
      if (match) {
        fileNum = parseInt(match[1], 10);
      }
     
      if (!match) {
        match = file.match(/OLSTXN-\w+-\d{8}-(\d{3})_/);
        if (match) {
          fileNum = parseInt(match[1], 10);
        }
      }
     
      if (!match && fileType === 'err') {
        match = file.match(/OLSDB009_(\d+)_\d{8}\.err/);
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
  const sourcePath = path.join(__dirname, '../test-data/generated/OLSDB009', `tc${tcId}`);
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



// ============ POSTGRESQL DATABASE HELPER FUNCTIONS ============

async function getDbConnection() {
  const client = new pg.Client({
    host: CONFIG.database.host,
    port: CONFIG.database.port,
    database: CONFIG.database.database,
    user: CONFIG.database.username,
    password: CONFIG.database.password,
  });
  await client.connect();
  return client;
}

async function executeDbQuery(query, testCase = 'DB') {
  let client = null;
  try {
    client = await getDbConnection();
    const result = await client.query(query);
    log(`[${testCase}] ✅ Query returned ${result.rows.length} row(s)`);
    return result.rows;
  } catch (error) {
    log(`[${testCase}] ❌ Query failed: ${error.message}`);
    return [];
  } finally {
    if (client) {
      await client.end();
    }
  }
}

async function testDatabaseConnection(testCase = 'DB') {
  const rows = await executeDbQuery('SELECT 1 AS ok', testCase);
  return rows.length > 0;
}


// ============ TEST CASE RUNNER ============
/**
 * Run one OLSDB009 case end to end, so a case only declares what it is and the
 * runner owns the plumbing:
 *
 *   generate -> scripts/test-data/generated/OLSDB009/<tcId>/
 *   stage    -> CONFIG.winscp.localPath
 *   upload   -> CONFIG.winscp.remotePath
 *   batch    -> CONFIG.batch.scriptPath + CONFIG.batch.command
 *   verify   -> OLSTXN-OLS-<HDdate>-<seq>_<pid>_<batchdate>.{out,rej} and
 *               OLSDB009_<pid>_<batchdate>.err in that same directory
 *
 * The expected number of result files comes from how many .dat files the case
 * generated, so no case hardcodes a count.
 *
 * @param {Object} opts
 * @param {string} opts.tcId     - TEST_CASES id in file-generator.js, e.g. 'tc1'
 * @param {string} opts.label   - human description for the log output
 * @param {string} [opts.expect] - 'true' (accepted) or 'false' (rejected)
 * @returns {Promise<Object>} the final verification result
 */
async function runBatchTestCase({ tcId, label, expect: expectedResult = 'true' }) {
  const tcName = tcId.toUpperCase();

  log(`\n${'='.repeat(60)}`);
  log(`🚀 STARTING ${tcName} - ${label}`);
  log(`${'='.repeat(60)}`);

  const startTime = Date.now();

  try {
    // ---- Step 1: generate this case's input files ----
    log('\n📋 Step 1: Generating input files...');
    const generated = await generateTestCase(tcId);
    const expectedFiles = generated.length;
    log(`📊 Generated ${expectedFiles} file(s): ${generated.join(', ')}`);

    expect(expectedFiles,
      `${tcName} produced no .dat files - check its build() in file-generator.js`
    ).toBeGreaterThan(0);

    const fileRange = { start: 1, end: expectedFiles };

    // ---- Step 2: stage locally ----
    log('\n📋 Step 2: Copying files to local staging...');
    await cleanLocalFolder(tcName);
    const copiedFiles = await copyFilesToLocal(tcId.replace(/^tc/, ''));
    log(`📊 Copied ${copiedFiles.length} file(s)`);

    expect(copiedFiles.length,
      `Staged ${copiedFiles.length}/${expectedFiles} files into ${CONFIG.winscp.localPath}`
    ).toBe(expectedFiles);

    // ---- Step 3: upload ----
    log('\n📋 Step 3: Uploading files...');
    const uploadResults = await uploadFiles(copiedFiles, tcName);
    const uploaded = uploadResults.filter(r => r.success).length;
    log(`📊 Uploaded ${uploaded}/${copiedFiles.length} file(s)`);

    expect(uploaded,
      `Only ${uploaded}/${copiedFiles.length} files reached ${CONFIG.winscp.remotePath}`
    ).toBe(copiedFiles.length);

    // ---- Step 4: run the batch ----
    log('\n📋 Step 4: Executing batch...');
    const batchResult = await executeBatch(tcName);
    expect(batchResult.success,
      `Batch command did not run, so no output will ever appear and the wait ` +
      `below would just time out. ${(batchResult.stderr || batchResult.error || '').trim()}`
    ).toBe(true);
    log('✅ Batch executed');

    // ---- Step 5: wait for the result files ----
    log('\n📋 Step 5: Waiting for result files...');
    const maxWaitTime = 300000;  // 5 minutes
    const checkInterval = 3000;
    let verification = null;
    let filesFound = 0;
    const waitStartTime = Date.now();

    while (Date.now() - waitStartTime < maxWaitTime) {
      verification = await verifyResults(tcName, expectedResult, fileRange);
      filesFound = verification.totalFiles;

      const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
      log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);

      if (filesFound >= expectedFiles) break;
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
    if (filesFound < expectedFiles) {
      log(`⚠️ Only ${filesFound}/${expectedFiles} files after ${totalWaitTime}s (timeout)`);
      if (verification) {
        log(`📁 Found: ${verification.outOnlyFiles.join(', ') || '(none)'}`);
        if (verification.rejOnlyFiles.length > 0) {
          log(`📁 Rejected: ${verification.rejOnlyFiles.join(', ')}`);
        }
      }
    } else {
      log(`✅ All files generated in ${totalWaitTime}s`);
    }

    // ---- Step 6: save + report ----
    if (!verification) {
      verification = await verifyResults(tcName, expectedResult, fileRange);
    }
    await saveTestResults(tcName, verification, fileRange, Date.now() - startTime);

    log(`\n📊 ${tcName} Results:`);
    log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
    log(`   ✅ Fully Passed: ${verification.passedFiles} (${verification.outOnlyFiles.join(', ') || '-'})`);
    if (verification.partialPassFiles > 0) {
      log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} (${verification.outAndRejFiles.join(', ')})`);
    }
    if (verification.rejectedFiles > 0) {
      log(`   ❌ Fully Rejected: ${verification.rejectedFiles} (${verification.rejOnlyFiles.join(', ')})`);
    }
    if (verification.errorFiles > 0) {
      log(`   🔴 System Error: ${verification.errorFiles} (${verification.errOnlyFiles.join(', ')})`);
    }
    log(`   📝 Total Records: ${verification.totalRecords}`);
    log(`   ✅ |true|: ${verification.trueCount}   ❌ |false|: ${verification.falseCount}`);

    expect(verification.totalFiles,
      `Batch produced ${verification.totalFiles} result file(s), expected ${expectedFiles}`
    ).toBe(expectedFiles);

    log(`\n✅ ${tcName} COMPLETED`);
    return verification;

  } catch (error) {
    log(`\n❌ ${tcName} FAILED`, { error: error.message });
    throw error;
  }
}

// ============ TEST SUITE ============

test.describe('OLSDB009 / OLSTXN - Transaction Adjustment Batch', () => {

  test.beforeAll(async () => {
    log('🚀 Starting OLSDB009 test suite setup...');
    log(`📅 Current date for files: ${date}`);
    log(`📤 Upload target: ${CONFIG.winscp.host}:${CONFIG.winscp.remotePath}`);
    log(`⚙️  Batch command: cd ${CONFIG.batch.scriptPath} && ${CONFIG.batch.command}`);

    fs.ensureDirSync('./test-data/generated');
    fs.ensureDirSync('./logs');
    fs.ensureDirSync('./reports');

    // Start each Playwright execution with a clean dashboard
    const masterPath = path.join(process.cwd(), 'batch-results.json');
    if (fs.existsSync(masterPath)) fs.removeSync(masterPath);
    if (fs.existsSync(EXECUTION_TRACKER_PATH)) fs.removeSync(EXECUTION_TRACKER_PATH);

    log('✅ Setup complete');
  });

  // ============================================================
  // One test per TEST_CASES entry in file-generator.js.
  // Input files come from generateTestCase() - no case stages its own data.
  // ============================================================

  test('TC01: Adjust transaction - 1 DT record',
    { tag: ['@critical', '@smoke'] },
    async () => {
      await runBatchTestCase({
        tcId: 'tc1',
        label: 'Adjust transaction, 1 DT record',
        expect: 'true',
      });
    });

  // NEXT CASES - add one entry here plus its build() in file-generator.js

});
