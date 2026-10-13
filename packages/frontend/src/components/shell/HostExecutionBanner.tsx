import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  HostExecutionGroupSchema,
  isHostExecutionGroupReady,
  type HostExecutionStatus,
  HostExecutionStatusSchema,
} from '@agent-workflow/shared'
import { ErrorBanner } from '@/components/ErrorBanner'
import { NoticeBanner } from '@/components/NoticeBanner'
import {
  useHostExecutionStatus,
  HOST_EXECUTION_STATUS_QUERY_KEY,
} from '@/hooks/useHostExecutionStatus'
import { usePermission } from '@/hooks/useActor'
import { api } from '@/api/client'

/** Presentation is shared with action guards; it never starts an owner. */
export function HostExecutionNotice({
  view,
  action,
}: {
  view: HostExecutionStatus
  action?: ReactNode
}) {
  const { t } = useTranslation()
  if (view.mode === 'native') return null
  if (view.mode === 'resource-only')
    return (
      <NoticeBanner
        tone="info"
        title={t('hostExecution.resourceOnly')}
        testid="host-execution-status"
      >
        {t('hostExecution.resourceOnlyDescription')}
      </NoticeBanner>
    )
  const unavailable = HostExecutionGroupSchema.options.filter(
    (group) => !isHostExecutionGroupReady(view, group),
  )
  if (unavailable.length === 0) return null
  const available = HostExecutionGroupSchema.options.filter((group) =>
    isHostExecutionGroupReady(view, group),
  )
  const names = (groups: typeof unavailable) =>
    groups.map((group) => t(`hostExecution.group.${group}`)).join(', ')
  const title =
    view.status.phase === 'active'
      ? t('hostExecution.partial')
      : t(`hostExecution.${view.status.phase}`)
  return (
    <NoticeBanner tone="warning" title={title} testid="host-execution-status" action={action}>
      {available.length > 0 && (
        <p>{t('hostExecution.activeDescription', { groups: names(available) })}</p>
      )}
      <p>{t('hostExecution.unavailable', { groups: names(unavailable) })}</p>
      {action && <p>{t('hostExecution.recoveryBeforeRetry')}</p>}
    </NoticeBanner>
  )
}

export function HostExecutionBanner() {
  const query = useHostExecutionStatus()
  const canWriteSettings = usePermission('settings:write'),
    canExecute = usePermission('tasks:execute')
  const client = useQueryClient()
  const { t } = useTranslation()
  const retry = useMutation({
    mutationFn: async () =>
      HostExecutionStatusSchema.parse(await api.post<unknown>('/api/execution/recover')),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: HOST_EXECUTION_STATUS_QUERY_KEY })
    },
  })
  if (query.isError)
    return (
      <ErrorBanner message={t('hostExecution.queryFailed')} onRetry={() => void query.refetch()} />
    )
  const view = query.data
  if (!view) return null
  const canRetry =
    canWriteSettings &&
    canExecute &&
    view.mode === 'execution' &&
    ['standby', 'draining'].includes(view.status.phase)
  return (
    <>
      <HostExecutionNotice
        view={view}
        action={
          canRetry ? (
            <button
              type="button"
              className="btn btn--sm"
              disabled={retry.isPending}
              onClick={() => retry.mutate()}
            >
              {t(
                retry.isPending
                  ? 'hostExecution.retryingActivation'
                  : 'hostExecution.retryActivation',
              )}
            </button>
          ) : undefined
        }
      />
      {canRetry && retry.isError && (
        <ErrorBanner
          message={
            retry.error instanceof Error ? retry.error.message : t('hostExecution.retryFailed')
          }
        />
      )}
    </>
  )
}
