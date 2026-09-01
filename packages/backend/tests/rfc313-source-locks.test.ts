// RFC-313 T10 — 源码层兜底锁。
//
// 为什么这条测试存在：本 RFC 引入的是**预算**类逻辑，而预算最容易在后续 RFC 里被
// 「顺手多给一次」——改动看起来无害、跑起来也全绿（多试一次通常只是更慢），但它悄悄
// 抬高了每个节点的最坏成本上限，而那正是用户逐项确认过的东西（最坏 attempt 4→8）。
// 单测覆盖不到「有人在别处又加了一次预算」，只有源码层断言能拦住。
//
// 锁三件事：
//   ① 形状判定只有一个 TaskExecution 定义点；neutral cap 只有一个 platform 定义点；
//   ② scheduler.ts 里 restartsUsed 只被纯函数的返回值推进，没有第二处自增；
//   ③ 告知段只有 renderSessionRestartNotice 一个出口（不许有人再拼一份文案）。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')
const SHARED_SRC = resolve(import.meta.dir, '..', '..', 'shared', 'src')
const read = (...seg: string[]): string => readFileSync(resolve(...seg), 'utf8')
const occurrences = (src: string, needle: string): number => src.split(needle).length - 1
const readNodeMechanics = (): string =>
  read(BACKEND_SRC, 'modules', 'task-execution', 'composition', 'nodeMechanics.ts')

describe('RFC-313 源码层锁', () => {
  test('decideRetryShape 只在 TaskExecution domain 定义一次', () => {
    const shared = read(SHARED_SRC, 'prompt.ts')
    expect(shared).not.toContain('export function decideRetryShape')

    const policy = read(
      BACKEND_SRC,
      'modules',
      'task-execution',
      'domain',
      'envelopeRetryPolicy.ts',
    )
    expect(occurrences(policy, 'export function decideRetryShape')).toBe(1)

    const scheduler = read(BACKEND_SRC, 'services', 'scheduler.ts')
    const nodeMechanics = readNodeMechanics()
    expect(scheduler).not.toContain('function decideRetryShape')
    expect(scheduler).not.toContain('decideRetryShape({')
    expect(occurrences(nodeMechanics, 'decideRetryShape({')).toBe(1)
  })

  test('node mechanics 里没有第二处推进升级预算的地方', () => {
    const nodeMechanics = readNodeMechanics()
    // 唯一的推进方式是把纯函数返回的 next 整体赋回去。任何 `restartsUsed +=` /
    // `restartsUsed++` 都意味着有人绕过了判定单源。
    expect(nodeMechanics).not.toContain('restartsUsed +=')
    expect(nodeMechanics).not.toContain('restartsUsed++')
    expect(occurrences(nodeMechanics, 'retryShapeState = next')).toBe(1)
  })

  test('attempt 上限只由 retryAttemptCap 导出，agent 线不再自己拼预算', () => {
    const nodeMechanics = readNodeMechanics()
    expect(occurrences(nodeMechanics, 'retryAttemptCap(followupBudget, restartBudget)')).toBe(1)
    const platform = read(BACKEND_SRC, 'platform', 'contracts', 'retryAttemptCap.ts')
    expect(occurrences(platform, 'export function retryAttemptCap(')).toBe(1)
    expect(occurrences(platform, 'export function retryAttemptCapFromPolicy(')).toBe(1)
    expect(occurrences(platform, '(1 + normalizeBudget(followupBudget)) *')).toBe(1)
    // 公式必须只在 platform contract；node mechanics 里再出现就是复制了单源。
    expect(nodeMechanics).not.toContain('(1 + followupBudget) * (1 + restartBudget)')
    expect(read(SHARED_SRC, 'prompt.ts')).not.toContain('export function retryAttemptCap')
  })

  test('会话升级告知只有一个渲染出口', () => {
    const shared = read(SHARED_SRC, 'prompt.ts')
    expect(occurrences(shared, 'export function renderSessionRestartNotice')).toBe(1)
    const runner = read(BACKEND_SRC, 'services', 'runner.ts')
    // runner 只透传结构化的 reason，不许自己拼文案。
    expect(runner).not.toContain('Note on an earlier attempt')
    expect(occurrences(runner, 'priorSessionAbandoned:')).toBe(1)
  })

  test('升级审计事件只有一个发射点', () => {
    const nodeMechanics = readNodeMechanics()
    // 数**发射点**（payload 模板字面量）而不是文本出现次数——doc 注释里提到这个 tag
    // 是正常的，不该让锁转红（实现门修复期实撞：新增的前缀说明里列了三个 tag）。
    expect(occurrences(nodeMechanics, 'payload: `[rfc313/session-restart]')).toBe(1)
  })

  test('框架自写的 text 审计事件全部带统一前缀，且被排除出「模型说过话」的计数', () => {
    // 实现门 P1-2：三个 producer 与模型输出共用 kind='text'，且都写在**新铸的那一行**
    // 上。不过滤的话，第 1 次之后每一次 attempt 的 agentTextCount 恒 ≥1，RFC-042 那条
    // 「模型必须说过话」的判据当场失效——而 RFC-313 的整条形状判定正架在它上面。
    // 这条锁两件事：①任何新增的框架审计载荷都必须落在同一前缀下（否则又漏一个）；
    // ②计数查询确实带着排除条件（有人日后"简化"掉它就红）。
    const nodeMechanics = readNodeMechanics()
    expect(nodeMechanics).toContain("export const FRAMEWORK_AUDIT_EVENT_PREFIX = '[rfc'")

    // 所有以 `payload: \`[...\`` 形式写进 nodeRunEvents 的框架事件标签
    const tags = [...nodeMechanics.matchAll(/payload: `(\[[a-z0-9/-]+\])/g)].map((m) => m[1]!)
    expect(tags.length).toBeGreaterThanOrEqual(3) // rfc042 / rfc049 / rfc313
    for (const tag of tags) {
      expect(tag.startsWith('[rfc'), `框架审计载荷 ${tag} 未落在统一前缀下`).toBe(true)
    }

    // 计数查询必须带排除条件
    expect(nodeMechanics).toContain(
      'persistence.countAgentTextEvents(nodeRunId, FRAMEWORK_AUDIT_EVENT_PREFIX)',
    )
    const sqlitePersistence = read(
      BACKEND_SRC,
      'modules',
      'task-execution',
      'infrastructure',
      'sqliteNodeExecutionPersistence.ts',
    )
    const postgresqlPersistence = read(
      BACKEND_SRC,
      'modules',
      'task-execution',
      'infrastructure',
      'postgresqlNodeExecutionPersistence.ts',
    )
    for (const persistence of [sqlitePersistence, postgresqlPersistence]) {
      expect(persistence).toContain('notLike(nodeRunEvents.payload, `${frameworkPrefix}%`)')
    }
    // 同样数**真实代码用点**而不是文本命中——doc 里的 {@link} 提及是正常的。
    expect(occurrences(nodeMechanics, 'export const FRAMEWORK_AUDIT_EVENT_PREFIX')).toBe(1)
    expect(occurrences(nodeMechanics, 'FRAMEWORK_AUDIT_EVENT_PREFIX)')).toBe(1)
  })
})
