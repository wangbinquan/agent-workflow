import { createHash } from 'node:crypto'
import { and, asc, eq, gt, or } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationCalculationRows, observationCalculationVersions } from '@/db/schema'
import {
  completeWorkingPages,
  completeWorkingTraversal,
} from '../application/completeWorkingTraversal'
import {
  calculationSourceKey,
  CompleteCalculationInvalid,
} from '../domain/completeCalculationFacts'
import {
  HISTORICAL_PREPARATION_ALGORITHM,
  HISTORICAL_PREPARATION_GROUPS,
  historicalPreparationKey,
  historicalPreparationContentDigest,
  parseHistoricalPreparationGroup,
  parseHistoricalPreparationVersion,
} from '../domain/historicalObservationPreparation'
import type { CompleteCalculationContext } from '../ports/completeCalculationFacts'
import type {
  HistoricalObservationPreparationCache,
  HistoricalObservationPreparationExecution,
  HistoricalObservationPreparationGroup,
  HistoricalObservationPreparationItem,
  HistoricalObservationPreparationVersion,
  HistoricalPreparationWorkingRows,
} from '../ports/historicalObservationPreparation'
import { updateCalculationRowDigest } from './completeCalculationFactReader'

/** Whole raw history is sealed once per source proof, independently of the requested period. */
export function historicalObservationPreparationCollector(input: {
  readonly db: ProviderNeutralDatabase
  readonly rows: HistoricalPreparationWorkingRows
  readonly namespace: string
  readonly snapshotId: string
  readonly context: CompleteCalculationContext
  readonly signal?: AbortSignal
}) {
  const sourceKey = calculationSourceKey(input.context),
    cacheKey = historicalPreparationKey(sourceKey),
    historical = input.namespace + '/historical',
    retained = input.namespace + '/historical-preparation-export',
    staging = input.namespace + '/historical-preparation-read',
    metadata = (prefix: string) => prefix + HISTORICAL_PREPARATION_GROUPS
  let sealed: HistoricalObservationPreparationVersion | null = null,
    usedCache = false,
    cachedRows = '0'
  const stage = (sourceRows: string) => ({
    namespace: historical,
    executionsNamespace: historical + '/executions',
    nativeRecordsNamespace: historical + '/native-records',
    receiptsNamespace: historical + '/receipts',
    sourceRows,
    candidateIndex: true as const,
  })
  const cleanup = async (prefix: string) => {
    if (input.rows.clearNamespacePrefix) return input.rows.clearNamespacePrefix(prefix)
    for await (const group of completeWorkingTraversal(input.rows, metadata(prefix), input.signal))
      await input.rows.clear(prefix + group.key)
    await input.rows.clear(metadata(prefix))
  }
  const cache: HistoricalObservationPreparationCache = {
    async read() {
      const stored = await input.db
        .select()
        .from(observationCalculationVersions)
        .where(eq(observationCalculationVersions.cacheKey, cacheKey))
        .get()
      if (!stored) return null
      let version: HistoricalObservationPreparationVersion
      try {
        if (stored.sourceKey !== sourceKey)
          throw new CompleteCalculationInvalid('Historical preparation source changed')
        version = parseHistoricalPreparationVersion(
          JSON.parse(stored.document),
          sourceKey,
          cacheKey,
        )
      } catch (error) {
        if (error instanceof CompleteCalculationInvalid || error instanceof SyntaxError) return null
        throw error
      }
      let after: { namespace: string; key: string } | null = null,
        rows = 0n,
        groups = 0n,
        declaredRows = 0n,
        groupName: string | null = null,
        expectedGroup: HistoricalObservationPreparationGroup | null = null,
        groupRows = 0n,
        groupHash = createHash('sha256')
      const groupsHash = createHash('sha256')
      const finishGroup = () => {
        if (groupName === null) return
        if (
          !expectedGroup ||
          String(groupRows) !== expectedGroup.rows ||
          groupHash.digest('hex') !== expectedGroup.digest
        )
          throw new CompleteCalculationInvalid('Historical preparation complete group changed')
      }
      try {
        for (;;) {
          input.signal?.throwIfAborted()
          const page = await input.db
            .select()
            .from(observationCalculationRows)
            .where(
              and(
                eq(observationCalculationRows.cacheKey, cacheKey),
                ...(after
                  ? [
                      or(
                        gt(observationCalculationRows.namespace, after.namespace),
                        and(
                          eq(observationCalculationRows.namespace, after.namespace),
                          gt(observationCalculationRows.key, after.key),
                        ),
                      )!,
                    ]
                  : []),
              ),
            )
            .orderBy(asc(observationCalculationRows.namespace), asc(observationCalculationRows.key))
            .limit(250)
            .all()
          if (page.length === 0) break
          const batches = new Map<string, { key: string; document: unknown }[]>()
          for (const row of page) {
            if (
              !row.key ||
              !row.namespace.startsWith('/') ||
              (after &&
                (row.namespace < after.namespace ||
                  (row.namespace === after.namespace && row.key <= after.key)))
            )
              throw new CompleteCalculationInvalid('Historical preparation row order changed')
            let document: unknown
            try {
              document = JSON.parse(row.document)
            } catch {
              throw new CompleteCalculationInvalid('Historical preparation row cannot be decoded')
            }
            if (row.namespace === HISTORICAL_PREPARATION_GROUPS) {
              const declaration = parseHistoricalPreparationGroup(row.key, document)
              declaredRows += BigInt(declaration.rows)
              groups++
              updateCalculationRowDigest(groupsHash, row.key, document)
            } else {
              if (groupName !== row.namespace) {
                // Group declarations must be present before any data namespace.
                for (const [name, batch] of batches) await input.rows.insert(staging + name, batch)
                batches.clear()
                finishGroup()
                groupName = row.namespace
                groupRows = 0n
                groupHash = createHash('sha256')
                expectedGroup = parseHistoricalPreparationGroup(
                  groupName,
                  await input.rows.get(metadata(staging), groupName),
                )
              }
              updateCalculationRowDigest(groupHash, row.key, document)
              groupRows++
            }
            const batch = batches.get(row.namespace) ?? []
            batch.push({ key: row.key, document })
            batches.set(row.namespace, batch)
            rows++
            after = { namespace: row.namespace, key: row.key }
          }
          for (const [name, batch] of batches) await input.rows.insert(staging + name, batch)
        }
        finishGroup()
        if (
          String(rows) !== version.rows ||
          String(groups) !== version.groups ||
          declaredRows !== rows - groups ||
          groupsHash.digest('hex') !== version.groupDigest
        )
          throw new CompleteCalculationInvalid('Historical preparation EOF incomplete')
        for (const name of [
          '/executions',
          '/roots',
          '/native-records',
          '/receipts',
          '/root-results',
        ])
          parseHistoricalPreparationGroup(name, await input.rows.get(metadata(staging), name))
        if (input.rows.copyNamespacePrefix)
          await input.rows.copyNamespacePrefix(staging, historical, [HISTORICAL_PREPARATION_GROUPS])
        else
          for await (const group of completeWorkingTraversal(
            input.rows,
            metadata(staging),
            input.signal,
          ))
            for await (const page of completeWorkingPages(
              input.rows,
              staging + group.key,
              input.signal,
            ))
              await input.rows.insert(historical + group.key, page)
        await input.rows.put(historical + '/receipts', {
          key: 'derived-preparation/' + cacheKey,
          document: {
            source: 'derived-historical-preparation-confirmation/' + cacheKey,
            snapshotId: input.snapshotId,
            rows: version.rows,
            groups: version.groups,
            digest: version.contentDigest,
            sourceKey,
            eof: true,
          },
        })
        usedCache = true
        cachedRows = version.rows
        return stage(version.sourceRows)
      } catch (error) {
        if (!(error instanceof CompleteCalculationInvalid)) throw error
        return null
      } finally {
        await cleanup(staging)
      }
    },
    async retain(original) {
      if (original.namespace !== historical || !original.candidateIndex)
        throw new CompleteCalculationInvalid('Historical preparation source namespace changed')
      for await (const root of completeWorkingTraversal<{
        eof: unknown
        issues: readonly string[]
      }>(input.rows, historical + '/root-results', input.signal))
        if (root.document.issues.includes('historical-native-generation-changed')) return
      const names = historical + '/preparation-groups'
      for (const name of ['/executions', '/roots', '/native-records', '/receipts', '/root-results'])
        await input.rows.put(names, { key: name, document: true })
      let groups = 0n,
        rows = 0n
      const groupHash = createHash('sha256')
      for await (const group of completeWorkingTraversal(input.rows, names, input.signal)) {
        const name = group.key
        if (
          name === '/parent-task-qualification' ||
          name === '/retained-root-edges' ||
          name.endsWith('/cursors') ||
          name === '/preparation-groups'
        )
          continue
        let population = 0n
        const hash = createHash('sha256')
        for await (const page of completeWorkingPages(
          input.rows,
          historical + name,
          input.signal,
        )) {
          const originalRows = page.map((row) => {
            if (name !== '/executions') return row
            const execution = row.document as HistoricalObservationPreparationExecution
            return {
              key: row.key,
              document: { execution: execution.execution, parentTask: execution.parentTask },
            }
          })
          for (const row of originalRows) {
            updateCalculationRowDigest(hash, row.key, row.document)
            population++
          }
          await input.rows.insert(retained + name, originalRows)
        }
        const declaration: HistoricalObservationPreparationGroup = {
          rows: String(population),
          digest: hash.digest('hex'),
        }
        await input.rows.insert(metadata(retained), [{ key: name, document: declaration }])
        updateCalculationRowDigest(groupHash, name, declaration)
        groups++
        rows += population + 1n
      }
      const body = {
        algorithm: HISTORICAL_PREPARATION_ALGORITHM,
        sourceKey,
        cacheKey,
        sourceRows: original.sourceRows,
        groups: String(groups),
        rows: String(rows),
        groupDigest: groupHash.digest('hex'),
      }
      sealed = { ...body, contentDigest: historicalPreparationContentDigest(body) }
    },
  }
  return {
    cache,
    get usedCache() {
      return usedCache
    },
    get statistics() {
      return { cachedRows, prepared: sealed !== null }
    },
    async *items(): AsyncGenerator<HistoricalObservationPreparationItem> {
      if (!sealed) return
      yield { kind: 'version', version: sealed }
      for await (const group of completeWorkingTraversal(
        input.rows,
        metadata(retained),
        input.signal,
      ))
        yield { kind: 'row', cacheKey, namespace: HISTORICAL_PREPARATION_GROUPS, ...group }
      for await (const group of completeWorkingTraversal(
        input.rows,
        metadata(retained),
        input.signal,
      ))
        for await (const row of completeWorkingTraversal(
          input.rows,
          retained + group.key,
          input.signal,
        ))
          yield { kind: 'row', cacheKey, namespace: group.key, ...row }
    },
  }
}
