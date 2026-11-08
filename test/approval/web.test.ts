import { Script } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalBroker, type ApprovalSubject } from '../../src/approval/broker.js';
import { createApprovalApp, MAX_DECISION_BODY_BYTES } from '../../src/approval/web.js';

const XSS = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
const subject: ApprovalSubject = {
  tool: XSS, kind: 'command', text: XSS, argv: ['sh', '-c', XSS], paths: [XSS], url: XSS, workdir: XSS,
  content_excerpt: XSS, user_request: XSS, route: XSS, protocol: 'anthropic-messages', session_id: XSS,
  probabilities: { risk: 0.5 }, escalation: 'gray-no-reviewer', reviewer_reason: XSS,
};
const HOST = '127.0.0.1:8485';
const brokers: ApprovalBroker[] = [];
afterEach(() => { for (const broker of brokers.splice(0)) broker.close(); });

function setup(token?: string, host = '127.0.0.1') {
  const broker = new ApprovalBroker({ timeout_ms: 60_000, max_pending: 10 });
  brokers.push(broker);
  return { broker, app: createApprovalApp(broker, { host, ...(token === undefined ? {} : { token }) }) };
}
function get(app: ReturnType<typeof setup>['app'], path: string, headers: Record<string, string> = {}) {
  return app.request(path, { headers: { host: HOST, ...headers } });
}
function post(app: ReturnType<typeof setup>['app'], id: string, body: string, headers: Record<string, string> = {}) {
  return app.request(`/api/approvals/${id}`, { method: 'POST', body, headers: { host: HOST, 'content-type': 'application/json', ...headers } });
}

