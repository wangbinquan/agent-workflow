import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  like,
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

import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import {
  employeeAttentionBindings,
  employeeCaseEventOrigins,
  employeeCaseInbox,
  employeeCaseMembers,
  employeeCaseMeteringReceipts,
  employeeCases,
  employeeChannelResults,
  employeeChannels,
  employeeContextLinks,
  employeeContextRecords,
  employeeContextRevisions,
  employeeExternalContextBindings,
  employeeInputUploads,
  employeeInvocations,
  employeeOsOutbox,
  employeeReactionRounds,
} from '@/db/schema'
import { ConflictError, NotFoundError } from '@/util/errors'
import type {
  AttentionBindingRecord,
  EmployeeChannelRecord,
  EmployeeChannelResultRecord,
  EmployeeInvocationRecord,
  EmployeeOutboxRecord,
  RuntimeCasePersistence,
  RuntimeCaseStorePort,
} from '../application/ports/runtimeStore'
import type {
  CaseInboxRecord,
  EmployeeCaseRecord,
  EmployeeContextRecord,
  ReactionRoundRecord,
} from '../domain/runtimeModel'
import { employeeCaseLifecycleObservation } from '../public/events'

function changes(result: unknown): number {
  return (result as { changes?: number }).changes ?? 0
}

function enqueueCaseLifecycleEventTx(
  tx: DbTxSync,
  input: {
    readonly caseId: string
    readonly employeeId: string
    readonly revision: number
    readonly previousState: EmployeeCaseRecord['state'] | null
    readonly state: EmployeeCaseRecord['state']
    readonly terminalKind: string | null
    readonly occurredAt: number
  },
): void {
  const observation = employeeCaseLifecycleObservation(input)
  tx.insert(employeeOsOutbox)
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
    .run()
}

