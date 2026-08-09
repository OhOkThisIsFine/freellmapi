// Keep the exact bytes of a JSON request body alongside the parsed object.
//
// `express.json()` consumes the request stream, so by the time a handler runs
// `req.body` is a parsed object and the original bytes are gone. That is fine
// for every route that translates the request — but the Anthropic passthrough
// lane forwards the request onward unchanged, and re-serializing a parsed object
// is not the same thing: `JSON.stringify` normalizes key order, number
// formatting, and escaping. Byte-exactness matters upstream (anything that
// hashes or signs a body sees a different payload), so capture the buffer that
// body-parser already has in hand rather than rebuilding one later.
//
// Stored under a Symbol instead of a plain `req.rawBody` property so it cannot
// collide with a field some other middleware sets, and so nothing reaches it
// except through the accessor below.

import type { IncomingMessage } from 'http';

const RAW_BODY = Symbol('freellmapi.rawBody');

/**
 * `verify` hook for `express.json()`. body-parser hands it the fully buffered
 * request bytes before parsing; we keep that same buffer (no copy — body-parser
 * builds a fresh one per request and does not reuse it).
 *
 * Never throws: `verify` throwing is how body-parser signals a 400, and this
 * capture is an optimization, not a validation.
 */
export function captureRawBody(req: IncomingMessage, _res: unknown, buf: Buffer): void {
  if (buf && buf.length > 0) (req as IncomingMessage & { [RAW_BODY]?: Buffer })[RAW_BODY] = buf;
}

/**
 * The captured bytes, or undefined when there were none to capture — an empty
 * body, or a content type `express.json()` declined to parse (its `verify` hook
 * only runs for the types it handles). Callers must have a fallback.
 */
export function rawBody(req: IncomingMessage): Buffer | undefined {
  return (req as IncomingMessage & { [RAW_BODY]?: Buffer })[RAW_BODY];
}
