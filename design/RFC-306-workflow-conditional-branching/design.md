# RFC-306 工作流条件分支 —— 技术设计

> 读法：先读 `proposal.md`（尤其 §4 行为规格、§5 行为影响清单、§7bis 设计门结论），本文只讲怎么实现。
> 源码锚点取自 `main` @ `fbe9ac9f`（设计门评审基线）。`scheduler.ts` 在并发提交下行号漂移快，
> **锚点以符号名为准、行号仅供定位**。
>
> **本文已按设计门（Codex，2026-08-16，9×P1 + 5×P2）的结论修订**；被门推翻的原始表述已就地更正，
> 逐条处置见 `proposal.md §7bis`。

## 1. 落位与 RFC-294 对齐

### 1.1 归属

分支判定属于 **`task-execution` bounded context**（RFC-294 proposal §G2：「Task/NodeRun 生命周期、调度、
恢复、运行态 ownership、wrapper/fanout」）。本 RFC 新增的**纯域逻辑**全部落在模块内：

```
packages/backend/src/modules/task-execution/
  domain/branchActivation.ts        # 纯函数：端口激活 → 节点激活判定（无 DB / 无 scheduler import）
  application/resolveNodeActivation.ts  # 组合 DB 读取 + domain 判定，供 scheduler 调用
  application/branchTrace.ts        # getTaskBranchTrace(taskId)：运行轨迹查询（前端唯一入口）
                                    # 注意：**不放 public/** —— 它需要 DbClient，而 RFC-294
                                    # preflight 禁止 public 面出现基础设施类型（"no type taint"）。
                                    # 跨包传的只有 BranchTrace 值对象，它已在 shared 里（前端要渲染）
```

跨模块只经 `public/*` 合同；前端拿轨迹只能走 `getTaskBranchTrace`，**不允许**自己在前端重算判定
（否则前后端两份判定必然漂移）。

### 1.2 偏离项（逐条呈用户确认）

1. **调用点仍在 `services/scheduler.ts`**。W2 尚未把调度器迁进模块，本 RFC 不做该迁移；
   新逻辑落模块 `domain/application`，scheduler 只做**一处**调用。承担的演进：把「激活判定」这件事
   从一开始就放在目标位置，不在 `services/` 里再长一块横向耦合。留下的债：调用点迁移随 W2。
2. **`freshness.ts` / `dispatchFrontier.ts` 仍留在 `services/`**。本 RFC 只在原地改口径（§6.1），
   不顺手搬家——这两个文件是三十多个测试文件的纯函数锚，搬迁属于 W2 的独立波次。
3. **端口激活状态存在 `node_run_outputs` 列上**（§2.1），而不是新建聚合表。理由：所有端口读点已经
   围绕这张表，新表会立刻制造第二事实源。

## 2. 数据模型

### 2.1 migration 0172 —— `node_run_outputs.active`

现表定义在 `packages/backend/src/db/schema.ts:1995-2019`（PK `(node_run_id, port_name)`）。

```sql
-- 0172_rfc306_port_activation.sql
ALTER TABLE node_run_outputs ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
```

- `1` = 激活（默认；存量行、未标记端口、缺失端口补空串的行全部落在这里）；
- `0` = 不激活；此时 `content` 存的是**决策理由**（可为空串），不再是数据。

不加索引：所有读点都已按 `(node_run_id, port_name)` 主键或 `node_run_id` 前缀走。

### 2.2 `node_runs.force_activated`（同一 migration）

```sql
ALTER TABLE node_runs ADD COLUMN force_activated INTEGER NOT NULL DEFAULT 0;
```

承载 §10「仍然执行」：用户对 `skipped` 节点点强制执行时，`retryNode` 在铸的行上打 1，
调度判定看到即视为激活一次。默认 0 ⇒ 存量行为不变。

### 2.3 状态与 cause

- 节点跳过复用既有 `node_runs.status='skipped'`（`packages/shared/src/schemas/task.ts:1016`，
  枚举早已存在，**零 migration**）。
- `RERUN_CAUSES` 新增 `'branch-skip'`（`schemas/task.ts:1050-1113`）：该行是分支判定产物，
  不是重试、不是 park。

## 3. 线协议与解析

### 3.1 端口属性解析（`services/envelope.ts`）

今天的开标签正则**不允许任何属性**：

```ts
// envelope.ts:210
const PORT_OPEN_RE = /<port\s+name=(?:"([^"]+)"|'([^']+)')\s*>/g
```

