// RFC-120 Codex F1 — locks `resolveHandlerRun`: the PRECISE handler lineage
// (not a bare "freshest run >= trigger" comparison) used to derive an entry's
// execution phase.
//
// Intent of each lock (so a future refactor that reddens it sees why):
//   * null effective target OR null trigger → null (unscheduled → pending).
//   * the trigger run itself is the handler when nothing newer matches.
//   * a process-retry of the trigger (same node/iter, cause='process-retry',
//     id > anchor) IS in the window → freshest wins.
//   * **a LATER unrelated clarify-triggered rerun (a new round/answer on the
//     same node, cause ∈ NEW_CLARIFY_TRIGGER_CAUSES, id > anchor) is the WINDOW
//     UPPER BOUND and is EXCLUDED** — so it cannot drag an already
//     awaiting_confirm entry back to processing (the core F1 bug).
//   * fanout: the top-level parent run represents the handler; shard children
//     (parentNodeRunId != null) are not picked as the representative.
//   * runs on a different node / different iteration are ignored, and runs with
//     id < anchor (the pre-clarify original run) are below the window.

import { describe, expect, test } from 'bun:test'
import { deriveQuestionPhase, resolveHandlerRun, type RunLineageView } from '../src/task-questions'

const R = (id: string, over: Partial<RunLineageView> = {}): RunLineageView => ({
  id,
  nodeId: 'design',
  iteration: 0,
  loopIter: 0,
  rerunCause: 'cross-clarify-answer',
  status: 'done',
  startedAt: 1,
  hasOutput: true,
  parentNodeRunId: null,
  shardKey: null,
  ...over,
})

const base = { effectiveTargetNodeId: 'design', iteration: 0, loopIter: 0 }

describe('resolveHandlerRun', () => {
  test('null effective target → null', () => {
    expect(
      resolveHandlerRun({
        ...base,
        effectiveTargetNodeId: null,
        triggerRunId: 'r1',
        runs: [R('r1')],
      }),
    ).toBeNull()
  })

  test('null trigger → null', () => {
    expect(resolveHandlerRun({ ...base, triggerRunId: null, runs: [R('r1')] })).toBeNull()
  })

  test('trigger run is the handler', () => {
    const out = resolveHandlerRun({
      ...base,
      triggerRunId: 'r1',
      runs: [R('r1', { status: 'done', hasOutput: true })],
    })
    expect(out).toEqual({ status: 'done', startedAt: 1, hasOutput: true })
  })

  test('trigger still pending → its pending view', () => {
    const out = resolveHandlerRun({
      ...base,
      triggerRunId: 'r1',
      runs: [R('r1', { status: 'pending', startedAt: null, hasOutput: false })],
    })
    expect(out).toEqual({ status: 'pending', startedAt: null, hasOutput: false })
  })

  test('process-retry of the trigger is in-window → freshest wins', () => {
    const out = resolveHandlerRun({
      ...base,
      triggerRunId: 'r1',
      runs: [
        R('r1', { status: 'failed', hasOutput: false }),
        R('r2', { rerunCause: 'process-retry', status: 'running', hasOutput: false }),
      ],
    })
    expect(out).toEqual({ status: 'running', startedAt: 1, hasOutput: false })
  })

  test('F1: a later unrelated clarify rerun is the upper bound → EXCLUDED (stays awaiting_confirm)', () => {
    const out = resolveHandlerRun({
      ...base,
      triggerRunId: 'r1',
      runs: [
        R('r1', { status: 'done', hasOutput: true }), // our handler — done w/ output
        R('r3', { rerunCause: 'cross-clarify-answer', status: 'running', hasOutput: false }), // a NEW round's rerun
      ],
    })
    // Must return r1 (done+output), NOT r3 (running) — else the entry would be
    // dragged back to processing by an unrelated newer round.
    expect(out).toEqual({ status: 'done', startedAt: 1, hasOutput: true })
  })

  test('fanout: top-level parent is the representative, shard child ignored', () => {
    const out = resolveHandlerRun({
      ...base,
      triggerRunId: 'r1',
      runs: [
        R('r1', { status: 'running', hasOutput: false, parentNodeRunId: null }),
        R('r2', { status: 'done', hasOutput: true, parentNodeRunId: 'r1' }), // shard child
      ],
    })
    expect(out).toEqual({ status: 'running', startedAt: 1, hasOutput: false })
  })

  test('runs below the anchor (pre-clarify original) are excluded', () => {
    const out = resolveHandlerRun({
      ...base,
      triggerRunId: 'r2',
      runs: [
        R('r1', { status: 'done', hasOutput: true }), // original run before clarify
        R('r2', { status: 'running', hasOutput: false }), // the clarify-triggered handler
      ],
    })
    expect(out).toEqual({ status: 'running', startedAt: 1, hasOutput: false })
  })

  test('different node / iteration ignored → null when none match', () => {
    expect(
      resolveHandlerRun({
        ...base,
        triggerRunId: 'r1',
        runs: [R('r1', { nodeId: 'other' }), R('r2', { iteration: 1 })],
      }),
    ).toBeNull()
  })
})

