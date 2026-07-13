# RFC-172 设计 — 工作组成员人类反问答案回流（shardKey 隔离）

## 1. 现状与缺口（代码事实）

### 1.1 已有的 shardKey 基础设施（关键：基本齐备）
- `node_runs.shard_key`（schema.ts:872）—— member host run 的 shardKey = assignment id；leader host run 为 `null`。
- `clarify_sessions.source_shard_key`（schema.ts:1359）+ 索引 `idx_clarify_sessions_node_shard (clarify_node_id, source_shard_key)`（:1387）。
- `clarify_rounds.asking_shard_key`（schema.ts:1476）。
- 注释 schema.ts:1342-1343 明述设计意图：**「agent-multi：每个 reaching shard 铸自己的 clarify_node_run + 自己的 clarify_session，按 `(clarify_node_id, source_shard_key)` 键」**。
- `createClarifySession`（services/clarify.ts）已把 `sourceShardKey` 落进 `clarify_sessions.source_shard_key`（:237）与 `clarify_rounds.asking_shard_key`（:214）；`runHostNode`（scheduler.ts）建 session 时传的 `sourceShardKey = currentRunRow?.shardKey`（member = assignment id）。

**结论（⚠️ 已被设计门对抗评审修正，见 §5）**：「问」侧确已按 shardKey 分账，**但这个结论把范围判小了**。「问」与「选取」之间还夹着一整段 **shard 盲的 dispatch/mint 阶段**（`autoDispatchClarifyRound → dispatchTaskQuestions → buildFrontierMintPlan` + `assertNoInFlightDispatch`，taskQuestionDispatch.ts 全文零 shard 感知）。member 回流其实是**「问 → 铸续跑 run → 选取 → 路由」四段链**，缺口不止「选取」一段——续跑 run 的 shardKey（第二段）和 `driveAdoptedRun` 路由（第四段）会**先于**选取断裂。只改 `selectAgentQueue` 必要但**远不充分**。

### 1.2 缺口：`selectAgentQueue` 不看 shardKey
`services/clarifyQueue.ts` `selectAgentQueue`（:87-214）：
- **选取**（:94-109）：`task_questions WHERE taskId + effectiveTarget(override ?? default)==consumerNodeId + dispatchedAt NOT NULL`，再 `sealedAt!=null || sourceKind='manual'`。**无 shardKey 过滤** → member 节点返回**所有** member 指派的问题。
- **老化窗口**（:116-131）：`sameNode = node_runs WHERE nodeId==consumerNodeId AND iteration==iteration`。**无 shardKey 过滤** → 含所有 sibling 指派的 run，任一 sibling 的 output 都会经 `isTargetNodeConsumed` 老化本条目。
- **绑定**：`bindTriggerRun`（:216+）把 `task_questions.trigger_run_id = dispatchedRunId`，按选取结果绑 → 会把 A 的条目误绑到 B 的 run。

`buildClarifyQueueContext`（:296-327）是薄封装（选取 + 渲染 + 绑定），签名 `{db, definition, taskId, consumerNodeId, dispatchedRunId, iteration}`，其中 `definition`/`iteration` 是**保留位不读**。

### 1.3 当前临时收敛（本 RFC 要撤掉）
- `renderWgProtocolBlock`（services/workgroupContext.ts）：`<workflow-clarify>` 邀请 + 格式**只发 leader**。
- `runHostNode`（services/scheduler.ts）：`clarifyContext` 注入 `req.nodeId === WG_LEADER_NODE_ID` 才做；非 leader 的 `<workflow-clarify>` 在 `createClarifySession` **之前**直接 `return { status:'failed', errorMessage:'clarify-not-supported' }`。

## 2. 方案：给队列机制补 shardKey 维度

> ⚠️ **本节（§2.1–§2.4）是设计门前的初版方案，只覆盖「选取」一段，已被 §5 对抗评审证伪为不充分。真正要做的四段链方案见 §5，本节保留作演进留痕。**

