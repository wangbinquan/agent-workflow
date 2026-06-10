# agent-workflow 节点调度子系统问题调研报告

> 调研对象：`/Users/wangbinquan/Documents/proj/agent-workflow` 后端调度子系统（`packages/backend/src/services/scheduler.ts` 及其卫星模块 dispatchFrontier / freshness / task / runner / clarify / review / crossClarify / lifecycleInvariants / lifecycleRepair / commitPushRunner / util/git）。
> 方法：多智能体分维度（frontier / wrappers / lifecycle / concurrency / freshness / history / architecture）调研，每条发现经对抗式核实（尽力推翻）。本报告只把**核实通过**的发现列入正文清单；核实者意见分歧或未经核实的单独放附录。

---

## ① 总评

调度子系统经过 23 天高速迭代（RFC-053 生命周期状态机、RFC-060 fanout、RFC-074 provenance/freshness、RFC-075 commit&push、RFC-076 completion-driven frontier）已经具备了相当完整的能力面，且近期两轮测试补强（commit `8859a67` 的门控真实-IO 防护 + clarify 三写一致 oracle、`b28377e` 的 124 个组合/边界用例）确实把若干历史事故路径锁住了——对抗核实中有三条"历史模式类"指控正是因为现网已有专项回归测试而被部分推翻（cross-clarify 门控回归、fanout 并发上限、isFresherNodeRun 基线，详见附录 B）。

但本次调研确认了 **2 个 P0、9 个 P1、15 个 P2、2 个 P3** 现存问题，整体画像是：**单次顺跑的 happy path 是稳的，"恢复 / 重试 / 反问 / 嵌套 wrapper / 并发"五个轴一旦组合就进入无防护区**。最危险的共性形态是"静默错误"——任务显示成功但消费了空输入 / 旧输出 / 被污染的 worktree（S-2、S-5、S-6、S-7、S-20），或者以一句无诊断价值的 `scheduler stalled` 假失败收场（S-1、S-12、S-22）。这些问题高度同源：状态分桶手工枚举、freshest-row 判定多处 fork、首跑/恢复双轨实现、并发守卫靠 call-site 约定——与既往热点调研排队的重构方向（decideScopeOutcome 抽取、freshest-run 收敛、nextTaskStatus CAS、clarify 收敛）完全吻合，本报告第 ④ 节把确认问题映射进了那条既有队列，不另起炉灶。

---

## ② 确认问题清单（按严重级排序）

> 严重级以对抗核实后的共识为准：核实者明确改判的按改判级别列出并注明；多维度重复上报的已合并（标注合并来源）。所有路径相对 `packages/backend/src/`。

### 速查表

| 编号 | 级别 | 一句话                                                                                                   | 主要位置                                                        |
| ---- | ---- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| S-1  | P0   | 运行中答复 clarify / 提交 review 决策被 `dispatchedThisInvocation` 永久屏蔽 → 假失败 `scheduler stalled` | services/scheduler.ts:606,636,1123                              |
| S-2  | P0   | 多仓任务进程内重试回滚静默 no-op，脏工作区喂给下一次重试                                                 | services/scheduler.ts:1512-1536,3775-3794                       |
| S-3  | P1   | wrapper 内 review 被 approve 后任务永久卡 awaiting_review                                                | services/dispatchFrontier.ts:87-105,140-141                     |
| S-4  | P1   | git wrapper 不扣 pre-existing 脏改动；git-in-loop 退化为累计 diff                                        | services/scheduler.ts:3176-3184,3290-3298                       |
| S-5  | P1   | fanout 内 per-shard 链 A→B 的 B 永远收到空输入                                                           | services/scheduler.ts:2517,3557-3558                            |
| S-6  | P1   | loop 嵌 loop：外层第 2 轮起内层整体静默 no-op                                                            | services/scheduler.ts:2253-2263,1064-1070                       |
| S-7  | P1   | loop/git wrapper 不写 consumed → 上游重跑后下游静默消费过期输出                                          | services/scheduler.ts:2448-2455 对照缺失                        |
| S-8  | P1   | 并发 resume/retry 可起两个调度器实例，双写同一 worktree                                                  | services/task.ts:969-1059,1214-1215                             |
| S-9  | P1   | clarify/review HTTP 路径对运行中任务 `reset --hard`，绕过 writeSem                                       | services/clarify.ts:425-439                                     |
| S-10 | P1   | drizzle+bun:sqlite async 事务体跑在 COMMIT 之外（五处装饰性事务）                                        | services/review.ts:505-538 等                                   |
| S-11 | P1   | stash 快照是 dangling 对象可被 gc；回滚"先销毁后恢复"                                                    | util/git.ts:763-769,786-801                                     |
| S-12 | P2   | deriveFrontier 分桶不完备：running/canceled/skipped 落黑洞（历史已五连漏）                               | services/scheduler.ts:1108-1133,675-678                         |
| S-13 | P2   | readSnapshotForLatestRun / retryNode 仍按 retryIndex 排序——freshest 比较器第 4、5 处 fork                | services/scheduler.ts:3791; task.ts:1178                        |
| S-14 | P2   | tasks.status 20+ 写点全是非 CAS 盲写，与 node_runs 治理完全不对称                                        | services/scheduler.ts:262,385,396,403 等                        |
| S-15 | P2   | 取消/超时只发一次 SIGTERM 无 SIGKILL 升级；孤儿进程无人收割、pid 列从未使用                              | services/runner.ts:760-779,933,1506-1512                        |
| S-16 | P2   | node_run 行铸造散布 13 处裸 insert + 多份手抄继承清单（历史已修 7 次）                                   | services/scheduler.ts:1419-1456,3332-3360 等                    |
| S-17 | P2   | 写节点排队期占住 globalSem，readonly 并行承诺失效；commit&push 冻结派发循环                              | services/scheduler.ts:1462-1463,713-725                         |
| S-18 | P2   | fanout 任一 shard 失败即整 wrapper failed，与 RFC-060 部分容忍设计相反；errors port 未实现               | services/scheduler.ts:2612-2622                                 |
| S-19 | P2   | fanout failed 后重试全量重跑所有 done shard（复用键挂在新 wrapperRunId 下）                              | services/scheduler.ts:2126-2133,2790-2800                       |
| S-20 | P2   | fanout resume 复用 done shard 只比 shardKey 不比 value，重启后按位复用过期输出                           | services/scheduler.ts:2800-2811                                 |
| S-21 | P2   | aggregator 行无幂等复用；聚合输入不过滤 status='done'                                                    | services/scheduler.ts:3064-3075,3021-3035                       |
| S-22 | P2   | canceled 任务允许 retryNode，但 canceled 行无桶 → 反复 `scheduler stalled`                               | services/task.ts:1083-1088                                      |
| S-23 | P2   | lifecycleInvariants 全部事后扫描；S3 修复无法证明调度器已死，可叠加双调度器                              | services/lifecycleInvariants.ts; lifecycleRepair/options-S3.ts  |
| S-24 | P2   | wrapper-git baseline/diff 计算不取 writeSem 无 quiescence；diff 失败被空 catch 吞成空 diff→done          | services/scheduler.ts:3229-3238,3288-3295                       |
| S-25 | P2   | clarify/cross-clarify 注入门控用代理信号反推 rerun 成因（吃掉 scheduler 58% 的 fix）                     | services/scheduler.ts:1683,1727,1761                            |
| S-26 | P2   | 成体系腐化注释：三处声称 frontier "UNWIRED"，两处引用已删除的 rescan 当现行安全网                        | services/dispatchFrontier.ts:1-33; routes/clarify.ts:255-257 等 |
| S-27 | P3   | review 决策自动 resume 把 409 静默吞掉且注释错误，窄窗口下任务 wedge 30 分钟                             | routes/reviews.ts:171-184                                       |
| S-28 | P3   | wrapper 行 DB 全程 pending、WS 却广播 running；runner eager 广播先于 CAS                                 | services/scheduler.ts:2247-2250,3229-3232                       |

### P0

**S-1｜运行中答复 clarify / 提交 review 迭代决策被 `dispatchedThisInvocation` 永久屏蔽，任务以 "scheduler stalled" 假失败**