// Regression for live incident 01KWDKBS9K22KB6HH4KNR3XMX6 (2026-07-09), reproduced
// at the unit level from the real node_run topology: agent_m7p3n1 @ iteration 0 has
//   K7QVYJQH64  initial         done  no-output   (asked round 0)
//   BJRF4C5G59  clarify-answer  done  no-output   (answered round 0, asked round 1)  ← anchor
//   AVY61AJPFK  clarify-answer  done  +output     (answered round 1, produced output)
// Five self questions bound to BJRF4C5G59. Its lineage window is [BJRF4C5G59,
// AVY61AJPFK): the later clarify-answer run is the UPPER BOUND (a
// NEW_CLARIFY_TRIGGER_CAUSE), so the output-producing run never enters — the handler
// is forever the done-no-output BJRF4C5G59. The board must still show those questions
// as 已处理待确认 (the answer WAS processed), not 处理中 forever.
describe('multi-round clarify strand (incident 01KWDKBS9K…): done-no-output handler → awaiting_confirm', () => {
  const runs: RunLineageView[] = [
    R('01_initial', { rerunCause: 'initial', status: 'done', hasOutput: false }),
    R('02_answered_r0', { rerunCause: 'clarify-answer', status: 'done', hasOutput: false }), // anchor
    R('03_answered_r1', { rerunCause: 'clarify-answer', status: 'done', hasOutput: true }), // upper bound
  ]

  test('the window caps at the follow-up round, keeping the done-no-output handler', () => {
    const handler = resolveHandlerRun({ ...base, triggerRunId: '02_answered_r0', runs })
    // NOT 03_answered_r1 — that later clarify-answer run is the window upper bound.
    expect(handler).toEqual({ status: 'done', startedAt: 1, hasOutput: false })
  })

  test('phase of a round-0 question is 已处理待确认, not stranded at 处理中', () => {
    const handler = resolveHandlerRun({ ...base, triggerRunId: '02_answered_r0', runs })
    const phase = deriveQuestionPhase({
      roundStatus: 'answered',
      confirmation: 'open',
      isStaged: false,
      dispatchedInFlight: false,
      handlerRun: handler,
    })
    expect(phase).toBe('awaiting_confirm')
  })
})

// RFC-172b (T2) — the optional shardKey scopes the lineage window to one fan-out shard, so a
// workgroup member's handler is NOT resolved from a SIBLING shard's run (假消费). undefined =
// shard-blind (golden-lock, byte-identical to pre-172b). Nulls collapse: a non-workgroup node's
// runs are all shardKey=null, so shardKey===null filters to exactly today's set.
describe('resolveHandlerRun — RFC-172b shardKey scoping', () => {
  // member A's anchor (pending, shard A) + a sibling member B run (done, shard B, HIGHER id). The
  // sibling has a NON-trigger cause (null) so it sits INSIDE the lineage window (a clarify-cause
  // sibling would be the window UPPER BOUND and excluded regardless — the masking bug needs an
  // in-window sibling).
  const memberA = R('r1', { status: 'pending', startedAt: null, hasOutput: false, shardKey: 'A' })
  const siblingB = R('r2', { rerunCause: null, status: 'done', hasOutput: true, shardKey: 'B' })

  test("shardKey='A' excludes the sibling B run → A's own (pending) is the handler", () => {
    const out = resolveHandlerRun({
      ...base,
      triggerRunId: 'r1',
      runs: [memberA, siblingB],
      shardKey: 'A',
    })
    expect(out).toEqual({ status: 'pending', startedAt: null, hasOutput: false })
  })

  test('golden-lock: undefined is shard-blind → the higher-id sibling B (done) masks A (今日行为)', () => {
    const out = resolveHandlerRun({ ...base, triggerRunId: 'r1', runs: [memberA, siblingB] })
    // sibling B (id r2 > anchor r1, top-level, in window) is freshest → its done view wins.
    expect(out).toEqual({ status: 'done', startedAt: 1, hasOutput: true })
  })

  test('shardKey=null scopes to null-shard runs (non-workgroup collapse)', () => {
    const nullRun = R('r1', { status: 'done', hasOutput: true, shardKey: null })
    const memberRun = R('r2', {
      status: 'pending',
      startedAt: null,
      hasOutput: false,
      shardKey: 'A',
    })
    // null-shard resolution ignores the member run entirely → the null-shard done is the handler.
    const out = resolveHandlerRun({
      ...base,
      triggerRunId: 'r1',
      runs: [nullRun, memberRun],
      shardKey: null,
    })
    expect(out).toEqual({ status: 'done', startedAt: 1, hasOutput: true })
  })
})
