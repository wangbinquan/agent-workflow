import { and, asc, eq, gt, inArray, lte, min, sql } from 'drizzle-orm'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { ContentRef } from '../contentRef'
import { hostedObjectReferenceOwner, parseHostedObject } from '../locations/hostedObject'
import {
  contentRefColumns,
  contentStorageKind,
  type ContentPublication,
  type ContentPublicationFence,
  type ContentPublicationIdentity,
  type ContentPublicationLedger,
  type ContentSource,
  type ContentStoragePolicy,
  type ContentStore,
} from '../contentStore'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { createSha256DigestBuilder, sha256Hex } from '@/util/hash'
import type {
  CrewStationStreamObjectStorage,
  HostedStoredObject,
} from '@/platform/crewstation/objectStorage'

type PublicationRow = PersistenceTables['contentPublications']['$inferSelect']
type ExternalRef = Exclude<ContentRef, { kind: 'inline' }>

function objectIdOf(ref: ExternalRef): string | null {
  if (ref.kind !== 'object') return null
  const { codec, value } = ref.location
  if (codec === 'hosted-object-id' && typeof value === 'string') return value
  if (
    codec === 'review-object' &&
    value !== null &&
    typeof value === 'object' &&
    'objectId' in value &&
    typeof value.objectId === 'string'
  )
    return value.objectId
  if (codec === 'aw-object:v2' && typeof value === 'string') {
    const owner = hostedObjectReferenceOwner(value)
    if (owner !== null) return parseHostedObject(owner, value).id
  }
  return null
}

/** Migrated references retain their original location spelling and media type;
 * the shared catalog normalizes locations and may have no common media type. */
function sameContentObject(catalog: ExternalRef, ref: ExternalRef): boolean {
  return (
    catalog.contentId === ref.contentId &&
    catalog.kind === ref.kind &&
    (ref.contentVersion === null || catalog.contentVersion === ref.contentVersion) &&
    (ref.sha256 === null || catalog.sha256 === ref.sha256) &&
    (ref.size === null || catalog.size === ref.size) &&
    (canonicalSchemaJson(catalog.location) === canonicalSchemaJson(ref.location) ||
      (objectIdOf(catalog) !== null && objectIdOf(catalog) === objectIdOf(ref)))
  )
}

export const CONTENT_INLINE_MAX_BYTES = 64 * 1024
export const databaseContentPolicy: ContentStoragePolicy = Object.freeze({
  inlineMaxBytes: CONTENT_INLINE_MAX_BYTES,
  externalKind: 'database-bytes',
})

export const contentPublicationId = (identity: ContentPublicationIdentity): string =>
  sha256Hex(JSON.stringify([identity.owner, identity.logicalKey]))

function publicationOf(row: PublicationRow): ContentPublication {
  if (
    (row.state === 'ready' && (row.contentId === null || row.sourceSealed !== null)) ||
    ((row.state === 'pending' || row.state === 'ready') && row.releasedAt !== null) ||
    ((row.state === 'releasing' || row.state === 'released') &&
      (row.releasedAt === null || row.sourceSealed !== null))
  )
    throw new Error('content-publication-shape-invalid')
  return row as ContentPublication
}

async function publicationRow(
  tx: PersistenceTx,
  identity: ContentPublicationIdentity,
  lock = false,
): Promise<PublicationRow | undefined> {
  const { contentPublications } = tablesOf(tx)
  const id = contentPublicationId(identity)
  if (lock)
    await engineOf(tx).lockAggregateRoot(tx, contentPublications, contentPublications.id, id)
  return (
    await tx.select().from(contentPublications).where(eq(contentPublications.id, id)).limit(1)
  )[0]
}

function assertFence(row: PublicationRow | undefined, fence: ContentPublicationFence) {
  if (
    row === undefined ||
    row.owner !== fence.owner ||
    row.logicalKey !== fence.logicalKey ||
    row.attempt !== fence.attempt ||
    row.epoch !== fence.epoch
  )
    throw new Error('content-publication-stale-attempt')
  return row
}

