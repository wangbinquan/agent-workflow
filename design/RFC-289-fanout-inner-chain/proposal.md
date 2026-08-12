# RFC-289 — fanout 内链根治：同 shardKey 上游解析 + 拓扑序派发（proposal）

状态：Draft（2026-08-13 落档）
来源：`design/system-commons-unification-audit-2026-08-12.md` D3 大件三（:142
「shardKey 解析+拓扑序派发，解除 validator 挡板（能力扩张）」）。

## 0. 标签正名（测绘纠账，防检索误导）

「WP-6b」在仓内有**三层含义**：①原始定义 `design/scheduler-audit-2026-06-10.md:311`
= fanout 恢复幂等（S-19/20/21）——**已随 RFC-098 B3 完工**（同文件 :416 收官）；
②三处代码/测试注释（workflow.validator.ts:1198、scheduler-audit-s05 测试 :10,:19）
把 **S-5 长期修法**也标成了 WP-6b——**本 RFC 的真实内核就是它**
（`scheduler-audit-2026-06-10.md:90-95`）；③`design/design.md:798-802` 又把 S-18
部分容忍 + errors port 挂同名——那是独立的产品语义决策，本 RFC **不做**（见非
目标）。另：08-12 审计 :147 引用的 hydration 注释锚已漂移，现锚 scheduler.ts:7008-7011。

## 1. 背景（S-5：产品主打场景静默产垃圾）

fanout 内层是旁路小引擎：inner 子图不进主 frontier 引擎，`resolveUpstreamInputs`
过滤掉全部 child 行（A 的 shard 产出整体不可见），B 的端口在 prompt 渲染里静默
变空串；inner 派发按 nodeIds **数组序**而非拓扑序。用户画 fanout 内 audit→fix
链（产品主打场景）validator 全绿、运行零报错、fix 收到空 audit 结果照样跑完产出
垃圾——最危险的静默错误形态。现状由 validator 挡板 `fanout-inner-chain-unsupported`
（workflow.validator.ts:1192-1229，error 只阻启动）禁入，S-5 三层测试锁定。

## 2. 目标

采纳审计长期修法原文（:94「长期在 dispatchFanoutShard 增加同 shardKey 上游
child 行解析 + 拓扑序派发」）：

- **G1 同 shardKey 上游解析**：`resolveUpstreamInputs` 在 fanout per-shard 语境
  放宽 parent 过滤——同 `(nodeId, shardKey)` 的 child 行优先、无则回退 top-level
  （放宽论证复用既有先例 scheduler.ts:9506-9514 的 parent-agnostic 三段式）。
- **G2 拓扑序派发**：inner 节点按内层边拓扑排序后串行推进（shard 间保持并行）；
  检测到内层环 = wrapper failed（防御；validator 同步加规则）。
- **G3 挡板置换（能力扩张）**：删除 `fanout-inner-chain-unsupported`，代之以三
  条**保真**规则：跨 shard 引用（B 的 per-shard 入边源自另一 shard 语境）拒绝、
  per-shard→shared 集反向边拒绝、内层环拒绝。
- **G4 数据语义**：内链继承主 DAG 既有语义——数据经端口流动；iso/merge-back
  与今天的 per-(node,shard) 生命周期一致（可写 merge 经 canonical + writeSem
  串行），**不引入**「B 复用 A 的 worktree」新轴。复用/幂等：B 行的 valueHash
  仍锚原始 shard 值，A 产出变化经既有 consumed-gate（rfc098）失效。

## 3. 非目标

- S-18 部分容忍 / errors port（标签③）：维持 fail-all-after-join，产品决策另立。
- 其余家族挡板不动：script-in-fanout / call-workflow|workgroup-in-fanout /
  fanout 嵌套 warning / inner 仅 agent-single（运行时 :7217-7228）照旧。
- 不接入主引擎 runScope（frontier 加 shardKey 轴与 WP-8 身份轴建模同根因——
  登记为长期方向，收益是 clarify/review/human gate 白得；本 RFC 不动）。
- hydration 坏引用与主派发的声明式差异收敛（08-12 审计 :147）：不并入本刀，
  维持 FANOUT_HYDRATE_CALL_POLICY 现状（skip + wrapper 级失败 + 空列表吞）。

## 4. 能力影响清单

**纯扩张，零收缩**。解除后用户新增可写形态：① fanout 内 per-shard 多阶段流水
线（audit→fix、analyze→patch→verify）——此前只能全经 aggregator 收口（丢
per-shard 隔离）或拆两个串联 fanout（分片两次、成本翻倍）；② per-shard 扇内
分叉/汇聚（scope 计算 applyAutoPromote 本就支持，只差派发）。新增拒绝仅覆盖
**此前也不可运行**的形态（跨 shard 引用/环），无既有工作流受损。

## 5. 验收标准

- AC-1 s05 三层锁按头注翻转：fixer prompt 含 AUDIT-FINDING-SENTINEL（层 1/3
  旁注）、层 2 挡板断言改新规则集。
- AC-2 逆序 nodeIds 的链（[fix, audit] 书写序）按拓扑序派发且数据到位（杀死
  R2 现状锁）。
- AC-3 新守卫三条各有正反例测试（跨 shard 引用/反向边/环）。
- AC-4 既有硬锁全绿或按声明改锚：s21 聚合读行锁**不动**（读路径零改）、
  routing 源码文本锁逐条改锚、并行度锁（concurrency）、resume 幂等锁
  （每 shardKey 恰一行）、shardKey 撞键锁、rfc172 (home,shardKey) 金锁、
  consumed-gate/hash-rerun 复用锁。
- AC-5 e2e：audit→fix 双 inner 链真实调度产出（含空 shardSource 短路、单
  shard 失败 fail-all 语义保持）。
- AC-6 validator/i18n/前端 target 映射同步（zh/en 文案 + workflow-validation-
  target.ts）；每批 pin gate 全绿 + exact-SHA CI 绿；实现门双路。
