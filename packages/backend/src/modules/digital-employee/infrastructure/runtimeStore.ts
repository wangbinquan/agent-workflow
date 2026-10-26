import { databaseContentColumnsInTx } from '@/platform/content/infrastructure/contentStore'
// RFC-359 W4-D7b —— Digital Employee OS 运行时案件持久化（案件 / 上下文 / 关注绑定 / 收件箱 / 反应轮次 / 调用与
// 通道 / outbox）：一份实现，两个 provider 共用。
//
// 语义沿 RFC-310 的 SQLite store：多表写走统一事务原语；CAS 判据全在 WHERE 里（revision / activeRoundId /
// attemptCount），受影响行数经 `affectedRows` 判；计量与成员替换这两处读—改—写先 `lockAggregateRoot` 锁案件行（PG 渲染
// FOR UPDATE，SQLite 独占事务下 no-op）；案件搜索的大小写不敏感与通配符转义走能力矩阵；nullable 列的 ORDER BY 走能力
// 矩阵的 NULL 排序（SQLite 的 NULL 最小语义，PG 显式 nulls first）。

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import { EMPLOYEE_TERMINAL_CATALOG_CANCELED_KINDS } from '@agent-workflow/shared'
import { z } from 'zod'

import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { affectedRows, databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { ConflictError, NotFoundError } from '@/util/errors'
import type {
  AttentionBindingRecord,
  EmployeeChannelRecord,
  EmployeeChannelResultRecord,
  EmployeeInvocationRecord,
  EmployeeOutboxRecord,
  ReactionDispatchRecord,
  RuntimeCasePersistence,
} from '../application/ports/runtimeStore'
import type {
  ReactionClaimEpoch,
  ReactionExecutionAdmissionParticipantV1,
} from '../composition/required-ports'
import {
  type CaseInboxRecord,
  type EmployeeCaseRecord,
  type EmployeeContextRecord,
  type ReactionRoundRecord,
  reactionExecutionPlanSchema,
} from '../domain/runtimeModel'
import { employeeCaseLifecycleObservation } from '../public/events'
import { reactionArtifactRef, sanitizeReactionText } from '../domain/reactionArtifacts'

async function enqueueCaseLifecycleEventTx(
  tx: PersistenceTx,
  input: {
    readonly caseId: string
    readonly employeeId: string
    readonly revision: number
    readonly previousState: EmployeeCaseRecord['state'] | null
    readonly state: EmployeeCaseRecord['state']
    readonly terminalKind: string | null
    readonly occurredAt: number
  },
): Promise<void> {
  const observation = employeeCaseLifecycleObservation(input)
  const { employeeOsOutbox } = tablesOf(tx)
  await tx
    .insert(employeeOsOutbox)
    .values({
      id: `case-lifecycle:${input.caseId}:${input.revision}`,
      caseId: input.caseId,
      kind: 'event-publish',
      payloadJson: JSON.stringify(observation),
      dedupeKey: observation.dedupeKey,
      state: 'pending',
      attemptCount: 0,
      nextAttemptAt: input.occurredAt,
      createdAt: input.occurredAt,
      updatedAt: input.occurredAt,
    })
    .onConflictDoNothing({ target: employeeOsOutbox.dedupeKey })
}

function caseRecord(row: PersistenceTables['employeeCases']['$inferSelect']): EmployeeCaseRecord {
  return {
    id: row.id,
    name: row.name,
    employeeRef: { id: row.employeeId, revision: row.employeeRevision },
    typeRef: { typeId: row.typeId, revision: row.typeRevision },
    primaryContextId: row.primaryContextId,
    executionPolicyRevision: row.executionPolicyRevision,
    maxDurationMs: row.maxDurationMs,
    consumedDurationMs: row.consumedDurationMs,
    maxTotalTokens: row.maxTotalTokens,
    consumedTotalTokens: row.consumedTotalTokens,
    ownerUserId: row.ownerUserId,
    launchOrigin: row.launchOrigin,
    state: row.state,
    terminalKind: row.terminalKind,
    blockReason: row.blockReason,
    currentWorkItemRef: row.currentWorkItemRef,
    activeRoundId: row.activeRoundId,
    revision: row.revision,
    writerGeneration: row.writerGeneration,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    terminalAt: row.terminalAt,
  }
}

function contextRecord(
  row: PersistenceTables['employeeContextRecords']['$inferSelect'],
): EmployeeContextRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    typeId: row.typeId,
    schemaVersion: row.schemaVersion,
    revision: row.currentRevision,
    lifecycleState: row.lifecycleState,
    stateJson: row.stateJson,
    artifactRefs: JSON.parse(row.artifactRefsJson) as string[],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function attentionRecord(
  row: PersistenceTables['employeeAttentionBindings']['$inferSelect'],
): AttentionBindingRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    contextId: row.contextId,
    contextRevision: row.contextRevision,
    eventTypeRef: { id: row.eventTypeId, revision: row.eventTypeRevision },
    subject: { typeId: row.subjectType, subjectRef: row.subjectRef },
    desiredIdentityKey: row.desiredIdentityKey,
    eventSubscriptionId: row.eventSubscriptionId,
    state: row.state,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function inboxRecord(row: PersistenceTables['employeeCaseInbox']['$inferSelect']): CaseInboxRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    deliveryId: row.deliveryId,
    eventId: row.eventId,
    eventTypeRef: { id: row.eventTypeId, revision: row.eventTypeRevision },
    sourceRef: { id: row.sourceId, revision: row.sourceRevision },
    subject: { typeId: row.subjectType, subjectRef: row.subjectRef },
    deliveryClass: row.deliveryClass,
    priority: row.priority,
    occurredAt: row.occurredAt,
    summary: row.summary,
    payloadArtifactRef: row.payloadArtifactRef,
    state: row.state,
    roundId: row.roundId,
    acceptedAt: row.acceptedAt,
    settledAt: row.settledAt,
  }
}

function roundRecord(
  row: PersistenceTables['employeeReactionRounds']['$inferSelect'],
): ReactionRoundRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    caseRevision: row.caseRevision,
    inboxId: row.inboxId,
    employeeRef: { id: row.employeeId, revision: row.employeeRevision },
    ruleId: row.ruleId,
    workItemRef: row.workItemRef,
    workContractRef: {
      contractId: row.workContractId,
      version: row.workContractVersion,
    },
    toolRef:
      row.toolId === null || row.toolRevision === null
        ? null
        : { id: row.toolId, revision: row.toolRevision },
    executionPolicyRevision: row.executionPolicyRevision,
    inputContextRefsJson: row.inputContextRefsJson,
    planJson: row.planJson,
    state: row.state,
    executionRef: row.executionRef,
    outputJson: row.outputJson,
    attemptOrdinal: row.attemptOrdinal,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    settledAt: row.settledAt,
  }
}

/**
 * RFC-368 T5b —— 切换前 `execution-launch` outbox 行的 kind 与 payload 形状。只剩一次性收编
 * （`adoptLegacyReactionLaunches`）还认得它；新代码不再写这一类。
 */
const LEGACY_EXECUTION_LAUNCH_KIND = 'execution-launch'

const legacyExecutionLaunchPayloadSchema = z
  .object({
    roundId: z.string().min(1),
    plan: reactionExecutionPlanSchema,
    attempt: z
      .object({
        ordinal: z.number().int().nonnegative(),
        mode: z.enum(['initial', 'same-scene', 'fresh-scene']),
        previousError: z.string().nullable(),
      })
      .strict()
      .default({ ordinal: 0, mode: 'initial', previousError: null }),
  })
  .strict()

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function outboxRecord(
  row: PersistenceTables['employeeOsOutbox']['$inferSelect'],
): EmployeeOutboxRecord {
  // `claimOutbox` 不会选中遗留的 `execution-launch` 行（它们只由 `adoptLegacyReactionLaunches`
  // 收编）；万一读到，说明判据漂了，直接报出来而不是交给一个不认识它的执行臂。
  if (row.kind === LEGACY_EXECUTION_LAUNCH_KIND) {
    throw new Error(`legacy execution-launch outbox row must be adopted, not claimed: ${row.id}`)
  }
  return {
    id: row.id,
    caseId: row.caseId,
    kind: row.kind,
    payloadJson: row.payloadJson,
    dedupeKey: row.dedupeKey,
    attemptCount: row.attemptCount,
  }
}

function dispatchRecord(
  row: PersistenceTables['employeeReactionDispatch']['$inferSelect'],
): ReactionDispatchRecord {
  return {
    roundRef: row.roundRef,
    caseId: row.caseId,
    claimEpoch: row.claimEpoch,
    nextAttemptAt: row.nextAttemptAt,
    dispatchAttempts: row.dispatchAttempts,
    dispatchClaimedBy: row.dispatchClaimedBy,
    dispatchLeaseExpiresAt: row.dispatchLeaseExpiresAt,
    lastDispatchError: row.lastDispatchError,
    operationRef: row.operationRef,
    retryFeedbackRef: row.retryFeedbackRef,
  }
}

/** round 结算状态 → admission 收口原因（RFC-368 T13）。 */
const CLOSE_REASON = {
  completed: 'completed',
  failed: 'exhausted',
  obsolete: 'superseded',
} as const

