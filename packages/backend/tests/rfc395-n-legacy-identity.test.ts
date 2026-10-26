// design/RFC-395-database-target-schema-rebuild/plan.md:435: stable roles and epoch-1 neighbours.
import { describe, expect, test } from 'bun:test'
import { deriveLegacyNodeRunIdentity } from '@/modules/task-execution/domain/runSelection/legacyIdentity'
import type {
  FrozenRunNode,
  LegacyNodeRunFacts,
  LegacyNodeRunRow,
  LegacyRunWriterFact,
} from '@/modules/task-execution/domain/runSelection/legacyFacts'
import {
  nodeRunSlotKeyForMint,
  type NodeRunMintSlotFacts,
} from '@/modules/task-execution/domain/runSelection/mintIdentity'
import { encodeCanonicalRunSlot } from '@/modules/task-execution/domain/runSelection/slotKey'
import {
  runSlotInFamily,
  type RunFamily,
} from '@/modules/task-execution/domain/runSelection/families'
import type { RunSlot } from '@/modules/task-execution/domain/runSelection/slots'

function row(patch: Partial<LegacyNodeRunRow> = {}): LegacyNodeRunRow {
  return {
    id: 'r',
    taskId: 't',
    nodeId: 'n',
    parentNodeRunId: null,
    containerRunId: null,
    iteration: 0,
    shardKey: null,
    rerunCause: null,
    ...patch,
  }
}

function facts(
  nodes: readonly FrozenRunNode[] = [{ id: 'n', kind: 'agent-single' }],
): LegacyNodeRunFacts {
  return { task: { id: 't', subject: 'workflow', engine: 'dag', definition: { nodes } } }
}

function writer(
  target: LegacyNodeRunRow,
  kind: LegacyRunWriterFact['writer'],
): LegacyRunWriterFact {
  return {
    runId: target.id,
    taskId: target.taskId,
    writer: kind,
    evidence: [`persisted-operation:${target.id}`],
  }
}

function expectIdentity(
  target: LegacyNodeRunRow,
  context: LegacyNodeRunFacts,
  expected: NodeRunMintSlotFacts,
) {
  const actual = deriveLegacyNodeRunIdentity(target, context)
  expect(actual).toMatchObject({
    ...expected,
    recordMode: 'executable',
    provenanceQuality: 'legacy-derived',
  })
  expect(actual.evidence.missingFacts).toEqual([])
  expect(actual.evidence.conflicts).toEqual([])
  expect(actual.slot).not.toBeNull()
  expect(encodeCanonicalRunSlot(actual.slot!)).toBe(nodeRunSlotKeyForMint(expected))
  expect(actual.evidence.source).toEqual(target)
  return actual
}

function expectHistory(
  target: LegacyNodeRunRow,
  context: LegacyNodeRunFacts,
  path: string,
  conflict = false,
) {
  const actual = deriveLegacyNodeRunIdentity(target, context)
  expect(actual).toMatchObject({
    role: null,
    syntheticKind: null,
    slot: null,
    family: null,
    recordMode: 'history-only',
    provenanceQuality: 'unknown',
  })
  expect(conflict ? actual.evidence.conflicts : actual.evidence.missingFacts).toContain(path)
  expect(actual.evidence.source).toEqual(target)
  return actual
}

