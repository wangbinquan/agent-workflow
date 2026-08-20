// RFC-311（自 RFC-310 移交）—— `/api/code/missions` 的 O(页) 读法。
//
// 移交理由（记在 RFC-311 plan.md 的后续清单里）：原实现是全表 `.all()` + 全量
// 投影，mission 表长起来会复刻 `/tasks` 在十万任务下的卡顿形态，而这条路径跑在
// daemon 唯一的同步连接上——一次慢查询就是全站停顿。
//
// 锁三件事：
//   1. **逐页序列 === 旧全量顺序**（分页只是把同一个序列切开，不是换一种排序）；
//   2. **双形状**：无参保持旧 `{items}`，带参才切 `{items, nextCursor}`——既有
//      消费点零改动是这次能安全落地的前提；
//   3. 断点是**行值比较**：同一 `created_at` 上的多行不能重复也不能漏（RFC-311
//      在 10 万任务库上实测过展开式断点会让 SQLite 走 TEMP B-TREE 全排序）。

import { describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { taskMatchesListView } from '@agent-workflow/shared'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { developmentMissions, users } from '../src/db/schema'
import {
  listMissionSummaries,
  listMissionSummariesPage,
} from '../src/modules/development-automation/infrastructure/missionReadModels'
import { createApp } from '../src/server'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const TOKEN = 'a'.repeat(64)
const T0 = 1_700_000_000_000

async function seed(db: DbClient, count: number): Promise<void> {
  await db.insert(users).values({
    id: 'u1',
    username: 'u1',
    displayName: 'u1',
    role: 'admin',
    createdAt: T0,
    updatedAt: T0,
  })
  for (let i = 0; i < count; i += 1) {
    await db.insert(developmentMissions).values({
      id: `m${String(i).padStart(3, '0')}`,
      revision: 1,
      status: 'active',
      automationMode: 'auto',
      transitionFence: 'none',
      repositoryId: `repo-${i % 3}`,
      sourceKind: 'direct-input',
      deliveryKind: 'merge-request',
      // 每三行共享一个 created_at ⇒ 逼出「同一时间戳内的次序」这条边界:
      // 只有 (created_at, id) 的行值断点才能在这里既不重复也不漏。
      createdAt: T0 + Math.floor(i / 3) * 1_000,
      updatedAt: T0 + i,
    })
  }
}

/** 状态/文本都铺开的种子——否则过滤组合大半命中空集，对拍等于没跑。 */
async function seedVaried(db: DbClient, count: number): Promise<void> {
  await db.insert(users).values({
    id: 'u1',
    username: 'u1',
    displayName: 'u1',
    role: 'admin',
    createdAt: T0,
    updatedAt: T0,
  })
  const statuses = [
    'admitting',
    'awaiting-information',
    'working',
    'publishing',
    'watching',
    'ready-to-merge',
    'waiting-committer',
    'blocked',
    'completed-no-change',
    'merged',
    'closed-unmerged',
    'canceled',
    'failed',
  ]
  for (let i = 0; i < count; i += 1) {
    await db.insert(developmentMissions).values({
      id: `m${String(i).padStart(3, '0')}`,
      revision: 1,
      status: statuses[i % statuses.length]!,
      automationMode: 'auto',
      transitionFence: 'none',
      repositoryId: `repo-${i % 3}`,
      sourceKind: 'direct-input',
      deliveryKind: 'merge-request',
      externalId: i % 4 === 0 ? `EXT-${i}` : null,
      blockCode: i % 5 === 0 ? `block-${i}` : null,
      employeeId: i % 6 === 0 ? `emp-${i}` : null,
      createdAt: T0 + Math.floor(i / 3) * 1_000,
      updatedAt: T0 + i,
    })
  }
}

function pageAll(db: DbClient, limit: number): string[] {
  const ids: string[] = []
  let cursor = undefined as undefined | { createdAt: number; id: string }
  for (let guard = 0; guard < 100; guard += 1) {
    const page = listMissionSummariesPage(db, {
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
    })
    ids.push(...page.items.map((m) => m.id))
    if (page.nextCursor === null) break
    cursor = page.nextCursor
  }
  return ids
}

describe('RFC-311 — mission list paging === the legacy full listing', () => {
  test('every page size reproduces the full-list order exactly, ties included', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, 25)
    const expected = listMissionSummaries(db).map((m) => m.id)
    expect(expected).toHaveLength(25)

    for (const limit of [1, 2, 3, 4, 7, 25, 100]) {
      expect(pageAll(db, limit), `limit=${limit}`).toEqual(expected)
    }
  })

  test('the wire keeps both shapes: bare call is legacy, any paging param pages', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aw-rfc311-missions-'))
    process.env.AGENT_WORKFLOW_HOME = home
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, 12)
    const app: Hono = createApp({
      token: TOKEN,
      configPath: join(home, 'config.json'),
      opencodeVersion: '1.14.25',
      dbVersion: 17,
      db,
    })
    const get = (path: string) =>
      app.request(path, { headers: { Authorization: `Bearer ${TOKEN}` } })

    const legacy = (await (await get('/api/code/missions')).json()) as Record<string, unknown>
    expect(Array.isArray(legacy.items)).toBe(true)
    expect((legacy.items as unknown[]).length).toBe(12)
    expect('nextCursor' in legacy).toBe(false)

    const first = (await (await get('/api/code/missions?limit=5')).json()) as {
      items: Array<{ id: string }>
      nextCursor: string | null
    }
    expect(first.items).toHaveLength(5)
    expect(first.nextCursor).not.toBeNull()

    const second = (await (
      await get(`/api/code/missions?limit=5&cursor=${encodeURIComponent(first.nextCursor!)}`)
    ).json()) as { items: Array<{ id: string }>; nextCursor: string | null }
    // 翻页不重复:第二页与第一页零交集(游标写错最典型的症状就是重复首行)。
    const firstIds = new Set(first.items.map((m) => m.id))
    for (const item of second.items) expect(firstIds.has(item.id)).toBe(false)

    // 逐条**点名 code**,而不只看 422:`route-error-code-coverage` 守卫要求每个新
    // 错误码在测试里出现过字面量——否则「换了个码」这种回归无人接住(422 还是 422)。
    const failure = async (path: string): Promise<{ status: number; code: string }> => {
      const res = await get(path)
      return { status: res.status, code: ((await res.json()) as { code: string }).code }
    }
    expect(await failure('/api/code/missions?limit=0')).toEqual({
      status: 422,
      code: 'mission-limit-invalid',
    })
    expect(await failure('/api/code/missions?limit=999')).toEqual({
      status: 422,
      code: 'mission-limit-invalid',
    })
    expect(await failure('/api/code/missions?cursor=not-base64url-json')).toEqual({
      status: 422,
      code: 'mission-cursor-invalid',
    })
    expect(await failure('/api/code/missions?view=nope')).toEqual({
      status: 422,
      code: 'mission-view-invalid',
    })
    expect(await failure('/api/code/missions?statuses=not-a-status')).toEqual({
      status: 422,
      code: 'mission-statuses-invalid',
    })
    expect(await failure('/api/code/missions?missionStatuses=not-a-mission-status')).toEqual({
      status: 422,
      code: 'mission-raw-statuses-invalid',
    })
  })
})

