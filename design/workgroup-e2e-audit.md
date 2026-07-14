# 工作组端到端审计——为什么一次都没跑通（2026-07-14）

> 目的：工作组（`leader_worker` / `free_collab`）自 RFC-164 落地以来 **10 个任务、0 个 done、没有一个 worker 真正执行过**。本审计不改代码，只把「从启动到 done」整条链上的所有尖角 / 盲区 / 覆盖缺口列全，标注现状与修复优先级，供拍板后按路线实现。
>
> 方法：live DB 实证（`~/.agent-workflow/db.sqlite`）+ 5 路并发源码走查（leader/member 协议、回合循环与收尾、iso/merge-back、clarify/重启、e2e 覆盖与配置陷阱）。

## §1 实证记录（live DB，截至 2026-07-14 09:xx）

> **更新（同日稍晚）**：并发 session commit `9874fffd`（RFC-185 端到端实测）修了 P0-A 的基础部分（`envelope-missing` 重试 + `<workflow-output>` 字面示例 + `@` 宽容），任务 `01K…1GWAWY`（fanout-demo 组）**首次跑到 `done`**——本审计的「0 done」自此被打破。但 **P0-B（§4-1/§5-F1 重启永久死）未动、真实自动 e2e（§6 meta 根因）仍缺、P0-A 仅最小补丁未全量对齐**。后续由 [RFC-186](./RFC-186-workgroup-first-green-and-resume/proposal.md) 承接这三个真空。以下记录为修复前快照，findings 除已标注外仍有效。

**10 个工作组任务，0 done（快照时点），0 assignment 由 leader 成功派发，0 worker 执行。**

| 任务(尾6) | 组 | 状态 | 死因 |
|---|---|---|---|
| 2DMA29 | test | failed | `clarify-questions-malformed`（leader 反问 JSON 畸形）|
| V6H5T8 | test | interrupted | daemon 重启 |
| BF231F | test | interrupted | daemon 重启 |
| Z01BJA | test | failed | `port-validation-path-empty-path`（RFC-184 目标）|
| Z41EG9 | test | failed | `no <workflow-output> envelope` |
| 0F42SE | test | failed | `port-validation-path-empty-path`（RFC-184 已修）|
| YRV85W | test | interrupted | daemon 重启（**我为上线 RFC-184 重启所致**）|
| E0RBDE | test | failed | `no <workflow-output> envelope`（leader 用 `<wg-output>` 裸标签）|
| DP7BXB | fanout-demo | failed | **复合**：见 §1.2 |
| GRMS20 | fanout-demo | failed | （fanout-demo，同类）|

**5 种不同的 leader 首轮失败模式**（`node_runs where node_id='__wg_leader__' and status='failed'`）：`clarify-forbidden` ×1 · `clarify-questions-malformed` ×1 · `no <workflow-output> envelope` ×2 · `port-validation-path-empty-path` ×2。全部集中在「框架↔模型信封/反问协议契约」这一个咽喉，串行踩雷、修一个冒一个。

### §1.1 配置陷阱：花名册无 producer

4 个组：`test`（`coder`+`task-completion-checker`，autonomous）、`eee`（**空花名册**）、`rrr`（**空花名册**）、`fanout-demo`（`fanout-leader`+`fanout-writer`，autonomous）。

- `test` 组 leader=`coder`，唯一可派发对象是 `task-completion-checker`——**只读/评审 agent，不写代码/不产文件**。所以这个组即使框架零 bug，leader 也只能正确地判「BLOCKED（无 producer）」——但框架却在这个「正确的 done」上崩了（E0RBDE）。
- 启动期**没有**「花名册缺 producer」的护栏（待 e2e 组确认 `workgroupLaunchReadiness`）。空花名册组能创建。

### §1.2 DP7BXB：一个任务里叠了三件事（最有代表性）

`fanout-demo` 组（**有** producer `fanout-writer`）。leader 两轮：

| run | retry_index | runNode 状态 | 实况 |
|---|---|---|---|
| 1H7J45 | 0 | **done** | emit 了**完全合法**的 `<workflow-output><port name="wg_assignments">[{"member":"@writer",…}]`——**RFC-184 生效，史上第一次合法派发信封** |
| MATEAF | 1 | **failed** | `no <workflow-output> envelope`——重试轮改用 `<wg_assignments>` 裸标签，外壳丢了 |

