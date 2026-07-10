# RFC-165 统一创建任务 —— design

配套 `proposal.md`（产品决策 D1–D11）。本文约定：引用行号为 2026-07-10 工作树（含 RFC-164 PR-3 未提交改动）的快照，实现期以 grep 实况为准。**§14 记录 Codex 设计门三轮 findings 的逐条折算**——本版已全部吸收。

## §0 关键抉择

| 抉择                          | 选型                                                                                                                                                                                                                                                                                                                                                                                                                 | 理由 / 否决项                                                                                                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 空间契约形态                  | **平铺字段 + superRefine 互斥**（`scratch?: boolean ⊕ repoUrl/repos`）+ **入口层 raw-key 拒收**退役字段                                                                                                                                                                                                                                                                                                              | 与现 schema 同构（`task.ts:349-429`）、multipart 编码友好；非 strict zod 静默剥离未知键（F1），沿 `assignments` 先例（`routes/tasks.ts:204-217`）显式拒收。                                                                      |
| wire ≠ 服务层输入             | 公开 `StartTaskSchema` 收敛为 远端 URL\|scratch；fusion 走 `deps.internalSource`（wire 不可达），任务落 **`space_kind='internal'`**                                                                                                                                                                                                                                                                                  | fusion 两条启动链现用 `repoPath/baseBranch/preCreatedWorktree`（`fusion.ts:447-483, 832-879`），硬删 wire 字段会击穿（F4）；`'internal'` 给内部任务合法持久语义。                                                                |
| 临时空间落库                  | scratch 目录**自身是 git 仓**：`repo_path = worktree_path = scratchDir`，`base_branch='main'`，base commit=空根提交                                                                                                                                                                                                                                                                                                  | 三列 NOT NULL 零迁移重建；空根提交是快照机制 `HEAD` 依赖所必需（`util/git.ts:1067-1095`）。                                                                                                                                      |
| 单 Agent 执行                 | 合成快照走**正常 runScope**；**唯一运行时触点=clarify optional 指令**（F12）                                                                                                                                                                                                                                                                                                                                         | 分派入口不动（`scheduler.ts:494-510`）；现 clarify 边=强制先问（§4）。                                                                                                                                                           |
| 单 Agent FK 锚 + 生命周期守卫 | 懒播种 `__agent_host__` + 守卫改 **`taskExecutionKind` 感知**（F13-r3 终版）：**agent 宿主放行 resume + node retry；workgroup 宿主 resume 与 node retry 均维持 403**（引擎恢复语义〔host 行/assignment/gate/cursor 重置矩阵〕属 164 领域，generic resume 对其不成立——引擎只收养 `pending` 行、wake 只驱动 durable 态，`workgroupRunner.ts:435-444`、`workgroupWake.ts:107`）；fusion builtin 403；宿主 sync 统一 422 | 现守卫挡宿主任务 resume/retry/sync（`routes/tasks.ts:371-381,514-529,417-420,639-650`）；对 workgroup 的放行留待 164 定义 engine-specific 恢复后另行解锁（本 RFC 显式 403 锁）。                                                 |
| 任务主体判别                  | `tasks.source_agent_name` 新列 + shared `taskExecutionKind` 单点派生                                                                                                                                                                                                                                                                                                                                                 | 守卫/徽标/再次启动/sync 共用判定点。                                                                                                                                                                                             |
| 启动 endpoint                 | 三类**不合流** + 三 launch endpoint 统一 **`tasks:launch`**（F15）；**scheduled 的「委托 launch」操作全部 gate**（N1-r3）：create / payload 更新 / enable / **enabled 态下的 scheduleSpec 变更**（改频率=改委托）/ run-now；disabled 态 spec-only 与 disable/delete/改名放行                                                                                                                                         | `/api/agents/*` POST 中间件误落 `agents:write`（`server.ts:118-123`）；scheduled 路由现状零 gate（`routes/scheduledTasks.ts:71-113`）+ fire 以 owner 重建全权 actor（`scheduledTasks.ts:219-233`、`actor.ts:28-42`）= PAT 绕过。 |
| 定时任务                      | **三主体全支持（D11）**：`launch_kind` + payload 封套 + fire/run-now 按 kind 分派；存储/读取 tolerant（**逐字段 degraded**，N3-r3）、创建/更新/触发 strict                                                                                                                                                                                                                                                           | 一行 legacy/坏 JSON/坏 shape 不得炸整表（`scheduledTasks.ts:38-85` 现状 `JSON.parse` 前置 + DTO 双列必合法，`schemas/scheduledTask.ts:63`）。                                                                                    |

## §1 数据模型与迁移（0085）

```sql
ALTER TABLE tasks ADD COLUMN space_kind text NOT NULL DEFAULT 'remote';
--> statement-breakpoint
UPDATE tasks SET space_kind = 'local'
WHERE repo_url IS NULL
   OR EXISTS (SELECT 1 FROM task_repos tr WHERE tr.task_id = tasks.id AND tr.repo_url IS NULL);
--> statement-breakpoint
UPDATE tasks SET space_kind = 'internal'
WHERE workgroup_id IS NULL
  AND workflow_id IN (SELECT id FROM workflows WHERE builtin = 1 AND name = 'aw-skill-fusion');
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN source_agent_name text;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN workspace_pruning_at integer;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN workspace_pruned_at integer;
--> statement-breakpoint
DROP TABLE IF EXISTS recent_repos;
```