- 位置：`services/scheduler.ts:606, 636, 1120-1124, 643-678`；`routes/clarify.ts:269-276`；`routes/reviews.ts:180-182`；`services/review.ts:1742-1757`
- 合并来源：frontier 维度 + architecture 维度（后者用独立临时测试做了确定性端到端复现：注入 pending rerun 行后 task 落 `failed / scheduler stalled`，注入行永久 pending）。
- 机制：`runScope` 的 `dispatchedThisInvocation`（:606）在整个调用期内只 add 不清；`deriveFrontier` ready 判定含 `!dispatchedThisInvocation.has(n.id)`（:1123）。clarify 答复（clarify.ts:441-461）/ review iterate/reject（review.ts:1742-1757）给已派发节点铸的 pending rerun 行因此既不 ready 也不入任何桶；两个 REST 路由又把 `resumeTask` 的 `task-not-resumable` 吞掉。RFC-076 删除 mid-batch rescan 时，这条"运行中铸 pending 行有人兜底"的隐式契约一并消失，但注释还在承诺它（见 S-26）。
- 触发条件：完全普通路径——并行分支工作流（菱形 in→{A,B}），A 发 clarify 后用户在 B 还在跑时通过收件箱答题（收件箱按 session 状态列出，不看 task 状态）；review iterate/reject 在 sibling in-flight 时提交同理。窗口期等于兄弟节点整个运行时长（分钟级）。已用真实生产代码端到端复现（慢 sibling + 运行中 `submitClarifyAnswers`）。
- 爆炸半径：所有带并行分支 + clarify/review 的工作流。任务翻 `failed('scheduler stalled')`，已答的 clarify 看似丢失；手动 resume 可自愈（新调用的去重集为空），但用户看到的是无端失败 + 零诊断价值的错误信息。
- 核实备注：双核实均确认属实；其中一名建议降为 P1（理由：手动 resume 可自愈）。鉴于触发路径普通、表现为产品级假失败，仍列 P0。
- 建议修法：ready 判定对"latest 行是 pending 且不在 inFlight"的节点放行（pending 行本身是幂等派发锚点，`runOneNode` 会复用 pendingExisting 行，不会重复铸行）；或在静默块把"存在 pending latest 但被 invocation 去重挡住"识别为继续循环而非 stalled。先固化 RED 集成测试：慢 sibling + 运行中调 `submitClarifyAnswers` / `submitReviewDecision`，断言任务最终 done。同步修正 `routes/clarify.ts:255-257` 的失真注释（见 S-26）。

**S-2｜多仓任务（repoCount>1）的进程内重试回滚静默 no-op：失败尝试的脏工作区直接喂给下一次重试**

- 位置：`services/scheduler.ts:1512-1536, 1598-1629, 3775-3794`；对照正确实现 `services/task.ts:870-901`
- 合并来源：lifecycle 维度 + concurrency 维度 +（附录 A 中 freshness / architecture 两条重复上报）。四次独立核实全部确认。
- 机制：快照写入是双轨的——单仓写 `preSnapshot` 列（:1604-1605），多仓写 `preSnapshotReposJson`、`preSnapshot` 保持 NULL（:1606-1628）。但重试回滚是单轨的——`readSnapshotForLatestRun`（:3775-3794）只读 `preSnapshot` 单列得 `''`，再对 `task.worktreePath`（多仓时是 plain mkdir 的容器目录，非 git 仓）跑 `rollbackToSnapshot`，git 报错被 :1529-1534 的 catch+warn 吞掉，N 个子仓一个都没回滚。resume 路径早已正确处理多仓（`rollbackNodeRunForResume`，有 `resume-multi-repo-rollback.test.ts` 防护），这是 RFC-066 移植时只改 resume 没改 scheduler 内重试的双轨漂移。
- 触发条件：多仓任务 + 非 readonly 节点 + 首次尝试失败（默认 maxRetries=3，重试是常态路径）。100% 确定性，无需竞态。
- 爆炸半径：attempt N 的半成品写入残留进 attempt N+1 的起点，最终 git diff/聚合输出混入失败尝试的垃圾改动；warn 日志是唯一痕迹，现网完全不可见。附带角落风险：若 worktrees 容器目录的某个祖先是 git repo（用户把 $HOME 纳入 dotfiles 管理），`git clean -fd` 可能从容器目录开始删未跟踪内容。
- 建议修法：把 `task.ts` 的 `rollbackNodeRunForResume` 抽成共享函数（按 repoCount 分支读 `preSnapshotReposJson` 逐仓回滚），scheduler 重试路径改调它并直接传当前行（不再经 `readSnapshotForLatestRun` 重查——顺带消掉 S-13 的一处 fork）；`rollbackToSnapshot` 入口对空快照/非 git worktree 硬拒绝。补红测：repoCount=2 + 写者失败重试，断言两个子仓 attempt2 起点干净。

### P1

**S-3｜wrapper 内 review 被 approve 后任务永久卡 awaiting_review 弹回循环**

- 位置：`services/dispatchFrontier.ts:87-105, 140-141`；`services/scheduler.ts:2286-2299, 3262-3276`；`services/review.ts:1534-1621`
- 机制：wrapper-loop/git 以 park-review 把自身行置 awaiting*review；approve 分支只把 review 行翻 done + 发布 approved_doc，**不铸任何 pending 行、不碰 wrapper 行**；而 resume 后 wrapper awaiting*\* 的唯一放行条件 `wrapperHasFreshInnerWork` 只扫描 `status === 'pending'` 的 inner 行 → 恒 false → 任务永远弹回 awaiting_review。已用真实 scheduler 端到端复现（loop ∋ {agent, review} → approve → 两次 resume 恒卡死），100% 确定性。T1 不变量被 wrapper 行满足故 lifecycleInvariants 不报警；S3 修复规则只覆盖 task=running 形态——普通用户没有出路。
- 触发条件："loop 内 agent + review 迭代到通过为止"正是 loop wrapper 的目标场景；validator 对 review 进 wrapper 无任何限制。
- 建议修法：approve 路径检测被 approve 的 review 行是否有 parked 的祖先 wrapper 行，有则一并把 wrapper 行翻回 pending（与 resume-clarify 同型的显式 transition）；或扩展 `wrapperHasFreshInnerWork` 判定。必须补 approve-inside-loop / approve-inside-git e2e。

**S-4｜git wrapper 基线只记 HEAD、不扣 pre-existing 脏改动；git-in-loop 在 inner 不 commit 时退化为累计 diff**

- 位置：`services/scheduler.ts:3176-3184, 3229-3237, 3290-3298`；`util/git.ts:627-667`；设计依据 `design/design.md:816-831, 837`
- 机制：`captureHead` 仅 `rev-parse HEAD`，输出 = `git diff --name-only <baseline>` + 全部 untracked 无条件并入；design §6.5 要求的 pre_diff 扣除完全未实现。两个触发面：(1) 顺序 `wrapper-git[code] → audit → wrapper-git[fix]`——典型 agent 不 commit，第二个 wrapper 的 git_diff 把 code 阶段所有文件混入，下游 fan-out 分片集合错误；(2) git-in-loop 迭代 N 的 git_diff 是 0..N 累计而非设计规定的"那一轮"，loop 退出轮输出语义直接错。核实者特别指出：**现有测试反而把错误语义锁死了**（scheduler.test.ts:561 用干净 worktree、git-in-loop 测试只跑 1 迭代不断言 diff 内容）。
- 爆炸半径：平台核心抽象（record-state → run → diff → fan-out）的输出物失真。
- 建议修法：进入 wrapper 时补抓 pre 文件集（或复用 RFC-040 的 stash 快照机制）写入 wrapperProgress，输出时做差集；更新 design.md §6.5（git_diff 已是 list<path>，文档也未跟进 RFC-060 PR-E）。补双 git wrapper 顺序 + git-in-loop 满 2 迭代断言每轮互斥的测试。

**S-5｜fanout 内 per-shard 链 A→B 数据流断裂：B 永远收到空输入，且 inner 派发非拓扑序**

- 位置：`services/scheduler.ts:2517, 2572-2579, 2844-2850, 3557-3558`；`services/fanout.ts:80-137`
- 机制：scope 计算侧（computeShardScope BFS + applyAutoPromote）明确支持链式 promote（RFC-060 design:388 举例 A→B→C），但 dispatch 侧 `resolveUpstreamInputs` 过滤 `parentNodeRunId === null`——A 的 shard 行全是 child 行被整体排除，B 只拿到 broadcast + shardSource 边界注入；缺失端口被 prompt 渲染静默替换为 `''`。validator 对非 aggregator 的 inner-to-inner 边零规则。inner 派发还按 nodeIds 数组序而非拓扑序。
- 爆炸半径：用户画 fanout 内 audit→fix 链（产品主打场景）validator 全绿、运行时无报错，fix 的 prompt 里 audit 结果是空字符串，agent 照样跑完产出垃圾——最危险的静默错误形态。
- 建议修法：短期 validator 加硬规则拒绝指向非 aggregator inner 节点的 inner-to-inner 边（v1 明确报错），先补 RED 测试锁定 B 输入为空的现状；长期在 `dispatchFanoutShard` 增加同 shardKey 上游 child 行解析 + 拓扑序派发。

**S-6｜loop 嵌 loop：内层迭代计数器每次从 0 重置，外层第 2 轮起内层整体静默 no-op**

