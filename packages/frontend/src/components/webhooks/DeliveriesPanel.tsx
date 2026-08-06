// RFC-257 UI 修订 — 投递审计面板（/webhooks 单页的 deliveries tab；原独立
// 路由 /webhook-deliveries 并入）。列表 + 详情 Dialog + 重放。
import type { WebhookDeliveryReason, WebhookDeliveryStatus } from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FeedbackStack } from '@/components/FeedbackStack'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { RelativeTime } from '@/components/RelativeTime'
import { Segmented } from '@/components/Segmented'
import { StatusChip, type StatusChipKind } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'

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

/** RFC-260：isAdmin=false 渲染只读视图（replay 隐藏；列表与详情照常）。 */
export function DeliveriesPanel({ isAdmin = false }: { isAdmin?: boolean } = {}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [status, setStatus] = useState<StatusFilter>('all')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [replayedDeliveryId, setReplayedDeliveryId] = useState<string | null>(null)

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
    onSuccess: ({ deliveryId }) => {
      setError(null)
      setReplayedDeliveryId(deliveryId)
      void qc.invalidateQueries({ queryKey: ['webhook-deliveries'] })
    },
    onError: setError,
  })

  const rows = list.data ?? []
  const isInitialEmpty = !list.isLoading && list.data !== undefined && rows.length === 0

  return (
    <section className="webhook-panel" data-testid="webhook-deliveries-panel">
      <div className="webhook-panel__intro">
        <div>
          <span className="webhook-panel__eyebrow">{t('webhookDeliveries.eyebrow')}</span>
          <h2>{t('webhookDeliveries.title')}</h2>
          <p>{t('webhookDeliveries.subtitle')}</p>
        </div>
      </div>
      <div className="webhook-filterbar">
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
        {!list.isLoading && (
          <span className="muted">
            {t('webhookDeliveries.resultCount', { count: rows.length })}
          </span>
        )}
      </div>
      <FeedbackStack variant="section">
        {error !== null && <ErrorBanner error={error} />}
        {list.error != null && <ErrorBanner error={list.error} />}
        {replayedDeliveryId !== null && (
          <NoticeBanner
            tone="success"
            size="compact"
            dismiss={{
              label: t('common.close'),
              onDismiss: () => setReplayedDeliveryId(null),
            }}
          >
            {t('webhookDeliveries.replaySuccess', { id: replayedDeliveryId })}
          </NoticeBanner>
        )}
      </FeedbackStack>
      {list.isLoading && <LoadingState data-testid="webhook-deliveries-loading" />}
      {isInitialEmpty && (
        <EmptyState
          title={t(
            status === 'all' ? 'webhookDeliveries.empty' : 'webhookDeliveries.filteredEmpty',
          )}
          description={t(
            status === 'all'
              ? 'webhookDeliveries.emptyDescription'
              : 'webhookDeliveries.filteredEmptyDescription',
          )}
          data-testid="webhook-deliveries-empty"
        />
      )}
      {rows.length > 0 && (
        <TableViewport label={t('webhookDeliveries.title')}>
          <table
            className="data-table webhook-deliveries-table"
            data-testid="webhook-deliveries-table"
          >
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
                    <strong>
                      {row.eventType === null
                        ? (row.objectKind ?? t('common.emDash'))
                        : t(`webhookTriggers.events.${row.eventType}`, {
                            defaultValue: row.eventType,
                          })}
                    </strong>
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
                  <td className="muted">
                    <RelativeTime ts={row.receivedAt} />
                  </td>
                  <td className="data-table__actions">
                    <button
                      type="button"
                      className="btn btn--xs"
                      onClick={() => setDetailId(row.id)}
                      data-testid={`webhook-delivery-detail-${row.id}`}
                    >
                      {t('common.details')}
                    </button>
                    {isAdmin && (
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
                    )}
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
    </section>
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
        <div className="form-grid webhook-delivery-detail">
          <dl className="webhook-facts webhook-delivery-detail__facts">
            <div>
              <dt>{t('webhookDeliveries.detail.status')}</dt>
              <dd>
                <StatusChip kind={STATUS_CHIP[detail.data.status]} size="sm">
                  {t(`webhookDeliveries.statuses.${detail.data.status}`)}
                </StatusChip>
              </dd>
            </div>
            <div>
              <dt>{t('webhookDeliveries.detail.event')}</dt>
              <dd>
                {detail.data.eventType === null
                  ? (detail.data.objectKind ?? t('common.emDash'))
                  : t(`webhookTriggers.events.${detail.data.eventType}`, {
                      defaultValue: detail.data.eventType,
                    })}
              </dd>
            </div>
            <div>
              <dt>{t('webhookDeliveries.detail.repo')}</dt>
              <dd>{detail.data.repoPath ?? t('common.emDash')}</dd>
            </div>
            <div>
              <dt>{t('webhookDeliveries.detail.received')}</dt>
              <dd>{new Date(detail.data.receivedAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t('webhookDeliveries.detail.uuid')}</dt>
              <dd>
                <code>{detail.data.eventUuid ?? t('common.emDash')}</code>
              </dd>
            </div>
            <div>
              <dt>{t('webhookDeliveries.detail.stream')}</dt>
              <dd>
                <code>{detail.data.streamHint ?? t('common.emDash')}</code>
              </dd>
            </div>
          </dl>
          <div>
            <h3 className="webhook-delivery-detail__body-title">
              {t('webhookDeliveries.detail.payload')}
            </h3>
            <pre className="task-output-card__body" data-testid="webhook-delivery-body">
              {detail.data.bodyJson === null
                ? t('webhookDeliveries.bodyPruned')
                : formatPayload(detail.data.bodyJson)}
            </pre>
          </div>
        </div>
      )}
    </Dialog>
  )
}

function formatPayload(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}
