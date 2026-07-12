// Agents page — RFC-169 split (master-detail) layout route.
//
// The left rail (search + agent cards + "+ new") stays mounted; the right rail
// is the routed <Outlet/> (empty pane / edit / inline new). Cards are
// zero-button — open = click, launch/delete/ACL moved into the detail header.

import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, createRoute, useMatchRoute, useParams } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { Agent } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useResourceList } from '@/hooks/useResourceList'
import { EmptyState } from '@/components/EmptyState'
import { ResourceBadges } from '@/components/ResourceBadges'
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
          return {
            key: a.name,
            title: a.name,
            subtitle: a.description || undefined,
            to: '/agents/$name',
            params: { name: a.name },
            badges: (
              <>
                {runtimeName != null && (
                  <StatusChip kind="neutral" size="sm">
                    {runtimeName}
                  </StatusChip>
                )}
                {a.runtime == null && defaultRuntimeName != null && (
                  <StatusChip kind="neutral" size="sm">
                    {t('agents.runtimeDefaultTag')}
                  </StatusChip>
                )}
                <ResourceBadges
                  visibility={a.visibility}
                  ownerUserId={a.ownerUserId}
                  owners={owners}
                />
                {a.builtin === true && (
                  <span className="chip chip--tight">{t('agents.builtin')}</span>
                )}
              </>
            ),
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
    >
      <Outlet />
    </ResourceSplitPage>
  )
}

function AgentsEmptyPane() {
  const { t } = useTranslation()
  return (
    <EmptyState
      title={t('splitPage.emptyPaneTitle')}
      description={t('splitPage.emptyPaneHint')}
      action={
        <Link to="/agents/new" className="btn btn--primary">
          {t('agents.newButton')}
        </Link>
      }
    />
  )
}