- 位置：`services/scheduler.ts:2253-2263, 1064-1070, 3349-3362`
- 合并来源：wrappers 维度（双核实确认）+ freshness 维度重复上报（附录 A）。
- 机制：内层 loop 以自身计数器 i（startIter=0）调 `runScope({iteration: i})`，而 node_runs 无任何父作用域/父迭代轴——外层迭代 0 与迭代 1 的内层 agent 行键完全相同 `(taskId, nodeId, iteration)`。外层第 2 轮重入时内层 frontier 命中第 1 轮的 done 行（无上游变化时恒 fresh）→ completed → allSettled，exit condition 也读到旧内容。wrapper 自身行的迭代轴曾修过（findResumableWrapperRun 按 parentIteration 隔离，:2101-2104 注释自证），inner 行漏掉。核实确认**零防护**。
- 爆炸半径："任意嵌套"是设计承诺；外层第 2 轮起内层一个 agent 都不跑，任务正常 done 但结果是旧数据，事后排查极难。
- 建议修法：先在 validator 把 wrapper-loop 嵌 wrapper-loop 标 error（短期止血），补 RED 测试（外层 2 轮 × 内层 2 轮断言内层 agent 共跑 4 次）；长期给 node_runs 加父作用域轴（scopePath / 复合 iteration），同步 readPortAtIteration / wrapperHasFreshInnerWork。走 RFC。

**S-7｜loop/git wrapper 行不记录 consumedUpstreamRunsJson：上游 clarify/review 重跑后 wrapper 恒 fresh，下游静默消费过期输出**

- 位置：写点核查——`consumedUpstreamRunsJson` 仅在 `services/scheduler.ts:1448/1457/1545`（agent）与 `:2452-2455`（仅 wrapper-fanout，注释明写 RFC-074 §8 D3 动机）写入；`runLoopWrapperNode`（:2178-2336）/`runGitWrapperNode`（:3186-3302）全段无写入
- 机制：loop/git wrapper 行 consumed 恒 null → `freshness.ts:54-65` 空 consumed 恒 fresh → done 行永不重派。RFC-074 D3 专门给 fanout 修了这个洞，loop/git 被漏掉——同一抽象在三类 wrapper 上不一致。
- 爆炸半径：`requirements → loop[audit-fix] → 下游` 拓扑里，上游因 cross-clarify 答案重跑后 loop 不重入、下游不重跑，新答案静默丢弃——与 RFC-074 指控的 stale-consume 事故同型。
- 建议修法：对齐 fanout——wrapper 行落 inner 节点外部上游的 consumed 并集（这正是"freshest-run 抽共享"重构的天然切入点）；补用例：上游 rerun 后断言 loop wrapper 被判 stale 重派。

**S-8｜resumeTask/retryNode 无任务级互斥、runTask 无防重入：并发 resume 起两个调度器双写同一 worktree**

- 位置：`services/task.ts:969-1059, 1072-1240`；`services/scheduler.ts:206-262, 344-346`
- 合并来源：lifecycle 维度 + concurrency 维度（四次核实全部确认）。
- 机制：resumeTask 是 read-check-act——读状态校验后要先跑数十至上百 ms 的 git 回滚（真实 await 窗口），才无条件 UPDATE pending 并 `void runTask`；runTask 入口不检查现状、无 CAS 直接写 running；writeSem 是 per-runTask 的局部 `Semaphore(1)`，两个循环各持一把互不知晓。`activeTasks.set` 直接覆盖旧 controller，`.finally` 删除时不比对身份。现网触发器现成：reviews.ts:180 的自动 resume 与用户手动 resume 并发即可。`resume-task-idempotent.test.ts` 文件头自认只锁顺序场景。
- 爆炸半径：同一节点铸两份行、两个 opencode 写者并行改同一 worktree（直接违反 CLAUDE.md 的"framework serializes writes within a task"）、stash 快照/回滚互踩、任务终态由后写者随机决定。
- 建议修法：三层——入口 `activeTasks.has(id)` 拒绝；状态翻转改 CAS（affected=0 即 409），rollback 移到 CAS 成功之后；`.finally` 删除前比对 controller 身份。配一条真并发测试（rollback 的 git await 中间发起第二次 resume）。与 S-14 的 nextTaskStatus CAS 同一工作包。

**S-9｜clarify 答复 / review 驳回在任务 running 时对 worktree 做 `reset --hard`，完全绕过 writeSem**

- 位置：`services/clarify.ts:425-439`；同类 `services/review.ts:1705-1715`、`services/crossClarify.ts:782`；`util/git.ts:786-801`
- 机制：三个 HTTP 入口直接调 `rollbackToSnapshot`（reset --hard + clean -fd + stash apply），而 writeSem 是 SchedulerState 的函数局部变量，clarify/review 服务根本拿不到。平台明确支持任务 running 时提交答案/决策（routes/clarify.ts:250-262、clarify.ts:370-372 注释自述），门控只查 sessionMode/快照非空，无任务状态/在飞 writer 检查。
- 爆炸半径：并行分支里 B 分支 writer 正持锁写文件时，HTTP 线程的 reset/clean 清掉它的全部未提交写入，它继续在被偷换的文件系统上跑，产出垃圾 diff；还可能与 writer 自己的 git 命令争 index.lock。这是"writeSem 手工单写保证"的三个现成后门。
- 建议修法：把任务级 worktree 写锁提升为全局注册表（`Map<taskId, Semaphore>`），scheduler 的 writeSem、三处 HTTP 回滚、commitPush 的 acquireWrite 全部取同一把锁；或最小修复——回滚前检查在飞 writer，有则把回滚 defer 给调度循环持锁执行（rerun 行已带 preSnapshot，重派时本就会回滚）。

**S-10｜drizzle+bun:sqlite 的 async 事务体在第一个 await 后全部跑在 COMMIT 之外——五处事务是装饰性的**

- 位置：`services/review.ts:505-538`；同模式 `services/memory.ts:285/415`、`services/plugin.ts:237`、`services/mcp.ts:126`
- 机制：实验确认 bun:sqlite 的 `Database.transaction` 是同步包装——async 回调返回 promise 后立即 COMMIT，await 之后的语句逐条 autocommit，事后抛异常不回滚。仓内有双重旁证：clarify.ts:385-387 注释明写 "db.transaction does NOT help…verified"；lifecycleRepair/options-R2.ts:4-7 记载 RFC-052 的 approve 半提交事故正是这一类。**RFC-052 之后 review.ts:505 又新写了一处**——API 形态像安全的，复发已被证实。
- 爆炸半径：崩溃或中途语句失败落在序列中间时留下半态（comments 已删但 docVersion 仍 pending 等），恰是 R2 修复规则存在的根因类；memory.ts:9 注释甚至声称靠事务防 half-promoted（错误信念）。
- 建议修法：提供 `dbTxSync(db, (tx)=>{...})` 同步事务助手并改写五处；加源码层文本断言测试，grep 禁止 `db.transaction(async` 出现在 src/（仓内已有 source-text guard 先例），从结构上封死复发。

**S-11｜stash 快照是 dangling 对象会被 git gc 回收；回滚顺序"先销毁后恢复"——resume 旧任务可静默丢数据**

- 位置：`util/git.ts:759-769, 786-801`；调用方 `task.ts:905-914`、`scheduler.ts:1526-1535`、`clarify.ts:432`、`crossClarify.ts:782`
- 机制：`git stash create` 产生的 commit 无任何 ref 钉住（全仓 grep 确认），默认 `gc.pruneExpire` 2 周回收；且 worktree 与源仓共享对象库，用户在源仓的自动 gc 也会清掉平台快照。`rollbackToSnapshot` 顺序是 reset --hard → clean -fd → 最后才 stash apply——apply 失败时工作区已被前两步清空，所有调用方 catch+warn 继续。核实者指出：现有测试 `git-snapshot.test.ts:87-92` 锁定的恰恰是"先销毁后报错"行为，不构成 fail-closed 防护。
- 爆炸半径：产品语义（cancel 保留 worktree、resume 回滚 pre_snapshot）鼓励长期搁置后恢复；放置两周后 resume = 未提交状态永久丢失 + 在错误基线上的"成功恢复"，只留一行 warn。
- 建议修法：快照时建轻量 ref（`refs/agent-workflow/snapshots/{nodeRunId}`），任务终态清理时删；回滚前 `git cat-file -e` 验证对象存在，不存在则 fail-closed 不执行 reset/clean；resume 路径把 apply 失败升级为任务级可见错误。

### P2

**S-12｜deriveFrontier 状态分桶不完备：latest 为 running/canceled/skipped 一律落无桶黑洞，统一以无归因的 "scheduler stalled" 失败（历史已五连漏）**

