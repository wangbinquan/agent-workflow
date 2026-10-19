// RFC-370 §10 V16 — the code-review owner's hosted object sweep. Task deletion
// removes task rows by cascade without visiting each object owner; once a
// task is gone, every `code-review` publication of its scope is released.
import { inArray } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks } from '@/db/schema'
import {
  HOSTED_CODE_REVIEW_OWNER,
  type HostedCodeReviewPublications,
} from './objectCodeReviewArtifacts'

/** Artifacts are written only for tasks that exist; the grace covers clock skew. */
export const HOSTED_CODE_REVIEW_OBJECT_GRACE_MS = 60 * 60_000

export interface HostedCodeReviewObjectSweep {
  readonly name: string
  sweep(input: { readonly now: number }): Promise<number>
}

export function createHostedCodeReviewObjectSweep(input: {
  readonly db: ProviderNeutralDatabase
  readonly publications: Pick<HostedCodeReviewPublications, 'scopes' | 'release'>
  readonly graceMs?: number
  readonly pageSize?: number
}): HostedCodeReviewObjectSweep {
  const pageSize = input.pageSize ?? 200
  return {
    name: 'code-review',
    async sweep({ now }) {
      let released = 0
      let after: string | undefined
      for (;;) {
        const scopes = await input.publications.scopes(HOSTED_CODE_REVIEW_OWNER, {
          before: now - (input.graceMs ?? HOSTED_CODE_REVIEW_OBJECT_GRACE_MS),
          ...(after === undefined ? {} : { after }),
          limit: pageSize,
        })
        if (scopes.length === 0) break
        const live = new Set(
          (
            await input.db
              .select({ id: tasks.id })
              .from(tasks)
              .where(inArray(tasks.id, [...scopes]))
          ).map((row) => row.id),
        )
        for (const scope of scopes)
          if (!live.has(scope))
            released += await input.publications.release({ owner: HOSTED_CODE_REVIEW_OWNER, scope })
        if (scopes.length < pageSize) break
        after = scopes.at(-1)
      }
      return released
    },
  }
}
