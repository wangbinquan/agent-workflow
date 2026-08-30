# RFC-338 实施计划 — 重维护 Worker 隔离与每日维护时刻

状态：Done（2026-08-30）；用户已于 2026-08-28 批准 `proposal.md §5 D1–D11`，随后明确授权完整实现、提交与
推送。T0～T11 均已完成，final functional exact SHA、Main CI 与 8 个 scheduled workflows 全部闭合。

## 1. 实施原则

1. 先建立可复现的 maintenance freeze oracle，再迁执行面；不能只看到耗时日志减少就宣布完成。
2. 每个 job 按“characterization → worker adapter → 原主 timer body 归零”原子切换，不 shadow 双跑。
3. correctness/recovery 先从 mixed tick 拆出并锁原 cadence，再改变执行位置。
4. Worker 不可用时不回退到主事件循环执行重 body；显示 degraded、恢复 Worker 或停止该 job。
5. 每个 DB/FS mixed effect 先定义 crash fault points 与恢复协议，再接 durable run ledger。
6. 只在批准后的任务范围改动；不夹带 PostgreSQL、普通 query pool 或无关架构 wave。
7. shared `main` 上按现行短 Git 临界区、精确 path staging 和 candidate-content gate 规则交付。

## 2. baseline 与 source-lock

T2 开工前 fetch/sync 并从 committed blob 重采以下 source-lock；任何结果变化先更新 RFC：

| ID  | source pin `251b5d725` 上的事实                                | target                                                                           |
| --- | -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| S1  | `DbClient` 生产提及约 303 files                                | RFC-338 新 job application contracts 不新增直接依赖；目标 owner 逐项收口         |
| S2  | `dbTxSync` 约 81 files                                         | 本 RFC 只迁 maintenance-owned transaction，不虚报全仓归零                        |
| S3  | `bun:sqlite` 约 29 files                                       | maintenance Worker connection 仅 platform SQLite adapter/entry 可直接使用        |
| S4  | `@/db/schema` 生产 import 约 258 files                         | 本 RFC job ports 不 import；全仓迁移留后续 RFC                                   |
| S5  | `MAINTENANCE_PHASE` 14 keys                                    | 每个 key exact 分类；heavy/recovery/lightweight 无遗漏                           |
| S6  | `startMaintenanceTicker` production callers 另含 human-gate    | heavy caller body 归零；recovery 走新 worker admission；lightweight 明确留主进程 |
| S7  | `startWalCheckpointLoop` 在主连接同步 TRUNCATE                 | checkpoint body 迁 Worker，监督/跳拍水位 oracle 不变                             |
| S8  | `worktreeGc` 一拍串 6 段且混 recovery                          | durable recovery 与 proactive cleanup 拆分                                       |
| S9  | `intentScratchGc` 混 scratch + 3 条 recovery                   | cleanup/recovery 拆分，原恢复最坏延迟不增大                                      |
| S10 | events/retention/webhook/task archive 已有 batch，但仍连续同步 | cursor-driven slice + Worker + bounded transaction                               |
| S11 | 现有唯一 Worker 先例为只读 backup VACUUM                       | generic maintenance write/FS Worker 不复用主 DbClient                            |
| S12 | RFC-311 perf bench 是大 seed + 顺序 `app.request`              | 新增真实 socket 并发 HTTP/write/WS gate                                          |

重采产物写入 RFC-338 test fixture/bench report，不把 shell 输出手抄成无人校验的永久数字。

## 3. 任务分解

