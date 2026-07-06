# RFC-141 技术设计：反问轮携带上轮产出

## 0. 改动一览

| 文件 | 改动 |
|---|---|
| `packages/shared/src/clarify.ts` | 新增反问版三常量：`ASKBACK_PRIOR_OUTPUT_BLOCK_TITLE` / `ASKBACK_PRIOR_OUTPUT_DIRECTIVE_BLOCK_TITLE` / `ASKBACK_PRIOR_OUTPUT_DIRECTIVE_TEXT` |
| `packages/shared/src/prompt.ts` | pou 渲染去掉 `input.hasClarifyChannel !== true` 抑制门，改为**按 `hasClarifyChannel` 选变体**（true → 反问版标题+指令；否则既有 `PRIOR_OUTPUT_BLOCK_TITLE` + `UPDATE_DIRECTIVE_TEXT`）；接口注释随动 |
| `packages/backend/src/services/scheduler.ts` | 计算门从 4 项减到 2 项（删 `!suppressPriorOutput`、`!effectiveHasClarifyChannel`）；删 `suppressPriorOutput` 读取（2657）；D6 / §18 相关注释随动 |
| `packages/backend/src/services/clarifyQueue.ts` | 删 `ClarifyQueueContext.suppressPriorOutput` 字段（275）、派生表达式（336）、接口注释（266-274）与模块头引用（60） |
| `packages/backend/src/services/runner.ts` | 无逻辑改动；`opts.priorOutputUpdate` 注释里「非 ask-back」措辞随动（173-178） |
| 测试 | 见 §5 |

无 schema / migration；`PriorOutputUpdateContext` 形状不变（`{block}`）。

## 1. 机制现状（精确锚点）

- **调度层计算门**（`scheduler.ts:2753-2780`）：
  `currentRunRow !== undefined && !suppressPriorOutput && !resumeDecision.inlineMode &&
  !effectiveHasClarifyChannel` 全真才执行 `freshestPriorRunWithOutput` →
  `composePriorOutputBlock`（review-iterate 时 `onlyPorts={iterateTargetPort}`，D10）→
  `priorOutputUpdate={block}`。
- **改派抑制派生**（`clarifyQueue.ts:336`）：`suppressPriorOutput: hasDesigner && !graphOwnedDesigner`
  ——队列里有 designer 条目且**没有任何一条**的 default target 是本节点（纯 override 交接）时为
  true；scheduler 在 2657 读取。
- **渲染层门**（`prompt.ts:582-592`）：`pou.block 非空 && xcc 未占位 && !inlineMode &&
  hasClarifyChannel !== true` → 追加 `PRIOR_OUTPUT_BLOCK_TITLE` + block +
  `UPDATE_DIRECTIVE_BLOCK_TITLE` + `UPDATE_DIRECTIVE_TEXT`（常量在 `clarify.ts:408-425`）。
- **线程化**（`runner.ts:791-793`）：仅非 followup 分支透传 `opts.priorOutputUpdate`；followup
  分支天然不注入（RFC-119 D5 的 envelope-followup 半边，本 RFC 不动）。
- **aggregator**（`scheduler.ts:4686-4697、4764-4766`）：无 ask-back 概念，`runNode` 显式传
  `hasClarifyChannel: false`（PR-D2）——渲染层变体选择对它恒走定稿版，不受本 RFC 影响。
- **section 顺序**（`prompt.ts:444-605`）：输入端口 → 评审反馈 → `## Clarify Q&A`（扁平块）→
  prior output + 指令 → STOP notice → 尾部协议。反问轮注入后阅读顺序天然成立：
  「问答记录 → 你的草稿 → 本轮怎么问」。

## 2. 决策

- **D1 反问轮注入 + 强指令文案**（用户拍板 2026-07-06，三选一取「强指令：问题围绕改稿提」）。
  文案见 §3.1。要点：重申 clarify-only（与尾部协议一致而不是对冲）、要求反问围绕修改上轮产出、
  禁止重新讨论 Clarify Q&A 已定稿决策、文件路径端口先读再问。
- **D2 inline / followup 豁免维持**（用户拍板「维持不注入」）：`!resumeDecision.inlineMode`
  （调度层）与 `!inlineMode`（渲染层）双门原样保留；followup 分支不透传原样保留。
- **D3 改派抑制整体拆除**（用户拍板「也注入」，**有意推翻 RFC-120 §18**）：纯 override 交接轮
  同样注入——反问轮走 D1 文案；定稿轮走既有 Update Directive。语义交代：改派问答本来就在
  `## Clarify Q&A` 里，Update Directive 的「see the feedback in the sections above」指向它；
  agent 拿到自己旧产出作背景后处理改派问题，比「失忆」处理更对齐。§18 担心的「改写自己旧
  artifact 而非处理问题」由文案中 feedback 指向 + 问答在场兜底，风险由用户接受。
  随之 `suppressPriorOutput` 全链路（派生、字段、读取、门控、源锁）删除——不留死代码。
