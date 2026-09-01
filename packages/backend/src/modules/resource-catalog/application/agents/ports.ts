import type {
  AclResourceType,
  Agent,
  CreateAgent,
  Mcp,
  Plugin,
  RenameAgent,
  Skill,
  UpdateAgent,
} from '@agent-workflow/shared'
import type { AgentOperationContext } from '../../public/participants'
import type { AgentReferenceLabels, AgentReferenceLabelsInput } from '../../public/types'

export interface AgentMutationFence {
  readonly expectedUpdatedAt: number
  readonly expectedAclRevision: number
}

export interface AgentRepository {
  list(): Promise<readonly Agent[]>
  get(id: string): Promise<Agent | null>
  create(authority: AgentOperationContext, input: CreateAgent): Promise<Agent>
  update(
    authority: AgentOperationContext,
    id: string,
    patch: UpdateAgent,
    fence: AgentMutationFence,
  ): Promise<Agent>
  delete(authority: AgentOperationContext, id: string, fence: AgentMutationFence): Promise<void>
  rename(
    authority: AgentOperationContext,
    id: string,
    rename: RenameAgent,
    fence: AgentMutationFence,
  ): Promise<Agent>
  referenceLabels(
    authority: AgentOperationContext,
    input: AgentReferenceLabelsInput,
  ): Promise<AgentReferenceLabels>
}

export interface AgentAccessPort {
  filterVisible(authority: AgentOperationContext, rows: readonly Agent[]): Promise<readonly Agent[]>
  canView(authority: AgentOperationContext, row: Agent): Promise<boolean>
  requireResourceEdit(authority: AgentOperationContext, row: Agent): Promise<void>
  requireResourceGovern(authority: AgentOperationContext, row: Agent): Promise<void>
}

export interface AgentPolicyPort {
  excludeBuiltin(rows: readonly Agent[]): Agent[]
  assertMutable(row: Agent): void
}

export interface AgentMutationClock {
  nextUpdatedAt(agent: Agent): number
}

export interface AgentResourceInventorySkill extends Pick<
  Skill,
  'id' | 'name' | 'ownerUserId' | 'visibility'
> {
  readonly reservationState: string | null
  readonly versionState: string | null
  readonly available: boolean
}

export type AgentResourceInventoryMcp = Pick<
  Mcp,
  'id' | 'name' | 'enabled' | 'ownerUserId' | 'visibility'
>

export type AgentResourceInventoryPlugin = Pick<
  Plugin,
  'id' | 'name' | 'enabled' | 'ownerUserId' | 'visibility'
>

export interface AgentResourceInventory {
  readonly agents: Map<string, Agent>
  readonly skills: Map<string, AgentResourceInventorySkill>
  readonly mcps: Map<string, AgentResourceInventoryMcp>
  readonly plugins: Map<string, AgentResourceInventoryPlugin>
}

/** Provider-owned complete inventory load; visibility stays application-owned. */
export interface AgentResourceInventoryReadPort {
  load(): Promise<AgentResourceInventory>
}

/** Provider-selected complete inventory plus actor-visible projection. */
export interface AgentResourceInventorySource {
  load(): Promise<AgentResourceInventory>
  filterVisible<
    T extends {
      readonly id: string
      readonly ownerUserId?: string | null
      readonly visibility?: 'public' | 'private'
    },
  >(
    authority: AgentOperationContext,
    type: AclResourceType,
    rows: readonly T[],
  ): Promise<readonly T[]>
}