describe('RFC-395 N-domain frozen wrapper and ordinary kinds', () => {
  for (const kind of ['wrapper-git', 'wrapper-loop', 'wrapper-fanout'] as const)
    for (const rerunCause of [
      null,
      'wrapper-init',
      'retry-node',
      'review-reject',
      'review-iterate',
      'cascade-placeholder',
    ])
      test(`${kind} ${rerunCause ?? 'NULL'} remains a container without progress or children`, () => {
        const target = row({ nodeId: 'w', rerunCause, wrapperProgressJson: null })
        expectIdentity(target, facts([{ id: 'w', kind, nodeIds: [] }]), {
          role: 'container',
          syntheticKind: null,
          slot: { kind: 'container', nodeId: 'w', frame: { containerRunId: null, iteration: 0 } },
        })
      })

  test('nested wrapper uses its outer frame, not its own generation id', () => {
    const outer = row({ id: 'outer-generation', nodeId: 'outer' })
    const target = row({
      nodeId: 'inner',
      containerRunId: outer.id,
      iteration: 2,
      rerunCause: 'review-iterate',
    })
    expectIdentity(
      target,
      {
        ...facts([
          { id: 'outer', kind: 'wrapper-loop', nodeIds: ['inner'] },
          { id: 'inner', kind: 'wrapper-git', nodeIds: [] },
        ]),
        container: { row: outer },
      },
      {
        role: 'container',
        syntheticKind: null,
        slot: {
          kind: 'container',
          nodeId: 'inner',
          frame: { containerRunId: outer.id, iteration: 2 },
        },
      },
    )
  })

  test.each([
    '__repo_prep__',
    '__commit_push__',
    '__commit_push__:n',
    '__merge_resolve__:n',
    '__dw_orchestrator__',
    '__wg_leader__',
    '__wg_member__',
    '__wg_clarify__',
  ])('user node %s is never a system row by id or cause', (nodeId) => {
    for (const rerunCause of [null, 'commit-push-session', 'dw-gate', 'wg-gate', 'wrapper-init'])
      expectIdentity(
        row({ nodeId, rerunCause, wrapperProgressJson: '{}' }),
        facts([{ id: nodeId, kind: 'agent-single' }]),
        {
          role: 'node-attempt',
          syntheticKind: null,
          slot: { kind: 'node', nodeId, frame: { containerRunId: null, iteration: 0 } },
        },
      )
  })

  test('turn-engine __wg_clarify__ park is an ordinary clarify node', () => {
    const context = facts([{ id: '__wg_clarify__', kind: 'clarify' }])
    expectIdentity(
      row({ nodeId: '__wg_clarify__', rerunCause: 'clarify-park' }),
      { task: { ...context.task!, subject: 'workgroup', engine: 'workgroup-turns' } },
      {
        role: 'node-attempt',
        syntheticKind: null,
        slot: {
          kind: 'node',
          nodeId: '__wg_clarify__',
          frame: { containerRunId: null, iteration: 0 },
        },
      },
    )
  })

  test('ordinary loop body frame and review reruns retain one immutable slot', () => {
    const outer = row({ id: 'g', nodeId: 'loop' })
    const context = {
      ...facts([
        { id: 'loop', kind: 'wrapper-loop', nodeIds: ['review'] },
        { id: 'review', kind: 'review' },
      ]),
      container: { row: outer },
    }
    const keys = [0, 1, 9].map((reviewIteration) => {
      const actual = expectIdentity(
        row({
          nodeId: 'review',
          containerRunId: 'g',
          iteration: 3,
          reviewIteration,
          rerunCause: 'review-iterate',
        }),
        context,
        {
          role: 'node-attempt',
          syntheticKind: null,
          slot: { kind: 'node', nodeId: 'review', frame: { containerRunId: 'g', iteration: 3 } },
        },
      )
      return encodeCanonicalRunSlot(actual.slot!)
    })
    expect(new Set(keys).size).toBe(1)
  })
})

function fanoutContext(generation: string): LegacyNodeRunFacts {
  const wrapper = row({ id: generation, nodeId: 'fanout' })
  const context = facts([
    { id: 'fanout', kind: 'wrapper-fanout', nodeIds: ['shared', 'inner', 'agg'] },
    ...['shared', 'inner', 'agg'].map((id) => ({ id, kind: 'agent-single' as const })),
  ])
  return {
    ...context,
    task: {
      ...context.task!,
      fanouts: [
        {
          wrapperNodeId: 'fanout',
          perShardNodeIds: ['inner'],
          sharedNodeIds: ['shared'],
          aggregatorNodeId: 'agg',
          evidence: ['frozen-definition:fanout', 'frozen-agent-role:agg'],
        },
      ],
    },
    parent: { row: wrapper },
    container: { row: wrapper },
  }
}

