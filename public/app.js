'use strict';

const TZ = 'America/New_York';
const SEEN_KEY = 'hub.seen.v1';
const ACTIVE_KEY = 'hub.activeBotId';
const COLLAPSE_KEY = 'hub.sidebarCollapsed';
const EMOJI = ['🤖', '📰', '🖼️', '🎙️', '🗓️', '✅', '📦', '💬'];

const els = {
  app: document.getElementById('app'),
  list: document.getElementById('bot-list'),
  emptyBots: document.getElementById('bot-empty'),
  filter: document.getElementById('bot-filter'),
  messages: document.getElementById('messages'),
  composerWrap: document.getElementById('composer-wrap'),
  composer: document.getElementById('composer'),
  input: document.getElementById('composer-input'),
  file: document.getElementById('file-input'),
  preview: document.getElementById('attach-preview'),
  cmds: document.getElementById('cmd-pop'),
  recordBar: document.getElementById('record-bar'),
  recordTime: document.getElementById('record-time'),
  wave: document.getElementById('wave'),
  mic: document.getElementById('mic'),
  name: document.getElementById('chat-name'),
  sub: document.getElementById('chat-sub'),
  icon: document.getElementById('chat-icon'),
  actions: document.getElementById('chat-actions'),
  live: document.getElementById('live-status'),
  toasts: document.getElementById('toasts'),
  modal: document.getElementById('modal-root'),
  lightbox: document.getElementById('lightbox'),
  lightboxImg: document.getElementById('lightbox-img'),
  jump: document.getElementById('jump'),
  install: document.getElementById('install-btn'),
  ios: document.getElementById('ios-hint'),
  secure: document.getElementById('secure-note'),
  chat: document.getElementById('chat')
};

const state = {
  bots: [],
  unread: {},
  seen: {},
  activeBotId: null,
  messages: [],
  hasMore: false,
  loadToken: 0,
  filter: '',
  attachment: null,
  previewUrl: '',
  cmdOpen: false,
  cmdIndex: 0,
  busy: new Set(),
  stick: true,
  messageSig: '',
  installEvent: null
};

const rec = {
  active: false,
  starting: null,
  mode: null,
  downAt: 0,
  cancelDrag: false,
  pendingStop: false,
  suppressClick: false,
  pointerId: null,
  originX: 0,
  recorder: null,
  stream: null,
  chunks: [],
  started: 0,
  mime: '',
  timer: 0,
  raf: 0,
  ctx: null,
  analyser: null,
  maxTimer: 0
};

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `c_${Date.now().toString(16)}_${Math.random().toString(16).slice(2)}`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function hueClass(id) {
  let n = 0;
  for (const ch of String(id || '')) n = (n + ch.charCodeAt(0)) % 12;
  return `hue-${n}`;
}

function loadSeen() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEEN_KEY) || 'null');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* keep a fresh map */ }
  return {};
}

function saveSeen() {
  localStorage.setItem(SEEN_KEY, JSON.stringify(state.seen));
}

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  els.toasts.appendChild(el);
  setTimeout(() => el.remove(), 3400);
}

function activeBot() {
  return state.bots.find((bot) => bot.id === state.activeBotId) || null;
}

function channelIsOpen() {
  return Boolean(state.activeBotId)
    && document.visibilityState === 'visible'
    && !document.body.classList.contains('sidebar-open');
}

function formatTime(ts) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(ts));
}

function dayKey(ts) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(ts));
}

function dayLabel(ts) {
  const key = dayKey(ts);
  if (key === dayKey(Date.now())) return 'Today';
  if (key === dayKey(Date.now() - 24 * 60 * 60 * 1000)) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric'
  }).format(new Date(ts));
}

function sidebarWhen(ts) {
  if (!ts) return '';
  if (dayKey(ts) === dayKey(Date.now())) return formatTime(ts);
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }).format(new Date(ts));
}

function previewOf(message) {
  if (!message) return '';
  if (message.type === 'image') return (message.text || '').trim() || 'Photo';
  if (message.type === 'voice') return 'Voice message';
  if (message.type === 'action') return (message.text || '').trim() || message.action || 'Action';
  return String(message.text || '').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Message';
}

function safeUrl(raw) {
  try {
    const url = new URL(raw, location.origin);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    if (url.origin === location.origin && /^\/uploads\/[a-zA-Z0-9._-]+$/.test(url.pathname)) return url.pathname;
  } catch { /* reject */ }
  return '';
}

