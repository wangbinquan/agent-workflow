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
  'wg-leader-round': false, // RFC-164 workgroup turns are full-context re-injections, not clarify reruns
  'wg-assignment': false,
  'wg-message-turn': false,
  'wg-gate': false,
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

  // RFC-132 (PR-C) superseded gate-3/4/5. The round-grouped injectors + their per-round
  // directive plumbing are gone: one flat injector (buildClarifyQueueContext) selects every role in
  // one query, the designer's working draft rides the generalized RFC-119 prior-output path, and the
  // standing directive is the per-node clarify state. These lock that the superseded scaffolding is
  // GONE and the flat wiring is in place.
  test('gate-3 (update-mode working draft) → generalized RFC-119 prior-output path (RFC-132 PR-C)', () => {
    // The cross-clarify-specific update-mode gate is gone; a designer surfaces its draft via the same
    // freshestPriorRunWithOutput path every rerun uses. RFC-141 then removed the RFC-120 §18
    // suppressPriorOutput gate from that path too (negative lock below).
    expect(SCHEDULER_SRC).not.toContain('isCrossClarifyTriggeredRerun')
    expect(SCHEDULER_SRC).toContain('freshestPriorRunWithOutput')
    expect(SCHEDULER_SRC).not.toContain('!suppressPriorOutput')
  })

  test('gate-4 (clarify injection) → one unified query, no per-role SELECT fork (RFC-132 PR-C)', () => {
    // "consumerKind 消失": buildClarifyQueueContext selects self/questioner/designer together.
    expect(SCHEDULER_SRC).not.toContain('isQuestionerCrossClarifyRerun')
    expect(SCHEDULER_SRC).toContain('await buildClarifyQueueContext(')
  })

  test('gate-5 (stop scoping) → per-node clarify state, no per-round applyLatestDirective (RFC-132 PR-C)', () => {
    // The standing continue/stop directive is the per-node clarify state (design §7); the flat context
    // carries none, so the per-round directive-override plumbing (applyLatestDirective) is gone.
    expect(SCHEDULER_SRC).not.toContain('applyLatestDirective')
    expect(SCHEDULER_SRC).toContain('const nodeStopOverride = nodeDirective === ')
  })
})

// ---------------------------------------------------------------------------
// Producer side — each rerun producer states its cause at the mint site.
// ---------------------------------------------------------------------------

describe('RFC-098 WP-10 — producers mint the cause the gates consume', () => {
  // RFC-132 ②b: the legacy immediate-mint producers (submitClarifyAnswers /
  // triggerDesignerRerun / triggerQuestioner*) were deleted — the ONE producer is
  // now dispatchTaskQuestions, whose per-entry cause comes from the single
  // causeClassForEntry mapping (clarifyRerunLedger). Re-anchor the lock there.
  test("causeClassForEntry maps self→'clarify-answer', questioner→'cross-clarify-questioner-rerun', designer→'cross-clarify-answer'", () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'clarifyRerunLedger.ts'),
      'utf8',
    )
    expect(src).toContain("if (e.roleKind === 'self') return 'clarify-answer'")
    expect(src).toContain(
      "if (e.roleKind === 'questioner') return 'cross-clarify-questioner-rerun'",
    )
    expect(src).toContain(
      "return 'cross-clarify-answer' // designer (incl. manual, incl. reassign-added upstream reviser)",
    )
  })

  test('dispatchTaskQuestions mints via causeClassForEntry (no hardcoded per-path cause forks)', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'taskQuestionDispatch.ts'),
      'utf8',
    )
    expect(src).toContain('causeClassForEntry')
  })
})
