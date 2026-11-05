const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mockOneBot, waitFor } = require('./test-support/mock-onebot');

test('server login, QQ filtering, admin replies, actual print batching, duplicate prevention and stop', async () => {
  const mock = await mockOneBot();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onebot-printer-test-'));
  const prints = [];
  const printer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => { prints.push(JSON.parse(Buffer.concat(chunks))); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"retcode":0,"retmsg":"ok"}'); });
  });
  await new Promise((resolve) => printer.listen(0, '127.0.0.1', resolve));
  const reservation = http.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const appPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  for (const name of await fs.readdir(__dirname)) {
    if (/\.(?:js|html|css)$/.test(name) && !name.endsWith('.test.js')) await fs.copyFile(path.join(__dirname, name), path.join(directory, name));
  }
  const hook = path.join(directory, 'mock-printer-hook.cjs');
  await fs.writeFile(hook, `const https=require('node:https'),http=require('node:http');
https.request=(options,callback)=>{
 if(options.hostname!=='payapp.wechatpay.cn')throw new Error('External requests are forbidden in tests');
 return http.request({...options,hostname:'127.0.0.1',port:${printer.address().port}},callback);
};`);
  let output = '';
  const child = spawn(process.execPath, ['--require', hook, path.join(directory, 'server.js')], { cwd: directory, env: { ...process.env, HOST: '127.0.0.1', PORT: String(appPort), ONEBOT_ADMIN_USER_IDS: '' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (value) => output += value); child.stderr.on('data', (value) => output += value);
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const status = () => fetch(baseUrl + '/api/onebot/status').then((result) => result.json());
  const event = (id, text, extra = {}) => ({ time: Math.floor(Date.now() / 1000), self_id: 10001, post_type: 'message', message_type: 'private', message_id: id, user_id: 20002, sender: { nickname: 'Mock sender' }, message: [{ type: 'text', data: { text } }], ...extra });
  try {
    await waitFor(async () => { try { return (await fetch(baseUrl)).ok; } catch { if (child.exitCode != null) throw new Error(output); return false; } });
    const page = await (await fetch(baseUrl)).text();
    assert.ok(page.includes('ws://127.0.0.1:3001'));
    assert.ok(!page.includes('BotFather'));
    assert.equal((await fetch(baseUrl + '/api/telegram/status')).status, 404);
    const started = await fetch(baseUrl + '/api/onebot/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_base: mock.url, token: '', device_sn: 'TEST_DEVICE', sid: 'DUMMY_SID', account_type: 2, max_per_minute: 0, max_chars_per_task: 0, photo_enabled: false, admin_user_ids: [] }) });
    assert.equal(started.status, 200, await started.text());
    assert.equal((await status()).running, true);
    mock.broadcast(event(1, 'ignored group', { message_type: 'group', group_id: 30003 }));
    mock.broadcast(event(2, 'ignored own message', { user_id: 10001 }));
    mock.broadcast({ post_type: 'meta_event', meta_event_type: 'heartbeat' });
    mock.broadcast(event(3, '/whoami'));
    await waitFor(() => mock.actions.some((call) => call.action === 'send_private_msg'));
    assert.equal(prints.length, 0);
    const whoami = mock.actions.find((call) => call.action === 'send_private_msg');
    assert.equal(whoami.params.user_id, 20002);
    assert.equal(whoami.params.message[0].type, 'text');
    assert.ok(whoami.params.message[0].data.text.includes('20002'));
    const printable = event(4, 'Test print through OneBot');
    mock.broadcast(printable); mock.broadcast(printable);
    await waitFor(() => prints.length === 1);
    await waitFor(async () => (await status()).logs.some((entry) => entry.type === 'printed'));
    assert.equal(prints[0].device_sn, 'TEST_DEVICE');
    assert.equal(prints[0].sid, 'DUMMY_SID');
    assert.equal(prints[0].account_type, 2);
    const receiptText = prints[0].ad_content.user_define_template.root
      .flatMap((node) => node.content?.lines?.linelist?.flatMap((line) => line.column) || []).join('');
    assert.ok(receiptText.includes('Mock sender'));
    assert.ok(receiptText.includes('Test print through OneBot'));
    const denied = event(5, '/block 55555'); mock.broadcast(denied);
    await waitFor(() => mock.actions.filter((call) => call.action === 'send_private_msg').length >= 4);
    const state = await status();
    assert.equal(state.blacklist.length, 0);
    assert.equal(prints.length, 1);
    const stopped = await fetch(baseUrl + '/api/onebot/stop', { method: 'POST' });
    assert.equal(stopped.status, 200);
    assert.equal((await status()).running, false);
    mock.broadcast(event(6, 'must not print after stop'));
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(prints.length, 1);
    const config = await (await fetch(baseUrl + '/api/config')).json();
    assert.ok(config.onebot);
    assert.equal(config.telegram, undefined);
    assert.equal(config.onebot.apiBase, 'ws://127.0.0.1:3001');
    for (const privatePath of ['/.onebot-admin.json', '/.onebot-media-cache.json', '/config.json', '/.git/config']) {
      assert.equal((await fetch(baseUrl + privatePath)).status, 404, privatePath);
    }
  } catch (error) { error.message += '\n' + output; throw error; }
  finally {
    const exit = once(child, 'exit'); child.kill(); await exit;
    await mock.close();
    await new Promise((resolve) => printer.close(resolve));
    const resolvedDirectory = path.resolve(directory);
    assert.ok(resolvedDirectory.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolvedDirectory).startsWith('onebot-printer-test-'));
    await fs.rm(resolvedDirectory, { recursive: true, force: true });
  }
});
