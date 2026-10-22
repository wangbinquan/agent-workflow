// RFC-370 v3 V6 — the one platform-neutral hosted object publication journal.
//
// State machine of one (owner, key):
//   pending ──upload/link──▶ ready ──owner release──▶ releasing ──unpin──▶ released
//      │                                                  ▲
//      └── abandoned (older epoch / stale) ── resolve ────┘ (or straight to released
//                                                            when no bytes ever arrived)
// A pending publication never has an owner reference: owners commit theirs in
// the transaction that marks the publication ready. Abandoned pending rows are
// therefore orphans; maintenance replays the stable upload request without
// bytes to learn whether an object (and so a pin) exists, then releases it.
// Owner-released objects are unpinned only behind the backup release horizon.
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  lte,
  min,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type { CrewStationStreamObjectStorage } from '@/platform/crewstation/objectStorage'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { sha256Hex } from '@/util/hash'
import { createLogger } from '@/util/log'
import type {
  HostedBackupReleaseHorizon,
  HostedObjectContent,
  HostedObjectOwnerSweep,
  HostedObjectPublicationMaintenance,
  HostedObjectPublicationRequest,
  HostedObjectPublications,
  HostedObjectReceipt,
  HostedObjectReleaseSelection,
} from './objectPublicationContract'

type Row = PersistenceTables['hostedObjectPublications']['$inferSelect']
type Lease = ReturnType<CrewStationMutationFence['current']>

const OWNER = /^[a-z][a-z0-9-]{0,63}$/
const ATTEMPT = /^[A-Za-z0-9_.:-]{1,128}$/
const DIGEST = /^[a-f0-9]{64}$/
const OBJECT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const SQL_CHUNK = 500
/** Bytes sealed into the journal stay small; large sources are reopened by owners. */
export const HOSTED_RECOVERABLE_SOURCE_MAX_BYTES = 4 * 1024 * 1024
/** Twice the object client's 30 minute upload deadline: no live writer of the
 * same execution epoch can still be completing an upload after this. */
export const HOSTED_PUBLICATION_ABANDON_MS = 60 * 60_000
export const HOSTED_PUBLICATION_RETENTION_MS = 7 * 86_400_000
const HORIZON_RECHECK_MS = 60 * 60_000
const IN_FLIGHT_RECHECK_MS = 10 * 60_000

export class HostedObjectPublicationError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'HostedObjectPublicationError'
  }
}

// Identities hash an unambiguous tuple encoding: a separator byte inside an
// owner-chosen key could otherwise make two different (owner, key) pairs equal.
export const hostedPublicationId = (owner: string, key: string): string =>
  sha256Hex(JSON.stringify([owner, key]))

/** The CS application owner of exactly one publication lifetime. */
export const hostedPublicationPin = (row: Pick<Row, 'owner' | 'logicalKey' | 'attempt'>): string =>
  `aw-publication:${sha256Hex(JSON.stringify([row.owner, row.logicalKey, row.attempt]))}`

const receiptOf = (row: Row): HostedObjectReceipt => {
  if (row.objectId === null)
    throw new HostedObjectPublicationError('hosted-object-publication-not-ready')
  return { id: row.objectId, sha256: row.sha256, size: row.size }
}

/** Exact, case-sensitive prefix on both engines (`LIKE` folds ASCII case on
 * SQLite only); `substr` counts characters, so the length is in code points. */
function keyPrefixMatch(column: SQLWrapper, prefix: string): SQL {
  return sql`substr(${column}, 1, ${[...prefix].length}) = ${prefix}`
}

async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      await run(items[index]!, index)
    }
  })
  await Promise.all(workers)
}

interface Sealer {
  seal(plaintext: string): string
  unseal(packed: string): string
}

interface Bound {
  readonly request: HostedObjectPublicationRequest
  readonly row: Row
}