改为容纳可选属性，并**逐属性 token 扫描**出 `active`（设计门 P2#11 修订）：

```ts
// 属性段写成严格的 name="value" 序列，而不是 [^>]*：
// 正文里的散文 `<port name="a" is the left port>` 必须继续被当作文本。
const PORT_ATTRS_RE_SRC = String.raw`(?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*`
const PORT_OPEN_RE = new RegExp(
  String.raw`<port\s+name=(?:"([^"]+)"|'([^']+)')${PORT_ATTRS_RE_SRC}\s*>`,
  'g',
)
// 从标签起始位置 sticky 逐对匹配，值被整体消费 ⇒ 值里的内容永远不会被当成属性
const PORT_ATTR_PAIR_RE = /\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y
```

- **不能**用 `/\sactive\s*=/` 之类的文本搜索。设计门给出的两个反例都很朴素：
  `<port name="p" data-active="false">`（另一个属性名）、
  `<port name="p" note="x active='false'">`（**另一个属性的值里**恰好有空格 + `active=`）——
  文本搜索会在这两种情况下关闭一条作者根本没关的分支。两例已成为回归用例。
- 解析规则：无 `active` ⇒ 激活；`true` / `false`（大小写不敏感、允许空白）⇒ 对应值；
  其他取值 ⇒ 记入 `badActiveAttr: string[]`，**不猜**（猜哪一边都会静默产生错误的图）。
- **其它属性一律忽略**（向前兼容，不报错）。
- 同名端口重复出现仍是「后者胜」（既有语义），激活标记随最后一次出现。
- **框架损坏优先于分支判定**：进了 `malformedPorts` 的端口不再报告为分支决策——
  它的闭合都坏了，标记同样不可信，报上去只会让 agent 去修错的东西。

`EnvelopeParseResult` 增加：

```ts
inactivePorts: string[]   // 声明端口中被标 active="false" 的
badActiveAttr: string[]   // active 属性值非法的端口
```

**必须同步修正的两处**（否则解析口径分叉）：

1. 吸收检测（`envelope.ts:461-466`）里手工拼的 `<port\s+name=("x"|'x')\s*>` 正则，同样要允许属性；
2. 结构化闭合扫描（`envelope.ts:402-413`）判定下一个端口开标签的 `/^<port\s+name=/` 前瞻不受影响
   （只看前缀），但需补测「带属性的下一个端口」不会被误判为内容。

### 3.2 声明对账与协议违规（`services/runner.ts`）

在既有 envelope 分支（`runner.ts:1887-1933`，`kind === 'output'` 分支）里，紧接
`parseEnvelope` 之后、`malformedPorts` 判定之前插入：

```ts
const declaredBranch = new Set(opts.agent.branchPorts ?? [])
const illegal = parsed.inactivePorts.filter((p) => !declaredBranch.has(p))
if (parsed.badActiveAttr.length > 0) {
  status = 'failed'
  failureCode = 'branch-marker-malformed'
  errorMessage = `${BRANCH_MARKER_MALFORMED_PREFIX}: …`
} else if (illegal.length > 0) {
  status = 'failed'
  failureCode = 'branch-port-not-declared'
  errorMessage = `${BRANCH_PORT_NOT_DECLARED_PREFIX}: …`
}
```

顺序：**先于** RFC-049 的 per-kind 校验与入库（`runner.ts:1935-2100`），因为协议违规时不应写任何端口行。

两个新 `failure_code` 进 `shared` 的 failure-code 集合，并在 `decideEnvelopeFollowup`
（`scheduler.ts:1656`）里加入 followup 家族：同 session 重问一次，文案由
`packages/shared/src/prompt.ts` 的 repair 段生成（§3.4）。

### 3.3 入库（`services/runner.ts:2071-2097`）

```ts
const inactive = new Set(parsed.inactivePorts)
…
.values({ nodeRunId, portName: name, content: persisted, kind, archiveJson,
          active: inactive.has(name) ? 0 : 1 })
