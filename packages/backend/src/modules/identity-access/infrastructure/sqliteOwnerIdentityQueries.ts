import { inArray } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { users } from '@/db/schema'
import type {
  OwnerIdentityPersistence,
  OwnerIdentityRow,
} from '../application/ports/ownerIdentityQueries'

export class SqliteOwnerIdentityPersistence implements OwnerIdentityPersistence {
  constructor(private readonly db: DbClient) {}

  async listByIds(ids: readonly string[]): Promise<ReadonlyArray<OwnerIdentityRow>> {
    if (ids.length === 0) return []
    return this.db
      .select({ id: users.id, username: users.username, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, [...ids]))
      .all()
  }
}
