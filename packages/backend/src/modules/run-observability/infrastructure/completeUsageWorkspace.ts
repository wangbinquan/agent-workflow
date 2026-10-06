import type { UsageContributionEvidence } from '../domain/usageSelection'
import type {
  CompleteWorkingRows,
  CompleteWorkingRow,
  CompleteWorkingPage,
} from '../ports/completeWorkingRows'
import type { CompleteUsageWorkspace } from '../ports/completeUsageWorkspace'
import { completeOrdinalKey } from '../domain/completeOrdinal'
import { completeExternalSort } from '../application/completeExternalSort'
import { compareCompleteUsage } from '../application/completeUsageSelection'
import { completeCoverageWorkspace } from './completeCoverageWorkspace'
import { completeAncestryWorkspace } from './completeAncestryWorkspace'
import { completeUsagePrefetch } from './completeUsagePrefetch'
import { completeCoveragePrefetchTrees } from './completeCoveragePrefetch'
import { groupOf } from '../domain/completeCoverageKeys'
import { sha256Hex } from '@/util/hash'
import { isNativeUsageScope } from '../domain/nativeUsageScope'
import type { ObservationNativeScopeSource } from '../public/participants'

function* legacyAncestry<T extends UsageContributionEvidence>(records: readonly T[]) {
  for (const record of records) {
    const scope = record.measurement.scope
    if (!scope || isNativeUsageScope(scope)) continue
    const group = groupOf(record)
    for (const session of scope.ancestors) yield { group, session }
    yield { group, session: scope.session }
  }
}

async function* retainedInput<T>(input: {
  readonly rows: CompleteWorkingRows
  readonly namespace: string
  readonly sealed: () => boolean
  readonly count: () => bigint
  readonly signal?: AbortSignal
}) {
  if (!input.sealed()) throw new Error('Complete usage input is not sealed')
  let after: string | null = null,
    seen = 0n
  for (;;) {
    input.signal?.throwIfAborted()
    const page: CompleteWorkingPage<T> = await input.rows.page<T>(input.namespace, after, 100)
    for (const row of page.items) {
      if (row.key !== completeOrdinalKey(seen++))
        throw new Error('Complete usage input ordinal missing')
      yield row.document
    }
    if (page.nextCursor === null) {
      if (seen !== input.count()) throw new Error('Complete usage input row count changed')
      return
    }
    if (
      !page.items.length ||
      page.nextCursor !== page.items.at(-1)!.key ||
      page.nextCursor === after
    )
      throw new Error('Complete usage input cursor did not advance')
    after = page.nextCursor
  }
}

