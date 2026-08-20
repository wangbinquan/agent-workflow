// RFC-159 → RFC-192 → RFC-246 — scheduled-task operations surface.
//
// RFC-246 keeps every established row behavior (enable PUT, two-click run-now,
// launched-only last-task links, and guarded row navigation) while aligning the
// information hierarchy, density, filters, and responsive shape with /tasks.

import type { ScheduledTask, ScheduledTaskListItem } from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'

import { api, type ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FeedbackStack } from '@/components/FeedbackStack'
import { Field, Switch } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { OperationsChevronIcon, OperationsToolbar } from '@/components/operations/OperationsToolbar'
import { OwnerLabel } from '@/components/OwnerLabel'
import { PageHeader } from '@/components/PageHeader'
import { RelativeTime } from '@/components/RelativeTime'
import { ScheduledRunNowAction } from '@/components/ScheduledRunNowAction'
import { Segmented } from '@/components/Segmented'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { SCHEDULE_ICON } from '@/components/icons/resourceIcons'
import { useScheduledTaskWs } from '@/hooks/useScheduledTaskWs'
import {
  SCHEDULED_OPERATIONS_VIEWS,
  filterScheduledOperations,
  scheduledNeedsRepair,
  scheduledOperationsFacets,
  type ScheduledLaunchKindFilter,
  type ScheduledOperationsView,
  type ScheduledOutcomeFilter,
} from '@/lib/operations-filters'
import { shouldRowNavigate } from '@/lib/row-nav'
import { scheduleRunNowEligibility, scheduleSummary } from '@/lib/schedule-view'
import { Route as RootRoute } from './__root'

const SCHEDULED_LAUNCH_KINDS = ['all', 'workflow', 'workgroup', 'agent'] as const
const SCHEDULED_OUTCOMES = ['all', 'never', 'launched', 'failed'] as const

interface ScheduledFilterDraft {
  launchKind: ScheduledLaunchKindFilter
  outcome: ScheduledOutcomeFilter
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/scheduled',
  component: ScheduledPage,
})

