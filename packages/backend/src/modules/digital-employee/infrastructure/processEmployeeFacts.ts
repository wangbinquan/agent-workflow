// RFC-616 §3.2 / §6.3 — digital-employee facts offered to process metrics through the platform contract.
//
// This module stays the only owner of three things the facts are built from: who may see a case, what a case
// lifecycle event says, and how an employee type is asked about its own content. Process metrics reads none of
// these tables and interprets none of these documents.

import { and, asc, desc, eq, gte, inArray, lt, ne, or, type SQL } from 'drizzle-orm'
import { z } from 'zod'

import {
  PROCESS_FACT_ID_BATCH,
  type ProcessEmployeeApprovalRow,
  type ProcessEmployeeCaseRow,
  type ProcessEmployeeFacts,
  type ProcessEmployeeManifest,
  type ProcessEmployeeTransitionRow,
  type ProcessSubjectEventRow,
  type ProcessViewer,
} from '@/platform/contracts/processFacts'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { EMPLOYEE_CASE_STATE_CHANGED_EVENT_REF } from '../application/lifecycleEvents'
import {
  readHumanFeedbackProjection,
  readProcessMetricsDeclaration,
  type EmployeeHumanFeedbackItem,
} from '../application/processMetricsDeclarations'
import {
  employeeTypeRefSchema,
  parsePersistedEmployeeTypePackageDescriptor,
  type EmployeeTypePackageDescriptor,
} from '../domain/model'
import type { EmployeeTypeContextCodec, EmployeeTypePackageRegistration } from '../public/types'

type TypeRegistration = Pick<
  EmployeeTypePackageRegistration,
  'descriptorJson' | 'describeProcessMetricsJson'
>
type ContextCodec = Pick<EmployeeTypeContextCodec, 'typeId' | 'projectHumanFeedbackJson'>
type DeclaringRegistration = TypeRegistration & { describeProcessMetricsJson(): string }
type FeedbackProjector = ContextCodec & {
  projectHumanFeedbackJson(contextTypeId: string, stateJson: string): string
}

/** The employee types of this build, exactly as bootstrap hands them to the module. */
export interface ProcessEmployeeTypes {
  /** The registered type packages (`typePackages`). */
  readonly typePackages: readonly TypeRegistration[]
  /** The context codecs of those types (`runtime.codecs`). */
  readonly contextCodecs: readonly ContextCodec[]
}

/**
 * Context documents can be large (a type keeps whole conversations in them), so they are read for this many
 * cases at a time and only the projected items are kept.
 */
const CONTEXT_CASE_BATCH = 100

/**
 * The statuses after which the writer stops observing an approval. `unavailable` is one of them: the approval
 * has ended without a verdict and the case is handed to a person.
 */
const FINAL_APPROVAL_STATUSES: ReadonlySet<string> = new Set([
  'approved',
  'rejected',
  'expired',
  'unavailable',
])

const registeredTypeSchema = z.object({ typeRef: employeeTypeRefSchema })

const caseStateSchema = z.enum(['active', 'waiting', 'blocked', 'terminal'])

/** The part of a stored lifecycle event this module reads back: the routing facts it published with it. */
const lifecycleDocumentSchema = z.object({
  routingFacts: z.object({
    state: caseStateSchema,
    previousState: caseStateSchema.nullable(),
    revision: z.number().int().optional(),
  }),
})

interface SelectedCase {
  readonly caseId: string
  readonly name: string
  readonly employeeId: string
  readonly employeeName: string | null
  readonly employeeRevision: number
  readonly typeId: string
  readonly typeRevision: number
  readonly origin: ProcessEmployeeCaseRow['origin']
  readonly ownerUserId: string | null
  readonly state: ProcessEmployeeCaseRow['state']
  readonly terminalKind: string | null
  readonly blockReason: string | null
  readonly createdAt: number
  readonly terminalAt: number | null
}

