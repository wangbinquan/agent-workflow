// RFC-345 closed, data-only Resource Catalog operation descriptor and module contracts.

import type { FileNode, ResourceAcl, Workgroup } from '@agent-workflow/shared'
import type { CommandContext, QueryContext } from '@/modules/identity-access/public/participants'
import type {
  CommandOperationDescriptor,
  IdempotentCommandOperationDescriptor,
  QueryOperationDescriptor,
} from '@/platform/operations/contracts'
import type {
  AgentOperationContext,
  McpAclIdentityParticipant,
  McpOperationContext,
  PluginOperationContext,
  SkillOperationContext,
  WorkgroupOperationContext,
} from './participants'
import type { McpQueries } from './queries'
import type {
  AgentCatalogResource,
  ApplyResourcePackage,
  CheckPluginUpdateCatalogInput,
  CheckPluginUpdateCatalogReceipt,
  CopyWorkgroupCatalogInput,
  CreateAgentCatalogInput,
  CreateMcpCatalogInput,
  CreatePluginCatalogInput,
  CreateSkillCatalogInput,
  CreateWorkgroupCatalogInput,
  DeleteAgentCatalogInput,
  DeleteAgentCatalogReceipt,
  DeleteMcpCatalogInput,
  DeleteMcpCatalogReceipt,
  DeletePluginCatalogInput,
  DeletePluginCatalogReceipt,
  DeleteSkillCatalogInput,
  DeleteSkillCatalogReceipt,
  DeleteSkillFileCatalogInput,
  DeleteSkillFileCatalogReceipt,
  DeleteWorkgroupCatalogInput,
  DeleteWorkgroupCatalogReceipt,
  DiffSkillVersionsCatalogInput,
  ExportResourcePackage,
  GetAgentCatalogInput,
  GetMcpCatalogInput,
  GetPluginCatalogInput,
  GetResourceAclCatalogInput,
  GetSkillCatalogInput,
  GetSkillContentCatalogInput,
  GetSkillVersionContentCatalogInput,
  GetWorkgroupCatalogInput,
  InspectResourcePackage,
  ListSkillFilesCatalogInput,
  ListSkillVersionsCatalogInput,
  McpCatalogResource,
  PluginCatalogResource,
  ReadSkillFileCatalogInput,
  RenameAgentCatalogInput,
  RenameMcpCatalogInput,
  RenamePluginCatalogInput,
  RenameWorkgroupCatalogInput,
  RestoreSkillVersionCatalogInput,
  RestoreSkillVersionCatalogReceipt,
  SaveSkillCatalogInput,
  SkillCatalogContent,
  SkillCatalogResource,
  SkillCatalogVersion,
  SkillCatalogVersionContent,
  SkillCatalogVersionDiff,
  UpdateAgentCatalogInput,
  UpdateMcpCatalogInput,
  UpdatePluginCatalogInput,
  UpdateResourceAclCatalogInput,
  UpdateWorkgroupCatalogInput,
  UpdateWorkgroupCatalogReceipt,
  UpgradePluginCatalogInput,
  UpgradePluginCatalogReceipt,
  WorkgroupCatalogDetail,
  WriteSkillFileCatalogInput,
  WriteSkillFileCatalogReceipt,
} from './types'

/** RFC-580: exported for the workflow descriptors that moved into `application/`; every ACL-governed descriptor here extends it. */
export interface ResourceAclOperationDescriptors<Context> {
  readonly getAcl: QueryOperationDescriptor<GetResourceAclCatalogInput, ResourceAcl, Context>
  readonly updateAcl: CommandOperationDescriptor<
    UpdateResourceAclCatalogInput,
    ResourceAcl,
    Context
  >
}

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

