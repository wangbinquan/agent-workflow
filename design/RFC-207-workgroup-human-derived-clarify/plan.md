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
- **T2** `packages/shared/src/schemas/workgroupRuntime.ts:52` 删 `autonomous`。（已核实该 schema 为裸 `z.object`、非 `.strict()`，旧快照多余键会被静默剥离——仍补一条「旧快照可 parse」回归测试。）
- **T3** 注释同步：`shared/src/prompt.ts:152/308-309/873`、`shared/src/schemas/clarify.ts:459`（顺带把 `sealedCause` 取值改为 `'wg-clarify-disabled'`）。
- **T4** shared 测试：`workgroupHasHumanMember` 真值表 + `resolveCompletionGate` 四象限 + 「`resolveClarifyEnabled` 符号在 `packages/shared/src` 零命中」源码锁。

依赖：T1 → T2/T3/T4；T1 落地后 `bun run typecheck` 会在**所有**需要改的后端/前端调用点报红——按红点推进即可，这是设计意图（design §1.2 / R1）。

### 阶段 B —— backend 引擎与 hook

- **T5** `services/workgroupContext.ts:457` 邀请块判据换 `workgroupHasHumanMember(config.members)`。
- **T6** `services/workgroupRunner.ts`：`:1518-1520/:1807-1813/:1987-1989` 三处**算一次 `clarifyAllowed` 同时喂 renderer 与 `clarifyEnabled`**（见 T28d）；`:1121` 完工门复检；`:977-989` 重入不变式改用 `!workgroupHasHumanMember(rec.config.members)`（**只看花名册这一维**，预算/喊停不遣散在途 park）；`:1536-1544` / `:1828-1833` 重提示文案（收场逻辑不动）。
- **T7** `services/workgroupWake.ts`：`:308-311` 完工门；`:315-322` **删 autonomous 分支**、催办统一（design §3.3）；`WG_NUDGE_BODY` 文案去 autonomous。
- **T8** `services/workgroupLifecycle.ts`：`isTaskAutonomous` → **`resolveWgClarifyAllowed(db, taskId, nodeId, shardKey)`**（design §1.3——三条件串联的**全仓唯一求值出口**，fail-open 语义见 D12）；`dismissOpenClarifyParksForAutonomous` → `dismissOpenClarifyParks`（:208+）；留痕字面量 `:262` → `'wg-clarify-disabled'`。
- **T9** `services/scheduler.ts:863-865/936-937/990-999` 三处换新活判据 + 新 dismiss 名；`services/runner.ts:1266-1278` 压制文案。
- **T10** `services/workgroupRunner.ts:583-607` `persistGate` **无需改动**（已核实是整份 reload-merge、无字段白名单，`members` 天然保留，design §3.5）；仅补一条并发回归测试：引擎持久化 gate 的同时路由删成员，断言成员变更不被覆盖——锁住「整份 merge」这个性质，防未来被优化成白名单而静默丢成员。

### 阶段 C —— backend 路由与持久化

