import { existsSync, mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { gitUrlCacheKeyWith, parseGitUrl, type GitCommitIdentity } from '@agent-workflow/shared'
import { sha1Hex } from '@/util/hash'
import { requireWorkPath } from '@/platform/crewstation/workVolumePath'
import { runGit, isGitWorkTree, gitDiffSnapshot, worktreeDiff, initScratchRepo } from '@/util/git'
import { detectSubmodules, listEffectiveSubmodules } from '@/services/gitSubmodule'
import { listAvailableRefs } from '@/services/gitRepoCache'
import { DomainError } from '@/util/errors'
import {
  materializeWorktree,
  materializeGroupSpace,
  cleanupMaterializedSpace,
  resolveRepoSourceSingleWithProvider,
} from '../infrastructure/workspaceMaterializer'
import type { MaterializedSpace, ResolvedRepoSource } from '../application/workspaceMaterialization'
import { bindFileAgentWorkspaceGitControlObservation } from '../infrastructure/local/fileAgentWorkspaceGitControl'
import { createNodeWorkspaceMaintenanceFilesystem } from '../infrastructure/nodeWorkspaceMaintenanceFilesystem'
import {
  createLocalIsolationWorkspaceFactory,
  prepareLocalIsolationConflict,
} from '../infrastructure/local/localIsolationWorkspace'
import type { IsolationWorkspaceBinding } from '../application/ports/isolationWorkspace'
import type { IsolationConflict } from '../application/ports/isolationWorkspace'
import {
  finishConflictResolution,
  type PreparedConflictResolution,
} from '@/platform/workspace/local/isolation'
import {
  executeTaskImageRepositoryOperation,
  TASK_IMAGE_REPOSITORY_OPERATIONS,
} from './taskImageRepositoryEffects'
import { executeTaskImageUploadOperation, TASK_IMAGE_UPLOAD_OPERATIONS } from './taskImageUploads'
import { assertHostedRepositoryUrl } from '../infrastructure/crewstation/repositoryUrl'
import { createVolumeRepositoryMirrorStore } from '../infrastructure/crewstation/volumeRepositoryMirrors'
import { REPOSITORY_COMMIT_OPERATION } from '../infrastructure/crewstation/workspaceEffects'
import { createFileRepositoryPreviewIndexPort } from '../infrastructure/local/fileRepositoryPreviewIndex'
import {
  commitPreparedRepository,
  prepareRepositoryCommit,
  readRepositoryCommitPreview,
} from '../application/repositoryCommit'
import type { RepositoryCommitWorkspaceOperations } from '../application/ports/repositoryGitWorkspace'
import { executeTaskImageIsolationMergeStep } from './taskImageIsolation'

interface ResolveRepositoryInput {
  readonly id: string
  readonly url: string
  readonly ref?: string
  readonly timeoutMs?: number
}

/** RFC-370 §9.2 V3: the volume reuses the standalone mirror cache primitive
 * itself (temp dir + rename, recursive submodules, fetch with prune, and the
 * fast-forward of the requested branch) over a registry that is the volume's
 * own `repos/` directory. The exact commit is frozen for materialization. */
async function resolveRepository(
  input: ResolveRepositoryInput,
  root: string,
  signal?: AbortSignal,
): Promise<ResolvedRepoSource> {
  // Credentials belong to the task's injected Git credential environment.
  // They must not be captured in a command request or its persisted argv.
  assertHostedRepositoryUrl(input.url)
  const source = await resolveRepoSourceSingleWithProvider(
    { repoUrl: input.url, ...(input.ref ? { ref: input.ref } : {}) },
    {},
    {
      appHome: root,
      repositoryWorkspace: createVolumeRepositoryMirrorStore(root),
      loadFrozenSpaceLayout: async () => {
        throw new Error('hosted-frozen-space-layout-unavailable')
      },
      cloneTimeoutMs: input.timeoutMs ?? 1_800_000,
      ...(signal === undefined ? {} : { sourceTerminationLaunchSignal: signal }),
    },
  )
  const repoPath = requireWorkPath(source.repoPath, root)
  const requested = input.ref || source.baseBranch || 'HEAD'
  const revision = await runGit(repoPath, ['rev-parse', '--verify', `${requested}^{commit}`, '--'])
  // Same structured refusal as the standalone launch (code, status, refs).
  if (revision.exitCode !== 0)
    throw new DomainError('repo-ref-not-found', `ref '${requested}' not found`, 400, {
      ref: requested,
      availableRefs: await listAvailableRefs(repoPath, 10),
    })
  return {
    ...source,
    repoPath,
    repoUrl: input.url,
    cachedRepoId: input.id,
    baseBranch: input.ref || source.baseBranch || 'HEAD',
    resolvedCommit: revision.stdout.trim(),
  }
}

/** The branch a development mirror held before a refresh (null when the
 * mirror does not exist yet or holds no such branch). */
async function developmentBranchBefore(
  input: ResolveRepositoryInput,
  root: string,
): Promise<{ readonly repoPath: string; readonly ref: string; readonly sha: string } | null> {
  const parsed = parseGitUrl(input.url)
  if (parsed === null) return null
  const mirror = await createVolumeRepositoryMirrorStore(root).findCachedRepoByHash(
    gitUrlCacheKeyWith(parsed, sha1Hex).hash,
  )
  if (mirror === null) return null
  const branch = input.ref || mirror.defaultBranch
  if (!branch) return null
  const ref = `refs/heads/${branch}`
  const sha = await runGit(mirror.localPath, ['rev-parse', '--verify', ref, '--'])
  return sha.exitCode === 0 ? { repoPath: mirror.localPath, ref, sha: sha.stdout.trim() } : null
}

async function materializeSingle(
  input: {
    readonly taskId: string
    readonly source: ResolvedRepoSource
    readonly workingBranch?: string
    readonly gitCommitIdentity: GitCommitIdentity | null
  },
  root: string,
  signal?: AbortSignal,
): Promise<MaterializedSpace> {
  const workPath = (path: string) => requireWorkPath(path, root)
  const source = input.source
  const materialized = await materializeWorktree({
    repoPath: workPath(source.repoPath),
    baseBranch: source.resolvedCommit ?? source.baseBranch,
    taskId: input.taskId,
    appHome: root,
    overrideWorktreePath: workPath(join(root, 'worktrees', input.taskId)),
    ...(input.workingBranch === undefined ? {} : { workingBranch: input.workingBranch }),
    gitUserName: input.gitCommitIdentity?.name,
    gitUserEmail: input.gitCommitIdentity?.email,
    ...(signal === undefined ? {} : { signal }),
  })
  return {
    kind: 'single',
    spaceKind: 'remote',
    taskId: input.taskId,
    worktreePath: materialized.worktreePath,
    branch: materialized.branch,
    baseCommit: materialized.baseCommit,
    earlyError: materialized.earlyError,
    resolvedSources: [source],
    nodePaths: [],
    repos: [
      {
        repoIndex: 0,
        repoPath: source.repoPath,
        repoUrl: source.repoUrl,
        cachedRepoId: source.cachedRepoId,
        baseBranch: source.baseBranch ?? 'HEAD',
        branch: materialized.branch,
        baseCommit: materialized.baseCommit,
        worktreePath: materialized.worktreePath,
        worktreeDirName: '',
        mountPath: '',
        subdir: '',
        readonly: false,
        submoduleInitOk: materialized.submoduleInitOk,
        submoduleInitError: materialized.submoduleInitError,
        hasSubmodules: materialized.hasSubmodules,
      },
    ],
    cleanup: {
      taskId: input.taskId,
      ownedRoot: null,
      worktrees: materialized.cleanup === null ? [] : [materialized.cleanup],
      state: 'owned',
      report: null,
    },
  }
}

export async function executeTaskImageWorkspaceOperation(
  operation: string,
  value: unknown,
  signal?: AbortSignal,
  volumeRoot = '/work',
): Promise<unknown> {
  const root = resolve(volumeRoot)
  const workPath = (path: string) => requireWorkPath(path, root)
  if ((TASK_IMAGE_REPOSITORY_OPERATIONS as readonly string[]).includes(operation))
    return executeTaskImageRepositoryOperation(operation, value, root)
  if ((TASK_IMAGE_UPLOAD_OPERATIONS as readonly string[]).includes(operation))
    return executeTaskImageUploadOperation(operation, value, root)
  switch (operation) {
    case 'prepare-development-repository': {
      const input = value as ResolveRepositoryInput
      // The canonical development baseline only ever fast-forwards. The mirror
      // primitive moves a requested branch to its remote tip, so the branch it
      // held before is captured first and a diverged branch is put back.
      const before = await developmentBranchBefore(input, root)
      const source = await resolveRepository(input, root, signal)
      if (
        input.ref &&
        source.ffWarnings.some(
          (outcome) => outcome.branch === input.ref && outcome.warning === 'origin-ref-missing',
        )
      )
        throw new DomainError(
          'repo-ref-not-found',
          `default branch '${input.ref}' no longer exists in the remote; refusing to freeze the stale local branch`,
          400,
          { ref: input.ref },
        )
      const remoteHead =
        input.ref ||
        (
          await runGit(source.repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
        ).stdout
          .trim()
          .replace(/^origin\//, '')
      if (
        !remoteHead ||
        (await runGit(source.repoPath, ['check-ref-format', `refs/heads/${remoteHead}`]))
          .exitCode !== 0
      )
        throw new Error('hosted-repository-default-branch-unavailable')
      const ref = `refs/heads/${remoteHead}`
      const current = await runGit(source.repoPath, ['rev-parse', '--verify', ref, '--'])
      const previous =
        before !== null && before.ref === ref && before.repoPath === source.repoPath
          ? before.sha
          : current.exitCode === 0
            ? current.stdout.trim()
            : null
      if (previous !== null && previous !== source.resolvedCommit) {
        const ancestor = await runGit(source.repoPath, [
          'merge-base',
          '--is-ancestor',
          previous,
          source.resolvedCommit!,
        ])
        if (ancestor.exitCode !== 0) {
          if (current.exitCode === 0 && current.stdout.trim() !== previous)
            await runGit(source.repoPath, ['update-ref', ref, previous, current.stdout.trim()])
          throw new Error('hosted-development-repository-non-fast-forward')
        }
      }
      const updated = await runGit(source.repoPath, [
        'update-ref',
        ref,
        source.resolvedCommit!,
        current.exitCode === 0 ? current.stdout.trim() : '',
      ])
      if (updated.exitCode !== 0) throw new Error('hosted-development-repository-head-changed')
      const head = await runGit(source.repoPath, ['symbolic-ref', 'HEAD', ref])
      if (head.exitCode !== 0) throw new Error('hosted-development-repository-head-unavailable')
      return { path: source.repoPath, defaultBranch: remoteHead }
    }
    case 'isolation-conflict-prepare': {
      const input = value as { conflict: IsolationConflict; containerRef: string }
      return prepareLocalIsolationConflict(
        {
          ...input.conflict,
          canonicalRef: workPath(input.conflict.canonicalRef),
        },
        workPath(input.containerRef),
      )
    }
    case 'isolation-conflict-finish': {
      const input = value as {
        prepared: Extract<PreparedConflictResolution, { kind: 'agent' }>
        agentError?: string
      }
      return finishConflictResolution(
        {
          ...input.prepared,
          resolveIso: workPath(input.prepared.resolveIso),
          conflict: {
            ...input.prepared.conflict,
            canonWorktreePath: workPath(input.prepared.conflict.canonWorktreePath),
          },
        },
        { agentError: input.agentError },
      )
    }
    case 'isolation': {
      const input = value as { binding: IsolationWorkspaceBinding; method: string; args: unknown[] }
      const scope = await createLocalIsolationWorkspaceFactory().bind({
        ...input.binding,
        storageRootRef: root,
        repositories: input.binding.repositories.map((repo) => ({
          ...repo,
          repositoryRef: workPath(repo.repositoryRef),
          workspaceRef: workPath(repo.workspaceRef),
        })),
      })
      switch (input.method) {
        case 'recoverKey':
          return scope.recoverKey(...(input.args as Parameters<typeof scope.recoverKey>))
        case 'chooseGeneration':
          return scope.chooseGeneration(
            ...(input.args as Parameters<typeof scope.chooseGeneration>),
          )
        case 'create':
          return scope.create(...(input.args as Parameters<typeof scope.create>))
        case 'restore':
          return scope.restore(...(input.args as Parameters<typeof scope.restore>))
        case 'head':
          return scope.head(...(input.args as Parameters<typeof scope.head>))
        case 'submodulePresence':
          return scope.submodulePresence(
            ...(input.args as Parameters<typeof scope.submodulePresence>),
          )
        case 'changedFiles':
          return scope.changedFiles(...(input.args as Parameters<typeof scope.changedFiles>))
        case 'blobHashes':
          return scope.blobHashes(...(input.args as Parameters<typeof scope.blobHashes>))
        case 'snapshot':
          // Arguments arrive as JSON, which carries an absent optional list as null.
          return scope.snapshot(
            input.args[0] as Parameters<typeof scope.snapshot>[0],
            undefined,
            (input.args[2] as string[] | null | undefined) ?? undefined,
          )
        case 'merge':
          return scope.merge(...(input.args as Parameters<typeof scope.merge>))
        case 'merge-step':
          return executeTaskImageIsolationMergeStep(
            input.args[0] as Parameters<typeof scope.merge>[0],
            input.args[1] as Parameters<typeof scope.merge>[1],
            input.args[2] as [string, boolean][],
            root,
          )
        case 'undoShard':
          return scope.undoShard(...(input.args as Parameters<typeof scope.undoShard>))
        case 'discard':
          await scope.discard(...(input.args as Parameters<typeof scope.discard>))
          return null
        case 'completeHumanConflict':
          return scope.completeHumanConflict(
            ...(input.args as Parameters<typeof scope.completeHumanConflict>),
          )
        default:
          throw new Error('workspace-isolation-operation-unknown')
      }
    }
    case REPOSITORY_COMMIT_OPERATION: {
      const input = value as {
        method: keyof RepositoryCommitWorkspaceOperations
        path: string
        input: Record<string, unknown>
      }
      const repoPath = workPath(input.path)
      const request = input.input as { gitOptions?: Parameters<typeof runGit>[2] }
      const gitOptions = request.gitOptions === undefined ? {} : { gitOptions: request.gitOptions }
      const configuredPatterns = (input.input.configuredPatterns as readonly string[]) ?? []
      switch (input.method) {
        case 'prepare':
          return prepareRepositoryCommit({ repoPath, configuredPatterns, ...gitOptions })
        case 'commitPrepared': {
          const commit = input.input as Parameters<
            RepositoryCommitWorkspaceOperations['commitPrepared']
          >[0]
          return commitPreparedRepository({
            repoPath,
            message: commit.message,
            verification: commit.verification,
            ...(commit.authorName === undefined ? {} : { authorName: commit.authorName }),
            ...(commit.authorEmail === undefined ? {} : { authorEmail: commit.authorEmail }),
            ...gitOptions,
          })
        }
        case 'preview':
          return readRepositoryCommitPreview({
            repoPath,
            configuredPatterns,
            previewIndex: createFileRepositoryPreviewIndexPort({ repoPath, ...gitOptions }),
          })
        default:
          throw new Error('workspace-repository-commit-operation-unknown')
      }
    }
    case 'git': {
      const input = value as {
        path: string
        args: string[]
        options?: Parameters<typeof runGit>[2]
      }
      return runGit(workPath(input.path), input.args, {
        ...input.options,
        ...(signal === undefined ? {} : { signal }),
      })
    }
    case 'exists':
      return existsSync(workPath((value as { path: string }).path))
    case 'is-git':
      return isGitWorkTree(workPath((value as { path: string }).path))
    case 'git-diff': {
      const input = value as { path: string; from: string }
      return gitDiffSnapshot(workPath(input.path), input.from)
    }
    case 'worktree-diff': {
      const input = value as { path: string; from: string }
      return worktreeDiff(workPath(input.path), input.from)
    }
    case 'git-control':
      return bindFileAgentWorkspaceGitControlObservation({
        workingDirectory: () => workPath((value as { path: string }).path),
      }).capture()
    case 'has-submodules':
      return detectSubmodules(workPath((value as { path: string }).path))
    case 'submodules':
      return listEffectiveSubmodules(workPath((value as { path: string }).path))
    case 'preview-index-create': {
      mkdirSync(join(root, 'tmp'), { recursive: true })
      return join(mkdtempSync(join(root, 'tmp', 'aw-index-')), 'index')
    }
    case 'preview-index-remove': {
      const path = workPath((value as { path: string }).path)
      if (!path.startsWith(join(root, 'tmp', 'aw-index-')) || !path.endsWith(sep + 'index'))
        throw new Error('workspace-preview-index-invalid')
      rmSync(dirname(path), { recursive: true, force: true })
      return null
    }
    case 'write-seeds': {
      const input = value as { path: string; files: readonly { path: string; content: string }[] }
      const root = workPath(input.path)
      mkdirSync(root, { recursive: true })
      for (const file of input.files) {
        const target = workPath(join(root, file.path))
        if (!target.startsWith(root + sep)) throw new Error('workspace-seed-path-outside-root')
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, file.content)
      }
      return null
    }
    case 'resolve-repository':
      return resolveRepository(value as ResolveRepositoryInput, root, signal)
    case 'materialize-single':
      return materializeSingle(value as Parameters<typeof materializeSingle>[0], root, signal)
    case 'materialize-group': {
      const input = value as Omit<
        Parameters<typeof materializeGroupSpace>[0],
        'appHome' | 'signal' | 'lifecycleHook' | 'worktreeMaterializer'
      >
      if (input.planned.length !== input.resolvedSources.length)
        throw new Error('hosted-repository-source-layout-mismatch')
      const groupRoot = workPath(join(root, 'worktrees', 'group', input.taskId))
      const child = (path: string) => {
        if (
          path.includes('\\') ||
          path.includes('\0') ||
          path.split('/').some((part) => part === '.' || part === '..')
        )
          throw new Error('hosted-repository-layout-path-invalid')
        const absolute = workPath(resolve(groupRoot, path))
        if (absolute !== groupRoot && !absolute.startsWith(groupRoot + sep))
          throw new Error('hosted-repository-layout-path-invalid')
      }
      for (const planned of input.planned) {
        child(planned.mountPath)
        child(planned.subdir)
      }
      for (const path of input.nodePaths) child(path)
      for (const source of input.resolvedSources) workPath(source.repoPath)
      return materializeGroupSpace({ ...input, appHome: root, signal })
    }
    case 'cleanup-space':
      return cleanupMaterializedSpace(value as MaterializedSpace)
    case 'scratch': {
      const input = value as { taskId: string; gitCommitIdentity: GitCommitIdentity | null }
      const path = workPath(join(root, 'scratch', input.taskId))
      const result = await initScratchRepo({
        dir: path,
        resumeExisting: true,
        gitUserName: input.gitCommitIdentity?.name,
        gitUserEmail: input.gitCommitIdentity?.email,
      })
      return {
        kind: 'scratch',
        spaceKind: 'scratch',
        taskId: input.taskId,
        worktreePath: path,
        branch: 'main',
        baseCommit: result.ok ? result.rootCommit : null,
        earlyError: result.ok ? null : result.error,
        resolvedSources: [],
        repos: [],
        nodePaths: [],
        cleanup: {
          taskId: input.taskId,
          ownedRoot: path,
          worktrees: [],
          state: 'owned',
          report: null,
        },
      } satisfies MaterializedSpace
    }
    case 'read-json':
      return JSON.parse(readFileSync(workPath((value as { path: string }).path), 'utf8')) as unknown
    case 'workspace-maintenance': {
      const input = value as { method: string; args: unknown[] }
      const filesystem = createNodeWorkspaceMaintenanceFilesystem({
        appHome: root,
        isMaterializingTask: () => false,
        invalidateWorkspacePath: () => undefined,
      })
      switch (input.method) {
        case 'removeWorkspace':
          return filesystem.removeWorkspace(
            ...(input.args as Parameters<typeof filesystem.removeWorkspace>),
          )
        case 'removeIsoContainer':
          return filesystem.removeIsoContainer(
            ...(input.args as Parameters<typeof filesystem.removeIsoContainer>),
          )
        case 'isMerged':
          return filesystem.isMerged(...(input.args as Parameters<typeof filesystem.isMerged>))
        case 'listScratchDirectories':
          return filesystem.listScratchDirectories()
        case 'listWorktreeLeaves':
          return filesystem.listWorktreeLeaves()
        case 'listIsoTaskIds':
          return filesystem.listIsoTaskIds()
        case 'removeAgedPath':
          return filesystem.removeAgedPath(
            ...(input.args as Parameters<typeof filesystem.removeAgedPath>),
          )
        case 'runPartialCloneGc':
          return filesystem.runPartialCloneGc(
            ...(input.args as Parameters<typeof filesystem.runPartialCloneGc>),
          )
        default:
          throw new Error('workspace-maintenance-operation-unknown')
      }
    }
    default:
      throw new Error(`workspace-helper-operation-unknown: ${operation}`)
  }
}
