const { v, badRequest } = require('./security');
const code = (value, width) => {
  if (!['string', 'number'].includes(typeof value)) return '';
  const text = String(value).trim();
  return new RegExp(`^\\d{1,${width}}$`).test(text) ? text.padStart(width, '0') : '';
};
// Keep the source snapshot intact; API/storage use official fixed-width strings.
const provinces = require('./catalog/vietnam-divisions.json').map(p => ({
  ...p, code: code(p.code, 2), wards: p.wards.map(w => ({ ...w, code: code(w.code, 5) })),
}));

function validateLocation(body) {
  const province = provinces.find(p => p.code === code(body.provinceCode, 2));
  const ward = province?.wards.find(w => w.code === code(body.wardCode, 5));
  if (!province || !ward) throw badRequest('Vui lòng chọn tỉnh/thành và phường/xã hợp lệ');
  return { provinceCode: province.code, province: province.name, wardCode: ward.code, ward: ward.name, district: '' };
}

function validateContact(body) {
  const fullName = v.str(body.fullName, 'họ tên', { min: 2, max: 80 });
  if (!/^[\p{L}\p{M}]+(?:[ '\u2019-][\p{L}\p{M}]+)*$/u.test(fullName)) {
    throw badRequest('Họ tên chỉ được chứa chữ, khoảng trắng, dấu nháy hoặc dấu gạch nối');
  }
  return { fullName, phone: v.phone(body.phone), email: v.email(body.email) };
}

function validateAddress(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Địa chỉ không hợp lệ');
  return {
    fullName: v.str(body.fullName, 'họ tên người nhận', { min: 2, max: 80 }),
    phone: v.phone(body.phone),
    ...validateLocation(body),
    line1: v.str(body.line1, 'số nhà, tên đường', { min: 3, max: 200 }),
    note: v.str(body.note, 'ghi chú', { required: false, max: 200 }),
  };
}

module.exports = { provinces, validateContact, validateAddress, validateLocation, code };
