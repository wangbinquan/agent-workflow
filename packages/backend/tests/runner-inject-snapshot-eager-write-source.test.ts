// RFC-047 — grep guard. Locks structural invariants of the eager-write that
// the dynamic test (`runner-inject-snapshot-eager-write.test.ts`) can't
// reach directly without racing the SQL pipeline:
//
//   1. `runner.ts` carries the success log tag exactly once.
//   2. `runner.ts` carries the failure log tag exactly once.
//   3. The eager UPDATE statement physically precedes runner-exit finalization
//      — so a future refactor that re-orders the steps can't silently
//      revert RFC-047 back to RFC-046 behavior (column populated only at
//      run end).
//   4. The successful runner-exit finalization region still writes
//      `injectedMemoriesJson` after the status CAS. RFC-224 split status fields
//      from runner-specific JSON fields, but the eager write remains layered
//      on top of RFC-046, NOT a replacement.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

const RUNNER_PATH = resolve(import.meta.dir, '..', 'src', 'services', 'runner.ts')

function countOccurrences(haystack: string, needle: string): number {
  let i = 0
  let count = 0
  while (true) {
    const idx = haystack.indexOf(needle, i)
    if (idx === -1) break
    count += 1
    i = idx + needle.length
  }
  return count
}

describe('RFC-047 source-level grep guard', () => {
  const src = readFileSync(RUNNER_PATH, 'utf-8')

  test('log tag for success appears exactly once', () => {
    expect(countOccurrences(src, "'inject-snapshot-eager-write'")).toBe(1)
  })

  test('log tag for failure appears exactly once', () => {
    expect(countOccurrences(src, "'inject-snapshot-eager-write-failed'")).toBe(1)
  })

  test('eager UPDATE precedes runner-exit finalization', () => {
    const eagerIdx = src.indexOf("'inject-snapshot-eager-write'")
    expect(eagerIdx).toBeGreaterThan(-1)
    // `reason: 'runner-exit'` identifies the successful normal-finalization CAS
    // without confusing RFC-224's additional fail-closed finishedAt branches.
    const finalIdx = src.indexOf("reason: 'runner-exit'")
    expect(finalIdx).toBeGreaterThan(-1)
    expect(eagerIdx).toBeLessThan(finalIdx)
  })

  test('runner-exit finalization still persists injectedMemoriesJson (fail-safe vs RFC-046)', () => {
    const finalBlockStart = src.indexOf("reason: 'runner-exit'")
    expect(finalBlockStart).toBeGreaterThan(-1)
    const finalBlockEnd = src.indexOf('const result: RunResult', finalBlockStart)
    expect(finalBlockEnd).toBeGreaterThan(finalBlockStart)
    const finalization = src.slice(finalBlockStart, finalBlockEnd)
    // RFC-224 moved non-status JSON out of setNodeRunStatus. Keep the follow-up
    // write in the same successful finalization region and after the status CAS.
    expect(finalization).toContain('.update(nodeRuns)')
    expect(finalization).toContain('injectedMemoriesJson:')
    expect(finalization.indexOf('.update(nodeRuns)')).toBeLessThan(
      finalization.indexOf('injectedMemoriesJson:'),
    )
  })
})
