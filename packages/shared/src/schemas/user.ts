// RFC-036 — user/session/PAT/identity zod schemas. Backend zod-validates DB
// reads/writes through these; frontend uses them via TanStack Query as the
// response contract.

import { z } from 'zod'
import { PermissionSchema, RoleSchema } from './permission'

export const USERNAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/

export const UserSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1).max(64).regex(USERNAME_REGEX),
  email: z.string().email().max(254).nullable(),
  displayName: z.string().min(1).max(128),
  role: RoleSchema,
  status: z.enum(['active', 'disabled', 'invited']),
  forcePasswordChange: z.boolean(),
  createdBy: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  lastLoginAt: z.number().int().nonnegative().nullable(),
})

export type User = z.infer<typeof UserSchema>

/** Admin-facing user row. OIDC ownership is materialized server-side so the
 *  UI can omit inapplicable password actions without an N+1 identity query. */
export const AdminUserViewSchema = UserSchema.extend({
  hasOidcIdentity: z.boolean(),
})

export type AdminUserView = z.infer<typeof AdminUserViewSchema>

/** Subset returned by /api/users/search — public 5 fields, never includes email / lastLoginAt. */
export const UserPublicSchema = UserSchema.pick({
  id: true,
  username: true,
  displayName: true,
  role: true,
  status: true,
})

export type UserPublic = z.infer<typeof UserPublicSchema>

export const CreateUserBodySchema = z.object({
  username: UserSchema.shape.username,
  email: UserSchema.shape.email.optional(),
  displayName: UserSchema.shape.displayName,
  role: UserSchema.shape.role,
  password: z.string().min(8).max(256).optional(),
  sendInvite: z.boolean().optional(),
})

export type CreateUserBody = z.infer<typeof CreateUserBodySchema>

export const PatchUserBodySchema = z
  .object({
    displayName: UserSchema.shape.displayName.optional(),
    email: UserSchema.shape.email.optional(),
    role: UserSchema.shape.role.optional(),
    status: UserSchema.shape.status.optional(),
    forcePasswordChange: z.boolean().optional(),
  })
  .strict()

export type PatchUserBody = z.infer<typeof PatchUserBodySchema>

// flag-audit §8 决策（用户 2026-07-07）：曾经的 `revokePats` 选项被删除——它在
// schema 公开、service 收而不办（安全假旋钮）。未来要做「重置密码连带吊销 PAT」
// 请连实现一起落，不再允许契约先行。
export const ResetPasswordBodySchema = z.object({
  newPassword: z.string().min(8).max(256),
  force: z.boolean().optional(),
})

export type ResetPasswordBody = z.infer<typeof ResetPasswordBodySchema>

// ----------------------------------------------------------------------------
// Sessions / PATs
// ----------------------------------------------------------------------------

export const SESSION_TOKEN_PREFIX = 'aws_s_'
export const PAT_TOKEN_PREFIX = 'aws_pat_'

export const SessionPublicSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userAgent: z.string().nullable(),
  createdAt: z.number(),
  lastUsedAt: z.number(),
  expiresAt: z.number(),
  revokedAt: z.number().nullable(),
})

export type SessionPublic = z.infer<typeof SessionPublicSchema>

export const PatPublicSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(128),
  scopes: z.array(PermissionSchema),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
  expiresAt: z.number().nullable(),
  revokedAt: z.number().nullable(),
})

export type PatPublic = z.infer<typeof PatPublicSchema>

export const CreatePatBodySchema = z.object({
  name: z.string().min(1).max(128),
  scopes: z.array(PermissionSchema).default([]),
  expiresAt: z.number().int().nonnegative().optional(),
})

export type CreatePatBody = z.infer<typeof CreatePatBodySchema>

// ----------------------------------------------------------------------------
// Login flow
// ----------------------------------------------------------------------------

export const LoginBodySchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
})

export type LoginBody = z.infer<typeof LoginBodySchema>

export const ChangePasswordBodySchema = z.object({
  /** Required unless caller's user row has forcePasswordChange=true. */
  oldPassword: z.string().min(1).max(256).optional(),
  newPassword: z.string().min(8).max(256),
})

export type ChangePasswordBody = z.infer<typeof ChangePasswordBodySchema>

// ----------------------------------------------------------------------------
// Linked identities (user → OIDC subject)
// ----------------------------------------------------------------------------

export const UserIdentitySchema = z.object({
  id: z.string(),
  userId: z.string(),
  providerId: z.string(),
  providerSlug: z.string().optional(), // attached by service-layer join
  providerDisplayName: z.string().optional(),
  subject: z.string(),
  email: z.string().nullable(),
  emailVerified: z.boolean(),
  linkedAt: z.number(),
})

export type UserIdentity = z.infer<typeof UserIdentitySchema>
