# RFC-175 任务「再次启动」全参数预填 —— plan

单一逻辑 PR（本仓 main-only 开发，[[feedback_main_branch_only]]）。**主重建路径零 migration + 1 枚 agent 身份 targeted migration（§2e，用户拍板 B）**。依赖顺序 T0（migration）→T1→T2→T3→T4→T5→T6；T1/T2 与 T3 可并行，T4 依赖 T2+T3，T5 依赖 T4。

`feat(shared,backend,frontend): RFC-175 任务再次启动全参数预填（reconstruct + agent 身份 migration）`

| #  | 任务 | 说明 / 验收 |
| -- | ---- | ----------- |
| T0 | backend：`source_agent_id` migration（用户拍板 B，§2e） | **取当时最新空号**（勿硬编码；看 `packages/backend/db/migrations` + journal 尾，与 RFC-170 协调）：`ALTER TABLE tasks ADD COLUMN source_agent_id TEXT`（nullable、**不 backfill**）；`schema.ts` 加列；**journal bump → 改 `upgrade-rolling.test.ts` N**（[[reference_migration_bumps_journal_count_test]]）。migration parse 测试。 |
| T1 | shared：schema 增字段 | `schemas/task.ts` `TaskSchema` 增 `workgroupName`+`goal`+**`sourceAgentId`**（`nullable().optional()`）+ `StartTaskSchema` 增 `expectedWorkflowVersion`（R5-F1）；`schemas/workgroup.ts` `StartWorkgroupTaskSchema` 增 `expectedWorkgroupId`（R2-F1b）；`StartAgentTaskSchema` 增 **`expectedAgentId`**（§2e）。**三守卫是即时提交 OCC overlay**（R6-F1：即时 POST spread、**不进** `buildImmediateBody`/`buildLaunchBody*`；定时 schema 拒收）。同 PR 修 fixtures/测试。 |
| T2 | backend：派生投影 + 三启动守卫 + agent 持久化 | `services/task.ts`：`frozenWorkgroupGoal` + `rowToTask` 加 `workgroupName`/`goal`/`sourceAgentId`；`startTask` `expectedWorkflowVersion` 不符→`ConflictError('workflow-version-mismatch')`。`workgroupLaunch.ts`：**404 后**比对 `expectedWorkgroupId`→`workgroup-id-mismatch`。**agent（§2e/R8-F2/R10-F1）：`startAgentTask` ACL-404 得 `resolved.id`→**早检**（`materializeSpace` 前比对 `expectedAgentId`→`agent-id-mismatch`）；**进程内引用计数 reservation**（R10-F1/R11-F1：`Map<agentId,count>` acquire++ 于 materialize 前 / `try..finally` count-- 覆盖早检+校验+materialize+INSERT 全异常、仅 count→0 移除；**acquire 后 name→id ACL-safe 重验** 补 resolve→acquire 窗）；**`deleteAgent`/`renameAgent` 加 `count>0`→`agent-launching` 409**；线程 `resolved.id` 进 `StartTaskDeps.agentLaunch`、`task.ts` 中央 INSERT dbTxSync re-check 断言 id==线程值（belt-and-suspenders 不变式）、`sourceAgentId` 从重验 id 写（唯一写路径改动）**。测试 §6.4/§6.7/§6.7b + 早检 + reservation（launch 中删/改名→409）。**除 §2e 外无新端点/join；进程内 lease 无 durable/崩溃面（单进程 daemon）。** |
| T3 | frontend：两枚纯函数 + applyWizardSeed 抽取 | `lib/task-wizard.ts`：`snapshotClarifyState` **三态**（仅 false 写 allowClarify）+ `taskToLaunchPayload(task)` 回带 `{payload, spaceResolvable}`（**无 subjectResolvable**——主体校验归 §4 清单查，R3-F3；**空间四态** + local 空/internal 降级；upload 剔除由 §4 按**当前 inputDefs** 做，R3-F2；协作者不入）。抽 `applyWizardSeed(seed,setters)` 供两路复用。测试 §6.1/§6.2/§6.3。 |
| T4 | frontend：向导接 relaunchFrom + 状态机 | `routes/tasks.new.tsx`：`+relaunchFrom`+editScheduled 互斥；query 集（task/members + **kind 清单+workflow 详情**）；**`relaunchPhase` barrier**〔R3/R4-F4：含 **actor 三态**〔R5-F2：`useActor` auth 失败=`data:null` success 永不 isError；`isPending`→loading / `success&&null`→鉴权错误面重登 / 非 null→`actor.data.user.id`+排 `__system__`〕、每条必需 query 有 error/retry〔不永挂〕、loading 冻结、applied 拒晚到；members「弃继续」、主体清单/详情失败可重试〕；**协作者集=`[owner,...users]−launcher−inactive/system`**〔R3-F4，含原 owner〕、workgroup 不预填、**kind 变更清 collaborators**；**主体守卫**〔workgroup id 守卫 + **captured `selectedWorkgroupId`**〔R4-F2〕；agent **三分支 seed**〔R9-F1：NULL→best-effort 按名 / 非 NULL & id 一致→pre-select+捕获 `selectedAgentId` / **非 NULL & id 不符→不 pre-select+禁提交+重选**（不降级 guardless）〕 + captured `selectedAgentId`〔R8-F3：改选更新/清选清、即时 POST 携 `expectedAgentId=selectedAgentId`〕；**save-as-schedule 主体身份=定时既有 name 定位、不加 create-time precondition**〔R8-F1：撤 R7 的 theater precondition，整体出范围〕〕；**输入规范化 + 版本绑定**〔R4-F3+R5-F1：按当前 `inputDefs` 清 upload-kind/enum 越界/非法值 + 提示；捕获 `workflowQ.data.version` 提交带 `expectedWorkflowVersion`、409 重取+重规范化〕+ multipart 防御剔除；**两 OCC 守卫仅即时 POST overlay、不进 `buildImmediateBody`/scheduledEnvelope**〔R6-F1〕；**多仓失败门 `failed&&failedNodeId==null&&remote`**〔R3-F1〕；**internal 任务 seedFailed 防御**〔R4-F1〕；落 STEP_MODE+frontier CONFIRM。**不设 isEdit**、kind 不锁。测试 §6.5/§6.6/§6.8/§6.9/§6.12。 |
| T5 | frontend：入口切换 + 源码锁 | `routes/tasks.detail.tsx`：relaunch `<Link>`（`task-detail-relaunch`）+ resume-兜底 `<Link>` → `{ relaunchFrom: tk.id }`；gate = `isTerminal` **且 `tk.spaceKind !== 'internal'`**〔R4-F1：fusion 任务不给 relaunch〕。测试 §6.9 internal 抑制 e2e + §6.10 源码锁。工作组 room 入口＝可选增量（design §5，非验收所需）。 |
| T6 | 门禁 | `bun run typecheck && bun run test && bun run format:check` 全绿（含前端 vitest）；`bun run build:binary` 冒烟；push 后查 CI（[[feedback_post_commit_ci_check]]）；Codex 实现门（[[feedback_codex_review_after_changes]]）折入 findings。§6.8 editScheduled 回归确认全绿。 |

