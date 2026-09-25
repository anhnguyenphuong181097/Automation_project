import winston from 'winston';
import fs from 'fs-extra';

// Ensure log directory exists
fs.ensureDirSync('./logs');

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'terminal-batch-test' },
  transports: [
    new winston.transports.File({
      filename: './logs/error.log',
      level: 'error'
    }),
    new winston.transports.File({
      filename: './logs/execution.log'
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

export const logStep = (step, data = {}) => {
  logger.info(`[STEP] ${step}`, data);
};

export const logError = (error, context = {}) => {
  logger.error(`[ERROR] ${error.message}`, {
    error: error.stack,
    ...context
  });
};

export const logResult = (testCase, result, details = {}) => {
  logger.info(`[RESULT] ${testCase}: ${result}`, details);
};

export const logAssert = (assertion, expected, actual, message = '') => {
  if (assertion) {
    logger.info(`[ASSERT PASS] ${message}`, { expected, actual });
  } else {
    logger.error(`[ASSERT FAIL] ${message}`, { expected, actual });
  }
};