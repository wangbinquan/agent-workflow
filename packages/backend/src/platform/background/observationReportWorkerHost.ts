import type { CompleteObservationBuildResult } from '@/modules/run-observability/public/participants'
import type { OriginalReportSnapshot } from '../persistence/reportSnapshotTypes'
import type {
  ObservationReportRequest,
  ObservationReportWorkerEvent,
  ObservationReportWorkerStart,
} from './observationReportProtocol'

declare const AW_COMPILED_BUILD: boolean | undefined
const entry =
  typeof AW_COMPILED_BUILD === 'boolean' && AW_COMPILED_BUILD
    ? './platform/background/observationReportWorker.ts'
    : new URL('./observationReportWorker.ts', import.meta.url).href
async function execute(snapshot: OriginalReportSnapshot, request: ObservationReportRequest) {
  switch (request.kind) {
    case 'read': {
      if (!snapshot.readChannel) throw new Error('Original report reader channel missing')
      return snapshot.readChannel[request.method](request.statement, request.parameters)
    }
    case 'write-working':
      return snapshot.workspace[request.method](request.namespace, request.rows)
    case 'get-working':
      return snapshot.workspace.get(request.namespace, request.key)
    case 'page-working':
      return snapshot.workspace.page(request.namespace, request.after, request.size)
    case 'clear-working':
      return snapshot.workspace.clear(request.namespace)
  }
}
/** No pool/URL crosses IPC. In-flight native reads finish before the original reservation is released. */
export async function runObservationReportWorker(
  input: ObservationReportWorkerStart,
  signal: AbortSignal,
  snapshot?: OriginalReportSnapshot,
): Promise<CompleteObservationBuildResult> {
  signal.throwIfAborted()
  const worker = new Worker(entry)
  const pending = new Set<Promise<void>>()
  let accepting = true,
    completed = false,
    workerError: Error | undefined
  const cancel = () =>
    worker.postMessage({ kind: 'cancel', reason: 'Original report build cancelled' })
  try {
    return await new Promise<CompleteObservationBuildResult>((resolve, reject) => {
      const finish = (result: CompleteObservationBuildResult | Error) => {
        if (completed) return
        accepting = false
        completed = true
        void Promise.allSettled([...pending])
          .then(() => {
            if (signal.aborted) reject(signal.reason)
            else if (result instanceof Error) reject(result)
            else resolve(result)
          })
          .catch(reject)
      }
      worker.onmessage = (event: MessageEvent<ObservationReportWorkerEvent>) => {
        const message = event.data
        if (message.kind === 'result') {
          finish(message.result)
          return
        }
        if (message.kind === 'failed') {
          finish(new Error(message.error))
          return
        }
        if (!accepting || !snapshot) {
          cancel()
          return
        }
        const work = (async () => {
          try {
            signal.throwIfAborted()
            const value = await execute(snapshot, message.request)
            if (accepting) worker.postMessage({ kind: 'response', id: message.id, ok: true, value })
          } catch (error) {
            if (accepting)
              worker.postMessage({
                kind: 'response',
                id: message.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              })
          }
        })()
        pending.add(work)
        void work.finally(() => pending.delete(work)).catch(() => {})
      }
      worker.onerror = (event) => {
        event.preventDefault()
        workerError = new Error(event.message || 'Original report Worker failed')
        cancel()
      }
      worker.addEventListener('close', () => {
        if (!completed)
          finish(
            workerError ?? new Error('Original report Worker exited without a complete result'),
          )
      })
      signal.addEventListener('abort', cancel, { once: true })
      worker.postMessage(input)
      if (signal.aborted) cancel()
    })
  } finally {
    accepting = false
    signal.removeEventListener('abort', cancel)
    await Promise.allSettled([...pending])
    // A result/failure is emitted after SQLite finally closes its original file channel.
    worker.terminate()
  }
}