// Built per query: schema columns are provider projections and must not be captured at load time.
function caseFields(db: object) {
  const { employeeCases, employeeDefinitions } = tablesOf(db)
  return {
    caseId: employeeCases.id,
    name: employeeCases.name,
    employeeId: employeeCases.employeeId,
    employeeName: employeeDefinitions.name,
    employeeRevision: employeeCases.employeeRevision,
    typeId: employeeCases.typeId,
    typeRevision: employeeCases.typeRevision,
    origin: employeeCases.launchOrigin,
    ownerUserId: employeeCases.ownerUserId,
    state: employeeCases.state,
    terminalKind: employeeCases.terminalKind,
    blockReason: employeeCases.blockReason,
    createdAt: employeeCases.createdAt,
    terminalAt: employeeCases.terminalAt,
  }
}

function caseRow(row: SelectedCase): ProcessEmployeeCaseRow {
  return {
    caseId: row.caseId,
    name: row.name,
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    employeeRevision: Number(row.employeeRevision),
    typeId: row.typeId,
    typeRevision: Number(row.typeRevision),
    origin: row.origin,
    ownerUserId: row.ownerUserId,
    state: row.state,
    terminalKind: row.terminalKind,
    // Resuming and terminating clear the reason; reading it on a blocked case only keeps that true of any row.
    blockReason: row.state === 'blocked' ? row.blockReason : null,
    createdAt: Number(row.createdAt),
    terminalAt: row.terminalAt === null ? null : Number(row.terminalAt),
  }
}

/**
 * `canViewCase` (application/caseAccess.ts) as a row filter: everything for a read-all viewer, otherwise the
 * cases the viewer owns or is a member of. Same shape as the membership filter of the case list page.
 */
function visibleTo(db: PersistenceDb, viewer: ProcessViewer): SQL | undefined {
  if (viewer.canReadAll) return undefined
  const { employeeCases, employeeCaseMembers } = tablesOf(db)
  return or(
    eq(employeeCases.ownerUserId, viewer.userId),
    inArray(
      employeeCases.id,
      db
        .select({ id: employeeCaseMembers.caseId })
        .from(employeeCaseMembers)
        .where(eq(employeeCaseMembers.userId, viewer.userId)),
    ),
  )
}

function bounded(caseIds: readonly string[]): string[] {
  if (caseIds.length > PROCESS_FACT_ID_BATCH)
    throw new RangeError(`case id batch exceeds ${PROCESS_FACT_ID_BATCH}`)
  return [...new Set(caseIds)]
}

function ordered<T extends { readonly order: number }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.order - right.order)
}

/** The writers store ISO-8601 instants in these text columns. */
function instantOf(text: string | null): number | null {
  const at = text === null ? Number.NaN : Date.parse(text)
  return Number.isFinite(at) ? at : null
}

function frozenDescriptor(descriptorJson: string): EmployeeTypePackageDescriptor | null {
  try {
    return parsePersistedEmployeeTypePackageDescriptor(JSON.parse(descriptorJson) as unknown)
  } catch {
    // A registered descriptor this build can no longer read has no responsibility map to offer.
    return null
  }
}

function lifecycleFacts(summaryJson: string) {
  try {
    return lifecycleDocumentSchema.parse(JSON.parse(summaryJson) as unknown).routingFacts
  } catch {
    // Not a document this module published: it says nothing about a case's state.
    return null
  }
}

function caseTransitions(
  events: readonly ProcessSubjectEventRow[],
): ProcessEmployeeTransitionRow[] {
  const byCase = new Map<
    string,
    (Omit<ProcessEmployeeTransitionRow, 'caseId'> & { readonly revision: number })[]
  >()
  for (const event of events) {
    if (event.eventTypeId !== EMPLOYEE_CASE_STATE_CHANGED_EVENT_REF.id) continue
    const facts = lifecycleFacts(event.summaryJson)
    if (facts === null) continue
    const changes = byCase.get(event.subjectRef) ?? []
    byCase.set(event.subjectRef, changes)
    changes.push({
      at: event.occurredAt,
      revision: facts.revision ?? 0,
      from: facts.previousState,
      to: facts.state,
    })
  }
  return [...byCase].flatMap(([caseId, changes]) =>
    changes
      // Two changes of one case can share a millisecond, and events are stored in the order they were
      // published, not the order the case changed in; the case revision published with each change tells.
      .sort((left, right) => left.at - right.at || left.revision - right.revision)
      .map(({ at, from, to }) => ({ caseId, at, from, to })),
  )
}

