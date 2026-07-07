# RFC-144 · merge_state 状态机化（plan）

> 依赖关系图：T1 → T2 → T3 →（T4, T5 并行）→ T6。
> 排序铁律（RFC-053/097 共同教训）：shared 纯函数先行 → CAS 包装 → 写点全迁移 → **守卫最后翻红**
> （守卫在写点迁移完成前落地会自红）。

## 任务分解

### RFC-144-T1 shared 状态机 + 穷举测试（无依赖）

- `packages/shared/src/lifecycle.ts` 追加：`MERGE_STATES` / `MergeState` / `MergeStateOrNull` /
  `TERMINAL_MERGE_STATES` / `SETTLED_MERGE_STATES` / `isTerminalMergeState` / `isMergeStateSettled` /
  `MergeStateTransitionEvent`（7 事件 ADT）/ `IllegalMergeStateTransition` /
  `targetForMergeEvent` / `nextMergeState`（`never` 穷举）/ `allowedFromForMergeEvent`（遍历派生）。
- 新测试 `packages/shared/tests/rfc144-merge-state-transition-table.test.ts`（design §13 项 1-5）。
- 验收：shared 测试绿；不触 backend。

### RFC-144-T2 backend CAS 包装 + 竞态测试（依赖 T1）

- `packages/backend/src/services/lifecycle.ts` 追加：`ConcurrentMergeStateTransition` /
  `MergeStateUpdateExtra` / `transitionMergeState`（NULL-from 用 `isNull` 谓词）/
  `tryTransitionMergeState` / `abandonSupersededMergeStates`（集合式守卫写，含
  taskQuestionDispatch 同步 tx 可用的形态）——两处直写各带
  `// rfc144-allow-direct-merge-state-write` 标记。
- 新测试 `packages/backend/tests/rfc144-merge-state-cas.test.ts`（design §13 项 6-9）。
- 验收：CAS/竞态/abandon 单测绿；生产码尚无调用者（此刻 scheduler 仍裸写，守卫未落地，不红）。

### RFC-144-T3 19 写点迁移 + 读点表派生 + 守卫翻红（依赖 T2）

- 按 design §5 迁移表逐点替换 scheduler.ts 的 19 处 `.set({ mergeState })`：
  - `persistIsoBase` / `persistIsoNodeTree` 内部改调 `transitionMergeState`（后者删除
    `mergeState: string` 假旋钮参数，D11）；
  - 主路径抛、catch 内错误路径（W10/13/16/19）用 try 变体 + log；
- 读点改造（design §6）：settled 门 → `isMergeStateSettled`；done 分支 → 穷举 switch（含
  abandoned→blocked 新格 + `never`）；replay WHERE 字面量 → shared 常量。
- `mergeBackWrapperIso` 返回联合 `awaiting_human` → `conflict-human` 改名（§9-3）。
- schema.ts:770-773 注释矫正（7 值 + NULL + 唯一写者指路）。
- **守卫落地**：`packages/backend/tests/rfc144-merge-state-blind-write-inventory.test.ts`
  （design §9-1，含 mint 无 mergeState 源码锁）。
- 验收：守卫绿（allowlist 恰被 lifecycle.ts 2 处占用）；rfc130-* 全套 + scheduler.test.ts 绿
  （本任务行为零变更——事件与旧写值一一对应）；deriveFrontier 分桶测试绿。

### RFC-144-T4 abandon 接线 + stale replay 修复（依赖 T3）

- **先写红测试**：`rfc144-stale-replay-regression.test.ts` 场景 A（design §7/§13-10），确认在
  T3 完成、T4 未接线时为红（复现 bug）。
- `mintNodeRun`（nodeRunMint.ts:186）insert 后调 `abandonSupersededMergeStates`；
  `taskQuestionDispatch.ts:759` 同步 tx 内同参调用（同豁免标记）。
- 补场景 B / C 测试（§13-11）、clarify D19 交互测试（§13-14，abandon 后 iso 目录仍在）、
  merge-failed 行为测试（§13-12，顺带补 RFC-130 缺口）。
- 验收：场景 A 红转绿；B/C/D19/merge-failed 全绿；rfc130-* golden 仍绿。

### RFC-144-T5 migration 0076 存量清洗（依赖 T3，可与 T4 并行）

- `packages/backend/db/migrations/0076_rfc144_abandon_superseded_merge_state.sql`（design §8，
  单语句无需 statement-breakpoint）+ journal 登记。
- `upgrade-rolling.test.ts` 「HEAD journal has 75 entries」→ 76（标题+断言+注释同步）。
- 新迁移测试：三类行判定锁死（§13-15）。
- 验收：迁移测试绿；rolling 测试绿。

### RFC-144-T6 收尾（依赖 T1-T5）

- `design/plan.md` RFC 索引状态 Draft → Done；`STATE.md` 顶部「进行中 RFC」行改完成记录
  （含已完成 issue 表加行）。
- flag-audit-2026-07-07.md §4.4/§7 的 RFC-G2 条目标注「已由 RFC-144 落地」。
- 门禁：`bun run typecheck && bun run lint && bun run test && bun run format:check` +
  `bun run build:binary` smoke + 前端 vitest（虽不触前端、跑一遍防误伤）；push 后查 GitHub
  Actions（[feedback_post_commit_ci_check]）。
- Codex 实现门评审（[feedback_codex_review_after_changes]），发现项修完再宣告完成。

## PR 拆分建议

默认单 RFC 单 PR；本 RFC 建议**拆 2 个 PR**（理由：结构收口与行为修复的回滚域分离——PR-1 行为
零变更、可独立验证「纯收口不动语义」；PR-2 才引入 abandoned 值 + 迁移 + bug 修，出问题回滚不
牵连守卫层）：

- **PR-1（T1+T2+T3）**`feat(scheduler): RFC-144 merge_state 状态机化——转移表+CAS+守卫收口`
  ——行为零变更（事件↔旧写值一一对应、abandoned 值已进值域但无生产写者）、守卫翻红、golden 全绿。
- **PR-2（T4+T5+T6）**`feat(scheduler): RFC-144 abandoned 接线+migration 0076——修 stale replay 脏 canon`
  ——mint 不变量、先红后绿回归、存量清洗、收尾。

每个 PR 独立满足门禁；PR-1 合入后即使 PR-2 延迟，守卫已生效（新增写点会被拦）。

## 验收清单（对照 proposal §5）

- [ ] scheduler.ts `mergeState` 裸直写 0 处（守卫 allowlist = services/lifecycle.ts ×2）
- [ ] shared 穷举测试：合法全绿 / 非法全拒 / allowedFrom 自洽 / 终态集锁定
- [ ] CAS 竞态（含 NULL-from isNull 格）+ try 语义 + abandon 集合写幂等
- [ ] stale replay 场景 A 先红后绿；B / C / D19 交互覆盖
- [ ] migration 0076 三类行判定 + journal 75→76 + rolling 锁 bump
- [ ] merge-failed 行为测试补齐（RFC-130 缺口）
- [ ] rfc130-* golden 全套保持绿
- [ ] schema 注释矫正 + `awaiting_human`→`conflict-human` 联合改名
- [ ] 门禁四件套 + binary smoke + CI 状态核查 + Codex 实现门
