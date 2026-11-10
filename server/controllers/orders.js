/**
 * Đơn hàng — tạo, xem, hủy.
 *
 * Nguyên tắc:
 *  - Tài khoản xác minh email hoặc khách có vé OTP đặt hàng một lần.
 *  - Mọi con số tiền do server tính lại từ database, không tin client.
 *  - Khách chỉ xem được đơn của chính mình; admin/staff xem được tất cả.
 */

const db = require('../db');
const pricing = require('../pricing');
const inventory = require('../inventory');
const mailer = require('../mailer');
const config = require('../config');
const crypto = require('crypto');
const otp = require('../otp');
const { provinces, validateContact, validateAddress } = require('../checkout-validation');
const { v, badRequest, forbidden, notFound, HttpError } = require('../security');

/** Vòng đời trạng thái đơn hàng */
const STATUS = {
  PENDING: 'pending',              // vừa tạo, chờ thanh toán / xác nhận
  CONFIRMED: 'confirmed',          // đã thanh toán hoặc shop đã xác nhận (COD)
  PROCESSING: 'processing',        // đang soạn hàng
  READY_TO_SHIP: 'ready_to_ship',  // đóng gói xong, chờ bàn giao
  SHIPPED: 'shipped',              // đã bàn giao đơn vị vận chuyển
  DELIVERED: 'delivered',          // giao thành công
  CANCELLED: 'cancelled',
  RETURN_REQUESTED: 'return_requested',
  RETURN_APPROVED: 'return_approved',
  RETURN_REJECTED: 'return_rejected',
  RETURNING: 'returning',
  RETURNED: 'returned',
  REFUND_PENDING: 'refund_pending',
  REFUNDED: 'refunded',
};

/** Khách được tự hủy cho tới trước khi đơn được bàn giao cho đơn vị vận chuyển */
const CUSTOMER_CANCELLABLE = [STATUS.PENDING, STATUS.CONFIRMED, STATUS.PROCESSING, STATUS.READY_TO_SHIP];

/** Trạng thái mà việc trừ kho cần được hoàn lại */
const RELEASES_STOCK = [STATUS.CANCELLED];

/** Đang trong quy trình đổi/trả — không được huỷ đơn để tránh cộng kho hai lần */
const RETURN_PIPELINE = [
  STATUS.RETURN_REQUESTED, STATUS.RETURN_APPROVED, STATUS.RETURNING,
  STATUS.RETURNED, STATUS.REFUND_PENDING, STATUS.REFUNDED,
];

const ALL_STATUSES = Object.values(STATUS);

/**
 * Máy trạng thái đơn hàng — chỉ những bước chuyển liệt kê ở đây mới hợp lệ.
 *
 * Mục đích: chặn việc nhảy cóc trạng thái (ví dụ pending → delivered để né bước
 * thanh toán, hay confirmed → refunded để né quy trình đổi/trả). Trước đây API
 * quản trị nhận bất kỳ trạng thái nào nên có thể đặt tùy ý.
 *
 * Các bước chuyển do quy trình riêng đảm nhiệm (hủy đơn, thanh toán, đổi/trả)
 * KHÔNG nằm ở đây — chúng gọi applyTransition với cờ `internal`.
 */
const TRANSITIONS = {
  [STATUS.PENDING]:        [STATUS.CONFIRMED, STATUS.PROCESSING, STATUS.CANCELLED],
  [STATUS.CONFIRMED]:      [STATUS.PROCESSING, STATUS.READY_TO_SHIP, STATUS.CANCELLED],
  [STATUS.PROCESSING]:     [STATUS.READY_TO_SHIP, STATUS.CANCELLED],
  [STATUS.READY_TO_SHIP]:  [STATUS.SHIPPED, STATUS.CANCELLED],
  [STATUS.SHIPPED]:        [STATUS.DELIVERED],
  [STATUS.DELIVERED]:      [STATUS.RETURN_REQUESTED],
  [STATUS.RETURN_REQUESTED]: [STATUS.RETURN_APPROVED, STATUS.RETURN_REJECTED],
  [STATUS.RETURN_APPROVED]:  [STATUS.RETURNING, STATUS.RETURNED],
  [STATUS.RETURNING]:      [STATUS.RETURNED],
  [STATUS.RETURNED]:       [STATUS.REFUND_PENDING, STATUS.REFUNDED],
  [STATUS.REFUND_PENDING]: [STATUS.REFUNDED],
  // Trạng thái kết thúc — không đi tiếp được nữa
  [STATUS.RETURN_REJECTED]: [STATUS.DELIVERED],
  [STATUS.CANCELLED]:      [],
  [STATUS.REFUNDED]:       [],
};

