// RFC-024 → RFC-246 — cached-repo operations surface. The wire remains
// redacted and every refresh/delete/batch-import behavior is preserved.

import {
  CachedRepoPageSchema,
  type CachedRepo,
  type CachedRepoPage,
  type DeleteRepoGroupResponse,
  type RepoGroup,
} from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { createRoute, useRouterState } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FeedbackStack } from '@/components/FeedbackStack'
import { Field } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { OperationsToolbar } from '@/components/operations/OperationsToolbar'
import { PageHeader } from '@/components/PageHeader'
import { RelativeTime } from '@/components/RelativeTime'
import { BatchImportDialog } from '@/components/repos/BatchImportDialog'
import { SubmoduleBadge } from '@/components/repos/SubmoduleBadge'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Segmented } from '@/components/Segmented'
import { TabBar, tabDomIds } from '@/components/TabBar'
import { RepoGroupEditor } from '@/components/repos/RepoGroupEditor'
import { RepoGroupsPane } from '@/components/repos/RepoGroupsPane'
import { TableViewport } from '@/components/TableViewport'
import { VirtualList } from '@/components/VirtualList'
import { FOLDER_ICON, REPO_ICON } from '@/components/icons/resourceIcons'
import { ACTOR_QUERY_KEY, useActor, type MeResponse } from '@/hooks/useActor'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { usePagedList } from '@/hooks/usePagedList'
import { getToken } from '@/stores/auth'
import {
  REPO_OPERATIONS_VIEWS,
  type RepoAutoRefreshFilter,
  type RepoOperationsView,
  type RepoSubmoduleFilter,
} from '@/lib/operations-filters'
import { Route as RootRoute } from './__root'

const BATCH_ID_LS_KEY = 'repo-import-batch-id'
const REPO_SUBMODULE_FILTERS = ['all', 'with', 'without'] as const
const REPO_AUTO_REFRESH_FILTERS = ['all', 'refreshed', 'never'] as const

type RepoWritePermission = 'repos:create' | 'repos:update' | 'repos:delete' | 'repos:execute'

/** Final request-boundary authorization; never trusts a render-time snapshot. */
export function hasRepoPermissionAtRequest(
  queryClient: QueryClient,
  permission: RepoWritePermission,
): boolean {
  const queryKey = [...ACTOR_QUERY_KEY, getToken() ?? 'no-token'] as const
  const state = queryClient.getQueryState(queryKey)
  if (state?.status !== 'success' || state.fetchStatus !== 'idle') return false
  const data = queryClient.getQueryData<MeResponse | null>(queryKey)
  return data !== null && data !== undefined && Array.isArray(data.permissions)
    ? data.permissions.includes(permission)
    : false
}

interface RepoFilterDraft {
  submodules: RepoSubmoduleFilter
  autoRefresh: RepoAutoRefreshFilter
}

type RepoResourceTab = 'repos' | 'groups'

interface ReposSearch extends Record<string, unknown> {
  tab?: RepoResourceTab
}

function isRepoResourceTab(value: unknown): value is RepoResourceTab {
  return value === 'repos' || value === 'groups'
}

export function validateReposSearch(search: Record<string, unknown>): ReposSearch {
  const { tab: _tab, ...adjacent } = search
  return isRepoResourceTab(search.tab) ? { ...adjacent, tab: search.tab } : adjacent
}

export function withRepoResourceTab<T extends Record<string, unknown>>(
  previous: T,
  tab: RepoResourceTab,
): T & { tab: RepoResourceTab } {
  return { ...previous, tab }
}

export function repoResourceTabFromUrl(href: string): {
  tab: RepoResourceTab
  invalid: boolean
} {
  const value = new URL(href, 'http://localhost').searchParams.get('tab')
  if (value === null) return { tab: 'repos', invalid: false }
  if (value === 'repos' || value === 'groups') return { tab: value, invalid: false }
  return { tab: 'repos', invalid: true }
}

