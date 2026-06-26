# RFC-108 — 技术设计

> 读前置：`proposal.md`（产品视角 + 决策登记 D1–D6）。本文给接口契约、数据流、耦合点、失败模式、测试策略。
> 证据 file:line 相对仓库根，来自本 RFC 专项 10 路并行恢复审计的回源核实（与 `design/arch-audit-2026-06-23/01-task-lifecycle.md` 交叉印证）。

## 1. 现状全景（调研结论）

### 1.1 检测半（成熟，CAS 守卫，测试齐备）

| 机制                          | 触发                                                            | 行为                                                                                                                                                                   | 证据                                                                      |
| ----------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 启动孤儿回收 `reapOrphanRuns` | 启动一次（HTTP listener 之前）                                  | running/pending 的 task+node_run CAS 翻 `interrupted`（`errorSummary='daemon-restart'`）；`killStaleRunProcessTree` 在翻之前组杀仍活子进程（pid+48h窗口+ps命令形状门） | `orphans.ts:32-104`、`start.ts:135`                                       |
| 卡死探测 S1–S5                | 每 5min，30min 静默门（S4 pending 5min）                        | S1 awaiting_review 无 pending dv；S2 awaiting_human 无 open clarify_session；S3 running 全终态；S4 pending>5min；S5 running 有活节点但 events 停                       | `stuckTaskDetector.ts:205-329,457-477`；模块注释 `:26-28`「does not fix」 |
| 不变式扫描 R/T/U/C/CR         | 启动 ~5s {全量} + 每 1h {since now-2h}，24h warning→error grace | 结构一致性；**CR-1 是唯一自动 reconcile**（陈旧 cross-clarify 轮翻 `abandoned`，确定性终态触发 + 幂等）                                                                | `lifecycleInvariants.ts:706-819`；CR-1 `:483-564`                         |
| per-node 硬超时               | spawn 时 `setTimeout(timeoutMs)`，触发一次                      | SIGTERM→grace→SIGKILL 组杀 + reap deadline；判 `node-timeout`                                                                                                          | `runner.ts:824-830,1053`                                                  |
| 资源限额 ticker               | 每 1s                                                           | `elapsed>maxDurationMs` 或 `sum(tok_total)>maxTotalTokens` → `cancelTask`                                                                                              | `limits.ts:5-103`                                                         |
| 优雅关闭 survivor flip        | SIGTERM/SIGINT，30s 预算                                        | abort 所有 controller，poll 30s，survivor CAS 翻 `interrupted`                                                                                                         | `shutdown.ts:22-54`                                                       |
| snapshot-lost 升级            | resume/retry 回滚遇 `pre_snapshot` 被 gc-prune                  | `gitCommitExists` 前检；缺失则 `escalateSnapshotLost` CAS pending→failed + 409                                                                                         | `task.ts:961-993`                                                         |

### 1.2 修复半（成熟但纯人工）

- **RFC-057 修复引擎** `lifecycleRepair.ts:120-349`：13 规则 × ~24 typed 选项（每选项 `preflight`+`apply`+`risk`+`destructive`），re-preflight drift-guard，append-only `lifecycle_repair_audit`，可选 `resumeAfterApply`。**唯一调用方 = `routes/tasks.ts:463`（人工 POST `/repair` + `confirm:true`）**。
- **`resumeTask`** `task.ts:1053-1185`：CAS 所有权锁（pending）**先于**任何 git 副作用（幂等）、stale-child kill、per-node `pre_snapshot` 回滚。LIFE-05/06 已由 RFC-103 修复。**可被任何 auto-resume 整段复用**。
- **scheduler revival 已就绪**：`dispatchFrontier.isDispatchable` 对 interrupted/canceled 返回 dispatchable，`schedulerMintCause` 给 `'revival'` cause——**自动续跑唯一缺的就是「有人在 boot 调 `resumeTask()`」**。

### 1.3 一句话

DETECT 半与 FIX 半都接近成熟，但**永不闭合成 loop**：唯二真正的自动恢复是「启动孤儿回收（只翻 interrupted 然后等人）」和「CR-1」。其余全是 alert-only / 人工点击。本 RFC 补的就是这根线 + 一批已确诊的独立安全缺口。

## 2. 架构原则与目标形态

