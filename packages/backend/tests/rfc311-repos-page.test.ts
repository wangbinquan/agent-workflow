// RFC-311 T28 — /api/cached-repos O(页) 分页的语义等价与形状锁。
//
// 快路径(listCachedReposPage,SQL 下推)必须与旧全量管线(listCachedRepos +
// 前端 filterRepoOperations/repoOperationsFacets 的 JS 语义)逐 id 等价:
// 本文件用 108 组过滤组合 × limit=3 逐页走到底做 oracle 对比。tie(相同
// last_fetched_at)的次序旧管线未定义,canonical 定为 (ts DESC, id DESC)。
//
// C7(proposal §5):无参 GET 保持旧 `{items}` 全量形状;带任一参数才切分页
// 封套——两种形状都在 HTTP 层锁死。

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { CachedRepo } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos, scheduledTasks, taskRepos, tasks, users, workflows } from '../src/db/schema'
import { listCachedRepos, listCachedReposPage } from '../src/services/gitRepoCache'
import { createApp } from '../src/server'
import { ValidationError } from '../src/util/errors'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const T0 = 1_700_000_000_000

interface RepoSeed {
  id: string
  urlRedacted: string
  localPath: string
  defaultBranch: string | null
  lastFetchedAt: number
  lastAutoRefreshAt: number | null
  hasSubmodules: boolean | null
  lastSubmoduleSyncOk: boolean | null
}

function seed(db: DbClient): RepoSeed[] {
  // 12 仓覆盖:submodule true/false/null × sync ok/fail × autoRefresh 有/无 ×
  // q 命中面(urlRedacted/localPath/defaultBranch)× lastFetchedAt tie。
  const repos: RepoSeed[] = [
    r('r01', 'git@github.com:acme/gamma-api.git', '/repos/a1', 'main', T0 + 11_000, T0, true, true),
    r(
      'r02',
      'git@github.com:acme/beta.git',
      '/repos/delta-cache',
      'main',
      T0 + 10_000,
      null,
      true,
      false,
    ),
    r(
      'r03',
      'git@github.com:acme/web.git',
      '/repos/a3',
      'feat/epsilon',
      T0 + 9_000,
      T0,
      false,
      null,
    ),
    r('r04', 'git@github.com:acme/tools.git', '/repos/a4', null, T0 + 8_000, null, null, null),
    // tie 组:三行同一 lastFetchedAt,靠 id DESC 定序。
    r('r05', 'git@github.com:acme/tie-a.git', '/repos/a5', 'main', T0 + 7_000, T0, true, false),
    r('r06', 'git@github.com:acme/tie-b.git', '/repos/a6', 'main', T0 + 7_000, null, false, null),
    r('r07', 'git@github.com:acme/tie-c.git', '/repos/a7', 'dev', T0 + 7_000, T0, null, null),
    r(
      'r08',
      'git@github.com:acme/gamma-lib.git',
      '/repos/a8',
      'main',
      T0 + 6_000,
      null,
      true,
      true,
    ),
    r('r09', 'git@github.com:acme/ops.git', '/repos/a9', 'main', T0 + 5_000, T0, false, null),
    r('r10', 'git@github.com:acme/data.git', '/repos/a10', 'main', T0 + 4_000, null, true, false),
    r('r11', 'git@github.com:acme/edge.git', '/repos/a11', 'main', T0 + 3_000, T0, null, null),
    r('r12', 'git@github.com:acme/never-fetched.git', '/repos/a12', 'main', 0, null, null, null),
  ]
  for (const row of repos) {
    db.insert(cachedRepos)
      .values({
        id: row.id,
        urlHash: row.id.padEnd(8, '0'),
        urlRedacted: row.urlRedacted,
        localPath: row.localPath,
        defaultBranch: row.defaultBranch,
        lastFetchedAt: row.lastFetchedAt,
        createdAt: T0,
        lastAutoRefreshAt: row.lastAutoRefreshAt,
        hasSubmodules: row.hasSubmodules,
        lastSubmoduleSyncOk: row.lastSubmoduleSyncOk,
        lastSubmoduleSyncError: row.lastSubmoduleSyncOk === false ? 'boom' : null,
      })
      .run()
  }

  // 引用面三源:
  //   r01 ← task_repos 两个不同 task(计 2)+ 下面 tD 的 task_repos 行(计 1)= 3
  //   r05 ← 仅 tasks.cachedRepoId(无 task_repos 行)(计 1)
  //   r08 ← 仅 scheduled payload 提及(计 1)
  //   r02 ← tasks.cachedRepoId 但该 task 有 task_repos 行(指向 r01)→ tasks 腿
  //         不计(锁 NOT EXISTS 细节),r02 保持 unused。
  db.insert(users)
    .values({
      id: 'u1',
      username: 'u1',
      displayName: 'u1',
      role: 'admin',
      createdAt: T0,
      updatedAt: T0,
    })
    .run()
  db.insert(workflows)
    .values({ id: 'wf1', name: 'wf', definition: '{"nodes":[],"edges":[],"inputs":[]}' })
    .run()
  const mkTask = (id: string, cachedRepoId: string | null): void => {
    db.insert(tasks)
      .values({
        id,
        name: id,
        workflowId: 'wf1',
        workflowSnapshot: '{}',
        repoPath: `/tmp/${id}`,
        worktreePath: `/tmp/wt-${id}`,
        baseBranch: 'main',
        branch: `agent-workflow/${id}`,
        status: 'done',
        inputs: '{}',
        startedAt: T0,
        finishedAt: T0 + 1,
        runningMs: 0,
        ownerUserId: 'u1',
        launchOrigin: 'manual',
        cachedRepoId,
      })
      .run()
  }
  mkTask('tA', null)
  mkTask('tB', null)
  mkTask('tC', 'r05')
  mkTask('tD', 'r02')
  const mkTaskRepo = (taskId: string, cachedRepoId: string): void => {
    db.insert(taskRepos)
      .values({
        taskId,
        repoIndex: 0,
        repoPath: `/tmp/${taskId}`,
        worktreePath: `/tmp/wt-${taskId}`,
        cachedRepoId,
        branch: `agent-workflow/${taskId}`,
      })
      .run()
  }
  mkTaskRepo('tA', 'r01')
  mkTaskRepo('tB', 'r01')
  mkTaskRepo('tD', 'r01')
  db.insert(scheduledTasks)
    .values({
      id: ulid(),
      name: 'sched-1',
      ownerUserId: 'u1',
      launchKind: 'workflow',
      launchPayload: JSON.stringify({ body: { repos: [{ cachedRepoId: 'r08' }] } }),
      scheduleSpec: '{}',
      createdAt: T0,
      updatedAt: T0,
    })
    .run()
  return repos
}

