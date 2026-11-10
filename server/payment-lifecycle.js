/**
 * Vòng đời thanh toán VNPay.
 *
 * Một đơn có thể được thử thanh toán nhiều lần (thất bại rồi thử lại). Mỗi lần thử
 * là một "attempt" với `vnp_TxnRef` riêng. Cổng thanh toán có thể gọi callback muộn,
 * gọi lặp, hoặc gọi cho lần thử cũ — nên phải xác định rõ từng callback thuộc lần nào.
 *
 * Quy tắc xử lý callback:
 *  - txnRef lạ                       → từ chối, không đụng vào đơn.
 *  - THÀNH CÔNG, đơn chưa thanh toán → chấp nhận, kể cả khi lần thử đó đã cũ/hết hạn,
 *                                      vì tiền đã thực sự bị trừ của khách.
 *  - THÀNH CÔNG, đơn đã thanh toán   → bỏ qua (idempotent), không cộng tiền hai lần.
 *  - THẤT BẠI cho lần thử đang hoạt động → ghi nhận và trả hàng về kho.
 *  - THẤT BẠI cho lần thử cũ         → chỉ ghi vào lịch sử, KHÔNG đổi trạng thái đơn,
 *                                      vì có thể đang có lần thử mới hợp lệ.
 *
 * Hết hạn: quá `payment.attemptTtlMinutes` mà chưa thanh toán thì hủy đơn, trả hàng
 * về kho và hoàn lượt dùng voucher, để hàng không bị giữ vô thời hạn.
 */
const db = require('./db');
const config = require('./config');
const inventory = require('./inventory');

const ATTEMPT = {
  PENDING: 'pending',
  SUCCESS: 'success',
  FAILED: 'failed',
  EXPIRED: 'expired',
  SUPERSEDED: 'superseded', // bị thay thế bởi lần thử mới hơn
};

/** Khởi tạo khối payment cho đơn nếu chưa có */
function ensurePayment(order) {
  if (!order.payment || typeof order.payment !== 'object') order.payment = {};
  if (!Array.isArray(order.payment.attempts)) order.payment.attempts = [];
  return order.payment;
}

/**
 * Ghi nhận một lần thử thanh toán mới.
 * Lần thử đang chờ trước đó (nếu có) bị đánh dấu là đã bị thay thế.
 */
function registerAttempt(order, { txnRef, live }) {
  const payment = ensurePayment(order);

  if (payment.attempts.length >= config.payment.maxAttempts) {
    const err = new Error('Đơn hàng đã vượt quá số lần thử thanh toán cho phép. Vui lòng liên hệ cửa hàng.');
    err.status = 429;
    throw err;
  }

  const now = Date.now();
  for (const attempt of payment.attempts) {
    if (attempt.status === ATTEMPT.PENDING) {
      attempt.status = ATTEMPT.SUPERSEDED;
      attempt.closedAt = new Date(now).toISOString();
    }
  }

  const attempt = {
    txnRef,
    status: ATTEMPT.PENDING,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + config.payment.attemptTtlMinutes * 60000).toISOString(),
  };
  payment.attempts.push(attempt);

  payment.gateway = 'vnpay';
  payment.live = live;
  payment.activeTxnRef = txnRef;
  payment.requestedAt = attempt.createdAt;

  return attempt;
}

const findAttempt = (order, txnRef) =>
  (order.payment?.attempts || []).find((a) => a.txnRef === txnRef) || null;

const activeAttempt = (order) => {
  const ref = order.payment?.activeTxnRef;
  return ref ? findAttempt(order, ref) : null;
};

const isExpired = (attempt) =>
  !!attempt && attempt.status === ATTEMPT.PENDING && Date.now() > new Date(attempt.expiresAt).getTime();

/**
 * Hạn thanh toán của một đơn, tính cả khi khách chưa từng mở cổng thanh toán.
 *
 * Trước đây chỉ dựa vào `attempt`, mà attempt chỉ được tạo khi khách bấm "Thanh toán".
 * Đơn được tạo rồi bị bỏ dở (đóng tab) không có attempt nào → không bao giờ hết hạn,
 * hàng bị giữ trong kho và lượt voucher bị khoá vĩnh viễn.
 *
 * @returns {number|null} mốc thời gian hết hạn (ms) hoặc null nếu đơn không có hạn
 */
