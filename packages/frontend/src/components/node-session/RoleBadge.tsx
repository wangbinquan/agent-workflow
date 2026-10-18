// RFC-027 / RFC-377: shared role chip for conversation and subagent blocks.

export type RoleVariant = 'user' | 'assistant' | 'reasoning' | 'tool' | 'subagent'

/**
 * Visually distinct role chip rendered in the top-left of every session
 * block. Colored pill + icon + uppercase label so users can scan the
 * conversation by role at a glance — RFC-027 §UX revision.
 */
export function RoleBadge({
  variant,
  icon,
  label,
}: {
  variant: RoleVariant
  icon: string
  label: string
}) {
  return (
    <span className={`session-role-badge session-role-badge--${variant}`}>
      <span className="session-role-badge__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="session-role-badge__label">{label}</span>
    </span>
  )
}
