// RFC-036 — OIDC provider zod schemas. Admins CRUD providers in
// /settings → Authentication; framework runs the standard OIDC Authorization
// Code + PKCE flow against each enabled provider.

import { z } from 'zod'

export const ProvisioningSchema = z.enum(['auto', 'allowlist', 'invite'])
export type ProvisioningPolicy = z.infer<typeof ProvisioningSchema>

export const PROVIDER_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/
export const EMAIL_DOMAIN_REGEX = /^@[a-z0-9.-]+$/i

// RFC-220 — manual endpoint overrides must be http(s): the authorize URL is
// followed via a raw browser redirect (frontend auth.tsx), so a javascript:
// value in admin config would execute on the login page.
const HttpUrlSchema = z.string().url().max(2048).regex(/^https?:\/\//i)

// RFC-220 D5/D6 — claim-name selectors: plain-key whitelist plus a prototype
// pollution blocklist (same defense family as RFC-218 port names).
export const CLAIM_NAME_REGEX = /^[A-Za-z0-9_.-]{1,64}$/
const BANNED_CLAIM_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const ClaimNameSchema = z
  .string()
  .regex(CLAIM_NAME_REGEX)
  .refine((v) => !BANNED_CLAIM_KEYS.has(v), { message: 'reserved claim name' })

// RFC-220 D7 — usernameClaim is a space-separated LIST of claim names (1-8
// tokens; values are joined with single spaces into the presented name).
// max(519) = 8 tokens × 64 chars + 7 separator spaces.
const ClaimNameListSchema = z
  .string()
  .max(519)
  .regex(/^[A-Za-z0-9_.-]{1,64}( [A-Za-z0-9_.-]{1,64}){0,7}$/)
  .refine((v) => v.split(' ').every((t) => !BANNED_CLAIM_KEYS.has(t)), {
    message: 'reserved claim name',
  })

export const OidcProviderSchema = z.object({
  id: z.string(),
  slug: z.string().min(1).max(64).regex(PROVIDER_SLUG_REGEX),
  displayName: z.string().min(1).max(128),
  issuerUrl: z.string().url(),
  clientId: z.string().min(1).max(256),
  scopes: z.string().min(1).max(512),
  provisioning: ProvisioningSchema,
  allowedEmailDomains: z.array(z.string().regex(EMAIL_DOMAIN_REGEX)).default([]),
  iconUrl: z.string().url().nullable(),
  enabled: z.boolean(),
  // RFC-220 — manual endpoint fallbacks (per-field merge with discovery, D1)
  // plus identity-shaping knobs for pure OAuth 2.0 IdPs (D3/D5/D6/D7).
  authorizationEndpoint: HttpUrlSchema.nullable(),
  tokenEndpoint: HttpUrlSchema.nullable(),
  userinfoEndpoint: HttpUrlSchema.nullable(),
  jwksUri: HttpUrlSchema.nullable(),
  trustEmailVerified: z.boolean(),
  usernameClaim: ClaimNameListSchema.nullable(),
  subjectClaim: ClaimNameSchema.nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})

export type OidcProvider = z.infer<typeof OidcProviderSchema>

/** Public response — login page lists enabled providers without leaking config. */
export const OidcProviderPublicSchema = OidcProviderSchema.pick({
  slug: true,
  displayName: true,
  iconUrl: true,
})

export type OidcProviderPublic = z.infer<typeof OidcProviderPublicSchema>

export const CreateOidcProviderBodySchema = OidcProviderSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  clientSecret: z.string().min(1).max(1024),
  // RFC-220 — every new field is optional on the wire so pre-RFC clients
  // (which never send them) keep working; the service defaults null/false.
  authorizationEndpoint: HttpUrlSchema.nullable().optional(),
  tokenEndpoint: HttpUrlSchema.nullable().optional(),
  userinfoEndpoint: HttpUrlSchema.nullable().optional(),
  jwksUri: HttpUrlSchema.nullable().optional(),
  trustEmailVerified: z.boolean().optional(),
  usernameClaim: ClaimNameListSchema.nullable().optional(),
  subjectClaim: ClaimNameSchema.nullable().optional(),
})

export type CreateOidcProviderBody = z.infer<typeof CreateOidcProviderBodySchema>

export const PatchOidcProviderBodySchema = CreateOidcProviderBodySchema.partial()

export type PatchOidcProviderBody = z.infer<typeof PatchOidcProviderBodySchema>
