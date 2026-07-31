// Tasks list page — RFC-192 run-monitor table.
//
// Status leads the row (running rows pulse); the name cell carries the ULID
// subtitle, a「定时」origin chip (scheduledTaskId → /scheduled/$id) and — on
// FAILED rows only — the red error summary line (the always-on Error column
// retired; canceled/interrupted rows keep their non-error summaries for the
// detail page). Repo shows the display name (URL-mode derives from the
// REDACTED repoUrl, never the cache dir). Whole row navigates via the shared
// `shouldRowNavigate` guard (modifier clicks / inner links exempt).
//
// Filters: status chips stay URL-driven (API param); subject (Segmented over
// `taskExecutionKind`) + name search are pure client-side (决策 D2) over the
// explicitly requested `limit=500` window (listTasks defaults to 100 —
// without the param local filtering would silently miss older rows).
//
// RFC-242 PR-5 — child-task nesting. The backend defaults the list to
// top-level rows (`parent_task_id IS NULL`); node-invoked child executions
// surface two ways:
//   - default scope: an expand arrow on running/awaiting/done rows lazily
//     fetches `GET /api/tasks?parent_id=<id>` and nests the direct children
//     under the parent row (indent +「子任务」badge). There is no per-row
//     has-children signal, so the arrow is shown unconditionally on those
//     statuses; an empty result renders one「无子任务」row and is remembered
//     in component state (no re-probe on re-expand).
//   - 「含子任务」scope: the query adds `include_children=true` (flat), and
//     child rows carry a parent-task link badge. When the parent itself is
//     not visible to the viewer (design §8 — e.g. a workgroup human member
//     who is only a member of the child), the badge degrades to a neutral
//     non-link label instead of a dead link.

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { describeTaskFailure } from '@/lib/task-failure'
import { Link, createRoute, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { Task, TaskListItem, TaskStatus, TaskSummary } from '@agent-workflow/shared'
import { TASK_STATUS } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FeedbackStack } from '@/components/FeedbackStack'
import { TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { OwnerLabel } from '@/components/OwnerLabel'
import { RelativeTime } from '@/components/RelativeTime'
import { Segmented } from '@/components/Segmented'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { TaskStatusChip } from '@/components/TaskStatusChip'
import { TaskSubjectLink } from '@/components/TaskSubjectLink'
import { TASK_ICON } from '@/components/icons/resourceIcons'
import { useNowTick } from '@/hooks/useNowTick'
import { useTaskChildren } from '@/hooks/useTaskChildren'
import { useTasksSync } from '@/hooks/useTasksSync'
import { taskDurationCell } from '@/lib/duration'
import { shouldRowNavigate } from '@/lib/row-nav'
import { filterTaskRows, type TaskSubjectFilter } from '@/lib/task-list-filter'
import { taskRepoDisplayName } from '@/lib/task-repo-name'
import { Route as RootRoute } from './__root'

interface TasksSearch {
  status?: TaskStatus
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/tasks',
  component: TasksPage,
  validateSearch: (raw: Record<string, unknown>): TasksSearch => {
    const status = raw.status
    if (typeof status === 'string' && (TASK_STATUS as readonly string[]).includes(status)) {
      return { status: status as TaskStatus }
    }
    return {}
  },
})

const SUBJECT_FILTERS: readonly TaskSubjectFilter[] = ['all', 'workflow', 'workgroup', 'agent']

/** RFC-242: list scope —「仅顶层」(server default) vs「含子任务」(flat). */
type TaskChildScope = 'top' | 'all'

/**
 * RFC-242: statuses whose rows carry the always-on expand arrow. There is no
 * per-row has-children signal by design (no N+1 probing); these are the
 * states a call node's child execution can exist under (running parent,
 * parent parked on review/human, finished parent).
 */
const EXPANDABLE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'running',
  'awaiting_review',
  'awaiting_human',
  'done',
])

/** Column count of the run-monitor table (child loading/empty rows span it). */
const TASK_TABLE_COL_COUNT = 8

function TasksPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const search = Route.useSearch() as TasksSearch
  const status = search.status

  useTasksSync()
  const [scope, setScope] = useState<TaskChildScope>('top')
  const { data, isLoading, error, refetch } = useQuery<TaskListItem[]>({
    queryKey: ['tasks', { status, scope }],
    // RFC-192 (Codex 设计门 P1): listTasks defaults to 100 rows — request the
    // route's full 500-row cap explicitly so client-side subject/search
    // filtering never silently misses rows 101+.
    queryFn: ({ signal }) => {
      const query: Record<string, string> = { include_owner: 'true', limit: '500' }
      if (status !== undefined) query.status = status
      // RFC-242: flat child view. The default request deliberately carries NO
      // include_children param — the server's top-level filter is the contract.
      if (scope === 'all') query.include_children = 'true'
      return api.get('/api/tasks', query, signal)
    },
    refetchInterval: 15_000, // Fallback for cases where WS is unavailable.
  })

  const now = useNowTick()
  const [subject, setSubject] = useState<TaskSubjectFilter>('all')
  const [nameSearch, setNameSearch] = useState('')
  // RFC-242: expanded parent rows + the "known childless" memory (an empty
  // children result renders the「无子任务」row once and is not re-fetched on
  // the next expand; plain component state per the design).
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [childless, setChildless] = useState<ReadonlySet<string>>(() => new Set())
  const toggleExpanded = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const markChildless = useCallback((id: string) => {
    setChildless((previous) => (previous.has(id) ? previous : new Set(previous).add(id)))
  }, [])
  const nameSearchRef = useRef<HTMLInputElement | null>(null)
  const allStatusRef = useRef<HTMLAnchorElement | null>(null)
  const focusAfterStatusClearRef = useRef(false)
  const rows = useMemo(
    () => (data === undefined ? undefined : filterTaskRows(data, { subject, search: nameSearch })),
    [data, subject, nameSearch],
  )
  // RFC-242: ACL-visibility proxy for the flat-mode parent badge — a parent
  // present in the SAME (unfiltered) response is trivially visible; absent
  // parents get one probe fetch in ParentTaskBadge. Built from `data`, not
  // `rows`, because client-side subject/search filters say nothing about
  // visibility.
  const listedIds = useMemo(() => new Set((data ?? []).map((row) => row.id)), [data])
  const hasRows = data !== undefined && data.length > 0
  const isInitialEmpty =
    !isLoading && data !== undefined && data.length === 0 && status === undefined
  const isStatusEmpty =
    !isLoading && data !== undefined && data.length === 0 && status !== undefined

  // A status-only empty result does not mount the search field. Clearing that
  // URL filter therefore has to wait until the unfiltered query has rendered
  // before restoring focus. Fall back to the always-mounted "All" chip when
  // the unfiltered list is empty too.
  useEffect(() => {
    if (
      !focusAfterStatusClearRef.current ||
      status !== undefined ||
      isLoading ||
      data === undefined
    ) {
      return
    }
    focusAfterStatusClearRef.current = false
    const target = nameSearchRef.current ?? allStatusRef.current
    if (target !== null && target.isConnected) target.focus()
  }, [data, isLoading, status])
  const newTaskAction = (
    <Link to="/tasks/new" className="btn btn--primary" data-testid="tasks-new-button">
      {t('tasks.newButton')}
    </Link>
  )
  const clearFiltersAction = (
    <button
      type="button"
      className="btn btn--sm"
      onClick={() => {
        setSubject('all')
        setNameSearch('')
        if (status !== undefined) {
          focusAfterStatusClearRef.current = true
          void navigate({ to: '/tasks', search: {} })
        }
        const target = nameSearchRef.current
        if (target !== null && target.isConnected) target.focus()
      }}
    >
      {t('common.clearFilters')}
    </button>
  )

  return (
    <div className="page">
      <PageHeader title={t('tasks.title')} actions={isInitialEmpty ? undefined : newTaskAction} />

      <div className="status-filter">
        <div className="status-filter__statuses">
          <Link
            ref={allStatusRef}
            to="/tasks"
            search={{}}
            className={`chip ${status === undefined ? 'chip--active' : ''}`}
          >
            {t('tasks.filterAll')}
          </Link>
          {TASK_STATUS.map((s) => (
            <Link
              key={s}
              to="/tasks"
              search={{ status: s }}
              className={`chip ${status === s ? 'chip--active' : ''}`}
            >
              {t(`tasks.status.${s}`)}
            </Link>
          ))}
        </div>
        {/* RFC-192 — subject + name filters, pure client-side. Rendered only
            when the list has rows so the empty page does not show controls
            that cannot narrow anything. RFC-242: the child-scope Segmented is
            deliberately OUTSIDE that gate — it is a server-side scope that
            can BROADEN an empty top-level list (a workgroup human member may
            be a member of child tasks only; hiding the toggle would strand
            their awaiting children, the exact P2-5(R1) window the design
            closes). */}
        {data !== undefined && (
          // div, not span: Segmented's root is a <div> and <span><div> is
          // invalid nesting (React 19 validateDOMNesting; 实现门 P3).
          <div className="tasks-toolbar">
            <Segmented<TaskChildScope>
              value={scope}
              onChange={setScope}
              ariaLabel={t('tasks.scopeFilterAria')}
              options={[
                { value: 'top', label: t('tasks.scopeFilter.top'), testid: 'tasks-scope-top' },
                { value: 'all', label: t('tasks.scopeFilter.all'), testid: 'tasks-scope-all' },
              ]}
            />
            {hasRows && (
              <>
                <Segmented<TaskSubjectFilter>
                  value={subject}
                  onChange={setSubject}
                  ariaLabel={t('tasks.colSubject')}
                  options={SUBJECT_FILTERS.map((v) => ({
                    value: v,
                    label: t(`tasks.subjectFilter.${v}`),
                    testid: `tasks-subject-${v}`,
                  }))}
                />
                <TextInput
                  type="search"
                  value={nameSearch}
                  onChange={setNameSearch}
                  placeholder={t('common.searchEllipsis')}
                  aria-label={t('common.searchEllipsis')}
                  className="tasks-toolbar__search"
                  inputRef={nameSearchRef}
                  data-testid="tasks-search"
                />
              </>
            )}
          </div>
        )}
      </div>

      {isLoading && <LoadingState data-testid="tasks-loading" />}
      <FeedbackStack variant="section">
        {error !== null && error !== undefined && (
          <ErrorBanner error={error} onRetry={() => void refetch()} />
        )}
      </FeedbackStack>
      {isInitialEmpty && (
        <EmptyState
          title={t('tasks.emptyList')}
          description={t('tasks.emptyDescription')}
          icon={TASK_ICON}
          action={newTaskAction}
          data-testid="tasks-empty"
        />
      )}
      {isStatusEmpty && (
        <EmptyState
          size="compact"
          title={t('common.noMatches')}
          action={clearFiltersAction}
          data-testid="tasks-no-matches"
        />
      )}
      {hasRows && rows !== undefined && rows.length === 0 && (
        <EmptyState
          size="compact"
          title={t('common.noMatches')}
          action={clearFiltersAction}
          data-testid="tasks-no-matches"
        />
      )}

      {rows !== undefined && rows.length > 0 && (
        <TableViewport label={t('tasks.title')} minWidth="lg">
          <table className="data-table">
            <thead>
              <tr>
                {/* RFC-192: status leads (monitor-scan entry point); the ULID
                    stays a muted subtitle inside the name cell (RFC-037). */}
                <th>{t('tasks.colStatus')}</th>
                <th>{t('tasks.colName')}</th>
                <th>{t('tasks.colSubject')}</th>
                <th>{t('acl.owner')}</th>
                <th>{t('tasks.colRepo')}</th>
                <th>{t('tasks.colStarted')}</th>
                <th>{t('tasks.colDuration')}</th>
                <th aria-label={t('common.ariaActions')} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <TaskRowGroup
                  key={row.id}
                  row={row}
                  now={now}
                  depth={0}
                  scope={scope}
                  expanded={expanded}
                  childless={childless}
                  onToggleExpanded={toggleExpanded}
                  onMarkChildless={markChildless}
                  listedIds={listedIds}
                />
              ))}
            </tbody>
          </table>
        </TableViewport>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// RFC-242 — row group (one task row + its lazily expanded direct children).
