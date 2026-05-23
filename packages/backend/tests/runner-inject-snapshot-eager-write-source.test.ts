// RFC-047 — grep guard. Locks structural invariants of the eager-write that
// the dynamic test (`runner-inject-snapshot-eager-write.test.ts`) can't
// reach directly without racing the SQL pipeline:
//
//   1. `runner.ts` carries the success log tag exactly once.
//   2. `runner.ts` carries the failure log tag exactly once.
//   3. The eager UPDATE statement physically precedes the final run-end
//      UPDATE — so a future refactor that re-orders the steps can't silently
//      revert RFC-047 back to RFC-046 behavior (column populated only at
//      run end).
//   4. The final UPDATE still writes `injectedMemoriesJson` — the eager
//      write is layered on top of RFC-046, NOT a replacement.

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

  test('eager UPDATE precedes the final UPDATE', () => {
    const eagerIdx = src.indexOf("'inject-snapshot-eager-write'")
    expect(eagerIdx).toBeGreaterThan(-1)
    // The final run-end UPDATE writes status + finishedAt + injectedMemoriesJson
    // together. We pin both pieces to be sure we're matching the run-end UPDATE
    // (the eager block only sets injectedMemoriesJson, so it does NOT contain
    // `finishedAt:`). lastIndexOf is used so unrelated `finishedAt:` lines
    // earlier in the file (e.g. RFC-060 PR-D signal-port-in-prompt failure
    // path) don't shadow the actual final run-end UPDATE block we want to lock.
    const finalIdx = src.lastIndexOf('finishedAt: Date.now()')
    expect(finalIdx).toBeGreaterThan(-1)
    expect(eagerIdx).toBeLessThan(finalIdx)
  })

  test('final UPDATE still carries injectedMemoriesJson (fail-safe vs RFC-046)', () => {
    const finalBlockStart = src.lastIndexOf('finishedAt: Date.now()')
    expect(finalBlockStart).toBeGreaterThan(-1)
    // Walk a generous window after the finishedAt line and assert
    // `injectedMemoriesJson:` is present — the final UPDATE's `.set({...})`
    // payload lives within the same drizzle call expression.
    const window = src.slice(finalBlockStart, finalBlockStart + 2000)
    expect(window).toContain('injectedMemoriesJson:')
  })
})