/** Both native providers use the same lifetime ledger and transaction boundaries. */
export function createContentPublicationLedger(db: PersistenceDb): ContentPublicationLedger {
  return {
    async find(identity) {
      const row = await publicationRow(db, identity)
      return row === undefined ? null : publicationOf(row)
    },
    async keysForContent(tx, selection) {
      if (selection.contentIds.length === 0) return []
      const { contentPublications } = tablesOf(tx)
      const rows = await tx
        .select({ key: contentPublications.logicalKey })
        .from(contentPublications)
        .where(
          and(
            eq(contentPublications.owner, selection.owner),
            eq(contentPublications.scope, selection.scope),
            inArray(contentPublications.contentId, [...selection.contentIds]),
          ),
        )
      return rows.map((row) => row.key)
    },
    async begin(tx, input) {
      if (
        !input.owner ||
        !input.logicalKey ||
        !input.attempt ||
        !Number.isSafeInteger(input.epoch) ||
        input.epoch < 0 ||
        !/^[a-f0-9]{64}$/.test(input.sha256) ||
        !Number.isSafeInteger(input.size) ||
        input.size < 0
      )
        throw new Error('content-publication-facts-invalid')
      const { contentPublications } = tablesOf(tx)
      const fresh = {
        id: contentPublicationId(input),
        owner: input.owner,
        logicalKey: input.logicalKey,
        scope: input.scope,
        attempt: input.attempt,
        epoch: input.epoch,
        sha256: input.sha256,
        size: input.size,
        state: 'pending' as const,
        contentId: null,
        sourceSealed: input.sourceSealed,
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: input.now,
        updatedAt: input.now,
        releasedAt: null,
      }
      await tx.insert(contentPublications).values(fresh).onConflictDoNothing()
      const row = await publicationRow(tx, input, true)
      if (row?.state === 'released' && row.attempt !== input.attempt && row.epoch <= input.epoch) {
        await tx.update(contentPublications).set(fresh).where(eq(contentPublications.id, row.id))
        return fresh
      }
      const current = assertFence(row, input)
      if (
        current.sha256 !== input.sha256 ||
        current.size !== input.size ||
        current.scope !== input.scope
      )
        throw new Error('content-publication-facts-changed')
      const publication = publicationOf(current)
      if (publication.state !== 'pending' && publication.state !== 'ready')
        throw new Error('content-publication-retired')
      return publication
    },
    async ready(tx, input) {
      const row = assertFence(await publicationRow(tx, input, true), input)
      if (row.state !== 'pending' && row.state !== 'ready')
        throw new Error('content-publication-retired')
      if (row.contentId !== null && row.contentId !== input.contentId)
        throw new Error('content-publication-receipt-changed')
      const ref = await readContentObject(tx, input.contentId)
      if (ref.sha256 !== row.sha256 || ref.size !== row.size)
        throw new Error('content-publication-receipt-mismatch')
      const { contentPublications } = tablesOf(tx)
      const ready = {
        ...row,
        state: 'ready' as const,
        contentId: input.contentId,
        sourceSealed: null,
        releasedAt: null,
        updatedAt: input.now,
      }
      await tx.update(contentPublications).set(ready).where(eq(contentPublications.id, row.id))
      return ready
    },
    async release(tx, selection, now) {
      if (
        selection.keys === undefined &&
        selection.scope === undefined &&
        selection.keyPrefix === undefined
      )
        throw new Error('content-publication-selection-empty')
      const { contentPublications: table } = tablesOf(tx)
      const groups =
        selection.keys === undefined
          ? [undefined]
          : Array.from({ length: Math.ceil(selection.keys.length / 400) }, (_, index) =>
              selection.keys!.slice(index * 400, (index + 1) * 400),
            )
      let count = 0
      for (const keys of groups) {
        const rows = await tx
          .update(table)
          .set({
            state: 'releasing',
            releasedAt: now,
            updatedAt: now,
            nextAttemptAt: 0,
            attempts: 0,
            sourceSealed: null,
          })
          .where(
            and(
              eq(table.owner, selection.owner),
              inArray(table.state, ['pending', 'ready']),
              keys === undefined ? undefined : inArray(table.logicalKey, [...keys]),
              selection.scope === undefined ? undefined : eq(table.scope, selection.scope),
              selection.keyPrefix === undefined
                ? undefined
                : sql`substr(${table.logicalKey}, 1, ${[...selection.keyPrefix].length}) = ${selection.keyPrefix}`,
            ),
          )
          .returning({ id: table.id })
        count += rows.length
      }
      return count
    },
    async released(tx, fence, now) {
      const row = assertFence(await publicationRow(tx, fence, true), fence)
      if (row.state === 'released') return
      if (row.state !== 'releasing') throw new Error('content-publication-not-releasing')
      const { contentPublications } = tablesOf(tx)
      await tx
        .update(contentPublications)
        .set({ state: 'released', updatedAt: now })
        .where(eq(contentPublications.id, row.id))
    },
    async retry(tx, input) {
      const row = assertFence(await publicationRow(tx, input, true), input)
      if (row.state !== 'pending' && row.state !== 'releasing')
        throw new Error('content-publication-not-retryable')
      const { contentPublications } = tablesOf(tx)
      await tx
        .update(contentPublications)
        .set({
          attempts: row.attempts + 1,
          nextAttemptAt: input.nextAttemptAt,
          updatedAt: input.now,
        })
        .where(eq(contentPublications.id, row.id))
    },
    async pending(page) {
      const { contentPublications } = tablesOf(db)
      const rows = await db
        .select()
        .from(contentPublications)
        .where(
          and(
            inArray(contentPublications.state, ['pending', 'releasing']),
            lte(contentPublications.nextAttemptAt, page.now),
          ),
        )
        .orderBy(asc(contentPublications.nextAttemptAt), asc(contentPublications.id))
        .limit(page.limit)
      return rows.map(publicationOf)
    },
    async scopes(owner, page) {
      const { contentPublications: table } = tablesOf(db)
      const rows = await db
        .select({ scope: table.scope })
        .from(table)
        .where(
          and(
            eq(table.owner, owner),
            inArray(table.state, ['pending', 'ready']),
            sql`${table.scope} IS NOT NULL`,
            page.after === undefined ? undefined : gt(table.scope, page.after),
          ),
        )
        .groupBy(table.scope)
        .having(lte(min(table.createdAt), page.before))
        .orderBy(asc(table.scope))
        .limit(page.limit)
      return rows.flatMap((row) => (row.scope === null ? [] : [row.scope]))
    },
  }
}

