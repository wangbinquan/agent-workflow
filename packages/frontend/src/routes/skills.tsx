// Skills page — RFC-169 split (master-detail) layout route.
//
// Left rail = search + skill cards + "+ new"; right rail = the routed
// <Outlet/>. RFC-178: skills are managed-only, so the empty pane just prompts
// to create one.

import { Outlet, createRoute, useMatchRoute, useParams } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { Skill } from '@agent-workflow/shared'
import { useResourceList } from '@/hooks/useResourceList'
import { EmptyState } from '@/components/EmptyState'
import { ResourceBadges } from '@/components/ResourceBadges'
import { ResourcePackageImportEntry } from '@/components/ResourcePackageImportEntry'
import { ResourceSplitPage, type ResourceCardItem } from '@/components/split/ResourceSplitPage'
import { SKILL_ICON } from '@/components/icons/resourceIcons'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/skills',
  component: SkillsSplitLayout,
})

export const IndexRoute = createRoute({
  getParentRoute: () => Route,
  path: '/',
  component: SkillsEmptyPane,
})

function SkillsSplitLayout() {
  const { t } = useTranslation()
  const { data, isLoading, error, refetch, owners } = useResourceList<Skill>({
    queryKey: ['skills'],
    endpoint: '/api/skills',
  })

  const params = useParams({ strict: false }) as { id?: string }
  const matchRoute = useMatchRoute()
  const isNew = matchRoute({ to: '/skills/new' }) !== false

  const items: ResourceCardItem[] | undefined =
    data === undefined
      ? undefined
      : data.map((s) => ({
          key: s.id,
          kind: 'skill' as const,
          title: s.name,
          subtitle: s.description || undefined,
          updatedAt: s.updatedAt,
          searchText: [
            t('skills.cardVersion', { version: s.contentVersion }),
            s.visibility === 'private' ? t('acl.privateChip') : '',
            s.ownerUserId != null ? (owners.get(s.ownerUserId)?.displayName ?? s.ownerUserId) : '',
          ].join(' '),
          to: '/skills/$id',
          params: { id: s.id },
          badges: (
            <>
              <span className="chip chip--tight">
                {t('skills.cardVersion', { version: s.contentVersion })}
              </span>
              <ResourceBadges
                visibility={s.visibility}
                ownerUserId={s.ownerUserId}
                owners={owners}
              />
            </>
          ),
        }))

  return (
    <ResourceSplitPage
      // RFC-271：配置包导入是**一个**入口通吃六类——包的根类型写在包里，用户不必
      // 先选「我要导入哪一类」。导入可能同时落多类资源，所以失效键不止本列表。
      listActions={
        <ResourcePackageImportEntry
          invalidateKeys={[['agents'], ['skills'], ['mcps'], ['plugins'], ['workflows']]}
        />
      }
      title={t('skills.title')}
      items={items}
      isLoading={isLoading}
      error={error}
      selectedKey={isNew ? null : (params.id ?? null)}
      newActive={isNew}
      newLabel={t('skills.newButton')}
      newTo="/skills/new"
      searchPlaceholder={t('common.searchEllipsis')}
      emptyListText={t('skills.emptyList')}
      emptyDescription={t('skills.emptyDescription')}
      emptyIcon={SKILL_ICON}
      onRetry={() => void refetch()}
      listTo="/skills"
      mobileBackLabel={t('common.backToList')}
      mobileBackTestId="skills-mobile-back"
    >
      <Outlet />
    </ResourceSplitPage>
  )
}

function SkillsEmptyPane() {
  const { t } = useTranslation()
  return (
    <div className="skills-empty-pane">
      <EmptyState
        title={t('splitPage.emptyPaneTitle')}
        description={t('splitPage.emptyPaneHint')}
      />
    </div>
  )
}
