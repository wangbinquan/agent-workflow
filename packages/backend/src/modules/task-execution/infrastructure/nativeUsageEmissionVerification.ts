import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import {
  ObservationNativeEmissionSchema,
  ObservationNativeCompletionSchema,
  ObservationNativeSourceAckSchema,
  type ObservationNativeCompletion,
  type ObservationNativeProcessFact,
} from '@agent-workflow/shared'
import { nativeUsageEmissions, taskExecutionObservationSources } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import type { NativeUsageOwnerBinding } from '../application/ports/nativeUsagePersistence'
import type { TaskExecutionTransaction } from './ownedTaskExecution'
import { nativeUsageSourceWatermark } from './nativeUsageOwnerTransaction'
import { verifyNativeUsageMeasurementEvidence } from './nativeUsageMeasurementEvidence'
import { ObservationNativeMeasurementSchema } from '@agent-workflow/shared'

/** Read every frozen emission and its actual original source; packet sizes never bound EOF. */
export async function verifyNativeUsageEmissions(
  tx: TaskExecutionTransaction,
  binding: NativeUsageOwnerBinding,
): Promise<{
  readonly emissions: ObservationNativeCompletion['emissions']
  readonly process: ObservationNativeCompletion['process']
  readonly hasProcessIssues: boolean
  readonly observedAtFloor: number
}> {
  let after: string | undefined
  let records = 0n,
    frames = 0n,
    sources = 0n
  let digest = sha256Hex(JSON.stringify(['native-emissions-v2', binding.invocationId]))
  let spawned: ObservationNativeProcessFact | undefined
  let settled: ObservationNativeProcessFact | undefined
  let observedAtFloor = 0
  for (;;) {
    const rows = await tx
      .select()
      .from(nativeUsageEmissions)
      .where(
        and(
          eq(nativeUsageEmissions.invocationId, binding.invocationId),
          after === undefined ? undefined : gt(nativeUsageEmissions.eventId, after),
        ),
      )
      .orderBy(asc(nativeUsageEmissions.eventId))
      .limit(20)
    if (rows.length === 0) break
    const sourceRows = await tx
      .select()
      .from(taskExecutionObservationSources)
      .where(
        inArray(
          taskExecutionObservationSources.id,
          rows.map((row) => row.sourceRowId),
        ),
      )
    const sourcesById = new Map(sourceRows.map((row) => [row.id, row]))
    for (const row of rows) {
      sources++
      const stored = JSON.parse(row.document) as { request: string; evidence: string }
      const evidence = JSON.parse(stored.evidence)
      const originalRequest: unknown = JSON.parse(stored.request)
      const isSeal =
        originalRequest !== null &&
        typeof originalRequest === 'object' &&
        Object.hasOwn(originalRequest, 'nativeCompletion')
      const request = isSeal
        ? (originalRequest as {
            invocationId: string
            measurements: readonly []
            diagnostics: string[]
            nativeCompletion: ObservationNativeCompletion
          })
        : ObservationNativeEmissionSchema.parse(originalRequest)
      if (isSeal) {
        const seal = request as {
          invocationId: string
          measurements: readonly []
          diagnostics: string[]
          nativeCompletion: ObservationNativeCompletion
        }
        const completion = ObservationNativeCompletionSchema.parse(seal.nativeCompletion)
        if (
          !isDeepStrictEqual(seal, {
            invocationId: binding.invocationId,
            measurements: [],
            diagnostics: completion.issues,
            nativeCompletion: completion,
          })
        )
          throw new Error('Native emission verification changed its original completion frame')
      }
      const source = sourcesById.get(row.sourceRowId)
      const ack = ObservationNativeSourceAckSchema.parse(JSON.parse(row.ack))
      if (
        !source ||
        source.taskId !== binding.taskId ||
        source.nodeRunId !== binding.nodeRunId ||
        source.evidenceJson !== stored.evidence ||
        sha256Hex(stored.request) !== row.fingerprint ||
        evidence.invocationId !== binding.invocationId ||
        request.invocationId !== binding.invocationId ||
        ack.invocationId !== binding.invocationId ||
        ack.eventId !== row.eventId ||
        ack.fingerprint !== row.fingerprint ||
        ack.sourceWatermark !== String(source.id) ||
        !isDeepStrictEqual(evidence, { ...request, measurements: ack.measurements })
      )
        throw new Error('Native emission verification changed its original source or frozen ACK')
      if (
        ack.measurements.length !== request.measurements.length ||
        ack.measurements.some(
          (measurement, index) =>
            !isDeepStrictEqual(measurement, {
              ...request.measurements[index],
              revision: measurement.revision,
            }),
        )
      )
        throw new Error('Native emission verification changed its original measurement payload')
      if (isSeal) {
        if (ack.measurements.length !== 0)
          throw new Error('Native completion source contains numeric measurements')
        observedAtFloor = Math.max(
          observedAtFloor,
          (request as { nativeCompletion: ObservationNativeCompletion }).nativeCompletion
            .observedAt,
        )
        continue
      }
      for (const measurement of ack.measurements)
        observedAtFloor = Math.max(observedAtFloor, measurement.observedAt)
      const native = ack.measurements.flatMap((measurement) =>
        measurement.scope && 'ancestry' in measurement.scope
          ? [ObservationNativeMeasurementSchema.parse(measurement)]
          : [],
      )
      await verifyNativeUsageMeasurementEvidence(tx, binding, native)
      const process = ObservationNativeEmissionSchema.parse(request).nativeProcess
      if (process !== undefined) {
        observedAtFloor = Math.max(
          observedAtFloor,
          process.spawnedAt ?? 0,
          process.reapedAt ?? 0,
          process.drainedAt ?? 0,
        )
        if (process.phase === 'spawned') {
          if (spawned !== undefined && !isDeepStrictEqual(spawned, process))
            throw new Error('Native emission verification changed the original spawn fact')
          spawned = process
        } else {
          if (settled !== undefined && !isDeepStrictEqual(settled, process))
            throw new Error('Native emission verification changed the original settled fact')
          settled = process
        }
      }
      frames++
      records += BigInt(ack.measurements.length)
      digest = sha256Hex(
        JSON.stringify([
          digest,
          row.eventId,
          row.fingerprint,
          String(source.id),
          sha256Hex(row.ack),
        ]),
      )
    }
    const next = rows.at(-1)!.eventId
    if (next === after) throw new Error('Native emission verification did not advance to EOF')
    after = next
  }
  const population = (
    await tx
      .select({
        rows: sql<string>`CAST(count(*) AS TEXT)`,
        sources: sql<string>`CAST(count(DISTINCT ${nativeUsageEmissions.sourceRowId}) AS TEXT)`,
      })
      .from(nativeUsageEmissions)
      .where(eq(nativeUsageEmissions.invocationId, binding.invocationId))
  )[0]
  if (!population || BigInt(population.rows) !== sources || BigInt(population.sources) !== sources)
    throw new Error('Native emissions changed or duplicated their original source population')
  if (
    spawned !== undefined &&
    settled !== undefined &&
    (spawned.pid !== settled.pid ||
      spawned.launchNonce !== settled.launchNonce ||
      spawned.spawnedAt !== settled.spawnedAt)
  )
    throw new Error('Native emission verification changed the original process identity')
  return {
    emissions: {
      records: String(records),
      frames: String(frames),
      digest,
      sourceWatermark: await nativeUsageSourceWatermark(tx, binding.nodeRunId),
    },
    process: {
      spawnedAt: spawned?.spawnedAt ?? settled?.spawnedAt ?? null,
      reapedAt: settled?.reapedAt ?? null,
      drainedAt: settled?.drainedAt ?? null,
    },
    observedAtFloor,
    hasProcessIssues:
      spawned === undefined ||
      spawned.launchNonce === null ||
      settled === undefined ||
      settled.reapedAt === null ||
      settled.drainedAt === null ||
      settled.drainTimedOut ||
      settled.pumpError,
  }
}
