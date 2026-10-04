// RFC-370: preserve the full mutable native API; one Task-owned upload policy.
import { resolve } from 'node:path'
import { applyWorkspaceUploads } from '@/modules/task-execution/public/commands'
import { resolveUniqueUploadNameSync } from '@/modules/task-execution/public/queries'
import type {
  UploadInputDef,
  UploadFile,
  UploadLimits,
  WorkspaceUploadPlan,
  WorkspaceUploadResult,
} from '@/modules/task-execution/public/types'
import { entryExists } from './uploadPaths'

export interface UploadPlan {
  /** Task-owned recovery journal; absent preserves the original upload path. */
  recovery?: {
    placement(index: number): string | null
    reserve(index: number, filename: string): Promise<void>
  }

  /**
   * RFC-248 D12: 上传物的额外根前缀（相对 `worktreePath`）。多仓任务传
   * `.agent-workflow/inputs`——上传物不属于任何成员仓，落进某个仓会变成它的
   * 未跟踪改动、进审计 diff 与自动提交。单仓任务不传，路径保持 baseline。
   */
  inputsSubdir?: string
  worktreePath: string
  defs: ReadonlyMap<string, UploadInputDef>
  files: readonly UploadFile[]
  limits: UploadLimits
}

export interface UploadResult {
  /** key → repo-relative paths in the same order the files were submitted. */
  packedByKey: Map<string, string[]>
}

/** Pick the original name without creating a directory, using the single policy. */
export function resolveUniqueName(dir: string, filename: string): string {
  return resolveUniqueUploadNameSync(filename, (candidate) => entryExists(resolve(dir, candidate)))
}

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
  const result = await applyWorkspaceUploads(request)
  if (!isNativeUploadResult(result))
    throw new TypeError('Native uploads require their mutable result')
  return result
}
