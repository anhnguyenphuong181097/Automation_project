import { exec } from 'child_process';
import { promisify } from 'util';
import { config } from '../config/test-config.js';
import { logger, logStep, logError } from './logger.js';

const execAsync = promisify(exec);

export class PuttyHandler {
  constructor() {
    this.puttyPath = config.putty.path;
    this.host = config.putty.host;
    this.username = config.putty.username;
    this.password = config.putty.password;
    this.timeout = config.putty.timeout;
    this.batchCommand = config.batch.command;
    this.waitTime = config.batch.waitTime;
    this.retryAttempts = config.batch.retryAttempts;
    this.retryDelay = config.batch.retryDelay;
  }

  async executeBatchCommand(command, testCase) {
    let attempts = 0;
    let lastError = null;

    while (attempts < this.retryAttempts) {
      try {
        attempts++;
        logStep(`Executing batch command (Attempt ${attempts}/${this.retryAttempts})`, { 
          testCase,
          command 
        });

        const plinkCommand = this.buildPlinkCommand(command);
        const { stdout, stderr } = await execAsync(plinkCommand, {
          timeout: this.timeout,
          maxBuffer: 1024 * 1024 * 10
        });

        logStep(`Batch execution successful`, { 
          testCase
        });

        if (stderr) {
          logger.warn(`Batch stderr: ${stderr}`);
        }

        await this.waitForBatchCompletion(testCase);

        return { 
          success: true, 
          stdout, 
          stderr,
          attempts 
        };

      } catch (error) {
        lastError = error;
        logError(error, { 
          testCase,
          command,
          attempt: attempts,
          message: `Batch execution failed (Attempt ${attempts})`
        });

        if (attempts < this.retryAttempts) {
          logger.info(`Retrying in ${this.retryDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, this.retryDelay));
        }
      }
    }

    throw new Error(`Batch execution failed after ${this.retryAttempts} attempts: ${lastError.message}`);
  }

  async executeCustomCommand(command, testCase) {
    try {
      logStep(`Executing custom command`, { testCase, command });
      
      const plinkCommand = this.buildPlinkCommand(command);
      const { stdout, stderr } = await execAsync(plinkCommand, {
        timeout: this.timeout
      });

      logStep(`Custom command executed successfully`, { testCase });
      
      return { success: true, stdout, stderr };

    } catch (error) {
      logError(error, { 
        testCase,
        command,
        message: 'Custom command execution failed'
      });
      throw error;
    }
  }

  async checkBatchStatus(testCase) {
    try {
      logStep(`Checking batch status`, { testCase });
      
      const statusCommand = 'echo "Checking status..." && ps aux | grep process_batch';
      const result = await this.executeCustomCommand(statusCommand, testCase);
      
      const isRunning = result.stdout.includes('process_batch') && 
                        !result.stdout.includes('grep');
      
      return { 
        success: true, 
        isRunning, 
        output: result.stdout 
      };

    } catch (error) {
      logError(error, { 
        testCase,
        message: 'Failed to check batch status'
      });
      return { success: false, isRunning: false };
    }
  }

  async waitForBatchCompletion(testCase, timeout = 120000) {
    const startTime = Date.now();
    
    logStep(`Waiting for batch to complete (timeout: ${timeout}ms)`, { testCase });
    
    while (Date.now() - startTime < timeout) {
      const status = await this.checkBatchStatus(testCase);
      
      if (!status.isRunning) {
        logStep(`Batch completed`, { testCase });
        return true;
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    throw new Error(`Timeout waiting for batch to complete after ${timeout}ms`);
  }

  async executeBatchAndWait(testCase, batchFile = 'process_batch.sh') {
    try {
      logStep(`Starting batch execution for ${testCase}`, { testCase });
      
      // First, list files in directory
      await this.executeCustomCommand('ls -la /sftp/apps-SG-auto/', testCase);
      
      // Execute batch
      const result = await this.executeBatchCommand(
        `cd /sftp/apps-SG-auto/ && ./${batchFile}`,
        testCase
      );
      
      // Wait for completion
      await this.waitForBatchCompletion(testCase);
      
      // Check logs or output files
      const outputResult = await this.executeCustomCommand(
        'tail -n 50 /sftp/apps-SG-auto/batch_output.log',
        testCase
      );
      
      return {
        ...result,
        outputLog: outputResult.stdout
      };

    } catch (error) {
      logError(error, { 
        testCase,
        message: 'Batch execution and wait failed'
      });
      throw error;
    }
  }

  buildPlinkCommand(command) {
    return `"${this.puttyPath}" ` +
      `-ssh ${this.username}@${this.host} ` +
      `-pw ${this.password} ` +
      `"${command}"`;
  }

  async executeSequentialCommands(commands, testCase) {
    const results = [];
    
    for (const [index, cmd] of commands.entries()) {
      try {
        logStep(`Executing command ${index + 1}/${commands.length}`, { 
          testCase,
          command: cmd 
        });
        
        const result = await this.executeCustomCommand(cmd, testCase);
        results.push({ success: true, ...result });
        
        if (index < commands.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
      } catch (error) {
        logError(error, { 
          testCase,
          command: cmd,
          message: `Command ${index + 1} failed`
        });
        results.push({ success: false, error: error.message });
      }
    }
    
    return results;
  }

  async checkRemoteFileExists(filePath, testCase) {
    try {
      const command = `test -f ${filePath} && echo "EXISTS" || echo "NOT_EXISTS"`;
      const result = await this.executeCustomCommand(command, testCase);
      
      return result.stdout.trim() === 'EXISTS';
    } catch (error) {
      logError(error, { 
        testCase,
        filePath,
        message: 'Failed to check remote file existence'
      });
      return false;
    }
  }

  async getRemoteFileContent(filePath, testCase) {
    try {
      const command = `cat ${filePath}`;
      const result = await this.executeCustomCommand(command, testCase);
      
      return result.stdout;
    } catch (error) {
      logError(error, { 
        testCase,
        filePath,
        message: 'Failed to get remote file content'
      });
      throw error;
    }
  }
}