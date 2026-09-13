const MAX_PREVIEW_LENGTH = 500;
const MAX_MESSAGES = 1000;
const MAX_AUDIT_LOGS = 500;
const MAX_USERS = 10000;

function normalizeAdminUserIds(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values
    .map((item) => String(item ?? '').trim())
    .filter((item) => /^\d+$/.test(item)))];
}

function parseTelegramCommand(value) {
  const source = String(value || '').trim();
  if (!source.startsWith('/')) return null;
  const firstLine = source.split(/\r?\n/, 1)[0].trim();
  const match = firstLine.match(/^\/([a-z][a-z0-9_]*)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const rawArgs = String(match[3] || '').trim();
  return {
    command: match[1].toLowerCase(),
    botName: match[2] || '',
    rawArgs,
    args: rawArgs ? rawArgs.split(/\s+/) : [],
  };
}

function parseTelegramUserId(value) {
  const id = String(value ?? '').trim();
  return /^\d+$/.test(id) ? id : '';
}

function parseDuration(value, { allowPermanent = true, maxMinutes = 525600 } = {}) {
  const source = String(value ?? '').trim().toLowerCase();
  if (allowPermanent && ['perm', 'permanent', '永久', '0'].includes(source)) return null;
  const match = source.match(/^(\d+(?:\.\d+)?)(m|h|d|w)$/);
  if (!match) return 0;
  const units = { m: 1, h: 60, d: 1440, w: 10080 };
  const minutes = Math.ceil(Number(match[1]) * units[match[2]]);
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.min(maxMinutes, minutes);
}

function truncateText(value, maxLength = MAX_PREVIEW_LENGTH) {
  const text = String(value || '');
  const chars = Array.from(text);
  return chars.length > maxLength ? `${chars.slice(0, maxLength).join('')}…` : text;
}

function paginateTelegramText(value, maxLength = 3900) {
  const text = String(value || '');
  if (!text) return [''];
  const pages = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < Math.floor(maxLength * 0.5)) splitAt = maxLength;
    pages.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }
  pages.push(remaining);
  return pages;
}

function emptyAdminStore(adminUserIds = []) {
  return {
    version: 1,
    adminUserIds: normalizeAdminUserIds(adminUserIds),
    users: {},
    userOverrides: {},
    blacklist: {},
    messages: [],
    auditLogs: [],
  };
}

