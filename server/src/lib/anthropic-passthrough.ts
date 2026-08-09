// The Anthropic passthrough lane: forward a request upstream under the CALLER's
// own credential, storing nothing.
//
// This exists so subagent offload is possible at all. FreeLLMAPI otherwise has
// no outbound Anthropic provider — it accepts the Anthropic protocol inbound and
// maps it onto free OpenAI-compatible providers — so detecting a subagent would
// be useless on its own: the user's MAIN conversation would land on a free model
// too, which is the opposite of the intent.
//
// ⚠ Deliberately env-configured and default-off. This is a local-topology
// feature, not part of "pool the free tiers", and an accidental enable would
// silently start spending paid quota.

import type { Response as ExpressResponse } from 'express';
import { buildForwardHeaders } from './passthrough-auth.js';
import type { RequestHeaders } from './subagent-detect.js';

export const PASSTHROUGH_MODES = ['off', 'subagent-offload'] as const;
export type PassthroughMode = (typeof PASSTHROUGH_MODES)[number];

export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

export interface PassthroughConfig {
  mode: PassthroughMode;
  baseUrl: string;
}

/**
 * Read the lane's configuration from the environment.
 *
 * Unrecognized values resolve to `off` rather than throwing: a typo in `.env`
 * must not start forwarding traffic to a paid endpoint, and must not brick boot
 * either. `off` is the only safe interpretation of "I don't understand this".
 */
export function readPassthroughConfig(env: NodeJS.ProcessEnv = process.env): PassthroughConfig {
  const raw = env.FREELLMAPI_ANTHROPIC_PASSTHROUGH?.trim().toLowerCase();
  const mode: PassthroughMode = (PASSTHROUGH_MODES as readonly string[]).includes(raw ?? '')
    ? raw as PassthroughMode
    : 'off';

  const base = env.FREELLMAPI_ANTHROPIC_BASE_URL?.trim();
  const resolved: PassthroughConfig = { mode, baseUrl: normalizeBaseUrl(base) };

  // ⚠ The lane cannot demand FreeLLMAPI's unified key. In this topology the
  // client authenticates with its ANTHROPIC credential — that is what makes a
  // keyless passthrough possible — so the same request carries nothing we can
  // check, and free-pool requests from the same client carry it too. Auth is
  // therefore delegated to Anthropic for the passthrough half and implicitly
  // trusted for the free-pool half.
  //
  // That is only defensible on loopback. Bound to a routable address it is an
  // open relay: anyone who can reach the port can spend the free pool, and can
  // hand their own Anthropic key to whatever `baseUrl` points at. Refuse rather
  // than let a HOST change quietly convert a local convenience into one.
  if (resolved.mode !== 'off' && !isLoopbackHost(env.HOST)) {
    console.error(
      `[passthrough] REFUSING to enable "${resolved.mode}": HOST=${env.HOST ?? '(unset)'} is not loopback. `
      + 'This lane delegates authentication and would be an open relay. Set HOST=127.0.0.1.',
    );
    return { ...resolved, mode: 'off' };
  }

  return resolved;
}

/**
 * Whether the server is bound to loopback only. An unset HOST is NOT treated as
 * loopback — Express defaults to all interfaces, so the safe reading of "unset"
 * is "exposed".
 */
export function isLoopbackHost(host: string | undefined): boolean {
  const h = host?.trim().toLowerCase();
  if (!h) return false;
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

/**
 * Reject a base URL that is not http(s), and strip a trailing slash so path
 * concatenation cannot produce `//v1/messages`. An unparseable value falls back
 * to Anthropic rather than being concatenated blindly into a request URL.
 */
export function normalizeBaseUrl(value: string | undefined): string {
  if (!value) return DEFAULT_ANTHROPIC_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return DEFAULT_ANTHROPIC_BASE_URL;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return DEFAULT_ANTHROPIC_BASE_URL;
  return value.replace(/\/+$/, '');
}

/**
 * Whether this request should be forwarded upstream rather than routed to the
 * free pool.
 *
 * The polarity matters: in `subagent-offload` the SUBAGENT goes to the free pool
 * and everything else passes through. So a detection miss keeps the user's turn
 * on their paid model (correct but not thrifty), while a false positive would
 * downgrade a human conversation (wrong). Failing toward passthrough is the
 * conservative direction.
 */
export function shouldPassthrough(mode: PassthroughMode, isSubagent: boolean): boolean {
  if (mode === 'off') return false;
  return !isSubagent;
}

export interface ForwardResult {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

/**
 * Forward the buffered request upstream under the caller's own credential.
 *
 * `fetchFn` is injectable so the lane is testable without network access.
 * No credential is declared, so `buildForwardHeaders` forwards inbound auth
 * verbatim and injects nothing — the whole point of the lane.
 */
export async function forwardToAnthropic(
  args: {
    baseUrl: string;
    path: string;
    method: string;
    inboundHeaders: RequestHeaders;
    body: Buffer | string | undefined;
    signal?: AbortSignal;
  },
  fetchFn: typeof fetch = fetch,
): Promise<ForwardResult> {
  const headers = buildForwardHeaders(args.inboundHeaders);
  const init: RequestInit = { method: args.method, headers, signal: args.signal };
  if (args.body !== undefined && args.body.length > 0) {
    init.body = typeof args.body === 'string' ? args.body : new Uint8Array(args.body);
  }
  const res = await fetchFn(args.baseUrl + args.path, init);
  return { status: res.status, headers: res.headers, body: res.body };
}

/** Response headers that belong to the upstream hop, not to ours. */
const DROP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'content-encoding',
  'content-length', 'set-cookie',
]);

/**
 * Relay an upstream result onto the Express response, preserving status and
 * streaming bytes through unbuffered so SSE arrives incrementally.
 *
 * `content-encoding` and `content-length` are dropped because fetch has already
 * decompressed the body — forwarding them would describe bytes we are not
 * sending. `set-cookie` is dropped so an upstream cannot set cookies on our
 * origin.
 */
export async function relayResponse(res: ExpressResponse, upstream: ForwardResult): Promise<void> {
  upstream.headers.forEach((value, key) => {
    if (DROP_RESPONSE_HEADERS.has(key.toLowerCase())) return;
    res.setHeader(key, value);
  });
  res.status(upstream.status);

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        res.write(Buffer.from(value));
        // Force each SSE chunk out rather than letting it sit in a buffer; a
        // streamed agent turn that arrives in one lump at the end is a hang.
        (res as ExpressResponse & { flush?: () => void }).flush?.();
      }
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}
