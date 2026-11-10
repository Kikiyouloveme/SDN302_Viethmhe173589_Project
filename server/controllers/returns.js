/**
 * Đổi / trả hàng và hoàn tiền.
 *
 * Nghiệp vụ:
 *  - Khách gửi yêu cầu trong 7 ngày kể từ khi đơn được giao thành công.
 *  - Bắt buộc có lý do + ảnh minh chứng.
 *  - Admin duyệt thủ công (không tự động chấp thuận chỉ vì còn trong hạn).
 *  - Khách đổi ý → khách chịu phí ship. Shop lỗi/giao sai → shop chịu.
 *  - Đổi hàng: sang sản phẩm khác cùng giá trị, tính theo giá đã ghi nhận trong đơn.
 */

const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const inventory = require('../inventory');
const pricing = require('../pricing');
const mailer = require('../mailer');
const vnpay = require('../vnpay');
const { v, badRequest, forbidden, notFound, conflict } = require('../security');
const { STATUS, addHistory } = require('./orders');

const TYPES = ['return', 'exchange'];
const REASONS = {
  changed_mind: { label: 'Đổi ý, không còn nhu cầu', faultOfShop: false },
  wrong_size: { label: 'Không vừa size', faultOfShop: false },
  not_as_described: { label: 'Không giống mô tả', faultOfShop: true },
  defective: { label: 'Sản phẩm bị lỗi', faultOfShop: true },
  wrong_item: { label: 'Giao sai sản phẩm', faultOfShop: true },
};
const RETURN_STATUS = ['pending', 'approved', 'rejected', 'receiving', 'received', 'completed'];

/** Yêu cầu còn đang xử lý — chặn tạo yêu cầu mới cho cùng đơn */
const IN_PROGRESS_STATUSES = ['pending', 'approved', 'receiving', 'received'];

/* ---------------- upload ảnh minh chứng ---------------- */

const PROOF_DIR = path.join(__dirname, '..', '..', 'assets', 'img', 'returns');
fs.mkdirSync(PROOF_DIR, { recursive: true });

const ALLOWED_IMAGE = /^image\/(png|jpe?g|webp)$/;

const uploadProof = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE.test(file.mimetype)) {
      return cb(badRequest('Chỉ chấp nhận ảnh JPG, PNG hoặc WEBP, dung lượng tối đa 5MB'));
    }
    cb(null, true);
  },
});

/* ---------------- tiện ích ---------------- */

/**
 * Tổng số lượng đã đổi/trả theo từng biến thể của một đơn.
 * Yêu cầu bị từ chối không tính, vì hàng vẫn ở chỗ khách.
 *
 * @param {string} orderId
 * @param {string} [excludeReturnId] bỏ qua một yêu cầu (khi đang sửa chính nó)
 * @returns {Record<string, number>} variantId → số lượng đã đổi/trả
 */
function returnedQtyByVariant(orderId, excludeReturnId) {
  const totals = {};
  for (const ret of db.returns.byOrder(orderId)) {
    if (ret.status === 'rejected') continue;
    if (excludeReturnId && ret.id === excludeReturnId) continue;
    for (const item of ret.items) {
      const key = item.lineId || item.variantId;
      totals[key] = (totals[key] || 0) + item.qty;
    }
  }
  return totals;
}

/** Số ngày còn lại để gửi yêu cầu đổi/trả; null nếu đơn chưa giao */
function returnWindow(order) {
  const deliveredAt = order.shipping?.deliveredAt;
  if (!deliveredAt) return null;
  const deadline = new Date(deliveredAt).getTime() + config.returnWindowDays * 86400000;
  return { deadline, expired: Date.now() > deadline, daysLeft: Math.max(0, Math.ceil((deadline - Date.now()) / 86400000)) };
}

/**
 * Đơn đã trả hết hàng chưa?
 *
 * Dùng để quyết định đóng đơn (`refunded`) hay để mở (`returned`) cho lần trả tiếp
 * theo. Hoàn tiền một phần mà đóng đơn ngay thì phần hàng còn lại sẽ không bao giờ
 * trả được nữa, dù vẫn trong 7 ngày.
 *
 * @param {object} order
 * @param {object|null} ret yêu cầu vừa hoàn tất — tính cả nó dù `db.returns` có thể chưa commit
 */
