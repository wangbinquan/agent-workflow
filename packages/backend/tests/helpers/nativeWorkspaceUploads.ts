// RFC-527: the native upload entry only tests used, moved out of production
// (modules/task-execution/infrastructure/local/nativeWorkspaceUploads.ts keeps its plan and result types). It lands a
// plan through the one Task-owned upload policy with the local upload content — what the retired fallback built.
import { createFileWorkspaceUploadContentFactory } from '@/modules/source-control/composition'
import type {
  WorkspaceUploadPlan,
  WorkspaceUploadResult,
} from '@/modules/task-execution/application/ports/workspaceUploads'
import { applyWorkspaceUploads } from '@/modules/task-execution/composition/workspaceUploads'
import type {
  UploadPlan,
  UploadResult,
} from '@/modules/task-execution/infrastructure/local/nativeWorkspaceUploads'

function isNativeUploadResult(value: WorkspaceUploadResult): value is UploadResult {
  return value.packedByKey instanceof Map
}

export async function applyUploadsToWorktree(plan: UploadPlan): Promise<UploadResult> {
  const request: WorkspaceUploadPlan = {
    workspace: { workspaceRef: plan.worktreePath },
    defs: plan.defs,
    files: plan.files,
    limits: plan.limits,
    ...(plan.inputsSubdir === undefined ? {} : { inputsSubdir: plan.inputsSubdir }),
    ...(plan.recovery === undefined ? {} : { recovery: plan.recovery }),
  }
  const result = await applyWorkspaceUploads(request, createFileWorkspaceUploadContentFactory())
  if (!isNativeUploadResult(result))
    throw new TypeError('Native uploads require their mutable result')
  return result
}
