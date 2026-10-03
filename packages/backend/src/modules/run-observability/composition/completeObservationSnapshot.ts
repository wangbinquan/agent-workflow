import type { OriginalReportSnapshot } from '@/platform/persistence/reportSnapshotTypes'
import { sha256Hex } from '@/util/hash'
import { buildCompleteObservationCohort } from '../application/completeObservationCohort'
import { sealCompleteObservationReport } from '../application/completeObservationReportTransfer'
import { createCompleteObservationSources } from '../infrastructure/completeObservationSources'
import { completeObservationValuation } from '../infrastructure/completeObservationValuation'
import { completeObservationAgentNames } from '../infrastructure/completeObservationAgentNames'
import { completeObservationSourceRevision } from '../infrastructure/completeObservationSourceRevision'
import { assertCompleteReportActor } from '../infrastructure/completeObservationReportAdmission'
import { completeUsageWorkspace } from '../infrastructure/completeUsageWorkspace'
import type {
  CompleteObservationBuildResult,
  CompleteObservationSpool,
  CompleteObservationStoredReport,
} from '../ports/completeObservationReport'
import type { ObservationTaskSource } from '../ports/taskObservations'

/** Bootstrap supplies the Task owner's original full-population query on this exact reader. */
export async function composeCompleteObservationSnapshot(input: {
  readonly snapshot: OriginalReportSnapshot
  readonly tasks: ObservationTaskSource
  readonly report: CompleteObservationStoredReport
  readonly spool: CompleteObservationSpool
  readonly signal?: AbortSignal
}): Promise<CompleteObservationBuildResult> {
  const { snapshot, report, signal } = input
  signal?.throwIfAborted()
  if (snapshot.generationId !== report.generation)
    throw new Error('Original report database generation changed')
  await assertCompleteReportActor(snapshot.executor, report.request.actor, report.request.taskId)
  const task =
    report.request.taskId === undefined
      ? undefined
      : await input.tasks.get(report.request.actor, report.request.taskId)
  if (report.request.taskId !== undefined && !task)
    throw new Error('Original complete report root Task missing')
  const namespace = 'report/' + report.id
  const value = completeObservationValuation({
    db: snapshot.executor,
    rows: snapshot.workspace,
    namespace: namespace + '/value',
    signal,
  })
  const names = completeObservationAgentNames({
    db: snapshot.executor,
    rows: snapshot.workspace,
    namespace: namespace + '/agent-names',
    signal,
  })
  const build = await buildCompleteObservationCohort({
    actor: report.request.actor,
    query: report.request.query,
    ...(task ? { task } : {}),
    sources: createCompleteObservationSources({
      db: snapshot.executor,
      tasks: input.tasks,
      snapshotId: snapshot.snapshotId,
    }),
    asOf: snapshot.asOf,
    rows: snapshot.workspace,
    namespace,
    keyOf: sha256Hex,
    signal,
    usageWorkspace: completeUsageWorkspace,
    value: value.value,
    agentName: names.name,
  })
  await value.flush()
  await names.flush()
  if (build.summary.metrics.state === 'not-ready')
    return { state: 'not-ready', gaps: build.summary.metrics.gaps }
  const sourceRevision = await completeObservationSourceRevision({
    rows: snapshot.workspace,
    namespace: build.receiptsNamespace,
    taskSource: build.taskSource,
    snapshotId: snapshot.snapshotId,
    signal,
  })
  const header = {
    projectionVersion: 2 as const,
    reportId: report.id,
    generation: report.generation,
    snapshotId: snapshot.snapshotId,
    asOf: snapshot.asOf,
    sourceRevision,
    actorScope: report.actorScope,
    authorizationRevision: String(report.request.actor.authorityRevision ?? 0),
    filters: report.request.query,
    taskId: report.request.taskId ?? null,
  }
  return {
    state: 'ready',
    manifest: await sealCompleteObservationReport({
      report,
      rows: snapshot.workspace,
      build,
      header,
      spool: input.spool,
      signal,
    }),
  }
}
