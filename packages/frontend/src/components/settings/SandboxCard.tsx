// RFC-205 T5 (design D6) — runtime sandbox observability card (Settings → Runtime).
//
// One StatusChip mirrors the `sandbox` block of GET /api/runtimes/status:
//   - mode !== 'off' && available   → success 「沙箱：seatbelt/bwrap」
//   - mode !== 'off' && !available  → warn    「沙箱不可用」
//   - mode === 'off'                → neutral 「沙箱关闭」
// The status query shares RUNTIMES_STATUS_HOME_QUERY_KEY with the homepage
// hero so both observers read ONE cache entry; this observer deliberately
// sets no refetchInterval (the homepage already polls — no second poller).
//
// The `.segmented` three-way control edits config.sandboxMode through the
// shared config write coordinator (same mutation shape as RuntimeList's
// set-default): minimal patch, receipt-cached config, then a runtimes/status
// invalidation so the chip re-reads the daemon's effective state.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Config, RuntimesStatusResponse } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Card } from '@/components/Card'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field } from '@/components/Form'
import { NoticeBanner } from '@/components/NoticeBanner'
import { Segmented } from '@/components/Segmented'
import { StatusChip } from '@/components/StatusChip'
import { RUNTIMES_STATUS_HOME_QUERY_KEY } from '@/components/home/HomepageGreeting'
import { ConfigAmbiguousWriteError } from '@/lib/config-receipts'
import {
  cacheConfigWriteReceipt,
  queryConfig,
  reconcileAmbiguousConfigWrite,
  useConfigQueryKey,
  writeConfigPatch,
} from '@/lib/config-resource'

type SandboxMode = Config['sandboxMode']

export function SandboxCard() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const configQueryKey = useConfigQueryKey()
  const config = useQuery<Config>({
    queryKey: configQueryKey,
    queryFn: ({ signal }) => queryConfig(signal),
  })
  const status = useQuery<RuntimesStatusResponse>({
    queryKey: RUNTIMES_STATUS_HOME_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/runtimes/status', undefined, signal),
    staleTime: 30_000,
  })
  const sandbox = status.data?.sandbox

  // config is the user's saved intent (authoritative for the control); the
  // status block only fills the gap until the config cache resolves.
  const mode: SandboxMode = config.data?.sandboxMode ?? sandbox?.mode ?? 'warn'

  const save = useMutation({
    mutationFn: (next: SandboxMode) => writeConfigPatch({ sandboxMode: next }),
    onSuccess: (receipt) => {
      cacheConfigWriteReceipt(qc, receipt)
      void qc.invalidateQueries({ queryKey: RUNTIMES_STATUS_HOME_QUERY_KEY })
    },
    onError: async (error) => {
      if (!(error instanceof ConfigAmbiguousWriteError)) return
      try {
        await reconcileAmbiguousConfigWrite(error, qc)
        await qc.invalidateQueries({ queryKey: RUNTIMES_STATUS_HOME_QUERY_KEY })
      } catch {
        // The mutation's original outcome-unknown error remains visible.
      }
    },
  })

  // D6 chip states. `mechanism` is non-null whenever available is true (the
  // probe names what it trial-ran); `?? ''` only guards the type.
  const chip =
    sandbox === undefined
      ? null
      : sandbox.mode === 'off'
        ? { kind: 'neutral' as const, text: t('settings.sandbox.chipOff') }
        : sandbox.available
          ? {
              kind: 'success' as const,
              text: t('settings.sandbox.chipActive', { mechanism: sandbox.mechanism ?? '' }),
            }
          : { kind: 'warn' as const, text: t('settings.sandbox.chipUnavailable') }

  return (
    <Card
      as="section"
      data-testid="sandbox-card"
      header={
        <>
          <strong>{t('settings.sandbox.title')}</strong>
          {chip !== null && (
            <StatusChip kind={chip.kind} size="sm" withDot data-testid="sandbox-status-chip">
              {chip.text}
            </StatusChip>
          )}
        </>
      }
    >
      <Field label={t('settings.sandbox.modeLabel')} hint={t('settings.sandbox.modeHint')} group>
        <Segmented<SandboxMode>
          value={mode}
          onChange={(next) => save.mutate(next)}
          options={[
            { value: 'enforce', label: t('settings.sandbox.modeEnforce') },
            { value: 'warn', label: t('settings.sandbox.modeWarn') },
            { value: 'off', label: t('settings.sandbox.modeOff') },
          ]}
          ariaLabel={t('settings.sandbox.modeLabel')}
          disabled={save.isPending}
          testidPrefix="sandbox-mode"
        />
      </Field>
      {mode === 'enforce' && sandbox !== undefined && !sandbox.available && (
        <NoticeBanner
          tone="warning"
          size="compact"
          className="stack-top--sm"
          title={t('settings.sandbox.chipUnavailable')}
          testid="sandbox-enforce-unavailable"
        >
          {t('settings.sandbox.enforceUnavailable')}
        </NoticeBanner>
      )}
      {save.error !== null && <ErrorBanner error={save.error} testid="sandbox-save-error" />}
    </Card>
  )
}