核心（初版认知）是让 `selectAgentQueue` 的**选取 + 老化 + 绑定**三者都能按「本次续跑 run 的 shardKey」收窄。task_questions 本身
是否需要新增 shardKey 列，取决于能否经现有关联（`origin_node_run_id` → `clarify_rounds.asking_shard_key`，
或 `node_runs.shard_key`）无损推导。**T1 查证：该 join 对单轮 member self-clarify 1:1 无损（方案 A 前提成立），但这只是第三段——续跑 run 的 shardKey 是否正确是前置（见 §5）。**

### 2.1 selectAgentQueue 增 shardKey 隔离 —— 方案 A（T1 定案，零 migration）

**join 链无损定位 shard（T1a 查证）**：member run 的 `node_runs.shard_key = assignment.id`（workgroupRunner.ts:1067-1074；消息轮为 `msg:${memberId}:...`）。`createClarifySession` 按 `(clarify_node_id, source_shard_key, iterationIndex)` **每 shard 铸独立 clarify node_run**（`findClarifyNodeRunForShard` clarify.ts:460-472），并双写 `clarify_rounds.asking_shard_key = sourceShardKey`（clarify.ts:214）+ `intermediary_node_run_id`（:216）；`task_questions.origin_node_run_id = round.intermediary_node_run_id`（taskQuestions.ts:141-146）。故 `task_questions.origin_node_run_id → clarify_rounds.asking_shard_key` 与 shard **1:1、无损**，且 `selectAgentQueue` **现在就已取该 round 行**（clarifyQueue.ts:150-157，`askingShardKey` 已在手）→ 加 shard 过滤**零新增查询**。

- **入口新增可选 `shardKey?: string | null`**（`undefined` = 保持现状：普通 agent-single 节点/leader 的单一 null 身份零影响、golden-lock 不改一行）。`buildClarifyQueueContext` 从 `dispatchedRunId` 行读出 `shard_key` 后透传（leader→`null`，member→assignment id）。**做成通用参数、非 workgroup 专用**（见 §3 T1b：让延期的 wrapper-fanout per-shard clarify 将来免费继承同一隔离）。
- **选取过滤（clarify 条目）**：`shardKey` 传值时，候选 `task_questions` 追加「其 round 的 `asking_shard_key == shardKey`」（复用 clarifyQueue.ts:150-157 已 join 的 round 行）。
- **老化窗口**：`shardKey` 传值时 `sameNode` 追加 `AND node_runs.shard_key = shardKey`（member run 恒非 null，`__wg_member__` 内部无 `IS NULL` 特判坑；不传值则保持今天按 nodeId+iteration 的全窗）。
- **绑定**：`bindTriggerRun` 仍绑选取后的条目——选取按 shardKey 收窄后，绑定自然只落本 shard。
- **manual 条目（§15）收口**：manual 无 round → 无 `asking_shard_key`，且 manual **可**指派 `__wg_member__`（taskQuestions.ts:1260-1266 只校验 target 是本任务 agent 节点）。但 manual **不产生逐成员 clarify 答案**，故无答案串扰。定案：**manual 免 clarify shard 过滤**（无逐成员身份，广播全成员是唯一自洽语义）；**但老化窗仍逐 shard**（否则一 manual 条目会被兄弟 shard 的 output 误老化）。逐成员定向 manual 非 RFC-172 需求；若将来需要，才上方案 B（`task_questions` 加 `shard_key` 列 + migration + reconcile/create 落戳）。

### 2.2 撤临时收敛、恢复 member 反问
- `renderWgProtocolBlock`：worker / fc_member 恢复 `<workflow-clarify>` 邀请 + 格式（复用现 `LEADER_CLARIFY_BLOCK`，改为「非 leader 也 push」或抽通用块）。free_collab 无 leader，成员即 fc_member，同样开放。
- `runHostNode`：移除 `req.nodeId !== WG_LEADER_NODE_ID` 的拒绝分支；`clarifyContext` 注入守卫从「仅 leader」改为「传入本 run shardKey 的 `buildClarifyQueueContext`」（leader 走 null shard，member 走自身 shard）。

## 3. 与现有模块耦合点 / 失败模式