.onConflictDoUpdate({ …, set: { content: persisted, kind, archiveJson, active: … } })
```

**不激活端口跳过 RFC-049 的 per-kind 内容校验与 RFC-193 归档**：内容此时是自然语言理由，
不是 `markdown_file` 路径或 `list<…>` 载荷。这一条写进 `resolvePortContentDetailed` 的调用点判断，
不改 handler 契约。

`RunResult.outputs`（供 fanout / wrapper 直接消费，`runner.ts:2054-2058`）同步产出
`RunResult.inactiveOutputs: string[]`，避免这些内部消费者绕过 DB 时丢掉激活信息。

### 3.4 prompt 协议块（`packages/shared/src/prompt.ts:820-876`）

`buildProtocolBlock` 对分支端口追加一段英文说明（放在 per-kind guidance 之后）：

> The following ports are BRANCH ports (`p1`, `p2`). Emitting a branch port normally activates its
> downstream chain. If a branch must NOT run this time, still emit the port and mark it inactive:
> `<port name="p1" active="false">short reason</port>`. The reason text is recorded for the run trace
> and is NOT passed to any downstream node. Never mark a non-branch port inactive.

以及 followup repair 段（`prompt.ts:1193-1280` 的 reason 家族）新增两条：
`branch-port-not-declared` / `branch-marker-malformed`。

### 3.5 script 节点（`services/scriptPorts.ts:43-73`）

- 复用同一个 `parseEnvelope`，因此属性解析自动生效；
- **严格性不变**：`missingDeclared.length > 0` 仍是硬失败（`scriptPorts.ts:67-73`）——
  script 想关分支必须显式输出 `<port name="x" active="false"></port>`；
- 越权 / 非法属性判定与 §3.2 同形（script 的声明来自 `ScriptOutputPortSchema.branch`）。

## 4. 声明面

### 4.1 shared 契约

| 位置                                                    | 变更                                                                                                                                            |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemas/agent.ts`（`outputs` 旁，:214-217 / :328-335） | 新增 `branchPorts?: string[]` sidecar，随 `frontmatter_extra` 存取（与 `outputKinds` / `outputWrapperPortNames` 同通路）                        |
| `schemas/workflow.ts:903-909`                           | `ScriptOutputPortSchema` 增 `branch: z.boolean().optional()`（该 schema 是 `.strict()`，必须显式加字段）                                        |
| `schemas/workflow.ts:137-164`                           | `WorkflowNodeSchema` 是 `.passthrough()`，`joinMode?: 'any' \| 'all'` 由验证器与调度器读取，无需改基 schema；导出 `JoinModeSchema` 供验证器复用 |
| `nodePorts.ts:63-73`                                    | `DeclaredPort` 增 `branch?: boolean`；agent / script deriver 各自填充                                                                           |
| `schemas/task.ts`                                       | `RERUN_CAUSES` 加 `'branch-skip'`；failure code 常量加两条                                                                                      |
| `outputKinds/*`                                         | **不动**。分支与 kind 正交                                                                                                                      |

`declaredPorts()`（`nodePorts.ts`）是端口声明的唯一事实源（RFC-146 已把五处分叉收敛到这里），
因此画布、验证器、调度器读「这个端口是不是分支端口」都只经它。

### 4.2 验证器（`services/workflow.validator.ts`）

新增规则：

- `join-mode-invalid`：`joinMode` 取值不在 `{any, all}`；
- `branch-port-unknown`：script 节点 `outputs[].branch` 为 true 但端口名不在声明里（结构性冗余保护）；
- `exit-condition-port-not-branch`：`port-inactive` 退出条件指向的端口未声明为分支端口
  （否则该条件永不成立，是纯粹的作者错误）；
- **不新增**「分支必须有汇合点」「AND join 不得接互斥分支」之类的可达性规则——静态判不出，且会误伤。

## 5. 激活判定（域模型）

### 5.1 纯函数（`modules/task-execution/domain/branchActivation.ts`）

```ts
export type EdgeActivation =
  | { kind: 'active' }
  | { kind: 'inactive'; reason: 'port-inactive' | 'source-skipped' }
  | { kind: 'unresolved' } // 上游还没结算（防御；正常路径不会出现）

export interface NodeActivationInput {
  nodeId: string
  /** 与 resolveUpstreamInputs 同一投影后的入边激活状态（见 §6.2） */
  inbound: readonly EdgeActivation[]
  joinMode: 'any' | 'all'
  /** §10 人工强制执行 */
  forceActivated: boolean
}

export function resolveNodeActivation(
  i: NodeActivationInput,
):
  | { kind: 'active' }
  | { kind: 'skipped'; reason: 'all-inbound-inactive' | 'required-inbound-inactive' }
```

判定表（**唯一**判定实现，前端与后端共用同一结论）：

