import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { Hono, type Context } from 'hono';

import type { Config } from '../config/schema.js';
import type { ApprovalBroker, HumanDecision } from './broker.js';

/** Decision bodies are tiny; anything larger is rejected before parsing. */
export const MAX_DECISION_BODY_BYTES = 4096;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ApprovalConfig = Pick<Config['human_approval'], 'host' | 'token'>;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time over fixed-length digests, so neither length nor prefix leaks. */
function tokenMatches(header: string | undefined, expected: Buffer): boolean {
  const supplied = /^Bearer[\t ]+(\S+)$/i.exec(header ?? '')?.[1];
  if (supplied === undefined) return false;
  return timingSafeEqual(digest(supplied), expected);
}

function hostName(host: string): string {
  if (host.startsWith('[')) return host.slice(1, host.indexOf(']')).toLowerCase();
  const colon = host.lastIndexOf(':');
  return (colon > -1 && host.indexOf(':') === colon ? host.slice(0, colon) : host).toLowerCase();
}

/**
 * Without a token, the only protection is reachability. Restrict Host to IP
 * literals, localhost and the configured host so DNS-rebinding pages (whose
 * Origin would equal the rebound Host) cannot read or decide approvals.
 */
function hostAllowed(host: string | undefined, configured: string): boolean {
  if (!host) return false;
  const name = hostName(host);
  return isIP(name) !== 0 || name === 'localhost' || name === hostName(configured);
}

function originMatches(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try { return new URL(origin).host.toLowerCase() === host.toLowerCase(); }
  catch { return false; }
}

async function boundedText(request: Request, limit: number): Promise<string | undefined> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await request.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => undefined); return undefined; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return undefined; }
}

function parseDecision(text: string): HumanDecision | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'decision') return undefined;
  const decision = (value as { decision: unknown }).decision;
  return decision === 'allow' || decision === 'block' ? decision : undefined;
}

