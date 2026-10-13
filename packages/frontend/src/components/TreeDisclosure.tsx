import './tree-disclosure.css'

/** Shared tree caret: the containing tree owns selection and keyboard movement. */
export function TreeDisclosure({
  expanded,
  label,
  onToggle,
  className = '',
}: {
  expanded: boolean
  label: string
  onToggle(): void
  className?: string
}) {
  return (
    <button
      type="button"
      className={`btn btn--ghost btn--sm tree-disclosure ${className}`}
      tabIndex={-1}
      aria-label={label}
      aria-expanded={expanded}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path d="m6 4 4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}
