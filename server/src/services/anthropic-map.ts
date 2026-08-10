import { z } from 'zod';
import { getDb, getSetting, setSetting } from '../db/index.js';
import { getModelGroups, resolveRequestedIdForDispatch } from './model-groups.js';

// Claude Code model mapping. Claude Code keeps its built-in model names
// (e.g. `claude-sonnet-4-5` as the main model, `claude-3-5-haiku` as the
// small/fast background model) and sends them verbatim to `/v1/messages`.
// Since this proxy serves a free model pool (not the real Claude cloud
// models), we map each Claude family to either "auto" (let the router pick —
// the default and the common case) or a specific catalog model the operator
// pins. A concrete catalog model id sent directly (e.g. the user set
// ANTHROPIC_MODEL to one of our models) bypasses the map and pins as-is.
//
// Stored as a JSON blob in the `settings` table — no migration needed.

const SETTING_KEY = 'anthropic_model_map';

export const CLAUDE_FAMILIES = ['default', 'opus', 'sonnet', 'haiku', 'fable'] as const;
export type ClaudeFamily = (typeof CLAUDE_FAMILIES)[number];
/**
 * A family maps to one of three things:
 *   'auto'                    — let the router pick from the whole chain
 *   'some-model-id'           — pin that model first, whole chain behind it
 *   ['first', 'second', ...]  — a POOL: only these, in this order (local
 *                               reproduction of llm-relay's `routing.tiers`)
 *
 * The pool form is the one that carries a *boundary*. A single pin only
 * expresses a preference — `preferredModelDbId` moves a model to the front and
 * the rest of the chain still serves behind it. A pool restricts the candidate
 * set, which is what makes "keep the background/small tier small" mean
 * anything.
 */
export type FamilyTarget = string | string[];
export type AnthropicModelMap = Record<ClaudeFamily, FamilyTarget>;

const DEFAULT_MAP: AnthropicModelMap = {
  default: 'auto', opus: 'auto', sonnet: 'auto', haiku: 'auto', fable: 'auto',
};

const familyTargetSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
]);

export const anthropicModelMapSchema = z.object({
  default: familyTargetSchema.optional(),
  opus: familyTargetSchema.optional(),
  sonnet: familyTargetSchema.optional(),
  haiku: familyTargetSchema.optional(),
  fable: familyTargetSchema.optional(),
}).strict();

/** Normalize one stored value, dropping anything that isn't a non-empty string
 *  or a non-empty array of them. A malformed entry degrades to 'auto' rather
 *  than throwing on the proxy hot path. */
function readTarget(value: unknown): FamilyTarget {
  if (typeof value === 'string' && value) return value;
  if (Array.isArray(value)) {
    const ids = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (ids.length > 0) return ids;
  }
  return 'auto';
}

export function getClaudeModelMap(): AnthropicModelMap {
  const raw = getSetting(SETTING_KEY);
  if (!raw) return { ...DEFAULT_MAP };
  try {
    const p = JSON.parse(raw) as Partial<Record<ClaudeFamily, unknown>>;
    return {
      default: readTarget(p.default),
      opus: readTarget(p.opus),
      sonnet: readTarget(p.sonnet),
      haiku: readTarget(p.haiku),
      fable: readTarget(p.fable),
    };
  } catch {
    return { ...DEFAULT_MAP };
  }
}

export function setClaudeModelMap(input: unknown): AnthropicModelMap {
  const patch = anthropicModelMapSchema.parse(input);
  const current = getClaudeModelMap();
  const next: AnthropicModelMap = {
    default: patch.default ?? current.default,
    opus: patch.opus ?? current.opus,
    sonnet: patch.sonnet ?? current.sonnet,
    haiku: patch.haiku ?? current.haiku,
    fable: patch.fable ?? current.fable,
  };
  setSetting(SETTING_KEY, JSON.stringify(next));
  return next;
}

