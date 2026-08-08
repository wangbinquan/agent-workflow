// RFC-271 T6g —— `RefResolution` 契约本身的锁，以及**四处失败归属**的收口证据。
//
// 引用模型归一化之后，最容易悄悄坏掉的不是解析结果，而是**归属**：四个位点看起来
// 都是「解析一个 agent 引用」，实测行为却各不相同。把它们收成一个 resolver 时，
// 只要有一处跟着别人走，故障就从「这个节点失败」变成「整个任务 scheduler error」
// 或者反过来「本该报错却静默跳过」。
//
// 四处（design §1.1c'' / plan T6d 的实测表）：
//
//   位点                          缺 agentId              查不到 agent 行
//   ① 主派发 agent-single         节点失败                节点失败
//                                 agent-identity-missing   agent-not-found
//   ② wrapper-fanout inner 水合   静默跳过（continue）    静默跳过（continue）
//   ③ shard source 为空           wrapper 仍**成功**（wrapper-fanout-empty）
//   ④ shard source 非空但失败     wrapper 标 failed
//
// resolver 的行为契约在 `rfc271-runtime-ref.test.ts`；本文件锁的是「四处调用点
// 各自映射到自己的归属」这件事——运行时巨型组件难直接覆盖，按仓规保留源码层断言。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DISPATCH_CALL_POLICY,
  EXPORT_CALL_POLICY,
  FANOUT_HYDRATE_CALL_POLICY,
  PREVIEW_CALL_POLICY,
  REF_DOMAIN_POLICIES,
  VALIDATE_CALL_POLICY,
  type RefCallPolicy,
} from '@agent-workflow/shared'

const SRC = (...p: string[]) => join(import.meta.dir, '..', 'src', ...p)

/** 行注释 / 块注释一律剥掉——源码层断言只该看代码。 */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n')
const scheduler = readFileSync(SRC('services', 'scheduler.ts'), 'utf8')

describe('五条解析属性 —— 域级 2 条 + 调用级 3 条，缺一不可', () => {
  test('每个域都同时定死 freeze 与 aclAt（新增域忘了填会让这条红）', () => {
    for (const [domain, policy] of Object.entries(REF_DOMAIN_POLICIES)) {
      expect(['per-task', 'none'], `${domain}.freeze`).toContain(policy.freeze)
      expect(['launch', 'save', 'none'], `${domain}.aclAt`).toContain(policy.aclAt)
    }
    // 五个域全在表里（`call` 是唯一冻结的那个）。注意「六个 wire codec」与
    // 「五个域策略」不是同一件事：`bundle` 一个域有 identity / agent-skill /
    // call 三种槽位编码，域级策略只有一条。
    expect(Object.keys(REF_DOMAIN_POLICIES).sort()).toEqual([
      'bundle',
      'call',
      'importSelector',
      'intent',
      'runtime',
    ])
    expect(REF_DOMAIN_POLICIES.call.freeze).toBe('per-task')
    expect(REF_DOMAIN_POLICIES.runtime.freeze).toBe('none')
  })

  test('每个已定案的调用实例都同时定死 purpose / onMissing / failureOwner', () => {
    const named: Array<[string, RefCallPolicy]> = [
      ['export', EXPORT_CALL_POLICY],
      ['dispatch', DISPATCH_CALL_POLICY],
      ['fanout-hydrate', FANOUT_HYDRATE_CALL_POLICY],
      ['validate', VALIDATE_CALL_POLICY],
      ['preview', PREVIEW_CALL_POLICY],
    ]
    for (const [label, p] of named) {
      expect(['dispatch', 'validate', 'preview', 'export'], `${label}.purpose`).toContain(p.purpose)
      expect(['fail', 'skip', 'dangle'], `${label}.onMissing`).toContain(p.onMissing)
      expect(['node', 'wrapper', 'task', 'caller'], `${label}.failureOwner`).toContain(
        p.failureOwner,
      )
    }
  })

  test('域级与调用级**不重叠**：freeze/aclAt 不出现在调用策略里，反之亦然', () => {
    // 两组属性混进同一个对象，就等于宣称「这个域永远只有一种调用方式」——
    // dependsOn 的 fail / skip 之别正是反例。
    const call = DISPATCH_CALL_POLICY as unknown as Record<string, unknown>
    expect(call.freeze).toBeUndefined()
    expect(call.aclAt).toBeUndefined()
    const domain = REF_DOMAIN_POLICIES.call as unknown as Record<string, unknown>
    expect(domain.onMissing).toBeUndefined()
    expect(domain.failureOwner).toBeUndefined()
  })

  test('导出域是 dangle 不是 fail —— 与 AC-7b「零匹配与全不可见同形」绑死', () => {
    expect(EXPORT_CALL_POLICY.onMissing).toBe('dangle')
    expect(EXPORT_CALL_POLICY.failureOwner).toBe('caller')
    // dispatch 与它相反：导出可以留悬空，派发不行。
    expect(DISPATCH_CALL_POLICY.onMissing).toBe('fail')
  })
})

