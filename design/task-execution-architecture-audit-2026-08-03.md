# 任务执行链架构审视报告（2026-08-03）

> **性质**：架构级审视（模块边界 / 抽象 / 耦合 / 状态归属 / 分层），**不是 bug 审计**——逻辑缺陷见 `design/scheduler-audit-2026-06-10.md`、安全见 `docs/audit-backlog.md`。
> **方法**：7 维并行测绘（scheduler-core / wrapper-model / lifecycle-state / runner-runtime / human-in-loop / cross-cutting / data-model），每维一个对抗性复核者逐条推翻（默认立场 = 驳回，须自证「不是有意设计」「不是已修」「不是行数偏见」），再做跨维合并。原始 132 条 → **存活 72 条** → 合并为 **12 条 top issue** + **5 条根因**。
> **复核口径**：每条须有 `file:line` 且复核者独立打开验证；命中 RFC 明确决策且理由仍成立的一律驳回（见 §5 「不是问题」）。

---

## ⓪ 落地进度

| WP                | 状态                        | 说明                    |
| ----------------- | --------------------------- | ----------------------- |
| **WP-0 门禁复明** | ✅ **已落地（2026-08-03）** | 见下方「WP-0 落地记录」 |
| WP-1…WP-10        | 待排期                      | 见 §4                   |

### WP-0 落地记录

**做了什么**

1. `.dependency-cruiser.cjs` 不再自己写 `tsConfig`，改为从 `DEPCRUISE_TSCONFIG` 读 per-package
   tsconfig，且**拿不到就抛错**（fail-closed）——裸跑 `depcruise` 会响亮失败，而不是退回静默失明。
2. 新增 `scripts/depcheck.ts`（照 `scripts/audit-gate.ts` 的门禁范式）：每个 package 各跑一次
   cruise，生成扁平化（无 `extends`、绝对 `baseUrl` + 绝对 `include`）的临时 tsconfig，然后做**三条判据**：
   - **第一方边零未解析** —— 门禁必须看得见图（这是防复辟的棘轮）
   - 没有 `KNOWN_VIOLATIONS` 之外的违规
   - `KNOWN_VIOLATIONS` 里没有**过期**条目（环拆掉了必须同步删条目 ⇒ 允许列表只能缩）
3. `no-circular` 规则的 `from.pathNot` 允许列表（按**文件**排除，会连带放过未来经过同一文件的新环）
   迁进 `KNOWN_VIOLATIONS`，改为按 `(规则, 起点, 终点)` **精确匹配**，每条带 `why` + `removeWhen`。
4. `package.json` 的 `depcheck` 改调新脚本；CI 接线不变（仍是 `bun run depcheck`）。

**实测数字**

|        | 模块 | 依赖边 | couldNotResolve                                             | 违规                                              |
| ------ | ---- | ------ | ----------------------------------------------------------- | ------------------------------------------------- |
| 修复前 | 1678 | 5384   | **3365（62.5%）**                                           | **0**                                             |
| 修复后 | 1223 | —      | 16（全为外部 npm 子路径导出与 `bun` 内建，**第一方 0 条**） | **19**（18 个 runtime 环 + 1 条 services→routes） |

19 条中 **16 条是门禁复明后新暴露的**，3 条是原 `pathNot` 里的存量。

**变异验证**（三条判据逐条真跑，不是纸面声明）

| 变异                                         | 结果                                           |
| -------------------------------------------- | ---------------------------------------------- |
| 临时 tsconfig 去掉 `paths`（还原失明形态）   | ✖ 红：`3349 条第一方 import 解析不了`          |
| 删掉一条 `KNOWN_VIOLATIONS`（模拟新违规）    | ✖ 红：`1 条违规不在允许列表里`                 |
| 加一条不再触发的条目（模拟环已修但条目没删） | ✖ 红：`1 条允许列表条目已不再触发 —— 请删除`   |
| 全部还原                                     | ✔ 绿：`1223 个模块；已接受 19 / 19 条存量违规` |

**测试**：`packages/backend/tests/depcheck-gate.test.ts`（31 例，锁判定逻辑 + 允许列表纪律 + 接线反悔防护，
含真 `require` 断言配置 fail-closed）；`rfc217-architecture-locks.test.ts` 补第 (e) 条 lock——
它原本列了「门是真的」三个条件 (a)(b)(c)(d)，而这四条在门禁失明的两年里**全都是绿的**。

**通用踩坑已沉淀**：`docs/dev-gotchas.md` §测试 / CI 新增两条（静态分析器拿错 tsconfig 会静默失明；
允许列表按文件排除 vs 按违规排除）。

---

## ① 总评

这个平台的任务执行有三层承重结构，而且都做对了、不该动：①图层面的纯核（deriveFrontier / isDispatchable / decideScopeOutcome 是真纯函数且有表驱动测试）；②状态真值的单写者治理（tasks.status / node_runs.status / merge_state 三条生命周期各有唯一写点 + eslint/grep 棘轮 + nodeRunMint 单一工厂）；③runtime 的 driver 能力抽象（DRIVERS 注册表 + 可选能力方法，把 kind 判断基本清出了派发层）。失效点高度集中在一个位置：**图层之下、进程之上的那一段**——「选行/铸行 → 装配参数 → 起一次隔离代理 → 解析产出 → 落库广播」。这段没有任何抽象，于是成了所有新语义的默认落点，把 scheduler.ts 撑到 9021 行、task.ts 4616 行、runNode 单函数 1902 行（两个月内 854→1101→1901，超线性），并已把架构缺口变现成产品缺口：fanout 分片因为「把那一支搬进来要复制 500 行」而永久没有 clarify/review 通道。最根本的成因只有两条：一是**抽象抽了一半就停**——isolatedAgentRun 抽了 iso 锁窗却留下 runNode 参数装配、execution/ 抽了任务级动词却留下节点级机制、转移表建了却只有 1/32 个写点走、resumeTaskWithAtomicSideEffects 建好了只有 1/6 个门在用、verifiedPlanCore 只覆盖流水线 15%，共同点是「抽取完成」的定义里从没包含「旧路径必须消失」；二是**变体用可选字段而非判别联合/接口表达**，义务靠 call-site 记忆——StartTaskDeps 27 字段平铺 5 种互斥启动形态、SpawnPlan 9 个义务字段由 5 个消费者各自兑现、node_runs 无 kind 列靠可空列区分十余种行语义、containmentCoordinator 可选注入漏传即 fail-open。这两条成因两年无人被拦，是因为全仓赖以维系无环分层的 depcheck 门禁把 tsConfig 指向了没有 paths 的 base，后端 61% / 前端 59% 的依赖边解析失败被静默丢弃，CI 今天报 0 违规、换正确 tsconfig 立刻报 16 条——而绕环最常用的 `await import('@/…')` 恰好全落在这个盲区里，「工具+约定双保险」实际退化成纯人肉约定。所以重构顺序不按严重度排，按「哪一刀让后面每一刀都变便宜」排：先用一行配置让门禁复明，再补「一次 agent 执行」这个缺失的下层原语，wrapper 模板方法 / god module 拆分 / 人机门统一都以它为内核；数据模型的身份轴建模（row_kind / seq / scope_path / repo_index）必须排在代码侧收口之后，因为 backfill 的安全性依赖唯一写入点。

### 各维度画像

**scheduler-core** — `scheduler.ts` 已是不折不扣的 god module：9021 行里按职责切分约为——wrapper 三件套 2779 行（30.8%）、`runOneNode`（kind 分派 + agent-single 执行）1397 行（15.5%）、call 节点 1103 行（12.2%）、提示词/技能/MCP 注入与上游取值 665 行（7.4%）、纯 frontier 553 行（6.1%）、任务级状态机与启动校验 522 行（5.8%）、workgroup 宿主节点机制 457 行（5.1%）、scope 派发循环 465 行（5.2%）、iso/merge 恢复重放 432 行（4.8%）。「纯函数 + 副作用外壳」只在**图层面**做成了：`deriveFrontier` / `isDispatchable` / `decideScopeOutcome` 是纯的且有独立测试；但从 frontier 往下（选行/铸行/装配 runNode 参数/落库/广播）全是决策与执行交织的内联长段，`runOneNode` 的重试循环单函数 697 行。`SchedulerState` 不是隐式全局（15 个字段、23 个函数只读传参、仅 2 处 spread 覆写），真正的问题是它把**任务不变量**与**scope 可变坐标**（`repos` / `scopeRoot`）塞进同一个类型，导致嵌套 wrapper 下坐标逐层退化且无编译期提示。`execution/`（1222 行）是一次**正交**抽取——它抽的是「任务级执行动词」（start/watch/outcome/budget/closure/engine），节点级执行机制一行没搬；scheduler.ts 反而因 RFC-243 净增 1171 行。最缺的两个抽象是「节点 kind 执行注册表」和「一次隔离代理运行的下层原语」，下一刀应切在这两处。

**wrapper-model** — 四类 wrapper 在 scheduler.ts 里是四段并列的手写过程，而不是一个抽象的四种实现：没有任何 `WrapperRuntime`/策略对象，"取行或建行 → mark-running → 持久化进度 → 跑内层 → 收尾+广播 → bubble awaiting" 这条骨架被逐字抄了 3~4 份，历史提交（`f39664d0` 同一语义改三处 `allowedFrom`、`46ff73ba` 一次改三段）证明每次语义演进都要人肉巡检 N 处，且第 4 份（RFC-243 call-workflow）落地时已带着不同的 `allowedFrom` 和不同的失败收敛机制。嵌套语义分两套：loop/git 走 `runScope` 真递归（git-in-loop / loop-in-git 天然成立），fanout 完全绕开 `runScope` 直接 `runNode`，只接受 `agent-single` 内层、无 wrapper 私有 canonical、无 awaiting bubble、`clarifyChannel:{kind:'none'}`——`WRAPPER_NODE_KINDS` 的统一成员资格因此几乎不承载共同契约，validator 与 dispatchFrontier 却仍按"它们是同一类"写规则，已经产生"validator 警告 / runtime 硬失败"的自相矛盾与死分支。承重根因在数据模型：`node_runs` 的身份只有扁平的 `iteration` + 一堆后补轴（`retry_index` / `shard_key` / `parent_node_run_id` / `wg_round` / `review_iteration`），没有 scope path，所以 loop-in-loop 只能在 validator 里禁掉、`wrapperRevivalEvidence` 只能停在 depth-1 近似。`nodeIsolation.ts` 与 scheduler 的边界是"写入侧收口、读出侧散落"：`persistIsoBase/persistIsoNodeTree/mergeBackAndSettle` 已抽到 `isolatedAgentRun.ts`，但"行 → IsoHandle"的水合在 scheduler 里手抄 5 处，wrapper 的 merge-back 更是 `mergeBackAndSettle` 的一份分叉，导致 RFC-210 的子模块 merge-agent 钩子与 `pendingSubResolves` 只接到了其中一支。

**lifecycle-state** — 任务状态真值归属是清晰的：`tasks.status` / `node_runs.status` / `node_runs.merge_state` 三条生命周期各有唯一写点（`services/lifecycle.ts`），并由 eslint 规则 + grep 守卫把裸 UPDATE 锁死在该文件内，行 INSERT 也收敛到 `nodeRunMint.ts` 单一工厂——这层治理在全仓属上乘。问题出在真值之外的三层：①「合法转移」的单一转移表（`shared/lifecycle.ts` 的 `nextTaskStatus` / `nextNodeRunStatus`）已存在却几乎无人走事件路径（task 级 31 个写点只有 1 个用 `transitionTaskStatusByEvent`），30 处手抄的 `allowedFrom` 已经写出表明确禁止的边（`awaiting_*→interrupted`、`done→failed`、`canceled→running`），转移表事实上只描述了约 1/3 的真实边，却仍以「SSOT」自居；②「谁拥有这个任务」有四套互不知情的登记处（`activeTasks` Map / `driverLease` Map / `tasks.workspace_pruning_at` / `materializingSpaces` Map），其中 `driverLease` 宣称的 auto↔human 互斥在代码里根本不成立（人工路径零调用、`isDriverLeaseHeld` 零生产调用方）；③ 自愈者已增殖到 10 个，触发时机（boot 一次 / 1Hz / 5min / 10min / 1h / 事件钩子）、判据来源、守卫组合（driver 门 / lease / 熔断 / 隔离 / DB claim）呈稀疏矩阵，历史上 RFC-165/187/202/230 四次事故全部源于「某个 healer 不知道另一个 healer 的判据」。此外 `services/task.ts` 4616 行里同居着 5 个彼此无耦合的子域（1363 行工作区物化 / 698 行启动 / 700 行恢复重试 / 817 行读模型投影），并与 `scheduler.ts` 构成真实的值级循环依赖。

**runner-runtime** — 执行落地层的抽象骨架（`RuntimeDriver` 能力对象 + `DRIVERS` 注册表 + `SpawnPlan` 契约）方向是对的：`driver.kind === 'xxx'` 的分支已被 RFC-143/237 基本清光，`readInventory?` / `startLiveCapture?` / `captureSessionsToSink?` / `mcpTest?` 这种 null-object 可选能力也用得很规范，`runtime/opencode/` 29 个文件的内部依赖图无环、分层清晰（leaf schema → mechanics → plan → launcher），这些都不该动。真正的承重问题在三处。第一，方法派发层 kind-blind 了，**数据与状态机层没有**：整个 OpenCode session 所有权状态机（control marker 解析、lease claim/confirm/release、execution-identity 失败码）直接住在通用 `runner.ts` 里，`SpawnPlan.control` 名为 runtime-neutral 实为两个 `opencode-*` 变体。第二，「把一个计划变成一个真实子进程」这个平台最核心的原语被 fork 了 4 份（runner / systemAgentRun / memoryDistiller / runtimeSmoke），kill 降级语义与 grace 常量已经各不相同；同样地 verified plan 装配管线 fork 了 3 份，其中 source-fingerprint 二次扫描与 manifest 落盘的**顺序已经漂移**。第三，几个关键判定位的真值来源不唯一：生产/测试信任位靠 `WeakSet` 对象身份传递，argv head 有三个优先级互相倒挂的解析函数，containment 同时存在 RFC-205 `SandboxCtx` 与 RFC-233 `PreparedContainmentPlan` 两套对象模型且协调器是可选注入（漏传 = 静默 fail-open）。`runNode` 单函数 1902 行、43 个入参字段，是上述所有问题的汇流点，也是继续加功能会指数级恶化的那块承重墙。

**human-in-loop** — 「暂停等人 → 人给输入 → 继续」在本仓有 **6 套并行实现**（self-clarify / cross-clarify / review 决策 / task-question 看板下发 / workgroup 完成门 / dw-confirm），它们**只共享 `node_runs.status='awaiting_*'` 这一个字符串**，其余 open-gate 写、门态真值、成员校验、乐观锁、WS 事件、pending-count、resume 踢腿、wrapper 复活证据全部各写一遍——`awaiting_human|awaiting_review` 在 scheduler 之外的 57 个文件里出现 511 次。更承重的是 **HTTP 应答路径已经长成第二个调度器**：`routes/clarify.ts` / `routes/reviews.ts` / `routes/taskQuestions.ts` 在请求线程里算上游 frontier、铸 `node_runs`、`reset --hard` worktree、cancel 在飞行，而 `taskQuestionDispatch.ts`(1772 行) 自带一套 `computeUpstreamFrontier` / in-flight 门 / 借壳 / readiness，最后又被 scheduler tick 顶端反向调用（`scheduler.ts:1503`），分层完全倒置成环。「门开着没有」的真值同时散在 2~4 张表（clarify_rounds.status **和** node_runs.status 是两个独立 park 信号），只能靠 `rfc053-allow-direct-status-write` 逃生舱手工做原子。park 信号本身是无载荷裸 kind，任务级分支直接丢弃 detail，逼得 workgroup 另建 `pause_reason` 侧信道；wrapper 复活证据把「pending 行 or review done 行」硬编码进 frontier，等于每加一种 gate 都要回到 `dispatchFrontier.ts` 补形状。clarify 域 8 个模块是按 RFC 时间线增生（RFC-023/056/058/120/128/131/132/136/162/217 层层叠加）而非领域分解，唯一一个 `clarify/` 目录里只躺着 1 个文件、6 个兄弟平铺在 services/ 根。