1. **护栏先于自动**：可观测（AR-11）+ 熔断（AR-09）+ 租约（AR-08）+ 分类器（AR-07）四道护栏先落且默认 OFF / alert-only；自动执行（auto-resume / auto-repair / auto-kill）实现但默认 OFF，逐项 opt-in。
2. **复用既有原语，不另造**：自动续跑复用 `resumeTask` 整段；自动修复复用 `applyRepairOption`（仅把 actor 从「人」换成 `'system'`）；杀进程复用 `killStaleRunProcessTree`；revival 复用 `dispatchFrontier`；告警复用 `lifecycle_alerts` + WS `lifecycle.alert`；审计复用 `lifecycle_repair_audit` 的范式扩成 `recovery_events`。
3. **状态写入结构保证**：任何新 status 写（quarantine / auto-resume）一律经新 `nextTaskStatus(from,event)` 转移表，**禁裸 `tasks.status` 写**（eslint 守卫）。
4. **确定性触发 + 幂等 + 自清**：自动动作以「确定性终态事实」为触发（如 CR-1 的范本），幂等可重入，留 `recovery_events` 痕，失败自动收敛回探测网。
5. **单 daemon 接缝显式化**：lease / counters / `isTaskActive` 是进程内实现，但以可注入接口暴露 DB-backed seam，不焊死。

## 3. 能力设计（按 PR 分组；AR-NN 对应 proposal 缺口）

### PR-A — 状态机地基 + 可观测地基

**T1（AR-12）`nextTaskStatus` 转移表 oracle**

- 在 `packages/shared/src/lifecycle.ts` 新增 `nextTaskStatus(from: TaskStatus, event: TaskTransitionEvent): TaskStatus`，对称既有 `nextNodeRunStatus`：单一表 + `never` 穷举 + 派生 `allowedFromForTaskEvent(ev)`。事件 ADT：`claim` / `park-review` / `park-human` / `complete` / `fail` / `cancel` / `interrupt` / `resume` / `retry` / `quarantine` / `unquarantine`。
- backend `lifecycle.ts` 的 `setTaskStatus`/`trySetTaskStatus` 增量改为「接 `event`、由 `allowedFromForTaskEvent` 派生 `allowedFrom`」；保留 RFC-097 CAS 与 `allowTerminal` 语义不变（Codex 核验建议：两步走，先引入表，再逐点迁移，不破坏所有权锁）。
- eslint `no-direct-task-status-write` 守卫 + 源码穷举 + transition-table property 测试（对称 `lifecycle-transition-table.test.ts`）。
- 失败模式：迁移期某调用点未改 → 仍走旧 `allowedFrom` 形态（向后兼容）；穷举测试保新事件全覆盖。

**T2（AR-19）共享状态集模块**

- `shared/lifecycle.ts` 上提 `TERMINAL_TASK_STATUSES` + `isTerminalTaskStatus` / `isRetryableNodeRunStatus` / `taskStatusTone` / `nodeRunStatusTone`，`never`-default 穷举。
- 前端 4 站（`tasks.detail.tsx` `isTerminal`/`canvasStatus`/`noderunTone`、`NodeDetailDrawer.tsx` `canRetryNodeRun`）删本地副本改 import。新增状态（如 quarantine 衍生显示）→ TS 编译失败逼全覆盖。

**T3（AR-11 数据层）统一恢复审计**

- 新表 `recovery_events`（migration，见 §5）：`id / task_id / node_run_id? / actor('system'|userId) / kind / reason / before_json / after_json / created_at`。
- 单一原语 `recordRecoveryEvent(db, {...})`。**审计行与恢复 mutation 同事务落库**（Codex 设计 gate P2 修正）：凡有 status 翻转的 actor（boot-reap / shutdown-flip / limit-cancel / snapshot-lost / auto-resume / auto-repair / heartbeat-kill / quarantine），status CAS + `recovery_events` INSERT 经 `dbTxSync` 原子提交——避免「mutation 成功但 daemon 在异步 insert 前崩 → 无审计行」破 AC-3。仅纯 counter 自增走 fire-and-forget（崩了只丢内存计数、不丢持久历史）。所有现有 actor 接线：boot-reap（`orphans.ts`）、shutdown-flip（`shutdown.ts`）、limit-cancel（`limits.ts`）、snapshot-lost（`task.ts`）、CR-1（`lifecycleInvariants.ts`）。
- counters：进程内 `RecoveryCounters`（reapedSinceBoot / casLossSinceBoot / autoResumes / autoRepairsByRule / kills / quarantines），暴露在 `/api/health`（扩字段）或新 `/api/recovery`。
- 表增长：纳入既有 hourly `eventsArchive` 归档 / GC。

### PR-B — 配置接线（P0）

**T4（AR-01）默认 per-node 硬超时下限（D2：30min 可配）** ✅ 已实现（PR-B，commit 见 §9）

