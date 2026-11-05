const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { spawn } = require('child_process');
const { createHash } = require('node:crypto');
const { uploadExtended } = require('./upload-provider');
const { normalizeImageHost, validateImageHost } = require('./image-host-settings');
const { normalizeAi, checkWithAi } = require('./ai-markdown');
const Markdown = require('./markdown-engine');
const { OneBotClient, normalizeOneBotUrl } = require('./onebot-client');
let onebotClient = null;
const { printableText, unsupportedCharacters } = require('./printable-text');
const { onebotPrintNodes, onebotContentNodes, onebotQrAllowed } = require('./onebot-layout');
const { isSidExpired } = require('./print-response');
const {
  MAX_PREVIEW_LENGTH,
  MAX_MESSAGES,
  MAX_AUDIT_LOGS,
  normalizeAdminUserIds,
  parseOneBotCommand,
  parseOneBotUserId,
  parseDuration,
  truncateText,
  paginateOneBotText,
  emptyAdminStore,
  normalizeAdminStore,
} = require('./onebot-admin');

const PORT = Number(process.env.PORT) || 4180;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const TARGET_HOST = 'payapp.wechatpay.cn';
const DEFAULT_ONEBOT_API = 'ws://127.0.0.1:3001';
const DEFAULT_IMAGE_HOST = 'imgchr';
const FFMPEG_COMMAND = process.env.WECHAT_PRINTER_FFMPEG || 'ffmpeg';
const MEDIA_SIZE = 280;
const DEFAULT_CACHE_EXPIRE_DAYS = 7;
const MAX_CACHE_EXPIRE_DAYS = 36500;
const DAY_MS = 24 * 60 * 60 * 1000;
const MEDIA_CACHE_VERSION = 2;
const MEDIA_CACHE_FILE = path.join(ROOT, '.onebot-media-cache.json');
const CACHE_META_KEY = '__meta';
const CACHE_PENDING_PREFIX = '__pending-delete:';
const CONFIG_FILE = path.join(ROOT, 'config.json');
const ONEBOT_ADMIN_FILE = path.join(ROOT, '.onebot-admin.json');
const ENV_ADMIN_USER_IDS = normalizeAdminUserIds(process.env.ONEBOT_ADMIN_USER_IDS || '');

function log(level, message, detail = '') {
  const suffix = detail ? ` | ${String(detail).replace(/\s+/g, ' ').trim()}` : '';
  const line = `[${new Date().toISOString()}] [${level}] ${message}${suffix}`;
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}

const DEFAULT_APP_CONFIG = {
  storageMode: 'browser',
  device: { sn: '', sid: '', accountType: 2 },
  onebot: {
    apiBase: DEFAULT_ONEBOT_API, token: '',
    maxPerMinute: 2, maxCharsPerTask: 0,
    rateLimitStrikeWindowMinutes: 1, rateLimitPenaltyMinutes: [2, 10, 1440], rateLimitBlacklistOnThird: false,
    blacklist: [],
    photoEnabled: true, markdownEnabled: true,
    reply_printing: '正在打印，请稍候。', reply_printed: '已打印。',
    reply_print_failed: '打印失败，请稍后重试。', reply_unsupported: '该消息类型不支持打印，请发送文字。',
    reply_rate_limited: '操作太频繁，请稍后再试。',
    adminUserIds: [],
  },
  imageHost: { provider: DEFAULT_IMAGE_HOST, cacheExpireDays: DEFAULT_CACHE_EXPIRE_DAYS, deleteExpiredCache: false },
  ai: normalizeAi(),
};

function normalizeAccountType(value, fallback = 2) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  if (!text) return '';
  const number = Number(text);
  return Number.isFinite(number) ? number : fallback;
}

function mergeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const onebot = source.onebot && typeof source.onebot === 'object' ? source.onebot : {};
  const device = source.device && typeof source.device === 'object' ? source.device : {};
  const savedDevices = Array.isArray(source.savedDevices) ? source.savedDevices.filter((item) => item?.sn && item?.sid).map((item) => ({
    sn: String(item.sn),
    sid: String(item.sid),
    account_type: normalizeAccountType(item.account_type ?? item.accountType),
  })) : [];
  const sharedDevice = device.sn && device.sid ? device : savedDevices[0] || {};
  const { device_sn: _device_sn, deviceSn: _deviceSn, sid: _sid, accountType: _accountType, account_type: _account_type, ...onebotSettings } = onebot;
  return {
    storageMode: source.storageMode === 'local' ? 'local' : 'browser',
    device: { sn: String(sharedDevice.sn || ''), sid: String(sharedDevice.sid || ''), accountType: normalizeAccountType(sharedDevice.account_type ?? sharedDevice.accountType ?? device.account_type ?? device.accountType ?? savedDevices[0]?.account_type) },
    onebot: {
      ...DEFAULT_APP_CONFIG.onebot,
      ...onebotSettings,
      apiBase: String(onebot.apiBase || DEFAULT_ONEBOT_API),
      token: String(onebot.token || ''),
      maxPerMinute: Number.isFinite(Number(onebot.maxPerMinute)) ? Math.max(0, Math.min(100, Math.floor(Number(onebot.maxPerMinute)))) : 2,
      maxCharsPerTask: Number.isFinite(Number(onebot.maxCharsPerTask)) ? Math.max(0, Math.min(4294967295, Math.floor(Number(onebot.maxCharsPerTask)))) : 0,
      rateLimitStrikeWindowMinutes: Number.isFinite(Number(onebot.rateLimitStrikeWindowMinutes)) ? Math.max(1, Math.min(1440, Math.floor(Number(onebot.rateLimitStrikeWindowMinutes)))) : 1,
      rateLimitPenaltyMinutes: Array.isArray(onebot.rateLimitPenaltyMinutes) ? [0, 1, 2].map((index) => Number.isFinite(Number(onebot.rateLimitPenaltyMinutes[index])) ? Math.max(0, Math.min(525600, Math.floor(Number(onebot.rateLimitPenaltyMinutes[index])))) : [2, 10, 1440][index]) : [2, 10, 1440],
      rateLimitBlacklistOnThird: onebot.rateLimitBlacklistOnThird === true,
      adminUserIds: normalizeAdminUserIds(onebot.adminUserIds),
      blacklist: Array.isArray(onebot.blacklist) ? onebot.blacklist.filter((item) => item && item.userId).map((item) => ({
        userId: String(item.userId), name: String(item.name || '未知用户'), username: String(item.username || ''),
        blockedUntil: item.blockedUntil === null ? null : Number(item.blockedUntil) || null,
        reason: String(item.reason || '多次触发频率限制'), strikes: Number(item.strikes) || 0, createdAt: Number(item.createdAt) || Date.now(),
      })) : [],
      photoEnabled: onebot.photoEnabled !== false,
      markdownEnabled: onebot.markdownEnabled !== false,
    },
    imageHost: imageHostConfig(source.imageHost || {}),
    ai: normalizeAi(source.ai || {}),
  };
}

function loadAppConfig() {
  try { return mergeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch { return mergeConfig(); }
}

function saveAppConfig(value) {
  const config = mergeConfig({ ...value, storageMode: 'local' });
  const temporaryFile = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryFile, CONFIG_FILE);
  return config;
}

