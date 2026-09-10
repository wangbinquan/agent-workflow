// RFC-359 AC-11 —— 反问徽标计数的**往返数预算**（双引擎，只降不升）。
//
// 与 `rfc359-w56-badge-round-trip-budget.test.ts` 同一条判据、同一个理由，钉的是另一个
// 端点：`GET /api/clarify/pending-count`。壳层每 15s × 每个打开的标签页轮询一次。
//
// 为什么它需要单独一条
// -------------------
// `rfc311-badge-counts.test.ts` 的对拍只比**数字**（count === 过滤后列表长度），比不出
// **语句数**；而 `countAwaitingClarifyRounds` 的两条分支往返数并不一样：
//   - `tasks:read:all`：一条 `count(*)`，早就是对的；
//   - 其余所有人（**生产上的绝大多数请求**）：① 把全部 awaiting 轮次的 taskId 捞出来
//     → ② `visibleTaskIds` 再问一次可见性（内部还按 sqlChunk 分块，任务多了不止一条）
//     → 在 JS 里 reduce 计数。
// 数字一直是对的，所以对拍一直绿。RFC-311 那份文件的头注释至今写着「the 15s inbox badge
// as ONE indexed count(*)」——对 admin 成立，对普通用户不成立。
//
// 代价为什么只在 PostgreSQL 上显形
// -------------------------------
// 每一段在 SQLite 上是进程内调用（~0μs），在 PostgreSQL 上是一次真实网络往返。取证泳道
// 实测该端点 SQLite P95 **1.58ms** / PG **3.46ms**，且差值不随行数放大——代价来自**往返
// 次数**，不是查询本身。这是 AC-11（PG 各端点 P95 不劣于 SQLite）在轻端点上唯一的杠杆。
//
// 判据是**语句数**而不是墙钟：确定性、可进每次 PR，不会因为机器忙就假红。
import { expect, test } from 'bun:test'
import { ulid } from 'ulid'

import { buildActor, type Actor } from '../src/auth/actor'
import {
  clarifyRounds,
  nodeRuns,
  taskCollaborators,
  tasks,
  users,
  workflows,
} from '../src/db/schema'
import { countAwaitingClarifyRounds } from '../src/modules/collaboration/infrastructure/clarifyRounds'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'

