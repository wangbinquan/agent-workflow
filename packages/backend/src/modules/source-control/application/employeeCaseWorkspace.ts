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
import { dirname, isAbsolute, join } from 'node:path'
import { ulid } from 'ulid'

import { describeRepositoryRemote, PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'
import { runGit } from '@/util/git'
import { createSha256DigestBuilder } from '@/util/hash'
import { redactSensitiveString } from '@/util/redact'
import { classifyRepositoryPushFailure } from '../domain/repositoryPushFailure'
import type { CandidatePublicationSubject, CandidatePublicationTransport } from './deliverCandidate'

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
  readonly publicationSubject?: CandidatePublicationSubject
  readonly publicationTransport?: CandidatePublicationTransport
}): Promise<
  | { readonly ok: true; readonly headSha: string }
  | {
      readonly ok: false
      readonly code: 'remote-head-moved'
      readonly expectedHeadSha: string
      readonly actualHeadSha: string
    }
> {
  const described = describeRepositoryRemote(input.remoteUrl)
  const localRemote =
    (described.ok && described.value.transport === 'file') ||
    isAbsolute(input.remoteUrl) ||
    input.remoteUrl.startsWith('./') ||
    input.remoteUrl.startsWith('../')
  let fetched: Awaited<ReturnType<typeof runGit>>
  if (input.publicationTransport !== undefined && input.publicationSubject !== undefined) {
    const opened = await input.publicationTransport.open({
      subject: input.publicationSubject,
      remoteUrl: input.remoteUrl,
    })
    if (!opened.ok) {
      throw new Error(`employee workspace publication transport failed: ${opened.code}`)
    }
    try {
      fetched = await opened.session.runNetwork(input.baselineRepoPath, [
        'fetch',
        '--quiet',
        '--no-tags',
        opened.session.endpointUrl,
        `refs/heads/${input.branch}`,
      ])
    } finally {
      opened.session.close()
    }
  } else {
    if (!localRemote) {
      throw new Error('employee workspace publication transport and owner are required')
    }
    fetched = await runGit(input.baselineRepoPath, [
      'fetch',
      '--quiet',
      '--no-tags',
      input.remoteUrl,
      `refs/heads/${input.branch}`,
    ])
  }
  if (fetched.exitCode !== 0) {
    const detail = `${fetched.stderr}\n${fetched.stdout}`
    throw new Error(
      classifyRepositoryPushFailure(detail) ??
        `employee workspace remote-head fetch failed: ${redactSensitiveString(detail).slice(0, 500)}`,
    )
  }
  const actual = await runGit(input.baselineRepoPath, [
    'rev-parse',
    '--verify',
    'FETCH_HEAD^{commit}',
  ])
  if (actual.exitCode !== 0) {
    throw new Error(`employee workspace fetched head is unreadable: ${actual.stderr.slice(0, 500)}`)
  }
  const actualHeadSha = actual.stdout.trim()
  if (actualHeadSha !== input.expectedHeadSha) {
    return {
      ok: false,
      code: 'remote-head-moved',
      expectedHeadSha: input.expectedHeadSha,
      actualHeadSha,
    }
  }
  return { ok: true, headSha: actualHeadSha }
}

export async function resolveEmployeeWorkspaceBaseline(input: {
  readonly baselineRepoPath: string
  readonly preferredBranch: string | null
  readonly sourceBranch: string | null
}): Promise<{
  readonly baselineSha: string
  readonly targetBranch: string
  readonly remoteHeadSha: string | null
}> {
  const targetBranch = input.preferredBranch ?? 'main'
  if (input.sourceBranch !== null) {
    const valid = await runGit(input.baselineRepoPath, [
      'check-ref-format',
      '--branch',
      input.sourceBranch,
    ])
    if (valid.exitCode !== 0) {
      throw new Error(`employee workspace source branch is invalid: ${input.sourceBranch}`)
    }
    const remoteSource = await runGit(input.baselineRepoPath, [
      'rev-parse',
      '--verify',
      `refs/remotes/origin/${input.sourceBranch}^{commit}`,
    ])
    const remoteHeadSha = remoteSource.stdout.trim()
    if (remoteSource.exitCode === 0 && /^[0-9a-f]{40}$/.test(remoteHeadSha)) {
      return { baselineSha: remoteHeadSha, targetBranch, remoteHeadSha }
    }
  }
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
      return { baselineSha, targetBranch, remoteHeadSha: null }
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
