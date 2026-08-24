// RFC-321 — repository publication transport wire contracts.
//
// These schemas deliberately separate the one write-only token request from
// every read/publication receipt. A plaintext token has no place in a summary,
// endpoint candidate, publication receipt, or stable error response.

import { z } from 'zod'
import { CodeHostProviderSchema } from './webhook'

/** Explicit ownership context for managed Git publication. Code-host REST
 * calls remain on the administrator-managed platform connection; the only
 * personal-token API call is the account owner's explicit identity probe. */
export type RepositoryCredentialSubject =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'system' }

export const RepositoryConnectionGenerationSchema = z.string().trim().min(1).max(128)
export const RepositoryEndpointBindingDigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'expected a lowercase SHA-256 digest')

export const RepositoryTransportMappingV1Schema = z
  .object({
    sshHost: z.string().trim().min(1).max(255),
    sshPort: z.number().int().min(1).max(65535).optional(),
    sshPathPrefix: z.string().trim().min(1).max(2048).optional(),
    httpBaseUrl: z.string().trim().min(1).max(2048),
  })
  .strict()
export type RepositoryTransportMappingV1 = z.infer<typeof RepositoryTransportMappingV1Schema>

export const RepositoryEndpointSources = [
  'input-http',
  'provider-api',
  'admin-mapping',
  'saas-convention',
  'local-fixture',
  'legacy-remote',
] as const
export const RepositoryEndpointSourceSchema = z.enum(RepositoryEndpointSources)
export type RepositoryEndpointSource = z.infer<typeof RepositoryEndpointSourceSchema>

export const RepositoryEndpointCandidateSchema = z
  .object({
    provider: CodeHostProviderSchema,
    project: z.string().trim().min(1).max(2048),
    connectionGeneration: RepositoryConnectionGenerationSchema,
    url: z.string().trim().min(1).max(4096),
    source: z.literal('provider-api'),
  })
  .strict()
export type RepositoryEndpointCandidate = z.infer<typeof RepositoryEndpointCandidateSchema>

export const OwnCodeHostPushCredentialFallbackSchema = z.enum([
  'platform-global',
  'legacy-transport-unmanaged',
])

export const OwnCodeHostPushCredentialSummarySchema = z
  .object({
    provider: CodeHostProviderSchema,
    displayBaseUrl: z.string().max(2048),
    connectionGeneration: RepositoryConnectionGenerationSchema,
    endpointBindingDigest: RepositoryEndpointBindingDigestSchema,
    configured: z.boolean(),
    tokenHint: z.string().max(4).nullable(),
    updatedAt: z.number().int().nonnegative().nullable(),
    stale: z.boolean(),
    fallback: OwnCodeHostPushCredentialFallbackSchema,
  })
  .strict()
export type OwnCodeHostPushCredentialSummary = z.infer<
  typeof OwnCodeHostPushCredentialSummarySchema
>

export const OwnCodeHostPushCredentialListSchema = z
  .object({ items: z.array(OwnCodeHostPushCredentialSummarySchema).max(2) })
  .strict()
export type OwnCodeHostPushCredentialList = z.infer<typeof OwnCodeHostPushCredentialListSchema>

/** Write-only request. Never reuse this schema for a response or audit payload. */
export const PutOwnCodeHostPushCredentialRequestSchema = z
  .object({
    token: z.string().min(8).max(4096),
    connectionGeneration: RepositoryConnectionGenerationSchema,
    endpointBindingDigest: RepositoryEndpointBindingDigestSchema,
  })
  .strict()
export type PutOwnCodeHostPushCredentialRequest = z.infer<
  typeof PutOwnCodeHostPushCredentialRequestSchema
>

/** One-shot identity probe. The token is optional so an already stored personal
 * credential can be tested without ever reading it back into the browser. */
export const TestOwnCodeHostPushCredentialRequestSchema = z
  .object({
    token: z.string().min(8).max(4096).optional(),
    connectionGeneration: RepositoryConnectionGenerationSchema,
    endpointBindingDigest: RepositoryEndpointBindingDigestSchema,
  })
  .strict()
export type TestOwnCodeHostPushCredentialRequest = z.infer<
  typeof TestOwnCodeHostPushCredentialRequestSchema
>

export const CodeHostConnectionMutationConfirmationSchema = z
  .object({
    expectedConnectionGeneration: RepositoryConnectionGenerationSchema.optional(),
    confirmCredentialRevocationDigest: RepositoryEndpointBindingDigestSchema.optional(),
  })
  .strict()
export type CodeHostConnectionMutationConfirmation = z.infer<
  typeof CodeHostConnectionMutationConfirmationSchema
>

export const RepositoryCredentialSources = ['personal', 'global', 'legacy'] as const
export const RepositoryCredentialSourceSchema = z.enum(RepositoryCredentialSources)
export type RepositoryCredentialSource = z.infer<typeof RepositoryCredentialSourceSchema>

export const RepositoryPublicationReceiptSchema = z
  .object({
    credentialSource: RepositoryCredentialSourceSchema,
    credentialRevision: z.number().int().positive().nullable(),
    endpointSource: RepositoryEndpointSourceSchema,
    endpointBindingDigest: RepositoryEndpointBindingDigestSchema.nullable(),
  })
  .strict()
export type RepositoryPublicationReceipt = z.infer<typeof RepositoryPublicationReceiptSchema>

export const REPOSITORY_TRANSPORT_ERROR_CODES = [
  'code-host-push-credential-invalid',
  'code-host-push-credential-connection-missing',
  'code-host-push-credential-stale',
  'code-host-push-credential-unavailable',
  'code-host-transport-rebind-confirmation-required',
  'repository-http-endpoint-unresolved',
  'repository-http-endpoint-untrusted',
  'repository-push-authentication-failed',
  'repository-push-authorization-failed',
  'repository-push-remote-changed',
] as const
export const RepositoryTransportErrorCodeSchema = z.enum(REPOSITORY_TRANSPORT_ERROR_CODES)
export type RepositoryTransportErrorCode = z.infer<typeof RepositoryTransportErrorCodeSchema>

export const RepositoryTransportErrorSchema = z
  .object({
    code: RepositoryTransportErrorCodeSchema,
  })
  .strict()
export type RepositoryTransportError = z.infer<typeof RepositoryTransportErrorSchema>
