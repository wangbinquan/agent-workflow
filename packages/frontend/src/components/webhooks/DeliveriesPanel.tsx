// RFC-257 UI 修订 — 投递审计面板（/webhooks 单页的 deliveries tab；原独立
// 路由 /webhook-deliveries 并入）。列表 + 详情 Dialog + 重放。
// RFC-261 — 服务端页码分页（{items,total,page,pageCount} 封套）+ 事件 / 仓库过滤。
import {
  CODE_HOST_EVENT_TYPES,
  type CodeHostEventType,
  type WebhookDeliveryReason,
  type WebhookDeliveryStatus,
} from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FeedbackStack } from '@/components/FeedbackStack'
import { FilterBar, FilterField } from '@/components/FilterBar'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { Pagination } from '@/components/Pagination'
import { RelativeTime } from '@/components/RelativeTime'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
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

type TerminalControlTarget = {
  taskId: string
  priorStatus: string | null
  currentStatus: string
  fenceOutcome: string
  cancelOutcome: string
  releaseOutcome: string
  error: string | null
  workspace: { spaceKind: string | null; state: 'retained' | 'pruning' | 'pruned' }
}

type TerminalControlAudit = {
  kind: 'fence-closed' | 'fence-merged' | 'clear-closed'
  observedEventType: 'mr_opened' | 'mr_closed' | 'mr_merged'
  status: 'pending' | 'leased' | 'waiting-launches' | 'retryable' | 'succeeded'
  revision: number
  attemptCount: number
  lastError: string | null
  totalTargetCount: number
  hiddenTargetCount: number
  targets: TerminalControlTarget[]
}

type DeliveryDetail = DeliveryRow & {
  bodyJson: string | null
  terminalControl: TerminalControlAudit | null
}

