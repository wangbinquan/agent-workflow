// RFC-244 capacity smoke: keep this deterministic and generous. It is not a
// microbenchmark; it guards against accidentally returning to 500-row client
// scans or making each child expansion rescan every task globally.
//
// RFC-359 W6-T27 起两个引擎各跑一遍，判据也从**墙钟毫秒**换成了与负载无关的量。
//
// 为什么换：原判据是「20k 行的一页 + 20 次子展开必须在 30 秒内跑完」。30 秒对本机是三个
// 数量级的余量，对满载的共享 runner 却不是——`docs/audit-backlog.md` §「O(k²) 守卫用墙钟
// 毫秒当判据，在共享 runner 上会假红」记着同类判据在 CI 上量到本机 300 倍的实例。更要命的是
// 它**测不出想测的东西**：真回归（子展开退回全表扫描）在 20k 行上也未必撞破 30 秒，而机器
// 一忙就会在没有任何回归时红。
//
// 新判据是**取回的行数**：一页 root 只许取回 min(limit, 根数) 行，每次子展开只许取回一页。
// 这个量由查询形状唯一决定，与 CPU 忙不忙无关，而且正是「退回 500 行客户端扫描 / 每次展开
// 重扫全表」这两类回归的直接签名。墙钟仍然打印出来作诊断基线（RFC-359 AC-11 要的「两个
// 引擎各取各的 P95」），但不再是判据。

import { describe, expect, test } from 'bun:test'

import { buildActor } from '../src/auth/actor'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { tasks, users, workflows } from '../src/db/schema'
import { describeEachProvider } from './helpers/eachProvider'
import { listTaskOperationsPage } from './helpers/taskListPage'

const ROOT_COUNT = 20
const CHILDREN_PER_ROOT = 999
const PAGE_LIMIT = 50

/**
 * **结构目标**：一页 root（20 个）+ 20 次子展开（每次 50 行）+ 每次展开的所有者补齐。
 * 这个数不随库里 20k 行变化——那正是「分页」的定义。
 */
const STRUCTURAL_TARGET_ROWS = ROOT_COUNT + 20 * PAGE_LIMIT + 64

/**
 * **实测棘轮（只许降）**：今天离结构目标还差 20 倍，差的那一笔有名有姓。
 *
 * RFC-359 W6-T27 上线这条判据时实测：两个引擎**各 83 条语句、各取回 21061 行**（完全一致）。
 * 其中 19980 行来自同一条语句——root 页的子任务补齐：
 *
 *     select parent_task_id, id from tasks where parent_task_id in (<本页 20 个 root>)
 *
 * 它把这 20 个 root 的**全部**子任务取回内存，只为算「这个 root 有没有子任务 / 有几个」。
 * 本例每个 root 挂 999 个子任务，于是一页 20 行的列表搬回了 19980 行；生产上一个跑了几天的
 * root 子任务只会更多。这是 RFC-311 审计「取回行数不随库增长」那一类的存量，
 * `rfc311-perf-guards` 没抓到它是因为那份语料**没有子任务**（全是 root）。
 *
 * 正解是把它下推成聚合（`select parent_task_id, count(*) … group by parent_task_id`，
 * 返回行数被本页 root 数封顶），或干脆只问存在性（`exists`）。改完之后把这个棘轮降到
 * `STRUCTURAL_TARGET_ROWS`，本注释一并删掉。**在那之前只许降不许升。**
 */
const ROWS_FETCHED_RATCHET = 21_100

