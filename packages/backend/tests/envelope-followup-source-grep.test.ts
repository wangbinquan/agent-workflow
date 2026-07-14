// RFC-042 §5.7 — source-code-text grep guards.
//
// Locks in:
//   1. scheduler.ts must NOT regress to `?? 0` for the retries fallback
//      (RFC-042 §A4 default 3). RFC-115 moved the budget from a per-node
//      `retries` override to the global `opts.defaultNodeRetries ?? 3`; this
//      guards that fallback (and that the per-node lookup stays removed).
//   2. shared/prompt.ts must export `renderEnvelopeFollowupPrompt` — this
//      function is the contract the runner depends on for follow-up
//      attempts. If renamed / removed without notice, this test goes red.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_PROTOCOL_RETRY_BUDGET } from '@agent-workflow/shared'

describe('RFC-042 source-code-text guards', () => {
  test('scheduler.ts retries default rides DEFAULT_PROTOCOL_RETRY_BUDGET (=3), not `?? 0`', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    // RFC-115: the per-node `retries` override was removed; the budget is now
    // the global `opts.defaultNodeRetries`. The RFC-042 §A4 invariant (default
    // 3, never the legacy `?? 0`) lives on that fallback. 调度架构审视
    // 2026-07-14: the literal `?? 3` became the shared cross-engine constant
    // (retry-budget-single-source.test.ts locks all four consumer sites); the
    // §A4 VALUE invariant is asserted on the constant itself here.
    expect(src).toMatch(/opts\.defaultNodeRetries\s*\?\?\s*DEFAULT_PROTOCOL_RETRY_BUDGET\b/)
    expect(DEFAULT_PROTOCOL_RETRY_BUDGET).toBe(3)
    expect(src).not.toMatch(/opts\.defaultNodeRetries\s*\?\?\s*0\b/)
    // The per-node retries lookup is gone entirely (RFC-115 D2 — node no longer overrides).
    expect(src).not.toMatch(/pickNumber\(\s*node\s*,\s*['"]retries['"]/)
  })

  test('shared/prompt.ts exports renderEnvelopeFollowupPrompt', () => {
    // Walk up from packages/backend/tests/ to the workspace root.
    const sharedPrompt = resolve(import.meta.dir, '..', '..', 'shared', 'src', 'prompt.ts')
    const src = readFileSync(sharedPrompt, 'utf8')
    expect(src).toMatch(/export\s+function\s+renderEnvelopeFollowupPrompt\s*\(/)
  })
})
