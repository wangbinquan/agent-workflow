import { and, asc, eq, gt } from 'drizzle-orm'
import { AcceptedObservationInvocationSchema } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationInvocations } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { completeSourceCursor, completeSourcePosition } from '../domain/completeSourceCursor'
import type { CompleteSourceReader } from '../ports/completeReport'
import type { CompleteObservationSources } from '../ports/completeObservationSources'
import type { ObservationTaskSource } from '../ports/taskObservations'
import { readUsageCapturePage } from './usageCapturePersistence'
import { createUsageLedgerStore } from './usageLedgerPersistence'
import {
  createPlatformObservationStore,
  readPlatformObservationPage,
} from './platformObservationPersistence'

/** The caller owns the dedicated original snapshot connection; this adapter opens no transactions. */
export function createCompleteObservationSources(input: {
  readonly db: ProviderNeutralDatabase
  readonly tasks: ObservationTaskSource
  readonly snapshotId: string
  readonly pageSize?: number
}): CompleteObservationSources {
  const { db, tasks, snapshotId } = input,
    pageSize = input.pageSize ?? 100
  if (!snapshotId || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200)
    throw new RangeError('Complete source page size or snapshot identity invalid')
  const ledger = createUsageLedgerStore(db),
    platform = createPlatformObservationStore(db)
  const reader = <T>(
    source: string,
    parent: string,
    read: (
      after: string | undefined,
    ) => Promise<{ readonly items: readonly T[]; readonly nextCursor?: string | null }>,
  ): CompleteSourceReader<T> => ({
    async next(cursor) {
      const page = await read(completeSourcePosition(cursor, snapshotId, source, parent))
      return {
        items: page.items,
        snapshotId,
        nextCursor:
          page.nextCursor == null
            ? null
            : completeSourceCursor(snapshotId, source, parent, page.nextCursor),
      }
    },
  })
  return {
    snapshotId,
    tasks: (actor, query) => {
      const parent = sha256Hex(
        JSON.stringify([actor.user.id, [...actor.permissions].sort(), query]),
      )
      return reader('tasks', parent, (after) =>
        tasks.list({
          actor,
          query: { ...query, limit: pageSize, ...(after === undefined ? {} : { after }) },
        }),
      )
    },
    attempts: (taskId) =>
      reader('attempts', taskId, (after) => {
        if (!tasks.attemptPage) throw new Error('Complete attempt source is not installed')
        return tasks.attemptPage(taskId, {
          limit: pageSize,
          ...(after === undefined ? {} : { after }),
        })
      }),
    invocations: (taskId) =>
      reader('invocations', taskId, async (after) => {
        const rows = await db
          .select({ id: observationInvocations.id, document: observationInvocations.document })
          .from(observationInvocations)
          .where(
            and(
              eq(observationInvocations.taskId, taskId),
              after === undefined ? undefined : gt(observationInvocations.id, after),
            ),
          )
          .orderBy(asc(observationInvocations.id))
          .limit(pageSize + 1)
          .all()
        const selected = rows.slice(0, pageSize)
        return {
          items: selected.map((row) =>
            AcceptedObservationInvocationSchema.parse(JSON.parse(row.document)),
          ),
          nextCursor: rows.length > pageSize ? selected.at(-1)!.id : null,
        }
      }),
    usage: (taskId) =>
      reader('usage', taskId, (after) =>
        ledger.records(taskId, { limit: pageSize, ...(after === undefined ? {} : { after }) }),
      ),
    captures: (taskId) =>
      reader('captures', taskId, (after) =>
        readUsageCapturePage(db, taskId, {
          limit: pageSize,
          ...(after === undefined ? {} : { after }),
        }),
      ),
    platform: (binding) =>
      reader('platform', JSON.stringify(binding), (after) =>
        readPlatformObservationPage(db, binding, {
          limit: pageSize,
          ...(after === undefined ? {} : { after }),
        }),
      ),
    platformState: (binding) => platform.state(binding),
    async backlog(taskId) {
      const [state] = await tasks.sourceBacklog([taskId])
      if (!state || state.taskId !== taskId)
        throw new Error('Original Task source backlog proof missing')
      return state
    },
  }
}
