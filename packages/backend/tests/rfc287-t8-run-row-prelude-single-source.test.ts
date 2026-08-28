// RFC-287 T8（G2）—— 取行前奏的**单一实现**与四线×五项差异矩阵。
//
// 为什么存在：迁移前 L4 agent / L7 script / L8 call / L9 code-host 各手抄一份取行
// 前奏（查同节点同迭代行 → isFresherNodeRun 取最新 → 复用 pending ∨ 按
// schedulerMintCause 铸新行 → 广播 pending）。四份骨干一字不差，差异只在五个维度
// 上；这种「几乎一样但不完全一样」的复制正是最容易在后续改动里走散的形态——改了
// 三处忘了第四处，症状是某一条线的 cause 分档 / retryIndex / WS 事件悄悄跑偏。
//
// 本文件锁两件事：
//   ① **单一实现**：没有任何线再自己写这段前奏（反向扫描，比正向枚举更耐改名）；
//   ② **五项差异逐线钉死**：谁继承 reviewIteration、谁清 agentOverrideName、谁追
//      retryIndex、谁广播 pending、谁走领养短路——每一项都是真差异，统一任一项都
//      是行为变更（依据见 nodeRunMint.ts 上那段表格注释与各线的源注）。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..', 'src', 'services')
const SCHEDULER = readFileSync(resolve(SRC, 'scheduler.ts'), 'utf8')
const NODE_MECHANICS = readFileSync(
  resolve(SRC, '..', 'modules', 'task-execution', 'composition', 'nodeMechanics.ts'),
  'utf8',
)
const MINT = readFileSync(resolve(SRC, 'nodeRunMint.ts'), 'utf8')

/** 取某函数体（到下一个顶格 `}` 为止）。 */
function bodyOf(signature: string): string {
  const start = NODE_MECHANICS.indexOf(signature)
  expect(start, `未找到函数：${signature}`).toBeGreaterThan(-1)
  const end = NODE_MECHANICS.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return NODE_MECHANICS.slice(start, end)
}

/** 四条消费线：签名 + 期望的五项表态。 */
const LINES = [
  {
    label: 'L4 agent-single',
    sig: 'async function runAgentSingleNode(',
    inheritReviewIteration: true,
    clearAgentOverride: true,
    trackRetryIndex: true,
    broadcastsPending: true,
    hasPreResolve: false,
  },
  {
    label: 'L7 script',
    sig: 'async function runScriptNode(',
    // 脚本节点没有评审轮次、也没有代理借用——继承/清空这两项都无意义。
    inheritReviewIteration: false,
    clearAgentOverride: false,
    trackRetryIndex: true,
    broadcastsPending: true,
    hasPreResolve: false,
  },
  {
    label: 'L8 call-workflow',
    sig: 'async function runCallWorkflowNode(',
    inheritReviewIteration: true,
    clearAgentOverride: true,
    trackRetryIndex: true,
    broadcastsPending: true,
    // RFC-243-LOCK：领养区复用一条 running/interrupted/canceled 的行并就地转
    // running，与「铸行」是两码事，绝不能进收编（在那里 mint 会把子任务的
    // canonical iso 判为 superseded）。故只有本线带 preResolve 短路。
    hasPreResolve: true,
  },
  {
    label: 'L9 code-host',
    sig: 'async function runCodeHostCallNode(',
    inheritReviewIteration: false,
    clearAgentOverride: false,
    // 代码平台调用没有节点级重试（只有 HTTP 幂等重试），不追这个维度。
    trackRetryIndex: false,
    // 铸完立刻转 running；多播一条 pending 会让前台看到不存在的中间态。
    broadcastsPending: false,
    hasPreResolve: false,
  },
] as const

describe('RFC-287 T8 — 取行前奏单一实现 + 四线×五项差异矩阵', () => {
  test('四条线都改调 resolveSchedulerRunRow', () => {
    for (const line of LINES) {
      expect(bodyOf(line.sig), line.label).toContain('await resolveSchedulerRunRow({')
    }
  })

  test('五项表态逐线钉死（统一任一项都是行为变更）', () => {
    for (const line of LINES) {
      const body = bodyOf(line.sig)
      const call = body.slice(
        body.indexOf('await resolveSchedulerRunRow({'),
        body.indexOf('await resolveSchedulerRunRow({') + 3000,
      )
      expect(call, `${line.label}: inheritReviewIteration`).toContain(
        `inheritReviewIteration: ${String(line.inheritReviewIteration)}`,
      )
      expect(call, `${line.label}: clearAgentOverride`).toContain(
        `clearAgentOverride: ${String(line.clearAgentOverride)}`,
      )
      expect(call, `${line.label}: trackRetryIndex`).toContain(
        `trackRetryIndex: ${String(line.trackRetryIndex)}`,
      )
      // broadcastPending：null = 不播；回调 = 播。
      if (line.broadcastsPending) {
        expect(call, `${line.label}: 应广播 pending`).toMatch(/broadcastPending: \(id\) =>/)
      } else {
        expect(call, `${line.label}: 不得广播 pending`).toContain('broadcastPending: null')
      }
      expect(call.includes('preResolve:'), `${line.label}: preResolve`).toBe(line.hasPreResolve)
    }
  })

  test('单一实现：没有任何线再自己手写这段前奏', () => {
    // 前奏的两个特征形状：①「找 pending 行并盖 consumed 戳」；②「按
    // schedulerMintCause 铸 pending 行」。两者在 scheduler.ts 里都必须归零
    // ——它们现在只存在于 nodeRunMint.ts 的收编函数里。
    expect(`${SCHEDULER}\n${NODE_MECHANICS}`).not.toMatch(
      /status === 'pending' && r\.parentNodeRunId === null/,
    )
    expect(`${SCHEDULER}\n${NODE_MECHANICS}`).not.toMatch(/cause: schedulerMintCause\(/)
    // 正向：收编函数里各有且仅有一处。
    expect(MINT.split("status === 'pending' && r.parentNodeRunId === null").length - 1).toBe(1)
    expect(MINT.split('cause: schedulerMintCause(').length - 1).toBe(1)
  })

  test('领养区仍带 RFC-243-LOCK 标记，且标记内不得出现 mintNodeRun', () => {
    const begin = NODE_MECHANICS.indexOf('RFC-243-LOCK:adoption-no-mint-begin')
    const end = NODE_MECHANICS.indexOf('RFC-243-LOCK:adoption-no-mint-end')
    expect(begin).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(begin)
    expect(NODE_MECHANICS.slice(begin, end)).not.toContain('mintNodeRun(')
  })
})
