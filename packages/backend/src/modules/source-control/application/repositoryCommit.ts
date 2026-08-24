// RFC-308 — shared candidate-selection and outgoing-history engine.
//
// Ordinary task auto-publish and code-capability artifacts deliberately keep
// their own orchestration and push modes. They both delegate the Git mechanism
// here so stage/preview/freeze/history can no longer drift.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AW_INTERNAL_GIT_IDENTITY, runGit as defaultRunGit } from '@/util/git'
import { createTaskCommitPolicy, type TaskCommitPolicy } from '../domain/taskCommitPolicy'
import type {
  CommitPreparedResult,
  CommitExclusionReceipt,
  PrepareRepositoryCommitResult,
  RepositoryPublishMode,
  RepositoryPublishResult,
} from '../public/types'

export type RepositoryGit = typeof defaultRunGit

interface ChangedPathGroup {
  readonly status: string
  readonly paths: readonly string[]
}

function describeFailure(stage: string, stderr: string, stdout: string, exitCode: number): string {
  const detail = stderr.trim() || stdout.trim() || `git exited ${exitCode}`
  return `${stage}: ${detail}`
}

export function parseNameStatusZ(raw: string): ChangedPathGroup[] {
  if (raw === '') return []
  const fields = raw.split('\0')
  const groups: ChangedPathGroup[] = []
  let index = 0
  while (index < fields.length) {
    const status = fields[index++]
    if (status === undefined || status === '') break
    const first = fields[index++]
    if (first === undefined || first === '') throw new Error('malformed git name-status output')
    if (status.startsWith('R') || status.startsWith('C')) {
      const second = fields[index++]
      if (second === undefined || second === '') throw new Error('malformed git rename output')
      groups.push({ status, paths: [first, second] })
    } else {
      groups.push({ status, paths: [first] })
    }
  }
  return groups
}

async function readPolicy(input: {
  repoPath: string
  configuredPatterns?: readonly string[]
  runGit: RepositoryGit
  gitOptions?: Parameters<RepositoryGit>[2]
}): Promise<TaskCommitPolicy> {
  const ignoreCaseResult = await input.runGit(
    input.repoPath,
    ['config', '--bool', '--get', 'core.ignoreCase'],
    input.gitOptions,
  )
  return createTaskCommitPolicy({
    configuredPatterns: input.configuredPatterns ?? [],
    ignoreCase: ignoreCaseResult.exitCode === 0 && ignoreCaseResult.stdout.trim() === 'true',
  })
}

function mergeGitOptions(
  options: Parameters<RepositoryGit>[2] | undefined,
  env: Record<string, string>,
): Parameters<RepositoryGit>[2] {
  return { ...options, env: { ...(options?.env ?? {}), ...env } }
}

