import { existsSync, mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { GitCommitIdentity } from '@agent-workflow/shared'
import { requireWorkPath } from '@/platform/crewstation/workVolumePath'
import { runGit, isGitWorkTree, gitDiffSnapshot, worktreeDiff, initScratchRepo } from '@/util/git'
import { detectSubmodules, listEffectiveSubmodules } from '@/services/gitSubmodule'
import {
  materializeWorktree,
  cleanupMaterializedSpace,
} from '../infrastructure/workspaceMaterializer'
import type { MaterializedSpace, ResolvedRepoSource } from '../application/workspaceMaterialization'
import { bindFileAgentWorkspaceGitControlObservation } from '../infrastructure/local/fileAgentWorkspaceGitControl'
import { createNodeWorkspaceMaintenanceFilesystem } from '../infrastructure/nodeWorkspaceMaintenanceFilesystem'
import { createLocalIsolationWorkspaceFactory } from '../infrastructure/local/localIsolationWorkspace'
import type { IsolationWorkspaceBinding } from '../application/ports/isolationWorkspace'

interface ResolveRepositoryInput {
  readonly id: string
  readonly url: string
  readonly ref?: string
  readonly timeoutMs?: number
}

async function resolveRepository(
  input: ResolveRepositoryInput,
  root: string,
  signal?: AbortSignal,
): Promise<ResolvedRepoSource> {
  const workPath = (path: string) => requireWorkPath(path, root)
  // Credentials belong to the task's injected Git credential environment.
  // They must not be captured in a command request or its persisted argv.
  const url = URL.canParse(input.url) ? new URL(input.url) : null
  if (url !== null && (url.username !== '' || url.password !== '' || url.protocol === 'file:')) {
    throw new Error('hosted-repository-requires-remote-url-and-platform-credentials')
  }
  if (url === null && !/^[^/@\s]+@[^/:\s]+:[^\s]+$/.test(input.url))
    throw new Error('hosted-repository-remote-url-required')
  const repoPath = workPath(join(root, 'repos', input.id))
  mkdirSync(dirname(repoPath), { recursive: true })
  const options = {
    timeoutMs: input.timeoutMs ?? 1_800_000,
    ...(signal === undefined ? {} : { signal }),
  }
  if (!existsSync(join(repoPath, '.git'))) {
    const clone = await runGit(root, ['clone', '--no-checkout', '--', input.url, repoPath], options)
    if (clone.exitCode !== 0) throw new Error(`repository-clone-failed: ${clone.stderr}`)
  } else {
    const fetched = await runGit(repoPath, ['fetch', '--prune', 'origin'], options)
    if (fetched.exitCode !== 0) throw new Error(`repository-fetch-failed: ${fetched.stderr}`)
  }
  const requested = input.ref || 'origin/HEAD'
  let revision = await runGit(repoPath, [
    'rev-parse',
    '--verify',
    `${input.ref ? `origin/${input.ref}` : requested}^{commit}`,
    '--',
  ])
  if (revision.exitCode !== 0 && input.ref)
    revision = await runGit(repoPath, ['rev-parse', '--verify', `${requested}^{commit}`, '--'])
  if (revision.exitCode !== 0)
    throw new Error(`repo-ref-not-found: ${requested}: ${revision.stderr}`)
  return {
    repoPath,
    repoUrl: input.url,
    cachedRepoId: input.id,
    baseBranch: input.ref || 'HEAD',
    resolvedCommit: revision.stdout.trim(),
    pathFetchError: null,
    ffWarnings: [],
  }
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
  switch (operation) {
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
          return scope.snapshot(
            input.args[0] as Parameters<typeof scope.snapshot>[0],
            undefined,
            input.args[2] as string[] | undefined,
          )
        case 'merge':
          return scope.merge(...(input.args as Parameters<typeof scope.merge>))
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
