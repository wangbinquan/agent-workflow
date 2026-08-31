// RFC-349 — fail-closed supervisor/proxy for the SQLite migration Worker.
// There is deliberately no main-thread fallback: a missing or failed Worker
// stops migration instead of turning a data-plane operation into UI latency.

import type { CanonicalLogicalValue } from './logicalDatabaseArtifact'
import type { LogicalSchemaContract, LogicalTableContract } from './schemaContract'
import {
  SqliteLogicalSourceError,
  type SqliteLogicalSource,
  type SqliteLogicalSourceSnapshot,
} from './sqliteLogicalSource'
import {
  SQLITE_LOGICAL_SOURCE_PROTOCOL_VERSION,
  SqliteLogicalSourceWorkerEventSchema,
  type SqliteLogicalSourceWorkerEvent,
  type SqliteLogicalSourceWorkerRequest,
} from './sqliteLogicalSourceProtocol'

declare const AW_COMPILED_BUILD: boolean | undefined

export interface SqliteLogicalSourceWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onerror: ((event: ErrorEvent) => unknown) | null
  postMessage(message: unknown): void
  terminate(): void
}

export interface SqliteLogicalSourceWorkerOptions {
  readonly path: string
  readonly contract: LogicalSchemaContract
  readonly workerFactory?: () => SqliteLogicalSourceWorkerLike
  readonly requestTimeoutMs?: number
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

const SQLITE_LOGICAL_SOURCE_WORKER_ENTRY =
  typeof AW_COMPILED_BUILD === 'boolean' && AW_COMPILED_BUILD
    ? './platform/persistence/sqliteLogicalSourceWorker.ts'
    : new URL('./sqliteLogicalSourceWorker.ts', import.meta.url).href

const DEFAULT_FACTORY = (): SqliteLogicalSourceWorkerLike =>
  new Worker(SQLITE_LOGICAL_SOURCE_WORKER_ENTRY) as unknown as SqliteLogicalSourceWorkerLike

type Pending = {
  readonly expected: SqliteLogicalSourceWorkerEvent['type']
  readonly resolve: (event: SqliteLogicalSourceWorkerEvent) => void
  readonly reject: (error: Error) => void
  readonly timer: unknown
}

type RequestWithoutEnvelope<T> = T extends SqliteLogicalSourceWorkerRequest
  ? Omit<T, 'version' | 'requestId'>
  : never
type SqliteLogicalSourceWorkerRequestInput =
  RequestWithoutEnvelope<SqliteLogicalSourceWorkerRequest>

const SOURCE_CODES = new Set([
  'sqlite-source-integrity',
  'sqlite-source-schema',
  'sqlite-source-mutated',
  'sqlite-source-read',
])

function sourceError(code: string, message: string): SqliteLogicalSourceError {
  return new SqliteLogicalSourceError(
    SOURCE_CODES.has(code)
      ? (code as ConstructorParameters<typeof SqliteLogicalSourceError>[0])
      : 'sqlite-source-read',
    message,
  )
}

export async function openSqliteLogicalSourceWorker(
  options: SqliteLogicalSourceWorkerOptions,
): Promise<SqliteLogicalSource> {
  const worker = (options.workerFactory ?? DEFAULT_FACTORY)()
  const timeoutMs = options.requestTimeoutMs ?? 30 * 60_000
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const pending = new Map<string, Pending>()
  let nextRequestId = 1
  let closed = false

  const rejectAll = (error: Error): void => {
    for (const request of pending.values()) {
      clearTimer(request.timer)
      request.reject(error)
    }
    pending.clear()
  }

  const failWorker = (message: string): void => {
    if (closed) return
    closed = true
    worker.terminate()
    rejectAll(sourceError('sqlite-source-read', message))
  }

  worker.onerror = (event) => {
    event.preventDefault?.()
    failWorker(event.message || 'SQLite logical-source Worker crashed')
  }
  worker.onmessage = (message) => {
    const parsed = SqliteLogicalSourceWorkerEventSchema.safeParse(message.data)
    if (!parsed.success) {
      failWorker('SQLite logical-source Worker returned an invalid protocol event')
      return
    }
    const event = parsed.data
    const request = pending.get(event.requestId)
    if (request === undefined) {
      failWorker('SQLite logical-source Worker returned an unknown request id')
      return
    }
    clearTimer(request.timer)
    pending.delete(event.requestId)
    if (event.type === 'failure') {
      request.reject(sourceError(event.code, event.message))
      return
    }
    if (event.type !== request.expected) {
      request.reject(
        sourceError(
          'sqlite-source-read',
          `SQLite logical-source Worker returned ${event.type}; expected ${request.expected}`,
        ),
      )
      return
    }
    request.resolve(event)
  }

  const request = async (
    input: SqliteLogicalSourceWorkerRequestInput,
    expected: SqliteLogicalSourceWorkerEvent['type'],
  ): Promise<SqliteLogicalSourceWorkerEvent> => {
    if (closed) throw sourceError('sqlite-source-read', 'SQLite logical-source Worker is closed')
    const requestId = `sls_${nextRequestId++}`
    const message = {
      ...input,
      version: SQLITE_LOGICAL_SOURCE_PROTOCOL_VERSION,
      requestId,
    } as SqliteLogicalSourceWorkerRequest
    return await new Promise<SqliteLogicalSourceWorkerEvent>((resolve, reject) => {
      const timer = setTimer(() => {
        pending.delete(requestId)
        failWorker(`SQLite logical-source Worker request ${input.type} timed out`)
        reject(sourceError('sqlite-source-read', `SQLite logical-source Worker timed out`))
      }, timeoutMs)
      ;(timer as { unref?: () => void } | null)?.unref?.()
      pending.set(requestId, { expected, resolve, reject, timer })
      worker.postMessage(message)
    })
  }

  await request(
    {
      type: 'init',
      path: options.path,
      expectedSchemaDigest: options.contract.digest,
    },
    'ready',
  )

  return Object.freeze<SqliteLogicalSource>({
    provider: 'sqlite',
    path: options.path,
    async preflight() {
      const event = await request({ type: 'preflight' }, 'snapshot')
      if (event.type !== 'snapshot') throw new Error('unreachable SQLite source response')
      return event.snapshot
    },
    async assertUnchanged(snapshot: SqliteLogicalSourceSnapshot) {
      await request({ type: 'assert-unchanged', snapshot }, 'unchanged')
    },
    async readChunk(
      table: LogicalTableContract,
      afterKey: readonly CanonicalLogicalValue[] | null,
      limit: number,
    ) {
      const event = await request(
        {
          type: 'read-chunk',
          tableId: table.id,
          afterKey: afterKey === null ? null : [...afterKey],
          limit,
        },
        'rows',
      )
      if (event.type !== 'rows') throw new Error('unreachable SQLite source response')
      return event.rows
    },
    async close() {
      if (closed) return
      try {
        await request({ type: 'close' }, 'closed')
      } finally {
        closed = true
        worker.terminate()
        rejectAll(sourceError('sqlite-source-read', 'SQLite logical-source Worker closed'))
      }
    },
  })
}