function r(
  id: string,
  urlRedacted: string,
  localPath: string,
  defaultBranch: string | null,
  lastFetchedAt: number,
  lastAutoRefreshAt: number | null,
  hasSubmodules: boolean | null,
  lastSubmoduleSyncOk: boolean | null,
): RepoSeed {
  return {
    id,
    urlRedacted,
    localPath,
    defaultBranch,
    lastFetchedAt,
    lastAutoRefreshAt,
    hasSubmodules,
    lastSubmoduleSyncOk,
  }
}

// --- JS 语义镜像(与前端 lib/operations-filters.ts 逐行对齐) ---------------
type View = 'all' | 'referenced' | 'attention' | 'unused'
type Subs = 'all' | 'with' | 'without'
type Auto = 'all' | 'refreshed' | 'never'

function needsAttention(row: CachedRepo): boolean {
  return row.hasSubmodules === true && row.lastSubmoduleSyncOk === false
}
function jsFilter(
  items: CachedRepo[],
  f: { view: View; q: string; submodules: Subs; autoRefresh: Auto },
): CachedRepo[] {
  const query = f.q.trim().toLowerCase()
  return items.filter((row) => {
    if (f.view === 'referenced' && !(row.referencingTaskCount > 0)) return false
    if (f.view === 'attention' && !needsAttention(row)) return false
    if (f.view === 'unused' && row.referencingTaskCount !== 0) return false
    if (
      f.submodules !== 'all' &&
      (f.submodules === 'with' ? row.hasSubmodules !== true : row.hasSubmodules !== false)
    ) {
      return false
    }
    if (
      f.autoRefresh !== 'all' &&
      (f.autoRefresh === 'refreshed'
        ? row.lastAutoRefreshAt === null
        : row.lastAutoRefreshAt !== null)
    ) {
      return false
    }
    if (query === '') return true
    return [row.urlRedacted, row.localPath, row.defaultBranch].some(
      (v) => v?.toLowerCase().includes(query) === true,
    )
  })
}

