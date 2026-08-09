import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { resetPassthroughConfigCache } from '../../routes/anthropic.js';
import { mintDashboardToken } from '../helpers/auth.js';

// The wiring of the Anthropic passthrough lane into POST /v1/messages: the
// fork itself, the auth relaxation it requires, and byte-exact forwarding.
//
// The lib-level tests cover the pieces in isolation. What can only be asserted
// here is that they are connected in the right ORDER — the fork runs before
// schema validation, the caller's own credential survives the hop, and with the
// lane off nothing about the route changed.

const UPSTREAM = 'http://upstream.test';

let dashToken = '';

/** POST with a body we control byte-for-byte, so re-serialization is visible. */
async function postRaw(app: Express, path: string, rawJson: string, headers: Record<string, string>) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: rawJson,
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE or empty */ }
  return { status: res.status, headers: res.headers, text, body: json };
}

/**
 * Intercept calls to the configured passthrough base URL, recording the exact
 * bytes and headers we sent. Anything else falls through to the real fetch, so
 * the free-pool half of a test still reaches its own mock.
 */
function mockUpstream(reply: () => Response) {
  const origFetch = global.fetch;
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.startsWith(UPSTREAM)) {
      const raw = (init as RequestInit).body;
      calls.push({
        url: urlStr,
        body: raw instanceof Uint8Array ? Buffer.from(raw).toString('utf8') : String(raw ?? ''),
        headers: Object.fromEntries(
          Object.entries(((init as RequestInit).headers ?? {}) as Record<string, string>)
            .map(([k, v]) => [k.toLowerCase(), v]),
        ),
      });
      return reply();
    }
    return origFetch(url as any, init);
  });
  return calls;
}

const jsonReply = (body: object, status = 200) =>
  () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Mock the Groq upstream the free-pool half routes to. */
function mockGroq(response: any) {
  const origFetch = global.fetch;
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('api.groq.com')) {
      return { ok: true, json: () => Promise.resolve(response) } as any;
    }
    if (urlStr.startsWith(UPSTREAM)) throw new Error('passthrough taken for a subagent turn');
    return origFetch(url as any, init);
  });
}

const groqCompletion = (text: string) => ({
  id: 'chatcmpl-x', object: 'chat.completion', created: 1, model: 'openai/gpt-oss-120b',
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});

/** A caller credential that is NOT this server's unified key. */
const CALLER_KEY = 'sk-ant-caller-credential';

function enableLane() {
  process.env.HOST = '127.0.0.1';
  process.env.FREELLMAPI_ANTHROPIC_PASSTHROUGH = 'subagent-offload';
  process.env.FREELLMAPI_ANTHROPIC_BASE_URL = UPSTREAM;
  resetPassthroughConfigCache();
}

