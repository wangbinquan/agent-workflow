# RFC-127 — 技术设计：反问问题统一可指派 + 借壳顶替

> 读法：先 `proposal.md` 再本文。本文给接口契约、数据流、耦合点、失败模式、测试策略，并把「借壳顶替」机制讲透。证据 file:line 基于 2026-06-29 HEAD，**行号以符号名为锚**（RFC 并发改动后可能漂移）。
> 调研由两路并行子代理回源（产出/下游/freshness；agent 解耦/借壳）；下文 §1 是其结论的浓缩。

## 1. 现状机制回源（决定可行性的事实）

### 1.1 产出归属 + 下游消费：完全按「源节点 id + 端口名」

- 产出表 `node_run_outputs`（`schema.ts:803-820`）：主键 `(node_run_id, port_name)`；外键 `node_run_id → node_runs.id` cascade。`port_name` = agent 在 `<workflow-output><port name="...">` envelope 里实际吐出的端口名，框架不重命名。
- 写入：`runner.ts:1402-1444` —— 仅 `status==='done'` 落库（`:1430`）；落库前按 `agent.outputKinds[port]` 逐 port 校验，任一失败则整 run 翻 `failed`、不落任何 port（`:1402-1424`）。
- 下游读取：`resolveUpstreamInputs`（`scheduler.ts:4834-4888`）：取入边 `edges.filter(e => e.target.nodeId === nodeId)` → 对每条入边 `SELECT * FROM node_runs WHERE taskId AND nodeId === edge.source.nodeId`（**纯按工作流 node_id 定位上游，与具体哪条 run 无关**）→ `pickUpstreamSourceRun` 取 freshest done → 读该 run 的 `node_run_outputs` 找 `port_name === edge.source.portName` → 塞进 `grouped[edge.target.portName]`。
- Edge 模型：`WorkflowEdge = { source: PortRef, target: PortRef }`，`PortRef = { nodeId, portName }`（`workflow.ts:105-108,132-139`）；边冻进 `tasks.workflow_snapshot`（`schema.ts:457`）。
- Prompt 注入：`renderUserPrompt`（`prompt.ts:354-447`）的 `{{port_name}}` 绑的是**下游入端口名**（`edge.target.portName`）。

> **关键推论**：下游消费**只认 `node_id`**。只要原节点 P 名下出现一条 fresh `done` 顶层 run、带 P 下游边引用的端口，下游天然放行——它不关心这次实际是哪个 agent 跑的。这是借壳成立的地基。

### 1.2 agent 与 node_run 解耦：`node_runs` 无 agent 字段

- `node_runs`（`schema.ts:602-798`）只有 `node_id`（`:609`），**无 agentName/agentId 列**。
- agent 每个 tick 现解析：`runOneNode` → `agentName = pickString(node, 'agentName')` → `getAgent(db, agentName)`（`scheduler.ts:1764-1772`；`getAgent` 按 name 查 `agents` 表，`agent.ts:22-26`）。
- runner 收 agent 作入参、与 node_id/nodeRunId 解耦：`runNode(opts.agent, opts.nodeId, opts.nodeRunId)`；opencode CLI `--agent` 用 `opts.agent.name`（`spawn.ts:23-38`），inline 配置 `buildInlineAgentEntry`（`runner.ts:1675-1701`）的 `prompt/description/permission/options:{outputs,readonly}` 全取自传入 agent。
- env 注入：`buildOpencodeEnv`（`spawn.ts:59-88`）→ `OPENCODE_CONFIG_CONTENT = JSON.stringify(inlineConfig)`、`OPENCODE_CONFIG_DIR`。

> **关键推论**：「用 X 的 agent 跑一条归属 P 的 run」runner 侧零改——只需在 `scheduler.ts:1772` 那个**单一解析点**把 `agentName` 换成 X。

### 1.3 三类反问续跑现状（都只 mint `node_id=原节点`、不指定 agent）

