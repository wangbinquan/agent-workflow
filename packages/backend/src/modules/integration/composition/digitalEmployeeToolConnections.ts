import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { isVisibleToAudienceSnapshot } from '@/services/resourceAcl'
import { developmentAdapterContentSchema } from '../domain/developmentAdapterDefinition'
import {
  createPostgresqlDevelopmentToolConnectionStore,
  createSqliteDevelopmentToolConnectionStore,
  type DevelopmentToolConnectionStore,
} from '../infrastructure/developmentToolConnectionStore'

/**
 * Bootstrap adapter for the Digital Employee consumer-owned connection catalog
 * port. Only exact identity/purpose/availability crosses the boundary; provider
 * executable, connection details and secret projections stay in Integration.
 */
function catalog(store: DevelopmentToolConnectionStore) {
  type Subject = {
    readonly userId: string
    readonly authority: { readonly bypass: boolean; readonly private: boolean }
  }
  type Ref = { readonly id: string; readonly revision: number }

  const resolve = async (ref: Ref, subject?: Subject | null) => {
    const [identity, revision] = await Promise.all([
      store.identity(ref.id),
      store.revision(ref.id, ref.revision),
    ])
    if (identity === null || revision === null) return null
    const content = developmentAdapterContentSchema.parse(JSON.parse(revision.contentJson))
    const available = identity.archivedAt === null
    const grantedUserIds =
      subject === undefined || subject === null
        ? new Set<string>()
        : await store.grantedUserIds(identity.id)
    const visible =
      subject === undefined || subject === null
        ? true
        : isVisibleToAudienceSnapshot(subject.userId, subject.authority, {
            visibility: identity.visibility,
            ownerUserId: identity.ownerUserId,
            grantedUserIds,
          })
    return {
      ref,
      purpose: content.purpose,
      available,
      visible,
      contentDigest: revision.contentDigest,
      closureSummary: `${identity.name}; ${content.purpose}; exact revision ${ref.revision}; ${available ? 'available' : 'archived'}; ${visible ? 'visible' : 'not visible'}`,
    }
  }

  return {
    resolve,
    async selectAutomatic(input: {
      readonly purpose: string
      readonly candidates: readonly Ref[]
      readonly subject?: Subject | null
    }) {
      const preferredKeys = new Set(input.candidates.map((ref) => `${ref.id}\u0000${ref.revision}`))
      const refs = new Map<
        string,
        { readonly ref: Ref; readonly createdAt: number; readonly preferred: boolean }
      >()
      for (const identity of await store.identities()) {
        if (identity.purpose !== input.purpose || identity.publishedRevision === null) continue
        const publishedRef = { id: identity.id, revision: identity.publishedRevision }
        refs.set(`${publishedRef.id}\u0000${publishedRef.revision}`, {
          ref: publishedRef,
          createdAt: identity.createdAt,
          preferred: preferredKeys.has(`${publishedRef.id}\u0000${publishedRef.revision}`),
        })
      }
      for (const ref of input.candidates) {
        const identity = await store.identity(ref.id)
        if (identity === null || identity.purpose !== input.purpose) continue
        refs.set(`${ref.id}\u0000${ref.revision}`, {
          ref,
          createdAt: identity.createdAt,
          preferred: true,
        })
      }
      const ordered = [...refs.values()].sort(
        (left, right) =>
          Number(right.preferred) - Number(left.preferred) ||
          left.createdAt - right.createdAt ||
          left.ref.id.localeCompare(right.ref.id) ||
          left.ref.revision - right.ref.revision,
      )
      for (const candidate of ordered) {
        const projection = await resolve(candidate.ref, input.subject)
        if (
          projection !== null &&
          projection.purpose === input.purpose &&
          projection.available &&
          projection.visible
        ) {
          return projection
        }
      }
      return null
    },
  }
}

export function composeSqliteDevelopmentToolConnectionCatalog(db: DbClient) {
  return catalog(createSqliteDevelopmentToolConnectionStore(db))
}

export function composePostgresqlDevelopmentToolConnectionCatalog(db: PostgresqlDatabaseClient) {
  return catalog(createPostgresqlDevelopmentToolConnectionStore(db))
}
