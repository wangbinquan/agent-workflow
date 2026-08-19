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
  })
})
