import type { EventDeliveryEnvelope } from '@/modules/event-center/public/types'
import type {
  CaseInboxRecord,
  EmployeeCaseRecord,
  EmployeeContextRecord,
  ReactionExecutionPlan,
  ReactionRoundRecord,
} from '../../domain/runtimeModel'

export interface AttentionBindingRecord {
  readonly id: string
  readonly caseId: string
  readonly contextId: string
  readonly contextRevision: number
  readonly eventTypeRef: { readonly id: string; readonly revision: number }
  readonly subject: { readonly typeId: string; readonly subjectRef: string }
  readonly desiredIdentityKey: string
  readonly eventSubscriptionId: string | null
  readonly state: 'desired' | 'active' | 'cancel-requested' | 'cancelled'
  readonly createdAt: number
  readonly updatedAt: number
}

export interface EmployeeOutboxRecord {
  readonly id: string
  readonly caseId: string | null
  readonly kind:
    | 'event-subscribe'
    | 'event-unsubscribe'
    | 'event-publish'
    | 'execution-launch'
    | 'platform-work-item-execute'
    | 'invocation-create'
  readonly payloadJson: string
  readonly dedupeKey: string
  readonly attemptCount: number
}

export interface EmployeeInvocationRecord {
  readonly id: string
  readonly idempotencyKey: string
  readonly parentCaseId: string
  readonly parentRoundId: string
  readonly targetEmployeeRef: { readonly id: string; readonly revision: number }
  readonly targetWorkScopeRefJson: string
  readonly inputEnvelopeRef: string
  readonly inputDigest: string
  readonly completionContractRefJson: string
  readonly deadlineAt: number
  readonly childCaseId: string | null
  readonly state: 'requested' | 'accepted' | 'waiting' | 'satisfied' | 'failed' | 'detached'
  readonly createdAt: number
  readonly updatedAt: number
}

export interface EmployeeChannelRecord {
  readonly id: string
  readonly invocationId: string
  readonly parentCaseId: string
  readonly childCaseId: string
  readonly correlationRef: string
  readonly resultContractRefJson: string
  readonly state: 'open' | 'satisfied' | 'failed' | 'detached'
  readonly createdAt: number
  readonly updatedAt: number
}

export interface EmployeeChannelResultRecord {
  readonly id: string
  readonly channelId: string
  readonly milestoneType: string
  readonly envelopeJson: string
  readonly envelopeDigest: string
  readonly monotonic: boolean
  readonly createdAt: number
}

export interface ContextSettlementMutation {
  readonly context: EmployeeContextRecord
  readonly expectedRevision: number | null
  readonly contentDigest: string
  readonly externalSubjects: readonly {
    readonly typeId: string
    readonly subjectRef: string
  }[]
}

export interface ContextSettlementLink {
  readonly id: string
  readonly fromContextId: string
  readonly relation:
    | 'derived-from'
    | 'handles'
    | 'delivers'
    | 'tracks'
    | 'delegates-to'
    | 'supersedes'
  readonly toContextId: string
}

export interface AttentionSettlementUpsert {
  readonly binding: AttentionBindingRecord
  readonly subscribeOutbox: EmployeeOutboxRecord | null
}

export interface AttentionSettlementCancellation {
  readonly bindingId: string
  readonly unsubscribeOutbox: EmployeeOutboxRecord | null
}

