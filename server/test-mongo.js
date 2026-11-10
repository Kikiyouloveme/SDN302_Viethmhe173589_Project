require('./config');
const assert = require('node:assert/strict');
const db = require('./db');
const BASE = process.env.TEST_BASE_URL;
async function main() {
  assert(BASE, 'Use npm run test:integration');
  await db.connect();
  const call = async (method, url, body, token) => {
    const res = await fetch(BASE + url, { method, headers: {
      'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  const admin = (await call('POST', '/api/auth/login', { email: 'admin@velathier.vn', password: 'admin123' })).data.token;
  assert(admin);
  const spec = { title: 'MongoDB integration product', price: 150000, cat: 'tops',
    variants: [{ color: 'Đen', size: 'M', stock: 1 }] };
  const create = await call('POST', '/api/products', spec, admin);
  assert.equal(create.status, 201);
  const id = create.data.id;
  assert(await db.models.products.findOne({ id }), 'HTTP success must follow durable insert');
  const update = await call('PUT', `/api/products/${id}`, { ...spec, title: 'Updated product' }, admin);
  assert.equal(update.status, 200);
  assert.equal((await db.models.products.findOne({ id }).lean()).title, 'Updated product');
  // Sửa trực tiếp MongoDB mô phỏng Compass: request kế tiếp phải đọc dữ liệu mới.
  await db.models.products.updateOne({ id }, { $set: { title: 'Edited in MongoDB' } });
  assert.equal((await call('GET', `/api/products/${id}`)).data.title, 'Edited in MongoDB');
  const removed = await call('DELETE', `/api/products/${id}`, null, admin);
  assert.equal(removed.status, 200);
  assert.equal(await db.models.products.countDocuments({ id }), 0);
  await assert.rejects(db.models.products.create({ id: 'invalid-stock', ...spec,
    variants: [{ id: 'bad', color: 'Đen', size: 'M', stock: -1 }] }), /validation/i);
  const existing = await db.models.users.findOne({ id: 'u_admin' }).lean();
  delete existing._id;
  await assert.rejects(db.models.users.create({ ...existing, id: 'duplicate-email' }), { code: 11000 });
  const cors = await fetch(BASE + '/api/products', { method: 'OPTIONS', headers: {
    Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'POST',
  } });
  assert.equal(cors.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  const disallowed = await fetch(BASE + '/api/health', { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(disallowed.headers.get('access-control-allow-origin'), null);
  const scarce = await call('POST', '/api/products', spec, admin);
  assert.equal(scarce.status, 201);
  const orderBody = {
    items: [{ productId: scarce.data.id, variantId: scarce.data.variants[0].id, qty: 1 }],
    address: { fullName: 'Khách Kiểm Thử', phone: '0901234567', provinceCode: '01', wardCode: '00004', line1: '1 Test' },
    payMethod: 'cod',
  };
  const attempts = await Promise.all(Array.from({ length: 5 }, () => call('POST', '/api/orders', orderBody, admin)));
  assert.equal(attempts.filter((r) => r.status === 201).length, 1, 'Only one request can buy the last unit');
  assert.equal(attempts.filter((r) => r.status === 400).length, 4);
  assert.equal((await db.models.products.findOne({ id: scarce.data.id }).lean()).variants[0].stock, 0);
  const order = attempts.find((r) => r.status === 201).data;
  const detail = await call('GET', `/api/admin/orders/${order.id}`, null, admin);
  assert.equal(detail.data.customer.id, 'u_admin');
  assert.equal(detail.data.customer.pass, undefined);
  // Đóng/mở connection rồi đọc lại, không sử dụng state/cache trong ứng dụng.
  await db.close();
  await db.connect();
  assert(await db.models.orders.findOne({ id: order.id }));
  console.log('MongoDB checks passed: durable CRUD, external edits, validation, unique email, CORS, concurrent stock, populate, reconnect.');
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => db.close());
