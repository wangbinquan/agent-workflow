// RFC-032: one of the three sidebar nav groups (Agents / Workflows / Tasks).
//
// Each group renders one plain section label and its icon-led route items.

import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ResourceIcon } from '@/components/icons/resourceIcons'
import type { ActiveNav, NavGroupEntry, SubNavItem } from '@/lib/nav'

interface NavGroupProps {
  group: NavGroupEntry
  active: ActiveNav
  /** Optional sibling action factory (for example Memory pending review). */
  renderAccessory?: (item: SubNavItem) => ReactNode
}

export function NavGroup({ group, active, renderAccessory }: NavGroupProps) {
  const { t } = useTranslation()
  return (
    <div className="nav-group" data-group={group.key}>
      <div className="nav-group__header">
        <span>{t(group.i18nKey)}</span>
      </div>
      <div className="nav-group__items">
        {group.subnav.map((item) => (
          <NavItem
            key={item.to}
            item={item}
            isActive={active.activeItemTo === item.to}
            accessory={renderAccessory ? renderAccessory(item) : null}
          />
        ))}
      </div>
    </div>
  )
}

interface NavItemProps {
  item: SubNavItem
  isActive: boolean
  accessory: ReactNode
}

function NavItem({ item, isActive, accessory }: NavItemProps) {
  const { t } = useTranslation()
  const className = ['nav-item', isActive ? 'nav-item--active' : null].filter(Boolean).join(' ')
  return (
    <div className={`nav-item-row${isActive ? ' nav-item-row--active' : ''}`}>
      <Link
        to={item.to}
        search={item.to === '/memory' ? { tab: 'all' } : undefined}
        className={`${className} nav-item__main`}
        activeProps={{ className: `${className} nav-item__main nav-item--active` }}
      >
        <span className="nav-item__icon" aria-hidden="true">
          <ResourceIcon name={item.icon} />
        </span>
        <span className="nav-item__label">{t(item.i18nKey)}</span>
      </Link>
      {accessory}
    </div>
  )
}
