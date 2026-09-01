import { and, asc, desc, eq, inArray, isNotNull, lt, or, sql, type SQL } from 'drizzle-orm'
import {
  DIGITAL_EMPLOYEE_MISSION_STATUSES,
  digitalEmployeeTaskStatus,
  taskMatchesListView,
} from '@agent-workflow/shared'

import {
  cachedRepos,
  developmentDecisions,
  developmentEffects,
  developmentMissionSources,
  developmentMissions,
  developmentMrClaims,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  MissionPageFilters,
  MissionPageProjection,
  MissionReadModelQueries,
  MissionSummaryProjection,
} from '../application/ports/missionReadModelQueries'
import { mergeRequestHref } from './missionReadModels'

const SUMMARY_COLUMNS = {
  id: developmentMissions.id,
  revision: developmentMissions.revision,
  status: developmentMissions.status,
  automationMode: developmentMissions.automationMode,
  transitionFence: developmentMissions.transitionFence,
  repositoryId: developmentMissions.repositoryId,
  sourceKind: developmentMissions.sourceKind,
  externalId: developmentMissions.externalId,
  resolvedSourceKey: developmentMissions.resolvedSourceKey,
  deliveryKind: developmentMissions.deliveryKind,
  employeeId: developmentMissions.employeeId,
  employeeRevision: developmentMissions.employeeRevision,
  policyId: developmentMissions.policyId,
  policyRevision: developmentMissions.policyRevision,
  blockCode: developmentMissions.blockCode,
  terminalKind: developmentMissions.terminalKind,
  createdAt: developmentMissions.createdAt,
  updatedAt: developmentMissions.updatedAt,
} as const

const TERMINAL_MISSION_STATUSES = [
  'merged',
  'completed-no-change',
  'closed-unmerged',
  'canceled',
  'failed',
] as const
const MAX_EMPLOYEE_OUTCOME_GROUPS = 50_000

function statusesFor(filters: MissionPageFilters): string[] {
  const wanted = filters.statuses ?? []
  const view = filters.view ?? 'all'
  return DIGITAL_EMPLOYEE_MISSION_STATUSES.filter((missionStatus) => {
    const status = digitalEmployeeTaskStatus(missionStatus)
    return (wanted.length === 0 || wanted.includes(status)) && taskMatchesListView(view, status)
  })
}

async function facets(db: PostgresqlDatabaseClient): Promise<MissionPageProjection['facets']> {
  const rows = await db
    .select({ status: developmentMissions.status, n: sql<number>`count(*)` })
    .from(developmentMissions)
    .groupBy(developmentMissions.status)
    .all()
  const result = { all: 0, active: 0, attention: 0, finished: 0 }
  for (const row of rows) {
    const count = Number(row.n)
    const status = digitalEmployeeTaskStatus(row.status)
    result.all += count
    if (taskMatchesListView('active', status)) result.active += count
    if (taskMatchesListView('attention', status)) result.attention += count
    if (taskMatchesListView('finished', status)) result.finished += count
  }
  return result
}

async function counts(db: PostgresqlDatabaseClient, where: SQL): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: developmentMissions.status, n: sql<number>`count(*)` })
    .from(developmentMissions)
    .where(where)
    .groupBy(developmentMissions.status)
    .all()
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.n)]))
}

