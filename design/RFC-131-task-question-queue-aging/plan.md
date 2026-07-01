# RFC-131 任务分解与 PR 拆分

> 配套 `proposal.md` / `design.md`。派生式老化 → **零 schema migration**。

## 任务分解

### T1 — 派生老化纯函数
- 新 `isTargetNodeConsumed(targetNodeId, iteration, runs, outputRunIds): boolean`（design §2 三态规则）。
- 单测：无 run / pending / running / `done`-无-output / `done`+output / failed / canceled 各 case。
- 依赖：无。可独立落库（未接入）。

### T2 — 队列注入 `buildClarifyQueueContext`
- 取 target 队列所有 `sealed` 且 `!isTargetNodeConsumed` 的问题，跨轮累积、按 iteration 排序、历史轮 read-only、当前轮 sibling scope、零 attribution。
- golden-lock：non-deferred / 单轮全量 → 逐字旧 `buildPromptContext`。
- 单测：多轮全历史注入 / done+output 老化后不注入 / done-无-output 不老化仍注入 / 历史 read-only / sibling scope / golden-lock parity。
- 依赖：T1。

### T3 — 消费路径切换 + 防护改按 target
- 注入接入 scheduler（deferred 路径用 `buildClarifyQueueContext`，non-deferred 保留 `buildPromptContext`，XOR）。
- in-flight 串行 + readiness gate + park 改按 target 派生（design §7）：`assertNoInFlightDispatch` / `partitionUndispatchedParkTargets` 收敛为「target 有未产出在飞 run」。
- 收敛 `isDispatchedEntryConsumed` / `openImmediateRounds` 的 in-flight/revivable mode（design §10）。
- 测试：in-flight 串行 / park / readiness / 死锁天然避免（done-无-output）。
- 依赖：T1、T2。

### T4 — 改派下游（**去借壳大改**，用户 2026-07-01 拍板；design §4 D3 勘误）
- 改派问题的 rerun 在 **target 节点** mint（非 origin 借壳）；产出 / 下游归 target 自己。
- 注入器改派后 `consumerNodeId` 用 target（投影后的目标节点）。
- **退役** `buildBorrowedAgent` / `resolveBorrowForNode`（慎删：多人树，先与协作者调和，绝不单方覆盖）。
- #7 勘误：self/questioner **可**改派（都可，与现状 `canReassign` 一致）——初稿「不可改派」被用户模型推翻。
- 测试：改派 target → 进目标队列、target 消费、下游归 target；`rfc127-*-borrow` 改语义或删。
- 依赖：T3 + **协作者 RFC-130 scheduler 稳定**（撞 `scheduler.ts`，等其 CI 绿再动）。

### T5 — 迁移/派生验证 + 集成 e2e
- 派生零 migration：升级窗口在飞任务不丢历史轮（历史 target 已产出 → 派生老化；未产出 → 注入）。
- 集成：多轮 self-clarify e2e（复现并锁死 `01KWDKBS` 类 bug：round 1 + round 2 都进产出 prompt）。
- review reject → 重做不重注 + prior-output。
- 依赖：T3、T4。

### T6 — 前序收敛 + 回归锁
- `1fb1646`（mode 分裂）→ 收敛为 `isTargetNodeConsumed`；`9b1c30e`（history 补丁）→ `buildClarifyQueueContext` 取代（可回退补丁 or 留作过渡）。
- 回归锁更新：`rfc128-p5-bc` / `rfc127-*-borrow` / `clarify-rerun-ledger-deadlock` 按新语义。
- 依赖：T2、T3、T4。

## PR 拆分建议

| PR | 内容 | 风险 |
|----|------|------|
| PR-1 | T1 + T2（纯函数 + 注入，未接入 scheduler） | 低（纯函数 + 单测） |
| PR-2 | T3（消费/注入接入 + gate/park 按 target + mode 收敛） | 🔴 高（热点调度器） |
| PR-3 | T4（改派下游 RFC-127 收编） | 🟡 中（借壳交集） |
| PR-4 | T5 + T6（迁移验证 + e2e + 前序收敛 + 回归锁） | 🟡 中 |

每个 PR 独立门禁（typecheck + test + format + Codex impl gate）+ CI 绿。

## 依赖图

```
T1 ─→ T2 ─→ T3 ─→ T4
              └─→ T5 ─┐
                      ├─→ T6
              T4 ─────┘
```

## 验收清单（交付前必绿）

