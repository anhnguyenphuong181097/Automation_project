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

## 13. OLSDB028 — Item Redemption export (`OLSITRED.dat`)

`OLSDB028` is not a report: it is an **export** batch (`redeemItemExportJob`) that reads the
fulfillment records the Item Redemption API already stored in the database and writes
`OLSITRED.dat` for the receiving system `CLK`.

| Item | Value |
|---|---|
| Batch command | `/apps/MY-dev/scripts/OLSDB028` (`./OLSDB028`) |
| Output | `/apps/MY-dev/OE/cls/USER_OUTPUT/OLSDB028/OLSITRED.dat` |
| Source data | `ols_schema.item_fulfilment_status` + `item_fulfilment_status_his` |
| Cut-off module | `oe_cutofftime_control.module_id = 'OLSDB028'` |
| Files | `scripts\OLSDB028\{test-data.js, file-naming.js, file-generator.js, test-runner.spec.js}` + `api-data\OL59-itemRedeem.json` |
| Test cases | TC01 structure, TC02 header, TC03 detail vs DB, TC04 cut-off control, TC05 extraction window, TC06 trailer |

How one run works:

```
0  read batch_date + oe_cutofftime_control (before)
0b call the Item Redemption API (OL59) once per case of api-data\OL59-itemRedeem.json
   -> capture itmRdmRefNbr, ITEM_FULFILMENT_STATUS.REFERENCE_NO / EXTRACTED_DATE_TIME
1  ./OLSDB028
2  wait for a fresh OLSITRED* file
3  download it to reports\OLSDB028\ (WinSCP, binary)
4  parse HD / FN / DT / TR
5  expected rows = the BA query (grouped) over last_cutoff_time < extracted_date_time <= current_cutoff_time
6  verify header / detail (matched by itmRdmReferenceNo) / trailer hashes / cut-off control
```

The file is a "fixed pipe delimiter" file: an `HD` record, the `FN|DT` / `FN|TR` field-name
records, one `DT` record per extracted fulfillment row and a `TR` record whose last three numbers
are the rightmost 10 digits of the sum of the card numbers, the points and the quantity.

`EXPECTED_QUERY` in `test-data.js` is the query the BA provided, kept verbatim (only the two
timestamps are parameters, in `DD-MM-YYYY HH24:MI:SS`). Two things follow from it:

* It is **grouped**, so one result row = one `DT` record: `quantity = COUNT(*)` and
  `redeemed_point = SUM(redeemed_point) * 100` (already the printed value). Group key:
  `transaction_date`(day), `extracted_date_time`(day), `pool_id`, `item_code`, `item_name`,
  `fulfillment_status`, `description`, `card_no`, `reference_no`, `last_approve_by`, `temp_column`
  (`MAIN` = `item_fulfilment_status`, `HIS` = `item_fulfilment_status_his`), `supplier_id`.
* Its filters are the business rules: `status = 'A'` on `item_fulfilment_status`, `status = 'I'`
  on `item_fulfilment_status_his`, `last_update_by NOT LIKE '%OLSRB%'` (records touched by the
  `OLSRB028` unwind are excluded) and an `INNER JOIN cat_catalogue_trans_details` (status `'A'`),
  which is also where `itmRdmUserId` (`last_approve_by`) and the fulfilment
  description (`fulfillment_status.description`) come from.

Run it:

```powershell
npm run test:olsdb028            # whole suite (runs the real batch)
npm run generate:olsdb028        # only prepare the input data through OL59
npx playwright test scripts/OLSDB028/test-runner.spec.js -g "TC01"
```

### Input data — Item Redemption API (OL59)

The input of OLSDB028 is not a file: it is the fulfillment data the Item Redemption API creates.
`file-generator.js` plays that role and is **data driven** — the payload is not hard-coded, it
comes from [scripts\OLSDB028\api-data\OL59-itemRedeem.json](scripts/OLSDB028/api-data/OL59-itemRedeem.json)
(baseline template + one entry per redemption). To add a redemption, add a case to that file only.

The data file supports placeholders resolved at execution time (`{{timestamp}}` in `yyyyMMdd HHmmss`,
`{{messageNum}}` unique per request, `{{msgSqNum}}`, `{{runId}}`, `{{todayYmd}}`, `{{nowIso}}`), and
a case may compute the price fields from `unitPriceInPoints` + `quantity` instead of spelling out
`itmRdmFullPriceInPoints` / `itmRdmPoolUnitsRequired` / `itmRdmQuantityItem`.