export function hrefForRepoResourceTab(href: string, tab: RepoResourceTab): string {
  const url = new URL(href, 'http://localhost')
  url.searchParams.set('tab', tab)
  return `${url.pathname}${url.search}${url.hash}`
}

export function shouldNormalizeRepoResourceLocation(pathname: string, href: string): boolean {
  return pathname === '/repos' && repoResourceTabFromUrl(href).invalid
}

export const ReposRoute = createRoute({
  getParentRoute: () => RootRoute,
  path: '/repos',
  validateSearch: validateReposSearch,
  component: ReposPage,
})

function ReposPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const actor = useActor()
  // Permission data is an untrusted network payload. Keep every capability
  // false until /me has returned a settled, successful permission array. A
  // failed/background refetch can retain old data, which must not stay usable.
  const actorPermissions =
    actor.status === 'success' &&
    actor.fetchStatus === 'idle' &&
    Array.isArray(actor.data?.permissions)
      ? actor.data.permissions
      : []
  const canCreate = actorPermissions.includes('repos:create')
  const canUpdate = actorPermissions.includes('repos:update')
  const canDelete = actorPermissions.includes('repos:delete')
  const canExecute = actorPermissions.includes('repos:execute')
  const hasRepoPermission = (permission: RepoWritePermission): boolean =>
    hasRepoPermissionAtRequest(qc, permission)
  const routeSearch = ReposRoute.useSearch()
  const navigateRepos = ReposRoute.useNavigate()
  const routeLocation = useRouterState({
    select: (state) => state.resolvedLocation ?? state.location,
  })
  const refresh = useMutation({
    mutationFn: async (id: string) => {
      if (!hasRepoPermission('repos:execute')) throw new Error('repos:execute permission required')
      return api.post(`/api/cached-repos/${encodeURIComponent(id)}/refresh`, {})
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cached-repos'] }),
  })
  const remove = useMutation({
    mutationFn: async ({ id, force }: { id: string; force?: boolean }) => {
      if (!hasRepoPermission('repos:delete')) throw new Error('repos:delete permission required')
      return api.delete(`/api/cached-repos/${encodeURIComponent(id)}${force ? '?force=1' : ''}`)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cached-repos'] }),
  })
  const resetRemoveMutation = remove.reset

  const [pendingDelete, setPendingDelete] = useState<CachedRepo | null>(null)
  const [batchImportOpen, setBatchImportOpen] = useState(false)
  const batchImportTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [activeBatchId, setActiveBatchId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(BATCH_ID_LS_KEY)
    } catch {
      return null
    }
  })
  useEffect(() => {
    try {
      if (activeBatchId === null) localStorage.removeItem(BATCH_ID_LS_KEY)
      else localStorage.setItem(BATCH_ID_LS_KEY, activeBatchId)
    } catch {
      /* ignore quota errors */
    }
  }, [activeBatchId])

  const [view, setView] = useState<RepoOperationsView>('all')
  const [search, setSearch] = useState('')
  const [submodules, setSubmodules] = useState<RepoSubmoduleFilter>('all')
  const [autoRefresh, setAutoRefresh] = useState<RepoAutoRefreshFilter>('all')
  const [filterOpen, setFilterOpen] = useState(false)
  const [draft, setDraft] = useState<RepoFilterDraft>({ submodules: 'all', autoRefresh: 'all' })
  const searchRef = useRef<HTMLInputElement | null>(null)
  const filterButtonRef = useRef<HTMLButtonElement | null>(null)

  // RFC-311 T28:过滤/搜索/facets 全部下推服务端(/api/cached-repos 分页封套,
  // C7 无参兼容面留给 repo picker 消费方)。搜索 350ms 去抖;条件变化 =
  // queryKey 变化 = 自动回首页。
  const debouncedSearch = useDebouncedValue(search.trim(), 350)
  const pageFilters = useMemo(
    () => ({ view, q: debouncedSearch, submodules, autoRefresh }),
    [autoRefresh, debouncedSearch, submodules, view],
  )
  const list = usePagedList<CachedRepoPage>({
    queryKey: ['cached-repos', 'page', pageFilters],
    keepPreviousData: true,
    fetchPage: async (cursor, signal) => {
      const payload = await api.get<unknown>(
        '/api/cached-repos',
        {
          // limit 恒发:空 query 会落回旧全量形状(buildUrl 丢弃空串/undefined)。
          limit: 50,
          view: view === 'all' ? undefined : view,
          q: debouncedSearch === '' ? undefined : debouncedSearch,
          submodules: submodules === 'all' ? undefined : submodules,
          auto_refresh: autoRefresh === 'all' ? undefined : autoRefresh,
          cursor: cursor ?? undefined,
        },
        signal,
      )
      return CachedRepoPageSchema.parse(payload)
    },
  })

  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data])
  const facets = list.data?.pages[0]?.facets ?? { all: 0, referenced: 0, attention: 0, unused: 0 }
  const advancedFilterCount = Number(submodules !== 'all') + Number(autoRefresh !== 'all')
  const hasAnyFilter = view !== 'all' || search.trim() !== '' || advancedFilterCount > 0
  const isInitialEmpty = !list.isLoading && list.data !== undefined && facets.all === 0
  const noMatches = !list.isLoading && list.error == null && facets.all > 0 && items.length === 0

  const clearFilters = () => {
    setView('all')
    setSearch('')
    setSubmodules('all')
    setAutoRefresh('all')
    window.setTimeout(() => searchRef.current?.focus(), 0)
  }
  const openFilters = () => {
    setDraft({ submodules, autoRefresh })
    setFilterOpen(true)
  }
  const applyFilters = () => {
    setSubmodules(draft.submodules)
    setAutoRefresh(draft.autoRefresh)
    setFilterOpen(false)
  }

  // RFC-249 T31: page-level view state is a strict URL contract. Deep links,
  // refresh and browser history must restore the same resource surface.
  const tab = isRepoResourceTab(routeSearch.tab) ? routeSearch.tab : 'repos'
  useEffect(() => {
    // `state.location` becomes the optimistic destination before this route
    // unmounts. Never interpret another route's search params as a malformed
    // repos URL, otherwise leaving for `/memory?tab=all` is replaced back to
    // `/repos?tab=repos` during the transition.
    if (!shouldNormalizeRepoResourceLocation(routeLocation.pathname, routeLocation.href)) return
    void navigateRepos({
      search: (previous) => withRepoResourceTab(previous, 'repos'),
      hash: routeLocation.hash,
      replace: true,
    })
  }, [navigateRepos, routeLocation])
  const selectTab = (next: RepoResourceTab) => {
    if (next === tab) return
    void navigateRepos({
      search: (previous) => withRepoResourceTab(previous, next),
      hash: routeLocation.hash,
    })
  }
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<RepoGroup | undefined>(undefined)
  const groupList = useQuery<{ items: RepoGroup[] }>({
    queryKey: ['repo-groups'],
    queryFn: ({ signal }) => api.get('/api/repo-groups', undefined, signal),
    enabled: tab === 'groups',
  })
  // RFC-248（实现门 P1）：删组要**先确认**再删——它会连带把绑在这个组上的记忆
  // 置为 archived，无确认地一键抹掉是不可接受的。被别的组或启用中计划引用时
  // 服务端回 409，UI 要给出「强制删除（并摘除引用 / 停发计划）」的重试路径，
  // 而不是把用户堵在一个没有出口的错误上。
  // RFC-248（实现门 P2）：组这一档也要能搜——组多起来（每个项目一个组合）时
  // 一张没有搜索的长表和远端仓那边的体验就割裂了。
  const [groupSearch, setGroupSearch] = useState('')
  const [pendingGroupDelete, setPendingGroupDelete] = useState<RepoGroup | null>(null)
  const [deleteConflict, setDeleteConflict] = useState<string | null>(null)
  const [deleteReport, setDeleteReport] = useState<string | null>(null)
  const [groupDeleteSession, setGroupDeleteSession] = useState(0)
  const suppressNextGroupDeleteCloseRef = useRef(false)
  useEffect(() => {
    // If the failed session was unmounted before it could request a close,
    // do not let the suppression leak into the replacement session.
    suppressNextGroupDeleteCloseRef.current = false
  }, [groupDeleteSession])
  const removeGroup = useMutation({
    mutationFn: async ({ id, force }: { id: string; force?: boolean }) => {
      if (!hasRepoPermission('repos:delete')) throw new Error('repos:delete permission required')
      return api.delete<DeleteRepoGroupResponse>(
        `/api/repo-groups/${encodeURIComponent(id)}${force === true ? '?force=1' : ''}`,
      )
    },
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ['repo-groups'] })
      setPendingGroupDelete(null)
      setDeleteConflict(null)
      // 回报服务端实际做了什么——归档了几条记忆、摘掉几处引用、停发几个计划。
      setDeleteReport(
        t('repoGroups.deleteReport', {
          memories: res.archivedMemories,
          refs: res.detachedReferences,
          schedules: res.disabledSchedules,
        }),
      )
    },
    onError: (err: unknown) => {
      const code = (err as { code?: string }).code
      setDeleteConflict(code === 'repo-group-has-references' ? 'references' : null)
    },
  })
  const resetRemoveGroupMutation = removeGroup.reset

  // A permission refresh may downgrade the actor while a destructive surface
  // is already open. Tear down every stale surface instead of leaving a live
  // control backed by an obsolete render-time decision.
  useEffect(() => {
    if (!canCreate) {
      setBatchImportOpen(false)
      if (editorOpen && editing === undefined) setEditorOpen(false)
    }
    if (!canUpdate && editorOpen && editing !== undefined) setEditorOpen(false)
    if (!canDelete) {
      setPendingDelete(null)
      setPendingGroupDelete(null)
      setDeleteConflict(null)
      // Detach this view from any mutation that was authorized before the
      // downgrade. Its late failure must not leak a stale destructive error
      // back into the read-only surface (or reappear after a later upgrade).
      resetRemoveMutation()
      resetRemoveGroupMutation()
    }
  }, [
    canCreate,
    canDelete,
    canUpdate,
    editing,
    editorOpen,
    resetRemoveGroupMutation,
    resetRemoveMutation,
  ])

  const newGroupAction = canCreate ? (
    <button
      type="button"
      className="btn btn--primary"
      data-testid="repo-groups-new"
      onClick={() => {
        if (!hasRepoPermission('repos:create')) return
        setEditing(undefined)
        setEditorOpen(true)
      }}
    >
      {t('repoGroups.newButton')}
    </button>
  ) : undefined

  const canOpenBatchDialog = canCreate || (canExecute && activeBatchId !== null)
  useEffect(() => {
    if (!canOpenBatchDialog) setBatchImportOpen(false)
  }, [canOpenBatchDialog])
  const batchImportAction = canOpenBatchDialog ? (
    <button
      ref={batchImportTriggerRef}
      type="button"
      className="btn btn--primary"
      data-testid="repos-batch-import-button"
      data-repo-action={canCreate ? 'create' : 'retry'}
      onClick={() => {
        if (
          hasRepoPermission('repos:create') ||
          (hasRepoPermission('repos:execute') && activeBatchId !== null)
        ) {
          setBatchImportOpen(true)
        }
      }}
    >
      {t(canCreate ? 'repos.batchImport.button' : 'repos.batchImport.retry')}
    </button>
  ) : undefined
  const reposPanelIds = tabDomIds('repos-resource', 'repos')
  const groupsPanelIds = tabDomIds('repos-resource', 'groups')

  return (
    <div className="page page--operations repos-page page--repo-operations">
      <div className="operations-surface">
        <PageHeader
          title={t('repos.pageTitle')}
          actions={
            tab === 'groups' ? newGroupAction : isInitialEmpty ? undefined : batchImportAction
          }
          className="operations-surface__header"
        >
          <p className="operations-surface__subtitle">
            {tab === 'groups' ? t('repoGroups.subtitle') : t('repos.operations.subtitle')}
          </p>
        </PageHeader>

        <TabBar<'repos' | 'groups'>
          active={tab}
          onSelect={selectTab}
          ariaLabel={t('repoGroups.tabAria')}
          idPrefix="repos-resource"
          rootTestid="repos-tab"
          className="repo-kind-tabs"
          tabs={[
            {
              key: 'repos',
              testid: 'repos-tab-repos',
              label: (
                <span className="repo-kind-tabs__label">
                  {REPO_ICON}
                  {t('repos.remoteTab')}
                </span>
              ),
            },
            {
              key: 'groups',
              testid: 'repos-tab-groups',
              label: (
                <span className="repo-kind-tabs__label">
                  {FOLDER_ICON}
                  {t('repoGroups.tabLabel')}
                </span>
              ),
            },
          ]}
        />

        <div
          role="tabpanel"
          id={groupsPanelIds.panelId}
          aria-labelledby={groupsPanelIds.tabId}
          hidden={tab !== 'groups'}
        >
          <RepoGroupsPane
            list={groupList}
            search={groupSearch}
            onSearchChange={setGroupSearch}
            onEdit={(g) => {
              if (!hasRepoPermission('repos:update')) return
              setEditing(g)
              setEditorOpen(true)
            }}
            onDelete={(g) => {
              if (!hasRepoPermission('repos:delete')) return
              setDeleteConflict(null)
              setDeleteReport(null)
              setPendingGroupDelete(g)
            }}
            deleteError={canDelete && pendingGroupDelete === null ? removeGroup.error : null}
            newAction={newGroupAction}
            canUpdate={canUpdate}
            canDelete={canDelete}
          />
          {deleteReport !== null && (
            <div className="info-box" role="status" data-testid="repo-group-delete-report">
              {deleteReport}
            </div>
          )}
        </div>
        <ConfirmDialog
          key={groupDeleteSession}
          open={canDelete && pendingGroupDelete !== null}
          title={t('repoGroups.deleteTitle')}
          description={
            deleteConflict === 'references'
              ? t('repoGroups.deleteConflictBody', { name: pendingGroupDelete?.name ?? '' })
              : t('repoGroups.deleteBody', {
                  name: pendingGroupDelete?.name ?? '',
                  memories: pendingGroupDelete?.boundMemories ?? 0,
                })
          }
          confirmLabel={
            deleteConflict === 'references' ? t('repoGroups.deleteForce') : t('common.delete')
          }
          tone="danger"
          onConfirm={async () => {
            if (!hasRepoPermission('repos:delete') || pendingGroupDelete === null) return
            const target = pendingGroupDelete
            try {
              await removeGroup.mutateAsync({
                id: target.id,
                ...(deleteConflict === 'references' ? { force: true } : {}),
              })
            } catch (error) {
              if (
                (error as { code?: string }).code === 'repo-group-has-references' &&
                hasRepoPermission('repos:delete')
              ) {
                // ConfirmDialog normally closes after a fulfilled callback.
                // Remount its local operation session so pending resets while
                // this same named target remains available for the explicit
                // force retry, without rendering the 409 a second time.
                resetRemoveGroupMutation()
                suppressNextGroupDeleteCloseRef.current = true
                setGroupDeleteSession((session) => session + 1)
                return
              }
              throw error
            }
          }}
          onClose={() => {
            // A handled 409 fulfills ConfirmDialog's callback, which normally
            // closes the dialog. Keep this one close tied to the failed
            // session suppressed; the keyed replacement resets pending state.
            if (suppressNextGroupDeleteCloseRef.current) {
              suppressNextGroupDeleteCloseRef.current = false
              return
            }
            setPendingGroupDelete(null)
            setDeleteConflict(null)
          }}
        />
        {editorOpen && (
          <RepoGroupEditor
            open
            canWrite={editing === undefined ? canCreate : canUpdate}
            hasWritePermission={() =>
              hasRepoPermission(editing === undefined ? 'repos:create' : 'repos:update')
            }
            onClose={() => setEditorOpen(false)}
            {...(editing !== undefined ? { group: editing } : {})}
          />
        )}

        <div
          role="tabpanel"
          id={reposPanelIds.panelId}
          aria-labelledby={reposPanelIds.tabId}
          hidden={tab !== 'repos'}
        >
          {!isInitialEmpty && (
            <OperationsToolbar<RepoOperationsView>
              view={view}
              onViewChange={setView}
              views={REPO_OPERATIONS_VIEWS.map((value) => ({
                value,
                label: t(`repos.operations.views.${value}`),
                count: facets[value],
              }))}
              viewAria={t('repos.operations.viewAria')}
              searchValue={search}
              onSearchChange={setSearch}
              searchPlaceholder={t('repos.operations.searchPlaceholder')}
              searchLabel={t('repos.operations.searchLabel')}
              filterLabel={t('repos.operations.filters')}
              activeFilterCount={advancedFilterCount}
              activeFiltersLabel={(count) => t('repos.operations.activeFilters', { count })}
              onOpenFilters={openFilters}
              showClear={hasAnyFilter}
              clearLabel={t('common.clearFilters')}
              onClear={clearFilters}
              testidPrefix="repos"
              disabled={list.isLoading}
              searchRef={searchRef}
              filterButtonRef={filterButtonRef}
            />
          )}

          <>
            <FeedbackStack variant="section">
              {list.error !== null && list.error !== undefined && (
                <ErrorBanner error={list.error} onRetry={() => void list.refetch()} />
              )}
              {refresh.error !== null && refresh.error !== undefined && (
                <ErrorBanner error={refresh.error} />
              )}
              {remove.error !== null && remove.error !== undefined && (
                <ErrorBanner error={remove.error} />
              )}
            </FeedbackStack>
            {list.isLoading && (
              <LoadingState label={t('repos.loading')} data-testid="repos-loading" />
            )}
            {isInitialEmpty && (
              <EmptyState
                title={t('repos.empty')}
                description={t('repos.emptyDescription')}
                icon={REPO_ICON}
                action={batchImportAction}
                data-testid="repos-empty"
              />
            )}
            {noMatches && (
              <EmptyState
                title={t('common.noMatches')}
                description={t('repos.operations.noMatchesDescription')}
                action={
                  <button type="button" className="btn" onClick={clearFilters}>
                    {t('common.clearFilters')}
                  </button>
                }
                data-testid="repos-no-matches"
              />
            )}
            {items.length > 0 && (
              <TableViewport label={t('repos.title')}>
                {/* RFC-311 T28:<table>/<tr> 换 role 化 div 网格 + VirtualList
                    窗口化(绝对定位行不能作 table-row 参与表格布局);列网格
                    声明不变,行内结构与行为逐一保留。 */}
                <div className="operations-table repo-operations" data-testid="repos-table">
                  <div className="repo-operations__head" aria-hidden="true">
                    <span>{t('repos.operations.columns.repository')}</span>
                    <span>{t('repos.operations.columns.freshness')}</span>
                    <span>{t('repos.operations.columns.usage')}</span>
                    <span>{t('repos.colActions')}</span>
                  </div>
                  <VirtualList<CachedRepo>
                    items={items}
                    itemKey={(item) => item.id}
                    estimateSize={72}
                    scrollResetKey={JSON.stringify(pageFilters)}
                    rowRole="listitem"
                    containerProps={{
                      className: 'repo-operations__list',
                      role: 'list',
                      'aria-label': t('repos.title'),
                    }}
                    tail={
                      list.hasNextPage ? (
                        <div className="repo-operations__more" role="listitem">
                          {/* 同 /tasks：名字固定 + 不 disabled，见 RFC-311 的注记。 */}
                          <button
                            type="button"
                            className="btn btn--sm"
                            aria-busy={list.isFetchingNextPage || undefined}
                            onClick={() => {
                              if (!list.isFetchingNextPage) void list.fetchNextPage()
                            }}
                          >
                            {t('repos.operations.loadMore')}
                          </button>
                          {list.isFetchingNextPage ? (
                            <span role="status" className="sr-only">
                              {t('repos.operations.loadingMore')}
                            </span>
                          ) : null}
                        </div>
                      ) : null
                    }
                    renderItem={(item) => (
                      <div className="repo-operations__row" data-testid={`repos-row-${item.id}`}>
                        <div className="repo-operations__repo">
                          <span className="operations-table__mobile-label">
                            {t('repos.operations.columns.repository')}：
                          </span>
                          <div className="repo-operations__url-line">
                            <span className="repo-operations__url" title={item.urlRedacted}>
                              {item.urlRedacted}
                            </span>
                            <SubmoduleBadge
                              hasSubmodules={item.hasSubmodules}
                              lastSubmoduleSyncOk={item.lastSubmoduleSyncOk}
                              lastSubmoduleSyncError={item.lastSubmoduleSyncError}
                            />
                          </div>
                          <div className="repo-operations__meta">
                            <code title={item.localPath}>{item.localPath}</code>
                            {item.defaultBranch !== null && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>
                                  {t('repos.operations.branch', { branch: item.defaultBranch })}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="repo-operations__freshness">
                          <span className="operations-table__mobile-label">
                            {t('repos.operations.columns.freshness')}：
                          </span>
                          <span>
                            {/* RFC-287 G7：`ensureCachedRepoIdentity` 会在**克隆之前**先登记
                                仓库身份（AC-11 的重试要靠它找回来源），这类行以 epoch 0 标记
                                「尚未取回内容」。0 是个合法时间戳，直接丢给 RelativeTime 会
                                渲染成「56 年前」——对一个从未同步过的镜像，那是假信息。 */}
                            {Date.parse(item.lastFetchedAt) === 0 ? (
                              t('repos.operations.neverFetched')
                            ) : (
                              <>
                                {t('repos.operations.fetched')}{' '}
                                <RelativeTime ts={item.lastFetchedAt} />
                              </>
                            )}
                          </span>
                          <span className="repo-operations__secondary">
                            {t('repos.operations.autoRefresh')}{' '}
                            {item.lastAutoRefreshAt === null ? (
                              t('common.emDash')
                            ) : (
                              <RelativeTime ts={item.lastAutoRefreshAt} />
                            )}
                          </span>
                        </div>
                        <div className="repo-operations__usage">
                          <span className="operations-table__mobile-label">
                            {t('repos.operations.columns.usage')}：
                          </span>
                          <strong>{item.referencingTaskCount}</strong>
                          <span>{t('repos.operations.referencingTasks')}</span>
                        </div>
                        <div className="repo-operations__actions">
                          <span className="operations-table__mobile-label">
                            {t('common.ariaActions')}：
                          </span>
                          <div className="data-table__actions">
                            {canExecute && (
                              <button
                                type="button"
                                className="btn btn--sm"
                                data-testid={`repos-refresh-${item.id}`}
                                disabled={refresh.isPending}
                                onClick={() => {
                                  if (hasRepoPermission('repos:execute')) refresh.mutate(item.id)
                                }}
                              >
                                {t('repos.refresh')}
                              </button>
                            )}
                            {canDelete && (
                              <button
                                type="button"
                                className="btn btn--sm btn--danger"
                                data-testid={`repos-delete-${item.id}`}
                                onClick={() => {
                                  if (!hasRepoPermission('repos:delete')) return
                                  if (item.referencingTaskCount > 0) setPendingDelete(item)
                                  else remove.mutate({ id: item.id })
                                }}
                              >
                                {t('repos.delete')}
                              </button>
                            )}
                            {!canExecute && !canDelete && t('common.emDash')}
                          </div>
                        </div>
                      </div>
                    )}
                  />
                </div>
              </TableViewport>
            )}
          </>
        </div>
      </div>

      <BatchImportDialog
        open={batchImportOpen && canOpenBatchDialog}
        onClose={() => setBatchImportOpen(false)}
        activeBatchId={activeBatchId}
        onActiveBatchIdChange={setActiveBatchId}
        triggerRef={batchImportTriggerRef}
        canCreate={canCreate}
        canExecute={canExecute}
        hasPermission={hasRepoPermission}
      />

      <RepoFilterDialog
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        triggerRef={filterButtonRef}
        draft={draft}
        onChange={setDraft}
        onApply={applyFilters}
        onClear={() => setDraft({ submodules: 'all', autoRefresh: 'all' })}
      />

      <Dialog
        open={canDelete && pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={t('repos.deleteConfirmTitle')}
        size="sm"
        data-testid="repos-delete-confirm"
        footer={
          <>
            <button type="button" className="btn btn--sm" onClick={() => setPendingDelete(null)}>
              {t('repos.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--danger"
              data-testid="repos-delete-confirm-action"
              onClick={() => {
                if (hasRepoPermission('repos:delete') && pendingDelete !== null) {
                  remove.mutate({ id: pendingDelete.id, force: true })
                  setPendingDelete(null)
                }
              }}
            >
              {t('repos.confirmDelete')}
            </button>
          </>
        }
      >
        <p>
          {pendingDelete !== null &&
            t('repos.deleteConfirmBody', {
              url: pendingDelete.urlRedacted,
              count: pendingDelete.referencingTaskCount,
            })}
        </p>
      </Dialog>
    </div>
  )
}

function RepoFilterDialog(props: {
  open: boolean
  onClose: () => void
  triggerRef: RefObject<HTMLButtonElement | null>
  draft: RepoFilterDraft
  onChange: (draft: RepoFilterDraft) => void
  onApply: () => void
  onClear: () => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t('repos.operations.filterTitle')}
      size="md"
      triggerRef={props.triggerRef}
      data-testid="repos-filter-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClear}>
            {t('common.clearFilters')}
          </button>
          <button type="button" className="btn btn--primary" onClick={props.onApply}>
            {t('repos.operations.applyFilters')}
          </button>
        </>
      }
    >
      <div className="form-grid operations-filter-dialog">
        <Field label={t('repos.operations.submodulesLabel')} group>
          <Segmented<RepoSubmoduleFilter>
            value={props.draft.submodules}
            onChange={(next) => props.onChange({ ...props.draft, submodules: next })}
            ariaLabel={t('repos.operations.submodulesLabel')}
            options={REPO_SUBMODULE_FILTERS.map((value) => ({
              value,
              label: t(`repos.operations.submodules.${value}`),
            }))}
          />
        </Field>
        <Field label={t('repos.operations.autoRefreshLabel')} group>
          <Segmented<RepoAutoRefreshFilter>
            value={props.draft.autoRefresh}
            onChange={(next) => props.onChange({ ...props.draft, autoRefresh: next })}
            ariaLabel={t('repos.operations.autoRefreshLabel')}
            options={REPO_AUTO_REFRESH_FILTERS.map((value) => ({
              value,
              label: t(`repos.operations.autoRefreshFilters.${value}`),
            }))}
          />
        </Field>
      </div>
    </Dialog>
  )
}
