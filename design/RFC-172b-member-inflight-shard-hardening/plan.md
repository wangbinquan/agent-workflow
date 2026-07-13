# RFC-172b 任务分解 — run-resolution 家族 shard 化

状态：**Done（已实现并推送 origin/main，CI 绿）**。前置：RFC-172 路线 2 核心已交付（S0–S3 / R2-T3 / R2-T5 / R2-T6 / R2-T7 / S5）。零 migration。

## 交付记录（2026-07-13，用户批准 → 实现）

设计门（Codex）跑完并折入两发现（S4 守卫指向 `hasOpenDispatchedEntryOnHome` 而非 `pickFreshestRun`；砍伪任务 T3——`isTargetNodeConsumed` 已由 R2-T3 SQL 闭合）。实现分两 PR + 六轮 Codex impl-gate 加固：

- **PR-1**（`348abf63`，纯能力布线，CI 绿）：T1 `RunLineageView` 加 `shardKey`（6 构造点）+ T2 `resolveHandlerRun` 可选 `shardKey`（undefined=shard 盲 golden-lock）+ T4a `isDispatchedEntryConsumed` anchor 透传。零行为变化。
- **PR-2**（`33004ecf` + Codex 修 `f3f200fa`，CI 绿）：T5 分发门 `(target,shard)` 化（`findOpenDispatchTarget` + `assertNoInFlightDispatch` + in-tx recheck `resolveEntryShardKeysSync`）+ T6 `hasOpenDispatchedEntryOnHome` shardKey（S4 self-rollback）+ T4b 渲染/park（`resolveDispatchedEntryHandler`/`partitionUndispatchedParkTargets`）。P1 merge supersede 按 shard（`abandonSupersededMergeStates` + dispatch escape-hatch + **mintNodeRun 工厂**）。
- **Codex impl-gate 六轮加固**（`a9be7f57`→`2878ae2c`+`1f9eb4d0`）——均在**升级前遗留 null-shard 广播 ledger**（manual@`__wg_member__`，R2-T5 已禁新）这一近乎不可能的边角上逐层收敛：round-2 从 trigger 恢复 shard → round-3 证伪（manual trigger 不稳定、rebind）→ 改**保守 block** → round-4 修永久死锁（仅在有 run obligation 时挡）→ round-5 忽略被取代的历史 failed → round-6 区分**活跃 run vs 被取代终态**（对齐 scheduler/engine liveness 模型，最精确）。**第 9 轮复审生产代码零发现（收敛）**，仅一处测试质量强化。

后端全量每轮 5289→5306 pass / 0 fail、四门 + 单二进制 smoke + CI 全绿。golden-lock：每条非-workgroup-member 路径 shardKey 恒 null→undefined，逐字节等价今日。

## 子任务

### RFC-172b-T1 — `RunLineageView` 带 `shardKey`

- 审计 `RunLineageView` 定义 + 所有构造点（`toLineageViews`、各 lineageViews 构造），把 `node_runs.shard_key` 映射进 view。
- 测试：view 构造保真（shard_key 不丢）。**漏一处 = 静默 shard 盲**，源码锁每个构造点。
- 依赖：无。

### RFC-172b-T2 — `resolveHandlerRun` 加可选 `shardKey`（家族核心）

- `ResolveHandlerInput` 加 `shardKey?: string | null`；`sameNode` 过滤追加 `(shardKey === undefined || r.shardKey === shardKey)`。
- 纯函数测试：同 (node,iter) 混两 shard，`shardKey='A'` 只取 A lineage；`undefined` 复现今日（sibling 掩盖）= golden-lock。
- 依赖：T1。

### ~~RFC-172b-T3 — `isTargetNodeConsumed` shard 化~~ → 删除（Codex 设计门澄清）

- **不做**。`isTargetNodeConsumed` 唯一生产调用方 `clarifyQueue`（R2-T3）传入的 `runs` 已在 SQL 层按 shard 过滤（`clarifyQueue.ts:146-147`），sibling 到不了该判据 → 老化路径已闭合。给它加 shardKey 只扩核心 API + 回归面、零收益。保留编号占位避免 T4/T5 位移。

### RFC-172b-T4 — `isDispatchedEntryConsumed` anchor 分支 + 两个渲染/park 调用方透传

- anchor 分支 `resolveHandlerRun({..., shardKey})` 透传已有 shardKey 参数。
- `resolveDispatchedEntryHandler`（taskQuestions:236）/ `partitionUndispatchedParkTargets`（taskQuestions:572）按调用语境传 shard 或 `undefined`。
- 测试：anchor 分支传 shardKey 后 sibling 在飞不判「消费」。
- 依赖：T2。

