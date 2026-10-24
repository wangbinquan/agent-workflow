// RFC-395 II-b package O1: real-engine closure proofs for GC, repository usage, sealing and worktree location.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  composeSourceControlTaskPorts,
  createTaskWorktreeLocator,
  existingTaskIds,
} from '@/modules/task-execution/composition'
import { composeRepositoryWorkspaceStore } from '@/modules/source-control/composition'
import { createTaskRepositoryUsageQueries } from '@/modules/task-execution/infrastructure/taskRepositoryUsage'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { insertOne } from '@/platform/persistence/singleInsert'
import type { WorkspacePruneCause } from '@/modules/task-execution/domain/terminalWorkspacePrune'
import { describeEachProvider } from './helpers/eachProvider'
import { taskFixture, taskRepoFixture, workflowFixture, patchTaskFixture } from './helpers/model'

// The domain vocabulary and the still-active epoch-1 column cannot drift apart.
const pruneCauseParity: [
  WorkspacePruneCause,
  NonNullable<PersistenceTables['tasks']['$inferSelect']['workspacePruneCause']>,
] extends [infer A, infer B]
  ? [A] extends [B]
    ? [B] extends [A]
      ? true
      : false
    : false
  : false = true

async function task(db: PersistenceDb, id: string, cachedRepoId: string | null = null) {
  await taskFixture(db, {
    id,
    name: id,
    workflowId: 'o1-workflow',
    workflowVersion: 1,
    workflowSnapshot: '{}',
    inputs: {},
    repoPath: '/repo',
    repoUrl: 'https://example.test/old.git',
    cachedRepoId,
    worktreePath: '/workspace/' + id,
    baseBranch: 'main',
    branch: 'task/' + id,
    baseCommit: 'base',
    spaceKind: 'remote',
    status: 'done',
    startedAt: 10,
    finishedAt: 20,
    rootTaskId: id,
  })
}

async function mount(
  db: PersistenceDb,
  taskId: string,
  ordinal: number,
  cachedRepoId: string | null,
) {
  await taskRepoFixture(db, {
    taskId,
    repoIndex: ordinal,
    mountPath: 'member' + ordinal,
    repoPath: '/repo/' + ordinal,
    repoUrl: 'https://example.test/mount.git',
    cachedRepoId,
    branch: 'branch/' + ordinal,
    baseBranch: 'main',
    worktreePath: '/workspace/' + taskId + '/member' + ordinal,
    baseCommit: 'base/' + ordinal,
  })
}

async function cache(db: PersistenceDb, id: string, lastFetchedAt: number) {
  await insertOne(db, tablesOf(db).cachedRepos, {
    id,
    urlHash: id,
    urlEnc: null,
    urlRedacted: 'https://example.test/' + id,
    localPath: '/cache/' + id,
    defaultBranch: 'main',
    lastFetchedAt,
    createdAt: 1,
  })
}

