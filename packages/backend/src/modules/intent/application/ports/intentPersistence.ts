import type {
  IntentGenerationReceipt,
  IntentResourceType,
  IntentWorkingSetChangeDto,
  PostIntentCurrentAction,
  PostIntentIteration,
  PostIntentRetry,
  PostIntentWorkingSetChange,
} from '@agent-workflow/shared'

import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import type {
  IntentContextResourceReference,
  ResourceRequestContext,
} from '@/modules/resource-catalog/public/participants'
import type { IntentContextManifest } from '@/services/intent/manifest'
import type { IntentAuxiliaryPersistence } from './intentAuxiliaryQueries'

export type IntentSessionStatus = 'active' | 'archived'
export type IntentTurnRole = 'user' | 'agent'
export type IntentTurnKind =
  | 'message'
  | 'answers'
  | 'mount-approval'
  | 'running'
  | 'questions'
  | 'changeset'
  | 'error'

export interface IntentSessionRecord {
  readonly id: string
  readonly ownerUserId: string
  readonly title: string
  readonly status: IntentSessionStatus
  readonly contextRevision: number
  readonly contextManifestJson: string
  readonly handleWatermarkJson: string
  readonly currentDraftId: string | null
  readonly inFlightTurnId: string | null
  readonly turnSeq: number
  readonly commitSeq: number
  readonly budgetJson: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface IntentTurnRecord {
  readonly id: string
  readonly sessionId: string
  readonly seq: number
  readonly role: IntentTurnRole
  readonly kind: IntentTurnKind
  readonly contentJson: string
  readonly contextRevision: number
  readonly envelopeNonce: string | null
  readonly runMetaJson: string | null
  readonly clientMutationId: string | null
  readonly captureState: 'live' | 'complete' | 'truncated' | 'incomplete' | null
  readonly captureLastEventSeq: number
  readonly captureEventBytes: number
  readonly captureRootSessionId: string | null
  readonly captureIncompleteReason:
    | 'stream-persist-failed'
    | 'stream-frame-limit-exceeded'
    | 'child-capture-failed'
    | 'post-exit-flush-timeout'
    | null
  readonly scratchRetained: boolean
  readonly createdAt: number
}

export interface IntentDraftRecord {
  readonly id: string
  readonly sessionId: string
  readonly revision: number
  readonly changesetJson: string
  readonly validationJson: string
  readonly draftHash: string
  readonly producedByTurnId: string | null
  readonly contextRevision: number
  readonly createdAt: number
}

export interface IntentWorkingSetChangeRecord {
  readonly id: string
  readonly sessionId: string
  readonly clientMutationId: string
  readonly requestHash: string
  readonly expectedTurnSeq: number
  readonly expectedContextRevision: number
  readonly mode: 'after-current' | 'interrupt'
  readonly deltaJson: string
  readonly state: 'queued' | 'applying' | 'applied' | 'failed' | 'canceled'
  readonly error: string | null
  readonly resultingContextRevision: number | null
  readonly resultingTurnId: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface IntentApplyJournalRecord {
  readonly id: string
  readonly sessionId: string
  readonly clientMutationId: string
  readonly draftId: string
  readonly draftHash: string
  readonly state: 'prepared' | 'applying' | 'committed' | 'failed'
  readonly preparedArtifactsJson: string
  readonly receiptJson: string | null
  readonly error: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface IntentDraftResolutionRecord {
  readonly draftId: string
  readonly reason: 'committed' | 'discarded' | 'superseded'
}

export interface IntentTurnEventRecord {
  readonly id: number
  readonly turnId: string
  readonly eventSeq: number
  readonly ts: number
  readonly kind: string
  readonly payload: string
  readonly sessionId: string | null
  readonly parentSessionId: string | null
  readonly source: 'stream' | 'live-child' | 'post-run-child'
  readonly externalEventId: string | null
}

export interface IntentSessionListRecord extends IntentSessionRecord {
  readonly currentDraftRevision: number | null
  readonly currentDraftContextRevision: number | null
  readonly currentDraftValidationJson: string | null
  readonly latestAgentTurnKind: IntentTurnKind | null
  readonly latestCommit: null | {
    readonly draftId: string
    readonly state: IntentApplyJournalRecord['state']
  }
}

export interface ReservedIntentTurnRecord {
  readonly turnId: string
  readonly envelopeNonce: string
  readonly launchSession: IntentSessionRecord
  readonly budget: { readonly generateRounds: number; readonly questionRounds: number }
}

export interface IntentResourceVisibility {
  /** Provider-neutral visibility/name check composed from Resource Catalog. */
  visible(input: IntentContextResourceReference): Promise<boolean>
}

/**
 * Request-bound facts needed to mint the Resource Catalog transaction session.
 * Both values are opaque/branded handles produced by Identity Access; Intent
 * never reconstructs either from the legacy Actor projection.
 */
export interface IntentContextResourceAuthorityPair {
  readonly authority: ResourceRequestContext
  readonly actor: DirectAuthenticatedAuthority
}

/** Exact context-mutation capability carried by the actor-bound catalog face. */
export interface IntentContextResourceAuthorization extends IntentResourceVisibility {
  readonly currentAuthority: IntentContextResourceAuthorityPair
}

export interface IntentSessionPersistence {
  findSession(id: string): Promise<IntentSessionRecord | null>
  listSessions(input: {
    readonly ownerUserId?: string
    readonly status?: IntentSessionStatus
    readonly before?: { readonly updatedAt: number; readonly id: string }
    readonly limit?: number
  }): Promise<readonly IntentSessionListRecord[]>
  listTurns(sessionId: string): Promise<readonly IntentTurnRecord[]>
  findDraft(id: string): Promise<IntentDraftRecord | null>
  loadSessionDetailArtifacts(sessionId: string): Promise<{
    readonly drafts: readonly IntentDraftRecord[]
    readonly resolutions: readonly IntentDraftResolutionRecord[]
    readonly commits: readonly IntentApplyJournalRecord[]
  }>
  createSession(input: {
    readonly session: IntentSessionRecord
    readonly userTurn: IntentTurnRecord
    readonly agentTurn?: IntentTurnRecord
  }): Promise<void>
  createSessionWithAuthorizedResources(input: {
    readonly session: IntentSessionRecord
    readonly userTurn: IntentTurnRecord
    readonly agentTurn?: IntentTurnRecord
    readonly authorization: IntentContextResourceAuthorization
    readonly resources: readonly IntentContextResourceReference[]
  }): Promise<void>
  insertUserTurn(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly turn: IntentTurnRecord
  }): Promise<{ readonly turnId: string; readonly seq: number }>
  commitMountSuggestionDecision(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly sourceTurnId: string
    readonly expectedTurnSeq: number
    readonly expectedContextRevision: number
    readonly approvalTurn: IntentTurnRecord
    readonly manifest: IntentContextManifest
    readonly handleWatermarkJson: string
    readonly authorization: IntentContextResourceAuthorization
    readonly resources: readonly IntentContextResourceReference[]
  }): Promise<'committed' | 'stale'>
  insertUserTurnAndReserve(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly userTurnId: string
    readonly agentTurnId: string
    readonly envelopeNonce: string
    readonly kind: 'message' | 'answers'
    readonly contentJson: string
    readonly now: number
    readonly maxGenerateRounds: number
  }): Promise<{
    readonly turnId: string
    readonly seq: number
    readonly reservation: ReservedIntentTurnRecord
  }>
  reserveRetryTurn(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly turnId: string
    readonly envelopeNonce: string
    readonly now: number
    readonly maxGenerateRounds: number
  }): Promise<ReservedIntentTurnRecord>
  updateManifest(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly expectedContextRevision: number
    readonly expectedTurnSeq: number
    readonly manifest: IntentContextManifest
    readonly handleWatermarkJson?: string
    readonly updatedAt: number
  }): Promise<'updated' | 'stale'>
  updateManifestWithAuthorizedResources(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly expectedContextRevision: number
    readonly expectedTurnSeq: number
    readonly manifest: IntentContextManifest
    readonly handleWatermarkJson?: string
    readonly updatedAt: number
    readonly authorization: IntentContextResourceAuthorization
    readonly resources: readonly IntentContextResourceReference[]
  }): Promise<'updated' | 'stale'>
  setStatus(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly status: IntentSessionStatus
    readonly updatedAt: number
  }): Promise<'updated' | 'unchanged'>
  listProvenance(input: {
    readonly resourceType: IntentResourceType
    readonly resourceId: string
  }): Promise<
    readonly {
      readonly commitId: string
      readonly sessionId: string
      readonly sessionTitle: string
      readonly sessionOwnerUserId: string
      readonly createdAt: number
    }[]
  >
}

