// RFC-370: preserve the full mutable native API; one Task-owned upload policy. RFC-527: the native
// `applyUploadsToWorktree` (only tests used it) moved to tests/helpers/nativeWorkspaceUploads.ts.
import { resolve } from 'node:path'
import type { UploadLimits } from '../../domain/uploads'
import { resolveUniqueUploadNameSync } from '../../application/workspaceUploads'
import type { UploadInputDef, UploadFile } from '../../domain/uploads'
import { entryExists } from '@/platform/content/local/uploadPaths'

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