export interface RuntimeCaseStorePort {
  createCase(input: {
    readonly caseRecord: EmployeeCaseRecord
    readonly primaryContext: EmployeeContextRecord
    readonly contextDigest: string
    readonly externalSubject: { readonly typeId: string; readonly subjectRef: string }
    readonly eventOrigin: {
      readonly eventSubscriptionId: string
      readonly eventDeliveryId: string
    } | null
    readonly uploadClaims: readonly {
      readonly uploadRef: string
      readonly actorUserId: string | null
      readonly sha256: string
      readonly blobRef: string
    }[]
  }): void
  getCase(id: string): EmployeeCaseRecord | null
  findCaseByEventDelivery(eventDeliveryId: string): EmployeeCaseRecord | null
  listCases(employeeId?: string, state?: string): EmployeeCaseRecord[]
  /** Terminal facts grouped once for every employee, without loading Case rows. */
  listTerminalOutcomeGroups(): readonly {
    readonly employeeId: string
    readonly terminalKind: string
    readonly count: number
  }[]
  listCasesPage(input: {
    readonly employeeId?: string
    readonly states?: readonly EmployeeCaseRecord['state'][]
    readonly view: 'all' | 'active' | 'attention' | 'finished'
    readonly q?: string
    readonly cursor: { readonly updatedAt: number; readonly id: string } | null
    readonly limit: number
  }): {
    readonly cases: EmployeeCaseRecord[]
    readonly hasMore: boolean
    readonly facets: {
      readonly all: number
      readonly active: number
      readonly attention: number
      readonly finished: number
    }
  }
  findCaseByExternalSubject(subjectType: string, subjectRef: string): EmployeeCaseRecord | null
  listContexts(caseId: string): EmployeeContextRecord[]
  listAttention(caseId: string): AttentionBindingRecord[]
  listInbox(caseId: string): CaseInboxRecord[]
  listRounds(caseId: string): ReactionRoundRecord[]
  listRunningRounds(): ReactionRoundRecord[]
  listInvocationsForRound(roundId: string): EmployeeInvocationRecord[]
  createInvocation(record: EmployeeInvocationRecord): EmployeeInvocationRecord
  acceptInvocation(input: {
    readonly invocationId: string
    readonly childCaseId: string
    readonly channel: EmployeeChannelRecord
    readonly now: number
  }): EmployeeChannelRecord
  getChannelByInvocation(invocationId: string): EmployeeChannelRecord | null
  listChannels(caseId: string): EmployeeChannelRecord[]
  listChannelResults(channelId: string): EmployeeChannelResultRecord[]
  listOpenChannelsWithTerminalChild(limit: number): readonly {
    readonly channel: EmployeeChannelRecord
    readonly childCase: EmployeeCaseRecord
  }[]
  listExpiredOpenChannels(
    now: number,
    limit: number,
  ): readonly {
    readonly channel: EmployeeChannelRecord
    readonly invocation: EmployeeInvocationRecord
    readonly childCase: EmployeeCaseRecord
  }[]
  settleChannelResult(input: {
    readonly result: EmployeeChannelResultRecord
    readonly channelState: 'satisfied' | 'failed' | 'detached'
    readonly now: number
  }): void
  detachOpenChannelsForRound(roundId: string, now: number): void
  claimOutbox(input: {
    readonly workerId: string
    readonly now: number
    readonly leaseMs: number
  }): EmployeeOutboxRecord | null
  completeOutbox(id: string, workerId: string, now: number): void
  retryOutbox(input: {
    readonly id: string
    readonly workerId: string
    readonly now: number
    readonly nextAttemptAt: number
    readonly error: string
    readonly terminal: boolean
  }): void
  activateAttention(bindingId: string, subscriptionId: string, now: number): void
  cancelAttention(bindingId: string, now: number): void
  acceptDelivery(
    caseId: string,
    id: string,
    delivery: EventDeliveryEnvelope,
    priority: number,
    now: number,
  ): boolean
  markInbox(inboxId: string, state: 'coalesced' | 'obsolete', now: number): void
  createRound(input: {
    readonly expectedCaseRevision: number
    readonly inboxId: string | null
    readonly round: ReactionRoundRecord
    readonly plan: ReactionExecutionPlan
    readonly launchOutbox: EmployeeOutboxRecord | null
  }): boolean
  markRoundRunning(roundId: string, executionRef: string, now: number): void
  retryRound(input: {
    readonly roundId: string
    readonly expectedExecutionRef: string
    readonly attemptOrdinal: number
    readonly errorJson: string
    readonly launchOutbox: EmployeeOutboxRecord
    readonly nextAttemptAt: number
    readonly now: number
  }): void
  settleRound(input: {
    readonly roundId: string
    readonly state: 'completed' | 'failed' | 'obsolete'
    readonly outputJson: string | null
    readonly nextWorkItemRef?: string | null
    readonly nextCaseState?: EmployeeCaseRecord['state']
    readonly terminalKind?: string | null
    readonly blockReason?: string | null
    readonly contextMutations?: readonly ContextSettlementMutation[]
    readonly contextLinks?: readonly ContextSettlementLink[]
    readonly attentionUpserts?: readonly AttentionSettlementUpsert[]
    readonly attentionCancellations?: readonly AttentionSettlementCancellation[]
    readonly now: number
  }): void
  blockCase(caseId: string, reason: string, now: number): void
  resumeCase(caseId: string, now: number): EmployeeCaseRecord
  terminateCase(caseId: string, terminalKind: string, now: number): EmployeeCaseRecord
  upgradePolicy(input: {
    readonly caseId: string
    readonly expectedRevision: number
    readonly targetPolicyRevision: number
    readonly now: number
  }): EmployeeCaseRecord | null
}