- **`selectAgentQueue` 是共享 golden-lock 函数**（普通节点 + cross-clarify + designer 全走它）。改动必须以 `shardKey===undefined` 完全复现现行为（golden-lock 不改一行断言），仅传值时启用新过滤。
- **普通 agent-multi 不受累（T1b 查证）**：`agent-multi` NodeKind 已被 RFC-060 PR-E 删除（shared/src/index.ts:50-51、clarify.ts:371）；现存分片路径是 **wrapper-fanout**，其 shard 走 `dispatchFanoutShard`（scheduler.ts:4761）**不传 `clarifyChannel`**（`{kind:'none'}`），头注释显式声明「v1 无 clarify 通道，per-shard clarify 是 PR-D2/D.T5 延期项」（scheduler.ts:4486-4490）。故分片节点当前**根本不能吐 `<workflow-clarify>`**，普通路径不存在可复现的跨-shard 串扰。`schema.ts:1342-1343` 那条「agent-multi 每 shard 分 session」是删除后遗留的休眠注释。**结论：RFC-172 不顺带修普通路径 bug；但把 shardKey 隔离做成通用可选参数后，延期的 fanout per-shard clarify（PR-D2/D.T5）可免费继承——RFC-172 是逐-shard clarify 的首个真实消费者。**
- **失败模式**：shardKey 不匹配 → 空队列 → member 续跑无答案（退化为「未回流」，不串扰、不悬挂）——安全降级。
- **manual 条目 §15**：shard 归属与老化收口见 §2.1（免 clarify shard 过滤 + 老化仍逐 shard）。

## 4. 测试策略（design.md §测试策略，实现 PR 必跑绿）

- **纯数据预言（首选）**：seed「同 taskId、同 `__wg_member__`、两个不同 shardKey 各一条已答 clarify」，断言 `selectAgentQueue(consumerNodeId=__wg_member__, dispatchedRunId=<A 的续跑>, shardKey=A)` **只返回 A 的条目**；传 B 只返回 B 的。
- **老化隔离**：B 的 done+output run 不老化 A 的条目（跨 shard）。
- **绑定隔离**：绑定只落本 shard 的 `trigger_run_id`，无悬挂 `processing`。
- **golden-lock 回归**：`shardKey===undefined` 路径下 `rfc132-select-agent-queue` 等既有断言全绿不变。
- **引擎级**：并发两 member 各问各答，续跑 prompt 各自只含己方 `## Clarify Q&A`（可用 fake-hook 引擎 harness + 源码锁兜底）。
- **撤守卫回归**：`renderWgProtocolBlock('worker')` 恢复含 `<workflow-clarify>`；`runHostNode` 不再含 `clarify-not-supported`。

## 附注 — 既有缺陷（⚠️ 已升级为 §5 P2-2，非正交）
host clarify 的 `createClarifySession` 传 `iterationIndex: 0` 硬编码：同一 host + 同 shardKey 的**第二轮** clarify
复用/覆写首轮 clarify_node_run（`findClarifyNodeRunForShard` 按 `(clarifyNodeId, shardKey, iterationIndex)` 幂等）。
**设计门推翻了「正交」判断**：见 §5 P2-2——它直接落在 member 多轮回流的选取路径上。

---

## 5. 设计门（对抗评审）——re-scope 到「四段链」【本节为权威，覆盖 §1.1/§2 的初版认知】

一轮对抗式设计评审（对照真实代码）证伪了本 RFC 的中心诊断。**member 人类反问回流是「问 → 铸续跑 run → 选取 → 路由」四段链；初版只补了第三段（选取），第二段（续跑 run 的 shardKey）与第四段（`driveAdoptedRun` 路由）会先断。** 逐条 findings 与修正：

### P1（阻断）

