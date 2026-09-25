// ============ POSTGRESQL DATABASE HELPER FUNCTIONS (FULLY CORRECTED) ============

// Database connection function for PostgreSQL
async function getDbConnection() {
  const client = new pg.Client({
    host: CONFIG.database.host,
    port: CONFIG.database.port,
    user: CONFIG.database.username,
    password: CONFIG.database.password,
    database: CONFIG.database.database,
    schema: CONFIG.database.schema || 'ols_schema',
  });
  
  try {
    await client.connect();
    // Set the schema for the connection
    await client.query(`SET search_path TO ${CONFIG.database.schema || 'ols_schema'}`);
    log('✅ PostgreSQL connected successfully');
    return client;
  } catch (error) {
    log('❌ PostgreSQL connection failed', { error: error.message });
    throw error;
  }
}

// Execute database query
async function executeDbQuery(query, testCase) {
  let client;
  try {
    client = await getDbConnection();
    log(`[${testCase}] Executing DB query: ${query.substring(0, 100)}...`);
    
    const result = await client.query(query);
    return { 
      success: true, 
      rows: result.rows, 
      count: result.rowCount || result.rows.length 
    };
    
  } catch (error) {
    log(`[${testCase}] ❌ DB query failed`, { error: error.message });
    return { success: false, error: error.message, rows: [] };
  } finally {
    if (client) {
      await client.end();
      log(`[${testCase}] PostgreSQL connection closed`);
    }
  }
}

// ============================================
// BATCH_RESOURCE VERIFICATION
// ============================================

// Verify database results for batch_resource - COMPLETE
async function verifyBatchResource(batchId, testCase) {
  const query = `
    SELECT 
      record_no,
      business_id,
      job_id,
      job_name,
      batch_id,
      logical_filename,
      file_no,
      file_date,
      file_creation_date,
      file_last_modified_date,
      file_checksum,
      total_record,
      process_by,
      process_date,
      process_status,
      start_date_time,
      end_date_time,
      user_batch_no,
      status,
      batch_date,
      error_code,
      error_message,
      source_system
    FROM ols_schema.batch_resource 
    WHERE batch_id = '${batchId}' 
    ORDER BY record_no DESC 
    LIMIT 20
  `;
  
  const result = await executeDbQuery(query, testCase);
  
  if (result.success && result.rows.length > 0) {
    log(`[${testCase}] 📊 Batch Resource Results:`, {
      count: result.rows.length,
      latestRecords: result.rows.slice(0, 5).map(r => ({
        record_no: r.record_no,
        job_name: r.job_name,
        logical_filename: r.logical_filename,
        status: r.status,
        process_status: r.process_status,
        file_creation_date: r.file_creation_date
      }))
    });
  } else {
    log(`[${testCase}] ⚠️ No records found in batch_resource`);
  }
  
  return result;
}

// ============================================
// EFT_POS VERIFICATION
// ============================================

// Verify database results for eft_pos - COMPLETE
async function verifyEftPos(testCase) {
  const query = `
    SELECT 
      business_id,
      record_no,
      corporate_id,
      establishment_id,
      status,
      last_update_date,
      last_update_by,
      last_approve_date,
      last_approve_by,
      terminal_type,
      terminal_name,
      service_start_date,
      currency_code,
      branch_id,
      terminal_id,
      service_termination_date,
      batch_no,
      dept_no,
      sub_dept_no,
      ecr_no,
      response_code,
      installed_date,
      remove_date,
      eft_pos_group,
      create_by,
      create_date,
      terminal_status
    FROM ols_schema.eft_pos 
    ORDER BY record_no DESC 
    LIMIT 20
  `;
  
  const result = await executeDbQuery(query, testCase);
  
  if (result.success && result.rows.length > 0) {
    log(`[${testCase}] 📊 EFT POS Results:`, {
      count: result.rows.length,
      latestRecords: result.rows.slice(0, 5).map(r => ({
        record_no: r.record_no,
        terminal_name: r.terminal_name,
        terminal_id: r.terminal_id,
        status: r.status,
        terminal_status: r.terminal_status,
        create_date: r.create_date
      }))
    });
  } else {
    log(`[${testCase}] ⚠️ No records found in eft_pos`);
  }
  
  return result;
}