function invocationRecord(
  row: PersistenceTables['employeeInvocations']['$inferSelect'],
): EmployeeInvocationRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    parentCaseId: row.parentCaseId,
    parentRoundId: row.parentRoundId,
    targetEmployeeRef: {
      id: row.targetEmployeeId,
      revision: row.targetEmployeeRevision,
    },
    targetWorkScopeRefJson: row.targetWorkScopeRefJson,
    inputEnvelopeRef: row.inputEnvelopeRef,
    inputDigest: row.inputDigest,
    completionContractRefJson: row.completionContractRefJson,
    deadlineAt: row.deadlineAt,
    childCaseId: row.childCaseId,
    state: row.state,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function channelRecord(
  row: PersistenceTables['employeeChannels']['$inferSelect'],
): EmployeeChannelRecord {
  return {
    id: row.id,
    invocationId: row.invocationId,
    parentCaseId: row.parentCaseId,
    childCaseId: row.childCaseId,
    correlationRef: row.correlationRef,
    resultContractRefJson: row.resultContractRefJson,
    state: row.state,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function channelResultRecord(
  row: PersistenceTables['employeeChannelResults']['$inferSelect'],
): EmployeeChannelResultRecord {
  return {
    id: row.id,
    channelId: row.channelId,
    milestoneType: row.milestoneType,
    envelopeJson: row.envelopeJson,
    envelopeDigest: row.envelopeDigest,
    monotonic: row.monotonic,
    createdAt: row.createdAt,
  }
}

export interface RuntimePersistenceOptions {
  /**
   * RFC-368 —— TaskExecution 的 admission 参与者工厂，按事务句柄取用（`InTx` 定式）。
   * 由组合根注入；缺席时 `admitReactionDispatch` 抛错，结算也不收口 claim（旧装配路径）。
   */
  readonly reactionAdmission?: (tx: PersistenceDb) => ReactionExecutionAdmissionParticipantV1
}

export function createRuntimePersistence(
  db: PersistenceDb,
  options: RuntimePersistenceOptions = {},
): RuntimeCasePersistence {
  const session = databaseSessionFor(db)
  const engine = session.engine
  const maxEmployeeOutcomeGroups = 50_000
  return {
    async createCase(input) {
      await session.transaction(async (tx) => {
        for (const claim of input.uploadClaims) {
          const { employeeInputUploads } = tablesOf(tx)
          const upload = await first(
            tx
              .select()
              .from(employeeInputUploads)
              .where(eq(employeeInputUploads.id, claim.uploadRef)),
          )
          if (
            upload === undefined ||
            upload.actorUserId !== claim.actorUserId ||
            upload.state !== 'pending' ||
            upload.expiresAt <= input.caseRecord.createdAt ||
            upload.sha256 !== claim.sha256 ||
            upload.blobRef !== claim.blobRef
          ) {
            throw new ConflictError(
              'employee-upload-claim-conflict',
              `input upload changed before case admission: ${claim.uploadRef}`,
            )
          }
          const claimed = await tx
            .update(employeeInputUploads)
            .set({
              state: 'claimed',
              claimedByCaseId: input.caseRecord.id,
              claimedAt: input.caseRecord.createdAt,
            })
            .where(
              and(
                eq(employeeInputUploads.id, claim.uploadRef),
                eq(employeeInputUploads.state, 'pending'),
              ),
            )
          if (affectedRows(claimed) !== 1) {
            throw new ConflictError(
              'employee-upload-claim-conflict',
              `input upload was claimed concurrently: ${claim.uploadRef}`,
            )
          }
        }
        const {
          employeeCases,
          employeeCaseMembers,
          employeeCaseEventOrigins,
          employeeContextRecords,
          employeeContextRevisions,
          employeeExternalContextBindings,
        } = tablesOf(tx)
        await insertOne(tx, employeeCases, {
          id: input.caseRecord.id,
          name: input.caseRecord.name,
          employeeId: input.caseRecord.employeeRef.id,
          employeeRevision: input.caseRecord.employeeRef.revision,
          typeId: input.caseRecord.typeRef.typeId,
          typeRevision: input.caseRecord.typeRef.revision,
          primaryContextId: input.caseRecord.primaryContextId,
          executionPolicyRevision: input.caseRecord.executionPolicyRevision,
          maxDurationMs: input.caseRecord.maxDurationMs,
          consumedDurationMs: input.caseRecord.consumedDurationMs,
          maxTotalTokens: input.caseRecord.maxTotalTokens,
          consumedTotalTokens: input.caseRecord.consumedTotalTokens,
          ownerUserId: input.caseRecord.ownerUserId,
          launchOrigin: input.caseRecord.launchOrigin,
          state: input.caseRecord.state,
          terminalKind: input.caseRecord.terminalKind,
          blockReason: input.caseRecord.blockReason,
          currentWorkItemRef: input.caseRecord.currentWorkItemRef,
          activeRoundId: input.caseRecord.activeRoundId,
          revision: input.caseRecord.revision,
          writerGeneration: input.caseRecord.writerGeneration,
          createdAt: input.caseRecord.createdAt,
          updatedAt: input.caseRecord.updatedAt,
          terminalAt: input.caseRecord.terminalAt,
        })
        if (input.initialMembers.length > 0) {
          await tx.insert(employeeCaseMembers).values(
            input.initialMembers.map((member) => ({
              caseId: input.caseRecord.id,
              userId: member.userId,
              role: member.role,
              addedBy: member.addedBy,
              addedAt: member.addedAt,
            })),
          )
        }
        if (input.eventOrigin !== null) {
          await insertOne(tx, employeeCaseEventOrigins, {
            caseId: input.caseRecord.id,
            eventSubscriptionId: input.eventOrigin.eventSubscriptionId,
            eventDeliveryId: input.eventOrigin.eventDeliveryId,
            createdAt: input.caseRecord.createdAt,
          })
        }
        await enqueueCaseLifecycleEventTx(tx, {
          caseId: input.caseRecord.id,
          employeeId: input.caseRecord.employeeRef.id,
          revision: input.caseRecord.revision,
          previousState: null,
          state: input.caseRecord.state,
          terminalKind: input.caseRecord.terminalKind,
          occurredAt: input.caseRecord.createdAt,
        })
        await insertOne(tx, employeeContextRecords, {
          id: input.primaryContext.id,
          caseId: input.primaryContext.caseId,
          typeId: input.primaryContext.typeId,
          schemaVersion: input.primaryContext.schemaVersion,
          currentRevision: input.primaryContext.revision,
          lifecycleState: input.primaryContext.lifecycleState,
          stateJson: input.primaryContext.stateJson,
          artifactRefsJson: JSON.stringify(input.primaryContext.artifactRefs),
          createdAt: input.primaryContext.createdAt,
          updatedAt: input.primaryContext.updatedAt,
        })
        await insertOne(tx, employeeContextRevisions, {
          contextId: input.primaryContext.id,
          revision: input.primaryContext.revision,
          stateJson: input.primaryContext.stateJson,
          artifactRefsJson: JSON.stringify(input.primaryContext.artifactRefs),
          contentDigest: input.contextDigest,
          createdAt: input.primaryContext.createdAt,
        })
        await insertOne(tx, employeeExternalContextBindings, {
          subjectType: input.externalSubject.typeId,
          subjectRef: input.externalSubject.subjectRef,
          caseId: input.caseRecord.id,
          contextId: input.primaryContext.id,
          bindingRevision: 1,
          updatedAt: input.caseRecord.createdAt,
        })
      })
    },

    async getCase(id) {
      const { employeeCases } = tablesOf(db)
      const row = await first(db.select().from(employeeCases).where(eq(employeeCases.id, id)))
      return row === undefined ? null : caseRecord(row)
    },

    async listCaseMembers(caseId) {
      const { employeeCaseMembers } = tablesOf(db)
      return (
        await db.select().from(employeeCaseMembers).where(eq(employeeCaseMembers.caseId, caseId))
      ).map((row) => ({
        caseId: row.caseId,
        userId: row.userId,
        role: row.role,
        addedBy: row.addedBy,
        addedAt: row.addedAt,
      }))
    },

    async getCaseMemberRole(caseId, userId) {
      const { employeeCaseMembers } = tablesOf(db)
      const row = await first(
        db
          .select({ role: employeeCaseMembers.role })
          .from(employeeCaseMembers)
          .where(
            and(eq(employeeCaseMembers.caseId, caseId), eq(employeeCaseMembers.userId, userId)),
          ),
      )
      return row === undefined ? null : row.role
    },

    async recordMetering(input) {
      return await session.transaction(async (tx) => {
        if (
          !Number.isSafeInteger(input.durationMs) ||
          input.durationMs < 0 ||
          !Number.isSafeInteger(input.totalTokens) ||
          input.totalTokens < 0
        ) {
          throw new ConflictError(
            'employee-case-metering-invalid',
            'employee case metering must contain nonnegative safe integers',
          )
        }
        const { employeeCases, employeeCaseMeteringReceipts } = tablesOf(tx)
        await engine.lockAggregateRoot(tx, employeeCases, employeeCases.id, input.caseId)
        const current = await first(
          tx.select().from(employeeCases).where(eq(employeeCases.id, input.caseId)),
        )
        if (current === undefined) {
          throw new NotFoundError(
            'employee-case-not-found',
            `employee case not found: ${input.caseId}`,
          )
        }
        const inserted = await tx
          .insert(employeeCaseMeteringReceipts)
          .values({
            sourceRef: input.sourceRef,
            caseId: input.caseId,
            roundId: input.roundId,
            durationMs: input.durationMs,
            totalTokens: input.totalTokens,
            createdAt: input.now,
          })
          .onConflictDoNothing({ target: employeeCaseMeteringReceipts.sourceRef })
        const applied = affectedRows(inserted) === 1
        if (applied) {
          const consumedDurationMs = current.consumedDurationMs + input.durationMs
          const consumedTotalTokens = current.consumedTotalTokens + input.totalTokens
          if (
            !Number.isSafeInteger(consumedDurationMs) ||
            !Number.isSafeInteger(consumedTotalTokens)
          ) {
            throw new ConflictError(
              'employee-case-metering-overflow',
              'employee case metering totals exceed safe integer range',
            )
          }
          await tx
            .update(employeeCases)
            .set({
              consumedDurationMs,
              consumedTotalTokens,
              revision: current.revision + 1,
              updatedAt: input.now,
            })
            .where(eq(employeeCases.id, input.caseId))
        }
        const updated = await first(
          tx.select().from(employeeCases).where(eq(employeeCases.id, input.caseId)),
        )
        if (updated === undefined) throw new Error('employee case disappeared while metering')
        return { applied, caseRecord: caseRecord(updated) }
      })
    },

    async replaceCaseMembers(input) {
      return await session.transaction(async (tx) => {
        const { employeeCases, employeeCaseMembers } = tablesOf(tx)
        await engine.lockAggregateRoot(tx, employeeCases, employeeCases.id, input.caseId)
        const current = await first(
          tx
            .select({ id: employeeCases.id, ownerUserId: employeeCases.ownerUserId })
            .from(employeeCases)
            .where(eq(employeeCases.id, input.caseId)),
        )
        if (current === undefined) {
          throw new NotFoundError(
            'employee-case-not-found',
            `employee case not found: ${input.caseId}`,
          )
        }
        const before = await tx
          .select({ userId: employeeCaseMembers.userId })
          .from(employeeCaseMembers)
          .where(eq(employeeCaseMembers.caseId, input.caseId))
        if (current.ownerUserId !== input.ownerUserId) {
          // 只改归属，不动 revision：revision 是运行时状态机的 CAS 位，策略升级预览
          // token 等都按它对账；owner 转移不是一次状态变迁。
          await tx
            .update(employeeCases)
            .set({ ownerUserId: input.ownerUserId, updatedAt: input.now })
            .where(eq(employeeCases.id, input.caseId))
        }
        await tx.delete(employeeCaseMembers).where(eq(employeeCaseMembers.caseId, input.caseId))
        if (input.members.length > 0) {
          await tx.insert(employeeCaseMembers).values(
            input.members.map((member) => ({
              caseId: input.caseId,
              userId: member.userId,
              role: member.role,
              addedBy: input.addedBy,
              addedAt: input.now,
            })),
          )
        }
        return {
          previousOwnerUserId: current.ownerUserId,
          previousMemberUserIds: before.map((row) => row.userId),
        }
      })
    },

    async findCaseByEventDelivery(eventDeliveryId) {
      const { employeeCases, employeeCaseEventOrigins } = tablesOf(db)
      const row = await first(
        db
          .select({ case: employeeCases })
          .from(employeeCaseEventOrigins)
          .innerJoin(employeeCases, eq(employeeCases.id, employeeCaseEventOrigins.caseId))
          .where(eq(employeeCaseEventOrigins.eventDeliveryId, eventDeliveryId)),
      )
      return row === undefined ? null : caseRecord(row.case)
    },

    async listCases(employeeId, state) {
      const { employeeCases } = tablesOf(db)
      const conditions = [
        ...(employeeId === undefined ? [] : [eq(employeeCases.employeeId, employeeId)]),
        ...(state === undefined
          ? []
          : [eq(employeeCases.state, state as EmployeeCaseRecord['state'])]),
      ]
      return (
        await db
          .select()
          .from(employeeCases)
          .where(conditions.length === 0 ? undefined : and(...conditions))
          .orderBy(desc(employeeCases.updatedAt), desc(employeeCases.id))
      ).map(caseRecord)
    },

    async listTerminalOutcomeGroups() {
      const { employeeCases } = tablesOf(db)
      const rows = await db
        .select({
          employeeId: employeeCases.employeeId,
          terminalKind: employeeCases.terminalKind,
          count: count(),
        })
        .from(employeeCases)
        .where(eq(employeeCases.state, 'terminal'))
        .groupBy(employeeCases.employeeId, employeeCases.terminalKind)
        .orderBy(asc(employeeCases.employeeId), engine.ascNullsFirst(employeeCases.terminalKind))
        .limit(maxEmployeeOutcomeGroups + 1)
      if (rows.length > maxEmployeeOutcomeGroups) {
        throw new Error('employee-outcome-group-limit-exceeded')
      }
      return rows.map((row) => ({
        employeeId: row.employeeId,
        terminalKind: row.terminalKind ?? 'completed',
        count: Number(row.count),
      }))
    },

    async listCasesPage(input) {
      // RFC-330 缺口 1：成员制过滤。与 `services/taskAuthorization.ts` 的
      // `taskOwnershipScopeCondition` 同形（那边是 task_collaborators）；shared 对
      // `owner_user_id IS NULL` 也成立，否则无主案例的成员在「与我共享」里看不到它。
      const membershipCondition = (): SQL | null => {
        if (input.membership === undefined) return null
        const { employeeCases, employeeCaseMembers } = tablesOf(db)
        const memberOf = inArray(
          employeeCases.id,
          db
            .select({ id: employeeCaseMembers.caseId })
            .from(employeeCaseMembers)
            .where(eq(employeeCaseMembers.userId, input.membership.actorUserId)),
        )
        if (input.membership.scope === 'shared') {
          return and(
            memberOf,
            or(
              isNull(employeeCases.ownerUserId),
              ne(employeeCases.ownerUserId, input.membership.actorUserId),
            ),
          )!
        }
        return or(eq(employeeCases.ownerUserId, input.membership.actorUserId), memberOf)!
      }
      const conditions: SQL[] = []
      if (input.employeeId !== undefined) {
        const { employeeCases } = tablesOf(db)
        conditions.push(eq(employeeCases.employeeId, input.employeeId))
      }
      if (input.ownerUserId !== undefined) {
        const { employeeCases } = tablesOf(db)
        conditions.push(eq(employeeCases.ownerUserId, input.ownerUserId))
      }
      const membership = membershipCondition()
      if (membership !== null) conditions.push(membership)
      if (input.launchOrigin !== undefined) {
        const { employeeCases } = tablesOf(db)
        conditions.push(eq(employeeCases.launchOrigin, input.launchOrigin))
      }
      if (input.states !== undefined) {
        const { employeeCases } = tablesOf(db)
        conditions.push(
          input.states.length === 0 ? sql`0 = 1` : inArray(employeeCases.state, [...input.states]),
        )
      }
      if (input.terminalCatalogStatuses !== undefined) {
        const wantsDone = input.terminalCatalogStatuses.includes('done')
        const wantsCanceled = input.terminalCatalogStatuses.includes('canceled')
        if (wantsDone !== wantsCanceled) {
          const { employeeCases } = tablesOf(db)
          conditions.push(
            wantsCanceled
              ? or(
                  ne(employeeCases.state, 'terminal'),
                  inArray(employeeCases.terminalKind, [
                    ...EMPLOYEE_TERMINAL_CATALOG_CANCELED_KINDS,
                  ]),
                )!
              : or(
                  ne(employeeCases.state, 'terminal'),
                  isNull(employeeCases.terminalKind),
                  notInArray(employeeCases.terminalKind, [
                    ...EMPLOYEE_TERMINAL_CATALOG_CANCELED_KINDS,
                  ]),
                )!,
          )
        } else if (!wantsDone) {
          const { employeeCases } = tablesOf(db)
          conditions.push(ne(employeeCases.state, 'terminal'))
        }
      }
      if (input.view === 'active') {
        const { employeeCases } = tablesOf(db)
        conditions.push(inArray(employeeCases.state, ['active', 'waiting']))
      } else if (input.view === 'attention') {
        const { employeeCases } = tablesOf(db)
        conditions.push(eq(employeeCases.state, 'blocked'))
      } else if (input.view === 'finished') {
        const { employeeCases } = tablesOf(db)
        conditions.push(eq(employeeCases.state, 'terminal'))
      }
      if (input.q !== undefined) {
        const { pattern, escape } = engine.likeEscape(input.q)
        const { employeeCases, employeeContextRecords } = tablesOf(db)
        conditions.push(
          or(
            engine.likeCaseInsensitive(employeeCases.name, pattern, escape),
            engine.likeCaseInsensitive(employeeCases.id, pattern, escape),
            engine.likeCaseInsensitive(employeeCases.employeeId, pattern, escape),
            engine.likeCaseInsensitive(employeeCases.blockReason, pattern, escape),
            engine.likeCaseInsensitive(employeeContextRecords.stateJson, pattern, escape),
          )!,
        )
      }
      if (input.cursor !== null) {
        const { employeeCases } = tablesOf(db)
        conditions.push(
          or(
            lt(employeeCases.updatedAt, input.cursor.updatedAt),
            and(
              eq(employeeCases.updatedAt, input.cursor.updatedAt),
              lt(employeeCases.id, input.cursor.id),
            ),
          )!,
        )
      }
      const { employeeCases, employeeContextRecords } = tablesOf(db)
      const rows = await db
        .select({ case: employeeCases })
        .from(employeeCases)
        .innerJoin(
          employeeContextRecords,
          eq(employeeContextRecords.id, employeeCases.primaryContextId),
        )
        .where(conditions.length === 0 ? undefined : and(...conditions))
        .orderBy(desc(employeeCases.updatedAt), desc(employeeCases.id))
        .limit(input.limit + 1)
      const facetConditions: SQL[] = []
      if (input.employeeId !== undefined) {
        facetConditions.push(eq(employeeCases.employeeId, input.employeeId))
      }
      if (input.ownerUserId !== undefined) {
        facetConditions.push(eq(employeeCases.ownerUserId, input.ownerUserId))
      }
      const facetMembership = membershipCondition()
      if (facetMembership !== null) facetConditions.push(facetMembership)
      if (input.launchOrigin !== undefined) {
        facetConditions.push(eq(employeeCases.launchOrigin, input.launchOrigin))
      }
      const facetBase = facetConditions.length === 0 ? undefined : and(...facetConditions)
      const countWhere = async (stateWhere?: SQL) => {
        const row = await first(
          db
            .select({ value: count() })
            .from(employeeCases)
            .where(
              facetBase === undefined
                ? stateWhere
                : stateWhere === undefined
                  ? facetBase
                  : and(facetBase, stateWhere),
            ),
        )
        return Number(row?.value ?? 0)
      }
      const [all, active, attention, finished] = await Promise.all([
        countWhere(),
        countWhere(inArray(employeeCases.state, ['active', 'waiting'])),
        countWhere(eq(employeeCases.state, 'blocked')),
        countWhere(eq(employeeCases.state, 'terminal')),
      ])
      return {
        cases: rows.slice(0, input.limit).map((row) => caseRecord(row.case)),
        hasMore: rows.length > input.limit,
        facets: {
          all,
          active,
          attention,
          finished,
        },
      }
    },

    async findCaseByExternalSubject(subjectType, subjectRef) {
      const { employeeCases, employeeExternalContextBindings } = tablesOf(db)
      const row = await first(
        db
          .select({ case: employeeCases })
          .from(employeeExternalContextBindings)
          .innerJoin(employeeCases, eq(employeeCases.id, employeeExternalContextBindings.caseId))
          .where(
            and(
              eq(employeeExternalContextBindings.subjectType, subjectType),
              eq(employeeExternalContextBindings.subjectRef, subjectRef),
            ),
          ),
      )
      return row === undefined ? null : caseRecord(row.case)
    },

    async listContexts(caseId) {
      const { employeeContextRecords } = tablesOf(db)
      return (
        await db
          .select()
          .from(employeeContextRecords)
          .where(eq(employeeContextRecords.caseId, caseId))
          .orderBy(asc(employeeContextRecords.createdAt), asc(employeeContextRecords.id))
      ).map(contextRecord)
    },

    async listAttention(caseId) {
      const { employeeAttentionBindings } = tablesOf(db)
      return (
        await db
          .select()
          .from(employeeAttentionBindings)
          .where(eq(employeeAttentionBindings.caseId, caseId))
          .orderBy(asc(employeeAttentionBindings.createdAt), asc(employeeAttentionBindings.id))
      ).map(attentionRecord)
    },

    async listInbox(caseId) {
      const { employeeCaseInbox } = tablesOf(db)
      return (
        await db
          .select()
          .from(employeeCaseInbox)
          .where(eq(employeeCaseInbox.caseId, caseId))
          .orderBy(
            desc(employeeCaseInbox.priority),
            asc(employeeCaseInbox.occurredAt),
            asc(employeeCaseInbox.eventId),
          )
      ).map(inboxRecord)
    },

    async listRounds(caseId) {
      const { employeeReactionRounds } = tablesOf(db)
      return (
        await db
          .select()
          .from(employeeReactionRounds)
          .where(eq(employeeReactionRounds.caseId, caseId))
          .orderBy(desc(employeeReactionRounds.createdAt), desc(employeeReactionRounds.id))
      ).map(roundRecord)
    },

    async listRunningRounds() {
      const { employeeReactionRounds } = tablesOf(db)
      return (
        await db
          .select()
          .from(employeeReactionRounds)
          .where(eq(employeeReactionRounds.state, 'running'))
          .orderBy(asc(employeeReactionRounds.updatedAt), asc(employeeReactionRounds.id))
      ).map(roundRecord)
    },

    async listInvocationsForRound(roundId) {
      const { employeeInvocations } = tablesOf(db)
      return (
        await db
          .select()
          .from(employeeInvocations)
          .where(eq(employeeInvocations.parentRoundId, roundId))
          .orderBy(asc(employeeInvocations.createdAt), asc(employeeInvocations.id))
      ).map(invocationRecord)
    },

    async createInvocation(record) {
      return await session.transaction(async (tx) => {
        const { employeeInvocations } = tablesOf(tx)
        const existing = await first(
          tx
            .select()
            .from(employeeInvocations)
            .where(eq(employeeInvocations.idempotencyKey, record.idempotencyKey)),
        )
        if (existing !== undefined) {
          if (
            existing.parentRoundId !== record.parentRoundId ||
            existing.targetEmployeeId !== record.targetEmployeeRef.id ||
            existing.targetEmployeeRevision !== record.targetEmployeeRef.revision ||
            existing.inputDigest !== record.inputDigest
          ) {
            throw new ConflictError(
              'employee-invocation-idempotency-conflict',
              `invocation identity was reused with different input: ${record.idempotencyKey}`,
            )
          }
          return invocationRecord(existing)
        }
        await insertOne(tx, employeeInvocations, {
          id: record.id,
          idempotencyKey: record.idempotencyKey,
          parentCaseId: record.parentCaseId,
          parentRoundId: record.parentRoundId,
          targetEmployeeId: record.targetEmployeeRef.id,
          targetEmployeeRevision: record.targetEmployeeRef.revision,
          targetWorkScopeRefJson: record.targetWorkScopeRefJson,
          inputEnvelopeRef: record.inputEnvelopeRef,
          inputDigest: record.inputDigest,
          completionContractRefJson: record.completionContractRefJson,
          deadlineAt: record.deadlineAt,
          childCaseId: record.childCaseId,
          state: record.state,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        })
        return record
      })
    },

    async acceptInvocation(input) {
      return await session.transaction(async (tx) => {
        const { employeeInvocations, employeeChannels } = tablesOf(tx)
        const invocation = await first(
          tx
            .select()
            .from(employeeInvocations)
            .where(eq(employeeInvocations.id, input.invocationId)),
        )
        if (invocation === undefined) {
          throw new NotFoundError(
            'employee-invocation-not-found',
            `employee invocation not found: ${input.invocationId}`,
          )
        }
        const existing = await first(
          tx
            .select()
            .from(employeeChannels)
            .where(eq(employeeChannels.invocationId, input.invocationId)),
        )
        if (existing !== undefined) {
          if (existing.childCaseId !== input.childCaseId) {
            throw new ConflictError(
              'employee-channel-child-conflict',
              'invocation is already linked to another child case',
            )
          }
          return channelRecord(existing)
        }
        await insertOne(tx, employeeChannels, {
          id: input.channel.id,
          invocationId: input.channel.invocationId,
          parentCaseId: input.channel.parentCaseId,
          childCaseId: input.channel.childCaseId,
          correlationRef: input.channel.correlationRef,
          resultContractRefJson: input.channel.resultContractRefJson,
          state: input.channel.state,
          createdAt: input.channel.createdAt,
          updatedAt: input.channel.updatedAt,
        })
        await tx
          .update(employeeInvocations)
          .set({ childCaseId: input.childCaseId, state: 'waiting', updatedAt: input.now })
          .where(eq(employeeInvocations.id, input.invocationId))
        return input.channel
      })
    },

    async getChannelByInvocation(invocationId) {
      const { employeeChannels } = tablesOf(db)
      const row = await first(
        db.select().from(employeeChannels).where(eq(employeeChannels.invocationId, invocationId)),
      )
      return row === undefined ? null : channelRecord(row)
    },

    async listChannels(caseId) {
      const { employeeChannels } = tablesOf(db)
      return (
        await db
          .select()
          .from(employeeChannels)
          .where(
            or(eq(employeeChannels.parentCaseId, caseId), eq(employeeChannels.childCaseId, caseId)),
          )
          .orderBy(asc(employeeChannels.createdAt), asc(employeeChannels.id))
      ).map(channelRecord)
    },

    async listChannelResults(channelId) {
      const { employeeChannelResults } = tablesOf(db)
      return (
        await db
          .select()
          .from(employeeChannelResults)
          .where(eq(employeeChannelResults.channelId, channelId))
          .orderBy(asc(employeeChannelResults.createdAt), asc(employeeChannelResults.id))
      ).map(channelResultRecord)
    },

    async listOpenChannelsWithTerminalChild(limit) {
      const { employeeChannels, employeeCases, employeeChannelResults } = tablesOf(db)
      return (
        await db
          .select({ channel: employeeChannels, child: employeeCases })
          .from(employeeChannels)
          .innerJoin(employeeCases, eq(employeeCases.id, employeeChannels.childCaseId))
          .where(
            and(
              inArray(employeeChannels.state, ['open', 'detached']),
              eq(employeeCases.state, 'terminal'),
              notExists(
                db
                  .select({ id: employeeChannelResults.id })
                  .from(employeeChannelResults)
                  .where(eq(employeeChannelResults.channelId, employeeChannels.id)),
              ),
            ),
          )
          .orderBy(engine.ascNullsFirst(employeeCases.terminalAt), asc(employeeChannels.id))
          .limit(limit)
      ).map((row) => ({ channel: channelRecord(row.channel), childCase: caseRecord(row.child) }))
    },

    async listExpiredOpenChannels(now, limit) {
      const { employeeChannels, employeeInvocations, employeeCases } = tablesOf(db)
      return (
        await db
          .select({
            channel: employeeChannels,
            invocation: employeeInvocations,
            child: employeeCases,
          })
          .from(employeeChannels)
          .innerJoin(employeeInvocations, eq(employeeInvocations.id, employeeChannels.invocationId))
          .innerJoin(employeeCases, eq(employeeCases.id, employeeChannels.childCaseId))
          .where(and(eq(employeeChannels.state, 'open'), lte(employeeInvocations.deadlineAt, now)))
          .orderBy(asc(employeeInvocations.deadlineAt), asc(employeeChannels.id))
          .limit(limit)
      ).map((row) => ({
        channel: channelRecord(row.channel),
        invocation: invocationRecord(row.invocation),
        childCase: caseRecord(row.child),
      }))
    },

    async settleChannelResult(input) {
      await session.transaction(async (tx) => {
        const { employeeChannelResults, employeeChannels, employeeInvocations } = tablesOf(tx)
        await tx
          .insert(employeeChannelResults)
          .values({
            id: input.result.id,
            channelId: input.result.channelId,
            milestoneType: input.result.milestoneType,
            envelopeJson: input.result.envelopeJson,
            envelopeDigest: input.result.envelopeDigest,
            monotonic: input.result.monotonic,
            createdAt: input.result.createdAt,
          })
          .onConflictDoNothing()
        const channel = await first(
          tx.select().from(employeeChannels).where(eq(employeeChannels.id, input.result.channelId)),
        )
        if (channel === undefined) {
          throw new NotFoundError(
            'employee-channel-not-found',
            `employee channel not found: ${input.result.channelId}`,
          )
        }
        await tx
          .update(employeeChannels)
          .set({ state: input.channelState, updatedAt: input.now })
          .where(eq(employeeChannels.id, channel.id))
        await tx
          .update(employeeInvocations)
          .set({ state: input.channelState, updatedAt: input.now })
          .where(eq(employeeInvocations.id, channel.invocationId))
      })
    },

    async detachOpenChannelsForRound(roundId, now) {
      await session.transaction(async (tx) => {
        const { employeeInvocations, employeeChannels } = tablesOf(tx)
        const invocations = await tx
          .select({ id: employeeInvocations.id })
          .from(employeeInvocations)
          .where(eq(employeeInvocations.parentRoundId, roundId))
        for (const invocation of invocations) {
          await tx
            .update(employeeInvocations)
            .set({ state: 'detached', updatedAt: now })
            .where(
              and(
                eq(employeeInvocations.id, invocation.id),
                inArray(employeeInvocations.state, ['requested', 'accepted', 'waiting']),
              ),
            )
          await tx
            .update(employeeChannels)
            .set({ state: 'detached', updatedAt: now })
            .where(
              and(
                eq(employeeChannels.invocationId, invocation.id),
                eq(employeeChannels.state, 'open'),
              ),
            )
        }
      })
    },

    async claimOutbox(input) {
      const { employeeOsOutbox } = tablesOf(db)
      const candidate = await first(
        db
          .select()
          .from(employeeOsOutbox)
          .where(
            and(
              or(
                eq(employeeOsOutbox.state, 'pending'),
                and(
                  eq(employeeOsOutbox.state, 'claimed'),
                  or(
                    isNull(employeeOsOutbox.claimExpiresAt),
                    lte(employeeOsOutbox.claimExpiresAt, input.now),
                  ),
                ),
              ),
              lte(employeeOsOutbox.nextAttemptAt, input.now),
              // RFC-368：遗留的 `execution-launch` 行只由派发臂的一次性收编处理。
              ne(employeeOsOutbox.kind, LEGACY_EXECUTION_LAUNCH_KIND),
            ),
          )
          .orderBy(asc(employeeOsOutbox.createdAt), asc(employeeOsOutbox.id)),
      )
      if (candidate === undefined) return null
      const claimed = affectedRows(
        await db
          .update(employeeOsOutbox)
          .set({
            state: 'claimed',
            claimedBy: input.workerId,
            claimExpiresAt: input.now + input.leaseMs,
            attemptCount: candidate.attemptCount + 1,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(employeeOsOutbox.id, candidate.id),
              eq(employeeOsOutbox.attemptCount, candidate.attemptCount),
              inArray(employeeOsOutbox.state, ['pending', 'claimed']),
            ),
          ),
      )
      if (claimed !== 1) return null
      return outboxRecord({
        ...candidate,
        state: 'claimed',
        claimedBy: input.workerId,
        claimExpiresAt: input.now + input.leaseMs,
        attemptCount: candidate.attemptCount + 1,
        updatedAt: input.now,
      })
    },

    async completeOutbox(id, workerId, now) {
      const { employeeOsOutbox } = tablesOf(db)
      const result = await db
        .update(employeeOsOutbox)
        .set({
          state: 'completed',
          claimedBy: null,
          claimExpiresAt: null,
          lastError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(employeeOsOutbox.id, id),
            eq(employeeOsOutbox.state, 'claimed'),
            eq(employeeOsOutbox.claimedBy, workerId),
          ),
        )
      if (affectedRows(result) !== 1) throw new Error(`lost outbox claim: ${id}`)
    },

    async retryOutbox(input) {
      const { employeeOsOutbox } = tablesOf(db)
      const result = await db
        .update(employeeOsOutbox)
        .set({
          state: input.terminal ? 'failed' : 'pending',
          claimedBy: null,
          claimExpiresAt: null,
          nextAttemptAt: input.nextAttemptAt,
          lastError: input.error.slice(0, 2_000),
          updatedAt: input.now,
        })
        .where(
          and(
            eq(employeeOsOutbox.id, input.id),
            eq(employeeOsOutbox.state, 'claimed'),
            eq(employeeOsOutbox.claimedBy, input.workerId),
          ),
        )
      if (affectedRows(result) !== 1) throw new Error(`lost outbox claim: ${input.id}`)
    },

    async activateAttention(bindingId, subscriptionId, now) {
      const { employeeAttentionBindings } = tablesOf(db)
      const result = await db
        .update(employeeAttentionBindings)
        .set({ eventSubscriptionId: subscriptionId, state: 'active', updatedAt: now })
        .where(
          and(
            eq(employeeAttentionBindings.id, bindingId),
            inArray(employeeAttentionBindings.state, ['desired', 'active']),
          ),
        )
      if (affectedRows(result) !== 1) {
        throw new NotFoundError('employee-attention-not-found', `attention not found: ${bindingId}`)
      }
    },

    async cancelAttention(bindingId, now) {
      const { employeeAttentionBindings } = tablesOf(db)
      await db
        .update(employeeAttentionBindings)
        .set({ eventSubscriptionId: null, state: 'cancelled', updatedAt: now })
        .where(
          and(
            eq(employeeAttentionBindings.id, bindingId),
            eq(employeeAttentionBindings.state, 'cancel-requested'),
          ),
        )
    },

    async acceptDelivery(caseId, id, delivery, priority, now) {
      return await session.transaction(async (tx) => {
        const { employeeCaseInbox, employeeCases } = tablesOf(tx)
        const existing = await first(
          tx
            .select({ id: employeeCaseInbox.id })
            .from(employeeCaseInbox)
            .where(eq(employeeCaseInbox.deliveryId, delivery.deliveryId)),
        )
        if (existing !== undefined) return false
        const current = await first(
          tx.select().from(employeeCases).where(eq(employeeCases.id, caseId)),
        )
        if (current === undefined) {
          throw new NotFoundError('employee-case-not-found', `employee case not found: ${caseId}`)
        }
        if (current.state !== 'terminal') {
          await tx
            .update(employeeCaseInbox)
            .set({ state: 'coalesced', settledAt: now })
            .where(
              and(
                eq(employeeCaseInbox.caseId, caseId),
                eq(employeeCaseInbox.eventTypeId, delivery.eventTypeRef.id),
                eq(employeeCaseInbox.eventTypeRevision, delivery.eventTypeRef.revision),
                eq(employeeCaseInbox.subjectType, delivery.subject.typeId),
                eq(employeeCaseInbox.subjectRef, delivery.subject.subjectRef),
                eq(employeeCaseInbox.state, 'pending'),
              ),
            )
        }
        await insertOne(tx, employeeCaseInbox, {
          id,
          caseId,
          deliveryId: delivery.deliveryId,
          eventId: delivery.eventId,
          eventTypeId: delivery.eventTypeRef.id,
          eventTypeRevision: delivery.eventTypeRef.revision,
          sourceId: delivery.sourceRef.id,
          sourceRevision: delivery.sourceRef.revision,
          subjectType: delivery.subject.typeId,
          subjectRef: delivery.subject.subjectRef,
          deliveryClass: delivery.deliveryClass,
          priority,
          occurredAt: delivery.occurredAt,
          summary: delivery.summary,
          payloadArtifactRef: delivery.payloadArtifactRef,
          state: current.state === 'terminal' ? 'obsolete' : 'pending',
          acceptedAt: now,
          ...(current.state === 'terminal' ? { settledAt: now } : {}),
        })
        return true
      })
    },

    async markInbox(inboxId, state, now) {
      const { employeeCaseInbox } = tablesOf(db)
      await db
        .update(employeeCaseInbox)
        .set({ state, settledAt: now })
        .where(and(eq(employeeCaseInbox.id, inboxId), eq(employeeCaseInbox.state, 'pending')))
    },

    async createRound(input) {
      return await session.transaction(async (tx) => {
        const {
          employeeCases,
          employeeCaseInbox,
          employeeReactionRounds,
          employeeOsOutbox,
          employeeReactionDispatch,
        } = tablesOf(tx)
        const current = await first(
          tx.select().from(employeeCases).where(eq(employeeCases.id, input.round.caseId)),
        )
        if (
          current === undefined ||
          current.revision !== input.expectedCaseRevision ||
          current.activeRoundId !== null ||
          current.state === 'terminal'
        ) {
          return false
        }
        const inbox =
          input.inboxId === null
            ? null
            : await first(
                tx.select().from(employeeCaseInbox).where(eq(employeeCaseInbox.id, input.inboxId)),
              )
        if (
          input.inboxId !== null &&
          (inbox === null || inbox === undefined || inbox.state !== 'pending')
        ) {
          return false
        }
        await insertOne(tx, employeeReactionRounds, {
          id: input.round.id,
          caseId: input.round.caseId,
          caseRevision: input.round.caseRevision,
          inboxId: input.round.inboxId,
          employeeId: input.round.employeeRef.id,
          employeeRevision: input.round.employeeRef.revision,
          ruleId: input.round.ruleId,
          workItemRef: input.round.workItemRef,
          workContractId: input.round.workContractRef.contractId,
          workContractVersion: input.round.workContractRef.version,
          toolId: input.round.toolRef?.id ?? null,
          toolRevision: input.round.toolRef?.revision ?? null,
          executionPolicyRevision: input.round.executionPolicyRevision,
          inputContextRefsJson: input.round.inputContextRefsJson,
          planJson: JSON.stringify(input.plan),
          state: 'planned',
          executionRef: null,
          outputJson: null,
          attemptOrdinal: 0,
          createdAt: input.round.createdAt,
          updatedAt: input.round.updatedAt,
        })
        if (inbox !== null && inbox !== undefined) {
          await tx
            .update(employeeCaseInbox)
            .set({ state: 'claimed', roundId: input.round.id })
            .where(eq(employeeCaseInbox.id, inbox.id))
        }
        await tx
          .update(employeeCases)
          .set({
            activeRoundId: input.round.id,
            currentWorkItemRef: input.round.workItemRef,
            revision: current.revision + 1,
            updatedAt: input.round.createdAt,
          })
          .where(
            and(
              eq(employeeCases.id, current.id),
              eq(employeeCases.revision, input.expectedCaseRevision),
            ),
          )
        if (input.launchOutbox !== null) {
          await insertOne(tx, employeeOsOutbox, {
            id: input.launchOutbox.id,
            caseId: input.launchOutbox.caseId,
            kind: input.launchOutbox.kind,
            payloadJson: input.launchOutbox.payloadJson,
            dedupeKey: input.launchOutbox.dedupeKey,
            state: 'pending',
            attemptCount: 0,
            nextAttemptAt: input.round.createdAt,
            createdAt: input.round.createdAt,
            updatedAt: input.round.createdAt,
          })
        }
        if (input.reactionDispatch !== undefined && input.reactionDispatch !== null) {
          await insertOne(tx, employeeReactionDispatch, {
            roundRef: input.round.id,
            caseId: input.round.caseId,
            nextAttemptAt: input.reactionDispatch.nextAttemptAt,
            createdAt: input.round.createdAt,
            updatedAt: input.round.createdAt,
          })
        }
        return true
      })
    },

    async markRoundRunning(roundId, executionRef, now) {
      const { employeeReactionRounds } = tablesOf(db)
      await db
        .update(employeeReactionRounds)
        .set({ state: 'running', executionRef, updatedAt: now })
        .where(
          and(eq(employeeReactionRounds.id, roundId), eq(employeeReactionRounds.state, 'planned')),
        )
    },

    async adoptLegacyReactionLaunches(input) {
      return await session.transaction(async (tx) => {
        const { employeeOsOutbox, employeeReactionRounds, employeeReactionDispatch } = tablesOf(tx)
        const { employeeReactionArtifacts } = tablesOf(tx)
        const rows = await tx
          .select()
          .from(employeeOsOutbox)
          .where(
            and(
              eq(employeeOsOutbox.kind, LEGACY_EXECUTION_LAUNCH_KIND),
              inArray(employeeOsOutbox.state, ['pending', 'claimed']),
            ),
          )
        for (const row of rows) {
          const payload = legacyExecutionLaunchPayloadSchema.safeParse(
            parseJsonOrNull(row.payloadJson),
          )
          const round = payload.success
            ? await first(
                tx
                  .select()
                  .from(employeeReactionRounds)
                  .where(eq(employeeReactionRounds.id, payload.data.roundId)),
              )
            : undefined
          if (payload.success && round !== undefined && round.state === 'planned') {
            const previousError = payload.data.attempt.previousError
            let retryFeedbackRef: string | null = null
            if (previousError !== null && previousError.length > 0) {
              const separator = /^([a-z0-9][a-z0-9._-]*): /.exec(previousError)
              const text = sanitizeReactionText({
                errorCode: separator?.[1] ?? 'previous-error',
                errorDetail:
                  separator === null ? previousError : previousError.slice(separator[0].length),
                workspaceRoot: null,
              })
              await tx
                .insert(employeeReactionArtifacts)
                .values({
                  digest: text.digest,
                  kind: 'retry-feedback',
                  ...(await databaseContentColumnsInTx(
                    tx,
                    'employee-reaction',
                    text.digest,
                    Buffer.from(text.body),
                  )),
                  bytes: Buffer.byteLength(text.body, 'utf8'),
                  createdAt: input.now,
                })
                .onConflictDoNothing({ target: employeeReactionArtifacts.digest })
              retryFeedbackRef = reactionArtifactRef('retry-feedback', text.digest)
            }
            await tx
              .update(employeeReactionRounds)
              .set({
                planJson: JSON.stringify(payload.data.plan),
                attemptOrdinal: payload.data.attempt.ordinal,
                updatedAt: input.now,
              })
              .where(eq(employeeReactionRounds.id, round.id))
            await tx
              .insert(employeeReactionDispatch)
              .values({
                roundRef: round.id,
                caseId: round.caseId,
                nextAttemptAt: row.nextAttemptAt,
                dispatchAttempts: row.attemptCount,
                lastDispatchError: row.lastError,
                retryFeedbackRef,
                createdAt: input.now,
                updatedAt: input.now,
              })
              .onConflictDoNothing({ target: employeeReactionDispatch.roundRef })
          }
          // 行本身删掉：round 已不在 planned（结算过了）或 payload 读不懂的，也没有派发的意义了。
          await tx.delete(employeeOsOutbox).where(eq(employeeOsOutbox.id, row.id))
        }
        return rows.length
      })
    },

    async claimReactionDispatch(input) {
      const { employeeReactionDispatch, employeeReactionRounds } = tablesOf(db)
      const candidate = await first(
        db
          .select({ dispatch: employeeReactionDispatch, round: employeeReactionRounds })
          .from(employeeReactionDispatch)
          .innerJoin(
            employeeReactionRounds,
            eq(employeeReactionRounds.id, employeeReactionDispatch.roundRef),
          )
          .where(
            and(
              eq(employeeReactionRounds.state, 'planned'),
              lte(employeeReactionDispatch.nextAttemptAt, input.now),
              or(
                isNull(employeeReactionDispatch.dispatchLeaseExpiresAt),
                lte(employeeReactionDispatch.dispatchLeaseExpiresAt, input.now),
              ),
            ),
          )
          .orderBy(
            asc(employeeReactionDispatch.nextAttemptAt),
            asc(employeeReactionDispatch.roundRef),
          ),
      )
      if (candidate === undefined) return null
      const leaseExpiresAt = input.now + input.leaseMs
      // CAS：尝试次数没变且租约仍可领——两个 worker 同时选中同一行时只有一个能改到。
      const claimed = affectedRows(
        await db
          .update(employeeReactionDispatch)
          .set({
            dispatchClaimedBy: input.workerId,
            dispatchLeaseExpiresAt: leaseExpiresAt,
            dispatchAttempts: candidate.dispatch.dispatchAttempts + 1,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(employeeReactionDispatch.roundRef, candidate.dispatch.roundRef),
              eq(employeeReactionDispatch.dispatchAttempts, candidate.dispatch.dispatchAttempts),
              or(
                isNull(employeeReactionDispatch.dispatchLeaseExpiresAt),
                lte(employeeReactionDispatch.dispatchLeaseExpiresAt, input.now),
              ),
            ),
          ),
      )
      if (claimed !== 1) return null
      return {
        round: roundRecord(candidate.round),
        dispatch: dispatchRecord({
          ...candidate.dispatch,
          dispatchClaimedBy: input.workerId,
          dispatchLeaseExpiresAt: leaseExpiresAt,
          dispatchAttempts: candidate.dispatch.dispatchAttempts + 1,
          updatedAt: input.now,
        }),
      }
    },

    async admitReactionDispatch(input) {
      const participantFor = options.reactionAdmission
      if (participantFor === undefined) {
        throw new Error('reaction admission participant is not wired into runtime persistence')
      }
      return await session.transaction(async (tx) => {
        const { employeeReactionDispatch, employeeReactionRounds } = tablesOf(tx)
        const row = await first(
          tx
            .select({ dispatch: employeeReactionDispatch, round: employeeReactionRounds })
            .from(employeeReactionDispatch)
            .innerJoin(
              employeeReactionRounds,
              eq(employeeReactionRounds.id, employeeReactionDispatch.roundRef),
            )
            .where(eq(employeeReactionDispatch.roundRef, input.roundId)),
        )
        if (
          row === undefined ||
          row.round.state !== 'planned' ||
          row.dispatch.dispatchClaimedBy !== input.workerId ||
          row.dispatch.dispatchLeaseExpiresAt === null ||
          row.dispatch.dispatchLeaseExpiresAt <= input.now
        ) {
          throw new ConflictError(
            'employee-reaction-dispatch-lost',
            `reaction dispatch lease is no longer held: ${input.roundId}`,
          )
        }
        const participant = participantFor(tx)
        const previous = row.dispatch.claimEpoch
        const nextEpoch = (previous + 1) as ReactionClaimEpoch
        const fence = await participant.activateClaim({
          employeeCase: { id: row.dispatch.caseId },
          reaction: { roundRef: input.roundId },
          expectedPreviousEpoch: previous === 0 ? null : (previous as ReactionClaimEpoch),
          nextEpoch,
          authority: input.authority,
        })
        const receipt = await participant.admitLaunch({
          fence,
          operation: input.operation,
          requestHash: input.requestHash,
        })
        await tx
          .update(employeeReactionDispatch)
          .set({ claimEpoch: nextEpoch, operationRef: input.operation, updatedAt: input.now })
          .where(
            and(
              eq(employeeReactionDispatch.roundRef, input.roundId),
              eq(employeeReactionDispatch.claimEpoch, previous),
            ),
          )
        // 执行身份在事务内就写下（design §4.1）：「任务已建、ref 未写回」这一格因此不存在。
        await tx
          .update(employeeReactionRounds)
          .set({ executionRef: receipt.execution, updatedAt: input.now })
          .where(
            and(
              eq(employeeReactionRounds.id, input.roundId),
              eq(employeeReactionRounds.state, 'planned'),
            ),
          )
        return receipt
      })
    },

    async retryReactionDispatch(input) {
      await session.transaction(async (tx) => {
        const { employeeReactionDispatch, employeeReactionRounds } = tablesOf(tx)
        const released = affectedRows(
          await tx
            .update(employeeReactionDispatch)
            .set({
              dispatchClaimedBy: null,
              dispatchLeaseExpiresAt: null,
              nextAttemptAt: input.nextAttemptAt,
              lastDispatchError: input.error.slice(0, 2_000),
              operationRef: null,
              updatedAt: input.now,
            })
            .where(
              and(
                eq(employeeReactionDispatch.roundRef, input.roundId),
                eq(employeeReactionDispatch.dispatchClaimedBy, input.workerId),
              ),
            ),
        )
        if (released !== 1) {
          throw new ConflictError(
            'employee-reaction-dispatch-lost',
            `reaction dispatch lease is no longer held: ${input.roundId}`,
          )
        }
        await tx
          .update(employeeReactionRounds)
          .set({ executionRef: null, updatedAt: input.now })
          .where(
            and(
              eq(employeeReactionRounds.id, input.roundId),
              eq(employeeReactionRounds.state, 'planned'),
            ),
          )
      })
    },

    async retryRound(input) {
      await session.transaction(async (tx) => {
        const { employeeReactionRounds, employeeReactionDispatch } = tablesOf(tx)
        const round = await first(
          tx
            .select()
            .from(employeeReactionRounds)
            .where(eq(employeeReactionRounds.id, input.roundId)),
        )
        if (
          round === undefined ||
          round.state !== 'running' ||
          round.executionRef !== input.expectedExecutionRef
        ) {
          throw new ConflictError(
            'employee-reaction-retry-stale',
            `reaction round cannot be retried: ${input.roundId}`,
          )
        }
        const dispatch = input.reactionDispatch
        await tx
          .update(employeeReactionRounds)
          .set({
            state: 'planned',
            executionRef: null,
            outputJson: input.errorJson,
            attemptOrdinal: input.attemptOrdinal,
            planJson: JSON.stringify(dispatch.plan),
            updatedAt: input.now,
          })
          .where(
            and(
              eq(employeeReactionRounds.id, input.roundId),
              eq(employeeReactionRounds.state, 'running'),
              eq(employeeReactionRounds.executionRef, input.expectedExecutionRef),
            ),
          )
        const reset = {
          nextAttemptAt: input.nextAttemptAt,
          dispatchAttempts: 0,
          dispatchClaimedBy: null,
          dispatchLeaseExpiresAt: null,
          operationRef: null,
          retryFeedbackRef: dispatch.retryFeedbackRef,
          lastDispatchError: dispatch.lastDispatchError,
          updatedAt: input.now,
        }
        const updated = affectedRows(
          await tx
            .update(employeeReactionDispatch)
            .set(reset)
            .where(eq(employeeReactionDispatch.roundRef, input.roundId)),
        )
        // 切换前由旧路径启动的 round 没有派发行：这里补建，epoch 从 0 起（它从没 admission 过）。
        if (updated === 0) {
          await insertOne(tx, employeeReactionDispatch, {
            roundRef: input.roundId,
            caseId: round.caseId,
            ...reset,
            createdAt: input.now,
          })
        }
      })
    },

    async settleRound(input) {
      await session.transaction(async (tx) => {
        const {
          employeeReactionRounds,
          employeeCases,
          employeeContextRecords,
          employeeContextRevisions,
          employeeExternalContextBindings,
          employeeContextLinks,
          employeeAttentionBindings,
          employeeOsOutbox,
          employeeReactionDispatch,
          employeeCaseInbox,
        } = tablesOf(tx)
        const round = await first(
          tx
            .select()
            .from(employeeReactionRounds)
            .where(eq(employeeReactionRounds.id, input.roundId)),
        )
        if (round === undefined) {
          throw new NotFoundError(
            'employee-reaction-round-not-found',
            `reaction round not found: ${input.roundId}`,
          )
        }
        if (['completed', 'failed', 'obsolete'].includes(round.state)) return
        const current = await first(
          tx.select().from(employeeCases).where(eq(employeeCases.id, round.caseId)),
        )
        if (current === undefined || current.activeRoundId !== round.id) {
          throw new ConflictError(
            'employee-reaction-round-stale',
            `reaction round no longer owns the case writer: ${round.id}`,
          )
        }

        for (const mutation of input.contextMutations ?? []) {
          const existing = await first(
            tx
              .select()
              .from(employeeContextRecords)
              .where(eq(employeeContextRecords.id, mutation.context.id)),
          )
          if (mutation.expectedRevision === null) {
            if (existing !== undefined) {
              throw new ConflictError(
                'employee-context-create-conflict',
                `context already exists: ${mutation.context.id}`,
              )
            }
            await insertOne(tx, employeeContextRecords, {
              id: mutation.context.id,
              caseId: mutation.context.caseId,
              typeId: mutation.context.typeId,
              schemaVersion: mutation.context.schemaVersion,
              currentRevision: mutation.context.revision,
              lifecycleState: mutation.context.lifecycleState,
              stateJson: mutation.context.stateJson,
              artifactRefsJson: JSON.stringify(mutation.context.artifactRefs),
              createdAt: mutation.context.createdAt,
              updatedAt: mutation.context.updatedAt,
            })
          } else {
            if (
              existing === undefined ||
              existing.caseId !== round.caseId ||
              existing.currentRevision !== mutation.expectedRevision
            ) {
              throw new ConflictError(
                'employee-context-revision-conflict',
                `context revision changed before settlement: ${mutation.context.id}`,
              )
            }
            await tx
              .update(employeeContextRecords)
              .set({
                schemaVersion: mutation.context.schemaVersion,
                currentRevision: mutation.context.revision,
                lifecycleState: mutation.context.lifecycleState,
                stateJson: mutation.context.stateJson,
                artifactRefsJson: JSON.stringify(mutation.context.artifactRefs),
                updatedAt: mutation.context.updatedAt,
              })
              .where(
                and(
                  eq(employeeContextRecords.id, mutation.context.id),
                  eq(employeeContextRecords.currentRevision, mutation.expectedRevision),
                ),
              )
          }
          await insertOne(tx, employeeContextRevisions, {
            contextId: mutation.context.id,
            revision: mutation.context.revision,
            stateJson: mutation.context.stateJson,
            artifactRefsJson: JSON.stringify(mutation.context.artifactRefs),
            contentDigest: mutation.contentDigest,
            createdAt: input.now,
          })
          for (const subject of mutation.externalSubjects) {
            const binding = await first(
              tx
                .select()
                .from(employeeExternalContextBindings)
                .where(
                  and(
                    eq(employeeExternalContextBindings.subjectType, subject.typeId),
                    eq(employeeExternalContextBindings.subjectRef, subject.subjectRef),
                  ),
                ),
            )
            if (
              binding !== undefined &&
              (binding.caseId !== round.caseId || binding.contextId !== mutation.context.id)
            ) {
              throw new ConflictError(
                'employee-external-context-conflict',
                `external subject is already bound: ${subject.typeId}/${subject.subjectRef}`,
              )
            }
            await tx
              .insert(employeeExternalContextBindings)
              .values({
                subjectType: subject.typeId,
                subjectRef: subject.subjectRef,
                caseId: round.caseId,
                contextId: mutation.context.id,
                bindingRevision: mutation.context.revision,
                updatedAt: input.now,
              })
              .onConflictDoUpdate({
                target: [
                  employeeExternalContextBindings.subjectType,
                  employeeExternalContextBindings.subjectRef,
                ],
                set: {
                  bindingRevision: mutation.context.revision,
                  updatedAt: input.now,
                },
              })
          }
        }

        for (const link of input.contextLinks ?? []) {
          await tx
            .insert(employeeContextLinks)
            .values({
              id: link.id,
              caseId: round.caseId,
              fromContextId: link.fromContextId,
              relation: link.relation,
              toContextId: link.toContextId,
              createdAt: input.now,
            })
            .onConflictDoNothing()
        }

        for (const desired of input.attentionUpserts ?? []) {
          const existing = await first(
            tx
              .select()
              .from(employeeAttentionBindings)
              .where(eq(employeeAttentionBindings.id, desired.binding.id)),
          )
          if (existing === undefined) {
            await insertOne(tx, employeeAttentionBindings, {
              id: desired.binding.id,
              caseId: desired.binding.caseId,
              contextId: desired.binding.contextId,
              contextRevision: desired.binding.contextRevision,
              eventTypeId: desired.binding.eventTypeRef.id,
              eventTypeRevision: desired.binding.eventTypeRef.revision,
              subjectType: desired.binding.subject.typeId,
              subjectRef: desired.binding.subject.subjectRef,
              desiredIdentityKey: desired.binding.desiredIdentityKey,
              eventSubscriptionId: desired.binding.eventSubscriptionId,
              state: desired.binding.state,
              createdAt: desired.binding.createdAt,
              updatedAt: desired.binding.updatedAt,
            })
          } else {
            await tx
              .update(employeeAttentionBindings)
              .set({
                contextRevision: desired.binding.contextRevision,
                eventSubscriptionId: desired.binding.eventSubscriptionId,
                state: desired.binding.state,
                updatedAt: input.now,
              })
              .where(eq(employeeAttentionBindings.id, desired.binding.id))
          }
          if (desired.subscribeOutbox !== null) {
            await tx
              .insert(employeeOsOutbox)
              .values({
                id: desired.subscribeOutbox.id,
                caseId: desired.subscribeOutbox.caseId,
                kind: desired.subscribeOutbox.kind,
                payloadJson: desired.subscribeOutbox.payloadJson,
                dedupeKey: desired.subscribeOutbox.dedupeKey,
                state: 'pending',
                attemptCount: 0,
                nextAttemptAt: input.now,
                createdAt: input.now,
                updatedAt: input.now,
              })
              .onConflictDoNothing({ target: employeeOsOutbox.dedupeKey })
          }
        }

        for (const cancellation of input.attentionCancellations ?? []) {
          await tx
            .update(employeeAttentionBindings)
            .set({
              state: cancellation.unsubscribeOutbox === null ? 'cancelled' : 'cancel-requested',
              updatedAt: input.now,
            })
            .where(eq(employeeAttentionBindings.id, cancellation.bindingId))
          if (cancellation.unsubscribeOutbox !== null) {
            await tx
              .insert(employeeOsOutbox)
              .values({
                id: cancellation.unsubscribeOutbox.id,
                caseId: cancellation.unsubscribeOutbox.caseId,
                kind: cancellation.unsubscribeOutbox.kind,
                payloadJson: cancellation.unsubscribeOutbox.payloadJson,
                dedupeKey: cancellation.unsubscribeOutbox.dedupeKey,
                state: 'pending',
                attemptCount: 0,
                nextAttemptAt: input.now + 1,
                createdAt: input.now + 1,
                updatedAt: input.now + 1,
              })
              .onConflictDoNothing({ target: employeeOsOutbox.dedupeKey })
          }
        }

        await tx
          .update(employeeReactionRounds)
          .set({
            state: input.state,
            outputJson: input.outputJson,
            updatedAt: input.now,
            settledAt: input.now,
          })
          .where(eq(employeeReactionRounds.id, round.id))
        // RFC-368 T13 —— admission 收口与结算同事务。集中在这里而不是散到各个结算入口：
        // 四个 `settleRound` 调用点 + obsolete 全部经过这一处，不会漏掉任何一个而让 admission
        // 行永久停在 admitted/launched。从没 admission 过（epoch 0）的 round 不用收口。
        if (options.reactionAdmission !== undefined) {
          const dispatch = await first(
            tx
              .select()
              .from(employeeReactionDispatch)
              .where(eq(employeeReactionDispatch.roundRef, round.id)),
          )
          if (dispatch !== undefined && dispatch.claimEpoch > 0) {
            await options.reactionAdmission(tx).closeClaim({
              reaction: { roundRef: round.id },
              expectedCurrentEpoch: dispatch.claimEpoch as ReactionClaimEpoch,
              reason: CLOSE_REASON[input.state],
            })
          }
        }
        if (round.inboxId !== null) {
          await tx
            .update(employeeCaseInbox)
            .set({
              state: input.state === 'obsolete' ? 'obsolete' : 'settled',
              settledAt: input.now,
            })
            .where(eq(employeeCaseInbox.id, round.inboxId))
        }
        const nextState =
          input.nextCaseState ?? (input.state === 'failed' ? 'blocked' : current.state)
        const nextRevision = current.revision + 1
        const nextTerminalKind =
          nextState === 'terminal' ? (input.terminalKind ?? 'completed') : null
        await tx
          .update(employeeCases)
          .set({
            activeRoundId: null,
            currentWorkItemRef:
              input.state === 'completed'
                ? (input.nextWorkItemRef ??
                  (nextState === 'blocked' ? current.currentWorkItemRef : null))
                : current.currentWorkItemRef,
            state: nextState,
            terminalKind: nextTerminalKind,
            blockReason:
              nextState === 'blocked'
                ? (input.blockReason ?? current.blockReason ?? 'reaction failed')
                : null,
            // 已经终止的案例再结算一轮（终止后收掉残留 round）时保留真正终止的时刻，
            // 不改成 round 被收掉的时刻（RFC-368 实现门 P3-1）。
            terminalAt:
              nextState === 'terminal'
                ? current.state === 'terminal'
                  ? current.terminalAt
                  : input.now
                : null,
            writerGeneration:
              nextState === 'terminal' && current.state !== 'terminal'
                ? current.writerGeneration + 1
                : current.writerGeneration,
            revision: nextRevision,
            updatedAt: input.now,
          })
          .where(and(eq(employeeCases.id, current.id), eq(employeeCases.activeRoundId, round.id)))
        if (nextState !== current.state) {
          await enqueueCaseLifecycleEventTx(tx, {
            caseId: current.id,
            employeeId: current.employeeId,
            revision: nextRevision,
            previousState: current.state,
            state: nextState,
            terminalKind: nextTerminalKind,
            occurredAt: input.now,
          })
        }
      })
    },

    async blockCase(caseId, reason, now) {
      await session.transaction(async (tx) => {
        const { employeeCases } = tablesOf(tx)
        // 读—改—写：`state` 判据与 `revision + 1` 都由这次读决定，而 UPDATE 的 where 里没有它们。
        // 不先锁住案件行，PG 的 READ COMMITTED 下一次并发 `terminateCase` 会整个被盖掉——
        // 「终止」已经回了 200，案件却带着 terminalKind 变回可 resume 的 blocked
        // （tests/rfc359-w8-t28-lost-update.test.ts L1）。
        await engine.lockAggregateRoot(tx, employeeCases, employeeCases.id, caseId)
        const current = await first(
          tx.select().from(employeeCases).where(eq(employeeCases.id, caseId)),
        )
        if (current === undefined) {
          throw new NotFoundError('employee-case-not-found', `employee case not found: ${caseId}`)
        }
        if (current.state === 'terminal' || current.state === 'blocked') return
        await tx
          .update(employeeCases)
          .set({
            state: 'blocked',
            blockReason: reason.slice(0, 2_000),
            revision: current.revision + 1,
            updatedAt: now,
          })
          .where(eq(employeeCases.id, caseId))
        await enqueueCaseLifecycleEventTx(tx, {
          caseId,
          employeeId: current.employeeId,
          revision: current.revision + 1,
          previousState: current.state,
          state: 'blocked',
          terminalKind: null,
          occurredAt: now,
        })
      })
    },

    async resumeCase(caseId, now) {
      return await session.transaction(async (tx) => {
        const { employeeCases } = tablesOf(tx)
        const current = await first(
          tx.select().from(employeeCases).where(eq(employeeCases.id, caseId)),
        )
        if (current === undefined) {
          throw new NotFoundError('employee-case-not-found', `employee case not found: ${caseId}`)
        }
        if (current.state === 'terminal') {
          throw new ConflictError(
            'employee-case-terminal',
            `terminal employee case cannot be resumed: ${caseId}`,
          )
        }
        if (current.state !== 'blocked' || current.activeRoundId !== null) {
          throw new ConflictError(
            'employee-case-not-blocked',
            `employee case is not resumable: ${caseId}`,
          )
        }
        await tx
          .update(employeeCases)
          .set({
            state: 'active',
            blockReason: null,
            revision: current.revision + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(employeeCases.id, caseId),
              eq(employeeCases.revision, current.revision),
              eq(employeeCases.state, 'blocked'),
              isNull(employeeCases.activeRoundId),
            ),
          )
        await enqueueCaseLifecycleEventTx(tx, {
          caseId,
          employeeId: current.employeeId,
          revision: current.revision + 1,
          previousState: current.state,
          state: 'active',
          terminalKind: null,
          occurredAt: now,
        })
        const updated = await first(
          tx.select().from(employeeCases).where(eq(employeeCases.id, caseId)),
        )
        if (updated === undefined) throw new Error('case vanished after resume transition')
        return caseRecord(updated)
      })
    },

    async terminateCase(caseId, terminalKind, now) {
      return await session.transaction(async (tx) => {
        const {
          employeeCases,
          employeeInvocations,
          employeeChannels,
          employeeAttentionBindings,
          employeeOsOutbox,
        } = tablesOf(tx)
        // 同 blockCase：`state !== 'terminal'` 的判据、`revision + 1` 与 `writerGeneration + 1`
        // 都由这次读决定。两笔并发终止若都读到 active，后落地的那笔会把 terminalKind 换掉，而
        // 生命周期事件的 id / dedupeKey 由 (caseId, revision) 决定 ⇒ 后一条被去重丢掉，
        // 事件流与案件详情从此说两种终止原因（tests/rfc359-w8-t28-lost-update.test.ts L2）。
        await engine.lockAggregateRoot(tx, employeeCases, employeeCases.id, caseId)
        const current = await first(
          tx.select().from(employeeCases).where(eq(employeeCases.id, caseId)),
        )
        if (current === undefined) {
          throw new NotFoundError('employee-case-not-found', `employee case not found: ${caseId}`)
        }
        if (current.state !== 'terminal') {
          await tx
            .update(employeeCases)
            .set({
              state: 'terminal',
              terminalKind,
              blockReason: null,
              revision: current.revision + 1,
              writerGeneration: current.writerGeneration + 1,
              updatedAt: now,
              terminalAt: now,
            })
            .where(eq(employeeCases.id, caseId))
          await enqueueCaseLifecycleEventTx(tx, {
            caseId,
            employeeId: current.employeeId,
            revision: current.revision + 1,
            previousState: current.state,
            state: 'terminal',
            terminalKind,
            occurredAt: now,
          })
          const outbound = await tx
            .select({ id: employeeInvocations.id })
            .from(employeeInvocations)
            .where(eq(employeeInvocations.parentCaseId, caseId))
          for (const invocation of outbound) {
            await tx
              .update(employeeInvocations)
              .set({ state: 'detached', updatedAt: now })
              .where(
                and(
                  eq(employeeInvocations.id, invocation.id),
                  inArray(employeeInvocations.state, ['requested', 'accepted', 'waiting']),
                ),
              )
            await tx
              .update(employeeChannels)
              .set({ state: 'detached', updatedAt: now })
              .where(
                and(
                  eq(employeeChannels.invocationId, invocation.id),
                  eq(employeeChannels.state, 'open'),
                ),
              )
          }
          const bindings = await tx
            .select()
            .from(employeeAttentionBindings)
            .where(
              and(
                eq(employeeAttentionBindings.caseId, caseId),
                inArray(employeeAttentionBindings.state, ['desired', 'active']),
              ),
            )
          for (const binding of bindings) {
            await tx
              .update(employeeAttentionBindings)
              .set({
                state: binding.eventSubscriptionId === null ? 'cancelled' : 'cancel-requested',
                updatedAt: now,
              })
              .where(eq(employeeAttentionBindings.id, binding.id))
            if (binding.eventSubscriptionId !== null) {
              await tx
                .insert(employeeOsOutbox)
                .values({
                  id: `${binding.id}:unsubscribe`,
                  caseId,
                  kind: 'event-unsubscribe',
                  payloadJson: JSON.stringify({
                    bindingId: binding.id,
                    subscriptionId: binding.eventSubscriptionId,
                  }),
                  dedupeKey: `event-unsubscribe:${binding.id}`,
                  state: 'pending',
                  attemptCount: 0,
                  nextAttemptAt: now,
                  createdAt: now,
                  updatedAt: now,
                })
                .onConflictDoNothing({ target: employeeOsOutbox.dedupeKey })
            }
          }
        }
        const updated = await first(
          tx.select().from(employeeCases).where(eq(employeeCases.id, caseId)),
        )
        if (updated === undefined) throw new Error('case vanished after terminal transition')
        return caseRecord(updated)
      })
    },

    async upgradePolicy(input) {
      const { employeeCases } = tablesOf(db)
      const current = await first(
        db.select().from(employeeCases).where(eq(employeeCases.id, input.caseId)),
      )
      if (
        current === undefined ||
        current.revision !== input.expectedRevision ||
        current.state === 'terminal' ||
        current.activeRoundId !== null
      ) {
        return null
      }
      const result = await db
        .update(employeeCases)
        .set({
          executionPolicyRevision: input.targetPolicyRevision,
          revision: current.revision + 1,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(employeeCases.id, input.caseId),
            eq(employeeCases.revision, input.expectedRevision),
            isNull(employeeCases.activeRoundId),
          ),
        )
      if (affectedRows(result) !== 1) return null
      const updated = await first(
        db.select().from(employeeCases).where(eq(employeeCases.id, input.caseId)),
      )
      return updated === undefined ? null : caseRecord(updated)
    },
  }
}
