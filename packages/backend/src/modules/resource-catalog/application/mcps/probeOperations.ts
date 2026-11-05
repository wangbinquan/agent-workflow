// RFC-030 / RFC-201 — the MCP probe use cases: the stored probe list, one MCP's
// stored probe, and a probe of one MCP's exact configuration.
//
// RFC-448: moved from routes/mcps.ts unchanged, statement for statement; the
// route now only parses HTTP. The caller passes the authority it derived for
// the request (`directOperationAuthority(directAuthority, actor)` — the same
// value every time for the same actor; visibility is evaluated at query time),
// so the post-probe re-check uses that same authority.
import type { McpProbe } from '@agent-workflow/shared'
import {
  ConflictError,
  DomainError,
  NotFoundError,
  ValidationError,
  staleConflictError,
} from '@/util/errors'
import { createLogger } from '@/util/log'
import type {
  McpAclIdentityParticipant,
  McpOperationContext,
  McpProbeMeasurement,
  McpProbeStore,
} from '../../public/participants'
import type { McpQueries } from '../../public/queries'
import type { McpCatalogResource } from '../../public/types'
import type { McpProbeCoordinatorPort, McpProbeOperations, McpProbeReceipt } from './ports'
import { getProbeByMcpId, listProbes, upsertProbe } from './probeRecords'

const log = createLogger('mcps-routes')

export interface McpProbeOperationDeps {
  readonly queries: McpQueries
  readonly aclIdentity: McpAclIdentityParticipant
  readonly store: McpProbeStore
  readonly coordinator: McpProbeCoordinatorPort
  /** The probe clock (also the MCP write clock — see composition). */
  readonly now: () => number
  /** One measurement where the deployment's Agents run their MCP servers. */
  readonly runProbe: (
    mcp: McpCatalogResource,
    options: { readonly startedAt: number },
  ) => Promise<McpProbeMeasurement>
}

export function createMcpProbeOperations(deps: McpProbeOperationDeps): McpProbeOperations {
  const { queries, aclIdentity, store, coordinator } = deps

  // RFC-099: missing and not-visible produce the identical 404 (D1).
  async function loadVisibleMcp(
    authority: McpOperationContext,
    id: string,
  ): Promise<McpCatalogResource> {
    const mcp = await queries.get(authority, { id })
    if (mcp === null) throw new NotFoundError('mcp-not-found', 'mcp not found')
    return mcp
  }

  return {
    // RFC-099: probe rows are keyed by mcpId — only visible MCPs' probes leak.
    async list(authority: McpOperationContext): Promise<McpProbe[]> {
      const list = await listProbes(store)
      const visibleMcps = await queries.list(authority)
      const allowed = new Set(visibleMcps.map((m) => m.id))
      return list.filter((p) => allowed.has(p.mcpId))
    },

    async read(authority: McpOperationContext, id: string): Promise<McpProbe> {
      // Existence check on the parent mcp keeps the 404 distinction:
      //   - mcp doesn't exist            → 404 mcp-not-found
      //   - mcp exists but never probed  → 404 probe-not-found
      const resolved = await loadVisibleMcp(authority, id)
      const { currentName, probe } = await coordinator.runExclusive(resolved.id, async () => {
        // Bind the read to the already-resolved stable id. Reload visibility
        // under the same fence used by rename/ACL so name reuse cannot expose a
        // different MCP's inventory or make the original probe disappear.
        const fresh = await loadVisibleMcp(authority, resolved.id)
        return {
          currentName: fresh.name,
          probe: await getProbeByMcpId(store, fresh.id),
        }
      })
      if (probe === null) {
        throw new NotFoundError(
          'probe-not-found',
          `mcp '${currentName}' has not been probed yet — POST /api/mcps/${resolved.id}/probe first`,
        )
      }
      return probe
    },

    async probe(
      authority: McpOperationContext,
      id: string,
      expectedHash: string,
    ): Promise<McpProbeReceipt> {
      const resolved = await loadVisibleMcp(authority, id)

      return await coordinator.runDeduplicatedOperation(resolved.id, expectedHash, async () => {
        const start = await coordinator.runExclusive(resolved.id, async () => {
          const captured = await loadVisibleMcp(authority, resolved.id)
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
          const persisted = await getProbeByMcpId(store, captured.id)
          const operation = coordinator.beginOperation(captured.id, deps.now(), [
            captured.updatedAt + 1,
            (persisted?.startedAt ?? 0) + 1,
          ])
          return { captured, ...operation }
        })

        let result
        try {
          result = await deps.runProbe(start.captured, { startedAt: start.startedAt })
        } catch (err) {
          if (err instanceof DomainError) throw err
          log.error('probeMcp unexpectedly threw', {
            mcp: start.captured.name,
            message: err instanceof Error ? err.message : String(err),
          })
          throw err
        }

        return coordinator.runExclusive(resolved.id, async () => {
          const current = await queries.get(authority, { id: resolved.id })
          if (current === null) {
            const identity = await aclIdentity.load(resolved.id)
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
          if (coordinator.latestGeneration(current.id) !== start.generation) {
            throw new ConflictError(
              'resource-operation-superseded',
              'a newer probe completed for this MCP; result was discarded',
              { generation: start.generation },
            )
          }
          const persisted = await upsertProbe(store, current.id, current.name, result)
          return { ...persisted, configHashUsed: expectedHash }
        })
      })
    },
  }
}