// ============================================
// COMPREHENSIVE VERIFICATION
// ============================================

// Comprehensive database verification
async function verifyDatabaseResults(testCase, batchId = 'OLSDB024') {
  log(`[${testCase}] 🔍 Starting PostgreSQL verification...`);
  
  const results = {
    batchResource: null,
    eftPos: null,
    success: false,
    summary: {}
  };
  
  try {
    // Verify batch_resource
    results.batchResource = await verifyBatchResource(batchId, testCase);
    
    // Verify eft_pos
    results.eftPos = await verifyEftPos(testCase);
    
    // Determine overall success
    results.success = results.batchResource.success && results.eftPos.success;
    
    // Create summary with correct column names
    const latestBatch = results.batchResource?.rows?.[0] || {};
    const latestEft = results.eftPos?.rows?.[0] || {};
    
    results.summary = {
      batchResourceCount: results.batchResource?.rows?.length || 0,
      eftPosCount: results.eftPos?.rows?.length || 0,
      latestRecordNo: latestBatch.record_no || 'N/A',
      latestFileName: latestBatch.logical_filename || 'N/A',
      latestBatchStatus: latestBatch.status || 'N/A',
      latestProcessStatus: latestBatch.process_status || 'N/A',
      latestTerminalName: latestEft.terminal_name || 'N/A',
      latestTerminalStatus: latestEft.terminal_status || 'N/A',
      timestamp: new Date().toISOString()
    };
    
    log(`[${testCase}] ✅ PostgreSQL verification complete`, results.summary);
    
  } catch (error) {
    log(`[${testCase}] ❌ PostgreSQL verification failed`, { error: error.message });
    results.success = false;
  }
  
  return results;
}

// ============================================
// DISPLAY RESULTS
// ============================================

