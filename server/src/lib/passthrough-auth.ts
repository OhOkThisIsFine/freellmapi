// Credential handling for the Anthropic passthrough lane.
//
// FreeLLMAPI's normal model is CONTAINED: every provider has its own key stored
// encrypted in the DB, and the caller's inbound credential (the unified key) is
// never forwarded anywhere. The passthrough lane is the one exception — it
// forwards a request to Anthropic under the CALLER's own credential, so nothing
// Anthropic-shaped is ever stored here.
//
// ⚠ The single invariant this module exists to enforce: containment is DECLARED,
// never inferred from whether a key happens to be present. llm-relay shipped the
// inferred version (`stripAuth = !!apiKey`) and it was a credential leak — that
// expression is identically falsy for two OPPOSITE configurations:
//
//   * "no credential declared"     → an intentional passthrough; forward inbound auth
//   * "credential declared but unset" → a misconfiguration; forward nothing
//
// so in the second case the caller's Anthropic token was forwarded verbatim to a
// third-party base URL. FreeLLMAPI is more exposed than llm-relay ever was: every
// provider here is a third-party free endpoint, so the same bug would deliver an
// Anthropic credential to Groq or NVIDIA. Hence an explicit enum with no boolean
// coercion anywhere, and `declared-missing` failing closed instead of falling back.

/**
 * Whether a target's own credential is declared, and if so whether it is usable.
 * Derived from configuration ONLY. Never from key presence — see the header note.
 */
export type CredentialState = 'not-declared' | 'declared-present' | 'declared-missing';

export class CredentialConfigError extends Error {
  constructor(public readonly target: string) {
    super(`${target}: credential is declared but unset — refusing to forward the caller's own`);
    this.name = 'CredentialConfigError';
  }
}

/**
 * Classify a target's credential from its DECLARATION plus the declared value.
 *
 * `declared` is the configuration answer to "does this target carry its own
 * credential?". Passing `undefined` means the target is a passthrough. Passing a
 * name with a blank/absent value is a misconfiguration, NOT a passthrough.
 */
export function credentialState(declared: string | undefined, value: string | undefined): CredentialState {
  if (declared === undefined) return 'not-declared';
  return (value ?? '').trim().length > 0 ? 'declared-present' : 'declared-missing';
}

/** Hop-by-hop headers: meaningful to one connection only, never forwarded. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

/**
 * Inbound credential headers. Stripped whenever the target is contained, so a
 * caller's key cannot ride along to a provider that has its own.
 */
export const INBOUND_AUTH = ['authorization', 'x-api-key', 'api-key', 'proxy-authorization'];

/** FreeLLMAPI's own control headers — consumed here, never forwarded upstream. */
function isInternalHeader(key: string): boolean {
  return key.startsWith('x-freellm');
}

export interface ForwardHeaderOptions {
  /** Config name of the target's own credential, or undefined for a passthrough. */
  declaredCredential?: string;
  /** The declared credential's value. Ignored entirely when `declaredCredential` is undefined. */
  credentialValue?: string;
  /** Header the injected credential goes into. Anthropic uses `x-api-key`. */
  authHeader?: 'x-api-key' | 'authorization';
  /** Label used in the thrown error when the credential is declared but unset. */
  targetLabel?: string;
  /**
   * Force containment even for a target with no declared credential. The escape
   * hatch for "forward to this URL but never let the caller's key reach it".
   */
  forceContained?: boolean;
}

/**
 * Build the header map for an upstream request.
 *
 * Contained target  → caller's auth stripped, declared credential injected.
 * Passthrough target → caller's auth forwarded verbatim, nothing injected.
 *
 * Throws `CredentialConfigError` for `declared-missing` rather than silently
 * degrading to passthrough, which is exactly the leak described in the header.
 * The strip happens BEFORE the throw so no code path — including an error
 * handler that decides to reuse the partially built map — can observe a header
 * map still carrying the caller's credential.
 */
export function buildForwardHeaders(
  inbound: Record<string, string | string[] | undefined>,
  options: ForwardHeaderOptions = {},
): Record<string, string> {
  const state = credentialState(options.declaredCredential, options.credentialValue);
  const contained = state !== 'not-declared' || options.forceContained === true;

  const out: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(inbound)) {
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (isInternalHeader(key)) continue;
    if (contained && INBOUND_AUTH.includes(key)) continue;
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }

  if (state === 'declared-missing') {
    throw new CredentialConfigError(options.targetLabel ?? options.declaredCredential ?? 'target');
  }

  if (state === 'declared-present') {
    const key = (options.credentialValue ?? '').trim();
    if (options.authHeader === 'authorization') {
      out['authorization'] = key.startsWith('Bearer ') ? key : `Bearer ${key}`;
    } else {
      out['x-api-key'] = key;
    }
  }

  return out;
}
