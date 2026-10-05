import { and, eq } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import { ObservationNativeScopeReferenceSchema } from '@agent-workflow/shared'
import type { ObservationNativeScopeReference } from '@agent-workflow/shared'
import { nativeUsagePasses, nativeUsagePassPages, nativeUsageSessionParents } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import type { NativeUsageOwnerBinding } from '../application/ports/nativeUsagePersistence'
import type { TaskExecutionTransaction } from './ownedTaskExecution'

/** Verify the entire original parent chain without materializing a population-sized path. */
export async function verifyNativeUsageScope(
  tx: TaskExecutionTransaction,
  binding: Pick<NativeUsageOwnerBinding, 'invocationId'>,
  value: ObservationNativeScopeReference,
): Promise<string> {
  const reference = ObservationNativeScopeReferenceSchema.parse(value)
  const proof = reference.ancestry
  const pass = (
    await tx
      .select()
      .from(nativeUsagePasses)
      .where(eq(nativeUsagePasses.passId, proof.identity.passId))
      .limit(1)
  )[0]
  const page = (
    await tx
      .select()
      .from(nativeUsagePassPages)
      .where(
        and(
          eq(nativeUsagePassPages.passId, proof.identity.passId),
          eq(nativeUsagePassPages.ordinal, proof.pageOrdinal),
        ),
      )
      .limit(1)
  )[0]
  if (
    !pass ||
    !page ||
    pass.invocationId !== binding.invocationId ||
    proof.identity.invocationId !== binding.invocationId ||
    !isDeepStrictEqual(JSON.parse(pass.identity), proof.identity) ||
    pass.ownerReceiptId !== proof.ownerReceiptId ||
    page.cumulativeDigest !== proof.cumulativeDigest
  )
    throw new Error('Original native scope changed its persisted page')
  let session: string | null = reference.session
  let child: typeof nativeUsageSessionParents.$inferSelect | undefined
  let depth: string | undefined
  while (session !== null) {
    const link: typeof nativeUsageSessionParents.$inferSelect | undefined = (
      await tx
        .select()
        .from(nativeUsageSessionParents)
        .where(
          and(
            eq(nativeUsageSessionParents.passId, pass.passId),
            eq(nativeUsageSessionParents.sessionId, session),
          ),
        )
        .limit(1)
    )[0]
    if (!link || BigInt(link.ordinal) > BigInt(proof.pageOrdinal))
      throw new Error('Original native scope has an unpersisted parent')
    if (!child) {
      if (link.parentSessionId !== reference.parentSession)
        throw new Error('Original native scope changed its direct parent')
      depth = link.depth
    } else if (
      BigInt(child.depth) !== BigInt(link.depth) + 1n ||
      child.pathDigest !== sha256Hex(JSON.stringify([link.pathDigest, child.sessionId]))
    )
      throw new Error('Original native scope parent chain is cyclic or changed')
    if (
      (link.sessionId === reference.root) !== (link.parentSessionId === null) ||
      (link.parentSessionId === null &&
        (link.depth !== '0' ||
          link.pathDigest !== sha256Hex(JSON.stringify([null, link.sessionId]))))
    )
      throw new Error('Original native scope lost its actual root')
    child = link
    session = link.parentSessionId
  }
  if (depth === undefined) throw new Error('Original native scope is absent')
  return depth
}
