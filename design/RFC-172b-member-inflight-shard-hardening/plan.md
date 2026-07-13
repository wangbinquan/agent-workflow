# RFC-172b 任务分解 — run-resolution 家族 shard 化

状态：**Draft（待设计门 + 用户批准；不改代码）**。前置：RFC-172 路线 2 核心已交付（S0–S3 / R2-T3 / R2-T5 / R2-T6 / R2-T7 / S5）。零 migration。

## 子任务

### RFC-172b-T1 — `RunLineageView` 带 `shardKey`
- 审计 `RunLineageView` 定义 + 所有构造点（`toLineageViews`、各 lineageViews 构造），把 `node_runs.shard_key` 映射进 view。
- 测试：view 构造保真（shard_key 不丢）。**漏一处 = 静默 shard 盲**，源码锁每个构造点。
- 依赖：无。

### RFC-172b-T2 — `resolveHandlerRun` 加可选 `shardKey`（家族核心）
- `ResolveHandlerInput` 加 `shardKey?: string | null`；`sameNode` 过滤追加 `(shardKey === undefined || r.shardKey === shardKey)`。
- 纯函数测试：同 (node,iter) 混两 shard，`shardKey='A'` 只取 A lineage；`undefined` 复现今日（sibling 掩盖）= golden-lock。
- 依赖：T1。

### RFC-172b-T3 — `isTargetNodeConsumed` 加可选 `shardKey` + 调用方
- 同款追加过滤；`clarifyQueue.ts`（老化）/ `crossClarify.ts` 调用方在 member 场景传本 run shard、其余 `undefined`。
- 测试：`shardKey='A'` 时 sibling B done+output 不老化 A；`undefined` 复现今日。
- 依赖：无（与 T2 并行）。

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

### RFC-172b-T6 — S4 self 回滚守卫 shardKey 透传
- self 回滚路径 `pickFreshestRun(scoped, ...)` 的 `scoped` 加 shard 过滤（`undefined` golden-lock）。
- 同步更新 `scheduler-audit-s13-freshest-fork-source-guards.test.ts` 的 G7 锁断言。
- 测试：并发两 member retry 各自回滚 `pre_snapshot`，不互相回滚。
- 依赖：T1。

### RFC-172b-T7 — golden-lock 全回归 + 门禁
- `rfc128-p5-bc` / `rfc131` / `rfc132` / `rfc133` / `rfc164` / `cross-clarify-*` 全绿（`shardKey===undefined` 逐字节不变）。
- `typecheck && lint && test && format:check` + 单二进制 smoke + CI 绿。
- 依赖：T1–T6。

## PR 拆分建议

- **PR-1（家族 shard 化，纯函数为主）**：T1 + T2 + T3 + T4。可断言面全是纯函数，golden-lock 由 `undefined` 保，低风险先落。
- **PR-2（分发门 + S4，高风险）**：T5 + T6 + T7。门的 TOCTOU/CAS + in-tx sync 解析是风险集中段，单独 PR、加并发测试锁。
- 无 migration、无跨批不可分割约束（PR-2 依赖 PR-1 的家族参数已落）。

## 验收清单

- [ ] 并发两 member（shard A/B）在飞：A 不挡 B；B 铸 shard-B 续跑。
- [ ] 同 member（shard A）在飞：第二条仍 `task-question-node-dispatch-in-flight`（不双铸）。
- [ ] member B queued run-obligation 只数 shard-B run。
- [ ] `resolveHandlerRun` / `isTargetNodeConsumed` 传 shardKey 后 sibling 不掩盖/不误老化。
- [ ] S4：并发 retry 各自回滚 `pre_snapshot`，不互相回滚。
- [ ] golden-lock：`shardKey===undefined` 既有断言全绿（含 s13 G7 同步）。
- [ ] 四门 + 单二进制 smoke + CI 全绿。

## 备注（RFC 纪律）

- 本 RFC 是横切读侧改动（`resolveHandlerRun` 家族被渲染/老化/消费/门复用），**先走设计门（Codex 对抗评审）+ 用户批准，才实现**（[feedback_codex_review_after_changes] 设计门）。
- 多人树：按精确 pathspec 提交，勿碰他人 RFC-170/173/174 WIP。