- **D4 变体选择放渲染层**：`renderUserPrompt` 已接收 `hasClarifyChannel`（尾部协议选择用同一
  信号），pou 渲染直接按它选标题/指令对；`PriorOutputUpdateContext` 不加字段、调度层不传旗标。
  单一信号源，杜绝「调度层旗标 × 渲染层信号」不一致。
- **D5 其余 RFC-119 决策逐字不变**：D8（文件端口 content=路径、逐字渲染、零 I/O）、D9
  （aggregator 注入 / shard 永不注入）、D10（review-iterate 限 `iterateTargetPort`；该限定在
  「评审周期内的反问轮」〔reviewContext 存在 && isClarifyRerun〕同样适用——iterate 语义是
  「改这一个端口」，反问也围绕它）、xcc 互斥（`prompt.ts:586`——同一 prompt 恒最多一段 prior
  output）、D7 无开关。
- **D6 触发条件用渲染层既有信号，不新增「反问轮」判定**：调度层唯一职责是「找到最新产出」，
  找到就传；渲染层唯一职责是「有产出 + 什么协议 → 什么措辞」。两处判定天然一致
  （`effectiveHasClarifyChannel` 就是 runNode 收到的 `hasClarifyChannel`，`runner.ts` 原样透传）。

## 3. 具体改动

### 3.1 shared/clarify.ts —— 反问版常量（新增，不改既有常量）

```ts
/** RFC-141: ask-back variant of the prior-output section. Injected when a
 *  clarify-only round (mandatory ask-back active) has a prior captured output —
 *  the agent must frame its questions around REVISING that output, not emit it. */
export const ASKBACK_PRIOR_OUTPUT_BLOCK_TITLE =
  "## Prior Output (your previous run's output)" as const
export const ASKBACK_PRIOR_OUTPUT_DIRECTIVE_BLOCK_TITLE = '## Prior Output Directive' as const
export const ASKBACK_PRIOR_OUTPUT_DIRECTIVE_TEXT = [
  'The "Prior Output" section above is what you produced on your previous run of',
  'this node. This round is still a clarify-only round — you MUST reply with a',
  'single <workflow-clarify> envelope and NO <workflow-output>. Frame your',
  'questions around how this prior output should be REVISED — do not re-litigate',
  'decisions the user has already settled in the Clarify Q&A. When a Prior Output',
  'port is a file path, read that file for its contents before asking.',
].join(' ')
```

标题刻意与定稿版（`to update or regenerate`）不同：反问轮不许产出，「update or regenerate」
是错误暗示。块体（`buildPriorOutputBlock` 输出）两变体共用，逐字不变。

### 3.2 shared/prompt.ts —— 渲染变体

```ts
// RFC-119 / RFC-141: generalized rerun prior-output. Emits ONLY when the
// scheduler set the block, cross-clarify is not already rendering its own
// (mutual exclusion), and this is not an inline session resume. RFC-141: a
// mandatory ask-back round now ALSO renders it — with the clarify-flavored
// title + directive (ask about revising the draft) instead of the update pair
// (which demands a <workflow-output> this very round and would contradict the
// clarify-only protocol).
const pou = input.priorOutputUpdate
if (
  pou?.block !== undefined &&
  pou.block.trim().length > 0 &&
  !(xcc?.priorOutputBlock !== undefined && xcc.priorOutputBlock.trim().length > 0) &&
  !inlineMode
) {
  if (input.hasClarifyChannel === true) {
    sections += `\n\n${ASKBACK_PRIOR_OUTPUT_BLOCK_TITLE}\n${pou.block}`
    sections += `\n\n${ASKBACK_PRIOR_OUTPUT_DIRECTIVE_BLOCK_TITLE}\n${ASKBACK_PRIOR_OUTPUT_DIRECTIVE_TEXT}`
  } else {
    sections += `\n\n${PRIOR_OUTPUT_BLOCK_TITLE}\n${pou.block}`
    sections += `\n\n${UPDATE_DIRECTIVE_BLOCK_TITLE}\n${UPDATE_DIRECTIVE_TEXT}`
  }
}
```

接口注释随动：`PriorOutputUpdateContext`（197-199）与 `priorOutputUpdate` 字段注释（267-274）
去掉「Absent when ask-back」措辞，改述双变体；`hasClarifyChannel` 注释（257-266）补一句
「also selects the prior-output directive variant (RFC-141)」。

### 3.3 scheduler.ts —— 门缩减 + suppress 拆除

- 2653-2657：`suppressPriorOutput` 读取整段删除（含 RFC-120 §18 注释——替换为一句
  「RFC-141: the §18 suppression was removed by user ruling; an override handoff
  also gets its own prior output」）。
