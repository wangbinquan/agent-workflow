// RFC-036 — decideProvisioning pure-function table tests (design.md §5.5).

import { describe, expect, test } from 'bun:test'
import type { OidcProvider } from '../src/schemas/oidcProvider'

// Re-export the function from backend so the snapshot lives in `shared` tests
// (CI three-piece guards both packages). The function itself remains a pure
// JS function with no DB / HTTP coupling.
import { decideProvisioning } from '../../backend/src/auth/oidc/provisioning'

const baseProvider = (
  patch: Partial<Pick<OidcProvider, 'provisioning' | 'allowedEmailDomains'>>,
): Pick<OidcProvider, 'provisioning' | 'allowedEmailDomains'> => ({
  provisioning: 'invite',
  allowedEmailDomains: [],
  ...patch,
})

describe('decideProvisioning', () => {
  test('existing identity → login (regardless of policy)', () => {
    const result = decideProvisioning(
      baseProvider({ provisioning: 'invite' }),
      { sub: 's1', email: 'x@y.com', email_verified: true },
      { userId: 'user-1' },
      null,
    )
    expect(result).toEqual({ action: 'login', userId: 'user-1' })
  })

  test('auto → create (no email check)', () => {
    const result = decideProvisioning(
      baseProvider({ provisioning: 'auto' }),
      { sub: 's2', email: null, email_verified: false },
      null,
      null,
    )
    expect(result).toEqual({ action: 'create' })
  })

  test('allowlist + verified + matching domain → create', () => {
    const result = decideProvisioning(
      baseProvider({ provisioning: 'allowlist', allowedEmailDomains: ['@corp.com'] }),
      { sub: 's3', email: 'alice@corp.com', email_verified: true },
      null,
      null,
    )
    expect(result).toEqual({ action: 'create' })
  })

  test('allowlist + verified + miss → reject email-domain-not-allowed', () => {
    const result = decideProvisioning(
      baseProvider({ provisioning: 'allowlist', allowedEmailDomains: ['@corp.com'] }),
      { sub: 's4', email: 'alice@gmail.com', email_verified: true },
      null,
      null,
    )
    expect(result).toEqual({ action: 'reject', reason: 'email-domain-not-allowed' })
  })

  test('allowlist + unverified → reject email-not-verified', () => {
    const result = decideProvisioning(
      baseProvider({ provisioning: 'allowlist', allowedEmailDomains: ['@corp.com'] }),
      { sub: 's5', email: 'alice@corp.com', email_verified: false },
      null,
      null,
    )
    expect(result).toEqual({ action: 'reject', reason: 'email-not-verified' })
  })

  test('invite + invited row + verified → bindInvited', () => {
    const result = decideProvisioning(
      baseProvider({ provisioning: 'invite' }),
      { sub: 's6', email: 'carol@corp.com', email_verified: true },
      null,
      { id: 'user-carol', email: 'carol@corp.com', status: 'invited' },
    )
    expect(result).toEqual({ action: 'bindInvited', userId: 'user-carol' })
  })

  test('invite + no invited row → reject not-invited', () => {
    const result = decideProvisioning(
      baseProvider({ provisioning: 'invite' }),
      { sub: 's7', email: 'mallory@corp.com', email_verified: true },
      null,
      null,
    )
    expect(result).toEqual({ action: 'reject', reason: 'not-invited' })
  })

  test('invite + invited row + unverified email → reject not-invited (safety)', () => {
    const result = decideProvisioning(
      baseProvider({ provisioning: 'invite' }),
      { sub: 's8', email: 'carol@corp.com', email_verified: false },
      null,
      { id: 'user-carol', email: 'carol@corp.com', status: 'invited' },
    )
    expect(result).toEqual({ action: 'reject', reason: 'not-invited' })
  })

  test('case-insensitive domain match', () => {
    const result = decideProvisioning(
      baseProvider({ provisioning: 'allowlist', allowedEmailDomains: ['@CORP.COM'] }),
      { sub: 's9', email: 'Alice@corp.com', email_verified: true },
      null,
      null,
    )
    expect(result).toEqual({ action: 'create' })
  })
})
