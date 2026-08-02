// RFC-041 — REST surface for the platform memory tables (PR1 scope).
//
//   GET    /api/memories               list + filter        memory:read
//   GET    /api/memories/:id           detail + supersede chain   memory:read
//   POST   /api/memories               admin manual create (status=candidate)  memory:approve
//   PATCH  /api/memories/:id           RFC-045 in-place edit                    memory:edit
//   POST   /api/memories/:id/promote   admin approve / supersede / reject       memory:approve
//   POST   /api/memories/:id/archive   approved → archived                       memory:archive
//   POST   /api/memories/:id/unarchive archived → approved                       memory:archive
//   DELETE /api/memories/:id?confirm=true   hard delete                         memory:delete

import {
  MemoryCandidatePromoteSchema,
  MemoryCreateRequestSchema,
  MemoryListFilterSchema,
  MemoryPatchRequestSchema,
  MemoryScopeSchema,
  MemoryStatusSchema,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { actorOf } from '@/auth/actor'
import {
  archiveMemory,
  createManualCandidate,
  deleteMemory,
  getMemoryById,
  listMemories,
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

/**
 * RFC-099 (D12) — load + gate one memory row for a management operation:
 * invisible → 404 (existence isolation); visible but not the scope-resource
 * owner / admin → 403. Returns the loaded row bundle for the handler.
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
      'only the scoped resource owner or an admin can manage this memory',
    )
  }
  return found
}

export function mountMemoryRoutes(app: Hono, deps: AppDeps): void {
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
      if (includeRaw === 'body') {
        const items = await listMemories(deps.db, parsed.data, { includeBody: true })
        const visible = await filterMemoriesByScopeVisibility(deps.db, actor, items)
        return c.json({ items: await annotateMemoryManageRights(deps.db, actor, visible) })
      }
      const items = await listMemories(deps.db, parsed.data)
      const visible = await filterMemoriesByScopeVisibility(deps.db, actor, items)
      return c.json({ items: await annotateMemoryManageRights(deps.db, actor, visible) })
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
      // hold management rights on that scope (resource owner or admin;
      // repo/global stay admin-only).
      const canCreate = await canManageMemory(deps.db, actorOf(c), {
        scopeType: parsed.data.scopeType,
        scopeId: parsed.data.scopeId ?? null,
      })
      if (!canCreate) {
        throw new ForbiddenError(
          'forbidden',
          'only the scoped resource owner or an admin can create memories for this scope',
        )
      }
      const memory = await createManualCandidate(deps.db, parsed.data)
      return c.json({ memory }, 201)
    },
  )

  // RFC-045 — admin in-place edit (scope_type / scope_id / title / body_md /
  // tags) on candidate / approved / archived rows. version is bumped only
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
      await loadManagedMemory(deps, c, id)
      if (!parseBoolQuery(c, 'confirm', { default: false })) {
        throw new ValidationError(
          'confirm-required',
          'hard delete requires ?confirm=true to acknowledge irreversibility',
        )
      }
      await deleteMemory(deps.db, id)
      return c.json({ ok: true })
    },
  )
}
