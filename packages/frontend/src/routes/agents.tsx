// Agents page — RFC-169 split (master-detail) layout route.
//
// The left rail (search + agent cards + "+ new") stays mounted; the right rail
// is the routed <Outlet/> (empty pane / edit / inline new). Cards are
// zero-button — open = click, launch/delete/ACL moved into the detail header.

import { useQuery } from '@tanstack/react-query'
import { Outlet, createRoute, useMatchRoute, useParams } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { Agent } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useResourceList } from '@/hooks/useResourceList'
import { EmptyState } from '@/components/EmptyState'
import { ResourceSplitPage, type ResourceCardItem } from '@/components/split/ResourceSplitPage'
import { RUNTIMES_QUERY_KEY } from '@/components/RuntimeList'
import { StatusChip } from '@/components/StatusChip'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/agents',
  component: AgentsSplitLayout,
})

export const IndexRoute = createRoute({
  getParentRoute: () => Route,
  path: '/',
  component: AgentsEmptyPane,
})

function AgentsSplitLayout() {
  const { t } = useTranslation()
  // RFC-151 PR-3 — shared list shell: query + owner lookup (delete lives in the
  // detail header now).
  const { data, isLoading, error, owners } = useResourceList<Agent>({
    queryKey: ['agents'],
    endpoint: '/api/agents',
    deleteBy: 'name',
  })

  // RFC-115: each agent's runtime; inheriting agents fall back to the global
  // default runtime. Reuse the ['runtimes'] key the settings list uses.
  const runtimes = useQuery<{ runtimes: Array<{ name: string; isDefault: boolean }> }>({
    queryKey: RUNTIMES_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/runtimes', undefined, signal),
  })
  const defaultRuntimeName = runtimes.data?.runtimes.find((r) => r.isDefault)?.name

  const params = useParams({ strict: false }) as { name?: string }
  const matchRoute = useMatchRoute()
  const isNew = matchRoute({ to: '/agents/new' }) !== false

  const items: ResourceCardItem[] | undefined =
    data === undefined
      ? undefined
      : data.map((a) => {
          const runtimeName = a.runtime ?? defaultRuntimeName
          const inheritsDefaultRuntime = a.runtime == null && defaultRuntimeName != null
          const runtimeSummary =
            runtimeName == null
              ? undefined
              : inheritsDefaultRuntime
                ? `${runtimeName} · ${t('agents.runtimeDefaultTag')}`
                : runtimeName
          const inputCount = a.inputs?.length ?? 0
          const outputCount = a.outputs.length
          const portSummary = t('agents.cardPorts', {
            inputs: inputCount,
            outputs: outputCount,
          })
          const ownerName =
            a.ownerUserId != null ? (owners.get(a.ownerUserId)?.displayName ?? '') : ''
          const hasSummary =
            runtimeSummary != null ||
            inputCount + outputCount > 0 ||
            a.visibility === 'private' ||
            ownerName !== '' ||
            a.builtin === true
          return {
            key: a.name,
            kind: 'agent' as const,
            title: a.name,
            subtitle: a.description || undefined,
            primaryStatus:
              a.role === 'aggregator' ? (
                <StatusChip kind="info" size="sm">
                  {t('agentForm.roleAggregator')}
                </StatusChip>
              ) : undefined,
            searchText: [
              runtimeName ?? '',
              inputCount + outputCount > 0 ? portSummary : '',
              inheritsDefaultRuntime ? t('agents.runtimeDefaultTag') : '',
              a.builtin === true ? t('agents.builtin') : '',
              a.role === 'aggregator' ? t('agentForm.roleAggregator') : '',
              a.visibility === 'private' ? t('acl.privateChip') : '',
              ownerName,
            ].join(' '),
            to: '/agents/$name',
            params: { name: a.name },
            badges: hasSummary ? (
              <span className="agent-card__facts">
                {runtimeSummary != null && (
                  <span
                    className="agent-card__runtime"
                    title={runtimeSummary}
                    data-testid={`agent-runtime-${a.name}`}
                  >
                    {runtimeSummary}
                  </span>
                )}
                {inputCount + outputCount > 0 && (
                  <span className="agent-card__ports">{portSummary}</span>
                )}
                {a.visibility === 'private' && (
                  <span className="chip chip--tight">{t('acl.privateChip')}</span>
                )}
                {ownerName !== '' && (
                  <span
                    className="agent-card__owner"
                    title={`${t('acl.ownerBadge')}: ${ownerName}`}
                  >
                    {ownerName}
                  </span>
                )}
                {a.builtin === true && (
                  <span className="chip chip--tight">{t('agents.builtin')}</span>
                )}
              </span>
            ) : undefined,
          }
        })

  return (
    <ResourceSplitPage
      title={t('agents.title')}
      items={items}
      isLoading={isLoading}
      error={error}
      selectedKey={isNew ? null : (params.name ?? null)}
      newActive={isNew}
      newLabel={t('agents.newButton')}
      newTo="/agents/new"
      searchPlaceholder={t('common.searchEllipsis')}
      emptyListText={t('agents.emptyList')}
      listTo="/agents"
      mobileBackLabel={t('common.backToList')}
      mobileBackTestId="agents-mobile-back"
    >
      <Outlet />
    </ResourceSplitPage>
  )
}

function AgentsEmptyPane() {
  const { t } = useTranslation()
  return (
    <EmptyState title={t('splitPage.emptyPaneTitle')} description={t('splitPage.emptyPaneHint')} />
  )
}
