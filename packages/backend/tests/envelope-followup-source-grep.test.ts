// RFC-042 §5.7 — source-code-text grep guards.
//
// Locks in:
//   1. scheduler.ts must NOT regress to `?? 0` for the retries fallback
//      (RFC-042 §A4 default 3). A future refactor that re-introduces the
//      old fallback will trip this test.
//   2. shared/prompt.ts must export `renderEnvelopeFollowupPrompt` — this
//      function is the contract the runner depends on for follow-up
//      attempts. If renamed / removed without notice, this test goes red.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('RFC-042 source-code-text guards', () => {
  test('scheduler.ts retries default is `?? 3`, not `?? 0`', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    // Allow the literal pattern `pickNumber(node, 'retries') ?? 3` with any
    // whitespace; forbid the legacy `?? 0` next to the same lookup.
    expect(src).toMatch(/pickNumber\(\s*node\s*,\s*['"]retries['"]\s*\)\s*\?\?\s*3\b/)
    expect(src).not.toMatch(/pickNumber\(\s*node\s*,\s*['"]retries['"]\s*\)\s*\?\?\s*0\b/)
  })

  test('shared/prompt.ts exports renderEnvelopeFollowupPrompt', () => {
    // Walk up from packages/backend/tests/ to the workspace root.
    const sharedPrompt = resolve(import.meta.dir, '..', '..', 'shared', 'src', 'prompt.ts')
    const src = readFileSync(sharedPrompt, 'utf8')
    expect(src).toMatch(/export\s+function\s+renderEnvelopeFollowupPrompt\s*\(/)
  })
})
