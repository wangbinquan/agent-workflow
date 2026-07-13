# RFC-180 工作组「全自动」模式 —— plan

## 任务分解

### 批次 A — schema + resolve 事实源 + migration

- **RFC-180-T0**：migration（`workgroups` +`autonomous INTEGER NOT NULL DEFAULT 0`，`--> statement-breakpoint`）+ `upgrade-rolling.test.ts` journal 计数 +1（title+断言+注释）。依赖：无。⚠️ 见 [reference_migration_bumps_journal_count_test]。
- **RFC-180-T1**：`shared/schemas/workgroup.ts` 加 `autonomous` 字段（`workgroupConfigFields` + `WorkgroupSchema`）+ `resolveCompletionGate` / `resolveClarifyEnabled` 纯函数 + table 测试（§6.1）。依赖：无（与 T0 并行，落库前 schema 先行）。
- **RFC-180-T2**：`shared/schemas/workgroupRuntime.ts` `WorkgroupRuntimeConfig` 带 `autonomous` + `services/workgroupLaunch.ts` 组装透传。依赖：T1。

### 批次 B — prompt + 引擎控流

- **RFC-180-T3**：`services/workgroupContext.ts` `renderWgProtocolBlock` 条件 push clarify（`resolveClarifyEnabled`）+ 测试（三 role × autonomous，§6.2）。依赖：T2。
- **RFC-180-T4**：`services/workgroupWake.ts` gate 判定读 `resolveCompletionGate` + 测试（§6.3）。依赖：T2。
- **RFC-180-T5**：`services/workgroupWake.ts` leader-idle nudge 分支（新 `leader-nudge` outcome kind + nudgeCount 派生 + 上限）+ `services/workgroupRunner.ts` 消费（落 system 催办消息 + 重跑）+ 引擎测试（nudge/上限/重置/max_rounds，§6.4）。依赖：T2。

### 批次 C — 前端 + 回归 + 门禁

- **RFC-180-T6**：`components/workgroup/WorkgroupForm.tsx` +「全自动」Switch（复用公共 `Switch`）+ 开启置灰 completionGate + 房间/详情「全自动」徽标；i18n zh/en 对称。依赖：T1。
- **RFC-180-T7**：回归 & 升级锁（autonomous=false 三路径现状 §6.5、升级不回归 §6.6）+ 全门禁 + build smoke（migration 计数）。依赖：T3、T4、T5、T6。

## 依赖图

```
T0 ─┐
T1 ─┼→ T2 ─┬→ T3
    │       ├→ T4
    │       └→ T5
    └──────────→ T6
T3+T4+T5+T6 → T7
```

## PR 拆分建议

- **PR-1（schema 地基）**：T0–T2。migration + 字段 + resolve + runtime 透传。可独立测。
- **PR-2（引擎控流）**：T3–T5。prompt 关邀请 + gate resolve + leader-idle nudge。依赖 PR-1。
- **PR-3（前端 + 回归）**：T6–T7。依赖 PR-1。

单 RFC 三 PR；migration 单独在 PR-1 收口，后续 PR 不再动 migration。

## 验收清单

- [ ] `workgroups` 加 `autonomous` 列（default 0）；`upgrade-rolling` journal 计数 +1 绿。
- [ ] `resolveCompletionGate`/`resolveClarifyEnabled` table 全绿（autonomous×storedGate×mode）。
- [ ] autonomous=true：三 role `renderWgProtocolBlock` 无 `WG_CLARIFY_BLOCK`；autonomous=false 有（RFC-172 不回归）。
- [ ] autonomous=true + leader done → 任务直接 `done`（无 gate run/awaiting_review）。
- [ ] autonomous=true + leader idle → nudge system 消息 + 重跑；连续无进展到 `WG_AUTONOMOUS_NUDGE_LIMIT` → `awaiting_human`；有进展→重置；`max_rounds` 触顶优先。
- [ ] autonomous=false：clarify 邀请 / gate / leader-idle 三路径全维持现状（回归锁）。
- [ ] 升级已有组（autonomous 缺省 false）行为不变。
- [ ] `WorkgroupForm` 有「全自动」Switch、开启置灰 completionGate + 提示；i18n zh/en 对称。
- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；单二进制 build smoke（migration）通过。
- [ ] Codex 设计门 findings 全折（批准前）+ 实现门 findings 全折（实现后）。
- [ ] `design/plan.md` RFC 索引 + `STATE.md` 登记（Draft→In Progress→Done）。

## 备注（多人协作）

与并发 RFC-177/178（skills / task-subject）共享工作树。提交只按精确 pathspec 提 RFC-180 自有文件 + `plan.md`/`STATE.md` 自有行；共享索引文件混入他人在途行时按 CLAUDE.md「一起提、只述己方」，不剥离他人内容。migration 文件名取提交时**实际最大**编号 +1（避免与并发 session 的 migration 撞号——提交前复查 `packages/backend/src/db/migrations/` 最新编号）。
