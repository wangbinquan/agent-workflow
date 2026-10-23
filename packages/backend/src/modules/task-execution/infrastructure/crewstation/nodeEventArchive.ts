// RFC-370 v3 V6 — hosted node event chunks. A prepared row names an exact
// event range; its bytes are always re-encoded from those still-present source
// rows, so nothing but facts is stored before upload. The chunk is a
// `node-event-archive` publication (key = chunk id, scope = task id); marking it
// ready, recording the object and deleting exactly the source range commit in
// one transaction. Rows of deleted tasks are released by the task object sweep.
import {
  legacyHostedEventArchiveReference,
  legacyEventArchiveChunkPath,
} from '@/platform/content/legacyEventArchive'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { and, asc, eq, gt, gte, lte } from 'drizzle-orm'
import { z } from 'zod'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { HostedObjectPublications } from '@/modules/system-operations/public/participants'
import type {
  EventsArchiveContent,
  ArchivedEventsReader,
} from '@/platform/background/eventsArchiveContent'
import type { EventsArchiveRow } from '@/platform/background/eventsArchiveStorePort'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type {
  CrewStationStreamObjectStorage,
  HostedStoredObject,
} from '@/platform/crewstation/objectStorage'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { sha256Hex } from '@/util/hash'

export const HOSTED_EVENT_ARCHIVE_OWNER = 'node-event-archive'

const EventRow = z
  .object({
    id: z.number().int().positive(),
    ts: z.number(),
    kind: z.string(),
    payload: z.string(),
    sessionId: z.string().nullable(),
    parentSessionId: z.string().nullable(),
  })
  .strict()
type Row = PersistenceTables['hostedNodeEventArchives']['$inferSelect']
const reference = legacyHostedEventArchiveReference
const objectOf = (row: Row): HostedStoredObject => {
  if (row.objectId === null) throw new Error('hosted-event-archive-not-published')
  return { id: row.objectId, sha256: row.digest, size: row.size }
}
const encode = (rows: readonly EventsArchiveRow[]) =>
  rows.map((row) => JSON.stringify(EventRow.parse(row)) + '\n').join('')
const range = (db: object, row: Pick<Row, 'nodeRunId' | 'firstId' | 'lastId'>) => {
  const { nodeRunEvents } = tablesOf(db)
  return and(
    eq(nodeRunEvents.nodeRunId, row.nodeRunId),
    gte(nodeRunEvents.id, row.firstId),
    lte(nodeRunEvents.id, row.lastId),
  )
}