- self：`clarify.ts:473-481` `mintNodeRun({ nodeId: sourceRunRow.nodeId, cause:'clarify-answer', inheritFrom })`。
- questioner：`crossClarify.ts:1004-1012` `mintQuestionerRerun({ nodeId: lastRun.nodeId, cause:'cross-clarify-questioner-rerun' })`。
- designer：`crossClarify.ts:887-896` `triggerDesignerRerun({ nodeId: designerNodeId, cause:'cross-clarify-answer' })`。

三者都靠调度器按 mint 出的行的 `node_id` 重新解析 agent（§1.2）→ 借壳只需在这些 mint 点 stamp override、解析点统一消费。

### 1.4 现状 designer 改派 = 「换节点」（本 RFC 要改的点）

`buildFrontierMintPlan`（`taskQuestionDispatch.ts:658+`）对 override 题 mint 的 run 用 **handler 自己的 nodeId**（`nodeId: targetNodeId` = X，`effectiveTarget = override ?? default`，`:116-118`），X 以 X 身份产出 X 的端口、走 X 的下游；从不顶替原 designer 的端口。**D3 要把它改成借壳（`node_id=原 designer`、agent=X）。**

### 1.5 freshness / park（借壳必须配套解除）

- freshness 单一收口 `freshness.ts`：`isNodeRunFresh`（`:54-65`）—— 被消费上游的「当前 freshest done id」变了则下游 stale → 重派（`dispatchFrontier.ts:310-340`）；`parseConsumedJson`（`:26-40`）空/畸形 ⇒ 恒 fresh。
- park：节点 `awaiting_human`（反问后）不在 completed 集，其下游无法派发；`decideScopeOutcome`（`dispatchFrontier.ts:396-408`）把整 scope 判 `awaiting_human`。**借壳 run `done` 后必须让原节点退出 park**，否则 scope 仍卡。

## 2. 数据模型

### 2.1 `node_runs` 加一列 + migration

| 列                    | 类型          | 含义                                                                                       |
| --------------------- | ------------- | ------------------------------------------------------------------------------------------ |
| `agent_override_name` | TEXT nullable | 借壳：本 run 实际用的 agent name（NULL = 用节点默认 agentName）。审计 + 跨 tick 重派可见。 |

- 新 migration（递增号，紧接 RFC-120 的 0060/0061 等已存在者之后取下一个空号）；多语句注意 `--> statement-breakpoint`（见 [migration-statement-breakpoint]）；HEAD journal +1 会撞 `upgrade-rolling.test.ts` 的「journal has N entries」锁，须同步 bump（见 [migration-bumps-journal-count-test]）。
- **不改** `task_questions`：改派仍写既有 `override_target_node_id`（全角色复用），只是 §3 把它消费成「借壳的 agent 来源」而非「换节点目标」。

### 2.2 借壳的 agent 解析口径

有效借用 agent name = 从 `override_target_node_id`（X 节点）解析 `X.agentName`（工作流快照里），而非直接存 agent name——这样改派语义仍是「选一个**节点**」（与 RFC-120 UI 一致、与 `canReassign` 的「目标须是 agent 节点」一致），借壳时再把 X 节点的 agentName 取出注入 `agent_override_name`。

## 3. 借壳机制（核心）

### 3.1 mint：`node_id=原节点`、stamp 借用 agent

`MintNodeRunOverrides`（`nodeRunMint.ts:70-89`）加 `agentOverrideName?: string`；`buildMintNodeRunValues`（`:126-175`）写出该列。三条续跑 mint 点（§1.3）+ 现状 designer 改派 mint（§1.4，改为 `node_id=原 designer`）在改派命中时传 `agentOverrideName = resolve(X.agentName)`。**与 `inheritFrom` 正交**（继承列不含 agent，借壳是新维度）。

### 3.2 agent 解析单点：`runOneNode`

`scheduler.ts:1764-1772` 解析前先读「本次要跑的那行」的 `agent_override_name`：非空 → `agentName = override`（再 `getAgent`）。**必须早于** `prepareNodeRunInjection`（闭包/skill/mcp/plugin 随 X，`scheduler.ts:1797`）与 `resolveFrozenRuntime`（runtime 随 X 的 `agent.runtime`，`:2659`）。当前 pending 行读取在 agent 解析之后（`:1838`）——落地时把行读取上提或 agent 解析下移到行已知之后（实现 gate 细化）。

