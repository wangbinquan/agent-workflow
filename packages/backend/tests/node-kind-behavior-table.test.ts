// RFC-053 P-2 / RFC-146 — NODE_KIND_BEHAVIORS 全真行为表锁。
//
// 为什么这条测试存在：RFC-053 的原表五维只有 retryCascade 被运行时消费，其余
// 四维（limits/orphanReap/gc/shutdown）是「愿望文档」假 SSOT（flag-audit §4.2）。
// RFC-146 重铸后表的准入标准 = 每一维都有 grep 可证的运行时消费者：
//   retryCascade → services/task.ts retryNode 级联；
//   isAgent → isAgentNodeKind（收敛 5 处 agent-single 判定）；
//   settlesWithoutRow → scheduler SETTLES_WITHOUT_ROW 派生 + stuckTaskDetector。
//
// ⚠️ RFC-317 T43 改了两处，都是被实测逼出来的：
//
//  ① **删掉了第四维 `isProcess`**。它当年是按同一条准入标准收进来的，消费者写的是
//     `isProcessNodeKind`——但 R6 反向普查发现那个谓词**零生产调用者**，只有测试在用，
//     而测试做的又是 `expect(isProcessNodeKind(k)).toBe(NODE_KIND_BEHAVIORS[k].isProcess)`
//     ——拿谓词去断言它自己读的那一列。同时 `isProcess` 与 `retryCascade ===
//     'mint-placeholder'` 在**每一行**上恒等（下面原本就有一条断言这么写）。
//     两列手工保持相等、没有任何消费者，只是一个纯粹的漂移隐患。
//
//  ② **逐值锁从 9 个 kind 扩到全部 14 个**。原来 call-workflow / call-workgroup /
//     script / code-host-call / code-round 五个 kind 一条值断言都没有，代价是真实的：
//     RFC-310 退役了 code-round 的整条执行链（scheduler 现在只回一条 typed
//     `code-round-retired` 失败），源码里那一行的描述却仍是现在时的「it drives a whole
//     stage sequence … so it is process-bearing」，**没有任何测试会因为一个 kind 退役
//     而变红**。结构性断言只能抓住「新增的 process kind」，抓不住「退役的」。
//     现在改成遍历 NODE_KIND：漏掉任何一行都是 red，退役一行则必须来这里重新确认。
//
// 本文件锁：①逐 kind × 逐维值（**全 14 行**，意图确认）；②key 全集与 NODE_KIND 自洽；
// ③派生谓词与表引用同源（不再是「巧合等价靠测试对齐」）；④愿望维确已删除（防回潮）。

import { describe, expect, test } from 'bun:test'
import {
  NODE_KIND,
  NODE_KIND_BEHAVIORS,
  isAgentNodeKind,
  isWrapperKind,
  nodeKindParticipatesInRetryCascade,
  nodeKindSettlesWithoutRow,
  type NodeKind,
} from '@agent-workflow/shared'

/** 表的三维取值。逐行手写一遍——这就是「意图确认」的全部内容。 */
type Row = {
  readonly retryCascade: 'mint-placeholder' | 'skip'
  readonly isAgent: boolean
  readonly settlesWithoutRow: boolean
}

const PROCESS_BEARING: Row = {
  retryCascade: 'mint-placeholder',
  isAgent: false,
  settlesWithoutRow: false,
}
const INERT: Row = { retryCascade: 'skip', isAgent: false, settlesWithoutRow: false }
const SETTLES: Row = { retryCascade: 'skip', isAgent: false, settlesWithoutRow: true }

/**
 * **全 14 行**的期望值。`satisfies Record<NodeKind, Row>` 让新增一个 NodeKind 却
 * 忘了在这里表态成为**编译错误**——而不是像扩面前那样，静静地不被任何断言覆盖。
 */
const EXPECTED_ROWS = {
  // 唯一拥有模型 session 的 kind。
  'agent-single': { retryCascade: 'mint-placeholder', isAgent: true, settlesWithoutRow: false },
  // 三个容器：持一行 node_run，状态由内部子图驱动。
  'wrapper-git': PROCESS_BEARING,
  'wrapper-loop': PROCESS_BEARING,
  'wrapper-fanout': PROCESS_BEARING,
  // RFC-243 —— call 节点：真实执行体是独立子任务，自身无 session、非容器。
  'call-workflow': PROCESS_BEARING,
  'call-workgroup': PROCESS_BEARING,
  // RFC-253 —— script 自己就是那个进程（有 pid、有退出码），不拥有模型 session。
  script: PROCESS_BEARING,
  // RFC-269 —— 有真实外部副作用（评论已发出），要级联、要自己的行。
  'code-host-call': PROCESS_BEARING,
  // RFC-304 + **RFC-310 已退役执行链**。这一行留着只为让历史 round 任务在 daemon
  // 重启 resume 时 typed-fail（`code-round-retired`）而不是让调度器 crash，并让前端
  // 还能渲染/跳转那些历史任务。取值与其它「持行 kind」同形，正是为了走普通失败路径。
  'code-round': PROCESS_BEARING,
  // 无进程状态的 kind：级联 skip（RFC-052 的 review-cascade-stuck 教训）。
  review: INERT,
  input: INERT,
  output: INERT,
  // clarify 家族额外「无行结算」（C1/N6）。
  clarify: SETTLES,
  'clarify-cross-agent': SETTLES,
} as const satisfies Record<NodeKind, Row>

