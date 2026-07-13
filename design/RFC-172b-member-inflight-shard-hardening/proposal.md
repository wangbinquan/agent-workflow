# RFC-172b 提案 — 工作组 member 反问并发加固（run-resolution 家族 shard 化）

状态：**Draft（待设计门 + 用户批准）**。前置：[RFC-172](../RFC-172-member-clarify-roundtrip/proposal.md) 路线 2 核心（S0–S3 / R2-T3 / R2-T5 / R2-T6 / R2-T7 + S5）已交付并推送 origin/main。

## 背景

RFC-172 路线 2 让工作组 **member 的人类反问答案能正确回流到对应指派**：所有 member 指派共享唯一的 `__wg_member__` host 节点，靠 `node_runs.shard_key`（= assignment id）区分。核心已做到——两个 member 各问各答，各自 shard 独立铸续跑、`entryIds` 不串（S5 端到端证明）。

RFC-172 的 plan.md 把两段**并行度加固**显式降级为 follow-up（原 R2-T2 后半 S2b + S4），当时的判断是「正确性核心不依赖它，改动须动 golden-lock 的 TOCTOU/CAS 三处」。本 RFC 接手这两段，并给出**为什么它不是 gate 的外科手术、而是一次横切设计**的调研结论。

## 问题（调研结论）

in-flight 分发门（`assertNoInFlightDispatch` / `findOpenDispatchTarget`，taskQuestionDispatch.ts）按 `target = override ?? default` **单节点键**判断「该节点有没有未消费的在飞续跑」。两个 member 共享 `__wg_member__`，理论上 member A 的在飞续跑会挡住 member B 的分发。

但调研发现真正的根因**在更底层**：门的「消费」判据最终落到 `resolveHandlerRun`（`packages/shared/src/task-questions.ts:254`），它按 `(nodeId, iteration, loopIter)` 取 lineage 窗口、**完全 shard 盲**（`task-questions.ts` 全文零 shard 引用）。同族的派生老化判据 `isTargetNodeConsumed`（`clarifyRerunLedger.ts:249`）同样 shard 盲。这带来**双向**错误：

- **假消费（sibling 掩盖）**：member A 的在飞续跑（shard A，pending），被一个 id 更大的 sibling done run（shard B）落进同一 lineage 窗口 → `resolveHandlerRun` 判 member A「已消费」→ 门放行 member B（甚至放行 member A 自己的第二次，串行保护也失效）。
- **假在飞（obligation 误判）**：反过来，member B 的 queued 条目做 run-obligation 扫描时，会把 member A 的在飞 run（异 shard）算成 member B 的义务 → member B 的答案被误判「还在飞」而不老化 / 悬挂。

即：**在飞门、消费判据、老化判据、渲染、park 分区**——整个 run-resolution 家族对 workgroup member 都是 shard 盲的。RFC-172 的 R2-T3 只把**老化窗口的 node_runs 扫描**加了 shard 过滤，`resolveHandlerRun` / `isTargetNodeConsumed` 家族仍 shard 盲。所以 S2b 不能只改分发门（会造成「门 shard 感知、老化/消费 shard 盲」的不一致读侧）。

## 目标

1. 让 run-resolution 家族（`resolveHandlerRun` + `isTargetNodeConsumed` + 全部调用方）对 workgroup member **shard 感知**：一个 shard 的 run 只解析/消费/老化本 shard 的义务，sibling shard 互不干扰。
2. **并发正确性**：并发两 member 各自反问各自被答，续跑绑定、老化、渲染各自只见本 shard；member A 在飞不挡 member B（异 shard），但同 member 的第二次仍串行（不双铸）。
3. **S4 顺带收口**：self 回滚守卫（retry 回滚 pre_snapshot）随家族 shard 化一并透传 shardKey（当前 `pickFreshestRun` node 级，多 member 并发回滚才需逐 shard）。

## 非目标

- 不改普通节点 / leader / dynamic_workflow 的任何行为——**golden-lock**：每条非 workgroup-member 路径 shardKey 恒 `undefined`（shard 盲，逐字节等价今日）。
- 不做跨 shard 反馈端口 / 跨 member 状态共享（RFC-172 v1 边界不变）。
- 不引入 migration（`node_runs.shard_key` 已存在）。

## 用户故事

- **作为工作组使用者**：两个 member 并发各自触发人类反问，我分别回答，两人各自的续跑都只看到自己那条 `## Clarify Q&A`、互不串扰、互不阻塞（今天 member B 可能被 member A 的在飞掩盖/阻塞）。
- **作为平台维护者**：run-resolution 家族有单一、shard 感知的判据；`undefined` 保 golden-lock，我能确信普通节点行为零漂移。

## 验收标准

- [ ] 并发两 member（shard A/B）在飞：A 的在飞续跑**不**挡 B 的分发；B 铸 shard-B 续跑。
- [ ] 同一 member（shard A）在飞时，该 member 第二条答案分发**仍被串行挡**（不双铸）。
- [ ] member B 的 queued 条目 run-obligation 判据只数 shard-B 的 run，不被 sibling 在飞 run 误判为在飞。
- [ ] member 答案老化 / 渲染 / park 分区各自 shard 隔离（`resolveHandlerRun` / `isTargetNodeConsumed` 传 shardKey）。
- [ ] **golden-lock**：`shardKey===undefined` 路径全绿（rfc128 / rfc131 / rfc132 / rfc133 / rfc164 既有断言逐字节不变）。
- [ ] S4：并发两 member retry 回滚各自 `pre_snapshot`，不互相回滚 sibling worktree 状态。
- [ ] `typecheck && lint && test && format:check` + 单二进制 smoke + CI 全绿。

## 决策点（设计门 / 用户拍板）

- **D1 范围：宽 vs 窄**。窄=只 shard 化分发门（`findOpenDispatchTarget`）；宽=shard 化整个 `resolveHandlerRun` + `isTargetNodeConsumed` 家族。调研结论**推荐宽**（窄会造成门与老化/消费的读侧不一致）。见 design §决策。
- **D2 shardKey 传导形态**：`resolveHandlerRun` 加**可选** `shardKey?: string | null`（`undefined`=shard 盲 golden-lock），还是新开 shard 感知的孪生函数？推荐可选参数（复用、零 fork）。
- **D3 S4 是否并入本 RFC**：self 回滚守卫与家族 shard 化同源，推荐并入（同一 PR 批）。
