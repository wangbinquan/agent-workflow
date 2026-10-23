// RFC-186 (audit design/workgroup-e2e-audit.md §5 F4) — an answered workgroup
// clarify used to re-inject into EVERY future host round forever: RFC-184 makes
// host runs write zero node_run_outputs, but the derived-aging oracle
// (isTargetNodeConsumed) only ages an entry when the target node has a done run
// WITH an output row — so host nodes never aged. Fix: a DONE top-level host run
// at id ≥ trigger is itself the produced/consumed signal for host nodes.

import { describe, expect, test } from 'bun:test'
import { isTargetNodeConsumed } from '../src/services/clarifyRerunLedger'
// RFC-395 II-a: exercise the surviving production builders and constant leaf.
import {
  WG_LEADER_NODE_ID,
  WG_MEMBER_NODE_ID,
} from '@/modules/resource-catalog/infrastructure/legacy/workgroup/constants'

type Row = Parameters<typeof isTargetNodeConsumed>[3][number]
function run(over: Partial<Row>): Row {
  return {
    seq: null,
    nodeId: 'n1',
    iteration: 0,
    parentNodeRunId: null,
    status: 'done',
    supersededByReview: null,
    id: 'r5',
    ...over,
  } as Row
}

describe('RFC-186 F4 — host clarify ages without node_run_outputs', () => {
  test('a DONE leader host run at id ≥ trigger consumes the clarify (empty outputRunIds)', async () => {
    const runs = [run({ nodeId: WG_LEADER_NODE_ID, id: 'r5' })]
    expect(await isTargetNodeConsumed(WG_LEADER_NODE_ID, 0, 'r1', runs, new Set())).toBe(true)
  })

  test('a DONE member host run too', async () => {
    const runs = [run({ nodeId: WG_MEMBER_NODE_ID, id: 'r5' })]
    expect(await isTargetNodeConsumed(WG_MEMBER_NODE_ID, 0, 'r1', runs, new Set())).toBe(true)
  })

  test('a normal node STILL requires an output row (host exception does not leak)', async () => {
    const runs = [run({ nodeId: 'n1', id: 'r5' })]
    expect(await isTargetNodeConsumed('n1', 0, 'r1', runs, new Set())).toBe(false)
    expect(await isTargetNodeConsumed('n1', 0, 'r1', runs, new Set(['r5']))).toBe(true)
  })

  test('a host run BELOW the trigger id does not consume', async () => {
    const runs = [run({ nodeId: WG_LEADER_NODE_ID, id: 'r0' })]
    expect(await isTargetNodeConsumed(WG_LEADER_NODE_ID, 0, 'r1', runs, new Set())).toBe(false)
  })

  test('an interrupted/pending host run does not consume (only done/review-canceled)', async () => {
    for (const status of ['interrupted', 'failed', 'pending', 'running'] as const) {
      const runs = [run({ nodeId: WG_LEADER_NODE_ID, id: 'r5', status })]
      expect(await isTargetNodeConsumed(WG_LEADER_NODE_ID, 0, 'r1', runs, new Set())).toBe(false)
    }
  })

  test('the inline literals match the WG_*_NODE_ID constants (leaf module avoids the import)', () => {
    expect(WG_LEADER_NODE_ID).toBe('__wg_leader__')
    expect(WG_MEMBER_NODE_ID).toBe('__wg_member__')
  })
})
