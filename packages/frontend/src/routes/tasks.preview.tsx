// RFC-105 — /tasks/$id/preview — standalone Markdown preview page.
//
// A dedicated route (not a modal) so the preview is shareable + browser-back
// returns. Reuses the review interface's renderer (`components/prose/Prose`):
// mermaid / PlantUML / KaTeX / shiki / GFM / heading anchors all render exactly
// as in the review pane. The markdown body is rebuilt from the URL search:
//   - file source   `?path=<worktree-rel>`   → GET worktree-file (shared cache)
//   - inline port    `?runId=&port=`          → value from the node-runs outputs
// A "← 返回" link goes back to the owning task detail.

import { useQuery } from '@tanstack/react-query'
import { createRoute, Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { NodeRunOutput, TaskNodeRuns, WorktreeFileResponse } from '@agent-workflow/shared'
import { WORKTREE_FILE_MAX_BYTES } from '@agent-workflow/shared'
import { api, ApiError, fetchOrNetworkError } from '@/api/client'
import { fetchWorktreeFile } from '@/api/worktreeFiles'
import { portArtifactItemUrl } from '@/lib/worktree-download'
import { getBaseUrl, getToken } from '@/stores/auth'
import { ErrorBanner } from '@/components/ErrorBanner'
import { EmptyState } from '@/components/EmptyState'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { Prose } from '@/components/prose/Prose'
import { formatBytes } from '@/components/WorktreeFilesPanel'
import { downloadWorktreeFile } from '@/lib/worktree-download'
import {
  resolvePreviewSource,
  validatePreviewSearch,
  type PreviewResolution,
} from '@/lib/markdown-preview'
import { useState } from 'react'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/tasks/$id/preview',
  validateSearch: (raw: Record<string, unknown>) => validatePreviewSearch(raw),
  component: TaskMarkdownPreviewPage,
})

function deriveTitle(source: PreviewResolution, explicit: string | undefined): string {
  if (explicit !== undefined && explicit.length > 0) return explicit
  if (source.mode === 'file') {
    const segs = source.path.split('/').filter((s) => s.length > 0)
    return segs.length > 0 ? (segs[segs.length - 1] as string) : source.path
  }
  if (source.mode === 'port') return source.port
  return ''
}

export function TaskMarkdownPreviewPage() {
  const { t } = useTranslation()
  const { id } = Route.useParams()
  const search = Route.useSearch()
  const source = resolvePreviewSource(search)
  const title = deriveTitle(source, search.title) || t('taskPreview.title')

  return (
    <div className="page page--md-preview">
      <PageHeader
        back={
          <Link
            to="/tasks/$id"
            params={{ id }}
            className="btn btn--sm"
            data-testid="md-preview-back"
          >
            ← {t('taskPreview.back')}
          </Link>
        }
        title={
          <span className="md-preview__title" title={title}>
            {title}
          </span>
        }
      />
      <div className="md-preview__body">
        {source.mode === 'invalid' ? (
          <div data-testid="md-preview-invalid">
            <NoticeBanner tone="error" size="compact">
              {t('taskPreview.invalidLink')}
            </NoticeBanner>
          </div>
        ) : source.mode === 'file' ? (
          <FilePreviewBody taskId={id} path={source.path} />
        ) : source.mode === 'artifact' ? (
          <ArtifactPreviewBody
            taskId={id}
            path={source.path}
            runId={source.runId}
            port={source.port}
          />
        ) : (
          <PortPreviewBody taskId={id} runId={source.runId} port={source.port} />
        )}
      </div>
    </div>
  )
}

