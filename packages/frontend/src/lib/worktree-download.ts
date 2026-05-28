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
  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = downloadBaseName(relPath)
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
