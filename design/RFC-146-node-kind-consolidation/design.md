# RFC-146 · 节点 kind 知识收口（design）

> 行号为 2026-07-08 调研快照（RFC-145 之后），实现以 grep 实况为准。
> 既有范式落点：`NODE_KIND_BEHAVIORS satisfies Record<NodeKind,…>`（编译穷举）、
> `DEFAULT_NODE_SIZE_BY_KIND`（全量 Record 单源）、`NODE_TYPES`（per-kind 渲染注册表）、
> `WRAPPER_KINDS = new Set(WRAPPER_NODE_KINDS)`（W0 的 shared 派生接线模板）。

## 1. 行为表重铸（shared/node-kind-behavior.ts）

### 1.1 目标形态

```ts
export interface NodeKindBehavior {
  /** retryNode 级联：下游是否铸 failed 占位行。既有唯一真消费维，保留。 */
  retryCascade: 'mint-placeholder' | 'skip'
  /** 是否 process kind（跑真进程/wrapper 容器）。收敛 isProcessNodeKind 双实现。 */
  isProcess: boolean
  /** 是否 agent kind（有自己的 opencode/claude 会话、prompt、inventory）。
   *  收敛 5 处：inventory.isAgentRunKind / inventory.PROMPT_CAPABLE_KINDS /
   *  sessionView.PROMPT_CAPABLE_KINDS / 前端 isPromptCapableKind / isAgentKind。 */
  isAgent: boolean
  /** deriveFrontier pass-2：图访问 no-op 不写 node_run 行、上游 done 即结算
   *  （C1/N6）。收敛 scheduler 私有 SETTLES_WITHOUT_ROW_KINDS。 */
  settlesWithoutRow: boolean
}
```

- **删除 limits / orphanReap / gc / shutdown 四维**（D1）：零消费者、语义由 status 驱动
  代码隐式兑现（orphans.ts 按 status ∈ {running,pending} 过滤天然放过 awaiting_* 行；
  gc/shutdown 只看 task 终态）。删维时把这段「为什么不需要 per-kind 维度」写成表头注释，
  取代原来的假承诺。`scheduler-audit-gap5` 测试头注绑定的 `node-kind-behavior.ts:72-75`
  行号引用同步改为注释引用。
- 派生谓词：`isProcessNodeKind`（schemas/workflow.ts）改为查表薄封装（or-chain 删除）；
  `nodeKindParticipatesInRetryCascade` 保留查表实现；新增 `isAgentNodeKind(kind)` 导出。
  「巧合等价」测试（node-kind-behavior-table 82-104）升级为「引用同源」断言。

### 1.2 后端接线（预算表 B3/B4/B5/B6/B8）

| 点 | 现状 | 改造 |
|---|---|---|
| `scheduler.ts:1247` SETTLES_WITHOUT_ROW_KINDS | 私有 Set(2) | 派生：`new Set(NODE_KIND.filter(k => NODE_KIND_BEHAVIORS[k].settlesWithoutRow))`（WRAPPER_KINDS 模板） |
| `inventory.ts:32-36 / :127 / :181` | isAgentRunKind + PROMPT_CAPABLE_KINDS | 删两者，改 `isAgentNodeKind` |
| `sessionView.ts:31 / :72`（backend） | PROMPT_CAPABLE_KINDS 逐字复制 | 同上 |
| 前端 `lib/node-prompt.ts:36` / `lib/injected-memories-card.ts:13` | isPromptCapableKind / isAgentKind | 改 import shared `isAgentNodeKind`（null 守卫保留在调用点） |
| `stuckTaskDetector.ts:428-429` | 内联 review/clarify 集 | review 判定保持字面（单 kind）；clarify 家族改 `settlesWithoutRow` 谓词（语义恰等：等人工的非行 kind 家族）——**若语义偏差则保持字面并注释**（实现时核） |
| `scheduler.ts:378-397` runTask 白名单 | `!isWrapperKind` + 6 个 `!==` 负枚举 | 正向：`!(node.kind in NODE_KIND_BEHAVIORS)` → fail（表 = 已支持全集；负枚举删除）。fanout-routing 文本锁 :41 同步改 |
| runOneNode fall-through（:2146 前） | 隐式 agent-single 兜底 | 加一行守卫：`if (node.kind !== 'agent-single') return { kind:'failed', … 'unhandled-node-kind' }`（D2：不重排 if-chain 为 switch——几百行缩进 diff + 闭包结构不值得；运行时守卫兜底穷举） |

