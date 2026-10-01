# NHÁP - request OL59 để bạn kiểm tra trên server (30/09/2026)

Region: dùng `ID` (region dev đang nhận; `MY` trả `E0003`). Channel `INB` (giống request MA đã
thành công). `Timestamp` để bạn tự set theo giờ chạy (format `yyyyMMdd HHmmss`), `MessageNum` nên
đổi mỗi lần (6 ký tự, ví dụ `E12345`).

Điểm quan trọng: **receiving fields khác nhau theo item** - lấy từ các redemption đã thành công
trong `ITEM_FULFILMENT_STATUS`, không dùng bộ của MA.

## 1. AA - ITAA3 (`item AA malaysia`, catalogue TRANG, price 10.00, pool ENQ1, 0VN, seq 129002)

Receiving lấy từ ref `49915449` (24/08/2026, `last_update_by = OL59`):
`itmRdmReceivingAcctOrId = 9999990005235400`, First = `Buddy`, Last = `Miles`.

```json
{
  "SvcRq": { "ChannelId": "INB", "Timestamp": "20260930 150000", "TimeoutPeriod": 99, "MessageNum": "E10001" },
  "OLSRq": { "MsgSqNum": "1", "Timestamp": "20260930 150000", "Region": "ID", "MsgCode": "OL59", "ProcessingCode": "000000" },
  "itemRedeem": {
    "itmRdmCIFNum": "002222300006877",
    "itmRdmAcctNum": "",
    "itmRdmCardNum": "",
    "itmRdmCatalogue": "TRANG",
    "itmRdmRewardCurrency": "0VN",
    "itmRdmItemCode": "ITAA3",
    "itmRdmFullPriceInPoints": 10,
    "itmRdmPoolUnitsRequired": 10,
    "itmRdmCashRequired": "0",
    "itmEnqAdminFeeGrp": [],
    "itmRdmQuantityItem": "1",
    "itmRdmReceiveQuantity": "1",
    "itmRdmReceivingAcctOrId": "9999990005235400",
    "itmRdmReceivingFirstName": "Buddy",
    "itmRdmReceivingLastName": "Miles",
    "itmRdmDeliveryAddress1": "123 Main Street",
    "itmRdmDeliveryAddress2": "Suite 4B",
    "itmRdmCity": "Hanoi",
    "itmRdmZIPCode": "100000",
    "itmRdmRecipientName": "John Doe",
    "itmRdmTitle": "Mr",
    "itmRdmMobile": "0912345678",
    "itmRdmRemarks": "Please deliver ASAP"
  }
}
```

Biến thể nên thử nếu `E5918`: `full/pool = 1000` + `quantity = "100"` (giống pattern MA).

## 2. TL - ITTL1 (`item traveloka 1`, catalogue TRANG, price 100.00, pool ENQ1, 0VN, seq 77593)

Receiving lấy từ ref do OL99 tạo (17/09/2026): AcctOrId `08123450000`, First = `Chi`, Last = `Pham`.

```json
{
  "SvcRq": { "ChannelId": "INB", "Timestamp": "20260930 150000", "TimeoutPeriod": 99, "MessageNum": "E10002" },
  "OLSRq": { "MsgSqNum": "1", "Timestamp": "20260930 150000", "Region": "ID", "MsgCode": "OL59", "ProcessingCode": "000000" },
  "itemRedeem": {
    "itmRdmCIFNum": "002222300006877",
    "itmRdmAcctNum": "",
    "itmRdmCardNum": "",
    "itmRdmCatalogue": "TRANG",
    "itmRdmRewardCurrency": "0VN",
    "itmRdmItemCode": "ITTL1",
    "itmRdmFullPriceInPoints": 100,
    "itmRdmPoolUnitsRequired": 100,
    "itmRdmCashRequired": "0",
    "itmEnqAdminFeeGrp": [],
    "itmRdmQuantityItem": "1",
    "itmRdmReceiveQuantity": "1",
    "itmRdmReceivingAcctOrId": "08123450000",
    "itmRdmReceivingFirstName": "Chi",
    "itmRdmReceivingLastName": "Pham",
    "itmRdmDeliveryAddress1": "123 Main Street",
    "itmRdmDeliveryAddress2": "Suite 4B",
    "itmRdmCity": "Hanoi",
    "itmRdmZIPCode": "100000",
    "itmRdmRecipientName": "John Doe",
    "itmRdmTitle": "Mr",
    "itmRdmMobile": "0912345678",
    "itmRdmRemarks": "Please deliver ASAP"
  }
}
```

