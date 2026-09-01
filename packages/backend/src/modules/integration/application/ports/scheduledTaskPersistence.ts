import type { OwnerIdentity, ResourceGrantLevel, UserPublic } from '@agent-workflow/shared'

import type { Actor } from '@/auth/actor'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import type {
  FrozenIntegrationTriggerResourceSnapshot,
  IntegrationTriggerResourceRequest,
} from '@/modules/resource-catalog/public/types'

/** Provider-neutral durable representation of one scheduled launch. */
export interface ScheduledTaskRecord {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string
  readonly launchKind: 'workflow' | 'agent' | 'workgroup' | 'code-round'
  readonly launchPayload: string
  readonly scheduleSpec: string
  readonly enabled: boolean
  readonly nextRunAt: number | null
  readonly lastRunAt: number | null
  readonly lastStatus: 'launched' | 'failed' | null
  readonly lastError: string | null
  readonly lastTaskId: string | null
  readonly consecutiveFailures: number
  readonly aclRevision: number
  readonly createdAt: number
  readonly updatedAt: number
}

export type ScheduledTaskCreateRecord = Omit<
  ScheduledTaskRecord,
  'lastRunAt' | 'lastStatus' | 'lastError' | 'lastTaskId' | 'aclRevision'
>

type ScheduledTaskMutableKey =
  | 'name'
  | 'launchPayload'
  | 'scheduleSpec'
  | 'enabled'
  | 'nextRunAt'
  | 'lastError'
  | 'consecutiveFailures'
  | 'updatedAt'

export type ScheduledTaskMutablePatch = {
  -readonly [Key in ScheduledTaskMutableKey]?: ScheduledTaskRecord[Key]
}

export interface IntegrationTriggerAuthorityPair {
  readonly authority: ResourceRequestContext
  readonly actor: Actor
}

/**
 * Pure two-phase decision used by both providers. The adapter reloads the row,
 * derives the exact resource request, loads that snapshot inside the same
 * transaction, and only then asks the application for the final mutation.
 */
export interface ScheduledTaskAtomicUpdateDecision {
  readonly request: IntegrationTriggerResourceRequest | null
  finish(snapshot: FrozenIntegrationTriggerResourceSnapshot | null): ScheduledTaskMutablePatch
}

export interface ScheduledTaskAclSnapshot {
  readonly aclRevision: number
  readonly grants: readonly Readonly<{
    userId: string
    level: ResourceGrantLevel
  }>[]
  readonly users: readonly UserPublic[]
}

export interface ScheduledTaskAclReplacement {
  readonly resourceId: string
  readonly expectedResourceId: string
  readonly expectedAclRevision: number
  readonly actorUserId: string
  readonly bypassOwner: boolean
  readonly grants: readonly Readonly<{ userId: string; level: ResourceGrantLevel }>[]
  readonly systemUserId: string
  readonly updatedAt: number
}

export type ScheduledTaskClaimDecision =
  | Readonly<{ kind: 'claim'; nextRunAt: number }>
  | Readonly<{ kind: 'disable'; error: string }>

/**
 * One provider-neutral application port for scheduled-task CRUD, ACL, healer,
 * and worker state. Transaction objects and ORM rows never cross this surface.
 */
export interface ScheduledTaskPersistencePort {
  list(): Promise<readonly ScheduledTaskRecord[]>
  countVisible(actor: Actor): Promise<number>
  get(id: string): Promise<ScheduledTaskRecord | null>
  loadGrantLevel(resourceId: string, userId: string): Promise<ResourceGrantLevel | null>
  listGrantedResourceIds(userId: string): Promise<ReadonlySet<string>>
  loadOwnerIdentities(userIds: readonly string[]): Promise<ReadonlyMap<string, OwnerIdentity>>

  createAtomically(input: {
    readonly record: ScheduledTaskCreateRecord
    readonly authority: IntegrationTriggerAuthorityPair
    readonly request: IntegrationTriggerResourceRequest
    finish(snapshot: FrozenIntegrationTriggerResourceSnapshot): ScheduledTaskCreateRecord
  }): Promise<ScheduledTaskRecord>

  updateAtomically(input: {
    readonly id: string
    readonly authority: IntegrationTriggerAuthorityPair
    decide(fresh: ScheduledTaskRecord): ScheduledTaskAtomicUpdateDecision
  }): Promise<ScheduledTaskRecord>

  delete(id: string): Promise<ScheduledTaskRecord | null>

  loadAcl(resourceId: string): Promise<ScheduledTaskAclSnapshot | null>
  replaceAclAtomically(input: ScheduledTaskAclReplacement): Promise<void>

  pollAndClaim(input: {
    readonly now: number
    readonly limit: number
    decide(row: ScheduledTaskRecord): ScheduledTaskClaimDecision
  }): Promise<readonly ScheduledTaskRecord[]>
  recordSuccess(input: {
    readonly id: string
    readonly taskId: string
    readonly firedAt: number
    readonly recordedAt: number
  }): Promise<void>
  recordFailure(input: {
    readonly id: string
    readonly message: string
    readonly firedAt: number
    readonly recordedAt: number
    readonly maxFailures: number
  }): Promise<Readonly<{ autoDisabled: boolean }>>

  updateHealedPayload(input: {
    readonly id: string
    readonly launchPayload?: string
    readonly disableError?: string
    readonly updatedAt: number
  }): Promise<void>
}

export interface IntegrationOverviewQueries {
  countScheduled(actor: Actor): Promise<number | null>
}

/** Required async snapshot seam used outside an owning persistence transaction. */
export interface IntegrationTriggerResourceQueries {
  loadAuthorized(
    pair: IntegrationTriggerAuthorityPair,
    requests: readonly IntegrationTriggerResourceRequest[],
  ): Promise<readonly FrozenIntegrationTriggerResourceSnapshot[]>
}
