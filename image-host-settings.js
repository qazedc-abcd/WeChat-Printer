(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PrinterImageHost = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PROVIDERS = ['imgchr', 'cfbed', 'r2', 's3', 'custom'];
  const NAMES = { imgchr: '路过图床', cfbed: 'CloudFlare ImgBed', r2: 'Cloudflare R2', s3: 'S3 兼容存储', custom: '自定义 HTTP 图床' };
  function normalizeImageHost(value = {}) {
    const provider = PROVIDERS.includes(value.provider) ? value.provider : 'imgchr';
    const days = value.cacheExpireDays == null || value.cacheExpireDays === '' ? 7 : Number(value.cacheExpireDays);
    const common = { provider, cacheExpireDays: Number.isFinite(days) ? Math.max(0, Math.min(36500, Math.floor(days))) : 7, deleteExpiredCache: provider === 'cfbed' && value.deleteExpiredCache === true };
    const string = key => String(value[key] || '').trim();
    if (provider === 'cfbed') return { ...common, baseUrl: string('baseUrl'), token: string('token'), authCode: string('authCode'), uploadChannel: string('uploadChannel') };
    if (provider === 'r2' || provider === 's3') return {
      ...common, endpoint: string('endpoint'), bucket: string('bucket'), region: string('region') || (provider === 'r2' ? 'auto' : 'us-east-1'),
      accessKeyId: string('accessKeyId'), secretAccessKey: string('secretAccessKey'), sessionToken: string('sessionToken'),
      publicBaseUrl: string('publicBaseUrl').replace(/\/+$/, ''), prefix: value.prefix == null ? 'wechat-printer' : string('prefix').replace(/^\/+|\/+$/g, ''),
      forcePathStyle: value.forcePathStyle !== false,
    };
    if (provider === 'custom') return { ...common, uploadUrl: string('uploadUrl'), fileField: string('fileField') || 'file', responseUrlPath: string('responseUrlPath') || 'url', authorization: string('authorization') };
    return { ...common, cacheExpireDays: 7, deleteExpiredCache: false };
  }
  function validateImageHost(value) {
    const config = normalizeImageHost(value);
    const errors = [];
    const checkUrl = (key, label, allowQuery = false) => {
      try {
        const url = new URL(config[key]);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || (!allowQuery && url.search)) throw new Error();
      } catch { errors.push(`${label}必须是有效的 HTTP(S) 地址，不能包含账号、锚点${allowQuery ? '' : '或查询参数'}`); }
    };
    if (config.provider === 'cfbed') checkUrl('baseUrl', 'ImgBed 站点地址');
    if (['r2', 's3'].includes(config.provider)) {
      checkUrl('endpoint', 'S3 API Endpoint'); checkUrl('publicBaseUrl', '公开访问地址');
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(config.bucket)) errors.push('请填写有效的 Bucket 名称');
      if (!/^[a-zA-Z0-9-]+$/.test(config.region)) errors.push('Region 只能包含字母、数字或连字符');
      if (!config.accessKeyId || !config.secretAccessKey) errors.push('请填写 Access Key ID 和 Secret Access Key');
      if (config.prefix.split('/').some(part => part === '.' || part === '..')) errors.push('对象前缀不能包含 . 或 .. 路径段');
      if (/\r|\n/.test(config.sessionToken + config.accessKeyId)) errors.push('密钥不能包含换行');
    }
    if (config.provider === 'custom') {
      checkUrl('uploadUrl', '上传接口', true);
      if (!/^[a-zA-Z0-9_-]+$/.test(config.fileField)) errors.push('文件字段名只能包含字母、数字、下划线和连字符');
      if (!/^[a-zA-Z0-9_.-]+$/.test(config.responseUrlPath) || config.responseUrlPath.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) errors.push('返回 URL 路径无效，例如 data.url 或 0.url');
      if (/\r|\n/.test(config.authorization)) errors.push('Authorization 不能包含换行');
    }
    return { config, errors, valid: errors.length === 0 };
  }
  return { PROVIDERS, NAMES, normalizeImageHost, validateImageHost };
});
