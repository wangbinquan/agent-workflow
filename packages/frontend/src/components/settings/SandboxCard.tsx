// RFC-205 T5 (design D6) — runtime sandbox observability card (Settings → Runtime).
//
// One StatusChip mirrors the capability receipt in GET /api/runtimes/status:
//   - active + required capabilities → success 「沙箱：<provider>」
//   - unavailable/degraded            → warn    「沙箱不可用」
//   - mode === 'off'                  → neutral 「沙箱关闭」
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
  const configuredMode =
    config.data?.sandboxMode ?? sandbox?.configuredMode ?? sandbox?.mode ?? 'warn'
  const effectiveMode = sandbox?.effectiveMode ?? sandbox?.mode ?? configuredMode
  const degraded =
    sandbox !== undefined && (!sandbox.available || (sandbox.degradedReasons?.length ?? 0) > 0)
  // 2026-08-04 audit: the card knew only that SOMETHING was degraded — the
  // reason codes (`provider-not-found` / `provider-parent-unsafe` /
  // `required-capability-missing` / `containment-mode-off`) were computed,
  // shipped to the client and then dropped, and the install/userns guidance
  // that answers them existed ONLY in the `agent-workflow sandbox` CLI. So the
  // UI could say "unavailable" and never say why or what to do.
  const degradedDetail =
    (sandbox?.degradedReasons?.length ?? 0) > 0 ? (
      <>
        {' '}
        {t('settings.sandbox.reasonCodes', {
          codes: sandbox?.degradedReasons?.join(', ') ?? '',
        })}{' '}
        {t('settings.sandbox.cliHint')}
      </>
    ) : (
      <> {t('settings.sandbox.cliHint')}</>
    )
  const lifetimeBestEffort =
    effectiveMode !== 'off' &&
    sandbox?.available === true &&
    sandbox.capabilities?.descendantLifetimeBound === 'best-effort'

  // The radio represents what new admissions use now. Config remains the saved
  // intent and is shown separately when an out-of-process write created a
  // configured/effective mismatch.
  const mode: SandboxMode = effectiveMode
  const mismatch =
    sandbox !== undefined && (sandbox.restartRequired === true || configuredMode !== effectiveMode)

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
      : effectiveMode === 'off'
        ? { kind: 'neutral' as const, text: t('settings.sandbox.chipOff') }
        : sandbox.available && !degraded
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
      {mismatch && (
        <NoticeBanner
          tone="warning"
          size="compact"
          className="stack-top--sm"
          title={t('settings.sandbox.mismatchTitle')}
          testid="sandbox-mode-mismatch"
          action={
            <button
              type="button"
              className="btn btn--sm"
              disabled={save.isPending}
              onClick={() => save.mutate(configuredMode)}
            >
              {t('settings.sandbox.applyConfigured')}
            </button>
          }
        >
          {t('settings.sandbox.mismatchBody', {
            configured: configuredMode,
            effective: effectiveMode,
          })}
        </NoticeBanner>
      )}
      {mode === 'enforce' && degraded && (
        <NoticeBanner
          tone="warning"
          size="compact"
          className="stack-top--sm"
          title={t('settings.sandbox.chipUnavailable')}
          testid="sandbox-enforce-unavailable"
        >
          {t('settings.sandbox.enforceUnavailable')}
          {degradedDetail}
        </NoticeBanner>
      )}
      {mode === 'warn' && degraded && (
        <NoticeBanner
          tone="warning"
          size="compact"
          className="stack-top--sm"
          title={t('settings.sandbox.chipUnavailable')}
          testid="sandbox-warn-degraded"
        >
          {t('settings.sandbox.warnDegraded')}
          {degradedDetail}
        </NoticeBanner>
      )}
      {lifetimeBestEffort && (
        <NoticeBanner
          tone="info"
          size="compact"
          className="stack-top--sm"
          testid="sandbox-lifetime-best-effort"
        >
          {t('settings.sandbox.lifetimeBestEffort')}
        </NoticeBanner>
      )}
      {save.error !== null && <ErrorBanner error={save.error} testid="sandbox-save-error" />}
    </Card>
  )
}
