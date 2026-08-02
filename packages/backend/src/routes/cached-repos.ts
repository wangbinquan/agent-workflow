// RFC-024 — management surface for `cached_repos` (the persistent mirrors of
// remote Git URLs the user has launched tasks against).
//
// GET    /api/cached-repos              list all
// POST   /api/cached-repos/:id/refresh  manual `git fetch --all --prune --tags`
// DELETE /api/cached-repos/:id?force=1  remove cache dir + DB row (force=1 skips
//                                       the "referenced by N tasks" guard)

import {
  RetryBatchImportRowRequestSchema,
  StartBatchImportRequestSchema,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { actorOf } from '@/auth/actor'
import { assertTokenDeleteConfirm, readDeleteBody } from '@/services/deleteConfirm'
import { loadConfig } from '@/config'
import {
  CachedRepoHasReferencesError,
  deleteCachedRepo,
  listCachedRepos,
  refreshCachedRepo,
} from '@/services/gitRepoCache'
import { getBatchSnapshot, retryBatchRow, startBatchImport } from '@/services/repoBatchImport'
import { NotFoundError, ValidationError } from '@/util/errors'
import { parseBoolQuery } from '@/util/http'

export function mountCachedRepoRoutes(app: Hono, deps: AppDeps): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/cached-repos',
      permissions: ['repos:read'],
      tokenAccess: 'allow',
      summary: 'List cached repo mirrors',
    },
    async (c) => {
      const items = await listCachedRepos(deps.db)
      return c.json({ items })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/cached-repos/:id/refresh',
      permissions: ['repos:execute'],
      tokenAccess: 'allow',
      summary: 'Refresh a cached mirror',
    },
    async (c) => {
      const id = c.req.param('id')
      // RFC-208: `gitCloneTimeoutMs` was dead config — the schema accepted it but
      // nothing ever passed it to `cloneTimeoutMs`, so an operator tightening the
      // window had no effect. Manual refresh shells out to `git fetch` against a
      // remote host, which is exactly the call that needs a bound.
      const cfg = loadConfig(deps.configPath)
      const r = await refreshCachedRepo(
        {
          db: deps.db,
          ...(cfg.gitCloneTimeoutMs ? { cloneTimeoutMs: cfg.gitCloneTimeoutMs } : {}),
        },
        id,
      )
      return c.json(r)
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/cached-repos/:id',
      permissions: ['repos:delete'],
      tokenAccess: 'allow',
      summary: 'Delete a cached mirror',
    },
    async (c) => {
      const id = c.req.param('id')
      const isForce = parseBoolQuery(c, 'force', { default: false })
      // RFC-247 T20 — a token names the mirror it is deleting. A cached repo has
      // no `name`; its visible identity is `urlRedacted`, which is also what
      // `resource_read` hands back, so that is what gets echoed. The row is
      // looked up first so a stale id answers 404 rather than a confirm error —
      // the same ordering the other seven delete routes use.
      const actor = actorOf(c)
      if (actor.source === 'pat') {
        const existing = (await listCachedRepos(deps.db)).find((r) => r.id === id)
        if (!existing) throw new NotFoundError('cached-repo-not-found', 'cached repo not found')
        assertTokenDeleteConfirm(
          await readDeleteBody(c),
          existing.urlRedacted,
          'repo',
          actor.source,
        )
      }
      try {
        const r = await deleteCachedRepo({ db: deps.db }, id, { force: isForce })
        return c.json({ ok: true, deletedLocalPath: r.deletedLocalPath })
      } catch (err) {
        if (err instanceof CachedRepoHasReferencesError) {
          // Re-throw so the central errorHandler renders the 409 with details
          // (count + urlRedacted). Default Hono handler picks up status/code/details.
          throw err
        }
        throw err
      }
    },
  )

  // RFC-033 — batch import surface. Returns the synchronous snapshot; the
  // actual clones run in the background and stream progress via
  // /ws/repo-imports/{batchId}.
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/cached-repos/batch-import',
      permissions: ['repos:create'],
      tokenAccess: 'allow',
      summary: 'Batch-import repo mirrors',
    },
    async (c) => {
      const raw = (await c.req.json().catch(() => null)) as unknown
      const parsed = StartBatchImportRequestSchema.safeParse(raw)
      if (!parsed.success) {
        throw new ValidationError('batch-request-invalid', parsed.error.message, {
          issues: parsed.error.issues,
        })
      }
      const cfg = loadConfig(deps.configPath)
      const result = startBatchImport(
        {
          db: deps.db,
          concurrency: cfg.repoBatchImportConcurrency,
          retentionMs: cfg.repoBatchImportRetentionMs,
        },
        parsed.data,
      )
      return c.json(result.snapshot, 201)
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/cached-repos/imports/:batchId',
      permissions: ['repos:read'],
      tokenAccess: 'allow',
      summary: 'Batch import progress',
    },
    (c) => {
      const batchId = c.req.param('batchId')
      const snap = getBatchSnapshot(batchId)
      if (snap === null) {
        throw new NotFoundError('batch-not-found', `batch ${batchId} not found or expired`)
      }
      return c.json(snap)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/cached-repos/imports/:batchId/rows/:rowId/retry',
      permissions: ['repos:execute'],
      tokenAccess: 'allow',
      summary: 'Retry one batch-import row',
    },
    async (c) => {
      const batchId = c.req.param('batchId')
      const rowId = c.req.param('rowId')
      const hasBody = (c.req.header('content-length') ?? '0') !== '0'
      let body: { url?: string } = {}
      if (hasBody) {
        const raw = (await c.req.json().catch(() => null)) as unknown
        const parsed = RetryBatchImportRowRequestSchema.safeParse(raw ?? {})
        if (!parsed.success) {
          throw new ValidationError('retry-request-invalid', parsed.error.message, {
            issues: parsed.error.issues,
          })
        }
        body = parsed.data
      }
      const snap = retryBatchRow({ db: deps.db }, batchId, rowId, body)
      return c.json(snap)
    },
  )
}
