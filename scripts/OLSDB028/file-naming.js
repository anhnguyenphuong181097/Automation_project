// scripts/OLSDB028/file-naming.js
// Naming rules of the OLSDB028 export file.
//
// OLSDB028 has no input file: its input is the data the Item Redemption API already stored in
// ITEM_FULFILMENT_STATUS (+ _HIS). The only file involved is the output OLSITRED.dat:
//
//   /apps/MY-dev/OE/cls/USER_OUTPUT/OLSDB028/OLSITRED.dat
//
// The glob (instead of the exact name) is used because the batch may append a date or a sequence
// number on another build - the same defensive approach as OLSD134R / OLSD141R. The exact name
// printed by the batch is always recorded in the run metadata.

import path from 'path';
import { CONFIG, OUTPUT_ID } from './test-data.js';

// ============ OUTPUT FILE ============

/** OLSITRED.dat (TC_01_1) */
export function outputFileName() {
  return CONFIG.output.fileName;
}

/**
 * Any file of the output folder carrying the OLSITRED id, e.g. OLSITRED.dat or OLSITRED20260928.dat.
 * The receiving system is CLK, so a 'CLK' prefix variant is covered too.
 */
export function outputFileGlob() {
  return `*${OUTPUT_ID}*`;
}

/** reports\OLSDB028\<file downloaded from the server> */
export function outputLocalPathForName(fileName) {
  return path.join(CONFIG.output.localDir, fileName);
}

/** /apps/MY-dev/OE/cls/USER_OUTPUT/OLSDB028/OLSITRED.dat */
export function outputRemotePath(fileName = outputFileName()) {
  return `${CONFIG.output.remoteDir}/${fileName}`;
}

/**
 * Parse an OLSITRED file name.
 *   OLSITRED.dat          -> { name, sequence: null, batchDate: null }
 *   OLSITRED20260928.dat  -> { name, sequence: null, batchDate: '20260928' }
 *   OLSITRED_01           -> { name, sequence: 1,    batchDate: null }
 * @returns {{name: string, sequence: number|null, batchDate: string|null}|null}
 */
export function parseOutputFileName(fileName) {
  const name = String(fileName).trim();
  if (!name) return null;

  const base = path.basename(name);
  if (!base.toUpperCase().includes(OUTPUT_ID)) return null;

  const withDate = base.match(new RegExp(`${OUTPUT_ID}(\\d{8})`, 'i'));
  const withSeq = base.match(new RegExp(`${OUTPUT_ID}_(\\d{2})`, 'i'));

  return {
    name: base,
    sequence: withSeq ? Number(withSeq[1]) : null,
    batchDate: withDate ? withDate[1] : null,
  };
}
