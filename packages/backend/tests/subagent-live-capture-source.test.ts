// RFC-048 — source-code-level guards. These tests don't exercise behavior;
// they pin down the file layout that the RFC's plan.md §T6 acceptance
// list calls out so a refactor can't silently drop one of:
//
//   * the live poller call site in runner.ts
//   * the post-run captureChildSessions BFS (kept as the RFC-027 fail-safe)
//   * the two failure log tags emitted by services/subagentLiveCapture.ts
//   * the `liveCtrl.abort()` ordering after `child.exited`
//
// If any of these go missing the RFC's failure semantics regress, but
// production typecheck / behavior tests may not catch the loss directly.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..', '..', '..')

function read(p: string): string {
  return readFileSync(resolve(REPO, p), 'utf-8')
}

describe('RFC-048 source-layout guards', () => {
  test('runner.ts spins up the poller exactly once and stops it after child.exited', () => {
    // RFC-143: the poller start + post-run capture are now driver capability
    // methods (opencode implements; claude omits → NOOP_HANDLE), so the anchors
    // moved from the free fns to `driver.startLiveCapture?.(` / `driver.captureSessions({`.
    // The lifecycle contract this guards (poller started once, stopped after the
    // bounded exit wait and BEFORE the post-run capture) is unchanged.
    const src = read('packages/backend/src/services/runner.ts')
    const startCount = (src.match(/driver\.startLiveCapture\?\.\(/g) ?? []).length
    expect(startCount).toBe(1)
    const stmtPattern = /liveCtrl\.abort\(\)\n\s+livePoller\.stop\(\)/
    const stmtMatch = stmtPattern.exec(src)
    expect(stmtMatch).not.toBeNull()
    // RFC-098 WP-8: the exit wait is the bounded race
    // `const exitedOutcome = await Promise.race([child.exited..., reapDeadline...])`.
    const exitedIdx = src.indexOf('const exitedOutcome = await Promise.race([')
    const captureIdx = src.indexOf('await driver.captureSessions({')
    expect(exitedIdx).toBeGreaterThan(-1)
    expect(captureIdx).toBeGreaterThan(-1)
    expect(stmtMatch!.index).toBeGreaterThan(exitedIdx)
    expect(stmtMatch!.index).toBeLessThan(captureIdx)
  })

  test('runner.ts captures subagent sessions post-run via the driver (RFC-027 fail-safe preserved)', () => {
    const src = read('packages/backend/src/services/runner.ts')
    // RFC-143: was `await captureChildSessions({` — now the driver capability.
    expect(src).toContain('await driver.captureSessions({')
    // Must forward the live poller's partId dedupe Map so post-run BFS
    // doesn't double-write rows the poller already inserted.
    expect(src).toContain('alreadyInsertedPartIds: livePoller.stats().insertedPartIdsBySession')
  })

  test('subagentLiveCapture.ts emits each failure log tag exactly once', () => {
    const src = read('packages/backend/src/services/subagentLiveCapture.ts')
    const errCount = (src.match(/'subagent-live-poll-error'/g) ?? []).length
    const disCount = (src.match(/'subagent-live-poll-disabled'/g) ?? []).length
    expect(errCount).toBe(1)
    expect(disCount).toBe(1)
  })

  test('subagentLiveCapture.ts opens the opencode SQLite read-only', () => {
    const src = read('packages/backend/src/services/subagentLiveCapture.ts')
    expect(src).toContain('new Database(dbPath, { readonly: true })')
  })

  test('sessionCapture.ts captureChildSessions exposes alreadyInsertedPartIds + still loads sibling sessionIds', () => {
    const src = read('packages/backend/src/services/sessionCapture.ts')
    expect(src).toContain('alreadyInsertedPartIds?: Map<string, Set<string>>')
    expect(src).toContain('export async function loadSiblingsCapturedSessionIds(')
  })
})
