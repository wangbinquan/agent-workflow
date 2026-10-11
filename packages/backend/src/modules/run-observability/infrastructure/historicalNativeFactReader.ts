import { and, eq } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationNativeFactRoots, observationNativeFactPages } from '@/db/schema'
import type { ReportWorkingPage, ReportWorkspace } from '@/platform/persistence/reportWorkspace'
import {
  advanceOriginalHistoricalNativePage,
  initialHistoricalNativePagePosition,
  originalHistoricalNativeIdentity,
  type HistoricalNativePagePosition,
  type HistoricalNativeSourceProof,
} from '@/modules/runtime-management/public/participants'
import type { HistoricalNativeObservationPage } from '@agent-workflow/shared'
import type { HistoricalObservationSources } from '../ports/historicalObservationSources'
import type {
  HistoricalNativeFactReader,
  HistoricalNativeFactRoot,
  HistoricalNativeFactTransferItem,
} from '../ports/historicalNativeFacts'
import {
  HistoricalNativeFactInvalidation,
  historicalNativeFactRootKey,
  historicalNativeProofKey,
  parseHistoricalNativeFactRoot,
} from '../domain/historicalNativeFacts'

/** All durable reads use this original application snapshot; cold pages stage only in TEMP. */
export function historicalNativeFactCollector(input: {
  readonly db: ProviderNeutralDatabase
  readonly native: HistoricalObservationSources['native']
  readonly rows: ReportWorkspace
  readonly namespace: string
  readonly proof: HistoricalNativeSourceProof
  readonly signal?: AbortSignal
}) {
  const roots = input.namespace + '/native-fact-roots'
  const pageNamespace = (key: string) => input.namespace + '/native-fact-pages/' + key
  let usedCache = false,
    cachedRoots = 0n,
    cachedPages = 0n,
    sourceRoots = 0n,
    sourcePages = 0n
  const advance = (
    value: unknown,
    original: HistoricalNativeFactReader['identity'],
    position: HistoricalNativePagePosition,
    cached: boolean,
  ) => {
    try {
      return advanceOriginalHistoricalNativePage(value, original, position)
    } catch (error) {
      if (!cached) throw error
      throw new HistoricalNativeFactInvalidation(
        error instanceof Error ? error.message : 'Original native cached page invalid',
      )
    }
  }
  return {
    get usedCache() {
      return usedCache
    },
    get statistics() {
      return {
        cachedRoots: String(cachedRoots),
        cachedPages: String(cachedPages),
        sourceRoots: String(sourceRoots),
        sourcePages: String(sourcePages),
      }
    },
    async open(selection: { readonly referenceId: string; readonly rootSessionId: string }) {
      input.signal?.throwIfAborted()
      const cacheKey = historicalNativeFactRootKey(input.proof, selection),
        retained = await input.db
          .select()
          .from(observationNativeFactRoots)
          .where(eq(observationNativeFactRoots.cacheKey, cacheKey))
          .get()
      let root: HistoricalNativeFactRoot | undefined
      if (retained) {
        try {
          if (
            retained.state !== 'sealed' ||
            retained.rootSessionId !== selection.rootSessionId ||
            retained.proofKey !== historicalNativeProofKey(input.proof)
          )
            throw new Error('Original native cache is not sealed')
          root = parseHistoricalNativeFactRoot(
            JSON.parse(retained.document),
            input.proof,
            selection,
          )
        } catch (error) {
          if (error instanceof HistoricalNativeFactInvalidation) throw error
          throw new HistoricalNativeFactInvalidation('Original native cache header cannot be read')
        }
      }
      if (!root) sourceRoots++
      const original = root ? null : await input.native.open(selection)
      if (!root && !original) return null
      const identity = root?.identity ?? original!.identity,
        initialCursor = root?.initialCursor ?? original!.initialCursor,
        rootCreatedAt = root ? root.rootCreatedAt : original!.rootCreatedAt,
        cacheEligible = isDeepStrictEqual(
          identity,
          originalHistoricalNativeIdentity(
            input.proof,
            selection.referenceId,
            selection.rootSessionId,
          ),
        )
      let position = initialHistoricalNativePagePosition(identity),
        pending: ReturnType<typeof advance> | undefined,
        last: HistoricalNativeObservationPage | undefined,
        closed = false,
        failed = false
      if (root) {
        usedCache = true
        cachedRoots++
      }
      const reader: HistoricalNativeFactReader = {
        identity,
        initialCursor,
        rootCreatedAt,
        async next(cursor) {
          input.signal?.throwIfAborted()
          if (closed) throw new Error('Original native fact reader closed')
          if (pending) {
            if (pending.page.cursor !== cursor)
              throw new HistoricalNativeFactInvalidation('Original native page awaits its ACK')
            return structuredClone(pending.page)
          }
          try {
            let page: unknown
            if (root) {
              const stored = await input.db
                .select({ document: observationNativeFactPages.document })
                .from(observationNativeFactPages)
                .where(
                  and(
                    eq(observationNativeFactPages.cacheKey, cacheKey),
                    eq(observationNativeFactPages.cursor, cursor),
                  ),
                )
                .get()
              if (!stored)
                throw new HistoricalNativeFactInvalidation('Original native cached page missing')
              try {
                page = JSON.parse(stored.document)
              } catch {
                throw new HistoricalNativeFactInvalidation(
                  'Original native cached page cannot be decoded',
                )
              }
            } else page = original!.next(cursor)
            pending = advance(page, identity, position, root !== undefined)
            if (root) cachedPages++
            else sourcePages++
            if (pending.page.cursor !== cursor)
              throw new HistoricalNativeFactInvalidation('Original native cached cursor changed')
            if (
              root &&
              (BigInt(pending.position.ordinal) > BigInt(root.pages) ||
                (pending.position.ordinal === root.pages && pending.page.eof === null) ||
                (pending.page.eof !== null &&
                  (pending.position.ordinal !== root.pages ||
                    pending.position.digest !== root.finalDigest ||
                    !isDeepStrictEqual(pending.page.eof, root.eof) ||
                    !isDeepStrictEqual(pending.page.issues, root.issues))))
            )
              throw new HistoricalNativeFactInvalidation('Original native cached final EOF changed')
            if (!root && cacheEligible)
              await input.rows.put(pageNamespace(cacheKey), {
                key: pending.page.cursor,
                document: pending.page,
              })
            return structuredClone(pending.page)
          } catch (error) {
            failed = true
            throw error
          }
        },
        async acknowledge(ordinal, payloadDigest) {
          if (
            closed ||
            !pending ||
            pending.page.ordinal !== ordinal ||
            pending.page.payloadDigest !== payloadDigest
          )
            throw new Error('Original native fact ACK changed')
          try {
            original?.acknowledge(ordinal, payloadDigest)
            position = pending.position
            last = pending.page
            pending = undefined
          } catch (error) {
            failed = true
            throw error
          }
        },
        async close() {
          if (closed) return
          closed = true
          original?.close()
          if (!root && cacheEligible && !failed && position.eof && last?.eof) {
            const header: HistoricalNativeFactRoot = {
              cacheKey,
              proof: input.proof,
              identity,
              initialCursor,
              rootCreatedAt,
              pages: position.ordinal,
              finalDigest: position.digest,
              eof: last.eof,
              issues: last.issues,
            }
            await input.rows.put(roots, { key: cacheKey, document: header })
          }
        },
      }
      return reader
    },
    async *items(): AsyncIterable<HistoricalNativeFactTransferItem> {
      let after: string | null = null
      while (true) {
        input.signal?.throwIfAborted()
        const page: ReportWorkingPage<HistoricalNativeFactRoot> =
          await input.rows.page<HistoricalNativeFactRoot>(roots, after)
        for (const entry of page.items) {
          const root = parseHistoricalNativeFactRoot(
            entry.document,
            input.proof,
            entry.document.identity,
          )
          yield { kind: 'root', root }
          let cursor: string | null = root.initialCursor
          while (cursor !== null) {
            input.signal?.throwIfAborted()
            const original: HistoricalNativeObservationPage | undefined = await input.rows.get(
              pageNamespace(root.cacheKey),
              cursor,
            )
            if (!original) throw new Error('Original staged native numeric page missing')
            yield { kind: 'page', cacheKey: root.cacheKey, page: original }
            cursor = original.nextCursor
          }
        }
        if (page.nextCursor === null) break
        if (page.nextCursor === after)
          throw new Error('Original native fact root cursor did not advance')
        after = page.nextCursor
      }
    },
  }
}
