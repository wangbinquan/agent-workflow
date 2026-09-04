// RFC-357 T3 —— 列表页授权谓词的三态语义。
//
// 为什么这条测试存在：把 `services/taskOperations.ts` 平移进
// `modules/task-execution/infrastructure/taskListPage/` 时，可见性与 scope 谓词从
// `legacySqliteTaskAuthorization.ts` 一并搬走并放宽了参数类型（provider 中立）。搬之前
// 这两条判据**没有任何直接断言**——它们只被列表页的端到端用例间接覆盖，而那些用例的
// 种子里没有「无主任务」这一态。
//
// 需要钉死的是 SQL 三值逻辑的那个坑：`scope='shared'` 的判据是「我是协作者，且我不是
// 属主」，而 `ne(owner_user_id, me)` 在 `owner_user_id IS NULL` 时是 **NULL 而不是真**，
// 于是无主但共享给我的任务会静默消失。原实现靠 `or(isNull(...), ne(...))` 补上这一支；
// PostgreSQL 侧 `/api/tasks` 用的是等价的 `IS DISTINCT FROM`。三态各来一行，
// 任何一侧改写成裸 `ne(...)` 都会在这里红。

import { describe, expect, test } from 'bun:test'
import { and, type SQL } from 'drizzle-orm'
import { resolve } from 'node:path'

import { buildActor, type Actor } from '@/auth/actor'
import { createInMemoryDb } from '@/db/client'
import { taskCollaborators, tasks, users, workflows } from '@/db/schema'
import {
  defaultTaskListRowRef,
  taskListOwnershipScopeCondition,
  taskListViewerOf,
  taskListVisibilityCondition,
} from '@/modules/task-execution/infrastructure/taskListPage/authorization'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

type Db = ReturnType<typeof createInMemoryDb>

function actor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

/**
 * 三行任务，恰好覆盖 `owner_user_id` 的三态；三行都把 alice 记为协作者，
 * 于是「共享给我」这一档的差别只可能来自属主一栏。
 */
async function seed(db: Db): Promise<void> {
  await db.insert(users).values(
    ['alice', 'bob'].map((id) => ({
      id,
      username: id,
      displayName: id,
      role: 'user' as const,
      status: 'active' as const,
      createdAt: 1,
      updatedAt: 1,
    })),
  )
  await db.insert(workflows).values({
    id: 'wf1',
    name: 'wf',
    definition: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
  })
  const rows = [
    { id: 'owned-by-alice', owner: 'alice' },
    { id: 'owned-by-bob', owner: 'bob' },
    { id: 'ownerless', owner: null },
  ] as const
  let startedAt = 1_788_278_400_000
  for (const row of rows) {
    startedAt += 1
    await db.insert(tasks).values({
      id: row.id,
      name: row.id,
      workflowId: 'wf1',
      workflowSnapshot: '{}',
      repoPath: `/tmp/${row.id}`,
      worktreePath: `/tmp/wt-${row.id}`,
      baseBranch: 'main',
      branch: `agent-workflow/${row.id}`,
      status: 'done',
      inputs: '{}',
      startedAt,
      finishedAt: startedAt + 1,
      runningMs: 0,
      ownerUserId: row.owner,
      launchOrigin: 'manual',
      branchStartedAt: startedAt,
      rootTaskId: row.id,
    })
    await db.insert(taskCollaborators).values({
      taskId: row.id,
      userId: 'alice',
      role: 'collaborator',
      addedBy: 'bob',
      addedAt: startedAt,
    })
  }
}

async function idsWhere(db: Db, condition: SQL<unknown> | undefined): Promise<string[]> {
  const rows = await db.select({ id: tasks.id }).from(tasks).where(condition)
  return rows.map((row) => row.id).sort()
}

describe('RFC-357 task list authorization covers all three owner states', () => {
  test('visibility: an admin sees everything, a regular user sees owned plus collaborating', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db)

    const admin = await idsWhere(
      db,
      taskListVisibilityCondition(
        db,
        defaultTaskListRowRef(),
        taskListViewerOf(actor('root', 'admin')),
      ),
    )
    expect(admin).toEqual(['owned-by-alice', 'owned-by-bob', 'ownerless'])

    // alice 是三行的协作者，所以可见性这一档把三行都收进来——包括无主那行。
    const alice = await idsWhere(
      db,
      taskListVisibilityCondition(db, defaultTaskListRowRef(), taskListViewerOf(actor('alice'))),
    )
    expect(alice).toEqual(['owned-by-alice', 'owned-by-bob', 'ownerless'])

    // 与任何一行都无关的第三人什么都看不到。
    const carol = await idsWhere(
      db,
      taskListVisibilityCondition(db, defaultTaskListRowRef(), taskListViewerOf(actor('carol'))),
    )
    expect(carol).toEqual([])
  })

  test('scope=shared keeps the ownerless row — the three-valued-logic trap', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db)

    const shared = await idsWhere(
      db,
      taskListOwnershipScopeCondition(db, defaultTaskListRowRef(), 'alice', 'shared'),
    )
    // 「共享给我」= 我是协作者且我不是属主。bob 的那行显然算；**无主那行也算**——
    // 少了 `isNull(...)` 这一支它会因为 `NULL <> 'alice'` 求值成 NULL 而消失。
    expect(shared).toEqual(['owned-by-bob', 'ownerless'])
    expect(shared).not.toContain('owned-by-alice')
  })

  test('scope=mine is owned-or-collaborating, scope=all is unconditional', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db)

    const mine = await idsWhere(
      db,
      taskListOwnershipScopeCondition(db, defaultTaskListRowRef(), 'alice', 'mine'),
    )
    expect(mine).toEqual(['owned-by-alice', 'owned-by-bob', 'ownerless'])

    const all = await idsWhere(
      db,
      taskListOwnershipScopeCondition(db, defaultTaskListRowRef(), 'alice', 'all'),
    )
    expect(all).toEqual(['owned-by-alice', 'owned-by-bob', 'ownerless'])

    // scope 与可见性正交：bob 只是属主之一、不是任何一行的协作者，
    // 他的 mine 只有自己那行。
    const bobMine = await idsWhere(
      db,
      taskListOwnershipScopeCondition(db, defaultTaskListRowRef(), 'bob', 'mine'),
    )
    expect(bobMine).toEqual(['owned-by-bob'])
  })

  test('the two predicates compose the way the page uses them', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db)
    const alice = actor('alice')
    const composed = await idsWhere(
      db,
      and(
        taskListVisibilityCondition(db, defaultTaskListRowRef(), taskListViewerOf(alice)),
        taskListOwnershipScopeCondition(db, defaultTaskListRowRef(), alice.user.id, 'shared'),
      ),
    )
    expect(composed).toEqual(['owned-by-bob', 'ownerless'])
  })
})
