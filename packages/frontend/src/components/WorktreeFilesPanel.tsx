// RFC-065 — task detail page "工作目录" tab.
//
// Two-column layout: left side is a lazy-loaded directory tree (folders
// collapsed by default, click to expand/collapse), right side renders the
// selected file's content as plain text inside a <pre>. Files > 2 MiB are
// not previewed — the server returns oversized:true and the panel shows a
// human-readable hint with the real byte count.
//
// State is intentionally kept inside the panel (not lifted to the page
// route) so switching to another tab and back preserves the user's
// expand/select state for the lifetime of the task-detail mount.

import { useMemo, useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { DOWNLOAD_DEADLINE_MS, saveBlobAs } from '@/lib/download'
import { fetchWorktreeFile, fetchWorktreeTree } from '@/api/worktreeFiles'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { buildPreviewTarget, isMarkdownPath } from '@/lib/markdown-preview'
import {
  WORKTREE_DIR_MAX_ENTRIES,
  WORKTREE_FILE_MAX_BYTES,
  type WorktreeFileResponse,
  type WorktreeTreeEntry,
  type WorktreeTreeResponse,
} from '@agent-workflow/shared'

// ---------- pure helpers (exported for unit tests) ----------

/** Format a byte count into a short human-readable string. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return `${n} B`
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`
}

/** Join a parent rel-path and a child name into a posix rel-path. */
export function joinRel(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`
}

/**
 * Absolute URL of the raw-bytes download endpoint (RFC-005
 * `GET /api/worktree-files/:taskId/*`) for one worktree file. Unlike the JSON
 * preview endpoint this one has no 2 MiB cap, so oversized files download in
 * full. Each path segment is encodeURIComponent'd then rejoined with a literal
 * '/', which round-trips correctly through the endpoint's single
 * decodeURIComponent — spaces / '#' / '?' / '%' in names are all safe.
 */
export function worktreeFilePath(taskId: string, relPath: string): string {
  const segments = relPath
    .split('/')
    .filter((s) => s.length > 0)
    .map(encodeURIComponent)
  return `/api/worktree-files/${encodeURIComponent(taskId)}/${segments.join('/')}`
}

export function worktreeFileDownloadUrl(baseUrl: string, taskId: string, relPath: string): string {
  return new URL(worktreeFilePath(taskId, relPath), baseUrl).toString()
}

/** The basename a download should be saved as; '/'-only or empty → 'download'. */
export function downloadBaseName(relPath: string): string {
  const segments = relPath.split('/').filter((s) => s.length > 0)
  return segments.length > 0 ? (segments[segments.length - 1] as string) : 'download'
}

// ---------- API client wrappers ----------
// RFC-105: the tree + file fetchers moved to `@/api/worktreeFiles` so the
// Markdown preview route shares the exact fetch + query key. Imported above.

// ---------- Components ----------

export function WorktreeFilesPanel({ taskId }: { taskId: string }): ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  // expand state lives here so it survives subtree unmount/remount as the
  // user collapses/expands intermediate folders.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  function toggle(relPath: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(relPath)) next.delete(relPath)
      else next.add(relPath)
      return next
    })
  }

  // The tree + file queries use staleTime/gcTime Infinity (intentional — see
  // DirChildren below). That means data fetched while the worktree was empty
  // is otherwise stuck forever. Refresh invalidates every cached tree level
  // for this task plus the currently previewed file.
  function refresh(): void {
    void qc.invalidateQueries({ queryKey: ['worktreeTree', taskId] })
    void qc.invalidateQueries({ queryKey: ['worktreeFile', taskId] })
  }

  return (
    <div className="worktree-files-panel" data-testid="worktree-files-panel">
      <div className="worktree-files-panel__tree">
        <div className="worktree-files-panel__tree-header">
          <button
            type="button"
            className="btn btn--sm"
            onClick={refresh}
            data-testid="worktree-files-refresh"
          >
            {t('tasks.worktreeFilesRefresh')}
          </button>
        </div>
        <div
          className="worktree-files-panel__tree-body"
          role="tree"
          aria-label={t('tasks.worktreeFilesTreeAria')}
        >
          <DirChildren
            taskId={taskId}
            dirPath=""
            depth={0}
            expanded={expanded}
            onToggle={toggle}
            selectedPath={selectedPath}
            onSelectFile={setSelectedPath}
          />
        </div>
      </div>
      <div className="worktree-files-panel__preview">
        <WorktreeFilePreview taskId={taskId} path={selectedPath} />
      </div>
    </div>
  )
}