function clearAppConfig() {
  try { fs.unlinkSync(CONFIG_FILE); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  appConfig = mergeConfig();
  aiRuntime = normalizeAi(appConfig.ai);
}

let appConfig = loadAppConfig();
let aiRuntime = normalizeAi(appConfig.ai);

function loadOneBotAdminStore() {
  try {
    const store = normalizeAdminStore(JSON.parse(fs.readFileSync(ONEBOT_ADMIN_FILE, 'utf8')), [...appConfig.onebot.adminUserIds, ...ENV_ADMIN_USER_IDS]);
    if (!Object.keys(store.blacklist).length && Array.isArray(appConfig.onebot.blacklist)) {
      return normalizeAdminStore({ ...store, blacklist: appConfig.onebot.blacklist }, [...appConfig.onebot.adminUserIds, ...ENV_ADMIN_USER_IDS]);
    }
    return store;
  } catch {
    return normalizeAdminStore({ blacklist: appConfig.onebot.blacklist }, [...appConfig.onebot.adminUserIds, ...ENV_ADMIN_USER_IDS]);
  }
}

let onebotAdminStore = loadOneBotAdminStore();

function saveOneBotAdminStore() {
  try {
    onebotAdminStore = normalizeAdminStore({
      ...onebotAdminStore,
      adminUserIds: [...onebotState.adminUserIds],
      users: Object.fromEntries(onebotState.users),
      userOverrides: Object.fromEntries(onebotState.userOverrides),
      blacklist: Object.fromEntries(onebotState.blacklist),
      messages: onebotState.messages,
      auditLogs: onebotState.auditLogs,
    }, [...onebotState.adminUserIds]);
    const temporaryFile = `${ONEBOT_ADMIN_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryFile, `${JSON.stringify(onebotAdminStore, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryFile, ONEBOT_ADMIN_FILE);
    return true;
  } catch (error) {
    log('ERROR', 'OneBot 管理数据保存失败', error.message);
    return false;
  }
}

function loadMediaCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MEDIA_CACHE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const mediaCache = loadMediaCache();

function saveMediaCache() {
  try {
    const temporaryFile = `${MEDIA_CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(mediaCache, null, 2), 'utf8');
    fs.renameSync(temporaryFile, MEDIA_CACHE_FILE);
  } catch {
    // Cache persistence is optional; a failed write must not block printing.
  }
}

function mediaCacheKey(media, variant = 'default', kind = 'photo') {
  const id = media?.file_unique_id || media?.file_id;
  return id ? `${kind}:${String(id)}:${variant}` : '';
}

function imageHostCacheScope(config) {
  const settings = imageHostConfig(config);
  if (['r2', 's3', 'custom'].includes(settings.provider)) {
    const scope = { provider: settings.provider, endpoint: settings.endpoint, bucket: settings.bucket, prefix: settings.prefix, publicBaseUrl: settings.publicBaseUrl, uploadUrl: settings.uploadUrl, fileField: settings.fileField, responseUrlPath: settings.responseUrlPath, identity: createHash('sha256').update(settings.accessKeyId || settings.authorization || '').digest('hex') };
    return `${settings.provider}:${createHash('sha256').update(JSON.stringify(scope)).digest('hex')}`;
  }
  return settings.provider === 'cfbed' ? `cfbed:${settings.baseUrl}` : DEFAULT_IMAGE_HOST;
}

function cacheEntryExpired(entry, settings, now = Date.now()) {
  return settings.cacheExpireDays > 0 && now - entry.createdAt >= settings.cacheExpireDays * DAY_MS;
}

function getCachedMediaEntry(key, config) {
  if (!key) return null;
  const entry = mediaCache[key];
  if (!entry?.directUrl || entry.processingVersion !== MEDIA_CACHE_VERSION || !Number.isFinite(entry.createdAt)) return null;
  const settings = imageHostConfig(config);
  if (entry.cacheScope !== imageHostCacheScope(settings)) return null;
  return { key, entry, settings };
}

async function getCachedMedia(key, config) {
  const candidate = getCachedMediaEntry(key, config);
  if (!candidate) return null;
  if (cacheEntryExpired(candidate.entry, candidate.settings)) {
    queueExpiredCacheEntry(candidate);
    return null;
  }
  return { ...candidate.entry, cached: true };
}

function cacheRemotePath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const decodePath = (pathValue) => { try { return decodeURIComponent(pathValue); } catch { return pathValue; } };
  try { return decodePath(new URL(raw).pathname).replace(/^\/+/, ''); } catch { return decodePath(raw.split(/[?#]/, 1)[0]).replace(/^\/+/, ''); }
}

function cfBedEntryRemotePath(entry) {
  return cacheRemotePath(entry.remotePath || entry.src || entry.directUrl);
}

function deletePermissionError(statusCode, message) {
  return statusCode === 401 || statusCode === 403 || /permission|forbidden|unauthorized|access denied|权限|未授权|禁止|无权/i.test(String(message || ''));
}

function queueExpiredCacheEntry(candidate) {
  const { key, entry, settings } = candidate;
  let changed = false;
  if (settings.provider === 'cfbed' && settings.deleteExpiredCache) {
    const remotePath = cfBedEntryRemotePath(entry);
    const alreadyQueued = remotePath && Object.values(mediaCache).some((value) => (
      value?.pendingDeletion === true
      && value.cacheScope === imageHostCacheScope(settings)
      && value.remotePath === remotePath
    ));
    if (remotePath && !alreadyQueued) {
      mediaCache[`${CACHE_PENDING_PREFIX}${Date.now()}:${Math.random().toString(36).slice(2)}`] = {
        directUrl: entry.directUrl,
        pageUrl: entry.pageUrl || '',
        createdAt: entry.createdAt,
        processingVersion: MEDIA_CACHE_VERSION,
        cacheScope: imageHostCacheScope(settings),
        remotePath,
        pendingDeletion: true,
      };
      changed = true;
    }
  }
  if (mediaCache[key] === entry) {
    delete mediaCache[key];
    changed = true;
  }
  if (changed) saveMediaCache();
}

function imageHostCleanupStatus() {
  return {
    lastCheckAt: imageHostCleanupState.lastCheckAt,
    lastError: imageHostCleanupState.lastError,
    permissionDisabled: imageHostCleanupState.permissionDisabled,
    notice: imageHostCleanupState.notice,
  };
}

function disableExpiredCacheDeletion(message) {
  const settings = imageHostConfig(onebotState.imageHost);
  onebotState.imageHost = { ...settings, deleteExpiredCache: false };
  imageHostCleanupState.permissionDisabled = true;
  imageHostCleanupState.lastError = message;
  imageHostCleanupState.notice = `CloudFlare ImgBed API Token 未配置或没有 delete 权限，已自动关闭“自动删除过期图片”。请配置同时具有 upload 和 delete 权限的 Token 后重新开启。`;
  addOneBotLog('system', '已自动关闭过期图片删除', imageHostCleanupState.notice);
  if (appConfig.storageMode === 'local' && appConfig.imageHost?.provider === 'cfbed') {
    try { appConfig = saveAppConfig({ ...appConfig, imageHost: onebotState.imageHost }); } catch (error) { imageHostCleanupState.lastError = `${message}；自动保存关闭状态失败：${error.message}`; }
  }
}

async function deleteCfBedFiles(fileIds, config) {
  if (!fileIds.length) return { deleted: [], failed: [], permissionDenied: false };
  if (!config.token) {
    const error = '未配置 CloudFlare ImgBed API Token';
    return { deleted: [], failed: fileIds, permissionDenied: true, error };
  }
  const body = Buffer.from(JSON.stringify({ fileIds }));
  const target = new URL('/api/manage/delete/batch', `${config.baseUrl}/`);
  const response = await requestBuffer(target, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      Authorization: `Bearer ${config.token}`,
      'User-Agent': 'WeChatPrinter/1.0',
    },
  }, body);
  let result = {};
  try { result = JSON.parse(response.body.toString('utf8')); } catch { /* use HTTP status below */ }
  const message = result?.error || result?.message || `CloudFlare ImgBed 删除失败（HTTP ${response.statusCode}）`;
  const failed = Array.isArray(result?.failed) ? result.failed.map((item) => typeof item === 'string' ? { fileId: item, error: '' } : { fileId: item?.fileId, error: item?.error || '' }).filter((item) => item.fileId) : [];
  const deleted = Array.isArray(result?.deleted) ? result.deleted : response.statusCode >= 200 && response.statusCode < 300 && result?.success !== false ? fileIds : [];
  const permissionDenied = deletePermissionError(response.statusCode, message) || failed.some((item) => deletePermissionError(0, item.error));
  if (permissionDenied) return { deleted, failed, permissionDenied: true, error: message };
  if (response.statusCode < 200 || response.statusCode >= 300 || result?.success === false) return { deleted, failed, permissionDenied: false, error: message };
  return { deleted, failed, permissionDenied: false };
}

function expiredCacheEntries(settings, keys = null) {
  if (settings.provider !== 'cfbed') return [];
  const selectedKeys = keys ? new Set(keys.map((candidate) => candidate.key)) : null;
  return Object.entries(mediaCache)
    .filter(([key, entry]) => (
      (!selectedKeys || selectedKeys.has(key))
      && entry?.cacheScope === imageHostCacheScope(settings)
      && Number.isFinite(entry.createdAt)
      && (entry.pendingDeletion === true || cacheEntryExpired(entry, settings))
    ))
    .map(([key, entry]) => ({ key, entry, settings }));
}

async function removeExpiredCacheEntries(config, candidates = null) {
  const settings = imageHostConfig(config);
  const entries = candidates || expiredCacheEntries(settings);
  if (!entries.length) return { blocked: false, deleted: 0 };
  if (!settings.deleteExpiredCache) {
    let deleted = 0;
    entries.forEach(({ key, entry }) => { if (mediaCache[key] === entry) { delete mediaCache[key]; deleted += 1; } });
    if (deleted) saveMediaCache();
    return { blocked: false, deleted };
  }
  const remoteEntries = entries.map((candidate) => ({ ...candidate, remotePath: cfBedEntryRemotePath(candidate.entry) })).filter((candidate) => candidate.remotePath);
  const deletablePaths = [...new Set(remoteEntries.map((candidate) => candidate.remotePath))];
  const deletions = new Map();
  let failure = '';
  for (let offset = 0; offset < deletablePaths.length; offset += 500) {
    const result = await deleteCfBedFiles(deletablePaths.slice(offset, offset + 500), settings);
    if (result.permissionDenied) {
      disableExpiredCacheDeletion(result.error || '删除接口拒绝访问');
      return { blocked: true, error: imageHostCleanupState.notice };
    }
    result.deleted.forEach((fileId) => deletions.set(fileId, true));
    if (result.failed.length || result.error) failure = result.error || '部分过期图片删除失败';
  }
  const remotePathByKey = new Map(remoteEntries.map((candidate) => [candidate.key, candidate.remotePath]));
  const removable = entries.filter((candidate) => {
    const remotePath = remotePathByKey.get(candidate.key);
    return !remotePath || deletions.has(remotePath);
  });
  let deleted = 0;
  removable.forEach(({ key, entry }) => { if (mediaCache[key] === entry) { delete mediaCache[key]; deleted += 1; } });
  if (deleted) saveMediaCache();
  if (failure) return { blocked: true, error: failure };
  return { blocked: false, deleted };
}

async function runExpiredCacheCleanup(config = onebotState.imageHost) {
  imageHostCleanupState.lastCheckAt = Date.now();
  imageHostCleanupState.lastError = '';
  const settings = imageHostConfig(config);
  const hasPendingDeletion = expiredCacheEntries(settings).some(({ entry }) => entry.pendingDeletion === true);
  if (settings.provider !== 'cfbed' || !settings.deleteExpiredCache || (settings.cacheExpireDays === 0 && !hasPendingDeletion)) return { blocked: false, deleted: 0 };
  let result;
  try { result = await removeExpiredCacheEntries(settings); } catch (error) { result = { blocked: true, error: error.message }; }
  if (result.blocked) imageHostCleanupState.lastError = result.error || '';
  else imageHostCleanupState.notice = result.deleted ? `已删除 ${result.deleted} 个过期 CloudFlare ImgBed 文件。` : '';
  return result;
}

function localDateKey(date = new Date()) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((value) => String(value).padStart(2, '0'))
    .join('-');
}

function cleanupScope(settings) {
  return `${imageHostCacheScope(settings)}:${settings.cacheExpireDays}:${settings.deleteExpiredCache ? 'delete' : 'keep'}`;
}

function cleanupAlreadyDoneToday(settings) {
  const meta = mediaCache[CACHE_META_KEY];
  const done = meta?.lastCleanupDate === localDateKey() && meta.lastCleanupScope === cleanupScope(settings);
  if (done && Number.isFinite(meta.lastCleanupAt)) imageHostCleanupState.lastCheckAt = meta.lastCleanupAt;
  return done;
}

function markCleanupDone(settings) {
  mediaCache[CACHE_META_KEY] = {
    lastCleanupDate: localDateKey(),
    lastCleanupScope: cleanupScope(settings),
    lastCleanupAt: Date.now(),
  };
  saveMediaCache();
}

let imageHostCleanupRun = null;

async function runScheduledCacheCleanup(config = onebotState.imageHost) {
  const settings = imageHostConfig(config);
  if (settings.provider !== 'cfbed' || !settings.deleteExpiredCache) return { blocked: false, deleted: 0, skipped: true };
  const hasPendingDeletion = expiredCacheEntries(settings).some(({ entry }) => entry.pendingDeletion === true);
  if (settings.cacheExpireDays === 0 && !hasPendingDeletion) return { blocked: false, deleted: 0, skipped: true };
  if (cleanupAlreadyDoneToday(settings)) return { blocked: false, deleted: 0, skipped: true };
  if (imageHostCleanupRun) return imageHostCleanupRun;

  const run = (async () => {
    let result;
    try { result = await runExpiredCacheCleanup(settings); } catch (error) { result = { blocked: true, error: error.message }; }
    if (result.blocked) imageHostCleanupState.lastError = result.error || '';
    markCleanupDone(settings);
    return result;
  })();
  imageHostCleanupRun = run;
  try { return await run; } finally {
    if (imageHostCleanupRun === run) imageHostCleanupRun = null;
  }
}

function resetImageHostCleanupStatus() {
  imageHostCleanupState.lastCheckAt = 0;
  imageHostCleanupState.lastError = '';
  imageHostCleanupState.permissionDisabled = false;
  imageHostCleanupState.notice = '';
}

function applyImageHostSettings(config) {
  const settings = imageHostConfig(config);
  const preservePermissionNotice = imageHostCleanupState.permissionDisabled
    && settings.provider === 'cfbed'
    && settings.deleteExpiredCache === false;
  onebotState.imageHost = settings;
  if (!preservePermissionNotice) resetImageHostCleanupStatus();
  return settings;
}

function scheduleImageHostCleanup() {
  if (imageHostCleanupTimer) clearTimeout(imageHostCleanupTimer);
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  imageHostCleanupTimer = setTimeout(async () => {
    try { await runScheduledCacheCleanup(onebotState.imageHost); } catch (error) { imageHostCleanupState.lastError = error.message; }
    scheduleImageHostCleanup();
  }, Math.max(1000, next.getTime() - now.getTime()));
}

function cacheMedia(key, hosted, config) {
  if (!key || !hosted?.directUrl) return;
  mediaCache[key] = {
    directUrl: hosted.directUrl,
    pageUrl: hosted.pageUrl || '',
    createdAt: Date.now(),
    processingVersion: MEDIA_CACHE_VERSION,
    cacheScope: imageHostCacheScope(config),
    remotePath: hosted.remotePath || '',
  };
  saveMediaCache();
}

const onebotState = {
  running: false,
  token: '',
  offset: 0,
  sid: '',
  deviceSn: '',
  accountType: 2,
  apiBase: DEFAULT_ONEBOT_API,
  maxPerMinute: 2,
  maxCharsPerTask: 0,
  rateLimitStrikeWindowMinutes: 1,
  rateLimitPenaltyMinutes: [2, 10, 1440],
  rateLimitBlacklistOnThird: false,
  photoEnabled: true,
  markdownEnabled: true,
  replyPrinting: '正在打印，请稍候。',
  replyPrinted: '已打印。',
  replyPrintFailed: '打印失败，请稍后重试。',
  replyUnsupported: '该消息类型不支持打印，请发送文字。',
  replyRateLimited: '操作太频繁，请稍后再试。',
  logs: [],
  adminUserIds: new Set(onebotAdminStore.adminUserIds),
  users: new Map(Object.entries(onebotAdminStore.users)),
  userOverrides: new Map(Object.entries(onebotAdminStore.userOverrides)),
  messages: onebotAdminStore.messages.slice(-MAX_MESSAGES),
  messageById: new Map(onebotAdminStore.messages.map((item) => [item.id, item])),
  auditLogs: onebotAdminStore.auditLogs.slice(-MAX_AUDIT_LOGS),
  userTasks: new Map(),
  rateLimitStrikes: new Map(),
  blacklist: new Map(Object.entries(onebotAdminStore.blacklist)),
  printQueue: [],
  printFlushTimer: null,
  lastMessage: '',
  error: '',
  retryCount: 0,
  generation: 0,
  imageHost: appConfig.imageHost,
};
const imageHostCleanupState = {
  lastCheckAt: 0,
  lastError: '',
  permissionDisabled: false,
  notice: '',
};
let imageHostCleanupTimer = null;
const MAX_ONEBOT_LOGS = 200;
const MAX_ONEBOT_MESSAGES = MAX_MESSAGES;
const MAX_ONEBOT_AUDIT_LOGS = MAX_AUDIT_LOGS;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function readRequestBody(req, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function requestBuffer(target, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(target, options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.setTimeout(30_000, () => request.destroy(new Error('图床请求超时')));
    if (body) request.write(body);
    request.end();
  });
}

function extractImgchrToken(html) {
  const match = String(html).match(/auth_token\s*=\s*["']([^"']+)["']/i);
  return match?.[1] || '';
}

function appendMultipartField(parts, boundary, name, value) {
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
}

function appendMultipartFile(parts, boundary, name, filename, mime, data) {
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`));
  parts.push(data);
  parts.push(Buffer.from('\r\n'));
}

async function uploadToImgchr(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([a-z0-9+/=]+)$/i);
  if (!match) throw new Error('只支持 PNG、JPEG 或 WebP 图片');
  const mime = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
  const imageData = Buffer.from(match[2], 'base64');
  if (!imageData.length || imageData.length > 8 * 1024 * 1024) throw new Error('图片大小必须在 8MB 以内');

  const landing = await requestBuffer(new URL('https://imgchr.com/'), { method: 'GET', headers: { 'User-Agent': 'WeChatPrinter/1.0' } });
  if (landing.statusCode < 200 || landing.statusCode >= 300) throw new Error(`无法连接 Imgchr（HTTP ${landing.statusCode}）`);
  const token = extractImgchrToken(landing.body.toString('utf8'));
  if (!token) throw new Error('Imgchr 未返回上传授权信息');
  const cookie = Array.isArray(landing.headers['set-cookie']) ? landing.headers['set-cookie'].map((value) => value.split(';')[0]).join('; ') : '';
  const boundary = `----WeChatPrinter${Date.now().toString(16)}`;
  const parts = [];
  appendMultipartFile(parts, boundary, 'source', `receipt.${extension}`, mime, imageData);
  appendMultipartField(parts, boundary, 'type', 'file');
  appendMultipartField(parts, boundary, 'action', 'upload');
  appendMultipartField(parts, boundary, 'privacy', '0');
  appendMultipartField(parts, boundary, 'timestamp', `${Date.now()}`);
  appendMultipartField(parts, boundary, 'auth_token', token);
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  const uploaded = await requestBuffer(new URL('https://imgchr.com/json'), {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length, 'User-Agent': 'WeChatPrinter/1.0', ...(cookie ? { Cookie: cookie } : {}) },
  }, body);
  let result;
  try { result = JSON.parse(uploaded.body.toString('utf8')); } catch { throw new Error('Imgchr 返回了无法解析的响应'); }
  const directUrl = result?.image?.url || result?.image?.image?.url || result?.success?.image?.url;
  const pageUrl = result?.image?.url_viewer || result?.image?.url_short || '';
  if (uploaded.statusCode < 200 || uploaded.statusCode >= 300 || !directUrl) throw new Error(result?.error?.message || result?.status_txt || `Imgchr 上传失败（HTTP ${uploaded.statusCode}）`);
  return { directUrl, pageUrl };
}

