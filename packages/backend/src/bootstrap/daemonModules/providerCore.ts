import type { Actor } from '@/auth/actor'
import { admitDaemonIdentity, actorOfDirectAuthority } from '@/auth/session'
import { type DatabaseSourceWriteWindow } from '@/auth/application/authPersistence'
import { type AuthRuntime } from '@/auth/application/authRuntime'
import { type TokenCallAuditParticipant } from '@/auth/application/tokenCallAudit'
import { createAuthRuntimeFor, createTokenCallAudit } from '@/auth/composition'
import { type SecretBox } from '@/auth/secretBox'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createIdentityAccessRuntime,
  type IdentityAccessRuntime,
} from '@/modules/identity-access/composition'
import {
  composeLocalCredentialAdapters,
  type CredentialAdapterSelection,
} from '@/modules/identity-access/composition/authentication'
import { type HttpAuthenticationParticipant } from '@/modules/identity-access/public/participants'
import { composeRuntimeProfileParticipants } from '@/modules/resource-catalog/composition/runtimeProfileParticipants'
import {
  composeRealtimeRuntimeFor,
  type RealtimeCompositionPolicy,
} from '@/modules/runtime-management/composition'
import {
  composeRuntimeRegistryOperations,
  type RuntimeRegistryOperations,
} from '@/modules/runtime-management/composition/runtimeRegistry'
import { type RealtimeRuntime } from '@/modules/runtime-management/public/participants'
import {
  composeRepositoryWorkspaceOperations,
  composeRepositoryWorkspaceStore,
  DrizzleRepositoryTransportCredentialRepository,
  type RepositoryTransportCredentialRepository,
  type RepositoryWorkspaceOperations,
  type RepositoryWorkspaceStore,
} from '@/modules/source-control/composition'
import {
  createHealthDatabaseReadModel,
  type PostgresqlSystemOperationsModule,
  type SystemOperationsModule,
} from '@/modules/system-operations/composition'
import { type MaintenanceDiskOperations } from '@/modules/system-operations/public/operations'
import { type HealthDatabaseReadModel } from '@/modules/system-operations/public/queries'
import { type DatabaseProvider } from '@/platform/persistence/databaseProviders'

/** Bootstrap event sink shared by both database-provider compositions. */
export interface DaemonIdentityAccessEventSink {
  authorityRevisionChanged(input: {
    readonly userId: string
    readonly revision: number
    readonly onFailure: (error: unknown) => void
  }): void
}

/** Bootstrap presence sink shared by both database-provider compositions. */
export interface DaemonPresenceProjectionSink {
  publish(changes: ReadonlyArray<{ readonly userId: string; readonly online: boolean }>): void
}

type AuthRevalidation = NonNullable<
  Parameters<typeof createAuthRuntimeFor>[0]['onCredentialRevoked']
>

export type DaemonCredentialRevocationReason = Parameters<AuthRevalidation>[0]

export interface DaemonProviderCoreCommonInput {
  readonly daemonToken: string
  readonly appHome: string
  readonly secretBox: SecretBox | undefined
  /**
   * RFC-349 T10 — false while a migration has frozen the selected source. Only
   * daemon bootstrap supplies one; everything else stays always-writable.
   */
  readonly sourceWriteWindow: DatabaseSourceWriteWindow
  readonly realtimePolicy: RealtimeCompositionPolicy
  readonly onCredentialRevoked: (reason: DaemonCredentialRevocationReason) => void
  readonly identityEvents: DaemonIdentityAccessEventSink
  readonly presenceProjection: DaemonPresenceProjectionSink
  readonly identityId?: () => string
  readonly now?: () => number
  /** RFC-370 v2 §3.6 — the deployment's credential mechanism; standalone by default. */
  readonly credentials?: CredentialAdapterSelection
}

/**
 * Closed provider bundle consumed by all daemon transports. Database handles
 * remain captured by the provider adapters and never cross into route mount.
 */
export interface DaemonProviderCore<
  TSystemOperations extends SystemOperationsModule = SystemOperationsModule,
