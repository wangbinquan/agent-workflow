// RFC-210 G7 — periodic background refresh of cached repos and their submodules.
//
// Without it a cached mirror only ever advances when a task launches (the warm
// fetch on reuse) or a user clicks Refresh by hand. A repo nobody has launched
// against for a week is a week stale, and so are its submodules.
//
// Shape follows the established ticker pattern in this codebase (see
// eventsArchive / gc): a `{ stop }` handle, a re-entrancy flag so a slow tick
// never overlaps itself, `loadConfig()` per tick so settings changes apply
// without a daemon restart, and errors that are logged rather than thrown —
// a background refresh must never be able to take the daemon down.

import { and, eq, gte, isNotNull, isNull, lt, or } from 'drizzle-orm'
import type { Config } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { cachedRepos } from '@/db/schema'
import { refreshCachedRepo } from '@/services/gitRepoCache'
import { createLogger } from '@/util/log'

const log = createLogger('submodule-refresh')

const HOUR_MS = 60 * 60 * 1000
export const DEFAULT_REFRESH_INTERVAL_MS = 6 * HOUR_MS
export const DEFAULT_ONLY_RECENT_DAYS = 30

type RefreshConfig = Pick<Config, 'submoduleAutoRefresh'>

/**
 * Repos due for a background refresh.
 *
 * Two conditions, both deliberate:
 *  - never auto-refreshed, or last auto-refresh older than one interval;
 *  - fetched by a USER path (task-launch warm fetch or manual refresh) within
 *    `onlyRecentDays`.
 *
 * The second is what keeps this from being a network storm: a machine can
 * accumulate dozens of mirrors from one-off experiments, and re-fetching those
 * forever serves nobody. Critically, the background loop itself does NOT advance
 * `last_fetched_at` (`refreshCachedRepo(..., { touchRecency: false })`) — if it
 * did, every tick would renew this very recency gate and an abandoned mirror
 * would never age out. The loop's cadence lives in `last_auto_refresh_at`, which
 * is tracked separately precisely so it can be reasoned about independently of
 * user traffic.
 */
export async function selectDueRepos(
  db: DbClient,
  opts: { now: number; intervalMs: number; onlyRecentDays: number },
): Promise<Array<{ id: string; urlRedacted: string | null }>> {
  const dueBefore = opts.now - opts.intervalMs
  const freshAfter = opts.now - opts.onlyRecentDays * 24 * HOUR_MS
  const rows = await db
    .select({ id: cachedRepos.id, urlRedacted: cachedRepos.urlRedacted })
    .from(cachedRepos)
    .where(
      and(
        gte(cachedRepos.lastFetchedAt, freshAfter),
        or(isNull(cachedRepos.lastAutoRefreshAt), lt(cachedRepos.lastAutoRefreshAt, dueBefore)),
        isNotNull(cachedRepos.localPath),
      ),
    )
  return rows
}

/**
 * One tick: refresh every due repo, serially.
 *
 * Serial on purpose. `refreshCachedRepo` takes the per-URL lock, so parallel
 * ticks would mostly queue behind each other anyway, and a background job has no
 * business competing with task launches for network and disk.
 *
 * A failing repo is logged and skipped — one unreachable remote must not stop
 * the rest of the sweep.
 */
export async function refreshDueRepos(
  db: DbClient,
  cfg: RefreshConfig,
  opts?: { now?: () => number; appHome?: string },
): Promise<{ refreshed: number; failed: number }> {
  const enabled = cfg.submoduleAutoRefresh?.enabled ?? true
  if (!enabled) return { refreshed: 0, failed: 0 }
  const now = opts?.now ?? Date.now
  const intervalMs = cfg.submoduleAutoRefresh?.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
  const onlyRecentDays = cfg.submoduleAutoRefresh?.onlyRecentDays ?? DEFAULT_ONLY_RECENT_DAYS

  const due = await selectDueRepos(db, { now: now(), intervalMs, onlyRecentDays })
  if (due.length === 0) return { refreshed: 0, failed: 0 }

  let refreshed = 0
  let failed = 0
  for (const repo of due) {
    try {
      const res = await refreshCachedRepo(
        // Thread the tick's clock through so every timestamp in one sweep — the
        // selection cut-off, last_auto_refresh_at, and refreshCachedRepo's own
        // internal `now` — shares a single source. In production `now` is
        // Date.now, so behaviour is unchanged; tests can drive time deterministically.
        { db, now, ...(opts?.appHome !== undefined ? { appHome: opts.appHome } : {}) },
        repo.id,
        // RFC-210 G7 self-renewal fix: advance the mirror WITHOUT touching
        // last_fetched_at, else this loop keeps its own selection alive forever
        // (selectDueRepos gates on last_fetched_at) and abandoned mirrors never
        // age out. The loop's own cadence lives in last_auto_refresh_at.
        { touchRecency: false },
      )
      refreshed += 1
      if (!res.submoduleSyncOk) {
        // Not a failure of the refresh itself — the parent fetch succeeded (the
        // submodule telemetry columns advance regardless; only last_fetched_at
        // is held back). Surfaced through the repo row's existing submodule
        // telemetry columns, which /repos already renders.
        log.warn('submodule sync failed during auto-refresh', {
          repoId: repo.id,
          url: repo.urlRedacted ?? '',
          error: res.submoduleSyncError ?? '',
        })
      }
    } catch (err) {
      failed += 1
      log.warn('auto-refresh failed', {
        repoId: repo.id,
        url: repo.urlRedacted ?? '',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  // Stamp AFTER the sweep so a crash mid-sweep leaves the untouched repos due.
  await stampRefreshed(
    db,
    due.map((r) => r.id),
    now(),
  )
  log.info('submodule auto-refresh tick', { due: due.length, refreshed, failed })
  return { refreshed, failed }
}

async function stampRefreshed(db: DbClient, ids: string[], at: number): Promise<void> {
  for (const id of ids) {
    await db.update(cachedRepos).set({ lastAutoRefreshAt: at }).where(eq(cachedRepos.id, id))
  }
}

/**
 * Start the background refresh ticker. `loadConfig` runs each tick so a settings
 * change applies without restarting the daemon, matching the other tickers.
 */
export function startSubmoduleRefreshLoop(
  db: DbClient,
  loadConfig: () => RefreshConfig,
  intervalMs: number = HOUR_MS,
  appHome?: string,
): { stop: () => void } {
  let running = false
  const handle = setInterval(() => {
    if (running) return
    running = true
    refreshDueRepos(db, loadConfig(), appHome !== undefined ? { appHome } : {})
      .catch((err: unknown) => {
        log.error('submodule auto-refresh tick failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => {
        running = false
      })
  }, intervalMs)
  handle.unref?.()
  return { stop: () => clearInterval(handle) }
}