/** Trạng thái mà đơn coi như đã đóng, không cho thao tác nghiệp vụ tiếp */
const TERMINAL_STATUSES = [STATUS.CANCELLED, STATUS.REFUNDED];

const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

/** Danh sách bước tiếp theo hợp lệ — dùng để đổ dropdown ở giao diện quản trị */
const nextStatuses = (from) => TRANSITIONS[from] || [];

/**
 * Đổi trạng thái đơn hàng qua máy trạng thái.
 * @param {object} order
 * @param {string} to trạng thái đích
 * @param {object} opts
 * @param {boolean} opts.internal bỏ qua kiểm tra khi quy trình chuyên biệt gọi (hủy đơn, thanh toán, đổi/trả)
 */
function applyTransition(order, to, { internal = false } = {}) {
  require('../fulfillment').guardFulfillment(order, to);
  if (order.status === to) return false;
  if (!internal && !canTransition(order.status, to)) {
    throw badRequest(
      `Không thể chuyển đơn hàng từ "${order.status}" sang "${to}". ` +
      `Bước hợp lệ tiếp theo: ${nextStatuses(order.status).join(', ') || 'không còn bước nào'}.`
    );
  }
  order.status = to;
  return true;
}

/** Ghi một mốc vào lịch sử đơn hàng */
function addHistory(order, { status, actor, actorId, note, visibleToCustomer = true }) {
  if (!Array.isArray(order.history)) order.history = [];
  order.history.push({
    at: new Date().toISOString(),
    status: status || order.status,
    actor,          // 'customer' | 'staff' | 'admin' | 'system'
    actorId: actorId || null,
    note: note || '',
    visibleToCustomer,
  });
}

/** Khách chỉ thấy các mốc được phép; admin thấy đầy đủ */
function viewFor(order, user) {
  const isStaff = user && ['admin', 'staff'].includes(user.role);
  if (isStaff) return order;

  const { refund, guestTicketHash, requestHash, refundTransactions, ...rest } = order;
  return {
    ...rest,
    history: (order.history || []).filter((h) => h.visibleToCustomer !== false),
    // Khách chỉ cần biết trạng thái hoàn tiền, không cần thông tin nội bộ
    refund: refund ? { status: refund.status, amount: refund.amount, method: refund.method, refundedAt: refund.refundedAt || null } : null,
  };
}

/** Lấy đơn và kiểm tra quyền truy cập — dùng chung cho mọi route theo :id */
function getAuthorizedOrder(req) {
  const order = db.orders.byId(req.params.id);
  // Trả 404 (không phải 403) khi không có quyền, để không tiết lộ mã đơn nào có thật
  if (!order) throw notFound('Không tìm thấy đơn hàng');
  const isStaff = ['admin', 'staff'].includes(req.user.role);
  if (!isStaff && (order.userId||order.guestDesignOwnerId) !== req.user.id) throw notFound('Không tìm thấy đơn hàng');
  return order;
}

/* ==================== BÁO GIÁ (xem trước khi đặt) ==================== */

/**
 * Tính thử tổng tiền cho giỏ hàng hiện tại — checkout gọi để hiển thị.
 * Không tạo đơn, không trừ kho. Vẫn tính hoàn toàn ở server.
 */
const getLocations = (_req, res) => {
  res.json(provinces.map(({ code, name }) => ({ code, name })));
};

const getLocationsCodeWards = (req, res, next) => {
  const province = provinces.find((p) => String(p.code) === req.params.code);
  if (!province) return next(badRequest('Tỉnh/thành không hợp lệ'));
  res.json(province.wards.map(({ code, name }) => ({ code, name })));
};

const postGuestSendCode = async (req, res) => {
  if (!config.features.otpFlowsEnabled) {
    throw new HttpError(503, 'Hệ thống email đang tạm ngưng. Vui lòng thử lại sau.', 'EMAIL_SERVICE_UNAVAILABLE');
  }
  const contact = validateContact(req.body);
  const result = otp.issue(contact.email, otp.PURPOSE.GUEST_CHECKOUT);
  if (result.cooldown) return res.status(429).json({ error: `Vui lòng đợi ${result.cooldown} giây để gửi lại mã.`, retryAfter: result.cooldown });
  const delivery = await mailer.send(contact.email, 'guestCheckout', contact, result.code);
  if (!delivery.ok) {
    db.otps.remove(contact.email, otp.PURPOSE.GUEST_CHECKOUT);
    throw new HttpError(503, 'Chưa gửi được email xác minh. Vui lòng thử lại sau.', 'EMAIL_SERVICE_UNAVAILABLE');
  }
  res.json({ ok: true, mode: delivery.mode, expiresAt: result.expiresAt, retryAfter: config.otp.resendCooldownSeconds });
};