Rules verified against the dev API (29/09/2026):

* Success is the **business** code `OLSRs.ReturnCode = "00000"`; the gateway answers HTTP 200 even
  for failures. The redemption reference is `itemRedeem.itmRdmRefNbr` and it is what lands in
  `item_fulfilment_status.reference_no`.
* **Price.** The unit price is **taken from `item_price`**, not written in the data file: the active
  price row of the item is selected by `itmRdmRewardCurrency` (or `poolId` / `priceId` of the case),
  and the request sends `itmRdmFullPriceInPoints = itmRdmPoolUnitsRequired = price_in_point × quantity`
  (`{{channelId}}` is filled from the same row, normalised from `redemption_channel` /
  `redemption_channel_arr`, `[MB]` -> `MB`). Error codes seen while probing on dev:
  `E5918 "Incorrect full price in points"` (total ≠ unit price × quantity),
  `E5903 "Pool Units + Cash Required do not match Item Price"`,
  `E5921 "Item Price not found"` (channel the item is not priced for). Because of that, `UG7814`
  has `ENQ1/0VN/12` for `MB` and `HT4/3CC/119` — and `HT4` expired on 31/07/2026.
* **MA (point transfer) - recipe verified on dev 30/09/2026 (ref `58187457`, `MA-ITER` case).**
  `ITER` (`item_price.price_in_point = 10.00`, pool `ENQ1` / `0VN`) is redeemed with
  `SvcRq.ChannelId = INB`, `OLSRq.Region = ID`, `itmRdmFullPriceInPoints = itmRdmPoolUnitsRequired =
  1000` (= 10.00 × quantity 100), **`itmRdmQuantityItem = "100"` but `itmRdmReceiveQuantity =
  "1000"`** (for this item type the receive quantity is the full price, not the quantity), plus the
  three receiving fields (`itmRdmReceivingAcctOrId = 335221784`, `...FirstName = Enrich`,
  `...LastName = Blue Partner`). Leaving `itmRdmReceivingFirstName` empty is rejected with
  `E0006 "The itmRdmReceivingFirstName field is required"`. With quantity 1 the API answers
  `E5918`, so the case keeps quantity 100.
* **TL (`ITTL1`, Traveloka) is BLOCKED by the dev build - do not retry blindly.** The OL59 spec and
  the live `OL57` enquiry give `itmEnqPriceInPoints = 10000` (`itmEnqItemValue = 10000`,
  `itmEnqIncrBlkSize / itmEnqIncrPricePerBlk = null`, `itmEnqMinQty = 100`), so the spec-correct
  request is `itmRdmQuantityItem = "100"` (= 1.00 with the ×100 rule of the 9(14,2) fields),
  `itmRdmReceiveQuantity = "10000"`, `itmRdmFullPriceInPoints = itmRdmPoolUnitsRequired = 10000`.
  That payload passes the quantity and price checks but the API then answers
  `TL-BAD_REQUEST "Invalid request body"` (the BA reported the same when running it).
  More than 15 variants were tried (quantity `1/100/1.00/100.00`, receive `1/100/1000/10000/1000000`,
  price `100/1000/10000/1000000`, channel `INB`/`MB`, extra `itmRdmAcctNum`/`itmRdmFullName`).
  Everything else returns `E5917` (quantity) or `E5918` (price), which the formulas explain.
  A TL redemption does exist in the database (ref `58206452`, 01/10/2026 08:06, `last_update_by
  OL59`), so the dev build accepts some payload - it just has not been identified yet.
* **PI (donation) - recipe verified on dev 01/10/2026 (refs `58211449`, `58212449`, case `PI-APZ3K`).**
  `APZ3K` (`item_price` `ENQ1` / `0VN` / `2.00`, `partial_redeem = true`) is redeemed with
  `itmRdmCatalogue = ACATA`, `itmRdmFullPriceInPoints = itmRdmPoolUnitsRequired = 200`
  (= 2.00 × quantity 100), `itmRdmQuantityItem = itmRdmReceiveQuantity = "100"` and the same
  receiving fields as the MA case. The channel is discovered per price row (this row lists
  `[BATCH, INB, MB]`, and the run used `BATCH`).