function normalizeImageHostBase(value) {
  const target = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('CloudFlare ImgBed 地址只支持 HTTP 或 HTTPS');
  if (target.username || target.password) throw new Error('CloudFlare ImgBed 地址不能包含用户名或密码');
  if (target.search || target.hash) throw new Error('CloudFlare ImgBed 地址不能包含查询参数或锚点');
  target.pathname = target.pathname.replace(/\/+$/, '');
  return target.toString().replace(/\/$/, '');
}

function normalizeCacheExpireDays(value) {
  if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_CACHE_EXPIRE_DAYS;
  const days = Number(value);
  return Number.isFinite(days) ? Math.max(0, Math.min(MAX_CACHE_EXPIRE_DAYS, Math.floor(days))) : DEFAULT_CACHE_EXPIRE_DAYS;
}

function imageHostConfig(value = {}) {
  if (['r2', 's3', 'custom'].includes(value.provider)) return normalizeImageHost(value);
  const provider = value.provider === 'cfbed' ? 'cfbed' : DEFAULT_IMAGE_HOST;
  if (provider === DEFAULT_IMAGE_HOST) return { provider, cacheExpireDays: DEFAULT_CACHE_EXPIRE_DAYS, deleteExpiredCache: false };
  const baseUrl = normalizeImageHostBase(value.baseUrl);
  const token = String(value.token || '').trim();
  const authCode = String(value.authCode || '').trim();
  const uploadChannel = String(value.uploadChannel || '').trim();
  return { provider, baseUrl, token, authCode, uploadChannel, cacheExpireDays: normalizeCacheExpireDays(value.cacheExpireDays), deleteExpiredCache: value.deleteExpiredCache === true };
}

function cacheHitDetail(config) {
  const days = imageHostConfig(config).cacheExpireDays;
  return days === 0 ? '命中永久缓存，复用图片直链' : `命中 ${days} 天缓存，复用图片直链`;
}

async function uploadToCfBed(dataUrl, config) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([a-z0-9+/=]+)$/i);
  if (!match) throw new Error('只支持 PNG、JPEG 或 WebP 图片');
  const mime = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
  const imageData = Buffer.from(match[2], 'base64');
  if (!imageData.length || imageData.length > 20 * 1024 * 1024) throw new Error('图片大小必须在 20MB 以内');

  const query = new URLSearchParams({ returnFormat: 'full' });
  if (config.authCode) query.set('authCode', config.authCode);
  if (config.uploadChannel) query.set('uploadChannel', config.uploadChannel);
  const boundary = `----WeChatPrinterCfBed${Date.now().toString(16)}`;
  const parts = [];
  appendMultipartFile(parts, boundary, 'file', `receipt.${extension}`, mime, imageData);
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  const headers = {
    Accept: 'application/json',
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': body.length,
    'User-Agent': 'WeChatPrinter/1.0',
  };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  const uploaded = await requestBuffer(new URL(`/upload?${query.toString()}`, `${config.baseUrl}/`), { method: 'POST', headers }, body);
  let result;
  try { result = JSON.parse(uploaded.body.toString('utf8')); } catch { throw new Error('CloudFlare ImgBed 返回了无法解析的响应'); }
  const item = Array.isArray(result) ? result[0] : result;
  let directUrl = item?.publicUrl || item?.url || item?.src;
  if (directUrl && !/^https?:\/\//i.test(directUrl)) directUrl = new URL(directUrl, `${config.baseUrl}/`).toString();
  if (uploaded.statusCode < 200 || uploaded.statusCode >= 300 || !directUrl) {
    const message = result?.message || result?.error || item?.message || `CloudFlare ImgBed 上传失败（HTTP ${uploaded.statusCode}）`;
    throw new Error(message);
  }
  return { directUrl, pageUrl: directUrl, remotePath: cacheRemotePath(item?.src || directUrl) };
}

async function uploadHostedImage(dataUrl, config = {}) {
  const settings = imageHostConfig(config);
  if (['r2', 's3', 'custom'].includes(settings.provider)) return uploadExtended(dataUrl, settings);
  return settings.provider === 'cfbed' ? uploadToCfBed(dataUrl, settings) : uploadToImgchr(dataUrl);
}

async function imageHostUpload(req, res) {
  try {
    const raw = await readRequestBody(req, 28 * 1024 * 1024);
    const payload = JSON.parse(raw.toString('utf8') || '{}');
    const result = await uploadHostedImage(payload.dataUrl, payload.settings || payload.imageHost);
    log('INFO', '图片上传完成', `${imageHostConfig(payload.settings || payload.imageHost).provider}，${raw.length} bytes 请求体`);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
  } catch (error) {
    log('ERROR', '图片上传失败', error.message);
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

async function setImageHostSettings(req, res) {
  try {
    const raw = await readRequestBody(req, 64 * 1024);
    const settings = JSON.parse(raw.toString('utf8') || '{}');
    const validation = validateImageHost(settings);
    if (!validation.valid) throw new Error(validation.errors.join('；'));
    applyImageHostSettings(settings);
    await runScheduledCacheCleanup(onebotState.imageHost);
    log('INFO', '图床设置已更新', onebotState.imageHost.provider);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      provider: onebotState.imageHost.provider,
      baseUrl: onebotState.imageHost.baseUrl || '',
      uploadChannel: onebotState.imageHost.uploadChannel || '',
      cacheExpireDays: onebotState.imageHost.cacheExpireDays,
      deleteExpiredCache: onebotState.imageHost.deleteExpiredCache,
      cleanup: imageHostCleanupStatus(),
    }));
  } catch (error) {
    log('ERROR', '图床设置更新失败', error.message);
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

async function imageHostTest(req, res) {
  try {
    const payload = JSON.parse((await readRequestBody(req, 64 * 1024)).toString('utf8') || '{}');
    const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJesAAAAASUVORK5CYII=';
    const result = await uploadHostedImage(pixel, payload.settings || onebotState.imageHost);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ...result, message: '测试图片已上传，请打开直链确认可公开访问' }));
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: error.message }));
  }
}

async function markdownApi(req, res, useAi = false) {
  try {
    const payload = JSON.parse((await readRequestBody(req, 1024 * 1024)).toString('utf8') || '{}');
    if (typeof payload.text !== 'string') throw new Error('请提供 text 字符串');
    const result = useAi ? await checkWithAi(payload.text, payload.settings || aiRuntime) : { ...Markdown.analyzeMarkdown(payload.text), nodes: Markdown.markdownToNodes(payload.text) };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: error.message }));
  }
}

async function markdownImage(req, res) {
  try {
    const payload = JSON.parse((await readRequestBody(req, 64 * 1024)).toString('utf8') || '{}');
    const result = await processMarkdownImage(payload.url, payload.settings || onebotState.imageHost);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: error.message }));
  }
}

async function setAiSettings(req, res) {
  try {
    const payload = JSON.parse((await readRequestBody(req, 64 * 1024)).toString('utf8') || '{}');
    aiRuntime = normalizeAi(payload);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ enabled: aiRuntime.enabled, baseUrl: aiRuntime.baseUrl, model: aiRuntime.model, keyConfigured: Boolean(aiRuntime.apiKey) }));
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: error.message }));
  }
}

function getAppConfig(res) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(appConfig));
}

async function updateAppConfig(req, res) {
  try {
    const raw = await readRequestBody(req, 256 * 1024);
    appConfig = saveAppConfig(JSON.parse(raw.toString('utf8') || '{}'));
    aiRuntime = normalizeAi(appConfig.ai);
    applyImageHostSettings(appConfig.imageHost);
    await runScheduledCacheCleanup(onebotState.imageHost);
    log('INFO', '本地配置已保存');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ saved: true, config: appConfig }));
  } catch (error) {
    log('ERROR', '本地配置保存失败', error.message);
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

function deleteAppConfig(res) {
  try {
    clearAppConfig();
    applyImageHostSettings(appConfig.imageHost);
    log('WARN', '本地配置已清除');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ cleared: true }));
  } catch (error) {
    log('ERROR', '本地配置清除失败', error.message);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    const type = MIME_TYPES[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(content);
  });
}

