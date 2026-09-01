// RFC-248/249 — 仓库组目录树的管理面。
//
// GET    /api/repo-groups              列表（含目录节点与展平仓数）
// POST   /api/repo-groups              建组（节点挂 URL 时现场导入缓存）
// GET    /api/repo-groups/:id          详情（显式 nodes 定义，URL 只出脱敏形态）
// GET    /api/repo-groups/:id/layout   展平预览（nodes + repos + 总数 + 深度）
// PUT    /api/repo-groups/:id          全量替换 nodes，version 自增
// DELETE /api/repo-groups/:id          ?force=1 摘除引用；同事务归档组记忆
//
// 权限（D5）：仓库组与 cached_repos 同类，**复用 `repos:*` 权限点**，不新增
// 授权矩阵行、不进 RFC-099 的 per-resource ACL。注意 `repos:update` 是本 RFC
// 由 RFC-248 引入的点——在此之前 repos 域没有任何 PUT/PATCH 路由。

import {
  CreateRepoGroupSchema,
  PreviewRepoGroupSchema,
  UpdateRepoGroupSchema,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf } from '@/auth/actor'
import { loadConfig } from '@/config'
import type { RepositoryWorkspaceStore } from '@/modules/source-control/public/operations'
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
import { ValidationError } from '@/util/errors'
import { parseBoolQuery } from '@/util/http'

export interface RepoGroupRouteDependencies {
  readonly configPath: string
}

function assertNoRetiredMembers(raw: unknown): void {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    !Array.isArray(raw) &&
    Object.prototype.hasOwnProperty.call(raw, 'members')
  ) {
    throw new ValidationError(
      'repo-group-members-retired',
      "'members' is retired; send the explicit directory tree in 'nodes'",
    )
  }
}

export function mountRepoGroupRoutes(
  app: Hono,
  deps: RepoGroupRouteDependencies,
  store: RepositoryWorkspaceStore,
): void {
  /** 建组 / 改组共用：URL→id 的现场导入要走缓存服务，超时沿用 git clone 配置。 */
  const cacheDeps = () => {
    const cfg = loadConfig(deps.configPath)
    return {
      store,
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
    async (c) => c.json({ items: await listRepoGroups(store) }),
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
      assertNoRetiredMembers(raw)
      const parsed = CreateRepoGroupSchema.safeParse(raw)
      if (!parsed.success) {
        throw new ValidationError('repo-group-invalid', parsed.error.message, {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const group = await createRepoGroup({ store, cache: cacheDeps() }, parsed.data, actor.user.id)
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
    async (c) => c.json(await getRepoGroup(store, c.req.param('id'))),
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
      // 用 safeParse：编辑器每加一行都会先出现一个「还没选仓」的中间态，
      // `.parse()` 抛出的 ZodError 到中央 handler 会渲染成 **500**——把用户
      // 正常的输入过程报成服务端故障（实现门 P2）。
      const raw = (await c.req.json().catch(() => null)) as unknown
      assertNoRetiredMembers(raw)
      const parsed = PreviewRepoGroupSchema.safeParse(raw)
      if (!parsed.success) {
        throw new ValidationError('repo-group-invalid', parsed.error.message, {
          issues: parsed.error.issues,
        })
      }
      return c.json(await previewRepoGroupLayout(store, parsed.data))
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
    async (c) => c.json(await getRepoGroupLayoutResponse(store, c.req.param('id'))),
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
      assertNoRetiredMembers(raw)
      const parsed = UpdateRepoGroupSchema.safeParse(raw)
      if (!parsed.success) {
        throw new ValidationError('repo-group-invalid', parsed.error.message, {
          issues: parsed.error.issues,
        })
      }
      // RFC-248: OCC 栅栏必须真的传下去——只在 schema 里留个字段而不转发，
      // 服务层那道 409 永远不会触发（实现门 P1）。
      const { expectedVersion, ...body } = parsed.data
      const group = await updateRepoGroup(
        { store, cache: cacheDeps() },
        c.req.param('id'),
        body,
        expectedVersion,
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
        const existing = await getRepoGroup(store, id)
        assertTokenDeleteConfirm(await readDeleteBody(c), existing.name, 'repo', actor.source)
      }
      const r = await deleteRepoGroup(store, id, { force })
      return c.json({ ok: true as const, ...r })
    },
  )
}