| 条件                               | 结果                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `forceActivated`                   | active                                                                                                  |
| `inbound` 为空                     | active                                                                                                  |
| 存在 `unresolved`                  | active（防御性；与今天「upstream node_run not found ⇒ warn 后继续」同口径，`scheduler.ts:10203-10206`） |
| `joinMode='any'` ∧ 至少一条 active | active                                                                                                  |
| `joinMode='any'` ∧ 全部 inactive   | skipped(all-inbound-inactive)                                                                           |
| `joinMode='all'` ∧ 存在 inactive   | skipped(required-inbound-inactive)                                                                      |
| `joinMode='all'` ∧ 全部 active     | active                                                                                                  |

### 5.2 边激活的求值（`application/resolveNodeActivation.ts`）

对节点 N 在迭代 i：

1. 取 N 的入边 = **显式 dataflow 边 ∪ 隐式依赖**：
   - 显式：与 `resolveUpstreamInputs` 共用 `collectDataflowInboundEdges`
     （`boundary === undefined` + `channelEdgeDataflowSkip` + `resolveWorkflowSourceRef` 解析 wrapper 边界），
     杜绝第三份手抄；
   - **隐式（设计门 P1#2）**：`review.inputSource` 与 `output.ports[].bind`——这两类是调度器
     `buildScopeUpstreams` 早已承认的依赖，但常常**没有对应的边**。只看边会让 review / output 读成
     「无上游的根节点」⇒ 被关闭分支上的 review 照样弹给人审、output 照样落 `done`。
     由 `collectImplicitInboundRefs` 提供，与 `buildScopeUpstreams` 的隐式依赖走同一套判据。
   - loop 的 `exitCondition` / `outputBindings` **不算入边**：那是容器读自己的**内部**，
     把它当入边会让 wrapper 在自己 body 关分支时把自己也跳过——而那恰恰是它必须继续跑完提升 outlet 的场景。
2. 每条边取源节点在窗口 i 内的**最新已结算 top-level 行**（§6.1 `pickUpstreamSettledRun`）：
   - 无行 ⇒ `unresolved`；
   - `status='skipped'` ⇒ `inactive(source-skipped)`；
   - `status='done'` ⇒ 查 `node_run_outputs(runId, portName)`：无行 ⇒ active（D2 默认）；
     `active=0` ⇒ `inactive(port-inactive)`；否则 active。
3. `joinMode` 从节点定义读（`pickString(node, 'joinMode') ?? 'any'`）。
4. 交给 §5.1 判定。

## 6. 调度器集成

### 6.1 结算口径统一（`services/freshness.ts`）

两处 done-only 过滤扩为 **done ∪ skipped**：

- `pickUpstreamSourceRun`（`freshness.ts:179-186`，第 183 行 `row.status === 'done'`）
  → 新增 `pickUpstreamSettledRun`，过滤 `status === 'done' || status === 'skipped'`。
  **原函数保留**给「只要有内容的行」的读点？——不保留：调查后所有调用点都应看到 skipped
  （否则会跳过 skipped 行读到更早的 done 行内容，把「已关闭的分支」误判成激活，是本设计的核心正确性点）。
  故直接改 `pickUpstreamSourceRun` 的过滤谓词，并在函数注释里写明 RFC-306 口径变更 + golden lock。
- `buildFreshestDonePerNode`（`freshness.ts:277-291`，第 287 行）同样纳入 skipped，
  函数更名为 `buildFreshestSettledPerNode`，旧名保留为 deprecated 别名一个波次（调用点 8 处，一次改完则不留别名）。

**为什么必须一起改**：`isNodeRunFresh` 用这张表判断「我消费的上游 run 还是不是最新」。若 skipped 行不进表，
一个消费了 skipped 上游的下游行会永远被判 stale → 无限重调度。

### 6.2 判定发生的位置（`services/scheduler.ts`）

在 `runOneNode`（`scheduler.ts:5637`）**最开头**、`output` 节点分支（:5644）之前插入统一判定：

```ts
const activation = await resolveNodeActivationFor(state, node, iteration)
if (activation.kind === 'skipped') {
  // 见下：先结算当前锚点，而不是在它旁边插一条终态兄弟行
  const nrId = await settleAsSkipped(state, node, iteration, activation)
  broadcastNodeStatus(taskId, nrId, node.id, 'skipped')
  return { kind: 'ok', summary: '', message: 'branch-skipped' }
}
```

**落行方式（设计门 P1#8）**：`skipped` 不在 `MintableNodeRunStatus` 里，而生命周期表已有
`mark-skipped: pending → skipped`。所以按当前最新行分三种情况：

