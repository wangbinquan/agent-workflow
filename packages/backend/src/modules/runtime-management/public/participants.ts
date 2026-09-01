// RFC-349 — provider-neutral realtime contracts owned by runtime-management.

import type { TaskWsMessage } from '@agent-workflow/shared'

import type { Actor, ActorSource } from '@/auth/actor'
import type {
  DirectAuthorityAdmission,
  DirectAuthorityIdentity,
  DirectRequestAuthority,
  PresenceConnectionTracker,
  PresenceQuery,
  UserAccessFenceReader,
} from '@/modules/identity-access/public/participants'

export type RealtimeCredential =
  | Readonly<{
      kind: 'session' | 'pat'
      hash: string
      expiresAt: number | null
    }>
  | Readonly<{ kind: 'daemon' }>

interface RealtimeUpgradeIdentity {
  readonly actor: Actor | null
  readonly authority: DirectRequestAuthority | null
  readonly credential: RealtimeCredential
}

/** Credential persistence is bound by composition; the transport sees no DB client. */
export interface RealtimeCredentialAccess {
  readonly allowLegacyDaemonTestAccess: boolean
  resolveUpgrade(
    rawToken: string,
    daemonToken: Uint8Array,
    now?: number,
  ): Promise<RealtimeUpgradeIdentity>
  reresolve(credential: RealtimeCredential, now?: number): Promise<DirectAuthorityIdentity | null>
}

type RealtimeAclResourceType = 'workflow' | 'workgroup'

interface RealtimeMemoryScope {
  readonly scopeType: 'agent' | 'workflow' | 'repo' | 'repo_group' | 'global'
  readonly scopeId: string | null
}

/** Closed resource projection shared by provider stores and visibility policy. */
interface RealtimeResourceProjection {
  readonly id: string
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
}

interface RealtimeResourceVisibility {
  canViewResource(
    actor: Actor,
    type: RealtimeAclResourceType,
    resource: RealtimeResourceProjection,
  ): Promise<boolean>
}

interface RealtimeMemoryVisibility {
  canViewMemory(
    authority: DirectRequestAuthority,
    actor: Actor,
    scope: RealtimeMemoryScope,
  ): Promise<boolean>
}

/** Cross-owner policy consumed by runtime-management provider composition. */
export interface RealtimeCompositionPolicy {
  readonly resourceVisibility: RealtimeResourceVisibility
  readonly memoryVisibility: RealtimeMemoryVisibility
  readonly repoImportOwnerUserId: (batchId: string) => string | null
  readonly redactTaskEventPayload: (payload: unknown, actorSource: ActorSource) => unknown
}

/** All provider-backed channel decisions are closed behind this async participant. */
export interface RealtimeChannelAccess {
  canViewTask(actor: Actor, taskId: string): Promise<boolean>
  canViewResource(actor: Actor, type: RealtimeAclResourceType, resourceId: string): Promise<boolean>
  canViewMemory(
    authority: DirectRequestAuthority,
    actor: Actor,
    scope: RealtimeMemoryScope,
  ): Promise<boolean>
  canViewStoredMemory(
    authority: DirectRequestAuthority,
    actor: Actor,
    memoryId: string,
  ): Promise<boolean>
  replayTaskEvents(
    actorSource: ActorSource,
    taskId: string,
    since: number,
  ): Promise<readonly TaskWsMessage[]>
  repoImportOwnerUserId(batchId: string): string | null
}

/** Bootstrap-selected runtime. Neither member exposes a provider client. */
export interface RealtimeRuntime {
  readonly credentials: RealtimeCredentialAccess
  readonly channels: RealtimeChannelAccess
}

/** Identity-access stays the sole owner of account fences and presence leases. */
export interface RealtimeIdentityAccess {
  readonly directAuthority: DirectAuthorityAdmission
  readonly authorityFence: UserAccessFenceReader
  readonly presenceConnections: PresenceConnectionTracker
  readonly presenceQuery: PresenceQuery
}
