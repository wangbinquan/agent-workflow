import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
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
  ObservationReportWorkerStart,
} from './observationReportProtocol'

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ObservationReportWorkerInput>) => void) | null
  postMessage(value: ObservationReportWorkerEvent): void
  close(): void
}
const stop = new AbortController()
const channel = observationReportChannel((event) => scope.postMessage(event), stop.signal)
let started = false
async function run(input: ObservationReportWorkerStart) {
  const build = (snapshot: OriginalReportSnapshot) =>
    composeCompleteObservationSnapshot({
      snapshot,
      tasks: createCompleteTaskObservationFacts(snapshot.executor, input.report.request.taskId),
      report: input.report,
      spool: completeObservationFileSpool(input.appHome),
      signal: stop.signal,
    })
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
    scope.postMessage({ kind: 'result', result })
  } catch (error) {
    scope.postMessage({
      kind: 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    channel.close()
    scope.close()
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
    void run(input)
  } catch (error) {
    stop.abort(error)
  }
}