function actorOf(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

const NOW = 1_788_278_400_000

async function addTask(
  db: ProviderNeutralDatabase,
  id: string,
  ownerUserId: string | null,
  status: 'running' | 'awaiting_human' | 'canceled',
): Promise<void> {
  await db.insert(tasks).values({
    id,
    name: id,
    workflowId: 'wf',
    workflowSnapshot: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status,
    inputs: '{}',
    startedAt: NOW,
    ...(ownerUserId === null ? {} : { ownerUserId }),
  })
}

async function addRound(
  db: ProviderNeutralDatabase,
  taskId: string,
  status: 'awaiting_human' | 'answered',
): Promise<void> {
  const runId = ulid()
  await db.insert(nodeRuns).values({
    id: runId,
    taskId,
    nodeId: 'ask',
    status: 'running',
    retryIndex: 0,
    iteration: 0,
    startedAt: NOW,
  })
  await db.insert(clarifyRounds).values({
    id: ulid(),
    taskId,
    kind: 'self',
    askingNodeId: 'ask',
    askingNodeRunId: runId,
    intermediaryNodeId: 'ask',
    intermediaryNodeRunId: runId,
    questionsJson: '[]',
    status,
  })
}

/** 语料同时覆盖：属主可见 / 协作者可见 / 他人不可见 / 终态任务被丢弃 / 已答不计。 */
async function seed(db: ProviderNeutralDatabase): Promise<void> {
  await db.insert(users).values(
    ['admin', 'alice', 'bob', 'carol'].map((id) => ({
      id,
      username: id,
      displayName: id,
      role: id === 'admin' ? ('admin' as const) : ('user' as const),
      createdAt: NOW,
      updatedAt: NOW,
    })),
  )
  await db.insert(workflows).values({
    id: 'wf',
    name: 'wf',
    definition: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
  })
  await addTask(db, 'c-live', 'alice', 'awaiting_human')
  await addRound(db, 'c-live', 'awaiting_human')
  await addRound(db, 'c-live', 'answered')
  await db.insert(taskCollaborators).values({
    taskId: 'c-live',
    userId: 'carol',
    role: 'collaborator',
    addedBy: 'alice',
    addedAt: NOW,
  })
  await addTask(db, 'c-done', 'alice', 'canceled')
  await addRound(db, 'c-done', 'awaiting_human')
  await addTask(db, 'c-bob', 'bob', 'awaiting_human')
  await addRound(db, 'c-bob', 'awaiting_human')
}

describeEachProvider('RFC-359 AC-11 —— 反问徽标计数的往返数预算', (h) => {
  test('countAwaitingClarifyRounds 恒发一条语句，且由 SQL 计数（四种 actor 形态）', async () => {
    await seed(h.db)

    for (const [label, who] of [
      ['admin（tasks:read:all）', actorOf('admin', 'admin')],
      ['属主', actorOf('alice')],
      ['协作者', actorOf('carol')],
      ['无关用户', actorOf('bob')],
    ] as const) {
      const recording = h.recordStatements()
      try {
        await countAwaitingClarifyRounds(h.db, who)
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

  test('结果本身不变：admin 数全部、属主与协作者各数到自己那条、无关用户数不到', async () => {
    await seed(h.db)
    expect(await countAwaitingClarifyRounds(h.db, actorOf('admin', 'admin'))).toBe(2)
    expect(await countAwaitingClarifyRounds(h.db, actorOf('alice'))).toBe(1)
    expect(await countAwaitingClarifyRounds(h.db, actorOf('carol'))).toBe(1)
    expect(await countAwaitingClarifyRounds(h.db, actorOf('bob'))).toBe(1)
  })

  // `countAwaitingClarifyRounds` 里那两条防孤儿的分支（`or(isNull(tasks.id), …)` 与
  // 受限分支的 `isNotNull(tasks.id)`）**在两个引擎上都够不着**：clarify_rounds.task_id
  // 对 tasks.id 有外键，两侧都强制。折叠往返时我把它们逐字保留了，但「保留的是死分支」
  // 这件事本身要有判据——哪天有人把外键去掉，孤儿状态变可达，这条会红并指回那两条分支。
  test('孤儿轮次不可达：两个引擎都由外键拒绝没有 tasks 行的 clarify_round', async () => {
    await seed(h.db)
    let rejected: unknown
    try {
      await db_insertOrphan(h.db)
    } catch (error) {
      rejected = error
    }
    expect(
      rejected,
      'clarify_rounds.task_id → tasks.id 的外键必须拦住孤儿轮次；它一旦失效，' +
        'countAwaitingClarifyRounds 里两条按孤儿写的分支就从死代码变成活语义，' +
        '而它们此刻没有任何行为覆盖。',
    ).toBeDefined()
    // 前提没变：语料本身的计数不受影响。
    expect(await countAwaitingClarifyRounds(h.db, actorOf('admin', 'admin'))).toBe(2)
  })
})

/** 一条 task_id 指向不存在任务的 clarify_round——两个引擎都应当拒绝。 */
async function db_insertOrphan(db: ProviderNeutralDatabase): Promise<void> {
  const runId = ulid()
  await db.insert(clarifyRounds).values({
    id: ulid(),
    taskId: 'ghost-task',
    kind: 'self',
    askingNodeId: 'ask',
    askingNodeRunId: runId,
    intermediaryNodeId: 'ask',
    intermediaryNodeRunId: runId,
    questionsJson: '[]',
    status: 'awaiting_human',
  })
}
