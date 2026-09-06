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

  test('git cache uses the cleanup-capable primitive', () => {
    // RFC-359 W4-D19c-tail：工作组那一半退役了——不是丢了保护，是换了更强的一层。
    // 合一前 legacy 用 per-task 的进程内串行队列挡 `wg_tasks_add` 并发重名；中立回合驱动把定论
    // 挪进**提交事务**（`applyResourceCatalogOperation` 的 dedupKey 撞车检查），跨进程也成立，
    // 于是那个队列连同 legacy 引擎岛一起删除。这里只剩 git cache 这一处用例。
    const gitCache = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'gitRepoCache.ts'),
      'utf8',
    )
    expect(gitCache).toContain('urlQueue.run(urlHash')
    expect(gitCache).not.toContain('urlMutex')
  })
})