**cross-cutting** — 这个仓的跨切面结构总体是「有意识设计过、但守卫失效」的形态。分层意图明确且真实落地：services 不依赖 routes、禁 module cycle、tasks.status 单写者（lifecycle.ts + grep guard）、NodeKind 用 6 处 `satisfies Record<NodeKind,…>` 穷举注册表、WS 走 RFC-152 channel registry、runtime 走 RFC-111/143 driver 抽象（driver 外只剩 8 处 `=== 'opencode'`）——这些都不该动。真正的承重问题是：(1) 全仓赖以维系无环分层的 `bun run depcheck` 门禁把 tsConfig 指向了没有 `paths` 的 base，`@/` 别名 100% 解析失败、后端 61% 依赖边对门禁不可见，CI 今天报 0 违规，换成正确 tsconfig 立刻报 16 条（15 环 + 1 条 services→routes），「工具+约定双保险」实际退化成纯人肉约定。(2) 任务执行的入口装配没有单一事实源：launch 有 `buildStartTaskDeps`，resume 却有 6 份手抄 deps，其中 4 份已真实漏掉 `subagentLiveCapture`，同一问题 dedup-audit 2026-06-13 已记录、7 周未收敛。(3) scheduler.ts(9021 行)/task.ts(4616 行) 两个 god module 同时是 task↔scheduler 运行时环的两端，`StartTaskDeps` 把基础设施、已解析配置、5 种互斥启动形态、测试缝混装成 27 个平行 optional 字段。(4) 23 处 setInterval 无统一注册/停机编排点。修复顺序应是先修门禁（一行配置换真值），再按门禁暴露的环拆 scheduler/task。

**data-model** — 执行态的真值几乎全部压在两张宽表上：node_runs（51 列 / 12 个 JSON blob 列）与 tasks（49 列）。135 个迁移里有 33 条是 ALTER TABLE node_runs ADD COLUMN、32 条是 ALTER TABLE tasks ADD COLUMN——演进方式就是「每个 RFC 往 god table 上再挂几列」。node_runs 是典型单表多态：普通节点 / wrapper / shard 子行 / aggregator / IO 虚拟行 / retry / commit&push / workgroup host / call / review·clarify park 十余种语义共用一行，靠 parentNodeRunId 是否为 null（34 处）、shardKey 是否为 null（14 处）、node_id 魔法前缀、以及若干「非空即某类」的 JSON 列区分，全表没有任何 kind 列。行的新旧判定完全建立在 ULID 字典序这条未被数据库强制的前提上，而前端还并存一套 startedAt 排序，两套口径靠注释里的「应该一致」维系。多仓/单仓被做成两套持久化表示（标量列 vs JSON map），repoCount === 1 的分叉解码在 scheduler 里复制了 5 份，tasks.\* 又长期镜像 task_repos[0]。读模型侧没有查询层：review / clarify 的列表端点直接整表 select 后在 JS 里 join，并对每个 task 反复 JSON.parse(workflow_snapshot)。写模型侧不对称：node_runs 有唯一 mint 工厂 + grep 守卫，node_run_outputs 却有 13 处裸 insert、隐式契约只靠注释。迁移本身是 daemon 启动时自动跑、无停机，这一点健康；真正的债是列累积、blob 承载关系、无投影表。

---

## ② 根因（多个症状共享的同一个结构选择）

### RC-1 抽象抽了一半就停——「抽取完成」的定义里从不包含「旧路径必须消失」

本仓反复出现同一形态：正确的共享原语被建出来，但调用点没有被强制走它，于是新抽象只是多了一个选项、旧写法继续繁殖、后续改进只落到其中一支。没有任何一次抽取配套了「必填参数 / 编译期穷举 / grep 守卫 / 删除旧导出」这类把旧路径封死的机制。这条根因单独解释了清单里过半的发现，而且有一个可执行的通用修法：每次抽取的验收清单里强制包含一条『旧路径的源码级不可达证明』。

症状：

- isolatedAgentRun 抽了 iso 锁窗与 merge-back，却把 runNode 参数装配留在原地，RFC-248 的 mountPath/readonly 换个字段继续漂（3/11 处修对）
- shared/lifecycle 的转移表建成 SSOT，实测 32 个任务状态写点只有 1 个走事件路径，30 处手抄已写出表禁止的边
- resumeTaskWithAtomicSideEffects 文档头明写「Gate decisions use this instead of write-then-fire-and-forget」，实测 6 个门里只有 1 个在用
- nodeRunMint 把 node_runs 的 13 处裸 insert 收成唯一工厂 + grep 守卫，node_run_outputs 的 13 处裸 insert 完全没有对应机制
- verifiedPlanCore 只覆盖 8 步流水线的约 15%，三个 builder 各写一遍且顺序已漂移；captureOpencodeSessionsToSink 抽好了 distillSessionCapture 没迁（RFC-234 plan.md:30 登记为遗留）
- execution/ 抽走任务级执行动词后 scheduler.ts 反而净增 1171 行；facade 自称唯一 choke point 却有被文档化的旁路且源码锁不含旁路所在文件

### RC-2 变体用可选字段表达，义务靠 call-site 记忆——编译器被主动请出了扩展点

每当出现「同一个东西的 N 种形态」或「调用方必须做的 N 件事」，本仓的默认选择是往一个结构体上加可空/可选字段，而不是判别联合、必填字段或接口。结果是非法组合可编译、漏兑现无信号、失败模式一律静默且方向常常是 fail-open（降级、跳过、退回默认值）。这条根因决定了「每加一种 X 就要改 N 处」这个成本模式，也决定了漏改为什么永远抓不到。

症状：

- StartTaskDeps 27 字段平铺 5 种互斥启动形态，互斥关系只写在散文注释里，49 处 deps.<variant> 分支
- SpawnPlan 9 个字段是给 spawn 方的义务而非数据，由 5 个独立消费者各自兑现，preSpawnVerify 已有一次多 RFC 周期的静默空转
- containmentCoordinator 可选注入 + 28 处 `=== undefined` 旁路，漏传即整段跳过 admit、静默 fail-open，唯一守卫是一条数正则的测试
- node_runs 无 kind 列，十余种行语义靠可空列与魔法 node_id 前缀区分；WrapperProgressSchema 全字段 optional 不是判别联合
- executionPolicyViolations 第一句 `if (protocol !== 'opencode') return []`——第三个 runtime 接进来时三条门禁静默全失效
- AppDeps 每加一个会跑 agent 的子系统就 +1 个 \*TestDependencies 槽，三处各写 `deps.runFn ?? runSystemAgent`

### RC-3 执行态的身份轴是后补的列，不是被建模的概念

「这一行是什么 / 属于谁 / 是第几次 / 在哪个 scope / 哪个仓」这五个问题在 node_runs 上都没有显式建模，而是每来一种新执行体就补一根正交轴或一个可空列（33 条 ADD COLUMN），并且「最新」这条最基础的语义靠一个不受数据库约束、已知在同毫秒下会失序的外部 id 生成器隐式保证。后果不只是查询退化成全表扫 + JS 过滤，更是把功能缺口外化成了产品缺口——wrapper 任意嵌套是文档承诺的核心能力，而数据模型只能表达一层迭代，于是 loop-in-loop 被 validator 直接拒绝启动。

症状：

- 六根并列身份轴（parentNodeRunId / iteration / shardKey / retryIndex / wgRound / reviewIteration）+ 无 kind 列 + 无 scope path
- loop-in-loop 在 validator 判 error 拒绝启动（message 自陈 audit S-6），wrapperRevivalEvidence 停在 depth-1 且被 RFC-098 记为 accepted
- isFresherNodeRun 就是 `id > id`，mint 用普通 ulid() 无 monotonicFactory；前端并存 startedAt 排序而 clarify/review rerun 显式写 startedAt:null
- 「哪些行属于我」有两套互不相交表示（父指针 vs 定义层后代），innerRunsOf 是全仓唯一并起两者的地方，四个消费者各取一半
- 仓身份两个并行键（mount_path 规范键 vs 待删的 worktree_dir_name 仍是 4 个 JSON map 的键），8 处裸 `mountPath: r.worktreeDirName` 赋值
- 单/多仓两套物理表示，repoCount===1 分叉解码在 scheduler 复制 6 份；nodeRollback 模块头记录了因读错列造成的 S-2 事故

### RC-4 机制归属由「当时撞上了什么约束」决定，而非由领域决定——而绕开约束的手法恰好是门禁的盲区

模块边界的实际形状不是领域分解的结果，而是历次「撞上 module cycle / 撞上测试拿不到符号」时规避动作留下的沉积：为绕环把外部子系统的机制搬进 scheduler、为绕环用 `await import('@/…')`、为绕环用单槽位全局钩子、为图省事把平台边界机制留在第一个用到它的驱动子树里。最危险的是这条根因与 A1 互相掩护——`await import('@/…')` 这种绕环写法 100% 落在依赖门禁的解析盲区里，所以两年来既没有人被拦、也没有人知道环存在。

症状：

- buildWorkgroupHooks(453 行) 留在 scheduler.ts，注释自陈是为了让 workgroupRunner 不 import scheduler（module-cycle ban）
- scheduler.ts 5 处 `await import('@/services/…')`，其中 3 处取的模块 :182 已经静态 import 了——纯属绕环民俗
- 平台 containment 组合根 import 某个 driver 子树，兄弟驱动 claudeCode 跨目录 import opencode 私有模块；同一成因的第二份副本已造成过一次真实容器逃逸（RFC-242）
- terminalTaskHook 用单槽位全局变量避 cycle，第二个订阅者只能另起 executionWatch，第三个又另起 childBudget
- opencode session 所有权状态机整个住在通用 runner.ts，而 RFC-224 design.md 声称 SpawnPlan.control 是 runtime-neutral
- 四个受围子命令与整个 daemon 共用 main.ts 的静态 import 图，实测冷态首答 646ms 并已产出用户可见的 MCP pending

### RC-5 测试可达性反向决定生产模块边界，把重构成本人为抬高

因为核心模块大到无法从真入口测试，内部件被 export 出来供测试直取；因为搬迁会打红这些测试，测试反过来成为「别动它」的理由。更进一步，有些不变量本身只由源码文本断言维系（数正则次数、断言两个函数物理相邻），于是这些不变量把生产代码的物理排布锁成了长期契约。这条根因不改，前面每一条重构的第一步都会先撞上一堵测试墙——所以 roadmap 里 WP-1 专门先做「测试缝退出生产面」。

症状：

- scheduler.ts 7 个 export 生产零消费者（prepareNodeRunInjection / createOrRebuildWrapperIso / composePriorOutputBlock / resolveUpstreamInputs / fanoutInnerAgentKey / freshestPriorRunWithOutput / shouldRetryNodeFailure），96 个测试文件钉住这张面
- scheduler.ts:1284 一个注释自认「为让六个测试文件不改 import」的转发壳
- rfc144 用 `src.indexOf(...)` 到 `src.indexOf(...)` 的源码文本切片断言 CAS 早于 discard，把「函数必须保持 export 且必须紧挨着另一个函数」锁成契约
- rfc188 allowlist 断言 `mergeBackNodeIso(` 计数 === 1，把「wrapper 保留一处裸调用」锁成长期契约，于是 RFC-210 的增强只落到 agent 一侧
- rfc233 的生产守卫是一条数 `await runNode({` 出现次数的正则，只覆盖 scheduler 一个文件
- AppDeps 里 5 个纯测试槽 + 三处 `?? runSystemAgent`，测试脚手架穿透到生产顶层依赖契约

---

## ③ 合并后的问题清单（按架构承重程度排序）

| 编号 | 级别 | 一句话                                                                                                                                            | 主要位置                                                             |
| ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| A1   | P0   | 依赖门禁失明：depcruise 用无 paths 的 tsconfig，后端 61%/前端 59% 依赖边被静默丢弃，全仓分层纪律没有机器保底                                      | .dependency-cruiser.cjs:97                                           |
| A2   | P0   | 「执行一次 agent」没有下层原语：runNode 1902 行/43 入参 god function，上游 6 处手工装配 + 9 份 iso→repos 投影 + 3 份重试预算，能力集永久分叉      | packages/backend/src/services/runner.ts:691                          |
| A3   | P1   | god module 双子星与 task↔scheduler 值级运行时环：scheduler.ts 9021 行只有 2 个 importer，靠 5 处 `await import` 反向调 ta                         | packages/backend/src/services/task.ts:114                            |
| A4   | P1   | wrapper 生命周期没有策略接口：三份手写外壳（loop/git 逐行 44% 相同）+ 两份孪生分片壳，一处语义变更要人肉巡检 N 处，RFC-248/RFC-210 都已只改对一半 | packages/backend/src/services/scheduler.ts:5667                      |
| A5   | P1   | node_runs 的身份轴是后补的列不是被建模的概念：无 kind 列、无 scope path、无显式序、归属两套表示、仓身份两个并行键、单/多仓两套物理形态            | packages/backend/src/db/schema.ts:1252                               |
| A6   | P1   | 人机门没有共同抽象：6 套 gate 只共享一个状态字符串，门态跨 2~4 张表且无 owner，park 信号无载荷，已有的原子释放原语 6 个门里只有 1 个在用          | packages/backend/src/services/clarifySeal.ts:332                     |
| A7   | P1   | HTTP 应答路径已长成第二个调度器：请求线程 reset worktree、cancel 在飞、铸 node_run，taskQuestionDispatch 自带 1772 行规划引擎，并被 sc            | packages/backend/src/services/scheduler.ts:1503                      |
| A8   | P1   | 任务执行入口装配无单一事实源：resume 6 处手抄（4 处已真实漏 subagentLiveCapture），StartTaskDeps 27 字段平铺 5 种互斥启动形态，父子 round-tr      | packages/backend/src/services/task.ts:196                            |
| A9   | P1   | 平台级边界机制寄居在 opencode 驱动子树，被组合根与兄弟驱动反向依赖；四个受围子命令还共用 daemon 的静态 import 图                                  | packages/backend/src/services/runtime/opencode/sealedSubprocess.ts:1 |
| A10  | P1   | 「把一个计划变成一个真实子进程」被 fork 4~5 份且 kill 降级/行分帧已互不相同；生产信任位靠 WeakSet 对象身份，argv head 三个解析器优先级互相倒挂    | packages/backend/src/services/runner.ts:2683                         |
| A11  | P1   | 权威关系被存成 JSON blob，读模型没有查询层：11 个文件各自 JSON.parse(workflow_snapshot) 重建索引，列表端点整表 select 后 JS join，一个反问问      | packages/backend/src/services/review.ts:1251                         |
| A12  | P1   | 生命周期治理不对称：状态真值收口极好，但通知/自愈/中断原因/委派全无 owner——转移表只覆盖 1/32 写点，WS 帧靠调用点自觉，自愈判据寄生在人读文本列    | packages/backend/src/services/lifecycle.ts:334                       |

### A1｜P0｜依赖门禁失明：depcruise 用无 paths 的 tsconfig，后端 61%/前端 59% 依赖边被静默丢弃，全仓分层纪律没有机器保底

- **维度**：cross-cutting, lifecycle-state　**来源发现**：XCUT-1, LIFECYCLE-STATE-MISSED#1
- **锚点**：.dependency-cruiser.cjs:97; packages/backend/tsconfig.json:7; packages/frontend/tsconfig.json:8; packages/backend/src/services/apiDocs.ts:28; packages/backend/tests/rfc217-architecture-locks.test.ts:24; .github/workflows/ci.yml:53
- **根因**：`options.tsConfig.fileName='tsconfig.base.json'` 而 base 里 paths 出现次数为 0；`@/*` 只定义在各 package 的 tsconfig。凡 `@/` 写法的 import 一律 couldNotResolve 被丢出图。实测 `bun run depcheck` 绿（1675 modules / 5376 deps），仅把 tsConfig 换成 packages/backend/tsconfig.json 重跑立刻报 16 条违规（15 环 + 1 条 services→routes：apiDocs.ts:28 import `@/routes/registry`）。rfc217-architecture-locks 的三条「门是真的」断言只验证规则存在 / CI 跑了 / constants 是叶子，唯独没验证门看得见图。
- **重构方向**：①`depcheck` 拆成三条 per-package `depcruise --ts-config packages/<pkg>/tsconfig.json`（实测 enhancedResolveOptions.alias 不被 schema 接受，只能走 per-package tsConfig）；②16 条违规写进 `from.pathNot` 白名单并各挂 issue，白名单只许缩不许涨，且区分「真环」（task↔scheduler、executor→…→scheduler）与「RFC-034 有注释的 lazy import、无 RFC-079 初始化风险」（util/git↔services/git\*）；③加元测试断言 depcruise JSON 的 `couldNotResolve` 边数为 0（棘轮），把「门看得见图」本身锁成事实；④apiDocs 的 routes/registry meta 下沉 shared 或把 apiDocs 移到 routes 层。
- **影响面**：配置 1 文件 + package.json 1 行；随后白名单登记 1 个 commit。它是本 roadmap 里每一个后续 WP 的前置——不修则所有拆分的回归对 CI 不可见。

### A2｜P0｜「执行一次 agent」没有下层原语：runNode 1902 行/43 入参 god function，上游 6 处手工装配 + 9 份 iso→repos 投影 + 3 份重试预算，能力集永久分叉

