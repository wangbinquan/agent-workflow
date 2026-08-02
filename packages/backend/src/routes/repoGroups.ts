// RFC-248 — 仓库组的管理面。
//
// GET    /api/repo-groups              列表（含成员数与展平仓数）
// POST   /api/repo-groups              建组（成员可给 URL，不在缓存里就现场导入）
// GET    /api/repo-groups/:id          详情（成员原始定义，URL 只出脱敏形态）
// GET    /api/repo-groups/:id/layout   展平预览（PlannedRepo[] + 总数 + 深度）
// PUT    /api/repo-groups/:id          全量替换成员，version 自增
// DELETE /api/repo-groups/:id          ?force=1 摘除引用；同事务归档组记忆
//
// 权限（D5）：仓库组与 cached_repos 同类，**复用 `repos:*` 权限点**，不新增
// 授权矩阵行、不进 RFC-099 的 per-resource ACL。注意 `repos:update` 是本 RFC
// 新引入的点——在此之前 repos 域没有任何 PUT/PATCH 路由。

import {
  CreateRepoGroupSchema,
  PreviewRepoGroupSchema,
  UpdateRepoGroupSchema,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf } from '@/auth/actor'
import { loadConfig } from '@/config'
import { registerRoute } from '@/routes/registry'
import { assertTokenDeleteConfirm, readDeleteBody } from '@/services/deleteConfirm'
import {
  createRepoGroup,
  deleteRepoGroup,
  getRepoGroup,
  getRepoGroupLayoutResponse,
  listRepoGroups,
  previewRepoGroupLayout,
  updateRepoGroup,
} from '@/services/repoGroup'
import type { AppDeps } from '@/server'
import { ValidationError } from '@/util/errors'
import { parseBoolQuery } from '@/util/http'

export function mountRepoGroupRoutes(app: Hono, deps: AppDeps): void {
  /** 建组 / 改组共用：URL→id 的现场导入要走缓存服务，超时沿用 git clone 配置。 */
  const cacheDeps = () => {
    const cfg = loadConfig(deps.configPath)
    return {
      db: deps.db,
      ...(cfg.gitCloneTimeoutMs ? { cloneTimeoutMs: cfg.gitCloneTimeoutMs } : {}),
    }
  }

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/repo-groups',
      permissions: ['repos:read'],
      tokenAccess: 'allow',
      summary: 'List repo groups',
    },
    (c) => c.json({ items: listRepoGroups(deps.db) }),
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/repo-groups',
      permissions: ['repos:create'],
      tokenAccess: 'allow',
      summary: 'Create a repo group',
    },
    async (c) => {
      const raw = (await c.req.json().catch(() => null)) as unknown
      const parsed = CreateRepoGroupSchema.safeParse(raw)
      if (!parsed.success) {
        throw new ValidationError('repo-group-invalid', parsed.error.message, {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const group = await createRepoGroup(
        { db: deps.db, cache: cacheDeps() },
        parsed.data,
        actor.user.id,
      )
      return c.json(group, 201)
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/repo-groups/:id',
      permissions: ['repos:read'],
      tokenAccess: 'allow',
      summary: 'Get a repo group',
    },
    (c) => c.json(getRepoGroup(deps.db, c.req.param('id'))),
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/repo-groups/preview',
      // 纯读：干跑展平，不导入任何仓、不落任何行。所以只要 read 就够——
      // 用 `repos:create` 反而会让「只能看」的用户在编辑器里连预览都拿不到。
      permissions: ['repos:read'],
      tokenAccess: 'allow',
      summary: 'Dry-run flatten an unsaved repo group definition',
    },
    async (c) => {
      const body = PreviewRepoGroupSchema.parse(await c.req.json())
      return c.json(previewRepoGroupLayout(deps.db, body))
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/repo-groups/:id/layout',
      permissions: ['repos:read'],
      tokenAccess: 'allow',
      summary: 'Preview the flattened layout of a repo group',
    },
    (c) => c.json(getRepoGroupLayoutResponse(deps.db, c.req.param('id'))),
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/repo-groups/:id',
      // RFC-248: `repos:update` 是本 RFC 新加的点——在此之前 repos 域没有任何
      // PUT/PATCH 路由，所以权限目录里没有它。它同时进了 MANAGER_EXTRA，否则
      // manager 能建组却改不了组（设计门 G4）。
      permissions: ['repos:update'],
      tokenAccess: 'allow',
      summary: 'Replace a repo group definition',
    },
    async (c) => {
      const raw = (await c.req.json().catch(() => null)) as unknown
      const parsed = UpdateRepoGroupSchema.safeParse(raw)
      if (!parsed.success) {
        throw new ValidationError('repo-group-invalid', parsed.error.message, {
          issues: parsed.error.issues,
        })
      }
      const group = await updateRepoGroup(
        { db: deps.db, cache: cacheDeps() },
        c.req.param('id'),
        parsed.data,
      )
      return c.json(group)
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/repo-groups/:id',
      permissions: ['repos:delete'],
      tokenAccess: 'allow',
      summary: 'Delete a repo group',
    },
    async (c) => {
      const id = c.req.param('id')
      const force = parseBoolQuery(c, 'force', { default: false })
      const actor = actorOf(c)
      if (actor.source === 'pat') {
        // RFC-247 T20 同款：令牌删除必须具名回显要删的东西。先查再确认，
        // 这样过期 id 回 404 而不是确认失败（与其它八条删除路由同序）。
        const existing = getRepoGroup(deps.db, id)
        assertTokenDeleteConfirm(await readDeleteBody(c), existing.name, 'repo', actor.source)
      }
      const r = deleteRepoGroup(deps.db, id, { force })
      return c.json({ ok: true as const, ...r })
    },
  )
}
