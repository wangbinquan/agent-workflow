// RFC-349 — dedicated SQLite logical-source Worker. Integrity scans, the
// 184-table count pass and every bounded chunk query run on this connection,
// never on the daemon's request-serving event loop.

import { buildLogicalSchemaContract, type LogicalSchemaContract } from './schemaContract'
import { openSqliteLogicalSource, type SqliteLogicalSource } from './sqliteLogicalSource'
import {
  SQLITE_LOGICAL_SOURCE_PROTOCOL_VERSION,
  SqliteLogicalSourceWorkerRequestSchema,
  type SqliteLogicalSourceWorkerEvent,
} from './sqliteLogicalSourceProtocol'

declare const self: Worker

let source: SqliteLogicalSource | null = null
let contract: LogicalSchemaContract | null = null

function emit(event: SqliteLogicalSourceWorkerEvent): void {
  postMessage(event)
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

self.onmessage = async (event: MessageEvent<unknown>) => {
  const rawRequestId =
    typeof event.data === 'object' &&
    event.data !== null &&
    'requestId' in event.data &&
    typeof (event.data as { requestId: unknown }).requestId === 'string'
      ? (event.data as { requestId: string }).requestId
      : 'sls_0'
  try {
    const request = SqliteLogicalSourceWorkerRequestSchema.parse(event.data)
    switch (request.type) {
      case 'init': {
        if (source !== null) throw new Error('SQLite logical-source Worker was initialized twice')
        const workerContract = buildLogicalSchemaContract()
        if (workerContract.digest !== request.expectedSchemaDigest) {
          throw new Error('SQLite logical-source Worker schema digest does not match the daemon')
        }
        contract = workerContract
        source = openSqliteLogicalSource({ path: request.path, contract: workerContract })
        emit({
          type: 'ready',
          version: SQLITE_LOGICAL_SOURCE_PROTOCOL_VERSION,
          requestId: request.requestId,
        })
        return
      }
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
        ;(self as unknown as { close(): void }).close()
    }
  } catch (error) {
    failure(rawRequestId, error)
  }
}
