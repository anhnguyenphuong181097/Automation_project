// scripts/OLSDB037/file-naming.js
// Naming rules of the OLSDB037 output file.
//
// OLS Batch Interface (Output from OLS) Specifications v1.16, section 2.3.2:
//   "Request file name : GRSAVGPF (no extension)"
//   "Response file name: GRSAVOyyyymmdd (no extension)"   <- the fate file returned by SICS
//
// There is NO date and NO sequence number in the request file name, so two runs on the same day
// produce the same file name and the only way to tell "the file of this run" from "the file of the
// previous run" is its mtime / size (see waitForFreshOutput in the spec).

import path from 'path';
import { CONFIG } from './test-data.js';

export const OUTPUT_FILE_ID = 'GRSAVGPF';
/** Fate file prefix returned by the receiving system: GRSAVOyyyymmdd. */
export const FATE_FILE_ID = 'GRSAVO';

/** Expected file name of one run (no date, no sequence). */
export function outputFileName() {
  return CONFIG.output.fileName;
}

/** Glob used on the server to list the request files of this batch (*GRSAVGPF*). */
export function outputFileGlob() {
  return `*${OUTPUT_FILE_ID}*`;
}

/** Glob of the fate files (kept apart on purpose - they are a different interface). */
export function fateFileGlob() {
  return `*${FATE_FILE_ID}*`;
}

/** GRSAVOyyyymmdd of one date. */
export function fateFileName(date = new Date()) {
  const ymd = date.getFullYear() +
    String(date.getMonth() + 1).padStart(2, '0') +
    String(date.getDate()).padStart(2, '0');
  return `${FATE_FILE_ID}${ymd}`;
}

/** Local path of a downloaded file (reports\OLSDB037\GRSAVGPF). */
export function outputLocalPathForName(fileName) {
  return path.join(CONFIG.output.localDir, fileName);
}

/** True when the name is the request file of OLSDB037. */
export function isRequestFileName(name) {
  const base = path.basename(String(name ?? '')).trim();
  return base === OUTPUT_FILE_ID || base.startsWith(`${OUTPUT_FILE_ID}.`);
}

/** True when the name is a fate file (GRSAVOyyyymmdd) - never the file this spec verifies. */
export function isFateFileName(name) {
  const base = path.basename(String(name ?? '')).trim();
  return new RegExp(`^${FATE_FILE_ID}\\d{0,8}$`).test(base);
}

/**
 * Parse an output file name of OLSDB037.
 * @returns {{name: string, batch: string, kind: 'request'|'fate'} | null} null when the name does
 *   not belong to this interface (used to filter `ls` output of the folder).
 */
export function parseOutputFileName(name) {
  const base = path.basename(String(name ?? '')).trim();
  if (!base) return null;
  if (isFateFileName(base)) return { name: base, batch: OUTPUT_FILE_ID, kind: 'fate' };
  if (isRequestFileName(base)) return { name: base, batch: OUTPUT_FILE_ID, kind: 'request' };
  return null;
}

export default {
  OUTPUT_FILE_ID,
  FATE_FILE_ID,
  outputFileName,
  outputFileGlob,
  fateFileGlob,
  fateFileName,
  outputLocalPathForName,
  isRequestFileName,
  isFateFileName,
  parseOutputFileName,
};
