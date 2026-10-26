// RFC-370 M0 — skill file trees kept in the database (`skill_content_entries`).
//
// A deployment without a persistent local disk keeps each skill's live tree,
// immutable versions, in-flight staging trees and deletion trash as rows. Every
// tree operation runs in one transaction, so the crash windows the filesystem
// funnel recovers from (half-renamed directories, partial copies) do not exist.
// The tree hash is the canonical skill-tree digest (`digestSortedTree`, the
// one `hashDir` uses), so a tree hashes the same in either store.
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import {
  contentRefColumns,
  type SkillContentTree,
  type SkillContentLocationQuery,
} from '@/platform/content/contentStore'
import type { ContentRef } from '@/platform/content/contentRef'
import {
  createContentStore,
  createContentPublicationLedger,
  databaseContentPolicy,
  readDatabaseContent,
} from '@/platform/content/infrastructure/contentStore'
import { sha256Hex } from '@/util/hash'
import type { FileNode } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { ValidationError } from '@/util/errors'
import { digestSortedTree } from './legacy/skillHash'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertPathSegment,
  skillRootRel,
  skillStagingPath,
  skillTrashPath,
  trashTreePrefix,
} from '@/platform/content/locations/skill'

export {
  LIVE_TREE,
  versionTree,
  stagingTree,
  trashTreeOf,
  trashTreePrefix,
} from '@/platform/content/locations/skill'

const TRASH_PREFIX = 'trash:'

export interface SkillTreeFile {
  readonly path: string
  readonly bytes: Uint8Array
}

type Handle = PersistenceTx
type EntryRow = PersistenceTables['skillContentEntries']['$inferSelect'] & {
  readonly bytes: Uint8Array
}

/** Relative POSIX paths only: no absolute paths, empty, `.` or `..` segments. */
export function normalizeSkillPath(path: string): string {
  const segments = path.replaceAll('\\', '/').split('/')
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new ValidationError('skill-file-path-invalid', `invalid skill file path: ${path}`)
  }
  return segments.join('/')
}

/**
 * Whether a normalized tree path lies inside a normalized tree directory.
 * Both operands come from `normalizeSkillPath`, so `/` is the only separator.
 */
export function isInsideSkillDirectory(path: string, directory: string): boolean {
  return (
    path.length > directory.length + 1 &&
    path.startsWith(directory) &&
    path.charAt(directory.length) === '/'
  )
}

export function decodeEntry(row: Pick<EntryRow, 'bytes'>): Uint8Array {
  return Uint8Array.from(row.bytes)
}

/** The canonical skill-tree hash over in-memory files (same digest as `hashDir`). */
export function hashSkillTree(files: readonly SkillTreeFile[]): string {
  const bytesByPath = new Map(files.map((file) => [file.path, file.bytes]))
  return digestSortedTree([...bytesByPath.keys()].sort(), (path) => bytesByPath.get(path)!)
}

export async function readTreeRows(
  db: Handle,
  skillId: string,
  tree: string,
): Promise<readonly EntryRow[]> {
  const { skillContentEntries } = tablesOf(db)
  const rows = await db
    .select()
    .from(skillContentEntries)
    .where(and(eq(skillContentEntries.skillId, skillId), eq(skillContentEntries.tree, tree)))
  const result: EntryRow[] = []
  for (const row of rows) {
    const ref = contentRefColumns.decode(row.contentRefJson, row.contentInlineBytes)
    if (ref === null) throw new Error('skill-entry-content-missing')
    const bytes = await readDatabaseContent(db, ref)
    if (bytes.byteLength !== row.size) throw new Error('skill-entry-size-mismatch')
    result.push({ ...row, bytes })
  }
  return result
}

export async function readTree(
  db: Handle,
  skillId: string,
  tree: string,
): Promise<readonly SkillTreeFile[]> {
  return (await readTreeRows(db, skillId, tree)).map((row) => ({
    path: row.path,
    bytes: decodeEntry(row),
  }))
}

export async function treeExists(db: Handle, skillId: string, tree: string): Promise<boolean> {
  const { skillContentEntries } = tablesOf(db)
  return (
    (
      await db
        .select({ path: skillContentEntries.path })
        .from(skillContentEntries)
        .where(and(eq(skillContentEntries.skillId, skillId), eq(skillContentEntries.tree, tree)))
        .limit(1)
    ).length > 0
  )
}