- `resolveLaunchRuntimeConfig` 上移到共享模块 `services/launchRuntimeConfig.ts`（连同 `resolveCommitPushConfig`），增读 `cfg.defaultPerNodeTimeoutMs`（>0 才返回），经 `StartTaskDeps.defaultPerNodeTimeoutMs` 透传。`StartTaskDeps` 字段 + 三个 kick 块（start/resume/retry）+ scheduler fallback **本就存在**——唯一缺口是 resolver 从不读该字段。
- **透传覆盖全部 `StartTaskDeps` 构造点**（Codex 设计 gate P2 + 实现 gate P2）：tasks 路由 start/multipart×2/resume/retry/**repair-options**/**repair**（`applyRepairOption`→`resumeAfterApply`→`resumeTask`，`lifecycleRepair.ts:293-308`）+ **parked clarify/review resume**（`routes/clarify.ts`/`routes/reviews.ts` 的 resumeDeps）+ **fusion 引擎**（`FusionDeps.defaultPerNodeTimeoutMs` → 内部两处 `startTask`）。漏任一站点 = 该路径节点无硬超时。
- scheduler `nodeTimeoutMs = pickNumber(node,'timeoutMs') ?? opts.defaultPerNodeTimeoutMs`（`scheduler.ts:1697`）——floor 自动生效，per-node override 仍可调高。不影响 awaiting\_\*（停在 `awaiting_human`，非 `runNode` 下 running）。
- 测试：`rfc108-launch-budget-timeout-floor`（resolver 返回 floor + 源码层断言 clarify/reviews/fusion 全透传）+ rfc103 passthrough 5→7 calls。

**T5（AR-02）per-task 预算自动默认——移出 PR-B / 不做**（Codex 实现 gate P1）

- 原计划：把 `defaultPerTaskMaxDurationMs/Tokens` 接进 startTask 作 fallback。**实现期发现并撤回**：config loader（`config/index.ts`）**无版本迁移**，只 backfill 默认；存量 config 文件第一次 load 即把旧 `defaultPerTaskMaxDurationMs: 1h` **写进磁盘**，一旦消费会把它当硬上限、`limits.ts` ticker 取消任务，而 `canceled` 非 resumable → 不可恢复误杀合法长任务（这正是 stale-config landmine）。
- **决定**：per-task 预算自动默认推后续（需配套 config-migration 框架才能安全重置存量 1h 死值）。per-node 30min floor（T4）已兜住 hung 子进程的成本/挂死。`input.maxDurationMs`/`maxTotalTokens` 显式设值仍照常生效；config 字段保持原状未自动消费。
- `accumulateTokens` 嵌套 cache 漏计已由 RFC-103 T3 修复——将来真做 per-task token 限额时才有效。

### PR-C — 独立安全/正确性修复

**T6（AR-15）resume worktree-missing 410 前检** ✅ 已实现（PR-C，resume-safety 半）

- `resumeKick`（RFC-109 已把 `resumeTask`/`syncTaskWorkflow` 收口于此）在 pending-CAS **之前**调 `assertWorktreePresentForResume`，worktree 不在则抛干净 `410 task-worktree-missing`——而非 CAS→pending→对不存在 cwd kick 出脏 500，任务保持 failed 不被错误复活。
- **实现期两处微调**：① 用 `existsSync`（而非 `isGitWorkTree`）做门——AR-15 的实情是 GC `removeWorktree` **删目录**（existsSync=false），且大量「纯 DB 级」resume 测试用「存在但非 git」的 stub 目录，isGitWorkTree 会误杀它们；多仓另查容器在 + 任一子仓在。② 经 `worktreePreflight` opt **只对 `resumeTask` 开**（RFC-109 `syncTaskWorkflow` 暂不开——其测试用 `/tmp` stub；它可后续 opt-in）。
- 顺带修 2 个用不存在 stub `/tmp/wt` 的既有 resume 测试（gap1 / api-tasks-repair）改用真实存在目录。
- **GC-side 推后续（同 PR-C 余项）**：`gc.ts` 排除 failed/interrupted 可恢复 worktree + 多仓逐子仓 GC + snapshot 非 prune——更重、有「不回收=磁盘泄漏」权衡，且 worktreeAutoGc 默认 OFF，故 v1 先用 resume 前检让「真被回收时」优雅 410。

**T7（AR-17）resume 跨 node_run 原子回滚** ✅ 已实现（PR-C）

- `resumeKick` 的 reset 循环前加**跨行 pre-flight**：对每个 `toRollback` 行用 `rollbackNodeRunWorktrees` 新增的 **`checkOnly` dry-run**（跑 `gitCommitExists` 存在性检查、零副作用）；任一行快照缺失则**在 kill/reset 任何 worktree 之前** `escalateSnapshotLost`。把「node 内 two-phase」抬到「跨 node_run」高度——覆盖 resume + sync（无条件）。
- 红测（`rfc108-resume-safety`）：两 failed 顶层行、row A 快照 RFC-098 pin 存活 / row B gc-prune，断言 escalate snapshot-lost 且 row A 的 worktree leftover 未被 reset；正路径「全快照在 → 正常回滚 + flip pending」。

**T8（AR-16）S2 cross-clarify 误杀修复** ✅ 已实现（PR-C）

