import { describe, it, expect } from 'vitest';
import {
  readPassthroughConfig,
  normalizeBaseUrl,
  shouldPassthrough,
  forwardToAnthropic,
  isLoopbackHost,
  DEFAULT_ANTHROPIC_BASE_URL,
} from '../../lib/anthropic-passthrough.js';

const LOOPBACK = { HOST: '127.0.0.1' };

describe('config reads default-off', () => {
  it('is off when unset', () => {
    expect(readPassthroughConfig({}).mode).toBe('off');
  });

  it('accepts subagent-offload, case- and space-insensitively', () => {
    expect(readPassthroughConfig({ ...LOOPBACK, FREELLMAPI_ANTHROPIC_PASSTHROUGH: ' Subagent-Offload ' }).mode)
      .toBe('subagent-offload');
  });

  // A typo must not start spending paid quota, and must not brick boot either.
  it.each(['on', 'true', '1', 'yes', 'subagent', 'passthrough', ''])(
    'resolves unrecognized value %o to off', (value) => {
      expect(readPassthroughConfig({ ...LOOPBACK, FREELLMAPI_ANTHROPIC_PASSTHROUGH: value }).mode).toBe('off');
    });
});

// The lane delegates authentication, so off-loopback it is an open relay: anyone
// reaching the port could spend the free pool or hand their Anthropic key to
// whatever baseUrl points at.
describe('refuses to enable off-loopback', () => {
  it.each([
    ['unset', undefined],
    ['all interfaces', '0.0.0.0'],
    ['LAN address', '192.168.1.50'],
    ['any IPv6', '::'],
  ])('forces off when HOST is %s', (_label, host) => {
    const env = { FREELLMAPI_ANTHROPIC_PASSTHROUGH: 'subagent-offload' } as NodeJS.ProcessEnv;
    if (host !== undefined) env.HOST = host;
    expect(readPassthroughConfig(env).mode).toBe('off');
  });

  it.each(['127.0.0.1', 'localhost', '::1', '[::1]', ' 127.0.0.1 '])(
    'permits loopback HOST %o', (host) => {
      expect(isLoopbackHost(host)).toBe(true);
      expect(readPassthroughConfig({ HOST: host, FREELLMAPI_ANTHROPIC_PASSTHROUGH: 'subagent-offload' }).mode)
        .toBe('subagent-offload');
    });

  it('still reports the base URL even when it refuses to enable', () => {
    const cfg = readPassthroughConfig({
      HOST: '0.0.0.0',
      FREELLMAPI_ANTHROPIC_PASSTHROUGH: 'subagent-offload',
      FREELLMAPI_ANTHROPIC_BASE_URL: 'https://example.test',
    });
    expect(cfg.mode).toBe('off');
    expect(cfg.baseUrl).toBe('https://example.test');
  });
});

describe('base URL is validated, not concatenated blindly', () => {
  it('defaults to Anthropic', () => {
    expect(normalizeBaseUrl(undefined)).toBe(DEFAULT_ANTHROPIC_BASE_URL);
  });

  it('strips trailing slashes so paths cannot double up', () => {
    expect(normalizeBaseUrl('https://example.test/')).toBe('https://example.test');
    expect(normalizeBaseUrl('https://example.test///')).toBe('https://example.test');
  });

  it.each(['not a url', 'file:///etc/passwd', 'ftp://example.test', 'javascript:alert(1)'])(
    'rejects %o and falls back to Anthropic', (value) => {
      expect(normalizeBaseUrl(value)).toBe(DEFAULT_ANTHROPIC_BASE_URL);
    });

  it('allows http for a loopback relay', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
  });
});

describe('routing polarity', () => {
  it('never passes through when off, subagent or not', () => {
    expect(shouldPassthrough('off', false)).toBe(false);
    expect(shouldPassthrough('off', true)).toBe(false);
  });

  // In subagent-offload the SUBAGENT goes to the free pool and everything else
  // passes through, so a detection miss keeps the human's turn on their paid
  // model rather than silently downgrading it.
  it('offloads subagents and passes the human conversation through', () => {
    expect(shouldPassthrough('subagent-offload', true)).toBe(false);
    expect(shouldPassthrough('subagent-offload', false)).toBe(true);
  });
});

describe('forwarding carries the caller credential and nothing of ours', () => {
  function capturingFetch() {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { fn, calls };
  }

  it('forwards the inbound credential verbatim and injects none', async () => {
    const { fn, calls } = capturingFetch();
    await forwardToAnthropic({
      baseUrl: 'https://api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      inboundHeaders: { 'x-api-key': 'sk-ant-caller', 'anthropic-version': '2023-06-01' },
      body: Buffer.from('{"model":"claude-opus-5"}'),
    }, fn);

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers['x-api-key']).toBe('sk-ant-caller');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('strips our own control headers before they reach Anthropic', async () => {
    const { fn, calls } = capturingFetch();
    await forwardToAnthropic({
      baseUrl: 'https://api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      inboundHeaders: {
        'x-api-key': 'sk-ant-caller',
        'x-freellm-compress': 'aggressive',
        host: 'localhost:3001',
        'content-length': '25',
      },
      body: Buffer.from('{}'),
    }, fn);

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-freellm-compress']).toBeUndefined();
    expect(headers['host']).toBeUndefined();
    expect(headers['content-length']).toBeUndefined();
  });

  it('omits the body for a bodyless method rather than sending an empty one', async () => {
    const { fn, calls } = capturingFetch();
    await forwardToAnthropic({
      baseUrl: 'https://api.anthropic.com',
      path: '/v1/models',
      method: 'GET',
      inboundHeaders: { 'x-api-key': 'sk-ant-caller' },
      body: undefined,
    }, fn);
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it('surfaces the upstream status rather than normalizing it', async () => {
    const fn = (async () => new Response('nope', { status: 429 })) as unknown as typeof fetch;
    const out = await forwardToAnthropic({
      baseUrl: 'https://api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      inboundHeaders: {},
      body: Buffer.from('{}'),
    }, fn);
    expect(out.status).toBe(429);
  });
});
