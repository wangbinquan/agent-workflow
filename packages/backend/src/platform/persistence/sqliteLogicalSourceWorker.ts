// RFC-349 — dedicated SQLite logical-source Worker. Integrity scans, the
// 184-table count pass and every bounded chunk query run on this connection,
// never on the daemon's request-serving event loop.
// RFC-540 — this entry builds the Worker's one request handler; the source, the
// contract and the initializing flag live in that handler, not in module state.

import { createSqliteLogicalSourceWorkerHandler } from './sqliteLogicalSourceWorkerHandler'

declare const self: Worker

const handler = createSqliteLogicalSourceWorkerHandler({
  emit: (event) => postMessage(event),
  close: () => (self as unknown as { close(): void }).close(),
})

self.onmessage = async (event: MessageEvent<unknown>) => {
  await handler.handle(event.data)
}
