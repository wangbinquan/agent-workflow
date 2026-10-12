import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationInvocations } from '@/db/schema'
import {
  observationProjectionComponents,
  observationProjectionCurrent,
  observationProjectionHeads,
} from '@/db/observationProjection'
import type { ReportSnapshotSession } from '@/platform/persistence/reportSnapshotTypes'
import { jsonPathText } from '@/platform/persistence/jsonPathText'
import { sha256Hex } from '@/util/hash'
import type {
  CompleteObservationTask,
  CompleteObservationInvocation,
  HistoricalObservationExecution,
} from '@agent-workflow/shared'
import { buildCompleteObservationCohort } from '../application/completeObservationCohort'
import { buildCompleteObservationUsageWindow } from '../application/completeObservationUsageWindow'
import { completeWorkingTraversal } from '../application/completeWorkingTraversal'
import { projectionTaskMetadata } from '../application/incrementalObservationTaskMetadata'
import { completeMetricsFold } from '../domain/completeMetricsFold'
import { emptyCompleteObservationFold } from '../domain/completeObservationMetrics'
import { completeObservationAgentNames } from '../infrastructure/completeObservationAgentNames'
import { completeObservationValuation } from '../infrastructure/completeObservationValuation'
import { createCompleteObservationSources } from '../infrastructure/completeObservationSources'
import { completeUsageWorkspace } from '../infrastructure/completeUsageWorkspace'
import { incrementalObservationPreparedStore } from '../infrastructure/incrementalObservationPreparedStore'
import {
  projectionAcceptedScope,
  projectionCaptureRoots,
} from '../infrastructure/incrementalObservationScope'
import type { ProjectionObservationTaskSource } from '../ports/taskObservations'
import type { HistoricalObservationSources } from '../ports/historicalObservationSources'
import type {
  CompleteObservationReportRow,
  CompleteObservationCohortInput,
} from '../ports/completeObservationReport'
import type { IncrementalObservationWork } from '../ports/incrementalObservationProjection'
import type {
  QualifiedObservationContribution,
  QualifiedObservationDetail,
  QualifiedObservationHistoricalContribution,
  QualifiedObservationDimensionContribution,
} from '../ports/incrementalObservationQualified'

export interface ProjectionOriginalScope {
  readonly taskIds: readonly string[]
  readonly roots: readonly string[]
  readonly ownerIds: Readonly<
    Partial<Record<HistoricalObservationExecution['sourceKind'], readonly string[]>>
  >
}
const component = (kind: string, id: string) => JSON.stringify([kind, id])
const dimensionSection = {
  agent: 'agents',
  runtime: 'runtimes',
  model: 'models',
  purpose: 'purposes',
  source: 'sources',
} as const
/** One complete original qualification of the affected connected calls/roots.
 * Task metadata never expands a numeric scope to all calls of that Task. */