// RFC-311 —— 服务端过滤/facets 必须**逐条等于**此前前端那份实现。
//
// 背景：`/tasks` 的数字员工分类此前取**全量** mission 再在前端
// `filterDigitalEmployeeMissions` + `digitalEmployeeFacets`。要接分页就必须把过滤与
// 计数下推服务端，而"下推"最容易悄悄改语义（少一个状态、大小写不敏感漏了一列、
// facets 跟着过滤走）。所以这里把**旧的前端实现原样写进测试当预言**，逐组合对拍。
//
// 预言故意写成朴素的 JS filter：它不共享被测代码的任何一行，两者一致才有意义。

function oracleTaskStatus(status: string): string {
  if (status === 'admitting') return 'pending'
  if (status === 'awaiting-information') return 'awaiting_human'
  if (status === 'ready-to-merge' || status === 'waiting-committer') return 'awaiting_review'
  if (status === 'merged' || status === 'completed-no-change') return 'done'
  if (status === 'closed-unmerged' || status === 'canceled') return 'canceled'
  if (status === 'blocked' || status === 'failed') return 'failed'
  return 'running'
}
// 视图判定**直接复用 shared 的 `taskMatchesListView`**——旧前端用的就是它，不是
// 另一份实现。预言真正要独立转写的是搬家的那部分：mission 状态映射 + 过滤循环。
// （第一版我把三个桶按记忆手写进预言，`ACTIVE` 漏了 awaiting_review/awaiting_human，
// 于是预言自己先错了。凡是"照记忆重写一遍"的预言都有这个风险；能复用单一事实源
// 的部分就别重写。）
function oracleFilter(
  rows: Array<Record<string, unknown>>,
  f: { view: string; statuses: string[]; q?: string },
): Array<Record<string, unknown>> {
  const q = f.q?.toLocaleLowerCase('en-US')
  return rows.filter((m) => {
    const status = oracleTaskStatus(String(m.status))
    if (f.statuses.length > 0 && !f.statuses.includes(status)) return false
    if (!taskMatchesListView(f.view as never, status as never)) return false
    if (q === undefined) return true
    return [m.id, m.repositoryId, m.externalId ?? '', m.blockCode ?? '', m.employeeId ?? ''].some(
      (v) => String(v).toLocaleLowerCase('en-US').includes(q),
    )
  })
}

