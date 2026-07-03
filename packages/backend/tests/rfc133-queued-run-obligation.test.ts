// RFC-133 (design/RFC-133-dispatch-queued-run-obligation) — the QUEUED-entry「run 义务」matrix.
//
// Live deadlock (2026-07-02, task 01KWFZRQFPZFQQEM8JTCHQMGP5 "QMGP5"): the in-flight gate judged a
// dispatched-but-unbound entry (`trigger_run_id NULL`, reassigned to the never-run downstream node
// agent_1k2ftd) unconditionally OPEN, so every later batch dispatch touching that node 409'd with
// task-question-node-dispatch-in-flight. The node could only ever run AFTER the asking node got
// those very answers → circular wait; the gate's "dispatch after done+output" exit was unsatisfiable.
//
// New contract (isDispatchedEntryConsumed, in-flight, trigger NULL):
//   open ⟺ (a) the effective target has a RUN OBLIGATION — a top-level run with status !== 'done'
//            (same bar as openImmediateRounds' in-flight scan), OR
//          (b) the caller mints an ALIEN cause class there (`mintCause` given and ≠ the entry's own
//            causeClassForEntry — Codex design-gate P2: releasing it would bind the entry into that
//            alien-cause rerun, collapsing the §5.2.12 cause serialization).
//   'revivable' (borrow oracle) is UNCHANGED: queued → open, unconditionally.
//
// These are pure unit tests on the exported oracle; the gate integration (dispatchTaskQuestions /
// quick-finalize) is covered in rfc133-dispatch-queued-deadlock.test.ts.

import { describe, expect, test } from 'bun:test'

import type { nodeRuns, taskQuestions } from '../src/db/schema'
import { causeClassForEntry, isDispatchedEntryConsumed } from '../src/services/clarifyRerunLedger'
import type { RunLineageView } from '@agent-workflow/shared'

type NodeRunRow = typeof nodeRuns.$inferSelect
type TaskQuestionRow = typeof taskQuestions.$inferSelect

const TARGET = 'agent_target'

function mkRun(over: Partial<NodeRunRow>): NodeRunRow {
  return {
    id: 'run',
    nodeId: TARGET,
    iteration: 0,
    parentNodeRunId: null,
    rerunCause: null,
    status: 'done',
    ...over,
  } as NodeRunRow
}

