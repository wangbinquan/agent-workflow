import type {
  ValidatedWorkspaceRollbackPlan,
  WorkspaceRollbackCandidate,
} from '../domain/workspaceRollbackPlan'
import { validatedWorkspaceRollbackPlan } from '../domain/workspaceRollbackPlan'
import { HumanGateOperationError } from '../domain/humanGateOperation'

export interface WorkspaceRollbackSnapshotInspector {
  snapshotExists(input: {
    readonly worktreePath: string
    readonly snapshot: string
  }): Promise<boolean>
}

export async function prepareWorkspaceRollbackPlan(input: {
  readonly taskId: string
  readonly candidates: readonly WorkspaceRollbackCandidate[]
  readonly inspector: WorkspaceRollbackSnapshotInspector
}): Promise<ValidatedWorkspaceRollbackPlan> {
  const targets = input.candidates.flatMap((candidate) =>
    candidate.targets
      .filter((target) => target.snapshot.length > 0)
      .map((target) => ({
        sourceNodeRunId: candidate.sourceNodeRunId,
        worktreePath: target.worktreePath,
        worktreeDirName: target.worktreeDirName,
        snapshot: target.snapshot,
      })),
  )
  const checks = await Promise.all(
    targets.map(async (target) => ({
      target,
      exists: await input.inspector.snapshotExists({
        worktreePath: target.worktreePath,
        snapshot: target.snapshot,
      }),
    })),
  )
  const missing = checks.filter((check) => !check.exists)
  if (missing.length > 0) {
    throw new HumanGateOperationError(
      'human-gate-operation-manifest-invalid',
      `workspace rollback snapshot is missing for ${missing
        .map((check) => check.target.sourceNodeRunId)
        .join(', ')}`,
      { missingCount: missing.length },
    )
  }
  return validatedWorkspaceRollbackPlan({
    taskId: input.taskId,
    targets: targets.map((target, ordinal) => ({ ...target, ordinal })),
  })
}
