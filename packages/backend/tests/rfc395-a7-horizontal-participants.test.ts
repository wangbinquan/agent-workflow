// RFC-395 II-a A7 part 2：owner participants 使用调用方事务，删除/回填失败必须整体回滚。
import { beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  createTaskDeletionParticipantInTx,
  createTaskPreparationParticipantInTx,
  type TaskPreparationParticipant,
} from '@/modules/task-execution/public/participants'
import { createTaskDeletionCollaborationParticipantInTx } from '@/modules/collaboration/public/participants'
import { createTaskDeletionQueries } from '@/modules/task-execution/public/queries'
import { describeEachProvider } from './helpers/eachProvider'
import {
  taskFixture,
  workflowFixture,
  nodeRunFixture,
  patchNodeRunFixture,
  readTaskFixtures,
  readTaskRepoFixtures,
  readNodeRunFixtures,
  type TaskFixtureSpec,
} from './helpers/model'

describeEachProvider('RFC-395 II-a A7 horizontal participants', (h) => {
  async function task(id: string, extra: Partial<TaskFixtureSpec> = {}) {
    await taskFixture(h.db, {
      id,
      workflowId: 'wf',
      workflowSnapshot: '{}',
      inputs: '{}',
      repoPath: '/repo',
      worktreePath: '/work',
      baseBranch: 'main',
      branch: id,
      status: 'done',
      startedAt: 10,
      ...extra,
    })
  }
  beforeEach(async () => {
    await workflowFixture(h.db, { id: 'wf', name: 'Workflow', definition: '{}' })
    const { users } = tablesOf(h.db)
    await h.db.insert(users).values(
      ['owner', 'member'].map((id) => ({
        id,
        username: id,
        displayName: id,
        createdAt: 1,
        updatedAt: 1,
      })),
    )
  })
  async function deletionTree() {
    await task('parent', { branchStartedAt: 300 })
    await task('child', {
      parentTaskId: 'parent',
      startedAt: 300,
      branchStartedAt: 300,
      ownerUserId: 'owner',
    })
    await task('grandchild', { parentTaskId: 'child', startedAt: 200, branchStartedAt: 200 })
    await task('sibling', { parentTaskId: 'parent', startedAt: 100, branchStartedAt: 100 })
    const { taskCollaborators, taskFeedback } = tablesOf(h.db)
    await h.db.insert(taskCollaborators).values({
      taskId: 'grandchild',
      userId: 'member',
      role: 'collaborator',
      addedBy: 'owner',
      addedAt: 1,
    })
    await h.db.insert(taskFeedback).values([
      {
        id: 'feedback',
        taskId: 'grandchild',
        authorUserId: 'member',
        bodyMd: 'retain until delete',
        createdAt: 1,
      },
      { id: 'other', taskId: 'sibling', authorUserId: 'member', bodyMd: 'retained', createdAt: 1 },
    ])
  }
  test('deletion keeps recursive audience, feedback, cascade and ancestor recomputation in one caller commit', async () => {
    await deletionTree()
    await h.session.transaction(async (tx) => {
      const taskDelete = createTaskDeletionParticipantInTx(tx)
      const collab = createTaskDeletionCollaborationParticipantInTx(tx)
      expect(await taskDelete.status('child')).toEqual({ status: 'done' })
      expect(await taskDelete.status('missing')).toBeUndefined()
      expect(await taskDelete.cascade('missing')).toEqual([])
      expect(await collab.members([])).toEqual([])
      const cascade = await taskDelete.cascade('child')
      expect([...cascade].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: 'child', ownerUserId: 'owner' },
        { id: 'grandchild', ownerUserId: null },
      ])
      const ids = cascade.map((row) => row.id)
      expect(await collab.members(ids)).toEqual([{ taskId: 'grandchild', userId: 'member' }])
      await collab.deleteFeedback(ids)
      await taskDelete.deleteRoot('child')
      await taskDelete.recomputeAncestors('parent')
      expect(await createTaskDeletionQueries(tx).read('grandchild')).toBeUndefined()
    })
    const rows = await readTaskFixtures(h.db)
    expect(rows.map((row) => row.id).sort()).toEqual(['parent', 'sibling'])
    expect(rows.find((row) => row.id === 'parent')?.branchStartedAt).toBe(100)
    const { taskFeedback, taskCollaborators } = tablesOf(h.db)
    expect(
      (await h.db.select({ id: taskFeedback.id }).from(taskFeedback)).map((row) => row.id),
    ).toEqual(['other'])
    expect(await h.db.select().from(taskCollaborators)).toEqual([])
  })

  test('a caller failure restores tasks, memberships, feedback and the original ancestor watermark', async () => {
    await deletionTree()
    await expect(
      h.session.transaction(async (tx) => {
        const taskDelete = createTaskDeletionParticipantInTx(tx)
        const ids = (await taskDelete.cascade('child')).map((row) => row.id)
        await createTaskDeletionCollaborationParticipantInTx(tx).deleteFeedback(ids)
        await taskDelete.deleteRoot('child')
        await taskDelete.recomputeAncestors('parent')
        throw new Error('rollback-delete')
      }),
    ).rejects.toThrow('rollback-delete')
    expect((await readTaskFixtures(h.db)).map((row) => row.id).sort()).toEqual([
      'child',
      'grandchild',
      'parent',
      'sibling',
    ])
    expect((await readTaskFixtures(h.db, { id: 'parent' }))[0]?.branchStartedAt).toBe(300)
    const { taskFeedback, taskCollaborators } = tablesOf(h.db)
    expect(await h.db.select().from(taskFeedback)).toHaveLength(2)
    expect(await h.db.select().from(taskCollaborators)).toHaveLength(1)
  })

  test('empty deletion operations are no-ops and deleting the last child restores parent startedAt', async () => {
    await task('parent', { startedAt: 20, branchStartedAt: 200 })
    await task('child', { parentTaskId: 'parent', startedAt: 200 })
    await h.session.transaction(async (tx) => {
      const participant = createTaskDeletionParticipantInTx(tx)
      await participant.deleteRoot('missing')
      await participant.recomputeAncestors(null)
      await createTaskDeletionCollaborationParticipantInTx(tx).deleteFeedback([])
      await participant.deleteRoot('child')
      await participant.recomputeAncestors('parent')
    })
    expect((await readTaskFixtures(h.db, { id: 'parent' }))[0]?.branchStartedAt).toBe(20)
  })

  function prepared(): Parameters<TaskPreparationParticipant['writeWorkspace']>[0] {
    return {
      taskId: 'prep',
      worktreePath: '/new-root',
      branch: 'working',
      baseCommit: 'root-base',
      spaceKind: 'local',
      nodePaths: ['empty'],
      repositories: [
        {
          ordinal: 0,
          repoPath: '/mirror',
          repoUrl: 'https://host/repo',
          cachedRepoId: 'mirror',
          baseBranch: 'feature',
          branch: 'working',
          workingBranch: null,
          baseCommit: 'member-base',
          worktreePath: '/new-root/nested',
          mountPath: 'nested',
          subdir: 'src',
          readonly: true,
          readonlyDirtyCount: null,
          workspaceProfileVersion: 2,
          workspaceProfileDigest: 'digest',
          hasSubmodules: true,
          submoduleInitOk: false,
          submoduleInitError: 'retained',
        },
      ],
    }
  }
  async function pendingPreparation() {
    await task('prep', { status: 'pending', worktreePath: '', repoPath: '', baseBranch: '' })
    await nodeRunFixture(h.db, {
      id: 'prep-run',
      taskId: 'prep',
      nodeId: '__repo_prep__',
      status: 'running',
    })
  }
  test('workspace backfill, mount facts, explicit directories and caller run settlement commit together', async () => {
    await pendingPreparation()
    await h.session.transaction(async (tx) => {
      await createTaskPreparationParticipantInTx(tx).writeWorkspace(prepared())
      await patchNodeRunFixture(tx, { id: 'prep-run' }, { status: 'done', finishedAt: 30 })
    })
    const [row] = await readTaskFixtures(h.db, { id: 'prep' })
    expect(row).toMatchObject({
      worktreePath: '/new-root',
      repoPath: '/mirror',
      repoUrl: 'https://host/repo',
      branch: 'working',
      baseCommit: 'member-base',
      baseBranch: 'feature',
      cachedRepoId: 'mirror',
    })
    expect(await readTaskRepoFixtures(h.db, { taskId: 'prep' })).toMatchObject([
      {
        mountPath: 'nested',
        baseCommit: 'member-base',
        readonly: true,
        workspaceProfileDigest: 'digest',
        submoduleInitError: 'retained',
      },
    ])
    const { taskSpaceNodes } = tablesOf(h.db)
    expect(
      (
        await h.db
          .select({ path: taskSpaceNodes.nodePath })
          .from(taskSpaceNodes)
          .where(eq(taskSpaceNodes.taskId, 'prep'))
      )
        .map((r) => r.path)
        .sort(),
      // T-F6: roots and mount ancestors are stored together with explicit directories.
    ).toEqual(['', 'empty', 'nested'])
    expect((await readNodeRunFixtures(h.db, { id: 'prep-run' }))[0]?.status).toBe('done')
  })

  test('workspace backfill and run settlement roll back together on caller error', async () => {
    await pendingPreparation()
    await expect(
      h.session.transaction(async (tx) => {
        await createTaskPreparationParticipantInTx(tx).writeWorkspace(prepared())
        await patchNodeRunFixture(tx, { id: 'prep-run' }, { status: 'done' })
        throw new Error('rollback-workspace')
      }),
    ).rejects.toThrow('rollback-workspace')
    expect((await readTaskFixtures(h.db, { id: 'prep' }))[0]?.worktreePath).toBe('')
    expect(await readTaskRepoFixtures(h.db, { taskId: 'prep' })).toEqual([])
    expect((await readNodeRunFixtures(h.db, { id: 'prep-run' }))[0]?.status).toBe('running')
    const { taskSpaceNodes } = tablesOf(h.db)
    expect((await h.db.select().from(taskSpaceNodes)).map((row) => row.nodePath)).toEqual([''])
  })

  test('a newly bound workspace without repositories materializes an ordinal-zero root mount', async () => {
    await pendingPreparation()
    await h.session.transaction(async (tx) => {
      await createTaskPreparationParticipantInTx(tx).writeWorkspace({
        ...prepared(),
        repositories: [],
      })
    })
    expect((await readTaskFixtures(h.db, { id: 'prep' }))[0]).toMatchObject({
      repoPath: '',
      repoUrl: null,
      cachedRepoId: null,
      baseBranch: '',
      repoCount: 1,
    })
    expect(await readTaskRepoFixtures(h.db, { taskId: 'prep' })).toMatchObject([
      { repoIndex: 0, mountPath: '', worktreePath: '/new-root' },
    ])
  })
})
