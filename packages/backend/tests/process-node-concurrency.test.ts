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

const nodeMechanicsSrc = (): string =>
  readFileSync(
    resolve(
      import.meta.dir,
      '..',
      'src',
      'modules',
      'task-execution',
      'composition',
      'nodeMechanics.ts',
    ),
    'utf8',
  )
const taskEngineApplicationSrc = (): string =>
  readFileSync(
    resolve(
      import.meta.dir,
      '..',
      'src',
      'modules',
      'task-execution',
      'composition',
      'taskEngineApplication.ts',
    ),
    'utf8',
  )

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
    resizeAllNodePools(daemonScope, { agent: 9, script: 2, 'code-host': 8 })
    expect(agent.capacity).toBe(9)
    expect(script.capacity).toBe(2)
    // 实例不得被替换 —— 换实例 = 预算分裂（本模块存在的理由）。
    expect(getNodePoolSemaphore(daemonScope, 'agent', 9)).toBe(agent)
    expect(getNodePoolSemaphore(daemonScope, 'script', 2)).toBe(script)
  })

  test('resizeAllNodePools on a cold daemon creates both pools at the saved capacity', () => {
    const daemonScope = {}
    resizeAllNodePools(daemonScope, { agent: 3, script: 5, 'code-host': 8 })
    expect(getNodePoolSemaphore(daemonScope, 'agent', 3).capacity).toBe(3)
    expect(getNodePoolSemaphore(daemonScope, 'script', 5).capacity).toBe(5)
  })

  test('task engine application uses the pool registry and never constructs a per-task pool', () => {
    const application = taskEngineApplicationSrc()
    // RFC-287 T10（G4-C9）：三处池获取都带上 'seed-only'——任务启动只播种、不改写
    // daemon 级容量。少了它，一个带旧 opts 的子任务启动就会把用户刚在设置页改好的
    // 并发数静默改回去（resize-on-read）。锁「必须带 seed-only」而不只是「调了这个
    // 函数」，否则回退到默认 'set' 无人察觉。
    // 用「相邻性 + 身份」而不是定长文本：prettier 会按行宽把长调用折成多行
    // （code-host 那条就被折了），定长锚一改格式就失配——本文件里 RFC-292 那条锁
    // 已经吃过同一刀。这里按池名定位，再要求它的参数里同时出现配置键与 'seed-only'。
    for (const [kind, cfgKey] of [
      ['agent', 'maxConcurrentNodes'],
      ['script', 'maxConcurrentScriptNodes'],
      ['code-host', 'maxConcurrentCodeHostCalls'],
    ] as const) {
      const call = new RegExp(
        `getNodePoolSemaphore\\(\\s*opts\\.processConcurrencyScope,\\s*'${kind}',\\s*opts\\.${cfgKey}[^)]*'seed-only'`,
      )
      expect(
        call.test(application),
        `${kind} 池必须以 'seed-only' 取（否则子任务会撤销配置）`,
      ).toBe(true)
    }
    expect(application).not.toContain('new Semaphore(opts.maxConcurrentNodes ?? 4)')
    expect(application).not.toContain('new Semaphore(opts.maxConcurrentScriptNodes ?? 4)')
    // RFC-266: 扇出子池也不再 per-task new（否则设置改动到不了运行中的任务）。
    expect(application).not.toContain('new Semaphore(opts.multiProcessSubprocessConcurrency ?? 4)')
    expect(application).toContain(
      'getTaskFanoutSem(taskId, opts.multiProcessSubprocessConcurrency ?? 4)',
    )
  })

  // RFC-266 T-L —— 首次给「脚本节点取哪把闸」上锁。在此之前**没有任何测试**
  // 锁定它，所以 RFC-253 把脚本接在 agent 池上跑了整个生命周期都没人发现。
  test('the script branch acquires the script pool, never the agent pool', () => {
    const nodeMechanics = nodeMechanicsSrc()
    const start = nodeMechanics.indexOf('async function runScriptNode(')
    const end = nodeMechanics.indexOf('async function runOneScriptAttempt(')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = nodeMechanics.slice(start, end)
    // RFC-287 T6：许可的取/放已收进装配骨架，各线改为在 spec 上**声明**用哪个池。
    // 断言随之从「函数体里调了谁的 acquire」改成「声明的池列表是什么」——比原来
    // 更强：原来只查了「含 A、不含 B」，现在把整张池清单钉死（多挂一个池也红）。
    const pools = /pools: \[([^\]]*)\]/.exec(body)
    expect(pools, '脚本线必须在 spec 上声明它用的池').not.toBeNull()
    expect(pools![1]!.trim()).toBe('scriptSem')
    // 反向：本线任何形态都不得碰 agent 池。
    expect(body).not.toContain('agentSem')
  })
})