function normalizeAdminStore(raw = {}, adminUserIds = []) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const store = emptyAdminStore([...normalizeAdminUserIds(source.adminUserIds), ...normalizeAdminUserIds(adminUserIds)]);
  const users = source.users && typeof source.users === 'object' && !Array.isArray(source.users) ? source.users : {};
  Object.entries(users).slice(-MAX_USERS).forEach(([key, value]) => {
    const userId = parseTelegramUserId(value?.userId || key);
    if (!userId) return;
    store.users[userId] = {
      userId,
      name: truncateText(value?.name || '未知用户', 120),
      username: truncateText(value?.username || '', 120),
      firstSeenAt: Number(value?.firstSeenAt) || Date.now(),
      lastSeenAt: Number(value?.lastSeenAt) || Number(value?.firstSeenAt) || Date.now(),
      messageCount: Math.max(0, Number(value?.messageCount) || 0),
      printSuccessCount: Math.max(0, Number(value?.printSuccessCount) || 0),
      printFailedCount: Math.max(0, Number(value?.printFailedCount) || 0),
      limitedCount: Math.max(0, Number(value?.limitedCount) || 0),
      lastMessageType: truncateText(value?.lastMessageType || '', 40),
      lastMessagePreview: truncateText(value?.lastMessagePreview || '', MAX_PREVIEW_LENGTH),
    };
  });
  const overrides = source.userOverrides && typeof source.userOverrides === 'object' && !Array.isArray(source.userOverrides) ? source.userOverrides : {};
  Object.entries(overrides).forEach(([key, value]) => {
    const userId = parseTelegramUserId(value?.userId || key);
    if (!userId || !value || typeof value !== 'object') return;
    const maxPerMinute = value.maxPerMinute === null || value.maxPerMinute === undefined ? null : Math.max(0, Math.min(100, Math.floor(Number(value.maxPerMinute))));
    const maxCharsPerTask = value.maxCharsPerTask === null || value.maxCharsPerTask === undefined ? null : Math.max(0, Math.min(4294967295, Math.floor(Number(value.maxCharsPerTask))));
    if ((maxPerMinute !== null && !Number.isFinite(maxPerMinute)) || (maxCharsPerTask !== null && !Number.isFinite(maxCharsPerTask))) return;
    store.userOverrides[userId] = {
      userId,
      maxPerMinute,
      maxCharsPerTask,
      expiresAt: value.expiresAt === null || value.expiresAt === undefined ? null : Number(value.expiresAt) || null,
      updatedAt: Number(value.updatedAt) || Date.now(),
      updatedBy: parseTelegramUserId(value.updatedBy) || String(value.updatedBy || ''),
    };
  });
  const blacklist = source.blacklist && typeof source.blacklist === 'object' && !Array.isArray(source.blacklist)
    ? source.blacklist
    : Array.isArray(source.blacklist) ? Object.fromEntries(source.blacklist.map((item) => [String(item?.userId || ''), item])) : {};
  Object.entries(blacklist).forEach(([key, value]) => {
    const userId = parseTelegramUserId(value?.userId || key);
    if (!userId || !value || typeof value !== 'object') return;
    const blockedUntil = value.blockedUntil === null ? null : Number(value.blockedUntil) || null;
    store.blacklist[userId] = {
      userId,
      name: truncateText(value.name || '未知用户', 120),
      username: truncateText(value.username || '', 120),
      blockedUntil,
      reason: truncateText(value.reason || '管理员封禁', 300),
      strikes: Math.max(0, Number(value.strikes) || 0),
      createdAt: Number(value.createdAt) || Date.now(),
      createdBy: parseTelegramUserId(value.createdBy) || String(value.createdBy || ''),
    };
  });
  store.messages = Array.isArray(source.messages) ? source.messages.slice(-MAX_MESSAGES).map((value) => ({
    id: String(value?.id || ''),
    updateId: Number(value?.updateId) || 0,
    messageId: Number(value?.messageId) || 0,
    userId: parseTelegramUserId(value?.userId),
    chatId: String(value?.chatId || ''),
    receivedAt: Number(value?.receivedAt) || Date.now(),
    type: truncateText(value?.type || 'unknown', 40),
    preview: truncateText(value?.preview || '', MAX_PREVIEW_LENGTH),
    status: truncateText(value?.status || 'received', 40),
    detail: truncateText(value?.detail || '', 300),
    finishedAt: Number(value?.finishedAt) || 0,
  })).filter((value) => value.userId) : [];
  store.auditLogs = Array.isArray(source.auditLogs) ? source.auditLogs.slice(-MAX_AUDIT_LOGS).map((value) => ({
    id: String(value?.id || ''),
    time: String(value?.time || new Date().toISOString()),
    adminUserId: parseTelegramUserId(value?.adminUserId) || String(value?.adminUserId || ''),
    command: truncateText(value?.command || '', 200),
    targetUserId: parseTelegramUserId(value?.targetUserId) || '',
    before: truncateText(value?.before || '', 500),
    after: truncateText(value?.after || '', 500),
    ok: value?.ok !== false,
    error: truncateText(value?.error || '', 300),
  })) : [];
  return store;
}

module.exports = {
  MAX_PREVIEW_LENGTH,
  MAX_MESSAGES,
  MAX_AUDIT_LOGS,
  MAX_USERS,
  normalizeAdminUserIds,
  parseTelegramCommand,
  parseTelegramUserId,
  parseDuration,
  truncateText,
  paginateTelegramText,
  emptyAdminStore,
  normalizeAdminStore,
};
