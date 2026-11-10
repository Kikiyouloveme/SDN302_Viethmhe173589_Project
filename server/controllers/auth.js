/**
 * Xác thực & tài khoản: đăng ký, đăng nhập, xác minh email, quên mật khẩu (OTP),
 * hồ sơ cá nhân, đổi mật khẩu và sổ địa chỉ.
 */

const bcrypt = require('bcryptjs');
const db = require('../db');
const mailer = require('../mailer');
const otpService = require('../otp');
const config = require('../config');
const { v, sign, badRequest, notFound, conflict, HttpError } = require('../security');

const BCRYPT_ROUNDS = 12;

/** Số lượng mẫu ảnh đại diện dựng sẵn — phải khớp mảng AVATARS ở client */
const AVATAR_COUNT = 4;

/** Dữ liệu user trả ra ngoài — KHÔNG bao giờ chứa hash mật khẩu hay dữ liệu nhạy cảm */
const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone || '',
  role: u.role,
  emailVerified: !!u.emailVerified,
  avatarId: u.avatarId || 1,
  addresses: u.addresses || [],
  createdAt: u.createdAt,
});

/* ==================== ĐĂNG KÝ / ĐĂNG NHẬP ==================== */

/**
 * Chức năng cần gửi được OTP tới hộp thư khách. Ở production mà chưa cấu hình SMTP
 * thì phải TỪ CHỐI thẳng — nếu vẫn cho đăng ký, khách sẽ có tài khoản không bao giờ
 * xác minh được email và không đặt hàng được.
 */
function requireEmailDelivery() {
  if (!config.features.otpFlowsEnabled) {
    throw new HttpError(
      503,
      'Hệ thống gửi email đang tạm ngưng nên chưa thể thực hiện thao tác này. Vui lòng liên hệ cửa hàng để được hỗ trợ.',
      'EMAIL_SERVICE_UNAVAILABLE'
    );
  }
}

const postRegister = async (req, res) => {
  requireEmailDelivery();
  const name = v.str(req.body.name, 'họ tên', { min: 2, max: 80 });
  const email = v.email(req.body.email);
  const password = v.password(req.body.password);
  const phone = v.phone(req.body.phone, { required: false });

  if (db.users.byEmail(email)) throw conflict('Email này đã được đăng ký');

  const user = {
    id: db.uid('u'),
    name,
    email,
    phone,
    pass: await bcrypt.hash(password, BCRYPT_ROUNDS),
    role: 'customer',
    emailVerified: false,
    // Chọn ngẫu nhiên một mẫu có sẵn để mỗi tài khoản mới trông khác nhau ngay từ đầu
    avatarId: 1 + Math.floor(Math.random() * AVATAR_COUNT),
    addresses: [],
    tokensValidFrom: Date.now(),
    createdAt: new Date().toISOString(),
  };

  // Địa chỉ nhập sẵn lúc đăng ký (tuỳ chọn) → lưu thành địa chỉ mặc định
  const addr = req.body.address;
  if (addr && typeof addr === 'object' && addr.line1) {
    user.addresses.push({
      id: db.uid('addr'),
      ...require('../checkout-validation').validateAddress({ ...addr, fullName: name, phone }),
      isDefault: true,
      createdAt: new Date().toISOString(),
    });
  }

  db.users.insert(user);

  // Gửi ngay mã xác minh email
  const issued = otpService.issue(email, otpService.PURPOSE.VERIFY_EMAIL);
  if (issued.code) mailer.send(email, 'verifyEmail', publicUser(user), issued.code);
  mailer.send(email, 'welcome', publicUser(user));

  res.status(201).json({ token: sign(user), user: publicUser(user) });
};

const postLogin = async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.users.byEmail(email);

  // So sánh cả khi không tìm thấy user để thời gian phản hồi không tiết lộ email có tồn tại
  const hash = user ? user.pass : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid';
  const ok = await bcrypt.compare(password, hash);

  if (!user || !ok) throw badRequest('Email hoặc mật khẩu không đúng');
  if (config.isProd && (['u_demo','u_staff','u_admin'].includes(user.id) || user.disabled)) throw badRequest('Tài khoản demo hoặc đã khóa không được đăng nhập production');

  res.json({ token: sign(user), user: publicUser(user) });
};

const getMe = async (req, res) => {
  res.json(publicUser(req.user));
};

/* ==================== XÁC MINH EMAIL ==================== */

