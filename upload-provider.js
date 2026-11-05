const crypto = require('node:crypto');
const { requestBytes } = require('./http-client');
const { validateImageHost } = require('./image-host-settings');

const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
const encodePath = value => value.split('/').map(encode).join('/');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();

function parseImage(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([a-zA-Z0-9+/]+={0,2})$/);
  if (!match) throw new Error('只支持 PNG、JPEG 或 WebP 图片');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('图片必须在 20 MB 以内');
  const mime = match[1].toLowerCase().replace('image/jpg', 'image/jpeg');
  return { bytes, mime, extension: mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1] };
}

function signS3Request({ url, method = 'PUT', body = Buffer.alloc(0), region, accessKeyId, secretAccessKey, sessionToken = '', contentType, date = new Date() }) {
  const target = url instanceof URL ? url : new URL(url);
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = hash(body);
  const headers = { host: target.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (contentType) headers['content-type'] = contentType;
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map(name => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join('');
  const query = [...target.searchParams].map(([key, value]) => [encode(key), encode(value)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0).map(pair => pair.join('=')).join('&');
  const canonical = [method, target.pathname || '/', query, canonicalHeaders, names.join(';'), payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hash(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(Buffer.from('AWS4' + secretAccessKey), dateStamp), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return { headers, canonicalRequest: canonical, signature };
}

function objectTarget(config, key) {
  const endpoint = new URL(config.endpoint);
  const base = endpoint.pathname.replace(/\/+$/, '');
  if (config.forcePathStyle) endpoint.pathname = `${base}/${encode(config.bucket)}/${encodePath(key)}`;
  else { endpoint.hostname = `${config.bucket}.${endpoint.hostname}`; endpoint.pathname = `${base}/${encodePath(key)}`; }
  return endpoint;
}

async function uploadS3(image, config) {
  const date = new Date();
  const key = [config.prefix, date.toISOString().slice(0, 10).replace(/-/g, '/'), `${hash(image.bytes).slice(0, 24)}.${image.extension}`].filter(Boolean).join('/');
  const target = objectTarget(config, key);
  const signed = signS3Request({ url: target, body: image.bytes, contentType: image.mime, ...config, date });
  const result = await requestBytes(target, { method: 'PUT', headers: { ...signed.headers, 'content-length': image.bytes.length } }, image.bytes);
  if (result.statusCode < 200 || result.statusCode >= 300) {
    const code = result.body.toString().match(/<Code>([a-zA-Z0-9_-]+)<\/Code>/)?.[1];
    throw new Error(`S3 上传失败（HTTP ${result.statusCode}${code ? ' / ' + code : ''}），请检查 Endpoint、Region 和存储桶权限`);
  }
  return { directUrl: `${config.publicBaseUrl}/${encodePath(key)}`, pageUrl: `${config.publicBaseUrl}/${encodePath(key)}`, remotePath: key };
}

async function uploadCustom(image, config) {
  const boundary = '----WeChatPrinter' + crypto.randomBytes(12).toString('hex');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${config.fileField}"; filename="receipt.${image.extension}"\r\nContent-Type: ${image.mime}\r\n\r\n`),
    image.bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length, accept: 'application/json' };
  if (config.authorization) headers.authorization = config.authorization;
  const result = await requestBytes(new URL(config.uploadUrl), { method: 'POST', headers }, body);
  if (result.statusCode < 200 || result.statusCode >= 300) throw new Error(`自定义图床上传失败（HTTP ${result.statusCode}）`);
  let data;
  try { data = JSON.parse(result.body.toString('utf8')); } catch { throw new Error('图床未返回 JSON，请检查上传接口'); }
  let value = data;
  for (const part of config.responseUrlPath.split('.')) value = value != null && Object.prototype.hasOwnProperty.call(Object(value), part) ? value[part] : undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`响应中没有找到图片 URL：${config.responseUrlPath}`);
  const direct = new URL(value, config.uploadUrl);
  if (!['http:', 'https:'].includes(direct.protocol) || direct.username || direct.password) throw new Error('图床返回的图片地址必须是 HTTP(S) 地址');
  return { directUrl: direct.toString(), pageUrl: direct.toString() };
}

async function uploadExtended(dataUrl, value) {
  const { config, errors } = validateImageHost(value);
  if (errors.length) throw new Error(errors.join('；'));
  const image = parseImage(dataUrl);
  return config.provider === 'custom' ? uploadCustom(image, config) : uploadS3(image, config);
}

module.exports = { uploadExtended, signS3Request, objectTarget, parseImage };