function ScheduledPage() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const lang = i18n.language.startsWith('zh') ? 'zh' : 'en'
  useScheduledTaskWs()

  const { data, isLoading, error, refetch } = useQuery<ScheduledTaskListItem[]>({
    queryKey: ['scheduled-tasks', 'list'],
    queryFn: ({ signal }) => api.get('/api/scheduled-tasks', undefined, signal),
    refetchInterval: 30_000,
  })

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['scheduled-tasks'] })
  // No optimistic mirror: the backend can auto-disable after repeated failures.
  const toggle = useMutation<ScheduledTask, ApiError, { id: string; enabled: boolean }>({
    mutationFn: ({ id, enabled }) =>
      api.put(`/api/scheduled-tasks/${encodeURIComponent(id)}`, { enabled }),
    onSuccess: invalidate,
  })
  const [view, setView] = useState<ScheduledOperationsView>('all')
  const [search, setSearch] = useState('')
  const [launchKind, setLaunchKind] = useState<ScheduledLaunchKindFilter>('all')
  const [outcome, setOutcome] = useState<ScheduledOutcomeFilter>('all')
  const [filterOpen, setFilterOpen] = useState(false)
  const [draft, setDraft] = useState<ScheduledFilterDraft>({ launchKind: 'all', outcome: 'all' })
  const searchRef = useRef<HTMLInputElement | null>(null)
  const filterButtonRef = useRef<HTMLButtonElement | null>(null)

  const items = useMemo(() => data ?? [], [data])
  const facets = useMemo(() => scheduledOperationsFacets(items), [items])
  const filtered = useMemo(
    () =>
      filterScheduledOperations(items, { view, q: search, launchKind, outcome }, (row) =>
        scheduleSummary(row.scheduleSpec, lang),
      ),
    [items, lang, launchKind, outcome, search, view],
  )
  const advancedFilterCount = Number(launchKind !== 'all') + Number(outcome !== 'all')
  const hasAnyFilter = view !== 'all' || search.trim() !== '' || advancedFilterCount > 0
  const isInitialEmpty = !isLoading && data !== undefined && items.length === 0
  const noMatches = !isLoading && error == null && items.length > 0 && filtered.length === 0

  const clearFilters = () => {
    setView('all')
    setSearch('')
    setLaunchKind('all')
    setOutcome('all')
    window.setTimeout(() => searchRef.current?.focus(), 0)
  }
  const openFilters = () => {
    setDraft({ launchKind, outcome })
    setFilterOpen(true)
  }
  const applyFilters = () => {
    setLaunchKind(draft.launchKind)
    setOutcome(draft.outcome)
    setFilterOpen(false)
  }

  const newScheduledAction = (
    <button
      type="button"
      className="btn btn--primary"
      onClick={() => void navigate({ to: '/tasks/new', search: { schedule: true } })}
      data-testid="scheduled-new"
    >
      {t('scheduled.new')}
    </button>
  )

  return (
    <div className="page page--operations page--scheduled-operations">
      <div className="operations-surface">
        <PageHeader
          title={t('scheduled.title')}
          actions={isInitialEmpty ? undefined : newScheduledAction}
          className="operations-surface__header"
        >
          <p className="operations-surface__subtitle">{t('scheduled.operations.subtitle')}</p>
        </PageHeader>

        {!isInitialEmpty && (
          <OperationsToolbar<ScheduledOperationsView>
            view={view}
            onViewChange={setView}
            views={SCHEDULED_OPERATIONS_VIEWS.map((value) => ({
              value,
              label: t(`scheduled.operations.views.${value}`),
              count: facets[value],
            }))}
            viewAria={t('scheduled.operations.viewAria')}
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder={t('scheduled.operations.searchPlaceholder')}
            searchLabel={t('scheduled.operations.searchLabel')}
            filterLabel={t('scheduled.operations.filters')}
            activeFilterCount={advancedFilterCount}
            activeFiltersLabel={(count) => t('scheduled.operations.activeFilters', { count })}
            onOpenFilters={openFilters}
            showClear={hasAnyFilter}
            clearLabel={t('common.clearFilters')}
            onClear={clearFilters}
            testidPrefix="scheduled"
            busy={isLoading}
            searchRef={searchRef}
            filterButtonRef={filterButtonRef}
          />
        )}

        <FeedbackStack variant="section">
          {error !== null && error !== undefined && (
            <ErrorBanner error={error} onRetry={() => void refetch()} />
          )}
          {toggle.error != null && <ErrorBanner error={toggle.error} />}
        </FeedbackStack>
        {isLoading && <LoadingState data-testid="scheduled-loading" />}
        {isInitialEmpty && (
          <EmptyState
            title={t('scheduled.empty')}
            description={t('scheduled.emptyDescription')}
            icon={SCHEDULE_ICON}
            action={newScheduledAction}
            data-testid="scheduled-empty"
          />
        )}
        {noMatches && (
          <EmptyState
            title={t('common.noMatches')}
            description={t('scheduled.operations.noMatchesDescription')}
            action={
              <button type="button" className="btn" onClick={clearFilters}>
                {t('common.clearFilters')}
              </button>
            }
            data-testid="scheduled-no-matches"
          />
        )}
        {filtered.length > 0 && (
          <ScheduledOperationsTable
            rows={filtered}
            lang={lang}
            togglePending={toggle.isPending}
            onToggle={(id, enabled) => toggle.mutate({ id, enabled })}
            onRunNowSuccess={(taskId) => {
              invalidate()
              void navigate({ to: '/tasks/$id', params: { id: taskId } })
            }}
            onNavigate={(id) => void navigate({ to: '/scheduled/$id', params: { id } })}
          />
        )}
      </div>

      <ScheduledFilterDialog
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        triggerRef={filterButtonRef}
        draft={draft}
        onChange={setDraft}
        onApply={applyFilters}
        onClear={() => setDraft({ launchKind: 'all', outcome: 'all' })}
      />
    </div>
  )
}