* **Quantity.** The service enforces a minimum that no table carries: on dev `UG7814` rejected
  quantity 1/2/3/5/10/20/50 with `E5908 "Item Quantity is below minimum required"` and accepted 100
  (probed 29/09/2026). The generator therefore (a) checks the quantity against the columns it can
  read - `max_qty_allow_per_item_per_txn` is a hard check, the stock
  (`qty_on_hand - qty_reserved - qty_redeem`) is only a **warning** because the API accepted
  quantity 100 while only 46 units were "available" - and (b) on `E5908` retries with the next value
  of `OLSDB028_MIN_QTY_CANDIDATES` (price recomputed), reporting the minimum that worked.
* **ChannelId / Region are discovered at run time.** The dev environment changed its Region
  configuration during 29/09/2026: `MB + MY` worked at 16:06 and answered `E0003 "Invalid Region"`
  one hour later, while `MB + ID` was accepted. The generator therefore probes the candidate pairs
  with an **impossible price** (so no redemption can be created) and keeps the first pair the API
  accepts (`E5918`/`E5903` = valid and priced; `E5921`/`E5908` = valid fallback). Override with
  `OLSDB028_CHANNEL`, `OLSDB028_REGION`, `OLSDB028_REGIONS`.
* **Region pre-flight (step 0a).** Before any redemption is created, `preflightRegion()` probes the
  API and compares the region the service accepts with the region this environment must serve
  (`CONFIG.itemRedemptionApi.expectedRegion`, default `MY` - dev-my / `ols_my` / the BA payloads).
  A mismatch **fails the suite immediately** with both values and the probe trail, because the fix
  belongs to the API/deployment configuration (region of `ols-one-channels`, and
  `app_param.site_country_code` which is currently `ID` in the database), **not** to the payload:

  ```
  REGION MISMATCH: API accepts "ID" but the environment expects "MY". Probes: MB/MY=E0003, MB/ID=E5918
  ```

  `OLSDB028_EXPECTED_REGION` changes the expectation, `OLSDB028_ALLOW_REGION_MISMATCH=1` downgrades
  it to a warning.
* `E5903` = "Pool Units + Cash Required do not match Item Price" (send `unit price × quantity`),
  `E5908` = "Item Quantity is below minimum required" (`UG7814` needs quantity >= 100).
* The API itself also inserts the `cat_catalogue_trans_details` row (`status 'A'`, `last_approve_by
  = 'OL59'`) that the BA query joins on, so no extra step is needed before running the batch.
* **Statement output pool (SOPC).** `file-generator.js` also checks, per redemption, that the
  redeemed pool is configured for statement output - i.e. that OLSDB028 would really statement it:

  | Check | Rule |
  |---|---|
  | pool configured | `statement_output_pool.pool_id` = `item_fulfilment_status.pool_id` |
  | still effective | `status = 'A'` and `pool_start_date <= now <= pool_end_date` (`end_date` is never null) |
  | account level | `item_fulfilment_status.product_account_level` (PAL) must be one of the levels listed in `product_account_level` of that pool, e.g. `[PARTNER, OCR, 802, 500, 501, CCC]` |

  The match key is the **PAL**, not the PAT: every row the 29/09/2026 run exported had its PAL in
  the list while its PAT (`RWD`, `MIG`) was outside it. A failed check throws with the reason
  (pool missing / expired / PAL not listed) - bypass with `OLSDB028_SKIP_SOPC_CHECK=1`.
  Note the OLS documentation: statement output is only for **non-monetary** pools.