- [ ] 多轮反问 rerun prompt 含所有 answered 轮、按序、历史 read-only、零 attribution
- [ ] target `done+output` 老化；`done`-无-output 不老化、下轮仍注入；failed 不误消费
- [ ] 改派改 target → 进目标队列；下游归 origin；借壳 spawn 不破
- [ ] review 重做消费不重注 + prior-output
- [ ] readiness / in-flight 串行 / park 三重防护保留
- [ ] golden-lock：non-deferred / 单轮全量逐字不变
- [ ] 迁移：升级窗口在飞任务不丢历史轮（派生零 migration）
- [ ] 前序死锁修复（1fb1646）+ history 补丁（9b1c30e）收敛、回归锁更新
- [ ] typecheck×3 + 全量 backend test + format + 单二进制 smoke + CI 全绿

## 风险与缓解

- **golden-lock 回归**：non-deferred 单轮字节级 → 每 PR parity 测试兜底。
- **借壳 spawn 破坏**：`buildBorrowedAgent`/spawn 路径保留、rfc127 borrow 测试锁。
- **热点调度器（PR-2）**：Codex adversarial impl gate 每轮 + 分批小步。
- **迁移窗口丢数据**：派生无持久态、回退即回旧逻辑；e2e 覆盖在飞任务。

## 交付进度（2026-07-01）

**已交付**（本地全量 4635 pass + typecheck 我方文件干净 + 单二进制 smoke 绿；CI 待协作者 RFC-130 解除污染）：
- T1 判据 `isTargetNodeConsumed`（trigger_run_id + ULID id 序锚，防 round N+1 误老化）——`ee1a810` + `37907eb`；单测 `rfc131-target-consumed.test.ts`（13）。
- T2 注入接入：self/questioner（`buildClarifyNodeQueueContext`，`dba77ab`）+ designer（`buildNodeQueueExternalFeedback`，`37907eb`）换派生老化。
- T3 部分：gate/park 保持 per-entry in-flight（`1fb1646` 死锁 fix；design §7 语义分层勘误——注入=老化 / 调度=in-flight，**不收敛**，否则 park 死锁）。
- T6 回归锁：`rfc120-deferred-dispatch`（T9/§18 修）+ `rfc128-p5-bc`（多轮 + 注入层 老化/round N+1/failed 三新测试，`1f63919`）。
- design 勘误 `44059e5` + §4 去借壳（本次）；单二进制 smoke 绿。

**已交付续（2026-07-01 本 session 再续）**：
- cross-questioner 域注入 2 测试（`54500fb`）+ self 注入层 3 测试（`1f63919`）+ **T5 scheduler e2e**（`78df761`：`scheduler-clarify-multiround-aging.test.ts` runTask 端到端复现锁死 `01KWDKBS`，1 pass 7 expect）。
- 注入层测试全集完成（self×3 + cross-questioner×2 + designer〔rfc120 §18〕+ round N+1 + failed + 多轮 + 老化不重注〔§18 afterA〕+ golden-lock）。
- design §4 去借壳设计（`6504cfd`）。

**唯一剩 T4 去借壳的 spawn 层退役（用户 2026-07-01 拍板：等协作者 PR-C 落定后做）**：
- 注入层去借壳**已随 T2/T4-designer 交付**（问题按 target 投影 + `isTargetNodeConsumed(target)` = 改派进 target 队列的核心已达）。
- 剩 spawn 层：退役 `buildBorrowedAgent`（`agent.ts:39`）/`resolveBorrowForNode`（`taskQuestionDispatch.ts:966` 三账本）+ scheduler borrow spawn 调用。
- **硬冲突铁证**：`buildBorrowedAgent` 处理借壳的 `readonly` 继承，而协作者 RFC-130 **PR-C 此刻正改同一函数**（working tree 未提交 diff `@@ -27,14 @@` buildBorrowedAgent 注释 + createAgent/updateAgent/rowToAgent 删 readonly）。T4 退役 buildBorrowedAgent = 同函数覆盖 → CLAUDE.md「同一函数冲突→停下问用户」；+ classifier 拦 `scheduler.ts`。
- **用户拍板等 PR-C 落定**（AskUserQuestion 2026-07-01），PR-C commit 后我在稳定基线上做 T4（避免同函数 git 冲突 + 覆盖协作者未提交改动）。

**CI 状态**：前序 unused-import blocker 协作者自己修了（`8025194`+`c4b8c24`）。当前唯一红 = 协作者 RFC-130 `scheduler.test.ts:681`「two write agents serialize through write semaphore」（`expect(elapsed).toBeGreaterThan(450)`，s17 改并行 writeSem 后 timing 系统性 384/413ms < 450，非 flaky）——协作者改并行 writeSem 未同步此 serialize test，需协作者更新，非本 RFC。我方 RFC-131 committed typecheck 绿 + 运行时全 pass。
