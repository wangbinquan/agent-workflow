// RFC-244 — high-density task operations list.

import {
  TASK_LIST_ORIGINS,
  TASK_LIST_SCOPES,
  TASK_LIST_SUBJECTS,
  TASK_LIST_VIEWS,
  TASK_STATUS,
  canonicalTaskStatuses,
  parseTaskStatusList,
  taskMatchesListView,
  type TaskListOrigin,
  type TaskListScope,
  type TaskListSubject,
  type TaskListView,
  type TaskOperationsFilters,
  type TaskOperationsListItem,
  type TaskOperationsPage,
  type TaskStatus,
} from '@agent-workflow/shared'
import { useQuery } from '@tanstack/react-query'
import { Link, createRoute, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/Dialog'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FeedbackStack } from '@/components/FeedbackStack'
import { Field } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { ManagedLiveRegionProvider, useManagedLiveRegion } from '@/components/ManagedLiveRegion'
import { MultiSelect } from '@/components/MultiSelect'
import { NoticeBanner } from '@/components/NoticeBanner'
import {
  OperationsChevronIcon,
  OperationsExpandButton,
} from '@/components/operations/OperationsExpandButton'
import { OperationsToolbar } from '@/components/operations/OperationsToolbar'
import { OwnerLabel } from '@/components/OwnerLabel'
import { PageHeader } from '@/components/PageHeader'
import { VirtualList } from '@/components/VirtualList'
import { RelativeTime } from '@/components/RelativeTime'
import { Segmented } from '@/components/Segmented'
import { StatusChip } from '@/components/StatusChip'
import { TaskStatusChip } from '@/components/TaskStatusChip'
import { TaskSubjectLink } from '@/components/TaskSubjectLink'
import { TASK_ICON } from '@/components/icons/resourceIcons'
import { useActor, usePermission } from '@/hooks/useActor'
import { useNowTick } from '@/hooks/useNowTick'
import { useTaskOperationsPage } from '@/hooks/useTaskOperationsPage'
import { useTaskOperationsSync } from '@/hooks/useTaskOperationsSync'
import { shouldRowNavigate } from '@/lib/row-nav'
import { taskOperationsDuration } from '@/lib/task-operations-duration'
import { describeTaskFailure } from '@/lib/task-failure'
import { taskRepoDisplayName } from '@/lib/task-repo-name'
import { Route as RootRoute } from './__root'
import { missionStatusKind, missionStatusLabel, type MissionSummary } from './code.missions'

type TaskCategory = 'all' | 'orchestration' | 'digital-employee'
const TASK_CATEGORIES = ['all', 'orchestration', 'digital-employee'] as const

interface TasksSearch {
  view?: Exclude<TaskListView, 'all'>
  q?: string
  statuses?: string
  subject?: Exclude<TaskListSubject, 'all'>
  scope?: TaskListScope
  origin?: Exclude<TaskListOrigin, 'all'>
  category?: Exclude<TaskCategory, 'all'>
}

function canonicalSearch(raw: Record<string, unknown>): TasksSearch {
  const out: TasksSearch = {}
  if (
    typeof raw.view === 'string' &&
    raw.view !== 'all' &&
    (TASK_LIST_VIEWS as readonly string[]).includes(raw.view)
  ) {
    out.view = raw.view as Exclude<TaskListView, 'all'>
  }
  if (typeof raw.q === 'string') {
    const q = Array.from(raw.q.trim()).slice(0, 100).join('')
    if (q !== '') out.q = q
  }
  const rawStatuses =
    typeof raw.statuses === 'string'
      ? raw.statuses
      : typeof raw.status === 'string'
        ? raw.status
        : undefined
  if (rawStatuses !== undefined) {
    const statuses = parseTaskStatusList(rawStatuses)
    if (statuses !== null) out.statuses = statuses.join(',')
  }
  if (
    typeof raw.subject === 'string' &&
    raw.subject !== 'all' &&
    (TASK_LIST_SUBJECTS as readonly string[]).includes(raw.subject)
  ) {
    out.subject = raw.subject as Exclude<TaskListSubject, 'all'>
  }
  if (
    typeof raw.scope === 'string' &&
    (TASK_LIST_SCOPES as readonly string[]).includes(raw.scope)
  ) {
    out.scope = raw.scope as TaskListScope
  }
  if (
    typeof raw.origin === 'string' &&
    raw.origin !== 'all' &&
    (TASK_LIST_ORIGINS as readonly string[]).includes(raw.origin)
  ) {
    out.origin = raw.origin as Exclude<TaskListOrigin, 'all'>
  }
  if (
    typeof raw.category === 'string' &&
    raw.category !== 'all' &&
    (TASK_CATEGORIES as readonly string[]).includes(raw.category)
  ) {
    out.category = raw.category as Exclude<TaskCategory, 'all'>
  }
  return out
}

function taskSearchParams(search: TasksSearch): URLSearchParams {
  const params = new URLSearchParams()
  if (search.view !== undefined) params.set('view', search.view)
  if (search.q !== undefined) params.set('q', search.q)
  if (search.statuses !== undefined) params.set('statuses', search.statuses)
  if (search.subject !== undefined) params.set('subject', search.subject)
  if (search.scope !== undefined) params.set('scope', search.scope)
  if (search.origin !== undefined) params.set('origin', search.origin)
  if (search.category !== undefined) params.set('category', search.category)
  return params
}

function taskSearchParamsFromHref(href: string): URLSearchParams {
  return new URL(href, 'http://tasks.local').searchParams
}

function taskSearchFromHref(href: string): TasksSearch {
  const params = taskSearchParamsFromHref(href)
  const raw: Record<string, unknown> = {}
  for (const key of [
    'view',
    'q',
    'statuses',
    'status',
    'subject',
    'scope',
    'origin',
    'category',
  ] as const) {
    const values = params.getAll(key)
    if (values.length > 0) raw[key] = values.at(-1)
  }
  return canonicalSearch(raw)
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/tasks',
  component: TasksPageRoute,
  validateSearch: canonicalSearch,
})