function paymentDeadline(order) {
  // VietQR: hạn gắn với mã QR đã phát cho khách
  if (order.payMethod === 'vietqr') {
    const issued = order.payment?.expiresAt ? Date.parse(order.payment.expiresAt) : NaN;
    if (Number.isFinite(issued)) return issued;
    const created = Date.parse(order.createdAt);
    return Number.isFinite(created) ? created + config.payment.vietqrTtlMinutes * 60000 : null;
  }
  // VNPay: hạn của lần thử đang hoạt động, hoặc tính từ lúc tạo đơn
  const attempt = activeAttempt(order);
  if (attempt) return new Date(attempt.expiresAt).getTime();
  const created = Date.parse(order.createdAt);
  return Number.isFinite(created) ? created + config.payment.attemptTtlMinutes * 60000 : null;
}

/** Đơn chưa thanh toán và đã quá hạn giữ hàng thì phải hủy */
function isPaymentExpired(order) {
  const deadline = paymentDeadline(order);
  return deadline !== null && Date.now() > deadline;
}

/**
 * Hoàn lại lượt dùng voucher của đơn — gọi khi đơn bị hủy/hết hạn.
 * Idempotent nhờ cờ `voucherReleased`.
 */
function releaseVoucher(order) {
  if (!order.voucher || order.voucherReleased) return false;
  db.transaction(() => {
    const voucher = db.vouchers.byId(order.voucher.id);
    if (voucher) {
      voucher.usedCount = Math.max(0, (voucher.usedCount || 0) - 1);
      const index = (voucher.usedBy || []).indexOf(order.userId);
      if (index >= 0) voucher.usedBy.splice(index, 1);
    }
    order.voucherReleased = true;
  });
  return true;
}

/**
 * Hủy đơn do quá hạn thanh toán: trả hàng về kho, hoàn lượt voucher.
 * @returns {boolean} có thay đổi gì không
 */
function expireOrder(order, addHistory, STATUS) {
  if (order.payStatus === 'paid') return false;
  if (!isPaymentExpired(order)) return false;
  const attempt = activeAttempt(order);

  db.transaction(() => {
    if (attempt) {
      attempt.status = ATTEMPT.EXPIRED;
      attempt.closedAt = new Date().toISOString();
    }
    order.payStatus = 'failed';
    order.payment = order.payment && typeof order.payment === 'object' ? order.payment : {};
    order.payment.message = 'Hết hạn thanh toán';
    order.status = STATUS.CANCELLED;
    order.cancel = {
      reason: `Không hoàn tất thanh toán trong ${config.payment.attemptTtlMinutes} phút`,
      by: 'system',
      byId: null,
      at: new Date().toISOString(),
    };
    addHistory(order, {
      status: STATUS.CANCELLED,
      actor: 'system',
      note: `Hủy tự động: quá ${config.payment.attemptTtlMinutes} phút chưa thanh toán`,
    });
  });

  inventory.release(order, 'Hết hạn thanh toán');
  releaseVoucher(order);
  require('./custom-print').sync(order);
  return true;
}

/**
 * Quét toàn bộ đơn quá hạn thanh toán.
 * Chạy định kỳ, và gọi lười trước khi đọc/ghi một đơn cụ thể để số liệu luôn đúng
 * kể cả khi tiến trình vừa khởi động lại.
 */
function sweepExpired(addHistory, STATUS) {
  let count = 0;
  for (const order of db.orders.all()) {
    // Chỉ đơn trả tiền trước mới có "hạn thanh toán"; COD thu tiền khi giao hàng.
    if (order.payMethod !== 'vnpay' && order.payMethod !== 'vietqr') continue;
    if (order.payStatus === 'paid') continue;
    if (order.status === STATUS.CANCELLED) continue;
    if (expireOrder(order, addHistory, STATUS)) count++;
  }
  return count;
}

module.exports = {
  ATTEMPT,
  ensurePayment, registerAttempt, findAttempt, activeAttempt,
  isExpired, paymentDeadline, isPaymentExpired, expireOrder, sweepExpired, releaseVoucher,
};
