import type {
  CreateWorkgroup,
  DeleteWorkgroup,
  SaveWorkgroupReceipt,
  Workgroup,
  WorkgroupDetail,
  WorkgroupDraftSnapshot,
  WorkflowDefinition,
} from '@agent-workflow/shared'
import type { WorkgroupOperationContext } from '../../public/participants'
import type {
  CopyWorkgroupCatalogInput,
  DeleteWorkgroupCatalogReceipt,
  UpdateWorkgroupCatalogInput,
} from './operationContracts'

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

export interface ValidatedWorkgroupDeleteInput {
  readonly id: string
  readonly deletion: DeleteWorkgroup
}

export interface WorkgroupDeleteResult {
  readonly receipt: Omit<DeleteWorkgroupCatalogReceipt, 'deleted'>
  readonly audience: WorkgroupDeletedAudience
}

/**
 * RFC-401 A3b：新建与复制的行由唯一的 workgroup 写入参与者以调用者为 owner、private 落库（RFC-231），仓库不再接收初始
 * ACL。
 */
export interface WorkgroupRepository {
  list(): Promise<readonly Workgroup[]>
  get(id: string): Promise<WorkgroupDetail | null>
  create(input: {
    readonly authority: WorkgroupOperationContext
    readonly id: string
    readonly document: CreateWorkgroup
    readonly now: number
  }): Promise<WorkgroupDetail>
  copy(input: {
    readonly authority: WorkgroupOperationContext
    readonly request: CopyWorkgroupCatalogInput
    readonly id: string
    readonly now: number
  }): Promise<WorkgroupDetail>
  save(
    authority: WorkgroupOperationContext,
    input: UpdateWorkgroupCatalogInput,
  ): Promise<WorkgroupSaveResult>
  delete(
    authority: WorkgroupOperationContext,
    input: ValidatedWorkgroupDeleteInput,
  ): Promise<WorkgroupDeleteResult>
}

export interface WorkgroupProjection {
  resourceOf(workgroup: Workgroup): Workgroup
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

// RFC-504: the task room's two collaborator ports, moved here from infrastructure/workgroupTaskRoom.ts (their implementations are
// application use cases in taskRoomCollaborators.ts; the room's infrastructure takes them as dependencies).
export interface WorkgroupTaskRoomActiveUserDirectory {
  findActiveUserIds(userIds: readonly string[]): Promise<ReadonlySet<string>>
}

export interface WorkgroupTaskRoomDynamicWorkflowOperations {
  validateGenerated(
    authority: WorkgroupOperationContext,
    input: Readonly<{
      definition: WorkflowDefinition
      triggerContextJson: string | null
      poolAgentIds: readonly string[]
    }>,
  ): Promise<WorkflowDefinition>
  create(
    authority: WorkgroupOperationContext,
    input: Readonly<{ name: string; description: string; definition: WorkflowDefinition }>,
  ): Promise<Readonly<{ id: string; name: string }>>
}
