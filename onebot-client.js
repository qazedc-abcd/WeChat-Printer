const { createHash } = require('node:crypto');

const DEFAULT_ONEBOT_URL = 'ws://127.0.0.1:3001';
const MAX_EVENTS = 2000;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

function normalizeOneBotUrl(value = DEFAULT_ONEBOT_URL) {
  const url = new URL(String(value || DEFAULT_ONEBOT_URL).trim());
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('OneBot v11 地址必须使用 ws:// 或 wss://');
  if (url.username || url.password || url.search || url.hash) throw new Error('OneBot 地址不能包含账号、查询参数或锚点；访问令牌请单独填写');
  if (['/api', '/api/', '/event', '/event/'].includes(url.pathname)) throw new Error('请使用同时提供 API 与事件的 WebSocket 根路径 /');
  return url.toString();
}

function decodeCq(value, parameter = false) {
  let text = String(value ?? '').replace(/&#91;/g, '[').replace(/&#93;/g, ']');
  if (parameter) text = text.replace(/&#44;/g, ',');
  return text.replace(/&amp;/g, '&');
}

function parseOneBotSegments(message) {
  if (Array.isArray(message)) return message.filter((part) => part && typeof part.type === 'string');
  const source = String(message ?? '');
  const segments = [];
  const pattern = /\[CQ:([a-zA-Z0-9_-]+)((?:,[^\]]*)?)\]/g;
  let position = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > position) segments.push({ type: 'text', data: { text: decodeCq(source.slice(position, match.index)) } });
    const data = Object.create(null);
    for (const item of match[2].split(',').slice(1)) {
      const equals = item.indexOf('=');
      if (equals > 0) data[item.slice(0, equals)] = decodeCq(item.slice(equals + 1), true);
    }
    segments.push({ type: match[1], data });
    position = match.index + match[0].length;
  }
  if (position < source.length) segments.push({ type: 'text', data: { text: decodeCq(source.slice(position)) } });
  return segments;
}

function urlEntities(text) {
  return Array.from(String(text).matchAll(/https?:\/\/[^\s<>]+/g), (match) => ({ type: 'url', offset: match.index, length: match[0].length }));
}