**借壳必须断开原节点的 session / runtime 继承（Codex 设计 gate F1）**：clarify 续跑路径会从原 `node.id` 派生 `resumeSessionId` 并继承该 session owner 的 frozen runtime——借壳行若不处理，X 会 **resume P 的 opencode 历史对话 + 跑 P 的 runtime**，违反「runtime 随 X / X 的脑子」且泄漏 P 的 session 历史。故 `agent_override_name` 行须：① **清除 / 不继承 `resumeSessionId`**（X 全新 session、不接 P 的对话）；② frozen runtime 取 **X 的** `agent.runtime`（不继承 P 的）。统一原则：借壳行的一切「agent 派生物」（runtime / session / skill / mcp / readonly）都随 X，只有 `node_id` / promptTemplate / 上游输入 / **输出端口契约**随 P。

### 3.3 端口契约：用**原节点**的 outputs（不是 X 的）

借壳的产出协议块必须按**原节点声明的 outputs** 注入（让 X 吐 P 的端口），否则下游边引用 `P:port` 拿空。**但只改 `buildInlineAgentEntry` 不够（Codex 设计 gate F2）**：`runNode` 的**输出协议渲染、envelope 校验、产出持久化**都读 `opts.agent.outputs` / `opts.agent.outputKinds`（传入的 agent 对象），不是 inline `options.outputs`——只改 inline config 的话 X 仍按**自己**的 outputs 被 prompt / 校验，不会被要求吐 P 的端口、且 P 的 outputKind metadata 被跳过。**正解 = 构造一个「effective agent」对象传给 `runNode`**：`{ ...X〔body/model/runtime/readonly/skill 等〕, outputs: P.outputs, outputKinds: P.outputKinds }`——让 prompt 渲染（要 X 吐 P 的端口）、envelope 校验、产出持久化**全程**用 P 的输出契约，X 只贡献「脑子」。这个「X 的 agent 定义 + P 的输入/输出契约」混合在 effective agent 对象层一次性表达，而非散落 inline config。promptTemplate 本就 per-node（`scheduler.ts:1800`，node=P）→ 天然是 P 的；上游输入经 `resolveUpstreamInputs`（node=P）→ 天然是 P 的入边。

### 3.4 readonly 随 X（D4）

readonly 恒取自解析出的 agent 对象（`runner.ts:1691/848`、写锁 `scheduler.ts:1912`、fanout `:3977`、回滚 `:2001`）。借壳把 agent 换成 X 后，readonly 自动跟随 X，无需额外接线——但**类别可能翻转**（P readonly 借 X writer → 占写锁/串行；反之并行）。RFC 明确允许（proposal D4）。

### 3.5 解除原节点 park（让下游放行）

借壳 run（`node_id=P`）落 `done`+输出后，P 名下即有 fresh done 顶层 run → `decideScopeOutcome` 不再因 P 判 `awaiting_human`。需确认 clarify 的 park 来源（`clarify_sessions`/`node_run` awaiting_human 态）随借壳 run 的 done 被正确清掉——与现状 self/questioner 自我续跑 done 后退出 park 同一路径（借壳 run 就是那条续跑 run，只是换了 agent），故 park 解除复用现有机制、不需新逻辑。**这是借壳相对「换节点」(b)/(d2) 的关键优势：原节点真有一条 done run，park 自然消。**

### 3.6 prompt 注入内容（self 顶替语义，开放问题 1 的 v1 收口）

借壳 run 的 user prompt = 原节点 promptTemplate 渲染（原上游输入）+ 反问的「问题 + 答案」反馈块（self 走 `buildClarifyPromptBlock` `clarify.ts:721` 同源、questioner/designer 走 `buildExternalFeedbackBlock`）。**不重建 P 的内部对话历史**（平台续跑本就是无状态新进程，见 §1.2）；X 另可见 P 留在 worktree 的中间状态（cwd=worktree）。即 X 凭「P 的输入契约 + 问题 + 答案 + worktree 现状」接手。

