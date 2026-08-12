// RFC-072 — download a worktree output file (a path<ext> / markdown_file port's
// value is a worktree-relative path, not its content).
//
// RFC-286 F2：bare fetch 收敛——下载走 api.getBlob（auth + 结构化错误解码 +
// 显式大预算），存盘走 lib/download 的 saveBlobAs 单点；本文件不再自带
// `http-<status>` 压平的第二 decoder（后端 code 原样进 ApiError）。

import { api, ApiError } from '@/api/client'
import { downloadBaseName, worktreeFilePath } from '@/components/WorktreeFilesPanel'
import { DOWNLOAD_DEADLINE_MS, saveBlobAs } from '@/lib/download'

/** Fetch `relPath` from the task worktree and trigger a browser download named
 *  after the path's basename. Throws ApiError on a non-2xx response. */
export async function downloadWorktreeFile(
  taskId: string,
  relPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const blob = await api.getBlob(worktreeFilePath(taskId, relPath), undefined, {
    deadlineMs: DOWNLOAD_DEADLINE_MS,
    ...(signal !== undefined ? { signal } : {}),
  })
  saveBlobAs(blob, downloadBaseName(relPath))
}

/** RFC-193 §4.7 — the port-artifacts item path (emit-time archive read). */
export function portArtifactItemPath(
  taskId: string,
  runId: string,
  port: string,
  item = 0,
): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/port-artifacts/${encodeURIComponent(
    runId,
  )}/${encodeURIComponent(port)}?item=${item}`
}

/** Full-URL variant (tasks.preview 的 <img src> 场景仍需要绝对地址)。 */
export function portArtifactItemUrl(
  base: string,
  taskId: string,
  runId: string,
  port: string,
  item = 0,
): string {
  return new URL(portArtifactItemPath(taskId, runId, port, item), base).toString()
}

/**
 * RFC-193 — download a path port's file via the emit-time archive (immune to
 * wrapper scoping / worktree GC), falling back to the worktree-files route on
 * 404 (legacy rows without an archive). Any other failure propagates.
 * RFC-286 F2：api.getBlob 对 !ok 一律 throw，回退链改写为 catch ApiError 404。
 */
export async function downloadPortArtifact(
  taskId: string,
  runId: string,
  port: string,
  relPath: string,
  signal?: AbortSignal,
): Promise<void> {
  let blob: Blob
  try {
    blob = await api.getBlob(portArtifactItemPath(taskId, runId, port), undefined, {
      deadlineMs: DOWNLOAD_DEADLINE_MS,
      ...(signal !== undefined ? { signal } : {}),
    })
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return downloadWorktreeFile(taskId, relPath, signal)
    }
    throw error
  }
  saveBlobAs(blob, downloadBaseName(relPath))
}
