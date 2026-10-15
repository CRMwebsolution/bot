'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'uploads');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_TEXT = 20000;
const MAX_DATA_JSON = 4000;
const FORWARD_TIMEOUT_MS = 60000;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'audio/webm': '.webm',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/wave': '.wav',
  'audio/x-wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/aac': '.aac',
  'audio/x-m4a': '.m4a'
};

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'hub.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS bots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT NOT NULL,
    webhook_url TEXT NOT NULL DEFAULT '',
    quick_commands TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    type TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    file_name TEXT,
    file_mime TEXT,
    file_url TEXT,
    buttons_json TEXT,
    action TEXT,
    action_data_json TEXT,
    source_message_id TEXT,
    chosen_action TEXT,
    client_id TEXT,
    status TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_bot_time
    ON messages (bot_id, created_at DESC);
`);
db.pragma('user_version = 1');

const listBots = db.prepare('SELECT * FROM bots ORDER BY created_at ASC, id ASC');
const getBot = db.prepare('SELECT * FROM bots WHERE id = ?');
const insertBot = db.prepare(`
  INSERT INTO bots (id, name, icon, webhook_url, quick_commands, created_at, updated_at)
  VALUES (@id, @name, @icon, @webhook_url, @quick_commands, @created_at, @updated_at)
`);
const updateBot = db.prepare(`
  UPDATE bots
  SET name = @name, icon = @icon, webhook_url = @webhook_url,
      quick_commands = @quick_commands, updated_at = @updated_at
  WHERE id = @id
`);
const deleteBotRow = db.prepare('DELETE FROM bots WHERE id = ?');
const listBotFiles = db.prepare('SELECT file_url FROM messages WHERE bot_id = ? AND file_url IS NOT NULL');
const deleteBotMessages = db.prepare('DELETE FROM messages WHERE bot_id = ?');
const insertMessage = db.prepare(`
  INSERT INTO messages (
    id, bot_id, direction, type, text, file_name, file_mime, file_url,
    buttons_json, action, action_data_json, source_message_id, chosen_action,
    client_id, status, error, created_at
  ) VALUES (
    @id, @bot_id, @direction, @type, @text, @file_name, @file_mime, @file_url,
    @buttons_json, @action, @action_data_json, @source_message_id, @chosen_action,
    @client_id, @status, @error, @created_at
  )
`);
const getMessage = db.prepare('SELECT * FROM messages WHERE id = ?');
const setStatus = db.prepare('UPDATE messages SET status = @status, error = @error WHERE id = @id');
const setChosen = db.prepare('UPDATE messages SET chosen_action = @chosen_action WHERE id = @id');
const lastMessageStmt = db.prepare(`
  SELECT * FROM messages WHERE bot_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
`);
const countUnreadStmt = db.prepare(`
  SELECT COUNT(*) AS n FROM messages
  WHERE bot_id = ? AND direction = 'in' AND created_at > ?
`);
const recentMessages = db.prepare(`
  SELECT * FROM messages WHERE bot_id = ?
  ORDER BY created_at DESC, rowid DESC LIMIT ?
`);
const olderMessages = db.prepare(`
  SELECT * FROM messages WHERE bot_id = ? AND created_at < ?
  ORDER BY created_at DESC, rowid DESC LIMIT ?