function forwardPrint(sid, body, callback) {
  const proxyReq = https.request({
      hostname: TARGET_HOST,
      path: `/smartqr/printerad/printad?sid=${encodeURIComponent(sid)}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      },
  }, (proxyRes) => {
      const responseChunks = [];
      proxyRes.on('data', (chunk) => responseChunks.push(chunk));
      proxyRes.on('end', () => {
        callback(null, proxyRes.statusCode || 502, proxyRes.headers, Buffer.concat(responseChunks));
      });
  });
  proxyReq.on('error', callback);
  proxyReq.end(body);
}

function sanitizePrintPayload(body) {
  try {
    const payload = JSON.parse(body.toString('utf8'));
    const root = payload?.ad_content?.user_define_template?.root;
    if (!Array.isArray(root)) return body;
    root.forEach((node) => {
      node?.text?.column?.forEach((column) => {
        if (typeof column?.value === 'string') column.value = printableText(column.value);
      });
      node?.content?.lines?.linelist?.forEach((line) => {
        if (Array.isArray(line?.column)) line.column = line.column.map((value) => typeof value === 'string' ? printableText(value) : value);
      });
      if (node?.icon?.type === 1 && typeof node.icon.value === 'string') node.icon.value = printableText(node.icon.value);
    });
    return Buffer.from(JSON.stringify(payload));
  } catch {
    return body;
  }
}

function proxyPrint(req, res, requestUrl) {
  const sid = requestUrl.searchParams.get('sid');
  if (!sid) {
    log('WARN', '打印请求被拒绝', '缺少 sid');
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'sid is required' }));
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = sanitizePrintPayload(Buffer.concat(chunks));
    log('INFO', '打印请求已转发', `${body.length} bytes -> ${TARGET_HOST}`);
    forwardPrint(sid, body, (error, statusCode, headers, responseBody) => {
      if (error) {
        log('ERROR', '打印接口请求失败', error.message);
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: error.message }));
        return;
      }
      log(statusCode >= 200 && statusCode < 300 ? 'INFO' : 'WARN', '打印接口已返回', `HTTP ${statusCode}，${responseBody.length} bytes`);
      res.writeHead(statusCode, { 'Content-Type': headers['content-type'] || 'application/json; charset=utf-8' });
      res.end(responseBody);
    });
  });
}

function normalizeOneBotApiBase(value) {
  return normalizeOneBotUrl(value || DEFAULT_ONEBOT_API);
}

async function onebotRequest(apiBase, token, action, params = {}, timeoutMs = 15000) {
  if (!onebotClient || onebotClient.url !== normalizeOneBotUrl(apiBase) || onebotClient.token !== String(token || '').trim()) {
    if (onebotClient) onebotClient.close();
    onebotClient = new OneBotClient(apiBase, token);
  }
  return onebotClient.call(action, params, timeoutMs);
}

function closeOneBotClient() {
  if (onebotClient) onebotClient.close();
  onebotClient = null;
}

function characterWidth(character) {
  const codePoint = character.codePointAt(0);
  if (codePoint > 0xff || /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uff01-\uff60\uffe0-\uffe6]/u.test(character)) return 2;
  if (character === '8') return 1.45;
  if (/[MWmw@#%&]/.test(character)) return 1.4;
  if (/[1\s.,:;!'`|iIl\[\]()]/.test(character)) return 1;
  return 1.2;
}

function splitTextIntoLines(text, capacity = 32) {
  const lines = [];
  String(text).replace(/\r\n/g, '\n').split('\n').forEach((paragraph) => {
    let line = '';
    let width = 0;
    for (const character of Array.from(paragraph)) {
      const nextWidth = characterWidth(character);
      if (line && width + nextWidth > capacity) {
        lines.push(line);
        line = '';
        width = 0;
      }
      line += character;
      width += nextWidth;
    }
    if (line || !paragraph) lines.push(line);
  });
  return lines.length ? lines : [''];
}

function downloadOneBotBuffer(target, redirects = 0) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(target); } catch { reject(new Error('QQ 图片地址无效')); return; }
    if (!['http:', 'https:'].includes(url.protocol)) { reject(new Error('QQ 图片仅支持 HTTP(S) 地址')); return; }
    if (redirects > 5) { reject(new Error('QQ 图片重定向次数过多')); return; }
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.get(url, { timeout: 30000 }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        downloadOneBotBuffer(new URL(response.headers.location, url).toString(), redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`QQ 图片下载失败（HTTP ${response.statusCode || 0}）`)); return; }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 20 * 1024 * 1024) { response.destroy(new Error('QQ 图片超过 20 MB')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('QQ 图片下载被中断')));
    });
    request.on('timeout', () => request.destroy(new Error('QQ 图片下载超时')));
    request.on('error', () => reject(new Error('QQ 图片下载失败，请检查图片地址或网络')));
  });
}

function runFfmpeg(args, input, errorLabel) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_COMMAND, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    const errors = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.on('error', (error) => fail(new Error(`无法调用 FFmpeg：${error.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error(`${errorLabel}：${Buffer.concat(errors).toString('utf8').trim() || `FFmpeg ${code}`}`));
        return;
      }
      settled = true;
      resolve(Buffer.concat(output));
    });
    child.stdin.end(input);
  });
}



function applyFloydSteinberg(buffer, width, height) {
  const grayscale = new Float32Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    const alpha = buffer[offset + 3] / 255;
    grayscale[index] = (buffer[offset] * 0.299 + buffer[offset + 1] * 0.587 + buffer[offset + 2] * 0.114) * alpha + 255 * (1 - alpha);
  }
  const addError = (x, y, amount) => {
    if (x >= 0 && x < width && y >= 0 && y < height) grayscale[y * width + x] += amount;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const oldValue = grayscale[index];
      const newValue = oldValue < 128 ? 0 : 255;
      const error = oldValue - newValue;
      grayscale[index] = newValue;
      addError(x + 1, y, error * 7 / 16);
      addError(x - 1, y + 1, error * 3 / 16);
      addError(x, y + 1, error * 5 / 16);
      addError(x + 1, y + 1, error / 16);
      const offset = index * 4;
      buffer[offset] = newValue;
      buffer[offset + 1] = newValue;
      buffer[offset + 2] = newValue;
      buffer[offset + 3] = 255;
    }
  }
  return buffer;
}

async function renderOneBotImage(input, filterPrefix, errorLabel) {
  const imageFilter = `${filterPrefix || ''}scale=${MEDIA_SIZE}:${MEDIA_SIZE}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${MEDIA_SIZE}:${MEDIA_SIZE}:(ow-iw)/2:oh-ih:color=white,setsar=1`;
  const rgba = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vf', imageFilter, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], input, errorLabel);
  const expectedLength = MEDIA_SIZE * MEDIA_SIZE * 4;
  if (rgba.length < expectedLength) throw new Error('OneBot 图片处理结果不完整');
  const binarized = applyFloydSteinberg(Buffer.from(rgba.subarray(0, expectedLength)), MEDIA_SIZE, MEDIA_SIZE);
  return runFfmpeg(['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${MEDIA_SIZE}x${MEDIA_SIZE}`, '-i', 'pipe:0', '-frames:v', '1', '-f', 'image2', '-vcodec', 'mjpeg', '-q:v', '2', 'pipe:1'], binarized, 'OneBot 图片 JPEG 编码失败');
}