三件事叠加：① RFC-184 让 leader 首次产出合法信封 ✓；② `member` 写成 `@writer` 而花名册 displayName 是 `writer` → `unknown member '@writer'` → wg 协议违规 → 触发重试（**注：DP7BXB 正是 RFC-185 `WgMemberRefSchema` @-剥离修复的动机任务，见 `workgroupRuntime.ts:206-212`；该修复在 DP7BXB 之后落地，现役树已容忍前导 `@`**）；③ 重试轮把 member 名改对了（`writer`）却**换个姿势把信封外壳写崩**（`<wg_assignments>` 裸标签）→ `envelope-missing` → **零重试 → fatal**。

这一个任务把 §2 的三个核心 bug 演全了：**P0-2**（协议块没有 `<workflow-output>` 完整范例，模型只能瞎猜外壳）× **P1-3**（重提示太笼统，模型「修了 member 名、又崩了外壳」）× **P0-1**（`envelope-missing` 零重试直接 fatal）。「修一个、崩另一个、且不再给机会」——三者缺一，这个任务本可跑通。

### §1.3 daemon 重启脆弱

10 个里 **3 个** 卡在 `interrupted`（"daemon restarted while this task was running"）。**这些任务是否还能被重新驱动到完成，是 §5 的核心待查项**——若不能自动恢复，任何长任务撞上任意重启就永久死亡。

---

<!-- §2–§6 由并发源码走查填充：leader/member 协议契约、回合循环与收尾、iso/merge-back、clarify/重启、e2e 覆盖与配置陷阱 -->

## §2 leader / member 轮协议契约（尖角雷区）

**核心发现：工作组轮完全绕开了普通节点那套已打磨的信封修复机制（`decideEnvelopeFollowup` / `FOLLOWUP_POLICY` / `failureCode`），自己手搓了一个 1 次重试、且把最常见的首轮失败（envelope-missing）当即时 fatal 的循环。**

| # | 严重 | 尖角 | file:line | 现状 → 失败 |
|---|---|---|---|---|
| P0-1 | **P0** | `envelope-missing` 对 leader 是 fatal 零重试；普通节点重试 3× | `workgroupRunner.ts:1067`（`throw`）vs `scheduler.ts:2663`（`?? 3`）/`prompt.ts:948-956`（`FOLLOWUP_POLICY['envelope-missing']`）| leader emit `<wg-output>`/裸标签 → `ENVELOPE_RE` 不匹配 → envelope-missing → 直接 throw → **round 0 整任务死**。单这一条就解释 9 任务 0 成功 |
| P0-2 | **P0** | leader/member 输出信封**没有 `<workflow-output>` 完整范例**（同一块里的 clarify 子路径却有）| `workgroupContext.ts:262-265`（仅散文规则）vs `:286-298`（clarify 有 `CLARIFY_FORMAT_EXAMPLE`）；普通节点 `prompt.ts:719-723` 有 `Format:` 范例 | 无模板 → 模型自造外壳 `<wg-output>` + 端口名当标签 → 撞 P0-1。**这是诱因，P0-1 是放大器** |
| P1-3 | P1 | 重试预算 1（普通 3）且重提示无模板/无理由化 + 每次重开新子进程（非同会话续跑）| `workgroupRunner.ts:170`（`=1`）、`:1017-1019` / `:1228-1230`（裸错误 bullet）| 一次含糊纠正；模型「修了 member 名又崩外壳」（DP7BXB run2）|
| P1-4 | P1 | leader 只重试 `clarify-questions-*`，不含 `clarify-options-*` 等 → 那些 fatal | `workgroupRunner.ts:1060` | leader 反问 options 畸形 → 落到 `:1067` throw |
| P1-5 | P1 | 引擎按 `errorMessage` 字符串前缀反推重试/fatal；`runHostNode` 把结构化 `failureCode` 丢了 | `scheduler.ts:668/688/941/1000`（只带 errorMessage）；`workgroupRunner.ts:1042/1060/1259`（`startsWith`）| 重演 RFC-145 前那套「顺序敏感 startsWith 链」的脆弱；runner 改句文案即静默重分类 |
| P1-6 | P1 | `driveAssignmentTurn` 不重试 member 的 envelope-missing/clarify 畸形（仅 clarify-forbidden）| `workgroupRunner.ts:1253-1291`（`:1259` 只认 CLARIFY_FORBIDDEN）| worker 首轮信封手滑 → 零重试直接 assignment failed |
| P1-7 | P1 | `driveMessageTurn` 静默吞掉一切非 done | `workgroupRunner.ts:1397`（`!== 'done' → return`）| 被 @ 的成员轮失败 → 房间零提示、cursor 已推进、调试全黑 |
| P2-8 | P2(过程 P0) | 框架↔模型信封边界**零真实子进程覆盖** | `rfc164-workgroup-engine.test.ts:163-185`（stub）| 见 §6 |
| P2-9 | P2 | 被驳回的 attempt-0 留下一个 `done` 的 node_run（输出实际被弃）| `workgroupRunner.ts:1094-1100`/`1307-1321` | 房间/审计出现「done 但被取代」的脏卡 |