describe('四处失败归属：调用点各用各的策略，且映射逐条不变', () => {
  test('① 主派发用 DISPATCH，两个错误码分开（missing ≠ 查不到行）', () => {
    expect(scheduler).toContain('resolveNodeAgentRef(db, node, DISPATCH_CALL_POLICY)')
    // 两个分支必须都在，且 `missing` 那支先判——合并会让两个码塌成一个。
    expect(scheduler).toMatch(
      /resolvedAgent\.reason === 'missing'[\s\S]{0,200}agent-identity-missing/,
    )
    expect(scheduler).toContain("message: 'agent-not-found'")
  })

  test('② fanout inner 水合用 FANOUT_HYDRATE，且解析失败**不产生任何失败返回**', () => {
    const idx = scheduler.indexOf('resolveNodeAgentRef(db, rec, FANOUT_HYDRATE_CALL_POLICY)')
    expect(idx).toBeGreaterThan(0)
    // 紧随其后只有「成功才写进 map」，没有 return failed / throw。
    const after = scheduler.slice(idx, idx + 240)
    expect(after).toContain('if (resolved.ok)')
    expect(after).not.toContain("kind: 'failed'")
    expect(after).not.toContain('throw ')
  })

  test('③④ wrapper 归属：source 为空仍成功、非空失败才标 failed', () => {
    // 空 source 走 ok 分支（`wrapper-fanout-empty` 不是错误码，是成功摘要）。
    expect(scheduler).toContain(
      "return { kind: 'ok', summary: '', message: 'wrapper-fanout-empty' }",
    )
    // 非空路径上确有 wrapper 级 failed（与 node 级失败是两种归属）。
    expect(scheduler).toContain('markWrapperTerminal(')
  })

  test('resolver **绝不 throw** —— 直接抛会被 runScope 冒泡成任务级 scheduler error', () => {
    const runtimeRef = readFileSync(SRC('services', 'ref', 'runtimeRef.ts'), 'utf8')
    // ⚠️ 先剥注释再扫：这个文件的注释里就写着「绝不 throw」，裸文本扫描会自己撞
    // 上自己（同一个坑在 RFC-217 的架构守卫上踩过）。
    const code = stripComments(runtimeRef)
    expect(code).not.toContain('throw')
    expect(code).toContain('Promise<RefResult<Agent>>')
  })
})

describe('收口证据：agentId 只有一个读取点', () => {
  test('scheduler 不再自己 getAgentById(节点字段)', () => {
    expect(scheduler).not.toMatch(/await getAgentById\(db, (aid|agentIdRef)\b/)
  })

  test('fanout 的 dedup key 与主派发共用同一条判据', () => {
    expect(scheduler).toContain('fanoutInnerAgentRefKey(node)')
  })
})
