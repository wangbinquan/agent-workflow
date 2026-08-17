// RFC-308 — one Gitignore-compatible policy for every platform-owned commit.

import { createHash } from 'node:crypto'
import createIgnore from 'ignore'
import { PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'

export interface TaskCommitPolicy {
  readonly version: 1
  readonly digest: string
  readonly configuredPatterns: readonly string[]
  isExcluded(path: string, directory?: boolean): boolean
}

function canonicalPath(path: string): string {
  // Git name-status/pathspec output is `/`-separated on every host. A literal
  // backslash is therefore a filename character (and Gitignore escape input),
  // not a Windows separator to rewrite.
  return path.replace(/^\.\//, '').replace(/^\/+/, '')
}

export function createTaskCommitPolicy(input: {
  configuredPatterns?: readonly string[]
  ignoreCase?: boolean
}): TaskCommitPolicy {
  const configuredPatterns = [...(input.configuredPatterns ?? [])]
  const matcher = createIgnore({ ignorecase: input.ignoreCase === true })
  matcher.add(configuredPatterns)
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        configuredPatterns,
        hardRoots: [PLATFORM_WORKSPACE_DIR],
        ignoreCase: input.ignoreCase === true,
      }),
    )
    .digest('hex')

  return Object.freeze({
    version: 1 as const,
    digest,
    configuredPatterns: Object.freeze(configuredPatterns),
    isExcluded(path: string, directory = false): boolean {
      const normalized = canonicalPath(path)
      if (
        normalized === PLATFORM_WORKSPACE_DIR ||
        normalized.startsWith(`${PLATFORM_WORKSPACE_DIR}/`)
      ) {
        return true
      }
      if (normalized === '') return false
      const candidate = directory && !normalized.endsWith('/') ? `${normalized}/` : normalized
      return matcher.ignores(candidate)
    },
  })
}
