const assert = require('node:assert/strict');
const { test } = require('node:test');
const { OneBotClient, normalizeOneBotUrl, normalizeOneBotEvent, parseOneBotSegments } = require('./onebot-client');
const { mockOneBot, waitFor } = require('./test-support/mock-onebot');

const base = { post_type: 'message', message_type: 'private', self_id: 10001, user_id: 20002, message_id: 42, sender: { nickname: '测试昵称' } };

test('CQ escapes, ordered text/image segments, sender names and unsupported event filtering', () => {
  assert.equal(parseOneBotSegments('&#91;CQ:image&#93;&amp;')[0].data.text, '[CQ:image]&');
  const cq = parseOneBotSegments('前[CQ:image,file=a&#44;b,url=https://example.test/a?a=1&amp;b=2]后');
  assert.deepEqual(cq.map((part) => part.type), ['text', 'image', 'text']);
  assert.equal(cq[1].data.file, 'a,b');
  assert.equal(cq[1].data.url, 'https://example.test/a?a=1&b=2');
  const updates = normalizeOneBotEvent({ ...base, message: [{ type: 'text', data: { text: '前文' } }, { type: 'image', data: { file: 'image.jpg', url: 'https://example.test/a.jpg' } }, { type: 'text', data: { text: '后文 https://example.test' } }] });
  assert.equal(updates.length, 3);
  assert.equal(updates[0].message.text, '前文');
  assert.equal(updates[1].message.photo[0].source_url, 'https://example.test/a.jpg');
  assert.equal(updates[2].message.text, '后文 https://example.test');
  assert.equal(updates[0].message.from.first_name, '测试昵称');
  assert.equal(updates[2].message.entities[0].type, 'url');
  assert.equal(new Set(updates.map((item) => item.update_id)).size, 3);
  assert.deepEqual(normalizeOneBotEvent({ ...base, post_type: 'meta_event', message: 'ignore' }), []);
  assert.deepEqual(normalizeOneBotEvent({ ...base, user_id: base.self_id, message: 'ignore' }), []);
  assert.deepEqual(normalizeOneBotEvent({ ...base, message: '[CQ:reply,id=123]' }), []);
  assert.equal(normalizeOneBotEvent({ ...base, message_type: 'group', message: '群聊' })[0].message.chat.type, 'group');
  assert.throws(() => normalizeOneBotUrl('https://example.test'), /ws:/);
  assert.throws(() => normalizeOneBotUrl('ws://localhost:3001/api'), /根路径/);
  assert.throws(() => normalizeOneBotUrl('ws://localhost:3001/?access_token=secret'), /单独填写/);
});

test('real WebSocket RPC echoes, token, event deduplication, reconnect, failures and clean stop', async () => {
  const mock = await mockOneBot();
  const client = new OneBotClient(mock.url, 'dummy+token');
  try {
    const login = await client.call('get_login_info');
    assert.equal(login.user_id, 10001);
    assert.equal(new URL(mock.connections[0], mock.url).searchParams.get('access_token'), 'dummy+token');
    const first = client.nextUpdates();
    const event = { ...base, message: 'hello[CQ:image,file=test.jpg,url=https://example.test/test.jpg]world' };
    mock.broadcast(event); mock.broadcast(event);
    const batch = await first;
    assert.equal(batch.length, 3);
    assert.equal(client.queue.length, 0);
    await client.call('send_private_msg', { user_id: 20002, message: [{ type: 'text', data: { text: '[CQ:record,file=should-be-text]' } }] });
    assert.equal(mock.actions.at(-1).params.message[0].type, 'text');
    await assert.rejects(client.call('fail_action'), /retcode 1404/);
    await assert.rejects(client.call('never_reply', {}, 30), /超时/);
    assert.equal(client.pending.size, 0);
    mock.disconnect(); await waitFor(() => client.socket === null);
    assert.equal((await client.call('get_login_info')).user_id, 10001);
    assert.equal(mock.connections.length, 2);
    const waiting = client.nextUpdates();
    client.close();
    await assert.rejects(waiting, /已停止/);
    await assert.rejects(client.call('get_login_info'), /已停止/);
  } finally { client.close(); await mock.close(); }
});