- 位置：`services/scheduler.ts:1108-1133, 675-678, 1027-1034`；`services/dispatchFrontier.ts:129-158`
- 合并来源：frontier 维度（原报 P1，**两名核实者均改判 P2**——触发需先有遗弃 running 行等前置缺陷，重启 daemon 可解）+ history 维度的模式证据 + architecture 维度重复上报（附录 A）。
- 机制：分桶循环只处理 awaiting*review/awaiting_human/failed 三种，isDispatchable 对 canceled/running/skipped 返回 false → 既不 ready 也不入桶 → `scheduler stalled` 且 detail 不含 nodeId。遗弃 running 行的现实来源：runTask 的 sink/wrapper 分支无局部 try/catch（:353-359 注释自认），抛错后行停在 running；`reapOrphanRuns` 仅 daemon 启动时跑，同进程内无人修复；resumeTask 只回滚 failed/interrupted。历史佐证（history 维度）：awaiting*\*、exhausted、interrupted、canceled 五次漏分类，**且三例发生在 RFC-053 状态机化之后**（5dad31b 一次修三桶）——人工枚举确证挡不住这一类。`'skipped'` 在 schema 中存在但全 src 零 mint 点，未来任何人启用即落黑洞。
- 建议修法：分桶做成对 NodeStatus 全集的穷举（switch + never）；抽 `classifyRunStatus` 纯函数供 deriveFrontier/isDispatchable/isLiveStatus/wrapper 镜像共用；stalled 错误附带阻塞节点清单（nodeId + latest status）；`reapOrphanRuns` 的 running→interrupted 复用为 resumeTask 前置步骤。配 property test：枚举全部 status 喂 deriveFrontier，断言每个值入且仅入一个显式集合。

**S-13｜readSnapshotForLatestRun / retryNode 仍按 retryIndex 排序选行——freshest-run 比较器第 4、5 处分叉且该语义已被团队判死过**

- 位置：`services/scheduler.ts:3781-3793, 1519`；`services/task.ts:1174-1182`
- 机制：权威比较器 `isFresherNodeRun` 是纯 ULID id 序（:450-456），其注释明确拒绝 retryIndex 序并写明失效场景；resumeTask 已为同一 bug 修过一次（task.ts:986-997 + 专项回归测试，但只覆盖 resume 路径）。`readSnapshotForLatestRun` 仍 `orderBy(desc(retryIndex))`（被重试回滚调用——选错行即回滚目标错、工作区被错误覆盖），retryNode 的 prev 继承源同病。核实者另发现 lifecycleRepair 中还有第 6 处。
- 核实备注：一名核实者改判 P2（具体复现链有夸大）、一名维持确认。列 P2。
- 建议修法：`readSnapshotForLatestRun` 改为直接接受调用方手里的当前行（彻底删掉重查，与 S-2 修复合并）；retryNode 的 prev 改 id 序；freshest 选择收敛为 shared 单函数后用源码文本断言锁 `desc(nodeRuns.retryIndex)` 不得再出现在快照/继承路径。

**S-14｜tasks.status 20+ 写点全是非 CAS 盲写、无转移表——与 node_runs 的 RFC-053 治理完全不对称**

- 位置：`services/scheduler.ts:262, 385, 396, 403, 3366-3394`；`task.ts:947/1011/1202`；`orphans.ts:40`、`limits.ts:48`、`shutdown.ts:39`、lifecycleRepair 下 14-15 处（核实清点 21 处；architecture 维度普查口径 27 处/15 文件）
- 机制：node_runs 有转移表 + CAS + ESLint 直写禁令三件套；tasks 三者皆无，`nextTaskStatus` 全仓零命中。三个可命名互踩窗口：runTask 无条件写 running 可复活已 canceled 任务；最后一轮检查后到达的 abort 被 done 覆盖；limits 扫描在 cancel 失败后仍覆写 errorSummary。
- 核实备注：双核实确认事实但**均改判 P2**（窗口窄、未见现网事故、但无任何测试锁定）。
- 建议修法：复制 RFC-053 模式——shared `nextTaskStatus` 转移表 + `transitionTaskStatus` CAS + 同款 ESLint 限制；终态写点一律要求 from ∈ 非终态集合。这正是既有待办"runner/task nextTaskStatus CAS"的精确化执行清单。

**S-15｜取消/超时只发一次 SIGTERM、无 SIGKILL 升级，`child.exited` 无界等待；孤儿 opencode 进程树无人收割、nodeRuns.pid 落库后从未被使用；该挂死形态落在 stuck 检测盲区**

- 位置：`services/runner.ts:760-779, 933, 1506-1512`；`services/orphans.ts:9-11`；`services/shutdown.ts:21-47`；`services/stuckTaskDetector.ts:242-248`
- 合并来源：lifecycle 维度 + concurrency 维度。核实备注：四次核实中三次改判 P2（"调度器永久 wedge"子主张被指夸大；mock 子进程从未测过不合作场景），按多数列 P2。
- 机制：safeKill 签名支持 SIGKILL 但 runner 从未传过（pluginInstaller.ts:385 有现成升级模式）；opencode 源码自证其子进程会无视 SIGTERM（docker MCP 等）。叠加：daemon 退出后孤儿继续改 worktree，用户见 interrupted 立即 resume → 回滚与孤儿写入并发；shell 工具拉起的孙进程在父进程被杀后可继续写。stuckTaskDetector S1-S4 均不覆盖"running 行长时间无事件"。
- 建议修法：SIGTERM 后固定宽限（10s）升级 SIGKILL，`await child.exited` 加最终超时；spawn 自成进程组按组杀覆盖孙进程；reapOrphanRuns/resumeTask 前用 pid 做存活检查（结合 startedAt 时间窗降噪 pid 复用）；stuckTaskDetector 增 S5 规则（running 行 30 分钟无事件 → 告警带 pid）。

**S-16｜node_run 行铸造散布 13 处裸 `db.insert(nodeRuns)`（6 文件）+ 多份手抄继承字段清单——继承丢失与不幂等恢复历史已修 7 次**

- 位置：`services/scheduler.ts:1419-1456`（继承块）、`:3332-3364`（insertNodeRun，未导出）；裸 insert 清单：crossClarify.ts:209/817/933、commitPushRunner.ts:126、scheduler.ts:867/2827/3065/3349、review.ts:570/1742、clarify.ts:172/443、task.ts:1184
- 机制：恢复路径都是事故后补写，各自重新回答"选哪行、铸哪行、继承什么"；行 schema 每加一个语境字段全部铸造点要人肉同步。fix 史：d529e6a 与 c55eeb0 是**同一形态 bug 在两个铸行点各爆一次**；538456e/11d54a8 又两处漏继承 cci；5dad31b 一次清掉 4 个恢复路径缺陷。结构必然而非个别疏忽。
- 核实备注：一名确认 P1、一名改判 P2（现存测试网锁住已知个案），列 P2。
- 建议修法：收敛为单一 `mintNodeRun(db, {cause, inheritFrom?})` 工厂（继承字段集只在一处声明）+ grep guard 禁止服务层裸 insert；resume 决策抽纯函数 `planResume(rows, definition) → actions[]` 表驱动测试。与 S-25 的 rerun_cause 列同一工厂落地。

**S-17｜写节点在 writeSem 排队期间持有 globalSem 槽位，readonly 并行承诺在 ≥capacity 写节点就绪时完全失效；auto commit&push 冻结整个派发循环**

- 位置：`services/scheduler.ts:1462-1463, 2915-2917, 3098-3100, 713-725, 818-966`
- 机制：固定先 global（容量 4）后 write（容量 1）；4 个写节点就绪时 3 个排队者各占一个 global 槽，readonly 节点整体饿死——直接违反 :567-568 注释承诺。RFC-075 commit&push 在派发循环内同步 await 一次完整 opencode 会话，期间不 race 新完成、不派发新 ready。非死锁但属系统性吞吐退化，**无测试锁定**。
- 爆炸半径：Code→Audit→Fix 主场景里 readonly 审计节点被迫串行，墙钟成倍膨胀。
- 建议修法：写节点改为先 writeSem 后 globalSem（fanout shard/aggregator 同步改）；commit&push 移出 race 主路径。补并发测试：4 写 + N 读就绪时断言读节点在首个写节点完成前已 running。

**S-18｜fanout 失败语义与 RFC-060 设计相反：任一 shard 失败即整 wrapper failed；errors port 部分容忍机制未实现且两份权威文档均未记录降级**

- 位置：`services/scheduler.ts:2612-2622, 2652-2659, 2763-2764`；设计依据 RFC-060 design:529-531、design/design.md:765/779/1246
- 机制：`failedShards.length > 0` → 整 wrapper failed（实为 fail-all-after-join，:2763 注释 "fails-fast" 也不准确），跳过聚合与 outlet 写入。设计规定"只看 done shard 聚合、全失败才 failed、自动 errors port"。无任何"部分 shard 失败"测试。
- 爆炸半径：50 shard 跑 49 成功 1 超时 → 全部成功结果对下游不可见；按文档搭工作流（下游接 errors port）的用户会发现该 port 不存在。
- 建议修法：二选一并保持文档-实现一致——按 §7.5 落地部分容忍 + errors 出口，或在 design.md 显式记录 v1 fail-all 降级并修正注释。无论哪个方向先补"1/3 shard 失败"测试锁现状。

