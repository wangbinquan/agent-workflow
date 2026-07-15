// RFC-072 — download a worktree output file (a path<ext> / markdown_file port's
// value is a worktree-relative path, not its content).
//
// Coordination with RFC-071 (worktree-files tab download, in-flight in the
// working tree): we REUSE its exported URL/basename builders from
// WorktreeFilesPanel so the path-encoding + filename logic stays single-sourced,
// and we do NOT edit that contributor's uncommitted file. The blob fetch + save
// glue below is small framework boilerplate (mirrors WorktreeFilesPanel's
// private saveBlob and routes/reviews.detail.tsx's markdown export).
//
// Why blob fetch (not a plain <a download href>): the raw-file route needs auth
// and getBaseUrl() may point at a remote (cross-origin) daemon, where a plain
// <a download> attribute is ignored. Fetching with the Authorization header and
// saving an object URL works cross-origin and keeps the token out of the URL.

import { ApiError } from '@/api/client'
import { downloadBaseName, worktreeFileDownloadUrl } from '@/components/WorktreeFilesPanel'
import { getBaseUrl, getToken } from '@/stores/auth'

/** Fetch `relPath` from the task worktree and trigger a browser download named
 *  after the path's basename. Throws ApiError on a non-2xx response. */
export async function downloadWorktreeFile(taskId: string, relPath: string): Promise<void> {
  const token = getToken()
  const headers: Record<string, string> = {}
  if (token !== null) headers.Authorization = `Bearer ${token}`
  const res = await fetch(worktreeFileDownloadUrl(getBaseUrl(), taskId, relPath), { headers })
  if (!res.ok) {
    throw new ApiError(res.status, `http-${res.status}`, res.statusText || 'download failed')
  }
  await saveBlobAs(await res.blob(), downloadBaseName(relPath))
}

/** RFC-193 §4.7 — the port-artifacts item URL (emit-time archive read). */
export function portArtifactItemUrl(
  base: string,
  taskId: string,
  runId: string,
  port: string,
  item = 0,
): string {
  return `${base}/api/tasks/${encodeURIComponent(taskId)}/port-artifacts/${encodeURIComponent(
    runId,
  )}/${encodeURIComponent(port)}?item=${item}`
}

/**
 * RFC-193 — download a path port's file via the emit-time archive (immune to
 * wrapper scoping / worktree GC), falling back to the worktree-files route on
 * 404 (legacy rows without an archive). Any other failure propagates.
 */
export async function downloadPortArtifact(
  taskId: string,
  runId: string,
  port: string,
  relPath: string,
): Promise<void> {
  const token = getToken()
  const headers: Record<string, string> = {}
  if (token !== null) headers.Authorization = `Bearer ${token}`
  const res = await fetch(portArtifactItemUrl(getBaseUrl(), taskId, runId, port), { headers })
  if (res.status === 404) {
    return downloadWorktreeFile(taskId, relPath)
  }
  if (!res.ok) {
    throw new ApiError(res.status, `http-${res.status}`, res.statusText || 'download failed')
  }
  await saveBlobAs(await res.blob(), downloadBaseName(relPath))
}

async function saveBlobAs(blob: Blob, name: string): Promise<void> {
  const objectUrl = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = name
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
