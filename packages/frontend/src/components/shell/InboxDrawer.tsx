// RFC-195: task-focused inbox dialog.
//
// The shared Dialog owns modal chrome, dismissal, scroll locking, the focus
// trap, and trigger focus restoration. This component owns only the three
// failure-soft inbox feeds and their task-oriented presentation.

import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { ClarifyRoundSummary, ReviewSummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { RelativeTime } from '@/components/RelativeTime'
import { Segmented, type SegmentedOption } from '@/components/Segmented'
import { deriveInboxViewModel, type InboxItem, type InboxTab } from '@/lib/inbox-view'
import type { WorkgroupPendingCount } from '@/lib/workgroup-room'
import { InboxIcon } from './InboxIcon'

interface InboxDrawerProps {
  open: boolean
  onClose: () => void
  triggerRef?: RefObject<HTMLElement | null>
}

export function InboxDrawer({ open, onClose, triggerRef }: InboxDrawerProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<InboxTab>('all')
  const selectedOptionRef = useRef<HTMLButtonElement | null>(null)
  const navigate = useNavigate()

  const reviews = useQuery<ReviewSummary[]>({
    queryKey: ['reviews', 'inbox', 'pending'],
    queryFn: ({ signal }) => api.get('/api/reviews?status=pending', undefined, signal),
    enabled: open,
    refetchInterval: open ? 15_000 : false,
  })

  const clarify = useQuery<ClarifyRoundSummary[]>({
    queryKey: ['clarify', 'inbox', 'pending'],
    queryFn: ({ signal }) => api.get('/api/clarify?status=awaiting_human', undefined, signal),
    enabled: open,
    refetchInterval: open ? 15_000 : false,
  })

  // RFC-164: this endpoint is count-only, so it becomes one aggregate row
  // in the All view and navigates to the tasks list for the actual actions.
  const workgroups = useQuery<WorkgroupPendingCount>({
    queryKey: ['workgroup-tasks', 'pending-count'],
    queryFn: ({ signal }) => api.get('/api/workgroup-tasks/pending-count', undefined, signal),
    enabled: open,
    refetchInterval: open ? 15_000 : false,
  })

  const view = deriveInboxViewModel({
    tab,
    reviews: {
      data: reviews.data,
      isInitialLoading: reviews.isLoading,
      error: reviews.error,
    },
    clarify: {
      data: clarify.data,
      isInitialLoading: clarify.isLoading,
      error: clarify.error,
    },
    workgroups: {
      data: workgroups.data,
      isInitialLoading: workgroups.isLoading,
      error: workgroups.error,
    },
    formatClarifyContext: ({ askingAgent, shardKey, iteration }) => {
      const detail =
        shardKey !== null
          ? t('nav.inbox.shardLabel', { shard: shardKey })
          : t('nav.inbox.iterLabel', { iter: iteration })
      return t('nav.inbox.clarifySubtitle', { agent: askingAgent, detail })
    },
  })

  const selectedCount =
    tab === 'all' ? view.counts.all : tab === 'reviews' ? view.counts.reviews : view.counts.clarify
  const options: ReadonlyArray<SegmentedOption<InboxTab>> = (
    ['all', 'reviews', 'clarify'] as const
  ).map((value) => ({
    value,
    testid: `inbox-tab-${value}`,
    label: (
      <span className="inbox-dialog__filter-label">
        {t(inboxTabLabelKey(value))}
        {view.counts[value] !== undefined && (
          <span className="inbox-dialog__filter-count">{view.counts[value]}</span>
        )}
      </span>
    ),
  }))

  const navigateAndClose = (target: unknown): void => {
    onClose()
    // Route targets are fixed below; keeping this helper untyped avoids
    // spreading TanStack Router's route-union cast across every row.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void navigate(target as any)
  }

  const footer = (
    <div className="inbox-dialog__footer">
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        data-testid="inbox-drawer-open-reviews"
        onClick={() => navigateAndClose({ to: '/reviews' })}
      >
        {t('nav.inbox.openReviews')}
      </button>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        data-testid="inbox-drawer-open-clarify"
        onClick={() => navigateAndClose({ to: '/clarify' })}
      >
        {t('nav.inbox.openClarify')}
      </button>
    </div>
  )

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('nav.inbox.label')}
      triggerRef={triggerRef}
      initialFocusRef={selectedOptionRef}
      panelClassName="inbox-dialog"
      data-testid="inbox-drawer"
      footer={footer}
    >
      <div className="inbox-dialog__summary">
        <div className="inbox-dialog__summary-copy">
          <p className="inbox-dialog__subtitle">{t('nav.inbox.subtitle')}</p>
        </div>
        {view.partial ? (
          <span className="status-badge inbox-dialog__total">{t('nav.inbox.partial')}</span>
        ) : selectedCount !== undefined ? (
          <span className="status-badge inbox-dialog__total">
            {t('nav.inbox.total', { n: selectedCount })}
          </span>
        ) : null}
      </div>

      <Segmented
        value={tab}
        onChange={setTab}
        options={options}
        ariaLabel={t('nav.inbox.filterAria')}
        className="inbox-dialog__filters"
        activeOptionRef={selectedOptionRef}
      />

      <InboxFeedErrors
        tab={tab}
        reviewError={reviews.error}
        clarifyError={clarify.error}
        workgroupError={workgroups.error}
        retryReviews={() => void reviews.refetch()}
        retryClarify={() => void clarify.refetch()}
        retryWorkgroups={() => void workgroups.refetch()}
      />

      {view.state === 'loading' && (
        <div className="inbox-dialog__state">
          <LoadingState size="compact" label={t('nav.inbox.loading')} data-testid="inbox-loading" />
        </div>
      )}

      {view.state === 'empty' && (
        <div className="inbox-dialog__state">
          <EmptyState
            size="compact"
            title={t('nav.inbox.empty')}
            description={t('nav.inbox.emptyHint')}
            icon={<InboxEmptyIcon />}
          />
        </div>
      )}

      {view.state === 'content' && (
        <div className="inbox-dialog__list">
          {view.workgroup !== null && (
            <button
              key={view.workgroup.rowKey}
              type="button"
              className="inbox-dialog__item"
              data-testid="inbox-row-workgroups"
              onClick={() => navigateAndClose({ to: '/tasks' })}
            >
              <span className="inbox-dialog__item-meta">
                <span className="inbox-dialog__kind inbox-dialog__kind--wg" data-kind="wg">
                  {t('nav.inbox.wgKind')}
                </span>
                <span className="inbox-dialog__workgroup-count">
                  {t('nav.inbox.total', { n: view.workgroup.total })}
                </span>
              </span>
              <span className="inbox-dialog__item-title">
                {t('nav.inbox.wgRow', { count: view.workgroup.total })}
              </span>
              <span className="inbox-dialog__item-source">
                <span className="inbox-dialog__task-name">{t('nav.group.tasks')}</span>
                <span
                  className="inbox-dialog__context"
                  data-testid="inbox-row-workgroups-breakdown"
                >
                  {t('nav.inbox.wgBreakdown', {
                    d: view.workgroup.deliveries,
                    g: view.workgroup.gates,
                  })}
                </span>
              </span>
              <span className="inbox-dialog__chevron" aria-hidden="true">
                ›
              </span>
            </button>
          )}

          {view.items.map((item) => (
            <InboxItemRow
              key={`${item.kind}-${item.rowKey}`}
              item={item}
              onOpen={() =>
                navigateAndClose(
                  item.kind === 'review'
                    ? {
                        to: '/reviews/$nodeRunId',
                        params: { nodeRunId: item.navigationId },
                      }
                    : {
                        to: '/clarify/$nodeRunId',
                        params: { nodeRunId: item.navigationId },
                      },
                )
              }
            />
          ))}
        </div>
      )}
    </Dialog>
  )
}