- **维度**：scheduler-core, runner-runtime, cross-cutting, wrapper-model　**来源发现**：RUN-1, SCHED-2, SCHEDULER-CORE-MISSED#1, CROSS-CUTTING-MISSED#1, RUNNER-RUNTIME-MISSED#1
- **锚点**：packages/backend/src/services/runner.ts:691; packages/backend/src/services/runner.ts:166; packages/backend/src/services/scheduler.ts:4955; packages/backend/src/services/scheduler.ts:6489; packages/backend/src/services/scheduler.ts:7879; packages/backend/src/services/isolatedAgentRun.ts:9; packages/backend/src/services/runtime/types.ts:132; packages/backend/src/services/scheduler.ts:6503
- **根因**：被调侧：runNode 691→2592（1902 行）单函数同时持有业务语义（clarify/review/envelope/port）、opencode session 租约状态机、进程生命周期、DB 事务 CAS、WS 广播，43 个入参，6 处早退各复制完整返回体；两个月内 854→1101→1901 是超线性增长，RFC-143 的抽取发生在这段区间内却没压住曲线。调用侧：6 个 `await runNode({…})` 站点各手写 20~26 键、12 键六处全同、无共享构造器；`iso.repos → repos[]` 投影手抄 9 份（三种目标类型），RFC-248 的 readonly 语义只落到 3/11 处（:7879 innerState 写死 `readonly:false` 而同函数 :7859 用真值 → 嵌套 wrapper 里只读成员重新进 git_diff）；重试预算三份（shard/aggregator 逐字同构的 19 行外壳 + agent-single 内联第三种形态）。契约侧：SpawnPlan 9 个字段是给 spawn 方的**义务**而非数据，由 5 个独立消费者各自兑现，preSpawnVerify 已有一次登记在案的多 RFC 周期静默空转。产品后果：scheduler.ts:6489-6494 自陈 fanout 分片「因为要复制 500 行」而永久无 clarify/review 通道。
- **重构方向**：四步，从最安全的一刀开始：①`services/nodeRun/interpret.ts` — 把 envelope/clarify/port 校验抽成纯函数 `(accumulatedText, envelopeNonce, clarifyDisposition, declaredPorts) => NodeRunOutcome`（零 IO、不触 lease 时序，可独立 PR 且立刻可单测）；②两个纯投影函数 `projectIsoSchedulerRepos` / `projectIsoTemplateRepos` 收掉 9 处手抄，配源码断言禁止 `readonly: false` 出现在 innerState 构造；③`services/execution/agentAttempt.ts: runAgentAttempt(ctx, {agent, injection, isoRepos, clarifyChannel?, reviewContext?, priorOutputBlock?, followup?})` — 「一次 agent 尝试」升成可复用单元，四个站点（agent-single / shard / aggregator / workgroup 宿主）改为传 optional 通道参数，分片要 clarify 从此是传一个参数；同时抽 `withNodeRetryBudget` 吃掉两份逐字同构的重试壳；④driver 不再返回裸 SpawnPlan 而返回 `LaunchablePlan{cmd, env, launch(io)}`，preSpawnVerify / sandbox 包裹 / containment 投影 / readOnlySubtrees / cleanup finally / control 握手在 launch() 内按固定顺序执行，消费者拿不到跳过某一步的机会。
- **影响面**：runner.ts 大幅瘦身 + 5-7 个新文件 + scheduler 6 个调用点；不改 DB schema、不改对外契约。它是 A3/A4 的内核——不先做，wrapper 模板方法与 scheduler 拆分只能搬运重复代码。

### A3｜P1｜god module 双子星与 task↔scheduler 值级运行时环：scheduler.ts 9021 行只有 2 个 importer，靠 5 处 `await import` 反向调 task.ts；7 个 export 零生产消费者是测试撑出来的

- **维度**：cross-cutting, lifecycle-state, scheduler-core　**来源发现**：XCUT-3, LIFE-4, SCHED-5, SCHED-8, SCHEDULER-CORE-MISSED#2
- **锚点**：packages/backend/src/services/task.ts:114; packages/backend/src/services/scheduler.ts:182; packages/backend/src/services/scheduler.ts:3196; packages/backend/src/services/scheduler.ts:814; packages/backend/src/services/scheduler.ts:1284; packages/backend/src/services/lifecycleRepair/options-S1.ts:23; packages/backend/src/services/task.ts:422; packages/backend/src/services/execution/executor.ts:30
- **根因**：task.ts:114 `import { runTask } from './scheduler'` 与 scheduler.ts:182 `import { emitTaskStatus, getTask } from '@/services/task'` 构成真实值级环；scheduler 内 5 处 `await import('@/services/…')`，其中 3196/3237/3256 取的模块 :182 已静态 import 了——纯属绕环民俗。task.ts 4616 行同居 5 个无耦合子域，其中 1363 行工作区物化对生命周期符号 grep 零命中却被三方独立消费。scheduler.ts 的公共面是测试撑出来的：prepareNodeRunInjection / createOrRebuildWrapperIso / composePriorOutputBlock / resolveUpstreamInputs / fanoutInnerAgentKey / freshestPriorRunWithOutput / shouldRetryNodeFailure 七个 export 生产零命中，加 :1284 一个注释自认「为让六个测试文件不改 import」的转发壳，96 个测试文件钉住这张面。execution/(1222 行) 是正交抽取（只抽任务级动词），RFC-243 期间 scheduler.ts 反而净增 1171 行；executor 自称唯一 choke point 却被 :3880 的 workgroup 旁路绕开，源码锁的 CALL_FACES 不含 scheduler.ts。
- **重构方向**：①纯位移：Frontier / deriveFrontier / buildScopeUpstreams / findScopeCycle / buildContainerMap 整体搬进已存在的 dispatchFrontier.ts（已验证零新增依赖方向），删 :1284 转发壳，6 个测试 import 改指 freshness.ts——搬完 scheduler.ts 在 src/ 里成为零 importer 叶子；②`services/taskDriver.ts` 独占 activeTasks + emitTaskStatus + 统一的 kickScheduler，scheduler 改 import 它而非 task.ts，环即消失、5 处动态 import 可删；③再切 `services/workspace/materialize.ts`（379-1741）与 `services/taskReadModel.ts`，task.ts 收缩到约 1500 行编排层；④剩余 export 按归属搬走，并加源码断言：scheduler.ts 的 export 只允许 runTask / RunTaskOptions / buildWorkgroupHooks；⑤把 workgroup 旁路收进 facade 并把 CALL_FACES 补上 scheduler.ts。
- **影响面**：约 30 个文件改 import 路径 + 3-4 个新模块；零语义变更但 diff 大。必须在 A1 之后做，否则拆完没有门禁守住新环。

### A4｜P1｜wrapper 生命周期没有策略接口：三份手写外壳（loop/git 逐行 44% 相同）+ 两份孪生分片壳，一处语义变更要人肉巡检 N 处，RFC-248/RFC-210 都已只改对一半

- **维度**：wrapper-model, scheduler-core, human-in-loop　**来源发现**：SCHED-3, WRAP-1, WRAP-4, WRAP-5, WRAP-6, WRAP-7, HIL-8, SCHED-4, WRAPPER-MODEL-MISSED#2
- **锚点**：packages/backend/src/services/scheduler.ts:5667; packages/backend/src/services/scheduler.ts:7726; packages/backend/src/services/scheduler.ts:5938; packages/backend/src/services/scheduler.ts:6503; packages/backend/src/services/scheduler.ts:7649; packages/backend/src/services/scheduler.ts:7493; packages/backend/src/services/scheduler.ts:7970; packages/backend/tests/rfc144-stale-replay-regression.test.ts:458
- **根因**：loop(264 行)/fanout(495)/git(366) 是三段并列过程而非一个抽象的三种实现：difflib 实测 loop vs git ratio 0.437、86 行完全相同、最长相同块 15 行（awaiting 分支整段）；`allowedFrom:['pending','awaiting_review','awaiting_human','interrupted','canceled']` 逐字出现 3 次；markWrapperTerminal 后手工配对 broadcastNodeStatus 20 对；shard/aggregator 的 19 行重试壳逐字同构。共享出去的只有 runWrapperNode(6 行)/findResumableWrapperRun/markWrapperTerminal/createOrRebuildWrapperIso/mergeBackWrapperIso 五件。已产生的真实漂移：git innerState `readonly:false`（RFC-248 只改对 loop）、git park 路径丢 baselines/preDirtyByRepo（多仓 resume 后非挂根仓 baseline 退化）、mergeBackWrapperIso 是 mergeBackAndSettle 的分叉且没接上 RFC-210 的子模块 merge-agent 钩子与 pendingSubResolves fail-closed 门。「行→IsoHandle」水合在 scheduler 手抄 6 处、参数集已不一致。RFC-188 明确把 wrapper 样板收敛列为留候选，WP-6d 至今未做；测试 allowlist（rfc188 断言 `mergeBackNodeIso(` 计数 ===1、rfc144 用源码文本切片断言函数物理相邻）已把分叉锁成长期契约。
- **重构方向**：①建 `services/wrapper/runtime.ts` 的模板方法 `runWrapperNode(state, args, strategy)`，把序幕（复用锚点判定 → mint → mark-running → 建 iso → innerState 投影）、收尾三分支、mergeBack、markTerminal+broadcast 全部升到外壳；`WrapperStrategy` 只留 initProgress / runInner / progressPayload / finalize 四个函数槽，能力位（resumeAllowedFrom / bubblesAwaiting / acceptedInnerKinds）加进**已存在的** NODE_KIND_BEHAVIORS，不要新建第二张 kind 表；②call-workflow 不并入（不在 WRAPPER_NODE_KINDS、不递归 runScope、结构上不进 awaiting）；③mergeBackWrapperIso 降为 mergeBackAndSettle 的薄适配（显式传 state.writeSem + conflictResolver + extraForcedContainerPaths，保留 wrapper 自己的 catch 站位），rfc188 allowlist 期望从 1 改 0；④`hydrateIsoHandle`/`decodeIsoMaps` 收掉 6 处手抄，parseIsoJsonMap/parseIsoSubmodules 与编码器同址；⑤WrapperProgressSchema 改判别联合 + 构造器，禁止内联对象字面量；⑥awaiting 冒泡抽 `parkWrapperOnInnerGate` + `PARK_MAP satisfies Record<GateParkKind,…>`；⑦合并 shard/aggregator 为 `dispatchFanoutInner(role, …)`。
- **影响面**：scheduler.ts 约 1500 行迁移（仅 fanout 一项就 -830→+450）+ 新建 wrapper/ 目录 3-5 文件；无 DB 迁移。按 RFC-188 的 golden dump 对照范式交付。

### A5｜P1｜node_runs 的身份轴是后补的列不是被建模的概念：无 kind 列、无 scope path、无显式序、归属两套表示、仓身份两个并行键、单/多仓两套物理形态

- **维度**：data-model, wrapper-model, scheduler-core　**来源发现**：DM-1, DM-2, DM-3, DM-8, WRAP-3, WRAPPER-MODEL-MISSED#1
- **锚点**：packages/backend/src/db/schema.ts:1252; packages/backend/src/db/schema.ts:1417; packages/backend/src/db/schema.ts:1186; packages/backend/src/services/workflow.validator.ts:769; packages/backend/src/services/dispatchFrontier.ts:236; packages/backend/src/services/freshness.ts:156; packages/backend/src/services/nodeRunMint.ts:190; packages/backend/src/services/runLiveness.ts:266; packages/backend/src/services/scheduler.ts:2533
- **根因**：51 列 / 12 个 JSON blob，135 个迁移里 33 条是 `ALTER TABLE node_runs ADD COLUMN`。①无 kind 列：十余种行语义靠 parentNodeRunId 是否 null（29 处谓词）、shardKey 是否 null（14 处）、commit_push_json / child_task_id 非空、以及 `__commit_push__:` / `__wg_member__` 魔法前缀区分，taskQuestions.ts:846 自陈命名空间冲突只能靠 call-site 消歧；②无 scope path：iteration 是扁平轴，于是 loop-in-loop 被 validator 判 **error** 拒绝启动（message 自陈 audit S-6）、wrapperRevivalEvidence 停在 depth-1 近似，每来一种带基数的执行体就补一根正交轴（shardKey / wgRound / reviewIteration / clarifyGeneration，RFC-189 design 明确否决复用 iteration）；③无显式序：isFresherNodeRun 就是 `candidate.id > incumbent.id`，而 mint 用普通 `ulid()`（全仓无 monotonicFactory），前端并存 `startedAt ?? 0` 排序而 clarify/review rerun 显式写 startedAt:null → 最新 rerun 排最旧；④归属两套：fanout 子行带父指针、git/loop 内层行**故意不带**（因为 parentNodeRunId 被重载成「fan-out 子行」判据），innerRunsOf 是全仓唯一并起两者的地方，四个消费者各取一半；⑤仓身份两个并行键：mount_path 已宣告为规范键但 4 个 per-repo JSON map 的键仍是待删的 worktree_dir_name，代码里 8 处裸 `mountPath: r.worktreeDirName` 赋值；⑥单/多仓两套物理表示，repoCount===1 分叉解码在 scheduler 复制 6 份，nodeRollback 模块头记录了因读错列造成的 S-2 事故。
- **重构方向**：分四批迁移，每批用新旧口径互 oracle（复用 RFC-189 migration 0095 范式）：①`row_kind TEXT NOT NULL` 由 buildMintNodeRunValues 强制写入 + 存量 backfill，内存谓词改 `eq(nodeRuns.rowKind,…)` 下推 SQL；合成身份用 `synthetic_kind + host_node_id + repo_key` 三列取代字符串前缀解析；②`seq INTEGER NOT NULL` per-task 严格递增（在 mintNodeRun 已有的 dbTxSync 内 `max(seq)+1`，天然串行）+ `uniqueIndex(task_id, seq)`，isFresherNodeRun 改比 seq，前端三个 nav 模块与 tasks.detail 的 startedAt 比较统一换掉——仓内 intent_turns.seq 与 mcp_runtime_test_events.event_seq 已有两份可直接抄的实现；③`container_run_id`（只表达归属、不兼职调度语义）+ `scope_path`（根到本 scope 的 `wrapperId:iteration` 序列），parentNodeRunId 语义收窄为「born-running 子行」、topLevelOnly 更名 excludeBornRunningChildren，出 `containerMemberRuns()` 单一原语；拆 wrapper-loop-nested 禁令**必须**与解 depth-1 绑成同一个 AC，否则用户体验从「保存期被拒」变成「跑起来卡死」；④`node_run_repos(node_run_id, repo_index, pre_snapshot, iso_base_snapshot, iso_node_tree, iso_submodules_json)` 一次吃掉 9 个双轨列 + per-repo map 的键问题（用 repo_index 而非 worktree_dir_name），之后再 DROP tasks 的 7 个镜像列。
- **影响面**：10+ 文件 + 4 次迁移 + 存量回填；必须排在 A2/A4 之后（需要唯一写入点与统一 wrapper 外壳才能安全 backfill）。这是解开「wrapper 任意嵌套」这条产品承诺的唯一路径。

### A6｜P1｜人机门没有共同抽象：6 套 gate 只共享一个状态字符串，门态跨 2~4 张表且无 owner，park 信号无载荷，已有的原子释放原语 6 个门里只有 1 个在用

