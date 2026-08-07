// RFC-266 —— 并发参数保存即生效（含运行中任务与排队中节点）。
//
// 为什么这些测试存在：用户报「最大并发节点数改了也不立即生效」。核实属实——
// 全局闸虽是 daemon 级共享单例、`Semaphore.resize` 本身也正确（增容 drain 排队者、
// 缩容不抢占），但**唯一的 resize 调用方是 runTask**，所以保存的新值要等下一个
// 任务启动才被套上；没有新任务启动就永远不生效，正在排队等名额的节点也不会被放行。
// 这里锁定 PUT /api/config 作为线性化点：响应可观测时，三个池（agent / script /
// 每任务扇出）都已按新值生效。
//
// 另一条同等重要的断言：`deps.db` 必须与调度器持有的 DbClient 是**同一个对象**，
// 否则 WeakMap 键控会命中另一份预算，热生效表面成功、实际改不到跑任务的那把闸。

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { loadConfig } from '@/config'
import { createInMemoryDb, type DbClient } from '@/db/client'
import { createApp } from '@/server'
import { getNodePoolSemaphore } from '@/services/processNodeConcurrency'
import { getTaskFanoutSem, gcTaskFanoutSem, taskFanoutPoolCount } from '@/services/taskFanoutPools'
import { seedBuiltinRuntimes, updateRuntime } from '@/services/runtimeRegistry'

const TOKEN = 'd'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Harness {
  db: DbClient
  configPath: string
  put: (patch: Record<string, unknown>) => Promise<Response>
}

async function harness(slug: string): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), `rfc266-${slug}-`))
  roots.push(root)
  const configPath = join(root, 'config.json')
  loadConfig(configPath)
  const db = createInMemoryDb(MIGRATIONS)
  await seedBuiltinRuntimes(db)
  await updateRuntime(db, 'opencode', { model: 'openai/gpt-5' })
  const app = createApp({
    token: TOKEN,
    configPath,
    opencodeVersion: null,
    dbVersion: 1,
    db,
  })
  return {
    db,
    configPath,
    put: async (patch) =>
      await app.request('/api/config', {
        method: 'PUT',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }),
  }
}

describe('RFC-266 concurrency hot-apply', () => {
  test('PUT /api/config resizes both daemon pools before responding', async () => {
    const h = await harness('pools')
    // 模拟一个已在跑的 daemon：两把闸已按旧值建立。
    const agent = getNodePoolSemaphore(h.db, 'agent', 4)
    const script = getNodePoolSemaphore(h.db, 'script', 4)

    const res = await h.put({ maxConcurrentNodes: 9, maxConcurrentScriptNodes: 2 })
    expect(res.status).toBe(200)

    // 响应可观测时即已生效，且是同一实例被 resize（换实例 = 预算分裂）。
    expect(agent.capacity).toBe(9)
    expect(script.capacity).toBe(2)
    expect(getNodePoolSemaphore(h.db, 'agent', 9)).toBe(agent)
    expect(getNodePoolSemaphore(h.db, 'script', 2)).toBe(script)
    expect(loadConfig(h.configPath).maxConcurrentScriptNodes).toBe(2)
  })

  test('growing releases nodes ALREADY QUEUED for a slot — no launch required', async () => {
    const h = await harness('grow')
    const agent = getNodePoolSemaphore(h.db, 'agent', 1)
    const holder = await agent.acquire()

    let queuedEntered = false
    const queued = agent.acquire().then((release: () => void) => {
      queuedEntered = true
      return release
    })
    await Promise.resolve()
    expect(queuedEntered).toBe(false)

    const res = await h.put({ maxConcurrentNodes: 2 })
    expect(res.status).toBe(200)

    const releaseQueued = await queued // 未释放任何持有者就被放行
    expect(queuedEntered).toBe(true)
    releaseQueued()
    holder()
  })

  test('shrinking never preempts an in-flight node and does not refill past the new cap', async () => {
    const h = await harness('shrink')
    const agent = getNodePoolSemaphore(h.db, 'agent', 2)
    const r1 = await agent.acquire()
    const r2 = await agent.acquire()

    expect((await h.put({ maxConcurrentNodes: 1 })).status).toBe(200)
    expect(agent.capacity).toBe(1)

    let thirdEntered = false
    const third = agent.acquire().then((release: () => void) => {
      thirdEntered = true
      return release
    })
    r1() // 释放一个 → inUse 仍等于新容量，不得补位
    await Promise.resolve()
    expect(thirdEntered).toBe(false)

    r2()
    const r3 = await third
    expect(thirdEntered).toBe(true)
    r3()
  })

  test('a RUNNING task’s fan-out sub-pool is resized too', async () => {
    const h = await harness('fanout')
    const taskId = 'rfc266-hot-apply-task'
    const sem = getTaskFanoutSem(taskId, 4)

    expect((await h.put({ multiProcessSubprocessConcurrency: 7 })).status).toBe(200)
    expect(sem.capacity).toBe(7)
    expect(getTaskFanoutSem(taskId, 7)).toBe(sem)

    // 注册表是模块级 Map，同进程内跨测试文件共享 —— 断言「本条目已回收」而不是
    // 「全局计数归零」，否则别的测试文件留下的条目会让这条假红。
    const before = taskFanoutPoolCount()
    gcTaskFanoutSem(taskId)
    expect(taskFanoutPoolCount()).toBe(before - 1)
    expect(getTaskFanoutSem(taskId, 7)).not.toBe(sem)
    gcTaskFanoutSem(taskId)
  })

  test('an unrelated patch leaves the pools at their configured capacities', async () => {
    const h = await harness('unrelated')
    const agent = getNodePoolSemaphore(h.db, 'agent', 4)
    const script = getNodePoolSemaphore(h.db, 'script', 4)
    expect((await h.put({ logLevel: 'debug' })).status).toBe(200)
    // 未变的键由 mergeDefaults 保持既有值 → resize 到同一容量，实例不换。
    expect(agent.capacity).toBe(4)
    expect(script.capacity).toBe(4)
  })

  test('the route reaches the SAME DbClient the scheduler keys its pools by', () => {
    // WeakMap 键控要求路由与调度器共用同一个 db 对象；cli/start.ts 只 openDb 一次，
    // 同时喂给 createApp 与 buildStartTaskDeps。若哪天有人在中间包一层新对象，
    // 热生效会静默失效（改到另一份预算），故在源码层锁死这条接线。
    const startSrc = readFileSync(resolve(import.meta.dir, '..', 'src', 'cli', 'start.ts'), 'utf8')
    expect(startSrc.match(/openDb\(\{/g)).toHaveLength(1)
    const routesSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'routes', 'config.ts'),
      'utf8',
    )
    expect(routesSrc).toContain('resizeAllNodePools(deps.db, {')
    expect(routesSrc).toContain(
      'resizeAllTaskFanoutSems(updated.multiProcessSubprocessConcurrency)',
    )
  })
})