// Format and display results in a readable table
function displayResultsTable(results, testCase) {
  console.log(`\n${'='.repeat(120)}`);
  console.log(`📊 POSTGRESQL VERIFICATION RESULTS - ${testCase}`);
  console.log(`${'='.repeat(120)}`);
  
  // ========== BATCH_RESOURCE TABLE ==========
  if (results.batchResource?.rows?.length > 0) {
    console.log('\n📋 BATCH_RESOURCE TABLE:');
    console.log('-'.repeat(130));
    console.log('Record No | Job Name | File Name | Status | Process Status | Created Date');
    console.log('-'.repeat(130));
    
    results.batchResource.rows.slice(0, 10).forEach(row => {
      const fileName = (row.logical_filename || '').substring(0, 30);
      console.log(
        `${String(row.record_no || '').padEnd(9)} | ` +
        `${String(row.job_name || '').padEnd(10)} | ` +
        `${String(fileName).padEnd(30)} | ` +
        `${String(row.status || '').padEnd(8)} | ` +
        `${String(row.process_status || '').padEnd(15)} | ` +
        `${row.file_creation_date || ''}`
      );
    });
    console.log('-'.repeat(130));
    console.log(`Total records: ${results.batchResource.rows.length}`);
    
    // Show latest record details
    const latest = results.batchResource.rows[0];
    if (latest) {
      console.log(`\n📄 Latest Batch Record Details:`);
      console.log(`  Record No: ${latest.record_no}`);
      console.log(`  File Name: ${latest.logical_filename}`);
      console.log(`  Job Name: ${latest.job_name}`);
      console.log(`  Status: ${latest.status}`);
      console.log(`  Process Status: ${latest.process_status}`);
      console.log(`  Created: ${latest.file_creation_date}`);
      console.log(`  Total Records: ${latest.total_record}`);
      console.log(`  Processed By: ${latest.process_by}`);
      console.log(`  Error Message: ${latest.error_message || 'None'}`);
    }
  } else {
    console.log('\n📋 BATCH_RESOURCE TABLE: No records found');
  }
  
  // ========== EFT_POS TABLE ==========
  if (results.eftPos?.rows?.length > 0) {
    console.log('\n📋 EFT_POS TABLE:');
    console.log('-'.repeat(120));
    console.log('Record No | Terminal Name | Terminal ID | Status | Terminal Status | Create Date');
    console.log('-'.repeat(120));
    
    results.eftPos.rows.slice(0, 10).forEach(row => {
      console.log(
        `${String(row.record_no || '').padEnd(9)} | ` +
        `${String(row.terminal_name || '').padEnd(15)} | ` +
        `${String(row.terminal_id || '').padEnd(12)} | ` +
        `${String(row.status || '').padEnd(8)} | ` +
        `${String(row.terminal_status || '').padEnd(15)} | ` +
        `${row.create_date || ''}`
      );
    });
    console.log('-'.repeat(120));
    console.log(`Total records: ${results.eftPos.rows.length}`);
    
    // Show latest record details
    const latest = results.eftPos.rows[0];
    if (latest) {
      console.log(`\n📄 Latest EFT POS Record Details:`);
      console.log(`  Record No: ${latest.record_no}`);
      console.log(`  Terminal Name: ${latest.terminal_name}`);
      console.log(`  Terminal ID: ${latest.terminal_id}`);
      console.log(`  Terminal Type: ${latest.terminal_type}`);
      console.log(`  Status: ${latest.status}`);
      console.log(`  Terminal Status: ${latest.terminal_status}`);
      console.log(`  Business ID: ${latest.business_id}`);
      console.log(`  Branch ID: ${latest.branch_id}`);
      console.log(`  Create Date: ${latest.create_date}`);
      console.log(`  Last Update: ${latest.last_update_date}`);
    }
  } else {
    console.log('\n📋 EFT_POS TABLE: No records found');
  }
  
  console.log(`\n📈 Summary:`, results.summary);
  console.log(`${'='.repeat(120)}\n`);
}

// ============================================
// ADDITIONAL HELPER FUNCTIONS
// ============================================

// Get batch statistics
async function getBatchStatistics(batchId, testCase) {
  const query = `
    SELECT 
      COUNT(*) as total_records,
      COUNT(CASE WHEN status = 'SUCCESS' THEN 1 END) as success_count,
      COUNT(CASE WHEN status = 'ERROR' THEN 1 END) as error_count,
      COUNT(CASE WHEN status = 'PENDING' THEN 1 END) as pending_count,
      COUNT(CASE WHEN status = 'PROCESSING' THEN 1 END) as processing_count,
      MIN(file_creation_date) as earliest_date,
      MAX(file_creation_date) as latest_date
    FROM ols_schema.batch_resource 
    WHERE batch_id = '${batchId}'
  `;
  
  const result = await executeDbQuery(query, testCase);
  if (result.success && result.rows.length > 0) {
    const stats = result.rows[0];
    log(`[${testCase}] 📊 Batch Statistics for ${batchId}:`, {
      total_records: stats.total_records,
      success_count: stats.success_count,
      error_count: stats.error_count,
      pending_count: stats.pending_count,
      processing_count: stats.processing_count,
      date_range: `${stats.earliest_date} to ${stats.latest_date}`
    });
  }
  return result;
}