async function processOneBotPhoto(photo) {
  if (!photo?.file_id && !photo?.source_url) throw new Error('QQ 图片缺少文件标识或地址');
  const cacheKey = mediaCacheKey(photo, 'onebot-photo', 'photo');
  const cached = await getCachedMedia(cacheKey, onebotState.imageHost);
  if (cached) return cached;
  let input;
  if (photo.source_url) {
    try { input = await downloadOneBotBuffer(photo.source_url); } catch { /* Try the local OneBot image resolver. */ }
  }
  if (!input && photo.file_id) {
    const file = await onebotRequest(onebotState.apiBase, onebotState.token, 'get_image', { file: photo.file_id });
    if (file?.url && /^https?:\/\//i.test(file.url)) input = await downloadOneBotBuffer(file.url);
    else if (file?.file && /^https?:\/\//i.test(file.file)) input = await downloadOneBotBuffer(file.file);
    else if (file?.file) {
      // Only read a path returned by our configured OneBot service, never a path supplied directly by a chat message.
      const metadata = await fs.promises.stat(file.file);
      if (!metadata.isFile() || metadata.size > 20 * 1024 * 1024) throw new Error('OneBot 返回的图片文件无效或超过 20 MB');
      input = await fs.promises.readFile(file.file);
    }
  }
  if (!input) throw new Error('无法从 QQ / OneBot 获取图片');
  const jpg = await renderOneBotImage(input, '', 'QQ 图片解码失败');
  const hosted = await uploadHostedImage(`data:image/jpeg;base64,${jpg.toString('base64')}`, onebotState.imageHost);
  cacheMedia(cacheKey, hosted, onebotState.imageHost);
  return { directUrl: hosted.directUrl, pageUrl: hosted.pageUrl };
}

async function processMarkdownImage(source, value) {
  let url;
  try { url = new URL(source); } catch { throw new Error('Markdown 图片地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Markdown 图片仅支持 HTTP(S) 公开地址');
  const validation = validateImageHost(value);
  if (!validation.valid) throw new Error(validation.errors.join('；'));
  const settings = imageHostConfig(validation.config);
  const cacheKey = `markdown:${createHash('sha256').update(url.toString()).digest('hex')}`;
  const cached = await getCachedMedia(cacheKey, settings);
  if (cached) return cached;
  const input = await downloadOneBotBuffer(url.toString());
  const jpg = await renderOneBotImage(input, '', 'Markdown 图片解码失败（需要 FFmpeg）');
  const hosted = await uploadHostedImage(`data:image/jpeg;base64,${jpg.toString('base64')}`, settings);
  cacheMedia(cacheKey, hosted, settings);
  return hosted;
}

async function prepareOneBotMarkdownImages(nodes) {
  const uploaded = new Map();
  for (const node of nodes) if (node.icon?.type === 3) {
    const source = node.icon.value;
    if (!uploaded.has(source)) uploaded.set(source, await processMarkdownImage(source, onebotState.imageHost));
    node.icon.value = uploaded.get(source).directUrl;
  }
  return nodes;
}

function onebotSenderName(user) {
  const firstName = String(user?.first_name || '').trim();
  const lastName = String(user?.last_name || '').trim();
  const fullName = firstName && lastName
    ? (/[㐀-鿿]/u.test(`${firstName}${lastName}`) ? `${firstName}${lastName}` : `${firstName} ${lastName}`)
    : firstName || lastName;
  return fullName || user?.username || String(user?.id || 'unknown');
}

function normalizeReply(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return String(value).trim().slice(0, 500);
}

function addOneBotLog(type, message, detail = '') {
  const entry = { time: new Date().toISOString(), type, message: truncateText(message, MAX_PREVIEW_LENGTH), detail: truncateText(detail, 500) };
  onebotState.logs.push(entry);
  if (onebotState.logs.length > MAX_ONEBOT_LOGS) onebotState.logs.splice(0, onebotState.logs.length - MAX_ONEBOT_LOGS);
  const level = ['failed', 'reply_failed'].includes(type) ? 'ERROR' : ['blocked', 'filtered', 'ignored', 'limited'].includes(type) ? 'WARN' : 'INFO';
  log(level, `OneBot ${type}`, `${entry.message}${entry.detail ? ` | ${entry.detail}` : ''}`);
}

function onebotMessageType(message) {
  if (message?.text) return 'text';
  if (message?.photo) return 'photo';
  if (message?.document) return 'document';
  if (message?.video) return 'video';
  if (message?.voice) return 'voice';
  return 'other';
}

function upsertOneBotUser(user, message = null) {
  const userId = parseOneBotUserId(user?.userId || user?.id);
  if (!userId) return null;
  const now = Date.now();
  const previous = onebotState.users.get(userId);
  const profile = {
    userId,
    name: truncateText(user?.name || previous?.name || '未知用户', 120),
    username: truncateText(user?.username || previous?.username || '', 120),
    firstSeenAt: previous?.firstSeenAt || now,
    lastSeenAt: now,
    messageCount: (previous?.messageCount || 0) + (message ? 1 : 0),
    printSuccessCount: previous?.printSuccessCount || 0,
    printFailedCount: previous?.printFailedCount || 0,
    limitedCount: previous?.limitedCount || 0,
    lastMessageType: message ? onebotMessageType(message) : (previous?.lastMessageType || ''),
    lastMessagePreview: message ? truncateText(message.text || message.caption || `[${onebotMessageType(message)}]`) : (previous?.lastMessagePreview || ''),
  };
  onebotState.users.set(userId, profile);
  return profile;
}

function recordOneBotMessage(message, updateId, userProfile) {
  const userId = String(userProfile.userId);
  const entry = {
    id: `${updateId}:${message.message_id || Date.now()}`,
    updateId: Number(updateId) || 0,
    messageId: Number(message.message_id) || 0,
    userId,
    chatId: String(message.chat?.id || userId),
    receivedAt: Date.now(),
    type: onebotMessageType(message),
    preview: truncateText(message.text || message.caption || `[${onebotMessageType(message)}]`),
    status: 'received',
    detail: '',
    finishedAt: 0,
  };
  onebotState.messages.push(entry);
  onebotState.messageById = onebotState.messageById || new Map();
  onebotState.messageById.set(entry.id, entry);
  if (onebotState.messages.length > MAX_ONEBOT_MESSAGES) {
    const removed = onebotState.messages.splice(0, onebotState.messages.length - MAX_ONEBOT_MESSAGES);
    removed.forEach((item) => onebotState.messageById.delete(item.id));
  }
  return entry;
}

function updateOneBotMessage(id, status, detail = '') {
  const entry = onebotState.messageById?.get(id) || onebotState.messages.find((item) => item.id === id);
  if (!entry) return;
  entry.status = status;
  entry.detail = truncateText(detail, 300);
  if (['printed', 'failed', 'filtered', 'limited', 'blocked'].includes(status)) entry.finishedAt = Date.now();
  const user = onebotState.users.get(entry.userId);
  if (user && status === 'printed') user.printSuccessCount += 1;
  if (user && status === 'failed') user.printFailedCount += 1;
  if (user && status === 'limited') user.limitedCount += 1;
}

function effectiveOneBotRules(userId) {
  const base = { maxPerMinute: onebotState.maxPerMinute, maxCharsPerTask: onebotState.maxCharsPerTask };
  const override = onebotState.userOverrides.get(String(userId));
  if (!override || (override.expiresAt !== null && override.expiresAt <= Date.now())) {
    if (override) {
      onebotState.userOverrides.delete(String(userId));
      saveOneBotAdminStore();
    }
    return base;
  }
  return {
    maxPerMinute: override.maxPerMinute === null ? base.maxPerMinute : override.maxPerMinute,
    maxCharsPerTask: override.maxCharsPerTask === null ? base.maxCharsPerTask : override.maxCharsPerTask,
  };
}

function userTaskAllowed(userId) {
  const maxPerMinute = effectiveOneBotRules(userId).maxPerMinute;
  if (maxPerMinute === 0) return true;
  const now = Date.now();
  const entries = (onebotState.userTasks.get(String(userId)) || []).filter((timestamp) => now - timestamp < 60_000);
  if (entries.length >= maxPerMinute) {
    onebotState.userTasks.set(String(userId), entries);
    return false;
  }
  entries.push(now);
  onebotState.userTasks.set(String(userId), entries);
  return true;
}

function onebotTaskCharCount(text) {
  return Array.from(printableText(text)).length;
}

function queuedTextLengthForUser(userId) {
  return onebotState.printQueue
    .filter((item) => item.userId === userId && item.textLength)
    .reduce((total, item) => total + item.textLength, 0);
}

function textTaskAllowed(userId, textLength) {
  const maxCharsPerTask = effectiveOneBotRules(userId).maxCharsPerTask;
  if (maxCharsPerTask === 0) return true;
  return queuedTextLengthForUser(userId) + textLength <= maxCharsPerTask;
}

function activeBlacklistEntry(userId) {
  const key = String(userId);
  const entry = onebotState.blacklist.get ? onebotState.blacklist.get(key) : onebotState.blacklist.find((item) => item.userId === key);
  if (!entry) return null;
  if (entry.blockedUntil !== null && entry.blockedUntil <= Date.now()) {
    if (onebotState.blacklist.delete) onebotState.blacklist.delete(key);
    else onebotState.blacklist = onebotState.blacklist.filter((item) => item.userId !== key);
    saveOneBotAdminStore();
    return null;
  }
  return entry;
}

function blacklistEntries() {
  const entries = [];
  if (onebotState.blacklist instanceof Map) {
    for (const userId of onebotState.blacklist.keys()) {
      const entry = activeBlacklistEntry(userId);
      if (entry) entries.push({ ...entry });
    }
  } else {
    onebotState.blacklist.forEach((entry) => { if (activeBlacklistEntry(entry.userId)) entries.push({ ...entry }); });
  }
  return entries;
}

function blockedUser(userId) {
  return activeBlacklistEntry(userId);
}

function setBlacklistEntry(entry) {
  if (onebotState.blacklist instanceof Map) {
    onebotState.blacklist.set(String(entry.userId), entry);
    saveOneBotAdminStore();
  }
}

function removeBlacklistEntry(userId) {
  if (onebotState.blacklist instanceof Map) {
    onebotState.blacklist.delete(String(userId));
    saveOneBotAdminStore();
  }
}

function recordRateLimit(user, reason = '多次触发频率限制') {
  const userId = String(user.userId);
  const now = Date.now();
  const windowMs = onebotState.rateLimitStrikeWindowMinutes * 60_000;
  const strikes = (onebotState.rateLimitStrikes.get(userId) || []).filter((timestamp) => now - timestamp < windowMs);
  strikes.push(now);
  onebotState.rateLimitStrikes.set(userId, strikes);
  const strikeNumber = Math.min(strikes.length, 3);
  const permanent = strikeNumber >= 3 && onebotState.rateLimitBlacklistOnThird;
  const penaltyMinutes = onebotState.rateLimitPenaltyMinutes[strikeNumber - 1] || 0;
  const entry = {
    userId,
    name: String(user.name || '未知用户'),
    username: String(user.username || ''),
    blockedUntil: permanent ? null : now + penaltyMinutes * 60_000,
    reason: `${reason}（第 ${strikeNumber} 次）`,
    strikes: strikeNumber,
    createdAt: now,
    createdBy: 'auto',
  };
  if (permanent || penaltyMinutes > 0) setBlacklistEntry(entry);
  const action = permanent ? '已永久拉黑' : penaltyMinutes > 0 ? `封禁 ${penaltyMinutes} 分钟` : '本档未设置临时封禁';
  addOneBotLog('blocked', `${entry.name}${entry.username ? `（${entry.username}）` : ''}`, action);
  return entry;
}

const ONEBOT_LINK_MARKERS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

function onebotLinkMarker(index) {
  return ONEBOT_LINK_MARKERS[index - 1] || `(${index})`;
}

function onebotTextNodes(text, options = {}) {
  text = printableText(text);
  const width = Number(options.width) === 1 ? 1 : 0;
  const capacity = width === 1 ? 16 : 32;
  return onebotContentNodes(splitTextIntoLines(text, capacity), options);
}

function onebotEntityEnd(entity) {
  return entity.offset + entity.length;
}

function onebotFormattedTextNodes(text, entities = [], prefix = '') {
  const source = String(text ?? '');
  const validEntities = (Array.isArray(entities) ? entities : [])
    .map((entity) => ({ ...entity, offset: Number(entity.offset), length: Number(entity.length) }))
    .filter((entity) => Number.isInteger(entity.offset) && Number.isInteger(entity.length) && entity.offset >= 0 && entity.length > 0 && onebotEntityEnd(entity) <= source.length);
  const links = validEntities
    .filter((entity) => ['text_link', 'url'].includes(entity.type))
    .sort((left, right) => left.offset - right.offset)
    .map((entity) => ({
      entity,
      url: entity.type === 'text_link' && entity.url ? String(entity.url) : source.slice(entity.offset, onebotEntityEnd(entity)),
    }))
    .filter((link) => onebotQrAllowed(link.url))
    .map((link, index) => ({ ...link, marker: onebotLinkMarker(index + 1) }));
  const linkByEntity = new Map(links.map((link) => [link.entity, link]));
  const boundaries = new Set([0, source.length]);
  validEntities.forEach((entity) => {
    boundaries.add(entity.offset);
    boundaries.add(onebotEntityEnd(entity));
  });
  const positions = [...boundaries].sort((left, right) => left - right);
  const nodes = [];
  let line = { text: prefix, bold: false, italic: false };

  const appendLine = () => {
    const style = { height: line.bold ? 1 : line.italic ? 1 : 0, width: line.bold ? 1 : 0 };
    nodes.push(...onebotTextNodes(line.text, style));
    line = { text: '', bold: false, italic: false };
  };

  for (let index = 0; index < positions.length - 1; index += 1) {
    const start = positions[index];
    const end = positions[index + 1];
    const chunk = source.slice(start, end);
    const active = validEntities.filter((entity) => entity.offset <= start && onebotEntityEnd(entity) >= end);
    const link = active.map((entity) => linkByEntity.get(entity)).find(Boolean);
    const parts = chunk.split(/\r?\n/);
    parts.forEach((part, partIndex) => {
      line.text += printableText(part);
      line.bold ||= active.some((entity) => entity.type === 'bold');
      line.italic ||= active.some((entity) => entity.type === 'italic');
      if (partIndex < parts.length - 1) appendLine();
    });
    if (link && onebotEntityEnd(link.entity) === end) line.text += link.marker;
  }
  appendLine();
  return { nodes, links };
}

function onebotLinkNodes(links) {
  return links.flatMap((link) => [
    { icon: { value: printableText(link.url), style: { justification: 1 }, type: 1 } },
    ...onebotTextNodes(link.marker),
  ]);
}

function onebotMessageNodes(sender, text, entities, hasUnsupportedCharacters = false) {
  if (onebotState.markdownEnabled !== false && Markdown.detectMarkdown(text) && Markdown.analyzeMarkdown(text).valid) {
    const nodes = Markdown.markdownToNodes(text, { sender });
    return onebotState.photoEnabled ? nodes : nodes.map(node => node.icon?.type === 3 ? onebotTextNodes('[图片打印已关闭]')[0] : node);
  }
  const formatted = onebotFormattedTextNodes(text, entities, sender ? `${sender}：` : '');
  const nodes = [...formatted.nodes, ...onebotLinkNodes(formatted.links)];
  if (hasUnsupportedCharacters) {
    nodes.push(...onebotTextNodes('-----------'));
    nodes.push(...onebotTextNodes('该消息含有不支持打印的字符'));
  }
  return nodes;
}

function onebotPrintingReply(item) {
  const warning = item.unsupportedCharacters?.length
    ? `消息中的${item.unsupportedCharacters.join(' ')} 无法打印，将忽略`
    : '';
  return [onebotState.replyPrinting, warning].filter(Boolean).join('\n');
}

function onebotPayload(items) {
  const values = Array.isArray(items) ? items : [items];
  const root = onebotPrintNodes(values.map((item) => ({
    ...item,
    nodes: item.nodes || onebotTextNodes(item.printText),
  })), onebotTextNodes('-----------'));
  return {
    device_sn: onebotState.deviceSn,
    ad_content: { user_define_template: { root } },
    account_type: onebotState.accountType,
    sid: onebotState.sid,
  };
}

function flushPrintQueue(generation) {
  if (onebotState.printFlushTimer) {
    clearTimeout(onebotState.printFlushTimer);
    onebotState.printFlushTimer = null;
  }
  if (!onebotState.printQueue.length || onebotState.generation !== generation || !onebotState.running) return;
  const batch = onebotState.printQueue.splice(0);
  const payload = Buffer.from(JSON.stringify(onebotPayload(batch)));
  log('INFO', 'OneBot 批量打印已转发', `${batch.length} 条消息，${payload.length} bytes -> ${TARGET_HOST}`);
  batch.forEach((item) => {
    updateOneBotMessage(item.historyId, 'printing');
    addOneBotLog('printing', item.printText, `批量任务 ${batch.length} 条消息`);
    onebotReply(item.chatId, onebotPrintingReply(item), generation);
  });
  forwardPrint(onebotState.sid, payload, (error, statusCode, headers, body) => {
    if (error) log('ERROR', 'OneBot 打印接口请求失败', error.message);
    else log(statusCode >= 200 && statusCode < 300 ? 'INFO' : 'WARN', 'OneBot 打印接口已返回', `HTTP ${statusCode}，${body.length} bytes`);
    const requestError = typeof error?.message === 'string' ? error.message.trim() : '';
    let result = { ok: false, error: requestError || '打印请求失败', replyError: requestError };
    if (!error) {
      const responseText = body.toString('utf8');
      try {
        const response = JSON.parse(responseText);
        const replyError = typeof response.msg === 'string' ? response.msg.trim() : '';
        result = isSidExpired(response)
          ? { ok: false, error: 'SID 已失效，请重新填写。', replyError: '' }
          : response.errcode ? { ok: false, error: replyError || `打印接口错误码 ${response.errcode}`, replyError } : { ok: true };
      } catch (parseError) {
        result = isSidExpired(responseText)
          ? { ok: false, error: 'SID 已失效，请重新填写。', replyError: '' }
          : { ok: false, error: parseError.message, replyError: '' };
      }
    }
    if (onebotState.generation !== generation) return;
    batch.forEach(async (item) => {
      if (result.ok) {
        updateOneBotMessage(item.historyId, 'printed');
        onebotState.lastMessage = item.printText;
        onebotState.error = '';
        addOneBotLog('printed', item.printText, `批量任务 ${batch.length} 条消息`);
        await onebotReply(item.chatId, onebotState.replyPrinted, generation);
      } else {
        updateOneBotMessage(item.historyId, 'failed', result.error);
        onebotState.error = result.error;
        addOneBotLog('failed', item.printText, result.error);
        await onebotReply(item.chatId, result.replyError || onebotState.replyPrintFailed, generation);
      }
    });
    saveOneBotAdminStore();
  });
}

function schedulePrintFlush(generation) {
  if (onebotState.printFlushTimer) clearTimeout(onebotState.printFlushTimer);
  onebotState.printFlushTimer = setTimeout(() => flushPrintQueue(generation), 500);
}

function enqueuePrintMessage(item, generation) {
  updateOneBotMessage(item.historyId, 'queued');
  saveOneBotAdminStore();
  onebotState.printQueue.push(item);
  schedulePrintFlush(generation);
}

function pausePrintFlushForFollowingImage(userId) {
  const previous = onebotState.printQueue[onebotState.printQueue.length - 1];
  if (!onebotState.printFlushTimer || previous?.userId !== userId || previous.kind !== 'text') return false;
  clearTimeout(onebotState.printFlushTimer);
  onebotState.printFlushTimer = null;
  return true;
}

function formatOneBotUser(user) {
  if (!user) return '未知用户';
  return `${user.name || '未知用户'}${user.username ? ` (@${user.username})` : ''} [${user.userId}]`;
}

function formatOneBotTime(value) {
  if (!value) return '-';
  try { return new Date(value).toLocaleString('zh-CN'); } catch { return '-'; }
}

function onebotAdminAuthorized(userId) {
  return onebotState.adminUserIds.has(String(userId));
}

function recordOneBotAudit(adminUserId, command, targetUserId, before, after, ok = true, error = '') {
  onebotState.auditLogs.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    time: new Date().toISOString(),
    adminUserId: String(adminUserId),
    command: truncateText(command, 200),
    targetUserId: parseOneBotUserId(targetUserId),
    before: truncateText(before, 500),
    after: truncateText(after, 500),
    ok,
    error: truncateText(error, 300),
  });
  if (onebotState.auditLogs.length > MAX_ONEBOT_AUDIT_LOGS) onebotState.auditLogs.splice(0, onebotState.auditLogs.length - MAX_ONEBOT_AUDIT_LOGS);
  saveOneBotAdminStore();
}

function onebotAdminHelp() {
  return [
    '管理员指令：',
    '/whoami 查看自己的 OneBot ID',
    '/users [recent|blocked] 查看用户',
    '/user <用户ID> 查看用户详情',
    '/messages <用户ID> 查看最近消息',
    '/limits 查看全局限流',
    '/limit <用户ID> rpm <次数> [时长]',
    '/limit <用户ID> chars <字数> [时长]',
    '/limit <用户ID> reset 恢复全局限制',
    '/blacklist 查看黑名单',
    '/block <用户ID> [时长] [原因] 永久封禁可用 perm',
    '/unblock <用户ID> 解除封禁',
    '/status 查看 Bot、队列和统计',
    '/logs [failed|limited|user <用户ID>] 查看日志',
  ].join('\n');
}

function adminCommandTarget(args) {
  return parseOneBotUserId(args[0]);
}

function userOverrideText(userId) {
  let override = onebotState.userOverrides.get(String(userId));
  if (override?.expiresAt !== null && override.expiresAt <= Date.now()) {
    onebotState.userOverrides.delete(String(userId));
    saveOneBotAdminStore();
    override = null;
  }
  if (!override) return '跟随全局限制';
  const expires = override.expiresAt === null ? '永久' : `至 ${formatOneBotTime(override.expiresAt)}`;
  return `rpm=${override.maxPerMinute === null ? '全局' : override.maxPerMinute}，chars=${override.maxCharsPerTask === null ? '全局' : override.maxCharsPerTask}，${expires}`;
}

async function handleOneBotAdminCommand(message, userProfile, generation) {
  const text = typeof message.text === 'string' ? message.text : '';
  const parsed = parseOneBotCommand(text);
  if (!parsed) return false;
  const userId = String(userProfile.userId);
  if (parsed.command === 'whoami') {
    await onebotReply(message.chat?.id, `你的 OneBot user_id 是 ${userId}。`, generation);
    return true;
  }
  if (!onebotAdminAuthorized(userId)) {
    recordOneBotAudit(userId, text, '', '', '', false, 'unauthorized');
    await onebotReply(message.chat?.id, '无权限执行管理员指令。', generation);
    return true;
  }
  let reply = '';
  let targetUserId = '';
  let before = '';
  let after = '';
  let ok = true;
  let error = '';
  try {
    const { command, args } = parsed;
    if (command === 'admin' || command === 'help') {
      reply = onebotAdminHelp();
    } else if (command === 'users') {
      const users = [...onebotState.users.values()]
        .filter((user) => args[0] !== 'blocked' || Boolean(activeBlacklistEntry(user.userId)))
        .sort((left, right) => (args[0] === 'recent' ? right.lastSeenAt - left.lastSeenAt : right.messageCount - left.messageCount));
      reply = users.length ? [`用户数：${users.length}`, ...users.slice(0, 50).map((user) => `${formatOneBotUser(user)}\n最近：${formatOneBotTime(user.lastSeenAt)}，消息 ${user.messageCount}，成功 ${user.printSuccessCount}，失败 ${user.printFailedCount}`)].join('\n') : '暂无用户记录。';
    } else if (command === 'user') {
      targetUserId = adminCommandTarget(args);
      if (!targetUserId) throw new Error('用法：/user <用户ID>');
      const user = onebotState.users.get(targetUserId);
      if (!user) { reply = '未找到该用户。'; }
      else {
        const blocked = activeBlacklistEntry(targetUserId);
        reply = [`用户：${formatOneBotUser(user)}`, `首次：${formatOneBotTime(user.firstSeenAt)}`, `最近：${formatOneBotTime(user.lastSeenAt)}`, `消息：${user.messageCount}，成功 ${user.printSuccessCount}，失败 ${user.printFailedCount}，限流 ${user.limitedCount}`, `限制：${userOverrideText(targetUserId)}`, blocked ? `黑名单：${blocked.blockedUntil === null ? '永久' : formatOneBotTime(blocked.blockedUntil)}，${blocked.reason}` : '黑名单：否', `最近内容：${user.lastMessagePreview || '-'}`].join('\n');
      }
    } else if (command === 'messages') {
      targetUserId = adminCommandTarget(args);
      if (!targetUserId) throw new Error('用法：/messages <用户ID>');
      const entries = onebotState.messages.filter((entry) => entry.userId === targetUserId).slice(-30).reverse();
      reply = entries.length ? entries.map((entry) => `${formatOneBotTime(entry.receivedAt)} [${entry.status}] ${entry.type}\n${entry.preview}${entry.detail ? `\n原因：${entry.detail}` : ''}`).join('\n\n') : '该用户暂无消息记录。';
    } else if (command === 'limits') {
      reply = `全局限制：每分钟 ${onebotState.maxPerMinute === 0 ? '不限' : onebotState.maxPerMinute} 个任务；单次 ${onebotState.maxCharsPerTask === 0 ? '不限' : `${onebotState.maxCharsPerTask} 字`}。\n单用户覆盖数：${onebotState.userOverrides.size}`;
    } else if (command === 'limit') {
      targetUserId = adminCommandTarget(args);
      if (!targetUserId || !['rpm', 'chars', 'reset'].includes(args[1])) throw new Error('用法：/limit <用户ID> rpm|chars <数值> [时长]，或 /limit <用户ID> reset');
      before = userOverrideText(targetUserId);
      if (args[1] === 'reset') {
        onebotState.userOverrides.delete(targetUserId);
      } else {
        const value = Number(args[2]);
        if (!Number.isInteger(value) || value < 0 || (args[1] === 'rpm' && value > 100) || (args[1] === 'chars' && value > 4294967295)) throw new Error('限制数值无效。');
        const durationToken = args[3];
        const duration = durationToken ? parseDuration(durationToken, { allowPermanent: true }) : null;
        if (durationToken && duration === 0) throw new Error('时长格式无效，请使用 30m、2h、7d 或 perm。');
        const old = onebotState.userOverrides.get(targetUserId) || { userId: targetUserId, maxPerMinute: null, maxCharsPerTask: null };
        onebotState.userOverrides.set(targetUserId, {
          ...old,
          userId: targetUserId,
          maxPerMinute: args[1] === 'rpm' ? value : (old.maxPerMinute ?? null),
          maxCharsPerTask: args[1] === 'chars' ? value : (old.maxCharsPerTask ?? null),
          expiresAt: duration === null ? null : Date.now() + duration * 60_000,
          updatedAt: Date.now(),
          updatedBy: userId,
        });
      }
      after = userOverrideText(targetUserId);
      saveOneBotAdminStore();
      reply = `用户 ${targetUserId} 的限制已更新：${after}`;
    } else if (command === 'blacklist') {
      const entries = blacklistEntries();
      reply = entries.length ? entries.map((entry) => `${entry.userId} ${entry.name}${entry.username ? ` (@${entry.username})` : ''}\n${entry.blockedUntil === null ? '永久' : formatOneBotTime(entry.blockedUntil)}：${entry.reason}`).join('\n\n') : '黑名单为空。';
    } else if (command === 'block') {
      targetUserId = adminCommandTarget(args);
      if (!targetUserId) throw new Error('用法：/block <用户ID> [时长] [原因]');
      const target = onebotState.users.get(targetUserId) || { userId: targetUserId, name: '未知用户', username: '' };
      const durationToken = args[1] && /^(?:\d+(?:\.\d+)?[mhdw]|perm|permanent|永久|0)$/i.test(args[1]) ? args[1] : '';
      const duration = durationToken ? parseDuration(durationToken, { allowPermanent: true }) : null;
      if (durationToken && duration === 0) throw new Error('时长格式无效。');
      const reason = truncateText(args.slice(durationToken ? 2 : 1).join(' ') || '管理员封禁', 300);
      before = activeBlacklistEntry(targetUserId) ? '已封禁' : '未封禁';
      setBlacklistEntry({ userId: targetUserId, name: target.name, username: target.username, blockedUntil: duration === null ? null : Date.now() + duration * 60_000, reason, strikes: 0, createdAt: Date.now(), createdBy: userId });
      after = duration === null ? '永久封禁' : `封禁 ${duration} 分钟`;
      reply = `用户 ${targetUserId} 已${after}。`;
    } else if (command === 'unblock') {
      targetUserId = adminCommandTarget(args);
      if (!targetUserId) throw new Error('用法：/unblock <用户ID>');
      before = activeBlacklistEntry(targetUserId) ? '已封禁' : '未封禁';
      removeBlacklistEntry(targetUserId);
      onebotState.rateLimitStrikes.delete(targetUserId);
      after = '未封禁';
      saveOneBotAdminStore();
      reply = `用户 ${targetUserId} 已解除封禁。`;
    } else if (command === 'status') {
      const printed = [...onebotState.messages].filter((entry) => entry.status === 'printed').length;
      const failed = [...onebotState.messages].filter((entry) => entry.status === 'failed').length;
      reply = [`监听：${onebotState.running ? '运行中' : '已停止'}`, `队列：${onebotState.printQueue.length}`, `用户：${onebotState.users.size}`, `消息：${onebotState.messages.length}`, `成功：${printed}，失败：${failed}`, `黑名单：${blacklistEntries().length}`, `最近打印：${onebotState.lastMessage || '-'}`, onebotState.error ? `错误：${onebotState.error}` : '错误：无'].join('\n');
    } else if (command === 'logs') {
      const mode = args[0] || '';
      let logs = onebotState.logs;
      if (mode === 'failed' || mode === 'limited') logs = logs.filter((entry) => entry.type === mode || (mode === 'failed' && entry.type === 'reply_failed'));
      if (mode === 'user' && parseOneBotUserId(args[1])) {
        const userMessages = onebotState.messages.filter((entry) => entry.userId === args[1]).slice(-40).reverse();
        reply = userMessages.length ? userMessages.map((entry) => `${formatOneBotTime(entry.receivedAt)} [${entry.status}] ${entry.preview}${entry.detail ? ` | ${entry.detail}` : ''}`).join('\n') : '暂无匹配日志。';
      } else {
        reply = logs.length ? logs.slice(-40).reverse().map((entry) => `${entry.time} [${entry.type}] ${entry.message}${entry.detail ? ` | ${entry.detail}` : ''}`).join('\n') : '暂无匹配日志。';
      }
    } else {
      throw new Error('未知指令，请发送 /help。');
    }
  } catch (commandError) {
    ok = false;
    error = commandError.message;
    reply = `操作失败：${error}`;
  }
  recordOneBotAudit(userId, text, targetUserId, before, after, ok, error);
  for (const page of paginateOneBotText(reply)) await onebotReply(message.chat?.id, page, generation);
  return true;
}

async function onebotLoop(generation) {
  while (onebotState.running && onebotState.generation === generation) {
    try {
      const updates = await onebotClient.nextUpdates();
      if (!onebotState.running || onebotState.generation !== generation) return;
      onebotState.error = '';
      onebotState.retryCount = 0;
      for (const update of updates || []) {
        const message = update.message;
        if (!message) continue;
        const sender = onebotSenderName(message.from);
        if (message.chat?.type !== 'private') {
          addOneBotLog('ignored', `${sender} 的 ${message.chat?.type || '非私聊'} 消息已忽略`, 'only_private_chat');
          continue;
        }
        const userId = String(message.from?.id || message.chat?.id || 'unknown');
        const userProfile = { userId, name: sender, username: String(message.from?.username || '') };
        upsertOneBotUser(userProfile, message);
        const historyEntry = recordOneBotMessage(message, update.update_id, userProfile);
        saveOneBotAdminStore();
        const text = typeof message.text === 'string' ? message.text : '';
        const unsupportedMessageCharacters = unsupportedCharacters(text);
        const printableMessageText = printableText(text).trim();
        const caption = typeof message.caption === 'string' ? message.caption : '';
        if (await handleOneBotAdminCommand(message, userProfile, generation)) {
          updateOneBotMessage(historyEntry.id, 'filtered', 'admin_command');
          saveOneBotAdminStore();
          continue;
        }
        if (text.trim().startsWith('/') || caption.trim().startsWith('/')) {
          updateOneBotMessage(historyEntry.id, 'filtered', 'onebot_command');
          saveOneBotAdminStore();
          addOneBotLog('ignored', `${sender} 的指令已忽略`, 'onebot_command');
          continue;
        }
        const existingBlacklist = blockedUser(userId);
        if (existingBlacklist) {
          updateOneBotMessage(historyEntry.id, 'blocked', existingBlacklist.reason);
          saveOneBotAdminStore();
          addOneBotLog('blocked', `${sender}${userProfile.username ? `（${userProfile.username}）` : ''} 的消息已拦截`, existingBlacklist.blockedUntil === null ? '永久拉黑' : `封禁至 ${new Date(existingBlacklist.blockedUntil).toLocaleString('zh-CN')}`);
          recordRateLimit(userProfile, '封控期间再次触发频率限制');
          await onebotReply(message.chat?.id, onebotState.replyRateLimited, generation);
          continue;
        }


        if (message.photo) {
          if (!onebotState.photoEnabled) {
            updateOneBotMessage(historyEntry.id, 'filtered', 'photo_printing_disabled');
            saveOneBotAdminStore();
            addOneBotLog('filtered', `${sender} 收到了图片，已跳过`, 'photo_printing_disabled');
            await onebotReply(message.chat?.id, onebotState.replyUnsupported, generation);
            continue;
          }
          const printableCaption = printableText(caption).trim();
          const captionCharacters = unsupportedCharacters(caption);
          const captionLength = onebotTaskCharCount(printableCaption);
          if (printableCaption && !textTaskAllowed(userId, captionLength)) {
            updateOneBotMessage(historyEntry.id, 'limited', `单次打印文字超过 ${effectiveOneBotRules(userId).maxCharsPerTask} 字限制`);
            saveOneBotAdminStore();
            addOneBotLog('limited', `${sender}：${printableCaption}`, `单次打印文字超过 ${onebotState.maxCharsPerTask} 字限制`);
            await onebotReply(message.chat?.id, onebotState.replyRateLimited, generation);
            continue;
          }
          const pausedPrintFlush = pausePrintFlushForFollowingImage(userId);
          let photoEnqueued = false;
          try {
            const photo = Array.isArray(message.photo) ? message.photo[message.photo.length - 1] : null;
            const photoResult = await processOneBotPhoto(photo);
            addOneBotLog('received', `${sender}：图片${printableCaption ? ` ${printableCaption}` : ''}`, photoResult.cached ? cacheHitDetail(onebotState.imageHost) : '已处理并上传图片');
            const alreadyQueuedForUser = onebotState.printQueue.some((item) => item.userId === userId);
            if (!alreadyQueuedForUser && !userTaskAllowed(userId)) {
              updateOneBotMessage(historyEntry.id, 'limited', `超过每分钟 ${effectiveOneBotRules(userId).maxPerMinute} 条任务`);
              saveOneBotAdminStore();
              addOneBotLog('limited', `${sender}：图片`, `超过每分钟 ${onebotState.maxPerMinute} 条任务`);
              recordRateLimit(userProfile);
              await onebotReply(message.chat?.id, onebotState.replyRateLimited, generation);
              continue;
            }
            const imageNode = { icon: { value: photoResult.directUrl, style: { justification: 1 }, type: 3 } };
            const captionNodes = printableCaption
              ? await prepareOneBotMarkdownImages(onebotMessageNodes('', caption, message.caption_entities, captionCharacters.length > 0))
              : [];
            enqueuePrintMessage({
              userId,
              chatId: message.chat?.id,
              historyId: historyEntry.id,
              kind: 'image',
              printText: `${sender}：图片${printableCaption ? ` ${printableCaption}` : ''}`,
              textLength: captionLength,
              unsupportedCharacters: captionCharacters,
              nodes: [...onebotTextNodes(sender), imageNode, ...captionNodes],
              continuationNodes: [imageNode, ...captionNodes],
            }, generation);
            photoEnqueued = true;
          } catch (error) {
            updateOneBotMessage(historyEntry.id, 'failed', error.message || '图片处理失败');
            saveOneBotAdminStore();
            addOneBotLog('failed', `${sender} 的图片未打印`, error.message || '图片处理失败');
            await onebotReply(message.chat?.id, onebotState.replyPrintFailed, generation);
          } finally {
            if (pausedPrintFlush && !photoEnqueued) schedulePrintFlush(generation);
          }
          continue;
        }
        const unsupported = !printableMessageText || message.document || message.video || message.voice || message.animation || message.audio || message.contact || message.location || message.poll || message.video_note;
        if (unsupported) {
          updateOneBotMessage(historyEntry.id, 'filtered', 'unsupported_message');
          saveOneBotAdminStore();
          const description = `${sender} 收到了${message.photo ? ' 图片' : ' 非文字'}消息，已跳过`;
          addOneBotLog('filtered', description, 'unsupported_message');
          await onebotReply(message.chat?.id, onebotState.replyUnsupported, generation);
          continue;
        }
        addOneBotLog('received', `${sender}：${printableMessageText}`);
        const textLength = onebotTaskCharCount(printableMessageText);
        if (!textTaskAllowed(userId, textLength)) {
          updateOneBotMessage(historyEntry.id, 'limited', `单次打印文字超过 ${effectiveOneBotRules(userId).maxCharsPerTask} 字限制`);
          saveOneBotAdminStore();
          addOneBotLog('limited', `${sender}：${printableMessageText}`, `单次打印文字超过 ${onebotState.maxCharsPerTask} 字限制`);
          await onebotReply(message.chat?.id, onebotState.replyRateLimited, generation);
          continue;
        }
        const alreadyQueuedForUser = onebotState.printQueue.some((item) => item.userId === userId);
        if (!alreadyQueuedForUser && !userTaskAllowed(userId)) {
          updateOneBotMessage(historyEntry.id, 'limited', `超过每分钟 ${effectiveOneBotRules(userId).maxPerMinute} 条任务`);
          saveOneBotAdminStore();
          addOneBotLog('limited', `${sender}：${printableMessageText}`, `超过每分钟 ${onebotState.maxPerMinute} 条任务`);
          recordRateLimit(userProfile);
          await onebotReply(message.chat?.id, onebotState.replyRateLimited, generation);
          continue;
        }
        const printText = `${sender}：${printableMessageText}`;
        let messageNodes, continuationNodes;
        try {
          messageNodes = await prepareOneBotMarkdownImages(onebotMessageNodes(sender, text, message.entities, unsupportedMessageCharacters.length > 0));
          continuationNodes = await prepareOneBotMarkdownImages(onebotMessageNodes('', text, message.entities, unsupportedMessageCharacters.length > 0));
        } catch (error) {
          updateOneBotMessage(historyEntry.id, 'failed', error.message); saveOneBotAdminStore();
          addOneBotLog('failed', 'Markdown 图片处理失败', error.message);
          await onebotReply(message.chat?.id, onebotState.replyPrintFailed, generation); continue;
        }
        if (!onebotState.running || onebotState.generation !== generation) return;
        enqueuePrintMessage({
          userId,
          chatId: message.chat?.id,
          historyId: historyEntry.id,
          kind: 'text',
          printText,
          textLength,
          unsupportedCharacters: unsupportedMessageCharacters,
          nodes: messageNodes,
          continuationNodes,
        }, generation);
      }
    } catch (error) {
      if (!onebotState.running || onebotState.generation !== generation) return;
      onebotState.error = error.message;
      onebotState.retryCount += 1;
      if (onebotState.retryCount > 3) {
        onebotState.running = false;
        onebotState.generation += 1;
        closeOneBotClient();
        addOneBotLog('system', '监听已停止', `连续重试 3 次失败：${error.message}`);
        return;
      }
      addOneBotLog('system', `监听请求失败，${onebotState.retryCount}/3 次重试`, error.message);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

async function onebotReply(chatId, text, generation) {
  if (!chatId || !text || onebotState.generation !== generation || !onebotState.running) return;
  try {
    await onebotRequest(onebotState.apiBase, onebotState.token, 'send_private_msg', { user_id: Number(chatId), message: [{ type: 'text', data: { text } }] }, 15000);
    addOneBotLog('replied', `chat:${chatId}`, text);
  } catch (error) {
    onebotState.error = error.message;
    addOneBotLog('reply_failed', `chat:${chatId}`, error.message);
  }
}



async function startOneBot(req, res) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const accountType = normalizeAccountType(body.account_type, null);
      if (!body.sid || !body.device_sn || accountType === null || accountType === '') throw new Error('设备 SN、SID 和 account_type 都不能为空且 account_type 必须是数字');
      const apiBase = normalizeOneBotApiBase(body.api_base);
      const requestedLimit = Number(body.max_per_minute);
      const maxPerMinute = Number.isFinite(requestedLimit) ? Math.max(0, Math.min(100, Math.floor(requestedLimit))) : 2;
      const requestedChars = Number(body.max_chars_per_task);
      const maxCharsPerTask = Number.isFinite(requestedChars) ? Math.max(0, Math.min(4294967295, Math.floor(requestedChars))) : 0;
      const strikeWindow = Number(body.rate_limit_strike_window_minutes);
      const rateLimitStrikeWindowMinutes = Number.isFinite(strikeWindow) ? Math.max(1, Math.min(1440, Math.floor(strikeWindow))) : 1;
      const penaltyValues = Array.isArray(body.rate_limit_penalty_minutes) ? body.rate_limit_penalty_minutes : [2, 10, 1440];
      const rateLimitPenaltyMinutes = [0, 1, 2].map((index) => {
        const value = Number(penaltyValues[index]);
        return Number.isFinite(value) ? Math.max(0, Math.min(525600, Math.floor(value))) : [2, 10, 1440][index];
      });
      const rateLimitBlacklistOnThird = body.rate_limit_blacklist_on_third === true;
      const requestedAdminUserIds = normalizeAdminUserIds(body.admin_user_ids);
      onebotState.running = false;
      onebotState.generation += 1;
      closeOneBotClient();
      const login = await onebotRequest(apiBase, String(body.token || '').trim(), 'get_login_info', {}, 10000);
      if (!login?.user_id) throw new Error('OneBot 未返回登录 QQ，请确认 NapCat 已登录');
      onebotState.running = false;
      onebotState.generation += 1;
      if (onebotState.printFlushTimer) clearTimeout(onebotState.printFlushTimer);
      onebotState.printFlushTimer = null;
      onebotState.printQueue = [];
      onebotState.token = String(body.token || '').trim();
      onebotState.offset = 0;
      onebotState.sid = body.sid.trim();
      onebotState.deviceSn = body.device_sn.trim();
      onebotState.accountType = accountType;
      onebotState.apiBase = apiBase;
      onebotState.maxPerMinute = maxPerMinute;
      onebotState.maxCharsPerTask = maxCharsPerTask;
      onebotState.rateLimitStrikeWindowMinutes = rateLimitStrikeWindowMinutes;
      onebotState.rateLimitPenaltyMinutes = rateLimitPenaltyMinutes;
      onebotState.rateLimitBlacklistOnThird = rateLimitBlacklistOnThird;
      onebotState.photoEnabled = body.photo_enabled !== false;
      onebotState.markdownEnabled = body.markdown_enabled !== false;
      onebotState.replyPrinting = normalizeReply(body.reply_printing, '正在打印，请稍候。');
      onebotState.replyPrinted = normalizeReply(body.reply_printed, '已打印。');
      onebotState.replyPrintFailed = normalizeReply(body.reply_print_failed, '打印失败，请稍后重试。');
      onebotState.replyUnsupported = normalizeReply(body.reply_unsupported, '该消息类型不支持打印，请发送文字。');
      onebotState.replyRateLimited = normalizeReply(body.reply_rate_limited, '操作太频繁，请稍后再试。');
      applyImageHostSettings(body.image_host || {});
      const hasRequestedAdminIds = Object.prototype.hasOwnProperty.call(body, 'admin_user_ids');
      onebotState.adminUserIds = new Set(hasRequestedAdminIds
        ? [...ENV_ADMIN_USER_IDS, ...requestedAdminUserIds]
        : [...onebotAdminStore.adminUserIds, ...appConfig.onebot.adminUserIds, ...ENV_ADMIN_USER_IDS]);
      saveOneBotAdminStore();
      onebotState.userTasks = new Map();
      onebotState.rateLimitStrikes = new Map();
      onebotState.blacklist = new Map(Object.entries(onebotAdminStore.blacklist));
      onebotState.messageById = new Map(onebotState.messages.map((item) => [item.id, item]));
      onebotState.logs = [];
      runScheduledCacheCleanup(onebotState.imageHost).catch((error) => { imageHostCleanupState.lastError = error.message; });
      const taskLimitText = maxPerMinute === 0 ? '单个用户不限制打印任务数量' : `每位用户每分钟最多 ${maxPerMinute} 条任务`;
      const charLimitText = maxCharsPerTask === 0 ? '单次打印文字不限制字数' : `单次打印文字最多 ${maxCharsPerTask} 字`;
      const penaltyText = rateLimitBlacklistOnThird ? `封控窗口 ${rateLimitStrikeWindowMinutes} 分钟，惩罚 ${rateLimitPenaltyMinutes.join('/')} 分钟后第 3 次永久拉黑` : `封控窗口 ${rateLimitStrikeWindowMinutes} 分钟，惩罚 ${rateLimitPenaltyMinutes.join('/')} 分钟`;
      addOneBotLog('system', `监听已启动，${taskLimitText}，${charLimitText}，${penaltyText}`, '已连接 OneBot v11 正向 WebSocket；仅处理 QQ 私聊');
      onebotState.lastMessage = '';
      onebotState.error = '';
      onebotState.retryCount = 0;
      onebotState.running = true;
      onebotLoop(onebotState.generation);
      log('INFO', 'OneBot 监听请求已接受');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ running: true }));
    } catch (error) {
      closeOneBotClient();
      onebotState.running = false;
      log('ERROR', 'OneBot 监听启动失败', error.message);
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
}

