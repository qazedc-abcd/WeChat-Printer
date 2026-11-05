const http = require('node:http');
const https = require('node:https');

function requestBytes(url, options = {}, body = null) {
  const target = url instanceof URL ? url : new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) return Promise.reject(new Error('只支持 HTTP(S) 接口'));
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(target, options, res => {
      const parts = [];
      let size = 0;
      res.on('data', part => {
        size += part.length;
        if (size > (options.maxResponseBytes || 2 * 1024 * 1024)) { res.destroy(new Error('接口响应过大')); return; }
        parts.push(part);
      });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('接口连接中断')));
    });
    req.setTimeout(options.timeoutMs || 30000, () => req.destroy(new Error('接口请求超时')));
    req.on('error', error => reject(new Error(error.code ? `接口连接失败（${error.code}）` : error.message)));
    req.end(body);
  });
}

module.exports = { requestBytes };