describe('RFC-395 N-domain fanout topology, not cause heuristics', () => {
  test.each([
    ['shared', null, 'shard'],
    ['inner', '', 'shard'],
    ['inner', '汉字|🙂', 'shard'],
    ['agg', null, 'aggregator'],
  ] as const)(
    '%s / %s / %s ignores outer generation and mutable cause',
    (nodeId, shardKey, kind) => {
      const keys = new Set<string>()
      for (const generation of ['g0', 'g1'])
        for (const rerunCause of [null, 'retry-node', 'fanout-shard', 'fanout-aggregator']) {
          const target = row({
            nodeId,
            shardKey,
            parentNodeRunId: generation,
            containerRunId: generation,
            iteration: 2,
            rerunCause,
          })
          const slot: RunSlot =
            kind === 'shard'
              ? { kind, nodeId, shardKey, iteration: 2 }
              : { kind, nodeId, iteration: 2 }
          const actual = expectIdentity(target, fanoutContext(generation), {
            role: 'node-attempt',
            syntheticKind: null,
            slot,
          })
          expect(actual.evidence.references).toContain('frozen-agent-role:agg')
          keys.add(encodeCanonicalRunSlot(actual.slot!))
        }
      expect(keys.size).toBe(1)
    },
  )

  test('NULL shard key under fanout cannot choose broadcast versus aggregator without topology', () => {
    const context = fanoutContext('g')
    expectHistory(
      row({
        nodeId: 'shared',
        parentNodeRunId: 'g',
        containerRunId: 'g',
        rerunCause: 'fanout-shard',
      }),
      { ...context, task: { ...context.task!, fanouts: undefined } },
      'fanout.topology:fanout',
    )
  })

  test('per-shard missing key and shared/aggregator concrete keys retain evidence', () => {
    expectHistory(
      row({ nodeId: 'inner', parentNodeRunId: 'g', containerRunId: 'g' }),
      fanoutContext('g'),
      'fanout.per-shard-key',
    )
    for (const nodeId of ['shared', 'agg'])
      expectHistory(
        row({ nodeId, shardKey: '', parentNodeRunId: 'g', containerRunId: 'g' }),
        fanoutContext('g'),
        'fanout.shard-key',
        true,
      )
  })

  test('contradictory or unrecorded frozen topology is not accepted', () => {
    const context = fanoutContext('g')
    const topology = context.task!.fanouts![0]!
    const target = row({ nodeId: 'shared', parentNodeRunId: 'g', containerRunId: 'g' })
    expectHistory(
      target,
      { ...context, task: { ...context.task!, fanouts: [{ ...topology, evidence: [] }] } },
      'fanout.topology.evidence',
    )
    expectHistory(
      target,
      {
        ...context,
        task: { ...context.task!, fanouts: [{ ...topology, aggregatorNodeId: 'shared' }] },
      },
      'fanout.topology.membership',
      true,
    )
    expectHistory(
      target,
      { ...context, task: { ...context.task!, fanouts: [topology, topology] } },
      'fanout.topology.duplicate',
      true,
    )
    expectHistory({ ...target, shardKey: undefined }, context, 'row.shardKey')
    expectHistory(
      { ...target, containerRunId: 'g-other' },
      { ...context, container: { row: row({ id: 'g-other', nodeId: 'fanout' }) } },
      'fanout.parent-container',
      true,
    )
  })
})

