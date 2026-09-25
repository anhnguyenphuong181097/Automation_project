# BATCH-OCBC-PW1 — OLS Batch Test Automation (OCBC)

Automation test cho batch EOD của hệ thống **OLS (OCBC)**. Playwright được dùng như
*test runner* (assertion, tag, retry, report HTML/JSON/JUnit) — không phải để test UI.
Ba hệ thống ngoài tham gia vào mỗi lượt chạy:

| Thành phần | Vai trò | Công cụ |
|---|---|---|
| File input `.dat` | Dữ liệu đầu vào cho batch | sinh bởi `file-generator.js` |
| SFTP server | Nhận file input, trả file output | WinSCP |
| Batch server | Chạy job Java của từng batch | PuTTY `plink` (SSH) |
| PostgreSQL | Bảng thật để đối chiếu kết quả | driver `pg` |

---

## 1. Project này làm gì

Mỗi test case mô phỏng trọn vẹn một lượt chạy batch thật:

1. Sinh file input `.dat` đúng format quy định (gồm cả file hợp lệ và file cố tình sai).
2. Copy file vào thư mục local `src\`.
3. Upload lên server bằng SFTP.
4. SSH vào server chạy script batch.
5. Đọc file kết quả `.out` / `.rej` / `.err` do batch sinh ra.
6. Query PostgreSQL để kiểm tra record được insert / bị từ chối.
7. Ghi kết quả vào `batch-results.json` để phục vụ dashboard và report.

## 2. Yêu cầu môi trường

- Windows (project viết cho Windows + PowerShell, nhiều script dùng đường dẫn `C:\...`).
- Node.js 20+ (đang chạy Node 26). Dự án dùng ESM (`"type": "module"`) → **không dùng `require()`**.
- WinSCP: `C:\Program Files (x86)\WinSCP\WinSCP.com`
- PuTTY: `C:\Program Files\PuTTY\plink.exe`
- Kết nối được tới dải `192.168.99.x` (VPN) và tới PostgreSQL `5432`.

```powershell
cd F:\BATCH-OCBC-PW1
npm install
```

Sau khi cài, chạy mục 3 để xác nhận máy đã đủ công cụ trước khi test.

## 3. Kiểm tra công cụ trước khi chạy (pre-flight)

Chạy khối này trong PowerShell tại thư mục gốc project trước mỗi buổi test. Đoạn dưới chỉ
đọc trạng thái máy, không gọi ra server:

```powershell
$tools = @(
  @{ Name = 'Node.js';      Ok = [bool](Get-Command node -ErrorAction SilentlyContinue); Hint = 'Cài Node.js 20+' }
  @{ Name = 'WinSCP.com';   Ok = Test-Path 'C:\Program Files (x86)\WinSCP\WinSCP.com';   Hint = 'Cài WinSCP hoặc sửa CONFIG.winscp.path' }
  @{ Name = 'plink.exe';    Ok = Test-Path 'C:\Program Files\PuTTY\plink.exe';           Hint = 'winget install --id PuTTY.PuTTY' }
  @{ Name = 'node_modules'; Ok = Test-Path '.\node_modules';                             Hint = 'npm install' }
)
$tools | ForEach-Object {
  '{0,-13} {1,-6} {2}' -f $_.Name, $(if ($_.Ok) { 'OK' } else { 'THIEU' }), $(if (-not $_.Ok) { $_.Hint })
}
```

Kiểm tra kết nối tới server (mỗi host mất vài giây; chọn hàng theo batch sắp chạy):

```powershell
foreach ($t in @(
  @{ H = '192.168.99.89'; P = 22 },    # OLSDB024 — SFTP/SSH
  @{ H = '192.168.99.83'; P = 22 },    # OLSDB009, OLSDB020 — SFTP/SSH
  @{ H = '192.168.99.89'; P = 5432 },  # PostgreSQL (SG)
  @{ H = '192.168.99.83'; P = 5432 }   # PostgreSQL (MY)
)) {
  $ok = Test-NetConnection $t.H -Port $t.P -InformationLevel Quiet -WarningAction SilentlyContinue
  '{0}:{1}  {2}' -f $t.H, $t.P, $(if ($ok) { 'OK' } else { 'KHONG KET NOI DUOC — kiem tra VPN' })
}
```

Kiểm tra `plink` thật sự SSH được (thay `<password>` bằng giá trị trong `.env`):

```powershell
& 'C:\Program Files\PuTTY\plink.exe' -batch `
  -hostkey "SHA256:kGbLBMkLSnBoYmLg10qgHfmQmtUbawS69GYysVLkXu4" `
  -ssh root@192.168.99.83 -pw "<password>" "echo PLINK_OK"
