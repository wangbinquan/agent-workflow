// RFC-287 T9（G3）—— **刻意豁免的显式化** + 装配散写的**终局灭绝锁**。
//
// 为什么这两件事必须一起锁：T3-T8 把五条装配线（L1 工作组主机 / L4 agent /
// L5 分片 / L6 聚合 / L7 脚本）收进 `runAssembly` 之后，剩下四条线**故意**没迁。
// 只写「谁迁了」是不够的——后来者看到「五条走骨架、四条不走」的不对称，最自然的
// 反应就是「顺手补齐」，而那四条每一条不迁都有硬理由，补齐会实打实地改变死锁
// 性质或领养语义。所以：
//
//   ① 四条豁免各有一条**说明理由的锁**（改动它们时先撞到理由，而不是先撞到红）；
//   ② 灭绝锁把「装配散写归零」**限定在五条迁移线的函数体区间**，并对三个存续区
//      显式挖洞（L8 整线 / wrapper 便车 / 恢复 replay 段）——不挖洞的话，灭绝锁
//      会把这三处逼成「必须迁」，正好与 ① 打架。
//
// 依据锚见 design.md §5 的豁免表与「灭绝锁挖洞清单（P2-3）」。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..', 'src', 'services')
const SCHEDULER = readFileSync(resolve(SRC, 'scheduler.ts'), 'utf8')
const NODE_MECHANICS = readFileSync(
  resolve(SRC, '..', 'modules', 'task-execution', 'composition', 'nodeMechanics.ts'),
  'utf8',
)
const WRAPPER_MECHANICS = readFileSync(
  resolve(SRC, '..', 'modules', 'task-execution', 'composition', 'wrapperMechanics.ts'),
  'utf8',
)
const EXECUTION_MERGE_RECOVERY = readFileSync(
  resolve(SRC, '..', 'modules', 'task-execution', 'composition', 'executionMergeRecovery.ts'),
  'utf8',
)
const MECHANICS_SOURCES = [SCHEDULER, NODE_MECHANICS, WRAPPER_MECHANICS] as const

