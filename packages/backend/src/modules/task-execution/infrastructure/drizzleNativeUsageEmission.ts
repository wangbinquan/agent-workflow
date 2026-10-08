import { nativeUsageEvidenceStorage } from './nativeUsageEvidenceStorage'
import { and, eq } from 'drizzle-orm'
import { ObservationNativeEmissionSchema } from '@agent-workflow/shared'
import { ObservationNativeSourceAckSchema } from '@agent-workflow/shared'
import { AcceptedObservationInvocationSchema } from '@agent-workflow/shared'
import { ObservationNativeMeasurementSchema } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationInvocations } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import type { NativeUsagePersistence } from '../application/ports/nativeUsagePersistence'
import type { TaskExecutionTransaction } from './ownedTaskExecution'
import { withNativeUsageOwner, type NativeUsageOwnerFacts } from './nativeUsageOwnerTransaction'
import {
  lockOriginalNativeUsageSource,
  allocateOriginalNativeRevisions,
  rememberOriginalNativeSources,
} from './nativeUsageRevisionAllocation'
import { verifyNativeUsageMeasurementEvidence } from './nativeUsageMeasurementEvidence'

type EmissionPort = Pick<NativeUsagePersistence, 'emit'>

/** Frozen original-source mappings; this owner never adds a second set of numeric totals. */
export class DrizzleNativeUsageEmission implements EmissionPort {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async emit(input: Parameters<EmissionPort['emit']>[0]) {
    return withNativeUsageOwner(this.db, input.binding, (tx, facts) =>
      emitNativeUsageEvidence(tx, facts, input),
    )
  }
}

/** Used by the original page writer inside its own transaction, before the page ACK. */
export async function emitNativeUsageEvidence(
  tx: TaskExecutionTransaction,
  facts: NativeUsageOwnerFacts,
  input: Parameters<EmissionPort['emit']>[0],
) {
  const { nativeUsagePreparations, nativeUsageEmissions, taskExecutionObservationSources } =
    nativeUsageEvidenceStorage(input.binding.sourceKind)

  if (!input.eventId || input.eventId.length > 512)
    throw new RangeError('Invalid original native emission identity')
  ObservationNativeEmissionSchema.parse(input.evidence)
  const request = JSON.stringify(input.evidence)
  const fingerprint = sha256Hex(request)
  const prepared = (
    await tx
      .select()
      .from(nativeUsagePreparations)
      .where(eq(nativeUsagePreparations.invocationId, input.binding.invocationId))
      .limit(1)
  )[0]
  if (
    !prepared ||
    prepared.taskId !== input.binding.taskId ||
    prepared.nodeRunId !== input.binding.nodeRunId ||
    prepared.fence !== facts.fence ||
    input.evidence.invocationId !== input.binding.invocationId
  )
    throw new Error('Original native emission has no matching preparation')
  const frozen = (
    await tx
      .select()
      .from(nativeUsageEmissions)
      .where(
        and(
          eq(nativeUsageEmissions.invocationId, input.binding.invocationId),
          eq(nativeUsageEmissions.eventId, input.eventId),
        ),
      )
      .limit(1)
  )[0]
  if (frozen) {
    const document = JSON.parse(frozen.document) as { request: string; evidence: string }
    const original = (
      await tx
        .select()
        .from(taskExecutionObservationSources)
        .where(eq(taskExecutionObservationSources.id, frozen.sourceRowId))
        .limit(1)
    )[0]
    if (
      frozen.fingerprint !== fingerprint ||
      document.request !== request ||
      !original ||
      original.taskId !== input.binding.taskId ||
      original.nodeRunId !== input.binding.nodeRunId ||
      original.evidenceJson !== document.evidence
    )
      throw new Error('Original native emission replay changed its frozen payload')
    return ObservationNativeSourceAckSchema.parse(JSON.parse(frozen.ack))
  }
  if (prepared.state !== 'open')
    throw new Error('Original native invocation has already been sealed')
  const acceptedRow = (
    await tx
      .select({ document: observationInvocations.document })
      .from(observationInvocations)
      .where(eq(observationInvocations.id, input.binding.invocationId))
      .limit(1)
  )[0]
  if (!acceptedRow) throw new Error('Original native invocation is absent')
  const accepted = AcceptedObservationInvocationSchema.parse(JSON.parse(acceptedRow.document))
  const native = []
  for (const measurement of input.evidence.measurements) {
    if (measurement.agentId !== accepted.agentId)
      throw new Error('Original native emission changed its accepted Agent')
    if (measurement.scope && 'ancestry' in measurement.scope)
      native.push(ObservationNativeMeasurementSchema.parse(measurement))
  }
  await verifyNativeUsageMeasurementEvidence(tx, input.binding, native)
  const sourceId = await lockOriginalNativeUsageSource(
    tx,
    input.binding.nodeRunId,
    input.binding.sourceKind,
  )
  const measurements = await allocateOriginalNativeRevisions(
    tx,
    input.binding,
    sourceId,
    input.evidence.measurements,
  )
  const evidence = JSON.stringify({ ...input.evidence, measurements })
  const original = (
    await tx
      .insert(taskExecutionObservationSources)
      .values({
        taskId: input.binding.taskId,
        nodeRunId: input.binding.nodeRunId,
        evidenceJson: evidence,
      })
      .returning({ id: taskExecutionObservationSources.id })
      .all()
  )[0]
  if (!original || !Number.isSafeInteger(original.id) || original.id < 1)
    throw new Error('Original native emission did not return its actual source row')
  await rememberOriginalNativeSources(
    tx,
    input.binding.invocationId,
    measurements,
    original.id,
    input.binding.sourceKind,
  )
  const ack = ObservationNativeSourceAckSchema.parse({
    contract: 'native-usage-source-ack-v2',
    invocationId: input.binding.invocationId,
    eventId: input.eventId,
    fingerprint,
    sourceWatermark: String(original.id),
    measurements,
  })
  await tx
    .insert(nativeUsageEmissions)
    .values({
      invocationId: input.binding.invocationId,
      eventId: input.eventId,
      fingerprint,
      sourceRowId: original.id,
      document: JSON.stringify({ request, evidence }),
      ack: JSON.stringify(ack),
    })
    .run()
  return ack
}