- `space_kind ∈ {'local','remote','scratch','internal'}`：`'local'` 仅存量；**internal 回填按 fusion 内建工作流精确收窄 + 排除 `workgroup_id` 非空**（F4-r3：裸 `builtin=1` 会把 `__workgroup_host__` 任务误标 internal，与正文矛盾）；新 fusion 任务由 `internalSource` 写入。backfill 逐仓判定混合多仓（F20）。0085 硬编码 `aw-skill-fusion` 字面值（SQL 无法导入 TS 常量），migration 测试锁其与权威常量一致（§15）。
- **GC 两阶段墓碑（R3-1）**：`workspace_pruning_at`（认领戳）+ `workspace_pruned_at`（删除完成戳）。GC：① 条件 UPDATE 认领（`WHERE 终态 AND pruning IS NULL AND pruned IS NULL`）；② 删除目录（多仓逐 `task_repos` 删 worktree/快照 ref、最后删父容器）；③ 成功后写 `pruned_at`。删除失败/进程崩溃 ⇒ `pruning_at` 非空但 `pruned_at` 空：**超时 lease（如 30min）后 GC 可重认领续删**（沿现状「失败下轮重试」语义，`gc.ts:74`），不形成永久墓碑。
- **复活路径统一 CAS 条件（R3-2）**：resume / retry / **sync-workflow（复用 `resumeKick` 且现无 worktree preflight，`task.ts:1277, 1681`）** 及 lifecycle repair 的全部 revive 路径，状态 CAS 一律加 `AND workspace_pruning_at IS NULL AND workspace_pruned_at IS NULL`；pruned=410、pruning=409「回收中」。revive 调用点实现期逐一盘点入测试（§11.5）。**存量已回收行 reconcile（R3-2-r4）**：升级前旧 GC 删目录不写任何戳（`gc.ts:49`）——0085 后、HTTP serve 前一次性 reconcile：终态行工作目录缺失 ⇒ 补写 `workspace_pruned_at`；revive 入口另保留 FS preflight 兜底（目录缺失 ⇒ 原子补墓碑 + 410）。**物化失败落 failed 行时**（§3 tagged 失败臂）同事务原子写 `workspace_pruned_at`——失败行无可复活工作区，堵 retry 无 preflight 即 CAS pending（`task.ts:1810`）与 sync 仅查空串（`task.ts:1587`）的旁路。
- `recent_repos` 退役含 shared DTO/导出/前端 client（F7）。
- 迁移带 `--> statement-breakpoint`；journal 锁随 0085/0086 各 +1。
- `task_repos` 不改表结构：scratch 单行 `{repoIndex:0, repoPath:scratchDir, repoUrl:NULL, baseBranch:'main'}`。

## §2 wire 契约 v2（破坏性收敛）

`StartTaskSchema`（`packages/shared/src/schemas/task.ts:279-429`）：

- **删除（公开 wire）**：`repoPath`、顶层 `baseBranch`、`fetchBeforeLaunch`（URL 新鲜度由 `fetchOnReuse ?? true` + RFC-068 FF 保证）。
- **新增**：`scratch: z.boolean().optional()`；`StartTaskRepo` 行 url-only `{ repoUrl, ref? }`；superRefine 互斥同前版。
- **raw-key 拒收（F1）**：`rejectRetiredStartTaskKeys(raw)` 在 parse 前递归拒绝三退役键（顶层+`repos[]`），挂载全部公开入口（三 launch + scheduled create/update/fire/run-now + multipart）。
- **共享空间组装器（F2）**：`applySpaceFields(candidate, body)`；`StartWorkgroupTaskSchema` 同步收敛。
- **内部启动面（F4）**：`StartTaskDeps.internalSource?: { kind:'local-path'; repoPath; baseBranch }`（deps 层，wire 不可达）；与公开空间字段**互斥**（断言）；**可单独使用**（服务层按原 path 物化路径收内建 worktree）**或与 `preCreatedWorktree` 组合**（此时 repoPath 必须一致，断言）；落库 `space_kind='internal'`。fusion 两条链迁移，行为不变。
- `TaskSchema`/`TaskSummarySchema` 增 `spaceKind`、`sourceAgentName`；`gitUserName/Email` 在 scratch 下允许。

## §3 临时空间（scratch）模型

**统一物化协议（F3-r3：多仓形状 + lease token）**：

```
MaterializeSpaceResult =
  | { ok: true; kind: 'remote'|'scratch'; taskId: string;
      canonicalWorktreePath: string;                 // 单仓/scratch=自身；多仓=父容器
      repos: MaterializedRepo[];                     // 逐仓 { repoIndex, repoUrl|null, repoPath(镜像/scratch),
                                                     //        worktreePath, branch, baseCommit, submodules? }
      lease: MaterializeLease }                      // 见下，由外层 launch 流程显式释放
  | { ok: false; taskId: string; failedStage: 'resolve'|'materialize'|'upload';
      partial: MaterializedRepo[];                   // 已物化部分（清理责任=物化层，本臂返回前已清）
      earlyError: TaskEarlyError }
```

