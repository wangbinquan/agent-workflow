// Plugins page — RFC-169 split (master-detail) layout route.
//
// Cards key on plugin id, carry sourceKind + version + enabled + "update
// available" chips. The update state is a shared query cache (['plugins',
// 'updates']) written by the detail "Updates" tab's check-update and read here,
// keyed by stable id + exact operationConfigHash so a re-installed/ACL-edited
// plugin cannot keep a stale chip. Per-row actions live in the detail Updates
// tab.

import { useQuery } from '@tanstack/react-query'
import { Outlet, createRoute, useMatchRoute, useParams } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { PluginOperationResource } from '@agent-workflow/shared'
import { useResourceList } from '@/hooks/useResourceList'
import { EmptyState } from '@/components/EmptyState'
import { ResourceBadges } from '@/components/ResourceBadges'
import { ResourceSplitPage, type ResourceCardItem } from '@/components/split/ResourceSplitPage'
import { StatusChip } from '@/components/StatusChip'
import {
  PLUGIN_UPDATES_KEY,
  pluginUpdateEntry,
  pluginUpdateAvailable,
  type PluginUpdatesCache,
} from '@/lib/plugin-updates'
import { PLUGIN_ICON } from '@/components/icons/resourceIcons'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/plugins',
  component: PluginsSplitLayout,
})

export const IndexRoute = createRoute({
  getParentRoute: () => Route,
  path: '/',
  component: PluginsEmptyPane,
})

function PluginsSplitLayout() {
  const { t } = useTranslation()
  const { data, isLoading, error, refetch, owners } = useResourceList<PluginOperationResource>({
    queryKey: ['plugins'],
    endpoint: '/api/plugins',
  })
  // Pure cache carrier — no fetcher; the detail Updates tab writes it.
  const updates = useQuery<PluginUpdatesCache>({
    queryKey: PLUGIN_UPDATES_KEY,
    enabled: false,
    gcTime: Infinity,
    staleTime: Infinity,
  })
  const updateCache = updates.data ?? {}

  const params = useParams({ strict: false }) as { id?: string }
  const matchRoute = useMatchRoute()
  const isNew = matchRoute({ to: '/plugins/new' }) !== false

  const items: ResourceCardItem[] | undefined =
    data === undefined
      ? undefined
      : data.map((p) => ({
          key: p.id,
          kind: 'plugin' as const,
          title: p.name,
          subtitle: p.spec,
          updatedAt: p.updatedAt,
          searchText: [
            t(`plugins.sourceKind.${p.sourceKind}`),
            p.resolvedVersion ?? '',
            !p.enabled ? t('plugins.disabledChip') : '',
            pluginUpdateAvailable(pluginUpdateEntry(updateCache, p), p)
              ? t('plugins.updateAvailableChip')
              : '',
            p.visibility === 'private' ? t('acl.privateChip') : '',
            p.ownerUserId != null ? (owners.get(p.ownerUserId)?.displayName ?? p.ownerUserId) : '',
          ].join(' '),
          to: '/plugins/$id',
          params: { id: p.id },
          primaryStatus: pluginUpdateAvailable(pluginUpdateEntry(updateCache, p), p) ? (
            <StatusChip kind="info" size="sm" withDot data-testid={`plugin-update-${p.name}`}>
              {t('plugins.updateAvailableChip')}
            </StatusChip>
          ) : undefined,
          badges: (
            <>
              <span className="chip chip--tight">{t(`plugins.sourceKind.${p.sourceKind}`)}</span>
              {p.resolvedVersion != null && (
                <span className="muted split-card__version">{p.resolvedVersion}</span>
              )}
              {!p.enabled && <span className="chip chip--tight">{t('plugins.disabledChip')}</span>}
              <ResourceBadges
                visibility={p.visibility}
                ownerUserId={p.ownerUserId}
                owners={owners}
              />
            </>
          ),
        }))

  return (
    <ResourceSplitPage
      title={t('plugins.title')}
      items={items}
      isLoading={isLoading}
      error={error}
      selectedKey={isNew ? null : (params.id ?? null)}
      newActive={isNew}
      newLabel={t('plugins.newButton')}
      newTo="/plugins/new"
      searchPlaceholder={t('common.searchEllipsis')}
      emptyListText={t('plugins.emptyList')}
      emptyDescription={t('plugins.emptyDescription')}
      emptyIcon={PLUGIN_ICON}
      onRetry={() => void refetch()}
      listTo="/plugins"
      mobileBackLabel={t('common.backToList')}
      mobileBackTestId="plugins-mobile-back"
    >
      <Outlet />
    </ResourceSplitPage>
  )
}

function PluginsEmptyPane() {
  const { t } = useTranslation()
  return (
    <EmptyState title={t('splitPage.emptyPaneTitle')} description={t('splitPage.emptyPaneHint')} />
  )
}