**P1-1 · 续跑 run 的 shardKey 继承是 shard 盲的——mint 侧根本没修（最重）。**
member self-clarify 答复走 `autoDispatchClarifyRound → dispatchTaskQuestions → buildFrontierMintPlan`（taskQuestionDispatch.ts）。`buildFrontierMintPlan` 的继承源 `last = pickFreshestRun(所有 __wg_member__ 节点 run)`（:1373-1377）——`pickFreshestRun` 明确「deliberately does not group」，纯按 ULID 取**全局最新**（freshness.ts:282,290-304）；mint 时 `inheritFrom: last` **不覆写 shardKey**（:1393-1402），`buildMintNodeRunValues` 的 shardKey = `overrides ≻ inheritFrom ≻ null`（nodeRunMint.ts:151）。→ member A 的续跑 run 可能继承 B 的 assignment id、或某条 `msg:` 消息轮 key。`buildClarifyQueueContext` 读的正是这个 run 的 `shard_key` 再透传，故**过滤键本身就错**；`driveAdoptedRun` 也按它误路由（把 A 的答复跑成消息轮 / 跑到 B）。
**修**：`buildFrontierMintPlan` 必须从「本条目所属 shard」（`task_questions.origin_node_run_id → clarify_rounds.asking_shard_key`）取回 shard 并 `overrides.shardKey` 显式落。**这要求 dispatch 阶段引入 shard 维度，远超「只改 selectAgentQueue」。不修则验收 1/2 不可达。**

**P1-2 · 并发 member clarify 经共享 home 节点被串行化 / 批量坍缩。**
`assertNoInFlightDispatch`（taskQuestionDispatch.ts:548）与 `byTarget`/frontier（:472,507）均以 **home 节点 id** 键，而 member 全部 = 一个 `__wg_member__`。→ A 的续跑在飞时 B 答复 → 命中 `__wg_member__` 的 open 条目 → `task-question-node-dispatch-in-flight` → autoDispatch DEFER，B 要等 A 的 rerun done 才铸（clarifyAutoDispatch.ts）；更糟：批量下发同选 A、B → `byTarget[__wg_member__]=[A,B]` → **一个 rerun 服务两成员、答案搭错车**。破坏「并发指派并行零串扰」。
**修**：in-flight 门 + frontier mint 按 `(home, shardKey)` 双键，而非 home 单键。

**P1-3 · leader 的 `shardKey=null` 路径会 `eq(col,null)` 打空，回归 RFC-164 刚修好的 leader 回流。**
初版 §2.2/T3 让 leader「走 null shard」（透传 run 的 `shard_key=null`）。而 drizzle `eq(nodeRuns.shardKey, null)` 生成 `= NULL`（**恒假**，非 `IS NULL`）——本仓已知教训，三处显式分叉：`memoryInject.ts:427`（`shardKey===null ? isNull(...) : eq(...)`，与初版老化窗口写法逐字同形）、clarify.ts:468、lifecycle.ts:506。若照初版散文「`node_runs.shard_key = shardKey`」直接 eq，**leader 老化窗恒空 → leader 回流回归**；且初版测试只列 `undefined`、抓不到 leader 实走的 `null` 路径。
**修**：二选一并写死——(a) leader 传 `undefined`（保持 golden 路径，**首选**），或 (b) 传 null 但强制 `shardKey===null ? isNull(...) : eq(...)` 三值分叉 + **新增 leader=null 回流测试**。

### P2（应改）

**P2-1 · manual-to-member「广播选取 + 逐 shard 老化」不自洽（是回归）。** `trigger_run_id` 单列单锚，广播使 A、B 两 run 互相重绑；老化 `isTargetNodeConsumed` 用 `r.id >= sinceRunId` 跨 shard 比较无意义 → manual 条目对某些 shard 永不老化（prompt 无限膨胀）或误老化。而**改前**是「广播选取 + 广播老化」本自洽——初版把老化改逐 shard 却把选取留广播，亲手制造错配。**修**：manual-to-member 要么**全广播**（选取+老化都不逐 shard），要么上方案 B 真逐成员定向；**禁止 hybrid**。

**P2-2 · 「1:1 无损」keystone 实为「单轮」。** iterationIndex 钉 0 → 同 member 同 assignment 第二轮 clarify 与首轮**共享 origin**；`selectAgentQueue` 取 round 用 `where(intermediaryNodeRunId==origin).limit(1)` **无 orderBy**（clarifyQueue.ts:150-157）→ 非确定，第二轮答案可能选不到对应 round 被丢弃。**修**：要么本 RFC 一并让 host clarify 的 iterationIndex 递增（scheduler.ts:819 传真实代数）、要么 design 明确把范围限为「单轮 member clarify」+ 加断言防止悄悄依赖多轮。