function unescapeHtml(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function renderMarkdown(src) {
  const tokens = [];
  const stash = (html) => {
    const id = tokens.length;
    tokens.push(html);
    return `%%T${id}%%`;
  };
  const restore = (value) => value.replace(/%%T(\d+)%%/g, (_, n) => tokens[Number(n)] || '');
  let text = esc(String(src || '').replace(/\r\n/g, '\n'));
  text = text.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const label = lang || 'code';
    const body = code.replace(/^\n/, '').replace(/\n$/, '');
    return stash(`<div class="codeblock"><div class="codeblock-bar"><span>${label}</span><button type="button" class="text-btn" data-act="copy-code">Copy</button></div><pre><code>${body}</code></pre></div>`);
  });
  text = text.replace(/`([^`\n]+)`/g, (_, code) => stash(`<code class="inline-code">${code}</code>`));
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt, url) => {
    const href = safeUrl(unescapeHtml(url));
    if (!href) return match;
    return stash(`<img class="md-img" alt="${alt}" src="${esc(href)}" data-act="zoom">`);
  });
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    const href = safeUrl(unescapeHtml(url));
    if (!href) return match;
    return stash(`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  text = text.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
  text = text.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  text = text.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (match, pre, url) => {
    const href = safeUrl(unescapeHtml(url));
    if (!href) return match;
    return `${pre}${stash(`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`)}`;
  });

  const lines = text.split('\n');
  const html = [];
  let i = 0;
  const fenceIndex = (line) => {
    const match = line.trim().match(/^%%T(\d+)%%$/);
    return match ? Number(match[1]) : -1;
  };
  const isFence = (line) => {
    const index = fenceIndex(line);
    return index >= 0 && tokens[index]?.startsWith('<div class="codeblock"');
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    if (isFence(line)) { html.push(line.trim()); i += 1; continue; }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      html.push(`<h${heading[1].length}>${restore(heading[2])}</h${heading[1].length}>`);
      i += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { html.push('<hr>'); i += 1; continue; }
    if (/^&gt;\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
        quote.push(restore(lines[i].replace(/^&gt;\s?/, '')));
        i += 1;
      }
      html.push(`<blockquote>${quote.join('<br>')}</blockquote>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(restore(lines[i].replace(/^[-*]\s+/, '')));
        i += 1;
      }
      html.push(`<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>`);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(restore(lines[i].replace(/^\d+\.\s+/, '')));
        i += 1;
      }
      html.push(`<ol>${items.map((item) => `<li>${item}</li>`).join('')}</ol>`);
      continue;
    }
    const para = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !/^(#{1,3})\s+/.test(lines[i]) && !/^[-*]\s+/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i]) && !/^&gt;\s?/.test(lines[i]) && !/^(-{3,}|\*{3,})$/.test(lines[i].trim()) && !isFence(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    html.push(`<p>${restore(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return restore(html.join('\n'));
}

function setLive(on) {
  els.live.classList.toggle('is-off', !on);
  els.live.querySelector('span').textContent = on ? 'Live' : 'Reconnecting';
}

function updateTitle() {
  const total = Object.values(state.unread).reduce((sum, n) => sum + (n || 0), 0);
  document.title = total ? `(${total}) n8n Bot Hub` : 'n8n Bot Hub';
}

function visibleBots() {
  const q = state.filter.trim().toLowerCase();
  if (!q) return state.bots;
  return state.bots.filter((bot) => bot.name.toLowerCase().includes(q) || bot.id.includes(q));
}

function renderBots() {
  const top = els.list.scrollTop;
  const frag = document.createDocumentFragment();
  for (const bot of visibleBots()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `bot-item${bot.id === state.activeBotId ? ' active' : ''}`;
    btn.dataset.act = 'select-bot';
    btn.dataset.id = bot.id;
    btn.setAttribute('role', 'listitem');
    const count = state.unread[bot.id] || 0;
    btn.innerHTML = `
      <span class="avatar ${hueClass(bot.id)}">${esc(bot.icon || '🤖')}</span>
      <span class="bot-copy">
        <span class="name"></span>
        <span class="preview"></span>
      </span>
      <span>
        <span class="when"></span>
        ${count ? `<span class="unread">${count > 99 ? '99+' : count}</span>` : ''}
      </span>`;
    btn.querySelector('.name').textContent = bot.name;
    btn.querySelector('.preview').textContent = bot.lastMessage ? bot.lastMessage.preview : bot.id;
    btn.querySelector('.when').textContent = bot.lastMessage ? sidebarWhen(bot.lastMessage.at) : '';
    if (count) btn.querySelector('.unread').setAttribute('aria-label', `${count} unread`);
    frag.appendChild(btn);
  }
  els.list.replaceChildren(frag);
  els.list.scrollTop = top;
  els.emptyBots.hidden = state.bots.length > 0;
}

function renderHeader() {
  const bot = activeBot();
  if (!bot) {
    els.icon.textContent = '◎';
    els.icon.className = 'avatar hue-0';
    els.name.textContent = 'n8n Bot Hub';
    els.sub.textContent = 'Create a bot for each n8n workflow';
    els.actions.hidden = true;
    els.composerWrap.hidden = true;
    return;
  }
  els.icon.textContent = bot.icon || '🤖';
  els.icon.className = `avatar ${hueClass(bot.id)}`;
  els.name.textContent = bot.name;
  els.sub.textContent = bot.webhookUrl ? 'Outgoing webhook connected' : 'No outgoing webhook yet';
  els.actions.hidden = false;
  els.composerWrap.hidden = false;
}

function mergeMessages(current, incoming) {
  const map = new Map();
  for (const message of current) map.set(message.id, message);
  for (const message of incoming) map.set(message.id, { ...map.get(message.id), ...message });
  return [...map.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

function renderMessages(mode) {
  const el = els.messages;
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  const prevHeight = el.scrollHeight;
  const prevTop = el.scrollTop;
  const sig = `${state.activeBotId}|${state.hasMore}|${[...state.busy].join(',')}|${state.messages.map((m) => [m.id, m.status, m.chosenAction, m.text, m.fileUrl, (m.buttons || []).length].join(':')).join('|')}`;
  const stick = mode === 'bottom' || (mode !== 'keep' && (near || state.stick));
  if (sig === state.messageSig && mode !== 'keep' && mode !== 'bottom') return;
  state.messageSig = sig;
  const frag = document.createDocumentFragment();
  if (!state.activeBotId) {
    const card = document.createElement('div');
    card.className = 'empty-state';
    card.innerHTML = '<h2>Channels for your automations</h2><p>Each bot is a private chat that forwards text, images, and voice notes to an n8n webhook.</p>';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'new-bot';
    button.dataset.act = 'new-bot';
    button.textContent = 'New bot';
    card.appendChild(button);
    frag.appendChild(card);
  } else if (!state.messages.length) {
    const card = document.createElement('div');
    card.className = 'empty-state';
    card.innerHTML = '<h2>This channel is quiet</h2><p>Send a message below, or push one in from n8n with the webhook info button.</p>';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.dataset.act = 'webhook-info';
    button.textContent = 'Webhook info';
    card.appendChild(button);
    frag.appendChild(card);
  } else {
    if (state.hasMore) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'load-more';
      more.dataset.act = 'load-more';
      more.textContent = 'Load older messages';
      frag.appendChild(more);
    }
    let lastDay = '';
    for (const message of state.messages) {
      const day = dayKey(message.createdAt);
      if (day !== lastDay) {
        lastDay = day;
        const sep = document.createElement('div');
        sep.className = 'day-sep';
        sep.innerHTML = `<span>${esc(dayLabel(message.createdAt))}</span>`;
        frag.appendChild(sep);
      }
      frag.appendChild(renderMessage(message));
    }
  }
  el.replaceChildren(frag);
  if (mode === 'keep') el.scrollTop = Math.max(0, prevTop + (el.scrollHeight - prevHeight));
  else if (stick) el.scrollTop = el.scrollHeight;
  state.stick = stick;
  els.jump.hidden = stick || !state.messages.length;
  el.querySelectorAll('img').forEach((img) => {
    img.addEventListener('load', () => { if (state.stick) el.scrollTop = el.scrollHeight; }, { once: true });
  });
}

function renderMessage(message) {
  const row = document.createElement('article');
  row.className = `row ${message.direction === 'out' ? 'out' : 'in'}`;
  row.dataset.id = message.id;
  if (message.direction === 'in') {
    const bot = state.bots.find((item) => item.id === message.botId);
    const avatar = document.createElement('div');
    avatar.className = `avatar sm ${hueClass(message.botId)}`;
    avatar.textContent = bot ? bot.icon : '🤖';
    row.appendChild(avatar);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (message.type === 'action') {
    const kicker = document.createElement('p');
    kicker.className = 'kicker';
    kicker.textContent = 'Button';
    bubble.appendChild(kicker);
  }
  const media = safeUrl(message.fileUrl || '');
  if (message.type === 'image' && media) {
    const img = document.createElement('img');
    img.className = 'msg-image';
    img.src = media;
    img.alt = message.text || 'Image';
    img.dataset.act = 'zoom';
    bubble.appendChild(img);
  }
  if (message.type === 'voice' && media) {
    const wrap = document.createElement('div');
    wrap.className = 'voice';
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = media;
    wrap.appendChild(audio);
    bubble.appendChild(wrap);
  }
  if (message.text && !(message.type === 'image' && !message.text.trim())) {
    const md = document.createElement('div');
    md.className = 'md';
    md.innerHTML = renderMarkdown(message.text);
    bubble.appendChild(md);
  }
  if (message.buttons && message.buttons.length) {
    const actions = document.createElement('div');
    actions.className = 'inline-actions';
    message.buttons.forEach((button, index) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `action-btn${message.chosenAction === button.action ? ' is-chosen' : ''}`;
      el.dataset.act = 'inline';
      el.dataset.mid = message.id;
      el.dataset.i = String(index);
      el.textContent = button.label;
      el.disabled = state.busy.has(`${message.id}:${index}`);
      actions.appendChild(el);
    });
    bubble.appendChild(actions);
  }
  const meta = document.createElement('div');
  meta.className = 'meta';
  const time = document.createElement('span');
  time.textContent = formatTime(message.createdAt);
  meta.appendChild(time);
  if (message.status === 'pending') {
    const pending = document.createElement('span');
    pending.textContent = 'Sending';
    meta.appendChild(pending);
  }
  bubble.appendChild(meta);
  if (message.direction === 'out' && message.status === 'error') {
    const delivery = document.createElement('div');
    delivery.className = 'delivery';
    const span = document.createElement('span');
    span.textContent = message.error || 'n8n did not accept this message';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'text-btn';
    retry.dataset.act = 'retry';
    retry.dataset.id = message.id;
    retry.textContent = 'Retry';
    delivery.append(span, retry);
    bubble.appendChild(delivery);
  } else if (message.direction === 'out' && message.status === 'local') {
    const delivery = document.createElement('div');
    delivery.className = 'delivery muted';
    delivery.textContent = 'Saved on this hub. Add an outgoing webhook to forward it.';
    bubble.appendChild(delivery);
  }
  row.appendChild(bubble);
  return row;
}

function renderPreview() {
  els.preview.hidden = !state.attachment;
  els.preview.replaceChildren();
  if (!state.attachment) return;
  const img = document.createElement('img');
  img.src = state.previewUrl;
  img.alt = 'Attachment preview';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'text-btn danger';
  remove.dataset.act = 'clear-attach';
  remove.textContent = 'Remove';
  els.preview.append(img, remove);
}

function commandToken() {
  const pos = els.input.selectionStart ?? els.input.value.length;
  const match = els.input.value.slice(0, pos).match(/(^|\s)(\/[a-zA-Z0-9_-]*)$/);
  return match ? match[2] : null;
}

function filteredCommands() {
  const bot = activeBot();
  const commands = bot ? bot.quickCommands || [] : [];
  const token = commandToken();
  if (!state.cmdOpen && !token) return [];
  const query = (token || '').toLowerCase();
  return commands.filter((command) => !query || command.toLowerCase().startsWith(query));
}

function renderCommands() {
  const token = commandToken();
  const commands = filteredCommands();
  const show = state.cmdOpen || Boolean(token);
  els.cmds.hidden = !show;
  if (!show) return;
  els.cmds.replaceChildren();
  if (!commands.length) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = activeBot()?.quickCommands?.length
      ? 'No matching command'
      : 'No quick commands yet. Add them in bot settings.';
    els.cmds.appendChild(hint);
    return;
  }
  if (state.cmdIndex >= commands.length) state.cmdIndex = 0;
  commands.forEach((command, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.act = 'run-command';
    button.dataset.command = command;
    button.className = index === state.cmdIndex ? 'is-active' : '';
    button.textContent = command;
    els.cmds.appendChild(button);
  });
}

function slugify(name) {
  return String(name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function openSidebar() {
  document.body.classList.add('sidebar-open');
}

function closeSidebar() {
  document.body.classList.remove('sidebar-open');
  if (channelIsOpen()) markSeen(state.activeBotId);
}

function markSeen(botId) {
  if (!botId) return;
  const newest = state.messages.length ? state.messages[state.messages.length - 1].createdAt : 0;
  const current = state.seen[botId] || 0;
  const next = Math.max(current, newest, state.seen['*'] || 0);
  if (next !== current) {
    state.seen[botId] = next;
    saveSeen();
  }
  state.unread[botId] = 0;
  updateTitle();
  renderBots();
}

async function api(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

let refreshTimer = 0;
let refreshSeq = 0;
function scheduleBotRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refreshBots().catch(() => {}); }, 60);
}

async function refreshBots() {
  const seq = ++refreshSeq;
  const res = await fetch('/api/bots', { headers: { 'X-Hub-Seen': JSON.stringify(state.seen) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not load bots');
  if (seq !== refreshSeq) return;
  state.bots = data.bots || [];
  state.unread = {};
  for (const bot of state.bots) state.unread[bot.id] = bot.unread || 0;
  renderBots();
  renderHeader();
  updateTitle();
}

function upsertLocal(message) {
  const index = state.messages.findIndex((item) => item.id === message.id);
  if (index === -1) state.messages.push(message);
  else state.messages[index] = message;
  state.messages.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

function applyMessage(message, isUpdate) {
  const bot = state.bots.find((item) => item.id === message.botId);
  if (bot) {
    bot.lastMessage = {
      id: message.id,
      preview: previewOf(message),
      at: message.createdAt,
      direction: message.direction,
      type: message.type
    };
  }
  if (message.botId === state.activeBotId) {
    upsertLocal(message);
    if (!isUpdate && message.direction === 'in' && channelIsOpen()) {
      state.seen[message.botId] = Math.max(state.seen[message.botId] || 0, message.createdAt);
      state.unread[message.botId] = 0;
      saveSeen();
    }
    renderMessages('auto');
  }
  renderBots();
  scheduleBotRefresh();
}

async function openBot(id, updateHash = true) {
  if (!state.bots.some((bot) => bot.id === id)) return;
  state.activeBotId = id;
  localStorage.setItem(ACTIVE_KEY, id);
  if (updateHash) history.replaceState(null, '', `#${id}`);
  state.messages = [];
  state.hasMore = false;
  state.messageSig = '';
  state.stick = true;
  renderHeader();
  renderBots();
  renderMessages('bottom');
  closeSidebar();
  const token = ++state.loadToken;
  const data = await api(`/api/bots/${encodeURIComponent(id)}/messages?limit=50`);
  if (token !== state.loadToken || state.activeBotId !== id) return;
  state.messages = mergeMessages(state.messages, data.messages || []);
  state.hasMore = Boolean(data.hasMore);
  if (channelIsOpen()) {
    const newest = state.messages.length ? state.messages[state.messages.length - 1].createdAt : (state.seen['*'] || 0);
    state.seen[id] = Math.max(state.seen[id] || 0, newest);
    state.unread[id] = 0;
    saveSeen();
  }
  renderMessages('bottom');
  renderBots();
  scheduleBotRefresh();
  if (!matchMedia('(pointer: coarse)').matches) els.input.focus();
}

function clearAttachment() {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.attachment = null;
  state.previewUrl = '';
  els.file.value = '';
  renderPreview();
}

function setAttachment(file) {
  if (!file || !String(file.type || '').startsWith('image/') || file.type === 'image/svg+xml') {
    toast('Choose a photo from your camera, gallery, or clipboard');
    return;
  }
  if (rec.active) toast('Finish the voice note before attaching a photo');
  clearAttachment();
  state.attachment = file;
  state.previewUrl = URL.createObjectURL(file);
  renderPreview();
}

function resizeComposer() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 140)}px`;
}

async function postForm(botId, form, clientId, snapshot) {
  try {
    const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/send`, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Send failed');
    if (data.message) applyMessage(data.message, true);
    if (data.reply) applyMessage(data.reply, false);
  } catch (err) {
    const landed = state.messages.some((message) => message.clientId === clientId);
    if (!landed && snapshot) {
      els.input.value = snapshot.text || '';
      resizeComposer();
      if (snapshot.file) setAttachment(snapshot.file);
    }
    toast(err.message || 'Send failed');
  }
}

async function sendCurrent() {
  const bot = activeBot();
  if (!bot || rec.active) return;
  const text = els.input.value.trim();
  const file = state.attachment;
  if (!text && !file) return;
  const clientId = uid();
  const form = new FormData();
  form.append('type', file ? 'image' : 'text');
  form.append('text', text);
  form.append('clientId', clientId);
  if (file) form.append('file', file, file.name || 'image.png');
  const snapshot = { text: els.input.value, file };
  els.input.value = '';
  resizeComposer();
  state.cmdOpen = false;
  renderCommands();
  clearAttachment();
  await postForm(bot.id, form, clientId, snapshot);
}

async function sendCommand(command) {
  const bot = activeBot();
  if (!bot) return;
  const clientId = uid();
  const form = new FormData();
  form.append('type', 'text');
  form.append('text', command);
  form.append('clientId', clientId);
  els.input.value = '';
  resizeComposer();
  state.cmdOpen = false;
  renderCommands();
  await postForm(bot.id, form, clientId, { text: command });
}

async function sendAction(message, index) {
  const button = message.buttons[index];
  if (!button) return;
  const key = `${message.id}:${index}`;
  if (state.busy.has(key)) return;
  state.busy.add(key);
  renderMessages('auto');
  const clientId = uid();
  const form = new FormData();
  form.append('type', 'action');
  form.append('text', button.label);
  form.append('action', button.action);
  form.append('data', JSON.stringify(button.data || {}));
  form.append('sourceMessageId', message.id);
  form.append('clientId', clientId);
  try {
    await postForm(message.botId, form, clientId);
  } finally {
    state.busy.delete(key);
    renderMessages('auto');
  }
}

function webhookSnippets(bot) {
  const url = `${location.origin}/api/webhook/${bot.id}`;
  const body = {
    text: 'Markdown **formatted** message from n8n',
    imageUrl: 'https://example.com/optional.png',
    buttons: [
      { label: 'Approve', action: 'approve_task', data: { id: 123 } },
      { label: 'Reject', action: 'reject_task', data: { id: 123 } }
    ]
  };
  const json = JSON.stringify(body, null, 2);
  const curl = `curl -X POST ${sh(url)} -H ${sh('Content-Type: application/json')} -d ${sh(JSON.stringify(body))}`;
  return { url, json, curl };
}

function sh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function closeModal() {
  els.modal.replaceChildren();
}

function openModal(node) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.dataset.act = 'close-modal';
  back.appendChild(node);
  els.modal.replaceChildren(back);
  const field = node.querySelector('input, textarea, button');
  if (field) field.focus();
}

function openBotModal(bot) {
  const editing = Boolean(bot);
  const modal = document.createElement('form');
  modal.className = 'modal';
  modal.id = 'bot-form';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.addEventListener('submit', (event) => {
    event.preventDefault();
    saveBot(new FormData(modal));
  });
  modal.innerHTML = `
    <h2>${editing ? 'Edit bot' : 'New bot'}</h2>
    <p class="lede">A bot is a channel. Messages you send are forwarded to its n8n webhook.</p>
    <input type="hidden" name="editing" value="${editing ? '1' : '0'}">
    <label class="field"><span>Name</span><input name="name" required maxlength="60" value="${esc(bot ? bot.name : '')}"></label>
    <label class="field"><span>Id</span><input name="id" required maxlength="40" pattern="[a-z0-9]+(-[a-z0-9]+)*" value="${esc(bot ? bot.id : '')}" ${editing ? 'readonly' : ''} placeholder="media-bot"></label>
    <label class="field"><span>Icon</span><input name="icon" maxlength="8" value="${esc(bot ? bot.icon : '🤖')}"></label>
    <div class="emoji-row">${EMOJI.map((emoji) => `<button type="button" data-act="pick-icon" data-icon="${emoji}">${emoji}</button>`).join('')}</div>
    <label class="field"><span>n8n outgoing webhook URL</span><input name="webhookUrl" type="url" maxlength="2000" placeholder="https://n8n.example/webhook/..." value="${esc(bot ? bot.webhookUrl : '')}"></label>
    <label class="field"><span>Quick commands</span><input name="quickCommands" maxlength="500" placeholder="/status, /summary" value="${esc(bot ? (bot.quickCommands || []).join(', ') : '')}"></label>
    <div class="modal-actions">
      ${editing ? '<button type="button" class="btn danger" data-act="confirm-delete">Delete</button>' : '<span></span>'}
      <span>
        <button type="button" class="btn" data-act="close-modal">Cancel</button>
        <button type="submit" class="btn primary">${editing ? 'Save' : 'Create'}</button>
      </span>
    </div>`;
  openModal(modal);
  if (!editing) {
    const name = modal.querySelector('[name="name"]');
    const id = modal.querySelector('[name="id"]');
    name.addEventListener('input', () => {
      if (id.dataset.touched === '1') return;
      id.value = slugify(name.value);
    });
    id.addEventListener('input', () => { id.dataset.touched = '1'; });
  }
}

function openDeleteModal() {
  const bot = activeBot();
  if (!bot) return;
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.innerHTML = `<h2>Delete ${esc(bot.name)}?</h2><p class="lede">The channel and its message history on this hub will be removed. n8n workflows are left as they are.</p><div class="modal-actions"><span></span><span><button type="button" class="btn" data-act="close-modal">Cancel</button><button type="button" class="btn danger" data-act="delete-bot">Delete bot</button></span></div>`;
  openModal(modal);
}

function openWebhookModal() {
  const bot = activeBot();
  if (!bot) return;
  const snippets = webhookSnippets(bot);
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.innerHTML = `
    <h2>Webhook info</h2>
    <p class="lede">Anyone who can reach this hub can post into the channel. Keep it on a private network or behind a tunnel you trust.</p>
    <div class="copy-block"><div class="copy-row"><span>Incoming URL for the n8n HTTP Request node</span><button type="button" class="text-btn" data-act="copy-block">Copy</button></div><pre></pre></div>
    <div class="copy-block"><div class="copy-row"><span>curl</span><button type="button" class="text-btn" data-act="copy-block">Copy</button></div><pre></pre></div>
    <div class="copy-block"><div class="copy-row"><span>JSON body</span><button type="button" class="text-btn" data-act="copy-block">Copy</button></div><pre></pre></div>
    <p class="lede">Outgoing multipart fields posted to n8n: botId, messageId, timestamp, type (text, image, voice, or action), text, and file. Button presses also send action, data (JSON string), and sourceMessageId. A Respond to Webhook JSON body with text, imageUrl, or buttons is shown as a reply. The default “Workflow was started” ack is ignored.</p>
    <p class="lede">Outgoing URL: ${bot.webhookUrl ? '' : 'not set'}</p>
    <div class="modal-actions"><span></span><button type="button" class="btn primary" data-act="close-modal">Close</button></div>`;
  const pres = modal.querySelectorAll('pre');
  pres[0].textContent = snippets.url;
  pres[1].textContent = snippets.curl;
  pres[2].textContent = snippets.json;
  if (bot.webhookUrl) {
    const chip = document.createElement('div');
    chip.className = 'url-chip';
    chip.textContent = bot.webhookUrl;
    modal.querySelectorAll('.lede')[2].after(chip);
  }
  openModal(modal);
}

async function saveBot(form) {
  const editing = form.get('editing') === '1';
  const payload = {
    id: String(form.get('id') || '').trim().toLowerCase(),
    name: String(form.get('name') || '').trim(),
    icon: String(form.get('icon') || '').trim(),
    webhookUrl: String(form.get('webhookUrl') || '').trim(),
    quickCommands: String(form.get('quickCommands') || '').trim()
  };
  try {
    const data = await api(editing ? `/api/bots/${encodeURIComponent(payload.id)}` : '/api/bots', {
      method: editing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    closeModal();
    await refreshBots();
    await openBot(data.bot.id);
    toast(editing ? 'Bot updated' : 'Bot created');
  } catch (err) {
    toast(err.message || 'Could not save the bot');
  }
}

async function deleteBot() {
  const bot = activeBot();
  if (!bot) return;
  try {
    await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: 'DELETE' });
    closeModal();
    state.bots = state.bots.filter((item) => item.id !== bot.id);
    delete state.unread[bot.id];
    const next = state.bots[0];
    if (next) await openBot(next.id);
    else {
      state.activeBotId = null;
      state.messages = [];
      history.replaceState(null, '', location.pathname);
      renderHeader();
      renderMessages('bottom');
      renderBots();
    }
    toast('Bot deleted');
  } catch (err) {
    toast(err.message || 'Could not delete the bot');
  }
}

function pickMime() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];
  if (!window.MediaRecorder) return '';
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function updateRecordUi() {
  const recording = rec.active;
  els.recordBar.hidden = !recording;
  els.recordBar.classList.toggle('will-cancel', rec.cancelDrag);
  els.mic.classList.toggle('is-recording', recording);
  els.mic.setAttribute('aria-pressed', recording ? 'true' : 'false');
  if (rec.cancelDrag) els.recordTime.textContent = 'Release to cancel';
}

function drawWave() {
  const canvas = els.wave;
  if (!canvas || !rec.analyser) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor((rect.height || 36) * dpr));
  const ctx = canvas.getContext('2d');
  const buffer = new Uint8Array(rec.analyser.fftSize);
  const loop = () => {
    rec.raf = requestAnimationFrame(loop);
    if (!rec.analyser) return;
    rec.analyser.getByteTimeDomainData(buffer);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const bars = 28;
    const step = Math.floor(buffer.length / bars);
    const gap = 3 * dpr;
    const barW = (canvas.width - gap * (bars - 1)) / bars;
    for (let i = 0; i < bars; i += 1) {
      let sum = 0;
      for (let j = 0; j < step; j += 1) sum += Math.abs(buffer[i * step + j] - 128);
      const amp = Math.min(1, (sum / step) / 36);
      const h = Math.max(dpr * 3, amp * canvas.height);
      const x = i * (barW + gap);
      ctx.fillStyle = '#ff8d8d';
      ctx.fillRect(x, (canvas.height - h) / 2, barW, h);
    }
  };
  loop();
}