function ScheduledFilterDialog(props: {
  open: boolean
  onClose: () => void
  triggerRef: RefObject<HTMLButtonElement | null>
  draft: ScheduledFilterDraft
  onChange: (draft: ScheduledFilterDraft) => void
  onApply: () => void
  onClear: () => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t('scheduled.operations.filterTitle')}
      size="md"
      triggerRef={props.triggerRef}
      data-testid="scheduled-filter-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClear}>
            {t('common.clearFilters')}
          </button>
          <button type="button" className="btn btn--primary" onClick={props.onApply}>
            {t('scheduled.operations.applyFilters')}
          </button>
        </>
      }
    >
      <div className="form-grid operations-filter-dialog">
        <Field label={t('scheduled.operations.launchKindLabel')} group>
          <Segmented<ScheduledLaunchKindFilter>
            value={props.draft.launchKind}
            onChange={(next) => props.onChange({ ...props.draft, launchKind: next })}
            ariaLabel={t('scheduled.operations.launchKindLabel')}
            options={SCHEDULED_LAUNCH_KINDS.map((value) => ({
              value,
              label: t(`scheduled.operations.launchKinds.${value}`),
            }))}
          />
        </Field>
        <Field label={t('scheduled.operations.outcomeLabel')} group>
          <Segmented<ScheduledOutcomeFilter>
            value={props.draft.outcome}
            onChange={(next) => props.onChange({ ...props.draft, outcome: next })}
            ariaLabel={t('scheduled.operations.outcomeLabel')}
            options={SCHEDULED_OUTCOMES.map((value) => ({
              value,
              label: t(`scheduled.operations.outcomes.${value}`),
            }))}
          />
        </Field>
      </div>
    </Dialog>
  )
}

