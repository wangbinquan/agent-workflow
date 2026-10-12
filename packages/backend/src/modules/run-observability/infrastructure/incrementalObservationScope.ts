import { and, asc, gt, inArray } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationInvocations, observationUsageCaptures } from '@/db/schema'
import { jsonPathText } from '@/platform/persistence/jsonPathText'
import { AcceptedObservationInvocationSchema } from '@agent-workflow/shared'

/** Resolve only accepted calls connected to original execution/root identities.
 * Each identity packet and each keyset is exhausted; there is no Task-wide
 * numeric read and no fixed maximum number of calls in a connected component. */
export async function projectionAcceptedScope(
  db: ProviderNeutralDatabase,
  input: {
    readonly invocationIds: readonly string[]
    readonly attemptIds: readonly string[]
    readonly roots: readonly string[]
  },
) {
  const result = new Map<string, import('@agent-workflow/shared').AcceptedObservationInvocation>()
  const identities: { kind: 'invocation' | 'attempt' | 'root'; ids: readonly string[] }[] = [
    { kind: 'invocation', ids: input.invocationIds },
    { kind: 'attempt', ids: input.attemptIds },
    { kind: 'root', ids: input.roots },
  ]
  for (const { kind, ids } of identities)
    for (let at = 0; at < ids.length; at += 200) {
      const packet = ids.slice(at, at + 200)
      let after: string | undefined
      for (;;) {
        const condition =
          kind === 'invocation'
            ? inArray(observationInvocations.id, [...packet])
            : kind === 'attempt'
              ? inArray(jsonPathText(db, observationInvocations.document, ['nodeRunId']), [
                  ...packet,
                ])
              : inArray(
                  observationInvocations.id,
                  db
                    .select({ id: observationUsageCaptures.invocationId })
                    .from(observationUsageCaptures)
                    .where(
                      inArray(
                        jsonPathText(db, observationUsageCaptures.document, [
                          'evidence',
                          'capture',
                          'rootSessionId',
                        ]),
                        [...packet],
                      ),
                    ),
                )
        const page = await db
          .select({ id: observationInvocations.id, document: observationInvocations.document })
          .from(observationInvocations)
          .where(
            and(condition, after === undefined ? undefined : gt(observationInvocations.id, after)),
          )
          .orderBy(asc(observationInvocations.id))
          .limit(200)
          .all()
        if (!page.length) break
        for (const row of page)
          result.set(row.id, AcceptedObservationInvocationSchema.parse(JSON.parse(row.document)))
        after = page.at(-1)!.id
      }
    }
  return [...result.values()]
}
export async function projectionCaptureRoots(
  db: ProviderNeutralDatabase,
  invocationIds: readonly string[],
) {
  const roots = new Set<string>()
  for (let at = 0; at < invocationIds.length; at += 200)
    for (const row of await db
      .select({
        root: jsonPathText(db, observationUsageCaptures.document, [
          'evidence',
          'capture',
          'rootSessionId',
        ]),
      })
      .from(observationUsageCaptures)
      .where(inArray(observationUsageCaptures.invocationId, invocationIds.slice(at, at + 200)))
      .all())
      if (typeof row.root === 'string') roots.add(row.root)
  return [...roots]
}
