import { o2Ports } from './helpers/o2Closure'
// RFC-395 II-a A2: list ports must round-trip every mount shape on both physical providers.
import { deriveNodeRunRole } from '@/modules/task-execution/public/types'
import { expect, test } from 'bun:test'
import { ulid } from 'ulid'
import {
  readStoredCheckpointFixture,
  patchStoredCheckpointFixture,
} from './helpers/model/checkpoint'
import { describeEachProvider } from './helpers/eachProvider'
import {
  workflowFixture,
  taskFixture,
  nodeRunFixture,
  readNodeRunFixtures,
  patchNodeRunFixture,
} from './helpers/model'
import { DrizzleNodeExecutionPersistence } from '@/modules/task-execution/infrastructure/nodeExecutionPersistence'
import { DrizzleMergeStateLifecyclePersistence } from '@/modules/task-execution/infrastructure/mergeStateLifecyclePersistence'
import { DrizzleWrapperRunPersistence } from '@/modules/task-execution/infrastructure/wrapperRunPersistence'
import { DrizzleTaskEngineApplicationPersistence } from '@/modules/task-execution/infrastructure/taskEngineApplicationPersistence'
import { createNodeRunMintParticipantInTx } from '@/modules/task-execution/infrastructure/nodeRunMintParticipant'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { persistIsoNodeTree } from '@/modules/task-execution/infrastructure/isolatedAgentRun'
import type { TaskRepositoryCheckpoint } from '@/modules/task-execution/domain/taskCheckpoint'

const layouts = [
  { name: 'legacy root without task_repos', mounts: [] },
  { name: 'single root', mounts: [''] },
  { name: 'single non-root member', mounts: ['svc'] },
  { name: 'multiple mounts', mounts: ['', 'nested/svc'] },
] as const

