# RFC-289 — 技术设计（design）

> **本 RFC 已于 2026-08-14 CLOSED（未实现）**——理由与「重写时必须满足的五条」见
> `proposal.md` 顶部。产品目标保留，待 RFC-294 W7（NodeRun identity / provenance）
> 后另立新号重写。本文锚基线 `15b68f89` **已冻结、不再维护**。

> 现状测绘（2026-08-13 只读子代理）基线 15b68f89；实现期每批逐锚复核。
> **前置**：RFC-287 先落（L5/L6 已收敛 runAssembly 骨架，本 RFC 的派发改造
> 复用骨架而非再抄装配段；287 未落则锚全体位移）。

## 1. 现状锚（file = packages/backend/src/services/scheduler.ts 除注明外）

- 旁路点：`runFanoutWrapperNode` :6953-7452 全程无 runScope；inner 因入
  containerOf 被 topLevelIds 排除（:722-724）；`buildScopeUpstreams` 对 fanout
  boundary 边显式 continue（:9765-9767）。loop/git 都走主引擎（:6825/:8963）。
- 数组序派发：`for (const innerId of innerIds)` :7203（innerIds=nodeIds 书写
  序 :6981）；inner 间 await 串行、同 inner 的 shards `Promise.all` 并行 :7285。
- 断链机制：`resolveUpstreamInputs` :9243 → `pickUpstreamSourceRun` :9302 只挑
  top-level 行；A 的产出全在 `parentNodeRunId=wrapperRunId` child 行 → B 的端
  口键整体缺失 → prompt `v ?? ''` 静默空串。放宽先例：:9506-9514
  `freshestPriorRunWithOutput` 注释明写故意 parent-agnostic（(nodeId,shardKey)
  已唯一定界）。
- shardKey 流动：生成 shardingRegistry.ts:56-77（path 族用路径、默认 index）；
  撞键 #idx 消歧 :7189-7201；scope 划分 fanout.ts:61-137（computeShardScope BFS
  - applyAutoPromote 链式提升**已支持** A→B→C）；行落库/复用锚/聚合读
    :7539-7590/:8045-8090。
- 挡板：workflow.validator.ts:1192-1229（code `fanout-inner-chain-unsupported`
  :1219，error）；豁免 aggregator/clarify 边/boundary 边。外围：前端
  workflow-validation-target.ts:26、i18n zh:10754/en:5653。
- 运行时前提假设：:3109-3110 注释「fanout shard rows never reach here——
  validator 拒 call in fanout」——解除**本条**挡板不触它（call 挡板保留）。

## 2. G1 同 shardKey 上游解析

`resolveUpstreamInputs(db, workflow, nodeId, iteration, opts)` 增
`opts.shardCtx?: { wrapperRunId: string; shardKey: string | null }`：

- 传入时对每条入边：先查同 `(upstreamNodeId, shardKey)` 且
  `parentNodeRunId === wrapperRunId` 的 done child 行（同代内取 freshest，
  复用 pickReusableShardRun 同族判据）；命中即用其 outputs；未命中回退现行
  top-level 解析（boundary broadcast 注入语义不变）。
- 跨 shard 引用在派发期即是不变量违反（G3 validator 已拒；运行时防御性
  wrapper failed，错误码 `fanout-cross-shard-ref`）。
- `consumed` 记账照旧（consumedUpstreamRunsJson 记 A 的 child run id），
  rfc098 consumed-gate 复用失效链自然覆盖「A 重跑 → B 不可复用」。

纯函数优先：解析选择器抽 `pickShardUpstreamRun(rows, shardKey, wrapperRunId)`
（freshness.ts 同族），直测正/边界/回退三路。

## 3. G2 拓扑序派发

- `topoSortInner(innerIds, edges)`：Kahn；仅计两端都在 innerIds 的数据边
  （clarify 通道边/boundary 边不参与排序）；环 → wrapper failed
  （`fanout-inner-cycle`，防御——validator 先拒）。纯函数直测。
- 派发循环 :7203 改遍历拓扑序；**inner 间仍串行、shard 间仍并行**（并行度
  锁 scheduler-boundary-fanout-concurrency 语义不变）。B 的 per-shard 派发在
  A 全 shard settle 后（现有 inner 间 await 结构天然满足）。
- 与 287 骨架关系：本 RFC 只改「谁决定下一个 spawn」（driver 层 :7203 循环与
  输入解析）；单次 spawn 装配继续走 runAssembly（L5 spec 不动）。

## 4. G3 挡板置换（validator）

删 :1192-1229 规则，新增三条（同文件同区，复用 innerToWrapper 归属计算）：

- `fanout-cross-shard-ref`：per-shard 集内 B 的入边源自**另一** fanout 的
  per-shard 节点或同 fanout 但经 shared 集中转的 per-shard 值。
- `fanout-shared-consumes-pershard`：shared 集节点消费 per-shard 集产出
  （聚合语义只归 aggregator；scope 划分 fanout.ts 的集合直接给判据）。
- `fanout-inner-cycle`：inner 数据边成环。
- i18n：删旧 key（zh:10754/en:5653）加三对新 key；前端 target 映射同步。

## 5. 复用/幂等与失败语义（不变量重申）

- B 行身份 `(taskId, innerNodeId, iteration, shardKey)`、valueHash 锚**原始
  shard 值**（B 的输入变化由 consumed-gate 表达，不改 hash 轴）；聚合读回
  仍 done-only + pickReusableShardRun（s21 源码切片锁**零改动**）。
- 失败语义维持 fail-all-after-join（:7311-7322）；链上 B 因 A shard 失败而
  从未派发 = 既有 fail-all 路径，无新状态。
- 空 shardSource 短路（:7151-7160）不变：全 outlet 置空 + wrapper done。

## 6. 测试策略（26 文件面全对账）

- 翻转：s05 三层按头注旁注翻转（AUDIT-FINDING-SENTINEL 進 fixer prompt 断言
  - R2 改「逆序书写仍拓扑派发」）；rfc094-validator-guardrails :136-190 改新
    规则正反例。
- 改锚：scheduler-wrapper-fanout-routing（全文件源码文本锁——派发形状变，
  逐 pattern 改锚并保 D.T2/T3/T6/T7/T8 意图）；新增 pickShardUpstreamRun /
  topoSortInner 纯函数套件；e2e 双 inner 链（AC-5）。
- 必须零变化而全绿：s21 切片锁、s18-s19 fail-all 语义（mock spawn 计数）、
  concurrency、resume-duplicate-shards、shardkey-collision ×2、rfc172 金锁、
  rfc098 ×2、rfc103 kind-aware、rfc266 pools、rfc223 hydration dedup、
  rfc187 salvage、rfc130 undo。
- 实现门双路（契约 + 对抗）。