| 最新行                               | 处置                                          | 为什么                                                                                                                                                           |
| ------------------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`                            | **复用**该行（写 consumed 后 `mark-skipped`） | 它是 clarify 回答 / review iterate 铸的锚点。留着它 ⇒ 行解析器日后会复用它、拿被关闭的分支去跑；而且它 id 比 skip 行**旧**，会让 skip 永远是 latest ⇒ scope 卡住 |
| `awaiting_review` / `awaiting_human` | 先 `cancel-by-supersede`，再铸 skip 行        | 否则待办列表里留着一条「等人审」的条目，而那条分支根本不会跑                                                                                                     |
| 其它（done / failed / 无行 …）       | 铸 `pending` → `mark-skipped`                 | 是已结算代次之上的新一代                                                                                                                                         |

崩溃安全：两步写之间挂掉只会留下一条 `pending` 行，孤儿回收把它翻 `interrupted`，下一轮重新判定——自愈。

要点：

- **必须写 `consumed_upstream_runs_json`**，否则 D10 的「跳过可被推翻」判不出 stale。判定时已经解析出每个
  上游的 run id，直接复用。
- 放在 `runOneNode` 顶而不是 `deriveFrontier` 里：frontier 是纯函数且不读 `node_run_outputs`；
  判定需要端口级数据，属于「dispatch 时」的事。frontier 只管把节点放进 ready。
- `settlesWithoutRow` 家族（clarify / clarify-cross-agent，`node-kind-behavior.ts:133-148`）**不走这条**：
  它们本就不落行（`deriveFrontier` pass 2，`scheduler.ts:2475-2482`）。上游被跳过时它们没有会话可开，
  自然 no-op 结算；画布上的置灰由 §11 的轨迹查询推导。

### 6.3 frontier 侧改动（`services/dispatchFrontier.ts` / `scheduler.ts:2406-2728`）

1. `deriveFrontier` pass 1（:2441-2471）：`status === 'skipped'` ∧ fresh ⇒ 进 `completed`
   （与 done 同一条件分支，共用 `isNodeRunFresh` + `isMergeStateSettled` 不适用于 skipped，直接跳过 merge 判定）。
2. `isDispatchable`（`dispatchFrontier.ts:373-376`）：`case 'skipped': return !isNodeRunFresh(row, freshestDone)`
   —— 与 `done` 完全对称，注释里替换掉「零 mint 点」的历史说明。
3. **stale skip 的一次性释放（设计门 P1#7）**：同一次 `runScope` 里，若某节点先被判 skipped，
   随后**本次调用内**上游又重跑（例如 review iterate 借 pending anchor 释放）把分支重新打开，
   该节点已在 `dispatchedThisInvocation` 里、自身又没有 pending 行 ⇒ 永远无法再 ready，
   scope 静默后报 `scheduler stalled`——**一次正常的分支翻转被呈现为任务失败**。
   处置：为「stale 的 skipped 行」增加与 pending anchor 同形的一次性释放，
   **键取「使它变 stale 的那个上游 run id」**（`freshestUpstreamEvidenceId`），
   于是同一个上游代次至多释放一次，再释放必须有更新的上游 run（无 busy-loop）。
4. `deriveFrontier` 的 blocked 诊断分支：`skipped` 的 reason 改为
   `'stale-skipped-in-invocation-dedup'`，与 `done` 的表述对齐。
5. `schedulerMintCause`（`nodeRunMint.ts:277`）：`skipped` 的映射从「防御性 stale-redispatch」保持不变
   （重新评估时铸的新行 cause 就是 `stale-redispatch`，正确）。

### 6.4 输入解析（`scheduler.ts:10144-10224`）

`resolveUpstreamInputs` 在读端口内容时（:10208-10216）：

- 源行是 `skipped` ⇒ 该输入贡献空串（节点若仍被判 active，说明是 OR join 的另一条腿活着）；
- 端口 `active=0` ⇒ 同样贡献空串（**理由文本绝不进 prompt**——这是 agent 的自述，不是数据，
  也避免把「为什么不走」的措辞泄进另一个 agent 的上下文）。

返回值增加 `inactiveInputs: string[]`，供 §11 轨迹与调试展示。

### 6.5 output 节点（`scheduler.ts:5644-5700`）

- 节点整体被判 skipped（§6.2）时根本不进这段；
- 节点 active 但某个 binding 的源端口不激活：`readPortRowAtIteration` 返回 `active=0`，
  投影出的 `node_run_outputs` 行同样写 `active=0`、`content=''`，详情页显示「未激活」。

`readPortRowAtIteration`（`scheduler.ts:10246-10288`）返回值增加 `active: boolean`，
并把内部 `pickUpstreamSourceRun` 换成结算口径（§6.1）。

## 7. 容器边界

### 7.1 wrapper-loop 出口（`scheduler.ts:9363` `upsertWrapperOutput` / `completeLoopWrapperIteration:7371`）

出口端口绑定内部 `(nodeId, portName)`。提升时读 `readPortRowAtIteration` 的 `active`：
不激活 ⇒ `upsertWrapperOutput(..., { active: 0 })`。wrapper 外的下游因此按普通端口不激活处理（§5.2）。

### 7.2 wrapper-git

`git_diff` 是框架快照产物，恒 `active=1`（开放项 Q-B）。内部链全跳过 ⇒ 空 diff，与今天「无改动」一致。

### 7.3 wrapper-fanout（`runFanoutWrapperNode` / `dispatchFanoutShardAttempt` / `dispatchFanoutAggregatorAttempt`）

**边界先说清楚（设计门 P1#3/#4 更正）**：validator 只允许 fanout 内部的 `inner → aggregator` 边
（`workflow.validator.ts` 的 `fanout-inner-chain-unsupported`），所以分片内部**没有可跳过的下游链**；
分片子行由 `dispatchFanoutShard` 直接铸、**不经过 `runOneNode`**，因此**永远不会产生 skipped 分片行**。
这两点合起来意味着：

- 分支在 fanout 里的唯一形态是「**分片把自己的端口标成 `active=false`**」；
- **聚合输入过滤**：`dispatchFanoutAggregatorAttempt` 组装每个 shardKey 的输入时跳过
  `port.active === false` 的分片——不以空项占位（D13）。空项会让聚合器 prompt 里出现 N 个空的
  `### shardKey` 段（读起来像「这些分片查过、没发现问题」，而它们根本没被问过），
  更糟的是把该分片的**理由文本**当作发现塞进聚合；