**S-19｜fanout failed 后无断点续跑：retry 重铸 wrapperRunId，全部已 done shard 全量重跑**

- 位置：`services/scheduler.ts:2126-2133, 2429-2431, 2790-2800`
- 机制：findResumableWrapperRun 把 failed 列为 terminal 返回 null → mint 新 wrapperRunId → shard 复用查询按 `parentNodeRunId = 新 id` 永远查不到旧 done 子行。daemon 重启（interrupted）路径有专门复用防护与测试，failed-then-retry 路径完全没有。与 S-18 叠加：1 个 shard 网络抖动 → 用户重试 → N 个 opencode 进程全部重跑（真实 LLM 成本），非 readonly shard 还会改写 worktree。
- 建议修法：shard 复用锚点改为 `(taskId, nodeId, iteration, shardKey)` 维度或 retry 时继承前代 wrapper 的 done 子行；同步 aggregator 同款查询（S-21）。配用例：failed → 重试 → done shard 不重跑。

**S-20｜fanout resume 复用 done shard 只比 shardKey 不比 value：非 path 类 list 以 index 为 key，重启后上游内容变化时按位复用过期输出，且 consumed 被新值覆盖掩盖错配**

- 位置：`services/scheduler.ts:2800-2811, 2439-2455`；`services/shardingRegistry.ts:75`
- 机制：priorChild done 即原样返回旧 outputs，不比较 shard.value；重启恢复链路里 wrapper 重新 resolve 出新 list 后直接覆盖 consumed——provenance 审计也看不出 shard 输出来自不同代上游。path 类 key 同病（同路径内容已被改写）。
- 建议修法：shard 子行记录 value 摘要（hash），复用前比对；或 wrapper resume 时 consumed 不一致即放弃全部 child 复用。补用例：重启后上游新内容 → 断言对应 shard 重跑。

**S-21｜aggregator 行无幂等复用（每次 ulid 新铸，重启后旧 interrupted 行永久残留）；聚合输入挑 inner 行不过滤 status='done'**

- 位置：`services/scheduler.ts:3064-3075, 3021-3035`
- 机制：dispatchFanoutShard 为同一危害专门写了 prior-child 复用（注释直言动机），aggregator 自身没有；`innerRows.find(shardKey)` 无 status 过滤无排序，RFC-060 伪码明确要求 done-only——当前仅因 fail-all 语义"碰巧"全 done 才不出错，一旦落地 S-18 的部分容忍即静默读失败 shard 的空输出。典型"未来改动必踩"的回归地雷。
- 建议修法：aggregator 加同款复用分支；innerRows 改 filter(done) + isFresherNodeRun 取最新。补聚合阶段重启恢复用例。

**S-22｜canceled 任务允许 retryNode，但 canceled 行既不可调度也不入桶——恢复后必然以不透明 stalled 失败循环**

- 位置：`services/task.ts:1083-1088`；`services/dispatchFrontier.ts:156-157`；`services/scheduler.ts:1129-1132, 675-678`
- 机制：retryNode 状态门只拒 pending/running（且前端 `canRetryNodeRun` 显式把 canceled 列为可重试——这是设计内 UI 流）；但 canceled 行落 S-12 的无桶黑洞。场景：并行 A/B 运行中取消 → 对 A retryNode → B 的 canceled 行永远阻塞 → stalled；之后 resume 只重铸 failed/interrupted，循环失败且 errorSummary 互相覆盖。canceled 在"可恢复终态"与"真终态"之间的归类从未被显式决策。
- 建议修法：二选一写进转移表——retryNode 拒绝 canceled 任务（与 resumeTask 对齐），或 isDispatchable 把 canceled 视为可重铸信号。依赖 S-12 的 stalled 诊断改进。

**S-23｜lifecycleInvariants 818 行全部事后扫描（boot 5s + 每小时）；S3 修复的 preflight 无法证明调度器已死，demote + auto-resume 可叠加出双调度器**

- 位置：`services/lifecycleInvariants.ts:1-32, 482-563, 785-818`；`lifecycleRepair/options-S3.ts:118/193/268/317`；`lifecycleRepair.ts:230-280`
- 机制：七条 invariant 只写 alert（24h grace），唯一自动修复是 CR-1；S3 各 option preflight 只断言 `task.status==='running'`，区分不了"调度器已死"和"活着但 30 分钟没动静"；apply 非 CAS 写 tasks 并触发 resumeTask——若原调度器仍在 activeTasks 即构成 S-8 的双调度器。**修复工具自身可能复制它要修的事故类别**（S3 的历史成因恰是并发写者互踩，options-S3.ts:5-9 记载）。
- 建议修法：RepairContext 增加调度器活性证据（preflight 必查 activeTasks，活跃即 unavailable）；S3/T 系 apply 走 S-14 的 transitionTaskStatus CAS；长期把纯一致性规则前移为写入点断言。

**S-24｜wrapper-git 的 baseline 捕获与 diff 计算不取 writeSem、无 quiescence 保证；diff 失败被空 catch 吞成空列表 → wrapper 直接 done**

- 位置：`services/scheduler.ts:3229-3238, 3284-3301`（其中 :3293-3295 空 catch 已被核实确认会把 DomainError 吞成 `paths=[]`）
- 合并来源：concurrency 维度（确认）+ architecture 维度"diff 失败吞成空 done"重复上报（其核心事实已在本条核实中坐实）。
- 机制：wrapper 在 runOneNode 提前 return，从不进入信号量段；RFC-076 撤批屏障后给 commit-push 补了 C4 quiescence 锁，wrapper-git 没拿到同款修补。与并行顶层 writer 分支 mid-write 时，changed-file 列表读到对方半成品；争 index.lock 失败则吞成空 diff——下游 fanout 走空 source 短路，**所有审计 shard 一个不跑、任务全绿**。
- 建议修法：diff 捕获瞬间套 writeSem（与 C4 一致）；空 catch 不得降级——gitChangedFiles 抛错 → wrapper failed（`git-diff-failed:<msg>`），真空 diff 才走 done。补两条红测：finalize 前删 worktree → failed；wrapper-git ∥ 顶层 writer 并发。

**S-25｜clarify/cross-clarify 提示词注入门控用代理信号反推 rerun 成因——吃掉 scheduler 58% 的 fix（15/26），RFC-074 重构当天即修出回归**

- 位置：`services/scheduler.ts:1640-1900`（门控集中区：1683 / 1727 / 1761）
- 机制：注入决策的真实自变量是"本行 rerun 的成因"（clarify 答复 / review-iterate / 进程重试 / resume / 级联），成因只在铸行那一刻唯一可知但不持久化；每个消费点用计数器、retryIndex、拓扑等代理信号事后反推，代理在成因间天然重叠——每加一种 rerun 成因就打穿一个门。11-commit fix 链（d529e6a → … → 3979072）全部有据可查；3979072 证明删掉 cascade 这个"顺带摆正代理信号"的机制后门立即误判。既有重构队列要动 clarify（收敛单表），不改门控结构则大概率再出 prompt 缺失/死循环回归。
- 建议修法：node_runs 持久化显式 `rerun_cause` 枚举列（mint 时由唯一知情方写入），门控直接 switch on cause；配 `(consumerKind × cause)` 真值表测试穷举注入矩阵。与 S-16 的 mintNodeRun 工厂、clarify 收敛单表同包落地。

**S-26｜RFC-076 留下成体系腐化注释：三处声称 frontier "UNWIRED" 而实际已上线；两处把已删除的 rescanScopeForNewPendingRows 当现行安全网引用——其中 clarify 路由那条直接掩盖了 S-1**

- 位置：`services/dispatchFrontier.ts:1-33`；`services/scheduler.ts:992-1005, 2211-2214`；`routes/clarify.ts:255-257`；`services/wrapperProgress.ts:9-13`
- 合并来源：frontier 维度（确认）+ architecture 维度重复上报（后者补充 review.ts:307 的废弃比较器描述等）。
- 机制：这些不是普通过期注释——routes/clarify.ts 那段是"为什么可以吞掉 resume 失败"的安全论证，论证依据已不存在而 S-1 证明结论也随之失效；wrapperProgress.ts 那段是 wrapper 复活协议的权威描述，与现实不符（S-3 的缺口恰藏在新旧机制语义差里）。按仓规 RFC 流程，下一个接手 frontier 的 session 会先读这些注释建立错误心智模型。
- 建议修法：一次性清账（纯注释部分可按仓规直接提交）：删 UNWIRED 段、rescan 引用改为 deriveFrontier/wrapperHasFreshInnerWork 的准确描述并与 S-1/S-3 修复联动；跨文件契约类注释改为指向锁定该契约的测试文件名而非描述实现；孤儿抽取 computeReadyNodes 要么复用要么删除。

### P3

