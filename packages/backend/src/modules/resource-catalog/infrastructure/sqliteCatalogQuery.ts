import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { agents, mcps, plugins, skills, workflows, workgroups } from '@/db/schema'
import type { QueryContext } from '@/modules/identity-access/public/participants'
import { CATALOG_SELECTOR_KINDS, type CatalogSelectorKind } from '../domain/resourceKinds'
import type { CatalogResourceRef } from '../domain/resourceRef'
import type { ResourceSummaryRevision } from '../domain/resourceRevision'
import type { Mcp, Plugin } from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'
import { and, asc, eq, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import { visibleRowsCondition } from './sqliteResourceGrantRepository'

const CATALOG_PAGE_MAX = 500
const KIND_RANK = new Map(CATALOG_SELECTOR_KINDS.map((kind, rank) => [kind, rank] as const))

declare const resourceCatalogCursorBrand: unique symbol

type ResourceCatalogCursor = string & {
  readonly [resourceCatalogCursorBrand]: 'resource-catalog-cursor'
}

interface ResourceSummaryQuery {
  readonly kinds?: readonly CatalogSelectorKind[]
  readonly search?: string
  readonly cursor?: ResourceCatalogCursor
  readonly limit: number
}

interface ResourceSummaryPage {
  readonly items: readonly ResourceSummary[]
  readonly nextCursor: ResourceCatalogCursor | null
}

interface ResourceSummaryOf<K extends CatalogSelectorKind> {
  readonly ref: CatalogResourceRef<K>
  readonly kind: K
  readonly name: string
  readonly description: string | null
  readonly revision: ResourceSummaryRevision<K>
  readonly visibilityHint: 'public' | 'private'
}

type ResourceSummary<K extends CatalogSelectorKind = CatalogSelectorKind> =
  K extends CatalogSelectorKind ? ResourceSummaryOf<K> : never

interface DecodedCatalogCursor {
  readonly kind: CatalogSelectorKind
  readonly name: string
  readonly id: string
}

interface CatalogColumns {
  readonly id: SQLWrapper
  readonly name: SQLWrapper
  readonly description: SQLWrapper
  readonly ownerUserId: SQLWrapper
  readonly visibility: SQLWrapper
}

function cursorOf(summary: ResourceSummary): ResourceCatalogCursor {
  return Buffer.from(
    JSON.stringify({ kind: summary.kind, name: summary.name, id: summary.ref.id }),
    'utf8',
  ).toString('base64url') as ResourceCatalogCursor
}

function decodeCursor(cursor: ResourceCatalogCursor | undefined): DecodedCatalogCursor | null {
  if (cursor === undefined) return null
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    const record = value as Record<string, unknown>
    if (
      typeof record.kind !== 'string' ||
      !CATALOG_SELECTOR_KINDS.includes(record.kind as CatalogSelectorKind) ||
      typeof record.name !== 'string' ||
      typeof record.id !== 'string' ||
      record.id.length === 0
    ) {
      throw new Error()
    }
    return {
      kind: record.kind as CatalogSelectorKind,
      name: record.name,
      id: record.id,
    }
  } catch {
    throw new ValidationError(
      'resource-catalog-cursor-invalid',
      'resource catalog cursor is invalid',
    )
  }
}

function afterCursorCondition(
  kind: CatalogSelectorKind,
  columns: Pick<CatalogColumns, 'id' | 'name'>,
  cursor: DecodedCatalogCursor | null,
): SQL<unknown> | undefined | false {
  if (cursor === null) return undefined
  const rank = KIND_RANK.get(kind)!
  const cursorRank = KIND_RANK.get(cursor.kind)!
  if (rank < cursorRank) return false
  if (rank > cursorRank) return undefined
  return or(
    sql`${columns.name} > ${cursor.name}`,
    and(eq(columns.name, cursor.name), sql`${columns.id} > ${cursor.id}`),
  )!
}

