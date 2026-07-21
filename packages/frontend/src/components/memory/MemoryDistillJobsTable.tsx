// RFC-041 PR4 — admin monitoring table for the distill queue.
// Lists rows + per-row [Retry] (failed → pending) / [Cancel] (pending → canceled).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import type { MemoryDistillJob } from '@agent-workflow/shared'
import type { ApiError } from '@/api/client'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { TableViewport } from '@/components/TableViewport'

interface ListResponse {
  items: MemoryDistillJob[]
}

export function MemoryDistillJobsTable() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const list = useQuery<ListResponse>({
    queryKey: ['memory-distill-jobs', 'list'],
    queryFn: ({ signal }) => api.get<ListResponse>('/api/memory-distill-jobs', undefined, signal),
  })

  const action = useMutation<unknown, ApiError, { id: string; verb: 'retry' | 'cancel' }>({
    mutationFn: ({ id, verb }) =>
      api.post(`/api/memory-distill-jobs/${encodeURIComponent(id)}/${verb}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['memory-distill-jobs', 'list'] })
    },
  })

  const listError = list.error !== null && list.error !== undefined
  if (list.data === undefined) {
    if (list.isLoading) return <LoadingState />
    if (listError) {
      return <ErrorBanner error={list.error} onRetry={() => void list.refetch()} />
    }
    return <LoadingState />
  }
  const rows = list.data.items
  if (rows.length === 0) {
    return (
      <>
        {listError && <ErrorBanner error={list.error} onRetry={() => void list.refetch()} />}
        <EmptyState
          title={t('memory.distillJobs.empty')}
          description={t('memory.distillJobs.emptyDescription')}
        />
      </>
    )
  }

  return (
    <div className="memory-distill-jobs" data-testid="memory-distill-jobs">
      {listError && <ErrorBanner error={list.error} onRetry={() => void list.refetch()} />}
      <TableViewport label={t('memory.tab.distillJobs')} minWidth="lg">
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('memory.distillJobs.colId')}</th>
              <th>{t('memory.distillJobs.colStatus')}</th>
              <th>{t('memory.distillJobs.colSource')}</th>
              <th>{t('memory.distillJobs.colAttempts')}</th>
              <th>{t('memory.distillJobs.colCreated')}</th>
              <th>{t('memory.distillJobs.colError')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((job) => (
              <tr
                key={job.id}
                data-testid={`distill-job-row-${job.id}`}
                className="memory-distill-jobs__row"
                onClick={() =>
                  // RFC-043: whole-row click jumps to the admin detail
                  // page. Retry / Cancel buttons stop propagation so they
                  // remain row-local controls.
                  void navigate({
                    to: '/memory/distill-jobs/$jobId',
                    params: { jobId: job.id },
                  })
                }
                style={{ cursor: 'pointer' }}
              >
                <td>
                  <code>{job.id}</code>
                </td>
                <td>
                  <span className={`memory-distill-status memory-distill-status--${job.status}`}>
                    {t(`memory.distillJobs.status.${job.status}`)}
                  </span>
                </td>
                <td>{t(`memory.sourceKind.${job.sourceKind}`)}</td>
                <td>{job.attempts}</td>
                <td className="muted">{new Date(job.createdAt).toLocaleString()}</td>
                <td className="memory-distill-status__error">{job.lastError ?? ''}</td>
                <td>
                  {job.status === 'failed' && (
                    <button
                      type="button"
                      className="btn btn--xs"
                      onClick={(e) => {
                        e.stopPropagation()
                        action.mutate({ id: job.id, verb: 'retry' })
                      }}
                      disabled={action.isPending}
                      data-testid={`distill-job-row-${job.id}-retry`}
                    >
                      {t('memory.distillJobs.action.retry')}
                    </button>
                  )}
                  {job.status === 'pending' && (
                    <button
                      type="button"
                      className="btn btn--xs"
                      onClick={(e) => {
                        e.stopPropagation()
                        action.mutate({ id: job.id, verb: 'cancel' })
                      }}
                      disabled={action.isPending}
                      data-testid={`distill-job-row-${job.id}-cancel`}
                    >
                      {t('memory.distillJobs.action.cancel')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableViewport>
      {action.error !== null && action.error !== undefined && <ErrorBanner error={action.error} />}
    </div>
  )
}