- `pickReusableShardRun` 保持 done-only：既然分片行永不为 skipped，它不需要结算口径（门 P1#4 的场景不可达）；
- **聚合器出口继承（门 P1#5）**：聚合器自身可以声明分支端口——这正是「分支从 fanout 里穿出去」的路径。
  outlet 提升必须读取聚合器端口行的 `active` 并透传给 `upsertWrapperOutput`，否则分支在 wrapper 边界处静默复活；
- 失败语义不变（fail-all-after-join）：`skipped` 不是失败，不触发整 wrapper 失败；
- 全部分片不活跃 ⇒ 聚合器拿空列表照常启动（开放项 Q-A）。

### 7.4 call-workflow / call-workgroup（设计门 P1#6：**三层**契约，缺一层就断链）

子任务结束后把子工作流 output 节点的端口投影到父节点端口。`active` 必须在**每一层**都在场：

1. `services/execution/outcome.ts` 的 DB 读取要 `select` 出 `node_run_outputs.active`；
2. `ExecutionOutcome.outputs` 的值对象要带 `active?: boolean`；
3. `runCallWorkflowNode` 往父行写端口时要落 `active`。

另有一处只在这里才会暴露的坑：子侧 output 节点**整个 skipped** 时它没有任何端口行，
于是投影结果里该端口**整个消失**，父图按 D2「缺端口 = 激活」处理 ⇒ 分支在任务边界处复活。
所以投影要读快照里该 output 节点**声明的端口名**，为它们显式产出 `{content:'', active:false}`，
并且不再报 `output-node-without-done-run` 警告（它是正常的分支结果，不是异常）。

## 8. 循环退出条件（`services/exitCondition.ts`）

```ts
export type ExitCondition =
  | … 既有四种 …
  | { kind: 'port-inactive'; nodeId: string; portName: string }

export interface ExitPortValue { content: string; active: boolean }
export function evaluateExitCondition(cond: ExitCondition, v: ExitPortValue): boolean
```

判定表（`active === false` 时）：

| kind             | 结果                           |
| ---------------- | ------------------------------ |
| `port-inactive`  | **true**                       |
| `port-empty`     | **true**（D14'，保护存量循环） |
| `port-not-empty` | false                          |
| `port-equals`    | false                          |
| `port-count-lt`  | false                          |