export function createHostedNodeEventArchive(input: {
  readonly db: PersistenceDb
  readonly objects: Pick<CrewStationStreamObjectStorage, 'open'>
  readonly publications: HostedObjectPublications
  readonly fence: CrewStationMutationFence
}): EventsArchiveContent &
  ArchivedEventsReader & {
    files(taskId: string): Promise<readonly { path: string; object: HostedStoredObject }[]>
  } {
  const session = databaseSessionFor(input.db)
  const write = async <T>(operation: (tx: PersistenceDb) => Promise<T>) => {
    const lease = input.fence.current()
    return session.transaction(async (tx) => {
      await input.fence.assertHeld(tx, lease)
      return operation(tx)
    })
  }
  const get = async (db: PersistenceDb, id: string) => {
    const { hostedNodeEventArchives } = tablesOf(db)
    return (
      await db
        .select()
        .from(hostedNodeEventArchives)
        .where(eq(hostedNodeEventArchives.id, id))
        .limit(1)
    )[0]
  }
  const sourceRows = async (
    db: PersistenceDb,
    row: Pick<Row, 'nodeRunId' | 'firstId' | 'lastId'>,
  ) => {
    const { nodeRunEvents } = tablesOf(db)
    return (
      await db.select().from(nodeRunEvents).where(range(db, row)).orderBy(asc(nodeRunEvents.id))
    ).map((event) => ({
      id: event.id,
      ts: event.ts,
      kind: event.kind,
      payload: event.payload,
      sessionId: event.sessionId,
      parentSessionId: event.parentSessionId,
    }))
  }
  const finish = async (row: Row) => {
    if (row.state === 'ready') return { file: reference(row.id), archived: 0 }
    const encoded = encode(await sourceRows(input.db, row))
    if (Buffer.byteLength(encoded) !== row.size || sha256Hex(encoded) !== row.digest)
      throw new Error('hosted-event-archive-source-changed')
    let archived = 0
    await input.publications.publish(
      [
        {
          owner: HOSTED_EVENT_ARCHIVE_OWNER,
          key: row.id,
          scope: row.taskId,
          bytes: Buffer.from(encoded),
        },
      ],
      {
        async commit(tx, [object]) {
          const { nodeRuns, hostedNodeEventArchives, nodeRunEvents } = tablesOf(tx)
          await session.engine.lockAggregateRoot(tx, nodeRuns, nodeRuns.id, row.nodeRunId)
          const owner = (
            await tx
              .select({ taskId: nodeRuns.taskId })
              .from(nodeRuns)
              .where(eq(nodeRuns.id, row.nodeRunId))
              .limit(1)
          )[0]
          // A deleted run keeps no reference: the publication stays an orphan
          // for maintenance, and the task object sweep removes this row.
          if (owner === undefined) throw new Error('hosted-event-archive-owner-missing')
          if (owner.taskId !== row.taskId) throw new Error('hosted-event-archive-owner-mismatch')
          const current = await get(tx, row.id)
          if (current === undefined || current.digest !== row.digest)
            throw new Error('hosted-event-archive-intent-missing')
          if (current.state === 'ready') return
          const actual = await sourceRows(tx, row)
          if (encode(actual) !== encoded) throw new Error('hosted-event-archive-source-changed')
          await tx
            .update(hostedNodeEventArchives)
            .set({ state: 'ready', objectId: object!.id })
            .where(eq(hostedNodeEventArchives.id, row.id))
          await tx.delete(nodeRunEvents).where(range(tx, row))
          archived = actual.length
        },
      },
    )
    return { file: reference(row.id), archived }
  }
  return {
    async recover() {
      const { hostedNodeEventArchives, nodeRuns } = tablesOf(input.db)
      // Rows of a deleted run are the task object sweep's to remove; they must
      // not starve the prepared chunks of live runs.
      const row = (
        await input.db
          .select({ archive: hostedNodeEventArchives })
          .from(hostedNodeEventArchives)
          .innerJoin(nodeRuns, eq(nodeRuns.id, hostedNodeEventArchives.nodeRunId))
          .where(eq(hostedNodeEventArchives.state, 'prepared'))
          .orderBy(asc(hostedNodeEventArchives.createdAt))
          .limit(1)
      )[0]
      return row === undefined ? { file: null, archived: 0 } : finish(row.archive)
    },
    async archive(request) {
      if (request.rows.length === 0) throw new Error('hosted-event-archive-empty')
      // Bound normal chunks by bytes as well as rows. A single existing event
      // remains indivisible; do not silently drop it when its payload is large.
      const rows: EventsArchiveRow[] = []
      let length = 0
      for (const value of request.rows) {
        const row = EventRow.parse(value)
        const size = Buffer.byteLength(encode([row]))
        if (rows.length > 0 && length + size > 4 * 1024 * 1024) break
        if (rows.length > 0 && row.id <= rows.at(-1)!.id)
          throw new Error('hosted-event-archive-order-invalid')
        rows.push(row)
        length += size
      }
      const encoded = encode(rows),
        digest = sha256Hex(encoded)
      const candidate: Row = {
        id: sha256Hex(
          JSON.stringify([request.taskId, request.nodeRunId, rows[0]!.id, rows.at(-1)!.id, digest]),
        ),
        taskId: request.taskId,
        nodeRunId: request.nodeRunId,
        firstId: rows[0]!.id,
        lastId: rows.at(-1)!.id,
        rowCount: rows.length,
        size: length,
        digest,
        state: 'prepared',
        objectId: null,
        createdAt: Date.now(),
      }
      const prepared = await write(async (tx) => {
        const { nodeRuns, hostedNodeEventArchives } = tablesOf(tx)
        await session.engine.lockAggregateRoot(tx, nodeRuns, nodeRuns.id, request.nodeRunId)
        const owner = (
          await tx
            .select({ taskId: nodeRuns.taskId })
            .from(nodeRuns)
            .where(eq(nodeRuns.id, request.nodeRunId))
            .limit(1)
        )[0]
        if (owner?.taskId !== request.taskId) throw new Error('hosted-event-archive-owner-mismatch')
        const prior = await get(tx, candidate.id)
        if (prior !== undefined) return prior
        const overlapping = await tx
          .select({ id: hostedNodeEventArchives.id })
          .from(hostedNodeEventArchives)
          .where(
            and(
              eq(hostedNodeEventArchives.nodeRunId, request.nodeRunId),
              lte(hostedNodeEventArchives.firstId, candidate.lastId),
              gte(hostedNodeEventArchives.lastId, candidate.firstId),
            ),
          )
          .limit(1)
        if (overlapping.length > 0) throw new Error('hosted-event-archive-pending-range')
        if (encode(await sourceRows(tx, candidate)) !== encoded)
          throw new Error('hosted-event-archive-source-changed')
        await insertOne(tx, hostedNodeEventArchives, candidate)
        return candidate
      })
      return finish(prepared)
    },
    async read(taskId, nodeRunId, since, limit) {
      if (!Number.isSafeInteger(since) || since < 0 || !Number.isSafeInteger(limit) || limit < 0)
        throw new Error('hosted-event-archive-page-invalid')
      if (limit === 0) return []
      const out: EventsArchiveRow[] = []
      let after = since
      while (out.length < limit) {
        const { hostedNodeEventArchives } = tablesOf(input.db)
        const chunks = await input.db
          .select()
          .from(hostedNodeEventArchives)
          .where(
            and(
              eq(hostedNodeEventArchives.taskId, taskId),
              eq(hostedNodeEventArchives.nodeRunId, nodeRunId),
              eq(hostedNodeEventArchives.state, 'ready'),
              gt(hostedNodeEventArchives.lastId, after),
            ),
          )
          .orderBy(asc(hostedNodeEventArchives.firstId))
          .limit(16)
        if (chunks.length === 0) break
        for (const chunk of chunks) {
          const bytes = await new Response(await input.objects.open(objectOf(chunk))).text()
          if (Buffer.byteLength(bytes) !== chunk.size || sha256Hex(bytes) !== chunk.digest)
            throw new Error('hosted-event-archive-content-corrupt')
          const rows = bytes
            .trimEnd()
            .split('\n')
            .map((line) => EventRow.parse(JSON.parse(line)))
          if (
            rows.length !== chunk.rowCount ||
            rows[0]?.id !== chunk.firstId ||
            rows.at(-1)?.id !== chunk.lastId ||
            rows.some((row, i) => i > 0 && row.id <= rows[i - 1]!.id)
          )
            throw new Error('hosted-event-archive-index-corrupt')
          for (const row of rows) if (row.id > since && out.length < limit) out.push(row)
          after = chunk.lastId
          if (out.length >= limit) break
        }
      }
      return out
    },
    async files(taskId) {
      const { hostedNodeEventArchives } = tablesOf(input.db)
      const pending = await input.db
        .select({ id: hostedNodeEventArchives.id })
        .from(hostedNodeEventArchives)
        .where(
          and(
            eq(hostedNodeEventArchives.taskId, taskId),
            eq(hostedNodeEventArchives.state, 'prepared'),
          ),
        )
        .limit(1)
      if (pending.length > 0) throw new Error('hosted-event-archive-pending')
      return (
        await input.db
          .select()
          .from(hostedNodeEventArchives)
          .where(
            and(
              eq(hostedNodeEventArchives.taskId, taskId),
              eq(hostedNodeEventArchives.state, 'ready'),
            ),
          )
          .orderBy(asc(hostedNodeEventArchives.firstId))
      ).map((row) => ({
        path: legacyEventArchiveChunkPath(row.nodeRunId, row.firstId, row.lastId),
        object: objectOf(row),
      }))
    },
  }
}
