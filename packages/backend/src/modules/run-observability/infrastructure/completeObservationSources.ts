import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import { AcceptedObservationInvocationSchema } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationInvocations, observationUsageCurrent } from '@/db/schema'
import { jsonPathText } from '@/platform/persistence/jsonPathText'
import { identityPacketPage } from '@/platform/persistence/identityPackets'
import type { UsageLedgerRecord } from '../domain/usageLedger'
import { sha256Hex } from '@/util/hash'
import { completeSourceCursor, completeSourcePosition } from '../domain/completeSourceCursor'
import type { CompleteSourceReader } from '../ports/completeReport'
import type { CompleteObservationSources } from '../ports/completeObservationSources'
import type {
  ObservationTaskSource,
  ProjectionObservationTaskSource,
} from '../ports/taskObservations'
import { readUsageCapturePage } from './usageCapturePersistence'
import { createUsageLedgerStore } from './usageLedgerPersistence'
import {
  createPlatformObservationStore,
  readPlatformObservationPage,
} from './platformObservationPersistence'

/** The caller owns the dedicated original snapshot connection; this adapter opens no transactions. */
export function createCompleteObservationSources(input: {
  readonly db: ProviderNeutralDatabase
  readonly tasks: ObservationTaskSource | ProjectionObservationTaskSource
  readonly snapshotId: string
  readonly pageSize?: number
  readonly invocationIds?: readonly string[]
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
    nativeScopes: tasks.nativeScopes,
    snapshotId,
    tasks: (actor, query) => {
      const parent = sha256Hex(
        JSON.stringify([
          actor?.user.id ?? 'original-daemon-projection',
          actor ? [...actor.permissions].sort() : null,
          query,
        ]),
      )
      return reader('tasks', parent, (after) => {
        const page = { ...query, limit: pageSize, ...(after === undefined ? {} : { after }) }
        if (actor === null) {
          if (!('projectionList' in tasks))
            throw new Error('Original projection Task capability missing')
          return tasks.projectionList(page)
        }
        return tasks.list({ actor, query: page })
      })
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
        const rows = await identityPacketPage({
          ids: input.invocationIds,
          limit: pageSize,
          read: (ids, limit) =>
            db
              .select({ id: observationInvocations.id, document: observationInvocations.document })
              .from(observationInvocations)
              .where(
                and(
                  eq(observationInvocations.taskId, taskId),
                  ids === undefined ? undefined : inArray(observationInvocations.id, [...ids]),
                  after === undefined ? undefined : gt(observationInvocations.id, after),
                ),
              )
              .orderBy(asc(observationInvocations.id))
              .limit(limit)
              .all(),
          key: (row) => row.id,
        })
        const selected = rows.slice(0, pageSize)
        return {
          items: selected.map((row) =>
            AcceptedObservationInvocationSchema.parse(JSON.parse(row.document)),
          ),
          nextCursor: rows.length > pageSize ? selected.at(-1)!.id : null,
        }
      }),
    usage: (taskId) =>
      reader('usage', taskId, async (after) => {
        if (input.invocationIds === undefined)
          return ledger.records(taskId, {
            limit: pageSize,
            ...(after === undefined ? {} : { after }),
          })
        const rows = await identityPacketPage({
          ids: input.invocationIds,
          limit: pageSize,
          read: (ids, limit) =>
            db
              .select({
                id: observationUsageCurrent.id,
                document: observationUsageCurrent.document,
              })
              .from(observationUsageCurrent)
              .where(
                and(
                  eq(observationUsageCurrent.taskId, taskId),
                  inArray(
                    jsonPathText(db, observationUsageCurrent.document, [
                      'measurement',
                      'invocationId',
                    ]),
                    [...ids!],
                  ),
                  after === undefined ? undefined : gt(observationUsageCurrent.id, after),
                ),
              )
              .orderBy(asc(observationUsageCurrent.id))
              .limit(limit)
              .all(),
          key: (row) => row.id,
        })
        return {
          items: rows
            .slice(0, pageSize)
            .map((row) => JSON.parse(row.document) as UsageLedgerRecord),
          nextCursor: rows.length > pageSize ? rows[pageSize - 1]!.id : null,
        }
      }),
    captures: (taskId) =>
      reader('captures', taskId, (after) =>
        readUsageCapturePage(
          db,
          taskId,
          {
            limit: pageSize,
            ...(after === undefined ? {} : { after }),
          },
          input.invocationIds,
        ),
      ),
    platform: (binding) =>
      reader('platform', JSON.stringify(binding), (after) =>
        readPlatformObservationPage(db, binding, {
          limit: pageSize,
          ...(after === undefined ? {} : { after }),
        }),
      ),
    platformState: (binding) => platform.state(binding),
    spans: (taskId) =>
      reader('spans', taskId, async (after) => {
        if (!tasks.spanSources) throw new Error('Complete span source is not installed')
        const page = await tasks.spanSources({
          taskId,
          carrierInvocationIds: input.invocationIds ?? [],
          allTaskCarriers: input.invocationIds === undefined,
          sourceNamespace: null,
          scopeHash: sha256Hex(JSON.stringify(['complete-spans', snapshotId, taskId])),
          after,
          limit: pageSize,
        })
        if (page.nextCursor !== null && (page.scannedSources < 1 || page.nextCursor === after))
          throw new Error('Original span source did not advance')
        return {
          items:
            page.scannedSources === 0
              ? []
              : [
                  {
                    records: page.records,
                    scannedSources: page.scannedSources,
                    watermark: page.watermark,
                    issues: page.issues,
                  },
                ],
          nextCursor: page.nextCursor,
        }
      }),
    async backlog(taskId) {
      const [state] = await tasks.sourceBacklog([taskId])
      if (!state || state.taskId !== taskId)
        throw new Error('Original Task source backlog proof missing')
      return state
    },
  }
}
