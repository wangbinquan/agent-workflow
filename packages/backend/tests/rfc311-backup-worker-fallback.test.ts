// RFC-311 实现门 P0-1 回归锁。
//
// `bun build --compile` 只打包显式入口,`new Worker(new URL('./x.ts',
// import.meta.url))` 不被 bundler 追踪——于是**发布版单二进制里备份 100% 抛
// ModuleNotFound**,而所有测试仍绿(测试用内存库走同线程路径;二进制 smoke 只跑
// `version`)。两道防线各锁一条:
//   ① 构建脚本必须把 worker 列为额外入口(source lock,新增 worker 时会红);
//   ② worker 起不来时 `vacuumIntoOffThread` 必须回退到同线程 VACUUM INTO ——
//      丢的只是「不冻结主线程」这个优化,备份本身绝不能没。

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { isDbSnapshotInProgress, vacuumIntoOffThread } from '../src/services/backup'
import { runWalCheckpointTick } from '../src/services/backupScheduler'

describe('RFC-311 P0-1 — off-thread backup vacuum', () => {
  test('the compile step lists the worker as its own entrypoint', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', '..', '..', 'scripts', 'build-binary.ts'),
      'utf8',
    )
    expect(src).toContain("join(backendSrc, 'services', 'backupVacuumWorker.ts')")
    // 主二进制与 e2e 二进制共用同一个 compile helper；worker 必须作为
    // 额外入口进入该 helper，且两个产物都通过它构建。
    expect(src).toContain('entrypoints: [mainEntry, ...WORKER_ENTRIES]')
    expect(src.match(/await buildDaemonBinary\(\{/g)).toHaveLength(2)
  })

  test('a real file DB copies through the worker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-vacuum-'))
    const dbPath = join(dir, 'src.sqlite')
    const db = new Database(dbPath)
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('x');")
    const dest = join(dir, 'copy.sqlite')
    const result = await vacuumIntoOffThread(db, dbPath, dest)
    expect(result.offThread).toBe(true)
    expect(existsSync(dest)).toBe(true)
    const copy = new Database(dest, { readonly: true })
    expect((copy.query('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(1)
    copy.close()
    db.close()
  })

  test('an unusable worker falls back to the main thread instead of failing the backup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-vacuum-fb-'))
    const dbPath = join(dir, 'src.sqlite')
    const db = new Database(dbPath)
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('y');")
    const dest = join(dir, 'copy.sqlite')
    // 模拟编译产物里 worker 解析不到:构造函数直接抛(与 ModuleNotFound 同形)。
    const OriginalWorker = globalThis.Worker
    ;(globalThis as { Worker: unknown }).Worker = class {
      constructor() {
        throw new Error('ModuleNotFound resolving "/$bunfs/root/backupVacuumWorker.ts"')
      }
    }
    try {
      const result = await vacuumIntoOffThread(db, dbPath, dest)
      expect(result.offThread).toBe(false)
      expect(existsSync(dest)).toBe(true)
      const copy = new Database(dest, { readonly: true })
      expect((copy.query('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(1)
      copy.close()
    } finally {
      ;(globalThis as { Worker: unknown }).Worker = OriginalWorker
      db.close()
    }
  })
})

// 实现门 P0-2:备份的只读快照期间,checkpoint(TRUNCATE) 会阻塞满 busy_timeout
// (实测 5310ms)并冻结整个同步主连接——正是 §6.6 要消灭的那件事。快照期间必须跳过。
describe('RFC-311 P0-2 — checkpoint yields to an in-flight snapshot', () => {
  test('the tick skips while a DB snapshot holds a reader, and resumes after', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-ckpt-'))
    const dbPath = join(dir, 'src.sqlite')
    const raw = new Database(dbPath)
    raw.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY);')
    const db = { $client: raw } as unknown as Parameters<typeof runWalCheckpointTick>[0]

    expect(runWalCheckpointTick(db)).toBe('checkpointed')
    const slow = vacuumIntoOffThread(raw, dbPath, join(dir, 'copy.sqlite'))
    expect(isDbSnapshotInProgress()).toBe(true)
    expect(runWalCheckpointTick(db)).toBe('skipped-snapshot')
    await slow
    expect(isDbSnapshotInProgress()).toBe(false)
    expect(runWalCheckpointTick(db)).toBe('checkpointed')
    raw.close()
  })
})