**已修（记档）**：mode(5) `@writer` 前缀——`WgMemberRefSchema`（`workgroupRuntime.ts:214-217`）已剥离前导 `@` 并测试覆盖（RFC-185，动机任务=DP7BXB）。但**诱因仍在 prompt**：`renderRosterBlock` 渲染 `- @${displayName}`（`:213`）、派发体用 `@${member}`（`:1135`），协议却说「用裸名、不要 @writer」（`:350-352`）——自相矛盾，现靠防御性剥离兜住（见 §6 TRAP-2）。

**普通节点 vs 工作组轮 的不对称**（这就是「反复重踩已解决的坑」的实锤）：

| 方面 | 普通节点 | 工作组 leader/member |
|---|---|---|
| 重试预算 | `?? 3` | `1` |
| envelope-missing | 重试（FOLLOWUP_POLICY）| **fatal throw** / member 零重试 |
| 重提示 | 理由化 + 分 kind 修复块 + 同会话续跑 | 裸错误 bullet + 新子进程 |
| 失败分派 | 结构化 `FailureCode` → 表 | `errorMessage.startsWith`，failureCode 丢弃 |
| `<workflow-output>` 范例 | 有 | **无**（仅 clarify 子路径有）|
| 真实子进程测试 | 有 | **无**（全 stub）|

## §3 回合循环 · 聚合 · 收尾（能否真正到 done）

**好消息：假设 leader/member 轮修好，回合循环机械上能到 done。** 已逐 pass 追通 leader_worker 干净路径（3 pass 闭环）：pass2 barrier 靠 DB 状态挂住（`workgroupWake.ts:168`，抗重启）→ pass3 worker 发 `result` 消息触发 `hasUnconsumed(leader)` 重唤 leader、`renderLeaderLedger` 注入结果（**聚合有效**）→ leader emit `wg_decision done` → `decideWorkgroupOutcome` 返回 `done`（autonomous）或 gate→approve→`ok` → `trySetTaskStatus(done)`。**所以循环不是 P0**；P0 是这一切只在即时 resolve 的 fake hook 上验证过。

| # | 严重 | 盲区 | file:line | 失败场景 |
|---|---|---|---|---|
| 1 | **P0** | 整个循环+聚合+收尾**只在 stub `runHostNode` 上测过**，零真实覆盖 | `rfc164-workgroup-engine.test.ts:163-185`；真 hook `scheduler.ts:654-820` | round-2 首次跑真实投影+node_run 状态路径，任一错配（如 `wg_result` 以 `''` 回来被丢、行没到 done）就重演「派发 round1、死在 round2」而测试全绿 |
| 2 | P1 | leader emit `continue` 但不派发 → 停摆 park/nudge | `workgroupWake.ts:172-188`/`:259-267`；`workgroupRunner.ts:1148-1169` | 模型 round2「我想想/确认结果」不带动作 → autonomous 连 nudge 3 次后 park，非自治直接 `awaiting_human` 无自动恢复。**DP7BXB round-2 死因的头号嫌疑** |
| 3 | P1 | 协议重试多铸的 leader node_run **永久计入 maxRounds**（~2× 消耗）| `workgroupRunner.ts:1000-1012`/`418-427`（`countRoundsUsed`）| 一次逻辑聚合需重试就吃 2 轮；clarify-answer 续跑同样膨胀；sloppy leader 中途撞 `max-rounds` failed |
| 4 | P2 | 消息 id 用非单调 `ulid()`；同毫秒可乱序甚至跨 cursor 漏消息 | `workgroupRunner.ts:390-391`；`workgroupContext.ts:54-70` | 房间乱序（表面）；极端下 later 消息 ULID 小于 cursor → 被判已消费 → leader 不再唤醒 → 提前 park |
| 5 | P2 | adopted 的 dispatched 运行 CAS 缺口 → 重复 re-run | `workgroupRunner.ts:970-976`/`1216-1224`/`1339` | 崩在 mint 与 `dispatched→running` CAS 之间的成员轮被 adopt 后终态 `running→done` CAS 命中 0 行 → 下 pass 重派重跑（自愈但浪费一次子进程 + 重复 result）|
| 6 | P2 | 同一轮 `done` + 新 `wg_assignments`：派的活跑完但结果永不聚合 | `workgroupRunner.ts:1112-1140` 与 `:1149-1163` 同轮 | 新派工作跑完被静默丢弃、任务却报 done（autonomous）|
| 7 | P2 | `max_rounds` 恒 hard `failed`，无优雅收尾 | `workgroupWake.ts:182-184/243` | 本质已完成但没在第 cap 轮 declare done → failed + 弃活；宜改 park/最后一轮强制 wrap-up |

