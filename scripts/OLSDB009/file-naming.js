// scripts/OLSDB009/file-naming.js
// Batch     : OLSDB009
// File name : OLSTXN-<SOURCE>-YYYYMMDD-NN.dat
//
// NOTE: unlike the OLSDB020/OLSDB024 version of this file, OLSDB009 file names
// carry an extra <SOURCE> segment, so the parsing and validation differ.
//
// This module is currently not imported by the generator or the spec - the
// generator builds names through generateFileName() in file-generator.js. It is
// kept alongside the other batch folders for structural parity.
//
// Deliberately does NOT import ../config/test-config.js: that module calls
// dotenv.config(), and loading .env would override BATCH_COMMAND with the
// non-existent process_batch.sh. Keeping this file self-contained avoids
// planting that trap if it is ever imported.

export class FileNaming {
  constructor({ prefix = 'OLSTXN', source = 'OLS', separator = '-' } = {}) {
    this.prefix = prefix;
    this.source = source;
    this.separator = separator;
  }

  getCurrentDate() {
    const now = new Date();
    return (
      now.getFullYear() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0')
    );
  }

  getDateWithOffset(offsetDays = 0) {
    const now = new Date();
    now.setDate(now.getDate() + offsetDays);
    return (
      now.getFullYear() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0')
    );
  }

  /**
   * Generate a file name: OLSTXN-OLS-20260911-01.dat
   * @param {number} sequenceNo - sequence number (1-99)
   * @param {string} [date] - optional YYYYMMDD
   * @param {string} [source] - optional source system override
   * @returns {string}
   */
  generateFileName(sequenceNo, date = null, source = null) {
    const d = date || this.getCurrentDate();
    const src = source || this.source;
    const seq = String(sequenceNo).padStart(2, '0');
    return `${this.prefix}${this.separator}${src}${this.separator}${d}${this.separator}${seq}.dat`;
  }

  /** Same as generateFileName - kept for parity with the older batches. */
  generateFilePattern(sequenceNo, date = null, source = null) {
    return this.generateFileName(sequenceNo, date, source);
  }

  /** Array of file names for a sequence range. */
  generateFilePatterns(startSeq, endSeq, date = null, source = null) {
    const patterns = [];
    for (let i = startSeq; i <= endSeq; i++) {
      patterns.push(this.generateFileName(i, date, source));
    }
    return patterns;
  }

  /** Wildcard covering a sequence range: OLSTXN-OLS-20260911-*.dat */
  generateWildcardPattern(startSeq, endSeq, date = null, source = null) {
    const d = date || this.getCurrentDate();
    const src = source || this.source;
    if (startSeq === endSeq) return this.generateFileName(startSeq, d, src);
    return `${this.prefix}${this.separator}${src}${this.separator}${d}${this.separator}*.dat`;
  }

  /**
   * Parse OLSTXN-OLS-20260911-01.dat
   * @returns {Object} { prefix, source, date, sequence, sequenceStr, extension, fullName }
   */
  parseFileName(fileName) {
    const base = fileName.replace(/\.dat$/i, '');
    const parts = base.split(this.separator);

    // OLSTXN-OLS-20260911-01 -> [prefix, source, date, seq]
    // OLSTERM-20260911-01    -> [prefix, date, seq]  (older batches, no source)
    const hasSource = parts.length >= 4;
    const [prefix = '', second = '', third = '', fourth = ''] = parts;

    return {
      prefix,
      source: hasSource ? second : null,
      date: hasSource ? third : second,
      sequenceStr: hasSource ? fourth : third,
      sequence: parseInt(hasSource ? fourth : third, 10) || 0,
      extension: 'dat',
      fullName: fileName,
    };
  }

  getSequenceFromFile(fileName) {
    return this.parseFileName(fileName).sequence;
  }

  getDateFromFile(fileName) {
    return this.parseFileName(fileName).date;
  }

  /** Validate OLSTXN-<SOURCE>-YYYYMMDD-NN.dat */
  validateFileName(fileName) {
    const pattern = new RegExp(
      `^${this.prefix}${this.separator}[^-]+${this.separator}\\d{8}${this.separator}\\d{2}\\.dat$`,
    );
    return pattern.test(fileName);
  }

  /** Pattern for deleting every generated file of a given date. */
  getCleanupPattern(date = null, source = null) {
    const d = date || this.getCurrentDate();
    const src = source || this.source;
    return `${this.prefix}${this.separator}${src}${this.separator}${d}${this.separator}*.dat`;
  }
}

export default new FileNaming();