- `stuckTaskDetector.hasOpenClarifySession`（原只读 `clarify_sessions`）改读统一 `clarify_rounds`（status='awaiting_human'，RFC-058 dual-write 自带 self+cross）——这是 false-demote bug 的根因。
- **`options-S2.ts` S2.reopen 维持读 `clarify_sessions`**（实现期决定）：reopen 是「找一条已关闭的 self-clarify session 重开」，clarify_sessions 仍是 self-clarify 的权威表；cross-clarify 经检测修复后不再 false-fire，故 reopen-for-cross 已无意义，改写 reopen 的 clarify_rounds 写语义反增风险、不修任何 bug。
- 回归：`stuck-task-detector` 新增「纯 cross-clarify awaiting_human >30min → 无 S2」红→绿 + 既有 self-clarify S2 两例改用 clarify_rounds（反映真实 dual-write）。

**T9（AR-14）fail-safe survivor-kill + 持久化 spawn 身份** ✅ 已实现（PR-C，commit 见 §9）

- spawn 时持久化 `node_runs.spawn_binary_path = cmd[0]`（migration 0051）。`killStaleRunProcessTree` 的**命令门**改按该精确二进制路径匹配活 pid 的 `ps command`（`pidCommandContainsBinary`，substring、跨 macOS/Linux 可移植），比 `/opencode|bun/` 模糊正则更具体（减少对「同窗口内另一个 bun/opencode」的误判）。匹配 ⟹ 我们的 → 杀；不匹配 ⟹ 确信回收 → `command-mismatch`（安全、不杀）。**48h startedAt 时间窗始终生效**（Codex T9 复审 P1：`spawn_binary_path` **非唯一身份**——`cmd[0]` 可能是裸 `opencode`(PATH 查找) 或被并发任务共享的绝对路径；跳过时间窗会 SIGKILL 到被回收的无关 pid），命令门只是把窗口内的形状判定收紧。legacy 行（NULL）走 `/opencode|bun/` 兜底。
- **fail SAFE（核心）**：`resumeKick`（覆盖 resume + RFC-109 sync）+ `retryNode` 把 kill 拆成独立 pass 先于回滚 pass；任一行 `kill-failed`（身份匹配、活、扛过 SIGTERM→SIGKILL）→ `escalateLiveChildSurvived` 翻 pending→failed(`errorSummary='live-child-survived'`) + **409 拒绝**，绝不在活进程下 git-reset（跨行：也不 reset 更早的行）。`orphans` boot-reap 不能拒绝（须清行）但 kill-failed 升 `log.error`（survivor 可见，下次 resume 仍被 T9 拦）。
- 测试：`rfc108-stale-process-identity`（spawn 真实进程：匹配→killed〔含 >48h startedAt〕/ 不匹配→command-mismatch 不杀 / legacy null→window-expired）+ 源码层锁 resumeKick/retryNode 在 kill-failed 调 escalateLiveChildSurvived + runner 持久化。`kill-failed`（扛过 SIGKILL）无法确定性构造，由源码层断言兜底。
- **未做（推后续）**：start-time token（ps lstart 比对，跨平台解析易抖、暂不引）+ 48h 窗口配置化 + `recovery_events`/alert 接线（待 T3/PR-D）。

**T10（AR-13）写时 U1 唯一约束（shadow-mode）**

- migration（**裸 SQLite 用 snake_case 列名，非 Drizzle 属性名**——Codex 设计 gate P2）：partial unique index `... ON node_runs(task_id, node_id, review_iteration, COALESCE(shard_key,'')) WHERE status IN ('awaiting_review','awaiting_human')`。实现期先 `grep` `schema.ts` 确认 `review_iteration`/`shard_key` 实际列名（U1 键维度以 `lifecycleInvariants.ts` U1 检查实读的字段为准；如实际是 `iteration`/`shardKey→shard_value_hash` 等须对齐）。
- **shadow-mode 先行**：先发一版只在冲突时 log（不 enforce），确认 resume 路径不会误触发，再 enforce。
- resume 须在同事务把旧活跃行移出活跃集（否则 resume 期合法 re-mint 被唯一索引拒）。
- T1/T2 保留为 belt-and-suspenders 扫描，但 grace 按规则区分（结构新鲜违例用分钟级，历史债用 24h）。

### PR-D — 四道安全护栏（默认关闭 / alert-only）

**T11（AR-09）熔断 + 隔离**

- per-task 恢复尝试核算：新增 `tasks.auto_recovery_attempts`（或从 `recovery_events` + resume audit 滚动窗口派生）+ `tasks.auto_recovery_suspended`（soft flag，经 `nextTaskStatus` 的 `quarantine` 事件，非终态）。
- 超 `maxAutoRecoveriesPerWindow`（默认 3/1h，可配）→ 置 suspended，从**两个**自动 loop 排除，产独立 alert；人工一键 `unquarantine` 清除。
- 指数退避（复用 memoryDistill backoff 范式）。post-apply 校验：同 rule 再次 emit → audit outcome 记 `auto-repair-ineffective`。
- 失败模式：熔断本身经 CAS，竞争丢失则尊重赢家。

