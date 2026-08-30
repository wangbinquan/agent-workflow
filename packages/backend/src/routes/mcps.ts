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
  McpRuntimeTestCancelRequestSchema,
  McpRuntimeTestCreateRequestSchema,
  McpRuntimeTestEndRequestSchema,
  McpRuntimeTestMessageRequestSchema,
  RenameMcpRequestSchema,
  UpdateMcpRequestSchema,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import type { McpCatalogModule } from '@/modules/resource-catalog/public/operations'
import type { McpOperationContext } from '@/modules/resource-catalog/public/participants'
import type { McpCatalogResource } from '@/modules/resource-catalog/public/types'
import { invokeOperation } from '@/platform/operations/invoke'
import { registerRoute } from '@/routes/registry'
import { captureDeleteSnapshot } from '@/services/tokenAudit'
import { assertDeleteConfirm, readDeleteBody } from '@/services/deleteConfirm'
import { serializeMcpFor } from '@/services/tokenRedaction'
import { mountAclEndpoints } from './resourceAcl'
import { probeMcp, type ProbeOptions } from '@/services/mcpProbe'
import { getProbeByMcpId, listProbes, upsertProbe } from '@/services/mcpProbeStore'
import { mcpOperationCoordinator } from '@/services/resourceOperationCoordinator'
import {
  ConflictError,
  DomainError,
  NotFoundError,
  ValidationError,
  staleConflictError,
} from '@/util/errors'
import { createLogger } from '@/util/log'
import type { McpRuntimeTestService } from '@/services/mcpRuntimeTest'
import { transitionMcpAclRuntimeTestsInTx } from '@/services/mcpRuntimeTestTransitions'
import { safeJsonOrEmpty } from '@/util/http'

const log = createLogger('mcps-routes')

// Allow tests to override the probe options (e.g. inject a fake openClient).
// In production this stays undefined and probeMcp uses defaults.
let probeOptionsOverride: ProbeOptions | undefined
export function __setProbeOptionsForTesting(opts: ProbeOptions | undefined): void {
  probeOptionsOverride = opts
}

export function mcpRouteNow(): number {
  return (probeOptionsOverride?.now ?? Date.now)()
}

export interface McpRouteDependencies {
  readonly catalog: McpCatalogModule
  readonly authorityFor: (actor: Actor) => McpOperationContext
  readonly runtimeTests: McpRuntimeTestService
}

