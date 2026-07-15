// RFC-082 — shared "one markdown document + anchored comment sidebar" pane.
//
// Extracted verbatim (data sources swapped for props) from the single-document
// review page `routes/reviews.detail.tsx`, so BOTH the single-doc page and the
// multi-document review page (components/review/MultiDocReviewView.tsx) render
// the exact same capability: Premium Markdown body, anchored comment bubbles
// with collision-avoidance layout, collapse / resize sidebar, scroll-spy active
// highlight, J/K jump, inline edit / copy / delete, and the selection → comment
// popover with draft persistence.
//
// OUT of scope (stays in each host page): data fetching, diff mode + historical
// version (single-doc), the whole-doc / round-level decision controls, the
// multi-doc left navigator + per-doc accept/reject. Diff mode is supported via
// the optional `bodySlot` (host renders DiffView); when present, the pane skips
// interactivity + bubble measurement exactly like the old `if (diffMode) return`
// guards did.

import { useMutation } from '@tanstack/react-query'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { ReviewComment, ReviewCommentAnchor } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { AttributionChip } from '@/components/AttributionChip'
import { TextArea } from '@/components/Form'
import { useUserLookup } from '@/hooks/useUserLookup'
import { Prose } from '@/components/prose/Prose'
import { useResizable } from '@/hooks/useResizable'
import { anchorKey, computeAnchorFromSelection, selectionCrossesHeading } from '@/lib/review/anchor'
import { BUBBLE_GAP_PX, computeBubbleLayout } from '@/lib/review/bubbleLayout'
import { deleteDraft, getDraft, setDraft } from '@/lib/review/draftStore'
import { computeLineRange } from '@/lib/review/lineRange'
import type { ReviewPaneMode } from '@/lib/review/readonly'

// RFC-009-T2: sidebar width persistence + bounds. Shared with the single-doc
// page's original keys so the user's last width / collapsed preference survives
// across both review surfaces (RFC-082 OQ-1).
const SIDEBAR_WIDTH_KEY = 'agw-review-sidebar-width'
const SIDEBAR_COLLAPSED_KEY = 'agw-review-sidebar-collapsed'
const SIDEBAR_WIDTH_DEFAULT = 280
const SIDEBAR_WIDTH_MIN = 240
const SIDEBAR_WIDTH_MAX = 520
const SIDEBAR_COLLAPSED_PX = 32