**T12（AR-08）driver-lease**

- 进程内 per-task lease 原语（`acquireDriverLease(taskId): Lease | null` / `release`），TTL-bounded、`finally` 释放、leak 自愈成 stuck-detection。
- 活调度器 `runTaskInner` 期间持 lease；recovery actor（resume/repair）apply 前 try-acquire；持有期 `applyRepairOption` 对 `touchesLiveState` 选项**引擎级拒绝**（取代 per-call-site `schedulerLivenessGate` 约定——它现在漏挂在 `R1.approve-run`/`R2.demote-run`/`C1.resume-run`/`T1/T2.resurrect`/`S1.recreate`/`S2.reopen`/`U1.*`）。
- 每选项加 `touchesLiveState: boolean` 标注。boot reconcile（孤儿回收同段）清陈旧 lease。
- 显式 DB-backed seam（`LeaseStore` 接口），单 daemon 用 in-memory 实现。

**T13（AR-07）`autoApplyEligible` 分类器**

- `RepairOptionMeta`（`shared/diagnose-repair.ts:35-38`，现仅 `risk`+`destructive`）加 `autoApplyEligible: boolean`（或 `selection: 'single-deterministic' | 'human-choice'`）。
- **契约不变式（Codex 设计 gate P2 修正）**：`autoApplyEligible === true ⟹ risk==='low' && !destructive && 单值确定性`，与 AC-6 property 测试一致（绝不把 medium/high-risk 判 eligible）。**v1 eligible 集 = 在各 `options-*.ts` 实读为 `risk:'low'` 且非破坏性且 preflight 出唯一候选的那些**——实现期逐个核对每选项的 `risk` 级别再定；**凡实读为 medium 的（经核 `R2.demote-run`、部分 `resurrect-*`、`CR-1.retry-designer-rerun` 等很可能是 medium）一律排除（或先降 `human-choice`），不在 v1 自动集**。首批确定候选：`S4.kick-task`（纯可逆 re-poke）；其余 low-risk 单值项逐条核 risk 后纳入。
- 所有 `*.acknowledge` / `*.mark-failed` / `*.cancel-task` / `U1.*` / `*.reopen` 恒 ineligible。
- 自动白名单 = `autoApplyEligible && 规则恰有一个 eligible+available 选项`（preflight 出唯一候选）。加规则强制分类（穷举测试）。
- property 测试：分类器**永不**自动应用 destructive / 多选项 / 中高危；并断言 `autoApplyEligible ⟹ risk==='low' && !destructive`（编译/运行双锁不变式）。

### PR-E — 检测扩展 + 廉价可观测

**T14（AR-06，D4）S6 成员删除死锁检测（仅检测）**

- 新 rule `S6`（进 `LIFECYCLE_ALERT_RULES` + `REPAIR_OPTION_IDS['S6']=['S6.acknowledge']`，对称 S5）：对每个 awaiting_human/awaiting_review 任务，join 开放 `clarify_round`/`doc_version` × task members（owner+collaborator，RFC-099）× `users.status`；若**零活跃成员可答** → 产 alert。24h grace。
- 纯检测，不改归属（D4）。`disableUser`/`updateTaskMembers` 不加写时拦截（推 v2）。

**T15（AR-05 manual）`S5.kill-and-resume` 修复选项**

- `REPAIR_OPTION_IDS['S5']` 增 `S5.kill-and-resume`（保留既有 `S5.acknowledge`）；`apply` 复用 `killStaleRunProcessTree`（带 T9 的 fail-safe 身份门）→ 杀活子进程 → 翻 interrupted → 可选 `resumeAfterApply`。`touchesLiveState=true`、`autoApplyEligible=false`（杀进程 + resume 仍需人/熔断把关；自动半在 T20）。

**T16（AR-20）廉价可观测补漏**

- `reapOrphanRuns`：被翻 interrupted 的 node*run 若 parent 是 awaiting*\* → emit boot-time lifecycle_alert（今天静默解耦）。
- `POST /diagnose`（`routes/tasks.ts:385-399` 现只跑 invariants）增跑 `runStuckTaskDetector({taskIdFilter})`。
- `doctor.ts` 增任务生命周期检查：开放 error-severity alert 数 / running 任务带 dead pid / node_run 卡 running。
- `TaskDiagnosePanel`/`DiagnoseTable` 未知 rule code fallback 到裸 code（`StuckTaskBanner` 已防）。

**T17（AR-10）周期性 post-boot 孤儿 reconciler**

- 每 5–10min ticker，对 running/pending 且 `isTaskActive(id)===false`（in-daemon 孤儿）跑 scoped `reapOrphanRuns` 变体：复用 `killStaleRunProcessTree`（fail-safe）+ CAS 翻 interrupted。
- 新不变式「running ⟹ (∃ 活 node_run 有近期 event) ∨ taskId ∈ activeTasks」。
- gate：行 `startedAt` > ~60s grace + event 静默窗 + `activeTasks` 检；CAS-loss-is-fine（合法写者赢）。
- **reap-to-interrupted 是安全默认（可 on）**；其后是否自动 `resumeTask` 受 T18 `autoResumeOnBoot` 同开关门。

