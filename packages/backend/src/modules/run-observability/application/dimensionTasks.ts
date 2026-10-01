import type {
  ObservationTaskFacts,
  ObservationTaskPageQuery,
  ObservationTaskSummary,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { sha256Hex } from '@/util/hash'
import { parseObservationSelection } from '../domain/analysisDimensions'
import type { ObservationSnapshotSources } from '../ports/taskObservations'

export const OBSERVATION_READ_LIMITS = { tasks: 200, invocations: 10_000, records: 20_000 } as const
export class ObservationReadBudgetReached extends Error {}

/** Count source work before dimension selection; filtering never expands this budget. */
export function boundedObservationSources(
  sources: ObservationSnapshotSources,
): ObservationSnapshotSources {
  let invocations: number = OBSERVATION_READ_LIMITS.invocations,
    records: number = OBSERVATION_READ_LIMITS.records
  return {
    ...sources,
    async invocations(taskId) {
      if (invocations === 0) throw new ObservationReadBudgetReached()
      const page = await sources.invocations(taskId)
      if (page.items.length > invocations) throw new ObservationReadBudgetReached()
      invocations -= page.items.length
      return page
    },
    local: {
      async captures(ids) {
        if (ids.length > records) throw new ObservationReadBudgetReached()
        const rows = await sources.local.captures(ids)
        records -= rows.length
        return rows
      },
      async records(taskId, query) {
        if (records === 0) throw new ObservationReadBudgetReached()
        const page = await sources.local.records(taskId, {
          ...query,
          limit: Math.min(query.limit, records),
        })
        records -= page.items.length
        return page
      },
    },
    platform: {
      async records(binding, query) {
        if (records === 0) throw new ObservationReadBudgetReached()
        const page = await sources.platform.records(binding, {
          ...query,
          limit: Math.min(query.limit, records),
        })
        records -= page.items.length
        return page
      },
    },
  }
}

/** The enclosed Task cursor stays opaque. Only its owner may produce or consume it. */
export async function readDimensionTasks<
  T extends { readonly summary: ObservationTaskSummary },
>(input: {
  readonly actor: Actor
  readonly query: ObservationTaskPageQuery
  readonly sources: ObservationSnapshotSources
  readonly matchLimit?: number
  readonly summarize: (
    sources: ObservationSnapshotSources,
    task: ObservationTaskFacts,
  ) => Promise<T | null>
  readonly unresolved: (task: ObservationTaskFacts) => T
}) {
  const { selection: rawSelection, after, ...base } = input.query,
    selection = parseObservationSelection(rawSelection)
  if (selection === null) throw new RangeError('Dimension selection required')
  const scope = sha256Hex(
    JSON.stringify([
      base.from,
      base.to,
      base.timezone,
      base.q,
      base.status,
      base.repository,
      base.workflow,
      selection,
    ]),
  )
  let ownerAfter: string | undefined
  if (after !== undefined) {
    let cursor: unknown
    try {
      cursor = JSON.parse(after)
    } catch {
      throw new RangeError('Invalid dimension observation cursor')
    }
    if (
      !Array.isArray(cursor) ||
      cursor.length !== 3 ||
      cursor[0] !== 1 ||
      cursor[1] !== scope ||
      typeof cursor[2] !== 'string' ||
      !cursor[2]
    )
      throw new RangeError('Dimension observation cursor changed scope')
    ownerAfter = cursor[2]
  }
  const sources = boundedObservationSources(input.sources),
    rows: T[] = [],
    matchLimit = input.matchLimit ?? input.query.limit
  let scannedTasks = 0,
    partial = false,
    nextCursor: string | null = null
  scan: while (true) {
    const page = await sources.tasks.list({
      actor: input.actor,
      query: {
        ...base,
        limit: 25,
        ...(ownerAfter === undefined ? {} : { after: ownerAfter }),
      },
    })
    if (
      !Array.isArray(page.positions) ||
      page.positions.length !== page.items.length ||
      page.positions.some(
        (position, index) =>
          position.taskId !== page.items[index]?.id ||
          typeof position.cursor !== 'string' ||
          !position.cursor ||
          position.cursor === ownerAfter,
      )
    )
      throw new Error('Observation owner item positions missing or inconsistent')
    if (!page.items.length) {
      if (page.nextCursor !== null)
        throw new Error('Observation owner returned an empty continuing page')
      nextCursor = null
      break
    }
    if (
      new Set(page.positions.map((position) => position.cursor)).size !== page.positions.length ||
      (page.nextCursor !== null && page.nextCursor !== page.positions.at(-1)!.cursor)
    )
      throw new Error('Observation owner continuation inconsistent')
    for (let index = 0; index < page.items.length; index++) {
      const task = page.items[index]!,
        position = page.positions[index]!
      let row: T | null,
        exhausted = false
      try {
        row = await input.summarize(sources, task)
      } catch (error) {
        if (!(error instanceof ObservationReadBudgetReached)) throw error
        // A half-read task and its continuation advance together. Never reuse a subtotal.
        row = input.unresolved(task)
        exhausted = true
      }
      scannedTasks++
      if (row) rows.push(row)
      ownerAfter = position.cursor
      const eof = index === page.items.length - 1 && page.nextCursor === null
      nextCursor = eof ? null : JSON.stringify([1, scope, ownerAfter])
      if (
        exhausted ||
        scannedTasks === OBSERVATION_READ_LIMITS.tasks ||
        rows.length === matchLimit ||
        eof
      ) {
        partial = exhausted || (scannedTasks === OBSERVATION_READ_LIMITS.tasks && !eof)
        break scan
      }
    }
  }
  const unresolvedTasks = rows.filter((row) => row.summary.dimensionMatch === 'unresolved').length
  return {
    rows,
    nextCursor,
    scannedTasks,
    unresolvedTasks,
    partial: partial || unresolvedTasks > 0 || rows.some((row) => row.summary.metrics.truncated),
  }
}