// Get EFT POS statistics
async function getEftPosStatistics(testCase) {
  const query = `
    SELECT 
      COUNT(*) as total_terminals,
      COUNT(DISTINCT terminal_type) as terminal_types,
      COUNT(CASE WHEN status = 'ACTIVE' THEN 1 END) as active_count,
      COUNT(CASE WHEN status = 'INACTIVE' THEN 1 END) as inactive_count,
      COUNT(CASE WHEN terminal_status = 'ONLINE' THEN 1 END) as online_count,
      COUNT(CASE WHEN terminal_status = 'OFFLINE' THEN 1 END) as offline_count,
      MIN(create_date) as earliest_created,
      MAX(create_date) as latest_created
    FROM ols_schema.eft_pos
  `;
  
  const result = await executeDbQuery(query, testCase);
  if (result.success && result.rows.length > 0) {
    const stats = result.rows[0];
    log(`[${testCase}] 📊 EFT POS Statistics:`, {
      total_terminals: stats.total_terminals,
      active_count: stats.active_count,
      inactive_count: stats.inactive_count,
      online_count: stats.online_count,
      offline_count: stats.offline_count,
      terminal_types: stats.terminal_types
    });
  }
  return result;
}

// Comprehensive verification with statistics
async function verifyDatabaseWithStats(testCase, batchId = 'OLSDB024') {
  const results = await verifyDatabaseResults(testCase, batchId);
  
  // Get statistics
  if (results.batchResource.success) {
    results.batchStats = await getBatchStatistics(batchId, testCase);
  }
  
  if (results.eftPos.success) {
    results.eftStats = await getEftPosStatistics(testCase);
  }
  
  return results;
}

// Debug function to show table structure
async function showTableStructure(tableName, testCase) {
  const query = `
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'ols_schema' AND table_name = '${tableName}'
    ORDER BY ordinal_position
  `;
  const result = await executeDbQuery(query, testCase);
  if (result.success && result.rows.length > 0) {
    log(`[${testCase}] 📋 Table structure for ols_schema.${tableName}:`);
    result.rows.forEach(row => {
      log(`  ${row.column_name} (${row.data_type}) - Nullable: ${row.is_nullable}`);
    });
  }
  return result;
}

// Get records by file name pattern
async function getRecordsByFileName(filePattern, testCase) {
  const query = `
    SELECT 
      record_no,
      logical_filename,
      status,
      process_status,
      file_creation_date,
      error_message
    FROM ols_schema.batch_resource 
    WHERE logical_filename LIKE '%${filePattern}%'
    ORDER BY record_no DESC
    LIMIT 10
  `;
  return await executeDbQuery(query, testCase);
}

// Get latest N records from batch_resource
async function getLatestBatchRecords(limit = 10, testCase) {
  const query = `
    SELECT 
      record_no,
      logical_filename,
      job_name,
      status,
      process_status,
      file_creation_date
    FROM ols_schema.batch_resource 
    ORDER BY record_no DESC 
    LIMIT ${limit}
  `;
  return await executeDbQuery(query, testCase);
}

// Get latest N records from eft_pos
async function getLatestEftPosRecords(limit = 10, testCase) {
  const query = `
    SELECT 
      record_no,
      terminal_name,
      terminal_id,
      status,
      terminal_status,
      create_date
    FROM ols_schema.eft_pos 
    ORDER BY record_no DESC 
    LIMIT ${limit}
  `;
  return await executeDbQuery(query, testCase);
}

// Check if a specific file was processed
async function checkFileProcessed(fileName, testCase) {
  const query = `
    SELECT 
      record_no,
      logical_filename,
      status,
      process_status,
      file_creation_date,
      error_message
    FROM ols_schema.batch_resource 
    WHERE logical_filename = '${fileName}'
  `;
  const result = await executeDbQuery(query, testCase);
  if (result.success && result.rows.length > 0) {
    log(`[${testCase}] 📄 File ${fileName} found in database:`, {
      record_no: result.rows[0].record_no,
      status: result.rows[0].status,
      process_status: result.rows[0].process_status
    });
  } else {
    log(`[${testCase}] ⚠️ File ${fileName} not found in database`);
  }
  return result;
}