### PR-F — 自动执行（实现但默认 OFF）

**T18（AR-03）boot auto-resume（`autoResumeOnBoot` 默认 false）**

- boot（listener 起来后）对**本次** reaper 翻成 interrupted 且 `errorSummary='daemon-restart'`（**排除** failed/shutdown/limit/snapshot-lost）的任务逐个 `resumeTask`。
- 前置：(a) 熔断未隔离（T11）；(b) cause 严格 `daemon-restart`；(c) `pre_snapshot` 可解析（否则落既有 snapshot-lost 升级）；(d) 非 awaiting\_\*（那是停在人）。
- 整段复用 `resumeTask`（幂等）。记 `recovery_events(kind='auto-resume')` + 通知成员。
- 幂等 property 测试：重复跑不双写（CAS 锁兜底）。默认 false → 零行为变更。

**T19（AR-04）闭环 detect→classify→auto-repair loop（`autoRepair` per-rule 默认 off）**

- `AutoRepairLoop`（挂在探测 tick 后或独立 ticker）：对每个开放 alert 分类 AUTO（规则恰一个 eligible+available 选项，T13）vs ESCALATE（多选项 / ineligible → 维持 alert 等人）。
- AUTO 经 `applyRepairOption(actorUserId='system')`，behind driver-lease（T12）+ grace（alert 存活 ≥2 探测 tick ~10min）+ breaker（T11）。
- 逐规则 opt-in（config `autoRepair: { S4: true, ... }`），首发仅 `S4.kick-task`，每扩一条须 green 幂等 oracle（D5）。永不自动 destructive/多选项。
- 记 `recovery_events(kind='auto-repair', rule)`。默认全 off → 零行为变更。

**T20（AR-05 auto）心跳驱动 stalled-child auto-kill（`autoKillStalledChild` 默认 false）**

- per-run 心跳看门狗 ticker，由 `node_run_events` recency 驱动（S5 已算的数据）：last event 早于 `heartbeatStallMs`（默认 ≥30min、event-reset、可配）→ 跑 RFC-098 kill-then-settle（`killStaleRunProcessTree`（fail-safe）→ 翻 interrupted）。
- 与 T4 的 30min 硬超时下限「门槛 ≥ stall 门」避免双触发。记 `recovery_events(kind='heartbeat-kill')`。

### PR-G — 前端（恢复健康面 + 设置 + 通知 + parity）

> 按 [feedback_audit_fanout_frontend_parity]：前端与后端等粒度，含专门的 UI-design-system / 公共组件复用切片。

**T21** 系统健康/恢复事件页（新路由）：开放 alerts 列表 + `recovery_events` 历史 + counters 卡片。复用 `<EmptyState>/<ErrorBanner>/<LoadingState>/<StatusChip>`、`AttributionChip`（actor）、表格走未来 `<Table>` 或既有列表骨架。ACL 按资源可见性过滤。
**T22** 任务列表行 stuck 徽标（今天 alert 只在详情 `StuckTaskBanner` 可见）：复用 `<TaskStatusChip>` 旁加 alert chip。
**T23** WS `lifecycle.alert` payload 加 `recovered`/`resolved` transition（今天只 `new`/`promoted`）；任务成员收「系统对你的任务做了 X 恢复」通知（复用 inbox/WS）。每任务每 episode 合并去噪。
**T24** Settings 暴露 auto-knobs：`autoResumeOnBoot` / `autoRepair`（per-rule）/ `autoKillStalledChild` / `defaultPerNodeTimeoutMs` / `defaultPerTaskMaxDurationMs` / 熔断阈值。复用 `<Switch>/<NumberInput>/<Field>`、危险项加说明 hint。i18n 中英对称。
**T25** 视觉对齐自查（与 `/agents` `/workflows` `/settings` side-by-side）；源码层文本断言锁「不新落原生 input/select/table、不自写 error-box」。

## 4. 配置 schema 变更（`packages/shared/src/schemas/config.ts`）

新增（全部 operator 可配、默认安全）：

```
autoResumeOnBoot: z.boolean().default(false)
autoRepair: z.record(z.string(), z.boolean()).default({})        // 规则 → 开关；默认空 = 全 off
autoKillStalledChild: z.boolean().default(false)
heartbeatStallMs: z.number().int().positive().default(30*60*1000)
maxAutoRecoveriesPerWindow: z.number().int().positive().default(3)
autoRecoveryWindowMs: z.number().int().positive().default(60*60*1000)
periodicOrphanReconcileMs: z.number().int().positive().default(10*60*1000)  // 默认 10min on（Codex 设计 gate P3：与 AC-17「reap-to-interrupted 安全默认 on」一致）。仅 reap in-daemon 孤儿→interrupted（等价 boot reaper、不 auto-resume）；auto-resume 部分另受 autoResumeOnBoot 门。设 0 不再合法（要关用 autoResumeOnBoot=false 即可只 reap 不续跑）；若确需禁用 reconciler 改 nonnegative 并文档化
```