Biến thể: `full/pool = 10000` + `quantity = "100"`. Lưu ý TL lịch sử **chỉ thành công qua OL99**,
chưa từng qua OL59 - nếu TL trả `TL-BAD_REQUEST`/`E5918` ở mọi biến thể thì nên kết luận TL không
đi qua OL59.

## 3. PI - APZ3K (`A Donation`, catalogue ACATA)

Item này có 3 price active và `partial_redeem = true`:

| price_id | pool | currency | price_in_point | seq_no | channel |
|---|---|---|---|---|---|
| 68842 | APOOL | APR | 1.00 | 70486 | [BATCH, INB, MB, SICS] |
| 68843 | ENQ1 | 0VN | 2.00 | 70487 | [BATCH, INB, MB] |
| 68844 | RAYL | PCB | 2.00 | 70488 | [BATCH] |

Redemption thành công gần nhất: pool `RAYL`, `redeemed_point 5.00` nhưng `full_price_in_point 20.00`
(tức PI cho phép trả một phần) - do `OLSDB116` tạo, không phải OL59.

```json
{
  "SvcRq": { "ChannelId": "INB", "Timestamp": "20260930 150000", "TimeoutPeriod": 99, "MessageNum": "E10003" },
  "OLSRq": { "MsgSqNum": "1", "Timestamp": "20260930 150000", "Region": "ID", "MsgCode": "OL59", "ProcessingCode": "000000" },
  "itemRedeem": {
    "itmRdmCIFNum": "002222300006877",
    "itmRdmAcctNum": "",
    "itmRdmCardNum": "",
    "itmRdmCatalogue": "ACATA",
    "itmRdmRewardCurrency": "0VN",
    "itmRdmItemCode": "APZ3K",
    "itmRdmFullPriceInPoints": 200,
    "itmRdmPoolUnitsRequired": 200,
    "itmRdmCashRequired": "0",
    "itmEnqAdminFeeGrp": [],
    "itmRdmQuantityItem": "100",
    "itmRdmReceiveQuantity": "100",
    "itmRdmReceivingAcctOrId": "335221784",
    "itmRdmReceivingFirstName": "Enrich",
    "itmRdmReceivingLastName": "Blue Partner",
    "itmRdmDeliveryAddress1": "123 Main Street",
    "itmRdmDeliveryAddress2": "Suite 4B",
    "itmRdmCity": "Hanoi",
    "itmRdmZIPCode": "100000",
    "itmRdmRecipientName": "John Doe",
    "itmRdmTitle": "Mr",
    "itmRdmMobile": "0912345678",
    "itmRdmRemarks": "Please deliver as soon as possible"
  }
}
```

Biến thể: `full/pool = 20` + `quantity = "1"` (partial, price 2.00 x10?), hoặc pool `APR`
(`price 1.00`, seq 70486) với `full = 100`.

## Ket qua thu cua automation (30/09/2026, region ID)

| item | request thử gần nhất | kết quả |
|---|---|---|
| AA ITAA3 | full=1000, qty=100, recv=1000 (receiving của MA) | `E5918` |
| TL ITTL1 | full=10000, qty=100, recv=10000 | `TL-BAD_REQUEST` |
| PI APZ3K | full=200, qty=100, recv=200 | `E0008` receive quantity invalid data type |

Nhớ đổi receiving fields sang đúng của từng item (mục 1/2) trước khi chạy.
