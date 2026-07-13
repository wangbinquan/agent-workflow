# RFC-172 任务分解 — 工作组成员人类反问答案回流（shardKey 隔离）

状态：**路线 2 核心已交付并推送（S0–S3 + R2-T3 + R2-T5/T6/T7）**；并行度加固两段（S2b in-flight 门 shard 化 / S4 self 回滚守卫）**降级为 follow-up**（见下「未交付」栏理由）。依赖：无硬依赖；不回归普通节点 clarify 与 leader 反问（golden-lock：每条非 workgroup 路径 shardKey 恒 `null`，`(home,null)` 复合键逐字节坍缩回今日 home-only 行为）。

## 交付状态（路线 2 核心落地）

用户拍板走**路线 2 全四段链**（问 → 铸续跑 → 选取 → 路由）。核心正确性（各 member 答案隔离、绑定正确、逐 shard 老化 + 邀请启用）已交付；已推上 `origin/main`。

| 段 | 任务 | 提交 | 测试锁 | 状态 |
|---|---|---|---|---|
| 问·shard 解析 | S0 `resolveEntryShardKeys`（origin_node_run_id → asking_shard_key，manual→null） | `4b49bb80` | `rfc172-dispatch-shard` S0×3 | ✅ |
| 铸·续跑义务 | S1 `isDispatchedEntryConsumed` 加可选 shardKey（run 义务扫描逐 shard） | `4a4476d6` | `rfc133-queued-run-obligation` case 6 | ✅ |
| 铸·mint 分裂 | S2a dispatch mint-loop 按 shard 分裂 + reruns entryIds 逐 shard 分区 | `fabbec11` | `rfc172` S2a source-lock + **S5 端到端** | ✅ |
| 铸·续跑 shard | S3 `buildFrontierMintPlan` 加 shardKey：scope 继承源 + 覆写续跑 run shard_key | `fabbec11` | `rfc172` S3 + **S5** | ✅ |
| 选取·隔离 | R2-T3 `selectAgentQueue`/`buildClarifyQueueContext` 通用可选 shardKey（选取按 asking_shard_key、老化 `isNull` 三值分叉、绑定随选取、渲染过滤） | `0afd1709` | `rfc132-select-agent-queue` shard 隔离 | ✅ |
| 多轮 | R2-T6 host clarify `iterationIndex` = `priorDoneGenerationsForRun`（非恒 0）+ clarifyContext 注入对**所有** host run（leader=null/member=shard） | `034e8822` | `rfc164-workgroup-*` | ✅ |
| 撤守卫+邀请 | R2-T7 撤 `runHostNode` 非 leader 拒绝 + `renderWgProtocolBlock` 全角色邀请 clarify（`WG_CLARIFY_BLOCK` 抽公共）+ runner 畸形 clarify 折入重试 | `034e8822`（+`6b19a68d`/`8dddc1e8` 前置） | `rfc164-workgroup-core`/`engine` 全角色邀请断言 | ✅ |
| manual 收口 | R2-T5 禁 manual@`__wg_member__`（manual 无 shard 身份→会劫持任意 member；literal 守卫避 import 环 + source-lock） | 本批 | `rfc172` R2-T5×2 | ✅ |
| 路由·端到端 | S5 端到端集成：两 member shard 经真实 `dispatchTaskQuestions` → 两个 shard 正确的 rerun、entryIds 不串 member（R2-T4 路由验证并入） | 本批 | `rfc172` S5 | ✅ |

### 未交付（follow-up，非本 RFC 验收所需）

- **S2b（原 R2-T2 后半）— in-flight 门 / frontier 目标锁 shard 化**：`assertNoInFlightDispatch`（963）、`findOpenDispatchTarget`（893 async）、in-tx recheck（747）仍按 `home` 单键。**正确性不依赖它**——单次 dispatch 已按 shard 正确铸各自续跑（S5 证）；node 单键 in-flight 门只在「某 member 续跑在飞时，并发再 dispatch **另一** member」这一**并发**场景过度串行化（一个 member 等另一个），是**并行度**限制而非串扰/错绑。改它须动 golden-lock 的 TOCTOU/CAS 三处（async 预检 + in-tx recheck 一致性），风险与 RFC 已交付正确性收益不匹配 → 独立 follow-up。
- **S4 — self 回滚守卫 shardKey 透传**：与 S2b 同源（回滚 self 续跑的 pre_snapshot 逐 shard），随 S2b 一并做。当前单 member 回滚走 node 级 `pickFreshestRun`，多 member 并发回滚才需逐 shard——同属并行度加固。

