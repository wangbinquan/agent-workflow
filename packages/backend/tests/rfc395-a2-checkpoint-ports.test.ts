import { composeHumanGateOpenParticipantFactory } from '@/modules/collaboration/composition'
import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'
import { taskAggregateWrite } from '@/modules/task-execution/infrastructure/taskDefinitionWriteParticipant'
import { withTargetMintIdentity } from './helpers/rfc395Mint'
import { o2Ports } from './helpers/o2Closure'
// RFC-395 II-a A2: list ports must round-trip every mount shape on both physical providers.
import { expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { readStoredCheckpointFixture } from './helpers/model/checkpoint'
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
      const definition = JSON.stringify({
        $schema_version: 6,
        inputs: [],
        nodes: [{ id: 'wrapper', kind: 'wrapper-git', nodeIds: [] }],
        edges: [],
      })
      await workflowFixture(harness.db, { id: workflowId, name: 'checkpoints', definition })
      await taskFixture(harness.db, {
        id: taskId,
        workflowId,
        workflowSnapshot: definition,
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
      const { taskRepositoryMounts } = tablesOf(harness.db)
      const mount = (
        await harness.db
          .select()
          .from(taskRepositoryMounts)
          .where(eq(taskRepositoryMounts.taskId, taskId))
      ).find((repo) => repo.mountPath === mountPath)!
      expect(stored.checkpoints).toEqual([
        {
          nodeRunId: runId,
          taskId,
          repoKey: mount.repoKey,
          preSnapshot: '',
          isolationBase: 'base',
          nodeTree: '',
          submodules: JSON.stringify(topology),
        },
      ])
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
            humanGateOpen: composeHumanGateOpenParticipantFactory(),
            historyRestrictions: epoch2RuntimeTestPorts(harness.db).historyRestrictions,
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
        checkpoints: beforeEmpty.checkpoints,
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
      // Target attempts inherit every real mount's preSnapshot, including empty strings.
      const inherited = pre
      expect(row.checkpointInheritance).toEqual(inherited)
      const retryId = await harness.session.transaction(async (tx) => {
        await taskAggregateWrite.lockTaskAggregateRoot(tx, taskId)
        return createNodeRunMintParticipantInTx(tx).mint(
          withTargetMintIdentity({
            role: 'node-attempt',
            syntheticKind: null,
            taskId,
            nodeId: 'retry-copy',
            status: 'pending',
            cause: 'revival',
            inheritFrom: row,
          }),
        )
      })
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
      expect((await nodes.read(runId))!.checkpoints).toEqual([{ mountPath }])
    })
  }
})

describeEachProvider(
  'RFC-395 II-a conflict park preserves persisted component order',
  (harness) => {
    test('pending resolutions retain each actual repo key and read in mount ordinal order', async () => {
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
      await nodeRunFixture(harness.db, {
        id: runId,
        taskId,
        nodeId: 'node',
        status: 'running',
      })
      const nodes = new DrizzleNodeExecutionPersistence(harness.db)
      await nodes.patch({
        nodeRunId: runId,
        values: {
          checkpoint: {
            checkpoints: [
              { mountPath: 'b', preSnapshot: 'pre-b', submodules: { poolDirs: {}, subBases: {} } },
              { mountPath: 'a', preSnapshot: 'pre-a', submodules: { poolDirs: {}, subBases: {} } },
            ],
          },
        },
      })
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
      expect(raw.checkpoints).toHaveLength(3)
      const projected = (await nodes.read(runId))!.checkpoints
      expect(projected.map((row) => row.mountPath)).toEqual(['a', 'b', 'c'])
      for (const row of projected)
        expect(row.submodules).toEqual({
          poolDirs: {},
          subBases: {},
          pendingSubResolves: ['vendor'],
        })
      expect(projected.map((row) => row.preSnapshot)).toEqual(['pre-a', 'pre-b', undefined])
      await expect(
        nodes.patch({
          nodeRunId: runId,
          values: { checkpoint: { checkpoints: [{ mountPath: 'retired', preSnapshot: 'lost' }] } },
        }),
      ).rejects.toThrow('node-run-checkpoint-mount-missing:retired')
    })
  },
)
