// RFC-395 A3 K4: projected snapshots never manufacture row facts or infer
// structural supersession from a truncated query. These are contract regressions.
import { expect, test } from 'bun:test'
import {
  createRunSelectionOracleSnapshot,
  type OracleSnapshotRow,
} from '@/modules/task-execution/infrastructure/runSelection/oracle/snapshot'
import { createRunHistorySnapshot } from '@/modules/task-execution/infrastructure/runSelection/oracle/historySnapshot'
import type { OracleRunRow } from '@/modules/task-execution/infrastructure/runSelection/oracle/rows'

const row = (id: string, changes: Partial<OracleRunRow> = {}): OracleRunRow => ({
  id,
  taskId: 't',
  nodeId: 'n',
  seq: 1,
  status: 'pending',
  retryIndex: 0,
  iteration: 0,
  parentNodeRunId: null,
  containerRunId: null,
  shardKey: null,
  shardValueHash: null,
  reviewIteration: 0,
  wgRound: null,
  rerunCause: null,
  wrapperProgressJson: null,
  consumedUpstreamRunsJson: null,
  childTaskId: null,
  startedAt: null,
  mergeState: null,
  supersededByReview: null,
  ...changes,
})
const slot = { kind: 'node' as const, nodeId: 'n', frame: { containerRunId: null, iteration: 0 } }

// Hand-enumerated port facts: removing a production validation field must fail here.
const requiredRowFields = [
  'id',
  'taskId',
  'nodeId',
  'seq',
  'status',
  'retryIndex',
  'iteration',
  'parentNodeRunId',
  'containerRunId',
  'shardKey',
  'shardValueHash',
  'reviewIteration',
  'wgRound',
  'rerunCause',
  'wrapperProgressJson',
  'consumedUpstreamRunsJson',
  'childTaskId',
  'startedAt',
  'mergeState',
  'supersededByReview',
] as const satisfies readonly (keyof OracleRunRow)[]

test.each(requiredRowFields)(
  'a complete snapshot rejects a missing %s instead of filling it',
  (field) => {
    const incomplete: Partial<OracleRunRow> = { ...row('r') }
    delete incomplete[field]
    expect(() => createRunSelectionOracleSnapshot([incomplete as OracleRunRow])).toThrow(
      'oracle-snapshot-field-missing',
    )
  },
)

test('declared projections preserve a narrow query and throw for unbound fields', async () => {
  const projection = { id: 'r', taskId: 't', nodeId: 'n', seq: null, status: 'done' as const }
  const snapshot = createRunSelectionOracleSnapshot([projection], { scope: { kind: 'rows' } })
  const [ref] = await snapshot.familyHistory('t', {})
  expect(ref?.id).toBe('r')
  expect(ref?.seq).toBeNull()
  expect(() => ref!.retryIndex).toThrow('oracle-snapshot-field-missing:r:retryIndex')
  expect(() => ref!.parentNodeRunId).toThrow('oracle-snapshot-field-missing:r:parentNodeRunId')
  expect(() => ref!.structurallySuperseded).toThrow('oracle-snapshot-incomplete-supersession:r')
  await expect(snapshot.current('t', slot)).rejects.toThrow('oracle-snapshot-field-missing')
  await expect(snapshot.consumed('r')).rejects.toThrow(
    'oracle-snapshot-field-missing:r:consumedUpstreamRunsJson',
  )
  const history = createRunHistorySnapshot('t', [projection])
  const [bound] = await history.familyHistory('t', {})
  expect(() => bound!.startedAt).toThrow('oracle-snapshot-field-missing:r:startedAt')
})

test('sorting requires seq even for a single row and missing task identity cannot become an empty answer', async () => {
  const projection = { id: 'r', taskId: 't', nodeId: 'n', status: 'done' }
  await expect(
    // @ts-expect-error runtime negative control: seq is a required snapshot fact.
    createRunSelectionOracleSnapshot([projection], { scope: { kind: 'rows' } }).familyHistory(
      't',
      {},
    ),
  ).rejects.toThrow('oracle-snapshot-field-missing:r:seq')
  const consumedOnly = createRunSelectionOracleSnapshot(
    [{ id: 'r', nodeId: 'n', seq: null, status: 'done', consumedUpstreamRunsJson: '{}' }],
    { scope: { kind: 'rows' } },
  )
  expect(await consumedOnly.consumed('r')).toEqual([])
  await expect(consumedOnly.familyHistory('t', {})).rejects.toThrow(
    'oracle-snapshot-field-missing:taskId',
  )
})

