const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { waitFor } = require('./test-support/mock-onebot');

test('new APIs persist R2/AI settings, upload, analyze Markdown and protect local data without printing', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'printer-enhancements-test-'));
  for (const name of await fs.readdir(__dirname)) if (/\.(js|html|css)$/.test(name) && !name.endsWith('.test.js')) await fs.copyFile(path.join(__dirname, name), path.join(directory, name));
  await fs.cp(path.join(__dirname, 'vendor'), path.join(directory, 'vendor'), { recursive: true });
  const uploads = [], aiCalls = [];
  const mock = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (req.url === '/v1/chat/completions') { aiCalls.push(JSON.parse(body)); res.end(JSON.stringify({ choices: [{ message: { content: '{"summary":"通过","issues":[],"revisedMarkdown":"# 标题"}' } }] })); }
    else if (req.url === '/source.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJesAAAAASUVORK5CYII=', 'base64')); }
    else { uploads.push({ url: req.url, body, headers: req.headers }); res.writeHead(200); res.end(); }
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const remote = `http://127.0.0.1:${mock.address().port}`;
  const reservation = http.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const hook = path.join(directory, 'no-external.cjs');
  await fs.writeFile(hook, `const https=require('node:https');https.request=https.get=()=>{throw new Error('No external requests or physical printing allowed in this test');};`);
  const child = spawn(process.execPath, ['--require', hook, path.join(directory, 'server.js')], { cwd: directory, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, windowsHide: true });
  let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
  t.after(async () => {
    if (child.exitCode == null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    await new Promise(resolve => mock.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(directory).startsWith('printer-enhancements-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const post = async (route, body) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  await waitFor(async () => { try { return (await fetch(base + '/api/app/info')).ok; } catch { if (child.exitCode != null) throw new Error(output); return false; } });
  assert.equal((await (await fetch(base + '/api/app/info')).json()).version, '1.1.0');
  assert.equal((await fetch(base + '/vendor/markdown-it.min.js')).status, 200);
  const imageHost = { provider: 'r2', endpoint: remote, bucket: 'mock-bucket', region: 'auto', accessKeyId: 'MOCK_KEY', secretAccessKey: 'MOCK_SECRET', publicBaseUrl: remote + '/public', prefix: 'receipts' };
  const ai = { enabled: true, baseUrl: remote + '/v1', model: 'mock-model', apiKey: 'MOCK_AI_KEY' };
  assert.equal((await post('/api/settings/image-host', imageHost)).status, 200);
  const savedAi = await post('/api/settings/ai', ai);
  assert.equal(savedAi.status, 200); assert.equal(savedAi.body.keyConfigured, true); assert.ok(!JSON.stringify(savedAi.body).includes('MOCK_AI_KEY'));
  assert.equal(aiCalls.length, 0);
  assert.equal((await post('/api/config', { storageMode: 'local', imageHost, ai, onebot: { markdownEnabled: false } })).status, 200);
  const disk = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
  assert.equal(disk.imageHost.secretAccessKey, 'MOCK_SECRET'); assert.equal(disk.ai.model, 'mock-model'); assert.equal(disk.onebot.markdownEnabled, false);
  const upload = await post('/api/image-host/test', {});
  assert.equal(upload.status, 200); assert.ok(upload.body.directUrl.startsWith(remote + '/public/receipts/'));
  assert.equal(uploads.length, 1); assert.match(uploads[0].headers.authorization, /AWS4-HMAC-SHA256/);
  const analysis = await post('/api/markdown/analyze', { text: '#标题\n\n- 清单' });
  assert.equal(analysis.status, 200); assert.ok(analysis.body.issues.some(issue => issue.code === 'heading-space')); assert.ok(analysis.body.nodes.length);
  assert.equal((await post('/api/markdown/check-ai', { text: '#标题' })).body.revisedMarkdown, '# 标题');
  assert.equal(aiCalls.length, 1); assert.equal(aiCalls[0].messages[1].content, '#标题');
  assert.ok(!JSON.stringify(aiCalls).includes('MOCK_SECRET'));
  assert.equal((await post('/api/markdown/image', { url: 'file:///C:/private.png' })).status, 400);
  if (process.env.WECHAT_PRINTER_FFMPEG) {
    const image = await post('/api/markdown/image', { url: remote + '/source.png' });
    assert.equal(image.status, 200, JSON.stringify(image.body)); assert.equal(uploads.length, 2);
    assert.equal(uploads[1].headers['content-type'], 'image/jpeg');
    assert.equal(uploads[1].body.readUInt16BE(0), 0xffd8);
    const again = await post('/api/markdown/image', { url: remote + '/source.png' });
    assert.equal(again.body.directUrl, image.body.directUrl); assert.equal(uploads.length, 2);
  }
  for (const route of ['/config.json', '/.onebot-media-cache.json', '/.onebot-admin.json', '/.git/config']) assert.equal((await fetch(base + route)).status, 404);
  assert.equal((await fetch(base + '/api/config', { method: 'DELETE' })).status, 200);
  assert.equal((await post('/api/markdown/check-ai', { text: '# 标题' })).status, 400);
  assert.equal(aiCalls.length, 1);
});