describeEachProvider('RFC-395 II-a A2 checkpoint list ports', (harness) => {
  for (const layout of layouts) {
    test(`${layout.name}: projection patch, merge CAS and wrapper read share one list`, async () => {
      const taskId = ulid(),
        runId = ulid(),
        workflowId = ulid()
      await workflowFixture(harness.db, { id: workflowId, name: 'checkpoints', definition: '{}' })
      await taskFixture(harness.db, {
        id: taskId,
        workflowId,
        workflowSnapshot: '{}',
        repoPath: '/repo',
        worktreePath: '/workspace',
        baseBranch: 'main',
        branch: 'task',
        status: 'running',
        inputs: '{}',
        startedAt: 1,
        repos: layout.mounts.map((mountPath, repoIndex) => ({
          repoIndex,
          mountPath,
          repoPath: '/repo',
          worktreePath: `/workspace/${mountPath}`,
          baseBranch: 'main',
          branch: 'task',
          readonly: repoIndex === 1,
          workspaceProfileVersion: 1,
          workspaceProfileDigest: 'profile',
        })),
      })
      await nodeRunFixture(harness.db, { id: runId, taskId, nodeId: 'wrapper', status: 'running' })
      const nodes = new DrizzleNodeExecutionPersistence(harness.db)
      const merges = new DrizzleMergeStateLifecyclePersistence(harness.db)
      const mountPath = layout.mounts.at(-1) ?? ''
      const pre: TaskRepositoryCheckpoint[] = [{ mountPath, preSnapshot: '' }]
      expect(
        await nodes.patch({
          nodeRunId: runId,
          values: {
            checkpoint: {
              checkpoints: pre,
            },
          },
        }),
      ).toBe(true)
      expect((await nodes.read(runId))!.checkpoints).toEqual(pre)
      const topology = { poolDirs: { vendor: '/pool' }, subBases: { vendor: 'sub-base' } }
      await merges.transition({
        nodeRunId: runId,
        event: { kind: 'begin-isolation' },
        extra: {
          runtime: {
            isoWorktreePath: '/iso/run',
          },
          checkpoint: {
            checkpoints: [{ mountPath, isolationBase: 'base', submodules: topology }],
          },
        },
      })
      await merges.transition({
        nodeRunId: runId,
        event: { kind: 'mark-pending-merge' },
        extra: {
          checkpoint: {
            checkpoints: [{ mountPath, nodeTree: '' }],
          },
        },
      })
      const expected = [
        { mountPath, preSnapshot: '', isolationBase: 'base', nodeTree: '', submodules: topology },
      ]
      const row = (await nodes.read(runId))!
      expect(row.checkpoints).toEqual(expected)
      expect(row.isoWorktreePath).toBe('/iso/run')
      expect(row.mergeState).toBe('pending-merge')
      const stored = await readStoredCheckpointFixture(harness.db, runId)
      const single =
        layout.mounts.length === 0 || (layout.mounts.length === 1 && layout.mounts[0] === '')
      // Independent raw-column oracle: do not pass the expectation through the codec.
      expect({
        preSnapshot: stored.preSnapshot,
        preSnapshotReposJson: stored.preSnapshotReposJson,
        isoBaseSnapshot: stored.isoBaseSnapshot,
        isoBaseSnapshotReposJson: stored.isoBaseSnapshotReposJson,
        isoNodeTree: stored.isoNodeTree,
        isoNodeTreeReposJson: stored.isoNodeTreeReposJson,
        isoSubmodulesJson: stored.isoSubmodulesJson,
        isoSubmodulesReposJson: stored.isoSubmodulesReposJson,
      }).toEqual(
        single
          ? {
              preSnapshot: '',
              preSnapshotReposJson: null,
              isoBaseSnapshot: 'base',
              isoBaseSnapshotReposJson: null,
              isoNodeTree: '',
              isoNodeTreeReposJson: null,
              isoSubmodulesJson: JSON.stringify(topology),
              isoSubmodulesReposJson: null,
            }
          : {
              preSnapshot: null,
              preSnapshotReposJson: JSON.stringify({ [mountPath]: '' }),
              isoBaseSnapshot: null,
              isoBaseSnapshotReposJson: JSON.stringify({ [mountPath]: 'base' }),
              isoNodeTree: null,
              isoNodeTreeReposJson: JSON.stringify({ [mountPath]: '' }),
              isoSubmodulesJson: null,
              isoSubmodulesReposJson: JSON.stringify({ [mountPath]: topology }),
            },
      )
      const emptyTreeRun = ulid()
      await nodeRunFixture(harness.db, {
        id: emptyTreeRun,
        taskId,
        nodeId: 'empty-tree',
        status: 'running',
        mergeState: 'isolating',
        checkpoints: expected,
      })
      const beforeEmpty = await readStoredCheckpointFixture(harness.db, emptyTreeRun)
      await persistIsoNodeTree(
        {
          persistence: createTaskExecutionPersistence(harness.db, {
            recoveryHumanGates: o2Ports(harness.db).collaborationReads.recovery,
          }),
        },
        emptyTreeRun,
        {},
      )
      const afterEmpty = await readStoredCheckpointFixture(harness.db, emptyTreeRun)
      expect(afterEmpty).toEqual({
        ...beforeEmpty,
        mergeState: 'pending-merge',
        isoNodeTree: null,
        isoNodeTreeReposJson: '{}',
      })

      for (const column of [
        'preSnapshot',
        'preSnapshotReposJson',
        'isoBaseSnapshot',
        'isoBaseSnapshotReposJson',
        'isoNodeTree',
        'isoNodeTreeReposJson',
        'isoSubmodulesJson',
        'isoSubmodulesReposJson',
      ])
        expect(column in row).toBe(false)
      expect((await nodes.list({ taskId }))[0]!.checkpoints).toEqual(expected)
      expect((await readNodeRunFixtures(harness.db, { id: runId }))[0]!.checkpoints).toEqual(
        expected,
      )
      const resumed = await new DrizzleWrapperRunPersistence(harness.db).findResumable({
        taskId,
        nodeId: 'wrapper',
        containerRunId: null,
        iteration: 0,
      })
      expect(resumed!.previous!.checkpoints).toEqual(expected)
      const drive = (await new DrizzleTaskEngineApplicationPersistence(harness.db).load(taskId))!
      expect(drive.repositories.map((repo) => repo.mountPath)).toEqual([...layout.mounts])
      for (const [ordinal, repo] of drive.repositories.entries()) {
        expect(repo.ordinal).toBe(ordinal)
        expect(repo.workspaceProfileDigest).toBe('profile')
        expect('worktreeDirName' in repo).toBe(false)
      }
      // Preserve epoch-1 asymmetry: a new attempt copies only the scalar workspace history.
      const inherited =
        layout.mounts.length === 0 || (layout.mounts.length === 1 && layout.mounts[0] === '')
          ? pre
          : []
      expect(row.checkpointInheritance).toEqual(inherited)
      const retryId = await harness.session.transaction((tx) =>
        createNodeRunMintParticipantInTx(tx).mint({
          ...deriveNodeRunRole({ nodeId: 'retry-copy', rerunCause: 'revival' }),
          taskId,
          nodeId: 'retry-copy',
          status: 'pending',
          cause: 'revival',
          inheritFrom: row,
        }),
      )
      expect((await nodes.read(retryId))!.checkpoints).toEqual(inherited)
      // The base clear is one merge-state CAS. Other components remain recorded.
      await patchNodeRunFixture(harness.db, { id: runId }, { mergeState: 'merged' })
      await merges.transition({
        nodeRunId: runId,
        event: { kind: 'reenter-isolation' },
        extra: {
          runtime: {
            isoWorktreePath: null,
            wrapperProgressJson: null,
          },
          checkpoint: {
            checkpoints: [{ mountPath, isolationBase: undefined }],
          },
        },
      })
      expect((await nodes.read(runId))!.checkpoints).toEqual([
        { mountPath, preSnapshot: '', nodeTree: '', submodules: topology },
      ])
      expect((await nodes.read(runId))!.mergeState).toBe('isolating')
      await nodes.patch({
        nodeRunId: runId,
        values: {
          checkpoint: {
            checkpoints: [],
          },
        },
      })
      expect((await nodes.read(runId))!.checkpoints).toEqual([])
    })
  }
})

