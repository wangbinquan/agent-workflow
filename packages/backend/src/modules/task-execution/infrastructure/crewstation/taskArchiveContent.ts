import { contentRefColumns } from '@/platform/content/contentStore'
import {
  createContentPublicationLedger,
  readContentObject,
  readDatabaseContent,
} from '@/platform/content/infrastructure/contentStore'
// RFC-370 v3 V6 — hosted task archive content over the neutral object journal.
// The archive index is `hosted_task_archive_entries` (path -> ordered object
// parts); every part is a `task-archive` publication committed in the same
// transaction as its entry. Object-backed sources (prompts, ports, inputs,
// review documents, event chunks) are linked by a new pin of the same immutable
// object, never copied; only work-volume files are uploaded. A directory rename
// rewrites index rows only. Removing entries releases their parts; physical
// unpin is deferred to maintenance behind the backup release horizon.
import type {
  HostedObjectPublicationRequest,
  HostedObjectPublications,
} from '@/modules/system-operations/public/participants'
import {
  isHostedArchiveTemporary,
  hostedArchiveRoot,
  normalizeHostedArchive as normalized,
  hostedArchiveSource as sourceOf,
} from '@/platform/content/locations/hostedArchive'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type {
  CrewStationStreamObjectStorage,
  HostedStoredObject,
} from '@/platform/crewstation/objectStorage'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { asc, eq, or, sql } from 'drizzle-orm'
import type { TaskArchiveContentBinding } from '../../composition/taskArchiveMaintenance'

export const HOSTED_ARCHIVE_OWNER = 'task-archive'
const ROOT = hostedArchiveRoot('tasks')

type Row = PersistenceTables['hostedTaskArchiveEntries']['$inferSelect']
export interface HostedArchiveFile {
  readonly path: string
  readonly sha256: string
  readonly size: number
  /** An existing immutable object holding exactly these bytes. */
  readonly object?: HostedStoredObject
  open(): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>
}
export interface HostedArchiveSources {
  exists(kind: 'runs' | 'logs', taskId: string): Promise<boolean>
  snapshot(kind: 'runs' | 'logs', taskId: string): Promise<readonly HostedArchiveFile[]>
}