既有但本 RFC 才**真正接线**：`defaultPerNodeTimeoutMs`（T4）、`defaultPerTaskMaxDurationMs`/`defaultPerTaskMaxTotalTokens`（T5）。

## 5. 数据库变更（migration，手写、对齐本仓 0013 起停用 drizzle generate 的惯例）

- `recovery_events`（T3）：`id TEXT PK / task_id TEXT / node_run_id TEXT NULL / actor TEXT / kind TEXT / reason TEXT / before_json TEXT / after_json TEXT / created_at INTEGER`，索引 `(task_id, created_at)`。
- `tasks` 加列（T11）：`auto_recovery_attempts INTEGER NOT NULL DEFAULT 0`、`auto_recovery_suspended INTEGER NOT NULL DEFAULT 0`、`auto_recovery_window_started_at INTEGER NULL`。
- `node_runs` 加列（T9）：`spawn_binary_path TEXT NULL`、`spawn_token TEXT NULL`（持久化 spawn 身份；可复用既有 `opencodeSessionId` 则只加 binary path）。
- partial unique index（T10）：`CREATE UNIQUE INDEX ... ON node_runs(task_id,node_id,review_iteration,COALESCE(shard_key,'')) WHERE status IN ('awaiting_review','awaiting_human')`（shadow→enforce 分两 migration 或一列开关）。
- binary smoke 必跑（[reference_binary_build_module_cycle]）：新 migration 嵌入 + 无模块环。

## 6. 测试策略（先红后绿，每条都带回归命名）

- **配置接线**：`rfc108-timeout-floor`（default launch → runNode timeoutMs===default）、`rfc108-task-budget-default`。
- **护栏**：`rfc108-recovery-events`（每 actor 落痕）、`rfc108-circuit-breaker`（N 次后隔离 + 一键清）、`rfc108-driver-lease`（活调度器持有时 touchesLiveState 选项被拒；TTL/boot 清陈旧）、`rfc108-autoapply-classifier`（property：永不自动 destructive/多选项/中高危）。
- **安全修复**：`rfc108-gc-resumable-protect`（翻转既有 gap3 锁）、`rfc108-resume-worktree-preflight`（410）、`rfc108-resume-crossrow-atomic`（row1 未被 reset）、`rfc108-s2-cross-clarify`（不误产 S2）、`rfc108-survivor-kill-failsafe`（3 注入场景）、`rfc108-u1-unique-index`（shadow + resume re-mint 不被拒）。
- **检测/oracle**：`rfc108-s6-member-deletion`、`rfc108-s5-kill-and-resume`、`task-transition-table`（对称 node_run property）、`shared-status-set-exhaustive`（源码穷举）。
- **自动执行（默认 off 行为锚 + 开启路径）**：`rfc108-auto-resume-boot`（开启→续跑 + 幂等；关闭→零变更）、`rfc108-auto-repair-loop`（S4.kick 自动应用 + 多选项 escalate + lease/grace/breaker 联动；关闭→零变更）、`rfc108-heartbeat-kill`。
- **前端**：vitest 覆盖健康页三态 / settings 开关 / stuck badge / 未知 rule fallback；源码文本断言锁公共组件。
- 既有套件做等价锚：凡翻转既有断言（gap3 GC、S2）须在测试头注明 RFC-108 改写意图与原 commit/RFC，防未来 refactor 误判（[CLAUDE.md 回归防护命名]）。

## 7. 失败模式 / 回滚 / 已知限制

- **默认 off 兜底**：所有自动执行默认 OFF；最坏情况退化到「今天的行为 + 一批安全修复 + 更好的可观测」。每个自动 loop 都可单独关。
- **熔断兜底**：自动续跑/修复的崩溃-loop 由熔断在 N 次后隔离，不会无限烧钱。
- **lease 泄漏自愈**：lease TTL-bounded + finally 释放 + boot 清；泄漏只会让某任务暂时不能被自动恢复，落回 stuck-detection 网。
- **U1 唯一索引风险**：shadow-mode 先验证 resume re-mint 不被误拒，再 enforce；enforce 后第二次插入 fail-closed（比双 park 安全）。
- **timeout floor 行为变更（影响现有用户）**：default 配置任务节点此后有 30min 硬超时——合法长跑节点须显式调高 `timeoutMs`（settings + per-node override 均可）；这是有意的安全默认（D2）。release note 须显著提示。
- **已知限制（推 later，proposal §2.2 非目标）**：S7/S8 wedged-loop/fanout-shard 检测、snapshot-lost 的 re-baseline/worktree-recreate 修复、成员删除自动改归属 / 写时拦截、多 daemon DB-backed lease/coordinator。
- **回滚**：每个 PR 独立可回滚；migration 只增列/增表/增索引，不删不改既有列语义。