* **Fallback when the CIF does not have enough points (`E5922`).** Only a fallback: the OL59 call is
  always attempted first, and the top-up runs only when the answer is `E5922 "Insuffient point
  balance"` (the API message carries that typo; the trigger accepts the code or a message pattern).

  1. `full price in points − redeemable balance` = the **shortfall**; the balance comes from
     `ols_schema.balance_detail_view` for `(csn, pool_id)` (the pool of `item_price`).
  2. The adjustment is one **OLSTXN record with `txnTranType '03'`**, built with the existing
     OLSDB009 generator (`adjustTxn()` / `buildFile()`), so the layout, hashes and file naming stay
     with the code that already owns them.
  3. The account is resolved through **`statement_output_pool`**: the CIF's active
     `product_account` whose `product_account_level` (PAL) is listed for that pool; the adjustment
     reason comes from `reason_code` (`id_level = 'ADJ'`) through `OLSDB009/data-pool.js`.
  4. A free `OLSTXN-OLS-<date>-NN.dat` number is taken from the `batch_resource` ledger, the file is
     uploaded to `/apps/MY-dev/OE/cls/USER_INPUT/OLSDB009/`, `./OLSDB009` runs, the pool balance is
     re-read and the redemption is retried once.

  Switches: `OLSDB028_SKIP_TOPUP=1` (never top up), `OLSDB028_TOPUP_DRYRUN=1` (build the file only),
  `OLSDB028_INSUFFICIENT_CODES` / `OLSDB028_INSUFFICIENT_PATTERN`, `OLSDB028_ADJ_REASON_INDEX`,
  `OLSDB028_ADJ_REMOTE_PATH`.

  Verified in dry-run on 01/10/2026: balance lookup, account resolution (`80000003641`,
  `OCR/MIG`, PAL in the ENQ1 list) and the generated record
  `DT|03||BATCH|002222300006877|80000003641|MIG|OCR||MYR|...|ENQ1|123|SGD|...` (+1000 points,
  reason 123, `recordCount 000000005`). The upload + batch run path has not been exercised yet -
  the test CIF has ~80 M redeemable points in ENQ1, so the fallback never triggers for it.
* **CIF / account rule.** The CIF of a redemption is its `csn` and its accounts are the rows of
  `ols_schema.product_account` with that `csn`. The generator checks that the redeemed account
  (`item_fulfilment_status.product_account_no`) belongs to that CIF **and** carries the product
  (`product_account_level` = PAL) and brand (`product_account_type` = PAT) of the transaction, all
  with `status = 'A'`. On the 29/09/2026 run all 14 exported rows satisfied it (14/14 for each of
  the three sub-checks), so the strongest form is asserted; a failure throws and lists the CIF's
  active accounts - bypass with `OLSDB028_SKIP_ACCOUNT_CHECK=1`.
* No Bearer token is required; the dev gateway serves a self-signed certificate, which is why the
  generator disables TLS verification unless `OLSDB028_INSECURE_TLS=0`.

Environment switches (all optional):

| Variable | What it does |
|---|---|
| `OLSDB028_SKIP_BATCH=1` | do not rerun the batch; verify the OLSITRED file already on the server |
| `OLSDB028_WINDOW_START="YYYY-MM-DD HH24:MI:SS"` | before the run, force `last_cutoff_time = current_cutoff_time` to that timestamp, so the export stays small on the shared dev database. The batch then advances the row normally, exactly like a run at that time |
| `OLSDB028_WINDOW_FROM` / `OLSDB028_WINDOW_TO` | override the cut-off window passed to the BA query (useful to re-verify a file that is already on disk) |
| `OLSDB028_LOCAL_FILE=...` | verify an `OLSITRED` file already on disk (no SSH, no download) |
| `OLSDB028_OFFLINE=1` | with `OLSDB028_LOCAL_FILE`: no SSH and no database at all (`OLSDB028_BATCH_DATE` supplies the expected header date); only TC01/TC02 are meaningful |
| `OLSDB028_OUTPUT_DIR`, `OLSDB028_FILE_NAME` | override the remote folder / the expected file name |
| `OLSDB028_SKIP_PREPARE=1` | do not call the Item Redemption API; use the fulfillment data already in the database |
| `OLSDB028_API_DATA=...` | use another input data file instead of `api-data\OL59-itemRedeem.json` |
| `OLSDB028_API_URL=...`, `OLSDB028_API_TIMEOUT_MS=...`, `OLSDB028_INSECURE_TLS=0` | endpoint / timeout / refuse the dev self-signed certificate |
| `OLSDB028_RUN_ID=...` | fixed run id (used in `itmRdmRemarks` through `{{runId}}`) |
| `OLSDB028_SKIP_SOPC_CHECK=1` | do not fail when the pool is not configured for statement output (SOPC) |
| `OLSDB028_SKIP_ACCOUNT_CHECK=1` | do not fail when the CIF does not own the redeemed account / product / brand |
| `OLSDB028_CHANNEL`, `OLSDB028_REGION`, `OLSDB028_REGIONS` | pin the channel and/or region instead of probing the environment |
| `OLSDB028_EXPECTED_REGION` (default `MY`), `OLSDB028_ALLOW_REGION_MISMATCH=1` | region the environment must serve / downgrade the pre-flight mismatch to a warning |
| `OLSDB028_MIN_QTY_CANDIDATES` (default `100,150,200,500`), `OLSDB028_AUTO_MIN_QTY=0` | quantities to retry with when the API answers `E5908`; `0` disables the retry |
| `OLSDB028_SKIP_TOPUP=1`, `OLSDB028_TOPUP_DRYRUN=1` | never create the `E5922` adjustment / only build the OLSTXN file without uploading or running the batch |
| `OLSDB028_INSUFFICIENT_CODES`, `OLSDB028_INSUFFICIENT_PATTERN`, `OLSDB028_ADJ_REASON_INDEX`, `OLSDB028_ADJ_REMOTE_PATH` | override the `E5922` trigger, the adjustment reason index and the OLSDB009 input folder |

