// scripts/OLSD133R/file-naming.js
// File naming convention for batch OLSD133R (same role as file-naming.js in OLSDB024,
// but OLSDB024 names the input .dat file, while here it names the REPORT file generated
// by the batch because this batch does not have an input file).
//
// Actual filename on dev (verified from file MYOLSD133R20260922.txt):
//   MYOLSD133R<batch date YYYYMMDD>.txt
// In which:
//   - 'MY' is the environment prefix (MY-dev)
//   - 'OLSD133R' is the report ID
//   - <batch date> is the batch date in table batch_date.batch_date,
//     and it is also the value reported on the line 'Report Date: ddmmyyyy'
//
// The OLSDB009 input filename (used in the data-seeding step) is NOT defined here: it belongs
// to the convention in scripts/OLSDB009/file-generator.js and is reused as-is.

import path from 'path';
import { CONFIG } from './test-data.js';

/** MYOLSD133R20260922.txt */
export function reportFileName(batchDateYmd) {
  return `${CONFIG.report.prefix}${batchDateYmd}${CONFIG.report.extension}`;
}

/** /apps/MY-dev/OE/cls/USER_OUTPUT/OLSD133R/MYOLSD133R20260922.txt */
export function reportRemotePath(batchDateYmd) {
  return `${CONFIG.report.remoteDir}/${reportFileName(batchDateYmd)}`;
}

/** reports\OLSD133R\MYOLSD133R20260922.txt (tren may) */
export function reportLocalPath(batchDateYmd) {
  return path.join(CONFIG.report.localDir, reportFileName(batchDateYmd));
}

/**
 * Parse the report filename back to the batch date YYYYMMDD.
 * Useful when looking for the newest report in a folder without knowing the batch date.
 * @returns {{batchDate: string}|null}
 */
export function parseReportFileName(fileName) {
  const pattern = new RegExp(
    `^${CONFIG.report.prefix}(\\d{8})\\${CONFIG.report.extension}$`
  );
  const m = String(fileName).trim().match(pattern);
  return m ? { batchDate: m[1] } : null;
}

/** File path in the local staging folder (C:\BATCH-OCBC-PW1\src\) */
export function stagingPath(fileName) {
  return path.join(CONFIG.winscp.localPath, fileName);
}