`);

const sseClients = new Set();

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function baseMime(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

function extForMime(mime) {
  return MIME_EXT[baseMime(mime)] || '';
}

function clampText(value) {
  return String(value || '').slice(0, MAX_TEXT);
}

function clampIcon(value) {
  const raw = String(value || '').replace(/[\u0000-\u001F]/g, '').trim();
  if (!raw) return '🤖';
  const glyphs = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(raw)]
    .map((part) => part.segment)
    .slice(0, 4);
  const icon = glyphs.join('');
  if (!icon || icon.length > 32) return '🤖';
  return icon;
}

function parseCommands(input) {
  const source = Array.isArray(input) ? input.join(',') : String(input || '');
  const out = [];
  for (const piece of source.split(',')) {
    let part = piece.trim();
    if (!part) continue;
    if (!part.startsWith('/')) part = `/${part}`;
    if (!/^\/[a-zA-Z0-9_-]{1,31}$/.test(part)) continue;
    if (!out.includes(part)) out.push(part);
    if (out.length === 20) break;
  }
  return out;
}

function parseSeenHeader(req) {
  const raw = req.get('x-hub-seen');
  const seen = { '*': 0 };
  if (!raw) return seen;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return seen;
    for (const [key, value] of Object.entries(obj)) {
      if (key !== '*' && !SLUG_RE.test(key)) continue;
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) seen[key] = Math.floor(n);
    }
  } catch {
    return { '*': 0 };
  }
  return seen;
}

function previewText(row) {
  if (!row) return '';
  if (row.type === 'image') return String(row.text || '').trim() || 'Photo';
  if (row.type === 'voice') return 'Voice message';
  if (row.type === 'action') return String(row.text || '').trim() || row.action || 'Action';
  return String(row.text || '').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Message';
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toPublicMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    botId: row.bot_id,
    direction: row.direction,
    type: row.type,
    text: row.text || '',
    fileUrl: row.file_url || null,
    fileMime: row.file_mime || null,
    fileName: row.file_name || null,
    buttons: parseJson(row.buttons_json, []),
    action: row.action || null,
    actionData: parseJson(row.action_data_json, null),
    sourceMessageId: row.source_message_id || null,
    chosenAction: row.chosen_action || null,
    clientId: row.client_id || null,
    status: row.status,
    error: row.error || null,
    createdAt: row.created_at
  };
}

function toPublicBot(row, seen) {
  const last = lastMessageStmt.get(row.id);
  const bot = {
    id: row.id,
    name: row.name,
    icon: row.icon,
    webhookUrl: row.webhook_url,
    quickCommands: parseCommands(row.quick_commands),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessage: last
      ? { id: last.id, preview: previewText(last), at: last.created_at, direction: last.direction, type: last.type }
      : null
  };
  if (seen) {
    const threshold = Object.prototype.hasOwnProperty.call(seen, row.id) ? seen[row.id] : (seen['*'] || 0);
    bot.unread = Number(countUnreadStmt.get(row.id, threshold).n) || 0;
  }
  return bot;
}

function publish(payload) {
  const frame = `event: hub\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

function botIdFromParam(raw) {
  const id = String(raw || '').toLowerCase();
  if (!SLUG_RE.test(id) || id.length > 40) return null;
  return id;
}

function requireBot(raw) {
  const id = botIdFromParam(raw);
  if (!id) throw httpError(400, 'Invalid bot id');
  const bot = getBot.get(id);
  if (!bot) throw httpError(404, 'Bot not found');
  return bot;
}

