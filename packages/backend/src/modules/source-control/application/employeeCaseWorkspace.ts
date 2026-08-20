import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { ulid } from 'ulid'

import { PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'
import { runGit } from '@/util/git'
import { createSha256DigestBuilder } from '@/util/hash'

function copyTree(
  source: string,
  target: string,
  excludedTopLevel: ReadonlySet<string> = new Set(),
): void {
  const walk = (relative: string): void => {
    const absolute = relative === '' ? source : join(source, relative)
    const stat = lstatSync(absolute, { throwIfNoEntry: false })
    if (stat === undefined) return
    if (stat.isSymbolicLink()) throw new Error(`workspace checkpoint contains symlink: ${relative}`)
    if (stat.isDirectory()) {
      if (relative !== '') mkdirSync(join(target, relative), { recursive: true })
      for (const name of readdirSync(absolute).sort()) {
        if (relative === '' && excludedTopLevel.has(name)) continue
        walk(relative === '' ? name : `${relative}/${name}`)
      }
      return
    }
    if (!stat.isFile()) throw new Error(`workspace checkpoint contains non-file: ${relative}`)
    const destination = join(target, relative)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(absolute, destination)
    chmodSync(destination, stat.mode & 0o777)
  }
  walk('')
}

function treeDigest(root: string): string {
  const hash = createSha256DigestBuilder()
  const walk = (relative: string): void => {
    const absolute = relative === '' ? root : join(root, relative)
    const stat = lstatSync(absolute, { throwIfNoEntry: false })
    if (stat === undefined) return
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        walk(relative === '' ? name : `${relative}/${name}`)
      }
      return
    }
    if (!stat.isFile()) throw new Error(`workspace digest contains non-file: ${relative}`)
    hash.update(`${relative}\u0000${stat.mode & 0o777}\u0000`)
    hash.update(readFileSync(absolute))
    hash.update('\u0000')
  }
  walk('')
  return hash.digestHex()
}