- 成功臂直接交 `startTask`（替代 multipart 的 `preCreatedWorktree`+`preResolvedSource` 双参并列，`routes/tasks.ts:922-941`）；失败臂只落一次 failed 行，不再二次 resolve/materialize（现状 `routes/tasks.ts:893-907`）。**多仓部分失败**：失败臂携带 `partial` 且返回前完成清理，测试逐仓断言。
- **lease 归属（F9-r3）**：`materializingSpaces` 登记在 `mkdir` 前，**由外层 launch 流程 try/finally 持有**——成功臂的 `lease` 跨越 upload 与 `startTask` insert，落行后（或最终失败清理后）显式释放；孤儿扫描排除活跃 lease + 年龄阈值（≥24h）双保险；交错测试 materialize→scan→upload→insert。

物化细节：`scratchDir={appHome}/scratch/{taskId}`；`git init -b main` + 空根提交（**AW_INTERNAL_GIT_IDENTITY 模式注入身份**，N2；body git 身份可覆盖）；tasks 行 `repo_path=worktree_path=scratchDir`、`base_branch='main'`、base commit=根提交。

行为面：

- **回滚/重试**：canonical→iso→merge-back（RFC-130；`pre_snapshot` 已退役）。
- **产出契约**：Git 可见且非 `.gitignore`；截断口径 1,048,576 UTF-16 code units 带标记（沿现状）。
- **GC**：扫描 `space_kind='scratch'` 终态（阈值仅 `olderThanDays`）；删除走 §1 两阶段墓碑；**GC candidate 显式排除 `space_kind='internal'`（R3-4：fusion approval 目录保留承诺落到谓词）**，`local`/`remote`/`scratch` 可清理；fusion 终态任务目录保留测试。**iso GC 纳入同一认领（D1）**：`runIsoWorktreeGc` 现状快照终态后不重读不认领即删 `iso/{taskId}`（`gc.ts:132,143`；canonical GC disabled 时 ticker 仍跑 iso GC，`gc.ts:183`）——task-owned iso 容器删除前走同一 per-task pruning claim（或仅处理无 task 行/已 pruned 任务）；交错测试 query→revive→新 iso→旧 GC 不误删。**多仓 `onlyMerged` 语义（D3）**：remote/local 多仓须**所有** `task_repos` 均 merged 才可认领（现只查顶层 repo0 镜像列，`gc.ts:67`、`task.ts:757`——维持现状=多仓永久跳过或误删未合并仓）；scratch 忽略 `onlyMerged` 仅年龄阈值；「repo0 merged + repo1 unmerged 不删」测试。
- **失败/取消**：目录保留供 diff/resume/retry；pruning/pruned 后按 §1 语义。
- 禁用面/upload/files-git 选择器回退同前版。

## §4 单 Agent 启动路径

- `AGENT_HOST_WORKFLOW_ID = '00000000000000AGENTHOST00'`、`__agent_host__` 懒播种（onConflictDoNothing）。
- 合成快照 `buildAgentHostSnapshot(agentName, allowClarify)`：input(description) + agent-single(promptTemplate `{{description}}`) + `allowClarify` 时 clarify 节点（`sessionMode:'isolated'`, **`clarifyMode:'optional'`**）+ `buildClarifyEdges`；`$schema_version: 4`、`outputs: []`。描述经端口注入防 `{{}}` 再解析。
- **前置校验（F14 + R3-3）**：`buildWorkflowValidationContext(db)`（agents+skills+**plugins 全量**）；`startAgentTask` 副作用前 parse+`validateWorkflowDef(ctx)`。**该 helper 同 PR 替换全部生产 caller**——JSON launch（`task.ts:613`）、multipart（`routes/tasks.ts:835`）、sync apply/preview（`task.ts:1607, 1758`）现都只传 agents+skills、静默跳过插件校验（R3-3），与 picker 投影一并统一；一致性锁测试。负例矩阵：aggregator / missing skill / missing/disabled plugin（含 dependsOn 闭包）。
- **反问语义（F12-r3：指令联合全链）**：`'optional'` 进入 **`ClarifyChannel.directive` 联合**（现 `mandatory|suppressed`，定义在 `prompt.ts:145` 的 enforcement 通道——**公开回答契约 `schemas/clarify.ts` 的 `continue|stop` 不动**，并加锁 `SubmitClarifyAnswersSchema` 拒收 `optional`，D2）——不是布尔投影：runner 对 channel 的 `clarifyMandatory` 布尔化（`runner.ts:452, 639`）改为透传完整 directive，follow-up renderer（`prompt.ts:859`）对 optional 保持**双 envelope**（含 same-session 信封纠错轮：missing/malformed/both-present 后仍可二选一）。优先级 `stopped > optional > mandatory/suppressed`；initial/retry/答复 rerun（答复默认 `directive='continue'` 不得把 optional 恢复成 mandatory，`clarifyRounds.ts:48-64`）恒 optional。**兼容缺省（R3-5）**：`clarifyMode===undefined` ⇒ 既有 mandatory/suppressed 语义不变（additive 字段先例 `workflow.ts:292`）+ 兼容测试；scheduler 现有局部变量 `clarifyMode`（self|cross，`scheduler.ts:2467`）改名 `channelKind` 避撞。
- `StartAgentTaskSchema`：`name`、`description`（1..65536）、`allowClarify?`（default true）+ 空间/协作者/git 身份/上限字段。
- `startAgentTask`：① `canViewResource` 404 同形；② `assertNotBuiltin('agent')`（F16）；③ 合成+前置校验；④ `applySpaceFields` → parse → `startTask(..., { agentLaunch })`；⑤ **insert 事务内重检 agent 存在（F17）**。
- **事务机制钉死（F17-r3）**：涉事务处一律 **`dbTxSync`**（仓库唯一合法事务原语——async 事务在首个 await 提前提交，`db/txSync.ts:1`；`getAgent` 是 async，`agent.ts:22`，事务内改用同步 `.get/.all/.run`）：agent 重检 + task/taskRepos/协作者插入收拢单事务（现状多段 await，`task.ts:868+`）；rename/delete 守卫检查+写入同一 `dbTxSync`。**accepted limitation（显式记录）**：终态任务的 retry **与 resume** 遇 agent 已删 → 既有 agent-not-found 失败语义（与 164 成员软引用同哲学；「任务冻结 agent 配置」另立 RFC）。
- **权限门（F15）**：`POST /api/agents/:name/tasks` 脱离 `agents:write` 中间件、单挂 `tasks:launch`；三 launch endpoint 一致性 + PAT 矩阵。
- **生命周期守卫（F13-r3 终版）**：`agent` 宿主任务放行 resume + node retry（真实 DAG，generic 语义成立，测试断言重跑发生）；**`workgroup` 宿主任务 resume 与 node retry 均维持 403**（本 RFC 显式测试锁；解锁待 164 定义 engine-specific 恢复）；fusion builtin 403；宿主 sync 统一 422。**lifecycle repair 旁路同规（F13-r4）**：repair 成功后直接调 generic `resumeTask`（`lifecycleRepair.ts:298`）、S4 可 auto-apply（`options-S4.ts:18`），而工作组现仅豁免 S1/S2（`stuckTaskDetector.ts:313`）——repair 列表/apply/auto-repair 对 workgroup 任务隐藏并拒绝所有 `resumeAfterApply`/DAG 节点复活类选项（S3/S4/S5 对其豁免或选项过滤）；引擎认可的内部 continuation（如 clarify-answer 唤醒）不受影响。**boot auto-resume 同规（r5）**：启动 orphan reap 把 pending/running 置 interrupted（`orphans.ts:42`）后，`autoResumeInterruptedTasks` 现状不筛 kind 即调 generic `resumeTask`（`autoResume.ts:60`、`cli/start.ts:463`）——候选查询排除 workgroup 任务；在 164 定义 engine re-entry 之前，workgroup 任务 daemon 重启后停留 `interrupted`（已知限制，§12）。
- readonly agent 允许启动。

