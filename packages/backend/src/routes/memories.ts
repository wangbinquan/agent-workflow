// RFC-041 — REST surface for the platform memory tables (PR1 scope).
//
//   GET    /api/memories               list + filter        memory:read
//   GET    /api/memories/:id           detail + supersede chain   memory:read
//   POST   /api/memories               admin manual create (status=candidate)  memory:approve
//   PATCH  /api/memories/:id           content-only in-place edit                memory:update
//   POST   /api/memories/:id/move      candidate scope move + OCC                memory:update
//   POST   /api/memories/:id/promote   admin approve / supersede / reject       memory:approve
//   POST   /api/memories/:id/archive   approved → archived                       memory:archive
//   POST   /api/memories/:id/unarchive archived → approved                       memory:archive
//   DELETE /api/memories/:id?confirm=true   hard delete                         memory:delete

import {
  MemoryCandidatePromoteSchema,
  MemoryCreateRequestSchema,
  MemoryFacetsQuerySchema,
  MemoryListFilterSchema,
  MemoryMoveRequestSchema,
  MemoryPatchRequestSchema,
  MemoryScopeSchema,
  MemoryStatusSchema,
  MemoryTagModeSchema,
  aggregateTagFacets,
  normalizeTagList,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { hasResourceAclBypass } from '@/services/resourceAcl'
import { captureDeleteSnapshot } from '@/services/tokenAudit'
import { assertTokenDeleteConfirm, readDeleteBody } from '@/services/deleteConfirm'
import { actorOf } from '@/auth/actor'
import {
  archiveMemory,
  createManualCandidate,
  deleteMemory,
  getMemoryById,
  listMemories,
  moveMemory,
  annotateMemoryManageRights,
  canManageMemory,
  canViewMemory,
  filterMemoriesByScopeVisibility,
  patchMemory,
  promoteCandidate,
  toSummary,
  unarchiveMemory,
  type MemoryScopeRef,
} from '@/services/memory'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { parseBoolQuery } from '@/util/http'
import type { DirectCommandContextFactory } from '@/modules/identity-access/public/participants'

/**
 * RFC-099 (D12) — load + gate one memory row for a management operation:
 * invisible → 404 (existence isolation); visible but not the scope-resource
 * owner / ACL-bypass actor → 403. Returns the loaded row bundle for the handler.
 */
async function loadManagedMemory(deps: AppDeps, c: Parameters<typeof actorOf>[0], id: string) {
  const found = await getMemoryById(deps.db, id)
  if (found === null) throw new NotFoundError('memory-not-found', `memory ${id} not found`)
  const actor = actorOf(c)
  const scope: MemoryScopeRef = {
    scopeType: found.memory.scopeType,
    scopeId: found.memory.scopeId,
  }
  if (!(await canViewMemory(deps.db, actor, scope))) {
    throw new NotFoundError('memory-not-found', `memory ${id} not found`)
  }
  if (!(await canManageMemory(deps.db, actor, scope))) {
    throw new ForbiddenError(
      'forbidden',
      'only the scoped resource owner or an actor with resource-acl:bypass can manage this memory',
    )
  }
  return found
}

interface MemoryRouteIdentityAccess {
  readonly contexts: DirectCommandContextFactory
}

export function mountMemoryRoutes(
  app: Hono,
  deps: AppDeps,
  identityAccess: MemoryRouteIdentityAccess,
): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/memories',
      permissions: ['memory:read'],
      tokenAccess: 'allow',
      summary: 'List memories',
    },
    async (c) => {
      const raw = {
        status: c.req.query('status'),
        scopeType: c.req.query('scopeType'),
        scopeId: c.req.query('scopeId'),
        search: c.req.query('search'),
        tag: c.req.query('tag'),
        tagMode: c.req.query('tagMode'),
      }
      // Pre-parse each known field so we surface 422 with field name when the
      // caller sends e.g. ?status=bogus rather than dropping silently.
      const filter: Record<string, unknown> = {}
      if (raw.status !== undefined) {
        const r = MemoryStatusSchema.safeParse(raw.status)
        if (!r.success) throw new ValidationError('invalid-filter', `invalid status: ${raw.status}`)
        filter.status = r.data
      }
      if (raw.scopeType !== undefined) {
        const r = MemoryScopeSchema.safeParse(raw.scopeType)
        if (!r.success)
          throw new ValidationError('invalid-filter', `invalid scopeType: ${raw.scopeType}`)
        filter.scopeType = r.data
      }
      if (raw.scopeId !== undefined && raw.scopeId !== '') filter.scopeId = raw.scopeId
      if (raw.search !== undefined && raw.search.trim() !== '') filter.search = raw.search.trim()
      if (raw.tag !== undefined && raw.tag !== '') filter.tag = raw.tag
      // RFC-327: `?tags=a,b` 与重复 `?tags=a&tags=b` 都收，归一成一个保序去重数组。
      // 空串等于没给（`?tags=` 不该变成一条 min(1) 校验红）。
      const tags = normalizeTagList(c.req.queries('tags')?.flatMap((v) => v.split(',')) ?? [])
      if (tags.length > 0) filter.tags = tags
      if (raw.tagMode !== undefined && raw.tagMode !== '') {
        const r = MemoryTagModeSchema.safeParse(raw.tagMode)
        if (!r.success)
          throw new ValidationError('invalid-filter', `invalid tagMode: ${raw.tagMode}`)
        filter.tagMode = r.data
      }
      const parsed = MemoryListFilterSchema.safeParse(filter)
      if (!parsed.success) {
        throw new ValidationError(
          'invalid-filter',
          'invalid query parameters',
          parsed.error.format(),
        )
      }
      // `?include=body` widens the row to full Memory (with bodyMd /
      // sourceKind / sourceEventId / supersedesId) for the approval queue, which
      // needs to render the candidate body for admins to actually approve.
      const includeRaw = c.req.query('include')
      if (includeRaw !== undefined && includeRaw !== 'body') {
        throw new ValidationError('invalid-filter', `invalid include: ${includeRaw}`)
      }
      // RFC-099 (D12): agent/workflow-scoped rows only for viewers of that resource.
      const actor = actorOf(c)
      // RFC-285 B7（Q4 拍板，E12）：candidate 状态是**未经人审的蒸馏产物**（含
      // body）——读面收紧为仅持有 `resource-acl:bypass` 的操作者，与 distill 详情门
      // （E8）同一威胁模型。人审发布（approved）后才进入全员读面。两读法
      // （含 body / 不含 body）同收。
      const dropCandidates = <T extends { status: string }>(rows: T[]): T[] =>
        hasResourceAclBypass(actor) ? rows : rows.filter((r) => r.status !== 'candidate')
      if (includeRaw === 'body') {
        const items = await listMemories(deps.db, parsed.data, { includeBody: true })
        const visible = await filterMemoriesByScopeVisibility(deps.db, actor, items)
        return c.json({
          items: await annotateMemoryManageRights(deps.db, actor, dropCandidates(visible)),
        })
      }
      const items = await listMemories(deps.db, parsed.data)
      const visible = await filterMemoriesByScopeVisibility(deps.db, actor, items)
      return c.json({
        items: await annotateMemoryManageRights(deps.db, actor, dropCandidates(visible)),
      })
    },
  )

  // RFC-327 —— 标签 facets。挂在 `/api/memories/:id` **之前**：注册顺序决定匹配，
  // 反过来 `facets` 会被当成一个 id 走进详情路由并 404。
  //
  // 统计面**恰好是调用者的可见面**：先按同一条 ACL 链路（scope 可见性 + candidate
  // 收紧）滤过，再聚合——否则标签名本身就会泄露私有 scope 里有哪些记忆存在。
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/memories/facets',
      permissions: ['memory:read'],
      tokenAccess: 'allow',
      summary: 'List memory tag facets',
    },
    async (c) => {
      const raw = {
        status: c.req.query('status'),
        scopeType: c.req.query('scopeType'),
        scopeId: c.req.query('scopeId'),
      }
      const query: Record<string, unknown> = {}
      if (raw.status !== undefined && raw.status !== '') {
        const r = MemoryStatusSchema.safeParse(raw.status)
        if (!r.success) throw new ValidationError('invalid-filter', `invalid status: ${raw.status}`)
        query.status = r.data
      }
      if (raw.scopeType !== undefined && raw.scopeType !== '') {
        const r = MemoryScopeSchema.safeParse(raw.scopeType)
        if (!r.success)
          throw new ValidationError('invalid-filter', `invalid scopeType: ${raw.scopeType}`)
        query.scopeType = r.data
      }
      if (raw.scopeId !== undefined && raw.scopeId !== '') query.scopeId = raw.scopeId
      const parsed = MemoryFacetsQuerySchema.safeParse(query)
      if (!parsed.success) {
        throw new ValidationError(
          'invalid-filter',
          'invalid query parameters',
          parsed.error.format(),
        )
      }
      // 缺省 approved：与注入链路（services/memoryInject.ts 只取 approved）一致——
      // 一个外部代理问「有哪些标签」，想要的是能被注入的事实，不是未审的候选。
      const status = parsed.data.status ?? 'approved'
      const actor = actorOf(c)
      const rows = await listMemories(deps.db, { ...parsed.data, status })
      const visible = await filterMemoriesByScopeVisibility(deps.db, actor, rows)
      const items =
        status === 'candidate' && !hasResourceAclBypass(actor)
          ? visible.filter((r) => r.status !== 'candidate')
          : visible
      return c.json({
        status,
        scopeType: parsed.data.scopeType ?? null,
        scopeId: parsed.data.scopeId ?? null,
        total: items.length,
        tags: aggregateTagFacets(items),
      })
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/memories/:id',
      permissions: ['memory:read'],
      tokenAccess: 'allow',
      summary: 'Get one memory',
    },
    async (c) => {
      const id = c.req.param('id')
      const found = await getMemoryById(deps.db, id)
      if (found === null) throw new NotFoundError('memory-not-found', `memory ${id} not found`)
      // RFC-099 (D12): invisible scope → identical 404.
      const visible = await canViewMemory(deps.db, actorOf(c), {
        scopeType: found.memory.scopeType,
        scopeId: found.memory.scopeId,
      })
      if (!visible) throw new NotFoundError('memory-not-found', `memory ${id} not found`)
      // RFC-285 B7（Q4）：candidate 行对无 ACL bypass 权限者与不存在同形 404。
      if (found.memory.status === 'candidate' && !hasResourceAclBypass(actorOf(c))) {
        throw new NotFoundError('memory-not-found', `memory ${id} not found`)
      }
      const canManage = await canManageMemory(deps.db, actorOf(c), {
        scopeType: found.memory.scopeType,
        scopeId: found.memory.scopeId,
      })
      return c.json({
        memory: { ...found.memory, canManage },
        ancestors: found.ancestors.map((m) => toSummary(m)),
      })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/memories',
      permissions: ['memory:create'],
      tokenAccess: 'allow',
      summary: 'Create a memory row by hand',
    },
    async (c) => {
      const body = await c.req.json().catch(() => ({}))
      const parsed = MemoryCreateRequestSchema.safeParse(body)
      if (!parsed.success) {
        throw new ValidationError('invalid-body', 'invalid create request', parsed.error.format())
      }
      // RFC-099 (D12): creating a memory targets a scope — the creator must
      // hold management rights on that scope (resource owner or ACL bypass;
      // repo/global require the bypass capability).
      const canCreate = await canManageMemory(deps.db, actorOf(c), {
        scopeType: parsed.data.scopeType,
        scopeId: parsed.data.scopeId ?? null,
      })
      if (!canCreate) {
        throw new ForbiddenError(
          'forbidden',
          'only the scoped resource owner or an actor with resource-acl:bypass can create memories for this scope',
        )
      }
      const memory = await createManualCandidate(deps.db, parsed.data)
      return c.json({ memory }, 201)
    },
  )

  // RFC-045/RFC-342 — permission-gated content edit (title / body_md / tags)
  // on candidate / approved / archived rows. version is bumped only
  // when ≥1 field actually changes (service-side idempotent semantics).
  registerRoute(
    app,
    {
      method: 'PATCH',
      path: '/api/memories/:id',
      permissions: ['memory:update'],
      tokenAccess: 'allow',
      summary: 'Edit a memory',
    },
    async (c) => {
      const id = c.req.param('id')
      const body = await c.req.json().catch(() => ({}))
      const parsed = MemoryPatchRequestSchema.safeParse(body)
      if (!parsed.success) {
        throw new ValidationError('invalid-body', 'invalid patch request', parsed.error.format())
      }
      await loadManagedMemory(deps, c, id)
      const actor = actorOf(c)
      const result = await patchMemory(deps.db, id, parsed.data, actor.user.id)
      return c.json({ memory: result.memory, changedFields: result.changedFields })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/memories/:id/move',
      permissions: ['memory:update'],
      tokenAccess: 'allow',
      summary: 'Move a candidate memory to another scope',
    },
    async (c) => {
      const id = c.req.param('id')
      const body = await c.req.json().catch(() => ({}))
      const parsed = MemoryMoveRequestSchema.safeParse(body)
      if (!parsed.success) {
        throw new ValidationError('invalid-body', 'invalid move request', parsed.error.format())
      }
      const actor = actorOf(c)
      const context = identityAccess.contexts.fromAuthenticatedPrincipal(
        { userId: actor.user.id, source: actor.source },
        'http',
      )
      const result = moveMemory(deps.db, identityAccess.contexts, context, id, parsed.data)
      return c.json({ memory: result.memory, moved: result.moved })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/memories/:id/promote',
      permissions: ['memory:update'],
      tokenAccess: 'allow',
      summary: 'Promote a candidate memory to approved',
    },
    async (c) => {
      const id = c.req.param('id')
      const body = await c.req.json().catch(() => ({}))
      const parsed = MemoryCandidatePromoteSchema.safeParse(body)
      if (!parsed.success) {
        throw new ValidationError('invalid-body', 'invalid promote action', parsed.error.format())
      }
      await loadManagedMemory(deps, c, id)
      const actor = actorOf(c)
      const memory = await promoteCandidate(deps.db, id, parsed.data, actor.user.id)
      return c.json({ memory })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/memories/:id/archive',
      permissions: ['memory:update'],
      tokenAccess: 'allow',
      summary: 'Archive a memory',
    },
    async (c) => {
      const id = c.req.param('id')
      await loadManagedMemory(deps, c, id)
      const memory = await archiveMemory(deps.db, id)
      return c.json({ memory })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/memories/:id/unarchive',
      permissions: ['memory:update'],
      tokenAccess: 'allow',
      summary: 'Unarchive a memory',
    },
    async (c) => {
      const id = c.req.param('id')
      await loadManagedMemory(deps, c, id)
      const memory = await unarchiveMemory(deps.db, id)
      return c.json({ memory })
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/memories/:id',
      permissions: ['memory:delete'],
      tokenAccess: 'allow',
      summary: 'Delete a memory',
    },
    async (c) => {
      const id = c.req.param('id')
      const memory = await loadManagedMemory(deps, c, id)
      if (!parseBoolQuery(c, 'confirm', { default: false })) {
        throw new ValidationError(
          'confirm-required',
          'hard delete requires ?confirm=true to acknowledge irreversibility',
        )
      }
      // RFC-247 T20 — the query flag is enough for a human who clicked through
      // a dialog; a token additionally echoes the memory's title, so a model
      // cannot delete one it never read.
      assertTokenDeleteConfirm(
        await readDeleteBody(c),
        memory.memory.title,
        'memory',
        actorOf(c).source,
      )
      captureDeleteSnapshot(c, actorOf(c), memory.memory)
      await deleteMemory(deps.db, id)
      return c.json({ ok: true })
    },
  )
}