export async function fileExists(
  db: Handle,
  skillId: string,
  tree: string,
  path: string,
): Promise<boolean> {
  const { skillContentEntries } = tablesOf(db)
  return (
    (
      await db
        .select({ path: skillContentEntries.path })
        .from(skillContentEntries)
        .where(
          and(
            eq(skillContentEntries.skillId, skillId),
            eq(skillContentEntries.tree, tree),
            eq(skillContentEntries.path, path),
          ),
        )
        .limit(1)
    ).length > 0
  )
}

export async function deleteTree(db: Handle, skillId: string, tree: string): Promise<void> {
  const { skillContentEntries } = tablesOf(db)
  const entries = await db
    .select({
      json: skillContentEntries.contentRefJson,
      inline: skillContentEntries.contentInlineBytes,
    })
    .from(skillContentEntries)
    .where(and(eq(skillContentEntries.skillId, skillId), eq(skillContentEntries.tree, tree)))
  const ids = entries.flatMap((entry) => {
    const ref = contentRefColumns.decode(entry.json, entry.inline)
    return ref?.contentId === null || ref === null ? [] : [ref.contentId]
  })
  await db
    .delete(skillContentEntries)
    .where(and(eq(skillContentEntries.skillId, skillId), eq(skillContentEntries.tree, tree)))
  const retained = await db
    .select({
      json: skillContentEntries.contentRefJson,
      inline: skillContentEntries.contentInlineBytes,
    })
    .from(skillContentEntries)
    .where(eq(skillContentEntries.skillId, skillId))
  const held = new Set(
    retained.flatMap((entry) => {
      const ref = contentRefColumns.decode(entry.json, entry.inline)
      return ref?.contentId ? [ref.contentId] : []
    }),
  )
  const releaseIds = ids.filter((id) => !held.has(id))
  const ledger = createContentPublicationLedger(db)
  for (let offset = 0; offset < releaseIds.length; offset += 400) {
    const keys = await ledger.keysForContent(db, {
      owner: 'skill-content',
      scope: skillId,
      contentIds: releaseIds.slice(offset, offset + 400),
    })
    await ledger.release(db, { owner: 'skill-content', keys, scope: skillId }, Date.now())
  }
}

export async function writeTree(
  db: Handle,
  skillId: string,
  tree: string,
  files: readonly SkillTreeFile[],
  now: number,
): Promise<void> {
  await deleteTree(db, skillId, tree)
  const store = createContentStore({
    db,
    policy: databaseContentPolicy,
    now: () => now,
    transaction: (body) => body(db),
  })
  const rows: PersistenceTables['skillContentEntries']['$inferInsert'][] = []
  for (const file of files) {
    const path = normalizeSkillPath(file.path)
    const attempt = crypto.randomUUID()
    await store.put(
      {
        publication: {
          owner: 'skill-content',
          logicalKey: JSON.stringify([skillId, attempt]),
          scope: skillId,
          attempt,
          epoch: 0,
          sha256: sha256Hex(file.bytes),
          size: file.bytes.byteLength,
        },
        source: { kind: 'bytes', bytes: file.bytes },
        contentVersion: 1,
        mediaType: null,
        references: 'single',
      },
      async (_tx, ref) => {
        const encoded = contentRefColumns.encode(ref)
        rows.push({
          skillId,
          tree,
          path,
          contentRefJson: encoded.json,
          contentInlineBytes:
            encoded.inlineBytes === null ? null : Buffer.from(encoded.inlineBytes),
          size: file.bytes.byteLength,
          updatedAt: now,
        })
      },
    )
  }
  const { skillContentEntries } = tablesOf(db)
  for (let offset = 0; offset < rows.length; offset += 200)
    await db.insert(skillContentEntries).values(rows.slice(offset, offset + 200))
  if (tree === 'live') {
    const { skills } = tablesOf(db)
    await db
      .update(skills)
      .set(skillTreeColumns(skillId, tree, 'database-bytes'))
      .where(eq(skills.id, skillId))
  }
}

export async function copyTree(
  db: Handle,
  skillId: string,
  from: string,
  to: string,
  now: number,
): Promise<void> {
  if (from === to) return
  const { skillContentEntries } = tablesOf(db)
  const rows = await db
    .select()
    .from(skillContentEntries)
    .where(and(eq(skillContentEntries.skillId, skillId), eq(skillContentEntries.tree, from)))
  await deleteTree(db, skillId, to)
  const copies = rows.map((row) => ({ ...row, tree: to, updatedAt: now }))
  for (let offset = 0; offset < copies.length; offset += 200)
    await db.insert(skillContentEntries).values(copies.slice(offset, offset + 200))
}

