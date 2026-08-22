// RFC-244 — high-density task operations list.

import {
  TASK_LIST_VISIBLE_ORIGINS,
  TASK_LIST_SCOPES,
  TASK_LIST_VIEWS,
  TASK_SOURCE_REGISTRATIONS,
  TASK_STATUS,
  canonicalTaskStatuses,
  isTaskSourceId,
  parseTaskStatusList,
  taskSourceRegistration,
  type TaskListOrigin,
  type TaskListScope,
  type TaskListView,
  type TaskCatalogListItem,
  type TaskCatalogPage,
  type TaskOperationsFilters,
  type TaskOperationsListItem,
  type TaskSourceId,
  type TaskStatus,
} from '@agent-workflow/shared'
import { Link, createRoute, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/Dialog'
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
import { TASK_ICON } from '@/components/icons/resourceIcons'
import { localized } from '@/components/digital-employees/types'
import { useActor, useCurrentPermissions, usePermission } from '@/hooks/useActor'
import { useNowTick } from '@/hooks/useNowTick'
import { useTaskOperationsPage } from '@/hooks/useTaskOperationsPage'
import { useTaskOperationsSync } from '@/hooks/useTaskOperationsSync'
import { shouldRowNavigate } from '@/lib/row-nav'
import { taskOperationsDuration } from '@/lib/task-operations-duration'
import { describeTaskFailure } from '@/lib/task-failure'
import { Route as RootRoute } from './__root'

type TaskType = 'all' | TaskSourceId
const TASK_TYPES = [
  'all',
  ...TASK_SOURCE_REGISTRATIONS.map((source) => source.id),
] as const satisfies readonly TaskType[]

interface TasksSearch {
  view?: Exclude<TaskListView, 'all'>
  q?: string
  statuses?: string
  type?: TaskSourceId
  scope?: TaskListScope
  origin?: Exclude<TaskListOrigin, 'all'>
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
  if (isTaskSourceId(raw.type)) out.type = raw.type
  if (
    typeof raw.scope === 'string' &&
    (TASK_LIST_SCOPES as readonly string[]).includes(raw.scope)
  ) {
    out.scope = raw.scope as TaskListScope
  }
  if (
    typeof raw.origin === 'string' &&
    raw.origin !== 'all' &&
    (TASK_LIST_VISIBLE_ORIGINS as readonly string[]).includes(raw.origin)
  ) {
    out.origin = raw.origin as Exclude<TaskListOrigin, 'all'>
  }
  return out
}

function taskSearchParams(search: TasksSearch): URLSearchParams {
  const params = new URLSearchParams()
  if (search.view !== undefined) params.set('view', search.view)
  if (search.q !== undefined) params.set('q', search.q)
  if (search.statuses !== undefined) params.set('statuses', search.statuses)
  if (search.type !== undefined) params.set('type', search.type)
  if (search.scope !== undefined) params.set('scope', search.scope)
  if (search.origin !== undefined) params.set('origin', search.origin)
  return params
}

function taskSearchParamsFromHref(href: string): URLSearchParams {
  return new URL(href, 'http://tasks.local').searchParams
}

function taskSearchFromHref(href: string): TasksSearch {
  const params = taskSearchParamsFromHref(href)
  const raw: Record<string, unknown> = {}
  for (const key of ['view', 'q', 'statuses', 'status', 'type', 'scope', 'origin'] as const) {
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
  type: TaskType
  scope: TaskListScope
  origin: TaskListOrigin
}

function dedupeItems(pages: TaskCatalogPage[] | undefined): TaskCatalogListItem[] {
  const items: TaskCatalogListItem[] = []
  const seen = new Set<string>()
  for (const page of pages ?? []) {
    for (const item of page.items) {
      const key = taskCatalogItemKey(item)
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item)
    }
  }
  return items
}

function taskCatalogItemKey(item: Pick<TaskCatalogListItem, 'sourceId' | 'id'>): string {
  return `${item.sourceId}:${item.id}`
}

const EMPTY_FACETS = { all: 0, active: 0, attention: 0, finished: 0 } as const

function TasksPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
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
  const permissions = useCurrentPermissions()
  const canReadAll = usePermission('tasks:read:all')
  const actorReady =
    actor.status === 'success' &&
    actor.fetchStatus === 'idle' &&
    actor.data !== undefined &&
    actor.data !== null
  const defaultScope: TaskListScope = canReadAll ? 'all' : 'mine'
  const effectiveScope: TaskListScope =
    search.scope === 'all' && !canReadAll ? 'mine' : (search.scope ?? defaultScope)
  const selectedSource = search.type === undefined ? null : taskSourceRegistration(search.type)

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
      scope: effectiveScope,
      origin: search.origin ?? 'all',
      subject: 'all',
    }),
    [effectiveScope, search.origin, search.q, search.view, statuses],
  )
  const filterFingerprint = JSON.stringify({ filters, source: selectedSource?.id ?? 'all' })

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
    type: selectedSource?.id ?? 'all',
    scope: filters.scope,
    origin: filters.origin,
  })
  const openFilters = () => {
    setDraft({
      statuses: [...filters.statuses],
      type: selectedSource?.id ?? 'all',
      scope: filters.scope,
      origin: filters.origin,
    })
    setFiltersOpen(true)
  }
  const filterDimensionCount =
    Number(filters.statuses.length > 0) +
    Number(selectedSource !== null) +
    Number(filters.scope !== defaultScope) +
    Number(filters.origin !== 'all')
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
        type: draft.type === 'all' ? undefined : draft.type,
        scope: draft.scope === defaultScope ? undefined : draft.scope,
        origin: draft.origin === 'all' ? undefined : draft.origin,
      },
    })
    setFiltersOpen(false)
  }

  const sourceReadable =
    selectedSource === null
      ? TASK_SOURCE_REGISTRATIONS.some((source) => permissions.has(source.list.requiredPermission))
      : permissions.has(selectedSource.list.requiredPermission)
  const query = useTaskOperationsPage(
    filters,
    undefined,
    actorReady && sourceReadable,
    selectedSource?.id,
  )
  const items = useMemo(() => dedupeItems(query.data?.pages), [query.data?.pages])
  const facets = query.data?.pages[0]?.facets ?? EMPTY_FACETS
  const sync = useTaskOperationsSync()
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
      return
    }
    setCollapsed((previous) => {
      const next = new Set(previous)
      next.delete(id)
      return next
    })
    setExpanded((previous) => new Set(previous).add(id))
  }, [])

  return (
    <>
      <RegisteredTasksSurface
        items={items}
        facets={facets}
        actorLoading={actor.isLoading}
        isLoading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        feedback={
          sync.dirty ? (
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
          ) : null
        }
        filters={filters}
        sourceId={selectedSource?.id}
        search={search}
        searchDraft={searchDraft}
        setSearchDraft={setSearchDraft}
        filterDimensionCount={filterDimensionCount}
        hasAnyFilter={hasAnyFilter}
        filterFingerprint={filterFingerprint}
        openFilters={openFilters}
        clearFilters={clearFilters}
        searchRef={searchRef}
        filterButtonRef={filterButtonRef}
        expanded={expanded}
        collapsed={collapsed}
        onToggle={toggleBranch}
        onLoadMore={() => void query.fetchNextPage()}
        hasNextPage={query.hasNextPage}
        loadingMore={query.isFetchingNextPage}
      />
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
            type: 'all',
            scope: defaultScope,
            origin: 'all',
          })
        }
      />
    </>
  )
}