async function cloneBaseline(input: {
  readonly caseRoot: string
  readonly baselineRepoPath: string
  readonly baselineSha: string
  readonly platformOverlayRoot?: string
}): Promise<string> {
  mkdirSync(dirname(input.caseRoot), { recursive: true })
  const stagingRoot = `${input.caseRoot}.tmp-${ulid()}`
  const workspacePath = join(stagingRoot, 'workspace')
  mkdirSync(stagingRoot, { recursive: true })
  try {
    const cloned = await runGit(stagingRoot, [
      'clone',
      '--no-hardlinks',
      '--quiet',
      input.baselineRepoPath,
      workspacePath,
    ])
    if (cloned.exitCode !== 0) throw new Error(cloned.stderr.slice(0, 500))
    const checkout = await runGit(workspacePath, [
      'checkout',
      '--quiet',
      '--detach',
      input.baselineSha,
    ])
    if (checkout.exitCode !== 0) throw new Error(checkout.stderr.slice(0, 500))
    const removed = await runGit(workspacePath, ['remote', 'remove', 'origin'])
    if (removed.exitCode !== 0) throw new Error(removed.stderr.slice(0, 500))
    mkdirSync(join(workspacePath, '.git', 'info'), { recursive: true })
    writeFileSync(join(workspacePath, '.git', 'info', 'exclude'), `${PLATFORM_WORKSPACE_DIR}/\n`)
    if (input.platformOverlayRoot !== undefined && existsSync(input.platformOverlayRoot)) {
      const overlayTarget = join(workspacePath, PLATFORM_WORKSPACE_DIR)
      mkdirSync(overlayTarget, { recursive: true })
      copyTree(input.platformOverlayRoot, overlayTarget)
    }
    rmSync(input.caseRoot, { recursive: true, force: true })
    renameSync(stagingRoot, input.caseRoot)
    return join(input.caseRoot, 'workspace')
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true })
    throw new Error(
      `employee case workspace materialization failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export async function materializeEmployeeCaseWorkspace(input: {
  readonly caseRoot: string
  readonly baselineRepoPath: string
  readonly baselineSha: string
}): Promise<{ readonly workspacePath: string }> {
  return { workspacePath: await cloneBaseline(input) }
}

export async function rematerializeEmployeeCaseWorkspace(input: {
  readonly caseRoot: string
  readonly baselineRepoPath: string
  readonly baselineSha: string
  readonly currentWorkspacePath: string
}): Promise<{ readonly workspacePath: string }> {
  const preservationRoot = `${input.caseRoot}.platform-${ulid()}`
  const currentPlatformRoot = join(input.currentWorkspacePath, PLATFORM_WORKSPACE_DIR)
  try {
    if (existsSync(currentPlatformRoot)) {
      mkdirSync(preservationRoot, { recursive: true })
      copyTree(currentPlatformRoot, preservationRoot)
    }
    return {
      workspacePath: await cloneBaseline({
        caseRoot: input.caseRoot,
        baselineRepoPath: input.baselineRepoPath,
        baselineSha: input.baselineSha,
        platformOverlayRoot: preservationRoot,
      }),
    }
  } finally {
    rmSync(preservationRoot, { recursive: true, force: true })
  }
}

export async function fetchEmployeeWorkspaceRemoteHead(input: {
  readonly baselineRepoPath: string
  readonly remoteUrl: string
  readonly branch: string
  readonly expectedHeadSha: string
}): Promise<void> {
  const fetched = await runGit(input.baselineRepoPath, [
    'fetch',
    '--quiet',
    '--no-tags',
    input.remoteUrl,
    `refs/heads/${input.branch}`,
  ])
  if (fetched.exitCode !== 0) {
    throw new Error(`employee workspace remote-head fetch failed: ${fetched.stderr.slice(0, 500)}`)
  }
  const actual = await runGit(input.baselineRepoPath, [
    'rev-parse',
    '--verify',
    'FETCH_HEAD^{commit}',
  ])
  if (actual.exitCode !== 0 || actual.stdout.trim() !== input.expectedHeadSha) {
    throw new Error('employee workspace remote head changed while facts were being applied')
  }
}

export async function resolveEmployeeWorkspaceBaseline(input: {
  readonly baselineRepoPath: string
  readonly preferredBranch: string | null
}): Promise<{ readonly baselineSha: string; readonly targetBranch: string }> {
  const targetBranch = input.preferredBranch ?? 'main'
  const candidates = [
    ...(input.preferredBranch === null
      ? []
      : [
          `refs/remotes/origin/${input.preferredBranch}`,
          `refs/heads/${input.preferredBranch}`,
          input.preferredBranch,
        ]),
    'HEAD',
  ]
  for (const candidate of candidates) {
    const resolved = await runGit(input.baselineRepoPath, [
      'rev-parse',
      '--verify',
      `${candidate}^{commit}`,
    ])
    const baselineSha = resolved.stdout.trim()
    if (resolved.exitCode === 0 && /^[0-9a-f]{40}$/.test(baselineSha)) {
      return { baselineSha, targetBranch }
    }
  }
  throw new Error(`cannot resolve repository baseline for ${targetBranch}`)
}

/**
 * Import a platform-created commit into the cached repository object database
 * without moving any branch. Conflict repair uses this before the ordinary CAS
 * publisher and future Case scenes consume its merge commit.
 */
export async function importEmployeeWorkspaceCommit(input: {
  readonly baselineRepoPath: string
  readonly sourceRepoPath: string
  readonly commitSha: string
}): Promise<void> {
  const fetched = await runGit(input.baselineRepoPath, [
    'fetch',
    '--quiet',
    '--no-tags',
    input.sourceRepoPath,
    input.commitSha,
  ])
  if (fetched.exitCode !== 0) {
    throw new Error(`employee workspace commit import failed: ${fetched.stderr.slice(0, 500)}`)
  }
  const verified = await runGit(input.baselineRepoPath, [
    'rev-parse',
    '--verify',
    `${input.commitSha}^{commit}`,
  ])
  if (verified.exitCode !== 0 || verified.stdout.trim() !== input.commitSha) {
    throw new Error('employee workspace imported commit identity mismatch')
  }
}

export function checkpointEmployeeCaseWorkspace(input: {
  readonly workspacePath: string
  readonly checkpointRoot: string
}): { readonly checkpointDigest: string } {
  const staging = `${input.checkpointRoot}.tmp-${ulid()}`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  try {
    copyTree(input.workspacePath, staging, new Set(['.git']))
    const checkpointDigest = treeDigest(staging)
    rmSync(input.checkpointRoot, { recursive: true, force: true })
    renameSync(staging, input.checkpointRoot)
    return { checkpointDigest }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

export async function restoreEmployeeCaseWorkspace(input: {
  readonly caseRoot: string
  readonly baselineRepoPath: string
  readonly baselineSha: string
  readonly checkpointRoot: string
  readonly expectedCheckpointDigest: string
}): Promise<{ readonly workspacePath: string }> {
  if (!existsSync(input.checkpointRoot)) throw new Error('employee workspace checkpoint is missing')
  const actualDigest = treeDigest(input.checkpointRoot)
  if (actualDigest !== input.expectedCheckpointDigest) {
    throw new Error('employee workspace checkpoint digest mismatch')
  }
  const materialized = await materializeEmployeeCaseWorkspace(input)
  copyTree(input.checkpointRoot, materialized.workspacePath)
  return materialized
}

export function discardEmployeeCaseWorkspace(caseRoot: string): void {
  rmSync(caseRoot, { recursive: true, force: true })
}
