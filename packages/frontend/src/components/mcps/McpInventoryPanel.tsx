// RFC-030 / RFC-223 — Inventory panel on /mcps/$id.
//
// Composed of four collapsible <details> sections (Tools / Resources / Prompts /
// Capabilities) plus a sticky header with the status chip, last-probed
// timestamp, latency, and a "Re-probe" button. On error, an error box at
// the top of the body surfaces errorCode + errorMessage with a collapsible
// errorDetail JSON viewer.
//
// We use the standard probe query hooks so this panel and the list page
// stay cache-coherent: re-probing here invalidates the same keys the list
// page reads from.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { McpProbe, McpToolInfo } from '@agent-workflow/shared'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { McpProbeStatusChip, type McpProbeUiStatus } from '@/components/McpProbeStatusChip'
import { NoticeBanner } from '@/components/NoticeBanner'
import type { SplitBusyRelease } from '@/components/split/splitDirty'
import { useMcpProbe, useProbeMcpMutation } from '@/lib/mcp-probe-query'
import { probeFreshness } from '@/lib/probe-freshness'

export interface McpInventoryPanelProps {
  mcpId: string
  operationConfigHash?: string
  /** Current saved row timestamp; absent is deliberately treated as stale. */
  mcpUpdatedAt?: number
  dirty?: boolean
  saving?: boolean
  /** Persist the captured draft and return the exact PUT receipt hash. */
  onSaveForProbe?: () => Promise<string | null>
  beginBusy?: () => SplitBusyRelease
}

export function McpInventoryPanel(props: McpInventoryPanelProps) {
  const { t } = useTranslation()
  const probeQ = useMcpProbe(props.mcpId)
  const probeMut = useProbeMcpMutation(props.mcpId)
  const [preparationError, setPreparationError] = useState<unknown>(null)

  const persistedProbe = probeQ.data ?? null
  const persistedProbeExpired =
    persistedProbe !== null &&
    !probeFreshness(persistedProbe, props.mcpUpdatedAt ?? Number.MAX_SAFE_INTEGER)
  const probe = persistedProbeExpired ? null : persistedProbe
  const isProbing = probeMut.isPending
  const uiStatus: McpProbeUiStatus = isProbing
    ? 'probing'
    : probe === null
      ? 'unknown'
      : probe.status === 'ok'
        ? 'ok'
        : 'error'

  async function runSaved(hash: string): Promise<void> {
    const release = props.beginBusy?.() ?? (() => undefined)
    try {
      await probeMut.runAsync(hash)
    } finally {
      release()
    }
  }

  async function saveAndProbe(): Promise<void> {
    if (props.onSaveForProbe === undefined) return
    setPreparationError(null)
    let hash: string | null
    try {
      hash = await props.onSaveForProbe()
    } catch (error) {
      setPreparationError(error)
      return
    }
    if (hash === null) return
    try {
      await runSaved(hash)
    } catch {
      // The mutation exposes its structured transport/domain error below.
    }
  }

  const hash = props.operationConfigHash
  const operationActions =
    hash === undefined ? undefined : props.dirty === true ? (
      <div className="mcp-operation-basis__actions">
        <button
          type="button"
          className="btn btn--sm btn--primary"
          disabled={isProbing || props.saving === true}
          onClick={() => void saveAndProbe()}
          data-testid="mcp-save-and-probe"
        >
          {props.saving === true ? t('common.saving') : t('mcps.probe.saveAndRun')}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={isProbing || props.saving === true}
          onClick={() => void runSaved(hash).catch(() => undefined)}
          data-testid="mcp-probe-saved-version"
        >
          {t('mcps.probe.useSaved')}
        </button>
      </div>
    ) : (
      <button
        type="button"
        className="btn btn--sm btn--primary"
        disabled={isProbing || props.saving === true}
        onClick={() => void runSaved(hash).catch(() => undefined)}
        data-testid={`mcp-inventory-reprobe-${props.mcpId}`}
      >
        {isProbing ? t('mcps.probe.btnRunning') : t('mcps.probe.btnRun')}
      </button>
    )

  return (
    <section id="inventory" className="mcp-inventory">
      <NoticeBanner
        tone={props.dirty === true || hash === undefined ? 'warning' : 'info'}
        size="compact"
        title={
          props.dirty === true ? t('mcps.probe.basisDirtyTitle') : t('mcps.probe.basisSavedTitle')
        }
        action={operationActions}
        className="mcp-operation-basis"
      >
        {hash === undefined ? (
          t('mcps.probe.basisUnavailable')
        ) : (
          <>
            {props.dirty === true ? t('mcps.probe.basisDirtyBody') : t('mcps.probe.basisSavedBody')}{' '}
            <code title={hash}>{hash.slice(0, 10)}</code>
          </>
        )}
      </NoticeBanner>

      <header className="mcp-inventory__header">
        <h2 className="mcp-inventory__title">
          {t('mcps.probe.section.tools')} · {t('mcps.probe.section.resources')} ·{' '}
          {t('mcps.probe.section.prompts')}
        </h2>
        <McpProbeStatusChip status={uiStatus} title={probe?.errorMessage ?? undefined} />
        <span className="mcp-inventory__meta">
          {persistedProbe === null
            ? t('mcps.probe.neverProbed')
            : t('mcps.probe.lastProbed', {
                at: formatTimestamp(persistedProbe.updatedAt),
              })}
          {persistedProbe !== null && ` · ${formatLatency(persistedProbe.latencyMs, t)}`}
        </span>
      </header>

      {preparationError !== null && <ErrorBanner error={preparationError} />}
      {probeMut.resultStale && (
        <NoticeBanner tone="warning" size="compact">
          {t('mcps.probe.resultStale')}
        </NoticeBanner>
      )}
      {persistedProbeExpired && !probeMut.resultStale && (
        <NoticeBanner tone="warning" size="compact">
          {t('mcps.probe.savedResultExpired')}
        </NoticeBanner>
      )}
      {isProbing ? (
        <LoadingState label={t('mcps.probe.btnRunning')} data-testid="mcp-probe-running" />
      ) : probeMut.error !== null ? (
        <ErrorBanner
          error={probeMut.error}
          onRetry={
            hash === undefined ? undefined : () => void runSaved(hash).catch(() => undefined)
          }
        />
      ) : probeQ.isLoading ? (
        <LoadingState data-testid="mcp-probe-loading" />
      ) : probeQ.error !== null ? (
        <ErrorBanner error={probeQ.error} onRetry={() => void probeQ.refetch()} />
      ) : persistedProbeExpired ? (
        <EmptyState
          title={t('mcps.probe.savedResultExpired')}
          description={t('mcps.probe.savedResultExpiredHint')}
          size="compact"
          data-testid="mcp-probe-expired"
        />
      ) : probe === null ? (
        <EmptyState
          title={t('mcps.probe.neverProbed')}
          description={t('mcps.probe.neverProbedHint')}
          size="compact"
          data-testid="mcp-probe-never-run"
        />
      ) : (
        <>
          {(probe.status === 'error' || probe.errorCode === 'partial') && (
            <ProbeError probe={probe} />
          )}
          <ToolsSection tools={probe.tools} />
          <ResourcesSection resources={probe.resources} templates={probe.resourceTemplates} />
          <PromptsSection prompts={probe.prompts} />
          <CapabilitiesSection capabilities={probe.capabilities} />
        </>
      )}
    </section>
  )
}

