// RFC-098 WP-10 T-c (audit S-25) — (consumerKind × cause) injection gate
// truth table.
//
// The scheduler's clarify/cross-clarify injection gate region used PROXY
// signals to infer why the dispatched row exists. WP-10 records the cause on
// the row itself (node_runs.rerun_cause, migration 0044, written by the mint
// factory) and switches gate-2 onto it. This file pins, per 对抗检视修订 #11:
//
//   gate-2 (isClarifyRerun — inline session resume, prior-session read,
//           applyLatestDirective):
//     cause ∈ {'clarify-answer', 'cross-clarify-questioner-rerun'} — and
//     NOTHING else. The questioner rerun deliberately rides the same gate
//     (it used to do so via "retryIndex 0 + generation > 0"; dropping it
//     from the set flips the stop-directive + questioner-context nets).
//   gate-3 (isCrossClarifyTriggeredRerun — update-mode working-draft
//           injection): deliberately NOT switched on cause. It is a
//     retry-AGNOSTIC lineage signal — an in-attempt RFC-042 process retry
//     (cause='process-retry') must see the same working draft as the rerun
//     it retries — so the generation-derived form stays.
//   gate-4 (isQuestionerCrossClarifyRerun — questioner Q&A context): pure
//     topology (clarifyMode === 'cross') + RFC-070 consumed-by self-gating
//     inside buildPromptContext; cause is NOT consulted.
//   gate-5 (stop-directive single-round scoping): follows gate-2 OR
//     "not review-driven" — `applyLatestDirective = isClarifyRerun ||
//     reviewContext === undefined`, consumed by both prompt-context branches
//     (RFC-100 Codex review #2: a process-retry / revival of a clarify round is
//     NOT review-driven, so it keeps its directive — a 'stop' finalize round
//     stays released across retries instead of being re-forced into ask-back).
//     Also locked by rfc064-source-grep-guards.test.ts.
//
// End-to-end behavior sits in the existing ≈14-file gating regression net
// (clarify-prompt-injection / scheduler-clarify-inline / *stop-directive* /
// cross-clarify-questioner-context / ...). This file is the per-value oracle
// the net cannot give: every enum value asserted open/closed against gate-2.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RERUN_CAUSES, type RerunCause } from '@agent-workflow/shared'
import { isClarifyRerunCause } from '../src/services/nodeRunMint'

const SCHEDULER_SRC = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
  'utf8',
)

// ---------------------------------------------------------------------------
// gate-2 truth table — exhaustive over the enum.
// ---------------------------------------------------------------------------

const GATE2_EXPECTED: Record<RerunCause, boolean> = {
  initial: false,
  'stale-redispatch': false,
  revival: false,
  'process-retry': false,
  'clarify-answer': true,
  'cross-clarify-answer': false, // designer update rerun → gate-3 path, NOT gate-2
  'cross-clarify-questioner-rerun': true,
  'review-iterate': false,
  'review-reject': false,
  'review-park': false,
  'clarify-park': false,
  'cross-clarify-park': false,
  'retry-node': false,
  'retry-node-cascade': false,
  'fanout-shard': false,
  'fanout-aggregator': false,
  'wrapper-init': false,
  'commit-push': false,
  'commit-push-session': false,
  'merge-resolve': false, // RFC-130 internal merge-agent session — not a clarify rerun
  'io-virtual': false,
  'cross-clarify-guard': false,
}

describe('RFC-098 WP-10 — gate-2 (isClarifyRerun) × cause truth table', () => {
  test('the table is exhaustive over RERUN_CAUSES (adding a value forces a row here)', () => {
    expect(Object.keys(GATE2_EXPECTED).sort()).toEqual([...RERUN_CAUSES].sort())
  })

  for (const cause of RERUN_CAUSES) {
    test(`gate-2('${cause}') → ${GATE2_EXPECTED[cause] ? 'OPEN' : 'closed'}`, () => {
      expect(isClarifyRerunCause(cause)).toBe(GATE2_EXPECTED[cause])
    })
  }

  test('exactly two causes open gate-2', () => {
    const open = RERUN_CAUSES.filter((c) => isClarifyRerunCause(c))
    expect(open.sort()).toEqual(['clarify-answer', 'cross-clarify-questioner-rerun'])
  })

  test('NULL / undefined (pre-0044 legacy rows across a daemon upgrade) gate FALSE', () => {
    expect(isClarifyRerunCause(null)).toBe(false)
    expect(isClarifyRerunCause(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Gate wiring — source-level pins (consumerKind side of the matrix).
// ---------------------------------------------------------------------------

describe('RFC-098 WP-10 — scheduler gate wiring', () => {
  test('gate-2 reads the dispatched row cause (NOT the retryIndex proxy)', () => {
    expect(SCHEDULER_SRC).toContain(
      'const isClarifyRerun = isClarifyRerunCause(currentRunRow?.rerunCause)',
    )
    // The old proxy expression must be gone from scheduler.ts entirely —
    // comments included (a comment re-teaching the proxy is how it comes back).
    expect(SCHEDULER_SRC).not.toContain('(currentRunRow?.retryIndex ?? 0) === 0')
  })

  test('gate-3 (update-mode) deliberately stays generation-derived — no cause switch', () => {
    expect(SCHEDULER_SRC).toContain(
      'const isCrossClarifyTriggeredRerun = hasExternalFeedbackChannel && clarifyGeneration > 0',
    )
  })

  test('gate-4 (questioner context) stays a topology self-gate', () => {
    expect(SCHEDULER_SRC).toContain("const isQuestionerCrossClarifyRerun = clarifyMode === 'cross'")
  })

  test('gate-5 (stop scoping) follows gate-2 OR not-review-driven, in BOTH prompt-context branches', () => {
    // RFC-100 (Codex review #2 fix): gate-5 no longer STRICTLY follows gate-2.
    // A process-retry / revival of a clarify round (NOT review-driven) must keep
    // its directive so a 'stop' finalize round stays released across retries —
    // hence `isClarifyRerun || reviewContext === undefined`.
    expect(SCHEDULER_SRC).toContain(
      'const applyLatestDirective = isClarifyRerun || reviewContext === undefined',
    )
    // Both prompt-context branches consume the shared local (object shorthand).
    const matches = SCHEDULER_SRC.match(/\bapplyLatestDirective,/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// Producer side — each rerun producer states its cause at the mint site.
// ---------------------------------------------------------------------------

describe('RFC-098 WP-10 — producers mint the cause the gates consume', () => {
  test("clarify.ts answer rerun mints cause: 'clarify-answer'", () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'clarify.ts'),
      'utf8',
    )
    expect(src).toContain("cause: 'clarify-answer'")
  })

  test("crossClarify.ts designer rerun mints cause: 'cross-clarify-answer' and the questioner rerun 'cross-clarify-questioner-rerun'", () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'crossClarify.ts'),
      'utf8',
    )
    expect(src).toContain("cause: 'cross-clarify-answer'")
    expect(src).toContain("cause: 'cross-clarify-questioner-rerun'")
    // T-d (对抗检视修订 #11 改裁): the gate no longer depends on the designer
    // rerun's retryIndex — but the max+1 attempts-chain bump is KEPT (lineage
    // monotonicity, pinned by cross-clarify-designer-retry-index.test.ts).
    // The old proxy-hack comment teaching "deliberately ≥ 1 so isClarifyRerun
    // stays FALSE" must not survive — it described gate coupling that no
    // longer exists.
    expect(src).toContain('newDesignerRetryIndex')
    expect(src).not.toContain('must stay FALSE for a cross-clarify designer rerun')
  })
})