describeEachProvider(
  'RFC-395 II-a conflict park preserves persisted component order',
  (harness) => {
    test('pending resolutions retain existing map keys before newly encountered mounts', async () => {
      const taskId = ulid(),
        runId = ulid()
      await taskFixture(harness.db, {
        id: taskId,
        workflowId: '00000000000000DIGEMPHOST0',
        workflowSnapshot: '{}',
        repoPath: '/repo',
        worktreePath: '/workspace',
        baseBranch: 'main',
        branch: 'task',
        status: 'running',
        inputs: '{}',
        startedAt: 1,
        repos: ['a', 'b', 'c'].map((mountPath, repoIndex) => ({
          mountPath,
          repoIndex,
          repoPath: `/repo/${mountPath}`,
          worktreePath: `/workspace/${mountPath}`,
          branch: 'task',
        })),
      })
      const old = {
        b: { poolDirs: {}, subBases: {} },
        a: { poolDirs: {}, subBases: {} },
        retired: null,
      }
      await nodeRunFixture(harness.db, {
        id: runId,
        taskId,
        nodeId: 'node',
        status: 'running',
      })
      await patchStoredCheckpointFixture(harness.db, runId, {
        preSnapshotReposJson: '{"a":"pre-a","b":"pre-b"}',
        isoSubmodulesReposJson: JSON.stringify(old),
      })
      const nodes = new DrizzleNodeExecutionPersistence(harness.db)
      await nodes.patch({
        nodeRunId: runId,
        values: {
          checkpoint: {
            pendingSubResolves: ['a', 'b', 'c'].map((mountPath) => ({
              mountPath,
              poolDirs: {},
              subBases: {},
              pendingSubResolves: ['vendor'],
            })),
          },
        },
      })
      const raw = await readStoredCheckpointFixture(harness.db, runId)
      expect(raw.isoSubmodulesReposJson).toBe(
        '{"b":{"poolDirs":{},"subBases":{},"pendingSubResolves":["vendor"]},"a":{"poolDirs":{},"subBases":{},"pendingSubResolves":["vendor"]},"retired":null,"c":{"poolDirs":{},"subBases":{},"pendingSubResolves":["vendor"]}}',
      )
      expect(raw.preSnapshotReposJson).toBe('{"a":"pre-a","b":"pre-b"}')
    })
  },
)