- **维度**：human-in-loop, lifecycle-state　**来源发现**：HIL-1, HIL-3, HIL-4, HIL-7, HUMAN-IN-LOOP-MISSED#1, HUMAN-IN-LOOP-MISSED#2, HUMAN-IN-LOOP-MISSED#3
- **锚点**：packages/backend/src/services/clarifySeal.ts:332; packages/backend/src/services/clarifySeal.ts:344; packages/backend/src/services/task.ts:2710; packages/backend/src/services/workgroup/taskActions.ts:360; packages/backend/src/services/terminalSweep.ts:113; packages/backend/src/services/scheduler.ts:1267; packages/backend/src/services/workgroup/engine.ts:222; packages/backend/src/services/dispatchFrontier.ts:212
- **根因**：最硬的证据是代码自己写的：clarifySeal.ts:332-352 逐字承认 loadOpenClarify 读 clarify_rounds.status 而 deriveFrontier 读 node_runs.status 是「两个 INDEPENDENT park signal」，因此 full-seal 必须在同一 tx 里用 `rfc053-allow-direct-status-write` 逃生舱手工做原子，否则「deferred round parks permanently」。同型：review 门态是 node_runs.status + doc_versions.decision 两份；看板是 task_questions 四列组合且 park 现算无持久化；workgroup 是四处。park 信号本身是无载荷裸 kind——ScopeResult 只有 kind + 自由文本 detail，任务级分支**完全不读 detail**（scheduler.ts:1625-1639 自陈），逼得 workgroup 另建 pause_reason 侧信道并承认 PUT /config 全量覆写可能吞写。wrapperRevivalEvidence 把「pending 行 or review kind 的 done 行」硬编码进 frontier（注释自陈「Restricting to review kind is load-bearing」），每加一种 gate 都要回去补形状；deriveFrontier 签名已有 12 个形参、其中 3 个是门态侧信道。而正确的原语已经写好放在那没人用：resumeTaskWithAtomicSideEffects（文档头逐字写「Gate decisions use this instead of write-gate-then-fire-and-forget」）实测只有 1 个调用方，其余五门全是被该文档点名否定的模式。关门侧同样无 owner：sealOpenHumanGatesForTask 是表盲的状态串扫描，看板一行不碰，补偿靠三处各写的读侧终态过滤。
- **重构方向**：分三步且第一步零行为变更：①落 GateKind 联合 + `satisfies Record<GateKind, HumanGate>` 的**只读三方法**（describe / releaseEvidence / authorize），把 clarify(self+cross 合一)/review/board/wg-completion/dw-confirm 五个实现包成 adapter，authorize 收口四份手写的 gateId→task join；②`human_gates` 表（gate_id / task_id / kind / carrier_node_run_id / status / opened_at / answered_at）成为门态唯一 owner，clarify_rounds / doc_versions / task_questions 退化为 payload 表，deriveFrontier 从 (node_runs, human_gates) 两个纯输入派生、参数从 12 降到 8，三处逃生舱与三处读侧终态过滤随之删除；③`releaseTaskGate(db, taskId, deps, onClaimTx)` 成为唯一门释放入口且内部固定走 resumeTaskWithAtomicSideEffects（先零风险迁 routes/taskQuestions，它的 stamp+mint 本来就在一个 dbTxSync 里）；park 升级为 `GatePark{kind, gateId, gateKind, reasonCode, subjectNodeId, releaseEvidence}`，frontier 的复活判定改成「查这个 gateId 是否已 answered」——同时消解 depth-1 盲区；`closeGatesForTask` + `satisfies Record<GateKind, GateCloser>` 让新门漏实现直接编译失败；统一 If-Match 版本契约取代四套并发协议；统一 `GET /api/gates?status=open` 取代三个 pending-count 端点与前端手工合并。
- **影响面**：约 15-18 个文件 + 1 张新表 + backfill；前端 InboxDrawer/InboxFooterButton 改单 query。它同时解掉「看板与 dw-confirm 根本不在收件箱」这个用户可见缺口。

### A7｜P1｜HTTP 应答路径已长成第二个调度器：请求线程 reset worktree、cancel 在飞、铸 node_run，taskQuestionDispatch 自带 1772 行规划引擎，并被 scheduler tick 反向调用成环

- **维度**：human-in-loop　**来源发现**：HIL-2
- **锚点**：packages/backend/src/services/scheduler.ts:1503; packages/backend/src/services/review.ts:2479; packages/backend/src/services/review.ts:2510; packages/backend/src/services/clarifyAutoDispatch.ts:719; packages/backend/src/services/taskQuestionDispatch.ts:311; packages/backend/src/services/taskQuestionDispatch.ts:1702; packages/backend/src/services/clarifyAutoDispatch.ts:823
- **根因**：submitReviewDecision 在请求线程里 `getTaskWriteSem().run(rollbackNodeRunWorktrees)` 重置工作树、`setNodeRunStatus(to:'canceled', allowedFrom:[…,'done'], allowTerminal:true)` 强杀在飞/已完成行、mintNodeRun 铸重跑、cascadeSiblingReviews 连锁改兄弟；clarify 答复同形。taskQuestionDispatch.ts(1772 行) 自带 computeUpstreamFrontier / buildFrontierMintPlan / assertNoInFlightDispatch / assertSafeFrontierTarget / assertDesignerReady 一整套可派发性门与三个私有异常做 tx 回滚。最致命的是 scheduler.ts:1503 在每个 runTask tick 顶端调 autoDispatchDeferredQuestions——调度主循环反过来调用这条 HTTP 出身的派发链。多写者税已具体化为：三处锁序注释、两张冲突白名单、attempt<2 手工重试循环。注意「mint 留在 gate 服务侧」是 design/design.md:1301 授权的设计，不算 bug；真正无授权的是**请求线程做工作树破坏性写**与**反向回环**。
- **重构方向**：①定义 `TaskCommand`（rollback + supersede + mint 三元组）由 gate answer 写入、由 scheduler tick 消费，让 rollbackNodeRunWorktrees 的唯一调用方变成 scheduler（当前 review.ts:2480 与 clarifyAutoDispatch.ts:734 两处移出请求线程）；②autoDispatchDeferredQuestions 从「调用 dispatchTaskQuestions 全链」改成「消费 auto_dispatch_deferred_at 队列的命令」——这一步单独就能砍掉两张冲突白名单与 attempt<2 重试循环，并断掉 scheduler.ts:1503 的回环；③routes 退化成纯 transport + 写 answer 行。改 mint 归属需先改 design.md，不要顺手做。
- **影响面**：8-10 个文件，其中 2 个是 1700+ 行巨石；需新表（命令队列）或复用 dispatched_at 语义 → 有迁移。与 A6 同一 RFC 家族但拆独立 PR。

### A8｜P1｜任务执行入口装配无单一事实源：resume 6 处手抄（4 处已真实漏 subagentLiveCapture），StartTaskDeps 27 字段平铺 5 种互斥启动形态，父子 round-trip 有损丢 commitPush/mergeAgent

- **维度**：cross-cutting, lifecycle-state, human-in-loop　**来源发现**：XCUT-2, XCUT-4, CROSS-CUTTING-MISSED#2, LIFE-6, HIL-6
- **锚点**：packages/backend/src/services/task.ts:196; packages/backend/src/services/startTaskDeps.ts:36; packages/backend/src/routes/clarify.ts:434; packages/backend/src/routes/reviews.ts:322; packages/backend/src/routes/taskQuestions.ts:245; packages/backend/src/services/workgroup/taskActions.ts:108; packages/backend/src/services/scheduler.ts:3575; packages/backend/src/services/task.ts:790
- **根因**：resumeTask 的 deps 在 6 处各拼一遍，漂移是**双向**的：routes/tasks.ts 传 subagentLiveCapture 但不传 appHome；clarify/reviews/taskQuestions/workgroup 四处传 `appHome: Paths.root` 却完全没有 subagentLiveCapture——即经 review 决策 / clarify 自动分派 / 反问回答 / workgroup 唤醒恢复的任务，RFC-048 子代理实时捕获永远跑编译期默认值，与走 /resume 恢复的同一任务行为不同。buildStartTaskDeps 只服务 launch、无 resume 对应物；dedup-audit-2026-06-13 已点名落点 `resumeTaskBestEffort`，7 周后 grep 零命中。同一份配置还有两种不兼容形状（StartTaskDeps 嵌套 vs RunTaskOptions 扁平），靠两个手写、互不为逆的映射器搬运：buildChildDeps 还原了 10 个字段却**完全没有还原 commitPush 与 mergeAgent**，并用 `as StartTaskDeps` 把类型缺口盖掉——一切经 call/workgroup 节点拉起的子任务，自动提交推送模型、修复重试、diff 上限、merge-agent 运行时全部退回内置默认值。StartTaskDeps 27 字段混装基础设施 / 已解析配置 / 5 种互斥启动形态 / 5 个测试缝，互斥关系只写在散文注释里，`deps.<variant>` 49 处分支集中在 621 行的 startTaskImpl；字段注释里两次自陈「配置曾对生产完全无效」（RFC-103 maxConcurrentNodes、RFC-115 defaultRuntime）。
- **重构方向**：①把第 (b) 组 9 个配置打成**不可分割**的 `ResolvedRuntimeConfig`（由 resolveLaunchRuntimeConfig 唯一产出，禁止逐字段传），StartTaskDeps 与 RunTaskOptions 都改为持有它——runtimeConfigOpts 与 buildChildDeps 的配置部分退化成一行透传，有损 round-trip 物理消失；过渡期最小动作是先删 `as StartTaskDeps` 断言让 TS 指出缺口；②三条正交轴取代 5 臂平铺：`LaunchIntent = workflow|workgroup|agent`（真互斥）× `parentLinkage?`（正交，scheduler.ts:3880 实测同时传 workgroupLaunch 与 callLaunch）× `SpaceHandoff = none|materialized|preCreated|internal`，49 处 if 收敛成一次 switch；③`services/taskResume.ts` 导出唯一 resumeTaskBestEffort，内部统一调 buildStartTaskDeps 并内置 `task-not-resumable` 吞咽，6 个 call-site + kickScheduler 三入口全部替换（顺带补齐 retryNode 的 awaitScheduler）；④源码守卫：routes/ 下不得手工拼装 StartTaskDeps 对象字面量、resolveOpencodeCmd 只允许在 buildStartTaskDeps 内出现。
- **影响面**：约 12-15 个文件；改动会让 4 条门释放路径的运行时行为发生变化（subagentLiveCapture 从缺失变为生效）与子任务恢复 commitPush/mergeAgent 配置——需 RFC 且在 plan 里写明这是修复而非回归。

### A9｜P1｜平台级边界机制寄居在 opencode 驱动子树，被组合根与兄弟驱动反向依赖；四个受围子命令还共用 daemon 的静态 import 图

- **维度**：runner-runtime　**来源发现**：RUN-7, RUNNER-RUNTIME-MISSED#3
- **锚点**：packages/backend/src/services/runtime/opencode/sealedSubprocess.ts:1; packages/backend/src/services/containmentComposition.ts:8; packages/backend/src/services/runtime/claudeCode/netlessMcp.ts:46; packages/backend/src/services/runtime/netlessProjection.ts:1; packages/backend/src/main.ts:12; packages/backend/src/services/runtime/opencode/failure.ts:1; docs/audit-backlog.md:41
- **根因**：sealedSubprocess.ts(1225 行) 内含四类无关职责（netless manifest schema + provider 注册表 / 环境变量净化名单 / root-owned bwrap 资格化与能力监督 / bwrap·seatbelt 渲染），而反向依赖它的是**平台 containment 组合根** containmentComposition.ts:8（自称「The one production composition root」却 import 某个 driver 子树，分层是倒的）与**兄弟驱动** claudeCode/netlessMcp.ts:46。同型：opencode/failure.ts 被 8 个非 opencode 模块引用，事实上已是平台级 execution-identity 失败词汇表。这个成因在本仓**已经造成过真实的容器逃逸**：netlessProjection.ts:1-23 文件头逐字记录 RFC-242 结论——路径投影在 claudeCode/netlessMcp.ts 里存在第二份丢了三项检查的副本，攻击者可在工作树内造 `.git` 指针把写权限授予被围子进程。同一成因在 sealedSubprocess 上完全没消除。另一面：main.ts:12-31 用静态 import 把整个 daemon 与四个隐藏运行时子命令挂在同一模块图上，每 fork 一次受围子进程都付一次 daemon 启动成本——audit-backlog 有实测且标注未修：dev 首答≈210ms（裸 bun≈10ms）、生产冷态首次≈646ms，而 claude 在 init 事件冻结 MCP 可用性 → 升级/首次部署后第一个受控 MCP 节点实测 pending。
- **重构方向**：①先搬 opencode/failure.ts → services/execution/failure.ts（10 个 import 点、纯类型 + 2 个 parse、零环风险，单 PR），opencode 目录只留 marker 前缀常量；②拆 sealedSubprocess.ts 到 `services/sandbox/netless/{manifest,render,env,bwrapQualify}.ts`，verifiedSelfCommand 归 `services/selfExec.ts`，containmentComposition 与两个驱动都从 services/sandbox/\* 取，方向变成「驱动依赖平台」；③把 rfc233-containment-source-guard 的字面量断言升级成「containmentComposition.ts 不得出现 `runtime/opencode`」的结构守卫；④main.ts 的 switch 改惰性分发（全部 `await import()`），顶层只留 argv 解析与 util/version，加白名单守卫 + 冷态首答 gated 基准。仓内已有同方向的两次成功迁移（RFC-237 binarySnapshot、RFC-242 netlessProjection），这是剩下没搬的两块。
- **影响面**：约 10-12 个文件移动 + import 重写，逻辑零改动；因触及安全边界建议跑 Codex 实现门并保留全部 containment/netless 回归原样绿作为等价性证明。与 scheduler 侧工作文件面几乎不重叠，可并行。

### A10｜P1｜「把一个计划变成一个真实子进程」被 fork 4~5 份且 kill 降级/行分帧已互不相同；生产信任位靠 WeakSet 对象身份，argv head 三个解析器优先级互相倒挂

- **维度**：runner-runtime　**来源发现**：RUN-3, RUN-5, RUN-2, RUN-4, RUN-6, RUN-8, RUNNER-RUNTIME-MISSED#2
- **锚点**：packages/backend/src/services/runner.ts:2683; packages/backend/src/services/systemAgentRun.ts:169; packages/backend/src/services/runtimeSmoke.ts:100; packages/backend/src/services/memoryDistiller.ts:987; packages/backend/src/util/opencode.ts:17; packages/backend/src/services/runtime/opencode/driver.ts:106; packages/backend/src/services/runtime/head.ts:15; packages/backend/src/services/runner.ts:546
- **根因**：四份进程组 kill 语义已实际漂移：runner killTree 在 `process.kill(-pid)` 抛异常时回落 safeKill，systemAgentRun/runtimeSmoke 的 killGroup（逐字节相同）catch 里什么都不做（EPERM 直接放弃）且用数字信号 9/15，memoryDistiller 用字符串——「pid 存在但 kill 返回 EPERM」这种真实场景下三处静默留下孤儿进程（S-15 的教训只修了 runner 一份）。grace 常量 10s/5s vs 2s/2s vs 2s/2s；行分帧也分叉三份（字符上限+截断 marker / 字节上限+整行丢弃+剥 \r / 完全不分帧）；另有第五条带 PID 复用窗口 + 二进制身份门的 killStaleRunProcessTree，是唯一有那层保护的。这条债**登记在案**：RFC-234 plan.md:30 写着「遗留：distiller/smoke 改薄适配层未做」而 STATE.md 已把 RFC-234 标完成。信任位方面：`PRODUCTION_OPENCODE_COMMANDS = new WeakSet<string[]>()` 用堆对象身份决定走 RFC-224 verified 路径还是 legacy 未验证 spawn，76 处 opencodeCmd 传递里任何一次 `[...x]`/`.slice()` 都会静默降级——现场近失事故：opencode/driver.ts:106 在同一函数里做了 `[...ctx.opencodeCmd]`，12 行后 :118 的品牌判定读的是未拷贝的原对象，把 :118 改成读 head 就静默退回 legacy，零编译错误。argv head 三个解析器优先级倒挂（binaryPath 优先 / runtimeBinary 优先 / opencodeCmd 优先），今天靠调用方每次传相同值压住。此外 opencode session 所有权状态机整个住在通用 runner.ts 里（109 行 marker/lease/ack 状态机 + SpawnPlan.control 两个 `opencode-*` 变体），而 RFC-224 design.md:657 声称它是 runtime-neutral。
- **重构方向**：①从 systemAgentRun.ts:440-900 **原地抽出**进程监督核心成 `services/childProcess/supervisor.ts`（它已是行为锁定的成熟实现，rfc234 的 7 例在保护它），让 runSystemAgent 成为第一个消费者，再迁 smoke/distiller，runner 最后；grace/margin 作为**必填**参数保留差异但集中可见；把 killStaleRunProcessTree 的 PID 复用 + 二进制身份门并进策略；行分帧统一收进 supervisor；②`executionTrust: 'production' | 'test-injected'` **必填**字段取代 WeakSet，由组合根唯一设置，fail-open 变 fail-closed；`resolveLaunchHead` 单一函数取代三个解析器，删掉按 runtime 命名的 opencodeCmd 别名（RFC-143 T17 早已定下 testBinaryOverride 命名，从未落地）；③`RuntimeDriver.sessionOwnership?: RuntimeSessionOwnershipV1` 可选能力对象（仓内已有 5 个同范式能力方法），把 processRunnerOpencodeControlLine + requiresVerifiedOpencodeBarrier + 屏障准备整体 git mv 到 runtime/opencode/runnerSessionOwnership.ts，DB 写仍在父进程；SpawnPlan.control 判别式改 `session-owner-v1 + ownerKind`；④`ExecutionEnvironment` 必填依赖取代 28 处 `containmentCoordinator === undefined` 可选展开，漏传变编译错误；`resolveContainmentDemand` 单一 demand 解析（audit-backlog:38 已登记）；⑤RuntimeBinaryConfig 改 `binaryPaths: Partial<Record<RuntimeKind,string>>`，`RuntimeDriver.executionCapabilities` 必填三布尔取代 `protocol !== 'opencode' return []`；⑥verifiedPlanCore 升级为模板方法独占整条 8 步有序流水线，三个变体只提供描述符。
- **影响面**：约 25-35 个文件；无 DB 迁移，但 AppDeps 由可选转必填会波及全部 route 测试的 deps 构造。建议拆 5-6 个 PR，与 A9 同一条并行线。