export interface SkillOperationDescriptors extends ResourceAclOperationDescriptors<SkillOperationContext> {
  readonly list: QueryOperationDescriptor<
    Record<never, never>,
    SkillCatalogResource[],
    SkillOperationContext
  >
  readonly get: QueryOperationDescriptor<
    GetSkillCatalogInput,
    SkillCatalogResource | null,
    SkillOperationContext
  >
  readonly create: CommandOperationDescriptor<
    CreateSkillCatalogInput,
    SkillCatalogResource,
    SkillOperationContext
  >
  readonly save: CommandOperationDescriptor<
    SaveSkillCatalogInput,
    SkillCatalogContent,
    SkillOperationContext
  >
  readonly delete: CommandOperationDescriptor<
    DeleteSkillCatalogInput,
    DeleteSkillCatalogReceipt,
    SkillOperationContext
  >
  readonly content: QueryOperationDescriptor<
    GetSkillContentCatalogInput,
    SkillCatalogContent,
    SkillOperationContext
  >
  readonly listFiles: QueryOperationDescriptor<
    ListSkillFilesCatalogInput,
    FileNode[],
    SkillOperationContext
  >
  readonly readFile: QueryOperationDescriptor<
    ReadSkillFileCatalogInput,
    Readonly<{ path: string; content: string }>,
    SkillOperationContext
  >
  readonly writeFile: CommandOperationDescriptor<
    WriteSkillFileCatalogInput,
    WriteSkillFileCatalogReceipt,
    SkillOperationContext
  >
  readonly deleteFile: CommandOperationDescriptor<
    DeleteSkillFileCatalogInput,
    DeleteSkillFileCatalogReceipt,
    SkillOperationContext
  >
  readonly listVersions: QueryOperationDescriptor<
    ListSkillVersionsCatalogInput,
    SkillCatalogVersion[],
    SkillOperationContext
  >
  readonly diffVersions: QueryOperationDescriptor<
    DiffSkillVersionsCatalogInput,
    SkillCatalogVersionDiff,
    SkillOperationContext
  >
  readonly getVersionContent: QueryOperationDescriptor<
    GetSkillVersionContentCatalogInput,
    SkillCatalogVersionContent,
    SkillOperationContext
  >
  readonly restoreVersion: CommandOperationDescriptor<
    RestoreSkillVersionCatalogInput,
    RestoreSkillVersionCatalogReceipt,
    SkillOperationContext
  >
}

export interface McpOperationDescriptors extends ResourceAclOperationDescriptors<McpOperationContext> {
  readonly list: QueryOperationDescriptor<
    Record<never, never>,
    McpCatalogResource[],
    McpOperationContext
  >
  readonly get: QueryOperationDescriptor<
    GetMcpCatalogInput,
    McpCatalogResource | null,
    McpOperationContext
  >
  readonly create: CommandOperationDescriptor<
    CreateMcpCatalogInput,
    McpCatalogResource,
    McpOperationContext
  >
  readonly update: CommandOperationDescriptor<
    UpdateMcpCatalogInput,
    McpCatalogResource,
    McpOperationContext
  >
  readonly delete: CommandOperationDescriptor<
    DeleteMcpCatalogInput,
    DeleteMcpCatalogReceipt,
    McpOperationContext
  >
  readonly rename: CommandOperationDescriptor<
    RenameMcpCatalogInput,
    McpCatalogResource,
    McpOperationContext
  >
}

export interface McpCatalogModule {
  readonly queries: McpQueries
  readonly operations: McpOperationDescriptors
  readonly participants: Readonly<{
    aclIdentity: McpAclIdentityParticipant
  }>
}

export interface PluginOperationDescriptors extends ResourceAclOperationDescriptors<PluginOperationContext> {
  readonly list: QueryOperationDescriptor<
    Record<never, never>,
    PluginCatalogResource[],
    PluginOperationContext
  >
  readonly get: QueryOperationDescriptor<
    GetPluginCatalogInput,
    PluginCatalogResource | null,
    PluginOperationContext
  >
  readonly create: CommandOperationDescriptor<
    CreatePluginCatalogInput,
    PluginCatalogResource,
    PluginOperationContext
  >
  readonly update: CommandOperationDescriptor<
    UpdatePluginCatalogInput,
    PluginCatalogResource,
    PluginOperationContext
  >
  readonly delete: CommandOperationDescriptor<
    DeletePluginCatalogInput,
    DeletePluginCatalogReceipt,
    PluginOperationContext
  >
  readonly rename: CommandOperationDescriptor<
    RenamePluginCatalogInput,
    PluginCatalogResource,
    PluginOperationContext
  >
  readonly checkUpdate: CommandOperationDescriptor<
    CheckPluginUpdateCatalogInput,
    CheckPluginUpdateCatalogReceipt,
    PluginOperationContext
  >
  readonly upgrade: CommandOperationDescriptor<
    UpgradePluginCatalogInput,
    UpgradePluginCatalogReceipt,
    PluginOperationContext
  >
}