function stopStream() {
  clearInterval(rec.timer);
  clearTimeout(rec.maxTimer);
  if (rec.raf) cancelAnimationFrame(rec.raf);
  rec.raf = 0;
  if (rec.stream) rec.stream.getTracks().forEach((track) => track.stop());
  rec.stream = null;
  if (rec.ctx) rec.ctx.close().catch(() => {});
  rec.ctx = null;
  rec.analyser = null;
}

async function startRecording() {
  if (rec.active || rec.starting) return rec.starting;
  if (!window.isSecureContext) {
    toast('Voice notes need localhost or HTTPS');
    return;
  }
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    toast('This browser cannot record audio');
    return;
  }
  rec.starting = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    });
    const mime = pickMime();
    const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    rec.stream = stream;
    rec.recorder = recorder;
    rec.chunks = [];
    rec.mime = recorder.mimeType || mime || 'audio/webm';
    rec.started = Date.now();
    rec.active = true;
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size) rec.chunks.push(event.data);
    });
    recorder.start(200);
    try {
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      rec.ctx = audioCtx;
      rec.analyser = analyser;
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      drawWave();
    } catch { /* timer still works if the waveform cannot start */ }
    const tick = () => {
      if (rec.cancelDrag) return;
      const seconds = Math.floor((Date.now() - rec.started) / 1000);
      els.recordTime.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    };
    tick();
    rec.timer = setInterval(tick, 200);
    rec.maxTimer = setTimeout(() => { finishRecording({ send: true }); }, 5 * 60 * 1000);
    updateRecordUi();
  })();
  try {
    await rec.starting;
  } catch (err) {
    stopStream();
    rec.active = false;
    updateRecordUi();
    toast(err && err.name === 'NotAllowedError' ? 'Microphone permission blocked' : 'Could not start recording');
  } finally {
    rec.starting = null;
  }
}

