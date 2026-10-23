// RFC-370 v3 V6 — hosted task archive content over the neutral object journal.
// The archive index is `hosted_task_archive_entries` (path -> ordered object
// parts); every part is a `task-archive` publication committed in the same
// transaction as its entry. Object-backed sources (prompts, ports, inputs,
// review documents, event chunks) are linked by a new pin of the same immutable
// object, never copied; only work-volume files are uploaded. A directory rename
// rewrites index rows only. Removing entries releases their parts; physical
// unpin is deferred to maintenance behind the backup release horizon.
import {
  normalizeLegacyHostedArchive as normalized,
  legacyHostedArchiveSource as sourceOf,
  legacyHostedArchiveRoot,
  isLegacyHostedArchiveTemporary,
} from '@/platform/content/legacyHostedArchive'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { eq, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  HostedObjectPublicationRequest,
  HostedObjectPublications,
  HostedObjectReceipt,
} from '@/modules/system-operations/public/participants'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type {
  CrewStationStreamObjectStorage,
  HostedStoredObject,
} from '@/platform/crewstation/objectStorage'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { TaskArchiveContentBinding } from '../../composition/taskArchiveMaintenance'

export const HOSTED_ARCHIVE_OWNER = 'task-archive'
const ROOT = legacyHostedArchiveRoot('tasks')

const Part = z
  .object({
    key: z.string().min(1),
    id: z.string().uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
  })
  .strict()
type Part = z.infer<typeof Part>
type Row = PersistenceTables['hostedTaskArchiveEntries']['$inferSelect']
const partsOf = (row: Row): Part[] => z.array(Part).parse(JSON.parse(row.partsJson))

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
const partOf = (key: string, object: HostedObjectReceipt): Part => ({
  key,
  id: object.id,
  sha256: object.sha256,
  size: object.size,
})

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
  const releaseParts = async (tx: PersistenceDb, rows: readonly Row[]) => {
    const keys = rows.flatMap((row) => partsOf(row).map((part) => part.key))
    if (keys.length > 0) await input.publications.release({ owner: HOSTED_ARCHIVE_OWNER, keys }, tx)
  }
  const saveFile = async (reference: string, text: string, append: boolean) => {
    normalized(reference)
    if (!reference.startsWith(ROOT + '/')) throw new Error('hosted-archive-write-outside-archive')
    const key = partKey()
    await input.publications.publish(
      [{ owner: HOSTED_ARCHIVE_OWNER, key, bytes: Buffer.from(text, 'utf8') }],
      {
        async commit(tx, [object]) {
          const current = await find(reference, tx)
          if (current && current.kind !== 'file') throw new Error('hosted-archive-not-file')
          const previous = current ? partsOf(current) : []
          if (current && !append) await releaseParts(tx, [current])
          const parts = [...(append ? previous : []), partOf(key, object!)]
          const values = {
            kind: 'file' as const,
            partsJson: JSON.stringify(parts),
            updatedAt: now(),
          }
          const { hostedTaskArchiveEntries } = tablesOf(tx)
          await tx
            .insert(hostedTaskArchiveEntries)
            .values({ path: reference, createdAt: now(), ...values })
            .onConflictDoUpdate({ target: hostedTaskArchiveEntries.path, set: values })
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
          partsJson: '[]',
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
      async commit(tx, receipts) {
        if ((await rowsBelow(to, tx)).length > 0)
          throw new Error('hosted-archive-destination-exists')
        const { hostedTaskArchiveEntries } = tablesOf(tx)
        await insertOne(tx, hostedTaskArchiveEntries, {
          path: to,
          kind: 'directory',
          partsJson: '[]',
          createdAt: now(),
          updatedAt: now(),
        })
        for (let index = 0; index < files.length; index++)
          await insertOne(tx, hostedTaskArchiveEntries, {
            path: `${to}/${files[index]!.path}`,
            kind: 'file',
            partsJson: JSON.stringify([partOf(requests[index]!.key, receipts[index]!)]),
            createdAt: now(),
            updatedAt: now(),
          })
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
        isLegacyHostedArchiveTemporary(from) &&
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
      await tx.delete(hostedTaskArchiveEntries).where(below(from))
    })
  }
  return {
    locations: {
      archiveDir: ROOT,
      runsDir: legacyHostedArchiveRoot('runs'),
      logsDir: legacyHostedArchiveRoot('logs'),
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
        if (root !== legacyHostedArchiveRoot(kind))
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
      for (const part of partsOf(row))
        chunks.push(await new Response(await input.objects.open(part)).text())
      return chunks.join('')
    },
  }
}
