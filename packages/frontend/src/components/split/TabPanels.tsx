// RFC-169 (T5) — keep-mounted tab panels (§3.4, R2-P1-2). Inactive panels are
// hidden via the `hidden` attribute rather than unmounted, so child-owned local
// buffers (a half-typed skill file, a staged ZIP, an invalid-JSON field) survive
// tab switches instead of being dropped on every switch.

import type { ReactNode } from 'react'
import { tabDomIds } from '../TabBar'

export interface TabPanelDef<K extends string> {
  key: K
  content: ReactNode
  testid?: string
  /** Per-panel extra class (e.g. the prompt panel that fills instead of scrolls). */
  className?: string
}

export function TabPanels<K extends string>(props: {
  active: K
  panels: ReadonlyArray<TabPanelDef<K>>
  /** Class applied to every panel (the shared scroll body). */
  className?: string
  /** Stable DOM id namespace shared with the matching TabBar. */
  idPrefix?: string
}) {
  return (
    <>
      {props.panels.map((p) => {
        const ids = props.idPrefix === undefined ? undefined : tabDomIds(props.idPrefix, p.key)
        return (
          <div
            key={p.key}
            role="tabpanel"
            id={ids?.panelId}
            aria-labelledby={ids?.tabId}
            hidden={p.key !== props.active}
            data-testid={p.testid}
            className={[props.className, p.className].filter(Boolean).join(' ') || undefined}
          >
            {p.content}
          </div>
        )
      })}
    </>
  )
}
