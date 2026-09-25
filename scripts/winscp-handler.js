import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import path from 'path';
import { config } from '../config/test-config.js';
import { logger, logStep, logError } from './logger.js';

const execAsync = promisify(exec);

export class WinSCPHandler {
  constructor() {
    this.winscpPath = config.winscp.path;
    this.host = config.winscp.host;
    this.username = config.winscp.username;
    this.password = config.winscp.password;
    this.remotePath = config.winscp.remotePath;
    this.localPath = config.winscp.localPath;
    this.timeout = config.winscp.timeout;
  }

  async uploadFiles(filePatterns, testCase) {
    const results = [];
    const files = Array.isArray(filePatterns) ? filePatterns : [filePatterns];

    for (const filePattern of files) {
      try {
        logStep(`Uploading files matching: ${filePattern}`, { testCase });
        
        const fullPattern = path.join(this.localPath, filePattern);
        const command = this.buildUploadCommand(fullPattern);
        
        const { stdout, stderr } = await execAsync(command, {
          timeout: this.timeout,
          maxBuffer: 1024 * 1024 * 10
        });

        if (stderr && !stderr.includes('No files matching')) {
          logger.warn(`WinSCP warning: ${stderr}`);
        }

        logStep(`Upload successful for: ${filePattern}`, { testCase });
        
        results.push({
          filePattern,
          success: true,
          stdout,
          stderr
        });

      } catch (error) {
        logError(error, { 
          testCase, 
          filePattern,
          message: `Failed to upload ${filePattern}`
        });
        
        results.push({
          filePattern,
          success: false,
          error: error.message
        });
      }
    }

    return results;
  }

  async uploadSingleFile(fileName, testCase) {
    try {
      const filePath = path.join(this.localPath, fileName);
      
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      logStep(`Uploading file: ${fileName}`, { testCase });
      
      const command = this.buildUploadCommand(filePath);
      const { stdout, stderr } = await execAsync(command, {
        timeout: this.timeout,
        maxBuffer: 1024 * 1024 * 10
      });

      logStep(`Upload successful for: ${fileName}`, { testCase });
      
      return { success: true, stdout, stderr };

    } catch (error) {
      logError(error, { 
        testCase, 
        fileName,
        message: `Failed to upload ${fileName}`
      });
      throw error;
    }
  }

  async uploadDirectory(sourceDir, testCase) {
    try {
      logStep(`Uploading directory: ${sourceDir}`, { testCase });
      
      const command = this.buildUploadDirectoryCommand(sourceDir);
      const { stdout, stderr } = await execAsync(command, {
        timeout: this.timeout * 2
      });

      if (stderr) {
        logger.warn(`WinSCP warning: ${stderr}`);
      }

      logStep(`Directory upload successful`, { testCase });
      
      return { success: true, stdout, stderr };

    } catch (error) {
      logError(error, { 
        testCase, 
        sourceDir,
        message: `Failed to upload directory ${sourceDir}`
      });
      throw error;
    }
  }

  async listRemoteFiles(testCase) {
    try {
      logStep(`Listing remote files`, { testCase });
      
      const command = this.buildListCommand();
      const { stdout, stderr } = await execAsync(command, {
        timeout: this.timeout
      });

      logStep(`Remote file listing successful`, { testCase });
      
      return { success: true, files: stdout, stderr };

    } catch (error) {
      logError(error, { 
        testCase,
        message: 'Failed to list remote files'
      });
      throw error;
    }
  }

  async deleteRemoteFiles(filePatterns, testCase) {
    try {
      logStep(`Deleting remote files: ${filePatterns}`, { testCase });
      
      const command = this.buildDeleteCommand(filePatterns);
      const { stdout, stderr } = await execAsync(command, {
        timeout: this.timeout
      });

      logStep(`Delete successful`, { testCase, stdout });
      
      return { success: true, stdout, stderr };

    } catch (error) {
      logError(error, { 
        testCase,
        filePatterns,
        message: 'Failed to delete remote files'
      });
      throw error;
    }
  }

  async cleanupRemoteFiles(testCase) {
    try {
      logStep(`Cleaning up remote files`, { testCase });
      
      const date = new Date().toISOString().slice(0,10).replace(/-/g, '');
      const command = this.buildDeleteCommand(`OLSTERM_${date}*.dat`); // FIXED: Changed from hyphens to underscores
      const { stdout, stderr } = await execAsync(command, {
        timeout: this.timeout
      });

      logStep(`Cleanup successful`, { testCase });
      
      return { success: true, stdout, stderr };

    } catch (error) {
      logError(error, { 
        testCase,
        message: 'Failed to cleanup remote files'
      });
      return { success: false, error: error.message };
    }
  }

  // ============ FIXED: Changed from escaped backslashes to triple quotes ============
  buildUploadCommand(filePattern) {
    return `"${this.winscpPath}" /command ` +
      `"option batch abort" ` +
      `"option confirm off" ` +
      `"open sftp://${this.username}:${this.password}@${this.host}/" ` +
      `"cd ${this.remotePath}" ` +
      `"put ""${filePattern}""" ` +  // ← FIXED: Triple quotes instead of \"
      `"exit"`;
  }

  // ============ FIXED: Changed from escaped backslashes to triple quotes ============
  buildUploadDirectoryCommand(sourceDir) {
    return `"${this.winscpPath}" /command ` +
      `"option batch abort" ` +
      `"option confirm off" ` +
      `"open sftp://${this.username}:${this.password}@${this.host}/" ` +
      `"cd ${this.remotePath}" ` +
      `"put -recursive ""${sourceDir}"" /" ` +  // ← FIXED: Triple quotes instead of \"
      `"exit"`;
  }

  buildListCommand() {
    return `"${this.winscpPath}" /command ` +
      `"option batch abort" ` +
      `"option confirm off" ` +
      `"open sftp://${this.username}:${this.password}@${this.host}/" ` +
      `"cd ${this.remotePath}" ` +
      `"ls" ` +
      `"exit"`;
  }

  buildDeleteCommand(filePatterns) {
    const patterns = Array.isArray(filePatterns) ? filePatterns : [filePatterns];
    const deleteCommands = patterns.map(p => `"rm ${p}"`).join(' ');
    
    return `"${this.winscpPath}" /command ` +
      `"option batch abort" ` +
      `"option confirm off" ` +
      `"open sftp://${this.username}:${this.password}@${this.host}/" ` +
      `"cd ${this.remotePath}" ` +
      `${deleteCommands} ` +
      `"exit"`;
  }

  async waitForFileUpload(filePattern, timeout = 30000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      const result = await this.listRemoteFiles('wait');
      if (result.files.includes(filePattern)) {
        logger.info(`File ${filePattern} found on remote server`);
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    throw new Error(`Timeout waiting for file ${filePattern}`);
  }
}