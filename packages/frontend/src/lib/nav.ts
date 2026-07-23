// RFC-032: navigation data model + active-state resolver.
//
// `NAV_GROUPS` is the source of truth for the three sidebar groups (agents /
// workflows / tasks). `resolveActiveNav` is a pure function so unit tests can
// exhaustively cover every route → group mapping without spinning up a router.

import type { ResourceIconKey } from '@/components/icons/resourceIcons'

export type GroupKey = 'agents' | 'workflows' | 'tasks' | 'memory'

export interface SubNavItem {
  to: string
  i18nKey: string
  icon: ResourceIconKey
}

export interface NavGroupEntry {
  key: GroupKey
  i18nKey: string
  subnav: SubNavItem[]
}

/**
 * PR2 of RFC-032 lifts `/reviews` and `/clarify` out of the workflows group
 * — both now live behind the unified inbox drawer triggered by the footer
 * button. Their detail pages (`/reviews/:id`, `/clarify/:id`) still exist,
 * and `resolveActiveNav` still maps those paths to the workflows group via
 * the fallback at the bottom so detail-page deep links keep their group
 * highlight.
 */
export const NAV_GROUPS: NavGroupEntry[] = [
  {
    key: 'agents',
    i18nKey: 'nav.group.agents',
    subnav: [
      { to: '/agents', i18nKey: 'nav.agents', icon: 'agent' },
      { to: '/skills', i18nKey: 'nav.skills', icon: 'skill' },
      { to: '/mcps', i18nKey: 'nav.mcps', icon: 'mcp' },
      { to: '/plugins', i18nKey: 'nav.plugins', icon: 'plugin' },
    ],
  },
  {
    key: 'workflows',
    i18nKey: 'nav.group.workflows',
    subnav: [
      { to: '/workflows', i18nKey: 'nav.workflows', icon: 'workflow' },
      // RFC-164: workgroups are launched like workflows, so they live in
      // the same group.
      { to: '/workgroups', i18nKey: 'nav.workgroups', icon: 'workgroup' },
    ],
  },
  {
    key: 'tasks',
    i18nKey: 'nav.group.tasks',
    subnav: [
      { to: '/tasks', i18nKey: 'nav.tasks', icon: 'task' },
      { to: '/scheduled', i18nKey: 'nav.scheduled', icon: 'schedule' },
      { to: '/repos', i18nKey: 'nav.repos', icon: 'repo' },
    ],
  },
  // RFC-041 PR4 follow-up: mirror the single-item Workflows-group shape so
  // the sidebar reads as four parallel categories. Pending work is rendered
  // as a status badge inside the one Memory Link, which always enters the
  // stable `?tab=all` library default.
  {
    key: 'memory',
    i18nKey: 'nav.group.memory',
    subnav: [{ to: '/memory', i18nKey: 'nav.memory', icon: 'memory' }],
  },
]

export interface ActiveNav {
  /** True iff the user is on `/` (the homepage). */
  onHome: boolean
  /** True iff the user is on `/settings*`. Used to highlight the footer gear. */
  onSettings: boolean
  /** Group that owns the current path; `null` when on home / settings / unknown. */
  activeGroup: GroupKey | null
  /** The `to` of the matched sub-item, or `null` if no sub-item matches. */
  activeItemTo: string | null
}

/**
 * Map `location.pathname` to an active-state record consumed by the shell.
 *
 * Special cases:
 * - `/` → `onHome:true`; everything else false/null.
 * - `/settings` / `/settings/*` → `onSettings:true`; nav stays inactive (the
 *   footer gear is what gets highlighted).
 * - `/reviews*` / `/clarify*` → no longer enumerated in `NAV_GROUPS` (PR2
 *   lifted them into the unified inbox drawer); the fallback at the bottom
 *   keeps `activeGroup = 'workflows'` so detail-page deep links retain the
 *   correct group highlight even though the items themselves are gone.
 */
export function resolveActiveNav(pathname: string): ActiveNav {
  if (pathname === '/') {
    return { onHome: true, onSettings: false, activeGroup: null, activeItemTo: null }
  }
  if (pathname === '/settings' || pathname.startsWith('/settings/')) {
    return { onHome: false, onSettings: true, activeGroup: null, activeItemTo: null }
  }
  for (const g of NAV_GROUPS) {
    for (const sub of g.subnav) {
      if (pathname === sub.to || pathname.startsWith(sub.to + '/')) {
        return {
          onHome: false,
          onSettings: false,
          activeGroup: g.key,
          activeItemTo: sub.to,
        }
      }
    }
  }
  // Detail-route fallbacks for paths not enumerated in NAV_GROUPS.
  if (pathname.startsWith('/reviews') || pathname.startsWith('/clarify')) {
    return { onHome: false, onSettings: false, activeGroup: 'workflows', activeItemTo: null }
  }
  // RFC-121: fusions live under the Memory page now (its "fusion" tab), so a
  // /fusions/:id detail deep-link keeps the Memory group highlighted.
  if (pathname.startsWith('/fusions')) {
    return { onHome: false, onSettings: false, activeGroup: 'memory', activeItemTo: null }
  }
  return { onHome: false, onSettings: false, activeGroup: null, activeItemTo: null }
}