test('subset supersession is unknown, while a declared complete node universe supports rule (a) only', async () => {
  const old = row('old')
  const newerChild = row('newer', { seq: 2, parentNodeRunId: 'wrapper' })
  const complete = createRunSelectionOracleSnapshot([old, newerChild])
  expect((await complete.current('t', slot))?.structurallySuperseded).toBe(true)
  const subset = createRunSelectionOracleSnapshot([old], { scope: { kind: 'rows' } })
  const selected = await subset.current('t', slot)
  expect(selected?.id).toBe('old')
  expect(() => selected!.structurallySuperseded).toThrow('oracle-snapshot-incomplete-supersession')
  await expect(subset.familyHistory('t', {}, { excludeSuperseded: true })).rejects.toThrow(
    'oracle-snapshot-incomplete-supersession',
  )
  const scoped = createRunSelectionOracleSnapshot([old, newerChild], {
    scope: { kind: 'node', taskId: 't', nodeId: 'n', iteration: 0 },
  })
  expect((await scoped.current('t', slot))?.structurallySuperseded).toBe(true)
  const child = (await scoped.familyHistory('t', { runIds: ['newer'] }))[0]!
  expect(() => child.structurallySuperseded).toThrow('oracle-snapshot-incomplete-supersession')
  expect(() =>
    createRunSelectionOracleSnapshot([old], {
      scope: { kind: 'node', taskId: 'other', nodeId: 'n' },
    }),
  ).toThrow('oracle-snapshot-scope-mismatch')
})

test('rule (b) sees the parent generation only in the complete task', async () => {
  const old = row('g0', { nodeId: 'wrapper' })
  const fresh = row('g1', { nodeId: 'wrapper', seq: 3 })
  const child = row('child', { seq: 2, parentNodeRunId: 'g0', containerRunId: 'g0' })
  const complete = createRunSelectionOracleSnapshot([old, child, fresh])
  expect(
    (await complete.familyHistory('t', { runIds: ['child'] }))[0]?.structurallySuperseded,
  ).toBe(true)
  const subset = createRunSelectionOracleSnapshot([child], {
    scope: { kind: 'node', taskId: 't', nodeId: 'n' },
  })
  const [ref] = await subset.familyHistory('t', {})
  expect(() => ref!.structurallySuperseded).toThrow('oracle-snapshot-incomplete-supersession')
})

test.each(['rows', 'node'] as const)(
  'partial %s scope refuses role, slot and synthetic selection',
  async (kind) => {
    const scope = kind === 'rows' ? { kind } : { kind, taskId: 't', nodeId: 'n' }
    const snapshot = createRunSelectionOracleSnapshot([row('r')], { scope })
    const selected = (await snapshot.current('t', slot))!
    expect(() => selected.role).toThrow('oracle-snapshot-incomplete-role')
    expect(() => selected.syntheticKind).toThrow('oracle-snapshot-incomplete-role')
    expect(() => selected.slot).toThrow('oracle-snapshot-incomplete-slot')
    await expect(snapshot.familyHistory('t', { syntheticKind: 'repo-prep' })).rejects.toThrow(
      'oracle-snapshot-incomplete-role',
    )
    await expect(
      snapshot.slotHistory('t', {
        kind: 'synthetic',
        owner: { kind: 'task', id: 't' },
        syntheticKind: 'repo-prep',
        discriminator: '__repo_prep__',
      }),
    ).rejects.toThrow('oracle-snapshot-incomplete-slot')
  },
)

test('task-scoped role uses only role facts instead of spreading unrelated projection fields', async () => {
  const rows: OracleSnapshotRow[] = [
    {
      id: 'wrapper',
      taskId: 't',
      nodeId: 'wrapper',
      seq: 1,
      status: 'done',
      containerRunId: null,
      rerunCause: null,
      wrapperProgressJson: null,
    },
    {
      id: 'child',
      taskId: 't',
      nodeId: 'n',
      seq: 2,
      status: 'done',
      containerRunId: 'wrapper',
      rerunCause: null,
      wrapperProgressJson: null,
    },
  ]
  const snapshot = createRunSelectionOracleSnapshot(rows, { scope: { kind: 'task' } })
  const [wrapper, child] = await snapshot.familyHistory('t', {})
  expect(wrapper!.role).toBe('container')
  expect(child!.role).toBe('node-attempt')
  expect(() => wrapper!.retryIndex).toThrow('oracle-snapshot-field-missing:wrapper:retryIndex')
})

test('empty partial scopes still refuse a synthetic family query', async () => {
  const snapshot = createRunSelectionOracleSnapshot([], { scope: { kind: 'rows' } })
  await expect(snapshot.familyHistory('t', { syntheticKind: 'repo-prep' })).rejects.toThrow(
    'oracle-snapshot-incomplete-role',
  )
})
