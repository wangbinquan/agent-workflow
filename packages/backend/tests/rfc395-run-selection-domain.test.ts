// RFC-395 II-a A3：锁住槽位、选择变更和旧 attempt/role 规则；不把迁移推导当作消费事实。
import { describe, expect, test } from 'bun:test'
import { RERUN_CAUSES, compareNodeRunMintOrder } from '@agent-workflow/shared'
import {
  deriveNodeRunRole,
  type NodeRunRoleFacts,
  type NodeRunSyntheticKind,
} from '@/modules/task-execution/domain/nodeRunRole'
import { nodeRunAttemptIndex } from '@/modules/task-execution/domain/nodeRunAttempt'
import { nextRetryIndex } from '@/modules/task-execution/application/nextRetryIndex'
import { nextRetryIndex as frozenNextRetryIndex } from './helpers/model/frozenSelection/nextRetryIndex'
import {
  encodeRunSlot,
  decodeRunSlot,
  runSlotsEqual,
  type RunSlot,
} from '@/modules/task-execution/domain/runSelection/slots'
import {
  compareRunSequence,
  aggregatorInputsMatch,
} from '@/modules/task-execution/domain/runSelection/ordering'
import {
  applySelectionChanges,
  validateSelectionChange,
  type SelectionChange,
  type SelectionState,
} from '@/modules/task-execution/domain/runSelection/changes'
import { createRunSelectionParticipantInTx } from '@/modules/task-execution/infrastructure/runSelection/oracle/participant'

const slots: readonly RunSlot[] = [
  { kind: 'node', nodeId: 'n|["汉字"]', frame: { containerRunId: null, iteration: 0 } },
  { kind: 'container', nodeId: 'nested', frame: { containerRunId: 'outer', iteration: 2 } },
  { kind: 'shard', nodeId: 'inner', iteration: 1, shardKey: 'a\u0000b' },
  { kind: 'shard', nodeId: 'shared', iteration: 1, shardKey: null },
  { kind: 'aggregator', nodeId: 'agg', iteration: 1 },
  {
    kind: 'synthetic',
    owner: { kind: 'task', id: 't' },
    syntheticKind: 'repo-prep',
    discriminator: '__repo_prep__',
  },
  {
    kind: 'synthetic',
    owner: { kind: 'attempt', id: 'owner' },
    syntheticKind: 'commit-session',
    discriminator: '__commit_push__:n:repo',
  },
  { kind: 'workgroup-host', nodeId: '__wg_member__', shardKey: 'msg:x' },
]

function random(seed: number) {
  let value = seed >>> 0
  return (max: number) => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0
    return value % max
  }
}

describe('RFC-395 II-a A3 rs1 / ordering', () => {
  test.each(slots)('canonical round trip: %j', (slot) => {
    const encoded = encodeRunSlot(slot)
    expect(decodeRunSlot(encoded)).toEqual(slot)
    expect(encodeRunSlot(decodeRunSlot(encoded))).toBe(encoded)
    expect(runSlotsEqual(slot, decodeRunSlot(encoded))).toBe(true)
  })
  test('keys are unambiguous and exclude review / retry / outer fanout frame', () => {
    const next = random(395)
    for (let i = 0; i < 100; i += 1) {
      const nodeId = ['a|b', '汉字', '"quoted"', 'a\u0000b'][next(4)]!
      const slot: RunSlot = { kind: 'shard', nodeId, iteration: next(8), shardKey: `${next(9)}|x` }
      expect(runSlotsEqual(slot, decodeRunSlot(encodeRunSlot(slot)))).toBe(true)
      expect(encodeRunSlot({ ...slot, containerRunId: 'old', reviewIteration: 7 } as RunSlot)).toBe(
        encodeRunSlot(slot),
      )
    }
    expect(new Set(slots.map(encodeRunSlot)).size).toBe(slots.length)
    expect(
      runSlotsEqual(
        { kind: 'shard', nodeId: 'n', iteration: 0, shardKey: null },
        { kind: 'shard', nodeId: 'n', iteration: 0, shardKey: '' },
      ),
    ).toBe(false)
    expect(
      encodeRunSlot({ kind: 'node', nodeId: 'n', frame: { containerRunId: null, iteration: 0 } }),
    ).toBe('["rs1","node","n",null,0]')
  })
  test.each([
    '{}',
    'null',
    '[]',
    '["rs2","node","n",null,0]',
    '["rs1","unknown"]',
    '["rs1","node","n",null,-1]',
    '["rs1","node","n",null,0.5]',
    '["rs1","node","n",null,-0]',
    '["rs1","node","n",null,0,1]',
    '[ "rs1", "aggregator", "a", 0 ]',
    '["rs1","synthetic","task","t","unknown",""]',
    '["rs1","shard","n",0,1]',
    '["rs1","node","n",null,9007199254740992]',
  ])('reject noncanonical or invalid key: %s', (encoded) => {
    expect(() => decodeRunSlot(encoded)).toThrow('invalid-run-slot')
  })
  test('seq is the only target order, including negative seq; legacy NULL belongs to oracle', () => {
    const a = { seq: -20, id: 'z', retryIndex: 99, startedAt: 100 }
    const b = { seq: -2, id: 'a', retryIndex: 0, startedAt: 1 }
    expect(compareRunSequence(a, b)).toBe(-1)
    expect(compareRunSequence(a, { ...b, seq: -20 })).toBe(0)
    expect(() => compareRunSequence({ seq: null as unknown as number }, b)).toThrow(
      'run-sequence-required',
    )
    expect(compareNodeRunMintOrder({ id: 'z', seq: null }, b)).toBe(-1)
  })
})