- **T11** `routes/workgroupTasks.ts`：`ConfigPatchSchema` 删 `autonomous`（:119）、changes 文案（:1038）、nextConfig 合并（:1084）。
- **T12** `routes/workgroupTasks.ts:1212-1222` 遣散触发条件改为「人工成员数 `>0 → 0`」（design §3.4），保留 `dynamic_workflow` 守卫与双 kick。
- **T12a（二轮设计门 P1）** 把「配置写入 + 遣散」整体纳入 `getTaskQuestionWriteSem(taskId)`（`services/taskWriteLocks.ts:61`，答案提交侧经 `clarifySeal.ts:458` 持有同一把）。现状是配置事务在 `:1197` 就提交、遣散在 `:1217` 另开事务，RFC-181 A2 声称的「陈旧答案 409 / 不 mint 重跑」在这条缝里**并不成立**，只换触发条件会原样继承。注意该锁**非重入**（遣散原语内部不得再取）且锁序为 A(`getTaskWriteSem`) ≻ B(本锁)，此处只取 B。备选是把遣散改造成 tx-aware，但要动 RFC-181 既有原语签名，**优先加锁方案**。
- **T13** `services/workgroups.ts:123/178/422`（create 默认 / update 保留 / 序列化）、`services/workgroupLaunch.ts:98`（快照）删字段。
- **T13a** `services/workgroups.ts` create/update/序列化 + `workgroupLaunch.ts` 快照**新增** `clarifyBudget`；照抄 `fanOut` 的 optional-not-default 契约（create `?? 3`、update `?? existing`），**不能**用 schema `.default()`（否则省略该字段的 PUT 会静默改写既有组）。
- **T14** `db/schema.ts:496` 删列 + `clarify_budget` 新列 + `tasks.running_ms/running_since` 新列 + `task_node_clarify_directives` 重建 + `node_runs.error_message` 回填，**单 migration 多段、每段之间 `--> statement-breakpoint`**（design §4）+ `_journal.json` +1。排查「冻结在旧 migration 的 DB」fixture（drizzle INSERT 会带 HEAD 全部列 ⇒ `no column named running_ms`）。

依赖：T14 依赖 T13/T13a（代码不再读旧列）；T12 依赖 T8。

### 阶段 C2 —— 反问不能永不停（G8 / G9 / G10）

- **T28a（G8 键与回退）** shared 新增 `wgClarifyAskerKey(nodeId, shardKey)`（leader / `asg:*` / `mem:*` 归一化，design §3.6.3）与 `resolveClarifyBudget(config)` + `WG_CLARIFY_BUDGET_DEFAULT=3`（design §3.6.5）。**所有读取点只准走它们**，禁止裸 `?? 3`（配源码锁）。
- **T28b（G8 计数）** 按 `clarify_sessions` 的真实提问记录计数（`sourceAgentNodeId` + 归一化 asker key），**不得**复用 `priorDoneGenerationsForRun`——它统计的是同一 `(nodeId, iteration, shardKey)` 下所有 done 顶层 run，leader 每个正常回合都算一行，会让「跑满 N 个不反问的回合后首次反问」被误判耗尽（二轮设计门 P1）。检查点在 `createClarifySession` **之前**，与 §3.4a 地板、活判据同一短路。
- **T28c（G8 字段）** `schemas/workgroup.ts` 加 `clarifyBudget`（optional-not-default）+ 进 `WorkgroupRuntimeConfig`（**optional**，旧快照必须仍可解析）+ 进 per-task `ConfigPatchSchema`；重提示文案区分「无人可问 / 次数用尽 / 已被喊停」三种。
- **T28d（G8 邀请同源，二轮设计门 P1）** `renderWgProtocolBlock` 增参 `clarifyAllowed`，`workgroupContext.ts:457` 改用传入值不再自推；三个 turn 各算一次 `clarifyAllowed` 同时喂 renderer 与 `clarifyEnabled`。**否则预算耗尽/被停时 prompt 仍在邀请、envelope 又拒绝，白烧 `WG_PROTOCOL_RETRIES` 并把派单打成 failed。** 连带改 `rfc200-source-lock.test.ts:67`。
- **T29（G9 存储）** `task_node_clarify_directives` 加 `shard_key TEXT NOT NULL DEFAULT ''`、PK 改三元（重建式 migration，`''` 作节点级哨兵，service 边界做 `null ↔ ''` 转换）；改 `taskClarifyDirective.ts` 四个函数 + 三个生产读取点（`scheduler.ts:3189-3191`、`crossClarify.ts:500`、`clarifyMigration.ts:179`），读取按「shard 行优先、节点级回落」。
- **T29b（G9 恢复语义，二轮设计门 P2）** 写入节点级 `continue` 时同事务 `DELETE` 该 `(task_id, node_id)` 下所有 shard 行——否则 shard 级 stop 优先于节点级 continue，形成「看着是继续、实际仍被停」的不可恢复死角。
- **T30（G9 写入）** `clarifySeal.ts:467-474` 改为按轮的 `askingShardKey` 经 `wgClarifyAskerKey` 归一化后落行（`null → ''`；工作组消息轮 `msg:*` → `mem:*`，不归一化则每条消息换一个键、停了等于没停）；`routes/taskClarifyDirective.ts` 的 body schema 加可选 `shardKey`。**必配测试**：普通非分片零变化 + 普通 fan-out 分片 stop 收窄为单片（design §3.7.4 已披露的行为变化）。
- **T31（G9 接线）** 工作组 host 路径读 directive：派发期并入 `clarifyEnabled`（`workgroupRunner.ts:1520/1813/1989`）、envelope 期并入 `clarifySuppressed`（`scheduler.ts:863-865`）。**不改** `clarifyChannel.directive`（保持 `'delegated'`，别撞 RFC-183 对称性锁 / `clarifyDispositionFor` 的 `'stopped'→'reject'` 语义）。
- **T32（G9 恢复入口）** 房间响应增补 `clarifyStops`；`WorkgroupRoom` 信息区 / 派单卡片显示「反问已停止」chip + 复用 `.btn--xs` 恢复按钮（调既有 directive 路由写 `'continue'`）。**不新增配置开关**。
- **T33（G10）** `tasks` 加 `running_ms`/`running_since`；写入集中在 `lifecycle.ts:411-423` 的 `writeStatus`（进/出 `running` 各一条规则），`TaskStatusUpdateExtra`（`:290-300`）白名单加这两列；`limits.ts:77` 改读累计值；migration 回填当前 `running` 行的 `running_since = started_at`。
- **T34（G8/G9/G10 测试）** design §8 的三组新增覆盖；**特别注意**改写 `scheduler-audit-gap1-limits-resume-startedat.test.ts:170-217`（锁的正是要修的 bug）、更新 `limits.test.ts:74-81` 与 `rfc097-cancel-wins.test.ts` 的 seed（只 seed `startedAt` 会让取消不再触发）、同步两条 directive 源码文本锁（`rfc122-clarify-directive-dispatch.test.ts:547/569`、`rfc123-clarify-directive-single-source.test.ts:394/405-407`）。
- **T35（前端 G8）** 组表单在 `maxRounds` 邻位加「反问次数上限」`NumberInput`（复用 `<Field>`/`<NumberInput>`）；`reconcileWorkgroupSaveResponse` 的逐字段比对**补上** `clarifyBudget`，否则新字段的回执校验有洞。

