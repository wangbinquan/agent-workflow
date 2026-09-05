// RFC-359 W4-B4 —— owner 身份查询：一份实现，两个 provider 共用。

import { inArray } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { users } from '@/db/schema'
import type {
  OwnerIdentityPersistence,
  OwnerIdentityRow,
} from '../application/ports/ownerIdentityQueries'

export class DrizzleOwnerIdentityPersistence implements OwnerIdentityPersistence {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async listByIds(ids: readonly string[]): Promise<ReadonlyArray<OwnerIdentityRow>> {
    if (ids.length === 0) return []
    return await this.db
      .select({ id: users.id, username: users.username, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, [...ids]))
  }
}