function allItemsReturned(order, ret) {
  const returned = returnedQtyByVariant(order.id);
  if (ret) {
    for (const item of ret.items) {
      const key = item.lineId || item.variantId;
      returned[key] = (returned[key] || 0) + item.qty;
    }
  }
  return order.items.every((line) => (returned[line.lineId || line.variantId] || 0) >= line.qty);
}

/** Khách không được xem thông tin ngân hàng của người khác, cũng không thấy ghi chú nội bộ */
function viewFor(ret, user) {
  const isStaff = user && ['admin', 'staff'].includes(user.role);
  if (isStaff) return ret;
  const { bankAccount, internalNote, ...rest } = ret;
  return { ...rest, bankAccount: bankAccount ? { masked: true } : null };
}

function getAuthorizedReturn(req) {
  const ret = db.returns.byId(req.params.id);
  if (!ret) throw notFound('Không tìm thấy yêu cầu');
  const isStaff = ['admin', 'staff'].includes(req.user.role);
  if (!isStaff && ret.userId !== req.user.id) throw notFound('Không tìm thấy yêu cầu');
  return ret;
}

/* ==================== KHÁCH HÀNG ==================== */

/** Kiểm tra đơn có đủ điều kiện gửi yêu cầu không — dùng để bật/tắt nút ở giao diện */
const getEligibilityOrderId = async (req, res) => {
  const order = db.orders.byId(req.params.orderId);
  if (!order || (order.userId !== req.user.id && !['admin', 'staff'].includes(req.user.role))) {
    throw notFound('Không tìm thấy đơn hàng');
  }

  const window = returnWindow(order);
  const inProgress = db.returns.byOrder(order.id).filter((r) => IN_PROGRESS_STATUSES.includes(r.status));

  // Số lượng còn có thể đổi/trả cho từng dòng hàng
  const returned = returnedQtyByVariant(order.id);
  const remainingItems = order.items
    .map((line) => ({
      lineId: line.lineId,
      variantId: line.variantId,
      title: line.title,
      color: line.color,
      size: line.size,
      img: line.img,
      purchased: line.qty,
      remaining: line.qty - (returned[line.lineId || line.variantId] || 0),
    }))
    .filter((x) => x.remaining > 0);

  // Đơn đã giao nhưng đang có yêu cầu xử lý dở thì trạng thái đơn không còn là DELIVERED,
  // nên phải xét cả các trạng thái thuộc quy trình đổi/trả. `returned` = đã trả một lần
  // nhưng còn hàng chưa trả, vẫn được gửi yêu cầu tiếp trong hạn.
  const delivered = [STATUS.DELIVERED, STATUS.RETURN_REJECTED, STATUS.RETURNED].includes(order.status);

  res.json({
    eligible: delivered && !!window && !window.expired && !inProgress.length && remainingItems.length > 0,
    reason:
      !delivered ? 'Chỉ có thể yêu cầu sau khi đơn hàng đã giao thành công'
      : !window ? 'Đơn hàng chưa được ghi nhận ngày giao'
      : window.expired ? `Đã quá hạn ${config.returnWindowDays} ngày kể từ ngày nhận hàng`
      : inProgress.length ? 'Đơn hàng này đang có yêu cầu đổi/trả được xử lý'
      : !remainingItems.length ? 'Toàn bộ sản phẩm trong đơn đã được đổi/trả'
      : null,
    daysLeft: window ? window.daysLeft : 0,
    deadline: window ? new Date(window.deadline).toISOString() : null,
    windowDays: config.returnWindowDays,
    remainingItems,
    reasons: Object.entries(REASONS).map(([value, r]) => ({ value, label: r.label })),
  });
};

