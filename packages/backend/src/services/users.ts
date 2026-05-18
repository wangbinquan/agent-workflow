// RFC-036 — users service. PR1 scope: just enough surface for the CLI + the
// bootstrap log + future-PR retro-fit (PR2 layers in last-admin-protection /
// soft-delete logic).

import { and, eq, like, ne, or } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  type CreateUserBody,
  type PatchUserBody,
  type Role,
  type UserPublic,
} from '@agent-workflow/shared'
import { SYSTEM_USER_ID } from '@/auth/actor'
import { hashPassword } from '@/auth/passwords'
import { revokeAllSessionsForUser } from '@/auth/sessionStore'
import type { DbClient } from '@/db/client'
import { users } from '@/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'

export type UserRow = typeof users.$inferSelect

export async function countNonSystemUsers(db: DbClient): Promise<number> {
  const rows = await db.select().from(users).where(ne(users.id, SYSTEM_USER_ID))
  return rows.length
}

export async function findById(db: DbClient, id: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1)
  return rows[0] ?? null
}

export async function findByUsername(db: DbClient, username: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.username, username)).limit(1)
  return rows[0] ?? null
}

export interface CreateUserInput extends CreateUserBody {
  createdBy?: string | null
  now?: number
  /**
   * RFC-036 override. Without it: password present → active, password
   * absent → invited (admin-creates-an-invited-user flow). OIDC auto-
   * provisioning passes `status='active'` because the IdP already
   * verified the identity; password stays null forever.
   */
  status?: 'active' | 'disabled' | 'invited'
}

export async function createUser(db: DbClient, input: CreateUserInput): Promise<UserRow> {
  if (input.username === SYSTEM_USER_ID) {
    throw new ConflictError('username-reserved', `username '${SYSTEM_USER_ID}' is reserved`)
  }
  const existing = await findByUsername(db, input.username)
  if (existing) {
    throw new ConflictError('username-taken', `username '${input.username}' already exists`)
  }
  const now = input.now ?? Date.now()
  const passwordHash = input.password ? await hashPassword(input.password) : null
  const status = input.status ?? (passwordHash ? 'active' : 'invited')
  const id = ulid()
  await db.insert(users).values({
    id,
    username: input.username,
    email: input.email ?? null,
    displayName: input.displayName,
    passwordHash,
    role: input.role,
    status,
    forcePasswordChange: 0,
    createdBy: input.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    schemaVersion: 1,
  })
  return (await findById(db, id))!
}

export interface ResetPasswordInput {
  newPassword: string
  force?: boolean
  revokePats?: boolean
  now?: number
}

export async function resetPassword(
  db: DbClient,
  id: string,
  input: ResetPasswordInput,
): Promise<void> {
  if (id === SYSTEM_USER_ID) {
    throw new ValidationError('system-user-immutable', 'cannot reset password for __system__')
  }
  const row = await findById(db, id)
  if (!row) throw new NotFoundError('user-not-found', `user ${id} not found`)
  const passwordHash = await hashPassword(input.newPassword)
  const now = input.now ?? Date.now()
  await db
    .update(users)
    .set({
      passwordHash,
      forcePasswordChange: input.force ? 1 : 0,
      status: 'active',
      updatedAt: now,
    })
    .where(eq(users.id, id))
  await revokeAllSessionsForUser(db, id, now)
  // PR2 handles revokePats; left as TODO so the API contract is stable.
}

export async function disableUser(
  db: DbClient,
  id: string,
  now: number = Date.now(),
): Promise<void> {
  if (id === SYSTEM_USER_ID) {
    throw new ValidationError('system-user-immutable', 'cannot disable __system__')
  }
  const row = await findById(db, id)
  if (!row) throw new NotFoundError('user-not-found', `user ${id} not found`)
  if (row.status === 'disabled') return
  if (row.role === 'admin') {
    const otherAdmins = await db
      .select()
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.status, 'active'), ne(users.id, id)))
    if (otherAdmins.length === 0) {
      throw new ValidationError(
        'last-admin-protection',
        'cannot disable the last active admin user',
      )
    }
  }
  await db.update(users).set({ status: 'disabled', updatedAt: now }).where(eq(users.id, id))
  await revokeAllSessionsForUser(db, id, now)
}

export async function patchUser(
  db: DbClient,
  id: string,
  patch: PatchUserBody,
  now: number = Date.now(),
): Promise<UserRow> {
  if (id === SYSTEM_USER_ID) {
    throw new ValidationError('system-user-immutable', 'cannot modify __system__ user')
  }
  const row = await findById(db, id)
  if (!row) throw new NotFoundError('user-not-found', `user ${id} not found`)

  // Last-admin protection for role changes / status flips.
  if (patch.role && patch.role !== 'admin' && row.role === 'admin') {
    const others = await db
      .select()
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.status, 'active'), ne(users.id, id)))
    if (others.length === 0) {
      throw new ValidationError('last-admin-protection', 'cannot demote the last active admin user')
    }
  }

  const updates: Partial<typeof users.$inferInsert> = {
    updatedAt: now,
  }
  if (patch.displayName !== undefined) updates.displayName = patch.displayName
  if (patch.email !== undefined) updates.email = patch.email
  if (patch.role !== undefined) updates.role = patch.role
  if (patch.status !== undefined) updates.status = patch.status
  if (patch.forcePasswordChange !== undefined) {
    updates.forcePasswordChange = patch.forcePasswordChange ? 1 : 0
  }
  await db.update(users).set(updates).where(eq(users.id, id))
  return (await findById(db, id))!
}

export interface SearchInput {
  q?: string
  limit?: number
  excludeIds?: string[]
}

export async function searchUsersPublic(db: DbClient, input: SearchInput): Promise<UserPublic[]> {
  const q = (input.q ?? '').trim().toLowerCase()
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
  const rows = q
    ? await db
        .select()
        .from(users)
        .where(
          and(
            ne(users.id, SYSTEM_USER_ID),
            // Prefix match on both username and display_name per design §5.4.
            or(like(users.username, `${q}%`), like(users.displayName, `${q}%`)),
          ),
        )
    : await db.select().from(users).where(ne(users.id, SYSTEM_USER_ID))
  const excluded = new Set(input.excludeIds ?? [])
  return rows
    .filter((r) => !excluded.has(r.id))
    .filter((r) => r.status !== 'disabled' || excluded.size === 0)
    .slice(0, limit)
    .map(
      (r): UserPublic => ({
        id: r.id,
        username: r.username,
        displayName: r.displayName,
        role: r.role as Role,
        status: r.status as 'active' | 'disabled' | 'invited',
      }),
    )
}

export async function listAllUsers(db: DbClient): Promise<UserRow[]> {
  return db.select().from(users)
}
