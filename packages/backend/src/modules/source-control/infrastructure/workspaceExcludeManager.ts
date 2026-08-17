import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { runGit } from '@/util/git'
import { DomainError } from '@/util/errors'
import { planWorkspaceExcludeProfile } from '../domain/workspaceExcludeProfile'
import type { WorkspaceExcludeProfileReceipt } from '../public/types'

function assertDirectoryChain(path: string): void {
  const parent = dirname(path)
  if (parent !== path && !existsSync(parent)) assertDirectoryChain(parent)
  if (!existsSync(path)) {
    mkdirSync(path, { mode: 0o700 })
    return
  }
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new DomainError(
      'workspace-exclude-path-unsafe',
      'platform exclude path is not a plain directory',
      500,
    )
  }
}

async function gitOutput(worktreePath: string, args: string[], stage: string): Promise<string> {
  const result = await runGit(worktreePath, args)
  if (result.exitCode !== 0) {
    throw new DomainError(
      'workspace-exclude-config-failed',
      `${stage}: ${result.stderr.trim() || result.stdout.trim()}`,
      500,
    )
  }
  return result.stdout.trim()
}

function normalizeGitPath(raw: string): string {
  if (process.platform !== 'win32') return raw
  if (/^\/[A-Za-z]:[\\/]/.test(raw)) return raw.slice(1)
  const msysDrive = /^\/([A-Za-z])(?:[\\/]|$)/.exec(raw)
  return msysDrive === null ? raw : `${msysDrive[1]}:${raw.slice(2)}`
}

function configuredPath(worktreePath: string, raw: string): string {
  const normalized = normalizeGitPath(raw)
  return isAbsolute(normalized) ? resolve(normalized) : resolve(worktreePath, normalized)
}

function resolveGitPath(worktreePath: string, raw: string): string {
  return realpathSync(configuredPath(worktreePath, raw))
}

const PROFILE_MARKER = '# agent-workflow platform excludes v1'
const PROFILE_HEADER = `${PROFILE_MARKER}\n# managed outside the business repository; do not edit\n/.agent-workflow/\n`

function pathKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function normalizedRelative(path: string): string {
  return path.replace(/\\/g, '/')
}

function escapesRoot(path: string): boolean {
  const normalized = normalizedRelative(path)
  return normalized === '..' || normalized.startsWith('../') || isAbsolute(path)
}

/**
 * `git worktree add` copies the source worktree's `config.worktree`, including
 * its platform-owned `core.excludesFile`. Accept only that exact Git-admin
 * shape, recover its user prefix, then rebind the new worktree to its own
 * profile. An arbitrary repository/user path remains a hard conflict.
 */
function inheritedFromPlatformProfile(path: string, commonDir: string): string | null {
  if (!existsSync(path)) return null
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null

  const common = realpathSync(commonDir)
  const actual = realpathSync(path)
  const rel = relative(common, actual)
  if (escapesRoot(rel)) return null
  const parts = normalizedRelative(rel).split('/')
  const canonicalShape =
    (parts.length === 3 &&
      parts[0] === 'agent-workflow' &&
      parts[1] === 'excludes' &&
      parts[2] === 'v1') ||
    (parts.length === 5 &&
      parts[0] === 'worktrees' &&
      parts[1] !== '' &&
      parts[2] === 'agent-workflow' &&
      parts[3] === 'excludes' &&
      parts[4] === 'v1')
  if (!canonicalShape) return null

  const content = readFileSync(actual, 'utf8')
  const at = content.lastIndexOf(PROFILE_HEADER)
  if (at < 0 || (at > 0 && content[at - 1] !== '\n')) return null
  return at === 0 ? '' : content.slice(0, at).replace(/\n+$/, '')
}

function assertOwnedBy(worktreePath: string, appHome?: string): void {
  if (appHome === undefined) return
  const root = realpathSync(appHome)
  const wt = realpathSync(worktreePath)
  const wtRel = relative(root, wt)
  if (escapesRoot(wtRel)) {
    throw new DomainError(
      'workspace-exclude-owner-mismatch',
      'worktree is outside the platform home',
      409,
    )
  }
}

