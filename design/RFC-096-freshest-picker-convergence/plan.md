# RFC-096 — 任务分解

单 PR（RFC 默认；main 直推）。commit 前缀：`fix(backend): RFC-096 freshest picker 收敛（比较器下沉 + 共享挑行 + 四处病理修复）`。

## 子任务

### RFC-096-T1 — 比较器下沉 + 共享 picker + 机械迁移

- isFresherNodeRun / buildFreshestDonePerNode → freshness.ts（scheduler 一行 re-export）；
  review.ts 改 import；pickFreshestRun 落地；review.ts 三点 + priorDoneDesigner 机械迁移
  （design §1/§2）。
- 新增 `rfc096-pick-freshest.test.ts`。
- 依赖：无。

### RFC-096-T2 — 四处病理修复（红→绿）

- triggerDesignerRerun / retryNode 级联 / readPortAtIteration done-only / options-T1 reduce
  （design §3.1-3.4）+ 死代码删除（§3.5）。
- 新增三个 rfc096-\* red→green 测试 + options-T1 用例扩展。
- 依赖：T1。

### RFC-096-T3 — 守卫与收尾

- s13 按 FLIP 翻转 + startedAt 序/内存 reduce 新守卫（design §4）。
- `design/plan.md` 置 Done；`STATE.md` 登记；门禁三件套；推送查 CI。
- 依赖：T1-T2。

## 验收清单

见 proposal.md「验收标准」。