### A11｜P1｜权威关系被存成 JSON blob，读模型没有查询层：11 个文件各自 JSON.parse(workflow_snapshot) 重建索引，列表端点整表 select 后 JS join，一个反问问题没有归属

- **维度**：data-model, human-in-loop　**来源发现**：DM-4, DATA-MODEL-MISSED#2, DM-5, DM-6
- **锚点**：packages/backend/src/services/review.ts:1251; packages/backend/src/services/clarifyRounds.ts:138; packages/backend/src/services/memoryDistillScheduler.ts:146; packages/backend/src/db/schema.ts:1815; packages/backend/src/db/schema.ts:2495; packages/backend/src/services/clarifySeal.ts:251; packages/backend/src/services/clarifySeal.ts:133; packages/backend/src/db/schema.ts:1856
- **根因**：「工作流有哪些节点、什么 kind、绑哪个 agent」只以 blob 存在，于是 11 个文件各自在应用层重建索引。listReviewSummaries（/api/reviews 与 pending 徽章都走它）连做三次**无 WHERE 全表扫**再用 `.filter(r => nodeRunIds.includes(r.id))` 做 O(n·m) JS join，并对每个 task 反序列化整张工作流图只为拿节点标题；clarifyRounds 把整张表拉回内存再过滤，而 idx_clarify_rounds_task / idx_clarify_rounds_kind_status 就在那没被用。「drizzle 做不了 join」的借口已被证伪——仓内有 12 个 innerJoin/leftJoin 用法，其中 4 处就 join 的 nodeRuns。更承重的是「一个反问问题」没有归属：文本/答案/草稿/归属在 clarify_rounds 的 4 个 JSON blob 里，路由与生命周期在 task_questions 行里，靠 DB 无从校验的逻辑键 (origin_node_run_id, question_id) 相连，且 source_kind='manual' 往该列塞指向不存在 node_run 的合成 ULID，还冗余快照标题。代价已显形：封存一个子集的答案必须整轮读改写（mergeSealedAnswers），clarifySeal.ts:133-142 逐字记录了由此产生的丢失更新窗口及其绕法——**再加一把 per-task 写锁 B**，锁又带来锁序约束。同族还沉了死列 question_scopes_json（从不读写）。写入侧也不对称：node_runs 有唯一 mint 工厂 + grep 守卫，node_run_outputs 有 13 处裸 insert，「kind + archive_json 必须与 content 同源」只靠注释且已有写点漏写（options-R1 的 approved_doc），而 archive_json 为 NULL 会让读方回退已被 GC 的 worktree。
- **重构方向**：①`task_nodes(task_id, node_id, kind, title, description, agent_id)` 投影表，在 startTask / syncTaskWorkflow 写 workflow_snapshot 的**同一事务**写入；落地后 parseReviewNodeMeta / loadNodeTitlesByTask / extractAgentIdsFromSnapshot 整体删除而非留作 fallback；三处全表扫改 innerJoin + inArray + limit 下推；②`clarify_questions(round_id, question_id, seq, title, body)` + `clarify_answers(round_id, question_id, answer_text, draft_text, submitted_by, sealed_at)` 走真 FK，四个 blob 列 backfill 后 DROP、question_scopes_json 直接 DROP；sealRoundQuestions 改逐题 UPDATE，整轮读改写与 mergeSealedAnswers 一并删除——丢失更新窗口在数据模型层就不存在，锁 B 作用域可显著收窄；task_questions.question_title 冗余快照删除改 join；③`services/portOutput.ts` 唯一 writePortOutputs（kind 必须显式传参、不给默认值）收掉 13 处裸 insert + 一条 grep 守卫，顺带合并 3 份逐字节相同的 runIdsWithOutput；④wrapper_progress_json 的 CallLedger 改真列 call_human_wait_ms/since，hasLiveWrapperState 从「列非空」改成 kind 判据（当前一个 canceled 的 call 行会被永久判为 live wrapper）。
- **影响面**：3 张新表/列组 + backfill + 约 15 个文件；task_nodes 是只读投影（可随时重建）、clarify_questions 是权威数据搬家（需 backfill 校验 + 明确的双读退出计划），两者必须拆开 PR。排在 A5 之后。

### A12｜P1｜生命周期治理不对称：状态真值收口极好，但通知/自愈/中断原因/委派全无 owner——转移表只覆盖 1/32 写点，WS 帧靠调用点自觉，自愈判据寄生在人读文本列

- **维度**：lifecycle-state, scheduler-core　**来源发现**：LIFE-1, LIFE-2, LIFE-3, LIFE-5, LIFE-7, LIFE-8, SCHED-6, LIFECYCLE-STATE-MISSED#2
- **锚点**：packages/backend/src/services/lifecycle.ts:334; packages/backend/src/services/lifecycle.ts:21; packages/shared/src/lifecycle.ts:296; packages/backend/src/services/autoResume.ts:66; packages/backend/src/db/schema.ts:963; packages/backend/src/cli/start.ts:757; packages/backend/src/services/gc.ts:383; packages/backend/src/services/driverLease.ts:49
- **根因**：写口收得很好，写口之外全散：①转移表建了却不具权威——实测 32 个 setTaskStatus/trySetTaskStatus 写点里只有 **1** 个走 transitionTaskStatusByEvent，30 处手抄 allowedFrom 已写出表明确禁止的边（awaiting\_\*→interrupted、done→interrupted），而 backend/lifecycle.ts:326-330 的 doc 声称五个 allowTerminal 持有者「all via the event path」——文档在说谎；②节点状态写与 WS 广播是两步手工约定（broadcastNodeStatus 57 次调用 + 10 处手拼 `type:'node.status'` 帧散在 8 个模块），而**任务级** setTaskStatus 内部已内建 post-commit 通知，证明约束可在内部满足；同时任务级最该无条件发生的 WS 帧覆盖率只有 14/30，orphans/orphanReconcile/shutdown/limits/fusion/全部 repair option 的状态翻转都不发帧；③setTaskStatus 从状态机原语长成 177 行通知 hub（内联 existsSync 文件系统 IO + tombstone UPDATE + 运行时长会计 + 三套异构通知），「想在任务状态变化时挂一件事」现在有四种做法，选哪种取决于当时撞上的是不是 module cycle；④中断/失败原因没有结构化列，autoResume 用 `eq(tasks.errorSummary,'daemon-restart')` 精确匹配决定能否自愈而写入侧是 12+ 种自由文本——RFC-145 已为 node_runs 修过同一问题并立了空 allowlist 守卫，但该守卫扫不到 drizzle 的 `eq()`（SQL 层）与 `outcome.error?.message ===`（别名层）；⑤RFC-243 把生命周期变成递归后，「这个任务是不是被另一条 call 行驱动」有四份互不相识的实现、两个后台执行者（autoResume/limits）完全没有这个概念；⑥cli/start.ts 逐行手挂 16 个 ticker + 逐行 stop，另有 2 个只 unref 不 stop；⑦26 个 repair preflight 里 3 个会写任务状态/触发 resume 的漏调 schedulerLivenessGate，而引擎层已有统一施加点。
- **重构方向**：①`TaskStatusObserver` 多播注册表（叶子模块，订阅者只收 {taskId, from, to} 三元组），terminalTaskHook / childBudget / emitTaskStatus 全改订阅者，WS 覆盖由构造保证；节点侧同法建 `services/nodeStatusNotify.ts`，两个 helper 新增显式 `notify:{taskId,nodeId}` 入参（内部广播默认 off，编译器逼齐 57 处），源码断言锁 `type:'node.status'` 字面量；②转移表补全成真实边集（补 revive-park / repair-terminalize 等事件），allowedFrom 参数收进模块内部、外部只能传 event，加 property test 枚举 from×event，并先把那句失真的 doc 改成事实；③`tasks.interrupt_cause` + `terminal_cause` 结构化列（枚举放 shared + satisfies 守卫），autoResume 改 inArray，rfc145 守卫扩到 SQL 层与别名层且 allowlist 保持为空；④`services/taskDelegation.ts` 出 delegationOf / childrenOf / delegationLiveness 三个谓词作为唯一事实源，gc / stuckTaskDetector / scheduler 内联判定 / autoResume / limits 全改调它 + 源码棘轮；⑤services/recovery.ts 的 RecoveryEventKind 升格为 actor 注册表，cli/start.ts 改遍历挂载，`withTaskOwnership` 合并 isTaskActive + driverLease + breaker + quarantine + audit 五道 in-process 门（gc 的持久 claim 保留为独立的『持久 claim』建模，autoKill 显式声明 skipDriverGate）；⑥RepairOptionDef 加 `mutatesTaskState` 声明式字段，引擎在 preflight **之前**统一施加 liveness 门；⑦BackgroundTaskHost 统一注册/停机。
- **影响面**：约 25-30 个文件 + 2 次迁移；依赖 A3 的 taskDriver 解环（否则 observer 会造新环）。这层不修，A5/A6 的迁移完成后仍然缺一个能回答「此刻谁有权改这个任务」的单点。

---

## ④ 重构路线图

### WP-0 门禁复明（一行配置换真值）

- **覆盖**：A1, XCUT-1, LIFECYCLE-STATE-MISSED#1
- **依赖**：无——必须第一个做
- **需要 RFC**：否　**PR 估计**：1-2 个 PR
- **先落的 oracle 测试**：本 WP 本身就是在造 oracle，不需要前置 fortify。顺序：①把 depcheck 拆成三条 per-package depcruise 并把真实违规集打印存档；②新增元测试断言 depcruise JSON 的 `couldNotResolve` 边数为 0（棘轮，只降不升）——这是核心交付，它让「门看得见图」本身变成被锁住的事实；③rfc217-architecture-locks 补第 4 条断言；④16 条违规写进 pathNot 白名单 + 断言「白名单条目数只许缩」，每条注明拆环归属（task↔scheduler 与 executor→…→scheduler 归 WP-5；util/git↔services/git\* 标注为 RFC-034 有注释的 lazy import、无 RFC-079 初始化风险，与真环分开排序）。
- **理由**：投入最小、杠杆最大：一行配置把后续每个 WP 的回归从「靠人肉 review」变成「CI 拦住」。不先做，WP-2/3/5 每次拆分引入的新环都不会被发现，重构本身会成为新债来源。

### WP-1 纯核归位 + 测试缝退出生产面（fortify 前置）

- **覆盖**：A3 的可测面部分, SCHED-5, SCHEDULER-CORE-MISSED#2
- **依赖**：WP-0
- **需要 RFC**：否　**PR 估计**：2 个 PR
- **先落的 oracle 测试**：搬迁前先给 deriveFrontier 家族补一层 property test（当前只有表驱动用例），作为纯位移的等价性 oracle；搬迁后加源码断言：scheduler.ts 的 export 只允许出现在 runTask / RunTaskOptions / buildWorkgroupHooks 三个名字上（其余视为测试 seam 泄漏，新增即红）。
- **理由**：全清单里最便宜的一刀（一次剪切粘贴 + 一次 sed），却直接降低后面所有搬迁的成本：把 96 个测试文件对 god module 公共面的钉死解开，scheduler.ts 在 src/ 里变成零 importer 叶子。RC-5 不先松绑，WP-2/WP-3 的每一步都要先打红一堆测试。

### WP-2 「一次 agent 执行」的下层原语（承重刀）

- **覆盖**：A2, RUN-1, SCHED-2, SCHEDULER-CORE-MISSED#1, CROSS-CUTTING-MISSED#1, RUNNER-RUNTIME-MISSED#1
- **依赖**：WP-0、WP-1
- **需要 RFC**：是　**PR 估计**：5-6 个 PR（interpret → projectIsoRepos → withNodeRetryBudget → agentAttempt → LaunchablePlan）
- **先落的 oracle 测试**：严格 fortify-then-refactor，四条红测先行：①给 envelope/clarify/port 解析补齐纯函数单测（抽出前先用现有 runNode 行为做 golden 对照）；②写一条「嵌套 wrapper 下只读成员不得进入 innerState / diffableRepos」的红测锁 scheduler.ts:7879 的活缺陷；③写一条「六个 runNode 站点的 12 个公共键必须来自同一构造器」的源码断言；④把 rfc233 那条数 `await runNode({` 次数的正则守卫替换成类型级约束（构造器落地后该测试可直接删）。
- **理由**：整份清单的内核，也是 A3/A4 的前置：不先有「一次 agent 尝试」这个可复用单元，wrapper 外壳合并只是在搬运重复代码。第一刀 interpret.ts 零 IO、不触 lease 时序，风险最低收益最大，建议独立 PR 先落。落地后 fanout 分片要 clarify 从「再复制 500 行」变成「传一个参数」。

### WP-3 wrapper 生命周期模板方法

- **覆盖**：A4, SCHED-3, WRAP-1, WRAP-4, WRAP-5, WRAP-6, WRAP-7, HIL-8, SCHED-4, WRAPPER-MODEL-MISSED#2
- **依赖**：WP-2（projectIsoSchedulerRepos / runAgentAttempt 是它的内核）
- **需要 RFC**：是　**PR 估计**：3-4 个 PR
- **先落的 oracle 测试**：①先写多仓 git wrapper「park → resume 后非挂根仓 baseline 不退化」的红测（当前 :7975 漏写 baselines/preDirtyByRepo，会红）；②先合 shard/aggregator 那两个逐字同构的 19 行重试壳并加计数断言，作为后续合并的安全网；③按 RFC-188 范式准备 golden dump 对照，要求 rfc060 fanout 全套锁与 rfc130 shard-rerun 等价性回归零改动跑绿；④rfc188 allowlist 的 `mergeBackNodeIso(` 期望从 1 改 0 时，同批核对 `markMergeFailed(` 的计数断言；⑤rfc144 的源码文本切片断言改成对 reenterWrapperIsolationGeneration 的直接行为断言（并发两调用者、败者必须在任何 discard 之前抛），拆掉对函数物理位置的依赖。
- **理由**：wrapper 是「每加一条横切语义就要人肉巡检 N 处」的主要产地，且已有活漂移（git readonly、git park 丢多仓 baseline、merge-back 没接 RFC-210 钩子）。能力位加进已存在的 NODE_KIND_BEHAVIORS 而非新建第二张 kind 表；call-workflow 明确不并入。

### WP-4 执行入口单一装配（launch / resume / child 三条臂）

- **覆盖**：A8, XCUT-2, XCUT-4, CROSS-CUTTING-MISSED#2, LIFE-6, HIL-6
- **依赖**：WP-0（可与 WP-2 并行）
- **需要 RFC**：是　**PR 估计**：3 个 PR（ResolvedRuntimeConfig 打包 → resumeTaskBestEffort 收口 → LaunchIntent 三轴分解）
- **先落的 oracle 测试**：①先补一条表驱动测试：三条 kick 入口 + 四条门释放路径 + buildChildDeps 的 deps→RunTaskOptions 映射必须逐字段一致——这条现在就会红（subagentLiveCapture 缺 4 处、commitPush/mergeAgent 缺 1 处），是本 WP 的红测；②删掉 buildChildDeps 的 `as StartTaskDeps` 断言，让 TS 直接指出缺口（最小结构守卫）；③源码守卫：routes/ 下不得手工拼装 StartTaskDeps 对象字面量、resolveOpencodeCmd 只允许在 buildStartTaskDeps 内出现。
- **理由**：这是「同一任务因为谁触发恢复而运行时配置不同」的唯一修法，且是 WP-7 的前置（releaseTaskGate 建在 buildStartTaskDeps 之上）。第一步 ResolvedRuntimeConfig 打包同时物理消灭父子 round-trip 的有损点——RFC-103/115 两次「配置从未 forward」事故的第三次复发正发生在这里。

### WP-5 断 task↔scheduler 环并拆两个 god module

- **覆盖**：A3, XCUT-3, LIFE-4, SCHED-8
- **依赖**：WP-0（门禁必须先真）、WP-2（节点级机制搬走后 scheduler 才瘦得下来）、WP-4
- **需要 RFC**：是　**PR 估计**：3-4 个 PR（taskDriver 解环 → workspace/materialize → taskReadModel → 剩余 export 归位）
- **先落的 oracle 测试**：把 WP-0 白名单里 task↔scheduler 与 executor→…→scheduler 两条标为「本 WP 必须删除」，每刀之后跑 depcheck 断言该条消失（门禁本身就是本 WP 的 oracle）；纯搬运部分以既有全套件零改动跑绿为等价性证明；把 workgroup 旁路收进 facade 后 CALL_FACES 补上 scheduler.ts 并断言 `startWorkgroupTaskFromFrozen(` 不再出现在 scheduler.ts。
- **理由**：顺序上先切 taskDriver.ts（activeTasks + emitTaskStatus + kickScheduler）解环，之后 scheduler 不再 import task.ts，后两刀的 import 面改动会小很多，5 处 `await import` 随之可删。这一刀也是 WP-10 的前置——TaskStatusObserver 要接 emitTaskStatus 必须先有 taskDriver 做投影，否则立刻造新环。