// ---------------------------------------------------------------------------

interface TaskRowGroupProps {
  row: TaskListItem
  now: number
  /** Nesting depth: 0 = top-level; >0 = nested child row (indent + badge). */
  depth: number
  scope: TaskChildScope
  expanded: ReadonlySet<string>
  childless: ReadonlySet<string>
  onToggleExpanded: (id: string) => void
  onMarkChildless: (id: string) => void
  /** Ids present in the main list response — flat-mode parent-badge shortcut. */
  listedIds: ReadonlySet<string>
}

function TaskRowGroup(props: TaskRowGroupProps) {
  const { row, scope, depth } = props
  const { t } = useTranslation()
  // Expansion only exists in the nested (top-level) scope — the flat
  //「含子任务」listing already shows every child row.
  const expandable = scope === 'top' && EXPANDABLE_STATUSES.has(row.status)
  const isExpanded = expandable && props.expanded.has(row.id)
  return (
    <Fragment>
      <TaskRow
        row={row}
        now={props.now}
        depth={depth}
        expandState={expandable ? (isExpanded ? 'expanded' : 'collapsed') : null}
        onToggleExpand={() => props.onToggleExpanded(row.id)}
        parentBadge={
          scope === 'all' && row.parentTaskId != null ? (
            <ParentTaskBadge
              taskId={row.id}
              parentTaskId={row.parentTaskId}
              parentInList={props.listedIds.has(row.parentTaskId)}
            />
          ) : undefined
        }
      />
      {isExpanded &&
        (props.childless.has(row.id) ? (
          <tr data-testid={`task-children-empty-${row.id}`}>
            <td colSpan={TASK_TABLE_COL_COUNT} className="data-table__muted">
              {t('tasks.noChildTasks')}
            </td>
          </tr>
        ) : (
          <TaskChildRows {...props} parentId={row.id} depth={depth + 1} />
        ))}
    </Fragment>
  )
}

