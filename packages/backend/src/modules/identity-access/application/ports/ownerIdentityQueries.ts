import { OwnerIdentitySchema, type OwnerIdentity } from '@agent-workflow/shared'

export const OWNER_IDENTITY_SQL_BATCH_SIZE = 200

export interface OwnerIdentityRow {
  readonly id: string
  readonly username: string
  readonly displayName: string
}

/** Provider-owned lookup mechanism. The application layer owns batching and decoding. */
export interface OwnerIdentityPersistence {
  listByIds(ids: readonly string[]): Promise<ReadonlyArray<OwnerIdentityRow>>
}

export interface OwnerIdentityQueries {
  loadOwnerIdentities(
    ownerUserIds: ReadonlyArray<string | null | undefined>,
  ): Promise<ReadonlyMap<string, OwnerIdentity>>
}

export function createOwnerIdentityQueries(input: {
  readonly persistence: OwnerIdentityPersistence
  readonly systemUserId: string
}): OwnerIdentityQueries {
  const queries: OwnerIdentityQueries = {
    async loadOwnerIdentities(ownerUserIds) {
      const wanted = [
        ...new Set(
          ownerUserIds.filter(
            (id): id is string => id !== null && id !== undefined && id !== input.systemUserId,
          ),
        ),
      ]
      const byId = new Map<string, OwnerIdentity>()

      for (let offset = 0; offset < wanted.length; offset += OWNER_IDENTITY_SQL_BATCH_SIZE) {
        const rows = await input.persistence.listByIds(
          wanted.slice(offset, offset + OWNER_IDENTITY_SQL_BATCH_SIZE),
        )
        for (const row of rows) {
          const parsed = OwnerIdentitySchema.safeParse(row)
          // Historic malformed rows degrade to their stable owner id instead
          // of taking down an otherwise healthy task list.
          if (parsed.success) byId.set(parsed.data.id, parsed.data)
        }
      }

      return byId
    },
  }
  return Object.freeze(queries)
}
