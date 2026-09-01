import type { Permission, Role } from '@agent-workflow/shared'
import type { ManagedUserStatus } from '../../public/types'

export interface UserAccessRecord {
  readonly id: string
  readonly username: string
  readonly email: string | null
  readonly displayName: string
  readonly gitName: string
  readonly passwordHash: string | null
  readonly role: Role
  readonly status: ManagedUserStatus
  readonly forcePasswordChange: boolean
  readonly createdBy: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastLoginAt: number | null
  readonly schemaVersion: number
  readonly accessRevision: number
}

export interface UserPermissionGrantRecord {
  readonly userId: string
  readonly permission: string
  readonly grantedByUserId: string | null
  readonly grantedAt: number
}

export interface PublicUserRecord {
  readonly id: string
  readonly username: string
  readonly displayName: string
  readonly role: Role
  readonly status: ManagedUserStatus
}

export interface PublicUserSearch {
  readonly q?: string
  readonly limit: number
  readonly excludeIds: ReadonlyArray<string>
  readonly status?: ManagedUserStatus
}

/** Public-field-only directory used by user pickers and attribution chips.
 * Implementations must apply status/exclusion filters before the limit so a
 * disabled row cannot starve an active-only query. */
export interface PublicUserDirectory {
  findByUsername(username: string): Promise<PublicUserRecord | null>
  search(input: PublicUserSearch): Promise<ReadonlyArray<PublicUserRecord>>
  lookup(ids: ReadonlyArray<string>): Promise<ReadonlyArray<PublicUserRecord>>
}

/** RFC-320 — identity-side profile snapshot owned by identity-access. Subject
 * remains the immutable login key; these fields only drive account profile
 * refresh after the callback has established that subject. */
export interface OidcProfileIdentityRecord {
  readonly id: string
  readonly userId: string
  readonly email: string | null
  readonly emailVerified: boolean
  readonly preferredSnapshot: string | null
}

export interface OidcProfileSelectorRecord {
  readonly subjectClaim: string | null
  readonly usernameClaim: string | null
  readonly gitNameClaim: string | null
  readonly emailClaim: string | null
}

export interface OidcProfileIdentityUpdate {
  readonly id: string
  readonly email?: string
  readonly emailVerified?: boolean
  readonly preferredSnapshot?: string
}

/** One database-statement snapshot of the account preset and its explicit
 * grants. Consumers must materialize effective authority from this value,
 * rather than combining independently observed user and grant rows. */
export interface UserAccessSnapshot {
  readonly user: UserAccessRecord
  readonly grants: ReadonlyArray<UserPermissionGrantRecord>
}

export type InsertManagedUserRecord = UserAccessRecord

export interface ConditionalUserUpdate {
  readonly id: string
  readonly expectedAccessRevision: number
  readonly accessChanged: boolean
  readonly values: Partial<
    Pick<
      UserAccessRecord,
      | 'displayName'
      | 'gitName'
      | 'email'
      | 'role'
      | 'status'
      | 'forcePasswordChange'
      | 'updatedAt'
      | 'accessRevision'
    >
  >
}

export interface UserAccessReadRepository extends PublicUserDirectory {
  findAccessSnapshot(id: string): Promise<UserAccessSnapshot | null>
  listAccessSnapshots(): Promise<ReadonlyArray<UserAccessSnapshot>>
}

/**
 * RFC-317 T41 —— 出站授权围栏所需的**最小**账户快照。
 *
 * 只有两个字段，是刻意的：围栏要回答的问题只有「这个账号还有效吗、它的授权版本还是
 * 连接握手时那个吗」。给它一个完整的 `UserAccessSnapshot` 会让传输层重新拿到密码哈希、
 * 角色、授权明细——那些它一概不该看见。
 */
export interface AuthorityFenceRecord {
  readonly status: ManagedUserStatus
  readonly accessRevision: number
}

/**
 * **同步**读端口。
 *
 * 同步是硬约束、不是偷懒：唯一的消费者是 WS 广播器的发帧热路径，它必须在当前 tick 内
 * 决定这一帧发不发（RFC-305 的出站围栏）。改成 async 会让判定落到下一个微任务，
 * 而帧那时已经发出去了——围栏就此失效。Bun SQLite 的读本来就是同步的，
 * 所以这里不存在「为了同步而牺牲什么」。
 *
 * 端口摆在这里、实现落在 identity-access 的 infrastructure：`users.status` /
 * `users.access_revision` 是本 context 拥有的列，别的 context（尤其是 `ws/` 传输层）
 * 不该知道它们叫什么。RFC-317 T41 之前 `ws/registry.ts` 手写了一条
 * `SELECT status, access_revision FROM users WHERE id = ?` —— 那条字符串在列改名时
 * **typecheck 全绿、运行期在授权围栏上失败**，而且任何基于 import 边的守卫都看不见它。
 */
export interface UserAccessFenceReader {
  readAuthorityFence(id: string): AuthorityFenceRecord | null
}

export interface UserAccessTransactionParticipant {
  findUser(id: string): UserAccessRecord | null
  findUserByUsername(username: string): UserAccessRecord | null
  findUserByEmail(email: string): UserAccessRecord | null
  findOidcProfileIdentity(providerId: string, subject: string): OidcProfileIdentityRecord | null
  findOidcProfileSelectors(providerId: string): OidcProfileSelectorRecord | null
  updateOidcProfileIdentity(update: OidcProfileIdentityUpdate): void
  listGrants(userId: string): ReadonlyArray<UserPermissionGrantRecord>
  countOtherActiveAccessAdministrators(excludeId: string, systemUserId: string): number
  insertUser(record: InsertManagedUserRecord): void
  updateUserConditional(update: ConditionalUserUpdate): boolean
  deleteGrantValue(userId: string, permission: string): void
  deleteGrant(userId: string, permission: Permission): void
  insertGrant(record: {
    readonly userId: string
    readonly permission: Permission
    readonly grantedByUserId: string | null
    readonly grantedAt: number
  }): void
  transitionDisabledOwner(userId: string, now: number): void
}