interface InboxFeedErrorsProps {
  tab: InboxTab
  reviewError: unknown | null
  clarifyError: unknown | null
  workgroupError: unknown | null
  retryReviews: () => void
  retryClarify: () => void
  retryWorkgroups: () => void
}

function InboxFeedErrors(props: InboxFeedErrorsProps) {
  const { t } = useTranslation()
  const errors = [
    (props.tab === 'all' || props.tab === 'reviews') && props.reviewError !== null
      ? {
          key: 'reviews',
          error: props.reviewError,
          message: t('nav.inbox.errorReviews'),
          feedLabel: t('nav.inbox.tabReviews'),
          retry: props.retryReviews,
        }
      : null,
    (props.tab === 'all' || props.tab === 'clarify') && props.clarifyError !== null
      ? {
          key: 'clarify',
          error: props.clarifyError,
          message: t('nav.inbox.errorClarify'),
          feedLabel: t('nav.inbox.tabClarify'),
          retry: props.retryClarify,
        }
      : null,
    props.tab === 'all' && props.workgroupError !== null
      ? {
          key: 'workgroups',
          error: props.workgroupError,
          message: t('nav.inbox.errorWorkgroups'),
          feedLabel: t('nav.inbox.wgKind'),
          retry: props.retryWorkgroups,
        }
      : null,
  ].filter((entry): entry is NonNullable<typeof entry> => entry !== null)

  if (errors.length === 0) return null

  return (
    <div className="inbox-dialog__errors">
      {errors.map((entry) => (
        <ErrorBanner
          key={entry.key}
          error={entry.error}
          message={entry.message}
          onRetry={entry.retry}
          retryLabel={t('nav.inbox.retry')}
          retryAriaLabel={t('nav.inbox.retryFeed', { feed: entry.feedLabel })}
        />
      ))}
    </div>
  )
}

