// RFC-395 II-a A3: grouped writes retain epoch-1 bytes, CAS predicates and rollback boundaries on both providers.
import { expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { describeEachProvider } from './helpers/eachProvider'
import {
  workflowFixture,
  taskFixture,
  nodeRunFixture,
  patchNodeRunFixture,
  readNodeRunFixtures,
  type NodeRunFixtureRow,
} from './helpers/model'
import { readStoredCheckpointFixture } from './helpers/model/checkpoint'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { DrizzleNodeExecutionPersistence } from '@/modules/task-execution/infrastructure/nodeExecutionPersistence'
import { DrizzleNodeRunLifecyclePersistence } from '@/modules/task-execution/infrastructure/nodeRunLifecyclePersistence'
import { DrizzleMergeStateLifecyclePersistence } from '@/modules/task-execution/infrastructure/mergeStateLifecyclePersistence'
import { setNodeRunStatusTx } from '@/modules/task-execution/infrastructure/nodeRunLifecycleTransition'
import type {
  NodeRunProjectionWrite,
  NodeRunLifecycleWrite,
} from '@/modules/task-execution/application/ports/nodeRunWrites'
import type { NodeRunStatus } from '@agent-workflow/shared'
import { installAbortTrigger, dropAbortTrigger, abortMessages } from './helpers/faultTrigger'

const runtimeParams = '{ "z":1, "__configDir" : {"mode":"x"} }'
const inventory = '{"z": [], "a": [1,2]}'
const memories = '[ {"id":"memory", "text":"原样"} ]'
const startup = '{ "ok":true }'
const failures = '[ {"port":"out", "message":"bad"} ]'
const consumed = JSON.stringify({ upstream: 'producer' })

const projections: readonly {
  name: string
  write: NodeRunProjectionWrite
  expected: Partial<NodeRunFixtureRow>
  consumed?: string
}[] = [
  {
    name: 'W3 inline prompt',
    write: { config: { promptText: '正文\n', promptPath: null } },
    expected: { promptText: '正文\n', promptPath: null },
  },
  {
    name: 'W3 spilled prompt',
    write: { config: { promptText: null, promptPath: 'task/prompts/run.md' } },
    expected: { promptText: null, promptPath: 'task/prompts/run.md' },
  },
  {
    name: 'W4 injected memory',
    write: { config: { injectedMemoriesJson: memories } },
    expected: { injectedMemories: memories },
  },
  {
    name: 'W5 agent spawn receipt',
    write: { runtime: { pid: 42, spawnBinaryPath: '/bin/agent', spawnLaunchNonce: 'launch' } },
    expected: { pid: 42, spawnBinaryPath: '/bin/agent', spawnLaunchNonce: 'launch' },
  },
  {
    name: 'W5 script spawn receipt',
    write: {
      runtime: { pid: null, spawnBinaryPath: null, spawnLaunchNonce: null },
      config: { runtimeParamsJson: runtimeParams },
    },
    expected: {
      pid: null,
      spawnBinaryPath: null,
      spawnLaunchNonce: null,
      runtimeParamsJson: runtimeParams,
    },
  },
  {
    name: 'W6 captured session',
    write: { runtime: { opencodeSessionId: 'session-id' } },
    expected: { opencodeSessionId: 'session-id' },
  },
  {
    name: 'W7 runtime inventory',
    write: { config: { runtimeInventoryJson: inventory } },
    expected: { runtimeInventoryJson: inventory },
  },
  {
    name: 'W9 settlement follow-up',
    write: {
      config: { runtimeInventoryJson: inventory, injectedMemoriesJson: memories },
      runtime: { startupVerificationJson: startup },
      result: { portValidationFailuresJson: failures },
    },
    expected: {
      runtimeInventoryJson: inventory,
      injectedMemories: memories,
      startupVerificationJson: startup,
      portValidationFailures: failures,
    },
  },
  {
    name: 'W12 wrapper and call progress',
    write: { runtime: { wrapperProgressJson: '{ "round":2 }' } },
    expected: { wrapperProgressJson: '{ "round":2 }' },
  },
  {
    name: 'W16 commit metadata',
    write: { result: { commitPushJson: '{ "pushed": true }' } },
    expected: { commitPush: '{ "pushed": true }' },
  },
  {
    name: 'W17 shard reuse hash',
    write: { config: { shardValueHash: 'new-hash' } },
    expected: { shardValueHash: 'new-hash' },
  },
  {
    name: 'call child linkage',
    write: { identity: { childTaskId: 'child' } },
    expected: { childTaskId: 'child' },
  },
  {
    name: 'projection errors and finish time',
    write: { identity: { errorMessage: 'error', failureCode: 'failure', finishedAt: 12 } },
    expected: { errorMessage: 'error', failureCode: 'failure', finishedAt: 12 },
  },
  {
    name: 'consumed map',
    write: { inputs: { consumedUpstreamRunsJson: consumed } },
    expected: {
      consumedEdges: [
        { producerNodeId: 'upstream', producerRunId: 'producer', producerShardKey: null },
      ],
    },
    consumed,
  },
  {
    name: 'explicit null cleanup',
    write: {
      config: { injectedMemoriesJson: null, runtimeInventoryJson: null },
      runtime: { opencodeSessionId: null, pid: null },
      result: { portValidationFailuresJson: null },
    },
    expected: {
      injectedMemories: null,
      runtimeInventoryJson: null,
      opencodeSessionId: null,
      pid: null,
      portValidationFailures: null,
    },
  },
]
const transitions: readonly {
  name: string
  from: NodeRunStatus
  to: NodeRunStatus
  write: NodeRunLifecycleWrite
  expected: Partial<NodeRunFixtureRow>
}[] = [
  {
    name: 'W8 runner settlement tokens',
    from: 'running',
    to: 'done',
    write: {
      identity: { finishedAt: 12, exitCode: 0, errorMessage: null, failureCode: null },
      result: { tokInput: 1, tokOutput: 2, tokCacheCreate: 3, tokCacheRead: 4, tokTotal: 10 },
    },
    expected: {
      finishedAt: 12,
      exitCode: 0,
      errorMessage: null,
      failureCode: null,
      tokInput: 1,
      tokOutput: 2,
      tokCacheCreate: 3,
      tokCacheRead: 4,
      tokTotal: 10,
    },
  },
  {
    name: 'W14 review supersede',
    from: 'done',
    to: 'canceled',
    write: {
      identity: { finishedAt: 12, errorMessage: 'superseded' },
      result: { supersededByReview: 'review', rolledBack: true },
    },
    expected: {
      finishedAt: 12,
      errorMessage: 'superseded',
      supersededByReview: 'review',
      rolledBack: true,
    },
  },
  {
    name: 'W16 commit final session',
    from: 'running',
    to: 'done',
    write: { identity: { finishedAt: 12 }, runtime: { opencodeSessionId: 'session' } },
    expected: { finishedAt: 12, opencodeSessionId: 'session' },
  },
  {
    name: 'review iteration reset',
    from: 'done',
    to: 'pending',
    write: {
      identity: { reviewIteration: 3, startedAt: null, finishedAt: null, errorMessage: null },
    },
    expected: { reviewIteration: 3, startedAt: null, finishedAt: null, errorMessage: null },
  },
  {
    name: 'gate park input companions',
    from: 'running',
    to: 'awaiting_human',
    write: { identity: { startedAt: null }, inputs: { consumedUpstreamRunsJson: consumed } },
    expected: {
      startedAt: null,
      consumedEdges: [
        { producerNodeId: 'upstream', producerRunId: 'producer', producerShardKey: null },
      ],
    },
  },
]

describeEachProvider('RFC-395 II-a A3 grouped writes', (harness) => {
  async function seed(status: NodeRunStatus = 'running') {
    const taskId = ulid(),
      id = ulid()
    await workflowFixture(harness.db, { id: taskId, name: 'writes', definition: '{}' })
    await taskFixture(harness.db, {
      id: taskId,
      workflowId: taskId,
      workflowSnapshot: '{}',
      repoPath: '/repo',
      worktreePath: '/work',
      baseBranch: 'main',
      branch: 'task',
      status: 'running',
      inputs: '{}',
      startedAt: 1,
    })
    await nodeRunFixture(harness.db, { id: 'producer', taskId, nodeId: 'upstream', status: 'done' })
    await nodeRunFixture(harness.db, {
      id,
      taskId,
      nodeId: 'n',
      status,
      startedAt: 1,
      envelopeNonce: '0123456789abcdef',
    })
    const read = async () => (await readNodeRunFixtures(harness.db, { id }))[0]!
    return {
      id,
      taskId,
      read,
      nodes: new DrizzleNodeExecutionPersistence(harness.db),
      lifecycle: new DrizzleNodeRunLifecyclePersistence(harness.db),
      merge: new DrizzleMergeStateLifecyclePersistence(harness.db),
    }
  }
  for (const c of projections) {
    test(`${c.name}: the old flat write produces the same complete row`, async () => {
      const s = await seed(),
        before = await s.read()
      expect(await s.nodes.patch({ nodeRunId: s.id, values: c.write })).toBe(true)
      expect(await s.read()).toEqual({ ...before, ...c.expected })
      if (c.consumed !== undefined)
        expect((await s.nodes.read(s.id))!.consumedUpstreamRunsJson).toBe(c.consumed)
    })
  }
  for (const c of transitions) {
    test(`${c.name}: identity CAS and companions remain one atomic write`, async () => {
      const s = await seed(c.from),
        before = await s.read()
      await s.lifecycle.set({
        nodeRunId: s.id,
        to: c.to,
        allowedFrom: [c.from],
        allowTerminal: c.from === 'done',
        extra: c.write,
      })
      expect(await s.read()).toEqual({ ...before, status: c.to, ...c.expected })
    })
  }
  test('CAS miss leaves every companion untouched for both transition and set', async () => {
    const s = await seed('pending'),
      before = await s.read()
    const name = 'rfc395_a3_ignore_status'
    if (harness.capabilities.provider === 'sqlite') {
      await harness.executeFixtureDdl(
        `CREATE TRIGGER ${name} BEFORE UPDATE OF status ON node_runs BEGIN SELECT RAISE(IGNORE); END`,
      )
    } else {
      await harness.executeFixtureDdl(
        `CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql`,
      )
      await harness.executeFixtureDdl(
        `CREATE TRIGGER ${name} BEFORE UPDATE OF status ON node_runs FOR EACH ROW EXECUTE FUNCTION ${name}()`,
      )
    }
    try {
      await expect(
        s.lifecycle.set({
          nodeRunId: s.id,
          to: 'done',
          allowedFrom: ['pending'],
          extra: {
            identity: { finishedAt: 2 },
            result: { tokTotal: 99 },
            runtime: { opencodeSessionId: 'lost' },
            inputs: { consumedUpstreamRunsJson: consumed },
          },
        }),
      ).rejects.toMatchObject({ code: 'concurrent-node-run-transition' })
      await expect(
        s.lifecycle.transition({
          nodeRunId: s.id,
          event: { kind: 'mark-running' },
          extra: { identity: { startedAt: 9 }, runtime: { pid: 44 } },
        }),
      ).rejects.toMatchObject({ code: 'concurrent-node-run-transition' })
      expect(await s.read()).toEqual(before)
    } finally {
      await dropAbortTrigger(harness, { name, table: 'node_runs', error: 'unused' })
    }
  })
  test('merge CAS miss does not leak runtime or checkpoint companions', async () => {
    const s = await seed()
    await patchNodeRunFixture(harness.db, { id: s.id }, { pid: 42, mergeState: null })
    const before = await s.read()
    const name = 'rfc395_a3_ignore_merge'
    if (harness.capabilities.provider === 'sqlite') {
      await harness.executeFixtureDdl(
        `CREATE TRIGGER ${name} BEFORE UPDATE OF merge_state ON node_run_runtime_states BEGIN SELECT RAISE(IGNORE); END`,
      )
    } else {
      await harness.executeFixtureDdl(
        `CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql`,
      )
      await harness.executeFixtureDdl(
        `CREATE TRIGGER ${name} BEFORE UPDATE OF merge_state ON node_run_runtime_states FOR EACH ROW EXECUTE FUNCTION ${name}()`,
      )
    }
    try {
      await expect(
        s.merge.transition({
          nodeRunId: s.id,
          event: { kind: 'begin-isolation' },
          extra: {
            runtime: { isoWorktreePath: '/lost', wrapperProgressJson: '{"lost":true}' },
            checkpoint: { checkpoints: [{ mountPath: '', isolationBase: 'lost-base' }] },
          },
        }),
      ).rejects.toMatchObject({ code: 'concurrent-merge-state-transition' })
      expect(await s.read()).toEqual(before)
    } finally {
      await dropAbortTrigger(harness, { name, table: 'node_run_runtime_states', error: 'unused' })
    }
  })
  test('caller-owned transaction rollback undoes identity and result writes together', async () => {
    const s = await seed(),
      before = await s.read()
    await expect(
      databaseSessionFor(harness.db).transaction(async (tx) => {
        await setNodeRunStatusTx({
          tx,
          nodeRunId: s.id,
          to: 'done',
          allowedFrom: ['running'],
          extra: { identity: { finishedAt: 7 }, result: { tokTotal: 77 } },
        })
        throw new Error('after-status')
      }),
    ).rejects.toThrow('after-status')
    expect(await s.read()).toEqual(before)
  })
  test('W9 remains a separate transaction after settlement; a follow-up failure does not undo tokens', async () => {
    const s = await seed()
    await s.lifecycle.set({
      nodeRunId: s.id,
      to: 'done',
      allowedFrom: ['running'],
      extra: { identity: { finishedAt: 7 }, result: { tokTotal: 77 } },
    })
    const settled = await s.read()
    const trigger = {
      name: 'rfc395_a3_followup_abort',
      table: 'node_run_configs',
      event: 'insert' as const,
      error: 'followup-abort',
    }
    await installAbortTrigger(harness, trigger)
    try {
      const error = await s.nodes
        .patch({
          nodeRunId: s.id,
          values: {
            config: { runtimeInventoryJson: inventory },
            runtime: { startupVerificationJson: startup },
            result: { portValidationFailuresJson: failures },
          },
        })
        .then(
          () => undefined,
          (cause: unknown) => cause,
        )
      // PostgreSQL 把触发器异常包成 `Failed query`，原文在 cause 上；两个引擎都须由这条触发器中止。
      expect(abortMessages(error)).toContain('followup-abort')
    } finally {
      await dropAbortTrigger(harness, trigger)
    }
    expect(await s.read()).toEqual(settled)
  })
  test('W13 merge CAS keeps runtime and checkpoint bytes together, and superseded abandonment drops companions', async () => {
    const s = await seed()
    const topology = { poolDirs: { sub: '/pool' }, subBases: { sub: 'base' } }
    await s.merge.transition({
      nodeRunId: s.id,
      event: { kind: 'begin-isolation' },
      extra: {
        runtime: { isoWorktreePath: '/iso', wrapperProgressJson: '{ "round":1 }' },
        checkpoint: {
          checkpoints: [{ mountPath: '', isolationBase: 'base', submodules: topology }],
        },
      },
    })
    expect(await readStoredCheckpointFixture(harness.db, s.id)).toMatchObject({
      mergeState: 'isolating',
      checkpoints: [
        {
          nodeRunId: s.id,
          taskId: s.taskId,
          repoKey: `${s.taskId}:mount:`,
          isolationBase: 'base',
          submodules: JSON.stringify(topology),
          preSnapshot: null,
          nodeTree: null,
        },
      ],
    })
    const before = await s.read()
    await nodeRunFixture(harness.db, {
      id: ulid(),
      taskId: s.taskId,
      nodeId: 'n',
      status: 'pending',
    })
    await expect(
      s.merge.transition({
        nodeRunId: s.id,
        event: { kind: 'mark-pending-merge' },
        extra: {
          runtime: { isoWorktreePath: '/wrong' },
          checkpoint: { checkpoints: [{ mountPath: '', nodeTree: 'wrong' }] },
        },
      }),
    ).rejects.toThrow('superseded')
    expect(await s.read()).toEqual({ ...before, mergeState: 'abandoned' })
  })
})