/** Every tree of a skill except deletion trash. */
export async function liveTreeNames(db: Handle, skillId: string): Promise<readonly string[]> {
  const { skillContentEntries } = tablesOf(db)
  const rows = await db
    .selectDistinct({ tree: skillContentEntries.tree })
    .from(skillContentEntries)
    .where(eq(skillContentEntries.skillId, skillId))
  return rows.map((row) => row.tree).filter((tree) => !tree.startsWith(TRASH_PREFIX))
}

export async function trashTreeNames(
  db: Handle,
  skillId: string,
  operationId: string,
): Promise<readonly string[]> {
  // A skill holds only a handful of trees: filter by the exact machine prefix
  // here rather than with a LIKE pattern.
  const prefix = trashTreePrefix(operationId)
  const { skillContentEntries } = tablesOf(db)
  const rows = await db
    .selectDistinct({ tree: skillContentEntries.tree })
    .from(skillContentEntries)
    .where(eq(skillContentEntries.skillId, skillId))
  return rows.map((row) => row.tree).filter((tree) => tree.startsWith(prefix))
}

export async function renameTree(
  db: Handle,
  skillId: string,
  from: string,
  to: string,
): Promise<void> {
  const { skillContentEntries } = tablesOf(db)
  await db
    .update(skillContentEntries)
    .set({ tree: to })
    .where(and(eq(skillContentEntries.skillId, skillId), eq(skillContentEntries.tree, from)))
}

/** Directory nodes are inferred from file paths; files carry size and last write time. */
export function fileNodesOf(rows: readonly EntryRow[]): FileNode[] {
  const out: FileNode[] = []
  const seenDirectories = new Set<string>()
  for (const row of [...rows].sort((left, right) => (left.path < right.path ? -1 : 1))) {
    const parts = row.path.split('/')
    let directory = ''
    for (let index = 0; index < parts.length - 1; index++) {
      directory = directory === '' ? parts[index]! : `${directory}/${parts[index]}`
      if (!seenDirectories.has(directory)) {
        seenDirectories.add(directory)
        out.push({ path: directory, type: 'dir' })
      }
    }
    out.push({ path: row.path, type: 'file', size: row.size, modifiedAt: row.updatedAt })
  }
  return out
}

/** Tree identity is explicit even when no local filesystem exists. */
export function skillTreeName(tree: SkillContentTree): string {
  switch (tree.kind) {
    case 'live':
      return 'live'
    case 'version':
      return `version:${tree.version}`
    case 'staging':
      return `staging:${tree.operationId}`
    case 'candidate':
      return `candidate:${tree.candidateId}`
    case 'trash':
      return `trash:${tree.operationId}|${skillTreeName(tree.original)}`
  }
}

export function skillTreeReference(
  skillId: string,
  tree: string,
  kind: 'database-bytes' | 'local-file',
  path?: string,
): ContentRef {
  if (kind === 'local-file' && path === undefined) throw new Error('skill-local-reference-missing')
  return {
    version: 1,
    kind,
    location:
      kind === 'database-bytes'
        ? { codec: 'skill-tree', value: { skillId, tree } }
        : { codec: 'skill-path', value: path! },
    contentId: null,
    contentVersion: null,
    sha256: null,
    size: null,
    mediaType: null,
  }
}

export function skillTreeColumns(
  skillId: string,
  tree: string,
  kind: 'database-bytes' | 'local-file',
  path?: string,
) {
  const encoded = contentRefColumns.encode(skillTreeReference(skillId, tree, kind, path))
  return {
    contentRefJson: encoded.json,
    contentInlineBytes: encoded.inlineBytes === null ? null : Buffer.from(encoded.inlineBytes),
  }
}

/** Storage kind is a deployment binding fact, independent of publish timing. */
export function capturedSkillTreeColumns(
  kind: 'database-bytes' | 'local-file',
  skillId: string,
  tree: string,
  path: string,
) {
  return skillTreeColumns(skillId, tree, kind, path)
}