function stopRecorder() {
  return new Promise((resolve) => {
    const recorder = rec.recorder;
    if (!recorder || recorder.state === 'inactive') {
      resolve(null);
      return;
    }
    recorder.addEventListener('stop', () => {
      resolve(new Blob(rec.chunks, { type: rec.mime || 'audio/webm' }));
    }, { once: true });
    recorder.stop();
  });
}

async function finishRecording({ send = false, cancel = false } = {}) {
  if (rec.finishing) return;
  rec.finishing = true;
  try {
  if (rec.starting) await rec.starting;
  if (!rec.active) return;
  rec.active = false;
  rec.mode = null;
  rec.cancelDrag = false;
  const started = rec.started;
  const blob = await stopRecorder();
  stopStream();
  rec.recorder = null;
  updateRecordUi();
  const duration = Date.now() - started;
  if (cancel || !blob || duration < 400 || blob.size < 400) {
    if (!cancel && duration < 400) toast('Recording was too short');
    return;
  }
  if (!send) return;
  const bot = activeBot();
  if (!bot) return;
  const ext = /mp4|aac|m4a/.test(blob.type) ? 'm4a' : (/ogg/.test(blob.type) ? 'ogg' : 'webm');
  const baseType = (blob.type || 'audio/webm').split(';')[0];
  const file = new File([blob], `voice.${ext}`, { type: baseType });
  const clientId = uid();
  const form = new FormData();
  form.append('type', 'voice');
  form.append('text', '');
  form.append('clientId', clientId);
  form.append('file', file, file.name);
  clearAttachment();
  await postForm(bot.id, form, clientId);
  } finally {
    rec.finishing = false;
  }
}