### WP-6 运行时层归位与子进程原语统一（可与主线并行的独立线）

- **覆盖**：A9, A10, RUN-2, RUN-3, RUN-4, RUN-5, RUN-6, RUN-7, RUN-8, RUNNER-RUNTIME-MISSED#2, RUNNER-RUNTIME-MISSED#3
- **依赖**：WP-0
- **需要 RFC**：是　**PR 估计**：5-6 个 PR
- **先落的 oracle 测试**：①先搬 opencode/failure.ts（纯类型 + 2 个 parse、零环风险）作为最小可验证的第一刀；②supervisor 从 systemAgentRun.ts:440-900 原地抽，让 runSystemAgent 成为第一个消费者——rfc234-system-agent-run 的 7 例就是现成的行为锁；③迁 smoke/distiller 前先写「同一段 stdout 在三条路径下必须切成相同的行」的红测（当前字符/字节/不分帧三种口径会红）；④加源码守卫：services/ 下 `Bun.spawn(` 只允许出现在 executePlan.ts 与非 agent spawn 白名单（gitRepoCache / probe / indexers）；⑤加 `containmentComposition.ts` 不得出现 `runtime/opencode` 的分层断言；⑥executionTrust 必填化后加断言「测试代码无法在生产二进制里把它置为 test-injected」；⑦全部 containment/netless/verified 回归原样绿作为等价性证明，并按 docs/dev-gotchas.md 跑一次 Codex 实现门（触及安全边界）。
- **理由**：文件面与主线几乎不重叠（runtime/ + sandbox/ + main.ts vs scheduler.ts + task.ts），可由另一个 session 并行推进，缩短总工期。内部排序：failure.ts 搬迁（零风险）→ supervisor 抽取 → executionTrust 必填化（fail-open 变 fail-closed）→ sealedSubprocess 拆分 → main.ts 惰性分发（顺带修好用户可见的冷启动 MCP pending）→ verifiedPlanCore 模板方法。RUN-7 有本仓唯一一次真实容器逃逸的历史背书（RFC-242）。

### WP-7 人机门统一（HumanGate 接口 → human_gates 表 → 原子释放 → 命令队列）

- **覆盖**：A6, A7, HIL-1, HIL-2, HIL-3, HIL-4, HIL-7, HUMAN-IN-LOOP-MISSED#1, HUMAN-IN-LOOP-MISSED#2, HUMAN-IN-LOOP-MISSED#3
- **依赖**：WP-4（releaseTaskGate 建在 buildStartTaskDeps 之上）、WP-5（scheduler tick 要能消费命令队列而不成环）
- **需要 RFC**：是　**PR 估计**：5-6 个 PR（只读三方法 adapter → human_gates 表 + backfill → releaseTaskGate 原子化 → GatePark 载荷化 + frontier 改查 gateId → 命令队列断回环 → 统一 /api/gates 读模型）
- **先落的 oracle 测试**：三条红测先行：①「六种门在任务进入终态后都必须被关闭」的跨门表驱动测试（当前看板一行不扫，会红）；②「任一门的答案提交失败后所有行不变」的原子性测试（当前 5/6 会红，只有 dw 门通过）；③「上游 rerun 后各类门的复活行为」并列断言（当前只有各自分散用例，且 dw-confirm / 看板下发放进 wrapper 能否唤醒外层没有任何保证）。human_gates 的 backfill 用新旧口径互 oracle；`satisfies Record<GateKind, HumanGate>` 与 `Record<GateKind, GateCloser>` 提供编译期穷举，新门漏实现直接红。
- **理由**：第一步（只读 describe/releaseEvidence/authorize + adapter 包装）零行为变更，可先落并以现有全套件为等价锚。落地后同时解掉三个用户可见缺口：看板与 dw-confirm 不在收件箱、depth-1 嵌套下深层 approve 唤不醒外层 wrapper、门释放失败留下「答案已存但任务永久 park」的半态。scheduler.ts:1503 的反向回环可以在命令队列那一步单独断掉，不必等整个 WP。

### WP-8 node_runs 身份轴建模（row_kind / seq / container_run_id + scope_path / node_run_repos）

- **覆盖**：A5, DM-1, DM-2, DM-3, DM-8, WRAP-3, WRAPPER-MODEL-MISSED#1
- **依赖**：WP-2（projectIsoRepos 收口）、WP-3（wrapper 外壳统一后 scope_path 才有唯一写入点）、WP-5
- **需要 RFC**：是　**PR 估计**：6-8 个 PR（每根轴一次迁移 + 一次消费点收口）
- **先落的 oracle 测试**：每批迁移都用新旧口径互 oracle（复用 RFC-189 migration 0095 的 golden 互证范式）：①row_kind backfill 后断言「按现有判据分类 === 按 row_kind 分类」对全部存量行成立；②seq 落地后**双读一轮**（seq 缺失回退 id）并断言历史数据的 id 序与 seq 序无 mismatch，确认后再删 id 比较——这是全清单里唯一可接受双读的地方，因为它要证明的正是历史前提；③拆 wrapper-loop-nested 禁令前必须先解 wrapperRevivalEvidence 的 depth-1，两者绑成同一个 AC（否则用户体验从「保存期被拒」变成「跑起来卡死」）；④container_run_id 落地后加源码棘轮：`parentNodeRunId !== null` 的裸比较只允许出现在 nodeRunMint.ts 与 freshness.ts；⑤node_run_repos 用 repo_index 做第二主键列（不要用 worktree_dir_name，否则新表继承旧包裹）。
- **理由**：必须排在代码侧收口之后——backfill 的安全性依赖唯一写入点。这是解开「wrapper 任意嵌套」这条产品承诺的唯一路径，也是让「这一行是什么 / 属于谁 / 是第几次」从全表扫 + JS 过滤变成可查询、可索引、可穷举的唯一路径。仓内已有两份可直接抄的 per-owner 序号实现（intent_turns.seq、mcp_runtime_test_events.event_seq）。

### WP-9 读模型投影层（task_nodes / clarify_questions / 查询下推 / 端口写入收口）

- **覆盖**：A11, DM-4, DM-5, DM-6, DATA-MODEL-MISSED#2
- **依赖**：WP-8（row_kind 落地后热路径列集才稳定）、WP-7（clarify_questions 与 human_gates 是同一批领域搬家）
- **需要 RFC**：是　**PR 估计**：4-5 个 PR
- **先落的 oracle 测试**：①task_nodes 与 workflow_snapshot 的一致性 oracle：一条 property test 断言「从投影表重建的节点集 === 从 snapshot parse 的结果」，并断言写入挂在同一事务（sync 路径也要覆盖）；②clarify_questions/clarify_answers 是**权威数据搬家**，backfill 校验 + 明确的双读退出时点必须写进 RFC 的 AC；③portOutput 收口时 kind 参数**不给默认值**，让每个调用点被编译器逼着显式选择，再配 grep 守卫（逃生舱注释制）；④落地后断言 parseReviewNodeMeta / loadNodeTitlesByTask / extractAgentIdsFromSnapshot 三个函数已被删除而非留作 fallback。
- **理由**：task_nodes 是只读投影（可随时重建，风险低、收益立现：消掉 11 处 JSON.parse 与三次无 WHERE 全表扫）；clarify_questions 是权威搬家，两者必须拆开 PR。后者的额外收益是把 clarifySeal 那条自陈的丢失更新窗口在数据模型层消灭，per-task 写锁 B 的作用域可以显著收窄甚至取消，连带砍掉一条锁序约束。

### WP-10 生命周期治理补齐（通知多播 / 转移表补全 / interrupt_cause / 委派谓词 / 自愈注册表）

- **覆盖**：A12, LIFE-1, LIFE-2, LIFE-3, LIFE-5, LIFE-7, LIFE-8, SCHED-6, LIFECYCLE-STATE-MISSED#2, XCUT-5
- **依赖**：WP-5（taskDriver 解环后 observer 才能不成新环）
- **需要 RFC**：是　**PR 估计**：4-5 个 PR
- **先落的 oracle 测试**：①先补「每一个任务状态写点都必须产生一帧 task.status」的覆盖测试（当前 14/30，会红）；②property test 枚举 from × event 断言与转移表一致，并把 30 处手抄 allowedFrom 反推出的缺失事件补进表，源码守卫禁止 `allowedFrom:` 字面量出现在 lifecycle.ts 之外；③把 rfc145-error-message-machine-read-guard 的正则扩到三种形态（drizzle `eq(tasks.errorSummary,…)` 的 SQL 层、`===` 字面量比较、`outcome.error?.summary/message` 别名层），allowlist 保持为空——扩完当前就会红，正是本 WP 的红测；④`nodeRuns.childTaskId` / `tasks.parentTaskId` 的裸读加源码棘轮，只允许出现在 taskDelegation.ts；⑤BackgroundTaskHost 加「BACKGROUND_TASKS 长度 === shutdown 实际 stop 数」的结构不变量。
- **理由**：排在最后不是因为不重要，而是它的多数收口（observer / delegation 谓词 / actor 注册表）都需要先有 taskDriver 这个不成环的落点。注意保留两处刻意设计：gc 的 workspace_pruning_at 是跨进程持久 claim（已在 setTaskStatus 复活门单点汇合），autoKill 按设计就要杀活任务的僵死子进程（显式声明 skipDriverGate）。

### 推荐顺序

硬约束优先：**WP-0 必须第一个做**——不修门禁，后续每一次拆分的回归对 CI 都不可见，重构本身会成为新债来源。此后分两条可并行的线。

**主线（调度 / 执行 / 数据）**：WP-0 → WP-1（纯核归位 + 松开测试对 god module 的钉死）→ WP-2（一次 agent 执行的下层原语，**整份清单的内核**）→ WP-4（入口装配收口，可与 WP-2 并行）→ WP-3（wrapper 模板方法，以 WP-2 为内核）→ WP-5（断 task↔scheduler 环并拆 god module）→ WP-7（人机门统一）→ WP-8（node_runs 身份轴建模）→ WP-9（读模型投影层）→ WP-10（生命周期治理补齐）。

**并行线（运行时 / 容器）**：WP-0 → WP-6。它与主线的文件面几乎不重叠（`runtime/` + `sandbox/` + `main.ts` vs `scheduler.ts` + `task.ts`），可由另一个 session 同时推进，只在 WP-2 第 ④ 步（LaunchablePlan）与主线交汇——两边要约定该契约由 WP-6 定义、WP-2 消费。

**关键依赖链（不可颠倒）**：WP-2 → WP-3（没有 runAgentAttempt，wrapper 外壳合并只是搬运重复代码）；WP-2 + WP-5 → WP-8（数据迁移的 backfill 安全性依赖唯一写入点）；WP-5 → WP-10（TaskStatusObserver 要接 emitTaskStatus 必须先有 taskDriver 做投影，否则立刻造新环）；WP-4 → WP-7（releaseTaskGate 建在 buildStartTaskDeps 之上）；WP-8 → WP-9（row_kind 落地后热路径列集才稳定，否则要改两遍）。

**若只能做三件事**：WP-0（一行配置换回全仓分层的机器保底）、WP-2 的第 ①③ 步（interpret.ts 纯函数 + runAgentAttempt，把「加一种执行语义」的成本从 9021 行文件里的考古降为传一个参数）、WP-4 的第 ① 步（ResolvedRuntimeConfig 打包，物理消灭父子配置 round-trip 的有损点）。这三件约 8-10 个 PR，覆盖 RC-1 / RC-2 的主要出血点。

**流程约束**：本仓 trunk-only + 多 agent 并发，每个 PR 前跑全套门禁（typecheck / lint --max-warnings 0 / test / format:check），推完按 exact SHA 查 CI；WP-6 因触及安全边界须额外跑 Codex 实现门；WP-3 / WP-8 的 diff 面大，动手前与并发 session 协调窗口，避免与在途 RFC 撞同一批文件。

---

## ⑤ 「不是问题」——被复核推翻或确认为有意设计

> 这一节和问题清单同等重要：重构时**不要**动这些，它们是全仓资产。

### RuntimeDriver 能力抽象与 runtime/opencode 的内部分层——方向是对的，别推倒重来

`RuntimeDriver` + `DRIVERS` 注册表 + `SpawnPlan` 契约已把 `driver.kind === 'xxx'` 分支基本清出方法派发层（driver 外只剩 8 处 `=== 'opencode'`），`readInventory?` / `startLiveCapture?` / `captureSessionsToSink?` / `mcpTest?` / `parseTerminalResultError?` 是规范的 null-object 可选能力用法，`runtime/opencode/` 29 个文件内部依赖图无环、分层清晰（leaf schema → mechanics → plan → launcher）。A10 说的不是「这个抽象错了」，而是「它没被用到最后一处」——session-ownership 是唯一没走这个既定范式的 runtime 专属能力。重构方向是补上第六个可选能力对象，不是重新设计 driver 层。

### 不要新建 WRAPPER_CAPABILITIES 之类的第二张 kind 表

`packages/shared/src/node-kind-behavior.ts:100-172` 的 `NODE_KIND_BEHAVIORS satisfies Record<NodeKind, NodeKindBehavior>` 已经把「新增一种节点类型」变成编译错误（RFC-243 加 call-workflow/call-workgroup 时就是被这张表逼着填满四个维度的），且 RFC-146 在文件头立了明确准入规则：每个维度必须有 grep 可证的真实运行时消费者，原 RFC-053 的四个空想维度已被删除，理由写的就是「假 SSOT」。端口维度也已有 declaredPorts 按 wrapper kind 分派。wrapper 的 resumeAllowedFrom / bubblesAwaiting / acceptedInnerKinds 应作为新维度加进这张既有表，WrapperStrategy 只留 initProgress / runInner / progressPayload / finalize 四个函数槽。另起一张表正是 RFC-146 明令要消灭的形态。

### call-workflow 不是「第四类 wrapper」；workgroup_assignments 也不是「第七套状态机」

call-workflow 不在 `WRAPPER_NODE_KINDS`、不递归 runScope、生命周期锚在子任务上，且 RFC-243 D6 明确规定「子任务 awaiting 期间父行保持 running（不冒泡）」——所以 call 行**结构上永远不会**进 awaiting\_\*，scheduler.ts:2944 的 `['pending','interrupted','canceled']` 是正确的站点取值而非静默漂移。把它塞进 WrapperRuntime 并硬凑 `canBubbleAwaiting:false` / `acceptsInnerKinds:∅` 只会让能力表退化成噪声。同理 workgroup_assignments 自带的 awaiting_human 转移表是**卡片指派**的领域对象（open/dispatched/running/delivered/done），与 node_run 转移表无关是正确的领域分离。

### 已经收口的写入治理是全仓资产——重构中必须保留并扩展这套模式，不是拆掉它

`tasks.status` / `node_runs.status` / `node_runs.merge_state` 三条生命周期各有唯一写点（services/lifecycle.ts）并由 eslint 规则 + grep 守卫把裸 UPDATE 锁死；行 INSERT 收敛到 `nodeRunMint.ts` 单一工厂 + rfc098 grep 守卫，且 mint 的 supersede 与 insert 在同一 `dbTxSync` 内原子化；gc 的 `workspace_pruning_at` 是刻意的跨进程持久 claim（可崩溃续做、有续租），并已在 lifecycle.ts:378-421 的复活门与**每一条** revive 路径单点汇合（RFC-165 F8/R3-1）。这些都不是「四套并行登记处」里的杂项——WP-10 要做的是把这套模式扩展到通知 / 自愈 / 委派三层，而不是把已收口的部分重新打散。

### services/ 平铺 163 文件不是「半途而废的迁移」，不要为它做整仓大搬迁

`clarify/` 只有一个文件不是迁移停在中间：RFC-217 T9 声明的范围就是把 `clarify.ts` + `crossClarify.ts` **合并**成 `clarify/service.ts` 做 kind 泛化（DTO / broadcast 单份），从没说要迁 clarify 全族；`execution/` 是 RFC-242 的新子系统落盘，不是 `executionPolicy.ts` 的迁移目标。这条被复核降到 P3：无强制 / 正确性代价（无门禁依赖分组、无 import 契约被违反），而提议的六大目录整仓搬迁（约 140 文件）在 trunk-only + 多 agent 并发树上会与所有在途工作大面积冲突。真正值钱的只有一小步：把 `resolveEffectiveClarifyChannel` / `shouldInjectStopNotice` / `computeRemaining` 三个纯 oracle 抽到 `clarify/policy.ts`，让 scheduler 不再因依赖它们而拖进 REST 投影与协作草稿的整条依赖链。

