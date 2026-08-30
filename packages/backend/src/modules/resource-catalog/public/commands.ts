import type { CommandContext } from '@/modules/identity-access/public/participants'
import type { McpOperationContext } from './participants'
import type { PluginOperationContext } from './participants'
import type { WorkgroupOperationContext } from './participants'
import type {
  CheckPluginUpdateCatalogInput,
  CheckPluginUpdateCatalogReceipt,
  CreateMcpCatalogInput,
  CreatePluginCatalogInput,
  DeleteMcpCatalogInput,
  DeleteMcpCatalogReceipt,
  DeletePluginCatalogInput,
  DeletePluginCatalogReceipt,
  McpCatalogResource,
  PluginCatalogResource,
  RenameMcpCatalogInput,
  RenamePluginCatalogInput,
  ResourceAclDocument,
  UpdateMcpCatalogInput,
  UpdatePluginCatalogInput,
  UpdateResourceAclRequest,
  UpgradePluginCatalogInput,
  UpgradePluginCatalogReceipt,
  CopyWorkgroupCatalogInput,
  CreateWorkgroupCatalogInput,
  DeleteWorkgroupCatalogInput,
  DeleteWorkgroupCatalogReceipt,
  RenameWorkgroupCatalogInput,
  UpdateWorkgroupCatalogInput,
  UpdateWorkgroupCatalogReceipt,
  WorkgroupCatalogDetail,
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

export interface PluginCommands {
  create(
    authority: PluginOperationContext,
    input: CreatePluginCatalogInput,
  ): Promise<PluginCatalogResource>
  update(
    authority: PluginOperationContext,
    input: UpdatePluginCatalogInput,
  ): Promise<PluginCatalogResource>
  delete(
    authority: PluginOperationContext,
    input: DeletePluginCatalogInput,
  ): Promise<DeletePluginCatalogReceipt>
  rename(
    authority: PluginOperationContext,
    input: RenamePluginCatalogInput,
  ): Promise<PluginCatalogResource>
}

export interface PluginUpdateCommands {
  checkUpdate(
    authority: PluginOperationContext,
    input: CheckPluginUpdateCatalogInput,
  ): Promise<CheckPluginUpdateCatalogReceipt>
  upgrade(
    authority: PluginOperationContext,
    input: UpgradePluginCatalogInput,
  ): Promise<UpgradePluginCatalogReceipt>
}

export interface WorkgroupCommands {
  create(
    authority: WorkgroupOperationContext,
    input: CreateWorkgroupCatalogInput,
  ): Promise<WorkgroupCatalogDetail>
  copy(
    authority: WorkgroupOperationContext,
    input: CopyWorkgroupCatalogInput,
  ): Promise<WorkgroupCatalogDetail>
  update(
    authority: WorkgroupOperationContext,
    input: UpdateWorkgroupCatalogInput,
  ): Promise<UpdateWorkgroupCatalogReceipt>
  delete(
    authority: WorkgroupOperationContext,
    input: DeleteWorkgroupCatalogInput,
  ): Promise<DeleteWorkgroupCatalogReceipt>
  rename(
    authority: WorkgroupOperationContext,
    input: RenameWorkgroupCatalogInput,
  ): Promise<UpdateWorkgroupCatalogReceipt>
}
