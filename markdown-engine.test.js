const { test } = require('node:test');
const assert = require('node:assert/strict');
const MD = require('./markdown-engine');
const textOf = nodes => nodes.flatMap(node => node.content?.lines.linelist[0].column || []).join('\n');

test('automatic recognition, CommonMark warnings, printer constraints and Unicode count', () => {
  for (const sample of ['# 标题', '#忘记空格', '**粗体**', '*斜体*', '- 清单', '标题\n====', 'a | b\n--- | ---\n1 | 2', '![图](https://example.com/a.png)', '---', '~~删除线~~', '    indented code', '<https://example.com>']) assert.equal(MD.detectMarkdown(sample), true, sample);
  assert.equal(MD.detectMarkdown('普通文字，今天喝咖啡。'), false);
  assert.equal(MD.detectMarkdown('https://example.com'), false, 'plain URLs keep their existing QR behavior');
  assert.equal(MD.analyzeMarkdown('中文😀').characters, 3);
  assert.ok(MD.analyzeMarkdown('#标题').issues.some(issue => issue.code === 'heading-space'));
  const fence = MD.analyzeMarkdown('```js\nconst x = 1;');
  assert.equal(fence.valid, true); assert.equal(fence.issues[0].code, 'unclosed-fence');
  assert.equal(MD.analyzeMarkdown('![图](./local.png)').valid, false);
  const row = Array.from({ length: 17 }, () => '列').join('|');
  assert.equal(MD.analyzeMarkdown(row + '\n' + Array.from({ length: 17 }, () => '---').join('|')).valid, false);
});

test('printer nodes retain order, one content row per node, table alignment and safe preview', () => {
  const nodes = MD.markdownToNodes('# 标题\n\n1. 咖啡\n2. 茶\n\n| 商品 | 数量 |\n| --- | ---: |\n| 咖啡 | 2 |\n\n![图](https://example.com/a.png)\n\n```text\n<unsafe>\n```', { sender: '测试用户' });
  assert.match(textOf(nodes), /测试用户：\n标题\n1\. 咖啡\n2\. 茶/);
  assert.equal(nodes[1].content.style.width, 1);
  for (const node of nodes) if (node.content) assert.equal(node.content.lines.linelist.length, 1);
  const table = nodes.find(node => node.content?.maxcolumn === 2);
  assert.equal(table.content.column_align[1].style.justification, 2);
  assert.equal(nodes.find(node => node.icon)?.icon.value, 'https://example.com/a.png');
  const html = MD.receiptHtml(nodes);
  assert.ok(html.includes('&lt;unsafe&gt;')); assert.ok(!html.includes('<unsafe>'));
  assert.ok(!MD.receiptHtml([{ icon: { type: 3, value: 'javascript:alert(1)' } }]).includes('<img'));
  assert.ok(MD.receiptHtml(MD.markdownToNodes('<script>alert(1)</script>')).includes('&lt;script&gt;'));
  assert.ok(textOf(MD.markdownToNodes('中文'.repeat(1000))).replace(/\n/g, '').endsWith('中文'));
});