const post = async (req, res) => {
  const order = db.orders.byId(req.body.orderId);
  if (!order || order.userId !== req.user.id) throw notFound('Không tìm thấy đơn hàng');

  // Điều kiện thời gian — kiểm tra ở server, không chỉ ở giao diện
  if (![STATUS.DELIVERED, STATUS.RETURN_REJECTED, STATUS.RETURNED].includes(order.status)) {
    throw badRequest('Chỉ có thể yêu cầu đổi/trả sau khi đơn hàng đã giao thành công');
  }
  const window = returnWindow(order);
  if (!window || window.expired) {
    throw forbidden(`Đã quá hạn ${config.returnWindowDays} ngày kể từ ngày nhận hàng nên không thể tạo yêu cầu`);
  }
  if (db.returns.byOrder(order.id).some((r) => IN_PROGRESS_STATUSES.includes(r.status))) {
    throw badRequest('Đơn hàng này đang có yêu cầu đổi/trả được xử lý');
  }

  const type = v.oneOf(req.body.type, TYPES, 'loại yêu cầu');
  const reasonCode = v.oneOf(req.body.reason, Object.keys(REASONS), 'lý do');
  const description = v.str(req.body.description, 'mô tả chi tiết', { min: 10, max: 1000 });

  if (!req.files || !req.files.length) throw badRequest('Vui lòng đính kèm ít nhất một ảnh minh chứng');

  // Xác định món hàng và số lượng muốn đổi/trả
  let requestedItems;
  try {
    requestedItems = JSON.parse(req.body.items || '[]');
  } catch { throw badRequest('Danh sách sản phẩm không hợp lệ'); }
  if (!Array.isArray(requestedItems) || !requestedItems.length) throw badRequest('Vui lòng chọn sản phẩm muốn đổi/trả');

  // Số lượng đã đổi/trả ở các yêu cầu trước (không tính yêu cầu bị từ chối)
  const alreadyReturned = returnedQtyByVariant(order.id);

  const seen = new Set();
  const items = requestedItems.map((requested) => {
    const candidates = order.items.filter(i => requested.lineId ? i.lineId === requested.lineId : i.variantId === requested.variantId);
    if (candidates.length > 1) throw badRequest('Cần lineId để phân biệt các thiết kế cùng biến thể');
    const line = candidates[0];
    if (!line) throw badRequest('Sản phẩm không thuộc đơn hàng này');

    // Chặn gửi trùng một biến thể nhiều dòng để lách giới hạn số lượng
    const lineKey = line.lineId || line.variantId;
    if (seen.has(lineKey)) {
      throw badRequest(`Sản phẩm "${line.title}" (${line.color}/${line.size}) bị chọn trùng nhiều lần`);
    }
    seen.add(lineKey);

    const remaining = line.qty - (alreadyReturned[lineKey] || 0);
    if (remaining <= 0) {
      throw badRequest(`"${line.title}" (${line.color}/${line.size}) đã được đổi/trả hết trong yêu cầu trước`);
    }

    const qty = v.int(requested.qty, 'số lượng', { min: 1, max: remaining });
    return {
      lineId: line.lineId,
      itemType: line.itemType || 'regular',
      productId: line.productId,
      variantId: line.variantId,
      title: line.title,
      color: line.color,
      size: line.size,
      price: line.price,   // giá đã ghi nhận lúc mua — dùng làm chuẩn khi đổi hàng
      qty,
      img: line.img,
    };
  });

  // Hoàn theo số tiền THỰC khách đã trả (đã phân bổ voucher), không theo giá gốc
  const refundAmount = pricing.refundableAmount(order, items);
  const grossValue = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  const shopAtFault = REASONS[reasonCode].faultOfShop;

  const ret = {
    id: db.returns.nextId(),
    orderId: order.id,
    userId: req.user.id,
    type,
    status: 'pending',
    reason: reasonCode,
    reasonLabel: REASONS[reasonCode].label,
    description,
    photos: await Promise.all(req.files.map(async f => {
      let bytes;
      try{const image=require('sharp')(f.buffer,{limitInputPixels:20000000,failOn:'warning'}),meta=await image.metadata();if(!['png','jpeg','webp'].includes(meta.format)||meta.pages>1)throw Error();bytes=await image.rotate().resize(1600,1600,{fit:'inside',withoutEnlargement:true}).webp().toBuffer();}catch{throw badRequest('Ảnh minh chứng hỏng hoặc sai định dạng');}
      const key=db.uid('retproof')+'.webp',storage=require('../private-storage');
      await storage.put('returns/'+key,bytes);require('../mongo-store').onRollback(()=>storage.remove('returns/'+key).catch(()=>{}));
      return '/assets/img/returns/'+key;
    })),
    items,
    refundAmount,
    // Tổng giá niêm yết của số hàng trả — dùng làm chuẩn "cùng giá trị" khi đổi hàng
    grossValue,
    // Đề xuất ban đầu theo lý do; Admin có quyền quyết định lại khi duyệt
    shippingResponsibility: shopAtFault ? 'shop' : 'customer',
    exchange: null,
    bankAccount: null,
    adminNote: '',
    internalNote: '',
    history: [{ at: new Date().toISOString(), status: 'pending', actor: 'customer', note: 'Khách gửi yêu cầu' }],
    createdAt: new Date().toISOString(),
  };

  // Trả hàng bằng COD thì cần thông tin nhận tiền hoàn
  if (type === 'return' && order.payMethod === 'cod' && req.body.bankAccountNumber) {
    ret.bankAccount = {
      holder: v.str(req.body.bankAccountHolder, 'tên chủ tài khoản', { min: 2, max: 80 }),
      number: v.str(req.body.bankAccountNumber, 'số tài khoản', { min: 6, max: 30 }),
      bank: v.str(req.body.bankName, 'tên ngân hàng', { min: 2, max: 80 }),
    };
  }

  db.returns.insert(ret);
  db.transaction(() => {
    order.status = STATUS.RETURN_REQUESTED;
    addHistory(order, {
      status: STATUS.RETURN_REQUESTED,
      actor: 'customer',
      actorId: req.user.id,
      note: `Yêu cầu ${type === 'exchange' ? 'đổi' : 'trả'} hàng ${ret.id}: ${REASONS[reasonCode].label}`,
    });
  });

  mailer.send(req.user.email, 'returnRequested', ret, order);
  res.status(201).json(viewFor(ret, req.user));
};