function stopOneBot(res) {
  closeOneBotClient();
  onebotState.running = false;
  onebotState.generation += 1;
  onebotState.token = '';
  onebotState.error = '';
  onebotState.retryCount = 0;
  if (onebotState.printFlushTimer) clearTimeout(onebotState.printFlushTimer);
  onebotState.printFlushTimer = null;
  onebotState.printQueue = [];
  log('INFO', 'OneBot 监听已停止');
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ running: false }));
}

function onebotStatus(res) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    running: onebotState.running,
    lastMessage: onebotState.lastMessage,
    error: onebotState.error,
    retryCount: onebotState.retryCount,
    logs: onebotState.logs,
    userCount: onebotState.users.size,
    messageCount: onebotState.messages.length,
    queueCount: onebotState.printQueue.length,
    maxPerMinute: onebotState.maxPerMinute,
    maxCharsPerTask: onebotState.maxCharsPerTask,
    rateLimitStrikeWindowMinutes: onebotState.rateLimitStrikeWindowMinutes,
    rateLimitPenaltyMinutes: onebotState.rateLimitPenaltyMinutes,
    rateLimitBlacklistOnThird: onebotState.rateLimitBlacklistOnThird,
    blacklist: blacklistEntries(),
    photoEnabled: onebotState.photoEnabled,
    markdownEnabled: onebotState.markdownEnabled !== false,
    imageHost: {
      provider: onebotState.imageHost.provider,
      cacheExpireDays: onebotState.imageHost.cacheExpireDays,
      deleteExpiredCache: onebotState.imageHost.deleteExpiredCache,
      cleanup: imageHostCleanupStatus(),
    },
  }));
}

