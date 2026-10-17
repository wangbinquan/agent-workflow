// Task-image side of Source Control's repository operations on its volume.
//
// RFC-370 §9.2 V3: candidate and employee Case use cases arrive as ONE command
// each and run the same application function as standalone, with the native
// step effects against the volume. Paths arrive as volume paths and are
// contained to it before any effect.
import { gitCommitExists, runGit } from '@/util/git'
import { mkdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { requireWorkPath } from '@/platform/crewstation/workVolumePath'
import { assertWorkVolumeWritersSettled } from '@/platform/crewstation/workVolumeWriters'
import {
  deriveChangeCandidate,
  stageCandidateTree,
  type DeriveChangeCandidateInput,
  type StageCandidateTreeInput,
} from '../application/changeCandidate'
import {
  commitCandidate,
  pushCandidate,
  type CommitCandidateInput,
  type PushCandidateInput,
} from '../application/deliverCandidate'
import {
  checkpointEmployeeCaseWorkspace,
  discardEmployeeCaseWorkspace,
  fetchEmployeeWorkspaceRemoteHead,
  importEmployeeWorkspaceCommit,
  materializeEmployeeCaseWorkspace,
  rematerializeEmployeeCaseWorkspace,
  resolveEmployeeWorkspaceBaseline,
  restoreEmployeeCaseWorkspace,
} from '../application/employeeCaseWorkspace'
import { createFileRepositoryCandidateEffectsFactory } from '../infrastructure/local/fileRepositoryCandidateEffects'
import { createFileConflictMergeWorkspaceEffects } from '../infrastructure/local/fileConflictMergeWorkspaceEffects'
import { createFileEmployeeCaseWorkspaceEffectsFactory } from '../infrastructure/local/fileEmployeeCaseWorkspaceEffects'
import { createGitTaskDeletionRepositoryEffects } from '../infrastructure/local/gitTaskDeletionRepositoryEffects'
import { ensureWorkspaceExcludeProfile } from '../infrastructure/workspaceExcludeManager'
import { HOSTED_CANDIDATE_OPERATIONS } from '../infrastructure/crewstation/repositoryCandidate'
import { HOSTED_EMPLOYEE_CASE_OPERATION } from '../infrastructure/crewstation/employeeCaseWorkspace'
import type {
  RepositoryPublicationSession,
  RepositoryPublicationSubject,
  RepositoryPublicationTransport,
} from '../public/types'

export const TASK_IMAGE_REPOSITORY_OPERATIONS = [
  'review-snapshot-exists',
  'workspace-exclude-profile',
  ...HOSTED_CANDIDATE_OPERATIONS,
  HOSTED_EMPLOYEE_CASE_OPERATION,
  'conflict-allocate',
  'conflict-workspace',
  'delete-task-repository',
] as const

/** Network Git inside the task image authenticates with the platform's Git
 * credential bindings already present in the process environment. The remote
 * is used as given (no managed endpoint resolution), with the deployment's
 * credentials rather than a per-user code-host credential. */
export function platformPublicationSession(remoteUrl: string): RepositoryPublicationSession {
  return {
    endpointUrl: remoteUrl,
    receipt: {
      credentialSource: 'global',
      credentialRevision: null,
      endpointSource: 'legacy-remote',
      endpointBindingDigest: null,
    },
    runNetwork: (repoPath, args, options) => runGit(repoPath, [...args], options),
    close() {},
  }
}

const platformPublicationTransport: RepositoryPublicationTransport = {
  async open({ remoteUrl }) {
    return { ok: true, session: platformPublicationSession(remoteUrl) }
  },
}

/** Each command reopens the existing native receiver over durable volume paths. */
export async function executeTaskImageRepositoryOperation(
  operation: string,
  value: unknown,
  volumeRoot: string,
): Promise<unknown> {
  const workPath = (path: unknown) => {
    if (typeof path !== 'string') throw new Error('hosted-repository-path-invalid')
    return requireWorkPath(path, volumeRoot)
  }
  const rootFor = (kind: 'candidates' | 'conflicts') => workPath(join(volumeRoot, 'tmp', kind))
  const workspaceFor = (path: string, kind: 'candidates' | 'conflicts') => {
    const workspace = workPath(path)
    const rel = relative(rootFor(kind), workspace).split(sep)
    if (rel.length !== 2 || rel[0] === '..' || !rel[0] || rel[1] !== 'ws')
      throw new Error('hosted-temporary-workspace-owner-mismatch')
    return workspace
  }
  const child = (path: unknown) => {
    if (
      typeof path !== 'string' ||
      path.startsWith('/') ||
      path.includes('\\') ||
      path.includes('\0') ||
      path.split('/').some((segment) => segment === '.' || segment === '..')
    )
      throw new Error('hosted-repository-relative-path-invalid')
    return path
  }
  // Staged trees outlive the command (verification runs in them), so every
  // temporary candidate clone lives in the volume, never in container /tmp.
  const candidates = () => {
    const root = rootFor('candidates')
    mkdirSync(root, { recursive: true })
    return createFileRepositoryCandidateEffectsFactory({ temporaryRoot: root })
  }
  const candidateInput = <T extends { baselineRepoPath: string; overlayRoot?: string }>(
    input: T,
  ): T => ({
    ...input,
    baselineRepoPath: workPath(input.baselineRepoPath),
    ...(input.overlayRoot === undefined ? {} : { overlayRoot: workPath(input.overlayRoot) }),
  })
  switch (operation) {
    case 'workspace-exclude-profile': {
      // RFC-308 per-worktree profile, written by the standalone manager on the
      // task volume's worktree (the service has no Git and no worktrees).
      const input = value as { path: string; directChildMounts: readonly string[] }
      return ensureWorkspaceExcludeProfile({
        worktreePath: workPath(input.path),
        directChildMounts: input.directChildMounts.map(child),
      })
    }
    case 'review-snapshot-exists': {
      const input = value as { path: string; snapshot: string }
      if (!/^[a-f0-9]{40,64}$/.test(input.snapshot))
        throw new Error('hosted-review-snapshot-invalid')
      return gitCommitExists(workPath(input.path), input.snapshot)
    }
    case 'delete-task-repository': {
      const input = value as {
        method: string
        repoPath: string
        worktreePath?: string
        taskId?: string
      }
      const effects = createGitTaskDeletionRepositoryEffects()
      if (input.method === 'removeWorktree')
        return effects.removeWorktree({
          repoPath: workPath(input.repoPath),
          worktreePath: workPath(input.worktreePath),
          force: true,
        })
      if (input.method === 'deleteSnapshotRefs')
        return effects.deleteSnapshotRefs(workPath(input.repoPath), input.taskId!)
      throw new Error('hosted-task-delete-repository-operation-unknown')
    }
    case 'candidate-derive':
      return deriveChangeCandidate(
        candidateInput(value as DeriveChangeCandidateInput),
        candidates(),
      )
    case 'candidate-stage': {
      const staged = await stageCandidateTree(
        candidateInput(value as StageCandidateTreeInput),
        candidates(),
      )
      // The staged tree stays until `candidate-discard`; only its location
      // and identity leave the volume.
      return staged.ok ? { ok: true, ws: staged.ws, treeOid: staged.treeOid } : staged
    }
    case 'candidate-discard': {
      const workspace = workspaceFor(String((value as { ws?: unknown }).ws), 'candidates')
      assertWorkVolumeWritersSettled(volumeRoot, workspace)
      rmSync(dirname(workspace), { recursive: true, force: true })
      return null
    }
    case 'candidate-commit':
      return commitCandidate(candidateInput(value as CommitCandidateInput), candidates())
    case 'candidate-push':
      return pushCandidate(candidateInput(value as PushCandidateInput), candidates(), {
        localFixtureSession: platformPublicationSession,
      })
    case HOSTED_EMPLOYEE_CASE_OPERATION:
      return executeEmployeeCaseOperation(value, workPath, volumeRoot)
    case 'conflict-allocate':
      return createFileConflictMergeWorkspaceEffects().allocate(rootFor('conflicts'))
    case 'conflict-workspace': {
      const input = value as { workspaceReference: string; method: string; args: unknown[] }
      const path = workspaceFor(input.workspaceReference, 'conflicts')
      // Keep cleanup bound to precisely the allocated parent, never the shared root.
      if (basename(path) !== 'ws' || dirname(path) === rootFor('conflicts'))
        throw new Error('hosted-conflict-owner-mismatch')
      const effects = createFileConflictMergeWorkspaceEffects()
      switch (input.method) {
        case 'cloneBaseline':
          return effects.cloneBaseline(path, workPath(input.args[0]))
        case 'installPlatformExclude':
          return effects.installPlatformExclude(path)
        case 'readConflictFile':
          return effects.readConflictFile(path, child(input.args[0]))
        case 'mergeHeadExists':
          return effects.mergeHeadExists(path)
        case 'discard':
          return effects.discard(path)
        default:
          throw new Error('hosted-conflict-operation-unknown')
      }
    }
    default:
      throw new Error('hosted-repository-operation-unknown')
  }
}

async function executeEmployeeCaseOperation(
  value: unknown,
  workPath: (path: unknown) => string,
  volumeRoot: string,
): Promise<unknown> {
  const { method, input } = value as { method: string; input: Record<string, unknown> }
  const effects = createFileEmployeeCaseWorkspaceEffectsFactory()
  const text = (field: unknown) => {
    if (typeof field !== 'string') throw new Error('hosted-employee-case-input-invalid')
    return field
  }
  switch (method) {
    case 'materialize':
      return materializeEmployeeCaseWorkspace(
        {
          caseRoot: workPath(input.caseRoot),
          baselineRepoPath: workPath(input.baselineRepoPath),
          baselineSha: text(input.baselineSha),
        },
        effects,
      )
    case 'rematerialize':
      return rematerializeEmployeeCaseWorkspace(
        {
          caseRoot: workPath(input.caseRoot),
          baselineRepoPath: workPath(input.baselineRepoPath),
          baselineSha: text(input.baselineSha),
          currentWorkspacePath: workPath(input.currentWorkspacePath),
        },
        effects,
      )
    case 'fetchRemoteHead':
      return fetchEmployeeWorkspaceRemoteHead(
        {
          baselineRepoPath: workPath(input.baselineRepoPath),
          remoteUrl: text(input.remoteUrl),
          branch: text(input.branch),
          expectedHeadSha: text(input.expectedHeadSha),
          publicationSubject: (input.publicationSubject as
            | RepositoryPublicationSubject
            | undefined) ?? {
            kind: 'system',
          },
          publicationTransport: platformPublicationTransport,
        },
        effects,
      )
    case 'checkpoint':
      return checkpointEmployeeCaseWorkspace(
        {
          workspacePath: workPath(input.workspacePath),
          checkpointRoot: workPath(input.checkpointRoot),
        },
        effects,
      )
    case 'restore':
      return restoreEmployeeCaseWorkspace(
        {
          caseRoot: workPath(input.caseRoot),
          baselineRepoPath: workPath(input.baselineRepoPath),
          baselineSha: text(input.baselineSha),
          checkpointRoot: workPath(input.checkpointRoot),
          expectedCheckpointDigest: text(input.expectedCheckpointDigest),
        },
        effects,
      )
    case 'discard': {
      const caseRoot = workPath(input.caseRoot)
      if (caseRoot === requireWorkPath(volumeRoot, volumeRoot))
        throw new Error('hosted-workspace-root-removal-refused')
      await discardEmployeeCaseWorkspace(caseRoot, effects)
      return null
    }
    case 'resolveBaseline':
      return resolveEmployeeWorkspaceBaseline(
        {
          baselineRepoPath: workPath(input.baselineRepoPath),
          preferredBranch: (input.preferredBranch as string | null | undefined) ?? null,
          sourceBranch: (input.sourceBranch as string | null | undefined) ?? null,
        },
        effects,
      )
    case 'importCommit':
      await importEmployeeWorkspaceCommit(
        {
          baselineRepoPath: workPath(input.baselineRepoPath),
          sourceRepoPath: workPath(input.sourceRepoPath),
          commitSha: text(input.commitSha),
        },
        effects,
      )
      return null
    default:
      throw new Error('hosted-employee-case-operation-unknown')
  }
}
