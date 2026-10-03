import { isAbsolute } from 'node:path'
import { ulid } from 'ulid'

import { describeRepositoryRemote, PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'
import type { RepositoryCandidateGitOutcome } from './ports/repositoryCandidateEffects'
import type {
  EmployeeCaseGitOperand,
  EmployeeCaseWorkspaceEffects,
  EmployeeCaseWorkspaceEffectsFactory,
} from './ports/employeeCaseWorkspaceEffects'
import { createSha256DigestBuilder } from '@/util/hash'
import { redactSensitiveString } from '@/util/redact'
import { classifyRepositoryPushFailure } from '../domain/repositoryPushFailure'
import type { CandidatePublicationSubject, CandidatePublicationTransport } from './deliverCandidate'

async function copyTree(
  scope: EmployeeCaseWorkspaceEffects,
  source: string,
  target: string,
  excludedTopLevel: ReadonlySet<string> = new Set(),
): Promise<void> {
  const walk = async (relative: string): Promise<void> => {
    const absolute = relative === '' ? source : scope.resolve(source, relative)
    const stat = await scope.stat(absolute)
    if (stat === null) return
    if (stat.kind === 'symlink')
      throw new Error(`workspace checkpoint contains symlink: ${relative}`)
    if (stat.kind === 'directory') {
      if (relative !== '') await scope.createDirectory(scope.resolve(target, relative))
      for (const name of [...(await scope.list(absolute))].sort()) {
        if (relative === '' && excludedTopLevel.has(name)) continue
        await walk(relative === '' ? name : `${relative}/${name}`)
      }
      return
    }
    if (!(stat.kind === 'file'))
      throw new Error(`workspace checkpoint contains non-file: ${relative}`)
    const destination = scope.resolve(target, relative)
    await scope.createDirectory(scope.resolve(destination, '..'))
    await scope.copyFile(absolute, destination)
    await scope.setMode(destination, stat.mode & 0o777)
  }
  await walk('')
}

async function treeDigest(root: string, scope: EmployeeCaseWorkspaceEffects): Promise<string> {
  const hash = createSha256DigestBuilder()
  const walk = async (relative: string): Promise<void> => {
    const absolute = relative === '' ? root : scope.resolve(root, relative)
    const stat = await scope.stat(absolute)
    if (stat === null) return
    if (stat.kind === 'directory') {
      for (const name of [...(await scope.list(absolute))].sort()) {
        await walk(relative === '' ? name : `${relative}/${name}`)
      }
      return
    }
    if (!(stat.kind === 'file')) throw new Error(`workspace digest contains non-file: ${relative}`)
    hash.update(`${relative}\u0000${stat.mode & 0o777}\u0000`)
    hash.update(await scope.readBytes(absolute))
    hash.update('\u0000')
  }
  await walk('')
  return hash.digestHex()
}

async function cloneBaseline(
  scope: EmployeeCaseWorkspaceEffects,
  input: {
    readonly caseRoot: string
    readonly baselineRepoPath: string
    readonly baselineSha: string
    readonly platformOverlayRoot?: string
  },
): Promise<string> {
  await scope.createDirectory(scope.resolve(input.caseRoot, '..'))
  const stagingRoot = scope.sibling(input.caseRoot, `.tmp-${ulid()}`)
  const workspacePath = scope.resolve(stagingRoot, 'workspace')
  await scope.createDirectory(stagingRoot)
  try {
    const cloned = await scope.runGit(stagingRoot, [
      ...literalGitOperands(['clone', '--no-hardlinks', '--quiet']),
      { kind: 'reference', reference: input.baselineRepoPath },
      { kind: 'reference', reference: workspacePath },
    ])
    if (cloned.exitCode !== 0) throw new Error(cloned.stderr.slice(0, 500))
    const checkout = await scope.runGit(
      workspacePath,
      literalGitOperands(['checkout', '--quiet', '--detach', input.baselineSha]),
    )
    if (checkout.exitCode !== 0) throw new Error(checkout.stderr.slice(0, 500))
    const removed = await scope.runGit(
      workspacePath,
      literalGitOperands(['remote', 'remove', 'origin']),
    )
    if (removed.exitCode !== 0) throw new Error(removed.stderr.slice(0, 500))
    await scope.createDirectory(scope.resolve(workspacePath, '.git', 'info'))
    await scope.writeText(
      scope.resolve(workspacePath, '.git', 'info', 'exclude'),
      `${PLATFORM_WORKSPACE_DIR}/\n`,
    )
    if (
      input.platformOverlayRoot !== undefined &&
      (await scope.exists(input.platformOverlayRoot))
    ) {
      const overlayTarget = scope.resolve(workspacePath, PLATFORM_WORKSPACE_DIR)
      await scope.createDirectory(overlayTarget)
      await copyTree(scope, input.platformOverlayRoot, overlayTarget)
    }
    await scope.remove(input.caseRoot)
    await scope.move(stagingRoot, input.caseRoot)
    return scope.resolve(input.caseRoot, 'workspace')
  } catch (error) {
    await scope.remove(stagingRoot)
    throw new Error(
      `employee case workspace materialization failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export async function materializeEmployeeCaseWorkspace(
  input: {
    readonly caseRoot: string
    readonly baselineRepoPath: string
    readonly baselineSha: string
  },
  effects: EmployeeCaseWorkspaceEffectsFactory,
): Promise<{ readonly workspacePath: string }> {
  return withEmployeeCaseEffects(effects, async (scope) => {
    return { workspacePath: await cloneBaseline(scope, input) }
  })
}

export async function rematerializeEmployeeCaseWorkspace(
  input: {
    readonly caseRoot: string
    readonly baselineRepoPath: string
    readonly baselineSha: string
    readonly currentWorkspacePath: string
  },
  effects: EmployeeCaseWorkspaceEffectsFactory,
): Promise<{ readonly workspacePath: string }> {
  return withEmployeeCaseEffects(effects, async (scope) => {
    const preservationRoot = scope.sibling(input.caseRoot, `.platform-${ulid()}`)
    const currentPlatformRoot = scope.resolve(input.currentWorkspacePath, PLATFORM_WORKSPACE_DIR)
    try {
      if (await scope.exists(currentPlatformRoot)) {
        await scope.createDirectory(preservationRoot)
        await copyTree(scope, currentPlatformRoot, preservationRoot)
      }
      return {
        workspacePath: await cloneBaseline(scope, {
          caseRoot: input.caseRoot,
          baselineRepoPath: input.baselineRepoPath,
          baselineSha: input.baselineSha,
          platformOverlayRoot: preservationRoot,
        }),
      }
    } finally {
      await scope.remove(preservationRoot)
    }
  })
}

export async function fetchEmployeeWorkspaceRemoteHead(
  input: {
    readonly baselineRepoPath: string
    readonly remoteUrl: string
    readonly branch: string
    readonly expectedHeadSha: string
    readonly publicationSubject?: CandidatePublicationSubject
    readonly publicationTransport?: CandidatePublicationTransport
  },
  effects: EmployeeCaseWorkspaceEffectsFactory,
): Promise<
  | { readonly ok: true; readonly headSha: string }
  | {
      readonly ok: false
      readonly code: 'remote-head-moved'
      readonly expectedHeadSha: string
      readonly actualHeadSha: string
    }
> {
  return withEmployeeCaseEffects(effects, async (scope) => {
    const described = describeRepositoryRemote(input.remoteUrl)
    const localRemote =
      (described.ok && described.value.transport === 'file') ||
      isAbsolute(input.remoteUrl) ||
      input.remoteUrl.startsWith('./') ||
      input.remoteUrl.startsWith('../')
    let fetched: RepositoryCandidateGitOutcome
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
      fetched = await scope.runGit(
        input.baselineRepoPath,
        literalGitOperands([
          'fetch',
          '--quiet',
          '--no-tags',
          input.remoteUrl,
          `refs/heads/${input.branch}`,
        ]),
      )
    }
    if (fetched.exitCode !== 0) {
      const detail = `${fetched.stderr}\n${fetched.stdout}`
      throw new Error(
        classifyRepositoryPushFailure(detail) ??
          `employee workspace remote-head fetch failed: ${redactSensitiveString(detail).slice(0, 500)}`,
      )
    }
    const actual = await scope.runGit(
      input.baselineRepoPath,
      literalGitOperands(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']),
    )
    if (actual.exitCode !== 0) {
      throw new Error(
        `employee workspace fetched head is unreadable: ${actual.stderr.slice(0, 500)}`,
      )
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
  })
}

export async function resolveEmployeeWorkspaceBaseline(
  input: {
    readonly baselineRepoPath: string
    readonly preferredBranch: string | null
    readonly sourceBranch: string | null
  },
  effects: EmployeeCaseWorkspaceEffectsFactory,
): Promise<{
  readonly baselineSha: string
  readonly targetBranch: string
  readonly remoteHeadSha: string | null
}> {
  return withEmployeeCaseEffects(effects, async (scope) => {
    const targetBranch = input.preferredBranch ?? 'main'
    if (input.sourceBranch !== null) {
      const valid = await scope.runGit(
        input.baselineRepoPath,
        literalGitOperands(['check-ref-format', '--branch', input.sourceBranch]),
      )
      if (valid.exitCode !== 0) {
        throw new Error(`employee workspace source branch is invalid: ${input.sourceBranch}`)
      }
      const remoteSource = await scope.runGit(
        input.baselineRepoPath,
        literalGitOperands([
          'rev-parse',
          '--verify',
          `refs/remotes/origin/${input.sourceBranch}^{commit}`,
        ]),
      )
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
      const resolved = await scope.runGit(
        input.baselineRepoPath,
        literalGitOperands(['rev-parse', '--verify', `${candidate}^{commit}`]),
      )
      const baselineSha = resolved.stdout.trim()
      if (resolved.exitCode === 0 && /^[0-9a-f]{40}$/.test(baselineSha)) {
        return { baselineSha, targetBranch, remoteHeadSha: null }
      }
    }
    throw new Error(`cannot resolve repository baseline for ${targetBranch}`)
  })
}

/**
 * Import a platform-created commit into the cached repository object database
 * without moving any branch. Conflict repair uses this before the ordinary CAS
 * publisher and future Case scenes consume its merge commit.
 */
export async function importEmployeeWorkspaceCommit(
  input: {
    readonly baselineRepoPath: string
    readonly sourceRepoPath: string
    readonly commitSha: string
  },
  effects: EmployeeCaseWorkspaceEffectsFactory,
): Promise<void> {
  return withEmployeeCaseEffects(effects, async (scope) => {
    const fetched = await scope.runGit(input.baselineRepoPath, [
      ...literalGitOperands(['fetch', '--quiet', '--no-tags']),
      { kind: 'reference', reference: input.sourceRepoPath },
      ...literalGitOperands([input.commitSha]),
    ])
    if (fetched.exitCode !== 0) {
      throw new Error(`employee workspace commit import failed: ${fetched.stderr.slice(0, 500)}`)
    }
    const verified = await scope.runGit(
      input.baselineRepoPath,
      literalGitOperands(['rev-parse', '--verify', `${input.commitSha}^{commit}`]),
    )
    if (verified.exitCode !== 0 || verified.stdout.trim() !== input.commitSha) {
      throw new Error('employee workspace imported commit identity mismatch')
    }
  })
}

export async function checkpointEmployeeCaseWorkspace(
  input: {
    readonly workspacePath: string
    readonly checkpointRoot: string
  },
  effects: EmployeeCaseWorkspaceEffectsFactory,
): Promise<{ readonly checkpointDigest: string }> {
  return withEmployeeCaseEffects(effects, async (scope) => {
    const staging = scope.sibling(input.checkpointRoot, `.tmp-${ulid()}`)
    await scope.remove(staging)
    await scope.createDirectory(staging)
    try {
      await copyTree(scope, input.workspacePath, staging, new Set(['.git']))
      const checkpointDigest = await treeDigest(staging, scope)
      await scope.remove(input.checkpointRoot)
      await scope.move(staging, input.checkpointRoot)
      return { checkpointDigest }
    } catch (error) {
      await scope.remove(staging)
      throw error
    }
  })
}

export async function restoreEmployeeCaseWorkspace(
  input: {
    readonly caseRoot: string
    readonly baselineRepoPath: string
    readonly baselineSha: string
    readonly checkpointRoot: string
    readonly expectedCheckpointDigest: string
  },
  effects: EmployeeCaseWorkspaceEffectsFactory,
): Promise<{ readonly workspacePath: string }> {
  return withEmployeeCaseEffects(effects, async (scope) => {
    if (!(await scope.exists(input.checkpointRoot)))
      throw new Error('employee workspace checkpoint is missing')
    const actualDigest = await treeDigest(input.checkpointRoot, scope)
    if (actualDigest !== input.expectedCheckpointDigest) {
      throw new Error('employee workspace checkpoint digest mismatch')
    }
    const materialized = { workspacePath: await cloneBaseline(scope, input) }
    await copyTree(scope, input.checkpointRoot, materialized.workspacePath)
    return materialized
  })
}

export async function discardEmployeeCaseWorkspace(
  caseRoot: string,
  effects: EmployeeCaseWorkspaceEffectsFactory,
): Promise<void> {
  return withEmployeeCaseEffects(effects, async (scope) => {
    await scope.remove(caseRoot)
  })
}

function literalGitOperands(values: readonly string[]): readonly EmployeeCaseGitOperand[] {
  return values.map((value) => ({ kind: 'literal', value }))
}

async function withEmployeeCaseEffects<T>(
  effects: EmployeeCaseWorkspaceEffectsFactory,
  operation: (scope: EmployeeCaseWorkspaceEffects) => Promise<T>,
): Promise<T> {
  const scope = await effects.acquire()
  let outcome:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown }
  try {
    const methods = [
      'resolve',
      'sibling',
      'exists',
      'stat',
      'list',
      'createDirectory',
      'copyFile',
      'setMode',
      'readBytes',
      'writeText',
      'remove',
      'move',
      'runGit',
      'close',
    ] as const
    if (
      scope === null ||
      scope === undefined ||
      methods.some((name) => typeof scope[name] !== 'function')
    ) {
      throw new Error('employee-case-workspace-effects-incomplete')
    }
    outcome = { ok: true, value: await operation(scope) }
  } catch (error) {
    outcome = { ok: false, error }
  }
  try {
    if (scope !== null && scope !== undefined && typeof scope.close === 'function')
      await scope.close()
  } catch (error) {
    if (!outcome.ok)
      throw new AggregateError(
        [outcome.error, error],
        'employee case workspace operation and close failed',
      )
    throw error
  }
  if (!outcome.ok) throw outcome.error
  return outcome.value
}