function TasksPageRoute() {
  return (
    <ManagedLiveRegionProvider>
      <TasksPage />
    </ManagedLiveRegionProvider>
  )
}

interface FilterDraft {
  statuses: TaskStatus[]
  subject: TaskListSubject
  scope: TaskListScope
  origin: TaskListOrigin
  category: TaskCategory
}

function dedupeItems(pages: TaskOperationsPage[] | undefined): TaskOperationsListItem[] {
  const items: TaskOperationsListItem[] = []
  const seen = new Set<string>()
  for (const page of pages ?? []) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      items.push(item)
    }
  }
  return items
}

function TasksPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const liveRegion = useManagedLiveRegion()
  // Canonicalize only the last committed /tasks URL. During navigation,
  // state.location becomes the pending destination while this component is
  // still mounted; reading it here would treat another route's search keys
  // (for example /memory?tab=all) as invalid task filters and redirect back.
  const href = useRouterState({
    select: (state) => (state.resolvedLocation ?? state.location).href,
  })
  // Parent/root search state may retain adjacent or legacy raw keys at runtime.
  // Re-run the owned-key canonicalizer before any spread/navigation so a
  // replace can actually remove those keys instead of carrying them forward.
  const routeSearch = Route.useSearch()
  const search = useMemo(
    () => canonicalSearch(routeSearch as Record<string, unknown>),
    [routeSearch],
  )
  const actor = useActor()
  const canReadAll = usePermission('tasks:read:all')
  const canReadDigitalEmployees = usePermission('development-missions:read')
  const actorReady =
    actor.status === 'success' && actor.fetchStatus === 'idle' && actor.data !== undefined
  const defaultScope: TaskListScope = canReadAll ? 'all' : 'mine'
  const effectiveScope: TaskListScope =
    search.scope === 'all' && !canReadAll ? 'mine' : (search.scope ?? defaultScope)
  const category: TaskCategory = search.category ?? 'all'

  useEffect(() => {
    if (!actorReady || actor.data === null) return
    const hrefSearch = taskSearchFromHref(href)
    const canonical: TasksSearch = {
      ...hrefSearch,
      scope:
        hrefSearch.scope === defaultScope || (!canReadAll && hrefSearch.scope === 'all')
          ? undefined
          : hrefSearch.scope,
    }
    if (taskSearchParamsFromHref(href).toString() !== taskSearchParams(canonical).toString()) {
      void navigate({
        to: '/tasks',
        search: canonical,
        replace: true,
      })
    }
  }, [actor.data, actorReady, canReadAll, defaultScope, href, navigate])

  const statuses = useMemo(
    () => (search.statuses === undefined ? [] : (parseTaskStatusList(search.statuses) ?? [])),
    [search.statuses],
  )
  const filters = useMemo<TaskOperationsFilters>(
    () => ({
      view: search.view ?? 'all',
      ...(search.q === undefined ? {} : { q: search.q }),
      statuses,
      subject: search.subject ?? 'all',
      scope: effectiveScope,
      origin: search.origin ?? 'all',
    }),
    [effectiveScope, search.origin, search.q, search.subject, search.view, statuses],
  )
  const filterFingerprint = JSON.stringify({ filters, category })
  const taskQueryEnabled = actorReady && actor.data !== null && category !== 'digital-employee'
  const query = useTaskOperationsPage(filters, undefined, taskQueryEnabled)
  const sync = useTaskOperationsSync()
  const items = useMemo(() => dedupeItems(query.data?.pages), [query.data?.pages])
  const digitalMissions = useQuery<{ items: MissionSummary[] }>({
    queryKey: ['code-missions', 'task-operations'],
    queryFn: ({ signal }) => api.get('/api/code/missions', undefined, signal),
    enabled:
      actorReady && actor.data !== null && canReadDigitalEmployees && category !== 'orchestration',
    refetchInterval: 10_000,
  })
  const missionItems = useMemo(
    () =>
      filterDigitalEmployeeMissions(digitalMissions.data?.items ?? [], {
        view: filters.view,
        statuses: filters.statuses,
        query: filters.q,
      }),
    [digitalMissions.data?.items, filters.q, filters.statuses, filters.view],
  )
  const rootPage = query.data?.pages.find((page) => page.kind === 'root')
  const taskFacets =
    rootPage?.kind === 'root' ? rootPage.facets : { all: 0, active: 0, attention: 0, finished: 0 }
  const missionFacets = digitalEmployeeFacets(digitalMissions.data?.items ?? [])
  const facets =
    category === 'digital-employee'
      ? missionFacets
      : category === 'orchestration'
        ? taskFacets
        : {
            all: taskFacets.all + missionFacets.all,
            active: taskFacets.active + missionFacets.active,
            attention: taskFacets.attention + missionFacets.attention,
            finished: taskFacets.finished + missionFacets.finished,
          }

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    setExpanded(new Set())
    setCollapsed(new Set())
  }, [filterFingerprint])
  const toggleBranch = useCallback((id: string, currentlyOpen: boolean) => {
    if (currentlyOpen) {
      setExpanded((previous) => {
        const next = new Set(previous)
        next.delete(id)
        return next
      })
      setCollapsed((previous) => new Set(previous).add(id))
    } else {
      setCollapsed((previous) => {
        const next = new Set(previous)
        next.delete(id)
        return next
      })
      setExpanded((previous) => new Set(previous).add(id))
    }
  }, [])

  const [searchDraft, setSearchDraft] = useState(search.q ?? '')
  useEffect(() => setSearchDraft(search.q ?? ''), [search.q])
  useEffect(() => {
    const next = searchDraft.trim()
    if (next === (search.q ?? '')) return
    const timer = window.setTimeout(() => {
      void navigate({
        to: '/tasks',
        search: { ...search, q: next === '' ? undefined : next },
        replace: true,
      })
    }, 350)
    return () => window.clearTimeout(timer)
  }, [navigate, search, searchDraft])

  const searchRef = useRef<HTMLInputElement | null>(null)
  const filterButtonRef = useRef<HTMLButtonElement | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [draft, setDraft] = useState<FilterDraft>({
    statuses,
    subject: filters.subject,
    scope: filters.scope,
    origin: filters.origin,
    category,
  })
  const openFilters = () => {
    setDraft({
      statuses: filters.statuses,
      subject: filters.subject,
      scope: filters.scope,
      origin: filters.origin,
      category,
    })
    setFiltersOpen(true)
  }
  const filterDimensionCount =
    Number(filters.statuses.length > 0) +
    Number(filters.subject !== 'all') +
    Number(filters.scope !== defaultScope) +
    Number(filters.origin !== 'all') +
    Number(category !== 'all')
  const hasAnyFilter = filters.view !== 'all' || filters.q !== undefined || filterDimensionCount > 0

  const clearFilters = () => {
    setSearchDraft('')
    void navigate({ to: '/tasks', search: {} }).then(() => searchRef.current?.focus())
  }
  const applyFilters = () => {
    const canonicalStatuses = canonicalTaskStatuses(draft.statuses)
    void navigate({
      to: '/tasks',
      search: {
        ...search,
        statuses: canonicalStatuses.length === 0 ? undefined : canonicalStatuses.join(','),
        subject: draft.subject === 'all' ? undefined : draft.subject,
        scope: draft.scope === defaultScope ? undefined : draft.scope,
        origin: draft.origin === 'all' ? undefined : draft.origin,
        category: draft.category === 'all' ? undefined : draft.category,
      },
    })
    setFiltersOpen(false)
  }

  const isLoading =
    actor.isLoading ||
    (category !== 'digital-employee' && query.isLoading) ||
    (category !== 'orchestration' && canReadDigitalEmployees && digitalMissions.isLoading)
  const initialEmpty =
    !isLoading &&
    query.error == null &&
    digitalMissions.error == null &&
    items.length === 0 &&
    missionItems.length === 0 &&
    facets.all === 0 &&
    !hasAnyFilter
  const noMatches =
    !isLoading &&
    query.error == null &&
    digitalMissions.error == null &&
    items.length === 0 &&
    missionItems.length === 0 &&
    !initialEmpty
  const newTaskAction = (
    <div className="page-header__actions">
      <Link to="/tasks/new" className="btn btn--primary" data-testid="tasks-new-button">
        {t('tasks.newButton')}
      </Link>
      <Link
        to="/code/missions/new"
        className="btn btn--primary"
        data-testid="tasks-new-digital-employee"
      >
        {t('tasks.operations.newDigitalEmployee')}
      </Link>
    </div>
  )
  const previousResult = useRef<{ fingerprint: string; count: number } | null>(null)
  useEffect(() => {
    if (isLoading || query.error != null || liveRegion === null) return
    const previous = previousResult.current
    if (previous === null || previous.fingerprint !== filterFingerprint) {
      liveRegion.announce(
        t('tasks.operations.resultCount', { count: items.length + missionItems.length }),
      )
    } else if (items.length + missionItems.length > previous.count) {
      liveRegion.announce(
        t('tasks.operations.addedCount', {
          count: items.length + missionItems.length - previous.count,
        }),
      )
    }
    previousResult.current = {
      fingerprint: filterFingerprint,
      count: items.length + missionItems.length,
    }
  }, [filterFingerprint, isLoading, items.length, liveRegion, missionItems.length, query.error, t])

  return (
    <div className="page page--operations page--task-operations">
      <FeedbackStack variant="section">
        {sync.dirty && (
          <NoticeBanner
            tone="info"
            size="compact"
            testid="tasks-dirty-banner"
            action={
              <button type="button" className="btn btn--sm" onClick={() => void sync.refresh()}>
                {t('tasks.operations.refresh')}
              </button>
            }
          >
            {t('tasks.operations.updated')}
          </NoticeBanner>
        )}
      </FeedbackStack>

      <div className="operations-surface">
        <PageHeader
          title={t('tasks.title')}
          actions={initialEmpty ? undefined : newTaskAction}
          className="operations-surface__header"
        >
          <p className="operations-surface__subtitle">{t('tasks.operations.subtitle')}</p>
        </PageHeader>

        {!initialEmpty && (
          <OperationsToolbar<TaskListView>
            view={filters.view}
            onViewChange={(view) =>
              void navigate({
                to: '/tasks',
                search: { ...search, view: view === 'all' ? undefined : view },
              })
            }
            views={TASK_LIST_VIEWS.map((view) => ({
              value: view,
              label: t(`tasks.operations.views.${view}`),
              count: facets[view],
            }))}
            viewAria={t('tasks.operations.viewAria')}
            searchValue={searchDraft}
            onSearchChange={setSearchDraft}
            searchPlaceholder={t('tasks.operations.searchPlaceholder')}
            searchLabel={t('tasks.operations.searchLabel')}
            filterLabel={t('tasks.operations.filters')}
            activeFilterCount={filterDimensionCount}
            activeFiltersLabel={(count) => t('tasks.operations.activeFilters', { count })}
            onOpenFilters={openFilters}
            showClear={hasAnyFilter}
            clearLabel={t('common.clearFilters')}
            onClear={clearFilters}
            testidPrefix="tasks"
            disabled={isLoading}
            searchRef={searchRef}
            filterButtonRef={filterButtonRef}
          />
        )}

        <FeedbackStack variant="section">
          {query.error != null && (
            <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
          )}
          {digitalMissions.error != null && category !== 'orchestration' && (
            <ErrorBanner
              error={digitalMissions.error}
              onRetry={() => void digitalMissions.refetch()}
            />
          )}
        </FeedbackStack>
        {isLoading && <LoadingState data-testid="tasks-loading" />}
        {initialEmpty && (
          <EmptyState
            title={t('tasks.emptyList')}
            description={t('tasks.emptyDescription')}
            icon={TASK_ICON}
            action={newTaskAction}
            data-testid="tasks-empty"
          />
        )}
        {noMatches && (
          <EmptyState
            size="compact"
            title={t('common.noMatches')}
            action={
              <button type="button" className="btn btn--sm" onClick={clearFilters}>
                {t('common.clearFilters')}
              </button>
            }
            data-testid="tasks-no-matches"
          />
        )}

        {missionItems.length > 0 && category !== 'orchestration' && (
          <DigitalEmployeeTaskList items={missionItems} />
        )}

        {items.length > 0 && category !== 'digital-employee' && (
          <TaskOperationsList
            items={items}
            filters={filters}
            scrollResetKey={filterFingerprint}
            expanded={expanded}
            collapsed={collapsed}
            onToggle={toggleBranch}
            onLoadMore={() => void query.fetchNextPage()}
            hasNextPage={query.hasNextPage}
            loadingMore={query.isFetchingNextPage}
          />
        )}
      </div>

      <TaskListFilterDialog
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        triggerRef={filterButtonRef}
        draft={draft}
        onChange={setDraft}
        canReadAll={canReadAll}
        onApply={applyFilters}
        onClear={() =>
          setDraft({
            statuses: [],
            subject: 'all',
            scope: defaultScope,
            origin: 'all',
            category: 'all',
          })
        }
      />
    </div>
  )
}