## 4. 下游 / freshness：为什么天然正确

借壳 run 真正 `node_id=P`、top-level、done、带 P 端口 → `resolveUpstreamInputs`（§1.1）按 `nodeId=P` 命中、`isNodeRunFresh` 按真实 run id 记 provenance（非合成空 consumed，不会恒 fresh 漂移）、级联（`dispatchFrontier`）正常。**无需碰 resolver / 拓扑 / edge 重写**（对比 proposal 未选的「重映射 output」「重连边」方案，借壳是唯一 freshness 零特例的路径）。

## 5. 相位 / lineage 调和（RFC-120 记账）

`resolveHandlerRun`（`task-questions.ts:264-289`）现按 `effectiveTargetNodeId` 的 nodeId 框 lineage 取承接 run。借壳后承接 run 在**原节点**名下（不是 X）→ 框窗的 `effectiveTargetNodeId` 对借壳条目应取**原节点 id**（而非 override X）。契约：

- 借壳条目的 `effectiveTargetNodeId`（用于相位派生 / lineage 框窗）= **原节点 id**；`override_target_node_id` 仅用于「解析借用哪个 agent」（§2.2），不再当作承接 run 的 nodeId。
- 这与现状 designer「换节点」相反（那里 effectiveTarget=X 既是 agent 来源也是 run nodeId）——D3 统一后，**所有角色的承接 run nodeId 都是原节点**，`resolveHandlerRun` 统一按原节点框，逻辑反而更简单。
- 消费戳 `trigger_run_id` stamp 到借壳 run（在原节点名下），相位 `处理中/已处理待确认` 派生不变（RFC-120 AC-5/6 口径）。

## 6. 三类统一落地

| 角色       | 现状                           | RFC-127 后                                                     |
| ---------- | ------------------------------ | -------------------------------------------------------------- |
| self       | 自我续跑原提问节点（不可改派） | 默认自我续跑；改派→借壳（agent=X，run 归原提问节点）           |
| questioner | 自我续跑反问者（不可改派）     | 默认自我续跑；改派→借壳（agent=X，run 归反问者）               |
| designer   | 换节点 X、走 X 下游            | 借壳（agent=X，run 归原 designer、走 D 下游）——**行为变更 D3** |
| manual     | roleKind=designer、换节点      | 借壳（同 designer）                                            |

`canReassign`（`task-questions.ts:178-184`）放开角色限制：从 `roleKind==='designer'` 改为「任意角色 + 目标是工作流 agent 节点」。前端 `reassignable`（`TaskQuestionList.tsx`，RFC-127 前置修复已收窄到 `designer && pending`）改为「任意角色 + 未下发态（pending/staged）」。

## 7. 失败模式

1. **X 吐不齐原节点端口**：envelope 校验失败（`runner.ts:1402-1424`）→ run `failed` → 相位回「处理中」（D3 失败仍处理中），等人重选 agent / 重跑。UI 可在改派下拉旁提示「X 需能产出端口 a/b/c」（实现 gate 定）。
2. **X 节点被 RFC-109 sync 删 / 非 agent 节点**：改派校验 `canReassign` 的 `agentNodeIds` 取任务冻结快照 agent 节点 → 422（沿用 RFC-120 F5，`design/RFC-120.../design.md:170`）。
3. **readonly 翻转的写串行**：P readonly 借 X writer → 占写锁，与同任务其他写节点串行；需确认 `writeSem`（`scheduler.ts:1912`）无死锁/饥饿（借壳 run 与普通写节点同走一把信号量，无新锁，风险低）。
4. **借壳 run 进程级重试**：`agent` 在解析点解析一次、被重试循环复用（agent 2 调研：同一 `runOneNode` 内重试无虞）；**跨 tick 重派/复活**（`scheduler.ts` schedulerMintCause 路径）须把 `agent_override_name` 一并带上（`inheritFrom` 不含它）——否则后续 tick 退回解析原节点 agent。这是落地必锁的回归点。
5. **worktree 中间状态**：self 借壳时 X 见 P 的半成品；若 P writer 改了 worktree、X readonly → X 不写但能产出 envelope（output 走 stdout，readonly 也能吐）。语义可接受（proposal §5.1）。
6. **同轮多题混合改派**：沿用 RFC-120 §2.4 条目级反馈/消费戳隔离（Q1 改派 + Q2 默认不交叉污染）——借壳不改这套，只把承接 run 的 nodeId 从「X」改回「原节点」。

