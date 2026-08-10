import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

// Local reproduction of llm-relay's `routing.tiers`: a Claude family may map to
// an ORDERED POOL of model ids instead of a single pin. The difference that
// matters is the boundary — a pin only moves a model to the front of the whole
// chain, so a failed pin falls through to every other model in the catalog. A
// pool restricts the candidate set, which is the entire reason for writing a
// list in the first place.
//
// Scripted-provider mock, same pattern as responses-tool-args-repair.test.ts.
const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as any;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, getProvider: () => fakeProvider, resolveProvider: () => fakeProvider };
});

const { createApp } = await import('../../app.js');
const { initDb, getDb, getUnifiedApiKey } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { setRoutingStrategy } = await import('../../services/router.js');
const { setClaudeModelMap, getClaudeModelMap, classifyClaudeFamily } = await import('../../services/anthropic-map.js');
const { clearCooldownsForKey } = await import('../../services/ratelimit.js');

// Two real seeded Groq models, deliberately NOT the top of the priority chain,
// so "the pool was honored" cannot be confused with "the default order ran".
const POOL = ['llama-3.1-8b-instant', 'qwen/qwen3-32b'];

async function messages(app: Express, body: any, key: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], ...body }),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch { /* SSE */ }
  return { status: res.status, body: json, raw };
}

const textTurn = (text: string) => ({
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
});

/** Model ids the provider was actually asked for, in order. */
const dispatchedModels = () => chatCompletion.mock.calls.map(c => c[2]);