### 阶段 D —— backend 测试（与 B/C 同 commit 落地）

- **T15** 改写既有契约锁：`rfc180-workgroup-autonomous.test.ts`（整体重定向到新判据，文件可重命名为 `rfc207-*` 并保留原用例作为回归）、`rfc164-workgroup-core.test.ts:384-408/804-813`（默认 fixture 无人工 ⇒ 断言翻转 + 另加有人工正向例）、`rfc181-autonomous-hardening.test.ts`、`rfc164-workgroup-room.test.ts:916-1002`、`rfc187-continue-no-dispatch.test.ts:80-111`（G4 行为变更）、`rfc183-clarify-invite-accept-symmetry.test.ts:219-233/332-355`（逐字节文案）、`workgroup-host-output-isolation.test.ts:56`、`rfc186/187` 各 e2e fixture（**重点**：`rfc187-workgroup-e2e.test.ts:151-209` 与 `rfc187-leader-clarify-park.test.ts` 靠 `autonomous:false` 走「leader 反问 → park → 答 → done」，其花名册是纯 agent；改造后该路径会被压制 ⇒ **必须给 fixture 加一个人工成员**，否则这两条正向覆盖会静默变成「反问被压制」而失去意义）、`rfc186-envelope-followup-parity.test.ts`、`rfc164-workgroup-engine.test.ts`、`rfc187-clarify-continuation-revival.test.ts`、`rfc200-source-lock.test.ts`、`rfc187-maxrounds-wrapup.test.ts`、`rfc187-zero-delta-done.test.ts`、`upgrade-rolling.test.ts`（journal 计数 +1）。
- **T16** 新增 `packages/backend/tests/rfc207-human-derived-clarify.test.ts`：design §8 的「协议块 / 引擎 / 中途转移 / 迁移」四组必写用例（含无人工组硬压制全程不 park、有人工组反问→答→done、催办统一、遣散转移、陈旧答案 409、旧快照可 parse）。
  **必含派发期地板用例（design §3.4a，Codex 设计门 P1）**：无人工时起跑的 turn → 中途加入第一个人工成员 → 该 turn 硬发 `<workflow-clarify>` **仍被驳回、任务不 park**；**下一轮**才拿到邀请块并可正常反问。反向：有人工时起跑 → 中途移除最后一人 → 该 turn 落地时被活读当场压住。

