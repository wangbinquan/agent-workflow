// RFC-036 — users service. PR1 scope: just enough surface for the CLI + the
// bootstrap log + future-PR retro-fit (PR2 layers in last-admin-protection /
// soft-delete logic).

import { inArray, and, eq, like, ne, or } from 'drizzle-orm'
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
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { isOidcManagedUser, writeLocalPasswordIfUnmanaged } from '@/services/accountAuthPolicy'
import { triggerRevalidation } from '@/ws/revalidationHook'

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
    forcePasswordChange: false,
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
  if (await isOidcManagedUser(db, id)) {
    throw new ForbiddenError(
      'oidc-password-managed',
      'password is managed by the linked identity provider',
    )
  }
  const passwordHash = await hashPassword(input.newPassword)
  const now = input.now ?? Date.now()
  writeLocalPasswordIfUnmanaged(db, {
    userId: id,
    passwordHash,
    forcePasswordChange: input.force ?? false,
    activate: true,
    updatedAt: now,
  })
  await revokeAllSessionsForUser(db, id, now)
}

/**
 * Count active admins OTHER than `excludeId`, EXCLUDING the `__system__`
 * sentinel. `__system__` is permanently role=admin/status=active but is not a
 * real login account, so it must never satisfy last-admin-protection — counting
 * it once let an operator disable the only *human* admin and lock everyone out
 * (2026-06-24 incident: the admin row had to be re-activated directly in
 * sqlite). Single source of truth for every last-admin check below.
 */
async function countOtherActiveAdmins(db: DbClient, excludeId: string): Promise<number> {
  const rows = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.role, 'admin'),
        eq(users.status, 'active'),
        ne(users.id, excludeId),
        ne(users.id, SYSTEM_USER_ID),
      ),
    )
  return rows.length
}

export async function disableUser(
  db: DbClient,
  id: string,
  now: number = Date.now(),
  actorId?: string,
): Promise<void> {
  if (id === SYSTEM_USER_ID) {
    throw new ValidationError('system-user-immutable', 'cannot disable __system__')
  }
  // Self-disable lockout: disabling your own account revokes your sessions and
  // strips the permission needed to undo it. Mirror self-role-change-forbidden
  // and force the action through another admin (or the CLI break-glass path,
  // which passes no actorId). A disabled actor can't reach this code, so this
  // never collides with the idempotent already-disabled return below.
  if (actorId === id) {
    throw new ValidationError('self-disable-forbidden', 'cannot disable your own account')
  }
  const row = await findById(db, id)
  if (!row) throw new NotFoundError('user-not-found', `user ${id} not found`)
  if (row.status === 'disabled') return
  if (row.role === 'admin' && (await countOtherActiveAdmins(db, id)) === 0) {
    throw new ValidationError('last-admin-protection', 'cannot disable the last active admin user')
  }
  await db.update(users).set({ status: 'disabled', updatedAt: now }).where(eq(users.id, id))
  await revokeAllSessionsForUser(db, id, now)
  // RFC-212 — revokeAllSessionsForUser already fires a trigger, but disable also
  // narrows anything a still-live PAT could see; make the intent explicit.
  triggerRevalidation(db, 'user-disabled')
}

/**
 * Re-activate a disabled (or invited) account — the inverse of disableUser.
 * The web UI re-enables via PATCH {status:'active'} (patchUser); this focused
 * setter backs the CLI `enable` break-glass subcommand and any programmatic
 * caller. No last-admin / self guards: re-enabling can only ADD an active
 * admin, and a disabled user can't be logged in to re-enable themselves.
 */
export async function enableUser(
  db: DbClient,
  id: string,
  now: number = Date.now(),
): Promise<void> {
  if (id === SYSTEM_USER_ID) {
    throw new ValidationError('system-user-immutable', 'cannot modify __system__')
  }
  const row = await findById(db, id)
  if (!row) throw new NotFoundError('user-not-found', `user ${id} not found`)
  if (row.status === 'active') return
  await db.update(users).set({ status: 'active', updatedAt: now }).where(eq(users.id, id))
}

export async function patchUser(
  db: DbClient,
  id: string,
  patch: PatchUserBody,
  now: number = Date.now(),
  actorId?: string,
): Promise<UserRow> {
  if (id === SYSTEM_USER_ID) {
    throw new ValidationError('system-user-immutable', 'cannot modify __system__ user')
  }
  const row = await findById(db, id)
  if (!row) throw new NotFoundError('user-not-found', `user ${id} not found`)

  // Self-role lockout guard: an admin demoting themselves loses the very
  // permission needed to undo it, so role changes must come from another
  // admin. Same-value writes pass so full-object PATCHes stay idempotent.
  if (actorId === id && patch.role !== undefined && patch.role !== row.role) {
    throw new ValidationError('self-role-change-forbidden', 'cannot change your own role')
  }

  // Self-disable lockout — same rationale as disableUser: refuse flipping your
  // OWN status to disabled. Same-value writes pass so full-object PATCHes stay
  // idempotent.
  if (actorId === id && patch.status === 'disabled' && row.status !== 'disabled') {
    throw new ValidationError('self-disable-forbidden', 'cannot disable your own account')
  }

  // Last-admin protection — demoting the last real admin out of the admin role…
  if (patch.role && patch.role !== 'admin' && row.role === 'admin') {
    if ((await countOtherActiveAdmins(db, id)) === 0) {
      throw new ValidationError('last-admin-protection', 'cannot demote the last active admin user')
    }
  }
  // …and disabling the last real admin via a status flip. This comment block
  // historically claimed to cover "status flips" but only role was checked —
  // a PATCH {status:'disabled'} on the last admin slipped straight through.
  if (patch.status === 'disabled' && row.status !== 'disabled' && row.role === 'admin') {
    if ((await countOtherActiveAdmins(db, id)) === 0) {
      throw new ValidationError(
        'last-admin-protection',
        'cannot disable the last active admin user',
      )
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
    updates.forcePasswordChange = patch.forcePasswordChange
  }
  await db.update(users).set(updates).where(eq(users.id, id))
  // RFC-212 — patchUser writes BOTH role and status (users.ts is the Web UI's
  // demote AND disable path). Trigger unconditionally so neither branch can be
  // forgotten — a per-branch trigger is exactly the omission the audit warned of.
  triggerRevalidation(db, 'user-patched')
  return (await findById(db, id))!
}

export interface SearchInput {
  q?: string
  limit?: number
  excludeIds?: string[]
}

/**
 * RFC-099 — resolve a batch of user ids to their PUBLIC projection (id /
 * username / displayName / role / status). Unknown ids and the __system__
 * sentinel drop out silently. Disabled users ARE returned — historic
 * attribution chips must keep rendering after an account is disabled.
 */
export async function lookupUsersPublic(db: DbClient, ids: string[]): Promise<UserPublic[]> {
  const wanted = [...new Set(ids)].filter((id) => id !== SYSTEM_USER_ID)
  if (wanted.length === 0) return []
  const rows = await db.select().from(users).where(inArray(users.id, wanted))
  return rows.map(
    (r): UserPublic => ({
      id: r.id,
      username: r.username,
      displayName: r.displayName,
      role: r.role as Role,
      status: r.status as UserPublic['status'],
    }),
  )
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
