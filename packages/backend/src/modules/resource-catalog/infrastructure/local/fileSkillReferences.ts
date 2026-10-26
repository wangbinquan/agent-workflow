import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import type { ContentRef } from '@/platform/content/contentRef'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createSkillContentLocationQuery,
  readTreeRows,
  fileNodesOf,
  treeExists,
  skillTreeReference,
} from '../databaseSkillTrees'
import type { SkillContentReference } from '../../application/skills/contentReader'
import type { FileNode } from '@agent-workflow/shared'
import { realpathInside, safeJoin } from '@/util/safePath'
import { ValidationError } from '@/util/errors'

/** File reads retain the original local semantics; a full-tree listing is not a file lookup. */
export async function readFileSkillReferenceFile(
  appHome: string,
  db: PersistenceDb | undefined,
  ref: ContentRef | null,
  path: string,
): Promise<Uint8Array | null> {
  if (!ref) return null
  if (ref.kind === 'local-file') {
    const root = fileSkillReferencePath(appHome, ref)
    const absolute = safeJoin(root, path)
    if (!existsSync(absolute)) return null
    const actual = realpathInside(root, absolute)
    if (statSync(actual).isDirectory())
      throw new ValidationError('skill-file-is-dir', `'${path}' is a directory`)
    return new Uint8Array(readFileSync(actual))
  }
  return (
    (await readFileSkillReference(appHome, db, ref))?.files.find((file) => file.path === path)
      ?.bytes ?? null
  )
}

export async function fileSkillTreeReference(
  appHome: string,
  db: PersistenceDb | undefined,
  skillId: string,
  version?: number,
): Promise<ContentRef | null> {
  if (db)
    return createSkillContentLocationQuery(db).locate(
      skillId,
      version === undefined ? { kind: 'live' } : { kind: 'version', version },
    )
  const tree = version === undefined ? 'live' : `version:${version}`
  const path =
    version === undefined
      ? `skills/${skillId}/files`
      : `skills/${skillId}/versions/v${version}/files`
  return skillTreeReference(skillId, tree, 'local-file', path)
}
export function fileSkillReferencePath(appHome: string, ref: ContentRef): string {
  if (
    ref.kind !== 'local-file' ||
    ref.location.codec !== 'skill-path' ||
    typeof ref.location.value !== 'string'
  )
    throw new Error('skill-tree-reference-invalid')
  return resolve(appHome, ref.location.value)
}
function databaseTree(ref: ContentRef): { skillId: string; tree: string } {
  if (ref.kind !== 'database-bytes' || ref.location.codec !== 'skill-tree')
    throw new Error('skill-tree-reference-invalid')
  const location = ref.location.value as { skillId?: unknown; tree?: unknown }
  if (typeof location?.skillId !== 'string' || typeof location.tree !== 'string')
    throw new Error('skill-tree-reference-invalid')
  return { skillId: location.skillId, tree: location.tree }
}
export async function fileSkillReferenceExists(
  appHome: string,
  db: PersistenceDb | undefined,
  ref: ContentRef | null,
): Promise<boolean> {
  if (!ref) return false
  if (ref.kind === 'local-file') return existsSync(fileSkillReferencePath(appHome, ref))
  if (!db) throw new Error('skill-entry-reader-unavailable')
  const { skillId, tree } = databaseTree(ref)
  return treeExists(db, skillId, tree)
}
export async function currentFileSkillReference(
  appHome: string,
  db: PersistenceDb | undefined,
  reference: SkillContentReference,
): Promise<ContentRef | null> {
  if (reference.contentVersion > 0) {
    const snapshot = await fileSkillTreeReference(
      appHome,
      db,
      reference.id,
      reference.contentVersion,
    )
    if (await fileSkillReferenceExists(appHome, db, snapshot)) return snapshot
  }
  // Epoch-1 serves live between the version row commit and snapshot publication.
  return fileSkillTreeReference(appHome, db, reference.id)
}
export async function readFileSkillReference(
  appHome: string,
  db: PersistenceDb | undefined,
  ref: ContentRef | null,
): Promise<{ files: { path: string; bytes: Uint8Array }[]; nodes: FileNode[] } | null> {
  if (!(await fileSkillReferenceExists(appHome, db, ref)) || !ref) return null
  if (ref.kind === 'database-bytes') {
    if (!db) throw new Error('skill-entry-reader-unavailable')
    const { skillId, tree } = databaseTree(ref)
    const rows = await readTreeRows(db, skillId, tree)
    return {
      files: rows
        .map(({ path, bytes }) => ({ path, bytes }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      nodes: fileNodesOf(rows),
    }
  }
  const root = fileSkillReferencePath(appHome, ref)
  const files: { path: string; bytes: Uint8Array }[] = [],
    nodes: FileNode[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        nodes.push({ path, type: 'dir' })
        walk(path)
      } else if (entry.isFile()) {
        const stat = statSync(join(root, path))
        nodes.push({ path, type: 'file', size: stat.size, modifiedAt: Math.floor(stat.mtimeMs) })
        files.push({ path, bytes: new Uint8Array(readFileSync(join(root, path))) })
      }
    }
  }
  walk('')
  return { files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), nodes }
}
