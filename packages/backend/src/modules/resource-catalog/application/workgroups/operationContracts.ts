// RFC-589 — the workgroup catalog operation descriptors and the inputs / receipts the workgroup HTTP binding passes them.
// They left `public/` when the workgroup binding moved into this module's inbound layer: no other module consumes them.
import type {
  CommandOperationDescriptor,
  QueryOperationDescriptor,
} from '@/platform/operations/contracts'
import type {
  CopyWorkgroupRequest,
  CreateWorkgroup,
  RenameWorkgroup,
  SaveWorkgroupReceipt,
  UpdateWorkgroup,
  Workgroup,
  WorkgroupDetail,
} from '@agent-workflow/shared'
import type { ResourceAclOperationDescriptors } from '../../public/operations'
import type { WorkgroupOperationContext } from '../../public/participants'
import type {
  GetWorkgroupCatalogInput,
  JsonBodySubmission,
  WorkgroupCatalogDetail,
} from '../../public/types'

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

export type CreateWorkgroupCatalogInput = CreateWorkgroup

export interface CopyWorkgroupCatalogInput {
  readonly id: string
  readonly copy: CopyWorkgroupRequest
}

export interface UpdateWorkgroupCatalogInput {
  readonly id: string
  readonly update: UpdateWorkgroup
}

export type UpdateWorkgroupCatalogReceipt = SaveWorkgroupReceipt

export interface DeleteWorkgroupCatalogInput {
  readonly id: string
  readonly deletion: JsonBodySubmission
}

export interface DeleteWorkgroupCatalogReceipt {
  readonly id: string
  readonly deletedVersion: number
  readonly clientMutationId: string
  readonly deleted: WorkgroupDetail
}

export interface RenameWorkgroupCatalogInput {
  readonly id: string
  readonly rename: RenameWorkgroup
}
