# RFC-145 · 失败形态结构化（plan）

> 依赖：T1 → T2 → T3 → T4 → T5。守卫翻红放最后（写读两侧全迁移后）。
> 授权语境：G3-G10 批量授权（用户 2026-07-08），设计门后直接实现，不再单独请批。

## 任务分解

### RFC-145-T1 shared 枚举与策略表（无依赖）

- `shared/schemas/task.ts`：`FAILURE_CODES` / `FailureCodeSchema` / `FailureCode`
  （紧邻 RERUN_CAUSES，同 `as const → z.enum → infer` 形态）；
  `shared/schemas/review.ts`：`SUPERSEDE_DECISIONS`（两值）+ doc_versions 'superseded'
  防混淆互指注释。
- `shared/prompt.ts`：`EnvelopeFollowupReason`（6 值 union）单源导出 +
  `FOLLOWUP_POLICY: Record<FailureCode, { reason }>`。
- 测试：`packages/shared/tests/rfc145-followup-policy.test.ts`（穷举、投影、
  clarify-forbidden 降级格、reason union 与策略表值域自洽）。

### RFC-145-T2 schema + migration 0077（依赖 T1）

- `db/schema.ts` nodeRuns 加三列（failureCode 紧邻 errorMessage@644；supersede 两列
  紧邻 rerunCause@822；rolled_back 用 `integer(mode:'boolean')`）。
- `0077_rfc145_failure_code.sql`：三列 + 11 条 backfill（design §4，逐条
  `--> statement-breakpoint`）；journal idx76 条目；`upgrade-rolling` 76→77 bump。
- 测试：`rfc145-migration-0077.test.ts`（fixture 级：七前缀反解各一格 / 不匹配留 NULL /
  supersede 双值+rollback 组合 / 幂等）+ 复刻 0044 四测（列存在/往返/NULL/全枚举可存）。

### RFC-145-T3 写侧接线（依赖 T2）

- `services/lifecycle.ts`：`NodeRunStatusUpdateExtra` Pick 加三列。
- runner：`RunResult` 加 `failureCode?`；11 个 stamp 点置码（文案零变更）；
  runner-exit extra（:1431）落 `failureCode`。
- review.ts：supersede 写点 extra 加 `supersededByReview`/`rolledBack`；
  `REVIEW_SUPERSEDE_MARKER_PREFIX` 移居 review.ts（message 构造器）。
- 测试：写点断言（每 stamp 分支 failureCode 落库；supersede 双列 + marker 文案并存）。

### RFC-145-T4 读侧切换（依赖 T3）

- `decideEnvelopeFollowup` 查表化：`PreviousAttemptShape` 换 `failureCode`（删
  errorMessage 字段）、调用点 :2426 改读列、7 连 startsWith 删除、
  `PORT_VALIDATION_PREFIX` 删除；scheduler/runner 两份 reason union 改 import shared。
- supersede 切列：`isReviewSupersededRow` 列判定；clarifyRerunLedger :148/:264 切列 +
  :244 inline 常量删除；dispatchFrontier 停止导出 marker 常量。
- 前端：`NodeRunSchema` 加 supersede 两字段 + 序列化点映射；`noderun-status.ts` 字段
  驱动重写（4 字面量删除）；NodeDetailDrawer 等 3 调用点跟随。
- 锁预算兑现（design §6）：改写 rfc095 边界锁 / decide 真值表 fixture / s12 fixture /
  noderun-status-display；删除 rfc131 parity 锁。
- 测试：真值表切源逐格等价（先红后绿——decide 切源后未接 stamp 的集成红，T3 已接则绿，
  顺序上以「切源 commit 内自证」呈现）；前端 vitest 全量。

### RFC-145-T5 守卫 + 收尾（依赖 T4）

- `rfc145-error-message-machine-read-guard.test.ts`（backend+frontend 生产代码
  errorMessage 机器读禁令，剥注释 + 形态匹配）。
- design/plan.md 索引 + STATE.md + flag-audit §4.3 标注；门禁四件套 + binary smoke +
  前端 vitest；push 后 `gh run list/view` conclusion 判 CI；Codex 实现门循环至收敛。

## commit 拆分（少量多次）

1. `feat(scheduler): RFC-145 PR-1 失败形态结构化——shared 枚举/策略表 + 三列迁移`（T1+T2，
   行为零变更、新列无人读写）；
2. `feat(scheduler): RFC-145 PR-2 写侧正向声明——runner 置码 + review supersede 列化`（T3，
   双写开始、读侧未切、行为零变更）；
3. `feat(scheduler): RFC-145 PR-3 读侧切换——decide 查表 + supersede 列判定 + 守卫翻红`
   （T4+T5，协议切换 commit，全部锁预算在此兑现）。

每个 commit 独立过门禁；实现门发现项按 RFC-144 惯例以 PR-4+ 追加。

## 验收清单（对照 proposal §5）

- [ ] decide 零 startsWith、真值表逐格等价、reason union 单源
- [ ] supersede 五消费点零前缀解析、两份 fork 字面量删除、parity 锁按清单处理
- [ ] migration 0077 + backfill 判定锁 + journal/rolling bump
- [ ] runner 11 stamp 全置码；errorMessage 文案零变更（弱锁全绿）
- [ ] errorMessage 机器读守卫翻绿（allowlist 空）
- [ ] 门禁 + CI conclusion + Codex 实现门
