# Bản nháp (DRAFT) — 30/09/2026

Chưa áp dụng vào code. Xem xong, muốn áp thì nói tôi "áp nháp" (hoặc tự copy 2 chỗ bên dưới).

## 1. Công thức giá gửi OL59 — **CHƯA XÁC NHẬN, đừng áp dụng vội**

Cập nhật 30/09: giả thuyết "giá × 100" bên dưới **mâu thuẫn với bằng chứng E2E của chính mình**:

- OL59-A (`UG7814`, giá 12.00, quantity 100) gửi `1200` → OK
- OL59-B (`UG7814`, giá 12.00, quantity 200) gửi **`2400`** → OK

→ với item đang chạy được, giá trị gửi đi **= price_in_point × quantity** (nếu là "× 100 cố định" thì
case quantity 200 phải gửi 1200 và sẽ fail). Còn payload BA (`ITER` giá 10.00, quantity 1, gửi 1000)
rất có thể là **giá của item đó trong môi trường BA** (1000 điểm), không phải công thức ×100.

Kết luận (cập nhật 30/09, sau khi request MA chạy được): **giữ nguyên `price_in_point × quantity`**,
giả thuyết ×100 đã bị bác bỏ hoàn toàn:

- MA `ITER` giá `10.00`, quantity **100** → gửi `1000` = `10 × 100` ✔ (không phải "10 × 100" kiểu cố
  định, vì nếu cố định thì quantity=1 cũng phải gửi 1000 và đã pass — thực tế quantity=1 trả `E5918`).
- EV `UG7814` giá `12.00`, quantity 100 → `1200`, quantity 200 → `2400` ✔

Điểm riêng của item type **MA**: `itmRdmReceiveQuantity` = **giá trị full price** (`1000`), không bằng
`itmRdmQuantityItem` (`100`). Phần dưới chỉ để tham khảo, KHÔNG áp dụng.

### (giả thuyết cũ, để tham khảo)

**Vấn đề:** generator đang gửi `itmRdmFullPriceInPoints = price_in_point × quantity`.

**Bằng chứng nó sai:**

- Payload BA cho `ITER` (`item_price.price_in_point = 10.00`, quantity = **1**) gửi `itmRdmFullPriceInPoints = 1000`.
- Payload BA cho `TREV5` (`price_in_point = 10.00`) cũng gửi `1000`.
- `1000 = 10.00 × 100` ⇒ giá trị là **giá × 100** (đơn vị 2 số thập phân của pool), **không nhân quantity**.
- Case EV đang pass (`UG7814`, `12.00`, quantity = 100) chỉ đúng vì `12 × 100` = `12 × quantity(100)` — trùng nhau một cách tình cờ.

### Chỗ sửa 1 — `buildRequest()` trong `file-generator.js`

Trước:

```js
  if (unitPrice !== null && quantity !== null) {
    const total = unitPrice * quantity; // API expects the whole redemption, not the unit price
    if (caseItem.itmRdmFullPriceInPoints === undefined) item.itmRdmFullPriceInPoints = total;
    if (caseItem.itmRdmPoolUnitsRequired === undefined) item.itmRdmPoolUnitsRequired = total;
    if (caseItem.itmRdmQuantityItem === undefined) item.itmRdmQuantityItem = String(quantity);
    if (caseItem.itmRdmReceiveQuantity === undefined) item.itmRdmReceiveQuantity = String(quantity);
  }
```

Sau:

```js
  if (unitPrice !== null) {
    const price100 = Math.round(unitPrice * 100); // pool units = points * 100 (2 decimals)
    if (caseItem.itmRdmFullPriceInPoints === undefined) item.itmRdmFullPriceInPoints = price100;
    if (caseItem.itmRdmPoolUnitsRequired === undefined) item.itmRdmPoolUnitsRequired = price100;
  }
  if (quantity !== null) {
    if (caseItem.itmRdmQuantityItem === undefined) item.itmRdmQuantityItem = String(quantity);
    if (caseItem.itmRdmReceiveQuantity === undefined) item.itmRdmReceiveQuantity = String(quantity);
  }
```

### Chỗ sửa 2 — nhánh retry `E5908` trong `prepareData()`

Trước:

```js
        request.itemRedeem.itmRdmFullPriceInPoints = price.unitPriceInPoints * next;
        request.itemRedeem.itmRdmPoolUnitsRequired = price.unitPriceInPoints * next;
```

Sau (giá **không** đổi theo quantity):

```js
        request.itemRedeem.itmRdmFullPriceInPoints = Math.round(price.unitPriceInPoints * 100);
        request.itemRedeem.itmRdmPoolUnitsRequired = Math.round(price.unitPriceInPoints * 100);
```

### Ảnh hưởng

- Case EV hiện tại (`UG7814`, quantity 100): giá gửi đi **không đổi** (1200) ⇒ vẫn pass E2E.
- Các item type khác: bây giờ mới gửi đúng `1000` cho item giá `10.00` (thay vì `10`) ⇒ đi qua được bước kiểm giá **nếu** region của API khớp (xem mục 2).

