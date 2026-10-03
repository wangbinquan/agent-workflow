import type { OriginalReportReadChannel } from '../persistence/reportSnapshotTypes'
import type { ReportWorkspace, ReportWorkingPage } from '../persistence/reportWorkspace'
import type {
  ObservationReportRequest,
  ObservationReportWorkerEvent,
  ObservationReportWorkerInput,
} from './observationReportProtocol'

/** Worker-side requests keep SQL execution and TEMP ownership on the original reserved channel. */
export function observationReportChannel(
  post: (event: ObservationReportWorkerEvent) => void,
  signal: AbortSignal,
) {
  let sequence = 0n
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  function request<T>(input: ObservationReportRequest): Promise<T> {
    signal.throwIfAborted()
    const id = String(++sequence)
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (value) => resolve(value as T), reject })
      post({ kind: 'request', id, request: input })
    })
  }
  const cancel = () => {
    for (const value of pending.values())
      value.reject(new Error('Original report channel cancelled'))
    pending.clear()
  }
  signal.addEventListener('abort', cancel, { once: true })
  return {
    read: {
      objects: (statement, parameters) =>
        request({ kind: 'read', method: 'objects', statement, parameters }),
      values: (statement, parameters) =>
        request({ kind: 'read', method: 'values', statement, parameters }),
    } satisfies OriginalReportReadChannel,
    workspace: {
      insert: (namespace, rows) =>
        request<void>({ kind: 'write-working', method: 'insert', namespace, rows }),
      upsert: (namespace, rows) =>
        request<void>({ kind: 'write-working', method: 'upsert', namespace, rows }),
      put: (namespace, row) =>
        request<void>({ kind: 'write-working', method: 'upsert', namespace, rows: [row] }),
      get: <T>(namespace: string, key: string) =>
        request<T | undefined>({ kind: 'get-working', namespace, key }),
      page: <T>(namespace: string, after: string | null, size?: number) =>
        request<ReportWorkingPage<T>>({ kind: 'page-working', namespace, after, size }),
      clear: (namespace) => request<void>({ kind: 'clear-working', namespace }),
    } satisfies ReportWorkspace,
    receive(event: Extract<ObservationReportWorkerInput, { kind: 'response' }>) {
      const value = pending.get(event.id)
      if (!value) throw new Error('Original report channel response identity changed')
      pending.delete(event.id)
      if (event.ok) value.resolve(event.value)
      else value.reject(new Error(event.error))
    },
    close() {
      signal.removeEventListener('abort', cancel)
      cancel()
    },
  }
}
