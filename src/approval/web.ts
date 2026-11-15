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
 * Without a token (explicit require_token: false), the only protection is
 * reachability. Restrict Host to IP literals, localhost and the configured host so
 * DNS-rebinding pages (whose Origin would equal the rebound Host) cannot read or
 * decide approvals. With a token the check is skipped: a rebound origin cannot read
 * the token from this origin's sessionStorage, and operators may legitimately reach
 * a tokened listener through a hostname or reverse proxy.
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
 * by its operator. The token (required by default) is the credential that keeps
 * other local processes, including gated agents, from deciding approvals; headers
 * and CSRF checks are defense in depth, not a multi-user authorization model. Action content is never logged.
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
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Human approval · 人工审批</title>
<style nonce="${nonce}">
:root { color-scheme: light dark;
  --bg:#f6f7f9; --fg:#1b1f24; --muted:#5b6470; --card:#fff; --line:#d8dde3; --control-border:#8a939e;
  --allow:#1f7a3a; --block:#b42318; --warn:#8f5f00; --warn-bg:#fff8e5;
  --allow-bg:rgba(31,122,58,.06); --block-bg:rgba(180,35,24,.06);
  --mono:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
@media (prefers-color-scheme: dark) { :root {
  --bg:#111418; --fg:#e6e9ed; --muted:#9aa4b1; --card:#1a1f25; --line:#2c333b; --control-border:#6b7684;
  --allow:#3fb468; --block:#f0605a; --warn:#d4a72c; --warn-bg:#2a2410;
  --allow-bg:rgba(63,180,104,.08); --block-bg:rgba(240,96,90,.08); } }
* { box-sizing: border-box; }
[hidden] { display:none !important; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
main { max-width:960px; margin:0 auto; padding:16px; }
h1 { font-size:20px; margin:8px 0 4px; }
.sub { color:var(--muted); margin:0 0 16px; }
.sub span { display:block; }
.section-head { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:24px 0 8px; }
h2 { font-size:13px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin:0; }
h2 .badge { text-transform:none; letter-spacing:0; font-weight:600; vertical-align:1px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin:0 0 12px; }
.row { display:flex; flex-wrap:wrap; gap:8px; align-items:baseline; justify-content:space-between; }
.row > * { min-width:0; }
.head { align-items:flex-start; }
.title { flex:1 1 auto; min-width:0; }
.tool { font-weight:600; font-size:15px; }
h3.tool { display:inline; margin:0; }
.tool, .badge, .status { overflow-wrap:anywhere; }
.badge { display:inline-block; max-width:100%; padding:1px 8px; border-radius:10px; border:1px solid var(--line); color:var(--muted); font-size:12px; font-weight:400; }
.when { margin-left:auto; text-align:right; }
.expiry { margin-left:auto; white-space:nowrap; color:var(--muted); }
.expiry-label { color:var(--muted); font-weight:400; }
.expiry-time { font-variant-numeric:tabular-nums; }
.expiry.soon { color:var(--warn); }
.expiry.urgent { color:var(--block); font-weight:600; }
.expiry.expired { color:var(--block); font-weight:600; }
.card.stale .expiry, .card.stale .expiry.soon, .card.stale .expiry.urgent { color:var(--muted); font-weight:400; }
.requested { font-size:12px; color:var(--muted); font-variant-numeric:tabular-nums; white-space:nowrap; }
.group-label { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin:10px 0 0; }
.group.ctx { border-top:1px solid var(--line); padding-top:8px; margin-top:12px; }
.group.ctx .group-label { margin-top:0; }
dl { display:grid; grid-template-columns:11.5em minmax(0,1fr); gap:6px 12px; margin:6px 0 0; }
dt { color:var(--muted); overflow-wrap:anywhere; }
dd { margin:0; min-width:0; overflow-wrap:anywhere; }
.group.ctx dd { font-size:13px; color:var(--muted); }
.mono { font-family:var(--mono); font-size:13px; }
pre { margin:0; padding:8px 10px; background:var(--bg); border:1px solid var(--line); border-radius:6px; white-space:pre-wrap; overflow-wrap:anywhere; max-height:320px; overflow:auto; font:13px/1.5 var(--mono); }
pre.ctx { background:transparent; border:0; border-left:2px solid var(--line); border-radius:0; color:var(--muted); padding:0 0 0 10px; }
pre.expanded { max-height:none; }
.meta-row { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 12px; margin-top:2px; }
.meta { color:var(--muted); font-size:11px; }
.actions { display:flex; flex-wrap:wrap; align-items:center; gap:16px; margin-top:12px; padding-top:10px; border-top:1px solid var(--line); }
button { font:inherit; font-weight:600; min-height:36px; padding:7px 18px; border-radius:6px; border:1px solid var(--control-border); background:var(--card); color:var(--fg); cursor:pointer; }
button.allow { border-color:var(--allow); color:var(--allow); background:var(--allow-bg); }
button.block { border-color:var(--block); color:var(--block); background:var(--block-bg); }
button:disabled, button[aria-disabled="true"] { opacity:.5; cursor:not-allowed; }
button.dismiss, button.dismiss-all, button.expand { border:0; background:none; color:var(--muted); font-weight:400; min-height:0; padding:2px 4px; }
button.dismiss { margin-left:auto; }
button.dismiss-all { margin-left:auto; font-size:13px; }
button.expand { font-size:12px; }
button.dismiss:hover, button.dismiss-all:hover, button.expand:hover { color:var(--fg); text-decoration:underline; }
button:focus-visible, input:focus-visible, pre:focus-visible { outline:2px solid var(--fg); outline-offset:2px; }
@media (pointer:coarse), (max-width:560px) { .actions button { min-height:44px; } }
.empty { color:var(--muted); border:1px dashed var(--control-border); border-radius:8px; padding:16px; text-align:center; margin:0 0 12px; }
.status { color:var(--muted); }
.status:empty { display:none; }
#status:empty { margin:0; }
.meta.warn, .note.warn, .badge.warn, .empty.warn { color:var(--warn); border-color:var(--warn); }
.redacted { color:var(--warn); border:1px dashed var(--warn); border-radius:3px; padding:0 2px; font-weight:600; }
.redaction-warning { margin:10px 0 0; padding:8px 10px; border:1px solid var(--warn); border-radius:6px; background:var(--warn-bg); color:var(--fg); }
.redaction-warning .lead { display:block; color:var(--warn); font-weight:600; }
.note { margin-top:10px; font-weight:600; }
.note:empty { display:none; }
.note.allow { color:var(--allow); } .note.block { color:var(--block); }
.card.done { border-left:3px solid var(--line); }
.card.done-allow { border-left-color:var(--allow); } .card.done-block { border-left-color:var(--block); } .card.done-warn { border-left-color:var(--warn); }
.card.done .fields, .card.done .head { color:var(--muted); }
.recent-list { list-style:none; margin:0; padding:0 14px; background:var(--card); border:1px solid var(--line); border-radius:8px; }
.recent-row { display:flex; flex-wrap:wrap; gap:4px 12px; align-items:baseline; justify-content:space-between; padding:6px 0; border-top:1px solid var(--line); }
.recent-row:first-child { border-top:0; }
.recent-row > * { min-width:0; }
.recent-main { flex:1 1 14em; }
.recent-side { flex:0 0 auto; margin-left:auto; display:flex; gap:8px; align-items:baseline; }
.recent-time { color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; }
.summary { color:var(--muted); font:12px/1.5 var(--mono); overflow-wrap:anywhere; }
.badge.r-allow { color:var(--allow); border-color:var(--allow); background:var(--allow-bg); }
.badge.r-block { color:var(--block); border-color:var(--block); background:var(--block-bg); }
.badge.r-timeout, .badge.r-aborted { color:var(--muted); border-color:var(--control-border); }
#auth label { display:block; font-weight:600; }
.hint { color:var(--muted); font-size:12.5px; margin:2px 0 8px; }
.auth-row { display:flex; flex-wrap:wrap; gap:8px; }
#auth input { flex:1 1 220px; max-width:360px; min-height:36px; font:inherit; padding:6px 8px; border:1px solid var(--control-border); border-radius:6px; background:var(--card); color:var(--fg); }
.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
@media (max-width:560px) { dl { grid-template-columns:1fr; gap:2px; } dt { margin-top:6px; } .actions { gap:10px; } .actions button.allow, .actions button.block { flex:1 1 auto; padding:7px 10px; } }
</style>
</head>
<body>
<main>
<h1>Human approval · <span lang="zh-CN">人工审批</span></h1>
<p class="sub"><span>Agent-proposed actions awaiting a decision. All shown content is untrusted agent output.</span><span lang="zh-CN">待审批的智能体操作；所有内容均来自智能体，不可信。</span></p>
<div id="auth" class="card" hidden>
<form id="auth-form">
<label for="token">Approval token · <span lang="zh-CN">审批令牌</span></label>
<p class="hint">Set by human_approval.token in the gateway config; paste it here. · <span lang="zh-CN">令牌来自网关配置 human_approval.token，请粘贴到此处。</span></p>
<div class="auth-row"><input id="token" type="password" autocomplete="off"><button type="submit">Save · <span lang="zh-CN">保存</span></button></div>
</form>
</div>
<p id="status" class="status" role="status"></p>
<p id="announce" class="sr-only" role="status" aria-live="polite"></p>
<section aria-labelledby="pending-h">
<div class="section-head"><h2 id="pending-h" tabindex="-1">Pending · <span lang="zh-CN">待审批</span> <span id="pending-count" class="badge" hidden></span> <span id="conn" class="badge warn" hidden></span></h2><button id="dismiss-all" class="dismiss-all" type="button" hidden>Dismiss all settled · <span lang="zh-CN">移除全部已处理</span></button></div>
<div id="pending"><p id="pending-empty" class="empty">Loading… · <span lang="zh-CN">加载中…</span></p></div>
</section>
<section aria-labelledby="recent-h">
<div class="section-head"><h2 id="recent-h">Recent decisions · <span lang="zh-CN">最近决定</span></h2></div>
<div id="recent"></div>
</section>
</main>
<script nonce="${nonce}">
(() => {
  'use strict';
  const KEY = 'amp-approval-token';
  // Buttons that just appeared or moved stay inert briefly so a click aimed at one
  // action cannot land on another. The guard uses aria-disabled, not disabled: a
  // disabled button would lose keyboard focus, and decide() itself rejects the click.
  const GUARD_MS = 800;
  // Without a successful poll for this long, cards are shown as possibly out of date.
  const STALE_MS = 6000;
  const DECISION_TIMEOUT_MS = 10000;
  const GONE_MAX = 1000;
  const TITLE = 'Human approval · 人工审批';
  let token = '';
  try { token = sessionStorage.getItem(KEY) || ''; } catch (e) { token = ''; }
  // Convenience link form: #token=<value>. Fragments never reach the server or its
  // logs; the value moves into per-tab storage and the fragment is removed at once.
  try {
    const hash = typeof location === 'object' && location ? String(location.hash || '') : '';
    const match = /^#(?:.*&)?token=([^&]*)/.exec(hash);
    if (match) {
      let value = '';
      try { value = decodeURIComponent(match[1]).trim(); } catch (e) { value = ''; }
      if (typeof history === 'object' && history && typeof history.replaceState === 'function') {
        history.replaceState(null, '', String(location.pathname || '/') + String(location.search || ''));
      }
      if (value) {
        token = value;
        try { sessionStorage.setItem(KEY, token); } catch (e) { /* Per-tab memory only. */ }
      }
    }
  } catch (e) { /* Fall back to the prompt. */ }
  let offset = 0;
  let statusKind = '';
  let armedAt = 0;
  let recentKey = '';
  // Poll responses can arrive out of order; only the newest one issued is applied.
  let seq = 0;
  let applied = 0;
  let loaded = false;
  let lastFailed = false;
  let lastOkAt = 0;
  let stale = false;
  /** Pending cards keyed by id; built once and never re-rendered under the cursor. */
  const cards = new Map();
  /** Ids settled here; a stale response must never bring them back as pending. */
  const gone = new Set();
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  // Labels are written 'English · 中文'; Chinese segments are marked lang=zh-CN so a
  // screen reader uses a Chinese voice for them. Only page-authored text goes through
  // here; untrusted values are appended as plain text nodes.
  const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;
  const addBi = (node, text) => {
    String(text).split(' · ').forEach((part, i) => {
      if (i) node.appendChild(document.createTextNode(' · '));
      if (!part) return;
      if (HAN.test(part)) { const span = el('span', '', part); span.lang = 'zh-CN'; node.appendChild(span); }
      else node.appendChild(document.createTextNode(part));
    });
    return node;
  };
  const setBi = (node, text) => { node.textContent = ''; return addBi(node, text); };
  const bel = (tag, cls, text) => addBi(el(tag, cls), text);
  const isObj = (x) => x !== null && typeof x === 'object';
  const own = (map, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
  const headers = (extra) => {
    const h = Object.assign({}, extra || {});
    if (token) h.Authorization = 'Bearer ' + token;
    return h;
  };
  /** kind 'load' messages clear on the next successful load; decision messages persist. */
  const setStatus = (text, kind) => {
    const node = $('status');
    const changed = node.textContent !== text;
    setBi(node, text);
    statusKind = text ? (kind || '') : '';
    // The status line sits above the cards: any change moves them under the pointer.
    if (changed) guard();
  };
  /**
   * Polite screen-reader announcements, only for changes (never per poll or per second).
   * Messages from one pass are collected and spoken together; the region is cleared
   * first and filled in a later task so a repeated identical message is read again.
   * Parts: strings are page-authored bilingual labels; { raw } parts are untrusted values.
   */
  let spoken = [];
  let speaking = false;
  const announce = (...parts) => {
    const node = $('announce');
    if (!node || !parts.length) return;
    spoken.push(parts);
    if (speaking) return;
    speaking = true;
    node.textContent = '';
    setTimeout(() => {
      spoken.forEach((message, i) => {
        if (i) node.appendChild(document.createTextNode('; '));
        for (const part of message) {
          if (isObj(part)) node.appendChild(document.createTextNode(String(part.raw)));
          else addBi(node, part);
        }
      });
      spoken = [];
      speaking = false;
    }, 50);
  };
  const raw = (value) => ({ raw: value });
  const focusSafe = (node) => { if (node && typeof node.focus === 'function') node.focus(); };
  const ESCALATION = { 'gray-no-reviewer': 'First stage uncertain, no reviewer · 首阶段不确定，未配置复审', 'reviewer-uncertain': 'Reviewer uncertain · 复审模型不确定' };
  const RESULT = { allow: 'Approved · 已批准', block: 'Denied · 已拒绝', timeout: 'Timed out · 已超时', aborted: 'Cancelled · 已取消' };
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString();
  const left = (c) => c.expires - (Date.now() + offset);
  // NaN deadlines count as expired: the item can then only time out, which blocks.
  const expired = (c) => !(left(c) > 0);
  const clock = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
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
  /** Appends one dt/dd pair; returns 1 when it rendered. flags: mono, ctx, unit ('args'|'paths'), count. */
  const field = (dl, label, value, pre, flags) => {
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) return 0;
    const f = flags || {};
    const raw = String(value);
    dl.appendChild(bel('dt', '', label));
    const dd = el('dd', f.mono ? 'mono' : '');
    if (pre) {
      const shown = visible(raw, true);
      const base = f.ctx ? 'ctx' : '';
      const box = fill(el('pre', base), shown);
      box.tabIndex = 0;
      box.ariaLabel = label;
      box.translate = false;
      dd.appendChild(box);
      const lines = raw.split('\\n').length;
      const chars = [...raw].length;
      const long = shown.split('\\n').length > 16 || shown.length > 1500;
      if (long || lines > 1 || chars > 200) {
        let meta;
        if (f.unit === 'args') meta = plural(f.count, 'arg', 'args') + ' · ' + plural(chars, 'char', 'chars') + ' · ' + f.count + ' 个参数 · ' + chars + ' 字符';
        else if (f.unit === 'paths') meta = plural(f.count, 'path', 'paths') + ' · ' + f.count + ' 个路径';
        else meta = plural(lines, 'line', 'lines') + ' · ' + plural(chars, 'char', 'chars') + ' · ' + lines + ' 行 · ' + chars + ' 字符';
        const row = el('div', 'meta-row');
        const metaNode = bel('div', long ? 'meta warn' : 'meta', meta);
        if (long) { metaNode.appendChild(document.createTextNode(' — ')); addBi(metaNode, 'scroll to read all · 请滚动查看全部'); }
        row.appendChild(metaNode);
        if (long) {
          const expand = bel('button', 'expand', 'Show all · 展开全部');
          expand.type = 'button';
          let open = false;
          expand.addEventListener('click', () => {
            open = !open;
            box.className = open ? (base ? base + ' expanded' : 'expanded') : base;
            setBi(expand, open ? 'Collapse · 收起' : 'Show all · 展开全部');
            // Everything below just moved under the pointer.
            guard();
          });
          row.appendChild(expand);
        }
        dd.appendChild(row);
      }
    } else fill(dd, visible(raw, false));
    dl.appendChild(dd);
    return 1;
  };
  const probabilities = (p) => {
    if (!isObj(p)) return '';
    return Object.keys(p).map((k) => visible(k, false) + '=' + (Number.isFinite(p[k]) ? Number(p[k]).toFixed(2) : visible(String(p[k]), false))).join(', ');
  };
  const group = (cls, label, build) => {
    const dl = el('dl');
    if (!build(dl)) return undefined;
    const g = el('div', 'group ' + cls);
    g.appendChild(bel('div', 'group-label', label));
    g.appendChild(dl);
    return g;
  };
  const details = (s) => {
    const wrap = el('div', 'fields');
    const exec = group('exec', 'Will execute · 将执行', (dl) => {
      const argv = Array.isArray(s.argv) ? s.argv : undefined;
      return field(dl, 'Command · 命令', argv ? JSON.stringify(argv) : undefined, true, { unit: 'args', count: argv ? argv.length : 0 })
        + field(dl, 'Text · 文本', s.text, true)
        + field(dl, 'URL', s.url, false, { mono: true })
        + field(dl, 'Workdir · 工作目录', s.workdir, false, { mono: true })
        + field(dl, 'Paths · 路径', Array.isArray(s.paths) ? s.paths.join('\\n') : undefined, true, { unit: 'paths', count: Array.isArray(s.paths) ? s.paths.length : 0 })
        + field(dl, 'Content · 内容摘录', s.content_excerpt, true)
        + field(dl, s.arguments_truncated ? 'Arguments (truncated) · 参数（已截断）' : 'Arguments · 参数', s.arguments, true);
    });
    const ctx = group('ctx', 'Context · 上下文', (dl) =>
      field(dl, 'Escalation · 升级原因', own(ESCALATION, s.escalation) || s.escalation)
      + field(dl, 'First stage · 首阶段概率', probabilities(s.probabilities))
      + field(dl, 'Reviewer · 复审理由', s.reviewer_reason, true, { ctx: true })
      + field(dl, 'User request · 用户请求', s.user_request, true, { ctx: true })
      + field(dl, 'Route · 路由', [s.route, s.protocol].filter(Boolean).join(' · '))
      + field(dl, 'Session · 会话', s.session_id, false, { mono: true }));
    if (exec) wrap.appendChild(exec);
    if (ctx) wrap.appendChild(ctx);
    return wrap;
  };
  const strings = (s) => {
    const p = isObj(s.probabilities) ? s.probabilities : {};
    return [s.tool, s.kind, s.text, s.url, s.workdir, s.content_excerpt, s.arguments, s.user_request, s.route, s.protocol, s.session_id, s.escalation, s.reviewer_reason]
      .concat(Array.isArray(s.argv) ? s.argv : [], Array.isArray(s.paths) ? s.paths : [], Object.keys(p), Object.keys(p).map((k) => String(p[k])))
      .filter((v) => typeof v === 'string');
  };
  const live = (c) => c.state === 'pending' || c.state === 'busy';
  /**
   * Real disabled only for busy, settled and expired cards. During the guard window
   * the buttons are only marked aria-disabled, so a focused button keeps focus;
   * decide() rejects activation until the window ends.
   */
  const updateButtons = () => {
    const now = Date.now();
    for (const c of cards.values()) {
      const usable = c.state === 'pending' && !expired(c);
      const arming = usable && (now < armedAt || now < c.armedAt);
      for (const b of [c.allow, c.block]) {
        b.disabled = !usable;
        b.ariaDisabled = arming ? 'true' : 'false';
      }
    }
  };
  const guard = (card) => {
    const until = Date.now() + GUARD_MS;
    if (card) card.armedAt = until; else armedAt = until;
    updateButtons();
    setTimeout(updateButtons, GUARD_MS + 20);
  };
  const updateTitle = () => {
    if (typeof document.title !== 'string') return;
    let n = 0;
    for (const c of cards.values()) if (live(c)) n++;
    const attention = !$('auth').hidden || lastFailed || stale;
    document.title = (attention ? '(!) ' : n ? '(' + n + ') ' : '') + TITLE;
  };
  /** Everything in the pending section above or between cards whose size can change. */
  const layoutKey = () => {
    const empty = $('pending-empty');
    const count = $('pending-count');
    return [empty.hidden, empty.textContent, count.hidden, count.textContent.length, $('dismiss-all').hidden].join('|');
  };
  const updateEmpty = () => {
    const before = layoutKey();
    const empty = $('pending-empty');
    empty.hidden = cards.size > 0;
    if (lastFailed) {
      empty.className = 'empty warn';
      setBi(empty, 'Not connected — pending status unknown · 未连接，待审批状态未知');
    } else if (loaded) {
      empty.className = 'empty';
      setBi(empty, 'Nothing pending · 暂无待审批');
    }
    let n = 0, done = 0, busy = 0;
    for (const c of cards.values()) {
      if (live(c)) n++;
      if (c.state === 'done') done++;
      if (c.state === 'busy') busy++;
    }
    const count = $('pending-count');
    count.textContent = n ? String(n) : '';
    count.hidden = n === 0;
    $('dismiss-all').hidden = !(done > 0 && busy === 0);
    if (layoutKey() !== before) guard();
    updateTitle();
  };
  const updateStale = () => {
    const next = loaded && (lastFailed || Date.now() - lastOkAt > STALE_MS);
    const conn = $('conn');
    const at = next ? fmtTime(lastOkAt) : '';
    const text = next ? 'Connection lost · 连接中断 — last updated · 最后更新 ' + at : '';
    // The badge sits in the heading above the cards; showing or changing it can reflow them.
    const moved = conn.hidden !== !next || conn.textContent !== text;
    conn.hidden = !next;
    if (conn.textContent !== text) {
      conn.textContent = '';
      if (next) { addBi(conn, 'Connection lost · 连接中断'); conn.appendChild(document.createTextNode(' — ')); addBi(conn, 'last updated · 最后更新 ' + at); }
    }
    if (moved) guard();
    if (next !== stale) {
      stale = next;
      for (const c of cards.values()) if (c.state !== 'done') c.card.className = stale ? 'card stale' : 'card';
      updateTitle();
    }
  };
  const updateExpiry = (c) => {
    if (expired(c)) {
      c.expiry.className = 'expiry expired';
      c.expiryLabel.textContent = '';
      setBi(c.expiryTime, 'Expired · 已过期');
      return;
    }
    const ms = left(c);
    c.expiry.className = ms <= 30500 ? 'expiry urgent' : ms <= 120500 ? 'expiry soon' : 'expiry';
    if (!c.expiryLabel.textContent) setBi(c.expiryLabel, 'Expires in · 剩余 ');
    c.expiryTime.textContent = clock(ms);
    if (c.state === 'pending' && !c.warned && ms <= 60500) {
      c.warned = true;
      announce(raw(c.name + ' '), 'expires in 1 minute · 1 分钟后过期');
    }
  };
  /**
   * True when focus is inside this card, or (dropped) was lost to the page, as when the
   * focused decision button was just disabled. Focus elsewhere is never taken away.
   */
  const focusIn = (c, dropped) => {
    const active = document.activeElement;
    if (!active || active === document.body) return dropped;
    return typeof c.card.contains === 'function' && c.card.contains(active);
  };
  /** Focuses the card's note (never a decision button), so its text is read in context. */
  const focusNote = (c) => { c.note.tabIndex = -1; focusSafe(c.note); };
  /** spoken: shorter text for the announcement; the tool name is always prefixed. */
  const settle = (c, text, cls, mine, spokenText) => {
    // Checked before the buttons are disabled, which drops focus to the page.
    const keep = focusIn(c, mine);
    c.state = 'done';
    c.card.className = 'card done done-' + cls;
    c.card.ariaBusy = 'false';
    c.note.className = 'note ' + cls;
    setBi(c.note, text);
    c.expiry.hidden = true;
    c.dismiss.hidden = false;
    gone.add(c.id);
    if (gone.size > GONE_MAX) gone.delete(gone.values().next().value);
    updateButtons();
    updateEmpty();
    // The head (expiry) and note changed size, so every later card moved.
    guard();
    if (keep) focusNote(c);
    // A focused note is already read out; announce only otherwise.
    if (!keep) announce(raw(c.name ? c.name + ': ' : ''), spokenText || text);
  };
  const dismiss = (id) => {
    const c = cards.get(id);
    if (!c || c.state !== 'done') return;
    c.card.remove();
    cards.delete(id);
    updateEmpty();
    // Later cards just moved up under the pointer.
    guard();
    focusSafe($('pending-h'));
  };
  const dismissAll = () => {
    const list = Array.from(cards.values());
    if (list.some((c) => c.state === 'busy')) return;
    for (const c of list) if (c.state === 'done') { c.card.remove(); cards.delete(c.id); }
    updateEmpty();
    guard();
    focusSafe($('pending-h'));
  };
  const needToken = (rejected) => {
    const auth = $('auth');
    const opening = auth.hidden;
    auth.hidden = false;
    setStatus(rejected ? 'Token rejected · 令牌无效' : 'Token required · 需要令牌', 'load');
    if (opening) { guard(); focusSafe($('token')); }
    updateTitle();
  };
  const decide = async (id, decision) => {
    const c = cards.get(id);
    if (!c || c.state !== 'pending' || expired(c) || Date.now() < armedAt || Date.now() < c.armedAt) return;
    c.state = 'busy';
    c.card.ariaBusy = 'true';
    c.note.className = 'note';
    setBi(c.note, decision === 'allow' ? 'Submitting approval… · 正在提交批准…' : 'Submitting denial… · 正在提交拒绝…');
    // The note just appeared: later cards moved.
    guard();
    updateEmpty();
    const sent = token;
    const init = {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ decision }),
    };
    let finished = false;
    if (typeof AbortController === 'function') {
      const controller = new AbortController();
      init.signal = controller.signal;
      setTimeout(() => { if (!finished) controller.abort(); }, DECISION_TIMEOUT_MS);
    }
    let res;
    try { res = await fetch('api/approvals/' + encodeURIComponent(id), init); } catch (e) { res = undefined; }
    finished = true;
    const fail = (text) => {
      c.state = 'pending';
      c.card.ariaBusy = 'false';
      c.note.className = 'note warn';
      setBi(c.note, text);
      setStatus(text, 'decision');
      // The note changed size, so later cards moved too; disarm all of them.
      guard();
      updateEmpty();
      // Keep a keyboard or screen-reader user on this card, reading the failure.
      if (focusIn(c, true)) focusNote(c);
    };
    if (!res) fail('Network error — the decision may or may not have been recorded; check Recent · 网络错误，决定可能已生效，请查看最近决定');
    else if (res.status === 401) { fail('Not submitted: token required · 未提交：需要令牌'); needToken(sent !== ''); }
    else if (res.status === 404) { settle(c, 'Already settled or expired · 已处理或已过期', 'warn', true); setStatus(''); }
    else if (!res.ok) fail('Not submitted, still pending · 未提交，仍待审批 (HTTP ' + res.status + ')');
    else {
      c.note.textContent = '';
      settle(c, decision === 'allow' ? 'Approved by you · 你已批准' : 'Denied by you · 你已拒绝', decision, true);
      setStatus('');
    }
    updateButtons();
    await refresh();
  };
  const decisionButton = (cls, label, sr) => {
    const b = bel('button', cls, label);
    b.type = 'button';
    b.appendChild(el('span', 'sr-only', sr));
    return b;
  };
  const buildCard = (item) => {
    const s = isObj(item.subject) ? item.subject : {};
    const name = visible(s.tool === undefined ? '' : s.tool, false);
    const kind = visible(s.kind === undefined ? '' : s.kind, false);
    const card = el('section', stale ? 'card stale' : 'card');
    const head = el('div', 'row head');
    const title = el('div', 'title');
    title.appendChild(el('h3', 'tool', name));
    title.appendChild(document.createTextNode(' '));
    title.appendChild(el('span', 'badge', kind));
    if (strings(s).some(hasHidden)) {
      title.appendChild(document.createTextNode(' '));
      title.appendChild(bel('span', 'badge warn', 'Hidden characters shown as ⟨U+…⟩ · 含隐藏字符'));
    }
    head.appendChild(title);
    const when = el('div', 'when');
    const expiry = el('div', 'expiry');
    const expiryLabel = el('span', 'expiry-label');
    const expiryTime = el('span', 'expiry-time');
    expiry.appendChild(expiryLabel);
    expiry.appendChild(expiryTime);
    when.appendChild(expiry);
    when.appendChild(bel('div', 'requested', 'Requested · 请求时间 ' + fmtTime(Number(item.created_at) - offset)));
    head.appendChild(when);
    card.appendChild(head);
    if (s.redacted === true) {
      const warning = el('div', 'redaction-warning');
      warning.appendChild(bel('span', 'lead', 'Redacted — hidden content WILL execute · 已脱敏——隐藏内容会执行'));
      warning.appendChild(bel('span', '', 'Some content is hidden here but WILL execute as the agent sent it. Approve only if the visible part is acceptable whatever the hidden part contains. · 部分内容在此被隐藏，但会按 agent 原样执行。仅当无论隐藏部分是什么、可见部分都可接受时才批准。'));
      card.appendChild(warning);
    }
    card.appendChild(details(s));
    const note = el('div', 'note');
    card.appendChild(note);
    const actions = el('div', 'actions');
    const sr = ' — ' + name + ' (' + kind + ')';
    const block = decisionButton('block', 'Deny · 拒绝', sr);
    const allow = decisionButton('allow', 'Approve & run · 批准并执行', sr);
    const dismissButton = bel('button', 'dismiss', 'Dismiss · 移除');
    dismissButton.type = 'button';
    dismissButton.hidden = true;
    const id = item.id;
    allow.addEventListener('click', () => decide(id, 'allow'));
    block.addEventListener('click', () => decide(id, 'block'));
    dismissButton.addEventListener('click', () => dismiss(id));
    actions.appendChild(block); actions.appendChild(allow); actions.appendChild(dismissButton);
    card.appendChild(actions);
    const c = { id, name, card, note, expiry, expiryLabel, expiryTime, allow, block, dismiss: dismissButton,
      expires: Number(item.expires_at), state: 'pending', armedAt: 0, warned: false };
    // Only a crossing of the one-minute mark is announced, not an arrival below it.
    c.warned = left(c) <= 60500;
    updateExpiry(c);
    return c;
  };
  const renderPending = (input) => {
    const list = input.filter(isObj);
    const root = $('pending');
    const ids = new Set(list.map((item) => item.id));
    // A card that left the queue elsewhere stays in place until dismissed.
    for (const c of cards.values()) {
      if (c.state === 'pending' && !ids.has(c.id)) settle(c, 'No longer pending (timed out, cancelled or decided elsewhere) · 已不在待审批（超时、取消或已在别处处理）', 'warn', false, 'No longer pending · 已不在待审批');
    }
    const added = [];
    let failed = false;
    for (const item of list) {
      if (typeof item.id !== 'string' || cards.has(item.id) || gone.has(item.id)) continue;
      let c;
      // A card that cannot be built is skipped; its item times out to a block.
      try { c = buildCard(item); } catch (e) { failed = true; continue; }
      cards.set(c.id, c);
      root.appendChild(c.card);
      guard(c);
      added.push(c.name);
    }
    if (failed) setStatus('Some items could not be displayed · 部分项目无法显示', 'load');
    if (added.length) {
      announce(added.length + ' new pending · 新增 ' + added.length + ' 项待审批', ': ', raw(added.slice(0, 5).join(', ') + (added.length > 5 ? ', …' : '')));
    }
    updateEmpty();
    updateButtons();
  };
  const summaryOf = (s) => {
    if (Array.isArray(s.argv)) return JSON.stringify(s.argv);
    const candidates = [s.text, s.url, Array.isArray(s.paths) ? s.paths.join(', ') : '', s.arguments, s.content_excerpt];
    for (const v of candidates) if (typeof v === 'string' && v) return v;
    return '';
  };
  const recentRow = (item) => {
    const s = isObj(item.subject) ? item.subject : {};
    const row = el('li', 'recent-row');
    const main = el('div', 'recent-main');
    main.appendChild(el('span', 'tool', visible(s.tool === undefined ? '' : s.tool, false)));
    main.appendChild(document.createTextNode(' '));
    main.appendChild(el('span', 'badge', visible(s.kind === undefined ? '' : s.kind, false)));
    if (strings(s).some(hasHidden)) {
      main.appendChild(document.createTextNode(' '));
      main.appendChild(bel('span', 'badge warn', 'Hidden characters · 含隐藏字符'));
    }
    if (s.redacted === true) {
      main.appendChild(document.createTextNode(' '));
      main.appendChild(bel('span', 'badge warn', 'Redacted · 已脱敏'));
    }
    const raw = summaryOf(s);
    if (raw) {
      // Truncate by code points before escaping, so an escape is never split.
      const points = [...raw];
      const line = fill(el('div', 'summary'), visible(points.slice(0, 200).join(''), false));
      if (points.length > 200) addBi(line, ' … (truncated · 已截断)');
      main.appendChild(line);
    }
    row.appendChild(main);
    const side = el('div', 'recent-side');
    const result = String(item.result);
    const known = own(RESULT, item.result);
    const badge = el('span', 'badge r-' + result.replace(/[^a-z]/g, ''));
    if (known) addBi(badge, known); else badge.textContent = visible(result, false);
    side.appendChild(badge);
    if (Number.isFinite(item.resolved_at)) side.appendChild(el('span', 'recent-time', fmtTime(item.resolved_at)));
    row.appendChild(side);
    return row;
  };
  const renderRecent = (input) => {
    const list = input.filter(isObj);
    const key = list.map((item) => String(item.id) + ':' + String(item.result)).join(',');
    if (key === recentKey) return;
    recentKey = key;
    const root = $('recent');
    root.replaceChildren();
    if (!list.length) { root.appendChild(bel('p', 'empty', 'None yet · 暂无')); return; }
    const ul = el('ul', 'recent-list');
    for (const item of list) {
      try { ul.appendChild(recentRow(item)); } catch (e) { /* Skip an undisplayable entry. */ }
    }
    root.appendChild(ul);
  };
  const failLoad = (text) => {
    lastFailed = true;
    if (text) setStatus(text, 'load');
    updateStale();
    updateEmpty();
  };
  const refresh = async () => {
    const mine = ++seq;
    const sent = token;
    let data;
    try {
      const res = await fetch('api/pending', { credentials: 'same-origin', cache: 'no-store', headers: headers() });
      if (mine < applied) return;
      if (res.status === 401) { applied = mine; needToken(sent !== ''); failLoad(''); return; }
      if (!res.ok) { applied = mine; failLoad('Load failed · 加载失败 (' + res.status + ')'); return; }
      data = await res.json();
    } catch (e) {
      if (mine < applied) return;
      applied = mine;
      failLoad('Network error · 网络错误');
      return;
    }
    if (mine < applied) return;
    applied = mine;
    if (!isObj(data)) data = {};
    loaded = true;
    lastFailed = false;
    lastOkAt = Date.now();
    if (!$('auth').hidden) { $('auth').hidden = true; guard(); }
    if (statusKind === 'load') setStatus('');
    offset = Number.isFinite(data.now) ? data.now - Date.now() : 0;
    renderPending(Array.isArray(data.pending) ? data.pending : []);
    renderRecent(Array.isArray(data.recent) ? data.recent : []);
    updateStale();
    updateEmpty();
  };
  $('auth-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $('token').value.trim();
    $('token').value = '';
    if (!value) return;
    token = value;
    try { sessionStorage.setItem(KEY, token); } catch (e) { /* Per-tab memory only. */ }
    refresh();
  });
  $('dismiss-all').addEventListener('click', dismissAll);
  setInterval(() => {
    for (const c of cards.values()) {
      if (c.state === 'done') continue;
      const was = c.expiry.className === 'expiry expired';
      updateExpiry(c);
      // "Expired" replaces the countdown and can change the head's height.
      if (!was && c.expiry.className === 'expiry expired') guard();
    }
    updateStale();
    updateButtons();
  }, 1000);
  setInterval(refresh, 2000);
  refresh();
})();
</script>
</body>
</html>`;
}
