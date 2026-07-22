# Codex Adversarial Review

Target: branch diff against 2523cba8
Verdict: needs-attention

不应发布。`resolveCompletionGate` 两个生产调用点、可执行的 `resolveClarifyEnabled` 删除及 `autonomous:false` 夹具清理已核实闭合，但 RFC-207 仍会少放行一次反问、跨提问方撤销在途问题，并存在停止状态与升级记账缺口；RFC-209 对存量已打戳续跑仍会双计，异常派单路径也漏出 round 例外。

Findings:
- [high] RFC-207：预算的第 N 问会被当成超额，并撤销全任务的在途反问 (packages/backend/src/services/scheduler.ts:1007-1018)
  触发路径：`createClarifySession` 插入第 N 个 session 后进入这里；`isTaskClarifySuppressed` 在 `workgroupLifecycle.ts:213-214` 已把刚插入的 session 计入并以 `asked >= budget` 判断，因此 budget=1 时首问即被压制，budget=3 时第三问被撤销。随后 `dismissOpenClarifyParksForAutonomous` 在 `workgroupLifecycle.ts:277-282` 扫描该任务所有 `awaiting_human` session，而非当前 asker/session；并发 worker 的无关问题也会被取消、卡片重排队。停止指令若落在前后检查之间也走同一全局遣散，违反“预算/喊停不遣散在途 park”的设计约束。
  Recommendation: 让 post-create 补偿只处理“花名册已无人”这一全局原因；预算按插入前计数或显式排除刚创建的 session，预算/stop 只影响后续反问，禁止调用任务级全量遣散。增加 budget=1、budget=3 和两个 asker 同时 park 的调度器级回归测试。
- [high] RFC-209：已打戳的被杀续跑仍会永久多算一轮 (packages/backend/src/services/workgroupRounds.ts:102-115)
  新逻辑只从迭代中排除被杀前身，却仍以剩余行的 `max(wg_round)` 返回账本值。存量/版本交错场景中，旧代码可能已把前身打成 round 4、重铸后继打成 round 5；升级后即使前身被排除，后继的 5 已包含那次双计，函数仍返回 5 而非 4。零 migration/零回填使该错误永久保留，导致 `maxRounds` 提前触顶、`roundsUsed` 高报和房间轮号跳跃。新增 rider 测试只构造两个 `wgRound=null` 行，未覆盖真实已打戳存量。
  Recommendation: leader_worker 重铸续跑应继承被杀前身的 `wg_round`，并为现存同 lineage 的已打戳 4/5 形态提供幂等回填或派生归一化；新增 stamped predecessor/successor 测试并验证触顶、room `roundsUsed` 与卡片轮号。
- [medium] RFC-207：移除最后一人与反问遣散不是一个原子状态转移 (packages/backend/src/routes/workgroupTasks.ts:1248-1265)
  配置事务在 1248 行已提交，开放 session 的遣散到 1265 行才进入另一个事务，且路由没有取得 `getTaskQuestionWriteSem(taskId)`。进程若在两次提交之间退出，会留下“花名册无人但 session 仍可回答”的持久状态；`awaiting_human` 任务不属于 boot auto-resume 扫描，重试同一 PATCH 时 `hadHumanMember` 又已为 false，因而不会补做遣散。用户此时仍可提交旧答案并 mint continuation，破坏 AC5 的陈旧答案拒绝保证。
  Recommendation: 在 `getTaskQuestionWriteSem(taskId)` 下，用 tx-aware 遣散原语把 config 写入、session/round/park-run 取消放进同一个 `dbTxSync`；若暂时无法同事务，至少落耐久 cleanup marker，并在回答入口及启动扫描中 fail closed。补崩溃重开和答案并发屏障测试。