**S-27｜review 决策自动 resume 把 409 静默吞掉且 catch 注释错误，quiescent 过渡窗内的决策让任务停在 awaiting_review 至少 30 分钟**

- 位置：`routes/reviews.ts:171-184`
- 机制：`void resumeTask(...).catch(() => {/* errors land in task.errorMessage */})` 的注释是错的——ConflictError 时什么都不会写。危险窗口是 deriveFrontier 之后、写 awaiting_review 之前的 ms 级间隙；兜底只有 30 分钟周期的 stuckTaskDetector S1。决策数据不丢但任务 wedge。核实者改判 P3（窗口极窄）。
- 建议修法：升级为 clarify 同款分类处理 + 对 task-not-resumable 做短退避重试（3×500ms）；顺手修注释。可并入 S-14 工作包。

**S-28｜wrapper 行 fresh-mint 后 DB 全程 'pending'（从不进 running），WS 却广播 'running'；runner eager 广播先于 mark-running CAS——DB/WS 双口径**

- 位置：`services/scheduler.ts:2247-2250, 2429-2432, 3229-3232, 2154-2168`；`services/runner.ts:524-530, 663-667`
- 合并来源：wrappers 维度 + concurrency 维度。当前无正确性故障（orphan reaper 把 pending/running 同等收割、stuck S3 不误报），但页面刷新后状态 chip 回跳，且 markWrapperTerminal 注释声称 typical 来源是 'running' 与实际矛盾——任何人按注释收紧 allowedFrom 或新增"running 行才计活跃"统计即破裂。
- 建议修法：fresh-mint 后补一笔 pending→running 转移（与 resume 路径对齐），之后收窄 allowedFrom；eager 广播移到 CAS 之后；在 lifecycle.ts 固化"先写 DB 后广播"规则。

---

## ③ 根因主题归纳

28 个确认问题高度收敛在七个结构性根因上：

**R1｜状态分桶是 default-deny 黑洞，靠手工 if/else 枚举**（S-1、S-12、S-22、S-28）。9 值 NodeRunStatus × 至少 5 个消费端（frontier 分桶、isDispatchable、wrapper 镜像、resume allowedFrom、invariants），没有一处是带 never 检查的穷举 switch；历史五次漏分类、其中三次发生在专门状态机化（RFC-053）之后，证明人工枚举挡不住。漏桶的统一表现是诊断价值为零的 `scheduler stalled`。

**R2｜"哪行是最新/权威"的判定多处 fork**（S-13、S-16，及 S-2 的列错位变体）。权威比较器已统一为纯 id 序，但过滤谓词（status/iteration/parent-null/排序键）在 5-6 个 picker 里各自手写，retryIndex 序错误被团队判死过一次仍在两处残留。每个 fork 都是一次未来回归的埋点。

**R3｜首跑路径与恢复/重试路径双轨实现，事故后逐处补丁**（S-2、S-16、S-19、S-20、S-21、S-3）。快照写入双轨/读取单轨、行铸造 13 处裸 insert 各抄继承清单、fanout 的 shard 有复用防护而 aggregator 没有、approve 路径没有 wrapper 复活挂钩——同一语义的 N 份实现必然漂移，历史上同形态 bug 在不同铸行点各爆一次。

**R4｜并发守卫是 call-site 约定而非结构保证**（S-8、S-9、S-14、S-17、S-24）。writeSem 是 per-runTask 局部变量（HTTP 入口天然旁路、并发 runTask 各持一把）；tasks.status 无 CAS；信号量取用顺序与覆盖范围靠每个 dispatch 路径手工布线。历史上 fanout 曾两周完全绕过全部信号量（已修复并有回归测试，见附录 B），证明"漏接也能全绿"。

**R5｜wrapper 三件套（loop/git/fanout）同一抽象三种实现，逐项不一致**（S-3、S-4、S-6、S-7、S-18~S-21、S-28）。consumed provenance 只有 fanout 写、复活条件只认 pending、迭代轴只修了 wrapper 自身行漏了 inner 行、git baseline 缺 pre_diff、失败/恢复语义各行其是。每个不一致都是一个静默错误源。

**R6｜事后校验替代写入时防护 + 形似安全的 API**（S-10、S-23、S-14）。invariants 全部事后扫描且修复工具自身可复制事故；`db.transaction(async …)` 形态完全像安全的，仓内已两次实证无效后又新写了一处。

**R7｜知识载体腐化：注释失真、设计-实现漂移、隐式第二职责、代理信号**（S-26、S-18、S-4、S-25）。机制退役时未写文档的次级职责跟着消失（rescan 之于 mid-run pending 行）；安全论证类注释引用已删除的机制；设计文档承诺的 errors port/pre_diff 未实现也未记录降级；rerun 成因不持久化迫使所有消费点用代理信号反推。

---

## ④ 改进路线图（RFC 工作包）

与既有待办队列（validator/canvas computeNodeOutputs 抽共享 → structural-diff symbolId codec → review 端口 dedup → scheduler 抽 decideScopeOutcome / 拆 runOneNode → nextTaskStatus CAS → freshest-run 共享 → clarify 收敛单表）整合如下。原则沿用 fortify-then-refactor：每包先落 oracle 测试（红）再动刀。既有队列中与调度无关的前三项（computeNodeOutputs、symbolId codec、review 端口 dedup）保持原序不受影响，但建议调度侧 WP-1/WP-2 优先于它们排期。

**WP-1｜P0 止血（S-1、S-2；顺带 S-26 的 clarify 路由注释）——立即做，无依赖**

- 先补 oracle：① mid-run clarify/review 集成测（慢 sibling + 运行中 submitClarifyAnswers/submitReviewDecision，断言任务最终 done）；② 多仓 retry 回滚红测（repoCount=2 + 写者失败重试，断言子仓起点干净）。
- 再修：deriveFrontier 对 pending-latest 放行；rollbackNodeRunForResume 抽共享函数（按 repoCount 分支），scheduler 重试路径改调并直传当前行。
- 范围小、语义明确，可作为单个小 RFC（或按维护者判断作为带回归测试的 bug fix 直接落）。

**WP-2｜decideScopeOutcome 抽取 + 状态宇宙穷举（S-12、S-22、S-1 的结构化收尾）——对应既有待办"scheduler 抽 decideScopeOutcome"，依赖 WP-1**

- 先补 oracle：NODE_RUN_STATUS 全集 × deriveFrontier 的 property test（每个值入且仅入一个显式集合，新增状态先红）；canceled-task retryNode 场景测试。
- 再动刀：把 runScope:643-678 静默判定抽成纯函数 `decideScopeOutcome`，分桶改穷举 switch + never；stalled 错误附带阻塞节点诊断载荷；canceled 的归类（可重铸 vs 真终态）显式决策写进转移表。

**WP-3｜freshest-run picker 收敛（S-13、S-7 的切入点；顺带核实附录 C 的 readPortAtIteration / triggerDesignerRerun / cascade 继承三条）——对应既有待办"review freshest-run 共享 pickFreshestUpstreamRun"**

- 先补 oracle：retryIndex-vs-id 回滚目标红测（storm + clarify rerun 并存）；fanout 子行混入 picker 的定性测试；扩展现有 `isfresher-noderun-baseline.test.ts` 为新模块 oracle。
- 再动刀：isFresherNodeRun/buildFreshestDonePerNode 下沉到 freshness.ts（顺手解 scheduler↔review import 环的一半），新建带显式过滤参数的共享 picker；逐点替换 5-6 处 fork；源码文本断言锁 `desc(retryIndex)` 不再出现在快照/继承路径。

**WP-4｜nextTaskStatus CAS + 任务级互斥（S-14、S-8、S-23、S-27）——对应既有待办"runner/task nextTaskStatus CAS"**

- 先补 oracle：真并发 resume 测试（rollback 的 git await 中间发起第二次，断言恰好一个成功）；cancel-vs-done、limits-vs-done 竞态测试（锁定期望胜者）。
- 再动刀：shared `nextTaskStatus` 转移表 + `transitionTaskStatus` CAS + ESLint 直写禁令（复制 RFC-053 三件套）；resumeTask/retryNode 入口 activeTasks 拒绝 + CAS 翻转 + controller 身份比对；lifecycleRepair 的 preflight 增加调度器活性检查；reviews.ts 409 分类处理。

**WP-5｜任务级写锁注册表 + quiescence（S-9、S-17、S-24；顺带核实附录 C 的 commit&push 锁外 commit）——依赖 WP-4（任务级所有权先定）**

- 先补 oracle：4 写 + N 读就绪的并发峰值/公平性测试；wrapper-git ∥ 顶层 writer 测试；clarify mid-run 回滚 defer 测试。
- 再动刀：写锁从 SchedulerState 提升为按 taskId 的全局注册表，scheduler/clarify/review/crossClarify/commitPush 全部取同一把；写节点先 writeSem 后 globalSem；wrapper-git diff 捕获套锁、空 catch 改 fail；commit&push 移出 race 主路径。

