import { randomBytes } from 'node:crypto'

// RFC-460 (RFC-294 W9-D): the one envelope-nonce generator. Task execution (node runs), Intent (turns and sessions)
// and Memory (distills) all take it from here; it was task-execution's `generateNodeRunEnvelopeNonce`, re-exported
// to the other two through `services/nodeRunMint.ts` as `generateEnvelopeNonce`.

/**
 * RFC-200 — a fresh, unpredictable per-run envelope nonce (16 hex chars = 64
 * bits of `crypto` randomness). Unpredictable is load-bearing: the whole point
 * is that untrusted upstream content — authored BEFORE this run existed — cannot
 * guess it to forge a `<workflow-output nonce="…">` the parser would accept. A
 * time-ordered id (ULID) would be guessable, so this must stay `randomBytes`.
 */
export function generateEnvelopeNonce(): string {
  return randomBytes(8).toString('hex')
}