> follow-up 两段建议合成 **RFC-172b（工作组 member 反问并发加固）**，前置=本 RFC 已落的 (home,shardKey) 复合键地基。

## ⚠️ 设计门后重排（对抗评审证伪初版方案，见 design §5）

对抗式设计评审证伪了「只改 selectAgentQueue、零 migration、单 PR」——member 回流是**「问 → 铸续跑 → 选取 → 路由」四段链**，初版（下方 T1–T5）只覆盖第三段。**mint 段（P1-1，续跑 run 的 shardKey 靠 `pickFreshestRun` shard 盲继承）与 dispatch 键段（P1-2，`assertNoInFlightDispatch`/frontier 按 home 单键）会先断**，且 `taskQuestionDispatch.ts` 全文零 shard 感知，补它的代价接近方案 B。两条路待用户拍板：

### 路线 1 — 收窄本 RFC（低风险、已验证可行）
- **R1-T1**：leader 回流健壮化——修 P1-3 的 `shardKey=null` → `eq(col,null)` 空窗坑（leader 传 `undefined` 保 golden 路径，或 `isNull` 三值分叉）+ 新增 leader=null 回流测试。
- **R1-T2**：`selectAgentQueue` 加**通用可选 shardKey**（选取/老化/绑定，`undefined` 零回归）——为将来铺路，本身不启用 member。
- **R1-T3**：member 人类反问**继续不支持**（保留现 `clarify-not-supported` 临时拒绝 + leader-only 邀请），在代码注释指向「member 完整回流 = 独立更大 RFC」。
- **产物**：单 PR、零 migration、零回归。member 回流升格为后续独立 RFC（四段链）。

### 路线 2 — 做全 member 四段链（大范围、风险高）
- **R2-T1**（mint，P1-1）：`buildFrontierMintPlan` 从 `task_questions.origin_node_run_id → clarify_rounds.asking_shard_key` 取回 shard，`overrides.shardKey` 显式覆写续跑 run 的 shardKey。
- **R2-T2**（dispatch 键，P1-2）：`assertNoInFlightDispatch` + `byTarget`/frontier mint 改按 `(home, shardKey)` 双键，解并发 member 串行化 / 批量坍缩。
- **R2-T3**（选取，初版 T2）：`selectAgentQueue` 通用可选 shardKey 隔离（选取按 asking_shard_key、老化按 node_runs.shard_key 且含 `isNull` 分叉、绑定随选取）。
- **R2-T4**（路由）：确认 `driveAdoptedRun` 在 mint shardKey 正确后把续跑正确路由回对应 member。
- **R2-T5**（manual，P2-1）：manual-to-member 定为**全广播**（选取+老化都不逐 shard）或方案 B 加列；禁 hybrid。
- **R2-T6**（多轮，P2-2）：host clarify iterationIndex 递增（scheduler.ts:819），或明确单轮 only + 断言。
- **R2-T7**（撤守卫 + 恢复 member 邀请）：`runHostNode` 撤 `clarify-not-supported`、`renderWgProtocolBlock` 恢复 worker/fc_member 邀请（与 R2-T1..T4 同 PR，避免中间窗口）。
- **R2-T8**（测试，补初版空洞）：mint shardKey 正确性、并发两 member 经共享 home、leader null 路径、manual 广播+老化、多轮 member clarify、golden-lock 回归。
- **产物**：多 PR（mint+dispatch 一批、隔离+路由一批、撤守卫+邀请一批）、可能需 migration（若 manual 走方案 B）、风险显著。

**下方 T1–T5 = 初版方案，仅在路线 2 的 R2-T3 部分复用，其余被 §5 findings 取代——保留作演进留痕。**

## 子任务（初版——⚠️ 已被设计门证伪为不充分，见上「设计门后重排」）

### RFC-172-T1 — shardKey 归属查证 ✅ 已查证定案（进设计门前完成）
- **方案 A（零 migration）确定**：`task_questions.origin_node_run_id → clarify_rounds.asking_shard_key` 的 join 与 shard **1:1、无损**（createClarifySession 每 shard 铸独立 clarify node_run，`findClarifyNodeRunForShard` clarify.ts:460-472），且 `selectAgentQueue` 现在就已取该 round 行（clarifyQueue.ts:150-157）→ 加过滤零新增查询。shardKey 做成**通用可选参数**（非 workgroup 专用）。
- **普通 agent-multi 不受累**：agent-multi 已被 RFC-060 删除，后继 wrapper-fanout 分片不 wire clarify 通道（scheduler.ts:4486-4490 v1 无 clarify、PR-D2/D.T5 延期），普通路径无可复现串扰 → RFC-172 **不**顺带修普通 bug（但通用参数让延期的 fanout per-shard clarify 将来免费继承）。
- **manual §15 收口**：manual 可指派 `__wg_member__` 但无 shard 身份、不产生 clarify 答案串扰 → 免 clarify shard 过滤（广播）+ 老化仍逐 shard；逐成员定向 manual 非本 RFC 需求（否则才上方案 B）。
- 详见 design §2.1 / §3。