## 8. 与现有模块耦合点（改动面清单）

- `packages/shared/src/lifecycle.ts`（T1/T2 转移表 + 状态集）、`schemas/config.ts`（§4）、`diagnose-repair.ts`/`lifecycle-alerts.ts`（T13 字段 + S6/S5 选项）。
- `backend/services/`：`lifecycle.ts`（T1 接事件）、`orphans.ts`（T3/T16/T17）、`shutdown.ts`/`limits.ts`（T3）、`stuckTaskDetector.ts`（T8/T14/T17 不变式）、`lifecycleInvariants.ts`（T3 CR-1 痕 + T10 grace）、`lifecycleRepair.ts` + `lifecycleRepair/options-*.ts`（T12 touchesLiveState + T13 eligible + T15 S5 选项 + T14 S6 选项 + T19 system actor 路径）、`task.ts`（T4/T5/T6/T7/T11/T18 resume）、`gc.ts`（T6）、`runner.ts`（T9 spawn 身份）、`util/process.ts`（T9 fail-safe）、新 `services/recovery*.ts`（T3 审计 + T11 breaker + T12 lease + T18 boot resume + T19 auto-repair loop + T20 heartbeat）。
- `backend/cli/start.ts`（接线新 ticker/boot-resume）、`doctor.ts`（T16）、`routes/tasks.ts`（T4 deps + T16 diagnose + health/recovery 端点）。
- `frontend/`：新健康页路由、`tasks.detail.tsx`/`NodeDetailDrawer.tsx`（T2 状态集）、`StuckTaskBanner`/`TaskDiagnosePanel`/`DiagnoseTable`（T16）、列表行 badge（T22）、settings（T24）、`useTasksSync`（T23 transition）、i18n。
- **解循环依赖注意**（[reference_binary_build_module_cycle]）：`lifecycleRepair` 已 import `resumeTask`（`task.ts`）；新 `recovery*` 模块若被 `task.ts`/`scheduler.ts` 反向引用要走 leaf 模块共享常量，push 前必跑 `bun run build:binary` smoke。

## 9. Codex 设计 gate 记录（实现前）

2026-06-26 对三件套跑 Codex 设计 gate（working-tree review），5 findings 全 fold：

- **[P2] timeout floor 漏 repair-triggered resume**：`applyRepairOption` 的 `resumeAfterApply` 是第 4 个 `StartTaskDeps` 构造点，T4 已扩为覆盖全部 deps 站点（§3 PR-B）。
- **[P2] `autoApplyEligible` 含 medium-risk 项与 AC-6 矛盾**：加不变式 `autoApplyEligible ⟹ risk==='low' && !destructive`，medium 项（`R2.demote`/部分 resurrect/`CR-1.retry-designer`）排除出 v1 自动集，首发仅 `S4.kick-task`（§3 PR-D T13 + AC-6）。
- **[P2] `recovery_events` fire-and-forget 崩溃丢审计行**：改为与 status mutation 同 `dbTxSync` 事务原子落库，仅 counter 走 fire-and-forget（§3 PR-A T3 + AC-3）。
- **[P2] U1 migration 用了 Drizzle 属性名**：§3 T10 改裸 SQLite snake_case + 实现期核对实际列名（§3 PR-C T10）。
- **[P3] `periodicOrphanReconcileMs=0` 与 AC-17「默认 on」矛盾**：config 默认改 10min on（§4）。

实现期每 PR 仍跑 Codex 实现 gate（[feedback_codex_review_after_changes]）。

### PR-B 实现 gate（commit 57a6fb6，2 findings 全 fold）

- **[P1] stale-config 1h 误杀**：存量 config 文件已持久化旧 `defaultPerTaskMaxDurationMs: 1h`（loader 无版本迁移），消费它会把任务 1h 硬取消（canceled 非 resumable）。→ **撤回 T5 per-task 预算自动接线**（见上 T5），PR-B 只保留 T4 per-node floor。
- **[P2] floor 漏其它 kick 站点**：`/api/fusions`（`fusions.ts`）、parked clarify/review resume（`clarify.ts`/`reviews.ts`）各自手搭 `StartTaskDeps` 不带 floor。→ `resolveLaunchRuntimeConfig` 上移共享模块 `services/launchRuntimeConfig.ts`，三处 + repair 两 handler 全部透传；`FusionDeps` 加 `defaultPerNodeTimeoutMs` 透传进内部 startTask。
- 复跑：typecheck×3 + 全量 backend 3961 pass/0 fail + 源码层断言锁全站点 + format + lint 绿。
