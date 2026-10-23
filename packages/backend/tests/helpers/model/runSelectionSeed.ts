// RFC-395 A3 K8: deterministic histories across every selection family. Expected
// membership comes from the fixture writer, never from oracle role/slot functions.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { RunSlot } from '@/modules/task-execution/application/ports/runSelection'
import { nodeRunFixture, taskFixture, workflowFixture, type NodeRunFixtureSpec } from './index'
import {
  patchLegacyRunSelectionFixture,
  readRunSelectionOracleFixtures,
} from './runSelectionOracle'

export function selectionRandom(seed: number) {
  let value = seed >>> 0
  return (max: number) => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0
    // Use the high bits too: the low LCG bits alone alternate for small powers of two.
    return (value >>> 8) % max
  }
}

export async function seedSelectionFamilies(db: PersistenceDb, seed: number) {
  const next = selectionRandom(seed)
  const prefix = `selection-families-${seed}`
  const definition = {
    $schema_version: 2,
    inputs: [],
    nodes: [
      {
        id: 'wrapper',
        kind: 'wrapper-fanout',
        nodeIds: ['inner', 'shared', 'agg'],
        shardSourcePort: 'items',
      },
      { id: 'inner', kind: 'agent-single', agentName: 'worker' },
      { id: 'shared', kind: 'agent-single', agentName: 'worker' },
      { id: 'agg', kind: 'agent-single', agentName: 'aggregator' },
      { id: 'ordinary', kind: 'agent-single', agentName: 'worker' },
    ],
    edges: [
      {
        source: { nodeId: 'wrapper', portName: 'items' },
        target: { nodeId: 'inner', portName: 'items' },
        boundary: 'wrapper-input',
      },
      { source: { nodeId: 'inner', portName: 'out' }, target: { nodeId: 'agg', portName: 'in' } },
      {
        source: { nodeId: 'shared', portName: 'out' },
        target: { nodeId: 'agg', portName: 'shared' },
      },
      {
        source: { nodeId: 'agg', portName: 'out' },
        target: { nodeId: 'wrapper', portName: 'out' },
        boundary: 'wrapper-output',
      },
    ],
  }
  await workflowFixture(db, { id: prefix, name: prefix, definition })
  const taskIds = { dag: `${prefix}-dag`, host: `${prefix}-host`, dw: `${prefix}-dw` }
  for (const [kind, taskId] of Object.entries(taskIds)) {
    await taskFixture(db, {
      id: taskId,
      workflowId: prefix,
      workflowSnapshot: kind === 'dag' ? definition : { ...definition, nodes: [], edges: [] },
      repoPath: '/selection',
      worktreePath: '/selection',
      baseBranch: 'main',
      branch: taskId,
      status: 'running',
      inputs: {},
      startedAt: 0,
      ...(kind === 'dag'
        ? {}
        : {
            workgroupId: `${prefix}-workgroup`,
            workgroupConfigJson: { mode: kind === 'host' ? 'leader_worker' : 'dynamic_workflow' },
          }),
    })
  }
  const cases = new Map<string, { taskId: string; slot: RunSlot; runIds: string[] }>()
  const add = async (
    taskId: string,
    slot: RunSlot,
    spec: Omit<NodeRunFixtureSpec, 'taskId'>,
    legacy = false,
  ) => {
    await nodeRunFixture(db, { ...spec, taskId })
    if (legacy) await patchLegacyRunSelectionFixture(db, spec.id, { seq: null })
    const key = JSON.stringify([taskId, slot])
    const entry = cases.get(key) ?? { taskId, slot, runIds: [] }
    entry.runIds.push(spec.id)
    cases.set(key, entry)
  }
  const synthetic = (
    taskId: string,
    syntheticKind: Extract<RunSlot, { kind: 'synthetic' }>['syntheticKind'],
    nodeId: string,
    parent: string | null,
  ): RunSlot => ({
    kind: 'synthetic',
    syntheticKind,
    discriminator: nodeId,
    owner: parent === null ? { kind: 'task', id: taskId } : { kind: 'attempt', id: parent },
  })
  const parent = `${prefix}-ordinary`
  await add(
    taskIds.dag,
    { kind: 'node', nodeId: 'ordinary', frame: { containerRunId: null, iteration: 0 } },
    { id: parent, nodeId: 'ordinary', status: 'done', seq: -10 },
  )
  const generations = [`${prefix}-g0`, `${prefix}-g1`]
  for (const [index, id] of generations.entries())
    await add(
      taskIds.dag,
      { kind: 'container', nodeId: 'wrapper', frame: { containerRunId: null, iteration: 0 } },
      { id, nodeId: 'wrapper', status: 'interrupted', seq: -8 + index, rerunCause: 'wrapper-init' },
    )
  const commitParent = `${prefix}-commit-parent`
  await add(
    taskIds.dag,
    synthetic(taskIds.dag, 'commit-push', '__commit_push__:ordinary', parent),
    {
      id: commitParent,
      nodeId: '__commit_push__:ordinary',
      status: 'done',
      parentNodeRunId: parent,
      seq: -5,
      rerunCause: 'commit-push',
    },
  )
  const statuses = ['done', 'failed', 'interrupted', 'pending', 'canceled', 'running'] as const
  const merges = [
    null,
    'merged',
    'conflict-human',
    'pending-merge',
    'isolating',
    'merge-failed',
  ] as const
  // Each category has twelve rows, including at least three legacy NULL-seq rows.
  for (let round = 0; round < 12; round += 1)
    for (let category = 0; category < 11; category += 1) {
      const id = `${prefix}-${category}-${(round * 7) % 13}`
      const iteration = next(2)
      const generation = generations[next(2)]!
      const spec = {
        id,
        status: statuses[next(statuses.length)]!,
        seq: round * 11 + category + 1,
        retryIndex: next(5),
        iteration,
        startedAt: next(3) === 0 ? null : next(50),
        mergeState: merges[next(merges.length)]!,
      }
      const legacy = round % 4 === 0
      if (category < 3) {
        const nodeId = ['inner', 'shared', 'agg'][category]!
        const shardKey = category === 0 ? ['', 'a', 'b'][next(3)]! : null
        await add(
          taskIds.dag,
          category === 2
            ? { kind: 'aggregator', nodeId, iteration }
            : { kind: 'shard', nodeId, iteration, shardKey },
          {
            ...spec,
            nodeId,
            parentNodeRunId: generation,
            containerRunId: generation,
            shardKey,
            shardValueHash: next(2) === 0 ? null : 'hash-a',
            rerunCause: category === 2 ? 'fanout-aggregator' : 'fanout-shard',
          },
          legacy,
        )
      } else if (category === 3) {
        const nodeId = round % 2 === 0 ? '__wg_member__' : '__wg_leader__'
        const shardKey = [null, '', 'assignment', 'msg:1'][next(4)]!
        await add(
          taskIds.host,
          { kind: 'workgroup-host', nodeId, shardKey },
          { ...spec, nodeId, shardKey, wgRound: next(4), rerunCause: 'wg-protocol-retry' },
          legacy,
        )
      } else {
        const [kind, nodeId, cause, owner, taskId] = (
          [
            ['repo-prep', '__repo_prep__', 'retry-node', null, taskIds.dag],
            ['commit-push', '__commit_push__:ordinary', 'commit-push', parent, taskIds.dag],
            [
              'commit-session',
              '__commit_push__:ordinary',
              'commit-push-session',
              commitParent,
              taskIds.dag,
            ],
            ['merge-resolve', '__merge_resolve__:ordinary', 'merge-resolve', parent, taskIds.dag],
            ['dw-orchestrator', '__dw_orchestrator__', 'dw-generate', null, taskIds.dw],
            ['dw-gate', '__dw_orchestrator__', 'dw-gate', null, taskIds.dw],
            ['wg-gate', '__wg_leader__', 'wg-gate', null, taskIds.host],
          ] as const
        )[category - 4]!
        await add(
          taskId,
          synthetic(taskId, kind, nodeId, owner),
          {
            ...spec,
            nodeId,
            parentNodeRunId: owner,
            rerunCause: cause,
            ...(kind === 'repo-prep'
              ? {
                  retryIndex: round < 3 || round === 4 ? 9 : spec.retryIndex,
                  seq: round === 1 ? -2 : spec.seq,
                }
              : {}),
          },
          legacy,
        )
      }
    }
  const histories = await Promise.all(
    Object.values(taskIds).map(async (taskId) => ({
      taskId,
      rows: await readRunSelectionOracleFixtures(db, taskId),
    })),
  )
  return { taskIds, generations, cases: [...cases.values()], histories }
}
