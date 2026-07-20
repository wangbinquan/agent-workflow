// RFC-210 T38-T42 — 后台定时刷新缓存仓 + submodule。
//
// 为什么这条测试存在：
//
// 缓存镜像此前只在两个时刻前进——起任务时的 warm fetch，或用户手点 Refresh。
// 一个一周没被起过任务的仓就是一周陈旧的，它的子仓同样。
//
// 锁两件事：
//  1. **选仓条件**。既要「该刷了」（从未自动刷过，或上次自动刷早于一个周期），
//     也要「最近还有人用」（last_fetched_at 在 onlyRecentDays 内）。第二条是防
//     网络风暴的：机器上常年累积一堆一次性实验留下的镜像，永远重新 fetch 它们
//     对谁都没好处。
//  2. **`last_auto_refresh_at` 与 `last_fetched_at` 分开**。后者会被起任务的
//     warm fetch 推进，若复用它做节流判据，任务频繁的仓就永远不会被后台刷到、
//     而这恰恰应该是无所谓的；反过来判据也会被任务流量污染。
//
// 循环本身遵循仓里既定样板（eventsArchive / gc）：{stop} 句柄、重入保护、
// 每 tick 读一次 config、错误只记日志不抛——后台刷新绝不能把 daemon 拖挂。

import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  DEFAULT_ONLY_RECENT_DAYS,
  DEFAULT_REFRESH_INTERVAL_MS,
  refreshDueRepos,
  selectDueRepos,
  startSubmoduleRefreshLoop,
} from '@/services/submoduleRefresh'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

async function seed(
  db: DbClient,
  rows: Array<{ id: string; fetchedAt: number; autoRefreshAt: number | null }>,
): Promise<void> {
  for (const r of rows) {
    await db.run(sql`
      INSERT INTO cached_repos (id, url_hash, url, url_redacted, local_path,
        last_fetched_at, created_at, last_auto_refresh_at)
      VALUES (${r.id}, ${r.id}, '', ${'https://x/' + r.id}, ${'/tmp/' + r.id},
        ${r.fetchedAt}, 0, ${r.autoRefreshAt})
    `)
  }
}

describe('RFC-210 background refresh — repo selection', () => {
  test('picks repos never auto-refreshed, skips ones refreshed within the interval', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, [
      { id: 'never', fetchedAt: NOW - DAY, autoRefreshAt: null },
      { id: 'stale', fetchedAt: NOW - DAY, autoRefreshAt: NOW - 12 * 60 * 60 * 1000 },
      { id: 'fresh', fetchedAt: NOW - DAY, autoRefreshAt: NOW - 60_000 },
    ])
    const due = await selectDueRepos(db, {
      now: NOW,
      intervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      onlyRecentDays: DEFAULT_ONLY_RECENT_DAYS,
    })
    expect(due.map((r) => r.id).sort()).toEqual(['never', 'stale'])
  })

  test('skips repos nobody has used lately, however stale they are', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, [
      { id: 'recent', fetchedAt: NOW - 5 * DAY, autoRefreshAt: null },
      // Untouched for a year: refreshing it forever serves nobody.
      { id: 'abandoned', fetchedAt: NOW - 365 * DAY, autoRefreshAt: null },
    ])
    const due = await selectDueRepos(db, {
      now: NOW,
      intervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      onlyRecentDays: DEFAULT_ONLY_RECENT_DAYS,
    })
    expect(due.map((r) => r.id)).toEqual(['recent'])
  })

  test('the recency window is configurable', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, [{ id: 'r', fetchedAt: NOW - 40 * DAY, autoRefreshAt: null }])
    const narrow = await selectDueRepos(db, {
      now: NOW,
      intervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      onlyRecentDays: 30,
    })
    expect(narrow).toHaveLength(0)
    const wide = await selectDueRepos(db, {
      now: NOW,
      intervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      onlyRecentDays: 90,
    })
    expect(wide).toHaveLength(1)
  })
})

describe('RFC-210 background refresh — tick behaviour', () => {
  test('disabled config makes the tick a no-op that touches nothing', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, [{ id: 'r', fetchedAt: NOW - DAY, autoRefreshAt: null }])
    const res = await refreshDueRepos(db, { submoduleAutoRefresh: { enabled: false } })
    expect(res).toEqual({ refreshed: 0, failed: 0 })
    const row = (await db.all(
      sql`SELECT last_auto_refresh_at AS a FROM cached_repos WHERE id='r'`,
    )) as Array<{ a: number | null }>
    expect(row[0]?.a).toBeNull()
  })

  test('a repo whose local path is gone is counted failed, not thrown', async () => {
    // refreshCachedRepo raises repo-cache-corrupt for a missing cache dir. One
    // broken repo must not abort the whole sweep.
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, [{ id: 'gone', fetchedAt: NOW - DAY, autoRefreshAt: null }])
    const res = await refreshDueRepos(db, { submoduleAutoRefresh: { enabled: true } })
    expect(res.failed).toBe(1)
    expect(res.refreshed).toBe(0)
    // Still stamped, so a permanently broken repo cannot spin every tick.
    const row = (await db.all(
      sql`SELECT last_auto_refresh_at AS a FROM cached_repos WHERE id='gone'`,
    )) as Array<{ a: number | null }>
    expect(row[0]?.a).not.toBeNull()
  })

  test('nothing due ⟹ no writes at all', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, [{ id: 'fresh', fetchedAt: NOW - DAY, autoRefreshAt: Date.now() }])
    const res = await refreshDueRepos(db, { submoduleAutoRefresh: { enabled: true } })
    expect(res).toEqual({ refreshed: 0, failed: 0 })
  })
})

describe('RFC-210 background refresh — loop contract', () => {
  test('returns a stop handle and does not fire synchronously', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    let ticks = 0
    const loop = startSubmoduleRefreshLoop(
      db,
      () => {
        ticks += 1
        return { submoduleAutoRefresh: { enabled: false } }
      },
      50,
    )
    expect(ticks).toBe(0) // no eager first run — matches gc/eventsArchive
    await new Promise((r) => setTimeout(r, 120))
    expect(ticks).toBeGreaterThan(0)
    loop.stop()
    const after = ticks
    await new Promise((r) => setTimeout(r, 120))
    expect(ticks).toBe(after) // stop() really stops it
  })
})