const getMine = async (req, res) => {
  res.json(db.returns.byUser(req.user.id).map((r) => viewFor(r, req.user)));
};

const getId = async (req, res) => {
  res.json(viewFor(getAuthorizedReturn(req), req.user));
};

/** Bổ sung thông tin ngân hàng sau khi gửi yêu cầu (dành cho hoàn tiền COD) */
const putIdBankAccount = async (req, res) => {
  const ret = getAuthorizedReturn(req);
  if (ret.userId !== req.user.id) throw forbidden();
  if (['completed'].includes(ret.status)) throw badRequest('Yêu cầu đã hoàn tất, không thể thay đổi');

  const bankAccount = {
    holder: v.str(req.body.holder, 'tên chủ tài khoản', { min: 2, max: 80 }),
    number: v.str(req.body.number, 'số tài khoản', { min: 6, max: 30 }),
    bank: v.str(req.body.bank, 'tên ngân hàng', { min: 2, max: 80 }),
  };
  db.transaction(() => { ret.bankAccount = bankAccount; });
  res.json({ ok: true });
};

/* ==================== QUẢN TRỊ ==================== */

const get = async (req, res) => {
  const { status } = req.query;
  let list = db.returns.all();
  if (status) list = list.filter((r) => r.status === status);
  res.json(list);
};

/** Duyệt hoặc từ chối yêu cầu */
const putIdReview = async (req, res) => {
  const ret = db.returns.byId(req.params.id);
  if (!ret) throw notFound('Không tìm thấy yêu cầu');
  if (ret.status !== 'pending') throw badRequest('Yêu cầu này đã được xử lý');

  const decision = v.oneOf(req.body.decision, ['approved', 'rejected'], 'quyết định');
  const adminNote = v.str(req.body.adminNote, 'ghi chú', { required: false, max: 500 });
  const order = db.orders.byId(ret.orderId);
  // Đơn phải đang chờ duyệt đúng như khi khách gửi yêu cầu. Không kiểm tra thì đơn đã
  // bị huỷ/đã hoàn tiền vẫn bị kéo ngược về "return_approved", thoát khỏi trạng thái kết thúc.
  if (order && order.status !== STATUS.RETURN_REQUESTED) {
    throw badRequest(`Đơn hàng không còn ở trạng thái chờ duyệt đổi/trả (hiện tại: ${order.status}).`);
  }

  // Admin quyết định cuối cùng ai chịu phí vận chuyển
  const responsibility = req.body.shippingResponsibility
    ? v.oneOf(req.body.shippingResponsibility, ['shop', 'customer'], 'bên chịu phí vận chuyển')
    : ret.shippingResponsibility;

  db.transaction(() => {
    ret.status = decision;
    ret.adminNote = adminNote;
    ret.shippingResponsibility = responsibility;
    ret.reviewedAt = new Date().toISOString();
    ret.reviewedBy = req.user.id;
    ret.history.push({
      at: new Date().toISOString(),
      status: decision,
      actor: req.user.role,
      note: decision === 'approved' ? 'Yêu cầu được duyệt' : `Từ chối: ${adminNote || 'không nêu lý do'}`,
    });

    if (order) {
      order.status = decision === 'approved' ? STATUS.RETURN_APPROVED : STATUS.RETURN_REJECTED;
      addHistory(order, {
        status: order.status,
        actor: req.user.role,
        actorId: req.user.id,
        note: decision === 'approved'
          ? `Duyệt yêu cầu ${ret.id}. Phí vận chuyển do ${responsibility === 'shop' ? 'cửa hàng' : 'khách hàng'} chịu.`
          : `Từ chối yêu cầu ${ret.id}: ${adminNote}`,
      });
    }
  });

  if (order) mailer.send(order.customerEmail, 'returnReviewed', ret, order);
  res.json(ret);
};

