import { composeTaskExecutionResourceBinding } from '@/modules/resource-catalog/composition/taskExecution'
import { createTaskExecutionResourceBinding } from '@/services/execution/taskExecutionResources'
import { taskExecutionResourceDependencies } from '@/services/execution/taskExecutionResourceDependencies'
import { composeWorkspacePreparationMaintenance } from '@/modules/task-execution/composition/workspacePreparationMaintenance'
import { materializingSpaces } from '@/services/gc'
import { activeTaskIdsSnapshot } from '@/services/task'
import { compensatePreMaterializedRepository } from '@/modules/task-execution/infrastructure/preMaterializedRepositoryWorkspace'
import type { ProviderNeutralDatabase } from '@/db/query'
// RFC-363: exercise the production Task kernel, real provider transactions and Git adapter.
// These cases protect the gap between source freezing, a durable SC receipt and Task acceptance.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { StartTaskSchema, WorkflowDefinitionSchema } from '@agent-workflow/shared'
import { admitDaemonIdentity, actorOfDirectAuthority } from '@/auth/session'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { composeRepositoryPreparation } from '@/modules/source-control/composition/repositoryPreparation'
import { createRepositoryPreparationJournal } from '@/modules/source-control/infrastructure/repositoryPreparationJournal'
import {
  createRootTaskLaunchKernel,
  createTaskRouteWorkspaceParticipant,
} from '@/modules/task-execution/composition/taskRouteLaunch'
import { createWorkspacePreparationJournal } from '@/modules/task-execution/infrastructure/workspacePreparationJournal'
import {
  acceptDurableRepositoryWorkspace,
  prepareDurableRepositoryWorkspace,
  cleanupDurableRepositoryWorkspace,
} from '@/modules/task-execution/infrastructure/durableRepositoryPreparation'
import {
  tasks,
  workflows,
  scRepositorySnapshots,
  scPreparationOperations,
  taskExecutionOwners,
  repoGroups,
  repoGroupNodes,
} from '@/db/schema'
import { describeEachProvider } from './helpers/eachProvider'
import { remoteUrlFor, startGitHttpRemote, stopGitHttpRemote } from './helpers/gitHttpRemote'

const roots: string[] = []
beforeAll(async () => {
  await startGitHttpRemote()
})
afterAll(stopGitHttpRemote)
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function git(...args: string[]) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

