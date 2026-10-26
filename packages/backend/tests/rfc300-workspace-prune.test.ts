// RFC-395 II-pre：GC 改接生产 workspaceMaintenance，断言其回执及实际目录 / 行状态。
// RFC-300 — physical cleanup/recovery matrix for direct Webhook task-owned
// workspaces. Exercises real linked-worktree registry removal, snapshot refs,
// whole scratch-repository deletion, active-owner deferral, lease retry, boot
// replay, adjacent exclusions, and idempotent crash windows.

import {
  type TaskFixtureSpec,
  nodeRunFixture,
  nodeRunOutputFixture,
  readNodeRunOutputFixtures,
  readTaskFixtures,
  taskFixture,
  taskRepoFixture,
  workflowFixture,
  readNodeRunFixtures,
} from './helpers/model'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { TaskStatus } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { WORKSPACE_PRUNING_LEASE_MS } from '@/modules/source-control/application/workspaceMaintenance'
import { workspaceMaintenanceForTest } from './helpers/workspaceMaintenance'
import { getTask } from '../src/services/task'
import { runGit, snapshotRefName, snapshotRefPrefix } from '../src/util/git'

const ulid = monotonicFactory()

let db: DbClient
let root: string
let workflowId: string

beforeEach(async () => {
  db = createInMemoryDb()
  root = mkdtempSync(join(tmpdir(), 'aw-rfc300-prune-'))
  workflowId = ulid()
  await workflowFixture(db, { id: workflowId, name: 'rfc300', definition: '{}' })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function seedTask(overrides: Partial<TaskFixtureSpec> = {}): Promise<string> {
  const id = overrides.id ?? ulid()
  await taskFixture(db, {
    id,
    name: 'rfc300-prune',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: join(root, 'source-missing'),
    worktreePath: join(root, 'workspace-missing'),
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'done',
    inputs: '{}',
    startedAt: 1,
    finishedAt: 2,
    webhookTriggerId: 'trigger-deleted-after-launch',
    spaceKind: 'scratch',
    workspacePruningAt: 100,
    workspacePruneCause: 'webhook-terminal',
    ...overrides,
  })
  return id
}

async function rowOf(id: string) {
  return (await readTaskFixtures(db, { id }))[0]!
}

async function createLinkedWorktreeTask(status: 'done' | 'canceled') {
  const id = ulid()
  const repo = join(root, `source-${status}`)
  mkdirSync(repo, { recursive: true })
  expect((await runGit(repo, ['init', '-q', '-b', 'main'])).exitCode).toBe(0)
  writeFileSync(join(repo, 'README.md'), 'base\n')
  expect((await runGit(repo, ['add', 'README.md'])).exitCode).toBe(0)
  expect(
    (
      await runGit(repo, ['commit', '-q', '-m', 'base'], {
        env: {
          GIT_AUTHOR_NAME: 'RFC300',
          GIT_AUTHOR_EMAIL: 'rfc300@example.test',
          GIT_COMMITTER_NAME: 'RFC300',
          GIT_COMMITTER_EMAIL: 'rfc300@example.test',
        },
      })
    ).exitCode,
  ).toBe(0)
  const worktree = join(root, `linked-${status}`)
  const branch = `agent-workflow/${id}`
  expect(
    (await runGit(repo, ['worktree', 'add', '-q', '-b', branch, worktree, 'HEAD'])).exitCode,
  ).toBe(0)
  const snapshotRef = snapshotRefName(id, 'node-1')
  expect((await runGit(repo, ['update-ref', snapshotRef, 'HEAD'])).exitCode).toBe(0)
  await seedTask({
    id,
    status,
    repoPath: repo,
    worktreePath: worktree,
    branch,
    spaceKind: 'remote',
  })
  return { id, repo, worktree, snapshotRef }
}

describe('RFC-300 physical workspace deletion', () => {
  test('task detail projects available/pruning/pruned without exposing timestamps', async () => {
    const availableId = await seedTask({
      workspacePruningAt: null,
      workspacePruneCause: null,
      workspacePrunedAt: null,
    })
    const pruningId = await seedTask({ workspacePruningAt: 10, workspacePrunedAt: null })
    const prunedId = await seedTask({ workspacePruningAt: 10, workspacePrunedAt: 11 })

    expect((await getTask(db, availableId))?.workspaceState).toBe('available')
    expect((await getTask(db, pruningId))?.workspaceState).toBe('pruning')
    expect((await getTask(db, prunedId))?.workspaceState).toBe('pruned')
  })

  for (const status of ['done', 'canceled'] as const) {
    test(`removes real remote linked worktree + snapshot refs on ${status}`, async () => {
      const task = await createLinkedWorktreeTask(status)

      expect(
        await workspaceMaintenanceForTest(db).finalizeClaimedWorkspace(task.id, 200),
      ).toBeUndefined()
      expect(existsSync(task.worktree)).toBe(false)
      const registry = await runGit(task.repo, ['worktree', 'list', '--porcelain'])
      expect(registry.stdout).not.toContain(task.worktree)
      const refs = await runGit(task.repo, [
        'for-each-ref',
        '--format=%(refname)',
        snapshotRefPrefix(task.id),
      ])
      expect(refs.stdout.trim()).toBe('')
      expect((await rowOf(task.id)).workspacePrunedAt).toBe(200)
      // The durable task row/history survives physical cleanup.
      expect((await rowOf(task.id)).status).toBe(status)
    })
  }

  for (const status of ['done', 'canceled'] as const) {
    test(`deletes the whole scratch Git repository on ${status}`, async () => {
      const scratch = join(root, `scratch-${status}`)
      mkdirSync(scratch, { recursive: true })
      expect((await runGit(scratch, ['init', '-q', '-b', 'main'])).exitCode).toBe(0)
      writeFileSync(join(scratch, 'temporary-output.txt'), 'ephemeral')
      const archivePath = join(root, `persisted-archive-${status}.txt`)
      writeFileSync(archivePath, 'archived outside the workspace')
      const id = await seedTask({
        status,
        repoPath: scratch,
        worktreePath: scratch,
        spaceKind: 'scratch',
      })
      const nodeRunId = ulid()
      const { nodeRunEvents } = tablesOf(db)
      await nodeRunFixture(db, {
        id: nodeRunId,
        taskId: id,
        nodeId: 'persisted-result',
        status,
        iteration: 0,
        retryIndex: 0,
        startedAt: 1,
        finishedAt: 2,
        opencodeSessionId: `session-${status}`,
      })
      const archiveJson = JSON.stringify({
        v: 1,
        items: [{ path: 'result.txt', file: archivePath, size: 30, truncated: false }],
      })
      await nodeRunOutputFixture(db, {
        nodeRunId,
        portName: 'result',
        content: 'persisted outside the workspace',
        archiveJson,
      })
      await insertOne(db, nodeRunEvents, {
        nodeRunId,
        ts: 1,
        kind: 'text',
        payload: '{"text":"persisted event"}',
        sessionId: `session-${status}`,
      })

      expect(
        await workspaceMaintenanceForTest(db).finalizeClaimedWorkspace(id, 201),
      ).toBeUndefined()
      expect(existsSync(scratch)).toBe(false)
      const row = await rowOf(id)
      expect(row.status).toBe(status)
      expect(row.workspacePrunedAt).toBe(201)
      const persistedRun = (await readNodeRunFixtures(db, { id: nodeRunId }))[0]
      expect(persistedRun?.status).toBe(status)
      expect(persistedRun?.opencodeSessionId).toBe(`session-${status}`)
      const persistedOutput = (await readNodeRunOutputFixtures(db, { nodeRunId }))[0]
      expect(persistedOutput?.content).toBe('persisted outside the workspace')
      expect(persistedOutput?.archiveJson).toBe(archiveJson)
      expect(existsSync(archivePath)).toBe(true)
      const persistedEvent = (
        await db.select().from(nodeRunEvents).where(eq(nodeRunEvents.nodeRunId, nodeRunId))
      )[0]
      expect(persistedEvent?.payload).toContain('persisted event')
      expect(persistedEvent?.sessionId).toBe(`session-${status}`)
    })
  }

  test('removes every registered worktree and snapshot ref in a multi-repo workspace', async () => {
    const id = ulid()
    const container = join(root, 'multi-workspace')
    mkdirSync(container)
    const repos: Array<{
      source: string
      worktree: string
      branch: string
      snapshotRef: string
    }> = []
    for (const index of [0, 1]) {
      const source = join(root, `multi-source-${index}`)
      mkdirSync(source)
      expect((await runGit(source, ['init', '-q', '-b', 'main'])).exitCode).toBe(0)
      writeFileSync(join(source, 'README.md'), `repo ${index}\n`)
      expect((await runGit(source, ['add', 'README.md'])).exitCode).toBe(0)
      expect(
        (
          await runGit(source, ['commit', '-q', '-m', 'base'], {
            env: {
              GIT_AUTHOR_NAME: 'RFC300',
              GIT_AUTHOR_EMAIL: 'rfc300@example.test',
              GIT_COMMITTER_NAME: 'RFC300',
              GIT_COMMITTER_EMAIL: 'rfc300@example.test',
            },
          })
        ).exitCode,
      ).toBe(0)
      const worktree = join(container, `repo-${index}`)
      const branch = `agent-workflow/${id}-${index}`
      expect(
        (await runGit(source, ['worktree', 'add', '-q', '-b', branch, worktree, 'HEAD'])).exitCode,
      ).toBe(0)
      const snapshotRef = snapshotRefName(id, `node-${index}`)
      expect((await runGit(source, ['update-ref', snapshotRef, 'HEAD'])).exitCode).toBe(0)
      repos.push({ source, worktree, branch, snapshotRef })
    }
    await seedTask({
      id,
      repoPath: repos[0]!.source,
      worktreePath: container,
      branch: repos[0]!.branch,
      spaceKind: 'remote',
    })
    await taskRepoFixture(
      db,
      repos.map((repo, index) => ({
        taskId: id,
        repoIndex: index,
        repoPath: repo.source,
        baseBranch: 'main',
        branch: repo.branch,
        worktreePath: repo.worktree,
        mountPath: `repo-${index}`,
        schemaVersion: 1,
      })),
    )

    expect(await workspaceMaintenanceForTest(db).finalizeClaimedWorkspace(id, 205)).toBeUndefined()
    expect(existsSync(container)).toBe(false)
    for (const repo of repos) {
      const registry = await runGit(repo.source, ['worktree', 'list', '--porcelain'])
      expect(registry.stdout).not.toContain(repo.worktree)
      const refs = await runGit(repo.source, [
        'for-each-ref',
        '--format=%(refname)',
        snapshotRefPrefix(id),
      ])
      expect(refs.stdout).not.toContain(repo.snapshotRef)
    }
    expect((await rowOf(id)).workspacePrunedAt).toBe(205)
  })

  test('two finalizers have one delete owner and converge idempotently', async () => {
    const scratch = join(root, 'scratch-race')
    mkdirSync(scratch)
    const id = await seedTask({ repoPath: scratch, worktreePath: scratch })

    await Promise.all([
      workspaceMaintenanceForTest(db).finalizeClaimedWorkspace(id, 210),
      workspaceMaintenanceForTest(db).finalizeClaimedWorkspace(id, 210),
    ])
    expect(existsSync(scratch)).toBe(false)
    const { taskExecutionMaintenanceClaims } = tablesOf(db)
    expect(await db.select().from(taskExecutionMaintenanceClaims)).toHaveLength(1)
    expect((await rowOf(id)).workspacePrunedAt).toBe(210)
  })

  test('missing workspace finalizes the crash-after-delete window', async () => {
    const id = await seedTask()
    expect(await workspaceMaintenanceForTest(db).finalizeClaimedWorkspace(id, 211)).toBeUndefined()
    expect((await rowOf(id)).workspacePrunedAt).toBe(211)
  })

  test('missing remote worktree still replays snapshot-ref deletion before finalizing', async () => {
    const task = await createLinkedWorktreeTask('done')
    expect(
      (await runGit(task.repo, ['worktree', 'remove', '--force', task.worktree])).exitCode,
    ).toBe(0)
    expect(existsSync(task.worktree)).toBe(false)
    expect(
      (await runGit(task.repo, ['for-each-ref', '--format=%(refname)', snapshotRefPrefix(task.id)]))
        .stdout,
    ).toContain(task.snapshotRef)

    // The generic GC's legacy missing-directory healer must not steal this
    // source-specific claim and stamp it pruned before the dedicated replay
    // has deleted refs from the source repository.
    const generic = await workspaceMaintenanceForTest(db).runGcPhase({
      phase: 'worktree',
      activeTaskIds: [],
      gitCloneTimeoutMs: 30 * 60 * 1000,
      now: 211,
      ...{ worktreeAutoGc: { enabled: true } },
    })
    expect(generic.scanned).toBe(0)
    expect((await rowOf(task.id)).workspacePrunedAt).toBeNull()
    expect(
      (await runGit(task.repo, ['for-each-ref', '--format=%(refname)', snapshotRefPrefix(task.id)]))
        .stdout,
    ).toContain(task.snapshotRef)

    expect(
      await workspaceMaintenanceForTest(db).finalizeClaimedWorkspace(task.id, 212),
    ).toBeUndefined()
    expect(
      (
        await runGit(task.repo, ['for-each-ref', '--format=%(refname)', snapshotRefPrefix(task.id)])
      ).stdout.trim(),
    ).toBe('')
    expect((await rowOf(task.id)).workspacePrunedAt).toBe(212)
  })
})

describe('RFC-300 claimed-workspace recovery selection', () => {
  test('active owner defers; owner release then boot recovery deletes', async () => {
    const scratch = join(root, 'active-scratch')
    mkdirSync(scratch)
    const id = await seedTask({ repoPath: scratch, worktreePath: scratch })

    const deferred = await workspaceMaintenanceForTest(db).recover({
      activeTaskIds: [id],
      now: 300,
      webhookClaims: 'all',
    })
    expect(deferred.completed).toBe(0)
    expect(deferred.skipped).toBe(1)
    expect(existsSync(scratch)).toBe(true)

    const resumed = await workspaceMaintenanceForTest(db).recover({
      activeTaskIds: [],
      now: 301,
      webhookClaims: 'all',
    })
    expect(resumed.completed).toBe(1)
    expect(existsSync(scratch)).toBe(false)
  })

  test('ticker skips a fresh claim and retries it after the lease', async () => {
    const scratch = join(root, 'leased-scratch')
    mkdirSync(scratch)
    await seedTask({
      repoPath: scratch,
      worktreePath: scratch,
      workspacePruningAt: 1_000,
    })

    const fresh = await workspaceMaintenanceForTest(db).recover({
      activeTaskIds: [],
      now: 1_000 + WORKSPACE_PRUNING_LEASE_MS - 1,
      webhookClaims: 'stale',
    })
    expect(fresh.completed).toBe(0)
    expect(existsSync(scratch)).toBe(true)

    const stale = await workspaceMaintenanceForTest(db).recover({
      activeTaskIds: [],
      now: 1_000 + WORKSPACE_PRUNING_LEASE_MS + 1,
      webhookClaims: 'stale',
    })
    expect(stale.completed).toBe(1)
    expect(existsSync(scratch)).toBe(false)
  })

  test('dedicated delete failure keeps its durable claim, recovers after repair and is idempotent', async () => {
    const source = join(root, 'late-source')
    const worktree = join(root, 'failed-then-repaired-worktree')
    mkdirSync(worktree)
    const id = await seedTask({
      repoPath: source,
      worktreePath: worktree,
      spaceKind: 'remote',
      workspacePruningAt: 2_000,
    })

    const failed = await workspaceMaintenanceForTest(db).recover({
      activeTaskIds: [],
      now: 2_001,
      webhookClaims: 'all',
    })
    expect(failed.failed).toBe(1)
    expect(existsSync(worktree)).toBe(true)
    expect(await rowOf(id)).toMatchObject({
      workspacePruningAt: 2_001,
      workspacePruneCause: 'webhook-terminal',
      workspacePrunedAt: null,
    })

    mkdirSync(source)
    expect((await runGit(source, ['init', '-q', '-b', 'main'])).exitCode).toBe(0)
    writeFileSync(join(source, 'README.md'), 'repair\n')
    expect((await runGit(source, ['add', 'README.md'])).exitCode).toBe(0)
    expect(
      (
        await runGit(source, ['commit', '-q', '-m', 'base'], {
          env: {
            GIT_AUTHOR_NAME: 'RFC300',
            GIT_AUTHOR_EMAIL: 'rfc300@example.test',
            GIT_COMMITTER_NAME: 'RFC300',
            GIT_COMMITTER_EMAIL: 'rfc300@example.test',
          },
        })
      ).exitCode,
    ).toBe(0)
    rmSync(worktree, { recursive: true })
    const branch = (await rowOf(id)).branch
    expect(
      (await runGit(source, ['worktree', 'add', '-q', '-b', branch, worktree, 'HEAD'])).exitCode,
    ).toBe(0)

    const fresh = await workspaceMaintenanceForTest(db).recover({
      activeTaskIds: [],
      now: 2_001 + WORKSPACE_PRUNING_LEASE_MS - 1,
      webhookClaims: 'stale',
    })
    // RFC-395 II-pre：生产持久化 claim 可直接恢复；旧库的额外内存租约等待已退役。
    expect(fresh.completed).toBe(1)
    expect(existsSync(worktree)).toBe(false)
    expect((await rowOf(id)).workspacePrunedAt).toBe(2_001 + WORKSPACE_PRUNING_LEASE_MS - 1)

    const retried = await workspaceMaintenanceForTest(db).recover({
      activeTaskIds: [],
      now: 2_001 + WORKSPACE_PRUNING_LEASE_MS + 1,
      webhookClaims: 'stale',
    })
    expect(retried.completed).toBe(0)
    expect(existsSync(worktree)).toBe(false)
    expect((await rowOf(id)).workspacePrunedAt).toBe(2_001 + WORKSPACE_PRUNING_LEASE_MS - 1)
  })

  test('generic age/merge GC cannot steal a dedicated Webhook claim', async () => {
    const scratch = join(root, 'dedicated-claim')
    mkdirSync(scratch)
    const id = await seedTask({
      repoPath: scratch,
      worktreePath: scratch,
      workspacePruningAt: 1_100,
    })

    const generic = await workspaceMaintenanceForTest(db).runGcPhase({
      phase: 'worktree',
      activeTaskIds: [],
      gitCloneTimeoutMs: 30 * 60 * 1000,
      now: 1_200,
      ...{ worktreeAutoGc: { enabled: true } },
    })
    expect(generic.removed).toBe(0)
    expect(existsSync(scratch)).toBe(true)
    expect(await rowOf(id)).toMatchObject({
      workspacePruningAt: 1_100,
      workspacePruneCause: 'webhook-terminal',
      workspacePrunedAt: null,
    })

    const dedicated = await workspaceMaintenanceForTest(db).recover({
      activeTaskIds: [],
      now: 1_201,
      webhookClaims: 'all',
    })
    expect(dedicated.completed).toBe(1)
    expect(existsSync(scratch)).toBe(false)
  })

  test('does not retroactively claim historical terminal rows', async () => {
    const scratch = join(root, 'historical-unclaimed')
    mkdirSync(scratch)
    const id = await seedTask({
      repoPath: scratch,
      worktreePath: scratch,
      workspacePruningAt: null,
      workspacePruneCause: null,
    })

    const result = await workspaceMaintenanceForTest(db).recover({
      activeTaskIds: [],
      now: 400,
      webhookClaims: 'all',
    })
    expect(result.completed).toBe(0)
    expect(existsSync(scratch)).toBe(true)
    expect((await rowOf(id)).workspacePruningAt).toBeNull()
  })

  test('never mistakes a pre-existing or crashed iso-GC claim for Webhook consent', async () => {
    const scratch = join(root, 'foreign-claim')
    mkdirSync(scratch)
    const id = await seedTask({
      repoPath: scratch,
      worktreePath: scratch,
      workspacePruningAt: 450,
      workspacePruneCause: null,
    })

    const result = await workspaceMaintenanceForTest(db).recover({
      activeTaskIds: [],
      now: 500,
      webhookClaims: 'all',
    })
    expect(result).toEqual({ completed: 0, failed: 0, skipped: 0, healed: 0 })
    expect(existsSync(scratch)).toBe(true)
    expect(await rowOf(id)).toMatchObject({
      workspacePruningAt: 450,
      workspacePruneCause: null,
      workspacePrunedAt: null,
    })
  })

  test('excludes failed/interrupted, manual, and inherited rows even if malformed claims exist', async () => {
    const cases: Array<{
      status: TaskStatus
      webhookTriggerId: string | null
      spaceKind: 'scratch' | 'inherited'
    }> = [
      { status: 'failed', webhookTriggerId: 'trigger', spaceKind: 'scratch' },
      { status: 'interrupted', webhookTriggerId: 'trigger', spaceKind: 'scratch' },
      { status: 'done', webhookTriggerId: null, spaceKind: 'scratch' },
      { status: 'done', webhookTriggerId: 'trigger', spaceKind: 'inherited' },
    ]
    const dirs: string[] = []
    const ids: string[] = []
    for (const [index, one] of cases.entries()) {
      const dir = join(root, `excluded-${index}`)
      mkdirSync(dir)
      dirs.push(dir)
      ids.push(
        await seedTask({
          status: one.status,
          webhookTriggerId: one.webhookTriggerId,
          spaceKind: one.spaceKind,
          repoPath: dir,
          worktreePath: dir,
        }),
      )
    }

    const result = await workspaceMaintenanceForTest(db).recover({
      activeTaskIds: [],
      now: 500,
      webhookClaims: 'all',
    })
    expect(result.completed).toBe(0)
    expect(dirs.every(existsSync)).toBe(true)
  })

  test('a durable claim continues after the setting is turned off / trigger row is gone', async () => {
    const scratch = join(root, 'durable-decision')
    mkdirSync(scratch)
    await seedTask({ repoPath: scratch, worktreePath: scratch })

    // Recovery deliberately has no config or webhook-trigger table dependency:
    // the terminal CAS already linearized the decision into this claim.
    const result = await workspaceMaintenanceForTest(db).recover({
      activeTaskIds: [],
      now: 600,
      webhookClaims: 'all',
    })
    expect(result.completed).toBe(1)
    expect(existsSync(scratch)).toBe(false)
  })
})
