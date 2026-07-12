// RFC-169 (T5) — keep-mounted tab panels (§3.4, R2-P1-2). Inactive panels are
// hidden via the `hidden` attribute rather than unmounted, so child-owned local
// buffers (a half-typed skill file, a staged ZIP, an invalid-JSON field) survive
// tab switches instead of being dropped on every switch.

import type { ReactNode } from 'react'

export interface TabPanelDef<K extends string> {
  key: K
  content: ReactNode
  testid?: string
}

export function TabPanels<K extends string>(props: {
  active: K
  panels: ReadonlyArray<TabPanelDef<K>>
  className?: string
}) {
  return (
    <>
      {props.panels.map((p) => (
        <div
          key={p.key}
          role="tabpanel"
          hidden={p.key !== props.active}
          data-testid={p.testid}
          className={props.className}
        >
          {p.content}
        </div>
      ))}
    </>
  )
}
