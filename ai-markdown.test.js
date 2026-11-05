const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { checkWithAi, normalizeAi } = require('./ai-markdown');

test('optional OpenAI-compatible check, explicit text only, result parsing and safe failure', async t => {
  let status = 200, content = '```json\n{"summary":"建议补空格","issues":[{"line":1,"severity":"warning","message":"标题缺空格"}],"revisedMarkdown":"# 标题"}\n```';
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    calls.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(parts)) });
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content } }], error: 'NEVER_EXPOSE_TEST_KEY' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = { enabled: true, baseUrl: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, model: 'mock-model', apiKey: 'TEST_KEY' };
  await assert.rejects(checkWithAi('#标题', { ...config, enabled: false }), /启用/); assert.equal(calls.length, 0);
  const result = await checkWithAi('#标题', config);
  assert.equal(result.revisedMarkdown, '# 标题'); assert.equal(result.issues[0].line, 1);
  assert.equal(calls[0].url, '/v1/chat/completions'); assert.equal(calls[0].headers.authorization, 'Bearer TEST_KEY');
  assert.equal(calls[0].body.model, 'mock-model'); assert.equal(calls[0].body.messages[1].content, '#标题');
  assert.ok(!JSON.stringify(calls[0].body).includes('TEST_KEY')); assert.equal(calls[0].body.stream, false);
  status = 401; await assert.rejects(checkWithAi('#标题', config), error => /HTTP 401/.test(error.message) && !error.message.includes('NEVER_EXPOSE'));
  status = 200; content = 'invalid'; await assert.rejects(checkWithAi('#标题', config), /约定的检查结果 JSON/);
  assert.equal(normalizeAi().enabled, false);
});
