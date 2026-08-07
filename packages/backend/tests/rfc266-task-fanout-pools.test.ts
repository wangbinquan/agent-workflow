// RFC-266 —— 每任务扇出子池注册表。
//
// 为什么这些测试存在：
// ① `multiProcessSubprocessConcurrency` 从 P-3-02 落地起就是 runTask 内的
//    `new Semaphore(...)`，喂给它的 opts 字段**从来没有人填**（两级漏斗都漏搬），
//    所以任何部署上扇出并发恒为硬编码的 4。注册表 + 漏斗补齐后，这里锁住
//    getOrCreate / resize-on-read 语义。
// ② 用户要求「改动后立即生效」，运行中的任务也要感知 ⇒ resizeAllTaskFanoutSems
//    必须遍历到每一个活着的池。
// ③ 生命周期照抄 taskWriteLocks.ts 用事故换来的纪律：gc 只许 runTask finally 调，
//    且必须带 idle 守卫 —— 有人持有/排队时删掉再重建会把一个池裂成两个，任务
//    就会以双倍分片并发跑。守卫这条是本文件最重要的断言。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  getTaskFanoutSem,
  gcTaskFanoutSem,
  resizeAllTaskFanoutSems,
  taskFanoutPoolCount,
} from '../src/services/taskFanoutPools'

const tid = (s: string): string => `rfc266-${s}-${taskFanoutPoolCount()}`

describe('RFC-266 task fan-out pool registry', () => {
  test('get-or-create returns the same instance for one task', () => {
    const id = tid('same')
    const first = getTaskFanoutSem(id, 4)
    expect(getTaskFanoutSem(id, 4)).toBe(first)
    gcTaskFanoutSem(id)
  })

  test('resize-on-read updates the live instance instead of replacing it', () => {
    const id = tid('resize-read')
    const sem = getTaskFanoutSem(id, 4)
    const again = getTaskFanoutSem(id, 2)
    expect(again).toBe(sem)
    expect(sem.capacity).toBe(2)
    gcTaskFanoutSem(id)
  })

  test('resizeAllTaskFanoutSems reaches every running task (hot-apply)', () => {
    const a = tid('hot-a')
    const b = tid('hot-b')
    const semA = getTaskFanoutSem(a, 4)
    const semB = getTaskFanoutSem(b, 4)
    resizeAllTaskFanoutSems(9)
    expect(semA.capacity).toBe(9)
    expect(semB.capacity).toBe(9)
    gcTaskFanoutSem(a)
    gcTaskFanoutSem(b)
  })

  test('growing drains queued shards immediately — no holder has to release', async () => {
    const id = tid('grow')
    const sem = getTaskFanoutSem(id, 1)
    const releaseFirst = await sem.acquire()
    let secondEntered = false
    const queued = sem.acquire().then((release: () => void) => {
      secondEntered = true
      return release
    })
    await Promise.resolve()
    expect(secondEntered).toBe(false)

    resizeAllTaskFanoutSems(2) // 只改容量，不释放任何持有者
    const releaseSecond = await queued
    expect(secondEntered).toBe(true)

    releaseFirst()
    releaseSecond()
    gcTaskFanoutSem(id)
  })

  test('shrinking never preempts an in-flight shard', async () => {
    const id = tid('shrink')
    const sem = getTaskFanoutSem(id, 2)
    const r1 = await sem.acquire()
    const r2 = await sem.acquire()
    resizeAllTaskFanoutSems(1)
    expect(sem.capacity).toBe(1)

    // 两个在飞的都不被抢占；释放一个后不得补位（inUse 仍 > 新容量）。
    let thirdEntered = false
    const third = sem.acquire().then((release: () => void) => {
      thirdEntered = true
      return release
    })
    r1()
    await Promise.resolve()
    expect(thirdEntered).toBe(false)

    r2()
    const r3 = await third
    expect(thirdEntered).toBe(true)
    r3()
    gcTaskFanoutSem(id)
  })

  test('gc drops an idle entry', () => {
    const id = tid('gc-idle')
    getTaskFanoutSem(id, 4)
    const before = taskFanoutPoolCount()
    gcTaskFanoutSem(id)
    expect(taskFanoutPoolCount()).toBe(before - 1)
  })

  test('gc KEEPS an entry that is still held — a split pool would double the shard cap', async () => {
    const id = tid('gc-held')
    const sem = getTaskFanoutSem(id, 1)
    const release = await sem.acquire()
    gcTaskFanoutSem(id)
    expect(getTaskFanoutSem(id, 1)).toBe(sem) // 同一实例，未被裂开
    release()
    gcTaskFanoutSem(id)
  })

  test('gc KEEPS an entry that still has a waiter', async () => {
    const id = tid('gc-queued')
    const sem = getTaskFanoutSem(id, 1)
    const release = await sem.acquire()
    const queued = sem.acquire()
    gcTaskFanoutSem(id)
    expect(getTaskFanoutSem(id, 1)).toBe(sem)
    release()
    ;(await queued)()
    gcTaskFanoutSem(id)
  })

  test('the scheduler gc-s the entry in runTask finally and nowhere else', () => {
    const scheduler = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    // 与 gcTaskWriteSem 同处、同一个 finally —— 唯一允许的 gc 点。
    expect(scheduler).toContain('gcTaskWriteSem(opts.taskId)\n    gcTaskFanoutSem(opts.taskId)')
    expect(scheduler.match(/gcTaskFanoutSem\(/g)).toHaveLength(1)
    // HTTP 侧绝不允许 gc（会与调度器缓存的引用竞争 ⇒ 裂池）。
    const routes = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'routes', 'config.ts'),
      'utf8',
    )
    expect(routes).not.toContain('gcTaskFanoutSem')
  })
})
