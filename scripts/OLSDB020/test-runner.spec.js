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
    remotePath: process.env.SFTP_REMOTE_PATH || '/apps/MY-dev/OE/cls/USER_INPUT/OLSDB020/',
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
    // that just hangs until execAsync kills it, so the batch never runs and no
    // error surfaces. -batch plus a pinned key skip the prompt entirely.
    hostKey: process.env.SSH_HOST_KEY || 'SHA256:kGbLBMkLSnBoYmLg10qgHfmQmtUbawS69GYysVLkXu4',
  },

  batch: {
    scriptPath: process.env.BATCH_SCRIPT_PATH || '/apps/MY-dev/scripts',
    command: process.env.BATCH_COMMAND || './OLSDB020',
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
        details: verification.details || [],

        // Set by verifyMccInDatabase when a test case checks the batch output
        // against ols_schema.mcc.
        database: verification.database || null
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
// `allowFailure` exists for the one case that deliberately uploads a file name the
// batch has already imported. The batch answers that with BE051, the job throws
// JobInterruptedException and the whole run exits 20 - the rejection being tested is
// exactly what makes the command "fail", so the exit code cannot be its verdict. That
// test asserts on the .rej/.err files instead. Everywhere else a non-zero exit is a
// real failure and is re-thrown.
async function executeBatch(testCase, { allowFailure = false } = {}) {
  const command = `cd ${CONFIG.batch.scriptPath} && ${CONFIG.batch.command}`;

  log(`[${testCase}] Executing batch...`);

  const plinkCommand = `"${CONFIG.putty.path}" ` +
    `-batch -hostkey "${CONFIG.putty.hostKey}" ` +
    `-ssh ${CONFIG.putty.username}@${CONFIG.putty.host} ` +
    `-pw ${CONFIG.putty.password} ` +
    `"${command}"`;

  // The batch is a Java job (mccFileImportJob via java -jar) and its output is sent
  // to /dev/null on the remote side, so this call produces no output at all while it
  // runs. 30s is not enough for a JVM to start and finish the import - plink gets
  // killed mid-run, which can leave the import half done. Keep this well below the
  // suite timeout (1200s) but far above a JVM start.
  try {
    const { stdout, stderr } = await execAsync(plinkCommand, {
      timeout: 600000,
      maxBuffer: 1024 * 1024 * 10
    });

    log(`[${testCase}] ✅ Batch executed (exit 0)`);
    return { success: true, exitCode: 0, stdout, stderr };

  } catch (error) {
    if (!allowFailure) throw error;

    log(`[${testCase}] ⚠️ Batch exited ${error.code} - expected for this case: ` +
        `${String(error.message).split('\n')[0]}`);
    return { success: false, exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
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


// // ============ Cleanup remote files ============
// async function cleanupRemoteFiles(testCase) {
//   try {
//     log(`[${testCase}] Cleaning up remote files`);

//     const command = `"${CONFIG.winscp.path}" /command ` +
//       `"option batch abort" ` +
//       `"option confirm off" ` +
//       `"open sftp://${CONFIG.winscp.username}:${CONFIG.winscp.password}@${CONFIG.winscp.host}/" ` +
//       `"cd ${CONFIG.winscp.remotePath}" ` +
//       `"rm OLSTERM-*.dat" ` +
//       `"exit"`;

//     await execAsync(command, { timeout: 30000 });
//     log(`[${testCase}] ✅ Cleanup successful`);

//   } catch (error) {
//     if (!error.message.includes('No files matching')) {
//       log(`[${testCase}] ⚠️ Cleanup warning`, { error: error.message });
//     }
//   }
// }


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
    details: [],
    // Flat lists of the DT records the batch judged, kept for the DB layer.
    passedRecords: [],
    failedRecords: []
  };
 
  try {
    const currentDate = getCurrentDate();
    // OLSMCC writes its .out/.rej into the same directory the input was uploaded
    // to - same arrangement as OLSDB009.
    const baseDir = CONFIG.winscp.remotePath;

    log(`[${testCase}] 🔍 Looking for files with date: ${currentDate}`);
    log(`[${testCase}] 🔍 Directory: ${baseDir}`);

    const findCommand = `find ${baseDir} -maxdepth 1 -type f \\( -name "OLSMCC-${currentDate}-*.out" -o -name "OLSMCC-${currentDate}-*.rej" -o -name "*.err" \\) 2>/dev/null`;
    log(`[${testCase}] 🔍 Running: ${findCommand}`);



    const findResult = await executeCustomCommand(findCommand, testCase);
    let outputFiles = findResult.stdout.trim().split('\n').filter(f => f.trim() !== '');
    log(`[${testCase}] 📁 Found ${outputFiles.length} total output files in directory`);

    if (outputFiles.length === 0) {
      log(`[${testCase}] ⚠️ No files found with find, trying ls...`);
      const lsCommand = `ls ${baseDir}OLSMCC-${currentDate}-*.{out,rej} ${baseDir}*.err 2>/dev/null`;
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
     
      let match = file.match(/OLSMCC-\d{8}-(\d{2})_/);
      if (match) {
        fileNum = parseInt(match[1], 10);
      }

      if (!match) {
        match = file.match(/OLSMCC-\d{8}-(\d{3})_/);
        if (match) {
          fileNum = parseInt(match[1], 10);
        }
      }

      if (!match && fileType === 'err') {
        match = file.match(/OLSDB020_(\d+)_\d{8}\.err/);
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
        errorMessage: null,
        trueRecords: [],
        falseRecords: []
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

            const trimmedLine = line.trim();
            // OLSMCC echoes the file back into the .out and appends its verdict to every
            // line it judged: "<input line>|<true|false>|<errorCode>|<message>". The HD,
            // the two FN headers and TR come back too, without a verdict. So the verdict
            // is what tells a judged line from the rest - not the line's own prefix. An
            // unknown record type (XX) is judged like any other record but does not start
            // with DT, and keying on the prefix made a file of nothing but XX lines look
            // as if the batch had reported no records at all.
            if (!trimmedLine.includes('|true|') && !trimmedLine.includes('|false|')) continue;

            fileResult.recordCount++;

            // Fields 1..3 of the echoed line are mccScheme, mccMCC and mccDESC
            // (RECORD DEFINITION(2) in MCCBatch.docx); the verdict is appended after
            // them. Collect them so the DB layer can check what the batch stored.
            const parts = trimmedLine.split('|');
            const record = {
              fileNumber: fileNum,
              scheme: parts[1],
              code: parts[2],
              desc: parts[3]
            };

            if (trimmedLine.includes('|true|')) {
              fileResult.trueCount++;
              results.trueCount++;
              fileResult.trueRecords.push(record);
            } else {
              fileResult.falseCount++;
              results.falseCount++;
              fileResult.falseRecords.push(record);
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
      results.passedRecords.push(...fileResult.trueRecords);
      results.failedRecords.push(...fileResult.falseRecords);
     
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
    details: [],
    // Flat lists of the DT records the batch judged, kept for the DB layer.
    passedRecords: [],
    failedRecords: []
  };
 
  try {
    const currentDate = getCurrentDate();
    const baseDir = '/apps/SG-auto/OE/cls/USER_INPUT/OLSDB024/';
   
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
     
      let match = file.match(/OLSMCC-\d{8}-(\d{2})_/);
      if (match) {
        fileNum = parseInt(match[1], 10);
      }

      if (!match) {
        match = file.match(/OLSMCC-\d{8}-(\d{3})_/);
        if (match) {
          fileNum = parseInt(match[1], 10);
        }
      }

      if (!match && fileType === 'err') {
        match = file.match(/OLSDB020_(\d+)_\d{8}\.err/);
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
        errorMessage: null,
        trueRecords: [],
        falseRecords: []
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
              // Each DT line in the .out is the echoed input row plus
              // "|<processDate>|<processTime>|<filler>|true|<filler>". Fields 1..3 are
              // mccScheme, mccMCC, mccDESC (RECORD DEFINITION(2) in MCCBatch.docx).
              // Collect them so the DB layer can check what the batch actually stored.
              const parts = trimmedLine.split('|');
              const record = {
                fileNumber: fileNum,
                scheme: parts[1],
                code: parts[2],
                desc: parts[3]
              };

              if (trimmedLine.endsWith('|true|') || trimmedLine.includes('|true|')) {
                fileResult.trueCount++;
                results.trueCount++;
                fileResult.trueRecords.push(record);
              } else if (trimmedLine.endsWith('|false|') || trimmedLine.includes('|false|')) {
                fileResult.falseCount++;
                results.falseCount++;
                fileResult.falseRecords.push(record);
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
      results.passedRecords.push(...fileResult.trueRecords);
      results.failedRecords.push(...fileResult.falseRecords);
     
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
  const sourcePath = path.join(__dirname, '../test-data/generated/OLSDB020', `tc${tcId}`);
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

  // Stopping here rather than returning an empty list. With nothing to upload the
  // batch used to run anyway, pick up whatever files were left on the server from an
  // earlier run, and fail with a duplicate-file error that has nothing to do with the
  // real problem. That cost a full batch cycle and pointed at the wrong thing twice.
  if (copiedFiles.length === 0) {
    throw new Error(
      `No .dat files found in ${sourcePath}. Run the generator first: ` +
      `node scripts/OLSDB020/file-generator.js`
    );
  }

  return copiedFiles;
}


// The batch keeps every accepted file name in ols_schema.batch_resource and refuses
// one it has already imported (error BE051, after which the job throws and the whole
// batch stops). file-generator.js therefore hands out the next unused sequence
// number on every regeneration, so the numbers in play change from run to run and
// cannot be hardcoded here. They are read back from the files that were just copied.
function fileNumberRangeOf(fileNames) {
  const numbers = fileNames
    .map(name => (name.match(/OLSMCC-\d{8}-(\d{2})\.dat$/) || [])[1])
    .filter(Boolean)
    .map(value => parseInt(value, 10));

  if (numbers.length === 0) return null;
  return { start: Math.min(...numbers), end: Math.max(...numbers) };
}


// Which of these names the batch has already imported, according to its own ledger.
// Returned rather than only reported because TC3 needs the opposite answer to the one
// below: it carries one file whose name is deliberately already in the ledger, and has
// to tell that file apart from the rest of the folder.
async function findAlreadyImportedNames(fileNames) {
  const client = await getDbConnection();
  try {
    const { rows } = await client.query(
      'SELECT DISTINCT logical_filename FROM batch_resource WHERE logical_filename = ANY($1)',
      [fileNames]
    );
    return rows.map(r => r.logical_filename);
  } finally {
    await client.end();
  }
}

// Uploading a file name the batch has already seen is the one mistake that costs a
// full batch cycle and reports something unrelated (BE051 -> STOPPED -> exit 20).
// It happens whenever the test is re-run without regenerating, because the generator
// is what moves the sequence numbers forward. Catching it here turns a 100 second
// batch failure into an immediate, actionable message.
async function assertFileNamesAreUnused(fileNames, testCase) {
  const used = await findAlreadyImportedNames(fileNames);

  if (used.length > 0) {
    throw new Error(
      `[${testCase}] These file names have already been imported by the batch: ${used.join(', ')}. ` +
      `Regenerate them with a fresh sequence number first: node scripts/OLSDB020/file-generator.js`
    );
  }
}


// The records actually sent, read back from the .dat files that were just copied -
// not from the .out file the batch writes. The two are compared further down, and
// reading the input is what makes the database check prove an INSERT: the batch can
// only have put these codes in mcc if it read them from here.
function readInputRecords(fileNames) {
  const records = [];
  for (const name of fileNames) {
    const content = fs.readFileSync(path.join(CONFIG.winscp.localPath, name), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      if (!line.startsWith('DT|')) continue;
      const parts = line.split('|');
      records.push({ file: name, scheme: parts[1], code: parts[2], desc: parts[3] });
    }
  }
  return records;
}

// Snapshotted before the batch runs. Without this, "every record was found in mcc"
// would also be true of records that were sitting there all along, which is exactly
// how the old hardcoded input managed to look like a pass every single run.
async function assertRecordsAreNew(records, testCase) {
  if (records.length === 0) return;

  const client = await getDbConnection();
  try {
    const { rows } = await client.query(
      `SELECT mcc_scheme, code FROM mcc
        WHERE (mcc_scheme, code) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
      [records.map(r => r.scheme), records.map(r => r.code)]
    );

    if (rows.length > 0) {
      const found = rows.map(r => `${r.mcc_scheme}/${r.code}`).join(', ');
      throw new Error(
        `[${testCase}] ${rows.length} of ${records.length} input records already exist in mcc ` +
        `before the batch ran: ${found}. This case is meant to test insertion, so the input has ` +
        `to carry codes that are not there yet - regenerate with: node scripts/OLSDB020/file-generator.js`
      );
    }

    log(`[${testCase}] ✅ None of the ${records.length} input records exist in mcc yet`);
  } finally {
    await client.end();
  }
}


// ============ POSTGRESQL DATABASE HELPER FUNCTIONS (OPTION B) ============

// Database connection function for PostgreSQL
async function getDbConnection() {
  // NOTE: node-postgres has no `schema` option - passing one is silently ignored
  // and every unqualified query then resolves against `public`. The schema is set
  // explicitly below instead.
  const client = new pg.Client({
    host: CONFIG.database.host,
    port: CONFIG.database.port,
    user: CONFIG.database.username,
    password: CONFIG.database.password,
    database: CONFIG.database.database,
  });

  try {
    await client.connect();
    await client.query(`SET search_path TO ${CONFIG.database.schema}`);
    log('✅ PostgreSQL connected successfully');
    return client;
  } catch (error) {
    log('❌ PostgreSQL connection failed', { error: error.message });
    throw error;
  }
}

// Local YYYY-MM-DD. mcc.last_update_date is a "timestamp without time zone", which
// node-postgres parses in local time, so it has to be compared against a local day
// rather than an ISO/UTC one.
function localDay(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Check that every record the batch marked as passed in the .out files really
// reached ols_schema, and that the archive step treated it the way the confirmed
// interface spec says it must.
//
// This is what turns a test case from "the file was uploaded" into "the business
// logic worked". There is no key linking a source file to its rows - mcc.batch_id
// only holds the program name ('OLSDB020') and mcc.batch_no is a business number,
// not a file name - so the comparison is by content, on the (mcc_scheme, code)
// pair. The description is compared after trimming because the interface spec
// declares mccDESC as X(40), i.e. space padded, while the column stores the raw
// string.
//
// The input files carry disjoint records, so three of the four are archived during the
// same run that inserted them. Confirmed with the BA that this is the specified
// behaviour - an MCC file is a full refresh - so that is asserted, not treated as a
// failure. Three checks together prove it happened:
//   inserted  - every record sent reached the database (mcc or mcc_his). A record in
//               neither was accepted in the .out file but never written, which is the
//               real data loss and the reason this function exists.
//   live      - the LAST file's records are in mcc with status 'A' and a matching
//               description. The last file of a run is the one the system keeps.
//   archived  - every earlier file's records are in mcc_his with status 'I'. Still
//               active in mcc means the refresh did not run and the table is stale.
async function verifyMccInDatabase(verification, testCase) {
  const sent = verification.passedRecords || [];
  const runDay = localDay(new Date());

  const result = {
    checked: 0,
    lastFileNumber: null,
    inserted: 0,
    notInserted: [],
    expectedLive: 0,
    live: 0,
    writtenToday: 0,
    liveMismatch: [],
    expectedArchived: 0,
    archived: [],
    notArchived: []
  };

  if (sent.length === 0) {
    log(`[${testCase}] ⚠️ No passed records to verify against the database`);
    return result;
  }

  // One entry per distinct record. With disjoint files each code appears once, so this
  // is a guard rather than a real merge - it keeps the counting honest if a later test
  // case does repeat a record across files.
  const records = [];
  const seen = new Set();
  for (const rec of sent) {
    const key = `${String(rec.scheme).trim()} ${String(rec.code).trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(rec);
  }
  result.checked = records.length;

  // The last file is the one whose contents survive, so its number decides which
  // records must still be live and which must have been archived.
  result.lastFileNumber = records.reduce(
    (max, rec) => Math.max(max, Number(rec.fileNumber) || 0), 0
  );

  // One connection for the whole check rather than one per record.
  const client = await getDbConnection();

  try {
    const schemes = [...new Set(records.map(r => String(r.scheme).trim()))];
    const codes = records.map(r => String(r.code).trim());

    const active = await client.query(
      `SELECT mcc_scheme, code, status, description_english, last_update_date
         FROM mcc
        WHERE mcc_scheme = ANY($1)`,
      [schemes]
    );
    const liveByKey = new Map();
    for (const row of active.rows) {
      liveByKey.set(`${String(row.mcc_scheme).trim()} ${String(row.code).trim()}`, row);
    }

    // mcc_his is where the archive step puts a row it takes out of mcc, and its
    // last_update_date keeps the real time of that move - unlike mcc, whose value is
    // flattened to midnight. That timestamp is what keeps a row archived by an earlier
    // run (a fresh code can collide with one archived before) from being read as a
    // record of this run. ORDER BY DESC + first-wins keeps the newest row per key.
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const archivedRows = await client.query(
      `SELECT mcc_scheme, code, status, description_english
         FROM mcc_his
        WHERE mcc_scheme = ANY($1) AND code = ANY($2) AND last_update_date >= $3
        ORDER BY last_update_date DESC`,
      [schemes, codes, todayStart]
    );
    const archivedByKey = new Map();
    for (const row of archivedRows.rows) {
      const key = `${String(row.mcc_scheme).trim()} ${String(row.code).trim()}`;
      if (!archivedByKey.has(key)) archivedByKey.set(key, row);
    }

    for (const rec of records) {
      const key = `${String(rec.scheme).trim()} ${String(rec.code).trim()}`;
      const liveRow = liveByKey.get(key);
      const hisRow = archivedByKey.get(key);
      const where = { scheme: rec.scheme, code: rec.code, fromFile: rec.fileNumber };

      // Reached the database at all - live in mcc, or archived to mcc_his during this run.
      if (liveRow || hisRow) result.inserted++;
      else result.notInserted.push(where);

      if (Number(rec.fileNumber) === result.lastFileNumber) {
        result.expectedLive++;
        if (!liveRow) {
          result.liveMismatch.push({ ...where, reason: 'not in mcc' });
        } else if ((liveRow.status || '').trim() !== 'A') {
          result.liveMismatch.push({ ...where, reason: `status=${liveRow.status}` });
        } else if ((liveRow.description_english || '').trim() !== (rec.desc || '').trim()) {
          result.liveMismatch.push({
            ...where,
            reason: 'description differs',
            inFile: rec.desc,
            inDatabase: liveRow.description_english
          });
        } else {
          result.live++;
          // Informational only, never asserted: OLSDB020 stamps mcc.last_update_date at
          // 00:00:00, so a same-day re-run is indistinguishable from the first run here.
          if (localDay(liveRow.last_update_date) === runDay) result.writtenToday++;
        }
      } else {
        // Not in the last file, so the spec says it must be deactivated - moved to
        // mcc_his or flipped to 'I'. Still active in mcc means the refresh did not run.
        result.expectedArchived++;
        if (!hisRow) {
          result.notArchived.push({ ...where, stillActiveInMcc: !!liveRow });
        } else if ((hisRow.status || '').trim() !== 'I') {
          result.notArchived.push({ ...where, reason: `mcc_his status=${hisRow.status}` });
        } else {
          result.archived.push(where);
        }
      }
    }

    log(`[${testCase}] 📊 DB check: ${result.inserted}/${result.checked} records reached ${CONFIG.database.schema}` +
        ` (${result.live} live in mcc from the last file, ${result.archived.length} archived to mcc_his,` +
        ` ${result.writtenToday} carry today's date)`);
    if (result.notInserted.length > 0) {
      log(`[${testCase}] ❌ Never written to the database (${result.notInserted.length}):`, result.notInserted);
    }
    if (result.liveMismatch.length > 0) {
      log(`[${testCase}] ❌ Last file not live in mcc (${result.liveMismatch.length}):`, result.liveMismatch);
    }
    if (result.notArchived.length > 0) {
      log(`[${testCase}] ❌ Earlier records not archived (${result.notArchived.length}):`, result.notArchived);
    }

    return result;

  } catch (error) {
    log(`[${testCase}] ❌ DB verification failed`, { error: error.message });
    throw error;
  } finally {
    await client.end();
  }
}

// The record-level companion to verifyMccInDatabase. TC1 proves that a file the batch
// accepted really was written; this proves that a file the batch judged line by line
// really did refuse the lines it marked |false| and really did keep the ones it marked
// |true|.
//
// Only some of the refused lines can be checked. A line whose scheme or code is merely
// absent from mcc today ('A2', 'abc') proves nothing by its absence: creating a code
// that is not there yet is exactly what this batch is for (spec TC_01_16 to TC_01_18),
// so "not in mcc" is what a bug would look like too. What is checked instead is the
// lines that cannot be a stored row whatever the batch does - mcc.code is varchar(10)
// NOT NULL and mcc.mcc_scheme is varchar(10), so an empty or over-long value has
// nowhere to go. The rest are judged by the |false| flag in the .out file, which is
// where the batch states its own verdict.
//
// The accepted lines are checked the other way round - each has to be in mcc and
// active. Two of them use the OLSR prefix, which nothing else writes, so finding them
// there is proof of an insert rather than of data that was already present.
async function verifyRejectedLinesWereNotStored(verification, fileNumber, testCase) {
  const result = {
    checkedRefused: 0,
    storedAnyway: [],
    checkedAccepted: 0,
    acceptedMissing: []
  };

  const detail = (verification.details || [])
    .find(d => Number(d.fileNumber) === Number(fileNumber));

  if (!detail) {
    log(`[${testCase}] ⚠️ No output for the record-level file ${fileNumber} - cannot check it against the database`);
    return result;
  }

  const trim = value => String(value === undefined || value === null ? '' : value).trim();
  // Anything the columns cannot hold is objectively impossible, so its presence in mcc
  // would be a defect no matter what the batch decided about the line.
  const cannotBeStored = r =>
    !trim(r.scheme) || !trim(r.code) || trim(r.scheme).length > 10 || trim(r.code).length > 10;

  const refused = (detail.falseRecords || []).filter(cannotBeStored);
  const accepted = detail.trueRecords || [];
  result.checkedRefused = refused.length;
  result.checkedAccepted = accepted.length;

  const client = await getDbConnection();
  try {
    const stored = await client.query(
      `SELECT mcc_scheme, code FROM mcc
        WHERE (mcc_scheme, code) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
      [refused.map(r => trim(r.scheme)), refused.map(r => trim(r.code))]
    );
    result.storedAnyway = stored.rows.map(r => ({ scheme: r.mcc_scheme, code: r.code }));

    const present = await client.query(
      `SELECT mcc_scheme, code, status FROM mcc
        WHERE (mcc_scheme, code) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
      [accepted.map(r => trim(r.scheme)), accepted.map(r => trim(r.code))]
    );
    const byKey = new Map(present.rows.map(r => [`${trim(r.mcc_scheme)} ${trim(r.code)}`, r]));

    for (const r of accepted) {
      const row = byKey.get(`${trim(r.scheme)} ${trim(r.code)}`);
      if (!row) {
        result.acceptedMissing.push({ scheme: r.scheme, code: r.code, reason: 'not in mcc' });
      } else if (trim(row.status) !== 'A') {
        result.acceptedMissing.push({ scheme: r.scheme, code: r.code, reason: `status=${row.status}` });
      }
    }

  } catch (error) {
    log(`[${testCase}] ❌ DB check on the record-level file failed`, { error: error.message });
    throw error;
  } finally {
    await client.end();
  }

  log(`[${testCase}] 📊 DB check on the record-level file: ` +
      `${result.checkedRefused} refused lines that can never be stored (${result.storedAnyway.length} stored anyway), ` +
      `${result.checkedAccepted} accepted lines (${result.acceptedMissing.length} not present and active)`);
  if (result.storedAnyway.length > 0) {
    log(`[${testCase}] ❌ Refused lines found in mcc (${result.storedAnyway.length}):`, result.storedAnyway);
  }
  if (result.acceptedMissing.length > 0) {
    log(`[${testCase}] ❌ Accepted lines missing from mcc (${result.acceptedMissing.length}):`, result.acceptedMissing);
  }

  return result;
}

// The two file-name cases, which verifyResults() cannot see. A file named
// OLSMCC-YYYYMMDD.dat has no sequence number, so the patterns it groups by cannot place
// it anywhere - whatever the batch writes for it is invisible to that pass. The
// duplicate's rejection is invisible for the opposite reason: it is written under a
// number that belongs to an earlier import and therefore falls outside the range this
// run scans. Both are asked about directly instead, by looking for the output that
// should exist.
async function verifyFileNameCases(duplicateName, testCase) {
  const currentDate = getCurrentDate();
  const dir = CONFIG.winscp.remotePath;
  const result = {
    duplicateRejected: false,
    duplicateEvidence: null,
    malformedRejected: false,
    malformedEvidence: null
  };

  // One listing, filtered here rather than by a shell pattern: the distinction that
  // matters is "a .rej for a name with no sequence number", and spelling that as a glob
  // is how a pattern quietly stops matching.
  // Newest first: the output directory is never cleaned between runs, so a previous
  // run's .rej for the same name is still sitting there and would otherwise be read as
  // this run's evidence - the batch only ever writes a new job number, never overwrites.
  const listing = await executeCustomCommand(`ls -1t ${dir}OLSMCC-${currentDate}*.rej 2>/dev/null`, testCase);
  const rejections = listing.stdout.trim().split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(file => path.basename(file));

  const duplicateNumber = (duplicateName.match(/OLSMCC-\d{8}-(\d{2})\.dat$/) || [])[1] || null;
  const unNumberedName = `OLSMCC-${currentDate}.dat`;

  const duplicateRejections = duplicateNumber
    ? rejections.filter(f => f.startsWith(`OLSMCC-${currentDate}-${duplicateNumber}_`))
    : [];
  // Anything today that is not OLSMCC-<date>-<nn>_...: only the sequence-less name can
  // produce that shape.
  const malformedRejections = rejections.filter(f => !/^OLSMCC-\d{8}-\d{2,3}_/.test(f));

  if (duplicateRejections.length > 0) {
    // The content is the assertion: BE051 writes "File '<name>' already exist". A .rej
    // saying anything else would mean the file was refused for another reason.
    const cat = await executeCustomCommand(`cat ${dir}${duplicateRejections[0]}`, testCase);
    result.duplicateEvidence = `${duplicateRejections[0]}: ${cat.stdout.trim().split('\n')[0] || ''}`.trim();
    result.duplicateRejected = /already exist/i.test(cat.stdout);
  }

  if (malformedRejections.length > 0) {
    const cat = await executeCustomCommand(`cat ${dir}${malformedRejections[0]}`, testCase);
    result.malformedEvidence = `${malformedRejections[0]}: ${cat.stdout.trim().split('\n')[0] || ''}`.trim();
    result.malformedRejected = true;
  } else {
    // The batch does not always answer a refusal with a .rej. A file it never read far
    // enough to produce one is logged in an .err instead, and the .err is named after
    // the job rather than after the file - the only way to find it is by content.
    const grep = await executeCustomCommand(
      `grep -l "${unNumberedName}" ${dir}*.err 2>/dev/null | head -5`, testCase);
    const errFiles = grep.stdout.trim().split('\n').map(l => path.basename(l.trim())).filter(Boolean);

    if (errFiles.length > 0) {
      const cat = await executeCustomCommand(`cat ${dir}${errFiles[0]}`, testCase);
      result.malformedEvidence = `${errFiles[0]}: ${cat.stdout.trim().substring(0, 200)}`;
      result.malformedRejected = /REJECT/i.test(cat.stdout);
    }
  }

  log(`[${testCase}] 📛 Duplicate name ${duplicateName}: ${result.duplicateRejected ? 'refused' : 'NOT refused'} ` +
      `(${result.duplicateEvidence || `${rejections.length} .rej files today, none for number ${duplicateNumber}`})`);
  log(`[${testCase}] 📛 Name with no sequence number ${unNumberedName}: ` +
      `${result.malformedRejected ? 'refused' : 'NOT refused'} (${result.malformedEvidence || 'no .rej and no .err mentions it'})`);

  return result;
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

    // Every run needs input files the batch has never seen. The batch keeps a ledger of
    // every logical_filename it has accepted (batch_resource) and answers a repeat with
    // BE051 -> STOPPED -> exit 20, so reusing the previous run's files can never work.
    // Only the generator knows which sequence numbers are still free - it reads that
    // ledger and starts at max+1 - so it is run here, on every execution, rather than
    // being a step that has to be remembered. It only writes local files and reads the
    // database; the batch is what writes to the server.
    log('🎲 Generating fresh input files...');
    let generatorOutput;
    try {
      const { stdout } = await execAsync('node scripts/OLSDB020/file-generator.js', {
        cwd: process.cwd(),
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024
      });
      generatorOutput = stdout;
    } catch (error) {
      throw new Error(
        `File generator failed, so there is nothing fresh to upload:\n` +
        `${error.stdout || ''}\n${error.stderr || error.message}`
      );
    }
    // Only the lines that say what was produced and with which seed - the generator
    // prints one line per file, which would bury the rest of the run log.
    for (const line of generatorOutput.split(/\r?\n/)) {
      if (/Seed:|highest sequence|TC1 records|Cleaned|Total files generated|tc1\//.test(line)) {
        log(`   ${line.trim()}`);
      }
    }

    log('✅ Setup complete');
  });


//  // ============================================================
//   // TC1 - 4 FILES (01-04) - 17 RECORDS - ALL VALID - Expected: TRUE
//   // ============================================================
//   test.describe('TC1: 4 Files All Valid (17 records)', () => {

//   test('TC1: Process 4 files - 17 valid records', { tag: ['@critical', '@smoke'] }, async () => {
//     const tcId = '1';
//     log(`\n${'='.repeat(60)}`);
//     log(`🚀 STARTING TC${tcId} - All Valid`);
//     log(`${'='.repeat(60)}`);
  
//     const startTime = Date.now();
  
//     try {
//       await cleanLocalFolder(`TC${tcId}`);
  
//       log('\n📋 Step 1: Copying files to local...');
//       const copiedFiles = await copyFilesToLocal(tcId);
//       log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
//       await assertFileNamesAreUnused(copiedFiles, `TC${tcId}`);
//       await assertRecordsAreNew(readInputRecords(copiedFiles), `TC${tcId}`);

//       log('\n📋 Step 2: Uploading files...');
//       const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
//       log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
//       log('\n📋 Step 3: Executing batch...');
//       const batchResult = await executeBatch(`TC${tcId}`);
//       log(`✅ Batch executed successfully`);
  
//       // STEP 4: SMART WAIT - Wait for ALL files to be generated
//       log('\n📋 Step 4: Waiting for output files to be generated...');
      
//       const expectedFiles = copiedFiles.length; // TC1: 4 input files, 17 records total
//       // Only the file numbers just uploaded are looked at. The output directory also
//       // holds the .out/.rej of earlier runs of the same day and every .err file ever
//       // written, so an unfiltered scan would count those as well.
//       const fileRange = fileNumberRangeOf(copiedFiles);
//       log(`📁 Expecting output for file numbers ${fileRange ? `${fileRange.start}-${fileRange.end}` : '(none - no .dat copied)'}`);
//       const maxWaitTime = 300000; // Maximum wait: 5 minutes
//       const checkInterval = 3000; // Check every 3 seconds
//       let verification = null;
//       let filesFound = 0;
//       const waitStartTime = Date.now();
  
//       while (Date.now() - waitStartTime < maxWaitTime) {
//           // Check current files
//           verification = await verifyResults(`TC${tcId}`, 'true', fileRange);
//           filesFound = verification.totalFiles;
          
//           const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//           log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
//           if (filesFound === expectedFiles) {
//               log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
//               break;
//           }
          
//           // Wait before checking again
//           await new Promise(resolve => setTimeout(resolve, checkInterval));
//       }
  
//       // After waiting, show final status
//       const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//       if (filesFound < expectedFiles) {
//           log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
//           if (verification) {
//               log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
//               if (verification.rejOnlyFiles.length > 0) {
//                   log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
//               }
//           }
//       } else {
//           log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
//       }
  
//       // STEP 5: FINAL VERIFICATION (uses the last verification result)
//       log('\n📋 Step 5: Final verification...');
      
//       // If verification is null (shouldn't happen), run it one more time
//       if (!verification) {
//           verification = await verifyResults(`TC${tcId}`, 'true', fileRange);
//       }
      
//       // STEP 6: DATABASE VERIFICATION
//       // Every DT record the batch marked |true| must exist in ols_schema.mcc with
//       // the scheme, code and description that were sent in the input file.
//       log('\n📋 Step 6: Verifying records were inserted into the database...');
//       const dbResult = await verifyMccInDatabase(verification, `TC${tcId}`);
//       verification.database = dbResult;

//       // SAVE RESULTS TO JSON FILE FOR DASHBOARD

//       const duration = Date.now() - startTime;
//       await saveTestResults(`TC${tcId}`, verification, fileRange, duration);

//       log(`\n📊 TC${tcId} Results:`);
//       log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
//       log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
//       if (verification.partialPassFiles > 0) {
//         log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
//       }
//       if (verification.rejectedFiles > 0) {
//         log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
//       }
//       if (verification.errorFiles > 0) {
//         log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
//       }
//       log(`   📝 Total Records: ${verification.totalRecords}`);
//       log(`   ✅ |true|: ${verification.trueCount}`);
//       log(`   ❌ |false|: ${verification.falseCount}`);
//       log(`   🗄️  DB reached: ${dbResult.inserted}/${dbResult.checked} distinct records (${dbResult.notInserted.length} never written)`);
//       log(`   🗄️  DB live in mcc (last file, ${dbResult.lastFileNumber}): ${dbResult.live}/${dbResult.expectedLive} (${dbResult.liveMismatch.length} problems)`);
//       log(`   🗄️  DB archived to mcc_his (earlier files): ${dbResult.archived.length}/${dbResult.expectedArchived} (${dbResult.notArchived.length} not archived)`);

//       // ============================================================
//       // ASSERTIONS - without these the test passes no matter what.
//       // ============================================================
//       expect(verification.totalFiles, 'TC1 expects 4 input files to be processed').toBe(expectedFiles);
//       expect(verification.rejectedFiles, 'No file should be fully rejected').toBe(0);
//       expect(verification.failedFiles, 'No file should be fully failed').toBe(0);
//       expect(verification.errorFiles, 'No file should hit a system error').toBe(0);
//       // Four disjoint files carrying 1 + 5 + 4 + 7 = 17 distinct codes, so 17 DT lines.
//       expect(verification.totalRecords, 'TC1 sends 17 DT lines across 4 files').toBe(17);
//       expect(verification.trueCount, 'All 17 DT lines should pass').toBe(17);
//       expect(verification.falseCount, 'No record should fail').toBe(0);

//       // Every one of the 17 codes has to have reached the database. A record in neither
//       // mcc nor mcc_his was accepted in the .out file but never written - the real loss.
//       expect(dbResult.checked, 'TC1 sends 17 distinct MCC codes').toBe(17);
//       expect(dbResult.notInserted, 'Every accepted record must reach the database').toEqual([]);
//       expect(dbResult.inserted, 'All 17 records must be written').toBe(dbResult.checked);

//       // The last file is the one the system keeps: its 7 records must be live in mcc with
//       // status 'A' and the description that was sent.
//       expect(dbResult.expectedLive, 'Only the last file\'s 7 records stay live').toBe(7);
//       expect(dbResult.liveMismatch, 'Last file records must be live in mcc (status=A, desc match)').toEqual([]);
//       expect(dbResult.live, 'All 7 last-file records must match in the database').toBe(dbResult.expectedLive);

//       // The other three files are not in the last file, so the confirmed spec requires
//       // them to be deactivated - moved to mcc_his with status 'I'. This is the check that
//       // proves the full-refresh behaviour actually ran.
//       expect(dbResult.expectedArchived, 'The first three files\' 10 records must be archived').toBe(10);
//       expect(dbResult.notArchived, 'Earlier records must be deactivated by the archive step').toEqual([]);
//       expect(dbResult.archived, 'All 10 earlier records must be in mcc_his').toHaveLength(dbResult.expectedArchived);

//       log(`\n✅ TC${tcId} COMPLETED`);
  
//     } catch (error) {
//       log(`\n❌ TC${tcId} FAILED`, { error: error.message });
//       throw error;
//     }
//   });
//   });
  

  // ============================================
  // T3: file-level and record-level defects
  //to validate at the file level and the record level, the batch should reject the file and 
  // the records that are invalid. The batch should accept the valid records and insert them 
  // into the database. The test will verify that the rejected files and records are not inserted 
  // into the database and that the accepted records are inserted correctly.
  // ============================================
  
  // test.describe(' TC3: file-level and record-level defects', () => {

  // test('TC3: file-level and record-level defects', { tag: ['@critical', '@smoke'] }, async () => {
  //   const tcId = '3';
  //   log(`\n${'='.repeat(60)}`);
  //   log(`🚀 STARTING TC${tcId} - file-level and record-level defects`);
  //   log(`${'='.repeat(60)}`);

  //   const startTime = Date.now();

  //   try {
  //     await cleanLocalFolder(`TC${tcId}`);

  //     log('\n📋 Step 1: Copying files to local...');
  //     const copiedFiles = await copyFilesToLocal(tcId);
  //     log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);

      
  //     const alreadySeen = await findAlreadyImportedNames(copiedFiles);
  //     const unNumberedNames = copiedFiles.filter(name => name === `OLSMCC-${getCurrentDate()}.dat`);
  //     const duplicateNames = copiedFiles.filter(name => alreadySeen.includes(name) && !unNumberedNames.includes(name));
  //     const unNumberedWasAlreadySeen = unNumberedNames.some(name => alreadySeen.includes(name));
  //     const freshFiles = copiedFiles.filter(name => !alreadySeen.includes(name));

  //     log(`\n📋 Step 2: Classifying the file names...`);
  //     log(`   ♻️  Name already in the ledger (expected exactly 1): ${duplicateNames.join(', ') || 'none'}`);
  //     log(`   📛 Name with no sequence number: ${unNumberedNames.join(', ') || 'none'}` +
  //         `${unNumberedWasAlreadySeen ? ' (already in the ledger from an earlier run today)' : ' (not in the ledger yet)'}`);
  //     log(`   🆕 Fresh: ${freshFiles.length}`);

  //     expect(unNumberedNames,
  //       `tc${tcId}/ must hold one file named OLSMCC-${getCurrentDate()}.dat (TC_01_7). ` +
  //       `Regenerate: node scripts/OLSDB020/file-generator.js`
  //     ).toHaveLength(1);

  //     expect(duplicateNames,
  //       `tc${tcId}/ must hold exactly one file whose name the batch has already seen. ` +
  //       `Regenerate with a fresh sequence number: node scripts/OLSDB020/file-generator.js`
  //     ).toHaveLength(1);

  //     // Everything except that one file has to be unseen, or the batch stops on BE051
  //     // for the wrong file and every verdict below is meaningless.
  //     await assertFileNamesAreUnused(freshFiles, `TC${tcId}`);

  //     log('\n📋 Step 3: Uploading files...');
  //     const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
  //     const uploaded = uploadResults.filter(r => r.success).length;
  //     log(`📊 Uploaded ${uploaded} files successfully`);
  //     expect(uploaded, `Every file in tc${tcId}/ must reach the server`).toBe(copiedFiles.length);

  //     log('\n📋 Step 4: Executing batch...');
  //     // allowFailure: the duplicate name makes the job throw JobInterruptedException and
  //     // the run exit 20. That rejection IS the case under test, so the exit code cannot
  //     // be its verdict - the .rej file is.
  //     const batchResult = await executeBatch(`TC${tcId}`, { allowFailure: true });
  //     log(`✅ Batch finished (exit ${batchResult.exitCode})`);

  //     // The non-zero exit is tolerated only because one file was meant to cause it. If
  //     // the run failed without that reason, it failed for a reason worth stopping on.
  //     if (batchResult.exitCode !== 0) {
  //       log(`[TC${tcId}] ⚠️ Batch exited ${batchResult.exitCode} - checking it was the duplicate name that caused it`);
  //     }

  //     // STEP 5: SMART WAIT - Wait for ALL files to be generated
  //     log('\n📋 Step 5: Waiting for output files to be generated...');

  //     // The file whose name has no sequence number is deliberately left out: the
  //     // patterns verification groups by cannot see it, so counting it here would mean
  //     // waiting forever for output that never gets counted.
  //     const numberedFiles = freshFiles.filter(name => /OLSMCC-\d{8}-\d{2}\.dat$/.test(name));
  //     const fileRange = fileNumberRangeOf(freshFiles);
  //     expect(fileRange, `No numbered files in tc${tcId}/ to verify`).not.toBeNull();
  //     const expectedFiles = fileRange.end - fileRange.start + 1;
  //     log(`📊 Expecting ${expectedFiles} numbered outputs (files ${fileRange.start}-${fileRange.end}) ` +
  //         `from ${numberedFiles.length} numbered inputs`);

  //     const maxWaitTime = 300000;
  //     const checkInterval = 5000;
  //     let verification = null;
  //     let filesFound = 0;
  //     const waitStartTime = Date.now();

  //     while (Date.now() - waitStartTime < maxWaitTime) {
  //       // 'false': this case exists to be refused. It matters beyond bookkeeping -
  //       // verifyResults() decides the run's success flag from it.
  //       verification = await verifyResults(`TC${tcId}`, 'false', fileRange);
  //       filesFound = verification.totalFiles;

  //       const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
  //       log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);

  //       if (filesFound >= expectedFiles) {
  //         log(`✅ All ${expectedFiles} files accounted for after ${elapsed} seconds`);
  //         break;
  //       }

  //       await new Promise(resolve => setTimeout(resolve, checkInterval));
  //     }

  //     const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
  //     if (filesFound < expectedFiles) {
  //       log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
  //     } else {
  //       log(`✅ All files accounted for in ${totalWaitTime} seconds`);
  //     }

  //     if (!verification) {
  //       verification = await verifyResults(`TC${tcId}`, 'false', fileRange);
  //     }

  //     const duration = Date.now() - startTime;
  //     const recordFileNumber = fileRange.end;

  //     log(`\n📋 Step 6: Verifying the file-level defects...`);
  //     // The generator writes the shared record-level file last, so it holds the highest
  //     // number in the run; the ten files before it each carry exactly one defect of the
  //     // file itself and have to be refused outright.
  //     const defectDetails = verification.details
  //       .filter(d => Number(d.fileNumber) >= fileRange.start && Number(d.fileNumber) < recordFileNumber);

  //     const notRejected = defectDetails.filter(d => d.status !== 'REJECTED');
  //     log(`   📄 ${defectDetails.length} file-level defect files, ${defectDetails.length - notRejected.length} refused outright`);

  //     expect(defectDetails.map(d => Number(d.fileNumber)),
  //       `Every number from ${fileRange.start} to ${recordFileNumber - 1} must have produced output`
  //     ).toEqual(Array.from({ length: recordFileNumber - fileRange.start }, (_, i) => fileRange.start + i));

  //     expect(notRejected.map(d => `${d.fileNumber}: ${d.status} (out=${d.hasOut}, rej=${d.hasRej}, err=${d.hasErr}, ` +
  //       `rejection="${(d.rejectionReason || '').substring(0, 120)}")`),
  //       `A file-level defect must be refused, not silently accepted and not turned into a system error`
  //     ).toEqual([]);

  //     expect(verification.rejectedFiles, `Files refused outright`).toBe(recordFileNumber - fileRange.start);
  //     expect(verification.errorFiles, `Files that died with a system error instead of a refusal`).toBe(0);

  //     log(`\n📋 Step 7: Verifying the record-level file (number ${recordFileNumber})...`);
  //     const recordDetail = verification.details.find(d => Number(d.fileNumber) === recordFileNumber);
  //     expect(recordDetail, `No output found for the record-level file ${recordFileNumber}`).toBeTruthy();

  //     log(`   📄 File ${recordFileNumber}: ${recordDetail.status} | Records: ${recordDetail.recordCount} | ` +
  //         `True: ${recordDetail.trueCount} | False: ${recordDetail.falseCount}`);
  //     log(`   📄 Rejection reason: ${(recordDetail.rejectionReason || '(none)').substring(0, 300)}`);

  //     // One file, 16 judged lines: 11 that break a rule and 5 valid controls. The
  //     // controls are what make the 11 mean anything - without them a file that rejected
  //     // every line would look the same as one that judged each line.
  //     expect(recordDetail.recordCount, `Judged lines the batch reported on`).toBe(16);
  //     expect(recordDetail.trueCount, `Valid control lines that must be accepted`).toBe(5);
  //     expect(recordDetail.falseCount, `Defective lines that must be refused`).toBe(11);
  //     expect(recordDetail.hasOut, `A file judged line by line must still produce a .out`).toBe(true);

  //     // PARTIAL is the status verifyResults() assigns when a file holds both accepted
  //     // and refused lines. Anything else means the batch reported this file some other
  //     // way, which is a finding rather than a failure of this test.
  //     if (recordDetail.status !== 'PARTIAL') {
  //       log(`   ⚠️ The record-level file was classified ${recordDetail.status}, not PARTIAL - ` +
  //           `the batch did not write a .rej alongside its .out`);
  //     }

  //     log(`\n📋 Step 8: Verifying the two file names...`);
  //     if (unNumberedWasAlreadySeen) {
  //       log(`   ⚠️ OLSMCC-${getCurrentDate()}.dat was already in the ledger before this run, so its ` +
  //           `refusal cannot be attributed to the name format - the ledger refuses any name it has ` +
  //           `seen, whatever the file contains. This case gets one clean run per day: the first one ` +
  //           `after generating. Read the refusal reason below before trusting it.`);
  //     }
  //     const nameCases = await verifyFileNameCases(duplicateNames[0], `TC${tcId}`);
  //     expect(nameCases.duplicateRejected,
  //       `The file named after an already imported file must be refused with BE051 ` +
  //       `("File '<name>' already exist"). Evidence: ${nameCases.duplicateEvidence || 'no .rej found'}`
  //     ).toBe(true);
  //     // TC_01_7: a name with no sequence number must be refused. The batch does not
  //     // always answer with a .rej, so an .err naming the file counts as well - what must
  //     // not happen is the file being read and accepted, or dropped in silence.
  //     expect(nameCases.malformedRejected,
  //       `The file named OLSMCC-${getCurrentDate()}.dat must be refused (TC_01_7). ` +
  //       `Nothing in the output directory mentions it: ${nameCases.malformedEvidence || 'no .rej and no .err'}`
  //     ).toBe(true);

  //     log(`\n📋 Step 9: Checking the database...`);
  //     const db = await verifyRejectedLinesWereNotStored(verification, recordFileNumber, `TC${tcId}`);
  //     expect(db.storedAnyway,
  //       `Lines the batch refused must not be in mcc - these cannot be stored at all ` +
  //       `(mcc.code is varchar(10) NOT NULL, mcc.mcc_scheme is varchar(10))`
  //     ).toEqual([]);
  //     expect(db.acceptedMissing,
  //       `Lines the batch accepted must be in mcc with status 'A'`
  //     ).toEqual([]);
  //     expect(db.checkedAccepted, `Accepted lines checked against the database`).toBe(5);

  //     verification.fileNameCases = nameCases;
  //     verification.database = db;

  //     await saveTestResults(`TC${tcId}`, verification, fileRange, duration);

  //     log(`\n📊 TC${tcId} Results:`);
  //     log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
  //     log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
  //     if (verification.partialPassFiles > 0) {
  //       log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
  //     }
  //     log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
  //     if (verification.errorFiles > 0) {
  //       log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
  //     }
  //     log(`   📝 Total Records: ${verification.totalRecords}`);
  //     log(`   ✅ |true|: ${verification.trueCount}`);
  //     log(`   ❌ |false|: ${verification.falseCount}`);

  //     log(`\n✅ TC${tcId} COMPLETED`);

  //   } catch (error) {
  //     log(`\n❌ TC${tcId} FAILED`, { error: error.message });
  //     throw error;
  //   }
  // });
  // });

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

//   // // // ============================================
//   // // // TC4B: Alternating Pattern (32)
//   // // // ============================================
//    test.describe('TC4B: Alternating Pattern (32)', () => {
  
//   test('TC4A: Alternating Pattern - 6 Valid 4 Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
//     const tcId = '4B';
//     log(`\n${'='.repeat(60)}`);
//     log(`🚀 STARTING TC${tcId} - All Valid`);
//     log(`${'='.repeat(60)}`);
  
//     const startTime = Date.now();
  
//     try {
//       await cleanLocalFolder(`TC${tcId}`);
  
//       log('\n📋 Step 1: Copying files to local...');
//       const copiedFiles = await copyFilesToLocal(tcId);
//       log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
//       log('\n📋 Step 2: Uploading files...');
//       const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
//       log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
//       log('\n📋 Step 3: Executing batch...');
//       const batchResult = await executeBatch(`TC${tcId}`);
//       log(`✅ Batch executed successfully`);
  
//       // STEP 4: SMART WAIT - Wait for ALL files to be generated
//       log('\n📋 Step 4: Waiting for output files to be generated...');
      
//       const expectedFiles = 1; // Number of files you're processing (42-51)
//       const maxWaitTime = 300000; // Maximum wait: 2 minutes
//       const checkInterval = 3000; // Check every 3 seconds
//       let verification = null;
//       let filesFound = 0;
//       const waitStartTime = Date.now();
  
//       while (Date.now() - waitStartTime < maxWaitTime) {
//           // Check current files
//           verification = await verifyResults(`TC${tcId}`, 'true', { start: 32, end: 32 });
//           filesFound = verification.totalFiles;
          
//           const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//           log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
//           if (filesFound === expectedFiles) {
//               log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
//               break;
//           }
          
//           // Wait before checking again
//           await new Promise(resolve => setTimeout(resolve, checkInterval));
//       }
  
//       // After waiting, show final status
//       const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//       if (filesFound < expectedFiles) {
//           log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
//           if (verification) {
//               log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
//               if (verification.rejOnlyFiles.length > 0) {
//                   log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
//               }
//           }
//       } else {
//           log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
//       }
  
//       // STEP 5: FINAL VERIFICATION (uses the last verification result)
//       log('\n📋 Step 5: Final verification...');
      
//       // If verification is null (shouldn't happen), run it one more time
//       if (!verification) {
//           verification = await verifyResults(`TC${tcId}`, 'true', { start: 32, end: 32 });
//       }
      
//       // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
//       const duration = Date.now() - startTime;
//       await saveTestResults(`TC${tcId}`, verification, { start: 32, end: 32}, duration);
      
//       log(`\n📊 TC${tcId} Results:`);
//       log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
//       log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
//       if (verification.partialPassFiles > 0) {
//         log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
//       }
//       if (verification.rejectedFiles > 0) {
//         log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
//       }
//       if (verification.errorFiles > 0) {
//         log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
//       }
//       log(`   📝 Total Records: ${verification.totalRecords}`);
//       log(`   ✅ |true|: ${verification.trueCount}`);
//       log(`   ❌ |false|: ${verification.falseCount}`);
  
//       log(`\n✅ TC${tcId} COMPLETED`);
  
//     } catch (error) {
//       log(`\n❌ TC${tcId} FAILED`, { error: error.message });
//       throw error;
//     }
//   });
//   });

//   // // // ============================================
//   // // // TC4C: Boundary + Invalid Combo (33)
//   // // // ============================================
//    test.describe('TC4C: Boundary + Invalid Combo', () => {
  
//   test('TC4C: Boundary + Invalid Combo - 4 Valid 4 Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
//     const tcId = '4C';
//     log(`\n${'='.repeat(60)}`);
//     log(`🚀 STARTING TC${tcId} - All Valid`);
//     log(`${'='.repeat(60)}`);
  
//     const startTime = Date.now();
  
//     try {
//       await cleanLocalFolder(`TC${tcId}`);
  
//       log('\n📋 Step 1: Copying files to local...');
//       const copiedFiles = await copyFilesToLocal(tcId);
//       log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
//       log('\n📋 Step 2: Uploading files...');
//       const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
//       log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
//       log('\n📋 Step 3: Executing batch...');
//       const batchResult = await executeBatch(`TC${tcId}`);
//       log(`✅ Batch executed successfully`);
  
//       // STEP 4: SMART WAIT - Wait for ALL files to be generated
//       log('\n📋 Step 4: Waiting for output files to be generated...');
      
//       const expectedFiles = 1; // Number of files you're processing (42-51)
//       const maxWaitTime = 300000; // Maximum wait: 2 minutes
//       const checkInterval = 3000; // Check every 3 seconds
//       let verification = null;
//       let filesFound = 0;
//       const waitStartTime = Date.now();
  
//       while (Date.now() - waitStartTime < maxWaitTime) {
//           // Check current files
//           verification = await verifyResults(`TC${tcId}`, 'true', { start: 33, end: 33 });
//           filesFound = verification.totalFiles;
          
//           const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//           log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
//           if (filesFound === expectedFiles) {
//               log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
//               break;
//           }
          
//           // Wait before checking again
//           await new Promise(resolve => setTimeout(resolve, checkInterval));
//       }
  
//       // After waiting, show final status
//       const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//       if (filesFound < expectedFiles) {
//           log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
//           if (verification) {
//               log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
//               if (verification.rejOnlyFiles.length > 0) {
//                   log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
//               }
//           }
//       } else {
//           log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
//       }
  
//       // STEP 5: FINAL VERIFICATION (uses the last verification result)
//       log('\n📋 Step 5: Final verification...');
      
//       // If verification is null (shouldn't happen), run it one more time
//       if (!verification) {
//           verification = await verifyResults(`TC${tcId}`, 'true', { start: 33, end: 33 });
//       }
      
//       // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
//       const duration = Date.now() - startTime;
//       await saveTestResults(`TC${tcId}`, verification, { start: 33, end: 33}, duration);
      
//       log(`\n📊 TC${tcId} Results:`);
//       log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
//       log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
//       if (verification.partialPassFiles > 0) {
//         log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
//       }
//       if (verification.rejectedFiles > 0) {
//         log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
//       }
//       if (verification.errorFiles > 0) {
//         log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
//       }
//       log(`   📝 Total Records: ${verification.totalRecords}`);
//       log(`   ✅ |true|: ${verification.trueCount}`);
//       log(`   ❌ |false|: ${verification.falseCount}`);
  
//       log(`\n✅ TC${tcId} COMPLETED`);
  
//     } catch (error) {
//       log(`\n❌ TC${tcId} FAILED`, { error: error.message });
//       throw error;
//     }
//   });
//   });

//   // // // ============================================
//   // // // TC4D: Business Rule Violations (34)
//   // // // ============================================
//   test.describe('TC4D: Business Rule Violations (34)', () => {
  
//   test('TC4D: Business Rule Violations - 3 Valid 8 Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
//     const tcId = '4D';
//     log(`\n${'='.repeat(60)}`);
//     log(`🚀 STARTING TC${tcId} - All Valid`);
//     log(`${'='.repeat(60)}`);
  
//     const startTime = Date.now();
  
//     try {
//       await cleanLocalFolder(`TC${tcId}`);
  
//       log('\n📋 Step 1: Copying files to local...');
//       const copiedFiles = await copyFilesToLocal(tcId);
//       log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
//       log('\n📋 Step 2: Uploading files...');
//       const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
//       log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
//       log('\n📋 Step 3: Executing batch...');
//       const batchResult = await executeBatch(`TC${tcId}`);
//       log(`✅ Batch executed successfully`);
  
//       // STEP 4: SMART WAIT - Wait for ALL files to be generated
//       log('\n📋 Step 4: Waiting for output files to be generated...');
      
//       const expectedFiles = 1; // Number of files you're processing (42-51)
//       const maxWaitTime = 300000; // Maximum wait: 2 minutes
//       const checkInterval = 3000; // Check every 3 seconds
//       let verification = null;
//       let filesFound = 0;
//       const waitStartTime = Date.now();
  
//       while (Date.now() - waitStartTime < maxWaitTime) {
//           // Check current files
//           verification = await verifyResults(`TC${tcId}`, 'true', { start: 34, end: 34 });
//           filesFound = verification.totalFiles;
          
//           const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//           log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
//           if (filesFound === expectedFiles) {
//               log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
//               break;
//           }
          
//           // Wait before checking again
//           await new Promise(resolve => setTimeout(resolve, checkInterval));
//       }
  
//       // After waiting, show final status
//       const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//       if (filesFound < expectedFiles) {
//           log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
//           if (verification) {
//               log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
//               if (verification.rejOnlyFiles.length > 0) {
//                   log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
//               }
//           }
//       } else {
//           log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
//       }
  
//       // STEP 5: FINAL VERIFICATION (uses the last verification result)
//       log('\n📋 Step 5: Final verification...');
      
//       // If verification is null (shouldn't happen), run it one more time
//       if (!verification) {
//           verification = await verifyResults(`TC${tcId}`, 'true', { start: 34, end: 34 });
//       }
      
//       // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
//       const duration = Date.now() - startTime;
//       await saveTestResults(`TC${tcId}`, verification, { start: 34, end: 34}, duration);
      
//       log(`\n📊 TC${tcId} Results:`);
//       log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
//       log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
//       if (verification.partialPassFiles > 0) {
//         log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
//       }
//       if (verification.rejectedFiles > 0) {
//         log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
//       }
//       if (verification.errorFiles > 0) {
//         log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
//       }
//       log(`   📝 Total Records: ${verification.totalRecords}`);
//       log(`   ✅ |true|: ${verification.trueCount}`);
//       log(`   ❌ |false|: ${verification.falseCount}`);
  
//       log(`\n✅ TC${tcId} COMPLETED`);
  
//     } catch (error) {
//       log(`\n❌ TC${tcId} FAILED`, { error: error.message });
//       throw error;
//     }
//   });
//   });

  
//   // // // ============================================
//   // // // TC6A: Recovery (35)
//   // // // ============================================
//  test.describe('TC6A: Recovery (35))', () => {
  
//   test('TC6A: Recovery - 5 Valid 3 Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
//     const tcId = '6A';
//     log(`\n${'='.repeat(60)}`);
//     log(`🚀 STARTING TC${tcId} - All Valid`);
//     log(`${'='.repeat(60)}`);
  
//     const startTime = Date.now();
  
//     try {
//       await cleanLocalFolder(`TC${tcId}`);
  
//       log('\n📋 Step 1: Copying files to local...');
//       const copiedFiles = await copyFilesToLocal(tcId);
//       log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
//       log('\n📋 Step 2: Uploading files...');
//       const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
//       log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
//       log('\n📋 Step 3: Executing batch...');
//       const batchResult = await executeBatch(`TC${tcId}`);
//       log(`✅ Batch executed successfully`);
  
//       // STEP 4: SMART WAIT - Wait for ALL files to be generated
//       log('\n📋 Step 4: Waiting for output files to be generated...');
      
//       const expectedFiles = 1; // Number of files you're processing (42-51)
//       const maxWaitTime = 300000; // Maximum wait: 2 minutes
//       const checkInterval = 3000; // Check every 3 seconds
//       let verification = null;
//       let filesFound = 0;
//       const waitStartTime = Date.now();
  
//       while (Date.now() - waitStartTime < maxWaitTime) {
//           // Check current files
//           verification = await verifyResults(`TC${tcId}`, 'true', { start: 35, end: 35 });
//           filesFound = verification.totalFiles;
          
//           const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//           log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
//           if (filesFound === expectedFiles) {
//               log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
//               break;
//           }
          
//           // Wait before checking again
//           await new Promise(resolve => setTimeout(resolve, checkInterval));
//       }
  
//       // After waiting, show final status
//       const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//       if (filesFound < expectedFiles) {
//           log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
//           if (verification) {
//               log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
//               if (verification.rejOnlyFiles.length > 0) {
//                   log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
//               }
//           }
//       } else {
//           log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
//       }
  
//       // STEP 5: FINAL VERIFICATION (uses the last verification result)
//       log('\n📋 Step 5: Final verification...');
      
//       // If verification is null (shouldn't happen), run it one more time
//       if (!verification) {
//           verification = await verifyResults(`TC${tcId}`, 'true', { start: 35, end: 35 });
//       }
      
//       // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
//       const duration = Date.now() - startTime;
//       await saveTestResults(`TC${tcId}`, verification, { start: 35, end: 35}, duration);
      
//       log(`\n📊 TC${tcId} Results:`);
//       log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
//       log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
//       if (verification.partialPassFiles > 0) {
//         log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
//       }
//       if (verification.rejectedFiles > 0) {
//         log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
//       }
//       if (verification.errorFiles > 0) {
//         log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
//       }
//       log(`   📝 Total Records: ${verification.totalRecords}`);
//       log(`   ✅ |true|: ${verification.trueCount}`);
//       log(`   ❌ |false|: ${verification.falseCount}`);
  
//       log(`\n✅ TC${tcId} COMPLETED`);
  
//     } catch (error) {
//       log(`\n❌ TC${tcId} FAILED`, { error: error.message });
//       throw error;
//     }
//   });
//   });

// // // ============================================
// // TC7A: Invalid Flags (36)
// // ============================================
// test.describe('TC7A: Invalid Flags (36) )', () => {
  
//   test('TC7A: Invalid Flags - 5 Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
//     const tcId = '7A';
//     log(`\n${'='.repeat(60)}`);
//     log(`🚀 STARTING TC${tcId} - All Valid`);
//     log(`${'='.repeat(60)}`);
  
//     const startTime = Date.now();
  
//     try {
//       await cleanLocalFolder(`TC${tcId}`);
  
//       log('\n📋 Step 1: Copying files to local...');
//       const copiedFiles = await copyFilesToLocal(tcId);
//       log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
//       log('\n📋 Step 2: Uploading files...');
//       const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
//       log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
//       log('\n📋 Step 3: Executing batch...');
//       const batchResult = await executeBatch(`TC${tcId}`);
//       log(`✅ Batch executed successfully`);
  
//       // STEP 4: SMART WAIT - Wait for ALL files to be generated
//       log('\n📋 Step 4: Waiting for output files to be generated...');
      
//       const expectedFiles = 1; // Number of files you're processing (42-51)
//       const maxWaitTime = 300000; // Maximum wait: 2 minutes
//       const checkInterval = 3000; // Check every 3 seconds
//       let verification = null;
//       let filesFound = 0;
//       const waitStartTime = Date.now();
  
//       while (Date.now() - waitStartTime < maxWaitTime) {
//           // Check current files
//           verification = await verifyResults(`TC${tcId}`, 'true', { start: 36, end: 36 });
//           filesFound = verification.totalFiles;
          
//           const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//           log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
//           if (filesFound === expectedFiles) {
//               log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
//               break;
//           }
          
//           // Wait before checking again
//           await new Promise(resolve => setTimeout(resolve, checkInterval));
//       }
  
//       // After waiting, show final status
//       const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//       if (filesFound < expectedFiles) {
//           log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
//           if (verification) {
//               log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
//               if (verification.rejOnlyFiles.length > 0) {
//                   log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
//               }
//           }
//       } else {
//           log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
//       }
  
//       // STEP 5: FINAL VERIFICATION (uses the last verification result)
//       log('\n📋 Step 5: Final verification...');
      
//       // If verification is null (shouldn't happen), run it one more time
//       if (!verification) {
//           verification = await verifyResults(`TC${tcId}`, 'true', { start: 36, end: 36 });
//       }
      
//       // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
//       const duration = Date.now() - startTime;
//       await saveTestResults(`TC${tcId}`, verification, { start: 36, end: 36}, duration);
      
//       log(`\n📊 TC${tcId} Results:`);
//       log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
//       log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
//       if (verification.partialPassFiles > 0) {
//         log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
//       }
//       if (verification.rejectedFiles > 0) {
//         log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
//       }
//       if (verification.errorFiles > 0) {
//         log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
//       }
//       log(`   📝 Total Records: ${verification.totalRecords}`);
//       log(`   ✅ |true|: ${verification.trueCount}`);
//       log(`   ❌ |false|: ${verification.falseCount}`);
  
//       log(`\n✅ TC${tcId} COMPLETED`);
  
//     } catch (error) {
//       log(`\n❌ TC${tcId} FAILED`, { error: error.message });
//       throw error;
//     }
//   });
//   });


//   // // ============================================
//   // // TC7B: Invalid Statuses (37)
//   // // ============================================
//   test.describe('TC7B: Invalid Statuses (37) )', () => {
  
//   test('TC7B: Invalid Statuses - 2 Valid 3 Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
//     const tcId = '7B';
//     log(`\n${'='.repeat(60)}`);
//     log(`🚀 STARTING TC${tcId} - All Valid`);
//     log(`${'='.repeat(60)}`);
  
//     const startTime = Date.now();
  
//     try {
//       await cleanLocalFolder(`TC${tcId}`);
  
//       log('\n📋 Step 1: Copying files to local...');
//       const copiedFiles = await copyFilesToLocal(tcId);
//       log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
//       log('\n📋 Step 2: Uploading files...');
//       const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
//       log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
//       log('\n📋 Step 3: Executing batch...');
//       const batchResult = await executeBatch(`TC${tcId}`);
//       log(`✅ Batch executed successfully`);
  
//       // STEP 4: SMART WAIT - Wait for ALL files to be generated
//       log('\n📋 Step 4: Waiting for output files to be generated...');
      
//       const expectedFiles = 1; // Number of files you're processing (42-51)
//       const maxWaitTime = 300000; // Maximum wait: 2 minutes
//       const checkInterval = 3000; // Check every 3 seconds
//       let verification = null;
//       let filesFound = 0;
//       const waitStartTime = Date.now();
  
//       while (Date.now() - waitStartTime < maxWaitTime) {
//           // Check current files
//           verification = await verifyResults(`TC${tcId}`, 'true', { start: 37, end: 37 });
//           filesFound = verification.totalFiles;
          
//           const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//           log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
//           if (filesFound === expectedFiles) {
//               log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
//               break;
//           }
          
//           // Wait before checking again
//           await new Promise(resolve => setTimeout(resolve, checkInterval));
//       }
  
//       // After waiting, show final status
//       const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//       if (filesFound < expectedFiles) {
//           log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
//           if (verification) {
//               log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
//               if (verification.rejOnlyFiles.length > 0) {
//                   log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
//               }
//           }
//       } else {
//           log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
//       }
  
//       // STEP 5: FINAL VERIFICATION (uses the last verification result)
//       log('\n📋 Step 5: Final verification...');
      
//       // If verification is null (shouldn't happen), run it one more time
//       if (!verification) {
//           verification = await verifyResults(`TC${tcId}`, 'true', { start: 37, end: 37 });
//       }
      
//       // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
//       const duration = Date.now() - startTime;
//       await saveTestResults(`TC${tcId}`, verification, { start: 37, end: 37}, duration);
      
//       log(`\n📊 TC${tcId} Results:`);
//       log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
//       log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
//       if (verification.partialPassFiles > 0) {
//         log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
//       }
//       if (verification.rejectedFiles > 0) {
//         log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
//       }
//       if (verification.errorFiles > 0) {
//         log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
//       }
//       log(`   📝 Total Records: ${verification.totalRecords}`);
//       log(`   ✅ |true|: ${verification.trueCount}`);
//       log(`   ❌ |false|: ${verification.falseCount}`);
  
//       log(`\n✅ TC${tcId} COMPLETED`);
  
//     } catch (error) {
//       log(`\n❌ TC${tcId} FAILED`, { error: error.message });
//       throw error;
//     }
//   });
//   });

//   // // ============================================
//   // // TC7C: Length Validation (38)
//   // // ============================================
//   test.describe('TC7C: Length Validation (38) )', () => {
  
//   test('TC7C: Length Validation - 2 Valid 6 Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
//     const tcId = '7C';
//     log(`\n${'='.repeat(60)}`);
//     log(`🚀 STARTING TC${tcId} - All Valid`);
//     log(`${'='.repeat(60)}`);
  
//     const startTime = Date.now();
  
//     try {
//       await cleanLocalFolder(`TC${tcId}`);
  
//       log('\n📋 Step 1: Copying files to local...');
//       const copiedFiles = await copyFilesToLocal(tcId);
//       log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
//       log('\n📋 Step 2: Uploading files...');
//       const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
//       log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
//       log('\n📋 Step 3: Executing batch...');
//       const batchResult = await executeBatch(`TC${tcId}`);
//       log(`✅ Batch executed successfully`);
  
//       // STEP 4: SMART WAIT - Wait for ALL files to be generated
//       log('\n📋 Step 4: Waiting for output files to be generated...');
      
//       const expectedFiles = 1; // Number of files you're processing (42-51)
//       const maxWaitTime = 300000; // Maximum wait: 2 minutes
//       const checkInterval = 3000; // Check every 3 seconds
//       let verification = null;
//       let filesFound = 0;
//       const waitStartTime = Date.now();
  
//       while (Date.now() - waitStartTime < maxWaitTime) {
//           // Check current files
//           verification = await verifyResults(`TC${tcId}`, 'true', { start: 38, end: 38 });
//           filesFound = verification.totalFiles;
          
//           const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//           log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
//           if (filesFound === expectedFiles) {
//               log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
//               break;
//           }
          
//           // Wait before checking again
//           await new Promise(resolve => setTimeout(resolve, checkInterval));
//       }
  
//       // After waiting, show final status
//       const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//       if (filesFound < expectedFiles) {
//           log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
//           if (verification) {
//               log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
//               if (verification.rejOnlyFiles.length > 0) {
//                   log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
//               }
//           }
//       } else {
//           log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
//       }
  
//       // STEP 5: FINAL VERIFICATION (uses the last verification result)
//       log('\n📋 Step 5: Final verification...');
      
//       // If verification is null (shouldn't happen), run it one more time
//       if (!verification) {
//           verification = await verifyResults(`TC${tcId}`, 'true', { start: 38, end: 38 });
//       }
      
//       // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
//       const duration = Date.now() - startTime;
//       await saveTestResults(`TC${tcId}`, verification, { start: 38, end: 38}, duration);
      
//       log(`\n📊 TC${tcId} Results:`);
//       log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
//       log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
//       if (verification.partialPassFiles > 0) {
//         log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
//       }
//       if (verification.rejectedFiles > 0) {
//         log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
//       }
//       if (verification.errorFiles > 0) {
//         log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
//       }
//       log(`   📝 Total Records: ${verification.totalRecords}`);
//       log(`   ✅ |true|: ${verification.trueCount}`);
//       log(`   ❌ |false|: ${verification.falseCount}`);
  
//       log(`\n✅ TC${tcId} COMPLETED`);
  
//     } catch (error) {
//       log(`\n❌ TC${tcId} FAILED`, { error: error.message });
//       throw error;
//     }
//   });
//   });

//   // // ============================================
//   // // TC8A: Sequential Operations (39)
//   // // ============================================
//  test.describe('TC8A: Sequential Operations (39) )', () => {
  
//   test('TC8A: Sequential Operations - 3 Valid 5 Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
//     const tcId = '8A';
//     log(`\n${'='.repeat(60)}`);
//     log(`🚀 STARTING TC${tcId} - All Valid`);
//     log(`${'='.repeat(60)}`);
  
//     const startTime = Date.now();
  
//     try {
//       await cleanLocalFolder(`TC${tcId}`);
  
//       log('\n📋 Step 1: Copying files to local...');
//       const copiedFiles = await copyFilesToLocal(tcId);
//       log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
//       log('\n📋 Step 2: Uploading files...');
//       const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
//       log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
//       log('\n📋 Step 3: Executing batch...');
//       const batchResult = await executeBatch(`TC${tcId}`);
//       log(`✅ Batch executed successfully`);
  
//       // STEP 4: SMART WAIT - Wait for ALL files to be generated
//       log('\n📋 Step 4: Waiting for output files to be generated...');
      
//       const expectedFiles = 1; // Number of files you're processing (42-51)
//       const maxWaitTime = 300000; // Maximum wait: 2 minutes
//       const checkInterval = 3000; // Check every 3 seconds
//       let verification = null;
//       let filesFound = 0;
//       const waitStartTime = Date.now();
  
//       while (Date.now() - waitStartTime < maxWaitTime) {
//           // Check current files
//           verification = await verifyResults(`TC${tcId}`, 'true', { start: 39, end: 39 });
//           filesFound = verification.totalFiles;
          
//           const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//           log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
//           if (filesFound === expectedFiles) {
//               log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
//               break;
//           }
          
//           // Wait before checking again
//           await new Promise(resolve => setTimeout(resolve, checkInterval));
//       }
  
//       // After waiting, show final status
//       const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//       if (filesFound < expectedFiles) {
//           log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
//           if (verification) {
//               log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
//               if (verification.rejOnlyFiles.length > 0) {
//                   log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
//               }
//           }
//       } else {
//           log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
//       }
  
//       // STEP 5: FINAL VERIFICATION (uses the last verification result)
//       log('\n📋 Step 5: Final verification...');
      
//       // If verification is null (shouldn't happen), run it one more time
//       if (!verification) {
//           verification = await verifyResults(`TC${tcId}`, 'true', { start: 39, end: 39 });
//       }
      
//       // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
//       const duration = Date.now() - startTime;
//       await saveTestResults(`TC${tcId}`, verification, { start: 39, end: 39}, duration);
      
//       log(`\n📊 TC${tcId} Results:`);
//       log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
//       log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
//       if (verification.partialPassFiles > 0) {
//         log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
//       }
//       if (verification.rejectedFiles > 0) {
//         log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
//       }
//       if (verification.errorFiles > 0) {
//         log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
//       }
//       log(`   📝 Total Records: ${verification.totalRecords}`);
//       log(`   ✅ |true|: ${verification.trueCount}`);
//       log(`   ❌ |false|: ${verification.falseCount}`);
  
//       log(`\n✅ TC${tcId} COMPLETED`);
  
//     } catch (error) {
//       log(`\n❌ TC${tcId} FAILED`, { error: error.message });
//       throw error;
//     }
//   });
//   });

//   // // ============================================
//   // // TC8B: Duplicate Records (40)
//   // // ============================================
//    test.describe('TC8B: Duplicate Records (40) )', () => {
  
//   test('TC8B: Duplicate Records - 4 Valid 4 Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
//     const tcId = '8B';
//     log(`\n${'='.repeat(60)}`);
//     log(`🚀 STARTING TC${tcId} - All Valid`);
//     log(`${'='.repeat(60)}`);
  
//     const startTime = Date.now();
  
//     try {
//       await cleanLocalFolder(`TC${tcId}`);
  
//       log('\n📋 Step 1: Copying files to local...');
//       const copiedFiles = await copyFilesToLocal(tcId);
//       log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
//       log('\n📋 Step 2: Uploading files...');
//       const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
//       log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
//       log('\n📋 Step 3: Executing batch...');
//       const batchResult = await executeBatch(`TC${tcId}`);
//       log(`✅ Batch executed successfully`);
  
//       // STEP 4: SMART WAIT - Wait for ALL files to be generated
//       log('\n📋 Step 4: Waiting for output files to be generated...');
      
//       const expectedFiles = 1; // Number of files you're processing (42-51)
//       const maxWaitTime = 300000; // Maximum wait: 2 minutes
//       const checkInterval = 3000; // Check every 3 seconds
//       let verification = null;
//       let filesFound = 0;
//       const waitStartTime = Date.now();
  
//       while (Date.now() - waitStartTime < maxWaitTime) {
//           // Check current files
//           verification = await verifyResults(`TC${tcId}`, 'true', { start: 40, end: 40 });
//           filesFound = verification.totalFiles;
          
//           const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//           log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
//           if (filesFound === expectedFiles) {
//               log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
//               break;
//           }
          
//           // Wait before checking again
//           await new Promise(resolve => setTimeout(resolve, checkInterval));
//       }
  
//       // After waiting, show final status
//       const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//       if (filesFound < expectedFiles) {
//           log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
//           if (verification) {
//               log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
//               if (verification.rejOnlyFiles.length > 0) {
//                   log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
//               }
//           }
//       } else {
//           log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
//       }
  
//       // STEP 5: FINAL VERIFICATION (uses the last verification result)
//       log('\n📋 Step 5: Final verification...');
      
//       // If verification is null (shouldn't happen), run it one more time
//       if (!verification) {
//           verification = await verifyResults(`TC${tcId}`, 'true', { start: 40, end: 40 });
//       }
      
//       // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
//       const duration = Date.now() - startTime;
//       await saveTestResults(`TC${tcId}`, verification, { start: 40, end: 40}, duration);
      
//       log(`\n📊 TC${tcId} Results:`);
//       log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
//       log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
//       if (verification.partialPassFiles > 0) {
//         log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
//       }
//       if (verification.rejectedFiles > 0) {
//         log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
//       }
//       if (verification.errorFiles > 0) {
//         log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
//       }
//       log(`   📝 Total Records: ${verification.totalRecords}`);
//       log(`   ✅ |true|: ${verification.trueCount}`);
//       log(`   ❌ |false|: ${verification.falseCount}`);
  
//       log(`\n✅ TC${tcId} COMPLETED`);
  
//     } catch (error) {
//       log(`\n❌ TC${tcId} FAILED`, { error: error.message });
//       throw error;
//     }
//   });
//   });

//   // // ============================================
//   // // TC9A: Future Dates (41)
//   // // ============================================
//   test.describe('TC9A: Future Dates (41) )', () => {
  
//   test('TC9A: Future Dates - All Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
//     const tcId = '9A';
//     log(`\n${'='.repeat(60)}`);
//     log(`🚀 STARTING TC${tcId} - All Invalid`);
//     log(`${'='.repeat(60)}`);
  
//     const startTime = Date.now();
  
//     try {
//       await cleanLocalFolder(`TC${tcId}`);
  
//       log('\n📋 Step 1: Copying files to local...');
//       const copiedFiles = await copyFilesToLocal(tcId);
//       log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
//       log('\n📋 Step 2: Uploading files...');
//       const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
//       log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
//       log('\n📋 Step 3: Executing batch...');
//       const batchResult = await executeBatch(`TC${tcId}`);
//       log(`✅ Batch executed successfully`);
  
//       // STEP 4: SMART WAIT - Wait for ALL files to be generated
//       log('\n📋 Step 4: Waiting for output files to be generated...');
      
//       const expectedFiles = 1; // Number of files you're processing (42-51)
//       const maxWaitTime = 300000; // Maximum wait: 2 minutes
//       const checkInterval = 3000; // Check every 3 seconds
//       let verification = null;
//       let filesFound = 0;
//       const waitStartTime = Date.now();
  
//       while (Date.now() - waitStartTime < maxWaitTime) {
//           // Check current files
//           verification = await verifyResults2(`TC${tcId}`, 'true', { start: 41, end: 41 });
//           filesFound = verification.totalFiles;
          
//           const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//           log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
//           if (filesFound === expectedFiles) {
//               log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
//               break;
//           }
          
//           // Wait before checking again
//           await new Promise(resolve => setTimeout(resolve, checkInterval));
//       }
  
//       // After waiting, show final status
//       const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//       if (filesFound < expectedFiles) {
//           log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
//           if (verification) {
//               log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
//               if (verification.rejOnlyFiles.length > 0) {
//                   log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
//               }
//           }
//       } else {
//           log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
//       }
  
//       // STEP 5: FINAL VERIFICATION (uses the last verification result)
//       log('\n📋 Step 5: Final verification...');
      
//       // If verification is null (shouldn't happen), run it one more time
//       if (!verification) {
//           verification = await verifyResults2(`TC${tcId}`, 'true', { start: 41, end: 41 });
//       }
      
//       // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
//       const duration = Date.now() - startTime;
//       await saveTestResults(`TC${tcId}`, verification, { start: 41, end: 41}, duration);
      
//       log(`\n📊 TC${tcId} Results:`);
//       log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
//       log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
//       if (verification.partialPassFiles > 0) {
//         log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
//       }
//       if (verification.rejectedFiles > 0) {
//         log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
//       }
//       if (verification.errorFiles > 0) {
//         log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
//       }
//       log(`   📝 Total Records: ${verification.totalRecords}`);
//       log(`   ✅ |true|: ${verification.trueCount}`);
//       log(`   ❌ |false|: ${verification.falseCount}`);
  
//       log(`\n✅ TC${tcId} COMPLETED`);
  
//     } catch (error) {
//       log(`\n❌ TC${tcId} FAILED`, { error: error.message });
//       throw error;
//     }
//   });
//   });


//   // // ============================================
//   // // TC9B: Past Dates (42)
//   // // ============================================
//   test.describe('TC9B: Past Dates (42) )', () => {
  
//   test('TC9B: Past Date - All Invalid)', { tag: ['@critical', '@smoke'] }, async () => {
//     const tcId = '9B';
//     log(`\n${'='.repeat(60)}`);
//     log(`🚀 STARTING TC${tcId} - All Invalid`);
//     log(`${'='.repeat(60)}`);
  
//     const startTime = Date.now();
  
//     try {
//       await cleanLocalFolder(`TC${tcId}`);
  
//       log('\n📋 Step 1: Copying files to local...');
//       const copiedFiles = await copyFilesToLocal(tcId);
//       log(`📊 Copied ${copiedFiles.length} files: ${copiedFiles.join(', ')}`);
  
//       log('\n📋 Step 2: Uploading files...');
//       const uploadResults = await uploadFiles(copiedFiles, `TC${tcId}`);
//       log(`📊 Uploaded ${uploadResults.filter(r => r.success).length} files successfully`);
  
//       log('\n📋 Step 3: Executing batch...');
//       const batchResult = await executeBatch(`TC${tcId}`);
//       log(`✅ Batch executed successfully`);
  
//       // STEP 4: SMART WAIT - Wait for ALL files to be generated
//       log('\n📋 Step 4: Waiting for output files to be generated...');
      
//       const expectedFiles = 1; // Number of files you're processing (42-51)
//       const maxWaitTime = 300000; // Maximum wait: 2 minutes
//       const checkInterval = 3000; // Check every 3 seconds
//       let verification = null;
//       let filesFound = 0;
//       const waitStartTime = Date.now();
  
//       while (Date.now() - waitStartTime < maxWaitTime) {
//           // Check current files
//          verification = await verifyResults2(`TC${tcId}`, 'true', { start: 42, end: 42 });
//           filesFound = verification.totalFiles;
          
//           const elapsed = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//           log(`⏳ [${elapsed}s] Found ${filesFound}/${expectedFiles} files`);
          
//           if (filesFound === expectedFiles) {
//               log(`✅ All ${expectedFiles} files generated after ${elapsed} seconds`);
//               break;
//           }
          
//           // Wait before checking again
//           await new Promise(resolve => setTimeout(resolve, checkInterval));
//       }
  
//       // After waiting, show final status
//       const totalWaitTime = ((Date.now() - waitStartTime) / 1000).toFixed(1);
//       if (filesFound < expectedFiles) {
//           log(`⚠️ Only ${filesFound}/${expectedFiles} files found after ${totalWaitTime} seconds (timeout)`);
//           if (verification) {
//               log(`📁 Files found: ${verification.outOnlyFiles.join(', ')}`);
//               if (verification.rejOnlyFiles.length > 0) {
//                   log(`📁 Rejected files: ${verification.rejOnlyFiles.join(', ')}`);
//               }
//           }
//       } else {
//           log(`✅ All files generated successfully in ${totalWaitTime} seconds`);
//       }
  
//       // STEP 5: FINAL VERIFICATION (uses the last verification result)
//       log('\n📋 Step 5: Final verification...');
      
//       // If verification is null (shouldn't happen), run it one more time
//       if (!verification) {
//          verification = await verifyResults2(`TC${tcId}`, 'true', { start: 42, end: 42 });
//       }
      
//       // SAVE RESULTS TO JSON FILE FOR DASHBOARD
   
//       const duration = Date.now() - startTime;
//       await saveTestResults(`TC${tcId}`, verification, { start: 42, end: 42}, duration);
      
//       log(`\n📊 TC${tcId} Results:`);
//       log(`   📁 Total Files Found: ${verification.totalFiles}/${expectedFiles}`);
//       log(`   ✅ Fully Passed: ${verification.passedFiles} files (${verification.outOnlyFiles.join(', ')})`);
//       if (verification.partialPassFiles > 0) {
//         log(`   ⚠️  Partial Pass: ${verification.partialPassFiles} files (${verification.outAndRejFiles.join(', ')})`);
//       }
//       if (verification.rejectedFiles > 0) {
//         log(`   ❌ Fully Rejected: ${verification.rejectedFiles} files (${verification.rejOnlyFiles.join(', ')})`);
//       }
//       if (verification.errorFiles > 0) {
//         log(`   🔴 System Error: ${verification.errorFiles} files (${verification.errOnlyFiles.join(', ')})`);
//       }
//       log(`   📝 Total Records: ${verification.totalRecords}`);
//       log(`   ✅ |true|: ${verification.trueCount}`);
//       log(`   ❌ |false|: ${verification.falseCount}`);
  
//       log(`\n✅ TC${tcId} COMPLETED`);
  
//     } catch (error) {
//       log(`\n❌ TC${tcId} FAILED`, { error: error.message });
//       throw error;
//     }
//   });
//   });



}); // End of test suite