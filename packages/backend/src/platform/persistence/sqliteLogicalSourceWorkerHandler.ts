// RFC-540 — the SQLite logical-source Worker's request handling. Each Worker builds one handler (its entry,
// sqliteLogicalSourceWorker.ts); the opened source, the checked contract and the initializing flag live in the handler,
// not in module state, so two handlers in one realm never share them.
import { registerSchemaHistoryRuntime } from './schema/history/runtime'
import { digestSchemaContract, type LogicalSchemaContract } from './schemaContract'
import { openSqliteLogicalSource, type SqliteLogicalSource } from './sqliteLogicalSource'
import {
  SQLITE_LOGICAL_SOURCE_PROTOCOL_VERSION,
  SqliteLogicalSourceWorkerRequestSchema,
  type SqliteLogicalSourceWorkerEvent,
} from './sqliteLogicalSourceProtocol'

/** RFC-540: how a handler talks back to its Worker (the entry hands `postMessage` and the Worker's `close`). */
export interface SqliteLogicalSourceWorkerIo {
  readonly emit: (event: SqliteLogicalSourceWorkerEvent) => void
  readonly close: () => void
}

export interface SqliteLogicalSourceWorkerHandler {
  /** Handle one message posted to the Worker (its `data`). */
  readonly handle: (data: unknown) => Promise<void>
}

export function createSqliteLogicalSourceWorkerHandler(
  io: SqliteLogicalSourceWorkerIo,
): SqliteLogicalSourceWorkerHandler {
  let source: SqliteLogicalSource | null = null
  let contract: LogicalSchemaContract | null = null
  let initializing = false

  function emit(event: SqliteLogicalSourceWorkerEvent): void {
    io.emit(event)
  }

  function failure(requestId: string, error: unknown): void {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : error instanceof Error
          ? error.name
          : 'sqlite-source-worker'
    const message = error instanceof Error ? error.message : String(error)
    emit({
      type: 'failure',
      version: SQLITE_LOGICAL_SOURCE_PROTOCOL_VERSION,
      requestId,
      code: code.slice(0, 128) || 'sqlite-source-worker',
      message: message.slice(0, 2_000) || 'SQLite logical-source Worker failed',
    })
  }

  function requireSource(): SqliteLogicalSource {
    if (source === null) throw new Error('SQLite logical-source Worker is not initialized')
    return source
  }

  async function handle(data: unknown): Promise<void> {
    const rawRequestId =
      typeof data === 'object' &&
      data !== null &&
      'requestId' in data &&
      typeof (data as { requestId: unknown }).requestId === 'string'
        ? (data as { requestId: string }).requestId
        : 'sls_0'
    try {
      const request = SqliteLogicalSourceWorkerRequestSchema.parse(data)
      switch (request.type) {
        case 'init': {
          if (source !== null || initializing)
            throw new Error('SQLite logical-source Worker was initialized twice')
          initializing = true
          try {
            const workerContract = request.contract
            const { digest, ...payload } = workerContract
            if (
              digest !== request.expectedSchemaDigest ||
              digestSchemaContract(payload) !== digest
            ) {
              throw new Error(
                'SQLite logical-source Worker schema digest does not match the daemon',
              )
            }
            if (request.history)
              registerSchemaHistoryRuntime({
                head: () => request.history!.head,
                metaTables: request.history.metaTables,
              })
            contract = workerContract
            source = openSqliteLogicalSource({ path: request.path, contract: workerContract })
          } finally {
            initializing = false
          }
          emit({
            type: 'ready',
            version: SQLITE_LOGICAL_SOURCE_PROTOCOL_VERSION,
            requestId: request.requestId,
          })
          return
        }
        case 'metadata':
          emit({
            version: SQLITE_LOGICAL_SOURCE_PROTOCOL_VERSION,
            requestId: request.requestId,
            type: 'metadata',
            snapshot: await requireSource().readMetadata!(),
          })
          break
        case 'preflight':
          emit({
            type: 'snapshot',
            version: SQLITE_LOGICAL_SOURCE_PROTOCOL_VERSION,
            requestId: request.requestId,
            snapshot: await requireSource().preflight(),
          })
          return
        case 'assert-unchanged':
          await requireSource().assertUnchanged(request.snapshot)
          emit({
            type: 'unchanged',
            version: SQLITE_LOGICAL_SOURCE_PROTOCOL_VERSION,
            requestId: request.requestId,
          })
          return
        case 'read-chunk': {
          const table = contract?.tables.find((candidate) => candidate.id === request.tableId)
          if (table === undefined) throw new Error(`unknown logical table ${request.tableId}`)
          emit({
            type: 'rows',
            version: SQLITE_LOGICAL_SOURCE_PROTOCOL_VERSION,
            requestId: request.requestId,
            rows: [...(await requireSource().readChunk(table, request.afterKey, request.limit))],
          })
          return
        }
        case 'close':
          await requireSource().close()
          source = null
          contract = null
          emit({
            type: 'closed',
            version: SQLITE_LOGICAL_SOURCE_PROTOCOL_VERSION,
            requestId: request.requestId,
          })
          io.close()
      }
    } catch (error) {
      failure(rawRequestId, error)
    }
  }

  return Object.freeze({ handle })
}