| 任务        | 内容                                                                                                                                                         | 依赖  | 状态                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ----------------------------------------------------------------------------- |
| RFC-338-T0  | current-source 调研；完成 proposal/design/plan、总索引与 STATE；不改生产代码                                                                                 | —     | Done                                                                          |
| RFC-338-T1  | 用户逐项批准或修改 D1–D11；实现前重采 source-lock、shared tree owner/index/remote                                                                            | T0    | Done                                                                          |
| RFC-338-T2  | 建 freeze characterization、job inventory guard、真实 socket HTTP/WS/foreground-write harness 与旧实现 red target assertions                                 | T1    | Done                                                                          |
| RFC-338-T3  | 定义 shared schedule/status schema、closed job catalog、IPC/cursor/result contracts；新增 durable `maintenance_runs` migration/store/CAS tests               | T2    | Done                                                                          |
| RFC-338-T4  | 实现 platform background coordinator：hourly phase、daily IANA/DST、boot catch-up、hot apply、coalescing、priority/fairness                                  | T3    | Done                                                                          |
| RFC-338-T5  | 实现 Worker entry/supervisor/handshake、worker-owned SQLite profile、busy/backoff、heartbeat/lease/crash restart 与 graceful drain                           | T3–T4 | Done                                                                          |
| RFC-338-T6  | 迁 DB-first jobs：webhook delivery GC、retention、events archive DB slice、token audit、development retention；原 main body 归零                             | T5    | Done                                                                          |
| RFC-338-T7  | 迁 mixed DB/FS jobs：events/task archive effect recovery、backup prune、plugin generation、upload/input、proactive worktree/iso/scratch/orphan/partial clone | T5–T6 | Done                                                                          |
| RFC-338-T8  | 拆并迁 correctness：workspace cleanup recovery、intent journals/working sets/resource bundles、lifecycle invariant、human-gate；锁 boot/cadence/delta        | T5    | Done                                                                          |
| RFC-338-T9  | 迁 WAL checkpoint；完成 status API、设置页 maintenance card、last/current/next/backlog/error、i18n/390px/keyboard                                            | T4–T8 | Done                                                                          |
| RFC-338-T10 | 跑 per-job fault/characterization、常规 50-client 大库门、scheduled 100-client soak、mutation/architecture/full gate；生成指标报告                           | T6–T9 | Done：本地 50-client 与 final exact-SHA hosted 100-client/full-seed 均 PASS   |
| RFC-338-T11 | 精确提交/推送，验证 commit path/trailer/remote ancestry 与 exact-SHA CI/scheduled soak；回填 RFC/STATE/索引为 Done                                           | T10   | Done：实现 ancestry、Main CI 35/35 与同 SHA 8 个 scheduled workflows 均已核验 |

## 4. 实施波次

### T0 — RFC 与证据（本轮）

- 对拍 RFC-311/RFC-322/RFC-294、当前 ticker、batch 与 Worker 先例；
- 明确“改每天”只移峰，Worker + 锁/批次/恢复边界才是根因修复；
- 把 14 个任务分为 cleanup/recovery/lightweight，并把 checkpoint 纳入；
- 固定 daily/hourly、热更新、missed/coalesced、DST、backlog spill 与 scale claim 边界；
- 只写 5 个文档路径：RFC 三件套、`design/plan.md`、`STATE.md`。

退出：Markdown/链接/状态/source pin 一致；工作树没有生产代码 diff；等待用户批准。

### T1 — 批准与 live baseline

- 用户确认 D1–D11，尤其是 default hourly、daily 只是启动时刻、correctness 不降频、PostgreSQL 后续；
- fetch `origin/main`，重采 S1～S12 与当前 14-key inventory；
- 检查其他 session 的 shared WIP/owned paths/index；若 overlap 会 conflation，先协调。

退出：批准记录回填 proposal；source-lock fixture 来自 live committed blob；无未确认裁决。

### T2 — 先造会失败的用户结果门

- 绑定真实 loopback server，不只调用 `app.request()`；
- 同时运行 HTTP read/write、WS heartbeat 与 synthetic 2s synchronous maintenance body；
- 在旧实现上锁定可观察 freeze，并让 target assertion“maintenance body 必须在 Worker”转红；
- 为每个 job 记录输入 seed、row/file result、通知 delta、cadence、config snapshot、error behavior；
- 建 periodic-heavy census，扫描 `setInterval/startMaintenanceTicker/DbClient/sync FS` 生产链。

退出：旧结果 characterization 绿；target isolation/catalog tests 在旧生产接线上按预期红；测试不依赖等待一小时。

### T3 — 合同与 durable ledger

- 抽/复用 daily wall-clock schema；Config 默认 `{kind:'hourly'}`，patch/compat/draft tests；
- 建 `MaintenanceJobSpec` closed registry 与 main/Worker digest；
- 建 protocol V1 exact codecs，拒绝 unknown version/job/result delta；
- 新增 `maintenance_runs` migration、schema、CAS lease/cursor/settle store；
- 覆盖 unique slot、stale lease、late receipt、unknown cursor version、indexed last/backlog query；
- 定义 per-owner strict config snapshot/cursor/delta，不传整份 Config/DbClient/callback bag。