function assertRelative(path: string): void {
  if (
    !path ||
    path.startsWith('/') ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    /[\\\0]/.test(path)
  )
    throw new Error('hosted-archive-file-reference-invalid')
}
const partKey = () => `part:${crypto.randomUUID()}`
export function createHostedTaskArchiveContent(input: {
  readonly db: PersistenceDb
  readonly fence: CrewStationMutationFence
  readonly objects: Pick<CrewStationStreamObjectStorage, 'open'>
  readonly publications: HostedObjectPublications
  readonly sources: HostedArchiveSources
  /** Each archived task's own volume (Source Control's hosted workspaces). */
  readonly workspaces: {
    find(taskId: string): Promise<unknown | null>
    abandon(taskId: string): Promise<void>
  }
  readonly now?: () => number
}): TaskArchiveContentBinding & { readText(reference: string): Promise<string> } {
  const session = databaseSessionFor(input.db)
  const now = input.now ?? Date.now
  const write = <T>(operation: (tx: PersistenceDb) => Promise<T>): Promise<T> => {
    const lease = input.fence.current()
    return session.transaction(async (tx) => {
      await input.fence.assertHeld(tx, lease)
      return operation(tx)
    })
  }
  // Exact, case-sensitive descendant match on both engines (`LIKE` folds ASCII
  // case on SQLite only); `substr` counts characters, so lengths are code points.
  const below = (reference: string) => {
    const parent = `${reference}/`
    const { hostedTaskArchiveEntries } = tablesOf(input.db)
    return or(
      eq(hostedTaskArchiveEntries.path, reference),
      sql`substr(${hostedTaskArchiveEntries.path}, 1, ${[...parent].length}) = ${parent}`,
    )!
  }
  const rowsBelow = (reference: string, db: PersistenceDb = input.db) => {
    const { hostedTaskArchiveEntries } = tablesOf(db)
    return db.select().from(hostedTaskArchiveEntries).where(below(reference))
  }
  const find = async (reference: string, db: PersistenceDb = input.db) => {
    const { hostedTaskArchiveEntries } = tablesOf(db)
    return (
      await db
        .select()
        .from(hostedTaskArchiveEntries)
        .where(eq(hostedTaskArchiveEntries.path, reference))
        .limit(1)
    )[0]
  }
  const partsOf = async (db: PersistenceDb, path: string) => {
    const { hostedTaskArchiveEntryParts: parts } = tablesOf(db)
    return await db.select().from(parts).where(eq(parts.path, path)).orderBy(asc(parts.ordinal))
  }
  const partOf = async (tx: PersistenceDb, path: string, ordinal: number, key: string) => {
    const publication = await createContentPublicationLedger(tx).find({
      owner: HOSTED_ARCHIVE_OWNER,
      logicalKey: key,
    })
    if (publication?.state !== 'ready') throw new Error('hosted-archive-publication-not-ready')
    const ref = await readContentObject(tx, publication.contentId)
    const columns = contentRefColumns.encode(ref)
    return {
      path,
      ordinal,
      partKey: key,
      contentRefJson: columns.json,
      contentInlineBytes: columns.inlineBytes === null ? null : Buffer.from(columns.inlineBytes),
    }
  }
  const releaseParts = async (tx: PersistenceDb, rows: readonly Row[]) => {
    const { hostedTaskArchiveEntryParts: parts } = tablesOf(tx)
    for (const row of rows) {
      const keys = (await partsOf(tx, row.path)).map((part) => part.partKey)
      if (keys.length) await input.publications.release({ owner: HOSTED_ARCHIVE_OWNER, keys }, tx)
      await tx.delete(parts).where(eq(parts.path, row.path))
    }
  }
  const saveFile = async (reference: string, text: string, append: boolean) => {
    normalized(reference)
    if (!reference.startsWith(ROOT + '/')) throw new Error('hosted-archive-write-outside-archive')
    const key = partKey()
    await input.publications.publish(
      [{ owner: HOSTED_ARCHIVE_OWNER, key, bytes: Buffer.from(text, 'utf8') }],
      {
        async commit(tx, _receipts) {
          const current = await find(reference, tx)
          if (current && current.kind !== 'file') throw new Error('hosted-archive-not-file')
          const previous = current ? await partsOf(tx, current.path) : []
          if (current && !append) await releaseParts(tx, [current])
          const values = {
            kind: 'file' as const,
            updatedAt: now(),
          }
          const { hostedTaskArchiveEntries } = tablesOf(tx)
          await tx
            .insert(hostedTaskArchiveEntries)
            .values({ path: reference, createdAt: now(), ...values })
            .onConflictDoUpdate({ target: hostedTaskArchiveEntries.path, set: values })
          const { hostedTaskArchiveEntryParts } = tablesOf(tx)
          await insertOne(
            tx,
            hostedTaskArchiveEntryParts,
            await partOf(tx, reference, append ? previous.length : 0, key),
          )
        },
      },
    )
  }
  const exists = async (reference: string): Promise<boolean> => {
    normalized(reference)
    const source = sourceOf(reference)
    if (source) return input.sources.exists(source.kind, source.taskId)
    return (await rowsBelow(reference)).length > 0
  }
  const list = async (reference: string): Promise<string[]> => {
    normalized(reference)
    const prefix = reference + '/'
    return [
      ...new Set(
        (await rowsBelow(reference)).flatMap((row) =>
          row.path.startsWith(prefix) ? [row.path.slice(prefix.length).split('/')[0]!] : [],
        ),
      ),
    ].sort()
  }
  const remove = async (reference: string, recursive = false) => {
    normalized(reference)
    if (sourceOf(reference) || reference === ROOT)
      throw new Error('hosted-archive-source-removal-refused')
    await write(async (tx) => {
      const rows = await rowsBelow(reference, tx)
      if (!recursive && rows.some((row) => row.path !== reference))
        throw new Error('hosted-archive-directory-not-empty')
      await releaseParts(tx, rows)
      const { hostedTaskArchiveEntries } = tablesOf(tx)
      await tx.delete(hostedTaskArchiveEntries).where(below(reference))
    })
  }
  const createDirectory = async (reference: string) => {
    normalized(reference)
    if (!reference.startsWith(ROOT + '/')) throw new Error('hosted-archive-write-outside-archive')
    await write(async (tx) => {
      const current = await find(reference, tx)
      if (current) {
        if (current.kind !== 'directory') throw new Error('hosted-archive-not-directory')
        return
      }
      const { hostedTaskArchiveEntries } = tablesOf(tx)
      await tx
        .insert(hostedTaskArchiveEntries)
        .values({
          path: reference,
          kind: 'directory',
          createdAt: now(),
          updatedAt: now(),
        })
        .onConflictDoNothing()
    })
  }
  const moveSource = async (source: { kind: 'runs' | 'logs'; taskId: string }, to: string) => {
    const files = await input.sources.snapshot(source.kind, source.taskId)
    const seen = new Set<string>()
    const requests: HostedObjectPublicationRequest[] = []
    for (const file of files) {
      assertRelative(file.path)
      if (seen.has(file.path)) throw new Error('hosted-archive-file-reference-invalid')
      seen.add(file.path)
      normalized(`${to}/${file.path}`)
      const key = partKey()
      requests.push(
        file.object !== undefined
          ? { owner: HOSTED_ARCHIVE_OWNER, key, object: file.object }
          : {
              owner: HOSTED_ARCHIVE_OWNER,
              key,
              content: { sha256: file.sha256, size: file.size, open: () => file.open() },
            },
      )
    }
    await input.publications.publish(requests, {
      concurrency: 4,
      async commit(tx, _receipts) {
        if ((await rowsBelow(to, tx)).length > 0)
          throw new Error('hosted-archive-destination-exists')
        const { hostedTaskArchiveEntries } = tablesOf(tx)
        await insertOne(tx, hostedTaskArchiveEntries, {
          path: to,
          kind: 'directory',
          createdAt: now(),
          updatedAt: now(),
        })
        for (let index = 0; index < files.length; index++) {
          await insertOne(tx, hostedTaskArchiveEntries, {
            path: `${to}/${files[index]!.path}`,
            kind: 'file',
            createdAt: now(),
            updatedAt: now(),
          })
          const { hostedTaskArchiveEntryParts } = tablesOf(tx)
          await insertOne(
            tx,
            hostedTaskArchiveEntryParts,
            await partOf(tx, `${to}/${files[index]!.path}`, 0, requests[index]!.key),
          )
        }
      },
    })
    // Physical source retention belongs to the task maintenance owner. The
    // live task keeps its own references until its rows are deleted.
  }
  const move = async (from: string, to: string) => {
    normalized(from)
    normalized(to)
    if (!to.startsWith(ROOT + '/') || to.startsWith(from + '/') || from === ROOT || from === to)
      throw new Error('hosted-archive-move-invalid')
    const source = sourceOf(from)
    if (source) return moveSource(source, to)
    await write(async (tx) => {
      const rows = await rowsBelow(from, tx)
      if (rows.length === 0) throw new Error('hosted-archive-source-missing')
      if (
        isHostedArchiveTemporary(from) &&
        !rows.some((row) => row.path === `${from}/manifest.json`)
      )
        throw new Error('hosted-archive-manifest-missing')
      if ((await rowsBelow(to, tx)).length > 0) throw new Error('hosted-archive-destination-exists')
      const { hostedTaskArchiveEntries } = tablesOf(tx)
      for (const row of rows)
        await insertOne(tx, hostedTaskArchiveEntries, {
          ...row,
          path: to + row.path.slice(from.length),
          updatedAt: now(),
        })
      const { hostedTaskArchiveEntryParts } = tablesOf(tx)
      for (const row of rows)
        for (const part of await partsOf(tx, row.path))
          await insertOne(tx, hostedTaskArchiveEntryParts, {
            ...part,
            path: to + row.path.slice(from.length),
          })
      await tx.delete(hostedTaskArchiveEntries).where(below(from))
    })
  }
  return {
    locations: {
      archiveDir: ROOT,
      runsDir: hostedArchiveRoot('runs'),
      logsDir: hostedArchiveRoot('logs'),
    },
    content: {
      resolve: (reference, ...segments) => normalized([reference, ...segments].join('/')),
      exists,
      list,
      createDirectory,
      remove,
      move,
      appendText: (reference, text) => saveFile(reference, text, true),
      writeText: (reference, text) => saveFile(reference, text, false),
      async restoreMovedDirectories(temporary, kind, root) {
        if (root !== hostedArchiveRoot(kind))
          throw new Error('hosted-archive-restoration-root-mismatch')
        // Sources are never consumed by a move; discard the temporary links
        // only after confirming their corresponding source is still present.
        const directory = `${temporary}/${kind}`
        for (const taskId of await list(directory)) {
          if (!(await input.sources.exists(kind, taskId))) return false
        }
        await remove(directory, true)
        return true
      },
      async releaseTaskStorage(taskIds) {
        // A move never consumes its source, so the archived tasks' volumes still
        // hold their worktrees, runs and logs, and orphan sweeps visit only
        // running parents: archiving is what releases them, as deleting a task
        // does. Each own registration is closed (the intent is recorded first;
        // the lifecycle reconciler completes a close the platform refuses for
        // now). A task working in another task's volume has none of its own.
        for (const taskId of taskIds)
          if ((await input.workspaces.find(taskId)) !== null) await input.workspaces.abandon(taskId)
      },
    },
    async readText(reference) {
      const row = await find(normalized(reference))
      if (!row) throw new Error('hosted-archive-file-missing')
      if (row.kind !== 'file') throw new Error('hosted-archive-not-file')
      const chunks = []
      for (const part of await partsOf(input.db, row.path)) {
        const ref = contentRefColumns.decode(part.contentRefJson, part.contentInlineBytes)
        if (ref === null) throw new Error('hosted-archive-content-missing')
        if (ref.kind === 'object') {
          if (
            ref.location.codec !== 'hosted-object-id' ||
            typeof ref.location.value !== 'string' ||
            ref.sha256 === null ||
            ref.size === null
          )
            throw new Error('hosted-archive-object-reference-invalid')
          chunks.push(
            await new Response(
              await input.objects.open({
                id: ref.location.value,
                sha256: ref.sha256,
                size: ref.size,
              }),
            ).text(),
          )
        } else chunks.push(new TextDecoder().decode(await readDatabaseContent(input.db, ref)))
      }
      return chunks.join('')
    },
  }
}