function catalogWhere(
  db: DbClient,
  actor: Actor,
  kind: CatalogSelectorKind,
  columns: CatalogColumns,
  search: string | undefined,
  cursor: DecodedCatalogCursor | null,
): SQL<unknown> | undefined | false {
  const after = afterCursorCondition(kind, columns, cursor)
  if (after === false) return false
  const visibility = visibleRowsCondition(db, actor, kind, columns)
  const normalizedSearch = search?.trim()
  const matching =
    normalizedSearch === undefined || normalizedSearch === ''
      ? undefined
      : or(
          sql`instr(lower(${columns.name}), lower(${normalizedSearch})) > 0`,
          sql`instr(lower(COALESCE(${columns.description}, '')), lower(${normalizedSearch})) > 0`,
        )
  return and(visibility, matching, after)
}

function compareSummaries(left: ResourceSummary, right: ResourceSummary): number {
  const rank = KIND_RANK.get(left.kind)! - KIND_RANK.get(right.kind)!
  if (rank !== 0) return rank
  if (left.name !== right.name) return left.name < right.name ? -1 : 1
  if (left.ref.id === right.ref.id) return 0
  return left.ref.id < right.ref.id ? -1 : 1
}

interface ActorCatalogQuery {
  readonly db: DbClient
  readonly actor: Actor
}

export interface SqliteResourceCatalogProjectionDependencies {
  readonly encodeSkillToken: (input: {
    readonly skillId: string
    readonly contentVersion: number
    readonly metaRevision: number
  }) => string
  readonly mcpFromRow: (row: typeof mcps.$inferSelect) => Mcp
  readonly mcpOperationConfigHashOf: (mcp: Mcp) => string
  readonly pluginFromRow: (row: typeof plugins.$inferSelect) => Plugin
  readonly pluginOperationConfigHashOf: (plugin: Plugin) => string
}

