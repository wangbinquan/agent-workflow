// RFC-329 PR-B —— `pendingRows` 与 `pendingCount` 是同一个判定（AC-8）。
//
// 起因：`list_pending_gates` 要列出「在等人的工作组任务」，而 REST 上只有一个 badge 计数
// （三个数字）和一个单任务房间——没有可列的端点。而计数**内部**早就把整批行算出来了
// （可见性过滤、gate 判定、逐人待交付卡片），只是丢掉了。
//
// 于是重构成 `pendingRows` 唯一实现、`pendingCount` 由它派生。这个文件锁的就是那句
// 「由它派生」：**逐 actor 的 reduce(rows) === count**。
//
// 为什么不是「两个 HTTP 端点看到的行集合相同」（RFC-329 v1 曾这么写、设计门 P2-9 打回）：
// 旧端点只返回三个数字，根本没有行可比——那句话无法证伪。聚合等式才是能红的判据。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb } from '../src/db/client'
import { tasks, users, workflows, workgroupAssignments, workgroupTaskState } from '../src/db/schema'
import { buildRoomReads } from '../src/modules/resource-catalog/infrastructure/legacy/workgroup/room'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_788_278_400_000
type Db = ReturnType<typeof createInMemoryDb>

function actor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

/** alice owns it and is a human member; bob is unrelated. */
function config(): Record<string, unknown> {
  return {
    workgroupId: 'wg1',
    workgroupName: 'wg',
    mode: 'free_collab',
    leaderMemberId: null,
    switches: { shareOutputs: true, directMessages: true, blackboard: true },
    maxRounds: 3,
    completionGate: true,
    goal: 'ship it',
    instructions: '',
    members: [
      {
        id: 'm-alice',
        memberType: 'human',
        agentName: null,
        agentId: null,
        userId: 'alice',
        displayName: 'alice',
        roleDesc: 'reviewer',
      },
      {
        id: 'm-agent',
        memberType: 'agent',
        agentName: 'a1',
        agentId: 'agent-1',
        userId: null,
        displayName: 'A1',
        roleDesc: 'worker',
      },
    ],
  }
}

interface TaskSpec {
  readonly id: string
  readonly status: 'running' | 'awaiting_review'
  readonly gateStatus:
    | 'idle'
    | 'declared'
    | 'awaiting_confirmation'
    | 'approved'
    | 'rejected'
    | null
  /** dispatched cards addressed to alice's member id */
  readonly cardsForAlice: number
}

async function seed(db: Db, specs: ReadonlyArray<TaskSpec>): Promise<void> {
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
  for (const spec of specs) {
    await db.insert(tasks).values({
      id: spec.id,
      name: `task ${spec.id}`,
      workflowId: 'wf1',
      workflowSnapshot: '{}',
      repoPath: '/tmp/never-read',
      worktreePath: '/tmp/never-read',
      baseBranch: 'main',
      branch: `agent-workflow/${spec.id}`,
      status: spec.status,
      inputs: '{}',
      startedAt: NOW,
      runningMs: 0,
      ownerUserId: 'alice',
      launchOrigin: 'manual',
      workgroupId: 'wg1',
      workgroupConfigJson: JSON.stringify(config()),
    })
    if (spec.gateStatus !== null) {
      await db
        .insert(workgroupTaskState)
        .values({ taskId: spec.id, gateStatus: spec.gateStatus, updatedAt: NOW })
    }
    for (let i = 0; i < spec.cardsForAlice; i++) {
      await db.insert(workgroupAssignments).values({
        id: `${spec.id}-card-${i}`,
        taskId: spec.id,
        assigneeMemberId: 'm-alice',
        status: 'dispatched',
        source: 'leader',
        title: `card ${i}`,
        createdAt: NOW,
        updatedAt: NOW,
      })
    }
  }
}

function reads(db: Db) {
  return buildRoomReads(
    { db } as never,
    { loadVisibleWorkgroupTask: async () => ({}) as never } as never,
  )
}

/** The identity the refactor has to preserve. */
function foldRows(rows: Awaited<ReturnType<ReturnType<typeof reads>['pendingRows']>>): {
  deliveries: number
  gates: number
  total: number
} {
  const gates = rows.filter((row) => row.awaitingConfirmation).length
  const deliveries = rows.reduce((sum, row) => sum + row.pendingDeliveries, 0)
  return { deliveries, gates, total: deliveries + gates }
}

