// RFC-311 T20 —— `agent-workflow db compact`：停机回收 DB 内部空洞。
//
// 删除大批行（事件归档、保留期清理、终态任务归档）之后，那些页留在文件里不还给
// 文件系统——`freelist_count × page_size` 就是这部分。只有 VACUUM 能收回它，而
// VACUUM 会持写锁重写整个库：几 GB 的库上是分钟级，跑在 daemon 的单条同步连接上
// 等于全站冻结那么久。所以这条**只提供 CLI、只在 daemon 停止时执行**，不做「设置
// 页一键」——一键会让用户在不知情的情况下把生产冻住。
//
// 与 `backup`/`restore` 同一条闸门：先看 PID 文件，daemon 在跑就拒绝并告诉用户
// 先 `agent-workflow stop`。

import { Database } from 'bun:sqlite'
import { existsSync, statSync } from 'node:fs'

import { isProcessAlive } from '@/util/process'
import { readPidFromLock } from '@/util/lock'
import { Paths } from '@/util/paths'

export interface DbCompactResult {
  status: 'ok' | 'daemon-running' | 'no-db'
  output: string
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export function dbCompactCommand(): DbCompactResult {
  const pid = readPidFromLock(Paths.lock)
  if (pid !== null && isProcessAlive(pid)) {
    return {
      status: 'daemon-running',
      output:
        `daemon is running (pid ${pid}) — VACUUM rewrites the whole database while holding\n` +
        `the write lock, which would freeze every request for the duration.\n` +
        `Stop it first:  agent-workflow stop\n`,
    }
  }
  const dbPath = Paths.db
  if (!existsSync(dbPath)) {
    return { status: 'no-db', output: `no database at ${dbPath}\n` }
  }

  const before = statSync(dbPath).size
  const sqlite = new Database(dbPath)
  try {
    const pageSize = Number(
      (sqlite.query('PRAGMA page_size').get() as { page_size?: number } | null)?.page_size ?? 0,
    )
    const freelist = Number(
      (sqlite.query('PRAGMA freelist_count').get() as { freelist_count?: number } | null)
        ?.freelist_count ?? 0,
    )
    const t0 = performance.now()
    sqlite.exec('VACUUM')
    const elapsed = performance.now() - t0
    const after = statSync(dbPath).size
    return {
      status: 'ok',
      output:
        `compacted ${dbPath}\n` +
        `  reported reclaimable: ${mib(freelist * pageSize)} (${freelist} free pages × ${pageSize}B)\n` +
        `  file size: ${mib(before)} → ${mib(after)} (freed ${mib(Math.max(0, before - after))})\n` +
        `  took ${(elapsed / 1000).toFixed(1)}s\n`,
    }
  } finally {
    sqlite.close()
  }
}
