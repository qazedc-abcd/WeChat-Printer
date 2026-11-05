const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { uploadExtended, objectTarget, signS3Request } = require('./upload-provider');
const { normalizeImageHost, validateImageHost } = require('./image-host-settings');
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJesAAAAASUVORK5CYII=';

test('R2/S3 PUT, signed credentials, public URL, custom multipart, and safe failures', async t => {
  const calls = [];
  let status = 200, response = { data: { url: '/public/image.png' } };
  const server = http.createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    calls.push({ url: req.url, headers: req.headers, body: Buffer.concat(parts) });
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof response === 'string' ? response : JSON.stringify(response));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = normalizeImageHost({ provider: 'r2', endpoint: base, publicBaseUrl: base + '/public', bucket: 'test-bucket', accessKeyId: 'TESTKEY', secretAccessKey: 'TESTSECRET', sessionToken: 'TEMP_TOKEN', prefix: "收据/a b!'()" });
  const uploaded = await uploadExtended(PIXEL, config);
  assert.match(calls[0].url, /^\/test-bucket\/%E6%94%B6%E6%8D%AE\/a%20b%21%27%28%29\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9]{24}\.png$/);
  assert.equal(calls[0].headers['content-type'], 'image/png');
  assert.equal(calls[0].headers['x-amz-security-token'], 'TEMP_TOKEN');
  assert.match(calls[0].headers.authorization, /Credential=TESTKEY\/\d{8}\/auto\/s3\/aws4_request/);
  assert.equal(calls[0].body.toString('base64'), PIXEL.split(',')[1]);
  assert.equal(uploaded.directUrl, base + '/public' + calls[0].url.slice('/test-bucket'.length));
  assert.ok(!JSON.stringify(uploaded).includes('TESTSECRET'));
  const virtual = objectTarget({ endpoint: 'https://s3.example.com', bucket: 'photos', forcePathStyle: false }, 'a b/中文.png');
  assert.equal(virtual.href, 'https://photos.s3.example.com/a%20b/%E4%B8%AD%E6%96%87.png');
  const custom = { provider: 'custom', uploadUrl: base + '/upload?format=json', fileField: 'image', responseUrlPath: 'data.url', authorization: 'Bearer TEST' };
  assert.equal((await uploadExtended(PIXEL, custom)).directUrl, base + '/public/image.png');
  assert.equal(calls[1].headers.authorization, 'Bearer TEST');
  assert.match(calls[1].headers['content-type'], /multipart\/form-data; boundary=/);
  assert.match(calls[1].body.toString(), /name="image"; filename="receipt.png"/);
  status = 403; response = '<Code>SignatureDoesNotMatch</Code><Secret>TESTSECRET</Secret>';
  await assert.rejects(uploadExtended(PIXEL, config), error => /403 \/ SignatureDoesNotMatch/.test(error.message) && !error.message.includes('TESTSECRET'));
  status = 200; response = { data: { url: 'javascript:alert(1)' } };
  await assert.rejects(uploadExtended(PIXEL, custom), /HTTP\(S\)/);
  assert.equal(validateImageHost({ ...config, endpoint: 'https://example.com?bad=1' }).valid, false);
  assert.equal(validateImageHost({ ...config, prefix: '../escape' }).valid, false);
  assert.equal(validateImageHost({ ...custom, responseUrlPath: '__proto__.url' }).valid, false);
  assert.equal(normalizeImageHost({ ...config, deleteExpiredCache: true }).deleteExpiredCache, false);
});

test('SigV4 is stable for fixed date, payload, encoded path and temporary token', () => {
  const signed = signS3Request({ url: 'https://test-bucket.s3.us-east-1.amazonaws.com/a%20b/%E4%B8%AD%E6%96%87.png', body: Buffer.from('test payload'), contentType: 'image/png', region: 'us-east-1', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', sessionToken: 'TEST_TOKEN', date: new Date('2026-11-05T12:34:56Z') });
  assert.equal(signed.headers['x-amz-date'], '20261105T123456Z');
  assert.match(signed.canonicalRequest, /^PUT\n\/a%20b\/%E4%B8%AD%E6%96%87.png\n/);
  // Independently checked against botocore.auth.S3SigV4Auth (AWS SDK).
  assert.equal(signed.signature, '1090af191a259933c8f1defd08350477dd55944e79e652b0ce4fbb99d961b8b2');
});