退出：纯合同/ledger tests 全绿；migration replay/schema admission 通过；production job 尚未 shadow 执行。

### T4 — schedule coordinator

- hourly 保留 current phase；daily 使用现有 IANA/DST 纯算法；
- 实现 future timer 取消/重算、同当地日期去重、30s boot catch-up、missed 多拍合一；
- 长 cycle 跨 slot 只 coalesce pending，绝不并发；
- 接 `registerConfigAppliedListener`，仅成功写盘后热应用；
- supervisor live projection 提供 next/current/backlog，不由 route 重算另一套时间。

退出：fake-clock matrix 覆盖 00:00/23:59、gap/overlap、timezone change、同日改晚、重启、长 cycle、stop；
hourly phase golden 与 RFC-322 相等。

### T5 — Worker 执行底座

- Worker 在 migrations 后打开独立 SQLite WAL connection，短 `busy_timeout`；
- 主/Worker 握手对拍 protocol/catalog digest，所有消息 strict parse；
- 单 active slice priority queue，recovery 可在 cleanup slice 间抢占，同级 FIFO/round-robin；
- lease heartbeat、bounded restart、drain/terminate、late-message fence；
- SQLite busy/locked 分类、bounded exponential backoff、success cooldown、foreground-pressure hint；
- Worker degraded 时不把 job body接回 main。

退出：2s Worker block 下 HTTP/WS assertion 转绿；两连接 foreground-write test 过阈值；crash/handshake/queue mutations 全红。

### T6 — DB-first job cutover

建议每个 job 在同一 candidate 内执行：characterization → adapter/runSlice → worker registry → main body 删除 → source guard 归零。

顺序：

1. token audit（窄、DB-only，用于验证完整路径）；
2. webhook delivery GC；
3. generic retention sweep；
4. development retention；
5. events archive 的 DB selection/delete 与 cursor（文件 effect 留 T7）。

每个写 slice 单事务、bounded IDs、predicate recheck、cursor 同事务推进；`SQLITE_BUSY` 不推进。

退出：每 job 原结果同形，主 timer body=0，transaction p95/max 满足门；失败不会跳 row/cursor。

### T7 — DB/FS mixed 与 proactive cleanup

- 为 events/task archive 建 staged segment 或等价 offset/digest journal，锁 append/delete fault points；
- backup prune、plugin generation、development upload、employee input 使用 idempotent path effect/receipt；
- worktree chain 拆为 cursor phases，proactive worktree/iso/scratch/orphan/partial-clone 纳入 heavy schedule；
- 递归删除前后 durable fence，active snapshot 只 advisory；
- 文件 I/O 期间不持 SQLite write transaction；单次慢 FS 操作带 job/run/path-class metric。

退出：每个 prepare/effect/finalize fault point crash 可恢复；无 duplicate archive、无 active workspace 删除、无主线程 sync FS。

### T8 — correctness/recovery cutover

- worktree claimed/interrupted recovery 与 proactive cleanup 分离；
- intent scratch 与 apply journal/queued working sets/resource-bundle recovery 分离；
- lifecycle invariant 和 human-gate scan/decision 在 Worker，main 只消费 typed delta/admission；
- recovery 使用原 bootDelay/interval，priority 高于 cleanup；
- 如果某 owner 缺 durable fence/typed action，先补 owner 合同，不把 scheduler/runtime callback bag 注入 Worker。

退出：原 cadence worst-case 不增大；boot/crash/restart oracle 同形；把任一 recovery 改成 daily 的 mutation 必红。

### T9 — checkpoint、状态与 UI

- `startWalCheckpointLoop` 只产生 Worker run，snapshot skip/成功水位语义保持；
- status projection 合并 live Worker heartbeat 与 indexed durable last/backlog；
- 设置页“存储与保留”新增 maintenance card，纳入 draft/save/discard；
- hourly/daily、HH:MM、IANA timezone、field error、last/current/next/backlog/error 完整呈现；
- component/E2E 锁 hot apply next-run、正在运行不取消、390px、keyboard/focus。

退出：主连接 checkpoint production call=0；UI 不靠日志；未知/degraded/failed 不伪装 healthy。

### T10 — 验证与报告

