import { isDeepStrictEqual } from 'node:util'
import { ObservationNativePassCompletionSchema } from '@agent-workflow/shared'
import type { NativeUsageBaselineReadView } from '@/modules/task-execution/public/types'
import type { OriginalReportSnapshot } from '../persistence/reportSnapshotTypes'
import type {
  NativeUsageBaselineRequest,
  NativeUsageBaselineResult,
  NativeUsageBaselineWorkerEvent,
  NativeUsageBaselineWorkerStart,
} from './nativeUsageBaselineProtocol'

declare const AW_COMPILED_BUILD: boolean | undefined
const entry =
  typeof AW_COMPILED_BUILD === 'boolean' && AW_COMPILED_BUILD
    ? './modules/task-execution/infrastructure/nativeUsageBaselineWorker.ts'
    : new URL(
        '../../modules/task-execution/infrastructure/nativeUsageBaselineWorker.ts',
        import.meta.url,
      ).href

/** Original SQLite reads stay in the Worker; original PG reads drain before lease release. */
export async function withNativeUsageBaselineWorker<T>(
  input: NativeUsageBaselineWorkerStart,
  signal: AbortSignal,
  work: (baseline: NativeUsageBaselineReadView | null) => Promise<T>,
  snapshot?: OriginalReportSnapshot,
): Promise<T> {
  signal.throwIfAborted()
  const worker = new Worker(entry),
    sqlReads = new Set<Promise<void>>()
  let exited!: () => void
  const exit = new Promise<void>((resolve) => {
    exited = resolve
  })
  let sequence = 0n,
    closed = false,
    activeView = false,
    active: Promise<NativeUsageBaselineResult> | undefined,
    pending:
      | {
          id: string
          requestKind: NativeUsageBaselineRequest['kind']
          resolve(value: NativeUsageBaselineResult): void
          reject(error: unknown): void
        }
      | undefined
  let value!: T
  let failed = false
  let failure: unknown
  const recordFailure = (error: unknown) => {
    if (failed) return
    failed = true
    failure = error
  }
  let closeAcknowledged = false
  const stop = (error: unknown, terminate = false, planned = false) => {
    if (closed) return
    if (!planned) recordFailure(error)
    closed = true
    activeView = false
    signal.removeEventListener('abort', cancel)
    const waiting = pending
    pending = undefined
    waiting?.reject(error)
    // The Worker has already closed its original snapshot and will exit naturally.
    // Do not race that actual close event with another cancel/terminate operation.
    if (planned && closeAcknowledged) return
    if (terminate) worker.terminate()
    else
      try {
        worker.postMessage({ kind: 'cancel', reason: 'Original native baseline reader closing' })
      } catch {
        worker.terminate()
      }
  }
  const cancel = () => stop(signal.reason ?? new Error('Native baseline reader cancelled'))
  worker.onmessage = (event: MessageEvent<NativeUsageBaselineWorkerEvent>) => {
    const message = event.data
    if (message.kind === 'request') {
      if (closed) return
      const read = (async () => {
        try {
          if (!snapshot?.readChannel || message.request.kind !== 'read')
            throw new Error('Native baseline requires its original read-only channel')
          signal.throwIfAborted()
          const value = await snapshot.readChannel[message.request.method](
            message.request.statement,
            message.request.parameters,
          )
          if (!closed) worker.postMessage({ kind: 'response', id: message.id, ok: true, value })
        } catch (error) {
          if (!closed)
            worker.postMessage({
              kind: 'response',
              id: message.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
        }
      })()
      sqlReads.add(read)
      void read.finally(() => sqlReads.delete(read)).catch(stop)
      return
    }
    if (message.kind === 'failed') {
      stop(new Error(message.error))
      return
    }
    const waiting = pending
    if (!waiting || message.id !== waiting.id) {
      stop(new Error('Native baseline reply changed request'))
      return
    }
    pending = undefined
    if (waiting.requestKind === 'close' && message.result.kind === 'closed')
      closeAcknowledged = true
    waiting.resolve(message.result)
  }
  worker.onerror = (event) => {
    event.preventDefault()
    stop(new Error(event.message || 'Native baseline Worker failed'), true)
  }
  worker.addEventListener('close', () => {
    exited()
    stop(new Error('Native baseline Worker exited'), true, closeAcknowledged)
  })
  signal.addEventListener('abort', cancel, { once: true })
  const request = (value: NativeUsageBaselineRequest): Promise<NativeUsageBaselineResult> => {
    if (closed) return Promise.reject(new Error('Native baseline reader closed'))
    if (pending) return Promise.reject(new Error('Native baseline request awaits reply'))
    active = new Promise((resolve, reject) => {
      const id = String(++sequence)
      pending = { id, requestKind: value.kind, resolve, reject }
      try {
        worker.postMessage({ kind: 'operation', id, request: value })
      } catch (error) {
        stop(error, true)
      }
    })
    return active
  }
  try {
    if (signal.aborted) cancel()
    const result = await request({ kind: 'open', input })
    if (result.kind !== 'opened') throw new Error('Native baseline did not open original snapshot')
    const original = ObservationNativePassCompletionSchema.parse(result.original)
    if (
      !isDeepStrictEqual(original, input.original) ||
      typeof result.available !== 'boolean' ||
      typeof result.snapshotId !== 'string' ||
      !result.snapshotId ||
      result.generationId !== input.source.generationId ||
      (input.source.kind === 'original-channel' && result.snapshotId !== input.source.snapshotId)
    )
      throw new Error('Native baseline changed its original identity or generation')
    activeView = true
    value = await work(
      result.available
        ? {
            original,
            snapshotId: result.snapshotId,
            databaseGeneration: result.generationId,
            async members(stepIds) {
              signal.throwIfAborted()
              if (!activeView)
                throw new Error('Original native before index snapshot is already closed')
              if (stepIds.length > 1000)
                throw new RangeError('Native before lookup exceeds one transport packet')
              const reply = await request({ kind: 'members', stepIds })
              if (reply.kind !== 'members')
                throw new Error('Native baseline did not return original members')
              signal.throwIfAborted()
              const found = new Set(reply.stepIds),
                requested = new Set(stepIds)
              if (
                !activeView ||
                found.size !== reply.stepIds.length ||
                [...found].some((id) => !requested.has(id))
              )
                throw new Error('Native baseline changed its original membership reply')
              return found
            },
          }
        : null,
    )
  } catch (error) {
    recordFailure(error)
  } finally {
    activeView = false
    try {
      await active?.catch(() => {})
      if (!closed) {
        const result = await request({ kind: 'close' })
        if (result.kind !== 'closed')
          recordFailure(new Error('Native baseline did not close original snapshot'))
      }
    } catch (error) {
      recordFailure(error)
    } finally {
      stop(new Error('Native baseline reader closed'), false, true)
      await Promise.allSettled([...sqlReads])
      await exit
    }
  }
  if (failed) throw failure
  return value
}