export async function ensureWorkspaceExcludeProfile(input: {
  worktreePath: string
  appHome?: string
  directChildMounts?: readonly string[]
}): Promise<WorkspaceExcludeProfileReceipt> {
  const gitDirRaw = await gitOutput(
    input.worktreePath,
    ['rev-parse', '--path-format=absolute', '--git-dir'],
    'resolve git dir',
  )
  const gitDir = resolveGitPath(input.worktreePath, gitDirRaw)
  const commonDirRaw = await gitOutput(
    input.worktreePath,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    'resolve common git dir',
  )
  const commonDir = resolveGitPath(input.worktreePath, commonDirRaw)
  assertOwnedBy(input.worktreePath, input.appHome)

  const worktreeConfig = await runGit(input.worktreePath, [
    'config',
    '--local',
    '--bool',
    '--get',
    'extensions.worktreeConfig',
  ])
  if (worktreeConfig.exitCode === 0 && worktreeConfig.stdout.trim() === 'false') {
    throw new DomainError(
      'workspace-exclude-config-conflict',
      'repository explicitly disables extensions.worktreeConfig',
      409,
    )
  }

  const profilePath = join(gitDir, 'agent-workflow', 'excludes', 'v1')
  const existingWorktreeExclude = await runGit(input.worktreePath, [
    'config',
    '--worktree',
    '--path',
    '--get',
    'core.excludesFile',
  ])
  let inherited = ''
  if (existingWorktreeExclude.exitCode !== 0) {
    const effective = await runGit(input.worktreePath, [
      'config',
      '--path',
      '--get',
      'core.excludesFile',
    ])
    if (effective.exitCode === 0) {
      const inheritedRaw = effective.stdout.trim()
      if (inheritedRaw !== '') {
        const inheritedPath = configuredPath(input.worktreePath, inheritedRaw)
        if (existsSync(inheritedPath)) {
          const stat = lstatSync(inheritedPath)
          if (!stat.isFile() || stat.size > 1024 * 1024) {
            throw new DomainError(
              'workspace-exclude-inherited-invalid',
              'existing core.excludesFile is not a bounded regular file',
              409,
            )
          }
          inherited = readFileSync(inheritedPath, 'utf8')
        }
      }
    }
  } else {
    const existingPath = configuredPath(input.worktreePath, existingWorktreeExclude.stdout.trim())
    if (pathKey(existingPath) === pathKey(profilePath)) {
      inherited = inheritedFromPlatformProfile(existingPath, commonDir) ?? ''
    } else {
      const copiedPlatformInheritance = inheritedFromPlatformProfile(existingPath, commonDir)
      if (copiedPlatformInheritance === null) {
        throw new DomainError(
          'workspace-exclude-config-conflict',
          `worktree already has a non-platform core.excludesFile (configured='${existingPath}', common='${commonDir}', desired='${profilePath}')`,
          409,
        )
      }
      inherited = copiedPlatformInheritance
    }
  }

  const plan = planWorkspaceExcludeProfile({
    inherited,
    directChildMounts: input.directChildMounts ?? [],
  })
  assertDirectoryChain(dirname(profilePath))
  const temp = `${profilePath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temp, plan.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  renameSync(temp, profilePath)

  await gitOutput(
    input.worktreePath,
    ['config', 'extensions.worktreeConfig', 'true'],
    'enable worktree config',
  )
  await gitOutput(
    input.worktreePath,
    ['config', '--worktree', 'core.excludesFile', profilePath],
    'bind worktree excludes',
  )

  for (const directory of ['.agent-workflow', ...plan.directChildMounts]) {
    const probe = `${directory.replace(/\/+$/, '')}/.agent-workflow-ignore-probe`
    const ignored = await runGit(input.worktreePath, [
      'check-ignore',
      '--no-index',
      '-q',
      '--',
      probe,
    ])
    if (ignored.exitCode !== 0) {
      throw new DomainError(
        'workspace-exclude-profile-ineffective',
        `business ignore precedence prevents the platform profile from excluding '${directory}'`,
        409,
      )
    }
  }

  return {
    version: 1,
    digest: plan.digest,
    directChildMounts: plan.directChildMounts,
  }
}