```

| Kết quả | Nghĩa |
|---|---|
| In ra `PLINK_OK` | plink + host key + VPN đều ổn |
| `The system cannot find the path specified` | `plink.exe` chưa được cài, hoặc `CONFIG.putty.path` sai |
| Treo không trả về | host key không khớp `-hostkey`, hoặc lệnh gọi thiếu `-batch` |
| `Connection timed out` | chưa nối VPN / sai host |

Hai lỗi cấu hình hay gặp khi máy thiếu công cụ:

- **Thiếu `plink.exe`** → mọi batch fail. OLSDB009 báo rõ
  (`Batch command did not run… The system cannot find the path specified`), nhưng OLSDB024
  **im lặng**: `executeBatch()` của OLSDB024 bọc `catch` và luôn trả `success: true`, nên
  test chỉ fail muộn ở bước verify với thông báo "no files found" — trông như lỗi batch.
  Cài PuTTY (`winget install --id PuTTY.PuTTY`) để `plink.exe` nằm đúng
  `C:\Program Files\PuTTY\`.
- **WinSCP không thay thế được PuTTY.** WinSCP có kèm thư mục riêng
  `C:\Program Files (x86)\WinSCP\PuTTY\` nhưng trong đó chỉ có `pageant.exe` và
  `puttygen.exe`, **không có `plink.exe`**. WinSCP dùng cho upload SFTP, còn chạy batch
  trên server vẫn phải có PuTTY.

VS Code không cần cài thêm gì cho PuTTY — nó chỉ là chương trình ngoài mà code Node gọi
qua `child_process`. Tuỳ chọn: extension **Playwright Test for VSCode** để chạy/debug từng
test trong Test Explorer (hữu ích vì suite rất chậm), và extension SSH nếu muốn xem file
`.out` / `.rej` trên server (dùng OpenSSH có sẵn của Windows, không cần PuTTY).

## 4. Cấu trúc thư mục

```
F:\BATCH-OCBC-PW1\
├─ package.json                # toàn bộ lệnh npm — entry point thật của project
├─ playwright.config.js        # testDir './scripts', workers=1, timeout 20 phút
├─ .env                        # host/user/password cho SFTP, SSH, PostgreSQL
├─ run-tests.bat               # install → generate → test → report (tuần tự)
├─ generate-file.bat           # chỉ chạy generator (hard-code C:\BATCH-OCBC-PW1)
│
├─ config\
│  └─ test-config.js           # config dùng chung (xem cảnh báo ở mục 10)
│
├─ scripts\                    # toàn bộ logic nằm ở đây
│  ├─ logger.js                # winston logger (console + logs\error.log + logs\execution.log)
│  ├─ winscp-handler.js        # class upload file qua SFTP
│  ├─ putty-handler.js         # class chạy lệnh batch qua plink, có retry
│  ├─ database_helper.js       # helper PostgreSQL (getDbConnection, executeDbQuery…)
│  ├─ generate_report.js       # xuất report HTML cho phần verify DB
│  ├─ deepseek-test.js         # script phụ gọi API DeepSeek, không thuộc luồng test
│  │
│  ├─ OLSDB009\                # 1 folder = 1 batch job
│  ├─ OLSDB020\
│  ├─ OLSDB024\
│  │  ├─ file-naming.js        # quy ước tên file: prefix / date / sequence
│  │  ├─ file-generator.js     # sinh nội dung .dat cho từng test case
│  │  ├─ test-data.js          # dữ liệu & định nghĩa ca test (OLSDB009 không có)
│  │  └─ test-runner.spec.js   # spec Playwright: upload → chạy batch → verify → ghi kết quả
│  │
│  └─ test-data\
│     ├─ generated\<BATCH>\tcN\   # output của generator = input của spec
│     └─ pool\OLSDB009-pool.json  # snapshot dữ liệu thật lấy từ DB (OLSDB009)
│
├─ src\                        # file .dat đang chờ upload (đích của LOCAL_PATH)
├─ reports\                    # test-results.json, junit.xml
├─ playwright-report\          # report HTML của Playwright
├─ test-results\               # artifact lỗi (trace/screenshot/video)
└─ logs\                       # log của logger.js
```

## 5. Các batch job

| Job | Nghiệp vụ | File input | Máy đích | Test case |
|---|---|---|---|---|
| **OLSDB024** | Terminal / EFT POS | `OLSTERM-YYYYMMDD-NN.dat` | `192.168.99.89`, DB `ols_sg_auto`, `/apps/SG-auto/scripts` | **13 TC active**: TC1, TC2, TC3, TC4A–4D, TC6A, TC7A–7C, TC8A–8B, TC9A–9B |
| **OLSDB020** | Merchant Category Code | `OLSMCC-YYYYMMDD-NN.dat` | `192.168.99.83`, DB `ols_my`, `/apps/MY-dev/scripts` | Chỉ **TC4A** active, các TC khác đang comment |
| **OLSDB009** | Transaction Adjustment | `OLSTXN-OLS-YYYYMMDD-NN.dat` | `192.168.99.83`, DB `ols_my` | **TC01** |

Ghi chú:

- `OLSDB024` là bộ đầy đủ nhất và là **template** khi thêm job mới.
- `OLSDB020` và `OLSDB024` có `file-naming.js` và `test-data.js` giống nhau từng byte
  (OLSDB024 được nhân bản từ OLSDB020 rồi mở rộng spec).
- `OLSDB020` là job duy nhất generator **cần DB** (để chọn MCC code mới và sequence number
  chưa dùng). `OLSDB024` sinh file hoàn toàn offline từ `test-data.js`.
- `OLSDB009` có thêm `data-pool.js`: lấy dữ liệu thật (CIF / account / card / terminal /
  transaction code) từ DB, lưu snapshot JSON, các lần sau đọc lại snapshot.

## 6. Quy ước "1 job = 4 file"

Muốn thêm batch mới: copy một folder job có sẵn (khuyến nghị `OLSDB024`), rồi sửa:

| File | Trách nhiệm |
|---|---|
| `file-naming.js` | Sinh / parse / validate tên file theo prefix + date + sequence |
| `file-generator.js` | Sinh nội dung `.dat` cho từng test case (valid + các loại defect) |
| `test-data.js` | Hằng số, dữ liệu mẫu, danh sách ca test |
| `test-runner.spec.js` | Khối `CONFIG` đầu file (host, remotePath, batch command, DB) + các `test()` |

Sau đó thêm lệnh npm vào `package.json`, ví dụ:

```json
"generate:olsdb0xx": "node scripts/OLSDB0XX/file-generator.js",
"test:olsdb0xx": "npx playwright test scripts/OLSDB0XX/test-runner.spec.js"
```

## 7. Luồng chạy một test case

```
npm run generate:olsdb024
        │
        ▼