export function skillReferencePath(
  ref: ContentRef | null,
  skillId: string,
  tree: string,
): string | null {
  if (ref === null) return null
  if (
    ref.kind === 'local-file' &&
    ref.location.codec === 'skill-path' &&
    typeof ref.location.value === 'string'
  )
    return ref.location.value
  if (ref.kind === 'database-bytes' && ref.location.codec === 'skill-tree') {
    const location = ref.location.value as { skillId?: unknown; tree?: unknown }
    if (location?.skillId !== skillId || location.tree !== tree)
      throw new Error('skill-tree-identity-mismatch')
    if (tree === 'live') return `skills/${skillId}/files`
    if (/^version:[1-9][0-9]*$/.test(tree))
      return `skills/${skillId}/versions/v${tree.slice(8)}/files`
  }
  throw new Error('skill-tree-reference-invalid')
}

export function skillRowPath(
  row: { contentRefJson: string | null; contentInlineBytes: Uint8Array | null },
  skillId: string,
  tree: string,
): string | null {
  return skillReferencePath(
    contentRefColumns.decode(row.contentRefJson, row.contentInlineBytes),
    skillId,
    tree,
  )
}

export function createSkillContentLocationQuery(
  db: PersistenceDb,
  appHome?: string,
): SkillContentLocationQuery {
  const locate: SkillContentLocationQuery['locate'] = async (skillId, tree) => {
    const { skills, skillVersions } = tablesOf(db)
    if (tree.kind === 'live') {
      const row = (
        await db
          .select({ json: skills.contentRefJson, bytes: skills.contentInlineBytes })
          .from(skills)
          .where(eq(skills.id, skillId))
          .limit(1)
      )[0]
      return row === undefined ? null : contentRefColumns.decode(row.json, row.bytes)
    }
    if (tree.kind === 'version') {
      const row = (
        await db
          .select({ json: skillVersions.contentRefJson, bytes: skillVersions.contentInlineBytes })
          .from(skillVersions)
          .where(
            and(eq(skillVersions.skillId, skillId), eq(skillVersions.versionIndex, tree.version)),
          )
          .limit(1)
      )[0]
      return row === undefined ? null : contentRefColumns.decode(row.json, row.bytes)
    }
    const name = skillTreeName(tree)
    if (await treeExists(db, skillId, name))
      return skillTreeReference(skillId, name, 'database-bytes')
    if (appHome === undefined) return null
    const path = localSkillTreePath(skillId, tree)
    return existsSync(join(appHome, path))
      ? skillTreeReference(skillId, name, 'local-file', path)
      : null
  }
  return {
    locate,
    async publication(skillId, version) {
      const { skills, skillVersions } = tablesOf(db)
      const row = (
        await db
          .select({
            contentVersion: skills.contentVersion,
            json: skills.contentRefJson,
            bytes: skills.contentInlineBytes,
            snapshotVersion: skillVersions.versionIndex,
            snapshotJson: skillVersions.contentRefJson,
            snapshotBytes: skillVersions.contentInlineBytes,
            contentHash: skillVersions.contentHash,
          })
          .from(skills)
          .leftJoin(
            skillVersions,
            and(eq(skillVersions.skillId, skills.id), eq(skillVersions.versionIndex, version)),
          )
          .where(eq(skills.id, skillId))
          .limit(1)
      )[0]
      if (row === undefined) return null
      const content = contentRefColumns.decode(row.snapshotJson, row.snapshotBytes)
      return {
        skillId,
        contentVersion: row.contentVersion,
        live: contentRefColumns.decode(row.json, row.bytes),
        snapshot:
          row.snapshotVersion === null || content === null
            ? null
            : { version: row.snapshotVersion, content, contentHash: row.contentHash },
      }
    },
  }
}

function localSkillTreePath(skillId: string, tree: SkillContentTree): string {
  const root = skillRootRel(skillId)
  switch (tree.kind) {
    case 'live':
      return `${root}/files`
    case 'version':
      return `${root}/versions/v${tree.version}/files`
    case 'staging':
      return skillStagingPath(skillId, assertPathSegment(tree.operationId, 'skill operation id'))
    case 'candidate':
      return `${root}/candidates/${assertPathSegment(tree.candidateId, 'skill candidate id')}/files`
    case 'trash':
      return `${skillTrashPath(skillId, tree.operationId)}/${localSkillTreePath(skillId, tree.original).slice(root.length + 1)}`
  }
}