/**
 * Xác nhận đã nhận lại hàng.
 * `restock = true` khi hàng còn nguyên tem, chưa dùng, bán lại được.
 */
const putIdReceive = async (req, res) => {
  const ret = db.returns.byId(req.params.id);
  if (!ret) throw notFound('Không tìm thấy yêu cầu');
  if (ret.status !== 'approved') throw badRequest('Chỉ xác nhận nhận hàng cho yêu cầu đã được duyệt');
  if (ret.receivedAt) throw badRequest('Đã xác nhận nhận hàng trước đó');

  const restock = req.body.restock !== false;
  const order = db.orders.byId(ret.orderId);

  // Cộng lại kho — chỉ chạy một lần nhờ cờ receivedAt kiểm tra ở trên
  if (restock) {
    for (const item of ret.items) {
      if (item.itemType === 'custom') continue; // Printed garments cannot become saleable blanks.
      try { inventory.incrementVariant(item.productId, item.variantId, item.qty); }
      catch { /* sản phẩm/biến thể đã bị xoá — bỏ qua, ghi chú bên dưới */ }
    }
  }

  db.transaction(() => {
    ret.status = 'received';
    ret.receivedAt = new Date().toISOString();
    ret.restocked = restock;
    ret.history.push({
      at: ret.receivedAt,
      status: 'received',
      actor: req.user.role,
      note: restock ? 'Đã nhận hàng và nhập lại kho' : 'Đã nhận hàng, không nhập lại kho (không đủ điều kiện bán lại)',
    });
    if (order) {
      order.status = STATUS.RETURNED;
      addHistory(order, {
        status: STATUS.RETURNED,
        actor: req.user.role,
        actorId: req.user.id,
        note: `Đã nhận lại hàng của yêu cầu ${ret.id}`,
      });
    }
  });

  res.json(ret);
};

/**
 * Xử lý đổi hàng — chọn biến thể thay thế.
 * Giá so sánh dựa trên giá đã ghi nhận trong đơn (không dùng giá hiện tại) để khách
 * không bị ảnh hưởng bởi thay đổi giá sau ngày mua.
 */