### verifiedSystemPlan 的 write-before-scan 顺序不是信任边界漏洞；manifest 的 ~30 字段也不靠人肉对齐

三条 verified 装配管线里 verifiedSystemPlan 是 `write manifest → scan → assert`、另两条是 `scan → assert → write`，看起来像 TOCTOU 栅栏被绕过。但 verifiedSystemPlan.ts:297-305 的 `finally { if (!succeeded) rm(manifestPath) }` 在 assert 抛出时无条件删除 manifest，而 `succeeded = true` 设在 assert 之后——此时 plan 尚未返回、launcher 尚未 spawn，不会把任何冻结事实交给不可信 launcher。这是**书写顺序**差异不是**信任边界**差异（RUN-4 因此从 P1 降到 P2）。另外 `verifiedManifest.ts` 是 `.strict()` 的闭合判别联合外挂 ~160 行跨字段 superRefine，写盘前与读取时两侧都 parse，字段一致性是编译期 + 运行期双重强制。剩下的真实代价只是模板方法缺失。

---

## ⑥ Quick wins（无需 RFC、可直接改）

### 修 depcheck 的 tsconfig，让依赖门禁看得见后端 61% / 前端 59% 的依赖边

- **锚点**：.dependency-cruiser.cjs:97; packages/backend/tsconfig.json:7; packages/frontend/tsconfig.json:8; packages/backend/tests/rfc217-architecture-locks.test.ts:24
- **动作**：把 `depcheck` 拆成三条 per-package `depcruise --ts-config packages/<pkg>/tsconfig.json`（实测 `options.enhancedResolveOptions.alias` 不被 schema 接受，报 `must NOT have additional properties`，只能走 per-package tsConfig）。修完立刻会报 16 条违规（15 环 + 1 条 `services/apiDocs.ts:28 → routes/registry` 违反 no-services-to-routes），按 RFC-217 既有做法写进 `from.pathNot` 白名单、每条注明拆环归属，并加断言「白名单条目数只许缩」。同批新增元测试：depcruise JSON 输出的 `couldNotResolve` 边数为 0（棘轮）——这条比白名单本身更重要，它让「门看得见图」变成被锁住的事实。

### frontier 纯核归位 + 删掉为测试保留的转发壳

- **锚点**：packages/backend/src/services/scheduler.ts:1976; packages/backend/src/services/scheduler.ts:2053; packages/backend/src/services/scheduler.ts:8911; packages/backend/src/services/scheduler.ts:9019; packages/backend/src/services/scheduler.ts:1284; packages/backend/src/services/lifecycleRepair/options-S1.ts:23
- **动作**：把 `Frontier` 类型 + `SETTLES_WITHOUT_ROW_KINDS` + `isLiveStatus` + `deriveFrontier` + `buildScopeUpstreams` + `findScopeCycle` + `buildContainerMap` 整体剪切到已存在的 `services/dispatchFrontier.ts`（已逐符号验证零新增依赖方向：只用到 freshness / dispatchFrontier / shared 的符号）；删掉 scheduler.ts:1280-1284 那个注释自认「为让六个测试文件不改 import」的 `isFresherNodeRun` 转发壳，6 个测试的 import 一次 sed 改指 freshness.ts。搬完 scheduler.ts 在 src/ 里成为零 importer 叶子（lifecycleRepair/options-S1 只为 buildContainerMap 而静态拉起 60-import 图的问题一并消失）。

### 补齐 RFC-248 多仓语义在 wrapper 侧漏掉的一半（readonly 丢失 + git park 丢逐仓 baseline）

- **锚点**：packages/backend/src/services/scheduler.ts:7879; packages/backend/src/services/scheduler.ts:7859; packages/backend/src/services/scheduler.ts:7975; packages/backend/src/services/scheduler.ts:7784; packages/backend/src/services/scheduler.ts:5793
- **动作**：两个真缺陷 + 一次收口：①`runGitWrapperNode` 的 innerState（:7877-7880）把 `readonly` 写死 false，而同函数 :7859 的 diffableRepos 用 `state.repos[i]?.readonly`——嵌套 wrapper（git-in-git / loop-in-git）下 RFC-248 D11 的只读成员会重新进入 git_diff（loop 侧 :5794 已正确）；②git wrapper 的 awaiting park 路径（:7975）只写 `{kind:'git', baseline, preDirty, phase:'awaiting'}`，丢掉 D9 新增的 `baselines`/`preDirtyByRepo`，resume 侧 :7784 回落成 `{'': baseline}` → 多仓任务 park 过一次后非挂根仓 baseline 退化。先各写一条红测再修，然后抽 `projectIsoSchedulerRepos(canon, iso)` 纯函数收掉两处覆写点，配源码断言禁止 `readonly: false` 出现在 innerState 构造里。

### 消掉两段逐字重复：fanout 重试外壳与 MaterializedSpace 构造

- **锚点**：packages/backend/src/services/scheduler.ts:6503; packages/backend/src/services/scheduler.ts:6979; packages/backend/src/services/scheduler.ts:3662; packages/backend/src/services/scheduler.ts:3848
- **动作**：①`dispatchFanoutShard`(6503-6522) 与 `dispatchFanoutAggregator`(6979-7000) 的外层重试壳是**逐字同构**的 19 行（同样的 maxRetries 取法、同样的四条 bail 条件、同样的 `{...args, reuseDisabled:true, processRetryIndex:+1}` 重装），抽 `withNodeRetryBudget` 合一并加 `for (let retriesUsed = 0` 的计数断言，作为后续合并 attempt 体的安全网；②:3662-3692 与 :3848-3878 两段 MaterializedSpace 构造经 difflib 比对 **ratio = 1.0（去空行后 31 行逐字完全相同）**，抽 `buildInheritedSpace(state, childId, iso)` 一个函数即可。两项都是零语义变更、零风险。

### 把平台级 execution-identity 失败词汇表搬出 opencode 驱动子树，并把分层方向锁成守卫

- **锚点**：packages/backend/src/services/runtime/opencode/failure.ts:1; packages/backend/src/services/containmentComposition.ts:8; packages/backend/tests/rfc233-containment-source-guard.test.ts:61
- **动作**：`runtime/opencode/failure.ts` 已被 8 个非 opencode 模块引用（systemAgentRun / runtimeSmoke / memoryDistiller / netlessProjection / routes/runtime / opencodeStoreRecovery / claudeCode/driver / mcpTestExecutionMaterial），事实上就是平台级词汇表：整体 `git mv` 到 `services/execution/failure.ts`，opencode 目录只留 marker 前缀常量（纯类型 + 2 个 parse 函数、10 个 import 点、零环风险，单 PR 可完）。同批把 rfc233-containment-source-guard 那条「`containmentComposition.ts` 包含 `requireRootOwnedBwrap` 字面量」的弱断言升级成「`containmentComposition.ts` 不得出现 `runtime/opencode`」——否则下一个 RFC 还会往回接。仓内已有同方向两次成功迁移（RFC-237 binarySnapshot、RFC-242 netlessProjection）可援引。

### 清死缝与失真文档：零调用方的导出、说谎的注释、从不读写的列

- **锚点**：packages/backend/src/services/driverLease.ts:49; packages/backend/src/services/driverLease.ts:8; packages/backend/src/services/lifecycle.ts:326; packages/backend/src/db/schema.ts:1380; packages/backend/src/db/schema.ts:1856; packages/backend/src/services/scheduler.ts:1673
- **动作**：六处零风险整理：①`isDriverLeaseHeld`(driverLease.ts:49) 与 `driverLeaseHolder`(:54) 生产零调用方——删掉（留着会误导后人以为查得到持有者）；②driverLease.ts:8-13 的模块头声称「auto-actor 与 human 永不并发」，但人工路径从不取锁——改成事实（「本模块只保证 auto↔auto；auto↔human 由 resumeKick 的 isTaskActive + setTaskStatus 的 CAS 提供」）；③backend/lifecycle.ts:326-330 的 doc 声称五个 allowTerminal 持有者「all via the transitionTaskStatusByEvent event path」，实测只有 resumeKick 走事件路径——改成事实；④schema.ts:1380-1388 的 `wrapper_progress_json` 列文档仍写「NULL for non-wrapper runs」而 RFC-243 已把 CallLedger 存进同一列——补上，并把 CallLedger 的 zod schema + 解码搬进 `wrapperProgress.ts`（改名 `nodeRunProgress.ts`），删掉 limits.ts:157 那份重复解码器；⑤`question_scopes_json`(schema.ts:1856) 已确证从不读写（RFC-162 删除 scope 语义）——DROP；⑥`loadOpenClarify`(scheduler.ts:1673) 对同一张表发两条只差 kind 的查询，合成一条 `inArray(kind, ['self','cross'])`。

---

## ⑦ 附录：全部 72 条存活发现

> 合并进 §3 的以 top issue 的 `source_ids` 追溯。级别为复核后的修正值。