describe('RFC-395 N-domain actual system writers and structural sessions', () => {
  test.each([
    ['repository-preparation', 'repo-prep'],
    ['commit-push', 'commit-push'],
    ['merge-resolution', 'merge-resolve'],
  ] as const)('%s maps to %s with explicit task or attempt owner', (kind, syntheticKind) => {
    for (const parentNodeRunId of [null, 'owner']) {
      const parent = row({ id: 'owner' })
      const target = row({ nodeId: 'writer-chosen-id|🙂', parentNodeRunId })
      expectIdentity(
        target,
        {
          ...facts(),
          writer: writer(target, kind),
          ...(parentNodeRunId === null ? {} : { parent: { row: parent } }),
        },
        {
          role: 'synthetic',
          syntheticKind,
          slot: {
            kind: 'synthetic',
            owner:
              parentNodeRunId === null
                ? { kind: 'task', id: 't' }
                : { kind: 'attempt', id: parentNodeRunId },
            syntheticKind,
            discriminator: target.nodeId,
          },
        },
      )
    }
  })

  test.each([
    ['dw-gate', 'dw-gate'],
    ['dw-generate', 'dw-orchestrator'],
  ] as const)('dynamic operation %s keeps %s separate', (rerunCause, syntheticKind) => {
    const target = row({ nodeId: '__dw_orchestrator__', rerunCause })
    expectIdentity(
      target,
      {
        task: { ...facts([]).task!, subject: 'workgroup', engine: 'dw-generate' },
        writer: writer(target, 'dynamic-workflow'),
      },
      {
        role: 'synthetic',
        syntheticKind,
        slot: {
          kind: 'synthetic',
          owner: { kind: 'task', id: 't' },
          syntheticKind,
          discriminator: target.nodeId,
        },
      },
    )
  })

  test.each([null, 'commit-push-session', 'retry-node'])(
    'commit session with cause %s is proved by its parent, not its name',
    (rerunCause) => {
      const parent = row({ id: 'commit', nodeId: 'system-commit', parentNodeRunId: 'owner' })
      const target = row({ nodeId: 'session-any-name', parentNodeRunId: parent.id, rerunCause })
      expectIdentity(
        target,
        { ...facts(), parent: { row: parent, writer: writer(parent, 'commit-push') } },
        {
          role: 'synthetic',
          syntheticKind: 'commit-session',
          slot: {
            kind: 'synthetic',
            owner: { kind: 'attempt', id: 'commit' },
            syntheticKind: 'commit-session',
            discriminator: target.nodeId,
          },
        },
      )
    },
  )

  test('identical NULL-cause child under a user commit-push-named parent is unproven', () => {
    const parent = row({ id: 'commit', nodeId: '__commit_push__' })
    const target = row({ nodeId: 'session', parentNodeRunId: 'commit' })
    const context = {
      ...facts([
        { id: '__commit_push__', kind: 'agent-single' },
        { id: 'session', kind: 'agent-single' },
      ]),
      parent: { row: parent },
    }
    expectHistory(target, context, 'parent.commit-push-or-fanout-scope')
    expectHistory(
      target,
      { ...context, parent: { row: parent, writer: writer(parent, 'commit-push') } },
      'parent.writer.user-node',
      true,
    )
  })

  test('system spelling and mutable cause never supply a missing writer identity', () => {
    for (const nodeId of [
      '__repo_prep__',
      '__commit_push__:n',
      '__merge_resolve__:n',
      '__dw_orchestrator__',
      '__wg_leader__',
    ])
      expectHistory(
        row({ nodeId, rerunCause: 'commit-push' }),
        facts([]),
        'node.definition-or-system-writer',
      )
    const target = row({ nodeId: '__repo_prep__' })
    expectHistory(
      target,
      {
        ...facts([{ id: target.nodeId, kind: 'agent-single' }]),
        writer: writer(target, 'repository-preparation'),
      },
      'writer.user-node',
      true,
    )
  })
})

