// RFC-024 — Cached repos management page. Lists every persistent mirror the
// daemon has built for a `repoUrl`, surfaces last-fetched age + referencing
// task count, and exposes Refresh + Delete buttons. Delete on a row with
// references is confirmed via a modal that forwards `?force=1`.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CachedRepo, ListCachedReposResponse } from '@agent-workflow/shared'
import { redactGitUrl } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { LoadingState } from '@/components/LoadingState'
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

  return (
    <div className="page repos-page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('repos.title')}</h1>
          <p className="page__hint">{t('repos.hint')}</p>
        </div>
        <button
          ref={batchImportTriggerRef}
          type="button"
          className="btn btn--primary"
          data-testid="repos-batch-import-button"
          onClick={() => setBatchImportOpen(true)}
        >
          {t('repos.batchImport.button')}
        </button>
      </header>

      <BatchImportDialog
        open={batchImportOpen}
        onClose={() => setBatchImportOpen(false)}
        activeBatchId={activeBatchId}
        onActiveBatchIdChange={setActiveBatchId}
        triggerRef={batchImportTriggerRef}
      />

      {list.isLoading && <LoadingState label={t('repos.loading')} data-testid="repos-loading" />}
      {list.error !== null && list.error !== undefined && (
        <div className="error-box">{describeError(list.error)}</div>
      )}
      {!list.isLoading && items.length === 0 && (
        <EmptyState title={t('repos.empty')} data-testid="repos-empty" />
      )}

      {items.length > 0 && (
        <table className="data-table" data-testid="repos-table">
          <thead>
            <tr>
              <th>{t('repos.colUrl')}</th>
              <th>{t('repos.colLocalPath')}</th>
              <th>{t('repos.colLastFetched')}</th>
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
                  <time dateTime={item.lastFetchedAt}>{formatTimestamp(item.lastFetchedAt)}</time>
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
      )}

      {refresh.error !== null && refresh.error !== undefined && (
        <div className="error-box">{describeError(refresh.error)}</div>
      )}
      {remove.error !== null && remove.error !== undefined && (
        <div className="error-box">{describeError(remove.error)}</div>
      )}

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
              url: redactGitUrl(pendingDelete.url),
              count: pendingDelete.referencingTaskCount,
            })}
        </p>
      </Dialog>
    </div>
  )
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString()
  } catch {
    return iso
  }
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}