function mkLineage(over: Partial<RunLineageView>): RunLineageView {
  return {
    id: 'h1',
    nodeId: TARGET,
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

type EntryPick = Pick<
  TaskQuestionRow,
  'triggerRunId' | 'defaultTargetNodeId' | 'overrideTargetNodeId' | 'roleKind' | 'sourceKind'
>

function queued(over: Partial<EntryPick> = {}): EntryPick {
  return {
    triggerRunId: null,
    defaultTargetNodeId: TARGET,
    overrideTargetNodeId: null,
    roleKind: 'self',
    sourceKind: 'self',
    ...over,
  }
}

const NO_LINEAGE: RunLineageView[] = []

describe('RFC-133 queued run-obligation matrix — isDispatchedEntryConsumed (in-flight)', () => {
  test('case 1: target has ZERO runs (never-run downstream) → consumed (released); revivable stays open', () => {
    expect(isDispatchedEntryConsumed(queued(), [], NO_LINEAGE, 'in-flight')).toBe(true)
    expect(isDispatchedEntryConsumed(queued(), [], NO_LINEAGE, 'revivable')).toBe(false)
  })

  test('case 2: target all top-level runs done (with and without output) → released', () => {
    const doneNoOutput = [mkRun({ id: 'r1', status: 'done' })]
    expect(isDispatchedEntryConsumed(queued(), doneNoOutput, NO_LINEAGE, 'in-flight')).toBe(true)
    // output presence is irrelevant to the queued branch (it keys on run STATUS only) — the
    // done-run case releases either way; multi-done history too.
    const multiDone = [mkRun({ id: 'r1' }), mkRun({ id: 'r2' })]
    expect(isDispatchedEntryConsumed(queued(), multiDone, NO_LINEAGE, 'in-flight')).toBe(true)
  })

  test('case 3: target has a pending / running top-level run → still open (double-mint guard)', () => {
    for (const status of ['pending', 'running'] as const) {
      const runs = [mkRun({ id: 'r1', status: 'done' }), mkRun({ id: 'r2', status })]
      expect(isDispatchedEntryConsumed(queued(), runs, NO_LINEAGE, 'in-flight')).toBe(false)
    }
  })

  test('case 4: target has a failed / canceled / interrupted run → still open (revivable rerun)', () => {
    for (const status of ['failed', 'canceled', 'interrupted'] as const) {
      const runs = [mkRun({ id: 'r1', status })]
      expect(isDispatchedEntryConsumed(queued(), runs, NO_LINEAGE, 'in-flight')).toBe(false)
    }
  })

  test('case 5: only a WRAPPER CHILD run (parentNodeRunId set) is non-done → released (top-level only)', () => {
    const runs = [
      mkRun({ id: 'parent', status: 'done' }),
      mkRun({ id: 'child', status: 'running', parentNodeRunId: 'parent' }),
    ]
    expect(isDispatchedEntryConsumed(queued(), runs, NO_LINEAGE, 'in-flight')).toBe(true)
  })

  test('case 5b: a non-done run on ANOTHER node does not block this target', () => {
    const runs = [mkRun({ id: 'other', nodeId: 'agent_other', status: 'running' })]
    expect(isDispatchedEntryConsumed(queued(), runs, NO_LINEAGE, 'in-flight')).toBe(true)
  })

  test('case 6: effective target NULL (data anomaly) → conservative open', () => {
    const e = queued({ defaultTargetNodeId: null, overrideTargetNodeId: null })
    expect(isDispatchedEntryConsumed(e, [], NO_LINEAGE, 'in-flight')).toBe(false)
  })

  test('case 6b: override target wins — obligation is scanned on the OVERRIDE node', () => {
    const e = queued({ defaultTargetNodeId: 'agent_origin', overrideTargetNodeId: TARGET })
    const busyOverride = [mkRun({ id: 'r1', status: 'running' })]
    expect(isDispatchedEntryConsumed(e, busyOverride, NO_LINEAGE, 'in-flight')).toBe(false)
    const busyOriginOnly = [mkRun({ id: 'r1', nodeId: 'agent_origin', status: 'running' })]
    expect(isDispatchedEntryConsumed(e, busyOriginOnly, NO_LINEAGE, 'in-flight')).toBe(true)
  })

  test('case 7 (Codex P2): alien mintCause blocks a queued entry even with no run obligation; same cause rides', () => {
    // designer entry, caller mints 'clarify-answer' → alien → open.
    const designer = queued({ roleKind: 'designer' })
    expect(isDispatchedEntryConsumed(designer, [], NO_LINEAGE, 'in-flight', 'clarify-answer')).toBe(
      false,
    )
    // self entry, caller mints 'clarify-answer' → same cause → released (rides the mint).
    expect(isDispatchedEntryConsumed(queued(), [], NO_LINEAGE, 'in-flight', 'clarify-answer')).toBe(
      true,
    )
    // questioner entry vs designer mint → alien → open.
    const questioner = queued({ roleKind: 'questioner' })
    expect(
      isDispatchedEntryConsumed(questioner, [], NO_LINEAGE, 'in-flight', 'cross-clarify-answer'),
    ).toBe(false)
    // revivable ignores mintCause entirely (borrow unchanged).
    expect(isDispatchedEntryConsumed(designer, [], NO_LINEAGE, 'revivable', 'clarify-answer')).toBe(
      false,
    )
  })

  test('case 8: bound branches — done±output consumed in BOTH modes (RFC-139) / failed handler / GC anchor ignore mintCause', () => {
    const bound: EntryPick = { ...queued(), triggerRunId: 'h1' }
    const doneRuns = [mkRun({ id: 'h1', rerunCause: 'clarify-answer', status: 'done' })]
    const doneNoOut = [mkLineage({ id: 'h1', hasOutput: false })]
    expect(
      isDispatchedEntryConsumed(bound, doneRuns, doneNoOut, 'in-flight', 'cross-clarify-answer'),
    ).toBe(true)
    // RFC-139 flip: done-no-output = consumed in 'revivable' too. The old `false` locked the
    // RFC-127 "keeps borrowing the same handler" relic — consumerless since RFC-131 T4 de-borrow;
    // keeping it open made the ledger permanent (a clarify-ask never becomes done+output) and
    // deterministically killed the next round's rerun on task-question-borrow-ledger-conflict
    // (task QMGP5). Full matrix: rfc139-clarify-ask-closes-ledger.test.ts.
    expect(isDispatchedEntryConsumed(bound, doneRuns, doneNoOut, 'revivable')).toBe(true)
    const doneOut = [mkLineage({ id: 'h1', hasOutput: true })]
    expect(isDispatchedEntryConsumed(bound, doneRuns, doneOut, 'revivable')).toBe(true)
    const failedRuns = [mkRun({ id: 'h1', rerunCause: 'clarify-answer', status: 'failed' })]
    const failedLineage = [mkLineage({ id: 'h1', status: 'failed' })]
    expect(isDispatchedEntryConsumed(bound, failedRuns, failedLineage, 'in-flight')).toBe(false)
    const gone: EntryPick = { ...queued(), triggerRunId: 'gone' }
    expect(isDispatchedEntryConsumed(gone, doneRuns, doneNoOut, 'in-flight')).toBe(false)
  })
})

describe('RFC-133 causeClassForEntry — single shared definition', () => {
  test('role → cause class mapping', () => {
    expect(causeClassForEntry({ roleKind: 'self', sourceKind: 'self' })).toBe('clarify-answer')
    expect(causeClassForEntry({ roleKind: 'questioner', sourceKind: 'cross' })).toBe(
      'cross-clarify-questioner-rerun',
    )
    expect(causeClassForEntry({ roleKind: 'designer', sourceKind: 'cross' })).toBe(
      'cross-clarify-answer',
    )
  })

  test('grep guard: taskQuestionDispatch has NO private causeClassForEntry definition left', async () => {
    const src = await Bun.file(
      new URL('../src/services/taskQuestionDispatch.ts', import.meta.url).pathname,
    ).text()
    expect(src).not.toMatch(/function causeClassForEntry/)
    expect(src).toContain('causeClassForEntry,')
  })
})