describe('RFC-395 II-a A3 stored role facts', () => {
  const synthetic: readonly [NodeRunRoleFacts, NodeRunSyntheticKind][] = [
    [{ nodeId: '__repo_prep__', rerunCause: 'revival' }, 'repo-prep'],
    [{ nodeId: '__commit_push__:n:repo', rerunCause: 'commit-push' }, 'commit-push'],
    [{ nodeId: '__commit_push__:n:repo', rerunCause: 'commit-push-session' }, 'commit-session'],
    [{ nodeId: '__merge_resolve__:n' }, 'merge-resolve'],
    [{ nodeId: '__dw_orchestrator__', rerunCause: 'dw-gate' }, 'dw-gate'],
    [{ nodeId: '__wg_leader__', rerunCause: 'wg-gate' }, 'wg-gate'],
    [{ nodeId: '__dw_orchestrator__', rerunCause: 'dw-generate' }, 'dw-orchestrator'],
    [{ nodeId: '__wg_leader__', rerunCause: 'wg-leader-round' }, 'workgroup-host'],
    [{ nodeId: '__wg_member__', rerunCause: 'wg-protocol-retry' }, 'workgroup-host'],
    [{ nodeId: '__wg_clarify__', rerunCause: 'clarify-answer' }, 'workgroup-host'],
  ]
  test.each(synthetic)('%j derives %s', (facts, syntheticKind) => {
    expect(deriveNodeRunRole(facts)).toEqual({ role: 'synthetic', syntheticKind })
    expect(deriveNodeRunRole({ ...facts, hasContainerChildren: true })).toEqual({
      role: 'synthetic',
      syntheticKind,
    })
  })
  test('wrapper proof is cause, progress or container reference; parent alone proves nothing', () => {
    for (const facts of [
      { nodeId: 'wrapper', rerunCause: 'wrapper-init' },
      { nodeId: 'wrapper', rerunCause: 'retry-node', wrapperProgressJson: '{}' },
      { nodeId: 'wrapper', hasContainerChildren: true },
    ])
      expect(deriveNodeRunRole(facts)).toEqual({ role: 'container', syntheticKind: null })
    const child = { nodeId: 'ordinary', parentNodeRunId: 'p', containerRunId: 'p' }
    expect(deriveNodeRunRole(child)).toEqual({ role: 'node-attempt', syntheticKind: null })
  })
  test('every non-synthetic cause keeps ordinary graph nodes as attempts', () => {
    const special = new Set([
      'wrapper-init',
      'commit-push',
      'commit-push-session',
      'merge-resolve',
      'dw-gate',
      'wg-gate',
      'dw-generate',
    ])
    for (const rerunCause of RERUN_CAUSES.filter((cause) => !special.has(cause)))
      expect(deriveNodeRunRole({ nodeId: 'graph-node', rerunCause })).toEqual({
        role: 'node-attempt',
        syntheticKind: null,
      })
    expect(deriveNodeRunRole({ nodeId: '__user_node__' }).role).toBe('node-attempt')
  })
})