function ProbeError(props: { probe: McpProbe }) {
  const { t } = useTranslation()
  const [showDetail, setShowDetail] = useState(false)
  const codeKey = errorCodeI18nKey(props.probe.errorCode)
  return (
    <div data-testid="mcp-inventory-error">
      <ErrorBanner
        error={
          new Error(
            [
              codeKey !== null ? t(codeKey) : t('mcps.probe.error.codeInternalError'),
              props.probe.errorMessage,
            ]
              .filter((value): value is string => value !== null && value !== '')
              .join(' '),
          )
        }
      />
      {props.probe.errorDetail !== null && (
        <div className="mcp-inventory__error-detail">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setShowDetail((v) => !v)}
            data-testid="mcp-inventory-error-detail-toggle"
          >
            {showDetail ? t('mcps.probe.error.hideDetail') : t('mcps.probe.error.showDetail')}
          </button>
          {showDetail && (
            <pre className="mcp-inventory__tool-schema">
              {JSON.stringify(props.probe.errorDetail, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function errorCodeI18nKey(code: McpProbe['errorCode']): string | null {
  if (code === null) return null
  switch (code) {
    case 'connect-failed':
      return 'mcps.probe.error.codeConnectFailed'
    case 'handshake-failed':
      return 'mcps.probe.error.codeHandshakeFailed'
    case 'auth-required':
      return 'mcps.probe.error.codeAuthRequired'
    case 'timeout':
      return 'mcps.probe.error.codeTimeout'
    case 'partial':
      return 'mcps.probe.error.codePartial'
    case 'internal-error':
      return 'mcps.probe.error.codeInternalError'
    case 'mcp-disabled':
      return 'mcps.probe.error.codeMcpDisabled'
    default:
      return 'mcps.probe.error.codeInternalError'
  }
}

function ToolsSection(props: { tools: McpToolInfo[] | null }) {
  const { t } = useTranslation()
  const tools = props.tools ?? []
  return (
    <details className="mcp-inventory__section" open data-testid="mcp-inventory-tools">
      <summary>
        {t('mcps.probe.section.tools')} ({tools.length})
      </summary>
      {tools.length === 0 ? (
        <p className="muted">{t('mcps.probe.tools.empty')}</p>
      ) : (
        tools.map((tool) => <McpToolRow key={tool.name} tool={tool} />)
      )}
    </details>
  )
}

function McpToolRow(props: { tool: McpToolInfo }) {
  const { t } = useTranslation()
  const [showSchema, setShowSchema] = useState(false)
  const desc = props.tool.description ?? ''
  const hasSchema = props.tool.inputSchema !== undefined && props.tool.inputSchema !== null
  return (
    <div className="mcp-inventory__tool" data-testid={`mcp-tool-row-${props.tool.name}`}>
      <div className="mcp-inventory__tool-name">{props.tool.name}</div>
      <div className="mcp-inventory__tool-desc">
        {desc === '' ? t('mcps.probe.tools.descriptionEmpty') : desc}
      </div>
      <div className="mcp-inventory__tool-schema">
        {hasSchema ? (
          <details onToggle={(e) => setShowSchema((e.target as HTMLDetailsElement).open)}>
            <summary data-testid={`mcp-tool-schema-toggle-${props.tool.name}`}>
              {showSchema ? t('mcps.probe.tools.hideSchema') : t('mcps.probe.tools.showSchema')}
            </summary>
            <pre data-testid={`mcp-tool-schema-${props.tool.name}`}>
              {JSON.stringify(props.tool.inputSchema, null, 2)}
            </pre>
          </details>
        ) : (
          <span className="muted">{t('mcps.probe.tools.noInputSchema')}</span>
        )}
      </div>
    </div>
  )
}

function ResourcesSection(props: {
  resources: McpProbe['resources']
  templates: McpProbe['resourceTemplates']
}) {
  const { t } = useTranslation()
  const r = props.resources ?? []
  const tpls = props.templates ?? []
  return (
    <details className="mcp-inventory__section" data-testid="mcp-inventory-resources">
      <summary>
        {t('mcps.probe.section.resources')} ({r.length + tpls.length})
      </summary>
      {r.length === 0 && tpls.length === 0 ? (
        <p className="muted">{t('mcps.probe.resources.empty')}</p>
      ) : (
        <>
          <ul>
            {r.map((x) => (
              <li key={x.uri}>
                <code>{x.uri}</code>
                {x.name !== undefined && ` — ${x.name}`}
              </li>
            ))}
          </ul>
          {tpls.length > 0 && (
            <>
              <p className="mcp-inventory__tool-desc">
                {t('mcps.probe.resources.templatesHeading')}
              </p>
              <ul>
                {tpls.map((x) => (
                  <li key={x.uriTemplate}>
                    <code>{x.uriTemplate}</code>
                    {x.name !== undefined && ` — ${x.name}`}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </details>
  )
}

function PromptsSection(props: { prompts: McpProbe['prompts'] }) {
  const { t } = useTranslation()
  const prompts = props.prompts ?? []
  return (
    <details className="mcp-inventory__section" data-testid="mcp-inventory-prompts">
      <summary>
        {t('mcps.probe.section.prompts')} ({prompts.length})
      </summary>
      {prompts.length === 0 ? (
        <p className="muted">{t('mcps.probe.prompts.empty')}</p>
      ) : (
        prompts.map((p) => (
          <div key={p.name} className="mcp-inventory__tool">
            <div className="mcp-inventory__tool-name">{p.name}</div>
            {p.description !== undefined && (
              <div className="mcp-inventory__tool-desc">{p.description}</div>
            )}
            {p.arguments !== undefined && p.arguments.length > 0 && (
              <>
                <div className="mcp-inventory__tool-desc">
                  {t('mcps.probe.prompts.argumentsHeading')}
                </div>
                <ul>
                  {p.arguments.map((a) => (
                    <li key={a.name}>
                      <code>{a.name}</code>
                      {a.required === true && ` · ${t('mcps.probe.prompts.argumentRequired')}`}
                      {a.description !== undefined && ` — ${a.description}`}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ))
      )}
    </details>
  )
}

function CapabilitiesSection(props: { capabilities: McpProbe['capabilities'] }) {
  const { t } = useTranslation()
  const caps = props.capabilities ?? {}
  const keys = Object.keys(caps)
  return (
    <details className="mcp-inventory__section" data-testid="mcp-inventory-capabilities">
      <summary>
        {t('mcps.probe.section.capabilities')} ({keys.length})
      </summary>
      {keys.length === 0 ? (
        <p className="muted">{t('mcps.probe.capabilities.empty')}</p>
      ) : (
        <pre className="mcp-inventory__tool-schema">{JSON.stringify(caps, null, 2)}</pre>
      )}
    </details>
  )
}

function formatLatency(ms: number, t: TFunction): string {
  if (ms < 1000) return t('mcps.probe.latencyMs', { ms })
  return t('mcps.probe.latencySec', { s: (ms / 1000).toFixed(2) })
}

function formatTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return String(ms)
  }
}
