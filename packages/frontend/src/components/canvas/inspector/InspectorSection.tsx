import type { ReactNode } from 'react'

export function InspectorSection({
  title,
  collapsed = false,
  children,
}: {
  title: string
  collapsed?: boolean
  children: ReactNode
}) {
  const body = <div className="form-grid inspector-section__body">{children}</div>
  return collapsed ? (
    <details className="inspector-section inspector-section--collapsible">
      <summary>{title}</summary>
      {body}
    </details>
  ) : (
    <section className="inspector-section">
      <h3>{title}</h3>
      {body}
    </section>
  )
}