interface DirChildrenProps {
  taskId: string
  dirPath: string
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
  selectedPath: string | null
  onSelectFile: (path: string) => void
}

function DirChildren(props: DirChildrenProps): ReactElement {
  const { t } = useTranslation()
  const q = useQuery<WorktreeTreeResponse>({
    queryKey: ['worktreeTree', props.taskId, props.dirPath],
    queryFn: ({ signal }) => fetchWorktreeTree(props.taskId, props.dirPath, signal),
    // Cache forever within this mount — collapsing and re-expanding a folder
    // should not re-hit the server (RFC-065 acceptance §3). Worktrees do
    // change as the worker writes files, but a refresh requires leaving
    // the tab and coming back; that re-mount busts the cache naturally.
    staleTime: Infinity,
    gcTime: Infinity,
  })

  if (q.isLoading) {
    return (
      <div className="worktree-files-tree__loading" style={{ paddingLeft: indentFor(props.depth) }}>
        <LoadingState size="compact" />
      </div>
    )
  }
  if (q.error !== null && q.error !== undefined) {
    return (
      <div className="worktree-files-tree__error" style={{ paddingLeft: indentFor(props.depth) }}>
        <ErrorBanner error={q.error} />
      </div>
    )
  }
  const data = q.data
  if (data === undefined) return <></>

  return (
    <ul className="worktree-files-tree__list" role="group">
      {data.entries.map((entry) => (
        <TreeEntry
          key={entry.name}
          parentPath={props.dirPath}
          entry={entry}
          depth={props.depth}
          expanded={props.expanded}
          onToggle={props.onToggle}
          selectedPath={props.selectedPath}
          onSelectFile={props.onSelectFile}
          taskId={props.taskId}
        />
      ))}
      {data.truncated && (
        <li
          className="worktree-files-tree__row worktree-files-tree__row--truncated"
          style={{ paddingLeft: indentFor(props.depth + 1) }}
        >
          {t('tasks.worktreeFilesTruncated', { limit: WORKTREE_DIR_MAX_ENTRIES })}
        </li>
      )}
    </ul>
  )
}

interface TreeEntryProps {
  taskId: string
  parentPath: string
  entry: WorktreeTreeEntry
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
  selectedPath: string | null
  onSelectFile: (path: string) => void
}

function TreeEntry(props: TreeEntryProps): ReactElement {
  const { entry, depth, parentPath } = props
  const rel = joinRel(parentPath, entry.name)
  if (entry.kind === 'directory') {
    const isOpen = props.expanded.has(rel)
    return (
      <li role="treeitem" aria-expanded={isOpen}>
        <button
          type="button"
          className="worktree-files-tree__row worktree-files-tree__row--dir"
          style={{ paddingLeft: indentFor(depth) }}
          onClick={() => props.onToggle(rel)}
          data-testid={`worktree-tree-dir-${rel}`}
        >
          <span className="worktree-files-tree__caret" aria-hidden>
            {isOpen ? '▾' : '▸'}
          </span>
          <span className="worktree-files-tree__name">{entry.name}</span>
        </button>
        {isOpen && (
          <DirChildren
            taskId={props.taskId}
            dirPath={rel}
            depth={depth + 1}
            expanded={props.expanded}
            onToggle={props.onToggle}
            selectedPath={props.selectedPath}
            onSelectFile={props.onSelectFile}
          />
        )}
      </li>
    )
  }
  const isSelected = props.selectedPath === rel
  return (
    <li role="treeitem">
      <button
        type="button"
        className={
          'worktree-files-tree__row worktree-files-tree__row--file' +
          (isSelected ? ' is-selected' : '')
        }
        style={{ paddingLeft: indentFor(depth) }}
        aria-pressed={isSelected}
        onClick={() => props.onSelectFile(rel)}
        data-testid={`worktree-tree-file-${rel}`}
      >
        <span className="worktree-files-tree__name">{entry.name}</span>
      </button>
    </li>
  )
}

function indentFor(depth: number): string {
  // 16px per level keeps deep nesting readable without overflowing the
  // 220-320px tree column.
  return `${depth * 16}px`
}