### 修正的失败模式（推翻初版 §3「安全空降级」）
初版称「shardKey 不匹配 → 空队列 → 安全降级」。**只在 mint shardKey 正确时成立**；叠加 P1-1 后，错 shardKey 会让 `driveAdoptedRun` **主动误路由**（A 的答复跑成消息轮 → A 永卡 awaiting_human 答案丢；或跑到 B → B 被污染、A 卡死）——是「主动串扰 + 悬挂」，不是安全降级。

### 可行性重估（推翻「零 migration 单 PR」）
真正做对 member 回流要覆盖 mint（P1-1）+ dispatch 键（P1-2）两段，`taskQuestionDispatch.ts` 全文零 shard 感知 → 需引入 `(home, shardKey)` 维度。**其代价与复杂度接近方案 B**，「零 migration、单 PR」不再成立。两条路重估：
- **路线 1（收窄 RFC）**：本 RFC 只做**已验证可行**的部分——leader 回流健壮化（P1-3 修 null 路径）+ selectAgentQueue 通用可选 shardKey（为将来铺路）+ 明确 member 人类反问**继续不支持**（保留现临时拒绝）。member 完整回流因四段链复杂度**升格为独立更大 RFC**。
- **路线 2（做全）**：本 RFC 扩为四段链完整方案——mint shardKey 覆写 + dispatch `(home,shardKey)` 键 + selectAgentQueue 隔离 + driveAdoptedRun 路由 + manual 收口 + 多轮 iterationIndex + 全套测试（含 mint shardKey 正确性、并发两 member、leader null、manual、多轮）。范围与风险显著上升，可能需 migration。

**用户 2026-07-13 拍板走路线 2（做全四段链）。** 实现设计见 §6；进度：R2-T3（选取）已落地 commit `0afd1709`。

---

## 6. 路线 2 实现设计 — mint(R2-T1) + dispatch 键(R2-T2)【`(home, shardKey)` 复合键】

第二段（铸续跑 run 的 shardKey）+ dispatch 键的完整改造。核心表示法：**按 `(home, shardKey)` 分组、按 node 算拓扑**。

### 6.1 golden-lock 不回归的根：null-shard 坍缩等价
所有既有路径的派生 shardKey **恒为 `null`**：普通 agent-single self round `asking_shard_key` 为 NULL（schema.ts:1475）、cross round 恒 NULL、manual 无 round → null、leader singleton null。故 `(home, null)` 单组 **逐字节 ≡** 今天的 `home` 单键。只有 workgroup member（`__wg_member__` + `asking_shard_key = assignment id`）产生非 null shard 分裂。

### 6.2 shardKey 无损可取（零 migration，已确认）
`task_questions` **无** shard 列；每条 entry 的 shard 经 `origin_node_run_id → clarify_rounds.intermediary_node_run_id → asking_shard_key` 无损取回（member self round 每 shard 一条独立 clarify node_run；manual 无 round → null）。批量一次 join。