function normalizeBotPayload(body, creating) {
  const source = body && typeof body === 'object' ? body : {};
  const name = String(source.name || '').trim();
  if (!name) throw httpError(400, 'Name is required');
  if (name.length > 60) throw httpError(400, 'Name is too long');
  let id = null;
  if (creating) {
    id = String(source.id || '').trim().toLowerCase();
    if (!SLUG_RE.test(id) || id.length > 40) {
      throw httpError(400, 'Id must be a slug such as media-bot');
    }
  }
  let webhookUrl = String(source.webhookUrl || source.n8nOutgoingWebhookUrl || '').trim();
  if (webhookUrl.length > 2000) throw httpError(400, 'Webhook URL is too long');
  if (webhookUrl) {
    let parsed;
    try {
      parsed = new URL(webhookUrl);
    } catch {
      throw httpError(400, 'Webhook URL must be a valid http(s) URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw httpError(400, 'Webhook URL must start with http:// or https://');
    }
    webhookUrl = parsed.href;
  }
  return {
    id,
    name,
    icon: clampIcon(source.icon),
    webhook_url: webhookUrl,
    quick_commands: parseCommands(source.quickCommands).join(', ')
  };
}

function resolveUpload(name) {
  const abs = path.resolve(UPLOAD_DIR, name);
  const rel = path.relative(UPLOAD_DIR, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

function unlinkPublic(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  const abs = resolveUpload(path.basename(url));
  if (!abs) return;
  fs.promises.unlink(abs).catch(() => {});
}

function cleanupUpload(file) {
  if (!file) return;
  const target = file.path || (file.filename ? path.join(UPLOAD_DIR, file.filename) : '');
  if (target) fs.promises.unlink(target).catch(() => {});
}

function cleanupRequestFiles(req) {
  const files = [];
  if (req.file) files.push(req.file);
  if (req.files) {
    for (const list of Object.values(req.files)) {
      if (Array.isArray(list)) files.push(...list);
    }
  }
  for (const file of files) cleanupUpload(file);
}

function safeUploadName(file) {
  const ext = extForMime(file.mimetype);
  const cleaned = path.basename(String(file.originalname || 'upload')).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80);
  if (cleaned && path.extname(cleaned).toLowerCase() === ext) return cleaned;
  return `upload${ext}`;
}

function fileFromUpload(file) {
  if (!file) return null;
  const mime = baseMime(file.mimetype);
  if (!extForMime(mime)) return null;
  return {
    fileName: safeUploadName(file),
    fileMime: mime,
    fileUrl: `/uploads/${file.filename}`
  };
}

function pickUploaded(req) {
  if (req.file) return req.file;
  const files = req.files || {};
  return (files.file && files.file[0]) || (files.image && files.image[0]) || (files.audio && files.audio[0]) || null;
}

function plainData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = item;
  }
  return out;
}

function normalizeButtons(input) {
  let arr = input;
  if (typeof input === 'string') {
    if (!input.trim()) return [];
    try {
      arr = JSON.parse(input);
    } catch {
      throw httpError(400, 'buttons must be a JSON array');
    }
  }
  if (arr == null) return [];
  if (!Array.isArray(arr)) throw httpError(400, 'buttons must be an array');
  const buttons = [];
  for (const item of arr.slice(0, 8)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw httpError(400, 'Each button must be an object');
    }
    const label = String(item.label || '').trim().slice(0, 40);
    const action = String(item.action || '').trim().slice(0, 80);
    if (!label || !action) throw httpError(400, 'Each button needs a label and an action');
    if (!/^[a-zA-Z0-9_.:-]+$/.test(action)) {
      throw httpError(400, 'Button action may only contain letters, numbers, and . _ : -');
    }
    if (item.data != null && (typeof item.data !== 'object' || Array.isArray(item.data))) {
      throw httpError(400, 'Button data must be an object');
    }
    const data = plainData(item.data) || {};
    const json = JSON.stringify(data);
    if (json.length > MAX_DATA_JSON) throw httpError(400, 'Button data is too large');
    buttons.push({ label, action, data: JSON.parse(json) });
  }
  return buttons;
}

function parseActionData(raw) {
  if (raw == null || raw === '') return null;
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw httpError(400, 'data must be a JSON object');
    }
  }
  const data = plainData(value);
  if (!data) throw httpError(400, 'data must be a JSON object');
  const json = JSON.stringify(data);
  if (json.length > MAX_DATA_JSON) throw httpError(400, 'data is too large');
  return json;
}