> {
  readonly provider: DatabaseProvider
  readonly authRuntime: AuthRuntime
  readonly tokenCallAudit: TokenCallAuditParticipant
  /** The one window both the auth runtime and the token-call audit consult. */
  readonly sourceWriteWindow: DatabaseSourceWriteWindow
  readonly identityAccess: IdentityAccessRuntime
  /** RFC-383: admission belongs to each call, never a boot-time actor holder. */
  daemonActor(errorCode?: string): Promise<Actor>
  /** The selected credential mechanism's HTTP admission (WebSocket uses its twin). */
  readonly httpAuthentication: HttpAuthenticationParticipant
  readonly healthDatabase: HealthDatabaseReadModel
  readonly runtimeRegistry: RuntimeRegistryOperations
  readonly repositoryWorkspaceStore: RepositoryWorkspaceStore
  readonly repositoryWorkspaceOperations: RepositoryWorkspaceOperations
  readonly repositoryTransportCredentialRepository: RepositoryTransportCredentialRepository
  readonly realtime: RealtimeRuntime
  readonly systemOperations: TSystemOperations
  readonly maintenanceDisk: MaintenanceDiskOperations
}

function daemonIdentityOptions(input: DaemonProviderCoreCommonInput) {
  return {
    events: input.identityEvents,
    presenceProjection: input.presenceProjection,
    ...(input.identityId === undefined ? {} : { id: input.identityId }),
    ...(input.now === undefined ? {} : { now: input.now }),
  }
}

interface SystemOperationsModuleByProvider extends Record<
  DaemonProviderCore['provider'],
  SystemOperationsModule
> {
  readonly sqlite: SystemOperationsModule
  readonly postgresql: PostgresqlSystemOperationsModule
}

export type SelectedDaemonProviderCore<
  TProvider extends DaemonProviderCore['provider'] = DaemonProviderCore['provider'],
> = Omit<DaemonProviderCore<SystemOperationsModuleByProvider[TProvider]>, 'provider'> & {
  readonly provider: TProvider
}

export interface DaemonProviderCoreAdapters<P extends DatabaseProvider = DatabaseProvider> {
  readonly provider: P
  systemOperations(
    backupPreparation: RepositoryWorkspaceOperations['backupPreparation'],
  ): SystemOperationsModuleByProvider[P]
  maintenanceDisk(): MaintenanceDiskOperations
}

/** Passive, session-scoped composition shared by both database providers. */
export function composeDaemonProviderCore<P extends DatabaseProvider>(
  input: DaemonProviderCoreCommonInput & {
    readonly db: PersistenceDb
    readonly adapters: DaemonProviderCoreAdapters<P>
  },
): SelectedDaemonProviderCore<P> {
  const repositoryWorkspaceStore = composeRepositoryWorkspaceStore(input.db)
  const repositoryWorkspaceOperations = composeRepositoryWorkspaceOperations(
    repositoryWorkspaceStore,
    input.secretBox,
  )
  const repositoryTransportCredentialRepository =
    new DrizzleRepositoryTransportCredentialRepository(input.db)
  const sourceWriteWindow = input.sourceWriteWindow
  const authRuntime = createAuthRuntimeFor({
    db: input.db,
    onCredentialRevoked: input.onCredentialRevoked,
    sourceWriteWindow,
  })
  const identityAccess = createIdentityAccessRuntime({
    db: input.db,
    ...daemonIdentityOptions(input),
  })
  const credentials = (input.credentials ?? composeLocalCredentialAdapters)({
    db: input.db,
    auth: authRuntime,
    daemonToken: input.daemonToken,
    identityAccess,
  })

  return Object.freeze({
    provider: input.adapters.provider,
    authRuntime,
    sourceWriteWindow,
    tokenCallAudit: createTokenCallAudit(input.db),
    identityAccess,
    async daemonActor(errorCode = 'digital-employee-host-identity-not-admitted') {
      const identity = await admitDaemonIdentity(identityAccess)
      if (identity === null) throw new Error(errorCode)
      return actorOfDirectAuthority(identity)
    },
    httpAuthentication: credentials.http,
    healthDatabase: createHealthDatabaseReadModel(input.db),
    runtimeRegistry: composeRuntimeRegistryOperations(
      input.db,
      composeRuntimeProfileParticipants(),
    ),
    repositoryWorkspaceStore,
    repositoryWorkspaceOperations,
    repositoryTransportCredentialRepository,
    realtime: composeRealtimeRuntimeFor({
      db: input.db,
      credentials: credentials.webSocket,
      policy: input.realtimePolicy,
    }),
    systemOperations: input.adapters.systemOperations(
      repositoryWorkspaceOperations.backupPreparation,
    ),
    maintenanceDisk: input.adapters.maintenanceDisk(),
  })
}
