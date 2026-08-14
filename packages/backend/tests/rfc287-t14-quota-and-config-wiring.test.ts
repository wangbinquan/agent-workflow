// RFC-287 T14 实现门 —— G4 配额面与配置接线的三条真缺陷。
//
// 共同点：它们都属于「配置改了但不生效」这一族——本 RFC 的 G4 本来就是冲着这一族
// 去的（T10 已修两条），实现门又挖出第三条同形的。之所以值得单独立文件，是因为
// 这类缺陷在功能测试里**永远表现为通过**：接口返回 200、值也写进了库，只有真去看
// 「排队的人有没有被放行」才看得见。

import { describe, expect, test, beforeEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ensureChildTaskBudget,
  setChildTaskBudgetCapacity,
  resetChildTaskBudgetForTests,
} from '@/services/execution/childBudget'
import { createInMemoryDb } from '@/db/client'
import { MIGRATIONS } from './migration-freeze'

describe('RFC-287 T14 — 调大子任务配额必须立刻唤醒已排队者', () => {
  beforeEach(() => {
    resetChildTaskBudgetForTests()
  })

  // 修复前：`setChildTaskBudgetCapacity` 只改变量、不重扫等待队列。于是把上限从 1
  // 调到 2 对**已经在排队**的调用毫无作用——它得等某个子任务恰好发生生命周期变化
  // 才被顺带放行；而这期间**新来**的调用反而能直接拿到空出来的名额。等待者饿死、
  // 插队者得利，公平性正好反了。
  test('容量 1→2：排队中的 acquire 立刻被放行，不必等生命周期事件', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const budget = await ensureChildTaskBudget(db, () => 1)

    // 占满唯一名额。
    const first = await budget.acquire([])
    expect(first).not.toBeNull()

    // 第二个请求进入等待队列——此刻绝不能完成。
    let settled = false
    const queued = budget.acquire([]).then((h) => {
      settled = true
      return h
    })
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 30))
    expect(settled).toBe(false)

    // 管理员在设置页把上限调到 2。
    setChildTaskBudgetCapacity(2)

    // **不**制造任何子任务生命周期事件——单靠这次配置变更就该放行。
    const handle = await Promise.race([
      queued,
      new Promise((r) => setTimeout(() => r('TIMEOUT'), 2_000)),
    ])
    expect(handle).not.toBe('TIMEOUT')
    expect(settled).toBe(true)
  })

  test('调小容量不放行任何人（scan 无副作用，方向不必区分）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const budget = await ensureChildTaskBudget(db, () => 1)
    const first = await budget.acquire([])
    expect(first).not.toBeNull()

    let settled = false
    void budget.acquire([]).then(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 30))

    setChildTaskBudgetCapacity(1) // 同值
    await new Promise((r) => setTimeout(r, 50))
    expect(settled).toBe(false)
  })

  // 单例的 `counted` 集合是从**某一个库**重建出来的；拿它去服务另一个库，等于用甲
  // 的在跑数去限乙的并发。生产里 daemon 只有一个库，但并行用不同库的测试会静默
  // 串扰——那种串扰表现为「另一个用例的配额莫名其妙变了」，极难定位。
  test('换 DbClient 时单例必须重建，不得继续绑在旧库上', async () => {
    const dbA = createInMemoryDb(MIGRATIONS)
    const dbB = createInMemoryDb(MIGRATIONS)
    const a = await ensureChildTaskBudget(dbA, () => 1)
    const b = await ensureChildTaskBudget(dbB, () => 1)
    expect(b).not.toBe(a)
    // 同一个库再取则复用（单例语义本身没被破坏）。
    const b2 = await ensureChildTaskBudget(dbB, () => 1)
    expect(b2).toBe(b)
  })
})

describe('RFC-287 T14 — 配置漏斗的导出类型必须声明新字段', () => {
  // RFC-284 T30 的教训：`scriptInterpreters` / `scriptDepsInstallTimeoutMs` 因为
  // 「只赋值、类型没声明」被对象 spread 静默丢弃，管理员配置生产从未生效。G6/G7 的
  // 两个新字段一度重蹈覆辙——只声明在私有 `out` 类型里，导出签名看不见它们；运行时
  // 靠 spread 恰好还带得过去，下一次重构就断线且无人察觉。
  //
  // 上一版源码锁只断言 `cloneTimeoutMs?: number` 在文件里出现过——私有类型里那份就
  // 能满足它，等于没锁住。这里改成锁**导出函数的返回类型**那一段。
  test('resolveLaunchRuntimeConfig 的返回类型含 cloneTimeoutMs 与 gitBaselineSyncWindowMs', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'launchRuntimeConfig.ts'),
      'utf8',
    )
    const start = src.indexOf('export function resolveLaunchRuntimeConfig')
    expect(start).toBeGreaterThan(0)
    // 返回类型从签名的 `): {` 起，到第一个顶格 `} {`（函数体开始）止。
    const sigStart = src.indexOf('): {', start)
    const bodyStart = src.indexOf('\n} {', sigStart)
    expect(sigStart).toBeGreaterThan(0)
    expect(bodyStart).toBeGreaterThan(sigStart)
    const returnType = src.slice(sigStart, bodyStart)
    expect(returnType).toContain('cloneTimeoutMs?: number')
    expect(returnType).toContain('gitBaselineSyncWindowMs?: number')
  })
})
