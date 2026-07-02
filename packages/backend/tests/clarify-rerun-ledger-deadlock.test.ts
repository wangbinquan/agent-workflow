// RFC-128 P5-BC regression — the multi-round self/questioner clarify DEADLOCK fix.
//
// Bug (found 2026-07-01 on live task 01KWDKBS9K22KB6HH4KNR3XMX6 — a DEFERRED self-clarify
// task parked awaiting_human): after answering ROUND 2 of a self-clarify chain, batch
// dispatch was PERMANENTLY rejected with `task-question-node-dispatch-in-flight`
// ("该节点正在重跑，请等其完成后再下发") even though the agent had FINISHED — its
// continuation run was `done` (not running); it was only waiting for the round-2 answers.
//
// Root cause (clarifyRerunLedger.ts openImmediateRounds): the "pending continuation"
// predicate keyed on `!(status === 'done' && hasOutput)`. A self/questioner continuation
// run that ASKS a follow-up clarify round exits `done` WITH NO OUTPUT (runner.ts:1321 keeps
// status=done for a valid <workflow-clarify> envelope; it writes no <workflow-output> port).
// That terminal-but-outputless run — the PREVIOUS round's already-consumed continuation
// (4C5G59 in the live task: rerun_cause='clarify-answer', done, no output) — was mis-counted
// as an in-flight continuation of the CURRENT (next) round, because the predicate scans by
// (nodeId, iteration, cause) and cannot tell "last round's finished continuation" from
// "this round's not-yet-minted continuation". The round therefore stays forever "open" →
// dispatch blocked → the user's answers can never leave the board. A DEADLOCK: the only way
// forward (dispatch) is blocked by a run that is already done.
//
// Fix (mode-scoped so it does NOT regress RFC-127 借壳): openImmediateRounds now takes a `mode`. The
// DISPATCH GATE (findOpenImmediateLedgerHome) asks 'in-flight' — a round's genuine pending
// continuation is by definition NON-TERMINAL (pending/running, incl. the mint-first window), so a
// `done` (or failed/…) continuation of a PRIOR round no longer wedges the NEXT round's dispatch. The
// BORROW consumer (resolveImmediateBorrowForNode) keeps 'revivable' — a done-no-output continuation
// is NOT consumed, so it keeps borrowing (unchanged; locked by the RFC-127 defensive borrow test).
//
// These are PURE unit tests on the exported oracle (openImmediateRounds); the fix flows up
// through findOpenImmediateLedgerHome → assertNoOpenImmediateLedger → dispatchTaskQuestions.

import { describe, expect, test } from 'bun:test'

import type { clarifyRounds, nodeRuns } from '../src/db/schema'
import {
  buildImmediateLedgerContext,
  isDispatchedEntryConsumed,
  openImmediateRounds,
} from '../src/services/clarifyRerunLedger'
import type { RunLineageView } from '@agent-workflow/shared'

type ClarifyRoundRow = typeof clarifyRounds.$inferSelect
type NodeRunRow = typeof nodeRuns.$inferSelect

const P = 'agent_P'

// openImmediateRounds reads only a handful of columns; these factories fill exactly those
// and cast, so the test locks the oracle's CONTRACT (not the full row shape) and is immune
// to unrelated schema growth.
function mkRound(over: Partial<ClarifyRoundRow>): ClarifyRoundRow {
  return {
    kind: 'self',
    askingNodeId: P,
    status: 'answered',
    askingNodeRunId: 'ask',
    intermediaryNodeRunId: 'inter',
    consumedByConsumerRunId: null,
    consumedByQuestionerRunId: null,
    ...over,
  } as ClarifyRoundRow
}

function mkRun(over: Partial<NodeRunRow>): NodeRunRow {
  return {
    id: 'run',
    nodeId: P,
    iteration: 0,
    parentNodeRunId: null,
    rerunCause: 'clarify-answer',
    status: 'done',
    ...over,
  } as NodeRunRow
}

// A RunLineageView for the dispatched-ledger handler-run lineage (resolveHandlerRun projects this;
// hasOutput lives HERE, not on the NodeRunRow). Defaults to a done-no-output clarify continuation.
function mkLineage(over: Partial<RunLineageView>): RunLineageView {
  return {
    id: 'h1',
    nodeId: P,
    iteration: 0,
    loopIter: 0,
    rerunCause: 'clarify-answer',
    status: 'done',
    hasOutput: false,
    startedAt: 1,
    parentNodeRunId: null,
    ...over,
  }
}

