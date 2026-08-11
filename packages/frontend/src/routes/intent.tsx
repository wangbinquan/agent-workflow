// RFC-235 — goal-first Intent landing page. The inline composer is the primary
// action; resource shortcuts open the same business form in a URL-owned dialog.

import {
  IntentSessionListPageSchema,
  type IntentSessionListPage,
  type IntentSessionSummary,
} from '@agent-workflow/shared'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import {
  createRoute,
  useBlocker,
  useNavigate,
  useRouter,
  type ShouldBlockFn,
} from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { IntentCreateComposer } from '@/components/intent/IntentCreateComposer'
import { IntentSessionList } from '@/components/intent/IntentSessionList'
import { PageHeader } from '@/components/PageHeader'
import { INTENT_QUERY_KEYS, useIntentSessionsWs } from '@/hooks/useIntentSessionsWs'
import { Route as RootRoute } from './__root'

type IntentArtifactHint = 'agent' | 'skill' | 'mcp' | 'plugin' | 'workflow' | 'workgroup'

export interface IntentSearch {
  create?: boolean
  hint?: IntentArtifactHint
  mountType?: IntentArtifactHint
  mountId?: string
}

const ARTIFACT_TYPES = ['agent', 'skill', 'mcp', 'plugin', 'workflow', 'workgroup'] as const

interface PendingPopGuardOptions {
  isPending: () => boolean
  currentIndex: () => number | undefined
  restore: (delta: number) => void
}

/**
 * @tanstack/history 1.161.6 always rolls a blocked pop with history.go(1):
 * correct for Back, wrong for Forward. Capture the managed pop before the
 * router's bubble listener and restore by the actual signed index delta.
 */
export function createIntentPendingPopGuard({
  isPending,
  currentIndex,
  restore,
}: PendingPopGuardOptions): (event: PopStateEvent) => void {
  let restoring = false
  return (event) => {
    if (restoring) {
      restoring = false
      event.stopImmediatePropagation()
      return
    }
    if (!isPending()) return
    const current = currentIndex()
    const next =
      typeof event.state === 'object' &&
      event.state !== null &&
      typeof (event.state as Record<string, unknown>).__TSR_index === 'number'
        ? ((event.state as Record<string, unknown>).__TSR_index as number)
        : undefined
    if (current === undefined || next === undefined || current === next) return
    event.stopImmediatePropagation()
    restoring = true
    restore(current - next)
  }
}

function artifactType(value: unknown): IntentArtifactHint | undefined {
  return ARTIFACT_TYPES.find((type) => type === value)
}

function validateIntentSearch(search: Record<string, unknown>): IntentSearch {
  const hint = artifactType(search.hint)
  const mountType = artifactType(search.mountType)
  return {
    ...(search.create === true || search.create === 'true' ? { create: true } : {}),
    ...(hint === undefined ? {} : { hint }),
    ...(mountType === undefined ? {} : { mountType }),
    ...(typeof search.mountId === 'string' && search.mountId !== ''
      ? { mountId: search.mountId }
      : {}),
  }
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/intent',
  component: IntentSessionsPage,
  validateSearch: validateIntentSearch,
})

function IntentSessionsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const router = useRouter()
  const qc = useQueryClient()
  const search = Route.useSearch()
  const [dialogFooterTarget, setDialogFooterTarget] = useState<HTMLDivElement | null>(null)
  const [dialogPending, setDialogPending] = useState(false)
  const inlineTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const dialogTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const composerPendingRef = useRef({ inline: false, dialog: false })
  const completionNavigationRef = useRef<{
    sessionId: string
    phase: 'canonicalize' | 'detail'
  } | null>(null)
  const reportComposerPending = useCallback((variant: 'inline' | 'dialog', pending: boolean) => {
    composerPendingRef.current[variant] = pending
    if (variant === 'dialog') setDialogPending(pending)
  }, [])
  const reportInlinePending = useCallback(
    (pending: boolean) => reportComposerPending('inline', pending),
    [reportComposerPending],
  )
  const reportDialogPending = useCallback(
    (pending: boolean) => reportComposerPending('dialog', pending),
    [reportComposerPending],
  )
  const isCreatePending = useCallback(
    () =>
      composerPendingRef.current.inline ||
      composerPendingRef.current.dialog ||
      completionNavigationRef.current !== null,
    [],
  )
  const shouldBlockCreateNavigation = useCallback<ShouldBlockFn>(
    ({ action, current, next }) => {
      if (!isCreatePending()) return false
      const completion = completionNavigationRef.current
      if (completion === null) return true
      if (completion.phase === 'canonicalize') {
        return !(
          action === 'REPLACE' &&
          current.pathname === '/intent' &&
          next.pathname === '/intent' &&
          Object.keys(next.search as Record<string, unknown>).length === 0
        )
      }
      const params = next.params as { sessionId?: string }
      return !(
        action === 'PUSH' &&
        current.pathname === '/intent' &&
        next.pathname.startsWith('/intent/') &&
        params.sessionId === completion.sessionId
      )
    },
    [isCreatePending],
  )
  // Creation is non-idempotent in this first slice. The shared Dialog protects
  // its own dismiss paths; this route-level guard also covers sidebar/link
  // navigation, browser back/forward, refresh, and the inline composer.
  useBlocker({
    shouldBlockFn: shouldBlockCreateNavigation,
    enableBeforeUnload: isCreatePending,
  })
  useEffect(() => {
    const onPopState = createIntentPendingPopGuard({
      isPending: isCreatePending,
      currentIndex: () => {
        const value = router.history.location.state.__TSR_index
        return typeof value === 'number' ? value : undefined
      },
      restore: (delta) => window.history.go(delta),
    })
    window.addEventListener('popstate', onPopState, true)
    return () => window.removeEventListener('popstate', onPopState, true)
  }, [isCreatePending, router.history])
  useIntentSessionsWs()

  const sessions = useInfiniteQuery<IntentSessionListPage, ApiError>({
    queryKey: INTENT_QUERY_KEYS.list,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const cursor = typeof pageParam === 'string' ? `&cursor=${encodeURIComponent(pageParam)}` : ''
      return IntentSessionListPageSchema.parse(
        await api.get<unknown>(`/api/intent-sessions?page=1&limit=12${cursor}`),
      )
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })
  const sessionRows = useMemo(() => {
    const byId = new Map<string, IntentSessionSummary>()
    for (const page of sessions.data?.pages ?? []) {
      for (const session of page.items) byId.set(session.id, session)
    }
    return [...byId.values()]
  }, [sessions.data?.pages])
  const openSession = async (session: IntentSessionSummary): Promise<void> => {
    void qc.invalidateQueries({ queryKey: INTENT_QUERY_KEYS.list })
    try {
      // Canonicalize the list entry first, then push the detail. This consumes
      // dialog-only search without deleting the stable /intent Back destination.
      if (Object.keys(search).length > 0) {
        completionNavigationRef.current = {
          sessionId: session.id,
          phase: 'canonicalize',
        }
        await navigate({ to: '/intent', search: {}, replace: true })
      }
      completionNavigationRef.current = { sessionId: session.id, phase: 'detail' }
      await navigate({
        to: '/intent/$sessionId',
        params: { sessionId: session.id },
      })
    } finally {
      completionNavigationRef.current = null
    }
  }
  const closeDialog = (): void => {
    void navigate({ to: '/intent', search: {}, replace: true })
  }
  const dialogMount =
    search.mountType !== undefined && search.mountId !== undefined
      ? { resourceType: search.mountType, resourceId: search.mountId }
      : undefined

  return (
    <div className="page intent-page">
      <PageHeader title={t('intent.title')} meta={t('intent.createLead')} />

      <section className="intent-page__hero" aria-label={t('intent.messageLabel')}>
        <IntentCreateComposer
          variant="inline"
          onCreated={openSession}
          textareaRef={inlineTextareaRef}
          onPendingChange={reportInlinePending}
        />
      </section>

      <IntentSessionList
        sessions={sessions.data === undefined ? undefined : sessionRows}
        loading={sessions.isLoading}
        error={sessions.isError ? sessions.error : null}
        hasMore={sessions.hasNextPage}
        loadingMore={sessions.isFetchingNextPage}
        onLoadMore={() => void sessions.fetchNextPage()}
      />

      <Dialog
        open={search.create === true}
        onClose={closeDialog}
        title={dialogMount === undefined ? t('intent.newSession') : t('intent.entryModify')}
        size="lg"
        dismissDisabled={dialogPending}
        initialFocusRef={dialogTextareaRef}
        restoreFocusFallbackRef={inlineTextareaRef}
        footer={
          <div
            ref={setDialogFooterTarget}
            className="intent-create-dialog__footer-target"
            data-testid="intent-create-dialog-footer"
          />
        }
      >
        <IntentCreateComposer
          key={`${search.hint ?? 'auto'}:${search.mountType ?? ''}:${search.mountId ?? ''}`}
          variant="dialog"
          initialHint={search.hint ?? 'auto'}
          {...(dialogMount === undefined ? {} : { mount: dialogMount })}
          onCancel={closeDialog}
          onCreated={openSession}
          textareaRef={dialogTextareaRef}
          onPendingChange={reportDialogPending}
          footerTarget={dialogFooterTarget}
        />
      </Dialog>
    </div>
  )
}