### 阶段 E —— 前端（含前端测试，同 commit）

- **T17** `WorkgroupForm.tsx`：删 Switch；完工门 `disabled` 改 `!hasHumanMember`；新增 prop，`routes/workgroups.detail.tsx:956-963` 传入。
- **T18** `WorkgroupTaskConfigDialog.tsx`：同上，且 `hasHumanMember` 随本地成员增删暂存**实时**重算。
- **T19** `lib/workgroup-form.ts` / `lib/workgroup-room.ts` 删 draft 字段与 patch diff。
- **T20** `routes/workgroups.tsx:114/141-143`：「全自动」chip → 「含人工」chip（数据源已核实：`rowToWorkgroup` 返回 `members`）。
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

单 RFC 单 PR（`main` 直推）。**Codex 设计门 P2 更正**：原先设想的「后端一个 commit、前端一个 commit」**不可行**——workspace typecheck 覆盖全部 package，shared 契约（`Workgroup` / `WorkgroupRuntimeConfig` 删字段、`resolveClarifyEnabled` 删除）一旦落地，未同步的前端消费方立刻编译不过，第一个 commit 就是红的，违反本仓「每个 commit 自带测试且门禁全绿」的要求。故：

1. `feat(workgroup): RFC-207 反问/完工门改由花名册人工成员派生` —— **T1~T23 合为一个原子 commit**（shared 契约 + backend + migration + frontend + 全部测试）。契约与其所有消费方必须同生共死。
2. `feat(workgroup): RFC-207 反问预算 + 打通停止反问 + park 不计时` —— T28~T35。可独立成 commit：它**只增不减**（新增字段 / 新增读取条件 / 新增列），不动第 1 个 commit 已建立的契约，故中间态可编译可测。
3. `docs(state): RFC-207 索引与状态同步` —— T24/T25。

⚠️ 两个 commit 都要碰 migration。若第 1 个已落盘、第 2 个再加 migration，须是**新文件**而非改已提交的那个（已发布的 migration 不可变），或干脆把 T14 推迟到第 2 个 commit 一次写完。**推荐后者**：一个 RFC 一个 migration 文件，避免 journal 计数与 rolling-upgrade 测试改两遍。

（若单 commit 体量过大需要分次落盘，唯一安全的切法是**按功能纵切且每次都跨 shared/backend/frontend 三层**，而不是按层横切。）

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
- [ ] AC11（G8）反问预算：leader 与每张派单独立计数；问满即驳回并要求自行决断、**任务不 park**；新派单从 0 重算；`budget=0` 首问即驳回；省略该字段的 full-replace PUT 不改写既有组。
- [ ] AC12（G9）停止反问：工作组里点「提交并停止反问」后，**只有发问的那张派单**被停（leader 停 leader），后续 `<workflow-clarify>` 被硬驳回、不建 session、不 park；派发期同步不再注入邀请块（invite⟺accept 对称）。
- [ ] AC13（G9）恢复：房间显示「反问已停止」并可一键恢复，恢复后下一轮可正常反问。
- [ ] AC14（G9 已披露变化）普通任务非分片节点的 stop 行为零变化；fan-out 分片节点的 stop 收窄为单片（有专测）。
- [ ] AC15（G10）任务在 `awaiting_human` 停留任意时长后恢复，不因等待时长被 `task-time-limit-exceeded`；真实运行时长仍正确累计并仍能触发上限。
