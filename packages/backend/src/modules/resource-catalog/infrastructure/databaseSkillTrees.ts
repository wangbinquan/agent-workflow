// RFC-370 M0 — skill file trees kept in the database (`skill_content_entries`).
//
// A deployment without a persistent local disk keeps each skill's live tree,
// immutable versions, in-flight staging trees and deletion trash as rows. Every
// tree operation runs in one transaction, so the crash windows the filesystem
// funnel recovers from (half-renamed directories, partial copies) do not exist.
// The tree hash is the canonical skill-tree digest (`digestSortedTree`, the
// one `hashDir` uses), so a tree hashes the same in either store.
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import type { FileNode } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { ValidationError } from '@/util/errors'
import { digestSortedTree } from './legacy/skillHash'

export const LIVE_TREE = 'live'
export const versionTree = (version: number): string => `version:${version}`
export const stagingTree = (publicationId: string): string => `staging:${publicationId}`
const TRASH_PREFIX = 'trash:'
export const trashTreeOf = (operationId: string, tree: string): string =>
  `${TRASH_PREFIX}${operationId}|${tree}`
export const trashTreePrefix = (operationId: string): string => `${TRASH_PREFIX}${operationId}|`

export interface SkillTreeFile {
  readonly path: string
  readonly bytes: Uint8Array
}

type Handle = Pick<PersistenceDb, 'select' | 'selectDistinct' | 'insert' | 'delete' | 'update'>
type EntryRow = PersistenceTables['skillContentEntries']['$inferSelect']

const INSERT_CHUNK = 200

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

export function decodeEntry(row: Pick<EntryRow, 'encoding' | 'content'>): Uint8Array {
  return row.encoding === 'utf8'
    ? new TextEncoder().encode(row.content)
    : new Uint8Array(Buffer.from(row.content, 'base64'))
}

function encodeBytes(bytes: Uint8Array): Pick<EntryRow, 'encoding' | 'content'> {
  // A leading byte-order mark is kept as bytes (RFC-370 §10 V20): text layers
  // between here and the column drop it (the default decoder, and the SQLite
  // driver's text read), so a SKILL.md with a BOM came back 3 bytes short — a
  // different skill-tree digest.
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  if (!bom && !bytes.includes(0)) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return { encoding: 'utf8', content: text }
    } catch {
      // Not UTF-8: fall through to base64.
    }
  }
  return { encoding: 'base64', content: Buffer.from(bytes).toString('base64') }
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
  return await db
    .select()
    .from(skillContentEntries)
    .where(and(eq(skillContentEntries.skillId, skillId), eq(skillContentEntries.tree, tree)))
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
  await db
    .delete(skillContentEntries)
    .where(and(eq(skillContentEntries.skillId, skillId), eq(skillContentEntries.tree, tree)))
}

export async function writeTree(
  db: Handle,
  skillId: string,
  tree: string,
  files: readonly SkillTreeFile[],
  now: number,
): Promise<void> {
  await deleteTree(db, skillId, tree)
  const rows = files.map((file) => ({
    skillId,
    tree,
    path: normalizeSkillPath(file.path),
    ...encodeBytes(file.bytes),
    size: file.bytes.byteLength,
    updatedAt: now,
  }))
  for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK) {
    const { skillContentEntries } = tablesOf(db)
    await db.insert(skillContentEntries).values(rows.slice(offset, offset + INSERT_CHUNK))
  }
}

export async function copyTree(
  db: Handle,
  skillId: string,
  from: string,
  to: string,
  now: number,
): Promise<void> {
  await writeTree(db, skillId, to, await readTree(db, skillId, from), now)
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
