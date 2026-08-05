// RFC-258 §4.1 — the read-only source viewer: full-file shiki highlight with
// change-gutter ranges, fold-away unchanged stretches, line focus, and the
// identifier-click layer. Design-gate constraints baked in:
//  - F-14: a THREE-axis budget (bytes / lines / longest line) gates shiki; an
//    over-budget file renders as plain text with line numbers and stays fully
//    clickable. Highlight results carry a request version — a stale async
//    result is dropped, never written back.
//  - F-10/F-11: clicks resolve through lib/identifierClick (caret → summed
//    text-node column → tokenAt); real controls are never hijacked.
//  - CSS contract: the component is a flex column with min-height:0 (the
//    xyflow zero-height family of bugs — locked in tests).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { langIdForPath, repoKeyWire, shikiLangFor, type LangId } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { EmptyState } from '@/components/EmptyState'
import { getHighlighter } from '@/components/prose/highlighter'
import { resolveIdentifierClick, type IdentifierClick } from '@/lib/identifierClick'
import { foldSegments, type ChangedRange } from '@/lib/fullFileRanges'

const BUDGET_BYTES = 512 * 1024
const BUDGET_LINES = 2000
const BUDGET_LINE_CHARS = 4000

export interface CodeViewerProps {
  taskId: string
  /** canonical repo key ('' = root/single repo). */
  repoKey: string
  /** repo-relative path. */
  filePath: string
  side: 'base' | 'worktree'
  focus?: { line: number; endLine?: number } | null
  changedRanges?: readonly ChangedRange[]
  onIdentifierClick?: (hit: IdentifierClick) => void
  /** Render the "outside the diff" badge (nav to an unchanged file). */
  readonlyBadge?: boolean
}