export async function readContentObject(
  db: PersistenceTx,
  contentId: string,
): Promise<ExternalRef> {
  const { contentObjects } = tablesOf(db)
  const row = (
    await db.select().from(contentObjects).where(eq(contentObjects.contentId, contentId)).limit(1)
  )[0]
  if (row === undefined) throw new Error('content-object-missing')
  const ref = contentRefColumns.decode(
    JSON.stringify({
      version: 1,
      kind: row.kind,
      location: JSON.parse(row.locationJson),
      contentId: row.contentId,
      contentVersion: row.contentVersion,
      sha256: row.sha256,
      size: row.size,
      mediaType: row.mediaType,
    }),
    null,
  )
  if (ref === null || ref.kind === 'inline') throw new Error('content-object-shape-invalid')
  return ref
}

export async function registerContentObjectInTx(
  tx: PersistenceTx,
  ref: ExternalRef,
  now: number,
): Promise<void> {
  contentRefColumns.encode(ref)
  if (
    ref.contentId === null ||
    ref.contentVersion === null ||
    ref.sha256 === null ||
    ref.size === null
  )
    throw new Error('content-object-facts-missing')
  const { contentObjects } = tablesOf(tx)
  await tx
    .insert(contentObjects)
    .values({
      contentId: ref.contentId,
      contentVersion: ref.contentVersion,
      sha256: ref.sha256,
      size: ref.size,
      mediaType: ref.mediaType,
      kind: ref.kind,
      locationJson: canonicalSchemaJson(ref.location),
      createdAt: now,
    })
    .onConflictDoNothing()
  const existing = await readContentObject(tx, ref.contentId)
  if (!sameContentObject(existing, ref)) throw new Error('content-object-facts-changed')
}

/** External transports are selected by deployment composition. They preserve the
 * publication identity across retries and perform no database writes. */
export interface ContentTransport {
  put(input: {
    readonly publication: ContentPublicationFence
    readonly ref: ExternalRef
    readonly source: Exclude<ContentSource, { kind: 'existing' }>
  }): Promise<ExternalRef>
  read(ref: ExternalRef): Promise<Uint8Array>
  retain(ref: ExternalRef, publication: ContentPublicationFence): Promise<void>
  remove?(ref: ExternalRef): Promise<void>
}

function verifyBytes(ref: Pick<ContentRef, 'sha256' | 'size'>, bytes: Uint8Array): Uint8Array {
  if (ref.size !== null && ref.size !== bytes.byteLength)
    throw new Error('content-ref-size-mismatch')
  if (ref.sha256 !== null && ref.sha256 !== sha256Hex(bytes))
    throw new Error('content-ref-digest-mismatch')
  return Uint8Array.from(bytes)
}

