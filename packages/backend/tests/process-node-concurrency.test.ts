// 上线前加固（2026-07-18）— maxConcurrentNodes 必须是 daemon 级总预算。
//
// 旧 scheduler 在每次 runTask 内 new Semaphore(limit)，并发任务会把真实
// 子进程上限乘以任务数。这里锁同一 DB（一个 daemon 的事实边界）共享同一
// 可缩放实例，不同 DB/测试实例互不污染，并用源码锚点防止接线回退。
//
// RFC-266（2026-08-07）扩成**两个互不相干的池**：'agent'（agent 节点 / 工作组
// 主持节点 / 扇出分片与聚合）与 'script'（RFC-253 脚本节点）。用户诉求是「秒级
// 脚本不要排在多分钟 agent 后面」，因此本文件除了守住上面的 daemon 级单例语义，
// 还必须锁住两池**彼此独立**：一池占满 / resize 都不得影响另一池。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getNodePoolSemaphore, resizeAllNodePools } from '../src/services/processNodeConcurrency'

const schedulerSrc = (): string =>
  readFileSync(resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'), 'utf8')

describe('process node concurrency', () => {
  test('same daemon scope shares one limiter; a second task waits on the first', async () => {
    const daemonScope = {}
    const firstTask = getNodePoolSemaphore(daemonScope, 'agent', 1)
    const secondTask = getNodePoolSemaphore(daemonScope, 'agent', 1)
    expect(secondTask).toBe(firstTask)

    const releaseFirst = await firstTask.acquire()
    let secondEntered = false
    const second = secondTask.acquire().then((release: () => void) => {
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
    const original = getNodePoolSemaphore(daemonScope, 'agent', 4)
    const resized = getNodePoolSemaphore(daemonScope, 'agent', 2)
    expect(resized).toBe(original)
    expect(resized.capacity).toBe(2)
    expect(getNodePoolSemaphore({}, 'agent', 7)).not.toBe(original)
  })

  // RFC-266 核心不变量：脚本池与 agent 池是两个实例，且互不影响。
  test('agent and script pools are distinct instances within one daemon', () => {
    const daemonScope = {}
    const agent = getNodePoolSemaphore(daemonScope, 'agent', 4)
    const script = getNodePoolSemaphore(daemonScope, 'script', 4)
    expect(script).not.toBe(agent)
    // 同 kind 仍复用同一实例。
    expect(getNodePoolSemaphore(daemonScope, 'script', 4)).toBe(script)
  })

  test('a full agent pool never blocks a script acquire (RFC-266 诉求 C)', async () => {
    const daemonScope = {}
    const agent = getNodePoolSemaphore(daemonScope, 'agent', 1)
    const script = getNodePoolSemaphore(daemonScope, 'script', 1)

    const releaseAgent = await agent.acquire() // agent 池占满
    let scriptEntered = false
    const pending = script.acquire().then((release: () => void) => {
      scriptEntered = true
      return release
    })
    const releaseScript = await pending
    expect(scriptEntered).toBe(true) // 立刻拿到，没有排在 agent 后面
    expect(agent.available).toBe(0)

    releaseScript()
    releaseAgent()
  })

  test('resizing one pool leaves the other untouched', () => {
    const daemonScope = {}
    const agent = getNodePoolSemaphore(daemonScope, 'agent', 4)
    const script = getNodePoolSemaphore(daemonScope, 'script', 4)
    getNodePoolSemaphore(daemonScope, 'agent', 1)
    expect(agent.capacity).toBe(1)
    expect(script.capacity).toBe(4)
  })

  test('resizeAllNodePools pushes both saved capacities into the live limiters', () => {
    const daemonScope = {}
    const agent = getNodePoolSemaphore(daemonScope, 'agent', 4)
    const script = getNodePoolSemaphore(daemonScope, 'script', 4)
    resizeAllNodePools(daemonScope, { agent: 9, script: 2 })
    expect(agent.capacity).toBe(9)
    expect(script.capacity).toBe(2)
    // 实例不得被替换 —— 换实例 = 预算分裂（本模块存在的理由）。
    expect(getNodePoolSemaphore(daemonScope, 'agent', 9)).toBe(agent)
    expect(getNodePoolSemaphore(daemonScope, 'script', 2)).toBe(script)
  })

  test('resizeAllNodePools on a cold daemon creates both pools at the saved capacity', () => {
    const daemonScope = {}
    resizeAllNodePools(daemonScope, { agent: 3, script: 5 })
    expect(getNodePoolSemaphore(daemonScope, 'agent', 3).capacity).toBe(3)
    expect(getNodePoolSemaphore(daemonScope, 'script', 5).capacity).toBe(5)
  })

  test('scheduler uses the pool registry and never constructs a per-task pool', () => {
    const scheduler = schedulerSrc()
    expect(scheduler).toContain("getNodePoolSemaphore(db, 'agent', opts.maxConcurrentNodes ?? 4)")
    expect(scheduler).toContain(
      "getNodePoolSemaphore(db, 'script', opts.maxConcurrentScriptNodes ?? 4)",
    )
    expect(scheduler).not.toContain('new Semaphore(opts.maxConcurrentNodes ?? 4)')
    expect(scheduler).not.toContain('new Semaphore(opts.maxConcurrentScriptNodes ?? 4)')
    // RFC-266: 扇出子池也不再 per-task new（否则设置改动到不了运行中的任务）。
    expect(scheduler).not.toContain('new Semaphore(opts.multiProcessSubprocessConcurrency ?? 4)')
    expect(scheduler).toContain(
      'getTaskFanoutSem(taskId, opts.multiProcessSubprocessConcurrency ?? 4)',
    )
  })

  // RFC-266 T-L —— 首次给「脚本节点取哪把闸」上锁。在此之前**没有任何测试**
  // 锁定它，所以 RFC-253 把脚本接在 agent 池上跑了整个生命周期都没人发现。
  test('the script branch acquires the script pool, never the agent pool', () => {
    const scheduler = schedulerSrc()
    const start = scheduler.indexOf('async function runScriptNode(')
    const end = scheduler.indexOf('async function runOneScriptAttempt(')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = scheduler.slice(start, end)
    expect(body).toContain('scriptSem.acquire()')
    expect(body).not.toContain('agentSem.acquire()')
  })
})
