# RFC-215 — free_collab 双轨调度与批量认领（plan）

- 状态：Done（2026-07-21 实现落地；见下方交付记录）
- 默认单 PR 交付（规模可控、改动集中 fc 链路）；commit 前缀
  `feat(workgroup): RFC-215 …`。

## 任务分解

| # | 任务 | 依赖 | 内容 | 验收 |
| --- | --- | --- | --- | --- |
| RFC-215-T1 | shared 协议原语 | — | `WG_PORT_TASK_RESULTS` / `WG_FC_CLAIM_BATCH_LIMIT` / `WgTaskResultItemSchema` / `parseWgTaskResultsPort(raw, batchSize)`（missing 覆盖检查）/ `parseBatchShardKey`（memberId+ids 编解码单一事实源）/ `wgClarifyAskerKey` 批分支（`asg:batch:{memberId}`，design §6.3） | 设计 §10-17 单测 + askerKey 稳定性 |
| RFC-215-T2 | migration 0105 `attempt_count` | — | ALTER TABLE 加列；journal `when=1786464000000` 接轴；`upgrade-rolling`（:230,:304）104→105 bump；`rfc189-wg-round.test.ts:151` 冻结 fixture 改显式列裸 SQL（design §5 点名） | 设计 §10-19 |
| RFC-215-T3 | wake 双轨拆分 + 批量配对 | T1 | `WakeInput.inFlight.taskTurnMemberIds?`（optional，先例 leaderClarifyParked）；配对排除/恢复判定两维度拆分（design §2.1，lw 保合并）；fc 派发重排（恢复批→新配批→消息轨）；均分算法 + 边界短路（idle=0/open=0/空切片不产 item）；`fc_claim.assignmentIds[]` | 设计 §10-1..7 纯函数测 |
| RFC-215-T4 | 引擎批量 drive + `batch:` 消费点适配 | T1,T2,T3 | `driveBatchTurn`（逐卡 CAS+`bumpAttempt`、`batch:{member}:{ids}` shardKey mint、逐卡落库、漏报/自报 failed/整批失败回 open、clarify 整批泊/续、throw 收口批量化 §3.2-8）；`wakeKey`/`markInflight`/领养环适配（含 `msg:` 行补登记 §3.1）；**§9 清单逐点**：`reconcileRunningAssignments` 改按 `nodeRunId` 直查、`dismissOpenClarifyParksForAutonomous` 批 inArray requeue、`workgroupRoom.ts` `runKindOf`/presence/clarify 投影批分支；fc 游标移交（删批路径 `advanceMemberCursor`，lw 保留） | 设计 §10-8..16 引擎测 + §10-20 源锁 |
| RFC-215-T5 | 注入与协议块 | T1 | `composeMemberPrompt` 按调用方劈开（lw 单卡逐字不变；fc 恒批形态含 N=1，design §4）；`selectMemberSlices` `omitMentions` + 尾窗模式；`wgHostRolePorts(role, batch?)` + `renderWgProtocolBlock` 批量分支（明示不用 `wg_result`）+ 镜像锁平移扩展 | 设计 §10-18 + lw 零 diff 断言 |
| RFC-215-T6 | 既有测试改动清单落实 | T3,T4,T5 | design §11 逐行：rfc164-core claim pairing 改写、rfc164-engine fc 链 fixture 改 `wg_task_results`、`retry-budget-single-source` 锁串同步、`rfc186-resume-reconcile` cursor 计数核对 | §11 表全绿 |
| RFC-215-T7 | 前端批徽记 | T4 | 清单区按 `nodeRunId` 分组"批 ×N" chip（复用既有 chip 类）；i18n zh/en；vitest | 设计 §7 / AC-10 |
| RFC-215-T8 | 收尾登记 | T1–T7 | `design/plan.md` 索引置 Done、`STATE.md` 执行日志、AC 清单勾核、**回写 RFC-164 design §4.2/§4.3/§6.3 修订标注**（指向本 RFC，design §12-15） | 门槛四件套 + build:binary + CI 绿 |

## 验收清单（对应 proposal AC）