describe('openImmediateRounds — multi-round self-clarify deadlock (RFC-128 P5-BC)', () => {
  test('DEADLOCK REPRO: a prior round DONE-no-output continuation must NOT keep the next round open', () => {
    // Round 2 answered, NOT dispatched. Its asking run IS the round-1 continuation (4C5G59):
    // rerun_cause='clarify-answer', status='done', NO output (it asked round 2, wrote no port).
    const cont = mkRun({
      id: 'cont',
      nodeId: P,
      iteration: 0,
      rerunCause: 'clarify-answer',
      status: 'done',
    })
    const round2 = mkRound({
      id: 'round2',
      askingNodeRunId: 'cont',
      intermediaryNodeRunId: 'i2',
      status: 'answered',
    })
    const ctx = buildImmediateLedgerContext(
      [round2],
      [cont],
      new Set<string>(), // cont captured NO output row
      new Set<string>(), // round2 not dispatched → immediate-ledger candidate
    )
    // Before the fix this returned [round2] (done-no-output cont counted as pending) →
    // dispatch permanently rejected. After the fix: [].
    expect(openImmediateRounds(P, 0, ctx, 'in-flight')).toEqual([])
  })

  test('true in-flight STILL blocks: a pending continuation keeps the round open (double-mint guard)', () => {
    // Same round 2, but a GENUINE pending continuation B was minted (consumes round 2) and is
    // still running (or the mint-first window). Dispatch MUST stay blocked.
    const cont = mkRun({
      id: 'cont',
      nodeId: P,
      iteration: 0,
      rerunCause: 'clarify-answer',
      status: 'done',
    })
    const pendingB = mkRun({
      id: 'B',
      nodeId: P,
      iteration: 0,
      rerunCause: 'clarify-answer',
      status: 'pending',
    })
    const round2 = mkRound({
      id: 'round2',
      askingNodeRunId: 'cont',
      intermediaryNodeRunId: 'i2',
      status: 'answered',
    })
    const ctx = buildImmediateLedgerContext(
      [round2],
      [cont, pendingB],
      new Set<string>(),
      new Set<string>(),
    )
    expect(openImmediateRounds(P, 0, ctx, 'in-flight').map((r) => r.id)).toEqual(['round2'])
  })

  test('consumed continuation (done + output) does NOT block — unchanged behavior', () => {
    const cont = mkRun({
      id: 'cont',
      nodeId: P,
      iteration: 0,
      rerunCause: 'clarify-answer',
      status: 'done',
    })
    const round2 = mkRound({
      id: 'round2',
      askingNodeRunId: 'cont',
      intermediaryNodeRunId: 'i2',
      status: 'answered',
    })
    // cont IS in outputRunIds (done + output). Both old and new predicates exclude it.
    const ctx = buildImmediateLedgerContext(
      [round2],
      [cont],
      new Set<string>(['cont']),
      new Set<string>(),
    )
    expect(openImmediateRounds(P, 0, ctx, 'in-flight')).toEqual([])
  })

  test('mode split: a done-no-output continuation is OPEN for borrow (revivable) but NOT for the gate (in-flight)', () => {
    // The exact divergence that makes the `mode` parameter necessary: the BORROW consumer must still
    // see a done-no-output continuation as open (keeps borrowing — RFC-127 defensive), while the
    // DISPATCH GATE must see it as closed (deadlock fix). One shared oracle, two answers.
    const cont = mkRun({
      id: 'cont',
      nodeId: P,
      iteration: 0,
      rerunCause: 'clarify-answer',
      status: 'done',
    })
    const round2 = mkRound({
      id: 'round2',
      askingNodeRunId: 'cont',
      intermediaryNodeRunId: 'i2',
      status: 'answered',
    })
    const ctx = buildImmediateLedgerContext([round2], [cont], new Set<string>(), new Set<string>())
    expect(openImmediateRounds(P, 0, ctx, 'revivable').map((r) => r.id)).toEqual(['round2'])
    expect(openImmediateRounds(P, 0, ctx, 'in-flight')).toEqual([])
  })

  test('Codex impl-gate: a FAILED continuation keeps the gate blocked (revivable → no double-mint)', () => {
    // Codex caught: keying the gate on `!isTerminalNodeRunStatus` would release a FAILED continuation
    // (terminal) from the dispatch gate while the borrow side still treats it as open (revivable —
    // retry/resume re-runs it) → dispatch would mint a SECOND same-home rerun while the old ledger is
    // still borrow-open → irreversible multi-ledger conflict. So the gate keys on `status !== 'done'`,
    // NOT on terminal: a failed/canceled/interrupted continuation stays blocked, exactly like
    // revivable. Only `done` (succeeded, never re-run) is released — which is the done-no-output
    // deadlock case above. Here a done asking run + a FAILED continuation ⇒ still OPEN for BOTH modes.
    const askDone = mkRun({
      id: 'ask',
      nodeId: P,
      iteration: 0,
      rerunCause: 'clarify-answer',
      status: 'done',
    })
    const failedRerun = mkRun({
      id: 'fr',
      nodeId: P,
      iteration: 0,
      rerunCause: 'clarify-answer',
      status: 'failed',
    })
    const round2 = mkRound({
      id: 'round2',
      askingNodeRunId: 'ask',
      intermediaryNodeRunId: 'i2',
      status: 'answered',
    })
    const ctx = buildImmediateLedgerContext(
      [round2],
      [askDone, failedRerun],
      new Set<string>(),
      new Set<string>(),
    )
    expect(openImmediateRounds(P, 0, ctx, 'in-flight').map((r) => r.id)).toEqual(['round2'])
    expect(openImmediateRounds(P, 0, ctx, 'revivable').map((r) => r.id)).toEqual(['round2'])
  })
})

