// Mỗi lượt test dùng database mới. Không seed/reset database trong .env.
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const mongoose = require('mongoose');
const root = path.join(__dirname, '..');
const dbName = `velathier_test_${Date.now()}_${process.pid}`;
let server;
async function run(script, env, expectSuccess = true) {
  const child = spawn(process.execPath, [path.join(__dirname, script)], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (s) => { output += s; });
  child.stderr.on('data', (s) => { output += s; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  if (expectSuccess && code !== 0) throw new Error(`${script} failed:\n${output}`);
  console.log(script === 'test-api.js' ? output.split('\n').filter((s) => s.includes('Kết quả:')).join('\n') : output.trim());
  return code;
}
async function main() {
  const port = await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.on('error', reject);
    listener.listen(0, '127.0.0.1', () => { const p = listener.address().port; listener.close(() => resolve(p)); });
  });
  const env = { ...process.env, NODE_ENV: 'development', PORT: String(port),
    PRIVATE_STORAGE_PROVIDER:'local', PRIVATE_STORAGE_ROOT:path.resolve(root,'server/private/test-storage',dbName),
    JWT_SECRET:'isolated-test-jwt-secret-never-production', VNP_REFUND_AUTOMATION_ENABLED:'0',
    MONGO_URI: `mongodb://127.0.0.1:27017/${dbName}`,
    TEST_BASE_URL: `http://127.0.0.1:${port}`, PUBLIC_URL: `http://127.0.0.1:${port}`,
    DISABLE_RATE_LIMIT: '1', SMTP_HOST: '', SMTP_USER: '', VNP_TMN_CODE: '', VNP_HASH_SECRET: '',
    CORS_ORIGINS: 'http://localhost:3000',
  };
  try {
    await run('seed.js', env);
    const rejectedSeed = await run('seed.js', env, false);
    if (rejectedSeed === 0) throw new Error('Seed overwrote a nonempty database');
    server = spawn(process.execPath, ['server/server.js'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let serverOutput = '';
    server.stdout.on('data', (s) => { serverOutput += s; });
    server.stderr.on('data', (s) => { serverOutput += s; });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(env.TEST_BASE_URL + '/api/health')).ok; } catch {}
      if (ready) break;
      if (server.exitCode !== null) throw new Error(serverOutput);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('Server did not start: ' + serverOutput);
    await run('test-locations.js', env);
    await run('test-api.js', env);
    await run('test-mongo.js', env);
    await run('test-reviews.js', env);
    await run('test-custom-print.js', env);
    await run('test-print-srs.js', env);
  } finally {
    if (server && server.exitCode === null) {
      const exited = new Promise((resolve) => server.once('exit', resolve));
      server.kill();
      await exited;
    }
    // Tên đích là hằng được tạo riêng trong lượt này, không lấy từ cấu hình người dùng.
    await mongoose.connect(`mongodb://127.0.0.1:27017/${dbName}`, { serverSelectionTimeoutMS: 5000 });
    if (mongoose.connection.name !== dbName || !/^velathier_test_\d+_\d+$/.test(dbName)) throw new Error('Unsafe test database');
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
