import { describe, it, expect } from 'vitest';
import {
  buildForwardHeaders,
  credentialState,
  CredentialConfigError,
  INBOUND_AUTH,
} from '../../lib/passthrough-auth.js';

// The caller's own Anthropic credential, as Claude Code would send it.
const CALLER = { 'x-api-key': 'sk-ant-caller-secret', 'anthropic-version': '2023-06-01' };

describe('credentialState is declaration-driven', () => {
  it('undefined declaration is a passthrough regardless of any value', () => {
    expect(credentialState(undefined, undefined)).toBe('not-declared');
    expect(credentialState(undefined, 'a-key-that-should-be-ignored')).toBe('not-declared');
  });

  it('declared with a value is present; declared blank or whitespace is missing', () => {
    expect(credentialState('GROQ_KEY', 'abc')).toBe('declared-present');
    expect(credentialState('GROQ_KEY', '')).toBe('declared-missing');
    expect(credentialState('GROQ_KEY', '   ')).toBe('declared-missing');
    expect(credentialState('GROQ_KEY', undefined)).toBe('declared-missing');
  });
});

describe('passthrough forwards the caller credential', () => {
  it('forwards inbound auth verbatim and injects nothing', () => {
    const out = buildForwardHeaders(CALLER);
    expect(out['x-api-key']).toBe('sk-ant-caller-secret');
    expect(out['anthropic-version']).toBe('2023-06-01');
    expect(out['authorization']).toBeUndefined();
  });

  it('is credential-agnostic — a bearer token passes through untouched', () => {
    // This is what makes one lane serve both an API key and an OAuth
    // subscription: the relay never parses the credential, it just declines to
    // overwrite it.
    const out = buildForwardHeaders({ authorization: 'Bearer oauth-token' });
    expect(out['authorization']).toBe('Bearer oauth-token');
  });
});

describe('contained targets never see the caller credential', () => {
  it('strips every inbound auth header and injects the declared one', () => {
    const out = buildForwardHeaders(
      { ...CALLER, authorization: 'Bearer caller', 'api-key': 'caller-3' },
      { declaredCredential: 'GROQ_KEY', credentialValue: 'gsk-provider' },
    );
    expect(out['x-api-key']).toBe('gsk-provider');
    expect(out['authorization']).toBeUndefined();
    expect(out['api-key']).toBeUndefined();
  });

  it('injects into authorization as a Bearer when asked, without double-prefixing', () => {
    const bare = buildForwardHeaders({}, {
      declaredCredential: 'K', credentialValue: 'raw', authHeader: 'authorization',
    });
    expect(bare['authorization']).toBe('Bearer raw');

    const already = buildForwardHeaders({}, {
      declaredCredential: 'K', credentialValue: 'Bearer raw', authHeader: 'authorization',
    });
    expect(already['authorization']).toBe('Bearer raw');
  });

  it('forceContained strips inbound auth even with nothing declared', () => {
    const out = buildForwardHeaders(CALLER, { forceContained: true });
    expect(out['x-api-key']).toBeUndefined();
    expect(out['anthropic-version']).toBe('2023-06-01');
  });
});

// The regression this module exists for. llm-relay used `stripAuth = !!apiKey`,
// which is identically falsy for "not declared" (intentional passthrough) and
// "declared but unset" (misconfiguration) — so a misconfigured provider
// forwarded the caller's Anthropic token to a third-party base URL.
describe('declared-but-unset fails closed, and never leaks', () => {
  it('throws instead of silently degrading to passthrough', () => {
    expect(() => buildForwardHeaders(CALLER, {
      declaredCredential: 'GROQ_KEY',
      credentialValue: '',
      targetLabel: 'groq',
    })).toThrow(CredentialConfigError);
  });

  it('names the target so the misconfiguration is actionable', () => {
    expect(() => buildForwardHeaders(CALLER, {
      declaredCredential: 'GROQ_KEY', credentialValue: undefined, targetLabel: 'groq',
    })).toThrow(/groq/);
  });

  it('a blank declared credential is NOT treated as a passthrough', () => {
    // The distinction the boolean version collapsed.
    expect(credentialState('GROQ_KEY', '')).not.toBe(credentialState(undefined, ''));
  });
});

describe('header hygiene', () => {
  it('drops hop-by-hop and FreeLLMAPI-internal headers', () => {
    const out = buildForwardHeaders({
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
      host: 'localhost:3001',
      'content-length': '123',
      'x-freellm-compress': 'aggressive',
      'content-type': 'application/json',
    });
    for (const gone of ['connection', 'transfer-encoding', 'host', 'content-length', 'x-freellm-compress']) {
      expect(out[gone]).toBeUndefined();
    }
    expect(out['content-type']).toBe('application/json');
  });

  it('lowercases names and joins repeated values', () => {
    const out = buildForwardHeaders({ 'X-Custom': ['a', 'b'] });
    expect(out['x-custom']).toBe('a, b');
  });

  it('covers every INBOUND_AUTH name when contained', () => {
    const inbound = Object.fromEntries(INBOUND_AUTH.map(h => [h, 'caller-secret']));
    const out = buildForwardHeaders(inbound, { declaredCredential: 'K', credentialValue: 'v' });
    for (const h of INBOUND_AUTH) {
      if (h === 'x-api-key') continue; // replaced by the injected credential
      expect(out[h], `${h} must not survive containment`).toBeUndefined();
    }
    expect(out['x-api-key']).toBe('v');
  });
});
