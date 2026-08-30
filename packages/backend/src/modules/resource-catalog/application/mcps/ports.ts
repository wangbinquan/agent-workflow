import type { CreateMcp, Mcp } from '@agent-workflow/shared'
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

export interface McpUpdateSet {
  readonly description?: string
  readonly config?: Mcp['config']
  readonly enabled?: boolean
  readonly updatedAt: number
}

export interface McpRepository {
  list(): Promise<Mcp[]>
  get(id: string): Promise<Mcp | null>
  create(record: McpCreateRecord): Promise<Mcp>
  update(input: {
    readonly id: string
    readonly expectedConfigHash: string
    readonly set: McpUpdateSet
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
  requireEdit(authority: McpOperationContext, row: Mcp): Promise<void>
  requireGovern(authority: McpOperationContext, row: Mcp): Promise<void>
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

export interface McpMutationClock {
  next(mcp: Mcp): Promise<number>
}

export interface McpRuntimeLifecyclePort {
  prepareDelete(mcpId: string): Promise<void>
  reconcileDurableIntents(): Promise<void>
}
