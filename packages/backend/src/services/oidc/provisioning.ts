// RFC-036 — pure provisioning policy decision tree. Lifted out of the
// callback handler so the 6-path table is unit-testable without any HTTP /
// DB plumbing. `decideProvisioning` is the only export; callers translate
// the returned action into actual DB writes.

import type { OidcProvider } from '@agent-workflow/shared'

export interface IdTokenClaims {
  sub: string
  email?: string | null
  email_verified?: boolean | null
  name?: string | null
  preferred_username?: string | null
}

export interface ExistingIdentity {
  userId: string
}

export interface ExistingInvitedUser {
  id: string
  email: string | null
  status: 'active' | 'disabled' | 'invited'
}

export type ProvisioningDecision =
  | { action: 'login'; userId: string }
  | { action: 'create' }
  | { action: 'bindInvited'; userId: string }
  | { action: 'reject'; reason: string }

/**
 * RFC-220 D3 — per-provider email trust: when the admin explicitly declared
 * the IdP's emails trustworthy, a present email counts as verified on BOTH
 * identity paths (pure OAuth2 userinfo rarely carries email_verified, and
 * plenty of OIDC IdPs omit it too). Pure; applied by the callback before
 * decideProvisioning so the decision tree itself stays untouched.
 */
export function applyEmailTrust(claims: IdTokenClaims, trustEmailVerified: boolean): IdTokenClaims {
  if (trustEmailVerified && claims.email) return { ...claims, email_verified: true }
  return claims
}

/**
 * Pure function — given the persisted provider config, the IdP-issued id_token
 * claims, and any pre-existing user_identities / invited users matched by
 * email, decide what the framework should do next.
 *
 * Branch table (matches design.md §5.5):
 *   existingIdentity present                       → login
 *   provisioning='auto'                            → create (no email check)
 *   provisioning='allowlist' + email domain match  → create
 *   provisioning='allowlist' + miss                → reject('email-domain-not-allowed')
 *   provisioning='invite' + email_verified + match → bindInvited
 *   provisioning='invite' + miss                   → reject('not-invited')
 */
export function decideProvisioning(
  provider: Pick<OidcProvider, 'provisioning' | 'allowedEmailDomains'>,
  claims: IdTokenClaims,
  existingIdentity: ExistingIdentity | null,
  existingInvitedUser: ExistingInvitedUser | null,
): ProvisioningDecision {
  if (existingIdentity) {
    return { action: 'login', userId: existingIdentity.userId }
  }
  if (provider.provisioning === 'auto') {
    return { action: 'create' }
  }
  if (provider.provisioning === 'allowlist') {
    const email = claims.email?.toLowerCase()
    if (!email || !claims.email_verified) {
      return { action: 'reject', reason: 'email-not-verified' }
    }
    const ok = provider.allowedEmailDomains.some((d) => email.endsWith(d.toLowerCase()))
    return ok ? { action: 'create' } : { action: 'reject', reason: 'email-domain-not-allowed' }
  }
  // 'invite'
  if (existingInvitedUser && claims.email_verified) {
    return { action: 'bindInvited', userId: existingInvitedUser.id }
  }
  return { action: 'reject', reason: 'not-invited' }
}
