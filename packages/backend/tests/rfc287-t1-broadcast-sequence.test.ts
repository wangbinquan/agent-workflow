// RFC-287 T1④ —— 各装配线的**状态广播序列**快照（拆分前 oracle）。
//
// 为什么存在：广播是用户在任务详情页上**直接看得到**的东西——节点在重试时会不会
// 「失败→待运行→失败→…」地闪、准备阶段有没有声音、失败是不是当场可见。骨架把
// 「先写库再广播」的时序制度化时，很容易顺手把各线的广播点也「统一」掉，而那是
// 用户可感知的变化，不属于 §4 声明的「日志措辞不承诺逐字节」豁免。
//
// 锁两件事：
//   ① 每条装配线的广播**次数与状态序列**（按源码出现序，非运行时序——运行时序要
//      真跑调度器，那是 T3-T7 各批家族套件的活；这里要的是拆分前后可逐字对比的
//      结构快照）。
//   ② 「DB 写落地后才广播」这条时序契约的**唯一反例检测**：广播不得出现在
//      `await` 的 DB 写之前（骨架 §2 要把它制度化，先把现状钉住）。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SCHEDULER = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
  'utf8',
)
const NODE_MECHANICS = readFileSync(
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
const MECHANICS_SOURCES = [SCHEDULER, NODE_MECHANICS] as const

function bodyOf(signature: string): string {
  const source = MECHANICS_SOURCES.find((candidate) => candidate.includes(signature))
  expect(source, `未找到函数：${signature}`).toBeDefined()
  if (source === undefined) return ''
  const start = source.indexOf(signature)
  expect(start, `未找到函数：${signature}`).toBeGreaterThan(-1)
  // ⚠️ 括号配平，**不能**靠「下一个 function 声明」当边界（四轮门测试有效性自查
  // 实测）：`runHostNode` 是嵌套在 `buildWorkgroupHooks` 里的函数，它的兄弟钩子都写成
  // `const x = async () =>`，正则边界一个都不命中，于是切片一路跑出真实函数体
  // 159 行——把兄弟钩子与两个导出函数全吞了进来。实测把边界补上 `export ` 前缀只收窄
  // 了 31 行，仍然吞着别人的代码。只有配平括号才切得准。
  const open = source.indexOf('{', start + signature.length - 1)
  let depth = 1
  let i = open + 1
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
  }
  return source.slice(open + 1, i - 1)
}

/** 该函数体里 broadcastNodeStatus 的状态实参序列（按源码出现序）。 */
function broadcastSeq(body: string): string[] {
  const out: string[] = []
  const re = /broadcastNodeStatus\([^)]*?,\s*([^,)]+)\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) out.push((m[1] ?? '').trim())
  return out
}

// 2026-08-13 基线。迁移后逐条对比：**任何一格变化都必须在 §4 能力影响清单里
// 有对应条目**（广播是产品可见面）。
const BASELINE: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    'async function dispatchFanoutShardAttempt(',
    ["'done'", "'pending'", "'failed'", 'result.status', "'failed'"],
  ],
  // RFC-287 T3 改锚：聚合线已迁骨架，序列不变但分布到 spec 的 spawn / onUnhandledThrow
  // 两个钩子里（源码出现序仍逐字相同——迁移**没有**改动任何一次广播）。
  [
    'async function dispatchFanoutAggregatorAttempt(',
    ["'done'", "'pending'", "'failed'", 'result.status', "'failed'"],
  ],
  ['async function runScriptNode(', ["'pending'", "'failed'", "'pending'"]],
  // RFC-328's effect-ledger transaction settles the node and effect together;
  // those two branches broadcast the committed terminal state explicitly,
  // while legacy/no-context execution still broadcasts through `settle(to)`.
  ['async function runCodeHostCallNode(', ["'running'", 'to', "'failed'", "'done'"]],
  // 四轮门测试有效性自查纠正:第 4 项 `'status as NodeStatus'` **根本不在
  // runHostNode 里** —— 它是 `buildWorkgroupHooks` 返回对象里的兄弟钩子
  // `broadcastNodeStatus`。旧 `bodyOf` 靠「下一个 function 声明」当边界,而这些兄弟
  // 钩子都写成 `const x = async () =>`,正则一个都不命中,切片于是跑出真实函数体
  // 159 行、把别人的广播算进了本线的序列。`bodyOf` 改成括号配平后基线随之收正。
  ['async function executeWorkgroupHostMechanics(', ["'failed'", 'result.status', "'failed'"]],
  // ⚠️ L4 一直缺席（五轮门终局对账点名）：design §7 T1-④ 点名的**第一项**就是它，
  // 而它是本 RFC 唯一做了真手术的线（拆成 outer + 模式 B 重试窗口）。基线在
  // `d0f6333c` 上按括号配平的 `bodyOf` 实测导出，与其余四线同法。
  ['async function runAgentSingleNode(', ["'pending'", "'pending'", 'lastResult.status']],
  ['async function runOutputNode(', ["'done'"]],
  ['async function runInputNode(', ["'done'"]],
  ['async function runCrossClarifyNode(', ["'done'"]],
]

describe('RFC-287 T1④ — 广播序列快照', () => {
  for (const [sig, expected] of BASELINE) {
    test(`${sig.replace('async function ', '').replace('(', '')} 的广播序列不变`, () => {
      expect(broadcastSeq(bodyOf(sig))).toEqual([...expected])
    })
  }

  test('② 时序契约现状：全仓无「广播先于其 DB 写」的反例', () => {
    // 逐个广播点向前看 200 字符：若紧邻的上一条语句是 setNodeRunStatus/db.update
    // 的 await，说明顺序正确；这里只检出明显的反序（广播紧跟在同一语句块的
    // `await` DB 写**之前**）。骨架把该契约制度化后，本断言应改为对骨架的断言。
    const offenders: string[] = []
    const re = /broadcastNodeStatus\(/g
    let m: RegExpExecArray | null
    for (const source of MECHANICS_SOURCES) {
      re.lastIndex = 0
      while ((m = re.exec(source)) !== null) {
        const after = source.slice(m.index, m.index + 260)
        // 反序形态：广播之后紧接着对同一 nodeRunId 的 await DB 写，中间无其它语句。
        if (
          /^broadcastNodeStatus\([^)]*\)\s*\n\s*await (setNodeRunStatus|db\s*\n?\s*\.update)/.test(
            after,
          )
        ) {
          offenders.push(source.slice(Math.max(0, m.index - 60), m.index + 120))
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
