import { Select } from '@/components/Select'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  ObservationMaintenanceOperationSchema,
  type ObservationMaintenanceOperation,
  type ObservationMaintenanceRequest,
  type ObservationPricingRuntime,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { usePermission } from '@/hooks/useActor'
import { Card } from '@/components/Card'
import { Dialog } from '@/components/Dialog'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Field, TextInput } from '@/components/Form'
import { ErrorBanner } from '@/components/ErrorBanner'
import type { ReadableObservationReport } from './completeReportClient'
export function ObservationMaintenance({ report }: { report: ReadableObservationReport }) {
  const { t } = useTranslation(),
    allowed = usePermission('settings:write'),
    [open, setOpen] = useState(false),
    [mode, setMode] = useState<ObservationMaintenanceRequest['mode']>('backfill'),
    [runtime, setRuntime] = useState(''),
    [revision, setRevision] = useState(''),
    [operation, setOperation] = useState<ObservationMaintenanceOperation>(),
    [confirm, setConfirm] = useState(false),
    trigger = useRef<HTMLButtonElement | null>(null)
  const request = useMemo<ObservationMaintenanceRequest>(
    () => ({
      requestKey: crypto.randomUUID(),
      reportId: report.header.reportId,
      mode,
      ...(mode === 'reprice'
        ? { registrationId: runtime, targetPriceBookRevision: Number(revision) }
        : {}),
    }),
    [report.header.reportId, mode, runtime, revision],
  )
  const requestKey = request.requestKey
  const activeRequest = useRef(requestKey)
  activeRequest.current = requestKey
  const prepare = useMutation({
    mutationFn: async (requested: ObservationMaintenanceRequest) =>
      ObservationMaintenanceOperationSchema.parse(
        await api.post('/api/observability/maintenance', requested),
      ),
    onSuccess: (op, requested) => {
      if (requested.requestKey === activeRequest.current) setOperation(op)
    },
  })
  const runtimes = useQuery({
    queryKey: ['observation-maintenance-runtimes'],
    enabled: allowed && open && mode === 'reprice',
    queryFn: () =>
      api.get<{ runtimes: readonly ObservationPricingRuntime[] }>(
        '/api/observability/pricing/runtimes',
      ),
  })
  const status = useQuery({
    queryKey: ['observation-maintenance', operation?.id],
    enabled: !!operation?.id,
    queryFn: async () =>
      ObservationMaintenanceOperationSchema.parse(
        await api.get('/api/observability/maintenance/' + operation!.id),
      ),
    refetchInterval: operation && ['preparing', 'running'].includes(operation.state) ? 1000 : false,
  })
  useEffect(() => {
    if (status.data) setOperation(status.data)
  }, [status.data])
  useEffect(() => {
    setOperation(undefined)
    setConfirm(false)
  }, [requestKey])
  if (!allowed) return null
  return (
    <Card title={t('runObservability.maintenanceTitle')}>
      <p className="muted">{t('runObservability.maintenanceHint')}</p>
      <div className="page__actions">
        <button ref={trigger} className="btn btn--sm" type="button" onClick={() => setOpen(true)}>
          {t('runObservability.maintenancePrepare')}
        </button>
        {operation ? (
          <span>
            {t('runObservability.maintenanceState_' + operation.state)} ·{' '}
            {t('runObservability.maintenanceProcessed', { count: operation.processed })}
          </span>
        ) : null}
      </div>
      <Dialog
        panelClassName="observation-typography"
        open={open}
        onClose={() => setOpen(false)}
        title={t('runObservability.maintenanceTitle')}
        triggerRef={trigger}
      >
        <Field label={t('runObservability.maintenanceMode')}>
          <Select
            value={mode}
            onChange={setMode}
            options={(['backfill', 'rebuild', 'reprice'] as const).map((value) => ({
              value,
              label: t('runObservability.maintenanceMode_' + value),
            }))}
          />
        </Field>
        {mode === 'reprice' ? (
          <>
            <Field label={t('runObservability.maintenanceRuntime')}>
              <Select
                value={runtime}
                onChange={(id) => {
                  setRuntime(id)
                  const selected = runtimes.data?.runtimes.find((row) => row.registrationId === id)
                  setRevision(selected ? String(selected.pricingRevision) : '')
                }}
                options={(runtimes.data?.runtimes ?? []).map((row) => ({
                  value: row.registrationId,
                  label: row.name,
                  description: row.protocol + ' · ' + row.pricingRevision,
                }))}
              />
            </Field>
            <Field label={t('runObservability.maintenanceBook')}>
              <TextInput type="number" value={revision} onChange={setRevision} />
            </Field>
          </>
        ) : null}
        {prepare.error || status.error || runtimes.error ? (
          <ErrorBanner error={prepare.error ?? status.error ?? runtimes.error} />
        ) : null}
        <div className="page__actions">
          <button
            type="button"
            className="btn"
            disabled={
              prepare.isPending || (mode === 'reprice' && (!runtime || !/^\d+$/.test(revision)))
            }
            onClick={() => prepare.mutate(request)}
          >
            {t('runObservability.maintenancePrepare')}
          </button>
        </div>
        {operation ? (
          <>
            <dl className="detail-grid">
              <dt>{t('runObservability.taskCount')}</dt>
              <dd>{operation.tasks}</dd>
              <dt>{t('runObservability.maintenanceRecords')}</dt>
              <dd>{operation.records}</dd>
              <dt>{t('runObservability.maintenanceOriginal')}</dt>
              <dd>
                {operation.knownOriginalCny === null ? '—' : '¥' + operation.knownOriginalCny}
              </dd>
              <dt>{t('runObservability.maintenanceProposed')}</dt>
              <dd>
                {operation.knownProposedCny === null ? '—' : '¥' + operation.knownProposedCny}
              </dd>
              <dt>{t('runObservability.maintenancePairedDelta')}</dt>
              <dd>
                {operation.knownPairedDeltaCny === null ? '—' : '¥' + operation.knownPairedDeltaCny}
              </dd>
              <dt>{t('runObservability.maintenanceUnpriced')}</dt>
              <dd>{operation.unpricedRecords}</dd>
              <dt>{t('runObservability.maintenanceState')}</dt>
              <dd>{t('runObservability.maintenanceState_' + operation.state)}</dd>
            </dl>
            <p className="muted">{operation.scopeDigest}</p>
            {operation.state === 'preview' ? (
              <button className="btn" type="button" onClick={() => setConfirm(true)}>
                {t('runObservability.maintenanceApply')}
              </button>
            ) : null}
          </>
        ) : null}
      </Dialog>
      {operation ? (
        <ConfirmDialog
          open={confirm}
          onClose={() => setConfirm(false)}
          title={t('runObservability.maintenanceApply')}
          description={t('runObservability.maintenanceConfirmHint', {
            tasks: operation.tasks,
            records: operation.records,
          })}
          confirmLabel={t('runObservability.maintenanceApply')}
          confirmInput={{ expected: 'APPLY', label: t('runObservability.maintenanceConfirmInput') }}
          onConfirm={async (ctx) => {
            setOperation(
              ObservationMaintenanceOperationSchema.parse(
                await api.post('/api/observability/maintenance/' + operation.id + '/confirm', {
                  expectedDigest: operation.scopeDigest,
                  confirmation: ctx?.typedConfirm,
                }),
              ),
            )
          }}
        />
      ) : null}
    </Card>
  )
}