const putIdExchange = async (req, res) => {
  const ret = db.returns.byId(req.params.id);
  if (!ret) throw notFound('Không tìm thấy yêu cầu');
  if (ret.type !== 'exchange') throw badRequest('Yêu cầu này không phải đổi hàng');
  // Chỉ giao hàng đổi SAU KHI đã nhận lại hàng cũ — tránh mất cả hàng lẫn tiền
  if (ret.status !== 'received') {
    throw badRequest(
      ret.status === 'approved'
        ? 'Phải xác nhận đã nhận lại hàng cũ trước khi giao sản phẩm đổi'
        : 'Yêu cầu chưa ở trạng thái cho phép xử lý đổi hàng'
    );
  }
  if (ret.exchange?.fulfilledAt) throw badRequest('Đơn đổi hàng đã được xử lý trước đó');

  const product = db.products.byId(req.body.productId);
  if (!product) throw badRequest('Sản phẩm thay thế không tồn tại');
  if (product.active === false) throw badRequest('Sản phẩm thay thế đã ngừng kinh doanh');
  const variant = db.products.variantById(product, req.body.variantId);
  if (!variant) throw badRequest('Phiên bản thay thế không tồn tại');
  if (variant.active === false) throw badRequest('Phiên bản thay thế đã ngừng bán');

  const qty = v.int(req.body.qty ?? 1, 'số lượng', { min: 1, max: 20 });

  // Giá trị đối chiếu là giá NIÊM YẾT lúc mua của hàng trả — không dùng giá hiện tại
  // để khách không bị ảnh hưởng bởi thay đổi giá sau ngày mua.
  const originalValue = ret.grossValue ?? ret.items.reduce((s, i) => s + i.price * i.qty, 0);
  const newValue = product.price * qty;
  const difference = newValue - originalValue;

  // Chính sách: chỉ đổi sang sản phẩm CÙNG GIÁ TRỊ. Không thu thêm, không hoàn lại
  // phần chênh — muốn đổi sang món giá khác thì phải trả hàng rồi đặt đơn mới.
  if (difference !== 0) {
    throw badRequest(
      difference > 0
        ? `Sản phẩm thay thế đắt hơn ${difference.toLocaleString('vi-VN')}₫. Chỉ được đổi sang sản phẩm cùng giá trị (${originalValue.toLocaleString('vi-VN')}₫). Nếu khách muốn món giá khác, hãy xử lý trả hàng và để khách đặt đơn mới.`
        : `Sản phẩm thay thế rẻ hơn ${Math.abs(difference).toLocaleString('vi-VN')}₫. Chỉ được đổi sang sản phẩm cùng giá trị (${originalValue.toLocaleString('vi-VN')}₫). Nếu khách muốn món giá khác, hãy xử lý trả hàng và để khách đặt đơn mới.`
    );
  }

  if (variant.stock < qty) {
    throw conflict(
      variant.stock === 0
        ? `"${product.title}" (${variant.color}/${variant.size}) đã hết hàng`
        : `"${product.title}" (${variant.color}/${variant.size}) chỉ còn ${variant.stock} sản phẩm`
    );
  }

  // Trừ kho sản phẩm mới — ném lỗi nếu không đủ, tránh kho âm
  inventory.decrementVariant(product.id, variant.id, qty);

  db.transaction(() => {
    ret.exchange = {
      productId: product.id,
      variantId: variant.id,
      title: product.title,
      color: variant.color,
      size: variant.size,
      qty,
      unitPrice: product.price,
      originalValue,
      newValue,
      difference: 0,
      fulfilledAt: new Date().toISOString(),
      fulfilledBy: req.user.id,
    };
    ret.status = 'completed';
    // Đổi hàng xong thì không còn gì để hoàn tiền cho phần hàng này — nếu giữ
    // refundAmount, API hoàn tiền vẫn tính được trần hoàn cho món đã đổi.
    ret.refundAmount = 0;
    ret.refundStatus = 'not_applicable';
    ret.history.push({
      at: new Date().toISOString(),
      status: 'completed',
      actor: req.user.role,
      note: `Đổi sang ${product.title} (${variant.color}/${variant.size}) × ${qty} — cùng giá trị ${originalValue.toLocaleString('vi-VN')}₫`,
    });
  });

  res.json(ret);
};

/**
 * Gợi ý sản phẩm thay thế cùng giá trị cho một yêu cầu đổi hàng.
 * Giao diện quản trị dùng để đổ danh sách chọn, tránh admin phải tự dò giá.
 */
const getIdExchangeOptions = async (req, res) => {
  const ret = db.returns.byId(req.params.id);
  if (!ret) throw notFound('Không tìm thấy yêu cầu');
  if (ret.type !== 'exchange') throw badRequest('Yêu cầu này không phải đổi hàng');

  const targetValue = ret.grossValue ?? ret.items.reduce((s, i) => s + i.price * i.qty, 0);

  // Với số lượng 1 thì sản phẩm thay thế phải có giá đúng bằng giá trị cần đổi
  const options = db.products.all()
    .filter((p) => p.active !== false && p.price === targetValue)
    .map((p) => ({
      id: p.id,
      title: p.title,
      price: p.price,
      img: p.img,
      variants: (p.variants || [])
        .filter((variant) => variant.active !== false)
        .map((variant) => ({
          id: variant.id,
          color: variant.color,
          size: variant.size,
          stock: variant.stock,
          inStock: variant.stock > 0,
        })),
    }))
    .filter((p) => p.variants.some((variant) => variant.inStock));

  res.json({
    targetValue,
    qty: 1,
    options,
    note: options.length
      ? null
      : 'Không có sản phẩm nào cùng giá trị và còn hàng. Hãy xử lý trả hàng để khách đặt đơn mới.',
  });
};

