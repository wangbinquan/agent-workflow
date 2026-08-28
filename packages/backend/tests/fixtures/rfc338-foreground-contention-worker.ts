// Holds a real WAL writer briefly so the request connection must enter its
// transaction through BEGIN IMMEDIATE instead of a fallible snapshot upgrade.

import { Database } from 'bun:sqlite'

declare const self: Worker

self.onmessage = (event: MessageEvent<{ dbPath: string }>) => {
  const db = new Database(event.data.dbPath)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 50; BEGIN IMMEDIATE;')
  db.query("UPDATE token_audit SET status_code = 201 WHERE id = 'foreground-race'").run()
  self.postMessage({ type: 'locked' })
  setTimeout(() => {
    db.exec('COMMIT;')
    db.close()
    self.postMessage({ type: 'released' })
  }, 100)
}