describe('RFC-395 N-domain #70 host/gate families', () => {
  function context(target: LegacyNodeRunRow): LegacyNodeRunFacts {
    return {
      task: {
        ...facts([{ id: '__wg_leader__', kind: 'agent-single' }]).task!,
        subject: 'workgroup',
        engine: 'workgroup-turns',
      },
      writer: writer(target, 'workgroup-turn'),
    }
  }

  test('host and gate have separate canonical slots but one queryable family', () => {
    const host = row({ nodeId: '__wg_leader__', rerunCause: 'wg-leader-round', wgRound: 4 })
    const gate = row({ id: 'gate', nodeId: host.nodeId, rerunCause: 'wg-gate', wgRound: 8 })
    const a = expectIdentity(host, context(host), {
      role: 'synthetic',
      syntheticKind: 'workgroup-host',
      slot: { kind: 'workgroup-host', nodeId: host.nodeId, shardKey: null },
    })
    const b = expectIdentity(gate, context(gate), {
      role: 'synthetic',
      syntheticKind: 'wg-gate',
      slot: {
        kind: 'synthetic',
        owner: { kind: 'task', id: 't' },
        syntheticKind: 'wg-gate',
        discriminator: host.nodeId,
      },
    })
    expect(a.family).toEqual(b.family)
    expect(encodeCanonicalRunSlot(a.slot!)).not.toBe(encodeCanonicalRunSlot(b.slot!))
    expect(runSlotInFamily(a.slot!, a.family!)).toBe(true)
    expect(runSlotInFamily(b.slot!, a.family!)).toBe(true)
    expect(
      runSlotInFamily({ ...b.slot!, owner: { kind: 'task', id: 'other' } } as RunSlot, a.family!),
    ).toBe(false)
  })

  test.each([null, '', 'assignment', 'msg:1'])(
    'host shard %s survives protocol/clarify retries and wgRound changes',
    (shardKey) => {
      for (const rerunCause of [
        'wg-assignment',
        'wg-message-turn',
        'wg-protocol-retry',
        'clarify-answer',
        'cross-clarify-questioner-rerun',
      ]) {
        const target = row({
          nodeId: '__wg_leader__',
          shardKey,
          rerunCause,
          wgRound: 5,
          iteration: 8,
        })
        expectIdentity(target, context(target), {
          role: 'synthetic',
          syntheticKind: 'workgroup-host',
          slot: { kind: 'workgroup-host', nodeId: target.nodeId, shardKey },
        })
      }
    },
  )

  test('budget null/empty collapse is an explicit family option, never key canonicalization', () => {
    const family: RunFamily = { kind: 'workgroup', taskId: 't', nodeId: 'h', shardKey: '' }
    const slots: RunSlot[] = [
      { kind: 'workgroup-host', nodeId: 'h', shardKey: null },
      { kind: 'workgroup-host', nodeId: 'h', shardKey: '' },
      {
        kind: 'synthetic',
        owner: { kind: 'task', id: 't' },
        syntheticKind: 'wg-gate',
        discriminator: 'h',
      },
    ]
    expect(slots.map((slot) => runSlotInFamily(slot, family))).toEqual([false, true, false])
    expect(slots.map((slot) => runSlotInFamily(slot, family, { legacyEmptyShard: true }))).toEqual([
      true,
      true,
      true,
    ])
    expect(new Set(slots.map(encodeCanonicalRunSlot)).size).toBe(3)
  })

  test('subject, engine, writer and gate scope are all necessary facts', () => {
    const target = row({ nodeId: '__wg_leader__', rerunCause: 'wg-leader-round' })
    const known = context(target)
    expectHistory(target, { ...known, writer: undefined }, 'writer.workgroup-turn')
    for (const field of ['subject', 'engine'] as const)
      expectHistory(
        target,
        { ...known, task: { ...known.task!, [field]: undefined } },
        `task.${field}`,
      )
    expectHistory(
      target,
      { ...known, task: { ...known.task!, engine: 'dag' } },
      'task.engine',
      true,
    )
    expectHistory(
      target,
      { ...known, task: { ...known.task!, subject: 'workflow' } },
      'task.subject',
      true,
    )
    expectHistory(
      { ...target, rerunCause: 'wg-gate', shardKey: '' },
      known,
      'writer.gate-shard',
      true,
    )
    expectHistory({ ...target, rerunCause: null }, known, 'writer.workgroup-operation')
    expectHistory({ ...target, shardKey: undefined }, known, 'row.shardKey')
  })
})