describe('RFC-395 II-a A3 G8 allocation parity', () => {
  test('scheduler / retry / prep / clarify / review max+1 retain their exact row scopes', () => {
    const next = random(6)
    for (let sample = 0; sample < 80; sample += 1) {
      const rows = Array.from({ length: next(20) }, () => ({
        retryIndex: next(18) - 3,
        iteration: next(3),
        parentNodeRunId: next(2) === 0 ? null : 'parent',
      }))
      for (const opts of [
        {},
        { topLevelOnly: true },
        { topLevelOnly: true, iteration: 1 },
        { iteration: 2 },
      ]) {
        const prior = frozenNextRetryIndex(rows, opts)
        expect(nodeRunAttemptIndex({ kind: 'max-plus-one', rows, ...opts })).toBe(prior)
        expect(nextRetryIndex(rows, opts)).toBe(prior)
      }
      if (rows[0] !== undefined)
        expect(nodeRunAttemptIndex({ kind: 'max-plus-one', rows: [rows[0]] })).toBe(
          frozenNextRetryIndex([rows[0]]),
        )
    }
  })
  test('script / host offsets, agent absolute attempts, fanout fallback, gate zero and DW count stay distinct', () => {
    for (let base = 0; base < 8; base += 1)
      for (let offset = 0; offset < 5; offset += 1) {
        expect(nodeRunAttemptIndex({ kind: 'offset', base, offset })).toBe(base + offset)
        expect(nodeRunAttemptIndex({ kind: 'explicit', attempt: base + offset })).toBe(
          base + offset,
        )
        expect(nodeRunAttemptIndex({ kind: 'count', count: base })).toBe(base)
      }
    expect(nodeRunAttemptIndex({ kind: 'explicit' })).toBe(0)
    expect(nodeRunAttemptIndex({ kind: 'explicit', attempt: 0 })).toBe(0)
    expect(
      nodeRunAttemptIndex({
        kind: 'workgroup-revival',
        rows: [{ retryIndex: -5 }, { retryIndex: -3 }],
      }),
    ).toBe(-2)
    expect(
      nodeRunAttemptIndex({ kind: 'max-plus-one', rows: [{ retryIndex: -5 }, { retryIndex: -3 }] }),
    ).toBe(0)
  })
})

function selection(
  slot: RunSlot,
  id: string,
  extra: Partial<NonNullable<SelectionState['run']>> = {},
): SelectionChange {
  return {
    kind: 'select',
    taskId: 't',
    slot,
    expectedRevision: 0,
    generationSeq: 0,
    cause: 'test',
    run: {
      id,
      taskId: 't',
      slot,
      containerRunId: null,
      parentNodeRunId: null,
      shardKey: null,
      ...extra,
    },
  }
}

describe('RFC-395 II-a A3 selection changes', () => {
  test('clear retains revision and never invalidates another task', () => {
    const change = selection(slots[0]!, 'r')
    const other = applySelectionChanges([], [change]).map((entry) => ({
      ...entry,
      taskId: 'other',
    }))
    const state = applySelectionChanges(other, [change])
    const cleared = applySelectionChanges(state, [
      {
        kind: 'clear',
        taskId: 't',
        slot: change.slot,
        expectedRevision: 1,
        generationSeq: 2,
        cause: 'clear',
      },
    ])
    expect(cleared.find((entry) => entry.taskId === 't')?.selectedRunId).toBeNull()
    expect(cleared.find((entry) => entry.taskId === 't')?.revision).toBe(2)
    expect(cleared.find((entry) => entry.taskId === 'other')?.selectedRunId).toBe('r')
  })
  test('new attempt selects and revisions; shard-less node preserves cross-generation shard selections', () => {
    const shard: RunSlot = { kind: 'shard', nodeId: 'n', iteration: 1, shardKey: 'a' }
    const other: RunSlot = { kind: 'shard', nodeId: 'n', iteration: 2, shardKey: 'a' }
    const node: RunSlot = {
      kind: 'node',
      nodeId: 'n',
      frame: { containerRunId: 'outer', iteration: 1 },
    }
    const initial = applySelectionChanges([], [selection(shard, 's'), selection(other, 's2')])
    const state = applySelectionChanges(initial, [selection(node, 'n1')])
    expect(initial[0]?.selectedRunId).toBe('s')
    expect(state.find((entry) => runSlotsEqual(entry.slot, shard))?.selectedRunId).toBe('s')
    expect(state.find((entry) => runSlotsEqual(entry.slot, shard))?.revision).toBe(1)
    expect(state.find((entry) => runSlotsEqual(entry.slot, other))?.selectedRunId).toBe('s2')
    const next = applySelectionChanges(state, [{ ...selection(node, 'n2'), expectedRevision: 1 }])
    expect(next.find((entry) => runSlotsEqual(entry.slot, node))?.selectedRunId).toBe('n2')
  })
  test('replaced container preserves cross-generation shards and independent body frames', () => {
    const container: RunSlot = {
      kind: 'container',
      nodeId: 'w',
      frame: { containerRunId: null, iteration: 0 },
    }
    const child: RunSlot = { kind: 'shard', nodeId: 'n', iteration: 0, shardKey: 'a' }
    const deep: RunSlot = {
      kind: 'node',
      nodeId: 'deep',
      frame: { containerRunId: 's', iteration: 0 },
    }
    const body: RunSlot = {
      kind: 'node',
      nodeId: 'body',
      frame: { containerRunId: 'w1', iteration: 0 },
    }
    const state = applySelectionChanges(
      [],
      [
        selection(container, 'w1'),
        selection(body, 'loop-body', { containerRunId: 'w1', parentNodeRunId: null }),
        selection(child, 's', { parentNodeRunId: 'w1', containerRunId: 'w1', shardKey: 'a' }),
        selection(deep, 'd', { parentNodeRunId: 's', containerRunId: 's' }),
      ],
    )
    const replaced = applySelectionChanges(state, [
      { ...selection(container, 'w2'), expectedRevision: 1 },
    ])
    expect(replaced.find((entry) => runSlotsEqual(entry.slot, child))?.selectedRunId).toBe('s')
    expect(replaced.find((entry) => runSlotsEqual(entry.slot, body))?.selectedRunId).toBe(
      'loop-body',
    )
    expect(replaced.find((entry) => runSlotsEqual(entry.slot, deep))?.selectedRunId).toBe('d')
    const reused = applySelectionChanges(replaced, [
      {
        ...selection(child, 's', { containerRunId: 'w1', parentNodeRunId: 'w1', shardKey: 'a' }),
        expectedRevision: 1,
      },
    ])
    expect(reused.find((entry) => runSlotsEqual(entry.slot, child))?.selectedRunId).toBe('s')
  })
  test('invalid kind, slot/task mismatch and stale revision are rejected before state changes', () => {
    const change = selection(slots[0]!, 'r')
    expect(() =>
      validateSelectionChange({ ...change, kind: 'replace' } as unknown as SelectionChange),
    ).toThrow('invalid-selection-change-kind')
    expect(() => validateSelectionChange({ ...change, slot: slots[1]! })).toThrow(
      'selection-run-slot-mismatch',
    )
    expect(() => validateSelectionChange({ ...change, taskId: 'other' })).toThrow(
      'selection-run-slot-mismatch',
    )
    expect(() => validateSelectionChange({ ...change, expectedRevision: -1 })).toThrow(
      'invalid-selection-revision',
    )
    expect(() => applySelectionChanges(applySelectionChanges([], [change]), [change])).toThrow(
      'selection-revision-conflict',
    )
  })
  test('II-a apply reads/writes nothing and does not pretend to persist a revision', async () => {
    const tx = new Proxy(
      {},
      {
        get() {
          throw new Error('unexpected-db-access')
        },
      },
    )
    const participant = createRunSelectionParticipantInTx<object>()
    const change = selection(slots[0]!, 'r')
    const receipt = await participant.apply(tx, [change])
    expect(receipt[0]?.revision).toBe(1)
    expect(await participant.apply(tx, [change])).toEqual(receipt)
    await expect(participant.apply(tx, [{ ...change, slot: slots[1]! }])).rejects.toThrow(
      'selection-run-slot-mismatch',
    )
  })
})

