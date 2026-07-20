# RFC-207 —— plan

## 0. 前置

- 实现前重新 `rg -n "autonomous" packages/*/src` 复核一遍锚点（本 RFC 的 file:line 采于 2026-07-20 `1125dd83`；工作树多人并发，可能已漂移）。
- 复核 migration 空号：本 RFC 假定 `0099`，但另有一个**计划中**的 `0099 drop cached_repos.url`（RFC-204 遗留）。若已被占用则顺延，并同步 `_journal.json` 与 `upgrade-rolling.test.ts` 的计数断言。
- 本仓在 `main` 上直接开发（不开分支）；工作树可能带他人未提改动，`git add` 一律走精确路径。

## 1. 任务分解

### 阶段 A —— shared 契约（其余全部依赖它）

- **T1** `packages/shared/src/schemas/workgroup.ts`
  - 新增 `workgroupHasHumanMember(members)`（design §1.1）。
  - **删除** `resolveClarifyEnabled`。
  - `resolveCompletionGate` 第一参 `boolean` → 成员数组（design §1.2）。
  - `WG_AUTONOMOUS_NUDGE_LIMIT` → `WG_LEADER_IDLE_NUDGE_LIMIT`。
  - 删 `WorkgroupSchema.autonomous`（:132）与 `workgroupConfigFields.autonomous`（:181）及其大段注释。
- **T2** `packages/shared/src/schemas/workgroupRuntime.ts:52` 删 `autonomous`；**确认该 schema 非 `.strict()`**（旧快照多余键须被静默剥离，design §4 / R5）。
- **T3** 注释同步：`shared/src/prompt.ts:152/308-309/873`、`shared/src/schemas/clarify.ts:459`（顺带把 `sealedCause` 取值改为 `'wg-clarify-disabled'`）。
- **T4** shared 测试：`workgroupHasHumanMember` 真值表 + `resolveCompletionGate` 四象限 + 「`resolveClarifyEnabled` 符号在 `packages/shared/src` 零命中」源码锁。

依赖：T1 → T2/T3/T4；T1 落地后 `bun run typecheck` 会在**所有**需要改的后端/前端调用点报红——按红点推进即可，这是设计意图（design §1.2 / R1）。

### 阶段 B —— backend 引擎与 hook

- **T5** `services/workgroupContext.ts:457` 邀请块判据换 `workgroupHasHumanMember(config.members)`。
- **T6** `services/workgroupRunner.ts`：`:1520/:1813/:1989` 三处 `clarifyEnabled`；`:1121` 完工门复检；`:977-989` 重入不变式换 `isTaskClarifySuppressed`；`:1536-1544` / `:1828-1833` 重提示文案（收场逻辑不动）。
- **T7** `services/workgroupWake.ts`：`:308-311` 完工门；`:315-322` **删 autonomous 分支**、催办统一（design §3.3）；`WG_NUDGE_BODY` 文案去 autonomous。
- **T8** `services/workgroupLifecycle.ts`：`isTaskAutonomous` → `isTaskClarifySuppressed`（:166-181，fail-open 语义见 D12）；`dismissOpenClarifyParksForAutonomous` → `dismissOpenClarifyParks`（:208+）；留痕字面量 `:262` → `'wg-clarify-disabled'`。
- **T9** `services/scheduler.ts:863-865/936-937/990-999` 三处换新活判据 + 新 dismiss 名；`services/runner.ts:1266-1278` 压制文案。
- **T10 【设计门重点】** `services/workgroupRunner.ts:583-600` `persistGate` 的 reload-merge **必须覆盖 `members`**（design §3.5 / R2）；写一条并发测试：引擎持久化 gate 的同时路由删成员，断言成员变更不被覆盖。

### 阶段 C —— backend 路由与持久化

- **T11** `routes/workgroupTasks.ts`：`ConfigPatchSchema` 删 `autonomous`（:119）、changes 文案（:1038）、nextConfig 合并（:1084）。
- **T12** `routes/workgroupTasks.ts:1212-1222` 遣散触发条件改为「人工成员数 `>0 → 0`」（design §3.4），保留 `dynamic_workflow` 守卫、单事务编排、双 kick。
- **T13** `services/workgroups.ts:123/178/422`（create 默认 / update 保留 / 序列化）、`services/workgroupLaunch.ts:98`（快照）删字段。
- **T14** `db/schema.ts:496` 删列 + 新 migration（`ALTER TABLE workgroups DROP COLUMN autonomous` + `node_runs.error_message` 回填，**带 `--> statement-breakpoint`**）+ `_journal.json` +1。

依赖：T14 依赖 T13（代码不再读该列）；T12 依赖 T8。

### 阶段 D —— backend 测试（与 B/C 同 commit 落地）

- **T15** 改写既有契约锁：`rfc180-workgroup-autonomous.test.ts`（整体重定向到新判据，文件可重命名为 `rfc206-*` 并保留原用例作为回归）、`rfc164-workgroup-core.test.ts:384-408/804-813`（默认 fixture 无人工 ⇒ 断言翻转 + 另加有人工正向例）、`rfc181-autonomous-hardening.test.ts`、`rfc164-workgroup-room.test.ts:916-1002`、`rfc187-continue-no-dispatch.test.ts:80-111`（G4 行为变更）、`rfc183-clarify-invite-accept-symmetry.test.ts:219-233/332-355`（逐字节文案）、`workgroup-host-output-isolation.test.ts:56`、`rfc186/187` 各 e2e fixture、`rfc186-envelope-followup-parity.test.ts`、`rfc164-workgroup-engine.test.ts`、`rfc187-clarify-continuation-revival.test.ts`、`rfc200-source-lock.test.ts`、`rfc187-maxrounds-wrapup.test.ts`、`rfc187-zero-delta-done.test.ts`、`upgrade-rolling.test.ts`（journal 计数 +1）。
- **T16** 新增 `packages/backend/tests/rfc206-human-derived-clarify.test.ts`：design §8 的「协议块 / 引擎 / 中途转移 / 迁移」四组必写用例（含无人工组硬压制全程不 park、有人工组反问→答→done、催办统一、遣散转移、陈旧答案 409、旧快照可 parse）。