### RFC-172b-T5 — 分发门 (target, shard) 化（S2b 主体）

- `entryShardById` 前移到 `assertNoInFlightDispatch`（617）之前；构建「本批 mint 的 (target,shard) 集」。
- `findOpenDispatchTarget`：跳过 shard ∉ 本批 mint 集的在飞条目 + 给 `isDispatchedEntryConsumed` 传 entry 自身 shard。
- **in-tx recheck（774）**：`resolveEntryShardKeysSync(tx, entries)` 同步镜像 + 同款 (target,shard) 逻辑。
- 测试：红→绿集成（A 在飞不挡 B / 同 member 仍串行 / in-tx 并发）。
- 依赖：T2、T4。**风险最高段**（golden-lock TOCTOU/CAS）。

### RFC-172b-T6 — S4 self 回滚 open-ledger 门 shardKey 透传（Codex 修正）

- `hasOpenDispatchedEntryOnHome`（`clarifyRerunLedger.ts:194`）加可选 `shardKey`：`onHome` 追加 `shardOf(e) === shardKey` + 透传给 `isDispatchedEntryConsumed`。
- `selfHomeHasOpenLedger`（`clarifyAutoDispatch.ts:137`）传本 `selfRun` 的 `node_runs.shard_key`（member=assignment id、leader/普通=null→undefined）。
- 测试：member B（shard B）open ledger 不挡 member A（shard A）self 回滚；`undefined` 复现今日 node-wide。
- **不动** `pickFreshestRun` / `scheduler-audit-s13` G7 锁（初稿误指，那条已按 shard 过滤、非 blocker）。
- 依赖：T4（共用 `isDispatchedEntryConsumed` shardKey 透传）。

### RFC-172b-T7 — golden-lock 全回归 + 门禁

- `rfc128-p5-bc` / `rfc131` / `rfc132` / `rfc133` / `rfc164` / `cross-clarify-*` 全绿（`shardKey===undefined` 逐字节不变）。
- `typecheck && lint && test && format:check` + 单二进制 smoke + CI 绿。
- 依赖：T1–T6。

## PR 拆分建议

- **PR-1（家族 shard 化，纯函数为主）**：T1 + T2 + T4（T3 已删）。可断言面全是纯函数，golden-lock 由 `undefined` 保，低风险先落。
- **PR-2（分发门 + S4，高风险）**：T5 + T6 + T7。门的 TOCTOU/CAS + in-tx sync 解析是风险集中段，单独 PR、加并发测试锁。
- 无 migration、无跨批不可分割约束（PR-2 依赖 PR-1 的家族参数已落）。

## 验收清单

- [x] 并发两 member（shard A/B）在飞：A 不挡 B；B 铸 shard-B 续跑（T5，`rfc172` 跨 shard 测试）。
- [x] 同 member（shard A）在飞：第二条仍 `task-question-node-dispatch-in-flight`（不双铸）（T5）。
- [x] `resolveHandlerRun` 传 shardKey 后 sibling 不掩盖消费判据（T2 纯函数锁 + isDispatchedEntryConsumed anchor 透传）。
- [x] S4：member B（shard B）open ledger 不挡 member A（shard A）self 回滚（T6，`hasOpenDispatchedEntryOnHome` shard 单测）。
- [x] P1（Codex）：mint member B 不 abandon member A 在跑的 merge state（`abandonSupersededMergeStates` shard 化，dispatch + 工厂两点）。
- [x] 遗留 null-shard 广播 ledger：有 run obligation 时保守挡、空闲/被取代时释放（不死锁、不双铸）（Codex rounds 2-6，liveness-aware）。
- [x] golden-lock：`shardKey===undefined` 既有断言全绿（rfc128/131/132/133/139/164/cross-clarify/clarify-auto-dispatch）。
- [x] 四门 + 单二进制 smoke + CI 全绿（后端全量 5306 pass / 0 fail；`f3f200fa` CI success）。

## 备注（RFC 纪律）

- 本 RFC 是横切读侧改动（`resolveHandlerRun` 家族被渲染/老化/消费/门复用），**先走设计门（Codex 对抗评审）+ 用户批准，才实现**（[feedback_codex_review_after_changes] 设计门）。
- 多人树：按精确 pathspec 提交，勿碰他人 RFC-170/173/174 WIP。