describe('Anthropic passthrough lane wired into POST /v1/messages', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(async () => {
    delete process.env.FREELLMAPI_ANTHROPIC_PASSTHROUGH;
    delete process.env.FREELLMAPI_ANTHROPIC_BASE_URL;
    delete process.env.HOST;
    resetPassthroughConfigCache();

    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    db.prepare('DELETE FROM rate_limit_usage').run();

    const server = app.listen(0);
    const addr = server.address() as any;
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dashToken}` },
      body: JSON.stringify({ platform: 'groq', key: 'gsk_passthrough_test', label: 't' }),
    });
    server.close();
    expect(res.status).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.FREELLMAPI_ANTHROPIC_PASSTHROUGH;
    delete process.env.FREELLMAPI_ANTHROPIC_BASE_URL;
    delete process.env.HOST;
    resetPassthroughConfigCache();
  });

  const body = (extra: object = {}) => ({
    model: 'claude-opus-5',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hi' }],
    ...extra,
  });

  const anthropicHeaders = (key: string) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' });

  // ── Lane off: nothing about the route changed ─────────────────────────────

  it('still requires the unified key when the lane is off', async () => {
    const res = await postRaw(app, '/v1/messages', JSON.stringify(body()), anthropicHeaders(CALLER_KEY));
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe('authentication_error');
  });

  it('keeps demanding the unified key when HOST is not loopback, even with the mode set', async () => {
    // The loopback guard forces the mode back to `off`, so the auth relaxation
    // it would have unlocked never applies. This is the control that makes
    // delegating authentication defensible at all.
    process.env.HOST = '0.0.0.0';
    process.env.FREELLMAPI_ANTHROPIC_PASSTHROUGH = 'subagent-offload';
    process.env.FREELLMAPI_ANTHROPIC_BASE_URL = UPSTREAM;
    resetPassthroughConfigCache();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const calls = mockUpstream(jsonReply({ ok: true }));
    const res = await postRaw(app, '/v1/messages', JSON.stringify(body()), anthropicHeaders(CALLER_KEY));

    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  // ── Lane on: passthrough half ─────────────────────────────────────────────

  it('forwards a non-subagent turn upstream without the unified key', async () => {
    enableLane();
    const upstreamBody = { id: 'msg_up', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'from anthropic' }] };
    const calls = mockUpstream(jsonReply(upstreamBody));

    const res = await postRaw(app, '/v1/messages', JSON.stringify(body()), anthropicHeaders(CALLER_KEY));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(upstreamBody);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${UPSTREAM}/v1/messages`);
    // The caller's own credential is what authenticates the upstream hop.
    expect(calls[0].headers['x-api-key']).toBe(CALLER_KEY);
  });

  it('forwards the body byte-exactly rather than re-serializing it', async () => {
    enableLane();
    const calls = mockUpstream(jsonReply({ ok: true }));
    // Pretty-printed, so a JSON.stringify round-trip would collapse the
    // whitespace and the assertion below would fail.
    const raw = JSON.stringify(body(), null, 2);

    await postRaw(app, '/v1/messages', raw, anthropicHeaders(CALLER_KEY));

    expect(calls[0].body).toBe(raw);
  });

  it('forwards a request our own schema would reject', async () => {
    enableLane();
    const calls = mockUpstream(jsonReply({ ok: true }));

    // No `messages` array at all. A relayed request is Anthropic's to validate.
    await postRaw(app, '/v1/messages', JSON.stringify({ model: 'claude-opus-5' }), anthropicHeaders(CALLER_KEY));

    expect(calls).toHaveLength(1);
  });

  it('relays the upstream status and body for an upstream error', async () => {
    enableLane();
    mockUpstream(jsonReply({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, 529));

    const res = await postRaw(app, '/v1/messages', JSON.stringify(body()), anthropicHeaders(CALLER_KEY));

    expect(res.status).toBe(529);
    expect(res.body.error.type).toBe('overloaded_error');
  });

  it('relays a streamed upstream response', async () => {
    enableLane();
    const sse = 'event: message_start\ndata: {"type":"message_start"}\n\n'
      + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    mockUpstream(() => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));

    const res = await postRaw(app, '/v1/messages', JSON.stringify(body({ stream: true })), anthropicHeaders(CALLER_KEY));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.text).toBe(sse);
  });

  it('answers 502 when the upstream hop itself fails', async () => {
    enableLane();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockUpstream(() => { throw new Error('ECONNREFUSED'); });

    const res = await postRaw(app, '/v1/messages', JSON.stringify(body()), anthropicHeaders(CALLER_KEY));

    expect(res.status).toBe(502);
    expect(res.body.error.type).toBe('api_error');
  });

  // ── Lane on: free-pool half ───────────────────────────────────────────────

  it('routes a marked subagent turn to the free pool instead of upstream', async () => {
    enableLane();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGroq(groqCompletion('from the free pool'));

    const res = await postRaw(
      app, '/v1/messages',
      JSON.stringify(body({ system: 'You are a subagent. cc_is_subagent=true' })),
      anthropicHeaders(CALLER_KEY),
    );

    expect(res.status).toBe(200);
    expect(res.body.content[0].text).toBe('from the free pool');
  });

  it('routes a turn marked only by the agent-id header to the free pool', async () => {
    enableLane();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGroq(groqCompletion('header-detected'));

    const res = await postRaw(app, '/v1/messages', JSON.stringify(body()), {
      ...anthropicHeaders(CALLER_KEY),
      'x-claude-code-agent-id': 'agent_123',
    });

    expect(res.status).toBe(200);
    expect(res.body.content[0].text).toBe('header-detected');
  });

  it('accepts the caller credential on /v1/messages/count_tokens while the lane is on', async () => {
    // Claude Code sizes context through this endpoint with the same credential
    // it uses for /messages, so relaxing auth on one and not the other would
    // 401 mid-session.
    enableLane();
    const res = await postRaw(app, '/v1/messages/count_tokens', JSON.stringify(body()), anthropicHeaders(CALLER_KEY));
    expect(res.status).toBe(200);
    expect(typeof res.body.input_tokens).toBe('number');
  });

  it('keeps a unified-key caller on the free pool instead of forwarding it', async () => {
    // The unified key means "use the free pool" and nothing else. Forwarding it
    // would 401 upstream — silently breaking every existing all-free client the
    // moment the lane is enabled — and would hand our own gateway credential to
    // a third party. mockGroq throws if the passthrough is taken.
    enableLane();
    mockGroq(groqCompletion('still pooled'));

    const res = await postRaw(app, '/v1/messages', JSON.stringify(body()), anthropicHeaders(getUnifiedApiKey()));

    expect(res.status).toBe(200);
    expect(res.body.content[0].text).toBe('still pooled');
  });
});