`active === true` 时行为与今天逐字节一致（现有测试即 golden lock）。
调用点在 `runLoopWrapperNode`（`scheduler.ts:7441`），把 `readPortAtIteration` 换成
`readPortRowAtIteration` 以拿到 `active`。

**逐轮重算**天然成立：判定发生在 dispatch 时、按 `iteration` 读行，第 i 轮的 skipped 行只影响第 i 轮。

## 9. 人工节点与不变量

- **review**（非 settlesWithoutRow）：上游未激活 ⇒ §6.2 落 `skipped` 行，
  不进入 `awaiting_review`、不写 review 记录、不发通知。
- **clarify / clarify-cross-agent**：不落行，自然 no-op（§6.2 末段）。
- **不变量 T3**（`services/lifecycleInvariants.ts` `checkT3`，设计门 P2#10 修订）：
  判据从「**存在**一条 done 行」改为「**最新** top-level 行 ∈ {done, skipped}」。
  只扩状态集合是不够的：旧实现问的是「历史上存在过 done 吗」，于是一个 output 节点
  「旧 done + 新 failed」照样通过——把集合扩成 done ∪ skipped 只会把这个洞变大，
  而本文承诺的恰恰是相反的方向（最新为 failed 必须报）。因此改为逐 output 节点取最新行判状态。

## 10. 人工「仍然执行」

- 入口：任务详情节点操作区，对 `status='skipped'` 的节点显示「仍然执行」（复用现有单节点重试按钮位）。
- 后端：`services/task.ts retryNode` 允许目标行为 `skipped`，铸的 placeholder 行写
  `force_activated=1`；`mintNodeRun` 的继承源（`nodeRunMint.ts:67` `MintInheritSource`）把该标志
  带到调度器随后铸的正式行上。
- 判定：§5.1 第一行——`forceActivated` ⇒ active。
- 输入：未激活上游贡献空串（§6.4），不做特殊处理。
- **一次性（设计门 P1#9）**：标志只写在 retryNode 铸的 placeholder 上；判定读的是「最新行」，
  节点真正执行后铸的新行**不带**该标志。因此下一次重新评估看到的是干净的行，按分支本身的判据重判——
  「运行一次」不会变成节点的永久属性。**不需要**额外的清零逻辑，但需要用例锁住
  「第二次上游更新后不再强制」。
- 传染性：**仅该节点**。下游按它的真实输出重新判定（开放项 Q-C）。
- 级联：沿用现有 retryNode 下游级联（`node-kind-behavior.ts` 的 `retryCascade`）。

## 11. 前端

### 11.1 运行轨迹（唯一数据源）

后端 `modules/task-execution/application/branchTrace.ts` 新增：

```ts
getTaskBranchTrace(db, taskId): Promise<{
  skippedNodeIds: string[]
  inactiveEdgeIds: string[]
  decisions: Array<{ nodeId: string; portName: string; reason: string; nodeRunId: string }>
}>
```

用 §5 的同一 domain 函数按当前行状态求值。**不新开端点**：挂在任务详情已经在拉、且已经随
`node-status` WS 事件失效的 `GET /api/tasks/:id/node-runs` 响应上——单独开端点就要单独做失效，
画布与旁边的节点表随时可能显示两套结论。

**展示切片（设计门 P2#13）**：loop 逐轮、fanout 分片存在时，一个节点/边**没有**单一激活状态。
因此：①每条记录都带 `iteration`，口径是「每节点最新已结算代次」；②fanout 另给
`shardActivation: {nodeId, active, total}`，让画布显示「3/20 分片激活」，而不是把它压成一个
两头都错的布尔。

**clarify 家族（设计门 P2#12）**：`clarify` / `clarify-cross-agent` 属 `settlesWithoutRow`
（C1/N6 既有契约：它们不落行），本 RFC **不改这一点**——落行会破坏该契约。行为面无损：
上游被跳过 ⇒ 没有会话可开 ⇒ 天然 no-op、不弹人工。轨迹里的置灰由本查询按其**上游状态**推导。

### 11.2 画布

- `WorkflowCanvas`（`components/canvas/WorkflowCanvas.tsx:250` `nodeStatuses`）已支持按节点状态渲染，
  补 `'skipped'` 一档（整卡置灰 + 状态角标）；
- 新增 `inactiveEdgeIds` prop → 边加 `canvas-edge--inactive` class；样式与
  `CONTROL_FLOW_EDGE_CLASS`（`canvas/controlFlowEdge.ts:35`）同族但更淡，避免与「signal 控制流边」混淆；