scripts\test-data\generated\OLSDB024\tcN\*.dat
        │  copyFilesToLocal(tcId)              — dọn src\ rồi copy sang
        ▼
C:\BATCH-OCBC-PW1\src\*.dat
        │  assertFileNamesAreUnused()          — chặn trước lỗi BE051
        │  uploadFiles()                       — WinSCP SFTP
        ▼
root@<host>:<remotePath>/                     — thư mục input của batch
        │  executeBatch()                      — plink: cd <scriptPath> && ./OLSDB024
        ▼
<OLSTERM-...>.out / .rej / OLSDB024_*.err     — output của batch
        │  verifyResults() + verifyMccInDatabase()
        ▼
batch-results.json → reports\test-results.json, junit.xml, playwright-report\
```

Chi tiết đáng lưu ý trong `test-runner.spec.js`:

- `verifyResults()` đọc output trực tiếp trên server bằng `find` / `ls` qua `plink`, phân
  loại file thành `outOnlyFiles`, `outAndRejFiles`, `rejOnlyFiles`, `errOnlyFiles` rồi
  assert số file và số record đúng/sai.
- `executeBatch()` có tuỳ chọn `allowFailure`: dùng cho ca cố tình upload tên file đã
  import. Batch trả `BE051` → job throw `JobInterruptedException` → exit code 20. Với ca
  này exit code **không phải** tiêu chí đánh giá, verdict nằm ở file `.rej`.
- Timeout chạy batch đặt 600s vì phải chờ JVM khởi động; timeout của cả suite là 20 phút.

## 8. Lệnh thường dùng

| Lệnh | Việc |
|---|---|
| `npm run generate:olsdb024` | Sinh file input cho OLSDB024 |
| `npm run generate:olsdb020` | Sinh file input cho OLSDB020 (cần DB) |
| `npm run generate:olsdb009` | Sinh file input cho OLSDB009 |
| `npm run test:olsdb024` | Chạy spec OLSDB024 |
| `npm run test:olsdb009` | Chạy spec OLSDB009 |
| `npm run test:all` | Chạy tất cả, `workers=1`, report html + json + junit |
| `npm run test:smoke` | Chỉ chạy test gắn tag `@smoke` |
| `npm run refresh:pool:olsdb009` | Làm mới snapshot dữ liệu DB cho OLSDB009 |
| `npm run report` | Mở report HTML của Playwright |
| `npm run clean` | Xoá `test-data\generated`, `logs`, `reports`, `playwright-report` |

Các script sau **tồn tại trong `package.json` nhưng file không có** — đừng dùng:
`generate` (mặc định), `generate:dashboard`, `generate:report`, `dashboard:serve`,
`dashboard:open`, `generate:olsdb014`, `generate:olsdb006`, `test:batch`, `generate:all`.

## 9. Cấu hình

Biến trong `.env` (nạp bởi `config/test-config.js`, **không** được nạp bởi spec — xem mục 10):

| Nhóm | Biến |
|---|---|
| SFTP | `SFTP_HOST`, `SFTP_PORT`, `SFTP_USERNAME`, `SFTP_PASSWORD`, `SFTP_REMOTE_PATH`, `LOCAL_PATH` |
| SSH | `SSH_HOST`, `SSH_USERNAME`, `SSH_PASSWORD`, `SSH_HOST_KEY` |
| Batch | `BATCH_COMMAND`, `BATCH_SCRIPT_PATH`, `BATCH_TIMEOUT`, `RETRY_ATTEMPTS`, `RETRY_DELAY` |
| PostgreSQL | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD`, `DB_SCHEMA` |
| Khác | `WINSCP_PATH`, `PUTTY_PATH`, `LOG_LEVEL`, `TEST_SEED` |

