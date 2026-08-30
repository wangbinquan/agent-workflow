import type {
  CreateWorkgroup,
  SaveWorkgroupReceipt,
  Workgroup,
  WorkgroupDetail,
  WorkgroupDraftSnapshot,
} from '@agent-workflow/shared'
import type { WorkgroupOperationContext } from '../../public/participants'
import type {
  CopyWorkgroupCatalogInput,
  DeleteWorkgroupCatalogInput,
  DeleteWorkgroupCatalogReceipt,
  UpdateWorkgroupCatalogInput,
  WorkgroupCatalogResource,
} from '../../public/types'

export interface WorkgroupInitialAcl {
  readonly ownerUserId: string | null
  readonly visibility: 'private'
  readonly aclRevision: 0
}

export interface WorkgroupDeletedAudience {
  readonly kind: 'workgroup.deleted-audience'
  readonly workgroupId: string
  readonly visibility: 'public' | 'private'
  readonly ownerUserId: string | null
  readonly grantedUserIds: ReadonlySet<string>
}

export interface WorkgroupSaveResult {
  readonly receipt: SaveWorkgroupReceipt
  readonly committed: boolean
}

export interface WorkgroupDeleteResult {
  readonly receipt: DeleteWorkgroupCatalogReceipt
  readonly audience: WorkgroupDeletedAudience
}

export interface WorkgroupRepository {
  list(): Promise<readonly Workgroup[]>
  get(id: string): Promise<WorkgroupDetail | null>
  create(input: {
    readonly authority: WorkgroupOperationContext
    readonly id: string
    readonly document: CreateWorkgroup
    readonly initialAcl: WorkgroupInitialAcl
    readonly now: number
  }): Promise<WorkgroupDetail>
  copy(input: {
    readonly authority: WorkgroupOperationContext
    readonly request: CopyWorkgroupCatalogInput
    readonly id: string
    readonly now: number
    readonly initialAcl: WorkgroupInitialAcl
  }): Promise<WorkgroupDetail>
  save(
    authority: WorkgroupOperationContext,
    input: UpdateWorkgroupCatalogInput,
  ): Promise<WorkgroupSaveResult>
  delete(
    authority: WorkgroupOperationContext,
    input: DeleteWorkgroupCatalogInput,
  ): Promise<WorkgroupDeleteResult>
}

export interface WorkgroupProjection {
  resourceOf(workgroup: Workgroup): WorkgroupCatalogResource
  snapshotOf(workgroup: Workgroup): WorkgroupDraftSnapshot
}

export interface WorkgroupAccessPort {
  filterVisible(
    authority: WorkgroupOperationContext,
    rows: readonly Workgroup[],
  ): Promise<readonly Workgroup[]>
  canView(authority: WorkgroupOperationContext, row: Workgroup): Promise<boolean>
  requireResourceEdit(authority: WorkgroupOperationContext, row: Workgroup): Promise<void>
  requireResourceGovern(authority: WorkgroupOperationContext, row: Workgroup): Promise<void>
}

export interface WorkgroupEventsPort {
  created(workgroup: WorkgroupDetail): void
  updated(receipt: SaveWorkgroupReceipt): void
  deleted(result: WorkgroupDeleteResult): void
}

export interface WorkgroupMutationClock {
  now(): number
  nextUpdatedAt(workgroup: Workgroup): number
}

export interface WorkgroupIdFactory {
  next(): string
}