**旁注（free_collab）**：收敛只在无 open/dispatched/running 卡时排空（`workgroupWake.ts:270-287`），成员可持续 `wg_tasks_add` 新 open 卡 → 过热 roster livelock 到 maxRounds→failed；且 fc 轮数计**成员**运行（`:425-426`），fan-out 宽度直接吃预算。

## §4 iso worktree · merge-back · 多 worker 写聚合

**路径基线**：每个 host 运行在自己的 git iso worktree（`createNodeIso`，`nodeIsolation.ts:107`，从派发时的 canonical 全量快照分叉）→ 成功后 3-way `merge-tree` 回写单一 canonical（`mergeBackNodeIso`，`:288`），全程持**每任务** `writeSem`（`taskWriteLocks.ts:27`）。**没有独立聚合节点——canonical worktree 本身就是聚合**，用户经 `GET /api/tasks/:id/diff` 看累积 diff。结论：并发同文件写**不会损坏**（隔离+writeSem 串行）但**会冲突**；合并顺序=**完成顺序、非确定**；冲突→merge agent→未解→**输者整个 delta 被 park/丢弃**。

| # | 严重 | 盲区 | file:line | 失败场景 |
|---|---|---|---|---|
| **1** | **P0** | **daemon 重启中途成员轮 → 永久卡死 assignment + leader barrier** | `workgroupRunner.ts:598`（adopt 仅 `pending`）/`workgroupWake.ts:138`（仅唤 `dispatched`）/`:169`（`running` 算 blocking）| 重启→orphan reaper 把成员 node_run `running→interrupted`、任务 auto-resume；但 interrupted≠pending→不 adopt，assignment 仍 `running`→不重唤、且算 blocking→leader 也不唤 → `decideWorkgroupOutcome` 落 `awaiting_human/leader-idle` → **每次 resume 都同样卡死、非 DB 手术/取消不可恢复**。**这解释了 3/10 interrupted 永不恢复，单独也足以解释「0 done」** |
| 2 | P1 | fan-out 重叠写：输者**整个 delta 被丢**（whole-repo 粒度）、赢者完成序非确定 | `nodeIsolation.ts:295-322`；`scheduler.ts:963-994`；RFC-185 D3-4 | 4 worker 改同一共享文件（registry/`package.json`/CHANGELOG）→ A 干净赢，B/C/D 冲突→merge agent（LLM）解不了→各自 `merge-back-conflict` failed，**连它们不冲突的改动也一并丢**；谁赢纯看谁先完成。唯一护栏是给 leader 一句「分片别重叠」的 prompt，无框架级检测/部分救回 |
| 3 | P1 | merge agent 解冲突持 `writeSem` → 冻结全任务所有兄弟 merge-back **及新 iso 创建** | `scheduler.ts:963-976`（writeSem 包 merge agent 子进程）/`:674`（createNodeIso 也 writeSem）/`:671`+`:1007`（globalSem 全程持有）| 12-way fan-out，worker1 冲突 merge agent 跑 3 分钟 → 2-12 全堵在 writeSem 且各占 globalSem 槽 → 新成员连 globalSem 都拿不到 → 每次解冲突全任务吞吐塌成串行；慢/循环的 merge agent 整组停摆（无死锁但严重 head-of-line）|
| 4 | P2 | 工作组 conflict-human 行被孤儿化：iso 强制 discard + 删 refs（不像普通路径 keepIso）| `scheduler.ts:1001-1008`（finally 恒 discardNodeIso）vs `:3578`（DAG keepIso）；`nodeIsolation.ts:397-414` | 冲突后重启 → `replayConflictHumanResolutions` 探 base/node commit 已被 `deleteIsoRefs` 解钉+GC → mergeTree 退出>1→throw→`runTask` catch→**resume 时 failTask 整任务**；且 node_run 留 `done` 而 assignment `failed`，状态背离 |
| 5 | P1(cov) | fan-out 写路径零真实合并集成覆盖 | `rfc185-leader-fanout.test.ts:374,426-447`（fake hooks）；`rfc130-crash-replay.test.ts`（无工作组）| 上述全部对 CI 不可见 |
| 6 | P2 | 每 worker 的 merge base（所见 canonical）随调度时序非确定 | `scheduler.ts:674-683`；`nodeIsolation.ts:148-152` | createNodeIso 被 globalSem 排队拖到某兄弟 merge 之后 → 静默基于部分兄弟产出构建；同 fan-out 跑两次结果/冲突对不同 |