- `TEST_SEED=<số>` giúp chạy lại generator OLSDB020 đúng dữ liệu như lần trước (seed được
  in ra ở đầu output).
- `SSH_HOST_KEY` dùng để pin host key cho `plink`, tránh bị treo ở prompt
  `Store key in cache? (y/n)`.

## 10. Những điểm chưa nhất quán cần biết

1. **Spec tự khai báo `CONFIG` riêng**, không import `config/test-config.js`, cũng không
   import `logger.js` / `winscp-handler.js` / `putty-handler.js`. Sửa file config dùng
   chung sẽ **không** ảnh hưởng tới test đang chạy; hai class handler hiện gần như chỉ
   tồn tại để tham khảo.
2. **`.env` không được nạp trong spec.** `dotenv.config()` chỉ có trong
   `config/test-config.js` và `deepseek-test.js`, nên giá trị trong `.env` chỉ áp dụng cho
   file nào import chúng. `scripts/OLSDB009/file-naming.js` ghi chú rõ lý do: nạp `.env`
   sẽ ghi đè `BATCH_COMMAND` bằng `process_batch.sh` (không tồn tại) và làm hỏng luồng test.
3. **Hai môi trường lẫn nhau**: OLSDB009/OLSDB020 mặc định trỏ Malaysia
   `192.168.99.83` (`/apps/MY-dev/...`, DB `ols_my`); OLSDB024 và `.env` trỏ
   `192.168.99.89` (`/sftp/apps-SG-auto/`, DB `ols_sg_auto`). Trước khi chạy, kiểm tra
   `CONFIG` ở đầu spec bạn đang dùng.