function secure(headers: Headers, nonce: string): void {
  headers.set('cache-control', 'no-store');
  headers.set('x-frame-options', 'DENY');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('cross-origin-resource-policy', 'same-origin');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('content-security-policy', [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '));
}

function json(context: Context, status: 200 | 400 | 401 | 403 | 404 | 413 | 415 | 500, body: unknown): Response {
  return context.json(body, status);
}

/**
 * Local approval UI/API. All subject fields are agent-derived and untrusted; the
 * page renders them with textContent only. The UI is assumed to be reachable only
 * by its operator; headers, CSRF checks and the optional token are cheap
 * defense in depth, not a multi-user authorization model. Action content is never logged.
 */
export function createApprovalApp(broker: ApprovalBroker, config: ApprovalConfig) {
  const app = new Hono<{ Variables: { nonce: string } }>();
  const expected = config.token === undefined ? undefined : digest(config.token);

  app.use('*', async (context, next) => {
    const nonce = randomBytes(18).toString('base64');
    context.set('nonce', nonce);
    if (expected === undefined && !hostAllowed(context.req.header('host'), config.host)) {
      const response = json(context, 403, { error: 'forbidden_host' });
      secure(response.headers, nonce);
      return response;
    }
    await next();
    secure(context.res.headers, nonce);
  });
  app.onError((_error, context) => json(context, 500, { error: 'internal_error' }));
  app.notFound((context) => json(context, 404, { error: 'not_found' }));

  app.use('/api/*', async (context, next) => {
    if (expected !== undefined && !tokenMatches(context.req.header('authorization'), expected)) {
      return json(context, 401, { error: 'unauthorized' });
    }
    // Browsers attach Sec-Fetch-Site/Origin; reject any cross-site caller.
    const site = context.req.header('sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return json(context, 403, { error: 'cross_site' });
    const origin = context.req.header('origin');
    if (origin !== undefined && !originMatches(origin, context.req.header('host'))) return json(context, 403, { error: 'cross_origin' });
    await next();
  });

  app.get('/', (context) => {
    return context.html(page(context.get('nonce')));
  });

  app.get('/api/pending', (context) => json(context, 200, { pending: broker.list(), recent: broker.recent(), now: Date.now() }));

  app.post('/api/approvals/:id', async (context) => {
    const mediaType = context.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    // A non-simple content type forces a CORS preflight, blocking cross-site form posts.
    if (mediaType !== 'application/json') {
      await context.req.raw.body?.cancel().catch(() => undefined);
      return json(context, 415, { error: 'unsupported_media_type' });
    }
    const text = await boundedText(context.req.raw, MAX_DECISION_BODY_BYTES);
    if (text === undefined) return json(context, 413, { error: 'invalid_body' });
    const decision = parseDecision(text);
    if (decision === undefined) return json(context, 400, { error: 'invalid_body' });
    const id = context.req.param('id');
    if (!ID_PATTERN.test(id) || !broker.decide(id, decision)) return json(context, 404, { error: 'not_found' });
    return json(context, 200, { ok: true });
  });

  return app;
}

/** Self-contained page; no external assets, no inline handlers, data via textContent only. */
function page(nonce: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Human approval · 人工审批</title>
<style nonce="${nonce}">
:root { --bg:#f6f7f9; --fg:#1b1f24; --muted:#5b6470; --card:#fff; --line:#d8dde3; --allow:#1f7a3a; --block:#b42318; --warn:#9a6700; }
@media (prefers-color-scheme: dark) { :root { --bg:#111418; --fg:#e6e9ed; --muted:#9aa4b1; --card:#1a1f25; --line:#2c333b; --allow:#3fb468; --block:#f0605a; --warn:#d4a72c; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
main { max-width:960px; margin:0 auto; padding:16px; }
h1 { font-size:20px; margin:8px 0 4px; }
h2 { font-size:16px; margin:24px 0 8px; }
.sub { color:var(--muted); margin:0 0 16px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin:0 0 12px; }
.row { display:flex; flex-wrap:wrap; gap:8px; align-items:baseline; justify-content:space-between; }
.tool { font-weight:600; font-size:15px; }
.badge { display:inline-block; padding:1px 8px; border-radius:10px; border:1px solid var(--line); color:var(--muted); font-size:12px; }
.expiry { color:var(--warn); font-variant-numeric:tabular-nums; }
dl { display:grid; grid-template-columns:max-content 1fr; gap:4px 12px; margin:8px 0; }
dt { color:var(--muted); }
dd { margin:0; min-width:0; overflow-wrap:anywhere; }
pre { margin:0; padding:8px; background:var(--bg); border:1px solid var(--line); border-radius:6px; white-space:pre-wrap; overflow-wrap:anywhere; max-height:320px; overflow:auto; font:12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.actions { display:flex; gap:8px; margin-top:10px; }
button { font:inherit; padding:6px 16px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; }
button.allow { border-color:var(--allow); color:var(--allow); }
button.block { border-color:var(--block); color:var(--block); }
button:disabled { opacity:.5; cursor:default; }
.empty, .status, .meta { color:var(--muted); }
.meta { font-size:12px; margin-top:2px; }
.meta.warn, .note.warn, .badge.warn { color:var(--warn); border-color:var(--warn); }
.redacted { color:var(--warn); border:1px dashed var(--warn); border-radius:3px; padding:0 2px; font-weight:600; }
.redaction-warning { margin:6px 0; padding:6px 8px; border:1px solid var(--warn); border-radius:6px; color:var(--warn); font-weight:600; }
.note { margin-top:8px; font-weight:600; }
.note.allow { color:var(--allow); } .note.block { color:var(--block); }
.card.done { opacity:.75; }
.r-allow { color:var(--allow); } .r-block, .r-timeout, .r-aborted { color:var(--block); }
#auth input { font:inherit; padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); width:min(360px, 100%); }
@media (max-width:560px) { dl { grid-template-columns:1fr; } dt { margin-top:4px; } }
</style>
</head>
<body>
<main>
<h1>Human approval · 人工审批</h1>
<p class="sub">Agent-proposed actions awaiting a decision. All shown content is untrusted agent output. · 待审批的智能体操作；所有内容均来自智能体，不可信。</p>
<div id="auth" class="card" hidden>
<p>Approval token required · 需要审批令牌</p>
<form id="auth-form"><input id="token" type="password" autocomplete="off" aria-label="token"> <button type="submit">Save · 保存</button></form>
</div>
<p id="status" class="status" role="status"></p>
<h2>Pending · 待审批</h2>
<div id="pending"><p id="pending-empty" class="empty">Nothing pending · 暂无待审批</p></div>
<h2>Recent decisions · 最近决定</h2>
<div id="recent"></div>
</main>
<script nonce="${nonce}">
(() => {
  'use strict';
  const KEY = 'amp-approval-token';
  // Buttons that just appeared or moved stay disabled briefly so a click aimed at
  // one action cannot land on another.
  const GUARD_MS = 800;
  let token = '';
  try { token = sessionStorage.getItem(KEY) || ''; } catch (e) { token = ''; }
  let offset = 0;
  let statusKind = '';
  let armedAt = 0;
  let recentKey = '';
  /** Pending cards keyed by id; built once and never re-rendered under the cursor. */
  const cards = new Map();
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  const headers = (extra) => {
    const h = Object.assign({}, extra || {});
    if (token) h.Authorization = 'Bearer ' + token;
    return h;
  };
  /** kind 'load' messages clear on the next successful load; decision messages persist. */
  const setStatus = (text, kind) => { $('status').textContent = text; statusKind = text ? (kind || '') : ''; };
  const ESCALATION = { 'gray-no-reviewer': 'First stage uncertain, no reviewer · 首阶段不确定，未配置复审', 'reviewer-uncertain': 'Reviewer uncertain · 复审模型不确定' };
  const RESULT = { allow: 'Approved · 已批准', block: 'Denied · 已拒绝', timeout: 'Timed out · 已超时', aborted: 'Cancelled · 已取消' };
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString();
  const remaining = (expires) => {
    const s = Math.max(0, Math.round((expires - (Date.now() + offset)) / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  // Controls (except newline/tab), bidi overrides/isolates, zero-width and other
  // invisible format characters can hide or reorder text; show them as escapes.
  const HIDDEN = /[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff9-\\ufffb\\u{e0000}-\\u{e0fff}]/gu;
  const hasHidden = (value) => { HIDDEN.lastIndex = 0; const found = HIDDEN.test(value); HIDDEN.lastIndex = 0; return found; };
  const visible = (value, multiline) => {
    let text = String(value).replace(HIDDEN, (c) => '⟨U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + '⟩');
    text = text.replace(/[ \\t]{16,}/g, (run) => ' ⟨' + run.length + ' spaces · 空白⟩ ');
    if (multiline) text = text.replace(/\\n{3,}/g, (run) => '\\n⟨' + (run.length - 1) + ' blank lines · 空行⟩\\n');
    else text = text.replace(/\\n/g, '⟨\\\\n⟩');
    return text;
  };
  // Redaction markers stand in for content that still executes; make each one stand out.
  const MARKER = /\\[REDACTED:[^\\]\\n]{0,64}\\]/g;
  const fill = (node, text) => {
    let last = 0;
    for (const match of text.matchAll(MARKER)) {
      if (match.index > last) node.appendChild(document.createTextNode(text.slice(last, match.index)));
      node.appendChild(el('span', 'redacted', match[0]));
      last = match.index + match[0].length;
    }
    if (last < text.length) node.appendChild(document.createTextNode(text.slice(last)));
    return node;
  };
  const field = (dl, label, value, pre) => {
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) return;
    const raw = String(value);
    dl.appendChild(el('dt', '', label));
    const dd = el('dd');
    if (pre) {
      const shown = visible(raw, true);
      dd.appendChild(fill(el('pre'), shown));
      const lines = raw.split('\\n').length;
      const meta = lines + ' lines · ' + raw.length + ' chars · ' + lines + ' 行 · ' + raw.length + ' 字符';
      const long = shown.split('\\n').length > 16 || shown.length > 1500;
      dd.appendChild(el('div', long ? 'meta warn' : 'meta', long ? meta + ' — scroll to read all · 请滚动查看全部' : meta));
    } else fill(dd, visible(raw, false));
    dl.appendChild(dd);
  };
  const probabilities = (p) => {
    if (!p || typeof p !== 'object') return '';
    return Object.keys(p).map((k) => k + '=' + String(p[k])).join(', ');
  };
  const details = (s) => {
    const dl = el('dl');
    field(dl, 'Command · 命令', Array.isArray(s.argv) ? JSON.stringify(s.argv) : undefined, true);
    field(dl, 'Text · 文本', s.text, true);
    field(dl, 'URL', s.url);
    field(dl, 'Paths · 路径', Array.isArray(s.paths) ? s.paths.join('\\n') : undefined, true);
    field(dl, 'Workdir · 工作目录', s.workdir);
    field(dl, 'Content · 内容摘录', s.content_excerpt, true);
    field(dl, s.arguments_truncated ? 'Arguments (truncated) · 参数（已截断）' : 'Arguments · 参数', s.arguments, true);
    field(dl, 'User request · 用户请求', s.user_request, true);
    field(dl, 'Route · 路由', [s.route, s.protocol].filter(Boolean).join(' · '));
    field(dl, 'Session · 会话', s.session_id);
    field(dl, 'Escalation · 升级原因', ESCALATION[s.escalation] || s.escalation);
    field(dl, 'First stage · 首阶段概率', probabilities(s.probabilities));
    field(dl, 'Reviewer · 复审理由', s.reviewer_reason, true);
    return dl;
  };
  const strings = (s) => [s.tool, s.kind, s.text, s.url, s.workdir, s.content_excerpt, s.arguments, s.user_request, s.route, s.session_id, s.reviewer_reason]
    .concat(Array.isArray(s.argv) ? s.argv : [], Array.isArray(s.paths) ? s.paths : []).filter((v) => typeof v === 'string');
  const updateButtons = () => {
    const now = Date.now();
    for (const c of cards.values()) {
      const enabled = c.state === 'pending' && now >= armedAt && now >= c.armedAt;
      c.allow.disabled = !enabled;
      c.block.disabled = !enabled;
    }
  };
  const guard = (card) => {
    const until = Date.now() + GUARD_MS;
    if (card) card.armedAt = until; else armedAt = until;
    updateButtons();
    setTimeout(updateButtons, GUARD_MS + 20);
  };
  const updateEmpty = () => { $('pending-empty').hidden = cards.size > 0; };
  const settle = (c, text, cls) => {
    c.state = 'done';
    c.card.className = 'card done';
    c.note.className = 'note ' + cls;
    c.note.textContent = text;
    c.expiry.textContent = '';
    c.dismiss.hidden = false;
    updateButtons();
  };
  const dismiss = (id) => {
    const c = cards.get(id);
    if (!c || c.state !== 'done') return;
    c.card.remove();
    cards.delete(id);
    updateEmpty();
    // Later cards just moved up under the pointer.
    guard();
  };
  const decide = async (id, decision) => {
    const c = cards.get(id);
    if (!c || c.state !== 'pending' || Date.now() < armedAt || Date.now() < c.armedAt) return;
    c.state = 'busy';
    updateButtons();
    try {
      const res = await fetch('api/approvals/' + encodeURIComponent(id), {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ decision }),
      });
      if (res.status === 401) { c.state = 'pending'; needToken(); }
      else if (res.status === 404) { settle(c, 'Already settled or expired · 已处理或已过期', 'warn'); setStatus(''); }
      else if (!res.ok) { c.state = 'pending'; setStatus('Decision failed · 提交失败 (' + res.status + ')', 'decision'); }
      else { settle(c, decision === 'allow' ? 'Approved by you · 你已批准' : 'Denied by you · 你已拒绝', decision); setStatus(''); }
    } catch (e) { c.state = 'pending'; setStatus('Network error · 网络错误', 'decision'); }
    updateButtons();
    await refresh();
  };
  const buildCard = (item) => {
    const s = item.subject || {};
    const card = el('section', 'card');
    const head = el('div', 'row');
    const title = el('div');
    title.appendChild(el('span', 'tool', visible(s.tool === undefined ? '' : s.tool, false)));
    title.appendChild(document.createTextNode(' '));
    title.appendChild(el('span', 'badge', visible(s.kind === undefined ? '' : s.kind, false)));
    if (strings(s).some(hasHidden)) {
      title.appendChild(document.createTextNode(' '));
      title.appendChild(el('span', 'badge warn', 'Hidden characters shown as ⟨U+…⟩ · 含隐藏字符'));
    }
    head.appendChild(title);
    const expiry = el('span', 'expiry', remaining(item.expires_at));
    head.appendChild(expiry);
    card.appendChild(head);
    if (s.redacted === true) card.appendChild(el('div', 'redaction-warning',
      'Redacted: some content is hidden here but WILL execute as the agent sent it. Approve only if the visible part is acceptable whatever the hidden part contains. · 已脱敏：部分内容在此被隐藏，但会按 agent 原样执行。仅当无论隐藏部分是什么、可见部分都可接受时才批准。'));
    card.appendChild(el('div', 'status', 'Requested · 请求时间 ' + fmtTime(item.created_at)));
    card.appendChild(details(s));
    const note = el('div', 'note');
    card.appendChild(note);
    const actions = el('div', 'actions');
    const allow = el('button', 'allow', 'Approve · 批准');
    const block = el('button', 'block', 'Deny · 拒绝');
    const dismissButton = el('button', 'dismiss', 'Dismiss · 移除');
    allow.type = 'button'; block.type = 'button'; dismissButton.type = 'button';
    dismissButton.hidden = true;
    const id = item.id;
    allow.addEventListener('click', () => decide(id, 'allow'));
    block.addEventListener('click', () => decide(id, 'block'));
    dismissButton.addEventListener('click', () => dismiss(id));
    actions.appendChild(allow); actions.appendChild(block); actions.appendChild(dismissButton);
    card.appendChild(actions);
    return { id, card, note, expiry, allow, block, dismiss: dismissButton, expires: Number(item.expires_at), state: 'pending', armedAt: 0 };
  };
  const renderPending = (list) => {
    const root = $('pending');
    const ids = new Set(list.map((item) => item.id));
    // A card that left the queue elsewhere stays in place until dismissed.
    for (const c of cards.values()) {
      if (c.state === 'pending' && !ids.has(c.id)) settle(c, 'No longer pending (timed out, cancelled or decided elsewhere) · 已不在待审批（超时、取消或已在别处处理）', 'warn');
    }
    for (const item of list) {
      if (!item || typeof item.id !== 'string' || cards.has(item.id)) continue;
      const c = buildCard(item);
      cards.set(c.id, c);
      root.appendChild(c.card);
      guard(c);
    }
    updateEmpty();
    updateButtons();
  };
  const renderRecent = (list) => {
    const key = list.map((item) => String(item.id) + ':' + String(item.result)).join(',');
    if (key === recentKey) return;
    recentKey = key;
    const root = $('recent');
    root.replaceChildren();
    if (!list.length) { root.appendChild(el('p', 'empty', 'None yet · 暂无')); return; }
    for (const item of list) {
      const s = item.subject || {};
      const card = el('div', 'card row');
      const left = el('div');
      left.appendChild(el('span', 'tool', visible(s.tool === undefined ? '' : s.tool, false)));
      left.appendChild(document.createTextNode(' '));
      left.appendChild(el('span', 'badge', visible(s.kind === undefined ? '' : s.kind, false)));
      const summary = Array.isArray(s.argv) ? s.argv.join(' ') : (s.text || s.url || (s.paths || []).join(', '));
      if (summary) {
        const shown = visible(summary, false);
        left.appendChild(el('div', 'status', shown.length > 200 ? shown.slice(0, 200) + ' … (truncated · 已截断)' : shown));
      }
      card.appendChild(left);
      const right = el('div');
      right.appendChild(el('span', 'r-' + String(item.result).replace(/[^a-z]/g, ''), RESULT[item.result] || item.result));
      right.appendChild(el('div', 'status', fmtTime(item.resolved_at)));
      card.appendChild(right);
      root.appendChild(card);
    }
  };
  const needToken = () => { $('auth').hidden = false; setStatus('Token required · 需要令牌', 'load'); };
  const refresh = async () => {
    try {
      const res = await fetch('api/pending', { credentials: 'same-origin', cache: 'no-store', headers: headers() });
      if (res.status === 401) { needToken(); return; }
      if (!res.ok) { setStatus('Load failed · 加载失败 (' + res.status + ')', 'load'); return; }
      const data = await res.json();
      $('auth').hidden = true;
      if (statusKind === 'load') setStatus('');
      offset = typeof data.now === 'number' ? data.now - Date.now() : 0;
      renderPending(Array.isArray(data.pending) ? data.pending : []);
      renderRecent(Array.isArray(data.recent) ? data.recent : []);
    } catch (e) { setStatus('Network error · 网络错误', 'load'); }
  };
  $('auth-form').addEventListener('submit', (event) => {
    event.preventDefault();
    token = $('token').value.trim();
    $('token').value = '';
    try { sessionStorage.setItem(KEY, token); } catch (e) { /* Per-tab memory only. */ }
    refresh();
  });
  setInterval(() => {
    for (const c of cards.values()) if (c.state !== 'done') c.expiry.textContent = remaining(c.expires);
    updateButtons();
  }, 1000);
  setInterval(refresh, 2000);
  refresh();
})();
</script>
</body>
</html>`;
}
