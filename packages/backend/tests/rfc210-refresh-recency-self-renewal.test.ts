// RFC-210 G7 self-renewal regression — locks the Codex impl-gate [medium]
// finding (design/RFC-210-recursive-submodule-isolation/codex-impl-gate-2026-07-22.md):
//
//   "onlyRecentDays 会被后台刷新自身续期，废弃仓永久产生网络流量
//    (services/submoduleRefresh.ts)"
//
// The recency gate in `selectDueRepos` reads `last_fetched_at` to decide whether
// a mirror is still worth auto-refreshing. But the auto-refresh loop calls
// `refreshCachedRepo`, which — before the fix — advanced `last_fetched_at` on
// EVERY successful fetch. So a mirror that entered the recency window once would
// have its own activity timestamp renewed each tick and never age out: the loop
// kept itself busy forever, contradicting the "no network storm from one-off
// mirrors" contract the loop's own doc promises.
//
// The existing rfc210-refresh-loop.test.ts could not catch this: it seeds fake
// `/tmp/...` paths, so `refreshCachedRepo` throws repo-cache-corrupt and takes
// the FAILED branch, which never touched `last_fetched_at` anyway. Reproducing
// the bug needs a mirror whose fetch actually SUCCEEDS — hence a real local
// bare repo as the "remote", the same fixture shape as git-repo-cache.test.ts.
//
// The fix: auto-refresh passes `refreshCachedRepo(..., { touchRecency: false })`
// so the objects advance while `last_fetched_at` is held. Manual refresh and the
// task-launch warm fetch (real user activity) still advance it.
//
// Two locks:
//  1. touchRecency contract — false holds last_fetched_at while still writing the
//     rest of the row; the default (true) advances it.
//  2. self-renewal across real ticks — an unused mirror ages out of the recency
//     window even though every tick between now and then fetched it successfully.
//     Mutation check: flip auto-refresh back to touchRecency:true (or drop the
//     arg) and test #2 goes red — the mirror stays due forever.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos } from '../src/db/schema'
import { refreshCachedRepo, resolveCachedRepo } from '@/services/gitRepoCache'
import { refreshDueRepos, selectDueRepos } from '@/services/submoduleRefresh'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${await new Response(proc.stderr).text()}`)
  }
}

/** A real local bare repo we can hand to resolveCachedRepo as `file://...`. */
async function buildFixtureRemote(): Promise<{ dir: string; url: string }> {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc210-recency-'))
  const working = join(root, 'src')
  mkdirSync(working, { recursive: true })
  await git(working, 'init', '-b', 'main', working)
  await git(working, '-C', working, 'config', 'user.email', 'aw-test@example.com')
  await git(working, '-C', working, 'config', 'user.name', 'AW Test')
  writeFileSync(join(working, 'README.md'), '# fixture\n', 'utf-8')
  await git(working, '-C', working, 'add', '.')
  await git(working, '-C', working, 'commit', '-m', 'init')
  const bare = join(root, 'remote.git')
  await git(root, 'clone', '--bare', working, bare)
  return { dir: root, url: `file://${bare}` }
}

describe('RFC-210 G7 — auto-refresh does not renew its own recency window', () => {
  let db: DbClient
  let appHome: string
  let remoteDir: string
  let remoteUrl: string
  let repoId: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc210-recency-home-'))
    const r = await buildFixtureRemote()
    remoteDir = r.dir
    remoteUrl = r.url
    // Cold-clone so there is a real, fetchable mirror on disk.
    const resolved = await resolveCachedRepo(
      { db, appHome, fetchOnReuse: false },
      { url: remoteUrl },
    )
    repoId = resolved.cached.id
    // Pin a known baseline: fetched at NOW, never auto-refreshed, and reset the
    // submodule telemetry to NULL so we can later prove the row WAS written.
    db.update(cachedRepos)
      .set({ lastFetchedAt: NOW, lastAutoRefreshAt: null, lastSubmoduleSyncOk: null })
      .where(eq(cachedRepos.id, repoId))
      .run()
  })

  afterEach(() => {
    for (const d of [appHome, remoteDir]) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* noop */
      }
    }
  })

  test('touchRecency:false holds last_fetched_at but still writes the rest of the row', async () => {
    // Auto-refresh path: fetch succeeds but recency is deliberately NOT renewed.
    const res = await refreshCachedRepo({ db, appHome, now: () => NOW + 5 * DAY }, repoId, {
      touchRecency: false,
    })
    expect(res.fetchOk).toBe(true)

    const [row] = (await db.all(
      sql`SELECT last_fetched_at AS f, last_submodule_sync_ok AS s FROM cached_repos WHERE id=${repoId}`,
    )) as Array<{ f: number; s: number | null }>
    // last_fetched_at is untouched...
    expect(row?.f).toBe(NOW)
    // ...but the fetch really ran: the submodule telemetry we NULLed came back.
    expect(row?.s).not.toBeNull()
  })

  test('default (manual refresh) advances last_fetched_at', async () => {
    const res = await refreshCachedRepo({ db, appHome, now: () => NOW + 5 * DAY }, repoId)
    expect(res.fetchOk).toBe(true)
    const [row] = (await db.all(
      sql`SELECT last_fetched_at AS f FROM cached_repos WHERE id=${repoId}`,
    )) as Array<{ f: number }>
    expect(row?.f).toBe(NOW + 5 * DAY)
  })

  test('an unused mirror ages out of the recency window across real auto-refresh ticks', async () => {
    // intervalMs is a short 1h so the "one interval since last auto-refresh" gate
    // always clears on a daily tick — leaving the 3-day RECENCY window as the sole
    // thing that can age the mirror out, which is exactly the finding under test.
    const HOUR = 60 * 60 * 1000
    const cfg = {
      submoduleAutoRefresh: { enabled: true, intervalMs: HOUR, onlyRecentDays: 3 },
    }
    // Tick the loop once per day. Because auto-refresh holds last_fetched_at at
    // NOW, the recency window (3 days) is measured from NOW and never slides.
    const outcomes: Array<{ day: number; refreshed: number; due: number }> = []
    for (let day = 0; day <= 5; day++) {
      const at = NOW + day * DAY + 1000
      const due = await selectDueRepos(db, { now: at, intervalMs: HOUR, onlyRecentDays: 3 })
      const res = await refreshDueRepos(db, cfg, { now: () => at, appHome })
      outcomes.push({ day, refreshed: res.refreshed, due: due.length })
    }

    // Days 0..2 are inside the 3-day recency window → the mirror is fetched.
    for (const day of [0, 1, 2]) {
      expect(outcomes[day]?.refreshed).toBe(1)
    }
    // By day 4+ the mirror is older than onlyRecentDays and drops out entirely —
    // this is exactly what self-renewal (bug) would have prevented.
    expect(outcomes[4]?.due).toBe(0)
    expect(outcomes[4]?.refreshed).toBe(0)
    expect(outcomes[5]?.due).toBe(0)
    expect(outcomes[5]?.refreshed).toBe(0)

    // And last_fetched_at is still exactly the user's baseline — proof the loop
    // never renewed it.
    const [row] = (await db.all(
      sql`SELECT last_fetched_at AS f FROM cached_repos WHERE id=${repoId}`,
    )) as Array<{ f: number }>
    expect(row?.f).toBe(NOW)
  })
})
