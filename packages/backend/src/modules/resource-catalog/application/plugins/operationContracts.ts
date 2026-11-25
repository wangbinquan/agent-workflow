// RFC-581 — the plugin operation descriptors and their catalog inputs / receipts. They left `public/` with the plugin
// HTTP binding (now `inbound/http/pluginRoutes.ts`).
import type {
  CommandOperationDescriptor,
  QueryOperationDescriptor,
} from '@/platform/operations/contracts'
import type {
  CreatePlugin,
  DeletePlugin,
  PluginOperationRequest,
  PluginOperationResource,
  PluginUpdateCheck,
  PluginUpgradeResult,
  RenamePluginRequest,
  UpdatePluginRequest,
} from '@agent-workflow/shared'
import type { ResourceAclOperationDescriptors } from '../../public/operations'
import type { PluginOperationContext } from '../../public/participants'
import type { GetPluginCatalogInput, PluginCatalogResource } from '../../public/types'

export type CreatePluginCatalogInput = CreatePlugin

export interface UpdatePluginCatalogInput {
  readonly id: string
  readonly update: UpdatePluginRequest
}

export interface DeletePluginCatalogInput {
  readonly id: string
  readonly deletion: DeletePlugin
}

export interface DeletePluginCatalogReceipt {
  readonly deleted: PluginOperationResource
}

export interface RenamePluginCatalogInput {
  readonly id: string
  readonly rename: RenamePluginRequest
}

export interface CheckPluginUpdateCatalogInput {
  readonly id: string
  readonly operation: PluginOperationRequest
}

export type CheckPluginUpdateCatalogReceipt = PluginUpdateCheck

export interface UpgradePluginCatalogInput {
  readonly id: string
  readonly operation: PluginOperationRequest
}

export type UpgradePluginCatalogReceipt = PluginUpgradeResult

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
