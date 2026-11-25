// RFC-345 closed, data-only Resource Catalog operation descriptor and module contracts.

import type { ResourceAcl } from '@agent-workflow/shared'
import type { CommandContext, QueryContext } from '@/modules/identity-access/public/participants'
import type {
  CommandOperationDescriptor,
  IdempotentCommandOperationDescriptor,
  QueryOperationDescriptor,
} from '@/platform/operations/contracts'
import type { McpAclIdentityParticipant, McpOperationContext } from './participants'
import type { McpQueries } from './queries'
import type {
  ApplyResourcePackage,
  CreateMcpCatalogInput,
  DeleteMcpCatalogInput,
  DeleteMcpCatalogReceipt,
  ExportResourcePackage,
  GetMcpCatalogInput,
  GetResourceAclCatalogInput,
  InspectResourcePackage,
  McpCatalogResource,
  RenameMcpCatalogInput,
  UpdateMcpCatalogInput,
  UpdateResourceAclCatalogInput,
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