### 6.3 逐改造点（file:line + 做法）
- **分组**（taskQuestionDispatch.ts:433-497）：`byHomeCause` → `byHomeShardCause`，复合键 `home + '\x1f' + (shard ?? '\x00')`，侧存 `{home, shardKey}`；auto-split 下沉进复合组。
- **拓扑桥接**（:507-508）：`affectedNodes = 各组的 home 去 shard 维`；`computeUpstreamFrontier(def, affectedNodes)` **签名零改**（frontier 是节点拓扑，shard 只在 mint 分裂）。
- **mint**（:545-547 / 1361-1404）：`mintCauseByTarget` 升复合键；`buildFrontierMintPlan` **加 `shardKey` 参**，继承源 `pickFreshestRun(该 node 且 shard_key===shard 的 run)`（in-memory 过滤，避 `eq(col,null)` SQL 坑），`overrides.shardKey` 覆写；`FrontierMintPlan` 加 shardKey 字段。**关键抉择**：null 组传 **`undefined`**（不是 `null`）→ 不过滤/不覆写 → 保住 manual-to-member 不抛 `unsafe-dispatch-target`（传 null 会 `filter(===null)` 打空 → 回归）。
- **in-flight 门**（:548 assertNoInFlightDispatch / :851-893 findOpenDispatchTarget / clarifyRerunLedger.ts:84-113 `isDispatchedEntryConsumed`）：按 `(home, shardKey)` 收窄，shard A 在飞不挡 shard B。`isDispatchedEntryConsumed` 的 trigger-NULL run-obligation 扫描加 **可选** `shardKey`（**必须缺省 undefined**，否则 rfc133 两套件双红——最高风险点）。bound 分支不改（按 triggerRunId 锚天然 shard 正确）。
- **tx 插入**（:739-757 / reruns 映射 :801-805）：一 home 可插多个 rerun（每 shard 一个），`for...of mintPlans` 循环天然支持、仍原子；`reruns[].entryIds` **必须** 追加 `&& entryShard===p.shardKey`（否则 B 的 entryId 污染 A 的 rerun）。
- **上游 self 回滚守卫**（clarifyAutoDispatch.ts:534 `selfHomeHasOpenLedger` / clarifyRerunLedger.ts:183-207 `hasOpenDispatchedEntryOnHome`）：加可选 shardKey，透传本 self run 的 `shard_key`，否则 A 的 rollback 被 B 的 open 条目挡（隐蔽）。seal（clarifySeal.ts）已 per-origin 安全、无需改。

### 6.4 风险排序（最可能打红/破特性）
1. 【最高】`isDispatchedEntryConsumed` 的 shardKey 必须**可选缺省**（rfc133 纯 oracle 单测）。
2. 【高】mint null 组传 `undefined` 而非 `null`（否则回归 manual-to-member）。
3. 【高】`reruns[].entryIds` 按 shard 过滤（否则跨 shard 污染 caller resume/审计）。
4. 【中】`selfHomeHasOpenLedger`/`hasOpenDispatchedEntryOnHome` 漏改 → member 反问偶发不回流不报错。
5. 【中】复合键编码用 `\x1f` + `\x00` 哨兵（ULID 无控制字符，安全）。
6. 【低】`abandonSupersededMergeStates` 按 (node,iteration) 键跨 shard——经核 member run `merge_state` 恒 NULL、非 ABANDONABLE，当前安全；加断言锁防漂移。

### 6.5 逐特性字节不变（不回归清单）
普通 agent-single self / cross questioner+designer / 借壳 reassign（override 改 node 不改 shard）/ manual→任意节点（null 传 undefined 继承全局最新=今天）/ wrapper-fanout（不进本管线）/ leader（null 传 undefined）—— 派生 shard 全 null、复合键坍缩为今天。被锁测试 rfc120-deferred-dispatch / rfc128-p5-bc / rfc133（两套件，**唯一高危红点=可选参**）/ rfc139 / rfc140（含 `dispatchTaskQuestionsLocked(` 文本锁勿新增调用点）/ node-run-mint 全应绿。

### 6.6 实现子步骤（同一 PR，强耦合）
- **S0** 抽 `resolveEntryShardKeys(db, entries)`（批量 join asking_shard_key，manual→null）+ 纯数据测试。
- **S1** `isDispatchedEntryConsumed` 加可选 shardKey（in-flight trigger-NULL 分支）+ 扩 rfc133 测试（缺省=旧全绿）。
- **S2** dispatch 分组升复合键 + affectedNodes/frontier 桥接 + in-flight 门 + in-tx recheck + 集成测试（两 shard 各铸 rerun、并发不 429）。
- **S3** `buildFrontierMintPlan` 加 shardKey（继承过滤 + 覆写 + per-shard retry_index）+ reruns entryIds 过滤 + 断言 rerun.shard_key/继承源/entryIds。
- **S4** self 回滚守卫 shard 透传 + 测试。
- **S5** golden-lock 全回归 + member merge_state=NULL 断言锁。
- **S6**（交接 R2-T4）验 `driveAdoptedRun` 按正确 shardKey 命中 assignment。

**注**：P2-2（iterationIndex 钉 0 多轮）与 T1/T2 正交（shard 取 asking_shard_key、同 assignment 恒同 shard）；T1/T2 只保证**单轮** member shard 正确，多轮属 R2-T6，加断言防悄悄依赖。
