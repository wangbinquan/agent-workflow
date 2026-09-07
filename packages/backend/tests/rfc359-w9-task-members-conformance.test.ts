// RFC-359 W9 —— 任务成员面（`GET/PUT /api/tasks/:id/members`）的双引擎对拍。
//
// **为什么存在**：`modules/collaboration/infrastructure/legacySqliteTaskCollab.ts` 是本刀 12 个
// 文件里**唯一名副其实**的那个——W9 之前它的类型面是 `DbClient`（bun:sqlite 同步客户端），
// 成员全量替换跑在 `dbTxSync` 上，那是 PostgreSQL 上根本不存在的事务面。PG 部署下这条能力
// 由 `modules/task-execution/infrastructure/` 下 `TaskRouteOperations` 端口 PostgreSQL 那一侧的
// 独立重写承担（模块内私有的 `taskMembers` / `replaceTaskMembers` / `planMembers`，约 130 行），
// 两侧各写各的规则——这是本波反复照出漂移的那种形状。
//（这里刻意不写出那个文件的模块名：`rfc359-w5-t19d-coverage-parity.test.ts` 的 ref 通道
// 按标识符边界数「哪个测试提到了这一侧」，注释里的一次点名会被算成一次覆盖注意力，
// 把那对的倒挂账本虚抬一格。要查那份实现，按端口名在该目录下找 `postgresql` 前缀的那个。）
//
// W9 把 collaboration 这份迁到中立事务原语（`databaseSessionFor` + `lockAggregateRoot(tasks)`），
// 于是它**两个引擎都跑得动**了；本文件把成员面的用户可见契约写成同一段断言，两个引擎各跑一遍，
// 作为「把 PG 路由那份重写并到这一份」之前的对拍基线。
//
// **判据落在用户可见面**：成员面板上谁在列表里、谁是 owner、按钮亮不亮（`canManage` /
// `canOperate`）、以及哪些请求被 422 / 403 挡下来——不是 SQL 形状。
//
// 一条**反向对照**必须有：只断言「都被拒绝」的用例，被一个「永远拒绝」的实现也能满足。
// 所以每条拒绝旁边都配一条同形的放行。

import { expect, test } from 'bun:test'
import { monotonicFactory } from 'ulid'

import type { Actor } from '@/auth/actor'
import { buildActor, SYSTEM_USER_ID } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { taskCollaborators, tasks, users, workflows } from '@/db/schema'
import { encodeLineageSlotPath } from '@/modules/task-execution/domain/executionIntent'
import {
  getTaskMembers,
  updateTaskMembers,
} from '@/modules/collaboration/infrastructure/legacySqliteTaskCollab'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { eq } from 'drizzle-orm'
import { describeEachProvider } from './helpers/eachProvider'

const ulid = monotonicFactory()

const OWNER = 'u-owner'
const COLLAB = 'u-collab'
const OBSERVER = 'u-observer'
const STRANGER = 'u-stranger'
const DISABLED = 'u-disabled'

function actorOf(userId: string, extra: { admin?: boolean } = {}): Actor {
  return buildActor({
    user: {
      id: userId,
      username: userId,
      displayName: userId,
      role: extra.admin === true ? 'admin' : 'user',
      status: 'active',
    },
    source: 'session',
  })
}

async function seedUsers(db: ProviderNeutralDatabase): Promise<void> {
  const now = Date.now()
  await db.insert(users).values(
    [
      { id: OWNER, status: 'active' as const },
      { id: COLLAB, status: 'active' as const },
      { id: OBSERVER, status: 'active' as const },
      { id: STRANGER, status: 'active' as const },
      { id: DISABLED, status: 'disabled' as const },
    ].map((row) => ({
      id: row.id,
      username: row.id,
      displayName: row.id,
      passwordHash: 'x',
      role: 'user' as const,
      status: row.status,
      createdAt: now,
      updatedAt: now,
    })),
  )
}

async function seedTask(
  db: ProviderNeutralDatabase,
  input: {
    ownerUserId: string | null
    members?: ReadonlyArray<{ userId: string; role: 'collaborator' | 'observer' }>
  },
): Promise<{ id: string; ownerUserId: string | null }> {
  const taskId = `t_${ulid()}`
  const snapshot = JSON.stringify({ $schema_version: 6, inputs: [], nodes: [], edges: [] })
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: `rfc359-w9-members-${taskId}`,
    description: '',
    definition: snapshot,
    version: 1,
    schemaVersion: 6,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc359 w9 members',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: snapshot,
    repoPath: '/tmp/aw-rfc359-w9-members',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
    ownerUserId: input.ownerUserId,
    executionLineageId: taskId,
    lineageSlotPathJson: encodeLineageSlotPath([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
  })
  const rows = [
    ...(input.ownerUserId === null
      ? []
      : [{ taskId, userId: input.ownerUserId, role: 'owner' as const }]),
    ...(input.members ?? []).map((member) => ({
      taskId,
      userId: member.userId,
      role: member.role,
    })),
  ].map((row) => ({ ...row, addedBy: input.ownerUserId ?? SYSTEM_USER_ID, addedAt: Date.now() }))
  if (rows.length > 0) await db.insert(taskCollaborators).values(rows)
  return { id: taskId, ownerUserId: input.ownerUserId }
}