export function incrementalObservationQualification(input: {
  readonly db: ProviderNeutralDatabase
  readonly snapshot: ReportSnapshotSession
  readonly tasks: (
    db: ProviderNeutralDatabase,
    ids?: readonly string[],
    attemptIds?: readonly string[],
  ) => ProjectionObservationTaskSource
  readonly owners: (
    db: ProviderNeutralDatabase,
    scope?: ProjectionOriginalScope,
  ) => HistoricalObservationSources['owners']
  readonly native: () => HistoricalObservationSources['native'] & { close(): void }
}) {
  const prepared = incrementalObservationPreparedStore(input.db)
  return async (originalWork: IncrementalObservationWork, signal: AbortSignal) => {
    const work = await prepared.begin(originalWork)
    let leaseFailure: unknown,
      renewal = Promise.resolve()
    const timer = setInterval(() => {
      renewal = renewal
        .then(() => prepared.renew(work))
        .catch((error: unknown) => {
          leaseFailure = error
        })
    }, 15000)
    try {
      return await input.snapshot.run(async (snapshot) => {
        const baseRevision =
          (
            await snapshot.executor
              .select({ revision: observationProjectionHeads.revision })
              .from(observationProjectionHeads)
              .where(eq(observationProjectionHeads.id, 'incremental-20261012-v1'))
              .get()
          )?.revision ?? '0'
        if (work.source === 'original-bootstrap-finish')
          return prepared.seal(
            work,
            {
              generation: snapshot.generationId,
              snapshotId: snapshot.snapshotId,
              asOf: snapshot.asOf,
              baseRevision,
              preparationToken: work.preparationToken!,
            },
            work.components,
          )
        if (work.source === 'original-bootstrap-component') {
          let qualified = 0
          for (let at = 0; at < work.components.length; at += 200)
            qualified += (
              await snapshot.executor
                .select({ component: observationProjectionComponents.component })
                .from(observationProjectionComponents)
                .where(
                  inArray(
                    observationProjectionComponents.component,
                    work.components.slice(at, at + 200),
                  ),
                )
                .all()
            ).length
          if (qualified === work.components.length) {
            for (let at = 0; at < work.components.length; at += 200) {
              let after: string | undefined
              for (;;) {
                const rows = await snapshot.executor
                  .select({
                    key: observationProjectionCurrent.key,
                    document: observationProjectionCurrent.document,
                  })
                  .from(observationProjectionCurrent)
                  .where(
                    and(
                      eq(observationProjectionCurrent.kind, 'contribution'),
                      inArray(
                        observationProjectionCurrent.component,
                        work.components.slice(at, at + 200),
                      ),
                      after === undefined ? undefined : gt(observationProjectionCurrent.key, after),
                    ),
                  )
                  .orderBy(asc(observationProjectionCurrent.key))
                  .limit(200)
                  .all()
                if (!rows.length) break
                await prepared.append(
                  work,
                  rows.map((row) => JSON.parse(row.document) as QualifiedObservationContribution),
                )
                after = rows.at(-1)!.key
              }
            }
            return prepared.seal(
              work,
              {
                generation: snapshot.generationId,
                snapshotId: snapshot.snapshotId,
                asOf: snapshot.asOf,
                baseRevision,
                preparationToken: work.preparationToken!,
              },
              work.components,
            )
          }
        }
        const namespace = 'projection/' + work.id,
          bootstrap = work.source === 'original-bootstrap'
        const metadataIds = new Set<string>(),
          numericTaskIds = new Set<string>(),
          invocationIds = new Set<string>(),
          attemptIds = new Set<string>(),
          roots = new Set<string>(),
          ownerIds: Record<string, Set<string>> = {}
        for (const value of work.components) {
          const [kind, id] = JSON.parse(value) as [string, string]
          if (kind === 'task-metadata') metadataIds.add(id)
          else if (kind === 'invocation') invocationIds.add(id)
          else if (kind === 'attempt') attemptIds.add(id)
          else if (kind === 'root') roots.add(id)
          else if (kind !== 'bootstrap') {
            ;(ownerIds[kind] ??= new Set()).add(id)
            if (kind === 'task') attemptIds.add(id)
          }
        }
        // A parent Task is display/visibility metadata. It is deliberately NOT
        // an owner-scope selector, which would reopen every run of that Task.
        const scope = (): ProjectionOriginalScope => ({
          taskIds: [],
          roots: [...roots],
          ownerIds: Object.fromEntries(
            Object.entries(ownerIds).map(([kind, ids]) => [kind, [...ids]]),
          ),
        })
        const seenOwners = new Set<string>()
        for (;;) {
          const size =
            roots.size +
            attemptIds.size +
            invocationIds.size +
            Object.values(ownerIds).reduce((n, ids) => n + ids.size, 0)
          for (const source of input.owners(snapshot.executor, bootstrap ? undefined : scope())) {
            let after: string | undefined
            for (;;) {
              signal.throwIfAborted()
              const page = await source.query.owners({ limit: 100, ...(after ? { after } : {}) })
              for (const owner of page.items) {
                if (owner.parentTaskId) {
                  metadataIds.add(owner.parentTaskId)
                  numericTaskIds.add(owner.parentTaskId)
                }
                if (owner.rootSessionId) roots.add(owner.rootSessionId)
                ;(ownerIds[owner.sourceKind] ??= new Set()).add(owner.ownerId)
                if (owner.sourceKind === 'task') attemptIds.add(owner.ownerId)
                const key = JSON.stringify([source.kind, owner.ownerId])
                if (seenOwners.has(key)) continue
                seenOwners.add(key)
                let eventAfter: string | undefined
                for (;;) {
                  const events = await source.query.events(owner.ownerId, {
                    limit: 100,
                    ...(eventAfter ? { after: eventAfter } : {}),
                  })
                  for (const event of events.items) {
                    if (event.sessionId) roots.add(event.sessionId)
                    if (event.parentSessionId) roots.add(event.parentSessionId)
                  }
                  if (events.nextCursor === null) break
                  if (eventAfter === events.nextCursor)
                    throw new Error('Original projection event EOF did not advance')
                  eventAfter = events.nextCursor
                }
              }
              if (page.nextCursor === null) break
              if (after === page.nextCursor)
                throw new Error('Original projection owner EOF did not advance')
              after = page.nextCursor
            }
          }
          if (!bootstrap)
            for (const call of await projectionAcceptedScope(snapshot.executor, {
              invocationIds: [...invocationIds],
              attemptIds: [...attemptIds],
              roots: [...roots],
            })) {
              invocationIds.add(call.invocationId)
              numericTaskIds.add(call.taskId)
              metadataIds.add(call.taskId)
              if (call.nodeRunId) {
                attemptIds.add(call.nodeRunId)
                ;(ownerIds.task ??= new Set()).add(call.nodeRunId)
              }
            }
          if (!bootstrap)
            for (const root of await projectionCaptureRoots(snapshot.executor, [...invocationIds]))
              roots.add(root)
          if (
            bootstrap ||
            size ===
              roots.size +
                attemptIds.size +
                invocationIds.size +
                Object.values(ownerIds).reduce((n, ids) => n + ids.size, 0)
          )
            break
        }
        const tasks = input.tasks(
            snapshot.executor,
            bootstrap ? undefined : [...numericTaskIds],
            bootstrap ? undefined : [...attemptIds],
          ),
          metadataTasks = input.tasks(snapshot.executor, bootstrap ? undefined : [...metadataIds]),
          native = input.native()
        const value = completeObservationValuation({
          db: snapshot.executor,
          rows: snapshot.workspace,
          namespace: namespace + '/value',
          signal,
        })
        const names = completeObservationAgentNames({
          db: snapshot.executor,
          rows: snapshot.workspace,
          namespace: namespace + '/names',
          signal,
          originalAgentName: tasks.originalAgentName,
        })
        const components = new Set([
            ...work.components,
            ...[...metadataIds].map((id) => component('task-metadata', id)),
            ...[...invocationIds].map((id) => component('invocation', id)),
            ...[...attemptIds].map((id) => component('attempt', id)),
            ...[...roots].map((id) => component('root', id)),
            ...Object.entries(ownerIds).flatMap(([kind, ids]) =>
              [...ids].map((id) => component(kind, id)),
            ),
          ]),
          pending: QualifiedObservationContribution[] = []
        const historicalMetadata = new Map<string, QualifiedObservationHistoricalContribution>(),
          dimensionContributions: QualifiedObservationDimensionContribution[] = [],
          timeDimensions: QualifiedObservationDimensionContribution[] = []
        let collectingTime = false
        const invocationInventories = new Map<
          string,
          { readonly numericRecords: string; readonly nativeCaptures: string }
        >()
        let retained = 0n
        async function retain(
          owner: string,
          detail: QualifiedObservationDetail,
          fold: QualifiedObservationContribution['fold'] = emptyCompleteObservationFold(),
          aggregates: readonly string[] = [],
        ) {
          components.add(owner)
          retained++
          const key = sha256Hex(JSON.stringify([owner, detail.section, detail.parent, detail.key]))
          pending.push({
            key,
            component: owner,
            detail,
            fold,
            aggregates: [
              ...new Set([
                'component/' + owner,
                'rows/' + detail.section,
                'rows/' + JSON.stringify([detail.section, detail.parent]),
                ...aggregates,
              ]),
            ],
          })
          if (pending.length >= 150) {
            await prepared.append(work, pending)
            pending.length = 0
          }
        }
        try {
          const cohortInput: CompleteObservationCohortInput = {
            actor: null,
            query: { from: 0, to: Number.MAX_SAFE_INTEGER, timezone: 'UTC', cohort: 'usage' },
            projectionCohort: true,
            sources: {
              ...createCompleteObservationSources({
                db: snapshot.executor,
                tasks,
                snapshotId: snapshot.snapshotId,
                ...(bootstrap ? {} : { invocationIds: [...invocationIds] }),
              }),
              historical: {
                owners: input.owners(snapshot.executor, bootstrap ? undefined : scope()),
                native,
                task: tasks.projectionGet,
              },
            },
            asOf: snapshot.asOf,
            rows: snapshot.workspace,
            namespace,
            keyOf: sha256Hex,
            signal,
            usageWorkspace: completeUsageWorkspace,
            value: value.value,
            agentName: names.name,
            async retainInvocationInventory(id, inventory) {
              invocationInventories.set(id, inventory)
            },
            async retainDimensionContribution(item) {
              ;(collectingTime ? timeDimensions : dimensionContributions).push(item)
            },
            async retainHistoricalContribution(item) {
              historicalMetadata.set(item.key, item)
              const taskId = item.assigned ? item.task!.id : null
              await retain(
                item.ownerComponent,
                {
                  section: 'cohort-fold',
                  parent: null,
                  key: item.key,
                  taskId,
                  cohortAt: item.cohortAt,
                  document: null,
                  visibility: item.visibility,
                  nativeRecord: item.key.startsWith('record/'),
                  ...(item.scopes ? { scopes: item.scopes } : {}),
                },
                item.fold,
                ['cohort', ...(taskId ? ['task/' + taskId] : [])],
              )
            },
          }
          const build = await buildCompleteObservationCohort(cohortInput)
          await value.flush()
          await names.flush()
          const summaries = new Map<string, CompleteObservationTask>(),
            attemptTasks = new Map<string, string>(),
            callTasks = new Map<string, string>(),
            callRoots = new Map<string, Set<string>>()
          const recordReferences = new Map<string, string[]>(),
            records = new Map<
              string,
              import('@agent-workflow/shared').CompleteHistoricalObservationRecord
            >(),
            allocations = new Map<
              string,
              import('@agent-workflow/shared').CompleteObservationAllocation
            >()
          for await (const row of completeWorkingTraversal<CompleteObservationReportRow>(
            snapshot.workspace,
            build.rowsNamespace,
            signal,
          )) {
            const item = row.document
            if (item.section === 'tasks' && item.parent === null) {
              const task = item.document as CompleteObservationTask
              summaries.set(task.task.id, task)
            }
            if (item.section === 'attempts' && item.parent === null) {
              const attempt = item.document as { id: string; taskId: string }
              attemptTasks.set(attempt.id, attempt.taskId)
            }
            if (item.section === 'invocations' && item.parent === null) {
              const call = item.document as CompleteObservationInvocation
              callTasks.set(call.invocationId, call.taskId)
            }
            if (item.section === 'native-captures' && item.parent === null) {
              const capture = item.document as {
                invocationId: string
                capture: { rootSessionId: string | null }
              }
              if (capture.capture.rootSessionId) {
                const list = callRoots.get(capture.invocationId) ?? new Set<string>()
                list.add(capture.capture.rootSessionId)
                callRoots.set(capture.invocationId, list)
              }
            }
            if (item.section === 'historical-record-references' && item.parent !== null) {
              const ids = recordReferences.get(item.parent) ?? []
              ids.push((item.document as { referenceId: string }).referenceId)
              recordReferences.set(item.parent, ids)
            }
            if (item.section === 'historical-records' && item.parent === null) {
              const record =
                item.document as import('@agent-workflow/shared').CompleteHistoricalObservationRecord
              records.set(JSON.stringify([record.nativeSource, record.recordId]), record)
            }
            if (item.section === 'allocations' && item.parent === null) {
              const allocation =
                item.document as import('@agent-workflow/shared').CompleteObservationAllocation
              allocations.set(
                JSON.stringify([
                  allocation.sourceId,
                  allocation.recordId,
                  allocation.invocation.invocationId,
                ]),
                allocation,
              )
            }
          }
          // Metadata has its own component and includes all original attempts.
          // Accepted identity lookups never read usage, valuations or native files.
          let metadataAfter: string | undefined
          for (;;) {
            const page = await metadataTasks.projectionList({
              from: 0,
              to: Number.MAX_SAFE_INTEGER,
              timezone: 'UTC',
              limit: 200,
              ...(metadataAfter ? { after: metadataAfter } : {}),
            })
            const selectors = await metadataTasks.projectionSelectors(
              page.items.map((task) => task.id),
            )
            for (const task of page.items) {
              const acceptedAttempts = new Set<string>()
              let after: string | undefined
              for (;;) {
                const calls = await snapshot.executor
                  .select({
                    id: observationInvocations.id,
                    attempt: jsonPathText(snapshot.executor, observationInvocations.document, [
                      'nodeRunId',
                    ]),
                  })
                  .from(observationInvocations)
                  .where(
                    and(
                      eq(observationInvocations.taskId, task.id),
                      after === undefined ? undefined : gt(observationInvocations.id, after),
                    ),
                  )
                  .orderBy(asc(observationInvocations.id))
                  .limit(200)
                  .all()
                if (!calls.length) break
                for (const call of calls)
                  if (typeof call.attempt === 'string') acceptedAttempts.add(call.attempt)
                after = calls.at(-1)!.id
              }
              const metadata = await projectionTaskMetadata({
                task,
                tasks: metadataTasks,
                acceptedAttempts,
                rows: snapshot.workspace,
                namespace: namespace + '/metadata/' + sha256Hex(task.id),
                asOf: snapshot.asOf,
                signal,
              })
              await retain(
                component('task-metadata', task.id),
                {
                  section: 'tasks',
                  parent: null,
                  key: task.id,
                  taskId: task.id,
                  cohortAt: task.startedAt,
                  document: metadata.task,
                  timingAttempts: metadata.timingAttempts,
                  ...(selectors.has(task.id) ? { selectors: selectors.get(task.id)! } : {}),
                },
                metadata.fold,
                ['cohort', 'task/' + task.id, 'task-day/' + Math.floor(task.startedAt / 86400000)],
              )
            }
            if (page.nextCursor === null) break
            if (metadataAfter === page.nextCursor)
              throw new Error('Projection metadata EOF did not advance')
            metadataAfter = page.nextCursor
          }
          for (const entry of dimensionContributions) {
            const visibility =
              historicalMetadata.get(entry.identity)?.visibility ??
              (entry.task ? [{ taskId: entry.task.id, ownerUserId: null }] : [])
            const scopes = historicalMetadata.get(entry.identity)?.scopes
            await retain(
              entry.ownerComponent,
              {
                section: dimensionSection[entry.dimension.kind],
                parent: null,
                key: JSON.stringify([entry.dimension.key, entry.identity]),
                taskId: entry.task?.id ?? null,
                cohortAt: entry.cohortAt,
                document: {
                  ...entry.dimension,
                  metrics: { state: 'not-applicable' },
                  taskCount: '0',
                },
                visibility,
                nativeRecord: entry.identity.startsWith('record/'),
                ...(scopes ? { scopes } : {}),
              },
              entry.fold,
              ['dimension/' + entry.dimension.key],
            )
          }
          for await (const row of completeWorkingTraversal<CompleteObservationReportRow>(
            snapshot.workspace,
            build.rowsNamespace,
            signal,
          )) {
            const item = row.document,
              object = item.document as Record<string, unknown> | null
            if (
              [
                'tasks',
                'trends',
                'quality',
                'agents',
                'runtimes',
                'models',
                'purposes',
                'sources',
                'dimension-tasks',
                'quality-tasks',
              ].includes(item.section)
            )
              continue
            const historicalKey =
              item.section === 'historical-records'
                ? 'record/' + item.key
                : item.section === 'historical-executions'
                  ? 'reference/' + item.key
                  : item.parent !== null &&
                      ['historical-record-versions', 'historical-record-references'].includes(
                        item.section,
                      )
                    ? 'record/' + sha256Hex(item.parent)
                    : null
            const historical =
              historicalKey === null ? undefined : historicalMetadata.get(historicalKey)
            let taskId =
              typeof object?.taskId === 'string'
                ? object.taskId
                : historical?.assigned
                  ? historical.task!.id
                  : null
            const nested = [object, object?.invocation, object?.fact].filter(
              (value): value is Record<string, unknown> => !!value && typeof value === 'object',
            )
            const invocationId = nested
              .map((value) => value.invocationId)
              .find((value): value is string => typeof value === 'string')
            let attemptId = nested
              .map((value) => value.nodeRunId)
              .find((value): value is string => typeof value === 'string')
            if (item.section === 'attempts' && typeof object?.id === 'string') attemptId = object.id
            if (item.parent?.startsWith('[')) {
              const parent = JSON.parse(item.parent) as unknown[]
              if (parent[0] === 'attempt' && typeof parent[1] === 'string') attemptId ??= parent[1]
            }
            if (taskId === null && invocationId) taskId = callTasks.get(invocationId) ?? null
            if (taskId === null && attemptId) taskId = attemptTasks.get(attemptId) ?? null
            if (taskId === null && item.parent && summaries.has(item.parent)) taskId = item.parent
            let owner =
              historical?.ownerComponent ??
              (invocationId
                ? component('invocation', invocationId)
                : attemptId
                  ? component('attempt', attemptId)
                  : undefined)
            if (!owner && object?.execution && typeof object.execution === 'object') {
              const execution = object.execution as { sourceKind: string; ownerId: string }
              owner = component(execution.sourceKind, execution.ownerId)
            }
            if (!owner && typeof object?.sessionId === 'string')
              owner = component('root', object.sessionId)
            if (!owner)
              throw new Error(
                'Qualified original row has no execution component: ' +
                  JSON.stringify([item.section, item.parent, item.key]),
              )
            const cohortAt = taskId
              ? (summaries.get(taskId)?.task.startedAt ?? historical?.cohortAt ?? null)
              : (historical?.cohortAt ?? null)
            const bindings: { kind: string; identity: string }[] = []
            const fold =
              item.section === 'invocations' && item.parent === null
                ? completeMetricsFold((item.document as CompleteObservationInvocation).metrics)
                : emptyCompleteObservationFold()
            if (item.section === 'invocations' && item.parent === null) {
              const call = item.document as CompleteObservationInvocation
              const inventory = invocationInventories.get(call.invocationId)
              if (!inventory) throw new Error('Qualified invocation inventory missing')
              Object.assign(fold, { inventory: { tasks: '0', attempts: '0', ...inventory } })
              if (call.agentId) bindings.push({ kind: 'agent', identity: call.agentId })
              if (call.nodeRunId) bindings.push({ kind: 'attempt', identity: call.nodeRunId })
              if (call.authority.kind === 'local' && call.authority.runtime)
                bindings.push({ kind: 'runtime', identity: call.authority.runtime.registrationId })
              if (call.authority.kind === 'crewstation' && call.authority.sourceId)
                bindings.push({
                  kind: 'platform',
                  identity: sha256Hex(
                    JSON.stringify([
                      call.authority.sourceId,
                      call.authority.projectId,
                      call.authority.taskId,
                    ]),
                  ),
                })
              for (const root of callRoots.get(call.invocationId) ?? [])
                bindings.push({ kind: 'root', identity: root })
            }
            await retain(
              owner,
              {
                ...item,
                taskId,
                cohortAt,
                ...(historical
                  ? {
                      nativeRecord: historical.key.startsWith('record/'),
                      visibility: historical.visibility,
                      ...(historical.scopes ? { scopes: historical.scopes } : {}),
                    }
                  : {}),
                ...(bindings.length ? { bindings } : {}),
              },
              fold,
              item.section === 'invocations' && item.parent === null
                ? ['cohort', ...(taskId ? ['task/' + taskId] : [])]
                : [],
            )
          }
          collectingTime = true
          const timed = await buildCompleteObservationUsageWindow(cohortInput, build)
          const nativeDimensions = new Map<string, QualifiedObservationDimensionContribution[]>(),
            unknownDimensions = new Map<string, QualifiedObservationDimensionContribution[]>()
          for (const entry of dimensionContributions)
            if (entry.identity.startsWith('record/')) {
              const entries = nativeDimensions.get(entry.identity) ?? []
              entries.push(entry)
              nativeDimensions.set(entry.identity, entries)
            }
          for (const entry of timeDimensions)
            if (entry.identity.startsWith('record/')) {
              const entries = unknownDimensions.get(entry.identity) ?? []
              entries.push(entry)
              unknownDimensions.set(entry.identity, entries)
            }
          for await (const row of completeWorkingTraversal<CompleteObservationReportRow>(
            snapshot.workspace,
            timed.rowsNamespace,
            signal,
          )) {
            if (row.document.section !== 'time-partitions' || row.document.parent !== null) continue
            const time = row.document
                .document as import('@agent-workflow/shared').CompleteObservationTimePartition,
              taskId = time.task?.id ?? null
            const recordKey = JSON.stringify([time.sourceId, time.recordId]),
              record = records.get(recordKey)
            const allocation =
              time.invocation === null
                ? undefined
                : allocations.get(
                    JSON.stringify([time.sourceId, time.recordId, time.invocation.invocationId]),
                  )
            const references = recordReferences.get(recordKey) ?? []
            const visibility =
              historicalMetadata.get('record/' + sha256Hex(recordKey))?.visibility ??
              (taskId ? [{ taskId, ownerUserId: null }] : [])
            const owner = time.invocation
              ? component('invocation', time.invocation.invocationId)
              : record
                ? component('root', record.sessionId)
                : undefined
            if (!owner) throw new Error('Qualified occurrence has no original execution component')
            const original = completeMetricsFold(time.metrics),
              fold = {
                ...original,
                invocations: '0',
                observedInvocations: '0',
                historicalReferences: '0',
                observedHistoricalReferences: '0',
              }
            const day =
              time.occurrence.occurredAt === null
                ? null
                : Math.floor(time.occurrence.occurredAt / 86400000)
            await retain(
              owner,
              {
                section: 'time-partitions',
                parent: null,
                key: time.identity,
                taskId,
                cohortAt: time.occurrence.occurredAt,
                document: {
                  ...time,
                  referenceIds: references,
                  visibility,
                  model: allocation?.model ?? record?.model ?? null,
                  candidateCount: record?.candidateCount ?? '0',
                  dimensions: nativeDimensions.get('record/' + sha256Hex(recordKey)) ?? [],
                  unknownDimensions: unknownDimensions.get('record/' + sha256Hex(recordKey)) ?? [],
                },
                visibility,
              },
              fold,
              [
                'occurrence',
                'occurrence-day/' + (day ?? 'unknown'),
                'occurrence-scope-day/' + JSON.stringify([taskId, owner, day]),
              ],
            )
          }
          if (bootstrap && retained === 0n)
            await retain(
              work.components[0]!,
              {
                section: 'cohort-fold',
                parent: null,
                key: 'empty-population',
                taskId: null,
                cohortAt: null,
                document: null,
              },
              emptyCompleteObservationFold(),
              ['cohort'],
            )
          if (pending.length) await prepared.append(work, pending)
          await renewal
          if (leaseFailure) throw leaseFailure
          const retryNative = [...historicalMetadata.values()].some((entry) =>
            entry.fold.gaps.some((gap) => gap === 'historical-native-unavailable'),
          )
          return prepared.seal(
            { ...work, retryNative },
            {
              generation: snapshot.generationId,
              snapshotId: snapshot.snapshotId,
              asOf: snapshot.asOf,
              baseRevision,
              preparationToken: work.preparationToken!,
            },
            [...components],
          )
        } finally {
          native.close()
        }
      }, signal)
    } catch (error) {
      await prepared.releaseFailed(work, error)
      throw error
    } finally {
      clearInterval(timer)
      await renewal
    }
  }
}