function transportContent(source: Exclude<ContentSource, { kind: 'existing' }>) {
  let failure: Error | null = null
  const reject = (message: string): never => {
    failure = new Error(message)
    throw failure
  }
  const facts =
    source.kind === 'stream'
      ? source
      : { sha256: sha256Hex(source.bytes), size: source.bytes.byteLength }
  return {
    sha256: facts.sha256,
    size: facts.size,
    async open() {
      // The remote uploader may replay a failed transfer. Invalid immutable
      // source facts must fail before it starts another transfer.
      if (failure !== null) throw failure
      const stream =
        source.kind === 'stream'
          ? await source.open()
          : new Blob([Uint8Array.from(source.bytes)]).stream()
      const digest = createSha256DigestBuilder()
      let size = 0
      return stream.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            size += chunk.byteLength
            if (size > facts.size) reject('content-ref-size-mismatch')
            const bytes = Uint8Array.from(chunk)
            digest.update(bytes)
            controller.enqueue(bytes)
          },
          flush() {
            if (size !== facts.size) reject('content-ref-size-mismatch')
            if (digest.digestHex() !== facts.sha256) reject('content-ref-digest-mismatch')
          },
        }),
      )
    },
  }
}

async function sourceBytes(
  source: Exclude<ContentSource, { kind: 'existing' }>,
): Promise<Uint8Array> {
  if (source.kind === 'bytes') return Uint8Array.from(source.bytes)
  const reader = (await source.open()).getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > source.size) throw new Error('content-ref-size-mismatch')
      chunks.push(Uint8Array.from(item.value))
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return verifyBytes(source, bytes)
}

export async function readDatabaseContent(db: PersistenceTx, ref: ContentRef): Promise<Uint8Array> {
  if (ref.kind === 'inline') return verifyBytes(ref, ref.bytes)
  if (ref.kind !== 'database-bytes' || ref.contentId === null)
    throw new Error('content-database-location-invalid')
  const catalog = await readContentObject(db, ref.contentId)
  if (catalog.kind !== ref.kind || catalog.sha256 !== ref.sha256 || catalog.size !== ref.size)
    throw new Error('content-object-facts-changed')
  const { contentBytes } = tablesOf(db)
  const row = (
    await db
      .select({ bytes: contentBytes.bytes })
      .from(contentBytes)
      .where(eq(contentBytes.contentId, ref.contentId))
      .limit(1)
  )[0]
  if (row === undefined) throw new Error('content-bytes-missing')
  return verifyBytes(ref, row.bytes)
}