**WP-6｜wrapper 语义一致化（S-3、S-4、S-5、S-6、S-7、S-18~S-21、S-28）——最大的包，依赖 WP-3（共享 picker/freshness 先行），建议拆 4 个 PR**

- 6a（可提前到 WP-1 之后）：validator 短期禁入 + 现状固化——loop 嵌 loop 标 error、fanout inner-to-inner 非 aggregator 边标 error；RED 测试锁定 B 空输入 / 内层 no-op 现状；S-18 的失败语义二选一决策并同步 design.md；修正全部失实注释（S-26 收尾）。
- 6b：fanout 恢复幂等——shard 复用锚点改 (taskId, nodeId, iteration, shardKey)、value hash 校验、aggregator 复用分支 + done 过滤（S-19/S-20/S-21）。oracle：failed→retry 不重跑 done shard、重启后上游新内容对应 shard 重跑、聚合阶段重启无重复行。
- 6c：loop/git 语义补全——wrapper 行落 consumed（S-7）、pre_diff 扣除 + git-in-loop 每轮独立 diff（S-4）、approve-in-wrapper 复活（S-3）。oracle：上游 rerun 后 loop 重派、双 git wrapper 顺序 diff 互斥、approve-inside-loop e2e。
- 6d：wrapperRuntime 样板收敛 + pending→running 一致化（S-28）——对应既有待办"拆 runOneNode"的 wrapper 部分。oracle：fresh wrapper 行运行期 DB 状态必须为 running 的一致性测试（现状红）+ 三件套 resume 参数化测试。

**WP-7｜dbTxSync 同步事务助手（S-10）——独立小包，建议尽早（与 WP-1 并行）**

- 先补 oracle：源码文本断言 grep 禁止 `db.transaction(async`；中途抛错半提交红测（按 review.ts 三步序列构造）。
- 再动刀：实现 dbTxSync，改写 review/memory/plugin/mcp 五处；修正 memory.ts:9 错误注释。

**WP-8｜进程治理（S-15）——独立，建议在 WP-4 之后（resume 前 pid 检查与互斥相关）**

- 先补 oracle：trap SIGTERM 的不合作 mock 子进程 + 超时路径测试（现有 mock 是配合型，从未测过此形态）。
- 再动刀：SIGTERM→SIGKILL 升级链、进程组杀、pid 存活检查接入 reapOrphanRuns/resumeTask、stuck S5 规则。

**WP-9｜快照 ref 钉住 + fail-closed 回滚（S-11）——独立，可与 WP-1 的回滚共享函数同 PR 族**

- 先补 oracle：对象被 prune 后 resume 的红测（断言不执行 reset/clean 且报任务级错误——注意现有 git-snapshot 测试锁的是"先销毁后报错"，需改写）。
- 再动刀：refs/agent-workflow/snapshots/ 轻量 ref + 终态清理；cat-file 前置验证。

**WP-10｜rerun_cause 持久化（S-25、S-16 收尾）——并入既有待办"clarify 收敛单表"，最后做**

- 先补 oracle：(consumerKind × cause) 注入真值表测试。
- 再动刀：mintNodeRun 工厂统一铸行 + cause 列，门控改 switch on cause；clarify 收敛单表在此基础上进行，避免在代理门控不改的前提下动 clarify 再出回归。

推荐总顺序：**WP-1 → WP-7（并行）→ WP-6a → WP-2 → WP-3 → WP-4 → WP-5 → WP-6b/6c/6d → WP-8 / WP-9（穿插）→ WP-10**。

---

## ⑤ 存疑发现附录

### A. 与确认问题重复（内容已并入正文，此处仅注明归属）

| 存疑条目                                                                         | 归属                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| architecture：RFC-076 删 rescan 后 mid-run clarify → stalled（含确定性复现实验） | 已并入 S-1（其复现实验作为 S-1 的佐证）                            |
| architecture / freshness：多仓重试回滚单仓路径（含容器目录 git clean 角落风险）  | 已并入 S-2                                                         |
| freshness：readSnapshotForLatestRun retryIndex + 多仓失效                        | 已并入 S-2 / S-13                                                  |
| freshness：loop 嵌 loop 内层一次性重放                                           | 已并入 S-6                                                         |
| architecture：tasks.status 27 写点普查                                           | 已并入 S-14（核实口径 21 处，普查口径 27 处）                      |
| architecture：调度分桶 default-deny 黑洞 + 'skipped' 零 mint 点                  | 已并入 S-12                                                        |
| architecture：runGitWrapperNode diff 失败吞成空 done                             | 核心事实（空 catch 吞 DomainError）已在 S-24 核实中坐实，并入 S-24 |
| architecture：导航性注释成批失真（补充 review.ts:307 等）                        | 已并入 S-26                                                        |
| architecture：wrapper 三件套样板复制 + pending/WS 失真                           | DB/WS 部分并入 S-28，样板收敛并入 WP-6d                            |

### B. 核实者意见分歧（一确认一推翻）——历史模式类，已有防护覆盖已知实例

这三条的事实链（commit、事故 task ULID）均核实属实，但被对抗核实方以"已修复 + 有专项回归测试锁定，不构成现存缺陷"推翻或改判 P3。**如实结论：它们不是现存 bug，而是已被部分治理的历史模式**；其前瞻性主张（结构上仍无强制保证）应作为上述 WP 的设计约束吸收，不单独立项：

1. **「freshest 判定第一重灾区」（history, 原报 P1）**：23 天 6 fix、5 起生产事故属实；但比较器在 src 内并未 fork（全仓唯一定义、review.ts import 同一函数），`isfresher-noderun-baseline.test.ts` 等测试网已覆盖声称的暴露面，剩余缺口（乱序铸造使 id 序与因果序背离）在现有代码中无可达路径。推翻方改判 P3。其建议（lifecycleInvariants 增加 supersede 链 id 单调规则、乱序 mint property test）作为 WP-3 的可选加固项。
2. **「机制退役丢隐式第二职责」（history, 原报 P1）**：三个实例（删 cascade 出 questioner 死循环、删批屏障出 C4 竞态、一跳门当天被修）全部已修复且各有回归测试锁定（如 `scheduler-cross-clarify-dispatch.test.ts:535-639` 直接复刻生产任务并声明行为级断言）。剩余是流程建议（退役前列副作用读点写进 RFC §失败模式）——建议吸收进 RFC 模板，不立项。
3. **「信号量守卫手工布线两次失守」（history, 原报 P1）**：41fdf09→5dad31b 的 fanout 绕过与 C4 均已修复，`scheduler-boundary-fanout-concurrency.test.ts` 用墙钟下限直接断言并发上限。其结构性主张（新 spawn 路径无强制 acquire）作为 WP-5 的设计约束（guarded 执行入口 + grep guard）吸收。

### C. 未经对抗核实（verdictNotes 为空），按原报告呈现，建议在对应 WP 中先核实再处置

1. **agent 定义（含 readonly）每次派发现读 DB，任务中途编辑/删除 agent 改变串行化与回滚语义**（frontier, P2）——readonly 驱动 writeSem/回滚/快照三件安全关键事，task 启动时只快照 workflow 不快照 agent。若属实，归 WP-5 处置（readonly 在 task 启动时固化）。
2. **retryNode 下游 cascade 占位行继承源无 iteration/parentNodeRunId 过滤**（freshness, 原报 P1）——占位行可能落错 iteration 或变子行而对 frontier 不可见，cascade 静默失效。与 S-13 同源，归 WP-3 核实。
3. **跨 loop/git 边界直连边双重失效**（freshness, 原报 P1）——buildScopeUpstreams 丢弃跨界依赖（消费者不等 loop 完成）+ iteration≤ 窗口只读到第 0 轮，违背 last-iter wins，缺失静默喂空。归 WP-6a 的 validator 禁入规则一并核实。
4. **exitCondition/outputBindings 可引用 loop 体外节点**（freshness, P2）——i≥1 时恒返回 ''，port-empty 恒第 2 轮退出。归 WP-6a。
5. **readPortAtIteration 未跟随 RFC-074 done-only 统一，注释引用废弃比较器**（freshness, P2）——三 picker 口径再次分叉。归 WP-3。
6. **freshest 收敛不彻底 + scheduler↔review 模块环**（freshness, P2）——模块环主张已在附录 B-1 的核实中得到旁证（review.ts:65 反向 import 确认存在），归 WP-3。
7. **triggerDesignerRerun 按 desc(startedAt) 任意 status 选 lastDesigner**（freshness, P2）——NULL 排序与 mark-running 重写 startedAt 两个背离点。归 WP-3。
8. **freshness 复合键偏离 RFC-074 设计（裸 nodeId 键 + absent→fresh），且 freshness.test.ts:53 把缺陷锁成预期**（freshness, P2）——与已确认的 S-7 同域，归 WP-6c 一并核实。
9. **commit&push C4 写锁只罩 add+diff，`git commit` 隔着整个 LLM 会话在锁外**（concurrency, P2）——兄弟 writer 的 commit 可被"反向回退"。归 WP-5 核实（若属实需 write-tree/commit-tree 方案）。
10. **runOneNode 945 行 god-function、SchedulerState 死字段**（architecture, P2）——结构性观察，与既有待办"拆 runOneNode"一致，归 WP-6d / 后续拆分 RFC。

