// RFC-221 — authentication-method discovery, bootstrap handoff, and the
// persisted username/password login policy.  These schemas are shared by the
// public login page, the admin Authentication settings surface, and backend
// routes so bootstrap can never accidentally expose a mixed method set.

import { z } from 'zod'
import { OidcProviderPublicSchema } from './oidcProvider'
import { UserSchema } from './user'

export const AuthLoginPolicySchema = z.object({
  passwordLoginEnabled: z.boolean(),
  bootstrapCompletedAt: z.number().int().nonnegative().nullable(),
  updatedAt: z.number().int().nonnegative(),
})

export type AuthLoginPolicy = z.infer<typeof AuthLoginPolicySchema>

export const AuthMethodDiscoverySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('bootstrap'),
    providers: z.tuple([]),
    passwordLoginEnabled: z.literal(false),
    daemonTokenEnabled: z.literal(true),
  }),
  z.object({
    mode: z.literal('ready'),
    providers: z.array(OidcProviderPublicSchema),
    passwordLoginEnabled: z.boolean(),
    daemonTokenEnabled: z.literal(false),
  }),
])

export type AuthMethodDiscovery = z.infer<typeof AuthMethodDiscoverySchema>

export const UpdateAuthLoginPolicyBodySchema = z
  .object({
    passwordLoginEnabled: z.boolean(),
  })
  .strict()

export type UpdateAuthLoginPolicyBody = z.infer<typeof UpdateAuthLoginPolicyBodySchema>

export const CreateBootstrapAdminBodySchema = z
  .object({
    username: UserSchema.shape.username,
    displayName: UserSchema.shape.displayName,
    email: z.string().email().max(254).optional(),
    password: z.string().min(8).max(256),
  })
  .strict()

export type CreateBootstrapAdminBody = z.infer<typeof CreateBootstrapAdminBodySchema>
