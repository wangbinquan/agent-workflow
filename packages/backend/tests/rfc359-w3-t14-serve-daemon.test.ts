// RFC-359 W3-T14 —— 监听器与关机序列只有一份（`serveDaemon`），两个 provider 共用；
// provider 专属的收尾全部在各自会话的关闭参与者里，且两侧同一组 id、同一顺序。
//
// 此前 PostgreSQL 走永不返回的 `servePostgresqlDaemon`，SQLite 在 `startCommand` 尾部另有一段手写的
// `Bun.serve` + `shutdown()`——同一件事两种写法，PG 那份漏掉的步骤（design §6）正是从这条分叉长出来的。
// 这条源码锁钉住：`cli/start.ts` 只有一个 `Bun.serve(`、一个 `serveDaemon(` 定义、两个调用点
// （PG 分支与 SQLite 主路径；T16 把 provider 执行分支归零后只剩一个），以及两个会话的关闭参与者 id 集合相等。

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const START = readFileSync(resolve(import.meta.dir, '..', 'src', 'cli', 'start.ts'), 'utf8')

function closeParticipantIds(section: string): string[] {
  const ids: string[] = []
  const re = /const (\w+): DaemonProviderCloseParticipant = Object\.freeze\(\{\n\s+id: '([^']+)'/g
  let match: RegExpExecArray | null
  while ((match = re.exec(section)) !== null) ids.push(match[2]!)
  return ids
}

test('监听器只有一份：一个 Bun.serve、一个 serveDaemon 定义、没有 servePostgresqlDaemon', () => {
  expect(START.split('Bun.serve(').length - 1).toBe(1)
  expect(START.split('async function serveDaemon(').length - 1).toBe(1)
  expect(START).not.toContain('function servePostgresqlDaemon(')
  // 两个调用点：PG 分支与 SQLite 主路径各一次（T16 之后归一）。
  expect(START.split('await serveDaemon({').length - 1).toBe(2)
})

test('serveDaemon 的 shutdown 只做监听器层的事：provider 专属收尾不得再出现在它里面', () => {
  const start = START.indexOf('async function serveDaemon(')
  const end = START.indexOf('const MAX_DEV_LOCK_HANDOFF_MS', start)
  const body = START.slice(start, end)
  for (const forbidden of [
    'distillWorker',
    'registerAfterCommitEventPump',
    'webhookTerminalControl',
    'gracefulShutdown',
    'shutdownActiveTaskExecutions',
  ]) {
    expect(body, `${forbidden} 属于会话的关闭参与者，不属于监听器`).not.toContain(forbidden)
  }
  expect(body).toContain('await input.bootstrap.stop()')
  expect(body).toContain('input.lock.release()')
})

test('两个 provider 会话声明同一组关闭参与者、同一顺序', () => {
  const pg = START.slice(
    START.indexOf('async function composePostgresqlProviderSession('),
    START.indexOf('async function serveDaemon('),
  )
  const sqlite = START.slice(START.indexOf('export async function startCommand('))
  const expected = [
    'memory-distill-recover-running',
    'task-execution-graceful-shutdown',
    'webhook-terminal-control',
  ]
  expect(closeParticipantIds(pg)).toEqual(expected)
  expect(closeParticipantIds(sqlite)).toEqual(expected)
  // 两侧的 providerCloseParticipants 列表同序（绑定型参与者 + 三个本地声明）。
  const listOf = (section: string): string[] => {
    const at = section.indexOf('providerCloseParticipants')
    const open = section.indexOf('[', at)
    const close = section.indexOf(']', open)
    return section
      .slice(open + 1, close)
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) =>
        entry.replace(/^\w+(Bindings|RuntimeBindings|BackgroundBindings)\./, '<bindings>.'),
      )
  }
  expect(listOf(sqlite)).toEqual(listOf(pg))
})