- 2740-2759：skip 列表注释改为两条（inline resume / 无产出）；门改为
  `currentRunRow !== undefined && !resumeDecision.inlineMode`。
  `effectiveHasClarifyChannel` 在门外的既有用途（协议选择、runNode 传参）不动。
- D10 的 `onlyPorts` 计算原样保留（评审周期内反问轮同样限目标端口，见 §2 D5）。

### 3.4 clarifyQueue.ts —— 字段拆除

- 275 `suppressPriorOutput: boolean` 删；266-274 接口注释删；336 派生删（`hasDesigner` /
  `graphOwnedDesigner` 若无他用一并清）；模块头 60 行引用改写。
- 返回值仍是 `{ block, sourceRunIds }`。

### 3.5 runner.ts —— 注释随动

173-178 `priorOutputUpdate` 字段注释：由「review reject/iterate, manual retry, cascade,
resume, self-clarify」补上 ask-back / override 轮次，并注明渲染层选文案。逻辑零改动。

## 4. 失败模式分析

1. **反问轮 agent 看到草稿后直接发 `<workflow-output>`**：三重防线不变——尾部协议明说 emit 被
   拒、runner 对 ask-back 轮拒收 output envelope（既有）、D1 文案再次重申 clarify-only。
2. **token 膨胀**：string 端口大产出每个反问轮重复注入。接受：只带最新单份（非历史），文件型
   端口只带路径（D8）；用户裁决「上下文永远在场」优先于 token。
3. **改派轮 agent 改写自己旧 artifact 而非处理改派问题**（原 §18 担心）：改派问答在
   `## Clarify Q&A` 在场 + 指令 feedback 指向；残余风险用户已接受（D3）。
4. **双 prior-output 块**：xcc 互斥门保留（`prompt.ts:586`），不可能双注入。
5. **黄金锁**：非反问、非改派、非 inline rerun 的 prompt byte-identical——调度层门缩减对这类
   run 的真值不变（原两门在这类 run 上本就为真），渲染层走 else 分支输出原常量对。

## 5. 测试策略（随改动同 commit，缺一不可）

**shared（渲染层，`packages/shared/tests/`）**
- `rerun-prior-output.test.ts:125`「suppressed on mandatory ask-back」**翻转**：ask-back +
  pou → 断言含 `ASKBACK_PRIOR_OUTPUT_BLOCK_TITLE` + 反问版指令、**不含** `UPDATE_DIRECTIVE_TEXT`、
  尾部仍是 clarify-only 协议（`<workflow-clarify>` 强制块）。
- 新增黄金锁：同输入仅 `hasClarifyChannel` 翻转 → 定稿版/反问版两对常量各自出现、互不渗漏。
- `:108` inline 抑制、`:86` xcc 互斥两 case 原样保留跑绿。
- `clarify-baseline-prompt-render.test.ts` 若有 ask-back 基线快照，按新节次更新（明示这是有意
  契约变更）。

**backend（调度层）**
- `rerun-prior-output-source-guards.test.ts:28-46` 重写：守卫改为「保留 `!resumeDecision.inlineMode`
  + `freshestPriorRunWithOutput`；`!suppressPriorOutput` 与 `!effectiveHasClarifyChannel` 必须
  **不存在**于该区域」（负向锁防回潮）。
- `rfc098-rerun-cause-gates.test.ts:119-122`：`!suppressPriorOutput` 源锁移除，改锁新注释锚。
- `rfc120-deferred-dispatch.test.ts:1125/:1146/:1153/:2255-2298/:2340`：suppressPriorOutput
  相关断言删除；补一条**行为级** case——纯 override handoff + 旧产出 → `buildClarifyQueueContext`
  返回无 suppress 字段（类型层面）且 scheduler 路径注入（源锁或集成）。
- `rfc120-manual-questions.test.ts:702`：字段断言删除。
- `rerun-prior-output-injection.test.ts` 加 case：ask-back 轮走 `composePriorOutputBlock` →
  `renderUserPrompt(hasClarifyChannel:true)` 端到端出反问版两节（复用 :338 的 e2e 模式）。
- `rerun-prior-output-e2e.test.ts`：若 harness 已支持 clarify channel 节点则加一条真调度 case；
  过重则以上两层（渲染 + 源锁）为准并在文件头注明。

**回归防护命名**：新 case 顶注链接本 RFC 与任务取证（QMGP5 / agent_m7p3n1 idx17），说明锁的是
「反问轮丢草稿」回归。

## 6. 依赖与兼容

- 无 schema / migration / API 变更；纯 prompt 契约增量。
- 与 RFC-131 老化、RFC-132 扁平 Q&A、RFC-139/140 台账机制零耦合（只消费其结果）。
- 历史文档不改写：RFC-119 design.md D6 / RFC-120 design.md §18 保持原文，本 RFC 为翻案记录；
  代码注释中的引用改指 RFC-141。
