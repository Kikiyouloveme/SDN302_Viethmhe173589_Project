# VELATHIER — SDN302

Website thời trang phục vụ học phần backend Node.js, Express và MongoDB.

**Stack:** React · TypeScript · Express · MongoDB · Mongoose · JWT.

## In áo theo yêu cầu (bổ sung)

Đã bổ sung Studio, upload artwork riêng tư, bản nháp/version, phí in phía server,
Staff review → Customer proof → sản xuất/QC, vận chuyển, size và verified reviews.

```powershell
npm.cmd run migrate:custom-print
npm.cmd run seed:custom-demo
npm.cmd run build
npm.cmd start
```

Chạy migration/demo khi chỉ có một writer; không dùng `seed` để reset DB đang có dữ liệu.
Demo seed chỉ chạy development/outbox/VNPay sandbox. [Kịch bản demo](docs/DEMO_SCRIPT.md),
[API](docs/CUSTOM_PRINT_API.md), [kiểm toán ban đầu](docs/CUSTOM_PRINT_GAP_ANALYSIS.md),
[ma trận kiểm thử và giới hạn](docs/CUSTOM_PRINT_TEST_CASES.md),
[bàn giao thay đổi](docs/CUSTOM_PRINT_CHANGELOG.md).

Kiểm thử: `npm.cmd run test:custom-unit`, `npm.cmd run test:integration`.
Ảnh mới là minh họa có nhãn; chưa có ảnh nhà cung cấp được cấp phép. Browser QA và
dịch vụ thanh toán/SMTP/vận chuyển live chưa được kiểm chứng trong môi trường này.

## Cài đặt và chạy

Hướng dẫn chi tiết theo màn hình Compass: [MONGODB-SETUP](docs/MONGODB-SETUP.md).
Đối chiếu slides và giới hạn phạm vi: [SDN302-ALIGNMENT](docs/SDN302-ALIGNMENT.md).

Mở PowerShell tại thư mục project:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm run setup
```

Trong `.env`, cấu hình `MONGO_URI=mongodb://127.0.0.1:27017/velathier`.
MongoDB Server phải đang chạy. Chọn **một** cách chuẩn bị database trống:

- `npm run seed`: tạo dữ liệu demo.
- `npm run db:import-json`: chuyển dữ liệu schema v3 từ `server/data/db.json`, giữ nguyên file nguồn.

Cả hai lệnh đều từ chối ghi vào database đã có dữ liệu.

```powershell
npm run db:check
npm start
```

Mở <http://localhost:5173>. Kiểm tra <http://localhost:5173/api/health>.

| Lệnh | Công dụng |
| --- | --- |
| `npm run setup` | Cài dependencies server/client và build; không seed dữ liệu |
| `npm run build` | Build React |
| `npm run typecheck` | Kiểm tra TypeScript |
| `npm run db:check` | Kết nối MongoDB, hiện database và số lượng bản ghi |
| `npm run test:integration` | Tự tạo database test riêng, chạy kiểm thử rồi dọn database test |
| `npm run test:api` | Chế độ thủ công; cần server test đang chạy và MONGO_URI khớp |

Tài khoản demo: `admin@velathier.vn / admin123`, `staff@velathier.vn / staff123`,
`khach@velathier.vn / khach123`. Chỉ dùng trong môi trường học tập.

## Kiến trúc

- `server/models/`: Mongoose schemas, validation, unique indexes và quan hệ.
- `server/routes/`: HTTP paths, middleware xác thực/phân quyền.
- `server/controllers/`: nhận request và trả response.
- `server/db.js`: facade truy cập dữ liệu cho logic nghiệp vụ.
- `server/mongo-store.js`: connection và unit of work, CRUD bằng Mongoose.
- `server/pricing.js`, `inventory.js`, `otp.js`: service nghiệp vụ.
- `client/src/`: giao diện React.
- `postman/`: collection demo API theo bài học.

Dữ liệu chạy thật nằm trong MongoDB. JSON cũ chỉ dùng làm nguồn nhập một lần.
Bản chuyển đổi dùng một process Node, đọc các collection mỗi request và chỉ ghi
những document thay đổi. Standalone chưa đảm bảo atomicity nhiều document;
replica set sẽ dùng transaction khi commit. Xem giới hạn đầy đủ trong hướng dẫn
MongoDB trước khi triển khai ngoài môi trường demo.

---

## Phân quyền

| Chức năng | Khách vãng lai | Khách hàng | Nhân viên | Admin |
|---|:-:|:-:|:-:|:-:|
| Xem sản phẩm, trang nội dung | ✓ | ✓ | ✓ | ✓ |
| Thêm vào giỏ hàng | ✓ | ✓ | ✓ | ✓ |
| Đặt hàng (cần xác minh email) | | ✓ | ✓ | ✓ |
| Xem/hủy đơn của chính mình | | ✓ | ✓ | ✓ |
| Yêu cầu đổi/trả | | ✓ | ✓ | ✓ |
| Quản lý sản phẩm, tồn kho, voucher | | | ✓ | ✓ |
| Xử lý đơn hàng, đổi/trả, hoàn tiền | | | ✓ | ✓ |
| Quản lý người dùng & phân quyền | | | | ✓ |

Kiểm soát ở **cả hai lớp**: middleware chặn ở API và `<Protected>` chặn ở route React.
Bỏ qua lớp giao diện cũng không truy cập được dữ liệu vì API tự kiểm tra quyền.

---

## Quy tắc nghiệp vụ

