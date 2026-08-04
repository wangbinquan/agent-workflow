// RFC-257 T12 — webhook 投递历史页（端点级审计，manage 权限；触发器 owner
// 的排障入口是触发器页的 fires——F-13 分层）。列表 + 详情 Dialog + 重放。
import type { WebhookDeliveryReason, WebhookDeliveryStatus } from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { Segmented } from '@/components/Segmented'
import { StatusChip, type StatusChipKind } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/webhook-deliveries',
  component: WebhookDeliveriesPage,
})

type DeliveryRow = {
  id: string
  endpointId: string
  eventUuid: string | null
  attemptCount: number
  gitlabEventHeader: string | null
  objectKind: string | null
  eventType: string | null
  repoPath: string | null
  streamHint: string | null
  status: WebhookDeliveryStatus
  statusReason: WebhookDeliveryReason | null
  replayedFromDeliveryId: string | null
  receivedAt: number
}

type DeliveryDetail = DeliveryRow & { bodyJson: string | null }

const STATUS_CHIP: Record<WebhookDeliveryStatus, StatusChipKind> = {
  received: 'info',
  processing: 'info',
  rejected: 'danger',
  ignored: 'neutral',
  matched: 'success',
  failed: 'danger',
}

type StatusFilter = 'all' | WebhookDeliveryStatus

const STATUS_FILTERS: StatusFilter[] = ['all', 'matched', 'ignored', 'rejected', 'failed']

function WebhookDeliveriesPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [status, setStatus] = useState<StatusFilter>('all')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)

  const list = useQuery({
    queryKey: ['webhook-deliveries', status],
    queryFn: ({ signal }) =>
      api.get<DeliveryRow[]>(
        '/api/webhook-deliveries',
        status === 'all' ? undefined : { status },
        signal,
      ),
    refetchInterval: 10_000,
  })
  const replay = useMutation({
    mutationFn: (id: string) =>
      api.post<{ deliveryId: string }>(`/api/webhook-deliveries/${encodeURIComponent(id)}/replay`),
    onSuccess: () => {
      setError(null)
      void qc.invalidateQueries({ queryKey: ['webhook-deliveries'] })
    },
    onError: setError,
  })

  const rows = list.data ?? []
  const isInitialEmpty = !list.isLoading && list.data !== undefined && rows.length === 0

  return (
    <div className="page">
      <PageHeader title={t('webhookDeliveries.title')}>
        <p className="muted">{t('webhookDeliveries.subtitle')}</p>
      </PageHeader>
      <div className="page__section">
        <Segmented<StatusFilter>
          value={status}
          onChange={setStatus}
          ariaLabel={t('webhookDeliveries.filterAria')}
          options={STATUS_FILTERS.map((value) => ({
            value,
            label:
              value === 'all'
                ? t('webhookDeliveries.filterAll')
                : t(`webhookDeliveries.statuses.${value}`),
          }))}
        />
      </div>
      {error !== null && <ErrorBanner error={error} />}
      {list.error != null && <ErrorBanner error={list.error} />}
      {list.isLoading && <LoadingState data-testid="webhook-deliveries-loading" />}
      {isInitialEmpty && (
        <EmptyState
          title={t('webhookDeliveries.empty')}
          description={t('webhookDeliveries.emptyDescription')}
          data-testid="webhook-deliveries-empty"
        />
      )}
      {rows.length > 0 && (
        <TableViewport label={t('webhookDeliveries.title')}>
          <table className="data-table" data-testid="webhook-deliveries-table">
            <thead>
              <tr>
                <th>{t('webhookDeliveries.columns.event')}</th>
                <th>{t('webhookDeliveries.columns.repo')}</th>
                <th>{t('webhookDeliveries.columns.status')}</th>
                <th>{t('webhookDeliveries.columns.time')}</th>
                <th aria-label={t('common.ariaActions')} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="data-table__row"
                  data-testid={`webhook-delivery-${row.id}`}
                >
                  <td>
                    <strong>{row.eventType ?? row.objectKind ?? t('common.emDash')}</strong>
                    {row.attemptCount > 1 && <span className="muted"> ×{row.attemptCount}</span>}
                    {row.replayedFromDeliveryId !== null && (
                      <StatusChip kind="info" size="sm">
                        {t('webhookDeliveries.replayBadge')}
                      </StatusChip>
                    )}
                  </td>
                  <td className="muted">{row.repoPath ?? t('common.emDash')}</td>
                  <td>
                    <StatusChip kind={STATUS_CHIP[row.status]} size="sm">
                      {t(`webhookDeliveries.statuses.${row.status}`)}
                    </StatusChip>
                    {row.statusReason !== null && (
                      <span className="muted">
                        {' '}
                        {t(`webhookDeliveries.reasons.${row.statusReason}`, {
                          defaultValue: row.statusReason,
                        })}
                      </span>
                    )}
                  </td>
                  <td className="muted">{new Date(row.receivedAt).toLocaleString()}</td>
                  <td className="data-table__actions">
                    <button
                      type="button"
                      className="btn btn--xs"
                      onClick={() => setDetailId(row.id)}
                      data-testid={`webhook-delivery-detail-${row.id}`}
                    >
                      {t('common.details')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--xs"
                      disabled={
                        row.status === 'rejected' ||
                        row.status === 'received' ||
                        row.status === 'processing' ||
                        replay.isPending
                      }
                      title={
                        row.status === 'rejected'
                          ? t('webhookDeliveries.rejectedNotReplayable')
                          : undefined
                      }
                      onClick={() => replay.mutate(row.id)}
                      data-testid={`webhook-delivery-replay-${row.id}`}
                    >
                      {t('webhookDeliveries.replay')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      )}
      {detailId !== null && (
        <DeliveryDetailDialog id={detailId} onClose={() => setDetailId(null)} />
      )}
    </div>
  )
}

function DeliveryDetailDialog(props: { id: string; onClose: () => void }) {
  const { t } = useTranslation()
  const detail = useQuery({
    queryKey: ['webhook-deliveries', 'detail', props.id],
    queryFn: ({ signal }) =>
      api.get<DeliveryDetail>(
        `/api/webhook-deliveries/${encodeURIComponent(props.id)}`,
        undefined,
        signal,
      ),
  })
  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t('webhookDeliveries.detailTitle')}
      size="lg"
      data-testid="webhook-delivery-detail-dialog"
    >
      {detail.isLoading && <LoadingState />}
      {detail.error != null && <ErrorBanner error={detail.error} />}
      {detail.data !== undefined && (
        <div className="form-grid">
          <p className="muted">
            {detail.data.gitlabEventHeader ?? ''} · {detail.data.eventUuid ?? t('common.emDash')} ·{' '}
            {detail.data.streamHint ?? ''}
          </p>
          <pre className="task-output-card__body" data-testid="webhook-delivery-body">
            {detail.data.bodyJson === null
              ? t('webhookDeliveries.bodyPruned')
              : detail.data.bodyJson}
          </pre>
        </div>
      )}
    </Dialog>
  )
}