### Verified against a real run (dev, 29/09/2026)

`OLSITRED.dat` (4 716 075 bytes, 58 013 lines) was produced by the dev batch and verified with
`OLSDB028_SKIP_BATCH=1 OLSDB028_WINDOW_FROM="2026-04-23 17:49:24" OLSDB028_WINDOW_TO="2026-09-29 11:37:12"`:
TC01, TC02, TC03 and TC05 **pass**, TC04 is skipped (the spec did not run the batch itself).

Facts learned from that file (they override what the sheet/spec sheet implies):

* Header: `HD|OLSITRED|CLK|20260927|20260929|01` - `fileId` / `receivingSystem` are **not padded**
  inside the pipe cell, `fileNumber` is `01` (the sheet declares `9(04)`).
* `FN|DT` names the columns `filler`, `itmPartnercode` and `itmRdmFulfillmentStatusDesc`
  (lower/other case, shorter name), so the field-name check is case-insensitive.
* A `DT` record has 15 cells: `recordTag`, date, reference, card, pool, `filler` (always spaces),
  `itmPartnercode` (empty when `item_fulfilment_status.supplier_id` is null - the normal case on
  dev), item code, item description, points (already `* 100`), quantity, status, status
  description, status update date, user id. There is **no** second filler cell.
* `batch.OLSDB028.item.type` in the properties file is **not** the export filter: the run exported
  21 rows of item types `ER` / `MA`, outside that list.

`recordCount` counts **every** record of the file, the two `FN` definition records included:
verified twice, 17 `DT` -> `21` and 2 `DT` -> `6`, i.e. `N + 4` (HD + FN|DT + FN|TR + N DT + TR).
The whole end-to-end run of 29/09/2026 16:04-16:06 (17 and 2 details, produced by two fresh OL59
redemptions) passed TC01, TC02, TC03, TC04, TC05 and TC06.

**Anomaly of the 11:48 file** (kept as evidence, not reproducible with the file that replaced it):
that earlier run wrote 58 009 `DT` records but a trailer of only `57 965` records, with
`hash(itmRdmCardNumber) = 0000000000` and the points/quantity hashes 374 246 / 86 below the values
computed from its own details. Either the file was written by two processes or the trailer was
built from a smaller set than the one written. Worth a question to the dev team.

Known gaps (report them, do not silently guess):

1. `itmRdmStatusUpdateDate` (TC_01_27) is **not** part of the BA query. The spec therefore selects
   `MIN(fulfill_status_update_date)` only as a *soft* check: a difference is logged and shown on
   the dashboard but does not fail TC03. Confirm the real source with the BA before making it hard.
2. `reference_no` is `varchar(20)` in the database while the sheet declares `X(15)`.
3. `OLSDB028_WINDOW_START` is only used before a run of the spec; on a shared dev database the
   window can still be large if other users keep creating redemptions. Use
   `OLSDB028_WINDOW_FROM` / `OLSDB028_WINDOW_TO`, for a small, reviewable run.
4. `file-generator.js` calls OL59 sequentially and never inserts into `item_fulfilment_status`
   itself (AGENTS.md rule: the API is the only way to create that data).
