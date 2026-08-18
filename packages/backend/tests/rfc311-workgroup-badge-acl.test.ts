// RFC-311 实现门(测试有效性第 3 路,变异 #18)——workgroup 徽章的 ACL 过滤零防护。
//
// 变异实验把 `pendingCount` 里的 `visibleTaskIdsOf(...)` 换成「全部可见」(即彻底
// 去掉徽章的可见性过滤)后,`--test-name-pattern workgroup` 仍 234 pass / 0 fail:
// 一个**可越权的计数泄漏**没有任何测试接住。design.md §11.1 明写三个徽章都要
// oracle,reviews / clarify 有,workgroup 一直缺。
//
// 这条锁的是最直接的用户后果:非成员的收件箱徽章不得因为别人的工作组任务而 +1。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb } from '../src/db/client'
import { tasks, users, workflows, workgroupTaskState } from '../src/db/schema'
import { buildRoomReads } from '../src/services/workgroup/room'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_788_278_400_000

type Db = ReturnType<typeof createInMemoryDb>

function actor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

const CONFIG = {
  workgroupId: 'wg1',
  workgroupName: 'wg',
  mode: 'free_collab' as const,
  leaderMemberId: null,
  switches: { shareOutputs: true, directMessages: true, blackboard: true },
  maxRounds: 3,
  completionGate: true,
  goal: 'ship it',
  instructions: '',
  members: [
    {
      id: 'm1',
      memberType: 'agent' as const,
      agentName: 'a1',
      agentId: 'agent-1',
      userId: null,
      displayName: 'A1',
      roleDesc: 'worker',
    },
  ],
}

async function seed(db: Db): Promise<void> {
  await db.insert(users).values(
    ['alice', 'bob', 'admin'].map((id) => ({
      id,
      username: id,
      displayName: id,
      role: id === 'admin' ? ('admin' as const) : ('user' as const),
      createdAt: NOW,
      updatedAt: NOW,
    })),
  )
  await db.insert(workflows).values({ id: 'wf1', name: 'wf', definition: '{}' })
  await db.insert(tasks).values({
    id: 'wgtask',
    name: 'wg task',
    workflowId: 'wf1',
    workflowSnapshot: '{}',
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read',
    baseBranch: 'main',
    branch: 'agent-workflow/wgtask',
    status: 'awaiting_review',
    inputs: '{}',
    startedAt: NOW,
    runningMs: 0,
    ownerUserId: 'alice',
    launchOrigin: 'manual',
    workgroupId: 'wg1',
    workgroupConfigJson: JSON.stringify(CONFIG),
  })
  await db.insert(workgroupTaskState).values({
    taskId: 'wgtask',
    gateStatus: 'awaiting_confirmation',
    updatedAt: NOW,
  })
}

function reads(db: Db) {
  return buildRoomReads(
    { db } as never,
    { loadVisibleWorkgroupTask: async () => ({}) as never } as never,
  )
}

describe('RFC-311 — workgroup pending-count honours task visibility', () => {
  test('the owner and an admin see the gate; an unrelated user counts zero', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db)
    const { pendingCount } = reads(db)

    const owner = await pendingCount(actor('alice'))
    const stranger = await pendingCount(actor('bob'))
    const admin = await pendingCount(actor('admin', 'admin'))

    const total = (r: Awaited<ReturnType<typeof pendingCount>>): number =>
      Object.values(r as Record<string, number>).reduce((a, b) => a + (b ?? 0), 0)

    expect(total(owner)).toBeGreaterThan(0)
    expect(total(admin)).toBeGreaterThan(0)
    // 关键断言:非成员的徽章不得因为别人的工作组任务而 +1(变异去掉可见性过滤
    // 后,这里会变成和 owner 一样的数)。
    expect(total(stranger)).toBe(0)
  })
})
