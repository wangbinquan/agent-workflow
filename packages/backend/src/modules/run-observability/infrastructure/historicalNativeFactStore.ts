import { eq } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationNativeFactRoots, observationNativeFactPages } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import {
  advanceOriginalHistoricalNativePage,
  initialHistoricalNativePagePosition,
} from '@/modules/runtime-management/public/participants'
import {
  historicalNativeProofKey,
  parseHistoricalNativeFactRoot,
} from '../domain/historicalNativeFacts'
import type {
  HistoricalNativeFactManifest,
  HistoricalNativeFactSpool,
  HistoricalNativeFactTransferItem,
} from '../ports/historicalNativeFacts'

function* items(
  spool: HistoricalNativeFactSpool,
  manifest: HistoricalNativeFactManifest,
  signal?: AbortSignal,
): Generator<HistoricalNativeFactTransferItem> {
  for (const packet of spool.pages(manifest, signal)) yield* packet.items
}

/** The caller has already released the original snapshot/reservation, including pool max=1. */
export async function importHistoricalNativeFacts(input: {
  readonly db: ProviderNeutralDatabase
  readonly spool: HistoricalNativeFactSpool
  readonly manifest: HistoricalNativeFactManifest
  readonly signal?: AbortSignal
}) {
  // Verify every packet and manifest EOF before the first writer mutation.
  for (const _packet of input.spool.pages(input.manifest, input.signal)) {
    input.signal?.throwIfAborted()
  }
  const iterator = items(input.spool, input.manifest, input.signal)
  let next = iterator.next(),
    imported = 0n
  while (!next.done) {
    input.signal?.throwIfAborted()
    if (next.value.kind !== 'root') throw new Error('Original native fact root header missing')
    const root = parseHistoricalNativeFactRoot(
      next.value.root,
      input.manifest.proof,
      next.value.root.identity,
    )
    await databaseSessionFor(input.db).transaction(async (tx) => {
      await tx
        .delete(observationNativeFactRoots)
        .where(eq(observationNativeFactRoots.cacheKey, root.cacheKey))
        .run()
      await tx
        .insert(observationNativeFactRoots)
        .values({
          cacheKey: root.cacheKey,
          proofKey: historicalNativeProofKey(root.proof),
          rootSessionId: root.identity.rootSessionId,
          state: 'sealed',
          document: JSON.stringify(root),
        })
        .run()
      let position = initialHistoricalNativePagePosition(root.identity)
      // All file reads are synchronous. Only actual database operations yield inside this transaction.
      for (let ordinal = 0n; ordinal < BigInt(root.pages); ordinal++) {
        input.signal?.throwIfAborted()
        const item = iterator.next()
        if (item.done || item.value.kind !== 'page' || item.value.cacheKey !== root.cacheKey)
          throw new Error('Original native fact root page population incomplete')
        const verified = advanceOriginalHistoricalNativePage(
          item.value.page,
          root.identity,
          position,
        )
        position = verified.position
        if (
          position.eof &&
          (position.ordinal !== root.pages ||
            position.digest !== root.finalDigest ||
            !isDeepStrictEqual(verified.page.eof, root.eof) ||
            !isDeepStrictEqual(verified.page.issues, root.issues))
        )
          throw new Error('Original native fact root EOF changed')
        await tx
          .insert(observationNativeFactPages)
          .values({
            cacheKey: root.cacheKey,
            cursor: verified.page.cursor,
            document: JSON.stringify(verified.page),
          })
          .run()
      }
      if (!position.eof || position.ordinal !== root.pages || position.digest !== root.finalDigest)
        throw new Error('Original native fact root not fully sealed')
      // Reading the next boundary also verifies the final transport EOF before the last root commits.
      next = iterator.next()
      if (!next.done && next.value.kind !== 'root')
        throw new Error('Original native fact root has unexpected extra pages')
      input.signal?.throwIfAborted()
    })
    imported++
  }
  if (String(imported) !== input.manifest.roots)
    throw new Error('Original native fact root manifest EOF incomplete')
}