function TaskListFilterDialog(props: {
  open: boolean
  onClose: () => void
  triggerRef: React.RefObject<HTMLButtonElement | null>
  draft: FilterDraft
  onChange: (draft: FilterDraft) => void
  canReadAll: boolean
  onApply: () => void
  onClear: () => void
}) {
  const { t } = useTranslation()
  const statusOptions = TASK_STATUS.map((status) => ({
    value: status,
    label: t(`tasks.status.${status}`),
  }))
  const scopeOptions = (props.canReadAll ? TASK_LIST_SCOPES : ['mine', 'shared']).map((scope) => ({
    value: scope as TaskListScope,
    label: t(`tasks.operations.scope.${scope}`),
  }))
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t('tasks.operations.filterTitle')}
      size="md"
      triggerRef={props.triggerRef}
      data-testid="tasks-filter-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClear}>
            {t('common.clearFilters')}
          </button>
          <button type="button" className="btn btn--primary" onClick={props.onApply}>
            {t('tasks.operations.applyFilters')}
          </button>
        </>
      }
    >
      <div className="form-grid task-list-filter-dialog">
        <Field label={t('tasks.operations.categoryLabel')} group>
          <Segmented<TaskCategory>
            value={props.draft.category}
            onChange={(category) => props.onChange({ ...props.draft, category })}
            ariaLabel={t('tasks.operations.categoryLabel')}
            options={TASK_CATEGORIES.map((category) => ({
              value: category,
              label: t(`tasks.operations.category.${category}`),
            }))}
          />
        </Field>
        <Field label={t('tasks.operations.statuses')} group>
          <MultiSelect
            value={props.draft.statuses}
            onChange={(values) =>
              props.onChange({ ...props.draft, statuses: values as TaskStatus[] })
            }
            options={statusOptions}
            ariaLabel={t('tasks.operations.statuses')}
            allowCustom={false}
            openOnFocus={false}
            placeholder={t('tasks.operations.statusPlaceholder')}
            data-testid="tasks-status-filter"
          />
        </Field>
        <Field label={t('tasks.colSubject')} group>
          <Segmented<TaskListSubject>
            value={props.draft.subject}
            onChange={(subject) => props.onChange({ ...props.draft, subject })}
            ariaLabel={t('tasks.colSubject')}
            options={TASK_LIST_SUBJECTS.map((subject) => ({
              value: subject,
              label: t(`tasks.subjectFilter.${subject}`),
            }))}
          />
        </Field>
        <Field label={t('tasks.operations.scopeLabel')} group>
          <Segmented<TaskListScope>
            value={props.draft.scope}
            onChange={(scope) => props.onChange({ ...props.draft, scope })}
            ariaLabel={t('tasks.operations.scopeLabel')}
            options={scopeOptions}
          />
        </Field>
        <Field label={t('tasks.operations.originLabel')} group>
          <Segmented<TaskListOrigin>
            value={props.draft.origin}
            onChange={(origin) => props.onChange({ ...props.draft, origin })}
            ariaLabel={t('tasks.operations.originLabel')}
            options={TASK_LIST_ORIGINS.map((origin) => ({
              value: origin,
              label: t(`tasks.operations.origin.${origin}`),
            }))}
          />
        </Field>
      </div>
    </Dialog>
  )
}