function declaresProcessMetrics(
  registration: TypeRegistration,
): registration is DeclaringRegistration {
  return registration.describeProcessMetricsJson !== undefined
}

function projectsHumanFeedback(codec: ContextCodec): codec is FeedbackProjector {
  return codec.projectHumanFeedbackJson !== undefined
}

export function createProcessEmployeeFacts(
  db: PersistenceDb,
  types: ProcessEmployeeTypes,
): ProcessEmployeeFacts {
  const registrations = new Map<
    string,
    { readonly revision: number; readonly registration: TypeRegistration }[]
  >()
  for (const registration of types.typePackages) {
    const { typeRef } = registeredTypeSchema.parse(
      JSON.parse(registration.descriptorJson) as unknown,
    )
    const revisions = registrations.get(typeRef.typeId) ?? []
    registrations.set(typeRef.typeId, revisions)
    revisions.push({ revision: typeRef.revision, registration })
  }
  for (const revisions of registrations.values())
    revisions.sort((left, right) => right.revision - left.revision)

  const projectors = new Map<string, FeedbackProjector>()
  for (const codec of types.contextCodecs)
    if (projectsHumanFeedback(codec)) projectors.set(codec.typeId, codec)

  /**
   * The registration that speaks for a type revision: its own, or the type's newest one. Only the revisions
   * compiled into this build are registered, while cases keep the revision they started on; work item refs are
   * stable across revisions, so the newest declaration still describes them.
   */
  function registrationOf(typeId: string, revision: number): TypeRegistration | null {
    const revisions = registrations.get(typeId) ?? []
    return (
      (revisions.find((entry) => entry.revision === revision) ?? revisions[0])?.registration ?? null
    )
  }

  /**
   * The feedback items of each existing case, in the order given; null where the case's type does not project
   * feedback or one of its answers could not be read. A case with one unreadable context has no count at all:
   * the readable rest would be reported as the whole.
   */
  async function feedbackByCase(
    caseIds: readonly string[],
  ): Promise<Map<string, EmployeeHumanFeedbackItem[] | null>> {
    const { employeeCases } = tablesOf(db)
    const typeOfCase = new Map(
      (
        await db
          .select({ caseId: employeeCases.id, typeId: employeeCases.typeId })
          .from(employeeCases)
          .where(inArray(employeeCases.id, [...caseIds]))
      ).map((row) => [row.caseId, row.typeId] as const),
    )
    const feedback = new Map<string, EmployeeHumanFeedbackItem[] | null>()
    const projecting = new Map<string, FeedbackProjector>()
    for (const caseId of caseIds) {
      const typeId = typeOfCase.get(caseId)
      if (typeId === undefined) continue
      const projector = projectors.get(typeId)
      feedback.set(caseId, projector === undefined ? null : [])
      if (projector !== undefined) projecting.set(caseId, projector)
    }
    const projectingIds = [...projecting.keys()]
    for (let offset = 0; offset < projectingIds.length; offset += CONTEXT_CASE_BATCH) {
      const { employeeContextRecords } = tablesOf(db)
      const contexts = await db
        .select({
          caseId: employeeContextRecords.caseId,
          typeId: employeeContextRecords.typeId,
          stateJson: employeeContextRecords.stateJson,
        })
        .from(employeeContextRecords)
        .where(
          inArray(
            employeeContextRecords.caseId,
            projectingIds.slice(offset, offset + CONTEXT_CASE_BATCH),
          ),
        )
        .orderBy(
          asc(employeeContextRecords.caseId),
          asc(employeeContextRecords.createdAt),
          asc(employeeContextRecords.id),
        )
      for (const context of contexts) {
        const projector = projecting.get(context.caseId)
        const collected = feedback.get(context.caseId)
        if (projector === undefined || collected === undefined || collected === null) continue
        const items = readHumanFeedbackProjection(() =>
          projector.projectHumanFeedbackJson(context.typeId, context.stateJson),
        )
        if (items === null) feedback.set(context.caseId, null)
        else collected.push(...items)
      }
    }
    return feedback
  }

  return {
    async cases(viewer, query) {
      const { employeeCases, employeeDefinitions } = tablesOf(db)
      const rows = await db
        .select(caseFields(db))
        .from(employeeCases)
        .leftJoin(employeeDefinitions, eq(employeeDefinitions.id, employeeCases.employeeId))
        .where(
          and(
            gte(employeeCases.createdAt, query.from),
            lt(employeeCases.createdAt, query.to),
            query.employeeId === undefined
              ? undefined
              : eq(employeeCases.employeeId, query.employeeId),
            visibleTo(db, viewer),
          ),
        )
        .orderBy(desc(employeeCases.createdAt), desc(employeeCases.id))
        .limit(query.limit)
      return rows.map(caseRow)
    },

    async case(viewer, caseId) {
      const { employeeCases, employeeDefinitions } = tablesOf(db)
      const rows = await db
        .select(caseFields(db))
        .from(employeeCases)
        .leftJoin(employeeDefinitions, eq(employeeDefinitions.id, employeeCases.employeeId))
        .where(and(eq(employeeCases.id, caseId), visibleTo(db, viewer)))
        .limit(1)
      const row = rows[0]
      return row === undefined ? null : caseRow(row)
    },

    async rounds(caseIds) {
      const ids = bounded(caseIds)
      if (ids.length === 0) return []
      const { employeeReactionRounds } = tablesOf(db)
      // Read from the round table itself: collaboration rounds and rounds that fail before they start leave
      // no metering receipt, so receipts cannot stand in for the set of rounds.
      const rows = await db
        .select({
          caseId: employeeReactionRounds.caseId,
          roundId: employeeReactionRounds.id,
          workItemRef: employeeReactionRounds.workItemRef,
          state: employeeReactionRounds.state,
          attemptOrdinal: employeeReactionRounds.attemptOrdinal,
          createdAt: employeeReactionRounds.createdAt,
          settledAt: employeeReactionRounds.settledAt,
        })
        .from(employeeReactionRounds)
        .where(inArray(employeeReactionRounds.caseId, ids))
        .orderBy(
          asc(employeeReactionRounds.caseId),
          asc(employeeReactionRounds.createdAt),
          asc(employeeReactionRounds.id),
        )
      return rows.map((row) => ({
        caseId: row.caseId,
        roundId: row.roundId,
        workItemRef: row.workItemRef,
        state: row.state,
        attemptOrdinal: Number(row.attemptOrdinal),
        createdAt: Number(row.createdAt),
        settledAt: row.settledAt === null ? null : Number(row.settledAt),
      }))
    },

    async metering(caseIds) {
      const ids = bounded(caseIds)
      if (ids.length === 0) return []
      const { employeeCaseMeteringReceipts } = tablesOf(db)
      const rows = await db
        .select({
          caseId: employeeCaseMeteringReceipts.caseId,
          roundId: employeeCaseMeteringReceipts.roundId,
          durationMs: employeeCaseMeteringReceipts.durationMs,
          totalTokens: employeeCaseMeteringReceipts.totalTokens,
        })
        .from(employeeCaseMeteringReceipts)
        .where(inArray(employeeCaseMeteringReceipts.caseId, ids))
        .orderBy(
          asc(employeeCaseMeteringReceipts.caseId),
          asc(employeeCaseMeteringReceipts.createdAt),
          asc(employeeCaseMeteringReceipts.sourceRef),
        )
      return rows.map((row) => ({
        caseId: row.caseId,
        roundId: row.roundId,
        durationMs: Number(row.durationMs),
        totalTokens: Number(row.totalTokens),
      }))
    },

    transitions: caseTransitions,

    async approvals(caseIds) {
      const ids = bounded(caseIds)
      if (ids.length === 0) return []
      const { employeeApprovalSagas } = tablesOf(db)
      const rows = await db
        .select({
          caseId: employeeApprovalSagas.caseId,
          status: employeeApprovalSagas.latestStatus,
          submittedAt: employeeApprovalSagas.submittedAt,
          observedAt: employeeApprovalSagas.observedAt,
          createdAt: employeeApprovalSagas.createdAt,
          updatedAt: employeeApprovalSagas.updatedAt,
        })
        .from(employeeApprovalSagas)
        // A saga is `prepared` until the external system has accepted the request.
        .where(
          and(
            inArray(employeeApprovalSagas.caseId, ids),
            ne(employeeApprovalSagas.latestStatus, 'prepared'),
          ),
        )
        .orderBy(
          asc(employeeApprovalSagas.caseId),
          asc(employeeApprovalSagas.createdAt),
          asc(employeeApprovalSagas.id),
        )
      return rows.map(
        (row): ProcessEmployeeApprovalRow => ({
          caseId: row.caseId,
          submittedAt: instantOf(row.submittedAt) ?? Number(row.createdAt),
          // The writer stops observing once a status is final, so the last observation is the one that
          // recorded it — and the last time the row was written.
          settledAt: FINAL_APPROVAL_STATUSES.has(row.status)
            ? (instantOf(row.observedAt) ?? Number(row.updatedAt))
            : null,
          status: row.status,
        }),
      )
    },

    async humanFeedbackCounts(caseIds) {
      const ids = bounded(caseIds)
      if (ids.length === 0) return []
      return [...(await feedbackByCase(ids))].map(([caseId, items]) => ({
        caseId,
        items: items === null ? null : items.length,
      }))
    },

    async manifest(typeId, typeRevision) {
      const { employeeTypePackages } = tablesOf(db)
      // A retired revision still describes the cases that ran on it, so the state of the row is not a filter.
      const rows = await db
        .select({ descriptorJson: employeeTypePackages.descriptorJson })
        .from(employeeTypePackages)
        .where(
          and(
            eq(employeeTypePackages.typeId, typeId),
            eq(employeeTypePackages.revision, typeRevision),
          ),
        )
        .limit(1)
      const row = rows[0]
      const descriptor = row === undefined ? null : frozenDescriptor(row.descriptorJson)
      if (descriptor === null) return null
      const workItems = ordered(descriptor.authoringManifest.workItems)
      const known = new Set(workItems.map((item) => item.workItemRef))
      const registration = registrationOf(typeId, typeRevision)
      const declaration =
        registration === null || !declaresProcessMetrics(registration)
          ? null
          : readProcessMetricsDeclaration(() => registration.describeProcessMetricsJson())
      const rework = [...new Set(declaration?.reworkWorkItemRefs ?? [])].filter((ref) =>
        known.has(ref),
      )
      return {
        typeId,
        typeRevision,
        regions: ordered(descriptor.authoringManifest.lifecycleRegions).map((region) => ({
          regionId: region.regionId,
          label: region.label,
          order: region.order,
          lanes: ordered(region.responsibilityLanes).map((lane) => ({
            laneId: lane.laneId,
            label: lane.label,
            order: lane.order,
            kind: lane.kind,
          })),
        })),
        workItems: workItems.map((item) => ({
          workItemRef: item.workItemRef,
          regionId: item.regionId,
          // A region may declare no lanes and its work items then have none: the empty string, which no
          // manifest can declare as a lane id.
          laneId: item.responsibilityLaneId ?? '',
          order: item.order,
          label: item.label,
          nodeKind: item.nodeKind,
        })),
        // Naming no work item of this revision is the same as declaring none.
        reworkWorkItemRefs: rework.length === 0 ? null : rework,
      } satisfies ProcessEmployeeManifest
    },

    async texts(caseIds) {
      const ids = bounded(caseIds)
      if (ids.length === 0) return []
      return [...(await feedbackByCase(ids))].flatMap(([caseId, items]) =>
        (items ?? []).map((item) => ({
          source: 'employee-feedback' as const,
          taskId: null,
          caseId,
          stageRef: item.workItemRef ?? null,
          at: item.at,
          text: item.text,
        })),
      )
    },
  }
}
