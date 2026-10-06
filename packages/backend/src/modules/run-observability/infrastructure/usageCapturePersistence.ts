import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import {
  ObservationUsageCaptureCommitSchema,
  type ObservationUsageCaptureCommit,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationUsageCaptures } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { ObservationIngestError } from '../domain/ingestError'
import type { NativeRevisionResolution, UsageCaptureReceipt } from '../ports/usageLedger'
import {
  NativeHistoryProgressSchema,
  nativeHistoryFingerprint,
  type NativeHistoryProgress,
} from '../domain/nativeUsageHistory'

function decode(row: {
  document: string
  sourceId: string
  sourceCursor: string
  priorRevisionGap: number
}): UsageCaptureReceipt {
  const value = JSON.parse(row.document) as {
    evidence: unknown
    resolutions: NativeRevisionResolution[]
    history?: unknown
  }
  return {
    ...ObservationUsageCaptureCommitSchema.parse(value.evidence),
    sourceCursor: row.sourceCursor,
    sourceId: row.sourceId,
    resolutions: value.resolutions,
    priorRevisionGap: row.priorRevisionGap === 1,
    ...(value.history === undefined
      ? {}
      : { history: NativeHistoryProgressSchema.parse(value.history) }),
  }
}
export async function readUsageCapture(db: ProviderNeutralDatabase, invocationId: string) {
  const row = await db
    .select()
    .from(observationUsageCaptures)
    .where(eq(observationUsageCaptures.invocationId, invocationId))
    .get()
  return row ? decode(row) : undefined
}

/** Every retained capture header is traversed; compact explanation text is not an EOF proof. */
export async function readUsageCapturePage(
  db: ProviderNeutralDatabase,
  taskId: string,
  page: { readonly limit: number; readonly after?: string },
) {
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 500)
    throw new RangeError('Capture page size must be 1 through 500')
  const rows = await db
    .select({
      invocationId: observationUsageCaptures.invocationId,
      document: observationUsageCaptures.document,
      sourceId: observationUsageCaptures.sourceId,
      sourceCursor: observationUsageCaptures.sourceCursor,
      nativeRootKey: observationUsageCaptures.nativeRootKey,
      priorRevisionGap: observationUsageCaptures.priorRevisionGap,
    })
    .from(observationUsageCaptures)
    .where(
      and(
        eq(observationUsageCaptures.taskId, taskId),
        page.after === undefined
          ? undefined
          : gt(observationUsageCaptures.invocationId, page.after),
      ),
    )
    .orderBy(asc(observationUsageCaptures.invocationId))
    .limit(page.limit + 1)
    .all()
  const selected = rows.slice(0, page.limit)
  const roots = [
    ...new Set(selected.flatMap((row) => (row.nativeRootKey === null ? [] : [row.nativeRootKey]))),
  ]
  const gaps =
    roots.length === 0
      ? []
      : await db
          .select({ root: observationUsageCaptures.nativeRootKey })
          .from(observationUsageCaptures)
          .where(
            and(
              inArray(observationUsageCaptures.nativeRootKey, roots),
              eq(observationUsageCaptures.priorRevisionGap, 1),
            ),
          )
          .groupBy(observationUsageCaptures.nativeRootKey)
          .all()
  const affected = new Set(gaps.map((row) => row.root))
  return {
    items: selected.map((row) => ({
      ...decode(row),
      priorRevisionGap:
        row.priorRevisionGap === 1 ||
        (row.nativeRootKey !== null && affected.has(row.nativeRootKey)),
    })),
    nextCursor: rows.length > page.limit ? selected.at(-1)!.invocationId : null,
  }
}