### 阶段 E —— 前端（含前端测试，同 commit）

- **T17** `WorkgroupForm.tsx`：删 Switch；完工门 `disabled` 改 `!hasHumanMember`；新增 prop，`routes/workgroups.detail.tsx:956-963` 传入。
- **T18** `WorkgroupTaskConfigDialog.tsx`：同上，且 `hasHumanMember` 随本地成员增删暂存**实时**重算。
- **T19** `lib/workgroup-form.ts` / `lib/workgroup-room.ts` 删 draft 字段与 patch diff。
- **T20** `routes/workgroups.tsx:114/141-143`：「全自动」chip → 「含人工」chip（先核实列表 API 带 `members`，R7）。
- **T21** `routes/clarify.detail.tsx:819-820` cause 值 + 文案 key；`WorkgroupRoom.tsx:1050-1054` 压制标注文案。
- **T22** i18n 双 bundle + 类型声明：删 4 键、加 2 键、改名 1 键（design §6）。
- **T23** 前端测试：`workgroup-form.test.tsx:128-136/597-607`、`workgroup-task-config.test.tsx:86-103/260-284`、`workgroups-pages.test.tsx:964`、`workgroup-studio-panel.test.tsx:161`、`rfc202-source-locks.test.ts:52-70` 改写 + 新增 `workgroup-human-derived-clarify.test.tsx`（design §8 前端四条）。

### 阶段 F —— 文档与门禁

- **T24** `design/plan.md` RFC 索引新增 RFC-207 行；RFC-180 / RFC-181 行状态标注 **Superseded（autonomous 开关部分）**，措辞写清 RFC-181 的硬压制机制被继承保留。
- **T25** `STATE.md`：立项时顶部加「进行中 RFC」行；完工后转 Done + 已完成表加行 + 写明升级期两类行为变化（design §4）。
- **T26** 门禁：`bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；**改了 migration ⇒ 跑完整 backend `bun test`，不只跑 migration 子集**；`bun run build:binary` smoke；Playwright e2e（`task-wizard.spec.ts` 重点）。
- **T27** Codex 实现门（`--base` 指向本次改动起点，detached worktree 跑，避开并发 session 的 diff），把 findings 逐条折入；推完立即查 GitHub Actions 状态（按 my sha 查，不用 `--limit 1`）。

## 2. 依赖图

```
T1 ─┬→ T2 → T4
    ├→ T5/T6/T7/T8/T9 ─→ T10
    ├→ T11 → T12 (dep T8)
    ├→ T13 → T14
    ├→ T17/T18/T19/T20/T21/T22
    └→ (T15/T16/T23 随各自阶段同 commit)
T14 → T26(全量 backend test)
所有 → T24/T25 → T27
```

## 3. PR / commit 拆分建议

单 RFC 单 PR（`main` 直推），内部按**纵切**分 commit，每个 commit 自带测试（test-with-every-change）：

1. `feat(workgroup): RFC-207 反问/完工门改由花名册人工成员派生（shared + backend + migration）` —— T1~T16。
2. `feat(frontend): RFC-207 删除全自动开关、完工门随人工成员置灰` —— T17~T23。
3. `docs(state): RFC-207 索引与状态同步` —— T24/T25。

不建议把 shared 契约单独成 commit：`resolveClarifyEnabled` 删除后中间态无法 typecheck。

## 4. 验收清单（对应 proposal §6）

- [ ] AC1 无人工成员组：三角色 prompt 无 `<workflow-clarify>`；硬发被驳回、耗尽丢弃，任务全程不进 `awaiting_human`（反问原因）。
- [ ] AC2 有人工成员组：三角色 prompt 含邀请块；反问 → `awaiting_human` → 答 → done，leader run 数不膨胀。
- [ ] AC3 完工门：无人工 ⇒ 直接 done；有人工 + 存储开 ⇒ `awaiting_review`。
- [ ] AC4 催办统一：任意组空转均先催至多 3 轮，再 `leader-idle` park。
- [ ] AC5 中途加人 ⇒ 下轮可反问；中途移除最后一人 ⇒ 单事务遣散 + 解卡 + resume；陈旧答案 409；gate park 不被误遣散；dw 免疫。
- [ ] AC6 `rg -n "autonomous" packages/*/src` 仅剩 `home.cap.workgroups.desc` 营销文案；`workgroups` 表无该列；per-task PATCH 不再接受该字段。
- [ ] AC7 非工作组 clarify 全套零回归；`requireTaskMember` 边界与 rfc099 prompt 隔离测试绿。
- [ ] AC8 旧任务快照（含 `autonomous` 键）仍可 parse 且行为按新判据。
- [ ] AC9 `persistGate` reload-merge 覆盖 `members`（并发测试通过）。
- [ ] AC10 门禁四件套 + 单二进制 smoke + e2e 全绿；CI 按本人 sha 查证。