## §5 执行主体判别与展示

`taskExecutionKind` 单点派生；任务列表「来源」列 + `space_kind` 次要呈现（`local`=「本地(已下线)」、`internal`=「内部」）；再次启动按 kind 深链（v1 只预填主体）。

## §6 启动 endpoint × body builder 矩阵（RFC-125 锁）

同前版：三 endpoint × 三显式 builder（`buildLaunchBody` v2 / `buildAgentLaunchBody` / `buildWorkgroupLaunchBody`）+ `stampLaunchExtras`/`stampSpace` + 每 builder 字段显式断言；「存为定时任务」复用 builder 产物 + kind 封套；`bodyToRepoSources` v2 与 path builder 删除随 PR-1。

## §7 前端：Stepper 原语 + `/tasks/new` 四步向导

同前版（Stepper 原语 / 四步 / 三分支内容 / 高级折叠 / Step4 双按钮与 `?schedule=1` 主次互换 / 深链与 `editScheduled` 三 kind / gating / i18n）；Step 1 的 agents 过滤复用 §4 统一校验 ctx 投影。

## §8 入口全集与旧面下线

同前版（首页 / `/tasks` / `/scheduled`+徽标 / 编辑器 / 任务详情 / 定时详情 / agents 详情+列表行 / workgroups 详情 / redirect / PR-3 删整页）。**部署可用性（F6，已闭合）**：PR-1 完成旧 launcher URL-only retrofit（recent import/query/种子、path 分支、`RepoSourceTabs`、`buildLaunchFormData.ts`、`bodyToRepoSources` v2 全随 PR-1）+ PR-1 出口冒烟（前端 build、URL JSON/upload 启动、legacy schedule 修复链）。

## §9 存量迁移：scheduled payload 启动期 backfill

**时点**：DB open → heal → HTTP serve → ticker（`cli/start.ts:309-348, 440-446`）。

**策略：path → `file://` 保真改写**，工程细节（F19-r3 修订）：