export interface IntentTurnLifecyclePersistence {
  beginTurn(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly turnId: string
    readonly envelopeNonce: string
    readonly now: number
    readonly maxGenerateRounds: number
    readonly reservation?: {
      readonly turnId: string
      readonly envelopeNonce: string
      readonly budget: { readonly generateRounds: number; readonly questionRounds: number }
    }
  }): Promise<{
    readonly session: IntentSessionRecord
    readonly seq: number
    readonly budget: { readonly generateRounds: number; readonly questionRounds: number }
  }>
  cancelReservedTurn(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly now: number
  }): Promise<boolean>
  settleReservedTurnStartFailure(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly turnId: string
    readonly envelopeNonce: string
    readonly detail: string
    readonly now: number
  }): Promise<boolean>
  refreshTurnManifest(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly launchRevision: number
    readonly manifest: IntentContextManifest
    readonly handleWatermarkJson: string
    readonly updatedAt: number
  }): Promise<boolean>
  settleTurn(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly launchRevision: number
    readonly kind: 'questions' | 'changeset' | 'error'
    readonly content: Readonly<Record<string, unknown>>
    readonly runMetaJson?: string
    readonly scratchRetained: boolean
    readonly budgetDelta?: {
      readonly generateRounds?: number
      readonly questionRounds?: number
    }
    readonly draft?: {
      readonly changesetJson: string
      readonly validationJson: string
      readonly draftHash: string
    }
    readonly now: number
  }): Promise<{
    readonly turnId: string
    readonly kind: 'questions' | 'changeset' | 'error'
    readonly errorCode?: string
    readonly draftRevision?: number
  }>
}

