// RFC-420 — entering a wrapper body, moved from the wrapper scope driver binding (`composition/wrapperMechanics.ts`
// `scopeDriver.drive`): the body's repository mounts over the scene's iso handle, the scope log, the RFC-370 merge
// completion and the body scope drive. `S` is the execution state the composition assembles; the engine never reads
// it, it only hands the body's state from `enter` to `completeMerges` and `drive`.
import type { IsoHandle } from '@/platform/contracts/isolationWorkspace'
import type { FrameCoordinate } from '../../domain/environmentChain'
import type { TaskScopeOutcome } from '../../domain/taskEngine'
import type { TaskRepositoryMount } from '../../domain/taskRepository'
import type { WrapperNodeKind } from '../../domain/wrapperExecution'
import type { DagScopeArgs } from '../../application/ports/dagScope'
import type { Logger } from '../../application/ports/executionKernel'
import type { WrapperScopeDriverPort } from '../../application/ports/wrapperScopeDriver'
import type { WrapperWorkspaceScene } from '../../application/ports/wrapperWorkspace'

/** A wrapper body's repositories and container root. */
export interface WrapperBodyMounts {
  readonly repos: TaskRepositoryMount[]
  readonly scopeRoot: string
}

/**
 * The body's mounts over an isolated scene; null when the scene runs in place (passthrough), where the body runs in
 * the outer state. A loop body keeps the outer mount path and read-only flag of each repository; a git body uses the
 * iso's mount and is writable.
 */
export function wrapperBodyMounts(
  outer: readonly TaskRepositoryMount[],
  handle: IsoHandle,
  kind: WrapperNodeKind,
): WrapperBodyMounts | null {
  if (handle.passthrough) return null
  return {
    repos: handle.repos.map((repo, index) => ({
      ...outer[index]!,
      ordinal: outer[index]!.ordinal,
      repoPath: repo.repoPath,
      worktreePath: repo.isoWorktreePath,
      mountPath:
        kind === 'wrapper-loop' ? (outer[index]?.mountPath ?? repo.mountPath) : repo.mountPath,
      readonly: kind === 'wrapper-loop' ? (outer[index]?.readonly ?? false) : false,
      baseBranch: repo.baseBranch,
      baseCommit: repo.baseSnapshot,
    })),
    scopeRoot: handle.containerPath,
  }
}

/** The capabilities of a wrapper body's entry over the composition's execution state `S`. */
export interface WrapperBodyScopePorts<S> {
  /** The state the wrapper node runs in. */
  readonly outer: S
  /** The outer state's repositories; each body mount extends its outer row. */
  readonly outerRepos: readonly TaskRepositoryMount[]
  /** The scene's iso handle and wrapper kind (the wrapper workspace opened it). */
  resolve(scene: WrapperWorkspaceScene): {
    readonly handle: IsoHandle
    readonly kind: WrapperNodeKind
  }
  /** The body's state: the outer state over the body's mounts. */
  enter(mounts: WrapperBodyMounts): S
  completeMerges(state: S, frame: FrameCoordinate, log: Logger): Promise<void>
  drive(state: S, args: DagScopeArgs): Promise<TaskScopeOutcome>
}

export function createWrapperScopeDriver<S>(
  ports: WrapperBodyScopePorts<S>,
  executionLog: Logger,
): WrapperScopeDriverPort {
  return {
    drive(input) {
      const { handle, kind } = ports.resolve(input.workspace)
      const mounts = wrapperBodyMounts(ports.outerRepos, handle, kind)
      const innerState = mounts === null ? ports.outer : ports.enter(mounts)
      const label = kind === 'wrapper-loop' ? 'loop' : 'git'
      const scopeLog = executionLog.child(`${label}:${input.scope.wrapperId}`)
      // RFC-370 — a revived body first finishes the merge-backs a crash or a
      // lost execution lease interrupted in it, into this wrapper's worktree.
      return ports
        .completeMerges(
          innerState,
          { containerRunId: input.containerRunId, iteration: input.iteration },
          scopeLog,
        )
        .then(() =>
          ports.drive(innerState, {
            scopeId: input.scope.wrapperId,
            scopeIds: new Set(input.scope.directNodeIds),
            containerRunId: input.containerRunId,
            iteration: input.iteration,
            log: scopeLog,
          }),
        )
    },
  }
}
