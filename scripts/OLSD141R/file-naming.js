// scripts/OLSD141R/file-naming.js
// Naming rules for the OLSD141R report file (this batch has no input file of its own):
//   MYOLSD141R<batch date YYYYMMDD>.txt
//   - MY       : environment prefix, may differ per region (MY / ID), so the file is always
//                located through reportFileGlob() instead of a fixed prefix
//   - OLSD141R : report ID (EOD Batch flow v1.10 row 81: batch = OLSDR141)
// The OLSMECIF seed file (batch OLSDB057) uses its own convention: OLSMECIF-YYYYMMDD-NN.dat.

import path from 'path';
import { CONFIG } from './test-data.js';

// ============ REPORT FILE ============

/** MYOLSD141R20260922.txt */
export function reportFileName(batchDateYmd) {
  return `${CONFIG.report.prefix}${batchDateYmd}${CONFIG.report.extension}`;
}

/** Region independent pattern: *OLSD141R20260922*.txt */
export function reportFileGlob(batchDateYmd) {
  return `*${CONFIG.report.reportId}${batchDateYmd}*.txt`;
}

/** reports\OLSD141R\<file downloaded from the server> */
export function reportLocalPathForName(fileName) {
  return path.join(CONFIG.report.localDir, fileName);
}

/** /apps/MY-dev/OE/cls/USER_OUTPUT/OLSD141R/MYOLSD141R20260922.txt */
export function reportRemotePath(batchDateYmd) {
  return `${CONFIG.report.remoteDir}/${reportFileName(batchDateYmd)}`;
}

/** reports\OLSD141R\MYOLSD141R20260922.txt */
export function reportLocalPath(batchDateYmd) {
  return path.join(CONFIG.report.localDir, reportFileName(batchDateYmd));
}

/**
 * Parse the report file name back to its batch date.
 * @returns {{envCode: string|null, batchDate: string}|null}
 */
export function parseReportFileName(fileName) {
  const pattern = new RegExp(
    `^([A-Za-z]{0,4})${CONFIG.report.reportId}(\\d{8})(?:_\\d{8})?\\${CONFIG.report.extension}$`
  );
  const m = String(fileName).trim().match(pattern);
  return m ? { envCode: m[1] || null, batchDate: m[2] } : null;
}

// ============ OLSMECIF SEED FILE (batch OLSDB057) ============

/** OLSMECIF-20260924-01.dat */
export function mergeFileName(batchDateYmd, sequenceNo) {
  return `${CONFIG.seed.fileNamePrefix}-${batchDateYmd}-${String(sequenceNo).padStart(2, '0')}` +
    `${CONFIG.seed.extension}`;
}

/**
 * Parse OLSMECIF-YYYYMMDD-NN.dat.
 * @returns {{date: string, sequence: number}|null}
 */
export function parseMergeFileName(fileName) {
  const pattern = new RegExp(
    `^${CONFIG.seed.fileNamePrefix}-(\\d{8})-(\\d{2})\\${CONFIG.seed.extension}$`
  );
  const m = String(fileName).trim().match(pattern);
  return m ? { date: m[1], sequence: Number(m[2]) } : null;
}

/** Local staging path (C:\BATCH-OCBC-PW1\src\). */
export function stagingPath(fileName) {
  return path.join(CONFIG.winscp.localPath, fileName);
}