const postGuestVerifyCode = async (req, res) => {
  const email = v.email(req.body.email);
  const code = v.str(req.body.code, 'mã OTP', { min: 6, max: 6 });
  if (!/^\d{6}$/.test(code)) throw badRequest('Mã OTP phải gồm 6 chữ số');
  const result = otp.verify(email, otp.PURPOSE.GUEST_CHECKOUT, code);
  if (!result.ok) throw badRequest(result.message);
  res.json({ ticket: result.ticket, expiresAt: Date.now() + 10 * 60 * 1000 });
};

const postQuote = async (req, res) => {
  const { lines, subtotal } = pricing.buildLines(req.body.items, req.user||req.printActor);
  if (!req.user && req.body.voucherCode) throw badRequest('Vui lòng đăng nhập để sử dụng mã giảm giá');
  const totals = pricing.computeTotals(subtotal, req.body.voucherCode, req.user?.id);

  res.json({
    items: lines,
    subtotal: totals.subtotal,
    discount: totals.discount,
    discountedSubtotal: totals.discountedSubtotal,
    shippingFee: totals.shippingFee,
    total: totals.total,
    voucher: totals.voucher,
    voucherError: totals.voucherError ? totals.voucherError.message : null,
    freeShipping: totals.freeShipping,
    freeShippingShortBy: totals.freeShippingShortBy,
    freeShippingThreshold: config.shipping.freeThreshold,
  });
};

/* ==================== TẠO ĐƠN ==================== */

