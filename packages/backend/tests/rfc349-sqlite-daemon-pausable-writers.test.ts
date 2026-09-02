// RFC-349 回归防护 —— SQLite daemon 的周期写手必须归 provider session 管，能被冻结。
//
// 为什么这条测试存在：一次数据库迁移先**冻结** SQLite 源，再证明它在拷贝期间没动过
// （`sqliteLogicalSource.assertUnchanged`：data_version / page_count / file_bytes 三选一
// 变了就判 `sqlite-source-mutated`）。冻结的实现是把 provider session 上注册的 handle
// 全部 stop + drain——**没注册的写手不受影响，会一路写穿整个冻结窗口**。
// PostgreSQL daemon 早就把 limits / backup / submodule-refresh / batch-import-gc 四条
// 组装成可暂停 handle；SQLite daemon 这一侧却在 §8 直接 `startXxx()` 起裸 ticker，
// 其中 resource-limits 是 1Hz 的。这条不对称正是 hosted `postgresql-evidence` 的大迁移
// 反复以 `sqlite-source-mutated` 收场时第一个要排除的嫌疑。
//
// 判据：①四条都出现在 SQLite 那份 `providerBackgroundWriterFactories` 里；
// ②两个 daemon 组装的这四个 id 一一对应（不对称就是回归）；
// ③关机路径不再逐个 `.stop()` 它们——那意味着它们又回到了 session 之外；
// ④`startLimitsTicker` 这个裸 ticker 入口已经没有生产调用者。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const backendRoot = resolve(import.meta.dir, '..')
const START = readFileSync(resolve(backendRoot, 'src/cli/start.ts'), 'utf8')

/** handle id ⇄ the factory const each daemon registers under it. */
const PAUSABLE_WRITERS = [
  { id: 'resource-limits', factory: 'limitsRuntimeFactory' },
  { id: 'scheduled-backup', factory: 'backupRuntimeFactory' },
  { id: 'submodule-refresh', factory: 'submoduleRefreshRuntimeFactory' },
  { id: 'batch-import-gc', factory: 'batchImportRuntimeFactory' },
] as const

/** The array literal passed as `backgroundWriterFactories` / `providerBackgroundWriterFactories`. */
function writerListAfter(marker: string): string {
  const at = START.indexOf(marker)
  expect(at, `${marker} 不在 start.ts 里（组装结构变了？）`).toBeGreaterThan(-1)
  const open = START.indexOf('[', at)
  const close = START.indexOf(']', open)
  return START.slice(open, close)
}

describe('RFC-349 SQLite daemon periodic writers are provider-session handles', () => {
  test('the SQLite session owns all four periodic writers', () => {
    const sqliteList = writerListAfter('const providerBackgroundWriterFactories = Object.freeze([')
    for (const writer of PAUSABLE_WRITERS) {
      expect(
        sqliteList,
        `${writer.id} 不在 SQLite provider session 的写手清单里 ⇒ 它会写穿迁移的冻结窗口，` +
          '拷贝阶段随后以 sqlite-source-mutated 收场',
      ).toContain(writer.factory)
    }
  })

  test('both daemons compose the same four pausable writers', () => {
    const postgresqlList = writerListAfter('backgroundWriterFactories: [')
    for (const writer of PAUSABLE_WRITERS) {
      expect(
        postgresqlList,
        `${writer.id} 不在 PostgreSQL 那份清单里 ⇒ 两侧的冻结保证不对称`,
      ).toContain(writer.factory)
      expect(
        START.split(`id: '${writer.id}'`).length - 1,
        `${writer.id} 的 handle id 不是两个 daemon 各一次 ⇒ 有一侧没组装成 handle`,
      ).toBe(2)
    }
  })

  test('shutdown no longer stops them by hand: the session owns their lifecycle', () => {
    const shutdown = START.slice(START.indexOf('const shutdown = async (signal: string)'))
    for (const ticker of [
      'limitsTicker.stop()',
      'backupTicker.stop()',
      'submoduleRefreshTicker.stop()',
      'batchImportGcTicker.stop()',
    ]) {
      expect(
        shutdown.includes(ticker),
        `${ticker} 还留在关机路径上 ⇒ 说明它又是一条 session 之外的裸 ticker`,
      ).toBe(false)
    }
  })

  test('the bare limits ticker entry point is gone', () => {
    const limits = readFileSync(resolve(backendRoot, 'src/services/limits.ts'), 'utf8')
    expect(
      limits,
      'startLimitsTicker 又回来了 ⇒ 下一个调用方会绕开 provider session 起一条 1Hz 写手',
    ).not.toContain('export function startLimitsTicker')
    expect(START).not.toContain('startLimitsTicker')
  })
})
