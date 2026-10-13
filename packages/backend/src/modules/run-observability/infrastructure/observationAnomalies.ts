import { and, asc, eq, gt } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationAnomalyStates, observationAnomalyHistory } from '@/db/observationAnalysis'
import {
  observationProjectionCurrent,
  observationProjectionHeads,
} from '@/db/observationProjection'
import {
  ObservationAnomalySchema,
  type ObservationAnomaly,
  type ObservationAnomalyPage,
  type ObservationStorage,
  type CompleteObservationTask,
  type ObservationSpanDetail,
} from '@agent-workflow/shared'
import { sha256Hex } from '@/util/hash'
import { randomUUID } from 'node:crypto'
import type { IncrementalObservationFold } from '../domain/incrementalObservationFold'
import {
  advanceObservationAnomaly,
  type ObservationAnomalySample,
} from '../domain/observationAnomaly'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'
import type { QualifiedObservationContribution } from '../ports/incrementalObservationQualified'
async function sample(
  db: ProviderNeutralDatabase,
  input: Omit<ObservationAnomalySample, 'key'> & { keyScope?: string },
) {
  const key = sha256Hex(JSON.stringify([input.taskId, input.rule, input.keyScope ?? null])),
    old = await db
      .select()
      .from(observationAnomalyStates)
      .where(eq(observationAnomalyStates.key, key))
      .get(),
    previous = old ? ObservationAnomalySchema.parse(JSON.parse(old.document)) : undefined
  if (old?.sourceRevision === input.sourceRevision && previous?.lastObservedAt === input.observedAt)
    return
  const next = advanceObservationAnomaly(
    previous,
    { ...input, observedAt: Math.max(input.observedAt, previous?.lastObservedAt ?? 0), key },
    randomUUID,
  )
  if (!next || JSON.stringify(next) === JSON.stringify(previous)) return
  await db
    .insert(observationAnomalyStates)
    .values({
      key,
      taskId: input.taskId,
      document: JSON.stringify(next),
      sourceRevision: input.sourceRevision,
    })
    .onConflictDoUpdate({
      target: observationAnomalyStates.key,
      set: { document: JSON.stringify(next), sourceRevision: input.sourceRevision },
    })
    .run()
  if (!previous || previous.state !== next.state || previous.sourceState !== next.sourceState)
    await db
      .insert(observationAnomalyHistory)
      .values({
        id: randomUUID(),
        key,
        taskId: input.taskId,
        observedAt: input.observedAt,
        document: JSON.stringify(next),
      })
      .run()
}
/** One Task is one actual lifecycle observation. This is not a synthetic model-call count. */
export async function observeProjectionTaskAnomalies(
  db: ProviderNeutralDatabase,
  key: string,
  fold: IncrementalObservationFold,
  version: { revision: string; asOf: number },
  taskName: string | null = null,
) {
  if (!key.startsWith('task/')) return
  const taskId = key.slice(5),
    rules: [ObservationAnomaly['rule'], boolean][] = [
      [
        'usage-missing',
        fold.unknownCoverage !== '0' ||
          Object.keys(fold.gaps).some((g) =>
            /usage.*(missing|incomplete)|native.*(unobserved|incomplete)|coverage-incomplete/.test(
              g,
            ),
          ),
      ],
      ['unpriced', fold.hidden === '0' && fold.unpriced !== '0'],
      ['clock-skew', Object.keys(fold.gaps).some((g) => /clock/.test(g))],
      [
        'source-unavailable',
        Object.keys(fold.gaps).some((g) =>
          /source.*unavailable|native.*unavailable|source-projection-pending/.test(g),
        ),
      ],
    ]
  for (const [rule, condition] of rules)
    await sample(db, {
      taskId,
      taskName,
      rule,
      condition,
      sourceState: 'available',
      samples: fold.counters.tasks,
      minimumSamples: '1',
      windowMs: 60000,
      durationMs: rule === 'clock-skew' ? 0 : 60000,
      observedAt: version.asOf,
      evidence: Object.keys(fold.gaps),
      sourceRevision: version.revision,
    })
}
export async function observeProjectionOwnerAnomalies(
  db: ProviderNeutralDatabase,
  row: QualifiedObservationContribution,
  version: { revision: string; asOf: number },
) {
  if (!row.detail.taskId) return
  const taskId = row.detail.taskId,
    base = {
      taskId,
      taskName: null,
      sourceState: 'available' as const,
      samples: '1',
      minimumSamples: '1',
      windowMs: 60000,
      durationMs: 0,
      observedAt: version.asOf,
      sourceRevision: version.revision,
    }
  if (row.detail.section === 'tasks' && row.detail.parent === null) {
    const task = row.detail.document as CompleteObservationTask,
      attempts = row.detail.timingAttempts ?? []
    await sample(db, {
      ...base,
      taskName: task.task.name,
      rule: 'execution-failed',
      condition: task.task.status === 'failed',
      evidence: [task.task.status],
    })
    await sample(db, {
      ...base,
      taskName: task.task.name,
      rule: 'retry-amplification',
      samples: '1',
      minimumSamples: '1',
      condition:
        !['done', 'failed', 'canceled', 'interrupted'].includes(task.task.status) &&
        attempts.some(
          (attempt) =>
            attempt.retryIndex >= 3 &&
            attempt.startedAt !== null &&
            attempt.startedAt >= version.asOf - 60000,
        ),
      evidence: attempts.filter((attempt) => attempt.retryIndex >= 3).map((attempt) => attempt.id),
    })
    // First observed parked state is an explicit observation boundary. It does
    // not backdate to Task creation or count workgroup rounds as technical retry.
    await sample(db, {
      ...base,
      taskName: task.task.name,
      rule: 'human-waiting',
      conditionStartedAt: row.detail.humanWaitingSince,
      condition: ['awaiting_review', 'awaiting_human'].includes(task.task.status),
      durationMs: 300000,
      evidence: [task.task.status],
    })
  }
  if (row.detail.section === 'span-facts' && row.detail.parent === null) {
    const span = row.detail.document as ObservationSpanDetail
    if (span.fact.scope.kind === 'tool')
      await sample(db, {
        ...base,
        keyScope: span.fact.spanKey,
        rule: 'tool-timeout',
        condition:
          span.fact.state.status === 'unknown' || span.fact.state.startedAt === null
            ? null
            : span.fact.state.status === 'open' &&
              version.asOf - span.fact.state.startedAt >= 300000,
        evidence: [span.fact.spanKey, 'native-open-duration-threshold'],
      })
  }
}
/** Durable timed sampling only revisits published metadata and pending rules.
 * It never reopens raw Token sources or turns collector failure into Task failure. */