async function loadOlder() {
  const botId = state.activeBotId;
  const oldest = state.messages[0];
  if (!botId || !oldest) return;
  const data = await api(`/api/bots/${encodeURIComponent(botId)}/messages?limit=50&before=${oldest.createdAt}`);
  if (state.activeBotId !== botId) return;
  state.messages = mergeMessages(data.messages || [], state.messages);
  state.hasMore = Boolean(data.hasMore);
  state.messageSig = '';
  renderMessages('keep');
}

function connectSse() {
  const es = new EventSource('/api/events');
  es.addEventListener('hub', (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'hello') {
      setLive(true);
      refreshBots().catch(() => {});
      return;
    }
    if (data.type === 'message') applyMessage(data.message, false);
    if (data.type === 'message_updated') applyMessage(data.message, true);
    if (data.type === 'bot_upsert') {
      const index = state.bots.findIndex((bot) => bot.id === data.bot.id);
      if (index === -1) state.bots.push({ ...data.bot, unread: state.unread[data.bot.id] || 0 });
      else {
        const unread = state.unread[data.bot.id] || 0;
        state.bots[index] = { ...state.bots[index], ...data.bot, unread };
      }
      state.bots.sort((a, b) => a.createdAt - b.createdAt);
      renderBots();
      renderHeader();
    }
    if (data.type === 'bot_delete') {
      state.bots = state.bots.filter((bot) => bot.id !== data.botId);
      delete state.unread[data.botId];
      if (state.activeBotId === data.botId) {
        const next = state.bots[0];
        if (next) openBot(next.id);
        else {
          state.activeBotId = null;
          state.messages = [];
          renderHeader();
          renderMessages('bottom');
        }
      }
      renderBots();
      updateTitle();
      if (els.modal.querySelector('.modal')) closeModal();
    }
  });
  es.onerror = () => setLive(false);
}

