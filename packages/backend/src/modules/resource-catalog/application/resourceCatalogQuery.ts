import type { Actor } from '@/auth/actor'
import type { QueryContext } from '@/modules/identity-access/public/participants'
import { ValidationError } from '@/util/errors'
import type { CatalogResourceRef } from '../domain/resourceRef'
import { CATALOG_SELECTOR_KINDS, type CatalogSelectorKind } from '../domain/resourceKinds'
import type { ResourceCatalogQuery } from '../public/queries'
import type {
  ResourceCatalogCursor,
  ResourceSummary,
  ResourceSummaryPage,
  ResourceSummaryQuery,
} from '../public/types'
import type { ResourceCatalogSummaryReadPort } from './ports/providerResourceCatalogPersistence'

const CATALOG_PAGE_MAX = 500
const KIND_RANK = new Map(CATALOG_SELECTOR_KINDS.map((kind, rank) => [kind, rank] as const))

interface DecodedCatalogCursor {
  readonly kind: CatalogSelectorKind
  readonly name: string
  readonly id: string
}

function isCatalogSelectorKind(value: unknown): value is CatalogSelectorKind {
  return (
    typeof value === 'string' && CATALOG_SELECTOR_KINDS.some((candidate) => candidate === value)
  )
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
      !isCatalogSelectorKind(record.kind) ||
      typeof record.name !== 'string' ||
      typeof record.id !== 'string' ||
      record.id.length === 0
    ) {
      throw new Error()
    }
    return { kind: record.kind, name: record.name, id: record.id }
  } catch {
    throw new ValidationError(
      'resource-catalog-cursor-invalid',
      'resource catalog cursor is invalid',
    )
  }
}

function compareSummaries(left: ResourceSummary, right: ResourceSummary): number {
  const rank = KIND_RANK.get(left.kind)! - KIND_RANK.get(right.kind)!
  if (rank !== 0) return rank
  if (left.name !== right.name) return left.name < right.name ? -1 : 1
  if (left.ref.id === right.ref.id) return 0
  return left.ref.id < right.ref.id ? -1 : 1
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > CATALOG_PAGE_MAX) {
    throw new ValidationError(
      'resource-catalog-limit-invalid',
      `resource catalog limit must be between 1 and ${CATALOG_PAGE_MAX}`,
    )
  }
}

export async function listVisibleResourceSummaries(
  actor: Actor,
  query: ResourceSummaryQuery,
  summaries: ResourceCatalogSummaryReadPort,
): Promise<ResourceSummaryPage> {
  assertLimit(query.limit)
  const requested = new Set(query.kinds ?? CATALOG_SELECTOR_KINDS)
  const cursor = decodeCursor(query.cursor)
  const cursorRank = cursor === null ? -1 : KIND_RANK.get(cursor.kind)!
  const kinds = CATALOG_SELECTOR_KINDS.filter(
    (kind) => requested.has(kind) && KIND_RANK.get(kind)! >= cursorRank,
  )
  const candidates = (
    await Promise.all(
      kinds.map((kind) =>
        summaries.listKind(actor, kind, {
          limit: query.limit + 1,
          ...(query.search === undefined ? {} : { search: query.search }),
          ...(cursor?.kind === kind ? { after: { name: cursor.name, id: cursor.id } } : {}),
        }),
      ),
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

export async function getVisibleResourceSummary(
  actor: Actor,
  ref: CatalogResourceRef,
  summaries: ResourceCatalogSummaryReadPort,
): Promise<ResourceSummary | null> {
  let cursor: ResourceCatalogCursor | undefined
  do {
    const page = await listVisibleResourceSummaries(
      actor,
      {
        kinds: [ref.kind],
        limit: CATALOG_PAGE_MAX,
        ...(cursor === undefined ? {} : { cursor }),
      },
      summaries,
    )
    const found = page.items.find((item) => item.ref.id === ref.id)
    if (found !== undefined) return found
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  return null
}

export interface ResourceCatalogQueryApplicationDependencies {
  readonly summaries: ResourceCatalogSummaryReadPort
  resolveActor(context: QueryContext): Actor
}

/** Public query composition over a provider-bound, row-free persistence port. */
export function createResourceCatalogQueryApplication(
  dependencies: ResourceCatalogQueryApplicationDependencies,
): ResourceCatalogQuery {
  const application: ResourceCatalogQuery = {
    listVisible(context: QueryContext, query: ResourceSummaryQuery) {
      return listVisibleResourceSummaries(
        dependencies.resolveActor(context),
        query,
        dependencies.summaries,
      )
    },
    getVisibleSummary(context: QueryContext, ref: CatalogResourceRef) {
      return getVisibleResourceSummary(
        dependencies.resolveActor(context),
        ref,
        dependencies.summaries,
      )
    },
  }
  return Object.freeze(application)
}
