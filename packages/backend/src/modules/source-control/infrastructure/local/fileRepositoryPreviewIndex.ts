import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit as defaultRunGit } from '@/util/git'
import type { RepositoryGit } from '../../application/repositoryCommit'
import type { RepositoryPreviewIndexPort } from '../../application/ports/repositoryPreviewIndex'

export function createFileRepositoryPreviewIndexPort(input: {
  repoPath: string
  runGit?: RepositoryGit
  gitOptions?: Parameters<RepositoryGit>[2]
}): RepositoryPreviewIndexPort {
  const runGit = input.runGit ?? defaultRunGit
  const repoPath = input.repoPath
  const baseOptions = input.gitOptions
  return {
    async withIndex(operation) {
      const tempDir = mkdtempSync(join(tmpdir(), 'aw-commit-index-'))
      const tempIndex = join(tempDir, 'index')
      try {
        const gitOptions = {
          ...baseOptions,
          env: { ...(baseOptions?.env ?? {}), GIT_INDEX_FILE: tempIndex },
        }
        return await operation({
          run: (args, options) =>
            runGit(
              repoPath,
              [...args],
              options?.literalPathspecs === true
                ? {
                    ...gitOptions,
                    env: { ...gitOptions.env, GIT_LITERAL_PATHSPECS: '1' },
                  }
                : gitOptions,
            ),
        })
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    },
  }
}
