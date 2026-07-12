// Skills page — RFC-169 split (master-detail) layout route.
//
// Left rail = search + skill cards + "+ new"; right rail = the routed
// <Outlet/>. The empty pane (nothing selected) hosts the SkillSourcesCard: the
// source-folder rescan/remove panel is a global operation, semantically "not
// focused on any one skill" (T-D3).

import { Link, Outlet, createRoute, useMatchRoute, useParams } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { Skill } from '@agent-workflow/shared'
import { useResourceList } from '@/hooks/useResourceList'
import { EmptyState } from '@/components/EmptyState'
import { ResourceBadges } from '@/components/ResourceBadges'
import { SkillSourcesCard } from '@/components/SkillSourcesCard'
import { ResourceSplitPage, type ResourceCardItem } from '@/components/split/ResourceSplitPage'
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
  const { data, isLoading, error, owners } = useResourceList<Skill>({
    queryKey: ['skills'],
    endpoint: '/api/skills',
    deleteBy: 'name',
  })

  const params = useParams({ strict: false }) as { name?: string }
  const matchRoute = useMatchRoute()
  const isNew = matchRoute({ to: '/skills/new' }) !== false

  const items: ResourceCardItem[] | undefined =
    data === undefined
      ? undefined
      : data.map((s) => ({
          key: s.name,
          title: s.name,
          subtitle: s.description || undefined,
          to: '/skills/$name',
          params: { name: s.name },
          badges: (
            <>
              <span className={`chip chip--tight chip--${s.sourceKind}`}>
                {t(s.sourceKind === 'managed' ? 'skills.tabManaged' : 'skills.tabExternal')}
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
      title={t('skills.title')}
      items={items}
      isLoading={isLoading}
      error={error}
      selectedKey={isNew ? null : (params.name ?? null)}
      newActive={isNew}
      newLabel={t('skills.newButton')}
      newTo="/skills/new"
      searchPlaceholder={t('common.searchEllipsis')}
      emptyListText={t('skills.emptyList')}
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
        action={
          <Link to="/skills/new" className="btn btn--primary">
            {t('skills.newButton')}
          </Link>
        }
      />
      <SkillSourcesCard />
    </div>
  )
}
