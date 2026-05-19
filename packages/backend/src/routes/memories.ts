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
import { actorOf } from '@/auth/actor'
import { requirePermission } from '@/auth/permissions'
import {
  archiveMemory,
  createManualCandidate,
  deleteMemory,
  getMemoryById,
  listMemories,
  patchMemory,
  promoteCandidate,
  toSummary,
  unarchiveMemory,
} from '@/services/memory'
import { NotFoundError, ValidationError } from '@/util/errors'

export function mountMemoryRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/memories', requirePermission('memory:read'), async (c) => {
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
      throw new ValidationError('invalid-filter', 'invalid query parameters', parsed.error.format())
    }
    const items = await listMemories(deps.db, parsed.data)
    return c.json({ items })
  })

  app.get('/api/memories/:id', requirePermission('memory:read'), async (c) => {
    const id = c.req.param('id')
    const found = await getMemoryById(deps.db, id)
    if (found === null) throw new NotFoundError('memory-not-found', `memory ${id} not found`)
    return c.json({
      memory: found.memory,
      ancestors: found.ancestors.map((m) => toSummary(m)),
    })
  })

  app.post('/api/memories', requirePermission('memory:approve'), async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = MemoryCreateRequestSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('invalid-body', 'invalid create request', parsed.error.format())
    }
    const memory = await createManualCandidate(deps.db, parsed.data)
    return c.json({ memory }, 201)
  })

  // RFC-045 — admin in-place edit (scope_type / scope_id / title / body_md /
  // tags) on candidate / approved / archived rows. version is bumped only
  // when ≥1 field actually changes (service-side idempotent semantics).
  app.patch('/api/memories/:id', requirePermission('memory:edit'), async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({}))
    const parsed = MemoryPatchRequestSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('invalid-body', 'invalid patch request', parsed.error.format())
    }
    const actor = actorOf(c)
    const result = await patchMemory(deps.db, id, parsed.data, actor.user.id)
    return c.json({ memory: result.memory, changedFields: result.changedFields })
  })

  app.post('/api/memories/:id/promote', requirePermission('memory:approve'), async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({}))
    const parsed = MemoryCandidatePromoteSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('invalid-body', 'invalid promote action', parsed.error.format())
    }
    const actor = actorOf(c)
    const memory = await promoteCandidate(deps.db, id, parsed.data, actor.user.id)
    return c.json({ memory })
  })

  app.post('/api/memories/:id/archive', requirePermission('memory:archive'), async (c) => {
    const id = c.req.param('id')
    const memory = await archiveMemory(deps.db, id)
    return c.json({ memory })
  })

  app.post('/api/memories/:id/unarchive', requirePermission('memory:archive'), async (c) => {
    const id = c.req.param('id')
    const memory = await unarchiveMemory(deps.db, id)
    return c.json({ memory })
  })

  app.delete('/api/memories/:id', requirePermission('memory:delete'), async (c) => {
    const id = c.req.param('id')
    const confirm = c.req.query('confirm')
    if (confirm !== 'true' && confirm !== '1') {
      throw new ValidationError(
        'confirm-required',
        'hard delete requires ?confirm=true to acknowledge irreversibility',
      )
    }
    await deleteMemory(deps.db, id)
    return c.json({ ok: true })
  })
}