function bindInstall() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installEvent = event;
    els.install.hidden = false;
  });
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (ios && !standalone) els.ios.hidden = false;
  if (!window.isSecureContext) els.secure.hidden = false;
}

function bindSwipe() {
  let startX = 0;
  let startY = 0;
  let tracking = false;
  els.chat.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) return;
    const target = event.target.closest('button, a, audio, input, textarea, canvas');
    if (target) return;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    tracking = true;
  }, { passive: true });
  els.chat.addEventListener('touchend', (event) => {
    if (!tracking) return;
    tracking = false;
    const dx = event.changedTouches[0].clientX - startX;
    const dy = event.changedTouches[0].clientY - startY;
    if (Math.abs(dx) < 80 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    if (dx > 0 && startX < 48) openSidebar();
    else if (dx < 0) closeSidebar();
  }, { passive: true });
}

function bindRecorder() {
  els.mic.addEventListener('contextmenu', (event) => event.preventDefault());
  els.mic.addEventListener('pointerdown', (event) => {
    if (event.button != null && event.button !== 0) return;
    if (rec.active && rec.mode === 'toggle') {
      rec.pendingStop = true;
      return;
    }
    if (rec.active || rec.starting) return;
    rec.pointerId = event.pointerId;
    rec.originX = event.clientX;
    rec.downAt = Date.now();
    rec.cancelDrag = false;
    rec.mode = 'pending';
    try { els.mic.setPointerCapture(event.pointerId); } catch { /* some browsers reject capture */ }
    startRecording();
  });
  els.mic.addEventListener('pointermove', (event) => {
    if (!rec.active && !rec.starting) return;
    if (rec.mode === 'toggle') return;
    rec.cancelDrag = event.clientX < rec.originX - 80;
    updateRecordUi();
  });
  els.mic.addEventListener('pointerup', () => {
    if (rec.pendingStop) {
      rec.suppressClick = true;
      rec.pendingStop = false;
      finishRecording({ send: true });
      return;
    }
    if (rec.mode !== 'pending' && rec.mode !== 'hold') return;
    rec.suppressClick = true;
    const held = Date.now() - rec.downAt >= 280;
    if (held) finishRecording({ cancel: rec.cancelDrag, send: !rec.cancelDrag });
    else {
      rec.mode = 'toggle';
      updateRecordUi();
    }
  });
  els.mic.addEventListener('pointercancel', () => {
    rec.pendingStop = false;
    if (rec.active) {
      rec.mode = 'toggle';
      rec.cancelDrag = false;
      updateRecordUi();
    }
  });
  els.mic.addEventListener('click', () => {
    if (rec.suppressClick) {
      rec.suppressClick = false;
      return;
    }
    if (!rec.active) {
      rec.mode = 'toggle';
      startRecording();
    } else finishRecording({ send: true });
  });
}