function digitalEmployeeTaskStatus(status: string): TaskStatus {
  if (status === 'admitting') return 'pending'
  if (status === 'awaiting-information') return 'awaiting_human'
  if (status === 'ready-to-merge' || status === 'waiting-committer') return 'awaiting_review'
  if (status === 'merged' || status === 'completed-no-change') return 'done'
  if (status === 'closed-unmerged' || status === 'canceled') return 'canceled'
  if (status === 'blocked' || status === 'failed') return 'failed'
  return 'running'
}

function filterDigitalEmployeeMissions(
  missions: MissionSummary[],
  filters: { view: TaskListView; statuses: TaskStatus[]; query?: string },
): MissionSummary[] {
  const query = filters.query?.toLocaleLowerCase('en-US')
  return missions.filter((mission) => {
    const status = digitalEmployeeTaskStatus(mission.status)
    if (filters.statuses.length > 0 && !filters.statuses.includes(status)) return false
    if (!taskMatchesListView(filters.view, status)) return false
    if (query === undefined) return true
    return [
      mission.id,
      mission.repositoryId,
      mission.externalId ?? '',
      mission.blockCode ?? '',
      mission.employeeId ?? '',
    ].some((value) => value.toLocaleLowerCase('en-US').includes(query))
  })
}

function digitalEmployeeFacets(missions: MissionSummary[]): {
  all: number
  active: number
  attention: number
  finished: number
} {
  const statuses = missions.map((mission) => digitalEmployeeTaskStatus(mission.status))
  return {
    all: statuses.length,
    active: statuses.filter((status) => taskMatchesListView('active', status)).length,
    attention: statuses.filter((status) => taskMatchesListView('attention', status)).length,
    finished: statuses.filter((status) => taskMatchesListView('finished', status)).length,
  }
}

