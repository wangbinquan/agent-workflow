import type { EventDeliveryEnvelope } from '@/modules/event-center/public/types'
import type { TaskLaunchOrigin } from '@agent-workflow/shared'
import type {
  CaseInboxRecord,
  EmployeeCaseRecord,
  EmployeeContextRecord,
  ReactionExecutionPlan,
  ReactionRoundRecord,
} from '../../domain/runtimeModel'
import type {
  ReactionExecutionAdmissionReceiptV1,
  ReactionOperationRef,
  ReactionRequestHash,
} from '../../composition/required-ports'

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

/**
 * RFC-368 —— round 的派发状态（`employee_reaction_dispatch` 侧表，与 round 一一对应）。
 * 装的正是 `execution-launch` outbox 行今天装的东西：租约、单行重试计数、退避时刻、上次错误。
 * round 本身仍是 `planned`——「派发中」由这里持有中的租约表示（design §5.1，不新增 round 状态）。
 */
export interface ReactionDispatchRecord {
  readonly roundRef: string
  readonly caseId: string
  /** 每次派发 +1；与 TE admission 日志上的 epoch 同步推进（design §3.2）。 */
  readonly claimEpoch: number
  readonly nextAttemptAt: number
  /** 领取时 +1（与 outbox 的 `attemptCount` 同语义：从 1 起）。 */
  readonly dispatchAttempts: number
  readonly dispatchClaimedBy: string | null
  readonly dispatchLeaseExpiresAt: number | null
  readonly lastDispatchError: string | null
  readonly operationRef: string | null
  readonly retryFeedbackRef: string | null
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

/** RFC-330 —— 一行案例成员。 */
export interface EmployeeCaseMemberRecord {
  readonly caseId: string
  readonly userId: string
  readonly role: 'collaborator' | 'observer'
  readonly addedBy: string
  readonly addedAt: number
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
    readonly initialMembers: readonly {
      readonly userId: string
      readonly role: 'collaborator'
      readonly addedBy: string
      readonly addedAt: number
    }[]
  }): void
  getCase(id: string): EmployeeCaseRecord | null
  /** RFC-330 D19 —— 案例成员行（owner 不在其中，见 employee_cases.owner_user_id）。 */
  listCaseMembers(caseId: string): readonly EmployeeCaseMemberRecord[]
  getCaseMemberRole(caseId: string, userId: string): EmployeeCaseMemberRecord['role'] | null
  recordMetering(input: {
    readonly sourceRef: string
    readonly caseId: string
    readonly roundId: string
    readonly durationMs: number
    readonly totalTokens: number
    readonly now: number
  }): { readonly applied: boolean; readonly caseRecord: EmployeeCaseRecord }
  /**
   * RFC-330 D19/D20 —— 一个事务内改 owner（可选）并全量替换成员行。返回变更前的
   * owner 与成员 id，供调用方冻结「before ∪ after」的广播受众。调用方已完成
   * 规范化（owner 不进成员行、重复 last-wins、用户 active）。
   */
  replaceCaseMembers(input: {
    readonly caseId: string
    readonly ownerUserId: string | null
    readonly members: readonly {
      readonly userId: string
      readonly role: EmployeeCaseMemberRecord['role']
    }[]
    readonly addedBy: string
    readonly now: number
  }): {
    readonly previousOwnerUserId: string | null
    readonly previousMemberUserIds: readonly string[]
  }
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
    readonly ownerUserId?: string
    /**
     * RFC-330 缺口 1：按成员制过滤，与任务侧 `taskOwnershipScopeCondition` 同语义——
     * mine = 发起人 ∨ 成员（observer / collaborator）；shared = 成员 ∧ 非发起人（无主案例也算）。
     */
    readonly membership?: { readonly actorUserId: string; readonly scope: 'mine' | 'shared' }
    readonly launchOrigin?: TaskLaunchOrigin
    readonly states?: readonly EmployeeCaseRecord['state'][]
    readonly terminalCatalogStatuses?: readonly ('done' | 'canceled')[]
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
    /**
     * RFC-368：Reaction 执行走派发侧表而不是 `execution-launch` outbox 时，同事务插一行派发
     * 状态。与 `launchOutbox` 互斥。
     */
    readonly reactionDispatch?: { readonly nextAttemptAt: number } | null
  }): boolean
  markRoundRunning(roundId: string, executionRef: string, now: number): void
  /**
   * RFC-368 T8 —— 选一个到期的 `planned` round 并占派发租约。判据（design §4.1）：
   * `next_attempt_at <= now` 且租约为空（从没派发过）或已过期（上一次派发中途崩了——
   * 这一支就是崩溃重放）。领取时 `dispatch_attempts + 1`。
   */
  claimReactionDispatch(input: {
    readonly workerId: string
    readonly now: number
    readonly leaseMs: number
  }): { readonly round: ReactionRoundRecord; readonly dispatch: ReactionDispatchRecord } | null
  /**
   * RFC-368 T8 —— record-before-act：在**同一个事务**里推进派发 epoch、调 TE 的 admission
   * 参与者（`activateClaim` + `admitLaunch`，预分配执行身份），并把 operation 与执行身份写回
   * 侧表与 round（round 仍是 `planned`）。租约已丢（别的 worker 接管了）⇒ 抛 conflict。
   */
  admitReactionDispatch(input: {
    readonly roundId: string
    readonly workerId: string
    readonly operation: ReactionOperationRef
    readonly requestHash: ReactionRequestHash
    readonly authority: { readonly subject: string; readonly revision: number }
    readonly now: number
  }): ReactionExecutionAdmissionReceiptV1
  /**
   * RFC-368 T8/T11 —— `launch` 本身失败、预算未尽：释放租约，按派发级退避排下一次。
   * 清 `operation_ref` 与 round 上预写的执行身份（同一 ordinal 重派仍命中同一个 operation，
   * admission 幂等返回同一个执行身份）。
   */
  retryReactionDispatch(input: {
    readonly roundId: string
    readonly workerId: string
    readonly nextAttemptAt: number
    readonly error: string
    readonly now: number
  }): void
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

/**
 * Live provider contract; all application-visible persistence is awaitable. RFC-359 W4-D7b 起只有一份
 * provider-中立实现（`infrastructure/runtimeStore.ts`），上面的同步形状只作为这份异步合同的类型来源。
 */
export type RuntimeCasePersistence = {
  readonly [K in keyof RuntimeCaseStorePort]: RuntimeCaseStorePort[K] extends (
    ...args: infer Args
  ) => infer Result
    ? (...args: Args) => Promise<Awaited<Result>>
    : never
}