async function onClick(event) {
  const target = event.target.closest('[data-act]');
  if (!target) return;
  const act = target.dataset.act;
  if (act === 'close-modal') {
    if (event.target.closest('.modal') && !event.target.closest('[data-act="close-modal"]')) return;
    closeModal();
    return;
  }
  if (act === 'toggle-sidebar') {
    document.body.classList.toggle('sidebar-open');
    return;
  }
  if (act === 'close-sidebar') { closeSidebar(); return; }
  if (act === 'collapse-sidebar') {
    els.app.classList.toggle('is-collapsed');
    localStorage.setItem(COLLAPSE_KEY, els.app.classList.contains('is-collapsed') ? '1' : '0');
    return;
  }
  if (act === 'new-bot') { closeSidebar(); openBotModal(null); return; }
  if (act === 'edit-bot') { openBotModal(activeBot()); return; }
  if (act === 'webhook-info') { openWebhookModal(); return; }
  if (act === 'confirm-delete') { openDeleteModal(); return; }
  if (act === 'delete-bot') { deleteBot(); return; }
  if (act === 'select-bot') { openBot(target.dataset.id).catch((err) => toast(err.message)); return; }
  if (act === 'attach') { els.file.click(); return; }
  if (act === 'clear-attach') { clearAttachment(); return; }
  if (act === 'toggle-commands') {
    state.cmdOpen = !state.cmdOpen;
    state.cmdIndex = 0;
    renderCommands();
    return;
  }
  if (act === 'run-command') { sendCommand(target.dataset.command); return; }
  if (act === 'pick-icon') {
    const input = els.modal.querySelector('[name="icon"]');
    if (input) input.value = target.dataset.icon || '';
    return;
  }
  if (act === 'copy-block') {
    const text = target.closest('.copy-block')?.querySelector('pre')?.textContent || '';
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      toast('Could not copy');
    }
    return;
  }
  if (act === 'copy-code') {
    const code = target.closest('.codeblock')?.querySelector('code')?.textContent || '';
    try {
      await navigator.clipboard.writeText(code);
      toast('Copied');
    } catch {
      toast('Could not copy');
    }
    return;
  }
  if (act === 'zoom') {
    const src = target.getAttribute('src');
    if (!src) return;
    els.lightboxImg.src = src;
    els.lightbox.hidden = false;
    return;
  }
  if (act === 'close-lightbox') { els.lightbox.hidden = true; els.lightboxImg.removeAttribute('src'); return; }
  if (act === 'retry') {
    try { await api(`/api/messages/${encodeURIComponent(target.dataset.id)}/retry`, { method: 'POST' }); }
    catch (err) { toast(err.message); }
    return;
  }
  if (act === 'inline') {
    const message = state.messages.find((item) => item.id === target.dataset.mid);
    if (message) sendAction(message, Number(target.dataset.i));
    return;
  }
  if (act === 'load-more') {
    try { await loadOlder(); } catch (err) { toast(err.message); }
    return;
  }
  if (act === 'record-cancel') { finishRecording({ cancel: true }); return; }
  if (act === 'record-send') { finishRecording({ send: true }); return; }
}