async function listKind(
  context: ActorCatalogQuery,
  projections: SqliteResourceCatalogProjectionDependencies,
  kind: CatalogSelectorKind,
  query: ResourceSummaryQuery,
  cursor: DecodedCatalogCursor | null,
): Promise<ResourceSummary[]> {
  const limit = query.limit + 1
  switch (kind) {
    case 'agent': {
      const where = catalogWhere(context.db, context.actor, kind, agents, query.search, cursor)
      if (where === false) return []
      const rows = await context.db
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
        .where(where)
        .orderBy(asc(agents.name), asc(agents.id))
        .limit(limit)
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
      const where = catalogWhere(context.db, context.actor, kind, skills, query.search, cursor)
      if (where === false) return []
      const rows = await context.db
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
        .where(where)
        .orderBy(asc(skills.name), asc(skills.id))
        .limit(limit)
      return rows.map((row) => ({
        ref: { kind, id: row.id },
        kind,
        name: row.name,
        description: row.description,
        revision: {
          kind,
          token: projections.encodeSkillToken({
            skillId: row.id,
            contentVersion: row.contentVersion,
            metaRevision: row.metaRevision,
          }),
        },
        visibilityHint: row.visibility,
      }))
    }
    case 'mcp': {
      const where = catalogWhere(context.db, context.actor, kind, mcps, query.search, cursor)
      if (where === false) return []
      const rows = await context.db
        .select()
        .from(mcps)
        .where(where)
        .orderBy(asc(mcps.name), asc(mcps.id))
        .limit(limit)
      return rows.map((row) => {
        const resource = projections.mcpFromRow(row)
        return {
          ref: { kind, id: row.id },
          kind,
          name: row.name,
          description: row.description,
          revision: { kind, configHash: projections.mcpOperationConfigHashOf(resource) },
          visibilityHint: row.visibility,
        }
      })
    }
    case 'plugin': {
      const where = catalogWhere(context.db, context.actor, kind, plugins, query.search, cursor)
      if (where === false) return []
      const rows = await context.db
        .select()
        .from(plugins)
        .where(where)
        .orderBy(asc(plugins.name), asc(plugins.id))
        .limit(limit)
      return rows.map((row) => ({
        ref: { kind, id: row.id },
        kind,
        name: row.name,
        description: row.description,
        revision: {
          kind,
          configHash: projections.pluginOperationConfigHashOf(projections.pluginFromRow(row)),
        },
        visibilityHint: row.visibility,
      }))
    }
    case 'workflow': {
      const where = catalogWhere(context.db, context.actor, kind, workflows, query.search, cursor)
      if (where === false) return []
      const rows = await context.db
        .select({
          id: workflows.id,
          name: workflows.name,
          description: workflows.description,
          ownerUserId: workflows.ownerUserId,
          visibility: workflows.visibility,
          version: workflows.version,
        })
        .from(workflows)
        .where(where)
        .orderBy(asc(workflows.name), asc(workflows.id))
        .limit(limit)
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
      const where = catalogWhere(context.db, context.actor, kind, workgroups, query.search, cursor)
      if (where === false) return []
      const rows = await context.db
        .select({
          id: workgroups.id,
          name: workgroups.name,
          description: workgroups.description,
          ownerUserId: workgroups.ownerUserId,
          visibility: workgroups.visibility,
          version: workgroups.version,
        })
        .from(workgroups)
        .where(where)
        .orderBy(asc(workgroups.name), asc(workgroups.id))
        .limit(limit)
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

export async function listVisibleResourceSummariesForActor(
  db: DbClient,
  actor: Actor,
  query: ResourceSummaryQuery,
  projections: SqliteResourceCatalogProjectionDependencies,
): Promise<ResourceSummaryPage> {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > CATALOG_PAGE_MAX) {
    throw new ValidationError(
      'resource-catalog-limit-invalid',
      `resource catalog limit must be between 1 and ${CATALOG_PAGE_MAX}`,
    )
  }
  const requested = new Set(query.kinds ?? CATALOG_SELECTOR_KINDS)
  const kinds = CATALOG_SELECTOR_KINDS.filter((kind) => requested.has(kind))
  const cursor = decodeCursor(query.cursor)
  const candidates = (
    await Promise.all(
      kinds.map((kind) => listKind({ db, actor }, projections, kind, query, cursor)),
    )
  )
    .flat()
    .sort(compareSummaries)
  const items = candidates.slice(0, query.limit)
  return {
    items,
    nextCursor: candidates.length > query.limit ? cursorOf(items.at(-1)!) : null,
  }
}

export async function listAllVisibleResourceSummariesForActor(
  db: DbClient,
  actor: Actor,
  projections: SqliteResourceCatalogProjectionDependencies,
): Promise<ResourceSummary[]> {
  const out: ResourceSummary[] = []
  let cursor: ResourceCatalogCursor | undefined
  do {
    const page = await listVisibleResourceSummariesForActor(
      db,
      actor,
      {
        limit: CATALOG_PAGE_MAX,
        ...(cursor === undefined ? {} : { cursor }),
      },
      projections,
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
  projections: SqliteResourceCatalogProjectionDependencies,
): Promise<ResourceSummary | null> {
  let cursor: ResourceCatalogCursor | undefined
  do {
    const page = await listVisibleResourceSummariesForActor(
      db,
      actor,
      {
        kinds: [ref.kind],
        limit: CATALOG_PAGE_MAX,
        ...(cursor === undefined ? {} : { cursor }),
      },
      projections,
    )
    const found = page.items.find((item) => item.ref.id === ref.id)
    if (found !== undefined) return found
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  return null
}

export interface SqliteResourceCatalogQueryDependencies extends SqliteResourceCatalogProjectionDependencies {
  resolve(context: QueryContext): ActorCatalogQuery
}

interface SqliteResourceCatalogQuery {
  listVisible(context: QueryContext, query: ResourceSummaryQuery): Promise<ResourceSummaryPage>
  getVisibleSummary(context: QueryContext, ref: CatalogResourceRef): Promise<ResourceSummary | null>
}

export function createSqliteResourceCatalogQuery(
  dependencies: SqliteResourceCatalogQueryDependencies,
): SqliteResourceCatalogQuery {
  return {
    listVisible(context, query) {
      const resolved = dependencies.resolve(context)
      return listVisibleResourceSummariesForActor(resolved.db, resolved.actor, query, dependencies)
    },
    getVisibleSummary(context, ref) {
      const resolved = dependencies.resolve(context)
      return getVisibleResourceSummaryForActor(resolved.db, resolved.actor, ref, dependencies)
    },
  }
}
