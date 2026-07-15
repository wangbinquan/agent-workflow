// RFC-190 — the capability portal's six-tile matrix: one tile per platform
// capability (agents / workflows / workgroups / memory / scheduled / repos),
// each with a live per-actor count from /api/overview, a one-line capability
// description, and a whole-tile link to the list page.
//
// Tile chrome is the shared <Card interactive to=…> (design gate P1-9 —
// no second card chrome); `.home-cap*` classes only lay out the grid and the
// icon/count/title/desc stack inside the card body.
//
// Count semantics: number → render it; null (actor lacks the coarse read
// permission, D2) → an em-dash with an explanatory title; query still
// loading or failed → em-dash as well, plus one compact retry row under the
// grid on failure. `variant="intro"` (Onboarding) skips the query entirely
// and renders no count row — a fresh install shouldn't greet users with a
// wall of zeros.

import type { ReactElement, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { OverviewResources } from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import {
  AGENT_ICON,
  MEMORY_ICON,
  REPO_ICON,
  SCHEDULE_ICON,
  WORKFLOW_ICON,
  WORKGROUP_ICON,
} from '@/components/icons/resourceIcons'
import { useOverview } from './useOverview'

type CapKey = 'agents' | 'workflows' | 'workgroups' | 'memory' | 'scheduled' | 'repos'

interface TileSpec {
  key: CapKey
  to: string
  search?: Record<string, string>
  icon: ReactNode
  /** overview.resources key feeding the count. */
  resource: keyof OverviewResources
}

const TILES: TileSpec[] = [
  { key: 'agents', to: '/agents', icon: AGENT_ICON, resource: 'agents' },
  { key: 'workflows', to: '/workflows', icon: WORKFLOW_ICON, resource: 'workflows' },
  { key: 'workgroups', to: '/workgroups', icon: WORKGROUP_ICON, resource: 'workgroups' },
  // Deep-link to the "all" tab — its default view is the approved pool, so
  // the tile count and the landing page agree (design gate P2-6).
  { key: 'memory', to: '/memory', search: { tab: 'all' }, icon: MEMORY_ICON, resource: 'memories' },
  { key: 'scheduled', to: '/scheduled', icon: SCHEDULE_ICON, resource: 'scheduled' },
  { key: 'repos', to: '/repos', icon: REPO_ICON, resource: 'repos' },
]

interface CapabilityGridProps {
  /** 'live' (default) fetches /api/overview; 'intro' renders count-less tiles. */
  variant?: 'live' | 'intro'
}

export function CapabilityGrid({ variant = 'live' }: CapabilityGridProps): ReactElement {
  const { t } = useTranslation()
  const live = variant === 'live'
  const overview = useOverview({ enabled: live })
  const resources = overview.data?.resources

  const agentsSub = live ? describeAgentsSub(t, resources) : null

  return (
    <div className="home-cap" data-testid="home-cap-grid">
      <div className="home-cap-grid">
        {TILES.map((tile) => (
          <Card
            key={tile.key}
            interactive
            to={tile.to as never}
            search={tile.search as never}
            className="home-cap__tile"
            data-testid={`home-cap-${tile.key}`}
          >
            <span className="home-cap__icon" aria-hidden="true">
              {tile.icon}
            </span>
            {live && (
              <span
                className="home-cap__count"
                data-testid={`home-cap-${tile.key}-count`}
                title={
                  resources?.[tile.resource] === null ? t('home.cap.countUnavailable') : undefined
                }
              >
                {resources?.[tile.resource] ?? '—'}
              </span>
            )}
            <span className="home-cap__title">{t(`home.cap.${tile.key}.title`)}</span>
            <span className="home-cap__desc">{t(`home.cap.${tile.key}.desc`)}</span>
            {tile.key === 'agents' && agentsSub !== null && (
              <span className="home-cap__sub" data-testid="home-cap-agents-sub">
                {agentsSub}
              </span>
            )}
          </Card>
        ))}
      </div>
      {live && overview.isError && (
        <div className="home-cap__error muted" role="status">
          <span>{t('home.section.error.generic')}</span>
          <button type="button" className="btn btn--xs" onClick={() => void overview.refetch()}>
            {t('home.section.error.retry')}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The agents tile's secondary line ("技能 X · MCP Y · 插件 Z"). null-count
 * members drop out individually; all-null (or no data yet) drops the line.
 */
function describeAgentsSub(
  t: (key: string, opts?: Record<string, unknown>) => string,
  resources: OverviewResources | undefined,
): string | null {
  if (resources === undefined) return null
  const parts: string[] = []
  if (resources.skills !== null)
    parts.push(t('home.cap.agents.sub.skills', { n: resources.skills }))
  if (resources.mcps !== null) parts.push(t('home.cap.agents.sub.mcps', { n: resources.mcps }))
  if (resources.plugins !== null)
    parts.push(t('home.cap.agents.sub.plugins', { n: resources.plugins }))
  if (parts.length === 0) return null
  return parts.join(' · ')
}