## 2. 端口声明层单源（新 shared/nodePorts.ts）

### 2.1 分层与返回结构（D3）

```ts
export interface DeclaredPort { name: string; kind?: string }  // kind = 输出端口 kind（控制流消费）
export interface DeclaredPorts {
  dataInputs: DeclaredPort[]
  dataOutputs: DeclaredPort[]
  /** agent 的 __clarify__/__clarify_response__/__external_feedback__、clarify 的
   *  questions/answers、cross 的 to_designer/to_questioner。validator 消费；
   *  canvas 渲染层不消费（维持「系统口靠边补」的现状渲染契约）。 */
  systemInputs: DeclaredPort[]
  systemOutputs: DeclaredPort[]
}
export function declaredPorts(
  node: WorkflowNode,
  agentByName: ReadonlyMap<string, Agent>,
  nodeById: ReadonlyMap<string, WorkflowNode>,   // review inputKind / fanout 派生需要邻居
): DeclaredPorts
// 内部 Record<NodeKind, (ctx) => DeclaredPorts> + satisfies 穷举。
```

- 分组化解「canvas 靠边补 vs validator 硬编码」的真相分裂（D3）：**同一张表两种投影**，
  canvas 行为字节不变（canvas.test.ts:146-155 的靠边补契约保留），validator 的硬编码
  段（:265-348 全部 8 case + agent 系统口）删除改查表。
- 规则来源：以 canvas `computePorts`（数据口权威）+ validator（系统口权威）合并为准；
  fanout 的 declaredInputs / `deriveWrapperFanoutOutputs` / review 的
  `reviewApprovedPortName` + inputKind 解析全部内聚进表（消费既有 shared oracle）。
- `kind?` 字段：agent-single 从 `agent.outputKinds`、fanout 从派生结果携带——控制流
  `sourcePortKind` 变成 `declaredPorts(...).dataOutputs.find(p => p.name===port)?.kind`。

### 2.2 五消费面切换

| 消费面 | 现状 | 改造 |
|---|---|---|
| canvas `computePorts`（WorkflowCanvas.tsx:1487-1631） | 全量 switch | 薄封装：declaredPorts 数据口 + 入/出边容错（跳 boundary）+ 有序化。行为字节不变（canvas.test 全绿为证） |
| validator（workflow.validator.ts:265-348） | 第五 fork（最全，含系统口） | 删 switch，查表取 data+system；**不吃边**语义保留（本来就不吃） |
| loop 候选 `deriveOutputPorts`（wrapperCandidates.ts:72-92） | agent/review 两 case | 改 `declaredPorts(...).dataOutputs`（空则 `['out']` 的 agent 兜底保留在调用点） |
| 控制流 `sourcePortKind`（controlFlowEdge.ts:66-83) | agent/fanout 两 case | 改查表 dataOutputs.kind |
| 拖放 `existingInputPorts`（dropTarget.ts:30-47） | 边 + output 声明 | 改 declaredPorts.dataInputs + 入边（容错留调用点） |

## 3. 前端注册面

### 3.1 NodeInspector 拆分（D4）

- `components/inspector/` 新目录：`InputInspector.tsx` / `OutputInspector.tsx` /
  `AgentInspector.tsx` / `GitLoopInspector.tsx`（wrapper-git+loop 现共 case，拆为两文件、
  loop 复用 git 的只读 inner 段）/ `FanoutInspector.tsx` / `ReviewInspector.tsx` /
  `ClarifyInspector.tsx` / `CrossClarifyInspector.tsx`。
- 注册表：`const KIND_INSPECTORS = { … } satisfies Record<NodeKind, FC<EditProps>>`；
  `EditForm` 变 `const Form = KIND_INSPECTORS[node.kind]; return <Form …/>`。
- `titleField` 提为公共组件段（各 inspector 头部复用）；props 面 = 既有 `EditProps`
  （:135-147）不变——node-inspector 渲染测试群零改动为验收。
- 顺手：`NODE_TYPES`（WorkflowCanvas.tsx:105-117）补 `satisfies Record<NodeKind, …>`。
- `tabs-retrofit-grep` 源码锁只碰 tab 头 markup，拆分不动 header——不受影响（实现时验证）。

### 3.2 palette 描述符表（D5）