/** RFC-261 列表封套（tasks /api/tasks/page 同款形态）。 */
type DeliveryPage = {
  items: DeliveryRow[]
  total: number
  page: number
  pageCount: number
}

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
  const [eventType, setEventType] = useState<'all' | CodeHostEventType>('all')
  const [repoPath, setRepoPath] = useState<string>('all')
  const [page, setPage] = useState(1)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [replayedDeliveryId, setReplayedDeliveryId] = useState<string | null>(null)

  const list = useQuery({
    queryKey: ['webhook-deliveries', status, eventType, repoPath, page],
    queryFn: ({ signal }) =>
      api.get<DeliveryPage>(
        '/api/webhook-deliveries',
        {
          status: status === 'all' ? undefined : status,
          eventType: eventType === 'all' ? undefined : eventType,
          repoPath: repoPath === 'all' ? undefined : repoPath,
          page,
        },
        signal,
      ),
    refetchInterval: 10_000,
  })
  // 仓库下拉选项源（保留窗内出现过的仓库；D5）。事件流通常低频，30s 足够新鲜。
  const repos = useQuery({
    queryKey: ['webhook-deliveries', 'repos'],
    queryFn: ({ signal }) => api.get<string[]>('/api/webhook-deliveries/repos', undefined, signal),
    refetchInterval: 30_000,
  })
  // 页码钳制（AC-7）：过滤切换/GC 让 total 缩水时钳回末页，不停留在空页。
  const pageCount = list.data?.pageCount ?? 1
  useEffect(() => {
    if (list.data !== undefined && page > list.data.pageCount) setPage(list.data.pageCount)
  }, [list.data, page])
  // 选中仓库已滚出选项列表（30s 刷新窗）时补渲染，避免闭合态显示空 label；
  // 补入后重排保持与 /repos 相同的字典升序（评审门 P2-⑥）。
  const repoOptions = useMemo(() => {
    const known = repos.data ?? []
    if (repoPath === 'all' || known.includes(repoPath)) return known
    return [...known, repoPath].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  }, [repos.data, repoPath])
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

  const rows = list.data?.items ?? []
  const hasFilter = status !== 'all' || eventType !== 'all' || repoPath !== 'all'
  // UI 修订：此前整页没有清除入口，而空态文案却让用户「清除筛选」。
  const clearFilters = () => {
    setStatus('all')
    setEventType('all')
    setRepoPath('all')
    setPage(1)
  }
  // 空态看 total 而非当前页 items（越界页 items 为空但 total>0，由钳制效应接管）。
  const isInitialEmpty = !list.isLoading && list.data !== undefined && list.data.total === 0

  return (
    <section className="webhook-panel" data-testid="webhook-deliveries-panel">
      <div className="webhook-panel__intro">
        <div>
          <span className="webhook-panel__eyebrow">{t('webhookDeliveries.eyebrow')}</span>
          <h2>{t('webhookDeliveries.title')}</h2>
          <p>{t('webhookDeliveries.subtitle')}</p>
        </div>
      </div>
      <FilterBar
        ariaLabel={t('webhookDeliveries.filtersLabel')}
        data-testid="webhook-deliveries-filters"
        trailing={
          hasFilter ? (
            <button
              type="button"
              className="btn btn--sm"
              onClick={clearFilters}
              data-testid="webhook-deliveries-clear-filters"
            >
              {t('common.clearFilters')}
            </button>
          ) : undefined
        }
      >
        <Segmented<StatusFilter>
          value={status}
          onChange={(value) => {
            setStatus(value)
            setPage(1)
          }}
          ariaLabel={t('webhookDeliveries.filterAria')}
          options={STATUS_FILTERS.map((value) => ({
            value,
            label:
              value === 'all'
                ? t('webhookDeliveries.filterAll')
                : t(`webhookDeliveries.statuses.${value}`),
          }))}
        />
        <FilterField label={t('webhookDeliveries.filterEventLabel')}>
          <Select<'all' | CodeHostEventType>
            value={eventType}
            onChange={(value) => {
              setEventType(value)
              setPage(1)
            }}
            options={[
              { value: 'all', label: t('webhookDeliveries.filterAllEvents') },
              ...CODE_HOST_EVENT_TYPES.map((value) => ({
                value,
                label: t(`webhookTriggers.events.${value}`),
              })),
            ]}
            ariaLabel={t('webhookDeliveries.filterEventAria')}
            data-testid="webhook-delivery-filter-event"
          />
        </FilterField>
        <FilterField label={t('webhookDeliveries.filterRepoLabel')}>
          <Select
            value={repoPath}
            onChange={(value) => {
              setRepoPath(value)
              setPage(1)
            }}
            options={[
              { value: 'all', label: t('webhookDeliveries.filterAllRepos') },
              ...repoOptions.map((repo) => ({ value: repo, label: repo })),
            ]}
            ariaLabel={t('webhookDeliveries.filterRepoAria')}
            data-testid="webhook-delivery-filter-repo"
          />
        </FilterField>
      </FilterBar>
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
          title={t(hasFilter ? 'webhookDeliveries.filteredEmpty' : 'webhookDeliveries.empty')}
          description={t(
            hasFilter
              ? 'webhookDeliveries.filteredEmptyDescription'
              : 'webhookDeliveries.emptyDescription',
          )}
          // 筛选后无结果时给出路（user-directory 空态同款）。
          action={
            hasFilter ? (
              <button
                type="button"
                className="btn btn--sm"
                onClick={clearFilters}
                data-testid="webhook-deliveries-empty-clear"
              >
                {t('common.clearFilters')}
              </button>
            ) : undefined
          }
          data-testid="webhook-deliveries-empty"
        />
      )}
      {!list.isLoading && list.data !== undefined && list.data.total > 0 && (
        <p className="webhook-deliveries__meta" data-testid="webhook-deliveries-total">
          {t('webhookDeliveries.totalCount', { total: list.data.total })}
        </p>
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
      {rows.length > 0 && (
        <Pagination
          page={page}
          pageCount={pageCount}
          onPageChange={setPage}
          data-testid="webhook-deliveries-pagination"
        />
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
          {detail.data.terminalControl !== null && (
            <section data-testid="webhook-terminal-control-audit">
              <h3 className="webhook-delivery-detail__body-title">
                {t('webhookDeliveries.terminalControl.title')}
              </h3>
              <dl className="webhook-facts webhook-delivery-detail__facts">
                <div>
                  <dt>{t('webhookDeliveries.terminalControl.kind')}</dt>
                  <dd>
                    {t(
                      `webhookDeliveries.terminalControl.kinds.${detail.data.terminalControl.kind}`,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t('webhookDeliveries.terminalControl.status')}</dt>
                  <dd>
                    {t(
                      `webhookDeliveries.terminalControl.statuses.${detail.data.terminalControl.status}`,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t('webhookDeliveries.terminalControl.revision')}</dt>
                  <dd>{detail.data.terminalControl.revision}</dd>
                </div>
                <div>
                  <dt>{t('webhookDeliveries.terminalControl.targets')}</dt>
                  <dd>{detail.data.terminalControl.totalTargetCount}</dd>
                </div>
              </dl>
              {detail.data.terminalControl.hiddenTargetCount > 0 && (
                <p className="muted" data-testid="webhook-terminal-control-hidden-targets">
                  {t('webhookDeliveries.terminalControl.hiddenTargets', {
                    count: detail.data.terminalControl.hiddenTargetCount,
                  })}
                </p>
              )}
              {detail.data.terminalControl.targets.length > 0 && (
                <TableViewport label={t('webhookDeliveries.terminalControl.targetTable')}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>{t('webhookDeliveries.terminalControl.task')}</th>
                        <th>{t('webhookDeliveries.terminalControl.cancel')}</th>
                        <th>{t('webhookDeliveries.terminalControl.release')}</th>
                        <th>{t('webhookDeliveries.terminalControl.workspace')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.data.terminalControl.targets.map((target) => (
                        <tr key={target.taskId}>
                          <td>
                            <Link to="/tasks/$id" params={{ id: target.taskId }} className="link">
                              {target.taskId}
                            </Link>
                          </td>
                          <td>
                            {t(
                              `webhookDeliveries.terminalControl.cancelOutcomes.${target.cancelOutcome}`,
                            )}
                          </td>
                          <td>
                            {t(
                              `webhookDeliveries.terminalControl.releaseOutcomes.${target.releaseOutcome}`,
                            )}
                          </td>
                          <td>
                            {t(
                              `webhookDeliveries.terminalControl.workspaceStates.${target.workspace.state}`,
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableViewport>
              )}
              {detail.data.terminalControl.lastError !== null && (
                <p className="muted">{detail.data.terminalControl.lastError}</p>
              )}
            </section>
          )}
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
