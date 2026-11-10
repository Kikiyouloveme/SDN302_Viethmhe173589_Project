/**
 * Unit test cho VietQR POS — chạy độc lập, không cần MongoDB.
 * Kiểm tra cấu trúc TLV, CRC và các ràng buộc đầu vào.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// Cấu hình tài khoản nhận thử nghiệm trước khi nạp module
process.env.VIETQR_BANK_BIN = '970422';
process.env.VIETQR_ACCOUNT_NO = 'VQRQANLS5394';
process.env.VIETQR_ACCOUNT_NAME = 'Hoang Minh Viet';

const vietqr = require('./vietqr');

/** Đọc các trường TLV ở một cấp: [{id, value}] */
function parse(payload) {
  const out = [];
  let i = 0;
  while (i < payload.length) {
    const id = payload.slice(i, i + 2);
    const len = Number(payload.slice(i + 2, i + 4));
    const value = payload.slice(i + 4, i + 4 + len);
    out.push({ id, value });
    i += 4 + len;
  }
  return out;
}

test('VietQR CRC-16/CCITT-FALSE khớp giá trị chuẩn', () => {
  // Kiểm thử vector chuẩn: CRC của "123456789" theo CCITT-FALSE là 29B1
  assert.equal(vietqr.crc16('123456789'), '29B1');
});

test('VietQR payload có đủ trường bắt buộc theo EMVCo', () => {
  const payload = vietqr.payload({ amount: 610000, orderId: 'DH4' });
  const fields = parse(payload);
  const ids = fields.map((f) => f.id);
  assert.deepEqual(ids, ['00', '01', '38', '53', '54', '58', '62', '63']);
  assert.equal(fields.find((f) => f.id === '00').value, '01');
  assert.equal(fields.find((f) => f.id === '01').value, '12'); // dùng một lần
  assert.equal(fields.find((f) => f.id === '53').value, '704'); // VND
  assert.equal(fields.find((f) => f.id === '54').value, '610000');
  assert.equal(fields.find((f) => f.id === '58').value, 'VN');
});

test('VietQR merchant account mang đúng BIN và số tài khoản NAPAS', () => {
  const payload = vietqr.payload({ amount: 100000, orderId: 'DH10' });
  const merchant = parse(parse(payload).find((f) => f.id === '38').value);
  assert.equal(merchant.find((f) => f.id === '00').value, 'A000000727');
  const account = parse(merchant.find((f) => f.id === '01').value);
  assert.equal(account.find((f) => f.id === '00').value, '970422');
  assert.equal(account.find((f) => f.id === '01').value, 'VQRQANLS5394');
  assert.equal(merchant.find((f) => f.id === '02').value, 'QRIBFTTA');
});

test('VietQR nội dung chuyển khoản đúng chuẩn đối soát', () => {
  // Bỏ ký tự không phải A-Z0-9-, viết hoa, tối đa 25 ký tự
  assert.equal(vietqr.contentFor('DH4'), 'DH4');
  assert.equal(vietqr.contentFor('DH-00042'), 'DH-00042');
  assert.equal(vietqr.contentFor('dh 4/2026'), 'DH42026');
  assert.equal(vietqr.contentFor('x'.repeat(40)).length, 25);
});

test('VietQR CRC trong payload tự xác thực lại được', () => {
  const payload = vietqr.payload({ amount: 285000, orderId: 'DH99' });
  const withoutCrc = payload.slice(0, -4);
  assert.equal(payload.slice(-4), vietqr.crc16(withoutCrc));
});

test('VietQR từ chối số tiền không hợp lệ', () => {
  assert.throws(() => vietqr.payload({ amount: 0, orderId: 'X' }), /không hợp lệ/);
  assert.throws(() => vietqr.payload({ amount: -5, orderId: 'X' }), /không hợp lệ/);
  assert.throws(() => vietqr.payload({ amount: 500_000_001, orderId: 'X' }), /hạn mức/);
});

test('VietQR làm tròn số tiền lẻ về đồng', () => {
  const payload = vietqr.payload({ amount: 199999.6, orderId: 'DH1' });
  assert.equal(parse(payload).find((f) => f.id === '54').value, '200000');
});

test('VietQR render trả ảnh PNG data URL và thông tin ngân hàng', async () => {
  const out = await vietqr.render({ amount: 280000, orderId: 'DH4' });
  assert.match(out.image, /^data:image\/png;base64,/);
  assert.equal(out.amount, 280000);
  assert.equal(out.content, 'DH4');
  assert.equal(out.bank.accountNo, 'VQRQANLS5394');
  assert.equal(vietqr.publicConfig().bankName, 'MB Bank');
});

test('VietQR báo chưa cấu hình khi thiếu số tài khoản', () => {
  const saved = process.env.VIETQR_ACCOUNT_NO;
  process.env.VIETQR_ACCOUNT_NO = '';
  try {
    assert.equal(vietqr.isConfigured(), false);
    assert.throws(() => vietqr.payload({ amount: 1000, orderId: 'X' }), /Chưa cấu hình/);
  } finally {
    process.env.VIETQR_ACCOUNT_NO = saved;
  }
});
