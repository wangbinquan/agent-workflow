// RFC-032: navigation data model + active-state resolver.
//
// `NAV_GROUPS` is the source of truth for the sidebar groups. Navigation is a
// stable product-discovery surface: every authenticated account sees the whole
// catalog, while `permission` describes the destination's data capability and
// never decides whether the menu row exists. `resolveActiveNav` is pure so unit
// tests can exhaustively cover route → group mapping without spinning up a
// router.

import type { Permission } from '@agent-workflow/shared'
import type { ResourceIconKey } from '@/components/icons/resourceIcons'

export type GroupKey = 'agents' | 'workflows' | 'tasks' | 'memory'

export interface SubNavItem {
  to: string
  i18nKey: string
  icon: ResourceIconKey
  /** Data capability for the destination; not a navigation visibility gate. */
  permission: Permission
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
      { to: '/agents', i18nKey: 'nav.agents', icon: 'agent', permission: 'agents:read' },
      { to: '/skills', i18nKey: 'nav.skills', icon: 'skill', permission: 'skills:read' },
      { to: '/mcps', i18nKey: 'nav.mcps', icon: 'mcp', permission: 'mcps:read' },
      { to: '/plugins', i18nKey: 'nav.plugins', icon: 'plugin', permission: 'plugins:read' },
    ],
  },
  {
    key: 'workflows',
    i18nKey: 'nav.group.workflows',
    subnav: [
      {
        to: '/workflows',
        i18nKey: 'nav.workflows',
        icon: 'workflow',
        permission: 'workflows:read',
      },
      // RFC-164: workgroups are launched like workflows, so they live in
      // the same group.
      {
        to: '/workgroups',
        i18nKey: 'nav.workgroups',
        icon: 'workgroup',
        permission: 'workgroups:read',
      },
      // RFC-234: the intent builder authors workflows/workgroups (and their
      // agents/skills), so it lives beside them.
      { to: '/intent', i18nKey: 'nav.intent', icon: 'workflow', permission: 'intent:read' },
    ],
  },
  {
    key: 'tasks',
    i18nKey: 'nav.group.tasks',
    subnav: [
      { to: '/tasks', i18nKey: 'nav.tasks', icon: 'task', permission: 'tasks:read' },
      {
        to: '/scheduled',
        i18nKey: 'nav.scheduled',
        icon: 'schedule',
        permission: 'scheduled-tasks:read',
      },
      { to: '/repos', i18nKey: 'nav.repos', icon: 'repo', permission: 'repos:read' },
      // RFC-260/RFC-305：读面由 `webhook-endpoints:read` 控制；配置动作在页内
      // 按各自具体权限显示，导航模型不携带角色概念。
      {
        to: '/webhooks',
        i18nKey: 'nav.webhooks',
        icon: 'webhook',
        permission: 'webhook-endpoints:read',
      },
      // RFC-304 — `/code` 的读面按 `repos:read`：能力矩阵就是仓库配置的一部分。
      // 页内的写动作各自按 `repos:update` 渲染，导航模型不携带角色概念。
      { to: '/code', i18nKey: 'nav.code', icon: 'repo', permission: 'repos:read' },
    ],
  },
  // RFC-041 PR4 follow-up: mirror the single-item Workflows-group shape so
  // the sidebar reads as four parallel categories. Pending work is rendered
  // as a status badge inside the one Memory Link, which always enters the
  // stable `?tab=all` library default.
  {
    key: 'memory',
    i18nKey: 'nav.group.memory',
    subnav: [{ to: '/memory', i18nKey: 'nav.memory', icon: 'memory', permission: 'memory:read' }],
  },
]

/**
 * Resolve the read capability that owns a visible navigation destination.
 * Keeping this lookup on the same catalog prevents shell content gating from
 * drifting away from the menu it protects.
 */
export function navPermissionForPath(pathname: string): Permission | null {
  for (const group of NAV_GROUPS) {
    for (const item of group.subnav) {
      if (pathname === item.to || pathname.startsWith(item.to + '/')) return item.permission
    }
  }
  return null
}

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