/**
 * Lazily loaded direct children of one expanded parent row. Children that are
 * themselves in an expandable state recurse through TaskRowGroup, so a
 * grandchild chain (invocationDepth > 1) stays reachable from the list.
 */
function TaskChildRows(props: Omit<TaskRowGroupProps, 'row'> & { parentId: string }) {
  const { parentId, onMarkChildless } = props
  const { t } = useTranslation()
  const query = useTaskChildren(parentId)
  const isEmpty = query.data !== undefined && query.data.length === 0
  // Remember "no children" in the page's component state (setState in render
  // is illegal — effect). The parent then renders the empty row itself and
  // this query unmounts, so a re-expand never re-probes the server.
  useEffect(() => {
    if (isEmpty) onMarkChildless(parentId)
  }, [isEmpty, onMarkChildless, parentId])

  if (query.data === undefined) {
    if (query.error !== null && query.error !== undefined) {
      return (
        <tr data-testid={`task-children-error-${parentId}`}>
          <td colSpan={TASK_TABLE_COL_COUNT}>
            <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
          </td>
        </tr>
      )
    }
    return (
      <tr data-testid={`task-children-loading-${parentId}`}>
        <td colSpan={TASK_TABLE_COL_COUNT}>
          <LoadingState size="compact" />
        </td>
      </tr>
    )
  }
  if (isEmpty) {
    // First (pre-memory) frame of an empty result — same DOM as the
    // remembered branch in TaskRowGroup, which takes over on the next render.
    return (
      <tr data-testid={`task-children-empty-${parentId}`}>
        <td colSpan={TASK_TABLE_COL_COUNT} className="data-table__muted">
          {t('tasks.noChildTasks')}
        </td>
      </tr>
    )
  }
  return (
    <Fragment>
      {query.data.map((child) => (
        <TaskRowGroup {...props} key={child.id} row={child} />
      ))}
    </Fragment>
  )
}

