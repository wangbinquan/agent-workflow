# RFC-095 — 任务分解

单 PR（RFC 默认；main 直推）。commit 前缀：`fix(backend): RFC-095 decideScopeOutcome 抽取 + 状态全集穷举分桶 + canceled 复活语义`。

## 子任务

### RFC-095-T1 — canceled 归类 + isDispatchable 穷举

- dispatchFrontier.ts：`REVIEW_SUPERSEDE_MARKER_PREFIX` / `isReviewSupersededRow` 常量与助手；
  isDispatchable 改穷举 switch + canceled 分支（design §1/§2.1）；review.ts 引常量为单一事实源。
- 依赖：无。

### RFC-095-T2 — deriveFrontier 穷举分桶 + Frontier.blocked

- scheduler.ts 分桶段按 design §2.2 改穷举 switch + never；Frontier 接口加 `blocked`。
- 依赖：T1。

### RFC-095-T3 — decideScopeOutcome 抽取

- dispatchFrontier.ts 新纯函数（design §3）；runScope quiescent 块替换为调用（行为字节级
  等价 + stalled 诊断增量）。
- 依赖：T2。

### RFC-095-T4 — 测试落地

- 翻转 s12 / s22；新增 `rfc095-scope-outcome.test.ts`（design §5）。
- 回归网跑通（rfc092-midrun-review-iterate / derive-frontier\* / review 全套）。
- 依赖：T1-T3。

### RFC-095-T5 — 收尾

- `design/plan.md` RFC 索引置 Done；`STATE.md` 登记。
- 门禁：`bun run typecheck` + 根 `bun test` + `bun run format:check`；推送后查 CI。
- 依赖：T4。

## 验收清单

见 proposal.md「验收标准」。