describeEachProvider('RFC-244 task operations capacity smoke', (harness) => {
  test('20k tasks support one root page plus twenty bounded child expansions', async () => {
    const db: ProviderNeutralDatabase = harness.db
    await db.insert(users).values({
      id: 'capacity-owner',
      username: 'capacity-owner',
      displayName: 'Capacity Owner',
      role: 'user',
      createdAt: 1,
      updatedAt: 1,
    })
    await db.insert(workflows).values({
      id: 'capacity-workflow',
      name: 'Capacity workflow',
      definition: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
    })

    const rows: (typeof tasks.$inferInsert)[] = []
    for (let rootIndex = 0; rootIndex < ROOT_COUNT; rootIndex += 1) {
      const rootId = `capacity-root-${String(rootIndex).padStart(2, '0')}`
      rows.push(taskRow(rootId, null, rootIndex * 10_000))
      for (let childIndex = 0; childIndex < CHILDREN_PER_ROOT; childIndex += 1) {
        rows.push(
          taskRow(
            `${rootId}-child-${String(childIndex).padStart(4, '0')}`,
            rootId,
            rootIndex * 10_000 + childIndex + 1,
          ),
        )
      }
    }
    // 分批插：PostgreSQL 的绑定参数上限是 65535，逐行插会把整条 lane 拖成分钟级。
    for (let offset = 0; offset < rows.length; offset += 200) {
      await db.insert(tasks).values(rows.slice(offset, offset + 200))
    }

    const actor = buildActor({
      user: {
        id: 'capacity-owner',
        username: 'capacity-owner',
        displayName: 'Capacity Owner',
        role: 'user',
        status: 'active',
      },
      source: 'session',
    })

    const recording = harness.recordStatements()
    const started = performance.now()
    try {
      const rootPage = await listTaskOperationsPage(db as never, actor, {
        limit: String(PAGE_LIMIT),
      })
      expect(rootPage.kind).toBe('root')
      expect(rootPage.items).toHaveLength(ROOT_COUNT)
      for (const root of rootPage.items) {
        const children = await listTaskOperationsPage(db as never, actor, {
          parent_id: root.id,
          limit: String(PAGE_LIMIT),
        })
        expect(children.kind).toBe('children')
        expect(children.items).toHaveLength(PAGE_LIMIT)
        expect(children.nextCursor).not.toBeNull()
      }
    } finally {
      recording.stop()
    }
    const elapsedMs = performance.now() - started

    // 判据：**取回多少行**，不是花了多少毫秒。20k 行的库里只许搬回一页 root + 20 页子任务。
    const fetched = recording.statements.reduce((total, statement) => total + statement.rows, 0)
    console.info(
      `[rfc244-capacity ${harness.capabilities.provider}] 20k root+20-child-pages ` +
        `${elapsedMs.toFixed(1)}ms / ${recording.statements.length} 条语句 / 取回 ${fetched} 行`,
    )
    expect(
      fetched,
      `一页 root + 20 次子展开取回了 ${fetched} 行（棘轮 ${ROWS_FETCHED_RATCHET}，结构目标 ${STRUCTURAL_TARGET_ROWS}）。\n` +
        `这是「退回 500 行客户端扫描」或「每次子展开重扫全表」的签名——库里有 ` +
        `${rows.length} 行，页查询却把远超一页的数据搬了回来。\n` +
        recording.statements
          .filter((statement) => statement.rows > PAGE_LIMIT + 1)
          .map(
            (statement) =>
              `  ${statement.rows} 行 ← ${statement.sql.replace(/\s+/g, ' ').slice(0, 120)}`,
          )
          .join('\n'),
    ).toBeLessThanOrEqual(ROWS_FETCHED_RATCHET)
  }, 180_000)
})

describe('RFC-244 capacity smoke —— 判据本身的形状', () => {
  test('结构目标是常量，棘轮欠着的那一笔必须还在账上', () => {
    // 20k 行的库、目标却只有三位数——这正是「分页」这件事的定义。判据一旦被改成随
    // ROOT_COUNT * CHILDREN_PER_ROOT 走，它就再也拦不住全表扫描了。
    expect(STRUCTURAL_TARGET_ROWS).toBeLessThan(ROOT_COUNT * CHILDREN_PER_ROOT * 0.1)
    expect(STRUCTURAL_TARGET_ROWS).toBeGreaterThanOrEqual(ROOT_COUNT + 20 * PAGE_LIMIT)
    // 棘轮高于结构目标 = 还欠着债；两者相等的那天这条断言会提醒把棘轮和注释一起删掉。
    expect(ROWS_FETCHED_RATCHET).toBeGreaterThanOrEqual(STRUCTURAL_TARGET_ROWS)
  })
})

function taskRow(
  id: string,
  parentTaskId: string | null,
  startedAt: number,
): typeof tasks.$inferInsert {
  return {
    id,
    name: id,
    workflowId: 'capacity-workflow',
    workflowSnapshot: '{}',
    repoPath: `/tmp/${id}`,
    worktreePath: `/tmp/wt-${id}`,
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'done',
    inputs: '{}',
    startedAt,
    finishedAt: startedAt + 1,
    ownerUserId: 'capacity-owner',
    parentTaskId,
    invocationDepth: parentTaskId === null ? 0 : 1,
  }
}