export function createPostgresqlMissionReadModelQueries(
  db: PostgresqlDatabaseClient,
): MissionReadModelQueries {
  return {
    async list() {
      return await db
        .select(SUMMARY_COLUMNS)
        .from(developmentMissions)
        .orderBy(desc(developmentMissions.createdAt))
        .all()
    },
    async listPage(input) {
      const statuses = statusesFor(input)
      const allFacets = await facets(db)
      if (statuses.length === 0) {
        return { items: [], nextCursor: null, facets: allFacets, counts: {} }
      }
      const boundary =
        input.cursor === undefined
          ? sql`1 = 1`
          : or(
              lt(developmentMissions.createdAt, input.cursor.createdAt),
              and(
                eq(developmentMissions.createdAt, input.cursor.createdAt),
                lt(developmentMissions.id, input.cursor.id),
              ),
            )!
      const statusCond =
        statuses.length === DIGITAL_EMPLOYEE_MISSION_STATUSES.length
          ? sql`1 = 1`
          : inArray(developmentMissions.status, statuses)
      const employeeCond =
        input.employeeId === undefined
          ? sql`1 = 1`
          : eq(developmentMissions.employeeId, input.employeeId)
      const missionStatusCond =
        input.missionStatuses === undefined || input.missionStatuses.length === 0
          ? sql`1 = 1`
          : inArray(developmentMissions.status, [...input.missionStatuses])
      const needle = input.q?.trim().toLocaleLowerCase('en-US')
      const queryCond =
        needle === undefined || needle === ''
          ? sql`1 = 1`
          : sql`(lower(${developmentMissions.id}) like ${`%${needle}%`}
              or lower(${developmentMissions.repositoryId}) like ${`%${needle}%`}
              or lower(coalesce(${developmentMissions.externalId}, '')) like ${`%${needle}%`}
              or lower(coalesce(${developmentMissions.blockCode}, '')) like ${`%${needle}%`}
              or lower(coalesce(${developmentMissions.employeeId}, '')) like ${`%${needle}%`})`
      const filters = and(statusCond, employeeCond, missionStatusCond, queryCond)!
      const rows = await db
        .select(SUMMARY_COLUMNS)
        .from(developmentMissions)
        .where(and(boundary, filters))
        .orderBy(desc(developmentMissions.createdAt), desc(developmentMissions.id))
        .limit(input.limit + 1)
        .all()
      const hasMore = rows.length > input.limit
      const page = hasMore ? rows.slice(0, input.limit) : rows
      const last = page[page.length - 1]
      return {
        items: page,
        nextCursor:
          hasMore && last !== undefined ? { createdAt: last.createdAt, id: last.id } : null,
        facets: allFacets,
        counts: await counts(db, filters),
      }
    },
    async terminalOutcomeGroups() {
      const rows = await db
        .select({
          employeeId: developmentMissions.employeeId,
          terminalKind: developmentMissions.status,
          count: sql<number>`count(*)`,
        })
        .from(developmentMissions)
        .where(
          and(
            isNotNull(developmentMissions.employeeId),
            inArray(developmentMissions.status, [...TERMINAL_MISSION_STATUSES]),
          ),
        )
        .groupBy(developmentMissions.status, developmentMissions.employeeId)
        .orderBy(asc(developmentMissions.status), asc(developmentMissions.employeeId))
        .limit(MAX_EMPLOYEE_OUTCOME_GROUPS + 1)
        .all()
      if (rows.length > MAX_EMPLOYEE_OUTCOME_GROUPS) {
        throw new Error('employee-outcome-group-limit-exceeded')
      }
      return rows.flatMap((row) =>
        row.employeeId === null
          ? []
          : [
              {
                employeeId: row.employeeId,
                terminalKind: row.terminalKind,
                count: Number(row.count),
              },
            ],
      )
    },
    async detail(missionId) {
      const row = await db
        .select()
        .from(developmentMissions)
        .where(eq(developmentMissions.id, missionId))
        .limit(1)
        .get()
      if (row === undefined) return null
      const sources = await db
        .select()
        .from(developmentMissionSources)
        .where(eq(developmentMissionSources.missionId, missionId))
        .all()
      const summary: MissionSummaryProjection = {
        id: row.id,
        revision: row.revision,
        status: row.status,
        automationMode: row.automationMode,
        transitionFence: row.transitionFence,
        repositoryId: row.repositoryId,
        sourceKind: row.sourceKind,
        externalId: row.externalId,
        resolvedSourceKey: row.resolvedSourceKey,
        deliveryKind: row.deliveryKind,
        employeeId: row.employeeId,
        employeeRevision: row.employeeRevision,
        policyId: row.policyId,
        policyRevision: row.policyRevision,
        blockCode: row.blockCode,
        terminalKind: row.terminalKind,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
      return {
        ...summary,
        sources: sources.map((source) => ({
          generation: source.generation,
          sourceKind: source.sourceKind,
          externalId: source.externalId,
          adapterId: source.adapterId,
          adapterRevision: source.adapterRevision,
          sourceRevision: source.sourceRevision,
          bundleRef: source.bundleRef,
          manifestDigest: source.manifestDigest,
          state: source.state,
        })),
        readiness: row.readinessJson === null ? null : JSON.parse(row.readinessJson),
        blockDetail: row.blockDetail,
      }
    },
    async mergeRequest(missionId, repositoryId) {
      const claim = await db
        .select()
        .from(developmentMrClaims)
        .where(eq(developmentMrClaims.missionId, missionId))
        .limit(1)
        .get()
      if (claim === undefined) return null
      const repository = await db
        .select({ urlRedacted: cachedRepos.urlRedacted })
        .from(cachedRepos)
        .where(eq(cachedRepos.id, repositoryId))
        .limit(1)
        .get()
      return {
        iid: claim.mrIid,
        state: claim.state,
        href: mergeRequestHref({
          repositoryUrl: repository?.urlRedacted ?? null,
          endpointRef: claim.codeHostEndpointRef,
          mrIid: claim.mrIid,
        }),
      }
    },
    async effects(missionId) {
      const rows = await db
        .select()
        .from(developmentEffects)
        .where(eq(developmentEffects.missionId, missionId))
        .orderBy(desc(developmentEffects.createdAt))
        .all()
      return rows.map((row) => ({
        id: row.id,
        effectKind: row.effectKind,
        state: row.state,
        intentDigest: row.intentDigest,
        epoch: row.epoch,
        createdAt: row.createdAt,
        settledAt: row.settledAt,
      }))
    },
    async decisionTrace(missionId) {
      const rows = await db
        .select()
        .from(developmentDecisions)
        .where(eq(developmentDecisions.missionId, missionId))
        .orderBy(desc(developmentDecisions.decidedAt))
        .all()
      return rows.map((row) => ({
        id: row.id,
        missionRevision: row.missionRevision,
        policyId: row.policyId,
        policyRevision: row.policyRevision,
        employeeId: row.employeeId,
        employeeRevision: row.employeeRevision,
        factDigest: row.factDigest,
        guardTrace: JSON.parse(row.guardTraceJson),
        ruleTrace: JSON.parse(row.ruleTraceJson),
        selected: JSON.parse(row.selectedJson),
        canonicalDigest: row.canonicalDigest,
        decidedAt: row.decidedAt,
      }))
    },
  }
}
