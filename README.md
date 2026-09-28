# OLSD134R & OLSD141R — Report batch automation tests (OCBC / OLS)

This document explains two automated tests: **OLSD134R** and **OLSD141R**.
Both of them test an OLS **report batch**.

Playwright is used only as a test runner (assertions, retries, HTML / JSON / JUnit reports).
It does not test any user interface.

Every run is a **real run against the dev servers** — nothing is mocked. One run does this:

1. create `.dat` input files and upload them over SFTP,
2. run Java batches on the batch server over SSH,
3. download the `.txt` report that the batch produced,
4. compare that report with the real PostgreSQL database.

## Quick start

```powershell
cd F:\BATCH-OCBC-PW1
npm install
npm run test:olsd141r          # runs the whole OLSD141R suite
npx playwright test scripts/OLSD134R/test-runner.spec.js   # runs the whole OLSD134R suite
```

Both commands above **seed data and run real batches**. Read section 8 before you run them.

## Words used in this document

| Word | Meaning |
|---|---|
| **Report batch** | A batch that has no input file of its own. It reads data that other batches already stored in the database, and writes a `.txt` report. |
| **Seed / seeding** | Creating that source data first, by generating `.dat` files and running the batches that own them. Nothing can be verified until the data exists. |
| **Cut-off time** | A timestamp stored in `ols_schema.oe_cutofftime_control`. A report only prints rows newer than the cut-off. OLSD134R uses it; OLSD141R does not. |
| **Ledger** | The table `ols_schema.batch_resource`. It remembers which file names were already used. Re-using a name makes the batch fail with `BE051`. |
| **Glob** | A file-name pattern, for example `*OLSD141R*`. It matches any file whose name contains that text. |
| **plink** | The PuTTY command-line tool used to run SSH commands on the batch server. |
| **WinSCP** | The tool used to upload and download files over SFTP. |

## Contents