const post = async (req, res) => {
  const guest = !req.user;
  const hasCustom = Array.isArray(req.body.items) && req.body.items.some(i=>i.itemType==='custom'||i.designRevisionId);
  const requestKey = hasCustom || req.body.requestKey ? v.str(req.body.requestKey,'mã yêu cầu đặt hàng',{min:10,max:100}) : null;
  const requestHash = requestKey ? require('../custom-print').hash(req.body) : null;
  if (requestKey && req.user) {
    const existing = db.orders.byUser(req.user.id).find(o=>o.requestKey===requestKey);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new HttpError(409,'Mã yêu cầu đã được dùng với giỏ hàng khác');
      return res.json(viewFor(existing,req.user));
    }
  }
  const customerEmail = guest ? v.email(req.body.email) : req.user.email;
  const ticket = guest ? v.str(req.body.guestTicket, 'mã xác minh email', { min: 64, max: 64 }) : null;
  const guestTicketHash = guest ? crypto.createHash('sha256').update(ticket).digest('hex') : null;
  // Một vé OTP chỉ tạo một đơn; retry sau lỗi mạng trả lại đúng đơn đã tạo.
  const previous = guest && db.orders.all().find((o) => o.guestTicketHash === guestTicketHash && o.customerEmail === customerEmail);
  if (previous) return res.status(200).json(viewFor(previous, null));
  const payMethod = v.oneOf(req.body.payMethod || 'cod', ['cod', 'vnpay', 'vietqr'], 'phương thức thanh toán');
  if (guest && payMethod !== 'cod') throw badRequest('Khách chưa đăng nhập vui lòng chọn thanh toán khi nhận hàng (COD)');
  if (guest && req.body.voucherCode) throw badRequest('Vui lòng đăng nhập để sử dụng mã giảm giá');

  // Cổng thanh toán không khả dụng thì từ chối ngay, không tạo đơn treo
  if (payMethod === 'vnpay' && !config.features.vnpayEnabled) {
    throw badRequest('Thanh toán trực tuyến hiện không khả dụng. Vui lòng chọn thanh toán khi nhận hàng.');
  }
  if (payMethod === 'vietqr' && !config.features.vietqrEnabled) {
    throw badRequest('Chuyển khoản ngân hàng hiện không khả dụng. Vui lòng chọn thanh toán khi nhận hàng.');
  }

  // Địa chỉ giao hàng: chọn từ sổ địa chỉ hoặc nhập trực tiếp
  let shippingAddress;
  if (guest) {
    if (req.body.addressId) throw badRequest('Vui lòng nhập địa chỉ giao hàng');
    shippingAddress = validateAddress({ ...req.body.address, email: customerEmail });
  } else if (req.body.addressId) {
    const saved = (req.user.addresses || []).find((a) => a.id === req.body.addressId);
    if (!saved) throw badRequest('Địa chỉ giao hàng không hợp lệ');
    shippingAddress = { ...saved };
    delete shippingAddress.isDefault;
  } else {
    const a = req.body.address || {};
    shippingAddress = {
      fullName: v.str(a.fullName, 'họ tên người nhận', { min: 2, max: 80 }),
      phone: v.phone(a.phone),
      province: v.str(a.province, 'Tỉnh/Thành phố', { max: 100 }),
      district: v.str(a.district, 'Quận/Huyện', { max: 100 }),
      ward: v.str(a.ward, 'Phường/Xã', { max: 100 }),
      line1: v.str(a.line1, 'địa chỉ chi tiết', { min: 3, max: 200 }),
      note: v.str(a.note, 'ghi chú', { required: false, max: 200 }),
    };
  }

  // Server dựng lại dòng hàng và tính tiền — bỏ qua hoàn toàn số liệu client gửi lên
  const { lines, subtotal } = pricing.buildLines(req.body.items, req.user||req.printActor);
  const totals = pricing.computeTotals(subtotal, req.body.voucherCode, req.user?.id);

  // Chặn mọi trường hợp tổng tiền khách nhìn thấy khác tổng server tính — kể cả
  // giỏ thường. Trước đây chỉ so với dòng hàng in tùy chỉnh, nên khi giá/tồn thay đổi
  // giữa lúc xem và lúc bấm đặt, đơn được tạo ở mức tiền khác con số trên màn hình.
  if (req.body.acceptedTotal !== undefined && Number(req.body.acceptedTotal) !== totals.total) {
    throw new HttpError(409, 'Giá đã thay đổi trong lúc bạn đặt hàng. Vui lòng xem lại tổng tiền rồi đặt lại.', 'QUOTE_CHANGED');
  }

  // Client gửi voucher không dùng được thì báo lỗi rõ ràng thay vì âm thầm bỏ qua
  if (req.body.voucherCode && totals.voucherError) throw badRequest(totals.voucherError.message);

  // Kiểm tra toàn bộ dữ liệu trước khi dùng vé; không có await từ đây tới lúc lưu đơn.
  if (guest) otp.consumeTicket(customerEmail, otp.PURPOSE.GUEST_CHECKOUT, ticket);

  const order = {
    id: db.orders.nextId(),
    ...(requestKey ? { requestKey, requestHash } : {}),
    userId: req.user?.id || null,
    ...(guest&&req.printActor?{guestDesignOwnerId:req.printActor.id}:{}),
    customerEmail,
    ...(guest ? { guestTicketHash, customerEmailVerified: true } : {}),
    items: lines,
    shippingAddress,
    subtotal: totals.subtotal,
    discount: totals.discount,
    voucher: totals.voucher,
    shippingFee: totals.shippingFee,
    total: totals.total,
    payMethod,
    payStatus: 'pending',
    status: STATUS.PENDING,
    stockState: 'none',
    payment: null,
    shipping: { carrier: '', trackingNumber: '', handedOverAt: null, deliveredAt: null },
    cancel: null,
    refund: null,
    history: [],
    createdAt: new Date().toISOString(),
  };

  addHistory(order, { status: STATUS.PENDING, actor: 'customer', actorId: req.user?.id, note: 'Đơn hàng được tạo' });

  // Trừ kho ngay khi tạo đơn (giữ hàng cho khách). Nếu không đủ hàng sẽ throw ở đây
  // và đơn chưa được lưu → không phát sinh đơn rác.
  inventory.reserve(order);

  // Ghi nhận lượt dùng voucher — làm sau khi giữ hàng thành công
  if (totals.voucher) {
    db.transaction(() => {
      const voucher = db.vouchers.byId(totals.voucher.id);
      if (voucher) {
        voucher.usedCount = (voucher.usedCount || 0) + 1;
        if (!Array.isArray(voucher.usedBy)) voucher.usedBy = [];
        voucher.usedBy.push(req.user.id);
      }
    });
  }

  db.orders.insert(order);
  require('../custom-print').createJobs(order);
  db.saveNow();
  const delivery = await mailer.send(customerEmail, 'orderPlaced', order);

  res.status(201).json({ ...viewFor(order, req.user), emailDelivery: delivery.queued ? 'queued' : delivery.ok ? delivery.mode : 'failed' });
};

/* ==================== XEM ĐƠN ==================== */

const getMine = async (req, res) => {
  const list = db.orders.byUser(req.user.id).map((o) => viewFor(o, req.user));
  res.json(list);
};

const getId = async (req, res) => {
  const order = getAuthorizedOrder(req);
  res.json(viewFor(order, req.user));
};

/* ==================== HỦY ĐƠN ==================== */

