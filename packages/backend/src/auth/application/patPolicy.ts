import {
  grantableMatrixPoints,
  resolveEffectiveAccountPermissions,
  type Permission,
  type Role,
} from '@agent-workflow/shared'

/** Raised when a requested matrix contains points the owner's account cannot grant. */
export class PatMatrixError extends Error {
  constructor(readonly ungrantable: ReadonlyArray<Permission>) {
    super(`matrix contains points this account cannot grant: ${ungrantable.join(', ')}`)
  }
}

/**
 * Reject an over-reaching matrix instead of silently narrowing it. This is an
 * application policy and deliberately has no persistence or provider input.
 */
export function assertMatrixGrantable(
  accountOrRole: ReadonlySet<Permission> | Role,
  scopes: ReadonlyArray<Permission>,
): void {
  const accountPermissions =
    typeof accountOrRole === 'string'
      ? resolveEffectiveAccountPermissions({ role: accountOrRole, additionalPermissions: [] })
      : accountOrRole
  const grantable = new Set(grantableMatrixPoints(accountPermissions))
  const ungrantable = scopes.filter((permission) => !grantable.has(permission))
  if (ungrantable.length > 0) throw new PatMatrixError(ungrantable)
}
