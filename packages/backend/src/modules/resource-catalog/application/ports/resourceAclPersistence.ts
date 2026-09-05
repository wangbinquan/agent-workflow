import type { AclResourceType, ResourceVisibility } from '@agent-workflow/shared'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'

/** ACL identity tables whose aggregate writer remains outside resource-catalog. */
export type ForeignResourceAclType = Extract<
  AclResourceType,
  'development_adapter' | 'employee_definition' | 'employee_tool' | 'employee_job_template'
>

export interface ResourceAclIdentityMutationRow {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: ResourceVisibility
  readonly aclRevision: number
}

/**
 * RFC-359 W4-D6 —— owner 在目录写事务里交出的 identity 行：撞名判定与写回都绑定同一个统一事务句柄。
 * `update` 以 aclRevision 为 CAS（返回 false 表示有人先写了），resource-catalog 据此回滚整个事务。
 */
export interface ResourceAclIdentityMutation {
  readonly current: ResourceAclIdentityMutationRow
  readonly ownerNameIsUnique: boolean
  hasOwnerNameCollision(nextOwnerUserId: string): Promise<boolean>
  update(input: {
    readonly ownerUserId: string | null
    readonly visibility: ResourceVisibility
    readonly aclRevision: number
    readonly updatedAt: number
  }): Promise<boolean>
}

/**
 * Consumer-owned identity persistence seam for ACL resources whose aggregate table belongs to another
 * bounded context. resource-catalog 持有目录写事务（SERIALIZABLE）并把句柄交给 owner；owner 只回答
 * 「这行现在长什么样」与「把 ACL 列写回去」，不暴露表描述符。两个 provider 同一份。
 */
export interface ResourceAclIdentityPersistence {
  readonly type: ForeignResourceAclType
  getRevision(resourceId: string): Promise<number>
  loadForMutation(
    transaction: DatabaseTransaction,
    resourceId: string,
  ): Promise<ResourceAclIdentityMutation | undefined>
}

// ---------------------------------------------------------------------------
// 同步形态（legacy）：digital-employee 的 employee_* owner 仍跑在 dbTxSync 的同步回调里，随其 AuthoringStore /
// ConfigResourceStore 对合一（W4-D6b/c）一起退役。SQLite 专属的同步 ACL 端口只认这一种。
// ---------------------------------------------------------------------------

export interface SyncResourceAclIdentityMutation {
  readonly current: ResourceAclIdentityMutationRow
  readonly ownerNameIsUnique: boolean
  hasOwnerNameCollision(nextOwnerUserId: string): boolean
  update(input: {
    readonly ownerUserId: string | null
    readonly visibility: ResourceVisibility
    readonly aclRevision: number
    readonly updatedAt: number
  }): void
}

export interface SyncResourceAclIdentityPersistence {
  readonly type: ForeignResourceAclType
  getRevision(resourceId: string): number
  withMutation<T>(
    resourceId: string,
    run: (mutation: SyncResourceAclIdentityMutation) => T,
  ): T | undefined
}