export function observationAnomalySampler(
  db: ProviderNeutralDatabase,
  now: () => number = Date.now,
) {
  let nextAt = 0
  return async () => {
    if (now() < nextAt) return
    nextAt = now() + 60000
    // Each section has its own seek cursor. An OR over sections combined
    // with ORDER BY key otherwise makes SQLite rescan the full kind prefix.
    for (const section of ['tasks', 'span-facts'] as const) {
      let after: string | undefined
      for (;;) {
        const rows = await db
          .select({
            key: observationProjectionCurrent.key,
            document: observationProjectionCurrent.document,
            revision: observationProjectionCurrent.revision,
          })
          .from(observationProjectionCurrent)
          .where(
            and(
              eq(observationProjectionCurrent.kind, 'contribution'),
              eq(observationProjectionCurrent.section, section),
              after ? gt(observationProjectionCurrent.key, after) : undefined,
            ),
          )
          .orderBy(asc(observationProjectionCurrent.key))
          .limit(200)
          .all()
        if (!rows.length) break
        await databaseSessionFor(db).transaction(async (tx) => {
          await engineOf(tx).lockAggregateRoot(
            tx,
            observationProjectionHeads,
            observationProjectionHeads.id,
            'incremental-20261012-v1',
          )
          for (const item of rows) {
            const current = await tx
              .select({ document: observationProjectionCurrent.document })
              .from(observationProjectionCurrent)
              .where(
                and(
                  eq(observationProjectionCurrent.kind, 'contribution'),
                  eq(observationProjectionCurrent.key, item.key),
                ),
              )
              .get()
            if (!current) continue
            const row = JSON.parse(current.document) as QualifiedObservationContribution
            await observeProjectionOwnerAnomalies(tx, row, { revision: item.revision, asOf: now() })
            const original = await tx
              .select({ document: observationProjectionCurrent.document })
              .from(observationProjectionCurrent)
              .where(
                and(
                  eq(observationProjectionCurrent.kind, 'aggregate'),
                  eq(observationProjectionCurrent.key, 'task/' + row.detail.taskId),
                ),
              )
              .get()
            if (original)
              await observeProjectionTaskAnomalies(
                tx,
                'task/' + row.detail.taskId,
                JSON.parse(original.document) as IncrementalObservationFold,
                { revision: item.revision, asOf: now() },
              )
          }
        })
        after = rows.at(-1)!.key
      }
    }
  }
}
export function observationAnomalyQueries(
  db: ProviderNeutralDatabase,
  visible: (ids: readonly string[]) => Promise<readonly string[]>,
  includeStorage = false,
) {
  return async (input: {
    from: number
    to: number
    after?: string
    pageSize: number
  }): Promise<ObservationAnomalyPage> => {
    const episodes = new Map<string, ObservationAnomaly>()
    // Resolved episodes remain historical facts after the same rule fires again.
    // Current state supplies the latest samples for the one still-open episode.
    for (const table of [observationAnomalyHistory, observationAnomalyStates] as const) {
      let after: string | undefined
      for (;;) {
        const cursorColumn =
          table === observationAnomalyHistory
            ? observationAnomalyHistory.id
            : observationAnomalyStates.key
        const rows = await db
          .select()
          .from(table)
          .where(after ? gt(cursorColumn, after) : undefined)
          .orderBy(asc(cursorColumn))
          .limit(200)
          .all()
        if (!rows.length) break
        for (const row of rows) {
          const value = ObservationAnomalySchema.parse(JSON.parse(row.document))
          if (table === observationAnomalyHistory && value.state !== 'resolved') continue
          if (
            value.firstObservedAt >= input.to ||
            (value.resolvedAt !== null && value.resolvedAt < input.from)
          )
            continue
          const previous = episodes.get(value.id)
          if (!previous || value.lastObservedAt >= previous.lastObservedAt)
            episodes.set(value.id, value)
        }
        after =
          table === observationAnomalyHistory
            ? (rows.at(-1)! as { id: string }).id
            : rows.at(-1)!.key
      }
    }
    const allowed = new Set<string>(),
      ids = [
        ...new Set([...episodes.values()].flatMap((value) => (value.taskId ? [value.taskId] : []))),
      ]
    for (let at = 0; at < ids.length; at += 200)
      for (const id of await visible(ids.slice(at, at + 200))) allowed.add(id)
    const order = (value: ObservationAnomaly) => JSON.stringify([value.key, value.id]),
      qualified = [...episodes.values()]
        .filter((value) =>
          value.taskId !== null
            ? allowed.has(value.taskId)
            : includeStorage &&
              ['storage-capacity', 'projection-backlog', 'storage-maintenance'].includes(
                value.rule,
              ),
        )
        .sort((a, b) => order(a).localeCompare(order(b))),
      scopedCursor = input.after ? (JSON.parse(input.after) as unknown) : undefined
    if (
      scopedCursor !== undefined &&
      (!Array.isArray(scopedCursor) ||
        scopedCursor.length !== 3 ||
        scopedCursor[0] !== input.from ||
        scopedCursor[1] !== input.to ||
        typeof scopedCursor[2] !== 'string')
    )
      throw new RangeError('Anomaly cursor changed period')
    const after =
        scopedCursor === undefined ? undefined : (scopedCursor as [number, number, string])[2],
      tail = qualified.filter(
        (value) => after === undefined || order(value).localeCompare(after) > 0,
      ),
      items = tail.slice(0, input.pageSize),
      nextCursor =
        tail.length > input.pageSize
          ? JSON.stringify([input.from, input.to, order(items.at(-1)!)])
          : null
    return { items, total: String(qualified.length), nextCursor, asOf: Date.now() }
  }
}

