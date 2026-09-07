// RFC-359 W5-T19b —— 协作组合根的 `reviewTaskAccess` 由「可为空的装配槽」改成**必填字段**之后的行为回归。
//
// # 为什么这条测试存在
//
// 改动前 `CollaborationCommandDependencies.reviewTaskAccess` 是 `?:`，于是同一个缺口要在运行期
// 兜两次、还兜出了两种话术：
//   · `commandContext.ts` 的 `requireReviewTaskAccess` 抛 `collaboration task access is not composed`；
//   · `composition/reviewNodeReviewerDependencies.ts` 私藏了一份逐字同构的 `createReviewTaskAccessPort(context)`，
//     抛 `collaboration review task access is not composed`。
// 而这个槽**从来没有第二个来源**：两个工厂都是 `createReviewTaskAccessPort(input.db)` 现造，全仓
// 没有任何调用方传过它（`createCollaborationCommandContextFromPersistence` 也无外部调用方）。
// 换句话说那两句 throw 描述的是一个装配期就不可能发生的状态，代价却是「缺口在类型层可表达」——
// 正是 RFC-359 W1-T1 修掉的那类形状（PG daemon 上一串 `*-not-bound` 被交给下游，每 tick 抛，
// 同一段业务在 SQLite 上一直正常）。改必填后缺口无处可表达，两句兜底一起删除。
//
// # 这里锁的是什么
//
//   1. 两个引擎上，`createCollaborationCommandContext({ db })` 交出的上下文里那个端口是**活的、
//      绑在本 harness 的 db 上**——不是随便一个满足接口的对象。判据用真实的关系解析：owner 可见、
//      陌生人不可见、协作者可见，都要落到 harness 刚种进去的行上。端口若换成任何桩，这三条一起红。
//   2. `reviewNodeReviewerDependencies(context).taskAccess` 与 `requireReviewTaskAccess(context)`
//      是**同一个实例**。删掉的那份私藏副本一旦复辟（无论它抛什么话术、还是自己再造一个端口），
//      这条恒等断言立刻红。
//   3. `taskExecutionReadModels` 原样透传——证明 (2) 读的是组合根交下来的那份依赖，不是就地重建的。
//
// 类型层的那一半由 `bunx tsc --noEmit` 兜：把工厂里的 `reviewTaskAccess: createReviewTaskAccessPort(input.db)`
// 删掉会直接编译失败（必填字段缺失），这正是「让没装配在类型层不可表达」的落点。
// 计数面的那一半由 `tests/architecture/rfc359-w5-t19b-composition-root-complete.test.ts` 的账本兜。

import { expect, test } from 'bun:test'
import { ulid } from 'ulid'

import type { Actor } from '@/auth/actor'
import { buildActor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { taskCollaborators, tasks, users, workflows } from '@/db/schema'
import {
  createCollaborationCommandContext,
  requireReviewTaskAccess,
  resolveCollaborationCommandContext,
} from '@/modules/collaboration/composition/commandContext'
import { reviewNodeReviewerDependencies } from '@/modules/collaboration/composition/reviewNodeReviewerDependencies'
import type { TaskExecutionReadModels } from '@/modules/task-execution/public/types'
import { describeEachProvider } from './helpers/eachProvider'

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

/** 只用于「原样透传」的身份判据：`reviewNodeReviewerDependencies` 只搬运它、不调用它。 */
const READ_MODELS_MARKER = Object.freeze({}) as unknown as TaskExecutionReadModels

async function seedUser(db: ProviderNeutralDatabase): Promise<string> {
  const id = `u_t19b_${ulid()}`
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role: 'user',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
  return id
}

function actorFor(userId: string): Actor {
  return buildActor({
    user: { id: userId, username: userId, displayName: userId, role: 'user', status: 'active' },
    source: 'session',
  })
}

async function seedTask(db: ProviderNeutralDatabase, owner: string): Promise<string> {
  const id = `t_t19b_${ulid()}`
  const workflowId = `wf_t19b_${ulid()}`
  await db.insert(workflows).values({
    id: workflowId,
    name: workflowId,
    description: '',
    definition: SNAPSHOT,
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id,
    name: id,
    workflowId,
    workflowSnapshot: SNAPSHOT,
    repoPath: '/tmp/repo',
    worktreePath: `/tmp/worktree/${id}`,
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'running',
    inputs: '{}',
    startedAt: 1,
    ownerUserId: owner,
  })
  return id
}

describeEachProvider('RFC-359 W5-T19b —— 协作上下文必带活的评审任务访问端口', (harness) => {
  test('组合根交出的端口绑在本 db 上：owner / 协作者可见，陌生人不可见', async () => {
    const db = harness.db
    const owner = await seedUser(db)
    const collaborator = await seedUser(db)
    const stranger = await seedUser(db)
    const taskId = await seedTask(db, owner)
    await db.insert(taskCollaborators).values({
      taskId,
      userId: collaborator,
      role: 'collaborator',
      addedBy: owner,
      addedAt: 1,
    })

    // 只给 `db`——不传 `reviewTaskAccess`（改必填后它已不是工厂的入参）。
    const access = requireReviewTaskAccess(createCollaborationCommandContext({ db }))

    expect((await access.resolveRelationship(actorFor(owner), taskId, owner)).taskVisible).toBe(
      true,
    )
    expect(
      (await access.resolveRelationship(actorFor(collaborator), taskId, owner)).taskVisible,
    ).toBe(true)
    expect((await access.resolveRelationship(actorFor(stranger), taskId, owner)).taskVisible).toBe(
      false,
    )
    expect(await access.visibleTaskIds(actorFor(owner), [taskId])).toEqual(new Set([taskId]))
    expect(await access.visibleTaskIds(actorFor(stranger), [taskId])).toEqual(new Set())
    expect(access.canManageReviewers(actorFor(owner), owner)).toBe(true)
    expect(access.canManageReviewers(actorFor(stranger), owner)).toBe(false)
  })

  test('评审人依赖读的是组合根那一份端口本身（复辟一份私藏副本即红），read models 原样透传', async () => {
    const db = harness.db
    const context = createCollaborationCommandContext({
      db,
      taskExecutionReadModels: READ_MODELS_MARKER,
    })

    const composed = requireReviewTaskAccess(context)
    const dependencies = reviewNodeReviewerDependencies(context)

    expect(dependencies.taskAccess).toBe(composed)
    expect(dependencies.taskAccess).toBe(
      resolveCollaborationCommandContext(context).reviewTaskAccess,
    )
    expect(dependencies.taskExecutionReadModels).toBe(READ_MODELS_MARKER)
    expect(dependencies.reviewerStore).toBe(
      resolveCollaborationCommandContext(context).persistence.reviewers,
    )
  })
})