## 验收清单

- [x] AC1 工作组 relaunch 预填组名（id 一致时）/goal/space/limits，非空表单；**不预填协作者**
- [x] AC2 agent relaunch 预填 description + allowClarify（三态）+ space + advanced（含协作者）
- [x] AC3 workflow relaunch 预填非 upload inputs + space + advanced；upload 清空+必填重选
- [x] AC4 历史任务：remote/scratch/local best-effort 预填；internal/中途失败多仓/upload 安全降级，无静默错误值
- [x] AC5 落地全新任务、kind 未锁、未污染 editScheduled
- [x] AC6 主体/ACL 安全：workgroup seed-id 守卫 + 服务端 `expectedWorkgroupId` 409（关 TOCTOU）；协作者=当前成员可编辑默认、workgroup 不预填、kind 切换清协作者；`relaunchPhase`（loading 冻结/applied 拒晚到）；404/403/网络报错禁提交；多仓失败确认门
- [x] AC7 重建零 migration + 1 枚 targeted `source_agent_id` migration（用户拍板 B）；TaskSchema +3 optional + 三启动 schema 各 +1 守卫参；唯 `startAgentTask` 落库 `sourceAgentId` 一处写路径改动；三守卫即时 overlay 不进定时
- [x] AC-agent post-migration agent 任务 delete+同名重建 relaunch→`agent-id-mismatch` 409；历史任务（sourceAgentId NULL）best-effort 按名
- [x] AC8 全测试 + 门禁 + CI + Codex 实现门 绿