- 设计期：分支端口 handle 复用 signal 的虚线环视觉（`styles.css` `.canvas-node__handle--signal` 家族，
  新增 `--branch` 变体）。

### 11.3 表单与列表

- 「分支端口」开关落在 `components/agent-ports/AgentPortDialog.tsx` 与 `components/OutputsEditor.tsx`，
  用公共 `<Switch>`（`components/Form.tsx`）——**禁止**新写 checkbox；
- script 端口编辑器（`components/canvas/inspector/` 下 script 面板）同一开关；
- `joinMode` 落 `NodeInspector`，用 `.segmented`（2 选 1 短列表，CLAUDE.md §Frontend UI consistency）；
- 节点表 `skipped` chip 复用既有 `<TaskStatusChip>` / node 状态 chip 家族，不新写样式；
- 决策理由展示在节点详情的 Outputs 区，端口标题旁标「未激活」并显示理由文本。
- i18n：`en-US` / `zh-CN` 双语齐全。

## 12. 失败模式表

| 场景                                 | 行为                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------ |
| 越权标记不激活                       | `failed(branch-port-not-declared)` + 同 session 重问一次，重试用尽硬失败 |
| `active` 属性值非法                  | `failed(branch-marker-malformed)`，同上                                  |
| 整个 envelope 缺失                   | 不变：`failed(envelope-missing)`                                         |
| 分支端口漏输出（端口整体缺失）       | 不变：agent 侧 warn + 空串（激活）；script 侧仍硬失败                    |
| 上游 skipped 但下游 `joinMode='all'` | 下游 skipped，继续传播                                                   |
| 所有 output 节点被跳过               | 任务 `done`（D7）                                                        |
| `port-inactive` 指向非分支端口       | 保存期验证器拒绝（`exit-condition-port-not-branch`）                     |
| 强制执行一个上游全不激活的节点       | 正常执行，输入为空串                                                     |
| 跳过行 stale（上游重跑）             | 重新评估；可能翻转为执行                                                 |

## 13. 测试策略

**纯函数（必写）**

- `branchActivation.test.ts`：§5.1 判定表逐行；空入边；unresolved 防御；force。
- `envelope-branch-attr.test.ts`：无属性 / `active="false"` / `="true"` / 大小写 / 单双引号 /
  多属性共存 / 非法值 / 与 malformed 检测交互 / 与吸收检测交互 / nonce 作用域。
- `exit-condition-inactive.test.ts`：§8 判定表逐行 + `active=true` 时与既有测试逐字节等价。

**调度（必写）**

- 端到端跳过传播 + 任务 `done`（AC-1/AC-2）；
- **golden lock**：不含分支端口的既有工作流快照行为不变（AC-3）；
- 越权 / 非法属性的 failure code 与 followup（AC-4）；
- `joinMode` any/all（AC-5）；
- wrapper-loop / call 继承（AC-6）；fanout 活跃分片聚合（AC-7）；
- loop 逐轮 + 四种退出条件（AC-8）；
- review/clarify 跟随跳过、无待办（AC-9）；
- stale 推翻（AC-10）；强制执行（AC-11）；
- 不变量 T3 放宽后的正反用例（AC-12）。

**回归防护命名**：文件顶注明「锁 RFC-306 §X 的哪条判定」，例如
`scheduler-rfc306-branch-propagation.test.ts` 顶部写明「locks 端口不激活 ⇒ 下游 skipped ⇒ 任务 done，
反例：任一环节回退成 stalled 即失败」。

**前端**：画布轨迹渲染（`findByRole` 优先）、端口开关往返、节点表 skipped、i18n key 完备性。

**e2e**：一条「判定 agent → 两条互斥链 → 两个 output」的真工作流，断言只跑一条链、任务 done、
画布上另一条置灰。

## 14. 迁移与回退

- migration 0172 只加两列且都有默认值，**向后兼容**：旧代码读新库照常工作（多余列被忽略）。
- 无数据回填（存量行默认激活 / 未强制）。
- 回退路径：不声明任何分支端口即回到今天的行为；代码级回退只需还原两处口径改动（§6.1、§6.3）。

## 15. 呈用户确认的开放项

见 `proposal.md` §8（Q-A fanout 全不活跃 / Q-B git wrapper / Q-C 强制执行传染性）。
实现按当前设计推进，用户如改判则在对应 PR 内调整。