4. **`LOCAL_PATH` trỏ `C:\BATCH-OCBC-PW1\src\`** nên file `.dat` luôn được copy sang ổ C
   trước khi upload, dù chạy project từ ổ F.
5. **Sequence number là tài nguyên dùng một lần mỗi ngày.** `ols_schema.batch_resource` là
   ledger: tên file đã nằm trong đó sẽ bị từ chối bằng `BE051`, job exit 20 và batch không
   sinh file `.out` nào. Generator OLSDB020 tự truy vấn ledger để lấy số kế tiếp; generator
   OLSDB024 dùng dải cố định 01–42 nên **chạy lại trong cùng ngày sẽ lỗi BE051** — phải
   regenerate hoặc đổi ngày.
6. **Mật khẩu đang ở dạng plaintext** trong `.env` và trong giá trị default của các spec.
   Không commit, không dán vào ticket; nên chuyển sang biến môi trường / secret store.
7. **`F:\BATCH-OCBC-PW1` chưa được version control** (không có `.git`). Bản trong
   `C:\BATCH-OCBC-PW1` chỉ là copy một phần (`src\`), không phải bản chạy được.
8. `package.json` chứa block `DeepSeekCopilotAPIKey` với key placeholder — không liên quan
   tới test, có thể bỏ.

## 11. Trạng thái lần chạy gần nhất

Theo `reports\test-results.json` (16/09/2026):

| Kết quả | Test | Nguyên nhân ghi nhận |
|---|---|---|
| FAIL | OLSDB009 `TC01` | `Batch command did not run… The system cannot find the path specified` — sai đường dẫn script batch trên server |
| FAIL | OLSDB020 `TC4A` | `File generator failed, so there is nothing fresh to upload` — `beforeAll` chạy generator thất bại (generator cần DB `192.168.99.83`) |
| INTERRUPTED | OLSDB020 `TC1` | bị ngắt giữa chừng |
| SKIPPED | 15 test còn lại | bị bỏ qua sau lỗi `beforeAll` / khi ngắt |

## 12. Checklist thêm batch mới

1. Copy folder `scripts\OLSDB024` → `scripts\OLSDBxxx`.
2. Sửa prefix tên file và format record trong `file-generator.js` / `file-naming.js`.
3. Sửa `CONFIG` đầu `test-runner.spec.js`: `winscp.remotePath`, `batch.scriptPath`,
   `batch.command`, `database.*`.
4. Sửa các regex nhận diện file output (`.out` / `.rej` / `.err`) trong `verifyResults()`.
5. Thêm script `generate:*` và `test:*` vào `package.json`.
6. Thêm folder rỗng tương ứng dưới `scripts\test-data\generated\`.
7. Chạy `npm run generate:olsdbxxx` trước, kiểm tra file sinh ra, rồi mới chạy
   `npm run test:olsdbxxx`.

## 13. Xử lý sự cố

| Triệu chứng | Nguyên nhân thường gặp |
|---|---|
| Batch exit code 20, không có `.out` | Tên file đã tồn tại trong `batch_resource` (BE051) → regenerate với sequence mới |
| `Batch command did not run… path specified` | `batch.scriptPath` / `batch.command` sai, hoặc file script không có trên server |
| `plink` treo không trả kết quả | Chưa cache host key → thêm `-batch -hostkey` hoặc set `SSH_HOST_KEY` (xem mục 3) |
| `The system cannot find the path specified` | Thiếu `plink.exe` / sai `CONFIG.putty.path` (xem mục 3) |
| Timeout chờ output | Batch chậm hơn dự kiến; kiểm tra log trên server trước khi tăng `maxWaitTime` |
| `File generator failed` (OLSDB020) | Không kết nối được DB `192.168.99.83` / `ols_my` |
| Upload fail qua WinSCP | Sai host/remotePath hoặc chưa có VPN |

## 14. Quy ước khi sửa code

- Chạy mọi lệnh từ thư mục gốc project (`process.cwd()` được dùng để tính đường dẫn
  `test-data\generated\...`).
- Giữ nguyên `workers: 1` — các test dùng chung `src\`, dùng chung server và dùng chung
  ledger `batch_resource`, chạy song song sẽ tranh chấp file và sequence number.
- Không hard-code thêm ngày/sequence mới; ưu tiên để generator tự tính.
- Giữ comment giải thích nghiệp vụ: các comment sẵn có trong `file-generator.js`,
  `test-runner.spec.js` mô tả những hành vi đã mất nhiều thời gian để tìm ra
  (BE051, BE654, host key của plink, thời gian khởi động JVM).