1. URL 构造 `pathToFileURL(realpath(path))`（空格/Unicode/`#`/`%`）；`parseGitUrl` file 分支的百分号解码兼容 T4 内核验补齐。
2. **file cache key dual-read + 校验后 lazy rekey（F19-r4：file:// 缓存早已存在**，`git-url.ts:47,183-192`、`gitRepoCache.ts:315`——直接改 key 规则会重复 clone/遗留旧行）：新规范（保留大小写与 `.git`）未命中时回退旧 key 查询；旧 key 是 lossy 的（lowercase+剥 `.git`）会碰撞（`/Foo` vs `/foo`、`repo` vs `repo.git`）——**rekey 前必须复核 `newKey(parse(row.url)) === requestedNewKey`**，不一致视为 miss 走新 clone；rekey 在 old/new 两把 `withUrlLock` 下 CAS 更新 **`url_hash`（`cached_repos` 无 slug 列，`schema.ts:616`；`local_path` 目录不动）**；测试覆盖命中/碰撞不误认/迁移/不重复 clone。
3. **file 源权威解析**：请求 ref 以**源仓当次 rev-parse 结果为权威**——cold/warm 都把 ref 解析到 remote-tracking（cold 补 syncBranches 同款 FF）；**file scheme 下** fetch 失败、或源分支已删（`syncBranchToRemote` 现仅 warning 留 stale 本地分支，`gitRepoCache.ts:218`）→ **硬 fail**，不得以 stale 镜像启动。其它 scheme 维持现状 warning。
4. **`fetchBeforeLaunch` 存量行不静默删（F19-r3）**：`fetchBeforeLaunch:true` 的行语义（启动前刷新本地仓的 `origin/*`，`task-fetch-before-launch.test.ts:123`）在 file:// 转换后**不等价**（镜像只 fetch 本地仓自身）——该类行**禁用 + `lastError='rfc165-fetch-semantic-review'`**，编辑页提示改选 origin URL 或确认 file:// 后重存；`false`/缺省行自动转换（转换时移除该键）。
5. 目录缺失/非 git → 禁用 + `lastError='rfc165-local-path-retired'`；幂等；谓词按 payload 内容。

**读写分离（F18 + N3-r3：逐字段 degraded）**：row mapper 对 `launchPayload` 与 `scheduleSpec` **各自**逐行 try/catch + safeParse——每列三态：`ok(值)` / `legacy(migrationNeeded)` / `degraded(null + migrationError)`（覆盖坏 JSON **与「JSON 合法但 shape 不识别」**两类）；DTO 为逐字段 discriminated（`schemas/scheduledTask.ts:62-68` 双列必合法的钉死解开）。**raw PUT 修复路径不依赖完整 parsed row**：PUT 以 raw body 全量校验后整行重写（degraded 行同样可修可删）。

**UI**：详情 `lastError` + 列表错误/迁移徽标；编辑遇禁用/degraded 行修复横幅。

## §9b 定时任务三主体扩展（launch_kind，D11 / migration 0086）

- 0086：`launch_kind text NOT NULL DEFAULT 'workflow'`；journal +1。
- payload 封套与 `scheduledPayloadSchemaFor(kind)`（save/edit/fire/run-now 四处）；保存轻校验/触发全量校验；`scheduleLaunch.ts` 工厂按 kind 分派（owner actor）。
- **权限（N1-r3 完整规则）**：要求 `tasks:launch` 的操作=create / payload 更新 / enable / **enabled 态下的 `scheduleSpec` 变更**（窄 PAT 把低频改每分钟同属委托扩权，`schemas/scheduledTask.ts:90`、`routes/scheduledTasks.ts:82`）/ run-now；放行=disabled 态 spec-only、disable、delete、仅改名。PAT 矩阵测试逐操作。
- **失败语义**：自动 fire 计数+阈值禁用（现状）；run-now 不动 cadence 记账（现状）。两条分锁。
- 工作组/agent 配置每次触发时冻结；kind 不可变（PUT 422）。
- 取代 164 design.md:504-505 排除（§12）。

## §10 失败模式

| 场景                                     | 行为                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| 物化失败（任一阶段/多仓部分失败）        | tagged 失败臂：`failedStage`+`partial`，物化层清理后单次落 failed 行。                   |
| 长上传/insert 前崩溃孤儿                 | 外层 lease 排除活跃流程；孤儿扫描按年龄阈值。                                            |
| GC 认领后删除失败/崩溃                   | 两阶段墓碑：`pruning` 超时 lease 重认领续删；不形成永久 410。                            |
| GC 与 resume/retry/sync 竞态             | 认领条件 UPDATE + 全部 revive 路径 CAS 带 pruning/pruned 条件；pruned=410、pruning=409。 |
| 混合新旧 body                            | raw-key 拒收 422。                                                                       |
| 提交时对象被删/失去可见性                | 404/403/422 冒泡 Step 4；insert 事务内重检 agent。                                       |
| `file://` 源目录/源分支删除、fetch 失败  | file scheme 硬 fail（不跑 stale）；其它 scheme 维持 warning 现状。                       |
| `fetchBeforeLaunch:true` 存量定时行      | 禁用 + 语义确认提示（不静默转换）。                                                      |
| scheduled legacy / 坏 JSON / 坏 shape 行 | 逐字段 degraded DTO；raw PUT 可修、可删，不炸列表。                                      |
| 自动 fire 失败 / run-now 失败            | 前者计数+阈值禁用；后者仅返回错误。                                                      |
| kind 与 payload 形不符                   | 保存/编辑挡；fire 前复验失败 → `lastError`。                                             |
| 宿主任务 resume/retry/sync               | agent：resume+node retry 放行；workgroup：**均 403**（锁）；sync 统一 422。              |
| agent 中途被删（终态任务 retry/resume）  | 既有 agent-not-found 失败语义（accepted limitation）。                                   |

## §11 测试策略（必写清单，PR 全绿才算交付）

**shared/backend**

