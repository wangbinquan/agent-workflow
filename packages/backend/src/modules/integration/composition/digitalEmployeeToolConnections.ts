import type { DbClient } from '@/db/client'
import { and, eq } from 'drizzle-orm'
import { resourceGrants } from '@/db/schema'
import { isVisibleToAudienceSnapshot } from '@/services/resourceAcl'
import { developmentAdapterContentSchema } from '../domain/developmentAdapterDefinition'
import { createSqliteDevelopmentAdapterStore } from '../infrastructure/sqliteDevelopmentAdapterStore'

/**
 * Bootstrap adapter for the Digital Employee consumer-owned connection catalog
 * port. Only exact identity/purpose/availability crosses the boundary; provider
 * executable, connection details and secret projections stay in Integration.
 */
export function composeDevelopmentToolConnectionCatalog(db: DbClient) {
  const store = createSqliteDevelopmentAdapterStore(db)
  type Subject = {
    readonly userId: string
    readonly authority: { readonly bypass: boolean; readonly private: boolean }
  }
  type Ref = { readonly id: string; readonly revision: number }

  const resolve = (ref: Ref, subject?: Subject | null) => {
    const identity = store.getById(ref.id)
    const revision = store.getRevision(ref.id, ref.revision)
    if (identity === null || revision === null) return null
    const content = developmentAdapterContentSchema.parse(JSON.parse(revision.contentJson))
    const available = identity.archivedAt === null
    const grantedUserIds =
      subject === undefined || subject === null
        ? new Set<string>()
        : new Set(
            db
              .select({ userId: resourceGrants.userId })
              .from(resourceGrants)
              .where(
                and(
                  eq(resourceGrants.resourceType, 'development_adapter'),
                  eq(resourceGrants.resourceId, identity.id),
                ),
              )
              .all()
              .map((row) => row.userId),
          )
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
    selectAutomatic(input: {
      readonly purpose: string
      readonly candidates: readonly Ref[]
      readonly subject?: Subject | null
    }) {
      const preferredKeys = new Set(input.candidates.map((ref) => `${ref.id}\u0000${ref.revision}`))
      const refs = new Map<
        string,
        { readonly ref: Ref; readonly createdAt: number; readonly preferred: boolean }
      >()
      for (const identity of store.list()) {
        if (identity.purpose !== input.purpose || identity.publishedRevision === null) continue
        const publishedRef = { id: identity.id, revision: identity.publishedRevision }
        refs.set(`${publishedRef.id}\u0000${publishedRef.revision}`, {
          ref: publishedRef,
          createdAt: identity.createdAt,
          preferred: preferredKeys.has(`${publishedRef.id}\u0000${publishedRef.revision}`),
        })
      }
      for (const ref of input.candidates) {
        const identity = store.getById(ref.id)
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
        const projection = resolve(candidate.ref, input.subject)
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