interface FileContentAnswer {
  exists: boolean
  content?: string
  size?: number
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Highlighted (or plain) per-line HTML for the code cell of each row. */
function useLineHtml(
  content: string | null,
  lang: LangId | null,
  /** Identity of the fetched document — lengths collide, identities don't. */
  identity: string,
): { lines: string[] | null; plain: boolean } {
  const [state, setState] = useState<{ key: string; lines: string[]; plain: boolean } | null>(null)
  const key = `${identity} ${lang ?? ''} ${content?.length ?? -1}`
  useEffect(() => {
    if (content === null) return
    const rawLines = content.split('\n')
    const overBudget =
      content.length > BUDGET_BYTES ||
      rawLines.length > BUDGET_LINES ||
      rawLines.some((l) => l.length > BUDGET_LINE_CHARS)
    const shikiLang = shikiLangFor(lang)
    if (overBudget || shikiLang === null) {
      setState({ key, lines: rawLines.map((l) => escapeHtml(l)), plain: true })
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const hl = await getHighlighter()
        if (cancelled) return
        const html = hl.codeToHtml(content, {
          lang: shikiLang,
          themes: { light: 'github-light', dark: 'github-dark' },
          defaultColor: false,
        })
        if (cancelled) return // F-14: stale result — drop, never write back
        const doc = new DOMParser().parseFromString(html, 'text/html')
        const lineEls = doc.querySelectorAll('pre code > span.line')
        const lines = [...lineEls].map((el) => el.innerHTML)
        // shiki drops a trailing empty line the raw split keeps — pad to match
        while (lines.length < rawLines.length) lines.push('')
        setState({ key, lines, plain: false })
      } catch {
        if (!cancelled) setState({ key, lines: rawLines.map((l) => escapeHtml(l)), plain: true })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [content, lang, key])
  if (state === null || state.key !== key) return { lines: null, plain: false }
  return { lines: state.lines, plain: state.plain }
}

export function CodeViewer({
  taskId,
  repoKey,
  filePath,
  side,
  focus,
  changedRanges = [],
  onIdentifierClick,
  readonlyBadge = false,
}: CodeViewerProps) {
  const { t } = useTranslation()
  const wire = repoKeyWire(repoKey)
  const query = useQuery<FileContentAnswer>({
    queryKey: ['rfc258FileContent', taskId, wire, filePath, side],
    queryFn: ({ signal }) =>
      api.get(
        `/api/tasks/${encodeURIComponent(taskId)}/file-content?side=${side}&path=${encodeURIComponent(filePath)}&repo=${encodeURIComponent(wire)}`,
        undefined,
        signal,
      ),
    retry: false,
  })

  const content = query.data?.exists === true ? (query.data.content ?? '') : null
  const lang = useMemo(() => langIdForPath(filePath), [filePath])
  const { lines, plain } = useLineHtml(content, lang, `${taskId} ${wire} ${filePath} ${side}`)

  const changeTypeOf = useCallback(
    (line: number): 'added' | 'modified' | null => {
      for (const r of changedRanges) {
        if (line >= r.start && line <= r.end) return r.type
      }
      return null
    },
    [changedRanges],
  )

  const segments = useMemo(
    () => foldSegments(lines?.length ?? 0, changedRanges, focus?.line),
    [lines, changedRanges, focus],
  )
  const [openedFolds, setOpenedFolds] = useState<ReadonlySet<number>>(() => new Set())
  useEffect(() => setOpenedFolds(new Set()), [taskId, filePath, side])

  const rootRef = useRef<HTMLDivElement | null>(null)
  // focus scroll + flash — scoped to THIS instance (the panel and the drill
  // source pane can show the same file simultaneously). Keyed on the focus
  // VALUE with a once-per-value guard (impl-gate P0-1): hosts pass inline
  // object literals, and re-running on identity churn (menu open/close, query
  // flips) yanked the viewport back to the focus line mid-read.
  const focusLine = focus?.line ?? null
  const lastScrolled = useRef<string | null>(null)
  useEffect(() => {
    if (focusLine === null || lines === null) return
    const key = `${taskId}\u0000${filePath}\u0000${focusLine}`
    if (lastScrolled.current === key) return
    const el = rootRef.current?.querySelector(`[data-ln="${focusLine}"]`) ?? null
    if (el !== null) {
      lastScrolled.current = key
      el.scrollIntoView({ block: 'center' })
      el.classList.add('cv__line--flash')
      const timer = setTimeout(() => el.classList.remove('cv__line--flash'), 1600)
      return () => clearTimeout(timer)
    }
  }, [focusLine, lines, taskId, filePath])

  const handleClick = useCallback(
    (ev: React.MouseEvent) => {
      if (onIdentifierClick === undefined) return
      const hit = resolveIdentifierClick(ev)
      if (hit !== null) onIdentifierClick(hit)
    },
    [onIdentifierClick],
  )

  if (query.isLoading) return <LoadingState />
  if (query.isError) {
    const err = query.error
    if (err instanceof ApiError && err.status === 413) {
      return <EmptyState title={t('tasks.codeViewerOversized')} />
    }
    if (err instanceof ApiError && err.status === 415) {
      return <EmptyState title={t('tasks.codeViewerBinary')} />
    }
    if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
      return <EmptyState title={t('tasks.codeViewerGone')} />
    }
    return <ErrorBanner error={err} />
  }
  if (query.data?.exists === false) return <EmptyState title={t('tasks.codeViewerMissing')} />
  if (lines === null) return <LoadingState />

  return (
    <div className="code-viewer" ref={rootRef} data-plain={plain || undefined}>
      {readonlyBadge && (
        <div className="code-viewer__badges">
          <span className="structure__tag">{t('tasks.codeViewerOutsideDiff')}</span>
        </div>
      )}
      {/* one delegated listener — rows carry data-ln, code cells data-code */}
      <div className="code-viewer__scroll" onClick={handleClick}>
        {segments.map((seg) => {
          if (seg.folded && !openedFolds.has(seg.start)) {
            return (
              <button
                key={`fold-${seg.start}`}
                type="button"
                className="cv__fold"
                onClick={() => setOpenedFolds((prev) => new Set(prev).add(seg.start))}
              >
                ⋯ {t('tasks.codeViewerFoldedLines', { n: seg.end - seg.start + 1 })}
              </button>
            )
          }
          const rows = []
          for (let ln = seg.start; ln <= seg.end; ln++) {
            const ct = changeTypeOf(ln)
            rows.push(
              <div
                key={ln}
                data-ln={ln}
                className={`cv__line${ct !== null ? ` cv__line--${ct}` : ''}`}
              >
                <span className="cv__ln" aria-hidden="true">
                  {ln}
                </span>
                <span
                  className="cv__code"
                  data-code=""
                  dangerouslySetInnerHTML={{ __html: lines[ln - 1] ?? '' }}
                />
              </div>,
            )
          }
          return rows
        })}
      </div>
    </div>
  )
}