/** Gửi (lại) mã xác minh email cho tài khoản đang đăng nhập */
const postVerifyEmailSend = async (req, res) => {
  if (req.user.emailVerified) return res.json({ ok: true, alreadyVerified: true });
  requireEmailDelivery();

  const issued = otpService.issue(req.user.email, otpService.PURPOSE.VERIFY_EMAIL);
  if (issued.cooldown) {
    return res.status(429).json({
      error: `Vui lòng đợi ${issued.cooldown} giây trước khi yêu cầu mã mới`,
      cooldown: issued.cooldown,
    });
  }
  const delivery=await mailer.send(req.user.email, 'verifyEmail', publicUser(req.user), issued.code);
  if(!delivery.ok)throw new HttpError(503,'Chưa gửi được email xác minh. Vui lòng thử lại sau.','EMAIL_SERVICE_UNAVAILABLE');
  res.json({ ok: true, mode:delivery.mode, queued:delivery.queued, expiresAt: issued.expiresAt });
};

/** Nhập mã để xác minh email */
const postVerifyEmailConfirm = async (req, res) => {
  if (req.user.emailVerified) return res.json({ ok: true, user: publicUser(req.user) });

  const result = otpService.verify(req.user.email, otpService.PURPOSE.VERIFY_EMAIL, req.body.code);
  if (!result.ok) throw badRequest(result.message);

  db.transaction(() => { req.user.emailVerified = true; req.user.verifiedAt = new Date().toISOString(); });
  db.otps.remove(req.user.email, otpService.PURPOSE.VERIFY_EMAIL);

  res.json({ ok: true, user: publicUser(req.user) });
};

/* ==================== QUÊN MẬT KHẨU (OTP 3 BƯỚC) ==================== */

/**
 * Bước 1 — yêu cầu mã.
 * Luôn trả về cùng một thông điệp dù email có tồn tại hay không, để không cho phép
 * dò xem địa chỉ nào đã đăng ký (user enumeration).
 */
const postForgotPassword = async (req, res) => {
  requireEmailDelivery();
  const email = v.email(req.body.email);
  const user = db.users.byEmail(email);
  const genericMessage = 'Nếu email này đã được đăng ký, mã xác minh đã được gửi tới hộp thư của bạn.';

  if (user) {
    const issued = otpService.issue(email, otpService.PURPOSE.RESET_PASSWORD);
    if (issued.cooldown) {
      return res.json({ ok: true, message: genericMessage, cooldown: issued.cooldown });
    }
    await mailer.send(email, 'resetPassword', publicUser(user), issued.code);
  }

  res.json({ ok: true, message: genericMessage, ttlMinutes: config.otp.ttlMinutes });
};

/** Bước 2 — xác minh mã, nhận vé (ticket) cho bước 3 */
const postForgotPasswordVerify = async (req, res) => {
  const email = v.email(req.body.email);
  const code = String(req.body.code || '').replace(/\D/g, '');
  if (code.length !== config.otp.length) throw badRequest(`Mã xác minh phải gồm ${config.otp.length} chữ số`);

  const result = otpService.verify(email, otpService.PURPOSE.RESET_PASSWORD, code);
  if (!result.ok) throw badRequest(result.message);

  res.json({ ok: true, ticket: result.ticket });
};

/**
 * Bước 3 — đặt mật khẩu mới.
 * Bắt buộc phải có ticket hợp lệ từ bước 2 → không thể gọi thẳng API này để bỏ qua OTP.
 */
const postForgotPasswordReset = async (req, res) => {
  const email = v.email(req.body.email);
  const password = v.password(req.body.password);
  const confirm = String(req.body.confirmPassword || '');
  if (password !== confirm) throw badRequest('Mật khẩu nhập lại không khớp');

  otpService.consumeTicket(email, otpService.PURPOSE.RESET_PASSWORD, req.body.ticket);

  const user = db.users.byEmail(email);
  if (!user) throw notFound('Không tìm thấy tài khoản');

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  db.transaction(() => {
    user.pass = hash;
    // Vô hiệu hoá mọi token đã phát hành trước thời điểm này
    user.tokensValidFrom = Date.now();
    user.passwordChangedAt = new Date().toISOString();
  });

  mailer.send(user.email, 'passwordChanged', publicUser(user));
  res.json({ ok: true, message: 'Đặt lại mật khẩu thành công. Vui lòng đăng nhập bằng mật khẩu mới.' });
};

/* ==================== HỒ SƠ ==================== */

