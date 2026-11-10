# Bộ chọn địa chỉ Việt Nam — bàn giao

## Phạm vi và kiến trúc

Đã tích hợp trực tiếp trên source hiện tại, không dùng ZIP hoặc tạo dự án mới.

- `AddressSelector`: một trường chọn hai cấp, tìm kiếm, tab tỉnh/phường, danh sách
  cuộn, loading/empty/error/retry, đóng khi click ngoài/Escape và hỗ trợ bàn phím.
  Giá trị form là hai hidden input `provinceCode`, `wardCode`; guest checkout dùng
  callback `onChange`. Gõ từ khóa không tự chọn hoặc thay đổi giá trị gửi đi.
- `useVietnamLocations`: cache cả request đang chạy và kết quả thành công; xóa
  cache lỗi để thử lại. Kết quả có khóa tỉnh; response cũ không ghi đè tỉnh mới.
- `location-utils`: chuẩn hóa dấu tiếng Việt, đ/Đ, hoa/thường và khoảng trắng;
  hỗ trợ `ha noi`, `hanoi`, mã hành chính; đối chiếu tên cũ chỉ bằng kết quả duy nhất.
- Dropdown render bằng portal trong dialog gần nhất (hoặc body), vị trí fixed,
  giới hạn theo viewport/visualViewport. Focus trap của Dialog được cập nhật động;
  Escape đóng bộ chọn trước, không đóng luôn form.

Tái sử dụng đúng hai API:

```text
GET /api/orders/locations
GET /api/orders/locations/:code/wards
```

Không bổ sung API danh mục, thư viện mới hoặc danh sách tỉnh hardcode ở frontend.

## Validation, MongoDB và tương thích

`validateLocation` kiểm tra tỉnh tồn tại, phường tồn tại trong đúng tỉnh; lấy tên
từ catalog backend. `validateAddress` dùng chung cho sổ địa chỉ, địa chỉ đăng ký
tùy chọn và địa chỉ mới gửi khi checkout. OTP/contact validation khách vẫn giữ.

Mã lưu dạng chuỗi: tỉnh 2 chữ số, phường 5 chữ số (`01`, `00004`). Input mã số
cũ được chuẩn hóa để tương thích API; không dùng `Number` khi trả mã hoặc lưu mới.
Schema khai báo rõ mã, tên, địa chỉ chi tiết, ghi chú, mặc định và timestamps.

Địa chỉ mới không có quận/huyện (`district: ''`). Địa chỉ cũ vẫn đọc và dùng qua
`addressId`; không migration hoặc sửa hàng loạt đơn cũ. Khi sửa địa chỉ cũ có
quận/huyện nhưng thiếu mã phường, yêu cầu chọn lại thay vì đoán theo tên trùng.
Tên cũ không có quận/huyện chỉ preselect khi khớp chính xác, duy nhất trong tỉnh.

Order snapshot được sao chép từ địa chỉ lúc đặt hàng. Sửa sổ địa chỉ không sửa
snapshot. Order detail, Admin và email đã dùng `filter(Boolean).join(', ')` nên
hiển thị được cả địa chỉ hai cấp mới và địa chỉ có quận/huyện trong lịch sử.

Đã kiểm tra catalog: 34 tỉnh/thành, 3.321 mã phường/xã duy nhất. Giữ nguyên nội dung
snapshot; quy ước mã và nguồn đối chiếu chính thức ghi tại `server/catalog/README.md`.
Không khẳng định catalog đã phản ánh mọi thay đổi hành chính sau snapshot.

## Danh sách file

Tạo mới:

- `client/src/components/address-selector.tsx`
- `client/src/hooks/use-vietnam-locations.ts`
- `client/src/lib/location-utils.ts`
- `server/test-locations-unit.js`
- `server/test-locations.js`
- `tests/browser/addresses.spec.cjs`
- `docs/address-selector-upgrade.md`

Sửa:

- `client/src/components/guest-checkout.tsx`
- `client/src/components/ui/dialog.tsx`
- `client/src/pages/checkout.tsx`
- `client/src/pages/account.tsx`
- `client/src/lib/api.ts`
- `server/checkout-validation.js`
- `server/controllers/auth.js`
- `server/controllers/orders.js`
- `server/models/index.js`
- `server/catalog/README.md`
- `server/seed-custom-demo.js` — payload demo dùng mã hợp lệ; không chạy trên DB thật.
- `server/test-api.js`
- `server/test-custom-print.js`
- `server/test-mongo.js`
- `server/test-print-srs.js`
- `server/test-reliability.js` — các fixture địa chỉ mới chuyển sang mã hợp lệ.
- `server/test-integration.js` — thêm nhóm test địa chỉ trên DB riêng.
- `server/test-browser.js` — hỗ trợ chuyển tiếp đối số Playwright để chạy nhóm cụ thể.
- `tests/browser/srs.spec.cjs` — dùng bộ chọn mới và kiểm tra snapshot địa chỉ guest.
- `package.json` — đưa unit test địa chỉ vào lệnh test hiện có.