async function materializeImage(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') return null;
  const value = imageUrl.trim();
  if (!value) return null;
  if (value.length > 12_000_000) throw httpError(413, 'Image is too large');

  if (value.startsWith('/uploads/')) {
    const name = path.basename(value);
    if (`/uploads/${name}` !== value) throw httpError(400, 'Invalid image path');
    const abs = resolveUpload(name);
    if (!abs || !fs.existsSync(abs)) throw httpError(400, 'Image file not found');
    return { fileName: name, fileMime: extToMime(name), fileUrl: `/uploads/${name}` };
  }

  const dataUrl = value.match(/^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,([a-z0-9+/=\r\n]+)$/i);
  if (dataUrl) {
    const mime = dataUrl[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : dataUrl[1].toLowerCase();
    const buf = Buffer.from(dataUrl[2], 'base64');
    if (!buf.length) throw httpError(400, 'Image data is empty');
    if (buf.length > 8 * 1024 * 1024) throw httpError(413, 'Image is too large');
    const fileName = `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}${extForMime(mime)}`;
    await fs.promises.writeFile(path.join(UPLOAD_DIR, fileName), buf);
    return { fileName, fileMime: mime, fileUrl: `/uploads/${fileName}` };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw httpError(400, 'imageUrl must be an http(s) URL, a data URL, or an uploaded file');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw httpError(400, 'imageUrl must be an http(s) URL');
  }
  if (url.href.length > 2000) throw httpError(400, 'imageUrl is too long');
  return { fileName: null, fileMime: null, fileUrl: url.href };
}

function extToMime(name) {
  const ext = path.extname(name).toLowerCase();
  for (const [mime, extension] of Object.entries(MIME_EXT)) {
    if (extension === ext) return mime;
  }
  return null;
}

function inferIncomingType(payload, file) {
  if (file && String(file.fileMime || '').startsWith('audio/')) return 'voice';
  if (file && String(file.fileMime || '').startsWith('image/')) return 'image';
  if (payload.imageUrl) return 'image';
  return 'text';
}

function messageRecord(fields) {
  return {
    id: fields.id,
    bot_id: fields.bot_id,
    direction: fields.direction,
    type: fields.type,
    text: fields.text || '',
    file_name: fields.file_name || null,
    file_mime: fields.file_mime || null,
    file_url: fields.file_url || null,
    buttons_json: fields.buttons_json || null,
    action: fields.action || null,
    action_data_json: fields.action_data_json || null,
    source_message_id: fields.source_message_id || null,
    chosen_action: fields.chosen_action || null,
    client_id: fields.client_id || null,
    status: fields.status,
    error: fields.error || null,
    created_at: fields.created_at
  };
}

async function ingestIncoming(bot, payload) {
  const uploaded = payload.file || null;
  const image = uploaded ? null : await materializeImage(payload.imageUrl);
  const file = uploaded || image;
  const buttons = payload.buttons || [];
  const text = clampText(payload.text || '');
  if (!text.trim() && !file && !buttons.length) {
    throw httpError(400, 'Webhook body needs text, an image, audio, or buttons');
  }
  const row = messageRecord({
    id: newId('m'),
    bot_id: bot.id,
    direction: 'in',
    type: inferIncomingType({ ...payload, imageUrl: payload.imageUrl && !uploaded ? payload.imageUrl : '' }, file),
    text,
    file_name: file ? file.fileName : null,
    file_mime: file ? file.fileMime : null,
    file_url: file ? file.fileUrl : null,
    buttons_json: buttons.length ? JSON.stringify(buttons) : null,
    status: 'ok',
    created_at: Date.now()
  });
  insertMessage.run(row);
  const message = toPublicMessage(getMessage.get(row.id));
  publish({ type: 'message', message });
  return message;
}

function extractReply(body) {
  if (body == null) return null;
  if (Array.isArray(body)) return body.length ? extractReply(body[0]) : null;
  if (typeof body === 'string') return { text: body.slice(0, MAX_TEXT), imageUrl: '', buttons: [] };
  if (typeof body !== 'object') return null;

  const buttons = normalizeButtons(body.buttons);
  const imageUrl = typeof body.imageUrl === 'string'
    ? body.imageUrl
    : (typeof body.image === 'string' ? body.image : '');
  let text = '';
  if (typeof body.text === 'string') text = body.text;
  else if (typeof body.output === 'string') text = body.output;
  else if (typeof body.message === 'string') text = body.message;
  text = text.slice(0, MAX_TEXT);

  if (!text.trim() && !imageUrl && !buttons.length && body.json && typeof body.json === 'object') {
    return extractReply(body.json);
  }
  if (!text.trim() && !imageUrl && !buttons.length) return null;
  if (!imageUrl && !buttons.length && /^workflow (was started|executed successfully)\.?$/i.test(text.trim())) {
    return null;
  }
  return { text, imageUrl, buttons };
}

async function readReply(resp) {
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  if (ct.startsWith('image/') || ct.startsWith('audio/') || ct.includes('octet-stream')) return null;
  const raw = await resp.text();
  if (!raw.trim()) return null;
  const looksJson = ct.includes('json') || /^[\[{]/.test(raw.trim());
  if (looksJson) {
    try {
      return extractReply(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  if (ct.startsWith('text/') || !ct) return { text: raw.slice(0, MAX_TEXT), imageUrl: '', buttons: [] };
  return null;
}

async function forwardToN8n(bot, row) {
  if (!bot.webhook_url) return { skipped: true, ok: true, reply: null };
  const form = new FormData();
  form.append('botId', bot.id);
  form.append('messageId', row.id);
  form.append('timestamp', new Date(row.created_at).toISOString());
  form.append('type', row.type);
  form.append('text', row.text || '');
  if (row.action) form.append('action', row.action);
  if (row.action_data_json) form.append('data', row.action_data_json);
  if (row.source_message_id) form.append('sourceMessageId', row.source_message_id);

  if (row.file_url && row.file_url.startsWith('/uploads/')) {
    const abs = resolveUpload(path.basename(row.file_url));
    if (!abs || !fs.existsSync(abs)) {
      return { ok: false, error: 'The attachment is no longer on disk', reply: null };
    }
    const buf = await fs.promises.readFile(abs);
    const bytes = Uint8Array.from(buf);
    const blob = new Blob([bytes], { type: row.file_mime || 'application/octet-stream' });
    form.append('file', blob, row.file_name || path.basename(abs));
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FORWARD_TIMEOUT_MS);
  try {
    const resp = await fetch(bot.webhook_url, { method: 'POST', body: form, signal: ctrl.signal });
    const reply = await readReply(resp);
    if (!resp.ok) return { ok: false, error: `n8n responded with ${resp.status}`, reply: null };
    return { ok: true, reply };
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    console.error(`[hub] forward failed bot=${bot.id} message=${row.id} ${timedOut ? 'timeout' : err.name || 'error'}`);
    return {
      ok: false,
      error: timedOut ? 'The n8n webhook timed out after 60 seconds' : 'Could not reach the n8n webhook',
      reply: null
    };
  } finally {
    clearTimeout(timer);
  }
}

async function deliver(bot, messageId) {
  const existing = getMessage.get(messageId);
  if (!bot.webhook_url) {
    if (existing.status !== 'local') {
      setStatus.run({ id: messageId, status: 'local', error: null });
      publish({ type: 'message_updated', message: toPublicMessage(getMessage.get(messageId)) });
    }
    return {
      message: toPublicMessage(getMessage.get(messageId)),
      reply: null,
      delivery: { ok: true, skipped: true, error: null }
    };
  }

  const result = await forwardToN8n(bot, existing);
  if (!result.ok) {
    setStatus.run({ id: messageId, status: 'error', error: result.error || 'Delivery failed' });
  } else {
    setStatus.run({ id: messageId, status: 'ok', error: null });
  }
  publish({ type: 'message_updated', message: toPublicMessage(getMessage.get(messageId)) });

  let reply = null;
  if (result.ok && result.reply) {
    try {
      reply = await ingestIncoming(bot, result.reply);
    } catch (err) {
      console.error(`[hub] reply ingest failed bot=${bot.id} ${err.message}`);
      try {
        reply = await ingestIncoming(bot, {
          text: `n8n replied, but the attachment could not be stored. ${err.message || ''}`.trim(),
          buttons: result.reply.buttons || []
        });
      } catch (inner) {
        console.error(`[hub] reply fallback failed bot=${bot.id} ${inner.message}`);
      }
    }
  }

  return {
    message: toPublicMessage(getMessage.get(messageId)),
    reply,
    delivery: { ok: !!result.ok, skipped: false, error: result.ok ? null : (result.error || 'Delivery failed') }
  };
}

function publishBot(row) {
  publish({ type: 'bot_upsert', bot: toPublicBot(row) });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = extForMime(file.mimetype) || '';
    cb(null, `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (extForMime(file.mimetype)) cb(null, true);
    else cb(httpError(415, 'Only image and audio uploads are accepted'));
  }
});

function acceptUpload(req, res, next) {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('multipart/form-data')) return next();
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'image', maxCount: 1 },
    { name: 'audio', maxCount: 1 }
  ])(req, res, (err) => {
    if (err) {
      cleanupRequestFiles(req);
      return next(err);
    }
    next();
  });
}

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: http: https:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'"
  );
  next();
});
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'n8n-bot-hub', now: Date.now() });
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');
  res.write('event: hub\ndata: {"type":"hello"}\n\n');
  sseClients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
      sseClients.delete(res);
    }
  }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

app.get('/api/bots', (req, res) => {
  const seen = parseSeenHeader(req);
  res.json({ bots: listBots.all().map((row) => toPublicBot(row, seen)) });
});

app.post('/api/bots', (req, res) => {
  const input = normalizeBotPayload(req.body, true);
  if (getBot.get(input.id)) throw httpError(409, 'A bot with this id already exists');
  const now = Date.now();
  insertBot.run({ ...input, created_at: now, updated_at: now });
  const row = getBot.get(input.id);
  publishBot(row);
  res.status(201).json({ bot: toPublicBot(row, { '*': now }) });
});

app.put('/api/bots/:botId', (req, res) => {
  const bot = requireBot(req.params.botId);
  const input = normalizeBotPayload(req.body, false);
  updateBot.run({
    id: bot.id,
    name: input.name,
    icon: input.icon,
    webhook_url: input.webhook_url,
    quick_commands: input.quick_commands,
    updated_at: Date.now()
  });
  const row = getBot.get(bot.id);
  publishBot(row);
  res.json({ bot: toPublicBot(row) });
});

app.delete('/api/bots/:botId', (req, res) => {
  const bot = requireBot(req.params.botId);
  const files = listBotFiles.all(bot.id).map((row) => row.file_url);
  const remove = db.transaction((id) => {
    deleteBotMessages.run(id);
    deleteBotRow.run(id);
  });
  remove(bot.id);
  for (const url of files) unlinkPublic(url);
  publish({ type: 'bot_delete', botId: bot.id });
  res.json({ ok: true });
});

app.get('/api/bots/:botId/messages', (req, res) => {
  const bot = requireBot(req.params.botId);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const before = req.query.before == null || req.query.before === '' ? null : Number(req.query.before);
  if (before != null && !Number.isFinite(before)) throw httpError(400, 'Invalid before cursor');
  const rows = before == null
    ? recentMessages.all(bot.id, limit + 1)
    : olderMessages.all(bot.id, before, limit + 1);
  const hasMore = rows.length > limit;
  const messages = rows.slice(0, limit).reverse().map(toPublicMessage);
  res.json({ messages, hasMore });
});

app.post('/api/bots/:botId/send', acceptUpload, asyncRoute(async (req, res) => {
  let saved = false;
  try {
    const bot = requireBot(req.params.botId);
    const type = String((req.body && req.body.type) || 'text');
    if (!['text', 'image', 'voice', 'action'].includes(type)) {
      throw httpError(400, 'Unsupported message type');
    }
    const text = clampText(req.body.text || '');
    const action = type === 'action' ? String(req.body.action || '').trim().slice(0, 80) : '';
    if (type === 'action' && !action) throw httpError(400, 'Action is required');
    if (type === 'action' && !/^[a-zA-Z0-9_.:-]+$/.test(action)) {
      throw httpError(400, 'Action may only contain letters, numbers, and . _ : -');
    }
    const actionData = type === 'action' ? parseActionData(req.body.data) : null;
    if (type === 'text' || type === 'action') cleanupRequestFiles(req);
    const file = (type === 'text' || type === 'action') ? null : fileFromUpload(pickUploaded(req));
    if ((type === 'image' || type === 'voice') && !file) throw httpError(400, 'A file is required for this message');
    if (type === 'text' && !text.trim()) throw httpError(400, 'Message is empty');
    if (type === 'image' && !file.fileMime.startsWith('image/')) throw httpError(400, 'Attachment must be an image');
    if (type === 'voice' && !file.fileMime.startsWith('audio/')) throw httpError(400, 'Recording must be an audio file');

    const sourceMessageId = req.body.sourceMessageId ? String(req.body.sourceMessageId).slice(0, 80) : null;
    const clientId = req.body.clientId ? String(req.body.clientId).slice(0, 80) : null;
    const id = newId('m');
    insertMessage.run(messageRecord({
      id,
      bot_id: bot.id,
      direction: 'out',
      type,
      text,
      file_name: file ? file.fileName : null,
      file_mime: file ? file.fileMime : null,
      file_url: file ? file.fileUrl : null,
      action: action || null,
      action_data_json: actionData,
      source_message_id: sourceMessageId,
      client_id: clientId,
      status: bot.webhook_url ? 'pending' : 'local',
      created_at: Date.now()
    }));
    saved = true;

    if (sourceMessageId && action) {
      const source = getMessage.get(sourceMessageId);
      if (source && source.bot_id === bot.id && source.direction === 'in') {
        setChosen.run({ id: source.id, chosen_action: action });
        publish({ type: 'message_updated', message: toPublicMessage(getMessage.get(source.id)) });
      }
    }

    publish({ type: 'message', message: toPublicMessage(getMessage.get(id)) });
    const result = await deliver(bot, id);
    res.json(result);
  } catch (err) {
    if (!saved) cleanupRequestFiles(req);
    throw err;
  }
}));

app.post('/api/messages/:id/retry', asyncRoute(async (req, res) => {
  const row = getMessage.get(req.params.id);
  if (!row || row.direction !== 'out') throw httpError(404, 'Message not found');
  const bot = getBot.get(row.bot_id);
  if (!bot) throw httpError(404, 'Bot not found');
  if (!bot.webhook_url) throw httpError(400, 'This bot has no outgoing webhook URL');
  setStatus.run({ id: row.id, status: 'pending', error: null });
  publish({ type: 'message_updated', message: toPublicMessage(getMessage.get(row.id)) });
  res.json(await deliver(bot, row.id));
}));

app.post('/api/webhook/:botId', acceptUpload, asyncRoute(async (req, res) => {
  let saved = false;
  try {
    const bot = requireBot(req.params.botId);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const uploaded = fileFromUpload(pickUploaded(req));
    const buttons = normalizeButtons(body.buttons);
    const text = typeof body.text === 'string' ? body.text : '';
    const imageUrl = uploaded
      ? ''
      : (typeof body.imageUrl === 'string' ? body.imageUrl : (typeof body.image === 'string' ? body.image : ''));
    const message = await ingestIncoming(bot, { text, imageUrl, buttons, file: uploaded });
    saved = true;
    res.json({ ok: true, message });
  } catch (err) {
    if (!saved) cleanupRequestFiles(req);
    throw err;
  }
}));

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use('/uploads', express.static(UPLOAD_DIR, {
  immutable: true,
  maxAge: '365d',
  fallthrough: false,
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
  }
}));

app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error('[hub]', err);
  const message = status >= 500
    ? 'Internal server error'
    : (err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 20 MB' : (err.message || 'Request failed'));
  res.status(status).json({ error: message });
});

const server = app.listen(PORT, HOST, () => {
  const addr = server.address();
  console.log(`n8n Bot Hub listening on http://${addr.address}:${addr.port}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use.`);
  else console.error(err);
  process.exit(1);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