- [x] AC-1 两轨互不占用（`rfc215-fc-dual-track.test.ts`：S2 反转正反两向 + 同轨互斥 + S1 反转双轨合法）
- [x] AC-2 均分 + 上限 5（同上：7/2⇒4+3、11/2⇒5+5 剩 1、3/5⇒1+1+1 无空批、idle=0/open=0 短路）
- [x] AC-3 `wg_task_results` 逐卡汇报（`rfc215-batch-engine.test.ts`：漏报重试点名缺卡→耗尽已报卡照落缺卡回 open；误发 `wg_result` 走同一重试路径点名换端口，不静默）
- [x] AC-4 失败语义 + `attempt_count`（认领即计数、自报 failed 回 open、预算封顶留 failed、整 run 失败整批回 open；drive throw 收口经共享 `settleCardAfterFailure` 子例程覆盖）
- [x] AC-5 游标单一归属（批 run 后 cursor 表零行；lw 路径保留推进——`rfc186-resume-reconcile` 计数锁原样绿）
- [x] AC-6 预算末端批优先（S3 反转：剩 1 格批占格、消息 capExceeded）
- [x] AC-7 崩溃恢复矩阵 v2 三行全测（失驱重配不重计数 / interrupted⇒redispatch 重跑 / host done⇒0 次调用收卡）——顺手实锤并修复 RFC-186 遗留 bug：转移表从无 `running→dispatched`，单卡时代 reconcile redispatch 一触即抛炸引擎重入
- [x] AC-8 lw 零变化（rfc164 全套原样绿 + 新增 lw merged-busy 锁 + lw 恒无 fc_claim 锁）
- [x] AC-9 收敛/终局判定不变（rfc164-engine fc 收敛/确认门/deadlock 原测试绿）
- [x] AC-10 前端批徽记（`wg-fc-batch-*` chip 复用 `.chip--tight`）+ 房间可见性（`runKindOf`/classify 批分支，`rfc179-member-current-run` 新锁：卡表为空也能按 key 归属）+ zh/en i18n
- [x] AC-11 askerKey 跨批稳定（`rfc215-batch-claim-primitives.test.ts`：同成员两批同 key `asg:batch:{member}`；lw/msg key 不变）

## 交付记录（2026-07-21）

- 实现按 T1→T8 单批落地；`design.md §11` 既有测试改动清单逐行兑现：core claim-pairing
  改写为批断言、engine fc fixture 换 `wg_task_results`（`doneBatchMember`）、
  `retry-budget-single-source` 锁串 `priorRuns`→`attemptCount`、
  `rfc186-resume-reconcile` cursor 计数 3 处不变原样绿、镜像锁 arity 兼容原样绿、
  `rfc189-wg-round` 冻结 fixture 改显式列裸 SQL、`WakeInput` 新字段 optional 九处
  字面量免改。
- 门槛：typecheck / lint / format:check / shared 1354 / frontend 5044（含新批徽记锁）
  / `build:binary` smoke 全绿；后端全量见 STATE.md 记录。

## 风险与缓释

- **`batch:` shardKey 存量消费点**：设计门盘出全量清单（design §9，6 处需适配 + 3 处
  免改），T4 逐点落实——这是 v1 最大盲区（3 镜头交叉坐实 3 条 P1），实现时以 §9 表
  为准逐项勾核。
- **既有测试锁**：design §11 是"会红清单"，T6 专项处理；按
  [feedback_grep_locks_before_push] 改符号前再全量盘一遍锁。
- **改动半径**：wake 纯函数独测充分；引擎批量路径与 lw 单卡路径共享落库/失败收尾
  子例程（§3.5 反 fork 红线），lw 走原路径不动。
- **迁移**：单列 ADD COLUMN 回滚安全；工程纪律见设计 §5（journal 单调 / 计数 bump /
  冻结 fixture 点名改裸 SQL）。
- **模块环**：`workgroupRounds` 头部已有初始化环警告——本 RFC 不新增顶层派生 const；
  push 前必跑 `bun run build:binary`。
- **门槛**：`bun run typecheck && bun run lint && bun run test && bun run format:check`
  全绿 + push 后按 sha 查 CI。