## 8. 与现有 RFC 的耦合

- **RFC-120**：问题清单/看板/确认/打回/回填/相位全继承；改的是 `canReassign` 角色限制 + 承接 mint 的 nodeId/agent + `resolveHandlerRun` 框窗口径。
- **RFC-099**：归属不进 prompt 铁律——借壳 run 的 promptText 不含改派人（AC-9 双层锁）。
- **RFC-074 freshness / RFC-097 lifecycle / RFC-098 调度**：借壳 run 是普通 node_run，走同一 freshness/生命周期/调度，无新原语。
- **RFC-109 sync**：X 节点删除 → 改派 422 / 已改派条目降级显示。

## 9. 测试策略（必写 case；先红后绿）

**纯函数 / oracle（shared）**

- `canReassign` 放开全角色 + 仍拒非 agent 节点 / 非工作流节点（AC-1）。
- 借壳 agent 解析：override 节点 → 取其 agentName 作 `agent_override_name`（§2.2）。
- `resolveHandlerRun` 借壳条目按**原节点**框 lineage（§5）；后续不相关新轮不误拉相位。

**service / 集成（backend）**

- 借壳 mint：self/questioner/designer/manual 改派下发 → mint `node_id=原节点` + `agent_override_name=X.agent`（AC-3）。
- agent 解析单点：带 override 的 run 用 X 的 agent 跑、readonly=X.readonly（AC-7）；无 override 退回原节点 agent（黄金锁）。
- 端口契约：借壳注入 outputs=原节点声明；X 没吐齐 → failed、不落部分端口、相位处理中（AC-5）。
- 下游接线（核心）：self/questioner 借壳 run done+输出 → 原节点下游被调度并消费到产出、park 解除、不死锁（AC-4）。
- designer 行为变更：改派后产出归原 designer、走 D 下游；替换 RFC-120 旧「走 X 下游」测试并注释来源（AC-6）。
- 跨 tick 重派带 override（§7.4 回归锁）。
- prompt-isolation：借壳 run promptText 无改派人/归属（AC-9）。
- 权限：改派/下发经 `requireTaskMember`（AC-10）。

**前端（vitest）**

- 改派下拉对全角色非终态开放、已下发只读（AC-2，扩 RFC-127 前置修复的回归测试）。

**门槛**：`bun run typecheck && bun run test && bun run format:check` 全绿 + CI（lint+test×2OS+binary smoke+e2e+静态扫描）+ 按 [feedback-codex-review-after-changes] 设计 gate + 实现 gate 各跑 Codex + 按 [feedback-post-commit-ci-check] push 后查 CI。

## 10. 落地顺序硬约束

1. **先**改 `resolveHandlerRun` 框窗口径（借壳条目按原节点）+ 加 `agent_override_name` 列/mint stamp，**再**放开 `canReassign` 角色——否则放开后 self/questioner 改派会按旧 designer「换节点」路径 mint（nodeId=X），与借壳并存期产生错误下游。
2. designer 从「换节点」切「借壳」与「放开 self/questioner」可同 PR（都依赖借壳基建），但 designer 行为变更测试要先替换、避免红着合。
3. 端口契约注入（§3.3）必须与 borrow agent 解析同 PR 落地——少了它 X 不吐 P 端口、下游拿空。

## 11. PR 拆分建议

见 `plan.md`。默认单 RFC 单 PR；若过大按「基建（列+mint+解析+端口契约+lineage 口径）」→「放开角色+designer 切借壳+前端」两 PR，前者不改用户可见行为、后者一次性切换。