describe('RFC-329 AC-8 — the badge is a fold of the rows, for every actor', () => {
  test('gate only, deliveries only, and both at once all fold correctly', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, [
      // Parked on a confirmation gate, nothing dispatched to alice.
      {
        id: 'gate-only',
        status: 'awaiting_review',
        gateStatus: 'awaiting_confirmation',
        cardsForAlice: 0,
      },
      // Cards waiting for alice, no gate.
      { id: 'cards-only', status: 'running', gateStatus: null, cardsForAlice: 2 },
      // BOTH — the row a "pick one" implementation would undercount.
      {
        id: 'both',
        status: 'awaiting_review',
        gateStatus: 'awaiting_confirmation',
        cardsForAlice: 1,
      },
    ])
    const { pendingRows, pendingCount } = reads(db)

    const rows = await pendingRows(actor('alice'))
    const count = await pendingCount(actor('alice'))

    expect(foldRows(rows)).toEqual(count)
    expect(count).toEqual({ deliveries: 3, gates: 2, total: 5 })

    const both = rows.find((row) => row.taskId === 'both')
    expect(both?.awaitingConfirmation).toBe(true)
    expect(both?.pendingDeliveries).toBe(1)
  })

  test('the identity holds for owner, stranger and admin alike', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, [
      {
        id: 'gate-only',
        status: 'awaiting_review',
        gateStatus: 'awaiting_confirmation',
        cardsForAlice: 0,
      },
      {
        id: 'both',
        status: 'awaiting_review',
        gateStatus: 'awaiting_confirmation',
        cardsForAlice: 1,
      },
    ])
    const { pendingRows, pendingCount } = reads(db)

    for (const who of [actor('alice'), actor('bob'), actor('admin', 'admin')]) {
      expect(foldRows(await pendingRows(who)), `actor ${who.user.id}`).toEqual(
        await pendingCount(who),
      )
    }
  })

  test('a stranger sees no rows at all — visibility is not applied only to the count', async () => {
    // Mutation anchor: drop `visibleTaskIdsOf` from pendingRows and bob starts
    // seeing alice's workgroup tasks here, not just in the badge number.
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, [
      {
        id: 'gate-only',
        status: 'awaiting_review',
        gateStatus: 'awaiting_confirmation',
        cardsForAlice: 0,
      },
    ])
    const { pendingRows, pendingCount } = reads(db)

    expect(await pendingRows(actor('bob'))).toEqual([])
    expect(await pendingCount(actor('bob'))).toEqual({ deliveries: 0, gates: 0, total: 0 })
    expect((await pendingRows(actor('alice'))).length).toBe(1)
  })

  test('a row that is neither gated nor addressed to this actor is not listed', async () => {
    // A workgroup task that is simply running, with cards for somebody else, is
    // not "waiting on you" — listing it would make list_pending_gates noisy in
    // exactly the way that trains a model to ignore it.
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, [{ id: 'idle', status: 'running', gateStatus: null, cardsForAlice: 0 }])
    const { pendingRows, pendingCount } = reads(db)

    expect(await pendingRows(actor('alice'))).toEqual([])
    expect(await pendingCount(actor('alice')).then((c) => c.total)).toBe(0)
  })

  test('malformed workgroup config is skipped, not thrown on', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, [
      {
        id: 'ok',
        status: 'awaiting_review',
        gateStatus: 'awaiting_confirmation',
        cardsForAlice: 0,
      },
    ])
    await db.insert(tasks).values({
      id: 'broken',
      name: 'broken',
      workflowId: 'wf1',
      workflowSnapshot: '{}',
      repoPath: '/tmp/never-read',
      worktreePath: '/tmp/never-read',
      baseBranch: 'main',
      branch: 'agent-workflow/broken',
      status: 'awaiting_review',
      inputs: '{}',
      startedAt: NOW,
      runningMs: 0,
      ownerUserId: 'alice',
      launchOrigin: 'manual',
      workgroupId: 'wg1',
      workgroupConfigJson: '{not json',
    })
    const { pendingRows, pendingCount } = reads(db)

    const rows = await pendingRows(actor('alice'))
    expect(rows.map((row) => row.taskId)).toEqual(['ok'])
    expect(foldRows(rows)).toEqual(await pendingCount(actor('alice')))
  })

  test('rows carry what a caller needs to act, not just an id', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, [
      {
        id: 'gate-only',
        status: 'awaiting_review',
        gateStatus: 'awaiting_confirmation',
        cardsForAlice: 0,
      },
    ])
    const rows = await reads(db).pendingRows(actor('alice'))
    expect(rows[0]).toEqual({
      taskId: 'gate-only',
      name: 'task gate-only',
      status: 'awaiting_review',
      gateStatus: 'awaiting_confirmation',
      awaitingConfirmation: true,
      pendingDeliveries: 0,
    })
  })
})