export interface IntentIterationPersistence {
  reserveIteration(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly request: PostIntentIteration
    readonly maxGenerateRounds: number
  }): Promise<{
    readonly receipt: IntentGenerationReceipt
    readonly reservation: ReservedIntentTurnRecord | null
  }>
  reserveRetry(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly request: PostIntentRetry
    readonly maxGenerateRounds: number
  }): Promise<{
    readonly receipt: IntentGenerationReceipt
    readonly reservation: ReservedIntentTurnRecord | null
  }>
  reserveCurrentAction(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly request: PostIntentCurrentAction
    readonly maxGenerateRounds: number
    readonly visibility: IntentContextResourceAuthorization
  }): Promise<{
    readonly receipt: IntentGenerationReceipt
    readonly reservation: ReservedIntentTurnRecord | null
  }>
}

export interface IntentWorkingSetPersistence {
  latestWorkingSetChange(sessionId: string): Promise<IntentWorkingSetChangeRecord | null>
  submitWorkingSetChange(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly request: PostIntentWorkingSetChange
    readonly maxGenerateRounds: number
    readonly visibility: IntentContextResourceAuthorization
  }): Promise<{
    readonly change: IntentWorkingSetChangeDto
    readonly reservation: ReservedIntentTurnRecord | null
    readonly shouldInterrupt: boolean
  }>
  activateWorkingSetChange(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly maxGenerateRounds: number
    readonly visibility: IntentContextResourceAuthorization
    readonly changeId?: string
  }): Promise<{
    readonly change: IntentWorkingSetChangeDto | null
    readonly reservation: ReservedIntentTurnRecord | null
  }>
  cancelWorkingSetChange(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly changeId: string
  }): Promise<IntentWorkingSetChangeDto>
  retryWorkingSetChange(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly changeId: string
    readonly maxGenerateRounds: number
    readonly visibility: IntentContextResourceAuthorization
  }): Promise<{
    readonly change: IntentWorkingSetChangeDto | null
    readonly reservation: ReservedIntentTurnRecord | null
  }>
  listQueuedWorkingSetSessionIds(): Promise<readonly string[]>
}

export interface IntentMaintenancePersistence {
  listQueuedWorkingSetSessionIds(): Promise<readonly string[]>
  listTurnIdsForBootRecovery(): Promise<readonly string[]>
  listRunningTurnIds(turnIds: readonly string[]): Promise<ReadonlySet<string>>
  recoverTurnsOnBoot(input: {
    readonly turnIds: readonly string[]
    readonly now: number
    readonly reason: string
  }): Promise<number>
  markScratchSwept(input: {
    readonly cutoff: number
    readonly excludedTurnIds: readonly string[]
  }): Promise<readonly string[]>
}

export interface IntentTurnEventPersistence {
  appendTurnEvent(
    input: Omit<IntentTurnEventRecord, 'id' | 'eventSeq'> & {
      readonly byteLength: number
      readonly rowLimit: number
      readonly byteLimit: number
    },
  ): Promise<{
    readonly eventSeq: number
    readonly duplicate: boolean
    readonly stopped: boolean
  }>
  replaceTurnRootSession(input: {
    readonly turnId: string
    readonly sessionId: string
    readonly previousSessionId?: string
  }): Promise<{
    readonly eventSeq: number
    readonly captureState: IntentTurnRecord['captureState']
    readonly conflict: boolean
  }>
  readTurnCapture(turnId: string): Promise<IntentTurnRecord | null>
  settleTurnCapture(input: {
    readonly turnId: string
    readonly state: Exclude<IntentTurnRecord['captureState'], 'live' | null>
    readonly rootSessionId?: string | null
    readonly incompleteReason?: IntentTurnRecord['captureIncompleteReason']
  }): Promise<{
    readonly eventSeq: number
    readonly captureState: IntentTurnRecord['captureState']
  }>
  readTurnSession(turnId: string): Promise<{
    readonly turn: IntentTurnRecord
    readonly events: readonly IntentTurnEventRecord[]
  } | null>
}

export interface IntentPersistence
  extends
    IntentSessionPersistence,
    IntentIterationPersistence,
    IntentWorkingSetPersistence,
    IntentMaintenancePersistence,
    IntentTurnEventPersistence,
    IntentTurnLifecyclePersistence,
    IntentAuxiliaryPersistence {}
