import type {
  Agent,
  CopyWorkflowRequest,
  CopyWorkgroupRequest,
  CreateAgent,
  CreateMcp,
  CreatePlugin,
  CreateWorkgroup,
  DeleteMcp,
  DeletePlugin,
  McpOperationResource,
  PluginOperationRequest,
  PluginOperationResource,
  PluginUpdateCheck,
  PluginUpgradeResult,
  RenameAgentRequest,
  RenameMcpRequest,
  RenamePluginRequest,
  RenameWorkgroup,
  SaveWorkflowReceipt,
  SaveWorkgroupReceipt,
  Skill,
  UpdateMcpRequest,
  UpdatePluginRequest,
  UpdateWorkgroup,
  WorkgroupDetail,
} from '@agent-workflow/shared'

interface JsonBodySubmission {
  readonly kind: 'json-body'
  readonly body: string
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

export interface RenameAgentCatalogInput {
  readonly id: string
  readonly rename: RenameAgentRequest
}

export interface DeleteAgentCatalogReceipt {
  readonly deleted: Agent
}

export interface CreateSkillCatalogInput {
  readonly submission: JsonBodySubmission
}

export interface SaveSkillCatalogInput {
  readonly id: string
  readonly submission: JsonBodySubmission
}

export interface DeleteSkillCatalogInput {
  readonly id: string
  readonly submission: JsonBodySubmission
}

export interface DeleteSkillCatalogReceipt {
  readonly deleted: Skill
}

export interface CreateWorkflowCatalogInput {
  readonly submission: JsonBodySubmission
}

export interface CopyWorkflowCatalogInput {
  readonly id: string
  readonly copy: CopyWorkflowRequest
}

export interface UpdateWorkflowCatalogInput {
  readonly id: string
  readonly submission: JsonBodySubmission
}

export interface DeleteWorkflowCatalogInput {
  readonly id: string
  readonly submission: JsonBodySubmission
}

export type UpdateWorkflowCatalogReceipt = SaveWorkflowReceipt

export interface DeleteWorkflowCatalogReceipt {
  readonly deleted: Readonly<{
    readonly id: string
    readonly name: string
    readonly ownerUserId: string | null
    readonly visibility: 'public' | 'private'
    readonly builtin: boolean
  }>
  readonly clientMutationId: string
  readonly deletedVersion: number
}

export type CreateMcpCatalogInput = CreateMcp

export interface UpdateMcpCatalogInput {
  readonly id: string
  readonly update: UpdateMcpRequest
}

export interface DeleteMcpCatalogInput {
  readonly id: string
  readonly deletion: DeleteMcp
}

export interface RenameMcpCatalogInput {
  readonly id: string
  readonly rename: RenameMcpRequest
}

export interface DeleteMcpCatalogReceipt {
  readonly deleted: McpOperationResource
}

export type CreatePluginCatalogInput = CreatePlugin

export interface UpdatePluginCatalogInput {
  readonly id: string
  readonly update: UpdatePluginRequest
}

export interface DeletePluginCatalogInput {
  readonly id: string
  readonly deletion: DeletePlugin
}

export interface RenamePluginCatalogInput {
  readonly id: string
  readonly rename: RenamePluginRequest
}

export interface CheckPluginUpdateCatalogInput {
  readonly id: string
  readonly operation: PluginOperationRequest
}

export interface UpgradePluginCatalogInput {
  readonly id: string
  readonly operation: PluginOperationRequest
}

export interface DeletePluginCatalogReceipt {
  readonly deleted: PluginOperationResource
}

export type CheckPluginUpdateCatalogReceipt = PluginUpdateCheck
export type UpgradePluginCatalogReceipt = PluginUpgradeResult

export type CreateWorkgroupCatalogInput = CreateWorkgroup

export interface CopyWorkgroupCatalogInput {
  readonly id: string
  readonly copy: CopyWorkgroupRequest
}

export interface UpdateWorkgroupCatalogInput {
  readonly id: string
  readonly update: UpdateWorkgroup
}

export interface DeleteWorkgroupCatalogInput {
  readonly id: string
  readonly deletion: JsonBodySubmission
}

export interface RenameWorkgroupCatalogInput {
  readonly id: string
  readonly rename: RenameWorkgroup
}

export type UpdateWorkgroupCatalogReceipt = SaveWorkgroupReceipt

export interface DeleteWorkgroupCatalogReceipt {
  readonly id: string
  readonly deletedVersion: number
  readonly clientMutationId: string
  readonly deleted: WorkgroupDetail
}
