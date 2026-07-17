// MCP HTTP routes (RFC-028 + RFC-030).
// GET    /api/mcps                  — list
// GET    /api/mcps/probes           — RFC-030: list all probe rows (joined w/ mcp name)
// GET    /api/mcps/:name            — one
// POST   /api/mcps                  — create
// PUT    /api/mcps/:name            — update (subset of fields; type immutable)
// DELETE /api/mcps/:name            — delete (refuses if referenced)
// POST   /api/mcps/:name/rename     — rename (cascades into agents.mcp arrays)
// GET    /api/mcps/:name/probe      — RFC-030: last probe row, 404 if never probed
// POST   /api/mcps/:name/probe      — RFC-030: trigger probe + upsert; returns row
//
// IMPORTANT: /api/mcps/probes is registered BEFORE /api/mcps/:name so it
// doesn't get swallowed by the parametric route (`:name = "probes"`).

import {
  CreateMcpSchema,
  McpOperationRequestSchema,
  RenameMcpSchema,
  UpdateMcpSchema,
  type Mcp,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import {
  createMcp,
  deleteMcp,
  getMcp,
  getMcpById,
  listMcps,
  renameMcp,
  updateMcp,
} from '@/services/mcp'
import {
  mcpOperationConfigHashOf,
  withMcpOperationConfigHash,
} from '@/services/mcpOperationRevision'
import { canViewResource, filterVisibleRows, requireResourceOwner } from '@/services/resourceAcl'
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
  async function loadVisibleMcp(actor: Actor, name: string) {
    const mcp = await getMcp(deps.db, name)
    if (mcp === null || !(await canViewResource(deps.db, actor, 'mcp', mcp))) {
      throw new NotFoundError('mcp-not-found', `mcp '${name}' not found`)
    }
    return mcp
  }

  async function loadVisibleMcpById(actor: Actor, id: string): Promise<Mcp> {
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

  // RFC-030 — must come BEFORE /api/mcps/:name to avoid being swallowed.
  // RFC-099: probe rows are keyed by mcpId — only visible MCPs' probes leak.
  app.get('/api/mcps/probes', async (c) => {
    const list = await listProbes(deps.db)
    const visibleMcps = await filterVisibleRows(deps.db, actorOf(c), 'mcp', await listMcps(deps.db))
    const allowed = new Set(visibleMcps.map((m) => m.id))
    return c.json(list.filter((p) => allowed.has(p.mcpId)))
  })

  app.get('/api/mcps/:name', async (c) => {
    return c.json(withMcpOperationConfigHash(await loadVisibleMcp(actorOf(c), c.req.param('name'))))
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

  app.put('/api/mcps/:name', async (c) => {
    const name = c.req.param('name')
    const body = await safeJson(c.req.raw)
    const parsed = UpdateMcpSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('mcp-invalid', 'invalid mcp patch', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const resolved = await loadVisibleMcp(actor, name)
    const updated = await mcpOperationCoordinator.runExclusive(resolved.id, async () => {
      const fresh = await loadVisibleMcpById(actor, resolved.id)
      await requireResourceOwner(deps.db, actor, 'mcp', fresh)
      return updateMcp(deps.db, fresh.name, parsed.data, {
        existing: fresh,
        updatedAt: await nextMutationTimestamp(fresh),
      })
    })
    return c.json(withMcpOperationConfigHash(updated))
  })

  app.delete('/api/mcps/:name', async (c) => {
    const name = c.req.param('name')
    const actor = actorOf(c)
    const resolved = await loadVisibleMcp(actor, name)
    await mcpOperationCoordinator.runExclusive(resolved.id, async () => {
      const fresh = await loadVisibleMcpById(actor, resolved.id)
      await requireResourceOwner(deps.db, actor, 'mcp', fresh)
      await deleteMcp(deps.db, fresh.name, actor, { existing: fresh })
    })
    return c.body(null, 204)
  })

  app.post('/api/mcps/:name/rename', async (c) => {
    const name = c.req.param('name')
    const body = await safeJson(c.req.raw)
    const parsed = RenameMcpSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('mcp-rename-invalid', 'invalid rename payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const resolved = await loadVisibleMcp(actor, name)
    const renamed = await mcpOperationCoordinator.runExclusive(resolved.id, async () => {
      const fresh = await loadVisibleMcpById(actor, resolved.id)
      await requireResourceOwner(deps.db, actor, 'mcp', fresh)
      return renameMcp(deps.db, fresh.name, parsed.data, {
        existing: fresh,
        updatedAt: await nextMutationTimestamp(fresh),
      })
    })
    return c.json(withMcpOperationConfigHash(renamed))
  })

  // RFC-030 — per-mcp probe endpoints.
  app.get('/api/mcps/:name/probe', async (c) => {
    const name = c.req.param('name')
    // Existence check on the parent mcp keeps the 404 distinction:
    //   - mcp doesn't exist            → 404 mcp-not-found
    //   - mcp exists but never probed  → 404 probe-not-found
    const actor = actorOf(c)
    const resolved = await loadVisibleMcp(actor, name)
    const { currentName, probe } = await mcpOperationCoordinator.runExclusive(
      resolved.id,
      async () => {
        // Bind the read to the already-resolved stable id. Reload visibility
        // under the same fence used by rename/ACL so name reuse cannot expose a
        // different MCP's inventory or make the original probe disappear.
        const fresh = await loadVisibleMcpById(actor, resolved.id)
        return {
          currentName: fresh.name,
          probe: await getProbeByMcpId(deps.db, fresh.id),
        }
      },
    )
    if (probe === null) {
      throw new NotFoundError(
        'probe-not-found',
        `mcp '${currentName}' has not been probed yet — POST /api/mcps/${currentName}/probe first`,
      )
    }
    return c.json(probe)
  })

  app.post('/api/mcps/:name/probe', async (c) => {
    const name = c.req.param('name')
    const body = await safeJson(c.req.raw)
    const parsed = McpOperationRequestSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('mcp-probe-invalid', 'expectedConfigHash is required', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const resolved = await loadVisibleMcp(actor, name)
    const expectedHash = parsed.data.expectedConfigHash

    const receipt = await mcpOperationCoordinator.runDeduplicatedOperation(
      resolved.id,
      expectedHash,
      async () => {
        const start = await mcpOperationCoordinator.runExclusive(resolved.id, async () => {
          const captured = await loadVisibleMcpById(actor, resolved.id)
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

  // RFC-099 — GET/PUT /api/mcps/:name/acl
  mountAclEndpoints(app, deps, {
    type: 'mcp',
    base: '/api/mcps',
    param: 'name',
    load: (db, name) => getMcp(db, name),
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

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