// A small platform-neutral message shape is used by the existing print queue.
// Each segment keeps its original order; no text/media rearrangement is performed.
function normalizeOneBotEvent(event) {
  if (!event || event.post_type !== 'message' || !['private', 'group'].includes(event.message_type)) return [];
  if (!/^\d+$/.test(String(event.user_id ?? '')) || event.message_id == null) return [];
  if (String(event.user_id) === String(event.self_id)) return [];
  const sender = event.sender || {};
  const base = {
    from: { id: String(event.user_id), first_name: String(sender.card || sender.nickname || event.user_id), username: '' },
    chat: { id: String(event.user_id), type: event.message_type },
    date: event.time,
    source_message_id: String(event.message_id),
  };
  const parts = [];
  let text = '';
  const flush = () => {
    if (text) { parts.push({ ...base, text, entities: urlEntities(text) }); text = ''; }
  };
  for (const segment of parseOneBotSegments(event.message ?? event.raw_message)) {
    const data = segment.data || {};
    if (segment.type === 'text') text += String(data.text ?? '');
    else if (segment.type === 'at') text += data.qq === 'all' ? '@全体成员' : `@${String(data.qq || '')}`;
    else if (segment.type === 'face') text += `[表情:${String(data.id || '')}]`;
    else if (segment.type === 'share') text += [data.title, data.url].filter(Boolean).join(' ');
    else if (segment.type === 'reply') continue;
    else if (segment.type === 'image') {
      flush();
      const file = String(data.file || '');
      const url = String(data.url || (/^https?:\/\//i.test(file) ? file : ''));
      parts.push({ ...base, photo: [{ file_id: file, source_url: url, file_unique_id: createHash('sha256').update(file || url).digest('hex') }] });
    } else {
      flush();
      parts.push({ ...base, document: { type: segment.type } });
    }
  }
  flush();
  return parts.map((message, index) => ({
    update_id: `${event.self_id}:${event.message_type}:${event.message_id}:${index}`,
    message: { ...message, message_id: `${event.message_id}:${index}` },
  }));
}

class OneBotClient {
  constructor(url = DEFAULT_ONEBOT_URL, token = '', { WebSocketImpl = globalThis.WebSocket } = {}) {
    if (!WebSocketImpl) throw new Error('OneBot v11 正向 WebSocket 需要 Node.js 22 或更高版本');
    this.url = normalizeOneBotUrl(url);
    this.token = String(token || '').trim();
    this.WebSocketImpl = WebSocketImpl;
    this.socket = null;
    this.opening = null;
    this.pending = new Map();
    this.queue = [];
    this.waiters = [];
    this.seen = new Set();
    this.counter = 0;
    this.stopped = false;
  }

  async connect(timeoutMs = 10000) {
    if (this.stopped) throw new Error('OneBot 连接已停止');
    if (this.socket?.readyState === 1) return;
    if (this.opening) return this.opening;
    const target = new URL(this.url);
    if (this.token) target.searchParams.set('access_token', this.token);
    this.opening = new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(target.toString());
      this.socket = socket;
      let opened = false;
      const timer = setTimeout(() => fail('OneBot WebSocket 连接超时，请检查本地服务与访问令牌'), timeoutMs);
      const fail = (message) => {
        clearTimeout(timer);
        if (this.socket !== socket) return;
        this.socket = null;
        const error = new Error(message);
        if (!opened) reject(error);
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
        this.pending.clear();
        for (const entry of this.waiters.splice(0)) { clearTimeout(entry.timer); entry.reject(error); }
        try { socket.close(); } catch { }
      };
      socket.addEventListener('open', () => { clearTimeout(timer); opened = true; resolve(); });
      socket.addEventListener('error', () => fail('OneBot WebSocket 连接失败，请检查服务地址和访问令牌'));
      socket.addEventListener('close', () => fail('OneBot WebSocket 已断开'));
      socket.addEventListener('message', (event) => {
        if (this.socket !== socket || this.stopped || typeof event.data !== 'string') return;
        if (Buffer.byteLength(event.data, 'utf8') > MAX_MESSAGE_BYTES) { fail('OneBot 消息过大'); return; }
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (!data || typeof data !== 'object') return;
        if (data.echo != null && this.pending.has(String(data.echo))) {
          const entry = this.pending.get(String(data.echo)); this.pending.delete(String(data.echo)); clearTimeout(entry.timer);
          if (Number(data.retcode) !== 0 || data.status === 'failed') entry.reject(new Error(`OneBot ${entry.action} 调用失败（retcode ${String(data.retcode ?? '?')}）`));
          else entry.resolve(data.data);
          return;
        }
        if (data.post_type !== 'message') return;
        const updates = normalizeOneBotEvent(data);
        if (!updates.length) return;
        const key = `${data.self_id}:${data.message_type}:${data.message_id}`;
        if (this.seen.has(key)) return;
        this.seen.add(key);
        if (this.seen.size > MAX_EVENTS) this.seen.delete(this.seen.values().next().value);
        if (this.queue.length + updates.length > MAX_EVENTS) { fail('OneBot 待处理消息过多，已断开连接'); return; }
        this.queue.push(...updates);
        if (this.waiters.length) {
          const entry = this.waiters.shift(); clearTimeout(entry.timer); entry.resolve(this.queue.splice(0, 128));
        }
      });
    });
    try { await this.opening; } finally { this.opening = null; }
  }

  async call(action, params = {}, timeoutMs = 15000) {
    await this.connect();
    if (this.stopped) throw new Error('OneBot 连接已停止');
    return new Promise((resolve, reject) => {
      const echo = `printer-${++this.counter}`;
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new Error(`OneBot ${action} 请求超时`)); }, timeoutMs);
      this.pending.set(echo, { action, resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ action, params, echo })); }
      catch { clearTimeout(timer); this.pending.delete(echo); reject(new Error('OneBot WebSocket 发送失败')); }
    });
  }

  async nextUpdates() {
    await this.connect();
    if (this.stopped) throw new Error('OneBot 连接已停止');
    if (this.queue.length) return this.queue.splice(0, 128);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => { this.waiters = this.waiters.filter((item) => item !== entry); resolve([]); }, 45000);
      this.waiters.push(entry);
    });
  }

  close() {
    this.stopped = true;
    this.queue = [];
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('OneBot 连接已停止')); }
    this.pending.clear();
    for (const entry of this.waiters.splice(0)) { clearTimeout(entry.timer); entry.reject(new Error('OneBot 连接已停止')); }
    if (this.socket) { try { this.socket.close(); } catch { } }
  }
}

module.exports = { DEFAULT_ONEBOT_URL, OneBotClient, normalizeOneBotUrl, normalizeOneBotEvent, parseOneBotSegments };
