// Documentation ↔ implementation reverse locks.
//
// WHY THIS EXISTS
// ---------------
// The 2026-07-21 test-guard audit found a recurring escape mechanism it named
// 「散文与索引充当契约载体」: load-bearing claims live in prose (CLAUDE.md,
// design/*.md, docs/*.md, code comments) and prose has no compiler. Nothing
// signals when a claim goes false, and the next contributor believes it.
// Concrete damage already observed:
//
//   * CLAUDE.md and design/proposal.md described fan-out's auto `errors` port
//     and partial-failure tolerance as delivered. They are DEFERRED — the
//     implementation is fail-all-after-join. CLAUDE.md is the first thing every
//     new session reads, so the error propagated into RFCs written on top of it.
//   * docs/performance-notes.md listed "no index on node_run_events.node_run_id"
//     as an open v2 bottleneck long after `idx_events_node` shipped. An audit
//     re-reported it as a live performance gap on 2026-07-21.
//
// The fix pattern is a REVERSE lock: assert that as long as the implementation
// is in state X, the docs say X. Each lock is deliberately two-sided — it reads
// the real implementation signal, not just the doc text — so it fails when
// EITHER side moves. That is the point: whoever implements the feature is
// forced to update the prose in the same commit.
//
// Add new locks here rather than scattering doc greps through feature tests.
//
// See design/test-guard-audit-2026-07-21 §3 结构守卫 G11.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..', '..', '..')
const read = (...segments: string[]): string => readFileSync(resolve(repoRoot, ...segments), 'utf8')

/** Lines mentioning `needle`, together with a window of surrounding context. */
function mentionsWithContext(source: string, needle: string, window: number): string[] {
  const lines = source.split(/\r?\n/)
  return lines.flatMap((line, index) => {
    if (!line.includes(needle)) return []
    const from = Math.max(0, index - window)
    return [lines.slice(from, index + window + 1).join('\n')]
  })
}

const DEFERRED_MARKERS = ['deferred', '未实现', 'not implemented']

function claimsDeferred(context: string): boolean {
  const lowered = context.toLowerCase()
  return DEFERRED_MARKERS.some((marker) => lowered.includes(marker.toLowerCase()))
}

describe('docs ↔ implementation parity', () => {
  describe("fan-out's auto `errors` port is documented as deferred while it is deferred", () => {
    // The implementation signal. `scheduler-audit-s18-s19-fanout-failure-semantics`
    // is the behavioural lock on fail-all-after-join; its assertion that the
    // wrapper produces NO `errors` port is what makes the doc marker correct.
    // If somebody implements the port they must change that assertion, which
    // flips this test red and forces the docs to move in the same commit.
    const s18 = read(
      'packages/backend/tests/scheduler-audit-s18-s19-fanout-failure-semantics.test.ts',
    )
    const errorsPortStillAbsent = s18.includes(
      "expect(wrapperOuts.find((o) => o.portName === 'errors')).toBeUndefined()",
    )

    test('the behavioural lock proving the port is absent is still in place', () => {
      // Fails closed: if the anchor assertion is renamed or deleted, this whole
      // group would otherwise skip its checks and go quietly green.
      expect(errorsPortStillAbsent).toBe(true)
    })

    test('CLAUDE.md does not present the errors port as delivered', () => {
      if (!errorsPortStillAbsent) return
      const claude = read('CLAUDE.md')
      for (const context of mentionsWithContext(claude, '`errors` port', 0)) {
        expect(`CLAUDE.md errors-port claim marked deferred: ${claimsDeferred(context)}`).toBe(
          'CLAUDE.md errors-port claim marked deferred: true',
        )
      }
      // And it must state the semantics that ARE implemented, so a reader who
      // skips the parenthetical still gets the right model.
      expect(claude).toContain('fail-all-after-join')
    })

    test('design/proposal.md marks every errors-port claim as deferred', () => {
      if (!errorsPortStillAbsent) return
      const proposal = read('design', 'proposal.md')
      const contexts = mentionsWithContext(proposal, 'errors port', 8)
      expect(contexts.length).toBeGreaterThan(0)
      for (const context of contexts) {
        expect(`proposal.md errors-port claim marked deferred: ${claimsDeferred(context)}`).toBe(
          'proposal.md errors-port claim marked deferred: true',
        )
      }
    })
  })

  test('performance notes do not report an index that the schema declares', () => {
    // docs/performance-notes.md §Issue tracker is a hand-maintained backlog of
    // known scale bottlenecks. Entry 1 claimed `node_run_events.node_run_id`
    // had no index for long after one shipped. Assert the two sides agree: if
    // the schema declares an index leading with node_run_id, the doc must not
    // still be asking for one.
    const schema = read('packages/backend/src/db/schema.ts')
    const notes = read('docs', 'performance-notes.md')

    const nodeRunEventsTable = schema.slice(
      schema.indexOf('export const nodeRunEvents = sqliteTable('),
    )
    const hasIndex = /index\('idx_events_node'\)\.on\(t\.nodeRunId/.test(
      nodeRunEventsTable.slice(0, nodeRunEventsTable.indexOf('\n)\n')),
    )
    expect(hasIndex).toBe(true)

    // With the index present, the doc must not carry an unresolved request for
    // it. A struck-through / RESOLVED entry is fine — an open one is not.
    for (const context of mentionsWithContext(notes, 'index on `node_run_events.node_run_id`', 2)) {
      expect(`open "missing index" entry: ${!/RESOLVED|~~/.test(context)}`).toBe(
        'open "missing index" entry: false',
      )
    }
  })

  test("RFC-212's status in the plan index matches whether the code shipped", () => {
    // RFC-212 v1's plan.md claimed T10 was "protected by docs-implementation-
    // parity.test.ts" — which was false, because that lock is a hand-written
    // set that would not cover RFC-212 unless someone added this very entry.
    // This is that entry. Implementation signal: the revalidation trigger being
    // wired into the credential write points. If it is wired, the plan index
    // must say Done (not Draft); if it is not, it must not say Done.
    const sessionStore = read('packages/backend/src/auth/sessionStore.ts')
    const shipped = sessionStore.includes("triggerRevalidation(db, 'session-revoked')")

    const planRow = read('design', 'plan.md')
      .split(/\r?\n/)
      .find((line) => line.includes('RFC-212-ws-authorization-revalidation'))
    expect(planRow).toBeDefined()

    // The status is the last `| … |` cell on the row.
    const status = (planRow as string).trimEnd().replace(/\s*\|\s*$/, '')
    const saysDone = /\|\s*Done\b/.test(status) || /\bDone\b[^|]*$/.test(status)
    expect(`RFC-212 wired=${shipped} plan-says-done=${saysDone}`).toBe(
      `RFC-212 wired=${shipped} plan-says-done=${shipped}`,
    )
  })
})
