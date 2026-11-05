const http = require('node:http');
const { createHash } = require('node:crypto');

function frame(value, opcode = 1) {
  const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  let header;
  if (body.length < 126) header = Buffer.from([0x80 | opcode, body.length]);
  else { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(body.length, 2); }
  return Buffer.concat([header, body]);
}

async function mockOneBot() {
  const sockets = new Set();
  const actions = [];
  const connections = [];
  const server = http.createServer();
  server.on('upgrade', (request, socket) => {
    connections.push(request.url);
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15;
        const masked = (buffer[1] & 128) !== 0;
        let size = buffer[1] & 127;
        let offset = 2;
        if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
        if (size === 127) { if (buffer.length < 10) return; size = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + (masked ? 4 : 0) + size) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : null;
        offset += masked ? 4 : 0;
        const body = Buffer.from(buffer.subarray(offset, offset + size));
        buffer = buffer.subarray(offset + size);
        if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        if (opcode === 8) { socket.end(frame('', 8)); continue; }
        if (opcode === 9) { socket.write(frame(body.toString(), 10)); continue; }
        if (opcode !== 1) continue;
        const call = JSON.parse(body.toString());
        actions.push(call);
        if (call.action === 'never_reply') continue;
        if (call.action === 'fail_action') { socket.write(frame({ status: 'failed', retcode: 1404, echo: call.echo })); continue; }
        const result = call.action === 'get_login_info' ? { user_id: 10001, nickname: 'Mock QQ' }
          : call.action === 'get_image' ? { url: 'http://127.0.0.1/not-used.png' }
            : { message_id: actions.length };
        socket.write(frame({ status: 'ok', retcode: 0, data: result, echo: call.echo }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    actions, connections,
    broadcast(event) { for (const socket of sockets) socket.write(frame(event)); },
    disconnect() { for (const socket of sockets) socket.destroy(); },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); },
  };
}

async function waitFor(predicate, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for mock integration state');
}

module.exports = { mockOneBot, waitFor };