- 常规 gate：目标 unit/integration/architecture/backend/frontend/E2E/typecheck；
- fault corpus：Worker/DB/FS/config/shutdown 每个 linearization point；
- 50-client large-seed gate 与 100-client scheduled soak；
- 对拍 control/maintenance 指标，检查 proposal AC-1～AC-12；
- 运行完整 mutation 集：worker hop、batch、busy backoff、fence、slot unique、recovery class、timezone；
- 同一 task candidate 最多一轮完整本地 gate，未改 task content 时复用，不因 unrelated HEAD 前移重跑。

退出：硬阈值与业务 oracle 全过；报告固定 exact seed/command/SHA/runner；任何 ≥1s 全站停顿均阻塞发布。

### T11 — 发布与 closeout

- 进入 shared index 临界区前 fetch/sync，确认 cached entries 为空或全部已显式 handoff；
- exact path staging，核对完整 staged path/diff 与真实 material contributor trailer；
- commit 后核对 paths/message/trailer，再 fetch/sync/push；
- 证明实现 commit 是 `origin/main`/containing SHA 祖先；跟踪 exact-SHA 主 CI 和 scheduled soak 到 terminal success；
- 回填 proposal/design/plan、总索引、STATE 的 commit/run/metric 证据并置 Done。

退出：本地 `main == origin/main`，或报告具体同步 blocker；queued/cancelled/无关 containing run 不冒充 green。

## 5. 预计 owned paths

最终以批准后 live source-lock 与实际 diff 为准，预计：

- `design/RFC-338-maintenance-worker-daily-window/**`
- `design/plan.md`、`STATE.md`
- `packages/shared/src/schemas/config.ts` 及 daily wall-clock/status/IPC contract 的必要 shared 文件
- `packages/backend/db/migrations/**`、`packages/backend/src/db/schema.ts`
- `packages/backend/src/platform/background/**`
- `packages/backend/src/platform/persistence/sqlite/**`
- 各 owner 的 `modules/*/{application,infrastructure,composition}/**` maintenance slice
- legacy `packages/backend/src/services/{daemonCadence,maintenanceTicker,gc,eventsArchive,maintenanceRetention,taskArchive,backupScheduler,pluginGenerationGc}.ts`
  中原生产接线的必要迁移
- `packages/backend/src/services/webhook/**`、`packages/backend/src/cli/start.ts` 的 composition cutover
- config/status route 与 `packages/backend/tests/**` RFC-338 gates/bench harness
- `packages/frontend/src/routes/settings.tsx`
- `packages/frontend/src/lib/settings-drafts.ts`
- `packages/frontend/src/i18n/{zh-CN,en-US}.ts` 与目标 frontend/component/E2E tests
- scheduled workflow/bench report 的精确文件

不预计修改普通业务 query、auth/ACL、代码平台凭据、task execution 结果合同或 PostgreSQL driver。共享文件包含并发输出时，
提交前逐 hunk 对账并完整保留；非 RFC-338 path 不暂存。

## 6. 测试矩阵

| 维度           | 最小覆盖                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| schedule       | hourly 14 phase；daily 正常/gap/overlap；timezone change；同日改晚；missed/catch-up/coalesce                 |
| config         | default compat；PATCH merge；invalid time/tz；persist-before-hot-apply；running snapshot 不变                |
| IPC            | hello/digest；unknown version/job/delta；duplicate/late event；status request；drain                         |
| lease          | unique slot；stale takeover；old token CAS fail；commit-before-ack；succeeded no resurrection                |
| queue          | recovery priority；cleanup FIFO/round-robin；busy defer；foreground pressure；no two active slices           |
| SQLite         | read/write contention；short transaction；busy timeout；cursor atomicity；checkpoint skip/retry              |
| FS effects     | stage/rename/finalize；duplicate append guard；disk full；already missing；recursive delete crash            |
| active race    | active before scan/after scan/before delete；daemon restart after claim                                      |
| job parity     | 每个 cleanup/recovery 的 rows/files/delta/error/cadence/config snapshot                                      |
| responsiveness | synthetic 2s block；50/100 clients；HTTP read/write；WS heartbeat；event-loop gap                            |
| UI             | draft/save/discard；hourly/daily field visibility；error；last/current/next/backlog/degraded；390px/keyboard |
| architecture   | heavy main body=0；catalog exact；lightweight-main no DB/sync FS；module ports no SQLite/Drizzle             |
| regression     | backup/restore、archive/readback、task/workspace lifecycle、intent/human-gate recovery、existing settings    |

