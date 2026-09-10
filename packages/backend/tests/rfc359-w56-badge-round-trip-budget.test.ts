// RFC-359 AC-11 —— 徽标计数的**往返数预算**（双引擎，只降不升）。
//
// 为什么需要这条判据
// -----------------
// `rfc311-badge-counts.test.ts` 的对拍只比**数字**（count === 过滤后列表长度），比不出
// **语句数**。于是发生过一次静默漂移：RFC-311 PR-1 把三个 pending-count 端点重写成
// 「single indexed count(*)」（那份文件的头注释至今这么写），而 RFC-340 把评审徽标的语义
// 改成「任务可见 ∪ 节点被指派」时，`countPendingReviews` 退回成
//   ① 主 join 捞出全部待审行 → ② 查可见性 → ③ 查指派 → 在 JS 里归并计数
// 三次串行往返 + 把行搬进内存数一遍。数字一直是对的，所以对拍一直是绿的。
//
// 代价为什么只在 PostgreSQL 上显形
// -------------------------------
// 每一段在 SQLite 上是进程内调用（~0μs），在 PostgreSQL 上是一次真实网络往返。
// RFC-359 取证泳道实测该端点 SQLite P95 **1.80ms** / PG **7.33ms**，差值 +5.5ms ≈ 3 × RTT，
// 且**不随行数放大**——即代价来自**往返次数**，不是查询本身。同一份取证里
// `workgroup-tasks/pending-count` 反而是 PG 快 4.3×（22.7 → 5.2ms），可见「PG 更慢」
// 不是引擎属性，而是这几个端点的往返次数在嵌入式库上免费、在进程外库上要付钱。
// 这是 AC-11（PG 各端点 P95 不劣于 SQLite）在**轻端点**上唯一的杠杆：查询再怎么调，
// 也调不掉一次 TCP 往返。
//
// 判据是**语句数**而不是墙钟：确定性、可进每次 PR，不会因为机器忙就假红
// （与 `rfc311-perf-guards` 同一哲学；RFC-244 的教训是墙钟测不出真回归）。
import { expect, test } from 'bun:test'
import { ulid } from 'ulid'

import { buildActor, type Actor } from '../src/auth/actor'
import { docVersions, nodeRuns, tasks, users, workflows } from '../src/db/schema'
import { countPendingReviews } from '../src/modules/collaboration/infrastructure/review'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'

function actorOf(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

async function seedOnePendingReview(db: ProviderNeutralDatabase): Promise<void> {
  const now = 1_788_278_400_000
  await db.insert(users).values(
    ['alice', 'carol', 'root'].map((id) => ({
      id,
      username: id,
      displayName: id,
      role: id === 'root' ? ('admin' as const) : ('user' as const),
      createdAt: now,
      updatedAt: now,
    })),
  )
  await db.insert(workflows).values({
    id: 'wf',
    name: 'wf',
    definition: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
  })
  await db.insert(tasks).values({
    id: 't-badge',
    name: 't-badge',
    workflowId: 'wf',
    workflowSnapshot: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read',
    baseBranch: 'main',
    branch: 'agent-workflow/t-badge',
    status: 'awaiting_review',
    inputs: '{}',
    startedAt: now,
    ownerUserId: 'alice',
  })
  const runId = ulid()
  await db.insert(nodeRuns).values({
    id: runId,
    taskId: 't-badge',
    nodeId: 'rev',
    status: 'awaiting_review',
    retryIndex: 0,
    iteration: 0,
    reviewIteration: 0,
    startedAt: now,
  })
  await db.insert(docVersions).values({
    id: ulid(),
    taskId: 't-badge',
    reviewNodeId: 'rev',
    reviewNodeRunId: runId,
    sourceNodeId: 'src',
    sourcePortName: 'doc',
    versionIndex: 1,
    reviewIteration: 0,
    bodyPath: 'doc_versions/never-read.md',
    decision: 'pending',
  })
}

describeEachProvider('RFC-359 AC-11 —— 徽标计数的往返数预算', (h) => {
  test('countPendingReviews 恒发一条语句，且由 SQL 计数（三种 actor 形态）', async () => {
    await seedOnePendingReview(h.db)

    // 三种形态各自走不同分支：无 actor 不收窄；owner 命中可见性臂；
    // 非成员两臂都不命中（结果 0，但语句数不许因此变多）。
    for (const [label, who] of [
      ['无 actor（不收窄）', undefined],
      ['owner', actorOf('alice')],
      ['非成员', actorOf('carol')],
    ] as const) {
      const recording = h.recordStatements()
      try {
        await countPendingReviews(h.db, who)
      } finally {
        recording.stop()
      }
      const statements = recording.statements
      expect(
        statements.length,
        `${label}：徽标计数必须恒为一条语句——多出来的每一条在 PostgreSQL 上都是一次真实往返，` +
          `而这个端点的 P95 差值几乎全部来自往返次数（AC-11）。实际执行：\n` +
          statements.map((row) => row.sql).join('\n'),
      ).toBe(1)
      expect(
        statements[0]?.sql.toLowerCase().includes('count('),
        `${label}：必须由 SQL 计数；把匹配行搬进 JS 再数一遍，行数一多就是无界读`,
      ).toBe(true)
    }
  })

  test('结果本身不变：owner 数得到、非成员数不到、无 actor 数全部', async () => {
    await seedOnePendingReview(h.db)
    expect(await countPendingReviews(h.db, actorOf('alice'))).toBe(1)
    expect(await countPendingReviews(h.db, actorOf('carol'))).toBe(0)
    expect(await countPendingReviews(h.db)).toBe(1)
    expect(await countPendingReviews(h.db, actorOf('root', 'admin'))).toBe(1)
  })
})