const putProfile = async (req, res) => {
  const name = v.str(req.body.name, 'họ tên', { min: 2, max: 80 });
  const phone = v.phone(req.body.phone, { required: false });

  db.transaction(() => {
    req.user.name = name;
    req.user.phone = phone;
    req.user.updatedAt = new Date().toISOString();
  });
  // Cố tình KHÔNG cho sửa: email, role, emailVerified — tránh leo thang đặc quyền
  res.json(publicUser(req.user));
};

/** Đổi ảnh đại diện — chỉ được chọn trong bộ mẫu dựng sẵn, không nhận URL tuỳ ý */
const putAvatar = async (req, res) => {
  const avatarId = v.int(req.body.avatarId, 'ảnh đại diện', { min: 1, max: AVATAR_COUNT });

  db.transaction(() => {
    req.user.avatarId = avatarId;
    req.user.updatedAt = new Date().toISOString();
  });
  res.json(publicUser(req.user));
};

const putPassword = async (req, res) => {
  const current = String(req.body.currentPassword || '');
  const password = v.password(req.body.newPassword);
  const confirm = String(req.body.confirmPassword || '');

  if (!(await bcrypt.compare(current, req.user.pass))) throw badRequest('Mật khẩu hiện tại không đúng');
  if (password !== confirm) throw badRequest('Mật khẩu nhập lại không khớp');
  if (current === password) throw badRequest('Mật khẩu mới phải khác mật khẩu hiện tại');

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  db.transaction(() => {
    req.user.pass = hash;
    req.user.tokensValidFrom = Date.now();
    req.user.passwordChangedAt = new Date().toISOString();
  });

  mailer.send(req.user.email, 'passwordChanged', publicUser(req.user));
  // Token cũ vừa bị vô hiệu → cấp token mới để người dùng không bị đăng xuất đột ngột
  res.json({ ok: true, token: sign(req.user) });
};

/* ==================== SỔ ĐỊA CHỈ ==================== */

const readAddress = require('../checkout-validation').validateAddress;

const getAddresses = async (req, res) => {
  res.json(req.user.addresses || []);
};

const postAddresses = async (req, res) => {
  const data = readAddress(req.body);
  if ((req.user.addresses || []).length >= 20) throw badRequest('Bạn chỉ có thể lưu tối đa 20 địa chỉ');

  const address = {
    id: db.uid('addr'),
    ...data,
    isDefault: !!req.body.isDefault || (req.user.addresses || []).length === 0,
    createdAt: new Date().toISOString(),
  };

  db.transaction(() => {
    if (!Array.isArray(req.user.addresses)) req.user.addresses = [];
    if (address.isDefault) req.user.addresses.forEach((a) => { a.isDefault = false; });
    req.user.addresses.push(address);
  });

  res.status(201).json(address);
};

const putAddressesId = async (req, res) => {
  const address = (req.user.addresses || []).find((a) => a.id === req.params.id);
  if (!address) throw notFound('Không tìm thấy địa chỉ');
  const data = readAddress(req.body);

  db.transaction(() => {
    Object.assign(address, data, { updatedAt: new Date().toISOString() });
    if (req.body.isDefault) {
      req.user.addresses.forEach((a) => { a.isDefault = a.id === address.id; });
    }
  });

  res.json(address);
};

const deleteAddressesId = async (req, res) => {
  const list = req.user.addresses || [];
  const index = list.findIndex((a) => a.id === req.params.id);
  if (index < 0) throw notFound('Không tìm thấy địa chỉ');

  db.transaction(() => {
    const [removed] = list.splice(index, 1);
    // Xoá địa chỉ mặc định → đặt địa chỉ đầu tiên còn lại làm mặc định
    if (removed.isDefault && list.length) list[0].isDefault = true;
  });

  res.json({ ok: true });
};

const putAddressesIdDefault = async (req, res) => {
  const list = req.user.addresses || [];
  if (!list.some((a) => a.id === req.params.id)) throw notFound('Không tìm thấy địa chỉ');
  db.transaction(() => { list.forEach((a) => { a.isDefault = a.id === req.params.id; }); });
  res.json(list);
};

module.exports = { postRegister, postLogin, getMe, postVerifyEmailSend, postVerifyEmailConfirm, postForgotPassword, postForgotPasswordVerify, postForgotPasswordReset, putProfile, putAvatar, putPassword, getAddresses, postAddresses, putAddressesId, deleteAddressesId, putAddressesIdDefault, publicUser, AVATAR_COUNT };
