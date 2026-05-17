// RFC-028 — /mcps list page. Mirrors /agents and /skills shape exactly:
// header row with title + primary "New" Link, table, no inline editor. The
// create + edit pages are separate routes (`/mcps/new`, `/mcps/$name`).
//
// RFC-030 extends this with three new columns (status / latency / tool count)
// and an in-row expand affordance that surfaces the captured tool name chips
// + a "re-probe" button + a "view full inventory" link. The probe state
// itself comes from `useMcpProbes` (one batched fetch alongside the mcps
// list); per-mcp re-probe goes through `useProbeMcpMutation` so its onSuccess
// invalidates both query keys at once.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Mcp, McpProbe } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { McpProbeStatusChip, type McpProbeUiStatus } from '@/components/McpProbeStatusChip'
import { useMcpProbes, useProbeMcpMutation } from '@/lib/mcp-probe-query'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/mcps',
  component: McpsPage,
})

/** Max number of tool-name chips shown inline before "+N more". */
const MAX_INLINE_TOOL_CHIPS = 12

function McpsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<Mcp[]>({
    queryKey: ['mcps'],
    queryFn: ({ signal }) => api.get('/api/mcps', undefined, signal),
  })
  const probesQ = useMcpProbes()

  // Local-only expand state — keyed by mcp.name, session-scoped (no IDB).
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const toggleExpanded = (name: string): void =>
    setExpanded((s) => ({ ...s, [name]: !(s[name] ?? false) }))

  const del = useMutation({
    mutationFn: (name: string) => api.delete(`/api/mcps/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mcps'] }),
  })

  // Index probes by mcpName so each row can look its own state up in O(1).
  const probesByName = useMemo<Record<string, McpProbe>>(() => {
    const idx: Record<string, McpProbe> = {}
    for (const p of probesQ.data ?? []) idx[p.mcpName] = p
    return idx
  }, [probesQ.data])

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('mcps.title')}</h1>
          <p className="page__hint">{t('mcps.hint')}</p>
        </div>
        <Link to="/mcps/new" className="btn btn--primary">
          {t('mcps.newButton')}
        </Link>
      </header>

      {isLoading && <LoadingState data-testid="mcps-loading" />}
      {error !== null && error !== undefined && <ErrorBanner error={error} />}
      {del.error !== null && <ErrorBanner error={del.error} />}

      {!isLoading && data !== undefined && data.length === 0 && (
        <EmptyState title={t('mcps.emptyList')} data-testid="mcps-empty" />
      )}

      {data !== undefined && data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th aria-label="expand" />
              <th>{t('mcps.colName')}</th>
              <th>{t('mcps.colType')}</th>
              <th>{t('mcps.colDescription')}</th>
              <th>{t('mcps.colEnabled')}</th>
              <th>{t('mcps.colStatus')}</th>
              <th>{t('mcps.colLatency')}</th>
              <th>{t('mcps.colToolCount')}</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {data.map((m) => {
              const probe = probesByName[m.name] ?? null
              const isExpanded = expanded[m.name] === true
              return (
                <McpRow
                  key={m.id}
                  mcp={m}
                  probe={probe}
                  isExpanded={isExpanded}
                  onToggleExpanded={() => toggleExpanded(m.name)}
                  onDelete={() => del.mutateAsync(m.name)}
                  deleteDisabled={del.isPending}
                />
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

interface McpRowProps {
  mcp: Mcp
  probe: McpProbe | null
  isExpanded: boolean
  onToggleExpanded: () => void
  onDelete: () => Promise<unknown>
  deleteDisabled: boolean
}

function McpRow(props: McpRowProps) {
  const { t } = useTranslation()
  const probeMut = useProbeMcpMutation(props.mcp.name)
  const uiStatus = deriveUiStatus(props.probe, probeMut.isPending)
  const tools = props.probe?.tools ?? null
  const toolCount = tools !== null ? tools.length : null
  const latencyLabel = formatLatency(props.probe?.latencyMs ?? null)

  return (
    <>
      <tr data-testid={`mcp-row-${props.mcp.name}`}>
        <td className="data-table__expand">
          <button
            type="button"
            className="btn btn--ghost btn--sm data-table__expand-btn"
            aria-expanded={props.isExpanded}
            aria-label={props.isExpanded ? t('mcps.probe.collapseRow') : t('mcps.probe.expandRow')}
            onClick={props.onToggleExpanded}
            data-testid={`mcp-row-expand-${props.mcp.name}`}
          >
            {props.isExpanded ? '▼' : '▶'}
          </button>
        </td>
        <td className="data-table__nowrap">
          <Link to="/mcps/$name" params={{ name: props.mcp.name }} className="data-table__link">
            {props.mcp.name}
          </Link>
        </td>
        <td className="data-table__nowrap">
          <span className="chip chip--tight">
            {props.mcp.type === 'local' ? t('mcps.typeLocal') : t('mcps.typeRemote')}
          </span>
        </td>
        <td
          className="data-table__muted data-table__truncate"
          title={props.mcp.description || undefined}
        >
          {props.mcp.description || t('common.emDash')}
        </td>
        <td>{props.mcp.enabled ? t('common.yes') : t('common.no')}</td>
        <td className="data-table__nowrap">
          <McpProbeStatusChip status={uiStatus} title={props.probe?.errorMessage ?? undefined} />
        </td>
        <td className="data-table__nowrap">{latencyLabel}</td>
        <td className="data-table__nowrap">
          {toolCount === null ? t('common.emDash') : String(toolCount)}
        </td>
        <td className="data-table__actions">
          <Link to="/mcps/$name" params={{ name: props.mcp.name }} className="btn btn--sm">
            {t('common.open')}
          </Link>
          <ConfirmButton
            label={t('mcps.deleteButton')}
            onConfirm={props.onDelete}
            danger
            disabled={props.deleteDisabled}
            size="sm"
          />
        </td>
      </tr>
      {props.isExpanded && (
        <tr className="data-table__expanded-row" data-testid={`mcp-row-expanded-${props.mcp.name}`}>
          <td />
          <td colSpan={8} className="mcp-expanded-cell">
            <McpExpandedSummary
              probe={props.probe}
              mcpName={props.mcp.name}
              onReprobe={() => probeMut.mutate()}
              isProbing={probeMut.isPending}
            />
          </td>
        </tr>
      )}
    </>
  )
}

interface McpExpandedSummaryProps {
  probe: McpProbe | null
  mcpName: string
  onReprobe: () => void
  isProbing: boolean
}

function McpExpandedSummary(props: McpExpandedSummaryProps) {
  const { t } = useTranslation()
  const tools = props.probe?.tools ?? null
  const visible = tools === null ? [] : tools.slice(0, MAX_INLINE_TOOL_CHIPS)
  const overflow = tools === null ? 0 : Math.max(0, tools.length - visible.length)
  return (
    <div className="mcp-expanded">
      <div className="mcp-expanded__tools">
        {tools === null && <span className="muted">{t('mcps.probe.expandNotProbed')}</span>}
        {tools !== null && tools.length === 0 && (
          <span className="muted">{t('mcps.probe.expandNoTools')}</span>
        )}
        {visible.map((tool) => (
          <span
            key={tool.name}
            className="chip chip--tight mcp-tool-chip"
            title={tool.description ?? undefined}
          >
            {tool.name}
          </span>
        ))}
        {overflow > 0 && (
          <span className="chip chip--tight chip--muted">
            {t('mcps.probe.moreCount', { count: overflow })}
          </span>
        )}
      </div>
      <div className="mcp-expanded__actions">
        <button
          type="button"
          className="btn btn--sm"
          onClick={props.onReprobe}
          disabled={props.isProbing}
          data-testid={`mcp-reprobe-${props.mcpName}`}
        >
          {props.isProbing ? t('mcps.probe.btnRunning') : t('mcps.probe.btnRun')}
        </button>
        <Link to="/mcps/$name" params={{ name: props.mcpName }} className="btn btn--sm btn--ghost">
          {t('mcps.probe.viewFull')}
        </Link>
      </div>
    </div>
  )
}

function deriveUiStatus(probe: McpProbe | null, isProbing: boolean): McpProbeUiStatus {
  if (isProbing) return 'probing'
  if (probe === null) return 'unknown'
  return probe.status === 'ok' ? 'ok' : 'error'
}

function formatLatency(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}