// Classify a requested model into a Claude family, or null when it's not a
// Claude alias at all (a concrete catalog id meant to pin directly).
export function classifyClaudeFamily(model?: string): ClaudeFamily | null {
  const m = (model ?? '').trim().toLowerCase();
  if (!m || m === 'auto' || m === 'default' || m === 'freellmapi-auto') return 'default';
  // Claude Code's planning alias is opus-ish by name but must hit the catch-all,
  // so match it before the substring family checks below.
  if (m === 'opusplan' || m === 'opusplan-4') return 'default';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('fable')) return 'fable';
  // Any other claude-ish alias → the catch-all.
  if (m.startsWith('claude')) return 'default';
  return null;
}

export interface ResolvedAnthropicModel {
  // The catalog model db id to pin, or undefined to auto-route.
  preferredModelDbId?: number;
  // True when we resolved to a specific model (for analytics/pinned labels).
  pinned: boolean;
  // An ordered, RESTRICTED candidate set when the family maps to a pool. The
  // caller turns this into the routing chain, so nothing outside it can serve.
  // Ids are already filtered to enabled models, in the operator's declared
  // order.
  poolDbIds?: number[];
}

// Resolve the model a `/v1/messages` request should route to, honoring the
// operator's family map. Returns undefined preferredModelDbId to mean
// "auto-route" (the default for every family unless the operator pinned one).
export function resolveAnthropicModel(model?: string): ResolvedAnthropicModel {
  const db = getDb();
  const lookupEnabled = (modelId: string): number | undefined => {
    const row = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(modelId) as { id: number } | undefined;
    return row?.id;
  };
  const lookupEnabledDbId = (dbId: number): number | undefined => {
    const row = db.prepare('SELECT id FROM models WHERE id = ? AND enabled = 1').get(dbId) as { id: number } | undefined;
    return row?.id;
  };

  const family = classifyClaudeFamily(model);
  if (family) {
    const target = getClaudeModelMap()[family];
    if (!target || target === 'auto') return { pinned: false };

    if (Array.isArray(target)) {
      // A pool. Each entry is resolved the way the OpenAI surfaces resolve a
      // requested model, NOT by a raw `models.model_id` lookup — the catalog
      // stores one row per (provider, model), so "deepseek-v4-flash" is three
      // rows with three different provider-native spellings
      // (`deepseek-ai/DeepSeek-V4-Flash`, `deepseek-ai/deepseek-v4-flash`,
      // `deepseek-v4-flash-free`). A raw lookup would miss the id the operator
      // actually sees in /v1/models, and even on a hit would pin ONE provider's
      // copy — the opposite of what naming a model in a pool means.
      //
      // resolveRequestedIdForDispatch accepts all three spellings a pool entry
      // might use — `platform:model_id`, a bare model_id (every provider that
      // serves it), and the group's canonical slug — so one model name expands
      // to every provider carrying it, in group order.
      const groups = getModelGroups();
      const ids: number[] = [];
      const add = (id: number | undefined): void => {
        if (id != null && !ids.includes(id)) ids.push(id);
      };
      for (const entry of target) {
        const resolved = resolveRequestedIdForDispatch(entry, groups);
        if (resolved && resolved.memberDbIds.length > 0) {
          // Groups span enabled AND disabled rows so resolution stays complete;
          // only enabled ones can serve.
          for (const dbId of resolved.memberDbIds) add(lookupEnabledDbId(dbId));
          continue;
        }
        add(lookupEnabled(entry));
      }
      // An empty result degrades to auto for the same reason a dead single pin
      // does: refusing to serve because the operator's map went stale is worse
      // than routing normally.
      if (ids.length === 0) return { pinned: false };
      return { poolDbIds: ids, preferredModelDbId: ids[0], pinned: true };
    }

    const id = lookupEnabled(target);
    // A pinned-but-now-disabled/removed target degrades gracefully to auto.
    return id != null ? { preferredModelDbId: id, pinned: true } : { pinned: false };
  }

  // Not a Claude alias: treat as a concrete catalog model id and pin it if it
  // exists and is enabled; otherwise auto-route (lenient, like the OpenAI route).
  const id = lookupEnabled((model ?? '').trim());
  return id != null ? { preferredModelDbId: id, pinned: true } : { pinned: false };
}
