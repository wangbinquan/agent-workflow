// RFC-351 —— 持有一段真实的 WAL writer，让前台事务必须在边界处等锁，
// 而不是先取读快照、再去做一次会被 SQLITE_BUSY_SNAPSHOT 顶掉的升级。
//
// 与 rfc338-foreground-contention-worker 同形，只是写的是本 RFC 关心的表：
// 任何一次写都会取到 writer，UPDATE 命中零行也一样。

import { Database } from 'bun:sqlite'

declare const self: Worker

self.onmessage = (event: MessageEvent<{ dbPath: string; holdMs?: number }>) => {
  const db = new Database(event.data.dbPath)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 50; BEGIN IMMEDIATE;')
  db.query(
    "UPDATE employee_tool_registrations SET updated_at = updated_at + 1 WHERE id = 'rfc351-contended'",
  ).run()
  self.postMessage({ type: 'locked' })
  // 在当前 Worker handler 持锁等待，不依赖下一轮 timer callback；原默认 100ms 保持。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, event.data.holdMs ?? 100)
  db.exec('COMMIT;')
  db.close()
  self.postMessage({ type: 'released' })
}