1. `StartTaskSchema` v2 superRefine 表驱动；`StartWorkgroupTaskSchema` 同步形。
2. raw-key 拒收：混合体全公开入口 422。
3. scratch 物化：init+根提交（隔离 HOME 断言身份）+diff 契约案例（截断/ignored/binary）+iso/merge-back。
4. `materializeSpace`：resolve/materialize 恰一次；失败单次落行；**多仓部分失败逐仓断言 + `partial` 清理**；scratch+upload 成功/失败；**外层 lease 跨 upload/insert 持有**、孤儿扫描交错。
5. GC：两阶段墓碑（认领→删除失败→超时重认领续删；成功写 pruned）；**revive 全路径 CAS**（resume/retry/**sync**/lifecycle repair 盘点清单）竞态两向（GC 赢=410/409、revive 赢=目录保留）；**internal 任务不入 GC candidate（fusion 目录保留）**；**iso GC 同认领交错测试（query→revive→新 iso→旧 GC 不误删，D1）**；**多仓 onlyMerged 全仓判定（repo0 merged + repo1 unmerged 不删，D3）**；**legacy 双 NULL 行 startup reconcile + 物化失败行原子补墓碑后 retry/sync 均 410（R3-2-r4）**。
6. 工作组 × 空间三态（服务层 + HTTP 层）。
7. fusion 回归：`internalSource`（单独/组合 preCreatedWorktree 两态 + 路径一致断言 + 互斥断言）+ `space_kind='internal'` 落库 + 审批目录保留。
8. `buildAgentHostSnapshot` 形状锁 + `validateWorkflowDef(ctx).ok` + 负例矩阵；**统一 ctx 替换全部生产 caller 的一致性锁（JSON/multipart/sync preview/apply/picker 同判定，R3-3）**。
9. `POST /api/agents/:name/tasks` 全链 + ACL/builtin/PAT 矩阵 + insert 事务内重检（检查后删除→422+清理；`dbTxSync` 同步断言）。
10. optional clarify：**directive 联合含 'optional' 全链透传**（runner 不布尔化、follow-up renderer 双 envelope——含信封纠错轮三态）；四向状态机；`clarifyMode===undefined` 兼容缺省锁；`channelKind` 改名后无残留歧义；**`SubmitClarifyAnswersSchema` 拒收 'optional' 锁（公开回答契约不扩，D2）**。
11. 生命周期守卫：agent 宿主 resume+node retry 真重跑；**workgroup 宿主 resume 与 node retry 均 403 锁**；**lifecycle repair 对 workgroup 任务无 `resumeAfterApply`/节点复活选项（列表过滤 + apply 拒绝 + S4 auto 跳过，F13-r4）**；**boot reap→auto-resume 对 workgroup 任务不调 `resumeTask`（候选排除锁，r5）**；fusion 403；宿主 sync 422。
12. agent rename/delete：非终态引用 409（`dbTxSync` 闭包）；终态可删；终态 retry/resume 遇删=agent-not-found（accepted 语义锁）。
13. `taskExecutionKind` 表驱动。
14. backfill：`pathToFileURL` 改写（空格/Unicode/未推送非默认分支冷启动）；**file cache key dual-read/校验后 rekey（碰撞不误认、不重复 clone）**；file 源删除/源分支删除硬 fail；**`fetchBeforeLaunch:true` 行禁用+语义提示、false 行转换**；目录缺失禁用；幂等；多仓部分失败不半改。
15. scheduled tolerant read：legacy/坏 JSON/坏 shape **逐字段三态**；raw PUT 修复不依赖 parsed row；DELETE；healer 在 HTTP serve 前。
16. 定时分派：自动 fire 三 kind + 阈值两态；run-now 三 kind 不动 cadence（分锁）。
17. 定时封套三 kind 正反例；kind≠payload 422；PUT 改 kind 422；**`tasks:launch` 逐操作矩阵（含 enabled 态 spec-only 变更 gate、disabled 态放行、re-enable gate）**。
18. migration 0085：journal bump；backfill（local/remote/**internal 收窄谓词——workgroup 宿主任务不落 internal**/混合多仓）；两墓碑列存在。
19. migration 0086：journal bump；存量 `launch_kind='workflow'`。
20. banned 锁（精确 allowlist）：**三键 `repoPath`/`baseBranch`/`fetchBeforeLaunch`**，锁定对象=公开 request schema **属性**、launch handler 的 body/raw 解析段、前端 request builders（符号/锚级断言，非整文件零命中——`routes/tasks.ts:130,881` 等内部合法使用出锁）。

**frontend（vitest）**

21. `Stepper` 单测。22. 向导三分支/gating/确认页/回跳/Step1 过滤。23. 三 builder 字段显式断言 + `stampSpace` + 定时封套。24. `bodyToRepoSources` v2 往返 + legacy 修复横幅（PR-1）。25. 深链三 kind + `editScheduled` 反填 + `?schedule=1` 主次互换。26. 源码文本兜底锁（分 PR-1/PR-3 两期）。27. PR-1 出口冒烟（build + URL JSON/upload + legacy 修复链）。

**e2e（Playwright）**

28. 三方式创建链到终态（file:// fixture / scratch+agent→done→diff / workgroup→终态）。29. 定时创建链（agent 定时）。30. 视觉自查（不动基线）。

## §12 与 RFC-164 的协调