const postIdCancel = async (req, res) => {
  const order = getAuthorizedOrder(req);
  const isStaff = ['admin', 'staff'].includes(req.user.role);
  const reason = v.str(req.body.reason, 'lý do hủy', { min: 3, max: 300 });

  if (order.cancel) {
    if (order.items.some(i=>i.itemType==='custom')) return res.json(viewFor(order,req.user));
    throw badRequest('Đơn hàng đã được hủy trước đó');
  }
  require('../custom-print').guardCancel(order, req.user, req.body.productionException);

  // Khách chỉ được hủy trước khi hàng bàn giao cho đơn vị vận chuyển. Admin linh hoạt hơn.
  if (!isStaff && !CUSTOMER_CANCELLABLE.includes(order.status)) {
    throw forbidden('Đơn hàng đã được bàn giao cho đơn vị vận chuyển nên không thể tự hủy. Vui lòng liên hệ cửa hàng để được hỗ trợ.');
  }
  if (isStaff && [STATUS.DELIVERED, STATUS.RETURNED, STATUS.REFUNDED].includes(order.status)) {
    throw badRequest('Không thể hủy đơn đã giao thành công. Hãy dùng quy trình đổi/trả hàng.');
  }
  // Hàng đã rời kho (đang giao) hoặc đang trong quy trình đổi/trả: huỷ ở đây sẽ cộng
  // lại tồn kho trong khi hàng vẫn nằm ngoài cửa hàng — và nếu hàng về sau đó thì
  // nhập kho lần nữa thành cộng đôi. Phải xử lý qua quy trình hoàn về người gửi.
  if (isStaff && (order.status === STATUS.SHIPPED || RETURN_PIPELINE.includes(order.status))) {
    throw badRequest(
      order.status === STATUS.SHIPPED
        ? 'Đơn đang giao cho khách. Hãy cập nhật hành trình hoàn về người gửi thay vì hủy đơn.'
        : 'Đơn đang trong quy trình đổi/trả. Hãy hoàn tất quy trình đó thay vì hủy đơn.'
    );
  }

  db.transaction(() => {
    order.status = STATUS.CANCELLED;
    order.cancel = {
      reason,
      by: isStaff ? req.user.role : 'customer',
      byId: req.user.id,
      at: new Date().toISOString(),
      ...(req.user.role === 'admin' && req.body.productionException ? { productionException: { inventoryDecision:'discard_consumed', refundDecision:'pending_if_paid' } } : {}),
    };
    addHistory(order, {
      status: STATUS.CANCELLED,
      actor: isStaff ? req.user.role : 'customer',
      actorId: req.user.id,
      note: `Hủy đơn: ${reason}`,
    });
  });

  // Hoàn kho — idempotent, gọi lại không cộng kho hai lần
  inventory.release(order, 'Đơn hàng bị hủy');

  // Trả lại lượt dùng voucher
  if (order.voucher && !order.voucherReleased) {
    db.transaction(() => {
      const voucher = db.vouchers.byId(order.voucher.id);
      if (voucher && voucher.usedCount > 0) {
        voucher.usedCount -= 1;
        const i = (voucher.usedBy || []).indexOf(order.userId);
        if (i >= 0) voucher.usedBy.splice(i, 1);
      }
      order.voucherReleased = true;
    });
  }

  // Đơn đã thanh toán thì cần hoàn tiền — đánh dấu chờ xử lý
  if (order.payStatus === 'paid') {
    db.transaction(() => {
      order.refund = {
        status: 'pending',
        amount: order.total,
        method: order.payMethod === 'vnpay' ? 'vnpay' : 'bank_transfer',
        reason: 'Hoàn tiền do hủy đơn',
        requestedAt: new Date().toISOString(),
      };
      order.status = STATUS.REFUND_PENDING;
      addHistory(order, { status: STATUS.REFUND_PENDING, actor: 'system', note: 'Đơn đã thanh toán — chờ hoàn tiền' });
    });
  }

  db.saveNow();
  require('../custom-print').sync(order);
  mailer.send(order.customerEmail, 'orderCancelled', order);
  res.json(viewFor(order, req.user));
};

module.exports = { getLocations, getLocationsCodeWards, postGuestSendCode, postGuestVerifyCode, postQuote, post, getMine, getId, postIdCancel, STATUS, ALL_STATUSES, CUSTOMER_CANCELLABLE, RELEASES_STOCK, RETURN_PIPELINE,
  TRANSITIONS, TERMINAL_STATUSES, canTransition, nextStatuses, applyTransition,
  addHistory, viewFor, getAuthorizedOrder,
};