function DigitalEmployeeTaskList(props: { items: MissionSummary[] }): ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <section
      className="task-operations task-operations--digital-employee"
      aria-label={t('tasks.operations.digitalEmployeeSection')}
      data-testid="digital-employee-task-list"
    >
      <div className="task-operations__section-title">
        <strong>{t('tasks.operations.digitalEmployeeSection')}</strong>
        <span>{t('tasks.operations.digitalEmployeeSectionHint')}</span>
      </div>
      <div className="task-operations__head" aria-hidden="true">
        <span>{t('tasks.operations.columns.task')}</span>
        <span>{t('tasks.operations.columns.execution')}</span>
        <span>{t('tasks.operations.columns.time')}</span>
        <span>{t('acl.owner')}</span>
        <span />
      </div>
      <div className="task-operations__list" role="list">
        {props.items.map((mission) => (
          <div
            key={mission.id}
            role="listitem"
            className="task-operations__row"
            data-testid={`digital-employee-task-${mission.id}`}
            onClick={(event) => {
              if (shouldRowNavigate(event)) {
                void navigate({
                  to: '/code/missions/$missionId',
                  params: { missionId: mission.id },
                })
              }
            }}
          >
            <div className="task-operations__cell task-operations__task">
              <span className="task-operations__expand-spacer" aria-hidden="true" />
              <div className="task-operations__task-copy">
                <div className="task-operations__name-line">
                  <Link
                    to="/code/missions/$missionId"
                    params={{ missionId: mission.id }}
                    className="data-table__link task-operations__name"
                  >
                    {mission.externalId ?? t('tasks.operations.digitalEmployeeTask')}
                  </Link>
                  <StatusChip kind="info" size="sm">
                    {t('tasks.operations.category.digital-employee')}
                  </StatusChip>
                </div>
                <div className="task-operations__meta">
                  <code>{mission.repositoryId}</code>
                  <span aria-hidden="true">·</span>
                  <code>{mission.id.slice(-8)}</code>
                </div>
              </div>
            </div>
            <div className="task-operations__cell task-operations__execution">
              <StatusChip kind={missionStatusKind(mission.status)} size="sm">
                {missionStatusLabel(t, mission.status)}
              </StatusChip>
              {mission.blockCode === null ? null : <small>{mission.blockCode}</small>}
            </div>
            <div className="task-operations__cell task-operations__time">
              <RelativeTime ts={mission.updatedAt} />
            </div>
            <div className="task-operations__cell task-operations__owner">
              {t('tasks.operations.digitalEmployeeOwner')}
            </div>
            <div className="task-operations__cell task-operations__chevron" aria-hidden="true">
              <OperationsChevronIcon />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function TaskOperationsList(props: {
  items: TaskOperationsListItem[]
  filters: TaskOperationsFilters
  /** Changes only when the result set's filter identity changes. */
  scrollResetKey: string
  expanded: ReadonlySet<string>
  collapsed: ReadonlySet<string>
  onToggle: (id: string, currentlyOpen: boolean) => void
  onLoadMore: () => void
  hasNextPage: boolean
  loadingMore: boolean
}) {
  const { t } = useTranslation()
  // RFC-311 (audit L5/P0-1/P0-3): the root level is windowed — 2000 accumulated
  // roots used to render ~80k DOM nodes with a 30s clock tick re-rendering all
  // of them each beat. Each virtual row is one root branch (its expanded
  // subtree included, measured dynamically), so off-screen rows mount nothing
  // and their tick subscriptions vanish with them. Scrolling near the end
  // auto-fetches the next page; the button stays as fallback + a11y target.
  const { hasNextPage, loadingMore, onLoadMore } = props
  const reachEnd = useCallback(() => {
    if (hasNextPage && !loadingMore) onLoadMore()
  }, [hasNextPage, loadingMore, onLoadMore])
  return (
    <section
      className="task-operations"
      aria-label={t('tasks.title')}
      aria-busy={props.loadingMore || undefined}
    >
      <div className="task-operations__head" aria-hidden="true">
        <span>{t('tasks.operations.columns.task')}</span>
        <span>{t('tasks.operations.columns.execution')}</span>
        <span>{t('tasks.operations.columns.time')}</span>
        <span>{t('acl.owner')}</span>
        <span />
      </div>
      <VirtualList<TaskOperationsListItem>
        items={props.items}
        itemKey={(item) => item.id}
        estimateSize={73}
        scrollResetKey={props.scrollResetKey}
        onReachEnd={reachEnd}
        containerProps={{
          className: 'task-operations__list',
          role: 'list',
          'aria-label': t('tasks.title'),
          'data-testid': 'task-operations-list',
        }}
        renderItem={(item, index) => (
          <TaskBranch
            item={item}
            depth={0}
            filters={props.filters}
            expanded={props.expanded}
            collapsed={props.collapsed}
            onToggle={props.onToggle}
            ariaSetsize={props.items.length}
            ariaPosinset={index + 1}
          />
        )}
        tail={
          props.hasNextPage ? (
            <div className="task-operations__more" role="presentation">
              {/* RFC-311：可及名固定、且**不 disabled**。距底 400px 的滚动哨兵会在
                  用户/浏览器把本按钮滚进视口时先一步触发翻页，若此刻改文案或禁用，
                  按名字拿到的句柄当场失配（webkit e2e 症状是 element detached 活锁），
                  键盘焦点也会被弹走。加载态改由 aria-busy + 旁白承载。 */}
              <button
                type="button"
                className="btn btn--sm"
                aria-busy={props.loadingMore || undefined}
                onClick={() => {
                  if (!props.loadingMore) props.onLoadMore()
                }}
              >
                {t('tasks.operations.loadMore')}
              </button>
              {props.loadingMore ? (
                <span role="status" className="muted">
                  {t('tasks.operations.loadingMore')}
                </span>
              ) : null}
            </div>
          ) : undefined
        }
      />
    </section>
  )
}

interface TaskBranchProps {
  item: TaskOperationsListItem
  depth: number
  filters: TaskOperationsFilters
  expanded: ReadonlySet<string>
  collapsed: ReadonlySet<string>
  onToggle: (id: string, currentlyOpen: boolean) => void
  /** RFC-311:窗口化后 DOM 里只有可视行,屏幕阅读器无法自行数出总量/位次。
   *  这两个值由 VirtualList 的调用点传入,挂在**本行自己的** role="listitem"
   *  元素上(挂在无 role 的定位包装上会触发 axe aria-allowed-attr)。 */
  ariaSetsize?: number
  ariaPosinset?: number
}

function TaskBranch(props: TaskBranchProps) {
  const { item } = props
  const hasChildren = item.listContext.qualifyingChildCount > 0
  const autoExpanded = item.listContext.matchKind === 'context' && !props.collapsed.has(item.id)
  const isExpanded = hasChildren && (props.expanded.has(item.id) || autoExpanded)
  const branchId = `task-children-${encodeURIComponent(item.id).replaceAll('%', '_')}`
  // RFC-311: list/listitem roles are explicit — the root level lives inside
  // the VirtualList's positioning wrapper (a role-neutral div between the
  // role="list" scroller and these rows), where literal <ol>/<li> nesting
  // would be invalid HTML. Child levels reuse the same shape for symmetry.
  return (
    <div
      role="listitem"
      className={
        props.depth === 0
          ? 'task-operations__item task-operations__item--root'
          : 'task-operations__item'
      }
      style={{ '--task-tree-depth': props.depth } as CSSProperties}
      data-depth={props.depth}
      aria-setsize={props.ariaSetsize}
      aria-posinset={props.ariaPosinset}
    >
      <TaskOperationsRow
        item={item}
        depth={props.depth}
        branchId={hasChildren ? branchId : undefined}
        expanded={isExpanded}
        onToggle={() => props.onToggle(item.id, isExpanded)}
      />
      {hasChildren && (
        <div
          role="list"
          id={branchId}
          className="task-operations__children"
          aria-label={`${item.name}`}
          hidden={!isExpanded}
        >
          {isExpanded && (
            <TaskChildren
              parent={item}
              depth={props.depth + 1}
              filters={props.filters}
              expanded={props.expanded}
              collapsed={props.collapsed}
              onToggle={props.onToggle}
            />
          )}
        </div>
      )}
    </div>
  )
}

function TaskChildren(props: Omit<TaskBranchProps, 'item'> & { parent: TaskOperationsListItem }) {
  const { t } = useTranslation()
  const liveRegion = useManagedLiveRegion()
  const query = useTaskOperationsPage(props.filters, props.parent.id)
  const items = useMemo(() => dedupeItems(query.data?.pages), [query.data?.pages])
  const childFingerprint = `${props.parent.id}:${JSON.stringify(props.filters)}`
  const previousPage = useRef<{ fingerprint: string; pages: number; count: number } | null>(null)
  useEffect(() => {
    const pages = query.data?.pages.length ?? 0
    if (pages === 0) return
    const previous = previousPage.current
    if (
      previous !== null &&
      previous.fingerprint === childFingerprint &&
      pages > previous.pages &&
      items.length > previous.count
    ) {
      liveRegion?.announce(
        t('tasks.operations.addedChildrenCount', { count: items.length - previous.count }),
      )
    }
    previousPage.current = { fingerprint: childFingerprint, pages, count: items.length }
  }, [childFingerprint, items.length, liveRegion, query.data?.pages.length, t])

  if (query.isLoading) {
    return (
      <div
        role="listitem"
        className="task-operations__branch-state"
        data-testid={`task-children-loading-${props.parent.id}`}
      >
        <LoadingState size="compact" />
      </div>
    )
  }
  if (query.error != null && items.length === 0) {
    return (
      <div
        role="listitem"
        className="task-operations__branch-state"
        data-testid={`task-children-error-${props.parent.id}`}
      >
        <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
      </div>
    )
  }
  if (items.length === 0) {
    return (
      <div
        role="listitem"
        className="task-operations__branch-state"
        data-testid={`task-children-empty-${props.parent.id}`}
      >
        {t('tasks.noChildTasks')}
      </div>
    )
  }
  return (
    <>
      {query.error != null && (
        <div role="listitem" className="task-operations__branch-state">
          <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
        </div>
      )}
      {items.map((item) => (
        <TaskBranch key={item.id} item={item} {...props} />
      ))}
      {query.hasNextPage && (
        <div role="listitem" className="task-operations__more task-operations__more--child">
          {/* 同根列表：名字固定 + 不 disabled，见 RFC-311 的注记。 */}
          <button
            type="button"
            className="btn btn--sm"
            aria-busy={query.isFetchingNextPage || undefined}
            onClick={() => {
              if (!query.isFetchingNextPage) void query.fetchNextPage()
            }}
          >
            {t('tasks.operations.loadMoreChildren')}
          </button>
          {query.isFetchingNextPage ? (
            <span role="status" className="muted">
              {t('tasks.operations.loadingMoreChildren')}
            </span>
          ) : null}
        </div>
      )}
    </>
  )
}

function TaskOperationsRow(props: {
  item: TaskOperationsListItem
  depth: number
  branchId?: string
  expanded: boolean
  onToggle: () => void
}) {
  const { item } = props
  const { t } = useTranslation()
  const navigate = useNavigate()
  const now = useNowTick()
  const repo = taskRepoDisplayName(item)
  const duration = taskOperationsDuration(item, now)
  const durationText =
    duration.kind === 'dash'
      ? t('common.emDash')
      : t(`tasks.operations.duration.${duration.kind}`, {
          dur: t(`common.dur.${duration.dur.key}`, duration.dur.opts),
        })
  const detail = executionDetail(item, t)

  return (
    <div
      className={`task-operations__row${props.depth > 0 ? ' task-operations__row--child' : ''}`}
      data-testid={`task-row-${item.id}`}
      onClick={(event) => {
        if (shouldRowNavigate(event)) {
          void navigate({ to: '/tasks/$id', params: { id: item.id } })
        }
      }}
    >
      <div className="task-operations__cell task-operations__task">
        <span className="sr-only">{t('tasks.operations.columns.task')}：</span>
        <div className="task-operations__task-main">
          {props.branchId === undefined ? (
            <span className="task-operations__expand-spacer" aria-hidden="true" />
          ) : (
            <OperationsExpandButton
              expanded={props.expanded}
              controls={props.branchId}
              label={t(props.expanded ? 'tasks.collapseChildren' : 'tasks.expandChildrenCount', {
                count: item.listContext.qualifyingChildCount,
              })}
              testid={`task-expand-${item.id}`}
              onToggle={props.onToggle}
            />
          )}
          <div className="task-operations__task-copy">
            <div className="task-operations__name-line">
              <Link
                to="/tasks/$id"
                params={{ id: item.id }}
                className="data-table__link task-operations__name"
                title={item.name}
              >
                {item.name}
              </Link>
              {item.childCount > 0 && (
                <span className="task-operations__child-count">
                  {t('tasks.operations.childCount', { count: item.childCount })}
                </span>
              )}
              {item.listContext.parentAvailability === 'unavailable' && (
                <span
                  className="chip chip--tight"
                  data-testid={`task-parent-unavailable-${item.id}`}
                >
                  {t('tasks.parentTaskUnavailable')}
                </span>
              )}
            </div>
            <div className="task-operations__meta">
              <TaskSubjectLink task={item} taskId={item.id} badge />
              <span className="task-operations__repo-separator" aria-hidden="true">
                ·
              </span>
              <code className="task-operations__repo" title={repo.title}>
                {repo.name}
              </code>
              {item.repoCount > 1 && (
                <span
                  className="chip chip--tight task-operations__repo-count"
                  data-testid={`task-repos-${item.id}`}
                >
                  {t('tasks.repoCountChip', { n: item.repoCount })}
                </span>
              )}
              {item.scheduledTaskId != null && (
                <Link
                  to="/scheduled/$id"
                  params={{ id: item.scheduledTaskId }}
                  className="task-operations__meta-link"
                  data-testid={`task-scheduled-chip-${item.id}`}
                >
                  {t('tasks.scheduledChip')}
                </Link>
              )}
              <span aria-hidden="true">·</span>
              <code className="task-operations__id" title={item.id}>
                {item.id.slice(-8)}
              </code>
            </div>
          </div>
        </div>
      </div>

      <div className="task-operations__cell task-operations__execution">
        <span className="sr-only">{t('tasks.operations.columns.execution')}：</span>
        <div className="task-operations__status-line">
          <TaskStatusChip status={item.status} pulse={item.status === 'running'} />
          {(item.openAlertCount ?? 0) > 0 && (
            <StatusChip kind="warn" size="sm">
              {t('tasks.stuckBadge', { count: item.openAlertCount })}
            </StatusChip>
          )}
        </div>
        <span className="task-operations__detail" title={detail.title}>
          {detail.text}
        </span>
      </div>

      <div className="task-operations__cell task-operations__time">
        <span className="sr-only">{t('tasks.operations.columns.time')}：</span>
        <RelativeTime ts={item.startedAt} />
        <span className="task-operations__duration">{durationText}</span>
      </div>

      <div className="task-operations__cell task-operations__owner">
        <span className="sr-only">{t('acl.owner')}：</span>
        <OwnerLabel ownerUserId={item.ownerUserId} owner={item.owner} wrap />
      </div>

      <div className="task-operations__nav" aria-hidden="true">
        <OperationsChevronIcon />
      </div>
    </div>
  )
}

function executionDetail(
  item: TaskOperationsListItem,
  t: (key: string, options?: Record<string, unknown>) => string,
): { text: string; title?: string } {
  if ((item.openAlertCount ?? 0) > 0) {
    return { text: t('tasks.operations.openAlertDetail', { count: item.openAlertCount }) }
  }
  if (item.status === 'failed') {
    const failure = describeTaskFailure({
      failureCode: item.failureCode ?? null,
      errorSummary: item.errorSummary,
    })
    return { text: failure.title, title: item.errorSummary ?? failure.title }
  }
  if (item.listContext.matchKind === 'context') {
    return {
      text: t('tasks.operations.contextMatches', {
        count: item.listContext.matchingDescendantCount,
      }),
    }
  }
  if (item.status === 'awaiting_review') return { text: t('tasks.operations.awaitingReview') }
  if (item.status === 'awaiting_human') return { text: t('tasks.operations.awaitingHuman') }
  if (item.status === 'pending') return { text: t('tasks.operations.pendingDetail') }
  if (item.status === 'running') return { text: t('tasks.operations.runningDetail') }
  return { text: t('tasks.operations.finishedDetail') }
}

// Retained as a small named seam for duration source locks and component tests.
export function taskOperationsDurationText(
  item: TaskOperationsListItem,
  now: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): ReactNode {
  const duration = taskOperationsDuration(item, now)
  if (duration.kind === 'dash') return t('common.emDash')
  return t(`tasks.operations.duration.${duration.kind}`, {
    dur: t(`common.dur.${duration.dur.key}`, duration.dur.opts),
  })
}