describe('approval web API', () => {
  it('lists pending and recent approvals', async () => {
    const { broker, app } = setup();
    const result = broker.request(subject);
    const response = await get(app, '/api/pending');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json() as { pending: { id: string; subject: ApprovalSubject }[]; recent: unknown[]; now: number };
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0]!.subject).toEqual(subject);
    expect(body.recent).toEqual([]);
    expect(typeof body.now).toBe('number');
    broker.decide(body.pending[0]!.id, 'block');
    await result;
    const after = await (await get(app, '/api/pending')).json() as { pending: unknown[]; recent: { result: string }[] };
    expect(after.pending).toEqual([]);
    expect(after.recent.map(item => item.result)).toEqual(['block']);
  });

  it.each(['allow', 'block'] as const)('decides %s, then 404s once settled', async (decision) => {
    const { broker, app } = setup();
    const result = broker.request(subject);
    const id = broker.list()[0]!.id;
    const response = await post(app, id, JSON.stringify({ decision }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await result).toMatchObject({ status: 'decided', decision });
    expect((await post(app, id, JSON.stringify({ decision }))).status).toBe(404);
  });

  it('404s on an unknown id', async () => {
    const { app } = setup();
    expect((await post(app, '00000000-0000-4000-8000-000000000000', '{"decision":"allow"}')).status).toBe(404);
    expect((await post(app, 'not-a-uuid', '{"decision":"allow"}')).status).toBe(404);
    expect((await get(app, '/nope')).status).toBe(404);
  });

  it.each([
    '', 'null', '[]', '"allow"', '{}', '{"decision":"maybe"}', '{"decision":"ALLOW"}',
    '{"decision":"allow","extra":1}', '{"decision":true}', '{bad json',
  ])('400s an invalid body %j without settling', async (body) => {
    const { broker, app } = setup();
    void broker.request(subject);
    const id = broker.list()[0]!.id;
    expect((await post(app, id, body)).status).toBe(400);
    expect(broker.size).toBe(1);
  });

  it('rejects oversized bodies', async () => {
    const { broker, app } = setup();
    void broker.request(subject);
    const id = broker.list()[0]!.id;
    const body = JSON.stringify({ decision: 'allow', pad: 'x'.repeat(MAX_DECISION_BODY_BYTES) });
    expect((await post(app, id, body)).status).toBe(413);
    expect(broker.size).toBe(1);
  });

  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx'])('requires application/json, rejecting %s', async (type) => {
    const { broker, app } = setup();
    void broker.request(subject);
    const id = broker.list()[0]!.id;
    expect((await post(app, id, '{"decision":"allow"}', { 'content-type': type })).status).toBe(415);
    expect(broker.size).toBe(1);
  });

  it('accepts application/json with charset', async () => {
    const { broker, app } = setup();
    void broker.request(subject);
    const id = broker.list()[0]!.id;
    expect((await post(app, id, '{"decision":"allow"}', { 'content-type': 'application/json; charset=utf-8' })).status).toBe(200);
  });

  it('rejects a mismatched Origin or cross-site fetch metadata, accepts same origin', async () => {
    const { broker, app } = setup();
    void broker.request(subject);
    const id = broker.list()[0]!.id;
    expect((await post(app, id, '{"decision":"allow"}', { origin: 'http://evil.example' })).status).toBe(403);
    expect((await post(app, id, '{"decision":"allow"}', { origin: 'null' })).status).toBe(403);
    expect((await post(app, id, '{"decision":"allow"}', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await get(app, '/api/pending', { origin: 'http://evil.example' })).status).toBe(403);
    expect(broker.size).toBe(1);
    expect((await post(app, id, '{"decision":"allow"}', { origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
  });

  it('rejects DNS-rebinding Host names when no token is configured', async () => {
    const { app } = setup();
    expect((await get(app, '/api/pending', { host: 'rebind.example:8485' })).status).toBe(403);
    expect((await get(app, '/', { host: 'rebind.example:8485' })).status).toBe(403);
    expect((await get(app, '/api/pending', { host: 'localhost:8485' })).status).toBe(200);
    expect((await get(app, '/api/pending', { host: '[::1]:8485' })).status).toBe(200);
  });

  it('requires the Bearer token on /api/* when configured', async () => {
    const { broker, app } = setup('secret-token', '0.0.0.0');
    void broker.request(subject);
    const id = broker.list()[0]!.id;
    expect((await get(app, '/api/pending')).status).toBe(401);
    expect((await get(app, '/api/pending', { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await get(app, '/api/pending', { authorization: 'Bearer secret-token-longer' })).status).toBe(401);
    expect((await get(app, '/api/pending', { authorization: 'Basic secret-token' })).status).toBe(401);
    expect((await post(app, id, '{"decision":"allow"}')).status).toBe(401);
    expect(broker.size).toBe(1);
    expect((await get(app, '/api/pending', { authorization: 'Bearer secret-token' })).status).toBe(200);
    // With a token, any Host name is allowed (e.g. a LAN hostname).
    expect((await get(app, '/api/pending', { authorization: 'Bearer secret-token', host: 'approvals.lan:8485' })).status).toBe(200);
    expect((await post(app, id, '{"decision":"allow"}', { authorization: 'Bearer secret-token' })).status).toBe(200);
    // The static page carries no data and is served without the token.
    expect((await get(app, '/')).status).toBe(200);
  });
});

describe('approval web page', () => {
  it('sets a nonce CSP and defensive headers on every response', async () => {
    const { app } = setup();
    const first = await get(app, '/');
    const second = await get(app, '/');
    const csp = first.headers.get('content-security-policy') ?? '';
    const nonce = /script-src 'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(second.headers.get('content-security-policy')).not.toBe(csp);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    for (const response of [first, await get(app, '/api/pending'), await get(app, '/missing')]) {
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    }
    const html = await first.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
  });

  it('has no inline handlers, external assets or data-to-HTML sinks', async () => {
    const { app } = setup();
    const html = await (await get(app, '/')).text();
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\s(?:src|href)\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    expect(script.length).toBeGreaterThan(1000);
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'setAttribute(', '.style.']) {
      expect(script).not.toContain(sink);
    }
    expect(script).toContain('textContent');
    // Compile only (never run) to catch template-escaping mistakes in the inline script.
    expect(() => new Script(script)).not.toThrow();
  });

  it('never embeds agent-derived subject data in the page', async () => {
    const { broker, app } = setup();
    void broker.request(subject);
    const html = await (await get(app, '/')).text();
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('alert(');
  });
});
