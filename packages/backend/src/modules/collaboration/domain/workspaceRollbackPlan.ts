import { sha256Hex } from '@/util/hash'
import { canonicalHumanGateValueJson } from './canonicalGateRequest'
import { HumanGateOperationError } from './humanGateOperation'

export interface WorkspaceRollbackCandidateTarget {
  readonly worktreePath: string
  readonly worktreeDirName: string
  readonly snapshot: string
}

export interface WorkspaceRollbackCandidate {
  readonly sourceNodeRunId: string
  readonly targets: readonly WorkspaceRollbackCandidateTarget[]
}

export interface ValidatedWorkspaceRollbackTarget extends WorkspaceRollbackCandidateTarget {
  readonly sourceNodeRunId: string
  readonly ordinal: number
}

export interface ValidatedWorkspaceRollbackPlan {
  readonly schemaVersion: 1
  readonly kind: 'workspace-rollback-plan'
  readonly taskId: string
  readonly targets: readonly ValidatedWorkspaceRollbackTarget[]
  readonly resourceKeys: readonly string[]
  readonly digest: string
}

export function workspaceRollbackPlanDigest(
  plan: Omit<ValidatedWorkspaceRollbackPlan, 'digest'>,
): string {
  return sha256Hex(canonicalHumanGateValueJson(plan))
}

export function validatedWorkspaceRollbackPlan(input: {
  readonly taskId: string
  readonly targets: readonly ValidatedWorkspaceRollbackTarget[]
}): ValidatedWorkspaceRollbackPlan {
  if (input.taskId.length === 0) {
    throw new HumanGateOperationError(
      'human-gate-operation-manifest-invalid',
      'workspace rollback plan requires a task id',
    )
  }
  const ordinals = new Set<number>()
  for (const target of input.targets) {
    if (
      target.sourceNodeRunId.length === 0 ||
      target.worktreePath.length === 0 ||
      target.snapshot.length === 0 ||
      !Number.isSafeInteger(target.ordinal) ||
      target.ordinal < 0 ||
      ordinals.has(target.ordinal)
    ) {
      throw new HumanGateOperationError(
        'human-gate-operation-manifest-invalid',
        'workspace rollback plan target is invalid',
      )
    }
    ordinals.add(target.ordinal)
  }
  const targets = [...input.targets].sort((left, right) => left.ordinal - right.ordinal)
  if (targets.some((target, index) => target.ordinal !== index)) {
    throw new HumanGateOperationError(
      'human-gate-operation-manifest-invalid',
      'workspace rollback plan ordinals must be contiguous',
    )
  }
  const resourceKeys = [
    ...new Set(targets.map((target) => `workspace:${sha256Hex(target.worktreePath)}`)),
  ].sort()
  const content = {
    schemaVersion: 1 as const,
    kind: 'workspace-rollback-plan' as const,
    taskId: input.taskId,
    targets,
    resourceKeys,
  }
  return Object.freeze({
    ...content,
    targets: Object.freeze(targets.map((target) => Object.freeze({ ...target }))),
    resourceKeys: Object.freeze(resourceKeys),
    digest: workspaceRollbackPlanDigest(content),
  })
}