- [medium] RFC-207：节点级 continue 可删除并发写入的更新 stop (packages/backend/src/services/taskClarifyDirective.ts:103-128)
  节点级 continue 的 upsert 与清除 shard 行是两个独立 await。若 continue 完成 upsert 后，一个答案并发写入较新的 shard-level stop，随后 119-127 行的无条件 DELETE 会把这个较新的 stop 一并删除；用户刚选择的“提交并停止反问”静默失效，后续派单继续反问。现有测试只覆盖顺序执行，未覆盖该交错。
  Recommendation: 将节点级 upsert 与 shard DELETE 放入同一同步事务，使事务提交顺序成为明确的 last-write-wins；或限定 DELETE 只清除 `updated_at <= continueTimestamp` 的行。增加并发 stop/continue 测试。
- [medium] RFC-207：迁移保留的节点级 stop 被房间隐藏，升级后无法恢复 (packages/backend/src/routes/workgroupTasks.ts:377-391)
  迁移 `0101_rfc207_directive_shard.sql:23-24` 把全部存量 directive 搬成 `shard_key=''`，解析器又把该行作为所有 asker 的回退。因此旧工作组的 stop 会在升级后压制 leader 或整个 `__wg_member__` 节点。这里却显式过滤空 shard；源码注释也确认工作组没有普通画布开关，房间是唯一恢复入口。结果是有效 stop 不显示、没有恢复按钮，而且当前 API 的 `shardKey` 还要求非空，用户无法从 UI 撤销。
  Recommendation: 在 room wire 中显式表示 node-scoped stop（例如 `scope:'node'`、可选 askerKey），前端恢复时省略 `shardKey`，从而触发节点级 continue；补一条从旧表含 stop 行升级到 0101 后的 API/UI 回归测试。
- [medium] RFC-207：运行中任务的迁移回填仍会把历史 park 时间计入上限 (packages/backend/db/migrations/0100_rfc207_task_running_time.sql:13-17)
  升级时若旧 daemon 异常退出，任务可能仍为 `running`。该任务若此前经历过长时间 `awaiting_human` 再恢复，`started_at` 早于 park；这里把 `running_since` 回填为 `started_at`，随后新版本的状态收口或 limits tick 会把整个历史墙钟时间（含 park）累计进 `running_ms`。任务可能在升级恢复后立即以 `task-time-limit-exceeded` 被取消，正好重现 RFC-207 要消除的行为。
  Recommendation: 历史状态段不可重建时应避免误杀：将存量 running 行的 `running_since` 回填为迁移时刻，或引入 unknown-baseline 标记并从升级后开始计时；补旧库中“曾 park、崩溃时 running”的迁移与 limits 回归测试。
- [medium] RFC-209：派单异常兜底漏出 assignment.round 保护族 (packages/backend/src/services/workgroupRunner.ts:1383-1406)
  `driveAssignmentTurn` 在自身错误处理前抛异常时（注释举例为 mint error），catch 先用省略 round 的通用 `postMessage` 写入实时账本轮号，且不带 `assignmentId`，随后才把派单置为 failed。轮 2 派出、轮 7 才在该路径失败时，错误消息会落到 round 7 并与派单卡脱钩；这违反 RFC-209 声明的“结果/失败/交付/取消均使用 assignment.round”例外。
  Recommendation: 对 `assignment`/`fc_claim` 分支先从 state 解析卡片，并使用 `postAssignmentMessage` 写 `assignment.round` 与 `assignmentId`；leader/message-turn 才走通用消息。增加注入 mint/DB 异常且 live round 不等于 assignment.round 的测试。

Next steps:
- 先修 RFC-207 预算后检的全局遣散与最后一人移除的原子性，这两项直接破坏用户问题和续跑状态。
- 补齐 stop/continue 并发、旧 directive 升级、运行时长迁移以及 RFC-209 已打戳续跑和异常派单测试。
- 修复后运行 RFC-207/209 定向套件，再执行完整 backend、frontend、typecheck、lint、format 与 binary build 门禁。

Codex session ID: 019f8764-a1d1-7182-ae37-b9da6d30d816
Resume in Codex: codex resume 019f8764-a1d1-7182-ae37-b9da6d30d816
