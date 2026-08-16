// RFC-306 — two things that are easy to get subtly wrong and impossible to
// notice afterwards:
//
//   1. how each LOOP exit condition answers an INACTIVE port (design §8). The
//      asymmetry was decided explicitly (D14′), not derived, so it is pinned
//      here rule by rule. In particular `port-empty` must stay TRUE for an
//      inactive port: a loop written before branches existed, whose body later
//      learns to close a branch, must still exit instead of grinding to
//      max_iterations and failing.
//
//   2. that a skip is REVERSIBLE (D10 / AC-10). `isDispatchable` treats a
//      skipped row exactly like a done one — fresh stays put, stale re-runs —
//      which is what lets retrying the deciding node re-open a closed branch.
//      If this regresses, a skip silently becomes a dead end that only a brand
//      new task can escape.

import { describe, expect, test } from 'bun:test'
import { evaluateExitCondition, parseExitCondition } from '../src/services/exitCondition'
import { isDispatchable } from '../src/services/dispatchFrontier'
import type { nodeRuns } from '../src/db/schema'
import type { WorkflowDefinition } from '@agent-workflow/shared'

type Row = typeof nodeRuns.$inferSelect

const ACTIVE = { content: 'x', active: true }
const INACTIVE = { content: 'reason text', active: false }

describe('RFC-306 §8 — exit conditions vs an inactive port', () => {
  const at = (kind: string, extra: Record<string, unknown> = {}) =>
    parseExitCondition({ kind, nodeId: 'n', portName: 'p', ...extra })!

  test('port-inactive is TRUE exactly when the port is inactive', () => {
    expect(evaluateExitCondition(at('port-inactive'), INACTIVE)).toBe(true)
    expect(evaluateExitCondition(at('port-inactive'), ACTIVE)).toBe(false)
    // Even an ACTIVE-but-empty port is not "inactive" — the two are different
    // facts, which is why this kind exists alongside port-empty.
    expect(evaluateExitCondition(at('port-inactive'), { content: '', active: true })).toBe(false)
  })

  test('port-empty ACCEPTS an inactive port (D14′ back-compat hinge)', () => {
    expect(evaluateExitCondition(at('port-empty'), INACTIVE)).toBe(true)
  })

  test('the other three refuse an inactive port', () => {
    expect(evaluateExitCondition(at('port-not-empty'), INACTIVE)).toBe(false)
    expect(evaluateExitCondition(at('port-equals', { value: 'reason text' }), INACTIVE)).toBe(false)
    expect(evaluateExitCondition(at('port-count-lt', { n: 5 }), INACTIVE)).toBe(false)
  })

  test('with an ACTIVE port every rule behaves exactly as before RFC-306', () => {
    expect(evaluateExitCondition(at('port-empty'), { content: '  ', active: true })).toBe(true)
    expect(evaluateExitCondition(at('port-empty'), { content: 'x', active: true })).toBe(false)
    expect(evaluateExitCondition(at('port-not-empty'), { content: 'x', active: true })).toBe(true)
    expect(evaluateExitCondition(at('port-equals', { value: 'x' }), ACTIVE)).toBe(true)
    expect(
      evaluateExitCondition(at('port-count-lt', { n: 2 }), { content: 'a\nb', active: true }),
    ).toBe(false)
  })

  test('port-inactive round-trips through parseExitCondition', () => {
    expect(parseExitCondition({ kind: 'port-inactive', nodeId: 'n', portName: 'p' })).toEqual({
      kind: 'port-inactive',
      nodeId: 'n',
      portName: 'p',
    })
    // Malformed stays malformed (the wrapper hard-fails on null).
    expect(parseExitCondition({ kind: 'port-inactive', nodeId: '', portName: 'p' })).toBeNull()
  })
})

describe('RFC-306 D10 — a skip is reversible, not terminal', () => {
  const row = (over: Partial<Row> = {}): Row =>
    ({
      id: '01A',
      status: 'skipped',
      consumedUpstreamRunsJson: null,
      supersededByReview: null,
      mergeState: null,
      iteration: 0,
      nodeId: 'n',
      parentNodeRunId: null,
      ...over,
    }) as Row

  const definition: WorkflowDefinition = {
    $schema_version: 1,
    inputs: [],
    nodes: [{ id: 'n', kind: 'agent-single' }],
    edges: [],
  } as unknown as WorkflowDefinition

  test('a FRESH skip stays put (no busy loop)', () => {
    const skipped = row({ consumedUpstreamRunsJson: JSON.stringify({ up: '01UP' }) })
    const freshest = new Map<string, Row>([
      ['up', row({ id: '01UP', nodeId: 'up', status: 'done' })],
    ])
    expect(isDispatchable(skipped, 'agent-single', freshest, [skipped], definition)).toBe(false)
  })

  test('a STALE skip re-dispatches — this is what re-opens a closed branch', () => {
    const skipped = row({ consumedUpstreamRunsJson: JSON.stringify({ up: '01UP' }) })
    // The upstream re-ran: a newer settled row exists, so what this skip decided
    // against is no longer the current answer.
    const freshest = new Map<string, Row>([
      ['up', row({ id: '01UP2', nodeId: 'up', status: 'done' })],
    ])
    expect(isDispatchable(skipped, 'agent-single', freshest, [skipped], definition)).toBe(true)
  })

  test('exhausted stays terminal — the two must not be confused', () => {
    const ex = row({ status: 'exhausted' })
    expect(isDispatchable(ex, 'wrapper-loop', new Map(), [ex], definition)).toBe(false)
  })
})
