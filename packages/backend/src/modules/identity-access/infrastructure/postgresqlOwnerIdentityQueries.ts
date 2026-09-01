import { inArray } from 'drizzle-orm'

import { users } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  OwnerIdentityPersistence,
  OwnerIdentityRow,
} from '../application/ports/ownerIdentityQueries'

export class PostgresqlOwnerIdentityPersistence implements OwnerIdentityPersistence {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async listByIds(ids: readonly string[]): Promise<ReadonlyArray<OwnerIdentityRow>> {
    if (ids.length === 0) return []
    return await this.db
      .select({ id: users.id, username: users.username, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, [...ids]))
      .all()
  }
}