function ScheduledOperationsTable(props: {
  rows: ScheduledTaskListItem[]
  lang: 'zh' | 'en'
  togglePending: boolean
  onToggle: (id: string, enabled: boolean) => void
  onRunNowSuccess: (taskId: string) => void
  onNavigate: (id: string) => void
}) {
  const { t } = useTranslation()
  return (
    <TableViewport label={t('scheduled.title')}>
      <table
        className="data-table operations-table scheduled-operations"
        data-testid="scheduled-table"
      >
        <thead>
          <tr>
            <th>{t('scheduled.operations.columns.schedule')}</th>
            <th>{t('scheduled.operations.columns.state')}</th>
            <th>{t('scheduled.operations.columns.next')}</th>
            <th>{t('acl.owner')}</th>
            <th aria-label={t('common.ariaActions')} />
            <th aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => {
            const repair = scheduledNeedsRepair(row)
            const summary = scheduleSummary(row.scheduleSpec, props.lang)
            const runNowEligibility = scheduleRunNowEligibility(row)
            return (
              <ScheduledRunNowAction
                key={row.id}
                scheduleId={row.id}
                eligibility={runNowEligibility}
                onSuccess={props.onRunNowSuccess}
                size="sm"
                testid={`scheduled-run-now-${row.id}`}
                errorTestid={`scheduled-run-now-error-${row.id}`}
              >
                {({ action, feedback }) => (
                  <>
                    <tr
                      className="data-table__row scheduled-operations__row"
                      onClick={(event) => {
                        if (shouldRowNavigate(event)) props.onNavigate(row.id)
                      }}
                      data-testid={`scheduled-row-${row.id}`}
                    >
                      <td className="scheduled-operations__schedule">
                        <span className="operations-table__mobile-label">
                          {t('scheduled.operations.columns.schedule')}：
                        </span>
                        <div className="scheduled-operations__name-line">
                          <Link
                            to="/scheduled/$id"
                            params={{ id: row.id }}
                            className="data-table__link scheduled-operations__name"
                            title={row.name}
                          >
                            {row.name}
                          </Link>
                          {repair && (
                            <StatusChip
                              kind="warn"
                              size="sm"
                              data-testid={`scheduled-repair-${row.id}`}
                            >
                              {t('scheduled.repairBadge')}
                            </StatusChip>
                          )}
                        </div>
                        <div className="scheduled-operations__meta">
                          <span>{t(`scheduled.operations.launchKinds.${row.launchKind}`)}</span>
                          <span aria-hidden="true">·</span>
                          <span className="scheduled-operations__summary" title={summary}>
                            {summary}
                          </span>
                        </div>
                      </td>
                      <td className="scheduled-operations__state">
                        <span className="operations-table__mobile-label">
                          {t('scheduled.operations.columns.state')}：
                        </span>
                        <div className="scheduled-operations__toggle">
                          <Switch
                            checked={row.enabled}
                            disabled={props.togglePending}
                            onChange={(enabled) => props.onToggle(row.id, enabled)}
                            aria-label={t('scheduled.colEnabled')}
                            data-testid={`scheduled-enable-${row.id}`}
                          />
                          <span>
                            {t(row.enabled ? 'scheduled.enabledYes' : 'scheduled.enabledNo')}
                          </span>
                        </div>
                        <div className="scheduled-operations__last-run">
                          {row.lastStatus === null ? (
                            <span>{t('scheduled.lastNever')}</span>
                          ) : (
                            <>
                              <StatusChip
                                kind={row.lastStatus === 'failed' ? 'danger' : 'success'}
                                size="sm"
                              >
                                {t(`scheduled.last_${row.lastStatus}`)}
                              </StatusChip>
                              {row.consecutiveFailures > 1 && (
                                <StatusChip
                                  kind="danger"
                                  size="sm"
                                  data-testid={`scheduled-streak-${row.id}`}
                                >
                                  {t('scheduled.consecutiveChip', {
                                    n: row.consecutiveFailures,
                                  })}
                                </StatusChip>
                              )}
                              {row.lastRunAt !== null && <RelativeTime ts={row.lastRunAt} />}
                              {row.lastStatus === 'launched' && row.lastTaskId !== null && (
                                <Link
                                  to="/tasks/$id"
                                  params={{ id: row.lastTaskId }}
                                  className="data-table__link"
                                  data-testid={`scheduled-last-task-${row.id}`}
                                >
                                  {t('scheduled.lastTaskLink')}
                                </Link>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                      <td className="scheduled-next scheduled-operations__next">
                        <span className="operations-table__mobile-label">
                          {t('scheduled.operations.columns.next')}：
                        </span>
                        {row.enabled && row.nextRunAt !== null ? (
                          <>
                            <RelativeTime ts={row.nextRunAt} />
                            <span className="scheduled-next__abs scheduled-operations__secondary">
                              {new Date(row.nextRunAt).toLocaleString(undefined, {
                                dateStyle: 'short',
                                timeStyle: 'short',
                              })}
                            </span>
                          </>
                        ) : (
                          <span className="data-table__muted">{t('common.emDash')}</span>
                        )}
                      </td>
                      <td className="data-table__owner-cell scheduled-operations__owner">
                        <span className="operations-table__mobile-label">{t('acl.owner')}：</span>
                        <OwnerLabel ownerUserId={row.ownerUserId} owner={row.owner} />
                      </td>
                      <td className="data-table__actions scheduled-operations__actions">
                        <span className="operations-table__mobile-label">
                          {t('common.ariaActions')}：
                        </span>
                        {action}
                      </td>
                      <td
                        className="data-table__chevron scheduled-operations__nav"
                        aria-hidden="true"
                      >
                        <OperationsChevronIcon />
                      </td>
                    </tr>
                    {feedback !== null && (
                      <tr
                        className="scheduled-operations__feedback-row"
                        data-testid={`scheduled-run-now-feedback-row-${row.id}`}
                      >
                        <td colSpan={6}>
                          <div className="scheduled-operations__feedback">{feedback}</div>
                        </td>
                      </tr>
                    )}
                  </>
                )}
              </ScheduledRunNowAction>
            )
          })}
        </tbody>
      </table>
    </TableViewport>
  )
}
