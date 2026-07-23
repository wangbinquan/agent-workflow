// MCP HTTP routes (RFC-028 + RFC-030).
// GET    /api/mcps                  — list
// GET    /api/mcps/probes           — RFC-030: list all probe rows (joined w/ mcp name)
// GET    /api/mcps/:id              — one
// POST   /api/mcps                  — create
// PUT    /api/mcps/:id              — update (subset of fields; type immutable)
// DELETE /api/mcps/:id              — delete (refuses if referenced)
// POST   /api/mcps/:id/rename       — rename (references remain id-stable)
// GET    /api/mcps/:id/probe        — RFC-030: last probe row, 404 if never probed
// POST   /api/mcps/:id/probe        — RFC-030: trigger probe + upsert; returns row
//
// IMPORTANT: /api/mcps/probes is registered BEFORE /api/mcps/:id so it
// doesn't get swallowed by the parametric route (`:id = "probes"`).

import {
  CreateMcpSchema,
  DeleteMcpSchema,
  McpOperationRequestSchema,
  RenameMcpRequestSchema,
  UpdateMcpRequestSchema,
  type Mcp,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { createMcp, deleteMcp, getMcpById, listMcps, renameMcp, updateMcp } from '@/services/mcp'
import {
  mcpOperationConfigHashOf,
  withMcpOperationConfigHash,
} from '@/services/mcpOperationRevision'
import { canViewResource, filterVisibleRows, requireResourceOwner } from '@/services/resourceAcl'
import { assertDeleteConfirm, readDeleteBody } from '@/services/deleteConfirm'
import { mountAclEndpoints } from './resourceAcl'
import { probeMcp, type ProbeOptions } from '@/services/mcpProbe'
import { getProbeByMcpId, listProbes, upsertProbe } from '@/services/mcpProbeStore'
import { mcpOperationCoordinator } from '@/services/resourceOperationCoordinator'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'

const log = createLogger('mcps-routes')

// Allow tests to override the probe options (e.g. inject a fake openClient).
// In production this stays undefined and probeMcp uses defaults.
let probeOptionsOverride: ProbeOptions | undefined
export function __setProbeOptionsForTesting(opts: ProbeOptions | undefined): void {
  probeOptionsOverride = opts
}

export function mountMcpRoutes(app: Hono, deps: AppDeps): void {
  // RFC-099: missing and not-visible produce the identical 404 (D1).
  async function loadVisibleMcp(actor: Actor, id: string): Promise<Mcp> {
    const mcp = await getMcpById(deps.db, id)
    if (mcp === null || !(await canViewResource(deps.db, actor, 'mcp', mcp))) {
      throw new NotFoundError('mcp-not-found', 'mcp not found')
    }
    return mcp
  }

  async function nextMutationTimestamp(mcp: Mcp): Promise<number> {
    const persisted = await getProbeByMcpId(deps.db, mcp.id)
    return mcpOperationCoordinator.nextCausalTimestamp(
      mcp.id,
      (probeOptionsOverride?.now ?? Date.now)(),
      [
        mcp.updatedAt + 1,
        (persisted?.startedAt ?? 0) + 1,
        mcpOperationCoordinator.activeLastStartedAt(mcp.id) + 1,
      ],
    )
  }

  app.get('/api/mcps', async (c) => {
    const list = await listMcps(deps.db)
    const visible = await filterVisibleRows(deps.db, actorOf(c), 'mcp', list)
    return c.json(visible.map(withMcpOperationConfigHash))
  })

  // RFC-030 — must come BEFORE /api/mcps/:id to avoid being swallowed.
  // RFC-099: probe rows are keyed by mcpId — only visible MCPs' probes leak.
  app.get('/api/mcps/probes', async (c) => {
    const list = await listProbes(deps.db)
    const visibleMcps = await filterVisibleRows(deps.db, actorOf(c), 'mcp', await listMcps(deps.db))
    const allowed = new Set(visibleMcps.map((m) => m.id))
    return c.json(list.filter((p) => allowed.has(p.mcpId)))
  })

  app.get('/api/mcps/:id', async (c) => {
    return c.json(withMcpOperationConfigHash(await loadVisibleMcp(actorOf(c), c.req.param('id'))))
  })

  app.post('/api/mcps', async (c) => {
    const body = await safeJson(c.req.raw)
    const parsed = CreateMcpSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('mcp-invalid', 'invalid mcp payload', {
        issues: parsed.error.issues,
      })
    }
    const created = await createMcp(deps.db, parsed.data, { ownerUserId: actorOf(c).user.id })
    return c.json(withMcpOperationConfigHash(created), 201)
  })

  app.put('/api/mcps/:id', async (c) => {
    const id = c.req.param('id')
    const body = await safeJson(c.req.raw)
    const parsed = UpdateMcpRequestSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('mcp-invalid', 'invalid mcp patch', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const resolved = await loadVisibleMcp(actor, id)
    const updated = await mcpOperationCoordinator.runExclusive(resolved.id, async () => {
      const fresh = await loadVisibleMcp(actor, resolved.id)
      await requireResourceOwner(deps.db, actor, 'mcp', fresh)
      assertExpectedHash(fresh, parsed.data.expectedConfigHash)
      const { expectedConfigHash: _expectedConfigHash, ...patch } = parsed.data
      return updateMcp(deps.db, fresh.id, patch, {
        existing: fresh,
        updatedAt: await nextMutationTimestamp(fresh),
      })
    })
    return c.json(withMcpOperationConfigHash(updated))
  })

  app.delete('/api/mcps/:id', async (c) => {
    const id = c.req.param('id')
    const actor = actorOf(c)
    const resolved = await loadVisibleMcp(actor, id)
    const deleteBody = await readDeleteBody(c)
    assertDeleteConfirm(deleteBody, resolved.name, 'mcp')
    const parsed = DeleteMcpSchema.safeParse(deleteBody)
    if (!parsed.success) {
      throw new ValidationError('mcp-delete-invalid', 'invalid mcp delete payload', {
        issues: parsed.error.issues,
      })
    }
    await mcpOperationCoordinator.runExclusive(resolved.id, async () => {
      const fresh = await loadVisibleMcp(actor, resolved.id)
      await requireResourceOwner(deps.db, actor, 'mcp', fresh)
      assertExpectedHash(fresh, parsed.data.expectedConfigHash)
      // RFC-222 (D5, N-6): confirm against the FRESH name inside the exclusive
      // section, so a concurrent rename is caught as a mismatch.
      assertDeleteConfirm(parsed.data, fresh.name, 'mcp')
      await deleteMcp(deps.db, fresh.id, actor, { existing: fresh })
    })
    return c.body(null, 204)
  })

  app.post('/api/mcps/:id/rename', async (c) => {
    const id = c.req.param('id')
    const body = await safeJson(c.req.raw)
    const parsed = RenameMcpRequestSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('mcp-rename-invalid', 'invalid rename payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const resolved = await loadVisibleMcp(actor, id)
    const renamed = await mcpOperationCoordinator.runExclusive(resolved.id, async () => {
      const fresh = await loadVisibleMcp(actor, resolved.id)
      await requireResourceOwner(deps.db, actor, 'mcp', fresh)
      assertExpectedHash(fresh, parsed.data.expectedConfigHash)
      const { expectedConfigHash: _expectedConfigHash, ...rename } = parsed.data
      return renameMcp(deps.db, fresh.id, rename, {
        existing: fresh,
        updatedAt: await nextMutationTimestamp(fresh),
      })
    })
    return c.json(withMcpOperationConfigHash(renamed))
  })

  // RFC-030 — per-mcp probe endpoints.
  app.get('/api/mcps/:id/probe', async (c) => {
    const id = c.req.param('id')
    // Existence check on the parent mcp keeps the 404 distinction:
    //   - mcp doesn't exist            → 404 mcp-not-found
    //   - mcp exists but never probed  → 404 probe-not-found
    const actor = actorOf(c)
    const resolved = await loadVisibleMcp(actor, id)
    const { currentName, probe } = await mcpOperationCoordinator.runExclusive(
      resolved.id,
      async () => {
        // Bind the read to the already-resolved stable id. Reload visibility
        // under the same fence used by rename/ACL so name reuse cannot expose a
        // different MCP's inventory or make the original probe disappear.
        const fresh = await loadVisibleMcp(actor, resolved.id)
        return {
          currentName: fresh.name,
          probe: await getProbeByMcpId(deps.db, fresh.id),
        }
      },
    )
    if (probe === null) {
      throw new NotFoundError(
        'probe-not-found',
        `mcp '${currentName}' has not been probed yet — POST /api/mcps/${resolved.id}/probe first`,
      )
    }
    return c.json(probe)
  })

  app.post('/api/mcps/:id/probe', async (c) => {
    const id = c.req.param('id')
    const body = await safeJson(c.req.raw)
    const parsed = McpOperationRequestSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('mcp-probe-invalid', 'expectedConfigHash is required', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const resolved = await loadVisibleMcp(actor, id)
    const expectedHash = parsed.data.expectedConfigHash

    const receipt = await mcpOperationCoordinator.runDeduplicatedOperation(
      resolved.id,
      expectedHash,
      async () => {
        const start = await mcpOperationCoordinator.runExclusive(resolved.id, async () => {
          const captured = await loadVisibleMcp(actor, resolved.id)
          const actualHash = mcpOperationConfigHashOf(captured)
          if (actualHash !== expectedHash) {
            throw new ConflictError(
              'resource-operation-stale',
              'the MCP changed; reload before probing',
              { expectedConfigHash: expectedHash, currentConfigHash: actualHash },
            )
          }
          // Preserve the existing 422 disabled contract before assigning a
          // generation to an operation that cannot truly start.
          if (!captured.enabled) {
            throw new ValidationError(
              'mcp-disabled',
              `mcp '${captured.name}' is disabled; enable it before probing`,
            )
          }
          const persisted = await getProbeByMcpId(deps.db, captured.id)
          const operation = mcpOperationCoordinator.beginOperation(
            captured.id,
            (probeOptionsOverride?.now ?? Date.now)(),
            [captured.updatedAt + 1, (persisted?.startedAt ?? 0) + 1],
          )
          return { captured, ...operation }
        })

        let result
        try {
          result = await probeMcp(start.captured, {
            ...probeOptionsOverride,
            startedAt: start.startedAt,
          })
        } catch (err) {
          if (err instanceof DomainError) throw err
          log.error('probeMcp unexpectedly threw', {
            mcp: start.captured.name,
            message: err instanceof Error ? err.message : String(err),
          })
          throw err
        }

        return mcpOperationCoordinator.runExclusive(resolved.id, async () => {
          const current = await getMcpById(deps.db, resolved.id)
          if (current === null || mcpOperationConfigHashOf(current) !== expectedHash) {
            throw new ConflictError(
              'resource-operation-stale',
              'the MCP changed while the probe was running; result was discarded',
              { expectedConfigHash: expectedHash },
            )
          }
          if (!(await canViewResource(deps.db, actor, 'mcp', current))) {
            throw new ConflictError(
              'resource-operation-stale',
              'MCP access changed while the probe was running; result was discarded',
            )
          }
          if (mcpOperationCoordinator.latestGeneration(current.id) !== start.generation) {
            throw new ConflictError(
              'resource-operation-superseded',
              'a newer probe completed for this MCP; result was discarded',
              { generation: start.generation },
            )
          }
          const persisted = await upsertProbe(deps.db, current.id, current.name, result)
          return { ...persisted, configHashUsed: expectedHash }
        })
      },
    )
    return c.json(receipt)
  })

  // RFC-099 / RFC-223 — GET/PUT /api/mcps/:id/acl
  mountAclEndpoints(app, deps, {
    type: 'mcp',
    base: '/api/mcps',
    param: 'id',
    load: (db, id) => getMcpById(db, id),
    coordinator: {
      runExclusive: (resourceId, task) => mcpOperationCoordinator.runExclusive(resourceId, task),
      loadById: (db, resourceId) => getMcpById(db, resourceId),
      nextUpdatedAt: async (row) => {
        const mcp = await getMcpById(deps.db, row.id)
        if (mcp === null) throw new NotFoundError('mcp-not-found', 'mcp not found')
        return nextMutationTimestamp(mcp)
      },
    },
  })
}

function assertExpectedHash(mcp: Mcp, expected: string): void {
  if (mcpOperationConfigHashOf(mcp) !== expected) {
    throw new ConflictError(
      'resource-operation-stale',
      'the MCP changed; reload before modifying it',
      { expectedConfigHash: expected, currentConfigHash: mcpOperationConfigHashOf(mcp) },
    )
  }
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
