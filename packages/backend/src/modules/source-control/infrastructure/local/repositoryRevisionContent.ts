// RFC-370 §10 V16 — revision content of a worktree on this host. Each read is
// the Git or filesystem primitive the code-review services called directly
// before the port existed; the task image runs this same adapter against its
// volume (`../crewstation/codeReviewVolumeOperation.ts`).
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import {
  gitChangedEntries,
  gitChangedEntriesBetween,
  gitDiffNumstat,
  gitGrepFiles,
  isGitWorkTree,
  readBlobAtRef,
} from '@/util/git'
import { toPortableRelativePath } from '@/util/platformExec'
import { worktreeSnapshotDigest } from '@/services/codeIntel/snapshot'
import { buildClassIndex, scanClassDecls } from '@/services/structuralDiff/callGraph/classIndex'
import { resolveLang } from '@/services/structuralDiff/lang/grammars'
import type {
  RepositoryClassIndex,
  RepositoryRevisionContent,
  RepositoryRevisionContentFactory,
  RevisionFileRead,
  WorktreeFileRead,
} from '../../application/ports/repositoryRevisionContent'
import { openContainedFileWithin, type ContainedFileHooks } from './containedFileRead'

/** A NUL in the first 8 KiB is the binary signal Git itself uses. */
const NUL_PROBE_CHARS = 8192

/** RFC-085 — the class index walk skips build/vendor trees and is bounded. */
const CLASS_INDEX_IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  'out',
  '.next',
  'vendor',
])
const CLASS_INDEX_MAX_FILES = 8000
const CLASS_INDEX_MAX_FILE_BYTES = 2_000_000

/** Revision blobs arrive as Git's decoded text, so the bound and the reported
 * size count that text (the file-content view always measured it this way). */
function revisionRead(blob: string | null, maxBytes: number): RevisionFileRead {
  if (blob === null) return { kind: 'absent' }
  if (blob.length > maxBytes) return { kind: 'oversized', size: blob.length }
  const probe = blob.length > NUL_PROBE_CHARS ? blob.slice(0, NUL_PROBE_CHARS) : blob
  if (probe.includes('\u0000')) return { kind: 'binary' }
  return { kind: 'text', content: blob, size: blob.length }
}

/** Source files under `root` (supported languages only), skipping common
 * build/vendor dirs. Bounded by CLASS_INDEX_MAX_FILES. */
async function listSourceFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= CLASS_INDEX_MAX_FILES) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (out.length >= CLASS_INDEX_MAX_FILES) return
      if (e.isDirectory()) {
        if (!CLASS_INDEX_IGNORE_DIRS.has(e.name) && !e.name.startsWith('.'))
          await walk(join(dir, e.name))
      } else if (e.isFile() && resolveLang(e.name) !== null) {
        // RFC-254 T32: these relative paths ARE the identifier. They become the
        // `ref` (`src/A.java#A.run`) and `ownerClass` that callers pass back in,
        // store, and display — and `relative` answers in the HOST spelling, so
        // on Windows the index produced `src\A.java#A.run` while every caller
        // and fixture spells it with `/`.
        out.push(toPortableRelativePath(relative(root, join(dir, e.name))))
      }
    }
  }
  await walk(root)
  return out
}

/** RFC-085 — shallow class→file index over every declaration line of the tree. */
async function buildRepositoryClassIndex(root: string): Promise<RepositoryClassIndex> {
  const perFile: Array<{ file: string; names: string[] }> = []
  for (const file of await listSourceFiles(root)) {
    try {
      const source = await readFile(join(root, file), 'utf8')
      if (source.length <= CLASS_INDEX_MAX_FILE_BYTES)
        perFile.push({ file, names: scanClassDecls(file, source) })
    } catch {
      // unreadable files are skipped
    }
  }
  return buildClassIndex(perFile)
}

export function bindLocalRepositoryRevisionContent(
  root: string,
  options: { readonly hooks?: ContainedFileHooks } = {},
): RepositoryRevisionContent {
  return Object.freeze<RepositoryRevisionContent>({
    capabilities: Object.freeze({ indexing: true, indexRoot: root }),
    async presence() {
      if (root === '' || !existsSync(root)) return 'absent'
      return (await isGitWorkTree(root)) ? 'git' : 'directory'
    },
    async changes(request) {
      if (request.to !== undefined)
        return { entries: await gitChangedEntriesBetween(root, request.from, request.to) }
      const entries = await gitChangedEntries(root, request.from)
      if (request.lineStats !== true) return { entries }
      return { entries, lineStats: await gitDiffNumstat(root, request.from) }
    },
    async readRevision(request) {
      const reads = new Map<string, RevisionFileRead>()
      for (const path of new Set(request.paths))
        reads.set(
          path,
          revisionRead(await readBlobAtRef(root, request.rev, path), request.maxBytes),
        )
      return reads
    },
    async readWorktree(request): Promise<WorktreeFileRead> {
      const read = openContainedFileWithin(root, request.path, request.maxBytes, options.hooks)
      switch (read.kind) {
        case 'ok':
          return { kind: 'text', content: read.content, size: read.size }
        case 'not-found':
          return { kind: 'absent' }
        case 'outside':
        case 'binary':
          return { kind: read.kind }
        case 'oversized':
          return { kind: 'oversized', size: read.size }
      }
    },
    grep: (patterns) => gitGrepFiles(root, [...patterns]),
    classIndex: () => buildRepositoryClassIndex(root),
    snapshotDigest: () => worktreeSnapshotDigest(root),
  })
}

/** Standalone selection: every reference is a native path on this host. */
export function createLocalRepositoryRevisionContentFactory(
  options: { readonly hooks?: ContainedFileHooks } = {},
): RepositoryRevisionContentFactory {
  return Object.freeze({
    bind: (workspaceRef: string) => bindLocalRepositoryRevisionContent(workspaceRef, options),
  })
}
