// /reviews/:nodeRunId — RFC-005 PR-D T27.
//
// The review detail page. Renders the current doc_version's markdown body,
// shows existing review comments in a right sidebar, lets the user select
// text + drop a comment via a popover, and surfaces the three decision
// buttons (approve / reject / iterate) along with the optimistic-lock
// review_iteration the backend will check.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate, useSearch, Link } from '@tanstack/react-router'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  Config,
  DocVersionWithBodyAndComments,
  ReviewComment,
  ReviewCommentAnchor,
  ReviewDetail,
} from '@agent-workflow/shared'
import type { DocVersion } from '@agent-workflow/shared'
import { api, type ApiError } from '@/api/client'
import { DiffView, type DiffGranularity } from '@/components/review/DiffView'
import { Prose } from '@/components/prose/Prose'
import { useResizable } from '@/hooks/useResizable'
import { useTaskSync } from '@/hooks/useTaskSync'
import { anchorKey, computeAnchorFromSelection } from '@/lib/review/anchor'
import { deleteDraft, getDraft, listDrafts, setDraft } from '@/lib/review/draftStore'
import { computeLineRange } from '@/lib/review/lineRange'
import { resolveReviewView } from '@/lib/review/readonly'
import { wrapAnchorsInDom } from '@/lib/review/wrapAnchorsInDom'
import { Route as RootRoute } from './__root'

// RFC-013: optional ?version=<vid> for the read-only historical view.
// The search object must always be defined (TanStack invariant), so we
// hand back `{}` for the no-query path.
interface ReviewDetailSearch {
  version?: string
}

const BUBBLE_GAP_PX = 8

// RFC-009-T2: sidebar width persistence + bounds. The min keeps the bubble
// quote+body readable; the max prevents the user from squeezing the doc
// area to nothing on a wide monitor.
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

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/reviews/$nodeRunId',
  validateSearch: (raw: Record<string, unknown>): ReviewDetailSearch => {
    const out: ReviewDetailSearch = {}
    if (typeof raw.version === 'string' && raw.version.length > 0) out.version = raw.version
    return out
  },
  component: ReviewDetailPage,
})