describeEachProvider('RFC-363 Task preparation admission', (harness) => {
  async function fixture() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'rfc363-task-admission-')))
    roots.push(home)
    const working = join(home, 'source'),
      bare = join(home, 'remote.git'),
      appHome = join(home, 'app')
    mkdirSync(working)
    git('init', '-b', 'main', working)
    git('-C', working, 'config', 'user.name', 'Fixture')
    git('-C', working, 'config', 'user.email', 'fixture@example.test')
    writeFileSync(join(working, 'README.md'), 'frozen source\n')
    git('-C', working, 'add', 'README.md')
    git('-C', working, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'initial')
    git('clone', '--bare', working, bare)
    const identityAccess = createIdentityAccessRuntime({ db: harness.db })
    const identity = await admitDaemonIdentity(identityAccess)
    if (identity === null) throw new Error('daemon identity missing')
    const actor = actorOfDirectAuthority(identity)
    const workflowId = ulid()
    const definition = WorkflowDefinitionSchema.parse({
      $schema_version: 1,
      inputs: [],
      nodes: [],
      edges: [],
    })
    await harness.db
      .insert(workflows)
      .values({ id: workflowId, name: workflowId, definition: JSON.stringify(definition) })
    const binding = composeRepositoryPreparation({ db: harness.db, appHome })
    const workspace = createTaskRouteWorkspaceParticipant({
      db: harness.db,
      appHome,
      repositoryPreparation: binding,
    })
    const submitted: string[] = []
    function kernel(rollback = false, inspect?: (path: string, taskId: string) => Promise<void>) {
      return createRootTaskLaunchKernel({
        db: harness.db,
        gitCommitIdentity: identityAccess.getUserGitCommitIdentity,
        workspace:
          rollback || inspect !== undefined
            ? {
                async prepare(request) {
                  const prepared = await workspace.prepare(request)
                  return {
                    ...prepared,
                    async admit(tx: ProviderNeutralDatabase) {
                      await inspect?.(prepared.worktreePath, prepared.taskId)
                      await prepared.admit!(tx)
                      if (rollback) throw new Error('reject-after-source-freeze')
                    },
                  }
                },
              }
            : workspace,
        coordinator: {
          async submit(request) {
            submitted.push(request.taskId)
            return { kind: 'accepted', taskId: request.taskId }
          },
        },
      })
    }
    const request = {
      actor,
      resourceAuthority: {
        actor,
        authority: identity.authority,
        resources: createTaskExecutionResourceBinding(
          harness.db,
          composeTaskExecutionResourceBinding(taskExecutionResourceDependencies),
        ),
      },
      invoker: { type: 'user' as const, launchKind: 'direct-json' as const },
      task: StartTaskSchema.parse({
        workflowId,
        name: 'durable task',
        repoUrl: remoteUrlFor(bare),
        inputs: {},
      }),
      subject: {
        workflowId,
        workflowName: workflowId,
        workflowVersion: 1,
        workflowSnapshot: definition,
        builtin: false,
      },
      deferRepoPreparation: true,
    }
    function effect(taskId: string, signal = new AbortController().signal) {
      return {
        db: harness.db,
        binding: composeRepositoryPreparation({ db: harness.db, appHome }),
        taskId,
        gitCommitIdentity: null,
        signal,
      }
    }
    return { appHome, kernel, request, submitted, effect, workspace, binding }
  }
  test('Task admission atomically creates the frozen source and unmaterialized plan', async () => {
    const f = await fixture()
    const task = await f.kernel().launch(f.request)
    const journal = createWorkspacePreparationJournal(harness.db)
    const plan = await journal.forTask(task.id)
    expect(task.worktreePath).toBe('')
    expect(task.status).toBe('pending')
    expect(plan).toMatchObject({
      id: task.id,
      admittedTaskId: task.id,
      state: 'preparing',
      lane: 'repository-preparation',
      ownerFence: 0,
    })
    const operation = await createRepositoryPreparationJournal(harness.db).operation(
      plan!.operationRef!,
    )
    expect(operation?.state).toBe('planned')
    expect(
      (await createRepositoryPreparationJournal(harness.db).snapshot(operation!.snapshotRef))
        ?.factsJson,
    ).toContain('repository')
    expect(existsSync(join(f.appHome, 'worktrees'))).toBe(false)
    expect(f.submitted).toEqual([task.id])
  })
  test('a group edited after Task admission does not replace the frozen preparation layout', async () => {
    const f = await fixture()
    const single = await f.kernel().launch(f.request)
    const row = (await harness.db.select().from(tasks).where(eq(tasks.id, single.id)))[0]!
    const groupId = ulid()
    await harness.db
      .insert(repoGroups)
      .values({ id: groupId, name: 'frozen-group', version: 1, createdAt: 1, updatedAt: 1 })
    await harness.db.insert(repoGroupNodes).values([
      { groupId, path: '', attachmentKind: null },
      {
        groupId,
        path: 'code',
        attachmentKind: 'repo',
        cachedRepoId: row.cachedRepoId!,
        ref: 'main',
      },
      { groupId, path: 'docs', attachmentKind: null },
    ])
    const task = await f.kernel().launch({
      ...f.request,
      task: StartTaskSchema.parse({
        workflowId: f.request.task.workflowId,
        name: 'frozen group',
        repoGroupId: groupId,
        inputs: {},
      }),
    })
    await harness.db.delete(repoGroupNodes).where(eq(repoGroupNodes.groupId, groupId))
    await harness.db.update(repoGroups).set({ version: 2 }).where(eq(repoGroups.id, groupId))
    const space = await prepareDurableRepositoryWorkspace(f.effect(task.id))
    expect(space?.earlyError).toBeNull()
    expect(space?.kind).toBe('group')
    expect(space?.nodePaths).toEqual(['', 'code', 'docs'])
    expect(readFileSync(join(space!.worktreePath, 'code', 'README.md'), 'utf8')).toBe(
      'frozen source\n',
    )
  }, 60_000)
  test('an active Task owner fences an ownerless physical attempt before Git runs', async () => {
    const f = await fixture()
    const task = await f.kernel().launch(f.request)
    const now = Date.now()
    await harness.db.insert(taskExecutionOwners).values({
      taskId: task.id,
      ownerId: 'existing-owner',
      daemonGeneration: 'daemon-1',
      epoch: 1,
      state: 'claimed',
      leaseUntil: now + 60_000,
      revision: 1,
      lastHeartbeatAt: now,
      updatedAt: now,
    })
    await expect(prepareDurableRepositoryWorkspace(f.effect(task.id))).rejects.toMatchObject({
      code: 'task-execution-stale-owner',
    })
    expect(existsSync(join(f.appHome, 'worktrees'))).toBe(false)
    const plan = await createWorkspacePreparationJournal(harness.db).forTask(task.id)
    expect(
      (await createRepositoryPreparationJournal(harness.db).operation(plan!.operationRef!))?.state,
    ).toBe('planned')
  })
  test('a failure after source freezing rolls back Task, plan, operation and snapshot together', async () => {
    const f = await fixture()
    await expect(f.kernel(true).launch(f.request)).rejects.toThrow('reject-after-source-freeze')
    expect(await harness.db.select().from(tasks)).toEqual([])
    expect(await harness.db.select().from(scRepositorySnapshots)).toEqual([])
    expect(await harness.db.select().from(scPreparationOperations)).toEqual([])
    expect(f.submitted).toEqual([])
  })
  test('a recreated driver reuses the physical receipt and Task acceptance shares the projection transaction', async () => {
    const f = await fixture()
    const task = await f.kernel().launch(f.request)
    const space = await prepareDurableRepositoryWorkspace(f.effect(task.id))
    expect(space?.earlyError).toBeNull()
    writeFileSync(join(space!.worktreePath, 'retain.txt'), 'receipt reuse')
    const replay = await prepareDurableRepositoryWorkspace(f.effect(task.id))
    expect(replay?.worktreePath).toBe(space!.worktreePath)
    expect(readFileSync(join(replay!.worktreePath, 'retain.txt'), 'utf8')).toBe('receipt reuse')
    await expect(
      harness.session.transaction(async (tx) => {
        await acceptDurableRepositoryWorkspace(tx, task.id)
        await tx
          .update(tasks)
          .set({ worktreePath: space!.worktreePath })
          .where(eq(tasks.id, task.id))
        throw new Error('projection-rollback')
      }),
    ).rejects.toThrow('projection-rollback')
    expect((await createWorkspacePreparationJournal(harness.db).forTask(task.id))?.state).toBe(
      'prepared',
    )
    expect(
      (await harness.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]?.worktreePath,
    ).toBe('')
    await harness.session.transaction(async (tx) => {
      await acceptDurableRepositoryWorkspace(tx, task.id)
      await tx.update(tasks).set({ worktreePath: space!.worktreePath }).where(eq(tasks.id, task.id))
    })
    expect((await createWorkspacePreparationJournal(harness.db).forTask(task.id))?.state).toBe(
      'admitted',
    )
    await expect(cleanupDurableRepositoryWorkspace(f.effect(task.id))).rejects.toMatchObject({
      code: 'workspace-preparation-owner-changed',
    })
    expect(existsSync(space!.worktreePath)).toBe(true)
  }, 60_000)
  test('cancellation cleanup is durable and an explicit subsequent attempt keeps the frozen source', async () => {
    const f = await fixture()
    const task = await f.kernel().launch(f.request)
    const space = await prepareDurableRepositoryWorkspace(f.effect(task.id))
    const before = await createWorkspacePreparationJournal(harness.db).forTask(task.id)
    const original = await createRepositoryPreparationJournal(harness.db).operation(
      before!.operationRef!,
    )
    const controller = new AbortController()
    controller.abort('canceled')
    const cleanup = await cleanupDurableRepositoryWorkspace(f.effect(task.id, controller.signal))
    expect(cleanup?.complete).toBe(true)
    expect(existsSync(space!.worktreePath)).toBe(false)
    expect(await cleanupDurableRepositoryWorkspace(f.effect(task.id, controller.signal))).toEqual(
      cleanup,
    )
    const retried = await prepareDurableRepositoryWorkspace(f.effect(task.id))
    expect(retried?.earlyError).toBeNull()
    const after = await createWorkspacePreparationJournal(harness.db).forTask(task.id)
    expect(after!.operationRef).not.toBe(before!.operationRef)
    expect(
      (await createRepositoryPreparationJournal(harness.db).operation(after!.operationRef!))
        ?.snapshotRef,
    ).toBe(original!.snapshotRef)
  }, 60_000)
  test('synchronous preparation is accepted in the Task INSERT transaction', async () => {
    const f = await fixture()
    const task = await f.kernel().launch({ ...f.request, deferRepoPreparation: false })
    expect(task.status).toBe('pending')
    expect(readFileSync(join(task.worktreePath, 'README.md'), 'utf8')).toBe('frozen source\n')
    expect(await createWorkspacePreparationJournal(harness.db).forTask(task.id)).toMatchObject({
      lane: 'pre-materialized',
      state: 'admitted',
      admittedTaskId: task.id,
    })
    expect(materializingSpaces.has(task.id)).toBe(false)
    await expect(
      compensatePreMaterializedRepository({ db: harness.db, binding: f.binding, taskId: task.id }),
    ).rejects.toMatchObject({ code: 'workspace-preparation-owner-changed' })
    expect(existsSync(task.worktreePath)).toBe(true)
  }, 60_000)
  test('synchronous admission rollback preserves the failed Task transaction and durably compensates Git', async () => {
    const f = await fixture()
    await expect(
      f.kernel(true).launch({ ...f.request, deferRepoPreparation: false }),
    ).rejects.toThrow('reject-after-source-freeze')
    expect(await harness.db.select().from(tasks)).toEqual([])
    const operations = await harness.db.select().from(scPreparationOperations)
    expect(operations).toHaveLength(1)
    expect(operations[0]?.state).toBe('cleaned')
    expect(f.submitted).toEqual([])
  }, 60_000)
  test('before Task admission, a fresh adapter reuses the receipt and uploaded files; old orphan GC compensates once', async () => {
    const f = await fixture()
    const taskId = ulid()
    const input = {
      actor: f.request.actor,
      authority: f.request.resourceAuthority.authority,
      taskId,
      task: f.request.task,
      gitCommitIdentity: null,
    }
    const first = await f.workspace.prepare(input)
    expect(await harness.db.select().from(tasks)).toEqual([])
    expect(await createWorkspacePreparationJournal(harness.db).read(taskId)).toMatchObject({
      state: 'prepared',
      lane: 'pre-materialized',
      admittedTaskId: null,
    })
    expect(activeTaskIdsSnapshot()).toContain(taskId)
    writeFileSync(join(first.worktreePath, 'uploaded.txt'), 'before admission')
    const rebound = createTaskRouteWorkspaceParticipant({
      db: harness.db,
      appHome: f.appHome,
      repositoryPreparation: composeRepositoryPreparation({ db: harness.db, appHome: f.appHome }),
    })
    const replay = await rebound.prepare(input)
    expect(replay.worktreePath).toBe(first.worktreePath)
    expect(readFileSync(join(replay.worktreePath, 'uploaded.txt'), 'utf8')).toBe('before admission')
    const gcInputs: string[][] = []
    const maintenance = composeWorkspacePreparationMaintenance({
      db: harness.db,
      appHome: f.appHome,
      repositoryPreparation: composeRepositoryPreparation({ db: harness.db, appHome: f.appHome }),
      maintenance: {
        async runGcPhase(request) {
          gcInputs.push([...request.activeTaskIds])
          return { scanned: 0, removed: 0, skipped: 0 }
        },
        async recover() {
          return { completed: 0, failed: 0, skipped: 0, healed: 0 }
        },
      },
    })
    const gc = {
      phase: 'orphan' as const,
      worktreeAutoGc: { enabled: false },
      activeTaskIds: [taskId],
      now: Date.now() + 25 * 60 * 60 * 1000,
      gitCloneTimeoutMs: 60_000,
    }
    expect((await maintenance.runGcPhase(gc)).removed).toBe(0)
    expect(existsSync(first.worktreePath)).toBe(true)
    materializingSpaces.delete(taskId) // The original process no longer owns a preparation lease.
    expect((await maintenance.runGcPhase({ ...gc, activeTaskIds: [] })).removed).toBe(1)
    expect(existsSync(first.worktreePath)).toBe(false)
    expect((await createWorkspacePreparationJournal(harness.db).read(taskId))?.state).toBe(
      'cleaned',
    )
    expect(gcInputs[1]).toContain(taskId)
    expect((await maintenance.runGcPhase({ ...gc, activeTaskIds: [] })).removed).toBe(0)
    expect(await harness.db.select().from(tasks)).toEqual([])
  }, 60_000)
  test('multipart uploads land before Task admission and consume the same prepared receipt', async () => {
    const f = await fixture()
    let observed = false
    const task = await f
      .kernel(false, async (path, taskId) => {
        expect(await harness.db.select().from(tasks).where(eq(tasks.id, taskId))).toEqual([])
        expect(readFileSync(join(path, 'inputs', 'attachment.txt'), 'utf8')).toBe(
          'uploaded before Task',
        )
        expect((await createWorkspacePreparationJournal(harness.db).read(taskId))?.state).toBe(
          'prepared',
        )
        observed = true
      })
      .launch({
        ...f.request,
        uploads: {
          parts: [
            {
              inputKey: 'refs',
              filename: 'attachment.txt',
              declaredMime: 'text/plain',
              blob: new Blob(['uploaded before Task']),
            },
          ],
          definitions: new Map([['refs', { key: 'refs', targetDir: 'inputs' }]]),
          limits: { perFile: 1024, perRequest: 1024, perCount: 1 },
        },
      })
    expect(observed).toBe(true)
    expect(task.inputs.refs).toBe('inputs/attachment.txt')
    expect((await createWorkspacePreparationJournal(harness.db).forTask(task.id))?.state).toBe(
      'admitted',
    )
    expect(materializingSpaces.has(task.id)).toBe(false)
  }, 60_000)
})