export interface WorkgroupOperationDescriptors extends ResourceAclOperationDescriptors<WorkgroupOperationContext> {
  readonly list: QueryOperationDescriptor<
    Record<never, never>,
    Workgroup[],
    WorkgroupOperationContext
  >
  readonly get: QueryOperationDescriptor<
    GetWorkgroupCatalogInput,
    WorkgroupCatalogDetail | null,
    WorkgroupOperationContext
  >
  readonly create: CommandOperationDescriptor<
    CreateWorkgroupCatalogInput,
    WorkgroupCatalogDetail,
    WorkgroupOperationContext
  >
  readonly copy: CommandOperationDescriptor<
    CopyWorkgroupCatalogInput,
    WorkgroupCatalogDetail,
    WorkgroupOperationContext
  >
  readonly update: CommandOperationDescriptor<
    UpdateWorkgroupCatalogInput,
    UpdateWorkgroupCatalogReceipt,
    WorkgroupOperationContext
  >
  readonly delete: CommandOperationDescriptor<
    DeleteWorkgroupCatalogInput,
    DeleteWorkgroupCatalogReceipt,
    WorkgroupOperationContext
  >
  readonly rename: CommandOperationDescriptor<
    RenameWorkgroupCatalogInput,
    UpdateWorkgroupCatalogReceipt,
    WorkgroupOperationContext
  >
}

interface ResourcePackagePreviewReceipt {
  readonly previewId: string
}

interface GetResourcePackagePreview {
  readonly previewId: string
}

interface ResourcePackagePreviewView {
  readonly previewId: string
  readonly document: string
}

interface ResourcePackageApplyReceipt {
  readonly receiptId: string
}

interface GetResourcePackageApplyReceipt {
  readonly receiptId: string
}

interface ResourcePackageApplyReceiptView {
  readonly receiptId: string
  readonly document: string
}

interface ResourcePackageExportReceipt {
  readonly packageId: string
  readonly filename: string
}

export interface ResourcePackageOperationDescriptors {
  readonly inspect: CommandOperationDescriptor<
    InspectResourcePackage,
    ResourcePackagePreviewReceipt,
    CommandContext
  >
  readonly apply: IdempotentCommandOperationDescriptor<
    ApplyResourcePackage,
    ResourcePackageApplyReceipt,
    CommandContext
  >
  readonly getPreview: QueryOperationDescriptor<
    GetResourcePackagePreview,
    ResourcePackagePreviewView,
    QueryContext
  >
  readonly getReceipt: QueryOperationDescriptor<
    GetResourcePackageApplyReceipt,
    ResourcePackageApplyReceiptView,
    QueryContext
  >
  readonly exports: Readonly<{
    agent: CommandOperationDescriptor<
      ExportResourcePackage,
      ResourcePackageExportReceipt,
      CommandContext
    >
    skill: CommandOperationDescriptor<
      ExportResourcePackage,
      ResourcePackageExportReceipt,
      CommandContext
    >
    mcp: CommandOperationDescriptor<
      ExportResourcePackage,
      ResourcePackageExportReceipt,
      CommandContext
    >
    plugin: CommandOperationDescriptor<
      ExportResourcePackage,
      ResourcePackageExportReceipt,
      CommandContext
    >
    workflow: CommandOperationDescriptor<
      ExportResourcePackage,
      ResourcePackageExportReceipt,
      CommandContext
    >
    workgroup: CommandOperationDescriptor<
      ExportResourcePackage,
      ResourcePackageExportReceipt,
      CommandContext
    >
    capability_template: CommandOperationDescriptor<
      ExportResourcePackage,
      ResourcePackageExportReceipt,
      CommandContext
    >
  }>
}

export interface ResourcePackageCatalogModule {
  readonly operations: ResourcePackageOperationDescriptors
}
