// RFC-035 — unified status chip primitive.
//
// One component for every "this thing is success/warn/danger/info/neutral"
// indicator across the app. Replaces the four parallel implementations
// previously listed in design/ux-audit.md §2.2:
//   - <TaskStatusChip>          (task list / detail header)
//   - <StatusBadge>             (inventory: agent/skill/plugin/mcp rows)
//   - <McpProbeStatusChip>      (MCP probe results)
//   - task-row__status inline   (homepage running/recent rows)

import type { ReactElement, ReactNode } from 'react'

export type StatusChipKind = 'success' | 'warn' | 'danger' | 'info' | 'neutral'
export type StatusChipSize = 'sm' | 'md'

export interface StatusChipProps {
  kind: StatusChipKind
  size?: StatusChipSize
  children: ReactNode
  /** Render a leading 6×6 dot in the chip's color (probe / live indicator). */
  withDot?: boolean
  title?: string
  'aria-label'?: string
  'data-testid'?: string
  /** Extra class names appended to the standard `status-chip` chain. */
  className?: string
  /**
   * RFC-182 D9 — optional click affordance: present ⇒ the chip renders as a
   * real `<button type="button">` (keyboard-focusable, Enter/Space fire) with
   * a `--clickable` modifier for focus/hover styling; absent ⇒ the historical
   * `<span>` markup byte-for-byte (every existing caller unchanged).
   */
  onClick?: () => void
}

export function StatusChip(props: StatusChipProps): ReactElement {
  const size = props.size ?? 'md'
  const ariaLabel = props['aria-label']
  const classes = ['status-chip', `status-chip--${props.kind}`, `status-chip--${size}`]
  if (props.withDot === true) classes.push('status-chip--with-dot')
  if (props.onClick !== undefined) classes.push('status-chip--clickable')
  if (props.className !== undefined && props.className !== '') classes.push(props.className)
  const inner = (
    <>
      {props.withDot === true && <span className="status-chip__dot" aria-hidden="true" />}
      {props.children}
    </>
  )
  if (props.onClick !== undefined) {
    return (
      <button
        type="button"
        className={classes.join(' ')}
        title={props.title}
        aria-label={ariaLabel}
        data-testid={props['data-testid']}
        onClick={props.onClick}
      >
        {inner}
      </button>
    )
  }
  // `role=status` is only added when the consumer gives us a label, so
  // decorative chips don't pollute the accessibility tree.
  const role = ariaLabel !== undefined || props.title !== undefined ? 'status' : undefined
  return (
    <span
      className={classes.join(' ')}
      role={role}
      title={props.title}
      aria-label={ariaLabel}
      data-testid={props['data-testid']}
    >
      {inner}
    </span>
  )
}
