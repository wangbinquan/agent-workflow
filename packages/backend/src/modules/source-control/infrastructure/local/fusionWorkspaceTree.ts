// RFC-370 §10 V20 — the native fusion working copy, moved unchanged from the
// fusion orchestration (RFC-101 / RFC-170 T6): the seed is written into the
// directory, `git init -b fusion`, the platform exclude profile and the
// `.agent-workflow/fusion` directory are put in place, everything is committed
// as `fusion baseline`, and a re-run's prior proposal replaces the working copy
// as uncommitted changes. Both the standalone adapter and the hosted task-image
// command run these exact steps.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { PLATFORM_FUSION_MANIFEST, PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'
import { gitDiffSnapshot, runGit } from '@/util/git'
import type {
  FusionWorkspaceFile,
  FusionWorkspaceManifest,
  FusionWorkspaceResult,
} from '../../application/ports/fusionWorkspaceEffects'
import { ensurePlatformWorkspaceDirectory } from '../platformWorkspaceDirectory'
import { ensureWorkspaceExcludeProfile } from '../workspaceExcludeManager'

export type FusionWorkspaceGit = typeof runGit

/** Relative POSIX paths inside the working copy, never its Git or platform directory. */
function targetOf(root: string, path: string): string {
  const segments = path.split('/')
  if (
    path.length === 0 ||
    path.includes('\\') ||
    path.includes('\0') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    segments[0] === '.git' ||
    segments[0] === PLATFORM_WORKSPACE_DIR
  ) {
    throw new ValidationError('fusion-workspace-path-invalid', `invalid skill file path: ${path}`)
  }
  const target = resolve(root, ...segments)
  if (!target.startsWith(resolve(root) + sep)) {
    throw new ValidationError('fusion-workspace-path-invalid', `invalid skill file path: ${path}`)
  }
  return target
}

function writeTree(root: string, files: readonly FusionWorkspaceFile[]): void {
  for (const file of files) {
    const target = targetOf(root, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content)
  }
}

/** git init the work dir, commit the seed as the baseline, return the baseline (root) sha. */
export async function seedFusionWorktree(input: {
  readonly workDir: string
  readonly base: readonly FusionWorkspaceFile[]
  readonly overlay: readonly FusionWorkspaceFile[] | null
  readonly appHome?: string
  readonly git?: FusionWorkspaceGit
}): Promise<string> {
  const workDir = input.workDir
  const git = input.git ?? runGit
  const checkedGit = async (stage: string, args: string[]) => {
    const result = await git(workDir, args)
    if (result.exitCode !== 0) {
      const reason = result.stderr.trim() || result.stdout.trim() || `git exited ${result.exitCode}`
      throw new Error(`failed to ${stage} fusion worktree: ${reason}`)
    }
    return result
  }

  mkdirSync(workDir, { recursive: true })
  writeTree(workDir, input.base)
  await checkedGit('initialize', ['init', '-b', 'fusion'])
  await ensureWorkspaceExcludeProfile({
    worktreePath: workDir,
    ...(input.appHome === undefined ? {} : { appHome: input.appHome }),
    directChildMounts: [],
  })
  ensurePlatformWorkspaceDirectory({ worktreePath: workDir, kind: 'fusion' })
  await checkedGit('stage baseline for', [
    '-c',
    'user.name=agent-workflow',
    '-c',
    'user.email=agent-workflow@local',
    'add',
    '-A',
  ])
  await checkedGit('commit baseline for', [
    '-c',
    'user.name=agent-workflow',
    '-c',
    'user.email=agent-workflow@local',
    'commit',
    '--allow-empty',
    '-m',
    'fusion baseline',
  ])
  const head = await checkedGit('resolve baseline for', ['rev-list', '--max-parents=0', 'HEAD'])
  const baseCommit = head.stdout.trim()
  if (baseCommit === '')
    throw new Error('failed to resolve baseline for fusion worktree: empty SHA')
  // The PRIOR proposal replaces the working copy as uncommitted changes, so the
  // agent refines its last attempt while the diff vs the baseline stays full.
  if (input.overlay !== null) {
    for (const entry of readdirSync(workDir)) {
      if (entry === '.git') continue
      rmSync(join(workDir, entry), { recursive: true, force: true })
    }
    writeTree(workDir, input.overlay)
  }
  return baseCommit
}

function readManifest(workDir: string): FusionWorkspaceManifest {
  const manifestPath = join(workDir, PLATFORM_FUSION_MANIFEST)
  if (!existsSync(manifestPath)) return { kind: 'missing' }
  const manifestStat = lstatSync(manifestPath)
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) return { kind: 'not-a-file' }
  return { kind: 'file', text: readFileSync(manifestPath, 'utf-8') }
}

/** The skill content of a working copy: everything except `.git` and the platform directory. */
function readTree(root: string, at: string, output: FusionWorkspaceFile[]): void {
  for (const entry of readdirSync(at === '' ? root : join(root, at))) {
    if (at === '' && (entry === '.git' || entry === PLATFORM_WORKSPACE_DIR)) continue
    const relative = at === '' ? entry : `${at}/${entry}`
    const absolute = join(root, relative)
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink()) {
      throw new ValidationError(
        'fusion-proposal-invalid',
        `the proposed skill tree contains a symbolic link: ${relative}`,
      )
    }
    if (stat.isDirectory()) {
      readTree(root, relative, output)
    } else if (stat.isFile()) {
      output.push({ path: relative, content: new Uint8Array(readFileSync(absolute)) })
    } else {
      throw new ValidationError(
        'fusion-proposal-invalid',
        `the proposed skill tree contains a non-regular entry: ${relative}`,
      )
    }
  }
}

/** The proposal: the diff vs the explicit baseline, the agent's manifest and the edited tree. */
export async function collectFusionWorktree(
  workDir: string,
  baseCommit: string,
): Promise<FusionWorkspaceResult> {
  const diff = await gitDiffSnapshot(workDir, baseCommit)
  ensurePlatformWorkspaceDirectory({ worktreePath: workDir, kind: 'fusion' })
  const manifest = readManifest(workDir)
  const files: FusionWorkspaceFile[] = []
  readTree(workDir, '', files)
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return { diff, manifest, files }
}