function readCollapsedInit(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

export interface ReviewDocPaneProps {
  nodeRunId: string
  /** For draft-store keys (per task/node/doc/anchor). */
  taskId: string
  /** doc_version the comments attach to; single-doc=currentVersion.id, multi-doc=active doc. */
  docVersionId: string
  /** Already-resolved markdown body. Host owns fetching/loading. */
  body: string
  comments: ReviewComment[]
  /**
   * RFC-149: single three-state writability mode (replaces the `readonly` +
   * `awaiting` boolean pair, whose (readonly=true, awaiting=true) combination
   * was unrepresentable nonsense):
   *   - 'awaiting'   — fully writable: popover + edit + delete.
   *   - 'decided'    — current-but-decided: write affordances render, but
   *                    edit / delete are disabled (comments froze at the
   *                    decision boundary).
   *   - 'historical' — read-only history view: every write affordance hidden.
   */
  mode: ReviewPaneMode
  /** Called after any comment create/edit/delete so the host refetches. */
  onInvalidate: () => Promise<void>
  /**
   * Single-doc diff mode flag. When true, the pane suppresses comment anchors,
   * bubble measurement and scroll-spy — even before `bodySlot` resolves (the
   * diff-loading flash where the host still shows current Prose as a
   * placeholder). Mirrors the old `anchors={diffMode ? undefined}` + measure
   * `if (diffMode) return` guards. Multi-doc omits it (always interactive).
   */
  diffMode?: boolean
  /**
   * When provided (single-doc diff loaded), render this instead of `<Prose>`
   * (the host's <DiffView> or a loading placeholder).
   */
  bodySlot?: ReactNode
  /**
   * Report whether the pane is currently capturing keystrokes (popover open or
   * inline-editing) so the host can suppress its own single-key shortcuts
   * (single-doc A/R/I + Ctrl+1/2/3) — faithfully reproduces the original single
   * combined keydown handler's `if (popover) / if (editingId) return` guards.
   */
  onShortcutCaptureChange?: (capturing: boolean) => void
}

// ---------------------------------------------------------------------------
// useCommentBubbles — DOM measurement wrapper around computeBubbleLayout.
// ---------------------------------------------------------------------------

function useCommentBubbles(params: {
  markdownRef: RefObject<HTMLDivElement | null>
  bubblesRef: RefObject<HTMLDivElement | null>
  sortedComments: ReviewComment[]
  enabled: boolean
  sidebarWidth: number
  editingId: string | null
}): { bubbleTops: Map<string, number>; bubblesMinHeight: number } {
  const { markdownRef, bubblesRef, sortedComments, enabled, sidebarWidth, editingId } = params
  const [bubbleTops, setBubbleTops] = useState<Map<string, number>>(new Map())
  const [bubblesMinHeight, setBubblesMinHeight] = useState<number>(0)

  useLayoutEffect(() => {
    if (markdownRef.current === null || bubblesRef.current === null) return
    if (!enabled) return

    const measure = (): void => {
      const root = markdownRef.current
      const col = bubblesRef.current
      if (root === null || col === null) return
      const colTop = col.getBoundingClientRect().top
      const headerEl = col.querySelector<HTMLElement>('.review-detail__sidebar-header')
      const headerFloor = headerEl !== null ? headerEl.offsetHeight + BUBBLE_GAP_PX : 0
      const located: { id: string; top: number; height: number }[] = []
      const orphans: { id: string; height: number }[] = []
      for (const c of sortedComments) {
        const bubble = col.querySelector<HTMLElement>(`.comment-bubble[data-comment-id="${c.id}"]`)
        const h = bubble?.getBoundingClientRect().height ?? 0
        const el = root.querySelector<HTMLElement>(`mark.comment-anchor[data-comment-id="${c.id}"]`)
        if (el === null) {
          orphans.push({ id: c.id, height: h })
          continue
        }
        const rect = el.getBoundingClientRect()
        located.push({ id: c.id, top: rect.top - colTop, height: h })
      }
      const { tops, minHeight } = computeBubbleLayout({
        located,
        orphans,
        headerFloor,
        rootHeight: root.getBoundingClientRect().height,
      })
      setBubbleTops(tops)
      setBubblesMinHeight(minHeight)
    }

    measure()

    const ro = new ResizeObserver(() => measure())
    ro.observe(markdownRef.current)
    ro.observe(bubblesRef.current)
    bubblesRef.current
      .querySelectorAll<HTMLElement>('.comment-bubble')
      .forEach((b) => ro.observe(b))
    const onResize = (): void => measure()
    window.addEventListener('resize', onResize)
    const onScroll = (): void => measure()
    window.addEventListener('scroll', onScroll, true)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
    }
    // editingId in deps so opening/closing inline edit re-measures immediately.
  }, [markdownRef, bubblesRef, sortedComments, enabled, sidebarWidth, editingId])

  return { bubbleTops, bubblesMinHeight }
}

