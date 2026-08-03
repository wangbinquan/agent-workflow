// RFC-249 — one compact expand/collapse control for dense operations tables.
//
// The task list established this interaction and visual language. Resource
// tables reuse the same component so chevron motion, hit target, focus ring,
// and accessible state cannot drift between surfaces.

export interface OperationsExpandButtonProps {
  expanded: boolean
  controls: string
  label: string
  testid?: string
  onToggle: () => void
}

export function OperationsChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

export function OperationsExpandButton(props: OperationsExpandButtonProps) {
  return (
    <button
      type="button"
      className="task-operations__expand-button"
      aria-expanded={props.expanded}
      aria-controls={props.controls}
      aria-label={props.label}
      data-testid={props.testid}
      onClick={props.onToggle}
    >
      <OperationsChevronIcon />
    </button>
  )
}
