// RFC-201: navigation between sibling routes/resources.
//
// Peer navigation is deliberately link-owned: the route supplies the real
// TanStack Link so native href, modifier-click, copy-link, and preloading
// behavior remain intact. This component owns only the shared <nav> semantics
// and current-page presentation contract.

import { Fragment, type ReactNode } from 'react'

export interface PeerNavItem<K extends string = string> {
  key: K
  label: ReactNode
}

export interface PeerNavDestinationState {
  className: string
  ariaCurrent?: 'page'
  children: ReactNode
}

interface PeerNavProps<Item extends PeerNavItem> {
  items: readonly Item[]
  activeKey: Item['key']
  ariaLabel: string
  renderDestination: (item: Item, state: PeerNavDestinationState) => ReactNode
  className?: string
  rootTestid?: string
}

export function PeerNav<Item extends PeerNavItem>({
  items,
  activeKey,
  ariaLabel,
  renderDestination,
  className,
  rootTestid,
}: PeerNavProps<Item>) {
  return (
    <nav
      aria-label={ariaLabel}
      className={
        'peer-nav page__actions' +
        (className === undefined || className === '' ? '' : ` ${className}`)
      }
      data-testid={rootTestid}
    >
      {items.map((item) => {
        const isCurrent = item.key === activeKey
        return (
          <Fragment key={item.key}>
            {renderDestination(item, {
              className: `btn btn--sm${isCurrent ? ' btn--primary' : ''}`,
              ariaCurrent: isCurrent ? 'page' : undefined,
              children: item.label,
            })}
          </Fragment>
        )
      })}
    </nav>
  )
}