## 备注

- **1 枚 migration（§2e `source_agent_id`，用户拍板）** ⇒ **必须** bump `upgrade-rolling.test.ts` journal-count N（[[reference_migration_bumps_journal_count_test]]）、**取实现期最新空号**与 RFC-170 协调（勿硬编码 0091）；单条 ALTER 免 statement-breakpoint。其余重建路径仍零 migration。
- 改符号前全量盘测试源码锁（[[feedback_grep_locks_before_push]]）：`taskToLaunchPayload`/`snapshotClarifyState`/`applyWizardSeed`/`relaunchFrom`/`workgroupName`/`goal`/`sourceAgentId`/`expectedAgentId`/`expectedWorkgroupId`/`expectedWorkflowVersion`/`startAgentTask` 命中集。
- 多人树精确 pathspec 提交，勿碰他人 WIP（scheduler.ts / skills\*）。

## 交付状态（Done，2026-07-13）

设计门 12 轮 APPROVE + 用户批准 B-full → 实现 T0–T6 全落地（migration 0091 取实现期空号）。**Codex 实现门 4 轮收敛 4→3→1→1→APPROVE，findings 全折**（每条见对应 commit message）：

- **F1** stale-members ACL 回授 → `staleTime:0`+`refetchOnMount:'always'`+ barrier 判 `isSuccess`（不止 `isFetchedAfterMount`——errored refetch 留 stale data；组件探针实测 TanStack v5 语义）。
- **F2** 失败多仓静默子集 → 正向 `worktree creation failed:` marker（**非** `failedNodeId===null`——scheduler 失败〔snapshot-invalid/cycle/scheduler-error〕同 null 但空间完整；前后端 marker 源码锁耦合）。
- **F3** enum drift 静默非法提交 → `normalizeSeededInput` multiSelect-first（allowOther 也强制 JSON 数组线格式）+ `missingRequired` 空数组按缺失。
- **F4** multipart 漏 `expectedWorkflowVersion` OCC → `buildWorkflowStartFormData` 加 `extra` 参在 whitelist **之后**并入 payload（scheduledEnvelope 仍干净）。
- **F1-followup** barrier 按**源任务 kind** 判成员（workgroup 不阻塞于其不消费的 members；错误横幅指真失败查询，不再渲染 "null"）。
- **F1-followup-2** submit 门改反应式 `relaunchApplied`（仅 seed effect 越过完整 barrier 后置 true，与种子 setState 同批渲染）——堵缓存 refetch 期「种子未应用但 submit 已开」窗。
- **W13** 端到端行为回归（`?relaunchFrom` seed→导航→launch，断言 POST body 恰为重建值）补实现门 low 覆盖。

提交：`7498e626`〔T0+T1〕`cb052b39`〔T2 投影〕`3df6896b`〔T2 守卫+reservation〕`79b65929`〔T3〕`010afc44`〔T4+T5〕`2a7de26c`〔RFC-165 lock 键盖形〕`d432ccfd`〔impl-gate F1-4〕`524dd3d8`〔re-gate〕`ef6e30b8`〔F1-followup〕`eed47fb5`〔F1-followup-2〕`d48e42c7`〔W13〕`f9a95c19`〔STATE/plan Done〕。全 origin/main、CI 绿。
