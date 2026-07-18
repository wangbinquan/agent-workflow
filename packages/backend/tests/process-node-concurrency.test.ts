// 上线前加固（2026-07-18）— maxConcurrentNodes 必须是 daemon 级总预算。
//
// 旧 scheduler 在每次 runTask 内 new Semaphore(limit)，并发任务会把真实
// 子进程上限乘以任务数。这里锁同一 DB（一个 daemon 的事实边界）共享同一
// 可缩放实例，不同 DB/测试实例互不污染，并用源码锚点防止接线回退。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getProcessNodeSemaphore } from '../src/services/processNodeConcurrency'

describe('process node concurrency', () => {
  test('same daemon scope shares one limiter; a second task waits on the first', async () => {
    const daemonScope = {}
    const firstTask = getProcessNodeSemaphore(daemonScope, 1)
    const secondTask = getProcessNodeSemaphore(daemonScope, 1)
    expect(secondTask).toBe(firstTask)

    const releaseFirst = await firstTask.acquire()
    let secondEntered = false
    const second = secondTask.acquire().then((release) => {
      secondEntered = true
      return release
    })
    await Promise.resolve()
    expect(secondEntered).toBe(false)
    releaseFirst()
    const releaseSecond = await second
    expect(secondEntered).toBe(true)
    releaseSecond()
  })

  test('a new live config value resizes the shared limiter; another daemon stays isolated', () => {
    const daemonScope = {}
    const original = getProcessNodeSemaphore(daemonScope, 4)
    const resized = getProcessNodeSemaphore(daemonScope, 2)
    expect(resized).toBe(original)
    expect(resized.capacity).toBe(2)
    expect(getProcessNodeSemaphore({}, 7)).not.toBe(original)
  })

  test('scheduler uses the process limiter and never constructs a per-task globalSem', () => {
    const scheduler = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    expect(scheduler).toContain('getProcessNodeSemaphore(db, opts.maxConcurrentNodes ?? 4)')
    expect(scheduler).not.toContain('new Semaphore(opts.maxConcurrentNodes ?? 4)')
  })
})