function RegisteredTasksSurface(props: {
  items: readonly TaskCatalogListItem[]
  facets: TaskCatalogPage['facets']
  actorLoading: boolean
  isLoading: boolean
  error: unknown
  onRetry: () => void
  feedback: ReactNode
  filters: TaskOperationsFilters
  sourceId?: TaskSourceId
  search: TasksSearch
  searchDraft: string
  setSearchDraft: (value: string) => void
  filterDimensionCount: number
  hasAnyFilter: boolean
  filterFingerprint: string
  openFilters: () => void
  clearFilters: () => void
  searchRef: React.RefObject<HTMLInputElement | null>
  filterButtonRef: React.RefObject<HTMLButtonElement | null>
  expanded: ReadonlySet<string>
  collapsed: ReadonlySet<string>
  onToggle: (id: string, currentlyOpen: boolean) => void
  onLoadMore: () => void
  hasNextPage: boolean
  loadingMore: boolean
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const liveRegion = useManagedLiveRegion()
  const facets = props.facets
  const itemCount = props.items.length
  const isLoading = props.actorLoading || props.isLoading
  const hasError = props.error != null
  const initialEmpty =
    !isLoading && !hasError && itemCount === 0 && facets.all === 0 && !props.hasAnyFilter
  const noMatches = !isLoading && !hasError && itemCount === 0 && !initialEmpty
  const newTaskAction = (
    <Link to="/tasks/new" className="btn btn--primary" data-testid="tasks-new-button">
      {t('tasks.newButton')}
    </Link>
  )
  const previousResult = useRef<{ fingerprint: string; count: number } | null>(null)
  useEffect(() => {
    if (isLoading || hasError || liveRegion === null) return
    const previous = previousResult.current
    if (previous === null || previous.fingerprint !== props.filterFingerprint) {
      liveRegion.announce(t('tasks.operations.resultCount', { count: itemCount }))
    } else if (itemCount > previous.count) {
      liveRegion.announce(t('tasks.operations.addedCount', { count: itemCount - previous.count }))
    }
    previousResult.current = { fingerprint: props.filterFingerprint, count: itemCount }
  }, [hasError, isLoading, itemCount, liveRegion, props.filterFingerprint, t])

  return (
    <div className="page page--operations page--task-operations">
      <FeedbackStack variant="section">{props.feedback}</FeedbackStack>
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
            view={props.filters.view}
            onViewChange={(view) =>
              void navigate({
                to: '/tasks',
                search: { ...props.search, view: view === 'all' ? undefined : view },
              })
            }
            views={TASK_LIST_VIEWS.map((view) => ({
              value: view,
              label: t(`tasks.operations.views.${view}`),
              count: facets[view],
            }))}
            viewAria={t('tasks.operations.viewAria')}
            searchValue={props.searchDraft}
            onSearchChange={props.setSearchDraft}
            searchPlaceholder={t('tasks.operations.searchPlaceholder')}
            searchLabel={t('tasks.operations.searchLabel')}
            filterLabel={t('tasks.operations.filters')}
            activeFilterCount={props.filterDimensionCount}
            activeFiltersLabel={(count) => t('tasks.operations.activeFilters', { count })}
            onOpenFilters={props.openFilters}
            showClear={props.hasAnyFilter}
            clearLabel={t('common.clearFilters')}
            onClear={props.clearFilters}
            testidPrefix="tasks"
            busy={isLoading}
            searchRef={props.searchRef}
            filterButtonRef={props.filterButtonRef}
          />
        )}
        <FeedbackStack variant="section">
          {hasError ? <ErrorBanner error={props.error} onRetry={props.onRetry} /> : null}
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
              <button type="button" className="btn btn--sm" onClick={props.clearFilters}>
                {t('common.clearFilters')}
              </button>
            }
            data-testid="tasks-no-matches"
          />
        )}
        {props.items.length > 0 ? (
          <TaskOperationsList
            items={[...props.items]}
            filters={props.filters}
            sourceId={props.sourceId}
            scrollResetKey={props.filterFingerprint}
            expanded={props.expanded}
            collapsed={props.collapsed}
            onToggle={props.onToggle}
            onLoadMore={props.onLoadMore}
            hasNextPage={props.hasNextPage}
            loadingMore={props.loadingMore}
          />
        ) : null}
      </div>
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
          <Segmented<TaskType>
            value={props.draft.type}
            onChange={(taskType) => props.onChange({ ...props.draft, type: taskType })}
            ariaLabel={t('tasks.operations.categoryLabel')}
            options={TASK_TYPES.map((taskType) => ({
              value: taskType,
              label:
                taskType === 'all'
                  ? t('tasks.operations.category.all')
                  : t(taskSourceRegistration(taskType).labelKey),
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
            options={TASK_LIST_VISIBLE_ORIGINS.map((origin) => ({
              value: origin,
              label: t(`tasks.operations.origin.${origin}`),
            }))}
          />
        </Field>
      </div>
    </Dialog>
  )
}

function TaskOperationsList(props: {
  items: TaskCatalogListItem[]
  filters: TaskOperationsFilters
  sourceId?: TaskSourceId
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
  // RFC-311：**显式的翻页按钮在场时，不再挂滚动哨兵**。两者写的是同一份状态，
  // 会互相抢：为了点按钮而把它滚进视口，那一下就触发了哨兵，最后一页到达后
  // `hasNextPage` 转 false，按钮在指针底下**合法卸载**——webkit e2e 上稳定复现为
  // `element was detached from the DOM` 直到超时（chromium 因为有 scroll anchoring
  // 且时序更快而侥幸躲过）。一个会在你伸手时消失的按钮，对真人和键盘用户同样是
  // 缺陷。按钮已 sticky 钉在列表底沿、随时够得着，由它独占翻页即可；无限滚动若要
  // 回归，需要一个不与按钮争的设计（见 RFC-311 plan 的登记）。
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
      <VirtualList<TaskCatalogListItem>
        items={props.items}
        itemKey={taskCatalogItemKey}
        estimateSize={73}
        scrollResetKey={props.scrollResetKey}
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
            sourceId={props.sourceId}
            expanded={props.expanded}
            collapsed={props.collapsed}
            onToggle={props.onToggle}
            ariaSetsize={props.items.length}
            ariaPosinset={index + 1}
          />
        )}
        tail={
          props.hasNextPage ? (
            <div className="task-operations__more" role="listitem">
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
                <span role="status" className="sr-only">
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
  item: TaskCatalogListItem
  depth: number
  filters: TaskOperationsFilters
  sourceId?: TaskSourceId
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
  const itemKey = taskCatalogItemKey(item)
  const hasChildren = item.hierarchy.qualifyingChildCount > 0
  const autoExpanded = item.hierarchy.matchKind === 'context' && !props.collapsed.has(itemKey)
  const isExpanded = hasChildren && (props.expanded.has(itemKey) || autoExpanded)
  const branchId = `task-children-${encodeURIComponent(itemKey).replaceAll('%', '_')}`
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
        onToggle={() => props.onToggle(itemKey, isExpanded)}
      />
      {hasChildren && (
        <div
          role="list"
          id={branchId}
          className="task-operations__children"
          aria-label={item.title}
          hidden={!isExpanded}
        >
          {isExpanded && (
            <TaskChildren
              parent={item}
              depth={props.depth + 1}
              filters={props.filters}
              sourceId={props.sourceId}
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

function TaskChildren(props: Omit<TaskBranchProps, 'item'> & { parent: TaskCatalogListItem }) {
  const { t } = useTranslation()
  const liveRegion = useManagedLiveRegion()
  const query = useTaskOperationsPage(props.filters, props.parent.id, true, props.sourceId)
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
        <TaskBranch key={taskCatalogItemKey(item)} item={item} {...props} />
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
            <span role="status" className="sr-only">
              {t('tasks.operations.loadingMoreChildren')}
            </span>
          ) : null}
        </div>
      )}
    </>
  )
}

function TaskOperationsRow(props: {
  item: TaskCatalogListItem
  depth: number
  branchId?: string
  expanded: boolean
  onToggle: () => void
}) {
  const { item } = props
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const now = useNowTick()
  const language = i18n.resolvedLanguage ?? i18n.language
  const href = taskDetailHref(item)
  const subject = localized(item.subject.label, language)
  const duration = taskOperationsDuration(item, now)
  const durationText =
    duration.kind === 'dash'
      ? t('common.emDash')
      : t(`tasks.operations.duration.${duration.kind}`, {
          dur: t(`common.dur.${duration.dur.key}`, duration.dur.opts),
        })
  const detail = executionDetail(item, t, language)

  return (
    <div
      className={`task-operations__row${props.depth > 0 ? ' task-operations__row--child' : ''}`}
      data-testid={`task-row-${item.id}`}
      onClick={(event) => {
        if (shouldRowNavigate(event)) {
          void navigate({ to: href })
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
                count: item.hierarchy.qualifyingChildCount,
              })}
              testid={`task-expand-${item.id}`}
              onToggle={props.onToggle}
            />
          )}
          <div className="task-operations__task-copy">
            <div className="task-operations__name-line">
              <a href={href} className="data-table__link task-operations__name" title={item.title}>
                {item.title}
              </a>
              {item.childCount > 0 && (
                <span className="task-operations__child-count">
                  {t('tasks.operations.childCount', { count: item.childCount })}
                </span>
              )}
              {item.hierarchy.parentAvailability === 'unavailable' && (
                <span
                  className="chip chip--tight"
                  data-testid={`task-parent-unavailable-${item.id}`}
                >
                  {t('tasks.parentTaskUnavailable')}
                </span>
              )}
            </div>
            <div className="task-operations__meta">
              <StatusChip kind="info" size="sm">
                {t(taskSourceRegistration(item.sourceId).labelKey)}
              </StatusChip>
              <span>{subject}</span>
              {item.targetLabel !== null ? (
                <>
                  <span className="task-operations__repo-separator" aria-hidden="true">
                    ·
                  </span>
                  <code className="task-operations__repo" title={item.targetLabel}>
                    {item.targetLabel}
                  </code>
                </>
              ) : null}
              {item.repositoryCount > 1 && (
                <span
                  className="chip chip--tight task-operations__repo-count"
                  data-testid={`task-repos-${item.id}`}
                >
                  {t('tasks.repoCountChip', { n: item.repositoryCount })}
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
        {item.ownerLabel === null ? (
          <OwnerLabel ownerUserId={item.ownerUserId} owner={item.owner} wrap />
        ) : (
          <span>{item.ownerLabel}</span>
        )}
      </div>

      <div className="task-operations__nav" aria-hidden="true">
        <OperationsChevronIcon />
      </div>
    </div>
  )
}

function taskDetailHref(item: TaskCatalogListItem): string {
  return taskSourceRegistration(item.sourceId).list.detailPath.replace(
    /\$[A-Za-z][A-Za-z0-9]*/,
    encodeURIComponent(item.id),
  )
}

function executionDetail(
  item: TaskCatalogListItem,
  t: (key: string, options?: Record<string, unknown>) => string,
  language: string,
): { text: string; title?: string } {
  if (item.statusDetail !== null) return { text: localized(item.statusDetail, language) }
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
  if (item.hierarchy.matchKind === 'context') {
    return {
      text: t('tasks.operations.contextMatches', {
        count: item.hierarchy.matchingDescendantCount,
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