function onebotBlacklist(res) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ blacklist: blacklistEntries() }));
}

function removeOneBotBlacklist(req, res, requestUrl) {
  let userId;
  try { userId = decodeURIComponent(requestUrl.pathname.slice('/api/onebot/blacklist/'.length)); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'invalid userId' }));
    return;
  }
  if (!userId) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'userId is required' }));
    return;
  }
  removeBlacklistEntry(userId);
  onebotState.rateLimitStrikes.delete(String(userId));
  addOneBotLog('system', `已解除用户 ${userId} 的封控`, 'blacklist_removed');
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ removed: true, blacklist: blacklistEntries() }));
}

function clearOneBotLogs(res) {
  onebotState.logs = [];
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ cleared: true }));
}

function proxyImage(res, requestUrl) {
  let target;
  try { target = new URL(requestUrl.searchParams.get('url')); } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('A valid image URL is required');
    return;
  }
  if (!['http:', 'https:'].includes(target.protocol)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Only HTTP(S) image URLs are supported');
    return;
  }
  const transport = target.protocol === 'https:' ? https : http;
  transport.get(target, (imageRes) => {
    if (imageRes.statusCode && imageRes.statusCode >= 300 && imageRes.statusCode < 400 && imageRes.headers.location) {
      imageRes.resume();
      proxyImage(res, new URL(`/api/image?url=${encodeURIComponent(new URL(imageRes.headers.location, target).toString())}`, 'http://localhost'));
      return;
    }
    if (imageRes.statusCode !== 200) {
      imageRes.resume();
      res.writeHead(imageRes.statusCode || 502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Image request failed');
      return;
    }
    res.writeHead(200, {
      'Content-Type': imageRes.headers['content-type'] || 'image/png',
      'Cache-Control': 'no-store',
    });
    imageRes.pipe(res);
  }).on('error', () => {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Image request failed');
  });
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const startedAt = Date.now();
  res.on('finish', () => {
    const level = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO';
    log(level, `HTTP ${req.method} ${requestUrl.pathname} -> ${res.statusCode}`, `${Date.now() - startedAt} ms`);
  });
  if (req.method === 'GET' && requestUrl.pathname === '/api/app/info') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ version: '1.1.0', features: ['r2', 's3', 'custom-image-host', 'markdown', 'openai-compatible-check'] })); return;
  }
  if (req.method === 'POST' && requestUrl.pathname === '/api/print') {
    proxyPrint(req, res, requestUrl);
    return;
  }
  if (req.method === 'POST' && requestUrl.pathname === '/api/image-host/upload') return imageHostUpload(req, res);
  if (req.method === 'POST' && requestUrl.pathname === '/api/image-host/test') return imageHostTest(req, res);
  if (req.method === 'POST' && requestUrl.pathname === '/api/markdown/analyze') return markdownApi(req, res);
  if (req.method === 'POST' && requestUrl.pathname === '/api/markdown/image') return markdownImage(req, res);
  if (req.method === 'POST' && requestUrl.pathname === '/api/markdown/check-ai') return markdownApi(req, res, true);
  if (req.method === 'POST' && requestUrl.pathname === '/api/settings/ai') return setAiSettings(req, res);
  if (req.method === 'GET' && requestUrl.pathname === '/api/config') return getAppConfig(res);
  if (req.method === 'POST' && requestUrl.pathname === '/api/config') return updateAppConfig(req, res);
  if (req.method === 'DELETE' && requestUrl.pathname === '/api/config') return deleteAppConfig(res);
  if (req.method === 'POST' && requestUrl.pathname === '/api/settings/image-host') return setImageHostSettings(req, res);
  if (req.method === 'POST' && requestUrl.pathname === '/api/onebot/start') return startOneBot(req, res);
  if (req.method === 'POST' && requestUrl.pathname === '/api/onebot/stop') return stopOneBot(res);
  if (req.method === 'POST' && requestUrl.pathname === '/api/onebot/logs/clear') return clearOneBotLogs(res);
  if (req.method === 'GET' && requestUrl.pathname === '/api/onebot/status') return onebotStatus(res);
  if (req.method === 'GET' && requestUrl.pathname === '/api/onebot/blacklist') return onebotBlacklist(res);
  if (req.method === 'DELETE' && requestUrl.pathname.startsWith('/api/onebot/blacklist/')) return removeOneBotBlacklist(req, res, requestUrl);
  if (req.method === 'GET' && requestUrl.pathname === '/api/image') {
    proxyImage(res, requestUrl);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD, POST' });
    res.end('Method not allowed');
    return;
  }
  const requestedPath = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  if (['/config.json', '/.onebot-admin.json', '/.onebot-media-cache.json'].includes(requestedPath)
      || requestedPath.startsWith('/.git/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const filePath = path.resolve(ROOT, `.${requestedPath}`);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  sendFile(res, filePath);
});

scheduleImageHostCleanup();
runScheduledCacheCleanup(appConfig.imageHost).catch((error) => { imageHostCleanupState.lastError = error.message; });

server.listen(PORT, HOST, () => {
  log('INFO', `WeChat Printer local app is running at http://${HOST}:${PORT}`);
  log('INFO', 'POST /api/print is proxied to payapp.wechatpay.cn');
});

server.on('error', (error) => {
  log('ERROR', '本地服务错误', error.message);
  process.exitCode = 1;
});

function shutdown(signal) {
  closeOneBotClient();
  onebotState.running = false;
  onebotState.generation += 1;
  onebotState.token = '';
  server.close(() => {
    log('INFO', `${signal}: local app stopped`);
    process.exit(0);
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