/** Storage findings use the same transition history as task findings, without entering numerical totals. */
export async function observeStorageAnomalies(
  db: ProviderNeutralDatabase,
  value: ObservationStorage,
  now = Date.now(),
) {
  const capacity =
    value.daysRemaining !== null
      ? value.daysRemaining < 7
      : value.freeBytes === null
        ? null
        : BigInt(value.freeBytes) < 1073741824n
  const backlog =
    value.pending === '0'
      ? false
      : value.oldestPendingAt === null
        ? null
        : now - value.oldestPendingAt >= 60000
  await databaseSessionFor(db).transaction(async (tx) => {
    await engineOf(tx).advisoryLock(tx, 'observation-storage-anomalies')
    for (const [rule, condition] of [
      ['storage-capacity', capacity],
      ['projection-backlog', backlog],
      ['storage-maintenance', value.lastError !== null],
    ] as const)
      await sample(tx, {
        taskId: null,
        taskName: null,
        rule,
        condition,
        sourceState: condition === null ? 'unavailable' : 'available',
        samples: '1',
        minimumSamples: '1',
        windowMs: 3600000,
        durationMs: 0,
        observedAt: now,
        sourceRevision: sha256Hex(JSON.stringify(value)),
        evidence: [JSON.stringify(value)],
      })
  })
}