function caseRecord(row: typeof employeeCases.$inferSelect): EmployeeCaseRecord {
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

function contextRecord(row: typeof employeeContextRecords.$inferSelect): EmployeeContextRecord {
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
  row: typeof employeeAttentionBindings.$inferSelect,
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

function inboxRecord(row: typeof employeeCaseInbox.$inferSelect): CaseInboxRecord {
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

function roundRecord(row: typeof employeeReactionRounds.$inferSelect): ReactionRoundRecord {
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

function outboxRecord(row: typeof employeeOsOutbox.$inferSelect): EmployeeOutboxRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    kind: row.kind,
    payloadJson: row.payloadJson,
    dedupeKey: row.dedupeKey,
    attemptCount: row.attemptCount,
  }
}

function invocationRecord(row: typeof employeeInvocations.$inferSelect): EmployeeInvocationRecord {
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

function channelRecord(row: typeof employeeChannels.$inferSelect): EmployeeChannelRecord {
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
  row: typeof employeeChannelResults.$inferSelect,
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

export function createSqliteRuntimeStore(db: DbClient): RuntimeCaseStorePort {
  const maxEmployeeOutcomeGroups = 50_000
  return {
    createCase(input) {
      dbTxSync(db, (tx) => {
        for (const claim of input.uploadClaims) {
          const upload = tx
            .select()
            .from(employeeInputUploads)
            .where(eq(employeeInputUploads.id, claim.uploadRef))
            .get()
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
          const claimed = tx
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
            .run()
          if (changes(claimed) !== 1) {
            throw new ConflictError(
              'employee-upload-claim-conflict',
              `input upload was claimed concurrently: ${claim.uploadRef}`,
            )
          }
        }
        tx.insert(employeeCases)
          .values({
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
          .run()
        if (input.initialMembers.length > 0) {
          tx.insert(employeeCaseMembers)
            .values(
              input.initialMembers.map((member) => ({
                caseId: input.caseRecord.id,
                userId: member.userId,
                role: member.role,
                addedBy: member.addedBy,
                addedAt: member.addedAt,
              })),
            )
            .run()
        }
        if (input.eventOrigin !== null) {
          tx.insert(employeeCaseEventOrigins)
            .values({
              caseId: input.caseRecord.id,
              eventSubscriptionId: input.eventOrigin.eventSubscriptionId,
              eventDeliveryId: input.eventOrigin.eventDeliveryId,
              createdAt: input.caseRecord.createdAt,
            })
            .run()
        }
        enqueueCaseLifecycleEventTx(tx, {
          caseId: input.caseRecord.id,
          employeeId: input.caseRecord.employeeRef.id,
          revision: input.caseRecord.revision,
          previousState: null,
          state: input.caseRecord.state,
          terminalKind: input.caseRecord.terminalKind,
          occurredAt: input.caseRecord.createdAt,
        })
        tx.insert(employeeContextRecords)
          .values({
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
          .run()
        tx.insert(employeeContextRevisions)
          .values({
            contextId: input.primaryContext.id,
            revision: input.primaryContext.revision,
            stateJson: input.primaryContext.stateJson,
            artifactRefsJson: JSON.stringify(input.primaryContext.artifactRefs),
            contentDigest: input.contextDigest,
            createdAt: input.primaryContext.createdAt,
          })
          .run()
        tx.insert(employeeExternalContextBindings)
          .values({
            subjectType: input.externalSubject.typeId,
            subjectRef: input.externalSubject.subjectRef,
            caseId: input.caseRecord.id,
            contextId: input.primaryContext.id,
            bindingRevision: 1,
            updatedAt: input.caseRecord.createdAt,
          })
          .run()
      })
    },

    getCase(id) {
      const row = db.select().from(employeeCases).where(eq(employeeCases.id, id)).get()
      return row === undefined ? null : caseRecord(row)
    },

    listCaseMembers(caseId) {
      return db
        .select()
        .from(employeeCaseMembers)
        .where(eq(employeeCaseMembers.caseId, caseId))
        .all()
        .map((row) => ({
          caseId: row.caseId,
          userId: row.userId,
          role: row.role,
          addedBy: row.addedBy,
          addedAt: row.addedAt,
        }))
    },

    getCaseMemberRole(caseId, userId) {
      const row = db
        .select({ role: employeeCaseMembers.role })
        .from(employeeCaseMembers)
        .where(and(eq(employeeCaseMembers.caseId, caseId), eq(employeeCaseMembers.userId, userId)))
        .get()
      return row === undefined ? null : row.role
    },

    recordMetering(input) {
      return dbTxSync(db, (tx) => {
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
        const current = tx
          .select()
          .from(employeeCases)
          .where(eq(employeeCases.id, input.caseId))
          .get()
        if (current === undefined) {
          throw new NotFoundError(
            'employee-case-not-found',
            `employee case not found: ${input.caseId}`,
          )
        }
        const inserted = tx
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
          .run()
        const applied = changes(inserted) === 1
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
          tx.update(employeeCases)
            .set({
              consumedDurationMs,
              consumedTotalTokens,
              revision: current.revision + 1,
              updatedAt: input.now,
            })
            .where(eq(employeeCases.id, input.caseId))
            .run()
        }
        const updated = tx
          .select()
          .from(employeeCases)
          .where(eq(employeeCases.id, input.caseId))
          .get()
        if (updated === undefined) throw new Error('employee case disappeared while metering')
        return { applied, caseRecord: caseRecord(updated) }
      })
    },

    replaceCaseMembers(input) {
      return dbTxSync(db, (tx) => {
        const current = tx
          .select({ id: employeeCases.id, ownerUserId: employeeCases.ownerUserId })
          .from(employeeCases)
          .where(eq(employeeCases.id, input.caseId))
          .get()
        if (current === undefined) {
          throw new NotFoundError(
            'employee-case-not-found',
            `employee case not found: ${input.caseId}`,
          )
        }
        const before = tx
          .select({ userId: employeeCaseMembers.userId })
          .from(employeeCaseMembers)
          .where(eq(employeeCaseMembers.caseId, input.caseId))
          .all()
        if (current.ownerUserId !== input.ownerUserId) {
          // 只改归属，不动 revision：revision 是运行时状态机的 CAS 位，策略升级预览
          // token 等都按它对账；owner 转移不是一次状态变迁。
          tx.update(employeeCases)
            .set({ ownerUserId: input.ownerUserId, updatedAt: input.now })
            .where(eq(employeeCases.id, input.caseId))
            .run()
        }
        tx.delete(employeeCaseMembers).where(eq(employeeCaseMembers.caseId, input.caseId)).run()
        if (input.members.length > 0) {
          tx.insert(employeeCaseMembers)
            .values(
              input.members.map((member) => ({
                caseId: input.caseId,
                userId: member.userId,
                role: member.role,
                addedBy: input.addedBy,
                addedAt: input.now,
              })),
            )
            .run()
        }
        return {
          previousOwnerUserId: current.ownerUserId,
          previousMemberUserIds: before.map((row) => row.userId),
        }
      })
    },

    findCaseByEventDelivery(eventDeliveryId) {
      const row = db
        .select({ case: employeeCases })
        .from(employeeCaseEventOrigins)
        .innerJoin(employeeCases, eq(employeeCases.id, employeeCaseEventOrigins.caseId))
        .where(eq(employeeCaseEventOrigins.eventDeliveryId, eventDeliveryId))
        .get()
      return row === undefined ? null : caseRecord(row.case)
    },

    listCases(employeeId, state) {
      const conditions = [
        ...(employeeId === undefined ? [] : [eq(employeeCases.employeeId, employeeId)]),
        ...(state === undefined
          ? []
          : [eq(employeeCases.state, state as EmployeeCaseRecord['state'])]),
      ]
      return db
        .select()
        .from(employeeCases)
        .where(conditions.length === 0 ? undefined : and(...conditions))
        .orderBy(desc(employeeCases.updatedAt), desc(employeeCases.id))
        .all()
        .map(caseRecord)
    },

    listTerminalOutcomeGroups() {
      const rows = db
        .select({
          employeeId: employeeCases.employeeId,
          terminalKind: employeeCases.terminalKind,
          count: sql<number>`count(*)`,
        })
        .from(employeeCases)
        .where(eq(employeeCases.state, 'terminal'))
        .groupBy(employeeCases.employeeId, employeeCases.terminalKind)
        .orderBy(asc(employeeCases.employeeId), asc(employeeCases.terminalKind))
        .limit(maxEmployeeOutcomeGroups + 1)
        .all()
      if (rows.length > maxEmployeeOutcomeGroups) {
        throw new Error('employee-outcome-group-limit-exceeded')
      }
      return rows.map((row) => ({
        employeeId: row.employeeId,
        terminalKind: row.terminalKind ?? 'completed',
        count: Number(row.count),
      }))
    },

    listCasesPage(input) {
      // RFC-330 缺口 1：成员制过滤。与 `services/taskAuthorization.ts` 的
      // `taskOwnershipScopeCondition` 同形（那边是 task_collaborators）；shared 对
      // `owner_user_id IS NULL` 也成立，否则无主案例的成员在「与我共享」里看不到它。
      const membershipCondition = (): SQL | null => {
        if (input.membership === undefined) return null
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
        conditions.push(eq(employeeCases.employeeId, input.employeeId))
      }
      if (input.ownerUserId !== undefined) {
        conditions.push(eq(employeeCases.ownerUserId, input.ownerUserId))
      }
      const membership = membershipCondition()
      if (membership !== null) conditions.push(membership)
      if (input.launchOrigin !== undefined) {
        conditions.push(eq(employeeCases.launchOrigin, input.launchOrigin))
      }
      if (input.states !== undefined) {
        conditions.push(
          input.states.length === 0 ? sql`0 = 1` : inArray(employeeCases.state, [...input.states]),
        )
      }
      if (input.terminalCatalogStatuses !== undefined) {
        const wantsDone = input.terminalCatalogStatuses.includes('done')
        const wantsCanceled = input.terminalCatalogStatuses.includes('canceled')
        if (wantsDone !== wantsCanceled) {
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
          conditions.push(ne(employeeCases.state, 'terminal'))
        }
      }
      if (input.view === 'active') {
        conditions.push(inArray(employeeCases.state, ['active', 'waiting']))
      } else if (input.view === 'attention') {
        conditions.push(eq(employeeCases.state, 'blocked'))
      } else if (input.view === 'finished') {
        conditions.push(eq(employeeCases.state, 'terminal'))
      }
      if (input.q !== undefined) {
        const term = `%${input.q}%`
        conditions.push(
          or(
            like(employeeCases.name, term),
            like(employeeCases.id, term),
            like(employeeCases.employeeId, term),
            like(employeeCases.blockReason, term),
            like(employeeContextRecords.stateJson, term),
          )!,
        )
      }
      if (input.cursor !== null) {
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
      const rows = db
        .select({ case: employeeCases })
        .from(employeeCases)
        .innerJoin(
          employeeContextRecords,
          eq(employeeContextRecords.id, employeeCases.primaryContextId),
        )
        .where(conditions.length === 0 ? undefined : and(...conditions))
        .orderBy(desc(employeeCases.updatedAt), desc(employeeCases.id))
        .limit(input.limit + 1)
        .all()
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
      const countWhere = (stateWhere?: SQL) =>
        Number(
          db
            .select({ value: sql<number>`count(*)` })
            .from(employeeCases)
            .where(
              facetBase === undefined
                ? stateWhere
                : stateWhere === undefined
                  ? facetBase
                  : and(facetBase, stateWhere),
            )
            .get()?.value ?? 0,
        )
      return {
        cases: rows.slice(0, input.limit).map((row) => caseRecord(row.case)),
        hasMore: rows.length > input.limit,
        facets: {
          all: countWhere(),
          active: countWhere(inArray(employeeCases.state, ['active', 'waiting'])),
          attention: countWhere(eq(employeeCases.state, 'blocked')),
          finished: countWhere(eq(employeeCases.state, 'terminal')),
        },
      }
    },

    findCaseByExternalSubject(subjectType, subjectRef) {
      const row = db
        .select({ case: employeeCases })
        .from(employeeExternalContextBindings)
        .innerJoin(employeeCases, eq(employeeCases.id, employeeExternalContextBindings.caseId))
        .where(
          and(
            eq(employeeExternalContextBindings.subjectType, subjectType),
            eq(employeeExternalContextBindings.subjectRef, subjectRef),
          ),
        )
        .get()
      return row === undefined ? null : caseRecord(row.case)
    },

    listContexts(caseId) {
      return db
        .select()
        .from(employeeContextRecords)
        .where(eq(employeeContextRecords.caseId, caseId))
        .orderBy(asc(employeeContextRecords.createdAt), asc(employeeContextRecords.id))
        .all()
        .map(contextRecord)
    },

    listAttention(caseId) {
      return db
        .select()
        .from(employeeAttentionBindings)
        .where(eq(employeeAttentionBindings.caseId, caseId))
        .orderBy(asc(employeeAttentionBindings.createdAt), asc(employeeAttentionBindings.id))
        .all()
        .map(attentionRecord)
    },

    listInbox(caseId) {
      return db
        .select()
        .from(employeeCaseInbox)
        .where(eq(employeeCaseInbox.caseId, caseId))
        .orderBy(
          desc(employeeCaseInbox.priority),
          asc(employeeCaseInbox.occurredAt),
          asc(employeeCaseInbox.eventId),
        )
        .all()
        .map(inboxRecord)
    },

    listRounds(caseId) {
      return db
        .select()
        .from(employeeReactionRounds)
        .where(eq(employeeReactionRounds.caseId, caseId))
        .orderBy(desc(employeeReactionRounds.createdAt), desc(employeeReactionRounds.id))
        .all()
        .map(roundRecord)
    },

    listRunningRounds() {
      return db
        .select()
        .from(employeeReactionRounds)
        .where(eq(employeeReactionRounds.state, 'running'))
        .orderBy(asc(employeeReactionRounds.updatedAt), asc(employeeReactionRounds.id))
        .all()
        .map(roundRecord)
    },

    listInvocationsForRound(roundId) {
      return db
        .select()
        .from(employeeInvocations)
        .where(eq(employeeInvocations.parentRoundId, roundId))
        .orderBy(asc(employeeInvocations.createdAt), asc(employeeInvocations.id))
        .all()
        .map(invocationRecord)
    },

    createInvocation(record) {
      return dbTxSync(db, (tx) => {
        const existing = tx
          .select()
          .from(employeeInvocations)
          .where(eq(employeeInvocations.idempotencyKey, record.idempotencyKey))
          .get()
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
        tx.insert(employeeInvocations)
          .values({
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
          .run()
        return record
      })
    },

    acceptInvocation(input) {
      return dbTxSync(db, (tx) => {
        const invocation = tx
          .select()
          .from(employeeInvocations)
          .where(eq(employeeInvocations.id, input.invocationId))
          .get()
        if (invocation === undefined) {
          throw new NotFoundError(
            'employee-invocation-not-found',
            `employee invocation not found: ${input.invocationId}`,
          )
        }
        const existing = tx
          .select()
          .from(employeeChannels)
          .where(eq(employeeChannels.invocationId, input.invocationId))
          .get()
        if (existing !== undefined) {
          if (existing.childCaseId !== input.childCaseId) {
            throw new ConflictError(
              'employee-channel-child-conflict',
              'invocation is already linked to another child case',
            )
          }
          return channelRecord(existing)
        }
        tx.insert(employeeChannels)
          .values({
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
          .run()
        tx.update(employeeInvocations)
          .set({ childCaseId: input.childCaseId, state: 'waiting', updatedAt: input.now })
          .where(eq(employeeInvocations.id, input.invocationId))
          .run()
        return input.channel
      })
    },

    getChannelByInvocation(invocationId) {
      const row = db
        .select()
        .from(employeeChannels)
        .where(eq(employeeChannels.invocationId, invocationId))
        .get()
      return row === undefined ? null : channelRecord(row)
    },

    listChannels(caseId) {
      return db
        .select()
        .from(employeeChannels)
        .where(
          or(eq(employeeChannels.parentCaseId, caseId), eq(employeeChannels.childCaseId, caseId)),
        )
        .orderBy(asc(employeeChannels.createdAt), asc(employeeChannels.id))
        .all()
        .map(channelRecord)
    },

    listChannelResults(channelId) {
      return db
        .select()
        .from(employeeChannelResults)
        .where(eq(employeeChannelResults.channelId, channelId))
        .orderBy(asc(employeeChannelResults.createdAt), asc(employeeChannelResults.id))
        .all()
        .map(channelResultRecord)
    },

    listOpenChannelsWithTerminalChild(limit) {
      return db
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
        .orderBy(asc(employeeCases.terminalAt), asc(employeeChannels.id))
        .limit(limit)
        .all()
        .map((row) => ({ channel: channelRecord(row.channel), childCase: caseRecord(row.child) }))
    },

    listExpiredOpenChannels(now, limit) {
      return db
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
        .all()
        .map((row) => ({
          channel: channelRecord(row.channel),
          invocation: invocationRecord(row.invocation),
          childCase: caseRecord(row.child),
        }))
    },

    settleChannelResult(input) {
      dbTxSync(db, (tx) => {
        tx.insert(employeeChannelResults)
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
          .run()
        const channel = tx
          .select()
          .from(employeeChannels)
          .where(eq(employeeChannels.id, input.result.channelId))
          .get()
        if (channel === undefined) {
          throw new NotFoundError(
            'employee-channel-not-found',
            `employee channel not found: ${input.result.channelId}`,
          )
        }
        tx.update(employeeChannels)
          .set({ state: input.channelState, updatedAt: input.now })
          .where(eq(employeeChannels.id, channel.id))
          .run()
        tx.update(employeeInvocations)
          .set({ state: input.channelState, updatedAt: input.now })
          .where(eq(employeeInvocations.id, channel.invocationId))
          .run()
      })
    },

    detachOpenChannelsForRound(roundId, now) {
      dbTxSync(db, (tx) => {
        const invocations = tx
          .select({ id: employeeInvocations.id })
          .from(employeeInvocations)
          .where(eq(employeeInvocations.parentRoundId, roundId))
          .all()
        for (const invocation of invocations) {
          tx.update(employeeInvocations)
            .set({ state: 'detached', updatedAt: now })
            .where(
              and(
                eq(employeeInvocations.id, invocation.id),
                inArray(employeeInvocations.state, ['requested', 'accepted', 'waiting']),
              ),
            )
            .run()
          tx.update(employeeChannels)
            .set({ state: 'detached', updatedAt: now })
            .where(
              and(
                eq(employeeChannels.invocationId, invocation.id),
                eq(employeeChannels.state, 'open'),
              ),
            )
            .run()
        }
      })
    },

    claimOutbox(input) {
      const candidate = db
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
          ),
        )
        .orderBy(asc(employeeOsOutbox.createdAt), asc(employeeOsOutbox.id))
        .get()
      if (candidate === undefined) return null
      const claimed = changes(
        db
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
          )
          .run(),
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

    completeOutbox(id, workerId, now) {
      const result = db
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
        .run()
      if (changes(result) !== 1) throw new Error(`lost outbox claim: ${id}`)
    },

    retryOutbox(input) {
      const result = db
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
        .run()
      if (changes(result) !== 1) throw new Error(`lost outbox claim: ${input.id}`)
    },

    activateAttention(bindingId, subscriptionId, now) {
      const result = db
        .update(employeeAttentionBindings)
        .set({ eventSubscriptionId: subscriptionId, state: 'active', updatedAt: now })
        .where(
          and(
            eq(employeeAttentionBindings.id, bindingId),
            inArray(employeeAttentionBindings.state, ['desired', 'active']),
          ),
        )
        .run()
      if (changes(result) !== 1) {
        throw new NotFoundError('employee-attention-not-found', `attention not found: ${bindingId}`)
      }
    },

    cancelAttention(bindingId, now) {
      db.update(employeeAttentionBindings)
        .set({ eventSubscriptionId: null, state: 'cancelled', updatedAt: now })
        .where(
          and(
            eq(employeeAttentionBindings.id, bindingId),
            eq(employeeAttentionBindings.state, 'cancel-requested'),
          ),
        )
        .run()
    },

    acceptDelivery(caseId, id, delivery, priority, now) {
      return dbTxSync(db, (tx) => {
        const existing = tx
          .select({ id: employeeCaseInbox.id })
          .from(employeeCaseInbox)
          .where(eq(employeeCaseInbox.deliveryId, delivery.deliveryId))
          .get()
        if (existing !== undefined) return false
        const current = tx.select().from(employeeCases).where(eq(employeeCases.id, caseId)).get()
        if (current === undefined) {
          throw new NotFoundError('employee-case-not-found', `employee case not found: ${caseId}`)
        }
        if (current.state !== 'terminal') {
          tx.update(employeeCaseInbox)
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
            .run()
        }
        tx.insert(employeeCaseInbox)
          .values({
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
          .run()
        return true
      })
    },

    markInbox(inboxId, state, now) {
      db.update(employeeCaseInbox)
        .set({ state, settledAt: now })
        .where(and(eq(employeeCaseInbox.id, inboxId), eq(employeeCaseInbox.state, 'pending')))
        .run()
    },

    createRound(input) {
      return dbTxSync(db, (tx) => {
        const current = tx
          .select()
          .from(employeeCases)
          .where(eq(employeeCases.id, input.round.caseId))
          .get()
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
            : tx
                .select()
                .from(employeeCaseInbox)
                .where(eq(employeeCaseInbox.id, input.inboxId))
                .get()
        if (
          input.inboxId !== null &&
          (inbox === null || inbox === undefined || inbox.state !== 'pending')
        ) {
          return false
        }
        tx.insert(employeeReactionRounds)
          .values({
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
          .run()
        if (inbox !== null && inbox !== undefined) {
          tx.update(employeeCaseInbox)
            .set({ state: 'claimed', roundId: input.round.id })
            .where(eq(employeeCaseInbox.id, inbox.id))
            .run()
        }
        tx.update(employeeCases)
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
          .run()
        if (input.launchOutbox !== null) {
          tx.insert(employeeOsOutbox)
            .values({
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
            .run()
        }
        return true
      })
    },

    markRoundRunning(roundId, executionRef, now) {
      db.update(employeeReactionRounds)
        .set({ state: 'running', executionRef, updatedAt: now })
        .where(
          and(eq(employeeReactionRounds.id, roundId), eq(employeeReactionRounds.state, 'planned')),
        )
        .run()
    },

    retryRound(input) {
      dbTxSync(db, (tx) => {
        const round = tx
          .select()
          .from(employeeReactionRounds)
          .where(eq(employeeReactionRounds.id, input.roundId))
          .get()
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
        tx.update(employeeReactionRounds)
          .set({
            state: 'planned',
            executionRef: null,
            outputJson: input.errorJson,
            attemptOrdinal: input.attemptOrdinal,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(employeeReactionRounds.id, input.roundId),
              eq(employeeReactionRounds.state, 'running'),
              eq(employeeReactionRounds.executionRef, input.expectedExecutionRef),
            ),
          )
          .run()
        tx.insert(employeeOsOutbox)
          .values({
            id: input.launchOutbox.id,
            caseId: input.launchOutbox.caseId,
            kind: input.launchOutbox.kind,
            payloadJson: input.launchOutbox.payloadJson,
            dedupeKey: input.launchOutbox.dedupeKey,
            state: 'pending',
            attemptCount: 0,
            nextAttemptAt: input.nextAttemptAt,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .run()
      })
    },

    settleRound(input) {
      dbTxSync(db, (tx) => {
        const round = tx
          .select()
          .from(employeeReactionRounds)
          .where(eq(employeeReactionRounds.id, input.roundId))
          .get()
        if (round === undefined) {
          throw new NotFoundError(
            'employee-reaction-round-not-found',
            `reaction round not found: ${input.roundId}`,
          )
        }
        if (['completed', 'failed', 'obsolete'].includes(round.state)) return
        const current = tx
          .select()
          .from(employeeCases)
          .where(eq(employeeCases.id, round.caseId))
          .get()
        if (current === undefined || current.activeRoundId !== round.id) {
          throw new ConflictError(
            'employee-reaction-round-stale',
            `reaction round no longer owns the case writer: ${round.id}`,
          )
        }

        for (const mutation of input.contextMutations ?? []) {
          const existing = tx
            .select()
            .from(employeeContextRecords)
            .where(eq(employeeContextRecords.id, mutation.context.id))
            .get()
          if (mutation.expectedRevision === null) {
            if (existing !== undefined) {
              throw new ConflictError(
                'employee-context-create-conflict',
                `context already exists: ${mutation.context.id}`,
              )
            }
            tx.insert(employeeContextRecords)
              .values({
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
              .run()
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
            tx.update(employeeContextRecords)
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
              .run()
          }
          tx.insert(employeeContextRevisions)
            .values({
              contextId: mutation.context.id,
              revision: mutation.context.revision,
              stateJson: mutation.context.stateJson,
              artifactRefsJson: JSON.stringify(mutation.context.artifactRefs),
              contentDigest: mutation.contentDigest,
              createdAt: input.now,
            })
            .run()
          for (const subject of mutation.externalSubjects) {
            const binding = tx
              .select()
              .from(employeeExternalContextBindings)
              .where(
                and(
                  eq(employeeExternalContextBindings.subjectType, subject.typeId),
                  eq(employeeExternalContextBindings.subjectRef, subject.subjectRef),
                ),
              )
              .get()
            if (
              binding !== undefined &&
              (binding.caseId !== round.caseId || binding.contextId !== mutation.context.id)
            ) {
              throw new ConflictError(
                'employee-external-context-conflict',
                `external subject is already bound: ${subject.typeId}/${subject.subjectRef}`,
              )
            }
            tx.insert(employeeExternalContextBindings)
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
              .run()
          }
        }

        for (const link of input.contextLinks ?? []) {
          tx.insert(employeeContextLinks)
            .values({
              id: link.id,
              caseId: round.caseId,
              fromContextId: link.fromContextId,
              relation: link.relation,
              toContextId: link.toContextId,
              createdAt: input.now,
            })
            .onConflictDoNothing()
            .run()
        }

        for (const desired of input.attentionUpserts ?? []) {
          const existing = tx
            .select()
            .from(employeeAttentionBindings)
            .where(eq(employeeAttentionBindings.id, desired.binding.id))
            .get()
          if (existing === undefined) {
            tx.insert(employeeAttentionBindings)
              .values({
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
              .run()
          } else {
            tx.update(employeeAttentionBindings)
              .set({
                contextRevision: desired.binding.contextRevision,
                eventSubscriptionId: desired.binding.eventSubscriptionId,
                state: desired.binding.state,
                updatedAt: input.now,
              })
              .where(eq(employeeAttentionBindings.id, desired.binding.id))
              .run()
          }
          if (desired.subscribeOutbox !== null) {
            tx.insert(employeeOsOutbox)
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
              .run()
          }
        }

        for (const cancellation of input.attentionCancellations ?? []) {
          tx.update(employeeAttentionBindings)
            .set({
              state: cancellation.unsubscribeOutbox === null ? 'cancelled' : 'cancel-requested',
              updatedAt: input.now,
            })
            .where(eq(employeeAttentionBindings.id, cancellation.bindingId))
            .run()
          if (cancellation.unsubscribeOutbox !== null) {
            tx.insert(employeeOsOutbox)
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
              .run()
          }
        }

        tx.update(employeeReactionRounds)
          .set({
            state: input.state,
            outputJson: input.outputJson,
            updatedAt: input.now,
            settledAt: input.now,
          })
          .where(eq(employeeReactionRounds.id, round.id))
          .run()
        if (round.inboxId !== null) {
          tx.update(employeeCaseInbox)
            .set({
              state: input.state === 'obsolete' ? 'obsolete' : 'settled',
              settledAt: input.now,
            })
            .where(eq(employeeCaseInbox.id, round.inboxId))
            .run()
        }
        const nextState =
          input.nextCaseState ?? (input.state === 'failed' ? 'blocked' : current.state)
        const nextRevision = current.revision + 1
        const nextTerminalKind =
          nextState === 'terminal' ? (input.terminalKind ?? 'completed') : null
        tx.update(employeeCases)
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
            terminalAt: nextState === 'terminal' ? input.now : null,
            writerGeneration:
              nextState === 'terminal' && current.state !== 'terminal'
                ? current.writerGeneration + 1
                : current.writerGeneration,
            revision: nextRevision,
            updatedAt: input.now,
          })
          .where(and(eq(employeeCases.id, current.id), eq(employeeCases.activeRoundId, round.id)))
          .run()
        if (nextState !== current.state) {
          enqueueCaseLifecycleEventTx(tx, {
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

    blockCase(caseId, reason, now) {
      dbTxSync(db, (tx) => {
        const current = tx.select().from(employeeCases).where(eq(employeeCases.id, caseId)).get()
        if (current === undefined) {
          throw new NotFoundError('employee-case-not-found', `employee case not found: ${caseId}`)
        }
        if (current.state === 'terminal' || current.state === 'blocked') return
        tx.update(employeeCases)
          .set({
            state: 'blocked',
            blockReason: reason.slice(0, 2_000),
            revision: current.revision + 1,
            updatedAt: now,
          })
          .where(eq(employeeCases.id, caseId))
          .run()
        enqueueCaseLifecycleEventTx(tx, {
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

    resumeCase(caseId, now) {
      return dbTxSync(db, (tx) => {
        const current = tx.select().from(employeeCases).where(eq(employeeCases.id, caseId)).get()
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
        tx.update(employeeCases)
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
          .run()
        enqueueCaseLifecycleEventTx(tx, {
          caseId,
          employeeId: current.employeeId,
          revision: current.revision + 1,
          previousState: current.state,
          state: 'active',
          terminalKind: null,
          occurredAt: now,
        })
        const updated = tx.select().from(employeeCases).where(eq(employeeCases.id, caseId)).get()
        if (updated === undefined) throw new Error('case vanished after resume transition')
        return caseRecord(updated)
      })
    },

    terminateCase(caseId, terminalKind, now) {
      return dbTxSync(db, (tx) => {
        const current = tx.select().from(employeeCases).where(eq(employeeCases.id, caseId)).get()
        if (current === undefined) {
          throw new NotFoundError('employee-case-not-found', `employee case not found: ${caseId}`)
        }
        if (current.state !== 'terminal') {
          tx.update(employeeCases)
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
            .run()
          enqueueCaseLifecycleEventTx(tx, {
            caseId,
            employeeId: current.employeeId,
            revision: current.revision + 1,
            previousState: current.state,
            state: 'terminal',
            terminalKind,
            occurredAt: now,
          })
          const outbound = tx
            .select({ id: employeeInvocations.id })
            .from(employeeInvocations)
            .where(eq(employeeInvocations.parentCaseId, caseId))
            .all()
          for (const invocation of outbound) {
            tx.update(employeeInvocations)
              .set({ state: 'detached', updatedAt: now })
              .where(
                and(
                  eq(employeeInvocations.id, invocation.id),
                  inArray(employeeInvocations.state, ['requested', 'accepted', 'waiting']),
                ),
              )
              .run()
            tx.update(employeeChannels)
              .set({ state: 'detached', updatedAt: now })
              .where(
                and(
                  eq(employeeChannels.invocationId, invocation.id),
                  eq(employeeChannels.state, 'open'),
                ),
              )
              .run()
          }
          const bindings = tx
            .select()
            .from(employeeAttentionBindings)
            .where(
              and(
                eq(employeeAttentionBindings.caseId, caseId),
                inArray(employeeAttentionBindings.state, ['desired', 'active']),
              ),
            )
            .all()
          for (const binding of bindings) {
            tx.update(employeeAttentionBindings)
              .set({
                state: binding.eventSubscriptionId === null ? 'cancelled' : 'cancel-requested',
                updatedAt: now,
              })
              .where(eq(employeeAttentionBindings.id, binding.id))
              .run()
            if (binding.eventSubscriptionId !== null) {
              tx.insert(employeeOsOutbox)
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
                .run()
            }
          }
        }
        const updated = tx.select().from(employeeCases).where(eq(employeeCases.id, caseId)).get()
        if (updated === undefined) throw new Error('case vanished after terminal transition')
        return caseRecord(updated)
      })
    },

    upgradePolicy(input) {
      const current = db
        .select()
        .from(employeeCases)
        .where(eq(employeeCases.id, input.caseId))
        .get()
      if (
        current === undefined ||
        current.revision !== input.expectedRevision ||
        current.state === 'terminal' ||
        current.activeRoundId !== null
      ) {
        return null
      }
      const result = db
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
        .run()
      if (changes(result) !== 1) return null
      const updated = db
        .select()
        .from(employeeCases)
        .where(eq(employeeCases.id, input.caseId))
        .get()
      return updated === undefined ? null : caseRecord(updated)
    },
  }
}

export function asAsyncRuntimeCasePersistence(store: RuntimeCaseStorePort): RuntimeCasePersistence {
  return {
    createCase: async (input) => store.createCase(input),
    getCase: async (id) => store.getCase(id),
    listCaseMembers: async (caseId) => store.listCaseMembers(caseId),
    getCaseMemberRole: async (caseId, userId) => store.getCaseMemberRole(caseId, userId),
    recordMetering: async (input) => store.recordMetering(input),
    replaceCaseMembers: async (input) => store.replaceCaseMembers(input),
    findCaseByEventDelivery: async (eventDeliveryId) =>
      store.findCaseByEventDelivery(eventDeliveryId),
    listCases: async (employeeId, state) => store.listCases(employeeId, state),
    listTerminalOutcomeGroups: async () => store.listTerminalOutcomeGroups(),
    listCasesPage: async (input) => store.listCasesPage(input),
    findCaseByExternalSubject: async (subjectType, subjectRef) =>
      store.findCaseByExternalSubject(subjectType, subjectRef),
    listContexts: async (caseId) => store.listContexts(caseId),
    listAttention: async (caseId) => store.listAttention(caseId),
    listInbox: async (caseId) => store.listInbox(caseId),
    listRounds: async (caseId) => store.listRounds(caseId),
    listRunningRounds: async () => store.listRunningRounds(),
    listInvocationsForRound: async (roundId) => store.listInvocationsForRound(roundId),
    createInvocation: async (record) => store.createInvocation(record),
    acceptInvocation: async (input) => store.acceptInvocation(input),
    getChannelByInvocation: async (invocationId) => store.getChannelByInvocation(invocationId),
    listChannels: async (caseId) => store.listChannels(caseId),
    listChannelResults: async (channelId) => store.listChannelResults(channelId),
    listOpenChannelsWithTerminalChild: async (limit) =>
      store.listOpenChannelsWithTerminalChild(limit),
    listExpiredOpenChannels: async (now, limit) => store.listExpiredOpenChannels(now, limit),
    settleChannelResult: async (input) => store.settleChannelResult(input),
    detachOpenChannelsForRound: async (roundId, now) =>
      store.detachOpenChannelsForRound(roundId, now),
    claimOutbox: async (input) => store.claimOutbox(input),
    completeOutbox: async (id, workerId, now) => store.completeOutbox(id, workerId, now),
    retryOutbox: async (input) => store.retryOutbox(input),
    activateAttention: async (bindingId, subscriptionId, now) =>
      store.activateAttention(bindingId, subscriptionId, now),
    cancelAttention: async (bindingId, now) => store.cancelAttention(bindingId, now),
    acceptDelivery: async (caseId, id, delivery, priority, now) =>
      store.acceptDelivery(caseId, id, delivery, priority, now),
    markInbox: async (inboxId, state, now) => store.markInbox(inboxId, state, now),
    createRound: async (input) => store.createRound(input),
    markRoundRunning: async (roundId, executionRef, now) =>
      store.markRoundRunning(roundId, executionRef, now),
    retryRound: async (input) => store.retryRound(input),
    settleRound: async (input) => store.settleRound(input),
    blockCase: async (caseId, reason, now) => store.blockCase(caseId, reason, now),
    resumeCase: async (caseId, now) => store.resumeCase(caseId, now),
    terminateCase: async (caseId, terminalKind, now) =>
      store.terminateCase(caseId, terminalKind, now),
    upgradePolicy: async (input) => store.upgradePolicy(input),
  }
}

export function createSqliteRuntimePersistence(db: DbClient): RuntimeCasePersistence {
  return asAsyncRuntimeCasePersistence(createSqliteRuntimeStore(db))
}
