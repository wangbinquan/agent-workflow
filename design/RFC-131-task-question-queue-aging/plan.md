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

### T4 — 改派下游（RFC-127 收编）
- 确认 run.node_id=origin / agent=target / 下游=origin（design §4 D3）；`buildBorrowedAgent` + `resolveBorrowForNode`（target agent 解析给 spawn）保留。
- 三账本借壳冲突判定收敛为 in-flight 串行。
- 测试：改派 target → 进目标队列、下游归 origin；self/questioner 不可改派；designer 可改派；借壳 spawn 不破。
- 依赖：T3。

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
