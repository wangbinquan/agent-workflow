// RFC-024 — management surface for `cached_repos` (the persistent mirrors of
// remote Git URLs the user has launched tasks against).
//
// GET    /api/cached-repos              list all
// POST   /api/cached-repos/:id/refresh  manual `git fetch --all --prune --tags`
// DELETE /api/cached-repos/:id?force=1  remove cache dir + DB row (force=1 skips
//                                       the "referenced by N tasks" guard)
//
// RFC-370 §10 V17: where the selected mirrors register by verifying the remote
// (hosted), a refresh verifies it again and a batch import registers each URL
// without cloning; a standalone daemon keeps cloning and fetching its mirrors.

import {
  CachedRepoPageQuerySchema,
  RetryBatchImportRowRequestSchema,
  StartBatchImportRequestSchema,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import type { CachedRepositoryOperations } from '@/modules/source-control/public/types'
import { registerRoute } from '@/routes/registry'
import { actorOf } from '@/auth/actor'
import { assertTokenDeleteConfirm, readDeleteBody } from '@/platform/http/deleteConfirm'
import { captureDeleteSnapshot } from '@/platform/http/deleteSnapshot'
import { NotFoundError, ValidationError } from '@/util/errors'
import { parseBoolQuery } from '@/util/http'

/** RFC-451: the operations, the selected mirrors and their settings come composed from source-control. */
export function mountCachedRepoRoutes(app: Hono, operations: CachedRepositoryOperations): void {
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
      // RFC-311 T28 / proposal §5 C7:带任一分页参数 → O(页) 封套
      // `{items, nextCursor, facets}`;无参调用保持旧全量 `{items}` 形状
      // (7 个 repo picker 消费方 + 外部脚本零改动)。
      // 空串视同未传:`?q=`/`?limit=` 这类空值在客户端 buildUrl 里本就会被丢弃,
      // 服务端若当成"带参"处理,一个外部脚本拼出的空 q 就会从"全量"静默变成
      // "第一页 50 行"——C7 承诺的无参兼容会被这种边角形态绕过去。
      const param = (name: string): string | undefined => {
        const value = c.req.query(name)
        return value === undefined || value === '' ? undefined : value
      }
      const raw = {
        q: param('q'),
        view: param('view'),
        submodules: param('submodules'),
        autoRefresh: param('auto_refresh'),
        cursor: param('cursor'),
        limit: param('limit'),
      }
      if (Object.values(raw).every((v) => v === undefined)) {
        const items = await operations.list()
        return c.json({ items })
      }
      const parsed = CachedRepoPageQuerySchema.safeParse(raw)
      if (!parsed.success) {
        throw new ValidationError(
          'invalid_query',
          parsed.error.issues[0]?.message ?? 'invalid query',
        )
      }
      return c.json(await operations.page(parsed.data))
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
      // RFC-451: hosted mirrors verify the remote again; a standalone daemon fetches with the configured clone bound.
      return c.json(await operations.refresh(c.req.param('id')))
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
        const existing = (await operations.list()).find((r) => r.id === id)
        if (!existing) throw new NotFoundError('cached-repo-not-found', 'cached repo not found')
        assertTokenDeleteConfirm(
          await readDeleteBody(c),
          existing.urlRedacted,
          'repo',
          actor.source,
        )
        // AC-20 — the row is already in hand for the confirmation check, so the
        // snapshot costs nothing extra. `urlRedacted` is what the wire carries
        // (RFC-204 removed the plaintext url), so nothing sensitive is stored.
        captureDeleteSnapshot(c, actor, existing)
      }
      // `cached-repo-has-references` propagates to the central errorHandler, which renders the 409 with
      // its details (count + urlRedacted + referencing groups).
      const r = await operations.remove(id, { force: isForce })
      return c.json({ ok: true, deletedLocalPath: r.deletedLocalPath })
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
      // RFC-285 B6②：发起者归属（WS 升级门判定依据）。
      const snapshot = await operations.startBatchImport(parsed.data, {
        userId: actorOf(c).user.id,
      })
      return c.json(snapshot, 201)
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
      const snap = operations.batchSnapshot(batchId)
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
      return c.json(operations.retryBatchRow(batchId, rowId, body))
    },
  )
}
