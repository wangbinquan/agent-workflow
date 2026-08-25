// RFC-324 —— 任务的第三档：观察者。
//
// RFC-099 之后，把人加进任务只有一个含义：他与 owner 同权——能 cancel / resume /
// retry，也是评审与反问的回答权主体（`services/taskCollab.ts` 头注释白纸黑字）。
// 于是「让他看得见任务进展，但别动」在产品上无法表达；用户要么把人加进来连同操作
// 权一起给出去，要么让他什么也看不见。
//
// 本文件锁 proposal.md §7 的 AC-7 / AC-8：
//   - observer 看得见（canViewTask 为真，任务读面不受影响）；
//   - observer 不是行动权主体：requireTaskMember（回答评审 / 反问）与
//     requireTaskOperator（cancel / resume / diagnose / retry）都拒绝他；
//   - collaborator 的语义**一个字节都没变**——这是本 RFC 对存量任务的承诺。
//
// 红→绿对：把 `requireTaskMember` 的 `hasActingMembership` 换回 `hasMembership`，
// 「observer 不能回答评审」那条立刻绿转红。

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { taskCollaborators, tasks, workflows } from '../src/db/schema'
import { createUser } from '../src/services/users'
import {
  canViewTask,
  getTaskMembers,
  hasActingMembership,
  hasMembership,
  requireTaskMember,
  requireTaskOperator,
  updateTaskMembers,
} from '../src/services/taskCollab'
import { ForbiddenError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000

function actorFor(id: string): Actor {
  return buildActor({
    user: { id, username: `u-${id.slice(-4)}`, displayName: 'U', role: 'user', status: 'active' },
    source: 'session',
  })
}

describe('RFC-324 —— 任务观察者档', () => {
  let db: DbClient
  let owner = ''
  let collaborator = ''
  let observer = ''
  let stranger = ''
  const taskId = ulid()

  async function seedTask(ownerUserId: string): Promise<void> {
    const wfId = `wf-${taskId}`
    await db.insert(workflows).values({ id: wfId, name: wfId, description: '', definition: '{}' })
    await db.insert(tasks).values({
      id: taskId,
      name: 'rfc324-observer-fixture',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/repo',
      repoUrl: null,
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      baseCommit: null,
      status: 'running',
      inputs: '{}',
      maxDurationMs: null,
      maxTotalTokens: null,
      startedAt: NOW,
      finishedAt: null,
      errorSummary: null,
      errorMessage: null,
      failedNodeId: null,
      expiresAt: null,
      deletedAt: null,
      schemaVersion: 1,
      ownerUserId,
    })
  }

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    const mk = async (username: string): Promise<string> =>
      (
        await createUser(db, {
          username,
          displayName: username,
          role: 'user',
          password: 'pw12345678',
        })
      ).id
    owner = await mk('owner')
    collaborator = await mk('collab')
    observer = await mk('observer')
    stranger = await mk('stranger')
    await seedTask(owner)
    await db.insert(taskCollaborators).values([
      { taskId, userId: owner, role: 'owner', addedBy: owner, addedAt: NOW },
      { taskId, userId: collaborator, role: 'collaborator', addedBy: owner, addedAt: NOW },
      { taskId, userId: observer, role: 'observer', addedBy: owner, addedAt: NOW },
    ])
  })

  const row = (): { id: string; ownerUserId: string } => ({ id: taskId, ownerUserId: owner })

  test('前提复核：三种成员行都种进去了，否则本文件零预言力', async () => {
    expect(await hasMembership(db, taskId, collaborator)).toBe(true)
    expect(await hasMembership(db, taskId, observer)).toBe(true)
    expect(await hasMembership(db, taskId, stranger)).toBe(false)
  })

  test('observer 看得见任务（这正是这一档存在的理由）', async () => {
    expect(await canViewTask(db, actorFor(observer), row())).toBe(true)
    expect(await canViewTask(db, actorFor(stranger), row())).toBe(false)
  })

  test('observer 不是行动权成员；owner 与 collaborator 是', async () => {
    expect(await hasActingMembership(db, taskId, observer)).toBe(false)
    expect(await hasActingMembership(db, taskId, collaborator)).toBe(true)
    expect(await hasActingMembership(db, taskId, owner)).toBe(true)
  })

  test('回答权（评审 / 反问）：observer 被拒，collaborator 照旧通过', async () => {
    await expect(requireTaskMember(db, actorFor(observer), row())).rejects.toThrow(ForbiddenError)
    expect(await requireTaskMember(db, actorFor(collaborator), row())).toBe('user')
    expect(await requireTaskMember(db, actorFor(owner), row())).toBe('owner')
  })

  test('操作权（cancel / resume / diagnose / retry）：observer 被拒且错误码可辨认', async () => {
    await expect(requireTaskOperator(db, actorFor(observer), row())).rejects.toThrow(ForbiddenError)
    try {
      await requireTaskOperator(db, actorFor(observer), row())
      throw new Error('unreachable')
    } catch (error) {
      expect((error as { code?: string }).code, '前端据这个码禁用按钮并给出说人话的解释').toBe(
        'task-observer-read-only',
      )
    }
    // 对照：同一个门对 collaborator 放行——否则上面的拒绝可能只是门坏了。
    await requireTaskOperator(db, actorFor(collaborator), row())
  })

  test('成员面板：members 带档位，canOperate 对 observer 为假、对 collaborator 为真', async () => {
    const asObserver = await getTaskMembers(db, actorFor(observer), row())
    expect(asObserver.members.map((m) => [m.user.id, m.role]).sort()).toEqual(
      [
        [collaborator, 'collaborator'],
        [observer, 'observer'],
      ].sort(),
    )
    expect(asObserver.canOperate).toBe(false)
    expect(asObserver.canManage).toBe(false)

    const asCollaborator = await getTaskMembers(db, actorFor(collaborator), row())
    expect(asCollaborator.canOperate).toBe(true)
    expect(asCollaborator.canManage).toBe(false)

    const asOwner = await getTaskMembers(db, actorFor(owner), row())
    expect(asOwner.canOperate).toBe(true)
    expect(asOwner.canManage).toBe(true)
  })

  test('PUT members：档位是全量替换的一部分，降档立刻生效', async () => {
    await updateTaskMembers(db, actorFor(owner), row(), {
      members: [
        { userId: collaborator, role: 'observer' },
        { userId: observer, role: 'collaborator' },
      ],
    })
    // 两个人换了位置：原协作者现在只能看，原观察者可以动。
    expect(await hasActingMembership(db, taskId, collaborator)).toBe(false)
    expect(await hasActingMembership(db, taskId, observer)).toBe(true)
    await expect(requireTaskOperator(db, actorFor(collaborator), row())).rejects.toThrow(
      ForbiddenError,
    )
    await requireTaskOperator(db, actorFor(observer), row())
  })

  test('同一用户只留一行：重复条目取最后一条，不产生两档并存', async () => {
    await updateTaskMembers(db, actorFor(owner), row(), {
      members: [
        { userId: observer, role: 'collaborator' },
        { userId: observer, role: 'observer' },
      ],
    })
    const rows = await db.select().from(taskCollaborators)
    const forObserver = rows.filter((r) => r.userId === observer)
    expect(forObserver.length, '(task,user,role) 是主键，两档并存会让判据变成掷骰子').toBe(1)
    expect(forObserver[0]!.role).toBe('observer')
  })

  test('存量语义不变：没有 observer 的任务，collaborator 与 owner 同权', async () => {
    await updateTaskMembers(db, actorFor(owner), row(), {
      members: [{ userId: collaborator, role: 'collaborator' }],
    })
    const members = await getTaskMembers(db, actorFor(owner), row())
    expect(members.members.map((m) => m.role)).toEqual(['collaborator'])
    await requireTaskOperator(db, actorFor(collaborator), row())
    expect(await requireTaskMember(db, actorFor(collaborator), row())).toBe('user')
  })
})