Không xóa file. Không chỉnh `.env`, không reset MongoDB hiện có, không sửa logic
thanh toán/tồn kho/OTP/in áo. Không cần migration.

## Chạy trên VS Code / Windows PowerShell

Mở folder dự án trong VS Code, mở Terminal → New Terminal (PowerShell).
Sử dụng MongoDB và `.env` đang cấu hình; không chạy seed/reset trên DB đang dùng.

```powershell
Set-Location E:\SDN302\Project\WebQuanAo
npm install
npm --prefix client install
npm run build
npm start
```

Mở URL server in ra terminal (mặc định `http://localhost:5173`, hoặc `PORT` đã cấu hình).
Vào `/checkout` ở trạng thái khách; hoặc đăng nhập rồi vào Checkout / Tài khoản → Địa chỉ.

```powershell
npm run typecheck
npm run build
npm run test:custom-unit
npm run test:integration
npm run test:browser
# Chỉ chạy kiểm thử bộ chọn:
npm run test:browser -- tests/browser/addresses.spec.cjs
```

Integration và browser harness tạo DB có tên `velathier_test_<timestamp>_<pid>`
riêng rồi dọn đúng DB đó. Cần MongoDB localhost:27017. Playwright cần Chromium
đã cài; nếu máy mới chưa có, chạy `npx playwright install chromium`.

## Ma trận kiểm thử

| Yêu cầu | Nhóm kiểm thử |
|---|---|
| TC01–06 | Browser: mở đủ 34 tỉnh, tìm có/không dấu/liền chữ, chọn mã/tên, đổi tỉnh xóa phường, không có kết quả |
| TC07 | Unit + integration: mã không tồn tại, phường sai tỉnh, tên giả, chuỗi trắng |
| TC08 | SRS browser + integration: guest OTP → COD, snapshot có mã/tên đúng |
| TC09–11 | Browser account/checkout + integration: thêm, sửa, preselect, mặc định, tự chọn địa chỉ mới |
| TC12 | Browser yêu cầu chọn lại địa chỉ cũ không rõ mã; integration đặt hàng bằng địa chỉ cũ |
| TC13–14 | Browser: lỗi API/thử lại, giữ tên người nhận, response cũ đến sau tỉnh mới |
| TC15–16 | Browser desktop/mobile: viewport, bàn phím, Escape, focus, click ngoài, dialog |
| TC17–18 | Các test API/Custom Print/SRS/VNPay/VietQR và hành trình trình duyệt hiện có |
| TC19 | Integration: sửa sổ địa chỉ sau đặt đơn không thay đổi snapshot |
| TC20 | Typecheck, production build, unit và integration |

## Kết quả thực thi

| Lệnh/nhóm | Kết quả |
|---|---|
| `npm run typecheck` | PASS |
| `npm run build` | PASS — production build |
| `npm run test:custom-unit` | PASS — 33 tests, gồm 6 tests địa chỉ mới |
| `npm run test:integration` | PASS — địa chỉ 18 HTTP checks, API 153, Custom Print 95, SRS 122; MongoDB và reviews đều đạt |
| `npm run test:browser -- tests/browser/addresses.spec.cjs` | PASS — 6/6 trên desktop/mobile |
| `npm run test:browser` | PASS — 16/16, gồm bộ chọn địa chỉ và toàn bộ hành trình regression desktop/mobile |

Kiểm tra trình duyệt có thêm xác nhận giữ nguyên giỏ, voucher WELCOME10 và lựa
chọn VNPay khi thêm địa chỉ trong checkout. Đã xem ảnh chụp desktop/mobile;
dropdown nằm trong viewport, tab và danh sách cuộn hiển thị đúng.

Không có lỗi chức năng còn biết trong các luồng đã kiểm tra. Giới hạn còn lại:
catalog là snapshot hiện có, không tự cập nhật các thay đổi hành chính tương lai;
địa chỉ lịch sử thiếu mã/không đủ chắc chắn phải chọn lại khi sửa. Không thử giao
dịch thanh toán thật hoặc gửi email SMTP thật — các kiểm thử dùng môi trường
sandbox/outbox và DB riêng.