export function createHostedObjectPublications(input: {
  readonly db: PersistenceDb
  readonly fence: CrewStationMutationFence
  readonly objects: Pick<
    CrewStationStreamObjectStorage,
    'putStream' | 'resolve' | 'retain' | 'release'
  >
  /** Required only by owners that publish `recoverable` bytes. */
  readonly sealer?: Sealer
  readonly now?: () => number
  readonly randomAttempt?: () => string
  readonly abandonAfterMs?: number
  readonly retentionMs?: number
}) {
  const session = databaseSessionFor(input.db)
  const now = input.now ?? Date.now
  const randomAttempt = input.randomAttempt ?? (() => crypto.randomUUID())
  const abandonAfter = input.abandonAfterMs ?? HOSTED_PUBLICATION_ABANDON_MS
  const retention = input.retentionMs ?? HOSTED_PUBLICATION_RETENTION_MS
  const log = createLogger('hosted-object-publications')
  const write = <T>(run: (tx: PersistenceDb) => Promise<T>): Promise<T> => {
    const lease = input.fence.current()
    return session.transaction(async (tx) => {
      await input.fence.assertHeld(tx, lease)
      return run(tx)
    })
  }
  const read = async (tx: PersistenceDb, id: string) => {
    const { hostedObjectPublications } = tablesOf(tx)
    return (
      await tx
        .select()
        .from(hostedObjectPublications)
        .where(eq(hostedObjectPublications.id, id))
        .limit(1)
    )[0]
  }
  const lock = async (tx: PersistenceDb, id: string) => {
    const { hostedObjectPublications } = tablesOf(tx)
    await session.engine.lockAggregateRoot(
      tx,
      hostedObjectPublications,
      hostedObjectPublications.id,
      id,
    )
    return read(tx, id)
  }
  const factsOf = (request: HostedObjectPublicationRequest) =>
    request.object !== undefined
      ? { sha256: request.object.sha256, size: request.object.size }
      : request.content !== undefined
        ? { sha256: request.content.sha256, size: request.content.size }
        : { sha256: sha256Hex(request.bytes), size: request.bytes.byteLength }
  const validate = (request: HostedObjectPublicationRequest) => {
    if (!OWNER.test(request.owner))
      throw new HostedObjectPublicationError('hosted-object-publication-owner-invalid')
    if (request.key.length === 0 || request.key.length > 1024 || request.key.includes('\0'))
      throw new HostedObjectPublicationError('hosted-object-publication-key-invalid')
    if (
      request.scope !== undefined &&
      request.scope !== null &&
      (request.scope.length === 0 || request.scope.length > 512 || request.scope.includes('\0'))
    )
      throw new HostedObjectPublicationError('hosted-object-publication-scope-invalid')
    if (request.attempt !== undefined && !ATTEMPT.test(request.attempt))
      throw new HostedObjectPublicationError('hosted-object-publication-attempt-invalid')
    const facts = factsOf(request)
    if (!DIGEST.test(facts.sha256) || !Number.isSafeInteger(facts.size) || facts.size < 0)
      throw new HostedObjectPublicationError('hosted-object-publication-facts-invalid')
    if (request.object !== undefined && !OBJECT_ID.test(request.object.id))
      throw new HostedObjectPublicationError('hosted-object-publication-facts-invalid')
    if (request.bytes !== undefined && request.recoverable === true) {
      if (input.sealer === undefined)
        throw new HostedObjectPublicationError('hosted-object-publication-sealer-unavailable')
      if (request.bytes.byteLength > HOSTED_RECOVERABLE_SOURCE_MAX_BYTES)
        throw new HostedObjectPublicationError('hosted-object-publication-source-too-large')
    }
    return facts
  }
  const sealedOf = (request: HostedObjectPublicationRequest): string | null =>
    request.bytes !== undefined && request.recoverable === true
      ? input.sealer!.seal(Buffer.from(request.bytes).toString('base64'))
      : null
  const sameFacts = (row: Row, request: HostedObjectPublicationRequest) => {
    const facts = factsOf(request)
    if (row.sha256 !== facts.sha256 || row.size !== facts.size)
      throw new HostedObjectPublicationError('hosted-object-publication-content-changed')
    if (request.object !== undefined && row.objectId !== null && row.objectId !== request.object.id)
      throw new HostedObjectPublicationError('hosted-object-publication-content-changed')
    if ((request.scope ?? null) !== row.scope)
      throw new HostedObjectPublicationError('hosted-object-publication-scope-changed')
  }
  const bindOne = async (
    tx: PersistenceDb,
    request: HostedObjectPublicationRequest,
    lease: Lease,
  ): Promise<Row> => {
    const facts = factsOf(request)
    const id = hostedPublicationId(request.owner, request.key)
    const at = now()
    const fresh = {
      id,
      owner: request.owner,
      logicalKey: request.key,
      scope: request.scope ?? null,
      attempt: request.attempt ?? randomAttempt(),
      state: 'pending' as const,
      sha256: facts.sha256,
      size: facts.size,
      objectId: request.object?.id ?? null,
      epoch: lease.epoch,
      sourceSealed: sealedOf(request),
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: at,
      releasedAt: null,
      updatedAt: at,
    }
    const { hostedObjectPublications } = tablesOf(tx)
    await tx.insert(hostedObjectPublications).values(fresh).onConflictDoNothing()
    const row = await lock(tx, id)
    if (row === undefined)
      throw new HostedObjectPublicationError('hosted-object-publication-missing')
    if (row.attempt === fresh.attempt && row.createdAt === at && row.state === 'pending') return row
    if (row.owner !== request.owner || row.logicalKey !== request.key)
      throw new HostedObjectPublicationError('hosted-object-publication-identity-collision')
    switch (row.state) {
      case 'ready':
        sameFacts(row, request)
        return row
      case 'pending': {
        sameFacts(row, request)
        if (request.attempt !== undefined && request.attempt !== row.attempt)
          throw new HostedObjectPublicationError('hosted-object-publication-attempt-changed')
        const updated = {
          epoch: lease.epoch,
          nextAttemptAt: 0,
          updatedAt: at,
          ...(row.objectId === null && request.object !== undefined
            ? { objectId: request.object.id }
            : {}),
          ...(row.sourceSealed === null && fresh.sourceSealed !== null
            ? { sourceSealed: fresh.sourceSealed }
            : {}),
        }
        await tx
          .update(hostedObjectPublications)
          .set(updated)
          .where(eq(hostedObjectPublications.id, id))
        return { ...row, ...updated }
      }
      case 'releasing':
        throw new HostedObjectPublicationError('hosted-object-publication-releasing')
      case 'released': {
        // A settled lifetime never reactivates its CS reference; a new lifetime
        // pins under a new owner identity.
        if (request.attempt !== undefined && request.attempt === row.attempt)
          throw new HostedObjectPublicationError('hosted-object-publication-retired')
        const revived = { ...fresh, attempt: request.attempt ?? randomAttempt() }
        await tx
          .update(hostedObjectPublications)
          .set(revived)
          .where(eq(hostedObjectPublications.id, id))
        return revived
      }
    }
  }
  const transfer = async (bound: Bound): Promise<HostedObjectReceipt> => {
    const { row, request } = bound
    if (row.state === 'ready') return receiptOf(row)
    const pin = hostedPublicationPin(row)
    if (request.object !== undefined) {
      await input.objects.retain(pin, request.object)
      return { id: request.object.id, sha256: request.object.sha256, size: request.object.size }
    }
    const bytes = request.bytes
    const content: HostedObjectContent =
      request.content ??
      ({
        sha256: row.sha256,
        size: row.size,
        open: () => new Blob([Uint8Array.from(bytes!)]).stream(),
      } satisfies HostedObjectContent)
    const object = await input.objects.putStream(pin, content, { attempt: row.attempt })
    if (object.sha256 !== row.sha256 || object.size !== row.size)
      throw new HostedObjectPublicationError('hosted-object-publication-receipt-mismatch')
    return { id: object.id, sha256: object.sha256, size: object.size }
  }
  const markReady = async (tx: PersistenceDb, bound: Bound, receipt: HostedObjectReceipt) => {
    const current = await lock(tx, bound.row.id)
    if (current === undefined || current.attempt !== bound.row.attempt)
      throw new HostedObjectPublicationError('hosted-object-publication-superseded')
    if (current.state === 'ready') {
      if (current.objectId !== receipt.id)
        throw new HostedObjectPublicationError('hosted-object-publication-receipt-changed')
      return
    }
    if (current.state !== 'pending')
      throw new HostedObjectPublicationError('hosted-object-publication-retired')
    const { hostedObjectPublications } = tablesOf(tx)
    await tx
      .update(hostedObjectPublications)
      .set({ state: 'ready', objectId: receipt.id, sourceSealed: null, updatedAt: now() })
      .where(eq(hostedObjectPublications.id, bound.row.id))
  }

  const publications: HostedObjectPublications = {
    async publish(requests, options = {}) {
      const identities = new Set<string>()
      for (const request of requests) {
        validate(request)
        const id = hostedPublicationId(request.owner, request.key)
        if (identities.has(id))
          throw new HostedObjectPublicationError('hosted-object-publication-duplicate')
        identities.add(id)
      }
      if (requests.length === 0) {
        if (options.commit) await write((tx) => options.commit!(tx, []))
        return []
      }
      // One registration transaction for the whole batch: no per-item rewrite.
      const bound = await write(async (tx) => {
        const lease = input.fence.current()
        const rows: Bound[] = []
        for (const request of requests)
          rows.push({ request, row: await bindOne(tx, request, lease) })
        return rows
      })
      const receipts: HostedObjectReceipt[] = new Array(bound.length)
      await eachLimited(bound, options.concurrency ?? 1, async (entry, index) => {
        receipts[index] = await transfer(entry)
      })
      await write(async (tx) => {
        for (let index = 0; index < bound.length; index++)
          await markReady(tx, bound[index]!, receipts[index]!)
        await options.commit?.(tx, receipts)
      })
      return receipts
    },
    async find(owner, key) {
      const row = await read(input.db, hostedPublicationId(owner, key))
      return row?.state === 'ready' ? receiptOf(row) : null
    },
    async release(selection: HostedObjectReleaseSelection, tx?: PersistenceDb) {
      if (!OWNER.test(selection.owner))
        throw new HostedObjectPublicationError('hosted-object-publication-owner-invalid')
      if (
        selection.keys === undefined &&
        selection.scope === undefined &&
        selection.keyPrefix === undefined
      )
        throw new HostedObjectPublicationError('hosted-object-publication-selection-empty')
      const run = async (handle: PersistenceDb) => {
        const at = now()
        const { hostedObjectPublications } = tablesOf(handle)
        const live = and(
          eq(hostedObjectPublications.owner, selection.owner),
          inArray(hostedObjectPublications.state, ['pending', 'ready']),
          selection.scope === undefined
            ? undefined
            : eq(hostedObjectPublications.scope, selection.scope),
          selection.keyPrefix === undefined
            ? undefined
            : keyPrefixMatch(hostedObjectPublications.logicalKey, selection.keyPrefix),
        )
        const release = {
          state: 'releasing' as const,
          releasedAt: at,
          updatedAt: at,
          nextAttemptAt: 0,
          attempts: 0,
          sourceSealed: null,
        }
        if (selection.keys === undefined) {
          const rows = await handle
            .update(hostedObjectPublications)
            .set(release)
            .where(live)
            .returning({ id: hostedObjectPublications.id })
          return rows.length
        }
        let count = 0
        for (let offset = 0; offset < selection.keys.length; offset += SQL_CHUNK) {
          const ids = selection.keys
            .slice(offset, offset + SQL_CHUNK)
            .map((key) => hostedPublicationId(selection.owner, key))
          const rows = await handle
            .update(hostedObjectPublications)
            .set(release)
            .where(and(live, inArray(hostedObjectPublications.id, ids)))
            .returning({ id: hostedObjectPublications.id })
          count += rows.length
        }
        return count
      }
      if (tx === undefined) return write(run)
      await input.fence.assertHeld(tx, input.fence.current())
      return run(tx)
    },
    async scopes(owner, page) {
      const { hostedObjectPublications } = tablesOf(input.db)
      const rows = await input.db
        .select({ scope: hostedObjectPublications.scope })
        .from(hostedObjectPublications)
        .where(
          and(
            eq(hostedObjectPublications.owner, owner),
            inArray(hostedObjectPublications.state, ['pending', 'ready']),
            sql`${hostedObjectPublications.scope} IS NOT NULL`,
            page.after === undefined ? undefined : gt(hostedObjectPublications.scope, page.after),
          ),
        )
        .groupBy(hostedObjectPublications.scope)
        .having(lte(min(hostedObjectPublications.createdAt), page.before))
        .orderBy(asc(hostedObjectPublications.scope))
        .limit(page.limit)
      return rows.flatMap((row) => (row.scope === null ? [] : [row.scope]))
    },
  }

  const backoff = async (row: Row, error: unknown) => {
    log.warn('hosted object publication settlement deferred', {
      owner: row.owner,
      state: row.state,
      error: error instanceof Error ? error.message : String(error),
    })
    await write(async (tx) => {
      const { hostedObjectPublications } = tablesOf(tx)
      await tx
        .update(hostedObjectPublications)
        .set({
          attempts: row.attempts + 1,
          nextAttemptAt: now() + Math.min(60_000 * 2 ** Math.min(row.attempts, 6), 60 * 60_000),
          updatedAt: now(),
        })
        .where(
          and(
            eq(hostedObjectPublications.id, row.id),
            eq(hostedObjectPublications.attempt, row.attempt),
            eq(hostedObjectPublications.state, row.state),
          ),
        )
    }).catch(() => undefined)
  }
  /** Moves `row` from `from` to the next state only if nothing changed meanwhile. */
  const advance = (row: Row, from: Row['state'], values: Partial<Row>) =>
    write(async (tx) => {
      const current = await lock(tx, row.id)
      if (current?.attempt !== row.attempt || current.state !== from) return false
      const { hostedObjectPublications } = tablesOf(tx)
      await tx
        .update(hostedObjectPublications)
        .set({ ...values, updatedAt: now() })
        .where(eq(hostedObjectPublications.id, row.id))
      return true
    })
  const unseal = (row: Row): Uint8Array => {
    if (input.sealer === undefined)
      throw new HostedObjectPublicationError('hosted-object-publication-sealer-unavailable')
    const bytes = Buffer.from(input.sealer.unseal(row.sourceSealed!), 'base64')
    if (bytes.byteLength !== row.size || sha256Hex(bytes) !== row.sha256)
      throw new HostedObjectPublicationError('hosted-object-publication-source-corrupt')
    return bytes
  }
  const settleAbandoned = async (row: Row): Promise<'completed' | 'released' | 'releasing'> => {
    const pin = hostedPublicationPin(row)
    if (row.sourceSealed !== null) {
      const bytes = unseal(row)
      const object = await input.objects.putStream(
        pin,
        {
          sha256: row.sha256,
          size: row.size,
          open: () => new Blob([Uint8Array.from(bytes)]).stream(),
        },
        { attempt: row.attempt },
      )
      await advance(row, 'pending', { state: 'ready', objectId: object.id, sourceSealed: null })
      return 'completed'
    }
    if (row.objectId !== null) {
      await advance(row, 'pending', {
        state: 'releasing',
        releasedAt: now(),
        attempts: 0,
        nextAttemptAt: 0,
      })
      return 'releasing'
    }
    const object = await input.objects.resolve(pin, row, { attempt: row.attempt })
    if (object === null) {
      await advance(row, 'pending', { state: 'released', releasedAt: now(), attempts: 0 })
      return 'released'
    }
    await advance(row, 'pending', {
      state: 'releasing',
      objectId: object.id,
      releasedAt: now(),
      attempts: 0,
      nextAttemptAt: 0,
    })
    return 'releasing'
  }
  const settleReleasing = async (
    row: Row,
    horizon: HostedBackupReleaseHorizon,
  ): Promise<'released' | 'protected' | 'deferred'> => {
    let current = row
    const pin = hostedPublicationPin(row)
    if (current.objectId === null) {
      // Released while its upload may still be completing in a live writer.
      if (
        current.epoch >= input.fence.current().epoch &&
        current.updatedAt > now() - abandonAfter
      ) {
        await advance(current, 'releasing', { nextAttemptAt: now() + IN_FLIGHT_RECHECK_MS })
        return 'deferred'
      }
      const object = await input.objects.resolve(pin, current, { attempt: current.attempt })
      if (object === null) {
        await advance(current, 'releasing', { state: 'released' })
        return 'released'
      }
      if (!(await advance(current, 'releasing', { objectId: object.id }))) return 'deferred'
      current = { ...current, objectId: object.id }
    }
    if (await horizon.protects({ createdAt: current.createdAt, releasedAt: current.releasedAt! })) {
      await advance(current, 'releasing', { nextAttemptAt: now() + HORIZON_RECHECK_MS })
      return 'protected'
    }
    await input.objects.release(pin, receiptOf(current))
    await advance(current, 'releasing', { state: 'released' })
    return 'released'
  }

  return {
    publications,
    /** Settlement entry for the single maintenance job; also used by tests. */
    maintenance(options: {
      readonly horizon: HostedBackupReleaseHorizon
      readonly sweeps?: readonly HostedObjectOwnerSweep[]
      readonly batch?: number
    }): HostedObjectPublicationMaintenance {
      const batch = options.batch ?? 100
      return {
        async run() {
          const counters = {
            swept: 0,
            sweepFailures: 0,
            completed: 0,
            resolved: 0,
            released: 0,
            protected: 0,
            deferred: 0,
            failures: 0,
            purged: 0,
          }
          for (const sweep of options.sweeps ?? []) {
            try {
              counters.swept += await sweep.sweep({ now: now() })
            } catch (error) {
              counters.sweepFailures++
              log.warn('hosted object owner sweep failed', {
                sweep: sweep.name,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }
          const lease = input.fence.current()
          const { hostedObjectPublications } = tablesOf(input.db)
          const abandoned = await input.db
            .select()
            .from(hostedObjectPublications)
            .where(
              and(
                eq(hostedObjectPublications.state, 'pending'),
                lte(hostedObjectPublications.nextAttemptAt, now()),
                or(
                  sql`${hostedObjectPublications.epoch} < ${lease.epoch}`,
                  lte(hostedObjectPublications.updatedAt, now() - abandonAfter),
                ),
              ),
            )
            .orderBy(asc(hostedObjectPublications.updatedAt), asc(hostedObjectPublications.id))
            .limit(batch)
          for (const row of abandoned) {
            try {
              const outcome = await settleAbandoned(row)
              if (outcome === 'completed') counters.completed++
              else counters.resolved++
            } catch (error) {
              counters.failures++
              await backoff(row, error)
            }
          }
          const releasing = await input.db
            .select()
            .from(hostedObjectPublications)
            .where(
              and(
                eq(hostedObjectPublications.state, 'releasing'),
                lte(hostedObjectPublications.nextAttemptAt, now()),
              ),
            )
            .orderBy(asc(hostedObjectPublications.releasedAt), asc(hostedObjectPublications.id))
            .limit(batch)
          for (const row of releasing) {
            try {
              counters[await settleReleasing(row, options.horizon)]++
            } catch (error) {
              counters.failures++
              await backoff(row, error)
            }
          }
          const settled = await input.db
            .select({ id: hostedObjectPublications.id })
            .from(hostedObjectPublications)
            .where(
              and(
                eq(hostedObjectPublications.state, 'released'),
                lte(hostedObjectPublications.updatedAt, now() - retention),
              ),
            )
            .limit(SQL_CHUNK)
          if (settled.length > 0)
            counters.purged = await write(async (tx) => {
              const { hostedObjectPublications } = tablesOf(tx)
              const rows = await tx
                .delete(hostedObjectPublications)
                .where(
                  and(
                    inArray(
                      hostedObjectPublications.id,
                      settled.map((row) => row.id),
                    ),
                    eq(hostedObjectPublications.state, 'released'),
                  ),
                )
                .returning({ id: hostedObjectPublications.id })
              return rows.length
            })
          return counters
        },
      }
    },
  }
}

export type HostedObjectPublicationJournal = ReturnType<typeof createHostedObjectPublications>

/** Restore normalization only: a backup's own archive was published after its
 * snapshot, so the restored journal re-adopts that exact deterministic pin. */
export async function adoptHostedPublicationInTx(
  tx: PersistenceDb,
  input: {
    readonly owner: string
    readonly key: string
    readonly attempt: string
    readonly object: HostedObjectReceipt
    readonly createdAt: number
    readonly now: number
  },
): Promise<void> {
  const id = hostedPublicationId(input.owner, input.key)
  const values = {
    owner: input.owner,
    logicalKey: input.key,
    scope: null,
    attempt: input.attempt,
    state: 'ready' as const,
    sha256: input.object.sha256,
    size: input.object.size,
    objectId: input.object.id,
    epoch: 0,
    sourceSealed: null,
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: input.createdAt,
    releasedAt: null,
    updatedAt: input.now,
  }
  const { hostedObjectPublications } = tablesOf(tx)
  await tx
    .insert(hostedObjectPublications)
    .values({ id, ...values })
    .onConflictDoUpdate({ target: hostedObjectPublications.id, set: values })
}
