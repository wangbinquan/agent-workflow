// RFC-589 — the agent catalog operation descriptors and the inputs / receipts the agent HTTP binding passes them. They left
// `public/` when the agent binding moved into this module's inbound layer: no other module consumes them.
import type {
  CommandOperationDescriptor,
  QueryOperationDescriptor,
} from '@/platform/operations/contracts'
import type { Agent, CreateAgent, RenameAgentRequest } from '@agent-workflow/shared'
import type { ResourceAclOperationDescriptors } from '../../public/operations'
import type { AgentOperationContext } from '../../public/participants'
import type {
  AgentCatalogResource,
  GetAgentCatalogInput,
  JsonBodySubmission,
} from '../../public/types'

export interface AgentOperationDescriptors extends ResourceAclOperationDescriptors<AgentOperationContext> {
  readonly list: QueryOperationDescriptor<
    Record<never, never>,
    AgentCatalogResource[],
    AgentOperationContext
  >
  readonly get: QueryOperationDescriptor<
    GetAgentCatalogInput,
    AgentCatalogResource | null,
    AgentOperationContext
  >
  readonly create: CommandOperationDescriptor<
    CreateAgentCatalogInput,
    AgentCatalogResource,
    AgentOperationContext
  >
  readonly update: CommandOperationDescriptor<
    UpdateAgentCatalogInput,
    AgentCatalogResource,
    AgentOperationContext
  >
  readonly delete: CommandOperationDescriptor<
    DeleteAgentCatalogInput,
    DeleteAgentCatalogReceipt,
    AgentOperationContext
  >
  readonly rename: CommandOperationDescriptor<
    RenameAgentCatalogInput,
    AgentCatalogResource,
    AgentOperationContext
  >
}

export type CreateAgentCatalogInput = CreateAgent

export interface UpdateAgentCatalogInput {
  readonly id: string
  readonly submission: JsonBodySubmission
}

export interface DeleteAgentCatalogInput {
  readonly id: string
  readonly submission: JsonBodySubmission
}

export interface DeleteAgentCatalogReceipt {
  readonly deleted: Agent
}

export interface RenameAgentCatalogInput {
  readonly id: string
  readonly rename: RenameAgentRequest
}
