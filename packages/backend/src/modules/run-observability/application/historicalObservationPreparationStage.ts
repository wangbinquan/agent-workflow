import type { HistoricalObservationExecution, ObservationTaskFacts } from '@agent-workflow/shared'
import type { CompleteObservationCohortInput } from '../ports/completeObservationReport'
import type { CompleteWorkingRows } from '../ports/completeWorkingRows'
import type {
  HistoricalObservationPreparationExecution,
  HistoricalObservationStage,
} from '../ports/historicalObservationPreparation'
import type { HistoricalWorkingExecution } from '../ports/historicalObservationWorking'
import { completeWorkingCache } from './completeWorkingCache'
import { completeWorkingPages } from './completeWorkingTraversal'

/** Names are recorded in the TEMP store; the memory cache remains bounded for arbitrary populations. */
export function trackHistoricalPreparationGroups(input: {
  readonly rows: CompleteWorkingRows
  readonly namespace: string
  readonly signal?: AbortSignal
}) {
  const namespace = input.namespace + '/historical'
  const registry = completeWorkingCache<boolean>(
    input.rows,
    namespace + '/preparation-groups',
    input.signal,
  )
  const record = async (name: string) => {
    if (!name.startsWith(namespace + '/')) return
    const relative = name.slice(namespace.length)
    if ((await registry.get(relative)) !== true) await registry.put(relative, true)
  }
  const rows: CompleteWorkingRows = {
    get<T>(name: string, key: string) {
      return input.rows.get<T>(name, key)
    },
    getMany<T>(name: string, keys: readonly string[]) {
      return input.rows.getMany<T>(name, keys)
    },
    page<T>(name: string, after: string | null, size?: number) {
      return input.rows.page<T>(name, after, size)
    },
    async insert(name, items) {
      await record(name)
      await input.rows.insert(name, items)
    },
    async put(name, row) {
      await record(name)
      await input.rows.put(name, row)
    },
    async upsert(name, items) {
      await record(name)
      await input.rows.upsert(name, items)
    },
    async clear(name) {
      await record(name)
      await input.rows.clear(name)
    },
  }
  return { rows, flush: () => registry.flush() }
}

/** Original membership is evaluated against this report's real Task population and exact time range. */
export async function qualifyPreparedHistoricalExecutions(
  input: CompleteObservationCohortInput,
  stage: HistoricalObservationStage,
  membership: (
    input: CompleteObservationCohortInput,
    execution: HistoricalObservationExecution,
    parent: ObservationTaskFacts | null,
    taskSelected: boolean,
  ) => HistoricalWorkingExecution,
) {
  for await (const page of completeWorkingPages<HistoricalObservationPreparationExecution>(
    input.rows,
    stage.executionsNamespace,
    input.signal,
  )) {
    const ids = [
      ...new Set(
        page.flatMap((row) =>
          row.document.execution.parentTaskId === null ? [] : [row.document.execution.parentTaskId],
        ),
      ),
    ]
    const selected = await input.rows.getMany(input.namespace + '/original-tasks', ids)
    await input.rows.upsert(
      stage.executionsNamespace,
      page.map((row) => {
        const { execution, parentTask } = row.document
        return {
          key: row.key,
          document: membership(
            input,
            execution,
            parentTask,
            execution.parentTaskId !== null && selected.has(execution.parentTaskId),
          ),
        }
      }),
    )
  }
}