export function createContentStore(input: {
  readonly db: PersistenceDb
  readonly policy: ContentStoragePolicy
  readonly transports?: Partial<Record<'local-file' | 'object', ContentTransport>>
  readonly now?: () => number
  /** Object publications share the hosted maintenance fence epoch. */
  readonly objectPublicationEpoch?: () => number
  /** The same lease as content maintenance, including reuse of existing references. */
  readonly exclusive?: <T>(run: () => Promise<T>) => Promise<T>
  /** Owner-bound database-only adapters can join their existing transaction. */
  readonly transaction?: <T>(body: (tx: PersistenceTx) => Promise<T>) => Promise<T>
}): ContentStore {
  const { db, policy } = input
  contentStorageKind(policy, { size: 0, references: 'single' })
  const transaction = input.transaction ?? ((body) => databaseSessionFor(db).transaction(body))
  const now = input.now ?? Date.now
  const publications = createContentPublicationLedger(db)
  const transportFor = (kind: 'local-file' | 'object') => {
    const transport = input.transports?.[kind]
    if (transport === undefined) throw new Error(`content-transport-unavailable:${kind}`)
    return transport
  }
  const read = async (ref: ContentRef): Promise<Uint8Array> => {
    contentRefColumns.encode(ref)
    if (ref.kind === 'inline' || ref.kind === 'database-bytes') return readDatabaseContent(db, ref)
    if (ref.contentId !== null) {
      const stored = await readContentObject(db, ref.contentId)
      if (!sameContentObject(stored, ref)) throw new Error('content-object-facts-changed')
    }
    return verifyBytes(ref, await transportFor(ref.kind).read(ref))
  }
  const store: ContentStore = {
    policy,
    publications,
    read,
    async put(request, commit) {
      const { source } = request
      let publication = request.publication
      if (!Number.isSafeInteger(request.contentVersion) || request.contentVersion < 0)
        throw new Error('content-version-invalid')
      const kind =
        source.kind === 'existing'
          ? source.ref.kind
          : contentStorageKind(policy, { size: publication.size, references: request.references })
      if (kind === 'object') {
        if (!input.objectPublicationEpoch) throw new Error('content-object-epoch-unconfigured')
        publication = { ...publication, epoch: input.objectPublicationEpoch() }
      }
      if (
        source.kind === 'stream' &&
        (source.sha256 !== publication.sha256 || source.size !== publication.size)
      )
        throw new Error('content-publication-facts-changed')
      if (kind === 'inline') {
        if (source.kind === 'existing') throw new Error('content-existing-inline-invalid')
        const bytes = verifyBytes(publication, await sourceBytes(source))
        const ref: ContentRef = {
          version: 1,
          kind: 'inline',
          location: { codec: 'inline', value: null },
          bytes,
          contentId: null,
          contentVersion: request.contentVersion,
          sha256: publication.sha256,
          size: publication.size,
          mediaType: request.mediaType,
        }
        await transaction((tx) => commit(tx, ref))
        return ref
      }
      if (source.kind === 'bytes') verifyBytes(publication, source.bytes)
      if (
        source.kind === 'existing' &&
        ((source.ref.sha256 !== null && source.ref.sha256 !== publication.sha256) ||
          (source.ref.size !== null && source.ref.size !== publication.size) ||
          (source.ref.contentVersion !== null &&
            source.ref.contentVersion !== request.contentVersion) ||
          (source.ref.mediaType !== null && source.ref.mediaType !== request.mediaType))
      )
        throw new Error('content-publication-facts-changed')
      const bound =
        kind === 'database-bytes'
          ? await publications.find(publication)
          : await transaction((tx) =>
              publications.begin(tx, { ...publication, sourceSealed: null, now: now() }),
            )
      if (bound?.state === 'ready') {
        const catalog = await readContentObject(db, bound.contentId)
        const ref =
          source.kind === 'existing'
            ? {
                ...source.ref,
                contentId: bound.contentId,
                contentVersion: source.ref.contentVersion ?? request.contentVersion,
                sha256: publication.sha256,
                size: publication.size,
                mediaType: source.ref.mediaType ?? request.mediaType,
              }
            : catalog
        if (
          ref.contentVersion !== request.contentVersion ||
          ref.mediaType !== request.mediaType ||
          ref.kind !== kind ||
          !sameContentObject(catalog, ref)
        )
          throw new Error('content-publication-facts-changed')
        await transaction(async (tx) => {
          await publications.begin(tx, { ...publication, sourceSealed: null, now: now() })
          await publications.ready(tx, { ...publication, contentId: bound.contentId, now: now() })
          await commit(tx, ref)
        })
        return ref
      }
      const bytes =
        source.kind === 'existing'
          ? verifyBytes(
              publication,
              await read({ ...source.ref, sha256: publication.sha256, size: publication.size }),
            )
          : kind === 'database-bytes'
            ? verifyBytes(publication, await sourceBytes(source))
            : null
      const contentId =
        (source.kind === 'existing' ? source.ref.contentId : null) ??
        sha256Hex(
          JSON.stringify([
            publication.owner,
            publication.logicalKey,
            publication.attempt,
            publication.epoch,
          ]),
        )
      let ref: ExternalRef =
        source.kind === 'existing'
          ? {
              ...source.ref,
              contentId,
              contentVersion: source.ref.contentVersion ?? request.contentVersion,
              mediaType: source.ref.mediaType ?? request.mediaType,
              sha256: publication.sha256,
              size: publication.size,
            }
          : {
              version: 1,
              kind,
              location: {
                codec: kind === 'database-bytes' ? 'content-bytes' : 'content-object',
                value: contentId,
              },
              contentId,
              contentVersion: request.contentVersion,
              sha256: publication.sha256,
              size: publication.size,
              mediaType: request.mediaType,
            }
      if (kind !== 'database-bytes') {
        if (source.kind === 'existing') await transportFor(kind).retain(ref, publication)
        else ref = await transportFor(kind).put({ publication, ref, source })
        if (
          ref.kind !== kind ||
          ref.contentId !== contentId ||
          ref.sha256 !== publication.sha256 ||
          ref.size !== publication.size ||
          ref.contentVersion !== request.contentVersion ||
          ref.mediaType !== request.mediaType
        )
          throw new Error('content-publication-receipt-mismatch')
      }
      await transaction(async (tx) => {
        if (kind === 'database-bytes')
          await publications.begin(tx, { ...publication, sourceSealed: null, now: now() })
        await registerContentObjectInTx(tx, ref, now())
        if (kind === 'database-bytes') {
          if (bytes === null) throw new Error('content-database-bytes-missing')
          const { contentBytes } = tablesOf(tx)
          await tx
            .insert(contentBytes)
            .values({ contentId, bytes: Buffer.from(bytes) })
            .onConflictDoNothing()
          await readDatabaseContent(tx, ref)
        }
        await publications.ready(tx, { ...publication, contentId, now: now() })
        await commit(tx, ref)
      })
      return ref
    },
    async release(tx, request) {
      if (request.ref.kind === 'inline') return
      const row = assertFence(
        await publicationRow(tx, request.publication, true),
        request.publication,
      )
      if (row.contentId !== request.ref.contentId)
        throw new Error('content-publication-receipt-changed')
      await publications.release(tx, { owner: row.owner, keys: [row.logicalKey] }, now())
    },
  }
  return input.exclusive
    ? { ...store, put: (request, commit) => input.exclusive!(() => store.put(request, commit)) }
    : store
}