/** Immutable native evidence and its recoverable projection are distinct. */
export async function commitUsageCapture(
  db: ProviderNeutralDatabase,
  sourceId: string,
  sourceCursor: string,
  value: ObservationUsageCaptureCommit,
  resolutions: readonly NativeRevisionResolution[],
  history?: NativeHistoryProgress,
) {
  const previous = await readUsageCapture(db, value.invocationId)
  const paged =
    value.capture.contract === 'opencode-child-pages-v2' ||
    value.capture.contract === 'opencode-child-root-pages-v3'
  const originalWatermark = (cursor: string) => {
    const match = /^node-event:([1-9]\d*)$/.exec(cursor)
    if (!match)
      throw new ObservationIngestError(
        'invalid-batch',
        'Native capture has no original source watermark',
      )
    return BigInt(match[1]!)
  }
  const advancingNative =
    paged &&
    previous?.capture.contract === value.capture.contract &&
    previous.taskId === value.taskId &&
    previous.sourceId === sourceId &&
    previous.capture.nativeSource === value.capture.nativeSource &&
    originalWatermark(sourceCursor) > originalWatermark(previous.sourceCursor) &&
    previous.capture.state !== 'complete'
  if (
    previous &&
    (previous.sourceId !== sourceId ||
      (JSON.stringify({
        invocationId: previous.invocationId,
        taskId: previous.taskId,
        capture: previous.capture,
      }) !== JSON.stringify(value) &&
        !advancingNative))
  )
    throw new ObservationIngestError('event-conflict', 'Native capture proof changed')
  const nativeRootKey =
    value.capture.rootSessionId === null
      ? null
      : sha256Hex(JSON.stringify([value.capture.nativeSource, value.capture.rootSessionId]))
  const priorRevisionGap = Number(
    (paged &&
      (value.capture.contract === 'opencode-child-pages-v2' ||
        value.capture.contract === 'opencode-child-root-pages-v3') &&
      value.capture.reconciliation.unresolved !== '0') ||
      resolutions.some(
        (row) => row.status === 'unresolved' && row.reason !== 'native-owner-unseen',
      ) ||
      (value.capture.issues.includes('native-prior-revision-gap') && resolutions.length === 0),
  )
  const previousResolutions = new Map(previous?.resolutions.map((row) => [row.stepId, row]) ?? [])
  const valueFingerprint = paged
    ? nativeHistoryFingerprint({ ...value, sourceId, sourceCursor })
    : undefined
  const retainedHistory =
    history ??
    (previous?.history?.preparation.valueFingerprint === valueFingerprint
      ? previous?.history
      : undefined)
  if (retainedHistory && retainedHistory.preparation.valueFingerprint !== valueFingerprint)
    throw new ObservationIngestError(
      'event-conflict',
      'Native history progress changed its original source',
    )
  if (retainedHistory) NativeHistoryProgressSchema.parse(retainedHistory)
  const retained = resolutions.map((row) => {
    const prior = previousResolutions.get(row.stepId)
    return row.status === 'resolved' &&
      row.previous === undefined &&
      prior?.previous !== undefined &&
      prior.invocationId === row.invocationId
      ? { ...row, previous: prior.previous, current: prior.current }
      : row
  })
  // List/overview queries never load thousands of baseline records. The full evidence remains
  // durable for projection retry, while the compact summary retains the first 100 explanations.
  const proof =
    value.capture.contract === 'opencode-child-steps-v1'
      ? (({ baselineSteps: _baseline, ...rest }) => rest)(value.capture)
      : value.capture
  const summary = {
    evidence: { ...value, capture: proof },
    resolutions: retained
      .filter((row) => row.status === 'unresolved' || row.previous !== undefined)
      .slice(0, 100),
    ...(retainedHistory === undefined ? {} : { history: retainedHistory }),
  }
  const row = {
    invocationId: value.invocationId,
    taskId: value.taskId,
    sourceId,
    sourceCursor,
    nativeRootKey,
    priorRevisionGap,
    repairPending: Number(
      resolutions.some((row) => row.status === 'unresolved') ||
        (((value.capture.contract === 'opencode-child-pages-v2' &&
          value.capture.baseline.kind === 'resume') ||
          (value.capture.contract === 'opencode-child-root-pages-v3' &&
            value.capture.beforeSpawn.mode === 'resume')) &&
          (retainedHistory
            ? retainedHistory.state !== 'resolved'
            : value.capture.reconciliation.unresolved !== '0' ||
              value.capture.reconciliation.examined !==
                (value.capture.contract === 'opencode-child-pages-v2'
                  ? value.capture.baseline.kind === 'resume'
                    ? value.capture.baseline.pass?.ack.counts.steps
                    : '0'
                  : undefined))),
    ),
    document: JSON.stringify({
      evidence: value,
      resolutions: retained,
      ...(retainedHistory === undefined ? {} : { history: retainedHistory }),
    }),
    summary: JSON.stringify(summary),
  }
  await db
    .insert(observationUsageCaptures)
    .values(row)
    .onConflictDoUpdate({ target: observationUsageCaptures.invocationId, set: row })
    .run()
}

export async function readUsageCaptures(
  db: ProviderNeutralDatabase,
  invocationIds: readonly string[],
) {
  if (invocationIds.length > 1000) throw new RangeError('Capture query exceeds invocation budget')
  const result: UsageCaptureReceipt[] = []
  for (let start = 0; start < invocationIds.length; start += 400) {
    const rows = await db
      .select({
        invocationId: observationUsageCaptures.invocationId,
        document: observationUsageCaptures.summary,
        sourceId: observationUsageCaptures.sourceId,
        sourceCursor: observationUsageCaptures.sourceCursor,
        nativeRootKey: observationUsageCaptures.nativeRootKey,
        priorRevisionGap: observationUsageCaptures.priorRevisionGap,
      })
      .from(observationUsageCaptures)
      .where(
        inArray(observationUsageCaptures.invocationId, [
          ...invocationIds.slice(start, start + 400),
        ]),
      )
      .all()
    const roots = [
      ...new Set(rows.flatMap((row) => (row.nativeRootKey === null ? [] : [row.nativeRootKey]))),
    ]
    const gaps =
      roots.length === 0
        ? []
        : await db
            .select({ root: observationUsageCaptures.nativeRootKey })
            .from(observationUsageCaptures)
            .where(
              and(
                inArray(observationUsageCaptures.nativeRootKey, roots),
                eq(observationUsageCaptures.priorRevisionGap, 1),
              ),
            )
            .groupBy(observationUsageCaptures.nativeRootKey)
            .all()
    const affected = new Set(gaps.map((row) => row.root))
    for (const row of rows)
      result.push({
        ...decode(row),
        priorRevisionGap:
          row.priorRevisionGap === 1 ||
          (row.nativeRootKey !== null && affected.has(row.nativeRootKey)),
      })
  }
  return result
}

export async function readPendingCaptureRepairs(
  db: ProviderNeutralDatabase,
  limit: number,
  after?: string,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2)
    throw new RangeError('Capture repair page exceeds budget')
  const read = (cursor?: string) =>
    db
      .select()
      .from(observationUsageCaptures)
      .where(
        and(
          eq(observationUsageCaptures.repairPending, 1),
          cursor ? gt(observationUsageCaptures.invocationId, cursor) : undefined,
        ),
      )
      .orderBy(asc(observationUsageCaptures.invocationId))
      .limit(limit)
      .all()
  const rows = await read(after)
  return (rows.length || after === undefined ? rows : await read()).map(decode)
}