**查过没问题（非发现）**：submodule 脏内容快照前会大声抛错（`nodeIsolation.ts:234`）；并发 `snapshotFullState` 安全（per-pid temp index、per-nodeRunId 唯一 pin ref）；`replayPendingMerges` 幂等。**损坏风险确实不存在——暴露面是丢写/park（#2）与重启卡死（#1），不是 worktree 损坏。**

## §5 clarify 往返 · daemon 重启 / adoption 恢复

**头条（B 部分）：turn-engine 工作组任务一旦 `interrupted` 就永远无法完成——三处独立的、已提交的拒绝 + 一条刻意锁定该排除的测试共同证实。** 引擎本身完全可重入、durable 状态足够恢复，但**没有任何东西触发对 `interrupted` 的重入**。这就是 3/10 任务永久卡死的直接原因。

| # | 严重 | 发现 | file:line | 现状→失败 |
|---|---|---|---|---|
| **F1** | **P0** | **`interrupted` 工作组任务零恢复路径（永久死亡）** | `autoResume.ts:77`（`!isTurnEngineWorkgroupTask` 过滤掉）；`lifecycleRepair.ts:154/251`（revive 拒绝）；`tasks.ts:671-694`→`systemResources.ts:75-82`（手动 resume 403 builtin）；host wf `builtin:true` `workgroupLaunch.ts:124`；**锁定测试** `rfc108-auto-resume.test.ts:86-107`（断言 lw/fc 保持 interrupted）| 重启→reapOrphanRuns 把任务 `→interrupted`；三条出路全拒 → 永远卡死、非 DB 手术/取消不可出。`resumeTask` 服务其实通到 `runWorkgroupEngine`（引擎会 adopt+重导），**修复很小、只差一个触发器** |
| **F2** | **P0** | 给 `interrupted`/idle 任务发消息 → 建悬空 assignment 却永不驱动 | `workgroupTasks.ts:396-398`（仅拒 done/failed/canceled）/`:405-453`（插 dispatched assignment，但 kickResume 只在 `awaiting_human` 触发）| 人想 @成员 解卡 → 得 201 + 建 `dispatched` 行 → 什么都不跑，黑洞。`/deliver`/config-PATCH 同陷阱 |
| F3 | P1 | leader clarify-park 不可检测（`leaderParked` 是死代码）→ 并发活动绕过未答 clarify | `workgroupRunner.ts:629-631`（查 `__wg_leader__`+`awaiting_human`，永不存在）；clarify 另 park `__wg_clarify__` 行 | leader 反问 park 后，在途成员发 `result` → 越 leader cursor → 重唤 leader 跑错假设、孤儿化 clarify session。（成员 clarify-park 安全，靠 assignment awaiting_human）|
| F4 | P1 | **RFC-184 host 输出隔离让 host 节点 clarify 老化失效** → 已答 clarify 每轮重注入永不消 | `scheduler.ts:761`（host `persistDeclaredOutputs:false`）；老化 oracle `clarifyRerunLedger.ts:298-301`（要 `outputRunIds.has`）；`runIdsWithOutput` 读 node_run_outputs | host 恒零 output 行 → 已答工作组 clarify 永不老化 → 每个 wg-leader-round 重注同一 Q&A → 上下文膨胀 + 反复见已解决问题。**注：pre-RFC-184 host 也从不持久化，此为既存潜伏，RFC-184 把它固化——需显式决策 leader 是否该留存已答 clarify** |
| F5 | P1 | leader 反问畸形仅 2 次尝试后 fail **整任务** | `workgroupRunner.ts:1060-1067`/`:165`（`=1`）/`:931-943`（throw→reportFatal）| 正是 2DMA29 死因；两次 JSON 手滑杀整个多 agent 任务、且（F1）不可恢复 |
| F6 | P1(潜伏于 F1) | cursor 在 turn **执行前**推进 → 中途崩的 turn 在 resume 时被静默丢 | `workgroupRunner.ts:1020/1231/1385`（`advanceMemberCursor` 在 `runHostNode` 前）| resume 后 leader cursor 已越内容→`hasUnconsumed` false→崩掉的 turn 永不重跑→引擎误判 idle。**修 F1 前/同时必须修此，否则 resume 会静默跳工作** |
| F7 | P2 | 成员反问畸形零重试（与 leader 不对称）| `workgroupRunner.ts:1253-1291`（仅 CLARIFY_FORBIDDEN 重提示）| 成员 clarify 格式一滑立即烧掉 assignment，无纠正机会 |
| F8 | P2 | leader clarify-park 误报 "leader-idle"；autonomous 压制可把真被阻任务 round/nudge 耗尽 | `workgroupWake.ts:245-267`（humanPending 只看 assignment）；`:263-267`/`:243` | 遥测/UX 谎报 park 原因；autonomous 组 leader 真需人答时只能空转到 max-rounds failed，无处浮出阻塞 |