/**
 * RFC-242 — flat-mode parent badge on a child row. Links to the parent detail
 * when the parent is visible; degrades to a neutral non-link label when it is
 * not (design §8 — a workgroup human member can be a member of the child task
 * only; the ACL-filtered list/detail make "invisible" and "deleted" look the
 * same, so one neutral label covers both, never a dead link).
 */
function ParentTaskBadge({
  taskId,
  parentTaskId,
  parentInList,
}: {
  taskId: string
  parentTaskId: string
  parentInList: boolean
}) {
  const { t } = useTranslation()
  // Probe only when the parent is not already in the list window (rare:
  // ACL-invisible parent, or a parent older than the 500-row window). Shares
  // the detail route's ['tasks', id] cache entry, so a successful probe also
  // pre-warms the parent detail navigation.
  const probe = useQuery<Task>({
    queryKey: ['tasks', parentTaskId],
    queryFn: ({ signal }) =>
      api.get(`/api/tasks/${encodeURIComponent(parentTaskId)}`, undefined, signal),
    enabled: !parentInList,
    retry: false,
    staleTime: 30_000,
  })
  if (parentInList || probe.data !== undefined) {
    return (
      <Link
        to="/tasks/$id"
        params={{ id: parentTaskId }}
        className="chip chip--tight task-name-cell__origin"
        data-testid={`task-parent-chip-${taskId}`}
      >
        {t('tasks.parentTaskChip')}
      </Link>
    )
  }
  return (
    <span
      className="chip chip--tight task-name-cell__origin"
      data-testid={`task-parent-chip-${taskId}`}
    >
      {probe.isError ? t('tasks.parentTaskUnavailable') : t('tasks.parentTaskChip')}
    </span>
  )
}

// ---------------------------------------------------------------------------
// One run-monitor table row (top-level or nested child).
// ---------------------------------------------------------------------------

interface TaskRowProps {
  row: TaskListItem
  now: number
  depth: number
  /** null = no expand affordance on this row. */
  expandState: 'collapsed' | 'expanded' | null
  onToggleExpand: () => void
  /** Flat-mode parent badge (link or neutral degrade), when applicable. */
  parentBadge?: ReactNode
}

