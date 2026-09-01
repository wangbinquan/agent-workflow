import { and, asc, eq, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { agents, mcps, plugins, skills, workflows, workgroups } from '@/db/schema'
import type { QueryContext } from '@/modules/identity-access/public/participants'
import type {
  ResourceCatalogSummaryReadPort,
  ResourceCatalogSummaryReadQuery,
} from '../application/ports/providerResourceCatalogPersistence'
import {
  createResourceCatalogQueryApplication,
  getVisibleResourceSummary,
  listVisibleResourceSummaries,
} from '../application/resourceCatalogQuery'
import type { CatalogSelectorKind } from '../domain/resourceKinds'
import type { CatalogResourceRef } from '../domain/resourceRef'
import type { ResourceCatalogQuery } from '../public/queries'
import type { ResourceSummary, ResourceSummaryQuery } from '../public/types'
import { encodeSkillToken } from '../application/skills/skillToken'
import { mcpConfigHash, mcpFromPersistenceRow } from './mcpPersistence'
import { pluginConfigHash, pluginFromPersistenceRow } from './pluginPersistence'
import { visibleRowsCondition } from './sqliteResourceGrantRepository'

interface CatalogColumns {
  readonly id: SQLWrapper
  readonly name: SQLWrapper
  readonly description: SQLWrapper
  readonly ownerUserId: SQLWrapper
  readonly visibility: SQLWrapper
}

function afterCondition(
  columns: Pick<CatalogColumns, 'id' | 'name'>,
  after: ResourceCatalogSummaryReadQuery['after'],
): SQL<unknown> | undefined {
  if (after === undefined) return undefined
  return or(
    sql`${columns.name} > ${after.name}`,
    and(eq(columns.name, after.name), sql`${columns.id} > ${after.id}`),
  )!
}

function catalogWhere(
  db: DbClient,
  actor: Actor,
  kind: CatalogSelectorKind,
  columns: CatalogColumns,
  query: ResourceCatalogSummaryReadQuery,
): SQL<unknown> | undefined {
  const visibility = visibleRowsCondition(db, actor, kind, columns)
  const normalizedSearch = query.search?.trim()
  const matching =
    normalizedSearch === undefined || normalizedSearch === ''
      ? undefined
      : or(
          sql`instr(lower(${columns.name}), lower(${normalizedSearch})) > 0`,
          sql`instr(lower(COALESCE(${columns.description}, '')), lower(${normalizedSearch})) > 0`,
        )
  return and(visibility, matching, afterCondition(columns, query.after))
}

async function listKind(
  db: DbClient,
  actor: Actor,
  kind: CatalogSelectorKind,
  query: ResourceCatalogSummaryReadQuery,
): Promise<ResourceSummary[]> {
  switch (kind) {
    case 'agent': {
      const rows = await db
        .select({
          id: agents.id,
          name: agents.name,
          description: agents.description,
          ownerUserId: agents.ownerUserId,
          visibility: agents.visibility,
          aclRevision: agents.aclRevision,
          updatedAt: agents.updatedAt,
        })
        .from(agents)
        .where(catalogWhere(db, actor, kind, agents, query))
        .orderBy(asc(agents.name), asc(agents.id))
        .limit(query.limit)
      return rows.map((row) => ({
        ref: { kind, id: row.id },
        kind,
        name: row.name,
        description: row.description,
        revision: { kind, updatedAt: row.updatedAt, aclRevision: row.aclRevision },
        visibilityHint: row.visibility,
      }))
    }
    case 'skill': {
      const rows = await db
        .select({
          id: skills.id,
          name: skills.name,
          description: skills.description,
          ownerUserId: skills.ownerUserId,
          visibility: skills.visibility,
          contentVersion: skills.contentVersion,
          metaRevision: skills.metaRevision,
        })
        .from(skills)
        .where(catalogWhere(db, actor, kind, skills, query))
        .orderBy(asc(skills.name), asc(skills.id))
        .limit(query.limit)
      return rows.map((row) => ({
        ref: { kind, id: row.id },
        kind,
        name: row.name,
        description: row.description,
        revision: {
          kind,
          token: encodeSkillToken({
            skillId: row.id,
            contentVersion: row.contentVersion,
            metaRevision: row.metaRevision,
          }),
        },
        visibilityHint: row.visibility,
      }))
    }
    case 'mcp': {
      const rows = await db
        .select()
        .from(mcps)
        .where(catalogWhere(db, actor, kind, mcps, query))
        .orderBy(asc(mcps.name), asc(mcps.id))
        .limit(query.limit)
      return rows.map((row) => {
        const resource = mcpFromPersistenceRow(row)
        return {
          ref: { kind, id: row.id },
          kind,
          name: row.name,
          description: row.description,
          revision: { kind, configHash: mcpConfigHash(resource) },
          visibilityHint: row.visibility,
        }
      })
    }
    case 'plugin': {
      const rows = await db
        .select()
        .from(plugins)
        .where(catalogWhere(db, actor, kind, plugins, query))
        .orderBy(asc(plugins.name), asc(plugins.id))
        .limit(query.limit)
      return rows.map((row) => ({
        ref: { kind, id: row.id },
        kind,
        name: row.name,
        description: row.description,
        revision: {
          kind,
          configHash: pluginConfigHash(pluginFromPersistenceRow(row)),
        },
        visibilityHint: row.visibility,
      }))
    }
    case 'workflow': {
      const rows = await db
        .select({
          id: workflows.id,
          name: workflows.name,
          description: workflows.description,
          ownerUserId: workflows.ownerUserId,
          visibility: workflows.visibility,
          version: workflows.version,
        })
        .from(workflows)
        .where(catalogWhere(db, actor, kind, workflows, query))
        .orderBy(asc(workflows.name), asc(workflows.id))
        .limit(query.limit)
      return rows.map((row) => ({
        ref: { kind, id: row.id },
        kind,
        name: row.name,
        description: row.description,
        revision: { kind, version: row.version },
        visibilityHint: row.visibility,
      }))
    }
    case 'workgroup': {
      const rows = await db
        .select({
          id: workgroups.id,
          name: workgroups.name,
          description: workgroups.description,
          ownerUserId: workgroups.ownerUserId,
          visibility: workgroups.visibility,
          version: workgroups.version,
        })
        .from(workgroups)
        .where(catalogWhere(db, actor, kind, workgroups, query))
        .orderBy(asc(workgroups.name), asc(workgroups.id))
        .limit(query.limit)
      return rows.map((row) => ({
        ref: { kind, id: row.id },
        kind,
        name: row.name,
        description: row.description,
        revision: { kind, version: row.version },
        visibilityHint: row.visibility,
      }))
    }
  }
}

export function createSqliteResourceCatalogSummaryReadPort(
  db: DbClient,
): ResourceCatalogSummaryReadPort {
  const port: ResourceCatalogSummaryReadPort = {
    listKind: (actor, kind, query) => listKind(db, actor, kind, query),
  }
  return Object.freeze(port)
}

export async function listVisibleResourceSummariesForActor(
  db: DbClient,
  actor: Actor,
  query: ResourceSummaryQuery,
) {
  return listVisibleResourceSummaries(actor, query, createSqliteResourceCatalogSummaryReadPort(db))
}

export async function listAllVisibleResourceSummariesForActor(
  db: DbClient,
  actor: Actor,
): Promise<ResourceSummary[]> {
  const summaries = createSqliteResourceCatalogSummaryReadPort(db)
  const out: ResourceSummary[] = []
  let cursor: ResourceSummaryQuery['cursor']
  do {
    const page = await listVisibleResourceSummaries(
      actor,
      { limit: 500, ...(cursor === undefined ? {} : { cursor }) },
      summaries,
    )
    out.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  return out
}

export async function getVisibleResourceSummaryForActor(
  db: DbClient,
  actor: Actor,
  ref: CatalogResourceRef,
): Promise<ResourceSummary | null> {
  return getVisibleResourceSummary(actor, ref, createSqliteResourceCatalogSummaryReadPort(db))
}

export interface SqliteResourceCatalogQueryDependencies {
  resolveActor(context: QueryContext): Actor
}

export function createSqliteResourceCatalogQuery(
  db: DbClient,
  dependencies: SqliteResourceCatalogQueryDependencies,
): ResourceCatalogQuery {
  return createResourceCatalogQueryApplication({
    summaries: createSqliteResourceCatalogSummaryReadPort(db),
    resolveActor: dependencies.resolveActor,
  })
}