**贯穿性**：所有工作组**引擎**测试都用 fake hook（`rfc164-workgroup-engine.test.ts:170`）；真 `runHostNode`（真 clarify session 创建、真 merge-back、`scheduler.ts:734-742` 的往返注入）**仅被源码文本锁**（`:735-739`）。无真实 e2e、无 restart→resume 测试（`e2e/crash-recovery.spec.ts` 是通用非工作组）。**这就是「测试全绿而 0/9 真任务完成」的原因——所有失败模式都活在引擎与真 host-hook 之间那条未被执行的缝里。**

## §6 e2e / 测试覆盖缺口 + 配置/UX 陷阱

**头条结论（假设已证实+量化）**：leader_worker / free_collab 引擎——9 个死亡任务走的正是这条路——**零真实子进程 e2e 覆盖**。所有驱动引擎（`runWorkgroupEngine`）的测试都注入 **fake `runHostNode`** 返回罐装 outputs。真 hook `buildWorkgroupHooks`（`scheduler.ts:654-1015`）**只被生产接线引用（`:537/:544`），零测试触及**。唯一用真子进程跑真 `buildWorkgroupHooks.runHostNode` 的是 `rfc167-dw-e2e.test.ts`——但只测 dynamic_workflow 单 host 生成，**从不碰 leader→派发→worker→merge-back→done 多轮循环**。

**覆盖清单（分类）**：STUB=fake hook 返罐装；REAL runNode=经 mock-opencode 子进程直调；REAL hook=经 buildWorkgroupHooks。

| 测试 | 驱动引擎? | runHostNode | 覆盖 |
|---|---|---|---|
| `rfc164-workgroup-engine.test.ts` | ✅×18 | **STUB**（`:164-185`）| 回合编排/协议重试/clarify park/gate——全在 fake hook 上 |
| `rfc185-leader-fanout.test.ts` | ✅×4 | **STUB** | fan-out 派发/唤醒 + 解析源码锁 |
| `rfc167-dynamic-workflow-engine.test.ts` | ✅(DW) | **STUB** | DW 生成/确认/执行 |
| `rfc167-dw-e2e.test.ts` | ✅ | **REAL hook+子进程** | **唯一**真 `buildWorkgroupHooks`——但仅 DW 单节点 |
| `workgroup-host-output-isolation.test.ts`(RFC-184) | ❌ | REAL runNode 直调、hook 手搓复刻 | leader 轮投影红→绿，无 iso/merge/引擎/派发 |
| `rfc183-clarify-invite-accept-symmetry.test.ts` | ❌ | REAL runNode | clarifyChannel directive 契约 |
| `e2e/task-wizard.spec.ts`(Playwright) | ✅ 真 daemon | REAL daemon+stub-opencode.sh | 见 TRAP-3 |
| 其余 rfc164/166/172/179/180/181/182 | ❌ | 无 | 纯函数/源码锁/CRUD |

**「有没有任何测试真跑 leader 轮→解析→派发→真 worker 轮→merge-back→done？」——没有，零。** 缺失的正是 `buildWorkgroupHooks.runHostNode`（`scheduler.ts:656-1009`）**在 `runWorkgroupEngine` 多轮循环语境下**的整个躯体。**堵口模板已在仓内**：`rfc167-dw-e2e.test.ts` 的形状（`startWorkgroupTask(..., {opencodeCmd, awaitScheduler:true})`）直接指向一个 leader_worker 组即可，用 `fixtures/scenario-opencode.ts`（支持 `--agent NAME` 按 agent/轮脚本化）喂多轮信封，断言 `__wg_member__` 真 run 到 done 且任务到 done（**不是** `['done','failed']`）。

