import { describe, it, expect } from 'vitest';
import { isSubagentRequest, subagentSignal } from '../../lib/subagent-detect.js';

// The real shape: Claude Code stamps the marker into an attribution line inside
// the system block, alongside other `key=value` pairs.
const ATTRIBUTION = 'x-anthropic-billing-header: cc_entrypoint=agent; cc_is_subagent=true;';

describe('system marker', () => {
  it('detects the marker in a string system field', () => {
    expect(isSubagentRequest({ system: `You are a helper.\n${ATTRIBUTION}` })).toBe(true);
  });

  it('detects the marker in a system block array', () => {
    expect(isSubagentRequest({
      system: [{ type: 'text', text: 'You are a helper.' }, { type: 'text', text: ATTRIBUTION }],
    })).toBe(true);
  });

  it('handles bare-string blocks', () => {
    expect(isSubagentRequest({ system: ['prelude', ATTRIBUTION] })).toBe(true);
  });

  it('does not fire on a main-conversation request', () => {
    expect(isSubagentRequest({ system: 'x-anthropic-billing-header: cc_entrypoint=cli;' })).toBe(false);
  });

  it('does not fire on cc_is_subagent=false', () => {
    expect(isSubagentRequest({ system: 'cc_is_subagent=false' })).toBe(false);
  });
});

describe('agent-id header', () => {
  it('fires on presence alone', () => {
    expect(isSubagentRequest({}, { 'x-claude-code-agent-id': 'agent_123' })).toBe(true);
  });

  it('is case-insensitive in the header name', () => {
    expect(isSubagentRequest({}, { 'X-Claude-Code-Agent-Id': 'agent_123' })).toBe(true);
  });

  it('ignores a blank or whitespace value', () => {
    expect(isSubagentRequest({}, { 'x-claude-code-agent-id': '' })).toBe(false);
    expect(isSubagentRequest({}, { 'x-claude-code-agent-id': '   ' })).toBe(false);
  });

  // The point of carrying two signals: either alone must be sufficient, because
  // each disappears under a different, realistic configuration.
  it('still detects when the system marker is stripped by CLAUDE_CODE_ATTRIBUTION_HEADER=0', () => {
    expect(isSubagentRequest({ system: 'You are a helper.' }, { 'x-claude-code-agent-id': 'a1' })).toBe(true);
  });

  it('still detects when middleware filtered the header away', () => {
    expect(isSubagentRequest({ system: ATTRIBUTION }, {})).toBe(true);
  });
});

describe('codex turn metadata', () => {
  it('detects a subagent request kind', () => {
    expect(isSubagentRequest({}, {
      'x-codex-turn-metadata': JSON.stringify({ request_kind: 'subagent' }),
    })).toBe(true);
  });

  it('ignores an ordinary turn', () => {
    expect(isSubagentRequest({}, {
      'x-codex-turn-metadata': JSON.stringify({ request_kind: 'primary' }),
    })).toBe(false);
  });

  it('fails open on unparseable metadata rather than throwing', () => {
    expect(isSubagentRequest({}, { 'x-codex-turn-metadata': 'not json{' })).toBe(false);
  });
});

describe('fails open — an unmarked request is the human conversation', () => {
  it.each([
    ['empty body', {}],
    ['null body', null],
    ['string body', 'nonsense'],
    ['no system field', { messages: [] }],
    ['null system', { system: null }],
    ['numeric system', { system: 42 }],
  ])('%s is not a subagent', (_label, body) => {
    expect(isSubagentRequest(body)).toBe(false);
  });

  it('treats a request with no headers at all as the human conversation', () => {
    expect(isSubagentRequest({ messages: [] }, undefined)).toBe(false);
  });
});

describe('subagentSignal reports which signal fired', () => {
  it.each([
    ['system-marker', { system: ATTRIBUTION }, {}],
    ['agent-id-header', {}, { 'x-claude-code-agent-id': 'a1' }],
    ['codex-turn-metadata', {}, { 'x-codex-turn-metadata': '{"request_kind":"subagent"}' }],
  ])('reports %s', (expected, body, headers) => {
    expect(subagentSignal(body, headers as Record<string, string>)).toBe(expected);
  });

  it('returns null when nothing fired', () => {
    expect(subagentSignal({ messages: [] })).toBeNull();
  });

  it('prefers the in-body marker when both are present', () => {
    expect(subagentSignal({ system: ATTRIBUTION }, { 'x-claude-code-agent-id': 'a1' })).toBe('system-marker');
  });
});
