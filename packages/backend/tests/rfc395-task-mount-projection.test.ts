import type { TaskCreationInput } from '@/modules/task-execution/application/ports/taskCreation'
import { createTaskCreationParticipantInTx } from '@/modules/task-execution/infrastructure/taskCreationParticipant'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { setDefaultTimeout, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { describeEachProvider } from './helpers/eachProvider'

const taskInput = (id: string): TaskCreationInput => ({
  subject: { kind: 'workflow', sourceId: 'workflow' },
  core: {
    id,
    name: id,
    status: 'failed',
    startedAt: 10,
    ownerUserId: null,
    catalogVisibility: 'public',
    branchStartedAt: 10,
  },
  definition: {
    definitionOrigin: 'authored',
    workflowSnapshot: '{"$schema_version":4,"inputs":[],"nodes":[],"edges":[]}',
    workflowVersion: 4,
    inputs: '{}',
  },
  launch: { kind: 'root', launchOrigin: 'api' },
  launchContext: {},
  workspace: {
    repoPath: '',
    worktreePath: '',
    baseBranch: '',
    branch: `agent-workflow/${id}`,
    baseCommit: null,
    spaceKind: 'scratch',
  },
  repos: [],
  nodePaths: [],
})

import { taskMountAtCreation } from '@/modules/task-execution/domain/taskCreation'
import {
  taskCheckpointMountPaths,
  taskMountKeysReader,
} from '@/modules/task-execution/infrastructure/taskCheckpointPersistence'
import { taskAggregateWrite } from '@/modules/task-execution/infrastructure/taskDefinitionWriteParticipant'
import { createTaskPreparationParticipantInTx } from '@/modules/task-execution/infrastructure/taskPreparationParticipant'
import {
  taskMountReadColumns,
  projectTaskMountReadRow,
  taskReadColumns,
} from '@/modules/task-execution/infrastructure/taskRepositorySql'
import { projectStoredTaskRepositorySurface } from '@/platform/persistence/taskRepositorySurface'
import {
  decodeRequestedSourceJson,
  encodeRequestedSource,
  requestedSourceAtCreation,
} from '@/platform/taskRepository'
import { isSingleRootRepository } from '@agent-workflow/shared'

const mount = (ordinal: number, mountPath: string) => ({
  ordinal,
  mountPath,
  repoPath: '/cache',
  repoUrl: 'file:///cache',
  cachedRepoId: null,
  baseBranch: 'main',
  branch: 'topic',
  workingBranch: null,
  baseCommit: 'sha',
  worktreePath: `/work/${mountPath}`,
  subdir: '',
  readonly: false,
  readonlyDirtyCount: null,
  workspaceProfileVersion: null,
  workspaceProfileDigest: null,
  hasSubmodules: false,
  submoduleInitOk: true,
  submoduleInitError: null,
})
describeEachProvider('RFC-395 T requested source and actual mounts', (harness) => {
  test('zero mounts project one DTO placeholder but no checkpoint mount', async () => {
    await harness.session.transaction((tx) =>
      createTaskCreationParticipantInTx(tx).create(taskInput('zero')),
    )
    const { tasks } = tablesOf(harness.db)
    const [row] = await harness.db.select(taskReadColumns(harness.db)).from(tasks)
    expect(projectStoredTaskRepositorySurface(row!).repos).toMatchObject([
      { repoIndex: 0, mountPath: '', worktreeDirName: '' },
    ])
    expect(await taskCheckpointMountPaths(harness.db, 'zero')).toEqual([])
    expect(await harness.session.transaction((tx) => taskMountKeysReader.list(tx, 'zero'))).toEqual(
      [],
    )
  })
  test('a sole svc mount stays non-root and retains its stable key', async () => {
    const input = taskInput('svc')
    await harness.session.transaction((tx) =>
      createTaskCreationParticipantInTx(tx).create({
        ...input,
        workspace: { ...input.workspace, worktreePath: '/work' },
        repos: [mount(0, 'svc')],
      }),
    )
    const before = await harness.session.transaction((tx) => taskMountKeysReader.list(tx, 'svc'))
    expect(isSingleRootRepository(before.map((row) => row.mountPath))).toBe(false)
    expect(await taskCheckpointMountPaths(harness.db, 'svc')).toEqual(['svc'])
    const { taskRepositoryMounts } = tablesOf(harness.db)
    const [row] = await harness.db
      .select(taskMountReadColumns(harness.db))
      .from(taskRepositoryMounts)
      .then((rows) => rows.map(projectTaskMountReadRow))
    expect(row?.worktreePath).toBe('/work/svc')
    expect(row?.worktreeDirName).toBe('svc')
    const { tasks } = tablesOf(harness.db)
    const [task] = await harness.db.select(taskReadColumns(harness.db)).from(tasks)
    const surface = projectStoredTaskRepositorySurface(task!, [row!])
    expect(surface.repoUrl).toBe('file:///cache')
    expect(surface.baseBranch).toBe('main')
    expect(decodeRequestedSourceJson(task!.requestedSource).repoUrl).toBeNull()

    expect(
      taskMountAtCreation('svc', { ...mount(1, 'svc'), repoKey: before[0]!.repoKey }).repoKey,
    ).toBe(before[0]!.repoKey)
  })
  test('reordering two mounts preserves repo keys while exchanging their ordinals', async () => {
    const base = taskInput('reorder')
    await harness.session.transaction((tx) =>
      createTaskCreationParticipantInTx(tx).create({
        ...base,
        workspace: { ...base.workspace, worktreePath: '/work' },
        repos: [mount(0, 'svc'), mount(1, 'web')],
      }),
    )
    const before = await harness.session.transaction((tx) =>
      taskMountKeysReader.list(tx, 'reorder'),
    )
    await harness.session.transaction(async (tx) => {
      await taskAggregateWrite.lockTaskAggregateRoot(tx, 'reorder')
      const { taskRepositoryMounts: mounts } = tablesOf(tx)
      await tx.update(mounts).set({ ordinal: 2 }).where(eq(mounts.repoKey, before[0]!.repoKey))
      await tx.update(mounts).set({ ordinal: 0 }).where(eq(mounts.repoKey, before[1]!.repoKey))
      await tx.update(mounts).set({ ordinal: 1 }).where(eq(mounts.repoKey, before[0]!.repoKey))
    })
    expect(
      await harness.session.transaction((tx) => taskMountKeysReader.list(tx, 'reorder')),
    ).toEqual([
      { ...before[1]!, ordinal: 0 },
      { ...before[0]!, ordinal: 1 },
    ])
  })
  for (const spaceKind of ['local', 'remote', 'scratch', 'internal', 'inherited'] as const)
    test(`the full zero-mount DTO preserves old projection bytes for ${spaceKind}`, async () => {
      const base = taskInput(`dto-${spaceKind}`)
      const input: TaskCreationInput = {
        ...base,
        workspace: {
          ...base.workspace,
          spaceKind,
          repoPath: '/requested/source',
          repoUrl: 'file:///requested/source',
          baseBranch: 'refs/tags/v1',
          baseCommit: 'abc',
        },
      }
      await harness.session.transaction((tx) => createTaskCreationParticipantInTx(tx).create(input))
      const { tasks } = tablesOf(harness.db)
      const [target] = await harness.db.select(taskReadColumns(harness.db)).from(tasks)
      const nodes = await harness.db.select().from(tablesOf(harness.db).taskSpaceNodes)
      const surface = projectStoredTaskRepositorySurface(
        target!,
        [],
        nodes.map((node) => node.nodePath),
      )
      expect(surface).toMatchObject({
        repoPath: '/requested/source',
        repoUrl: 'file:///requested/source',
        baseBranch: 'refs/tags/v1',
        baseCommit: 'abc',
        worktreePath: '',
        branch: `agent-workflow/dto-${spaceKind}`,
        repoCount: 1,
        spaceNodes: [{ path: '', origins: [] }],
        repos: [
          { repoIndex: 0, mountPath: '', worktreeDirName: '', worktreePath: '', baseCommit: 'abc' },
        ],
      })
    })
  test('binding a workspace preserves the frozen source and changes only the root reference and mounts', async () => {
    await harness.session.transaction((tx) =>
      createTaskCreationParticipantInTx(tx).create(taskInput('bind')),
    )
    const { tasks, taskWorkspaces } = tablesOf(harness.db)
    const before = await harness.db.select().from(taskWorkspaces)
    await harness.session.transaction((tx) =>
      createTaskPreparationParticipantInTx(tx).writeWorkspace({
        taskId: 'bind',
        worktreePath: '/work',
        branch: 'topic',
        baseCommit: 'sha',
        spaceKind: 'remote',
        repositories: [mount(0, 'svc')],
        nodePaths: ['svc'],
      }),
    )
    expect((await harness.db.select().from(taskWorkspaces))[0]?.requestedSource).toBe(
      before[0]?.requestedSource,
    )
    expect((await harness.db.select().from(taskWorkspaces))[0]?.taskBranch).toBe('topic')
    expect(
      (await harness.db.select().from(tasks).where(eq(tasks.id, 'bind')))[0]?.workspaceRootRef,
    ).toBe('/work')
  })
})
for (const spaceKind of ['local', 'remote', 'scratch', 'internal', 'inherited'] as const)
  test(`requested_source v2 preserves locator/ref bytes for ${spaceKind}`, () => {
    const input = {
      ...taskInput('source').workspace,
      spaceKind,
      repoPath: 'C:\\repo',
      repoUrl: 'file:///local/repo',
      cachedRepoId: 'cache',
      baseBranch: 'refs/tags/v1',
      baseCommit: 'abc',
    }
    const source = requestedSourceAtCreation(input)
    expect(decodeRequestedSourceJson(encodeRequestedSource(source))).toEqual(source)
    expect(source.repoPath).toBe(input.repoPath)
    expect(source.requestedRef).toEqual({
      value: 'refs/tags/v1',
      provenance: 'resolved-base-branch',
    })
  })

import { taskConversionRule } from '@/modules/task-execution/infrastructure/migration/task/rule'
import {
  repositoryUrlFactKey,
  repositoryUrlFacts,
  type RepositoryUrlFact,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import {
  convertTaskFixtures,
  repoRow,
  taskRow,
  writeTaskFixture,
} from './helpers/rfc395V2/taskFixtures'
import { describeV2Providers } from './helpers/rfc395V2Harness'

describeV2Providers('RFC-395 T composes B URL facts in its sole task claim', (h) => {
  for (const blocked of [false, true])
    test(`B URL fact ${blocked ? 'blocks without target rows' : 'changes workspace and mount with source evidence'}`, async () => {
      await h.install()
      const raw = 'https://example.test/repository.git/'
      const url = 'https://example.test/repository.git'
      const task = taskRow('url-fact', { repo_url: raw })
      await writeTaskFixture(h, task, { repos: [repoRow(task)] })
      const fact: RepositoryUrlFact = {
        state: blocked ? 'blocked' : 'proven',
        cachedRepoId: null,
        repoUrl: blocked ? null : url,
        rawUrlDigest: null,
        factIds: ['url-fixture'],
        reason: blocked ? 'v2-boot-url-unproven' : null,
      }
      const result = await convertTaskFixtures(h, {
        extra: [
          {
            rules: [],
            validators: [],
            lookups: [
              {
                key: repositoryUrlFacts,
                sources: [],
                build(_staged, put) {
                  put(repositoryUrlFactKey(raw), fact)
                },
              },
            ],
          },
        ],
      })
      if (blocked) {
        expect(result.summary.blocks.length).toBeGreaterThan(0)
        expect(result.sink.rows('task_workspaces')).toEqual([])
        expect(result.sink.rows('task_repository_mounts')).toEqual([])
      } else {
        expect(result.summary.blocks).toEqual([])
        expect(
          decodeRequestedSourceJson(
            String(result.sink.rows('task_workspaces')[0]!.requested_source),
          ).repoUrl,
        ).toBe(url)
        expect(result.sink.rows('task_repository_mounts')[0]!.repo_url).toBe(url)
        expect(
          [...result.sink.units.values()]
            .flatMap((unit) => unit.dispositions)
            .some(
              (row) =>
                row.decision?.code === 'v2-task-repository-url-converged' && row.archive !== null,
            ),
        ).toBe(true)
      }
      expect(taskConversionRule.claims.filter((table) => table === 'tasks')).toHaveLength(1)
      expect(taskConversionRule.lookups).toContain(repositoryUrlFacts)
    })
})

// W1 fixes: the persisted minimal tree and borrowed root are consumed by isolation, not inferred at read time.
import { DrizzleMergeStateLifecyclePersistence } from '@/modules/task-execution/infrastructure/mergeStateLifecyclePersistence'
import { DrizzleSchedulerCompletionPersistence } from '@/modules/task-execution/infrastructure/schedulerCompletionPersistence'
import { encodeCanonicalRunSlot } from '@/modules/task-execution/domain/runSelection/slotKey'
import { insertOne } from '@/platform/persistence/singleInsert'
import { createTaskDetailQueries } from '@/modules/task-execution/infrastructure/taskDetailQueries'

// Slowest case took 3.23 s on CI run 40433510287 including hooks; allow 20 s.
setDefaultTimeout(20_000)

describeEachProvider(
  'RFC-395 W1 borrowed workspace and stored directory regressions',
  (harness) => {
    test('a borrowed root creates a checkpoint mount and survives isolation plus readonly-dirty completion', async () => {
      const base = taskInput('borrowed')
      await harness.session.transaction((tx) =>
        createTaskCreationParticipantInTx(tx).create({
          ...base,
          core: { ...base.core, status: 'running' },
          workspace: {
            ...base.workspace,
            spaceKind: 'local',
            repoPath: '/borrowed',
            worktreePath: '/borrowed',
            baseBranch: 'main',
            branch: 'main',
            baseCommit: 'base',
          },
        }),
      )
      const tables = tablesOf(harness.db)
      const [mount] = await harness.db.select().from(tables.taskRepositoryMounts)
      expect(mount).toMatchObject({
        ordinal: 0,
        mountPath: '',
        repoPath: '/borrowed',
        baseBranch: 'main',
        branch: 'main',
        baseCommit: 'base',
        readonly: false,
        hasSubmodules: null,
        submoduleInitOk: null,
      })
      expect(await taskCheckpointMountPaths(harness.db, 'borrowed')).toEqual([''])
      await insertOne(harness.db, tables.nodeRuns, {
        id: 'isolated-run',
        taskId: 'borrowed',
        nodeId: 'worker',
        seq: 1,
        role: 'node-attempt',
        slotKey: encodeCanonicalRunSlot({
          kind: 'node',
          nodeId: 'worker',
          frame: { containerRunId: null, iteration: 0 },
        }),
        generationSeq: 0,
        attemptIndex: 0,
        recordMode: 'executable',
        provenanceQuality: 'recorded',
        envelopeNonce: 'nonce',
        status: 'running',
      })
      await new DrizzleMergeStateLifecyclePersistence(harness.db).transition({
        nodeRunId: 'isolated-run',
        event: { kind: 'begin-isolation' },
        extra: {
          runtime: { isoWorktreePath: '/isolation' },
          checkpoint: { checkpoints: [{ mountPath: '', isolationBase: 'base-tree' }] },
        },
      })
      expect(await harness.db.select().from(tables.nodeRunRepoCheckpoints)).toMatchObject([
        {
          taskId: 'borrowed',
          nodeRunId: 'isolated-run',
          repoKey: mount!.repoKey,
          isolationBase: 'base-tree',
        },
      ])
      await new DrizzleSchedulerCompletionPersistence(harness.db).recordReadonlyDirty({
        taskId: 'borrowed',
        repoIndex: 0,
        changedCount: 3,
        now: 20,
      })
      expect(
        (await harness.db.select().from(tables.taskRepositoryMounts))[0]!.readonlyDirtyCount,
      ).toBe(3)
      expect((await createTaskDetailQueries(harness.db).read('borrowed'))!.task.spaceNodes).toEqual(
        [{ path: '', origins: [] }],
      )
    })
    for (const via of ['creation', 'preparation'] as const)
      test(`${via} persists mount ancestors and explicit empty directories`, async () => {
        const base = taskInput(via)
        const repos = [mount(0, 'apps/api'), mount(1, 'apps/web')]
        await harness.session.transaction(async (tx) => {
          await createTaskCreationParticipantInTx(tx).create(
            via === 'creation'
              ? {
                  ...base,
                  repos,
                  nodePaths: ['empty/dir'],
                  workspace: { ...base.workspace, worktreePath: '/work' },
                }
              : base,
          )
          if (via === 'preparation')
            await createTaskPreparationParticipantInTx(tx).writeWorkspace({
              taskId: via,
              worktreePath: '/work',
              branch: 'topic',
              baseCommit: 'sha',
              spaceKind: 'remote',
              repositories: repos,
              nodePaths: ['empty/dir'],
            })
        })
        const nodes = await harness.db.select().from(tablesOf(harness.db).taskSpaceNodes)
        expect(nodes.map((node) => node.nodePath).sort()).toEqual([
          '',
          'apps',
          'apps/api',
          'apps/web',
          'empty',
          'empty/dir',
        ])
        expect(
          (await createTaskDetailQueries(harness.db).read(via))!.task
            .spaceNodes!.map((node) => node.path)
            .sort(),
        ).toEqual(['', 'apps', 'apps/api', 'apps/web', 'empty', 'empty/dir'])
      })
    test('settlement replay is a clean CAS miss and preserves the first workspace', async () => {
      await harness.session.transaction((tx) =>
        createTaskCreationParticipantInTx(tx).create(taskInput('settle-once')),
      )
      const settlement = {
        taskId: 'settle-once',
        worktreePath: '/first',
        branch: 'first',
        baseCommit: 'first-base',
        spaceKind: 'scratch' as const,
        repositories: [],
        nodePaths: [],
      }
      await harness.session.transaction((tx) =>
        createTaskPreparationParticipantInTx(tx).writeWorkspace(settlement),
      )
      const tables = tablesOf(harness.db)
      const before = {
        tasks: await harness.db.select().from(tables.tasks),
        workspaces: await harness.db.select().from(tables.taskWorkspaces),
        mounts: await harness.db.select().from(tables.taskRepositoryMounts),
        nodes: await harness.db.select().from(tables.taskSpaceNodes),
      }
      expect(before.mounts).toMatchObject([{ ordinal: 0, mountPath: '', baseCommit: 'first-base' }])
      await expect(
        harness.session.transaction((tx) =>
          createTaskPreparationParticipantInTx(tx).writeWorkspace({
            ...settlement,
            worktreePath: '/second',
            branch: 'second',
          }),
        ),
      ).rejects.toThrow('task-aggregate-cas-miss:settle-once')
      expect({
        tasks: await harness.db.select().from(tables.tasks),
        workspaces: await harness.db.select().from(tables.taskWorkspaces),
        mounts: await harness.db.select().from(tables.taskRepositoryMounts),
        nodes: await harness.db.select().from(tables.taskSpaceNodes),
      }).toEqual(before)
    })
  },
)
