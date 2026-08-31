import type { CommandContext } from '@/modules/identity-access/public/participants'
import type { AgentOperationContext } from './participants'
import type { McpOperationContext } from './participants'
import type { PluginOperationContext } from './participants'
import type { SkillOperationContext } from './participants'
import type { WorkflowOperationContext } from './participants'
import type { WorkgroupOperationContext } from './participants'
import type {
  AgentCatalogResource,
  CheckPluginUpdateCatalogInput,
  CheckPluginUpdateCatalogReceipt,
  CreateMcpCatalogInput,
  CreateAgentCatalogInput,
  CreatePluginCatalogInput,
  DeleteMcpCatalogInput,
  DeleteAgentCatalogInput,
  DeleteAgentCatalogReceipt,
  DeleteMcpCatalogReceipt,
  DeletePluginCatalogInput,
  DeletePluginCatalogReceipt,
  McpCatalogResource,
  PluginCatalogResource,
  RenameMcpCatalogInput,
  RenameAgentCatalogInput,
  RenamePluginCatalogInput,
  ResourceAclDocument,
  CreateSkillCatalogInput,
  DeleteSkillCatalogInput,
  DeleteSkillCatalogReceipt,
  DeleteSkillFileCatalogInput,
  DeleteSkillFileCatalogReceipt,
  RestoreSkillVersionCatalogInput,
  RestoreSkillVersionCatalogReceipt,
  SaveSkillCatalogInput,
  SkillCatalogContent,
  SkillCatalogResource,
  WriteSkillFileCatalogInput,
  WriteSkillFileCatalogReceipt,
  UpdateMcpCatalogInput,
  UpdateAgentCatalogInput,
  UpdatePluginCatalogInput,
  UpdateResourceAclRequest,
  UpgradePluginCatalogInput,
  UpgradePluginCatalogReceipt,
  CopyWorkflowCatalogInput,
  CreateWorkflowCatalogInput,
  DeleteWorkflowCatalogInput,
  DeleteWorkflowCatalogReceipt,
  UpdateWorkflowCatalogInput,
  UpdateWorkflowCatalogReceipt,
  WorkflowCatalogDetail,
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

export interface AgentCommands {
  create(
    authority: AgentOperationContext,
    input: CreateAgentCatalogInput,
  ): Promise<AgentCatalogResource>
  update(
    authority: AgentOperationContext,
    input: UpdateAgentCatalogInput,
  ): Promise<AgentCatalogResource>
  delete(
    authority: AgentOperationContext,
    input: DeleteAgentCatalogInput,
  ): Promise<DeleteAgentCatalogReceipt>
  rename(
    authority: AgentOperationContext,
    input: RenameAgentCatalogInput,
  ): Promise<AgentCatalogResource>
}

export interface SkillCommands {
  create(
    authority: SkillOperationContext,
    input: CreateSkillCatalogInput,
  ): Promise<SkillCatalogResource>
  save(authority: SkillOperationContext, input: SaveSkillCatalogInput): Promise<SkillCatalogContent>
  delete(
    authority: SkillOperationContext,
    input: DeleteSkillCatalogInput,
  ): Promise<DeleteSkillCatalogReceipt>
}

export interface SkillFileCommands {
  write(
    authority: SkillOperationContext,
    input: WriteSkillFileCatalogInput,
  ): Promise<WriteSkillFileCatalogReceipt>
  delete(
    authority: SkillOperationContext,
    input: DeleteSkillFileCatalogInput,
  ): Promise<DeleteSkillFileCatalogReceipt>
}

export interface SkillVersionCommands {
  restore(
    authority: SkillOperationContext,
    input: RestoreSkillVersionCatalogInput,
  ): Promise<RestoreSkillVersionCatalogReceipt>
}

export interface WorkflowCommands {
  create(
    authority: WorkflowOperationContext,
    input: CreateWorkflowCatalogInput,
  ): Promise<WorkflowCatalogDetail>
  copy(
    authority: WorkflowOperationContext,
    input: CopyWorkflowCatalogInput,
  ): Promise<WorkflowCatalogDetail>
  update(
    authority: WorkflowOperationContext,
    input: UpdateWorkflowCatalogInput,
  ): Promise<UpdateWorkflowCatalogReceipt>
  delete(
    authority: WorkflowOperationContext,
    input: DeleteWorkflowCatalogInput,
  ): Promise<DeleteWorkflowCatalogReceipt>
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