function TaskRow({ row, now, depth, expandState, onToggleExpand, parentBadge }: TaskRowProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const repo = taskRepoDisplayName(row)

  function durationCell(r: TaskSummary): string {
    const cell = taskDurationCell(r, now)
    if (cell.kind === 'dash') return t('common.emDash')
    const dur = t(`common.dur.${cell.dur.key}`, cell.dur.opts)
    if (cell.kind === 'running') return t('tasks.durationRunning', { dur })
    if (cell.kind === 'waiting') return t('tasks.durationWaiting', { dur })
    return dur
  }

  return (
    <tr
      className={`data-table__row${depth > 0 ? ' task-row--child' : ''}`}
      data-testid={`task-row-${row.id}`}
      data-depth={depth > 0 ? depth : undefined}
      // RFC-242: nested-child indent rides a CSS var on the <tr>; the
      // `.task-row--child .task-name-cell__inner` rule consumes it. The inner
      // <div> stays byte-identical — tasks-list-name-cell-row-alignment locks
      // its exact markup (flex belongs on the inner wrapper, never the <td>).
      style={depth > 0 ? ({ '--task-child-depth': depth } as CSSProperties) : undefined}
      onClick={(e) => {
        // Whole-row navigation; inner links / modifier clicks are
        // exempt via the shared guard (RFC-192 design §4).
        if (shouldRowNavigate(e)) {
          void navigate({ to: '/tasks/$id', params: { id: row.id } })
        }
      }}
    >
      <td className="data-table__nowrap">
        {/* RFC-242: always-on expand arrow (no per-row children probe). A
            <button> is exempt from row navigation by the shouldRowNavigate
            closest() guard. */}
        {expandState !== null && (
          <>
            <button
              type="button"
              className="btn btn--xs"
              aria-expanded={expandState === 'expanded'}
              aria-label={t(
                expandState === 'expanded' ? 'tasks.collapseChildren' : 'tasks.expandChildren',
              )}
              data-testid={`task-expand-${row.id}`}
              onClick={onToggleExpand}
            >
              <span aria-hidden="true">{expandState === 'expanded' ? '▾' : '▸'}</span>
            </button>{' '}
          </>
        )}
        <TaskStatusChip status={row.status} pulse={row.status === 'running'} />
        {/* RFC-108 T22: stuck badge — open lifecycle alerts. */}
        {(row.openAlertCount ?? 0) > 0 && (
          <>
            {' '}
            <StatusChip
              kind="warn"
              size="sm"
              aria-label={t('tasks.stuckBadge', { count: row.openAlertCount })}
            >
              {t('tasks.stuckBadge', { count: row.openAlertCount })}
            </StatusChip>
          </>
        )}
      </td>
      <td className="task-name-cell">
        {/* Flex column lives on this inner wrapper, NOT the <td> —
          a flex <td> drops out of row-height equalization and its
          bottom border paints ~3px above the neighbors' (stepped
          row separator). See .skills__name-cell__inner for the
          same pattern. */}
        <div className="task-name-cell__inner">
          {/* Flex row so the origin chip sits BESIDE the name
            (__name is display:block — a bare span would push
            the chip to its own line; 实现门 P2). */}
          <span className="task-name-cell__row">
            <Link
              to="/tasks/$id"
              params={{ id: row.id }}
              className="data-table__link task-name-cell__name"
              title={row.name}
            >
              {row.name}
            </Link>
            {/* RFC-242: nested rows are marked as child executions; flat-mode
                child rows link their parent instead (parentBadge). */}
            {depth > 0 && (
              <span className="chip chip--tight" data-testid={`task-child-badge-${row.id}`}>
                {t('tasks.childBadge')}
              </span>
            )}
            {parentBadge}
            {/* RFC-192: scheduled-origin chip → the owning schedule. */}
            {row.scheduledTaskId != null && (
              <Link
                to="/scheduled/$id"
                params={{ id: row.scheduledTaskId }}
                className="chip chip--tight task-name-cell__origin"
                data-testid={`task-scheduled-chip-${row.id}`}
              >
                {t('tasks.scheduledChip')}
              </Link>
            )}
          </span>
          <code className="task-name-cell__id">{row.id}</code>
          {/* RFC-192: the error line renders on FAILED rows only —
            canceled/interrupted rows also carry non-null
            summaries ("canceled by user", "daemon-shutdown")
            that are notes, not errors (Codex 设计门 P2). */}
          {row.status === 'failed' && row.errorSummary != null && (
            <span
              className="task-name-cell__error"
              title={row.errorSummary}
              data-testid={`task-error-${row.id}`}
            >
              {/* RFC-203 T4: localized failure copy; raw token stays in title. */}
              {
                describeTaskFailure({
                  failureCode: row.failureCode ?? null,
                  errorSummary: row.errorSummary,
                }).title
              }
            </span>
          )}
        </div>
      </td>
      <td className="data-table__nowrap">
        {/* Execution subject (group / agent / workflow) — resolved
          by TaskSubjectLink so builtin host anchors never leak. */}
        <TaskSubjectLink task={row} taskId={row.id} badge />
      </td>
      <td className="data-table__owner-cell">
        <OwnerLabel ownerUserId={row.ownerUserId} owner={row.owner} />
      </td>
      <td className="data-table__nowrap">
        <code title={repo.title}>{repo.name}</code>
        {row.repoCount > 1 && (
          <>
            {' '}
            <span className="chip chip--tight" data-testid={`task-repos-${row.id}`}>
              {t('tasks.repoCountChip', { n: row.repoCount })}
            </span>
          </>
        )}
      </td>
      <td className="data-table__muted data-table__nowrap">
        <RelativeTime ts={row.startedAt} />
      </td>
      <td className="data-table__muted data-table__nowrap">{durationCell(row)}</td>
      <td className="data-table__chevron" aria-hidden="true">
        ›
      </td>
    </tr>
  )
}