describeEachProvider('RFC-395 II-b O1 source-control × task-execution', (harness) => {
  test('mounts deduplicate tasks, any mount suppresses requested-only references, absent IDs stay absent', async () => {
    const { db } = harness
    await workflowFixture(db, { id: 'o1-workflow', name: 'o1-workflow', definition: '{}' })
    await task(db, 'mounted', 'requested-shadowed')
    await mount(db, 'mounted', 2, 'mounted-repo')
    await mount(db, 'mounted', 0, 'mounted-repo')
    await task(db, 'requested', 'mounted-repo')
    await task(db, 'null-mount', 'requested-shadowed')
    await mount(db, 'null-mount', 0, null)
    await task(db, 'no-source')
    const ports = composeSourceControlTaskPorts(db)
    const ids = ['mounted-repo', 'requested-shadowed', 'missing', 'mounted-repo']
    const usage = await ports.taskUsage.referencedAmong(ids)
    expect([...usage.mounted]).toEqual(['mounted-repo'])
    expect([...usage.requestedOnly]).toEqual(['mounted-repo'])
    expect([...(await ports.taskUsage.countTaskReferences(ids))]).toEqual([['mounted-repo', 2]])
    expect([...(await existingTaskIds(db, ['mounted', 'missing', 'mounted']))]).toEqual(['mounted'])
    expect(await ports.workspaceGc.existingTaskIds(['requested', 'missing'])).toEqual(
      new Set(['requested']),
    )
    const located = await createTaskWorktreeLocator(db).find('mounted')
    expect(located).toEqual({
      taskId: 'mounted',
      worktreePath: '/workspace/mounted',
      baseCommit: 'base',
      repos: [0, 2].map((ordinal) => ({
        ordinal,
        mountPath: 'member' + ordinal,
        worktreePath: '/workspace/mounted/member' + ordinal,
        baseCommit: 'base/' + ordinal,
      })),
    })
    expect(await createTaskWorktreeLocator(db).find('missing')).toBeNull()
  })

  test('candidate probes chunk at 500, deduplicate input and issue no statement for an empty input', async () => {
    const { db } = harness
    await workflowFixture(db, { id: 'o1-workflow', name: 'o1-workflow', definition: '{}' })
    const ids = Array.from({ length: 1001 }, (_, index) => 'candidate-' + index)
    for (const index of [0, 500, 1000]) await task(db, 'candidate-task-' + index, ids[index]!)
    const recording = harness.recordStatements()
    const queries = createTaskRepositoryUsageQueries(db)
    try {
      expect(await queries.referencedAmong([])).toEqual({
        mounted: new Set(),
        requestedOnly: new Set(),
      })
      expect(await queries.countTaskReferences([])).toEqual(new Map())
      expect(recording.statements).toHaveLength(0)
      const usage = await queries.referencedAmong([...ids, ids[0]!])
      expect([...usage.requestedOnly].sort()).toEqual([ids[0]!, ids[1000]!, ids[500]!].sort())
      const counts = await queries.countTaskReferences([...ids, ids[0]!])
      expect([...counts]).toEqual([0, 500, 1000].map((index) => [ids[index]!, 1]))
      expect(recording.statements).toHaveLength(6)
      for (const statement of recording.statements) {
        expect(statement.values.length).toBeLessThanOrEqual(500)
        expect(statement.sql).toMatch(/WITH candidates\(id\) AS \(VALUES/i)
        expect(statement.sql).toMatch(/cached_repo_id.*?= candidates.id/is)
        expect(statement.sql).toMatch(/NOT EXISTS/i)
        expect(statement.sql).not.toContain('cached_repos')
      }
    } finally {
      recording.stop()
    }
  })

  test('reference sets filter before keyset LIMIT and retain the five-second facet cache', async () => {
    const { db } = harness
    await workflowFixture(db, { id: 'o1-workflow', name: 'o1-workflow', definition: '{}' })
    for (const [id, time] of [
      ['a', 10],
      ['b', 20],
      ['c', 30],
      ['d', 40],
    ] as const)
      await cache(db, id, time)
    await task(db, 'a-task', 'a')
    await task(db, 'c-task', 'c')
    const store = composeRepositoryWorkspaceStore(db, composeSourceControlTaskPorts(db))
    const first = await store.listCachedRepoPage({ view: 'referenced', limit: 1 })
    expect(first.rows.map((row) => row.id)).toEqual(['c'])
    expect(first.hasMore).toBe(true)
    expect(first.facets).toEqual({ all: 4, referenced: 2, unused: 2, attention: 0 })
    const second = await store.listCachedRepoPage({
      view: 'referenced',
      limit: 1,
      cursor: { id: 'c', lastFetchedAt: 30 },
    })
    expect(second.rows.map((row) => row.id)).toEqual(['a'])
    expect(second.hasMore).toBe(false)
    await task(db, 'b-task', 'b')
    const current = await store.listCachedRepoPage({ view: 'referenced', limit: 10 })
    expect(current.rows.map((row) => row.id)).toEqual(['c', 'b', 'a'])
    expect(current.facets).toEqual(first.facets)
    store.invalidateCachedRepoFacets()
    const unused = await store.listCachedRepoPage({ view: 'unused', limit: 10 })
    expect(unused.rows.map((row) => row.id)).toEqual(['d'])
    expect(unused.facets).toEqual({ all: 4, referenced: 3, unused: 1, attention: 0 })
  })

  test('sealing requested sources and ordinal mounts participates in the caller transaction and rolls back with it', async () => {
    const { db } = harness
    await workflowFixture(db, { id: 'o1-workflow', name: 'o1-workflow', definition: '{}' })
    await task(db, 'seal', 'before')
    await mount(db, 'seal', 2, 'before-mount')
    await cache(db, 'cached', 1)
    const ports = composeSourceControlTaskPorts(db)
    const before = await ports.sourceSealing.listSources()
    await expect(
      databaseSessionFor(db).transaction(async (tx) => {
        await tx
          .update(tablesOf(tx).cachedRepos)
          .set({ urlRedacted: 'updated' })
          .where(eq(tablesOf(tx).cachedRepos.id, 'cached'))
        const participant = ports.sourceSealing.participant(tx)
        await participant.updateRequestedSource('seal', { repoUrl: null, cachedRepoId: 'after' })
        await participant.updateMount('seal', 2, {
          repoUrl: null,
          cachedRepoId: 'after-mount',
          submoduleInitError: 'redacted',
        })
        throw new Error('o1-sealing-rollback')
      }),
    ).rejects.toThrow('o1-sealing-rollback')
    expect(await ports.sourceSealing.listSources()).toEqual(before)
    const store = composeRepositoryWorkspaceStore(db, ports)
    expect((await store.findCachedRepoById('cached'))!.urlRedacted).toBe(
      'https://example.test/cached',
    )
    await store.applyCredentialSealingMutation({
      cachedRepoUpdates: [{ id: 'cached', patch: { urlRedacted: 'updated' } }],
      taskRepoUpdates: [
        {
          taskId: 'seal',
          ordinal: 2,
          patch: { repoUrl: null, cachedRepoId: 'after-mount', submoduleInitError: 'redacted' },
        },
      ],
      taskUpdates: [{ id: 'seal', patch: { repoUrl: null, cachedRepoId: 'after' } }],
      scheduleUpdates: [],
    })
    const snapshot = await store.readCredentialSealingSnapshot()
    expect(snapshot.taskRepos).toEqual([
      {
        taskId: 'seal',
        ordinal: 2,
        repoUrl: null,
        cachedRepoId: 'after-mount',
        submoduleInitError: 'redacted',
      },
    ])
    expect(snapshot.tasks).toEqual([{ id: 'seal', repoUrl: null, cachedRepoId: 'after' }])
    expect(snapshot.cachedRepos[0]!.urlRedacted).toBe('updated')
  })

  test('prune CAS retains lease cutoff, isolation release, tombstone idempotency and missing-workspace revision checks', async () => {
    const { db } = harness
    expect(pruneCauseParity).toBe(true)
    await workflowFixture(db, { id: 'o1-workflow', name: 'o1-workflow', definition: '{}' })
    await task(db, 'prune')
    const { workspaceGc, workspacePrune } = composeSourceControlTaskPorts(db)
    expect(await workspacePrune.claim('prune', 100, 50)).toBe(true)
    expect(await workspacePrune.claim('prune', 200, 100)).toBe(false)
    expect(await workspacePrune.claim('prune', 200, 101)).toBe(true)
    expect(await workspacePrune.releaseIsolation('prune', 100)).toBe(false)
    expect(await workspacePrune.releaseIsolation('prune', 200)).toBe(true)
    expect(await workspacePrune.claimIsolation('prune', 300)).toBe(true)
    expect(await workspacePrune.finalize('prune', 400)).toBe(true)
    expect(await workspacePrune.finalize('prune', 500)).toBe(true)
    expect((await workspaceGc.listTasks(['prune']))[0]!.prune.prunedAt).toBe(400)
    await task(db, 'heal')
    // `tasks.lifecycle_event_revision` defaults to 1, so the fixture's current revision is 1.
    expect(
      await workspacePrune.healMissing('heal', 600, {
        workspaceRootRef: '/other',
        lifecycleRevision: 1,
      }),
    ).toBe(false)
    expect(
      await workspacePrune.healMissing('heal', 600, {
        workspaceRootRef: '/workspace/heal',
        lifecycleRevision: 2,
      }),
    ).toBe(false)
    expect(
      await workspacePrune.healMissing('heal', 600, {
        workspaceRootRef: '/workspace/heal',
        lifecycleRevision: 1,
      }),
    ).toBe(true)
    await task(db, 'webhook')
    await patchTaskFixture(
      db,
      { id: 'webhook' },
      { workspacePruningAt: 10, workspacePruneCause: 'webhook-terminal' },
    )
    expect(await workspacePrune.reclaimWebhook('webhook', 9, 20)).toBe(false)
    expect(await workspacePrune.reclaimWebhook('webhook', 10, 20)).toBe(true)
  })
})
