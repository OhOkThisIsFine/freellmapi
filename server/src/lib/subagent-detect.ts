// Detect requests that a coding harness issued from a SUBAGENT rather than the
// user's own conversation.
//
// This is what makes selective offload safe. Without it, a subagent declaring
// `model: haiku` and a human picking Haiku for their own conversation are
// byte-identical on the wire, so any tier→provider mapping silently drops the
// human's conversation onto a free model.
//
// ⚠ The failure mode is asymmetric and quiet: an UNDETECTED subagent falls
// through to the passthrough and spends primary (paid) quota while still looking
// like a successful offload. Nothing errors. That is why three independent
// signals are checked ALONGSIDE each other rather than one being trusted — each
// covers another's silent disappearance:
//
//   * The system marker dies to `CLAUDE_CODE_ATTRIBUTION_HEADER=0`, which drops
//     the attribution block (and therefore the marker) from the system prompt.
//   * The agent-id header dies to any middleware that filters unknown request
//     headers, and Anthropic treats `x-claude-code-*` as an open list.
//
// One travels inside the body and one outside it, so no single component drops
// both. Ported from llm-relay `src/config.ts` (verified on wire against Claude
// Code 2.1.220); built-in subagents (Explore, general-purpose) carry the marker
// too, not just custom agent files.

/** Marker Claude Code stamps into the `system` block of subagent requests only. */
const SUBAGENT_MARKER = 'cc_is_subagent=true';

/**
 * Claude Code's per-request agent identifier — present only on requests from an
 * agent it spawned inside the session, and explicitly permitted to be consumed
 * by a gateway for routing.
 *
 * Presence alone is the signal. The value identifies WHICH agent, not who the
 * user is, so it is never read as an identity.
 */
const CLAUDE_AGENT_ID_HEADER = 'x-claude-code-agent-id';

/** Codex's local Responses client marks child-agent turns in this JSON header. */
const CODEX_TURN_METADATA_HEADER = 'x-codex-turn-metadata';
const CODEX_SUBAGENT_REQUEST_KIND = 'subagent';

export type RequestHeaders = Readonly<Record<string, string | string[] | undefined>>;

/** Case-insensitive single-value lookup — Node lowercases, hand-built maps may not. */
function headerValue(headers: RequestHeaders | undefined, name: string): string | undefined {
  const raw = Object.entries(headers ?? {}).find(([n]) => n.toLowerCase() === name)?.[1];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** True when the Anthropic `system` field carries the subagent marker. */
function systemHasMarker(system: unknown): boolean {
  // The marker contains no newline, so it cannot span a block join boundary —
  // checking each block independently is equivalent to checking the joined text.
  if (typeof system === 'string') return system.includes(SUBAGENT_MARKER);
  if (!Array.isArray(system)) return false;
  for (const block of system) {
    const text = typeof block === 'string' ? block : (block as { text?: unknown })?.text;
    if (typeof text === 'string' && text.includes(SUBAGENT_MARKER)) return true;
  }
  return false;
}

/**
 * Whether this request is a marked Claude Code or local Codex child turn.
 *
 * Fails OPEN (returns false) for anything unrecognized: an unmarked request is
 * treated as the user's own conversation, which is the safe default — it keeps
 * the human's turn on their chosen model rather than silently downgrading it.
 */
export function isSubagentRequest(body: unknown, headers?: RequestHeaders): boolean {
  if (typeof body === 'object' && body !== null) {
    if (systemHasMarker((body as { system?: unknown }).system)) return true;
  }

  const agentId = headerValue(headers, CLAUDE_AGENT_ID_HEADER);
  if (typeof agentId === 'string' && agentId.trim().length > 0) return true;

  // Codex Responses requests have no Anthropic `system` field. Parse defensively
  // and fail open for ordinary turns or metadata shapes we do not recognize.
  const metadataText = headerValue(headers, CODEX_TURN_METADATA_HEADER);
  if (typeof metadataText !== 'string') return false;
  try {
    const metadata = JSON.parse(metadataText) as unknown;
    return typeof metadata === 'object' && metadata !== null
      && (metadata as { request_kind?: unknown }).request_kind === CODEX_SUBAGENT_REQUEST_KIND;
  } catch {
    return false;
  }
}

/** Which signal fired — for logging, so a silent detection change is visible. */
export function subagentSignal(body: unknown, headers?: RequestHeaders): string | null {
  if (typeof body === 'object' && body !== null
    && systemHasMarker((body as { system?: unknown }).system)) return 'system-marker';
  const agentId = headerValue(headers, CLAUDE_AGENT_ID_HEADER);
  if (typeof agentId === 'string' && agentId.trim().length > 0) return 'agent-id-header';
  if (isSubagentRequest(body, headers)) return 'codex-turn-metadata';
  return null;
}
