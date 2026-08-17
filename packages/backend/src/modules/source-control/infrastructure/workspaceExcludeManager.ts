import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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

function resolveGitPath(worktreePath: string, raw: string): string {
  return realpathSync(isAbsolute(raw) ? raw : resolve(worktreePath, raw))
}

function assertOwnedBy(worktreePath: string, appHome?: string): void {
  if (appHome === undefined) return
  const root = realpathSync(appHome)
  const wt = realpathSync(worktreePath)
  const wtRel = relative(root, wt)
  if (wtRel === '..' || wtRel.startsWith(`..${sep}`) || isAbsolute(wtRel)) {
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
    ['rev-parse', '--git-dir'],
    'resolve git dir',
  )
  const gitDir = resolveGitPath(input.worktreePath, gitDirRaw)
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
  if (
    existingWorktreeExclude.exitCode === 0 &&
    resolve(existingWorktreeExclude.stdout.trim()) !== resolve(profilePath)
  ) {
    throw new DomainError(
      'workspace-exclude-config-conflict',
      'worktree already has a non-platform core.excludesFile',
      409,
    )
  }

  let inherited = ''
  if (existingWorktreeExclude.exitCode !== 0) {
    const effective = await runGit(input.worktreePath, [
      'config',
      '--path',
      '--get',
      'core.excludesFile',
    ])
    if (effective.exitCode === 0) {
      const inheritedPath = effective.stdout.trim()
      if (inheritedPath !== '' && existsSync(inheritedPath)) {
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
  } else if (existsSync(profilePath)) {
    const current = readFileSync(profilePath, 'utf8')
    const marker = '# agent-workflow platform excludes v1'
    const at = current.indexOf(marker)
    inherited = at > 0 ? current.slice(0, at).replace(/\n+$/, '') : ''
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
