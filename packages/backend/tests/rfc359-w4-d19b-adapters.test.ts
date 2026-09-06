// RFC-359 W4-D19b —— 工作组任务房本体合一：SQLite 不再走 legacy engine 上的薄驱动，两个 provider 用同一份
// 任务房实现（`workgroupTaskRoom.ts` / `-Commands.ts` / `-Queries.ts` + 一份装配）。
//
// 这一刀之前 PostgreSQL 跑的是一条几乎没有行为覆盖的路径（SQLite / legacy 侧有 13 个行为套件，PG 侧只有 3 个
// 源码形状锁）。这里给房间补上两引擎同跑的行为断言：房间聚合读、可见性 404、发言写入与终态拒绝；附源码锁。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { buildActor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { taskCollaborators, tasks, users, workflows, workgroupMessages } from '@/db/schema'
import { composeWorkgroupTaskRoomClarifyParticipantFactory } from '@/modules/collaboration/composition/workgroupTaskRoomClarify'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import { composeWorkgroupTaskRoom } from '@/modules/resource-catalog/composition/workgroupTaskRoom'
import { composeWorkgroupTaskRoomTaskParticipantFactory } from '@/modules/task-execution/composition/workgroupTaskRoomTask'
import { describeEachProvider } from './helpers/eachProvider'

const T0 = 1_700_000_000_000

const WORKGROUP_ID = 'wg-rfc359-d19b'

/** 运行期配置（任务快照里的那份）：一个 agent 成员即可满足 members.min(1)。 */
function workgroupConfig(ownerUserId: string): Record<string, unknown> {
  return {
    workgroupId: WORKGROUP_ID,
    workgroupName: 'rfc359 d19b squad',
    mode: 'free_collab',
    leaderMemberId: null,
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 5,
    completionGate: false,
    goal: 'ship the unification',
    instructions: '',
    members: [
      {
        id: 'm-owner',
        memberType: 'human',
        agentName: null,
        agentId: null,
        userId: ownerUserId,
        displayName: 'owner',
        roleDesc: 'lead',
      },
    ],
  }
}

async function seedUser(
  db: ProviderNeutralDatabase,
): Promise<{ id: string; authority: DirectAuthenticatedAuthority }> {
  const id = ulid()
  const username = `u-${id.slice(-8).toLowerCase()}`
  await db.insert(users).values({
    id,
    username,
    displayName: username,
    role: 'user',
    createdAt: T0,
    updatedAt: T0,
  })
  // 任务可见性判定读的是扁平的 `authority.userId`（不是 `user.id`），投影里两者都在。
  const actor = buildActor({
    source: 'session',
    user: { id, username, displayName: username, role: 'user', status: 'active' },
  })
  const authority = Object.freeze({
    ...actor,
    userId: id,
  }) as unknown as DirectAuthenticatedAuthority
  return { id, authority }
}

async function seedWorkgroupTask(
  db: ProviderNeutralDatabase,
  input: { readonly ownerUserId: string; readonly status?: 'running' | 'done' },
): Promise<string> {
  const taskId = ulid()
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: `rfc359-d19b-${workflowId.slice(-8).toLowerCase()}`,
    definition: '{}',
    builtin: true,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc359 d19b room',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read-wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: input.status ?? 'running',
    inputs: '{}',
    startedAt: T0,
    ownerUserId: input.ownerUserId,
    workgroupId: WORKGROUP_ID,
    workgroupConfigJson: JSON.stringify(workgroupConfig(input.ownerUserId)),
  })
  await db.insert(taskCollaborators).values({
    taskId,
    userId: input.ownerUserId,
    role: 'owner',
    addedBy: input.ownerUserId,
    addedAt: T0,
  })
  return taskId
}

function roomFor(db: ProviderNeutralDatabase, broadcasts: string[]) {
  return composeWorkgroupTaskRoom({
    db,
    taskParticipantFactory: composeWorkgroupTaskRoomTaskParticipantFactory({
      collaboration: composeWorkgroupTaskRoomClarifyParticipantFactory(),
    }),
    activeUsers: {
      async findActiveUserIds(userIds) {
        return new Set(userIds)
      },
    },
    dynamicWorkflow: {
      async validateGenerated(_authority, request) {
        return request.definition
      },
      async create() {
        return { id: 'workflow-never-created', name: 'never' }
      },
    },
    systemUserId: 'system',
    // 恢复可行性预检按部署形态注入：单进程查工作树、多进程空操作。本套只断言房间行为，用空操作。
    continuation: { assertResumable: async () => {}, driveAfterCommit: async () => {} },
    broadcast(taskId, event) {
      broadcasts.push(`${taskId}:${event.type}`)
    },
    now: () => T0 + 1,
  })
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    return '<no-throw>'
  } catch (error) {
    return (error as { code?: string }).code ?? '<no-code>'
  }
}

describeEachProvider('RFC-359 W4-D19b —— 工作组任务房', (harness) => {
  test('房间聚合读：成员看得到自己的任务；旁人拿到的是 workgroup-task-not-found（看不见即不存在）', async () => {
    const owner = await seedUser(harness.db)
    const stranger = await seedUser(harness.db)
    const taskId = await seedWorkgroupTask(harness.db, { ownerUserId: owner.id })
    const room = roomFor(harness.db, [])

    const aggregate = await room.queries.room(owner.authority, { taskId })
    const decoded = JSON.parse(aggregate.body) as Record<string, unknown>
    expect(decoded).toHaveProperty('messages')
    expect(decoded).toHaveProperty('assignments')

    expect(await codeOf(() => room.queries.room(stranger.authority, { taskId }))).toBe(
      'workgroup-task-not-found',
    )
  })

  test('发言：写进房间消息流并广播；已完结的任务拒绝发言', async () => {
    const owner = await seedUser(harness.db)
    const taskId = await seedWorkgroupTask(harness.db, { ownerUserId: owner.id })
    const broadcasts: string[] = []
    const room = roomFor(harness.db, broadcasts)

    await room.commands.postMessage(owner.authority, {
      taskId,
      submission: { kind: 'json-body', body: JSON.stringify({ body: 'hello squad' }) },
    })
    const rows = await harness.db
      .select({
        body: workgroupMessages.bodyMd,
        kind: workgroupMessages.kind,
        authorKind: workgroupMessages.authorKind,
        authorUserId: workgroupMessages.authorUserId,
      })
      .from(workgroupMessages)
      .where(eq(workgroupMessages.taskId, taskId))
    expect(rows).toEqual([
      { body: 'hello squad', kind: 'chat', authorKind: 'human', authorUserId: owner.id },
    ])
    expect(broadcasts).toEqual([`${taskId}:wg.message.created`])

    // 空正文被 schema 拒绝，终态任务被生命周期判据拒绝——两条都在两个引擎上同样成立。
    expect(
      await codeOf(() =>
        room.commands.postMessage(owner.authority, {
          taskId,
          submission: { kind: 'json-body', body: JSON.stringify({ body: '   ' }) },
        }),
      ),
    ).toBe('workgroup-message-invalid')

    const finished = await seedWorkgroupTask(harness.db, {
      ownerUserId: owner.id,
      status: 'done',
    })
    expect(
      await codeOf(() =>
        room.commands.postMessage(owner.authority, {
          taskId: finished,
          submission: { kind: 'json-body', body: JSON.stringify({ body: 'too late' }) },
        }),
      ),
    ).toBe('workgroup-task-terminal')
  })
})
