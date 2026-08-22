import {
  TASK_SOURCE_REGISTRATIONS,
  TaskCatalogPageSchema,
  isTaskSourceId,
  type TaskCatalogSourcesDocument,
  type TaskOperationsFacets,
  type TaskSourceId,
} from '@agent-workflow/shared'

import type { Actor } from '@/auth/actor'
import { ForbiddenError, ValidationError } from '@/util/errors'
import type { TaskCatalogSource } from '../composition/required-ports'
import type { TaskCatalogListQuery } from '../public/types'

export class TaskCatalogQueryService {
  readonly #sources: ReadonlyMap<TaskSourceId, TaskCatalogSource>

  constructor(sources: readonly TaskCatalogSource[]) {
    const byId = new Map<TaskSourceId, TaskCatalogSource>()
    for (const source of sources) {
      if (byId.has(source.sourceId))
        throw new Error(`duplicate task catalog source: ${source.sourceId}`)
      byId.set(source.sourceId, source)
    }
    const expected = new Set(TASK_SOURCE_REGISTRATIONS.map((source) => source.id))
    for (const sourceId of expected) {
      if (!byId.has(sourceId)) throw new Error(`task catalog source is missing: ${sourceId}`)
    }
    for (const sourceId of byId.keys()) {
      if (!expected.has(sourceId)) {
        throw new Error(`task catalog source is not registered: ${sourceId}`)
      }
    }
    this.#sources = byId
  }

  listSources(actor: Actor): string {
    const permissions = actor.permissions
    const document: TaskCatalogSourcesDocument = {
      schemaVersion: 1,
      sources: TASK_SOURCE_REGISTRATIONS.filter(
        (source) =>
          permissions.has(source.list.requiredPermission) ||
          permissions.has(source.creation.requiredPermission),
      ).map((source) => ({
        id: source.id,
        order: source.order,
        catalogPath: source.catalogPath,
        labelKey: source.labelKey,
        descriptionKey: source.descriptionKey,
        creationPermission: source.creation.requiredPermission,
        listPermission: source.list.requiredPermission,
        detailPath: source.list.detailPath,
      })),
    }
    return JSON.stringify(document)
  }

  async list(query: TaskCatalogListQuery, actor: Actor): Promise<string> {
    const selectedSource =
      query.sourceId === undefined
        ? null
        : (TASK_SOURCE_REGISTRATIONS.find((source) => source.id === query.sourceId) ?? null)
    if (query.sourceId !== undefined && selectedSource === null) {
      throw new ValidationError('task-source-invalid', `unknown task source: ${query.sourceId}`)
    }
    const permissions = actor.permissions
    const visibleSources = (
      selectedSource === null ? TASK_SOURCE_REGISTRATIONS : [selectedSource]
    ).filter((source) => permissions.has(source.list.requiredPermission))
    if (visibleSources.length === 0) {
      throw new ForbiddenError('task-source-forbidden', 'no readable task source', {
        sourceId: selectedSource?.id ?? null,
      })
    }
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor)
    const activeSources = visibleSources.flatMap((registration) => {
      const source = this.#sources.get(registration.id)
      if (source === undefined)
        throw new Error(`task catalog source disappeared: ${registration.id}`)
      if (query.parentItemId !== undefined && !source.supportsHierarchy) {
        if (selectedSource !== null) {
          throw new ValidationError(
            'task-hierarchy-unsupported',
            `task source does not expose child tasks: ${registration.id}`,
          )
        }
        return []
      }
      if (cursor?.cursors[registration.id] === null) return []
      return [{ registration, source }]
    })
    const pages = await Promise.all(
      activeSources.map(async ({ registration, source }) => {
        const page = await source.list({
          actor,
          ...(query.view === undefined ? {} : { view: query.view }),
          ...(query.q === undefined ? {} : { q: query.q }),
          ...(query.statuses === undefined ? {} : { statuses: query.statuses }),
          ...(query.scope === undefined ? {} : { scope: query.scope }),
          ...(query.origin === undefined ? {} : { origin: query.origin }),
          ...(query.parentItemId === undefined ? {} : { parentItemId: query.parentItemId }),
          ...(cursor?.cursors[registration.id] === undefined
            ? {}
            : { cursor: cursor.cursors[registration.id]! }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        })
        for (const item of page.items) {
          if (item.sourceId !== registration.id) {
            throw new Error(
              `task catalog source returned the wrong identity: ${registration.id}/${item.sourceId}`,
            )
          }
        }
        return { sourceId: registration.id, page }
      }),
    )
    const nextCursors = Object.fromEntries(
      visibleSources.map((source) => {
        const page = pages.find((candidate) => candidate.sourceId === source.id)?.page
        return [source.id, page?.nextCursor ?? null]
      }),
    ) as Partial<Record<TaskSourceId, string | null>>
    const hasNext = Object.values(nextCursors).some((value) => value !== null)
    const facets = pages.reduce<TaskOperationsFacets>(
      (total, entry) => ({
        all: total.all + entry.page.facets.all,
        active: total.active + entry.page.facets.active,
        attention: total.attention + entry.page.facets.attention,
        finished: total.finished + entry.page.facets.finished,
      }),
      { all: 0, active: 0, attention: 0, finished: 0 },
    )
    const page = TaskCatalogPageSchema.parse({
      schemaVersion: 1,
      sourceIds: visibleSources.map((source) => source.id),
      items: pages
        .flatMap((entry) => entry.page.items)
        .sort(
          (left, right) =>
            right.hierarchy.branchStartedAt - left.hierarchy.branchStartedAt ||
            right.id.localeCompare(left.id),
        ),
      nextCursor: hasNext ? encodeCursor(nextCursors) : null,
      facets,
    })
    return JSON.stringify(page)
  }
}

interface CatalogCursor {
  readonly v: 1
  readonly cursors: Partial<Record<TaskSourceId, string | null>>
}

function encodeCursor(cursors: CatalogCursor['cursors']): string {
  return Buffer.from(JSON.stringify({ v: 1, cursors } satisfies CatalogCursor)).toString(
    'base64url',
  )
}

function decodeCursor(raw: string): CatalogCursor {
  try {
    const decoded = Buffer.from(raw, 'base64url')
    if (decoded.toString('base64url') !== raw) throw new Error('non-canonical')
    const value = JSON.parse(decoded.toString('utf8')) as unknown
    if (typeof value !== 'object' || value === null || (value as { v?: unknown }).v !== 1) {
      throw new Error('shape')
    }
    const rawCursors = (value as { cursors?: unknown }).cursors
    if (typeof rawCursors !== 'object' || rawCursors === null || Array.isArray(rawCursors)) {
      throw new Error('cursors')
    }
    const cursors: Partial<Record<TaskSourceId, string | null>> = {}
    for (const [sourceId, cursor] of Object.entries(rawCursors)) {
      if (!isTaskSourceId(sourceId) || (cursor !== null && typeof cursor !== 'string')) {
        throw new Error('entry')
      }
      cursors[sourceId] = cursor
    }
    return { v: 1, cursors }
  } catch {
    throw new ValidationError('task-page-cursor-invalid', 'invalid task catalog cursor')
  }
}