- T22 标 Superseded；164 design.md:504-505 定时排除由 D11 取代（一起代改标注）。
- **工作组宿主任务的 resume/node retry/lifecycle repair 复活/boot auto-resume 在本 RFC 均维持拒绝**（F13 终版）：解锁需 164 定义 engine-specific 恢复（host 行/assignment/gate/cursor 重置矩阵），另立任务；本 RFC 只交付 kind 感知守卫框架 + agent 分支放行。**已知限制**：在此之前 workgroup 任务 daemon 重启后停留 `interrupted`，需手动等 164 恢复能力（与 164 session 对齐记录）。
- 实现顺序：排在 164 PR-3 提交之后；commit 前核对并发 hunk 引用闭包。
- 向导 Step 1 surface 164 守卫；PR-5 后删前端拦截文案。

## §13 影响面/耦合点清单

- **shared**：`schemas/task.ts`（契约 v2 + raw-key + 增列 + `taskExecutionKind`）、`schemas/workgroup.ts`、`StartAgentTaskSchema`+`scheduledPayloadSchemaFor`（新）、`schemas/scheduledTask.ts`（逐字段 degraded DTO）、`schemas/workflow.ts`（clarify `clarifyMode` + 缺省规则）、`prompt.ts` 的 `ClarifyChannel.directive` 联合 +'optional'（**`schemas/clarify.ts` 公开回答契约 `continue|stop` 不动**，D2）、`schemas/repo.ts`+`shared/index.ts`（退役）、`git-url.ts`（file 编码/key 规范 dual-read 配套）、`prompt.ts`（optional 双 envelope + follow-up renderer）。
- **backend**：`services/task.ts`（materializeSpace + lease + internalSource + 两墓碑 CAS + `dbTxSync` 收拢 insert）、新 `services/agentLaunch.ts`、`services/fusion.ts`、`services/repo.ts`/`routes/repos.ts`、`routes/tasks.ts`（multipart 协议 + 守卫 + raw-key）、`routes/agents.ts`、`server.ts`/`auth/permissions.ts`（launch + scheduled gate）、`services/agent.ts`（守卫 `dbTxSync`）、`services/gc.ts`（scratch + 两阶段 + internal 排除 + 多仓逐仓删）、`services/scheduledTasks.ts`+`scheduleLaunch.ts`+`routes/scheduledTasks.ts`、`services/clarifyRounds.ts`+`services/scheduler.ts`（`channelKind` 改名）+`services/runner.ts`（directive 透传）、`services/autoResume.ts`+`services/lifecycleRepair*`（workgroup 复活排除）、`services/gitRepoCache.ts`（dual-read/rekey + cold syncBranches + file 硬 fail）、`cli/start.ts`、`db/schema.ts`+0085/0086、`util/git.ts`。
- **frontend**：同前版（Stepper/tasks.new/旧 launcher PR-1 retrofit→PR-3 删/launch 库/ScheduleDialog/入口九处/Homepage/scheduled/router/styles/i18n）。
- **不动**：workgroup 引擎内部、ACL 资源模型（只加 endpoint gate）。

## §14 设计门记录（Codex adversarial review，2026-07-10）

**第一轮**：NOT-CLEAN，25 findings（10h/9m/6l），全折（F1–F25）。

**第二轮**：13 closed / 12 open + 4 新增（N1–N4），全折（见各节 `-r2` 标注）。

**第三轮**：6 closed（F6/F8/F14/F21/N2/N4）/ 10 open + 5 新增，本版逐条折算：

| #    | sev  | 三轮判定 → 本版处置                                                                                                                                                |
| ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F3   | high | §3 成功臂改多仓形状（`canonicalWorktreePath`+`repos: MaterializedRepo[]`+lease）、失败臂带 `failedStage`/`partial` + §11.4 部分失败测试                            |
| F4   | high | §1 SQL 收窄：fusion 内建工作流名精确匹配 + 排除 `workgroup_id` 非空；§2 明确 internalSource 可单独或组合 preCreatedWorktree（路径一致断言）+ §11.7/.18             |
| F9   | med  | §3 lease 由外层 launch try/finally 持有、成功臂携带跨 upload/insert 的 lease + §11.4                                                                               |
| F12  | med  | §4 `'optional'` 进 `ClarifyChannel.directive` 联合、runner 去布尔化透传、follow-up renderer 双 envelope（含信封纠错轮）+ §11.10                                    |
| F13  | high | §0/§4/§12 终版收窄：**workgroup 宿主 resume 与 node retry 均维持 403**（解锁待 164 engine-specific 恢复）；agent 分支放行 + §11.11                                 |
| F17  | med  | §4 事务机制钉死 `dbTxSync`（同步 `.get/.all/.run`；insert 收拢单事务）+ accepted limitation 措辞含 resume + §11.9/.12                                              |
| F19  | high | §9 file cache key dual-read/lazy rekey（file 缓存早已存在）；file 源 ref 权威解析+源分支删除硬 fail；**`fetchBeforeLaunch:true` 行禁用+语义提示不静默删** + §11.14 |
| F22  | med  | §11.20 三键 allowlist（补 `baseBranch`）+ 符号/锚级断言（非整文件零命中）                                                                                          |
| N1   | high | §0/§9b 完整规则：enabled 态 `scheduleSpec` 变更亦 gate；disabled spec-only/disable/delete/改名放行；re-enable gate + §11.17                                        |
| N3   | med  | §9 逐字段三态 degraded DTO（launchPayload 与 scheduleSpec 各自；覆盖坏 shape）+ raw PUT 修复 + §11.15                                                              |
| R3-1 | high | §1 两阶段墓碑 `workspace_pruning_at`/`workspace_pruned_at` + 超时 lease 重认领 + 多仓逐仓删 + §11.5                                                                |
| R3-2 | high | §1 revive 全路径（resume/retry/**sync**/lifecycle repair）统一 CAS 条件 + 调用点盘点入测试 §11.5                                                                   |
| R3-3 | med  | §4 统一校验 ctx 替换全部生产 caller（JSON/multipart/sync apply/preview）+ 一致性锁 §11.8                                                                           |
| R3-4 | med  | §3 GC candidate 显式排除 `internal` + fusion 目录保留测试 §11.5                                                                                                    |
| R3-5 | low  | §4 `clarifyMode===undefined` 兼容缺省 + scheduler 局部变量改名 `channelKind` + 兼容测试（Codex 认可可带实现期，已提前折算）                                        |