| 编号                   | 级别 | 维度            | 一句话                                                                                                                                                                   | 主要位置                                                                                                                                     |
| ---------------------- | ---- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| SCHED-2                | P1   | scheduler-core  | 缺「一次隔离代理运行」下层原语：6 处手工装配 runNode 参数、9 份 repos 投影已实际漂移，isolatedAgentRun 刻意只抽了一半                                                    | packages/backend/src/services/scheduler.ts:7879; packages/backend/src/services/scheduler.ts:5794                                             |
| SCHED-3                | P1   | scheduler-core  | wrapper 三件套仍是三份实现：loop 与 git 逐行 44% 相同，共享的只有一层 try/catch 外壳，序幕/收尾样板已在复制过程中漂移                                                    | packages/backend/src/services/scheduler.ts:5667; packages/backend/src/services/scheduler.ts:7726                                             |
| SCHED-4                | P2   | scheduler-core  | SchedulerState 把「任务不变量」和「scope 可变坐标」混在一个类型里：repos/scopeRoot 在 wrapper 里被同名同型覆写，嵌套时坐标逐层退化且无编译期信号                         | packages/backend/src/services/scheduler.ts:5783; packages/backend/src/services/scheduler.ts:7871                                             |
| SCHED-5                | P2   | scheduler-core  | 纯 frontier 内核被切成三块且主块留在 god module：deriveFrontier 是纯函数却住在 9021 行文件里，96 个测试文件被迫加载整张依赖图                                            | packages/backend/src/services/lifecycleRepair/options-S1.ts:23; packages/backend/src/services/scheduler.ts:9019                              |
| SCHED-6                | P2   | scheduler-core  | 节点状态写与 WS 广播是两步手工约定（57 处调用 + 6 个模块各拼帧），而任务级 lifecycle 已内建 post-commit 通知——同一层的两半不对称                                         | packages/backend/src/services/workgroup/taskActions.ts:426; packages/backend/src/services/workgroup/lifecycle.ts:411                         |
| SCHED-7                | P2   | scheduler-core  | node_runs.wrapper_progress_json 一列多语义：WrapperProgress 与 CallLedger 共用一列，三个互不感知的解码器，call 侧还没有 kind 判别位                                      | packages/backend/src/services/scheduler.ts:2830; packages/backend/src/services/limits.ts:157                                                 |
| SCHED-8                | P2   | scheduler-core  | execution/ 这次抽取与调度核心正交：只抽了任务级执行动词，节点级一行没动；且 facade 自称唯一入口却被 scheduler 用动态 import 绕开，源码锁覆盖不到                         | packages/backend/src/services/scheduler.ts:3662; packages/backend/src/services/scheduler.ts:3848                                             |
| SCHEDULER-CORE-MISSED  | P1   | scheduler-core  | 「跑一次 agent 节点」有四条并行流水线，重试预算复制三份，能力集永久分叉——fanout 分片拿不到 clarify/review 是架构直接产出的产品缺口                                       | packages/backend/src/services/scheduler.ts:6489; packages/backend/src/services/scheduler.ts:6503                                             |
| SCHEDULER-CORE-MISSED  | P2   | scheduler-core  | scheduler.ts 的 public 面是被测试撑出来的：7 个 export 在生产代码里零消费者，外加一个纯为测试保留的转发壳                                                                | packages/backend/src/services/scheduler.ts:8219; packages/backend/src/services/scheduler.ts:7493                                             |
| WRAP-1                 | P1   | wrapper-model   | 四类 wrapper 没有公共策略接口，同一骨架手抄 3~4 份，一处语义变更必须改 N 处（已有多次同改证据）                                                                          | packages/backend/src/services/scheduler.ts:5715; packages/backend/src/services/scheduler.ts:5735                                             |
| WRAP-2                 | P2   | wrapper-model   | wrapper-fanout 名义上是 wrapper、实为独立执行引擎：不走 runScope、无私有 canonical、无 awaiting、只收 agent-single，导致 WRAPPER_KINDS 成员资                            | packages/backend/src/services/scheduler.ts:6198; packages/backend/src/services/scheduler.ts:6015                                             |
| WRAP-3                 | P1   | wrapper-model   | node_runs 身份缺 scope path：嵌套语义靠 validator 禁令 + depth-1 近似维持，扁平 iteration 已被 6 个后补轴打补丁                                                          | packages/backend/src/db/schema.ts:1252; packages/backend/src/db/schema.ts:1253                                                               |
| WRAP-4                 | P1   | wrapper-model   | wrapper 的 merge-back 是 mergeBackAndSettle 的一份分叉，RFC-210 的子模块 merge-agent 钩子与 pendingSubResolves 只接到了 agent 一支                                       | packages/backend/src/services/scheduler.ts:7649; packages/backend/src/services/scheduler.ts:7670                                             |
| WRAP-5                 | P2   | wrapper-model   | iso 句柄的「行 → IsoHandle」水合在 scheduler 里手抄 5 处，nodeIsolation/isolatedAgentRun 只收口了写入侧、没收口读出侧                                                    | packages/backend/src/services/scheduler.ts:2534; packages/backend/src/services/scheduler.ts:2537                                             |
| WRAP-6                 | P2   | wrapper-model   | wrapper 进度 payload 没有单一 owner：6 个调用点各自手拼、schema 是 optional 大杂烩而非判别联合，且已漂移；同一列还被 call-workflow 复用存完全不同的 CallLed              | packages/backend/src/services/scheduler.ts:5425; packages/backend/src/services/scheduler.ts:5581                                             |
| WRAP-7                 | P2   | wrapper-model   | dispatchFanoutShard 与 dispatchFanoutAggregator 是两份 ~430/~400 行的近逐字同构外壳，RFC-188 只收了其中的 merge-back 一段                                                | packages/backend/src/services/scheduler.ts:6503; packages/backend/src/services/scheduler.ts:6979                                             |
| WRAP-8                 | P3   | wrapper-model   | 「wrapper 消费了哪些上游」有两套推导 + 三种写入协议，跨 wrapper 不可比                                                                                                   | packages/backend/src/services/scheduler.ts:5375; packages/backend/src/services/scheduler.ts:5404                                             |
| WRAPPER-MODEL-MISSED   | P1   | wrapper-model   | wrapper 的「哪些行属于我」有两套互不相交的表示，且 parentNodeRunId 被重载成「fan-out 子行」判据——每个消费者只能自己选一套或手工并集                                      | packages/backend/src/services/runLiveness.ts:266; packages/backend/src/services/runLiveness.ts:283                                           |
| WRAPPER-MODEL-MISSED   | P2   | wrapper-model   | wrapper iso 生命周期原语留在 9000 行 scheduler.ts 里、以 SchedulerState god-object 为唯一入参，且 export 只为让测试够得着（测试 seam 侵入生产代码）                      | packages/backend/src/services/scheduler.ts:7493; packages/backend/src/services/scheduler.ts:7649                                             |
| LIFE-1                 | P1   | lifecycle-state | 自愈子系统已增殖为 10 个互不知情的 healer，守卫组合呈稀疏矩阵，四次历史事故同源                                                                                          | packages/backend/src/cli/start.ts:757; packages/backend/src/cli/start.ts:763                                                                 |
| LIFE-2                 | P2   | lifecycle-state | 状态机「单一转移表」已存在但不具权威性：31 个 task 写点只有 1 个走事件路径，手抄 allowedFrom 已写出表禁止的边                                                            | packages/shared/src/lifecycle.ts:296; packages/shared/src/lifecycle.ts:324                                                                   |
| LIFE-3                 | P2   | lifecycle-state | 「任务归谁驱动」有四套并行登记处，driverLease 宣称的 auto↔human 互斥在代码里不成立                                                                                       | packages/backend/src/services/driverLease.ts:8; packages/backend/src/services/driverLease.ts:49                                              |
| LIFE-4                 | P1   | lifecycle-state | services/task.ts 4616 行同居 5 个无耦合子域，并与 scheduler.ts 构成值级循环依赖                                                                                          | packages/backend/src/services/task.ts:114; packages/backend/src/services/scheduler.ts:182                                                    |
| LIFE-5                 | P1   | lifecycle-state | 任务级中断/失败原因没有结构化列，机器语义寄生在 error_summary / error_message 两个人读文本列，RFC-145 的禁令只落在 node_runs 一侧                                        | packages/backend/src/db/schema.ts:963; packages/backend/src/db/schema.ts:1314                                                                |
| LIFE-6                 | P2   | lifecycle-state | 启动/恢复/重试三条入口各抄一遍 runTask kick 块与前置守卫，三份已出现行为差异                                                                                             | packages/backend/src/services/task.ts:2387; packages/backend/src/services/task.ts:2936                                                       |
| LIFE-7                 | P2   | lifecycle-state | 修复引擎的并发守卫是 call-site 约定：26 个 preflight 只有 13 个调 schedulerLivenessGate，改任务状态/触发 resume 的选项也在漏调之列                                       | packages/backend/src/services/lifecycleRepair/helpers.ts:12; packages/backend/src/services/lifecycleRepair/helpers.ts:20                     |
| LIFE-8                 | P2   | lifecycle-state | setTaskStatus 从状态机原语长成 177 行的通知 hub（含 fs IO 与三套异构回调），而用户可见的 WS task.status 反倒靠调用点自觉，31 写点只有 13 个发射                          | packages/backend/src/services/lifecycle.ts:334; packages/backend/src/services/lifecycle.ts:378                                               |
| LIFECYCLE-STATE-MISSED | P1   | lifecycle-state | no-circular 门是「假锁」：dependency-cruiser 用的 tsconfig 没有 @/\* paths，66% 的后端依赖边解析失败被静默忽略，task↔scheduler 真实运行时环因此长期隐形                  | .dependency-cruiser.cjs:97; .dependency-cruiser.cjs:66                                                                                       |
| LIFECYCLE-STATE-MISSED | P1   | lifecycle-state | RFC-243 把任务生命周期变成递归（task → node_run → child task），但「子任务的驱动者是另一个任务的 call 行」这条横切事实没有单一谓词，三个后台执行者各自重造、两个完全没有 | packages/backend/src/services/gc.ts:383; packages/backend/src/services/stuckTaskDetector.ts:222                                              |
| LIFECYCLE-STATE-MISSED | P2   | lifecycle-state | selectSyncRollbackTargets 自称是 selectResumeRollbackTargets 的「泛化版」却没有取代它，两份并存且 RFC-243 §4.2 的 call 行豁免只落在其中一份上                            | packages/backend/src/services/task.ts:719; packages/backend/src/services/task.ts:728                                                         |
| RUN-1                  | P0   | runner-runtime  | runNode 是 1902 行 / 43 入参的 god-function，同时是调度下游、运行时上游、WS 事件源、协议解析器和持久化层                                                                 | packages/backend/src/services/runner.ts:691; packages/backend/src/services/runner.ts:2592                                                    |
| RUN-2                  | P1   | runner-runtime  | OpenCode session 所有权状态机住在通用 runner 里；`SpawnPlan.control` 名为 runtime-neutral、实为两个 opencode 专属变体                                                    | packages/backend/src/services/runner.ts:113; packages/backend/src/services/runner.ts:117                                                     |
| RUN-3                  | P1   | runner-runtime  | 「spawn 一个子进程并安全收割」这个平台核心原语被 fork 了 4 份，kill 降级语义与 grace 常量已经互不相同                                                                    | packages/backend/src/services/runner.ts:2683; packages/backend/src/services/systemAgentRun.ts:169                                            |
| RUN-4                  | P2   | runner-runtime  | 三份 verified plan 装配管线各写一遍同样的 8 步，`verifiedPlanCore` 只覆盖了其中约 15%；source-fingerprint 栅栏与 manifest 落盘的顺序已经漂移                             | packages/backend/src/services/runtime/opencode/verifiedPlan.ts:422; packages/backend/src/services/runtime/opencode/verifiedSystemPlan.ts:129 |
| RUN-5                  | P1   | runner-runtime  | 「生产 vs 遗留未验证路径」这个信任位靠 WeakSet 对象身份传递；argv head 同时有三个优先级互相倒挂的解析函数                                                                | packages/backend/src/util/opencode.ts:17; packages/backend/src/util/opencode.ts:39                                                           |
| RUN-6                  | P2   | runner-runtime  | containment 有两套并行对象模型；RFC-233 的唯一准入点以「可选参数」形态在 31 个文件里手工穿线，漏传即静默 fail-open；预览与准入的输入未同源                               | packages/backend/src/services/runner.ts:1371; packages/backend/src/services/runner.ts:1049                                                   |
| RUN-7                  | P1   | runner-runtime  | 平台级 containment 机制（netless manifest / bwrap·seatbelt 渲染 / 环境变量净化 / root-owned bwrap 资格化）寄居在 opencode 驱动子树里，被组合                             | packages/backend/src/services/runtime/opencode/sealedSubprocess.ts:1; packages/backend/src/services/runtime/opencode/sealedSubprocess.ts:18  |
| RUN-8                  | P2   | runner-runtime  | runtime 扩展点是「按 runtime 命名的字段 + 协议字面量策略表」而非驱动声明的能力；加第三个 runtime 要改 14+ 处，且其中执行策略是 fail-open                                 | packages/backend/src/services/runtime/types.ts:39; packages/backend/src/services/runtime/types.ts:62                                         |
| RUNNER-RUNTIME-MISSED  | P1   | runner-runtime  | SpawnPlan 已变成「可选义务契约」结构体：9 个字段是给 spawn 方的强制义务，却由 5 个独立消费者各自靠约定手工兑现，漏兑现 = 静默 no-op（已有一次登记在案的事故）            | packages/backend/src/services/runtime/types.ts:132; packages/backend/src/services/runtime/types.ts:144                                       |
| RUNNER-RUNTIME-MISSED  | P2   | runner-runtime  | 平台有四条互不相干的「跑一次 agent」管线，各自持有 run 记录 / 状态词汇 / 并发控制 / 取消语义；其中两条把并发状态放在 module-global                                       | packages/backend/src/services/mcpRuntimeTest.ts:482; packages/backend/src/services/mcpRuntimeTest.ts:251                                     |
| RUNNER-RUNTIME-MISSED  | P2   | runner-runtime  | containment 子进程、netless wrapper、FFF 探针、verified launcher 全是 daemon 单二进制的隐藏子命令，共用 `main.ts` 的静态 import 图——每 for                               | packages/backend/src/main.ts:12; packages/backend/src/main.ts:24                                                                             |
| HIL-1                  | P1   | human-in-loop   | 六套「暂停等人」机制没有共同抽象，每套把 open/park/answer/release 全链各写一遍                                                                                           | packages/backend/src/services/clarify/service.ts:225; packages/backend/src/services/clarify/service.ts:1                                     |
| HIL-2                  | P1   | human-in-loop   | HTTP 应答路径已长成第二个调度器：路由线程算 frontier、铸 node_run、reset worktree、cancel 在飞行，且被 scheduler tick 反向调用成环                                       | packages/backend/src/services/scheduler.ts:1503; packages/backend/src/services/review.ts:2479                                                |
| HIL-3                  | P1   | human-in-loop   | 「门是否开着」的真值分散在 2~4 张表且互为独立 park 信号，只能靠 direct-status-write 逃生舱手工保持原子                                                                   | packages/backend/src/services/clarifySeal.ts:332; packages/backend/src/services/clarifySeal.ts:344                                           |
| HIL-4                  | P1   | human-in-loop   | park 信号是无载荷裸 kind：任务级分支丢弃 detail、复活证据形状硬编码，新增 gate 既说不出原因也唤不醒 wrapper                                                              | packages/backend/src/services/scheduler.ts:1267; packages/backend/src/services/scheduler.ts:753                                              |
| HIL-5                  | P2   | human-in-loop   | clarify 域 8 个模块是按 RFC 时间线增生而非领域分解：目录只有 1 个文件、clarifyRounds.ts 混装三种无关职责、quick/defer 双通道在同一入口交织                               | packages/backend/src/services/clarifyRounds.ts:51; packages/backend/src/services/clarifyRounds.ts:172                                        |
| HIL-6                  | P2   | human-in-loop   | 「释放门」的 resume 踢腿在 3 个 route 逐字复制第 4 次在 workgroup，且吞 task-not-resumable 靠 call-site 约定                                                             | packages/backend/src/routes/clarify.ts:432; packages/backend/src/routes/reviews.ts:320                                                       |
| HIL-7                  | P2   | human-in-loop   | 人在回路收件箱没有统一读模型：3 个 pending-count 端点 + 前端手工合并，workgroup 只能当聚合行，看板与 dw-confirm 根本不在收件箱                                           | packages/backend/src/routes/clarify.ts:181; packages/backend/src/routes/reviews.ts:174                                                       |
| HIL-8                  | P2   | human-in-loop   | wrapper 的 awaiting 冒泡在 loop/git 两处逐字复制，wrapper 只镜像状态而不拥有门语义                                                                                       | packages/backend/src/services/scheduler.ts:5837; packages/backend/src/services/scheduler.ts:7970                                             |
| HUMAN-IN-LOOP-MISSED   | P1   | human-in-loop   | 门释放的正确原语 resumeTaskWithAtomicSideEffects 已存在且自带「不要用 write-then-fire-and-forget」的文档，但 6 个门里只有 1 个在用                                       | packages/backend/src/services/task.ts:2710; packages/backend/src/services/task.ts:2716                                                       |
| HUMAN-IN-LOOP-MISSED   | P2   | human-in-loop   | 「关门」和「开门」一样没有 owner：唯一的跨 gate 收口是一条表盲的状态串扫描，看板一行不扫，补偿靠三处各写的读侧终态过滤                                                   | packages/backend/src/services/terminalSweep.ts:50; packages/backend/src/services/terminalSweep.ts:113                                        |
| HUMAN-IN-LOOP-MISSED   | P2   | human-in-loop   | 「人提交答案」的乐观并发协议每个门各造一套，共四种互不兼容的丢失更新防护，其中一种自带已知吞写窗口                                                                       | packages/backend/src/services/review.ts:2197; packages/backend/src/routes/clarify.ts:415                                                     |
| XCUT-1                 | P0   | cross-cutting   | 依赖门禁 tsconfig 指错，`@/` 别名全解析失败——后端 61% 依赖边对 no-circular / no-services-to-routes 不可见，CI 绿而实际有 16 条违规                                       | .dependency-cruiser.cjs:97; .dependency-cruiser.cjs:68                                                                                       |
| XCUT-2                 | P1   | cross-cutting   | 「恢复任务」没有单一入口：6 处手工拼装 resume deps，4 处已真实漏掉 subagentLiveCapture；收敛动作做在了错误的 seam 上                                                     | packages/backend/src/routes/tasks.ts:772; packages/backend/src/routes/clarify.ts:434                                                         |
| XCUT-3                 | P1   | cross-cutting   | scheduler.ts 9021 行 god module：60 个 import、64 个内部函数、只有 16 个 export、2 个 importer，且用 `await import('@/services/t                                         | packages/backend/src/services/scheduler.ts:350; packages/backend/src/services/scheduler.ts:3196                                              |
| XCUT-4                 | P1   | cross-cutting   | StartTaskDeps 是四种关注点的混装袋（27 字段）：5 种互斥启动形态用平行 optional 字段而非 tagged union 表达，task.ts 里 49 处 `deps.<variant>` 分支                        | packages/backend/src/services/task.ts:196; packages/backend/src/services/task.ts:1799                                                        |
| XCUT-5                 | P2   | cross-cutting   | 后台循环无单一注册/停机编排点：23 处 setInterval，start.ts 手写 16 行 .stop()，另有 2 个只 unref 不 stop                                                                 | packages/backend/src/cli/start.ts:597; packages/backend/src/cli/start.ts:678                                                                 |
| XCUT-6                 | P2   | cross-cutting   | 测试缝以 optional 字段形态渗入生产顶层契约：AppDeps 里每个新子系统加一个 \*TestDependencies 槽，`deps.runFn ?? realFn` 各写各的                                          | packages/backend/src/server.ts:77; packages/backend/src/server.ts:108                                                                        |
| XCUT-7                 | P3   | cross-cutting   | services/ 163 个平铺文件 + 半途而废的子目录迁移：clarify/ 只装了 1 个文件而 5 个 clarify\* 兄弟仍在顶层，execution/ 与 executionPolicy.ts 并存                           | packages/backend/src/services/clarify/service.ts:1; packages/backend/src/services/execution/executor.ts:1                                    |
| XCUT-8                 | P2   | cross-cutting   | util/git.ts 与 services/git\* 互相依赖：叶子层用 `await import('@/services/…')` 反向调服务层，形成 3 条被门禁漏掉的分层倒置环                                            | packages/backend/src/util/git.ts:970; packages/backend/src/util/git.ts:972                                                                   |
| CROSS-CUTTING-MISSED   | P1   | cross-cutting   | 一次「节点执行」没有请求构造器：scheduler 内 6 处手工装配 runNode(...)、9 处各自推导 iso→repos 投影，RFC-248 的 mountPath/readonly 语义只落到其中 3 处                   | packages/backend/src/services/scheduler.ts:920; packages/backend/src/services/scheduler.ts:1849                                              |
| CROSS-CUTTING-MISSED   | P1   | cross-cutting   | 同一份运行时配置有两种不兼容形状（StartTaskDeps 嵌套 vs RunTaskOptions 扁平），靠两个手写、互不为逆的映射器搬运，round-trip 有损：子任务丢掉 commitPush / merg           | packages/backend/src/services/task.ts:222; packages/backend/src/services/task.ts:234                                                         |
| DM-1                   | P1   | data-model      | node_runs 是单表多态的 god table：51 列、12 个 JSON blob，十余种行语义靠可空列与魔法 node_id 前缀区分，全表无 kind 列                                                    | packages/backend/src/db/schema.ts:1244-1568; packages/backend/src/db/schema.ts:1256-1264                                                     |
| DM-2                   | P1   | data-model      | freshest-run 依赖 ULID 字典序这条无强制的系统前提，数据模型缺显式 generation/sequence 列；前端并存 startedAt 第二套排序                                                  | packages/backend/src/services/freshness.ts:132-161; packages/backend/src/services/nodeRunMint.ts:190                                         |
| DM-3                   | P1   | data-model      | 单仓/多仓被做成两套持久化表示（标量列 vs JSON map），repoCount === 1 的分叉解码在 scheduler 里复制 5 份，tasks.\* 还长期镜像 task_repos[0]                               | packages/backend/src/db/schema.ts:1330; packages/backend/src/db/schema.ts:1424-1482                                                          |
| DM-4                   | P1   | data-model      | 读模型没有查询层：review / clarify 列表端点整表 select 后在 JS 里 join，并对每个 task 反复 JSON.parse(workflow_snapshot)                                                 | packages/backend/src/services/review.ts:1225-1227; packages/backend/src/services/review.ts:1251-1260                                         |
| DM-5                   | P2   | data-model      | wrapper_progress_json 一列承载三种互不相关的语义（WrapperProgress / CallLedger / git baseline），并被当成「是否活跃 wrapper」的布尔判据                                  | packages/backend/src/db/schema.ts:1382-1391; packages/backend/src/services/scheduler.ts:2825-2845                                            |
| DM-6                   | P2   | data-model      | node_run_outputs 没有单一写入权威：13 处裸 insert，「kind + archive_json 必须一起写」的隐式契约只靠注释，已有写点漏写                                                    | packages/backend/src/services/scheduler.ts:8513-8518; packages/backend/src/services/scheduler.ts:3943                                        |
| DM-7                   | P3   | data-model      | 四张近乎同构的会话事件表各自演化，capture 实现被自认地 fork 了一份 90% 拷贝                                                                                              | packages/backend/src/services/sessionEventSink.ts:11-30; packages/backend/src/services/sessionCapture.ts:179-196                             |
| DM-8                   | P1   | data-model      | 仓身份存在两个并行 key：mount_path 是 RFC-248 宣告的规范键，但 4 个持久化 JSON map 的键仍是待删的 worktree_dir_name，代码里两者互相赋值                                  | packages/backend/src/db/schema.ts:1178-1186; packages/backend/src/db/schema.ts:1424                                                          |
| DATA-MODEL-MISSED      | P1   | data-model      | RFC-224 的「会话身份冻结 + 单写者租约」契约被 fork 成两张表 + 两个服务，改进只落在其中一份                                                                               | packages/backend/src/db/schema.ts:2601-2652; packages/backend/src/db/schema.ts:3043-3107                                                     |
| DATA-MODEL-MISSED      | P1   | data-model      | 「一个反问问题」没有单一归属：文本/答案/草稿/归属在 clarify_rounds 的 4 个 JSON blob 里，路由与生命周期在 task_questions 行里，靠非 FK 的 (origin_node_r                 | packages/backend/src/db/schema.ts:1815-1830; packages/backend/src/db/schema.ts:1856                                                          |