/** 取某函数体（到下一个顶格 `}` 为止）。 */
function bodyOf(signature: string): string {
  const source = MECHANICS_SOURCES.find((candidate) => candidate.includes(signature))
  expect(source, `未找到函数：${signature}`).toBeDefined()
  if (source === undefined) return ''
  const start = source.indexOf(signature)
  expect(start, `未找到函数：${signature}`).toBeGreaterThan(-1)
  const end = source.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

/** 五条已迁线的函数签名（灭绝锁的射程）。 */
const MIGRATED_LINES = [
  ['L1 workgroup-host', 'async function executeWorkgroupHostMechanics('],
  ['L4 agent-single', 'async function runAgentSingleNode('],
  ['L5 fanout-shard', 'async function dispatchFanoutShardAttempt('],
  ['L6 fanout-aggregator', 'async function dispatchFanoutAggregatorAttempt('],
  ['L7 script', 'async function runScriptNode('],
] as const

describe('RFC-287 T9 ① — 四条刻意豁免各带理由锁', () => {
  test('L3 合并 agent：绝不取节点池位（取了就闭合 writeSem↔pool 死锁环）', () => {
    const body = bodyOf('async function resolveMergeConflicts(')
    // 调用方在 §6.2 全程持 writeSem；这里再等池位就闭环了（design §7 死锁分析）。
    expect(body).not.toMatch(/agentSem|scriptSem|\.acquire\(\)/)
    expect(body).not.toContain('runAssembly')
    // 理由必须写在源码里——后来者先撞到理由，而不是先撞到这条红。
    expect(NODE_MECHANICS).toMatch(/deliberately does NOT acquire a node-pool slot/)
    expect(NODE_MECHANICS).toMatch(/writeSem[↔<-]+pool/)
  })

  test('L8 call 节点：整线不迁，且其「可取消的配额 hold」不是信号量池位', () => {
    const body = bodyOf('async function runCallWorkflowNode(')
    expect(body).not.toContain('runAssembly')
    // 它的许可是子任务配额 hold（带 signal，排队中可被取消 → 标 canceled），
    // 与「拿到就拿到、拿不到就排队」的信号量池位不同型：统一进骨架会把
    // 「排队中可取消」这条最易做丢的行为一起做丢。
    expect(body).toMatch(/budget\.acquire\(|childBudget/)
    expect(body).toMatch(/signal/)
  })

  test('L8 的「排队中可被取消」有行为夹具兜着（统一时最易做丢的正是它）', () => {
    // 不是源码锁——真行为夹具。它一旦被删/改名，本条立刻红，提醒「你正在动的
    // 是 L8 不迁的核心理由」。
    const fixture = readFileSync(resolve(import.meta.dir, 'rfc243-child-budget.test.ts'), 'utf8')
    expect(fixture).toContain('abort rejects a queued waiter and deregisters it')
  })

  test('L9 代码平台：没有节点级 retry（只有 HTTP 幂等重试）', () => {
    const body = bodyOf('async function runCodeHostCallNode(')
    expect(body).not.toContain('runAssembly')
    expect(body).not.toMatch(/for \(let attempt|retryPolicy/)
    // T8 的表态矩阵已锁「不追 retryIndex」；这里锁「压根没有 attempt 循环」。
    expect(body).toContain('trackRetryIndex: false')
  })

  test('L2 commit-push：无池、无 iso（在 canonical 工作树直跑）', () => {
    // 本线走 commitPushRunner，scheduler 侧只有调用点；它既不取池位也不物化 iso
    // ——降级回退（{message:null} 容错）是它自己的语义，现有 commit-push 套件已锁。
    expect(SCHEDULER).toContain("import { runCommitPush } from '@/services/commitPushRunner'")
    const callSite = SCHEDULER.slice(
      SCHEDULER.indexOf('await runCommitPush('),
      SCHEDULER.indexOf('await runCommitPush(') + 1200,
    )
    expect(callSite).not.toMatch(/createIsoUnderLock|agentSem|runAssembly/)
  })
})

describe('RFC-287 T9 ② — 装配散写的终局灭绝锁（三处显式挖洞）', () => {
  test('五条迁移线里的 iso 物化只能**经装配 spec 到达**', () => {
    // 判据不是「文本位置在 runAssembly 之后」——那样会误伤合法形态：脚本线把
    // 「首建 + fresh-retry 重建」收进一个提前声明的具名闭包 `createScriptIso`，
    // 再挂到 spec 的 `iso.create` 上（RFC-287 T5c/T8 的收编产物）。真正要锁的是
    // **可达性**：每一处物化要么写在 spec 里（位置在 runAssembly 之后），要么它的
    // 宿主闭包被 `iso.create` 引用。散写（函数体直线上直接物化）两条都不满足。
    for (const [label, sig] of MIGRATED_LINES) {
      const body = bodyOf(sig)
      const asmAt = body.indexOf('runAssembly<')
      expect(asmAt, `${label}: 应已迁入骨架`).toBeGreaterThan(-1)
      const spec = body.slice(asmAt)
      for (const m of body.matchAll(/createIsoUnderLock\(/g)) {
        const at = m.index ?? 0
        if (at > asmAt) continue // ① 写在 spec 里
        // ② 向上找宿主闭包名，再确认它被 iso.create 引用。
        //
        // ⚠️ 必须**括号配平**确认调用点真的落在那个闭包体内（四轮门测试有效性自查
        // 实测）：光取「最近的前一个 `const X = async (`」是**顺序逃逸**——一句真正
        // 散写的 `await createIsoUnderLock(...)` 只要放在 `const createScriptIso =
        // async (` 之后、`runAssembly<` 之前，就会被误认成属于 createScriptIso（而它
        // 确实被 iso.create 引用），于是复辟**全绿**。这条锁当时只是靠代码顺序的运气。
        const before = body.slice(0, at)
        const decl = [...before.matchAll(/const (\w+) = async \(/g)].pop()
        expect(decl, `${label}: 物化既不在 spec 内、也不在具名闭包里（散写复辟）`).not.toBe(
          undefined,
        )
        const declAt = decl?.index ?? 0
        const declOpen = body.indexOf('{', declAt)
        let depth = 1
        let k = declOpen + 1
        for (; k < body.length && depth > 0; k++) {
          if (body[k] === '{') depth++
          else if (body[k] === '}') depth--
        }
        expect(
          at > declOpen && at < k,
          `${label}: createIsoUnderLock 落在 ${decl?.[1] ?? '?'} 的**体外**（散写复辟，只是恰好排在它后面）`,
        ).toBe(true)
        const name = decl?.[1] ?? ''
        // 只要求「spec 的 iso 块引用了它」——直接挂 `create: name` 与套一层
        // `create: async () => name()` 语义等价，锁死前者会让无害的重构变红。
        const isoBlock = spec.slice(spec.indexOf('iso: {'), spec.indexOf('onIsoSetupFailure'))
        expect(
          new RegExp(`\\b${name}\\b`).test(isoBlock),
          `${label}: 闭包 ${name} 里物化了 iso，却没有挂到 spec 的 iso 块上`,
        ).toBe(true)
      }
    }
  })

  test('三处存续区显式挖洞——它们**允许**直接物化 iso，不得被灭绝锁误伤', () => {
    // ① L8 整线（第六条 iso 线，本 RFC 不迁）
    expect(bodyOf('async function runCallWorkflowNode(')).toContain('createIsoUnderLock(')
    // ② wrapper 便车（wrapper 自己的 iso，不属于任何装配线）
    expect(bodyOf('export async function createOrRebuildWrapperIso(')).toContain(
      'createIsoUnderLock(',
    )
    // ③ 恢复 replay 段：它复原的是**别人已落库的** node_tree，不铸行也不进窗口。
    const replay = EXECUTION_MERGE_RECOVERY.slice(
      EXECUTION_MERGE_RECOVERY.indexOf('pending-merge replay'),
      EXECUTION_MERGE_RECOVERY.indexOf('conflict-human resume: human resolution merged back'),
    )
    expect(replay.length).toBeGreaterThan(0)
    expect(replay).toContain('discardNodeIso(')
    expect(replay).not.toContain('runAssembly')
  })

  test('五条迁移线不得再自己释放池许可（取放单点在骨架）', () => {
    for (const [label, sig] of MIGRATED_LINES) {
      const body = bodyOf(sig)
      // 允许出现 `pools: [agentSem]` 这种**声明**；不允许 `await xxxSem.acquire()`
      // 这种直线取许可，也不允许手写 release。
      expect(body, `${label}: 不得直线取许可`).not.toMatch(
        /=\s*await\s+(?:state\.)?\w*Sem\.acquire\(\)/,
      )
      expect(body, `${label}: 不得手写 releaseGlobal/releaseScript`).not.toMatch(
        /release(?:Global|Script|Sub|Host)\(\)/,
      )
    }
  })

  test('装配骨架是唯一的窗口实现（没有第二份 finally 兜底）', () => {
    const asm = readFileSync(resolve(SRC, 'schedulerAssembly.ts'), 'utf8')
    // 骨架里恰好一个「释放许可 + 按 keep 清理」的 finally。
    expect(asm.split('} finally {').length - 1).toBe(1)
    expect(asm).toContain('for (const release of releases.reverse()) release()')
    // scheduler.ts 里没有任何 finally 兼做这两件事（rfc287-t1-discard-failure-paths
    // 从正面锁了同一件事；这里是从骨架侧对拍，两边都塌才可能漏过去）。
    const schedFinallys = [...SCHEDULER.matchAll(/\bfinally\s*\{/g)].map((m) =>
      SCHEDULER.slice(m.index ?? 0, (m.index ?? 0) + 900),
    )
    expect(schedFinallys.filter((b) => b.includes('discardNodeIso(')).length).toBe(0)
  })
})
