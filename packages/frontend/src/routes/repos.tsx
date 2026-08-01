// RFC-024 → RFC-246 — cached-repo operations surface. The wire remains
// redacted and every refresh/delete/batch-import behavior is preserved.

import type { CachedRepo, ListCachedReposResponse } from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
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
import { Segmented } from '@/components/Segmented'
import { TableViewport } from '@/components/TableViewport'
import { REPO_ICON } from '@/components/icons/resourceIcons'
import {
  REPO_OPERATIONS_VIEWS,
  filterRepoOperations,
  repoOperationsFacets,
  type RepoAutoRefreshFilter,
  type RepoOperationsView,
  type RepoSubmoduleFilter,
} from '@/lib/operations-filters'
import { Route as RootRoute } from './__root'

const BATCH_ID_LS_KEY = 'repo-import-batch-id'
const REPO_SUBMODULE_FILTERS = ['all', 'with', 'without'] as const
const REPO_AUTO_REFRESH_FILTERS = ['all', 'refreshed', 'never'] as const

interface RepoFilterDraft {
  submodules: RepoSubmoduleFilter
  autoRefresh: RepoAutoRefreshFilter
}

export const ReposRoute = createRoute({
  getParentRoute: () => RootRoute,
  path: '/repos',
  component: ReposPage,
})

function ReposPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const list = useQuery<ListCachedReposResponse>({
    queryKey: ['cached-repos'],
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
  })

  const refresh = useMutation({
    mutationFn: (id: string) => api.post(`/api/cached-repos/${encodeURIComponent(id)}/refresh`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cached-repos'] }),
  })
  const remove = useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) =>
      api.delete(`/api/cached-repos/${encodeURIComponent(id)}${force ? '?force=1' : ''}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cached-repos'] }),
  })

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

  const items = useMemo(() => list.data?.items ?? [], [list.data?.items])
  const facets = useMemo(() => repoOperationsFacets(items), [items])
  const filtered = useMemo(
    () => filterRepoOperations(items, { view, q: search, submodules, autoRefresh }),
    [autoRefresh, items, search, submodules, view],
  )
  const advancedFilterCount = Number(submodules !== 'all') + Number(autoRefresh !== 'all')
  const hasAnyFilter = view !== 'all' || search.trim() !== '' || advancedFilterCount > 0
  const isInitialEmpty = !list.isLoading && list.data !== undefined && items.length === 0
  const noMatches =
    !list.isLoading && list.error == null && items.length > 0 && filtered.length === 0

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

  const batchImportAction = (
    <button
      ref={batchImportTriggerRef}
      type="button"
      className="btn btn--primary"
      data-testid="repos-batch-import-button"
      onClick={() => setBatchImportOpen(true)}
    >
      {t('repos.batchImport.button')}
    </button>
  )

  return (
    <div className="page page--operations repos-page page--repo-operations">
      <div className="operations-surface">
        <PageHeader
          title={t('repos.title')}
          actions={isInitialEmpty ? undefined : batchImportAction}
          className="operations-surface__header"
        >
          <p className="operations-surface__subtitle">{t('repos.operations.subtitle')}</p>
        </PageHeader>

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
        {list.isLoading && <LoadingState label={t('repos.loading')} data-testid="repos-loading" />}
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
        {filtered.length > 0 && (
          <TableViewport label={t('repos.title')}>
            <table
              className="data-table operations-table repo-operations"
              data-testid="repos-table"
            >
              <thead>
                <tr>
                  <th>{t('repos.operations.columns.repository')}</th>
                  <th>{t('repos.operations.columns.freshness')}</th>
                  <th>{t('repos.operations.columns.usage')}</th>
                  <th>{t('repos.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => (
                  <tr
                    key={item.id}
                    className="repo-operations__row"
                    data-testid={`repos-row-${item.id}`}
                  >
                    <td className="repo-operations__repo">
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
                    </td>
                    <td className="repo-operations__freshness">
                      <span className="operations-table__mobile-label">
                        {t('repos.operations.columns.freshness')}：
                      </span>
                      <span>
                        {t('repos.operations.fetched')} <RelativeTime ts={item.lastFetchedAt} />
                      </span>
                      <span className="repo-operations__secondary">
                        {t('repos.operations.autoRefresh')}{' '}
                        {item.lastAutoRefreshAt === null ? (
                          t('common.emDash')
                        ) : (
                          <RelativeTime ts={item.lastAutoRefreshAt} />
                        )}
                      </span>
                    </td>
                    <td className="repo-operations__usage">
                      <span className="operations-table__mobile-label">
                        {t('repos.operations.columns.usage')}：
                      </span>
                      <strong>{item.referencingTaskCount}</strong>
                      <span>{t('repos.operations.referencingTasks')}</span>
                    </td>
                    <td className="repo-operations__actions">
                      <span className="operations-table__mobile-label">
                        {t('common.ariaActions')}：
                      </span>
                      <div className="data-table__actions">
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={refresh.isPending}
                          onClick={() => refresh.mutate(item.id)}
                        >
                          {t('repos.refresh')}
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm btn--danger"
                          onClick={() =>
                            item.referencingTaskCount > 0
                              ? setPendingDelete(item)
                              : remove.mutate({ id: item.id })
                          }
                        >
                          {t('repos.delete')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        )}
      </div>

      <BatchImportDialog
        open={batchImportOpen}
        onClose={() => setBatchImportOpen(false)}
        activeBatchId={activeBatchId}
        onActiveBatchIdChange={setActiveBatchId}
        triggerRef={batchImportTriggerRef}
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
        open={pendingDelete !== null}
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
                if (pendingDelete !== null) {
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