async function filterPreparedIndex(input: {
  repoPath: string
  policy: TaskCommitPolicy
  runGit: RepositoryGit
  gitOptions?: Parameters<RepositoryGit>[2]
}): Promise<PrepareRepositoryCommitResult> {
  const inventory = await input.runGit(
    input.repoPath,
    ['diff', '--cached', '--name-status', '-z', '-M', '-C'],
    input.gitOptions,
  )
  if (inventory.exitCode !== 0) {
    return {
      ok: false,
      error: describeFailure(
        'git staged-path inventory failed',
        inventory.stderr,
        inventory.stdout,
        inventory.exitCode,
      ),
    }
  }

  let groups: ChangedPathGroup[]
  try {
    groups = parseNameStatusZ(inventory.stdout)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const excludedGroups = groups.filter((group) =>
    group.paths.some((path) => input.policy.isExcluded(path)),
  )
  const excludedPaths = [...new Set(excludedGroups.flatMap((group) => group.paths))].sort()

  for (let offset = 0; offset < excludedPaths.length; offset += 100) {
    const paths = excludedPaths.slice(offset, offset + 100)
    const reset = await input.runGit(
      input.repoPath,
      ['reset', '-q', 'HEAD', '--', ...paths],
      mergeGitOptions(input.gitOptions, { GIT_LITERAL_PATHSPECS: '1' }),
    )
    if (reset.exitCode !== 0) {
      return {
        ok: false,
        error: describeFailure(
          'git excluded-path reset failed',
          reset.stderr,
          reset.stdout,
          reset.exitCode,
        ),
      }
    }
  }

  return {
    ok: true,
    receipt: { policyDigest: input.policy.digest, excludedPaths },
  }
}

export async function prepareRepositoryCommit(input: {
  repoPath: string
  configuredPatterns?: readonly string[]
  runGit?: RepositoryGit
  gitOptions?: Parameters<RepositoryGit>[2]
}): Promise<PrepareRepositoryCommitResult> {
  const runGit = input.runGit ?? defaultRunGit
  const staged = await runGit(input.repoPath, ['add', '-A'], input.gitOptions)
  if (staged.exitCode !== 0) {
    return {
      ok: false,
      error: describeFailure('git add failed', staged.stderr, staged.stdout, staged.exitCode),
    }
  }
  const policy = await readPolicy({
    repoPath: input.repoPath,
    configuredPatterns: input.configuredPatterns ?? [],
    runGit,
    ...(input.gitOptions !== undefined ? { gitOptions: input.gitOptions } : {}),
  })
  return filterPreparedIndex({
    repoPath: input.repoPath,
    policy,
    runGit,
    ...(input.gitOptions !== undefined ? { gitOptions: input.gitOptions } : {}),
  })
}

export async function classifyRepositoryCommitPath(input: {
  repoPath: string
  path: string
  directory?: boolean
  configuredPatterns?: readonly string[]
  runGit?: RepositoryGit
  gitOptions?: Parameters<RepositoryGit>[2]
}): Promise<{ excluded: boolean; policyDigest: string }> {
  const runGit = input.runGit ?? defaultRunGit
  const policy = await readPolicy({
    repoPath: input.repoPath,
    configuredPatterns: input.configuredPatterns ?? [],
    runGit,
    ...(input.gitOptions !== undefined ? { gitOptions: input.gitOptions } : {}),
  })
  return {
    excluded: policy.isExcluded(input.path, input.directory ?? false),
    policyDigest: policy.digest,
  }
}

export async function commitPreparedRepository(input: {
  repoPath: string
  message: string
  verification: 'normal' | 'artifact'
  authorName?: string | null
  authorEmail?: string | null
  runGit?: RepositoryGit
  gitOptions?: Parameters<RepositoryGit>[2]
}): Promise<CommitPreparedResult> {
  const runGit = input.runGit ?? defaultRunGit
  const dirty = await runGit(
    input.repoPath,
    ['diff', '--cached', '--quiet', '--exit-code'],
    input.gitOptions,
  )
  if (dirty.exitCode === 0) return { ok: false, reason: 'no-changes' }
  if (dirty.exitCode !== 1) {
    return {
      ok: false,
      reason: 'failed',
      error: describeFailure(
        'git staged-state check failed',
        dirty.stderr,
        dirty.stdout,
        dirty.exitCode,
      ),
    }
  }

  const named = input.authorName?.trim() ?? ''
  const emailed = input.authorEmail?.trim() ?? ''
  const name = named !== '' && emailed !== '' ? named : AW_INTERNAL_GIT_IDENTITY.GIT_AUTHOR_NAME!
  const email =
    named !== '' && emailed !== '' ? emailed : AW_INTERNAL_GIT_IDENTITY.GIT_AUTHOR_EMAIL!
  const commitOptions = mergeGitOptions(input.gitOptions, {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  })
  const committed = await runGit(
    input.repoPath,
    [
      'commit',
      ...(input.verification === 'artifact' ? ['--no-verify', '--no-gpg-sign'] : []),
      '-m',
      input.message,
    ],
    commitOptions,
  )
  if (committed.exitCode !== 0) {
    return {
      ok: false,
      reason: 'failed',
      error: describeFailure(
        'git commit failed',
        committed.stderr,
        committed.stdout,
        committed.exitCode,
      ),
    }
  }
  const resolved = await runGit(
    input.repoPath,
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    input.gitOptions,
  )
  const commitSha = resolved.stdout.trim()
  return resolved.exitCode === 0 && commitSha !== ''
    ? { ok: true, commitSha }
    : {
        ok: false,
        reason: 'failed',
        error: describeFailure(
          'git committed HEAD resolution failed',
          resolved.stderr,
          resolved.stdout,
          resolved.exitCode,
        ),
      }
}

export async function updateRepositoryRef(input: {
  repoPath: string
  ref: string
  commitSha?: string
  runGit?: RepositoryGit
  gitOptions?: Parameters<RepositoryGit>[2]
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const runGit = input.runGit ?? defaultRunGit
  const result = await runGit(
    input.repoPath,
    input.commitSha === undefined
      ? ['update-ref', '-d', input.ref]
      : ['update-ref', input.ref, input.commitSha],
    input.gitOptions,
  )
  return result.exitCode === 0
    ? { ok: true }
    : {
        ok: false,
        error: describeFailure(
          'git ref update failed',
          result.stderr,
          result.stdout,
          result.exitCode,
        ),
      }
}

/** Preview the exact candidate tree with a disposable index; the live index is untouched. */
export async function readRepositoryCommitPreview(input: {
  repoPath: string
  configuredPatterns?: readonly string[]
  runGit?: RepositoryGit
  gitOptions?: Parameters<RepositoryGit>[2]
}): Promise<
  { ok: true; diff: string; receipt: CommitExclusionReceipt } | { ok: false; error: string }
> {
  const runGit = input.runGit ?? defaultRunGit
  const tempDir = mkdtempSync(join(tmpdir(), 'aw-commit-index-'))
  const tempIndex = join(tempDir, 'index')
  try {
    const gitOptions = mergeGitOptions(input.gitOptions, { GIT_INDEX_FILE: tempIndex })
    const readTree = await runGit(input.repoPath, ['read-tree', 'HEAD'], gitOptions)
    if (readTree.exitCode !== 0) {
      return {
        ok: false,
        error: describeFailure(
          'git preview index initialization failed',
          readTree.stderr,
          readTree.stdout,
          readTree.exitCode,
        ),
      }
    }
    const prepared = await prepareRepositoryCommit({
      repoPath: input.repoPath,
      configuredPatterns: input.configuredPatterns ?? [],
      runGit,
      gitOptions,
    })
    if (!prepared.ok) return prepared
    const diff = await runGit(
      input.repoPath,
      ['diff', '--cached', '--no-color', '--unified=3'],
      gitOptions,
    )
    return diff.exitCode === 0
      ? { ok: true, diff: diff.stdout, receipt: prepared.receipt }
      : {
          ok: false,
          error: describeFailure(
            'git preview diff failed',
            diff.stderr,
            diff.stdout,
            diff.exitCode,
          ),
        }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

async function changedGroups(input: {
  repoPath: string
  args: string[]
  runGit: RepositoryGit
  gitOptions?: Parameters<RepositoryGit>[2]
}): Promise<{ ok: true; groups: ChangedPathGroup[] } | { ok: false; error: string }> {
  const result = await input.runGit(input.repoPath, input.args, input.gitOptions)
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: describeFailure(
        'git outgoing history scan failed',
        result.stderr,
        result.stdout,
        result.exitCode,
      ),
    }
  }
  try {
    return { ok: true, groups: parseNameStatusZ(result.stdout) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function inspectOutgoingHistory(input: {
  repoPath: string
  baseSha: string
  tipSha: string
  configuredPatterns?: readonly string[]
  runGit?: RepositoryGit
  gitOptions?: Parameters<RepositoryGit>[2]
}): Promise<
  | { ok: true; policyDigest: string }
  | { ok: false; reason: 'failed'; error: string }
  | {
      ok: false
      reason: 'excluded-history'
      policyDigest: string
      excludedPaths: readonly string[]
    }
> {
  const runGit = input.runGit ?? defaultRunGit
  const policy = await readPolicy({
    repoPath: input.repoPath,
    configuredPatterns: input.configuredPatterns ?? [],
    runGit,
    ...(input.gitOptions !== undefined ? { gitOptions: input.gitOptions } : {}),
  })
  const revisions = await runGit(
    input.repoPath,
    ['rev-list', '--reverse', `${input.baseSha}..${input.tipSha}`],
    input.gitOptions,
  )
  if (revisions.exitCode !== 0) {
    return {
      ok: false,
      reason: 'failed',
      error: describeFailure(
        'git outgoing revision scan failed',
        revisions.stderr,
        revisions.stdout,
        revisions.exitCode,
      ),
    }
  }

  const hits = new Set<string>()
  for (const revision of revisions.stdout
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)) {
    const parentLine = await runGit(
      input.repoPath,
      ['rev-list', '--parents', '--max-count=1', revision],
      input.gitOptions,
    )
    if (parentLine.exitCode !== 0) {
      return {
        ok: false,
        reason: 'failed',
        error: describeFailure(
          'git outgoing parent scan failed',
          parentLine.stderr,
          parentLine.stdout,
          parentLine.exitCode,
        ),
      }
    }
    const parentCount = Math.max(0, parentLine.stdout.trim().split(/\s+/).length - 1)
    const changed = await changedGroups({
      repoPath: input.repoPath,
      args:
        parentCount > 1
          ? ['diff-tree', '--cc', '--no-commit-id', '-r', '--name-status', '-z', revision]
          : [
              'diff-tree',
              '--root',
              '--no-commit-id',
              '-r',
              '--name-status',
              '-z',
              '-M',
              '-C',
              revision,
            ],
      runGit,
      ...(input.gitOptions !== undefined ? { gitOptions: input.gitOptions } : {}),
    })
    if (!changed.ok) return { ok: false, reason: 'failed', error: changed.error }
    for (const group of changed.groups) {
      if (group.paths.some((path) => policy.isExcluded(path))) {
        for (const path of group.paths) hits.add(path)
      }
    }
  }

  // Net diff is a second check for merge-only resolutions; the per-merge `--cc`
  // scan above reports only paths changed from every parent, avoiding false
  // positives for paths that already exist on the remote parent.
  const net = await changedGroups({
    repoPath: input.repoPath,
    args: ['diff', '--name-status', '-z', '-M', '-C', input.baseSha, input.tipSha],
    runGit,
    ...(input.gitOptions !== undefined ? { gitOptions: input.gitOptions } : {}),
  })
  if (!net.ok) return { ok: false, reason: 'failed', error: net.error }
  for (const group of net.groups) {
    if (group.paths.some((path) => policy.isExcluded(path))) {
      for (const path of group.paths) hits.add(path)
    }
  }

  return hits.size === 0
    ? { ok: true, policyDigest: policy.digest }
    : {
        ok: false,
        reason: 'excluded-history',
        policyDigest: policy.digest,
        excludedPaths: [...hits].sort(),
      }
}

export async function resolvePushBase(input: {
  repoPath: string
  remote: string
  branch: string
  fallbackRef: string
  runGit?: RepositoryGit
}): Promise<string | null> {
  const runGit = input.runGit ?? defaultRunGit
  const candidates = [
    `refs/remotes/${input.remote}/${input.branch}^{commit}`,
    `${input.fallbackRef}^{commit}`,
    `refs/remotes/${input.remote}/${input.fallbackRef}^{commit}`,
    `refs/heads/${input.fallbackRef}^{commit}`,
  ]
  for (const candidate of candidates) {
    const resolved = await runGit(input.repoPath, ['rev-parse', '--verify', candidate])
    if (resolved.exitCode === 0 && resolved.stdout.trim() !== '') return resolved.stdout.trim()
  }
  return null
}

export async function publishRepositoryCommit(input: {
  repoPath: string
  baseSha: string
  tipSha: string
  mode: RepositoryPublishMode
  configuredPatterns?: readonly string[]
  runGit?: RepositoryGit
  gitOptions?: Parameters<RepositoryGit>[2]
}): Promise<RepositoryPublishResult> {
  const runGit = input.runGit ?? defaultRunGit
  const history = await inspectOutgoingHistory({
    repoPath: input.repoPath,
    baseSha: input.baseSha,
    tipSha: input.tipSha,
    configuredPatterns: input.configuredPatterns ?? [],
    runGit,
    ...(input.gitOptions !== undefined ? { gitOptions: input.gitOptions } : {}),
  })
  if (!history.ok) return history

  const args =
    input.mode.kind === 'normal'
      ? [
          ...(input.mode.leadingArgs ?? []),
          'push',
          input.mode.remote,
          `${input.tipSha}:refs/heads/${input.mode.branch}`,
        ]
      : input.mode.kind === 'cas'
        ? [
            'push',
            `--force-with-lease=refs/heads/${input.mode.branch}:${input.mode.expectedRemoteSha}`,
            input.mode.remote,
            `${input.tipSha}:refs/heads/${input.mode.branch}`,
          ]
        : ['push', input.mode.remote, `${input.tipSha}:refs/heads/${input.mode.branch}`]
  const pushed = await runGit(input.repoPath, args, input.gitOptions)
  return pushed.exitCode === 0
    ? { ok: true, policyDigest: history.policyDigest }
    : {
        ok: false,
        reason: 'failed',
        error: describeFailure('git push failed', pushed.stderr, pushed.stdout, pushed.exitCode),
      }
}