function ReviewDetailPage() {
  const { nodeRunId } = Route.useParams()
  const search = useSearch({ from: Route.id }) as ReviewDetailSearch
  const navigate = useNavigate()
  const { t } = useTranslation()
  const qc = useQueryClient()

  const detail = useQuery<ReviewDetail>({
    queryKey: ['reviews', 'detail', nodeRunId],
    queryFn: ({ signal }) => api.get(`/api/reviews/${nodeRunId}`, undefined, signal),
    refetchInterval: 8000,
  })

  // RFC-005 PR-D T30: subscribe to /ws/tasks/{taskId} once detail resolves;
  // useTaskSync invalidates review queries on review.* events as well, so
  // the page stays live across multi-tab edits.
  useTaskSync(detail.data?.summary.taskId ?? null)

  // RFC-005 PR-E T35: diff view toggle + granularity. Default to "off"
  // (single-pane view); flipping it on loads the prior decided doc_version
  // and renders side-by-side.
  const [diffMode, setDiffMode] = useState(false)
  const [diffGranularity, setDiffGranularity] = useState<DiffGranularity>('word')

  // RFC-013: versions list is consulted for two distinct purposes — the
  // diff toggle's prior-version pick AND the read-only historical view's
  // legitimacy check (resolveReviewView falls into `invalid` only after
  // this resolves and the requested vid isn't in the list). Fire it
  // whenever either consumer needs it.
  const versions = useQuery<DocVersion[]>({
    queryKey: ['reviews', 'versions', nodeRunId],
    queryFn: ({ signal }) => api.get(`/api/reviews/${nodeRunId}/versions`, undefined, signal),
    enabled: diffMode || search.version !== undefined,
  })

  // Pick the most recent doc_version that ISN'T the current pending one as
  // the diff "left" pane. That maps to "the last rejected / iterated /
  // approved version" in the RFC's vocabulary.
  const priorVersion = useMemo<DocVersion | null>(() => {
    if (versions.data === undefined || detail.data === undefined) return null
    const currentId = detail.data.currentVersion.id
    const candidate = versions.data.find((v) => v.id !== currentId)
    return candidate ?? null
  }, [versions.data, detail.data])

  const priorBody = useQuery<DocVersionWithBodyAndComments>({
    queryKey: ['reviews', 'version-body', nodeRunId, priorVersion?.id ?? ''],
    queryFn: ({ signal }) =>
      api.get(`/api/reviews/${nodeRunId}/versions/${priorVersion?.id ?? ''}`, undefined, signal),
    enabled: diffMode && priorVersion !== null,
  })

  // RFC-013: when ?version=<vid> is present and it's not the current vid,
  // fetch that historical version's body + comments. The endpoint validates
  // nodeRunId scoping server-side; a bogus vid returns 404 which we surface
  // through the navigate-replace + toast path below.
  const view = resolveReviewView(
    search.version,
    detail.data?.currentVersion.id ?? '',
    versions.data,
  )
  const historicalVid = view.mode === 'historical' ? view.vid : null
  const historicalDetail = useQuery<DocVersionWithBodyAndComments>({
    queryKey: ['reviews', 'version-body', nodeRunId, historicalVid ?? ''],
    queryFn: ({ signal }) =>
      api.get(`/api/reviews/${nodeRunId}/versions/${historicalVid ?? ''}`, undefined, signal),
    enabled: historicalVid !== null,
  })
  const readonly = view.mode === 'historical'

  // RFC-013: doc body + comments the page should *render* — in current
  // mode these come from the detail endpoint, in historical mode from the
  // version-detail endpoint. Memoized so the downstream `wrapAnchorsInDom`
  // effect doesn't churn its dependency on every render.
  const activeBody = useMemo<string | undefined>(() => {
    if (view.mode === 'historical') return historicalDetail.data?.body
    return detail.data?.currentBody
  }, [view.mode, historicalDetail.data, detail.data])

  const activeComments = useMemo<ReviewComment[]>(() => {
    if (view.mode === 'historical') return historicalDetail.data?.comments ?? []
    return detail.data?.comments ?? []
  }, [view.mode, historicalDetail.data, detail.data])

  // RFC-013: when the user types in a vid that the versions endpoint
  // doesn't recognize (after that endpoint has resolved), bounce them back
  // to the current-version path with a one-shot warning. Using window.alert
  // keeps the surface tiny — there is no in-app toast system yet, and the
  // page is interactive enough that a blocking dialog is acceptable here.
  // The `replace: true` keeps the back button from looping into the bad URL.
  const requestedInvalid = view.mode === 'invalid' ? view.requested : null
  useEffect(() => {
    if (requestedInvalid === null) return
    window.alert(t('reviews.unknownVersion', { id: requestedInvalid }))
    void navigate({
      to: '/reviews/$nodeRunId',
      params: { nodeRunId },
      search: {},
      replace: true,
    })
  }, [requestedInvalid, navigate, nodeRunId, t])

  // Config needed for plantuml endpoint passthrough.
  const config = useQuery<Config>({
    queryKey: ['config'],
    queryFn: ({ signal }) => api.get('/api/config', undefined, signal),
  })

  const markdownRef = useRef<HTMLDivElement>(null)
  const bubblesRef = useRef<HTMLDivElement>(null)
  const [popover, setPopover] = useState<{
    anchor: ReviewCommentAnchor
    draft: string
    rect: { left: number; top: number }
  } | null>(null)

  // Sidebar scroll-spy: highlight the comment whose anchor element is
  // currently the topmost in view.
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null)

  // RFC-009-T2: collapsible / resizable sidebar (width persisted to
  // localStorage; collapsed state persisted under a separate key so the
  // user's last preference survives between sessions and across tasks).
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

  // RFC-009-T3: inline edit. editingId selects which comment the user is
  // currently editing; editDraft holds the in-flight textarea value so the
  // user can Esc out without losing the saved row.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<string>('')

  // RFC-009-T4: copy-to-clipboard transient state. copiedId is the comment
  // whose copy button was last clicked; copyFailedId mirrors it for the
  // failure path (no clipboard permission, etc.). Both auto-clear after
  // ~1.5s so the button label flicks back.
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [copyFailedId, setCopyFailedId] = useState<string | null>(null)

  // Bubble vertical positions, keyed by comment id. Computed off the
  // anchor element rects in the rendered markdown; recomputed whenever
  // comments or rendered body change, on window resize, and on any
  // ResizeObserver tick from the markdown body (diagrams hydrating, images
  // loading, font swap, etc.).
  const [bubbleTops, setBubbleTops] = useState<Map<string, number>>(new Map())
  const [bubblesMinHeight, setBubblesMinHeight] = useState<number>(0)

  const commentsByOccurrence = useMemo(() => {
    const m = new Map<string, ReviewComment>()
    for (const c of activeComments) m.set(anchorKey(c.anchor), c)
    return m
  }, [activeComments])

  // Comments rendered in the order they appear in the reviewed text, not
  // in the API's creation order. The bubble layout positions each card at
  // its anchor's vertical offset, so visual order is *usually* doc order
  // anyway — but if measurement fails for any reason (orphan anchor, slow
  // diagram hydration during the first measure pass, etc.), bubbles fall
  // back to their DOM source-order stacking and we want THAT to be doc
  // order too. Sort key: source-markdown char offset, then occurrenceIndex
  // as a stable tiebreaker for two comments anchored to the same span.
  const sortedComments = useMemo<ReviewComment[]>(() => {
    return [...activeComments].sort((a, b) => {
      if (a.anchor.offsetStart !== b.anchor.offsetStart) {
        return a.anchor.offsetStart - b.anchor.offsetStart
      }
      return a.anchor.occurrenceIndex - b.anchor.occurrenceIndex
    })
  }, [activeComments])

  // Mouse-up handler on the markdown area: capture selection → build anchor → open popover.
  // RFC-013: in read-only historical mode the popover never opens — bail
  // out early so we don't waste the selection compute or open the IDB.
  const onMouseUpInDoc = useCallback(async () => {
    if (readonly) return
    if (markdownRef.current === null) return
    const sel = window.getSelection()
    if (sel === null || sel.isCollapsed) return
    if (detail.data === undefined) return
    const anchor = computeAnchorFromSelection(markdownRef.current, sel, detail.data.currentBody)
    if (anchor === null) return
    const range = sel.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    const draft =
      (await getDraft({
        taskId: detail.data.summary.taskId,
        nodeRunId,
        docVersionId: detail.data.currentVersion.id,
        anchorHash: anchorKey(anchor),
      })) ?? ''
    setPopover({
      anchor,
      draft,
      rect: { left: rect.left + window.scrollX, top: rect.bottom + window.scrollY },
    })
  }, [detail.data, nodeRunId, readonly])

  // Persist draft on every keystroke + cleanup on submit/cancel.
  useEffect(() => {
    if (popover === null || detail.data === undefined) return
    const k = {
      taskId: detail.data.summary.taskId,
      nodeRunId,
      docVersionId: detail.data.currentVersion.id,
      anchorHash: anchorKey(popover.anchor),
    }
    void setDraft(k, popover.draft)
  }, [popover, detail.data, nodeRunId])

  const submitComment = useMutation({
    mutationFn: async (input: { anchor: ReviewCommentAnchor; commentText: string }) => {
      await api.post(`/api/reviews/${nodeRunId}/comments`, input)
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['reviews', 'detail', nodeRunId] })
    },
  })

  const deleteComment = useMutation({
    mutationFn: async (commentId: string) => {
      await api.delete(`/api/reviews/${nodeRunId}/comments/${commentId}`)
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['reviews', 'detail', nodeRunId] })
    },
  })

  // RFC-009-T3: PATCH the comment body. Backend rejects 409 when the
  // review is no longer awaiting; the UI keeps the editor open so the user
  // can either retry or copy out their text.
  const updateComment = useMutation({
    mutationFn: async (input: { commentId: string; commentText: string }) => {
      await api.patch(`/api/reviews/${nodeRunId}/comments/${input.commentId}`, {
        commentText: input.commentText,
      })
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['reviews', 'detail', nodeRunId] })
      setEditingId(null)
      setEditDraft('')
    },
  })

  // RFC-009-T5: derive line ranges (1-based) for each comment so the
  // bubble can render a "Line N" chip without changing the anchor schema.
  // Memoized over [body, comments] so the O(N·docLen) scan only re-runs
  // when comments are added/removed or the doc body changes.
  const lineRanges = useMemo<Map<string, { start: number; end: number }>>(() => {
    const m = new Map<string, { start: number; end: number }>()
    if (activeBody === undefined) return m
    for (const c of activeComments) {
      m.set(c.id, computeLineRange(activeBody, c.anchor.offsetStart, c.anchor.offsetEnd))
    }
    return m
  }, [activeBody, activeComments])

  // RFC-009-T4: clipboard helper. We don't need to expose this as a
  // mutation because there's no server round-trip — just an optimistic
  // transient state.
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

  const submitDecision = useMutation({
    mutationFn: async (input: {
      decision: 'approved' | 'rejected' | 'iterated'
      rejectReason?: string
      reviewIteration: number
    }) => {
      await api.post(`/api/reviews/${nodeRunId}/decision`, input)
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['reviews', 'detail', nodeRunId] })
      await qc.invalidateQueries({ queryKey: ['reviews', 'list'] })
      await qc.invalidateQueries({ queryKey: ['reviews', 'pending-count'] })
    },
  })

  const onApprove = useCallback(async () => {
    if (detail.data === undefined) return
    const draftCount = (
      await listDrafts({
        taskId: detail.data.summary.taskId,
        nodeRunId,
        docVersionId: detail.data.currentVersion.id,
      })
    ).filter((d) => d.text.trim().length > 0).length
    if (draftCount > 0) {
      const ok = window.confirm(
        t('reviews.approveDraftWarning', { count: draftCount }) +
          '\n\n' +
          t('reviews.approveDraftConfirm'),
      )
      if (!ok) return
    }
    await submitDecision.mutateAsync({
      decision: 'approved',
      reviewIteration: detail.data.summary.reviewIteration,
    })
  }, [detail.data, nodeRunId, submitDecision, t])

  const onReject = useCallback(async () => {
    if (detail.data === undefined) return
    const willRerun = detail.data.rerunnableOnReject.join(', ') || '(none)'
    const reason = window.prompt(t('reviews.rejectPrompt', { willRerun }), '')
    if (reason === null) return
    const trimmed = reason.trim()
    if (trimmed.length === 0) {
      window.alert(t('reviews.rejectReasonRequired'))
      return
    }
    await submitDecision.mutateAsync({
      decision: 'rejected',
      rejectReason: trimmed,
      reviewIteration: detail.data.summary.reviewIteration,
    })
  }, [detail.data, submitDecision, t])

  const onIterate = useCallback(async () => {
    if (detail.data === undefined) return
    if (detail.data.comments.length === 0) {
      const ok = window.confirm(t('reviews.iterateNoCommentsWarning'))
      if (!ok) return
    }
    const willRerun = detail.data.rerunnableOnIterate.join(', ') || '(direct upstream)'
    const ok = window.confirm(t('reviews.iterateConfirm', { willRerun }))
    if (!ok) return
    await submitDecision.mutateAsync({
      decision: 'iterated',
      reviewIteration: detail.data.summary.reviewIteration,
    })
  }, [detail.data, submitDecision, t])

  // Wrap each comment's selectedText in <mark data-comment-id> inside the
  // rendered markdown DOM. Diff mode renders a different component so we
  // only wrap when in regular review mode. Re-runs on every change to
  // comments / body / diff toggle.
  useLayoutEffect(() => {
    if (markdownRef.current === null) return
    if (diffMode) return
    wrapAnchorsInDom(
      markdownRef.current,
      sortedComments.map((c) => ({
        commentId: c.id,
        selectedText: c.anchor.selectedText,
        occurrenceIndex: c.anchor.occurrenceIndex,
      })),
    )
  }, [sortedComments, diffMode])

  // Measure each bubble's vertical position from its anchor's rect. Walks
  // comments in DOM order and bumps any bubble down if it would overlap
  // the previous one (gap = BUBBLE_GAP_PX). Recomputes on resize, on body
  // mutations (ResizeObserver), and on every comments/body change.
  useLayoutEffect(() => {
    if (markdownRef.current === null || bubblesRef.current === null) return
    if (diffMode) return
    // RFC-009-T2: bubble column is hidden (display: none via collapsed
    // branch) when the sidebar is collapsed; measuring against a 0-height
    // container would just pin every bubble at top=0 and then thrash on
    // expand. Bail out cleanly.
    if (collapsed) return

    const measure = (): void => {
      const root = markdownRef.current
      const col = bubblesRef.current
      if (root === null || col === null) return
      const colTop = col.getBoundingClientRect().top
      // RFC-009 hot-fix: the sticky sidebar header is the first child of the
      // bubble column. Bubbles are position: absolute (so they ignore the
      // header in normal flow) and the first bubble's measured top can be
      // 0 / very small when its anchor sits near the top of the doc —
      // which would slide it under the header. Compute the header's offset
      // height once per pass and use that as the floor for the bubble
      // cursor below. offsetHeight is layout-final and includes
      // margin-bottom: 0 / padding / borders so it's the right number.
      const headerEl = col.querySelector<HTMLElement>('.review-detail__sidebar-header')
      const headerFloor = headerEl !== null ? headerEl.offsetHeight + BUBBLE_GAP_PX : 0
      // Split comments into "located" (anchor found in DOM) and
      // "orphaned" (anchor text missing — e.g. body changed since the
      // comment was created, or the wrap helper failed to find the
      // n-th occurrence). Located bubbles are positioned at their
      // anchor; orphans get stacked at the bottom of the column so they
      // remain visible. Without this, an orphan bubble would have no
      // inline top and collapse to the static-position 0, overlapping
      // every located bubble and producing the "only one comment
      // renders" symptom users hit when several anchors stack up.
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
      // sortedComments is already in anchor.offsetStart order, but the
      // *visual* position of those anchors can differ slightly if the
      // markdown renderer reorders content (rare, but possible with
      // custom block plugins). Re-sort defensively by measured top.
      located.sort((a, b) => a.top - b.top)
      const next = new Map<string, number>()
      // RFC-009 hot-fix: start the cursor below the sticky header so the
      // first bubble can never sit under it. Subsequent bubbles either
      // sit at their anchor's measured top or get bumped down by the
      // cumulative max (existing collision-avoidance logic).
      let cursor = headerFloor
      for (const item of located) {
        const top = Math.max(item.top, cursor)
        next.set(item.id, top)
        cursor = top + item.height + BUBBLE_GAP_PX
      }
      for (const item of orphans) {
        next.set(item.id, cursor)
        cursor = cursor + item.height + BUBBLE_GAP_PX
      }
      setBubbleTops(next)
      setBubblesMinHeight(Math.max(cursor, root.getBoundingClientRect().height))
    }

    measure()

    const ro = new ResizeObserver(() => measure())
    ro.observe(markdownRef.current)
    // Also observe the bubbles column itself — bubble heights change as
    // text wraps with column width.
    ro.observe(bubblesRef.current)
    // RFC-009 hot-fix: when the user opens / closes inline edit on a
    // middle bubble, that bubble grows (textarea + Save/Cancel actions)
    // or shrinks back — but the column's own size doesn't change since
    // we pin a minHeight on it. Observe each bubble individually so any
    // height change (inline edit toggle, manual textarea resize, body
    // text wrap on width change) triggers a remeasure and pushes the
    // bubbles below back down.
    bubblesRef.current
      .querySelectorAll<HTMLElement>('.comment-bubble')
      .forEach((b) => ro.observe(b))
    const onResize = (): void => measure()
    window.addEventListener('resize', onResize)
    // Scroll listener (capture phase, since scroll events don't bubble).
    // The anchor/bubble math (anchor.top - col.top) is invariant under
    // scroll *only* when both elements live in the same scroll container.
    // Adding a scroll-triggered remeasure makes the layout robust even if
    // a future container introduces its own overflow — bubbles stay
    // pinned to their anchors as the user drags the scrollbar.
    const onScroll = (): void => measure()
    window.addEventListener('scroll', onScroll, true)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
    }
    // editingId is in deps so opening / closing the inline editor
    // immediately re-measures even before the per-bubble ResizeObserver
    // fires its first callback (avoids a one-frame overlap flash).
  }, [sortedComments, diffMode, collapsed, sidebarWidth, editingId])

  // When the active comment changes (click bubble, J/K jump, scroll-spy),
  // toggle a data-active attribute on the matching <mark.comment-anchor>
  // in the rendered markdown so CSS can paint it with a stronger
  // highlight. Re-applied whenever the wrap effect re-runs (since wrap
  // strips and recreates every mark, otherwise the active state would be
  // lost after a comments refetch).
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
  }, [activeCommentId, sortedComments, diffMode])

  const onBubbleClick = useCallback((commentId: string) => {
    setActiveCommentId(commentId)
    const el = markdownRef.current?.querySelector<HTMLElement>(
      `mark.comment-anchor[data-comment-id="${commentId}"]`,
    )
    if (el !== null && el !== undefined) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [])

  // Scroll-spy: hook IntersectionObserver to the rendered DOM after each
  // markdown rerender. Currently a simple "top visible anchor in viewport"
  // heuristic — keeps the sidebar tracking the user's reading position.
  useEffect(() => {
    if (markdownRef.current === null || activeBody === undefined) return
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (top !== undefined) {
          const id = (top.target as HTMLElement).dataset.commentId ?? null
          if (id !== null) setActiveCommentId(id)
        }
      },
      { rootMargin: '-20% 0px -60% 0px' },
    )
    const anchors = markdownRef.current.querySelectorAll('[data-comment-id]')
    anchors.forEach((a) => observer.observe(a))
    return () => observer.disconnect()
  }, [activeBody])

  // Keyboard shortcuts: A/R/I + J/K (cross-comment jump) + Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // RFC-013: read-only historical mode disables every shortcut. The
      // decision buttons are not in the DOM, the popover is never opened,
      // and the diff toggle is hidden — so A/R/I, Ctrl+1/2/3 and even
      // J/K (which depend on comment-anchor state that's intentionally
      // present in the read-only view but should not steal global focus
      // away from typing in dev tools etc) all short-circuit.
      if (readonly) return
      if (popover !== null) {
        if (e.key === 'Escape') {
          setPopover(null)
        }
        return
      }
      // RFC-009-T3: while the user is editing a comment, all single-key
      // shortcuts are off — `j` / `k` need to type into the textarea, and
      // `a` / `r` / `i` would steal the keystroke too. We still process
      // Cmd/Ctrl+Enter / Escape in the textarea's own onKeyDown, so this
      // early return is safe.
      if (editingId !== null) {
        return
      }
      // Don't hijack typing inside form fields.
      if (
        document.activeElement !== null &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)
      ) {
        return
      }
      // Granularity hotkeys: Ctrl/Cmd+1/2/3 cycle word/line/block when diff
      // is on. Don't run when modifiers aren't set so plain "1/2/3" still
      // types into focused fields.
      if (diffMode && (e.ctrlKey || e.metaKey)) {
        if (e.key === '1') {
          e.preventDefault()
          setDiffGranularity('word')
          return
        }
        if (e.key === '2') {
          e.preventDefault()
          setDiffGranularity('line')
          return
        }
        if (e.key === '3') {
          e.preventDefault()
          setDiffGranularity('block')
          return
        }
      }
      const k = e.key.toLowerCase()
      if (k === 'a') void onApprove()
      else if (k === 'r') void onReject()
      else if (k === 'i') void onIterate()
      else if (k === 'j' || k === 'k') {
        // Jump to next / prev comment in doc order (sortedComments is
        // already sorted by anchor.offsetStart, matching the bubble
        // column's visual order).
        const comments = sortedComments
        if (comments.length === 0) return
        const currentIdx =
          activeCommentId === null ? -1 : comments.findIndex((c) => c.id === activeCommentId)
        const nextIdx =
          k === 'j' ? Math.min(currentIdx + 1, comments.length - 1) : Math.max(currentIdx - 1, 0)
        const target = comments[nextIdx]
        if (target !== undefined) {
          setActiveCommentId(target.id)
          const el = markdownRef.current?.querySelector(
            `mark.comment-anchor[data-comment-id="${target.id}"]`,
          )
          if (el !== null && el !== undefined) {
            ;(el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    popover,
    onApprove,
    onReject,
    onIterate,
    sortedComments,
    activeCommentId,
    diffMode,
    editingId,
    readonly,
  ])

  if (detail.isLoading) return <div className="muted">{t('common.loading')}</div>
  if (detail.error !== null && detail.error !== undefined) {
    const err = detail.error as ApiError
    return <div className="error-box">{err.message}</div>
  }
  if (detail.data === undefined) return null

  const data = detail.data
  // RFC-013: in readonly historical view, decision buttons are not in the
  // DOM, comment write affordances are hidden, and the diff toggle is
  // hidden. `isAwaiting` continues to drive the current-mode button enable
  // state. The "viewing version vN" label in the header switches between
  // current and historical too.
  const isAwaiting = !readonly && data.summary.awaitingReview
  const hasTitle = data.summary.title !== '' && data.summary.title !== data.summary.reviewNodeId
  const headerVersionIndex =
    view.mode === 'historical'
      ? (view.versionIndex ?? historicalDetail.data?.versionIndex)
      : data.currentVersion.versionIndex
  const headerDecision =
    view.mode === 'historical'
      ? (view.decision ?? historicalDetail.data?.decision)
      : data.currentVersion.decision

  // Download the markdown body the user is currently viewing (current or
  // historical version) as a `.md` file. Filename combines a sanitized title
  // (or the review node id when the user didn't set a title) with the
  // version index — gives a useful name when the user accumulates several
  // versions of the same review in their downloads folder. Sanitization
  // strips characters that POSIX / Windows refuse in filenames so the click
  // never silently fails on edge cases like "user/auth: design".
  const downloadDisabled = activeBody === undefined || activeBody.length === 0
  const downloadFileName = (() => {
    const base = (hasTitle ? data.summary.title : data.summary.reviewNodeId)
      .replace(/[\\/:*?"<>|\n\r\t]+/g, '_')
      .replace(/\s+/g, '_')
      .trim()
    const safeBase = base.length > 0 ? base : 'document'
    return `${safeBase}-v${headerVersionIndex ?? data.currentVersion.versionIndex}.md`
  })()
  const handleDownloadMarkdown = (): void => {
    if (activeBody === undefined || activeBody.length === 0) return
    const blob = new Blob([activeBody], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = downloadFileName
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="page review-detail">
      <header className="page__header review-detail__page-header">
        <div className="review-detail__page-header-text">
          <h1>
            {data.summary.workflowName} /{' '}
            {hasTitle ? data.summary.title : <code>{data.summary.reviewNodeId}</code>}
            <span className="muted">
              {' '}
              · v{headerVersionIndex ?? data.currentVersion.versionIndex}
            </span>
          </h1>
          {hasTitle && (
            <div className="muted">
              <code>{data.summary.reviewNodeId}</code>
            </div>
          )}
          {data.summary.description !== '' && data.summary.description !== data.summary.title && (
            <p className="page__hint review-detail__description">{data.summary.description}</p>
          )}
          {!readonly && (
            <p className="page__hint">
              {t('reviews.detailHint', {
                iteration: data.summary.reviewIteration,
                decision: data.currentVersion.decision,
              })}
            </p>
          )}
        </div>
        <div className="review-detail__page-header-actions">
          <button
            type="button"
            className="btn btn--sm review-detail__download"
            disabled={downloadDisabled}
            onClick={handleDownloadMarkdown}
            title={t('reviews.downloadMarkdownTitle', { filename: downloadFileName })}
          >
            <span aria-hidden="true" className="review-detail__download-icon">
              ↓
            </span>
            {t('reviews.downloadMarkdown')}
          </button>
        </div>
      </header>

      {readonly && (
        <div className="readonly-banner" role="status">
          <span>
            {t('reviews.historicalBanner', {
              version: headerVersionIndex ?? '?',
              decision: headerDecision ?? 'pending',
            })}
          </span>
          <Link
            to="/reviews/$nodeRunId"
            params={{ nodeRunId }}
            search={{}}
            className="link readonly-banner__back"
          >
            {t('reviews.backToCurrent')}
          </Link>
        </div>
      )}

      {!readonly && data.currentVersion.versionIndex > 1 && (
        <div className="review-detail__diff-toolbar">
          {/* RFC-010 follow-up：把"勾选框 + 三按钮"合并成一个 4 段 pill
              segmented control。选 "原文" 等价于关闭 diff 模式；其它三段
              等价于开启 diff + 设置 granularity。视觉更紧凑、状态更明确，
              用户少一次"先勾选才出现按钮"的两步操作。 */}
          <div className="diff-mode-segmented" role="tablist" aria-label={t('reviews.diffToggle')}>
            {(['off', 'word', 'line', 'block'] as const).map((m) => {
              const active = m === 'off' ? !diffMode : diffMode && diffGranularity === m
              const label =
                m === 'off'
                  ? t('reviews.diffOff')
                  : t(`reviews.diffGranularity${m.charAt(0).toUpperCase()}${m.slice(1)}` as const)
              return (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={
                    'diff-mode-segmented__btn' + (active ? ' diff-mode-segmented__btn--active' : '')
                  }
                  onClick={() => {
                    if (m === 'off') {
                      setDiffMode(false)
                    } else {
                      setDiffMode(true)
                      setDiffGranularity(m)
                    }
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div
        className="review-detail__layout"
        style={{
          gridTemplateColumns: `minmax(0, 1fr) ${collapsed ? SIDEBAR_COLLAPSED_PX : sidebarWidth}px`,
        }}
      >
        {!readonly && diffMode && priorBody.data !== undefined ? (
          <div className="review-detail__body">
            <DiffView
              left={priorBody.data.body}
              right={data.currentBody}
              granularity={diffGranularity}
              leftLabel={t('reviews.diffLeftLabel', {
                version: priorVersion?.versionIndex ?? '?',
                decision: priorVersion?.decision ?? 'pending',
              })}
              rightLabel={t('reviews.diffRightLabel', {
                version: data.currentVersion.versionIndex,
              })}
            />
          </div>
        ) : readonly && historicalDetail.isLoading ? (
          <div className="review-detail__body muted">{t('common.loading')}</div>
        ) : (
          <div
            className="review-detail__body"
            ref={markdownRef}
            onMouseUp={readonly ? undefined : () => void onMouseUpInDoc()}
          >
            <Prose
              body={activeBody ?? ''}
              taskId={data.summary.taskId}
              plantumlEndpoint={config.data?.plantumlEndpoint}
              plantumlAuthHeader={config.data?.plantumlAuthHeader}
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
            {/* RFC-009-T2: drag handle on the left edge of the column. */}
            <div
              className="review-detail__sidebar-resizer"
              data-dragging={resizing ? 'true' : 'false'}
              onPointerDown={onResizerPointerDown}
              role="separator"
              aria-orientation="vertical"
            />
            {/* RFC-009-T5: sticky header — count + collapse toggle. */}
            <header className="review-detail__sidebar-header">
              <span className="review-detail__sidebar-count">
                {t('reviews.sidebarCountLabel', { count: sortedComments.length })}
              </span>
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
                {readonly ? t('reviews.sidebarEmptyReadonly') : t('reviews.sidebarEmpty')}
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
                    {/* RFC-013: in read-only historical view, ALL comment
                        write affordances (edit / copy / delete) are
                        omitted from the DOM so they don't visually imply
                        an action that the page will refuse to take. */}
                    {!readonly && !isEditing && (
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
                          disabled={!isAwaiting}
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
                          disabled={!isAwaiting}
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
                        <textarea
                          autoFocus
                          rows={3}
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
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
                  </article>
                )
              })
            )}
          </div>
        )}
      </div>

      {!readonly && (
        <footer className="review-detail__footer">
          <button
            type="button"
            className="btn btn--primary"
            disabled={!isAwaiting || submitDecision.isPending}
            onClick={() => void onApprove()}
          >
            {t('reviews.approveButton')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!isAwaiting || submitDecision.isPending}
            onClick={() => void onIterate()}
          >
            {t('reviews.iterateButton')}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            disabled={!isAwaiting || submitDecision.isPending}
            onClick={() => void onReject()}
          >
            {t('reviews.rejectButton')}
          </button>
          {submitDecision.error !== null && submitDecision.error !== undefined && (
            <div className="error-box">{(submitDecision.error as Error).message}</div>
          )}
        </footer>
      )}

      {!readonly && popover !== null && (
        <div
          className="comment-popover"
          style={{ position: 'absolute', left: popover.rect.left, top: popover.rect.top }}
          role="dialog"
        >
          <div className="muted">{popover.anchor.sectionPath}</div>
          <textarea
            className="form-input"
            autoFocus
            rows={3}
            value={popover.draft}
            placeholder={t('reviews.popoverPlaceholder')}
            onChange={(e) => setPopover({ ...popover, draft: e.target.value })}
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
                if (detail.data === undefined) return
                void deleteDraft({
                  taskId: detail.data.summary.taskId,
                  nodeRunId,
                  docVersionId: detail.data.currentVersion.id,
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
    </div>
  )

  async function submitPopover() {
    if (popover === null || detail.data === undefined) return
    const text = popover.draft.trim()
    if (text.length === 0) return
    await submitComment.mutateAsync({ anchor: popover.anchor, commentText: text })
    await deleteDraft({
      taskId: detail.data.summary.taskId,
      nodeRunId,
      docVersionId: detail.data.currentVersion.id,
      anchorHash: anchorKey(popover.anchor),
    })
    void commentsByOccurrence // silence unused-var lint if commentsByOccurrence never gets a reader
    setPopover(null)
  }
}