describe('isDispatchedEntryConsumed — dispatched-ledger multi-round deadlock (RFC-128 P5-BC)', () => {
  // The DISPATCHED-ledger half of the SAME done-no-output bug (found on the SAME live task
  // 01KWDKBS...). round 1 is control-channel DISPATCHED; its handler run finishes `done` but writes
  // NO <workflow-output> (it asked round 2). assertNoInFlightDispatch → findOpenDispatchTarget →
  // isDispatchedEntryConsumed judged that handler "not consumed" (old `done && hasOutput`) → the home
  // stayed in-flight → round 2 dispatch permanently blocked. This is the gate that ACTUALLY fired for
  // the deferred task (assertNoInFlightDispatch runs BEFORE assertNoOpenImmediateLedger), so the
  // openImmediateRounds fix alone did not unblock it — isDispatchedEntryConsumed needed the same split.
  // RFC-133 widened the entry Pick (effective-target + roleKind feed the queued cause guard).
  const mkEntry = (triggerRunId: string | null) => ({
    triggerRunId,
    defaultTargetNodeId: P,
    overrideTargetNodeId: null,
    roleKind: 'self' as const,
  })
  const entry = mkEntry('h1')
  const runs = [
    mkRun({ id: 'h1', nodeId: P, iteration: 0, rerunCause: 'clarify-answer', status: 'done' }),
  ]

  test('done-no-output handler: in-flight = CONSUMED (gate releases → deadlock fix); revivable = OPEN (keeps borrowing)', () => {
    const lineage = [mkLineage({ id: 'h1', status: 'done', hasOutput: false })]
    // in-flight (dispatch gate / mint guard / park): a done handler terminated → consumed → releases.
    expect(isDispatchedEntryConsumed(entry, runs, lineage, 'in-flight')).toBe(true)
    // revivable (RFC-127 borrow): no output → NOT consumed → keeps borrowing.
    expect(isDispatchedEntryConsumed(entry, runs, lineage, 'revivable')).toBe(false)
  })

  test('done+output handler: CONSUMED in both modes (unchanged)', () => {
    const lineage = [mkLineage({ id: 'h1', status: 'done', hasOutput: true })]
    expect(isDispatchedEntryConsumed(entry, runs, lineage, 'in-flight')).toBe(true)
    expect(isDispatchedEntryConsumed(entry, runs, lineage, 'revivable')).toBe(true)
  })

  test('FAILED handler: NOT consumed in EITHER mode (revivable via retry/resume — gate stays blocked)', () => {
    const failedRuns = [
      mkRun({ id: 'h1', nodeId: P, iteration: 0, rerunCause: 'clarify-answer', status: 'failed' }),
    ]
    const lineage = [mkLineage({ id: 'h1', status: 'failed', hasOutput: false })]
    expect(isDispatchedEntryConsumed(entry, failedRuns, lineage, 'in-flight')).toBe(false)
    expect(isDispatchedEntryConsumed(entry, failedRuns, lineage, 'revivable')).toBe(false)
  })

  // RFC-133 (design/RFC-133-dispatch-queued-run-obligation): the queued lock is now CONDITIONAL —
  // a queued (trigger NULL) entry is open in-flight ONLY while its target owes a run obligation
  // (non-done top-level run) or the caller mints an alien cause there. The unconditional
  // "queued → open" contract this test used to lock caused the QMGP5 live deadlock
  // (task 01KWFZRQFPZFQQEM8JTCHQMGP5: entries reassigned to a never-run downstream node wedged
  // every later batch dispatch — the "wait for done+output" exit could never be satisfied).
  // The queued matrix lives in rfc133-queued-run-obligation.test.ts; here we keep the parts of
  // the old lock that still hold.
  test('queued on a target with an OPEN (non-done) run: still open in-flight; GC-d anchor: open — unchanged', () => {
    const lineage = [mkLineage({ id: 'h1' })]
    const busyRuns = [
      ...runs,
      mkRun({ id: 'h2', nodeId: P, iteration: 0, rerunCause: 'clarify-answer', status: 'running' }),
    ]
    expect(isDispatchedEntryConsumed(mkEntry(null), busyRuns, lineage, 'in-flight')).toBe(false)
    expect(isDispatchedEntryConsumed(mkEntry('gone'), runs, lineage, 'in-flight')).toBe(false)
  })

  test('queued in revivable mode: open unconditionally (borrow oracle unchanged by RFC-133)', () => {
    const lineage = [mkLineage({ id: 'h1' })]
    expect(isDispatchedEntryConsumed(mkEntry(null), runs, lineage, 'revivable')).toBe(false)
    expect(isDispatchedEntryConsumed(mkEntry(null), [], lineage, 'revivable')).toBe(false)
  })
})