### RFC-172-T2 — selectAgentQueue 增通用可选 shardKey 隔离（核心）
- `selectAgentQueue` / `buildClarifyQueueContext` 入口加**可选** `shardKey?: string | null`；`undefined` 完全复现现行为（普通节点/leader 单一 null 身份零影响）。
- 选取过滤：传值时 clarify 候选按已 join 的 `clarify_rounds.asking_shard_key == shardKey` 收窄（方案 A，零新增查询）；manual 免过滤。
- 老化窗口：传值时 `sameNode` 加 `node_runs.shard_key == shardKey`（member run 恒非 null，无 IS NULL 坑）。
- 绑定随选取收窄。依赖：无（T1 已定案）。

### RFC-172-T3 — runHostNode / member 路径接线
- `runHostNode`：`clarifyContext` 注入改为对**所有** host run 调 `buildClarifyQueueContext({ ..., shardKey: <本 run shard_key> })`（leader=null、member=assignment id）；移除 `req.nodeId !== WG_LEADER_NODE_ID` 的 `clarify-not-supported` 拒绝分支。
- 依赖：T2。

### RFC-172-T4 — 恢复 member clarify 邀请 + 格式
- `renderWgProtocolBlock`：worker / fc_member 恢复 `<workflow-clarify>` 邀请 + JSON 格式（复用/抽出 `LEADER_CLARIFY_BLOCK` 为通用块）。更新/回滚 RFC-164 期间「leader-only」的相关注释与测试断言。
- 依赖：T3（避免「邀请了但 runHostNode 仍拒绝」的中间窗口——同 PR 内落）。

### RFC-172-T5 — 测试
- 纯数据预言：`selectAgentQueue` 跨 shardKey 选取隔离 / 老化隔离 / 绑定隔离（无悬挂 `processing`）。
- golden-lock 回归：`shardKey===undefined` 路径既有断言全绿（`rfc132-select-agent-queue` 等）。
- 引擎级：并发两 member 各问各答、续跑各自只见己方 `## Clarify Q&A`。
- 撤守卫回归：worker 协议块含 `<workflow-clarify>`、`runHostNode` 不含 `clarify-not-supported`。
- 依赖：T2–T4。（普通分片 clarify 路径当前不可达——T1b——故无需普通 agent-multi 串扰测试；通用可选参数即为将来 fanout per-shard clarify 预留。）

## PR 拆分建议
T1 已判**方案 A（零 migration）**且普通路径不受累 → **单 PR**（T2–T5 一体，含撤守卫），T1 结论写进 PR 描述。无 migration、无跨批不可分割约束。

## 验收清单
- [x] 并发两 member 各自反问各自被答：两 member shard 经 `dispatchTaskQuestions` → 两个 shard 正确 rerun、entryIds 不串（S5）；续跑 prompt 各自只含自身 shardKey 的 `## Clarify Q&A`（R2-T3 渲染过滤 + rfc164 引擎级）。
- [x] 每条 member 反问 `trigger_run_id` 正确绑定，无永久 `processing`（S0 shard 解析 + S1 逐 shard run 义务）。
- [x] member 产出只老化自身 shard 队列，不影响 sibling（R2-T3 老化窗口 `isNull` 三值分叉，`rfc132-select-agent-queue`）。
- [x] leader 反问 + 普通节点 clarify 既有行为与 golden-lock 全绿不变（每路径 shardKey→null 坍缩；rfc128/rfc132/rfc133/rfc164 全绿）。
- [x] worker/fc_member 恢复 clarify 邀请 + 格式；`clarify-not-supported` 临时拒绝移除（R2-T7，`rfc164-workgroup-core`/`engine`）。
- [x] `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿（本批本地四门全绿）+ CI 绿（待本批推送后核）。
- [ ] follow-up（非本 RFC 验收）：S2b in-flight 门 shard 化 + S4 self 回滚守卫（并发加固，建议合成 RFC-172b）。
