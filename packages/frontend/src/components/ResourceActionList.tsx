import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react'

const ResourceActionBusyContext = createContext<((busy: boolean) => void) | null>(null)

export function useResourceActionBusy(): ((busy: boolean) => void) | null {
  return useContext(ResourceActionBusyContext)
}

export function ResourceActionList({
  children,
  onBusyChange,
}: {
  children: ReactNode
  onBusyChange?: (busy: boolean) => void
}): ReactElement {
  const [busy, setBusy] = useState(false)
  const reportBusy = useCallback(
    (next: boolean) => {
      setBusy(next)
      onBusyChange?.(next)
    },
    [onBusyChange],
  )
  return (
    <ResourceActionBusyContext.Provider value={reportBusy}>
      <fieldset className="resource-action-list" disabled={busy} aria-busy={busy || undefined}>
        {children}
      </fieldset>
    </ResourceActionBusyContext.Provider>
  )
}

export interface ResourceActionItemProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children'
> {
  label: ReactNode
  description: ReactNode
  tone?: 'default' | 'danger'
}

export function ResourceActionItem({
  label,
  description,
  tone = 'default',
  className,
  ...buttonProps
}: ResourceActionItemProps): ReactElement {
  const classes = ['resource-action-list__item']
  if (tone === 'danger') classes.push('resource-action-list__item--danger')
  if (className !== undefined && className !== '') classes.push(className)
  return (
    <button type="button" className={classes.join(' ')} {...buttonProps}>
      <strong>{label}</strong>
      <span>{description}</span>
    </button>
  )
}
