import type { ObservationSpanDetail, ObservationPhase } from '@agent-workflow/shared'
import { observationWindowCellKey } from '../domain/observationWindowCell'
import { incrementalObservationPreparationSpool } from '../infrastructure/incrementalObservationPreparationSpool'
import type {
  CompleteHistoricalObservationRecord,
  CompleteObservationAllocation,
  CompleteObservationTimePartition,
} from '@agent-workflow/shared'
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
import {
  emptyCompleteObservationFold,
  mergeCompleteObservationFold,
} from '../domain/completeObservationMetrics'
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
  HistoricalRecordScopeGroup,
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
    const work = originalWork,
      spool = incrementalObservationPreparationSpool(signal)
    let claimed: IncrementalObservationWork | undefined
    let leaseFailure: unknown,
      renewal = Promise.resolve()
    let timer: ReturnType<typeof setInterval> | undefined
    try {
      const result = await input.snapshot.run(async (snapshot) => {
        const baseRevision =
          (
            await snapshot.executor
              .select({ revision: observationProjectionHeads.revision })
              .from(observationProjectionHeads)
              .where(eq(observationProjectionHeads.id, 'incremental-20261012-v1'))
              .get()
          )?.revision ?? '0'
        if (work.source === 'original-bootstrap-finish')
          return spool.seal(
            work,
            {
              generation: snapshot.generationId,
              snapshotId: snapshot.snapshotId,
              asOf: snapshot.asOf,
              baseRevision,
            },
            work.components,
          )
        if (
          work.source === 'original-bootstrap-component' ||
          work.source === 'original-bootstrap-upgrade'
        ) {
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
          // Replay only already qualified physical candidate/model evidence.
          // Older protocols have no such proof and must reuse original sources.
          if (
            work.source === 'original-bootstrap-upgrade' ||
            qualified === work.components.length
          ) {
            const retainedNamespace = 'projection/' + work.id + '/retained-index-atoms',
              requiredGroups = new Set<string>()
            let proved = true
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
                const retained = rows.map((row) => ({
                  key: row.key,
                  document: JSON.parse(row.document) as QualifiedObservationContribution,
                }))
                for (const { document: row } of retained) {
                  if (
                    row.detail.nativeRecord ||
                    row.detail.key.startsWith('reference/') ||
                    row.detail.section === 'historical-executions' ||
                    row.detail.section === 'historical-record-references'
                  ) {
                    if (
                      (row.detail.nativeRecord ||
                        row.detail.section === 'historical-record-references') &&
                      (row.detail.scopes !== undefined || row.detail.visibility !== undefined)
                    )
                      proved = false
                    if (row.detail.historicalRecordScopes === undefined) proved = false
                    else
                      for (const key of row.detail.historicalRecordScopes) requiredGroups.add(key)
                  }
                }
                await snapshot.workspace.insert(retainedNamespace, retained)
                after = rows.at(-1)!.key
              }
            }
            const foundGroups = new Set<string>()
            for (let at = 0, keys = [...requiredGroups]; at < keys.length; at += 200) {
              const rows = await snapshot.executor
                .select({ document: observationProjectionCurrent.document })
                .from(observationProjectionCurrent)
                .where(
                  and(
                    eq(observationProjectionCurrent.kind, 'contribution'),
                    eq(observationProjectionCurrent.section, 'cohort-fold'),
                    eq(observationProjectionCurrent.parent, 'native-scope-groups'),
                    inArray(observationProjectionCurrent.originalKey, keys.slice(at, at + 200)),
                  ),
                )
                .all()
              for (const row of rows) {
                const value = JSON.parse(row.document) as QualifiedObservationContribution,
                  group = value.detail.document as Partial<HistoricalRecordScopeGroup> | null
                if (
                  group?.scopes?.length &&
                  typeof group.observed === 'boolean' &&
                  'model' in group &&
                  group.numeric &&
                  typeof group.numeric.records === 'string'
                )
                  foundGroups.add(value.detail.key)
              }
            }
            proved &&= foundGroups.size === requiredGroups.size
            if (proved) {
              for await (const row of completeWorkingTraversal<QualifiedObservationContribution>(
                snapshot.workspace,
                retainedNamespace,
                signal,
              ))
                await spool.append(work, [row.document])
              return spool.seal(
                work,
                {
                  generation: snapshot.generationId,
                  snapshotId: snapshot.snapshotId,
                  asOf: snapshot.asOf,
                  baseRevision,
                },
                work.components,
              )
            }
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
          if (roots.size) {
            const discovery = input.native()
            try {
              const related = await discovery.connectedRoots?.([...roots])
              if (related) for (const root of related) roots.add(root)
            } finally {
              discovery.close()
            }
          }
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
          // Native candidate payload and visibility are shared physical group
          // evidence. A public reference keeps only its own original execution.
          if (
            detail.historicalRecordScopes?.length &&
            (detail.nativeRecord || detail.section === 'historical-record-references')
          ) {
            const { scopes: _scopes, visibility: _visibility, ...compact } = detail
            detail = compact
            if (
              detail.section === 'time-partitions' &&
              detail.document &&
              typeof detail.document === 'object'
            ) {
              const {
                scopes: _documentScopes,
                visibility: _documentVisibility,
                ...document
              } = detail.document as Record<string, unknown>
              detail = { ...detail, document }
            }
          }
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
            await snapshot.workspace.insert(
              namespace + '/qualified-contributions',
              pending.map((row) => ({ key: row.key, document: row })),
            )
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
            records = new Map<string, CompleteHistoricalObservationRecord>(),
            allocations = new Map<string, CompleteObservationAllocation>()
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
              const record = item.document as CompleteHistoricalObservationRecord
              records.set(JSON.stringify([record.nativeSource, record.recordId]), record)
            }
            if (item.section === 'allocations' && item.parent === null) {
              const allocation = item.document as CompleteObservationAllocation
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
          // Candidate evidence is stored once per physical source/group; references
          // retain only group identities. A root shared by N references never copies
          // an N-owner execution payload N times. The complete relation has no cap.
          const referenceScopes = new Map<string, Set<string>>(),
            recordScopes = new Map<string, string>(),
            physicalGroups = new Map<string, { owner: string; group: HistoricalRecordScopeGroup }>()
          for (const [key, record] of records) {
            const scopes = historicalMetadata.get('record/' + sha256Hex(key))?.scopes
            if (!scopes?.length) continue
            const owner = component('root', record.sessionId),
              identity = sha256Hex(
                JSON.stringify([
                  owner,
                  scopes.map((scope) => scope.referenceId),
                  record.includedInTotals,
                  record.model,
                ]),
              ),
              value = physicalGroups.get(identity) ?? {
                owner,
                group: {
                  scopes,
                  observed: record.includedInTotals,
                  model: record.model,
                  numeric: emptyCompleteObservationFold(),
                },
              }
            // The original allocator puts a physical number on an execution only
            // when the candidate set contains exactly one owner.
            if (scopes.length === 1)
              mergeCompleteObservationFold(value.group.numeric, {
                ...completeMetricsFold(record.metrics),
                invocations: '0',
                observedInvocations: '0',
                historicalReferences: '0',
                observedHistoricalReferences: '0',
              })
            physicalGroups.set(identity, value)
            recordScopes.set('record/' + sha256Hex(key), identity)
            for (const reference of recordReferences.get(key) ?? []) {
              const groups = referenceScopes.get(reference) ?? new Set<string>()
              groups.add(identity)
              referenceScopes.set(reference, groups)
            }
          }
          for (const [identity, { owner, group }] of physicalGroups)
            await retain(owner, {
              section: 'cohort-fold',
              parent: 'native-scope-groups',
              key: identity,
              taskId: null,
              cohortAt: null,
              document: group,
            })
          for (const [key, original] of historicalMetadata) {
            const groups =
              key.startsWith('reference/') && original.scopes?.length === 1
                ? [...(referenceScopes.get(original.scopes[0]!.referenceId) ?? [])]
                : recordScopes.has(key)
                  ? [recordScopes.get(key)!]
                  : undefined
            const item =
              groups === undefined ? original : { ...original, historicalRecordScopes: groups }
            historicalMetadata.set(key, item)
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
                ...(item.historicalRecordScopes
                  ? { historicalRecordScopes: item.historicalRecordScopes }
                  : {}),
              },
              item.fold,
              ['cohort', ...(taskId ? ['task/' + taskId] : [])],
            )
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
              let humanWaitingSince: number | null = null
              if (metadataTasks.phasePage) {
                let after: string | undefined
                for (;;) {
                  const phases = await metadataTasks.phasePage(task.id, {
                    limit: 200,
                    ...(after ? { after } : {}),
                  })
                  for (const phase of phases.items) {
                    if (phase.status === 'active' && phase.startedAt !== null)
                      humanWaitingSince =
                        humanWaitingSince === null
                          ? phase.startedAt
                          : Math.min(humanWaitingSince, phase.startedAt)
                    for (const parent of [null, task.id])
                      await retain(component('task-metadata', task.id), {
                        section: 'phases',
                        parent,
                        key: phase.id,
                        taskId: task.id,
                        cohortAt: task.startedAt,
                        document: phase,
                      })
                  }
                  if (phases.nextCursor === null) break
                  if (phases.nextCursor === after)
                    throw new Error('Original lifecycle phase EOF did not advance')
                  after = phases.nextCursor
                }
              }
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
                  humanWaitingSince,
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
                ...(historicalMetadata.get(entry.identity)?.historicalRecordScopes
                  ? {
                      historicalRecordScopes: historicalMetadata.get(entry.identity)!
                        .historicalRecordScopes,
                    }
                  : {}),
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
            if (item.section === 'span-facts' && item.parent === null && taskId) {
              const span = item.document as ObservationSpanDetail,
                state = span.fact.state,
                phase: ObservationPhase = {
                  id: 'span/' + span.fact.spanKey,
                  taskId,
                  nodeRunId: attemptId ?? null,
                  kind: span.fact.scope.kind,
                  basis: 'original-span',
                  startedAt: state.startedAt,
                  endedAt: state.endedAt,
                  status:
                    state.endedAt !== null
                      ? 'closed'
                      : state.status === 'open' && snapshot.asOf - span.fact.capturedAt <= 60000
                        ? 'active'
                        : 'unknown',
                  evidenceId: span.fact.spanKey,
                  label: span.fact.label,
                }
              for (const parent of [null, taskId])
                await retain(owner, {
                  section: 'phases',
                  parent,
                  key: phase.id,
                  taskId,
                  cohortAt,
                  document: phase,
                })
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
                      ...(historical.historicalRecordScopes
                        ? { historicalRecordScopes: historical.historicalRecordScopes }
                        : {}),
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
            const time = row.document.document as CompleteObservationTimePartition,
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
            const originalMetadata = historicalMetadata.get('record/' + sha256Hex(recordKey)),
              originalScopes = originalMetadata?.scopes
            const scopeEvidence =
              time.invocation === null
                ? {
                    nativeRecord: true,
                    ...(originalScopes ? { scopes: originalScopes } : {}),
                    ...(originalMetadata?.historicalRecordScopes
                      ? { historicalRecordScopes: originalMetadata.historicalRecordScopes }
                      : {}),
                  }
                : {}
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
                ...scopeEvidence,
                document: {
                  ...time,
                  ...scopeEvidence,
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
                ...((cell) => (cell ? [cell] : []))(
                  observationWindowCellKey(owner, {
                    ...time,
                    ...scopeEvidence,
                    referenceIds: references,
                    model: allocation?.model ?? record?.model ?? null,
                    candidateCount: record?.candidateCount ?? '0',
                    visibility,
                    dimensions: nativeDimensions.get('record/' + sha256Hex(recordKey)) ?? [],
                  }),
                ),
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
          if (pending.length)
            await snapshot.workspace.insert(
              namespace + '/qualified-contributions',
              pending.map((row) => ({ key: row.key, document: row })),
            )
          const retryNative = [...historicalMetadata.values()].some((entry) =>
            entry.fold.gaps.some((gap) => gap === 'historical-native-unavailable'),
          )
          if (retryNative && work.source === 'original-bootstrap-upgrade')
            throw new Error('Original candidate-set index upgrade is waiting for native EOF')
          if (retryNative) {
            // An unreadable original root has no deletion EOF. Hold the entire
            // connected numeric bundle until the allocator can resolve overlap
            // again; metadata may still advance. Never add new accepted values
            // to old native values whose overlap has become unverifiable.
            const previousNamespace = namespace + '/previous-contributions'
            let knownPrevious = false
            for (let at = 0, selected = [...components]; at < selected.length; at += 200) {
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
                      inArray(observationProjectionCurrent.component, selected.slice(at, at + 200)),
                      after === undefined ? undefined : gt(observationProjectionCurrent.key, after),
                    ),
                  )
                  .orderBy(asc(observationProjectionCurrent.key))
                  .limit(200)
                  .all()
                if (!rows.length) break
                const retained = rows.map((row) => ({
                  key: row.key,
                  document: JSON.parse(row.document) as QualifiedObservationContribution,
                }))
                if (retained.some((row) => BigInt(row.document.fold.records) > 0n))
                  knownPrevious = true
                await snapshot.workspace.insert(previousNamespace, retained)
                after = rows.at(-1)!.key
              }
            }
            if (knownPrevious) {
              const metadataNamespace = namespace + '/current-metadata'
              for await (const row of completeWorkingTraversal<QualifiedObservationContribution>(
                snapshot.workspace,
                namespace + '/qualified-contributions',
                signal,
              ))
                if (row.document.detail.section === 'tasks')
                  await snapshot.workspace.insert(metadataNamespace, [row])
              await snapshot.workspace.clear(namespace + '/qualified-contributions')
              for await (const row of completeWorkingTraversal<QualifiedObservationContribution>(
                snapshot.workspace,
                previousNamespace,
                signal,
              ))
                if (row.document.detail.section !== 'tasks')
                  await snapshot.workspace.insert(namespace + '/qualified-contributions', [row])
              for await (const row of completeWorkingTraversal<QualifiedObservationContribution>(
                snapshot.workspace,
                metadataNamespace,
                signal,
              ))
                await snapshot.workspace.insert(namespace + '/qualified-contributions', [row])
              // A memory/MCP/intent-only bundle may have no Task owner. It still
              // needs a cohort gap while its previous numeric facts are held.
              for (const taskId of numericTaskIds.size ? numericTaskIds : [null]) {
                const owner = component('root', [...roots][0] ?? work.id),
                  key = sha256Hex(JSON.stringify(['native-retry-gap', owner, taskId]))
                const gap: QualifiedObservationContribution = {
                  key,
                  component: owner,
                  aggregates: taskId === null ? ['cohort'] : ['cohort', 'task/' + taskId],
                  fold: {
                    ...emptyCompleteObservationFold(),
                    gaps: ['historical-native-unavailable'],
                  },
                  detail: {
                    section: 'cohort-fold',
                    parent: null,
                    key: 'native-retry-gap/' + (taskId ?? 'standalone'),
                    taskId,
                    cohortAt: null,
                    document: null,
                  },
                }
                await snapshot.workspace.upsert(namespace + '/qualified-contributions', [
                  { key, document: gap },
                ])
              }
            }
          }
          for await (const row of completeWorkingTraversal<QualifiedObservationContribution>(
            snapshot.workspace,
            namespace + '/qualified-contributions',
            signal,
          ))
            spool.append(work, [row.document])
          return spool.seal(
            { ...work, retryNative },
            {
              generation: snapshot.generationId,
              snapshotId: snapshot.snapshotId,
              asOf: snapshot.asOf,
              baseRevision,
            },
            [...components],
          )
        } finally {
          native.close()
        }
      }, signal)
      signal.throwIfAborted()
      claimed = await prepared.begin(result.work)
      const current = claimed
      timer = setInterval(() => {
        renewal = renewal
          .then(() => prepared.renew(current))
          .catch((error: unknown) => {
            leaseFailure = error
          })
      }, 15000)
      const packet: QualifiedObservationContribution[] = []
      for await (const row of spool.rows()) {
        packet.push(row)
        if (packet.length >= 150) {
          await prepared.append(current, packet)
          packet.length = 0
        }
      }
      if (packet.length) await prepared.append(current, packet)
      await renewal
      if (leaseFailure) throw leaseFailure
      signal.throwIfAborted()
      return await prepared.seal(
        current,
        { ...result.identity, preparationToken: current.preparationToken! },
        result.components,
      )
    } catch (error) {
      if (claimed) await prepared.releaseFailed(claimed, error)
      throw error
    } finally {
      if (timer) clearInterval(timer)
      await renewal
      spool.close()
    }
  }
}