describe('Claude family pools (llm-relay routing.tiers equivalent)', () => {
  let app: Express;
  let key: string;
  let keyId: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();

    setRoutingStrategy('priority');
    const { encrypted, iv, authTag } = encrypt('test-key');
    const info = getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
    keyId = Number(info.lastInsertRowid);
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    const db = getDb();
    db.prepare("DELETE FROM settings WHERE key = 'anthropic_model_map'").run();
    // The failover tests below deliberately fail every attempt, which cools
    // down each model they touch. Deleting the table is NOT enough: the
    // authoritative cooldown map is in memory (services/ratelimit.ts), so a
    // DB-only reset leaves the next test routing against benched models and
    // exhausting into a 429 without dispatching at all.
    clearCooldownsForKey(keyId);
    db.prepare('DELETE FROM rate_limit_usage').run();
    db.prepare('DELETE FROM requests').run();
  });

  describe('the fable family', () => {
    it('classifies claude-fable-5 as its own family, not the catch-all', () => {
      expect(classifyClaudeFamily('claude-fable-5')).toBe('fable');
      expect(classifyClaudeFamily('claude-opus-5')).toBe('opus');
      // The planning alias is opus-ish by name and must still reach the
      // catch-all — pinning it to the opus pool would be wrong.
      expect(classifyClaudeFamily('opusplan')).toBe('default');
    });

    it('round-trips through the stored map', () => {
      setClaudeModelMap({ fable: 'llama-3.1-8b-instant' });
      expect(getClaudeModelMap().fable).toBe('llama-3.1-8b-instant');
      expect(getClaudeModelMap().opus).toBe('auto');
    });
  });

  describe('pool storage', () => {
    it('accepts and round-trips an ordered list', () => {
      setClaudeModelMap({ haiku: POOL });
      expect(getClaudeModelMap().haiku).toEqual(POOL);
    });

    it('rejects an empty list rather than storing a pool that can never serve', () => {
      expect(() => setClaudeModelMap({ haiku: [] })).toThrow();
    });

    it('degrades a malformed stored value to auto instead of throwing', () => {
      getDb().prepare(`
        INSERT INTO settings (key, value) VALUES ('anthropic_model_map', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(JSON.stringify({ haiku: [123, null] }));
      expect(getClaudeModelMap().haiku).toBe('auto');
    });
  });

  describe('routing', () => {
    it('serves the pool in declared order', async () => {
      setClaudeModelMap({ haiku: POOL });
      chatCompletion.mockResolvedValue(textTurn('from the pool'));

      const { status } = await messages(app, { model: 'claude-3-5-haiku-20241022' }, key);

      expect(status).toBe(200);
      expect(dispatchedModels()).toEqual(['llama-3.1-8b-instant']);
    });

    it('keeps failover INSIDE the pool and stops there', async () => {
      setClaudeModelMap({ haiku: POOL });
      chatCompletion.mockRejectedValue(new Error('Groq API error 500: upstream boom'));

      await messages(app, { model: 'claude-3-5-haiku-20241022' }, key);

      // The boundary: exactly the two members, in order, and nothing else —
      // where a single pin would have fallen through the whole Groq chain.
      expect(dispatchedModels()).toEqual(POOL);
    });

    it('falls through the whole chain for a single pin, showing the difference', async () => {
      setClaudeModelMap({ haiku: 'llama-3.1-8b-instant' });
      chatCompletion.mockRejectedValue(new Error('Groq API error 500: upstream boom'));

      await messages(app, { model: 'claude-3-5-haiku-20241022' }, key);

      const dispatched = dispatchedModels();
      expect(dispatched[0]).toBe('llama-3.1-8b-instant');
      expect(dispatched.length).toBeGreaterThan(POOL.length);
    });

    it('leaves other families on auto', async () => {
      setClaudeModelMap({ haiku: POOL });
      chatCompletion.mockResolvedValue(textTurn('from auto'));

      const { status } = await messages(app, { model: 'claude-sonnet-4-5' }, key);

      expect(status).toBe(200);
      expect(dispatchedModels()[0]).not.toBe(POOL[0]);
    });

    it('degrades to auto when every pool member is unknown or disabled', async () => {
      setClaudeModelMap({ haiku: ['no-such-model', 'also-not-real'] });
      chatCompletion.mockResolvedValue(textTurn('auto served it'));

      const { status, body } = await messages(app, { model: 'claude-3-5-haiku-20241022' }, key);

      // A stale map must not take the surface down — same graceful degradation
      // a dead single pin already had.
      expect(status).toBe(200);
      expect(body.content[0].text).toBe('auto served it');
    });

    // The catalog stores one row per (provider, model), so naming a model in a
    // pool has to mean "this model wherever it is served" — otherwise the id an
    // operator reads out of /v1/models resolves to nothing at all, because that
    // listing shows group slugs while `models.model_id` holds provider-native
    // spellings.
    it('expands one model name to every provider that serves it', async () => {
      const db = getDb();
      const { encrypted, iv, authTag } = encrypt('cerebras-key');
      db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES ('cerebras', 'test', ?, ?, ?, 'healthy', 1)
      `).run(encrypted, iv, authTag);
      try {
        // 'gpt-oss-120b' is a bare model_id on cerebras and the group slug for
        // groq's 'openai/gpt-oss-120b' — one name, two provider rows.
        setClaudeModelMap({ haiku: ['gpt-oss-120b'] });
        chatCompletion.mockRejectedValue(new Error('Groq API error 500: upstream boom'));

        await messages(app, { model: 'claude-3-5-haiku-20241022' }, key);

        const dispatched = dispatchedModels();
        expect(dispatched.length).toBeGreaterThan(1);
        // Every attempt is some spelling of the SAME model — the pool expanded
        // across providers rather than leaking into the rest of the catalog.
        expect(dispatched.every(m => m.includes('gpt-oss-120b'))).toBe(true);
      } finally {
        db.prepare("DELETE FROM api_keys WHERE platform = 'cerebras'").run();
      }
    });

    it('accepts a provider-qualified entry to pin one copy', async () => {
      setClaudeModelMap({ haiku: ['groq:openai/gpt-oss-120b'] });
      chatCompletion.mockRejectedValue(new Error('Groq API error 500: upstream boom'));

      await messages(app, { model: 'claude-3-5-haiku-20241022' }, key);

      expect(dispatchedModels()).toEqual(['openai/gpt-oss-120b']);
    });

    it('skips a disabled member but still honors the rest of the pool', async () => {
      getDb().prepare("UPDATE models SET enabled = 0 WHERE model_id = ?").run(POOL[0]);
      try {
        setClaudeModelMap({ haiku: POOL });
        chatCompletion.mockRejectedValue(new Error('Groq API error 500: upstream boom'));

        await messages(app, { model: 'claude-3-5-haiku-20241022' }, key);

        expect(dispatchedModels()).toEqual([POOL[1]]);
      } finally {
        getDb().prepare("UPDATE models SET enabled = 1 WHERE model_id = ?").run(POOL[0]);
      }
    });
  });
});