**两条反证实锤**（首次执行在生产）：`dc890325 RFC-184` 与 `f40f0dbc RFC-185 @writer` 都是事故后**反应式**修复，测试头都点名回填的生产任务 id（`workgroup-host-output-isolation.test.ts:3`→F42SE、`workgroupRuntime.ts:207`→DP7BXB）；RFC-184 头注直说「工作组引擎测试全部 stub 掉 runHostNode，真实 runNode 路径从未 e2e」。

**配置/UX 陷阱**：

| # | 严重 | 陷阱 | file:line | 现状→影响 |
|---|---|---|---|---|
| TRAP-1 | P1 | 启动就绪检查**无 producer/worker 校验**——leader-only 或纯评审花名册照样放行进死跑 | `shared/schemas/workgroup.ts:270-284`（`workgroupLaunchReadiness` 仅 `no-agent-member`/`leader-missing`）；create 更宽松 `workgroups.ts:340-350` | `test` 组（唯一可派=只读 `task-completion-checker`）绿灯启动 → leader 只能正确判 BLOCKED → 引擎当协议问题 failed。创建/启动都无警告，前端 banner 同源也沉默 |
| TRAP-2 | P2 | `@writer` vs `writer`：花名册/ledger 教模型加 `@`，机器解析的 `member` 字段禁 `@`（已反应式修，残留矛盾）| roster `workgroupContext.ts:212`（`- @${displayName}`）、ledger `:246`、矛盾文案 `:333/351`、修复 `workgroupRuntime.ts:214-217` | 功能已闭（`WgMemberRefSchema` 剥 `@`），但 prompt 仍自相矛盾、仅容忍单个前导 `@`、且**无 renderRosterBlock token 真过 parseWgAssignmentsPort 的往返测试**→ roster 格式一漂移可静默重引入 fatal |
| TRAP-3 | P2 | 唯一的 Playwright 工作组「e2e」容忍失败、且从不产合法 wg 信封 | `e2e/task-wizard.spec.ts:159`（`expect(['done','failed'])`）；`stub-opencode.sh:63`（固定 `<port name="answer">`）| **一个 failed 的工作组也算测试通过**；stub 发非 wg 信封→投影后 host 拿到空 wg 端口。这就是「生产 0 done 却从不触发红测」的最后一环 |

---

## §7 系统性根因（收敛后）

**两个 P0 联合解释「10 任务 0 done」，一个 meta 根因解释「为什么这俩 bug 能上线且反复」：**

- **P0-A｜leader/member 首轮死于任何信封/协议手滑（round 0）**：协议块无 `<workflow-output>` 完整范例（§2 P0-2）× `envelope-missing`/畸形输出零重试直接 throw fatal（§2 P0-1、§5 F5）× 重提示笼统、按 errorMessage 字符串前缀反推、结构化 `failureCode` 在 hook 边界被丢（§2 P1-3/4/5）。DP7BXB 一个任务演全（§1.2）。
- **P0-B｜任意 daemon 重启中途 = 永久死亡**：`interrupted` 的 turn-engine 工作组**零恢复路径**（三处已提交拒绝 + 锁定测试，§5 F1）；即便手动戳消息也只建悬空 assignment 不驱动（§5 F2）；`running` assignment + 终态 node_run 无对账、且算 blocking 冻住 leader（§4 F1）；cursor 在 turn 前推进使崩掉的 turn 在 resume 后被静默丢（§5 F6）。**3/10 任务即死于此，且不可恢复。**
- **Meta 根因｜真实运行路径零 e2e 覆盖**：所有工作组引擎测试 stub 掉 `runHostNode`（§6、§3-1、§5 贯穿性），真 `buildWorkgroupHooks.runHostNode` 在多轮循环语境下**从未被任何测试执行**。于是 P0-A/P0-B 都能带病上线，且每来一个真任务就在这条未测缝里发现一个新集成 bug——**串行 whack-a-mole 的机制根源**。两条反证实锤：RFC-184/RFC-185 都是事故后反应式修、测试头点名回填的生产任务 id。

**第三结构性成因（贯穿 P1）**：工作组另写一套重试/校验/老化，**不复用已打磨的普通节点机制**（`FOLLOWUP_POLICY`/`decideEnvelopeFollowup`/RFC-131 派生老化），反复重踩早已解决的坑——§2 不对称表 + §5 F4（RFC-184 让 host 老化失效）即实证。

