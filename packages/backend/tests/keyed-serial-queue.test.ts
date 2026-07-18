// 上线前加固（2026-07-18）— daemon 级按 key Promise 链必须在 settle 后回收。
//
// workgroup tasks_add 与 git URL clone 都曾保留完成 key；git 的旧清理还
// 比较了两个不同的 `prev.then(...)` Promise，条件永远不成立。长期运行会
// 让 Map 随任务/URL 单调增长。公共队列把串行、公平、异常续跑和回收锁在一起。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { KeyedSerialQueue } from '../src/util/keyedSerialQueue'

describe('KeyedSerialQueue', () => {
  test('same key is FIFO, different keys proceed independently, idle keys are removed', async () => {
    const queue = new KeyedSerialQueue<string>()
    const order: string[] = []
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate
    })
    const first = queue.run('task-a', async () => {
      order.push('a1-start')
      await gate
      order.push('a1-end')
    })
    const second = queue.run('task-a', async () => {
      order.push('a2')
    })
    const other = queue.run('task-b', async () => {
      order.push('b1')
    })
    await other
    expect(order).toEqual(['a1-start', 'b1'])
    expect(queue.size).toBe(1)
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['a1-start', 'b1', 'a1-end', 'a2'])
    expect(queue.size).toBe(0)
  })

  test('a rejected turn does not poison the next waiter and still cleans up', async () => {
    const queue = new KeyedSerialQueue<string>()
    const failed = queue.run('task', async () => {
      throw new Error('boom')
    })
    const next = queue.run('task', async () => 'ok')
    await expect(failed).rejects.toThrow('boom')
    await expect(next).resolves.toBe('ok')
    expect(queue.size).toBe(0)
  })

  test('workgroup and git cache use the cleanup-capable primitive', () => {
    const workgroup = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'workgroupRunner.ts'),
      'utf8',
    )
    const gitCache = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'gitRepoCache.ts'),
      'utf8',
    )
    expect(workgroup).toContain('tasksAddQueue.run(taskId')
    expect(workgroup).not.toContain('tasksAddChains')
    expect(gitCache).toContain('urlQueue.run(urlHash')
    expect(gitCache).not.toContain('urlMutex')
  })
})
