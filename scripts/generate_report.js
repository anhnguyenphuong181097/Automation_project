import fs from 'fs-extra';

async function generateDbReport(results, testCase) {
  const reportPath = `./reports/db-verification-${testCase}-${Date.now()}.html`;
  
  let html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Database Verification - ${testCase}</title>
      <style>
        body { font-family: Arial; margin: 20px; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #4CAF50; color: white; }
        .success { color: green; }
        .error { color: red; }
      </style>
    </head>
    <body>
      <h1>Database Verification Report - ${testCase}</h1>
      <h2>Batch Resource Records (${results.batchResource?.rows?.length || 0})</h2>
      <table>
        <tr>
          <th>Record No</th>
          <th>Terminal Name</th>
          <th>Status</th>
          <th>Created Date</th>
        </tr>
  `;
  
  if (results.batchResource?.rows) {
    results.batchResource.rows.slice(0, 50).forEach(row => {
      html += `
        <tr>
          <td>${row.record_no || ''}</td>
          <td>${row.terminal_name || ''}</td>
          <td>${row.status || ''}</td>
          <td>${row.created_date || ''}</td>
        </tr>
      `;
    });
  }
  
  html += `
      </table>
      <h2>EFT POS Records (${results.eftPos?.rows?.length || 0})</h2>
      <table>
        <tr>
          <th>Record No</th>
          <th>Terminal Name</th>
          <th>Status</th>
          <th>Updated Date</th>
        </tr>
  `;
  
  if (results.eftPos?.rows) {
    results.eftPos.rows.slice(0, 50).forEach(row => {
      html += `
        <tr>
          <td>${row.record_no || ''}</td>
          <td>${row.terminal_name || ''}</td>
          <td>${row.status || ''}</td>
          <td>${row.updated_date || ''}</td>
        </tr>
      `;
    });
  }
  
  html += `
      </table>
      <h2>Summary</h2>
      <pre>${JSON.stringify(results.summary, null, 2)}</pre>
    </body>
    </html>
  `;
  
  fs.writeFileSync(reportPath, html);
  log(`📄 Database report generated: ${reportPath}`);
}