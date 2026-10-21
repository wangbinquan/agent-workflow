import { readDaemonGraphSource } from './helpers/daemonGraphSource'
// RFC-359 W3-T14 —— 监听器与关机序列只有一份（`serveDaemon`），两个 provider 共用；
// provider 专属的收尾全部在各自会话的关闭参与者里，且两侧同一组 id、同一顺序。
//
// 此前 PostgreSQL 走永不返回的 `servePostgresqlDaemon`，SQLite 在 `startCommand` 尾部另有一段手写的
// `Bun.serve` + `shutdown()`——同一件事两种写法，PG 那份漏掉的步骤（design §6）正是从这条分叉长出来的。
// 这条源码锁钉住：`bootstrap/daemonStart.ts` 只有一个 `Bun.serve(`、一个 `serveDaemon(` 定义、两个调用点
// （PG 分支与 SQLite 主路径；T16 把 provider 执行分支归零后只剩一个），以及两个会话的关闭参与者 id 集合相等。

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { DAEMON_CLOSE_PARTICIPANTS } from '../src/bootstrap/daemonLifecycleProgram'
import { propertyBodies } from './helpers/daemonProgramSource'

const START = readDaemonGraphSource()

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
  // RFC-359 W3-T16：startCommand 是唯一调用点——provider 执行分支归零，会话装配按 provider 查表。
  expect(START.split('await serveDaemon({').length - 1).toBe(1)
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

test('startCommand 没有 provider 执行分支：不比较 provider 字面量，会话装配只经 composeSession 查表', () => {
  const body = START.slice(
    START.indexOf('export async function startCommand('),
    START.indexOf('async function composeDaemonApplication<'),
  )
  expect(body).not.toMatch(/provider\s*[!=]==\s*'(?:sqlite|postgresql)'/u)
  expect(body).not.toContain("'postgresql' as const")
  expect(body.split('composeSession({').length - 1).toBe(2)
  expect(START).toContain('DAEMON_SESSION_ADAPTERS[input.provider.provider]')
  expect(START).toContain('readonly [P in DatabaseProvider]: DaemonSessionAdapter<P>')
})

test('两个 provider 会话声明同一组关闭参与者、同一顺序', () => {
  const session = readFileSync(
    resolve(import.meta.dir, '../src/bootstrap/daemonSession.ts'),
    'utf8',
  )
  const expected = [
    'memory-distill-recover-running',
    'task-execution-graceful-shutdown',
    'webhook-terminal-control',
  ]
  expect(closeParticipantIds(session)).toEqual(expected)
  expect(DAEMON_CLOSE_PARTICIPANTS.map((item) => item.id)).toEqual([
    'memory-distill-recover-running',
    'task-execution-final-close',
    'maintenance-final-close',
    'mcp-runtime-tests-final-close',
    'task-execution-graceful-shutdown',
    'webhook-terminal-control',
  ])
  for (const section of [session]) {
    const record = propertyBodies(section, 'closeParticipants')
    expect(record).toHaveLength(1)
    for (const { id } of DAEMON_CLOSE_PARTICIPANTS)
      expect(propertyBodies(record[0]!, id)).toHaveLength(1)
  }
})
