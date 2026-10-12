import { createHash } from 'node:crypto'
import { and, asc, eq, gt, or } from 'drizzle-orm'
import type { AcceptedObservationInvocation } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationCalculationRows, observationCalculationVersions } from '@/db/schema'
import {
  completeWorkingPages,
  completeWorkingTraversal,
} from '../application/completeWorkingTraversal'
import {
  calculationNamespaceFields,
  calculationSourceKey,
  CompleteCalculationInvalid,
  COMPLETE_TASK_CALCULATION_ALGORITHM,
  parseTaskCalculationVersion,
  relativeTaskCalculation,
  restoreTaskCalculation,
  taskCalculationContentDigest,
  taskCalculationKey,
} from '../domain/completeCalculationFacts'
import type {
  CompleteCalculationContext,
  CompleteCalculationFactItem,
  CompleteTaskCalculationVersion,
} from '../ports/completeCalculationFacts'
import type { CompleteWorkingRows } from '../ports/completeWorkingRows'
import type { CompleteObservationTaskNumericCache } from '../ports/completeObservationTask'

export const updateCalculationRowDigest = (
  hash: ReturnType<typeof createHash>,
  key: string,
  document: unknown,
) => hash.update(JSON.stringify([key, document]) + '\n')

/** Snapshot-qualified numeric rows live outside the transient Task scope; clocks never do. */
export function completeTaskCalculationCollector(input: {
  readonly db: ProviderNeutralDatabase
  readonly rows: CompleteWorkingRows
  readonly namespace: string
  readonly snapshotId: string
  readonly context: CompleteCalculationContext
  readonly signal?: AbortSignal
}) {
  const sourceKey = calculationSourceKey(input.context)
  const headers = input.namespace + '/calculation-headers'
  const retained = (key: string, name: string) =>
    input.namespace + '/calculation-rows/' + key + name
  let cachedTasks = 0n,
    calculatedTasks = 0n,
    cachedRows = 0n
  const cache: CompleteObservationTaskNumericCache = {
    async read(task) {
      if (task.trace) return null
      input.signal?.throwIfAborted()
      const cacheKey = taskCalculationKey(sourceKey, task)
      const stored = await input.db
        .select()
        .from(observationCalculationVersions)
        .where(eq(observationCalculationVersions.cacheKey, cacheKey))
        .get()
      if (!stored) return null
      let version: CompleteTaskCalculationVersion
      try {
        if (stored.sourceKey !== sourceKey)
          throw new CompleteCalculationInvalid('Task calculation source changed')
        let value: unknown
        try {
          value = JSON.parse(stored.document)
        } catch {
          throw new CompleteCalculationInvalid('Task calculation header cannot be decoded')
        }
        version = parseTaskCalculationVersion(value, sourceKey, cacheKey)
      } catch (error) {
        if (error instanceof CompleteCalculationInvalid) return null
        throw error
      }
      const staging = (name: string) => input.namespace + '/calculation-read/' + cacheKey + name
      const cleanup = async () => {
        for (const group of version.groups) await input.rows.clear(staging(group.namespace))
      }
      let population = 0n,
        readPages = 0n
      const counters = new Map(
        version.groups.map((group) => [group.namespace, { rows: 0n, hash: createHash('sha256') }]),
      )
      let after: { namespace: string; key: string } | null = null
      let invalid = false
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
          readPages++
          if (page.length === 0) break
          const staged = new Map<string, { key: string; document: unknown }[]>()
          for (const row of page) {
            if (
              !row.key ||
              (after &&
                (row.namespace < after.namespace ||
                  (row.namespace === after.namespace && row.key <= after.key)))
            )
              throw new CompleteCalculationInvalid('Task calculation row order changed')
            const counter = counters.get(row.namespace)
            if (!counter) throw new CompleteCalculationInvalid('Task calculation extra namespace')
            let document: unknown
            try {
              document = JSON.parse(row.document)
            } catch {
              throw new CompleteCalculationInvalid('Task calculation row cannot be decoded')
            }
            updateCalculationRowDigest(counter.hash, row.key, document)
            counter.rows++
            population++
            const batch = staged.get(row.namespace) ?? []
            batch.push({ key: row.key, document })
            staged.set(row.namespace, batch)
            after = { namespace: row.namespace, key: row.key }
          }
          for (const [name, rows] of staged) await input.rows.insert(staging(name), rows)
        }
        if (
          String(population) !== version.rows ||
          version.groups.some((group) => {
            const counter = counters.get(group.namespace)!
            return (
              String(counter.rows) !== group.rows || counter.hash.digest('hex') !== group.digest
            )
          })
        )
          throw new CompleteCalculationInvalid('Task calculation row EOF changed')
      } catch (error) {
        if (!(error instanceof CompleteCalculationInvalid)) {
          try {
            await cleanup()
          } catch {
            /* Preserve the original read/cancellation failure. */
          }
          throw error
        }
        invalid = true
      }
      if (invalid) {
        await cleanup()
        return null
      }
      try {
        // Validate all rows before touching Task-local numeric namespaces.
        for (const group of version.groups)
          for await (const page of completeWorkingPages(
            input.rows,
            staging(group.namespace),
            input.signal,
          ))
            await task.rows.insert(task.namespace + group.namespace, page)
        cachedTasks++
        cachedRows += population
        return {
          ...restoreTaskCalculation(task, structuredClone(version.numeric)),
          sourceReceipts: [
            ...version.numeric.sourceReceipts,
            {
              source: 'derived-task-calculation-confirmation/' + cacheKey + '/' + sourceKey,
              snapshotId: input.snapshotId,
              rows: String(population),
              pages: String(readPages),
              eof: true,
            },
          ],
        }
      } finally {
        await cleanup()
      }
    },
    async retain(task, numeric) {
      if (task.trace) return
      // External authority lacks a closed public meter/visibility version here; preserve original reads.
      for await (const row of completeWorkingTraversal<AcceptedObservationInvocation>(
        task.rows,
        numeric.invocationsNamespace,
        input.signal,
      ))
        if (row.document.authority.kind !== 'local') return
      const states = await task.rows.page(task.namespace + '/platform-states', null, 1)
      if (states.items.length !== 0 || states.nextCursor !== null) return
      const cacheKey = taskCalculationKey(sourceKey, task)
      const names = new Set<string>(['/platform-states'])
      for (const field of calculationNamespaceFields) {
        const name = numeric[field]
        if (name !== undefined) names.add(name.slice(task.namespace.length))
      }
      const groups: CompleteTaskCalculationVersion['groups'][number][] = []
      let population = 0n
      for (const name of [...names].sort()) {
        const hash = createHash('sha256')
        let count = 0n
        for await (const page of completeWorkingPages(
          task.rows,
          task.namespace + name,
          input.signal,
        )) {
          for (const row of page) {
            updateCalculationRowDigest(hash, row.key, row.document)
            count++
          }
          await input.rows.insert(retained(cacheKey, name), page)
        }
        population += count
        groups.push({ namespace: name, rows: String(count), digest: hash.digest('hex') })
      }
      const body = {
        algorithm: COMPLETE_TASK_CALCULATION_ALGORITHM,
        cacheKey,
        sourceKey,
        numeric: relativeTaskCalculation(task, numeric),
        groups,
        rows: String(population),
      }
      const version: CompleteTaskCalculationVersion = {
        ...body,
        contentDigest: taskCalculationContentDigest(body),
      }
      await input.rows.insert(headers, [{ key: cacheKey, document: version }])
      calculatedTasks++
    },
  }
  return {
    cache,
    get usedCache() {
      return cachedTasks !== 0n
    },
    get statistics() {
      return {
        cachedTasks: String(cachedTasks),
        calculatedTasks: String(calculatedTasks),
        cachedRows: String(cachedRows),
      }
    },
    async *items(): AsyncGenerator<CompleteCalculationFactItem> {
      for await (const row of completeWorkingTraversal<CompleteTaskCalculationVersion>(
        input.rows,
        headers,
        input.signal,
      )) {
        const version = row.document
        yield { kind: 'version', version }
        for (const group of version.groups)
          for await (const item of completeWorkingTraversal(
            input.rows,
            retained(version.cacheKey, group.namespace),
            input.signal,
          ))
            yield { kind: 'row', cacheKey: version.cacheKey, namespace: group.namespace, ...item }
      }
    },
  }
}