// RFC-193 — artifact source: body from the emit-time archive (port-artifacts
// API, immune to wrapper scoping / worktree GC); a 404 (legacy row without an
// archive) falls back to the FILE source so old tasks render exactly as
// before. A truncated archive copy renders with a visible banner.
function ArtifactPreviewBody({
  taskId,
  path,
  runId,
  port,
}: {
  taskId: string
  path: string
  runId: string
  port: string
}) {
  const { t } = useTranslation()
  const q = useQuery<{ body: string; truncated: boolean } | { fallback: true }>({
    queryKey: ['portArtifact', taskId, runId, port],
    queryFn: async ({ signal }) => {
      const token = getToken()
      const headers: Record<string, string> = {}
      if (token !== null) headers.Authorization = `Bearer ${token}`
      // RFC-203: tagged fetch — this queryFn's rejection feeds <ErrorBanner>/
      // resolveApiError, so offline must classify as network-unreachable
      // instead of leaking a verbatim TypeError("Failed to fetch").
      const res = await fetchOrNetworkError(
        portArtifactItemUrl(getBaseUrl(), taskId, runId, port),
        {
          headers,
          ...(signal !== undefined ? { signal } : {}),
        },
      )
      if (res.status === 404) return { fallback: true as const }
      if (!res.ok) throw new ApiError(res.status, `http-${res.status}`, res.statusText)
      return {
        body: await res.text(),
        truncated: res.headers.get('x-aw-artifact-truncated') === '1',
      }
    },
    staleTime: 0,
  })
  const data = q.data
  if (data === undefined) {
    if (q.error !== null && q.error !== undefined)
      return <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
    if (q.isLoading) return <LoadingState size="compact" />
    return null
  }
  if ('fallback' in data) return <FilePreviewBody taskId={taskId} path={path} />
  return (
    <>
      {q.error !== null && q.error !== undefined && (
        <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      )}
      {data.truncated && (
        <div className="md-preview__truncated muted" role="note" data-testid="md-preview-truncated">
          {t('taskOutputs.artifactTruncated')}
        </div>
      )}
      <PreviewContent body={data.body} taskId={taskId} />
    </>
  )
}

function FilePreviewBody({ taskId, path }: { taskId: string; path: string }) {
  const q = useQuery<WorktreeFileResponse>({
    // Same key as WorktreeFilesPanel → a file the user just viewed renders from
    // cache (a staleTime:0 background revalidate still fires, which is fine).
    queryKey: ['worktreeFile', taskId, path],
    queryFn: ({ signal }) => fetchWorktreeFile(taskId, path, signal),
    staleTime: 0,
  })
  const data = q.data
  if (data === undefined) {
    if (q.error !== null && q.error !== undefined)
      return <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
    if (q.isLoading) return <LoadingState size="compact" />
    return null
  }
  return (
    <>
      {q.error !== null && q.error !== undefined && (
        <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      )}
      {data.oversized ? (
        <OversizedHint taskId={taskId} path={path} size={data.size} />
      ) : (
        <PreviewContent body={data.content} taskId={taskId} />
      )}
    </>
  )
}

function PortPreviewBody({ taskId, runId, port }: { taskId: string; runId: string; port: string }) {
  const q = useQuery<TaskNodeRuns>({
    queryKey: ['tasks', taskId, 'node-runs'],
    queryFn: ({ signal }) =>
      api.get(`/api/tasks/${encodeURIComponent(taskId)}/node-runs`, undefined, signal),
  })
  const data = q.data
  if (data === undefined) {
    if (q.error !== null && q.error !== undefined)
      return <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
    if (q.isLoading) return <LoadingState size="compact" />
    return null
  }
  const out = data.outputs.find((o: NodeRunOutput) => o.nodeRunId === runId && o.port === port)
  return (
    <>
      {q.error !== null && q.error !== undefined && (
        <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      )}
      <PreviewContent body={out?.value ?? null} taskId={taskId} />
    </>
  )
}

function PreviewContent({ body, taskId }: { body: string | null; taskId: string }) {
  const { t } = useTranslation()
  if (body === null) {
    return (
      <EmptyState
        title={t('taskPreview.pending')}
        size="compact"
        data-testid="md-preview-missing"
      />
    )
  }
  if (body.trim() === '') {
    return <EmptyState title={t('common.empty')} size="compact" data-testid="md-preview-empty" />
  }
  return <Prose body={body} taskId={taskId} className="md-preview__prose" />
}

function OversizedHint({ taskId, path, size }: { taskId: string; path: string; size: number }) {
  const { t } = useTranslation()
  const [downloading, setDownloading] = useState(false)
  const [failed, setFailed] = useState(false)
  function onDownload() {
    if (downloading) return
    setDownloading(true)
    setFailed(false)
    void downloadWorktreeFile(taskId, path)
      .catch(() => setFailed(true))
      .finally(() => setDownloading(false))
  }
  return (
    <div className="md-preview__oversized" data-testid="md-preview-oversized">
      <p className="muted">
        {t('tasks.worktreeFilesOversized', {
          size: formatBytes(size),
          limit: formatBytes(WORKTREE_FILE_MAX_BYTES),
        })}
      </p>
      <button type="button" className="btn btn--sm" onClick={onDownload} disabled={downloading}>
        <span aria-hidden="true">↓</span>{' '}
        {downloading ? t('tasks.worktreeFilesDownloading') : t('tasks.worktreeFilesDownload')}
      </button>
      {failed && (
        <span className="muted" role="alert">
          {' '}
          {t('tasks.worktreeFilesDownloadError')}
        </span>
      )}
    </div>
  )
}
