// scripts/file-naming.js
import moment from 'moment';
import { config } from '../config/test-config.js';

export class FileNaming {
  constructor() {
    this.prefix = config.testData.filePrefix || 'OLSTERM';
    this.dateFormat = config.testData.dateFormat || 'YYYYMMDD';
  }

  getCurrentDate() {
    return moment().format(this.dateFormat);
  }

  getDateWithOffset(offsetDays = 0) {
    return moment().add(offsetDays, 'days').format(this.dateFormat);
  }

  /**
   * Generate filename with format: OLSTERM-YYYYMMDD-XX.dat
   * @param {number} sequenceNo - Sequence number (1-99)
   * @param {string} date - Optional date string (YYYYMMDD)
   * @returns {string} Filename
   */
  generateFileName(sequenceNo, date = null) {
    const currentDate = date || this.getCurrentDate();
    const seq = String(sequenceNo).padStart(2, '0');
    return `${this.prefix}-${currentDate}-${seq}.dat`;
  }

  /**
   * Generate file pattern for WinSCP
   * @param {number} sequenceNo - Sequence number (1-99)
   * @param {string} date - Optional date string (YYYYMMDD)
   * @returns {string} File pattern
   */
  generateFilePattern(sequenceNo, date = null) {
    const currentDate = date || this.getCurrentDate();
    const seq = String(sequenceNo).padStart(2, '0');
    return `${this.prefix}-${currentDate}-${seq}.dat`;
  }

  /**
   * Generate multiple file patterns
   * @param {number} startSeq - Starting sequence number
   * @param {number} endSeq - Ending sequence number
   * @param {string} date - Optional date string (YYYYMMDD)
   * @returns {string[]} Array of file patterns
   */
  generateFilePatterns(startSeq, endSeq, date = null) {
    const patterns = [];
    const currentDate = date || this.getCurrentDate();
    
    for (let i = startSeq; i <= endSeq; i++) {
      const seq = String(i).padStart(2, '0');
      patterns.push(`${this.prefix}-${currentDate}-${seq}.dat`);
    }
    
    return patterns;
  }

  /**
   * Generate wildcard pattern for multiple files
   * @param {number} startSeq - Starting sequence number
   * @param {number} endSeq - Ending sequence number
   * @param {string} date - Optional date string (YYYYMMDD)
   * @returns {string} Wildcard pattern
   */
  generateWildcardPattern(startSeq, endSeq, date = null) {
    const currentDate = date || this.getCurrentDate();
    
    if (startSeq === endSeq) {
      const seq = String(startSeq).padStart(2, '0');
      return `${this.prefix}-${currentDate}-${seq}.dat`;
    }
    
    return `${this.prefix}-${currentDate}-*.dat`;
  }

  /**
   * Parse filename
   * @param {string} fileName - Filename like OLSTERM-20260625-01.dat
   * @returns {Object} Parsed parts
   */
  parseFileName(fileName) {
    // OLSTERM-20260625-01.dat
    const parts = fileName.split('-');
    const nameAndExt = parts[2] ? parts[2].split('.') : ['', ''];
    
    return {
      prefix: parts[0] || '',
      date: parts[1] || '',
      sequence: parseInt(parts[2] ? parts[2].split('.')[0] : '0'),
      sequenceStr: parts[2] ? parts[2].split('.')[0] : '',
      extension: parts[2] ? parts[2].split('.')[1] : 'dat',
      fullName: fileName
    };
  }

  /**
   * Get sequence number from filename
   * @param {string} fileName - Filename
   * @returns {number} Sequence number
   */
  getSequenceFromFile(fileName) {
    const parsed = this.parseFileName(fileName);
    return parsed.sequence;
  }

  /**
   * Get date from filename
   * @param {string} fileName - Filename
   * @returns {string} Date string (YYYYMMDD)
   */
  getDateFromFile(fileName) {
    const parsed = this.parseFileName(fileName);
    return parsed.date;
  }

  /**
   * Validate filename format
   * @param {string} fileName - Filename
   * @returns {boolean} True if valid
   */
  validateFileName(fileName) {
    const pattern = new RegExp(`^${this.prefix}-\\d{8}-\\d{2}\\.dat$`);
    return pattern.test(fileName);
  }

  /**
   * Get cleanup pattern
   * @param {string} date - Optional date
   * @returns {string} Pattern for deleting all test files
   */
  getCleanupPattern(date = null) {
    const currentDate = date || this.getCurrentDate();
    return `${this.prefix}-${currentDate}-*.dat`;
  }
}

// Export singleton instance
export default new FileNaming();