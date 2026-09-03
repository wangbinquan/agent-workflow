// RFC-076 PR-A — wrapper-fanout iteration-window lock (supplementary coverage).
//
// Regression locked here: wrapperHasFreshInnerWork / isDispatchable for the THIRD
// member of WRAPPER_KINDS — 'wrapper-fanout'. The existing dispatch-frontier.test.ts
// suite exercises only 'wrapper-loop' (progress-decoded iteration window) and
// 'wrapper-git' (own-iteration window); 'wrapper-fanout' is unexercised in the pure
// predicate suites (zero hits on `grep wrapper-fanout`).
//
// The code (dispatchFrontier.ts:95-101) branches on kind==='wrapper-loop' to decode
// the wrapper PROGRESS payload's iteration; ALL other wrapper kinds (git AND fanout)
// fall through to the ELSE branch and use wrapperRow.iteration directly — any
// wrapperProgressJson is IGNORED for non-loop wrappers. isDispatchable (:140-142)
// routes a parked wrapper-fanout into wrapperHasFreshInnerWork because
// WRAPPER_KINDS.has('wrapper-fanout') === true.
//
// This is the "fan-out nested inside a loop" resume combo: it hinges on the
// "use own iteration, ignore progress" rule for the fanout. If a refactor ever
// (a) drops wrapper-fanout from WRAPPER_KINDS, or (b) starts decoding progress for
// fanout, these tests go red. Mirror the harness in dispatch-frontier.test.ts.

import { describe, expect, test } from 'bun:test'
import type { NodeKind, WorkflowDefinition } from '@agent-workflow/shared'
import type { nodeRuns } from '../src/db/schema'
import { isDispatchable, wrapperHasFreshInnerWork } from '../src/services/dispatchFrontier'
import { encodeWrapperProgress } from '../src/modules/task-execution/domain/wrapperProgress'

type Row = typeof nodeRuns.$inferSelect

// Minimal node-run row factory (identical shape to dispatch-frontier.test.ts).
function run(over: Partial<Row>): Row {
  return {
    id: '01R',
    nodeId: 'n',
    iteration: 0,
    status: 'done',
    consumedUpstreamRunsJson: null,
    wrapperProgressJson: null,
    ...over,
  } as unknown as Row
}

const NO_FRESH = new Map<string, Row>()

// Minimal WorkflowDefinition: only .nodes (id/kind/nodeIds) is read.
function def(nodes: Array<{ id: string; kind: NodeKind; nodeIds?: string[] }>): WorkflowDefinition {
  return { nodes, edges: [] } as unknown as WorkflowDefinition
}

describe('RFC-076 PR-A — wrapper-fanout uses own iteration (progress ignored)', () => {
  const fanoutDef = def([
    { id: 'fw', kind: 'wrapper-fanout', nodeIds: ['a'] },
    { id: 'a', kind: 'agent-single' },
  ])

  // A wrapper-fanout carrying a loop-style progress payload (iteration:9) but whose
  // OWN row iteration is 3. The fanout takes the ELSE branch (not wrapper-loop), so
  // it scans inner descendants at iteration 3 — the progress value 9 is ignored.
  function fanoutAwaitingRow(): Row {
    return run({
      nodeId: 'fw',
      iteration: 3,
      status: 'awaiting_review',
      // loop-style progress deliberately points at a DIFFERENT iteration (9); for a
      // wrapper-fanout it must never be decoded.
      wrapperProgressJson: encodeWrapperProgress({
        kind: 'loop',
        iteration: 9,
        phase: 'awaiting',
      }),
    })
  }

  test('inner pending at wrapperRow.iteration (3) → true (own iteration, NOT progress 9)', () => {
    const wrapperRow = fanoutAwaitingRow()
    const rows = [
      wrapperRow,
      run({
        id: '01P',
        nodeId: 'a',
        status: 'pending',
        iteration: 3,
        containerRunId: wrapperRow.id,
      }),
    ]
    expect(wrapperHasFreshInnerWork(wrapperRow, rows, fanoutDef)).toBe(true)
  })

  test('inner pending at progress.iteration (9) instead of 3 → false (progress ignored)', () => {
    const wrapperRow = fanoutAwaitingRow()
    const rows = [wrapperRow, run({ id: '01P', nodeId: 'a', status: 'pending', iteration: 9 })]
    expect(wrapperHasFreshInnerWork(wrapperRow, rows, fanoutDef)).toBe(false)
  })

  test('isDispatchable(awaiting_review wrapper-fanout) routes to wrapperHasFreshInnerWork → true', () => {
    const wrapperRow = fanoutAwaitingRow()
    const rows = [
      wrapperRow,
      run({
        id: '01P',
        nodeId: 'a',
        status: 'pending',
        iteration: 3,
        containerRunId: wrapperRow.id,
      }),
    ]
    // WRAPPER_KINDS.has('wrapper-fanout') === true → routes into the wrapper carve-out;
    // inner pending at the wrapper's own iteration (3) makes it dispatchable.
    expect(isDispatchable(wrapperRow, 'wrapper-fanout', NO_FRESH, rows, fanoutDef)).toBe(true)
  })

  test('isDispatchable wrapper-fanout with inner pending only at progress iteration (9) → false', () => {
    const wrapperRow = fanoutAwaitingRow()
    const rows = [wrapperRow, run({ id: '01P', nodeId: 'a', status: 'pending', iteration: 9 })]
    expect(isDispatchable(wrapperRow, 'wrapper-fanout', NO_FRESH, rows, fanoutDef)).toBe(false)
  })
})