---

_报告完。所有行号以调研时 HEAD（f9db99f 附近）为准；落地各 WP 前请按仓规重新核对行号与 STATE.md 最新状态。_

---

## ⑥ 完整性批评补查点（独立 critic agent 产出，未经对抗核实——接手时先核实再处置）

1. limits.ts（资源限额，daemon 1Hz tick）整个维度未扫描，且有具体可验证缺陷：enforceLimits 以 `now - tasks.startedAt` 判 maxDurationMs（packages/backend/src/services/limits.ts:63-70），而 resumeTask 恢复时不重置 startedAt（task.ts:1010-1018 只清 status/finishedAt/error 字段）——interrupted/awaiting_review/awaiting_human 的暂停时长全部计入墙钟，长暂停后恢复的任务会被 ticker 立即以 task-time-limit-exceeded 取消；另 limits.ts:47-50 在 cancelTask 后对 errorSummary/errorMessage 的无条件覆写是 S-14 清单之外又一个 tasks 非 CAS 盲写点。建议补红测：interrupted 暂停超 maxDurationMs 后 resume，断言不被秒杀。

2. limits.ts:84-90 sumTaskTokens 的注释断言『fan-out children 的 tok_total 已由 runFanOutNode 聚合镜像进 parent（P-4-05）』，但全仓 tokTotal 唯一写点是 runner.ts:1178（无任何镜像写入），注释与实现失真——属 S-26 腐化注释同族但未被收录；若未来按注释补镜像将立即引入 token 双计导致提前误杀任务。

3. gc.ts（每小时 worktree GC）与 resume 语义的冲突未调研：TERMINAL_STATUSES 把可恢复的 'interrupted'/'failed' 也列为 GC 候选（gc.ts:23-28），GC 会删掉用户随后要 resume 的 worktree，而 resumeTask（task.ts:969）不做 worktree 存在性/git 有效性检查就直接 rollbackNodeRunForResume + runTask；另外多仓任务的 worktreePath 是普通 mkdir 容器目录而非 git worktree，`removeWorktree({repoPath: t.repoPath, worktreePath, force: true})`（gc.ts:73）对多仓任务的行为（恒失败→子仓 worktree 永久泄漏，或 force 误删）完全未验证——又一处多仓盲区。

4. exitCondition 共四种 kind，报告只推演了 port-empty / port-equals 两种：在 readPortAtIteration 对 loop 体外节点 i≥1 恒返回 '' 的已确认缺陷前提下，'port-count-lt'（'' → count=0 < n 恒真 → 第 2 轮即退出）和 'port-not-empty'（恒假 → 恒 exhausted，且注释明示这正是 RFC-023 clarify-loop 用例的关键出口）的行为未覆盖（exitCondition.ts:44-58, 64-73），后者意味着 clarify-loop 场景同样命中该缺陷。

5. orphans.ts（boot 孤儿收割 P-4-07）未进入任何调研维度：reapOrphanRuns 把全库 status IN ('running','pending') 的 node_runs 一律翻 interrupted（orphans.ts:30-35 起），不按任务状态过滤——合法暂停中（awaiting_review/awaiting_human）任务的 pending 锚点行、尚未开跑（task=pending）任务的行都会被收割；且 task 状态为 pending 的任务重启后无人 re-kick（只有 stuckTaskDetector S4 的 5 分钟告警、明确 non-goal 不自动修复）。这与 S-1 的建议修法（依赖 pending 行作为幂等派发锚点放行）直接耦合：若按该方案修复，必须同时验证 boot 收割不会把锚点行翻成 interrupted 使修复失效。

6. clarify/review 暂停的『进入路径』未调研（报告只查了答复/决策提交路径 S-1/S-9）：单节点 park 成 awaiting\_\* 并把任务翻 awaiting_human/awaiting_review 时，并行 in-flight 兄弟分支如何处置——是等待汇合、被中断、还是继续写 worktree？任务级状态翻转与兄弟节点收尾之间的窗口（例如兄弟写者在任务已 awaiting_review 后才 done/failed，状态被谁覆写）正是 S-14 盲写 + S-27 quiescent 窗口的上游成因，应专项验证。

7. 『WS 重连后的状态同步』维度整体缺位（S-28 只覆盖广播时序不覆盖重连）：eventsArchive 每小时把最旧 node_run_events 归档成 JSONL 并删除 DB 行（eventsArchive.ts），而 /ws/tasks/{taskId} 的 `?since=N` 断线重连重放从 DB 读 replayTaskEvents（ws/server.ts:276-277）——超过归档阈值的长任务（>1h、大输出）重连后 since 重放必然断档且无任何标记，前端任务详情出现静默事件缺口；归档与重放的契约应补查并至少在 hello 帧里声明截断。

8. 报告多处『已端到端复现/已实证』断言（S-1 注入 rerun 行复现、S-3 真实 scheduler 复现、S-10 drizzle 事务 COMMIT 外实证）依赖调研期间的临时测试脚本，正文未给出已固化为仓内回归测试的文件路径——按本仓 Test-with-every-change 规约，这些复现必须先以 RED 测试落库（命名标注所锁回归）再排修复，否则下一个 session 接手时无法接续验证、修复 PR 也无法证明红→绿；路线图第④节应把『三个复现脚本落库为 gated 测试』列为所有对应修复项的前置依赖。

9. **（2026-06-10 测试网落地时新发现）validator 对 fanout boundary 边误报 `edge-source-port-missing`**：workflow.validator.ts:255-322 的端口收集 switch 没有 `wrapper-fanout` case，wrapper 输出端口集为空集，导致连向 fanout wrapper 边界入口的合法边被判 error——疑似会卡死带 boundary 边 fanout 工作流的 createTask 校验门。既有 workflow-validator-wrapper-fanout.test.ts 全用 toContain 断言，不会暴露此误报。已在 `scheduler-audit-s05-fanout-inner-chain.test.ts` 以 characterization 锁定现状，归 WP-6a 一并处置。

---

## ⑦ 调研过程备注（可信度声明）

- 方法：7 个 finder（frontier/wrappers/lifecycle/freshness/concurrency/history/architecture）→ 每条发现 1-2 个独立对抗核实 agent（refute + coverage 双镜头，P0/P1 双票）→ 汇总合并去重 → 完整性批评。共 97 个 agent、59 条候选 → 33 确认 / 23 存疑 / 3 推翻。
- **核实覆盖缺口**：约 26 个核实 agent 在尾段撞上会话限额（freshness 维度 9 条、architecture 维度 8 条的核实大面积未完成），这些发现已如实降级进附录 C「未经对抗核实」，不计入正文确认清单。接手对应 WP 时须先核实。
- 主笔 session 亲自抽查并确认：S-1（deriveFrontier pending 无桶 + dispatchedThisInvocation 屏蔽，scheduler.ts:1123/1129-1132/675）、S-2（快照写入双轨 :1604/:1627 vs 读取单轨 :3793 + 容器目录回滚吞错 :1529）、S-13 的一处分叉（:3791 `desc(retryIndex)`）、S-14（20+ 个 `update(tasks)` 裸写点 grep 普查）、S-26（dispatchFrontier.ts:1 与 scheduler.ts:993-1005 的 "UNWIRED" 失真注释 vs :620/:1124 实际已接线）。
- 多个核实 agent 用临时脚本做了端到端复现（S-1 菱形拓扑 mid-run 答题、S-3 approve-in-loop 双 resume 卡死、S-10 bun:sqlite async 事务 COMMIT 外实证），这些复现脚本**未落库为回归测试**——按本仓 Test-with-every-change 规约，修复前须先把它们固化为 RED 测试（见 ⑥ 第 8 条）。
- **2026-06-10 更新：测试网已落地**——⑥ 第 8 条已解决。22 个 `scheduler-audit-*` 测试文件 / 78 条用例（全绿的现状锁定 + oracle + 源码守卫三形态，每条带翻转指引），覆盖 S-1~S-22 全部可测项与缺口 1/3/4/5；S-3/S-10 等复现已固化。落地过程中顺带核实了附录 C 的部分条目（#5 readPortAtIteration i≥1 恒空串成立并已锁进 gap4 文件；S-13 fork#6 lifecycleRepair/helpers.ts:42 成立已锁）。各 WP 动刀时先跑对应 `scheduler-audit-s<NN>` 文件，按文件头注释翻转断言。
- 行号基线：HEAD f9db99f（2026-06-10）。
