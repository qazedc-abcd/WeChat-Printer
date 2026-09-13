const assert = require('assert');
const {
  normalizeAdminUserIds,
  parseTelegramCommand,
  parseTelegramUserId,
  parseDuration,
  paginateTelegramText,
  normalizeAdminStore,
} = require('./telegram-admin');

assert.deepStrictEqual(normalizeAdminUserIds(['123', '123', 'bad', 456]), ['123', '456']);
assert.deepStrictEqual(parseTelegramCommand('/status@printer_bot now'), {
  command: 'status', botName: 'printer_bot', rawArgs: 'now', args: ['now'],
});
assert.strictEqual(parseTelegramCommand('hello'), null);
assert.strictEqual(parseTelegramUserId('00123'), '00123');
assert.strictEqual(parseTelegramUserId('12x'), '');
assert.strictEqual(parseDuration('2h'), 120);
assert.strictEqual(parseDuration('perm'), null);
assert.strictEqual(parseDuration('bad'), 0);
assert.strictEqual(paginateTelegramText('a'.repeat(8000), 3900).length, 3);
const store = normalizeAdminStore({ blacklist: [{ userId: '7', name: 'x' }], messages: [{ userId: '7', preview: 'hello' }] }, ['9', '9']);
assert.deepStrictEqual(store.adminUserIds, ['9']);
assert.strictEqual(store.blacklist['7'].name, 'x');
assert.strictEqual(store.messages[0].userId, '7');
console.log('telegram-admin tests passed');