describe('RFC-146 NODE_KIND_BEHAVIORS — 全真表', () => {
  test('key 全集与 NODE_KIND 完全自洽', () => {
    expect(Object.keys(NODE_KIND_BEHAVIORS).sort()).toEqual([...NODE_KIND].sort())
  })

  test('逐 kind × 逐维值锁 —— 遍历全部 14 行，一行都不漏', () => {
    // 遍历 NODE_KIND 而不是遍历 EXPECTED_ROWS：这样「表里多出一个 kind 而期望值
    // 没跟上」也会红（satisfies 只挡住反方向）。
    for (const kind of NODE_KIND) {
      expect(NODE_KIND_BEHAVIORS[kind] as unknown, `${kind} 的行为行`).toEqual(EXPECTED_ROWS[kind])
    }
    // 覆盖面本身也锁住：曾经只锁了 14 行里的 9 行，退役的 code-round 就是从那个
    // 缺口里漏过去的。
    expect(Object.keys(EXPECTED_ROWS).sort()).toEqual([...NODE_KIND].sort())
  })

  test('派生谓词与表引用同源（逐 kind property）', () => {
    for (const k of NODE_KIND) {
      expect(isAgentNodeKind(k)).toBe(NODE_KIND_BEHAVIORS[k].isAgent)
      expect(nodeKindSettlesWithoutRow(k)).toBe(NODE_KIND_BEHAVIORS[k].settlesWithoutRow)
      expect(nodeKindParticipatesInRetryCascade(k)).toBe(
        NODE_KIND_BEHAVIORS[k].retryCascade === 'mint-placeholder',
      )
    }
  })

  test('结构关系：isAgent ⊂ 级联族；级联族 = agent ∪ wrapper ∪ call ∪ script ∪ code-host ∪ code-round；settlesWithoutRow ∩ 级联族 = ∅', () => {
    // RFC-243：call 节点是第三类持行载体——真实执行体是独立子任务，
    // 自身无 session（isAgent=false）也非容器（不入 WRAPPER_NODE_KINDS）。
    // RFC-253：script 是第四类——它自己就是那个进程（有 pid、有退出码），
    // 但不拥有模型 session（isAgent=false），也不是容器。
    // RFC-269：code-host-call 是第五类 —— 有真实外部副作用（一条评论发出去了）。
    // RFC-304/310：code-round 是第六类，且**已退役**（见上面 EXPECTED_ROWS 的注释）。
    const isCallKind = (k: string): boolean => k === 'call-workflow' || k === 'call-workgroup'
    const isScriptKind = (k: string): boolean => k === 'script'
    const isCodeHostKind = (k: string): boolean => k === 'code-host-call'
    const isCodeRoundKind = (k: string): boolean => k === 'code-round'
    for (const k of NODE_KIND) {
      const cascades = NODE_KIND_BEHAVIORS[k].retryCascade === 'mint-placeholder'
      if (NODE_KIND_BEHAVIORS[k].isAgent) expect(cascades).toBe(true)
      expect(cascades, `${k} 的级联归属`).toBe(
        NODE_KIND_BEHAVIORS[k].isAgent ||
          isWrapperKind(k) ||
          isCallKind(k) ||
          isScriptKind(k) ||
          isCodeHostKind(k) ||
          isCodeRoundKind(k),
      )
      if (NODE_KIND_BEHAVIORS[k].settlesWithoutRow) expect(cascades).toBe(false)
    }
  })

  test('愿望维已删除（防回潮——表准入标准 = 有运行时消费者）', () => {
    for (const k of NODE_KIND) {
      const row = NODE_KIND_BEHAVIORS[k] as Record<string, unknown>
      expect(row.limits).toBeUndefined()
      expect(row.orphanReap).toBeUndefined()
      expect(row.gc).toBeUndefined()
      expect(row.shutdown).toBeUndefined()
      // `isProcess` 也在这条防线里了：它有过运行时消费者的**外形**（一个谓词），
      // 但那个谓词自己零生产调用者。回潮判据与愿望维完全一样。
      expect(row.isProcess).toBeUndefined()
      expect(Object.keys(row).sort()).toEqual(['isAgent', 'retryCascade', 'settlesWithoutRow'])
    }
  })
})
