import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import type { CompleteTaskObservationFactsQuery } from '@/modules/task-execution/public/queries'
import type { HistoricalTaskObservationQuery } from '@/modules/task-execution/public/queries'
import { createHistoricalTaskObservationFacts } from '@/modules/task-execution/composition/historicalObservationFacts'
import type { HistoricalMemoryObservationQuery } from '@/modules/memory/public/queries'
import { createHistoricalMemoryObservationFacts } from '@/modules/memory/composition/historicalObservationFacts'
import type { HistoricalIntentObservationQuery } from '@/modules/intent/public/queries'
import { createHistoricalIntentObservationFacts } from '@/modules/intent/composition/historicalObservationFacts'
import type { HistoricalMcpObservationQuery } from '@/modules/resource-catalog/public/queries'
import { createHistoricalMcpObservationFacts } from '@/modules/resource-catalog/composition/historicalObservationFacts'
import type { HistoricalNativeUsageQuery } from '@/modules/runtime-management/public/queries'
import { createHistoricalNativeUsageQuery } from '@/modules/runtime-management/composition/historicalNativeUsage'
import { prepareObservationNativeHistory } from '@/modules/task-execution/composition/observationNativeHistory'
import { composeCompleteObservationSnapshot } from '@/modules/run-observability/composition/completeObservationSnapshot'
import { completeObservationFileSpool } from '@/modules/run-observability/composition/completeObservationSpool'
import { originalSqliteFileReportSnapshot } from '../persistence/reportSqliteSnapshot'
import { reportReadonlyChannelClient } from '../persistence/reportReadonlyChannelClient'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { observationReportChannel } from './observationReportChannel'
import type { OriginalReportSnapshot } from '../persistence/reportSnapshotTypes'
import type {
  ObservationReportWorkerInput,
  ObservationReportWorkerEvent,
  OriginalObservationWorkerStart,
  OriginalObservationWorkerResult,
} from './observationReportProtocol'

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ObservationReportWorkerInput>) => void) | null
  postMessage(value: ObservationReportWorkerEvent): void
}
const stop = new AbortController()
const channel = observationReportChannel((event) => scope.postMessage(event), stop.signal)
let started = false
async function run(input: OriginalObservationWorkerStart) {
  const build = async (
    snapshot: OriginalReportSnapshot,
  ): Promise<OriginalObservationWorkerResult> => {
    if (input.kind === 'native-history')
      return {
        kind: 'native-history-result',
        result: await prepareObservationNativeHistory(snapshot.executor, input.value, snapshot),
      }
    const tasks: CompleteTaskObservationFactsQuery = createCompleteTaskObservationFacts(
      snapshot.executor,
      input.report.request.taskId,
    )
    const historicalTasks: HistoricalTaskObservationQuery = createHistoricalTaskObservationFacts(
      snapshot.executor,
    )
    const memory: HistoricalMemoryObservationQuery = createHistoricalMemoryObservationFacts(
      snapshot.executor,
    )
    const intent: HistoricalIntentObservationQuery = createHistoricalIntentObservationFacts(
      snapshot.executor,
    )
    const mcp: HistoricalMcpObservationQuery = createHistoricalMcpObservationFacts(
      snapshot.executor,
    )
    const native: HistoricalNativeUsageQuery = createHistoricalNativeUsageQuery(process.env)
    return {
      kind: 'result',
      result: await composeCompleteObservationSnapshot({
        snapshot,
        tasks,
        historical: {
          owners: [
            { kind: 'task', query: historicalTasks },
            { kind: 'memory-distill', query: memory },
            { kind: 'intent-turn', query: intent },
            { kind: 'mcp-runtime-test', query: mcp },
          ],
          native,
          task: (id) => tasks.get(input.report.request.actor, id),
        },
        report: input.report,
        spool: completeObservationFileSpool(input.appHome),
        signal: stop.signal,
      }),
    }
  }
  try {
    stop.signal.throwIfAborted()
    selectDatabaseSchemaProvider(input.source.kind === 'original-channel' ? 'postgresql' : 'sqlite')
    const result =
      input.source.kind === 'sqlite-file'
        ? await originalSqliteFileReportSnapshot(input.source).run(build, stop.signal)
        : await build({
            executor: reportReadonlyChannelClient(channel.read),
            workspace: channel.workspace,
            snapshotId: input.source.snapshotId,
            generationId: input.source.generationId,
            asOf: input.source.asOf,
          })
    scope.postMessage(result)
  } catch (error) {
    scope.postMessage({
      kind: 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    channel.close()
    // Bun exits naturally after the original channel closes and its message keepalive is released.
    scope.onmessage = null
  }
}
scope.onmessage = (event) => {
  try {
    const input = event.data
    if (input.kind === 'response') {
      channel.receive(input)
      return
    }
    if (input.kind === 'cancel') {
      stop.abort(new Error(input.reason))
      return
    }
    if (started) {
      stop.abort(new Error('Original report Worker already started'))
      return
    }
    started = true
    void run(input).catch((error) => {
      stop.abort(error)
      try {
        scope.postMessage({
          kind: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
        scope.onmessage = null
      } catch {
        // If the channel already closed, the host's close handler rejects the pending build.
      }
    })
  } catch (error) {
    stop.abort(error)
  }
}
