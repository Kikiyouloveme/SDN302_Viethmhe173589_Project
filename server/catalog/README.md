# Địa chỉ Việt Nam

`vietnam-divisions.json` là bản dữ liệu tải ngày 2026-09-15 từ
https://provinces.open-api.vn/api/v2/?depth=2 (34 tỉnh/thành, 3.321 phường/xã).
Nguồn và tài liệu: https://github.com/hongquan/vn-open-api-provinces

Dùng mã tỉnh và mã phường/xã để kiểm tra quan hệ địa chỉ trên server.
Client chỉ tải danh sách tỉnh và danh sách phường/xã của tỉnh đang chọn.
Không gửi thông tin khách hàng tới nhà cung cấp dữ liệu.
Khi cập nhật, thay file bằng dữ liệu cùng cấu trúc và chạy test checkout.

## Kiểm tra trong lần nâng cấp bộ chọn địa chỉ

- Đã đếm 34 tỉnh/thành, 3.321 phường/xã; không có mã tỉnh hoặc mã phường trùng.
- File nguồn hiện lưu mã dạng số. `checkout-validation.js` chuẩn hóa khi đọc thành
  chuỗi 2 chữ số cho tỉnh và 5 chữ số cho phường/xã (ví dụ `01`, `00004`). API và
  địa chỉ mới lưu MongoDB sử dụng chuỗi; không sửa hàng loạt dữ liệu cũ.
- Đối chiếu quy mô và quy ước mã với Quyết định 19/2025/QĐ-TTg:
  https://chinhphu.vn/?classid=1&docid=214409&orggroupid=3&pageid=27160
  https://datafiles.chinhphu.vn/cpp/files/vbpq/2025/7/19ttg.signed.pdf
- Giữ nguyên snapshot danh mục đang có; không khẳng định đã kiểm chứng từng ranh
  giới/tên gọi với mọi văn bản sửa đổi phát sinh sau snapshot. Khi cập nhật nội dung,
  cần đối chiếu nguồn hành chính chính thức, không tự ghép theo tên hoặc số lượng.
- Bộ chọn chỉ gọi hai endpoint nội bộ `/api/orders/locations` và
  `/api/orders/locations/:code/wards`; không có phụ thuộc mạng bên thứ ba lúc checkout.
