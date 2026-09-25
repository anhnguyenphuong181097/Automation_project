import dotenv from 'dotenv';
dotenv.config();

export const config = {
  winscp: {
    path: process.env.WINSCP_PATH || 'C:\\Program Files (x86)\\WinSCP\\WinSCP.com',
    host: process.env.SFTP_HOST || '192.168.99.89',
    username: process.env.SFTP_USERNAME || 'root',
    password: process.env.SFTP_PASSWORD || 'oev123',
    remotePath: process.env.SFTP_REMOTE_PATH || '/sftp/apps-SG-auto/',
    localPath: process.env.LOCAL_PATH || 'C:\\BATCH-OCBC-PW1',
    timeout: parseInt(process.env.WINSCP_TIMEOUT) || 30000
  },
  putty: {
    path: process.env.PUTTY_PATH || 'C:\\Program Files\\PuTTY\\plink.exe',
    host: process.env.SSH_HOST || '192.*****************',
    username: process.env.SSH_USERNAME || 'root',
    password: process.env.SSH_PASSWORD || 'oev123',
    timeout: parseInt(process.env.BATCH_TIMEOUT) || 60000
  },
  batch: {
    command: process.env.BATCH_COMMAND || 'process_batch.sh',
    waitTime: parseInt(process.env.BATCH_WAIT_TIME) || 5000,
    retryAttempts: parseInt(process.env.RETRY_ATTEMPTS) || 3,
    retryDelay: parseInt(process.env.RETRY_DELAY) || 2000,
    outputLogPath: '/sftp/apps-SG-auto/batch_output.log',
    resultsPath: '/sftp/apps-SG-auto/results/'
  },
  testData: {
    basePath: './test-data',
    outputPath: process.env.TEST_DATA_PATH || './test-data/generated',
    dateFormat: 'YYYYMMDD',
    filePrefix: 'OLSTERM'
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    path: './logs/execution.log'
  },
  report: {
    path: './reports',
    format: 'json'
  }
};