## 7. AC 证据账本

| AC    | 主要证据                                                           | 交付记录                                                                                                            |
| ----- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| AC-1  | real socket + 2s Worker block test；event-loop/HTTP/WS metrics     | Done：`rfc338-maintenance-responsiveness.test.ts`，真实 HTTP/WS 在 2s 同步 Worker block 中持续响应                  |
| AC-2  | two-connection foreground-write contention + transaction histogram | Done：`rfc338-maintenance-slices.test.ts`，50ms maintenance busy timeout 后同 cursor 可重试                         |
| AC-3  | periodic-heavy census + main body zero architecture guard          | Done：`rfc338-maintenance-architecture.test.ts` closed catalog/main-body-zero/build-entry guard                     |
| AC-4  | mixed-tick split/cadence characterization + mutation               | Done：intent/worktree/human-gate/lifecycle 分类与 production-call source guards；原 cadence 回归通过                |
| AC-5  | shared daily schema/time algorithm golden                          | Done：schema + 9-case schedule suite覆盖南北半球 DST、leap day、00:00/23:59                                         |
| AC-6  | fake-clock hot apply/restart/missed/coalesced slot suite           | Done：schedule/store suite覆盖 hot apply、boot catch-up、slot/queued 合并与 stale recovery                          |
| AC-7  | Worker/lease/DB/FS fault injection matrix                          | Done：Worker crash/心跳/late event、lease/CAS、running+queued、SQLite BUSY 与 archive 四个 journal fault point 已锁 |
| AC-8  | per-job characterization oracle                                    | Done：owner/perf 回归与 bounded slice/readback 通过，统一记录在 `verification-report.md`                            |
| AC-9  | active-task snapshot/claim/fence race corpus                       | Done：RFC-165 scan 后变 active 的 durable terminal CAS race 回归通过                                                |
| AC-10 | settings component/E2E/visual/keyboard                             | Done：component + 390px/browser + compiled-binary E2E；final Main/visual/webkit/windows workflows 全绿              |
| AC-11 | 50-client gate + 100-client scheduled soak report                  | Done：本地 50-client PASS；exact SHA `c5c4faaf…` 的 100-client run `33298851934` PASS，错误 0、所有 gap <1s         |
| AC-12 | mutation receipts                                                  | Done：Worker/main timer/batch/count/BUSY/fence/slot/recovery/timezone/foreground transaction mutations 全部被杀死   |
| AC-13 | exact commit/SHA/CI/soak ancestry and terminal status              | Done：主实现为 exact SHA 祖先；Main `33298828254` 与同 SHA 8 schedules 全部 `completed/success`                     |

## 8. 停止门与回退

实施中遇到以下任一项，停止对应 cutover并更新 RFC/请用户裁决：

- Worker 独立连接无法在目标 Bun/SQLite 版本保持 WAL/foreign-key/transaction 语义；
- 任一 job 无法在不削弱现有 durable eligibility/fence 的前提下离开主进程；
- archive mixed effect 无法证明 crash 后不重复/不漏删；
- transaction/busy 调优后仍出现 maintenance-attributed ≥1s foreground freeze；
- correctness/recovery worst-case cadence 被 daily 或 queue starvation 拉长；
- 配置默认/时区/DST 语义需要改变 D2/D3/D7；
- 实现必须扩大到普通 query pool、PostgreSQL 或多实例才能满足本 RFC AC。

运行期不允许以“Worker 失败就把旧 onTick 接回主线程”作为 fallback。可接受回退是：停止受影响的 cleanup admission、显示
degraded、保留 durable pending/cursor、修复/重启 Worker；正确性 job 的不可用状态必须显式暴露并按 owner 原有启动失败语义处理。

## 9. 完成后的下一步

RFC-338 交付后，以 soak 中的普通请求同步 SQL latency、write contention 和运行资源曲线决定 PostgreSQL/persistence RFC 的优先级。
后续 RFC 必须单独给出端口迁移 wave、双写/切换或停机迁移方案、control plane/execution worker/文件存储 ownership 和多实例证据，
不能把 RFC-338 的 Worker 成功外推成“数据库和平台已经无限扩展”。