## 2. Vì sao hiện vẫn chưa chạy được (không phải lỗi payload)

Bước 0a (region pre-flight) của spec đang fail có chủ đích:

```text
REGION MISMATCH: API accepts "ID" but the environment expects "MY".
Probes: MB/MY=E0003, MB/ID=E5918
```

Payload phải giữ `Region = MY` (dev-my / `ols_my` / payload BA). Cần dev khôi phục region của
service `ols-one-channels` (và kiểm tra `app_param.site_country_code`, hiện đang là `ID`).

Kiểm tra lại nhanh:

```powershell
node -e "import('./scripts/OLSDB028/file-generator.js').then(async m => console.log(await m.preflightRegion('check')))"
```

Khi nào `ok: true` (acceptedRegion = MY) thì chạy:

```powershell
npm run test:olsdb028
```

## 3. Việc còn lại sau khi region về MY

1. Áp nháp mục 1 (công thức giá ×100).
2. Thêm 3 item type khác EV vào `api-data/OL59-itemRedeem.json` — ứng viên đã xác minh trong DB
   (price còn hiệu lực, pool nằm trong statement output, PAL khớp CIF 6688):

   | item type | item code | catalogue | reward currency | price_in_point |
   |---|---|---|---|---|
   | AA | ITAA3 | TRANG | 0VN | 10.00 |
   | MA | ITER  | TRANG | 0VN | 10.00 (bắt buộc quantity = 1 — lỗi `E5917`) |
   | TL | ITTL1 | TRANG | 0VN | 100.00 |
   | OV | ITOV1 | TRANG | 0VN | 1200.00 |
   | PI | APZ3K | ACATA | 0VN | 2.00 |
   | CT | CT01  | H01   | OCB | 1.00 |

3. Chạy 1 case hẹp (`-g "TC01"`) để xác nhận request OL59 được nhận, rồi mới chạy E2E đầy đủ.

## 4. Ghi chú về rule EV + `qty_on_hand` (chưa làm)

`UG7814` là item EV duy nhất dùng được nhưng `qty_on_hand = 48` trong khi API chặn quantity < 100,
và không có item EV nào có `qty_on_hand >= 100` + price còn hiệu lực. Muốn áp rule "EV phải ≤ tồn kho"
thì cần: đổi sang item EV khác có tồn kho, hoặc hạ min-quantity trên dev, hoặc chấp nhận ngoại lệ.

## 5. Field của dòng item trên OA — lấy từ form thật (02/10/2026)

Không đoán nữa: trang Create (`moduleId=6412`) nạp bảng field qua
`loadSubModuleSection?subModuleId=6413` → `loadSubModule`. HTML trả về có đủ nhãn + mã field, lưu tại
`scripts/test-data/generated/OLSDB028/oa/submodule-fields-6413.html`. Các field liên quan:

| Nhãn trên OA | Mã field |
|---|---|
| Catalogue / Item / Reward Currency | `R_641309` / `R_641308` / `R_641340` |
| Redemption Quantity | `R_641310` |
| Member Id / Member First Name / Member Last Name | `R_641312` / `R_641313` / `R_641314` |
| **Email** | **`R_641321`** |
| Mobile | `R_641320` |
| Delivery Address 1 | `R_641317` |
| City / Province / Country | `R_641334` / `R_641350` / `R_641351` |
| Zip Code / Area | `R_641335` / `R_641336` |

Bản nháp trước đây map sai nhóm "credit to account" (nhồi Member Id vào `R_641330` = *Pool Units
Required*, `R_641351` = *Country*, `R_641334` = *City*, `R_641350` = *Province*) → đó là lý do TL
Save được nhưng Approve trả `BLANK_REQUIRED_FIELD`. Đã bỏ nhánh sai này.

### Traveloka (item `ITTL1`, type `TL`) — ĐÃ CHẠY ĐƯỢC 02/10

Chỉ cần thêm **Email = `tvlk.coupon@gmail.com`**:

```text
quote ITTL1: pool=ENQ1 cur=0VN fullPrice=100 itemValue=100 listPrice=100 seq=77593 type=TL
Save    -> "Record(s) created, pending for approval."
Approve -> "Record(s) approved."
IFS     -> ref 58278527, extracted 02-10-2026 10:58:03, last_update_by=olsadmin2
```

Kiểm tra đầu vào OLSDB028 cho row này: pool `ENQ1` có trong `statement_output_pool`
(status `A`, hiệu lực 20-01-2024 → 21-01-2029, PAL list `[PARTNER, OCR, 802, 500, 501, CCC]`);
row IFS có PAL `OCR` nằm trong list ✔. `trackStockQuantity = N`, `quantityOnHand = null` nên TL **không**
vướng rule tồn kho.

Script dùng để dò: `node scripts/OLSDB028/drafts/oa-field-probe.js --fields`
(`--sub` để xem phần Item Listing, không tham số để xem trang Create); xem DB:
`node scripts/OLSDB028/drafts/db-peek.js <reference_no>`.
