// RFC-024 — Cached repos management page. Lists every persistent mirror the
// daemon has built for a `repoUrl`, surfaces last-fetched age + referencing
// task count, and exposes Refresh + Delete buttons. Delete on a row with
// references is confirmed via a modal that forwards `?force=1`.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CachedRepo, ListCachedReposResponse } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { RelativeTime } from '@/components/RelativeTime'
import { TableViewport } from '@/components/TableViewport'
import { REPO_ICON } from '@/components/icons/resourceIcons'
import { BatchImportDialog } from '@/components/repos/BatchImportDialog'
import { SubmoduleBadge } from '@/components/repos/SubmoduleBadge'
import { Route as RootRoute } from './__root'

const BATCH_ID_LS_KEY = 'repo-import-batch-id'

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
  // Captured so the Dialog can restore focus here on close, even on
  // Safari/WebKit where mouse-clicking a <button> doesn't capture it
  // via `document.activeElement`. See e2e/keyboard-flows.spec.ts.
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

  const items = list.data?.items ?? []
  const isInitialEmpty = !list.isLoading && list.data !== undefined && items.length === 0
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
    <div className="page repos-page">
      <PageHeader
        title={t('repos.title')}
        actions={isInitialEmpty ? undefined : batchImportAction}
      />

      <BatchImportDialog
        open={batchImportOpen}
        onClose={() => setBatchImportOpen(false)}
        activeBatchId={activeBatchId}
        onActiveBatchIdChange={setActiveBatchId}
        triggerRef={batchImportTriggerRef}
      />

      {list.isLoading && <LoadingState label={t('repos.loading')} data-testid="repos-loading" />}
      {list.error !== null && list.error !== undefined && (
        <ErrorBanner error={list.error} onRetry={() => void list.refetch()} />
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

      {items.length > 0 && (
        <TableViewport label={t('repos.title')}>
          <table className="data-table" data-testid="repos-table">
            <thead>
              <tr>
                <th>{t('repos.colUrl')}</th>
                <th>{t('repos.colLocalPath')}</th>
                <th>{t('repos.colLastFetched')}</th>
                <th>{t('repos.colLastAutoRefresh')}</th>
                <th>{t('repos.colRefs')}</th>
                <th>{t('repos.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} data-testid={`repos-row-${item.id}`}>
                  <td className="data-table__truncate">
                    {item.urlRedacted}{' '}
                    <SubmoduleBadge
                      hasSubmodules={item.hasSubmodules}
                      lastSubmoduleSyncOk={item.lastSubmoduleSyncOk}
                      lastSubmoduleSyncError={item.lastSubmoduleSyncError}
                    />
                  </td>
                  <td className="data-table__truncate">{item.localPath}</td>
                  <td>
                    {/* RFC-192 (D4/D5): list-layer relative time; the ISO string
                      rides <RelativeTime>'s string contract (Date.parse). */}
                    <RelativeTime ts={item.lastFetchedAt} />
                  </td>
                  <td>
                    {/* RFC-210: distinct from lastFetched — that one also moves
                        on every task launch, this is the background loop alone. */}
                    {item.lastAutoRefreshAt === null ? (
                      <span className="data-table__muted">{t('common.emDash')}</span>
                    ) : (
                      <RelativeTime ts={item.lastAutoRefreshAt} />
                    )}
                  </td>
                  <td>{item.referencingTaskCount}</td>
                  <td>
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

      {refresh.error !== null && refresh.error !== undefined && (
        <ErrorBanner error={refresh.error} />
      )}
      {remove.error !== null && remove.error !== undefined && <ErrorBanner error={remove.error} />}

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