describe('RFC-395 N-domain history-only evidence', () => {
  test('missing or conflicting task and row scope facts remain visible', () => {
    expectHistory(row(), {}, 'task')
    expectHistory(row(), { task: { id: 't' } }, 'task.definition')
    expectHistory(row(), { task: { ...facts().task!, id: 'other' } }, 'task.id', true)
    for (const field of ['parentNodeRunId', 'containerRunId', 'iteration'] as const)
      expectHistory({ ...row(), [field]: undefined }, facts(), `row.${field}`)
    expectHistory(row({ iteration: -1 }), facts(), 'row.iteration', true)
    expectHistory(row({ nodeId: 'missing' }), facts(), 'node.definition-or-system-writer')
    expectHistory(
      row(),
      facts([{ id: 'n', kind: 'future-kind' } as unknown as FrozenRunNode]),
      'node.kind',
      true,
    )
    expectHistory(
      row(),
      facts([
        { id: 'n', kind: 'agent-single' },
        { id: 'n', kind: 'review' },
      ]),
      'task.definition.nodes:n',
      true,
    )
  })

  test('dangling parent/container, cross-task references and non-wrapper containers are not invented', () => {
    expectHistory(row({ parentNodeRunId: 'missing' }), facts(), 'parent.row:missing')
    expectHistory(row({ containerRunId: 'missing' }), facts(), 'container.row:missing')
    const target = row({ containerRunId: 'g' })
    expectHistory(
      target,
      { ...facts(), container: { row: row({ id: 'g', taskId: 'other' }) } },
      'container.identity',
      true,
    )
    expectHistory(
      target,
      { ...facts(), container: { row: row({ id: 'g' }) } },
      'container.wrapper-kind',
      true,
    )
    expectHistory(
      row(),
      facts([
        { id: 'n', kind: 'agent-single' },
        { id: 'w', kind: 'wrapper-loop', nodeIds: ['n'] },
      ]),
      'node.wrapper-frame',
    )
  })

  test('writer evidence is bound to this run and cannot be an empty attestation', () => {
    const target = row({ nodeId: '__repo_prep__' })
    const known = writer(target, 'repository-preparation')
    expectHistory(target, { ...facts([]), writer: { ...known, evidence: [] } }, 'writer.evidence')
    expectHistory(
      target,
      { ...facts([]), writer: { ...known, runId: 'other' } },
      'writer.identity',
      true,
    )
    expectHistory(
      target,
      { ...facts([]), writer: { ...known, taskId: 'other' } },
      'writer.identity',
      true,
    )
  })

  test('derivation never mutates its input and evidence retains the original nullable values', () => {
    const target = Object.freeze(
      row({ seq: null, rerunCause: null, shardKey: '', wrapperProgressJson: 'legacy-opaque' }),
    )
    const nodes = Object.freeze([Object.freeze({ id: 'n', kind: 'agent-single' as const })])
    const context = Object.freeze({
      task: Object.freeze({ id: 't', definition: Object.freeze({ nodes }) }),
    })
    const before = JSON.stringify({ target, context })
    const actual = expectHistory(target, context, 'shard.fanout-scope')
    expect(actual.evidence.source).not.toBe(target)
    expect(actual.evidence.source).toEqual(target)
    expect(JSON.stringify({ target, context })).toBe(before)
  })
})
