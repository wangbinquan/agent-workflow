import {
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

interface ManagedLiveRegionValue {
  announce: (message: string) => void
}

const ManagedLiveRegionContext = createContext<ManagedLiveRegionValue | null>(null)

export function useManagedLiveRegion(): ManagedLiveRegionValue | null {
  return useContext(ManagedLiveRegionContext)
}

export function readableAnnouncementText(...nodes: ReactNode[]): string {
  const parts: string[] = []

  function visit(node: ReactNode): void {
    if (typeof node === 'string' || typeof node === 'number') {
      const value = String(node).trim()
      if (value !== '') parts.push(value)
      return
    }
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (isValidElement<{ children?: ReactNode }>(node)) visit(node.props.children)
  }

  nodes.forEach(visit)
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

export function ManagedLiveRegionProvider({ children }: { children: ReactNode }) {
  const [announcement, setAnnouncement] = useState({ sequence: 0, message: '' })
  const announce = useCallback((message: string) => {
    const normalized = message.replace(/\s+/g, ' ').trim()
    if (normalized === '') return
    setAnnouncement((current) => ({ sequence: current.sequence + 1, message: normalized }))
  }, [])
  const value = useMemo(() => ({ announce }), [announce])

  return (
    <ManagedLiveRegionContext.Provider value={value}>
      {children}
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="managed-live-region"
      >
        <span key={announcement.sequence}>{announcement.message}</span>
      </div>
    </ManagedLiveRegionContext.Provider>
  )
}