export function ReviewDocPane(props: ReviewDocPaneProps) {
  const {
    nodeRunId,
    taskId,
    docVersionId,
    body,
    comments,
    mode,
    onInvalidate,
    diffMode,
    bodySlot,
    onShortcutCaptureChange,
  } = props
  const { t } = useTranslation()
  // RFC-099 — resolve comment author ids to display names (one batched call).
  const authors = useUserLookup(comments.map((c) => c.author))
  const diffActive = diffMode === true

  const markdownRef = useRef<HTMLDivElement>(null)
  const bubblesRef = useRef<HTMLDivElement>(null)
  const suppressScrollSpyUntilRef = useRef<number>(0)

  const [popover, setPopover] = useState<{
    anchor: ReviewCommentAnchor
    draft: string
    rect: { left: number; top: number }
  } | null>(null)
  const [crossHeadingHint, setCrossHeadingHint] = useState<{
    left: number
    top: number
    key: number
  } | null>(null)
  useEffect(() => {
    if (crossHeadingHint === null) return
    const id = window.setTimeout(() => setCrossHeadingHint(null), 2500)
    return () => window.clearTimeout(id)
  }, [crossHeadingHint])

  const [activeCommentId, setActiveCommentId] = useState<string | null>(null)
  // RFC-082 fix: jumpComment computes the next index from the CURRENT active
  // comment. Reading `activeCommentId` (React state) from the callback closure
  // breaks rapid ▲/▼ clicks — React batches the state updates, so several
  // synchronous clicks all see the same stale value and only advance one step
  // (the user "can't reach the first/last comment"). A ref updated synchronously
  // alongside the state lets each click see the latest selection.
  const activeCommentIdRef = useRef<string | null>(null)
  const selectComment = useCallback((id: string | null) => {
    activeCommentIdRef.current = id
    setActiveCommentId(id)
  }, [])

  const {
    width: sidebarWidth,
    onResizerPointerDown,
    dragging: resizing,
  } = useResizable({
    storageKey: SIDEBAR_WIDTH_KEY,
    initial: SIDEBAR_WIDTH_DEFAULT,
    min: SIDEBAR_WIDTH_MIN,
    max: SIDEBAR_WIDTH_MAX,
  })
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsedInit)
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [collapsed])

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<string>('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [copyFailedId, setCopyFailedId] = useState<string | null>(null)

  // Report capture state up so the host suppresses its single-key shortcuts.
  useEffect(() => {
    onShortcutCaptureChange?.(popover !== null || editingId !== null)
  }, [popover, editingId, onShortcutCaptureChange])

  const sortedComments = useMemo<ReviewComment[]>(() => {
    return [...comments].sort((a, b) => {
      if (a.anchor.offsetStart !== b.anchor.offsetStart) {
        return a.anchor.offsetStart - b.anchor.offsetStart
      }
      return a.anchor.occurrenceIndex - b.anchor.occurrenceIndex
    })
  }, [comments])

  const lineRanges = useMemo<Map<string, { start: number; end: number }>>(() => {
    const m = new Map<string, { start: number; end: number }>()
    for (const c of comments) {
      m.set(c.id, computeLineRange(body, c.anchor.offsetStart, c.anchor.offsetEnd))
    }
    return m
  }, [body, comments])

  const proseAnchors = useMemo(
    () =>
      sortedComments.map((c) => ({
        commentId: c.id,
        selectedText: c.anchor.selectedText,
        occurrenceIndex: c.anchor.occurrenceIndex,
      })),
    [sortedComments],
  )

  const { bubbleTops, bubblesMinHeight } = useCommentBubbles({
    markdownRef,
    bubblesRef,
    sortedComments,
    enabled: !diffActive && !collapsed,
    sidebarWidth,
    editingId,
  })

  const onMouseUpInDoc = useCallback(async () => {
    // RFC-149 impl-gate: NEW comment creation is an awaiting-only affordance —
    // a decided round would only get a server-side review-not-awaiting
    // rejection (edit/delete of EXISTING comments keeps its render-visible /
    // disabled treatment below).
    if (mode !== 'awaiting') return
    if (markdownRef.current === null) return
    const sel = window.getSelection()
    if (sel === null || sel.isCollapsed) return
    const anchor = computeAnchorFromSelection(markdownRef.current, sel, body)
    if (anchor === null) {
      if (selectionCrossesHeading(markdownRef.current, sel)) {
        const r = sel.getRangeAt(0).getBoundingClientRect()
        setCrossHeadingHint({
          left: r.left + window.scrollX,
          top: r.bottom + window.scrollY,
          key: Date.now(),
        })
      }
      return
    }
    const range = sel.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    const draft =
      (await getDraft({ taskId, nodeRunId, docVersionId, anchorHash: anchorKey(anchor) })) ?? ''
    setPopover({
      anchor,
      draft,
      rect: { left: rect.left + window.scrollX, top: rect.bottom + window.scrollY },
    })
  }, [mode, body, taskId, nodeRunId, docVersionId])

  // Persist popover draft on every keystroke.
  useEffect(() => {
    if (popover === null) return
    void setDraft(
      { taskId, nodeRunId, docVersionId, anchorHash: anchorKey(popover.anchor) },
      popover.draft,
    )
  }, [popover, taskId, nodeRunId, docVersionId])

  const submitComment = useMutation({
    mutationFn: async (input: { anchor: ReviewCommentAnchor; commentText: string }) => {
      await api.post(`/api/reviews/${nodeRunId}/comments`, { ...input, docVersionId })
    },
    onSuccess: onInvalidate,
  })
  const deleteComment = useMutation({
    mutationFn: async (commentId: string) => {
      await api.delete(`/api/reviews/${nodeRunId}/comments/${commentId}`)
    },
    onSuccess: onInvalidate,
  })
  const updateComment = useMutation({
    mutationFn: async (input: { commentId: string; commentText: string }) => {
      await api.patch(`/api/reviews/${nodeRunId}/comments/${input.commentId}`, {
        commentText: input.commentText,
      })
    },
    onSuccess: async () => {
      await onInvalidate()
      setEditingId(null)
      setEditDraft('')
    },
  })

  const onCopy = useCallback((commentId: string, text: string) => {
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
      setCopyFailedId(commentId)
      setTimeout(() => setCopyFailedId(null), 1500)
      return
    }
    navigator.clipboard.writeText(text).then(
      () => {
        setCopiedId(commentId)
        setTimeout(() => setCopiedId(null), 1500)
      },
      () => {
        setCopyFailedId(commentId)
        setTimeout(() => setCopyFailedId(null), 1500)
      },
    )
  }, [])

  const onStartEdit = useCallback((c: ReviewComment) => {
    setEditingId(c.id)
    setEditDraft(c.commentText)
  }, [])
  const onCancelEdit = useCallback(() => {
    setEditingId(null)
    setEditDraft('')
  }, [])
  const onSaveEdit = useCallback(
    async (commentId: string) => {
      const text = editDraft.trim()
      if (text.length === 0) return
      await updateComment.mutateAsync({ commentId, commentText: text })
    },
    [editDraft, updateComment],
  )

  // Toggle data-active on the matching mark whenever the active comment changes.
  useEffect(() => {
    if (markdownRef.current === null) return
    const root = markdownRef.current
    root.querySelectorAll<HTMLElement>('mark.comment-anchor[data-active]').forEach((m) => {
      m.removeAttribute('data-active')
    })
    if (activeCommentId === null) return
    const el = root.querySelector<HTMLElement>(
      `mark.comment-anchor[data-comment-id="${activeCommentId}"]`,
    )
    if (el !== null) el.setAttribute('data-active', 'true')
  }, [activeCommentId, sortedComments, diffActive])

  const scrollToCommentAnchor = useCallback((commentId: string) => {
    const el = markdownRef.current?.querySelector<HTMLElement>(
      `mark.comment-anchor[data-comment-id="${commentId}"]`,
    )
    if (el === null || el === undefined) return
    suppressScrollSpyUntilRef.current = Date.now() + 800
    // RFC-082 fix: a REAL mouse click on the ▲/▼ jump button (mousedown/focus +
    // React re-render around the handler) cancels an in-flight `behavior:
    // 'smooth'` scroll partway — the document stops between comments and the
    // jump "does nothing". (Programmatic .click() has no focus/mousedown, which
    // is why automated tests never caught it.) An instant scroll has no
    // animation to cancel, so the jump reliably lands on the comment.
    el.scrollIntoView({ behavior: 'auto', block: 'center' })
  }, [])

  const onBubbleClick = useCallback(
    (commentId: string) => {
      selectComment(commentId)
      scrollToCommentAnchor(commentId)
    },
    [selectComment, scrollToCommentAnchor],
  )

  const jumpComment = useCallback(
    (direction: 'next' | 'prev') => {
      const list = sortedComments
      if (list.length === 0) return
      // Read the latest selection from the ref (not the closed-over state) so
      // rapid clicks advance step-by-step instead of all jumping one step.
      const current = activeCommentIdRef.current
      const currentIdx = current === null ? -1 : list.findIndex((c) => c.id === current)
      const nextIdx =
        direction === 'next'
          ? Math.min(currentIdx + 1, list.length - 1)
          : Math.max(currentIdx - 1, 0)
      const target = list[nextIdx]
      if (target === undefined) return
      selectComment(target.id)
      scrollToCommentAnchor(target.id)
    },
    [sortedComments, selectComment, scrollToCommentAnchor],
  )

  const currentCommentIdx =
    activeCommentId === null ? -1 : sortedComments.findIndex((c) => c.id === activeCommentId)
  const canJumpPrev = sortedComments.length > 0 && currentCommentIdx !== 0
  const canJumpNext = sortedComments.length > 0 && currentCommentIdx !== sortedComments.length - 1

  // Scroll-spy: track the topmost visible anchor.
  useEffect(() => {
    if (markdownRef.current === null || diffActive) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (Date.now() < suppressScrollSpyUntilRef.current) return
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (top !== undefined) {
          const id = (top.target as HTMLElement).dataset.commentId ?? null
          if (id !== null) selectComment(id)
        }
      },
      { rootMargin: '-20% 0px -60% 0px' },
    )
    const anchors = markdownRef.current.querySelectorAll('[data-comment-id]')
    anchors.forEach((a) => observer.observe(a))
    return () => observer.disconnect()
  }, [body, diffActive, selectComment])

  // Pane-local keyboard: J/K jump + Esc closes popover. Host owns A/R/I etc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode === 'historical') return
      if (popover !== null) {
        if (e.key === 'Escape') setPopover(null)
        return
      }
      if (editingId !== null) return
      if (
        document.activeElement !== null &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)
      ) {
        return
      }
      const k = e.key.toLowerCase()
      if (k === 'j') jumpComment('next')
      else if (k === 'k') jumpComment('prev')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [popover, editingId, mode, jumpComment])

  const submitPopover = useCallback(async () => {
    if (popover === null) return
    const text = popover.draft.trim()
    if (text.length === 0) return
    await submitComment.mutateAsync({ anchor: popover.anchor, commentText: text })
    await deleteDraft({ taskId, nodeRunId, docVersionId, anchorHash: anchorKey(popover.anchor) })
    setPopover(null)
  }, [popover, submitComment, taskId, nodeRunId, docVersionId])

  return (
    <>
      <div
        className="review-detail__layout"
        style={
          {
            '--review-sidebar-width': `${collapsed ? SIDEBAR_COLLAPSED_PX : sidebarWidth}px`,
          } as CSSProperties
        }
      >
        {bodySlot !== undefined ? (
          <div className="review-detail__body">{bodySlot}</div>
        ) : (
          <div
            className="review-detail__body"
            ref={markdownRef}
            onMouseUp={mode === 'awaiting' ? () => void onMouseUpInDoc() : undefined}
          >
            <Prose
              body={body}
              taskId={taskId}
              // Diff-loading flash: suppress marks until DiffView swaps in.
              anchors={diffActive ? undefined : proseAnchors}
            />
          </div>
        )}
        {collapsed ? (
          <div className="comments-collapsed-rail" aria-label={t('reviews.sidebarTitle')}>
            <button
              type="button"
              className="comments-collapsed-rail__toggle"
              aria-label={t('reviews.sidebarExpand')}
              title={t('reviews.sidebarExpand')}
              onClick={() => setCollapsed(false)}
            >
              ‹
            </button>
            <span className="comments-collapsed-rail__count" aria-hidden="true">
              {sortedComments.length}
            </span>
          </div>
        ) : (
          <div
            className="review-detail__bubbles"
            ref={bubblesRef}
            style={bubblesMinHeight > 0 ? { minHeight: `${bubblesMinHeight}px` } : undefined}
            aria-label={t('reviews.sidebarTitle')}
          >
            <div
              className="review-detail__sidebar-resizer"
              data-dragging={resizing ? 'true' : 'false'}
              onPointerDown={onResizerPointerDown}
              role="separator"
              aria-orientation="vertical"
            />
            <header className="review-detail__sidebar-header">
              <span className="review-detail__sidebar-count">
                {t('reviews.sidebarCountLabel', { count: sortedComments.length })}
              </span>
              <div className="review-detail__sidebar-jump" role="group">
                <button
                  type="button"
                  className="review-detail__sidebar-jump-btn"
                  aria-label={t('reviews.sidebarJumpPrev')}
                  title={t('reviews.sidebarJumpPrev')}
                  disabled={!canJumpPrev}
                  onClick={() => jumpComment('prev')}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="review-detail__sidebar-jump-btn"
                  aria-label={t('reviews.sidebarJumpNext')}
                  title={t('reviews.sidebarJumpNext')}
                  disabled={!canJumpNext}
                  onClick={() => jumpComment('next')}
                >
                  ▼
                </button>
              </div>
              <button
                type="button"
                className="review-detail__sidebar-toggle"
                aria-label={t('reviews.sidebarCollapse')}
                title={t('reviews.sidebarCollapse')}
                onClick={() => setCollapsed(true)}
              >
                ›
              </button>
            </header>
            {sortedComments.length === 0 ? (
              <div className="review-detail__bubbles-empty muted">
                {mode === 'historical'
                  ? t('reviews.sidebarEmptyReadonly')
                  : t('reviews.sidebarEmpty')}
              </div>
            ) : (
              sortedComments.map((c) => {
                const top = bubbleTops.get(c.id)
                const isActive = activeCommentId === c.id
                const isEditing = editingId === c.id
                const range = lineRanges.get(c.id)
                const lineLabel =
                  range === undefined
                    ? ''
                    : range.start === range.end
                      ? t('reviews.lineRef', { n: range.start })
                      : t('reviews.lineRefRange', { start: range.start, end: range.end })
                const copyLabel =
                  copiedId === c.id
                    ? t('reviews.commentCopied')
                    : copyFailedId === c.id
                      ? t('reviews.commentCopyFailed')
                      : t('reviews.commentCopy')
                return (
                  <article
                    key={c.id}
                    className={
                      'comment-bubble' +
                      (isActive ? ' comment-bubble--active' : '') +
                      (isEditing ? ' comment-bubble--editing' : '')
                    }
                    data-comment-id={c.id}
                    style={top !== undefined ? { top: `${top}px` } : undefined}
                    onClick={() => onBubbleClick(c.id)}
                  >
                    {mode !== 'historical' && !isEditing && (
                      <div className="comment-bubble__actions">
                        <button
                          type="button"
                          className="comment-bubble__action"
                          aria-label={t('reviews.commentEdit')}
                          title={t('reviews.commentEdit')}
                          onClick={(e) => {
                            e.stopPropagation()
                            onStartEdit(c)
                          }}
                          disabled={mode !== 'awaiting'}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className="comment-bubble__action"
                          aria-label={copyLabel}
                          title={copyLabel}
                          data-copied={copiedId === c.id ? 'true' : 'false'}
                          onClick={(e) => {
                            e.stopPropagation()
                            onCopy(c.id, c.commentText)
                          }}
                        >
                          ⧉
                        </button>
                        <button
                          type="button"
                          className="comment-bubble__action comment-bubble__delete"
                          aria-label={t('common.delete')}
                          title={t('common.delete')}
                          onClick={(e) => {
                            e.stopPropagation()
                            deleteComment.mutate(c.id)
                          }}
                          disabled={mode !== 'awaiting'}
                        >
                          ×
                        </button>
                      </div>
                    )}
                    <header className="comment-bubble__section" title={c.anchor.sectionPath}>
                      {c.anchor.sectionPath || t('reviews.sidebarTitle')}
                      {lineLabel !== '' && (
                        <span className="comment-bubble__line-ref">{lineLabel}</span>
                      )}
                    </header>
                    <blockquote className="comment-bubble__quote" title={c.anchor.selectedText}>
                      {c.anchor.selectedText}
                    </blockquote>
                    {isEditing ? (
                      <div
                        className="comment-bubble__edit-form"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <TextArea
                          autoFocus
                          rows={3}
                          value={editDraft}
                          onChange={setEditDraft}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                              e.preventDefault()
                              void onSaveEdit(c.id)
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault()
                              onCancelEdit()
                            }
                          }}
                        />
                        <div className="comment-bubble__edit-form-actions">
                          <button
                            type="button"
                            className="btn btn--sm"
                            onClick={(e) => {
                              e.stopPropagation()
                              onCancelEdit()
                            }}
                          >
                            {t('reviews.commentEditCancel')}
                          </button>
                          <button
                            type="button"
                            className="btn btn--sm btn--primary"
                            disabled={editDraft.trim().length === 0 || updateComment.isPending}
                            onClick={(e) => {
                              e.stopPropagation()
                              void onSaveEdit(c.id)
                            }}
                          >
                            {t('reviews.commentSave')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="comment-bubble__body">{c.commentText}</p>
                    )}
                    {/* RFC-099 (D7): who commented, with their task role. */}
                    <footer className="comment-bubble__attribution">
                      <AttributionChip
                        userId={c.author}
                        role={c.authorRole ?? null}
                        user={authors.get(c.author)}
                      />
                    </footer>
                  </article>
                )
              })
            )}
          </div>
        )}
      </div>

      {mode === 'awaiting' && crossHeadingHint !== null && (
        <div
          key={crossHeadingHint.key}
          className="review-cross-heading-hint"
          style={{ position: 'absolute', left: crossHeadingHint.left, top: crossHeadingHint.top }}
          role="status"
          aria-live="polite"
        >
          {t('reviews.crossHeadingHint')}
        </div>
      )}

      {mode === 'awaiting' && popover !== null && (
        <div
          className="comment-popover"
          style={{ position: 'absolute', left: popover.rect.left, top: popover.rect.top }}
          role="dialog"
        >
          <div className="muted">{popover.anchor.sectionPath}</div>
          <TextArea
            autoFocus
            rows={3}
            value={popover.draft}
            placeholder={t('reviews.popoverPlaceholder')}
            onChange={(draft) => setPopover({ ...popover, draft })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void submitPopover()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setPopover(null)
              }
            }}
          />
          <div className="comment-popover__actions">
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={popover.draft.trim().length === 0 || submitComment.isPending}
              onClick={() => void submitPopover()}
            >
              {t('reviews.popoverSubmit')}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                void deleteDraft({
                  taskId,
                  nodeRunId,
                  docVersionId,
                  anchorHash: anchorKey(popover.anchor),
                })
                setPopover(null)
              }}
            >
              {t('reviews.popoverCancel')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
