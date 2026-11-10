require('./config');
const assert = require('node:assert/strict');
const db = require('./db');
const { sign } = require('./security');
const BASE = process.env.TEST_BASE_URL;
let checks = 0;
async function main() {
  if (!BASE || !/^mongodb:\/\/127\.0\.0\.1:27017\/velathier_test_\d+_\d+$/.test(process.env.MONGO_URI || '')) throw Error('Isolated integration harness required');
  await db.connect();
  const demo = await db.models.users.findOne({ id: 'u_demo' }).lean();
  // Dedicated identity: do not change defaults used by other integration suites.
  const user = { ...demo, _id: undefined, id: 'u_locations_test', email: 'locations@example.test' };
  await db.models.users.create(user);
  const token = sign(user);
  async function call(method, path, body, status = 200, auth = token) {
    const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json();
    assert.equal(r.status, status, `${method} ${path}: ${JSON.stringify(data)}`); checks++;
    return data;
  }
  const provinces = await call('GET', '/api/orders/locations', null, 200, '');
  assert.equal(provinces.length, 34); assert.ok(provinces.every(p => typeof p.code === 'string'));
  const wards = await call('GET', '/api/orders/locations/01/wards', null, 200, '');
  assert.equal(wards.find(w => w.name === 'Phường Ba Đình').code, '00004');
  await call('GET', '/api/orders/locations/99/wards', null, 400);
  const body = { fullName: 'Khách Địa Chỉ', phone: '0912345678', provinceCode: '01', wardCode: '00004', province: 'Forged', ward: 'Forged', district: 'Forged', line1: '12 Test Street', note: '', isDefault: true };
  await call('POST', '/api/auth/addresses', { ...body, provinceCode: '79' }, 400);
  await call('POST', '/api/auth/addresses', { ...body, line1: '   ' }, 400);
  const created = await call('POST', '/api/auth/addresses', body, 201);
  assert.equal(created.provinceCode, '01'); assert.equal(created.wardCode, '00004');
  assert.equal(created.ward, 'Phường Ba Đình'); assert.equal(created.district, '');
  const persisted = await db.models.users.findOne({ id: user.id }).lean();
  assert.equal(persisted.addresses.find(a => a.id === created.id).wardCode, '00004');
  const list = await call('GET', '/api/auth/addresses');
  assert.equal(list.filter(a => a.isDefault).length, 1);
  assert.equal(list.find(a => a.isDefault).id, created.id);
  const products = await call('GET', '/api/products');
  const product = products.find(p => p.variants.some(v => v.stock >= 2));
  const variant = product.variants.find(v => v.stock >= 2);
  const orderBody = { items: [{ productId: product.id, variantId: variant.id, qty: 1 }], payMethod: 'cod', addressId: created.id };
  const order = await call('POST', '/api/orders', orderBody, 201);
  assert.equal(order.shippingAddress.wardCode, '00004');
  await call('PUT', `/api/auth/addresses/${created.id}`, { ...body, wardCode: '00008', line1: '99 Updated Street' });
  const storedOrder = await call('GET', `/api/orders/${order.id}`);
  assert.equal(storedOrder.shippingAddress.wardCode, '00004'); assert.equal(storedOrder.shippingAddress.line1, '12 Test Street');
  await call('PUT', `/api/auth/addresses/${created.id}`, { ...body, provinceCode: '79' }, 400);
  const old = list.find(a => !a.provinceCode);
  assert.ok(old, 'Seed contains a district-era address');
  const oldOrder = await call('POST', '/api/orders', { ...orderBody, addressId: old.id }, 201);
  assert.equal(oldOrder.shippingAddress.district, old.district);
  await call('PUT', `/api/auth/addresses/${old.id}/default`, {});
  assert.equal((await call('GET', '/api/auth/addresses')).find(a => a.isDefault).id, old.id);
  await call('POST', '/api/orders', { items: orderBody.items, address: { ...body, provinceCode: '79' } }, 400);
  for (const placed of [order, oldOrder]) await call('POST', `/api/orders/${placed.id}/cancel`, { reason: 'Integration cleanup' });
  console.log(`Address integration: ${checks} HTTP checks passed; persistence, legacy checkout, defaults and immutable order snapshot verified.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.close());