describe('RFC-395 II-a A3 aggregator criterion evidence', () => {
  test('set equality equals every-shard-is-older for fixed participating slots and newly minted aggregation', () => {
    const next = random(3956)
    const shards = new Map([
      ['a', { id: 's-a', seq: -3 }],
      ['b', { id: 's-b', seq: -2 }],
    ])
    let aggregator = { id: 'agg', seq: -1 }
    let consumed = [...shards.values()].map((row) => row.id)
    for (let seq = 1; seq <= 200; seq += 1) {
      if (next(3) === 0) {
        aggregator = { id: `agg-${seq}`, seq }
        consumed = [...shards.values()].map((row) => row.id)
      } else shards.set(next(2) === 0 ? 'a' : 'b', { id: `shard-${seq}`, seq })
      expect(
        aggregatorInputsMatch(
          consumed,
          [...shards.values()].map((row) => row.id),
        ),
      ).toBe([...shards.values()].every((row) => compareNodeRunMintOrder(aggregator, row) > 0))
    }
    expect(aggregatorInputsMatch(['a', 'b', 'a'], ['b', 'a'])).toBe(true)
    expect(aggregatorInputsMatch([], [])).toBe(true)
  })
  test('today has no recorded shard set: shrinking inputs disproves unconditional equivalence', () => {
    const aggregator = { id: 'agg', seq: 3 }
    const remaining = [{ id: 'a', seq: 1 }]
    expect(remaining.every((row) => compareNodeRunMintOrder(aggregator, row) > 0)).toBe(true)
    expect(
      aggregatorInputsMatch(
        ['a', 'b'],
        remaining.map((row) => row.id),
      ),
    ).toBe(false)
  })
  test('in-place aggregator rerun can consume newer shards without advancing its mint seq', () => {
    const aggregator = { id: 'agg', seq: 3 }
    const shard = { id: 'new-shard', seq: 4 }
    expect(aggregatorInputsMatch([shard.id], [shard.id])).toBe(true)
    expect(compareNodeRunMintOrder(aggregator, shard) > 0).toBe(false)
  })
})
