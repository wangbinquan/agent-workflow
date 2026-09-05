import type { UserIdentity } from '@agent-workflow/shared'
import type { SyncOidcProfileCommand, SyncOidcProfileResult } from '../../public/commands'

export interface OidcIdentityRecord {
  readonly id: string
  readonly userId: string
  readonly providerId: string
  readonly subject: string
  readonly email: string | null
  readonly emailVerified: number
  readonly preferredSnapshot: string | null
  readonly linkedAt: number
}

export interface CreateOidcIdentityInput {
  readonly userId: string
  readonly providerId: string
  readonly subject: string
  readonly email: string | null
  readonly emailVerified: boolean
  readonly displayName?: string
  readonly gitName?: string
  readonly preferredSnapshot?: string | null
  readonly expectedSubjectClaim?: string | null
  readonly expectedUsernameClaim?: string | null
  readonly expectedGitNameClaim?: string | null
  readonly expectedEmailClaim?: string | null
  readonly now?: number
}

export type OidcIdentitySeed = Omit<CreateOidcIdentityInput, 'userId'>

/**
 * identity-access 运行时交给 OIDC 身份操作的账户面。RFC-359 W4-D8 起只剩独立事务的 profile 同步：
 * 建号 / 绑定 / 关联在 infrastructure 内直接用同一份写模型，不再经 TransactionScope 认领桥绕回运行时。
 */
export interface OidcIdentityProfileAccess {
  readonly syncOidcProfile: Readonly<{
    execute(command: SyncOidcProfileCommand): Promise<SyncOidcProfileResult>
  }>
}

export interface OidcIdentityOperations {
  listIdentitiesForUser(userId: string): Promise<ReadonlyArray<UserIdentity>>
  findByProviderSubject(providerId: string, subject: string): Promise<OidcIdentityRecord | null>
  createIdentity(input: CreateOidcIdentityInput): Promise<OidcIdentityRecord>
  createUserWithIdentity(input: {
    readonly username: string
    readonly displayName: string
    readonly gitName: string
    readonly email?: string | null
    readonly identity: OidcIdentitySeed
    readonly now?: number
  }): Promise<{ readonly userId: string }>
  bindInvitedUserWithIdentity(input: {
    readonly userId: string
    readonly identity: OidcIdentitySeed
    readonly now?: number
  }): Promise<void>
  syncPreferredSnapshot(input: {
    readonly providerId: string
    readonly subject: string
    readonly userId: string
    readonly displayName: string
    readonly gitName: string
    readonly email?: string | null
    readonly emailVerified: boolean
    readonly expectedSubjectClaim?: string | null
    readonly expectedUsernameClaim?: string | null
    readonly expectedGitNameClaim?: string | null
    readonly expectedEmailClaim?: string | null
    readonly now?: number
  }): Promise<SyncOidcProfileResult>
  unlinkIdentity(identityId: string): Promise<void>
}
