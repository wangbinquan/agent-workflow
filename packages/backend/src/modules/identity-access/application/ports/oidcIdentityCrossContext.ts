import type { UserIdentity } from '@agent-workflow/shared'
import type { SyncOidcProfileCommand, SyncOidcProfileResult } from '../../public/commands'
import type { InitialUserAccessProvisioner } from '../../public/participants'
import type { TransactionScope } from '@/platform/persistence/transactionScope'

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

export interface OidcIdentityProfileAccess {
  readonly initialUserAccess: Readonly<{
    forTransaction(transactionScope: TransactionScope): InitialUserAccessProvisioner
  }>
  readonly syncOidcProfile: Readonly<{
    execute(command: SyncOidcProfileCommand): Promise<SyncOidcProfileResult>
  }>
  readonly syncOidcProfileInTransaction: (
    transactionScope: TransactionScope,
    command: SyncOidcProfileCommand,
    now?: number,
  ) => SyncOidcProfileResult
  readonly mapOidcEmailConstraint: (error: unknown) => unknown
}

/**
 * Exact bootstrap bridge consumed by createPostgresqlIdentityAccessRuntime.
 * The object is structural so identity-access composition does not import its
 * own provider adapter back through infrastructure.
 */
export interface PostgresqlIdentityAccessCrossContextBindings {
  readonly initialUserAccess: OidcIdentityProfileAccess['initialUserAccess']
  readonly syncOidcProfileInTransaction: OidcIdentityProfileAccess['syncOidcProfileInTransaction']
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