export function mountMcpRoutes(app: Hono, deps: AppDeps, module: McpRouteDependencies): void {
  const { catalog, runtimeTests } = module
  // RFC-099: missing and not-visible produce the identical 404 (D1).
  async function loadVisibleMcp(actor: Actor, id: string): Promise<McpCatalogResource> {
    const mcp = await invokeOperation(catalog.operations.get, module.authorityFor(actor), { id })
    if (mcp === null) throw new NotFoundError('mcp-not-found', 'mcp not found')
    return mcp
  }

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/mcps',
      permissions: ['mcps:read'],
      tokenAccess: 'allow',
      summary: 'List MCP servers visible to the caller',
    },
    async (c) => {
      const actor = actorOf(c)
      const visible = await invokeOperation(catalog.operations.list, module.authorityFor(actor), {})
      return c.json(visible.map((mcp) => serializeMcpFor(mcp, actor.source)))
    },
  )

  // RFC-030 — must come BEFORE /api/mcps/:id to avoid being swallowed.
  // RFC-099: probe rows are keyed by mcpId — only visible MCPs' probes leak.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/mcps/probes',
      permissions: ['mcps:read'],
      tokenAccess: 'allow',
      summary: 'Stored probe results for all MCP servers',
    },
    async (c) => {
      const list = await listProbes(deps.db)
      const actor = actorOf(c)
      const visibleMcps = await invokeOperation(
        catalog.operations.list,
        module.authorityFor(actor),
        {},
      )
      const allowed = new Set(visibleMcps.map((m) => m.id))
      return c.json(list.filter((p) => allowed.has(p.mcpId)))
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/mcps/:id',
      permissions: ['mcps:read'],
      tokenAccess: 'allow',
      summary: 'Get one MCP server',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(serializeMcpFor(await loadVisibleMcp(actor, c.req.param('id')), actor.source))
    },
  )

  // RFC-238 — private multi-turn runtime playground. Dialog dismiss never
  // reaches a mutating endpoint; only message/cancel/end change lifecycle.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/mcps/:id/runtime-test-session',
      permissions: ['mcps:read'],
      tokenAccess: 'allow',
      summary: 'Current runtime-test session',
    },
    async (c) => {
      const actor = actorOf(c)
      const mcpId = c.req.param('id')
      const session = await mcpOperationCoordinator.runExclusive(mcpId, async () => {
        const mcp = await loadVisibleMcp(actor, mcpId)
        return runtimeTests.latest(actor, mcp.id)
      })
      return session === null ? c.body(null, 204) : c.json(session)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/mcps/:id/runtime-test-sessions',
      permissions: ['mcps:execute', 'tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Start an MCP runtime-test session (spawns a model run)',
    },
    async (c) => {
      const parsed = McpRuntimeTestCreateRequestSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('mcp-test-invalid', 'invalid MCP runtime test payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const resolved = await loadVisibleMcp(actor, c.req.param('id'))
      const receipt = await mcpOperationCoordinator.runExclusive(resolved.id, async () => {
        const fresh = await loadVisibleMcp(actor, resolved.id)
        return runtimeTests.create(actor, fresh, parsed.data)
      })
      return c.json(receipt, 202)
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/mcps/:id/runtime-test-sessions/:sessionId',
      permissions: ['mcps:read'],
      tokenAccess: 'allow',
      summary: 'Get a runtime-test session',
    },
    async (c) => {
      const actor = actorOf(c)
      const mcpId = c.req.param('id')
      return c.json(
        await mcpOperationCoordinator.runExclusive(mcpId, async () => {
          const mcp = await loadVisibleMcp(actor, mcpId)
          return runtimeTests.get(actor, mcp.id, c.req.param('sessionId'))
        }),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/mcps/:id/runtime-test-sessions/:sessionId/messages',
      permissions: ['mcps:execute', 'tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Send a runtime-test turn (spawns a model run)',
    },
    async (c) => {
      const parsed = McpRuntimeTestMessageRequestSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('mcp-test-invalid', 'invalid MCP runtime test message', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const resolved = await loadVisibleMcp(actor, c.req.param('id'))
      const receipt = await mcpOperationCoordinator.runExclusive(resolved.id, async () => {
        const fresh = await loadVisibleMcp(actor, resolved.id)
        return runtimeTests.message(actor, fresh, c.req.param('sessionId'), parsed.data)
      })
      return c.json(receipt, 202)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/mcps/:id/runtime-test-sessions/:sessionId/cancel-turn',
      permissions: ['mcps:execute'],
      tokenAccess: 'allow',
      summary: 'Cancel the in-flight runtime-test turn',
    },
    async (c) => {
      const parsed = McpRuntimeTestCancelRequestSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('mcp-test-invalid', 'invalid MCP runtime test cancel payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const mcpId = c.req.param('id')
      return c.json(
        await mcpOperationCoordinator.runExclusive(mcpId, async () => {
          const mcp = await loadVisibleMcp(actor, mcpId)
          return runtimeTests.cancel(actor, mcp.id, c.req.param('sessionId'), parsed.data)
        }),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/mcps/:id/runtime-test-sessions/:sessionId/end',
      permissions: ['mcps:execute'],
      tokenAccess: 'allow',
      summary: 'End a runtime-test session',
    },
    async (c) => {
      const parsed = McpRuntimeTestEndRequestSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('mcp-test-invalid', 'invalid MCP runtime test end payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const mcpId = c.req.param('id')
      return c.json(
        await mcpOperationCoordinator.runExclusive(mcpId, async () => {
          const mcp = await loadVisibleMcp(actor, mcpId)
          return runtimeTests.end(actor, mcp.id, c.req.param('sessionId'))
        }),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/mcps/:id/runtime-test-sessions/:sessionId/session',
      permissions: ['mcps:read'],
      tokenAccess: 'allow',
      summary: 'Runtime-test session transcript',
    },
    async (c) => {
      const actor = actorOf(c)
      const mcpId = c.req.param('id')
      return c.json(
        await mcpOperationCoordinator.runExclusive(mcpId, async () => {
          const mcp = await loadVisibleMcp(actor, mcpId)
          return runtimeTests.sessionView(actor, mcp.id, c.req.param('sessionId'))
        }),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/mcps',
      permissions: ['mcps:create'],
      tokenAccess: 'allow',
      summary: 'Create an MCP server',
    },
    async (c) => {
      const body = await safeJsonOrEmpty(c.req.raw)
      const parsed = CreateMcpSchema.safeParse(body)
      if (!parsed.success) {
        throw new ValidationError('mcp-invalid', 'invalid mcp payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const created = await invokeOperation(
        catalog.operations.create,
        module.authorityFor(actor),
        parsed.data,
      )
      return c.json(serializeMcpFor(created, actor.source), 201)
    },
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/mcps/:id',
      permissions: ['mcps:update'],
      tokenAccess: 'allow',
      summary: 'Replace an MCP server',
    },
    async (c) => {
      const id = c.req.param('id')
      const body = await safeJsonOrEmpty(c.req.raw)
      const parsed = UpdateMcpRequestSchema.safeParse(body)
      if (!parsed.success) {
        throw new ValidationError('mcp-invalid', 'invalid mcp patch', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const updated = await invokeOperation(catalog.operations.update, module.authorityFor(actor), {
        id,
        update: parsed.data,
      })
      return c.json(serializeMcpFor(updated, actor.source))
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/mcps/:id',
      permissions: ['mcps:delete'],
      tokenAccess: 'allow',
      summary: 'Delete an MCP server',
    },
    async (c) => {
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
      const receipt = await invokeOperation(catalog.operations.delete, module.authorityFor(actor), {
        id: resolved.id,
        deletion: parsed.data,
      })
      captureDeleteSnapshot(c, actor, receipt.deleted)
      return c.body(null, 204)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/mcps/:id/rename',
      permissions: ['mcps:update'],
      tokenAccess: 'allow',
      summary: 'Rename an MCP server',
    },
    async (c) => {
      const id = c.req.param('id')
      const body = await safeJsonOrEmpty(c.req.raw)
      const parsed = RenameMcpRequestSchema.safeParse(body)
      if (!parsed.success) {
        throw new ValidationError('mcp-rename-invalid', 'invalid rename payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const renamed = await invokeOperation(catalog.operations.rename, module.authorityFor(actor), {
        id,
        rename: parsed.data,
      })
      return c.json(serializeMcpFor(renamed, actor.source))
    },
  )

  // RFC-030 — per-mcp probe endpoints.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/mcps/:id/probe',
      permissions: ['mcps:read'],
      tokenAccess: 'allow',
      summary: 'Read the stored probe result',
    },
    async (c) => {
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
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/mcps/:id/probe',
      permissions: ['mcps:execute'],
      tokenAccess: 'allow',
      summary: 'Probe an MCP server (network work, no resource write)',
    },
    async (c) => {
      const id = c.req.param('id')
      const body = await safeJsonOrEmpty(c.req.raw)
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
            const actualHash = captured.operationConfigHash
            if (actualHash !== expectedHash) {
              throw staleConflictError('mcp', 'the MCP changed; reload before probing', {
                expectedConfigHash: expectedHash,
                currentConfigHash: actualHash,
              })
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
            const operation = mcpOperationCoordinator.beginOperation(captured.id, mcpRouteNow(), [
              captured.updatedAt + 1,
              (persisted?.startedAt ?? 0) + 1,
            ])
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
            const authority = module.authorityFor(actor)
            const current = await invokeOperation(catalog.operations.get, authority, {
              id: resolved.id,
            })
            if (current === null) {
              const identity = await catalog.participants.aclIdentity.load(resolved.id)
              if (identity !== null) {
                throw staleConflictError(
                  'mcp',
                  'MCP access changed while the probe was running; result was discarded',
                )
              }
              throw staleConflictError(
                'mcp',
                'the MCP changed while the probe was running; result was discarded',
                { expectedConfigHash: expectedHash },
              )
            }
            if (current.operationConfigHash !== expectedHash) {
              throw staleConflictError(
                'mcp',
                'the MCP changed while the probe was running; result was discarded',
                { expectedConfigHash: expectedHash },
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
    },
  )

  // RFC-099 / RFC-223 — GET/PUT /api/mcps/:id/acl
  mountAclEndpoints(app, deps, {
    type: 'mcp',
    base: '/api/mcps',
    param: 'id',
    load: (_db, id) => catalog.participants.aclIdentity.load(id),
    coordinator: {
      runExclusive: (resourceId, task) => mcpOperationCoordinator.runExclusive(resourceId, task),
      loadById: (_db, resourceId) => catalog.participants.aclIdentity.load(resourceId),
      nextUpdatedAt: (row) => catalog.participants.aclIdentity.nextUpdatedAt(row.id),
    },
    afterWriteInTx: (tx, change) =>
      transitionMcpAclRuntimeTestsInTx(tx, {
        mcpId: change.resourceId,
        ownerUserId: change.ownerUserId,
        visibility: change.visibility,
        grantedUserIds: change.grantedUserIds,
        now: change.now,
      }),
    afterUpdate: () => runtimeTests.reconcileDurableIntents(),
  })
}