describe('RFC-311 T28 — listCachedReposPage oracle', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    seed(db)
  })

  test('every filter combination pages to the same ids/counts as the legacy JS pipeline', async () => {
    const full = await listCachedRepos(db)
    // canonical 全序:(lastFetchedAt DESC, id DESC)。旧管线对 tie 未定序,
    // oracle 端显式重排后对比。ISO 字符串比较与 epoch 数值比较同序。
    const reference = [...full].sort((a, b) =>
      a.lastFetchedAt === b.lastFetchedAt
        ? b.id.localeCompare(a.id)
        : b.lastFetchedAt.localeCompare(a.lastFetchedAt),
    )
    const views: View[] = ['all', 'referenced', 'attention', 'unused']
    const subs: Subs[] = ['all', 'with', 'without']
    const autos: Auto[] = ['all', 'refreshed', 'never']
    const queries = ['', 'gamma', 'DELTA', 'epsilon', 'zzz-no-match']
    let combos = 0
    for (const view of views) {
      for (const submodules of subs) {
        for (const autoRefresh of autos) {
          for (const q of queries) {
            combos += 1
            const expected = jsFilter(reference, { view, q, submodules, autoRefresh })
            const got: CachedRepo[] = []
            let cursor: string | undefined
            let facetsSeen: Record<string, number> | undefined
            for (let hop = 0; hop < 20; hop += 1) {
              const page = await listCachedReposPage(db, {
                view,
                q,
                submodules,
                autoRefresh,
                limit: 3,
                ...(cursor === undefined ? {} : { cursor }),
              })
              got.push(...page.items)
              facetsSeen = page.facets
              if (page.nextCursor === null) break
              cursor = page.nextCursor
            }
            const label = `${view}/${submodules}/${autoRefresh}/q=${q}`
            expect(
              got.map((x) => x.id),
              label,
            ).toEqual(expected.map((x) => x.id))
            expect(
              got.map((x) => x.referencingTaskCount),
              label,
            ).toEqual(expected.map((x) => x.referencingTaskCount))
            // facets 恒等于全量视角(不随过滤变化)。
            expect(facetsSeen, label).toEqual({
              all: full.length,
              referenced: full.filter((x) => x.referencingTaskCount > 0).length,
              attention: full.filter(needsAttention).length,
              unused: full.filter((x) => x.referencingTaskCount === 0).length,
            })
          }
        }
      }
    }
    expect(combos).toBe(180)
    // seed 的引用面预期本身也锁一遍(防 fixture 退化成全 0):
    const byId = new Map(full.map((x) => [x.id, x.referencingTaskCount]))
    expect(byId.get('r01')).toBe(3)
    expect(byId.get('r05')).toBe(1)
    expect(byId.get('r08')).toBe(1)
    expect(byId.get('r02')).toBe(0)
  })

  test('malformed cursor is rejected', async () => {
    await expect(listCachedReposPage(db, { cursor: 'not-a-cursor' })).rejects.toThrow(
      ValidationError,
    )
    await expect(listCachedReposPage(db, { cursor: '12.' })).rejects.toThrow(ValidationError)
  })

  test('page query drives the keyset index, not a full sort', () => {
    const detail = db
      .all<{ detail: string }>(
        sql.raw(
          'EXPLAIN QUERY PLAN SELECT * FROM cached_repos ORDER BY last_fetched_at DESC, id DESC LIMIT 4',
        ),
      )
      .map((row) => row.detail)
      .join('\n')
    expect(detail).toContain('idx_cached_repos_fetched_id')
    expect(detail).not.toContain('TEMP B-TREE')
  })
})

describe('RFC-311 T28 — /api/cached-repos C7 双形状', () => {
  let db: DbClient
  let app: Hono
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc311-repos-'))
    const appHome = join(tmp, 'home')
    mkdirSync(appHome, { recursive: true })
    process.env.AGENT_WORKFLOW_HOME = appHome
    db = createInMemoryDb(MIGRATIONS)
    seed(db)
    app = createApp({
      token: TOKEN,
      configPath: join(tmp, 'config.json'),
      opencodeVersion: '1.14.25',
      dbVersion: 17,
      db,
    })
  })

  async function get(path: string): Promise<Response> {
    return app.request(path, { headers: { Authorization: `Bearer ${TOKEN}` } })
  }

  test('no-arg call keeps the legacy full `{items}` shape (C7)', async () => {
    const res = await get('/api/cached-repos')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Array.isArray(body.items)).toBe(true)
    expect((body.items as unknown[]).length).toBe(12)
    expect('nextCursor' in body).toBe(false)
    expect('facets' in body).toBe(false)
  })

  test('any paging param switches to the `{items, nextCursor, facets}` envelope', async () => {
    const res = await get('/api/cached-repos?limit=5')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: Array<{ id: string }>
      nextCursor: string | null
      facets: Record<string, number>
    }
    expect(body.items.length).toBe(5)
    expect(typeof body.nextCursor).toBe('string')
    expect(body.facets.all).toBe(12)
    const res2 = await get(
      `/api/cached-repos?limit=5&cursor=${encodeURIComponent(body.nextCursor!)}`,
    )
    const body2 = (await res2.json()) as { items: Array<{ id: string }> }
    expect(body2.items[0]?.id).not.toBe(body.items[0]?.id)
  })

  test('empty-string params are treated as absent (C7 stays intact for `?q=`)', async () => {
    // 外部脚本拼出的空值不得把全量兼容面悄悄换成分页首页。
    const res = await get('/api/cached-repos?q=&limit=')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect((body.items as unknown[]).length).toBe(12)
    expect('nextCursor' in body).toBe(false)
  })

  test('invalid enum values are rejected with 422', async () => {
    expect((await get('/api/cached-repos?view=bogus')).status).toBe(422)
    expect((await get('/api/cached-repos?limit=0')).status).toBe(422)
    expect((await get('/api/cached-repos?limit=999')).status).toBe(422)
    expect((await get('/api/cached-repos?cursor=broken')).status).toBe(422)
  })
})