/* ==================== HOÀN TIỀN ==================== */

/**
 * Ghi nhận hoàn tiền.
 * VNPay: gọi API hoàn tiền của cổng (khi đã cấu hình credential thật).
 * COD: chuyển khoản thủ công, admin nhập mã tham chiếu giao dịch.
 */
const postIdRefund = async (req, res) => {
  const ret = db.returns.byId(req.params.id);
  if (!ret) throw notFound('Không tìm thấy yêu cầu');
  if (!['received', 'completed'].includes(ret.status)) {
    throw badRequest('Chỉ hoàn tiền sau khi đã nhận lại hàng');
  }

  const order = db.orders.byId(ret.orderId);
  if (!order) throw notFound('Không tìm thấy đơn hàng');
  if (ret.refundedAt) throw badRequest('Yêu cầu này đã được hoàn tiền');
  if (order.payStatus !== 'paid') throw badRequest('Đơn hàng chưa thanh toán nên không có gì để hoàn');

  // Trần hoàn tiền = số thực đã trả cho phần hàng trả, và không vượt phần còn lại của đơn
  const maxByItems = ret.refundAmount;
  const maxByOrder = pricing.remainingRefundable(order);
  const ceiling = Math.min(maxByItems, maxByOrder);
  if (ceiling <= 0) throw badRequest('Đơn hàng đã được hoàn hết số tiền có thể hoàn');

  const amount = v.int(req.body.amount ?? ceiling, 'số tiền hoàn', { min: 1000, max: ceiling });
  const method = order.payMethod === 'vnpay' ? 'vnpay' : 'bank_transfer';

  const result = await processRefund({
    order, ret, amount, method,
    reference: req.body.reference,
    note: req.body.note,
    actor: req.user,
    ip: req.ip,
  });

  res.json({ ok: true, refund: result });
};

/**
 * Thực hiện hoàn tiền và ghi nhận kết quả.
 *
 * Nguyên tắc: chỉ đánh dấu `refunded` khi tiền THỰC SỰ đã được hoàn.
 *  - VNPay đã cấu hình → gọi API cổng, thất bại thì ném lỗi, không ghi gì.
 *  - VNPay chưa cấu hình (môi trường phát triển) → KHÔNG được giả vờ thành công;
 *    ghi trạng thái `pending_manual` để nhân viên hoàn thủ công rồi xác nhận lại.
 *  - Chuyển khoản thủ công → bắt buộc có mã giao dịch làm bằng chứng.
 */
