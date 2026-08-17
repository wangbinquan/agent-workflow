import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { platformWorkspacePath, type PlatformWorkspaceKind } from '@agent-workflow/shared'
import { DomainError } from '@/util/errors'

/** Create a canonical platform directory without following a repository symlink. */
export function ensurePlatformWorkspaceDirectory(input: {
  worktreePath: string
  kind: PlatformWorkspaceKind
  segments?: readonly string[]
}): string {
  const rootStat = lstatSync(input.worktreePath)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new DomainError(
      'platform-workspace-path-unsafe',
      'task worktree is not a plain directory',
      409,
    )
  }
  const realRoot = realpathSync(input.worktreePath)
  const relativePath = platformWorkspacePath(input.kind, ...(input.segments ?? []))
  let current = input.worktreePath
  for (const segment of relativePath.split('/')) {
    current = join(current, segment)
    if (existsSync(current)) {
      const stat = lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new DomainError(
          'platform-workspace-path-unsafe',
          'platform workspace contains a symlink or non-directory component',
          409,
        )
      }
    } else {
      mkdirSync(current, { mode: 0o700 })
    }
    const actual = realpathSync(current)
    const rel = relative(realRoot, actual)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new DomainError(
        'platform-workspace-path-unsafe',
        'platform workspace resolves outside the task worktree',
        409,
      )
    }
  }
  return current
}