export function createObjectContentTransport(
  objects: Pick<CrewStationStreamObjectStorage, 'putStream' | 'read' | 'retain'>,
): ContentTransport {
  const pin = (publication: ContentPublicationFence) =>
    `aw-publication:${sha256Hex(JSON.stringify([publication.owner, publication.logicalKey, publication.attempt]))}`
  const objectOf = (ref: ExternalRef): HostedStoredObject => {
    const id = objectIdOf(ref)
    if (id === null || ref.sha256 === null || ref.size === null)
      throw new Error('content-object-location-invalid')
    return { id, sha256: ref.sha256, size: ref.size }
  }
  return {
    async put({ publication, ref, source }) {
      const object = await objects.putStream(pin(publication), transportContent(source), {
        attempt: publication.attempt,
      })
      return {
        ...ref,
        location: { codec: 'hosted-object-id', value: object.id },
        sha256: object.sha256,
        size: object.size,
      }
    },
    async read(ref) {
      return objects.read(objectOf(ref).id)
    },
    async retain(ref, publication) {
      await objects.retain(pin(publication), objectOf(ref))
    },
  }
}

/** Local content is published by atomic rename outside the retryable transaction. */
export function createLocalFileContentTransport(
  root: string,
  historicalRoot?: string,
): ContentTransport {
  const pathOf = (ref: ExternalRef) => {
    if (
      ref.location.codec === 'content-file' &&
      typeof ref.location.value === 'string' &&
      /^[a-f0-9]{64}$/.test(ref.location.value)
    )
      return join(root, ref.location.value)
    if (
      historicalRoot !== undefined &&
      typeof ref.location.value === 'string' &&
      ref.kind === 'local-file'
    )
      return isAbsolute(ref.location.value)
        ? ref.location.value
        : join(historicalRoot, ref.location.value)
    throw new Error('content-file-location-invalid')
  }
  return {
    async put({ ref, source }) {
      const stored: ExternalRef = {
        ...ref,
        location: { codec: 'content-file', value: ref.contentId },
      }
      const path = pathOf(stored)
      await mkdir(root, { recursive: true })
      const temporary = `${path}.${crypto.randomUUID()}.pending`
      try {
        const file = await open(temporary, 'wx')
        try {
          const reader = (await transportContent(source).open()).getReader()
          try {
            for (;;) {
              const chunk = await reader.read()
              if (chunk.done) break
              let offset = 0
              while (offset < chunk.value.byteLength) {
                const result = await file.write(chunk.value.subarray(offset))
                if (result.bytesWritten === 0) throw new Error('content-file-write-incomplete')
                offset += result.bytesWritten
              }
            }
          } catch (error) {
            await reader.cancel().catch(() => undefined)
            throw error
          } finally {
            reader.releaseLock()
          }
        } finally {
          await file.close()
        }
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
      return stored
    },
    async read(ref) {
      return new Uint8Array(await readFile(pathOf(ref)))
    },
    async remove(ref) {
      await rm(pathOf(ref), { force: true })
    },
    async retain(ref) {
      verifyBytes(ref, await readFile(pathOf(ref)))
    },
  }
}

/** Native column spelling at the persistence edge, including the binary half. */
export function contentRowColumns(ref: ContentRef) {
  const columns = contentRefColumns.encode(ref)
  return {
    contentRefJson: columns.json,
    contentInlineBytes: columns.inlineBytes === null ? null : Buffer.from(columns.inlineBytes),
  }
}

export function contentRefOf(row: {
  readonly contentRefJson: string | null
  readonly contentInlineBytes: Uint8Array | null
}): ContentRef {
  const ref = contentRefColumns.decode(row.contentRefJson, row.contentInlineBytes)
  if (ref === null) throw new Error('content-reference-missing')
  return ref
}

export function inlineContentColumns(bytes: Uint8Array, mediaType: string | null = null) {
  return contentRowColumns({
    version: 1,
    kind: 'inline',
    location: { codec: 'inline', value: null },
    bytes,
    contentId: null,
    contentVersion: 1,
    sha256: sha256Hex(bytes),
    size: bytes.byteLength,
    mediaType,
  })
}

/** Database bytes have no transport side effects and can join an owner's transaction. */
export async function databaseContentColumnsInTx(
  tx: PersistenceTx,
  owner: string,
  logicalKey: string,
  bytes: Uint8Array,
  scope: string | null = null,
) {
  const digest = sha256Hex(bytes)
  let result: ReturnType<typeof contentRowColumns> | undefined
  await createContentStore({
    db: tx,
    policy: databaseContentPolicy,
    transaction: (body) => body(tx),
  }).put(
    {
      publication: {
        owner,
        logicalKey: JSON.stringify([logicalKey, digest]),
        scope,
        attempt: digest,
        epoch: 0,
        sha256: digest,
        size: bytes.byteLength,
      },
      source: { kind: 'bytes', bytes },
      contentVersion: 1,
      mediaType: null,
      references: 'single',
    },
    async (_tx, ref) => {
      result = contentRowColumns(ref)
    },
  )
  return result!
}

export async function databaseContentText(
  db: PersistenceTx,
  row: Parameters<typeof contentRefOf>[0],
) {
  return Buffer.from(await readDatabaseContent(db, contentRefOf(row))).toString('utf8')
}

/** Reuse the catalog identity created by the hosted publication's ready transaction. */
export async function hostedContentColumnsInTx(tx: PersistenceTx, object: HostedStoredObject) {
  const { contentObjects } = tablesOf(tx)
  const [row] = await tx
    .select({ id: contentObjects.contentId })
    .from(contentObjects)
    .where(
      and(
        eq(contentObjects.kind, 'object'),
        eq(
          contentObjects.locationJson,
          canonicalSchemaJson({ codec: 'hosted-object-id', value: object.id }),
        ),
        eq(contentObjects.sha256, object.sha256),
        eq(contentObjects.size, object.size),
      ),
    )
    .limit(1)
  if (!row) throw new Error('content-object-missing')
  return contentRowColumns(await readContentObject(tx, row.id))
}

export function hostedObjectOf(ref: ContentRef): HostedStoredObject {
  const id = ref.kind === 'inline' ? null : objectIdOf(ref)
  if (id === null || ref.sha256 === null || ref.size === null)
    throw new Error('content-object-location-invalid')
  return { id, sha256: ref.sha256, size: ref.size }
}

/** Read-only adapter for existing profile ports; verification stays in ContentStore. */
export function contentReadTransport(read: ContentTransport['read']): ContentTransport {
  return {
    read,
    async put() {
      throw new Error('content-read-only')
    },
    async retain() {
      throw new Error('content-read-only')
    },
  }
}

/** Release only the publications owned by the removed business references. */
export async function releaseContentRowsInTx(
  tx: PersistenceTx,
  owner: string,
  rows: readonly Parameters<typeof contentRefOf>[0][],
  now: number,
): Promise<void> {
  const ids = rows.flatMap((row) => {
    const ref = contentRefColumns.decode(row.contentRefJson, row.contentInlineBytes)
    return ref?.contentId ? [ref.contentId] : []
  })
  const { contentPublications } = tablesOf(tx)
  const ledger = createContentPublicationLedger(tx)
  for (let offset = 0; offset < ids.length; offset += 400) {
    const publications = await tx
      .select({ key: contentPublications.logicalKey })
      .from(contentPublications)
      .where(
        and(
          eq(contentPublications.owner, owner),
          inArray(contentPublications.contentId, ids.slice(offset, offset + 400)),
        ),
      )
    await ledger.release(tx, { owner, keys: publications.map((row) => row.key) }, now)
  }
}

/** One maintenance participant for database/local content. Composition supplies
 * the live/history holder query and the same backup horizon as hosted objects.
 * External removal is outside retryable transactions; the maintenance lease
 * supplied by composition serializes this step with publication/retention. */
export function createContentMaintenance(input: {
  readonly db: PersistenceDb
  readonly horizon: {
    protects(lifetime: { createdAt: number; releasedAt: number }): Promise<boolean>
  }
  readonly hasHolders: (tx: PersistenceTx, ref: ContentRef) => Promise<boolean>
  readonly exclusive: <T>(run: () => Promise<T>) => Promise<T>
  readonly localFiles?: Pick<ContentTransport, 'remove'>
  /** Explicit owner selection for local uploads released before catalog commit. */
  readonly localOwners?: readonly string[]
  readonly now?: () => number
  readonly batch?: number
}) {
  const now = input.now ?? Date.now
  const session = databaseSessionFor(input.db)
  const ledger = createContentPublicationLedger(input.db)
  let after: string | undefined, uncommittedAfter: string | undefined
  const batch = input.batch ?? 100
  return {
    async run() {
      return input.exclusive(async () => {
        const result = { released: 0, purged: 0, protected: 0 }
        const { contentObjects, contentPublications, contentBytes } = tablesOf(input.db)
        if (input.localOwners?.length) {
          const uncommitted = await input.db
            .select()
            .from(contentPublications)
            .where(
              and(
                eq(contentPublications.state, 'releasing'),
                sql`${contentPublications.contentId} IS NULL`,
                inArray(contentPublications.owner, [...input.localOwners]),
                uncommittedAfter === undefined
                  ? undefined
                  : gt(contentPublications.id, uncommittedAfter),
              ),
            )
            .orderBy(asc(contentPublications.id))
            .limit(batch)
          uncommittedAfter = uncommitted.length === batch ? uncommitted.at(-1)!.id : undefined
          for (const row of uncommitted) {
            if (
              await input.horizon.protects({
                createdAt: row.createdAt,
                releasedAt: row.releasedAt!,
              })
            ) {
              result.protected++
              continue
            }
            const id = sha256Hex(
              JSON.stringify([row.owner, row.logicalKey, row.attempt, row.epoch]),
            )
            const ref: ExternalRef = {
              version: 1,
              kind: 'local-file',
              contentId: id,
              contentVersion: 1,
              sha256: row.sha256,
              size: row.size,
              mediaType: null,
              location: { codec: 'content-file', value: id },
            }
            if (await input.hasHolders(input.db, ref)) {
              result.protected++
              continue
            }
            if (!input.localFiles?.remove) throw new Error('content-file-removal-unconfigured')
            await input.localFiles.remove(ref)
            await session.transaction((tx) => ledger.released(tx, row, now()))
            result.released++
          }
        }
        const candidates = await input.db
          .select()
          .from(contentObjects)
          .where(
            and(
              inArray(contentObjects.kind, ['database-bytes', 'local-file']),
              after === undefined ? undefined : gt(contentObjects.contentId, after),
              sql`NOT EXISTS (SELECT 1 FROM ${contentPublications} WHERE ${contentPublications.contentId} = ${contentObjects.contentId} AND ${contentPublications.state} IN ('pending', 'ready'))`,
            ),
          )
          .orderBy(asc(contentObjects.contentId))
          .limit(batch)
        after = candidates.length === batch ? candidates.at(-1)!.contentId : undefined
        for (const object of candidates) {
          const ref = await readContentObject(input.db, object.contentId)
          let publications = await input.db
            .select()
            .from(contentPublications)
            .where(eq(contentPublications.contentId, object.contentId))
          if (await input.hasHolders(input.db, ref)) {
            result.protected++
            continue
          }
          // Converted catalog rows have no publication. Persist the first observed
          // release time once, so later backups do not extend retention forever.
          if (publications.length === 0) {
            const identity = {
              owner: 'content-maintenance',
              logicalKey: object.contentId,
              attempt: 'converted-content',
              epoch: 0,
              scope: null,
              sha256: object.sha256,
              size: object.size,
            }
            await session.transaction(async (tx) => {
              await ledger.begin(tx, { ...identity, sourceSealed: null, now: object.createdAt })
              await ledger.ready(tx, { ...identity, contentId: object.contentId, now: now() })
              await ledger.release(
                tx,
                { owner: identity.owner, keys: [identity.logicalKey] },
                now(),
              )
            })
            publications = await input.db
              .select()
              .from(contentPublications)
              .where(eq(contentPublications.contentId, object.contentId))
          }
          if (
            await input.horizon.protects({
              createdAt: Math.min(object.createdAt, ...publications.map((row) => row.createdAt)),
              releasedAt: Math.max(...publications.map((row) => row.releasedAt!)),
            })
          ) {
            result.protected++
            continue
          }
          if (ref.kind === 'local-file') {
            if (!input.localFiles?.remove) throw new Error('content-file-removal-unconfigured')
            await input.localFiles.remove(ref)
          }
          await session.transaction(async (tx) => {
            for (const row of publications)
              if (row.state === 'releasing') {
                await ledger.released(tx, row, now())
                result.released++
              }
            await tx
              .update(contentPublications)
              .set({ contentId: null })
              .where(
                and(
                  eq(contentPublications.contentId, object.contentId),
                  eq(contentPublications.state, 'released'),
                ),
              )
            await tx.delete(contentBytes).where(eq(contentBytes.contentId, object.contentId))
            await tx.delete(contentObjects).where(eq(contentObjects.contentId, object.contentId))
            result.purged++
          })
        }
        return result
      })
    },
  }
}