async function processRefund({ order, ret, amount, method, reference, note, actor, ip }) {
  let refundStatus = 'refunded';
  let gatewayRef = v.str(reference, 'mã tham chiếu', { required: false, max: 100 });
  const refundKey = ret ? `return:${ret.id}` : gatewayRef ? `reference:${gatewayRef}` : `cancel:${order.id}:${amount}`;
  const priorRefund = (order.refundTransactions || []).find(r=>r.key===refundKey);
  if (priorRefund) {
    if (priorRefund.amount !== amount || priorRefund.method !== method) throw conflict('Mã hoàn tiền đã được dùng với số tiền/phương thức khác');
    return priorRefund.result;
  }
  let statusNote = '';

  if (method === 'vnpay') {
    if (config.features.vnpayRefundEnabled) {
      const result = await vnpay.refund({
        order,
        amount,
        transactionNo: order.payment?.transactionNo,
        transactionDate: order.payment?.processedAt,
        createdBy: actor.email,
        ip,
      });
      // Cổng từ chối → dừng hẳn, không ghi nhận đã hoàn
      if (!result.ok) throw badRequest(`VNPay từ chối hoàn tiền: ${result.message}`);
      gatewayRef = result.transactionNo || gatewayRef;
    } else {
      // Chưa có credential thật thì không thể hoàn tự động — nói thẳng thay vì giả vờ
        if(gatewayRef){
          if(actor.role!=='admin')throw forbidden('Chỉ Admin được xác nhận đã đối soát hoàn tiền VNPay thủ công');
          if(gatewayRef.length<5)throw badRequest('Cần mã giao dịch đối soát tối thiểu 5 ký tự');
          statusNote='Admin đã xác nhận hoàn tiền thủ công qua đối soát mã giao dịch; hệ thống không gọi API hoàn tiền.';
        }else{
          refundStatus = 'pending_manual';
          statusNote = 'Hoàn tiền tự động chưa được bật/nghiệm thu. Hoàn và đối soát trên cổng nhà cung cấp, sau đó Admin xác nhận bằng mã giao dịch.';
        }
    }
  } else {
    // Chuyển khoản tay: không có mã giao dịch thì coi như chưa hoàn xong
    if (!gatewayRef) {
      refundStatus = 'pending_manual';
      statusNote = 'Chưa có mã giao dịch chuyển khoản. Hãy chuyển khoản rồi nhập mã để xác nhận.';
    } else {
      // Xác nhận "đã hoàn tiền" là giảm doanh thu thật, phải cùng chuẩn với nhánh VNPay:
      // chỉ Admin và phải có mã đối soát đủ dài, nếu không nhân viên gõ "1" là trừ tiền sổ sách.
      if (actor.role !== 'admin') throw forbidden('Chỉ Admin được xác nhận đã chuyển khoản hoàn tiền');
      if (gatewayRef.length < 5) throw badRequest('Cần mã giao dịch đối soát tối thiểu 5 ký tự');
      statusNote = 'Admin đã xác nhận hoàn tiền bằng chuyển khoản, đối soát theo mã giao dịch.';
    }
  }

  const now = new Date().toISOString();
  const completed = refundStatus === 'refunded';

  db.transaction(() => {
    order.refund = {
      status: refundStatus,
      amount,
      method,
      reference: gatewayRef || null,
      note: v.str(note, 'ghi chú', { required: false, max: 300 }),
      statusNote,
      processedBy: actor.id,
      requestedAt: order.refund?.requestedAt || now,
      refundedAt: completed ? now : null,
      // Chỉ lưu 4 số cuối tài khoản để đối chiếu, không lưu toàn bộ ở đơn hàng
      bankAccountLast4: ret?.bankAccount?.number ? String(ret.bankAccount.number).slice(-4) : null,
    };

    if (completed) {
      if (!Array.isArray(order.refundTransactions)) order.refundTransactions=[];
      order.refundTransactions.push({key:refundKey,amount,method,result:structuredClone(order.refund)});
      // Cộng dồn để hỗ trợ hoàn nhiều lần (hoàn từng phần)
      order.refundedTotal = (Number(order.refundedTotal) || 0) + amount;
      // Chỉ đóng đơn khi TOÀN BỘ hàng đã được trả. Khách còn hàng trong hạn 7 ngày
      // thì đơn phải tiếp tục cho gửi yêu cầu trả nốt — trước đây đặt REFUNDED ngay
      // nên lần trả sau bị chặn vĩnh viễn.
      order.status = allItemsReturned(order, ret) ? STATUS.REFUNDED : STATUS.RETURNED;
    } else {
      order.status = STATUS.REFUND_PENDING;
    }

    addHistory(order, {
      status: order.status,
      actor: actor.role,
      actorId: actor.id,
      note: completed
        ? `Đã hoàn ${amount.toLocaleString('vi-VN')}₫ qua ${method === 'vnpay' ? 'VNPay' : 'chuyển khoản'}`
        : `Chờ hoàn ${amount.toLocaleString('vi-VN')}₫ — ${statusNote}`,
    });

    if (ret) {
      ret.refundStatus = refundStatus;
      if (completed) {
        ret.status = 'completed';
        ret.refundedAt = now;
      }
      ret.history.push({
        at: now,
        status: ret.status,
        actor: actor.role,
        note: completed
          ? `Đã hoàn ${amount.toLocaleString('vi-VN')}₫`
          : `Chờ hoàn tiền ${amount.toLocaleString('vi-VN')}₫`,
      });
    }
  });

  if (completed) mailer.send(order.customerEmail, 'refunded', order);
  require('../custom-print').event(order, `${order.id}:refund:${ret?.id || 'cancel'}:${completed ? order.refundedTotal : 'pending'}`, completed ? 'Đã xử lý hoàn tiền.' : 'Đang chờ xử lý hoàn tiền.');
  return order.refund;
}

module.exports = { getEligibilityOrderId, post, getMine, getId, putIdBankAccount, get, putIdReview, putIdReceive, putIdExchange, getIdExchangeOptions, postIdRefund, uploadProof, REASONS, TYPES, RETURN_STATUS, IN_PROGRESS_STATUSES,
  returnWindow, returnedQtyByVariant, processRefund,
};
