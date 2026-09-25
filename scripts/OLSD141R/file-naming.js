// scripts/OLSD141R/file-naming.js
// Naming rules for the two generated input files and the report file of OLSD141R:
//   OLSCUST-YYYYMMDD-NN.dat   input of OLSDB012 (creates the CIFs)
//   OLSMECIF-YYYYMMDD-NN.dat  input of OLSDB057 (CIF merge instructions)
//   MYOLSD141R<batch date>.txt report of OLSDR141

import path from 'path';
import { CONFIG } from './test-data.js';

// ============ REPORT FILE ============

/** MYOLSD141R20260922.txt */
export function reportFileName(batchDateYmd) {
  return `${CONFIG.report.prefix}${batchDateYmd}${CONFIG.report.extension}`;
}

/**
 * Any file of the report folder carrying the report ID.
 * On dev OLSDR141 writes 'OLSD141R_01' (no country code, no date, no extension), while the older
 * reports (OLSD133R/OLSD134R) write '<env><reportId><batchdate>.txt' - the glob covers both.
 */
export function reportFileGlob(batchDateYmd) {
  void batchDateYmd;
  return `*${CONFIG.report.reportId}*`;
}

/** reports\OLSD141R\<file downloaded from the server> */
export function reportLocalPathForName(fileName) {
  return path.join(CONFIG.report.localDir, fileName);
}

/** /apps/MY-dev/OE/cls/USER_OUTPUT/OLSD141R/MYOLSD141R20260922.txt */
export function reportRemotePath(batchDateYmd) {
  return `${CONFIG.report.remoteDir}/${reportFileName(batchDateYmd)}`;
}

/**
 * Parse the report file name. Two layouts exist on dev:
 *   OLSD141R_01                OLSDR141 output (verified on dev 25/09/2026)
 *   MYOLSD134R20260922.txt     other reports: <env><reportId><batchdate>.txt
 * @returns {{name: string, envCode: string|null, batchDate: string|null, sequence: number|null}|null}
 */
export function parseReportFileName(fileName) {
  const name = String(fileName).trim();
  const id = CONFIG.report.reportId;

  const withDate = name.match(new RegExp(`^([A-Za-z]{0,4})${id}(\\d{8})(?:_\\d{8})?\\${CONFIG.report.extension}$`));
  if (withDate) return { name, envCode: withDate[1] || null, batchDate: withDate[2], sequence: null };

  const plain = name.match(new RegExp(`^${id}(?:_(\\d{2}))?$`));
  return plain
    ? { name, envCode: null, batchDate: null, sequence: plain[1] ? Number(plain[1]) : null }
    : null;
}

// ============ INPUT FILES ============

/** Use the naming convention of the batch: <FILE_ID>-YYYYMMDD-NN.dat */
function inputFileName(fileId, batchDateYmd, sequenceNo, extension = '.dat') {
  return `${fileId}-${batchDateYmd}-${String(sequenceNo).padStart(2, '0')}${extension}`;
}

/** OLSCUST-20260924-01.dat (input of OLSDB012) */
export function custFileName(batchDateYmd, sequenceNo) {
  return inputFileName(CONFIG.seedCust.fileId, batchDateYmd, sequenceNo);
}

/** OLSMECIF-20260924-01.dat (input of OLSDB057) */
export function mergeFileName(batchDateYmd, sequenceNo) {
  return inputFileName(CONFIG.seedMerge.fileId, batchDateYmd, sequenceNo);
}

/** Local staging path (C:\BATCH-OCBC-PW1\src\). */
export function stagingPath(fileName) {
  return path.join(CONFIG.winscp.localPath, fileName);
}