- **Thanh toán:** COD hoặc VNPay. Khách đăng nhập cần xác minh email; checkout khách vãng lai dùng OTP riêng và chỉ hỗ trợ COD.
- **Phí vận chuyển:** 40.000₫, miễn phí khi giá trị đơn **sau khi trừ voucher** đạt 750.000₫.
- **Voucher:** chỉ giảm theo phần trăm, tối đa 1 mã mỗi đơn, áp dụng được cho cả hàng đang sale.
- **Hủy đơn:** khách tự hủy được cho tới trước khi đơn bàn giao đơn vị vận chuyển.
- **Đổi/trả:** trong 7 ngày kể từ khi giao thành công, hàng còn nguyên tem và chưa sử dụng,
  bắt buộc có lý do + ảnh minh chứng, nhân viên duyệt thủ công.
- **Phí ship đổi/trả:** khách đổi ý thì khách chịu; sản phẩm lỗi hoặc giao sai thì cửa hàng chịu.
- **Hoàn tiền:** đơn VNPay hoàn về nguồn thanh toán; đơn COD hoàn qua chuyển khoản.

Mọi con số tiền đều được **server tính lại từ database**. Client chỉ gửi lên mã sản phẩm,
biến thể, số lượng và mã voucher — giá, giảm giá, phí ship, tổng tiền do client gửi đều bị bỏ qua.

---

## Bảo mật

- Mật khẩu băm bằng bcrypt (12 vòng), không bao giờ trả ra API.
- JWT có phiên bản — đổi mật khẩu sẽ vô hiệu hóa toàn bộ token cũ.
- OTP chỉ lưu dạng hash + salt, hết hạn 10 phút, dùng một lần, giới hạn số lần nhập sai.
- Rate limit riêng cho đăng nhập, đăng ký, yêu cầu OTP và xác minh OTP.
- Security headers qua helmet, bao gồm Content-Security-Policy.
- Trạng thái `paid` **chỉ** được đặt sau khi xác thực chữ ký HMAC-SHA512 của VNPay và
  đối chiếu số tiền — không có API nào cho phép client tự đánh dấu đã thanh toán.
- Callback và IPN của VNPay xử lý idempotent, gọi lại nhiều lần không trừ/hoàn kho hai lần.
- Khách chỉ truy cập được đơn hàng của chính mình (trả 404 thay vì 403 để không lộ mã đơn có thật).
- Thông tin ngân hàng nhận hoàn tiền chỉ nhân viên xử lý mới xem được, không ghi log.
- Lỗi máy chủ không lộ stack trace ở production.

Chạy `npm run test:integration` để kiểm chứng — bộ test bao phủ 142 trường hợp gồm giả mạo giá,
giả mạo thanh toán, truy cập chéo đơn hàng, OTP hết hạn/tái sử dụng và tranh chấp tồn kho.

---

## Bật VNPay thật

Đăng ký tài khoản thử nghiệm tại https://sandbox.vnpayment.vn/devreg/ rồi điền vào `.env`:

```env
VNP_TMN_CODE=mã_website_của_bạn
VNP_HASH_SECRET=secret_key_của_bạn
PUBLIC_URL=https://tên-miền-của-bạn.vn
```

Khi chưa cấu hình, hệ thống dùng cổng giả lập nội bộ — vẫn ký và xác thực HMAC thật,
chỉ khác là không gọi ra server VNPay. Điền credential thật là chạy được ngay, không cần sửa code.

Nhớ khai báo **IPN URL** trong cổng quản trị VNPay: `https://tên-miền-của-bạn.vn/api/payment/vnpay/ipn`

## Bật gửi email thật

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=email_của_bạn
SMTP_PASS=mật_khẩu_ứng_dụng
```

Chưa cấu hình thì email được lưu vào hộp thư nội bộ, xem tại **Admin → Email**.
Lưu ý: ở production, **chưa có SMTP thì khách không nhận được mã OTP** nên không thể
đăng ký hoặc đặt lại mật khẩu.

---

## Chuẩn bị lên production

- [ ] Đặt `NODE_ENV=production` và `JWT_SECRET` ngẫu nhiên ≥ 32 ký tự (server sẽ từ chối khởi động nếu thiếu)
- [ ] Đặt `PUBLIC_URL` là tên miền thật, chạy qua HTTPS
- [ ] Cấu hình SMTP thật (bắt buộc — nếu không khách không nhận được OTP)
- [ ] Cấu hình VNPay thật và khai báo IPN URL
- [ ] Đổi mật khẩu hoặc xóa các tài khoản mẫu
- [ ] Thay ảnh sản phẩm mockup (SVG) bằng ảnh thật qua Admin → Sản phẩm
- [ ] Tối ưu repository MongoDB, kiểm thử replica set, xử lý đồng thời nhiều process và sao lưu định kỳ
# Cập nhật remediation V2

Xem [VELATHIER_V2_REMEDIATION.md](docs/VELATHIER_V2_REMEDIATION.md) cho payment gate tất cả loại đơn, bản xuất PNG private, schema 5, replica transaction/conditional stock, storage S3, transactional outbox, bảo mật production và kiểm thử Playwright. Tài liệu này cập nhật kết quả/giới hạn mới hơn các tài liệu CUSTOM_PRINT ban đầu.

Lệnh bổ sung: `npm.cmd run test:replica`, `npm.cmd run test:browser`, `npm.cmd run backup:private`, `npm.cmd run build:deployment`. Browser test cần `npm.cmd exec playwright -- install chromium`; replica test dùng mongod local riêng và có thể cấu hình `TEST_MONGOD_PATH`.
