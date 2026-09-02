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
import type { Memory, MemorySummary } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { registerRoute } from '@/routes/registry'
import { hasResourceAclBypass } from '@/services/resourceAcl'
import { captureDeleteSnapshot } from '@/services/tokenAudit'
import { assertTokenDeleteConfirm, readDeleteBody } from '@/services/deleteConfirm'
import { actorOf } from '@/auth/actor'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { parseBoolQuery } from '@/util/http'
import type {
  DirectAuthorityBinding,
  DirectCommandContextFactory,
} from '@/modules/identity-access/public/participants'
import type {
  MemoryCatalogOperations,
  MemoryScopeAuthority,
  MemoryScopeRef,
} from '@/modules/memory/public/catalog'
import { directRequestAuthority } from '@/routes/operationAuthority'

interface MemoryRouteIdentityAccess {
  readonly contexts: DirectCommandContextFactory
  readonly directAuthority: DirectAuthorityBinding
}

function memoryScopeAuthority(
  c: Parameters<typeof actorOf>[0],
  identityAccess: MemoryRouteIdentityAccess,
): MemoryScopeAuthority {
  const actor = actorOf(c)
  return Object.freeze({
    actor,
    authority: directRequestAuthority(identityAccess.directAuthority, actor),
  })
}

function toMemorySummary(memory: Memory): MemorySummary {
  return {
    id: memory.id,
    scopeType: memory.scopeType,
    scopeId: memory.scopeId,
    title: memory.title,
    status: memory.status,
    tags: memory.tags,
    approvedAt: memory.approvedAt,
    version: memory.version,
    distillAction: memory.distillAction,
    fusedIntoSkill: memory.fusedIntoSkill ?? null,
    fusedIntoSkillId: memory.fusedIntoSkillId ?? null,
    fusedIntoSkillVersion: memory.fusedIntoSkillVersion ?? null,
    outputLang: null,
  }
}

/**
 * RFC-099 (D12) — load + gate one memory row for a management operation:
 * invisible → 404 (existence isolation); visible but not the scope-resource
 * owner / ACL-bypass actor → 403. Returns the loaded row bundle for the handler.
 */
async function loadManagedMemory(
  catalog: MemoryCatalogOperations,
  identityAccess: MemoryRouteIdentityAccess,
  c: Parameters<typeof actorOf>[0],
  id: string,
) {
  const found = await catalog.queries.getById(id)
  if (found === null) throw new NotFoundError('memory-not-found', `memory ${id} not found`)
  const authority = memoryScopeAuthority(c, identityAccess)
  const scope: MemoryScopeRef = {
    scopeType: found.memory.scopeType,
    scopeId: found.memory.scopeId,
  }
  if (!(await catalog.queries.canView(authority, scope))) {
    throw new NotFoundError('memory-not-found', `memory ${id} not found`)
  }
  if (!(await catalog.queries.canManage(authority, scope))) {
    throw new ForbiddenError(
      'forbidden',
      'only the scoped resource owner or an actor with resource-acl:bypass can manage this memory',
    )
  }
  return found
}

export function mountMemoryRoutes(
  app: Hono,
  catalog: MemoryCatalogOperations,
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
      const scopeAuthority = memoryScopeAuthority(c, identityAccess)
      // RFC-285 B7（Q4 拍板，E12）：candidate 状态是**未经人审的蒸馏产物**（含
      // body）——读面收紧为仅持有 `resource-acl:bypass` 的操作者，与 distill 详情门
      // （E8）同一威胁模型。人审发布（approved）后才进入全员读面。两读法
      // （含 body / 不含 body）同收。
      const dropCandidates = <T extends { status: string }>(rows: T[]): T[] =>
        hasResourceAclBypass(actor) ? rows : rows.filter((r) => r.status !== 'candidate')
      if (includeRaw === 'body') {
        const items = await catalog.queries.listWithBody(parsed.data)
        const visible = await catalog.queries.filterVisible(scopeAuthority, items)
        return c.json({
          items: await catalog.queries.annotateManageRights(
            scopeAuthority,
            dropCandidates(visible),
          ),
        })
      }
      const items = await catalog.queries.list(parsed.data)
      const visible = await catalog.queries.filterVisible(scopeAuthority, items)
      return c.json({
        items: await catalog.queries.annotateManageRights(scopeAuthority, dropCandidates(visible)),
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
      // 缺省 approved：与注入链路（modules/memory/application/injection 只取 approved）一致——
      // 一个外部代理问「有哪些标签」，想要的是能被注入的事实，不是未审的候选。
      const status = parsed.data.status ?? 'approved'
      const actor = actorOf(c)
      const scopeAuthority = memoryScopeAuthority(c, identityAccess)
      const rows = await catalog.queries.list({ ...parsed.data, status })
      const visible = await catalog.queries.filterVisible(scopeAuthority, rows)
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
      const found = await catalog.queries.getById(id)
      if (found === null) throw new NotFoundError('memory-not-found', `memory ${id} not found`)
      // RFC-099 (D12): invisible scope → identical 404.
      const scopeAuthority = memoryScopeAuthority(c, identityAccess)
      const visible = await catalog.queries.canView(scopeAuthority, {
        scopeType: found.memory.scopeType,
        scopeId: found.memory.scopeId,
      })
      if (!visible) throw new NotFoundError('memory-not-found', `memory ${id} not found`)
      // RFC-285 B7（Q4）：candidate 行对无 ACL bypass 权限者与不存在同形 404。
      if (found.memory.status === 'candidate' && !hasResourceAclBypass(actorOf(c))) {
        throw new NotFoundError('memory-not-found', `memory ${id} not found`)
      }
      const canManage = await catalog.queries.canManage(scopeAuthority, {
        scopeType: found.memory.scopeType,
        scopeId: found.memory.scopeId,
      })
      return c.json({
        memory: { ...found.memory, canManage },
        ancestors: found.ancestors.map(toMemorySummary),
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
      const canCreate = await catalog.queries.canManage(memoryScopeAuthority(c, identityAccess), {
        scopeType: parsed.data.scopeType,
        scopeId: parsed.data.scopeId ?? null,
      })
      if (!canCreate) {
        throw new ForbiddenError(
          'forbidden',
          'only the scoped resource owner or an actor with resource-acl:bypass can create memories for this scope',
        )
      }
      const memory = await catalog.commands.createManual(parsed.data)
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
      await loadManagedMemory(catalog, identityAccess, c, id)
      const actor = actorOf(c)
      const result = await catalog.commands.patch(id, parsed.data, actor.user.id)
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
      const context = identityAccess.contexts.fromAuthority(
        directRequestAuthority(identityAccess.directAuthority, actor),
        'http',
      )
      const result = await catalog.commands.move(context, id, parsed.data)
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
      await loadManagedMemory(catalog, identityAccess, c, id)
      const actor = actorOf(c)
      const memory = await catalog.commands.promote(id, parsed.data, actor.user.id)
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
      await loadManagedMemory(catalog, identityAccess, c, id)
      const memory = await catalog.commands.archive(id)
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
      await loadManagedMemory(catalog, identityAccess, c, id)
      const memory = await catalog.commands.unarchive(id)
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
      const memory = await loadManagedMemory(catalog, identityAccess, c, id)
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
      await catalog.commands.delete(id)
      return c.json({ ok: true })
    },
  )
}
