// RFC-370 v3 V6 — Collaboration's hosted object sweep. Gate operations and
// their review documents are removed by the task cascade; once no gate
// operation of a task remains, every review publication of that task is
// released. Archived tasks already linked their own pins of the same objects.
import { inArray } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { collaborationGateOperations } from '@/db/schema'
import type {
  HostedObjectOwnerSweep,
  HostedObjectPublications,
} from '@/modules/system-operations/public/participants'
import { HOSTED_REVIEW_OWNER } from './reviewArtifacts'

export const HOSTED_REVIEW_OBJECT_GRACE_MS = 60 * 60_000

export function createHostedReviewObjectSweep(input: {
  readonly db: ProviderNeutralDatabase
  readonly publications: HostedObjectPublications
  readonly graceMs?: number
  readonly pageSize?: number
}): HostedObjectOwnerSweep {
  const pageSize = input.pageSize ?? 200
  return {
    name: 'collaboration',
    async sweep({ now }) {
      let released = 0
      let after: string | undefined
      for (;;) {
        const scopes = await input.publications.scopes(HOSTED_REVIEW_OWNER, {
          before: now - (input.graceMs ?? HOSTED_REVIEW_OBJECT_GRACE_MS),
          ...(after === undefined ? {} : { after }),
          limit: pageSize,
        })
        if (scopes.length === 0) break
        const live = new Set(
          (
            await input.db
              .selectDistinct({ taskId: collaborationGateOperations.taskId })
              .from(collaborationGateOperations)
              .where(inArray(collaborationGateOperations.taskId, [...scopes]))
          ).map((row) => row.taskId),
        )
        for (const scope of scopes)
          if (!live.has(scope))
            released += await input.publications.release({ owner: HOSTED_REVIEW_OWNER, scope })
        if (scopes.length < pageSize) break
        after = scopes.at(-1)
      }
      return released
    },
  }
}
