// RFC-232 — minimum owner identity projection for task list rows.
//
// The scheduled-task list has no pagination, so the SQL bind count must stay
// bounded independently of row count. The caller still receives one complete
// map: backend chunks are an implementation detail, never a truncated result.

import { OwnerIdentitySchema, type OwnerIdentity } from '@agent-workflow/shared'
import { inArray } from 'drizzle-orm'

import { SYSTEM_USER_ID } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { users } from '@/db/schema'

export const OWNER_IDENTITY_SQL_BATCH_SIZE = 200

export async function loadOwnerIdentities(
  db: DbClient,
  ownerUserIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, OwnerIdentity>> {
  const wanted = [
    ...new Set(
      ownerUserIds.filter(
        (id): id is string => id !== null && id !== undefined && id !== SYSTEM_USER_ID,
      ),
    ),
  ]
  const byId = new Map<string, OwnerIdentity>()

  for (let offset = 0; offset < wanted.length; offset += OWNER_IDENTITY_SQL_BATCH_SIZE) {
    const batch = wanted.slice(offset, offset + OWNER_IDENTITY_SQL_BATCH_SIZE)
    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
      })
      .from(users)
      .where(inArray(users.id, batch))

    for (const row of rows) {
      const parsed = OwnerIdentitySchema.safeParse(row)
      // A malformed historic identity degrades to the stable owner id instead
      // of taking down an otherwise healthy task list.
      if (parsed.success) byId.set(parsed.data.id, parsed.data)
    }
  }

  return byId
}
