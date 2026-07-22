// RFC-036 — OIDC provider schema invariants.

import { describe, expect, test } from 'bun:test'
import {
  CreateOidcProviderBodySchema,
  EMAIL_DOMAIN_REGEX,
  OidcProviderSchema,
  OidcProviderPublicSchema,
  PROVIDER_SLUG_REGEX,
  ProvisioningSchema,
} from '../src/schemas/oidcProvider'

describe('PROVIDER_SLUG_REGEX', () => {
  test('accepts lowercase slug forms', () => {
    expect(PROVIDER_SLUG_REGEX.test('github')).toBe(true)
    expect(PROVIDER_SLUG_REGEX.test('github-enterprise')).toBe(true)
    expect(PROVIDER_SLUG_REGEX.test('keycloak-corp-2024')).toBe(true)
  })

  test('rejects bad shapes', () => {
    expect(PROVIDER_SLUG_REGEX.test('GitHub')).toBe(false) // uppercase
    expect(PROVIDER_SLUG_REGEX.test('-github')).toBe(false) // leading dash
    expect(PROVIDER_SLUG_REGEX.test('github.corp')).toBe(false) // dot
    expect(PROVIDER_SLUG_REGEX.test('')).toBe(false)
  })
})

describe('EMAIL_DOMAIN_REGEX', () => {
  test('accepts @-prefixed domains', () => {
    expect(EMAIL_DOMAIN_REGEX.test('@corp.com')).toBe(true)
    expect(EMAIL_DOMAIN_REGEX.test('@a.b.c')).toBe(true)
  })

  test('rejects non-@-prefix or missing tld dot', () => {
    expect(EMAIL_DOMAIN_REGEX.test('corp.com')).toBe(false)
    expect(EMAIL_DOMAIN_REGEX.test('@')).toBe(false)
  })
})

describe('ProvisioningSchema', () => {
  test('accepts the documented 3 enum values', () => {
    for (const v of ['auto', 'allowlist', 'invite']) {
      ProvisioningSchema.parse(v)
    }
  })
  test('rejects unknown', () => {
    expect(() => ProvisioningSchema.parse('open')).toThrow()
  })
})

describe('CreateOidcProviderBodySchema', () => {
  const base = {
    slug: 'github-enterprise',
    displayName: 'GitHub Enterprise',
    issuerUrl: 'https://github.corp.com',
    clientId: 'Iv1.abc',
    clientSecret: 'super-secret',
    scopes: 'openid profile email',
    provisioning: 'allowlist' as const,
    allowedEmailDomains: ['@corp.com'],
    iconUrl: null,
    enabled: true,
  }

  test('happy path', () => {
    expect(() => CreateOidcProviderBodySchema.parse(base)).not.toThrow()
  })

  test('rejects bad issuerUrl', () => {
    expect(() => CreateOidcProviderBodySchema.parse({ ...base, issuerUrl: 'not-a-url' })).toThrow()
  })

  test('rejects allowedEmailDomains entry without leading @', () => {
    expect(() =>
      CreateOidcProviderBodySchema.parse({ ...base, allowedEmailDomains: ['corp.com'] }),
    ).toThrow()
  })

  test('rejects empty clientSecret', () => {
    expect(() => CreateOidcProviderBodySchema.parse({ ...base, clientSecret: '' })).toThrow()
  })
})

describe('OidcProviderPublicSchema', () => {
  test('returns only public fields (no clientId, no clientSecret)', () => {
    const full = OidcProviderSchema.parse({
      id: '01',
      slug: 'github',
      displayName: 'GitHub',
      issuerUrl: 'https://github.com',
      clientId: 'Iv1.abc',
      scopes: 'openid email',
      provisioning: 'invite',
      allowedEmailDomains: [],
      iconUrl: null,
      enabled: true,
      // RFC-220 — server-side config knobs; the public projection below must
      // keep stripping them (endpoints/claim selectors never reach the
      // anonymous login page).
      authorizationEndpoint: 'https://github.com/login/oauth/authorize',
      tokenEndpoint: null,
      userinfoEndpoint: null,
      jwksUri: null,
      trustEmailVerified: false,
      usernameClaim: 'login',
      subjectClaim: 'id',
      createdAt: 0,
      updatedAt: 0,
    })
    const publicView = OidcProviderPublicSchema.parse(full)
    expect(Object.keys(publicView).sort()).toEqual(['displayName', 'iconUrl', 'slug'])
  })
})