**第四轮**：12 closed（F3/F4/F9/F12/F17/F22/N1/N3/R3-1/R3-3/R3-4/R3-5）/ 3 open + 3 新增（D1–D3）+ 6 条 IMPLEMENTATION-NOTE（明确不阻断设计门，汇总 §15）。本版逐条折算：

| #    | sev  | 四轮判定 → 本版处置                                                                                                                                                                                             |
| ---- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F13  | high | §4 lifecycle repair 旁路同规：repair 列表/apply/auto 对 workgroup 拒绝 `resumeAfterApply`/节点复活选项（S3/S4/S5 豁免或过滤；`lifecycleRepair.ts:298`、`options-S4.ts:18`、`stuckTaskDetector.ts:313`）+ §11.11 |
| R3-2 | high | §1 legacy 双 NULL 行 HTTP serve 前 startup reconcile + revive FS preflight 兜底补墓碑 + 物化失败落 failed 行同事务写 `workspace_pruned_at` + §11.5                                                              |
| F19  | med  | §9.2 旧 key lossy 碰撞：rekey 前复核原 url 的新 key 一致，old/new 双锁 CAS，仅更新 `url_hash`（无 slug 列勘误）+ §11.14                                                                                         |
| D1   | high | §3 iso GC 纳入同一 per-task pruning claim（或仅处理无行/已 pruned）+ 交错测试 §11.5                                                                                                                             |
| D2   | med  | §4/§13 勘误：directive 联合在 `prompt.ts` 的 `ClarifyChannel`；`schemas/clarify.ts` 公开回答契约不动 + `SubmitClarifyAnswersSchema` 拒收锁 §11.10                                                               |
| D3   | med  | §3 多仓 `onlyMerged` 全仓判定（scratch 忽略）+ §11.5                                                                                                                                                            |

**第五轮**：指定 6 项 **6/6 CLOSED**；一致性复扫新增 1 high——**boot auto-resume 旁路**（orphan reap→`autoResumeInterruptedTasks` 不筛 kind 即 generic `resumeTask`，`orphans.ts:42`、`autoResume.ts:60`、`cli/start.ts:463`）→ 本版折算：候选排除 workgroup + §11.11 锁 + §12 已知限制（重启后停 interrupted 待 164）。

**第六轮（终验）**：boot auto-resume 旁路 **CLOSED**（候选按持久化 `workgroup_id` 排除，字段与写入点已核实 `schema.ts:733`、`task.ts:913`）；一致性复扫无新的必回文档缺陷——工作组的手工 resume / node retry / lifecycle repair 复活 / boot auto-resume 保持同一拒绝边界。**总结论：CLEAN-WITH-IMPLEMENTATION-NOTES，设计门通过**（仅保留 §15 六条实现期备注）。

## §15 实现期备注（设计门 IMPLEMENTATION-NOTE 汇总，不再扩写方案、按此执行）

1. **N1 原子判权**：无 `tasks:launch` 的 spec-only 更新须在写入瞬间保证 `enabled=0`（`WHERE enabled=0` CAS 或 `dbTxSync` 内重读+判权+写入）；并发 enable×spec-update 测试。
2. **N3 修复分支**：健康行保留 strict-partial PUT；degraded 行走 raw-row full-repair；鉴权/删除/disable/name-only 只读普通列，不解析坏 JSON。
3. **F3/F9 清理细节**：lease/孤儿扫描覆盖 remote 与 scratch；scratch 的 `repoPath===worktreePath` 不能用 `git worktree remove`（`util/git.ts:993`），按 kind 幂等递归删除；`MaterializedRepo` 保留 `worktreeDirName` 与完整 submodule telemetry。
4. **R3-1 重认领**：超时续删允许逐仓路径已不存在；claim token/CAS finalize；每仓同时清理 snapshot ref 与 iso ref。
5. **F4 迁移字面值**：0085 硬编码 `aw-skill-fusion`；migration 测试锁与权威常量（`systemResources.ts`）一致。
6. **F12/F17 事务边界**：optional 双 envelope 同时改 initial full prompt 与 follow-up renderer；昂贵校验/广播/scheduler kick 留在 `dbTxSync` 外，事务内仅同步重检与写入。