**注意**：§3 已证实——**假设 leader/member 轮修好，回合循环+聚合+收尾机械上能到 done**。所以这不是「架构跑不通」，是「一条从未被真实执行过的链上积了两个 P0 + 一串 P1」。修完 P0-A/P0-B 并补上真实 e2e，第一次绿是够得着的。

## §8 修复路线（优先级 + 相位）

> 建议立 RFC（或小 RFC 序列）：这是跨多区硬化 + 新 e2e 基建 + 恢复行为变更，超出单行 bug。Phase 0 单独即一个自洽 RFC，验收=**驱动一个真任务跑到 done**。

### Phase 0 — 到第一次绿（P0-A + 真实 e2e）
1. **信封修复对齐普通节点**（§2 P0-1/P1-3/4/5/6、§5 F5/F7）：`WorkgroupHostRunResult` 加 `failureCode`，leader+member 失败分支改按 `FOLLOWUP_POLICY`/`decideEnvelopeFollowup` 分派而非 `startsWith`；`envelope-missing`/畸形输出/畸形 clarify 全进重试；`WG_PROTOCOL_RETRIES` 提到普通默认量级；重提示注入理由化文案 + 分 kind 修复块。fatal 只留真致命码（iso/injection/merge/spawn/timeout）。
2. **协议块补 `<workflow-output>` 完整范例**（§2 P0-2）：抽共享常量（与 `buildProtocolBlock` 同源防漂移），按 role 渲染；对齐 clarify 块已有的 `CLARIFY_FORMAT_EXAMPLE`。
3. **真实子进程 e2e smoke**（§6、§3-1）：以 `rfc167-dw-e2e.test.ts` 为模板指向一个 leader_worker 组，`scenario-opencode.ts` 按 agent/轮喂多轮信封，断言 `__wg_member__` 真 run 到 done + 任务到 done（非 `['done','failed']`）。**这是 Phase 0 的验收面。**

### Phase 1 — 别再永久死（P0-B 恢复）
4. **接通 interrupted 恢复**（§5 F1/F2）：去掉 `autoResume.ts:77` 过滤或加房间级 resume（走 `resumeTask` 服务绕过 builtin-403，如 `taskQuestions.ts:176` 先例）；消息/deliver/patch 的 kickResume 对任何可恢复态触发。
5. **前置修 cursor-before-turn**（§5 F6）：cursor 改 turn 效果持久化**后**推进（或同事务），否则 resume 会静默跳工作——**必须先于/同步于第 4 项**。
6. **重启对账**（§4 F1）：引擎载入时对「node_run 终态但 assignment 仍 running」对账——merged/done→CAS assignment done；interrupted/failed→重派或 failed。加 restart→resume e2e。

### Phase 2 — 硬化（P1）
7. TRAP-1 启动就绪加 `no-non-leader-worker`/缺 producer 警告（§6）。
8. leader `continue` 不派发的处理：autonomous 无条件走 nudge、或强制 `continue` 须带 assignments/阻塞说明（§3-2）。
9. maxRounds 重试膨胀：按逻辑轮计数、退休重试行的 rerunCause（§3-3）；cap 到达改 park/最后一轮强制 wrap-up（§3-7）。
10. fan-out：重叠写改**逐路径**救回（清洁子树落地、仅冲突路径 park）+ 结构化「丢了 N 文件」note；merge agent 移出 writeSem、仅最终 materialize 再夺锁（§4-2/3）。
11. clarify：`leaderParked` 从真信号（open leader clarify session）派生（§5 F3）；host 节点老化补非 output-行的「已消费」信号 + 显式决策是否留存（§5 F4）；park 标注区分 idle vs 待答（§5 F8）。

### Phase 3 — 潜伏（P2）
12. `postMessage` 用 monotonic ULID（§3-4）；adopted dispatched CAS 补齐（§3-5）；禁 `done`+assignments 同轮（§3-6）；工作组 conflict-human 保 iso/不删 refs 或显式 abandon（§4-4）；fan-out 单波共享 base 快照（§4-6）；TRAP-2 roster/协议文案调和 + 往返测试；TRAP-3 收紧 Playwright 断言 + wg-aware stub（§6）。

### 覆盖总原则
每个 Phase 的交付都要带**真实子进程**测试（能触到 `buildWorkgroupHooks` 的那条缝），而非再加一条 stub-hook 引擎测试——否则修完仍是「测试绿、生产死」。
