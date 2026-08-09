// MCPs page — RFC-169 split (master-detail) layout route.
//
// Cards carry the type + enabled + probe-status chips; the probe chip is gated
// on freshness (a config save invalidates the persisted probe → "needs
// re-probe"). The list expand-row体系 is retired — probe details live in the
// detail "Tools & probe" tab.

import { useMemo } from 'react'
import { Outlet, createRoute, useMatchRoute, useParams } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { Mcp, McpProbe } from '@agent-workflow/shared'
import { useResourceList } from '@/hooks/useResourceList'
import { EmptyState } from '@/components/EmptyState'
import { ResourceBadges } from '@/components/ResourceBadges'
import { McpProbeStatusChip, type McpProbeUiStatus } from '@/components/McpProbeStatusChip'
import { ResourceSplitPage, type ResourceCardItem } from '@/components/split/ResourceSplitPage'
import { useMcpProbes } from '@/lib/mcp-probe-query'
import { probeFreshness } from '@/lib/probe-freshness'
import { MCP_ICON } from '@/components/icons/resourceIcons'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/mcps',
  component: McpsSplitLayout,
})

export const IndexRoute = createRoute({
  getParentRoute: () => Route,
  path: '/',
  component: McpsEmptyPane,
})

/** Fresh probe → its ok/error status; no probe or stale → "unknown" (a config
 *  save since the last probe reads as "needs re-probe"). */
export function probeUiStatus(probe: McpProbe | null, mcpUpdatedAt: number): McpProbeUiStatus {
  if (!probeFreshness(probe, mcpUpdatedAt)) return 'unknown'
  return probe!.status === 'error' ? 'error' : 'ok'
}

function McpsSplitLayout() {
  const { t } = useTranslation()
  const { data, isLoading, error, refetch, owners } = useResourceList<Mcp>({
    queryKey: ['mcps'],
    endpoint: '/api/mcps',
  })
  const probesQ = useMcpProbes()
  const probesById = useMemo<Record<string, McpProbe>>(() => {
    const out: Record<string, McpProbe> = {}
    for (const p of probesQ.data ?? []) out[p.mcpId] = p
    return out
  }, [probesQ.data])

  const params = useParams({ strict: false }) as { id?: string }
  const matchRoute = useMatchRoute()
  const isNew = matchRoute({ to: '/mcps/new' }) !== false

  const items: ResourceCardItem[] | undefined =
    data === undefined
      ? undefined
      : data.map((m) => {
          const typeLabel = t(m.type === 'local' ? 'mcps.typeLocal' : 'mcps.typeRemote')
          const probeStatus = probeUiStatus(probesById[m.id] ?? null, m.updatedAt)
          return {
            key: m.id,
            kind: 'mcp' as const,
            title: m.name,
            subtitle: m.description || undefined,
            updatedAt: m.updatedAt,
            searchText: [
              typeLabel,
              t(`mcps.probe.status.${probeStatus}`),
              !m.enabled ? t('mcps.disabledChip') : '',
              m.visibility === 'private' ? t('acl.privateChip') : '',
              m.ownerUserId != null
                ? (owners.get(m.ownerUserId)?.displayName ?? m.ownerUserId)
                : '',
            ].join(' '),
            to: '/mcps/$id' as const,
            params: { id: m.id },
            primaryStatus: <McpProbeStatusChip status={probeStatus} />,
            badges: (
              <>
                <span className={`chip chip--tight chip--${m.type}`}>{typeLabel}</span>
                {!m.enabled && <span className="chip chip--tight">{t('mcps.disabledChip')}</span>}
                <ResourceBadges
                  visibility={m.visibility}
                  ownerUserId={m.ownerUserId}
                  owners={owners}
                />
              </>
            ),
          }
        })

  return (
    <ResourceSplitPage
      title={t('mcps.title')}
      items={items}
      isLoading={isLoading}
      error={error}
      selectedKey={isNew ? null : (params.id ?? null)}
      newActive={isNew}
      newLabel={t('mcps.newButton')}
      newTo="/mcps/new"
      searchPlaceholder={t('common.searchEllipsis')}
      emptyListText={t('mcps.emptyList')}
      emptyDescription={t('mcps.emptyDescription')}
      emptyIcon={MCP_ICON}
      onRetry={() => void refetch()}
      listTo="/mcps"
      mobileBackLabel={t('common.backToList')}
      mobileBackTestId="mcps-mobile-back"
    >
      <Outlet />
    </ResourceSplitPage>
  )
}

function McpsEmptyPane() {
  const { t } = useTranslation()
  return (
    <EmptyState title={t('splitPage.emptyPaneTitle')} description={t('splitPage.emptyPaneHint')} />
  )
}
