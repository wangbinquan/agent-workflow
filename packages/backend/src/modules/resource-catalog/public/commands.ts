import type { CommandContext } from '@/modules/identity-access/public/participants'
import type { McpOperationContext } from './participants'
import type {
  CreateMcpCatalogInput,
  DeleteMcpCatalogInput,
  DeleteMcpCatalogReceipt,
  McpCatalogResource,
  RenameMcpCatalogInput,
  ResourceAclDocument,
  UpdateMcpCatalogInput,
  UpdateResourceAclRequest,
} from './types'

export interface ResourceAclCommands {
  update(context: CommandContext, request: UpdateResourceAclRequest): Promise<ResourceAclDocument>
}

export interface McpCommands {
  create(authority: McpOperationContext, input: CreateMcpCatalogInput): Promise<McpCatalogResource>
  update(authority: McpOperationContext, input: UpdateMcpCatalogInput): Promise<McpCatalogResource>
  delete(
    authority: McpOperationContext,
    input: DeleteMcpCatalogInput,
  ): Promise<DeleteMcpCatalogReceipt>
  rename(authority: McpOperationContext, input: RenameMcpCatalogInput): Promise<McpCatalogResource>
}
