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
//
// ⚠️ RFC-317 T43 改写了本文件的第一个 describe。原来那三条断言的是
// `REF_DOMAIN_POLICIES` / `EXPORT_CALL_POLICY` 的字面量对着自己——
// `expect(REF_DOMAIN_POLICIES.call.freeze).toBe('per-task')` 这种同义反复，
// 把任何一条常量改掉，测试跟着改就照绿。R6 实测两张表**零消费者**（连一个把它
// 当实参传出去的调用点都没有），已随 T43 删除；余下四条 policy 的真实契约是
// 「每条都必须在生产源码里被当作实参传给某个 resolver 调用点」——那才是
// 可证伪的性质：删掉任意一个调用点，下面这条就红。

//
// 覆盖验收条款：AC-B2c（统一引用模型）/ AC-B2e（解析契约调用级三属性；域级两属性
//   随 T43 删除，理由见 `shared/src/ref/resolution.ts` 顶注）/ AC-B2f（调度器不裸读）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  DISPATCH_CALL_POLICY,
  FANOUT_HYDRATE_CALL_POLICY,
  PREVIEW_CALL_POLICY,
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
const wrapperMechanics = readFileSync(
  SRC('modules', 'task-execution', 'composition', 'wrapperMechanics.ts'),
  'utf8',
)
const fanoutStrategy = readFileSync(
  SRC('modules', 'task-execution', 'engine', 'wrapper', 'fanoutStrategy.ts'),
  'utf8',
)
const nodeMechanics = readFileSync(
  SRC('modules', 'task-execution', 'composition', 'nodeMechanics.ts'),
  'utf8',
)

/** 递归收集一棵源码树里的 `.ts`。 */
function collectTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) collectTs(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/**
 * 一条 policy 在生产源码里**被当作实参传出去**的次数。
 *
 * 只数 import 语句之外、注释之外的出现——import 进来却没用等于没消费，
 * 而注释里提一嘴更不算（这个坑 RFC-217 的架构守卫踩过：裸文本扫描会撞上
 * 描述自己的那行注释）。
 */
function markerCallSites(symbol: string): string[] {
  const hits: string[] = []
  for (const file of collectTs(SRC())) {
    const code = stripComments(readFileSync(file, 'utf8'))
    const used = code
      .split('\n')
      .some((line) => line.includes(symbol) && !/^\s*(import|export)\b/.test(line))
    if (used) hits.push(file)
  }
  return hits
}

describe('调用级三属性 —— active legacy closure policies 必须真的被调用点消费', () => {
  test('validate / preview policy 各自至少有一个生产调用点（删掉调用点 ⇒ 这条红）', () => {
    // `resolveNodeAgentRef` 拿到 policy 后 `void call`——它是**文档标记**，
    // 真正的分支在调用点。标记的价值全在「被传出去」这一下：一条谁都不传的
    // policy 就是纯装饰，正是 T43 删掉那两条的判据。
    const named: Array<[string, RefCallPolicy]> = [
      ['VALIDATE_CALL_POLICY', VALIDATE_CALL_POLICY],
      ['PREVIEW_CALL_POLICY', PREVIEW_CALL_POLICY],
    ]
    for (const [name, policy] of named) {
      expect(
        markerCallSites(name).length,
        `${name} 没有任何生产调用点——它已经退化成纯装饰声明，要么接回调用点、要么删掉`,
      ).toBeGreaterThan(0)
      // 三属性齐备（缺字段是编译错误，这里锁的是取值落在既定词表内）。
      expect(['dispatch', 'validate', 'preview'], `${name}.purpose`).toContain(policy.purpose)
      expect(['fail', 'skip', 'dangle'], `${name}.onMissing`).toContain(policy.onMissing)
      expect(['node', 'wrapper', 'task', 'caller'], `${name}.failureOwner`).toContain(
        policy.failureOwner,
      )
    }
  })

  test('派发与水合的 legacy policy 取值仍相反，但 mechanics 已切到同一 catalog session', () => {
    // 这两条不是「常量等于自己」——它锁的是 R7-P1-5 那条实测差异：同一种解析，
    // 主派发失败要记到 node、fanout 水合失败要记到 wrapper。两者一旦被"统一"，
    // 故障归属就整个塌掉，而运行期看不出来。
    expect(DISPATCH_CALL_POLICY.onMissing).toBe('fail')
    expect(DISPATCH_CALL_POLICY.failureOwner).toBe('node')
    expect(FANOUT_HYDRATE_CALL_POLICY.onMissing).toBe('skip')
    expect(FANOUT_HYDRATE_CALL_POLICY.failureOwner).toBe('wrapper')
    // RFC-345 T4a 后，production mechanics 不再携带 legacy resolver policy；
    // 同一 task resource session 返回 closed typed failure，调用点只决定归属。
    expect(nodeMechanics).not.toContain('DISPATCH_CALL_POLICY')
    expect(wrapperMechanics).not.toContain('FANOUT_HYDRATE_CALL_POLICY')
    expect(nodeMechanics).toContain('state.taskExecutionResources.injection(agentRef.id)')
    expect(wrapperMechanics).toContain('state.taskExecutionResources.injection(agentId)')
  })
})

describe('四处失败归属：调用点各用各的策略，且映射逐条不变', () => {
  test('① 主派发用 catalog session，两个错误码分开（missing ≠ 查不到行）', () => {
    expect(nodeMechanics).toContain('const agentRef = agentRefOfNode(node)')
    expect(nodeMechanics).toContain('state.taskExecutionResources.injection(agentRef.id)')
    // 两个分支必须都在，且 `missing` 那支先判——合并会让两个码塌成一个。
    expect(nodeMechanics).toMatch(
      /resolvedAgent\.reason === 'missing'[\s\S]{0,200}agent-identity-missing/,
    )
    expect(nodeMechanics).toContain("message: 'agent-not-found'")
  })

  test('② fanout inner 水合复用 catalog session，失败作为 wrapper data-port 结果返回', () => {
    const idx = wrapperMechanics.indexOf('async resolveFanoutAgent(node)')
    expect(idx).toBeGreaterThan(0)
    const after = wrapperMechanics.slice(idx, idx + 520)
    expect(after).toContain('state.taskExecutionResources.injection(agentId)')
    expect(after).toContain("resolution.kind === 'ok'")
    expect(after).toContain(': resolution')
    expect(after).not.toContain('throw ')
  })

  test('③④ wrapper 归属：source 为空仍成功、非空失败才标 failed', () => {
    // 空 source 走 ok 分支（`wrapper-fanout-empty` 不是错误码，是成功摘要）。
    expect(fanoutStrategy).toContain("message: 'wrapper-fanout-empty'")
    // 非空路径上确有 wrapper 级 failed（与 node 级失败是两种归属）。
    expect(fanoutStrategy).toMatch(/wrapperSettlement\(\s*'failed'/)
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
  test('node execution owners 不再自己 getAgentById(节点字段)', () => {
    expect(`${wrapperMechanics}\n${nodeMechanics}`).not.toMatch(
      /await getAgentById\(db, (aid|agentIdRef)\b/,
    )
  })

  test('fanout 的 dedup key 与主派发共用同一条判据', () => {
    expect(wrapperMechanics).toContain('fanoutInnerAgentRefKey(node)')
  })
})
