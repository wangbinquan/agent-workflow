import type { McpPatch } from '../ports/mcpMutation'
import type { CreateMcp, Mcp, McpProbe } from '@agent-workflow/shared'
import type { McpOperationContext } from '../../public/participants'
import type { McpCatalogResource } from '../../public/types'

export interface McpAgentReference {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
}

export interface McpCreateRecord {
  readonly id: string
  readonly input: CreateMcp
  readonly ownerUserId: string
  readonly visibility: 'private'
  readonly aclRevision: 0
  readonly now: number
}

export interface McpRepository {
  list(): Promise<Mcp[]>
  get(id: string): Promise<Mcp | null>
  create(record: McpCreateRecord): Promise<Mcp>
  /** RFC-401 A2：stale、类型不可变、配置校验、no-op 与写入都在唯一的 MCP 写入参与者里（同一事务）。 */
  update(input: {
    readonly id: string
    readonly expectedConfigHash: string
    readonly patch: McpPatch
    readonly nextUpdatedAt: (current: Mcp) => Promise<number>
  }): Promise<Mcp>
  rename(input: {
    readonly id: string
    readonly newName: string
    readonly expectedConfigHash: string
    readonly updatedAt: number
  }): Promise<Mcp>
  findAgentReferences(id: string): Promise<readonly McpAgentReference[]>
  delete(input: {
    readonly id: string
    readonly expectedConfigHash: string
  }): Promise<readonly McpAgentReference[]>
}

export interface McpProjection {
  configHashOf(mcp: Mcp): string
  resourceOf(mcp: Mcp): McpCatalogResource
}

export interface McpAccessPort {
  filterVisible(authority: McpOperationContext, rows: readonly Mcp[]): Promise<readonly Mcp[]>
  canView(authority: McpOperationContext, row: Mcp): Promise<boolean>
  requireResourceEdit(authority: McpOperationContext, row: Mcp): Promise<void>
  requireResourceGovern(authority: McpOperationContext, row: Mcp): Promise<void>
  discloseAgentReferences(
    authority: McpOperationContext,
    references: readonly McpAgentReference[],
  ): Promise<{
    readonly visible: ReadonlyArray<{ readonly id: string; readonly name: string }>
    readonly hiddenCount: number
  }>
}

export interface McpOperationCoordinatorPort {
  runExclusive<T>(resourceId: string, task: () => Promise<T>): Promise<T>
}

/** RFC-448: the coordinator surface the probe use cases need; the shared
 * process-wide MCP instance provides it. */
export interface McpProbeCoordinatorPort extends McpOperationCoordinatorPort {
  runDeduplicatedOperation<T>(
    resourceId: string,
    operationConfigHash: string,
    operation: () => Promise<T>,
  ): Promise<T>
  beginOperation(
    resourceId: string,
    now: number,
    timestampFloors: readonly number[],
  ): { readonly generation: number; readonly startedAt: number }
  latestGeneration(resourceId: string): number
}

/** A stored probe plus the configuration hash it measured. */
export type McpProbeReceipt = McpProbe & { readonly configHashUsed: string }

/** RFC-448: the MCP probe use cases behind `/api/mcps/probes` and
 * `/api/mcps/:id/probe` (RFC-030 / RFC-201). */
export interface McpProbeOperations {
  /** Stored probes of the MCPs visible to `authority`. */
  list(authority: McpOperationContext): Promise<McpProbe[]>
  /** One visible MCP's stored probe; `probe-not-found` if it was never probed. */
  read(authority: McpOperationContext, id: string): Promise<McpProbe>
  /** Probe the MCP's exact configuration and store the result. */
  probe(
    authority: McpOperationContext,
    id: string,
    expectedConfigHash: string,
  ): Promise<McpProbeReceipt>
}

export interface McpMutationClock {
  next(mcp: Mcp): Promise<number>
}

export interface McpRuntimeLifecyclePort {
  prepareDelete(mcpId: string): Promise<void>
  reconcileDurableIntents(): Promise<void>
}
