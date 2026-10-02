import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { TaskArchiveContentPort } from '../../application/ports/taskArchiveContent'

/** Original standalone restoration mechanism; archive decisions remain with the coordinator. */
export function restoreFileArchiveMovedDirectories(
  tmpDir: string,
  kind: 'runs' | 'logs',
  root: string,
): boolean {
  const movedRoot = join(tmpDir, kind)
  if (!existsSync(movedRoot)) return true
  mkdirSync(root, { recursive: true })
  for (const entry of readdirSync(movedRoot)) {
    const from = join(movedRoot, entry)
    const to = join(root, entry)
    if (existsSync(to)) return false
    renameSync(from, to)
  }
  return true
}

export function createFileTaskArchiveContent(): TaskArchiveContentPort {
  return {
    resolve: (reference, ...segments) => join(reference, ...segments),
    exists: (reference) => existsSync(reference),
    list: (reference) => readdirSync(reference),
    createDirectory(reference) {
      mkdirSync(reference, { recursive: true })
    },
    remove: (reference, recursive) =>
      rmSync(reference, { ...(recursive === true ? { recursive: true } : {}), force: true }),
    move: (from, to) => renameSync(from, to),
    appendText: (reference, text) => appendFileSync(reference, text, 'utf8'),
    writeText: (reference, text) => writeFileSync(reference, text, 'utf8'),
    restoreMovedDirectories: restoreFileArchiveMovedDirectories,
  }
}