/** One immutable input population precedes ancestry, ordering and selection. */
export function completeUsageWorkspace<T extends UsageContributionEvidence>(input: {
  readonly rows: CompleteWorkingRows
  readonly namespace: string
  readonly keyOf: (value: string) => string
  readonly identity: (record: T) => string
  readonly signal?: AbortSignal
  readonly nativeScopes?: ObservationNativeScopeSource
}) {
  const space = (suffix: string) => `${input.namespace}/${suffix}`
  const coverage = completeCoverageWorkspace(
    input.rows,
    space('coverage'),
    input.keyOf,
    input.signal,
  )
  const ancestry = completeAncestryWorkspace(
    input.rows,
    space('ancestry'),
    input.keyOf,
    input.signal,
  )
  const summaryGroups = new Map<string, boolean>()
  const pendingAllocations: CompleteWorkingRow[] = []
  let count = 0n,
    sealed = false
  let sort: ReturnType<typeof completeExternalSort<T>> | undefined
  let validatingAncestry = true
  async function flushAllocations() {
    if (!pendingAllocations.length) return
    await input.rows.insert(space('allocations'), pendingAllocations)
    pendingAllocations.length = 0
  }
  const records = () =>
    retainedInput<T>({
      rows: input.rows,
      namespace: space('input'),
      sealed: () => sealed,
      count: () => count,
      signal: input.signal,
    })
  const workspace: CompleteUsageWorkspace<T> = {
    coverage: coverage.coverage,
    records: () =>
      completeUsagePrefetch(
        records(),
        (batch) => ancestry.prefetch(legacyAncestry(batch)),
        input.signal,
      ),
    async markSummary(group) {
      const key = input.keyOf(group)
      if (summaryGroups.get(key) !== true)
        await input.rows.upsert(space('summary-groups'), [{ key, document: true }])
      summaryGroups.delete(key)
      summaryGroups.set(key, true)
      if (summaryGroups.size > 4096) summaryGroups.delete(summaryGroups.keys().next().value!)
    },
    async hasSummaries(group) {
      const key = input.keyOf(group),
        cached = summaryGroups.get(key)
      if (cached !== undefined) return cached
      const value = (await input.rows.get<boolean>(space('summary-groups'), key)) === true
      summaryGroups.set(key, value)
      if (summaryGroups.size > 4096) summaryGroups.delete(summaryGroups.keys().next().value!)
      return value
    },
    orderedRecords: async function* () {
      validatingAncestry = false
      sort ??= completeExternalSort({
        workspace: input.rows,
        namespace: space('sort'),
        records: records(),
        compare: compareCompleteUsage,
        signal: input.signal,
      })
      yield* completeUsagePrefetch(
        (await sort).records(),
        (batch) => coverage.prefetchRoots(completeCoveragePrefetchTrees(batch, workspace)),
        input.signal,
      )
    },
    async bindAncestry(group, session, ancestors) {
      let digest: string | null = null
      for (const id of [...ancestors, session]) digest = sha256Hex(JSON.stringify([digest, id]))
      await ancestry.bind(
        group,
        session,
        JSON.stringify({
          depth: String(ancestors.length),
          pathDigest: digest,
          parentSession: ancestors.at(-1) ?? null,
        }),
      )
    },
    async bindNativeAncestry(group, link) {
      await ancestry.bind(
        group,
        link.session,
        JSON.stringify({
          depth: link.depth,
          pathDigest: link.pathDigest,
          parentSession: link.parentSession,
        }),
      )
    },
    nativePath: async function* (record) {
      const scope = record.measurement.scope
      if (!isNativeUsageScope(scope) || !record.nativeScopeFacts || !input.nativeScopes)
        throw new Error('Original native ancestry source is not installed')
      const path = input.nativeScopes.path(record.nativeScopeFacts, scope)
      if (!validatingAncestry) {
        yield* path
        return
      }
      const group = groupOf(record)
      yield* completeUsagePrefetch(
        path,
        (batch) => ancestry.prefetch(batch.map((link) => ({ group, session: link.session }))),
        input.signal,
        500,
      )
    },
    async allocate(record, contribution, quality) {
      pendingAllocations.push({
        key: input.keyOf(input.identity(record)),
        document: { record, contribution, quality },
      })
      if (pendingAllocations.length === 500) await flushAllocations()
    },
  }
  return {
    workspace,
    async append(items: readonly T[]) {
      if (sealed) throw new Error('Complete usage input is already sealed')
      for (let offset = 0; offset < items.length; offset += 500) {
        input.signal?.throwIfAborted()
        const batch = items.slice(offset, offset + 500)
        await input.rows.insert(
          space('identities'),
          batch.map((record) => ({ key: input.keyOf(input.identity(record)), document: true })),
        )
        await input.rows.insert(
          space('input'),
          batch.map((document, i) => ({ key: completeOrdinalKey(count + BigInt(i)), document })),
        )
        count += BigInt(batch.length)
      }
    },
    seal(expectedRows: string) {
      if (sealed || !/^(0|[1-9]\d*)$/.test(expectedRows) || BigInt(expectedRows) !== count)
        throw new Error('Complete usage input EOF count does not match')
      sealed = true
    },
    async flush() {
      input.signal?.throwIfAborted()
      await ancestry.flush()
      await flushAllocations()
      await coverage.flush()
    },
    allocationsNamespace: space('allocations'),
  }
}
