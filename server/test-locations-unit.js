const { test } = require('node:test');
const assert = require('node:assert/strict');
const { provinces, validateAddress } = require('./checkout-validation');
const address = { fullName: 'Nguyễn Văn A', phone: '0912345678', provinceCode: '01', wardCode: '00004', line1: '12 Đường A' };

test('Catalog has 34 provinces and 3321 unique wards, with fixed-width codes', () => {
  assert.equal(provinces.length, 34);
  const wards = provinces.flatMap(p => p.wards);
  assert.equal(wards.length, 3321);
  assert.equal(new Set(wards.map(w => w.code)).size, 3321);
  assert.equal(new Set(provinces.map(p => p.code)).size, 34);
  assert.ok(provinces.every(p => /^\d{2}$/.test(p.code)));
  assert.ok(wards.every(w => /^\d{5}$/.test(w.code)));
});
test('Canonical names come from catalog, never submitted names', () => {
  const result = validateAddress({ ...address, province: 'Fake', ward: 'Fake', district: 'Fake' });
  assert.equal(result.province, 'Thành phố Hà Nội');
  assert.equal(result.ward, 'Phường Ba Đình');
  assert.equal(result.district, '');
});
test('Numeric legacy codes normalize without losing leading zeroes', () => {
  assert.deepEqual(validateAddress({ ...address, provinceCode: 1, wardCode: 4 }), validateAddress(address));
});
test('Missing, malformed and foreign-parent codes fail', () => {
  for (const override of [{ provinceCode: '99' }, { wardCode: '99999' }, { provinceCode: '79' }, { provinceCode: '1e0' }, { wardCode: {} }, { provinceCode: '' }, { wardCode: '' }]) {
    assert.throws(() => validateAddress({ ...address, ...override }));
  }
});
test('Whitespace-only required fields fail', () => {
  for (const field of ['fullName', 'phone', 'line1']) assert.throws(() => validateAddress({ ...address, [field]: '   ' }));
});
test('Names alone cannot bypass the catalog for new addresses', () => {
  assert.throws(() => validateAddress({ ...address, provinceCode: undefined, wardCode: undefined, province: 'Thành phố Hà Nội', ward: 'Phường Ba Đình' }));
});