// Fetch the file as a Blob through the authenticated channel. The token rides
// the Authorization header (not a `?token=` query) so it never leaks into the
// URL, and a blob works cross-origin too — a plain <a download> pointing at a
// remote-daemon base URL would have its `download` attribute ignored.
// RFC-286 F2：bare fetch 收敛 api.getBlob（结构化错误解码 + 显式大预算）。
async function fetchWorktreeFileBlob(
  taskId: string,
  relPath: string,
  signal?: AbortSignal,
): Promise<Blob> {
  return api.getBlob(worktreeFilePath(taskId, relPath), undefined, {
    deadlineMs: DOWNLOAD_DEADLINE_MS,
    signal,
  })
}

// Top-right download button shown for the opened file in both the normal and
// the oversized preview states — oversized files can't be previewed but must
// still be downloadable (RFC-071).
function DownloadFileButton({ taskId, path }: { taskId: string; path: string }): ReactElement {
  const { t } = useTranslation()
  const [downloading, setDownloading] = useState(false)
  const [failed, setFailed] = useState(false)

  async function onClick(): Promise<void> {
    if (downloading) return
    setDownloading(true)
    setFailed(false)
    try {
      const blob = await fetchWorktreeFileBlob(taskId, path)
      saveBlobAs(blob, downloadBaseName(path))
    } catch {
      setFailed(true)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn--sm worktree-files-preview__download"
        disabled={downloading}
        onClick={() => void onClick()}
        data-testid="worktree-files-download"
        title={t('tasks.worktreeFilesDownload')}
      >
        <span aria-hidden="true">↓</span>{' '}
        {downloading ? t('tasks.worktreeFilesDownloading') : t('tasks.worktreeFilesDownload')}
      </button>
      {failed && (
        <span
          className="worktree-files-preview__download-error"
          role="alert"
          data-testid="worktree-files-download-error"
        >
          {t('tasks.worktreeFilesDownloadError')}
        </span>
      )}
    </>
  )
}

export function WorktreeFilePreview({
  taskId,
  path,
}: {
  taskId: string
  path: string | null
}): ReactElement {
  const { t } = useTranslation()
  const enabled = path !== null
  const q = useQuery<WorktreeFileResponse>({
    queryKey: ['worktreeFile', taskId, path],
    queryFn: ({ signal }) => fetchWorktreeFile(taskId, path as string, signal),
    enabled,
    staleTime: 0,
  })

  const sizeLabelData = useMemo(
    () => (q.data === undefined ? null : formatBytes(q.data.size)),
    [q.data],
  )

  if (path === null) {
    return (
      <div className="worktree-files-preview__empty" data-testid="worktree-files-preview-empty">
        <p className="muted">{t('tasks.worktreeFilesEmpty')}</p>
      </div>
    )
  }
  if (q.isLoading) return <LoadingState size="compact" />
  if (q.error !== null && q.error !== undefined) return <ErrorBanner error={q.error} />
  const data = q.data
  if (data === undefined) return <></>

  if (data.oversized) {
    return (
      <div
        className="worktree-files-preview__oversized"
        data-testid="worktree-files-preview-oversized"
      >
        <div className="worktree-files-preview__header">
          <code className="worktree-files-preview__path">{path}</code>
          <div className="worktree-files-preview__header-actions">
            <DownloadFileButton taskId={taskId} path={path} />
          </div>
        </div>
        <p className="muted">
          {t('tasks.worktreeFilesOversized', {
            size: formatBytes(data.size),
            limit: formatBytes(WORKTREE_FILE_MAX_BYTES),
          })}
        </p>
      </div>
    )
  }
  return (
    <div className="worktree-files-preview__body" data-testid="worktree-files-preview-body">
      <div className="worktree-files-preview__header">
        <code className="worktree-files-preview__path">{path}</code>
        <div className="worktree-files-preview__header-actions">
          <span className="worktree-files-preview__size muted">
            {t('tasks.worktreeFilesSizeHeader', { size: sizeLabelData ?? '' })}
          </span>
          {/* RFC-105: render-preview for markdown files (opens the standalone
              /tasks/$id/preview page reusing the review renderer). */}
          {isMarkdownPath(path) && (
            <Link
              {...buildPreviewTarget(taskId, { kind: 'file', path })}
              className="btn btn--sm"
              data-testid="worktree-files-preview-btn"
            >
              {t('taskPreview.button')}
            </Link>
          )}
          <DownloadFileButton taskId={taskId} path={path} />
        </div>
      </div>
      <pre className="worktree-files-preview__pre">{data.content}</pre>
    </div>
  )
}
