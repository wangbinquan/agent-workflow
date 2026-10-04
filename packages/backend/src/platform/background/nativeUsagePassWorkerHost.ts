import type {
  NativeUsagePassIdentity,
  NativeUsagePassPage,
} from '@/modules/runtime-management/public/participants'
import type {
  NativeUsagePassRequest,
  NativeUsagePassWorkerEvent,
  NativeUsagePassWorkerResult,
  NativeUsagePassWorkerStart,
} from './nativeUsagePassProtocol'

declare const AW_COMPILED_BUILD: boolean | undefined
const entry =
  typeof AW_COMPILED_BUILD === 'boolean' && AW_COMPILED_BUILD
    ? './platform/background/nativeUsagePassWorker.ts'
    : new URL('./nativeUsagePassWorker.ts', import.meta.url).href
export interface NativeUsagePassWorkerReader {
  readonly identity: NativeUsagePassIdentity
  readonly initialCursor: string
  readonly rootCreatedAt: number | null
  next(cursor: string): Promise<NativeUsagePassPage>
  acknowledge(ordinal: string, payloadDigest: string): Promise<void>
  close(): Promise<void>
}

/** Only one native packet crosses IPC at a time; raw SQLite work stays off the daemon thread. */
export async function openNativeUsagePassWorker(
  input: NativeUsagePassWorkerStart,
  signal: AbortSignal,
): Promise<NativeUsagePassWorkerReader> {
  signal.throwIfAborted()
  const worker = new Worker(entry)
  let exited!: () => void
  const exit = new Promise<void>((resolve) => {
    exited = resolve
  })
  let requestId = 0n,
    closed = false,
    closePromise: Promise<void> | undefined,
    active: Promise<NativeUsagePassWorkerResult> | undefined,
    pending:
      | {
          id: string
          resolve: (value: NativeUsagePassWorkerResult) => void
          reject: (error: unknown) => void
        }
      | undefined
  const stop = (reason: unknown) => {
    if (closed) return
    closed = true
    signal.removeEventListener('abort', cancel)
    const waiting = pending
    pending = undefined
    waiting?.reject(reason)
    worker.terminate()
  }
  const cancel = () => stop(signal.reason ?? new Error('Native owner pass cancelled'))
  worker.onmessage = (event: MessageEvent<NativeUsagePassWorkerEvent>) => {
    const message = event.data,
      waiting = pending
    if (!waiting || message.id !== waiting.id) {
      stop(new Error('Native worker reply changed request'))
      return
    }
    pending = undefined
    if (message.ok) waiting.resolve(message.result)
    else {
      waiting.reject(new Error(message.error))
      stop(new Error(message.error))
    }
  }
  worker.onerror = (event) => {
    event.preventDefault()
    stop(new Error(event.message || 'Native pass worker failed'))
  }
  worker.addEventListener('close', () => {
    exited()
    stop(new Error('Native pass worker exited before owner ACK'))
  })
  signal.addEventListener('abort', cancel, { once: true })
  const request = (value: NativeUsagePassRequest): Promise<NativeUsagePassWorkerResult> => {
    if (closed) return Promise.reject(new Error('Native owner pass closed'))
    if (pending) return Promise.reject(new Error('Native owner request awaits reply'))
    active = new Promise((resolve, reject) => {
      const id = (++requestId).toString()
      pending = { id, resolve, reject }
      try {
        worker.postMessage({ id, request: value })
      } catch (error) {
        stop(error)
      }
    })
    return active
  }
  try {
    if (signal.aborted) cancel()
    const opened = await request({ kind: 'open', input })
    if (opened.kind !== 'opened') throw new Error('Native worker did not open original snapshot')
    return {
      identity: opened.identity,
      initialCursor: opened.initialCursor,
      rootCreatedAt: opened.rootCreatedAt,
      async next(cursor) {
        try {
          const result = await request({ kind: 'next', cursor })
          if (result.kind !== 'page') throw new Error('Native worker did not return frozen page')
          signal.throwIfAborted()
          return result.page
        } catch (error) {
          if (closed) await exit
          throw error
        }
      },
      async acknowledge(ordinal, payloadDigest) {
        try {
          const result = await request({ kind: 'ack', ordinal, digest: payloadDigest })
          if (result.kind !== 'acknowledged')
            throw new Error('Native worker did not accept owner ACK')
          signal.throwIfAborted()
        } catch (error) {
          if (closed) await exit
          throw error
        }
      },
      close() {
        return (closePromise ??= (async () => {
          if (closed) {
            await exit
            return
          }
          try {
            await active?.catch(() => {})
            if (closed) return
            const result = await request({ kind: 'close' })
            if (result.kind !== 'closed') throw new Error('Native worker did not close snapshot')
          } finally {
            stop(new Error('Native owner pass closed'))
            await exit
          }
        })())
      },
    }
  } catch (error) {
    stop(error)
    await exit
    throw error
  }
}
