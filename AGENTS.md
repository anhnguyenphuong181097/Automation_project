# AGENTS.md — hướng dẫn cho AI coding agent

Áp dụng cho project **BATCH-OCBC-PW1** (automation test batch OLS của OCBC).
Đọc `README.md` trước để nắm kiến trúc; file này chỉ nói về **cách làm việc** trong repo.

## 1. Bối cảnh môi trường

- Hệ điều hành Windows, shell mặc định PowerShell. Đường dẫn dùng `\`.
- Node.js ESM (`"type": "module"` trong `package.json`) → dùng `import`, **không** `require`.
- Lệnh npm phải chạy từ thư mục gốc project: nhiều generator tính đường dẫn từ
  `process.cwd()`, chạy sai chỗ sẽ ghi file vào nhầm folder.
- Project này gọi ra hệ thống thật: SFTP server, batch server (SSH), và PostgreSQL.
  Mỗi lần chạy spec là một lượt **chạy batch thật trên server dev**, không phải mock.

## 2. Bản đồ file — sửa ở đâu

| Cần làm gì | Sửa file |
|---|---|
| Thêm / sửa dữ liệu test của một batch | `scripts/<BATCH>/file-generator.js`, `test-data.js` |
| Đổi quy ước tên file | `scripts/<BATCH>/file-naming.js` và regex trong `test-runner.spec.js` |
| Đổi host, remote path, batch command, DB | khối `CONFIG` ở đầu `test-runner.spec.js` (không phải `config/test-config.js` — xem mục 6) |
| Thêm / sửa test case | `scripts/<BATCH>/test-runner.spec.js` |
| Đổi cách kiểm chứng output | `verifyResults()` trong `test-runner.spec.js` |
| Đổi cách kiểm chứng DB | `verifyMccInDatabase()`, `executeDbQuery()`, `database_helper.js` |
| Đổi lệnh chạy | `package.json` |
| Đổi timeout, reporter, số worker | `playwright.config.js` |

## 3. Quy tắc an toàn (bắt buộc)

1. **Không in ra màn hình, không ghi vào file, không commit** credential trong `.env`,
   trong `CONFIG` của spec, hay trong `.claude/settings.local.json`. Khi cần trích dẫn,
   che lại (`oev***`, `ols***`).
2. **Không sửa `.env`** trừ khi được yêu cầu rõ ràng. Đổi host trong `.env` không làm test
   đổi host (spec không nạp `.env`) nhưng sẽ làm sai lệch các script có dùng config chung.
3. **Không chạy spec khi chỉ được yêu cầu đọc/giải thích code.** Chạy spec đồng nghĩa với
   upload file lên server, chạy batch thật và ghi vào DB dev — coi đây là hành động có
   thay đổi trạng thái.
4. **Không xoá** `src\`, `scripts\test-data\`, `reports\` bằng tay; dùng `npm run clean`
   nếu thực sự cần dọn.
5. **Không commit** `node_modules\`, `playwright-report\`, `test-results\`, `logs\`,
   `reports\` hoặc file `.dat` đã sinh.

## 4. Quy tắc nghiệp vụ phải nhớ

1. **Sequence number trong tên file là tài nguyên dùng một lần mỗi ngày.**
   `ols_schema.batch_resource` là ledger của batch. Tên file đã có trong ledger sẽ bị từ
   chối bằng `BE051`, job throw `JobInterruptedException`, batch exit code 20 và **không
   sinh file `.out` nào**. Vì vậy:
   - Generator OLSDB020 phải hỏi ledger để lấy số kế tiếp — giữ nguyên hành vi này.
   - Generator OLSDB024 dùng dải cố định 01–42 → chạy lại trong cùng ngày sẽ lỗi BE051.
   - Không hard-code thêm sequence mới vào generator.
2. **Exit code 20 không luôn là lỗi.** Với test case cố tình upload tên file trùng, phải
   gọi `executeBatch(testCase, { allowFailure: true })` rồi assert trên file `.rej`.
3. **Tên file output do batch sinh ra** theo mẫu `<PREFIX>-<date>-NN_<...>.out` /
   `.rej`, file lỗi mức job là `<BATCH>_*_<date>.err`. Regex nhận diện nằm trong
   `verifyResults()` — khi đổi mẫu tên, sửa cả generator, spec và regex cùng lúc.
4. **`plink` cần host key.** Nếu chưa cache, `plink` sẽ dừng ở prompt
   `Store key in cache? (y/n)`, không có stdin nên bị treo tới khi bị kill. Luôn giữ
   `-batch -hostkey "<SHA256:...>"` trong lệnh gọi.
5. **Batch là job Java**: cần thời gian khởi động JVM. Đừng hạ timeout chạy batch xuống
   mức vài chục giây.

## 5. Vòng lặp làm việc và xác minh

Khi sửa code, luôn theo thứ tự:

1. Sửa generator trước, chạy `npm run generate:<batch>` và **đọc file `.dat` sinh ra**
   (đúng số field, đúng độ dài, đúng dấu phân cách `|`, kết thúc CRLF) trước khi chạy test.
2. Chạy một test case hẹp, không chạy cả suite:
   `npx playwright test scripts/<BATCH>/test-runner.spec.js -g "TC4A"`.
3. Đọc kết quả có cấu trúc thay vì chỉ đọc log console:
   - `reports/test-results.json` — nguồn sự thật cho pass/fail và thông điệp lỗi.
   - `reports/junit.xml` — dùng khi cần chuyển cho CI.
   - `test-results/` — trace / screenshot / video của ca lỗi.
4. Khi báo cáo, trích nguyên văn thông điệp lỗi và chỉ ra file + dòng liên quan.

Tiêu chí hoàn thành (Definition of Done):

- Test liên quan chạy được tới verdict thật (pass hoặc fail có lý do rõ ràng), không phải
  fail vì lỗi hạ tầng (DB không kết nối được, sai path, thiếu VPN).
- Nếu đổi generator: đã kiểm tra file output thực tế.
- Nếu đổi tên file / regex: generator, spec và regex đã đồng bộ.
- Không còn credential mới xuất hiện trong diff.

## 6. Các cạm bẫy đã biết (đừng vấp lại)

1. **Đừng import `config/test-config.js` vào spec hay generator.** File đó gọi
   `dotenv.config()` và sẽ ghi đè `BATCH_COMMAND` bằng `process_batch.sh` (không tồn tại),
   đồng thời trỏ host theo `.env`. Các spec cố tình tự khai báo `CONFIG`.
2. **Đừng tin toàn bộ script trong `package.json`.** Các lệnh sau trỏ tới file không tồn
   tại: `generate`, `generate:dashboard`, `generate:report`, `dashboard:serve`,
   `dashboard:open`, `generate:olsdb014`, `generate:olsdb006`, `test:batch`, `generate:all`.
   Nếu cần dùng, phải tạo file trước.
3. **Đừng tăng `workers`.** Các test dùng chung `src\`, dùng chung server và dùng chung
   ledger `batch_resource` — chạy song song sẽ tranh chấp.
4. **Đừng xoá comment giải thích nghiệp vụ.** Các comment dài trong
   `scripts/OLSDB020/file-generator.js` và `test-runner.spec.js` ghi lại nguyên nhân thật
   của những lỗi khó tìm (BE051, BE654, host key của plink, thời gian khởi động JVM).
   Khi sửa hành vi, cập nhật comment tương ứng thay vì xoá.
5. **Đừng nhầm hai bộ host.** OLSDB009/OLSDB020 → `192.168.99.83` (`ols_my`,
   `/apps/MY-dev/...`); OLSDB024 → `192.168.99.89` (`ols_sg_auto`, `/apps/SG-auto/...`).
6. **`C:\BATCH-OCBC-PW1` không phải project.** Nó chỉ là nơi chứa `src\` cho
   `LOCAL_PATH` (`C:\BATCH-OCBC-PW1\src\`). Project chạy được nằm ở `F:\BATCH-OCBC-PW1`.
7. **Trong spec OLSDB020, phần lớn test case đang bị comment.** Chỉ TC4A active. Nhìn vào
   danh sách `test()` đang hoạt động, đừng giả định toàn bộ TC1–TC10 đang chạy.
8. **`test.beforeAll` của OLSDB020 tự chạy generator**, và generator này cần DB. Nếu DB
   không truy cập được, toàn bộ suite fail/skip với thông điệp
   `File generator failed, so there is nothing fresh to upload`.

## 7. Ghi chú khi thêm batch mới

1. Copy `scripts\OLSDB024` làm template (bộ spec đầy đủ nhất).
2. Đổi `FILE_ID` / prefix, format record, và dải sequence trong `file-generator.js`.
3. Đổi `CONFIG` trong spec: `winscp.remotePath`, `batch.scriptPath`, `batch.command`,
   `database.*`.
4. Sửa regex nhận diện file output trong `verifyResults()` và `verifyResults2()`.
5. Thêm script npm `generate:*` và `test:*`.
6. Tạo `scripts\test-data\generated\<BATCH>\` rồi chạy generator trước khi chạy test.