function bind() {
  document.body.addEventListener('click', onClick);
  els.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    if (rec.active) finishRecording({ send: true });
    else sendCurrent();
  });
  els.input.addEventListener('input', () => {
    resizeComposer();
    state.cmdIndex = 0;
    renderCommands();
  });
  els.input.addEventListener('keyup', () => renderCommands());
  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      sendCurrent();
      return;
    }
    const commands = filteredCommands();
    if (!els.cmds.hidden && commands.length && event.key === 'ArrowDown') {
      event.preventDefault();
      state.cmdIndex = (state.cmdIndex + 1) % commands.length;
      renderCommands();
      return;
    }
    if (!els.cmds.hidden && commands.length && event.key === 'ArrowUp') {
      event.preventDefault();
      state.cmdIndex = (state.cmdIndex - 1 + commands.length) % commands.length;
      renderCommands();
      return;
    }
    if (!els.cmds.hidden && commands.length && event.key === 'Tab') {
      event.preventDefault();
      sendCommand(commands[state.cmdIndex] || commands[0]);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer: coarse)').matches) {
      event.preventDefault();
      sendCurrent();
    }
  });
  els.file.addEventListener('change', () => {
    const file = els.file.files && els.file.files[0];
    if (file) setAttachment(file);
  });
  document.addEventListener('paste', (event) => {
    const items = event.clipboardData && event.clipboardData.items;
    if (!items || !state.activeBotId) return;
    const inOtherField = event.target.closest('input, textarea') && event.target !== els.input;
    if (inOtherField) return;
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) return;
        event.preventDefault();
        const named = file.name && file.name !== 'image.png'
          ? file
          : new File([file], `pasted-${Date.now()}.png`, { type: file.type || 'image/png' });
        setAttachment(named);
        return;
      }
    }
  });
  els.composerWrap.addEventListener('dragover', (event) => {
    if (![...event.dataTransfer.items].some((item) => item.type.startsWith('image/'))) return;
    event.preventDefault();
    els.composerWrap.classList.add('is-drop');
  });
  els.composerWrap.addEventListener('dragleave', () => els.composerWrap.classList.remove('is-drop'));
  els.composerWrap.addEventListener('drop', (event) => {
    els.composerWrap.classList.remove('is-drop');
    const file = [...event.dataTransfer.files].find((item) => item.type.startsWith('image/'));
    if (!file) return;
    event.preventDefault();
    setAttachment(file);
  });
  els.jump.addEventListener('click', () => {
    state.stick = true;
    els.messages.scrollTop = els.messages.scrollHeight;
    els.jump.hidden = true;
  });
  els.messages.addEventListener('scroll', () => {
    const near = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 90;
    state.stick = near;
    els.jump.hidden = near || !state.messages.length;
  });
  els.filter.addEventListener('input', () => {
    state.filter = els.filter.value;
    renderBots();
  });
  els.lightbox.addEventListener('click', (event) => {
    if (event.target === els.lightbox) {
      els.lightbox.hidden = true;
      els.lightboxImg.removeAttribute('src');
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!els.lightbox.hidden) {
        els.lightbox.hidden = true;
        return;
      }
      if (els.modal.childElementCount) { closeModal(); return; }
      if (rec.active) { finishRecording({ cancel: true }); return; }
      closeSidebar();
      state.cmdOpen = false;
      renderCommands();
      return;
    }
    if (event.key === '/' && document.activeElement !== els.input && !event.target.closest('input, textarea')) {
      event.preventDefault();
      els.input.focus();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (channelIsOpen()) {
      markSeen(state.activeBotId);
      scheduleBotRefresh();
    }
  });
  window.addEventListener('hashchange', () => {
    const id = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (id && id !== state.activeBotId && state.bots.some((bot) => bot.id === id)) {
      openBot(id, false).catch((err) => toast(err.message));
    }
  });
  els.install.addEventListener('click', async () => {
    if (!state.installEvent) return;
    state.installEvent.prompt();
    await state.installEvent.userChoice.catch(() => {});
    state.installEvent = null;
    els.install.hidden = true;
  });
  bindRecorder();
  bindSwipe();
}

async function boot() {
  bind();
  state.seen = loadSeen();
  if (localStorage.getItem(COLLAPSE_KEY) === '1' && matchMedia('(min-width: 768px)').matches) {
    els.app.classList.add('is-collapsed');
  }
  bindInstall();
  try {
    const health = await api('/api/health');
    if (!state.seen['*']) {
      state.seen['*'] = health.now;
      saveSeen();
    }
  } catch {
    toast('Hub server is not responding');
  }
  connectSse();
  try { await refreshBots(); } catch { toast('Could not load channels'); }
  const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
  const stored = localStorage.getItem(ACTIVE_KEY);
  const pick = state.bots.find((bot) => bot.id === hash) || state.bots.find((bot) => bot.id === stored) || state.bots[0];
  if (pick) await openBot(pick.id).catch((err) => toast(err.message));
  else {
    renderHeader();
    renderMessages('bottom');
    if (matchMedia('(max-width: 767px)').matches) openSidebar();
  }
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

boot();