describe('RFC-311 — mission 服务端过滤/facets === 旧的前端实现', () => {
  test('64 组过滤逐页对拍，且 facets 恒为全集计数', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedVaried(db, 40)
    const all = listMissionSummaries(db) as unknown as Array<Record<string, unknown>>

    const views = ['all', 'active', 'attention', 'finished']
    const statusSets: string[][] = [[], ['running'], ['done', 'failed'], ['awaiting_review']]
    const queries: Array<string | undefined> = [undefined, 'repo-1', 'EMP', 'zzz-no-match']

    let combos = 0
    for (const view of views) {
      for (const statuses of statusSets) {
        for (const q of queries) {
          combos += 1
          const expected = oracleFilter(all, { view, statuses, ...(q !== undefined ? { q } : {}) })
          // 逐页取完，验证分页只是把同一序列切开
          const got: string[] = []
          let cursor: undefined | { createdAt: number; id: string }
          for (let guard = 0; guard < 200; guard += 1) {
            const page = listMissionSummariesPage(db, {
              limit: 7,
              view: view as never,
              statuses: statuses as never,
              ...(q !== undefined ? { q } : {}),
              ...(cursor !== undefined ? { cursor } : {}),
            })
            got.push(...page.items.map((m) => m.id))
            // facets 恒等于全集计数,不随过滤变化
            expect(page.facets.all, `facets.all 应恒为全集(${view}/${statuses}/${q})`).toBe(
              all.length,
            )
            if (page.nextCursor === null) break
            cursor = page.nextCursor
          }
          expect(got, `组合 view=${view} statuses=[${statuses}] q=${q}`).toEqual(
            expected.map((m) => String(m.id)),
          )
        }
      }
    }
    expect(combos).toBe(64)
  })
})

describe('RFC-311 — employeeId / missionStatuses 过滤与 counts', () => {
  test('counts 算在过滤集上，且原始状态过滤不会把 blocked 混进终态', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedVaried(db, 40)
    const all = listMissionSummaries(db)

    // ① employeeId 收敛：counts 的总和 === 该员工的 mission 数
    const employeeId = all.find((m) => m.employeeId !== null)?.employeeId ?? null
    expect(employeeId).not.toBeNull()
    const scoped = listMissionSummariesPage(db, { limit: 1, employeeId: employeeId! })
    const scopedTotal = Object.values(scoped.counts).reduce((a, b) => a + b, 0)
    expect(scopedTotal).toBe(all.filter((m) => m.employeeId === employeeId).length)
    // facets 仍是全集语义，不随过滤走
    expect(scoped.facets.all).toBe(all.length)

    // ② 终态集合必须用**原始 mission 状态**表达：blocked 映射成 failed，
    //    若用任务状态 statuses=failed 会把 blocked 一起捞进来。
    const TERMINAL = [
      'merged',
      'completed-no-change',
      'closed-unmerged',
      'canceled',
      'failed',
    ] as const
    const terminal = listMissionSummariesPage(db, { limit: 200, missionStatuses: TERMINAL })
    expect(terminal.items.map((m) => m.id).sort()).toEqual(
      all
        .filter((m) => (TERMINAL as readonly string[]).includes(m.status))
        .map((m) => m.id)
        .sort(),
    )
    expect(
      terminal.items.some((m) => m.status === 'blocked'),
      'blocked 不是终态，不该出现在终态过滤里',
    ).toBe(false)

    // 反证：用任务状态表达会捞到 blocked——这正是必须新增原始状态过滤的理由
    const byTaskStatus = listMissionSummariesPage(db, { limit: 200, statuses: ['failed'] })
    expect(byTaskStatus.items.some((m) => m.status === 'blocked')).toBe(true)
  })
})
