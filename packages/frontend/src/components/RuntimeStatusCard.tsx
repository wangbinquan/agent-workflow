// RFC-001: read-only opencode runtime status card shown at the top of the
// Settings → Runtime tab. Calls GET /api/runtime/opencode and renders one of
// three states (probing / ok / failed). Provides a manual "Re-probe" button.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { RuntimeOpencodeStatus } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { describeApiError } from '@/i18n'

export const RUNTIME_OPENCODE_QUERY_KEY = ['runtime', 'opencode'] as const

export function RuntimeStatusCard() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const probe = useQuery<RuntimeOpencodeStatus>({
    queryKey: RUNTIME_OPENCODE_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/runtime/opencode', undefined, signal),
    staleTime: 30_000,
  })

  const reprobe = (): void => {
    void qc.invalidateQueries({ queryKey: RUNTIME_OPENCODE_QUERY_KEY })
  }

  return (
    <div className="info-box-muted" style={{ marginBottom: 16 }}>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}
      >
        <strong>{t('settingsForm.runtimeStatusTitle')}</strong>
        <button
          type="button"
          className="btn"
          onClick={reprobe}
          disabled={probe.isFetching}
          style={{ fontSize: 12, padding: '2px 10px' }}
        >
          {t('settingsForm.runtimeStatusReprobe')}
        </button>
      </div>
      <div style={{ marginTop: 8 }}>{renderBody(probe, t)}</div>
    </div>
  )
}

function renderBody(
  probe: ReturnType<typeof useQuery<RuntimeOpencodeStatus>>,
  t: (key: string, opts?: Record<string, unknown>) => string,
) {
  if (probe.isLoading) {
    return (
      <p style={{ margin: 0, fontSize: 13 }} className="muted">
        <StatusDot color="grey" /> {t('settingsForm.runtimeStatusProbing')}
      </p>
    )
  }
  if (probe.error !== null && probe.error !== undefined) {
    return (
      <p style={{ margin: 0, fontSize: 13 }} className="error-box">
        {describeApiError(probe.error)}
      </p>
    )
  }
  const data = probe.data
  if (data === undefined) return <></>

  const isOk = data.version !== null && data.compatible
  const isIncompatible = data.version !== null && !data.compatible
  const dotColor: 'green' | 'red' = isOk ? 'green' : 'red'

  let line: string
  if (isOk) {
    line = t('settingsForm.runtimeStatusOk', { version: data.version })
  } else if (isIncompatible) {
    line = t('settingsForm.runtimeStatusIncompatible', {
      version: data.version,
      minVersion: data.minVersion,
    })
  } else {
    line = t('settingsForm.runtimeStatusNotFound')
  }

  return (
    <>
      <p style={{ margin: 0, fontSize: 13 }}>
        <StatusDot color={dotColor} /> {line}
      </p>
      <p style={{ margin: '4px 0 0 0', fontSize: 12 }} className="muted">
        {t('settingsForm.runtimeStatusBinary', { path: data.binary })} ·{' '}
        {t('settingsForm.runtimeStatusMinVersion', { version: data.minVersion })}
      </p>
      {!isOk && (
        <p style={{ margin: '4px 0 0 0', fontSize: 12 }} className="muted">
          {t('settingsForm.runtimeStatusHint')}
        </p>
      )}
    </>
  )
}

function StatusDot({ color }: { color: 'green' | 'red' | 'grey' }) {
  const bg = color === 'green' ? '#1e8e3e' : color === 'red' ? '#c5221f' : '#9aa0a6'
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: bg,
        marginRight: 6,
        verticalAlign: 'baseline',
      }}
    />
  )
}
