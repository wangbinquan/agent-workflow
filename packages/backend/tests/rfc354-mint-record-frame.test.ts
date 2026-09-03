// RFC-354 — the frame fields of a minted node_runs row (`buildNodeRunMintRecord`, pure).
//
// Locks the regression found by rfc354-nested-loop-frames.test.ts on the first
// real nested run: the scheduler re-mints a body row for outer round 2 from
// the round-1 row (`inheritFrom`) with an EXPLICIT new `containerRunId`, and
// the breadcrumb must follow the new generation — `scopePath` is derived by
// the adapter from the container row, never copied from the inherited row
// (it also encodes the row's own round, so even a same-generation re-mint at
// another iteration would go stale).

import { describe, expect, test } from 'bun:test'
import { buildNodeRunMintRecord } from '../src/modules/task-execution/application/buildNodeRunMintRecord'

const inherited = {
  reviewIteration: 0,
  shardKey: null,
  parentNodeRunId: null,
  containerRunId: 'GEN-1',
  scopePath: 'oloop:0/iloop:0',
  preSnapshot: null,
}

function mint(over: Record<string, unknown>) {
  return buildNodeRunMintRecord({
    taskId: 'T',
    nodeId: 'worker',
    status: 'pending',
    cause: 'initial',
    iteration: 0,
    ...over,
  })
}

describe('RFC-354 — mint record frame fields', () => {
  test('an explicit containerRunId wins over the inherited row and leaves scopePath to be derived', () => {
    const record = mint({ containerRunId: 'GEN-2', iteration: 1, inheritFrom: inherited })
    expect(record.containerRunId).toBe('GEN-2')
    expect(record.scopePath).toBeNull()
  })

  test("with no explicit frame the row stays in the inherited row's generation — breadcrumb still derived", () => {
    const record = mint({ inheritFrom: inherited })
    expect(record.containerRunId).toBe('GEN-1')
    // Not 'oloop:0/iloop:0' copied from the source row: the adapter re-derives it
    // from GEN-1 and THIS row's iteration.
    expect(record.scopePath).toBeNull()
  })

  test('an explicit scopePath is taken verbatim', () => {
    const record = mint({
      containerRunId: 'GEN-2',
      scopePath: 'oloop:1/iloop:0',
      inheritFrom: inherited,
    })
    expect(record.scopePath).toBe('oloop:1/iloop:0')
  })

  test('the top scope is containerRunId null + empty breadcrumb, even when inheriting from a nested row', () => {
    const record = mint({ containerRunId: null, inheritFrom: inherited })
    expect(record.containerRunId).toBeNull()
    expect(record.scopePath).toBe('')
    const plain = mint({})
    expect(plain.containerRunId).toBeNull()
    expect(plain.scopePath).toBe('')
  })
})