/** 成员行的可比较投影：只看 `(userId, role)`，行顺序不进判据。 */
async function memberRows(
  db: ProviderNeutralDatabase,
  taskId: string,
): Promise<{ userId: string; role: string }[]> {
  const rows = await db
    .select({ userId: taskCollaborators.userId, role: taskCollaborators.role })
    .from(taskCollaborators)
    .where(eq(taskCollaborators.taskId, taskId))
  return rows
    .map((row) => ({ userId: row.userId, role: row.role }))
    .sort((left, right) =>
      `${left.role}:${left.userId}`.localeCompare(`${right.role}:${right.userId}`),
    )
}

async function ownerOf(db: ProviderNeutralDatabase, taskId: string): Promise<string | null> {
  return (
    (await db.select({ ownerUserId: tasks.ownerUserId }).from(tasks).where(eq(tasks.id, taskId)))[0]
      ?.ownerUserId ?? null
  )
}

describeEachProvider('RFC-359 W9 —— 任务成员面（成员制的用户可见契约）', (harness) => {
  // ---------------------------------------------------------------------------
  // 读面 —— 面板看到什么
  // ---------------------------------------------------------------------------

  test('成员面板：owner 不进 members 列表，两档成员各自带出；owner 看到 canManage / canOperate', async () => {
    const db = harness.db
    await seedUsers(db)
    const task = await seedTask(db, {
      ownerUserId: OWNER,
      members: [
        { userId: COLLAB, role: 'collaborator' },
        { userId: OBSERVER, role: 'observer' },
      ],
    })
    const view = await getTaskMembers(db, actorOf(OWNER), task)
    expect(view.taskId).toBe(task.id)
    expect(view.ownerUserId).toBe(OWNER)
    expect(view.owner?.id).toBe(OWNER)
    expect(view.members.map((m) => `${m.role}:${m.user.id}`).sort()).toEqual([
      `collaborator:${COLLAB}`,
      `observer:${OBSERVER}`,
    ])
    expect(view.canManage).toBe(true)
    expect(view.canOperate).toBe(true)
  })

  test('成员面板：collaborator 能操作但不能管理；observer 两个都不能（反向对照配在同一条里）', async () => {
    const db = harness.db
    await seedUsers(db)
    const task = await seedTask(db, {
      ownerUserId: OWNER,
      members: [
        { userId: COLLAB, role: 'collaborator' },
        { userId: OBSERVER, role: 'observer' },
      ],
    })
    const asCollaborator = await getTaskMembers(db, actorOf(COLLAB), task)
    expect([asCollaborator.canManage, asCollaborator.canOperate]).toEqual([false, true])
    const asObserver = await getTaskMembers(db, actorOf(OBSERVER), task)
    expect([asObserver.canManage, asObserver.canOperate]).toEqual([false, false])
  })

  test('成员面板：系统所有的任务不把 __system__ 渲染成 owner 用户（ownerUserId 仍如实带出）', async () => {
    const db = harness.db
    await seedUsers(db)
    const task = await seedTask(db, { ownerUserId: SYSTEM_USER_ID })
    const view = await getTaskMembers(db, actorOf(OWNER, { admin: true }), task)
    expect(view.ownerUserId).toBe(SYSTEM_USER_ID)
    expect(view.owner).toBeNull()
    expect(view.members).toEqual([])
  })

  // ---------------------------------------------------------------------------
  // 写面 —— 全量替换
  // ---------------------------------------------------------------------------

  test('PUT members 是全量替换：没列进来的成员被移除，owner 行照旧只有一行', async () => {
    const db = harness.db
    await seedUsers(db)
    const task = await seedTask(db, {
      ownerUserId: OWNER,
      members: [
        { userId: COLLAB, role: 'collaborator' },
        { userId: OBSERVER, role: 'observer' },
      ],
    })
    const view = await updateTaskMembers(db, actorOf(OWNER), task, {
      members: [{ userId: STRANGER, role: 'collaborator' }],
    })
    expect(view.members.map((m) => `${m.role}:${m.user.id}`)).toEqual([`collaborator:${STRANGER}`])
    expect(await memberRows(db, task.id)).toEqual([
      { userId: STRANGER, role: 'collaborator' },
      { userId: OWNER, role: 'owner' },
    ])
  })

  test('PUT 省略 members：沿用现状，只改 owner', async () => {
    const db = harness.db
    await seedUsers(db)
    const task = await seedTask(db, {
      ownerUserId: OWNER,
      members: [{ userId: OBSERVER, role: 'observer' }],
    })
    await updateTaskMembers(db, actorOf(OWNER), task, { ownerUserId: COLLAB })
    expect(await ownerOf(db, task.id)).toBe(COLLAB)
    expect(await memberRows(db, task.id)).toEqual([
      // 前任 owner 自动降为 collaborator（镜像资源 ACL 保留前任 grant 的规则）
      { userId: OWNER, role: 'collaborator' },
      { userId: OBSERVER, role: 'observer' },
      { userId: COLLAB, role: 'owner' },
    ])
  })

  test('owner 转移：前任被显式列成 observer 时，按列的档次走，不被强行提成 collaborator', async () => {
    const db = harness.db
    await seedUsers(db)
    const task = await seedTask(db, { ownerUserId: OWNER })
    await updateTaskMembers(db, actorOf(OWNER), task, {
      ownerUserId: COLLAB,
      members: [{ userId: OWNER, role: 'observer' }],
    })
    expect(await memberRows(db, task.id)).toEqual([
      { userId: OWNER, role: 'observer' },
      { userId: COLLAB, role: 'owner' },
    ])
  })

  test('owner 转移：新 owner 若同时被列进 members，成员行让位给 owner 行（不出现两行）', async () => {
    const db = harness.db
    await seedUsers(db)
    const task = await seedTask(db, { ownerUserId: OWNER })
    await updateTaskMembers(db, actorOf(OWNER), task, {
      ownerUserId: COLLAB,
      members: [{ userId: COLLAB, role: 'collaborator' }],
    })
    expect(await memberRows(db, task.id)).toEqual([
      { userId: OWNER, role: 'collaborator' },
      { userId: COLLAB, role: 'owner' },
    ])
  })

  test('owner 转移：系统前任（__system__）不被降级成成员', async () => {
    const db = harness.db
    await seedUsers(db)
    const task = await seedTask(db, { ownerUserId: SYSTEM_USER_ID })
    await updateTaskMembers(db, actorOf(OWNER, { admin: true }), task, { ownerUserId: OWNER })
    expect(await memberRows(db, task.id)).toEqual([{ userId: OWNER, role: 'owner' }])
  })

  test('同一用户在 members 里出现两次：取最后一条（PK 含 role，否则会落成两行）', async () => {
    const db = harness.db
    await seedUsers(db)
    const task = await seedTask(db, { ownerUserId: OWNER })
    await updateTaskMembers(db, actorOf(OWNER), task, {
      members: [
        { userId: COLLAB, role: 'collaborator' },
        { userId: COLLAB, role: 'observer' },
      ],
    })
    expect(await memberRows(db, task.id)).toEqual([
      { userId: COLLAB, role: 'observer' },
      { userId: OWNER, role: 'owner' },
    ])
  })

  // ---------------------------------------------------------------------------
  // 写面 —— 被挡下来的请求（每条都配同形的放行做反向对照）
  // ---------------------------------------------------------------------------

  test('引用已停用用户 → 422 members-user-invalid；同形的 active 用户放行', async () => {
    const db = harness.db
    await seedUsers(db)
    const task = await seedTask(db, { ownerUserId: OWNER })
    await expect(
      updateTaskMembers(db, actorOf(OWNER), task, {
        members: [{ userId: DISABLED, role: 'collaborator' }],
      }),
    ).rejects.toMatchObject({ code: 'members-user-invalid' })
    // 反向对照：同一条请求换成 active 用户就通过——证明拒绝不是「永远拒绝」。
    await updateTaskMembers(db, actorOf(OWNER), task, {
      members: [{ userId: COLLAB, role: 'collaborator' }],
    })
    expect(await memberRows(db, task.id)).toEqual([
      { userId: COLLAB, role: 'collaborator' },
      { userId: OWNER, role: 'owner' },
    ])
  })

  // RFC-326 P13 —— 授权行是在**事务外**读的，所以「路由那份快照」与「真正生效的行」必须
  // 分得开。这不是 provider 差异（两个引擎的读—写窗口同样真实存在，单写者租约串的是事务、
  // 不是「事务外读 + 事务内写」这条链），所以判据两个引擎逐字相同、且完全不靠时序：
  // 直接把一份**过期快照**递进去，看授权与 prevOwner 认哪一份。
  test('授权认锁内重读的新鲜行，不认调用方递进来的过期快照（越权方向）', async () => {
    const db = harness.db
    await seedUsers(db)
    const task = await seedTask(db, { ownerUserId: OWNER })
    // 快照说 STRANGER 是 owner（比如路由读到行之后 owner 刚被转走），库里其实是 OWNER。
    await expect(
      updateTaskMembers(
        db,
        actorOf(STRANGER),
        { id: task.id, ownerUserId: STRANGER },
        {
          members: [],
        },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(await memberRows(db, task.id)).toEqual([{ userId: OWNER, role: 'owner' }])
  })

  test('授权认锁内重读的新鲜行，不认调用方递进来的过期快照（放行方向 + prevOwner 也取新鲜行）', async () => {
    const db = harness.db
    await seedUsers(db)
    const task = await seedTask(db, { ownerUserId: OWNER })
    // 反向对照：快照说 owner 是别人，库里其实就是调用者——必须放行，否则上一条的 403
    // 会被一个「永远 403」的实现满足。同时 owner 转移的 prevOwner 也必须来自新鲜行：
    // 用过期的 STRANGER 当 prevOwner 会把 STRANGER 降级成 collaborator 塞进成员表。
    await updateTaskMembers(
      db,
      actorOf(OWNER),
      { id: task.id, ownerUserId: STRANGER },
      {
        ownerUserId: COLLAB,
      },
    )
    expect(await ownerOf(db, task.id)).toBe(COLLAB)
    expect(await memberRows(db, task.id)).toEqual([
      { userId: OWNER, role: 'collaborator' },
      { userId: COLLAB, role: 'owner' },
    ])
  })

  test('把 __system__ 列成成员 → 422；成员行不受影响', async () => {
    const db = harness.db
    await seedUsers(db)
    const task = await seedTask(db, {
      ownerUserId: OWNER,
      members: [{ userId: COLLAB, role: 'collaborator' }],
    })
    await expect(
      updateTaskMembers(db, actorOf(OWNER), task, {
        members: [{ userId: SYSTEM_USER_ID, role: 'collaborator' }],
      }),
    ).rejects.toMatchObject({ code: 'members-user-invalid' })
    expect(await memberRows(db, task.id)).toEqual([
      { userId: COLLAB, role: 'collaborator' },
      { userId: OWNER, role: 'owner' },
    ])
  })

  test('非 owner 改成员 → 403 forbidden；带 resource-acl:bypass 的管理员放行', async () => {
    const db = harness.db
    await seedUsers(db)
    const task = await seedTask(db, {
      ownerUserId: OWNER,
      members: [{ userId: COLLAB, role: 'collaborator' }],
    })
    await expect(
      updateTaskMembers(db, actorOf(COLLAB), task, { members: [] }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(await memberRows(db, task.id)).toEqual([
      { userId: COLLAB, role: 'collaborator' },
      { userId: OWNER, role: 'owner' },
    ])
    // 反向对照：admin 自带 resource-acl:bypass，同一条请求通过。
    await updateTaskMembers(db, actorOf(STRANGER, { admin: true }), task, { members: [] })
    expect(await memberRows(db, task.id)).toEqual([{ userId: OWNER, role: 'owner' }])
  })

  test('任务在锁内消失 → 404 task-not-found（队列前排读的是新鲜行，不是路由那份快照）', async () => {
    const db = harness.db
    await seedUsers(db)
    const task = await seedTask(db, { ownerUserId: OWNER })
    await db.delete(taskCollaborators).where(eq(taskCollaborators.taskId, task.id))
    await db.delete(tasks).where(eq(tasks.id, task.id))
    await expect(
      updateTaskMembers(db, actorOf(OWNER), task, { members: [] }),
    ).rejects.toMatchObject({ code: 'task-not-found' })
  })

  // ---------------------------------------------------------------------------
  // 事务面 —— W9 从 `dbTxSync` 迁到中立原语之后才可能在两个引擎上同时成立
  // ---------------------------------------------------------------------------

  test('替换跑在调用方的显式事务里：外层回滚把 owner 转移与成员替换一起带走', async () => {
    const db = harness.db
    await seedUsers(db)
    const task = await seedTask(db, {
      ownerUserId: OWNER,
      members: [{ userId: COLLAB, role: 'collaborator' }],
    })
    const boom = new Error('rfc359-w9-rollback')
    await expect(
      databaseSessionFor(db).transaction(async () => {
        await updateTaskMembers(db, actorOf(OWNER), task, {
          ownerUserId: COLLAB,
          members: [{ userId: OBSERVER, role: 'observer' }],
        })
        throw boom
      }),
    ).rejects.toBe(boom)
    // 不可重入的实现会另开一条连接、独立提交，外层回滚带不走它的写。
    expect(await ownerOf(db, task.id)).toBe(OWNER)
    expect(await memberRows(db, task.id)).toEqual([
      { userId: COLLAB, role: 'collaborator' },
      { userId: OWNER, role: 'owner' },
    ])
  })
})