function InboxItemRow({ item, onOpen }: { item: InboxItem; onOpen: () => void }) {
  const { t } = useTranslation()
  const kindLabel = t(inboxKindLabelKey(item.kind))
  const taskLabel =
    item.taskName.length > 0 ? item.taskName : t('nav.inbox.sourceTask', { taskId: item.taskId })

  return (
    <button
      type="button"
      className="inbox-dialog__item"
      data-testid={`inbox-row-${item.kind}-${item.rowKey}`}
      onClick={onOpen}
    >
      <span className="inbox-dialog__item-meta">
        <span
          className={`inbox-dialog__kind inbox-dialog__kind--${item.kind}`}
          data-kind={item.kind}
        >
          {kindLabel}
        </span>
        <span className="inbox-dialog__time">
          <RelativeTime ts={item.createdAt} data-testid={`inbox-row-time-${item.rowKey}`} />
        </span>
      </span>
      <span className="inbox-dialog__item-title">{item.title}</span>
      <span className="inbox-dialog__item-source">
        <span
          className="inbox-dialog__task-name"
          data-testid="inbox-row-task-name"
          title={item.taskId}
        >
          {taskLabel}
        </span>
        <span className="inbox-dialog__context">{item.context}</span>
      </span>
      <span className="inbox-dialog__chevron" aria-hidden="true">
        ›
      </span>
    </button>
  )
}

function inboxTabLabelKey(tab: InboxTab): string {
  switch (tab) {
    case 'all':
      return 'nav.inbox.tabAll'
    case 'reviews':
      return 'nav.inbox.tabReviews'
    case 'clarify':
      return 'nav.inbox.tabClarify'
  }
}

function inboxKindLabelKey(kind: InboxItem['kind']): string {
  switch (kind) {
    case 'review':
      return 'nav.inbox.tabReviews'
    case 'clarify':
      return 'nav.inbox.tabClarify'
  }
}

function InboxEmptyIcon() {
  return (
    <span className="inbox-dialog__empty-icon">
      <InboxIcon size={32} strokeWidth={1.6} />
    </span>
  )
}