```ts
const PALETTE: Record<NodeKind, {
  section: 'agents' | 'wrappers' | 'io' | 'human'
  labelKey: string; descKey: string
  idPrefix: string          // 原 SHORT
  glyph: string             // 原 5+1 散装点之六（各 *Node.tsx 硬编码图标一并收）
  makeDefaults: (ctx) => Partial<WorkflowNode>   // 原 makeNode switch
}> = { … }  // satisfies 穷举
```

`PaletteItem` 联合、deserialize、makeNode、SHORT、buildPalette 全部退化为查表遍历；
`palette-icon-coverage` 的 glyph 字面量锁保持绿（值不变、来源换表）；各 `nodes/*Node.tsx`
的图标改 import 表（`AgentNode` ⚙ / `ReviewNode` ⚖ / `ClarifyNode`+`CrossClarifyNode` ⚡）。

### 3.3 nodeTitle 单源（D6）

`nodeTitle`（WorkflowCanvas.tsx:1756-1773）与 `deriveTitle`（wrapperCandidates.ts:34-50）
合并为 shared/前端 lib 单源 `nodeDisplayTitle(node)`，规则采用**完整版**（title 优先 →
agent-single→agentName → input→inputKey → review→`review:<port>` → node.id）。canvas 上
review 节点标题从裸 id 变为 `review:<port>`——本 RFC 唯一有意的展示变化（信息增量），
`canvas-node-title` 测试同步。

## 4. 决策记录

- **D1 删愿望维而非接线**（拍板准则）：四维零消费者 = 假 SSOT；「接线兑现」会把 status
  驱动的正确机制改成 kind 查表的平行机制（无收益有风险）。表的准入标准从此是「有运行时
  消费者」。
- **D2 runOneNode 不表化、不重排**：`Record<NodeKind, handler>` 会把持有 SchedulerState
  闭包的 handler 提进共享表（反向依赖）；switch 化 = 几百行缩进 diff + 文本锁翻新，
  收益仅编译穷举。折中 = runTask 白名单表驱动（入口穷举）+ fall-through 运行时守卫。
- **D3 声明层分组 data/system**：canvas 与 validator 对系统口的分歧是**投影差异**不是
  真相分歧——一张表、两种投影，两侧现状语义字节保留。
- **D4 Inspector 注册表 + props 面冻结**：既有渲染测试零改动作为「拆分无行为变化」的
  机器证明。
- **D5 palette 单表含 glyph**：图标是 palette 知识的第 6 散装点，一并收。
- **D6 nodeTitle 采完整规则**：两份合并必须择一，取信息多的一侧；展示变化显式记录。
- **D7 stuckTaskDetector 的 clarify 集**：优先用 `settlesWithoutRow` 谓词表达（语义：
  等人工且不写行的家族恰为 clarify 系）；实现时若发现语义不完全重合（如未来新增
  settlesWithoutRow 但非人工 kind），回退为独立维度或保持字面 + 注释。

## 5. 测试策略

1. 行为表：node-kind-behavior-table 重写（三新维逐 kind 值锁 + 四删维消失断言 +
   谓词引用同源）；cross-clarify-rfc056-shared 的行相等断言更新。
2. 谓词收敛：新增「全仓无第二份 agent-single 判定」grep 守卫（isAgentRunKind /
   PROMPT_CAPABLE_KINDS 文本消失）；wrapper-fanout-schema 的 isProcessNodeKind 断言保绿。
3. settlesWithoutRow：derive-frontier C1 / rfc092 answer-race / s12 全绿（行为零变更）；
   派生 Set 与表一致的断言。
4. 端口声明层：新 shared 测试逐 kind 锁 declaredPorts（data/system 分组、review inputKind
   解析、fanout 派生、clarify 硬编码口）；canvas.test / fanout-port / control-flow /
   dropTarget / wrapper-candidates 全批保绿（消费面等价性证明）；validator 既有规则测试
   全绿（rfc094 守门等）。
5. Inspector：node-inspector 全批渲染测试零改动全绿；注册表 satisfies 编译锁。
6. palette：palette.test / palette-icon-coverage 全绿（默认值 byte 对齐断言保留）。
7. nodeTitle：canvas-node-title 更新 review 格 + wrapper-candidates 标题断言复用单源。
8. runTask 白名单/守卫：scheduler.test:206 与 fanout-routing 文本锁更新；新增「未支持
   kind 正向拒绝」与「fall-through 守卫」单测。
