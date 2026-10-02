// RFC-349 — provider-neutral realtime contracts owned by runtime-management.

import type { TaskWsMessage } from '@agent-workflow/shared'

import type { Actor, ActorSource } from '@/auth/actor'
import type {
  DirectAuthorityAdmission,
  WebSocketAuthenticationParticipant,
  DirectRequestAuthority,
  PresenceConnectionTracker,
  PresenceQuery,
  UserAccessFenceReader,
} from '@/modules/identity-access/public/participants'

// Compatibility names; credential shape and admission are owned by Identity Access.
export type {
  WebSocketCredential as RealtimeCredential,
  WebSocketAuthenticationParticipant as RealtimeCredentialAccess,
} from '@/modules/identity-access/public/participants'

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
  readonly credentials: WebSocketAuthenticationParticipant
  readonly channels: RealtimeChannelAccess
}

/** Identity-access stays the sole owner of account fences and presence leases. */
export interface RealtimeIdentityAccess {
  readonly directAuthority: DirectAuthorityAdmission
  readonly authorityFence: UserAccessFenceReader
  readonly presenceConnections: PresenceConnectionTracker
  readonly presenceQuery: PresenceQuery
}

/** Task owns minting and lifetime; composition binds it to one live NodeRun transaction. */
declare const nodeRunRuntimeSelectionBrand: unique symbol
export interface NodeRunRuntimeSelectionCapabilityInTx {
  readonly [nodeRunRuntimeSelectionBrand]: 'node-run-runtime-selection-in-live-tx'
}

declare const frozenRuntimeRefBrand: unique symbol
export type FrozenRuntimeRef = string & { readonly [frozenRuntimeRefBrand]: 'frozen-runtime' }

export interface NodeRunRuntimeSelection {
  readonly agentRuntime: string | null | undefined
  readonly defaultRuntime: string | null | undefined
}

/** No database, profile fields, binary path or process handle crosses this offered contract. */
declare const runtimeSelectionParticipantBrand: unique symbol
export interface RuntimeSelectionParticipantInTx {
  readonly [runtimeSelectionParticipantBrand]: 'runtime-selection-participant'
  freeze(
    capability: NodeRunRuntimeSelectionCapabilityInTx,
    input: NodeRunRuntimeSelection,
  ): Promise<FrozenRuntimeRef>
}
export { createOpencodeNativeUsageCapture } from '../composition/nativeUsageCapture'
export {
  createOpencodeNativeSpanCapture,
  createRuntimeStreamSpanCapture,
} from '../composition/nativeSpanCapture'
export type {
  NativeSpan,
  NativeSpanCapture,
  NativeSpanCaptureIdentity,
  NativeSpanRootBinding,
} from '../application/ports/nativeSpanCapture'
export type {
  NativeUsageCapture,
  NativeUsageCaptureIdentity,
} from '../application/ports/nativeUsageCapture'