1. [The two jobs](#1-the-two-jobs)
2. [What you need before you start](#2-what-you-need-before-you-start)
3. [Folder structure](#3-folder-structure)
4. [The "one job = 4 files" pattern](#4-the-one-job--4-files-pattern)
5. [How a run works](#5-how-a-run-works)
6. [Test cases](#6-test-cases)
7. [Configuration](#7-configuration)
8. [Running the tests](#8-running-the-tests)
9. [Where the results are](#9-where-the-results-are)
10. [Business rules verified on dev](#10-business-rules-verified-on-dev)
11. [Troubleshooting](#11-troubleshooting)
12. [Open items](#12-open-items)

## 1. The two jobs

| Job | Report it produces | Batch command | Data needed first (seed) | Report file on dev | Tests |
|---|---|---|---|---|---|
| **OLSD134R** | Batch Redemption Exception Report | `./OLSDR134` | `OLSTXN` file with `txn_type = 01` → run `./OLSDB009` → rows land in `DWH_TEMP_TXN` | `MYOLSD134R<YYYYMMDD>.txt`. The country code can be `ID…`, so the spec looks for `*OLSD134R<date>*.txt` | 5 tests: TC01, TC02, TC03, TC04, TC06 |
| **OLSD141R** | CIF Merge File Report | `./OLSDR141` | `OLSCUST` file (15 CIFs) → run `./OLSDB012` → rows land in `CLIENT`; `OLSMECIF` file (8 merge records) → run `./OLSDB057` → rows land in `DWH_TEMP_CIF_MERGE` | `OLSD141R_01` on the current dev build (no country code, no date), so the spec looks for `*OLSD141R*` | 7 tests: TC01 to TC07 |

Both jobs run against the same place:

| Item | Value |
|---|---|
| Host (SFTP + SSH + database) | `192.168.99.83` (MY-dev) |
| Folder with the batch scripts | `/apps/MY-dev/scripts` |
| Report folders on the server | `/apps/MY-dev/OE/cls/USER_OUTPUT/OLSD134R` and `.../OLSD141R` |
| Database | `ols_my`, schema `ols_schema`, port `5432` |

## 2. What you need before you start

- Windows with PowerShell (many paths in the project look like `C:\...`).
- Node.js 20 or newer. The project uses ESM (`"type": "module"`), so use `import`, never `require`.
- WinSCP, installed at `C:\Program Files (x86)\WinSCP\WinSCP.com`.
- PuTTY, installed at `C:\Program Files\PuTTY\plink.exe`.
  WinSCP does **not** include `plink.exe`, so installing WinSCP is not enough.
- A working VPN connection to `192.168.99.x`, and access to PostgreSQL on port `5432`.
- A `.env` file in the project root with the credentials. Never commit it, and never paste it into a ticket.
- For **OLSD141R only**: two sample files from the BA, used as layout templates —
  `F:\OCBC\OLSCUST-20260728-01.dat` and `F:\OCBC\OLSMECIF-20260907-01.dat`.
  If they move, update `CONFIG.templates` or the matching environment variables (section 7).

```powershell
cd F:\BATCH-OCBC-PW1
npm install
```

Run this quick check at the start of every session. It only reads the state of your machine;
it does not touch any server.

```powershell
$tools = @(
  @{ Name = 'Node.js';      Ok = [bool](Get-Command node -ErrorAction SilentlyContinue); Hint = 'Install Node.js 20+' }
  @{ Name = 'WinSCP.com';   Ok = Test-Path 'C:\Program Files (x86)\WinSCP\WinSCP.com';   Hint = 'Install WinSCP' }
  @{ Name = 'plink.exe';    Ok = Test-Path 'C:\Program Files\PuTTY\plink.exe';           Hint = 'winget install --id PuTTY.PuTTY' }
  @{ Name = 'node_modules'; Ok = Test-Path '.\node_modules';                             Hint = 'npm install' }
  @{ Name = 'VPN host';     Ok = Test-NetConnection 192.168.99.83 -Port 22 -InformationLevel Quiet -WarningAction SilentlyContinue; Hint = 'Turn on the VPN' }
)
$tools | ForEach-Object { '{0,-13} {1,-6} {2}' -f $_.Name, $(if ($_.Ok) { 'OK' } else { 'MISSING' }), $(if (-not $_.Ok) { $_.Hint }) }
```

## 3. Folder structure

```
F:\BATCH-OCBC-PW1\
├─ package.json                # all npm commands — the project's real entry point
├─ playwright.config.js        # testDir './scripts', workers=1, timeout 20 minutes
├─ .env                        # SFTP / SSH / PostgreSQL credentials
├─ run-tests.bat               # install → generate → test → report (one after another)
├─ generate-file.bat           # runs only the generator (hard-codes C:\BATCH-OCBC-PW1)
│
├─ config\
│  └─ test-config.js           # shared config — DO NOT import it from specs or generators
│
├─ scripts\                    # all test logic lives here
│  ├─ logger.js                # winston logger (console + logs\error.log + logs\execution.log)
│  ├─ winscp-handler.js        # class that uploads files over SFTP
│  ├─ putty-handler.js         # class that runs batches through plink, with retries
│  ├─ database_helper.js       # PostgreSQL helpers (getDbConnection, executeDbQuery…)
│  ├─ generate_report.js       # builds the HTML report for the database-verification part
│  ├─ deepseek-test.js         # side script that calls the DeepSeek API, not part of the tests
│  │
│  ├─ OLSDB009\                # one folder = one batch job
│  ├─ OLSDB020\
│  ├─ OLSDB024\
│  ├─ OLSD133R\                # three report folders (OLSD*R): no input file to upload
│  ├─ OLSD134R\
│  ├─ OLSD141R\
│  │  ├─ file-naming.js        # naming rules: input .dat (when there is one) + report .txt
│  │  ├─ file-generator.js     # creates .dat files, or seeds upstream batches for a report
│  │  ├─ test-data.js          # sample data + CONFIG + report sections / column layout
│  │  ├─ data-pool.js          # OLSDB009 only: reads real DB data into a snapshot file
│  │  └─ test-runner.spec.js   # Playwright spec: upload → run batch → verify → save results
│  │
│  └─ test-data\
│     ├─ generated\<BATCH>\tcN\        # generator output = spec input
│     ├─ generated\OLSD134R\seed-push\ # copy of the OLSTXN file uploaded to seed OLSD134R
│     ├─ generated\OLSD141R\seed-cust\ # OLSCUST uploaded for OLSDB012
│     ├─ generated\OLSD141R\seed-merge\# OLSMECIF uploaded for OLSDB057
│     └─ pool\OLSDB009-pool.json       # snapshot of real DB data (OLSDB009)
│
├─ src\                        # .dat files waiting to be uploaded (the LOCAL_PATH target)
├─ reports\                    # test-results.json, junit.xml + reports\<BATCH>\ (report .txt, dashboard.html)
├─ playwright-report\          # Playwright HTML report
├─ test-results\               # failure artifacts (trace / screenshot / video)
└─ logs\                       # logger.js output
```

## 4. The "one job = 4 files" pattern

Every job folder has the same four files. Learn them once and you can read any job folder.

| File | What it does |
|---|---|
| `test-data.js` | Holds `CONFIG` (host, paths, batch command, database), the report sections, the column layout, and the test data |
| `file-naming.js` | Builds and parses file names: seed input (`OLSTXN-…`, `OLSCUST-…`, `OLSMECIF-…`) and the report file |
| `file-generator.js` | The seeding step: create the input, upload it, run the upstream batch, check the data arrived in the database |
| `test-runner.spec.js` | The test itself: run the report batch, download the report, parse it, compare it with the database, save the results |

One difference worth knowing: `OLSDB024`, `OLSDB020` and `OLSDB009` declare `CONFIG` inside their
spec file, but `OLSD134R` and `OLSD141R` keep `CONFIG` in `test-data.js`. The reason is simple —
for a report job both the spec and the generator need the same host, paths and database, so the
config lives in one shared place.

## 5. How a run works

Both jobs work in two phases:

| Phase | What happens | Where the code is |
|---|---|---|
| 1. Seed | Create input files, upload them, run the upstream batches, check the database | `file-generator.js`, called automatically from `test.beforeAll` of the spec |
| 2. Report | Run the report batch, download and parse the report, compare it with the database | `test-runner.spec.js` |

### 5.1 OLSD134R

```
prepareData()  (file-generator.js)
  STEP 0  set ols_schema.batch_date = CURRENT_DATE
  STEP 1  build an OLSTXN file with the OLSDB009 generator, copy it to C:\BATCH-OCBC-PW1\src\
  STEP 2  upload it over SFTP to /apps/MY-dev/OE/cls/USER_INPUT/OLSDB009/
  STEP 3  run ./OLSDB009  (back-end scoring writes rows into DWH_TEMP_TXN)
  STEP 4  wait for the batch to finish
  STEP 5  wait for the output files (.out / .rej / .err)
  STEP 6  check those output files
  STEP 7  read the DWH_TEMP_TXN rows of this file and remember Post_Date
  STEP 8a update oe_cutofftime_control (module_id = 'OLSDR134')
  STEP 8  read last_cutoff_time and current_cutoff_time
  STEP 9  check Post_Date is greater than both cut-off values
        │
        ▼  test.beforeAll of the spec
  STEP 10 run ./OLSDR134
  STEP 11 wait for the report file to appear on the server
  STEP 12 download the report into reports\OLSD134R\
  STEP 13 parse the report and compare every field with the database
  STEP 14 check DWH_TEMP_TXN rows inside the report date range, and all report rows
        │
        ▼
  TC01…TC04, TC06  →  afterAll: dashboard.html + runs\<runId>\run-metadata.json
```

**TC06 is special.** All other tests run against one report. TC06 runs the report a second time:
it sets `last_cutoff_time = batch_date` on purpose, so every seeded row now falls on
`process_date <= last_cutoff_time`, runs `./OLSDR134` again, and asserts those rows are **not**
printed. In `afterAll` the cut-off values are restored to their original values.

### 5.2 OLSD141R

```
prepareData()  (file-generator.js)
  STEP 0  set ols_schema.batch_date = CURRENT_DATE
  STEP 1  generate 15 new CIFs (checked against ols_schema.client so they do not already exist)
  STEP 2  build OLSCUST from the BA sample: recordAction = 'A' plus one detail record per CIF
  STEP 3  upload OLSCUST to /apps/MY-dev/OE/cls/USER_INPUT/OLSDB012/
  STEP 4  run ./OLSDB012
  STEP 5  wait for the output files
  STEP 6  check the 15 CIFs exist in CLIENT (if one is missing the run stops here)
  STEP 7  build OLSMECIF with 8 merge records (7 normal results plus 1 row that gets EB930)
  STEP 8  upload OLSMECIF to /apps/MY-dev/OE/cls/USER_INPUT/OLSDB057/
  STEP 9  run ./OLSDB057
  STEP 10 wait for the output files
  STEP 11 read DWH_TEMP_CIF_MERGE for this run and keep the job_id
        │
        ▼  test.beforeAll of the spec
  STEP 20 run ./OLSDR141
  STEP 21 wait for the report file (glob *OLSD141R*)
  STEP 22 download the report into reports\OLSD141R\
  STEP 23 parse the report (fixed width, 413 characters per line)
  STEP 24 query DWH_TEMP_CIF_MERGE by job_id and compare every field with the report
        │
        ▼
  TC01…TC07  →  dashboard.html + reports\OLSD141R\olsd141r-results.json
```

OLSD141R does **not** use the cut-off time (confirmed with the BA). Which rows belong to one run
is decided by the `job_id` of that `OLSDB057` run, using the query the BA provided
(`EXPECTED_QUERY`).

## 6. Test cases

### 6.1 OLSD134R — `scripts\OLSD134R\test-runner.spec.js`

| Test | What it checks |
|---|---|
| TC01 | Report structure: the title `BATCH REDEMPTION EXCEPTION REPORT` exists, `*** END OF REPORT ***` exists, the parser produced no warnings, and `Report Date` matches the batch date in the database |
| TC02 | `OLSDB009` created rejected rows in `DWH_TEMP_TXN` (`txn_type = '01'` and `error_code IS NOT NULL`) inside the report date range. An empty report is still valid when every row is `<= last_cutoff_time` |
| TC03 | Report versus database, field by field: column mapping, row order and totals, plus the number of `DWH_TEMP_TXN` rows in the report date range |
| TC04 | Negative case: rows that must be excluded (`txn_type = '03'`, or `error_code IS NULL`) do not appear in the report |
| TC06 | Negative case, second run: after the cut-off is lowered, rows with `process_date <= last_cutoff_time` are not printed |

### 6.2 OLSD141R — `scripts\OLSD141R\test-runner.spec.js`

| Test | What it checks |
|---|---|
| TC01 | Report structure: `Report ID`, the title `CIF MERGE FILE REPORT`, and `*** END OF REPORT ***` |
| TC02 | `OLSDB012` created all 15 CIFs used by this merge (read back from `CLIENT`) |
| TC03 | Header lines: `FILE DATE` versus `PROC DATE` versus `File Name` (the OLSMECIF file that was processed) |
| TC04 | Every detail row of the report against `DWH_TEMP_CIF_MERGE`, matched by `job_id` |
| TC05 | `Successful Indicator` (Y / N / Z) and `Unsuccessful Error Description` (Successful / Not Successful / Not Found) are consistent |
| TC06 | Summary lines: accepted and rejected totals match the data |
| TC07 | Row order follows `CIF# A` |

## 7. Configuration

All settings live in `test-data.js` of each job:

| Setting | OLSD134R | OLSD141R |
|---|---|---|
| Report batch | `batch.command = ./OLSDR134` | `batch.command = ./OLSDR141` |
| Seed batches | `./OLSDB009` (see `ADJUSTMENT_SOURCE`) | `./OLSDB012` (`seedCust`) and `./OLSDB057` (`seedMerge`) |
| Report folder on the server | `report.remoteDir = /apps/MY-dev/OE/cls/USER_OUTPUT/OLSD134R` | `.../OLSD141R` |
| How the report file is found | `reportFileGlob()` returns `*OLSD134R<date>*.txt` | `reportFileGlob()` returns `*OLSD141R*` |
| Database | `ols_my` / `ols_schema`, cut-off module `OLSDR134` | `ols_my` / `ols_schema`, no cut-off |

Credentials come from `.env`. `test-data.js` reads that file by hand instead of using `dotenv`,
because loading the whole file would overwrite `BATCH_COMMAND`. The keys used are:
`SFTP_USERNAME`, `SFTP_PASSWORD`, `SSH_USERNAME`, `SSH_PASSWORD`, `DB_USERNAME`, `DB_PASSWORD`,
`SSH_HOST_KEY`, `WINSCP_PATH`, `PUTTY_PATH`, `LOCAL_PATH`.

Environment variables that only these two jobs use:

| Variable | What it does |
|---|---|
| `OLSD134R_SKIP_PREPARE=1` | Skip the seeding phase and use the data that is already in the database |
| `OLSD134R_SKIP_BATCH=1` | Do not run `./OLSDR134` again; use the report already on the server |
| `OLSD134R_RUN_ID` | Use a fixed run id instead of a timestamp |
| `OLSD134R_FILE_SOURCE` | Source segment in the `OLSTXN` file name. Default `OLS`. A wrong value is rejected by the batch |
| `OLSD134R_TXN_TYPE_REPORT`, `OLSD134R_TXN_TYPE_FILE`, `OLSD134R_RECEIVING_SYSTEM` | Override `txn_type` of the file and of the report (default `01`), and the receiving system (default `OLS`) |
| `OLSD141R_SKIP_PREPARE=1`, `OLSD141R_SKIP_BATCH=1` | The same two switches for OLSD141R |
| `OLSD141R_JOB_ID` | Verify one specific `job_id` instead of the newest one |
| `OLSD141R_MERGE_STATUSES` | Override the indicator of the merge records, for example `"Y,N,Y,Z"` |
| `OLSD141R_CUST_ACTION` | `recordAction` of the OLSCUST records. Default `A` (add) |
| `OLSD141R_CUST_REMOTE_PATH`, `OLSD141R_MERGE_REMOTE_PATH`, `OLSD141R_REPORT_DIR`, `OLSD141R_CUST_TEMPLATE`, `OLSD141R_MECIF_TEMPLATE` | Override the two input folders, the report folder and the two BA sample files |

One rule that is easy to forget: `plink` is always called with `-batch -hostkey "<SHA256:…>"`.
Without `-hostkey`, plink stops at the prompt `Store key in cache? (y/n)` and hangs forever,
because there is no keyboard input.

## 8. Running the tests

Run every command from the project root. The generators build file paths from `process.cwd()`.

| Task | Command |
|---|---|
| Seed OLSD134R only (runs OLSTXN → OLSDB009 for real) | `node scripts/OLSD134R/file-generator.js` |
| Run the OLSD134R suite | `npx playwright test scripts/OLSD134R/test-runner.spec.js` |
| Seed OLSD141R only (runs OLSCUST → OLSDB012 and OLSMECIF → OLSDB057 for real) | `npm run generate:olsd141r` |
| Run the OLSD141R suite | `npm run test:olsd141r` |
| Run a single test | `npx playwright test scripts/OLSD141R/test-runner.spec.js -g "TC01"` |
| Read structured results | `reports\test-results.json`, `reports\junit.xml`, `test-results\` |

Please remember:

- The spec of each job **runs the seeding phase by itself** in `test.beforeAll`. So running a
  suite uploads files and runs real batches (`OLSDB009`, `OLSDB012`, `OLSDB057`). Use
  `*_SKIP_PREPARE=1` when you only want to re-check a report that already exists.
- `npm run test:all` collects every spec under `scripts` (`testDir: './scripts'`), so it runs
  **all** jobs in the repository, not only these two.
- Keep `workers: 1`. The tests share the `src\` folder, the same server and the same
  `batch_resource` ledger, so parallel runs fight over files and file names.

## 9. Where the results are

| Path | What is inside |
|---|---|
| `reports\OLSD134R\runs\<runId>\` | Snapshot of one run: the report `MYOLSD134R<date>.txt`, the second report of TC06 as `_phase2.txt`, `run-metadata.json` (status, batch date, input file, cut-off values, expected and actual row counts, number of mismatched fields) and the run's `batch-results.json` |
| `reports\OLSD134R\dashboard.html` | Dashboard with steps 0 to 14b and the result of each test |
| `reports\OLSD141R\` | The downloaded report `OLSD141R_01` and `dashboard.html`, which the spec writes |
| `batch-results.json` in the project root | One record per test case, tracked through `.execution-tracker.json` |
| `reports\test-results.json`, `reports\junit.xml`, `playwright-report\` | The Playwright verdict of the most recent run |

Notes: `reports\test-results.json` and `reports\junit.xml` only hold the **latest** run, because
Playwright overwrites them. Historical results live in `reports\OLSD134R\runs\<runId>\` for
OLSD134R. In `reports\OLSD141R\` you may also see hand-made files from earlier sessions
(`olsd141r-results.json` is Playwright JSON output, and the `*.backup-*.json` files are database
snapshots) — those are not written by the spec. All of these folders are in `.gitignore`, so copy
anything you need as evidence somewhere else; do not commit it.

## 10. Business rules verified on dev

Both jobs:

- A successful WinSCP upload does **not** mean plink trusts the host. The host key cache is stored
  separately in the Windows registry, which is why `-hostkey` is always passed.
- A batch is a Java job. The timeout per batch run is 600 seconds to allow the JVM to start, and
  the suite timeout is 20 minutes.
- The parser reads the report using the fixed-width `COLUMN_LAYOUT`. If the printed column widths
  change, it falls back to token-based parsing and logs a warning. When the layout changes, update
  `COLUMN_LAYOUT` instead of trusting the fallback.

OLSD134R:

- The report only prints `dwh_temp_txn` rows with `txn_type = '01'` **and**
  `error_code IS NOT NULL`, inside the window `process_date > last_cutoff_time` and
  `<= batch date`. The cut-off module id is `OLSDR134`.
- The 2026 output is wider than the 2020 specification layout (212 characters instead of 171), so
  the column positions in `test-data.js` were measured again from a real file. Do not reuse the old
  offsets from the specification.
- The 2026 build prints `Report Date: ddmmyyyy`; the 2020 build prints `BATCH DATE: yyyymmdd`.
  The spec accepts both.
- An empty report is valid business behaviour when every row is `<= last_cutoff_time`. The 2026
  build prints neither the section title nor the column header when a section is empty.
- The seeded file deliberately contains several kinds of rows: good rows, rows rejected with
  `BE108` (product account does not exist), `BE632` (product account type does not exist) and
  `BE654` (no campaign hit), plus two negative rows for TC04 / TC05 — one with `txn_type = '03'`
  and an error code, and one with `txn_type = '01'` and no error code.
- The `OLSTXN` file must carry a valid source (`OLS`). Using `D134R` makes the batch reject the
  file with *"The Source System in the file name does not exist in OLS system"*.

OLSD141R:

- No cut-off time is used. The expected rows are selected by the `job_id` of the `OLSDB057` run.
- `OLSDB012` creates 15 CIFs, and the 8 merge records travel in **one** OLSMECIF file (header,
  8 detail records, trailer). The last record uses CIF14 as source right after CIF14 became a
  target of the previous record, so the batch answers `EB930 "Source cif is processing"` — that is
  the rejected line of the report.
- OLS **ignores** the indicator and description on input (interface spec 2.12). The report prints
  what the batch calculated, so compare it with `DWH_TEMP_CIF_MERGE`, never with the input file.
- Indicator and description: `Y = Successful`, `N = Not Successful`, `Z = Not Found`.
- Each report line is 413 characters wide. The printed layout also shows `Error Code` and
  `Error Description`, which are not part of the original field definition.
- The input files are cloned from the BA samples and only a few cells are patched (OLSCUST:
  `recordAction`, `custCifNbr`, `createDate`, `fileNumber`, `recordCount`; OLSMECIF: the two CIFs
  and the indicator). This keeps the layout identical to the samples, byte for byte.

## 11. Troubleshooting

| Symptom | Usual cause |
|---|---|
| `plink` hangs and never returns | `-batch` or `-hostkey` is missing, or the host key changed. Check `SSH_HOST_KEY` |
| `The system cannot find the path specified` | `plink.exe` is not installed (WinSCP does not ship it) or `PUTTY_PATH` is wrong |
| `Batch command did not run…` | `batch.scriptPath` or `batch.command` is wrong, or the batch script is missing on the server |
| Batch exits with code 20 and no `.out` file | The file name already exists in `batch_resource` (`BE051`). The generator must pick a new sequence |
| `The Source System in the file name does not exist` | The source inside the `OLSTXN` name is invalid. Use `OLS` (`OLSD134R_FILE_SOURCE`) |
| `File generator failed…` or seeding stops halfway | The database `192.168.99.83` / `ols_my` is unreachable, or `OLSDB012` did not create all 15 CIFs |
| OLSD141R generator cannot find a template | `F:\OCBC\OLSCUST-*.dat` or `F:\OCBC\OLSMECIF-*.dat` is missing. Fix `CONFIG.templates` |
| No report appears in `reports\<BATCH>\` | Either the seeding phase or the report batch produced no file. Re-run with `SKIP_PREPARE` or `SKIP_BATCH` to find out which one |
| The report is missing rows or has extra rows | The time window is off (`oe_cutofftime_control` for `OLSDR134`), or the wrong `job_id` was used (OLSD141R) |
| The parser logs a column warning | The printed column widths changed. Update `COLUMN_LAYOUT` from a real report file |
| The upload through WinSCP fails | Wrong host or remote path, or the VPN is not connected |

## 12. Open items

- OLSD134R currently has TC01, TC02, TC03, TC04 and TC06 only. The negative fixture called
  "TC05" (`txn_type = '01'` with no `error_code`) is still generated and is verified inside TC04.
- Some old comments still say "7 CIF" or "4 merge records" (including step 7 of the OLSD141R
  dashboard label), while the running values are `CIF_COUNT = 15` and 8 merge records. When you
  touch those comments or labels, update them to match the code.
- Two questions are still open with the dev team: the official source of `job_id`
  (`scripts\OLSD134R\file-generator.js`), and the dev input folders of `OLSDB012` and `OLSDB057`
  (`scripts\OLSD141R\test-data.js`).
- `OLSD133R` (Point Adjustment Exception Report) belongs to the same report group and follows the
  same four-file pattern. It is not covered by this document yet; if you need it, add it as a new
  section.
