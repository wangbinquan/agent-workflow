import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'
import { runGit as defaultRunGit } from '@/util/git'
import type { RepositoryGit } from '../../application/repositoryCommit'
import type { ConflictMergeWorkspaceEffects } from '../../application/ports/conflictMergeWorkspaceEffects'

/** Native mechanics retain the original clone, exclude, read and parent cleanup. */
export function createFileConflictMergeWorkspaceEffects(
  runGit: RepositoryGit = defaultRunGit,
): ConflictMergeWorkspaceEffects {
  return Object.freeze({
    allocate(storageRootReference?: string) {
      let parent: string
      if (storageRootReference === undefined) {
        parent = mkdtempSync(join(tmpdir(), 'aw-conflict-'))
      } else {
        mkdirSync(storageRootReference, { recursive: true })
        parent = mkdtempSync(join(storageRootReference, 'conflict-'))
      }
      return join(parent, 'ws')
    },
    cloneBaseline(workspaceReference, baselineReference) {
      return runGit(dirname(workspaceReference), [
        'clone',
        '--no-hardlinks',
        '--quiet',
        baselineReference,
        workspaceReference,
      ])
    },
    run(workspaceReference, args, options) {
      return runGit(workspaceReference, args as string[], options)
    },
    installPlatformExclude(workspaceReference) {
      mkdirSync(join(workspaceReference, '.git', 'info'), { recursive: true })
      writeFileSync(
        join(workspaceReference, '.git', 'info', 'exclude'),
        `${PLATFORM_WORKSPACE_DIR}/\n`,
      )
    },
    readConflictFile(workspaceReference, relativePath) {
      const abs = join(workspaceReference, relativePath)
      if (!existsSync(abs)) return null
      try {
        return readFileSync(abs, 'utf8')
      } catch {
        return null
      }
    },
    mergeHeadExists(workspaceReference) {
      return existsSync(join(workspaceReference, '.git', 'MERGE_HEAD'))
    },
    discard(workspaceReference) {
      if (basename(workspaceReference) !== 'ws') {
        throw new Error('conflict workspace cleanup refused an unexpected path')
      }
      rmSync(dirname(workspaceReference), { recursive: true, force: true })
    },
  } satisfies ConflictMergeWorkspaceEffects)
}
