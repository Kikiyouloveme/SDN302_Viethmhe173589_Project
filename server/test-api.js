/**
 * Bộ kiểm thử API — chạy trực tiếp với server đang bật.
 *   node server/test-api.js
 *
 * Bao phủ các case bắt buộc: bảo mật đơn hàng, giả mạo thanh toán, voucher,
 * phí ship theo ngưỡng, tồn kho theo biến thể, hủy đơn, đổi/trả và OTP.
 */
require('./config');
const db = require('./db');
const BASE = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 5173}`;

let passed = 0, failed = 0;
const results = [];

function check(name, condition, detail = '') {
  if (condition) { passed++; results.push(`  ✓ ${name}`); }
  else { failed++; results.push(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function section(title) { results.push(`\n${title}`); }

async function call(method, path, { token, body, raw } = {}) {
  const headers = {};
  if (!raw) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: raw ? body : body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

const rnd = () => Math.random().toString(36).slice(2, 8);

/** Các bước phải đi qua để tới một trạng thái — máy trạng thái không cho nhảy cóc */
const PATH_TO = {
  confirmed: ['confirmed'],
  processing: ['confirmed', 'processing'],
  ready_to_ship: ['confirmed', 'processing', 'ready_to_ship'],
  shipped: ['confirmed', 'processing', 'ready_to_ship', 'shipped'],
  delivered: ['confirmed', 'processing', 'ready_to_ship', 'shipped', 'delivered'],
};

/** Đưa đơn tới trạng thái đích bằng cách đi đúng từng bước */
async function advanceTo(orderId, target, token) {
  for (const status of PATH_TO[target]) {
    if (status === 'shipped') await call('PUT', `/api/admin/orders/${orderId}/shipping`, { token, body: { carrier:'Vận chuyển kiểm thử', trackingNumber:`TEST-${orderId}` } });
    const res = await call('PUT', `/api/admin/orders/${orderId}/status`, { token, body: { status } });
    if (res.status !== 200) return res;
  }
  return { status: 200 };
}

async function main() {
  await db.connect();
  /* ============ CHUẨN BỊ ============ */
  const admin = await call('POST', '/api/auth/login', { body: { email: 'admin@velathier.vn', password: 'admin123' } });
  if (admin.status !== 200) { console.error('Không đăng nhập được admin:', admin.data); process.exit(1); }
  const adminToken = admin.data.token;

  const products = (await call('GET', '/api/products')).data;
  const candidates = products.flatMap((p) => p.variants.map((v) => ({ p, v }))).sort((a, b) => b.v.stock - a.v.stock);
  const { p: p1, v: v1 } = candidates[0];
  const soldOut = products.flatMap((p) => p.variants.map((v) => ({ p, v }))).find((x) => x.v.stock === 0);

  // Hai khách hàng để kiểm tra cách ly dữ liệu
  const mkUser = async () => {
    const email = `test${rnd()}@velathier.vn`;
    const reg = await call('POST', '/api/auth/register', {
      body: { name: 'Khách Kiểm Thử', email, password: 'matkhau123', phone: '0901234567' },
    });
    return { email, token: reg.data.token, user: reg.data.user, status: reg.status };
  };
  const A = await mkUser();
  const B = await mkUser();

  /* ============ XÁC THỰC ============ */
  section('XÁC THỰC');
  check('Đăng ký trả về token', A.status === 201 && !!A.token);
  check('Tài khoản mới chưa xác minh email', A.user.emailVerified === false);
  check('API không trả về hash mật khẩu', !JSON.stringify(A.user).includes('$2'));

  const wrongPass = await call('POST', '/api/auth/login', { body: { email: A.email, password: 'saibet123' } });
  check('Đăng nhập sai mật khẩu bị từ chối', wrongPass.status === 400);

  const dupe = await call('POST', '/api/auth/register', {
    body: { name: 'Trùng', email: A.email, password: 'matkhau123' },
  });
  check('Không cho đăng ký trùng email', dupe.status === 409);

  const weak = await call('POST', '/api/auth/register', {
    body: { name: 'Yếu', email: `w${rnd()}@velathier.vn`, password: '123' },
  });
  check('Từ chối mật khẩu yếu', weak.status === 400);

  const noAuth = await call('GET', '/api/auth/me');
  check('/me không token trả 401', noAuth.status === 401);

  /* ============ CHẶN ĐẶT HÀNG KHI CHƯA XÁC MINH EMAIL ============ */
  section('XÁC MINH EMAIL');
  const beforeVerify = await call('POST', '/api/orders', {
    token: A.token,
    body: {
      items: [{ productId: p1.id, variantId: v1.id, qty: 1 }],
      address: { fullName: 'Nguyễn Văn A', phone: '0901234567', provinceCode: '01', wardCode: '00004', line1: '1 Test' },
      payMethod: 'cod',
    },
  });
  check('Chưa xác minh email thì không đặt được hàng', beforeVerify.status === 403 && beforeVerify.data.code === 'EMAIL_NOT_VERIFIED');

  /**
   * Lấy mã OTP để chạy kiểm thử.
   * Đọc trực tiếp MongoDB chứ KHÔNG qua API — vì API cố tình không bao giờ trả
   * nội dung email chứa OTP (kể cả cho admin). Chỉ làm được ở môi trường phát triển,
   * nơi nội dung email vẫn được lưu lại.
   */
  const grabOtp = async (email, template) => {
    const data = { emails: await db.models.emails.find({ to: email, template }).sort({ createdAt: -1 }).lean() };
    // Email mới nhất nằm đầu danh sách
    const mail = (data.emails || []).find((m) => m.to === email && m.template === template);
    if (!mail || !mail.html) return null;
    const match = mail.html.match(/letter-spacing:\.34em[^>]*>\s*(\d{6})/);
    return match ? match[1] : null;
  };

  const verifyCode = await grabOtp(A.email, 'verifyEmail');
  check('Email xác minh có chứa mã 6 số', !!verifyCode);

  const badOtp = await call('POST', '/api/auth/verify-email/confirm', { token: A.token, body: { code: '000000' } });
  check('OTP sai bị từ chối', badOtp.status === 400);

  const okOtp = await call('POST', '/api/auth/verify-email/confirm', { token: A.token, body: { code: verifyCode } });
  check('OTP đúng xác minh được email', okOtp.status === 200 && okOtp.data.user.emailVerified === true);

  const reuseOtp = await call('POST', '/api/auth/verify-email/confirm', { token: A.token, body: { code: verifyCode } });
  check('OTP đã dùng không thể tái sử dụng', reuseOtp.status === 200 && reuseOtp.data.ok === true);

  // Xác minh cho khách B để dùng ở các phần sau
  const codeB = await grabOtp(B.email, 'verifyEmail');
  await call('POST', '/api/auth/verify-email/confirm', { token: B.token, body: { code: codeB } });

  /* ============ QUÊN MẬT KHẨU ============ */
  section('QUÊN MẬT KHẨU (OTP)');
  const forgotUnknown = await call('POST', '/api/auth/forgot-password', { body: { email: `khongton${rnd()}@velathier.vn` } });
  check('Không tiết lộ email có tồn tại hay không', forgotUnknown.status === 200 && forgotUnknown.data.ok === true);

  await call('POST', '/api/auth/forgot-password', { body: { email: B.email } });
  const resetCode = await grabOtp(B.email, 'resetPassword');
  check('Nhận được mã đặt lại mật khẩu', !!resetCode);

  const skipOtp = await call('POST', '/api/auth/forgot-password/reset', {
    body: { email: B.email, password: 'matkhaumoi123', confirmPassword: 'matkhaumoi123', ticket: 'gia-mao' },
  });
  check('Không thể bỏ qua bước OTP để đổi mật khẩu', skipOtp.status === 400);

  const wrongCode = await call('POST', '/api/auth/forgot-password/verify', { body: { email: B.email, code: '111111' } });
  check('Mã đặt lại sai bị từ chối', wrongCode.status === 400);

  const verified = await call('POST', '/api/auth/forgot-password/verify', { body: { email: B.email, code: resetCode } });
  check('Mã đúng trả về ticket', verified.status === 200 && !!verified.data.ticket);

  const mismatch = await call('POST', '/api/auth/forgot-password/reset', {
    body: { email: B.email, password: 'matkhaumoi123', confirmPassword: 'khackhac123', ticket: verified.data.ticket },
  });
  check('Mật khẩu nhập lại không khớp bị chặn', mismatch.status === 400);

  const reset = await call('POST', '/api/auth/forgot-password/reset', {
    body: { email: B.email, password: 'matkhaumoi123', confirmPassword: 'matkhaumoi123', ticket: verified.data.ticket },
  });
  check('Đặt lại mật khẩu thành công', reset.status === 200);

  const oldLogin = await call('POST', '/api/auth/login', { body: { email: B.email, password: 'matkhau123' } });
  check('Mật khẩu cũ không dùng được nữa', oldLogin.status === 400);

  const newLogin = await call('POST', '/api/auth/login', { body: { email: B.email, password: 'matkhaumoi123' } });
  check('Đăng nhập được bằng mật khẩu mới', newLogin.status === 200);
  B.token = newLogin.data.token;

  const reuseTicket = await call('POST', '/api/auth/forgot-password/reset', {
    body: { email: B.email, password: 'lainuadi123', confirmPassword: 'lainuadi123', ticket: verified.data.ticket },
  });
  check('Ticket dùng một lần, không tái sử dụng', reuseTicket.status === 400);

  /* ============ VOUCHER ============ */
  section('VOUCHER');
  const vc = async (code, subtotal, token = A.token) =>
    call('POST', '/api/vouchers/validate', { token, body: { code, subtotal } });

  const valid = await vc('WELCOME10', 500000);
  check('WELCOME10 hợp lệ', valid.status === 200 && valid.data.voucher.discount === 50000);

  const lower = await vc('welcome10', 500000);
  check('Mã không phân biệt hoa thường', lower.status === 200);

  const spaced = await vc('  WELCOME10  ', 500000);
  check('Mã tự cắt khoảng trắng', spaced.status === 200);

  const invalid = await vc('KHONGTONTAI', 500000);
  check('Mã không tồn tại bị từ chối', invalid.status === 400 && invalid.data.reason === 'NOT_FOUND');

  const capped = await vc('WELCOME10', 5000000);
  check('Giảm giá bị chặn ở mức tối đa', capped.status === 200 && capped.data.voucher.discount === 150000);

  const belowMin = await vc('SALE20', 500000);
  check('Chưa đạt giá trị tối thiểu bị từ chối', belowMin.status === 400 && belowMin.data.reason === 'MIN_ORDER');

  /* ============ TÍNH TIỀN & PHÍ SHIP ============ */
  section('PHÍ VẬN CHUYỂN');
  const quote = async (qty, voucherCode, token = A.token) =>
    call('POST', '/api/orders/quote', { token, body: { items: [{ productId: p1.id, variantId: v1.id, qty }], voucherCode } });

  const q1 = await quote(1);
  check('Đơn nhỏ chịu phí ship 40.000₫', q1.data.shippingFee === 40000, `nhận ${q1.data.shippingFee}`);
  check('Tổng = tạm tính + phí ship', q1.data.total === q1.data.subtotal + 40000);

  const q3 = await quote(3);
  const expectFree = q3.data.discountedSubtotal >= 750000;
  check(
    `Đơn ${q3.data.discountedSubtotal.toLocaleString('vi-VN')}₫ ${expectFree ? 'được' : 'không được'} miễn ship`,
    expectFree ? q3.data.shippingFee === 0 : q3.data.shippingFee === 40000
  );

  // Ngưỡng miễn phí tính SAU khi trừ voucher
  const qv = await quote(3, 'WELCOME10');
  const afterVoucher = qv.data.discountedSubtotal;
  check(
    'Ngưỡng miễn ship tính sau khi trừ voucher',
    afterVoucher >= 750000 ? qv.data.shippingFee === 0 : qv.data.shippingFee === 40000,
    `sau voucher ${afterVoucher}, ship ${qv.data.shippingFee}`
  );
  check('Có thông tin còn thiếu bao nhiêu để miễn ship', typeof qv.data.freeShippingShortBy === 'number');

  /* ============ TỒN KHO THEO BIẾN THỂ ============ */
  section('TỒN KHO THEO MÀU + SIZE');
  check('Sản phẩm có nhiều biến thể riêng biệt', p1.variants.length > 1);
  check('Không còn trường stock chung', p1.stock === undefined);

  if (soldOut) {
    const outOrder = await call('POST', '/api/orders', {
      token: A.token,
      body: {
        items: [{ productId: soldOut.p.id, variantId: soldOut.v.id, qty: 1 }],
        address: { fullName: 'Nguyễn Văn A', phone: '0901234567', provinceCode: '01', wardCode: '00004', line1: '1 Test' },
        payMethod: 'cod',
      },
    });
    check('Không đặt được biến thể đã hết hàng', outOrder.status === 400);
  }

  const tooMany = await call('POST', '/api/orders/quote', {
    token: A.token,
    body: { items: [{ productId: p1.id, variantId: v1.id, qty: v1.stock + 100 }] },
  });
  check('Số lượng vượt tồn kho bị từ chối', tooMany.status === 400);

  /* ============ CHỐNG GIẢ MẠO GIÁ ============ */
  section('CHỐNG GIẢ MẠO GIÁ');
  const tampered = await call('POST', '/api/orders', {
    token: A.token,
    body: {
      items: [{ productId: p1.id, variantId: v1.id, qty: 1, price: 1000 }],
      subtotal: 1000, discount: 999999, shippingFee: 0, total: 1,
      address: { fullName: 'Nguyễn Văn A', phone: '0901234567', provinceCode: '01', wardCode: '00004', line1: '1 Test' },
      payMethod: 'cod',
    },
  });
  check('Server bỏ qua giá client gửi lên', tampered.status === 201 && tampered.data.total === p1.price + 40000,
    `nhận ${tampered.data.total}, mong đợi ${p1.price + 40000}`);
  const orderA = tampered.data;

  const fakeVoucher = await call('POST', '/api/orders', {
    token: A.token,
    body: {
      items: [{ productId: p1.id, variantId: v1.id, qty: 1 }],
      voucherCode: 'KHONGCOTHAT',
      address: { fullName: 'Nguyễn Văn A', phone: '0901234567', provinceCode: '01', wardCode: '00004', line1: '1 Test' },
      payMethod: 'cod',
    },
  });
  check('Voucher giả bị từ chối khi tạo đơn', fakeVoucher.status === 400);

  /* ============ BẢO MẬT ĐƠN HÀNG ============ */
  section('BẢO MẬT ĐƠN HÀNG');
  const anon = await call('GET', '/api/orders/' + orderA.id);
  check('Khách chưa đăng nhập không xem được đơn', anon.status === 401);

  const crossUser = await call('GET', '/api/orders/' + orderA.id, { token: B.token });
  check('Khách B không xem được đơn của khách A', crossUser.status === 404);

  const owner = await call('GET', '/api/orders/' + orderA.id, { token: A.token });
  check('Chủ đơn xem được đơn của mình', owner.status === 200);

  const staffView = await call('GET', '/api/orders/' + orderA.id, { token: adminToken });
  check('Admin xem được mọi đơn', staffView.status === 200);

  const crossCancel = await call('POST', `/api/orders/${orderA.id}/cancel`, {
    token: B.token, body: { reason: 'Thử hủy đơn người khác' },
  });
  check('Khách B không hủy được đơn của khách A', crossCancel.status === 404);

  const guestOrder = await call('POST', '/api/orders', {
    body: {
      items: [{ productId: p1.id, variantId: v1.id, qty: 1 }],
      address: { fullName: 'Nguyễn Văn A', phone: '0901234567', provinceCode: '01', wardCode: '00004', line1: '1 Test' },
      payMethod: 'cod',
    },
  });
  check('Khách vãng lai thiếu email/vé OTP không đặt được hàng', guestOrder.status === 400);

  /* ============ CHỐNG GIẢ MẠO THANH TOÁN ============ */
  section('CHỐNG GIẢ MẠO THANH TOÁN');
  const oldConfirm = await call('POST', '/api/payment/confirm', {
    token: A.token, body: { orderId: orderA.id, result: 'success' },
  });
  check('API tự đánh dấu đã thanh toán không còn tồn tại', oldConfirm.status === 404);

  const stillPending = await call('GET', '/api/orders/' + orderA.id, { token: A.token });
  check('Đơn vẫn ở trạng thái chưa thanh toán', stillPending.data.payStatus === 'pending');

  const forgedReturn = await call('GET',
    `/api/payment/vnpay/return?vnp_Amount=100&vnp_ResponseCode=00&vnp_TransactionStatus=00&vnp_TxnRef=${orderA.id}-1&vnp_SecureHash=giamao`);
  const afterForge = await call('GET', '/api/orders/' + orderA.id, { token: A.token });
  check('Callback chữ ký giả không làm đơn thành đã thanh toán', afterForge.data.payStatus === 'pending');
  check('Callback giả bị chuyển hướng sang trang báo lỗi', String(forgedReturn.headers.get('location') || '').includes('vnp=invalid'));

  const ipnForged = await call('GET', '/api/payment/vnpay/ipn?vnp_TxnRef=DH1&vnp_SecureHash=giamao');
  check('IPN chữ ký sai trả mã 97', ipnForged.data.RspCode === '97');

  const crossPay = await call('POST', '/api/payment/vnpay/create', { token: B.token, body: { orderId: orderA.id } });
  check('Khách B không tạo được link thanh toán cho đơn của A', crossPay.status === 404);

  /* ============ LUỒNG VNPAY THẬT ============ */
  section('LUỒNG THANH TOÁN VNPAY');
  const vnpOrder = (await call('POST', '/api/orders', {
    token: A.token,
    body: {
      items: [{ productId: p1.id, variantId: v1.id, qty: 1 }],
      address: { fullName: 'Nguyễn Văn A', phone: '0901234567', provinceCode: '01', wardCode: '00004', line1: '1 Test' },
      payMethod: 'vnpay',
    },
  })).data;

  const link = await call('POST', '/api/payment/vnpay/create', { token: A.token, body: { orderId: vnpOrder.id } });
  check('Tạo được link thanh toán có chữ ký', /vnp_SecureHash=[a-f0-9]{128}/.test(link.data.url));

  const sandboxHtml = (await call('GET', link.data.url.replace(BASE, ''))).data;
  const successHref = String(sandboxHtml).match(/href="([^"]*vnp_ResponseCode=00[^"]*)"/)[1].replace(/&amp;/g, '&');
  await call('GET', successHref);

  const paid = await call('GET', '/api/orders/' + vnpOrder.id, { token: A.token });
  check('Thanh toán hợp lệ được ghi nhận', paid.data.payStatus === 'paid' && paid.data.status === 'confirmed');

  const stockBefore = (await call('GET', '/api/products/' + p1.id)).data.variants.find((x) => x.id === v1.id).stock;
  await call('GET', successHref);
  const stockAfter = (await call('GET', '/api/products/' + p1.id)).data.variants.find((x) => x.id === v1.id).stock;
  check('Callback lặp không trừ kho thêm lần nữa', stockBefore === stockAfter);

  const ipnRepeat = await call('GET', successHref.replace('/return?', '/ipn?'));
  check('IPN cho đơn đã thanh toán trả mã 02', ipnRepeat.data.RspCode === '02');

  /* ============ HỦY ĐƠN & HOÀN KHO ============ */
  section('HỦY ĐƠN & HOÀN KHO');
  const stockBeforeCancel = (await call('GET', '/api/products/' + p1.id)).data.variants.find((x) => x.id === v1.id).stock;

  const noReason = await call('POST', `/api/orders/${orderA.id}/cancel`, { token: A.token, body: {} });
  check('Hủy đơn bắt buộc có lý do', noReason.status === 400);

  const cancelled = await call('POST', `/api/orders/${orderA.id}/cancel`, {
    token: A.token, body: { reason: 'Đổi ý không mua nữa' },
  });
  check('Khách hủy được đơn chưa giao', cancelled.status === 200 && cancelled.data.status === 'cancelled');

  const stockAfterCancel = (await call('GET', '/api/products/' + p1.id)).data.variants.find((x) => x.id === v1.id).stock;
  check('Hủy đơn hoàn lại kho', stockAfterCancel === stockBeforeCancel + 1, `${stockBeforeCancel} → ${stockAfterCancel}`);

  const cancelTwice = await call('POST', `/api/orders/${orderA.id}/cancel`, {
    token: A.token, body: { reason: 'Hủy lần hai' },
  });
  check('Không hủy được đơn đã hủy', cancelTwice.status === 400);

  const stockAfterDouble = (await call('GET', '/api/products/' + p1.id)).data.variants.find((x) => x.id === v1.id).stock;
  check('Hủy lặp không cộng kho hai lần', stockAfterDouble === stockAfterCancel);

  // Đơn đã bàn giao vận chuyển thì khách không được tự hủy
  const shipOrder = (await call('POST', '/api/orders', {
    token: A.token,
    body: {
      items: [{ productId: p1.id, variantId: v1.id, qty: 1 }],
      address: { fullName: 'Nguyễn Văn A', phone: '0901234567', provinceCode: '01', wardCode: '00004', line1: '1 Test' },
      payMethod: 'cod',
    },
  })).data;
  await advanceTo(shipOrder.id, 'shipped', adminToken);
  const lateCancel = await call('POST', `/api/orders/${shipOrder.id}/cancel`, {
    token: A.token, body: { reason: 'Muốn hủy sau khi đã gửi' },
  });
  check('Không hủy được đơn đã bàn giao vận chuyển', lateCancel.status === 403);

  /* ============ ĐỔI / TRẢ HÀNG ============ */
  section('ĐỔI / TRẢ HÀNG');
  await call('PUT', `/api/admin/orders/${shipOrder.id}/status`, { token: adminToken, body: { status: 'delivered' } });

  const delivered = await call('GET', '/api/orders/' + shipOrder.id, { token: A.token });
  check('Giao COD thành công thì ghi nhận đã thu tiền', delivered.data.payStatus === 'paid');

  const eligible = await call('GET', '/api/returns/eligibility/' + shipOrder.id, { token: A.token });
  check('Đơn vừa giao đủ điều kiện đổi/trả', eligible.data.eligible === true);
  check('Còn 7 ngày để yêu cầu', eligible.data.daysLeft === 7);

  const noPhoto = await call('POST', '/api/returns', {
    token: A.token, raw: true,
    body: (() => { const f = new FormData(); f.append('orderId', shipOrder.id); f.append('type', 'return'); f.append('reason', 'defective'); f.append('description', 'Sản phẩm bị lỗi đường may nghiêm trọng'); f.append('items', JSON.stringify([{ variantId: v1.id, qty: 1 }])); return f; })(),
  });
  check('Yêu cầu đổi/trả bắt buộc có ảnh minh chứng', noPhoto.status === 400);

  // Đơn chưa giao thì không được yêu cầu
  const freshOrder = (await call('POST', '/api/orders', {
    token: A.token,
    body: {
      items: [{ productId: p1.id, variantId: v1.id, qty: 1 }],
      address: { fullName: 'Nguyễn Văn A', phone: '0901234567', provinceCode: '01', wardCode: '00004', line1: '1 Test' },
      payMethod: 'cod',
    },
  })).data;
  const notDelivered = await call('GET', '/api/returns/eligibility/' + freshOrder.id, { token: A.token });
  check('Đơn chưa giao không đủ điều kiện đổi/trả', notDelivered.data.eligible === false);

  /* ============ PHÂN QUYỀN ============ */
  section('PHÂN QUYỀN');
  const custAdmin = await call('GET', '/api/admin/stats', { token: A.token });
  check('Khách không vào được thống kê admin', custAdmin.status === 403);

  const staffLogin = await call('POST', '/api/auth/login', { body: { email: 'staff@velathier.vn', password: 'staff123' } });
  const staffUsers = await call('GET', '/api/admin/users', { token: staffLogin.data.token });
  check('Nhân viên không xem được danh sách người dùng', staffUsers.status === 403);

  const staffOrders = await call('GET', '/api/admin/orders', { token: staffLogin.data.token });
  check('Nhân viên xem được danh sách đơn hàng', staffOrders.status === 200);

  const selfDemote = await call('PUT', '/api/admin/users/u_admin/role', { token: adminToken, body: { role: 'customer' } });
  check('Admin không tự hạ quyền chính mình', selfDemote.status === 400);

  const custProduct = await call('POST', '/api/products', { token: A.token, body: { title: 'Hàng giả', price: 1000 } });
  check('Khách không tạo được sản phẩm', custProduct.status === 403);

  /* ============ BẢO MẬT CHUNG ============ */
  section('BẢO MẬT CHUNG');
  const health = await call('GET', '/api/health');
  check('Có security header X-Content-Type-Options', health.headers.get('x-content-type-options') === 'nosniff');
  check('Có Content-Security-Policy', !!health.headers.get('content-security-policy'));
  check('Ẩn X-Powered-By', !health.headers.get('x-powered-by'));

  const users = (await call('GET', '/api/admin/users', { token: adminToken })).data;
  check('Danh sách người dùng không lộ mật khẩu', !JSON.stringify(users).includes('$2'));

  const emails = (await call('GET', '/api/admin/emails', { token: adminToken })).data;
  check('Danh sách email không kèm nội dung OTP', !JSON.stringify(emails).match(/letter-spacing/));

  /* ==================================================================
     KIỂM THỬ CÁC LỖI ĐÃ ĐƯỢC AUDIT CHỈ RA
     ================================================================== */

  /** Tạo nhanh một khách đã xác minh email */
  const mkVerifiedUser = async () => {
    const u = await mkUser();
    const code = await grabOtp(u.email, 'verifyEmail');
    await call('POST', '/api/auth/verify-email/confirm', { token: u.token, body: { code } });
    return u;
  };

  /** Đặt một đơn COD nhanh */
  const placeOrder = async (user, items, extra = {}) => {
    const res = await call('POST', '/api/orders', {
      token: user.token,
      body: {
        items,
        address: { fullName: 'Nguyễn Văn A', phone: '0901234567', provinceCode: '01', wardCode: '00004', line1: '1 Test' },
        payMethod: 'cod',
        ...extra,
      },
    });
    return res.data;
  };

  /**
   * Lấy một biến thể ĐANG còn hàng tại thời điểm gọi.
   * Các phần test phía trước đã bán bớt kho, nên không thể dùng mãi biến thể chọn
   * từ đầu — nếu không, test sẽ hỏng vì lý do không liên quan tới thứ đang kiểm tra.
   */
  const freshVariant = async (minStock = 1) => {
    const list = (await call('GET', '/api/products')).data;
    for (const product of list) {
      const variant = product.variants.find((x) => x.stock >= minStock);
      if (variant) return { product, variant };
    }
    throw new Error('Không còn biến thể nào đủ hàng để kiểm thử');
  };

  /* ============ (1) OTP KHÔNG ĐƯỢC RÒ RỈ QUA ADMIN ============ */
  section('AUDIT 1 — BẢO VỆ OTP KHỎI ADMIN');
  const mailList = (await call('GET', '/api/admin/emails', { token: adminToken })).data;
  const otpMail = mailList.find((m) => m.template === 'resetPassword' || m.template === 'verifyEmail');
  check('Email chứa OTP được đánh dấu nhạy cảm', !!otpMail && otpMail.sensitive === true);
  check('Danh sách email không kèm nội dung', mailList.every((m) => m.html === undefined));

  const orderMail = mailList.find((m) => m.template === 'orderPlaced');
  if (orderMail) {
    const full = (await call('GET', '/api/admin/emails/' + orderMail.id, { token: adminToken })).data;
    check('Email thường vẫn xem được nội dung', typeof full.html === 'string' && full.html.length > 0);
    check('Email thường không bị đánh dấu nhạy cảm', full.sensitive === false);
  }
  // API KHÔNG BAO GIỜ trả nội dung email chứa OTP — kể cả cho admin, kể cả ở
  // môi trường phát triển. Nhân viên đọc được mã của khách là chiếm được tài khoản.
  if (otpMail) {
    const otpDetail = await call('GET', '/api/admin/emails/' + otpMail.id, { token: adminToken });
    check('Admin không đọc được nội dung email OTP', otpDetail.data.html === null);
    check('Có nêu lý do che nội dung', typeof otpDetail.data.redactedReason === 'string');
    check('Phản hồi không chứa mã 6 số nào',
      !/letter-spacing:\.34em[^>]*>\s*\d{6}/.test(JSON.stringify(otpDetail.data)));
  }

  const healthCheck = await call('GET', '/api/health');
  check('Máy chủ báo đúng chế độ đang chạy', healthCheck.data.ok === true);
  check('Production không cho tắt rate limit bằng biến môi trường',
    require('./config').isProd ? healthCheck.data.rateLimit === 'on' : true);

  /* ============ (2) MÁY TRẠNG THÁI ĐƠN HÀNG ============ */
  section('AUDIT 2 — MÁY TRẠNG THÁI ĐƠN HÀNG');
  const smUser = await mkVerifiedUser();
  const smOrder = await placeOrder(smUser, [{ productId: p1.id, variantId: v1.id, qty: 1 }]);

  const jumpDelivered = await call('PUT', `/api/admin/orders/${smOrder.id}/status`, {
    token: adminToken, body: { status: 'delivered' },
  });
  check('Không nhảy thẳng pending → delivered', jumpDelivered.status === 400);

  const jumpRefunded = await call('PUT', `/api/admin/orders/${smOrder.id}/status`, {
    token: adminToken, body: { status: 'refunded' },
  });
  check('Không đặt trạng thái refunded qua API chung', jumpRefunded.status === 400);

  const jumpReturned = await call('PUT', `/api/admin/orders/${smOrder.id}/status`, {
    token: adminToken, body: { status: 'returned' },
  });
  check('Không đặt trạng thái returned qua API chung', jumpReturned.status === 400);

  const jumpCancel = await call('PUT', `/api/admin/orders/${smOrder.id}/status`, {
    token: adminToken, body: { status: 'cancelled' },
  });
  check('Không hủy đơn qua API đổi trạng thái', jumpCancel.status === 400);

  const stepConfirm = await call('PUT', `/api/admin/orders/${smOrder.id}/status`, {
    token: adminToken, body: { status: 'confirmed' },
  });
  check('Đi đúng bước pending → confirmed thì được', stepConfirm.status === 200);

  const backwards = await call('PUT', `/api/admin/orders/${smOrder.id}/status`, {
    token: adminToken, body: { status: 'pending' },
  });
  check('Không lùi trạng thái confirmed → pending', backwards.status === 400);

  const detail = await call('GET', `/api/admin/orders/${smOrder.id}`, { token: adminToken });
  check('API trả về danh sách bước hợp lệ tiếp theo', Array.isArray(detail.data.allowedTransitions)
    && detail.data.allowedTransitions.includes('processing'));

  // Đơn VNPay chưa thu tiền thì không được đánh dấu đã giao
  const unpaidVnp = (await call('POST', '/api/orders', {
    token: smUser.token,
    body: {
      items: [{ productId: p1.id, variantId: v1.id, qty: 1 }],
      address: { fullName: 'Nguyễn Văn A', phone: '0901234567', provinceCode: '01', wardCode: '00004', line1: '1 Test' },
      payMethod: 'vnpay',
    },
  })).data;
  for (const status of ['confirmed','processing','ready_to_ship','shipped']) {
    const rejected = await call('PUT', `/api/admin/orders/${unpaidVnp.id}/status`, { token: adminToken, body: { status } });
    check(`VNPay chưa thanh toán chặn ${status}`, rejected.status === 400);
  }
  const unpaidTracking = await call('PUT', `/api/admin/orders/${unpaidVnp.id}/shipping`, { token: adminToken, body: { carrier: 'Test', trackingNumber: 'TEST-UNPAID' } });
  check('VNPay chưa thanh toán chặn cập nhật vận chuyển', unpaidTracking.status === 400);
  const deliverUnpaid = await call('PUT', `/api/admin/orders/${unpaidVnp.id}/status`, {
    token: adminToken, body: { status: 'delivered' },
  });
  check('Đơn VNPay chưa thu tiền không được đánh dấu đã giao', deliverUnpaid.status === 400);

  /* ============ (3) CHỐNG TRÙNG VÀ VƯỢT SỐ LƯỢNG KHI ĐỔI/TRẢ ============ */
  section('AUDIT 3 — SỐ LƯỢNG ĐỔI/TRẢ');
  const retUser = await mkVerifiedUser();
  const retOrder = await placeOrder(retUser, [{ productId: p1.id, variantId: v1.id, qty: 2 }]);
  await advanceTo(retOrder.id, 'delivered', adminToken);

  const validProof=await require('sharp')({create:{width:32,height:32,channels:3,background:'#c24c28'}}).png().toBuffer();
  const mkReturnForm = (items, extra = {}) => {
    const f = new FormData();
    f.append('orderId', extra.orderId || retOrder.id);
    f.append('type', extra.type || 'return');
    f.append('reason', extra.reason || 'defective');
    f.append('description', extra.description || 'Sản phẩm bị lỗi đường may nghiêm trọng');
    f.append('items', JSON.stringify(items));
    f.append('photos', new Blob([validProof], { type: 'image/png' }), 'proof.png');
    return f;
  };

  const dupItems = await call('POST', '/api/returns', {
    token: retUser.token, raw: true,
    body: mkReturnForm([{ variantId: v1.id, qty: 1 }, { variantId: v1.id, qty: 1 }]),
  });
  check('Chặn gửi trùng cùng một biến thể', dupItems.status === 400 && /trùng/i.test(dupItems.data.error || ''));

  const overQty = await call('POST', '/api/returns', {
    token: retUser.token, raw: true,
    body: mkReturnForm([{ variantId: v1.id, qty: 5 }]),
  });
  check('Chặn trả nhiều hơn số đã mua', overQty.status === 400);

  const forgedProof=mkReturnForm([{variantId:v1.id,qty:1}]);forgedProof.set('photos',new Blob(['MZ fake image'],{type:'image/png'}),'fake.png');
  check('Chặn ảnh minh chứng giả định dạng',(await call('POST','/api/returns',{token:retUser.token,raw:true,body:forgedProof})).status===400);
  const firstReturn = await call('POST', '/api/returns', {
    token: retUser.token, raw: true,
    body: mkReturnForm([{ variantId: v1.id, qty: 1 }]),
  });
  check('Trả một phần được chấp nhận', firstReturn.status === 201);
  check('Ảnh đổi trả không công khai',(await call('GET',firstReturn.data.photos[0])).status===401);
  check('Khách khác không xem ảnh đổi trả',(await call('GET',firstReturn.data.photos[0],{token:B.token})).status===404);
  check('Chủ đơn xem ảnh đổi trả',(await call('GET',firstReturn.data.photos[0],{token:retUser.token})).status===200);

  const whileInProgress = await call('POST', '/api/returns', {
    token: retUser.token, raw: true,
    body: mkReturnForm([{ variantId: v1.id, qty: 1 }]),
  });
  check('Chặn tạo yêu cầu mới khi còn yêu cầu đang xử lý', whileInProgress.status === 400);

  // Hoàn tất yêu cầu đầu rồi thử trả phần còn lại + trả vượt
  const retId = firstReturn.data.id;
  await call('PUT', `/api/returns/${retId}/review`, { token: adminToken, body: { decision: 'approved' } });
  await call('PUT', `/api/returns/${retId}/receive`, { token: adminToken, body: { restock: true } });

  const overRemaining = await call('POST', '/api/returns', {
    token: retUser.token, raw: true,
    body: mkReturnForm([{ variantId: v1.id, qty: 2 }]),
  });
  check('Chặn trả vượt số lượng còn lại sau lần trả trước', overRemaining.status === 400);

  const eligibility2 = await call('GET', `/api/returns/eligibility/${retOrder.id}`, { token: retUser.token });
  check('Báo đúng số lượng còn có thể trả', eligibility2.data.remainingItems?.[0]?.remaining === 1,
    `nhận ${JSON.stringify(eligibility2.data.remainingItems)}`);

  /* ============ (4) HOÀN TIỀN THEO SỐ THỰC TRẢ SAU VOUCHER ============ */
  section('AUDIT 4 — HOÀN TIỀN SAU VOUCHER');
  const vcUser = await mkVerifiedUser();
  const vcOrder = await placeOrder(
    vcUser,
    [{ productId: p1.id, variantId: v1.id, qty: 2 }],
    { voucherCode: 'WELCOME10' }
  );
  check('Đơn có áp voucher', vcOrder.discount > 0, JSON.stringify(vcOrder.discount));

  await advanceTo(vcOrder.id, 'delivered', adminToken);
  const vcReturn = await call('POST', '/api/returns', {
    token: vcUser.token, raw: true,
    body: mkReturnForm([{ variantId: v1.id, qty: 2 }], { orderId: vcOrder.id }),
  });

  const grossValue = p1.price * 2;
  const expectedRefund = vcOrder.subtotal - vcOrder.discount;
  check(
    'Số tiền hoàn bằng số thực trả, không phải giá gốc',
    vcReturn.data.refundAmount === expectedRefund && vcReturn.data.refundAmount < grossValue,
    `hoàn ${vcReturn.data.refundAmount}, thực trả ${expectedRefund}, giá gốc ${grossValue}`
  );

  // Hoàn tiền không được vượt trần
  await call('PUT', `/api/returns/${vcReturn.data.id}/review`, { token: adminToken, body: { decision: 'approved' } });
  await call('PUT', `/api/returns/${vcReturn.data.id}/receive`, { token: adminToken, body: { restock: true } });
  const overRefund = await call('POST', `/api/returns/${vcReturn.data.id}/refund`, {
    token: adminToken, body: { amount: grossValue + 100000, reference: 'TEST123' },
  });
  check('Chặn hoàn vượt số khách đã trả', overRefund.status === 400);

  /* ============ (6) ĐỔI HÀNG: SAU KHI NHẬN HÀNG, CÙNG GIÁ TRỊ ============ */
  section('AUDIT 6 — QUY TẮC ĐỔI HÀNG');
  const exUser = await mkVerifiedUser();
  const exOrder = await placeOrder(exUser, [{ productId: p1.id, variantId: v1.id, qty: 1 }]);
  await advanceTo(exOrder.id, 'delivered', adminToken);

  const exReturn = await call('POST', '/api/returns', {
    token: exUser.token, raw: true,
    body: mkReturnForm([{ variantId: v1.id, qty: 1 }], { orderId: exOrder.id, type: 'exchange' }),
  });
  const exId = exReturn.data.id;

  const sameProduct = products.find((p) => p.id === p1.id);
  const otherVariant = sameProduct.variants.find((x) => x.id !== v1.id && x.stock > 0);

  const exBeforeApprove = await call('PUT', `/api/returns/${exId}/exchange`, {
    token: adminToken, body: { productId: p1.id, variantId: otherVariant.id, qty: 1 },
  });
  check('Không đổi hàng khi chưa duyệt', exBeforeApprove.status === 400);

  await call('PUT', `/api/returns/${exId}/review`, { token: adminToken, body: { decision: 'approved' } });
  const exBeforeReceive = await call('PUT', `/api/returns/${exId}/exchange`, {
    token: adminToken, body: { productId: p1.id, variantId: otherVariant.id, qty: 1 },
  });
  check('Không đổi hàng khi chưa nhận lại hàng cũ', exBeforeReceive.status === 400
    && /nhận lại hàng/i.test(exBeforeReceive.data.error || ''));

  await call('PUT', `/api/returns/${exId}/receive`, { token: adminToken, body: { restock: true } });

  const pricier = products.find((p) => p.price > p1.price && p.variants.some((x) => x.stock > 0));
  if (pricier) {
    const pricierVariant = pricier.variants.find((x) => x.stock > 0);
    const diffExchange = await call('PUT', `/api/returns/${exId}/exchange`, {
      token: adminToken, body: { productId: pricier.id, variantId: pricierVariant.id, qty: 1 },
    });
    check('Chặn đổi sang sản phẩm khác giá trị', diffExchange.status === 400
      && /cùng giá trị/i.test(diffExchange.data.error || ''));

    const forceDiff = await call('PUT', `/api/returns/${exId}/exchange`, {
      token: adminToken,
      body: { productId: pricier.id, variantId: pricierVariant.id, qty: 1, acknowledgeDifference: true },
    });
    check('Không thể lách bằng cờ xác nhận chênh lệch', forceDiff.status === 400);
  }

  const optionsRes = await call('GET', `/api/returns/${exId}/exchange-options`, { token: adminToken });
  check('API gợi ý sản phẩm đổi trả về đúng giá trị mục tiêu',
    optionsRes.status === 200 && optionsRes.data.targetValue === p1.price);
  check('Gợi ý chỉ gồm sản phẩm cùng giá và còn hàng',
    (optionsRes.data.options || []).every((o) => o.price === p1.price && o.variants.some((x) => x.inStock)));

  const okExchange = await call('PUT', `/api/returns/${exId}/exchange`, {
    token: adminToken, body: { productId: p1.id, variantId: otherVariant.id, qty: 1 },
  });
  check('Đổi sang biến thể cùng giá trị thành công', okExchange.status === 200
    && okExchange.data.status === 'completed');

  const exchangeTwice = await call('PUT', `/api/returns/${exId}/exchange`, {
    token: adminToken, body: { productId: p1.id, variantId: otherVariant.id, qty: 1 },
  });
  check('Không xử lý đổi hàng hai lần', exchangeTwice.status === 400);

  /* ============ (7) VÒNG ĐỜI THANH TOÁN VNPAY ============ */
  section('AUDIT 7 — VÒNG ĐỜI THANH TOÁN VNPAY');
  const payUser = await mkVerifiedUser();
  const mkVnpOrder = async () => (await call('POST', '/api/orders', {
    token: payUser.token,
    body: {
      items: [{ productId: p1.id, variantId: v1.id, qty: 1 }],
      address: { fullName: 'Nguyễn Văn A', phone: '0901234567', provinceCode: '01', wardCode: '00004', line1: '1 Test' },
      payMethod: 'vnpay',
    },
  })).data;

  const payOrder = await mkVnpOrder();
  const link1 = await call('POST', '/api/payment/vnpay/create', { token: payUser.token, body: { orderId: payOrder.id } });
  check('Link thanh toán có thời hạn', typeof link1.data.expiresInMinutes === 'number');

  const sandbox1 = (await call('GET', link1.data.url.replace(BASE, ''))).data;
  const failHref1 = String(sandbox1).match(/href="([^"]*vnp_ResponseCode=24[^"]*)"/)[1].replace(/&amp;/g, '&');

  // Tạo lần thử thứ hai → lần thứ nhất trở thành cũ
  const link2 = await call('POST', '/api/payment/vnpay/create', { token: payUser.token, body: { orderId: payOrder.id } });
  const sandbox2 = (await call('GET', link2.data.url.replace(BASE, ''))).data;
  const okHref2 = String(sandbox2).match(/href="([^"]*vnp_ResponseCode=00[^"]*)"/)[1].replace(/&amp;/g, '&');

  // Callback THẤT BẠI của lần thử cũ không được phá lần thử mới
  await call('GET', failHref1);
  const afterStaleFail = await call('GET', `/api/orders/${payOrder.id}`, { token: payUser.token });
  check('Callback thất bại của lần thử cũ không đổi trạng thái đơn',
    afterStaleFail.data.payStatus === 'pending', `nhận ${afterStaleFail.data.payStatus}`);

  // Lần thử mới thành công → ghi nhận
  await call('GET', okHref2);
  const afterSuccess = await call('GET', `/api/orders/${payOrder.id}`, { token: payUser.token });
  check('Lần thử mới thành công được ghi nhận', afterSuccess.data.payStatus === 'paid');

  // Callback thất bại đến muộn sau khi đã thanh toán → không đảo ngược
  await call('GET', failHref1);
  const afterLateFail = await call('GET', `/api/orders/${payOrder.id}`, { token: payUser.token });
  check('Callback muộn không đảo ngược đơn đã thanh toán', afterLateFail.data.payStatus === 'paid');

  // Mã giao dịch lạ không được chấp nhận
  const otherOrder = await mkVnpOrder();
  const linkOther = await call('POST', '/api/payment/vnpay/create', { token: payUser.token, body: { orderId: otherOrder.id } });
  const sandboxOther = (await call('GET', linkOther.data.url.replace(BASE, ''))).data;
  const okHrefOther = String(sandboxOther).match(/href="([^"]*vnp_ResponseCode=00[^"]*)"/)[1].replace(/&amp;/g, '&');
  // Đổi mã đơn trong callback sang đơn khác → chữ ký không còn khớp
  const forgedRef = okHrefOther.replace(otherOrder.id, payOrder.id);
  const forgedRes = await call('GET', forgedRef);
  check('Callback bị sửa mã đơn bị từ chối',
    String(forgedRes.headers.get('location') || '').includes('vnp=invalid'));

  const ipnUnknown = await call('GET',
    `/api/payment/vnpay/ipn?${okHrefOther.split('?')[1].replace(/vnp_TxnRef=[^&]*/, 'vnp_TxnRef=DH9999-000000')}`);
  check('IPN với mã giao dịch lạ không được chấp nhận',
    ipnUnknown.data.RspCode === '97' || ipnUnknown.data.RspCode === '01');

  /* ============ (8) KHÔNG GIẢ VỜ HOÀN TIỀN VNPAY ============ */
  section('AUDIT 8 — HOÀN TIỀN VNPAY THẬT');
  await advanceTo(payOrder.id, 'delivered', adminToken);
  const vnpReturn = await call('POST', '/api/returns', {
    token: payUser.token, raw: true,
    body: mkReturnForm([{ variantId: v1.id, qty: 1 }], { orderId: payOrder.id }),
  });
  await call('PUT', `/api/returns/${vnpReturn.data.id}/review`, { token: adminToken, body: { decision: 'approved' } });
  await call('PUT', `/api/returns/${vnpReturn.data.id}/receive`, { token: adminToken, body: { restock: true } });

  const vnpRefund = await call('POST', `/api/returns/${vnpReturn.data.id}/refund`, {
    token: adminToken, body: { amount: 100000 },
  });
  check('Hoàn tiền VNPay khi chưa cấu hình cổng không đánh dấu là đã hoàn',
    vnpRefund.status === 200 && vnpRefund.data.refund.status === 'pending_manual',
    `nhận ${vnpRefund.data.refund?.status}`);

  const afterPendingRefund = await call('GET', `/api/orders/${payOrder.id}`, { token: adminToken });
  check('Đơn chờ hoàn tiền không bị đánh dấu refunded', afterPendingRefund.data.status === 'refund_pending');
  check('Chưa cộng vào tổng đã hoàn', !afterPendingRefund.data.refundedTotal);
  const manualStaffToken=(await call('POST','/api/auth/login',{body:{email:'staff@velathier.vn',password:'staff123'}})).data.token;
  const staffManual=await call('POST',`/api/returns/${vnpReturn.data.id}/refund`,{token:manualStaffToken,body:{amount:100000,reference:'TEST-MANUAL-RECONCILED'}});
  check('Staff không tự xác nhận đối soát VNPay thủ công',staffManual.status===403);
  const adminManual=await call('POST',`/api/returns/${vnpReturn.data.id}/refund`,{token:adminToken,body:{amount:100000,reference:'TEST-MANUAL-RECONCILED'}});
  check('Admin xác nhận mã đối soát thủ công có ghi rõ chế độ',adminManual.status===200&&adminManual.data.refund.status==='refunded'&&/không gọi API/.test(adminManual.data.refund.statusNote));

  /* ============ (9) FAIL-SAFE KHI THIẾU HẠ TẦNG ============ */
  section('AUDIT 9 — FAIL-SAFE HẠ TẦNG');
  const payConfig = await call('GET', '/api/payment/config');
  check('API cấu hình báo trạng thái cổng thanh toán', typeof payConfig.data.vnpayEnabled === 'boolean');
  check('API cấu hình báo thời hạn thanh toán', typeof payConfig.data.paymentTtlMinutes === 'number');
  // Ở môi trường phát triển cổng giả lập được phép tồn tại
  check('Cổng giả lập chỉ bật ngoài production', payConfig.data.vnpayLive === false);

  /* ============ (10) DOANH THU KHI TỪ CHỐI TRẢ / HOÀN MỘT PHẦN ============ */
  section('AUDIT 10 — DOANH THU');
  const revUser = await mkVerifiedUser();
  const revOrder = await placeOrder(revUser, [{ productId: p1.id, variantId: v1.id, qty: 1 }]);
  await advanceTo(revOrder.id, 'delivered', adminToken);

  const statsBefore = (await call('GET', '/api/admin/stats', { token: adminToken })).data;

  // Khách xin trả hàng nhưng bị từ chối → khách giữ hàng, shop giữ tiền
  const rejReturn = await call('POST', '/api/returns', {
    token: revUser.token, raw: true,
    body: mkReturnForm([{ variantId: v1.id, qty: 1 }], { orderId: revOrder.id }),
  });
  await call('PUT', `/api/returns/${rejReturn.data.id}/review`, {
    token: adminToken, body: { decision: 'rejected', adminNote: 'Sản phẩm đã qua sử dụng' },
  });

  const statsAfterReject = (await call('GET', '/api/admin/stats', { token: adminToken })).data;
  check('Từ chối trả hàng không làm giảm doanh thu',
    statsAfterReject.revenue === statsBefore.revenue,
    `trước ${statsBefore.revenue}, sau ${statsAfterReject.revenue}`);

  // Hoàn một phần → doanh thu chỉ giảm đúng phần đã hoàn
  const partialUser = await mkVerifiedUser();
  const partialOrder = await placeOrder(partialUser, [{ productId: p1.id, variantId: v1.id, qty: 2 }]);
  await advanceTo(partialOrder.id, 'delivered', adminToken);
  const beforePartial = (await call('GET', '/api/admin/stats', { token: adminToken })).data;

  const partialRefund = await call('POST', `/api/admin/orders/${partialOrder.id}/refund`, {
    token: adminToken, body: { amount: 100000, reference: 'CK-PARTIAL-1' },
  });
  check('Ghi nhận hoàn tiền một phần thành công', partialRefund.status === 200
    && partialRefund.data.refund.status === 'refunded');

  const afterPartial = (await call('GET', '/api/admin/stats', { token: adminToken })).data;
  check('Doanh thu chỉ giảm đúng phần đã hoàn',
    beforePartial.revenue - afterPartial.revenue === 100000,
    `giảm ${beforePartial.revenue - afterPartial.revenue}`);
  check('Tổng đã hoàn được cộng dồn', afterPartial.refunded >= 100000);

  const secondPartial = await call('POST', `/api/admin/orders/${partialOrder.id}/refund`, {
    token: adminToken, body: { amount: 100000, reference: 'CK-PARTIAL-2' },
  });
  check('Hoàn phần thứ hai vẫn được chấp nhận', secondPartial.status === 200);

  const overTotal = await call('POST', `/api/admin/orders/${partialOrder.id}/refund`, {
    token: adminToken, body: { amount: 99999999, reference: 'CK-OVER' },
  });
  check('Chặn hoàn vượt tổng tiền đơn', overTotal.status === 400);

  // Doanh thu theo sản phẩm phải tính tiền THỰC thu (đã phân bổ voucher), không dùng
  // giá niêm yết — nếu không, tổng theo sản phẩm sẽ vượt doanh thu chung khi có giảm giá.
  const reportUser = await mkVerifiedUser();
  const reportOrder = await placeOrder(reportUser, [{ productId: p1.id, variantId: v1.id, qty: 2 }], { voucherCode: 'WELCOME10' });
  check('Đơn dùng voucher được tạo', !!reportOrder.id && reportOrder.discount > 0, JSON.stringify(reportOrder));
  await advanceTo(reportOrder.id, 'delivered', adminToken);

  const statsAfter = (await call('GET', '/api/admin/stats', { token: adminToken })).data;
  const soldLine = statsAfter.topProducts.find((t) => t.id === p1.id);
  check('Doanh thu theo sản phẩm không dùng giá niêm yết',
    !soldLine || soldLine.revenue <= soldLine.qty * p1.price,
    soldLine ? `${soldLine.revenue} cho ${soldLine.qty} món giá ${p1.price}` : '');
  check('Tổng doanh thu theo sản phẩm không vượt doanh thu chung',
    statsAfter.topProducts.reduce((s, t) => s + t.revenue, 0) <= statsAfter.revenue + 1);

  /* ============ (5) DỮ LIỆU CHO GIAO DIỆN ĐỔI HÀNG ============ */
  section('AUDIT 5 — DỮ LIỆU CHO GIAO DIỆN ĐỔI HÀNG');
  const uiUser = await mkVerifiedUser();
  const ui = await freshVariant(1);
  const uiOrder = await placeOrder(uiUser, [{ productId: ui.product.id, variantId: ui.variant.id, qty: 1 }]);
  await advanceTo(uiOrder.id, 'delivered', adminToken);
  const uiReturn = await call('POST', '/api/returns', {
    token: uiUser.token, raw: true,
    body: mkReturnForm([{ variantId: ui.variant.id, qty: 1 }], { orderId: uiOrder.id, type: 'exchange' }),
  });
  const uiOptions = await call('GET', `/api/returns/${uiReturn.data.id}/exchange-options`, { token: adminToken });
  check('Gợi ý đổi hàng kèm danh sách biến thể và tồn kho',
    uiOptions.status === 200
    && Array.isArray(uiOptions.data.options)
    && uiOptions.data.options.every((o) => Array.isArray(o.variants) && o.variants.every((x) => typeof x.stock === 'number')));

  const customerOptions = await call('GET', `/api/returns/${uiReturn.data.id}/exchange-options`, { token: uiUser.token });
  check('Khách không xem được gợi ý đổi hàng của quản trị', customerOptions.status === 403);

  /* ============ (11) NỘI DUNG & LIÊN HỆ THẬT ============ */
  section('AUDIT 11 — LIÊN HỆ CÓ BACKEND THẬT');
  const badContact = await call('POST', '/api/contact', {
    body: { name: 'A', email: 'khong-phai-email', content: 'ngắn' },
  });
  check('Form liên hệ validate dữ liệu', badContact.status === 400);

  const contactMsg = await call('POST', '/api/contact', {
    body: {
      name: 'Nguyễn Thị B',
      email: 'lienhe@example.com',
      phone: '0912345678',
      subject: 'product',
      content: 'Cho mình hỏi áo thun boxy size M có vừa người cao 1m70 nặng 60kg không ạ?',
    },
  });
  check('Gửi liên hệ thành công', contactMsg.status === 201 && contactMsg.data.ok === true);

  const msgList = await call('GET', '/api/contact', { token: adminToken });
  check('Nhân viên xem được tin nhắn', msgList.status === 200
    && msgList.data.some((m) => m.email === 'lienhe@example.com'));

  const msgAnon = await call('GET', '/api/contact');
  check('Khách không xem được danh sách tin nhắn', msgAnon.status === 401);

  const msgId = msgList.data.find((m) => m.email === 'lienhe@example.com').id;
  const msgUpdate = await call('PUT', `/api/contact/${msgId}/status`, {
    token: adminToken, body: { status: 'resolved' },
  });
  check('Cập nhật được trạng thái tin nhắn', msgUpdate.status === 200 && msgUpdate.data.status === 'resolved');

  const sitemap = await call('GET', '/sitemap.xml');
  check('Sitemap có trang nội dung', String(sitemap.data).includes('/about')
    && String(sitemap.data).includes('/contact'));

  const robots = await call('GET', '/robots.txt');
  check('robots.txt chặn khu vực riêng tư', String(robots.data).includes('Disallow: /admin')
    && String(robots.data).includes('Disallow: /account'));

  /* ============ (12) DỮ LIỆU BÀN GIAO ============ */
  section('AUDIT 12 — TÌNH TRẠNG DỮ LIỆU');
  const finalProducts = (await call('GET', '/api/products')).data;
  check('Sản phẩm có đủ biến thể màu + size', finalProducts.every((p) => p.variants.length > 0));
  check('Voucher WELCOME10 hoạt động được', (await vc('WELCOME10', 500000)).status === 200);

  /* ============ KẾT QUẢ ============ */
  console.log(results.join('\n'));
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Kết quả: ${passed} đạt · ${failed} lỗi`);
  console.log('─'.repeat(50));
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => { console.error('Lỗi khi chạy kiểm thử:', e); process.exitCode = 1; }).finally(() => db.close());
