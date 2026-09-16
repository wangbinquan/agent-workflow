# RFC-359：任务分解

## 0. 波次总览

**原则（D2/D3，修订）**：每一波自身可发布。实际顺序按硬依赖：**W2（原语+矩阵）→ W1 实现类条目 →
W1 接线类条目 → W3 → W4 → W5 → W6**。原稿「W1 优先」的理由对接线类条目成立，对实现类条目不成立
（它们在 PG 侧根本没有实现，在 W2 之前修只能抄第二份——正是本 RFC 要消灭的东西）。

| 波     | 内容                                                                                   | 为什么是这个顺序                                                                                |
| ------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **W1** | 修 12 条 P0，让 PG 真的能跑任务                                                        | 不修的话后面每一波都在一个跑不起来的 provider 上验证                                            |
| **W2** | 统一事务原语 ✅ + 能力矩阵 `EngineCapabilities`                                        | 它是「一份实现」的唯一技术前提；矩阵是「PG 最高性能」的唯一表达处                               |
| **W3** | 统一启动序列（消灭 `cli/start.ts` 的 provider 分支）                                   | 结构性缺陷的正身；W1 修的多数缺口在这里被永久关闭                                               |
| **W4** | 逐 context 合一适配器（153 对 → 0）                                                    | 体量最大，但 W2 之后是机械工作                                                                  |
| **W5** | 防复辟：七条结构性守卫 + harness 按 provider 参数化 + **全量套件在真 PG 上进 push CI** | 守卫的棘轮值要等 W4 收敛完才能钉死；覆盖率对等棘轮可提前到 W1 后立即上                          |
| **W6** | PostgreSQL 性能：JSONB + GIN 投影、`EXPLAIN (ANALYZE)` 热查询审计、双引擎性能基线      | 放 W4 之后——合一前给 PG 调优就是在给一份即将删除的实现调优                                      |
| **W7** | W4 的收尾：把 W5 守卫点出来的**剩余成对适配器**逐对合一                                | 见 §5c——W4 当时没有「还剩哪些对、每对验没验过」的清单，是 W5 的成对账本把它变成了可排期的有限集 |

## 0b. 验收记分板（W12 接续核验，2026-09-08）

「完整落地」= proposal §7 的 12 条 AC 全部达成。逐条实测状态如下——**数字都是跑出来的，不是估的**；
本波仍有多刀在跑，未达成项的数字会继续动。

| AC    | 判据                                              | 实测                                                                                                                                                                                                                                                                                                     | 状态   |
| ----- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| AC-1  | 已登记的机制差异保留对拍，其余重复实现合一        | 同目录153→9对已登记；W55将两个读取owner的三对完整资源快照投影共享，保原7调用及完整冻结/返回合同。三个SQLite原语的落位单独记为T17 59→56，不计业务合一。**W57 收掉两条内联真实重复**：①`/api/overview` 的两套完整实现（SQLite `buildOverview` / PG `composeSystemOverviewQuery`，逐个聚合键语义等价）收成一份，删 316 行；②任务可见性判据 `or(owner=我, id IN 我参与的)` 的**七份**逐字副本（含一份 provider 专属）收成一份，连带四份分块 `visibleTaskIds`（其中两份逐字相同、三份硬写字面量 500）；两条都带新守卫，可见性那条在收敛前 HEAD 上验红 6/6。**2026-09-13 续**：①退役一族**零生产调用方**的 SQLite 孪生——`transitionMergeState` / `tryTransitionMergeState` / `abandonSupersededMergeStates` / `ConcurrentMergeStateTransition` / `MergeStateUpdateExtra`（213 行），生产早已跑在中立的 `mergeStateLifecyclePersistence` 与 `nodeRunMintParticipant` 上（§5dj）；②合一「计划人审闸门」的判定——PG 侧此前**根本没有** `inspectHumanReview`，闸门在 PostgreSQL 上永远报不出 `waiting`（§5dm）；③**找到本仓最大的一处重复，且它此前不在任何账本里**——资源包 apply 引擎（SQLite 侧约 1448 行 / PG 侧约 976 行），成对判据是「同目录 + 同名」而它是**跨目录 + 改名**；已登记进 `DECLARED_CROSS_DIRECTORY_PAIRS`，并按 RFC 自己的办法**先补对拍**（`rfc359-w13-resource-package-apply-conformance.test.ts`，三种资源类型 / 16 格双引擎全绿，§5dp）。**跨目录真实重复缺口仍开**：那一对本身尚未合一。**2026-09-13 再续（§5dv）**：**那一对已合一**——先把 `rfc359-w13` 的 SQLite 泳道换成 PG 那台原子 apply 引擎实跑（22 格全绿、一格没改），确认「这一对从来不是两台机器，是一台中立引擎加一条 SQLite 专属老路」（七臂参与者 2977 行里 `PostgresqlDatabaseClient` / `DbClient` / `DbTxSync` 零处出现，唯一品牌痕迹是三个形参标注）；再把 `main.ts` / `server.ts` 两个 `provider === 'sqlite' ? …` 三元删成一条，退役两个零生产消费者的 SQLite 专属装配。**2026-09-14（§5dy / §5ea）AC-1 的成对面收口**：①通用 bundle 引擎整条退役（约 2800 行）；②**intent apply 引擎整条退役**（`sqliteIntentApplyOperations` 762 + `sqliteIntentApplyArtifactLifecycle` 178 + `legacyIntentApplyResourceParticipants` 1062 + 依赖表 141 + 提交期句柄 61），两个 bootstrap 根调同一个 `composeIntentApplyOperations`。账本 10 对 → **8 对**，剩下的八对已逐条判不合（迁移器 / 落盘格式 / 运行时引擎 / journal 事务包装）或已是薄转交。合一照出**三处 PostgreSQL 上一直存在的用户可见缺陷**（名字域 dangle 容忍写反、特权节点回填整段没有、in-place 改名两侧不一致），逐条修复并加双引擎判据 `rfc359-w41-intent-apply-provider-parity`（先红后绿实测）。                                                                                         **2026-09-13 续**：①退役一族**零生产调用方**的 SQLite 孪生——`transitionMergeState` / `tryTransitionMergeState` / `abandonSupersededMergeStates` / `ConcurrentMergeStateTransition` / `MergeStateUpdateExtra`（213 行），生产早已跑在中立的 `mergeStateLifecyclePersistence` 与 `nodeRunMintParticipant` 上（§5dj）；②合一「计划人审闸门」的判定，PG 侧此前**根本没有** `inspectHumanReview`（§5dm）；③**找到本仓最大的一处重复且它此前不在任何账本里**——资源包 apply 引擎（SQLite 侧约 1448 行 / PG 侧约 976 行），因为成对判据是「同目录 + 同名」而它是**跨目录 + 改名**；已登记进 `DECLARED_CROSS_DIRECTORY_PAIRS` 并补上 16 格双引擎对拍（§5dp）。**跨目录真实重复缺口仍开**：那一对尚未合一。 **2026-09-15 对账（§5fh）**：跨目录对已空、未验证对拍数为 0、仍成对共存 8 对且逐条判过「不合」并各有双引擎对拍。**但「完工线」有两份互相矛盾的定义**——AC 判据原文是「已登记的机制差异**保留对拍**，其余重复实现合一」（按此已满足），而 `PROVIDER_PAIR_COUNT` 的注释写「降到 **0** 才是合一完工线」（按此还差 8 对，含两套落盘工件格式与两台迁移器）。**2026-09-15 裁决（§5fq）**：这条矛盾不该靠「选一个数字」解，靠**判据**解——一对孪生必须合一，除非差异源于引擎本身，而「源于引擎本身」只有三种：①只有一个引擎有的原语（advisory lock / PRAGMA / `$client` / `dbTxSync` / PG 的只读可重复读快照）；②只有一个引擎有的资源形态（SQLite 是一个**文件**，PostgreSQL 是一台**服务器**）；③驱动强加的线上差异（占位符 / 类型编解码）。**其余一律是漂移，处方是各取更强的一半合成一份。**于是 `PROVIDER_PAIR_COUNT` 的「降到 0」注释作废：留下来的对必须**指名命中哪一条**，指不出来就得合。按这条判据，落盘工件格式与迁移器两对命中②（文件 vs 服务器），是真差异不是债。**2026-09-15（§5fp）AC-1 第一条按新判据执行的真合一**：`create{,Postgresql}ExecutionContractResourceAdapter` 两份都只是 `select` + 解码，三条都不命中 ⇒ 必须合。合之前先把两份接到**同一个真 PostgreSQL 库**上量差异，量出两处：①交给 `implicitAgentDeclarations` 的 `frontmatterExtra`，中立那份剥掉了 sidecar 键、PG 那份没剥（今天两个消费者都不读 sidecar 键，**属潜伏**）；②`definition` 存成坏 JSON 时，中立那份抛 `ValidationError('workflow-definition-corrupt')`、PG 那份抛**裸 `SyntaxError``**——**这一处是活的，用户看到的错误码取决于管理员选了哪种数据库**。合一取各自更强的一半（投影取 PG 的窄投影、解码取中立的两个口，并把解码抽成 `exposedFrontmatterExtra` / `decodeStoredWorkflowDefinition` 让整行路径与窄投影路径共用），三条新判据双引擎各自单独咬。 | 进行中 |
| AC-2  | 一个 boot 序列，无 provider literal 执行分支      | `servePostgresqlDaemon` 已删除，入口 provider literal 分支为 0                                                                                                                                                                                                                                           | ✅     |
| AC-3  | 双引擎原子性对拍；裸驱动事务归零                  | 按 TypeScript 接收者类型扫描，裸驱动事务账本为 0；生成器 runner 的 27 次中立事务不误计                                                                                                                                                                                                                   | ✅     |
| AC-4  | 方言 exact 清单，每项真实双引擎执行               | `RAW_DIALECT_DEBT` 与 `UNSHIMMED_FUNCTION_DEBT` 都为 0；`greatest` 的 NULL 前提有显式断言                                                                                                                                                                                                                | ✅     |
| AC-5  | 守卫锁住新增分叉                                  | T17/T18/T19/T19b–g/T20 已落；W12 补全 T18 接收者变异与守卫元数据                                                                                                                                                                                                                                         | ✅     |
| AC-6  | 全量 backend 行为套件在真 PostgreSQL 上进 push CI | **2026-09-13 当日收敛轨迹**：530 → 460（判据从文本扫改成 AST 数真调用点）→ 421 → **401**，其中「真债」`OPEN_MIGRATION_DEBT` **95**。总账按**该不该双引擎**分成五条机械免责判据（`migration-chain` / `sqlite-execution-engine` / `real-file-database` / `sqlite-only-primitive` / `sync-engine-capability`）与「真债」两栏，后者是唯一需要往下压的数字。**尾巴的形状已经变了**（§5do）：剩下的 95 个文件里，批量转换器对 22 个候选实跑下来只有 3 个能迁，**8 个卡在 SQLite-only 的生产签名上**（intent apply / 资源包 apply / 资源上限 / 几个 `composeSqlite*` 参与者）。**继续压这个数字的正解不再是转换测试，而是逐对收生产侧的引擎（AC-1）**——每收一对，下游那一串测试自然跟着能迁。 **2026-09-15 实测更正**：这一行写的「真债 95」**已过期**——`OPEN_MIGRATION_DEBT` 今天实测 **27 条**（`rfc359-w5-t19f-test-engine-hardcoding` 8 pass / 0 fail，账本与源码逐字相等）。剩余 27 条都是「没有机械正当理由的单引擎测试」，销账只有两条路：真迁到 `describeEachProvider`，或证明它落进 `SANCTIONED_SINGLE_ENGINE` 的某一类（账本明写**不许**为某个文件量身定做一条豁免）。抽查一条（`rfc097-task-status-cas.test.ts`，612 行 / 16 例）：被测的 `setTaskStatus` / `trySetTaskStatus` 本身是中立的，**可迁**，但它的 CAS 竞态用例是「在 helper 的 SELECT 与 UPDATE 之间插入竞争写者」，迁过去要重新对齐两个引擎的并发语义——**是真工作，不是机械转换**。 | 进行中 |
| AC-7  | 12 条 P0 消失且有回归证明                         | exact `67e2cf8c9a756ca3831a083aa4455cc03c2e2287` 独立真 PG job `102039466503` 成功；Bun1.4 两库各17阶段/89次执行，67 pass+22指定历史失败/827 expect，99源码与34原始日志摘要已核                                                                                                                          | ✅     |
| AC-8  | 用户可见行为逐字不变                              | **W54 那 15 条新 PG 红已在绿 SHA 上验证消失**：exact `03b34a783` 的 CI run `34440781011`，八个 ubuntu 后端分片（真 postgres:17 服务）合计 **19821 pass / 0 fail**，其中 `[postgresql]` 身份 **3317** 个、clarify × PostgreSQL 身份 **173** 个全过，八片零 `(fail)` 行。W54 定位的「mechanics common 与 CreateRoundCommon 没接全 executionContext」由 W55 两个生产文件的显式转交（显式值 ?? ambient 回退）修复，本次是它第一次落在全绿 exact SHA 上。**仍开放**：全量双库覆盖未闭合（见 AC-6），即「已跑的都对」不等于「该跑的都跑了」。**2026-09-13 逮到一条用户可见的分叉并修掉**：数字员工「计划人审闸门」在 PostgreSQL 上永远报不出 `waiting`（同一个案子 SQLite 显示「等待人审」、PG 显示「规划中」）——成因是端口**同步且可选**，PG 侧的 composition 实现不了、少实现也没有任何地方会红。判定已收成一份 async 中立实现、两侧都装，并加了**装配锁**（删掉 PG 侧那个方法当场红 4 格，§5dm）。同批做了一次**全类扫查**：端口/参与者接口上的可选方法全仓只有 9 个，其余 8 个都是按功能可选（工作组宿主能力 / 连接目录 / 契约投影），不是按引擎——这一类已经清干净。 | 进行中 |
| AC-9  | 含全部 RFC 改动的 exact-SHA CI 全绿               | **2026-09-13 连续 exact-SHA 全绿**：`63030aaea` / `b41a8cab2` / `55864e0c8` / `51aeda3f3` / `5b706bca8` / `7482255fc` 六笔各自的 push CI run 终态 success（十二个 ubuntu 后端分片带真 postgres:17、macOS 六分片、lint/format/depcheck、单二进制 build smoke、Playwright e2e）。同期修掉两次自己推出的红并各带回归用例：①`void <promise>` 没接 rejection（PG 上 `0 fail` 却退 1 的形态，§5dk）；②铸行 id 非单调（macOS 分片随机红，§5dl）。**仍待办**：RFC 收口后需要在最终 SHA 上再取一次终态取证。 | 进行中 |
| AC-10 | 业务 provider literal 分支为零                    | **2026-09-15 账本清零**：`PROVIDER_BRANCH_DEBT` 从开账的 31 处 / 16 个文件降到 **0**。十一波各自的处方**不相同**，这是本 AC 最该带走的东西——同一个账本条目，销账方式取决于「那个分叉到底在问什么」：①**品牌换能力**（traits 声明答案：`migrationRole` / `serverVersionFallback` / `failureRecoveryHint` / `offlineCompaction` / `absentLocalStoreMessage`）；②**删恒假 / 摆设标签**；③**按 provider 查表**（`satisfies Record<DatabaseProvider, …>` 即 forcing function，把「少一个 provider」从运行时抛错提前成编译错——`PRE_OPEN_STAGED_RESTORE` / `ENGINE_HEALTH_CHECKS` / `LOCAL_SYSTEM_OPERATIONS_COMPOSERS`）；④**装配方交答案**（`openAdmissionStore` / `startSupervisor` / `databaseInit`）；⑤**搬进白名单层**（`requireDatabaseConfig`）；⑥**各自收敛到强的一侧**（§5fb，唯一一条真改了用户可见行为的）。**traits 放答案、不放机械**是其中一条硬边界：`cli/start.ts` 的暂存恢复答案是一段 SQLite 机械，所以走查表而不是 traits。 | ✅     |
| AC-11 | 两引擎中位数基线，PG 各端点不劣于登记值 | **判据已换**（§5ey / §5ez，用户裁决「承认并改判据」）：从「PG 各端点 P95 不慢于 SQLite」换成「**中位数差不超过登记值**」。换的理由不是调数字过关，是**统计量选错了**——CI 的 `rounds: 20` 配 floor-quantile 让「P95」实际等于 **max**，六个轻端点的判决因此由单次抖动决定；而中位数差在每一个历史 run 上都同号。登记值逐端点写在 `scripts/perf-compare.ts` 的 `PERF_HTTP_SCENARIOS`（`medianAllowanceMs` + 可选 `medianAllowanceRatio`）。**换判据之后该红的照样红**：9 个历史 run 回放 4 FAIL / 5 PASS（`948d9b5f` / `602264d5`×2 红在 repos-first·reviews-pending，`dfb49eb8` / `56713f37` 红在 workgroup-pending +23.9/+24.9）。新判据上线第一跑就把**我自己校准错的一条登记值**顶了出来（`tasks-second` 的差随机器档次变号，EPYC 9V45 上 SQLite 提速 42% / PG 28%），据此补了比例项 `medianAllowanceRatio: 0.20`；`tasks-first` / `tasks-running` 九个 run 全负，比例项保持 0（不放宽）。**闭合条件**：在收口 SHA 上再取一次 `scale=full` 实测（`scripts/perf-run.ts`，100k tasks / 10M events）。 | 进行中 |
| AC-12 | 全量装配，无晚绑定占位，退役未豁免 provider 文件  | 当前占位文本32→9、未构造根0保持；provider文件88→56，其中W55的59→56来自三个真实SQLite原语归位platform/persistence，原body和导出保持。三份资源快照投影共享不改变调用装配；**W57 退役一个纯命名债入口**：`composePostgresqlResourceCatalogOverviewQuery` → `composeResourceCatalogOverviewQuery`（形参 `PostgresqlDatabaseClient` → `ProviderNeutralDatabase`；它的计数端口本就收中立客户端、函数体零方言，`/api/overview` 收成一份时 SQLite 也装它）。新增双库行为和澄清上下文转交修复待新SHA托管。**2026-09-13（§5dv）**：资源包 apply 的两个 SQLite 专属装配（`composeSqliteResourcePackageProvider` / `createSqliteResourcePackageExecutionAdapter`）因合一后零生产消费者而退役；`main.ts` / `server.ts` 的资源包三元各删一处。provider 适配器语料 133 → 131、provider 组合根 58 → 57。**2026-09-14（§5ea）**：intent apply 合一带走九个 provider 命名的装配 / 工厂（`compose{Sqlite,Postgresql}IntentApplyOperations` / `compose|createSqliteIntentApplyArtifactLifecycle` / `compose{Sqlite,Postgresql}IntentMaintenance{CommandsForAppHome,SnapshotQueries}` / `composePostgresqlIntentApplyConvergence` / `composeSqliteSkillArtifactCompensation` / `createLegacyIntentApplyResourceSession`），换成不带引擎前缀的 `composeIntentApply*` / `composeIntentMaintenance*`。provider 命名文件 47 → **44**、适配器语料 130 → **120**、组合根 57 → **48**。                                                                                    **2026-09-15 分类（§5fi）**：账本剩 **5 条**（先前误报为 3，已更正），**没有一条是「装配没做完」**——`marker` 那几条是 WeakMap **token 注册表不变量**（判据**高估**），`commandContext.ts` 的 `prose=5` 是**能力参数化**（依赖确实可选，`review.ts:1078/1598` 只传 `{db, appHome}`）。**另一个方向也不准**：`server.ts:2525` 有一处逐字同构的兜底因文案不含关键词而**两条判据都咬不到**（账本原话「改名逃逸不是假想」）。⇒ **占位计数现在不是可信的完工度量**。且这些前面的 session 已逐条分析、**明知误报也有意不豁免**；在已承认存在逃逸时再加豁免＝扩大盲区，故本轮不动判据。推进需一次方向裁决，两个选项见 §5fi。 | 进行中 |

### AC-9 取证（2026-09-10，exact `03b34a783`）

**主干在连红 10+ 笔后首次全绿。** CI run `34440781011`，**39/39 作业全部 success、零失败**，含：

| 面 | 结果 |
| --- | --- |
| 后端 × 真 PostgreSQL（ubuntu 8 分片，postgres:17 服务） | **19821 pass / 0 fail**，`[postgresql]` 身份 3317 |
| 后端 × SQLite（macOS 4 分片） | 全绿 |
| 前端（ubuntu / macOS / windows） | 全绿 |
| Playwright e2e（四 OS 共 10 分片） | 全绿 |
| 静态扫描（audit + actionlint + shellcheck + gitleaks） | 全绿 |
| 单二进制 build smoke（三 OS） | 全绿 |

**这一笔绿是怎么来的**——连红的四个成因逐条销掉，没有一条是「重跑就过了」：

1. `c8ed5871a`：W55 首次给 S17 / S18-S19 两条调度器回归锁接上 `describeEachProvider`，两条当场在 PG 上红。
   **S18/S19 是真缺陷**（读回 `node_runs` 后按数组序断言重试序列，SQLite 扫描序碰巧等于插入序、
   PG 不是）——补 `ORDER BY retryIndex`。**S17 不是缺陷，是余量失效**：断言余量 = 写者时长 −
   相邻节点派生间隔，实测 SQLite ~170ms / PG ~700ms–1s（PG 测试拓扑走完整 HTTP 应用 + 真库往返），
   而写者只跑 300ms ⇒ 在 PG 上恒不重叠；两侧 iso 隔离都已生效、锁序未变。把余量做成结构性
   （300 → 2500ms，两引擎同值）。
2. `c8ed5871a`：根 overrides 把 `js-yaml` 钉在 4.3.1，正落在 GHSA-2883-xcg3-v3hh 的受影响区间，
   改钉 4.3.2。
3. `a64c5991e`：gitleaks 两条误报（被测装配的 sha256 内容摘要、幂等键字面量），按本仓定式
   钉历史指纹 + 行内 `gitleaks:allow`。
4. `03b34a783`：`c8ed5871a` 为 W55 账本补录开的**三条一次性 `allowGrowth`** 在下一笔上过期，
   删掉并在 HEAD 只读导出上重采普查。

**AC-9 尚未可判达成**：本 SHA 只证明「当前主干全绿」，而 AC-9 要求的是**含全部 RFC-359 改动**
的那一笔。AC-1 / AC-6 / AC-11 / AC-12 仍有开放项，它们的修复会产生新 SHA，取证需随最终 SHA 重取。
**本节的价值是把「流水线红」这个前置障碍清掉**——在此之前任何 exact-SHA 取证都无从谈起。

**同批未修、已带证据落档**（`docs/audit-backlog.md`）：Windows 前端泳道存在间歇性数十秒停顿，
每次红在不同用例与分片；判据与 `rfc321-cached-repo-refresh-credential` 那条**相反**（那条是
「同文件邻居正常、只有它挂死」⇒ 单点挂起；这条是「邻居也慢、每次换人」⇒ 环境停顿）。

**W6 三件已收口**（2026-09-08 更正，此前记载过期）：**T23 判定为不可行并留下守卫**（jsonb 的
20× 买不起——三类活着的字节保真判据，逐条见 §5b）；**T24 已完成**（`q` 搜索 2.06×）；
**T25 已完成**——设施 + 5 处消费点在 `f2657dd00` 落地，W11 又补了六条热路径
（语句数 11→1 / 9→1 / 12→1 / 5→1 / 7→1 / 9→1）与批量删渲染（`deleteByCandidates` +
`BOUNDED_DELETE_MAX_ROWS` 单一推导，两侧各自那份 5000 常量删掉）。
`eventStore.ts` 的 `event_records` 一处留债：它的 `.returning()` 是活的分支判据
（`if (inserted === undefined) continue` 控制逐行去重），批量化需要设计而非机械改写。

**待完成的实际范围**：真实残余孪生合一、全量行为用例参数化、生产完整能力契约、
原始 P95 判据及最终 exact-SHA CI。此前“只剩命名债与事务守卫”的判断不成立。

**AC-9 的取证纪律**：取证 sha 必须是**含全部 RFC-359 改动的那一笔**，且要看**含该 commit 的
superseding run** 的绿（共享 main 上并发 push 会取消你的 run），并按失败测试的 owning commit 归属。
被 supersede 取消的 run **不是绿**。详见 `docs/dev-gotchas.md` 对应两条。

## 0c. W12 接续核验（2026-09-08）

- T18 已按接收者类型识别数据库句柄，`BARE_TRANSACTION_DEBT` **1 文件 / 27 处 → 0**。
  生成器 runner 的调用不再误算；10 格内存源码变异锁住裸驱动调用，另锁中立别名与注释/字符串。
  定向验证 15 pass / 0 fail；没有启动全量本地门禁。
- `b5347f30b` 的 CI `34153153273` 有两条源码账本失败，各在两个 OS 上出现：
  RFC-345 的 workgroup 导入集、RFC-349 的代理依赖引用预筛。前者保留接手时已有的修订，
  后者补全与 MCP/plugin 同契约的精确引用登记；生产行为不变。
- 上面 §0b 的「只剩命名债」不能作为完整落地结论。T17 源码旁的 W10 逐项分类仍指出
  resource-catalog 有跨目录/内联的成对实现；AC-12 还有启动入口与跨阶段绑定未闭合。
  接续工作以实际消费者、装配链和对拍结果为准，不通过改名把实现分叉销账。

### W12 第二批：生产装配与真实行为对拍

- realtime policy 改为完整构造参数；SQLite 根的 scheduler、collaboration、MCP、development
  与 PG maintenance status 均通过同一作用域的实际依赖闭包装配，取消可漏绑的空槽。
  memory 的 catalogBinding、digital-employee 的 runtime 输入与返回类型对应，调用方不再判不可能的空值。
- 清理 auth / identity-access / collaboration 的 19 个 provider 命名源路径，六个纯 SQLite
  测试兼容件移回 `tests/helpers/auth`。其余真实分叉保留原名，不靠改名销账。
- `rfc359-w5-t21b-execution-chain.test.ts` 从真实 launch → claim → drive → input/agent/output → done，
  同时核验输出、launch intent 终态和 owner 释放；仅用 mock-opencode 替代外部进程行为。
  `41c7316a6` 的 CI `34164195640` / job `101871886296` 已确认 SQLite 与真 PG 两侧都运行并通过。
  新的 composition contracts 与兼容 service 用例均接 `describeEachProvider`，真 PG 结果以本批 CI 为准。
- 工作组成员瞬态重试过去误走首次认领，重复执行 dispatched → running CAS，留下失败 run 与
  running 卡片。改为重关联新 run；两类瞬态错误恢复及重试耗尽回归，旧逻辑 3 fail，修复后 SQLite
  整文件 8 pass。Windows E2E 现场形状相符，但日志没有首个 failureCode，现场归因仍是推断。
- 首批 `9a093736b` / CI `34162161809` 暴露 T18 完整类型图超出单测试 5 秒以及负 fixture 元数据漂移。
  本批将类型图和调用计数集中在一次限时 setup 中，并同步实际守卫分类；没有降低生产判据。
  `41c7316a6` / job `101871886148` 的 15 条 T18 用例已通过（完整类型图 setup 约 11 秒）。
- 当前候选 TypeScript 检查通过；定向 SQLite 行为验证通过。完整本地门禁未启动，最终以 hosted
  exact-SHA CI 为准。上述 815 文件 / 1862 调用为 W12 AST 快照，后续迁移必须刷新清点。

### W12 第三批：读取合一、WorkStart 全量装配与自动修复引擎复用

- code-capability 四个 provider 文件合为 `codeMetricsRead.ts`、`capabilityMatrixRead.ts`，两个根
  共用 `composeCodeHistoryQueries`；矩阵保留 PG 的有界批量算法，1→5 个单元格始终 5 条 SELECT，
  空矩阵只发 1 条。原值与错误结果保持，源码净减 172 行。
- WorkStart 删除 deferred holder / bind。SQLite 的 `SqliteAppComposition` 必然返回 HTTP 员工
  模块的端口，两个 daemon 用后声明依赖的完整闭包装配；重复挂载不会覆盖已有实例，OS worker
  的独立生命周期保持。真实 SQLite HTTP 创建、发版、启动、重复挂载和幂等回归通过；PG 根尚以
  源码接线断言验证，本批不把它算作完整 PG daemon 动态证据。
- 自动修复两文件合为中立循环；PG 人工和自动复用原选项、preflight、applyAction 与清理引擎，
  删除第三份 S4 算法。自动空身份、原审计分类/快照/失败结果及关联告警元数据单独锁定，人工
  保留原响应和告警投影；17 条基线与新增对拍接入真 PG CI。实现门发现两处诊断/历史偏差，
  三个回归先红后绿后保留旧结果；SQLite 17 pass / 70 expect，最终类型/lint/格式及相关账本检查通过。
- 技能操作、恢复驱动、预留、版本操作和原子发布 5 套件迁入 `describeEachProvider`，保留全部
  28 个数据库行为用例及 1 个源码断言。新 AST 快照为 810 文件 / 1857 个实际 SQLite 构造调用，
  147 文件调用双引擎 harness；其中有引擎机制测试，仍须按用例分类，不能一概视为业务遗漏。
- `41c7316a6` 的 CI `34164195640` 中类型/lint/格式及真 PG 专用任务通过；shared codec 旧路径
  已以 `ab6e36437` 修复。两个 shard 1 暴露 13 条改名后被投影器遗漏的存量 inbound 账本与
  RFC-187 旧源码表达式，第三批同步修复并保留实际存量边；该 run 被后续提交取代且有失败，不能记全绿。
- AC-11 实测仍未达原文：同一 run / job `101871886117` 的 8 路径 PG/SQLite P95 比值为
  1.3–3.5 倍（overview 9.18ms / 2.60ms）。结构守卫通过不等于原 P95 条款通过，条款没有被改写。

### W12 第四批：初始迁移装配、资源包 journal 与完整执行工厂

- `composeDaemonProviderBootstrap` 在初始 session 前构造真实迁移 admission，初始化期间的
  sourceWriteWindow 直接读取它的 open phase；session、唯一 controller 和 router 齐备才返回。
  删除外部 deferred/bind；composing/ready/failed 是初始化状态，过早迁移动作明确拒绝，不能
  自等待或进入词法暂存区。错 generation 关闭已创建 session，关闭失败保留两个原错误；
  21 条初始装配/迁移/重试关闭回归通过，移除阶段门的变异先红。统一类型检查含 3 个负例通过。
- 资源包 journal 两份工厂合为 `resourcePackageApplyJournal.ts`，列表次序、冻结字段、expected
  state CAS 保持；资源恢复算法保持原样。同步事务账本减 1；双引擎语句数、竞争 CAS、外层回滚
  用例随 CI 执行。SQLite 定向 17 pass / 100 expect，生产源码净减 35 行。
- 真实 launch 到 done 用例改用完整的 SQLite/PG provider 工厂，实际驱动、owner、overview 与
  repair 命令共用该工厂返回的实例；PG workflow launch 也取自工厂，SQLite 保留原 startTask
  入口。原 11 项断言保留，新增完成统计和修复查询两项；SQLite 1 pass / 13 expect，PG 待本批 CI。
  未构造根账本 19 → 17，源码导入覆盖计数的减少按实际消费者变更同步，不能等同于行为覆盖回退。
- 再迁 10 个技能、MCP、内建工具缓存和 memory 状态测试：55 个数据库场景接入双引擎，13 个
  纯函数/文件/源码场景继续单跑；68 个测试名称、原顺序和 166 项断言保留，其中异步 ConflictError
  断言修为 await rejects。SQLite 68 pass / 166 expect。AST 清点 1881 个测试文件中有
  800 文件 / 1847 次 SQLite 构造，157 文件调用双引擎 harness；797 个无 harness 的文件仍含
  机制专属用例，不能直接等同于 797 个业务套件遗漏。
- 第三批 `2e68b5a35` / CI `34166445153` 暴露三条守卫漂移：RFC244 自动修复工厂旧名、
  WorkStart 已有消费者未销账、数值投影把注释内 SQL 误报。第四批逐项修复，保留原生产判据；
  该 run 终态 failure，不记全绿（两个 OS 的相同旧守卫失败，Ubuntu shard 3 被取消）。此前 `ab6e36437` / CI `34164925590` 终态 failure，只有两个
  shard 1 的旧 R1/RFC187 锁失败；第三批已修，其他任务通过。
- 本批完整本地门禁未启动；RFC 仍 In Progress，AC-11 原 P95 条款保留，最终整仓结论等 exact-SHA CI。

### W12 第五批：来源终止公共流程、持久化装配与行为覆盖

- 来源终止的两个工厂共用 binding/revision 查询、depth/id 排序、processed 固定点重扫、
  停止收据投影和 cause 函数。保持每目标串行，生产净减 17 行；两侧 `applyOne` 共 641 行
  经 AST 核对逐字不变，原事务、提交后事件/停止及 SQLite 无 driver 路径保留。排序与处理
  期间出现新子任务的新例在旧实现先通过，提取后加纯算法等候/异常/收据回归，30 pass / 79 expect。
  这只是公共流程提取，不能将整个 provider pair 销账。
- taskExecutionPersistence 的 25 个字段与构造顺序相同，抽为一份公共聚合；唯一不同的
  recoveryAdministration 仍在原位置构造并绑定原生命周期实现。pre-drive 组合根改用中立
  客户端与所选 persistence，两个 composition 路径去掉旧 provider 名。旧澄清恢复/目录
  38 个用例保留通过；完整 pre-drive 增补双引擎 claimed intent、重入与载荷错误验证。
- 两份新测试真实构造 Event Center、SQLite intent artifact lifecycle 与 PG intent convergence，
  驱动事件去重/重建/确认/重放，以及真实 DB/FS 补偿、活动/新鲜 journal、发布重试与坏日志保留。
  SQLite 6 pass / 62 expect；空持久化/空补偿变异明确红。未构造根 17 → 14，PG 等本批 CI。
- 15 个 memory/MCP/plugin/catalog 测试文件中的 137 个数据库行为接入双引擎，20 个纯函数
  或源码场景单跑，157 个原名称与 380 项断言 AST 保持相同；SQLite 157 pass / 388 expect。
  测试 seed 的 inputs 编码与两个枚举类型问题由统一类型检查发现并修复，42 个相关用例再次通过。
  当前 AST 为 1884 个测试文件，785 文件 / 1825 次实际 SQLite 构造、174 个 harness 文件。
- 第四批 `7ca6290d4` / CI `34168059309` 的四个 Ubuntu backend 分片已全部 success。
  job `101882938060` 确认真 PG 完整 provider 工厂任务 launch→done；job `101882938150`
  确认 journal 的语句数、竞争 CAS 与外层回滚真实双引擎通过。整 run 仍为 failure：唯一功能失败是
  macOS shard 3 的旧 direct-upload body+file journey 在 working 状态等待 90 秒。
  真 store 竞争回归已复现一条相同停顿链：materializer 插入快照后，peer reconcile 的 readiness
  写推进 revision，原写回忽略 CAS 失败，需求引用仍为 null；后续决策去重、无未结 effect。
  现场日志未保存需求引用，不能将这条已证实的缺陷当作现场唯一原因。
- 同提交维护大样本 run `34168059214` / job `101882937723` 终态 failure：唯一失败是
  `webhookDeliveryGc` 清理 body 的单笔 SQLite 事务 266.57ms，超过原 250ms 判据。94 个切片
  各处理 1000 行、各 4 条语句；同任务语句最大 261.39ms，事务均值 12.33ms，去掉最大样本后
  为 9.60ms。旧两个正常 run 的相同算法最大为 16.01/37.28ms，未发现第四批改动此算法。
  Worker 只保留 wall histogram，缺少该样本的 SQL/CPU/切片关联，不能据此宣布环境抖动或通过。
  原负载与阈值保持；不能把 Ubuntu 或目标用例通过当作整仓全绿。
- 独立功能实现门确认公共来源终止流程和持久化装配无 findings；统一 TypeScript 检查通过。
  全量本地门禁与本地 PG 未运行。全量行为迁移、641 行终止 atom 及其它真实孪生、原 P95 条款
  仍未闭合，RFC 状态保持 In Progress。

### W12 第六批：目录完整装配、提交回执与需求写回原子化

- 三个入口共用 `composeClassicCatalogs`，原 PG 工厂 30 行成员体逐字保留；两个 SQLite
  入口改用同一完整 bundle，保持原 appHome、runtimeRegistry getter 与 restoreMembership。
  构造期零 SQL/零目录创建，以及技能文件、agent 引用、workflow 规范化和重建读取接入双引擎；
  SQLite 相关 21 pass / 123 expect。provider 命名账本 63 → 62，不把残余资源包算法销账。
- resource-package 读装配共用一个工厂，PG mutation session 的原构造表达式逐字保持。
  新的真实 multipart preview→commit→DB/FS→重建后 replay 用例照出 PG 已持久化回执字段
  `operationId` 未映射 HTTP 所需 `opId`，提交已经成功却回 HTTP 500。回执文档统一映射，
  持久化格式、SQLite wire 及七条资源变更分支保持；旧值回归先红，SQLite 定向 5 pass / 170 expect。
- 上传需求写回不再分开插入快照、忽略 mission CAS：新增 `commitRequirementCells`，同一
  DatabaseSession 事务锁定聚合、重读当前快照、合并、插入及更新引用。原 epoch 固定，失败
  回滚整笔；8 次真实 peer readiness 竞争、并发八路合并与外层回滚回归通过，30 pass / 208 expect。
  这修复已复现的丢引用链，仍不把它当作第四批上传 journey 现场的唯一原因。
- 两侧 intent apply、maintenance 命令/查询根被真实 DB/FS 用例调用，锁住 prepared 屏障、
  幂等回执、活动集合、重建恢复、清理及提交后文件缺失的 roll-forward。SQLite 3 pass / 28 expect。
  加上 classic/resource-package 真实根，未构造根账本 14 → 4；尚余 collaboration 两根、PG realtime
  与 digital-employee 执行根。账本归因按实际调用，不把源码引用算成构造。
- 12 个 RFC310/memory 套件的 63 个数据库行为迁入双引擎，44 个纯函数/源码例仍单跑，
  一条 SQLite 孤儿外键机制例原样保留。原 108 个展开用例、333 处 matcher/expected AST 保持；
  SQLite 108 pass / 354 expect。17 个实际 SQLite 构造点降为 1，T19f 文件账本 866 → 855。
  受版本控制的候选 AST：1888 个测试文件，774 文件 / 1809 次实际 SQLite 构造、189 个 harness
  文件；仍有 770 个直接造 SQLite 的文件没有 harness，不能据此宣称全量行为对拍完成。
- 维护 Worker 增补慢片诊断，记录真实 job/run/slice/attempt、最慢 SQL 模板的 wall/process CPU
  和该片事务最大耗时；只保留一条有界模板，诊断 sink 失败不影响结果。原 250ms 判据、直方图、
  负载与完成协议保持。两个 SQLite observer 机制回归在旧函数上红，定向 30 pass / 171 expect。
  单测没有证明第四批 266.57ms 的性能失败已修复，后续 hosted soak 仍须取证。
- 第五批 `bd697712e` / CI `34170222964` 的全部 backend 分片及真 PG 专项通过，整 run
  仍为 failure：Windows shard 1 / job `101889467330` 的 inline clarify session resume，
  预期两次调用的 session 日志实际多出一条空值，两次尝试均失败。正在追踪实际调用来源，
  不放宽顺序断言，也不靠重跑宣称通过。本批 full CI 与 PG/Windows 结论待精确提交取证。
- 本批候选统一 TypeScript 检查、定向 SQLite/lint/format 验证；共享树内第七批新增终止测试会
  使 T19d 读到额外一条双方引用，其内容未进入本批提交，不为其提前改写本批账本。
  完整本地门禁、本地 PG/soak/E2E 未启动。AC-1/6/9/11/12 仍有未闭合项，RFC 保持 In Progress。

### W12 第七批：终止事务合一、真实组合根与测试夹具迁移

- 来源终止的 SQLite/PG `applyOne` 共 641 行退役，两侧共用 `sourceTerminationTarget` 与
  普通任务生命周期的物理 writer，4 个生产文件合计净减 394 行。每目标事务原子提交 CAS、
  围栏、节点取消、owner 撤销、intent 终态及事件；失败整笔回滚。旧提交后发布/停止位置、
  等待释放位于 review lock 外，以及 SQLite 无 driver 收尾均保留。原 W8 功能回归
  19 pass / 53 expect；新 atom 15 pass / 103 expect，两个 CAS 分支变异确实红。
- 明确修复 clear-closed 重放：没有本地 token 的活动 owner 不再使纯解除围栏回执变为
  unreaped。原实现回归先红，修复后首用/重放均 not-required，任务/节点/owner/intent 均不动。
  同事务真实写入终态赢家后的 CAS miss 按赢家元数据出收据，不虚构 canceled lifecycle 事件；
  fence-only CAS 冲突带走同事务内已写入的赢家及事件。两者是事务内分支验证，外部 PG 并发
  仍由原 W8 对拍证明，不混作同一种证据。旧已裁决 CAS 机制差异销账，保留共同 atom 源码锁。
- 两个 collaboration 根通过真实 command context 执行正文/版本/评论读写、问题生命周期、
  澄清草稿重入回滚与封存；realtime 两根回放真实持久事件并核验顺序、游标和后续插入。
  SQLite 9 pass / 46 expect。数字员工 workflow/agent 均经完整 provider 工厂和真实 mock-opencode
  子进程跑到 done，核验输出、owner 释放、intent 完成和重建后计量，2 pass / 44 expect。
  工作区准备使用带真实目录的测试端口，不宣称覆盖生产工作区准备。未构造根 4 → 0，空账本
  仍保留独立正负 fixture，不以构造覆盖冒充全量业务覆盖；真 PG 结果等待本批 hosted CI。
- PR2 的 3 个与 PR3 的 13 个既有行为套件迁入双引擎。分别保留原 17/76 个 case 声明与
  80/433 处 expected matcher AST；SQLite PR2 17 pass / 80 expect，PR3 非外部部分
  75 pass / 448 expect。外部澄清在旧 baseline 即因本机 port 0 setup 失败，交 hosted CI，
  不放宽超时。Pr3 默认 SQLite fixture 运行时逐字不变，显式中立 DB 注入保持精确类型；
  原有独立双 fixture 用例未合并数据库。T19f 855 → 854，只移除实际消失的 Pr2 helper 构造点。
  候选 AST 为 1893 个测试文件，774 文件 / 1809 次直接 SQLite 构造，209 文件调用 harness；
  这些迁移通过共享 fixture 进入真 PG，不会凭空降低测试文件内直接构造计数。
- 第五批 Windows inline session 日志多出空行的机制已由真子进程复现：后台蒸馏调用同一
  mock 会写入全局 session 日志。新增可选的精确 agent scope，E2E 只记录目标 designer，
  argv 仍记录全部调用；旧未设 scope 的行为保持。第三次 designer 仍会使原两次调用断言红，
  没有过滤空行或去重。旧机制 3 fail，新 6 pass / 32 expect；CI 旧 trace 缺 argv 日志，
  不能证明现场第三次调用的身份，失败附件已补日志供后续定位，Windows 最终结果待本批 CI。
- 第六批 `203c1da42` / Main CI `34172144340` 终态 failure：三条旧目录装配源码锁与
  macOS shard 3 的终态词汇扫描 6063.89ms 超过 5000ms。本批装配锁追到真实公共工厂，
  保留禁止重复实现的约束；词汇扫描仅加保守预筛，1786 → 80 个 AST，全部命中与顺序相同，
  Unicode 变异仍红，原分类与超时阈值不变。原上传 file-only/body+file journey 本次均 pass。
  真 PG 专项及其余三个 backend 分片通过；不能将这些局部结果记为整仓全绿。
- 同一第六批维护大样本 `34172144324` / job `101894355468` success：94 笔显式事务
  最大 16.5ms，API/WS 错误为 0，原负载和 250ms 阈值保持。本次无慢片阈值命中，仍不能
  反推第四批 266.57ms 的唯一原因。第七批全量本地门禁、本地 PG/soak/E2E 未启动；
  统一 backend/system-mocks 类型、定向 SQLite/lint/format 验证，最终 CI 按新提交取证。
  真实资源目录孪生、全量行为覆盖、11 处原始装配命中和原 P95 判据仍未闭合，RFC 仍 In Progress。

### W12 第八批：插件写入与工作流投影合一、独立多库夹具

- 插件插入、generation publication 与完整 16 列捕获行 CAS 共用 `pluginPersistence`，
  插入 SQL 3 → 1、更新 4 → 2（独立 rename 保留）、捕获行谓词 3 → 1。七个生产文件净减
  44 行；四条 legacy 提交链及四个装配转发全部 await，仍借用原外层事务。时间捕获、错误、
  文件安装与 journal 顺序保持。真实资源包 create/overwrite/重建 replay、缺行/旧值拒绝、
  可空字段、metadata-only 与整笔回滚接入双引擎；SQLite 17 pass / 48 expect。
- workflow 的 legacy 行解码、详情/草稿/修订投影转用公共实现，两个生产文件净减 63 行。
  legacy 先迁移再 hash 与中立 raw hash 的既有输入阶段差异保留；不改普通保存算法。
  真库 v1–v6 行、非空 v5 图、完整字段与 422 错误、hash 顺序、保存/重放/旧版本/外层回滚
  在旧/新实现上均 14 pass / 121 expect，两个运行时变异会红，PG 动态结论待本批 CI。
- 再迁 6 个既有功能套件：mission driver、requirement materialize、maintenance run store、
  idle-timeout persistence、Event Center 以及 webhook 顺序矩阵。前两组保留原 10/34 个
  case 声明与 62/162 处 expected AST，SQLite 12 pass / 70 expect、34 pass / 169 expect；
  webhook 原两条 case 与 10 处业务断言保留，两次 runOrder 继续使用两份独立数据库。
- `describeEachProvider` 增加显式 `databaseCount` 与 `database(index)`。默认第 0 库保持
  原端口与初始化；附加库在 setup 内按同一迁移/种子流程创建，每例分别重置，清理等待初始化
  收束，再关闭附库并只删除本次创建的精确库名，主库最后关闭。新多库 setup/cleanup 有独立
  预算，不改原单库 hook 或业务用例超时。测试专用 DDL 端口走所属真库的 native/raw 连接。
  原 8 pass / 27 expect，新 16 pass / 90 expect；同主键独立行、双向回滚、记录器/计划归属
  均有实证。CREATE→EXPLAIN→DROP 在旧 helper 上暴露 SQLITE_LOCKED，finally finalize
  修复后通过；仍保留无法解释时返回空串的契约。未启动本地 PostgreSQL 服务。
- 第七批 `082e1ea27` / Main CI `34174212983` 终态 failure，32/36 job success：三个
  backend 红 job 归为两处测试问题。旧非状态写入快照仍计两宿主 4+2 次，现已按真实公共
  writeFence 改为 1；状态 writer 清单及其他 14 项不变。来源终止 SQL 顺序扫描遗漏 PG 的
  schema 限定表名，真实 SQL 编译复现后修扫描器，保留 snapshot→winner→fence 与回滚判据，
  新增两形正反例；SQLite 35 pass / 165 expect。真 PG 专项及全部 E2E job 已过，Windows
  原 inline session 失败场景也过；不能把这些局部通过记成整仓全绿。
- 同 SHA 的 `windows-platform` / `34174213022` 失败于 7 条默认 PG 缺库判据：该原生
  Windows lane 无 PG 服务。仅该 lane 显式选择 SQLite，并将守卫的例外收成精确两个位置；
  Ubuntu 真 PG 服务、双引擎默认与缺库即红不变。`integration-opencode` / `34174212974`
  和 `visual-regression-nightly` / `34174212984` 均 success；本批最终状态仍待新 SHA 取证。
- 对剩余 11 个原始装配文本命中逐个追踪：4 个对象/请求登记检查、4 个 collaboration 能力
  类型缺口、2 个同一 task runtime 可选输入检查、1 个动态引擎条件检查；191 个组合源中
  结构式 holder 为 0。本次未发现这些命中对应漏装的生产功能，仍需收紧完整能力契约，
  不改错误码消账，也不据此声明整个 AC-12 完成。
- 本批 T19f 854 → 851，实际删除 30 次直接 SQLite 构造。候选 AST 为 1895 个测试文件，
  771 文件 / 1779 次直接构造、767 个直接构造文件没有 harness；harness 文件 209 → 217。
  入口扫描因新增公共 publish atom 为 1727 → 1728（原业务入口保留委托），实际插件写 SQL
  已减少；具名生产符号 24926 → 24921，不能把两个指标当成同一种实现数量。
  统一 backend 类型检查通过；新 harness 接入后的七个业务文件合跑 77 pass / 408 expect，
  架构/元数据定向 128 pass / 296 expect，CI 范围内的改动文件 lint/format 通过。
  没有启动全量本地门禁、PG、soak 或 E2E。
  真实跨目录/内联重复实现、全量行为覆盖、原 P95 判据及最终 exact-SHA CI 仍未闭合。

### W12 第九批：MCP 写入合一、驱动构造契约与 27 套件迁移

- MCP 插入和更新转入公共 `mcpPersistence`：三处插入合为一处，四处更新合为两处，
  仓库独立 rename 保留；八个生产文件净减 39 行。公开/legacy 路径保留先检查后按 id 更新，
  PG 资源包保持原 12 列捕获行 CAS，两种已存在的匹配合同用闭合输入类型表达。
  四条 legacy 提交及四个转发全部 await，旧会话失效副本退役，仍用同一外层事务；
  时间捕获、部分字段更新、错误和资源包回执保持。新增真实仓库/资源包重放、会话状态与版本、
  缺行/旧值、可空元数据、完整回滚和事务内写失败对拍；SQLite 39 pass / 95 expect。
- 生产 `BoundRunTaskOptions` 与 SQLite runtime participant 构造必需 identityAccess，
  原外层 `RunTaskOptions` 仍允许省略。两个实际消费者删除不可能的缺依赖判空；真实启动根
  原本就给齐，不新增运行流程。旧类型上三处负例报错，收紧后通过；正常驱动、子任务与
  resume 仍回同一个已持有依赖的 participant。独立构造/传参复核通过，原始装配命中 11 → 9；
  四个对象/请求登记检查、四个协作能力合同与一处动态引擎条件继续保留，不据文本计数宣告完成。
- 27 个现有测试文件迁入双引擎 harness：生命周期/恢复/预算 10、反馈/详情/意图/播种 8、
  评审文档与 worker/persistence 9。原后 SQLite 分别 100/40/28 pass，合计 168 pass /
  502 expect；139 个数据库用例参数化，29 个纯/源码/SQL 渲染用例保持单跑。
  原 case 与预期 AST、业务夹具值、独立数据库和超时保持；两组独立交叉复核未发现功能缺口。
  40 次实际 SQLite 构造退役，W12 已迁套件 64 → 91；T19f 851 → 824。
- 第八批 `461f299f4` / Main CI `34176215200` 终态 failure，31/36 job success：
  插件共享 SQL 搬迁使两个源码写入位置快照过期，按真实调用→公共 atom 更新；其他判据不变。
  插件新夹具把 tx 当作根客户端重建仓库，未命中既有客户端事务帧，在 PG savepoint 内重复
  设置隔离级别；修为复用原客户端写入、由 tx 观察未提交行。同形 MCP 新夹具同步修正。
  workflow 新夹具在外层事务内通过根连接池读到旧已提交行，改由 tx 读回。三处均仅改测试，
  不修改事务原语或普通保存算法，原 abort/版本/时戳/最终整行回滚预期保持；修后 PG 待本批 CI。
- 同一第八批 SHA 的真 PG 专项 `101906019767`、全部十个 Playwright E2E job 与三平台
  binary smoke 通过；`windows-platform` / `34176215206` success。Ubuntu shard 2 的
  真实多库 harness 12 条 PG 数据库用例全部通过，含独立同主键、跨库回滚和记录器/EXPLAIN
  所属库验证；这些局部结果不能记作整仓全绿。
- 候选 AST 为 1896 个测试文件：744 文件 / 1739 次直接构造，740 个直接构造文件没有
  harness，harness 文件 217 → 245。具名符号因两个闭合类型与两个 atom 替代旧两函数为
  24921 → 24923；实际 SQL 和生产行数下降。新增构造类型检查使 SQLite runtime 引用数
  9 → 10，实际驱动文件数仍 3，PG 仍 5/1，T19d 如实记账，不冒充新增动态覆盖。
  统一 backend TypeScript 检查通过；canonical/元数据六文件 125 pass / 289 expect，
  相关 RFC 结构守卫通过，候选 TS lint/format 通过。MCP 新完整行预期补齐七个夹具已知字段后
  类型检查通过，没有类型断言逃口；生产实现未因测试类型问题改变。
  全量本地门禁、PG 服务、soak 与 E2E 未启动，最终整仓结果仍由发布后的 exact-SHA CI 判断。
  实际剩余孪生、全量行为覆盖、协作能力类型与原 P95 判据未闭合，RFC 保持 In Progress。

### W12 第十批：协作能力合同、Agent 解码合一与评审夹具对齐

- `CollaborationCommandContext` 按工厂输入保留实际具备的四类能力；完整路由根要求四者齐备，
  窄消费者只要求自己调用的端口。可选、联合与显式 undefined 输入不能升级成完整合同。
  三个工厂保留原 WeakMap、对象身份、诊断及方法，15 个生产文件转译 JS 逐字不变。
  五个旧注入夹具补齐同库真实端口，构造不启动 worker 或执行命令；没有借默认根绕开原实例。
  34 个类型负例与统一 backend tsc 通过；三条既有决定用例经公开合同执行，原断言保持，
  定向 SQLite 14 pass / 145 expect。四条能力诊断保留，原始占位文本计数仍为 9。
- Agent 行解码共用实际字段投影与 sidecar 算法，两个原入口保留各自 JSON 容错、数组处理、
  NULL 错误顺序和字段省略约定；闭合 profile 表达既有数据格式差异，不增加 provider 分支。
  两个生产文件 1743 → 1596 行，实际净减 147；所有写入/时钟/CAS/prepare/commit/回执声明
  AST 不变。42 条真库场景在旧实现已通过，提取后加重复实现结构锁；连原邻域共 SQLite
  64 pass / 219 expect，另 422 次旧新算法的值及错误对照一致，PG 以本批 CI 为准。
- 任务详情/列表读取链 5 处参数类型改为既有中立客户端，整个服务运行 AST 不变。两个名称
  投影套件原后 11 pass / 21 expect；此前同夹具在旧类型上 12 处诊断，收紧后清零。
  再迁 15 个评审、问题、队列、会话与恢复套件，原后 95 pass / 312 expect；307 处预期 AST、
  全部 case/超时和 14 个纯场景保持，事务内观察使用 tx。独立交叉复核未发现功能缺口。
  两组合计 17 个旧套件、92 个数据库用例进入双引擎，W12 已迁 91 → 108 套件。
- 第九批 `9e3b41fd5` / Main CI `34178367611` 终态 failure，33/36 job success；真 PG
  专项、四个 macOS backend 分片、Ubuntu 2/3、全部十个 E2E 分片与三平台 binary job 通过。
  两个 backend 红 job 共 8 条失败：7 条是三份旧评审 raw insert 夹具依赖 SQLite 0210
  触发器自动填 lineage，PG 初始行为 NULL。本批显式写入旧 SQLite 已生成的根 ID 与 JSON，
  保持原字段顺序及 raw bytes，继续经原决定/续跑链验证；生产 canonical 校验不变。
  三套件原后 SQLite 均 13 pass，110 → 123 expect 只增加起点见证，原 78 处 matcher AST 保持。
  MCP 故障注入原断言只看最外层错误，PG 的 Drizzle 包装遮住驱动错误；仅在该断言前解开
  Error.cause，原故障文案及两份完整回滚预期不变。SQLite 原后 1 pass / 3 expect。
  上批插件/MCP 外层事务、workflow tx 读回与两个旧源码锁失败均已在第九批消失。
- T19f 824 → 807，直接 SQLite 构造减少 78 次。候选 AST 为 1898 个测试文件，727 文件 /
  1661 次直接构造，723 个直接构造文件没有 harness；harness 文件 245 → 264。
  T19d 两侧任务路由各新增一条 type import，ref 7/9 → 8/10，drive 仍各 2；不冒充动态覆盖。
  canonical 入口 1728、事务回调 272 不变；装配类型 import 5279 → 5282，符号 24923 →
  24930，增长仅来自公开/内部能力类型与既有算法拆分，运行依赖没有增加。六个元数据套件
  125 pass / 289 expect；定向 lint/format 与类型检查通过。没有启动全量本地门禁、PG 服务、
  soak 或 E2E，最终整仓证据等待本批 exact-SHA hosted CI。
- AC-11 的原 P95 判据未改。第八批同一 Ubuntu 2 job 的 overview 为 SQLite 2.65ms /
  PG 11.69ms，且现有性能用例两侧都调用旧 `buildOverview`，未覆盖 PG daemon 实际使用的
  `composeSystemOverviewQuery` 装配链。500 行/9 样本的 P95 是该组最大值，也不是完整
  RFC-311 性能基线。本批只更正误称结构指标已完成性能验收的注释，执行 AST、断言与阈值均不变。
  真正剩余重复实现、全量行为覆盖、生产 overview 性能证据与原 P95 条款仍未闭合，RFC 保持 In Progress。

### W12 第十一批：事件装配、行为迁移与实际 Overview 查询取证

- `committedEventHarness` 的 cutover 写入、两个安装入口及全部 12 个旧调用文件形成完整 await 链；
  原 pump/dispatcher 参数、返回句柄、清理顺序与消费者保持。九个未迁移的调用文件只改异步接线，
  独立运行 AST 比较确认差异仅为 async/await；不把这些文件计作双引擎迁移。
- 23 个旧行为套件迁入 harness：恢复/查询 11 个、澄清 9 个、事件投影依赖 3 个。保留 106 个
  本地范围内的原功能用例与 332 次原动态期望，候选 106 pass / 357 expect（新增 25 次同库起点见证）。
  其中 105 个数据库场景按 provider 运行、1 个源码场景单跑；另 4 个纯场景原样保留，未重复执行。
  恢复夹具使用真实 provider persistence，原服务与实际被调查询保持。没有把旧物理 SQLite helper
  仅靠类型断言包装成中立 helper；memoryDistill 与 clarify-fixtures 两个 helper 的运行 JS 字节不变。
- 实际旧 SQLite 行对照保留 task 根 lineage 与原 JSON 字节/hash。11 套件另核验 118 对实际起点
  （57 task / 61 node-run）全字段相同。0224 已删除 node-run 插入触发器，直接 run seed 仍保持 NULL；
  不能只看 0210 的历史 SQL 给夹具凭空补值。review refresh 的原故障点在两个引擎用真实 trigger
  注入，原错误文本及回滚/重试期望保持，PostgreSQL 执行结果待本批 hosted CI。
- 全树 AST 清点：1898 个测试文件，704 文件 / 1572 次直接 SQLite 构库（本批减 23 文件 / 89 调用），
  700 个含构库文件无 harness、287 个文件调用 harness；W12 已迁旧套件 108 → 131。
  T19f 精确文件账本 807 → 784。机制专属测试仍在分母内，不能把这一清点当作业务遗漏的精确数量。
- Overview 的 RFC-311 性能守卫及 T26 计划审计均接实际生产查询：SQLite 保留 buildOverview，PG
  以同库的五组真实 owner 端口执行 composeSystemOverviewQuery。新增独立非空语料与变更后重读，
  防止只量空库或错误根；原 8 条性能路径、7 条计划路径及阈值/采样量保持。SQLite 两文件 17 pass /
  80 expect，真实 PG 查询、EXPLAIN 与 P95 仍待 hosted；这里不包含 HTTP daemon 开销。
- 第十批 `e613c252c` / Main CI `34180742753` 终态 failure：29/36 job success。三条类型/架构
  账本失败各在两个 OS 出现，另有两个 PG review-multidoc 并发用例失败；真 PG 专项、全部 10 个
  E2E 与三个 binary job 通过。维护 soak `34180742732` 和 Git 协议 `34180742743` 同 SHA 成功。
  不能把这些子任务通过记作 Main 全绿。
- 第十批 AC-11 诊断仍未达原条款：同 job `101919180351` 的八条 PG P95 均高于 SQLite，
  比值 1.5–10.6×；overview 3.51ms / 2.34ms 当时仍量 legacy 算法，不作为实际 PG 根的证据。
  原 P95 判据保持，不能以本批改正确测量入口代替性能达标。
- 三条类型/架构失败按真实合同修正：能力 discriminator 留在模块内部；providerRuntime 只按自己
  实际消费的 reads 能力约束并原样透传调用方类型，启动根继续显式要求四能力。没有新增 DAG 例外，
  四个生产文件运行 JS 字节不变；原 34 个类型负例保持，新增完整/窄/联合/可选输入透传证明。
- 两个 review-multidoc 并发夹具通过真实写屏障与任务队列建立预定赢家，再发出另一服务请求；
  两个 Promise 在释放前同时在途。原测试误用数组顺序推断异步 scope 查询完成顺序，PG 不保证该顺序。
  原结果、失败码、输出及审计选择断言全部保留，SQLite 9 pass / 88 expect（原 82 + 6 并发见证）；
  PostgreSQL 屏障执行仍待 hosted，不将同机 SQLite 通过等同于真 PG 修复证明。
- 当前候选完整 backend tsc、45 个核心文件 lint/格式、父事件调用链的类型感知 Promise 检查及
  T19b/d/f 定向守卫通过。架构与导出/依赖检查的 139 项中，首次只有两个生成工件摘要过期；按当前
  内容刷新 provenance 后定向复验通过，其他原通过项沿用相同候选内容。没有放松守卫或跑全量本地门。
  canonical 维持 1728 入口 / 272 事务；导入 5281、例外 4749、public surface 983、符号 24932。
- 本批继续保持 In Progress；未运行本地 PostgreSQL、daemon、soak 或 E2E。真实重复实现、
  全量行为参数化与原 P95 判据仍须继续完成，最终整仓结论仍待包含本批的 exact-SHA hosted CI。

### W12 第十二批：Agent 写入字段合一、20 套件迁移与持久化归位

- Agent 的三个完整写入投影共用 `agentContentPersistenceValues`，12 字段映射由三份降为一份，
  删除 24 项重复映射，生产净减 8 行。中立完整创建/更新与 legacy 创建保留原事务、时间采样和
  字段求值顺序；原输入与已解析引用分别传入，避免对象展开提前读取 getter。legacy 显式空数组、
  中立省略空 sidecar、legacy 稀疏补丁三种合同保持，未把整对 Agent 写入或同步面销账。
- 字段差分 942 组、legacy 原 values 求值顺序 9 组全部一致；输入展开变异准确报红。新真库用例
  在原 writer 上先通过，候选连同原 codec/写入回归 79 pass / 246 expect，另三个原 intent 写入例
  前后均 3 pass / 12 expect。新增 10 个数据库场景按 provider 执行，三个纯字段/接线场景单跑；
  所有事务内观察使用 tx，外层回滚完成后才从 root 查回，真实 PG 等本批 hosted CI。
- 20 个旧功能套件迁入 harness：恢复/输出 8 个、问题/派发 9 个、运行时/数字员工 3 个。
  原 156 个静态 case 声明（158 个展开用例）与 596 个 matcher AST 保留；134 个 DB 声明按 provider
  执行、22 个纯用例单跑。同用例的两库保持为两份独立真库；源码 case 的 helper 仍在它的作用域。
  原测试名称、超时和被测服务入口保持，没有用另一个中立查询替代原生产入口。
- 恢复/输出旧新均 50 pass / 112 expect，43 个 task 与 51 个 node-run 实际起点行逐字段一致；
  数字员工/运行时旧新均 15 pass / 320 expect，36 处数据库终端调用补齐 await，非空访问时序保持。
  原 30 秒完整案件生命周期用例及五个纯用例保持；任务根 lineage 保留旧触发器的原 JSON 字节，
  直接 node-run seed 不新增已退役触发器的值。问题/派发旧新均 93 pass / 276 expect，264 对实际
  起点（82 task / 182 node-run）无差异；同 case 两库的独立客户端、库 0 已写而库 1 仍空也已实测。
  三组合计 158 pass / 708 expect，与全部旧动态期望一致。
- 汇总类型检查发现 Event Center 的 `ComposeEventCenterOptions.db` 仍限制为 `DbClient`，
  尽管四个实际存储早已接收中立句柄。本批只修正类型与 type import，运行 JS 字节不变；
  保留原 `composeEventCenter` 被测入口，不用断言或改调用另一工厂绕开。修后完整 backend tsc 通过。
- 全树 AST：1899 个测试文件，684 文件 / 1454 次实际 SQLite 构库，680 个含构库文件无 harness，
  308 个文件调用 harness。W12 已迁旧套件 131 → 151，本批移除 118 处直接构库；T19f 精确文件账本
  784 → 764。机制专属测试仍计入存量，不能将全树扫描数直接当作业务缺口数。
- PostgreSQL 重试策略从 `db/` 移入 `platform/persistence/`，策略文件逐字不变，四个生产 import
  都指向同一个新位置；七个原策略用例保持，连同 T17 定向 11 pass / 30 expect。provider 命名文件
  62 → 61，这是一项机制归位，不是重复实现合一，不改变重试分类、退避或预算。
- 第十一批 `0f327a7bc` / Main CI `34183590165` 终态 failure，33/36 job success；只有同一个
  collaboration 字符串联合中间别名的类型声明问题分别出现在 Ubuntu/macOS shard 1，汇总随之失败。
  真 PG 专项、其余六个后端分片、全部十个 E2E、三个 binary job 通过。该轮 review-multidoc 的
  两个真 PG 并发例及实际 PG Overview 查询已通过；不能把这些子任务通过记作 Main 全绿。
- 本批删除该冗余字符串联合别名，在两个原使用处内联相同联合。旧别名展开后的完整 AST 与新文件
  相同，运行 JS 字节不变；19 项类型等价、14 个负例证明通过。原 38 个合同负例、四个运行诊断、
  扫描器和债务阈值保持，既有完整构造与可选输入合同未放宽。
- 第十一批同 SHA maintenance soak `34183590148` / job `101927410129` success，control /
  maintenance API P95 为 74.7 / 97.0ms，errors 均 0。AC-11 的八条 500 行诊断仍全部 PG 更慢，
  比值 1.4–2.8×；真实 PG Overview 为 3.50ms，SQLite 1.72ms（job `101927410418`）。
  原始逐端点 P95 条款未达，不因测量接线正确或结构守卫通过而改写。
- 原 RFC-311 完整基准需要同一 hosted runner、相同 100k task / 3M run / 10M event / 100k delivery /
  500 cached-repo 语料和九个真实 HTTP handler 场景。旧 task page URL 已退役，必须登记到当前完整
  task-catalog 的三种请求；保留一次预热、默认 20 样本和原 floor 分位数。后续先合一确定性语料，
  再复用真实 HTTP 装配，独立 full job 严格逐端点比较 PG P95 ≤ SQLite；500 行诊断不能代替验收。
- 最终完整 backend tsc、34 个现存核心 TS 的 lint/格式、受影响生产链的类型感知 Promise 检查通过。
  八份架构/导出/依赖定向文件 139 pass / 310 expect，T19f 三项通过；不降低任何扫描或债务阈值。
  canonical 维持 1728 入口 / 272 事务 / 5281 导入 / 4749 例外 / 983 public surface；符号 24931，
  上批已消费的增长许可已清理。核心冻结文件、三组行为与独立复核证据分别核对。
- 本批继续 In Progress；未运行本地 PostgreSQL、daemon、soak、E2E 或全量门禁。最终整仓结论
  以包含本批的 exact-SHA hosted CI 为准。

### W12 第十三批：原始 HTTP 基准、完整动态工作流合同与真 PG 失败定位

- `06f1b82a3` 已发布并核对远端精确同步。maintenance `34190051222` / job `101946086629` 与
  首次 HTTP small `34190166690` / job `101946430906` 均在脚本装载前失败：根目录的 perf-seed
  新导入 `drizzle-orm`，但依赖仅在 backend 声明，Bun 1.4 干净 workspace 安装无法解析。
  后继修正只给根 package/lock 补同一既有 `^0.45.2` 开发依赖，不改任何行算法或测量规则；
  冻结锁 dry-run 通过，原 native CLI 微型库实得 7 repo / 23 task / 115 run / 361 event /
  11 delivery（共 517 行）。两次失败均未进入 HTTP，不能算 P95 结果或完整验收。
- 第十二批 `608d1b012` / Main CI `34186397795` 终态 failure，34/36 job success；
  只有 Ubuntu shard 4 与汇总失败。20 个迁移套件的 136 个 PostgreSQL 行为用例全部通过，
  Agent 新增 10 个真 PG 写入用例也通过，但 RFC139 套件的 afterAll 清理失败，不能将套件记绿。
  本批之前的 collaboration 类型声明红已消失；独立 PG job、其余七个后端分片、全部十个 E2E、
  三个平台 binary 与完整类型/格式检查通过。同 SHA maintenance soak `34186397848` 成功，
  control / maintenance API P95 43.9 / 52.8ms，errors 均 0（job `101935483261`）。
  本批八条 500 行诊断中七条 PG 更慢（1.6–4.2×）；mission 首页为 PG 1.87ms / SQLite 1.95ms，
  实际 Overview 为 PG 3.21ms / SQLite 1.43ms（job `101935483041`），仍不能替代原始完整 HTTP 判据。
- 对原九个装配诊断继续追调用链：四个来自作用域实例查询，四个来自完整协作能力检查，
  唯一还能合法省略的依赖是完整 TaskDrive 的 dynamicWorkflow。本批将 BoundRunTaskOptions 与
  两个 provider participants 输入收为必填，原 RunTaskOptions 兼容面仍可选；三个真实启动根
  本来已传实际同库 bundle，未改它们的运行逻辑。九个诊断全部保持，不能用删除错误消息伪造归零。
  15 个真实类型负例覆盖五种完整入口的省略/可选/undefined 输入；新增真实四类目录实时读与
  完整 driver 的动态确认恢复，原 12 个 case 与 58 个 matcher AST 保持。
- 原 RFC311 五表行算法提成唯一纯生成器。SQLite native CLI 的九条 prepared SQL、九个 exec
  次序、parseArgs/tx AST 和大事务分块保持；905 组边界行、6335 个原绑定表达式与旧源码一致。
  提取前后两份真实 SQLite 库的五表 517 行、全部物理列和顺序逐字一致；新增 async sink 通过
  同一个 session 的实际事务按引擎参数上限分批，新增 receipt 流式核对实际整表，未用前缀过滤藏行。
  原库默认列、任务 lineage 字节、node-run 的原 NULL、重复 events 追加与事务失败回滚均有判据。
  语料测试 SQLite 9 pass / 70 expect；完整 PG 装载与性能仍待 hosted。
- HTTP 复用生产 createComposedApp 的请求外壳，旧函数展开 AST 与其他 25 个原函数均不变；
  完整生产路由覆盖/注册闭合检查留在原入口。专用 benchmark graph 只装被测六域，但每条 GET
  都使用真实 owner，包含实际数字员工第四目录源，未加 type=workflow 过滤缩窄默认查询。
  Overview 的可持有工厂在计时外构造，旧包装展开行为与原结构守卫保持。
  新六个真实 HTTP 行为用例覆盖九场景、两页游标/顺序、非空徽章、写后读与真实员工目录；
  连同旧 Overview 回归 SQLite 23 pass / 1 skip / 144 expect。
- 新 perf-run 在同一 runner 顺序启动独立 provider worker。先在真实 SQLite 迁移后的微型模板
  写一次原 entry，保留 workflow 的数据库时钟默认值，再用原生文件复制与生产逻辑 export/restore
  将同一初始内容送到两库；PG 经过真实 schema finalization、prepareGeneration、activate 与
  assertReady，不手写代际标记。仅模板阶段本地实跑：10 active rows / 6 chunks；不代表 PG 恢复成功。
  两库同源 seed、ANALYZE、全表行数/摘要核对完成后才测 HTTP；计时前后再次核对原五表。
- 九场景保留原一次预热、20 次顺序样本、performance.now 到完整响应消费和 floor(q\*n) 分位数。
  已退役的 tasks/page 显式映射到当前 task-catalog，第二页必须来自实际第一页 cursor。
  结果保留每个原始样本、响应见证、代码/模板/schema 摘要、执行 ID 和实际机器/Bun 信息。
  分页比较另核固定页大小、有序 ID、schemaVersion 与真实游标，两边实际响应工作量一致才能比较。
  比较器逐端点严格判 PG P95 ≤ SQLite，没有倍率、容差、最小毫秒、删样本或其他端点抵扣；
  原 RFC311 绝对预算另列。缺端点/样本/语料、错误摘要/机器/SHA、缩小的 P95 与 0.001ms 单项
  回退均有负例。纯比较/清理回归 30 pass / 77 expect；small/weekly 只能报告诊断，不能关闭 AC11。
- postgresql-evidence 新增独立 HTTP job，保留原兼容性任务默认行为，允许 exact-SHA 只派发
  http-performance。full 使用原 100k task / 3M run / 10M event / 100k delivery / 500 repo。
  两端 HTTP 报告落盘后才各跑一轮原 archive；失败也保留已完成端点的原始样本和报告。
  worker 在业务操作与 native close 同时失败时保留两份原错误，不让清理错误覆盖初始原因。
- Ubuntu R2b 的 5 秒超时现场仍在第 600 组背景数据构造中的 nodeRun INSERT，尚未进入
  getReviewDetail；超时后的 connection closed 是继续执行夹具遇到已清理池的次生错误。
  夹具批量化保持 600 组原行、原时间窗、原三个期望和 5 秒预算；原新各 2 pass / 5 expect，
  1204 行所有字段一致，ID 生成调用顺序保持，实际 INSERT 从 1204 次降至 8 次（4 次原目标写 +
  同一实际事务内 run/version 各两批），最大绑定 6500；不能靠延长查询超时掩盖准备成本。
  RFC139 六个 PG case 已通过，随后 180 秒预算的 afterAll 在 30.004 秒收到 native
  ERR_POSTGRES_IDLE_TIMEOUT；现有日志不足以断言是哪一步。清理链新增三阶段 cause 上下文，
  保持附加库逆序关闭、逆序 DROP、主库关闭以及错误后继续清理；原超时和同 case 两真库不变。
  阶段诊断的旧函数回归 2 pass / 4 fail，新函数连同原 RFC139 SQLite 16 pass / 42 expect。
  具体 native 根因仍等下一次 hosted 阶段证据，不记成已修复。
- canonical 新增被提取的 createHttpRequestApp 与其输入类型：入口 1728 → 1729、符号 24931 → 24933；
  事务272、导入5281、例外4749、public surface983保持。两项增长只对应已有请求壳的复用出口，
  原生产根和外部路由保持；元数据逐项解释，未降低扫描或扩大既有债务豁免。
- 冻结候选完整 backend tsc、各组件严格 lint/format 与受影响生产 Promise 检查通过。11 份
  架构/参数化定向文件首次149 pass / 2 fail：仅 T19d 的 PG participants 类型引用数从5到6；
  按实际类型负例登记该单行变化，drive仍1，扫描/阈值/名单项数保持，修后定向复验通过。
- AST 当前 1903 个测试文件，684 文件 / 1454 次 SQLite 构库，680 个含构库文件无 harness，
  310 个文件调用 harness；W12 已迁旧套件仍为 151，本批新增基准证明不充作旧套件迁移数。
  本批仍 In Progress；未跑本地 PG、daemon、完整语料/性能、soak、E2E 或全量门禁。
  AC11 仍按原条款等待真实 full 证据，整仓结论等待包含本批的 exact-SHA hosted CI。

### W12 第十四批：共享提交与构造、真实执行、历史 P0 与 full 性能证据

- Workgroup 六组规范化/快照/hash/行/修订/详情算法提取为一份 `workgroupPersistence`，
  三个生产文件合计 2132 → 2029 行。旧两侧 720 组输入、8640 次算法对拍一致，49 个其他函数体
  字节与 AST 保持；legacy slice 与中立 spread 的原差异留在入口，包含稀疏数组和自定义行为。
  SQL、writer、CAS、ID/时钟和事务边界保持。新真库/纯函数 conformance 10 pass / 62 expect，
  原 RFC225/D18 定向功能 6 pass / 29 expect；不记作整对 adapter 或 T17 文件退役。
- 10 个原目录/运行时套件迁到真实 provider harness，119 个旧测试声明、281 个 matcher AST、
  全部原 timeout 与写入夹具保持；105 个数据库声明进入 21 个参数化组，14 个纯声明仍只跑一次。
  SQLite 定向原新均 106 pass / 252 expect，其余 14 个原 case 源码保持、未在本地执行。
  `runtimeRegistryPersistence` 的数据库入参中立化，生成的 JavaScript 保持一致。
  W12 旧套件累计 151 → 161；旧套件退役 15 次实际构库，另增 1 次同步机制证明，
  净减 14 次实际构库，T19f 精确文件账本 764 → 755。
- T7e 在真实 workgroup driver 下验证 worker 请求中的反问协议、已持久化 nonce、assignment
  等待状态，以及真实已回答轮次耗尽预算后仍可交付。旧 5 个 case / 25 个 matcher 全保留，
  新旧合计 SQLite 7 pass / 55 expect。受控 host reply 不是实际子模型主动发起反问的证明。
- `scripts/rfc359-p0-mutations.ts` 在每个 provider 执行七阶段：当前控制 → 原 protocol stub →
  原仅看 budget 的许可 → 原 strict lifecycle seal → 原未绑定 dispatcher → 原坏定义删除前解码 → 当前恢复控制。
  P0-5 用真实事务内 lifecycle participant 产生原 `illegal-node-run-transition`，同时验证答案回滚；
  P0-7 用原 holder class，在真实根启动/TaskEngine 链观察持久化的 failed 与原错误消息。
  没有写回或复制生产源码，没有注入伪造的业务异常。SQLite 32 次 case 执行、316 次断言：
  25 pass 与 7 次指定故障 fail，前后控制各 10 pass / 112 expect；17 个依赖文件前后摘要一致。
  新 P0-6 在真实删除事务恢复旧 decoder：两条坏 JSON 用例均得到原 422 workflow-definition-corrupt，
  同仓库正常 create/get/save/replay/stale 控制通过，实际 JSON Parse error: Unexpected EOF 有精确判据。
- 独立 PG CI job 加七阶段双引擎执行和 always 上传原始日志、结果及源码摘要。判定器逐项检查
  provider/用例/断言/错误/完成数，拒绝跳过、setup/import/unhandled、任意 exit 1 与错误断言；
  纯判定测试 9 pass / 53 expect。真实 PG 与 Bun 1.4 变异结果仍待本批 hosted，AC7 不提前销账。
- 依赖修复 `ee82a4988` 的 Main CI `34190806248` 终态 failure：33 success、2 failure、1 cancelled。
  macOS shard4 / job `101948393199` 首先发现上笔移除 consumed growth 后漏刷 ledger 内容摘要，
  当前四份 provenance 全部重新生成，151 项定向架构测试已过。另一个资源包恢复用例在 5013ms
  超时，随后的目录删除与 boot verified=false 是清理后的次生现象；具体耗时链另查，不记为已修。
- 同 SHA HTTP small `34190879364` / job `101948519663` 成功：9 场景各 20 个样本、两库共 360 个，
  实际 5 repo / 1000 task / 30000 run / 100000 event / 1000 delivery。两库计时前后整表行数与摘要、
  同机器/代码/执行 ID 见证一致，comparable=true 且 errors=[]；fullAcceptance 与 acceptancePassed
  都为 false。如下 P95 单位 ms；只有 workgroup pending 的 PG 更快，不能靠它抵扣其他八项。

| 实际 HTTP 场景          | SQLite P95 | PostgreSQL P95 |
| ----------------------- | ---------: | -------------: |
| tasks first             |    19.4517 |       110.3243 |
| tasks second            |     8.5739 |        25.6351 |
| tasks running           |     9.5296 |        14.3023 |
| repositories first      |     2.0116 |         5.4979 |
| repositories referenced |     2.8451 |        92.8212 |
| reviews pending         |     2.5190 |        19.9900 |
| clarifications pending  |     1.3169 |         5.3700 |
| workgroup pending       |    19.0573 |        18.3737 |
| overview                |     2.8731 |         9.2056 |

- 同 SHA full maintenance `34191021514` / job `101948938860` 成功：原始完整语料、50 客户端、
  每阶段 60 秒，control/maintenance API P95 63.5/73.9ms，错误均 0。归档与维护测量的成功
  不替代原 HTTP AC11。原完整 HTTP run `34191588506` / job `101950597356` 终态 failure；
  两库均完成，原 500 repo / 100k task / 3M run / 10M event / 100k delivery 的四份整表见证完全相等，
  同机器、八份源文件摘要、schema/template/执行 ID 均一致，9 场景各 20 样本，共 360 个。
  comparable=true、errors=[]、fullAcceptance=true、acceptancePassed=false：七项 PG 更慢。
  两库各完成后续归档，退出 1 来自严格验收失败，不能称作测量未跑完。full P95（SQLite/PG，ms）：
  tasks first 297.016/331.214、second 227.961/335.581、running 89.431/71.980；
  repos first 5.826/28.156、referenced 5.717/13.868；reviews 1.588/4.286、clarify 1.365/3.160；
  workgroup 147.572/9.277、overview 14.256/21.454。两引擎 tasks 首页/二页均超原150ms绝对预算，
  SQLite workgroup 与两侧 overview 超原10ms预算；保留原条款，继续按实际查询定位。
- 统一类型检查发现旧 Agent create/update 仍是同步写入口，不能仅将测试句柄换为中立类型。
  现将两份原提交体各保留一份，由有序 continuation 同时供旧同步资源包参与者和 awaited API 调用；
  prepare → hook → commit → 事务后读取、原字段与错误顺序保持。既有 opaque 读端口只增加中立
  async 装配，原底层实现不变；同步 void 合同仍立即完成，不能丢弃未结算 Promise。
  原始 SQLite 控制 106 pass / 252 expect，新事务/纯序列/同步机制 9 pass / 36 expect，原字段
  conformance 13 pass / 34 expect。实际 sqlite-proxy 终端及既有 loader 均返回 native Promise，
  延迟 driver-control 证明 continuation 等待完成；这不是本地 PostgreSQL 业务证明。
  `legacy/agent.ts` 两次真实 dbTxSync 退役，同步事务文件账本 8 → 7；同步参与者本身仍保留。
- Workgroup 继续合一四份 member mapper、三份 leader lookup 与两份同义创建投影，9 份实现 → 3 份，
  在前述 codec 提取之上再净删 63 行；两刀合计净删 166 行。1525 次旧源码表达式/新体差分相等，
  82 个其他函数体、20 个调用点 AST 保持，两个 INSERT 展开后整个函数 AST 相同。
  新 6 个真实数据库 case 原/新均 6 pass / 55 expect；连同纯构造、原功能与 writer inventory，
  27 pass / 169 expect。两个 nullable 测试查询显式校验存在性，预期可选成员对应物理 NULL。
- Legacy mission 两个新 case 通过真实发布规则与 `launchMission → automation.drive` 调用实际
  agent/script launcher、TaskEngine、子进程和原 terminal observer。attempt 引用落库后才释放子进程，
  真实输出、validated attempt、settled actionRun、owner released、无第二个 task/actionRun 均有断言。
  测试发布规则使用既有 `action.lastOutcome = none`，保证此夹具只执行一次；未修改生产策略语义。
  原 17 个控制 + 新 2 个真实执行 case 为 19 pass / 232 expect；helper 默认 await-settle 展开 AST
  与原相同。最终 mission 保留原 no-change 阻塞语义，不宣称任务完成交付；真 PG 待 hosted。
- Full 七项回退后增加独立 query-profile worker，严格在两份 HTTP 报告及 comparison 已保存后运行，
  随后才归档。每个原实际路径（含实际第二页 cursor）只额外请求一次，记录真实 SQL/绑定/返回行数、
  wall/CPU 与执行计划；SQLite 用原生 EXPLAIN QUERY PLAN，PG 在只读事务取 ANALYZE/BUFFERS JSON。
  同 SQL 与绑定的计划去重，整表回执再次核对未改变；诊断失败有原错误，不能写入或替换 P95 样本。
  新诊断/旧比较器定向 36 pass / 113 expect，含微型真实九端点 HTTP 与 native SQLite 计划。
  native query 经 prepare 与原慢语句 Proxy 时只计一次，stop 后原缓存 statement 也停止记录。
- 资源包恢复的旧超时窗口已由持久化 ID 的时间与日志缩到 claim→stage→commit：约 4957ms，
  stage 后到预期 pre-tail 故障约 3994ms；12 个直接链路文件在第十三批前后逐字相同。
  原测试在既有 seed/apply/fault/converge 边界加累计 wall/CPU，原 5000ms、四个 case 与断言保持；
  该 case 定向 1 pass / 7 expect。尚无 hosted 阶段 CPU 证据，不能将超时裁为环境抖动或已修复。
- 最终 canonical 为入口1731、事务272、导入5283、例外4751、public983、符号24941。
  入口新增两份共享 Agent 提交体；导入/例外净加2来自共享 Workgroup 与中立类型的五进三出，
  符号23进15出净加8，逐项在原账本解释，没有调整扫描或豁免。四份内容摘要已更新；
  完整 backend tsc 与 12 份定向架构文件 154 pass / 339 expect 通过。
- AST 当前 1909 个测试文件，675 文件 / 1440 次 SQLite 构库，670 个含构库文件无 harness，
  324 个文件调用 harness。机制专属文件仍在扫描中，不能直接将该总数当作全部业务缺口。
  RFC 仍 In Progress；全量旧行为、剩余跨目录孪生、完整 P0/能力合同、严格 full P95 与最终 CI 待完成。

### W12 第十五批：归档与工作流合一、运行时旧套件和 PG 实链修正

- 11 个原运行时套件迁到双引擎 harness：96 个旧声明、281 个 matcher 的期望值与原 timeout 保持，
  78 个实际数据库 case 参数化、26 个纯逻辑 case 单跑，另保留 1 个原生 SQLite 同步异常用例。
  六组真实旧/新 task seed 全字段一致，node-run 原 NULL 保留；有序读回显式按 id 保持原期望顺序。
  构库 19 → 1，SQLite 105 pass / 358 expect。node-run 操作和 runtime composition 只改数据库类型，
  两份生产 JavaScript 完全相同；插件测试 binding 的同类参数同步中立化，原函数体不变。
- 两套归档 store 的 12 个查询和两个 watermark 委托合成一份 `eventsArchiveStore`；三个维护键值
  函数原样移到中立位置，旧 SQLite 路径保留导出。原 PG 查询 AST、数值解码、19 个其他原函数体
  保持；文件追加、游标、事务、预算与归档顺序不变。五份生产文件总计 1071 → 963 行，净删 108。
  原 archive 14 例与 scale 6 例参数化，原 56/28 断言、timeout、全部 seed 算法不变。
  新真实稀疏 ID、NULL、Unicode、聚合与限定删除对拍在原代码和共享体均 2 pass / 33 expect；
  原/new archive 小样本合计 16 pass / 89 expect，另两个小窗口/源码用例 2 pass / 9 expect。
  原 40000/36000/5000/1000 规模用例保持，未在本地运行，交给 hosted；不能冒称全 scale 已验绿。
  这两旧套件再退役 6 次构库，W12 旧套件累计 161 → 174；T19f 精确文件账本 755 → 743。
- Workflow 的引用投影、缺失 Agent 校验、改名校验及宽松定义解码继续复用已有共享体，
  五份生产文件 5382 → 5348 行，净删 34；67 个其他原函数体字节/AST 保持，1274 次表达式
  差分一致（含 100 次 getter 顺序）。原 PG intent 的输入顺序和 no-op 处理保留，不能统一为
  另一路的排序或 canonicalization。新/旧定向控制 39 pass / 262 expect；同目录9对/T17不变。
- 上批 `7a19e5744` 的 Main CI `34196252484` 终态 failure：31 success / 4 failure / 1 cancelled。
  Ubuntu shard1 两个新 legacy mission PG case 暴露真实任务分类错误：借用内部目录被记为 local，
  调度器的原 artifact path 查询拒绝它携带的 platform input roster，子进程尚未启动任务就失败。
  本批仅将原借用租约改为 internal 并补齐 PreparedWorkspace 类型；原 SQL、路径、roster 与清理
  逐字保持。新回归先复现原错误再绿；原真实 mission 断言全留，新增落库分类/实际物化输入名单。
  相关 SQLite 20 pass / 246 expect，真实 PG 成功仍等本批 hosted。
- macOS shard4 的 Workgroup 源码断言仍找旧文件里的 hash import，改为核对原仓库委托和实际
  共享体中的同一个 hash；原其他断言保留，定向 1 pass / 56 expect。Windows E2E shard2
  的原 RFC244 分页 case 在点击后立即读异步请求数组，初始和重试都早于请求观察完成；trace
  证实该时序。本批沿用邻近旧例的完整树 aria-setsize=34 见证，再执行原 cursor 断言，原预算不变。
  没有本地 E2E；这两项与汇总/取消分片仍等待后继 exact-SHA CI。
- 上批 P0 变异产物 `rfc359-p0-mutations-34196252484`（artifact 10044031184）在 Bun 1.4.0
  SQLite/PG 各七阶段有效，14 份日志摘要全部核对；每侧 25 pass + 7 次指定旧故障 / 316 expect，
  前后控制各 10 pass / 112 expect，源码快照未变化。这是真双库历史证明，但不是 Main 全绿。
  本批保留原七阶段，再加 P0-9 缺 launcher/observer、P0-11 缺 boot barrier/reverify 四阶段。
  旧根 `01e4b1b7b` 的遗漏有源码锚；遗漏调用的重建不冒称空函数字节来自历史源码。
  缺 observer 通过真实已结束任务后的 claimed attempt/空 wake 精确失败，不依赖超时；非空技能
  恢复通过实际 reservation/锁/版本与本次 boot 状态验证。最终 SQLite 11 阶段均有效：
  37 pass + 13 次指定故障 / 591 expect，sourceFilesUnchanged=true；前次并发改源快照曾被拒收，
  重新冻结后取有效证据，没有放宽源码摘要判据。完整九变异真 PG 仍待本批 CI。
- 上批资源包恢复旧 timeout 这轮在 macOS shard4 通过：159.68ms，阶段 wall/CPU 已取得。
  原故障链 claim/stage/commit 这次未重现，不能据此认定根因已修；原 5000ms 与四例断言保持。
- 同 `7a19e5744` 的严格 full HTTP `34196371681` / job `101964898635` 已完成且 failure，
  产物 10045012108。原五表 500 repo / 100k task / 3M run / 10M event / 100k delivery，
  九端点每侧 20 个样本，共360；comparable=true、errors=[]、fullAcceptance=true，
  acceptancePassed=false。六项 PG 更慢，原绝对预算亦保持；P95（SQLite/PG，ms）如下。

| 实际 HTTP 场景          | SQLite P95 | PostgreSQL P95 |
| ----------------------- | ---------: | -------------: |
| tasks first             |    341.700 |        400.589 |
| tasks second            |    281.023 |        356.361 |
| tasks running           |    108.394 |         64.286 |
| repositories first      |     12.333 |         13.822 |
| repositories referenced |      9.247 |         13.799 |
| reviews pending         |      5.680 |          5.242 |
| clarifications pending  |      1.599 |          6.040 |
| workgroup pending       |     23.915 |          5.392 |
| overview                |     16.179 |         19.075 |

- 两份计时后 query-profile 已落盘，PG profile complete=false，不能冒称全部执行计划已取得；
  计时语料见证保持 unchangedFromHttp=true。后续按实际业务 SQL/CPU/计划定位，原样本不被诊断替代。
- 当前 AST：1911 个测试文件、663 文件 / 1416 次实际 SQLite 构库，657 个含构库文件无 harness，
  339 个文件调用 harness。同步事务文件仍7、provider 命名仍61、同目录对仍9，机制专属统计不删。
  canonical 为入口1732、事务272、导入5283、例外4751、public983、符号24944；新增共享归档入口1，
  符号12进9出净加3，已逐项登记。统一 tsc 的三个夹具合同缺项已修，完整 backend tsc 通过；
  154 个定向架构/参数化检查通过（339 expect），原清单次序保持，新 Workflow 行为用例按既有
  boundary 文件规则登记，不改扫描器。各组件及42个本批代码文件的严格 lint/format 通过。
  完整原行为覆盖、其他真实孪生、P0全证明、严格AC11和最终CI仍待完成。

### W12 第十六批：生命周期与事件追加共享、原性能 SQL 修正和历史回归补证

- `taskLifecycleWriteSequence` 将两份物理 task CAS → companion → committed event 合为一份。
  原同步入口仍立即返回 revision/eventRef、CAS miss 抛原异常；异步入口保留 nullable miss、
  expected revision 与异步 companion。外层事务、先 guard 后 CAS 的入口、提交后发布顺序均未移动。
  原30个 case 声明/89个 matcher 与其他函数 AST 保持；原50 pass/145 expect，新例先对旧 writer
  19 pass/118 expect，共享后64 pass/223 expect，追加原生 companion 后新套件14 pass/84 expect。
  两旧生产减少138行，共享体145行，生产净增7；这是算法2→1，不能记作净删。
  public `setTaskStatus` 与五个同步 companion 调用仍待迁移，未退役 SQLite 入口。
- committed append 的 cutover read、消费者清单、聚合序号与 append 四组算法共用 `appendProgram`；
  原同步/异步入口保留事务机制，异步 advisory lock 仍在原分配序号位置。Intent 原两段驱动循环
  原样移入通用 `transactionProgram`，闭包保存步进结果，不以断言转换驱动返回值。
  原7个公开签名、6个其他函数及5份原测试字节保持；原13 pass/60 expect 前后相同，
  新11 pass/53 expect。非法异步同步步进的拒绝也有先红后绿证明。
  完整 tsc 发现闭包内 cutover mode 收窄丢失，捕获已收窄局部值后通过，未使用类型断言。
  五生产文件677→556，净删121行；同步 cutover CAS 仍保留，不能整对销账。
- 原 full HTTP `34196371681` 的真实 PG 计划定位了 filtered task 根页：100000 个匹配行归为
  90000 根后才取51行，告警 EXISTS 执行100000次，聚合/JIT/临时磁盘开销均有实际计划。
  公共查询改用 default 已有的去重 open-alert 联接，matches 只投影后续所需三列；fam 以页内唯一
  root 集合作 IN 查询。原默认首页/游标 SQL 与绑定逐字相同，其他8个函数字节/AST 不变。
  新完整页/游标/并列顺序/祖先/筛选计数测试先在旧代码6 pass/283 expect，修改后相关11 pass/
  296 expect；12行真实 SQLite 的两组计划由 fam `SCAN t` 变成 `idx_tasks_root_started` 索引查询，
  所有原始结果和绑定相同。这只是计划与语义证明，真实双库 P95 留给下一轮原规模 hosted。
- 计时后 PG profile 唯一缺失计划来自 first-write generation marker 的实际 WITH UPDATE，
  不是业务查询遗漏。诊断仅将含写入的 CTE 改为不执行语句的 EXPLAIN，普通读查询保持 ANALYZE；
  原只读事务与回滚/释放顺序保持，报告逐条标注 plan-only/analyze，样本不改。
  实际故障 SQL 形状的纯机制回归先红后绿，完整 profiler 7 pass/41 expect；原分位数/严格比较/
  清理用例30 pass/77 expect。真实 PG 计划收集是否完整仍待 hosted，AC11 阈值和五表语料不变。
- 新增 P0-10 未清算 effect 就 release、P0-3 遗漏实际 boot recovery 调用、P0-4 periodic 对 revoked
  owner 的旧拒绝条件，均走真实持久化链并只接受指定旧故障。原11阶段和原控制前缀、断言/timeout
  全保留，现14阶段/每引擎64次执行。最终 SQLite 48 pass +16条指定历史红/665 expect；前后控制
  各18 pass/237 expect。appendProgram类型修正和清理诊断改变依赖后，原50源码证明分别保留，
  最终把eachProvider本体纳入51源码集合，再完整复验24.801秒通过；没有覆盖原结果或放宽摘要判断。
  这三项真实 PG 待 hosted；P0-4 的 S4 自动修复半链与 P0-1/2/8 历史证明仍待补。
- 上批 `f05a4d3ed569803b0ec109543c9f673e331a58b1` Main CI `34200442568` 终态为34 success /
  2 failure：唯一功能 job 红为 Ubuntu backend shard3（101977762291），另一个为汇总。
  RFC287 三个 PG 用例通过，afterAll 的追加库关闭后 DROP database 阶段报
  `ERR_POSTGRES_IDLE_TIMEOUT`（30005.19ms）；不能因其他分片或重跑通过就记为解决。
  同job的PostgreSQL日志显示原checkpoint耗时187.695秒，于07:47:17.835完成，随后强制等待
  checkpoint于07:47:19.922完成，比客户端失败晚593ms。PG17.11的DROP会请求并等待下一轮
  checkpoint，这与原故障高度吻合；仍需实际DROP的PID/wait_event才能确认直接归属。
  依据为PostgreSQL REL_17_11 `src/backend/commands/dbcommands.c:1834` 与
  `src/backend/postmaster/checkpointer.c:978,1033–1069`，以及Bun1.4.0 exact源码34cbb9a40。
  本批在慢DROP后以独立只读连接记录pg_stat_activity/checkpointer等待；原receiver、单次DROP、
  30秒超时和错误全保留。观察连接仅慢调用时创建，结束即取消观察，不加入原DROP的等待链。
  原6个清理例保持，新时序回归先红后绿，最终12个纯清理例加原4个RFC287 SQLite例
  共16 pass/57 expect；这份诊断不宣称已经修复旧故障。
  全部10个 E2E 分片、三平台 binary、macOS backend4及真 PG独立job成功；原Windows分页与
  Workgroup断言修正已获得后继证据。Git协议独立workflow34200442547同SHA成功；清理链继续定位，整仓尚未绿。
- 同 SHA 的 `rfc359-p0-mutations-34200442568` / artifact10045630780 在 Bun1.4.0 双引擎
  各11阶段有效：每侧37 pass +13条指定历史红/591 expect，前后控制各14 pass/213 expect。
  26个source hash 与发布SHA逐项一致、22份原始日志SHA全部核对。P0-9 的 agent/script真实任务
  已跑到done并结清实际attempt；上批 internal 分类修复与P0-9/11四变异已获真 PG证据。
  九个变异已证明，不等于12条P0或Main整体完成。
- 本批尚未新增旧套件迁移，累计仍174个。当前 AST：1914个测试文件、664文件/1417次实际
  `createInMemoryDb` 调用，657个构库文件无harness，342文件使用harness。四条同步机制证明共增一处原生构库，
  T19f743→744精确入账；十条共享生命周期写入行为仍默认双引擎，未隐藏机制构库。
  canonical：入口1734、事务272、导入5294、例外4761、public983、符号24959；符号19进4出，
  导入12进1出、例外11进1出逐项记明；只为已搬迁的物理writer增加精确分类，扫描器与原守卫保留。
  S14将两旧物理status写点收为共享体1处，保留全树扫描并显式断言旧路径不再写状态；3 pass/6 expect。
  T29原扫描器不变，事件追加先读后插从两文件2+2收为新文件2；T28原扫描器曾漏掉generator
  step返回的读值，补精确lexical表达式解包及先红后绿fixture，旧文件1处如实移到共享体1处，
  不能将漏扫当归零。两guard原判据全留，18 pass/45 expect。
  完整 backend tsc、154项定向架构/参数化检查（339 expect）通过。RFC继续 In Progress；
  AC6/7/8/9/11/12与真实剩余孪生继续推进。

### W12 第十七批：终态化共享、旧套件迁移与四类 CI 故障追踪

- native 与 async task-intent 终态化共用 `taskExecutionIntentTerminalSequence`，只复用已发布的
  两个 transaction interpreter。两次 select、两次 set、四次 where 的参数 AST 与旧两份实现
  全同；原 RETURNING 与两条精确错误保持。原 serializable 外壳和两个公开签名保持，
  boot composition 原 SQLite CAS 后 companion/后采时钟与 PG CAS 前 companion/input.now 均未改。
  新机制用例在旧两壳与共享后均8 pass/36 expect；原 epoch 例前后1 pass/5 expect。
  三生产文件189→170行，净删19行；public `setTaskStatus` 与其他原同步 companion 仍待迁移。
  统一类型检查发现两个测试期望工厂的字面量被推宽，仅补精确行返回类型，编译后JS逐字相同。
- 10个旧套件接默认双provider：自动布局、session capture/stdout/window及RFC304读面，累计174→184。
  原后SQLite均86 pass/417 expect，86个原case、177 matcher参数与全部timeout保持；完整回调、
  22个named helper与9个fixture hook在明确的await/harness改动后AST相同。
  75个原case双库声明，9个纯例和2个SQLite原生EXPLAIN例仍单跑；两条语句计数例分别使用
  同provider的两个独立真实数据库。5个OpenCode输入格式SQLite构造保留。
  四种旧/新seed的真实task70列/node_run61列整行和lineage原始JSON字节全同；共享seed helper
  只改数据库参数类型，编译后2641字节JS全同。真PG执行结果以本批hosted为准。
- P0-4新增真实S4修复半链：原已撤销owner条件使旧实现跳过实际修复；当前执行原任务CAS、
  持久事件和告警处理，保留节点仍pending与原后续resume位置。空boot控制与指定状态/错误
  同时核验，不能拿任意错误代替指定历史失败。原14阶段及所有已有控制/拒收逻辑保持。
  terminal共享与清库helper最终冻结后，统一65源码再验23.930秒：每引擎67次执行，SQLite
  50 pass+17条指定历史红/686 expect，前后控制各19 pass/245 expect；14份日志摘要全核。
  早期62/65源码候选与初版错误预期的日志各自保留，最终证明不混用。S4真PG等待本批CI。
- `8e55ebe35d97e0fe861655d4587b15c533629b26` Main CI `34205567197` 终态failure：
  28 success/7 failure/1 cancelled。六个后端分片失败、汇总失败，Ubuntu shard4被取消；
  独立真PG、全部10个E2E分片与三平台binary成功，不能代替整仓通过。
  独立PG job101994122471产物10047659112，在Bun1.4.0两库各14阶段、64次用例执行，
  48 pass+16条指定历史红/665 expect；51源码与exact SHA一致，28份原始日志摘要全核。
  已证12个历史变异覆盖9个P0编号的已列路径，不等于12条P0全部完成。
- CI第一类失败是 W16 物理写入合一后漏登的两条 legacy type/value 入边。
  `commons-debt`补记真实 taskLifecycle → taskLifecycleWriteSequence，inbound285→287，
  写明仍保留同步公共入口及RFC359退役波次。R1扫描器、精确逐条相等与正负fixture不改。
- CI第二类失败是 source-termination 原夹具依赖Promise执行节奏：真实SQLite语句为
  winner UPDATE → snapshot SELECT → fence UPDATE，因此读取新revision后的成功是合法结果。
  恢复原f05 writer导出的独立进程对照中原夹具绿，证实是共享`.all()`改变了夹具假定的交错。
  仅测试在实际快照查询完成后、返回原行之前，await同事务内原named lifecycle writer及其事件，
  确定snapshot → winner → fence。原错误码、整行回滚、事件与SQL顺序断言全留，只增一次
  捕获见证；旧/新writer均1 pass/8 expect，整文件35 pass/166 expect。生产没有再修改。
- CI第三类失败取得直接服务器证据：RFC287追加库DROP backend pid2580，statement精确匹配，
  state=active、wait_event=CheckpointStart、blocked_by=[]；checkpointer同时在DataFileSync。
  原checkpoint于08:48:25.692完成，随后DROP要求的新checkpoint于08:48:27.843完成，
  客户端却已在08:48:23.064按30s idle回收断线。PG17.11和Bun1.4.0精确源码与现场一致。
  30s不是DROP的显式SQL deadline：原SQL/lock预算均60s，afterAll为databaseCount×90s。
  仅DROP改用max1/idle0的短命连接，保留connect10s、SQL/lock60s、close30s及业务池原配置；
  单次执行、清理顺序和原错误保留，不重试或吞错。观察在语句结束即停止，再等待DDL连接关闭。
  新机制先13 pass/7条预期红，后20 pass/76 expect；原RFC287 SQLite4 pass/13 expect。
  真PG故障修复是否有效，继续等同链hosted证据。
- CI第四类为macOS资源包skill-update原5000ms超时。已有阶段证据指向apply内4880.568ms，
  新增CPU仅559533微秒；afterEach后的false与目录消失是超时后的次生现象。
  已在原三个hook加入阶段与实际SQL wall/CPU诊断，同traceId标记cleanup后的晚到续体；
  原timeout、四个case和全部行为断言保持。原后目标例各1 pass/7 expect，实际48条SQL均有记录。
  目前没有足够证据修改生产事务算法，不能将增加诊断或重跑偶绿称为修复。
- 当前AST：1915测试文件、657文件/1398次实际createInMemoryDb调用，647个构库文件无harness、
  353文件使用harness。10旧套件移除20次直接构库，新增2条同步机制case共用1次原生构库，
  T19f744→739逐文件精确记账；OpenCode外部输入格式的5次原生构造另保留，未隐藏。
  canonical：入口1734、事务272、导入5295、例外4762、public983、符号24961；
  imports9进8出、例外8进7出、共享sequence文件/函数新增2符号，旧全扫描判据保持。
  完整backend tsc通过；14个功能账本/边界/参数化套件173 pass/313 expect，canonical相关13 pass/55 expect。
  原规模HTTP run34205739420仍独立运行，不因新HEAD取消；严格AC11和RFC完整验收继续开放。

### W12 第十八批：不可变 schema 升级、历史恢复与 P0-1/2/8 证明

- PostgreSQL 历史不再通过覆盖旧 baseline 更新。原 `0000` SQL 和 journal 字节全留，另冻结
  完整逻辑合同、855 条原投影语句和 224 条 SQLite 迁移身份；`0001` 只追加两条 task 覆盖
  索引与条件 schema_contract 更新。SQLite 同步追加 `0225`，schema.ts 为两侧公共声明。
  原 root contract/plan 为 `9aabfa484e39… / 35a4a5ce169d…`，当前 head 为
  `4cf10ecd7bdb… / c7da5aac3234…`；历史边界不允许改列、行编码、原索引或 archive-only 合同。
- migrator 在同一保留连接持有稳定锁及各已知版本原锁；全部待执行索引、独立 upgrade receipt、
  schema_contract CAS 和 active generation 摘要同事务提交。原 baseline receipt 保留，
  全链按精确身份读取，不按 applied_at 排序；fresh head 不伪造历史 upgrade receipts。
  提交后仍持锁原子补写 pointer，文件失败时下一次只补 pointer，不重放已提交 DDL。
  6 个受控协议例为 6 pass/37 expect；同一测试装入原已发布 migrator 为 1 pass/5 指定失败。
- boot、手动迁移和 backup 在构造业务模块前准备 schema；SQLite 原 pending restore、pre-restore
  备份和 forward openDb 次序保留。已有 copy 使用原完整合同和计划恢复至 accepting-writes 后
  再升级；自动路径不恢复 failed/cancelled，显式 resume 保留该职责，且不自动 finalize。
  旧 copy 的 finalize receipt 保持原 schema，live pointer 使用已验证的当前目标 schema；
  rollback 仍选择原 SQLite schema。原 runner 加两例后 17 pass/87 expect；原实现会在新例的
  live pointer 检查报 `generation-schema-mismatch`，不能用改写原复制摘要绕过。
- 历史备份按原完整合同验证、解码，只有已验证的 index-only bridge 可以向当前完整目标合同
  重新编码内存 chunk；原 manifest、envelope、archive 和备份文件不改写。新 restore receipt
  和目标 generation 使用当前 schema。真实旧 PG 复制、索引失败事务回滚、同时间多步 receipts、
  fresh/upgrade 收敛、pointer 补写、新 backup 与旧 backup restore 已有默认真 PG 用例，等待
  hosted 执行。另有实际 SIGKILL 停在首个 chunk 提交后与 health-checked checkpoint 的用例，
  由正式 prepare 入口恢复旧 copy；本地 SQLite/协议检查不代替这些机制证明。
- 两条新增覆盖索引服务原 overview 四次读取和 repo 引用三次读取；没有合并语句或改原筛选。
  微型 SQLite 对拍覆盖空集、两种 awaiting、parent/catalog 分区、截止点 inclusive、NULL、
  explicit 对 legacy 的遮蔽及 schedule 去重；原 SQL、参数值、结果和事务回滚前后全行保持。
  真实目录检查锁住完整列序，SQLite 原查询使用 covering index。没有采用会改变无排序列表
  次序的 workgroup partial index，索引存在与本地计划通过均不代表严格 HTTP P95 已通过。
- P0-1 追加真实 ambient context 遗失、P0-2 追加 heartbeat owner revision 变化后的 effect 入账、
  P0-8 追加三个真实缺失能力调用与同工厂非空控制。原阶段、旧 case、参数和预算保留；最终
  SQLite 17 阶段/89 次执行为 67 pass+22 条指定历史失败/827 expect，前后各26 pass/307 expect。
  99 份真实源码/构库输入前后摘要与17份原始日志一致，新增 PG 证明等待本批独立 hosted 作业。
  证明范围不扩写为完整 daemon 或长期子进程 heartbeat 场景。
- 上批 `8fdb37939e9daaccfc174553f72e75abdc021dbd` 的 Main CI `34210383091` 终态 failure：
  32 success/3 failure/1 cancelled，Ubuntu2 与 macOS4 后端分片和汇总失败；独立真 PG、全部
  10 个 E2E 与三平台 binary 成功。其独立 PG job `102009694751` 的产物 `10049599094` 已核：
  Bun1.4.0 两侧各14阶段/67次执行、50 pass+17条指定历史红/686 expect，65源码与 exact SHA
  全同、28份原始日志摘要全核；S4 由此取得真双库证据。
- Ubuntu2 的 autokill 结构例原5秒预算超时于5233ms。原夹具在开始录制前逐条写入15/1200个
  事件，全部往返落在测试预算内；改为原顺序的公共 batch helper 后，六组真实 SQLite 全7列
  及行序与原夹具相同，原6 case/17 expect、4条测量语句、5/400样本和5000ms均保留。
  macOS4 的 manual cached-repo refresh 在120062ms超时，现场缺少具体阻塞阶段，不能将唯一
  已完成的 background clone 日志归给 manual fetch。原测试增加阶段、实际子进程 PID、流读取
  与 exit 等待诊断；原调用参数/顺序、2 case/7 个完整断言与120000ms保持，原子进程和 Promise
  直接返回，没有增加 reader、await 或重试。tiny 非网络子进程验证8 pass/237 expect，包含
  cleanup 抛错时恢复观察器；原网络用例未在本地运行，等待链仍待 hosted 定位，不能称整仓已绿。
- 原 full HTTP `34205739420`（exact `8e55ebe35d97e0fe861655d4587b15c533629b26`）现已完成。
  500 repositories/10万 tasks/300万 runs/1000万 events/10万 deliveries 的原完整语料、
  1次 warmup+20轮×9端点×2库共360个样本及全表前后见证均核对；9个原稳定 wire 投影相同。
  8个完整响应摘要相同，overview 的时钟正文摘要不同，由原比较器的稳定投影规则处理。
  两库 P95（SQLite/PG，ms）为：tasks first 245.008/334.487、second 201.352/290.012、
  running 50.441/51.938、repos first 9.118/13.092、referenced 6.649/12.267、
  reviews 4.658/5.252、clarify 1.449/5.679、workgroup 34.848/8.385、overview 9.704/19.937。
  8/9项 PG 更慢，两侧任务页、SQLite workgroup 与 PG overview 仍有原绝对预算失败。
  比较器 comparable/fullAcceptance=true、acceptancePassed=false；原 floor P95 与阈值不改。
  计时后 PG 79 个计划/SQLite 69 个计划均无错误，写 CTE 计划缺失已解决；它们不是第21个样本。
  本批不运行本地 PG、服务、完整性能库、soak、E2E 或全量门禁；RFC 与 AC11 继续 In Progress。
- 最终启动/恢复矩阵为24 pass/528 expect：历史与当前合同、真实 SQLite Worker、失败/取消的
  显式恢复、已完成状态拒绝再次 resume、COMMIT 后 pointer 补写均有定向判据。已接受写入且
  pointer 为 current 的目标不会因为旧 copy receipt 再抢离线锁；实际数据库机制准备在既有
  persistence runtime 内分派，history/copy/锁/pointer 编排由 system-operations 保持。
  原18 case/62 matcher AST 保留，最后三个非空类型收窄的 emitted JS 逐字相同。
- 当前AST为1921测试文件、660文件/1403次实际 createInMemoryDb 调用，650个构库文件无harness、
  354文件使用harness；旧行为迁移累计仍184。三份历史机制测试新增5次实际构库，另有一个
  只读 new Database 见证，全部记入T19f，文件账目739→742。LogicalSource 直接引用/驱动为
  SQLite12/8、PG6/4；新增原SQLite源夹具和真实PG备份源分别计数，不用间接生产调用虚增直接驱动数。
- canonical入口1737、事务272、导入5324、例外4791、public983、符号25040；新增3个历史
  纯构造/回放入口、29条实际依赖、81个符号并退役2个，扫描判据不改。手动 migrate 复用
  system-operations composition 的单条真实入边按W4-E7登记，R1为287→288，没有扩大bootstrap豁免。
  原CLI关闭句柄源锁随真实prepare开库点更新，两个关闭位置继续受约束；原真实migrate例与
  更新后的源锁2 pass/6 expect，旧源锁先按缺失openClient锚点报红。
  完整backend tsc、173项功能账本/边界检查、13项canonical功能检查及34项T19/T19c检查全部通过。

### W12 第十九批：任务页查询、行构造共享与托管功能回归修正

- filtered task 页的 matches/roots 改由优化器内联；qualified 的初始匹配集合直接来自已限页根的
  fam，以同一 nonView/view 谓词计算 is_match。attention 仍使用原去重告警联接，UNION 防环、
  筛选计数、游标、页根排序与一次语句快照保持。28行真实夹具覆盖63种筛选组合、完整页结果与
  游标/计数及环；SQLite 原相关4例仍通过，新3例加入全行golden后为3 pass/959 expect，合计7 pass/974 expect。原 PG profile 的 qualified seed 曾扫10万行，
  本改动的真实 PG 计划与原规模P95仍待hosted，不能由SQLite对拍推断加速。
- MCP/plugin 的两份 INSERT 行算法分别共用 createMcpInsertValues/createPluginInsertValues。
  原 helper 显式 schemaVersion=1，Intent 仍由实际数据库默认值决定该列；原 .insert/.returning/.get、
  JSON序列化、捕获的安装元数据和时钟保持。8组真实SQLite全行/返回/SQL/参数/回滚前后与旧实现
  相同，原6例加新8例为14 pass/65 expect；新增6个真库例默认双provider，不能写成完整Intent根验证。
- 再迁移12个旧功能套件：原后均88 pass/361 expect，323个完整matcher、88原名称和预算、27组种子
  参数、原timer/Git顺序保持；9组实际SQLite全物理行和行序相同。59个数据库fixture case默认双库，
  29个原纯逻辑/脚本化SQL控制保持单跑。构库27→0，累计迁移196套件；当前1924测试文件，
  648文件/1376次实际构库、638个构库文件无harness，368文件使用harness，T19f742→730。
- W18 exact `67e2cf8c9a756ca3831a083aa4455cc03c2e2287` Main CI `34219640735` 终态failure：
  26 success/7 failure/3 cancelled，五个后端分片失败、三个被取消；独立真PG、三平台binary、
  托管类型/格式和十个E2E作业完成。Windows E2E shard2有1个RuntimeInventory重试通过的flaky，
  不能把其重试结果当首轮干净通过。整仓AC9继续开放。
- 同SHA独立真PG job `102039466503` 原始产物已核：Bun1.4两库各17阶段/89次执行，
  67 pass+22条指定历史失败/827 expect；前后控制均26 pass/307 expect。99份源码对 exact git blobs、
  34份原始日志摘要全部核对；P0-1/2/8由此补齐真双库证据，AC7收口，证明不扩写为完整daemon。
- 三个恢复/旧备份失败位置已修：两处进程中断测试误给 db.all 裸字符串，改原查询的 SQLWrapper；
  实际 PostgreSQL logical source 的 metadata JOIN 使用保留词 current_schema 当未引号别名，
  改为 current_contract，其他生产字节保持。受控真实client/source先2red后2green，连原微型检查
  共5 pass/25 expect；原58 matcher及120s预算保持。原真实两步升级已在W18通过；三处真实恢复
  与受影响旧backup/LogicalSource例仍须hosted复验，不能把受控响应当成真实PG执行。
- W18 count-index例的PG记录器按完成时刻收集四个并发计数，前后SQL顺序因调度不同而红；
  只对这四条按完整SQL/参数数/参数值排序，保留重复次数与后续三次串行repo读取顺序。
  24种完成序排列与8种SQL/参数/数量/串行尾序改变的负例保留判别力；SQLite+纯回归3 pass/52 expect。
  没有合并四计数为单SQL，因为那会改变原四次独立语句快照。
- 性能/测试 helper productionOverview 的实际代理 getter 能读到 $provider，而 in 操作为false，
  导致原PG性能装配错误进入legacy路径；生产daemon的owner接线正确。helper以getter判别，
  两个原受控owner调用先红后绿，新3例20expect；其他五个函数体和原计时逻辑保持。
  因此此前full报告的overview数字只能归于实际legacy装配，不能证明预期PG owner路径；此前
  其余8端点数据仍保留，旧8e55中7项PG更慢。最新W18 full run `34219807721` / job `102040001645`
  / artifact `10054410251` 已结束为failure：exact67e2、8份源码与gitblob摘要相同，原五表数量与
  全表前后/双库摘要、1+20轮和360样本全部核对。SQLite/PG P95(ms)：tasks first299.786/364.395、
  second241.436/334.622、running65.946/57.597、repos first7.182/12.432、referenced5.032/14.035、
  reviews1.870/6.147、clarify1.705/3.111、workgroup24.197/5.392、overview6.876/14.061。
  仍有7/9较慢；排除装配偏差的overview后为6/8。两侧任务页、SQLite工作组及PG overview的原预算失败。
  原稳定投影一致，8份完整响应摘要一致；overview完整摘要不同，不据此声称完整响应相同。
  计时后SQLite69/PG79个计划与全部语句均无错误；原比较器comparable/fullAcceptance=true、
  acceptancePassed=false，overview另有实际路径归属限制。原语料、floor P95和预算保持。
- 其余托管源锁按实际实现同步：225条SQLite head、手动migrate退出provider选择根、backup/restore
  在本地组合后注入operations并shutdown、persistence runtime新增三处schema准备分派。status夹具
  用已冻结真实历史contract替代虚构digest，原missing-URL错误、四并发共用一次探测保持，3 pass/29 expect；
  rolling四原截点及真实任务到done保持，定向6 pass/257 expect。RFC349当前schema报告重生成，
  原PG 0000/root和SQLite历史前缀不改写。迁移构造器已有实际消费者在packages/backend/scripts；
  守卫扩大执行脚本语料并补移除真实调用的变异，不以新死代码豁免掩盖，七项定向源锁19expect通过。
- 最终类型检查发现新任务页fixture把谱系字段写成不存在的lineageRootExecutionId；Drizzle原先忽略
  它，SQLite0210触发器生成谱系。改为实际executionLineageId与原触发器生成的同序JSON，18基础行
  和自环变体18行的全物理列/JSON字节逐项相同；两份golden也进入默认双库断言，原18个add参数和
  筛选/游标/计数/timeout保持。dispatch读取private观测值改用getter；MCP两个matcher只补擦除的类型，
  转译JS字节相同。最终完整backend tsc和31个TS路径lint/format通过。
- canonical入口1737→1739、symbols25040→25042，正是两份真实共享INSERT构造；事务272、imports5324、
  exceptions4791、public983保持。新增执行脚本语料沿用原值调用判据与死适配器账本，不改排除逻辑。
  203项功能检查中首轮202项通过，唯一动态语料数组形状误报改为等值concat后，两文件49项/75expect
  定向复验通过；canonical13项/55expect通过。未运行全量本地门禁。
- LogicalSource直接引用/驱动更新为SQLite12/8、PG7/5，新增PG受控机制构造如实计数，不能称真库覆盖。
  本批仍不运行本地PG、服务、完整语料性能、soak、E2E或全量门禁。RFC保持In Progress，
  AC1/6/8/9/11/12继续按实际剩余实现、完整覆盖和最终exact-SHA证据推进。

### W12 第二十批：共享依赖遍历、真实查询差异与交互时序修正

- Agent 依赖遍历从两个真实消费者抽出共享 DFS，生产净减7行。先候选环、visited/visiting、串行加载、
  首个缺失错误与 loader 错误身份保持；两个 wrapper 原本不同的空根规范化不混同，SQL/解析/事务不动。
  32组实际原后函数对拍一致；原4个case及41个matcher保持，原实现上的新真实消费者控制2 pass/21 expect，
  最终小型SQLite与纯遍历16 pass/101 expect。真实 classic create/update 与 package inspect/preview/apply/
  receipt/create/overwrite/replay 均有新增默认双库例，完整package HTTP与PG结果仍待hosted。
- 仓库引用计数在 `tasks.id` 和 `task_repos.task_id` 真实 NOT NULL 前提下，将 legacy count 的相关
  NOT EXISTS 改为 NOT IN；原三次串行读取、查询顺序和各自快照保持。42种小型真实SQLite分布与旧SQL
  对拍、全表回滚一致，不能由此宣称PG优化有效。
- W19 Ubuntu的ACME搜索红来自生产三列 bare LIKE：SQLite大小写不敏感而PG敏感。SQL store构造必需
  注入现有 EngineCapabilities，唯一生产装配传实际 engineOf(db)，三列使用同一 capability。
  266项输入×两方言的532组SQL/参数对拍证明SQLite字节不变、PG仅三处LIKE改ILIKE，trim/NULL后备/
  转义/排序/游标保持。真实harness含8仓库/14查询/两页，连引用计数4 pass/527 expect；受控PG编译
  先指定红后绿，旧ACME测试未改。编译器证明不当作真实PG执行，真实结果等待新SHA。
- 再迁4旧套件：rfc108-list-open-alert-count、rfc182-room-execution、api-task-output-kind及rfc357-page-parity。
  原8个case、18个完整matcher AST和预算保持，6个DB case默认双库、2个源级case单跑，构造器5→0。
  原SQLite全物理列/行序/JSON字节的3组10行相等；page完整场景及未播种负例保持。最终8 pass/131 expect。
  初选的rfc310仍走真实同步setTaskStatus事务，已保留原文件并排除迁移计数；两个读取服务与私有子计数
  仅改3个已中立的参数类型，整文件转译JS逐字相同，完整backend tsc通过。
  累计旧套件196→200；当前1927测试文件，644文件/1371次实际构库，634构库文件无harness，375文件有harness；
  T19f730→726，仅移除这4个已迁文件的原条目，不改扫描器或排除判据。
- W19两条task-page golden失败已精确复现：原SQLite0196触发器覆盖9个子任务launchOrigin，PG没有该触发器。
  用原18×70行只还原这9列为原INSERT输入即重现两个托管失败摘要，列顺序并非原因。夹具显式继承原根值，
  原两份golden、63筛选组合、3个case/34个matcher、18次add参数及预算不变；原后SQLite均3 pass/959 expect，
  基础与环变体36×70全列/JSON字节相等。真实PG仍需新SHA。
- W19升级备份例已产出真实archive，失败在extract目标目录未创建。只补mkdirSync(extracted,{recursive:true})，
  原6个case、67个matcher、33个SQL调用与120秒预算保持；真实微型归档原片段1 pass/1指定fail→2 pass/8 expect。
  这次诊断有一次错误Bun参数误入根测试脚本，12:24:13.293Z至12:25:15.247Z约61.954秒后终止该PID子树，
  exit143且进程已消失；不计作完整测试或门禁证据，不重跑。后续只使用显式范围的验证命令。
- TaskDetailRoute在canvas点击早于run数据到达时丢失待选节点，之后同节点再次点击又被去重。以ref保留待选节点，
  数据到达只处理仍有效的一次待选；显式历史run、清空、关闭与任务切换保持原语义。真实route→canvas→drawer→
  inventory六场景在旧实现3指定fail/3 pass，修后6 pass；20个原相邻控制通过，frontend tsc/lint/format通过。
  没有原Windows trace，因此不把该真实缺陷认作早先flaky的唯一原因。
- W19 Windows shard4取消例首次请求200且任务已canceled，后续runtime_worker行却为空。原前置只等task running，
  不保证mock目标已激活；已有NodeRun.pid是更早持久化的launcher receipt。新增opt-in MATRIX_CANCEL_READY_DIR，
  真实mock解析cancel输入后、原10秒sleep前原子写同taskId/process.pid；E2E在原同一个45秒期限、250ms轮询内
  等任务/唯一running worker及目标见证，再执行原取消流程。原断言/180秒测试/2秒节点等待/retry均保留；实际小型
  dispatcher旧2控制pass/1指定fail→3 pass/18 expect，原fast retry/fail金样2 pass/25 expect。Windows完整链待hosted。
- W19 exact `08c06dea3f4840f9c18328dafa7a497402af9184` 的Main `34223843004` 终态failure：
  30 success/3 failure/3 cancelled。4个macOS后端、独立真PG、三平台binary及全部E2E作业成功；Ubuntu shard1失败，
  其余3个被取消，其中shard2取消前有ACME红、shard4有上述两个golden红，shard3没有记录失败case。
  Windows shard2为116 pass/11 skip/0 flaky；shard4为72 pass/50 skip/1 flaky，不能记首轮干净。
- 同SHA原full HTTP `34223969146` / job `102053472343` / artifact `10056094489` 终态failure。
  官方ZIP为159040字节，SHA256 `53d140ba138f870cc230783970491b24a022c4c4c5225ce62b60125b8bf6ee65` 已核；
  8源码与exact git blobs一致。原500仓库/10万任务/300万run/1000万event/10万delivery的全行原投影摘要
  前后及双库相同，1 warmup+20轮×9×2=360样本完整；全部P50/P95/max独立重算一致，floor P95仍为20项最大值。

| 原full端点        | SQLite P95 ms | PostgreSQL P95 ms |
| ----------------- | ------------: | ----------------: |
| tasks-first       |       264.634 |           226.988 |
| tasks-second      |       203.215 |           186.626 |
| tasks-running     |        58.249 |            49.180 |
| repos-first       |         6.874 |            12.747 |
| repos-referenced  |         4.683 |            11.085 |
| reviews-pending   |         1.772 |             7.916 |
| clarify-pending   |         1.547 |             3.129 |
| workgroup-pending |        24.595 |             6.736 |
| overview          |         3.969 |            11.383 |

- PG仍5/9更慢；两库首/次task页超过原150ms，SQLite工作组及PG overview超过原10ms。
  overview已核为正确PG owner及原四个task计数语句，不能再按旧legacy夹具排除该样本。
  9份稳定响应投影相等、8份最后测量完整body摘要相等，overview完整摘要不同，未保存body字节则不推断原因。
  两库计时后profile complete/unchanged=true且0 errors；诊断不充当360个计时样本或收益证明。
  原comparison comparable/fullAcceptance=true而acceptancePassed=false，原语料、分位数和全部预算保持。
- canonical入口1739、事务272、public983保持；imports5324→5326、exceptions4791→4793，如实计入共享
  DFS的ValidationError值入边和SQL store的EngineCapabilities类型入边。symbols25042→25043来自新增共享文件/
  函数两个符号及退役私有escapeLike一个符号，原分类器与豁免范围保持。所有新代码使用定向lint/format检查；
  203项功能metadata检查/419 expect及13项canonical功能检查/55 expect通过，独立功能复核的两个类型/
  同步入口问题已分别修正合同和排除未迁移用例，其余提交范围无功能findings。
- 除已终止且不采信的误命令，本批使用小型SQLite/受控非网络进程/组件及类型检查；未主动安排本地PG服务、
  完整语料性能、soak或E2E，未取得有效完整本地门禁。独立功能复核与托管验证的范围分别记录；
  AC1/6/8/9/11/12继续开放，RFC保持In Progress。

### W12 第二十一批：任务页与 Overview 构造、旧套件迁移和原预算内的 CI 分片

- W20 exact `c468b4eda1608bb7496149dfcccb9b0c7a2177fb` 的Main `34229654417` 终态failure：
  31 success/2 failure/3 cancelled。四个macOS后端、Ubuntu shard1、独立真PG、全部九个frontend、
  lint/types/shared/system-mocks、三平台binary及十个E2E成功，不能据此把完整Main记绿。
  Ubuntu shard2/3/4的明确annotation均为超过原15分钟作业上限，总时长918/918/917秒；shard1成功
  总时长874秒，测试阶段811.77秒/482文件。只将后端Ubuntu扩为八分片，macOS保留四分片，全部文件、
  isolate/randomize/coverage/env及15分钟不变，原required聚合继续覆盖完整matrix。
  两个原纯命令/分片例由2 pass/51 expect到2 pass/59 expect；其余22个callback及剩余源字节不变。
  37个/tmp纯文件经本机原生Bun的4分片与8分片均各执行一次；这是Bun1.3.13的小型机制证据，
  不能替代hosted Bun1.4完整后端双OS覆盖或证明新矩阵已解决全部超时。
- Ubuntu shard2在作业取消约42秒前还有独立的真实PG清库超时：runtime-freeze的四个业务例已通过，
  afterAll对额外数据库的DROP在60013.10ms收到SQLSTATE57014。服务端当时观察到CheckpointStart，
  blocked_by为空，checkpointer在DataFileSync；前一checkpoint共217.266秒、sync58.002秒，
  在该DROP取消1.021秒后结束。原初始化等待、关闭额外业务池、独占短命DDL连接、关闭主池顺序完整。
  这与W17的Bun idle误杀不同；没有证据把本次归因为池泄漏，也不能将共享checkpoint的420325文件
  同步归给某一个测试。原60秒DDL预算未改，不加重试或等待；是否随负载下降消失仍需新SHA。
- 该SHA的升级/旧备份恢复七例在Ubuntu shard1通过；旧ACME搜索例与新42种引用计数分布在真实PG通过。
  四份Ubuntu日志未出现task-page golden与新增search conformance的执行记录，不能据此补记通过。
  Windows shard2为116 pass/11 skip/0 flaky，shard4为73 pass/50 skip/0 flaky；实际runtime取消例
  `workflow-matrix.spec.ts:1466` 首轮ok、耗时1.6秒，原断言完整执行。此证据不证明W19 flaky只有一种原因。
- 再迁七个旧套件：六个task catalog/injected-memory/review/clarify读取套件，以及混合workgroup-state套件。
  六套件原后均39 pass/89 expect，39个case及80个完整matcher AST保持；36个DB例默认双库、3个纯例单跑。
  实际原后种子36场景×6表共218整行/9276字段/286原JSON值逐字相等，固定JS/原生SQL时钟与ULID
  只用于/tmp观察，原不带观察的用例也单独通过。旧根/子任务lineage与42条nodeRun的原NULL保持。
  workgroup套件原后均6 pass/64 expect，4个DB例默认双库，纯gate-view与原SQLite0106迁移各单跑；
  44个完整matcher及整段原迁移源字节不变。实际原后workflow/task/state三整行90列/JSON相等。
  只拓宽三个已异步state入口参数和type import，整个生产文件转译JS逐字相同，原同步函数保持。
  合计旧例45 pass/153 expect，40个DB例与5个原纯/原生例；累计200→207，不用新增测试充当旧套件迁移。
  当前1929测试文件、637构库文件/1355次调用、627构库文件无harness、384文件有harness；
  T19f726→720，移除六项并将workgroup原5处收紧为保留的一处原生SQLite迁移，不改扫描/豁免判据。
- W19原full后置计划表明filtered task-page在LIMIT51前物化10万non-view行、聚合约9万root，
  两个PG计划各有5批hash/temp spill；限页fam和qualified只处理57行。仅将实际快速filtered查询的
  non_view_matches改为NOT MATERIALIZED，其他生产字节、旧exhaustive查询及SQL绑定完全保持。
  旧SQL预言仅恢复这一原hint，真实db.all执行两份SQL并比完整行/JSON、facet、两页游标及回滚；
  新受控PG编译器使用真实编译路径，禁止连接，不伪造查询行。原W19的63筛选、环、完整golden保持，
  原录参器仅放宽定位字符串以容纳hint。最终六例1240 expect通过；完整backend tsc发现新测试读取了
  不存在的parameters字段，原SQLite绑定相等结论已撤回，修为真实values且要求非零params/双方长度，
  补完整cursor与结果行类型后重新验证。NOT MATERIALIZED可能重复扫描，尚不宣称P95收益。
- Overview复用三个不可变QueryBuilder并作四次独立执行，生产净增27行；每次仍独立prepare/all并保留四个并发语句、
  当前参数与原快照/clock/返回。warm后3次load的builder构造15→0，仍真实录到12条原SQL与完整参数。
  新机制例在旧源按构造次数指定红，最终五例及W18三个旧控制为8 pass/105 expect；并发参数变化、
  行更新、回滚和晚装录参器均覆盖。原SQL字节/绑定及完整结果保持，未缓存native statement或结果；
  提前捕获native statement的候选会绕过晚装录参器，已拒绝且未写入仓库。实际收益待原规模hosted。
- W20原full HTTP `34229859100` / job `102072994673` / artifact `10058685114` 终态failure。
  官方ZIP159412字节，SHA256 `3fef19abd2e7b1bfd94d612f39d01419c535ce9f21ad2b651441764cca42c247`
  与API一致；全部12成员字节和8源码对exact c468 git blobs已核。原500仓库/10万任务/300万run/
  1000万event/10万delivery的五表全行原投影，六份收据前后及双库一致；1 warmup+20轮×9×2=360
  完整raw样本独立重算相同，floor P95保持20项最大值，comparison原逐项判据不变。

| 原full端点        | SQLite P95 ms | PostgreSQL P95 ms |
| ----------------- | ------------: | ----------------: |
| tasks-first       |       276.524 |           227.977 |
| tasks-second      |       215.882 |           191.967 |
| tasks-running     |        58.867 |            47.733 |
| repos-first       |         5.414 |             9.496 |
| repos-referenced  |         5.441 |             8.642 |
| reviews-pending   |         2.225 |             4.226 |
| clarify-pending   |         1.820 |             5.258 |
| workgroup-pending |        26.756 |             8.809 |
| overview          |         3.856 |            14.647 |

- PG仍有repos-first/referenced、reviews/clarify、overview五项更慢；双库首/次任务页原150ms及
  SQLite workgroup、PG overview原10ms共六项绝对预算失败。comparable/fullAcceptance=true、
  acceptancePassed=false；正确PG owner链与原四个task计数已核，不能排除该overview样本。
  九份稳定响应投影相等；最后计时的完整body摘要八份相等、overview不同，上传包没有timed body字节，
  不冒称已本地重哈希或推断差异原因。两份后置profile complete/unchanged=true、0 errors，
  SQLite/PG分别96/125条语句、69/79计划；顺序为双HTTP→comparison→双profile→archive，
  诊断数据不充当360个计时样本，原语料、预算、统计口径均保留。
- canonical入口1739→1740来自实际createCountTemplates构造入口，事务272/public983保持；
  imports5326→5327、exceptions4793→4794只计入workgroup state的ProviderNeutralDatabase类型入边。
  symbols25043→25044来自移除私有loadOverview、增加私有CountTemplates/createCountTemplates，
  原分类器和豁免范围保持。完整backend tsc与定向lint/format通过；203项功能metadata/419 expect、
  13项canonical功能检查/55 expect通过。功能交叉复核已记录并关闭录参字段问题，其余候选无未解决finding。
- 本批本地仅做小型SQLite、纯编译/受控非网络录参、类型与定向源码检查；没有新增本地PG/服务/性能/
  E2E或完整门禁。新SHA的真实PG、八分片完整覆盖与原full P95仍待托管，AC1/6/8/9/11/12保持开放。

### W12 第二十二批：编译文本复用、Skill 标量映射与完整矩阵的旧合同修正

- W21 exact `cb0403df4fc92e6b5b481548dd1baa2d7311c1ba` 的Main `34236588166` 已终态failure，
  40个job为35 success/5 failure；完整Main仍未绿。12个后端matrix全部结束，9 success/3 failure、
  无cancelled；独立真PG成功。八个Ubuntu实际242+7×241=1929文件，逐exact Git文件集合与Bun分片
  规则对账，1929个unique、重复/缺漏/额外均0，总18711 pass/31 skip/3 fail/127016 expect。
  Ubuntu最大总时长579秒，macOS802秒，均在原15分钟内；这是本次完整覆盖与终态证据，
  不能据此归因或宣称所有负载条件下的PG独立清库超时已消失。
- 该SHA的三个功能失败均为旧RFC349对CI命令/矩阵的断言：Ubuntu shard1一例、shard5两例，
  macOS shard1重复这三例。W22将原owner命令登记与断言改为实际matrix.shards分母，解析真实YAML
  验证Ubuntu1..8与四个macOS include、无exclude，并在真实owner的steps中验证完整checkout及
  OpenCode安装。原三个case由0 pass/3 fail/8 expect到3 pass/69 expect；其余16个完整test声明
  和全部19个名称保持。真实原callback的4个控制与7个指定配置变异均按缺分片、错误分母或缺step
  在原断言处失败，不用替代测试假装托管覆盖；没有修改CI工作流、发现范围或原预算。
- W21七旧套件40个DB例在SQLite/PG各执行一次、5个原纯/原生例单跑，全部通过；task-page新五例、
  Overview新十次双库执行及W19六个原golden/筛选例均通过，63种筛选保持。W20搜索、引用分布，
  T19h升级7例/恢复5例，以及runtime-freeze20次也通过。source证据逐20文件对exact SHA核验。
- 再迁三旧套件：rfc127-self-questioner-borrow、rfc165-validation-context和混合rfc248-readonly-dirty-visible。
  原后均11 pass/28 expect，11个case及27个完整matcher AST保持；5个DB例默认双库，5个纯例和
  1个原生SQLite PRAGMA例单跑。四个实际种子场景的七表23整行/919字段/22原JSON逐字相等，
  六条node_run原NULL保持；任务lineage显式重现原SQLite0210触发器，不更改原业务fixture。
  rfc165原DB例只覆盖空上下文，不把额外的源码调用链核验记成动态分支已覆盖。
  Workflow验证三个既有async入口只改参数类型/import，整个生产文件转译JS相同；同步入口保持。
  一个/tmp观察器首尝试未完成并终止，已排除；最终原后控制和非观察执行均各11/28有效。
  累计207→210；当前1931测试文件、635构库文件/1351次调用、624构库文件无harness、388文件有harness。
  T19f720→718只移除rfc127/rfc165两项，rfc248原生1处保持，扫描/豁免/负例原字节不变。
- SQL编译器只保留成功的精确输入/输出文本对，生产净增28行；FIFO上限256项及524288合计UTF-16单位。
  原扫描器和客户端入口保持，每次真实SQL/新绑定仍重新提交。7个新功能例原后均7 pass/411 expect，
  加4个原控制为11 pass/419 expect；受控真实runtime/client到物理驱动边界记录16次raw、5次复用
  builder及2次可变SQL对象提交，共23次，完整SQL、参数身份/值/顺序不变，未执行数据库查询。
  /tmp同源计数核279次成功编译/292检查，重复扫描2→1，命中FIFO位置、双界、边界值、超大项及
  原词法错误保持；这不是真PG或性能证据。统一tsc发现新测试的泛型方法联合TS2349，改成四个保留
  receiver的显式类型closure，23次顺序与39个实际matcher不变，最终11/419、lint/format及完整tsc通过。
- Skill两处既有映射共用一个标量映射器，生产净减7行。inline默认与显式tail各保持原managedPath
  位置、NULL省略、空串/Unicode、own undefined、完整属性描述与getter读次/顺序；其余23个函数
  源字节保持，第三处PG intent映射完整文件保持，不记为provider配对/命名文件退役。
  新控制文件在原源8 pass/109 expect，候选加3个纯tail控制为11 pass/127 expect，原8个展开用例对应的callback
  转译JS/19个matcher及名称/预算保持。5个DB例实际经过catalog list/get、inventory回调与workflow
  context入口，另外6个纯例单跑；已有D23a建→读→列原例1 pass/7 expect单独通过。
  两个/tmp隔离变异分别6 pass/5指定断言失败，无驱动/import/hook/timeout假红，恢复后11/127通过。
- W21原full HTTP `34236805950` / job `102096517298` / artifact `10061729920` 终态failure。
  官方ZIP12成员/160978字节，digest `b7a0aeaedbad3465ee074f579afe8e06654ba30f8a79eea8588574c04acd4b06`
  与API及全部解包成员一致；8个原源码与4个实际诊断/owner源码逐exact cb0403 Git blob已核。
  原500仓库/10万任务/300万run/1000万event/10万delivery，六份五表全行原投影收据前后/跨库一致。
  每端点1 warmup+20轮×9×2=360 raw逐向量独立重算，floor P95仍为每20项最大值，整个comparison
  对象相同；comparable/fullAcceptance=true，acceptancePassed=false。

| 原full端点        | SQLite P95 ms | PostgreSQL P95 ms |
| ----------------- | ------------: | ----------------: |
| tasks-first       |       308.727 |           204.557 |
| tasks-second      |       194.157 |           157.429 |
| tasks-running     |        83.505 |            60.028 |
| repos-first       |         7.789 |             7.842 |
| repos-referenced  |         6.351 |            16.489 |
| reviews-pending   |         5.854 |             5.600 |
| clarify-pending   |         1.907 |             3.580 |
| workgroup-pending |        26.057 |             8.332 |
| overview          |         5.540 |            19.248 |

- PG仍有repos-first/referenced、clarify及overview四项更慢；双库首/次任务页原150ms、SQLite工作组
  和PG overview原10ms共六项绝对预算失败。不能把相邻批次耗时差直接归因于CTE或三个builder复用。
  正确PG overview owner的四条独立count及三个builder已核。九份原稳定响应投影相等，末次完整body
  摘要八对相等、overview不同；timed body未上传，不能本地完整重哈希或推断差异原因。
  双profile complete/unchanged=true、0 errors，SQLite96语句/69计划、PG125语句/79计划；
  顺序双HTTP→comparison→双profile→archive保持，后置诊断不充当计时采样。bootstrap导出/恢复
  的178表/10行收据相互关联，原规模语料在随后播种并由六份独立收据见证，不能混为全量恢复已验真。
- canonical入口1740、事务272/public983保持；imports5327→5328、exceptions4794→4795只加入
  workflow.validator到ProviderNeutralDatabase的类型入边，symbols25044→25049来自五个私有编译器
  cache声明。分类器/豁免范围保持。完整backend tsc、定向lint/format通过，203项功能metadata/
  419 expect、13项canonical功能检查/55 expect通过；最终文件与原断言/源码已交叉复核，无未解决功能finding。
- 本批本地仅小型SQLite、纯编译/受控非网络调用和类型/源码检查，无本地PG/服务/性能/E2E/完整门禁。
  本批真实PG、完整新SHA Main与编译复用的原full HTTP效果仍待托管，AC1/6/8/9/11/12继续开放。

### W12 第二十三批：页内匹配元数据、异步加载器修复与八套件双库迁移

- W22 exact `d2c27f5ec4f8f84841862c6bb6211f3f201e4d04` Main `34242698161` 终态failure，
  40个job为37 success/3 failure；完整Main仍未绿。12个后端matrix为11 success/1 failure，
  无cancelled，独立真PG成功。八Ubuntu分片242/242/242/241/241/241/241/241，1931测试文件
  对exact Git root tree和Bun sorted-modulo8分片规则逐项相等，缺漏/重复/额外均0。
  22个实际Git blob及12个W22 manifest源码摘要已核。W22三旧套件5个DB例两库各一次+6单跑、
  Skill5个DB例两库各一次+6纯例、编译器7个新例及4个原控制、三个原RFC349 CI合同修复均通过。
  编译器控制仅证明真实client边界与编译文本，不能记成执行PG查询。
- 后端唯一功能失败在Ubuntu shard4/job `102116652292`：RFC314 PG会话窗口计数例用尽原5秒，
  日志实际5478.63ms时large样本还在第二个run播种第278条事件，large样本尚未进入
  recordStatements/getSessionTree；small样本已完成原查询。
  同文件其余2个PG业务例、3个SQLite业务例及1个原生SQLite计划例通过。W23只让计数case的
  未录制播种选择每100事件一批，最大7字段/700参数；其他入口保留单事件INSERT。20/800事件
  写入次数20→2、800→8，全部820事件、绑定顺序及原7条窗口查询SQL/绑定值/返回行数对拍相等，
  另以真实乱序事件见证默认入口的完整SQL/值/行不变。原后4 pass/13 expect；原case、查询条数
  与5秒预算不变，没有改生产或harness。统一tsc发现map的kind拓宽为string，补字面量类型，
  完整转译JS不变；最终类型检查通过。真实PG在原预算内完成仍待本批exact SHA。
  首次单文件调用用了错误provider环境键，只产生缺少PG URL的sentinel失败，未启动PG；该调用
  已排除，以正确AW_TEST_PROVIDERS=sqlite的原后4/13及最终类型修正执行为有效证据。
- 再迁八旧套件：rfc215-batch-engine、rfc189-wg-round、rfc350-interrupted-archive、rfc354-frame-backfill、
  rfc243-call-validator、scheduler-mcp-preload、scheduler-plugin-preload，以及rfc333-human-gate-open-fault-baseline。
  前七套件原后54 pass/205 expect，54个原case及199个完整matcher AST保持；43个原DB例默认
  双库，10纯例与1个原生SQLite迁移例单跑。101个真实SQLite INSERT后快照原后逐字相同，
  合计246次行观察/14450字段/213 JSON字符串观察；有重复快照，不能写成246个独立种子行。
  frameBackfill、lookup helper及taskArchive三处只改类型，整个文件转译JS相等；resolver两个
  async loadByIds原来直接对all返回值map，改为await后map。受控适配只把真实SQLite查询结果
  以Promise交付，两个原map错误变为2 pass/2 expect；这是真缺陷修复，不是纯类型或真PG证据。
- 故障套件原后3 pass/29 expect，3个原DB例全部默认双库，21处实际查询终点await后再解引用。
  三处原SQLite CREATE模板逐字保持；PG使用同一故障点的独立function及FOR EACH ROW trigger，
  固定原异常标记，失败路径保留原断言，清理按trigger→function并覆盖部分安装失败。
  原生SQLite关闭在原finally时机保持，PG由harness关闭runtime；不把原生控制扩到PG或跳过业务例。
  3个真实seed场景13整行/483字段/28 JSON值原后逐字相等，任务lineage显式重现旧触发器、
  node_run原NULL保持。54个DDL文本/清理协议检查仅证明生成与生命周期，不是真PG trigger执行。
  八套件合计原后57 pass/234 expect，46个原DB例默认双库、11个原纯/原生例单跑；累计210→218。
  当前1932测试文件、628构库文件/1324调用、616构库文件无harness、397文件使用harness。
  T19f718→711：删除七条已无构造的路径，rfc189原5→1，合计减少27次；原scanner/豁免/负例保持。
- 任务页只改fastFilteredRootQuery中的七个SQL片段，生产净增7行；17个literal span中4处改变，
  16个动态表达式AST保持，逆替换七片段可逐字恢复整个原文件。roots只保留rid和MAX(started_at)，
  页边界/排序不变；existing fam带rid，两个匹配元数据在页内match_counts重建，再接回原paged。
  原限定条件、bindings、facets、qualified UNION、子数与快照保持；全局MAX/分组仍在。
  新文件2个DB例默认双库、1个受控PG编译例单跑，真实SQLite新旧原SQL/完整行、JSON、facets、
  cursor分页及事务回滚对拍；原源3 pass/277 expect，候选加六个原控制9 pass/1517 expect。
  原W19 golden/63种筛选和W21控制文件逐字保持。8次真实client边界提交、0次PG查询。
  两个/tmp单片段变异分别2 pass/1指定失败/68 expect、1 pass/2指定失败/43 expect，
  首次变异注入器因未命中片段只在自身计数失败，已排除；最终变异实际执行数据库查询并在
  原语义断言失败，恢复3/277通过。这些证据不等于原HTTP P95改善。
- Workgroup尝试用已有workgroup索引范围和test-only常量部分索引；两者虽改变真实SQLite计划，
  却改变完整结果数组与listActive/listVisibleActive的原顺序，因此均拒绝。生产owner保持原字节，
  probe移除；原SQL恢复控制3 pass/154 expect。没有增加生产索引、改原顺序或放松完整结果判据。
- W22原full HTTP `34243073181` / job `102117951237` / artifact `10064133565` 终态failure。
  官方ZIP12成员/160858字节，digest `88d59e03c7f6f4294c12b4914c064e55148d2279c5940331fc76b5dde6881dd1`
  与API及全部成员一致；8个原报告源与4个实际诊断/owner源逐exact d2c27 Git blob已核。
  原500仓库/10万任务/300万run/1000万event/10万delivery，六份五表全行原投影收据前后/跨库相等。
  每端点1 warmup+20轮×9×2=360 raw逐向量独立重算，floor P95仍为每20项最大值，完整comparison
  相同；comparable/fullAcceptance=true，acceptancePassed=false。

| 原full端点        | SQLite P95 ms | PostgreSQL P95 ms |
| ----------------- | ------------: | ----------------: |
| tasks-first       |       306.382 |           195.920 |
| tasks-second      |       201.131 |           151.151 |
| tasks-running     |        74.753 |            46.736 |
| repos-first       |         4.699 |             7.864 |
| repos-referenced  |         8.367 |            14.658 |
| reviews-pending   |         2.361 |             4.252 |
| clarify-pending   |         4.017 |             5.167 |
| workgroup-pending |        20.324 |             7.308 |
| overview          |         5.802 |             8.918 |

- repos-first/referenced、reviews、clarify及overview五项PG更慢；双库首/次任务页原150ms与SQLite
  工作组原10ms共五项绝对预算失败。本轮PG overview原10ms通过，但PG仍慢于SQLite，不能据此
  关闭AC11，不能把相邻运行的差值直接归因于编译复用。正确PG owner的三个builder/四次独立count
  保持；九份原稳定投影相等，末次完整body摘要八对相等、overview不同，timed body未上传，
  无法完整重哈希或猜差异原因。双profile完整且corpus不变、0错误，SQLite96语句/69计划、
  PG125语句/79计划；双HTTP→comparison→后置双profile→archive顺序保持，诊断不充当raw。
  bootstrap导出/恢复178表/10行互相关联，不能把它记成随后原规模语料的全量恢复证明。
- canonical入口1740、事务272/public983/symbols25049保持，imports5328→5327、exceptions4795→4794
  来自实际类型入边收缩。统一metadata首轮201 pass/2 fail，仅归档service直引db/query与旧精确
  import条目失败；改为既有mechanism的中立类型导出，账本只替换该条实际类型名，扫描器不变。
  次轮202/1来自第一次生成时已移除的原存量type入边未恢复；保留原type-only导入位置，恢复
  原已发布账目及解释，inbound保持原288，不新增入边/豁免，完整转译JS仍与原相同。
  中间去掉type的尝试被TS1484及类型导入lint拒绝，已弃置并留证，最终保留原type-only导入。
  最终完整backend tsc、定向lint/format、203项功能metadata/419 expect与13项canonical功能检查/
  55 expect通过；包含类型字面量与导入边界修正的最终候选和文档经过独立功能复核。
- 本批本地仅小型SQLite、纯编译/受控非网络调用与类型/源码检查，无本地PG/服务/性能/E2E/完整门禁。
  46个原DB例、PG故障DDL、两处异步加载及原预算夹具修复的真实PG，新SHA完整Main及原full HTTP
  仍待托管；AC1/6/8/9/11/12与完整RFC继续开放。历史W20误命令证据与限制原样保留。

### W12 第二十四批：成员读取投影合一、四套件迁移与精确托管复核

- W23 exact `dfb8427f38c50f146dac96e67172cc4ebb8a2a78` Main `34250474022` 首次终态
  37 success/3 failure，12个后端matrix与独立真PG全部成功，无cancelled。八Ubuntu为
  242/242/242/242/241/241/241/241，1932测试文件与exact Git tree及sorted-modulo8规则
  逐项相同，缺漏/额外/重复均0。44个官方Git blob、35路径最终manifest及四份贡献者清单已核。
  W23的46原DB例在两库各一次，11纯/原生例单跑，合计103次通过；三处PG故障trigger实际
  通过，两个异步preload通过，RFC314 PG计数例480.29ms满足原5秒预算。
- Ubuntu E2E shard1首次job `102143942414` 失败于测试二进制产物下载，Run e2e步骤明确
  skipped，实际测试执行/用例重试均0。只请求重跑该job，attempt2的job `102168690597`
  成功下载后首次实际执行168 pass/6 skipped/0 flaky/0用例重试。GitHub为其余作业换了
  databaseId，但38条执行起止时间逐字未变，仅目标E2E和required汇总重新执行；不能把这些
  换号记录计成后端再跑一次。attempt2终态38 success/2 failure，完整Main仍不能记绿，
  原下载失败保留，首次实际用例通过不写成业务flake修复。
- 再迁rfc128-p1-per-question-seal、rfc128-p5-0-stranding-guard、rfc136-reanswer、
  rfc271-call-selector-resolution四个旧套件。原/后各41 pass/148 expect，41原case、
  143完整matcher AST、14种seed表达式与195处原await及其位置保持；40原DB例默认双库，
  1纯例只跑一次，默认完整展开81次。只替换40次构库为harness.db，原种子和业务合同不变。
  317个实际SQLite INSERT后快照原/后743059字节相同，共464次重复行观察、18215字段、
  236 JSON字符串观察；这不是464个唯一种子行。原task观测所含的两列lineage显式保留，
  原root_task_id及node_run NULL保持。原生进程/同步生命周期套件不为减少账目强迁。
  累计218→222；当前1933测试文件、624构库文件/1284调用、612构库文件无harness、
  402文件使用harness。T19f只删除四条已无构造的路径，711→707、调用减少40；扫描器、
  原豁免及负例保持。行为迁移与机制专属用例仍须逐项区分，不能据此关闭AC6。
- Workgroup两个原成员投影callback共用既有workgroupPersistence内的workgroupDraftMemberOf，
  两入口原NULL-agent回退分别保留既有quarantine常量和空字符串；id/displayName/roleDesc
  属性创建、getter读取与成员顺序均不变。两整文件在展开实际helper后运行AST等于原版，
  8+37个其余顶层函数逐字保持，生产净减8行。新文件原/后7 pass/195 expect，加原W14
  控制共17 pass/257 expect；1个DB例默认双库、6纯例单跑。真实小库1组/3成员的完整行、
  原有序JSON及回滚后行均对拍。两种定点变异分别5 pass/2指定失败：错误回退及属性顺序
  变化均被原值/键序断言捕获，未把键序先红误称getter断言先红。
  PG私有函数由真实源码体和实际codec依赖作纯投影曝光，并非完整PG owner构造或真PG查询；
  真实双库执行仍待本批托管。没有宣称第三映射、整个owner、AC1或provider命名已经收口。
- 任务页反最大值实验保持完整结果，原/新各4 pass/582 expect；三项编译后真实SQLite
  负控分别证明跨root错误、max/min错误及同时间重复root，最后一项在limit50才指定失败。
  原16动态表达式、W23原7组逆替换与三个旧case AST保持。但tiny EXPLAIN显示page_roots
  仍用ORDER BY临时树，另增每行相关匹配集扫描，既有root索引未令它提前限页；没有证据
  能减少原10万匹配集热点，因此拒绝采用。只精确逆补丁本次独占SQL片段与W23新增oracle
  对，整个生产文件和原测试重新等于已发布字节；自建实验文件与完整证据保存到临时记录，
  不进入仓库/census/提交。没有通过放松全行结果、扩大预算或增加本地性能库来接受候选。
- W23原full HTTP `34257116051` / job `102165612706` / artifact `10069549446` 终态failure。
  官方ZIP12成员/163880字节，digest `84c01584693af94bfa07b99938c0230ad6b7acff408f3ccddf95e0eff71a61f8`
  与API及全部成员字节一致；8个报告源、4个实际诊断/owner源及workflow逐exact官方Git blob已核。
  原500仓库/10万任务/300万run/1000万event/10万delivery，六份五表全行原投影收据前后/跨库相等。
  每端点1 warmup+20轮×9×2=360 raw逐向量独立重算；原floor P95为每20项最大值，完整
  comparison相同，comparable/fullAcceptance=true、acceptancePassed=false。

| 原full端点        | SQLite P95 ms | PostgreSQL P95 ms |
| ----------------- | ------------: | ----------------: |
| tasks-first       |       279.594 |           181.010 |
| tasks-second      |       175.389 |           134.709 |
| tasks-running     |        57.552 |            45.752 |
| repos-first       |         7.965 |            15.233 |
| repos-referenced  |         4.451 |             7.698 |
| reviews-pending   |         1.604 |             5.480 |
| clarify-pending   |         1.415 |             9.109 |
| workgroup-pending |        18.051 |             7.745 |
| overview          |         3.805 |             7.799 |

- repos-first/referenced、reviews、clarify、overview仍五项PG更慢。两库首任务页和SQLite
  次任务页未满足原150ms，SQLite工作组未满足原max10ms，共四项原绝对预算失败。PG次任务页
  本轮134.709ms满足原预算，不能把相邻运行差值单独归因为W23页内元数据改动或关闭AC11。
  九份原稳定投影相等，末次完整body摘要八对相等、overview不同；原timed body字节未上传，
  不能重哈希完整body或推断差异原因。后置双profile完整、corpus不变、0错误，正确PG overview
  owner及四次独立count保持；原HTTP样本与后置计划wall分开，诊断不充当raw或相加。
- canonical入口1740、事务272、public983、imports5327、exceptions4794保持，symbols25049→25050
  仅来自上述实际共享helper，按该id说明增长。最终完整backend tsc、定向lint/format、203项
  功能metadata/419 expect和13项canonical功能检查/55 expect通过，并完成独立功能交叉复核。
  本批无本地PG、服务、性能、E2E或完整门禁；40原DB例及成员投影的真实PG和完整Main待新SHA。
  AC1/6/8/9/11/12及完整RFC仍开放，历史W20误命令证据与限制保持。

### W12 第二十五批：有限任务页前缀、Overview AST复用与真实并发夹具

- W24 exact `c24935b53f2ad97ee9dbb69ef6ab17a1edb94be3` 的Main `34263898340`
  首次终态38 success/2 failure；12个后端matrix与独立真PG全部成功，完整Main仍非绿。
  八Ubuntu为242×5+241×3，1933文件与官方exact Git tree及sorted-modulo8逐项相同，
  缺漏/额外/重复均0。34个官方Git blob、26路径发布清单与两份贡献者清单已核。
  四旧套件40SQLite+40PG+1纯例=81次通过；成员新例1SQLite+1PG+6纯=8次，
  原W14控制6SQLite+6PG+4纯=16次。E2E作业成功不另推断其用例重试数。
- 任务页先按原started_at/id索引读取4×(limit+1)物理前缀，以主键读取其中匹配行；
  如果全物理表已尽，或候选页齐备且最旧匹配时间严格大于物理尾时间，则采用前缀root聚合。
  严格时间间隙保证未见行不能改变入页root的MAX或遗漏更早排名；NULL/缺失rid仍在原
  LIMIT之前参与分组并占页槽。空/稀疏匹配、巨大家族、同时间切边及深cursor保留原全量
  MAX/GROUP BY回退。原过滤与facets不变，两分支和family在同一SQL快照；未称端点整体O(page)。
  page_rows参数显式CAST AS INTEGER，原16动态插值顺序保持，新增1或3个实际绑定单独投影。
- 新任务页文件12个DB例默认双库、2纯+1原生例单跑，完整展开27次。最终新文件15 pass/
  355 expect，连原W19/W23/W21共24 pass/1920 expect。原生产通过其中14个行为/纯例，
  原生机制例在原全量聚合上按预期失败；没有把原生产记作15例全绿。W23原33个完整matcher、
  7组逆替换与seed保持，W19/W21原字节不变。96条实际语句仅逆换新增span/绑定后逐字相等；
  34物理快照、496次重复行观察、每任务70列共371202字节相同。
  SQLite tiny计划为索引前缀+主键查找；在实际回退MAX输入注入依赖行的非法JSON，完备页
  不执行该分支，而原算法和深cursor回退指定失败。这是惰性回退证据，不是逐行计数或PG计划。
  三项真实SQL变异分别使严格间隙、过滤计数冒充穷尽、深cursor强制完备产生错误实际页行。
- Overview仅在既有私有builder缓存成功SQL AST，schema上下文变化时重建。原load整段
  字节/AST不变，四次独立count及每次sqlToQuery/prepare/all保留，原Number解码、参数数组、
  当前client/事务、异常、晚挂录制与stop后再挂录制均保持。固定夹具三次load的AST生成12→3，
  编译/prepare/all各12不变；不能把该计数当作HTTP P95收益。原/后8行560字段摘要相同。
  新文件原/后各4 pass/173 expect，加三个原控制为17 pass/656 expect；去掉schema失效条件
  的定点变异指定失败。2个DB例默认双库、2纯例单跑，受控39次无网络client调用不计真PG执行。
  首次统一tsc指出新seed含一个schema未知属性；仅删除该运行时未入库属性，同一最终测试在
  原/后重新通过4/173且整行摘要不变，生产源保持。首次类型失败留证，最终完整backend tsc通过。
- 再迁dispatch-multi-row-consistency、review-iterate-inherits-clarify-iteration、
  review-decision-full-asserts、structural-diff-empty-hint四旧套件，累计222→226。
  原30 pass/176 expect；最终30 pass/200 expect，保留30原case、166完整matcher AST、
  30种seed表达式、222处原await及全部timeout，增加8×3个真实并发前提见证。
  七写路径用原writerLease/PG同事务tasks与docVersions锁阻塞第一原请求；错误iteration例
  仅在原队列callback入口暂停，继续调用原callback及原查询/结果/错误。每例在第一仍未完成时
  发出第二真实请求，再释放屏障；没有把两请求改成前一个完成后的串行测试。后者是callback
  边界见证，不冒称行锁实证。252次实际INSERT后快照、358次重复行观察原字段与JSON相同；
  两列task lineage显式保留，实际默认数据库例30个均待本批托管PG。
- 当前1935测试文件、621构库文件/1280调用、608构库文件无harness、408文件使用harness。
  T19f707→704：删除四旧文件的5个构造，新增任务页原生SQLite机制例的1个真实构造并入账，
  未新增豁免。入口1740、事务272、public983、symbols25050保持；imports5327→5328、
  exceptions4794→4795仅为上述overview实际schema-context import，保留原classifier及解释口径。
  定向lint/format、203项功能metadata/419 expect、13项canonical功能检查/55 expect及独立复核通过。
- 本批没有本地PG、服务、E2E、性能或完整门禁。生产性能候选发布后按原full重测：原500仓库/
  10万任务/300万run/1000万event/10万delivery、1 warmup+20轮×9×2=360raw与原floor P95、
  每项PG≤SQLite及原绝对预算均保持。最近W23原full仍5/9项PG更慢、4项原绝对预算失败；
  W25真实PG计划、双库行为和原full效果待新SHA。AC1/6/8/9/11/12与RFC继续开放，W20历史限制保留。

### W12 第二十六批：工作组空表路径、取消窗口与剩余迁移

- W25 exact `26b43805b873a1f103192918a4b8c00bc041aa2b` 的Main `34269304467`
  首次终态33 success/4 failure/3 cancelled。后端matrix为8 success/1 failure/3 cancelled，
  独立真PG成功；完整Main仍非绿。八Ubuntu为242×7+241，1935文件与官方Git tree及
  sorted-modulo8逐项相同，缺漏/额外/重复均0；35官方blob与28发布路径及贡献清单已核。
  四旧套件30SQLite+30PG=60，新任务页27、Overview6、原W23页控制5，共98次全部通过。
  Ubuntu3在既有RFC215批/消息并发例返回awaiting_human；本批修复其可确定复现的取消窗口。
  三macOS作业取消，不能作为完整验证；rfc301首个功能调用归属扫描另有6.249s超过原5s的
  日志，后续仅保原语料/判据/预算优化扫描，未以扩大时限或重试替代结果。
- 原full `34269414114`、job `102206909486`、artifact `10074425853` 终态失败。
  官方ZIP 188670字节/12成员、8份报告源+4份诊断源+workflow精确blob、6份五表原投影
  receipt、360 raw和18组floor分位均已独立复算；相同机器、语料与计时边界保持。
  下表是本次原P95，单位ms；20样本的floor P95等于max，原绝对预算另行判断：

| 场景              | SQLite P95 | PostgreSQL P95 |
| ----------------- | ---------: | -------------: |
| tasks-first       | 201.970369 |     159.312264 |
| tasks-second      |  74.026891 |     107.673408 |
| tasks-running     |  80.880399 |      63.894685 |
| repos-first       |   3.791699 |       7.322796 |
| repos-referenced  |  10.929143 |       7.161466 |
| reviews-pending   |   4.057444 |       4.619205 |
| clarify-pending   |   1.917099 |       6.011827 |
| workgroup-pending |  22.191984 |       6.670512 |
| overview          |   3.836523 |      10.739894 |

PG更慢项是tasks-second/repos-first/reviews-pending/clarify-pending/overview；
原绝对预算失败是tasks-first两库150ms、workgroup-pending SQLite10ms、overview PG10ms。
原稳定投影九项相同，最后完整body摘要八项相同、overview不同；未上传原body，不推断差异原因。
诊断profile在全部HTTP样本后，不计入P95；跨run变化不能单独归因于W25优化。

- W26空工作组路径仅在原SELECT左侧增加既有workgroup索引的LIMIT1存在性输入，然后
  CROSS JOIN原tasks。`workgroup_id >= ''`保持空字符串；左侧空时不消费原右侧扫描，非空时
  保留全部原投影/谓词/数组顺序。未新增DDL、provider分支或第二语句。新6DB例默认双库、
  2纯例单跑；本地8 pass/321 expect。9次同事务原后对拍，每phase912次重复行观察、
  63840全字段及4560 JSON容器值相同；其中12非空返回行与W23原收据完整JSON及顺序相同。
  SQLite真实covering-index计划与行相关malformedJSON注入证明空输入惰性；旧模块和
  错误排除空字符串两个负控指定红。无网络PG编译不能代表真实PG计划/顺序或full收益。
- 共享原Workgroup成员十列mapper，保留默认truthy和Intent明确defined的空字符串区别，
  原属性/getter/ID求值顺序不变；两生产源净减10行。新原/后14 pass/80 expect，与两个
  原控制合跑30/347；17真实写入后的36次重复完整行观察、547字段与SQL/绑定/JSON均相同。
  两默认DB例真正执行SQLite完整Intent create/update/replay和写后rollback，PG待托管。
- 既有ProviderNeutralDatabase的node rollback模块及三个符号改为中立名称；两生产文件
  整体逆改名逐字恢复，343行保持，真实DbTxSync邻接实现不变，不算合一两份算法。
  T17命名账目61→60，provider-specific依赖原扫描1→0，原服务边界及observer source锁同步。
  五新DB例原/后5 pass/29 expect，9份真实快照中840字段与完整JSON相同；observer只验
  无context时零SQL，未宣称覆盖实际有context的PG effect执行。
- 取消修复只在驱动await load后增5行，复用原inflight allSettled再返回canceled。
  正式两新DB例仅延迟真实persistence.load/commit的continuation，不替换数据或返回值：
  原生产1指定红/1绿，修后新2+原RFC21512共14 pass/89 expect；删除等待在途提交的
  定点变异指定红。确定序列的旧running卡快照触发clarify-or-delivery分支；PG历史日志没有
  轨序，未声称该序列就是历史失败的唯一原因。原RFC215全字节、12case/66matcher及预算保持。
- 再迁cross-clarify-designer-rerun-no-rollback、rfc164-workgroup-core、
  rfc318-minimal-digital-employee-tool-contracts三旧套件，累计226→229。5原DB例默认双库，
  58静态声明/200完整matcher/7seed/53非provider回调AST保持；运行展开为5×2+61单跑。
  本地只执行5DB+原cross source guard，原/后均6 pass/21 expect；其余60展开例未本地执行。
  53次真实INSERT/UPDATE快照、221次重复行观察、5568字段/1374 JSON容器值一致。
  当前1939测试文件、618构库文件/1277调用、605构库文件无harness、415文件harness；
  T19f704→701，无新增构库豁免。入口1740/事务272/public983/imports5328/
  exceptions4795/symbols25050保持；两原commons-debt边按新路径登记，opaque解释未改。
  T19d只更新实际引用三条；T72具名登记三个固定输入/字段夹具，并保原matcher及exact key锁。
- 首次统一tsc三处新测试类型错误已用索引非空断言及Promise显式泛型修正，完整emitted JS
  均保持；首次metadata五处账目差异已按真实扫描修正。原失败日志留证，最终完整backend
  tsc、207项功能metadata/427 expect、13项canonical/55 expect及定向lint/format通过。
  本批未运行本地PG、服务、E2E、性能或完整门禁；新SHA真PG与原full待托管，原语料、
  1 warmup+20轮、9端点、原分位和所有比较/绝对预算不变。AC1/6/8/9/11/12继续开放，W20历史限制保留。

### W12 第二十七批：有限前缀回接、旧行为迁移与真实PG回归修正

- W26 exact `072c8f575125ae1d6818008339c74527c3fe8d3a` 的Main `34275439627`
  首次终态35 success/5 failure；后端matrix为9 success/3 failure，独立真PG成功。
  八Ubuntu为243×3+242×5，1939文件与官方Git tree及sorted-modulo8逐项相同，
  缺漏/额外/重复均0；45官方blob、38发布路径（37现存）及贡献清单全部吻合。
  选定78次执行为75 pass/3 fail：5原DB例两库10次、成员映射16、空工作组14、
  原RFC215两库24全过；node rollback为9过/1PG红，新取消例为2SQLite过/2PG红。
  初始全绿假设在真实红处停止，终态证明按同一批原日志如实计数；组外3条失败汇总
  echo不重复计入。macOS2另有daemon-start共享beforeAll在5.016s超时，未放宽预算。
- 原full `34275678736`、job `102227981265`、artifact `10076887975` 终态failure。
  官方ZIP 189595字节/12成员、13官方源、6份原五表receipt、360raw及18组floor向量
  已复算。仍为500repo/100ktask/3Mrun/10Mevent/100kdelivery、1 warmup+20轮×9×2；
  20样本的floor P95等于max，原每项比较与绝对预算保持。P95单位ms：

| 场景              | SQLite P95 | PostgreSQL P95 |
| ----------------- | ---------: | -------------: |
| tasks-first       | 210.681046 |     144.101563 |
| tasks-second      |  75.240840 |     102.828192 |
| tasks-running     |  84.020611 |      59.060077 |
| repos-first       |   3.986530 |       9.005290 |
| repos-referenced  |   7.197568 |       7.958691 |
| reviews-pending   |   1.964125 |       4.486079 |
| clarify-pending   |   1.708457 |       5.791102 |
| workgroup-pending |   4.999062 |       6.030970 |
| overview          |   5.253851 |      11.883893 |

七项PG更慢为tasks-second/repos-first/repos-referenced/reviews-pending/
clarify-pending/workgroup-pending/overview；原绝对失败为SQLite任务首页P95<150ms、
PG overview max<10ms。九项稳定wire相同，末次完整body摘要八项相同、overview不同；
未上传原body，不能推断原因。后置真实PG workgroup计划的左Limit/索引rows0、loops1，
原右tasks索引扫描loops0；这是实际惰性机制证据，不是HTTP样本或跨run因果归因。

- W25真实PG root_prefix仍Hash Join扫描100000任务；W27只把一个SQL字面span改为
  有界physical prefix的两个精确ID标量lookup。独立matched_id保留NULL rid，不新增LIMIT；
  原18插值及参数顺序、同SQL快照、certificate/strict gap/cursor/fallback/facets保持。
  新8DB+2纯例与四原控制，本地原34 pass/2088 expect、候选34/2092；差异仅原W25
  SQLite计划锁增加精确两次PK探测。25份原后完整观察、26684字段及665879字节一致，
  22次真实SQLite语句与6次真实PG客户端编译均保绑定；两错误SQL负控指定红。
  PG编译控制不算PG执行；真实PG计划与原full收益待新SHA，未宣称延时改善。
- 合并原task/repository-retry两处diagnostic文本体到已共同引用的util/errors，三生产
  文件净减6行；原5调用、所有非修改AST、继承stderr/getter访问顺序与异常identity保持。
  原/后纯6 pass/136 expect，两实际Bun负控指定红；仅覆盖文本体，不算Git/DB行为覆盖。
- rfc301功能调用归属扫描仍全读1797源文件，并保持四名称、原matcher和已有inventory缓存；
  只在四个ASCII名字及反斜杠全部缺席时跳过AST，且不构建parent links。原8case/19完整
  matcher/5秒预算保持，新2纯例覆盖转义回退。冻结语料parse1797→307，后续三诊断源及
  task query差量对拍使最终308；util/errors新增原样换行转义触发保守准入，原逐文件计数
  仍相同。旧4/8、新6/12与逃逸负控有效；macOS时限是否满足仍待新SHA。
- node rollback的唯一PG红是排序SQL锁漏掉实际agent_workflow schema。原5DB/29matcher
  只修一处regex参数，精确接受既有两限定形式并拒绝错schema/表/列/方向；原840字段观察
  及完整原文件逆换相同。实际PG日志SQL新纯正控先指定红，最终SQLite+纯例7/45过；
  这些字符串例不冒充新PG执行，生产未改。
- 新取消夹具原第三次load在PG可能先于batch claim/start提交而读到open。仅测试改为
  真实running提交确认后放行消息轮、按真实running卡选一次load窗口；原2case/17matcher/
  6seed、host返回及5秒预算不变。原后SQLite均2/17；延迟真实原commit能使旧夹具两例
  open不等于running指定红，同控制候选绿；删除原生产post-load取消检查或等待提交也红。
  28真实写SQL/绑定与28快照、36重复行、1174字段和38 JSON字符串原后相同，生产未改。
- 再迁lifecycle-invariants-current、rfc355-intent-apply-changeset-validation、
  rfc310-task-lifecycle-events三旧套件，累计229→232；14原DB例默认双库，原后14/25，
  14case/25完整matcher/8seed保持。84真实写观察、144重复行、4369字段与82 JSON相同；
  只12次task种子的两lineage字段显式等于旧trigger结果，64个node_run NULL观察保持。
  rfc310仍为原一次成功CAS→真实committed event→dispatcher→两订阅，不新增CAS-miss
  证明；4份完整订阅结果原后相同。原invariant checker为test-local，未宣称生产owner覆盖。
- 当前1941测试文件、615构库文件/1274调用、602构库文件无harness、419文件harness；
  T19f701→698。入口1740/事务272/public983/imports5329/exceptions4796/symbols25049；
  一个新具名util引用据实登记，两个旧私有体成为一个共享体。T19d两个PG引用/构造计数
  各增1；原阈值3未改，ArtifactLifecycle的3vs6使观察名单4→5，Operations为21vs7。
  这是实际静态代理债务，不能当PG操作已执行；无新provider豁免，T72原表不改。
- 补正W26临时AST serializer的truthy callback早停：empty原6DB callback内24个matcher，
  全文件连helper及纯例37个；早期AC6 inventory同类问题已重新独立核对。最终AC6保真
  脚本原本用正确void遍历，新独立收据再证200完整断言、58名称/预算、53未迁回调均等。
  原manifest和失败证据保留，源码逆换、真实SQL/全行证明未受影响，也未重跑行为测试。
- 最终完整backend tsc一次通过且15个候选代码路径前后hash不变；207功能metadata/
  427 expect、13canonical/55 expect、定向lint/format通过。初始账目/具名RFC/growth
  差异与实际修正留证；候选新SHA真PG、完整Main、原full仍待托管。AC1/6/8/9/11/12
  与RFC继续开放，W20历史限制和全部原验收保持，无本地PG、服务、E2E、性能或完整门禁。

### W12 第二十八批：共享快照与cutover、facet索引及可见前缀限额

- W27 exact `69a22bdc49b7e88219e4b4499ee45333273d7689` Main `34281654403`
  首次终态33 success/7 failure；后端matrix为7 success/5 failure，独立真PG成功。
  八Ubuntu为243×5+242×3，1941文件恰一次；40官方源blob、33发布路径及7贡献清单一致。
  74选定执行72 pass/2 fail：14个原DB例两库全过，node rollback、取消、扫描和诊断
  选定控制通过；两红仅W27新prefix例的PG raw BIGINT为字符串1000/1200而预期数字。
  本批保留生产raw值，修正两预期及类型；完整原/新查询结果比较、原断言与5秒预算不减。
- 其他可归因功能失败：T72旧task insert位置3530→3531使Ubuntu2/macOS2各红，
  本批只同步一行观察位置，四入口和三列合同不变；rfc287旧源码锁仍找task内私有函数，
  改为解析真实util/errors具名导入及导出定义，另57例与原调用断言保持。
  rfc257第二次投递只等cancel即读取running可能过早；相同wait同时等第二delivery的
  实际launched记录，原12完整matcher、其他3例、4秒等待/25ms轮询/5秒case预算保持。
  该修正仅做提取回调的5个受控读证明，未本地执行E2E，也不推断最终生产启动失败。
- runtime-freeze的PG additional database清理仍在原60秒statement预算失败。真实日志
  观察到DROP等待CheckpointStart、blocked_by为空，与checkpointer的DataFileSync重叠；
  长checkpoint总204.713秒，随后force-wait checkpoint2.165秒。单次无holder快照不证明
  无任何竞争，也没有app连接泄漏证据；本批不改清理过程/超时，不重跑本地PG。
  macOS扫描选定6纯例通过，实际startTask扫描1454.38ms，保留原5000ms预算。
- 原full `34281807637` / job `102248097957` / artifact `10078914111` 终态failure。
  ZIP 193181字节/12成员，13官方源、6份原五表receipt、360raw及18个floor向量已复算。
  原500repo/100ktask/3Mrun/10Mevent/100kdelivery、1warmup+20轮×9×2完全保留；
  floor P95为20样本max，逐端点PG≤SQLite及原绝对预算均未改。P95单位ms：

| 场景              | SQLite P95 | PostgreSQL P95 |
| ----------------- | ---------: | -------------: |
| tasks-first       | 229.836804 |     342.647363 |
| tasks-second      | 104.367241 |     167.220980 |
| tasks-running     |  79.862680 |     219.512501 |
| repos-first       |   6.001548 |       9.214916 |
| repos-referenced  |   3.581452 |       5.942600 |
| reviews-pending   |   1.691195 |       4.110121 |
| clarify-pending   |   1.409721 |       5.428680 |
| workgroup-pending |   5.119502 |       9.454392 |
| overview          |   7.445461 |       8.837592 |

九项PG均更慢；原绝对失败为SQLite任务首页与PG三项任务页。九稳定wire相同，八项末次
完整body摘要相同、overview不同；未上传raw body，不能推断其原因。
后置真实PG plans10/13/14（零基）中lookup实际204行/1loop、估算10000行，JIT总时间
分别193.223/125.202/145.865ms；这些诊断不属于HTTP样本，不相加或称P95唯一原因。

- physical_prefix仅将CTE子查询LIMIT替换为直接CAST绑定原同值page_rows预算，新增第7
  绑定，原18表达式顺序保持（历史W23为16）；其他源字节可逆精确恢复。W25/W27原25例
  527 expect→25/541，仅新增14次等值预算检查，原seed、断言、预算与父BIGINT修正保真。
  37份整行快照、567重复行/38934字段/1677 JSON、37有序结果及89 SQL/绑定逆换精确；
  错预算0在真实SQLite完整结果断言指定红。真实PG执行与计划改善待新SHA。
- 新idx_tasks_list_facets_cover覆盖原五列，SQLite0226+PG0002由原生成器及replayer
  产生；225旧journal条目、245历史文件及单索引候选的3个查询入口保持。
  新6例本地6/200，原history/counts25/141；972重复行/61236字段/2700 JSON与62实际
  SQL/绑定相同；删status列的实际索引负控在coverage断言红，结果行仍相同。
  直接预算结合索引的同6例6/200通过。8次真实PG客户端编译不冒充执行；两生成合同
  在原69a和候选均不符合直接Prettier检查，保留原生成器字节，未宣称全体格式通过。
- Workgroup三入口共享workgroupSnapshotValues，原解码/排序/leader/default差异和
  switches复制或原引用保持，members回调仍最后求值。原后32 pass/466 expect，
  61真实写观察、250重复行/2998字段/227 NULL/127 JSON及SQL完整字节相同；两个负控
  指定红。生产净增4行，不把旧函数跨度当删除量。资源包外层rollback证明DB回滚，
  原文件准备跨await仍有SQLite诊断，未声称文件系统回滚或无外部await。
- 原唯一SQLite cutover CAS进入共享program，新增真实异步adapter；原一算法仍一算法，
  不记作删除PG重复体。三生产文件净增28行，8个其他函数及四CAS谓词/输入/错误顺序
  保持。RFC341原5例25matcher保持，仅2个delivery例接入默认双库，native/pure3例原样。
  新9双库DB例本地与原append控制共25/138，39观察/111完整行/781字段/5 JSON/
  149实际SQL和绑定原后相同；去mode/epoch实际SQL负控各红。native trigger changes=2
  在原后均触发原exactly-one判断；readback删除例是同事务受控干扰，非外部PG竞争证明。
- 全量census1944/615构库文件/1274调用/601无harness/423有harness；T19f698、
  provider命名文件60和登记9对不变。canonical1740/272/983/5329/4796/25052；新增共享
  snapshot/cutover符号及原helper迁移净增3，身份4增1减据实登记，无新provider豁免。
- 最初统一backend tsc只在新snapshot测试异步闭包的可空spread报TS2769；仅补一个
  非空类型断言，完整emitted JS字节相同。修后统一tsc通过，24候选路径前后hash相同。
  首轮metadata为210过/1红：前波inverted-pairs一次性增长许可过期，删除后211/433通过；
  canonical13/55通过。定向源lint/format及独立代码、metadata、文档复核完成；两生成合同和RFC294
  status的原/候选直接Prettier均红，保留原生成器字节及精确投影，格式限制单列。未跑本地PG/服务/E2E/性能/完整门禁，原W20限制保留；本批新SHA真PG、
  完整Main及原full待托管，AC1/6/8/9/11/12和RFC保持开放。

### W12 第五十二批：共享完整apply锁、修复PG任务Git合同与诊断时间窗

基于已发布 `aac18f56025ed66c8a621fc5fe2803adcc3412ee`。

资源包两处完整 `withApplyLock` 算法共用 `resourcePackageApplyLock.ts` 的工厂。
两个原模块分别初始化独立Map，保原key、完整回调、两个await以及最后waiter清理chain的次序；
lower/apply业务、事务、FS及收据不变，锁切片生产净减14行。
原两完整函数与新函数接受同一组受控Promise输入，三版各21条完整观测与66条Map事件相同。
四项指定负控中，跳过前驱等待和错误chain比较触发实际断言失败；漏释放及合并锁域
由纯控制的96次Promise推进上限识别为未完成，不冒称产品超时或托管runner红。
旧RFC271源码锁只把读取位置指向共享owner，原标题/3条matcher/预算保持，原红后1 pass/3 expect。

W51新增9个PG HTTP失败均经过同一系统任务Git元数据校验链。W52修正PG任务启动适配器的
null投影合同；三个控制执行真实查询构造和launch内核，使用记录SQL的连接与无文件端口，
3 pass/21 expect，原7例未执行。没有运行真实PostgreSQL、应用或HTTP，九个原失败仍待新SHA验证。
`test-suite-policy`仅把submodule分组后的实际skipIf站点账目从1更新到2，原条件、7例及预算保持；
唯一原库存断言旧红后1 pass/1 expect，不是增添skip或放宽规则。

后置诊断capture新增performance时钟原点和请求起止值，沿用原wallMs结束点；
EXPLAIN仍在每次请求capture之后。两个纯控制2 pass/56 expect；正式360个HTTP样本、
20轮、warmup、P95判据及归档次序不变。CPU时间轴对齐仍待托管，未得到新性能改善证据。
本批新增9个纯例（lock4/timing2/Git3），仅增加两个测试文件，未迁移旧DB套件。
实测1964测试文件、596构库文件/1165调用、516无harness/514有harness；T19f保持679。
生成投影实测mutation entrypoints为1740→1739，imports为5332→5333、generated exceptions为4799→4800，
owner总数25067保持，生产文件1802→1803。新增import为PG launch引用既有SYSTEM_USER_ID常量，
用于普通系统任务空Git快照合同；仅两项对应账本登记本批一次性allowGrowth，旧why与规则保持。
首轮backend编译报告新增Git夹具的launchKind标签错误，原失败记录保留；修正后最终10个core
backend tsc通过且hash保持。metadata首轮217 pass/4 fail：新lock行为测试漏登记导致3红，
PG INSERT旧行号762→766导致1红。补一条行为守卫登记（200→201）及原行号后，
相关四文件定向62 pass/106 expect通过，原217成功结果保留，未重跑完整metadata。
最终core为11个，多出的旧行号guard仅字符串位置更新，由定向Bun检查覆盖，未再跑整包编译。
canonical原13 pass/55 expect通过，生产/canonical主投影未变，复用该收据。
metadata格式检查只有生成的RFC294/status.md失败，HEAD原输出同样失败，保持实际renderer输出；
其余12个JSON与新增lineage guard格式通过，不记为全部13份metadata格式通过。

[W51 Main 34424041887](https://github.com/wangbinquan/agent-workflow/actions/runs/34424041887)
终态35 success/5 failure，13个后端中10 success/3 failure；主集2131/2140通过，
旧1798/1798通过、新增333/342通过，9个PG HTTP失败完整保留。两OS各1962原文件无遗漏/重复；
另2例及原hook18例通过。原skip账目在两OS失败，单列在2140主集之外；其余失败只保任务元数据。

最新性能终态仍为[W49原full34417550874](https://github.com/wangbinquan/agent-workflow/actions/runs/34417550874)：
九端点两库绝对预算全部通过，六个PG端点仍相对较慢，严格AC-11未达成。
W49 CPU子进程属于comparison之后的诊断，包含请求、EXPLAIN和完整有序语料receipt；
`perf-seed.ts`的主要被采样调用是receipt摘要读取，不应仅因文件名把这些样本当作实际播种。
客户端CPU热点也不能直接归因于正式HTTP端点或当作PG服务器CPU。

证据入口：`/tmp/rfc359-w52-resource-package-lock-final-manifest-dirac.json`、
`rfc359-w52-profile-timing-root.json`、`rfc359-w52-task-git-metadata-manifest.json`、
`rfc359-w52-skip-count-handoff.json`；W51终态为`rfc359-w51-hosted-final-delivery-planck.json`。
本批未运行本地真实DB/App/HTTP/PG/Git夹具或完整门禁；新SHA托管行为待验。
原历史、验收判据与状态保持，AC-1/6/8/9/11/12及整个RFC继续In Progress。

### W12 第五十五批：资源快照共享、SQLite原语归位与澄清上下文修复

基于已发布 `3fad84efa451b5e0747aff8b8d7428a013cb2808`。14个旧测试文件保留65个原声明/339 matcher；
51个DB声明/278 matcher接默认双库，14个原例/61 matcher保原单次注册和全部预算。
63个完整原call原文保持，另两例仅适配内联任务种子；实际提取函数的54组受控验证、813次断言记录
及两项预期负控已封存。原业务callback只登记而未在本地执行，写入对象观察不冒充实际SQL或物理行。
9次构库调用及8个构库文件退役，T19f664→656；当前1968测试文件、573构库文件/1131调用、
483无harness/547有harness。这是入口清点，不将原生机制、已登记差异或未分类文件全部算作待迁业务。

两个普通资源读取owner的workflow/agent/workgroup三对完整快照函数逐字相同，收为一个共享模块，
保原7个生产调用、4/21/14个字段的完整投影及同步Object.freeze合同，无查询、事务或await变更。
两owner整源逆还原通过；新纯回归3 pass/291 expect，原两侧与共享函数9组实际提取对照/873 expect一致。
三个freeze→seal源变异在同纯断言内被拒绝；它们是受控脚本捕获的真实matcher错误，不是三个runner红。

SQLite迁移器、写入重试与committed-event同步解释器3个真实引擎原语移至platform/persistence，
原函数body和导出不变，旧3路径移除，消费者import及对应源码路径锁同步更新。T17从59降至56，
这是实际原语的落位，不冒称减少三份业务实现或删除原有效能力。

[W54 Main34433766182](https://github.com/wangbinquan/agent-workflow/actions/runs/34433766182)
终态34 success/6 failure，13后端10过3红。主2368个预期身份全部出现，2353过/15个新PG红，
原2227身份全过；新增43个PG身份中28过15红。两OS各1966原文件完整，独立2/2及原hook18/18通过，
RFC259原例两OS通过，两个原Playwright身份在两OS首次通过；这些定向结果不等于完整Main通过。

15个新PG澄清失败已定位真实字段转交缺口：nodeMechanics原三处已传executionContext，
mechanics common与CreateRoundCommon没有接全。本批两生产文件补显式转交，采用显式值??ambient回退；
原15测试、原断言和全部预算保持。实际完整函数配fake ports原4 pass/2 fail/32 expect，
修后6 pass/60 expect，仅验证字段转交及回退合同；实际PG业务修复仍待本批新SHA托管。
本批新增2个纯测试文件/9个纯例（快照3、澄清6）。39core首轮编译因注册遗漏beforeEach import未过；
补回该import后最终39core backend编译通过且候选hash保持，原失败记录保留。相关4个metadata/guard文件
63 pass/111 expect与canonical功能子集13 pass/55 expect（11 filtered）通过，最终52个候选hash稳定，
13份生成投影完成刷新。新SHA真实PG业务及完整流水线结果仍待托管。

W54原full34433823331仍由唯一watcher跟踪；最新已核原full仍为W52 run34427756137，
360样本/18组P95中SQLite tasks-first P95 150.616ms未低于原150ms，
PG workgroup-pending max 11.571ms未低于原10ms，其余16绝对项通过，六PG端点相对较慢。
保持原full语料、P95与相对判据；请求CPU诊断不构成性能改善结论。

**后续边界**：按用户要求，W55发布后停止新增RFC实施批次，只修流水线失败并验证对应exact SHA。
RFC-359保持In Progress，AC-1/6/8/9/11/12继续开放；本批发布不代表这些剩余判据已完成。

### W12 第五十四批：复用执行夹具、收口registry装配与请求CPU诊断

基于已发布 `4cbc2eed495d58516db7cb071648036c4e144773`。12个原测试文件保留44个声明/236 matcher；
42个DB声明/232 matcher接默认双库，原kind循环展开43个DB运行身份，2个纯例/4 matcher保持单次注册。
44组实际提取函数的纯控制记录671次Node断言调用，包含两次预期的负控断言失败；
两种provider各43个登记身份来自实际提取的注册函数，均不冒充真实业务数据库执行。
全部原断言、输入和预算保持。加入标记发布纯回归后，共1966测试文件、581构库文件/1140调用、
497无harness/533有harness，对应此前593/1152及509/521，12个构库文件退役，T19f及账本676→664。
这些入口计数不直接代表剩余普通迁移量；原生机制和已登记差异不因此转为待合一业务。

runtime-registry的两个wrapper拥有逐字相同的body，同一DrizzleRuntimeRegistryPersistence已接中立数据库。
本批保留一个同步中立factory，删除另一wrapper及PG专属类型import；3个生产文件/5次调用与
12个测试或helper文件/14次调用只换callee/import。每次原构造、返回、惰性fallback与错误传播保持，
底层service、持久化方法及查询/事务原样。原两factory与新factory的18份受控记录一致，129个Node断言通过；
错误数据库变异在passing纯例内被断言拒绝。W29旧完整body digest在改名后真实失败，新增唯一接线检查和
精确callee逆映射后8 pass/46 expect，原8个完整call、9个digest保持；wrong import/callee/db三个变异
均在新helper校验处抛错，不冒充已经走到原digest matcher的失败。所有旧literal与注释保持。
此次符号收口不减少provider命名文件数；background登记338→337与symbolOwners25067→25066
是重复factory对应的生成投影变化，不表示删除真实后台任务。

性能切片只修改后置诊断：每request使用真实bun:jsc.profile，以100us采样覆盖请求与读body，
EXPLAIN在窗口外；移除整进程采样旗标，正式bench、corpus、seed与comparator四个文件逐字保持。
实际Bun1.3.13接口5 pass/112 expect，Node端口控制36 request/36 EXPLAIN，保原返回及错误对象。
这些不是全规模测量或性能改善证明；真实Bun1.4原语料profile仍待本批托管。

[W53 Main34430614669](https://github.com/wangbinquan/agent-workflow/actions/runs/34430614669)
已终态36 success/4 failure，13后端12过1红、普通lint通过。主2227/2227、独立2/2及原hook18/18通过，
新21个PG例、旧九PG HTTP及两OS W29共16次均通过；两OS各1964原文件完整。
macOS4另一个原rfc259测试在收到取消通知后读到running行0、原期待1；同原callback在W52两OS及W53 Ubuntu通过。
已确认dispatcher原顺序是await cancel→await launch→recordFire terminal，原通知本身尚不能证明后继INSERT完成。
本批将原测试等待点改到第二delivery终态fire，保13原matcher、输入、4000ms等待预算及默认case预算，
新增一个launched/null matcher。4组纯端口控制/39次Node断言覆盖原等待在空窗断言失败、候选等到后继后通过，
以及真实launch失败和双running两个候选负控被断言拒绝。该证据不将历史失败称为flaky，也不裁定历史后继结果。

W53 Playwright macOS另有标记文件读取窗口：existsSync之后JSON.parse读到未写完内容。
E2E专用writer改为同目录临时文件写完后rename发布，原编译/环境条件、载荷及永不resolve合同保持，
所有原Playwright源码、输入和预算原样。实际writer配显式fakeFS的同一纯回归中，旧实现1过2红，
在写入未完或失败时最终路径已经可见；修后3 pass/22 expect。两项CI修复的真实macOS结果均待新SHA托管。

初始35core完整backend编译通过的原收据保留。加入上述两项CI修复后，最终38core完整backend编译通过，
候选hash保持；四个受影响metadata/guard文件63 pass/111 expect、canonical功能子集13 pass/55 expect
（11 filtered）通过。最终writer完成，13份生成文件刷新（8 canonical、4 metadata及RFC294 status）。
本批本地验证限源码、实际提取函数及受控端口，新增双库业务、两项CI修复和原语料采样待真实托管。

最新已核原full为W52 run34427756137/job102716502396：360样本/18组P95，
SQLite tasks-first P95 150.616ms未低于原150ms、PG workgroup-pending max 11.571ms未低于原10ms，
其余16项绝对预算通过（PG overview9.473ms）；repos-first、repos-referenced、reviews-pending、
clarify-pending、workgroup-pending及overview六个PG端点相对较慢。原full判据不变，
本批CPU采样不构成代码回归原因或性能改善证据。AC-1/6/8/9/11/12继续开放。

### W12 第五十三批：普通查询与原执行拓扑继续接入双库

基于已发布 `5ab4ecb83871f27cc86c7231cf0fffbd7f019da2`。7个旧测试文件保留40个原声明、
122个回调matcher及1个原helper matcher；21个原DB声明/60个回调matcher接默认双库，
19个原声明/62个回调matcher保持原注册，全部原预算保留。

查询部分包括工作流验证上下文、引用解析和任务列表的11个原例；分页helper只改数据库参数类型。
任务种子沿原task构造器，provider端显式给出原SQLite INSERT触发器生成的两项谱系字段，
保留根与两级子任务的顺序及原未赋值字段。纯控制核对14个原构造输出及原/后setup等待，
不把这些结果称为新观察到的物理数据库行。初次包装跨越原describe边界的问题已由AST检查发现，
按实际原组拆分后，六个选定验证上下文例均进入默认双库范围，原保留例与预算未变。

另外四个原执行测试文件保留原参数、调用和断言。PG通过完整应用的有限初始化建立真实provider拓扑，
新增既有intent提交、claim、attach取得executionContext的准备，等待drive/release及终态收尾，
dispose先于harness释放；SQLite继续原完整拓扑。两个已默认双库的task-catalog文件保持原样，
不重复计入本批迁移。实测1964测试文件、593构库文件/1152调用、509无harness/521有harness，
对应此前596/1165与516/514。无harness总数只用于定位入口；其中的native机制、纯测试和
已登记机制差异不直接算作剩余普通业务迁移或业务合一数量。

首轮15core整合编译因新PG夹具未提供driver必需的executionContext而失败；补齐上述真实执行链后，
最终backend编译通过且候选hash不变，原失败收据保留。四个受影响metadata/guard文件及W29纯装配
共71 pass/157 expect，canonical13 pass/55 expect通过；这两项检查发生在PG上下文修正前，
其生产输入、守卫与metadata未随这次测试helper修正变化，复用原收据，不冒充完整metadata门禁。
T19f及对应账本679→676；八canonical与RFC294 status原字节保持，只更新四份metadata的
provenance/账本并移除W52两项到期增长标记。新SHA真实数据库与执行行为待托管。
执行拓扑的实际提取函数与受控端口共19组/152个Node断言通过，包括连续launch/resume及driver错误的收尾；
真实coordinator和提取lifecycle使用受控claim token，不据此声称真实DB认领或TaskEngine已验证。
本地仅运行必要的源码及受控纯端口验证，没有运行原业务数据库、App、HTTP、PG或进程夹具。

[W52 Main 34427299579](https://github.com/wangbinquan/agent-workflow/actions/runs/34427299579)
已终态38 success/2 failure，13个后端和普通lint全部通过；主集2164/2164，另2/2及原hook18/18
全部通过。九个W51旧PG HTTP失败均恢复；三条旧guard两OS共6/6通过。
完整Main仍未全绿。最新W52原full [34427756137](https://github.com/wangbinquan/agent-workflow/actions/runs/34427756137)
及job102716502396终态失败，360样本/18组P95已按原判据核验。SQLite tasks-first P95 150.616ms
未低于原150ms，PG workgroup-pending max 11.571ms未低于原10ms，其余16个绝对项通过，
其中PG overview为9.473ms，低于10ms。repos-first、repos-referenced、reviews-pending、
clarify-pending、workgroup-pending及overview六个PG端点仍相对较慢。
这些结果与后置CPU采样不直接证明代码回归原因或性能改善。
AC-1/6/8/9/11/12继续开放，原验收标准与时间预算不变。

### W12 第五十一批：扩大资源包、仓库与任务HTTP双库覆盖

基于已发布 `50b062d034bfe677b96d206edcbd3593c6a3b590`。

16个旧测试文件保留186个原声明/549个完整matcher，其中114例/329 matcher接默认双库，72例/220 matcher保留原行为与预算。1962测试文件，直接构库596文件/1165调用，无harness532→516、有harness498→514；T19f及对应账本685→679。
A组8文件109声明/331 matcher，选48/136、保61/195；repository组3文件34声明/104 matcher，选29/90、保5/14；HTTP组5文件43声明/114 matcher，选37/103、保6/11。
选定声明没有新增循环展开；多数据库fixture不作为多份业务用例计数。原skip与超时预算保持。
原完整测试AST在精确构库替换和必要await逆变换后保持；A组61个保留call逐字一致。
repos一个保留call随fixture作用域调整缩进，按完整打印AST相同核对，不宣称所有保留源码逐字一致。
repository两个纯native组中的DB分配经无消费证明退役，原其余准备、Git/FS操作和原用例保持。

四文件七个DB参数改为既有ProviderNeutralDatabase，三个type import调整；完整文件除列举类型变更外逐字保持，Bun/TypeScript运行JS相同。
所选HTTP fixture等待完整provider应用初始化；repair只为provider任务种子补原SQLite触发器产生的两项根谱系，原nodeRun输入保持。
独立复核发现multipart与repository两个provider组的同层afterEach会先释放harness；最小修正为新增内层describe，保证原abort/dispose/目录环境清理先于harness释放。
实际Bun纯hook顺序控制与提取函数的受控端口记录用于这一步验证，不代替真实DB/App/Git行为。
初次repository lint发现两个无消费者DB变量；以证明后退役分配修复。multipart初次lint发现finally内throw；错误汇总移入dispose helper，原失败收据保留。

21个core完整backend tsc通过；两份测试清理作用域修正后最终backend tsc必要复验通过且候选hash不变。功能metadata 221 pass/452 expect与canonical 13 pass/55 expect通过，生产源/元数据未随后续作用域修复变化，复用该验证。
13份metadata只变原sourceDigest/provenance及对应T19f基线685→679，原why/其他条目/规则保持，未增加例外。
生产源在后续两文件测试作用域修复期间保持；按受影响内容进行必要验证，不因HEAD移动重跑完整门禁。

[W50 Main 34420342896](https://github.com/wangbinquan/agent-workflow/actions/runs/34420342896)：
W50 exact50b062d034bfe677b96d206edcbd3593c6a3b590 Main34420342896终态38 success/2 failure，13个后端与普通lint全部通过；重点1798/1798、本批新增218/218、另2/2与原hook18/18通过。两OS各1962原生文件无遗漏/重复；完整Main仍未绿，两个非后端失败仅记录任务元数据。

[W49 原 full 34417550874](https://github.com/wangbinquan/agent-workflow/actions/runs/34417550874)：
W49 exactbb2127ad07e5c227b13f776e41e75cc1d0c6dd08 原full34417550874已终态失败：九端点两库均满足原绝对预算，六端点PG仍较慢。overview SQLite/PG为5.676210/8.656728ms，PG已满足原10ms绝对预算；严格相对P95条件尚未满足。
仍较慢的是tasks-second、repos-first、reviews-pending、clarify-pending、workgroup-pending、overview。
正式360样本、18组P95、20测量轮及每组一次warmup、原语料与判据均保持。
九个稳定wire投影相同；overview完整body摘要有差异，不能声称九端点完整body全部相同。
两个后置CPU profile包含初始化、seed、EXPLAIN与清理，不等于正式计时HTTP或PG服务器CPU，也不能用来声称W51改善了性能。
W50/W51未另行派发full；这份W49终态结果替代旧W39作为当前性能证据，先前批次保留其当时状态。

本批本地未运行真实业务DB/App/HTTP/PG/Git夹具、进程监听、TaskEngine/daemon/E2E或完整门禁。
W51提交后的真实托管执行待验；AC-1/6/8/9/11/12与RFC继续In Progress。

### W12 第五十批：扩大双库覆盖并合并 catalog 解析

基于已发布 `bb2127ad07e5c227b13f776e41e75cc1d0c6dd08`。

13个旧测试文件的68个原功能声明（原循环展开72例）接默认双库；98个原声明与273个完整matcher保留，未选30例/75 matcher保持原调用，选定68例保留198个matcher和原预算。
A组7文件40声明/115 matcher，选26/74、保14/41；B组6文件58声明/158 matcher，选42/124、保16/34。
B组file-symbols原语言循环由一个声明展开五例，故选定总计72例，原循环和全部原预算保持。
所选fixture借用真实harness.db，并等待完整provider应用初始化与dispose；实际业务行为待新SHA托管。
RFC120/122两个原临时目录创建前缀与次序保持，任务谱系仅在provider种子中按原SQLite触发器根任务规则显式补齐。
工作区代理保留同一原FS/seed程序，两次原insert后再等待完整应用；native仍使用原真实SQLite工厂。
它的原9行注释在独立复核中发现遗漏并原字节补回；修复前后完整Bun/TypeScript输出相同，未重跑整批编译。
所有未选原调用、原matcher与规则保持，未以纯端口控制宣称真实HTTP/数据库通过。

catalog私有decoder只增加既有共享parser导入并改为委托；其原调用及六个完整外层函数/方法保持，生产净减6行/86字节。
现有conformance只追加一例，原6声明/10展开、24个静态matcher和完整helper保持。
原/后纯例各1 pass/35 expect，16条完整返回值、读取顺序及异常观测同字节；两项变异由完整值断言拒绝，
一项将解析移出catch的变异由真实解析异常使回归失败。旧十个展开例未在本地重跑。

16个core一次完整backend tsc通过；其后仅补回原9行注释，完整Bun/TypeScript输出同字节，复用编译结果。功能metadata先发现账本基线688未随源码685下降，精确修正后221 pass/452 expect；canonical 13 pass/55 expect及严格lint/format通过。1962测试文件、602构库文件/1182调用，无harness545→532、有harness485→498；T19f对应三文件归零退役，账本688→685。
T19f只更新五个本批文件的实际构库数，其中三条归零删除；原ledger基线同步688→685，原why、其他条目与规则不变，零新增例外。
生成投影只刷新实际源码摘要和来源记录；backend编译、元数据初次失败及必要修复、comment-only桥均保留原收据。

[W49 Main 34417055489](https://github.com/wangbinquan/agent-workflow/actions/runs/34417055489)：
W49 exactbb2127ad Main34417055489终态38 success/2 failure，13个后端与普通lint全部通过；主1580/1580、新增241/241、独立2/2及原hook18/18全部实过，两个OS各1962原生文件无遗漏/重复。完整Main仍未绿，两个非后端失败只记录任务元数据。
[W49 原 full 34417550874](https://github.com/wangbinquan/agent-workflow/actions/runs/34417550874)：
W49同SHA原full34417550874仅派发一次，仍在运行；最近已完成的原full仍为W39，六个PG端点较慢、overview13.222187ms超10ms。
原正式语料、九端点、20轮、P95及绝对预算不变；后置CPU采样不能算作性能达标证明。
本批未运行本地真实业务DB/App/HTTP/PG/进程或Git夹具及完整门禁。
AC-1/6/8/9/11/12与RFC保持In Progress；发布清单和独立证据保存在`/tmp/rfc359-w50-*`。

### W12 第四十九批：扩大双库行为覆盖、复用解析与后置CPU采样

基于已发布 `509e0f35dcd3d35ad66b0db346488d4e5c1de8f4`。

11个旧测试文件中75个原功能声明（原循环展开77例）接默认双库；130原声明、398 callback matcher及3个共享helper matcher保留，另55个原例保持native完整call与预算。
所有11个文件都是部分迁移，不能按整文件宣布全部用例完成；选定75个声明（展开77例）保留267个callback matcher，
55个保留例有131个callback matcher，另外3个原共享helper matcher不计入callback分母。
使用既有中立owner和provider应用夹具，保留原种子、native同步返回与生命周期；
必要的异步终端在原操作位置等待，不能用Promise本身代替原返回值进行断言。
原SQLite触发器产生的根任务谱系在provider fixture中按已有同前提合同显式保留。
实际完整应用helper会loadConfig，原legacy空配置路径在该入口必抛config: empty config path；
发布前真实前置复核发现此处，因此仅将9个HTTP文件的provider配置路径投影为其appHome/config.json。
原native和所有旧callback的空串输入保持。先前的纯stub未覆盖此真实前置，旧结果不冒充完整装配有效性。
未在本地运行真实业务DB/App/HTTP/PG/进程夹具；候选行为等待新SHA托管。

`agentPersistence`与Intent资源端口的两个字符串数组decoder复用既有`parseAgentDependencyIds`。
原wrapper签名、五个调用、两个完整调用者及原共享parser保持，生产净减12行/168字节。
原后纯例各2 pass/172 expect，80条完整记录相同，三项有效运行时负控均使选定真实回归失败；
其中一项解析异常逸出、两项由完整值matcher拒绝。
旧W44四声明/八个展开用例与14个完整matcher原文保留，未在本地运行那八个graph例。

原完整性能计划中的四个overview计数已使用同一覆盖索引，现存PG EXPLAIN实测执行时间
0.026–1.568ms；后置请求记录13.717ms不足以归因客户端耗时，因此补独立CPU采样。
仅两个原profile子进程增加100微秒采样及各自JSON文件，其他所有worker argv保持。
原双HTTP→comparison落盘→双profile→双archive的顺序、语料与判据保持；
采样覆盖完整诊断子进程，不能将初始化/EXPLAIN/清理或服务端执行时间混作计时请求CPU。
原比较套件加三纯例后33 pass/101 expect，八组实际原/候选run函数的受控端口记录一致，
包括原P95失败、不可比和诊断/归档错误。Bun1.3.13算术CLI仅证明本地flags接受与JSON落盘，
没有启动业务；托管Bun1.4原full采样将在本批实际发布后单独启动。

[W48 Main 34411434156](https://github.com/wangbinquan/agent-workflow/actions/runs/34411434156)
W48 exact509e0f35d Main34411434156终态38 success/2 failure，13后端全过；主1339/1339、新增196/196、独立2/2与原hook18/18全部通过，两OS各1962文件恰一次。完整Main仍未绿。
新增196次为62原迁移例的186次、两个Intent创建例的6次与两条RFC144源码例的4次，全部实际通过。
P0工件34/34阶段有效，99份before/after源映射与本轮官方source实际相交5项；不把全部99项称为新源交叉。
原W47两条源码锁失败记录保留；本轮通过不回写旧结果。两个非后端失败只记录官方任务元数据。

最终17个core整批backend tsc先修正两份评审fixture的重载输入类型；随后补齐9个HTTP文件的真实配置路径前置，最终必要复验通过；功能metadata 221 pass/452 expect、canonical 13 pass/55 expect及严格lint/format通过。1962测试文件、605构库文件/1195调用，无harness556→545、有harness474→485。
本批各作者清单、源码对照、census及编译收据保存在`/tmp/rfc359-w49-*`；
元数据变化以原生成器的实际输出和本批发布清单为准，原ledger判据/why不因消账而改写。
最近一次原full验收仍为W39，六个PG端点较慢、overview13.222187ms超10ms；CPU采样不是性能改善证明。
AC-1/6/8/9/11/12与整个RFC继续In Progress。

### W12 第四十八批：扩大旧行为套件双库覆盖并修复 mint 源码锁

基于已发布 `1f6738e5109f47bc5255f5de7695f0975ec52aea`。本批14个core均为现有测试文件，
生产代码与共享测试harness保持；所有11个旧行为文件都是部分迁移，不计作11个完整套件收口。

| 范围                                                                                     | 原声明 / matcher | 接默认双库 | 原留存   |
| ---------------------------------------------------------------------------------------- | ---------------- | ---------- | -------- |
| webhook task source、archive、Unicode names、template upstream 四文件                    | 52 / 150         | 19 / 82    | 33 / 68  |
| memory page、employee writer、dump、call edge、upstream wiring、PR9、type upgrade 七文件 | 77 / 312         | 43 / 154   | 34 / 158 |
| 合计                                                                                     | 129 / 462        | 62 / 236   | 67 / 226 |

全部原预算保持，67个未选完整call逐字保留，选定matcher保留原完整参数与比较。
共享全局fixture只按实际用例作用域绑定到当前harness；native的同步返回与原清理hook保留。
四文件的原种子仅做两次小型SQLite观察（完成后关闭），没有执行原业务callback；
实际提取helper和native hook的受控验证12 pass/12 expect，三种缺await变异在通过的控制用例中被拒绝。
这些只证明种子/等待/作用域，不冒充真实PG业务结果。七文件的原完整种子表达式、helper与
24处await变动有源码核验；候选业务DB/App/HTTP/进程夹具未在本地运行。

原W12 Intent装配套件保留3个完整旧call，另加2个默认双库skill创建例：省略额外frontmatter、
以及中文/emoji/数组frontmatter；SKILL.md固定91/134 UTF-8字节，并检查辅助文件完整Buffer、
committed receipt与同收据重放的单行结果。纯schema/renderer核验通过，实际创建与回放等待新SHA。

[W47 Main 34407576737](https://github.com/wangbinquan/agent-workflow/actions/runs/34407576737)
在上述exact SHA终态40 jobs为36 success/4 failure，13后端11成功/2失败，普通lint成功。
冻结主集1143/1143全部实际通过，另RFC234两例通过，两OS各1962文件恰一次。
两个后端失败均是RFC144原728行普通源码锁：它只读取原SQLite文件，第二断言得到-1；
W47将abandon/insert移到共享程序后，该定位失效。W46相同完整callback在两OS原均通过。
本批先验证真实同步入口的import、同tx/input和runner，再读取共享程序检查原abandon→insert。
其余12个完整call及文件其余字节保持；提取原两真实纯callback为1 pass/1 fail/5 expect，
候选2 pass/8 expect。缺绑定、错误tx、错误runner、缺abandon、insert提前五个指定变异均在
实际选定callback中失败。没有运行此文件的Git/TaskEngine夹具；托管恢复仍需新SHA证明。

最终14core一次完整backend tsc通过；功能metadata 221 pass/452 expect、canonical13 pass/55 expect，
严格lint/format通过。T19f仅六个既有条目调用数下降，其他源码/规则保持，688条目不变。
原生成13份投影逐字保持；只刷新四份provenance并移除W47三项已过期的一次性增长标记，
124条ledger的原baseline/why与200条guard记录保持。实际AST统计1962测试文件、605构库文件，
调用1224→1198，无harness567→556、有harness463→474。原始占位9、provider命名59和生产指标保持。
证据：`/tmp/rfc359-w48-core-final-frozen.json`、`/tmp/rfc359-w48-backend-tsc-receipt.json`、
`/tmp/rfc359-w48-engine-census-delta.json`及本批各贡献清单；完整PG行为和最终exact-SHA CI继续等待。
AC-1/6/8/9/11/12保持开放；最近一次原full性能仍是W39，六端点PG较慢、overview13.222187ms超10ms，
本批没有运行或改写原性能基线。

### W12 第四十七批：共享 node-run mint 程序与 Intent 文档渲染

基于已发布 `340aee20760fdb093179d338cb77f665b4a3c420`，本批统一两个实际生产逻辑片段。
五个生产文件、四个现有源码守卫/生成器与两个新增纯测试组成11个core；原接口及事务归属保持。

- `nodeRunMintProgram` 复用既有 transactionProgram runner；同步入口保留 `.all()`、立即id
  和同步错误，异步入口保留原 query thenable 并等待全部终端。完整五个查询AST/字面量与
  insert values对象保持，唯一非空断言只修闭包的类型收窄，不改变提取后的运行JS。
  record、scope和lineage helper整文件保持；八个直接消费者的十次工厂调用保持。
  两生产文件218→166行，直接INSERT 2→1；这是实际逻辑合一，不是删除仍有消费者的同步入口。
- 实际源码提取的两个工厂及共享程序配合真实runner，在受控终端下原后25份完整记录相同：
  8成功、12错误身份、5异步等待场景，含431个完整事件和83次终端调用。
  最终三例3 pass/110 expect；错误id、错误native终端、遗漏insert等待三个指定变异均红。
  初版遗漏等待变异曾因两次microtask检查过早而通过；将新测试检查推进到下一event-loop
  turn后，原件/候选等待例各1/20通过、同一变异失败。三次早期loader错误未计作有效负控。
  这些是原调用参数、完成顺序和受控返回记录，不是实际SQL、物理行、回滚或PG运行证据。
- Intent两份artifact writer复用已存在的`renderResourcePackageSkillMarkdown`。
  共享运行体逐字保持，只有输入类型允许省略frontmatterExtra；两原资源包消费者不变。
  两个owner完整文件可仅逆换本批渲染替换还原原件，文件写入、模式和路径等其余代码保持。
  原W40四例与新三例合计7 pass/96 expect，覆盖完整payload矩阵、UTF-8、字段读取和原错误。
  首轮6过1红为新增oracle把YAML空字符串引号写错，按原件/候选实际共同输出修正；原记录保留。

W46 exact `340aee20760fdb093179d338cb77f665b4a3c420` 的
[Main 34402411359](https://github.com/wangbinquan/agent-workflow/actions/runs/34402411359)
attempt1已终态：40 jobs为38 success/2 failure，13后端任务与普通lint全部成功。
63选定文件、424原callback对应1126/1126实际执行通过：Ubuntu685（240SQLite、240PG、205single），
macOS441（240SQLite、201single）。旧1018身份完整保留，新增108为MCP18、Plugins48、Skills42。
RFC234两例与原18个hook所属例另组全部通过；两个OS各1960原生文件恰一次，无缺失或重复。
99官方源码blob/12发布路径已核。P0有34个有效阶段（17×2）；99组历史映射只有2组与当前
官方源相交，不扩称为99份当前源的完整变异验证。两个失败任务只保身份/状态；完整Main未绿。
历史hook本次通过与没有lifecycle诊断都不证明旧超时机制已被修复。

最终11core backend tsc通过。首轮类型检查的闭包空值收窄和两个新matcher推断错误已修，
原失败保留；唯一生产非空断言的提取后JS相同，测试提取器另补擦除该类型语法并重新验证3/110。
原31个守卫测试声明、106个callback matcher保持：30完整call逐字相同，一例只移除退役writer
的预期条目，其余语句/预算保持。严格lint和format通过。

原canonical writer生成13份metadata，四份provenance当前快照刷新为本批基线340a。
两个writer基线各2→1：canonical node-run-insert-sites以及W6 lineage-completeness。
三项真实增长分别为导入5330→5332、例外4796→4799、owner25066→25067，均带本批一次性理由：
五个既有transactionProgram原语引用替换三个Drizzle/schema导入（其中两个原schema例外），
新增共享程序及两个私有查询类型、移除原重复常量与渲染函数。没有修改规则、旧why或新增豁免规则。
200个guard行中199行整行原样，canonical测试文件一行仅lines从808刷新到804。
选定canonical13 pass/55 expect通过。功能metadata首轮220 pass/1 fail/452 expect，
唯一失败为W6实际writer已为1而基线仍2；据实将基线降为1后，两相关文件43 pass/76 expect。
原220成功结果保留，修复后不重复整套metadata或完整类型检查，也不把首轮写成全绿。

AST清点1960→1962测试文件，差量仅本批两纯测试；605构库文件/1224调用、无harness567、
有harness463保持，T19f688、provider命名59和原始占位9保持。
本地未执行真实DB、App/HTTP/WS、TaskEngine、daemon、真实Git/进程夹具、E2E或规模库。
原full仍归W39 exact50e9与run34343025829：三个任务页PG达原判据，六个其他端点较慢，
PG overview MAX13.222187ms未满足10ms；20轮/360样本及严格P95原判据不变。
新SHA真实数据库行为与完整CI继续待验，AC-1/6/8/9/11/12及整个RFC保持In Progress。
证据入口为`/private/tmp/rfc359-w47-node-run-mint-manifest.json`、
`/private/tmp/rfc359-w47-intent-document-manifest.json`、两份独立源码复核及root最终发布清单。

### W12 第四十六批：MCP、Skills、Plugins原功能用例接完整双库应用

基于已发布 `29b6a3134dd8ad4f38acda085c092bf2ac14f040`，三个测试源稳定后统一验证。
本批不改生产owner或共享应用helper，只迁移明确选定的原功能回调；原完整断言和默认预算保持。

- MCP原21例/40 callback matcher，选6例/13 matcher默认双库，其余15例/27 matcher和
  四个原helper完整保留。四个App选项保持；应用ready后才交给旧回调，dispose完成后恢复
  原环境并清理自有目录。两个子集内部顺序保持，二者之间的原全局交错顺序发生变化。
  新helper的五个纯生命周期场景和三个指定负控通过；外层reset只是受控调度标记，
  不把它算成真实harness、HTTP或PG已经执行。
- Skills原19例/65 callback matcher，选14例/52 matcher，其余5例/13 matcher保留native。
  原req/buildHarness保持；HTTP创建helper的完整函数体置于绑定当前app的工厂中，
  原每个callback不改。原已有的四个rejects外层await保持，不重复增加等待。
  原必须使用特定native runtime夹具的行为继续留在native组，没有用类型断言绕过DbClient限制。
- Plugins原21例/81 callback matcher，选16例/60 matcher，其余5例/21 matcher保留native。
  唯一callback语义差量是第二次seed调用在原位置增加await；原完整matcher/参数/预算保持。
  同一个startPluginSeed执行原id生成、时钟读取及完整INSERT，native包装即时返回id，
  provider包装等待同一write再返回同一id。原先忽略的run返回现在被内部捕获，
  不把这个明确差量称为所有内部返回字节相同；没有复制种子数据或生产安装实现。
  原先同组的native和provider片段拆分为独立fixture，声明顺序保持；安装过程及其等待预算不改。

三个原工厂调用均1→1，未删除仍服务native回调的工厂。总计36选中例/125 callback matcher，
另25原例保持native；三个文件各有一个helper内matcher，静态计数不是运行时expect总数。
原36个callback在W44官方源与两个OS原日志中的72次执行均通过；W45官方源也与该原件相同。
这组旧基线单独记录，没有追溯扩大W44或W45的1018主分母；本批新增注册另由新SHA执行核验。

W45 exact `29b6a3134dd8ad4f38acda085c092bf2ac14f040` Main `34398511514`终态：
40 jobs为38 success/2 failure，13个后端任务全部成功，普通lint成功。
Ubuntu3 job102624248481与mac3 job102624247948的原8装配callback共16次实际通过，
W44两条旧结构锁的四次失败对应4/4恢复；原callback身份、名字和预算保持。
原1018主集逐例实际通过：Ubuntu613（204 SQLite、204 PG、205 single），
macOS405（204 SQLite、201 single）；两OS各1960原生文件恰一次，无缺失或重复。
RFC234两个sidecar和原18个hook所属例另组全部通过，未并入1018主分母。
两个失败任务仅保静态扫描及CI required的身份与状态，没有展开其内容；完整Main未绿。

一次完整backend tsc通过，三个候选hash保持；严格lint/format通过。
原canonical writer生成的13份投影与29b6逐字相同，四份provenance仅刷新currentSnapshotSha，
124 ledger行、200 guard行、baseline/why/rule以及主架构分母保持原样。
功能metadata211 pass/433 expect、选定canonical13 pass/55 expect通过。
测试清点仍1960文件、605构库文件/1224调用；无harness570→567，有harness460→463，
差量恰为三个原测试文件新增统一harness注册。这不是全量行为迁移完成的百分比。
T19f688、provider命名59和原始占位9保持；AC-1/6/8/9/11/12继续开放。
本地未运行真实App/HTTP/WS、PostgreSQL、TaskEngine、daemon、真实Git/进程夹具、E2E或规模库。
原full仍归W39 exact50e9的34343025829：三个任务页PG达原判据，六个其他端点较慢，
PG overview MAX13.222187ms未满足10ms；原20轮/360样本和严格P95判据不变。
证据入口为`/private/tmp/rfc359-w46-mcps-manifest.json`、两套件manifest及root最终发布清单。

### W12 第四十五批：保留原装配判据，修复已发布增量的结构锁

基于已发布 `8c5e6275338c6077cb08aa031cb42a7060571532`，只修改W29完整应用装配测试。
W44已发布的同一repositoryWorkspaceStore输出改变两个旧源码观察形状：
SQLite完整装配的末尾返回值多一个字段，helper将原直接compose调用保存为composed再挂载。
原失败在两OS同为两条断言，旧摘要常量没有随生产源码更新而替换。

- 测试先验证SqliteAppComposition中的必需readonly字段、最终Object.freeze返回值和
  最后一个实际bootstrap store属性，然后只移除这个已知新增属性进行原完整摘要比较。
  保留TypeScript原NodeArray尾逗号标记；原八个完整callback、42个matcher及九个摘要常量逐字保持。
- helper只接受唯一compose→createComposedApp(composed)→同一composed.store的完整函数体。
  验证后仅将该新增别名形状逆换成原调用观察，不忽略其他语句或新增字段。
  六种单输入变异包括可选store类型、错误bootstrap store、额外返回字段、错误helper store、
  返回次序改变和第二次compose；五项在同步结构检查拒绝，一项到原完整摘要断言失败。
  没有把装载错误或未执行的case计作有效负控。
- 原两条选定测试0 pass/2 fail/8 expect；最终原整套8 pass/46 expect。
  首轮候选因尾逗号标记丢失出现7 pass/1 fail，修正后通过，失败记录保留。
  严格lint（max-warnings 0）、format及冻结候选的一次完整backend tsc通过。
  原canonical writer产生的13份结果与8c5e逐字相同；四份provenance刷新到8c5e，
  只移除W44新增两个owner所用的一次性allowGrowth，25066 baseline及全部原规则保持。
  功能metadata211 pass/433 expect、选定canonical13 pass/55 expect通过。

W44 exact `8c5e6275338c6077cb08aa031cb42a7060571532` Main `34370615318`：
40 jobs终态36 success/4 failure，无取消；13后端11 success/2 failure。
选定主集仍是60文件/388源码callback，1018次执行完整、1014 pass/4 fail；
四次失败恰为上述两条旧结构锁在两个OS的结果。204个选定PG执行全部通过。
两个OS各1960个原生文件恰一次；原生文件被发现不等于全量行为已完成PG参数化。
本批前W44新增31次全过，W43此前未执行的12次已在W44实际通过，旧W43结果不改写。
RFC234两个sidecar与原18个hook所属case也分别通过，分母独立，不并入1018。
其他两失败任务仅保身份和状态，完整Main未绿。

生产代码未改，1960测试文件、605构库文件/1224调用、570无harness/460有harness保持；
T19f688、provider命名59、原始占位9及主架构分母均不变。
证据入口为`/private/tmp/rfc359-w45-composition-lock-manifest.json`和root最终发布清单。
本地只运行纯源码、受控生命周期及限定功能metadata检查，没有运行实际PG、App/HTTP/WS、
TaskEngine、daemon、真实Git夹具、E2E或规模库；真实托管结果仍须绑定新发布SHA。
最新原full仍归exact50e9的34343025829：三个任务页PG已满足原判据，六个其他端点较慢，
PG overview MAX13.222187ms仍未满足10ms。原规模、20轮/360样本和严格判据保持。
AC-1/6/8/9/11/12及整个RFC继续开放。

### W12 第四十四批：依赖解析合一与缓存仓库HTTP双库

基于已发布 `171bee3f6c85dda992c7c54d4a8131d070c824fc`，七个核心路径冻结后一次完整backend tsc通过。

- agentPersistenceSemantics与PG package mutation的实际loader共用parseAgentDependencyIds。
  两个原完整JSON.parse表达式保持，原查询、await、缺行、自引用检查及遍历保留。
  中立侧row getter仍位于catch内，PG仍先读row再进入原薄stringArray入口。
  不合并原去重函数：它们对空串的行为不同。此次只移除重复解析体，解析相关生产净减3行。
  从两个原真实graph函数与候选函数提取并调用原遍历，原后各8例/64 expect通过；
  32场景的42个受控读端口、39个解析返回、29 void/3原拒绝及156事件逐值相同。
  四项有效指定负控均使选定真实回归失败：两项在await拒绝，两项到原matcher失败。
  最初四个preload错误明确不算行为红。
  原T72静态collector对新test返回空列表，无新增账本豁免或改名绕过。
- cached-repos-http选择原5个call/12 matcher，另外4个call/7 matcher和全部原native helper保持。
  三次原INSERT和两次读取顺序补await；原task seed的26绑定顺序保持，新增两绑定显式表达
  原SQLite触发器确实生成的execution_lineage_id与lineage_slot_path_json，root_task_id仍为NULL。
  原后微型SQLite seed各执行一次：27条完整SQL/bind记录只有该task INSERT从26到28的差量，
  两组四表完整快照逐值相同。这不是全SQL字节相等，也不替代真实PG/HTTP/Git行为。
  完整应用夹具新增必需store输出：SQLite从既有repositoryBootstrap读取同一实例，
  PG从原core读取同一实例；原构造和createComposedApp顺序、原dispose保留。
  不另建store或提前构造，避免与实际路由形成两份facetsCache；内层应用先释放再清理自有资源。
- 原canonical writer刷新13份metadata，生产sourceDigest更新；唯一计数变化为共享文件及
  parseAgentDependencyIds函数两个实际owner记录：25064→25066，附一项source-bound增长说明。
  主分母1740/272/983/5330/4796保持，旧owner、rule、why及全部200 guard行保持。
  7core一次完整类型检查通过，211功能metadata/433 expect和13选定canonical/55 expect通过。
  当前1960测试文件，605个createInMemoryDb文件/1224调用、570无harness/460有harness；
  这些文件计数不是尚需迁移的工作量百分比，部分文件仍只迁移已选行为。

W43 exact `171bee3f6c85dda992c7c54d4a8131d070c824fc` Main `34364763034`终态：
40 jobs为37 success/2 failure/1 cancelled，13后端12 success/1 cancelled。
主分母固定987，975通过、12因mac1未到达而缺失；另RFC234两个sidecar通过，分母独立。
Ubuntu1959原生文件恰一次；macOS只发现1623/1959，缺失336，不补称两OS全量发现。
新增11个仓库组HTTP原callback的33次执行全过；原18个hook所属case也全过。
本批所选缓存仓库5个旧callback两OS10次均通过，作为独立基线，不扩入987主分母。
取消作业的官方记录没有reason字段，原因保持未知；其他失败只保独立身份与状态。

最新原full仍为exact50e9的`34343025829`：三个任务页PG较快且满足原预算，
其余六端点PG较慢，PG overview MAX13.222186999992118ms未满足10ms。
本批只读核对原性能SHA与当前驱动相同：被识别为只读的路径直接用现有连接池，
不会在该分支额外reserve或开启事务；这不能证明每个HTTP操作的分类或耗时根因。
没有据此改查询或重复派发full；原规模、20轮/360样本和严格P95判据保持。
证据入口为`/private/tmp/rfc359-w44-final-manifest.json`、两份切片manifest及独立复核。
本地未执行实际PG、App/HTTP/WS、TaskEngine、daemon、真实Git夹具、E2E或规模性能库。
新SHA真实双库HTTP与完整Main待托管；AC-1/6/8/9/11/12继续开放。

### W12 第四十三批：仓库组HTTP双库与历史hook阶段诊断

基于已发布 `dfdadd6ad10e2ba8fe3e73b2ad68a6656cdfeb83`，五个核心路径冻结后一次完整backend tsc通过。

- 仓库组HTTP选择11个原完整call/28 matcher；全部14个call及其前导注释保持，另3个仅保留原样。
  三个原节点构造const移入同一个共享工厂；seed只有中立参数类型、async与外层await变化，
  SQL表达式、原7值及次序、ULID/时钟输入和返回保持。原native beforeEach仅顺序await两次seed，
  native工厂1→1。本文件是部分选择，未把其他原例算入双库覆盖。
  默认describeEachProvider通过内层describe调用具名注册函数，保持真实provider上下文；
  复用完整provider应用工厂，四个原应用选项保持，并显式传入本次appHome。
  原seed与新seed各在一份微型原生SQLite夹具上执行两次，重放实际生成的两个ID与时钟值；
  完整6条SQL/bind记录、2次全行快照中的3行/36字段和两个返回值逐值相同。
  其中2条是INSERT记录、4条是两次显式observer query().all()的SELECT记录；记录条目数不等于
  独立native执行数。未使用的native run()返回对象没有录制，不扩称返回对象已对拍。
  16个纯控制包括5个失败/清理场景及11次真实Bun嵌套hook调度；实际应用/DB端口和原HTTP
  callback均替换为受控端口。208条原始事件保留，其中198为provider生命周期、10为手动控制
  外层原global hook。证明dispose与目录/环境清理先于DB释放，不替代真实HTTP行为验证。
  原collector误将全部208条期望为198，修正临时observer后通过；原seed报告一处旧数量说明
  由派生报告纠正，原脚本/日志/收据/捕获均保留，没有重跑夹具或改产品源码。
- daemon-start原beforeAll的9个操作、6处await、原10000ms reader参数、cleanup及9个原整call
  保持；新增18个固定阶段标记。纯验证仅执行前4个原setup操作及原清理，后5个操作和原行为例
  不执行。初版报告函数的sink抛错问题在交叉复核中发现并修正；初始化时钟和报告函数自身
  各自保护诊断失败，不包裹原操作。原3例保持，另4项诊断故障在修前真实断言红，修后共7/41。
  此处只增加后续托管定位能力，未改reader协议，也不宣称历史5秒超时已修复。
- RFC210原beforeAll的23个statement、10处await、60000ms预算、原git adapter与afterAll保持，
  5个原完整call仅作raw保真；新增46个固定阶段begin/end及单调耗时，sink失败不替换原错误。
  从原真实hook/adapter提取并注入非进程端口，4/79通过；17组前后各411条完整受控端口事件
  相等，10个pending边界与700条诊断保留。4项指定负控在真实断言红；未执行真实Git/原行为例。
- 当前1959测试文件，605个createInMemoryDb调用文件/1224调用、571无harness/459有harness。
  T19f整源/688条、provider命名59与生产sourceDigest保持；新增两文件均为纯诊断回归。
  原canonical writer后13份metadata全部raw不变；初次功能检查为210/1：两份诊断期望序列需按原T72规则登记。
  原NOT_A_LEDGER及其逐条相等断言显式增加两项，未改matcher或以改名绕过；修后211/433通过。
  治理更新为四份provenance、上一批两个一次性allowGrowth标记，以及原T72 guard行lines+6；
  其余199行、全部124个baseline、why和规则保持，parent status不变。五core唯一完整类型检查
  通过；后加的两项literal登记采用严格lint/format与功能复验，未重跑整包tsc。
  最终metadata的13/55选定canonical也通过，保留首轮失败收据。

W42 exact `dfdadd6ad10e2ba8fe3e73b2ad68a6656cdfeb83` 的Main `34358743177`终态：
40 jobs为36 success/4 failure，13后端11 success/2 failure。两OS各1957原生文件恰一次。
932主身份全部通过：Ubuntu562=188 SQLite+188 PostgreSQL+186 single，
macOS370=188 SQLite+182 single；另RFC234两个sidecar通过，分母独立保持。
W42新增40次全部通过，原Git配置并发callback两OS也通过；本批所选11个旧HTTP例两OS22次通过。
W41历史daemon beforeAll所属3例和RFC210所属5例在W42两OS均过。
W42另一个具名per-test daemon case在Ubuntu3525.51ms通过、macOS5014.05ms以5000ms预算失败，
没有stack或await阶段证据，不能混同前面的beforeAll，也不能据此判断哪一原操作超时。
其他未选失败仅记录身份与作业状态，不扩入932分母或解释为本批阶段诊断已解决。

最新原full仍为exact50e9的`34343025829`：三个任务页PG较快且满足原预算，
其余六端点PG较慢，PG overview MAX13.222186999992118ms仍未满足10ms。
本批不改性能查询、不派发重复full；原规模、20轮/360样本及严格P95判据保持。
证据入口为`/private/tmp/rfc359-w43-final-manifest.json`与三份切片清单、独立复核。
本地未执行实际PG、App/HTTP/WS、TaskEngine、daemon、真实Git夹具、E2E或规模性能库。
新SHA真实双库HTTP和完整Main待托管；AC-1/6/8/9/11/12继续开放。

### W12 第四十二批：共享端口校验、公共Git配置串行与六个HTTP例双库

基于已发布 `35053515dcc23f9975ddade91cbbe07b2c80f719`，七个核心路径冻结后一次完整backend tsc通过。

- `agentPersistenceSemantics`与PG资源包mutation arms的两份完整11行分支端口函数收为一个共享
  `agentBranchPorts.ts`实现。两个旧owner的整源逆换、三个原调用及所在函数raw保持；
  原CreateAgent Pick参数、同步void、空值短路与读取次序保持，生产2027→2021行。
  原两套完整提取函数各5 pass/18 expect，候选共享5/18；新增五个pure声明/14个静态matcher。
  三个实际行为变异分别锁住错误返回、missing顺序/重复值与过早读取outputs。
  两份原件与最终共享各八组纯观察，逐版本65次读取、完整结果和错误非位置属性相同；
  两个实际错误共六处sourceURL/line/stack差量保留，不把提取文件和新生产文件的位置当成相同。
  首unused type warning与纯JSON观察器位置字段假设失败保留；最终strict lint/format通过。
- `workspaceExcludeManager`只为原enable-worktree-config的await包入已有
  `withWorktreeRegistryLock(input.worktreePath, ...)`，复用真实common-directory resolver/cache/queue。
  原gitOutput完整函数、原配置argv和随后per-worktree await保持；原两任务并发及70000ms不变。
  从实际源码提取owner两句、resolver、queue和错误类，只注入非网络runGit端口：旧片段同key
  指定红0/1，候选6/30；不同repo仍可并发，原错误保持且队列继续，不加重试。
  三个实际负控拒绝按worktree路径分锁、全局串行与漏owner await。四个原command及完整端口
  返回保持，两个新冷路径common-dir查询与实际事件次序差量单列；cache重复路径只查询一次。
  W40 CI未记录锁holder/PID和准确重叠，候选修复的是证明过的同进程协议形状，不扩称历史根因。
  回归顶部只补来源注释，完整Bun/TS输出与已执行版本相同；最终strict lint/format通过。
- Batch HTTP前六个普通功能例的整call、19完整matcher、输入和原500ms要求保持，默认双库。
  第七整call、14原顶层声明和三个原native fixture statement整体raw保持，整源逆换通过。
  原native工厂继续1→1，本文件仅部分选择，不能记为完整迁移。原四应用输入保持并显式传入
  appHome，调用现有完整生产组合夹具；内层describe先等待app.dispose，再由外层harness释放DB。
  每次setup清空旧引用并提前记录本次tmp，初始化失败、销毁拒绝和目录创建失败保留原错误，
  不复用上一应用或删除旧目录。十个纯控制包括实际注册函数与原registerSqlite函数注入非DB
  端口后的六次真实Bun嵌套hook次序；没有执行原HTTP callback、实际App、请求或数据库。
  W41已发布旧源两OS六例共12/12通过；新候选的完整wire、真实两库HTTP及原预算等待新SHA。
  module-level注册函数只由默认provider callback内的同步describe调用，源码登记沿该真实调用
  传递provider上下文，不能因test声明位于顶层helper内部而误记为single。
- 当前1957个.test.ts；原createInMemoryDb口径为605文件/1224调用、572调用文件无harness，
  458文件有harness。仅新增两份pure文件与一个现有文件的harness登记，工厂数没有减少；
  T19f整文件/688条和provider命名59保持，不由未选原例推断全文件覆盖。
  七core的最终类型检查前后hash保持；211/433功能metadata与13/55选定canonical通过。
  原writer更新真实sourceDigest及原投影：canonical1740/272/983/5330/4796/25064，
  `sha256:3100f96aba941dddf01cdd5a62f46cea09154ca790760aab072a4f7a3fbce9c4`。
  两条新增observed边仅为共享helper的ValidationError和原owner的withWorktreeRegistryLock；
  相应两个高水位行登记本次增长原因。两旧private owner退出、新共享文件/函数进入，总数不变。
  200 guard行和其余122 ledger行、原why及原规则保持；parent status按原renderer投影。

W41 exact `35053515dcc23f9975ddade91cbbe07b2c80f719` 的Main `34354058081`终态：
40 jobs为36 success/4 failure，13后端11 success/2 failure，普通严格lint与独立PG通过。
86官方blob/13发布路径、52文件/343 callback及两OS各1955原生文件恰一次已核。
892主身份逐条通过：Ubuntu539=182 SQLite+182 PostgreSQL+175 single，
macOS353=182 SQLite+171 single；另RFC234两个sidecar通过，分母独立保留。
原五个Linux gate红全部恢复，新增RFC248四个与RFC331一个PG例均过；W31六pure恢复，
RFC341实际仍是pump→fault且都过，不据此声称已实测fault后pump。
P0原artifact的35成员和34原phase全有效，99前后映射相等但仅2与官方源码集合交叉；
四个选定生命周期观察文件零阈值事件，不据此倒推历史原因。
另外两条失败都在892范围外：macOS2 daemon-start的未命名hook5002.62ms，
macOS4 RFC210 alternates的未命名hook60000.06ms；Bun报告泛用beforeEach/afterEach超时文案，
源码中的对应setup均位于beforeAll，原日志没有逐操作阶段。后续daemon exited before ready
不证明前一个超时的原因。保持预算，下一批只沿实际hook链定位。
旧Git config并发任务本SHA两OS均过，仅作为原回调的附带观察，不替代W42候选验证。

最新原full仍为exact50e9的`34343025829`：360样本、六份原五表投影、9端点原判据保持。
三个任务页PG较快且满足预算，其余六端点PG较慢；PG overview MAX13.222186999992118ms
仍不满足10ms。W42没有改变性能查询或派发重复full；后置计划不替代HTTP样本。
本地没有实际PG、App/HTTP/WS监听、TaskEngine、daemon、E2E、规模性能库或完整门禁。
最终证据入口为`/private/tmp/rfc359-w42-final-manifest.json`、三个切片清单与独立复核。
新SHA真实HTTP/PG、原并发任务和完整Main待托管；全部原AC判据、原W20限制与六项未达AC保持。

### W12 第四十一批：实际Linux VM定位修复与五个旧DB例双库

基于已发布 `bbe954aff87a8f076afd94726c43b09690dc8672`，最终四个核心路径冻结。

- W40 Ubuntu6的五份真实程序分别有1746/1746/1768/1746/1768条指令，全部没有Explain。
  原定位器均先在Explain/UNION ALL查找失败；原业务查询、行/绑定、prefix/gate值断言已经通过，
  不能把缺调试指令解释为生产SQL结果错误。Bun为1.4.0+34cbb9a40，平台linux/x64。
- 只修改测试的`checkGateProgram`：根据一列、无Seek的唯一物化定义、真实facet索引rootpage和
  Rewind游标定位fallback门，额外验证Once/Return/Gosub链接。保留原主Seek/Next、gate Next和
  空门退出目标的全部大小关系，以及每个前置含Seek辅助定义的所有Gosub必须在门循环内的检查。
  使用实际指令addr范围，移除Explain后不依赖数组下标连续。其余31个顶层声明完整raw与整源
  精确逆换通过，两个原注册展开六例、原业务matcher、完整SQL/参数/输入/预算全保持。
  原opcode失败诊断仍在，不新增DB查询，不宣称省去OpenRead或游标分配。
- 直接提取原/候选函数、使用真实Bun expect运行保存的VM：五份Linux旧定位器全部红，新定位器
  通过五份Linux与五份mac记录；去除Explain的十份记录仍通过。四类变异共40次指定红：空门跳入
  主Seek、错误门游标、缺Once以及辅助扫描被提前调用；五份原未加门程序仍被拒绝。
  Linux失败诊断未打印函数的indexRootPage参数；这里的796来自三处OpenRead页号及P4摘要与
  同schema的mac实际记录匹配，属于明确映射。新托管原例仍通过sqlite_schema实际读取页号，
  不以这份记录重放替代新的Linux SQL实跑。纯收集器的三次定位/文案假设错误与修正均保留。
  最终小型SQLite只跑一次，六原例6 pass/228 expect；strict lint --max-warnings 0和format均通过。
- RFC331选原status/read-shape一个DB例，8原声明/29完整matcher保留；7未选完整call按raw保持，
  不重新解释或执行。唯一native工厂位于选定callback，迁移后1→0；两个种子await与四次read保持。
  原后各一次1 pass/4 expect，7 filtered。七SQL中六完整相同；task INSERT只追加旧trigger实际
  产生的executionLineageId/lineageSlotPathJson，原24绑定前缀保持，真实native changes2→1单列。
  tasks全部70列和四个read-model返回相同；16快照共5重复行/176字段/91 NULL/9 JSON值。
  workflow.created_at/updated_at仍由原SQL的unixepoch生成，两列在三个快照出现六处自然时间差量，
  保留完整旧新值，不改fixture追时间字节相同。原显式native close事件与现有harness clearState
  解除引用的生命周期差量单列；没有声称harness执行了同一native close。
- RFC248选PUT version、引用去重/摘除、删除不存在与级联删除四个原DB例。
  原22声明/61完整matcher=选4/11+留18/50，18未选完整call raw与原顺序/预算保持。
  用同层原生/双库分组保持原call缩进；原生共享工厂继续1→1，不能按四例退出四个构造点。
  原makeRepo的两处setup调用顺序await；级联删除的两处all只追加外层await。
  原后各一次4 pass/11 expect，18 filtered；113条完整SQL/绑定/native结果、90个全行快照
  共86重复行/880字段/290 NULL相同，11个原await返回与8个种子返回/完成顺序保持。
  12个原真实ULID输入记录后同序回放，Date.now固定；没有替换数据库或业务返回。
  两个新增await的返回逐项映射到原native values结果，单列不冒充旧await。
- 两文件合计5个选定DB例默认两引擎，25个未选完整call保持。既有242完整/17混合的历史登记
  保留，本批按两个部分选择文件记入，不由未执行的25例推断新的全文件覆盖。
  T19f仅去RFC331一行，689→688；RFC248那一行与其余条目字节保持。当前1955个.test.ts，
  延用原`createInMemoryDb`工厂调用口径为605文件/1224调用、573调用文件无harness，457文件有harness。
  此口径不含new Database；另一次扩展AST清点得到两种构造合计678文件/1375调用，单独保留，
  没有把不同分母当成本次迁移差量。原工厂口径逐文件只出现这两个文件的变化。
- 四core一次完整backend tsc通过，前后全部hash保持；211/433功能metadata与13/55 selected
  canonical通过。原writer/governance仅更新四份provenance，八份canonical与parent status原字节。
  canonical1740/272/983/5328/4794/25064及sourceDigest
  `sha256:9cad328b940e62bc133f4ddbc059f28b7fa17f68a83eeb31c947292dee01f3b2`保持。
  provider命名59保持；其他规则、owner行和why只作opaque字节校验，未改变其内容。

W40 exact `bbe954aff87a8f076afd94726c43b09690dc8672` 的Main `34348730483`已终态：
40 jobs为36 success/4 failure，13后端11 success/2 failure，普通lint成功。
93官方blob/27发布路径、50目标文件/338 callback及两OS各1955原生文件恰一次已核。
877主身份完整：872 pass/5 fail，五红仅Ubuntu上述VM定位；177选定PG均过，mac348全过。
另2 RFC234 sidecar均过。W39原12红精确映射为7恢复/5仍红，W31两OS六例恢复；
RFC341本次实际顺序是pump→fault且两者通过，不能据此声称已实测fault后再pump。
新增renderer八次、模板所选九次执行都过；P0 34阶段齐全有效，99前后映射仅2与官方blob交叉，
不扩大官方来源见证范围。四个选定生命周期诊断文件零阈值事件，不据此推断历史根因。
另一个mac分片唯一未选红是task-start-git-identity的并发例：enable worktree config遇到
repo/.git/config锁冲突。原调用链与已有worktree registry锁范围已只读核验，尚无锁holder或
重叠时间证据；下一批拟包入现有registry串行区，不降低原任务并发或放宽预算。本批未改该owner。

最新原full仍是exact50e9的`34343025829`；360样本、六份原五表投影、9端点原判据保持。
PG三个任务页较快且两库均满足原预算，其余六端点PG更慢；唯一原绝对失败为PG overview
MAX13.222186999992118ms不满足10ms。Overview后置四次count输入/参数各有原语义，
既有AST复用已经覆盖重复构造，没有足够依据删除或合批，当前优化写集合为空。
后置计划不是HTTP样本，不把空输入/跨run时间差当成原P95根因或修复；本批没有派发重复full。
证据入口为`/private/tmp/rfc359-w41-final-manifest.json`、三个切片清单、独立复核与W40官方终态包。
本地无实际PG、App/HTTP/WS监听、TaskEngine、daemon、E2E、规模性能库或完整门禁。
新SHA真实PG、Linux修复与完整Main待托管；原W20限制、全部原AC判据和六项未达AC继续保持。

### W12 第四十批：资源包序列化共享、模板双库与真实CI失败修复

基于已发布 `50e9e58cd5a7574ab463096c3da6fe487a49078a`，最终9个核心路径冻结。

- 两个实际资源包writer的原YAML投影与SKILL.md framing合为一个同步纯renderer。
  两份原表达式及其求值顺序相同，整owner逆换保持；原两份控制各3 pass/33 expect，候选4/38。
  18份完整字符串合计2463重复UTF8字节相同，五个属性故障点的15次原sentinel身份保持；
  缺末尾换行、错body字段、改变lineWidth三个值断言负控有效。原FS/暂存/事务边界未移动。
  生产净增2行，共享的是实际重复算法；两个完整artifact owner的其余差异仍开放。
- 模板修复三个原例使用默认双库harness，另两个原完整test call字节保持。
  原后各3 pass/39 expect、2 filtered；507条SQL含原执行文本/绑定/结果、90个agents全行快照、
  16个原await返回逐值相同。快照共1032重复行/21672字段/1032 NULL/8256 raw JSON。
  三处新增await实际观察18次写完成，与各原native run结果相同，单列而不冒充原await返回。
  两helper仅DB参数类型变化，完整Bun/TS运行JS相同；原5声明/9完整matcher及预算保持。
  native构造5→2，T19f只更新该一条；旧迁移累计242完整/17混合。
- W31三个旧pure例在W39因实际reset已包装而被旧source matcher拒绝，本地原3红。
  新matcher要求outer await、原phase/fixture.reset标签及返回原reset Promise的同步零参arrow；
  执行器提取实际helper函数，使用原无observer路径和原deferred端口，不替写wrapper实现。
  修后3 pass/24 expect；原行为callback、三个未选整call与其他helper保持，新增漏await/
  不返回Promise两项源负控。实际client对象、原option及reset后注册的相邻顺序仍严格检查。
- RFC341原PG故障trigger/function在同suite后续pump仍生效，W39日志中fault先过、pump随后
  因rfc341-collaboration-event-fault/P0001失败；W38同源码为pump先过、fault后过。
  这是实际顺序和泄漏证据，不归因为W39 helper改变注册顺序。只给该原故障例加try/finally，
  原7条保护区语句、4 matcher、3 DDL字面值以及其余3整call保持。
  finally依次await删除自有PG trigger和function；实际片段6纯协议场景与4指定负控通过。
  本地未执行整个旧业务callback或实际PG；cleanup端口失败仍使测试失败，新SHA验证恢复效果。
- W39 fallback五个Ubuntu SQLite例均先在缺首Explain/UNION ALL标记处失败，五个真实PG例通过。
  同Bun1.4.0+34cbb9a40官方macOS二进制运行原未改测试6/218通过，五份完整VM与旧mac记录相同；
  这不复现Linux问题，也不能证明Linux计划结构或原因。W40只给原missing-row断言补惰性诊断，
  记录实际已有VM的地址/opcode/数值、Explain标签和其余p4摘要、查找位置及Bun/platform。
  原checkGateProgram整函数、所有38完整matcher、SQL/输入/预算保持，未增加DB查询或放宽判据。
  五份录入VM的缺标记数据控制仍被原matcher拒绝；本项只是取证，Linux修复保持开放。
- 最终9core一次完整backend tsc通过，211/433功能metadata与13/55 selected canonical通过。
  原writer刷新13 metadata；首次governance仅因新共享owner未登记增长退出，原失败保留。
  登记新file/renderer两个身份、删除原private skillMarkdown身份，net+1后governance通过。
  canonical为1740/272/983/5328/4794/25064，sourceDigest为
  `sha256:9cad328b940e62bc133f4ddbc059f28b7fa17f68a83eeb31c947292dee01f3b2`。
  当前1955测试文件、606构库文件/1225调用、575无harness/455有harness；T19f689/T17命名59保持。
  无关规则与原why仅按opaque字节保留，所有切片实际strict lint/format通过。

W39 exact `50e9e58cd5a7574ab463096c3da6fe487a49078a` 的Main `34342947550` 已终态：
40 jobs为35 success/5 failure，13后端10 success/3 failure，普通lint与独立PG成功。
89官方blob、32发布路径、48目标文件/331 callback及两OS各1954原生文件恰一次已核。
860原目标身份齐全，848 pass/12 fail；Ubuntu519为510/9，macOS341为338/3。
12红是W31两OS共6、RFC341后续pump的PG1、Ubuntu fallback SQLite5，分别由上述切片处理或取证。
另2 RFC234 sidecar通过（Ubuntu3097.99ms、macOS22.61ms），不混入860分母；
P0 34原阶段有效，99前后映射中只有2项与这次官方blob交叉核验，不宣称99官方来源齐全。
四个选择诊断的旧文件本次没有阈值事件输出，不能据此宣称历史初始化问题已修。

W39原full HTTP P95 run `34343025829` 已按原workflow在exact50e9单次运行，job `102438022017`
于10:59:00至11:31:26 UTC实际完成，原relative比较失败。官方artifact `10101697737` 的12成员ZIP
为193190字节/SHA256 `9cfa5ecbd6890e51becce5349e8bc1bf41522c32ab8dece37a2e454defb2d435`。
13官方源码、360原样本/18向量、每端点每库20轮/1次排除warmup、原九个绝对与relative判据已核。
五表有序完整投影的六份receipt相同，500 repos/100k tasks/3m runs/10m events/100k deliveries保持；
这不是所有物理列或数据库文件字节的证明。原P95为20样本排序index19，即本轮MAX。

| 原端点            | SQLite P95 ms | PostgreSQL P95 ms |
| ----------------- | ------------: | ----------------: |
| tasks-first       |    142.563024 |         80.726695 |
| tasks-second      |     53.357342 |         51.165668 |
| tasks-running     |    104.899536 |         50.808485 |
| repos-first       |      4.057372 |          9.255347 |
| repos-referenced  |      4.876247 |          8.298452 |
| reviews-pending   |      2.109844 |          6.316191 |
| clarify-pending   |      1.752418 |          4.945905 |
| workgroup-pending |      5.458086 |          8.445990 |
| overview          |      4.489718 |         13.222187 |

两库三任务页均满足原150ms；PG三任务页较快，其余六端点仍较慢。
唯一原绝对失败为PG overview MAX13.222186999992118ms未过严格10ms；未改绝对预算或比较方向。
九个稳定wire投影相同，八个末次完整body摘要相同，overview摘要不同但无raw body，不推断原因。
后置诊断SQLite96语句/69计划、PG125语句/79计划均绑定实际SQL/参数，不能当作原HTTP计时或因果证据。
原exact6f3样本与199.069889ms历史结果保留，不凭跨run时间差将当前改善全部归因于gate。
Reviews/clarify候选只读检查未发现足够依据：实际选定域查询各一条，空输入时PG下游点取/扫描节点的Actual Loops为0；
后置EXPLAIN不是HTTP样本，不相加或据此引入缓存，生产写集合为空。
证据入口为 `/private/tmp/rfc359-w40-final-manifest.json`、各切片清单/独立复核及W39官方终态记录。
本地未运行实际PG、App/HTTP/WS监听、TaskEngine、daemon、E2E、完整门禁或规模性能库。
新SHA真实PG恢复、Linux VM现场和完整Main继续跟踪；原W20限制、原验收条款及六项剩余AC保持。

### W12 第三十九批：fallback执行门控、初始化诊断与中立artifact命名

基于已发布 `66a877da6260decbb84a6a9ae268c578c777629f`，最终14个核心路径冻结（含一个移名旧路径删除）。

- 任务分页只增加物化fallback_gate和对应CROSS JOIN，原完整性条件、LIMIT、CAST及23处插值/绑定保持。
  首个LIMIT+EXISTS候选因实际VM仍遍历主索引而拒绝，未写生产；本批采用的是后续物化gate候选。
  原24-task探针五组正常SQL/完整返回和VM记录有效，但后续poison替换脚本断言失败，整次exit1原样保留，
  没有执行poison SQL，也不将该探针标成整体绿色。空gate的Rewind跳过主Seek/Next与内部调用；
  OpenRead/SorterOpen仍在gate之前，不能宣称没有任何fallback初始化工作或直接推导P95改善。
  新测试五个默认双库行为例覆盖首页、近页、深页、稀疏和空结果，另一个纯例锁住完整源码逆换；
  本地SQLite合计6 pass/218 expect，10主语句经仅两处逆换后SQL相同，绑定及26返回行保持，10个完整物理快照无写入。
  与独立探针跨运行比较时users设置的10个槽位差量以原值/位置/hash保留，不称跨运行所有物理行相同。
  原W27只扩展逆换器，六个原注册及33完整matcher（30 direct、1 not、2 rejects）保持，两原纯例2/22通过。
  指定VM控制直接对已记录程序使用实际checker：五旧VM在缺失物化gate处红、五候选绿；
  五个已记录候选VM的Rewind跳址数据变异在边界断言红。这些是纯VM数据控制，不是五次SQL变异执行。
- provider helper新增可选诊断绑定器，四个原测试文件保留五个suite调用、16原声明/51 matcher、完整callback与预算。
  默认路径不创建observer/timer/附加Promise观察；选定路径原native Promise、值/错误身份和同步抛错保持。
  原memoization和cleanup等待初始化再close的顺序保持；最多64条阶段记录、4750ms单次unref提示，快路径无输出。
  实际合同是group/root operation ID与raw sourceFile；不提供子阶段父子ID、锁持有者或历史因果证明。
  原生命周期纯控制2/14，最终纯控制8/149；派生Promise、漏clear、漏unref、漏初始化await、旁路异常外逃
  五个指定负控均被拒。首次五次loader错误完整保留但不计有效负控；未在本地执行四个旧业务文件或真PG。
- 无DB/client/SQL/PG协议依赖的resourcePackageArtifacts整文件17779字节移名，12原函数/4导出保持。
  一个生产与一个测试消费者只换import literal，完整逆换和Bun/TS输出保持；T17仅删除对应一条，60→59。
  原六候选计划因额外要求已有双库消费者而全部拒绝，原件保留；按proposal既有中立命名合同补页纠正该一项，
  其余五项真实机制/类型差异未因此获准移名，也不将本项当作AC-1/12整体关闭。
- 首次14 core完整tsc仅新测试readonly tuple断言类型不匹配；只补readonly类型参数，完整Bun/TS运行JS相同。
  首次失败收据保留，修后完整tsc通过。6/218真实SQLite证据绑定修前55409d源码，经完整运行JS桥接至最终e39af032；
  不将旧运行重新标记成修后源码实跑。各切片严格lint含实际max-warnings0、format及原T17四例通过。
  原metadata writer/governance刷新13文件，211 pass/433 expect功能metadata和13 pass/55 expect canonical通过。
  2578个当前生产输入中2575原blob保持，三个差量为artifact新路径、consumer import及任务query；旧artifact路径另删除。
  sourceDigest为 `sha256:19764fe60645f2898b2e837348592a2128dd35e644dd79582a31d810453318e2`，
  六canonical数仍1740/272/983/5328/4794/25063，全部无关规则按opaque原身份保持。
  census为1954测试文件、606构库文件/1228调用、576无harness/454有harness；旧迁移仍242完整/16混合。
  T19f整文件689条和native兼容4文件/7调用保持，新增五例不是五个旧文件迁移。

W38 exact `66a877da6` Main `34334471348` 终态40 jobs为38 success/2 failure，13后端与普通lint全部成功。
69份官方blob、12发布路径、294原callback和两OS各1952文件恰一次已核；742重点执行全过：
Ubuntu446（146 SQLite、146 PG、154 single），macOS296（146 SQLite、150 single）。
另2个原RFC234 sidecar为25.55/57.49ms，各10 phase加1 settled，无near timer；不混入742分母。
独立P0 artifact 35成员/34阶段原日志有效，两库134 pass/44指定历史失败；99前后源码映射保持，
其中只有2项独立对上该69份官方blob，不能宣称99项都经过这一官方来源核验。
原watch已自然exit1且回收；这些新通过记录不证明W37八条历史失败同因或根因已修复。完整Main仍未绿。

本批实际PG行为、PG查询计划及原规模full HTTP P95留待新发布SHA；原exact6f3的360样本、原规模/20轮/
绝对预算与两库比较判据保持，六端点PG较慢及SQLite任务首页199.069889ms超过150ms的原结论未关闭。
证据入口为 `/private/tmp/rfc359-w39-final-manifest.json`、三个切片最终清单及独立复核、W38官方终态复核。
本地未运行实际PG、App/HTTP/WS监听、TaskEngine、daemon、E2E、完整门禁或规模性能库。
RFC359及AC-1/6/8/9/11/12继续开放，原W20限制和所有原验收条款保持。

### W12 第三十八批：原 Agents CRUD 与 Webhook GC 双库覆盖

基于已发布 `7fb629ebdda5a56f3b89b25b26f1466e6d29331b`，最终3个核心文件冻结，生产源码保持。

- Agents保留22原声明/68完整matcher；6个原异步CRUD例/20 matcher默认双库，16未选例/48 matcher保持。
  原单service组按原注册顺序拆为四个同层组（selected2、retained3、selected4、retained4）。
  两provider组各自绑定实际harness.db，原native初始化赋值供两个保留组复用，构库调用点2→2。
  全部22完整call/callback、token/literal、44份Bun/TS callback输出与原相同，完整HTTP组和四原helper保持。
  原baseline与最终同层候选均6 pass/20 expect，未执行16个未选例或完整App。
  99条有序SQL及绑定/原生结果、34快照/13重复行/269字段/88原JSON/42 NULL、16 await返回保持。
  15个实际owner Promise含13成功与2个NotFound错误，两个错误的raw stack差量保留，其余own字段保持。
  受控观察器实际改写一条已记录SQL，两边原文与执行文分别一致；这些是受控对拍，不称未经观察器的所有输入均逐字相同。
  首个嵌套候选c7dd虽通过6/20，却使一个未选call被Prettier换行并多一个CommaToken；
  原token相等断言的失败、旧源及旧运行收据完整保留。最终同层6c912候选避免该变化，并实际补跑一次选定capture；
  不把旧收据换签为最终源码实跑，也未重复原baseline。
- RFC261保留17原声明/71完整matcher；3个原GC例/9 matcher默认双库，14未选例/62 matcher完整raw保持。
  seed helper只有DbClient→ProviderNeutralDatabase参数类型差量，完整Bun/TS运行JS相同；另一个原DbClient helper保持。
  原后均3 pass/9 expect，3个构造退役，文件constructors7→4；原输入、await、默认预算和其他HTTP/setup保持。
  78条有序SQL、46完整快照/468重复行/8424字段/4760 NULL/388原JSON/2897 UTF8字节及36个await返回保持。
  GC三行用例仍2个body清理/1行删除；25个过期行的body与row批次均为10/10/5；动态配置同一实例仍0/0→1/1。
  比较的是完整capture.values，capture顶层phase/source hash不同，不称两个capture文件完整字节相同。
  初次编辑前置条件失败未写repo，随后两个误标candidate的运行实际仍在原源上，作为重复原baseline留档；
  后续真实候选绑定实际source hash，不用误标签冒充新候选证据。纯证明脚本的两次假设修正亦保留原失败记录。
- 两文件合计39原声明/139 matcher，新增9个原DB例默认双库，30个未选完整call保持；累计242完整/16混合。
  全量census1952测试文件、606构库文件/1228调用、576构库文件无harness/453文件有harness。
  T19f仍689条，仅原GC一项7→4，精确逆换后整文件字节相同；native事务兼容仍4文件/7调用。
  全部2578生产输入与已发布7fb一致，sourceDigest仍为
  `sha256:319afb5cfe11ce5f6273bf8ff807e81080070768d6d994771fdf435e58144309`。
  8份canonical及RFC294 parent status完整字节保持，六数1740/272/983/5328/4794/25063不变。
  原writer及governance只更新4份provenance，依原highwater合同移除三项未继续增长的W37一次性许可；其余规则按opaque身份保持。
  最终3core只运行一次完整backend tsc并通过，211 pass/433 expect功能metadata和13 pass/55 expect canonical通过；
  定向严格lint含实际max-warnings0，format检查通过。最终三组检查前后绑定同一3core；guard早期lint/format仅按41f6目标文件字节相同复用，未将当时c7dd上下文记为最终Agents候选验证。

两个空facet候选均没有进入生产。原四个24-task小库的结果对拍不证明节省执行；独立两次17-row真实SQLite控制中，
分页末尾判断仍执行指定projection错误，普通bytecode也证明根分页先于判据完成。
physical_prefix内判断可跳过该投影，但零facet分支跳往Prev并绕过LIMIT递减，使时间索引可能全遍历，故同样拒绝。
第二候选还引入对后置facet CTE的前向引用，不能未经处理用于旧截断CTE诊断；facet块实际有3处插值/11绑定，不是无绑定文本。
所有探针数据库已关闭；生产query与exact6f3全文一致，没有新full性能样本或P95改善结论。
exact6f3的原seed/schema推导agent/workgroup来源为空，原profile没有返回行正文；不能以rows=1直接声称观察到facet_all=0。
原profile一基第12/14条的39.459965/42.548269ms只是HTTP后的单次诊断，不是P95。
原full360样本及原规模/20轮/预算/比较判据保持，六端点PG较慢和SQLite任务首页199.069889ms超过150ms仍开放。

资源包mapper与9个装配诊断另作有界只读核验：没有找到足以新建共享算法的完整重复函数；
已检查的scope查询、四能力检查与兼容诊断各有真实合同，不据此删除诊断或宣布整个AC1/12完成。
skills旧service候选依赖原createApp，未获本地执行范围，不为取得baseline删除setup，故在运行前拒绝并保持原源。

W37 exact `7fb629ebd` Main `34328144901` attempt1终态40 jobs为37 success/3 failure，13后端12 success/1 failure，
普通lint job `102390128244` success。75份官方blob/255个原callback与冻结计划已对齐；
12个native分片依原modulo发现，两OS各1952文件恰一次。38重点文件655执行全部pass：
Ubuntu398（137 SQLite、137 PG、124 single），macOS257（137 SQLite、120 single）。
RFC234另2个sidecar分别37.52/35.81ms通过，各10 phase加1 settled，最后assertions-complete，无near timer；
它们不在655分母内，不证明历史超时根因已修复。
唯一失败后端为Ubuntu3/8 job `102390128400`，8条原失败记录均在冻结38重点文件之外。
原stdout-tail记录明确为 `postgresql-schema-lock-held`，stack指向migrator及eachProvider的beforeAll初始化，
该条393.22ms，不是本条60s DROP超时；首个d16记录5000.79ms尚未证明同因。
各条原输入、预算和日志保持，实际初始化/清理链继续定位，未把它们统称为同一个业务回归。完整Main未绿。
W38 collector保留原655主集身份，加Agents50与RFC26137，共40主文件742（Ubuntu446、macOS296）；
另保留2个原RFC234 sidecar，合计744/41文件。这些是新SHA的待验预期，不是本地或真实PG成功记录。
证据入口为 `/private/tmp/rfc359-w38-final-manifest.json`、两行为切片及独立复核、两查询拒绝报告与原full artifact。
本地未运行实际PG、App/HTTP/WS监听、TaskEngine、daemon、E2E、完整门禁或规模性能库。
RFC359及AC-1/6/8/9/11/12保持开放，原W20限制与所有原验收条款保持。

### W12 第三十七批：两库资源包读取共用与原工作流 CRUD 双库覆盖

基于已发布 `283582f8786b6ab79e602342dd06a2199836d886`，本轮5个核心文件冻结。

- `pluginCachedPathQuery` 共用两个实际 SQLite/PG 恢复owner的相同37 token查询前缀，
  原artifact对象的key在select/from之后读取；原get/await仍留在调用方，其他完整owner字节可精确逆换。
  复用已有模式类型，3个准确类型断言和同步赋值检查通过；三个生产文件632→639行，净增7行。
  新3例默认双库，原控制、候选捕获及最终无观察器运行均3 pass/45 expect。
  41条scoped SQL与整份raw capture相同，7快照/20重复行/320字段/34 NULL/20原JSON容器保持。
  cachedPath本身非NULL；覆盖合法空串、Unicode、空格/反斜杠、missing id、惰性求值和原事务rollback。
  错ID、错字段、提前执行及提前读取key四个变异均在指定实际结果或机制断言处失败。
  这些是原查询表达式的真实数据库验证，未执行完整恢复、文件系统或回执流程，不宣称整个owner已合一。
- Workflows旧文件保留22原声明/52完整matcher；6个原异步CRUD例/13 matcher默认双库，
  另16声明/39 matcher维持原形：13个HTTP整组原字节保持，3个native service例仅精确缩进调整。
  原5个共用helper与native setup内容保持，constructor仍2→2，属于部分迁移，累计242完整/14混合。
  选定原后均6 pass/13 expect。两task INSERT只补原实际触发器生成的executionLineageId及完整谱系JSON，
  原ulid调用一次、原rootTaskId/workflowVersion的NULL和原其他种子保持；没有额外workflow或关闭FK。
  54条SQL中52完整相同，2条INSERT保持原23绑定前缀并增加两个实际谱系值，changes2→1而rowid仍1。
  34完整快照/13重复行/388字段/189 NULL/21原JSON保持；15个await值13相同，2个丢弃写返回差量保留。
  13个owner Promise中10个成功值相同，3个错误除raw stack外的全部own字段相同，完整stack差量另存。
  8次实际COMMIT后的完整通知及顺序保持。原list仍依赖native DbClient，本批未扩到生产接口或HTTP执行。
- 首次完整backend tsc报新query fixture三行TS2741：installedAt由原beforeEach.map提供，但
  literal数组提前声明为完整insert类型。仅将satisfies类型改为省略installedAt，实际字段/时间/回调不变；
  完整Bun和TypeScript emitted JS分别相同，原3/45及负控通过桥接复用。
  原失败log与旧源/manifest保留；修正候选的一次完整tsc通过，独立复核与最终定向strict lint/format通过。
  211 pass/433 expect功能metadata和13 pass/55 expect canonical在最终5core上通过。
- 当前1952测试文件、606构库文件/1231调用，578构库文件无harness、451文件有harness。
  T19f原689条和完整守卫源保持，仅依原highwater合同移除不再增长的上批allowGrowth；native事务兼容仍4文件/7调用。
  canonical六数1740/272/983/5328/4794/25063；owner新增helper文件和函数两个身份。
  observed-imports原始差量3增2删，exceptions为2增1删，均净增1；不把净数写成只有一条原始边变化。
  实际增长许可仅对应新共享helper。原未改字段与规则按opaque identity保留，sourceDigest为
  `sha256:319afb5cfe11ce5f6273bf8ff807e81080070768d6d994771fdf435e58144309`。

W36 Main `34323372154` attempt1、exact `283582f87` 终态40 jobs中38 success/2 failure，
13后端与普通严格lint全部通过。74官方blob/31发布路径及246主集注册已核，两OS各1951文件按8/4分片恰一次。
36选定文件628执行全部通过：Ubuntu380（128 SQLite、128 PG、124 single），macOS248（128 SQLite、120 single）。
W35原597身份全部保持；RFC185原retry和新增真实旧快照回归均通过三条指定lane，历史失败/原日志继续保留。
独立P0 artifact `10092830451` 的35个成员与API digest一致，SQLite/PG各17阶段，共34阶段全部有效；
99个源before/after一致为artifact原报告，只与已下载官方源交叉核了其中2条，不宣称独立核过全部99条。
RFC234选定afterPluginInstall sidecar本次Ubuntu36.78ms、macOS44.02ms通过，各11诊断到assertions-complete且无near-deadline；
其2次执行单列在628之外，不证明历史超时原因。静态扫描与其汇总检查仍失败，完整Main未绿。

根查询优化只作四个24-task实际SQLite小库计划探针。原查询与单次LEFT JOIN候选的结果/完整行虽一致，
候选却将non_view_matches物化并逐前缀扫描，原查询保持精确主键回接，故未写入生产。
首探针误用raw search参数、未实际激活过滤，原源/结果保留；最终以q参数并检查解析结果重做四种原夹具。
这些探针不构成P95样本；原生产查询完整字节保持，本批无新full性能结果。
原360样本仍只归exact `6f3be930c`，六端点PG较慢，SQLite任务首页199.069889ms未过原150ms。

证据入口为 `/private/tmp/rfc359-w37-final-manifest.json`、两个切片manifest及独立复核，
W36原托管证据与root独立复核。新SHA计划继承628主集身份，新增query9与workflows18，
主集38文件/655执行（Ubuntu398、macOS257），另2个RFC234 sidecar，共657为待验预期。
本地未运行实际PG、HTTP/WS服务、TaskEngine、daemon、E2E、完整门禁或规模性能库。
AC-1/6/8/9/11/12与RFC保持开放，原规模、样本、预算及P95比较判据不变。

### W12 第三十六批：状态查询合一、异步快照修复与原行为覆盖

基于已发布 `1aab39f65ec5efd37d6b041ad70747a51dd65cd7`，本轮13个核心文件独立冻结并完成一次backend类型检查。

- 三个原状态查询前缀合一到 `skillOperationStateQuery`，原同步 `.get()`、等待 `.get()`、等待 `.limit(1)` 后取首行保持。
  原公开数据库alias完整恢复，新增显式 `ProviderNeutralDatabaseForMode` 供内部泛型推导使用；没有改公共接口字段渲染器。
  六个精确类型断言通过，两处完整TypeScript/Bun运行JS与类型修正前相同；实际生产净增8行。
  原、候选及最终选定4例均4 pass/47 expect，3例默认双库、1例验证native即时返回。
  41条scoped SQL及5次额外native读保持，31条tail观察含26次嵌套重叠，不相加为独立操作；
  7快照/21重复行/315字段/168 NULL保持，非NULL JSON容器为0。五种结果、SQL、即时及惰性求值负控各指定失败。
  类型词汇修正未改变运行JS，复用原实际DB证据；旧类型候选、所有原日志及RFC243依赖桥接保留。
  当前三个生产调用仍为native，现有PG对应文件没有同一loader，不能虚构PG消费者或宣称整个owner已统一。
- Workgroup driver在原load前捕获 `inflight.size`，原取消检查后检测load期间完成的turn并重新读取。
  两个同步set都仍在load之后，期间仅有两个原finally删除，故数量变化说明旧快照可能已落后；其他driver字节可完整逆换。
  新回归使用真实persistence/load/commit与原fake host，返回同一个实际旧快照对象；原driver稳定产生第三次member调用，
  且真实ledger多出第二个retry0消息回合。修后只保留原retry0消息回合及retry1协议重试。
  原有30注册（29直接与1个each，后者展开2运行名）/81 matcher全部原字节保持，新加1默认双库例/4 matcher。
  独立审查发现新夹具leader先结束可能令下一load错过屏障，现只在新leader host返回前等待member实际进入第二host；
  原finding、旧候选与旧红绿均保留。最终原driver1 pass/1 fail/5 expect，修后2 pass/6 expect；旧取消两例2/17保持。
  历史W35日志缺cursor/完成阶段记录，本轮证明实际可复现的缺陷，不把历史托管交错称为已直接观察。
- RFC243 child-count只迁原5注册中的3 DB例/9 matcher，另2 single/5 matcher原字节保持；原后3 pass/9 expect。
  原完整seed仍供native组；选定组按原parent-first顺序继承并追加实际谱系，不额外创建workflow行，不关闭FK。
  原rootTaskId/workflowVersion及其他NULL保持；原两级孙节点谱系已真实核对。
  12条SELECT完整SQL/绑定/返回保持；3条INSERT保留原逐行绑定前缀并追加两个已观察谱系绑定，
  native changes分别14→7、4→2、6→3，lastInsertRowid仍7/2/3；这些实际差量明确保留。
  27快照/24重复行/1680字段/1042 NULL/72原JSON与7个原await返回保持，workflow/node_runs原空表保持。
  构造站点5→2；套件仍部分迁移，累计242完整与13混合。最终db/query类型改动通过完整emit桥接复用原依赖证据。
- 独立P0 runner只替换一条源位置正则，接受完整wrapped/bare目标路径及数值行列；其他阶段、诊断和预算完整逆换相同。
  原15纯case全部字节保持并未扩到本地执行，新2纯case原validator0过2红、最终2过/80 expect。
  原官方两份完整日志由true/false变为true/true，20份只改目标frame的负控全拒；错误路径、缺行列和正文伪frame不能通过。
  首候选曾接受无括号anonymous前缀，负控红和候选原样保留，最终收紧前缀后通过。没有执行本地P0业务或实际PG。
- RFC234只为原afterPluginInstall故障注入例加阶段诊断，原3个故障点、10 matcher、throw/await及5秒预算可完整逆换。
  其余28完整注册原字节保持；其他两个点不创建诊断timer或记录。沿原setup语句记录wall/进程CPU阶段，
  选定点使用原setup起点的4秒unref计时器，finally清理并打印当前阶段，故障入口在原throw前记录。
  本地原例1 pass/10 expect，新增记录11条且实际near-deadline未触发；纯控制核对延迟钳制、unref、清理和捕获对象。
  setup若未返回不会进入case记录，事件循环同步阻塞时timer不能及时触发，CPU为进程级；这只是诊断，未宣称超时修复。

W35 Main `34317310011` attempt1、exact `1aab39f65` 终态40 jobs中35 success/5 failure，
13后端11过2红，普通严格lint通过。53官方blob/11发布路径和234原注册已核，两OS各1950文件按8/4分片恰一次。
33选定文件597执行596过1红：Ubuntu361（121 SQLite过、120 PG过/1 PG红、119 single过），macOS236全过。
新增两文件91执行与15新PG全过；原HTTP/mission及本次RFC314业务观察/清理通过，历史根因不据此宣称修复。
原RFC185重试例在Ubuntu7 job `102356129375` 收到3次member调用而预期2次，305.64ms，非超时。
独立P0 job `102356129080` 原集成步骤通过；34个mutation阶段33个有效，仅PG p0-10-unsettled-release因栈格式校验无效，
原指定失败和通过控制均匹配，真实完整目标文件:381:19存在，缺失的是旧正则要求的anonymous包装。
RFC234原afterPluginInstall例本次macOS32.42ms、Ubuntu22.11ms均通过；该sidecar不计入597，也不证明W34超时根因。
W35原失败、完整日志和原source保持，不以新诊断源码冒充旧托管证据。

本轮13core一次tsc与211 pass/433 expect功能metadata通过；原13 pass/55 expect canonical通过。
独立复核发现类型词汇修正后的格式红日志被误记为通过，原错误声明与红日志保留。
最终只格式化db/query的类型别名，全部TypeScript tokens（含literal）和完整运行JS相同，其余12core未变，
据此桥接复用原类型与行为结果，未重跑完整tsc或DB；真实定向lint/format和刷新后的13/55 canonical重新核验。
当前1951测试文件，606构库文件/1231调用、579构库文件无harness/449有harness；T19f688→689，
新增1个实际native即时返回见证，同时child-count退3个构造，不能把这条必要native记录删掉制造归零。
原生事务兼容仍4文件/7调用；canonical六数1740/272/983/5327/4793/25061，3个新增owner对应显式模式类型、查询文件及函数。
公共接口字段全部恢复原词汇，未改不相关why/规则或opaque类型许可；sourceDigest为
`sha256:c4520f71e0e68fffc4a4d5f29df42fe597ee5eec5287bf9c24720febf9d2e40e`。

证据入口为 `/private/tmp/rfc359-w36-final-manifest.json`、各切片最终manifest和独立复核，
以及W35原官方托管证据与root独立复核；本轮托管计划逐项继承原597身份并新增31，
主集36文件/628执行（Ubuntu380、macOS248），另有RFC234两OS独立sidecar，合计630仍为待验预期。
本地未运行实际PG、HTTP/WS服务、TaskEngine、daemon、E2E、完整门禁或规模性能库。
本批无新full性能结果；原360样本仍只归exact `6f3be930c`，六端点PG较慢，SQLite任务首页199.069889ms未过原150ms。
AC-1/6/8/9/11/12与RFC保持开放，原规模、样本、预算及P95比较判据不变。

### W12 第三十五批：插件与 workgroup CRUD 原用例接入双库

本批基于已发布`2a4a3bcc3106f515590a3b5d051cebb58efa7529`，无生产或外部helper改动。
插件原13声明/53完整matcher，选8DB/35 matcher，保留5single/18 matcher；workgroup原25声明/92 matcher，
只选原CRUD组内7DB/35 matcher，保留18single/57 matcher。两文件共38原声明/145 matcher，
15原DB/70 matcher默认双库，23single/75 matcher保持；两者仍为部分迁移，累计242完整与12混合套件。
原注册相对次序、输入、预期与预算保持；原后分别8 pass/35 expect和7 pass/36 expect。
Workgroup原循环重复执行一个matcher，所以70个选定静态matcher对应71次实际expect，不混用两种计数。

- 插件三个provider组与三个native同级组保留原顺序；五个single完整注册/callback、原native setup callback及afterEach原字节保持。
  Provider组用同一harness.db再走原FS/env/binding尾部，不额外创建SQLite；原短命fake-npm仍实际执行，无网络npm。
  原GC任务INSERT保持70列名/顺序与23原绑定完整前缀；只把两个原null值槽改为原物理谱系值的绑定。
  原node_runs INSERT/UPDATE不动，原lineage_slot_path_json仍NULL；既有busy/clear输入由原fixture提供，不能称其从node_runs推导。
  受控原后使用41个实际原ULID的同序输入、同一时钟与8个真实目录：每次先真实mkdtemp，
  再把本批自有新空目录rename到原已完成cleanup的对应路径，业务/SQL/子进程/FS实际执行，不伪造行或文件内容。
  79完整快照、25重复行/635字段/245 NULL/26原JSON保持；70 SQL中69条完整相同，1条保留两值槽/绑定差量。
  28个原await返回中27个完整记录相同，1个原已丢弃的task INSERT返回changes2→1、lastInsertRowid相同；原caught记录保持。
  52个FS快照中327次文件观测的55537字节、路径/类型/大小/符号链接目标保持；728自然mtime与1个观察label差量原样保留，
  不使用mtime归一化，不称整个FS或capture相同。初始自然输入对照2106叶差量另存，全部八目录的实际cleanup已核。
  原样、自然观察和受控原后六次均8/35；原两次纯source proof构造错误分别为literal打印形状和多余换行，
  原始记录保留，修正的是观察/逆换工具，没有为它们改测试预期或生产代码。
- Workgroup第二个原describe只迁连续0–4和7–8；另三CRUD注册增加两空格包装缩进，精确逆缩进后完整原字节恢复，
  不能直接称原始字节相同。外面两组15注册、原native setup callback完整字节保持，未选18例不在本地执行。
  三个helper的DB参数类型中立化，完整body及Bun/TypeScript运行JS相同；五个原rejects只新增外层await，完整matcher本体保持。
  原后及受控原后各7 pass/36 expect；原作用域种子、同一真实owner调用和原预算保持，构库站点2→2。
  受控247 SQL的文本/执行SQL/方法/有序绑定/底层结果保持；82快照、156重复行/2737字段/242 NULL/672原JSON全同。
  20个原await返回与14次实际COMMIT后完整通知保持；59个Promise观察包含嵌套重复，53 fulfilled及6个name/message/code错误投影相同。
  这些不是59个独立业务操作，六份投影不等于六个失败用例，也不证明Error栈及所有属性一致。
  原/后本地观察到的Promise都在afterEach时结算；此事不替代历史PG调度证明，也不能证明外层await多余。
  初始观察器在afterEach边界收口以排除后续harness reset，原capture与最终原capture相同；初次pure checker误把未选旧await计为新增，
  后按选定索引修正。两类工具问题原始证据保留，不算产品用例失败。

W34 Main`34314486701`、attempt1、exact`2a4a3bcc3`终态40任务37 success/3 failure，
13后端12 success/1 failure，普通严格lint通过。52官方blob/14发布路径与196原callback hash已独立复核；
两OS各1950原生测试文件按8/4分片恰一次，无遗漏/重复。31选定文件506次全过：
Ubuntu为106 SQLite、106 PG、96 single，共308；macOS为106 SQLite、92 single，共198。
新增9真PG、旧十HTTP PG与两mission PG原callback全部通过；RFC314本次11观察及其group清理通过，历史机制未宣称修复。
原RFC185首fan-out例本次SQLite36.70ms、PG347.82ms均通过，所属Ubuntu组43执行全过；
本次没有触发结果诊断，W33真实失败原因仍未知，不把后继新提交通过当作已证明的根因修复。
后端剩余macOS4 job`102347736241`失败：RFC234在853行注册的afterPluginInstall故障注入例，
原日志5059.18ms并明确超过5000ms；同SHA Ubuntu8 job`102347736306`同callback20.56ms通过。
该局部日志没有阶段、SQL或hook记录，不能从标题断言afterPluginInstall确实已到达；原预算保持，具体原因继续有界定位。
此sidecar不改变原52源/31目标集合；选定506全过不等于完整Main全绿。

两core冻结候选的一次完整backend tsc通过且hash保持；两切片严格lint(max-warnings0)/format通过，
211 pass/433 expect功能metadata与13 pass/55 expect canonical通过。
当前1950文件、605构库文件/1233调用、580构库文件无harness、447文件有harness；两个原文件构库站点均保留，
T19f整文件及688条保持，原生兼容4文件/7调用不变。2576生产输入、8份canonical与parent status完整字节保持，
sourceDigest仍`sha256:f16382c8d985c1d05b12b09dd0a6ab74f2a423237d8b244f99cbd2a692e9e611`，
canonical六数1740/272/983/5327/4794/25058和原owner/guard/ledger/why/许可保持。
仅四份治理JSON的provenance.currentSnapshotSha从13b0e3b3f推进到2a4a3bcc3。

证据：`/private/tmp/rfc359-w35-plugin-manifest-dirac.json`、`/private/tmp/rfc359-w35-rfc164-manifest.json`及独立复核，
`/private/tmp/rfc359-w35-metadata-manifest.json`与唯一两core tsc；
`/private/tmp/rfc359-w34-backend-hosted-evidence-planck.json`、`/private/tmp/rfc359-w34-hosted-independent-root-review.json`，
以及`/private/tmp/rfc359-w34-rfc234-sidecar-case-proof-planck.json`。
新SHA的15个原PG例及完整Main仍待托管；无本地实际PG、HTTP服务器、daemon、TaskEngine、E2E、规模库或完整门禁。
本批没有新full性能结果；原full360样本仍仅归exact`6f3be930c`，六端点PG较慢，SQLite任务首页199.069889ms仍未过原150ms。
AC-1/6/8/9/11/12与RFC继续开放；原历史、W20范围、规模、样本数与严格P95判据保持。

### W12 第三十四批：旧数据库夹具迁移与实际 fan-out 失败诊断

本批基于已发布`13b0e3b3f1013220c670f17d09d6619afb666dae`，无生产源码改动。
三个旧文件保留17个原声明与55个完整callback matcher：revision为8声明/27 matcher，选5DB/18；
pending为6声明/13 matcher，选3DB/7；WS为3声明/15 matcher，仅选首producer的1DB/5。
合计9个原DB例/30 matcher默认双库，8个原single/25 matcher继续单跑；原相对注册顺序及预算保持。
三文件均为部分迁移，候选累计242完整套件与另10混合套件，不增加完整套件数。

- Revision/pending沿原实际中立owner调用，六个原native完整注册/callback字节保持。
  Pending的test-local seed新增默认false的显式谱系参数，仅三个选定调用传true；原native默认分支保持。
  五个种子task INSERT与一个原直接INSERT补原物理行已有的execution_lineage_id与lineage_slot_path_json，
  原26个绑定完整前缀相同，将对应两个值槽的占位还原为原null/null即还原原SQL；原70列名及次序保持，未改生产迁移、触发器或业务规则。
  原后分别5 pass/18 expect与3 pass/7 expect。受控对照105快照、101重复行/2406字段、920 NULL与148原JSON容器全同；
  209条SQL中203条完整相同，另6条保留精确谱系差量；底层changes由2变1，lastInsertRowid相同。
  17个完整返回/序列化值与3个seed void返回保持，1个原已丢弃的await write返回差量单列，不能称所有返回相同。
  8次真实通知的完整参数相同，都发生在实际COMMIT之后且inTransaction=false；原stale版本例仍是顺序场景。
  node_runs只有6份空表快照，不据此扩称非空node_run行为对拍；自然执行日志的源绑定由实际preload及受控loaded-source hash补证。
- WS首producer仅新增harness import、替换原describe与第一处构库，精确三逆换恢复整个原文件字节。
  原两native完整注册、13个原import及两个resetBroadcasters hook保持，均未在本地执行或解释。
  选定例沿实际createWorkgroup/saveWorkgroup/deleteWorkgroup与进程内broadcaster，原后各1 pass/5 expect。
  26条实际SQL/执行SQL/ordered binding/底层结果、5快照/2重复行/42字段、4完整返回与3完整广播参数保持；
  三次广播都在实际COMMIT之后且inTransaction=false，原empty Set保留类型与零基数，最终完整capture payload相同。
  最初观察器把实际空Set记成空对象，初始原始记录保留；后续补Set等原类型后，再补两处原已丢弃await结果的临时观察，
  没有新增await。最终before通过原路径plugin加载原source；当时磁盘已是候选，disk hash与loaded-source hash分开记录。
- RFC185只把原首失败例的expect(result.kind).toBe('ok')增加JSON.stringify(result)诊断消息。
  精确一次逆换恢复整个原文件；29原声明/81完整matcher计数保持，其中80个完整matcher原字节相同，
  一个只增消息，原kind参数、ok预期、脚本、后续断言及预算不变。实际公开返回是kind及可选plain detail，诊断可保留原失败详情。
  没有本地执行TaskEngine或该用例；此项是收集真实失败链所需的诊断，不是已证明的根因修复。
- 仓库facet实验尝试合并原all_count与attention_count两条扫描，其他三臂和原getter/绑定次序保持。
  空库及12仓库/4任务/3引用/1计划的两个小SQLite控制2 pass/30 expect，完整页面JSON和五计数保持。
  但实际同库EXPLAIN/bytecode显示原all_count的Count快速路径、原attention的选择性覆盖索引SEARCH被全索引逐行聚合替换，
  候选已拒绝：生产repositoryWorkspaceStore.ts从未修改，仅删除本批自有未追踪probe，冻结源码及原观察完整留在临时证据中。
  OpenRead或字节码指令数降低不证明更快；没有动态scanstatus、P95或实际PG测量，未扩称性能验证完成。

W33 Main`34311234467`、attempt1、exact`13b0e3b3f`终态40任务37 success/3 failure，
13后端12 success/1 failure，普通严格lint通过。49官方源码blob与14发布路径、181原callback hash已核；
两OS各1950测试文件按原8/4分片恰一次，无遗漏或重复。28选定文件467次实际执行466 pass/1 fail：
Ubuntu为97 SQLite pass、96 PG pass/1 PG fail与90 single pass；macOS为97 SQLite与86 single全过。
新增三份部分迁移共66次执行全过，其中16个PG包括六个MCP HTTP全过；原两mission PG与旧十HTTP PG保持通过。
RFC223新机械callback两OS均过；RFC314本次11个观察与所属清理成功，不能据此认定历史checkpoint机制修复。
唯一选定功能失败在Ubuntu7 job`102338152005`的RFC185原fan-out例，原kind断言预期ok却收到failed，401.99ms，非超时。
该断言后的请求顺序、三个assignment/run/message断言尚未执行；日志没打印原完整outcome.detail、hook记录或失败物理行。
W32同一完整callback及W33 SQLite曾通过，不足以证明PG失败原因；不推测脚本耗尽、排序、SQL或超时分支。

本批五core冻结候选的一次最终backend tsc通过，前后及当前hash一致；严格lint(max-warnings0)/format通过。
211 pass/433 expect功能metadata、13 pass/55 expect canonical通过。当前1950文件、605构库文件/1233调用，
582构库文件无harness、445文件有harness；T19f仅三行8→3、3→2、6→3，688条保持，原生兼容4文件/7调用保持。
2576生产输入与8份canonical及parent status完整字节保持；sourceDigest仍
`sha256:f16382c8d985c1d05b12b09dd0a6ab74f2a423237d8b244f99cbd2a692e9e611`，
canonical六数1740/272/983/5327/4794/25058及原owner/guard/ledger/why/许可保持。
仅四份治理JSON的provenance.currentSnapshotSha由0449e91ee推进到13b0e3b3f。

证据：`/private/tmp/rfc359-w34-ac6-manifest-dirac.json`、`/private/tmp/rfc359-w34-workgroups-ws-manifest.json`、
`/private/tmp/rfc359-w34-rfc185-diagnostic-manifest.json`及各自独立复核；
`/private/tmp/rfc359-w34-repository-facets-deferred.json`、metadata/tsc收据和
`/private/tmp/rfc359-w33-backend-hosted-evidence-planck.json`及独立root官方源码/日志复核。
新SHA收集计划由源级注册推导31文件/506次预期执行，尚非通过结果；WS只选择首producer，另两native不纳入选定功能结果。
本批9个新PG用例、fan-out实际诊断及完整Main仍待托管；没有本地实际PG、HTTP服务器、daemon、TaskEngine、E2E、规模库或全门禁。
本批无新full性能结果；原full360样本仍仅归exact`6f3be930c`，六端点PG更慢、SQLite任务首页199.069889ms未过原150ms。
AC-1/6/8/9/11/12与RFC仍开放；W20范围、原历史、原规模、样本数和严格P95判据保持。

### W12 第三十三批：旧套件部分双库迁移与完整异步源码检查

本批基于已发布`0449e91eeba4e0ffb4619532ccd760921d1f551e`。三个旧套件保留全部25原声明：
workflow revision为11声明中5DB/30完整callback matcher，intent state为7声明中5DB/35 matcher，
MCP exact为7声明中6DB/25 matcher。16旧DB例默认双库，9原single继续单跑；原注册相对顺序与预算保持。
三文件都保留原生兼容用例，本批只增加3份部分迁移，候选累计242完整套件与另7混合套件。
90是选定callback的完整matcher数，不是25个声明的全文件matcher总数。MCP六例均为HTTP，未在本地运行应用。

- Workflow revision只替换五个既有DB夹具，沿用真实workflow owner与原保存调用；本地save helper仅DB类型变化，
  完整body与整个函数TypeScript输出相同。六个原single完整注册和callback字节保持；原生构库11→6。
  原后各5 pass /30 expect，六原single全部过滤，原5s预算保持。59条实际SQL/执行SQL/ordered binding/底层结果全同；
  19快照、14重复行/168字段/14 raw JSON、14完整返回全同；8个原广播都在实际COMMIT之后、连接inTransaction=false时发生。
  原后完整capture payload字节相同；初次preload位置错误未产生capture的观察单独保留，不计入正式对照。
- Intent state把五个原DB例接实际harness，原native setup仅作用于两个原single；中立组不额外创建SQLite。
  原五条初始化语句完整AST与次序保持，共享原生constructor仍一处。seedFakeRoot仍非async并直接返回原run结果，
  三个原生调用的即时完整行见证保持；选定调用在原位置等待，insertDraft的两个原写入依原序await。
  原后各5 pass /35 expect，七声明/45全文件matcher保持，选定五例35 matcher、保留两single10 matcher。
  一个single的完整注册/callback字节保持，另一个因夹具分组只增加统一两空格缩进，逆缩进与完整AST相同；
  不能将后者描述为原始字节完全相同，两者均未本地执行。
  初始自然capture的9个nonce差量完整保留；记录9个实际原生产者返回，以相同调用参数/次序提供给候选后，
  253条callback完整SQL/绑定/结果与53快照、210重复物理行/3232字段/312原JSON、24完整返回保持。
  全328条SQL文本、方法与顺序相同，但5个原setup binding及5个readback差量仍原样保留；
  不归一化这些原值，不称全部328条绑定或整份capture字节相同。初始观察器递归单列为无效instrumentation。
- MCP exact保留原native harness、八个原helper完整字节、probe清理和原四应用选项；两个默认双库组各4/2例，
  中间原single完整注册字节及原位置保持。六个原app获取语句使用实际完整createProviderHttpApplication和同一harness。
  首候选漏掉其必需appHome，独立复核在任何backend tsc之前发现；现已创建自有临时目录，
  创建拒绝时清理，成功实例等待dispose后finally清理。没有实际运行过的首轮typecheck失败可供宣称。
  全七个原注册经精确逆换后，完整AST及parser叶token相同；最初独立lexer没有template rescan产生的假差量单独保留。
  仅做source/AST、严格lint/format与类型检查，真实六HTTP的SQLite/PG执行等待本批托管。
- W32的RFC223首条完整async调用期望已经通过；真正红项是紧随其后的旧no-await matcher。
  本批只修同一机械callback和所需AST工具，核实际外层return await transaction、async回调与同一tx，
  以及内部原查询/委托的等待、参数身份与次序。保留原两条不透明断言及其他原用例/生产源码。
  独立提取完整机械callback后，原检查在该后继断言红、新检查绿；7个针对原实际AST节点的漏await与错tx负控均在新增guard处红，原首条async字符串期望先通过。
  未载入或执行原整文件的native setup和其他用例；这是源码合同检查，不是运行时PG事务证明。

W32 Main`34307322957`、attempt1、exact`0449e91ee`终态40任务36 success /4 failure，
13后端11 success /2 failure；普通Lint联合任务成功，backend严格max-warnings0实际exit0。
61官方源码blob与32发布路径一致，两OS各1950原生Bun文件按8/4分片恰一次，无遗漏、重复或额外文件。
25个选定源共401次实际执行：399 pass，2 fail都对应RFC223同一机械callback；其余23常规文件388次全过。
Ubuntu为81 SQLite、81 PG、80 single通过及1 single失败；macOS为81 SQLite、76 single通过及1 single失败。
原W31两条mission PG失败以同一完整callback hash恢复；此前十个HTTP PG原例仍全过。
RFC314另11次选定观察全过，所属Ubuntu4/macOS4任务均成功且本组无afterAll失败；
本次没有复发不证明历史checkpoint等待机制已修复，原预算、关闭顺序与历史诊断保持。
401的口径含388常规执行、11个RFC314观察与2个RFC223机械执行，未选领域只记文件/任务数量。

原四core冻结候选的一次backend tsc通过；追加实际typed RFC223 guard后，五core扩展候选的一次最终tsc通过，
各自前后文件hash稳定，两份原始receipt分别保留，不因HEAD移动重复跑。各切片严格lint（max-warnings0）与format通过；
211 pass /433 expect功能metadata、13 pass /55 expect canonical通过。
当前1950测试文件，605构库文件/1242调用，585无harness/442有harness；T19f仅workflow一行11→6，688条保持。
同步兼容4文件/7调用保持；2576生产输入全字节保持，sourceDigest仍
`sha256:f16382c8d985c1d05b12b09dd0a6ab74f2a423237d8b244f99cbd2a692e9e611`，
canonical六数1740/272/983/5327/4794/25058与8份canonical完整字节保持，parent status也不变。
只有四份治理JSON的provenance.currentSnapshotSha从2770352be推进到0449e91ee；原origin、所有guard/ledger行、
why及增长许可均保持，没有新许可。RFC223不是注册guard/ledger文件，不需要改基数。

证据：`/private/tmp/rfc359-w33-{workflow-revision,rfc293,mcp-exact}-manifest.json`与各自独立复核、
`/private/tmp/rfc359-w33-rfc223-manifest.json`与机械源码锁负控、两份tsc、metadata/canonical receipts；
`/private/tmp/rfc359-w32-backend-hosted-evidence-planck.json`及独立root官方blob/原始日志复核。
本批新SHA的16个原DB和六HTTP、完整CI仍待验；没有本地实际PG、HTTP、服务、daemon、TaskEngine、E2E、规模库或全门禁。
本批无新full性能结果；原full360样本仍仅归exact`6f3be930c`：PG其余六端点较慢，SQLite任务首页199.069889ms未过原150ms。
AC-1/6/8/9/11/12和RFC仍开放；W20范围、原历史、原规模、样本数与严格P95判据保持。

### W12 第三十二批：workgroup异步事务、旧套件双库与真实CI修正

本批基于已发布`2770352bee29eb0d36aa3964c13cec49ccf69f15`。四份旧套件保留40个声明、
110个完整matcher与原预算：RFC185为29/81（80个在callback内，另1个在原test-local helper），
RFC203为7/14，RFC291为3/12，outcome为1/3。合计20旧DB例默认双库、20原single声明保持；
候选累计242份完整套件与另4份混合套件。声明数不等于实际执行数，RFC185原pure参数化额外展开两例。
新增6个实际workgroup owner双库控制。本批唯一新增HTTP及20旧DB、6新owner的真实PG仍待新SHA。

- Workgroup的三处native事务使用现有中立async transaction；原读取与写入按原顺序await，
  两个legacy aggregate等候4个真实workgroup委托。整体旧SQLite aggregate合同仍保留，
  不能据此宣称其余分支已支持PG。getWorkgroupById与detail helper原本async，本次只改DB参数类型，
  完整body字节保持。RFC185原12个DB声明默认双库，17个pure声明保持单跑；原后实际31 pass /92 expect，
  新6 owner控制6 pass /28 expect。去掉两个真实hook await的负控在完整行断言红，恢复后2 pass /4 expect。
  1329条SQL/有序绑定/终端记录中1318全同，2条为现有async reader的LIMIT形状差量，9条为task种子显式原谱系；
  228快照、426重复行/11507字段/559 raw JSON、12完整返回与15实际commit后通知保持。
  2658份PG编译记录仅证明无网络SQL编译，不能代替真实PG事务调度。
- RFC203使用真实中立task读取，4个DB例默认双库、3个原source例完整块字节保持且未本地执行。
  原后4 pass /5 expect。42条实际记录38全同，4次task INSERT差量来自两条原播种表达式的原谱系显式化：
  原25绑定前缀保持，unused native changes由2变1，lastInsertRowid和已用返回保持。
  24快照/56重复行/2580字段/68 JSON、5完整返回以及8个node-run谱系NULL保持。
- RFC291三原例/12 matcher完整AST原样、3DB默认双库，原后3 pass /12 expect。
  测试helper四个DB类型与一个import调整，四函数body与完整TS/Bun emitted JS均相同。
  整份原后capture字节相同：75条SQL/绑定/底层返回，18快照、58重复行/1020字段/200原JSON，7完整dump返回。
  该夹具验证catalog inventory与watermark，不声称执行了workgroup detail分支。
- Outcome原一个HTTP例/3完整matcher与14条业务语句保留；同一harness DB与原home传给实际完整应用，
  原四应用选项保持，dispose后恢复home并清理自有目录，外层随后reset。原3种INSERT、ordered bindings、
  完整10物理行/316字段保持；没有本地运行应用或HTTP，真实端点等待托管。
- W31的两条真PG mission失败均为时间戳相同下的次序不同。实际共享全列表增加既有分页的id DESC，
  生产源仅此一个排序项、原RFC311四case/23 matcher整文件不变。原SQLite选例首次2/14，遗漏的过滤预言单独1/146，
  最终一次3/160；一HTTP例全程过滤。使用原seed/seedVaried/pageAll helper和实际owner的原后观察：
  461条记录459全同、2条只追加id DESC，153完整分页响应与2全列表返回保持；
  两独立fixture共65种子行、130重复物理行/5330字段保持，无raw JSON容器值。SQLite相同不证明新PG已绿。
- RFC199仅将唯一import改为type-only，旧严格lint为0 error /1 warning但因max-warnings0失败，新严格lint通过。
  原测试其他字节不变；TS与Bun输出都只删一条无用runtime import，其余token相同，不能称整份JS相同。
  完整应用helper仍真实value-import并调用server composer。RFC223仅将一个旧源码期望改成实际完整async事务调用；
  逆换此literal恢复原测试全部字节。只执行提取的机械源码断言：旧锁红、新锁绿，移除外await、内await、改变tx三个负控红；
  未执行其他RFC223用例或解释原规则。

W31 Main`34302340035`、attempt1、exact`2770352be`终态40任务中33 success /7 failure，
13后端9 success /4 failure，独立PG任务成功；普通Lint联合任务在RFC199一条type-import warning处失败。
55官方源码blob与33发布路径核对，两OS各1949文件按原8/4分片恰一次。18个选定功能文件共266次实际执行：
Ubuntu161为52 SQLite通过、50 PG通过/2 PG mission顺序失败、57 single通过；macOS105为52 SQLite与53 single全过。
W30旧十个PG HTTP原case全部恢复；W31新五HTTP（workflow四、mission一）均真PG通过。
W31新20个DB原型为18个PG通过与2个mission失败，6纯夹具控制通过。两OS的RFC223旧源码锁和RFC314清理hook
属于18文件范围外的三条实际失败，不能混入选定业务结果，五条summary echo也不重复计数。

RFC314的六个DB行为执行与一个native执行均通过，PG结构查询514.24ms仍在原5s预算内；
红项为afterAll清理附库：DROP实际语句60s先于两库180s外层预算。日志同一DROP等CheckpointStart，
该次快照中checkpointer处DataFileSync且无目标库活动连接；对应WAL checkpoint共189.626s（write123.209s、sync63.537s），
随后一次immediate force wait checkpoint为3.629s。附库runtime逆序await close、各DROP一次、短命DDL关闭、主runtime最后close的原顺序保留；
没有增加timeout或retry，也没有已证明能修复此托管清理失败的候选。它与旧Bun idle修复、查询预算失败分别记录。

14个core文件的一次最终backend tsc通过，前后hash不变；各切片严格lint（max-warnings0）与format通过。
211 pass /433 expect功能metadata和13 pass /55 expect canonical通过。当前1950测试文件，
605构库文件/1247调用，588无harness/439有harness；T19f692→688，同步兼容账本5→4文件、native调用10→7。
sourceDigest=`sha256:f16382c8d985c1d05b12b09dd0a6ab74f2a423237d8b244f99cbd2a692e9e611`，
canonical六数1740/272/983/5327/4794/25058。Workgroup三旧import退休、一中立type import加入，
两项分母各降2；全部25058 owner与494 ambient条目保持。五个事务身份随真实源码位置/调用形式变化，
其余267行保持；四ledger基数下降、两个原一次性growth许可依原规则到期移除，无新许可。
所有原扫描/判据与保留opaque字段及why字节不变，provenance origin保持、current为exact`2770352be`。

证据：`/private/tmp/rfc359-w32-{workgroup,rfc203,rfc291,outcome-summary,mission-order,rfc199-import,import-refs-source-lock}-manifest.json`、
对应独立复核、最终tsc和功能metadata/canonical receipts；W31的backend-hosted-evidence与cleanup-diagnosis。
本批没有本地HTTP、实际PG、daemon、TaskEngine、E2E、规模库或全门禁；没有新full性能结果。
原full360样本仍仅归exact`6f3be930c`：PG其余六端点较慢，SQLite任务首页199.069889ms未过原150ms。
AC-1/6/8/9/11/12和RFC仍开放，W20范围、原历史、数据规模、样本数与严格P95判据全部保留。

### W12 第三十一批：workflow异步事务、测试夹具登记及旧分页/retention覆盖

本批以已发布`0bfa2e7e0813ee39c11db4dede04bc39a1cd120a`为父版本，三份旧套件保留原17个声明、
75个完整matcher及全部原预算。RFC199为4DB/1pure，mission为4DB（含1HTTP），retention为6DB/2原single；
14个旧DB例默认双库，3个原single继续单跑，不能把后者全部称pure。候选累计238份完整套件完成参数化，
另4份混合套件，数量不代表全部真实PG用例通过。新增6个实际workflow owner双库控制和6个纯夹具对象控制；
本批五个HTTP例、14个旧DB例与6个新owner例的真实PG执行，仍等待包含本批的新SHA。

- `legacy/workflow.ts`的create/copy/update与`legacy/importRefs.ts`的resolve共4个原同步事务调用归零，
  使用现有中立事务，真实query terminal和guard在原位置等待；引用读取沿已有async端口逐个执行。
  两个legacy aggregate本身原已async，现在等待4处真实workflow委托结果，原整体SQLite构造边界保留。
  原RFC199五名称/25完整matcher/default预算保持，四DB例借用实际完整应用，原pure callback原字节保留。
  新owner控制最终SQLite6 pass /27 expect；两guard旧源在真实行断言指定失败，候选通过。
  最终原后10物理快照、9完整返回值及实际commit后通知保持；58条SQL/有序bindings/terminal原样，
  两copy读取复用既有async reader后，仅机械观察到一层括号及尾部`limit ?`差量，原3绑定前缀保持、尾增1。
  不修改或解释该原有reader的条件；首候选60条SQL全同仅属于尚未补齐copy异步接线的历史证据。
- `src/db/client.ts`将原WeakSet登记抽为`registerLegacyDaemonTestFixture`，原SQLite工厂继续在同一选项分支调用。
  PG fixture在原`resetToSnapshot`成功后，按同一bootstrap选项登记实际client；required分支、失败传播、
  applicationBinding对象、完整应用和消费者源保持。新6个纯控制使用实际登记API及提取的原reset/登记语句，
  同一最终测试旧源1 pass /5 fail，候选6 pass /34 expect；对象身份、pending/rejected reset及四个源码负控有效。
  这证明夹具登记合同修正，不证明十个真实HTTP失败已恢复；没有运行下游规则或本地应用。
- `rfc311-mission-page.test.ts`原4例/23完整matcher保留，四构库点归零；五个helper完整body字节相同。
  原后3个查询/旧预言SQLite例均3 pass /160 expect，64组过滤保持。三播种快照包含77 mission与3 fixture行，
  共80行/3202字段；80条播种INSERT的SQL/params/rows/values及完整快照JSON逐字一致，不能称80条分页读取。
  原HTTP业务语句、四应用选项保持；实际应用dispose后恢复原home、清理自有目录，再由harness重置DB。
- `systemMaintenanceRetention.ts`仅两参数接受中立DB，完整Bun/TypeScript emitted JS不变。
  原retention 8例/27完整matcher/15种values表达式与预算保持，原后六功能例均6 pass /17 expect；构库7→1。
  57实际SQL观察、47快照、262重复行/4067字段/215 JSON保持；55 SQL/有序绑定及底层返回原样，
  两task INSERT显式补原SQLite实际谱系值，原25绑定前缀不变。未使用的native `changes`从2变1，
  完整物理行、lastInsertRowid、业务读取/删除与原断言保持；差量明确保留。

W30 Main`34298444484`在exact`0bfa2e7e0`终态37 success /3 failure，13后端任务12过；普通
Lint/Typecheck/Format联合job`102300029519`成功。43官方源码blob/28发布路径与13后端日志已核，
两OS各1947文件按原8/4分片恰一次。十三选定功能文件Ubuntu112次执行：32 SQLite通过、22 PG通过/10 PG失败、
48 single通过；macOS32 SQLite与44 single全部通过。升级integration的single含显式hosted PG4、SQLite源库1、
受控query2，不能一律称pure。新增非HTTP参数化例已通过；10个PG HTTP红中8个明确收到401，另2个仅记录
响应字段缺失，没有status或raw body，不能据相邻用例赋予状态。此exact运行不含W31夹具修复，真实恢复待验。

最终backend tsc exit0且15个core源码hash保持。首轮3文件/4条诊断归为三类（重复type import、copy同步类型与测试行值未收窄）
及修正前字节/日志保留；copy是实际async接线补齐，按该内容变化比例复验，不能声称所有修正仅改类型。
20份功能metadata为211 pass /433 expect，canonical功能子集13 pass /55 expect。当前1949测试文件、
609构库文件/1253调用、592无harness/434有harness；T19f694→692、同步兼容账本7文件→5文件。
原生sourceDigest=`sha256:4990702d009fff879e3880807ec8f04419a1e724aeb9467d1d42020f475fd793`，
canonical六数1740/272/983/5329/4796/25058；原25057 owner整行保留，仅增加同一fixture helper身份，
ambient493→494仅对应原SQLite工厂对该helper的实际调用。两项有限growth均指向真实身份，原扫描器/规则不变，
provenance origin保持、current=`0bfa2e7e0`。

证据：`/private/tmp/rfc359-w31-{mission-page,retention,provider-fixture}-manifest.json`、`rfc359-w31-workflow-manifest.json`与独立复核、
`rfc359-w30-backend-hosted-evidence.json`和`rfc359-w30-http-functional-diagnosis.json`。未运行本地HTTP/PG/daemon/
TaskEngine/E2E/规模库/全门禁。本批未改变读页查询算法，也没有新full性能结果；原360样本仍仅归exact`6f3be930c`，
PG其余六端点较慢、SQLite任务首页199.069889ms未过原150ms。AC-1/6/8/9/11/12和RFC保持开放，
原W20范围、全部历史记录、数据规模、样本数与严格P95判据保持。

### W12 第三十批：旧行为双库覆盖、终态端口类型及托管lint修正

本批源于已发布`ff67b9eebec3f77c4ce44f881df3b919f92a09c3`，完成四份旧套件的15个真实数据库例参数化。
四文件原23个声明及131个完整matcher保持：分页10/46、子模块1/7、协作5/43、运行归属7/35；
15个DB例默认两引擎，另外8个原pure/native例单次执行。分页两条SQLite EXPLAIN与协作dbTxSync
继续直接验证原机制。候选累计236份完整旧套件已参数化；W28一份与W30两份混合套件单列，
参数化数量不代表全部托管例通过。当前1947文件、611构库文件/1266调用、595无harness/430有harness，
T19f从696降到694，provider命名仍60；原判据、完整回调、180组分页组合与预算保持。

- `rfc311-repos-page.test.ts`的8个业务/HTTP例使用实际shared store及W29完整应用；两个原native例保留。
  原/后小型SQLite均4 pass / 553 expect。完整10 callback/46 matcher与播种逆变换已核；原四task行
  共280字段逐字相同。独立复核发现首版仍依赖SQLite触发器，补入原实测谱系值后再次4/553；
  原workflowVersion/rootTaskId继续NULL。六HTTP例未在本地执行。
- `cached-repos-http-submodule.test.ts`原1例/7 matcher及两个10/7字段种子保持，请求函数原字节不变。
  两次插入只补await；应用dispose后恢复原home并清理自有目录，再由外层harness重置DB。HTTP待托管。
- `rfc349-collaboration-runtime-mechanics.test.ts`原3DB例默认双库，pure和native各1例保持单跑。
  原/后选定4/40通过；22快照、23重复行、833字段、30 JSON逐字相同。44 terminal SQL中41原向量保持，
  三task INSERT只显式加入原触发器实际已有的两个值；原CAS负控确实使false断言收到true。构库点仍1。
- `sqliteSourceTerminationParticipant.ts`、`services/task.ts`、`systemWorkspaceGc.ts`仅七处参数类型
  及必要type import变化；三完整Bun/TypeScript emitted JS逐字相等。`rfc303-runtime-ownership.test.ts`
  的3DB例默认双库、4pure原callback保持；原/后3/10通过。14快照、20重复行、576字段、7 JSON相等，
  40 SQL中39原向量保持，一task INSERT补原实测谱系值。实际写入负控由原完整行断言捕获；
  本例未执行真实workspace prune、外部I/O或PG，不扩张其证据范围。
- 官方W29 job`102286459723`的Lint步在server两处已登记ready调用报告普通Promise诊断。
  加两个显式void，原scope登记、等待及失败传播保持；单文件lint由2红到0。原装配纯控制仍8/46，
  检测器只识别这类特定void调用，原8 case/42静态matcher及全部expected hash保持。

W29 Main`34293982365`已终态：40任务中36 success / 4 failure；13后端任务12过、Ubuntu7失败，
独立真实PG任务成功。官方39源码blob与33发布路径、两个OS各1947文件恰一次已核；Ubuntu三个分片244、
五个243，macOS三个487、一个486，缺失/重复/额外均0。九选定文件Ubuntu74执行中71过/3红，
其中17 SQLite通过、14 PG通过/3 PG失败、40 single通过；macOS17 SQLite与36 single全部通过。
升级集成文件的single统计包含显式托管PG与pure例，不能把7次single都当参数化DB例。
四处原夹具的绑定、升级链/226计数及完整机制SELECT观察修正已通过；新增MCP生命周期、实际binding、
完整装配控制与协作两库例也通过。原三个workflow PG HTTP例在到达业务断言前返回401，SQLite同组三例通过；
已检查的输入身份/结构不支持字段丢失修复，根因仍未证明。原判据与失败记录保持。

本批一次backend tsc exit0且10个core源码hash保持，20份功能metadata的211例/433 expect、canonical
功能子集13例/55 expect通过。原生生成器sourceDigest为`sha256:5bcbb754fd979c65885e6074c492fe55de3796905e6f9eca2315d109b9e39063`；
canonical六数1740/272/983/5329/4796/25057保持，旧25057 owner整row原字节相同。原有身份替换与位置变化
由实际source对齐，provenance origin保持/current=`ff67b9eeb`，旧一次性growth许可移除。

证据：`/private/tmp/rfc359-w30-{repo-page,submodule,collaboration,source-termination,composition-lint}-manifest.json`、
同批独立复核及`rfc359-w29-backend-hosted-evidence.json`；原HTTP失败链另有`rfc359-w29-ubuntu7-functional-diagnosis.json`。
未运行本地HTTP/PG/daemon/E2E/规模库/全门禁。本批新SHA托管待验；原full360样本仅归exact`6f3be930c`，
六端点PG仍较慢，SQLite任务首页199.069889ms未过原150ms；本批没有查询算法变更或新full结果。
AC-1/6/8/9/11/12与RFC保持开放，原W20约束和严格P95判据保持。

### W12 第二十九批：完整应用测试装配、MCP生命周期及已发布升级夹具

- W28 exact `6f3be930c57e34ca01ebc14642e415a586344fac` Main `34288246161`
  首次终态33 success/7 failure；12个backend矩阵7过/5红，独立真PG成功。
  官方54个源blob与42发布路径相符；Ubuntu8×243、macOS4×486，各自1944文件恰一次。
  选定Ubuntu113执行为39SQLite过、38PG过/1PG红、35single过；macOS74全过。
  原索引/快照/前缀查询及旧RFC341双库目标均通过。其他job仅记录整体状态，未扩展检查范围。
- 四个功能文件的12次矩阵失败分别修复，原生产SQL和预算不变：W23历史绑定逆换遗漏
  physical-prefix第二个原值预算，补齐精确vector，原完整SQL/结果/JSON断言保持，
  本地原0过/3红→3过/325 expect，整个文件可精确逆换。cutover missing-row原本
  禁止业务readback，却把PG实际generation检查也断成空；现在对完整SELECT数组严格
  比较SQLite空/PG唯一原SQL、参数、行数和实际generationId，额外SELECT仍红。
  原九例/33matcher与预算保持，SQLite目标原后1/4，七个归档真实观察控制已核。
- PG upgrade旧测试仍把未来边写成sequence2/0002，已发布历史现在有0001和0002；
  改从真实已发布末尾接第三未来边，保留完整链、原失败整事务回滚/fresh收敛/同时间receipt
  断言，并将已发布facet索引纳入回滚观察。rolling仍用严格literal226，对应原journal。
  两文件11例/82静态matcher，79原AST保持，三项更新准确说明已发布历史；234历史文件
  字节不变。原literal与原fixture真实replay红、候选三边与错sequence/previous负控已核；
  仅tinySQLite及纯计数2/4本地运行，整条PG升级执行待托管。
- 原full `34288325222` / job `102268948298` / artifact `10081282518` 为failure。
  ZIP190924字节/12成员，13官方源、六份五表receipt、360raw及18个floor向量独立复算；
  原500repo/100ktask/3Mrun/10Mevent/100kdelivery、1warmup+20轮×9×2保持。
  P95为各20样本max，原逐端点PG≤SQLite与绝对预算未改，单位ms：

| 场景              | SQLite P95 | PostgreSQL P95 |
| ----------------- | ---------: | -------------: |
| tasks-first       | 199.069889 |      83.832988 |
| tasks-second      |  89.070534 |      56.640931 |
| tasks-running     | 112.710047 |      50.267344 |
| repos-first       |   3.915540 |       7.818441 |
| repos-referenced  |   4.171496 |      11.277337 |
| reviews-pending   |   5.766146 |       7.261289 |
| clarify-pending   |   1.541631 |       3.394773 |
| workgroup-pending |   5.017152 |       7.154442 |
| overview          |   4.339835 |       9.233671 |

三任务页PG本轮均达标且更快，六其他端点仍更慢；唯一绝对失败是SQLite任务首页。
九稳定wire相同，八项末次body摘要相同，overview不同但未上传raw body，原因不推断。
后置profile两侧完整且原corpus不变，SQLite96语句/69计划、PG125/79；148计划与真实
SQL/参数hash相符。这些是后置诊断，不把相邻run变化或计划wall单独当HTTP因果。

- 生产原完整PostgreSQL/SQLite装配体共享给旧daemon/sync入口与新测试fixture；封闭phase
  在原位置选择daemon恢复/播种，旧162步PG图和187/303顶层源经批准seam逆换保持。
  两个unstarted薄包装及scope生命周期归tests/helper。初版放production被真实
  adapter-consumer守卫判红，现已修正归属，没有增加豁免或伪造生产消费者。
  完整event-center初始化与digital-employee ready被等待，保持真实有限写；非零副作用图。
  8纯例/46 expect、四指定负控已核。production净+47/+20行，不记为算法退役。
- MCP每例new真实实例绕开原按db缓存，旧getter/constructor/stop/shutdown等42个原方法
  保持。dispose在未启动时不调用start/recovery/SQL/timer；已启动或启动中等待原Promise
  并走原drain预算，重复关闭与错误保真。首次boot同步回调的重入窗口由先公布Promise
  收口，晚到enqueue被关闭状态拦住。14纯例/109 expect，旧实现四控制4/31，三实际
  代码负控各指定红；生产净+51行。没有启动真实MCP/worker/DB作为这组本地证据。
- harness只增加真实binding读取；SQLite原db/session/record/DDL/cleanup和PG原六项
  配置、同一次recorded runtime/client构造均完整AST逆换一致。新机制例两个真实SQLite
  库1/12通过，PG直接pool录制断言等待托管。helper关闭app后再恢复原config字节并清cache；
  内层cleanup早于外层harness还原。真实migration模块使用明确fail-on-use admission，
  本fixture不计迁移功能覆盖。RFC199仍保留原件：旧同步writer与现有owner默认值不同，
  不能通过替换seed/更新接口声称等价迁移。
- RFC311三个原HTTP例使用上述完整应用，RFC341协作事件两个原DB例默认双库、两个纯例
  单跑；原名称、完整callback/matcher、seed与预算保持。协作原后4/21，八快照/十一重复
  行/245字段/8JSON相同；92语句观察91SQL原字节相同，唯一seed显式补旧trigger两槽。
  79绑定vector原字节相同，12真实随机ID/派生摘要按一致映射及重算核对；移除原INSERT
  故障后实际三表各提交1行，原reject断言指定红。三个HTTP例未本地运行，等待新SHA。
- 全量census1947/613构库文件/1271调用/599无harness/426有harness；T19f698→696只
  删除两条已清偿路径，旧scanner/负例/豁免不变。canonical1740/272/983/5329/4796/25057，
  新增五个真实共享装配身份，所有原owner行保持；provider命名60及登记9对保持。
- 首轮metadata210过/1红来自测试专用入口归属，修后211/433；canonical13/55通过。
  统一backend tsc仅在两个新测试的expect泛型及AST visitNode可空类型报错，类型修正
  的完整emitted JS相同，随后检查通过，15候选hash保持。定向lint/format和独立复核完成。
  W27实际Main Format步骤成功：三生成文档的直接Prettier差异不在该脚本范围，本批不改
  生成器/ignore/CI。无本地服务/PG/HTTP/E2E/规模性能/完整门禁；原W20限制保留，新SHA
  的完整Main/真PG仍待托管，AC1/6/8/9/11/12及RFC保持开放。

## 1. W1 —— 修 P0（让 PostgreSQL 可用）

| 任务   | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 证据                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| T1 ✅  | **P0-7** 延迟提问自动派发：PG 无实现。**已按做法①落地（2026-09-05）**：派发管线 `legacySqliteTaskQuestionDispatch.ts` 改跑 `DatabaseSession`（事务体开头 `lockAggregateRoot(tasks)`），事务体里的六类参与者各合成一份中立实现（committed-event append / node_runs 铸造 / human-gate 跃迁 / continuation 准入 / 决定接受 / gate 操作日志），`createTaskDagCollaborationOperations` 两 provider 共用，PG daemon 的 `DeferredTaskQuestionDispatcherBinding` 删除。`rfc359-t1-deferred-question-dispatch.test.ts` + 三个原子测试在两个引擎上各绿                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 真机实证，`node_runs` 0 行 → 两引擎各铸出 cross-clarify-answer rerun                       |
| T2     | **F-H2-1** 评审决定 / 反问下发 / 快速澄清三条命令端口：PG 无实现，路由必 500。**T2a ✅（2026-09-05）反问下发**：`questionDispatchCommand.ts` 一份实现（派发管线已跑在 DatabaseSession 上），PG daemon 注入 `questionDispatches`，`rfc359-t2-question-dispatch-command.test.ts` 两引擎各绿。**T2b ✅（2026-09-05）快速澄清**：`legacySqliteClarify/seal.ts` 的事务体迁到 DatabaseSession（开头 `lockAggregateRoot(tasks)`；`reconcileRoundEntriesTx` / `setNodeClarifyDirectiveTx` 随之中立），`legacySqliteClarifyDecision.ts` 参与者改用 journal / `acceptHumanGateDecisionTx` / 中立事件 append，`clarifyDecisionCommand.ts` 一份实现替代 `legacySqliteClarifyDecisionComposition.ts`，PG daemon 注入 `clarifyDecisions`；自澄清回滚的 effect 观察者（`legacySqliteNodeRollback.ts`）按客户端品牌挑两份真实现之一（fenced-dispatch 入 rfc349 fork 账本，两份 effect persistence 的合一归 W4）。`rfc359-t2b-clarify-decision.test.ts` 五个场景两引擎各绿。**T2c ✅（2026-09-05）评审决定**：`legacySqliteReview.ts` 的决定 / 评论增改删 / 文档选择五个事务体迁到 DatabaseSession（决定事务开头 `lockAggregateRoot(tasks)`；批量评论去重、归档、outputs upsert、上游作废 + 重跑铸造、兄弟级联全在同一事务）；同批合成四份中立原子并退役 PG 副本——`nodeRunLifecycleTransition.ts`（`setNodeRunStatusTx` / `transitionNodeRunStatusTx`，PG participant 的 `set` 委托过去）、`taskAuthorization.ts`（替代 `postgresqlTaskAuthorization.ts`）、`committedReviewArtifactReader.ts`（替代两份 reader）、`reviewMutationScope.ts`（替代 `sqliteReviewMutationScope.ts`；SQLite 独有的同步 `findTaskIdSync` 入队捷径退役，「先发出者先入队」改由 coordinator 等待在途作用域解析来保证，两引擎同一规则，`rfc326-review-decision-transaction` / `review-cancel-concurrency` 的线性化锁仍绿）；`reviewDecisionCommand.ts` 一份实现替代 `legacySqliteReviewDecisionComposition.ts`，PG daemon 注入 `reviewDecisions`。`rfc359-t2c-review-decision.test.ts` 六个场景两引擎各绿。**F-H2-1 三条命令端口至此全部合一。** 留债：`dispatchReviewNodeUnlocked`（评审门开启，12 处同步站点）与 `listReviewSummaries` 等读面仍绑 DbClient，归 W4 collaboration 收口 | `commandContext.ts:161-186`                                                                |
| T3 ✅  | **F-H2-2** development mission 的 `agentLauncher` / `scriptLauncher` 未注入 + 终态观察者零调用。**已修（2026-09-05）**：agent / script 动作执行器合一为 `composition/actionExecutionRunners.ts`（工作区 / baseline / 挂载校验 → agent 或 exact 脚本引用校验 → 宿主快照合成 → `launchHostTask` → 终态观察 / `fetchOutcome` / `cancel`），provider 只在 `actionExecutionEnvironment.ts` 提供两件私有能力：SQLite = `startTask`（`preCreatedWorktree` borrowed）/ `cancelTask`，PG = 根启动内核（`internal.workspace = borrowedPostgresqlWorkspace`，该租约从数字员工执行搬来共用）/ 取消命令；`agentActionExecution.ts` / `scriptActionExecution.ts` 退成薄 composer（`compose*` / `composePostgresql*`），agent 查询由 bootstrap 注入（模块不再 import resource-catalog 内部）；PG daemon 接上两个 launcher 与 `createPostgresqlDevelopmentMissionExecutionTerminalObserver`（ref-box 形态与 `cli/start.ts` 同）。`rfc359-t3-action-execution-runners.test.ts`：执行器在两个引擎上各跑（四条配置失败 / 正向启动 + 终态观察 + fetchOutcome / 启动抛错 / cancel 三态；script 四条配置失败 / 正向）+ PG daemon 接线与薄壳源码锁；RFC-310 PR-4 真子进程用例照旧绿                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `agentActionOrchestrator.ts:274-279`（修前锚点）                                           |
| T4 ✅  | **P0-3/P0-4** boot 恢复四步在 PG 不可达；`servePostgresqlDaemon` 永不返回。**已修（2026-09-05，四步部分）**：四步合一为 `composition/bootRecovery.ts`（`runTaskExecutionBootRecovery`：prepare 撤销旧 owner → `reapOrphanRuns` → `repairRuntimeSessionLeasesAfterOrphanReap` → finalize 清算并释放；锁证明由 `createDaemonLockProof` 铸造，RFC-328 允许表随之改锚），`cli/start.ts` 与 `postgresqlDaemonApplication.ts`（HTTP 前、delete 认领续做前）都调它；新增中立 `createRuntimeSessionLeaseOperations(db)`。**P0-4 根因**：PG `assertPostgresqlTaskOwnerlessTx` 把 `!== 'released'` 一律拒绝，`prepare` 撤销（`revoked`）之后的收割 / 周期修复全部 409——改为只拒活着的 `claimed`（`released` / `revoked` / `recovery-required` 都没有能再写库的 worker；SQLite 侧这几条路不读 owner 行）。`rfc359-w3-t4-boot-recovery.test.ts` 三个场景两引擎各绿 + 两入口顺序锁（rfc223-pr5 锁改锚）。**未完**：`servePostgresqlDaemon` 永不返回形态（T14）与其余 boot 步骤（T15）仍在 W3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `cli/start.ts:1160-1162,1570,2007-2037`（修前锚点）                                        |
| T5 ✅  | **P0-5** clarify 全量封存在 PG 上 409 并回滚整笔答案。**已随 T2b 合一（2026-09-05 确认）**：seal 是一份 `DatabaseSession` 实现，node_run 的 `awaiting_human → done` 是带 CAS 的条件 UPDATE（命中 0 行即安全 no-op），PG 不再经 `set({ allowedFrom })` 抛 409；`rfc359-t2b-clarify-decision.test.ts` 新增「澄清 node_run 已 failed 时整轮 seal 仍成功、答案落库、round 翻 answered」两引擎各绿                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `postgresqlNodeRunLifecyclePersistence.ts:154-160`（修前锚点）                             |
| T6 ✅  | **P0-6** 定义损坏的工作流在 PG 上永久删不掉、列表整体 422。**已修（2026-09-05，删除半边）**：PG 仓库 `delete` 不再解析 definition——只用原始行的 ACL 身份（`aclIdentity(row)`）与版本，版本冲突时 revision 算得出就带上、算不出只报 409（`staleRow`）；`assertDeleteInTransaction` 改收 `WorkflowAclIdentity`，并补齐 SQLite 一直有而 PG 从未有的两道删除守卫（非终态任务引用 → `workflow-in-use`、定时任务启动目标 → `workflow-scheduled-referenced`，错误码 / 详情同形）；SQLite `deleteWorkflow` 的 stale 分支同样改为坏定义只报 409。`rfc359-t6-corrupt-workflow-delete.test.ts` 四个场景两引擎各绿（夹具 `tests/helpers/workflowCatalog.ts` 按品牌装配目录）。**未动**：列表 / 详情对坏行 422 两侧一致，是否改成跳过坏行属产品行为变更，不在 parity 范围                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `postgresqlWorkflowRepository.ts:258`（修前锚点）                                          |
| T7 ✅  | **P0-1/P0-2** 两道 owner 围栏：适配器不读环境上下文 / effect 账本私有 fence 加等值判定。**已修（2026-09-05）**：PG 八处围栏（`postgresqlNodeExecutionPersistence` / `postgresqlNodeRunLifecyclePersistence` / `postgresqlWrapperRunPersistence` / `postgresqlMergeStateLifecyclePersistence` / `postgresqlTaskEngineApplicationPersistence` / `postgresqlTaskRuntimeLifecyclePersistence` / `postgresqlCollaborationRuntimeMechanics` 两处）改为 `input.executionContext ?? currentTaskExecutionContext(taskId)`（与 `sqliteOwnedTaskMutation` / `taskLifecycle.ts` 同规则）；`postgresqlTaskExecutionEffectPersistence.assertOwner` 去掉 revision / leaseUntil 等值与租约过期判定，与公共 `assertPostgresqlTaskOwnerTx` / SQLite `withOwnedTaskTx` 同（身份 + epoch + claimed）。`rfc359-t7-owner-fences.test.ts`：环境上下文内不传 executionContext 的 transition / upsertOutputs / patch 放行、显式上下文优先、心跳后旧 token 开 effect 并结算——两引擎各绿 + 源码锁                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 真库复现 + `postgresqlTaskLifecycleTransaction.ts:153-157` 的反证注释                      |
| T7b ✅ | **P0-10** 驱动释放不清算 effect ⇒ owner 永久卡 `claimed`、重启也救不回。**已修（2026-09-05）**：静默清算合一为 `infrastructure/effectQuiescence.ts`——managed-process 证据判定（spawn receipt ↔ node_run 的 pid / launchNonce / binary）、outcome-unknown 闭合（attempt / fence / watermark / replay-decision / 意图终结 / owner 释放）、exact-stop 与 successor-daemon 两种权威只差 `resolveQuiescenceAuthority` 一处判定；事务按 §5 READ COMMITTED + owner 行 `lockAggregateRoot`。释放序列合一为 `infrastructure/taskDriverRelease.ts`，`taskDriverLifecycle.ts` / `postgresqlTaskDriverLifecycle.ts` 只装配依赖（registry / persistence / 停心跳 / finalizeWorkspace）。中立端口 `TaskExecutionEffectPersistence` 补齐 `unresolvedEffectIds` / `unreapedProcessCode` / `resolveQuiescedManagedProcesses` / `closeOutcomeUnknownAndRelease`，两个适配器都只委托；PG successor 恢复（`postgresqlTaskExecutionRecovery.ts`）改调同一份，本地 `resolveManagedProcesses` / `closeOutcomeUnknown` 删除；新增按客户端品牌分派的 `createTaskExecutionPersistence(db)`（fenced dispatch，账本登记）。`rfc359-t7b-driver-release-settles-effects.test.ts` 七个场景（applied / 未激活 / 证据不足闭合 / child-unkillable / 过期 driver 不碰库 / successor 权威 / exact-stop 证明围栏）两引擎各绿 + 源码锁。**留债**：SQLite 同步 store（`sqliteTaskExecutionEffect.ts`）里的 `resolveQuiescedManagedProcesses` / `closeOutcomeUnknownAndRelease` / `closeRecoveredOutcomeUnknownAndRelease` 同步孪生仍被 `sqliteTaskExecutionRecovery.ts` 调用，W4 pair-deletion 时删；code-host 探针解析（`resolveCodeHostMutations` PG 私有 vs SQLite 同步版）尚未合一，同归 W4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `postgresqlTaskDriverLifecycle.ts:106-157` vs `taskDriverLifecycle.ts:127-212`（修前锚点） |
| T7d ✅ | **P0-11** 技能启动屏障从不装配 ⇒ 崩溃后该技能永久保存不了 / 同名永远建不了；损坏快照照常注入任务。**已修（2026-09-05）**：PG daemon 在 `applyPendingRestore()` 之后装配 `composePostgresqlSkillCatalogBoot`——fail-closed `runIdentityMigrationBarrier()` → `activateAvailabilityGate()`，HTTP 前 `reconcileLiveFiles()`（best-effort），HTTP 后后台 `backfillLegacyVersions()` + `reverifySnapshots()`，与 `cli/start.ts` 同序；`rfc359-t7d-postgresql-skill-catalog-boot.test.ts` 给 PG daemon 与 rfc223-pr5 同款顺序锁，并在两引擎上各跑一遍屏障/闸/对齐/回填/reverify。两份 boot adapter（`sqlite/postgresqlSkillCatalogBoot.ts`，各 1.4k 行）的合一归 W4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `composePostgresqlSkillCatalogBoot` 零调用方                                               |
| T7e ✅ | **P0-12** 工作组反问在 PG 上等于不存在（`protocolBlock` 是 stub，agent 永不发起反问）。**已修（2026-09-05）**：协议块渲染器 `renderWgProtocolBlock` / `wgHostRolePorts`（纯函数）从 legacy/context.ts 迁到 `application/workgroups/workgroupProtocol.ts`，两 provider 共用（legacy 再导出）；「能否反问」按 RFC-207 §3.7.2 只判一次——collaboration 的 `workgroupClarifyAskGate.ts`（预算 / 已问次数 / per-asker stop，公共 participant `createWorkgroupClarifyAskGate` / `countWorkgroupClarifyAsks`），legacy `resolveWgClarifyAllowed` / `countWgClarifyAsks` 只转发；中立驱动的 `WorkgroupTurnsPersistencePort` 新增 `clarifyAllowed`，PG 适配器接 collaboration 的 gate，`clarifyEnabled` 与协议块共用同一个答案；顺带修正驱动里 fc 指派回合的端口错配（stub 对 agent 说 `wg_task_results`，解析却要 `wg_result`；批任务回合现在按 `batchCount` 走 `wg_task_results`）。`rfc359-t7e-workgroup-clarify-ask-gate.test.ts` 两引擎各绿                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `workgroupTurnsDriver.ts:432-439,551-562`                                                  |
| T7c ✅ | **任务删除认领无恢复方**：`recoverInterruptedTaskDeletes` 形参是 `LegacySqliteTaskDatabase`，修好启动序列也接不上。**已修（2026-09-05）**：`infrastructure/taskDeleteRecovery.ts` 按 `ProviderNeutralDatabase` + `TerminalMaintenanceStore` 端口重写一份（级联树 parent_task_id BFS 取代 SQLite 递归 CTE；事务开头 `lockAggregateRoot(taskExecutionMaintenanceClaims)`），认领的事务内 `assertClaimTx` / `transitionTx` 合一为 `infrastructure/terminalMaintenanceClaim.ts`；清理计划解析 / 磁盘清理搬入同文件，`services/taskDelete.ts` 只再导出（`deleteTask` 本身仍是 SQLite legacy 路径）；PG daemon 在 `activateAvailabilityGate()` 之后、HTTP 之前调用。`rfc359-t7c-task-delete-recovery.test.ts` 六个场景（io-complete 续做整树 / claimed / recovery-required 行已删 / 计划损坏 / 树变化 ConflictError / 清理挂起）两引擎各绿 + PG daemon 顺序锁。**留债**：SQLite 同步 store 的 `assertClaimTx` / `transitionTx` 仍被 `deleteTask` / archive 路径调用，W4 pair-deletion 时删                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 正常并发的 `ConflictError` 分支即可达                                                      |

**每条都要**：先写一条能稳定复现的红用例（PG 侧），再修，修完再跑一次原变异确认转红。

**W1 的实际形状比「接线」重**：T1（clarify 自动派发）、T2（三条决定命令）、T7b（effect 清算）、
T7c（删除恢复）四条**在 PG 侧根本没有实现**，或**中立端口本身没声明该能力**——不是「写好了没人调」，
是要连端口带实现一起补。规模评估须按这个口径重做，不能按 W3 的接线量类比。

**T7 的次序说明**：P0-1 当前被 P0-7 遮蔽（任务活不到 `runNode`）。T1 落地后 P0-1 是否立刻接棒
**必须实测确认**，不能假定。

## 2. W2 —— 统一事务原语

- **T8** `platform/persistence/transaction.ts`：`DatabaseSession.transaction()`，两个 provider 各一实现
  （design §3.2 / §3.3）。
- **T9** `platform/persistence/writerLease.ts`：SQLite 进程内单写者异步租约 + 重入检出
  （`AsyncLocalStorage`）。
- **T10 ✅** 原子性对拍用例：proposal §3 的三组实测固化，两个 provider 各跑一遍（**AC-3**）——`rfc359-database-transaction.test.ts`（SQLite 前提 + 原语）与 `rfc359-each-provider-harness.test.ts`（双引擎回滚 / 提交）。
- **T11（修订）** ~~`dbTxSync` 改为兼容层~~ **做不到**（同步返回 `T`，转调异步必改签名）。改为：
  逐 context 迁移调用点，与 W4 各批同批；`dbTxSync` 调用点归零时删除。过渡期共存危险形态已由
  `db/transactionScope.ts` 堵死（`88b9a5940`）。
- **T11b ✅** `platform/persistence/capabilities.ts`：`EngineCapabilities` 接口 + 两个 provider 实现
  （design §5）。把散落的既有资产收进来：`postgresqlNullOrdering.ts`、三条 parity 守卫的判据、
  `postgresqlSerializationRetry.ts` 的 `errno` 判据、RFC-357 的 `numeric*` 归一、标量函数 shim 清单。
  每项双引擎实测断言。
- **T11c ✅** PG 会话默认 READ COMMITTED，`serializable(…)` 作 opt-in；`lockAggregateRoot` / `claimRows` /
  `advisoryLock` 三个并发原语落地并双引擎实测。
- **T11d ✅（2026-09-05，CI 实撞 `6efee254f` 后补）** 旁观者隔离：SQLite 统一事务在新的事件循环任务里开始
  （`setImmediate`），过渡期的同步写者不再可能与事务体的微任务链交错；旁观者语句守卫从 `dbTxSync` 扩到全部语句
  （`guardForeignStatements`），事务体跨宏任务时记带调用栈的 error 日志（design §3.2）。同批：runtime registry
  改两阶段停机（`release` 记结果 / `settle` 才唤醒等待者，driver 释放序列在库里 owner 行转移后再 settle）。
- **T12** 事务体软超时 + 结构化诊断；lint 规则禁止事务体内 import 进程/网络/fs（design §3.4）。
- **T13** RFC-311 基准库上实测吞吐前后对比，结果写回 proposal §6 的 **C-2**。

## 3. W3 —— 统一启动序列

- **T14 ✅（2026-09-05）** 监听器与关机序列合一为 `serveDaemon`（`cli/start.ts`），PG 分支与 SQLite 主路径
  都调它；`servePostgresqlDaemon` 删除。SQLite 此前写在监听器 `shutdown()` 里的四步（蒸馏 worker 回收 /
  after-commit 泵注销 / webhook 终态控制停机 / 任务优雅关停）改为会话的关闭参与者，与 PG 同一组 id、同一顺序
  （PG 补 `memory-distill-recover-running`）。`rfc359-w3-t14-serve-daemon.test.ts` 锁：一个 `Bun.serve`、一个
  `serveDaemon`、监听器里不得出现 provider 专属收尾、两会话关闭参与者集合相等。PG 与 SQLite 汇入同一条 boot
  序列的另一半（provider 执行分支归零）是 T16。
- **T15** 逐条接上 PG 缺的 boot 步骤（补审已列全）：boot 恢复四步、skill catalog boot 五项、
  终态工作区回收策略注册、数字员工模板播种、demo 播种、融合三步、定时任务载荷治愈、
  终态维护恢复五项。**多数 PG 适配器已写好且已接进 persistence，只是没人调。**
  - **T15-A ✅（2026-09-05）**：boot 恢复四步（T4）、skill catalog boot 五项（T7d）、终态工作区回收策略注册（P1-12
    注册半边；`postgresqlSourceTerminationParticipant.ts` 手写 UPDATE 不查策略仍待修）、孤儿凭据租约清理、融合三步、
    定时载荷治愈、数字员工模板、demo 播种、webhook 投递恢复、终态维护恢复五项之 delete（T7c）已按 `cli/start.ts`
    同序接进 `postgresqlDaemonApplication.ts`；runtime 注册表 boot 在 PG 路径由 `composePostgresqlProviderSession`
    跑过一次、不重复。`rfc359-w3-t15-boot-step-parity.test.ts` 锁两入口同组标记、同相对顺序。
  - **T15-B ✅（2026-09-05）**：归档恢复上端口 `TaskArchiveMaintenanceCommand.recover(options)`——SQLite 适配器包既有
    `recoverInterruptedArchives`，PG 适配器 = `recoverCompletedIo`（补齐 io-complete 时 tmp 带 manifest 则提升为正式目录的
    同一规则）+ `.tmp-*` 收尾；`.tmp-*` 的提升 / 丢弃 / 放回规则合一为 `infrastructure/archiveTempDirectorySweep.ts`，
    两侧共用。工作区四步走既有中立 `WorkspaceMaintenanceCommand.recover`：新增 `webhookClaims: 'all'`（boot 持单实例锁
    接管全部 webhook-terminal 认领；ticker 仍只接管过期租约）与 `healed`（`listUnstampedTerminalWorkspaces` +
    `healMissingWorkspace` 回填 RFC-165 前被删目录的幽灵工作区）。两个入口同序调用（`archive.recover` /
    `…Maintenance.recover` 进顺序锁）；SQLite boot 的四个 legacy 调用退役（函数本体仍被终态效果 /
    rfc165 / rfc300 / rfc311 黄金锁引用，W4 再删）。中立工厂 `composeWorkspaceMaintenanceCommand(db)` /
    `createTaskArchiveMaintenanceCommand(db)`（落 providerRuntime.ts，避免经 services/taskArchive 成环）。
    `rfc359-w3-t15b-terminal-maintenance-recovery.test.ts` 五个场景两引擎各绿。
- **T16 ✅（2026-09-05）** `cli/start.ts` 的 SQLite 内联装配（1700 行）抽成 `composeSqliteProviderSession`，与
  `composePostgresqlProviderSession` 同一份输入 / 输出契约（`DaemonProviderSessionComposeInput` /
  `ComposedDaemonProviderSession`）；`startCommand` 不再有 provider 执行分支——会话装配经
  `composeDaemonProviderSession` 按 `DatabaseProvider` 查表（`satisfies Record<…>` 穷举），运行时收窄走
  `platform/persistence` 的 `requireDatabaseProviderRuntime`，热切换的会话工厂中立（目标 provider 由
  `databaseProviderTraits(...).migrationRole` 判，不写字面量）。`rfc359-w3-t14-serve-daemon.test.ts` 扩成 T16 守卫
  （唯一 serveDaemon 调用点、startCommand 无 provider 字面量、查表穷举）；RFC-349 fork 账本的 `cli/start.ts`
  条目退役。文件拆分（`cli/sqliteDaemonApplication.ts`）留作纯搬家，随 W4 一起做（30 个读 start.ts 的源码锁要同批改）。
- **T16b** schema 契约补**触发器**维度：今天投影只覆盖表/列/约束/索引，9 个 SQLite 触发器一个都没到 PG。
  首个实锤（2026-09-05，T2a 真库用例）：`rfc328_tasks_lineage_after_insert` / `rfc328_node_runs_lineage_after_insert` 在 SQLite 上回填
  `execution_lineage_id` / `lineage_slot_path_json` / `continuation_slot_key`，PG 上没有——靠它们的插入在 PG 上落成 NULL，
  continuation 准入直接判 `lineage changed`。生产启动路径显式写 `executionLineageId`（`postgresqlTaskRouteLaunchOperations.ts:820`）才没炸；
  任何不走启动路径的插入（测试夹具、修复脚本、node_runs 直插）都会踩到。
  逐条判定「投影成 PG 触发器」还是「上移为应用层判据」，`node_runs.lineage_slot_path_json` 是唯一
  当前没有应用层等价物的一条。
  **T2c 实证②（2026-09-05）**：`tasks.owner_user_id → users(id)` 的 FK 只存在于 SQLite 迁移 `0020_rfc036_task_collab.sql`（`schema.ts` 无 `references`，PG 投影无此约束；双引擎夹具因此要显式插 users 行）——迁移 SQL 与 drizzle schema 的差集也要进 T16b 的对账。

## 4. W4 —— 逐 context 合一适配器

按前置对账的缺陷密度排序，**每个 context 一个 PR**：

| 批  | context                                                        | 配对数 | 已知缺陷                    |
| --- | -------------------------------------------------------------- | ------ | --------------------------- |
| B1  | task-execution                                                 | 44     | 最多（P0 ×4 + P1 ×10+）     |
| B2  | resource-catalog                                               | 29     | P0 ×1 + P1 ×10              |
| B3  | collaboration                                                  | 19     | P0 ×2 + P1 ×2               |
| B4  | memory / identity-access / intent / integration / auth         | 25     | P1 ×2                       |
| B5  | digital-employee / development-automation / code-capability    | 23     | P0 ×1 + P1 ×1               |
| B6  | platform / event-center / source-control / knowledge-evolution | 13     | **0**（本就同构，机械合一） |

每批的做法见 design §4。**B6 放最后**：它零缺陷，是最干净的收尾，也是给守卫钉棘轮的基线。

- **B1 进度（2026-09-05）**：42 对（对拍脚本按 provider 名归一后算相似度：3 对逐字相同、~10 对只差客户端类型 /
  少量方言、其余是「SQLite 薄壳套 legacy 同步实现 vs PG 整份实现」）。**批 1 ✅**：逐字相同的三对合一——
  `taskOverviewQuery.ts` / `branchTraceSnapshotReader.ts`（`DrizzleBranchTraceSnapshotReader`）/
  `taskRollbackQueries.ts`（`DrizzleTaskRollbackQueries`，SQLite 孪生此前无消费者），六个 provider 文件删除，
  `rfc359-w4-b1-identical-adapters.test.ts` 两引擎各跑 + 源码锁；RFC-349 cutover 账本对应边退役。
  **批 2a ✅**：只差客户端类型 / 同步异步形态的五对合一——`gateContinuationEffectPersistence.ts`（effect 持久化经端口注入，
  `settleGateRollback` 上 `TaskExecutionEffectPersistence` 端口）/ `nodeActivationSnapshotReader.ts` / `taskArtifactPathQueries.ts`
  / `dynamicWorkflowPersistence.ts`（两个 compose 具名工厂只做绑定）/ `frameBackfillStore.ts`（`applyRunFrames` 改走统一事务原语，
  此前 PG 用裸 `db.transaction`、SQLite 用 dbTxSync），十个 provider 文件删除；`rfc359-w4-b1-batch2a-adapters.test.ts` 两引擎各跑
  - 源码锁；RFC-349 fork 账本 `frameBackfill.ts` 条目退役。**批 2b ✅**：`taskExecutionReadModels.ts`（`createTaskExecutionReadModels`；composition 的
    `composeSqlite/PostgresqlTaskExecutionReadModels` 只是绑定别名）/ `taskLifecycleWsProjection.ts`（`createDatabaseTaskLifecycleWsProjection`
    / `Projector`，`committedEvents` 的 provider 具名导出为别名）/ `childTaskBudgetQueries.ts`（`DrizzleChildTaskBudgetQueries`），六个 provider
    文件删除；`services/execution/{childBudget,executionWatch,outcome,startupVerificationRead}` 改指中立实现，RFC-349 cutover 账本四条
    legacy → sqlite 边退役（基线 62 → 58）；`rfc359-w4-b1-batch2b-adapters.test.ts` 两引擎各跑 + 源码锁。**批 2c ✅**：先落中立的
    `infrastructure/ownedTaskExecution.ts`（`withTaskExecutionWrite` 统一写事务 + `assertTaskOwnerTx` owner CAS + `assertTaskOwnerlessTx`
    无主围栏 + `fenceTaskWrite` 「显式上下文 > 环境上下文 > 无主围栏」），再把 `wrapperRunPersistence.ts` / `nodeRunRuntimePersistence.ts`
    （freeze 两侧都过围栏，此前 PG 侧无围栏）/ `schedulerCompletionPersistence.ts` / `taskIdleTimeoutPersistence`（两个具名工厂退为别名）
    合到它上面，八个 provider 文件删除；rfc359-t7 源码锁与 rfc294Canonical worker-epoch 正则改指中立文件；
    `rfc359-w4-b1-batch2c-adapters.test.ts` 两引擎各跑 + 源码锁。剩 26 对（按对拍脚本重数：批 2b 后是 30 对，非此前记的 31）。
    **批 2d ✅**：`runtimeSessionCapturePersistence.ts` / `gateContinuationPreDrivePersistence.ts` / `mergeStateLifecyclePersistence.ts`
    （读 + CAS 写同一事务）/ `taskEngineApplicationPersistence.ts` 四对合到 `ownedTaskExecution.ts` 上，八个 provider 文件删除；
    SQLite 统一事务补回 RFC-111 PR-D 的 `BEGIN IMMEDIATE` 写锁重试（复用 `retrySqliteWrite`，只包 BEGIN）——此前只有 SQLite 的
    会话捕获适配器单独包着，合一后不能丢；rfc144 merge_state 直写清单 5 → 4、rfc341 / rfc359-t7 源码锁与 rfc294Canonical 正则改指
    中立文件；`rfc359-w4-b1-batch2d-adapters.test.ts` 两引擎各跑 + 源码锁。剩 22 对（`TaskRecoveryOperations` 0.89 是下一个，
    其余多与 B2 / B3 的对（resource snapshots / human gate）或 lifecycle 对耦合）。
    **批 2e ✅**：`taskRecoveryOperations.ts`（两份约千行合成一份）——取 SQLite 的形状，四条状态迁移由 provider 装配面注入
    （PG 侧新增 `createPostgresqlRecoveryAdministration`，与 SQLite 侧同形），`recordAutoRecoveryAttempt` 取 PG 的
    事务形态，PG 内联的租约孤儿修复抽成 `repairRuntimeSessionLeaseAfterOrphanReapTx`；s14 / s15 / terminal-status /
    rfc294Canonical 改指中立文件；`rfc359-w4-b1-batch2e-adapters.test.ts` 两引擎各跑 + 源码锁。剩 21 对。
    **批 2f ✅**：`nodeExecutionPersistence.ts`（最热的写路径：统一写事务 + 围栏，PG 聚合根行锁改由能力矩阵
    `lockAggregateRoot` 表达）/ `taskListPage/database.ts` / `taskCatalogSources.ts`（两对薄壳），六个 provider 文件删除；
    `rfc359-w4-b1-batch2f-adapters.test.ts` 两引擎各跑 + 源码锁。剩 18 对（其中 human gate / resource snapshots 与 B2 / B3
    耦合；lifecycle 内核四对〔task runtime lifecycle / node run lifecycle / intent / intent terminal〕与 shutdown /
    auto-repair / archive / route / launch / child launch / runtime participants 十对是「SQLite 薄壳套 legacy 同步内核 vs PG
    整份实现」，下一步先合 lifecycle 内核）。
    **批 2g ✅**：lifecycle 内核四对合一——`taskRuntimeLifecyclePersistence.ts` / `nodeRunLifecyclePersistence.ts`（含事务内参与者
    `createNodeRunLifecycleParticipantInTx`）/ `taskExecutionIntentPersistence.ts` / `taskExecutionIntentTerminalPersistence.ts`（含
    `terminalizeTaskExecutionIntentsInTx`；intent 两条沿用 `serializable`），八个 provider 文件删除，SQLite 同步内核
    （`platform/persistence/sqlite/taskLifecycle.ts` 等）暂留给 legacy 直接调用方。**顺带修掉合一暴露的两条缝**（批 2f 推上 main 后
    CI 全红的根因）：①io-virtual 行「born done」但输出在下一笔事务才落——统一事务在新的事件循环任务里开始后，另一条调度扫描能在两笔
    之间看见没有输出的 done 行并派发下游（`scheduler.test.ts` 多边并入同一端口丢了第二个输入）；`NodeRunMintInput.outputs` 让行与初始
    输出同一事务落库。②SQLite 统一事务的写锁重试改为**整笔重跑**（沿用 `retrySqliteWrite` 判据），此前只包 BEGIN，`runner.test.ts`
    注入在 insert 上的 BUSY 不再被兜住。`rfc287-t13` 把「准备行在 startTask 返回时已存在」的同步假设改为轮询。剩 15 对。
    **批 2h ✅**：`taskExecutionShutdownOperations.ts`（停机幸存者处置：控制面 CAS **不过围栏**——幸存者的 owner 仍是 claimed，
    与下一次启动的孤儿收割同理；`markRecoveryRequired` 取 SQLite 的精确元组 + revision CAS）；rfc294Canonical 把 2g 的三个
    lifecycle / intent 中立文件从 worker-epoch 改回 control-revision 归类；`rfc359-w4-b1-batch2h-adapters.test.ts` 两引擎各跑 + 源码锁。
    剩 14 对：human gate（B3）/ resource snapshots（B2）/ runtime participants / source termination / effect persistence /
    runtime session leases / auto-repair / execution recovery / ownership / archive / route / route launch / child launch /
    terminal maintenance——后面这十几对都是「SQLite 薄壳套 legacy 同步内核 vs PG 整份实现」，随 dbTxSync 调用点归零一起合。
- **B2 进度（2026-09-05）**：29 对。**批 a ✅**：`infrastructure/resourceCatalogTransaction.ts`（目录写事务的统一原语：
  `DatabaseSession.serializable`，目录写入有跨行不变量，沿用 PG 的 SERIALIZABLE）+ 四对只差客户端类型 / 事务原语的合一——
  `demoResourceCatalogSeed.ts` / `mcpProbeStore.ts` / `pluginGenerationGc.ts` / `agentResourceInventory.ts`（库存读取的 db 绑定并进
  既有共享文件），八个 provider 文件删除；rfc345 / rfc349 / rfc199 的「两份真实适配器」源码锁改为「一份中立实现、不含 provider
  名」；`rfc359-w4-b2a-adapters.test.ts` 两引擎各跑 + 源码锁。剩 25 对（下一批：AclRegistry + ResourceGrantRepository 的可见性
  谓词合一，随之带 ResourceCatalogOverview / CatalogQuery——后者的 `instr(lower(…))` 在 PG 上有同名 shim，可直接一份）。
  **批 b ✅**：`infrastructure/resourceVisibility.ts`（ACL 表注册 `ACL_TABLES` + 可见性阶梯 `visibleRowsCondition` + grant 谓词 +
  Promise 形态的 `createResourceGrantReadPort`）一份；`sqliteAclRegistry` / `postgresqlAclRegistry` 的表注册退为别名，
  `sqliteResourceGrantRepository` 只留 legacy 同步 `*InTx` 读法并转发中立件，`postgresqlResourceGrantRepository` 删除；
  `resourceCatalogOverview.ts` / `catalogQuery.ts`（搜索谓词统一为 `instr(lower(…))`，PG 基线有同名 shim；SQLite 侧三个无消费者的
  全量翻页便捷函数删除）合一，四个 provider 文件删除；rfc349 ACL 边界 / rfc345 合同 / rfc305 / rfc349 PG adapters 源码锁改指中立文件；
  `rfc359-w4-b2b-adapters.test.ts` 两引擎各跑（可见性阶梯四态 / grant 三法 / 概览计数 / 搜索与 after 游标）。剩 21 对。
  **批 c ✅**：`mcpRuntimeTestPersistence.ts`（约两千行，对拍归一后 0 处语义差异）/ `mcpRuntimeTestLease.ts` 合一，四个 provider 文件
  删除；SQLite 侧五个独立导出的同步租约函数没有外部消费者（服务层早已只经 `McpRuntimeTestLeaseOperations` 端口）一并删除；
  rfc349 NULL 排序守卫的 NULL-free 证明条目随 PG 文件退役（守卫只扫 PG 执行面，中立文件的同一句 ORDER BY 由 DB CHECK 保证）；
  `rfc359-w4-b2c-adapters.test.ts` 两引擎各跑。剩 19 对。
- **B3 进度（2026-09-05）**：19 对。**批 a ✅**：六对只差客户端类型 / 事务原语的适配器合一——`taskFeedbackStore.ts`
  （`DrizzleTaskFeedbackStore`）/ `reviewNodeReviewerStore.ts`（替换指派走统一事务）/ `collaborationTaskAccess.ts` /
  `reviewTaskAccess.ts`（取 SQLite 的单查询成员判定）/ `humanGateContinuationRecovery.ts` / `humanGateTerminalSweep.ts`（统一事务 +
  同一笔里追加 node-statuses committed event），十二个 provider 文件删除，`composition.ts` 留 `createSqlite… / createPostgresql…`
  具名绑定给两个 bootstrap；PG daemon 装配任务可见性端口改经 collaboration composition，`cli/postgresqlDaemonApplication.ts ->
collaboration/infrastructure/postgresqlCollaborationTaskAccess` 这条 R1 债随文件删除还清（commons-debt baseline 288→287）；
  rfc294Canonical terminal-maintenance 正则 / lifecycle-grep-guard 清单 / rfc202 源码锁改指中立文件；rfc202 T3 用例改为等清扫落定
  （终态清扫只剩一份异步实现，SQLite 侧不再在提交后钩子里同步完成）；`rfc359-w4-b3a-adapters.test.ts` 两引擎各跑 + 源码锁。
  剩 13 对（human gate open / review repair / clarify seal / collaboration runtime mechanics 等与 lifecycle 内核耦合的对，随
  dbTxSync 归零一起合）。
- **B4 进度（2026-09-05）**：25 对。**批 a ✅**：identity-access `ownerIdentityQueries.ts` / memory
  `memoryDistillReadStore.ts` + `memoryInjectionReadStore.ts` / integration `terminalWorkspaceAttribution.ts` +
  `webhookEndpointAdministration.ts` + `webhookTriggerAdministration.ts` + `webhookDispatchRuntime.ts`（执行器调用面，
  RFC-243 / RFC-257 / RFC-321 源码锁改指中立文件）七对合一，十四个 provider 文件删除；`composition/webhookDispatch.ts`
  留 `createSqlite… / createPostgresql…` 具名绑定给两个 bootstrap。双引擎用例在真 PG 上抓到一条老 PG 适配器就有的
  P1：`memoryInjectionReadStore` 用模块顶层常量捕获 `memories.*` 列，绕过 provider 投影代理，`createdAt / version /
approvedAt` 以字符串回到注入逻辑——改为查询时取列（见 `docs/dev-gotchas.md`）。`rfc359-w4-b4a-adapters.test.ts`
  两引擎各跑 + 源码锁。剩 18 对（intent 的 SQL 程序执行器 / IntentPersistence 两对是「同步程序 + 同步授权会话 vs 异步」，
  随 dbTxSync 归零一起合；其余为 integration 的 delivery / dispatch / MR 终态控制 / 定时任务持久化等）。
  **同批修守卫盲区**：`tests/architecture/postgresqlSurface.ts` 的 PG 执行面判据只认 provider 名与 PG 客户端类型，
  RFC-359 的中立句柄不在其中——每合一一对，新的中立实现就整体掉出三条 RFC-349 陷阱守卫的视野（前三批后执行面
  204 → 191）。判据纳入 `ProviderNeutralDatabase` / `DatabaseTransaction` / `databaseSessionFor(`（执行面 265），
  当场抓到并处置 9 处可空列裸排序 + 1 处裸 like（`services/task.ts` / `legacySqliteReview.ts` 改走
  `engineOf(db).ascNullsFirst / descNullsLast`，`mcpRuntimeTestPersistence.ts` 的最早空闲截止补 `isNotNull`，
  四处 gate revision 读法与 `effectQuiescence` 的机器标记匹配登记为可证明 / 有意精确）。`rfc349-dual-provider-predicate-drift`
  的过期配对登记（B2 批 b 合掉的 `CatalogQuery::catalogWhere`）曾把 main 推红一轮（dd1879ecd 热修），配对数下限与
  执行面下限改按 W4 的收敛趋势设置（配对 > 0；执行面 ≥ 100，两份变一份后收敛到约 180）。
  **批 b ✅**：integration `codeHostEventResponseDirectory.ts` / `webhookDispatchPersistence.ts` / `webhookDeliveryQueries.ts`
  （仓库路径枚举保留 loose index scan 的递归 CTE，表与列改经 drizzle 引用渲染——PG 侧带 schema 前缀，裸表名在 PG 上根本
  跑不通；计数走 drizzle `count()`）/ `mrTerminalControlPersistence.ts`（统一事务；PG 侧「先按流序列化再看 open 状态」的事务级
  advisory lock 改由引擎能力矩阵 `advisoryLock` 表达，SQLite 单写者下 no-op）四对合一，八个 provider 文件删除；rfc261 /
  rfc349 PG adapters 的源码锁改指中立文件与能力矩阵；`rfc359-w4-b4b-adapters.test.ts` 两引擎各跑（含 MR 守卫状态机、按流认领
  与开机对账）+ 源码锁。剩 14 对：intent 两对与 `scheduledTaskPersistence` / `integrationTriggerResources`（同步授权会话）随
  dbTxSync 归零一起合；`webhookDeliveryPersistence` / `verifiedWebhookDelivery{Store,Persistence}` PG 侧多出 MR 守卫与
  notExists 逻辑，需要先对账再合；其余为 identity-access / memory 的大对。
  **批 c ✅**：identity-access `oidcProviderRepository.ts`（写路径走统一原语的 `serializable`——PG SERIALIZABLE + 重试、SQLite
  独占事务；slug 撞库经能力矩阵 `classifyError` 归类再核对约束名）/ memory `memoryDistillWorkStore.ts` 两对合一，四个 provider
  文件删除；`memoryDistillSessionCapture.ts` 的两个 sink / 两个工厂合成一份。identity-access 公共面只导出
  `DrizzleOidcProviderRepository`，rfc349 cutover 账本里 public → provider 适配器的两条债随之还清；
  `rfc359-w4-b4c-adapters.test.ts` 两引擎各跑 + 源码锁。剩 12 对。
- **B6 进度（2026-09-05）**：7 对（event-center 3 / source-control 3 / knowledge-evolution 1；platform/persistence 的 provider
  命名文件按 W5-T17 允许留在原地，不计入）。**批 a ✅**：source-control `workspaceMaintenanceStore.ts` /
  `repositoryWorkspaceStore.ts` + event-center `eventResponseRuleStore.ts` / `customEventSourceStore.ts` 四对合一，八个 provider
  文件删除。仓库工作区存储把三处方言差异收进引擎能力矩阵：PG 的 `LOCK TABLE … SHARE ROW EXCLUSIVE`（仓库组图版本核对）改为
  事务级 `advisoryLock`；SQLite 聚合面板的 `INDEXED BY` 改为新增能力 `indexHint`（PG 空）；凭据擦除后的
  `secure_delete + checkpoint + VACUUM` 改为新增能力 `reclaimScrubbedStorage`（PG 交给 autovacuum）。自定义事件源发布保留
  PG 版事务末尾的 CAS。`composition/workspaceMaintenance.ts` 退成一条路径。`rfc359-w4-b6a-adapters.test.ts` 两引擎各跑 +
  源码锁。剩 3 对（`eventStore` 1377 行、`repositoryTransportCredentialRepository`、knowledge-evolution `fusionRepository`
  ——后者带跨 context 的同步事务参与者，随 dbTxSync 归零一起合）。**顺带观察到的对账缺口（未处置，记 P2）**：
  `repo_group_nodes` 上「group 挂载不得带 ref / subdir」的 CHECK 只在 SQLite 生效，PG 基线没有投影该约束（双引擎用例里
  同一条非法节点 SQLite 拒绝、PG 接受；批 c 又撞到第二处：`repository_transport_connections.endpoint_binding_digest`
  的「64 位十六进制」与 `token_hint` 定长 4 的 CHECK 同样只在 SQLite 生效）——PG schema 投影器对 SQLite CHECK 的覆盖面要单独盘一次，归 W5 守卫。
  **批 b ✅**：event-center `eventStore.ts`（1377 行的孪生对）合一，两个 provider 文件删除——以 PG 版为底（`count()`、
  `returning` 可见性判定、订阅 / 事件记录的 `onConflictDoNothing` 幂等插入两侧同形），四笔多语句写走统一事务原语，观察者到期
  扫描的 NULL 落位经能力矩阵 `ascNullsFirst` 表达；rfc349 null-ordering 与 event-delivery 用例改指中立文件。
  `rfc359-w4-b6b-adapters.test.ts` 两引擎各跑（登记 / 订阅幂等 / 观察判重 / 投递认领与结算围栏 / 观察者认领与 obsolete 结算）
  - 源码锁。剩 2 对。
    **批 c ✅**：source-control `repositoryTransportCredentialRepository.ts` 合一，两个 provider 文件删除（以 PG 版为底，四笔
    多语句写走统一事务原语，行数判定改用 `affectedRows`）；composition 留两个具名绑定；rfc349 promise-contract 源码锁改指中立
    文件。`rfc359-w4-b6c-adapters.test.ts` 两引擎各跑 + 源码锁。剩 1 对（knowledge-evolution `fusionRepository`：带 memory /
    resource-catalog 的同步事务参与者，随 dbTxSync 归零一起合）。
- **B5 进度（2026-09-05）**：23 对。**批 a ✅**：code-capability 七对（`capabilityParamRead` / `capabilityTemplatePersistence` /
  `codeWorkspaceRead` / `demoSeedPersistence` / `repoEndpointRead` / `readinessFactsRead` / `roundAttemptsRead`）+
  development-automation 两对（`cutoverStore` / `employeeWorkspacePersistence`）机械合一，十八个 provider 文件删除。差异全部收进
  既有原语：模板名字撞库经 `classifyError` 归类；节点 run 列表「未启动排最前」经 `ascNullsFirst`；演示种子多语句写走统一事务
  原语；投影列在函数内取。六个 composition 两条 bootstrap 路径装同一份，`createSqlite/PostgresqlCapabilityTemplatePersistence`
  留作装配别名（server.ts / postgresqlDaemonApplication.ts 仍按旧名取，bootstrap 收敛时删）。rfc349 cutover 账本
  `legacyResourcePackageMutationDependencies → sqliteCapabilityTemplatePersistence` 那条债随之还清（55 → 54），rfc317 表归属账本
  的两个 provider 站点并成一个（19 → 17），commons-debt R1 的同一条边改指中立文件。`rfc359-w4-b5a-adapters.test.ts` 两引擎各跑；
  两个 provider 边界锁的家族表改为单文件。剩 14 对（`DeliveryChain` 21 hunk / `TemplateUpstreamPersistence` 18 /
  `WorkItemProjectionRead` 10 / `ReviewerResolutionRead` 7 / `ReactionRoundQueries` 13 / `IntegrationTriggerParticipant` 7 /
  `UploadPlanStore` 20 / `ReconcilerReaders` 24 / `AdmissionLookup` 33 / `PlaybookSagaStore` 37 / `RuntimeStore` 59 /
  `AuthoringStore` 75 / `ConfigResourceStore` 90 / `MissionStore` 145——按 hunk 数从小到大逐批合，先对账再合）。
  **批 b ✅**：code-capability `reviewerResolutionRead`（类 `DrizzleReviewerResolutionRead`）/ `workItemProjectionRead`（`count()`
  聚合、三组投影列改为函数内取）/ `deliveryChainRead`（SQLite 版三个裸函数并进端口工厂，保留其表设计注释）/
  `templateUpstreamPersistence`（PG 版的两次 `SELECT … FOR UPDATE` 锁定读改为能力矩阵 `lockAggregateRoot`，事务走统一原语；
  SQLite 的 dbTxSync 参与者退役）+ digital-employee `reactionRoundQueries`（`descNullsLast` 经能力矩阵表达）五对合一，十个 provider
  文件删除；drift 守卫里 `DeliveryChain.ts::toRow` 的豁免随孪生对消失一并删除。`rfc359-w4-b5b-adapters.test.ts` 两引擎各跑
  - 源码锁。剩 9 对（`IntegrationTriggerParticipant` 带 dbTxSync 同步参与者，随 dbTxSync 归零一起合；其余 8 对为
    `UploadPlanStore` 20 / `ReconcilerReaders` 24 / `AdmissionLookup` 33 / `PlaybookSagaStore` 37 / `RuntimeStore` 59 /
    `AuthoringStore` 75 / `ConfigResourceStore` 90 / `MissionStore` 145）。
    **批 c ✅**：development-automation `reconcilerReaders`（六个纯读查询保留 SQLite 侧的函数名、PG 侧的 async 形状）/
    `admissionLookup`（以 PG 版为底自带查询，不再借道 SQLite 的 assignment / employee store 同步助手）/ `uploadPlanStore`
    （读回带 disposition 投影；`insertUploadPlan` 改为在调用方事务句柄上异步落库——PG mission store 的内联落库改用它；
    SQLite mission store 的 launch 事务仍是 dbTxSync 同步形状，留一份文件私有的 `insertUploadPlanSync`，随 MissionStore
    合一一起删）三对合一，六个 provider 文件删除。`rfc359-w4-b5c-adapters.test.ts` 两引擎各跑 + 源码锁。剩 6 对，全部是
    「SQLite 同步 store（dbTxSync）+ async 包装 vs PG 整份 async 实现」：`PlaybookSagaStore` / `RuntimeStore` / `AuthoringStore` /
    `ConfigResourceStore` / `MissionStore` / `IntegrationTriggerParticipant`——合一 = 该 context 的 dbTxSync 调用点归零，
    按 §W4 的「逐 context 迁移」推进，PG 版为底。
- **dbTxSync 归零路线（2026-09-05 起，W4-D 系列）**：剩下的 65 对几乎全是「SQLite 同步 store（dbTxSync）+ async 包装 vs PG
  整份 async 实现」，合一 = 该 context 的 dbTxSync 调用点归零，PG 版为底、经统一事务原语接进 SQLite 装配。同步事务参与者
  跨 context 传递（resource-catalog 的资源快照 / ACL 参与者被 integration / task-execution / intent / collaboration /
  memory / knowledge-evolution 的同步事务消费），所以按**依赖链从叶到根**推进：先把被消费的参与者换成中立的
  `DatabaseTransaction` 参与者（PG 版本就是），再把消费方 context 的事务改走 `databaseSessionFor(db).transaction`，
  最后 resource-catalog 自己的 68 处调用点收尾。每一步都是「一条链一批」，双引擎用例 + 源码锁 + 宽批次照旧。
  **D1 ✅（integration 触发器链）**：digital-employee `integrationTriggerParticipant.ts`（绑定统一事务句柄的 owner 参与者，
  同步参与者 `…ParticipantSync` 退役）/ resource-catalog `aggregateAdapters/integrationTriggerResourceSnapshots.ts`
  （以 PG 读取器为底：ACL 判定用 domain 的 `resolveAccessFrom` + grants 读，行映射用中立的 agent / workflow 映射器；
  workgroup 映射器仍在 PG 命名的仓库文件里，随 B2 合一挪名）+ `composition/integrationTrigger.ts` 单一工厂
  （`inTransaction(tx: DatabaseTransaction, pair, digitalEmployees)`；`application/participants/integrationTriggerResourceSnapshot.ts`
  的同步端口分派与 public 的 `IntegrationTriggerResourceSnapshotInTx` 类型一并退役）/ integration
  `scheduledTaskPersistence.ts`（四笔多语句写走统一事务原语，认领 CAS 用 returning 判定）+ `integrationTriggerResources.ts`
  - `composition/scheduledTasks.ts` 的 `composeScheduledTaskRuntimeFor` / `composeIntegrationTriggerResourceQueries`；
    server.ts / cli/start.ts 的 SQLite 装配改交快照工厂（不再传 `canViewResourceInTx` 同步 ACL 与同步数字员工参与者），
    九个文件删除，integration 的 dbTxSync 调用点 9 → 0（scheduledTask 相关）。`rfc359-w4-d1-adapters.test.ts` 两引擎各跑
    （写事务里加载已授权快照 / 私有资源对外人 404 / CAS 认领 / 记账与自动停用 / ACL 原子替换 / 数字员工快照与归档）+
    rfc345 / rfc349 锁改指中立文件。**下一条链**：integration 的 webhook 投递与验证（`webhookDeliveryPersistence` /
    `verifiedWebhookDelivery{Store,Persistence}`，PG 侧多出 MR 守卫与 notExists 逻辑，先对账）与 `developmentAdapterStore`。
    **D2 ✅（integration webhook 投递链）**：`webhookDeliveryPersistence.ts`（以 PG 版为底：同 uuid 重投的 attempt bump 改为
    `UPDATE … RETURNING` 一步原子；GC 两段各自「先选 id 再改 / 删」在统一事务原语里，SQLite 此前的 rowid 子查询方言退役；对账
    结论：PG 侧的 notExists 守卫（未成功的控制 effect / 活跃启动守卫）与 SQLite 的原生 SQL 语义相同）+
    `verifiedWebhookDeliveryPersistence.ts`（以 PG 版为底，MR 流序列化锁经能力矩阵 `advisoryLock` 表达，与启动预留共用
    `${endpointId}:${streamKey}` 键；SQLite 的同步 `SqliteVerifiedWebhookDeliveryStore` 与 application 的同步
    `createAcceptVerifiedWebhookDelivery` 一并退役）两对合一，四个 provider 文件删除；webhookIngress / webhookDelivery /
    webhookTerminalControl / webhookDispatch 四个 composition 两条路径装同一份。`rfc359-w4-d2-adapters.test.ts` 两引擎各跑
  - rfc303 用例改走异步端口 + rfc349 锁改指中立文件。integration 剩 `developmentAdapterStore`（SQLite 同步 store 被五个
    composition 与 application 命令同步消费；PG 侧只有只读修订面——「一好一坏」的存量，须把 application 命令改异步后合一）
    与 `scheduledTaskPersistence` 之外的对已清零。
    **D2 顺带抓到的 PG 功能缺口（已修）**：`webhook_deliveries` 的两条部分唯一索引（`idx_webhook_deliveries_dedupe` /
    `idx_webhook_deliveries_mr_fact`）此前只在 SQLite 迁移 0157 里存在、没进 drizzle 声明；PG 投影（`buildLogicalSchemaContract`
    只读 drizzle 声明）因此没有它们——同 uuid 重投与 MR 同事实重投在 PG 上不撞唯一键，去重分支永远走不到。本批把两条索引
    逐字进 `schema.ts`，PG 基线 / journal 用 `bun run db:rfc349-postgresql-schema` 重采（contract digest 变化，已部署的 PG
    目标须按 RFC-349 重做 cutover——与 RFC-354 PR-1 同规则；PG 侧尚无增量迁移，记 W5-T19h）。**这是一类系统性缺口**：凡是
    迁移 SQL 里手写而未进 drizzle 声明的索引 / CHECK / 触发器，PG 都没有（B6 记的 `repo_group_nodes` / 传输凭据 CHECK 是同一类）。
    W5-T19g 做一次「迁移后 sqlite*master vs 逻辑契约」的对账守卫，把所有此类差异要么补进声明、要么显式登记为 SQLite 专属。
    **D3 ✅（resource-catalog ACL 内核）**：目录自有 ACL 类型的读端口（`aclReadRepository.ts`：快照读在目录写事务原语里，
    owner / name 预检与七个异步读助手中立）、写端口（`resourceAclRepository.ts`：identity 行 CAS + grants 整体替换 +
    after-write 钩子同一事务，owner+name 撞库经能力矩阵 `classifyError` 归类再核约束名）与 `aclRegistry.ts`（唯一性类型集 /
    约束名一份，旧 PG 名留作别名）合一，PG 三个文件删除；`providerResourceCatalog.ts` 两条装配路径装同一份
    （`composeResourceCatalogFor`），`composition/resourceAcl.ts` 的默认路径（无 owner 侧 identity persistence、无同步
    after-write 钩子）改走中立端口，带同步参与者的调用（development_adapter / employee\*\* 的 identity persistence、mcp 装配的
    同步钩子）仍走 SQLite 同步路径，随各 owner 的 dbTxSync 归零一起退。`rfc359-w4-d3-adapters.test.ts` 两引擎各跑。
    剩余 SQLite 专属：`sqliteResourceAclRepository.ts`（identityPersistence 分支 + 同步 withMutation）、
    `sqliteAclReadRepository.ts`（`*InTx`同步读，workgroup / legacy 快照消费；memory 用的同步快照读端口已随 D4 退役）、`sqliteResourceGrantRepository.ts`（`_InTx`）——它们是「同步参与者」的最后一层，随 D 系列逐链退役。
**D4 ✅（memory 目录链）**：`memoryCatalogOperations.ts`（以 PG 版为底、逐命令按 SQLite 正典语义对账：晋升 / 编辑 / 迁移
scope 的多语句写走统一事务原语并在事务提交后才发 WS；编辑与迁移经版本 CAS；迁移在授权判定后二次读行（带 `currentVersion`
的 stale 详情）并刷新 actor 再判一次，`changedFields`逐字段；scope 的资源访问由 resource-catalog 的中立 participant 在
同一事务里回答，repo / repo_group 的存在性与管理权由 source-control 的中立读取器回答；搜索经能力矩阵`likeCaseInsensitive`+`likeEscape`。**一处有意偏离**：用户搜索词里的 `%`/`\_`此前在两个 provider 上都按 LIKE 通配符
解释——「100%」会命中「100」开头的任何正文——现在按字面匹配，且不再有裸 LIKE 模式）+`skillMemoryFusionParticipant.ts`
（PG 融合 participant 转中立；`listFusedIntoSkill`一份）+`memoryDistillRuntimeResolver.ts`（一份类，旧类名留别名）+
`composition.ts` 单一路径（`composeMemoryOperationsFor`/`composeMemoryCatalogOperations`，旧 provider 名保留为装配
别名；测试用故障注入缝 `MemoryCatalogTestHooks` 只在装配时给）。resource-catalog：scope 访问 participant 的唯一 owner 工厂
进 application（`createResourceScopeAccessParticipant(reads)`），中立读取器 `aggregateAdapters/resourceScopeAuthorization.ts`，
装配 `composition/resourceScopeAuthorization.ts`；端口归 memory（`application/ports/resourceScopeAccess.ts`），resource-catalog
的 public 面不引 Actor、不点名事务句柄；同步的 `ResourceScopeAuthorizationInTx`（public brand）/
`composeResourceScopeAuthorizationBinding`/`createSqliteResourceCatalogAclSnapshotReadPort`/`ResourceCatalogAclSnapshotReadPort`
退役。source-control：`repositoryScopeExistenceReads`一份（SQLite 同步读取器退役，PG 名留别名）。platform 的 SQLite overview
读模型改经 memory 目录合同取记忆计数。legacy facade`services/memory.ts`与 SQLite 专属`sqliteMemoryCatalog.ts`（1282 行的
函数式面）退役，十四个测试文件改经 `MemoryCatalogOperations` 合同（`tests/helpers/memoryCatalog.ts`）。九个文件删除，memory
的 dbTxSync 调用点只剩 `sqliteMemoryMembershipParticipant.ts`（knowledge-evolution 同步融合提交要的，随 KE 归零一起退）。
`rfc359-w4-d4-adapters.test.ts` 两引擎各跑（目录 CRUD / 搜索大小写与字面通配 / 替代链 / 编辑 OCC / WS / 分页等价 /
可见性与管理权矩阵 / scope 迁移含测试缝下的回滚 / 融合 participant / 仓库 scope 读取器）+ rfc345 / rfc347 / rfc305 / rfc349 /
rfc353 锁改指中立文件，两个 fake-PG 单测（memory catalog / fusion）随之删除；rfc349 cutover 账本还清一条（54 → 53），
rfc294 capability 兼容债还清三条（29 → 26）。**下一条链**：knowledge-evolution 融合提交（`markFusedSync`/`unfuseAboveVersionSync`的同步消费方：KE 的`sqliteFusionRepository`与 resource-catalog legacy`skillVersion.ts`）与
`developmentAdapterStore`。
**D5 ✅（knowledge-evolution 融合链）**：`fusionRepository.ts`（以 PG 版为底：十处 dbTxSync 事务改走统一事务原语；
技能操作锁撞库经能力矩阵 `classifyError`归类成同一个`skill-operation-busy`；跨聚合的两半——memory 的成员关系、
resource-catalog 的版本提交——经 tx-bound participant 工厂注入，provenance 修复逐条各自开事务走同一个 participant）+
resource-catalog `skillVersionCommitParticipant.ts`（版本提交写入面一份：复合前置条件重验 + `skills`推进 +`skill_versions`落行，判据仍只在`domain/skillVersionCommit`）+ KE `composition/fusion.ts` 单一路径（`composeFusionPersistenceFor`/`composeFusionOperationsFor`，旧 provider 名保留为装配别名）。memory 的 SQLite 同步融合写入面（`markFusedSync`/`reassignFusedSkillSync`/`composeSqliteFusionMemoryMembership`）与 resource-catalog 的 `sqliteSkillVersionCommitSync`/`composeSqliteFusionSkillVersionCommit`退役；server.ts / cli/start.ts / system-operations 三处 SQLite 根改交中立工厂
（与 PG daemon 同一份）。四个 provider 文件删除，knowledge-evolution 的 dbTxSync 调用点 10 → 0。留下的同步残余只有
legacy 技能回滚那一条（memory`unfuseAboveVersionSync`+ resource-catalog`sqliteSkillVersionCommitParticipant.ts`的两个
同步栅栏助手，都被`legacy/skillVersion.ts`的 dbTxSync 路径消费），随 resource-catalog 技能仓库对（B2 延后项）合一一起退。`rfc359-w4-d5-adapters.test.ts` 两引擎各跑（apply 的版本 / 成员关系 / 发布 / 操作账本序列与失败回收、操作锁撞库归类、
CAS / 决策认领 / 取消认领的前置条件、provenance 修复与幂等、决策恢复三分支）；rfc353 / rfc199 / fusion-engine 锁改指
中立文件，`rfc349-fusion-provider-persistence` fake-PG 单测随之删除。**下一条链**：`developmentAdapterStore`（integration；
须先把 application 命令改异步）与 identity-access 的两对大 PG 底（`UserAccessRepository`/`OidcIdentityCrossContext`）。
**D6a ✅（foreign-owner ACL 家族第一刀：development adapter 链）**：resource-catalog 的 ACL identity persistence 端口改成
异步、绑定目录写事务句柄（`ResourceAclIdentityPersistence.loadForMutation(tx, id)`交出 identity 行、撞名判定与带 aclRevision
CAS 的写回；同步形态改名`Sync_`，只剩 digital-employee 的 employee_* owner 在用，随 D6b/c 退）；中立的 ACL 读 / 写端口
（D3）多一条 foreign-owner 分支，目录自有类型与 owner 交来的 identity 共用同一份决策与 grants 替换；
`composeForeignResourceAclFor({db, identity})` 给两个 bootstrap 同一条 foreign ACL 路径（看不见即 not-found，提交后唤醒实时
订阅）。integration：`developmentAdapterStore.ts` 一份（identity + immutable revisions，publish 走统一事务原语，撞名经能力矩阵
归类；ACL identity 面即上面的端口）、`developmentAdapterCommands.ts`改异步（owner 改名进 store，editor 改名栅栏在装配层）、`developmentAdapterConfigOperations.ts`单一路径`composeDevelopmentAdapterConfigOperationsFor({db, access, grants})`（PG 侧
279 行的内联实现退役；显式授权事实经目录的 grant 读端口）、approvalGateway / pipelineEvidence / requirementSource 三处运行器
装配各一份（旧 provider 名留别名）。PG daemon 的 development_adapter ACL 路由改走中立 foreign 路径，employee_* 仍走
`postgresqlForeignResourceAcl.ts`直到 D6b/c。三个 provider 文件删除，integration 的 dbTxSync 归零；D4 留的`postgresqlRepositoryScopeExistenceReads` 别名随本刀删除并销账。`rfc359-w4-d6a-adapters.test.ts`两引擎各跑（store 的
identity / revisions / 撞名 / purpose 不可变 / 归档门；配置装配的可见性、技术细节读面、editor 改名栅栏、publish / archive 各自
的门；foreign ACL 的 CAS、grants 替换、换 owner 撞名与旧 owner 降为 read）；rfc310 的 adapter 用例与夹具改异步，rfc323 /
rfc317 表归属锁改指中立文件。**下一刀 D6b / D6c**：development-automation`ConfigResourceStore`（employee_job_template）与
digital-employee `AuthoringStore`（employee_definition / employee_tool）接同一个异步 identity 端口，之后删
`postgresqlForeignResourceAcl.ts` 与 Sync* 形态。
**D6b ✅（development-automation 配置族）**：`configResourceStore.ts` 一份（action template / verification profile 的
identity + immutable revisions；撞 (owner, name) 经能力矩阵归类成 typed 409，publishRevision 走统一事务原语，archive 单语句
returning 判 not-found；`list`按 createdAt, id 定序），同步`ConfigResourceStore`端口形态随 bun-sqlite 专属实现一起退役、
端口只剩异步`ConfigResourcePersistence`；`developmentConfigPersistence.ts`一份（digital employee / automation policy 的
identity 与 revision：publish 先`lockAggregateRoot` 再「draft 未变」CAS，PG 上即 FOR UPDATE、SQLite 独占事务下 no-op；
错误码沿 SQLite 语义）；`assignmentStore.ts`一份（引用存在性校验与 upsert 同一写事务，scope 谓词直接下推`IS NULL`/`=`
而不是全量拉回 JS 过滤，`now` 由调用方给）；员工 publish lookup 只剩异步形态、`publishLookup.ts` 删除；`migrationAssets.ts`一份（幂等键 (owner, name) 用同一条 SQL 谓词，employee / policy 落库改走`DevelopmentConfigPersistence`）。生产里再无
`sqliteDigitalEmployeeStore.ts`消费者，它的函数面搬到`tests/helpers/digitalEmployeeStore.ts`（底层走中立持久化，publish
校验与生产同一套，`lookup` 参数可省）供 14 个 RFC-310 用例沿用。装配：`composeDevelopmentConfigOperationsFor({db, …})` 单一
入口（位置参数形态与 PG 入口名留别名），`composition.ts`/`missionOperations.ts` 两个 bootstrap 同一份 persistence。六个
provider 文件删除，development-automation 配置族 dbTxSync 归零。`rfc359-w4-d6b-adapters.test.ts`两引擎各跑（配置资源的
identity / revisions / 撞名 / archive；identity 持久化的 revise / publish CAS / archive 与 publish lookup 四类引用；assignment
的 scope 校验、引用存在性、同 scope 覆盖、§3.8 解析与删除；legacy 迁移的读—析—落库与幂等），末尾源码锁保证该族不再出现
provider 专属文件。**下一刀 D6c**：digital-employee`AuthoringStore`（employee_definition / employee_tool /
employee_job_template）接同一个异步 identity 端口，之后删 `postgresqlForeignResourceAcl.ts`与`Sync*` 形态。
**D6c ✅（digital-employee 作者面 + foreign-owner ACL 收尾）**：`authoringStore.ts` 一份（类型包 / 工具 / 岗位模版 /
员工定义 / 全局执行策略五个聚合的 identity + immutable revision；撞唯一索引经能力矩阵归类成 typed 409，多表写走统一事务
原语，缺席行按 returning 行数判 typed 404，publish / update 员工定义前先按同一谓词判 identity——revision 表带 FK，直接插会以
驱动错误而不是 404 收场；`ensureExecutionPolicy`先`lockAggregateRoot`锁单例行再读—改—写；列表在 JS 侧排序，不让 DB
collation 决定顺序；ACL 列映射在函数内构造——模块级常量会把 SQLite 形态的列句柄冻结在 PG 路径上，aclRevision 以 int8 字符串
回来、CAS 永远不等）。端口`DigitalEmployeeAuthoringPersistence`改成显式异步接口，同步`DigitalEmployeeAuthoringStore`与`asAsync*` 桥退役；employee_* 的 ACL identity 面改成与目录同形的异步端口（`loadForMutation(tx, id)`+ aclRevision CAS），`DigitalEmployeeAuthoringAdapter`把它连同持久化一起交出；Bun-dev 的类型包草稿覆盖改包异步持久化，且两个 bootstrap 同一语义
（PG 装配也认`typePackageDriftPolicy`）。装配：`composeDigitalEmployeeBootstrapReadsFor`/`createDigitalEmployeeAuthoringReads`
各一份，`readPersistedDigitalEmployeeTypePackageDescriptorJsons`改异步。两个 bootstrap 的 employee_* ACL 都改走`composeForeignResourceAclFor`（与 development_adapter 同一条路径），`platform/persistence/postgresqlForeignResourceAcl.ts`删除；resource-catalog 的`SyncResourceAclIdentity*` 端口形态、SQLite ACL 仓库里的同步 identity 分支、`services/resourceAcl.ts`
的同名再导出（连同其 R1 兼容边）一起退役，`updateResourceAcl`的`identityPersistence` 选项消失。三个 provider 文件删除，
digital-employee 作者面 dbTxSync 归零。`rfc359-w4-d6c-adapters.test.ts` 两引擎各跑（类型包幂等 / drift / 定序；工具登记—
校验回写—发布—退役；岗位模版撞名 / 404 / 发布；员工定义 create / update / 类型期望不符 404 / 撞名不留半个 revision；全局
执行策略幂等递增；foreign ACL 的读面、grants 替换、CAS、换 owner 撞名、岗位模版按类型版本分区、工具不判撞名、private 对陌生人
即 not-found），末尾源码锁保证该族不再有 provider 专属文件、目录不再有同步 identity 形态。rfc223 / rfc351 / drift 等用例改接
异步持久化与中立 foreign 路径。**下一刀**：digital-employee runtime / input-upload / writer-cutover 三对与 identity-access 的两对
大 PG 底。
**D7a ✅（digital-employee 临时上传 + writer cutover）**：`inputUploadStore.ts`一份（幂等键按 actor 分区命中即返回既有行；
delete 单语句 returning 判本人 pending 行；sweepExpired 每片一个有界批次），同步`EmployeeInputUploadStore`形态退役；`writerCutoverPersistence.ts`一份（activate / refresh 先`lockAggregateRoot` 锁 'global' 单例行再数旧 Mission、翻 mode 写回；
migrationSnapshot 改成逐语句快照读——旧 SQLite 实现刻意用 deferred 事务不抢 writer，PG 的 READ COMMITTED 事务对多条
select 也不提供更强一致性，两边语义一致，S-10 的裸事务账本随之归零）。装配：`composeDigitalEmployeeMaintenanceCommands`/`composeDigitalEmployeeWriterCutoverFor` 各一份（PG 入口名留别名给 fake-PG 用例与 provider 边界锁），server / start / PG
daemon 三处 bootstrap 同一入口。一个 provider 文件删除。`rfc359-w4-d7a-adapters.test.ts`两引擎各跑（上传的幂等 / 解析校验
/ 删除 / 有界清扫；writer 的第 0 代升第 1 代、refresh、快照投影、重复 activate 幂等），末尾源码锁。**下一刀 D7b**：
digital-employee`RuntimeStore` 对（1955 / 2003 行，15 处 dbTxSync）；之后 identity-access 的两对大 PG 底。
**D7b ✅（digital-employee 运行时案件持久化）**：`runtimeStore.ts`一份（以 PG 版为底：14 处`db.transaction`改走统一
事务原语；计量与成员替换两处读—改—写先`lockAggregateRoot`锁案件行；受影响行数经`affectedRows`；案件搜索的大小写不敏感与
通配符转义走能力矩阵 `likeEscape`/`likeCaseInsensitive`（顺带修掉用户输入里 `%`/`\_`当通配符的旧行为）；nullable 列的
ORDER BY 走能力矩阵`ascNullsFirst`，SQLite 的 NULL 最小语义在 PG 显式 nulls first）；同步 `RuntimeCaseStorePort` 不再有
实现、只作为异步合同的类型来源，`asAsyncRuntimeCasePersistence` 桥退役；两个 bootstrap 的装配同一份。两个 provider 文件
（1955 + 2003 行）删除，digital-employee 的 dbTxSync 归零。`rfc359-w4-d7b-adapters.test.ts` 两引擎各跑（createCase 的一笔
事务落案件 / 上下文 / 外部主体 / 生命周期 outbox 与上传认领冲突；计量 CAS 与成员替换；分页的 facets / 成员制 mine-shared /
终态目录状态 / 大小写不敏感搜索与通配符字面匹配 / 游标；反应轮次的投递去重与合并、建轮次 CAS、跑、重试、结算、block /
resume / upgradePolicy / terminate 级联与终态后投递直接 obsolete），末尾源码锁；rfc349 案件搜索 parity 锁改成「两个引擎都
走能力矩阵」。**下一刀 D8**：identity-access 的两对大 PG 底（`UserAccessRepository` 554 / 760 行、`OidcIdentityCrossContext`318 / 781 行）。
**D6c 补 ✅（启动期并发注册幂等，2026-09-05）**：作者面存储改成真异步后，同一拍构造的两份`DigitalEmployeeAuthoringService`（路由层 + worker）并发注册同一类型包，读—插之间有让出点，第二个 insert 撞`(type_id, revision)` 主键，daemon 在 8f89a3ee4 /
d03fc3694 的 CI 上起不来（后端全部分片 + e2e 全红）。修法：`ensureTypePackage` 改「insert … ON CONFLICT DO NOTHING + 回读比
digest」（两引擎同形，漂移仍报错）；`ensureExecutionPolicy`先`advisoryLock`再锁单例行（PG 上首次创建也串行）；service 暴露`ready()`、后台初始化的拒绝标记为已接手；`composeDigitalEmployee`收中立句柄、PG 入口成别名。`rfc359-w4-d6c-bootstrap-idempotency.test.ts`两引擎各跑（改前 5/6 红），教训进`docs/dev-gotchas.md`。
**D8 ✅（identity-access 账户 / 授权持久化 + OIDC 身份关联）**：`userAccessPersistence.ts` 一份（以 PG 版的「读集 → 同步纯决策
→ 落库」为底：`BufferedUserAccessTransaction`只认读集声明过的行、未声明读 fail closed，两个引擎都走`session.serializable`；
唯一冲突经能力矩阵新项 `uniqueViolationTarget`映射回`username-taken`/`profile-email-conflict`/`oidc-email-conflict`，两个
引擎同一条正则）；出站授权围栏一份代码：先问能力矩阵新项 `readRowSync`（SQLite 驱动同步，跨进程写者立即可见），PG 退回本
进程缓存（授权读预热、写提交后刷新）。`oidcIdentityCrossContext.ts`一份（PG 的内存暂存 + 一笔 serializable 回放；RFC-220 S13 的
选择器复核仍先于 profile 名字判定；用户名冲突不再漏成裸驱动错误）——OIDC 本就是 identity-access 的 infrastructure，直接用同一份
写模型，RFC-349 期经 TransactionScope 认领桥绕回运行时公共面的`initialUserAccess.forTransaction`/`syncOidcProfileInTransaction`/`mapOidcEmailConstraint`与`InitialUserAccessProvisioner`参与者退役（src 里唯一的外部消费者是 auth 中只有测试在用的`completeBootstrapWithAdmin`，一并删除；bootstrap 首管理员只剩 `auth.completeBootstrap` 一条路——admin 没有默认附加授权，两个 auth
persistence 直落用户 + 审计已是完整语义）。装配：`createIdentityAccessRuntime({db})`收中立句柄、PG 入口成别名且不再要`crossContextTransactions`；`composeOidcIdentityOperations`/`composeOwnerIdentityQueries`各一个中立入口，provider 名入口删除、
消费者改名。五个 provider 文件（554 + 760 + 318 + 781 + 35 行）与两个假 PG 测试删除；schema 补上`user_identities_provider_subject_unique`（SQLite 迁移早有、PG 缺）并重采 PG 基线。`rfc359-w4-d8-adapters.test.ts`两引擎各跑
（目录搜索 / 查找顺序、围栏预热与旁路写者可见性、同步决策 + CAS、未声明读 fail closed、唯一冲突映射、选择器漂移回滚、建号一笔
提交、绑定 / 解绑 / 用户不存在），能力矩阵两新项在`rfc359-engine-capabilities`两侧各有真实执行；rfc305 / rfc347 / rfc345 /
rfc349 各锁与账本改指中立文件。**下一刀 D9**：auth 的`sqliteAuthPersistence`/`postgresqlAuthPersistence` 对（含 legacy
login policy / session / pat store）。
**D9 ✅（auth 认证持久化 + PAT 调用审计）**：`auth/infrastructure/authPersistence.ts`一份（登录策略 / bootstrap 首管理员 /
会话 / PAT / 本地口令）——事务形态按统一原语与能力矩阵取最优而不是照搬 PG 版的「全 SERIALIZABLE」：读—改—写先`lockAggregateRoot`锁策略单例行 / 用户行（RFC-221 的登录 / 策略线性化点在两边都成立），登录方法发现用只读`serializable`快照，会话 / PAT 解析这条每请求热路径改成一条 join 读 + 一条带`revoked_at is null`谓词的单语句 touch
（PG 上不再每请求一笔 SERIALIZABLE，SQLite 上不再抢 writer 租约做只读解析），bootstrap 的唯一冲突经能力矩阵`uniqueViolationTarget`映射回`username-taken`/`email-taken`。`tokenCallAudit.ts` 一份（有界清扫是「子查询取一批 id +
DELETE … RETURNING」一条语句，两引擎同形）。装配：`createAuthRuntimeFor({db, onCredentialRevoked?, sourceWriteWindow?})`
收中立句柄（`provider` 字段由会话引擎给出，`allowsLegacyDaemonTestAccess` 收任意客户端句柄），`createPostgresqlAuthRuntime`
成别名，`createTokenCallAudit`/`legacyTokenCallAudit` 各一个中立入口；`createSqliteAuthRuntime`/`createSqliteTokenCallAudit`/`createPostgresqlTokenCallAudit`/`legacySqliteTokenCallAudit`与应用层从未被消费的`AuthProvider`/`AuthPersistenceBinding` 删除，main.ts / server.ts / maintenanceWorker / services 消费者改名。四个 provider
文件（495 + 574 + 79 + 96 行）与假 PG 测试删除；`rfc359-w4-d9-adapters.test.ts` 两引擎各跑（bootstrap 与策略门、唯一冲突映射、
登录方法发现、口令登录 / 会话解析 / touch 节流 / 撤销 / 清扫、PAT 解析与本地口令写入、审计归属 / 脱敏 / 逆序 / 有界清扫）。
legacy SQLite 夹具（`legacySqliteLoginPolicy`/`SessionStore`/`PatStore`/`AuthRuntime`）不是 provider 对，仍为测试夹具，
另行退役。**下一刀 D10**：development-automation 剩余的 mission / playbook / upload store 对与 resource-catalog legacy 对。
**D10 ✅（development-automation 的 Mission 持久化 + 读模型，附带列 facade 修根）**：
`development-automation/infrastructure/missionStore.ts` 一份（`createMissionPersistence(db)`：launch 幂等与上传认领 / plan
一笔事务、OCC / epoch、MR claim 唯一、wake hint 去重、deferred wake、decision digest 去重 + 快照原子落、writable action
单活、attempt ordinal、effect 幂等与状态机、feedback 台账），`missionReadModels.ts` 改成中立异步（`listMissionSummariesPage`行值 keyset +`createMissionReadModelQueries(db)`：分页 / facets / counts / 详情 / MR 投影 / effect 台账 / 决策 trace /
终态分组）；同步的 `MissionStore` 端口只保留为类型源，`createMissionCodeHostEventContinuation`/`createDevelopmentMissionExecutionTerminalObserver` 各剩一个中立入口，composition / start.ts / server.ts /
postgresqlDaemonApplication 消费者改接。`sqliteMissionStore.ts`（886 行）/ `postgresqlMissionStore.ts`/`postgresqlMissionReadModels.ts`与只跑 SQLite 的`rfc310-pr2-mission-store`删除；32 个 rfc310 / rfc311 测试文件按 codemod
改成 await；boundary / null-ordering / predicate-drift（基线 8 → 7）/ t3 runners / pr7b 各锁改指中立文件。`rfc359-w4-d10-adapters.test.ts`两引擎各跑全部存储不变量 + 读模型 + 源码锁。
**修根**：D10 双引擎用例抓到 PG 上列表页游标`createdAt` 回成字符串——表 facade 只在访问时解析到当前 provider，
而模块加载期捕获进常量的列对象（`const COLUMNS = { createdAt: table.createdAt }`，全仓 12 处）那时还是 SQLite 列，
在 PG 上解码就绕开了 pg 投影的 `bigint → number`。`db/providerSchema.ts` 把列也做成访问时解析的 facade（身份稳定、
原型 / 映射 / 所属表随当前 provider），`rfc359-provider-schema-column-facade.test.ts`故意在模块加载期捕获列，两引擎锁住
解码 / 编码 / 行值比较 / 原型。**下一刀 D11**：development-automation 的`PlaybookSagaStore`对与 upload store，
再到 resource-catalog legacy 对。
**D11 ✅（development-automation 的 Playbook saga 持久化 + 上传会话 store）**：`infrastructure/playbookSagaStore.ts` 一份（`createPlaybookSagaPersistence(db)`：step run / mission link / approval saga
的幂等认领全部落在唯一索引上——`insert … onConflictDoNothing().returning()` 两引擎同形；`updateStepRun`读—判—写
放在统一事务里、落库`where state = from` 的 CAS；`sagaDigest`三张表同一快照走`serializable`）。
`infrastructure/uploadSessionStore.ts` 一份（`createUploadSessionPersistence(db)`；**`claimUploadSessions(tx, …)`是唯一的
认领原语**：条件 UPDATE … RETURNING 的 CAS + 失败后读一行分类，launch 事务`missionStore.commitMissionLaunch` 直接调用它，
D10 里内联的那份认领循环删除；`deleteUpload` 是本人 + pending 围栏写进语句的单条 DELETE … RETURNING；`sweepExpired`
是子查询取一批 id + DELETE … RETURNING 一条语句；`createUpload`的幂等键查—插在一笔事务里，并发由 insert 冲突路径兜底，
null actor 也按`is null`幂等——旧 SQLite 版`actorUserId ?? ''`永远匹配不到匿名行）。`missionInputUploadPersistence.ts` 只剩两份建在它上面的薄适配（`createMissionInputUploadPersistence`/`createUploadMaintenancePersistence`），`composition/missionInputUploads.ts`一个`composeMissionInputUploadOperations`，
server.ts / postgresqlDaemonApplication 改接；`composePlaybookSaga` 一个别名。端口：`UploadSessionPersistence`改成
Promise 合同（同步`UploadSessionStore`删除），同步`PlaybookSagaStore`只保留为类型源。`sqlitePlaybookSagaStore.ts`（493 行）/ `postgresqlPlaybookSagaStore.ts`（411 行）/ `sqliteUploadSessionStore.ts`（144 行）与
只跑 SQLite 的 `rfc310-pr3-upload-session`删除；playbook-coordinator / pr2-admission / pr3-upload-security / pr3-journey /
rfc338 五个测试按 codemod 改 await；boundary 锁改指中立文件，predicate-drift 的两条`PlaybookSagaStore.ts::*` 豁免删除
（基线 7 → 5）。`rfc359-w4-d11-adapters.test.ts` 两引擎各跑上传会话合同①–⑥（含 null actor 幂等、sweep limit）与 saga
的认领幂等 / 状态机 CAS / link / approval / join / digest，附源码锁。**下一刀 D12**：development-automation 剩余
provider 对（retentionSweeper / repositoryFactsCollector / uploadPublicationReceipt / uploadPlacementPersistence /
requirementBundleRef / repositoryLocationRead / admissionLookup 装配对），再到 resource-catalog legacy 对。
**D12 ✅（development-automation 剩余六个 infrastructure 对 + 三组装配对）**：`uploadPlacementPersistence.ts`
（`createUploadPlacementPersistence`：record 的幂等落 `dev*upload_receipts_unique`，旧 SQLite 版「plan 下任何 receipt 都
拦」的过宽判定退役）、`uploadPublicationReceipt.ts`（`recordUploadPublicationReceipt`/`hasUploadPublicationReceipt`
中立异步，查—插一笔事务 + 冲突路径兜底）、`requirementBundleRefPersistence.ts`（`createRequirementBundleRefPersistence`，
copyLatestRequirements 在统一事务里）、`gitBaselineReader.ts`（`createRepositoryLocationRead`；`resolveActionBaseline`/`createRepositoryBaselineResolver` 收中立句柄）、`repositoryFactsCollector.ts`（`createRepositoryFactsCollector`一个）、`retentionSweeper.ts`（`sweepDevelopmentRetention` 一份：删已结算 attempt / 标 bundle 指针各是一条带子查询的语句 +
RETURNING 计数——不再先取 id 列表再按 id 删，大 Mission 上 id 列表当绑定参数会撞上限；`count()` 走 drizzle 的
Number 映射，numeric-projection 登记项随之删除）。装配层三组对收口：`composeDevelopmentAdmissionLookup`/`composeDevelopmentAutomationMaintenanceCommands`/`composeDevelopmentAutomation`/`composeDevelopmentMissionOperations`
各一份（`db: ProviderNeutralDatabase`），`composeSqlite*`/`composePostgresql*`五个孪生删除，start.ts / server.ts /
postgresqlDaemonApplication / maintenanceWorker 改接；composition.ts 与 missionOperations.ts 不再 import 任一 provider
客户端类型。pr5-seed-absorption / pr3-placement / rfc310Pr3Fixture / 两个假 PG 测试改接，boundary 锁改成「只有中立入口」。`rfc359-w4-d12-adapters.test.ts`两引擎各跑 placement 读写幂等、publication receipt 首次 / 重放 / 换 baseline、bundle 指针
latest / findManifest / 复制、仓库位置读取、保留期清扫（只删已结算、只标 active、无策略 / 未终态不动、limit）+ 源码锁。
development-automation 的 infrastructure 里 provider 对至此清零；剩`employeePlatformWorkItemPersistence`/`developmentDeliveryProvider` 两个在文件内分支的 sqlite / postgresql 工厂，以及 composition/ 下 digitalEmployeeWorkspace /
digitalEmployeePlatformWorkItems / legacyMissionDrain 三组装配对——**下一刀 D13**。
**D13 ✅（development-automation 最后三组 provider 对）**：`employeePlatformWorkItemPersistence.ts` 一份
（`createEmployeePlatformWorkItemPersistence`：审批 saga 幂等准备 = onConflictDoNothing + 同事务回读，publish 两表更新在
统一事务里）、`developmentDeliveryProvider.ts` 一份（`createDevelopmentDeliveryProvider`；无密钥嵌入的 volatile 仓库 URL
按数据库句柄身份取——此前只有 SQLite 版接了这条回退，PG 上少一条能力）、`legacyMissionDrain.ts` 一份
（`createLegacyMissionDrainPort`；注：生产装配没有消费方，只被 rfc317 跨界端口测试与表归属账本引用）。装配层
`createDevelopmentEmployeeCaseWorkspaceDetailReader`/`composeDevelopmentEmployeeWorkspace`/`composeDevelopmentEmployeePlatformWorkItems` 各一份（`db: ProviderNeutralDatabase`），六个 `\_Sqlite*`/`_Postgresql_`孪生
删除，start.ts / server.ts / postgresqlDaemonApplication / composition.ts 改接，七个测试改接，
rfc349-development-integration-composition 的「PG 装配必须命名自己的适配器」清单去掉三个 development-automation 条目。`rfc359-w4-d13-adapters.test.ts`两引擎各跑 workspace 读 / head 更新、审批 saga 幂等准备 / 提交 / 观测、candidate 幂等 /
commit / publish 原子、轮次校验取最高 attempt、仓库解析（未缓存 / volatile / SecretBox 解封）与 MR 事实目标、排空视图
计数与 truncated + 源码锁。**development-automation 至此没有任何 provider 命名的持久化或装配孪生。**
**下一刀 D14**：resource-catalog legacy 对（16 对）。
**D14 ✅（resource-catalog · Agent 聚合：一份实现，SQLite 装配切过去）**：resource-catalog 的两侧形态不对称——
SQLite 侧是`legacy/\*` 同步服务外面的薄包装（`sqliteAgentRepository.ts` 50 行），PG 侧是完整的异步重写
（`postgresqlAgentRepository.ts`231 行 +`postgresqlAgentPersistenceSemantics.ts` 420 行）。合一的办法是让异步实现成为
唯一实现：`infrastructure/agentRepository.ts`（`createAgentRepository`：写路径全在 `runResourceCatalogTransaction`的 serializable 事务里；owner + name 唯一冲突经能力矩阵`uniqueViolationTarget`映射回`agent-name-in-use`——PG 给
约束名 `agents_owner_name_unique`、SQLite 给列清单 `agents.owner_user_id, …`，一条正则两边都认）、
`agentPersistenceSemantics.ts`（`createAgentPersistenceSemantics`：引用 / runtime / 依赖环 / 删除受引用校验）、
`agentImportQueries.ts`（`createAgentImportReferenceReadPort`+`createImportReferenceReadPortInTransaction`，
`ACL_TABLES`只有一份）。装配层`composeAgentCatalog` 一份（`db: ProviderNeutralDatabase` + persistence +
resourceCatalog），`composeAgentImportQueries`/`composeDatabaseAgentResourceInventorySource`/`composeDatabaseAgentResourceIntegrity`/`composePortableImportReferences(InTransaction)`各一份；server.ts 与 start.ts
的 SQLite 装配改成与 PG daemon 同一套（persistence 语义层 + runtimeProfiles 走 runtimeRegistry）；`postgresqlClassicCatalogs.ts` 的 Agent 分支改接中立入口。SQLite 专属的同步 portable-import 终写围栏
（`createPortableImportReferenceSyncFence`/`TransactionBoundImportReferenceSyncReadPort`，无生产消费方）删除。
五个 provider 文件删除；rfc345（contracts / classic-facades / agent-import-queries）与 rfc349 classic adapters、rfc305
跨界账本改指中立文件；七个测试与 legacy/workgroup/launch.ts 改接。`rfc359-w4-d14-adapters.test.ts` 两引擎各跑创建 /
同 owner 同名冲突 / 引用与 runtime 校验 / fence 过期 / 改名冲突 / 删除受引用保护 / 引用标签 / import 快照 + 源码锁。
**留下的债**：`legacy/agent.ts`同步服务仍被 services/agent.ts 门面、task-execution、code-capability 等消费，它不是
provider 对而是「只有 SQLite 能走」的旧路径，随各消费方切到`AgentCatalogModule` 后再删。**下一刀 D15**：
resource-catalog 的 Skill / Workflow 聚合按同一办法合一（PG 异步实现成为唯一实现）。
**D15 ✅（resource-catalog · Workflow 聚合：一份实现，SQLite 装配切过去）**：`infrastructure/workflowRepository.ts`
（`createWorkflowRepository`：创建 / 复制 / update 的 already-current 与 committed / 删除只用原始行的 ACL 身份与版本，全在
统一 serializable 事务里）、`workflowPersistenceSemantics.ts`（`createWorkflowPersistenceSemantics`：定义引用可见性、
复制命名、非终态任务 / 定时任务 / 被 call 的删除守卫，事件钩子）、`workflowValidation.ts`
（`createWorkflowValidationPort` 装载两引擎同形的库存跑共享校验器；`createWorkflowReferenceAdmissionPort` 的 D15 准入）
各一份。**managed skill 可用性判据只有一份**：`skillContentAvailability.ts`（reservation ready + 本次启动已复核 + 权威
版本目录在盘上），SQLite bootstrap 与 PG 内容生命周期都用它。装配层 `composeWorkflowCatalog`一份（PG 形状）+`composeDatabaseWorkflowCatalog({db, resourceCatalog, skillContent})`（语义层与 `/ws/workflows` 广播事件在这里接，
两个 provider 同一份），server.ts / start.ts 切过去；`postgresqlClassicCatalogs.ts`的 Workflow 分支改接。五个 provider
文件删除；rfc345（contracts / classic-facades / neutralization）与 rfc349 两把 adapters 锁改指中立文件；`tests/helpers/workflowCatalog.ts` 不再按 provider 分叉。`rfc359-w4-d15-adapters.test.ts`两引擎各跑创建 / 复制命名 /
update 三态 / 删除受 call 引用保护 / 校验与准入 / skill 可用性 + 源码锁。
**合一时补齐的两处 PG 缺口**（双引擎批次抓到）：①删除广播的受众——旧 SQLite 路径在删除事务里取出可见性 / owner /
授权用户随帧旁路带给 WS 注册表，冷缓存的私有观众才能收到 delete 帧，PG 版此前漏了（rfc099-ws-acl-filter 红）；
现在`createWorkflowRepository`在事务里取受众交给`deleted` 钩子，`composeDatabaseWorkflowCatalog` 带着广播。
②RFC-264 改名门——只有改名才受统一命名规则约束、历史名字原样回存可保存，PG 版此前不校验改名（`\_reserved` 也能存）；
现在语义层一条门两引擎同用（workflows.test.ts 红）。
**留下的债**：`composeSqliteDynamicWorkflowValidationContext`（task engine 的动态工作流校验上下文）仍走 legacy 装载器，
PG daemon 从目录查询拼上下文——两边拼法不同，随「动态工作流校验上下文」单独一刀合一；`legacy/workflow.ts` 同步服务仍被
    services/workflow.ts 门面、task-execution 等消费。**下一刀 D16**：Mcp 聚合。

  **D16 ✅（resource-catalog · Mcp 聚合：一份实现，运行时测试生命周期进仓库事务）**：`infrastructure/mcpRepository.ts`
  （`createMcpRepository({db, lifecycle})`：创建 / update（OCC 按 configHash）/ 改名 / 删除只回 agent 引用，
  `mcp-name-in-use` 经能力矩阵的唯一冲突映射）、`mcpRuntimeTestTransitions.ts`（`transitionMcpRuntimeTests`：配置变更→
  空闲会话结束、忙碌会话阻塞到本回合后，停用 / 删除→立即结束；`transitionMcpAclRuntimeTests`：按账号权限 + 可见性快照判定，
  失去可见性→access-revoked、保留→阻塞；`deletePreparedMcpRuntimeTests`：未安全停止的会话让删除抛
  `mcp-test-cleanup-incomplete`）、`mcpTransactionLifecycle.ts`（把两条接进仓库事务）各一份——**ACL 变更转换此前只有
  SQLite 有**，PG 版 ACL 写入不动测试会话，合一时补齐。装配层 `composeMcpCatalog` 一份 + `mcpAclRuntimeTestLifecycle()`
  （资源目录 ACL 写入后的事务内钩子，两 provider 同一份）、`composeMcpProbeStore` / `composeMcpRuntimeTestPersistence` /
  `composeMcpRuntimeTestProvider` 各一份；server.ts / start.ts / postgresqlDaemonApplication.ts 同一套装配。三个 provider
  文件删除（`sqliteMcpRepository` / `postgresqlMcpRepository` / `postgresqlMcpTransactionLifecycle`），
  `services/mcpRuntimeTestTransitions.ts` 零生产消费门面退役；rfc345（contracts / acl-facade-retirement /
  mcp-plugin-neutral-facades）、rfc349（adapters / resource-package-bootstrap）、rfc231 写点清单、rfc294 canonical
  manifests 改指中立文件；`tests/helpers/mcpServiceBinding.ts` 不再按 provider 分叉。`rfc359-w4-d16-adapters.test.ts`
  两引擎各跑创建 / 同名冲突 / OCC / 改名撞名 / 引用保护删除 / 会话清理守卫 / 三类会话转换 + 源码锁。
  **留下的债**：`legacy/mcpRuntimeTestTransitions.ts` 同步版仍被 runtime-registry 写点与 `mcpPersistence.ts` 消费，随那些
  写点切异步后删。
  **D14 / D15 的 CI 回归（94ce5351b 红，随 D16 一并修）**：①Agent 语义层的引用缺失先走 RFC-228 结构化预检
  （`agent-resources-invalid` + issues）再走逐类围栏——合一时次序反了，`skill-not-found` 抢先（rfc223-pr1-impl-gate 红）；
  ②provider 路径的 ACL 写入提交后要唤醒实时订阅（`resource-acl-changed`）——旧 SQLite 组合在 afterCommit 里触发、
  provider 组合漏了，被升档的观众收不到刷新帧（e2e rfc324-graded-grants 红）；③RFC-310 架构清单里的
  `postgresqlAgentPersistenceSemantics` 路径改指中立文件。前两条 `rfc359-w4-d14-d15-regressions.test.ts` 两引擎各锁一遍。
  教训进 `docs/dev-gotchas.md`：provider 形状成为唯一实现时，SQLite 侧的 HTTP / e2e 锁会**第一次**照到它，每刀的本地批次
  要把该聚合的 HTTP 层与 ACL / WS 用例（rfc223 / rfc228 / rfc324 / rfc099 / rfc212 家族）一并带上。
  **下一刀 D17**：Plugin 聚合。

  **D17 ✅（resource-catalog · Plugin 聚合：一份仓库、一份目录装配、一份代际清扫装配）**：`infrastructure/pluginRepository.ts`
  （`createPluginRepository({db})`：创建 / publish（按 configHash OCC，整行 WHERE + RETURNING 判定）/ 改名 / 删除只回 agent
  引用；`plugin-name-in-use` 经能力矩阵的唯一冲突映射）一份；`composition/pluginOperations.ts` 只剩 `composePluginCatalog`
  （PG 形状：访问判定与 ACL 操作都经资源目录的 provider 中立应用）+ `composePluginCatalogFromAdapters`；
  `composition/pluginGenerationGc.ts` 只剩 `composePluginGenerationGcCommand`。server.ts / start.ts /
  postgresqlDaemonApplication.ts / maintenanceWorker.ts 同一套装配，legacy `workflow.validator.ts` 的插件库存改读中立仓库。
  两个 provider 文件删除；rfc345 contracts、rfc349（adapters / contributions / search-case-parity）、rfc284 dedup、rfc231
  写点清单改指中立文件；`tests/helpers/pluginServiceBinding.ts` / `intentResourceCatalogBinding.ts` 不再按 provider 分叉。
  `rfc359-w4-d17-adapters.test.ts` 两引擎各跑创建 / owner 级同名冲突 / assertNameAvailable / publish OCC / 改名撞名 /
  引用保护删除 + 源码锁。**下一刀 D18**：Workgroup 聚合。

  **D18 ✅（resource-catalog · Workgroup 聚合：一份仓库、一份引用可用性判定、一份目录装配）**：
  `infrastructure/workgroupRepository.ts`（`createWorkgroupRepository(db, deps)`：创建 / 复制（版本 + 快照哈希 OCC）/
  save 三态 / 删除（定时任务与非终态任务引用守卫、受众随回执）全在统一 serializable 事务里；`workgroup-name-in-use` /
  `workgroup-copy-name-conflict` 经能力矩阵的唯一冲突映射；两份 provider 文件此前逐字同形，PG 版直接成为唯一实现）、
  `infrastructure/referenceUsability.ts`（`resolveAgentIdsUsable` 预检 / `assertAgentIdsUsableInTransaction` 同事务终检 /
  `resolveAccessInTransaction` / `listGrantedUserIdsInTransaction`，缺失与不可见一律 `acl-missing-refs`）各一份；
  `composition/workgroupOperations.ts` 只剩 `composeWorkgroupCatalog` + `composeWorkgroupCatalogFromAdapters`，仓库依赖
  由 `workgroupRepositoryDependencies({db})` 一处装配（测试也从这里拿）。server.ts / start.ts / postgresqlDaemonApplication.ts
  同一套装配；四个 PG-only 聚合适配器改读中立的 `workgroupFromRows`。四个 provider 文件删除；rfc225 写点清单、rfc231、
  rfc345（contracts / classic-facade-neutralization）、rfc349 adapters 改指中立文件。`rfc359-w4-d18-adapters.test.ts`
  两引擎各跑创建 / 同名冲突 / 不可见与不存在成员 / 复制 OCC / save 三态 / 删除 OCC 与受众 + 源码锁。
  **留下的债**：Workgroup 的任务房与回合（`sqliteWorkgroupTaskRoom.ts` 71 行薄驱动 vs PG 的
  `postgresqlWorkgroupTaskRoom*` 1457 行、`sqliteWorkgroupTurnsOperations.ts` 34 行 vs `postgresqlWorkgroupTurnsOperations.ts`
  567 行）是「SQLite 走 legacy engine、PG 全量实现」的不对称对，随 legacy workgroup engine 退役单独一刀（D19）。
  **下一刀 D19**：Workgroup 任务房 / 回合合一。这一刀体量最大且行为风险最高，拆三步走：

  **勘察结论（决定拆法）**：任务房与回合是 W4 里最后、也是最不对称的一对——SQLite 侧是 legacy workgroup engine
  上的薄驱动（`sqliteWorkgroupTaskRoom.ts` 71 行 + `sqliteWorkgroupTurnsOperations.ts` 34 行），PG 侧是原生实现
  （任务房 `postgresqlWorkgroupTaskRoom*.ts` 1457 行；回合 `postgresqlWorkgroupTurnsOperations.ts` 567 行，
  决策逻辑在 provider 中立的 `application/workgroups/workgroupTurnsDriver.ts` 2819 行里）。**测试覆盖也不对称**：
  SQLite / legacy 路径有 13 个行为套件（rfc164 引擎 / rfc185 领队扇出 / rfc189 回合 / rfc215 批次 / rfc329 待办 /
  rfc311 徽标 ACL / rfc108 自动恢复…），PG 走的中立驱动只有 3 个、且多是源码形状锁——**PostgreSQL 跑的是一条
  几乎没有行为覆盖的路径**，正是本 RFC 要根除的形态。故按风险分三刀：D19a 结构（参与者对 + 围栏去重，零行为变更）、
  D19b 任务房本体（SQLite 装配切到中立实现）、D19c 回合引擎（legacy engine 的回合面退役）。

  **D19a ✅（任务房事务内参与者合一 + 无主围栏去重：零行为变更）**：
  `collaboration/infrastructure/workgroupTaskRoomClarifyParticipant.ts`（反问投影 / 关闭未决自问）与
  `task-execution/infrastructure/workgroupTaskRoomTaskParticipant.ts`（继续 / 失败任务）各一份中立实现，装配层
  `composeWorkgroupTaskRoomClarifyParticipantFactory` / `composeWorkgroupTaskRoomTaskParticipantFactory` 各一份
  （事务类型三处都收敛到 `DatabaseTransaction`）。同批发现 `assertPostgresqlTaskOwnerlessTx` 与中立的
  `assertTaskOwnerlessTx` 是**逐字重复**，删掉 PG 那份、六个消费方改指中立模块。三个 provider 文件删除；
  rfc294 preflight 的能力债清单四条并成两条、rfc349 协作运行时锁改指中立工厂。
  `rfc359-w4-d19a-adapters.test.ts` 两引擎各跑反问投影（按 asker 聚合 + 非空 shardKey 的 stop 指令）、
  未决自问的 CAS 关闭与重放幂等、无主围栏的四种 owner 状态 + 源码锁。
  **D19b ✅（任务房本体合一：一份房间给两个引擎，「恢复执行」按部署形态注入 —— 采纳方案 2）**：
  三份中立房间文件（`workgroupTaskRoom{,Commands,Queries}.ts`）+ 一份装配 `composeWorkgroupTaskRoom`，
  两个 bootstrap 装同一份；`composeWorkgroupTaskRoomActiveUsers` / `composeWorkgroupTaskRoomDynamicWorkflow`
  把此前只在 PG daemon 里内联的两段判据（在岗用户过滤、动态工作流三层复核 + 另存为）提成共用装配。
  四个 provider 文件删除。**PostgreSQL 房间路径由此第一次拿到行为覆盖。**

  **合一时抓到、并按「合一前 SQLite 行为为准」修掉的差异**（这正是本 RFC 要根除的形态——两份实现各自演进）：
  1. 「恢复执行」的两件事按**部署形态**（不是按数据库）注入 `WorkgroupTaskRoomContinuationDriver`：
     `assertResumable`（单进程查工作树 → 工作树被 GC 回收就 410，闸门 / holder / 消息随事务整体回滚、
     决策保持可重试；多进程空操作）与 `driveAfterCommit`（单进程就地认领已准入的意图并驱动，
     即 `wakeHumanGateContinuation`；多进程交给 daemon 的 `human-gate-continuation` worker）。
     两处调用次序照抄合一前：预检排在合法性复核**之后**（提案不再通过当前池校验仍是 409，工作树没了才 410）、
     写入之前；驱动排在提交与广播之后。rfc164 的 410 与 rfc167 的原子换挡 / 相位复位因此全部照旧。
  2. `continueTask` 的意图类别改回 `gate-continuation`、载荷收回 `{v,event}` 两键。这一类里还住着 RFC-333
     人工门的富载荷，驱动链会 `decodeHumanGateContinuationPayload` 解它，多一个键就当场
     `invalid-human-gate-continuation-payload`；两键形态才被 `isLegacyTaskGateContinuationPayload` 识别成
     「由准入方自己驱动」而跳过那几步。合一前的 PG 房间写的是 `kind:'resume'`——**没有任何人认领它**。
  3. 加成员时解析不到的 agent 引用错误码回归 `acl-missing-refs`（合一版一度是 `workgroup-config-agent-missing`）。
  4. 遣散最后一个人类成员后的补跑（`continueIfStillParked`：立刻一次 + 2.5s 后一次）。引擎可能带着遣散前的
     快照慢一拍才把任务提交成 `awaiting_human`，那一拍落在配置更新事务之后，任务会永远停在等一个不存在的人。

  **收尾（同批）**：legacy 那四个动作文件（`taskActions` / `dwActions` / `room` / `configActions`，1749 行）
  生产零消费者，删除；6 个测试消费者改接中立房间（三个纯派生函数的改从 `application/workgroups/workgroupRoomProjection.ts`
  导入；徽章两套走新的 `tests/helpers/workgroupTaskRoom.ts` 装配；rfc223 引用围栏的 `beforeWriteTransaction`
  接缝随「事务外预检 + 事务内复核」一起退役，留下同一条用户可见行为的断言）。
  九把按文件名点名的清单锁改指中立实现，rfc217 G5 的模式分支棘轮把中立房间纳入扫描面。
  `rfc359-w4-d19b-adapters.test.ts` 两引擎各跑房间聚合读 / 可见性 404 / 发言写入 + 广播 / 终态拒绝 + 源码锁。

  **两处守卫脆弱点同批修掉**：路由错误码守卫的语料用 `trackedFiles`，新测试在 `git add` 之前不在语料里
  ——本地绿、提交之后才红（288a8f888 把 main 推红即此）；rfc345 的 schema 导入扫描在三份源码**拼接**后
  贪婪匹配，正文里出现「tasks」这个词（哪怕只是注释）就被误判成导入了 tasks 表，改为逐文件取块。

  **D19c ✅（回合引擎合一：SQLite 切到中立驱动，并补回它缺的整套提示词）**：
  持久化适配器中立化（`workgroupTurnsOperations.ts`；`GREATEST` 收进能力矩阵新增的 `greatest`，两方言各取
  `GREATEST` / `max`）、宿主账本参与者中立化（`workgroupHostLedgerParticipant.ts`）、装配收成一份
  `composeWorkgroupTurnsOperations`，三个 bootstrap 装同一条；SQLite 的 34 行 legacy 薄壳与
  `services/workgroup/engine.ts` 门面删除，回合操作改由 bootstrap 注入。

  **关键发现**：13 个「SQLite 行为套件」全都直接调 `runWorkgroupEngine`，**一条都没经过中立驱动**——
  PostgreSQL 跑的那条路几乎没有行为覆盖。把其中 5 个套件（约 88 条断言）改接
  `tests/helpers/workgroupTurns.ts` 的 shim 后，一次照出中立驱动与正典之间 8 处差异，逐条按
  「合一前 SQLite 为准」修回（每一条都是 PG 上一直存在的用户可见退化）：
  1. **整套提示词是降级版**——没有 charter 围栏 / goal 块 / 能力卡名册 / 领队账本 / peer results ·
     mentions · 黑板三段切片 / 闸门打回反馈块。legacy 的 `prompts.ts` + `context.ts` 搬进 application 层
     （`workgroupTurnPrompts.ts` / `workgroupTurnContext.ts`，输入换成 `WorkgroupTurnsSnapshot`）。
  2. **协议重提示块**写成了另一套更短的 `## Protocol correction`（G6 单一定义点随之搬进中立驱动）。
  3. **失败重试判据**：中立驱动对任何失败都重试并贴原始 errorMessage；正典走 FOLLOWUP_POLICY 表，
     只有协议失误才重试，且给按原因裁剪的可操作指引。
  4. **瞬时运行时故障**没有单独预算（正典：换新进程整轮重跑、不吃协议预算、不贴提示）。
  5. **反问被硬压制**（RFC-181 C）没有专门分支（正典：按角色贴 `Ask-back is OFF` 重试，耗尽后领队推游标
     丢弃继续、成员卡片浮 failed，绝不 park）。
  6. **17 处系统消息**各手写正文、逐条与模板渲染器不同 → 一律改由 `buildSystemMessage` 渲染。
  7. **标题去重丢弃**没有系统告警；去重只可能在提交时定论（并发成员回合共享快照），所以提交回执带上
     被跳过的操作键，驱动据此补消息。
  8. **free_collab 机械收敛**的闸门说明恒为空（它没有领队回合能推 idle → declared）。

  另加一条：`node.status{pending}` 广播在中立驱动里变成宿主的可选能力，测试 shim 按生产形态接上。
  十把点名清单锁改指中立实现；`rfc359-w4-d19c-adapters.test.ts` 两引擎各跑「领队派单 → 成员交付 →
  领队收敛」与「协议出错重提示一次后收敛」+ 源码锁。

  **D19c-tail（待办，独立一刀）**：legacy engine 那一片（`engine` / `turnExecution` / `memberTurns` /
  `rounds` / `wake` / `prompts` / `hooks` / `messages` / `lifecycle` / `strategies/*`，约 4500 行）现在
  **生产零消费者**，只剩测试还在引。删它不是机械 sweep：8 个模块共 25 个符号被测试直接消费
  （`decideAssignmentReconcile` / `deriveWakeSet` / `deriveLeaderClarifyPark` / `resolveWgClarifyAllowed` /
  `executeTurn` / `casAssignmentStatus`…），要逐个判定「中立驱动里的对应判据是哪一个、要不要导出、
  断言怎么改写」。`state` / `launch` / `constants` / `askerKey` 四个文件仍有真实生产消费者，不在退役范围内。

  **D22 ✅（数字员工岗位模版目录合一）**：此前 SQLite 是套在 legacy Agent 写面（`legacy/agent.ts`）上的
  59 行薄壳、PostgreSQL 是 390 行原生实现。正典取 PG 那份——它本来就是**按 builtin 模版语义**写的
  （系统 owner + builtin 双条件定位、`visibility:'public'` + `builtin:true` 落库、改名与更新过
  updatedAt + aclRevision 双 OCC），而 SQLite 那条借道普通 Agent 写面、带着一整套面向用户输入的
  ACL / 闭包校验——模版定义是代码自有、由 daemon 铸造的，那套校验既不适用也拦不住什么。合一顺带把
  `legacy/agent.ts` 从这条链上摘掉。provider 差异只剩驱动错误的形状，经能力矩阵 `uniqueViolationTarget`
  映射回闭合错误合同。两个 provider 文件删除；rfc345 边界锁与 rfc347 委派臂账本改指中立实现。
  `rfc359-w4-d22-adapters.test.ts` 两引擎各跑建 builtin 的三列落值 / 重复 id 与同名冲突 / 双 OCC 围栏 /
  非系统 builtin 的行按 id 被占用拒绝。

  **D24 ✅（运行时会话租约合一：一份实现，且不改隔离级别）**：这是「乙类」里取证已完成的那一对
  （502 / 504 行，归一化相似度 0.65）。差别只有三处，逐条收掉：①事务原语——**合一没有改隔离级别**，
  中立会话本来就有 `serializable`（PG 抬到 SERIALIZABLE 并按 40001 重放，SQLite 的 `BEGIN IMMEDIATE`
  本来就是全库独占），新增的 `withTaskExecutionSerializable` 两边各取所需，于是「PG 能不能降到
  READ COMMITTED」这个待裁决问题**不必回答**；②owner 围栏——PG 的本地 `fence()` 与中立
  `fenceTaskWrite` 逐字同义，改为委派，环境上下文至此只在 `ownedTaskExecution.ts` 读一次；
  ③驱动错误形状——改走能力矩阵 `classifyError`（`claimNew` 防重复认领靠的本来就是主键
  `(protocol, session_id)` + 这条映射，不是隔离级别）。
  `sqliteRuntimeSessionLeaseOperations.ts` 删除，按品牌分派的装配收成一行转出口；三个 bootstrap 改从
  装配层取（直连 infrastructure 会新增 R1 inbound 越界边）。四把清单锁改指中立实现，其中三条是**销账**
  （fork 计数 2→1、provider 专属依赖 50→49、能力兼容债 22→21、`taskExecutionPersistence` 的分派 4→2）。
  `rfc359-w4-d24-adapters.test.ts` 两引擎各跑，含 plan 点名的那条：**并发 `claimNew` 恰好一个成功、
  另一个 owner-conflict**，且落库行与胜出者一致、败者的 run 不带 session。

  ### 剩余 task-execution 对的相似度普查（2026-09-06，按可合难度排序）

  归一化（去注释、抹掉 provider 词）之后逐对量的相似度，越高越接近「同一份逻辑的两种写法」：

  | 相似度 | 对                                                                                                                                               | SQLite / PG 规模（字符） |
  | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
  | 0.31   | TaskExecutionRuntimeParticipants                                                                                                                 | 5215 / 6082              |
  | 0.26   | TaskExecutionEffectPersistence                                                                                                                   | 9821 / 28952             |
  | 0.22   | TaskLifecycleAutoRepairCommand                                                                                                                   | 2176 / 5988              |
  | 0.13   | TaskExecutionRecovery                                                                                                                            | 10139 / 19951            |
  | 0.09   | TaskOwnershipPersistence                                                                                                                         | 1541 / 12763             |
  | 0.08   | TaskArchiveMaintenanceCommand                                                                                                                    | 2133 / 21589             |
  | ≤0.04  | TaskRouteOperations / SourceTerminationParticipant / TerminalMaintenancePersistence / TaskRouteLaunchOperations / ChildExecutionLaunchOperations | 见普查                   |

  **D25 ✅（human-gate 停靠原子合一，2026-09-06）**：上一轮把 `HumanGateTaskLifecyclePersistence`
  动了一次又还原，卡点是它内部 new 了 `PostgresqlHumanGateOpenParticipantInTx`——collaboration 侧
  的另一对（695 / 820 行）。这一刀按记录的顺序从 collaboration 起手，一次收掉**三对 + 一条 legacy 路**：
  - **`humanGateOpenParticipant.ts`（新，中立）** 替代 `sqlite|postgresqlHumanGateOpenParticipant.ts`。
    正典取 SQLite 那份的语义：逐点的陈旧原因文案、提交 / 完成的**幂等重放**、以及「提交要求工件全
    `staged`、完成要求工件全 `finalized`」两条判据。关键发现是**这些语义早就有中立副本**——
    `humanGateOperationJournal.ts`（`DatabaseHumanGateOperationJournal`）是 `SqliteHumanGateOperationStore`
    的逐行异步移植，PG 那份参与者却自己内联了一套**更弱**的 commit / complete（不认幂等重放、
    不校工件状态、只从 `prepared` 起跳）。合一直接用 journal，于是 PG 侧顺带补齐了这三条。
    node run 的停靠改走 collaboration 自己声明的窄能力 `HumanGateNodeRunLifecycleParticipantInTx`
    （由 task-execution 供给），不再 import 对方 infrastructure。
  - **`humanGateTaskLifecyclePersistence.ts`（新，中立）** 替代两份 provider 实现。三处差异各取中立
    原语：`withTaskExecutionSerializable`（不改任一引擎的隔离级别）、`assertTaskOwnerTx` /
    `assertTaskOwnerlessTx`（围栏从**库外预读**挪进同一笔事务，两个引擎都不再有「读完到写之间被人
    认领」的窗口）、`transitionHumanGateTask`（蓝本就是 SQLite 跑最久的那份）。
  - **`clarifyQuestionSnapshotReader.ts`（新，中立）** 替代 `sqlite|postgresqlClarifyQuestionSnapshotReader.ts`
    ——两份逐字同一条查询，只差取行姿势。
  - **legacy 同步停靠路整条退役**：`sqliteTaskParkTransaction.ts` / `sqliteManualQuestionParkTransaction.ts` /
    `composition/taskExecutionHumanGateAdapter.ts` / task-execution 侧的同步 `HumanGateOpenParticipant`
    端口全删。`composition/humanGate.ts` 的 `parkPreparedHumanGate` /
    `settleManualQuestionParkObligations`（legacy review / clarify 服务的入口）直接落到中立原子——
    对账下来它与 `TaskParkTransaction` **逐条同判据**（同一个 owner 围栏、同一条 `transitionHumanGateTask`、
    同样提交后发事件），本来就是同一份逻辑的第二次抄写。

  又是「按端口数覆盖、不是按实现数」那条：RFC-333 的停靠套件（`rfc333-task-participants.test.ts`，
  15 个 test）**全部直接 new SQLite 那几个类**，PG 侧只有装配被引用过。这批已改接中立端口后一次全绿，
  说明两侧行为本来就该一致；新增 `rfc359-w4-d25-adapters.test.ts` 给**两个引擎**补齐停靠的核心判据
  （门消费 + 任务跃迁 + 两族事件同笔落定 / 陈旧 taskRevision 整笔回滚 / 无义务时结算是 no-op /
  带守卫的 CAS 正常落定），9 条两引擎各绿。

  留债当场清掉了 —— 见下面的 D26。

  **D26 ✅（手工提问写面合一 + 同步 gate 操作 store 退役，2026-09-06）**：
  `sqlite|postgresqlManualQuestionOpenWriter.ts`（165 / 269 行）并成一份中立实现。又是同一形态：
  PG 那份把 journal 的 `beginTx` / `markPreparedTx` **内联重写**成裸 INSERT + UPDATE，少了三条
  ——不查幂等键回放、`claimEpoch` 恒写 1、不比 `requestHash`。合一改用中立 journal 后一并补齐。

  写面是 `SqliteHumanGateOperationStore` 的最后一个消费者，于是那 825 行**整份删除**；
  `humanGateOperationTransactionStore.ts` 只留共享形状（租约常量 / 工件声明与快照 / begin 的回答），
  同步接口与 `services/humanGateComposition` 的 `createHumanGateOperationStore` 桥（零消费者）
  一起退役，rfc349 provider 具名依赖账本销一条。

  测试的处置同样按「覆盖跟着端口走」：`rfc333-human-gate-operation-store.test.ts` 锁的五条 store
  判据，其实早已被**双引擎**的 `rfc359-t1-human-gate-journal.test.ts` 逐条接管（同名五条 + 恢复
  认领排序一条），所以该文件只留与引擎无关的规范化请求断言；`rfc333-human-gate-artifact-recovery.test.ts`
  的夹具改用中立 journal。新增 `rfc359-w4-d26-adapters.test.ts` 九条两引擎各绿。

  **D27 ✅（任务执行资源快照合一 + 中立只读快照事务，2026-09-06）**：相似度表里最高的那一对
  （0.59）。resource-catalog 侧两份读面（legacy 494 行 / PG 529 行）本来就**逐行同一套逻辑**，
  差别只有三处，逐条对账后取中立形态：
  - **事务**：`DatabaseSession` 新增 `snapshotRead`。这是本刀唯一的新能力，加它是因为两个引擎
    在这条读路径上**本来就各有边界**且都不能丢：SQLite 走 `dbTxSync`（BEGIN IMMEDIATE），PG 走
    `REPEATABLE READ READ ONLY`。中立 `transaction()` 在 PG 上是 READ COMMITTED，会让闭包递归
    取数失去一致视图；所以按能力矩阵的路子补一条只读快照，两边各取原样，**边界一格未改**。
  - **可见性**：新增 `infrastructure/resourceAclTransaction.ts` 的 `canViewResourceForTx`。
    与 legacy `canViewResourceInTx` 同一条判据（audience → 私有才查授权 → `resolveAccessFrom`
    → `canViewAccess`）；PG 此前在读面里内联了逐字等价的一份。
  - **行映射**：改用同 context 内的 `*Persistence` 中立映射器。这是本刀风险最高的一处，逐个对账过
    ——`rowToAgent` vs `agentFromPersistenceRow`（sidecar 提升规则、runtime 列规则逐条相同）、
    `rowToWorkflowDetail` vs `workflowDetailOf∘workflowFromPersistenceRow`（两侧的
    `normalizeWorkflowSnapshot` / `workflowDraftSnapshotOf` 是同一个 `WorkflowDraftSnapshotSchema.parse`，
    所以 `snapshotHash` 逐字节相同）、`rowToWorkgroup` vs `workgroupFromRows`（函数体逐行相同）、
    mcp / plugin 两个本来就是同一个函数的别名。

  闭包冻结只保留异步一份：`freezeTaskExecutionCallClosureAsync` 与同步版**逐语句同构**（同一个
  builder、同一顺序、同一序列化），只在 loader 上多一个 await——所以「异步版能不能覆盖同步版」
  这个挂了很久的待裁决问题，答案是可以，且不必做行为取舍。参与者合同随之改成 Promise 面，
  `loadAuthorized` 顺序求值（闭包依赖「上一条结果决定下一条」，并发化会改变错误先后）。

  策略束里只留 legacy 行为神谕（`legacyTaskExecutionInjectionResolver`，生产零消费）还要的三个
  行映射器：它在 task-execution 里，直接 import 对方 infrastructure 会新增跨 context 内部边
  （实撞一次，R1 守卫当场报红），所以照旧经 services 装配边注入，随该文件退役一并删。

  `rfc359-w4-d27-adapters.test.ts` 九条两引擎各绿；`rfc349-task-execution-provider-adapters` 的
  闭包一致性断言从「两份实现冻出同一结果」改成「同一份实现在两个引擎上冻出同一结果」，并继续锁
  PG 那笔仍是只读可重复读快照。

  **D23a ✅（技能目录的双引擎取证基线，2026-09-06）**：合一动手前先按 D19b/D19c 的方法论取证
  ——**按端口数覆盖、不是按实现数**。新增 `tests/helpers/skillCatalog.ts`（两侧装配成同一个
  `SkillCatalogModule`；装配形状本身就是分叉的一部分，所以按能力矩阵的 `isolation` 分派，
  `describeEachProvider` 有意不把 provider 名交给 body）与
  `rfc359-w4-d23a-skill-conformance.test.ts`（八个场景 × 两引擎 = 16 条）。

  **结论：端口面已经一致**——建 / 读 / 列、内容与文件树、重名拒绝、保存推进版本、陈旧 token 拒绝、
  文件写入与读回、受保护主文件不许删、删除后再读为 null，八条在两个引擎上逐条同形同码。
  这是 D23b/c 的判据基线：合一之后每一条都必须继续成立。

  **风险因此收窄**：剩下的分叉不在端口面，而在**崩溃安全机器**本身（boot 验证、操作恢复、
  身份迁移、版本发布的 staging/swap 阶梯）——那些要的是进程级 / 崩溃矩阵测试，不是端口级场景。
  D23b（把 legacy 机器迁到 `DatabaseSession`）的验收面应当照着那一层去补，而不是再堆端口场景。

  **同批照出一条与 RFC-359 无关的存量问题**：把全部 skill 套件放进同一个 bun 进程跑，
  `skill-versioning` 的 v1/v2 与 RFC-170 的 rollforward 会红成 `skill-not-found`；去掉本次新增的
  文件照红。是跨文件的进程级状态串味（嫌疑：`skillBootVerify` 的模块级集合、
  `providerSchema` 的全局 provider 选择），CI 靠分片才没暴露。已记进 `docs/audit-backlog.md`。

  **D19c-tail 进行中（2026-09-06 落了四刀）**：legacy workgroup engine 那一片生产零消费者，
  但它的行为套件还锁着**已经没人跑**的那份实现。逐组重指到中立驱动，收干净才能删岛。
  - **第一刀（唤醒集）**：`deriveWakeSet` / `decideWorkgroupOutcome` / `WakeSet` / `WakeItem` /
    `WorkgroupOutcome` / `InflightTurns` 在中立驱动里本来就有、只是模块私有，按需导出；
    「只读成员」判据在中立侧住在 `workgroupTurnsOperations.readonlyPermission`，一并导出。
    新增 `tests/helpers/workgroupWake.ts` 把旧的 `WakeInput` 字面量翻成 `(snapshot, inflight)`
    ——其中 `budgetUsed` 在中立侧是**从 hostRuns 推**的，适配器按模式合成恰好产出该预算的 host run。
    八个套件 159 条全绿。只调了两处**命名差**（连字符拼写、`leader-nudge` 不再带 `nudgeCount`），
    判据一条没动。
  - **第二刀（领队反问停靠）**：`leaderClarifyParkedOf` 从宿主账本参与者里抽成具名导出，
    RFC-187 F3 的五条改指它。生产行为一格未变——这一格 symbol-owner 增长是「把既有规则命名」的代价。
  - **第三刀（派单卡转移表）**：两张表**逐字相同**，rfc164 全表遍历与 rfc181 的 A2 三条边直接改指
    `WORKGROUP_TURN_ASSIGNMENT_TRANSITIONS`。
  - **第四刀（房间消息 / 回合账本）——照出一处真缺口**：RFC-274 要求系统署名的房间消息要么带
    模板 key、要么显式声明 `localization: 'original'`；合一时中立驱动把**分类字段连同判据一起丢了**，
    于是两个 provider 都少了这道关，平台手写的英文兜底文案可以直接落进房间且无从本地化。已补回
    （目标种子那条正文是用户原文，显式标 original；其余 15 处本来就带模板 key），并由 rfc274 锁住三态。

  - **第五刀（派单卡 CAS / 成员游标）**：写面判据改锁中立账本操作。
  - **第六刀（反问许可）**：断言直接问 gate，legacy 的转发层不再被锁。
  - **第七刀（消息回合边界）**：`messageTurnBoundary` 抽名；「失败即关闭」那条改锁它的结构前提。
  - **第八刀（收尾轮）——第二处真缺口**：收尾轮丢掉的派单在房间里没有任何说明（模板
    `roundCapDispatchIgnored` 早就有，合一后没有调用方）。补回，并把零增量 / 收尾判据抽名改锁生产。
  - **第九刀（崩溃后派单对账）**：`decideAssignmentReconcile` 抽名改锁生产。
  - **第十刀（澄清续跑复活）——第三处真缺口**：RFC-187 T13 的恢复有两半，合一只带来一半。
    唤醒还在（`autoResumeInterruptedTasks`），**按原样澄清血缘重铸续跑**丢了：中立驱动的采纳只取
    pending，而 `interrupted` 是终态，于是只会另铸一条普通 `wg-leader-round`。而人回答过的 Q&A 是
    **靠 rerun cause 的血缘**注回提示词的（`buildClarifyQueueContext` 只在 clarify-answer /
    cross-clarify-questioner-rerun 上返回 Q&A），少了这半，任务虽被唤醒、领队却再看不到答案。已补回。
  - **第十一刀（传输重试进账本）——第四处真缺口**：中立驱动带来了「换进程重跑不吃协议预算」，
    却没带来**重跑自己进账本**那半：`retryIndex: retryBase + attempt` / `cause: attempt === 0 ? 主 cause`
    在流中断重跑（不推进 attempt）时会**撞同一个 retryIndex**、还挂主 cause。前者破坏 node_run 的
    身份（血缘 / 采纳会挑错行），后者让它**进轮次记账**——free_collab 的 `roundBudget` 逐条数成员 run、
    只跳过 `wg-protocol-retry`，一次流中断就白吃掉一整轮。补回 `freshMintOffset` +
    `transientRetryPending` 两个语义，先红后绿，双引擎锁。
  - **第十二刀（删岛）**：最后四处引用改指生产后，`engine` / `turnExecution` / `memberTurns` /
    `messages` / `prompts` / `rounds` / `lifecycle` / `wake` / `hooks` / `strategies/*` 共 **4112 行**
    整片删除（`askerKey` / `constants` / `launch` / `state` 是被全仓复用的共享件，留下）。RFC-181 的
    两条澄清判据改指 `CollaborationRuntimeMechanics` 的 SQLite 实现（collaboration 早有自己的一份，
    legacy 那份是重复件）；RFC-185 的两条传输重试断言改走中立驱动的真消息回合；RFC-182 的 pending 帧
    唯一广播点、重试预算单源锁、RFC-200 的 nonce 线程锁全部改锚中立驱动。
    `rfc294-review-off-dag-offered-edges` 的那条 RC→COL 边按它自己写明的销账条件退账（43 → 42）；
    rfc217 G5 的模式分支棘轮把中立驱动与提示词组装**纳入扫描面**（此前它们不在账内，等于 20 处分支
    从棘轮视野里消失了），rfc328 的写点允许表删掉 `rounds.ts#stampWgRound`。

    删之前还要把八个「按路径段拼」的源码锁逐条重指（`scripts/tests-referencing.sh` 只找 import，
    找不到这种形态），其中一条照出**第五处**缺口：房间消息 id 在中立驱动里退回了普通 `ulid()`。
    房间切片与成员游标都按 `message.id > cursor` 的**字典序**判「我没看过的」，同毫秒两条消息之间
    没有稳定序，游标若先落在字典序较大的那条上，另一条对该成员**永远不再出现**——正是 RFC-186 §3-4
    引入 `monotonicFactory()` 要消除的窗口。已补回，并加了「同毫秒连发 64 条严格递增」的行为判据。

  **D19c-tail ✅ 完工**：legacy workgroup 引擎岛已删除，两个 provider 只剩一条回合实现。
  过程中照出并修好**五处**合一遗漏的真缺口（系统消息分类、收尾轮房间说明、澄清续跑复活、
  传输重试记账、房间消息单调 id），全部带判据。

  ### 生命周期修复这一对的勘察结论（2026-09-06，**订正**）

  第一眼看上去是「一好一坏」：`TaskLifecycleAutoRepairCommand` 的 SQLite 侧是 65 行薄适配器，
  套在 `platform/persistence/sqlite/taskLifecycleRepair.ts`（513 行）+ `taskLifecycleRepair/options-*.ts`
  （14 个规则族、2613 行）这套成熟机器上；PG 侧只有 198 行，且**只实现 `S4.kick-task`**，
  别的选项一律抛 `postgresql-auto-repair-option-not-supported`。

  **对账之后不成立**：v1 里 `autoApplyEligible: true` 的选项**只有 S4.kick-task 一个**
  （`options-S4.ts:30` 是全仓唯一一处），而 `runAutoRepairOnce` 只在「恰好一个 autoApplyEligible
  且 available」时才自动施用。也就是说两边的**自动**修复能力**等价**，PG 不是缺能力，是把这唯一一条
  重写了一遍。人工修复面（诊断页那条路）两边也都是全的：PG 有自己的
  `postgresqlTaskRouteRepairOperations.ts`（1448 行），R1 / R2 / C1 / T1–T3 / U1 / S1–S6 全覆盖。

  **所以这里的问题是重复实现，不是能力缺口**——排期上没有「PG 用户此刻用不了」的紧迫性，价值在于
  「以后新增一个 autoApplyEligible 的选项不用写两遍、也不会只有一边生效」。真正的大头是那 1448 行
  PG 路由修复与共享目录的重复（形态同 D23：一侧薄适配 + 成熟机器，另一侧原生重写）。
  好消息是共享那套**天然中立**：`taskLifecycleRepair.ts` 与全部 options 模块里 `dbTxSync` /
  `.all()` / `.get()` / `.run()` 各 0 处，用的全是 drizzle 异步面，只是被类型钉成 `DbClient`、
  住在 `platform/persistence/sqlite/` 路径下。合一形状因此是把它整体提为中立（换类型 + 挪目录，
  事务点走 `databaseSessionFor`），PG 那两份退役。

  ### D23b ✅ 落地（2026-09-06/07）：先拆墙，再迁机器

  D23b 一度判定阻塞——技能的两个提交面被 **bundle apply 的同步大事务**调用（`dbTxSync`），
  body 里 await 不了，而 op 原语中立化后必须 await。**解法是先拆那堵墙**：
  1. **拆墙**：`legacyResourcePackageBundleApply.ts:390` 的大事务换成
     `databaseSessionFor(db).transaction(...)`，边界一格未变（journal 的 prepared→applying CAS、
     全部资源提交、journal committed 仍是同一笔），`.run()` 后读 `.changes` 换成中立的 `affectedRows()`。
     链上其余**同步** `*InTx` 成员（agent / mcp / workflow / workgroup / template）暂时保留，
     由 `bindApplyTx` 内一个具名的 `syncTx` 把中立句柄重新窄化给它们。
     **这不是强转谎话**：SQLite 会话交出的事务句柄**就是 `DbClient` 本身**
     （`createSqliteDatabaseSession`：`const tx = db as unknown as DatabaseTransaction`），
     适配器只是把平台层**已经依赖的那条身份**在类型上说一遍，并带退役条件——两套 apply 引擎
     合一时随文件一起消失，新增同步成员会被 `rfc359-sync-transaction-highwater` 账本挡下。
  2. **迁机器**：`skillOperations` / `skillReserveOp` / `skillDeleteOp` / `skillMigrateOp` /
     `skillVersionOp` / `skillOpRecoveryDriver` / `skillVersion` / `skill` / `skillIdentityMigration` /
     `skillBootVerify` 全部改吃中立事务。两阶段提交的阶段边界、锁的生命周期、崩溃恢复方向判据、
     隔离与 quarantine、发布阶梯的 swap/backup 顺序**逐条不变**；唯一冲突判别从写死的 SQLite
     错误串换成引擎能力面（`engineOf(tx).classifyError`）。
  3. **清重复件**：三处「只为同步路径存在」的副本按它们自己写明的退役条件删除——
     `sqliteSkillVersionCommitParticipant.ts`、`sqliteMemoryMembershipParticipant.ts`、
     `createSyncSkillRestoreMembership` / `SyncMemoryMembershipUnfuse`。

  **判据面**：技能与捆绑应用两侧 **322 条**用例全绿（崩溃恢复矩阵、身份迁移屏障、发布 staging 阶梯、
  boot 重验、包应用重放都在内）。同步事务面账本 41 → 33 个文件、124 → 85 个调用点。

  **三次撞上「漏 await 静默通过类型检查」**（`docs/dev-gotchas.md` 刚记下的那条），无一例外表现为
  「写好像没生效」而不是编译错：`deleteSkill` 漏 await ⇒ 删除没删掉；捆绑应用的**幂等尾**漏 await
  ⇒ 发布完没 mark boot-verified；测试侧多处漏 await ⇒ 断言拿到 Promise。按 gotchas 记的办法
  （按改成异步的导出名逐个 grep 调用点）全部找出。**D23c**（SQLite 装配切到这套机器、PG 那 3342 行
  原生实现退役）是下一刀。

  ### D23c ✅ 落地（2026-09-07）：技能目录合一，PostgreSQL 原生实现整体退役

  **动手前先做了一次决定性实验**：把双引擎一致性夹具的 PG 分支直接指向（D23b 已中立化的）legacy
  机器，跑 D23a 的 8 个场景。第一轮 8 条全红——`loadSkillRow` 在 create 之后读不到刚写的行。
  排下来是**我自己**在上一轮把 `tx.insert(skills).values({...}).run()` 的 `.run()` 摘掉时漏了
  `await`（同一个坑第四次）：SQLite 单连接下这条也一样不执行，只是那轮没跑测试没暴露；PG 上
  立刻现形。补上 `await` 后**两个引擎各 8/8 全绿**——合一可行由实测而非纸面对账确认。

  **合一的四刀**：
  1. **技能身份迁移屏障中立化**（`legacy/skillIdentityMigration.ts`，942 行）。这是最后一块
     SQLite-only 的技能机器：19 处同步读写 + 一条 `PRAGMA foreign_key_check('skill_versions')`。
     文件系统布局两个引擎共用（`~/.agent-workflow/skills/`），所以 SQLite→PG 迁过来的部署**照样
     可能**带着旧的 name-目录布局，屏障两边都真的需要，不能按「PG 没有历史包袱」糊弄过去。
     期间又逮到 **3 处漏 await 静默通过类型检查**：两处是 `boolean && versionPathsCanonical(...)`
     ——`false | Promise<boolean>` 是合法类型，而 Promise 恒真，判据直接失效；一处是两条 authority
     断言被整个丢掉。全部由「按改成异步的导出名逐个 grep」找出，`docs/dev-gotchas.md` 那条办法再次奏效。
  2. **合一时按「好的那份」抬齐**：PG 原生屏障**整条略过**了引用完整性复核（SQLite 侧有
     `PRAGMA foreign_key_check`）。合一没有取交集，而是把判据改写成两个引擎都能跑的孤儿行查询
     （`skill_versions LEFT JOIN skills WHERE skills.id IS NULL`），语义与 PRAGMA 对该表的检查一致
     ——**PG 侧因此补齐了此前缺失的这道屏障**。这正是「不允许一个好一个不好」的处理方式。
  3. **顺手退掉挡路的 ACL 分叉**：`updateResourceAcl` 的 SQLite 专属同步 after-write 分支
     （连同 `sqliteResourceAclRepository.ts` 334 行、`transitionMcpAclRuntimeTestsInTx`）**没有任何
     生产调用方**——最后一个在 W4-D16 就改走中立 `ResourceAclMutationLifecycle` 了，只剩一个测试
     自己手接旧钩子、证明一处没人用的接线。测试改指生产装配后整条退役，ACL 读面随之全面中立化
     （`createSqliteResourceGrantReadPort` 这个别名一直只是中立实现的旧名字）。
  4. **装配收口**：`sqliteSkillRepository/ZipImport/CatalogBoot` 更名为中立的
     `skillRepository/skillZipImportAdapter/skillCatalogBootAdapter`；`composePostgresqlSkillCatalog`
     与 `composePostgresqlSkillCatalogBoot` 删除，两个 daemon 走同一个 `composeSkillCatalog` /
     `composeSkillCatalogBoot`；PG bundle 的技能格换成中立目录 + 共用的 `createSkillContentAvailability`。

  **退役的四个文件（3342 行）**：`postgresqlSkillRepository.ts`(505) /
  `postgresqlSkillContentLifecycle.ts`(873) / `postgresqlSkillZipImport.ts`(546) /
  `postgresqlSkillCatalogBoot.ts`(1418)，加上 `sqliteResourceAclRepository.ts`(334)。

  **补上的验收缺口（这一刀最重要的一步）**：合一前，那套崩溃安全机器的 14 个套件（boot 验证 /
  操作恢复 / 身份迁移 / 发布 staging 阶梯 / 版本…共 4140 行）**全是单引擎**的。合一之后它们描述的
  就是 PostgreSQL 的行为，却一次都没在 PG 上跑过——只把实现并成一份、验收面仍只覆盖一个引擎，
  等于把「一个测到、一个没测到」换个位置放。新增 `rfc359-w4-d23c-skill-machinery-conformance.test.ts`
  补上那一层，挑**引擎语义真的可能分叉**的路径两个引擎各跑一遍（8 场景 × 2 = 16 条全绿）：
  ① 两阶段 op 的锁互斥；② 重名冲突的唯一冲突分类必须判 409 而非 500（SQLite 看 errno、PG 看
  SQLSTATE，最容易只在一侧成立）；③ 崩在 create 途中的 `reserving` 行 + 锁被恢复驱动清干净
  ——**正是 P0-11 说的那个「PG 上永远没人清、同名永远建不了」的形态**，现在两个引擎都实测清得掉；
  ④ 身份迁移屏障的引用完整性复核两个引擎都真的执行（外键在两侧都挡得住孤儿行，制造不出来，
  所以另加一条源码锁：判据必须是可移植的孤儿行查询、不得退回 PRAGMA）；⑤ 版本提交 / 回滚同形；
  ⑥ 孤儿锁 GC 不误伤活着的 op；⑦ phase 阶梯走完锁真的释放。纯文件系统的部分与引擎无关，
  留给既有单引擎套件，不重复。

  **判据面**：技能 / 包 / RFC-345 / RFC-359 相关 **156 个测试文件**在两个引擎上全绿
  （SQLite 1143 条、开 PG 后 1423 条）；D23a 的 8 场景 × 2 引擎现在跑的是**同一份实现**。
  9 条源码锁按新形状改写（不是放宽：`rfc345-classic-facade-provider-neutralization` /
  `rfc345-skill-zip-provider-neutral` / `rfc345-skill-catalog-boot-participant` /
  `rfc349-resource-catalog-classic-postgresql-adapters` 都从「PG 那份保持原生」改成
  **锁「只剩一份、四个原生文件必须保持不存在」**）。同步事务面账本 32 → **30 个文件、83 → 81 个调用点**；
  RFC-294 的 off-DAG offered 边少一条（`postgresqlSkillRepository → memory` 随文件退役，早于其 W4-E3 计划波次）。

  ### D28a ✅ 落地（2026-09-07）：任务归属端口的双引擎取证基线

  下一对（`TaskOwnershipPersistence`）与合一前的技能目录**同形**：SQLite 是 43 行薄适配器套
  563 行成熟同步实现，PostgreSQL 是 444 行原生重写；覆盖同样倒挂——
  `rfc328-durable-ownership.test.ts` 有 1495 行正确性矩阵，**全部只跑 SQLite**，PG 那 444 行的
  owner CAS / 租约 / 撤销 / 恢复逻辑**没有任何活着的行为覆盖**（现有引用全是源码文本锁）。

  按 D23a 的方法论先取证：新增 `rfc359-w4-d28a-task-ownership-conformance.test.ts`，
  九个场景通过同一个端口在两个引擎上各跑一遍（**18 条全绿**）：认领 / 重复认领冲突 /
  不存在的 intent / 心跳续租（revision 与租约都要推进）/ 撤销要对上 revision /
  撤销后心跳被围栏挡住 / 标记需要恢复 / 旧世代 daemon 被持锁者撤销 / 无 owner read 回 null。
  **结论：这一对的端口面本来就一致**（不像技能那次一跑就照出 PG 缺一道屏障），
  所以 D28b 的合一风险主要在事务原语本身，不在行为分叉。

  ### D28b 的真实形状（2026-09-07 实做到一半后回退，未提交；这是本轮最有价值的勘察结论）

  **它不是「再合一对」，而是把剩下的整条同步事务面一次性拔掉**——因为那 30 个文件是**一个连通分量**，
  由五个共享的同步 helper 绑在一起，动其中任何一个都会连锁拉动其余：

  | 同步 helper                         | 调用点 | 中立孪生                                                  |
  | ----------------------------------- | ------ | --------------------------------------------------------- |
  | `setNodeRunStatusTx`                | 8      | ✅ `nodeRunLifecycleTransition.ts`（异步、中立）          |
  | `terminalizeTaskExecutionIntentsTx` | 8      | ✅ `effectQuiescence.ts`（异步、中立，且**更强**）        |
  | `withOwnedTaskTx`                   | 10     | ❌（但它本身就是中立 `assertTaskOwnerTx` 逐字重复的一份） |
  | `withTaskExecutionMutation`         | 4      | ❌                                                        |
  | `withTaskExecutionTransaction`      | 3      | ❌                                                        |

  实测：把 owner 围栏一改，类型错一口气从 0 涨到 140+，跨
  `sqliteTaskExecutionEffect.ts`(1756 行 / 66 处同步调用)、`sqliteTaskExecutionEffectPersistence.ts`、
  `services/task.ts`、`platform/persistence/sqlite/taskLifecycle.ts`、
  `collaboration/legacySqliteReview.ts`、`sqliteCollaborationWorkgroupClarify.ts` 等十余个文件。
  **本轮把已改的部分整体回退**（工作树留干净），理由是：在一次会话里把这么大的异步化连同
  「漏 await 静默通过类型检查」的风险一起推上共享 main，不划算——这一刀值得单独一个 PR 专门做。

  **已勘明的三条，下一刀可以直接用**：
  1. **`withOwnedTaskTx` 是 `assertTaskOwnerTx` 的逐字重复**（`ownedTaskExecution.ts`），
     只是外面裹了 `dbTxSync`——D21 的 owner CAS 去重没走完最后一步。中立那份唯一缺的是
     「把 bump 后的 revision 交出来」，加上即可，不必新写。
  2. **两个现成的合一红利，且中立那份都更强**：
     `terminalizeTaskExecutionIntentsTx` 的中立版校验 terminalize 行数与预期相等、不等就抛
     `task-continuation-stale`，同步那份直接放过；`setNodeRunStatusTx` 同样有中立异步孪生。
     合一时按「好的那份」抬齐（与 D23c 处理引用完整性复核同一原则）。
  3. **顺序**：先给 `assertTaskOwnerTx` 加返回值并让 `withOwnedTaskTx` 委托过去 → 再退
     `terminalizeTaskExecutionIntentsTx` / `setNodeRunStatusTx` 的同步孪生 → 再 effect store →
     最后调用方。每一步跑一次 `bunx tsc` 与 D28a 套件；**每把一个函数从同步改成异步，都要按
     `docs/dev-gotchas.md` 那条「按导出名 grep 调用点」扫一遍**——这一轮在技能那边就是靠它
     逮到 3 处漏 await 静默通过类型检查（两处是 `boolean && Promise` 恒真、判据直接失效）。

  ### D28b 第二次尝试与它换来的门（2026-09-07，实测后再次回退）

  按上面的顺序真的做了一遍：30 个文件机械迁完、`bunx tsc` **全绿**。然后把类型感知的
  `@typescript-eslint/no-floating-promises` 第一次指向那批文件——**当场 62 处被丢掉的 Promise**。
  也就是说这条路上「类型检查过了」根本不构成证据：漏掉的 await 只表现为「写好像没生效」，
  而且集中在崩溃 / 并发才走到的分支上，正是任务执行内核最不能出错的地方。**据此再次整体回退**
  （工作树干净、main 全绿），但这一次带回了让它安全的东西：

  **① 这道门已经常设**（`bun run lint:promises` → 独立的 `eslint.promises.config.js`，只针对
  `packages/backend/src/**/*.ts`，只开 `no-floating-promises` + `no-misused-promises`，约 30s，
  已挂进 `bun run lint`）。独立成一份配置是必要的：主配置带上 `project` 会让 RFC-282 那种
  `eslint.lintText` 合成路径解析失败、连带吞掉该文件其它规则的报告。
  下一次做这刀**先开门再动手**，让它全程亮着——事后补是补不干净的。

  **② 开门当天照出并修掉 15 处存量真丢弃**（与本次迁移无关、早已在 main 上）：
  - `effect?.succeed()/fail()`（`nodeRollback` / `nodeIsolation` 共 6 处）——effect 台账的结算
    记录不等落库就返回；
  - fan-out 的 `recordConsumed`——端口写成 `void`、实现是异步写 `node_execution`，
    这次写被合法丢掉（契约已收窄成 `Promise<void>`）；
  - **资源包 apply 在写入落库之前就铸回执**——`commitCapability` 同步调用异步的 `applyPrepared`，
    「已应用」的回执可能先于写入返回。**这一处是 W4-D23b（本轮 `2de427ad8`）自己引入的**，
    由这道门当场抓出；契约（7 个 `*PackageMutationParticipantInTx.commit`）已改成 Promise 形。
  - 另有 4 处确属刻意的 fire-and-forget，改成显式 `void` 并写明理由。

  **③ 契约不要写 `void | Promise<void>`**：联合里混进 `void` 之后，丢 Promise 是合法写法，
  连 `no-floating-promises` 都不报。本轮把 `commitSkillReadyInTx` / `compensateManagedSkillStage`
  等 3 处收窄成 `Promise<void>`（实现本来就是异步、消费者本来就 await）。

  **结论**：D28b 依然是「把剩下整条同步事务面一次性拔掉」，形状与顺序同上一节；
  改变的是**它现在有了机械化的验收面**。没有这道门之前不该再尝试第三次。

  ### D28b 第三次尝试：真实规模比账本大一倍以上（2026-09-07，仍回退）

  这次带着已经开好的门重做了一遍，并且找到了前两次没找到的那一层：**账本里那 30 个文件不是全部**。
  账本清点的是「调用 `dbTxSync` / `withOwnedTaskTx` 的文件」，而另有 **37 个文件只是 `DbTxSync`
  类型的消费者**（aggregateAdapters 的两个参与者、`existingTransactionScope`、ACL 读仓 /
  grant 仓、committed-event 参与者、mcp / plugin persistence …）——它们不调用同步原语，
  所以从不进账本，但同步面一动它们全部要跟着动。**实际改动面 72 个文件、约 3700 行**，
  是账本数字的一倍以上。

  三次尝试的类型错都停在同一种地方，且**越做越大**：104 → 235 → 268。自动化（终结符改写、
  编译器驱动的 asyncify、按声明 / 按位置补 await、箭头回调 asyncify）每次都能砍掉八成，
  剩下的两成是**必须逐处读代码判断 await 落在哪里**的，机械 pass 到这里会开始互相打架
  （最后一轮 262 → 268 就是两个 pass 互相撤销对方）。

  **结论（第三次，判据比前两次硬）**：这一刀不能靠脚本收尾，也不该在一次会话里推上共享 main。
  它需要的是：**先把账本改成按 `DbTxSync` 类型消费者清点**（现在的口径少算一半以上），
  然后按文件逐个人工过，全程开着 `bun run lint:promises`（这道门已常设，见上一节）。
  在此之前不要再尝试第四次机械转换——三次都停在同一堵墙上，堵的位置也一次比一次靠后。

  ### D28b 第四次：换一种切法，第一刀落地（2026-09-07，已提交 c074e806d）

  前三次都把 D28b 当成「一次性拔掉整条同步事务面」，于是每次撞在同一堵墙上。这次换了切法，
  第一刀当天绿着上了主干。**变的不是工具，是找缝的判据**：
  - 前三次按**文件**切（账本 30 个 / 实际 61 个引用 `DbTxSync` 的文件）。一个文件里但凡有一处
    同步调用点，整份都要转 async，async 于是从那里向所有调用方扩散——级联面就是那约 3700 行。
  - 这次按**「外层函数是不是已经 async」**切。同步网关 `sqliteOwnedTaskMutation` 的四个导出
    只有 5 处调用点，而这 5 处的外层函数（`setTaskStatus` / `transitionMergeState` /
    `dispatchReviewNodeUnlocked`）**本来就是 async**——改完补个 `await` 就完了，**零级联**。

  照这个判据重看剩下的面，它就不再是「一件事」，而是一串**互不牵连的小刀**：一处同步调用点，
  只要外层函数已经 async、且体内用到的内层 helper 已有中立 async 版本，它就能单独迁、单独测、
  单独提交。本刀用到的三个内层 helper（`transitionNodeRunStatusTx` /
  `createNodeRunMintParticipantInTx` / `transitionHumanGateTask`）**全部早已存在**——W1/W4 前几波
  已经把中立侧建好了，剩下的只是把调用点接过去。这也解释了前三次为什么越做越大：机械 pass 不区分
  「已经 async 的外层」和「要连带转 async 的外层」，把两类混在一起做，后者的级联淹掉了前者的收益。

  **落地结果**（c074e806d）：`sqliteOwnedTaskMutation.ts` 整份退役；同步事务面账本 30 → 29 个文件
  （调用点 81 → 77）；rfc349 provider 具名依赖 46 → 44；`public/` 少两条点名 provider 的债。
  行为上补了一处分叉：旧同步网关在「无执行上下文」分支里既不开事务也不设围栏、直接裸写，新路径
  按统一规则走无主围栏——PG 侧一直是有围栏的那侧，合一以它为准（`rfc359-w4-d28b-owned-mutation-gateway.test.ts`
  双引擎各 2 条锁住，变异验证：摘掉 `fenceTaskWrite` 后正是围栏那 2 条红）。

  **下一刀怎么选**（同一判据，逐处筛）：
  1. `grep` 出还在用 `dbTxSync` / `withOwnedTaskTx` 的调用点；
  2. 每一处先看**外层函数是不是已经 async**——是就进候选；不是就跳过，它属于要连带转 async 的那
     一类，留到最后统一处理；
  3. 再看体内的内层 helper——判据要写严一点：**不是「有没有中立 async 版本」，而是「这个 helper
     的类型面还被别人钉在 `DbTxSync` 上没有」**。两者不等价，`legacy/agent.ts` 就是反例：它 5 个
     调用点的外层函数全是 `async`（第 2 步全过），体内却只调一句
     `commitAgentCreateInTx(tx, prepared)`，而这个 helper 的签名是 `(tx: DbTxSync, …) => void`，
     并且**被生产的意图应用链共用**（`aggregateAdapters/legacyIntentApplyResourceParticipants.ts`
     的端口逐字段声明成 `(tx: DbTxSync, prepared: unknown) => void`）。把它改成中立的，意图应用
     那条链要跟着改——级联从这里开始。所以 `legacy/agent.ts` **不是**一刀，它属于「意图应用参与者
     链」那一批，要连着做。
  4. 两条都满足就是一刀：改完跑 `bun run lint:promises` + 双引擎跑一遍 + 把账本改小，单独提交。

  **第二刀（同日，`0560998df`）验证了这套筛法可复用**：runtime 注册表那一对（247 行 SQLite /
  336 行 PG，十二个方法同名同序）五处同步调用点的外层函数**全部已经是 async**，一筛就中，改完
  同样零级联。这一刀比第一刀更进一步——不只是退掉同步网关，而是**把两份 provider 实现整体合成
  一份**，PG 那 336 行连同它内联重写的会话失效逻辑一起退役。两条经验记下来：
  - **隔离级别要逐方法抄 PG 那份**，别一刀切成 `.transaction`。PG 侧对「先查后写」的跨行判据
    （默认 runtime 不许停用 / 最后一个不许删 / 种子只种一次）用的是 SERIALIZABLE + 40001 重放，
    合一后对应 `databaseSessionFor(db).serializable`；其余两处才是普通写事务。
  - **合一会顺带照出「PG 自己抄了一份」**：`transitionRuntimeTests` 在 PG 文件里被内联重写，与
    `legacy/mcpRuntimeTestTransitions.ts` 的同步版并存。这类重复只有在合一时才会被逼着逐字段对
    账——本次对完确认语义相同，合并即可；D23c / D25 / D26 那几次对完是 PG 更弱，要按强的那侧抬齐。

  ### 账本里有一批「测试专用」的同步面：先分类，再决定要不要迁（2026-09-07 清点）

  按上面的筛法逐处看 resource-catalog legacy 那 11 个调用点时发现：**其中 10 个所在的函数在
  生产代码里一个静态调用方都没有**，只被测试大量使用。逐个清点（`grep` 静态调用点，
  排除定义文件本身）：

  | 函数                                          | 生产调用方                     | 测试用点 |
  | --------------------------------------------- | ------------------------------ | -------- |
  | `legacy/agent.ts` `createAgent`               | 0                              | 250      |
  | `legacy/agent.ts` `updateAgent`               | 0                              | 36       |
  | `legacy/agent.ts` `deleteAgent`               | 0                              | 23       |
  | `legacy/agent.ts` `renameAgent`（2 处调用点） | 0                              | 14       |
  | `legacy/workflow.ts` `copyWorkflow`           | 0                              | 9        |
  | `legacy/workgroups.ts` `createWorkgroup`      | 0                              | 53       |
  | `legacy/workgroup/state.ts` `casGateStatus`   | 0                              | 14       |
  | `legacy/workflow.ts` `createWorkflow`         | 1（`legacy/workflow.yaml.ts`） | 110      |
  | `legacy/importRefs.ts` `resolveImportRefs`    | 1（同上）                      | 11       |

  而那唯一的上游 `importWorkflowYaml` 自己也是**生产零调用方 / 16 处测试用点**——整条
  YAML 导入链在生产里没有入口（生产只消费同文件里的纯函数 `stringifyWorkflowYaml`）。
  资源写面的生产路径早已走中立的 `agentRepository.ts` / `agentPersistence.ts` 那一套。

  **这件事改变优先级**：这 8 个调用点**不是**「PostgreSQL 上跑不了某个功能」，而是**测试夹具
  把一批已死的生产代码吊着**。它们在账本里和真正的单引擎路径混在一起，会让「还剩多少」显得比
  实际的用户可见风险更严重。

  **另记一笔工具上的坑**：用「往上找最近的函数声明」这种正则启发式判断「外层是不是 async」会
  **漏判**——`renameAgent` 明明是 `export async function`，却因为它体内先出现了别的匹配行而被归进
  「外层非 async」那一堆。也就是说零级联候选比第一次扫出来的 23 处**更多**，下一轮筛选建议直接用
  TypeScript AST 取 enclosing function，别用正则。

  **处置建议（按性价比排序，都不必一次做完）**：
  1. **先确认「零调用方」**——上面只查了静态调用点，还要排除经 operation descriptor /
     `services/*` re-export 的动态到达。确认后按仓规「删除优于 deprecate」整体删除，测试改接
     中立仓（`agentRepository` / `workflowPersistence` 一类），账本一次掉 10 个点——
     `legacy/agent.ts` 那 5 个调用点**整份**都在这一类里（create / update / delete / rename×2）。
  2. **若暂不删**：把它们的内部改成中立事务原语即可，**签名一格不动**（它们本来就是 `async`），
     250 处测试调用完全无感——这仍然是零级联的一刀，只是收益是「账本数字」而非「用户可见能力」。
  3. **别再把它们和真单引擎路径混在一张表里**：下次更新账本正文时给这类加个标记，让读账本的人
     一眼看出哪些是「功能只有一个引擎能用」，哪些只是「测试夹具吊着的死代码」。

  **仍然成立**：不要再做第四次全量机械转换。账本口径确实少算一半以上（30 个调用者 vs 61 个
  `DbTxSync` 引用者），但**按这种切法它不再是拦路石**——每一刀只动自己那几处；口径问题留到最后
  那批「外层函数还不是 async」的文件时一并处理。

  ### 剩余工作的真实形状：一件事，不是 N 件（2026-09-06 量化）

  上面两条勘察（D23b 卡在 bundle apply 的同步大事务、剩余 task-execution 对卡在 `withOwnedTaskTx`）
  指向同一个根：**bun:sqlite 独有的同步事务面**。已按调用点清点并上了高水位账本
  （`tests/architecture/rfc359-sync-transaction-highwater.test.ts`，注册进 `ledger-baselines.json`
  与 `guard-manifest.json`）：

  | 上下文                   | 调用点               |
  | ------------------------ | -------------------- |
  | modules/resource-catalog | 52                   |
  | modules/task-execution   | 20                   |
  | platform                 | 18                   |
  | modules/intent           | 13                   |
  | modules/collaboration    | 8                    |
  | services                 | 4                    |
  | auth                     | 4                    |
  | **合计**                 | **129（43 个文件）** |

  中立原语**早就有**（`databaseSessionFor` / `withTaskExecutionWrite` / `withTaskExecutionSerializable`），
  所以剩下的不是设计问题而是迁移量。账本让这件事从此可计数、可防守：新增一个同步调用点就红，
  收敛了也要改账本——每一次减少都留下一次有署名的记录。

  ### Skill 聚合的勘察结论（W4-D23，尚未动手；这是剩余最大的一块）

  形态与任务房 / 回合完全同类，但深一个量级：**SQLite 侧是一层薄适配器，套在成熟的崩溃安全机器上**
  （`sqliteSkillRepository.ts` 129 行 → `legacy/skill.ts` + `legacy/skillVersion.ts`；
  `sqliteSkillCatalogBoot.ts` 22 行 → `legacy/skillBootVerify` + `skillIdentityMigration` +
  `skillVersion`；`sqliteSkillZipImport.ts` 23 行 → `legacy/skill-zip`），**PostgreSQL 侧是 3342 行原生
  重写**（`postgresqlSkillCatalogBoot.ts` 1418 / `postgresqlSkillContentLifecycle.ts` 873 /
  `postgresqlSkillRepository.ts` 505 / `postgresqlSkillZipImport.ts` 546）。两侧归一化后的**相似度只有
  7%**——不是同一份逻辑的两种写法，是两套机器。测试覆盖同样倒挂：SQLite / legacy 侧 52 个套件，PG 侧 6 个。

  **为什么不能照 D19c 的做法直接合**：D19c 能把 PG 那份提为中立基线，是因为它的决策逻辑本来就在
  provider 中立的 driver 里、PG 那份只是持久化适配器。Skill 不是——SQLite 那套机器同时耦合
  **文件系统**（`skillFsPublish` 的暂存目录 / 原子换入、`skillHash` 的树哈希、`skillIdentityPaths`）
  与 **`dbTxSync`**（28 处），崩溃安全协议就建立在「同步事务 + 目录换入」的次序上。把它中立化＝把
  这套恢复协议整体迁到 `DatabaseSession`，那正是账本里一直挂着的 **W9-E** 波次。

  **建议拆法（每一刀都要能独立跑绿）**：
  1. **D23a 勘察对账（零生产改动）**：把两侧的行为逐条列成对照表——版本快照 / 内容围栏 / 目录换入 /
     启动重验 / 身份迁移屏障 / zip 导入的解析与提交，各自的失败模式与恢复点。产出是「哪一份是正典」的
     逐条裁决，呈用户确认。参照 D19c 的教训：**先对着端口数覆盖**（`SkillRepository` /
     `SkillCatalogBootAdapter` / `SkillZipImportPort`），52 个套件里有多少是直连 legacy 实现的。
  2. **D23b 把 legacy skill 机器迁到 `DatabaseSession`**（W9-E 的实质）：28 处 `dbTxSync` 换成统一事务
     原语，恢复协议的次序不变。这一刀不碰 provider 分叉，只把 SQLite 那套变成两个引擎都能跑的。
  3. **D23c 合一**：SQLite 装配切到那套（已中立的）机器，PG 的 3342 行原生实现退役；差异按 D19c 的三条
     处置（正典恒取合一前 SQLite / 部署形态差异抽端口 / 合完立刻跑「谁引用了这些路径」的全部测试）。

  **剩余 provider 对的形态普查（决定后续排序）**：把 resource-catalog 里剩下的成对文件按
  「SQLite 是不是 legacy 薄壳」分两类——
  - **对称对（机械可合，无行为风险）**：`PackageResourceRows`（230 / 220 行，无 legacy import）、
    `IntentContextResourceAuthorization`（63 / 52 行，无 legacy import）→ 已由 **D20** 合掉。
  - **薄壳对（SQLite 是 legacy 上的壳，PG 是原生实现，且测试覆盖倒挂）**：任务房（71 / 1457）、
    回合（34 / 567）、Skill 三对（22–129 / 505–1418，52 个套件盯 SQLite 侧、PG 侧只有 6 个）、
    `ResourcePackageMaintenance`（293 / 379，5 处 legacy import）、
    `DigitalEmployeeAgentTemplateCatalog`（59 / 390）。这一类**都不是机械合一**：合的时候要先裁
    「哪一份实现是正典」，且大概率会像 D19b 一样撞出用户可见的行为差异。建议逐个先做「形态勘察 +
    覆盖对比」再动手，不要按文件数排优先级。

  **D20 ✅（两对对称适配器合一）**：`infrastructure/intentContextResourceAuthorization.ts`
  （Intent 上下文的资源身份 / 授权等级读取；异步端口一份，SQLite 的同步变体保留——Intent 宿主在
  SQLite 上仍跑在 `dbTxSync` 回调里，随宿主切统一事务原语后退役）与
  `infrastructure/packageResourceRows.ts`（资源包的 owner+name 查找 + 预览 / 导出读模型）各一份。
  同批清掉两处死代码：SQLite 的 Intent **异步**工厂零生产消费（两个 SQLite bootstrap 用的都是同步版）、
  `listSqlitePackageResourceRowsByIds/ByNames` 零消费；`sqlitePackageResourceRows.ts` 缩到只剩
  legacy 提交路径用的四个同步助手。三个 provider 文件删除；rfc345 三把锁与 rfc349 adapters 锁改指中立实现。
  `rfc359-w4-d20-adapters.test.ts` 两引擎各跑身份读取 / 授权三元组精确命中 / owner-name 查找 /
  读模型按 id 与 name 取快照 / 只回活跃用户 + 源码锁。

  ***

  ## W4 机械阶段收尾：剩余 provider 对的全仓普查（2026-09-06）

  D14–D20 之后，**能靠「PG 异步实现改名成中立实现 + SQLite 装配切过去」机械合掉的对已经清空**。
  全仓仍有 176 个 provider 命名的文件、约 39 对，逐对量过之后它们全部落进下面两类，**每一类都需要
  先做一个决定，不能再当重构顺手推**：

  ### 甲类：薄壳对——SQLite 是 legacy 上的壳，PG 是原生实现，且**测试覆盖倒挂**

  | 对                                                                                                                                                                                                                                                                                                                                                                                                                   | SQLite / PG 行数                | SQLite 侧行为套件                          | PG 侧               |
  | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------ | ------------------- |
  | 工作组任务房                                                                                                                                                                                                                                                                                                                                                                                                         | 71 / 1457                       | 13（含 rfc164 / rfc167 / rfc311 / rfc329） | 3（多为源码形状锁） |
  | 工作组回合引擎                                                                                                                                                                                                                                                                                                                                                                                                       | 34 / 567（+ 中立驱动 2819）     | 同上                                       | 同上                |
  | Skill 三对                                                                                                                                                                                                                                                                                                                                                                                                           | 22–129 / 505–1418               | 52 个文件                                  | 6                   |
  | ResourcePackageMaintenance                                                                                                                                                                                                                                                                                                                                                                                           | 293 / 379（5 处 legacy import） | —                                          | —                   |
  | DigitalEmployeeAgentTemplateCatalog                                                                                                                                                                                                                                                                                                                                                                                  | 59 / 390                        | —                                          | —                   |
  | task-execution 十对（TaskRouteOperations 292 / 2048、TaskRouteLaunchOperations 92 / 1362、TerminalMaintenancePersistence 33 / 543、TaskOwnershipPersistence 43 / 444、TaskArchiveMaintenanceCommand 66 / 746、ChildExecutionLaunchOperations 87 / 770、TaskExecutionEffectPersistence 369 / 1007、TaskExecutionRecovery 393 / 674、TaskLifecycleAutoRepairCommand 65 / 198、TaskExecutionResourceSnapshots 40 / 69） | —                               | —                                          |

  **这一类的共同问题**：两侧不是同一份逻辑的两种写法，而是**两套实现**；哪一份是正典要先裁。

  **D19b 给出了这一类的做法模板（已实证）**：照 PG 形状合完、双引擎测试全绿，仍撞出 4 条用户可见的
  行为差异（confirm 恢复失败从 410 变 200、继续意图类别写成没人认领的 `resume`、加成员的错误码变了、
  遣散人类成员后的补跑丢了）。处置不是回退，而是：
  1. **正典恒取合一前 SQLite 的行为**（它有 13 个套件盯着，PG 侧那条路几乎无覆盖）；
  2. 差异若源自**部署形态**（daemon 是否与 API 同进程）而非数据库，就抽成一个注入端口，两个 bootstrap
     各注入自己的实现——不要在实现里按 provider 分叉；
  3. 合完立刻跑「引用了这些路径的全部测试」（`scripts/tests-referencing.sh`），逐条把红归因成
     「锁的是文件名」还是「锁的是行为」；后者一律按 ①修回去。

  **做法建议**：逐对先出「形态勘察 + 覆盖对比 + 行为差异清单」，按上面三条处置；不要按文件数排优先级。

  ### 乙类：同一判据的两种写法——端口已是异步，卡在**逐对的语义判断**上

  （初稿把这一类记成「同步宿主对」，逐对量过之后更正：`RuntimeSessionLeaseOperations`（9 个方法全
  `Promise`）、`HumanGateTaskLifecyclePersistence`（3 个全 `Promise`）等的**端口契约本来就是全异步**，
  SQLite 只是内部用 `dbTxSync` 实现——调用方能 await，所以它们和 D14–D18 一样**没有宿主阻塞**。）

  真正卡住的是**逐对的语义判断**，各不相同，必须一对一看清再动：
  - **事务隔离级别**：PG 侧的 `withPostgresqlSerializableTaskExecution`（SERIALIZABLE + 40001 重试）
    与中立的 `withTaskExecutionWrite`（`databaseSessionFor(db).transaction`，PG 上是 READ COMMITTED）
    不是同一条路。中立模块的注释论证过「owner 围栏本身是 owner 行上的条件 UPDATE，行锁已把同一任务的
    写手串起来」，但**每一对都要单独确认它没有跨行不变量**才能降级。

    **`RuntimeSessionLeaseOperations` 的答案已经取证（结论：可以降级）**：
    - 七个操作只碰 `runtime_session_leases` 与 `node_runs` 两张表；
    - 每一处写入要么是主键作用域的 insert，要么带身份 + 状态谓词的 CAS
      （`protocol` / `sessionId` / `leaseNodeRunId` / `leaseNonceDigest` / `resetPending` / `status`）；
    - 唯一的「先查后写」竞态在 `claimNew`：租约表主键是 `(protocol, sessionId)`，而代码里**本来就有**
      `if (constraintViolation(error)) fail('owner-conflict')` —— 也就是说它防重复认领靠的是主键 +
      显式冲突映射，**不是靠 SERIALIZABLE**。
    - 因此这一对可以按 D14–D18 同法合并（PG 异步实现改名成中立实现、SQLite 装配切过去），
      **唯一要补的验收**：两引擎各跑一条并发 `claimNew`，断言恰好一个成功、另一个是 `owner-conflict`。

  - **同步 / 异步的闭包冻结**：`TaskExecutionResourceSnapshots` 的 SQLite 侧走
    `freezeTaskExecutionCallClosureSync`、PG 侧走 `...Async`，application 层同时留着两份冻结器；
    合一要先确认异步那份能覆盖同步那份的所有调用点。
  - **真同步宿主**：只有 Intent 上下文授权那半是货真价实的——Intent 宿主在 SQLite 上确实跑在
    `dbTxSync` 回调里（D20 已把异步半合掉、同步半按债保留）。

  **共同的机会（已清 ✅ D21）**：`assertPostgresqlTaskOwnerTx` 与中立的 `assertTaskOwnerTx` 又是一对
  **逐字重复**（归一化后逐字相等，与 D19a 去重掉的 `assertPostgresqlTaskOwnerlessTx` 同形）。
  已删掉 PG 那份定义，三个生产消费方（协作运行时机制 / 运行时会话租约 / 人类闸门）与一个测试改指中立模块；
  owner CAS 围栏至此只有 `ownedTaskExecution.ts` 一处定义。这一条不需要任何语义判断。

## 5. W5 —— 防复辟

- **T19g（D2 新增）** 「迁移后 `sqlite_master` vs 逻辑契约」对账守卫：把 SQLite 迁移跑完后的索引（含部分索引谓词）/ CHECK /
  触发器与 `buildLogicalSchemaContract()` 逐项对拍，差异要么补进 drizzle 声明（PG 随之投影），要么显式登记为 SQLite 专属并写明理由。
  已知差异：`repo_group_nodes` group 挂载 CHECK、`repository_transport_connections` 摘要 / token_hint CHECK（B6 记）。
- **T19h（D2 新增；W18 实施中）** PG 目标的增量迁移：不可变 root、追加 journal/SQL 与精确 upgrade receipts 已实现，先支持新增索引；原复制/备份合同保持，schema 准备发生在业务装配前。真实旧库、多步、SIGKILL 恢复及旧备份恢复已接 hosted 用例，待 exact-SHA 验证，见 §0c 第十八批。

- **T17** provider 命名文件只允许在 `platform/persistence/`（棘轮到 0）。
- **T18** 裸 `db.transaction(` 只允许在事务原语文件。
- **T19** `provider === ` 只允许在 `platform/persistence/`，其余全仓 exact 账本为空。
- **T19b** 组合根全量：`cli/` 与 `*/composition*` 下禁 `*-not-bound` 与晚绑定 holder。
- **T19c** 启动序列恰有一个调用方，`cli/start.ts` 无 provider 执行分支。
- **T19d** 覆盖率对等棘轮（过渡期，可在 W1 后立即上）：同一 port 两侧行覆盖率差超阈值即红。
- **T19f** PG 执行面上禁止模块顶层捕获 `@/db/schema` 的表列（`const X = { …: 表.列 }` / 顶层 `select({...})`
  投影常量）：表是按 provider 投影的 Proxy 门面，顶层捕获会钉死在加载时的 provider 上，PG 侧 bigint mapper 丢失、
  数值列以字符串返回（B4a 实撞，`memoryInjectionReadStore` 老 PG 适配器同病）。守卫扫 `postgresqlExecutionSurface`
  语料，存量逐条改为函数内取列后钉 0。
- **T19e ✅（首版）** `tests/helpers/eachProvider.ts`：`describeEachProvider` harness（design §11.1）——双引擎是
  **缺省**，PG 侧无 URL 即 **fail** 而非 skip（`AW_TEST_PROVIDERS=sqlite` 仅本地显式降级）；
  per-file schema 隔离；body 拿不到 provider 名。存量 816 文件 / 1,882 处 `createInMemoryDb(` 逐 context 迁入。
- **T19f** 守卫「测试不得写死引擎」：harness 之外的 `createInMemoryDb(` 棘轮 1,882 → 0；测试内
  按 provider 分叉须经 `capabilities` 且计数入账。
- **T21b** 执行链取证进 push CI：两个引擎上各起一个任务跑到 done（RFC-349 验收漏掉的那一环）；
  `postgresql-evidence.yml` 的 `prepareSoakDataset` 不再把在飞任务归一成 done。
- **T20** 方言表完备性守卫（语料按类型可达派生，沿用 `tests/architecture/postgresqlSurface.ts`）。
- **T21 ✅（首版，`test-backend-postgresql` 窄 lane 暂留）** **四个 backend 分片各自带 `services: postgres:17`**，PG 半边在每个分片里跑（design §11.2）；
  `test-backend-postgresql` 窄 lane 退役。时长由 per-file schema 并行 + W4 后测试数减半对冲，
  实测写回 proposal §6。按 D5 不打折。
- **T22** 退役 `rfc349-dual-provider-predicate-drift`（对象已消失），退役 `dbTxSync`（**C-1**）。

### W5 落地记录（2026-09-07，`e0be514a3` + `604b0a184`）

16 条守卫一次上线，全部只降不升棘轮 + 变异验证，`tests/architecture/` 571 pass / 0 fail。
账本值全部用 census 的 `ledgerEntryCount` / `corpusFloor` 实算。

| 守卫                      | 账本                                              | 值                |
| ------------------------- | ------------------------------------------------- | ----------------- |
| T17 provider 命名文件位置 | `PROVIDER_NAMED_FILE_DEBT` / `..._DIRECTORY_DEBT` | 136 / 2           |
| T18 裸 `db.transaction(`  | `BARE_TRANSACTION_DEBT`                           | 17                |
| T19 provider 条件分叉     | `PROVIDER_BRANCH_DEBT` / `..._RELOCATION_DEBT`    | 16 / 1            |
| T19b 组合根占位           | `COMPOSITION_ROOT_PLACEHOLDER_DEBT`               | 13                |
| T19c 启动序列             | `PROVIDER_EXECUTION_BRANCH_DEBT`                  | 1                 |
| T19d 覆盖对等             | `COVERAGE_PARITY_LEDGER` / `INVERTED_PAIRS`       | 26 / 6            |
| T19f 测试写死引擎         | `TEST_ENGINE_HARDCODING_DEBT`                     | 821               |
| T19f 顶层捕获表列         | `TOPLEVEL_COLUMN_CAPTURE_DEBT`                    | 8 文件 / 83 处    |
| T19g schema 契约对账      | `SQLITE_ONLY_PROTECTIONS` 等三份                  | 149 / 7 / 4       |
| T20 方言完备性            | `RAW_DIALECT_DEBT` / `UNSHIMMED_FUNCTION_DEBT`    | 12 / 0            |
| W6-T28 读—改—写不加锁     | `READ_MODIFY_WRITE_DEBT`                          | 9 文件 / 20 处    |
| 判据缺口账本（新）        | `DUAL_ENGINE_PREDICATE_GAPS`                      | 17                |
| 成对适配器对拍（新）      | `PROVIDER_PAIR_CONFORMANCE_LEDGER`                | 26 对 / 25 未验证 |
| 组合根被测试构造（新）    | `PROVIDER_RUNTIME_UNEXERCISED`                    | 70 / 102          |
| 死适配器（新）            | `DEAD_PROVIDER_ADAPTER_DEBT`                      | 18                |
| 工件格式可移植性（新）    | `ARTIFACT_FORMAT_PORTABILITY`                     | 12 格真值表       |

**已知缺口**：RFC-317 的中央高水位网按符号名只认 `*_DEBT`，所以 `SQLITE_ONLY_PROTECTIONS`(149)、
`PROVIDER_RUNTIME_UNEXERCISED`(70)、`DUAL_ENGINE_PREDICATE_GAPS`(17)、`COVERAGE_PARITY_LEDGER`(26)
**不在中央网里**——各自文件内有逐字相等断言、并非无人看守，但少了跨守卫统一视图。统一改名进网是独立一刀。

### 计划勘误（本轮实测推翻，动手前先读这一节）

**① T21b 的 `prepareSoakDataset` 断言：字面属实，危害不成立，不要改。**
计划写「它把在飞任务归一成 done」。那两条 UPDATE 确实存在（`tests/helpers/rfc349PostgresqlHostedEvidence.ts:1143-1172`），
但改的是 `scripts/perf-seed.ts` 秒级前刚播的**合成 fixture 行**——唯一调用点紧跟 `daemon.stop()` 之后，
库里没有任何进程跑过的行，那条 lane 也从不起任务，报告里没有一条判据依赖任务状态。
**而且删掉它换不来「在飞状态」**：daemon 一启动，boot recovery 就把同一批行逐行 reap 成 `interrupted`
（weekly 档约 6 万 runs、full 档约 60 万），可能顶穿 300s/600s 的 ready 超时——姊妹脚本
`scripts/rfc338-maintenance-soak.ts:246-251` 已经写过这个理由。

**② T22 前半「`rfc349-dual-provider-predicate-drift` 对象已消失」：不成立，现在不可执行。**
26 对适配器仍在盘上，该守卫今天跑绿（在扫，不是空转），且它自己写着退役条件——「W5-T17 棘轮到 0 时
随之退役」，而 T17 今天是 136 行。**它要等 W4 收敛完才能退役**，不是现在。

**③ T19f「存量逐条改为函数内取列后钉 0」把 0 当成了起点。** 实测上线当天存量就是 83 处 / 8 文件
（RFC-311 列表页投影常量那一轮留下的）。「钉 0」是终点。

### T21b 的正确落点（调研结论，未实施）

push CI 的四个 ubuntu 分片**早就带真 PostgreSQL**（W5-T21 已落），所以这条守卫**一行 YAML 都不用改**——
缺的是一个 `describeEachProvider` 后端集成测试。真正的代价在测试本身：唯一的驱动 harness
`tests/helpers/taskExecutionTestTopology.ts` 整个是 SQLite 硬编码，PG 侧要另攒一份端口束（约 150–250 行）。
而且**全仓今天没有任何测试真的在 PostgreSQL 上跑过执行链**，这条守卫大概率会当场挖出真缺陷——
它是一个 RFC 子任务的体量，不是 CI 接线。

## 5b. W6 —— PostgreSQL 最高性能（design §10）

- **T23 ⛔ 判定为不可行（2026-09-07 实测，见 `tests/rfc359-w6-t23-json-column-storage.test.ts`）**。
  原方案「JSON 列在 PG 上渲染为 JSONB + 热查询列建 GIN」性能上确实最优——同一段取值，5 万行实测
  plpgsql shim 296.6ms → text 列上的原生 `->>` 91.3ms（3.2×）→ **真 jsonb 列 14.6ms（20×）**。
  **但 20× 那一档买不起**：jsonb 是规范化存储，写进去的字节 ≠ 读出来的字节
  （`{"b":1,"a":2, "n":1.0,"e":1e3}` → `{"a": 2, "b": 1, "e": 1000, "n": 1.0}`），而本仓有三类
  **活着的**判据建立在字节保真上：
  ① **逻辑复制的块摘要**——`postgresqlLogicalTarget.assertTargetChunk` 写完一块后**从 PG 回读**
  重算 digest 与源比对，存储层一旦规范化就 `postgresql-target-chunk-mismatch`，整条
  SQLite→PostgreSQL 迁移停住；
  ② **`json-text` 列里合法地存着非法 JSON**——`webhook_deliveries.body_json` 是原始 HTTP 请求体，
  被 `truncateDeliveryBody` 按 256 KiB **裸截断**，jsonb 列根本插不进去；
  ③ **21 处应用层对 JSON 列原文做 hash / 相等比较**（`slot_path_digest` 直接对
  `intent.slot_path_json` 原文取 sha256、`committed_events` 的 payload digest 回读重算、
  `plugins` / `custom_event_source_definitions` 的整行 OCC 把 JSON 列放进 `eq(...)`、
  skill 的 `frontmatterExtra` 决定磁盘 SKILL.md 字节进而决定 contentVersion……）。
  **GIN 随之落空**：`@>` 需要 jsonb 列。顺带把「有没有人要用包含」普查完了——全仓确有 14 处包含
  形状的过滤（`agents.mcp`/`plugins`/`depends_on` 的 `LIKE '%"<id>"%'` 预过滤 + JS 复核，
  `scheduled_tasks.launch_payload` / `workflows.definition` 的全表捞回再按字段过滤），**但全部打在
  资源目录这类几十到几百行的小表上**，量不出代价。所以矩阵**没有**加 `jsonContains`：加一条没有
  可测收益、也没有索引可用的算子，只是给两个引擎各多一份要维护的方言。
  要走 jsonb 这条路，前置是给上面①②③各立一套替代契约（把 `json-text` 拆成
  「字节保真」与「只保 JSON 值」两个 codec），那是另一个 RFC 的量级。
  判据已落成守卫：每个 `json-text` 列在 PG 上必须投影成保字节类型。
- **T24 ✅ 已完成**（`jsonExtract` 半边落地为 `EngineCapabilities.jsonMemberText`）。
  取 JSON 文档顶层成员的字符串值，SQLite 渲染三个内建 JSON 函数（与改造前的查询文本逐字相同）、
  PostgreSQL 渲染 `pg_input_is_valid` 守住的原生 `->` / `->>`（此前走
  `agent_workflow.json_extract` 等 **plpgsql + EXCEPTION 块** shim，每行一个子事务）。
  列表页四处工作组名取值（`baseCtes` 物化列 + 两条快路径 `paged` 投影 + `q` 搜索的派生谓词）
  收敛成一个 `workgroupNameExpression`，RFC-357 时代那句「改一处必须改两处」的纪律不再需要人守。
  **实测（PostgreSQL 17.11，2 万任务 / 95% 有 workgroup_config_json）**：`q` 搜索 160.7ms →
  **78.0ms（2.06×）**；默认视图首页 7.8 → 7.9ms（0.99×，只对返回的 21 行求值，本来就不热）。
  SQLite 侧渲染逐字未变，`rfc311-perf-guards` 两个引擎语句数 / 取回行数 / 参数数全部不变。
  结果等价由 19 格语料对着**改造前的 SQL 原文**逐格对拍（两个引擎各一遍）。
  `jsonContains` / `@>` 按上面 T23 的普查结论**不做**。
- **T25** 批量写：矩阵给出 `batchInsertMax`，逐行 INSERT 的热路径改按批。
- **T26 ✅ 已完成**（W8）。三条计划缺口全部销账，`PLAN_GAPS` 现为空。实测：任务目录
  `facet_attention` loops 10000 → 1、84.053ms（含 JIT 32.419ms）/ 107,042 buf → 22.006ms / 2,098 buf；
  `/api/cached-repos` facets loops 10000×3 → 1、122.262ms（含 JIT 63.606ms）/ 200,820 buf →
  35.214ms / 5,191 buf。整条路径墙钟（50k 语料）：任务目录 99.8 → 27.8ms、仓库页 149.9 → 27.7ms，
  **两条路径的 JIT 编译都消失**（估算代价掉到 `jit_above_cost` 以下，未动任何 JIT 参数）。
  **过程中推翻了本账本自己写的「正解」**：原方案「两个 EXISTS 改成预聚合 UNION + LEFT JOIN」在 PG 上确实快，
  但它把代价从 O(仓库数) 换成 O(任务数)，而生产里任务表大几个数量级——实测 SQLite 侧 **退化 80×**
  （0.2ms → 16.3ms），并当场把 `rfc311-perf-guards` [sqlite] 打红（`SCAN tasks` 裸扫无界表）。
  最终形状是把 `exists` 送回 **WHERE 子句**（两个 planner 都会上提成 semi/anti join）+ 三格互斥标量子查询，
  **让每个引擎各自选计划**：PG 选 hash semi join、SQLite 选索引探，两种表比例下都不退化。
  教训：「PG 上更快」不等于「该这么写」——本 RFC 的判据是**两个引擎都不退化**。
- **T27 ✅ 已完成**。5 个性能守卫（`rfc311-perf-guards` / `rfc311-perf-foundation` /
  `rfc244-task-operations-benchmark` / `rfc311-task-page-fastpath` / `rfc311-task-page-filtered-fastpath`）
  全部走 `describeEachProvider`；`rfc311-perf-guards` 里有真正的**跨引擎对比**——两个引擎各取 P95、
  打印比值作诊断，并带一条 AC-11「塌方探测」断言。注意判据本身已按 RFC-244 的教训从**墙钟**
  换成**取回行数**（墙钟测不出真回归、机器一忙又假红），墙钟仅作诊断基线保留。
- **T28** 写法纪律审计：全仓「读—改—写中间不锁」的形状清单（`READ_MODIFY_WRITE_DEBT`，8 文件 / 19 处）。
  **用户 2026-09-07 裁决：「功能问题就做」。** 判据因此**不是「有没有加锁」，而是「并发能不能
  产出用户可见的错结果」**——丢一次计数、少一行、状态被覆盖，这些是功能缺陷，做；判不可达的
  （调用方本就在同一把写锁内串行 / 单一写者 / 该路径即将退役）写清理由留在账本里，不改。
  实施纪律：**先写双引擎并发用例把错的结果演出来（红），再加 `lockAggregateRoot`（绿）**；
  演不出错结果 ⇒ 该处不可达，回去重判。用能力矩阵的 `lockAggregateRoot`，不得裸写
  `SELECT … FOR UPDATE`（会掉进 T20 的裸方言账本）。
  **勘误（2026-09-07 实测推翻）**：本条原写「19 处里 17 处两个引擎都有 ⇒ 不是 provider 分叉」。
  **那是错的。** 代码形状确实两侧都有，但**缺陷只在 PostgreSQL 上成立**——W8 的变异验证
  6/6 全是「PG 红、SQLite 绿」。原因是 `createSqliteDatabaseSession` 是**进程内单写者租约 +
  `BEGIN IMMEDIATE`**，两笔写事务之间没有任何交错窗口；SQLite 上连**表达**这类时序都不行
  （旁观者语句会被 `CrossContextTransactionError` 当场拦下，用例因此要按 capabilities 分叉）。
  所以 T28 **正中本 RFC 的靶心**：同一份实现搬到另一个引擎才暴雷。
  推论：这类用例的 SQLite 那一遍**不是冗余**——它钉住的正是「换个引擎才炸」这件事本身。
  变异验证时若**只在 PostgreSQL 上红**（SQLite 的 `BEGIN IMMEDIATE` + 写者租约本就全序列化），
  那是结论不是缺陷，要如实记录。
  这类代码在 SQLite 上碰巧正确、在 PG 上是竞态——合一时必须改形状，不能原样搬。

## 5c. W7 —— 成对适配器收尾（并发波次）

**为什么排在 W5/W6 之后**：W4 定的目标是「153 对 → 0」，但当时没有「还剩哪些对、每对验没验过」
的清单，只能凭印象挑。W5 的 `rfc359-w5-provider-pair-conformance` 账本把它变成了**有限、可排期、
带 verified/unverified 状态**的集合——W7 就是照着那张表逐对收。测试文件统一叫 `rfc359-w7-*`。

**做法上的一个前提**：此前合一验证只能串行，因为 PG harness 按文件 `drop schema … cascade`，
两批双引擎测试并行会互相清库（见 `docs/dev-gotchas.md` 那一条）。本波先在同一个容器里开了
8 个隔离库（`awpar1`…`awpar8`），每个作业独占一个，**并行验证才成立**；git index 与
`architecture/*.json` 重采仍然只能串行。

### 已合 11 对（各带 `describeEachProvider` 对拍）

`RealtimeStore` · `ResourceLimitPersistence` · `ClarifyDirectiveStore` · `ReviewRepairParticipant` ·
`ClarifyRepairParticipant` · `TerminalMaintenancePersistence` · `IntentSqlProgramRunner` ·
`IntentPersistence` · `platform/events/committed/Persistence` · `CollaborationRouteOperations` ·
`CollaborationRuntimeMechanics`。

**净退役 4960 行**（删 6902 / 新建 1942），同时新增 **20 个双引擎对拍文件 / 10281 行**。
最能说明形态的一组：`collaborationRouteOperations.ts` 用 **149 行**替代了 2269+116 行，
`collaborationRuntimeMechanics.ts` 用 **99 行**替代 1746+81 行——因为 PG 那两份「原生重写」重写的，
正是 SQLite 薄壳早已转发过去的同一台机器。

**「先补对拍、再合一」这条又一次被证明是对的**（D23c/D25/D26 之后第四次）——纸面判成
「零分叉」的对，一跑对拍就照出真差异：

- **`ClarifyDirectiveStore`：PG 侧的裸 `db.transaction` 不可重入。** 外层显式事务里调 `store.set`，
  外层回滚后 SQLite 侧 0 行（写被一起回滚）、**PG 侧 1 行**（另开连接独立提交，外层带不走）；
  外层事务还开着时独立连接就已经能看到那笔写。合一后两侧都可重入，这条已锁进对拍。
- **`TerminalMaintenancePersistence`：PG 侧有两处更强，按强侧抬齐。**
  ① 并发 claim 的错误分类（PG 捕 `23505` → `task-terminal-maintenance-conflict`，SQLite 侧让裸
  `SQLITE_CONSTRAINT_UNIQUE` 冒泡）——中立实现改走能力矩阵的 `classifyError`；
  ② `snapshotTree` 的原子性（PG 把递归枚举 + 快照放同一笔 SERIALIZABLE，SQLite 分两笔 ⇒ 枚举与
  快照不原子）——中立实现只保留单事务形态，子树枚举用迭代 BFS 替掉两方言不通用的 `WITH RECURSIVE`。
  两条都做了变异验证。
- **两个 repair participant 的事务包裹没有语义依据**：`unapprove` 在 SQLite 侧包、PG 侧不包，
  `reopen` 反过来。合一按**语句形态**裁定（读改写序列包、单条 CAS UPDATE 不包），
  理由写进头注释——而不是「保留原样」。
- **`IntentSqlProgramRunner` 的 `get` 陷阱**：详见 `docs/dev-gotchas.md` 新增的那一条。
  纸面上「以 PG 为正典」会让 SQLite 上每个具名字段静默变 `undefined`。

### 判定为**不该合**的对：从 3 对增到 7 对

成对账本上「同名两份实现」并不等于「重复实现」。逐方法核对后判定**不合**的，本波又加两对——
合一会把一侧的缺口伪装成完成：

| 对                                | 为什么不合                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LogicalSource` / `LogicalTarget` | 漂移检测与目标端口物理绑定引擎                                                                                                                                                                                                                                                                                                                                                      |
| `TaskLifecycleAutoRepairCommand`  | PG 侧只实现了 14 个规则族中的 1 个                                                                                                                                                                                                                                                                                                                                                  |
| `IntentApplyArtifactLifecycle`    | **两套不同的恢复设计**：SQLite 重放 `skill_operations` 账，PG 从 `skills`/`skill_versions` 行 + 目录哈希重新推导。两侧写路径只产出各自那一套事实，换一侧跑就无据可依。日志工件词汇也不互通（同一列 `intent_apply_journal.prepared_artifacts_json`：`opId`/`skillDir` vs `operationId`/`stagingDirectory`，信封一个带 `{version,artifacts}` 一个是裸数组），而解码器是 `.strict()`。 |
| `IntentApplyOperations`           | 骨架同构，但挂的是**两套资源会话协议**（提交期句柄、提交后前滚、资源侧中止的形状都不同），合它等于先合 resource-catalog 的两套 apply 栈。                                                                                                                                                                                                                                           |
| `TaskRouteOperations`             | **两台执行引擎**（见下「挑对的先验」）：SQLite 侧带模块级可变全局 + 2 处 `dbTxSync` + 自驱进程内 scheduler，PG 侧一律委托端口 + serializable 事务 + 已提交事件出站。合一的前置是 `services/task.ts` 的调度耦合与同步事务面——正是本节记的结构性阻塞。                                                                                                                                |
| `TaskRouteLaunchOperations`       | 1362 行里只有 47 行与那 92 行壳对位，其余是别的端口借住同一文件；真正要合的是它背后的启动机器。                                                                                                                                                                                                                                                                                     |

**「不合」不等于「不管」**：这两对各配了一份双引擎对拍（共 1182 行），A 段锁两侧真正同义的
共同子集、B 段锁实测分叉，并做了变异验证——其中一次专门变异「照 PG 那侧合一」，确认对拍会拦住。
成对账本上它们从 `unverified` 翻成 `verified by`，但 `PROVIDER_PAIR_COUNT` **不减**：
仍是两份实现，只是从此有守卫看着。

### 「不能合」与「一侧更弱」是两件事，要分开处置

同一轮对拍在这两对上还照出三条**与合不合无关**的「一个好一个不好」，已单独立刀抬齐：
① 提交后前滚未完成时 SQLite 丢掉 `rollForward` 的返回值（那一行看上去干净，要等 boot/hourly
才发现）；② `intent-left-retryable` 诊断词汇只有 SQLite 记，运维在 PG 部署上 grep 不到同一类失败；
③ `plugin-install` 前滚的插件存在性判定只有 PG 做，SQLite 上「插件其实没装成」永远发现不了。

### 挑对的先验：**薄壳只说明「真实现在别处」，不说明「PG 抄了它」**

成对适配器里 SQLite 侧常常只有几十行。本波量了所有对的 `postgresql/sqlite` 行数比，
高比值确实高度对应「PG 把 SQLite 早已转发过去的那台机器又抄了一遍」——合掉后中立实现极短：

| 比值 | sqlite → postgresql                                   | 合一后              |
| ---- | ----------------------------------------------------- | ------------------- |
| 7.0  | 292 → 2048（`CollaborationRouteOperations` 是同形态） | **149 行**替代 2385 |
| —    | 81 → 1746（`CollaborationRuntimeMechanics`）          | **99 行**替代 1827  |
| —    | 41 → 363（已提交事件出站存储）                        | 净退役 390 行       |

**但这条先验必须修正一次，否则会误判**：`TaskLifecycleAutoRepairCommand` 比值 3.0（65 → 198）
同样是薄壳，却是判定**不该合**的那一对——SQLite 的真能力在 `taskLifecycleRepair/options-*.ts`
（14 个规则族），PG 那 198 行只实现了 **1 个**。照「薄壳 = 抄写」硬合，会把 13 个规则族的缺口
伪装成完工。

**正确用法**：薄壳 ⇒ 先找到它转发去的那台机器，拿**机器**去比 PG 那份，然后才分得清
「PG 抄了同一台机器」（纯重复，合）还是「PG 另建了一个部分替代品」（能力缺口，不合）。

**再修正一次（task-route 两对实测）：薄壳可能转发到「好几个横向层」，不是一台机器。**
`sqliteTaskRouteOperations.ts` 292 行看着比值 7.0，但它转发到**四处**——`services/task.ts`
（读面 ~1220 + 命令面 ~2030）、`services/taskDelete.ts`(399)、
`legacySqliteTaskCollab.ts`(516)、`taskLifecycleRepair.ts`(513)，**合计约 4700 行**，
对面是 `postgresqlTaskRouteOperations.ts`(2048) + `postgresqlTaskRouteRepairOperations.ts`(1448)
约 3500 行。**不是「壳 + 机器被抄」，是两台执行引擎**：SQLite 侧带模块级可变全局、2 处
`dbTxSync`、并自己驱动进程内 scheduler；PG 侧一律委托三个端口 + `withPostgresqlSerializableTaskExecution`

- 已提交事件出站。

**另一个陷阱：对面那个大文件里可能大部分不属于这个端口。** `postgresqlTaskRouteLaunchOperations.ts`
1362 行里**只有 47 行**站在 92 行壳对面，其余是别的端口借住在同一文件
（`createRootLaunch` 287 / `createPostgresqlTaskLaunchArms` 236 / 启动参与者 110 / 接口与快照构造 ~640）。

**所以量比值只能用来排优先级，不能用来下判定。** 判定必须做两件事：
① 把薄壳的**全部**转发目标找齐并求和；② 把对面文件按端口**分区段**，只比属于该端口的那部分。
本波已合的对里，`platform/events/committed/` 就是靠②才发现「802 行里只有一半服务这个端口」。

另一端也有信号：**比值接近 1 的对（两侧各自长出同样体量的代码）与「已判定不合」高度重合**
——`LogicalSource` 1.1、`SourceTerminationParticipant` 1.0、`TaskExecutionRuntimeParticipants` 1.2、
`ResourcePackageMaintenance` 1.3。同等体量通常意味着它们真的在做不同的事。

### 本波暴露的两个结构性阻塞

1. **`sqliteTerminalMaintenance.ts`（519 行 / 5 处 `dbTxSync`）删不掉**——`services/taskArchive.ts`
   `services/taskDelete.ts` `platform/persistence/sqlite/systemWorkspaceGc.ts` 三处要的是**同步端口
   独有**的 `assertClaimTx` / `transitionTx`，中立参与者是 async、进不了 `dbTxSync`。
   **同步事务面是死代码清理的前置**，不只是「以后再说的债」。
   三处的级联深度都很浅（两处外层已 async、一处只差一级），按 §「D28b 的可做判据」是最易的一类。
2. **`clarify_rounds` 的 `kind` / `status` CHECK 在 PG 上不存在**（实测：同一行 SQLite 拒、PG 收）。
   这与 W5-T19g 的 `SQLITE_ONLY_PROTECTIONS` 账本是同一件事的两次独立发现，
   佐证那 149 条不是纸面差异。

## 5d. W8 —— 一条必须挂在所有 `pre_snapshot` 类判据上的折扣（2026-09-07 实测）

W8 有三条分叉判据建立在**节点重试时按 `pre_snapshot` 回滚工作树**这条路径上
（retry 的快照丢失升级、syncWorkflow 的 canceled 档回滚、canceled wrapper 的原地复活）。
它们的代码路径是活的、判据也是对的，但**"用户可见"要打一个折扣，必须写明**：

**`pre_snapshot` / `pre_snapshot_repos_json` 今天没有任何写入方。** RFC-130 删掉了写入——
`modules/task-execution/composition/nodeMechanics.ts:4106-4111` 明写「the RFC-092/098
pre-snapshot … is GONE … columns + rollbackNodeRunWorktrees stay in the schema as
defense-in-depth but are no longer written here」。全 `src` 扫过一遍，其余 `preSnapshot:`
站点全是**继承传递**（`row.preSnapshot` / `latest.preSnapshot`），没有一处算出新 sha 写进去。

因此这三条的「同一操作两个引擎在磁盘上留下不同内容」**只对 pre-RFC-130 的存量行成立**
（或手工种的行）。抬齐仍然要做——路径是活的，哪天恢复写入就会立刻生效，而且判据本身正确；
但**不要把它们当成"当前生产里正在发生的用户可见故障"**去汇报。

**一般规律**：本 RFC 反复用「用户看到什么」作为判据，这很对；但「用户看到什么」的前提是
**这条路径当前真的会被走到**。判定一处分叉的用户可见后果时，要顺带确认它依赖的字段 / 状态
**今天还有没有生产写入方**——否则会把「存量数据上的差异」讲成「现在就在坏」。

### W8 发现的一条 schema 级分叉（未修，须与 T23 同批在安静工作树上做）

`node_runs.continuation_slot_key` / `lineage_slot_path_json` 的**补齐触发器只存在于 SQLite 的
迁移 0210 里，PostgreSQL 上没有**。后果：绕开生产工厂直插 `node_runs` 行时，两个引擎的
`readLineage` 结果不同——SQLite 有触发器兜底，PG 得到 null。

当前生产路径**够不着**（工厂本就显式写这两列，W8 的对拍已改成显式播种），所以不是正在发生的
故障；但它是一条**真正的能力不对等**：SQLite 有一层安全网，PG 没有。哪天有人新写一条忘了写这两列
的插入路径，SQLite 上被兜住、PG 上静默产出 null 行——正是本 RFC 要消灭的形态。

**为什么压后**：修它要动 `db/schema.ts` / 迁移，会开一个全仓 PostgreSQL 迁移历史漂移窗口
（`postgresql-migration-history-drift`，期间**所有** PG 泳道同时假红）。与 W6-T23（JSONB + GIN）
同性质，必须在**没有其他刀在跑**的安静工作树上一次做完并立刻
`bun run db:rfc349-postgresql-schema` 重生成历史。

**✅ 已按②落地（2026-09-07），但上面「当前生产路径够不着」那句话是错的，次序也因此被修正。**

实测推翻的部分：铸行工厂 `buildNodeRunMintRecord` 对 `lineageSlotPathJson` 的默认值是
`overrides ?? inherited ?? null`，而**全 `src` 没有任何调用点传 `overrides.lineageSlotPathJson`**
——所以任务的**首个** node_run 一定命中 NULL 分支，触发器在生产路径上是**活的**：

```
[sqlite]      n1  lineage=[{root…},{"n1"…}]   n2  lineage=[{root…},{"n2"…}]
[postgresql]  n1  lineage=null                n2  lineage=null
```

下游按 `run?.lineageSlotPathJson ?? intent.slotPathJson ?? task.lineageSlotPathJson ?? '[]'` 回落，
于是 **PostgreSQL 上同一任务的不同节点回落到同一条任务级路径**，effect 的 `slot_path_digest`
在节点之间撞车；SQLite 上它们各不相同。（W8 判成「够不着」是因为 AST 清点只认**对象字面量**的
插入点，而这两个铸行点写的是 `.values(变量)` —— 得去看构造那个变量的工厂。）

于是②的次序必须反过来：**先让工厂显式写，触发器这才真的冗余，然后才能删**。直接删会把 SQLite
拉平到 PG 的坏值。实际落地：

1. 推导搬进 `application/buildNodeRunMintRecord.ts` 的 `nodeRunLineageColumns`（两个引擎共用一份，
   帧键 `"<iteration>|<shardKey 或空串>"` 与被退役的触发器逐字对齐；编码走领域的
   `encodeLineageSlotPath`，即 canonical JSON——同一个值、规范化的字节）；
2. 两个铸行适配器（async 中立版 + 尚未退役的 SQLite 同步孪生）显式写这两列；
3. 迁移 `0224_rfc359_node_run_lineage_explicit.sql` 删掉触发器；
4. 守卫 `tests/architecture/rfc359-w6-node-run-insert-lineage-completeness.test.ts` 接替它
   （与 W7 那条同形，另多一步「解一层局部 `const`」，因为这两个插入点写的是 `.values(变量)`）；
5. 双引擎对拍 `tests/rfc359-w6-node-run-lineage-parity.test.ts`：同一次铸造两侧逐字节相同，
   并断言 SQLite 上那个触发器确实已经没了（否则①证明不了任何事）。

`SQLITE_ONLY_PROTECTIONS` 的 M4 段随之从 8 条降到 7 条，并把「这三个触发器的触发条件在任何生产
路径上都不成立」这句勘误写在原处。`tasks` 上的同名触发器**不动**——那四个插入点确实都显式写了三列。

### W8 交接：两条「该合但今天不该合」的对，各有确切阻塞点

**`ResourcePackageMaintenance` 的 `JournalPort`——几乎逐字重复，但合一不是白送。**
`list()` 11 行两侧逐字相同，`settleFailed` 的差别只在事务包装——而**那层包装不是冗余**：
SQLite 的 `dbTxSync` 兜的是 `foreignExplicitTransactionOpen`（`db/txSync.ts:34-38`：bun:sqlite
单连接下，一笔裸写会**静默落进别人的显式事务**并随它一起回滚）；PG 每笔事务独占预留连接，
不存在这个形态。合一要走中立事务原语，那会给 PG 再套一层 BEGIN/COMMIT，并改动
`rfc349-dual-provider-behavior-oracle.test.ts` 里脚本化的语句流水。
**结论**：合一应跟着同模块 `ArtifactRecoveryPort` 的桥接**一起做**，不要单独动。
（`ArtifactRecoveryPort` 本身是机制本质不同——两套互不认识的落盘工件格式，已由
`rfc359-w5-artifact-format-portability.test.ts` 的 12 格矩阵钉住，不重复造对拍。）

**`LogicalSource`——读出面该合，冻结围栏不该合。**
读出引擎 267 vs 283 行、近 1:1，`readChunk` 的 limit 上下界 / cursor 校验 / `encodeLogicalRow`
出口是同一份逻辑写了两遍。但**冻结围栏是两台机器**：SQLite 用 `PRAGMA data_version` /
`page_count` / 文件字节做**文件级代号**，PG 用 `database_generations` 活跃代 + `REPEATABLE READ`
快照。这一半按能力差异入账，不合。
注：那 432 行的 `sqliteLogicalSourceProtocol/Worker/WorkerSupervisor` 是 Worker **传输层**
（postMessage 协议 + 监督器），**不是「真实现在别处」**——薄壳求和时别把它算成隐藏实现。

**一个留给合一那一刀的活标本**：`sqliteResourcePackageMaintenance.ts:201-205` 读
`skillOperations` **漏了 `await`**。今天无害（drizzle bun-sqlite 的 `.get()` 是同步的），
但一旦这段被合成中立实现，PG 上 `operation` 会是一个 Promise、`operation?.active === 1`
**恒为 false**，于是静默改走告警分支。合一时先修它。

### 一条排序规则的守卫盲区（W8 实测，我的判断被推翻）

原以为「DDL 里的 `COLLATE "C"` 掉了会让两引擎行顺序不同」——**那一层掉不了**：
实测注释掉 `postgresqlSchema.ts:79` 之后，`verifyPostgresqlMigrationHistory` 在迁移器里就抛
`postgresql-migration-history-drift`，schema 根本建不起来。

**真正没人守的是另一半**：`postgresqlLogicalSource.readChunk` 里 **`ORDER BY` 子句自己**的排序规则。
把它换成 locale 排序（列的 DDL 排序规则不变），于是 `WHERE (key) > (cursor)` 按 C 比较、
`ORDER BY` 按 locale 比较——**两个比较用了不同规则**，keyset 分页当场**漏一行、重一行**
（实测：`w8src-punct` 整行消失、`w8srcalower` 重复两次）。

一般规律：**keyset 分页的正确性依赖「游标比较」与「排序」用同一套规则**，而这两处在源码里
往往相隔很远、由不同的东西决定（一个在列 DDL，一个在查询文本）。守住其中一处不等于守住这件事。

### T17 的「provider 命名文件」数**不等于**实现分叉数——很大一部分是命名债（W9 实测）

W9 逐个核过 collaboration 的 12 个条目：**只有 1 个名副其实**。8 个是**误名**——它们早就跑在
`ProviderNeutralDatabase` / `databaseSessionFor` 上，PG daemon 今天就在用；其中
`collaborationRouteOperations.ts:14-15` 的注释自己写着「正典是被转发的那批实现…它们的写事务
已经全部跑在中立原语上」。另 2 个是真 PG 侧产物（1 死代码、1 真成对），1 个是纯转发器。

**推论（读这本账本时必须带上）**：

- `PROVIDER_NAMED_FILE_DEBT` 的计数是**按文件名**的，它同时装着两类完全不同的债——
  **实现分叉**（两份实现会漂，是 RFC-359 的靶心）与**命名债**（一份中立实现顶着旧名字，零行为风险）。
  把这个数当成「还剩多少处分叉」会**高估**，把它当成「还剩多少工作量」会**低估**（改名很便宜）。
- 反过来，**「独苗」这个标签本身会骗人**：W9 另一处实测发现 `PackageSkillTree` 这一对，
  SQLite 侧叫 `sqlitePackageSkillTree.ts`、PG 那半**藏在 `postgresqlResourcePackageArtifacts.ts`
  里的一个函数**——两侧不同名、不同文件，于是 T17 的成对判据与 pair 账本的「同目录同名」判据
  **同时看不见它**，它只以一个「独苗」的面目出现。而它有 **5 条用户可见的行为差**。
  **看到独苗要去找孪生，孪生可能藏在别人的文件里。**

**下一步建议**：把纯改名单独做一刀（零行为改动），一次性重采账本。混在功能刀里做会牵动
5–7 份 architecture ledger、把改名的 diff 淹没在行为改动里，review 不动。

## 5e. T17 那 88 条的构成实测（2026-09-08，`1b5e74339`）——**未登记的成对实现已经是 0**

把 `PROVIDER_NAMED_FILE_DEBT`（88 条）逐条与 `PROVIDER_PAIR_CONFORMANCE_LEDGER`（10 对）交叉比对，
再对剩下的每一条查同目录同词干的孪生是否存在，结果是：

| 分类                    | 条数   | 含义                                                                                                         |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| 属于 9 对已登记机制分叉 | **18** | 各带双引擎对拍 + 逐条裁决；第 10 对 `LogicalSource` 本就在 `platform/persistence/` 下，不在 AC-12 第三款范围 |
| 未登记、**有**孪生      | **0**  | ——                                                                                                           |
| 未登记、**无**孪生      | **70** | 每一条都是那件事的**唯一实现**，provider 前缀纯属历史：命名债或死码                                          |

**这条数据的分量**：RFC-359 要消灭的是「同一件事两份实现会漂」。按成对账本的口径，
**全仓已不存在任何一对未登记的 provider 专属实现**——每个 provider 命名文件要么是登记在册、
裁决过、有对拍见证的机制分叉，要么根本没有对手方。用户那条硬要求（「不允许再出现两种数据库
一个好一个不好的分支」）在结构上已经达成，剩下的 70 条是**名不副实**，不是分叉。

**因此 Cut F（T17 收尾）是纯机械刀**：改名 + 删死码，不含裁决。但它必须在**安静工作树**上做——
改名要同时动 5–7 本架构账本（多本按文件名 / 符号名取语料）并配一次普查重采。

**口径的已知盲区（必须写明，别把上面的 0 读成绝对）**：成对账本按**同目录同词干**认对，
于是两类孪生它看不见——
① **同名不同文件**：`terminalizeTaskExecutionIntentsTx` 在 `effectQuiescence.ts` 里有第三份逐字节
相同的同名导出，T17（按文件名）与成对账本（按同目录同词干）**同时失明**；
② **孪生根本不是文件**：六个 PG 文件的对手方是 `src/cli/start.ts` / `services/task.ts` 里的
**内联对象字面量**。
这两类只能靠逐刀排查照出来，不是这个口径能覆盖的。**引用上面那个 0 时要连这段一起引。**

## 5f. AC-3 收口：裸驱动事务已归零，账本剩的 27 是**守卫过度匹配**（2026-09-08 实测）

W11 Cut G 把最后 4 处真·裸驱动事务转成中立原语
（`postgresqlIntentApplyOperations.ts` ×2、`postgresqlResourcePackageAtomicApply.ts` ×2）。
账本 `BARE_TRANSACTION_DEBT` 因此 31 → 27，**剩下的 27 全在 `intentSqlPersistence.ts` 一个文件里**。

**那 27 处不是债。** 它们的形状是 `this.runner.transaction(function* () { … })`——基于生成器的
intent SQL 程序运行器，而 `runner.transaction` 内部调的正是
`databaseSessionFor(this.db).transaction(...)`（`intentSqlProgramRunner.ts:85` / `:117`）。
也就是说它们**本来就走中立原语**，只是低一层。

**守卫超出了它自己声明的判据**：`rfc359-w5-t18-bare-transaction.test.ts` 的头注释写明它锁的是
「`db.transaction(` / `this.db.transaction(` / `dependencies.db.transaction(` 这些裸形态」，
而 `this.runner.transaction(` 不在其中——正则把任意接收者的 `.transaction(` 都数了进来。

**顺带订正一条过期裁决**：账本原注释称 `IntentSqlProgramRunner` 有
`SqliteIntentSqlProgramRunner`（走 `dbTxSync`）与 `PostgresqlIntentSqlProgramRunner`（走裸事务）
两份实现。**那两个文件在 W7 就被合并了**，现存两个类都调中立原语。注释已就地订正。

**处置（未做，记为收口项）**：把守卫的判据从「任意接收者的 `.transaction(`」收紧到
「接收者是**数据库句柄**」——用同文件 AST 找到接收者的声明（属性 / 形参）并看它的类型标注是否
指向数据库类型（`ProviderNeutralDatabase` / `DatabaseClient` / `SqliteRemoteDatabase` 等）。
**这不是白名单**（账本正确地拒绝过「白名单 = 空白许可证」），是让谓词与它自己写明的判据一致。
收紧后账本应降到 0，且必须配一条变异验证：手工插一处 `db.transaction(` 仍要红。

**另一条路（不取）**：collapse 掉生成器抽象（49 个 `function*` / 162 个 `yield*` / 44 个程序入口，
约 2845 行重写）。为了让一个正则高兴而做这种规模的重写，代价与收益完全不成比例。

### Cut G 顺带照出的一个真缺口（已修）

PG 侧的 apply **一直缺 `inClaimTxAfterJournal` 测试缝**，而 SQLite 侧从 W9 就有——
于是「认领与四条读判定同生共死」这条不变量**在 PostgreSQL 上此前零可观测面**。已在同位置补上。

**先红后绿的形状与常规相反**（值得记）：基线 8 pass / 4 fail 里，**PG 那半从一开始就是绿的**
（驱动自带事务本就原子），红的是 **SQLite**。此前 W8 的 T28 是反过来的（PG 红 SQLite 绿）。
**结论：别预设哪个引擎会红**——两个方向都真实出现过，取决于缺陷是「弱隔离」还是「同步包装器」。

## 5g. 组合根占位的正解是**词法作用域**，不是「改必填」（2026-09-08 W11 实测，推翻本计划原写法）

本计划此前把「装配未完成占位」的处置一律写成「把可选槽改必填」，并以 `cli/package.ts` 为范例。
W11 实测：**17 处里只有 1 处是可选参数**，其余 16 处是 `let x: T | null = null` 的**模块局部槽**。

两者的成因不同，手法不通用：

- **可选参数**：验证靠 grep 全仓有没有第二个传值点；类型层证据是 TS2345 / TS2739。
- **模块局部槽**：**没有调用点可 grep**。成因是**同一作用域内的循环依赖**（A 的构造要用 B，
  B 的构造要用 A），先用 `null` 占位、之后回填。

**判别式**：环的另一端在不在**同一个函数作用域**里。在，就让闭包直接引用**后面那个 `const`**
——JS 闭包本就允许引用声明在后面的绑定，只要**执行时**已初始化。槽位、回填、throw 三样一起消失。

**这个证明比「改必填」更强**：可空槽位把回填那行删掉，代码**照样编译得过**（只是运行时炸）；
换成词法引用后**根本没有回填可删**，删掉声明就是 **TS2304 `Cannot find name`**。

**代价**：把「A 必须在 B 之后求值」变成了运行时约束，要用一条测试钉住求值顺序
（把引用改成急切求值，应当抛 `ReferenceError: Cannot access 'x' before initialization`）。
注意 `void x` 当探针**没用**——Bun 的 transpiler 会当死代码消掉，必须是一次**真实读取**。

**本波成果**：三个文件 26 → 9。剩下两处不动，因为它们是**跨阶段**的延迟绑定原语、
各有一个消费者在 `cli/start.ts` 里，只改一边会让两个 daemon 的装配形状不一致，比现状更糟。

**顺带记一个守卫洞**：`server.ts` 里有一处 fail-closed 与被账本记着的那处结构完全相同，
但账本不数它——它的消息措辞既不匹配 `marker` 正则也不匹配 `prose` 正则，而 `holder` 通道
也盖不住（那个值是属性不是 `let`）。守卫头注释担心的「改个名就逃逸」**在树里已经是现实**。
凡按**自然语言措辞**取语料的守卫都有这个洞，读它的数字时不要当成全集。

## 5h. AC-11 在**轻端点**上唯一的杠杆是往返数，不是查询本身（W56 / W57 实测）

取证泳道反复给出同一个形状：几个徽标类轻端点在 PostgreSQL 上比 SQLite 慢，而**差值不随行数
放大**。逐条查下来根因一致——它们不是「一条查询在 PG 上更慢」，而是**发了不止一条语句**：
每一段在 SQLite 上是进程内调用（~0μs），在 PG 上是一次真实网络 RTT。查询再怎么调，也调不掉
一次 TCP 往返。

已折叠两条（各带一条**双引擎往返数预算**判据，先在旧实现上验红）：

| 端点 | 折叠前 | 折叠后 | 实测 P95（SQLite / PG） |
| --- | --- | --- | --- |
| `GET /api/reviews/pending-count` | 3 条串行往返 + JS 归并计数 | 1 条 `count(*)` | 1.80 / 7.33ms |
| `GET /api/clarify/pending-count` | `tasks:read:all` 1 条；**其余所有人** 2+ 条（taskId 全捞 → `visibleTaskIds` 再问一次，内部还按 `sqlChunk` 分块） | 两条分支都 1 条 `count(*)` | 1.58 / 3.46ms |

两条的共同点值得单独记：

- **数字一直是对的**，所以既有对拍（`rfc311-badge-counts`）一直绿——它比的是**数字**，比不出
  **语句数**。RFC-311 那两份文件的头注释至今写着「the 15s inbox badge as ONE indexed count(*)」，
  对 admin 成立、对普通用户不成立，而没有任何判据看得见这件事。新判据钉的是
  `recording.statements.length === 1` 且首条含 `count(`，确定性、可进每次 PR。
- **可见性谓词必须以「片段」形态存在**才折得掉那次往返：`visibleTaskIds` 的姿势是「先把 taskId
  捞出来、再问一次可见性」。拿到片段的调用方把它 AND 进自己那一条语句即可，且 `visibleTaskIds`
  自己也调同一个函数，两条路不可能漂。片段的落位判据见 `src/db/query.ts` 头注。
- **顺带削了一条跨上下文边**：clarify 折叠后不再需要
  `collaboration → task-execution/infrastructure/taskAuthorization` 的内部 import，
  `architecture/cross-context-imports.json` 少一条。

### 折叠时发现的一条：孤儿轮次在两个引擎上都不可达

`countAwaitingClarifyRounds` 里有两条按「clarify_rounds 有行、tasks 没有对应行」写的分支
（`or(isNull(tasks.id), …)` 与受限分支的 `isNotNull(tasks.id)`）。实测
**两个引擎都强制 `clarify_rounds.task_id → tasks.id` 外键**（SQLite `SQLITE_CONSTRAINT_FOREIGNKEY`
errno 787 / PG `23503`），所以那个状态根本进不去，两条分支是死代码。

处置：**逐字保留**（折叠往返不顺手改语义），但给「不可达」这个前提补一条双引擎判据——
外键哪天失效，孤儿状态变可达，那两条分支就从死代码变成活语义，而它们此刻没有任何行为覆盖。

### 杠杆的边界：只对**串行**往返成立（W57 实测，推翻我自己的第一判断）

上面两条能折出效果，是因为它们是**串行** `await`——一段等完才发下一段，N 段就是 N × RTT。
`GET /api/overview` 看起来是同一类（PG 侧 13 条语句），但它不是：六个 ACL 计数走
`Promise.all`，而 `poolMax` 缺省 **16**（`shared/src/schemas/config.ts:51`），六条查询各占一条
连接**同时**发出，墙钟本来就只有 ~1 个 RTT。

我按「同一个杠杆」把六条折成了一条（每维一个标量子查询拼成一条 `select`），语句数
**13 → 8**，而 P95 **3.24ms → 3.17ms**——在噪声里。于是**整刀回退**：它买不到当初立项要买的
东西，却要付出一条裸 SQL 路径（`db.all(sql…)` 取代类型化 builder）、resource-catalog
infrastructure 多一条指向 `platform/persistence` 的边（为了 `numericFromRawRow`）、以及两条
账本条目。「6 条查询变 1 条能省服务端功」是另一个论点，但那不是本次要买的东西，也没量过。

**给下一刀的判据**：动手折之前先分清这几条往返是**串行**还是**并发**——
`await a; await b;` 是前者（折叠有效），`Promise.all([a, b])` + 足够的 poolMax 是后者（折叠只减
语句数，不减墙钟）。分不清就先量，别按形状下结论。

### 还没折的

`GET /api/overview` 的 P95 差值（1.11 / 3.17ms）**不是往返数问题**——它并发发满了。剩下的
差值是 PG 相对 SQLite 的固有单次 RTT，属于「进程外数据库」的属性，不是这个端点的写法问题。

## 5i. `/api/overview` 曾是一引擎一份实现——**已收成一份**（W57）

`tests/helpers/productionOverview.ts` 里有一条 `if (isPostgresql(db))` 硬分叉，而
`rfc311-perf-guards.test.ts` 还用 AST 断言把这条分叉**钉住**（它当时的意图是「性能用例要走各
provider 的真实生产入口」，合理；但副作用是把分叉写进了守卫）：

- **SQLite** → `platform/persistence/sqlite/systemOverviewReadModel.ts::buildOverview`（`server.ts:2077` 装配）
- **PostgreSQL** → `modules/system-operations/application/overview.ts::composeSystemOverviewQuery`（`cli/postgresqlDaemonApplication.ts:1795` 装配）

**逐个聚合键对过，两套语义等价**（所以这是纯重复，不是「一好一坏」）：

| 聚合键 | SQLite `buildOverview` | PG `composeSystemOverviewQuery` | 判定 |
| --- | --- | --- | --- |
| 六类 ACL 资源计数 | `countAclResource` + `visibleRowsCondition` + builtin 排除 + `<res>:read` 门 | `createResourceCatalogOverviewCountPort.countVisible`——同一个 `visibleRowsCondition`（`resourceVisibility.ts` 唯一一份）、同样的 builtin 排除与权限门 | 等价 |
| repos | 门控 `countCachedRepositories()` | 同 | 等价 |
| scheduled | 内联 count，owner ∨ grant 子查询 | `scheduledTaskPersistence.countVisible`——**与内联那段逐字相同** | 等价 |
| memories | `list({status:'approved'})` + `filterVisible` + `.length` | 同 | 等价 |
| tasks | `buildTaskStats` | `taskOverviewQuery.load` + 调用方侧 null 门（`load` 内的零值分支从该调用方够不着） | 等价 |
| generatedAt / in-flight 合流 | 同形 | 同形 | 等价 |

**已落地**（本节其余内容保留为取证记录）。实际动作与取证时的判断一致，另加四件当时没预见到的：

1. **端口的 authority→actor 反查一并删掉**。`ResourceCatalogOverviewQuery.load` 原先收
   `ResourceRequestContext`，唯一实现拿到它之后做的唯一一件事是用一张**调用方填的**
   `WeakMap<authority, Actor>` 反查回请求者——而计数本来就只认请求者。代价是每个装配根抄一份
   「填 map + 包一层 execute」的胶水（daemon 一份、性能 helper 两份），漏填就是运行时
   `foreign-overview-authority`。现在直接收 `ResourceAclActorProjection`。
   ⚠️ 第一版我写的是收 `Actor`，被 `rfc345-resource-catalog-contracts` 判红且**判得对**：
   资源目录的公共面刻意不依赖 identity-access 的 `Actor`；正解是用本模块自己的闭合投影。
2. **legacy 层不得直接 import 模块的 application 层**（`rfc317-module-boundary` R1）。
   新建 `modules/system-operations/composition/overview.ts` 作为装配缝，与
   `task-execution/composition/taskOverview.ts` 同形；`server.ts` 从那里取。
3. **`system-operations/public/queries.ts` 对 `TaskOverviewQuery` 的兼容再导出退役**：它唯一的
   跨模块消费者就是被删掉的 `services/overview.ts`，归零后 `rfc294-review-public-consumer-ledger`
   判红。聚合体改从真正的 owner（task-execution public）取合同，off-DAG 债务边随之从 public 层
   挪到 application 层（同一个 bounded-context 对、同一个清偿波次，条目数不变）。
4. **`rfc311-perf-guards` 那条 AST 断言翻了向**：从「钉住分叉的形状」改成「断言没有分叉」，
   并把判据从**全文文本**改成 **AST 标识符**——文本匹配会把讲述历史的注释也算成命中
   （我的新头注释里写了 `isPostgresql`，第一版守卫当场自噬）。

净删 316 行；`architecture/cross-context-imports.json` 与 `facades.json` 各少一条；
`rfc345-resource-acl-facade-compatibility` 账本 41→40。

**目标形态**：留 `composeSystemOverviewQuery` 一份，SQLite 侧装同样的五个端口
（`composePostgresqlResourceCatalogOverviewQuery` 内部早已是中立的——计数端口收
`ProviderNeutralDatabase`，只有形参类型标注写着 `PostgresqlDatabaseClient`；
`composeSqliteScheduledTaskRuntime` 也已存在），删 `buildOverview`，
`runProductionOverview` 的分叉一并删，并把 `rfc311-perf-guards` 那条 AST 断言**从「钉住分叉」
翻成「断言没有分叉」**。

**已知阻塞（装配顺序）**：`overviewQuery` 在 `composeSqliteApplicationDeps`（server.ts:2077）就要造出来，
而它需要的 `scheduledTaskRuntime.overview` 要到 `composeSqliteApiRouteMounts`（server.ts:2592）才装配。
正解是把 overview 的装配挪到依赖齐备的那一层，**不是**留一个后填的槽——按 §5g 的结论，
组合根占位的正解是词法作用域。

**安全网（已用上）**：`rfc190-overview-route.test.ts` 的 oracle 逐 actor 断言「概览计数 ===
同一 actor 在对应列表端点拿到的行数」。它已改成打合成后的查询，**一次就绿**（195 条断言）——
这正是「两份实现语义等价」这个判断的直接验证。

⚠️ **对 `b3162f6c8` 提交信息末尾那段归因的更正**：那里写「合跑红是既有的进程级泄漏
（`db/providerSchema.ts` 的 `activeProvider`）」——**不准确**。真正的原因是本地命令漏了
`--isolate`（CI 的 backend 分片跑的是 `bun test --isolate --randomize --seed=… --shard=N/M`）。
不带它，bun 把多个文件放进同一进程并发跑，进程级全局态互相踩；而被我看到的那 7 条
`rfc190` 失败其实来自**另一条**机制——`rfc305-architecture-lock` 的 `resetRouteMetaRegistry()`
清掉了并发跑着的 `createApp` 的路由注册表。加上 `--isolate` 后**同样 33 个文件 396 pass /
0 fail**，一条不红。判据与规矩已落 `docs/dev-gotchas.md`。

**仍欠的一格（AC-6）**：这条 oracle 目前还是 SQLite 单引擎（它经 `createApp` 起真 HTTP 应用，
`describeEachProvider` 化要先解决 app 装配的 provider 参数化）。留作 AC-6 的待办。

## 5j. 任务可见性判据：**七份**逐字副本收成一份（W57）

`or(owner = 我, id IN (我参与的任务))` 是**授权判据**——漂一处，用户要么看见不该看见的任务，
要么丢掉本该看见的。落这一刀时它在仓里被逐字抄了七份：

| # | 位置 | 形态 |
| --- | --- | --- |
| 1 | `db/query.ts` | 本次定为唯一一份 |
| 2 | `task-execution/infrastructure/taskListPage/authorization.ts` | RFC-357，ref 参数化 |
| 3 | `collaboration/infrastructure/collaborationTaskAccess.ts` | 内联在分块 `visibleTaskIds` 里 |
| 4 | `collaboration/infrastructure/reviewTaskAccess.ts` | **与 3 逐字相同**（同一模块两个文件） |
| 5 | `task-execution/infrastructure/taskOverviewQuery.ts` | `sql.placeholder` 预编译形态 |
| 6 | `task-execution/infrastructure/postgresqlTaskRouteOperations.ts` | **provider 专属**那一份 |
| 7 | `task-execution/infrastructure/taskAuthorization.ts` | 先前已收敛 |

**七份里没有一份是「按引擎必须不同」**。差异只有三样，现在都由唯一那份的参数承担：
命名（`ref`/`viewer` vs `subject`）、返回约定（`undefined` vs `1 = 1`）、绑定形态
（字面量 vs `Placeholder`）。

**第二处重复**：分块版 `visibleTaskIds` 有四份，两份逐字相同，其中三份把分块大小硬写成字面量
`500`——而 `util/sqlChunk.ts` 的 `SQL_IN_CHUNK` 就是这个数，它存在的理由正是「别把某个具体
数字写进判据」。现在统一走 `visibleTaskIdsFor`（存在性过滤语义原样保留）。

**刻意不合并的一处**：`taskListOwnershipScopeCondition` 的 `mine` 分支与可见性判据今天恰好
等价，但一个是「我要看哪一档」、一个是「我能不能看」。可见性哪天扩了（例如加上工作组成员），
`mine` 不该跟着扩。

### 守卫写法上的两条教训（都是自己先踩了）

1. **判 AST，不判文本**。文本匹配会把讲述历史的注释算成命中——本条守卫的头注就写满了这些名字，
   第一版直接自噬。同一天在 `rfc311-perf-guards` 与 `rfc349-resource-catalog-provider-contributions`
   上各撞一次：前者被我新写的 helper 注释喂饱，后者被我新写的 composition 注释喂饱（那条本想钉
   导出声明，结果被散文满足，等于**静默失效**）。
2. **抓不全的守卫比没有更危险**。第一版按「`inArray` 第二个实参子树里有没有提到
   `taskCollaborators`」判，在收敛前的 HEAD 上只抓到 **2/6**——七份里有四份先把子查询绑到局部
   变量（`collaboratorIds` / `collaboratorTaskIds` / `memberIds`）再传进去。改成**文件级**限定后
   才 6/6。它让人以为已经守住了，是最坏的一种。
   （文件级限定本身也必要：无限定时它先命中了 `scheduledTaskPersistence.ts` 的
   `or(owner = 我, id IN (我被 grant 的定时任务))`——同一个句式，但那是 `scheduled_tasks` ×
   `resource_grants`。判据要认的是**概念**，不是句式。）

### 采法记一条：`allowGrowth` 的契约与顺序

- 契约是**对象** `{ why }`，不是字符串——写成字符串会被普查**静默丢掉**（`rfc294Canonical.ts:4089`
  的 `typeof permit === 'object'`）；
- 顺序必须是「**先手写许可 → 再跑普查**」：普查会把对象形态的许可读回保留**并重算
  contentDigest**；反过来先采后改，digest 对不上，N1a 判红。

### 下一个靶心（未动）

`postgresqlTaskRouteOperations.ts`（2601 行）连同 `postgresqlTaskRouteLaunchOperations` /
`postgresqlTaskRouteRepairOperations` / `postgresqlTaskLifecycleTransaction` 是一族**真分叉**
（`withPostgresqlSerializableTaskExecution` 有 7 个生产调用方，见 §5c 的 Cut I），不是命名债。
本轮只把它的可见性判据收走。

## 5k. 用**机械手段**找剩下的重复：38 组跨文件逐字相同的函数体（W57 调查）

AC-1 剩的是「跨目录 / 内联真实重复」。此前每一刀都靠人眼在自己碰到的那片里找，找到哪算哪。
W57 换了个做法：把 `packages/backend/src` 下所有函数 / 方法的**函数体**去注释、压空白后取摘要，
报告跨文件的逐字重复（≥220 字符）。结果：6384 个够长的函数体里，**38 组**跨文件逐字重复。

这份清单最大的价值是它**不挑食**——它同时照出了 provider 分叉、legacy 孪生、以及与 provider
无关的普通复制粘贴，而且给出的是可直接接手的 `file:line`。摘录几组（按 字符数 × 处数 排）：

| 处数 | 位置 | 性质 |
| --- | --- | --- |
| ×5 | `taskQuestionDispatch` / `review` / `clarifyDecision` / `sqliteTaskDecisionParticipant` / `taskDecisionParticipant` 的 `projectionMember`（586 字符） | 跨两个 bounded context 的复制 |
| ×2 | `postgresqlIntentApplyResourceParticipants` ↔ `legacyIntentApplyResourceParticipants` 的 preflight（912 字符） | **provider 真分叉**（§5c 记的 7 条之一） |
| ×2 | `postgresqlTaskRouteOperations` ↔ `services/task.ts` 的 `assertFrozenTaskTriggerPreflight`（811 字符） | provider 侧与 legacy 侧各一份 |
| ×2 | `postgresqlChildExecutionLaunchOperations` ↔ `postgresqlTaskRouteLaunchOperations` 的 `buildWorkgroupRuntimeConfig`（654 字符） | **两个 PG 文件互相重复** |
| ×4 组 | `sqlite/systemMaintenanceRetention` ↔ `postgresqlMaintenanceRetention` 的四个候选集构造器 | **本轮已收**，见下 |
| ×3 | `cli/start.ts` / `cli/postgresqlDaemonApplication.ts` / `server.ts` 的 `nextMutationTimestamp` | 三个装配根各一份 |
| ×2 | `capabilityTemplateOperations` ↔ `services/capabilityTemplates` 的 `rowFromInput` / `mergeableSnapshot` | 模块化迁移留下的 legacy 孪生 |

### 本轮收掉的一对：保留期清扫（retention sweep）

`platform/persistence/postgresqlMaintenanceRetention.ts` **整份删除**。逐行核过，它与
`platform/persistence/sqlite/systemMaintenanceRetention.ts` 的对应实现**逐字相同**：四个候选集
构造器连字符都一样，游标解析（`cursorFor` ↔ `retentionCursor`）、相位表、推进规则、计数赋值、
返回形状全部同形；唯一的差别是类型名与 `db` 标注的宽窄——而 SQLite 那份的签名**早就是**
`ProviderNeutralDatabase`。

「候选集怎么变成一条 DELETE」这唯一的方言点（PG `WITH candidates AS (…) DELETE … USING
candidates` / SQLite `DELETE … WHERE id IN (…)`）W6-T25 时就收进了能力矩阵的
`deleteByCandidates`——也就是说**分叉的理由在那时就没了，只是文件没删**。

`platform/background/maintenanceWorker.ts` 里那条 provider 分支随之消失：两个引擎现在调同一个
`runRetentionSweepSlice`。净删 288 行。

**判据反而更重了**：`rfc359-w8-retention-parity` 原本比的是「两份实现删的是不是同一批」，
现在比的是「同一份实现在两个引擎上删的是不是同一批」——后者才是 `deleteByCandidates` 那条
方言渲染的真实验收面。它在合一后**一次就绿**（双引擎 10 pass），这也是两份等价的直接证据。

### 顺带修掉的一个真 bug：并发续跑偶发 500 而不是 409

清单第 4 组（`buildWorkgroupRuntimeConfig`）落地那一提的 CI 上，ubuntu 分片 1/8 红了一条
`rfc359-w8-t29 [postgresql]`——报的是 `Error:Failed query: insert into … task_execution_intents …`，
即**驱动错误漏到了端口外面**。查下来是真缺陷，不是 flake：

续跑准入是「先读活跃 intent、再插一行 pending」，整笔在 SERIALIZABLE 里。两个并发续跑都读到
「没有活跃 intent」时，输家有两种收场、谁先冒是随机的：SSI 先判就是 40001（`serializable`
会重试，重放时读到赢家那行 ⇒ 领域错误 ✓）；部分唯一索引先抛就是 **23505**——它不是序列化失败
（重试不接），此前**也没有映射**，于是原样漏出去，用户侧就是 500 而不是 409。

修法：`taskContinuationAdmission.ts` 新增 `admitWithPendingIntentConflict`，两个提交入口都包上。
**端口的错误合同不再依赖调用方有没有先做 CAS**——那正是那条对拍直接打端口要测的东西。

这里有一条给账本用法的教训：`rfc359-w8-unnormalized-unique-insert` 早就把这一处记在账上，
why 写的是「**已实测不可达**」，依据是「唯一的生产入口更早还有一次 task 行 CAS 挡掉输家」。
那个判断**少看了一条路**——同一个仓里的对拍就直接打端口、绕开了那次 CAS。
**账本里的「不可达」是一次断言，不是一条事实**；它和别的断言一样会过期，而过期的表现是
偶发红、不是编译错。归一之后该条销账（20 → 19）。

### 本轮 burn down 到哪了：38 → 23 组（§5l 再收五组 → 17）

| 提交 | 收掉的组 | 性质 |
| --- | --- | --- |
| retention 合一 | 4 | provider 孪生（PG 文件整份删除） |
| task-execution 三处 | 3 | 两处 provider 家族内互抄 + 一处 provider↔legacy |
| 同模块两处 | 2 | `runIdsWithOutput` ×3、`grantedIds` ×2（后者复用既有导出） |
| agent 引用校验 + 蒸馏列表 | 3 | 「一处早就导出了它，另一处还留着私有副本」 |
| 矩阵守卫那批顺带 | 2 | 同上形状 |
| node_run 人工门投影 | 1 | **五份副本**，跨两个 bounded context |

剩 21 组。挑的时候优先「一处早就导出了它」那种——零新增边、零账本增长，而且往往说明
**当初就该用那个导出**（本轮六组里有四组是这个形状）。

**已判定「不该合」的（别再推导一遍）**：

- `decodeFusionSkillToken`（knowledge-evolution）↔ `decodeSkillToken`（resource-catalog）——
  两个 bounded context **各自拥有自己的令牌类型**（`FusionSkillToken` / `SkillPreconditionToken`）。
  合它要新开一条 knowledge-evolution → resource-catalog **application 层**的边，而 RFC-294 的
  模型正是「跨上下文只走 exact public 合同、不共享内部助手」。这是**按设计的重复**，
  逐字相同只是因为两个类型今天恰好同形。

**§5k 点名的两个靶心都已收**（`assertFrozenTaskTriggerPreflight` 与
`resolvePostgresqlIntentApplyResourcePreflight`），见 §5l。下一刀从上表其余各组里挑。

### 给下一刀的话

上表其余各组都还开着。挑的时候注意两件事：
- **先确认是不是「真重复」**：逐字相同只说明**今天**一样；要看两侧的调用面与孪生位置
  （§5c 的 Cut I 就是反例——`postgresqlTaskLifecycleTransaction` 里 5 个导出只有 2 个是死的）；
- **收敛方向朝中立那侧**：本轮两次（overview、retention）都是「中立实现已存在，provider 孪生是
  剩下的那份」，删 provider 侧即可，不必新写抽象。

## 5l. `assertFrozenTaskTriggerPreflight`：一次「明码标价」的合一（W8）

§5k 表里最后一条跨层靶心。它是 RFC-359 命题最纯粹的那种形状——**两条 provider 路由路径各揣一份
逐字相同的文件私有函数，只有 `db` 的类型标注不同**（`LegacySqliteTaskDatabase` vs
`PostgresqlDatabaseClient`），而函数体读的是 provider 中立的单行 `tasks` select，**没有任何方言面**。
两份并存的唯一后果就是「改一份、漂另一份」，且漂完两条路径各自的用例还都绿着。

### 落位不是我挑的，是守卫按住的

最省边的落位是 `services/execution/triggerPreflight.ts`——`assertTriggerPreflight` 本体所在处，
也是它唯一的逻辑依赖，而且 PG 那个文件**本来就**在 import 该文件，净增只有 1 条边。写完就红：
`rfc349-provider-cutover` 的 `databaseMechanismDependencies` 判据禁止 `services/` 面直接拥有
`@/db/*` / drizzle。那条守卫是对的——纯判据留在 `services/`，**带读点的那一层归 infrastructure**。
于是正典落在 `modules/task-execution/infrastructure/frozenTaskTriggerPreflight.ts`。

### 代价：+6 边 / +5 例外 / +2 符号主，三条一次性 permit

| 账本 | 变化 | 内容 |
| --- | --- | --- |
| `rfc294-cross-context-observed-imports` | 5333 → 5339 | 新文件的 6 条 import 边 |
| `rfc294-architecture-exceptions` | 4795 → 4800 | 同一批里被登记为架构例外的 5 条机制边 |
| `rfc294-module-symbol-owners` | 25035 → 25037 | 新文件导出的两个符号登记主人 |

外加 `commons-debt.json` 一条 `R1-inbound-module-internals`（`services/task.ts` →
新模块文件），与同文件既有的 `branchTraceSnapshotReader` 同形同命，随 W4-E 一起消失。

**这笔账值得付**：换掉的是一处**看不见、没测试、必然漂移**的 fork，换来的是一条**有署名、有
removeAfterWave、被守卫盯着**的耦合。不要把「账本零增长」当成合一的前提——那会让所有跨层重复
永远合不掉，正是这类 fork 存活至今的原因。

### 顺带立了一把可复用的棘轮账本

`tests/architecture/rfc359-converged-twins.test.ts`：每收一对孪生体追加一行（正典定义点 +
消费白名单），**双向棘轮**——冒出第二个定义点红、白名单条目陈旧也红。本轮把已收的五对一起
补登（本条 + 人工门投影 + retention + `/api/overview` 两条）。以后再收一对只需追加 ~15 行，
不必每次新写一把守卫。

判 AST 不判文本：本轮之前已经被自己的注释喂饱过两次守卫（`rfc311-perf-guards`、
`rfc349-resource-catalog-provider-contributions`），这次直接从设计上排除。守卫自证有牙——
临时往 `src/` 塞一份私有副本，实测转红。

### 两条新的踩坑（都是自己先踩了）

1. **文件名里的 `preflight` 会把功能测试识别成守卫**。`GUARD_FILE_NAME_PATTERN`
   （`census.ts`）按文件名匹配 `architecture|boundary|ratchet|lock|guard|invariants|preflight|
callsite|extinction|interlock`，命中即要求进 `guard-manifest.json`，否则两向钉死红。
   新测试叫 `rfc359-w8-frozen-trigger-preflight.test.ts`，于是被算成守卫。**处置是登记，不是改名**
   ——`mechanism: 'behaviour'` 是清单里既有的一档（`lifecycle-invariants-*` 全是这档）。
   四个元数据字段别手填：用 `census.ts` 导出的 `isCorpusScanner` / `corpusFloor` /
   `assertsAbsence` / `negativeFixtureAssertions` 现算，`lines` 要**在 prettier 跑完之后**取。
2. **一句讲历史的散文能把覆盖对等账本推红**。`rfc359-w5-t19d-coverage-parity` 按「测试文件提到
   该侧模块名」计注意力。新测试的头注释点了 PG 适配器的文件名，于是 `TaskRouteOperations` 的
   PG 侧 ref 10 → 11、和 SQLite 侧拉开到 3，被判为**新的深度倒挂**。而这条测试恰恰是
   `describeEachProvider`、喂的是两侧。**正解是改措辞，不是往倒挂名单里加一行**——把非信号
   登记进信号账本，等于把账本本身废掉。历史细节该落在 `commons-debt.json` 的 why 里。

### 同一刀里的第二对：Intent apply 归属预检（纯命名分叉，代价为负）

`resolveIntentApplyResourcePreflight` 与它的三个 interface 在
`modules/resource-catalog/infrastructure/aggregateAdapters/` 的两个适配器里各有一份**逐字相同**的
副本，差别只有类型名上的 `Legacy` / `Postgresql` 前缀。它是 §5c 记的 resource-catalog 七条真分叉里
**最容易的一条**——函数体只经 `ResourceCatalogAclIdentityReadPort` 这个闭合端口取数，一行方言都没有，
所以它根本不是能力分叉，是**命名分叉**。

抽到同目录的 `intentApplyResourcePreflight.ts`（同 bounded context、同层），**零新增跨上下文边**；
`rfc294-module-symbol-owners` 反而 25037 → 25033（少了 4 个重复导出）。收敛方向朝中立那侧的那类，
挑的时候优先——它们通常连账本都不用动。

一条顺带的：两个适配器原来各自 import `CATALOG_SELECTOR_KINDS` 的**值**只为这段用；抽走之后两处
都只剩类型用法，`--max-warnings 0` 当场红。**删函数体之后要重跑 lint**，别凭记忆判断哪些 import
还活着（本轮又验证了一次这条老规矩）。

覆盖：既有的 `rfc271-intent-skill-plugin-update.test.ts`（T14/T15）把语义钉得很细，但**只在 SQLite 上**
（`createInMemoryDb` + bun:sqlite 同步 `.run()`）。合一之后「两个 provider 共用」这句话本身需要证据，
于是新增 `tests/rfc359-w8-intent-apply-preflight.test.ts`（`describeEachProvider`，两引擎共 6 pass）：
不重复 T14/T15 的语义细分，只锁**跨引擎一致性**——占用名集合（大小写归一）、copy-only 目标与拒绝理由、
六类资源都被问过一遍（空库上是六个空集合而不是缺键）、返回值冻结。

### 第三、四对：`notSyncable` 与 `assertManagedPath`（都零边）

- **`notSyncable`**（`sqlite/postgresqlTaskRouteOperations.ts` 各一份）——纯投影，把一个拒绝理由
  包成 `WorkflowSyncPreview` 的否定形态。收进 `domain/workflowSyncPreview.ts`；domain 只依赖
  `@agent-workflow/shared`，而 **shared 不计入跨上下文账本**（`observedEdges` 的 external 那一档
  今天只有 `drizzle-orm` 一个 specifier），所以零新增边。
- **`assertManagedPath` + `errorValue`**（`sqlite/postgresqlResourcePackageMaintenance.ts` 各一份）
  ——纯路径判据 + 错误归一。收进同目录的 `resourcePackageMaintenancePaths.ts`：同模块同层，
  零新增边，`rfc294-module-symbol-owners` 反而 −1。
  `assertManagedPath` 尤其不该有两份：它决定「哪些路径算在托管根之内」，两侧一旦漂开，同一个
  清扫动作在两个 provider 上会得出不同的「可删」结论，而两条路径各自的用例都还绿着。

#### 棘轮账本因此长出一格：`homonyms`

`modules/intent/infrastructure/postgresqlIntentApplyArtifactLifecycle.ts` 里也有一个叫
`assertManagedPath` 的函数，但那是**另一个实现**（走 `pathInside`、抛另一个错误码，属于 intent
自己的托管根合同）。守卫判的是「这个名字在仓里只有一个定义点」，于是它恒红。

放宽成「至少有一个定义点」是错的——真 fork 回两份就抓不到了。正解是把已知的同名异物**逐条
登记**（`homonyms: [{ path, why }]`）：多出一个**没登记**的同名定义仍然红，逼下一个人来账本里
回答「它是又一份副本（合掉）还是同名异物（写清为什么不合）」。实测有牙：往第三个文件塞一个
同名空函数当场转红。

### 第五对：`preparedPackageMutation` —— 整族七个类型谓词，账本净降 12 条边

两个包应用引擎（`platform/persistence/sqlite/legacyResourcePackageBundleApply.ts` 与
`platform/persistence/postgresqlResourcePackageAtomicApply.ts`）各揣**整族七个**逐字相同的类型
谓词，差别只有函数名（`isPreparedAgentPackageMutation` vs `isPreparedAgent`）。

判据是 `PreparedPackageMutation` 这个可辨识联合的**性质**，不是任一 provider 的性质：
`mutation.kind` 的取值由公共合同定义，两个引擎只是消费者。两份并存的后果很具体——往联合里加
一种 kind 时漏改一侧，那一侧会**静默跳过**该类变更（谓词返回 false，走不到对应分支），
而两条路径各自的用例都还绿着。

落 `modules/resource-catalog/public/types.ts`（该文件本就有运行时导出），收成**一个冻结对象**
而不是七个具名导出——消费者只多一条边，而不是七条。账本因此**大幅下降**：

| 账本 | 变化 |
| --- | --- |
| `rfc294-cross-context-observed-imports` | 5340 → **5328**（−12） |
| `rfc294-architecture-exceptions` | 4801 → **4789**（−12） |
| `rfc294-module-symbol-owners` | 25030 → **25017**（−13） |
| `rfc294-public-surfaces` | 983 → 984（+1，一次性 permit） |

−12 是因为两个消费者各自的**七条** `Prepared*PackageMutation` type import 只服务于那族谓词的
返回类型，谓词搬走后全部变死，只换来一条值 import。

#### 两条落位上的教训

1. **对象属性上的类型谓词照样 narrow。** `preparedPackageMutation.isPreparedAgent(x)` 在
   `if (!…) throw` 之后，TypeScript 对 `x` 的收窄与自由函数完全一样。收成对象不牺牲类型能力。
2. **键名会撞进别的守卫的判据。** 初版键叫 `isAgent`，`rfc317-registry-reverse-completeness`
   的**键级**判据按键名文本找消费者（`census.ts` 的注释自陈了这个弱点、靠符号级判据兜底），
   于是它把我的 `isAgent` 算成 `NODE_KIND_BEHAVIORS.isAgent` 的直接消费者，把那条豁免判成过期。
   **让路的应该是新代码**：我的键名是任意的，注册表的不是。改成 `isPrepared*` 前缀，
   并把理由写在导出处——否则下一个人会把它改回短名。

#### 棘轮账本第二次长个儿：定义点判据放宽 + 别名例外

`const X = Object.freeze({…})` 的初始化器是一次**调用**，只认「函数形状」的初版对它恒红
（一个定义点都数不出来）。账本要问的是「这个名字全仓只有一个定义点吗」，判据因此放宽到
**任何模块级绑定**（函数 / 类 / 带初始化器的变量 / 方法 / 对象属性）。

放宽立刻照出一处必须排除的形状：`public/participants.ts` 的
`export const humanGateNodeProjectionMember = humanGateNodeProjectionMemberInternal`
是**纯别名再导出**，绑定的是同一个值、不可能是第二份实现。所以加一条例外：初始化器是**标识符
或属性访问**时不算定义点——否则这条守卫等于禁止一切 re-export。两条都配了负 fixture，
并实测「往第三个文件塞一个同名 const」仍然转红。

### 覆盖

`tests/rfc359-w8-frozen-trigger-preflight.test.ts`（`describeEachProvider`，两引擎各 10 条）：
任务行不存在的静默返回、trigger 上下文损坏的权威拒绝、**该判据先于快照**（两者都坏时仍报
`trigger-context-invalid`）、损坏快照的容忍、合法快照的权威拒绝、候选快照换定义、候选**不换**
trigger 源、durable 行损坏时候选救不回来、读点只花一次往返。

合一前这五条分支里**只有一条**（`trigger-context-invalid`，经 retry 端点）有双引擎覆盖。

## 5m. AC-1 收口：`Migrator` 的见证补上了（W8，成对面 unverified 归零）

成对适配器账本今天是 **10 对 / 9 对已见证 / 1 对未见证**（proposal §7 里「仍缺 5 对」的历史实测
早已过期）。剩的那一对是 `platform/persistence/Migrator`。

> **2026-09-11 更新：已收口。** 下面记的卡点在同日被 harness「每文件一库」解开——对拍现在
> 再开一个一次性库、把 PG 迁移器从零跑一遍，SQLite 侧对应一个全新内存库，
> `witnessesPair` 的机械判据（两侧实现各一条值 import）因此满足。
> `PROVIDER_PAIR_CONFORMANCE_LEDGER` 的状态位已改为 verified，`UNVERIFIED_PAIR_COUNT` 1 → 0，
> **成对面至此全部有双引擎对拍**。原始分析保留在下面，因为它解释了「为什么不能靠放宽判据收口」。

### （历史）缺的不是意愿，是「迁移器暂时不支持在隔离 schema 上被驱动」

`rfc359-w5-provider-pair-conformance` 认的见证是**机械**判据（`witnessesPair`）：
`describeEachProvider` + **两侧实现各有一条值 import**——对拍必须真的驱动两个实现，
不能只观察它们的结果。这条判据是对的，它挡的正是「拿一个不驱动实现的测试冒充对拍」。

对迁移器，「驱动 PG 侧」意味着在测试里再跑一次 `migratePostgresqlSchema`。而它的 schema 名
（`agent_workflow`）是**写死的**：重跑会打到 harness 共用的那个 schema 上，破坏同集群里其他
测试文件的库（PG 的 advisory lock 还是**集群级**的，见 `docs/dev-gotchas.md`）。
所以这一对的见证被卡在一个**产品侧的可测试性缺口**上，而不是排期上。

**要收口 AC-1，先让迁移器能在隔离 schema / 隔离库上被驱动**——这与 `docs/audit-backlog.md`
记的 harness 那一刀（「每文件一库 vs 每文件一 schema」）是同一件事，应该一起做。

### 与此同时，用户可见契约那一层已经有见证了

新增 `tests/rfc359-w8-migrator-conformance.test.ts`（`describeEachProvider`，两引擎共 6 pass）。
迁移器对应用的承诺只有一句——**跑完之后，这个库真的实现了应用声明的那份 schema**。
判据就照这句写：拿 `buildLogicalSchemaContract()`（从 drizzle 声明派生的表 / 列花名册）去
**问活库**，每张声明的表都发一条 `select().from(table).limit(1)`——不带投影 = 选出全部声明列，
少一张表或少一列都在这里炸。

它挡的是一类真实且**不会被别的测试照出来**的漂移：`docs/dev-gotchas.md` 记着「PG 的表 / 索引 /
约束来自 drizzle 声明，不是 SQLite 迁移 SQL——迁移里手写的索引 PG 没有」。反过来同样成立：
drizzle 里加了一列而 SQLite 的迁移 SQL 没跟，SQLite 侧就少一列。两种漏法在各自引擎的用例里
都不会红（那些用例只碰自己用到的那几张表），但任何一条读到那张表 / 那一列的生产路径都会在
运行时炸。

**判据自证不空转**：整个循环跑在 `recordStatements()` 里，断言实际发出的查询数 ≥ 花名册长度
——只看「失败列表为空」的话，循环若被某个 `continue` 悄悄跳过大半张花名册，测试照样绿。
另配一条负 fixture：查一张不存在的表必须抛，否则上一条判据对「表根本不存在」是瞎的。

**当时状态位没动**：那一版对拍不满足 `witnessesPair` 的机械判据，所以账本仍记 unverified。
放宽那条判据去迁就它是错的——它挡的就是这个。**正确的解法是把被挡住的能力补上**
（让迁移器能在隔离库上被驱动），而不是把判据改松；这也正是同日发生的事。

### 收口后的形态

`tests/rfc359-w8-migrator-conformance.test.ts` 现在有两半，都跑在 `describeEachProvider` 里：

1. **契约那一半**（原有）：拿 `buildLogicalSchemaContract()` 的花名册去问 **harness 迁好的活库**，
   每张声明的表发一条不带投影的 `select`。整个循环跑在 `recordStatements()` 里，
   断言查询数 ≥ 花名册长度——防的是「循环被某个 continue 悄悄跳过大半张花名册」。
2. **驱动那一半**（新增，AC-1 要的见证）：**从零跑一遍本引擎的迁移器**——SQLite 侧一个全新内存库
   + `migrateSqlite`，PostgreSQL 侧再开一个一次性库 + `migratePostgresqlSchema`——然后问各自引擎的
   **目录表**（`PRAGMA table_info` / `information_schema.columns`）核对声明的每一张表、每一列。

第二半刻意**不用** drizzle 的表对象：`drizzle-orm/sqlite-core` 的 `getTableConfig` 在 PostgreSQL
投影上会抛（`docs/dev-gotchas.md` 有这条，本轮又撞了一次）。走目录表反而更强——它读的是**库里
实际存在的东西**，不是应用声明的回声。

## 5n. AC-6 第一批机械迁移：19 个行为套件转双引擎，并**量出了真正的闸门**（W8）

本刀做两件事：把一批直接建 SQLite 内存库的行为用例迁到 `describeEachProvider`，以及——更重要的
——**把「为什么剩下的迁不动」量成数字**，让下一刀不用再重新摸一遍。

### 迁了什么

`rfc359-w5-test-engine-hardcoding` 账本 **657 → 638**（19 条，其中 `admin-only-gate.test.ts`
是上一刀留下的半截）。迁法是纯机械的三步：`describe(name, () => {}` → `describeEachProvider(name,
(harness) => {}`、构造点换成 `harness.db`、`DbClient` 标注换成 `ProviderNeutralDatabase`。
构造点落在模块级工厂函数里时（`buildHarness()` 这一类），把库当**参数**传进去而不是提到闭包里
——工厂本来就在 `describeEachProvider` 外面，`harness` 不在它的作用域内。

### 双引擎对拍当场照出的三条真实分叉

这批用例过去只在 SQLite 上跑，迁完立刻红了三条。三条各代表一类，都值得单独记：

1. **`runner-parent-stdout-broadcast`：漏 `await` 的播种**。`seedTask()` 里两条
   `db.insert(...).run()` 都没 await——同步 SQLite 上语句已经落库，PostgreSQL 上返回的是**没人等的
   Promise**，于是紧跟着插 `node_runs` 直接撞 `node_runs_task_id_tasks_id_fk`。
   这不是 PG 的毛病，是用例一直在**依赖同步驱动的副作用顺序**；async 只是让它现了形。
   修法：`seedTask` / `buildHarness` 改 async，逐条 await。

2. **`runner-inject-snapshot-eager-write` E4：注入点扎进了 SQLite 适配器的内部形状**。
   原写法猴补 `h.db.update(...).set(...)`，靠「载荷恰好只有 `injectedMemoriesJson`」认出
   eager-write 那一次。但 eager-write 走的是 `opts.persistence.nodeExecution.patch(...)`——
   **PostgreSQL 的持久化实现根本不经过那条 drizzle builder**，于是同一条用例在 PG 上一次也拦不到，
   `eagerWriteIntercepted` 恒为 false。修法是把注入点**上移到端口边界**：包一层
   `TaskExecutionPersistence`，只让第一次「载荷只有 `injectedMemoriesJson`」的 patch 抛。
   两个引擎同一形状，而且比原写法更贴合被断言的功能（「eager 写失败不致命」）。
   包法本身也踩了两个坑，都写进注释了：`nodeExecution` 是**类实例**（方法在原型上、自有字段只有
   `db`），对象展开会把 `appendEvents` 整批抄丢；而顶层 `realPersistence` 是 `Object.freeze` 的，
   非可配置属性上 Proxy 的 `get` 不许返回别的值（直接 TypeError）。所以顶层用展开、
   `nodeExecution` 用 Proxy。

3. **`rfc165-migration-0085`：不该迁**。它把 `0085_*.sql` 里的 UPDATE **逐字重放**，
   而那是 SQLite 方言（反引号标识符，PG 上 `syntax error at or near "\`"`）。
   这条判据锁的就是「**发出去的那份 SQLite 迁移脚本**回填对不对」，PG 有自己的迁移路径、
   由 `rfc359-w8-migrator-conformance` 见证。已回退，账本那一行保留——**「没迁」和「迁不了」要分开记**。

### 顺带放宽的一处生产标注：`systemWorkspaceGc.ts`

`gc.test.ts` 迁完撞上 `runWorktreeGc(db: DbClient, ...)`。整份文件 11 处 `DbClient` 标注一起换成
`ProviderNeutralDatabase` 后**零报错**——函数体本来就只用中立 drizzle 与 `databaseSessionFor`，
那 11 处纯粹是**过窄标注**，不是真的耦合。生产装配面早就是中立的（hourly GC 走
`ownerCommands.workspace.runGcPhase`，实现在 `modules/source-control/application/workspaceMaintenance.ts`，
不碰 `DbClient`），所以这次放宽零行为变更。

### 真正的闸门：`DbClient` 过窄标注，闸门本体只有 **7 个同步事务调用点**（本刀量出来的数字）

把这批 90 个候选文件跑一遍机械迁移后，typecheck 报了 489 条错。追下去只有一个来源：
**测试拿到的是中立库，而被调用的生产函数还标着 `DbClient`**——372 条可赋值性错里 **191 条**
直接指向 `DbClient` 形参。于是问题变成：这 111 个带 `DbClient` 的文件，有多少是真耦合？

拿整棵 `src/` 做替换实验（`DbClient` → `ProviderNeutralDatabase`，进口改从 `@/db/query` 走），
**唯独 `src/db/client.ts`（定义）与 `src/db/txSync.ts`（同步事务原语）保持原样**：

| 观测                                     | 数字                               |
| ---------------------------------------- | ---------------------------------- |
| `src/` 里带 `DbClient` 的文件 / 出现次数 | **111 / 332**                      |
| 全量放宽后残留错                          | **92 条，集中在 ~12 个文件**       |
| 残留错所在文件                            | 全部落在 `SYNC_TRANSACTION_DEBT` 那 4 个文件**及其调用闭包**（`digitalEmployeeExecution` / `services/task.ts` / `taskDelete.ts` …） |
| 账本 `SYNC_TRANSACTION_DEBT` 现值         | **7 个调用点 / 4 个文件**（4 × `dbTxSync(` + 3 × `withOwnedTaskTx(`） |

**一条要写下来的踩坑**：第一次做这个实验时**把 `src/db/txSync.ts` 也一起替换了**，残留错当场
变成 234 条、并冒出 175 条 `TS2339 … does not exist on type 'never'`，看上去像「同步事务面污染了
几十个文件」。其实是自伤——`DbTxSync = Parameters<Parameters<DbClient['transaction']>[0]>[0]`，
把 `DbClient` 换成联合类型库之后，两个重载的形参交出来就是 `never`，凡是用 `DbTxSync` 当类型的
地方全部塌掉。**度量同步事务面时必须把它的定义文件排除在外**，否则量到的是自己制造的噪声。

所以结论比第一眼干净得多：

> **`DbClient` 标注绝大多数是纯过窄、白送；真正挡路的是 7 个同步事务调用点。**
> 它们同时也是 §6「同步事务面是死代码清理的前置」挡住的那堵墙——两件事排在同一个前置后面。

### 给下一刀的话

- 迁移脚本可复用（本刀是一次性脚本，形状记在上面「迁了什么」一节，重写只要十几行）：
  它的**跳过判据**比迁移判据更值钱——`ctor-count != 1` / `new Database(` / 任何 `Sqlite` 命名符号 /
  顶层 `describe` 不唯一，四条挡掉的都是「机械改会改错」的形状。
- **别把 typecheck 干净当成迁移成功**。本批 19 个文件 typecheck 全绿，跑起来仍有 3 个红，
  且三条各属不同类别（漏 await / 注入点错层 / 根本不该迁）。**双引擎实跑是唯一判据**。
- 迁完 `packages/*/src/**` 有改动就要重跑普查，而且**顺序是先 `prettier --write` 再普查**——
  反过来会让 `sourceDigest` 停在格式化前的内容上，`rfc294-canonical-manifests` 当场红
  （本刀实撞一次）。

## 5o. 同步事务面这一刀该怎么下（W8 踩点，**未动手**，给下一刀的执行说明）

§5n 量出 AC-6 剩余迁移全部卡在同步事务面之后，本节把那一刀**踩清楚**：账本
`SYNC_TRANSACTION_DEBT` 现值 **7 个调用点 / 4 个文件**，但它们不是七件独立的事，是**一棵树**。
下面是实测出来的形状，照着做就行，不必再摸一遍。

### 好消息：中立解释器与中立写序列**都已经在仓里了**

- `platform/persistence/transactionProgram.ts`（58 行）——`transactionStep` 把一步写包成
  generator，`driveSyncProgram` / `driveAsyncProgram` 两个解释器**同一个程序两种跑法**。
- `modules/task-execution/infrastructure/taskLifecycleWriteSequence.ts`（145 行）——任务生命周期
  的 CAS + 伴随写 + 事件序列**已经是**一个 provider 中立的 program，它的头注释写得很直白：
  「The caller owns the transaction and chooses synchronous or asynchronous interpretation.」
- `modules/task-execution/infrastructure/nodeRunLifecycleTransition.ts` 的 `setNodeRunStatusTx`
  已经是中立 async 版本（W7 给协作域合一时立的），collaboration 侧已经在 await 它。

也就是说**要写的不是新机器，是新解释**：把 `sqlite/taskLifecycle.ts` 里那条
`driveSyncProgram(...)` 换成 `driveAsyncProgram(...)`，事务边界从 `dbTxSync` 换成
`databaseSessionFor(db).transaction`。同步那条**保留**——RFC-333 的人工门参与者
（`transitionHumanGateTaskTx`）挂在别人的同步大事务上，它要的就是同步解释。

### 树长什么样（按依赖自底向上）

```
sqlite/taskLifecycle.ts  setTaskStatus / trySetTaskStatus      ← 根，25 + 2 个调用点（都已 await）
├─ dbTxSync(args.db, commitTransition)                          ← 债 1
├─ ownership.withOwnedTaskTx({db, token, now, run})             ← 债 2（sqliteTaskOwnership.ts:234）
│    体内只有：一条 fence UPDATE（精确 owner 元组 + state='claimed'）RETURNING revision
│    → async 孪生 `withOwnedTaskWrite` 是**逐行照抄 + await**，20 行
└─ onTransitionTx?: (tx: DbTxSync, transition, collector) => void   ← 真正的工作量在这里
     services/task.ts 四处回调：
       4278  cancelOpenNodeRunsTx(...)         定义在 taskLifecycle.ts:230，1 个调用点
       4763  opts.onClaimTx + submitContinuationIntentTx(...)   task.ts:327，3 个调用点
       5516  submitContinuationIntentTx(...)
       6296  submitContinuationIntentTx(...)
     submitContinuationIntentTx → taskExecutionModule.intents.submitTx（DbTxSync 面）
       → 中立孪生 `DrizzleTaskExecutionIntentPersistence.submit` **已存在**
         （`taskExecutionIntentPersistence.ts`，走 `databaseSessionFor(db).serializable`）
```

另外两笔（`sqliteTaskExecutionEffect.ts:209,501` 的 `withOwnedTaskTx`）跟着债 2 一起落。

### 捷径已经走完：债 4 当场销掉（本刀落地，`SYNC_TRANSACTION_DEBT` 4 → 3 个文件）

`sqliteTaskExecutionIntent.ts` 的 `submit()`（债 4）**生产零调用方**——生产准入走同类里的
`submitTx`（`sqliteTaskExecutionIntentAdmission.ts`）与中立的
`DrizzleTaskExecutionIntentPersistence`；`grep "intents.submit({" src/` 为空。挡着它的只有测试夹具，
实际清点 **15 处 / 4 个文件**（账本上一版注释记的「38 处 / 12 个文件」已过期）。

因为中立孪生的入参与它**逐字相同**（只少一个 `db`），夹具是**平移**不是改写：

```
<module>.intents.submit({ db, ...rest })   →   await submitIntent(db, { ...rest })
```

级联只有一层：三个同步 `test(… , () => {…})` 与一个同步夹具函数
（`rfc328-codehost-attempt-ledger.ts` 的 `fixture`）翻 async，两处
`expect(() => …).toThrow(x)` 翻成 `await expect(…).rejects.toEqual(x)`。
方法与端口声明一并删除，`sqliteTaskExecutionIntent.ts` 的 `dbTxSync` 进口随之退役。

**这一笔的意义不在它本身，在于它证实了上面那棵树的读法**：账本上的数字里，有一部分根本
不是「技术钉死」，而是「只有测试夹具还挂着」。下刀前先对每一笔问一句「src 侧还有调用方吗」，
零调用方的先摘，剩下的才是真要改解释器的。

### 债 3（`sqliteTaskExecutionEffect.ts` 的两笔）**已销账**（用户 2026-09-11 裁决后落地）

先记结论：`SYNC_TRANSACTION_DEBT` **3 → 2 个文件**，`sqliteTaskExecutionEffect.ts` 从 583 行缩到
**180 行**（`prepareAndAcquire` / `settle` 连同它们的 `withOwnedTaskTx`、端口声明与随之变死的
`boundedReceipt` / `isEffectFenceConflict` 一并删除）。顺带 `rfc359-w8-unnormalized-unique-insert`
账本 19 → 18（那三处「先查存在再插唯一键表」全在被删的两个方法里）。

下面是撞墙与裁决的经过，保留原文，因为它给出了一条可复用的判断方法。

### （经过）先按 §5o 的方法走，前半段成立、后半段撞墙

按上面那条方法先问「src 侧还有调用方吗」：`prepareAndAcquire` / `settle` 也是零——生产走
`TaskExecutionPersistence['effects']`，即中立的 `DrizzleTaskExecutionEffectPersistence`
（`gateContinuationEffectPersistence.ts` 的两处 await 就是它）。挡着的测试夹具实际是
**18 处 / 2 个文件**（账本注释记的「53 处」同样过期）。两侧入参逐字相同（只少 `db`）、返回结构相同，
看起来是同一条平移。

**但平移到一半撞墙**：`rfc328-durable-ownership.test.ts` 有两处传了
`onSettledTx: (tx) => { … }`——把一笔投影写挂在**同一笔结算事务**里。中立端口**没有**这个入口，
而且是**故意**没有：该端口的契约就是「不让事务作用域逃逸给调用方」
（`taskOwnershipPersistence.ts` 的端口注释同款措辞），`taskExecutionEffectPersistence.ts` 的头注释
把 `onSettledTx` 明确记成 SQLite 侧的旧形状。

所以这一笔**不是机械平移**。端口自己其实已经给出了答案的形状：同事务投影在这个端口上是用
**具名变体**表达的——`settleCodeHostNode({ settlement, … })` 就是「结算 + node_run 投影同事务」
那一个。也就是说方向不是「把裸 tx 回调加回来」，而是问：那两条用例真正要锁的是什么？

**裁决（用户 2026-09-11）：改用已有具名变体去锁。** 逐条落地后发现两处的真实意图并不相同：

- 第一处**真的**在断言「投影与结算同生共死」。改走 `settleCodeHostNode`，投影对象从一个只为测试
  存在的 `errorSummary` 字符串，换成**真实的 node_run 终态**——判据比原来更贴生产路径。
- 第二处**根本不是断言**，只是夹具：把任务推到 `done` 好让下面的归档用例有料可归。它平铺成
  结算之后的一笔普通写即可。

**方法本身值得记住**：撞到「中立端口没有某个逃逸口」时，先分辨那条用例锁的是**产品行为**还是
**实现机制**。前者总能用端口已有的具名能力重新表达（而且通常更贴生产）；后者锁的是即将退役的
细节，应当随实现一起走。两处混在同一个符号上，是这一笔看起来像「能力缺口」的唯一原因。

### （历史）撞墙当时的判断

### 一条必须先想清楚的语义变化

`dbTxSync` 是**同步**的：BEGIN 到 COMMIT 之间没有任何别的上下文能插进来。换成显式边界的
async 事务后就有了事件循环让渡窗口，护栏是 `databaseTransaction.ts` 头注释里的三条
（writer lease 串行化 / `setImmediate` 旁观者隔离 / **事务体只 await 数据库操作**）。
四处 `onTransitionTx` 回调改 async 时要逐个确认第三条：目前它们只做库写（`cancelOpenNodeRunsTx` /
`submitContinuationIntentTx`），没有网络 / 子进程 / 文件系统，符合。**新增回调时这条要继续守住**。

### 落完之后自动塌下来的三样

1. `SYNC_TRANSACTION_DEBT` 7 → 0；
2. `DbClient` 的放宽（§5n：排除 `db/txSync.ts` 后残留 92 条错、~12 个文件，全部在这棵树的闭包上）；
3. AC-6 的剩余迁移——本刀实测：对整份积压跑一遍机械迁移，142 个文件里 **138 个**的报错指向
   `DbClient` 形参，只有 4 个能独立落地。**这三件事是一件事，别分开推。**

## 5p. `setTaskStatus` 切到中立事务：**已落地**（W8；曾整刀退回一次，见下）

`SYNC_TRANSACTION_DEBT` **2 → 1 个文件**（只剩 `sqliteTaskOwnership.ts: 2`）。
`sqlite/taskLifecycle.ts` 的两笔同步事务归零：`setTaskStatus` / `trySetTaskStatus` 的写事务从
`dbTxSync` / `withOwnedTaskTx` 换成 `databaseSessionFor(db).transaction` / `withOwnedTaskWrite`。

**写序列一个字没改**——`taskLifecycleWriteSequence` 本来就是 provider 中立的 transaction program，
换的只是解释器（`driveAsyncProgram`）与事件追加的异步形态。同步那份保留：RFC-333 的人工门参与者
挂在别人的同步大事务上，要的就是同步解释，这正是它头注释说的
「caller chooses synchronous or asynchronous interpretation」。

### 卡住过的那一条，用**内部注入点**解决（用户 2026-09-11 裁决）

整刀曾因 `review-cancel-concurrency` 的 parent-cascade starvation 退回一次：它靠「包 db 代理拦
`db.transaction`」模拟外部竞争写者，而统一原语三处同时塌（不走 `db.transaction`；SQLite 上 tx 就是
db 对象本身；写者被串行化）。

先试过「两条真连接（仅 PG）」，**前提不成立**：`cancelTask` 与 `cancel-transition-starved` 这条
重试/饥饿语义**只在 SQLite 路径**上——SQLite 的 `children.cancel` 转发 `services/task.ts` 的
`cancelTask`，PostgreSQL 走另一份 762 行的 `postgresqlChildTaskLifecycleParticipant`（没有 starvation
概念）。取消这一对还没合一，PG 上没有可测的目标。

最终按用户裁决走**内部注入点**：`setTaskStatus` 增加 `beforeCas?: () => void | Promise<void>`，
落在它**自己那次读与 CAS 之间**——那是「别的写者在窗口里把行挪走」唯一能被确定性注入的位置；
`cancelTask` 增加同形的 `beforeStatusCas` 并**透传给级联的子任务取消**（判据锁的正是子任务那笔）。
生产从不传。判据一字未改（仍是 `cancel-transition-starved` + `attempts >= 8`），变异实测转红
（去掉 `await args.beforeCas?.()` 那一行，该用例立刻失败）。

**为什么注入点必须做进来**：它跟着实现走，换事务原语不会再让判据静默失效。而旧的代理注入器在新
原语下**一次都不触发**——用例照样绿却一个并发场景都没验（`docs/dev-gotchas.md` 有完整复盘）。

### 顺带

- `withOwnedTaskWrite` 落在**中立**模块 `taskOwnershipPersistence.ts`，不是 `sqliteTaskOwnership.ts`
  ——放后者会被 `rfc349-provider-cutover` 正确判成一条新的 provider-specific 依赖。
- `taskExecutionModule` 从 `public/operations` 这条窄合同上退役（它此前唯一的消费者就是被换掉的
  `ownership.withOwnedTaskTx`）；需要进程级单例的调用方走 `public/participants`。
- 六份 N1 账本因新增中立孪生与 public 导出而增长，各带一次性 `allowGrowth`，**下一笔提交必须退役**。

### （历史）曾整刀退回的那一次



按 §5o 的执行说明把根那一刀（`sqlite/taskLifecycle.ts` 的两笔）真做了一遍。生产侧**全部完成**，
typecheck 干净，`sqlite/taskLifecycle.ts` 的同步事务调用点 **2 → 0**。卡住的不是生产代码，
是三份并发回归用例的**注入手法**。整刀已回退，diff 原样存在
`design/RFC-359-database-provider-unification/settaskstatus-cutover.patch`（868 行），
下一刀直接 `git apply` 即可从这里接着走，不必重摸。

### 生产侧做了什么（全部落地、typecheck 干净）

| 改动 | 位置 | 说明 |
| --- | --- | --- |
| `withOwnedTaskWrite` | `sqliteTaskOwnership.ts` | `withOwnedTaskTx` 的中立异步孪生，体内逐行等价（同一条 owner fence UPDATE），CAS 判据换成「取回行数为 0」 |
| `writeTaskStatusAsync` | `sqlite/taskLifecycle.ts` | 同一个 `taskLifecycleWriteSequence` program，换 `driveAsyncProgram` + 中立的 `appendTaskLifecycleTransitionCommittedEvent` |
| `cancelOpenNodeRuns` | `sqlite/taskLifecycle.ts` | `cancelOpenNodeRunsTx` 的中立孪生，判据一字不差 |
| `setTaskStatus` / `trySetTaskStatus` | 同上 | `dbTxSync` / `withOwnedTaskTx` → `databaseSessionFor(db).transaction` / `withOwnedTaskWrite`；`onTransitionTx` 的 tx 类型放宽成 `DatabaseTransaction`、返回值允许 Promise |
| 四处 `onTransitionTx` 回调 | `services/task.ts` | 改用中立孪生：`cancelOpenNodeRuns` / `revokeExactOwnerInTransaction` / `terminalizeTaskExecutionIntentsInTransaction` / `submitTaskContinuationInTransaction` |
| `setDwStateTx` | `legacy/workgroup/state.ts` | 唯一生产调用方是 resume 准入的 `onClaimTx`，签名放宽到中立句柄并 async |
| 三个中立参与者出 public | `public/participants.ts` | 与既有的 `setNodeRunStatusInTransaction` 同一姿势 |

**同步那份全部保留**：RFC-333 的人工门参与者（`transitionHumanGateTaskTx`）挂在别人的同步大事务上，
它要的就是同步解释——这正是 `taskLifecycleWriteSequence` 头注释说的「caller chooses …
interpretation」的用法。

### 退回的原因：三份用例的注入手法钉在 `db.transaction` 上

29 个相关文件跑下来 6 条红，全是**注入手法**、不是产品行为。前五条已经修好（补丁里带着）：

- `rfc097-task-status-cas` / `rfc300-terminal-workspace-policy` 的 `dbWithCompetingWriter`
  只拦 `db.transaction`。统一原语不走它，而是自己发 `db.run(sql.raw('BEGIN IMMEDIATE'))`
  ——**旧写法在新原语下一次都不触发**，竞争写者不发生、CAS 照常成功，判据于是静默退化成
  「没有并发」（这是最危险的一类：不报错，只是不再验任何东西）。改成两种边界都拦即可。
- `rfc333-human-gate-source-locks` 是源码锁，锚点跟着实现走（同步锚保留、异步锚新增）。
- `rfc359-w16-task-lifecycle-write-sequence` 的 companion 回调改 async 并逐条 await。

**卡住的是第六条**：`review-cancel-concurrency` 的
「parent cascade surfaces child cancel starvation」。它要模拟「外部写者在每次 CAS 前把子任务
搅到另一个可取消状态」，实现是**包一层 db 代理拦 `transaction`**。在中立原语下这条路三处同时塌：

1. 边界信号变了（同上）；
2. **SQLite 上事务句柄就是 db 对象本身**（`createSqliteDatabaseSession`：
   `const tx = db as unknown as DatabaseTransaction`），于是「拿回调里的 tx 再包一层」无处可包；
3. 更本质的一条：新原语**串行化写者**。事务开着时用别的句柄写，会被
   `guardForeignStatements` 判成跨上下文写入并抛 `CrossContextTransactionError`——那条守卫是对的，
   那笔写确实会加入别人的事务并随它回滚。把搅动挪进事务里能绕开守卫，但它**跟着 CAS 一起回滚**，
   于是固定轮换的目标状态会与 CAS 的期望值对上号，第三次就让 CAS 赢了（实测）。改成「读当前值再翻到
   另一个」修掉了这一点，随后又撞上 `Failed to run the query 'BEGIN IMMEDIATE'`——代理与裸 db
   是**两个不同的 client 对象**，`databaseSessionFor` / `reuseFrame` 按对象身份缓存与复用，
   混用就会在同一条 SQLite 连接上开出第二笔事务。

也就是说：**这条用例要验的产品行为（取消重试到饥饿）仍然成立，但「用 db 代理模拟外部并发写者」
这套手法在统一事务原语下不再可用**。要么给它换一种注入（例如让被测入口接受一个可注入的
「每次 CAS 前的钩子」，而不是从外面猴补客户端），要么重新表达这条判据。**这是在改一条既有回归
判据的意图，与 §5o 里 `onSettledTx` 那条同类——先确认再动**，所以整刀退回。

### 给下一刀的话

- 补丁在 `settaskstatus-cutover.patch`，`git apply` 后只剩 `review-cancel-concurrency` 一条红。
- **先把「怎么注入并发」这件事定下来再动手**。本刀实测：跨越统一事务原语的并发注入只有两条路
  ——注入点在**被测代码内部**（钩子 / 端口），或者干脆用两个真连接（PostgreSQL 上可行，
  SQLite 内存库上不行）。继续在客户端外面套代理只会在下一处再塌一次。
- 顺带记住这条最阴的失效形态：**只拦 `db.transaction` 的注入器在新原语下静默失效**，
  用例照样绿，但它一个并发场景都没验。全仓 `prop === 'transaction'` 的注入器共 3 处
  （`rfc097-task-status-cas` / `rfc300-terminal-workspace-policy` / `retry-cascade-kind-matrix`），
  哪一天根那一刀落地，这三处都要一起看。

## 5q. 同步事务面**清零**（W8 收尾：`sqliteTaskOwnership` 的最后两笔）

`SYNC_TRANSACTION_DEBT` **1 → 0**。全仓 `src/` 里 `dbTxSync(` / `withOwnedTaskTx(` 的调用点
**一个不剩**，账本自开账以来第一次见底。四刀的顺序与手法：

| 刀 | 文件 | 手法 |
| --- | --- | --- |
| 1 | `sqliteTaskExecutionIntent.ts` | src 零调用方，15 处夹具平移到中立 `DrizzleTaskExecutionIntentPersistence` |
| 2 | `sqliteTaskExecutionEffect.ts` | 同上（18 处）；两处 `onSettledTx` 按真实意图分头处理——断言那条改走具名变体 `settleCodeHostNode`，夹具那条平铺 |
| 3 | `sqlite/taskLifecycle.ts` | 根刀：**写序列一字未改**，只把 `driveSyncProgram` 换成 `driveAsyncProgram`、事务边界换成中立原语 |
| 4 | `sqliteTaskOwnership.ts` | `withOwnedTaskTx` src 零调用方（1 处夹具改走中立 `withOwnedTaskWrite`）；`claimPendingIntent` 由组合根 `TaskExecutionModule.claim` 改走中立 `DrizzleTaskOwnershipPersistence` |

第 4 刀的两笔各代表一类，值得分开记：

- **`withOwnedTaskTx`** 是「前三刀的副产品」——生命周期与 effect 两处换掉之后它自动零调用方，
  只剩一处夹具挡着。**每清掉一个上游调用点，都要回头看一眼下游还剩谁**，这一类销账几乎是白送的。
- **`claimPendingIntent`** 是真正的生产路径（SQLite driver attach）。两份实现的判据逐条相同
  （intent 必须 pending、任务不在终态维护认领里、owner 转移表裁决、epoch/revision 递增），
  中立那份把事务换成 `databaseSessionFor(db).serializable`——每任务至多一个活跃 owner、
  每任务至多一条 pending·claimed intent 都是跨行谓词，SERIALIZABLE 是对的形态。
  代价是 `TaskExecutionModule.claim` 从同步变 async：生产唯一调用方
  （`taskDriverLifecycle.ts`）本就在 async 里，28 处夹具按调用点补 await。

### 清零**不等于**同步孪生退役了

账本数的是**调用点**（`dbTxSync(` / `withOwnedTaskTx(`）——那才是「只有一个 provider 能走」的路。
`DbTxSync` 这个**类型**仍被 35 个文件用来给同步孪生定型（`writeTaskStatusTx` /
`transitionNodeRunStatusTx` / `cancelOpenNodeRunsTx` / RFC-333 的人工门参与者一族）。
它们还活着、还被别人的同步大事务用着，**退役它们是下一件事**——而且正是 AC-6 的真正前置：
根刀落地后复测，机械迁移 138 个文件仍有 137 个被 `DbClient` 形参挡住，整棵 `src/` 放宽实验的残留
只从 92 条降到 90 条，剩下的窄标注全在这批同步孪生上（§5n / STATE 第 3 条）。

## 5r. 同步孪生开始退役：整条**同步人工门链**删除（W8）

同步事务面清零之后，下一层是那批**同步孪生**（`DbTxSync` 定型的函数）——它们才是 AC-6 的真正前置
（§5q 末尾）。第一刀拿的是其中最长的一条链，删掉 **2 个文件 + 3 个函数**：

```
bindTaskDecisionParticipantInTx   (composition/humanGate.ts + sqliteTaskDecisionParticipant.ts)
  └→ LegacyHumanGateTaskLifecycle (legacyHumanGateTaskLifecycle.ts)
       └→ transitionHumanGateTaskTx (sqlite/taskLifecycle.ts)
            └→ writeTaskStatusTx    (同上)
另：cancelOpenNodeRunsTx（根那一刀之后即零调用方）
```

**整条链生产侧一直零消费者。** `bindTaskDecisionParticipantInTx` 的全部引用是：自身定义、
composition 绑定、`public/participants` 转出、`services/humanGateComposition` 上一个同名包装
（也没人调），以及**一处测试夹具**。决定接受的生产路径早就是中立的 `acceptHumanGateDecisionTx`
（`infrastructure/taskDecisionParticipant.ts`）。

夹具（`rfc333-task-participants.test.ts`）平移过去：两侧入参 / 出参类型相同
（`AcceptHumanGateDecisionInput` / `AcceptedHumanGateDecision`），所以只是把
`bindTaskDecisionParticipantInTx(tx, effects).acceptGateDecisionTx(x)` 换成
`await acceptHumanGateDecisionTx(tx, x)`，外层 5 处 `dbTxSync(db, …)` 换成
`databaseSessionFor(db).transaction(async …)`。

### 一条判据按「锁机制还是锁产品行为」拆开

`rfc359-w16` 有一条 `human-gate result is immediate; an outer throw rolls back the CAS and event`。
前半句 `expect(result).not.toBeInstanceOf(Promise)` 锁的是**实现机制**（「这一份是同步的」），
机制退役它就该跟着走；后半句「外层抛错要把 CAS 与事件一起回滚」是**产品行为**，改锁在中立的
`transitionHumanGateTask` 上，与生产路径一致。判据因此改名，覆盖面不减反增（从只验 legacy 那份，
变成验真正在跑的那份）。这与 §5o 里 `onSettledTx` 的处置是同一条方法。

### 账本联动（删文件的代价）

删两个文件牵动四本账：`rfc294Canonical` 的 `gate-control` 写点（改指中立参与者，写点与判据未变）、
`rfc359-w5-t17` 的 provider 命名文件表（56 → 55）、`rfc359-converged-twins` 的
`humanGateNodeProjectionMember` 消费者白名单、以及普查的七份清单。**删代码比加代码更容易漏账本**
——四本里有三本是「它被列在名单上」而不是「它调用了谁」，grep 调用点找不到它们。

## 5s. 同步孪生退役收尾（W8 第二批，9 刀）＋「删文件」三条守卫

§5r 之后照同一条方法往下扫：**对每个同步孪生先问「src 侧还有调用方吗」**。答案几乎总是「没有」
——宿主早被前几波迁走，只剩夹具挡着。一天里落了 9 刀，`DbTxSync` 的 src 文件面从 **32 → 14**
（去掉注释后的真实引用 62 处），`PROVIDER_NAMED_FILE_DEBT` 从 **55 → 49**。

| 退役的东西 | 判据怎么处理 |
| --- | --- |
| `taskLifecycleEventParticipant.ts`（3 个同步 append） | `rfc359-w16` 那条「同步解释保持同步返回」锁机制，随机制删 |
| `collaborationCommittedEventParticipant` / `sqliteCommittedEventStore` / `sqlite/existingTransactionScope` / `legacy/mcpRuntimeTestTransitions` | `rfc341` 的 cutover 判据是产品行为，改走中立追加口并**搬进 `describeEachProvider`**；`rfc305` 两条锁桥自己的机制，随桥删 |
| `sqliteTaskOwnership` + 端口；死码 `markTaskExecutionShutdownSurvivor` | 组合根出 `ownershipFor(db)` 工厂 |
| `sqliteTaskExecutionEffect` / `sqliteTaskExecutionIntent` / `sqliteTaskExecutionIntentAdmission` + 各自端口与转发层 | 夹具改用中立持久化 / 中立准入口，入参逐字相同 |
| `sqliteTerminalizeExecutionIntent`；`humanGateTaskLifecycleTransaction` | w17 的 describe 搬进双引擎（变异验证过）；`HumanGateTaskTransition` 的**重复第二份定义**收成一份 |
| `sqliteNodeRunMintParticipant` + `mintLegacySqliteNodeRunInTx` + `mintNodeRunTx` | `rfc349` 那条用例的两半现在同形同 program；`rfc144` 源码锁**加强一格** |

### 三件值得单独记下的事

**① 权威搬家 ≠ 权威消失。** 删 `markTaskExecutionShutdownSurvivor` 时把 `rfc294Canonical` 的
`daemon-shutdown` 条目一起删了，普查当场报 `control subtype is empty` 且**不出产物**。
正解是**改指新实现**（`DrizzleTaskExecutionShutdownOperations`，写点与 CAS 判据逐条未变）。
同形状的还有 `gate-control`（§5r 已有先例）。**删控制权威前先问「这件事还有人做吗」**。

**② 守卫指路比守卫拦路更值钱。** `HumanGateTaskTransition` 收成一份时，第一版让 legacy 生命周期层
直接 import 模块 infrastructure，被 `RFC-317 T22`（legacy 不得 import 模块内部）当场拦下；
按它指的方向改走 `public/types` 才过。**那一拦正是它存在的意义**，不要绕过它改账本。

**③ 判据「锁机制」与「锁产品行为」要拆开，而且拆完常常能顺带 +1 双引擎覆盖。** 本批三条
（`rfc341` cutover、`rfc359-w17` boot companion、`rfc349` 原子铸行）拆完都从单引擎变成双引擎，
`rfc359-w5-test-engine-hardcoding` 因此 635 → 634。

### 「删文件」的三条守卫（同一个类一天栽三次，各堵一半）

| 形态 | 症状 | 守卫 |
| --- | --- | --- |
| `scripts/*.ts` 里硬写的源文件清单 | 只在 CI 独有的 lane 里 ENOENT | `rfc359-w14-p0-mutation-verdict`「指纹清单里的路径都还在」 |
| workflow `paths:` 触发器指着旧路径 | **永远不红**，只是覆盖面静默消失 | `test-suite-policy`「workflows / scripts 里带引号的字面仓内路径都存在」 |
| 测试在**模块顶层** `readFileSync(resolve(base,'x.ts'))` | typecheck 看不见（不是 import）；不长成完整字面量，上一条捞不到 | `test-suite-policy`「模块作用域读的源码路径都存在」 |

第三条要静态求值 `resolve`/`join` 的字面量拼接（`import.meta.dir` 取文件所在目录），并有两条
**被真实语料逼出来的**收窄：只认第一段就是绝对路径的拼接（`resolve('a','b')` 落到 cwd，那是测试
自己造的临时文件）、`expect(...)` 词法作用域内的读一律跳过（`expect(() => readFileSync(旧位置))
.toThrow()` 是迁位判据的标准写法）。三条都做过变异验证。

**三条都不在 `tests/architecture/` 下**，按主题挑波及面也捞不到——任何删 / 搬源文件的提交，推之前
单独跑 `bun test tests/rfc359-w14-p0-mutation-verdict.test.ts tests/test-suite-policy.test.ts`。

## 5t. 下一波：resource-catalog 的两条聚合适配器分叉（**未开工，需单独计划**）

同步孪生退役到这里就停了：剩下的 14 个 `DbTxSync` 文件**没有零消费者孤岛**，全部落在
resource-catalog 的两条 `legacy*` ↔ `postgresql*` 分叉上。实测行数（2026-09-11）：

| 分叉 | PG 侧 | legacy 侧 |
| --- | --- | --- |
| intent apply | `postgresqlIntentApplyResourceParticipants`(467) + `…ResourcePorts`(1556) + `…ArtifactOwners`(285) = **2308** | `legacyIntentApplyResourceParticipants`(1062) + `composition/legacyIntentApplyResourceDependencies`(144) + 注入的聚合写手 ≈ **1500** |
| 资源包导入 | `postgresqlResourcePackageMutationParticipants`(1405) + `…MutationArms`(1572) = **2977** | `legacyResourcePackageMutationParticipants`(1275) + `services/bundle/legacyResourcePackageMutationDependencies`(216) + `sqlite/legacyResourcePackageCommit`(796) + `…BundleApply`(652) + `…BundleLower`(324) = **3263** |

注：`postgresqlResourcePackageArtifacts.ts` 已更名合并为中立的 `resourcePackageArtifacts.ts`，
账本注释里的旧数字（489 行那一项）已过期。两条分叉**共用**那 ~1500 行注入的聚合写手
（agent / workflow / workgroup / skill / mcp / plugin），求和时不要重复计。

**为什么不能照前面那样一刀切**：前 9 刀能成立的前提是「同步那面零生产调用方」。这两条分叉
**两面都在生产里跑**（`main.ts:235/250` 按 provider 分别装配），删任何一面都是真行为变更。

**第一步（不是合并，是把对拍补全）**：对拍的**骨架 W12 已经有了**
（`tests/rfc359-w12-resource-package-commit-provider.test.ts`，`describeEachProvider`，两侧
compose 方式与 `main.ts:235/250` 同源），但它**只覆盖 agent / skill 两个 kind**——而分叉里
`commit{Agent,Skill,Mcp,Plugin,Workflow,Workgroup}PackageMutation` 是**逐 kind 一条臂**，
没对拍的 kind 等于两侧各写一份、谁漂了都看不出来。

本轮补了 **workflow / mcp / workgroup** 三条（落行 + 回执 + 重放幂等三件一起看）。
每条都做了变异验证——把对应的 PG 臂写坏一个字段，**只有 `[postgresql]` 那一条新用例红**、
其余全绿，证明新覆盖真的打到了分叉那条臂上：

| kind | 变异点 | 结果 |
| --- | --- | --- |
| workflow | `commitPostgresqlWorkflowPackageMutation` 的 create 臂改写 `description` | 只红 `[postgresql] workflow` |
| workgroup | 同文件 workgroup 臂的 `blackboard: candidate.switches.blackboard` 取反 | 只红 `[postgresql] workgroup` |

**还缺 plugin 一条，且它有一个明确的前置**：两侧现在用的**不是同一个安装器**——legacy 侧
`services/bundle/legacyResourcePackageMutationDependencies.ts:115` 直接绑真实的
`@/services/pluginInstaller#installPlugin`，而 PG 侧的 `composePostgresqlResourcePackageProvider`
收一个注入的 `PostgresqlResourcePackagePluginInstaller`。`composeSqliteResourcePackageProvider`
的依赖只有 `{ db, appHome }`（`resourcePackageOperations.ts:114`），**没有注入口**，所以夹具没法让
两侧跑同一个安装器，对拍没有意义。
**前置**：给 SQLite 那侧补一个与 PG 同形的安装器注入口（生产默认仍绑真实安装器），再写 plugin 对拍。
那是一处真的生产改动，应当与合并同批规划，不要为了一条测试单独塞。

补完 plugin，「合完还等价」才有可验证的基线；在那之前不要动 3000 : 3200 行里的任何一面。

写 fixture 时会撞到的两处（已实撞）：①`manifest.requirements` 与 `collectBundleRequirements(bundle)`
做的是 **`JSON.stringify` 逐字比对**，所以 YAML 里的键序必须与 collector 的返回对象一致
（runtimes / codeHosts / executables / pluginSources / projectSkills / mcpKinds / humanMembers），
全空时写 `requirements: {}` 才对（zod default 会按 schema 序补齐）；②工作流节点是
`{ id, kind, inputKey }` 而不是 `{ id, type, data }`，且导入会把 `$schema_version` 升到当前版本
（本轮实测 1 → 6）——那个升级正是要两个引擎逐字一致的东西。

## 6. 债与不做的事

- `legacySqlite*` 家族（clarify 子系统 3,401 行等）合一后仍带 legacy 命名与分层位置；
  **本 RFC 不迁**，随各 context 下一个 RFC 归位（design §1）。
- `workgroupTurns` 两侧是两套独立引擎（839 行 ↔ 2,801+561 行），**未做逐方法对拍**，
  分歧面可能比已发现的还大。**建议单独立一轮对账**，其结论可能给 W4-B1 增批。
- 前置对账的 5 条存疑项（Q1–Q5）不在本 RFC 范围，随 W4 各批顺带确认或销账。

### W7 发现的三处「合不了」，与「还没合」要分开记

这三处不是排期问题，是**结构上就绑死在一个引擎**，合一之前先要改形状。它们此前不在任何账本里
（成对账本只数「同名两份实现」，这三处不是那个形状），先记在这里：

- **`modules/integration/infrastructure/developmentToolConnectionStore.ts:43-53`** —— 读用
  bun:sqlite 的**同步** `.get()` / `.all()` 且**不 `await`**。换成 PostgreSQL 客户端时这两个
  方法返回的是 Promise，于是 `row === undefined` 永远不成立、`identityRow(promise)` 拿到垃圾。
  它**结构上只能跑 SQLite**——不抛错、不报警，只是悄悄产出错的数据。合一的前置是先把它改成
  异步读。（PG 侧另有自己的工厂，所以现状不是 bug；但那也意味着这一对永远是两份实现。）
- **`composeSqlite/PostgresqlResourcePackageApplyMaintenance` 的 API 不对称** —— SQLite 侧要调用方
  传 `activitySource`、不暴露 tracker；PG 侧自带内部注册表并多暴露一个 `activityTracker`。
  两者**调用点无法互换**，合一前要先把端口对齐。
- **`composePostgresqlTaskSourceTermination`** —— 两个引擎都构造得起来（组合根覆盖已证明），
  但它包的 participant 只在 PG 上真正 apply（`withPostgresqlSerializableTaskExecution`）。
  「装配得起来」不等于「跑得通」，这一对的覆盖要按后者写。

### 同步事务面是死代码清理的**前置**，不是可以往后放的债

W7 实测：`sqliteTerminalMaintenance.ts`（519 行）删不掉，唯一原因是三处服务要的是同步端口
（`assertClaimTx` / `transitionTx` 挂进各自的 `dbTxSync` 大事务），中立参与者是 async 进不去。
凡是「SQLite 侧薄壳 + 成熟同步机器」的形状都会撞到同一堵墙——**先清同步事务面，才轮得到删重复实现**。

## 7. 风险

| 风险                                        | 缓解                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| W2 的单写者租约改变 SQLite 吞吐特征         | T13 基准实测；结果不可接受则回到「两套事务机制 + 上层一份实现」的退化方案（代价是 design §3 的统一性打折） |
| W4 体量大、跨 6 个 context、与并发 RFC 撞车 | 每 context 一个 PR；合一时只动 provider 维度，不顺手重构；撞车面按 CLAUDE.md 多人协作规则处置              |
| 合一过程中把 SQLite 侧的正确行为改坏        | 每对合一都带「合一前后 SQLite 行为逐字对拍」（AC-8）                                                       |
| P0 修复本身引入回归                         | 每条先红后绿 + 修完再跑一次原变异确认转红（RFC-287 五轮门纪律）                                            |

## 5u. AC-6 迁移当天抓出的三处真分叉（W58，**已修**）

AC-6 的价值在这一轮被兑现了一次：`rfc109-sync-route.test.ts` 只是从「写死 SQLite」改成
双引擎，**什么产品代码都没动**，当天就红出三条 PostgreSQL 专有缺陷。三条都属于本 RFC 要消灭的
形态——同一份产品行为在两个库上给出不同答案，而两边各自的用例都绿着。

### ① lineage 列为 NULL 的任务，其 continuation 在 PG 上**全部**死锁

`tasks.execution_lineage_id` / `lineage_slot_path_json` 允许为 NULL。派生 continuation 请求的
一侧（`submitTaskContinuation`）遇到 NULL 会以任务自身为根派生一份作用域；而准入那一侧
（`submitCanonicalTaskExecutionIntent`）的 lineage 判据直接拿派生后的请求去比**原始列**：

```
request.scope.executionLineageId !== task.executionLineageId   // 'task-x' !== null ⇒ 永真
```

于是这类任务的每一次 sync-workflow / resume / retry 都在准入这一步 409
`task-continuation-stale`，**没有任何推进办法**。这条准入只在 PostgreSQL 上跑
（SQLite 的 route operations 不走 intent 准入），所以它是典型的「一个库好、另一个库不好」。

处置：派生与复核共用 `domain/executionIntent.ts` 的 `canonicalTaskLineageScope`。
回归防护 `tests/rfc359-w58-continuation-null-lineage.test.ts`（纯函数 3 条 + 双引擎行为 1 条
+ 源代码层 2 条），已变异验证：把复核改回比原始列 ⇒ 3 条红。

**顺带确认的一处引擎不对称**（不是本次修的）：SQLite 有迁移 0210 的
`rfc328_tasks_lineage_after_insert`，任何绕过生产工厂的写入者（测试、任务迁移 SQL、直连 SQL）
落的行都会被它悄悄补齐两列；PostgreSQL 的 DDL 由 `db/schema.ts` 投影，**一个触发器都没有**。
迁移 0224 退役 `node_runs` 上的同名触发器时已经论证过这个形态为什么危险，但 `tasks` 上那条
被留了下来（理由：四个生产插入点由 `rfc359-w7-task-insert-lineage-completeness` 钉着显式写三列，
触发器够不着）。这次的 bug 说明「够不着」只对生产路径成立：**非生产写入者仍然在两个引擎上落出
不同的行**，于是 PG 独有的 NULL 状态长期没有任何用例覆盖。应用层现在对 NULL 是容忍的
（`canonicalTaskLineageScope`），所以退役这条触发器的前置条件已经具备——留给下一波，
连同一次「SQLite 上删触发器后全量跑一遍」的验证。

### ② 内置工作流在 PG 上被预览成「工作流已删除」

SQLite 的 `computeWorkflowSyncPreview` 一上来就看 `workflow.builtin`，回 `builtin-workflow`
（RFC-104：内置工作流永远不能被手动 sync；前端据此隐藏同步横幅，Codex impl-gate F4）。
PG 侧压根不看这一列，而它装载工作流走的是**可启动性**授权，内置工作流在那里就被挡下，
异常被 catch 兜成 `workflow-deleted`——横幅写「工作流已被删除」，而工作流好端端地在。

### ③ 预览说能同步、按钮必然 409

SQLite 的可同步判据是**持久化**任务状态（`allowedFromForTaskEvent`）+ 工作树；PG 的预览看的是
**进程内**活跃表 `activity.isActive`。于是持久化状态就是 `running` 的任务——守护进程刚重启、
或任务由另一个进程在跑——在 PG 上预览成 `syncable: true`，而真点下去，`syncWorkflow` 用的又是
状态判据，稳定 409 `task-not-syncable`。

②③ 的处置：两条判据落进 `domain/workflowSyncPreview.ts`
（`builtinWorkflowSyncPreview` / `workflowSyncGateReason`），两个 provider 都从那里取；
legacy `services/task.ts` 经 `public/participants.ts` 取用（RFC-317 T22 边界）。
回归防护 `tests/rfc359-w58-workflow-sync-preview-parity.test.ts` + 行为面在
`rfc109-sync-route.test.ts` 上两个引擎各跑一遍。

**留下的一条差异（本次没动）**：PG 的 `syncWorkflow` 有一条 `workspacePrunedAt !== null` 的
工作树判据，SQLite 的 `syncTaskWorkflow` 没有（它只看 `worktreePath === ''`）。预览这一侧现在
两边逐字相同（只看空路径），所以**预览不再与 SQLite 分叉**；但 PG 的「动作」比 SQLite 严一档，
对已打墓碑的工作树两边给出不同答案。收敛它要先决定哪一侧是对的（直觉上「墓碑了就不能同步」
是对的，那意味着改 SQLite 的动作），并且这条判据应该走 `shared` 的 `taskWorkspacePhase`
单一事实源——而那个函数要 `hasRepoPrepRow`，得先给两侧的读补上这一列。独立一刀。

### 这一轮的方法论结论

**「把一个单引擎用例改成双引擎」本身就是一次审计**，而且成本极低——三条缺陷都不是靠读代码
发现的，是迁移当天测出来的。AC-6 剩下的量（`rfc359-w5-test-engine-hardcoding` 账本 604 行）
应当按「先迁行为面最厚的文件」排序，而不是按最好迁的排序。

## 5v. AC-6 第二批 secretBox 文件（W58）：一条装配合同的不对称

`createProviderHttpApplication` 暴露 `SecretBox` 之后，19 个带 `secretBox` 的单引擎 HTTP 文件
解锁。本批迁了 5 个（账本 604 → 600）。迁移当天两个引擎**一起**红出来的两条（都是迁移姿势
问题，不是 provider 分叉，但值得记下形态）：

- **加密列夹具必须用应用那个盒子**。`rfc220-oauth2-callback-route` 用自己 `randomBytes(32)` 新
  建的盒子去写 OIDC provider 的 `client_secret`（加密列），而回调链上应用用的是作用域装进去的
  那一个——解出来是乱码，5 条用例全红。修法：`const { app, secretBox } = await scope.open()`。
- **守护进程配置必须并进作用域现建的那份 config**。`rfc247-mcp-transport` 自建 app home 写
  `mcpSurfaceEnabled: false`，而应用读的是作用域的 config，开关整份被绕开——「关掉开关应当拒绝」
  的两条用例拿到 200。修法：`scope.open({ config: { mcpSurfaceEnabled: … } })`。
  （同一形态此前在 `plantuml-proxy` 上撞过一次，`open({ config })` 这个口子就是那次加的。）

### 真正的发现：**「没有 secretBox 的部署」这个状态只在 SQLite 侧存在**

`rfc221-login-policy-routes` 有一条判据专测「部署没有密钥 ⇒ 公开 OIDC 路由 fail closed
（503 `oidc-not-configured`）」。它原本**故意不给** `createApp` 传 `secretBox`。

这条接不进双引擎，原因不是迁移姿势，是**两侧的装配合同不对称**：

| | `secretBox` |
| --- | --- |
| `AppDeps`（SQLite 侧 `createApp` / `composeSqliteApplicationDeps`） | `SecretBox \| undefined` |
| `PostgresqlApplicationInput`（`composePostgresqlApplication`） | `SecretBox`，**必填** |

也就是说「无密钥部署」在 PostgreSQL 上按构造不存在——PG 守护进程根本组装不起来。这不是
bug（PG 部署一定有密钥），但它是**一条没有写明的能力差**：同一份产品在两个 provider 上可达的
部署形态不同。处置：那一条判据显式留在单引擎 `createApp` 上并在块内注明理由，**不是**「还没迁」。
要收敛的话得先决定「PG 是否也支持无密钥部署」——那是产品决定，不是重构，本 RFC 不替它做主。

### 顺带清掉的两处测试夹具类型债

`memoryCatalogOf` 与 `updateAuthLoginPolicy` / `setPasswordLoginEnabled` / `setOidcDefaultRole`
的入参此前写的是 `DbClient`，而它们的函数体**早就是中立的**（前者把 db 转手交给两个收
`ProviderNeutralDatabase` 的 composer，后三者走 `databaseSessionFor(db).transaction` + await 的
select）。纯类型债，却把这些夹具挡在双引擎用例之外。已改成 `ProviderNeutralDatabase`；
同文件里真正同步的那几个（`getAuthLoginPolicy` / `isBootstrapRequired` 用 `.get()`）没动。
20 个消费者文件全部跑过（227 pass / 0 fail）。

## 5w. AC-6 第三批（W58）：并发池的 scope key 按 provider 不同——判据不能自己猜

账本 600 → 598（`rfc324-acl-wire-contract` / `rfc266-concurrency-hot-apply`）。

`rfc266` 迁过去当天 **只有 PostgreSQL 侧红三条**（「PUT /api/config 应当当场改两个守护进程池的
容量」）。查下来**不是产品缺陷**，是判据自己猜错了 key：

`getNodePoolSemaphore(daemonScope, kind, capacity)` 的池注册表是一张按 `daemonScope` 键的
WeakMap，而这个 scope **按 provider 不同**：

| | `processConcurrencyScope` |
| --- | --- |
| SQLite | `db`（运行时参与者 + `composeLegacyConfigConcurrencyHotApply(deps.db)`） |
| PostgreSQL | `provider.runtime`（`cli/postgresqlDaemonApplication.ts` 的两处） |

两侧**各自内部一致**——配置路由与任务引擎用的是同一个 key，所以热应用在两个 provider 上都正确。
不一致的是用例：它直接拿 `harness.db` 当 key，那只在 SQLite 上碰巧等于真 key，在 PG 上取到的是
另一个命名空间里的**空池**，于是判据静默失效（池永远是新建的，容量当然不变）。

处置：`createProviderHttpApplication` 暴露 `processConcurrencyScope`——**问装配要 key，不要自己
构造**。这是给「检查守护进程级单例」这类判据的通用口子，不止这一个用例。

### 一条测量口径的提醒（本轮实撞）

给这个口子写注释时，顺手按本仓规矩写了 `sqliteTaskExecutionRuntimeParticipants.ts:77` 这样的
file:line 锚点，`rfc359-w5-t19d` 的成对覆盖账本**当场从 10 vs 6 变成 11 vs 6**——它是按**文本**
数「对某侧适配器的引用」的，一句注释也算一次。这不是账本的错，也不该靠改账本掩盖：注释改成
不写死那个 token（给出 `grep -rn processConcurrencyScope src/` 让人自己查），账本回到原值。
**写注释时提到某侧适配器的文件名，会让成对覆盖数失真**——提这一嘴，免得下一个人也撞。

## 5x. AC-6：`beforeAll` 一族的迁移形态（W58，`rfc310-pr6-evidence-read`）

账本 598 → 597。这一个文件值得单独记，因为它代表**一整类**还没迁的文件的形态。

原文件的结构是「整个文件共用一份自建内存库 + 一个 `beforeAll` seed + `afterAll` 里
`db.$client.close()`」。接双引擎时这三件事都不成立：

1. **`beforeAll` 里读不到 `scope.harness.db`**。harness 明确只在 test 体内（`beforeEach` 之后）
   给库——`eachProvider.ts` 的 getter 直接抛
   「ProviderHarness 只能在 test 体内读取」。这不是限制，是语义：**库每个用例前重置**，
   `beforeAll` seed 的数据第一条用例跑完就没了。所以 seed 必须搬进 `beforeEach`。
2. **`afterAll` 里不能关库**。库归 harness 所有，用例自己关它会把后面的用例一起带走。整段删掉。
3. **app home 不是模块加载时那个**。原文件在 import 之前就 `process.env.AGENT_WORKFLOW_HOME =
   HOME`（为了 `Paths.root`），然后夹具往 `join(HOME, 'evidence')` 写证据文件。而作用域装配的
   应用用的是**它现建的那个 appHome**，于是路由一路 404、夹具自己却一切正常。
   修法：`const opened = await scope.open()` 之后往 `join(opened.appHome, 'evidence')` 写。
   模块级的 `HOME` 保留——它只为 import 期的 `Paths.root` 存在。

另外这个文件里第一个 describe 是**纯函数**（`readEvidenceFileRange` 配一个 `blobPath` 桩），
不碰库也不碰应用，保持普通 `describe`：包进双引擎壳只是白起两套应用。
**「一个文件里哪些 describe 该进壳」按它是否真的触达 db / app 判断，不是整文件一刀切。**

## 5y. AC-6 第五批（W58）：作用域补 `bootstrap` 直通；请求时读文件的路由不需要各建应用

账本 597 → 594（`daemon-info-route` / `rfc221-bootstrap-auth` / `rfc221-account-auth-policy`）。

两个可复用的迁移结论：

- **`bootstrap: 'required'` 要直通**。`rfc221-bootstrap-auth` 测的是「还没有管理员」这个状态，
  它原本靠 `createInMemoryDb(MIGRATIONS, { bootstrap: 'required' })` 造出来；harness 默认会把
  `auth_login_policy` 标成已 bootstrap，不直通这个选项整条判据就没了（会静默变成「已 bootstrap
  的库上测 bootstrap 流程」，几条 401/403 判据全部失去意义）。作用域现在把它转给
  `describeEachProvider`。
- **请求时才读文件的路由，不需要为每个被测状态各建一个应用**。`daemon-info-route` 原本
  `makeApp(daemonInfoPath)` 三次、每次指一个不同的临时文件。而
  `routes/daemon.ts` 是在 handler 里才 `readDaemonInfo(...)`，所以装配一次、装配后**写不写**
  `<appHome>/.daemon.info` 就是「文件在 / 文件不在」两种状态。少起两套应用。

另：`rfc221` 两个文件里的 `.get()` / `.all()` 读回断言改成 await 的语句
（`const [row] = await db.select()…` / `await db.select()…`）——`test-suite-policy` 那条守卫盯的形态。

## 5z. AC-6 第六批（W58）：两条「不是还没迁，是没法迁」的记账

账本 594 → 590（`cached-repos-http-batch` / `routes-session` / `rfc201-mcp-exact-operation` /
`rfc101-builtin-list-hidden`；另 `rfc222-task-delete` 除一条外全迁）。

### ① PG 侧的 `task-active` 删除闸门**没有任何用例覆盖**（真缺口，待补）

`rfc222-task-delete` 的「active-in-memory（已取消但 controller 还活着）⇒ 409 `task-active`」
这一条迁不过去。两侧的**产品判据其实同形**——都是「本进程还有没有 driver 在跑这个任务」：

| | `activity.isActive` |
| --- | --- |
| SQLite | `isTaskActive` = `runtimeRegistry.hasTask(id) \|\| testActiveControllers.has(id)` |
| PostgreSQL | `(id) => executionModule.runtimeRegistry.hasTask(id)` |

差的是后面那个**测试注入项**：`__setActiveTaskForTesting` 往 `testActiveControllers` 里塞，
只有 SQLite 那一支读它。而且两侧锚的还不是同一个模块实例（SQLite 用进程级单例
`taskExecutionModule`，PG 用 `createProviderTaskExecutionModule` 装配出来的那个）。

后果不是「迁移做不完」，是**PG 侧这条闸门今天零覆盖**。处置：那一条显式留成单引擎
`describe` + `createApp` 并在块内写清理由（不用条件 skip——`test-suite-policy` 盯静默弱化）。
补法二选一，都不该夹在用例迁移里做：
- 给夹具加一个 provider 中立的「把任务标成在跑」口子：SQLite 走现有钩子，PG 往
  `selected.executionModule.runtimeRegistry` 注册（`SelectedPostgresqlTaskExecutionProviderRuntime`
  已经把 `executionModule` 暴露出来了，HTTP 夹具也已带 `taskExecution.selected`）；
- 或先统一两侧锚执行模块实例的方式。

### ② WebSocket 那两个文件卡在**真正的成对适配器**上

`ws.test.ts` / `rfc152-ws-frame-gates.test.ts` 用
`composeTestSqliteRealtimeRuntime`，它底下是 `composeSqliteRealtimeRuntime`——
`modules/runtime-management/composition.ts` 里 `db: DbClient` 与 `db: PostgresqlDatabaseClient`
**两个声明**，是登记在册的成对实现，不是类型债。要迁这两个文件，得先合这一对
（W4 那条线的活）。本轮原样退回，不做半吊子。

### 顺带清掉一处 src 类型债

`listWorkflows(db: DbClient)` 的函数体就是一条中立 select，同文件的 `getWorkflow` 早已是
`ProviderNeutralDatabase`。改成中立——纯类型债，却把这个读面挡在双引擎用例之外。

### 迁移工具的一个坑

`rfc201-mcp-exact-operation` **本来就已部分双引擎**（`describeEachProvider` + 一份本地 provider
夹具），只剩一条用例还在单引擎 `harness()` 上。机械地在外层再包一层 `describeEachProvider*`
会造出 `[postgresql] > … > [sqlite]` 的**交叉积**，两层 harness 还互不相干。
正解是把那一条补进已有的 `describeEachProvider` 里。**迁移前先 grep 文件里有没有
`describeEachProvider`。**

## 5aa. 迁移工具本身的一个坑（W58 实撞，已记进 dev-gotchas）

账本 590 → 589（`auth-self-service-idor`）。这一批只落了一个文件，因为撞上了一件更值得写下来的事。

批量迁移用的脚本按**单行正则**扫 `createApp({…})` 的选项键。而那些测试注入依赖
（`runtimeDiagnosticTestDependencies` / `mcpRuntimeTestDependencies` / `intentTestDependencies`
/ `executionContracts` / `webhookDispatcher`）的值几乎都是**跨多行的对象字面量**，于是被**静默
丢掉**——迁出来的应用少装一份依赖，而脚本还报告「选项集合是标准五项」。

`rfc135-runtimes-status` 就是这么坏的：`runtimeDiagnosticTestDependencies` 里的
`probeTimeoutMsForTest` 与桩二进制注入整块消失，探测改打真机 PATH，hang 用例 5s 超时。
**这次是红的，所以被抓住了；下一次可能是绿的**——注入的若是「把某个开关关掉」这类依赖，
用例照过，判据已经空了。

已做三件事：
1. **回退** `rfc135-runtimes-status`（它需要的依赖今天接不进共用作用域，保持单引擎）；
2. **审计本轮此前已迁的全部文件**，逐个比对迁移前的 `createApp` 选项键——只出现过 `secretBox`
   与 `daemonInfoPath` 两种，都是作用域已提供且我显式接了的，**没有文件因此少装依赖**；
3. 把「迁移前逐字核对 `createApp` 选项」与「迁移前先 grep `describeEachProvider`」写进
   `docs/dev-gotchas.md`。

**结论对后续批次的约束**：带 `*TestDependencies` 的文件（`rfc135-runtimes-status` /
`runtime-routes` / `rfc238-mcp-runtime-test-http` / `rfc349-mcp-runtime-test-daemon-identity` /
`rfc355-intent-session-event-callsites` / `rfc317-runtime-spawn-capability-guard` /
`rfc349-execution-contract-postgresql-adapter`）**先别迁**——要么给作用域加一条通用的
「额外 createApp 依赖」直通口，要么就接受它们留在单引擎。这是个设计决定，不该在批量迁移里顺手做。

## 5ab. AC-6：迁移后**真库往返多的用例会越过 bun 的 5s 默认预算**（W58）

> **勘误（同一轮内更正）**：本节初稿把因果写反了，说这是「用例遗留在途请求 ⇒ harness 拆库挂死」，
> 还给出了一条「见到 55006 就去找在途请求、别调预算」的指引。**那条指引是错的，会让人追一个不存在
> 的 bug**。查清楚的真相在下面。初稿的结论之所以站不住，是因为我只看了症状里最刺眼的那两行错误，
> 没有先去数这条用例到底做了多少次真库往返。

### 真相

`rfc190-overview-route` 里那条用例是

```
for (const who of [alice, bob, carol, admin])   // 4 个 actor
  for (9 个列表端点) await req(...)              // 每个都是一次真库 HTTP 往返
```

**36 次真库往返**。迁移前它跑在同步内存 SQLite 上，一两秒；迁到 PostgreSQL 之后它本身就越过了
bun 的 **5s 默认用例预算**。

`PostgresError: Connection closed` 与 `cannot drop the currently open database`(55006) 是**超时之后
的余波**——预算到点，bun 往下走，harness 开始 DROP 这个文件的专属库，而超时那条用例的请求还在跑。
它们是结果，不是原因。

### 处置

给那一条用例与它实际工作量相称的预算（`}, 60_000)`），并在旁边写明「36 次真库往返」。
`rfc099-resource-routes` 同理，重测后无需额外预算。三个文件放在一起**连跑 6 次全绿**
（此前同一组必然在两三次内红一次）。

### 留下的判断方法

看到 hook / 用例超时，先问**这条用例在真库上要做多少次往返**，再决定是调预算还是找 bug：
- 往返次数明显很多（循环 × 多端点）⇒ 就是预算，给一个与工作量相称的数字，别用默认值撞运气；
- 往返很少却仍超时 ⇒ 才去找没 await 的调用 / 在途请求。

（另一处**确有**预算问题的地方是 `eachProvider` 的 PG `beforeEach` 快照回滚，已单独给
`databaseCount × 30s`——那一处也是先数清它做什么、再给数字。）

## 5ac. AC-6 第九批（W58）：四个候选只过了一个——记清**三种不同的「过不去」**

账本 583 → 582（`rfc223-pr1-impl-gate`）。另三个各自卡在不同的东西上，区分清楚很重要，因为
**处置方式完全不同**：

| 文件 | 卡在哪 | 这是什么 | 怎么办 |
| --- | --- | --- | --- |
| `rfc099-ws-acl-filter` | `composeTestSqliteRealtimeRuntime` → `composeSqliteRealtimeRuntime` / PG 双声明 | **登记在册的成对实现** | 先合那一对（W4 线） |
| `rfc218-agent-launch-ports` | `composeSqlite/PostgresqlAgentLaunchResourceOperations` **签名不同**（PG 侧还要 `agents` / `workflowValidation` 两个协作者） | **构造面不对称的成对适配器**（同 plan §6 记的 `ResourcePackageApplyMaintenance`） | 先把端口对齐 |
| `rfc223-pr3b-dynamic-token` | `resumeDynamicWorkflowExecution` 要 `StartTaskDeps.db: LegacySqliteTaskDatabase` | **legacy 契约上的 SQLite 绑定** | 随 legacy 那条线 |

**顺带一个有用的对照**：`composeSqliteResourceCatalog` / `composePostgresqlResourceCatalog` 看起来
也是一对，其实两个都只是 `composeResourceCatalogFor`（收 `ProviderNeutralDatabase`）的**类型窄化
壳**——**不是**两份实现。双引擎用例直接调中立的那个即可，不需要改 src。
**看见 `composeSqlite*` / `composePostgresql*` 成对出现，先点进去看是不是同一个函数**，
别一见名字就判定「成对适配器，迁不了」。

**另记**：`rfc223-pr3b-dynamic-token` 除类型问题外，还有一条判据在 PG 上**稳定失败**
（`generate maps tokens to both frozen ids and execute selects each exact runtime profile`，三次
跑三次红）。它今天被类型错误挡着跑不完，等上面那条 legacy 绑定解开后**要专门看这一条**——
稳定失败往往意味着真分叉，不是夹具问题。

### 工具修复

`unwrap.py`（把纯函数 describe 从双引擎壳里取出来的脚本）在跳过「确实要保留」的调用时，
用 `m.end()-1` 起切会把 **describe 的名字实参一起吃掉**，于是同文件其余 7 个调用全部变成
`describeEachProviderHttpApplication({…})`（少一个参数）。已修成只替换函数名、保留实参。

## 5ad. AC-6：矩阵型用例的壳要套在**循环外面**（W58）

账本 582 → 581（`rfc099-acl-endpoints-matrix`，一个文件 **158 条**双引擎用例，本轮单文件最大）。

这个文件的形态是**模块层的 `for` 循环产出一组 describe**：

```ts
for (const rc of CASES) {          // 每个资源类型一轮
  describe(`… ${rc.type}`, () => { … buildHarness(scope, …) … })
}
```

两个坑：

1. **壳要套在 `for` 外面**。套在里面就是「每个资源类型各起两套应用」——这张矩阵有 7 个资源类型，
   等于白起 12 套。套在外面，整张矩阵在两个引擎上各跑一遍，应用按用例复用。
2. **批量脚本只认列首的 `describe(`**，循环里的那些缩进了两格，扫不到；而线程 `scope` 的那一遍
   却会把循环体里的 `buildHarness(scope, …)` 改掉 ⇒ 出来一个 `scope is not defined`。
   **迁移前先看这个文件的 describe 是不是循环产出的。**

（同一轮里三个候选被脚本**拒绝**而不是硬迁：两个找不到 `token` 选项、一个触发 runaway 保护，
文件原样未动。上一节那次「静默丢选项」之后这是想要的行为——**宁可拒绝，不要产出看着像对的东西**。）

## 5ae. AC-6 剩余量的**分层实测**：「83 个待迁」里只有 40 个是省力的（W58）

一批三个大文件（`review-state-machine` / `rfc326-review-decision-batch` / `tasks`）**全军覆没**，
都不是迁移姿势问题，而是卡在**SQLite 绑定的测试基建**上。这促使把剩余量按「卡在什么上」分层实测，
而不是只报一个总数：

| 层 | 数量 | 卡在什么 |
| --- | --- | --- |
| **省力入口** | **40** | `createApp` 选项标准 **且** 不碰 SQLite 绑定的测试基建 |
| 需要装配面变更 | 18 | 基建干净，但带 `AppDeps` 独有的注入缝（`PostgresqlApplicationInput` 上没有，见 §5aa） |
| 卡在测试基建 | 25 | 下面这几样 |

### 第三层的具体形态（这一层**不是迁移问题**）

- `createTaskExecutionTestTopology` / `runTaskWithRealTestTopology` —— 名字看不出来，但它内部直接
  composes `createSqliteTaskExecutionPersistence` / `sqliteMemoryInjectionQueries`，**按构造只跑
  SQLite**。凡是要真 scheduler 拓扑的用例都卡在这里。
- `composeTestSqliteRealtimeRuntime` —— 底下是登记在册的成对实现（§5ac）。
- `StartTaskDeps.db: LegacySqliteTaskDatabase` —— legacy 契约上的 SQLite 绑定。
- 用例自己 `db.$client.close()` —— 库归 harness 所有，这行在双引擎下本来就不该有（§5x）。

**结论**：AC-6 剩下的不是「再迁 83 个文件」这种匀质工作量。省力那 40 个迁完之后，
**真正的瓶颈是把上面这几件测试基建中立化**——尤其 `createTaskExecutionTestTopology`，
它一个就挡着一批要真 scheduler 的用例。那是一刀独立的活，值得单独排。

筛子命令写进了 `STATE.md`，可复跑。

## 5af. 下一刀的具体形状：`createTaskExecutionTestTopology` 中立化（**未开工，已踩点**）

§5ae 指出它一个就挡着约 25 个用例。这里把「怎么做」踩到可以直接排期的程度。

### 为什么不能照字面改

`composeTaskExecutionTestRuntime(db)`（`tests/helpers/taskExecutionTestTopology.ts:66`）直接
composes SQLite 的那一套：`createSqliteTaskExecutionPersistence` /
`createSqliteTaskExecutionRuntimeParticipants` / `sqliteMemoryInjectionQueries` /
`composeSqliteDynamicWorkflowPersistence`。

照字面「加一个 PG 分支」要在测试夹具里把 PG 侧的参与者重新接一遍，而两边的依赖集**差 6 个字段**：
PG 侧额外要 `taskDagCollaboration` / `childLaunchWorkgroup` / `processConcurrencyScope` /
`daemonGeneration` / `finalizeWorkspace` / `log`，且 `codeHostConnections` 从可选变必填。
在夹具里复刻这套接线＝把 `cli/postgresqlDaemonApplication.ts` 抄一遍，**抄错了还不会报错，
只会让一批用例在 PG 上测了个假拓扑**——正是本轮反复踩的那类坑。

### 该走的路：问装配要，不要重接

`composition/providerRuntime.ts` 里**已经有**两侧共同的选择器
（`SelectedTaskExecutionProviderRuntimeBase` 暴露 `runtime: TaskExecutionRuntime`，
里面就有 `schedulerDriver`），daemon 用的就是它；而共用 HTTP 夹具
`createProviderHttpApplication` 在 PG 分支上**已经把 `taskExecution.selected` 递出来了**。

所以形状应该是：`createTaskExecutionTestTopology` 不再自己 compose，而是**从已装配的应用
（或同一个 provider-runtime 选择器）取 topology**，再在其上套 `driver: 'real' | 'noop' | 'poison'`
那层选择。这和本轮已经做过三次的「问装配要 key / 要盒子 / 要 config」是同一个原则
（§5v / §5w / §5x），也是唯一能保证「测试拓扑 == 生产拓扑」的做法。

### 排期时要注意的两件事

1. `driver: 'noop' | 'poison'` 是**测试专用语义**，要想清楚在「取自装配」的形态下挂在哪一层；
2. 调用方基数大（约 25 个用例文件），建议先改夹具并让它在 SQLite 上与现状逐字等价（零行为变化），
   再逐批把用例切到双引擎——**不要一次同时改夹具与用例**，否则红了无从归因。

## 5ag. ~~第四条能力不对称：`confirmGate` 的 `assertResumable` 按**部署形态**注入~~（**结论已推翻，见 §5ah**）

账本 579 → 578（`users-http`）。同批 `rfc164-workgroup-room` 迁过去之后 PG 侧**稳定红一条**
（`上线前加固：confirm 恢复失败时 gate、holder 与消息全部保持可重试`，期望 410 得到 200）。
当时的结论是「**不是 PG 缺陷，是既有的、有明确理由的部署形态差异**」。
**这个结论是错的**——它照抄了源码注释里的理由，没去核对那个理由在今天的代码里成不成立。
下面整节保留作为**判断失误的记录**，正确的处置见 §5ah。

`confirmGate`（`resource-catalog/infrastructure/workgroupTaskRoomCommands.ts`）在写任何一行之前
调 `dependencies.continuation.assertResumable`。这个依赖**按部署形态注入**——源码原话是
「两件按**部署形态**（不是按数据库）分」：

| 部署形态 | `assertResumable` | 用户看到什么 |
| --- | --- | --- |
| 单进程（SQLite 部署） | `composeWorkgroupTaskRoomContinuationDriver` 注入真实现，撞一次 `assertWorktreePresentForResume` | 工作树没了 ⇒ **410**，闸门 / holder / 消息随事务回滚，决策可重试 |
| 多进程 daemon（PG 部署） | `cli/postgresqlDaemonApplication.ts` 注入**空操作**（受理请求的进程未必看得到该任务的工作树、也未必该驱动它） | **200**，改由 daemon 的 `human-gate-continuation` worker 轮询认领 |

同一个请求在两种部署上本来就给不同答案。那条判据锁的是前者，**接不进双引擎**，
文件原样退回。

### 但这里有一个真的覆盖缺口

**PG 那条「200 + 异步认领」的路径今天没有任何用例覆盖。** 单进程那条有（就是上面这条），
多进程那条一条都没有。补法是另写一条：确认 200 之后 worker 认领、并最终把任务推进或落回可重试态
——需要在夹具里把 `human-gate-continuation` worker 跑起来，是独立一条用例，不是把现有这条改双引擎。

### 与前三条的关系

这是本轮记下的第四条「不是还没迁、是迁不了」，而且是**理由最充分**的一条：
前三条（无 secretBox 部署 / PG 的 `task-active` 测试钩子 / WebSocket 成对适配器）多少还有
「应该收敛」的余地，这一条是**设计上就该按部署形态分**。记在这里是为了让后来人一眼分清
「该收敛的分叉」与「本就该不同的部署形态」——把后者也硬掰成一致，反而是错的。


## 5ah. 更正 §5ag：那个空操作不是部署形态，是**实打实的功能缺陷**（已修）

账本 578 → 576（`rfc315-event-automation-permissions` + `rfc164-workgroup-room`）。

§5ag 把 PG 侧的空操作判成「设计上就该按部署形态分」，依据是 `services/task.ts` 里那段注释：
「多进程 daemon 部署两件都做不了（受理请求的进程未必看得到工作树、也未必该驱动这个任务）」。
**照抄注释，没去核对。** 核对之后事实是：

- 两个部署的 `human-gate-continuation` worker **都跑在同一个 daemon 进程里**
  （`cli/start.ts:590` 单进程那条、`cli/start.ts:2570` PG 那条），工作树对受理请求的进程
  是可见的。所谓「看不到工作树」的多机形态，今天的代码里**不存在**。
- 于是那个空操作的净效果只有一个，而且是用户可见的：工作树被 GC 回收之后，
  `confirm/approve` 在 SQLite 上是 410（闸门与消息随事务回滚、决策可重试），
  在 PG 上是 **200**——闸门就地关上、holder 释放，随后 worker 驱动失败**只打一行 warn**
  （`cli/start.ts:580` 的 `onError`），任务**永久搁浅**，且没有第二次 confirm 的入口。
  这正是那条用例（「上线前加固」）当初被写下来要挡的回归，只不过它此前只跑 SQLite，
  所以 PG 这半从来没被看住。

用户对本 RFC 的要求原话是「以后不允许再出现两种数据库一个好一个不好的分支」。
一个 provider 410 可重试、另一个 200 永久搁浅，正是那种分支。已修：

- 判据本体从 `services/task.ts` 的私有函数搬进
  `modules/task-execution/application/worktreeResumePreflight.ts`，经
  `public/participants` 暴露。两个依赖都是 neutral（`TaskRouteOperations.get` 与
  `TaskRecoveryOperations` port），所以**没有任何 provider SQL 要复制**——
  这也说明「做不到」从来不是技术原因。
- PG 部署注入 `composeWorktreeResumePreflight({ getTask, taskRecoveryOperations })`，
  与 SQLite 同一份判据；两边 44 条用例全绿。
- `driveAfterCommit` **仍是** PG 侧空操作：「谁驱动这个任务」才是真按部署形态分的那一半
  （单进程就地驱动到底、PG 交给 worker 轮询认领），预检不是。
- 那条用例顶端写清了「PG 那半当初是红的、别把任一边再退回空操作」。

**方法论教训（已进 `docs/dev-gotchas.md`）**：迁移撞到「某 provider 这条过不了」时，
源码注释给出的理由**必须逐条核对到今天的代码**再采信。这次注释写的多机形态并不存在，
照抄它就等于把一个实打实的搁浅缺陷记成了「设计如此」，还顺手把用例退回单引擎——
等于亲手把发现缺陷的那只探针拆了。§5ag 保留原文，就是留着这个反例。

### §5ag 里那条覆盖缺口仍然成立

PG 侧「200 + worker 异步认领」的**正常**路径（工作树在、worker 顺利驱动）今天仍无用例覆盖。
现在预检统一之后，它不再兼任「工作树没了」的兜底，缺口范围反而更清楚了：需要在夹具里把
`human-gate-continuation` worker 跑起来，是独立一条用例。留在 backlog。

### 迁移工具的两处修正（本轮踩到）

- `@/server` / `@/db/client` **别名形式**此前没认，结果是脚本报
  「scope type used but not imported」并拒绝写盘——白跑一趟。已认两种写法。
- 文件本来就 import 过 `ProviderNeutralDatabase` 时会被追加第二份 → TS2300。已去重。
- `rfc164-workgroup-room` 里有一个**纯函数** describe（`resolveMentions`，一行 DB 都不碰）。
  脚本按「文件里有 `createApp`」整文件包，把它也套进了双引擎 harness——等于为几条字符串断言
  白开一个 PostgreSQL 库。这类 describe 保持普通 `describe`，已在文件里写明理由。
- `rfc327-memory-filter-and-facets` 的 harness 是**模块级** `let h` + 模块级 `beforeEach`，
  包 describe 之后 `beforeEach` 看不到 `scope`（当场 ReferenceError）。已退回，
  留待「模块级夹具上提」那一类一起做。**pre-flight 要加一条 MODULE-LEVEL-HARNESS。**


## 5ai. 账本 576 → 569：七个「只差 await 化 / 只差别自建 app home」的文件

pre-flight 把 82 个候选分完之后，**只差机械工作量**的那一档是 12 个。本轮迁掉七个：

| 文件 | 实际要动的 |
| --- | --- |
| `rfc330-tool-template-acl-matrix` / `rfc324-grant-level-matrix` / `rfc324-scheduled-task-acl` / `rfc317-config-resource-write-gate` | 只是 `.run()` / `.all()` 终结符 |
| `rfc317-employee-definition-acl` | 同上；另有一个**纯 AST 断言**的 describe 保持普通 `describe` |
| `rfc330-employee-case-access` | 三处 `.get()` 改 `(await …)[0]`；一个**判据级**（合成 actor）describe 保持普通 `describe` |
| `rfc128-p2-per-question-endpoint` | 自建 app home 那行直接删——作用域本来就建临时 home 并写 `AGENT_WORKFLOW_HOME`、`afterEach` 还原并删除 |

`.all()` / `.run()` 直接去掉即可（builder 本身 await 出等价结果）；`.get()` 必须改成
`(await …)[0]`——中立面回的是数组，去掉终结符会把「一行」悄悄变成「一个数组」，
**用例照跑、断言全变**。

### 本轮退回两个，各自暴露一条 pre-flight 漏判

- `rfc120-deferred-dispatch` / `rfc142-review-rounds` —— 都吃 `wakeHumanGateContinuation`，
  它的 `StartTaskDeps.db` 是 `LegacySqliteTaskDatabase`（bun:sqlite 专有类型），中立句柄传不进去。
  pre-flight 的 SQLITE-BOUND-INFRA 语料里没有这个符号，已补；**兜底始终是 `tsc`**。
- 顺带记两条迁移脚本的坑：①注册面的**选项对象在 describe 注册期就求值**，
  `token: DAEMON_TOKEN` 这种引用必须先于第一个注册面声明，否则 TDZ（`rfc142` 实撞）；
  ②`import type { ProviderNeutralDatabase } from '../src/db/client'` 这种**第三种路径写法**
  也要进去重名单，否则 TS2300。

### 一个必须记住的连带守卫：W29 的**摘要**

改 `cli/postgresqlDaemonApplication.ts` 会动
`tests/rfc359-w29-unstarted-application-composition.test.ts` 的 daemon 相位摘要。
§5ah 那一提**推红了 CI**（ubuntu shard 8/8 与 macOS shard 2/6）就是因为本地只跑了
`tests/architecture/` 与直接相关的用例，没跑它——它不在 `tests/architecture/` 下。
语句条数仍是 159（替换的是一条语句的内容，不是增删），摘要按新值更新并在用例里写明
**改了哪一条、为什么该改**：摘要变了说不出改了哪一条，才是红。

**规律**：碰 `postgresqlDaemonApplication.ts` / `server.ts` 的装配体，除 `tests/architecture/`
之外还要跑 `tests/rfc359-w29-unstarted-application-composition.test.ts`。


## 5aj. 账本 569 → 568：`rfc247-token-audit` 暴露「应答之后才写」这一类的**两种**错

迁 `rfc247-token-audit` 时 PG 侧四条红。查清楚**不是产品缺陷**：`/api/*` 中间件写 token 调用审计
用的是 `void deps.core.tokenCallAudit.record({…})`——**应答之后**的 fire-and-forget。两个 provider
的代码路径完全一样，差的是**可观测时机**：bun:sqlite 同 tick 落盘，PostgreSQL 是一次真实往返。

**不给产品加 await**：那等于给每个 PAT 请求加一次库往返，与「PostgreSQL 要做到最高性能表现」
直接冲突。契约是「最终会写一条」，两边都成立。修的是用例。

新增 `tests/helpers/eventually.ts`（`eventually` / `eventuallyAtLeast`）：有界轮询、拿到就返回、
超时带上最后一次实际值。**不是裸 `setTimeout`**——睡够了才过的用例在慢机器上就是 flaky，
本仓明令「绝不允许『重跑就过了』作为通过依据」。

### 更要紧的是第二种错：负向断言在 PG 上**因为错的理由绿**

原来那条 `a SESSION call writes nothing` 断言 `expect(await listTokenAudit(db)).toEqual([])`。
它在 PG 上是绿的——但绿的理由是**还没来得及写**，不是「不该写」。这种绿比红危险：
它把两件事混成同一个结论，而且迁移时不会有任何信号。

处置是补**因果屏障**：先发 session 调用，再发一次**已知会写**的 PAT 调用，等 PAT 那行落库，
再断言「除它之外没有别的行」。**时间不是屏障，因果才是。**
已验证屏障是承重的（把期望改成 `[]` 当场红）。

顺带发现这条判据在生产代码里有**两道**：中间件的 `actor.source !== 'pat'` 与参与者
`createTokenCallAuditParticipant` 里的同一条。只改一道做变异测试测不出东西——记在这里省下次的时间。

### 迁移 pre-flight 要加的一条自查

**这个文件有没有对「计数 / 空集」的断言？** 有就先回答「它在 PG 上靠什么保证已经写完了」。
这条没法纯靠 grep 判（`toEqual([])` 太常见、绝大多数与异步投影无关），所以写进清单靠人过一眼，
不进脚本。

### 迁移脚本本轮再修一处

`createInMemoryDb(MIGRATIONS, { bootstrap: 'ready' })` 的**两参形态**此前不认，替换整个漏掉，
迁完 `tsc` 才报 `Cannot find name 'createInMemoryDb'`。`'ready'` 就是 harness 缺省，直接换
`scope.harness.db` 等价；`'required'`（还没有管理员那一档）要人工改成作用域的 `bootstrap` 选项，
所以脚本只放行 `'ready'`。


## 5ak. 双引擎化照出的第二个真缺陷：应答之后 2.5s 的补偿继续，reject 了没有人接

`rfc164-workgroup-room` 迁上双引擎（§5ah）之后，CI 的 ubuntu shard 8/8 红了一格，而日志里
**一条 `(fail)` 都没有**——`44 pass / 0 fail`，只有 `##[error]Process completed with exit code 1`
和往上翻的一段 `# Unhandled error between tests: SQLiteError: no such table: agent_workflow.tasks`。

**bun 的 unhandled rejection 不进 pass/fail 计数**，只改退出码。这条已单独进
`docs/dev-gotchas.md`，因为它会让「看计数判绿」的习惯彻底失灵。

### 根因

`workgroupTaskRoomCommands.ts` 的 `updateConfig` 在解散真人之后排了一拍补偿：

```ts
const late = setTimeout(() => void continueIfStillParked(input.taskId), 2_500)
```

单引擎时代它 reject 也无人察觉。双引擎化之后：这一拍由 **SQLite 那半**排下，真正跑起来时
`describeEachProvider` 已经切到 PostgreSQL——`currentDatabaseSchemaProvider()` 变成 PG 的，
于是那个 SQLite 句柄渲染出 `agent_workflow.tasks` 去问 bun:sqlite，当场 `no such table`，
`void` 掉的 promise reject，没人接。

**这不只是测试问题**：daemon 里同一条路径 reject 同样是进程级 unhandled rejection。
尽力而为的补偿本来就不该把进程带下去。已改成自带 `.catch` + `log.warn`。

回归锁放在 `rfc164-workgroup-engine` 既有的 `source locks` describe 里（那段 `setTimeout`
必须含 `.catch(`）；已变异验证（去掉 `.catch` 当场红）。运行时的锚点是
`rfc164-workgroup-room` 本身：不改产品时它 3/3 都是 `exit=1`。

### 排查手法（stack 只剩 drizzle 的 `then`）

floating promise 的 stack 没有调用方。用 `--preload` 包住 `Database.prototype.prepare`、
失败时打印 SQL——**列集合足以定位到具体的 projection 常量**，再反查调用点。已进 gotchas。

### 顺带的一步收敛

`ensureWorkgroupHostWorkflow` 的形参从 bun:sqlite 专有的 `DbClient` 收成
`ProviderNeutralDatabase`。函数体本来就只有一条带 `onConflictDoNothing` 的 insert
（中立面广泛支持），此前那个类型纯属未收敛——代价是任何调它的用例都被钉死在 SQLite 上。

### `rfc164-workgroup-engine`：账本条目 8 → 1，**不销账**

九个注册面里八个迁上了双引擎；剩一个（stuck detector S1/S2）吃
`helpers/taskRecoveryOperations`——夹具用 `dbTxSync` + 同步终结符，是 bun:sqlite 专有的。
那层夹具中立化是独立一刀，留到 SQLITE-BOUND-INFRA 那一批一起做。另有两个 describe
保持普通 `describe`：`host snapshot`（纯投影）与 `source locks`（读源码做文本断言）。

迁移脚本因此加了一条：**源码锁 describe 一律不包**——它们一行 DB 都不碰，而且正文里的
正则 / 模板串带花括号，naive 的括号配平会走丢（这正是它此前报 `unbalanced` 的原因）。


## 5al. 账本 568 → 567：`rfc310-pr3-upload-security`，以及 `.all()` 的**姊妹坑**

迁移本身只有两件事：去掉同步终结符、别自建 app home（该文件此前用模块级 `beforeEach` 建了一个
并写 `AGENT_WORKFLOW_HOME`——而 `scope.open()` 随后会**再覆盖一次**，于是
`join(appHome, 'evidence', …)` 断言的是一个应用从没写过的目录）。改用 `opened.appHome`。

其中一个 describe 不打 HTTP（走 `previewDeps` + `sessions.createUpload`），但**仍然要
`open()`**：被测的落盘走 `Paths.root`，也就是 `AGENT_WORKFLOW_HOME`——不 open 的话那个变量
指向的是真实用户目录。顺带把一条 `db.insert(...)` 补上了 `await`。

### `.all()` 的姊妹坑：去掉终结符会把断言悄悄变成「断言 builder 对象」

`expect(db.select().from(x)).toHaveLength(0)` —— 原来 `.all()` 让它同步拿到数组；去掉之后
断言的是 **query builder 本身**。`toHaveLength` 碰巧会红（builder 没有 length），但
`toBeTruthy()` / `not.toBeNull()` 这类**会静静地绿**——用例还在跑，测的已经不是那回事。

已加零容忍守卫（`test-suite-policy`）：共用 HTTP 作用域的用例里，
`expect(` 后面直接跟未 await 的 `db|tx.select|insert|update|delete(` 一律红。已变异验证。
这条与既有的「不得出现 `.run()` / `.get()` / `.all()`」是**一对**：前者管「别用同步终结符」，
后者管「去掉之后别忘了 await」。

### 查过了：`backup.test.ts` **不能**简单迁——不是懒，是前提不成立

第一眼它像个好目标：`POST /api/backup` 在两个 provider 上确实是**两套实现**（SQLite 是
VACUUM INTO + 打 tar、PostgreSQL 走 `postgresqlAdminBackupCoordinator` /
`createPostgresqlProviderBackup`），而今天只有 SQLite 那半有用例。

但读了实现之后结论相反：`createPostgresqlProviderBackup` 要求
**「已核验的在用 PostgreSQL generation」**——generation 指针、完成态的迁移操作
（`accepting-writes` / `finalized`，且 `logicalBackupDigest` / `legacyArchiveDigest` 都在），
否则直接抛 `postgresql-backup-generation`。而共用 HTTP 夹具**刻意不提供** daemon 迁移准入
（`createProviderHttpApplication` 里四个 admission 钩子都是 `unexpectedAdmission`，见那份
文件的头注）。

所以这不是「PG 缺一半功能」，是**夹具形态不匹配**：PG 备份只对走完迁移的部署有意义，
要测它得先有一个能立出在用 generation 的夹具，那是另一刀（也是真正值得做的一刀——
今天 PG 备份路径确实零覆盖）。记进 backlog，别硬把它塞进共用 HTTP 作用域。


## 5am. 第三个真缺陷：同名并发创建在 PostgreSQL 上从 409 退化成 500（账本 567 → 566）

迁 `agents.test.ts` 时 PG 侧红一条：`RFC-223 maps a same-owner create race to one stable 409
conflict` 拿到的不是 `{ code: 'agent-name-in-use', status: 409 }`，而是一个裸的
`DrizzleQueryError`。

### 根因：Bun 的 PostgreSQL 驱动把 SQLSTATE 放在 `errno`，不是 `code`

探针打出来的错误链：

```
DrizzleQueryError                     // 没有 code/constraint
└─ PostgresError
     code:       'ERR_POSTGRES_SERVER_ERROR'   ← Bun 自己的标签
     errno:      '23505'                       ← 真正的 SQLSTATE
     constraint: 'agents_owner_name_unique'
```

`isOwnerScopedNameConflict`（legacy 三个资源门面 **agent / skill / workgroup** 共用的冲突分类器）
只读 `structured?.code === '23505'`，于是在真 PG 上**恒 false**；SQLite 那半的正则
（`UNIQUE constraint failed`）也对不上 PG 的 `duplicate key value violates unique constraint`。
净效果：同名并发创建在 SQLite 上是干净的 409，在 PostgreSQL 上是 500。

**这个坑本仓踩过第二次**——`postgresqlUniqueViolationConstraint` 的注释里白纸黑字记着
「`isPostgresqlUniqueViolation` 此前只看 `code`，在真 PG 上恒 false ⇒ 并发同名拿 500 而非 409」。
第一次修的是能力矩阵那份，**这份手写的副本没跟上**。

所以修法不是再手写一遍 errno 匹配，而是让分类器**复用那份唯一真值来源**
（`postgresqlUniqueViolationConstraint`）。一处修好，agent / skill / workgroup 三个门面一起好。

回归测试 `rfc359-owner-name-conflict-parity.test.ts`：双引擎各造一次真实唯一冲突，
断言分类器给出同一个结论；负向用**另一个索引**（主键）上的唯一冲突，确保不会把「id 撞了」
读成「同名已存在」。已变异验证（撤掉修复，PG 那半当场红）。

**规律（已在别处踩过，这里第三次）**：同一条判据出现两份实现时，修好的那份不会自动传染给
另一份。`docs/dev-gotchas.md` 里凡是写着「此前只看 X，在真 PG 上恒 false」的教训，
都该顺手 grep 一遍**还有谁在手写同一条判据**。

### `agents.test.ts`：顺手清掉两个 SQLite-only 的服务层 describe

文件里原有两个 `describe('agent service')` 用模块级 `initializeNativeServiceDb()` 自建 SQLite 库，
测的用例（重名拒绝、被工作流引用时拒删）与既有的 `describeEachProvider` 块**不重复**——
也就是说这些判据此前只在 SQLite 上成立过。改成 `describeEachProvider`，
那个 native 夹具随之整个删掉，文件销账。

**并且：正是这一步把上面那个 500 照了出来。** 如果只迁 HTTP 那个 describe（pre-flight 的
NESTED-EACHPROVIDER 提示的最小动作），这条缺陷会继续躺着。

### pre-flight 的 NESTED-EACHPROVIDER 不是拦路灯

`agents.test.ts` 证明了：绝大多数这类文件里，既有的 `describeEachProvider` 是**服务层**用例、
`createApp` 只在某一个 HTTP describe 里，处置是**只包那一个 describe**，其余原样——
整文件包才会交叉积。标签文案已改成这个意思。


## 5an. 账本 566 → 564：把「双引擎新半 + SQLite 旧半」并存的文件收成一份

前几波留下一种形态：同一个 HTTP 面上，一部分用例已经双引擎、另一部分还挂在 legacy 的
`buildHarness()`（自建 SQLite 内存库 + `createApp`）上。**两半测的不是同一批判据**——
旧半里的用例在新半里并不存在，所以它们此前**只在 SQLite 上成立过**。

- `mcps-http`：自带的那份生命周期拷贝（18 份之一）换成共用作用域；四个 legacy describe
  （POST / PUT / DELETE / rename 各自的另一半）转到同一个双引擎注册器。27 → 42 条。
- `skills`：两个 `native fixture` describe 转到既有的 `describeProviderSkills`，
  legacy `buildHarness()` 整个删掉。
- `agents`（§5am 已述）：正是这一步照出了同名并发 500 的缺陷。

**判据**：看到 `describeEachProvider` 与 `createApp` 在同一个文件里，先问「旧半测的用例
新半有没有」。有 ⇒ 旧半是重复，删；没有 ⇒ 旧半是**只在 SQLite 上成立过的判据**，必须迁。

同一手法又收了两个：`cached-repos-http`（两组）与 `rfc248-repo-groups-http`（一组）——
两个文件的 provider 注册器建出的 `h` 与 legacy 的 `Harness` **本来就同形**，
把旧半的 test 整段折进注册器即可，legacy `buildHarness()` 随之整个删掉。
账本 566 → 562（四个文件）。

`reviews-version-comments` 是第五个（服务层一组 + 路由一组）。它顺带暴露一件事：
那个文件的 `seed()` 有两个重载，**无参那条自建 SQLite 库**，而且
`...(suppliedDb === undefined ? {} : providerTaskLineage(taskId))` 意味着
**SQLite 那条路径插的任务行是不带血缘列的**。两个调用方都改走 `seedForProvider` 之后，
无参重载连同那个三元一起退役——血缘列现在总是补齐。账本 562 → 561。

### 暂缓：`plugins-http` 与 `rfc311-task-archive`

它的 provider 夹具把 `appHome` 钉在模块级的 `pluginsDir` 上（插件文件要预先落进去），
而 legacy 半的 `seedPluginRow` 是**同步**的、provider 半的 `seedProviderPluginRow` 是异步的，
两边种子不同形。不是不能做，是要先把种子统一，单独一刀。

`rfc311-task-archive` 的形状更特别：一个普通 `describe` 里**嵌着**一个
`describeEachProvider`。把外层包成双引擎会让内层变成交叉积，得先把内层那块提出来，
也是单独一刀。


## 5ao. 账本 562 → 560：再两个「旧半只在 SQLite 上成立过」的文件

- `reviews-version-comments`（服务层一组 + 路由一组）。顺带暴露一件事：它的 `seed()` 有两个
  重载，**无参那条自建 SQLite 库**，并且 `...(suppliedDb === undefined ? {} : providerTaskLineage(taskId))`
  意味着**SQLite 那条路径插的任务行不带血缘列**。两个调用方都改走 `seedForProvider` 之后，
  无参重载连同那个三元一起退役——血缘列现在总是补齐。
- `rfc304-capability-templates`：四组服务层 describe（自建 `createInMemoryDb` /
  `createCrudFixtureDatabase` + `db.$client.close()`）转到 `describeEachProvider`，
  路由那一组包进共用 HTTP 作用域。`createCrudFixtureDatabase` 与 `MIGRATIONS` 随之删除。
  **`afterEach(() => db.$client.close())` 必须一起去掉**——库归 harness 所有，用例自己关会
  把下一条用例的连接也关掉。

`rfc304` 是一个典型：同一个标题下 `describe` 与 `describeEachProvider` **交替出现**，
是前几波「逐条挑着迁」留下的形状。判据仍是那一条：旧半测的用例新半有没有。


## 5ap. 账本 560 → 559：`rfc326` 的 native 分支整条删掉

这个文件的 `buildFixture` 带两个重载：**不传 harness 就自建 SQLite 内存库 + `createApp`**。
四个 describe 走的是那条 native 路。把它们接到既有的 `registerProviderFixture` 之后，
native 分支**一个调用方都没有了**——重载、`connection.kind === 'native'` 的分支、
`createInMemoryDb` / `MIGRATIONS` 一并删除，库总是由 harness 传进来。

「删除优于 deprecate」在这里是实的：留着那条分支，下一个人写新用例时仍会不小心走回单引擎。

### 暂缓：`rfc193-port-artifacts-api`

同一形态，但它的 provider 夹具生命周期（~45 行）**原样抄了三份**，要先提成一个注册器再把
native 那组接进去。不难，但比上面几个大一档，单独一刀。


## 5aq. 更正：PG「没有测试接缝」这个说法不准，真正的缺口是**装配结果没被暴露出来**

此前把剩下最大的一块记成「`AppDeps` 上有 13 个测试接缝，`PostgresqlApplicationInput` 上一个
都没有，22 个文件卡在这里」。读了调用方之后，这个框架**是错的**：

```ts
// tests/rfc340-review-access.test.ts
const taskExecutionReadModels = createTaskExecutionReadModels(db)   // ← 建的是**真**读模型
createApp({ …, taskExecutionReadModels })
```

用例并不是要注入一个假件，而是「**把应用自己会建的那个东西也给我一份**」——因为
`createApp` 没把装配结果交出来，用例只好在外面再建一份一模一样的，再从 `AppDeps` 塞回去。
`taskExecutionReadModels` 的五个调用方全是这个形态（`createTaskExecutionReadModels(db)`）。

所以正解不是「给 PG 补 13 个接缝」（那会把一个本来就该收掉的形状复制到第二个 provider 上），
而是**让共用 HTTP 夹具把应用已经装配好的东西暴露出来**——PG 侧本来就有
（`taskExecutionProvider.readModels` / `core.*`），SQLite 侧要让
`composeSqliteUnstartedApplication` 一并返回。`ProviderHttpApplication` 上已经有
`secretBox` / `processConcurrencyScope` / `repositoryWorkspaceStore` / `taskExecution` 四个
先例，按同一形状往下加即可。

**这条更正很重要**：按错的框架做，会给生产输入类型加 13 个只服务测试的可选字段，
并且**两个 provider 各一份**；按对的框架做，是把已有的装配结果暴露出来，生产类型一个字不加。

逐个仍要看：真正需要「换掉」而不是「拿到」的接缝（`*TestDependencies` 那几个可能是），
才考虑别的办法。**先按调用方形态分类，再决定**——别再按字段名清单估工作量。


## 5ar. 按 §5aq 的正解动手：把装配结果暴露出来（账本 559 → 558）

`ProviderHttpApplication` 上加两项——`taskExecutionReadModels` 与 `collaborationContext`。
两个 provider **本来就装配了它们**：

| | 读模型 | 协作上下文 |
| --- | --- | --- |
| SQLite | `SqliteAppComposition`（`...runtimeDeps` 带出来的，只是类型上没声明） | 同左 |
| PostgreSQL | `taskExecutionProvider.readModels` | `boundCollaborationContext` |

所以这一刀**没有给生产输入类型加任何只服务测试的字段**：SQLite 侧是把已在返回值里的东西
在类型上声明出来；PostgreSQL 侧是在 `PostgresqlDaemonApplicationRuntime` 上多交出一个已有的
`const`（daemon 自己不碰它）。

`rfc340-review-access` 是第一个消费者：它此前在外面用
`createTaskExecutionReadModels(db)` + `createCollaborationCommandContext({...})` 建了一份
一模一样的，再从 `AppDeps` 塞回 `createApp`。现在整份夹具改成 `await scope.open()` 取用，
`Paths.root` 也跟着用 `opened.appHome`（原来自建的临时目录会被 `open()` 覆盖，见 §5al 同款坑）。

### W29 当场红三条——这正是它该做的

改装配体必跑 `rfc359-w29-unstarted-application-composition`（它不在 `tests/architecture/` 下，
判据见 `scripts/source-guard-sweep.ts`）。三条分别是 daemon 摘要、SQLite 返回对象的尾部逐字
比对、以及 helper 的整段文本比对。

处置不是「改数字让它绿」，而是**把追加项登记成一个显式名单**：
`APPENDED_EXPOSURES = ['repositoryWorkspaceStore:…', 'taskExecutionReadModels:…', 'collaborationContext:…']`，
守卫剥掉这几项之后再与合一前的摘要比。**以后再加一项必须在名单里登记**，不能默默混过去——
这样守卫仍然挡得住「真的改了装配」，又不会把「暴露已装配结果」误判成回归。

### 下一批消费者

`rfc326-mcp-review-tools` / `rfc327-memory-filter-and-facets` / `rfc247-mcp-server` 用的是同一
组合（读模型 + 协作上下文 + 各自的 `appHome`），现在都不再卡在接缝上了。


## 5as. `rfc327-memory-filter-and-facets`：两组接上双引擎，第三组**诚实地**留在单引擎

三个 describe 里两个（REST 的多标签过滤、facets 聚合）接上了共用作用域——模块级 `let h` +
模块级钩子整体上提进注册面（pre-flight 的 `MODULE-LEVEL-HARNESS` 那一类）。11 条 → 22 条。

**第三组（MCP `resource_read`）一开始留在了单引擎**，理由是它在夹具外面自建
`composeTaskExecutionTestRuntime(db)`（bun:sqlite 专有，吃 `DbClient`）去拿 `schedulerDriver`
拼一个 route operation dispatcher。

**随后解开了（§5at）**：真正的障碍不是 `schedulerDriver`，而是
`tests/helpers/routeOperationDispatcher` 只吃 `AppDeps` 并自己 `createApp`。
给它加一条「吃**已装配的应用**」的入参形态之后，那一整段自建运行时直接删掉——
整个文件 26 条全部双引擎。

### 拆分时自己踩了一次 MODULE-LEVEL-HARNESS

把单引擎那组的 `let native` + `beforeEach` 顺手放在了模块级 ⇒ 模块级钩子对**全文件**生效 ⇒
双引擎那半在 PostgreSQL 轮次里也去建一个 SQLite 应用，当场
`no such table: agent_workflow.users`，9 条红 + 18 个 unhandled error。
钩子挪进它自己的 describe 即好。已进 `docs/dev-gotchas.md`——那条判据此前只防「迁移时漏了
上提」，现在同样防「**拆分时新引入**一个模块级钩子」。


## 5at. dispatcher 只吃 `AppDeps` 才是真障碍（账本 558 → 557）

`createRouteOperationDispatcher(deps: AppDeps)` 内部 `createApp(...)`——**按构造只能是 SQLite**。
所有 MCP dispatcher 类用例都被它钉住，而它们为了凑出那个 `AppDeps`，又得在外面自建
`composeTaskExecutionTestRuntime(db)`（bun:sqlite 专有）去拿 `schedulerDriver`、读模型、
协作上下文——**一条自我维持的锁链**。

拆法是从 helper 这一头：它其实只需要两样东西——一个 `app` 和 `identityAccess.directAuthority`。
加一条入参形态 `{ app, identityAccess }`（旧的 `AppDeps` 形态保留给存量调用方），
再把 `identityAccess` 加进夹具的暴露面（第三项，与 §5ar 的两项同源：**两个 provider 本来就
装配了它**——SQLite 的 `composed.core.identityAccess`、PostgreSQL 的 `core.identityAccess`）。

`rfc327` 的 MCP 那组随即从「自建 6 行运行时 + 12 行 dispatcher 选项」塌成一行：

```ts
const dispatch = createDispatcher({ app: h.app, identityAccess: h.identityAccess })
```

**规律**：遇到「这组用例接不进双引擎」时，别只盯着用例缺什么依赖——先看它调用的那个
**测试 helper 自己是不是 provider-bound**。helper 吃 `AppDeps`、内部 `createApp`，
就是一把锁；从 helper 这头拆，往往比给用例补依赖便宜一个数量级。

`rfc247-mcp-server` / `rfc326-mcp-review-tools` 用的是同一个 helper，下一刀直接照做。


## 5au. 一条与 RFC-359 无关、但被本轮 CI 逮到的真缺陷：用例预算小于它自己的等待上限

`c00d45c90` 的 macOS 分片红了两条 `daemon start — lifecycle`（各 5006ms 超时）。查下来与本轮
改动无任何调用路径交集——是 `tests/daemon-start.test.ts` 里两条用例内部
`waitForReady(child.stdout, 10_000)`，自己却跑在 **bun 的 5s 缺省预算**上。

也就是说它们实际测的是「daemon 起得够不够快」：本机与快 runner 上绿，忙分片上红。
同文件里每条同样等 10s 的兄弟用例给的都是 15–30s，**只有这两条漏了**。

已补预算，并把判据写成守卫（`test-suite-policy`：`a test that waits N ms declares a budget
larger than N`，已变异验证）。细节与两个正则坑进 `docs/dev-gotchas.md`。

**顺带**：`scripts/source-guard-sweep.ts` 这一轮真的兜住了一条——
`rfc345-resource-catalog-contracts` 有一条源码锁钉着 `routeOperationDispatcher` 的
`deps.identityAccess ?? …` 字面量，§5at 把形参改名 `input` 之后它当场红。
本地扫到、当场改对，没有推红主干。**这就是那个脚本存在的理由。**


## 5av. §5at 的收益兑现：`rfc247-mcp-server` 与 `rfc326-mcp-review-tools`（账本 557 → 555）

同一个 helper 锁住的另外两个文件，照做即可：

- `rfc247-mcp-server`：九个 describe 接上双引擎（两个纯 AST / 判据 describe 保持普通
  `describe`）。harness 里那段「自建 `composeTaskExecutionTestRuntime(db)` + 12 行 `deps`」
  整段删掉，`createApp(h.deps)` 换成 `h.app`。**65 条全部双引擎。**
- `rfc326-mcp-review-tools`：三个 describe 接上；它的 `mcpSurfaceEnabled: true` 走
  `open({ config })`（自己另写 config 文件会被整份绕开）。另一处「为 HTTP transport 再建一个
  app」也换成 `h.app`——合一前那里测的其实**不是夹具那一个应用**。

`rfc326` 的 PG 侧红了一条，是**已知那一类**：MCP 通道的审计行也是
`void deps.tokenCallAudit.record(...)`，四个工具各一行、应答之后才落。用 `eventually` 读到为止
（判据同 §5aj）。这条再次说明那个原语值得单独存在——同一形态第二次出现在完全不同的文件里。

### 到这里为止，「自建运行时去凑 `AppDeps`」这个形状在 MCP 面上清干净了

`grep -rn 'composeTaskExecutionTestRuntime' tests/` 剩下的调用方都不再是为了拼 dispatcher。


## 5aw. 两个「单引擎 HTTP 混在 describeEachProvider 文件里」的收尾

账本**条目数不变**（两个文件都还剩别的单引擎调用点），但调用点从 5→4 / 4→2：

- `rfc244-task-operations`：三个 `describeEachProvider` 块之外，还直接挂着一条
  **单引擎的** HTTP 用例（自建 `createInMemoryDb` + `createApp`，测 `/api/task-catalog`）。
  判据在那三个块里并不存在——单独包成一个 HTTP 注册面。
- `rfc261-webhook-delivery-pagination`：五个 describe 接上作用域；它的 `configHarness`
  （模拟「操作者手写的存量 config.json」）改走 `open({ config })`。

### `rfc261` 当场撞了一次交叉积

它的 `describeEachProvider('RFC-261 delivery retention')` **嵌在**一个被我包成 HTTP 注册面的
describe 里，跑出 `[postgresql] > application lifetime > … > [postgresql] > (unnamed)`。
那一块是**服务层**的（不打 HTTP），处置是把它**提到与注册面平级**，不是嵌在里面。

这正是 pre-flight `NESTED-EACHPROVIDER` 提示的那件事，只是方向相反：它提醒的是
「别整文件包」，这里是「包了外层之后，里层那个 provider 注册要先搬出去」。
两条都写在标签文案里了。

（顺带：`DAY` 原本是那个 describe 的局部常量，搬出去的块也要用，提到模块级。）


## 5ax. `auth-routes` 全量双引擎（账本 555 → 554）

六个 describe 接上作用域，另加一个 `bootstrap: 'required'` 的独立注册面。三处要点：

1. **裸 SQL 换掉**：`h.db.$client.query('SELECT … FROM user_access_audit …').get(…)` 是
   bun:sqlite 专有的（中立面没有 `$client`）。改成 drizzle 的 select + `desc(createdAt)` + `limit(1)`，
   两个引擎同一份判据。**这类裸 SQL 是 SELF-CLOSES-DB 标签之外的另一种 provider 绑定**，
   pre-flight 扫 `$client` 时会一并报出来。
2. **`bootstrap` 是注册面级选项**：原来一条用例里既要 `'required'`（还没有管理员）又要
   `'ready'`，一个作用域服务不了两种形态。拆成两条——两半本来断言的也是两件事。
3. **一条用例里 `open()` 两次，换的是配置、库还是同一个**：第二半再建一个同名 `bob`
   当场 `username already exists`。合一前每次 `buildHarness()` 现建一个库，所以同名无碍。
   种子改名即可。**别**给作用域加「每次 open 重置库」——那会让「同一个库换一份配置」
   这种真实场景变得不可测。已进 `docs/dev-gotchas.md`。


## 5ay. `rfc294-route-gate-compat`（554 → 553）与 `rfc164-workgroups`（条目 2 → 1）

模块级 `beforeEach`/`afterEach` 建库建应用建 app home，整体上提进注册面。
`doc_versions` 目录改建在 `opened.appHome` 下（路由经 `Paths.root` 定位，自己另建一个会被
`open()` 覆盖）。`afterEach` 里的 `$client.close()` + `rmSync(root)` 全部退役——库与目录都归
作用域。

`.get()` 的三处按 §5al 的判据改成 `(await …)[0]`——**不能只去掉终结符**：中立面回的是数组，
去掉就把「一行」悄悄变成「一个数组」。

### 第三次被自己的注释绊倒

写完改动后 `test-suite-policy` 报 `rfc294-route-gate-compat: 1` 个同步终结符——扫到的是我
**注释里**那句「中立面上没有 `.get()`」。`docs/dev-gotchas.md` 早有一条
「守卫按文本计数时，你的注释就是它的输入」，这是第三次撞。注释改成不写出方法名即可。


`rfc164-workgroups` 同批：路由 ACL 那个 describe 接上作用域（另外两个是服务层的
`describeEachProvider`，本来就双引擎；`CreateWorkgroupSchema shape` 是纯 schema 断言，保持普通
`describe`）。文件里还剩一处单引擎调用点，条目不减。


## 5az. `rfc193-port-artifacts-api`：一份夹具抄了**六份**（账本 553 → 552，净删 100+ 行）

这个文件是「抄拷贝」的极端样本：同一段 45 行的夹具生命周期（建应用 / 存还
`AGENT_WORKFLOW_HOME` / 先 dispose 再清理）**三份 provider 版 + 三份 native 版**，一共六份，
彼此只差里面的 test。

处置是先提成一个注册器 `describeProviderPortArtifacts(register)`，六处一起接上去；
接完之后 `buildHarness` 的**无参重载**（自建 SQLite 内存库 + `createApp`）一个调用方都没有了，
连同 `nativeDb` 三元分支一起删除。净删 100+ 行。

另有一个 describe 是**纯源码锁**（读 `routes/port-artifacts.ts` 做文本断言，一行 DB 都不碰），
不套双引擎夹具，保持普通 `describe`——否则白开一个 PostgreSQL 库读源码。

**规律**：看到「同一段夹具在一个文件里出现三次以上」，先提注册器再迁，比逐份改省一个数量级，
而且提完之后 native 那条路往往就自己空了——`删除优于 deprecate` 在这里是自动发生的。


## 5ba. `inventory-in-flight-fallback`：账本上那一条是**纯死代码**（553 → 551 的最后一格）

这个文件早已全量走 `registerProviderApplication`（provider 注册器），但模块级还留着一个
自建 SQLite 的 `buildApp()`——**一个调用方都没有**：所有用例用的是注册器回调里同名的**参数**
（shadowing）。账本上那一条因此不是「还没迁」，是**没人清掉的残留**。

连同 `Omit<ReturnType<typeof buildApp>, 'db'>` 那处类型推导（它是唯一还引用它的地方）
一起改成显式形状，函数删除。

**规律**：账本上剩下的条目里，有一部分是这种——**shadowing 把死代码藏住了**。
迁移前先 grep 一遍「这个 `createInMemoryDb` 到底是谁在用」，可能根本不用迁，删掉即可。


## 5bb. 「白做的夹具」是账本上的第三类残留（551 → 550，并已脚本化）

§5ba 发现「shadowing 藏住的死代码」之后，顺手把整份账本扫了一遍，问的是
「这个 `createInMemoryDb` 绑定到底有没有调用方」。扫出一个假阳性
（`beforeEach(setupNative)` 是**裸引用**不是调用，正则要求 `name(` 就漏了），
但顺着它发现了**第三类残留**：

`rfc264-unicode-names` 的三个 describe 都挂着 `beforeEach(setupNative)`——那个 setup 建一个
SQLite 库、播两个用户——而三块正文**一次都不碰 `db`**：它们全是纯 schema / 校验断言。
也就是说那个库每条用例白建一次。删掉那三行 `beforeEach`，`setupNative` / `seedUser` /
`let db` / `createInMemoryDb` 一路空掉。

**这类根本不用迁，是删。** 判据加进了 pre-flight（`IDLE-FIXTURE[...]`）。

### 第一版判据太松，报出来才发现——已收紧

第一版只看「整块不出现 `db`」。拿整份账本扫一遍，`rfc201-plugin-exact-operation` 被报了**三块**，
逐块看下去两块是**误报**：一块用 `binding`（由 db 建出来的）、一块用 `pluginsDir`
（同一个 setup 建的目录）——它们只是没**直接**提 `db`，夹具照样是要的。

收紧后的判据看**全部产物**：先从 setup 函数体里收集它赋值的模块级绑定
（`^\s*(\w+)\s*=`），再要求 describe 正文**一个都不用**。两个误报随之消失，只剩
`production coordinator callsite ratchet` 一块——那块确实什么都不用（纯源码 ratchet），
那行 `beforeEach` 白建一个 SQLite 库加一个临时目录。已用一个含两种情形的负样本验证：
只报「真白做」那一块。

**这也是这条判据本身的价值**：如果只是靠人扫，那两个误报很可能被当成真的删掉——
删完测试照样绿（`binding` 在 provider 那半的 describe 里也建），要等到很久以后才发现
这两块从此什么都没测。

### 账本残留的三类，到这里都有了判据

| 类 | 判据 | 处置 |
| --- | --- | --- |
| 真·未迁 | pre-flight 的其余标签 | 迁 |
| shadowing 藏住的死代码（§5ba） | 那个绑定有没有**真正的**调用方（注意裸引用） | 删 |
| 白做的夹具（本节） | `IDLE-FIXTURE`：建了库但整块不碰 `db` | 删 `beforeEach` |

**先分类再动手**——后两类的成本是前者的十分之一，而且不需要任何双引擎验证。


## 5bc. 自己留下的一格红：`rfc247-token-audit` 的 AC-20 还在用 `setTimeout(50)` 等落库

§5av 迁 `rfc247-token-audit` 时我用 `eventually` 修了五处断言，**漏了 AC-20 那三条**——
它们用的是 `await new Promise((r) => setTimeout(r, 50))`。本机 3/3 全绿，
CI 的 ubuntu shard 7/8 红两条（各约 504ms，也就是整条用例跑完了才断言失败）。

漏的原因很具体：那三条**不在**我 grep `listTokenAuditForUser` 找到的那批里，
它们查的是 `tokenDeleteSnapshot`。**按「哪个表」grep 会漏掉同一条 fire-and-forget 路径上
的其它表**——`deletedSnapshot` 是跟着 `tokenCallAudit.record` 一起写的。

处置：
- 正向那条改 `eventuallyAtLeast`；
- 两条负向（session 删除 / 被拒的删除都不该留快照）补**因果屏障**：再发一次成功的 PAT
  删除，等它的快照落库，再断言「除它之外没有别的」。按快照正文里的标题辨认——
  `resourceId` 在这条路径上是 `'unknown'`（路由没往上报资源 id），第一版按 id 断言当场红。

**判据已写成守卫**（`test-suite-policy`：`provider HTTP tests do not sleep to wait for a write`，
扫 `new Promise(… => setTimeout` 与 `Bun.sleep(`），已变异验证。现在这类漏不掉了——
**这才是这一格红真正的产出**：靠人记「迁完要 grep 一遍睡眠」是记不住的，我自己就没记住。


## 5bd. 那条「睡一觉等写入」的判据，我改了**四版**才对——每一版都是跑真实数据才发现错

§5bc 的守卫只扫**已迁**的文件，挡得住回潮、挡不住「下一个文件迁进来时带着一个睡眠」。
补一条同判据的 pre-flight 之后，报出的数字是 **20 → 11 → 12 → 7**：

| 版本 | 判据 | 跑真实数据发现的错 |
| --- | --- | --- |
| ① | 有 `setTimeout` / `Bun.sleep` 就算 | 把**有界轮询**也算进去（`tasks.test.ts`：`for(;;){ …break; if(Date.now()>deadline) break; await sleep }`）。报 20，多算一倍。 |
| ② | 循环 + `Date.now() +` | 漏了**计数式上界**（`review-state-machine`：`for (attempt < 500 && isTaskActive(id))`）。 |
| ③ | 循环里有 `break`，或循环条件里有调用 | 漏了**用 `return` / `throw` 退出**的轮询（`rfc238` / `rfc300` / `rfc349` 的 waitFor 辅助函数全是这么写：`if (done) return session; if (过期) throw …; await sleep`）。 |
| ④ | 出口认 `break` / `return` / `throw` | 现在只剩 7 个文件、真的都是直线式。 |

**真正的区别不在「有没有上界」，而在谁在做同步**：坏形态是「睡一觉然后断言」——睡眠时长
**就是**同步手段；好形态是 `loop { 查一下; 满足就退出; sleep(退避) }`——**那个检查**才是同步。
上界写成 deadline 还是计数、退出写成 `break` 还是 `return`，都不改变这一点。

### 还有第四类：判据无法推断意图

逐条看剩下 7 个时又发现一种：`plugins-http:628` 的注释写着
「Allow some clock advance so installedAt strictly increases」——那是**刻意推进时钟**，
不是等写入。改成谓词等待反而是错的。

所以这条检查**本质上是顾问式的**：它找出直线式睡眠，然后必须逐条分三类——
① 等一个写入落库 ⇒ 改 `eventually`；② 断言某件事没发生 ⇒ 补**因果屏障**；
③ 与写入无关（推进时钟之类）⇒ 上一行写 `// sleep-ok: <理由>` 豁免。
零容忍 + 带理由的豁免，比「让判据自己猜意图」诚实。已验证豁免注释在两处都生效。

真正待处理的 7 个（带行号）：`plugins-http`(L628,680,761) / `rfc099-ws-acl-filter`(L288) /
`rfc152-ws-frame-gates`(L142,214) / `rfc257-webhook-management`(L643) /
`rfc259-github-ingress`(L134,191,305) / `runtime-routes-registry`(L694) /
`ws-repo-imports`(L171)。其中 `rfc099-ws-acl-filter:288` 与 `ws-repo-imports:171` 是
**负向断言**（断言某个 frame 没送到），正是最该补因果屏障的那一类——后者的注释还写着
「cannot be predicate-driven — keep a short fixed settle」，因果屏障恰好解决它。

### 三条规律

1. **守卫写完要问「它扫的范围是不是正好覆盖了问题发生的时机」。** `test-suite-policy` 扫
   「已迁完的文件」，对回潮有效、对**迁移当下**无效；两个时机都要有。
2. **报出来的第一个数字先别信，去看几条。** 这条判据我改了四版，**每一版的错都只能靠跑真实
   数据发现**——坐着想是想不出「waitFor 用 return 退出」这种形态的。
3. **判据推断不了意图时，给带理由的豁免，别硬猜。** 假阳性在这里的代价不是噪声——
   是有人照着把一个正当的轮询循环、或一次刻意的时钟推进改坏。


## 5be. `rfc120-deferred-dispatch` 的 HTTP 面（调用点 42 → 27）

这个文件 2400+ 行、七个 describe，其中**只有一个**打 HTTP（`run-scoped layer Codex folds`，
用一个本地 `makeApp(db)`）。把那一个包进作用域，`makeApp` 收成 `await scope.open()`
——它原来自己 `mkdtempSync` 建 app home **又**建一个 config 目录，两个都由作用域负责。

三个种子函数（`seedTask` / `seedDesignerEntries` / `seedTwoSource`）的形参从 `DbClient`
收成 `ProviderNeutralDatabase`——函数体本来就只有普通 insert，那个类型纯属未收敛。
一处改动，**32 个调用点**一起解锁（含另外六个 describe 将来要迁的那些）。

**剩下 27 个调用点是服务层的六个 describe**（不打 HTTP）。它们该转
`describeEachProvider`，与 AC-6 的 HTTP 面是**两件事**——账本条目因此不减。
那批是更大的一刀：单个 describe 动辄 300–900 行，且各自带自己的 fake 调度器 / 钩子。

**规律**：一个大文件里往往只有一两个 describe 真的打 HTTP。**先只迁那几个**——
AC-6 要的就是 HTTP 面的双引擎，服务层的转换是另一条线，混在一起做会把一刀拖成十倍。

## 5bf. 那 7 条直线式睡眠全清掉了——三类分法实际落地后，多出来一个新原语

§5bd 只把 7 条挑出来、分了类。这一轮逐条改完，实际处置与当初的猜测有出入：

| 文件:行 | §5bd 的预判 | 实际处置 |
| --- | --- | --- |
| `rfc099-ws-acl-filter:288` | 负向断言 ⇒ 因果屏障 | ✅ 屏障。播一帧陌生人**有权**看见的公共工作流，等它到达 |
| `ws-repo-imports:171` | 负向断言 ⇒ 因果屏障 | ✅ 屏障，而且**是形式化可靠的那种**（见下） |
| `rfc257-webhook-management:643` | 等写入 ⇒ `eventually` | ✅ `eventuallyAtLeast` |
| `rfc259-github-ingress:134,191,305` | 等写入 ⇒ `eventually` | ✅ `eventually`；其中 `:191` 是**正负各一半** |
| `runtime-routes-registry:694` | （未分类） | 🆕 第四类：「证明在飞的请求还卡着」⇒ 新原语 |
| `plugins-http:680,761` | （未分类） | 🆕 同上 |
| `plugins-http:628` | 推进时钟 ⇒ `sleep-ok` | ✅ `// sleep-ok:` |

### 屏障有两种，强度不一样——写的时候要说清是哪种

`ws-repo-imports` 那条**是真正的因果关系**：repo-import 频道**没有 frameGate**
（`src/ws/registry.ts` 只给它 `upgradeGate`），于是 `gatedSubscribe` 走的是**同步**
`sendJson` 分支——`broadcast()` 一返回，该送的帧就已经在 socket 里了。所以「在跨批次那帧
之后往本批次再播一帧、等它到」严格蕴含「跨批次那帧若被错误路由，一定已经先到了」。
那条注释原本写着 "cannot be predicate-driven — keep a short fixed settle"，**写错了**。

`rfc099` / `rfc152` 那两条**只是相对屏障**：workflows 频道**有** frameGate，而
`gatedSubscribe` 是 fire-and-forget 地起它（`.then(...)`），**跨帧送达无序**。所以
「后播的帧到了」不能证明「先播的帧已判完」。它仍然远好于固定毫秒——机器越慢，屏障请求
本身越慢，观察窗口跟着放大，而固定 30ms 在慢机器上是被吃掉的。**但必须在注释里说明它是
相对屏障**，别让下一个人以为拿到了证明。

### 第四类：「证明一个在飞的请求还卡着」

`plugins-http:680,761` 与 `runtime-routes-registry:694` 是同一个形状：并发互斥用例要断言
「此刻另一个请求还没走完」。原写法一律「睡 10~30ms 再看 settled 标志」。三处同形 ⇒ 按本
RFC 自己的判据（同一 fixture 抄三遍就抽）抽成 `tests/helpers/stillParked.ts`：
**把一趟不走那把锁的请求完整驱过同一个 app**，再读标志；屏障请求自己非 2xx 就直接抛
——屏障没成立的话，后面那条负向断言是空的。

这三处都还有一个关键性质值得记：**真正的产品契约并不靠这条时序断言**
（`probeFence` 计数、409 `resource-operation-stale`、缓存被作废，全是确定性断言）。
时序那半边只负责「当时确实并发」。分清哪半边是契约、哪半边是布景，才知道容许多大的不确定性。

### 改完发现：这个仓里早就有人写对了

`rfc152-ws-frame-gates` 里 memories 的三条用例（`fireSupersededThenControl` + 等
`memory.archived`）**本来就是**控制帧屏障的写法——播一帧该连接有权看见的，等它到，再断言
被门掉的那帧不在。同文件的 workflows 那条却在睡 100ms，`collectFrames` 还带一个
150ms 的兜底 settle。处置是把 workflows 那条**对齐到同文件既有的写法**，并删掉那条兜底。

**规律**：动手改一个形状之前，先在**同一个文件 / 同一个目录**里搜一遍有没有人已经写对了。
这次的正解不用发明，它就在同一个文件里隔了 80 行。

### 每条屏障都做了变异验证

改完必须回答「这条断言还抓得住回归吗」——屏障换错了会让负向断言**永远绿**。逐条变异
（改 `src/ws/registry.ts` 让 frameGate 漏帧 / 让 `channelKeyOf` 不分批次）确认全部转红，
再把源码 revert 干净：

- workflows frameGate 对 `workflow.deleted` 恒返 true ⇒ `rfc099` 转红 ✅
- repo-import `channelKeyOf` 收成常量（跨批次串台）⇒ `ws-repo-imports` 转红 ✅
- workflows frameGate 末尾恒返 true（私有 update 漏出）⇒ `rfc152` 两条转红 ✅

## 5bg. 「已迁完」的文件里还剩 3 条账本残留——两条是同名遮蔽，一条是两个组合根的签名不对称

pre-flight 把 55 个 HTTP 形状的欠债文件过了一遍，其中 3 个同时报
`ALREADY-MIGRATED` **却仍有账本条目**。逐个看完，是三种不同的东西：

### ① `routes/mcps-probe.test.ts`：同名遮蔽让残留看起来像已迁

文件里有一个**模块级** `function buildHarness()`（自建 `createInMemoryDb`），而三个
已迁的 describe 吃的是 `registerProviderApplication` **传进来的同名形参**
`buildHarness`。同名遮蔽之下，`grep buildHarness` 看到一片调用点，完全看不出哪些走
作用域、哪些走模块级那个。真正还用着模块级版本的只有最后那个 `describe('auth')`
的两条 401 用例——它们连 DB 都不碰，迁进作用域是纯机械动作。

### ② `rfc120-task-questions-route.test.ts`：同名遮蔽的第二例，而且两个同名函数**签名还不同**

同样的形状，但更阴：模块级 `makeApp(db)` 是**同步**的、注入的 `makeApp(db)` 是
**异步**的。那条残留用例写 `const app = makeApp(db)`（没有 `await`）——在已迁的那批里
这行会拿到一个 Promise 而当场炸，正因为它吃的是模块级那个同步版本才一直绿着。
**规律**：迁移留下的同名注入函数，若与被取代的模块级函数**签名不同**，那个差异本身
就是「谁还没迁」的指纹——`await` 的有无比 grep 更能定位残留。

### ③ `rfc221-login-policy-routes.test.ts`：不是残留，是两个组合根的签名不对称

这条留在单引擎是对的，但账本里原来记的**理由不准**。按源码重新对账：

- `server.ts:2540` 的 SQLite 根：`deps.secretBox === undefined ? null : …`，
  所以 `oidcProviders === null` **只在没传 secretBox 时**出现；
- `postgresqlDaemonApplication.ts:618` 无条件构造它（`secretBox` 是必填入参）；
- **但关键一条是** `cli/start.ts:1435` 在**选 provider 之前**就 `createSecretBox(...)`
  （源码注释原话 "needed by either selected composition"）——所以**两个引擎的真实部署
  都必定带 secretBox**。

也就是说：`oidcProviders === null` 及其背后那两个 503（`routes/oidc-auth.ts:120,176`）
**在生产上两个引擎都到不了**。原记载「该状态在 PG 上按构造不存在」容易被读成
「PG 缺了 SQLite 有的能力」，**不是**——没有任何用户可见的能力差，差的只是两个组合根的
**装配签名**（SQLite 根收 `secretBox?`，PG 根收 `secretBox`）。

正解是把 SQLite 根也收成必填、删掉 null 分支与那两个 503，这条用例连同最后一条账本
残留一起消失。**没有在本轮做**：要改 47 个测试文件的 `createApp` 入参、并动生产路由
分支，独立一刀更安全。已把准确理由写进用例注释，别再按旧记载理解。

### 账本：550 → 548

①② 各减一条。③ 不减（它该留着）。

### 顺带记一个下一刀会撞上的同类不对称

`scheduled-tasks-run-now` 的 HTTP describe 要注入 `buildScheduleLaunch` 桩（免得
run-now 真去 spawn opencode）。**SQLite 根有这个可选覆盖口**（`server.ts:822`
`buildScheduleLaunch?`，`:2625` 处 `deps.buildScheduleLaunch ?? …`），
**PG 根没有**（`postgresqlDaemonApplication.ts:1294` 直接取
`taskExecutionProvider.trigger.buildScheduleLaunch`）。这与 ③ 同类：不是产品能力差，
是**装配签名不对称**，而它恰好挡住一个 AC-6 迁移。处置方向是给 PG 根补上同形的可选
覆盖（默认值不变），让两个根的合同对齐——**不是**给测试加一个只有 PG 走的特例分支。

## 5bh. 我把 main 推红了一次：跑了 `tests/architecture/` 全绿，红的却是 `tests/` 里的那条摘要守卫

`98545e3f8` 给 PG 组合根补 `buildScheduleLaunch` 覆盖口，推上去 macOS shard 3/6 红：
`rfc359-w29-unstarted-application-composition` 的 daemon 相位**摘要**对不上
（159 条语句没变，摘要从 `5aa7d919…` 变成 `0f43011a…`）。

**推之前我跑了什么**：`tests/architecture/` 全套 663 条，全绿；改动文件各自的用例，全绿；
`tsc --noEmit`、`eslint --max-warnings 0`、`prettier`，全过。

**为什么还是漏了**：那条守卫**不在** `tests/architecture/` 下，它在 `tests/` 根目录。
「改了生产组合根 ⇒ 跑架构守卫」这个联想是对的，但我把「架构守卫」等同于了「那个目录」。
钉 PG 组合根语句图的守卫恰好是个例外。

**教训（与 §5bd 的第 1 条同源，换了个面孔）**：守卫写完要问「它扫的范围是不是正好覆盖了
问题发生的时机」；**跑守卫时也要问「我选的这组文件是不是正好覆盖了我改的东西」**。
按目录选测试是按**位置**选，而风险是按**被依赖面**分布的——两者不重合。

**下次的做法**：改了 `src/cli/postgresqlDaemonApplication.ts` / `src/server.ts` 这类组合根，
除了 `tests/architecture/`，还必须跑 `scripts/source-guard-sweep.ts`（它正是按「哪些测试
读了本包 src/」选的，不按目录），或者至少把
`rfc359-w29-unstarted-application-composition` 显式加进去。

**顺带一条记账更正**：`98545e3f8` 的标题写「账本 550 → 547」是**错的**，实际是 548。
这条账本的 baseline 数的是**文件条目数**，而 `scheduled-tasks-run-now` 那笔是把同一条目的
调用点从 2 改成 1，**条目没减**。（这个坑本轮之前就踩过一次，见 §5v。）

## 5bi. `webhookDispatcher` 不是第三个「纯透传」——两个根对它的**所有权**就不同，得先定语义

补完 `buildScheduleLaunch` 与 `runtimeDiagnosticTestDependencies` 之后，第三个卡住 AC-6
的覆盖口是 `webhookDispatcher`（挡着 3 个文件：`rfc257-webhook-error-codes` /
`rfc259-github-ingress` / `rfc257-webhook-management`）。**它不能照抄前两个的做法**：

| | SQLite 根 | PG 根 |
| --- | --- | --- |
| 谁构造 dispatcher | **不构造**，当依赖收（`deps.webhookDispatcher?`，生产由 `cli/start.ts:2310` 注入） | **自己构造**（`postgresqlDaemonApplication.ts:1247`） |
| 没有 dispatcher 时 | 事件中心两个用途各降级为 `null`（能力探测：`supportsEventCenterCodeHostDelivery` / `supportsEventCenterWorkStart`），公共 ingress 路由**自我跳过不挂载** | 该状态不存在 |
| 部分能力的桩 | 能力探测天然容忍（缺 `dispatchEventTarget` ⇒ 那一路当 `null`） | `1290` 直接调 `webhookDispatcher.dispatchEventTarget(...)`，塞个部分桩进去会**运行时炸** |

所以「给 PG 加一个 `input.webhookDispatcher ?? 构造的那个`」是错的：测试桩只有
`dispatch` / `dispatchSubscription`（见 `rfc257-webhook-error-codes`），一旦有事件目标触发就
在 `1290` 炸 TypeError；而且炸得**很晚**，看起来像别的 bug。

**要先定的语义**（三选一，需要用户拍板，我不自己选）：

1. **覆盖只替换路由面**（`webhookDeliveries` / `webhookIngress` 两处路由依赖），事件中心内部
   仍用自己构造的那个。改动最小、最不惊扰生产，但「同一个装配里两个 dispatcher」读起来别扭。
2. **覆盖整体替换，并把能力探测也搬到 PG 根**：`automationWorkStart` 改成「探测得到才接线」，
   与 SQLite 逐字同构。语义最统一，但这是**行为改动**——PG 上「没有 work starter」这个状态
   从「不存在」变成「可达」，得确认没有哪条路径默认它一定在。
3. **反过来统一**：让 SQLite 根也自己构造 dispatcher、不再当可选依赖，两边都变成「总是有」。
   最彻底，但要动 `cli/start.ts` 的注入与 ingress 路由的自我跳过纪律（那是 RFC-257 明确设计的
   「部分接线就不暴露保证 500 的公共路由」），**属于能力收缩，触发 CLAUDE.md §RFC workflow 第 7 条**。

**在定下来之前不动它**。前两个覆盖口之所以可以直接补，是因为它们**确实**是纯透传：
`RuntimesRouteDependencies` / `integration.scheduledTasks` 本来就声明了那个可选字段，
默认取值逐字未变。`webhookDispatcher` 不满足这个前提，硬套就是在给两个根制造第三种形态。

## 5bj. 一个前置未知数已经测掉：装配之后**中途**改配置，路由读得到

`runtime-routes` / `runtime-routes-registry` 那一簇有个和别人都不一样的形态：它们不是在
装配前准备好配置，而是**在用例中途** `applyConfigPatch(h.configPath, {...})` 再发一次请求，
断言路由看到了新值（换默认二进制、换 `defaultRuntime` 之类）。

共用作用域的 `open({config})` 只覆盖**装配那一刻**的配置，所以迁之前必须先回答：
作用域装配出来的应用，中途改它那份 config 文件还算不算数？已迁的 91 个文件里**一个都没有
这个形态**，查不到先例，只能实测。

写了一次性探针（`describeEachProviderHttpApplication` + `open()` 之后
`applyConfigPatch(join(opened.appHome, 'config.json'), …)` 再打一次 `/api/runtimes`）：
**两个引擎都通过**。路由内部是逐请求 `loadConfig(deps.configPath)`，而 `applyConfigPatch`
自己会让读缓存失效，所以中途改配置照常生效。探针已删。

**结论**：这一簇按 `join(opened.appHome, 'config.json')` 取路径就能原样迁，
不需要给作用域加「重新装配」或「暴露 configPath」之类的新口子。
（`opened.appHome` 本来就在暴露面上。）

**方法记一笔**：迁移前遇到「已迁的文件里没有这个形态」的时候，**写个一次性探针去测，
别靠读代码推断**——这次推断和实测结论一致，但 §5bd 那四版判据的教训是反过来的，
成本只有几分钟，不值得赌。

## 5bk. 一条真的 CI 抖动（不是「重跑就过了」），以及顺手照出的六条「假编排」

`e48b1d71a` 在 ubuntu shard 1/8 红在
`rfc359-w8-t28-lost-update` 的 **L6**（并发删兄弟任务后父行物化列收敛），`[postgresql]` 侧。
本机 3/3 全绿，前两提（`fe0d9e087` / `25c3ba4c2`）跑同一条也绿——是**间歇**。

本仓明令「绝不允许『重跑就过了』作为通过依据」，所以查到机制为止：

```ts
const deletingFirst = deleteTask(legacy(db), firstChild)
const deletingSecond = deleteTask(legacy(db), secondChild)
await settle(20)          // ← 赌 20 个 tick 够两笔删除各自走完认领链、停到自己的写锁上
```

这就是本轮一直在拆的那个形状：**固定等待当同步手段**。8 个分片挤一台 runner 时赌输。
可观测量是现成的——`Semaphore.queueLength`（`src/util/semaphore.ts`，注释原话
"Number of callers blocked waiting for a slot"）。改成等**那件事**：

```ts
await waitForQueued(getTaskWriteSem(firstChild), 1, '第一笔删除停到自己的写锁上')
await waitForQueued(getTaskWriteSem(secondChild), 1, '第二笔删除停到自己的写锁上')
```

变异验证过它不是恒真：把要求改成 3（不可达）会抛并报出 `queueLength=1`，说明确实在观测。

### 顺手照出的：`waitForReads` 静默超时，掩着六条「假编排」

同文件的 `waitForReads` 等不到就**静默 return**。我本想顺手改成抛错，一改
**L1 / L2 / L4 六条（两个引擎各三条）当场转红**——也就是说那几条用例**从来没等到**
它们声称的那个交错，一直是靠静默超时走下去、断言碰巧成立。

**没有在本轮改**：那是一个独立问题，要逐条查清「它们到底想卡在哪一步、为什么那个读等不到」，
而当时 main 正红着（本节开头那条），优先级是把红修掉。已在函数体里写明
「查清之前别顺手改成抛错，会一次推红六条」，并记进 `docs/audit-backlog.md`。

**规律**：**静默超时的等待函数会把「编排没成立」伪装成「编排成立了」**。
本轮两次撞到同一形状（`waitUntil` / `waitForReads`）。写这类 helper 时默认就该抛；
已经静默的那些，**改之前先跑一遍全量**——它可能正兜着好几条你不知道的假绿。

## 5bl. `webhookDispatcher` 定了：选 §5bi 的方案 2（覆盖 + 能力探测），并有测试钉住

§5bi 列了三个选项。**选方案 2**，理由是另外两个都不满足本 RFC 的目标：

- **方案 1（只替换路由面）看似最小，其实制造了新的双引擎分歧**：测试桩在 SQLite 上是
  *唯一*的 dispatcher（事件中心也用它，能力探测兜底），在 PG 上却只管路由面、事件中心仍走
  自建的那个。于是同一条用例在两个引擎上**观察到的派发不是同一批**——正是 AC-6 要消灭的东西。
- **方案 3（反过来让 SQLite 也自己构造）** 要动 `cli/start.ts` 的注入与 ingress 路由的
  自我跳过纪律（RFC-257 明确设计的「部分接线就不暴露保证 500 的公共路由」），属于能力收缩，
  触发 CLAUDE.md §RFC workflow 第 7 条，代价远大于收益。

**方案 2 的落地**（`postgresqlDaemonApplication.ts`）：

```ts
const composedWebhookDispatcher = createWebhookDispatcher({ … })   // 原来那个，改名
const webhookDispatcher = input.webhookDispatcher ?? composedWebhookDispatcher
…
...(supportsEventCenterWorkStart(webhookDispatcher) ? { automationWorkStart: { … } } : {}),
deliveryConsumers: supportsEventCenterCodeHostDelivery(webhookDispatcher) ? [ … ] : [],
```

两处能力探测与 `server.ts`（`codeHostDeliveryDispatcher` / `eventWorkStarter` 那两段）
**逐字同构**——这不是我发明的第三种形态，是把 SQLite 早就在做的事搬过来。
**生产逐字不变**：不传覆盖件 ⇒ 取自建的 ⇒ 它带全部能力 ⇒ 两个门都通过。

### 两条用例，两种「承重」，都变异验证过

- `rfc257-webhook-error-codes`（迁了 15 条 ×2）：这批只走**拒绝路径**，**从不到达派发**。
  所以把 PG 的 `??` 抽掉**不会红**——它证明不了 PG 侧那个口子。但把**夹具**的
  `webhookDispatcher` 抽掉，`[sqlite]` 三条立刻红：SQLite 根没有 dispatcher 就
  **不挂 ingress 路由**。**同一处改动，两个引擎的「承重点」不在一处**，各验各的才算数。
- `rfc259-github-ingress`（迁了 10 条 ×2）：它断言 `calls`（真的派发了哪几笔），
  抽掉 PG 的 `??` ⇒ `[postgresql]` 三条当场红。**这条才是钉住 PG 覆盖口的那个用例。**

**规律**：给两个 provider 补对称口子时，**别拿只走拒绝路径的用例去证明它承重**——
那种用例够不着被改的那一段。先问「这个口子生效时会发生什么可观测的事」，再去找断言了那件事的用例。

### 单引擎留一条，理由与 §5bg③ 同类

`rfc257-webhook-error-codes` 的 `webhook-ingress-unavailable`（装配缺 dispatcher ⇒ replay 拒绝）
留在普通 describe：被测的是「装配里没有 dispatcher」这个**测试独有**的形态
（生产两侧都必有一个：`cli/start.ts:2310` 注入 / PG 根自建），塞进 provider 作用域还会带着
自建的 bun:sqlite 库在 `[postgresql]` 那一遍里炸。

## 5bm. `mcpRuntimeTestDependencies`：第四个覆盖口，又是「同一个服务、只有一边转发」

`server.ts:2014-2023` 把 `runFn` / `now` / `capacity` 三项条件展开进
`getMcpRuntimeTestService(...)`；PG 根建的是**同一个**服务（`postgresqlDaemonApplication.ts:603`），
却一项都没转发——于是 MCP 运行时测试那两个文件在 PG 上没法双跑。补成同形，三条条件展开，
生产逐字不变。

**`appHome` 不在这三项里**，值得单记：SQLite 根读的是
`mcpRuntimeTestDependencies?.appHome ?? Paths.root`，PG 根读的是 `input.appHome`。
迁进作用域之后两边**自然对齐**——作用域在装配前把 `AGENT_WORKFLOW_HOME` 指向它现建的目录，
于是 `Paths.root === appHome`。用例因此可以**把 `appHome` 从注入口里删掉**，
而不是往 PG 那边也加一个 `appHome` 字段（加了反而会出现「两个来源、可能不一致」）。

### 又一次撞上「我自己的注释被按文本扫的守卫算成调用点」

迁完 `rfc349-mcp-runtime-test-daemon-identity` 后账本仍然报它有 1 个调用点——查下去是
**文件头注释里写了那个建库函数的字面名字**（在解释「为什么既有 rfc238 测试绕开了这条分支」）。
账本守卫按文本扫，注释也算它的输入。

**本 session 第四次撞同一形状**（前三次见 §5ab 等）。处置照旧：改写注释、不写出那个字面名字，
并在原地留一句说明为什么不写。**规律**：凡是「按文本扫源码」的守卫，它的语料**包含注释**；
写注释解释某个 API 时，先想一下有没有守卫在扫它。

### 本轮四个覆盖口的共同判据（给下一个人）

1. **先确认它到底是不是「纯透传」**：看那个字段有没有**已经**出现在某个共享类型上
   （`RuntimesRouteDependencies` 有 ⇒ 纯透传；`webhookDispatcher` 没有、两个根所有权不同 ⇒ 不是）。
2. **找一个「这个口子生效时会发生可观测的事」的用例去变异验证**，别拿只走拒绝路径的用例
   （§5bl 的教训）。
3. **两个引擎的承重点可能不在一处**，各验各的。
4. 改完组合根必跑 `scripts/source-guard-sweep.ts`，不能只跑 `tests/architecture/`（§5bh 的教训）。

## 5bn. `intentTestDependencies`：第五个覆盖口，以及「模块级钩子」那一坑的第二次

与 `mcpRuntimeTestDependencies` 完全同形：`IntentSessionRouteDependencies` 本来就有 `runTurn`，
`server.ts:2750-2752` 一直条件展开进去，PG 根没转发。补一条同形展开即可。

### `rfc355-intent-session-event-callsites` 踩的是「模块级 harness」

这个文件把 `beforeEach` / `afterEach` 写在**模块级**（不在任何 describe 里），于是它们
**对整文件生效**。pre-flight 的 `MODULE-LEVEL-HARNESS` 就是为这个形状加的：如果只把
里面那个 describe 包进 provider 作用域，模块级钩子仍然建自己那个 SQLite 库，
**两个引擎跑的是同一个库**，双跑等于白跑。

处置：整段钩子**上提进注册面**（与 §5az 的 `rfc327` 同一招）。同时 app home 交给作用域
——原来它自己 `mkdtempSync` 再设 `process.env.AGENT_WORKFLOW_HOME`，迁进来之后那份会被
作用域覆盖掉。`afterEach` 里只剩 `unsubscribe()`：删目录与还原环境变量都归作用域。

pre-flight 还给这个文件报了 `PURE-DESCRIBE(别包，保持普通 describe)`——**那条提示在这里是
误导**，因为判据看的是「describe 块**自己**有没有碰库/建 app」，而这个文件的 setup 全在
模块级钩子里，块内自然看着很"纯"。**两个标记同时出现时，`MODULE-LEVEL-HARNESS` 优先**：
先把钩子上提，`PURE-DESCRIBE` 随之消失。（已在此记录，免得下一个人照着 `PURE-DESCRIBE` 跳过它。）

### 一次「守卫在我改源码的中途跑」的假红，值得记

这一轮跑 `source-guard-sweep` 时我**同时**在改 PG 组合根（加 intent 那条展开）。
sweep 跑到 W29 那一批时，源码已经是新的、而 W29 的摘要我还没更新，于是报红。
**不是真回归**，但也**不是噪声**——它恰好演示了这个 sweep 的价值（§5bh 那次就是没跑它）。
**做法**：sweep 要在**源码停手之后**跑；跑之前 `git status` 看一眼自己还在不在改。

### 账本 544 → 541

`rfc238`(-1) / `rfc349`(-2，其中 1 条是**注释里写了建库函数名**被按文本扫算成的调用点，
见 §5bm) / `rfc355`(-1)。

**`rfc234-intent-routes` 留到下一刀**：1126 行、两个 describe、三处 `createApp`
（其中两处在用例中途**换一套 stub 重建应用**）。

**那个判据已经先查掉了**（省下一次试错）：`runTurn` 是**逐请求取**的——
`src/modules/intent/inbound/intentSessionRoutes.ts:149` 在 `dispatchIntentTurn(...)` 的
入参里现取 `deps.runTurn`，不是装载时捕获（与 `mountRuntimesRoutes` 装载期就取
`smokeRuntime` 正相反，见 §5bj）。

**所以那两处「换 stub 重建应用」可以直接塌成换目标**：注册一个稳定转发闭包指向
`currentRunFn`，用例中途只改 `currentRunFn`，**不必重开应用**——重开会换掉 app home，
把用例中途写进去的东西一起丢掉。

**规律**：遇到「注册期参数 vs 用例中途要换」这类冲突，先去读**消费端**那一行是
`const x = deps.x`（装载期）还是在函数体里 `deps.x`（逐请求）。两个答案给出完全不同的迁移
形状，而读一行就能定。

### 5bn 补记：`source-guard-sweep` 的**前置条件**比我以为的严

同一轮里我被这个咬了两次，两次都不是回归：

1. **源码还在改的时候跑 sweep** ⇒ W29 摘要守卫报红（源码已新、摘要还没更新）。
2. **census 还没重采就跑 sweep** ⇒ `RFC-294 N1b` 的两条清单守卫报红
   （我在上一次 census 之后又动了一次 PG 组合根，哪怕只是**调整接口成员顺序 + 挪注释**）。

所以顺序是死的：**改完源码 → `prettier --write` → 重采 census → 再跑 sweep**。
少任何一步，sweep 都会报出与本次改动无关的红，而你得花时间把它们一条条排除掉
——这比不跑还糟，因为它会训练你忽略 sweep 的输出。

3. **别在 sweep 跑的时候另外跑 `bun test`**。这一轮我并发跑了一次 W29，结果
   `rfc223-pr1-impl-gate` 的 `[postgresql]` 在那一批里 **5393ms 超时**（bun 默认 5s），
   隔离重跑 3/3 全绿。那不是「flaky 可以忽略」，那是**我自己制造的 CPU 争抢**——
   但它和真 flake 在日志里长得一模一样，事后无法区分。**sweep 期间保持机器安静。**

## 5bo. `rfc234-intent-routes` 迁完，顺带照出一条「只在 SQLite 上成立」的分页判据

意图路由那一簇最后一个文件（1126 行 / 两个 describe / 三处 `createApp`）。
按 §5bn 先查掉的判据（`runTurn` 逐请求取），那两处「换 stub 重建应用」**直接塌成换
`currentRunFn` 目标**——不重开应用，于是 app home 与中途写进去的东西都保得住。
模块级钩子照 §5bn 上提进注册面。文件里三处 `.run()` / 一处 `.get()` 同步终结符一并改成 await。

### 照出来的：keyset 分页那条用例的前提「数据集静止」只在 SQLite 上自动成立

`v22 additive keyset page returns canonical journey and preserves legacy array` 建三条会话、
`limit=2` 翻两页，断言第二页恰好 1 条。迁到 PG 后 **3 次里红 1 次**，第二页回 0 条
（三条会话确实都在——同一用例里 `?cursor=legacy-client-value` 那条断言 3 条是过的）。

成因：`POST /api/intent-sessions` 会顺带点燃一次意图回合，而那次回合**回写会话行**
（`updatedAt` / `journey`）——正是 keyset 游标排序依赖的列。SQLite 上这些写同 tick 落盘，
翻页时数据集早已静止；PostgreSQL 是真往返，**回写落在两次翻页之间**，游标于是漂掉一条。

**这不是产品缺陷**：keyset 分页在数据集并发变动时本来就会漂，这是它的已知取舍；
而本用例要钉的是**分页形态**（页大小 / nextCursor / 两页不重叠），不是并发下的稳定性。
处置是补因果屏障——建完三条之后逐个 `pollDetail` 等到 `inFlight === false` 再翻页。
补完 4/4 全绿。

**规律（本轮第二次遇到同型）**：**「数据集静止」是很多用例的隐含前提，而它在 SQLite 上
是免费的、在 PostgreSQL 上不是。** 迁移时看到「建若干行 → 立刻查询/翻页/统计」的形状，
先问一句「建的过程会不会顺带触发异步回写」。会的话，屏障要补在**查询之前**，
而不是等断言红了再去调超时。

**另记（未处置）**：同一次红里 dispatcher 打了
`intent-turn-fire-failed … err="deadlock detected"`（PostgreSQL 死锁）与 `err="session vanished"`。
补完屏障后不再出现。**那是 dispatcher 自己的重试域**（它 warn 一下、把该回合记失败），
与本用例的判据无关，但「并发点燃意图回合会在 PG 上撞死锁」值得单独查一次，已记进
`docs/audit-backlog.md`。

### 账本 541 → 540

## 5bp. `repos.test.ts`：残留不在「还没迁的那半」，而在「只服务一条用例的 native 注册器」

这个文件**早就双引擎**——它自己手抄了一份 application lifetime
（`describeEachProvider` + `createProviderHttpApplication` + 自建 app home 与 dispose 顺序，
正是共用作用域要取代的那 18 份拷贝之一）。账本里那 1 个调用点在旁边：一个**只跑 SQLite**
的 `registerNativeApplication`，自建内存库 + 自建应用。

它服务几条用例？**一条**——`all /api/repos/* require token`（不碰库，只验无 token ⇒ 401）。
并进 provider 注册面，整个 native 注册器连同它的建库/建应用一起删掉。
401 现在两个引擎各跑一遍（junit 里 `name="all /api/repos/* require token"` 数得到 2 条）。

**判据**：看到「同一文件里 provider 注册面与 native 注册面并存」，别假设 native 那边是
「还没迁完的一半」。**先看它到底还测什么**——常常只剩一两条不碰库的门禁用例（401 / 404 /
参数校验），并过去就能整段删，而不是去给它补一套双引擎装配。

（顺带：本文件仍是那 18 份手抄 lifetime 之一，没有换成
`describeEachProviderHttpApplication`——那是独立的一刀，与本轮账本无关。）

## 5bq. 同一个形状连撞三次：「provider 注册面旁边那个只服务一两条用例的 native 构造器」

`repos`(§5bp) / `rfc310-digital-employee-writer-cutover` / `rfc234-config-intent-runtime`
三个文件的账本残留**完全同形**，值得单独立一条判据：

| 文件 | 已双引擎的部分 | 残留 | 残留服务几条用例 |
| --- | --- | --- | --- |
| `repos` | 手抄的 application lifetime | `registerNativeApplication` | **1**（401 门禁，不碰库） |
| `rfc310-…-writer-cutover` | `describeEachProvider` 服务层块 | 文件下半段一个普通 `describe` | **1**（HTTP 拒绝 + 排空报告） |
| `rfc234-config-intent-runtime` | 手抄的 provider 注册面 | 模块级 `makeApp()` | **1**（`resolveIntentTurnConfig`） |

**判据**：看到「同一文件里已迁的注册面 + 一个单引擎构造器」并存，**先数那个构造器还服务几条用例**。
三次都是 **1 条**，并进去就能把整个构造器连同它的建库/建应用一起删掉——
比给它补一套双引擎装配便宜一个数量级，也不会留下「两套装配」的长期债。

反过来说：**别默认那半是「还没迁完的一半」**。前几波确实有那种（§5aa 的「新半 + 旧半并存」），
但到这个阶段，剩下的多半只是**没人回头收的尾巴**。

### 顺带又验证一次「从 helper 那头拆」

`rfc234-config-intent-runtime` 迁的时候被
`intentTurnRuntimeResolverForTest(db: DbClient)` 挡了一下——而它的函数体只是把库转手给
`intentPersistenceForTest`，**那个早就是中立面了**。形参的 `DbClient` 纯属未收敛，
收一下就通。**判据**：被 helper 的类型挡住时，先读它的函数体到底用没用到 bun:sqlite 专有面；
没用到就直接收形参，不要在调用方 `as` 一下绕过去。

### `rfc310` 顺带清掉 4 个同步终结符

那 4 处是 `await db.insert(...).values({...}).run()`——**awaited 的 `.run()`**，
在中立面上能过类型也能跑，所以一直没被发现。去掉 `.run()` 即可（`await` 本身就是终结）。
**它们能活下来是因为守卫只扫已迁文件**（§5bc）：这个文件的 HTTP 那半迁进来之后就会被扫到，
所以顺手清掉是必须的，不是可选的。

### 账本 540 → 537

## 5br. 迁 `rfc234-intent-routes` 推红了一次 CI —— 而那是一条**真的 PG-only 产品缺陷**

`c8c944bed` 推上去，ubuntu shard 6/8 红。日志里**没有任何 `(fail)`**，只有：

```
# Unhandled error between tests
PostgresError: Connection closed
 code: "ERR_POSTGRES_CONNECTION_CLOSED"
```

**这种红看起来像绿的**：bun 把它算作 `1 error`，计数行照样 `N pass / 0 fail`，只把退出码变成 1。
（本仓已经吃过同一个亏——`test-suite-policy` 里那段注释记的就是它。）

### 机制

`dispatchIntentTurn` 的 **13 个调用点全是 fire-and-forget**（3 个在 dispatcher 自己、
10 个在 `intentSessionRoutes` 的 `void fireTurn(...)`）：应答先回，回合在后台跑。
它**有** try/catch/finally，但——

**它的 catch 与 finally 里也在写库**（`settleReservedIntentTurnStartFailure` /
`activateIntentWorkingSetChange`）。连接池一关，**处理块自己就抛**，异常于是**越过它自己的
catch** 逃出来，`void` 掉之后就是一条进程级 unhandled rejection。

PostgreSQL 上这条路径真实可达：回合在后台跑，进程（或测试作用域）收尾时把池关掉，
在飞的那笔查询直接拿到 `ERR_POSTGRES_CONNECTION_CLOSED`。
**SQLite 是同步单写者，没有「池关了但活还在跑」这个窗口**，所以此前一直看不见。

### 修法：把网织在**被调用方**，不是 13 个调用点上

第一版我给 `fireTurn` 加 `.catch()`——能修，但要给 `intentSessionRoutes` 新引一个 logger，
于是三份架构账本涨了（`cross-context-observed-imports` +1 / `architecture-exceptions` +1 /
`module-symbol-owners` +2），而**涨账本要一次性 `allowGrowth` 并点名 RFC**。

第二版把外层 try/catch 放进 `dispatchIntentTurn` **自己**：dispatcher 本来就有 `log`，
**零新符号、零新 import、三份账本一个没涨**，而且 13 个调用点一次全覆盖——
以后再多一个 `void dispatchIntentTurn(...)` 也自动被兜住。

**规律**：**一个「所有调用点都 fire-and-forget」的函数，保证不 reject 是它自己的责任，
不是调用点的。** 把网织在调用点上，既漏（下一个调用点忘了加）又贵（常常要给调用方新引依赖）。
顺带一条：**先看改动会不会顶高架构账本**——顶高了就说明这个修法在「往外摊」，多半有更内聚的位置。

### 已变异验证

抽掉那层外层 catch，`rfc234-intent-routes` 立刻回到 `EXIT=1 / unhandled=1`（而
`28 pass / 0 fail` 不变——再次说明**不能只看计数行**）；装回去 3/3 全绿、`EXIT=0`。

### 这是本 session 第 4 条「靠迁移照出来的 PG 缺陷」

前三条见 STATE.md 上一段（工作树预检空操作 / 房间补偿无 catch / 同名并发 409 退化成 500）。
**四条里有两条是同一个形状：fire-and-forget 少一层网。** 值得单独做一次全仓扫查
（`void <expr>(...)` 且无 `.catch`），已记进 `docs/audit-backlog.md`。

## 5bs. WS 那一簇（11 个文件）的拦路石查清了——但它比看起来深一层，**没动手**

HTTP 形状的欠债里最大的一簇是 WebSocket 用例：**11 个文件**都调
`composeTestSqliteRealtimeRuntime`（`tests/helpers/realtimeRuntime.ts`），被钉在 SQLite 上。
本轮把它查清但**刻意没动手**，把结论留下省下一次重复探路。

### 第一层（可解，且不必动生产）

`composeTestSqliteRealtimeRuntime` 里两处 `composeSqlite*` 是真的 provider-bound。
但底下**全是中立的**：

- `DrizzleRealtimeStore` 的构造器收的就是 `ProviderNeutralDatabase`；
- `composeSqliteRealtimeRuntime` 与 `composePostgresqlRealtimeRuntime` 的**函数体逐字相同**，
  差别只在两个导出包装声明的 `db` 类型；
- 资源目录那边**根本不用分派**：`composeResourceCatalogFor` 本身就是导出的中立函数
  （两个 `composeXxxResourceCatalog` 也只是它的类型化包装）。

所以测试侧按 harness 的 `applicationBinding` 判别式分派就行——`rfc359-w12-realtime-composition.test.ts`
**已经是这么写的**，照抄即可。我写过一版 `composeTestProviderRealtimeRuntime`，零 `as` 强转、
`tsc` 干净。

**没把那对孪生合成一个中立导出**：它是 RFC-349「provider-selected composition」有意留的形状，
而且 `rfc359-w12-realtime-composition` 正是钉它的；要不要合并是那条线自己的决定，
**不该作为一次测试迁移的副作用**（生产调用点也只有 2+2 个，真要合很便宜）。

### 第二层（真正的拦路石）

WS 用例不是只要一个实时运行时——它们**自建 `Bun.serve`**，把 `ws.tryUpgrade` 和
**`app.fetch` 的 HTTP 回落**接在一起，而那个 `app` 来自 **`createApp`，也就是 SQLite 根**。
换句话说：解掉实时运行时之后，**应用本身仍是单引擎的**。

所以这一簇要的不是「再补一个 helper」，而是一个 **WS 版作用域**——
形如 `describeEachProviderHttpApplication`，但额外交出「活的 server + 已接好的 ws 适配器」，
应用取自 `createProviderHttpApplication`（两个引擎都装得起来）。

**估算**：写这个作用域一次，11 个文件顺次迁；不写它，每个文件都要自己把
`Bun.serve` + 适配器 + provider 应用重新拼一遍——正是共用作用域当初要消灭的那 18 份拷贝。
**所以下一刀应该是「写 WS 作用域」，不是「逐个迁 WS 文件」。**

我把探路的两处改动都 revert 了（helper 没有消费者就是死代码，与本 RFC 对「补了口子必须有用例钉住」
的要求同一把尺）。

## 5bt. WS 作用域写出来了——**WebSocket 用例第一次在 PostgreSQL 上跑起来**

§5bs 查清了两层拦路石，这一轮把作用域写了：`tests/helpers/providerWebSocketScope.ts`
的 `describeEachProviderWebSocketApplication`。它一次交出
**provider 应用 + 实时运行时 + ws 适配器 + 活的 server**：

- 应用来自内层的 `describeEachProviderHttpApplication`（两个引擎都装得起来）；
- 实时运行时来自 `composeTestProviderRealtimeRuntime`（按 `applicationBinding` 判别式分派）；
- `Bun.serve` 的 `fetch` 把 `ws.tryUpgrade` 与 **`opened.app.fetch` 的 HTTP 回落**接在一起
  ——那正是 WS 用例原来各自手拼的那一段；
- 交出 `url`（`ws://…`）与 `httpUrl`（同一监听器的 http 形态，WS 用例常要先打 REST 建数据）。

### 两个细节是踩出来的，不是设计出来的

1. **identityAccess 必须用应用自己装配的那一份**（`opened.identityAccess`），
   不能像原来那样另 `createIdentityAccessRuntime({ db })` 建一个——两份实例会让**升级门**和
   **路由**看到不同的授权视图。共用作用域早就把它暴露出来了（§5ar 那一批），直接取。
2. **广播器是进程级单例**，作用域的 `afterEach` 必须 `resetBroadcastersForTests()`，
   否则上一条用例的订阅者会收到本条的帧。原来每个文件的 `cleanup` 各做一次，现在归作用域。

### 已迁两个，账本 537 → 535

`ws-repo-imports`（8 条 ×2）与 `rfc152-ws-frame-gates`（5 条 ×2）。
junit 里两个文件都各有 `[sqlite]` / `[postgresql]` 两组 classname——
**这是本仓 WebSocket 用例第一次在 PostgreSQL 上跑。**

### 变异验证：确认 PG 分支是**真的**走到了

把 `composeTestProviderRealtimeRuntime` 的 PG 分支换成 `throw`，
`ws-repo-imports` 立刻炸在那一行。**这一步不能省**——分派写错时最容易的失败形态是
「两遍都走 SQLite」，那样 junit 里照样有两组 classname、照样全绿，但 PG 侧等于没跑。

### 剩下 9 个 WS 文件

`rfc152-ws-channel-registry` / `rfc312-impl-gate-fixes` / `rfc212-revalidation-behavior` /
`ws-auth-multi-token` / `rfc338-websocket-heartbeat` / `ws` / `rfc099-ws-acl-filter` /
`rfc152-ws-task-channel` / `rfc225-workgroups-ws`。形状与已迁的两个一样：
`buildHarness` 收成 `scope.open()`、删掉自建的 `Bun.serve` / 适配器 / `createApp`、
`h.server.hostname:port` 换 `h.httpUrl`。

## 5bu. WS 那一簇迁掉 6 个：**先按「要不要应用」分流**，别一律套作用域

§5bt 写出 WS 作用域之后，剩下 9 个文件**并不都需要它**。先用一条 grep 分流：

```
app.fetch=?  Bun.serve=?  $client=?
```

- **有 `app.fetch` 回落** ⇒ 真的要**应用**，套 `describeEachProviderWebSocketApplication`
  （`rfc099-ws-acl-filter` / `ws`）；
- **没有应用**（ws 之外回落是一条 404）⇒ 只要换库 + 按 provider 分派实时运行时，
  `Bun.serve` 仍归文件自管，用 `describeEachProvider` 就够
  （`ws-auth-multi-token` / `rfc152-ws-task-channel`）；
- **连 server 都不要**（直接调 `adapter.handlers.message` 或只取 `.channels`）⇒ 同上，更轻
  （`rfc338-websocket-heartbeat` 39 行 / `rfc225-workgroups-ws` 的第二个 describe）。

**为什么值得分流**：给一个只调 `handlers.message` 的 39 行用例套上「应用 + server」的作用域，
是把它的依赖面凭空放大——跑得更慢，失败面更宽，而它一条 HTTP 都不打。
**作用域是给「真的需要那一套」的用例准备的，不是默认值。**

本轮按这条分流迁了 6 个（账本 535 → 530）：
`rfc338-websocket-heartbeat` / `ws-auth-multi-token` / `rfc225-workgroups-ws` /
`rfc152-ws-task-channel` / `rfc099-ws-acl-filter`，外加 §5bt 的两个。

### 剩 3 个都卡在同一件事：用例自己 `db.$client.close()`

`rfc152-ws-channel-registry`(6 处) / `rfc312-impl-gate-fixes`(4 处) / `rfc212-revalidation-behavior`(3 处)。
库归 harness 所有，用例关它在双引擎下本来就不该有（§5x 记过同一条）。
这三个要先把自持库的生命周期交出去，才谈得上分流——是下一刀。

## 5bv. AC-6 的 530 条里，**80 条是 `migration-*.test.ts`——它们按定义就不该双引擎**（需用户裁决）

把 530 条按「卡在什么」重新分层（可复跑，判据见下）：

| 类别 | 数量 | 说明 |
| --- | --- | --- |
| 服务层/其他 | 271 | 其中 **80 条是 `migration-*.test.ts`**（见下） |
| 卡:任务执行拓扑 | 113 | `createTaskExecutionTestTopology` 一族（§5af 那一刀） |
| 卡:裸 `$client` | 76 | 用例直接写 bun:sqlite 原生 SQL |
| 已部分双引擎(残留) | 47 | 文件里已有 `describeEachProvider`，另一半没迁 |
| HTTP 形状 | 23 | 还剩这些是「省力入口」 |

### 那 80 条 migration 测试测的是**SQLite 迁移链本身**

实测：**57 条用 `pragma_table_info` / `PRAGMA`、29 条查 `sqlite_master`**（有重叠），
其余的也都是 `createInMemoryDb(MIGRATIONS)` 之后断言「这条迁移把表改成了什么样」。
`pragma_table_info` 在 PostgreSQL 上**根本不存在**；而即便改写成中立断言，它测的
「`db/migrations/*.sql` 这条链跑完是什么形状」也**只对 SQLite 成立**——PG 不共享这条链。

**PG 那边不是没覆盖，是另有其人**：`scripts/rfc349-schema-contract.ts` 从 SQLite schema 投影
生成规范契约（`schema-contract.json` / `.md`），架构测试**逐字节比对**，"schema drift cannot be
published silently"；另有 `rfc359-t19h-postgresql-migration-sequence` /
`rfc359-t19h-postgresql-upgrade.integration` 覆盖 PG 自己的迁移序列与升级。
**所以把这 80 条排除出 AC-6 不会留下 PG 覆盖洞。**

### 但我**没有**自行把它们豁免——因为守卫的设计明确在防这件事

`EXEMPT` 目前只有 **2 条**（harness 自己 + 本守卫），且它自带账本
`rfc359-w5-test-engine-hardcoding-exempt` baseline=2、**只降不升**，理由原文写着
「防止豁免退化成空白许可证」。往里塞 80 条正是这条规则要挡的动作。

**需要用户裁决的是判据问题，不是豁免问题**：AC-6 的原文判据是
「**全量 backend 行为套件**在真 PostgreSQL 上进 push CI」。
迁移链测试**不是行为套件**，是单引擎的 schema 溯源测试。所以正确的做法应当是
**把账本的匹配判据收窄**（例如：`migration-*.test.ts` 且加载了 SQLite 迁移链的，
不计入单引擎欠债），而不是给它们发 80 张豁免票。

两种处置的差别：收窄判据 = 承认「它们从来不在 AC-6 范围内」；发豁免票 = 承认「它们在范围内但我们不做」。
**前者是对的，但它改变了一个 AC 的口径，所以这一刀我留给用户拍板，没有自行执行。**

裁决之后 AC-6 的真实剩余量是 **450**（530 − 80），其中最大的一块仍是「卡:任务执行拓扑」的 113。

## 5bw. 账本的判据换掉了：**按 AST 数真调用点，不按文本数**

`rfc359-w5-t19f` 的高水位账本一直是纯文本扫描（`/\bcreateInMemoryDb\(|\bnew Database\(/g`）。
它认不出注释与字符串，于是**写字也算欠债**。实测三处（2026-09-13）：

| 文件                                       | 被记成债的那一处                                          |
| ------------------------------------------ | --------------------------------------------------------- |
| `backup.test.ts`                           | 一行注释里提到 `new Database()`                            |
| `createindb-snapshot-parity.test.ts`       | 文件头注释两次提到 `createInMemoryDb()`——它正是锁这个工厂的用例，绕不开要写出名字 |
| `subagent-live-capture-source.test.ts`     | `expect(src).not.toContain('new Database(')`——一条**禁止**建库的源码断言 |

误计不只是数字不准，它让「把账本改到 0」**做不到**：除非去改那些本该这么写的注释与断言。
守卫自己也因此不得不自我豁免。这条坑在本 RFC 已经重复踩到第五次（前四次都是「我写的注释被数进去了」，
处置都是改注释措辞），所以这次改的是**判据本身**：

- 只认真正会执行的节点——`createInMemoryDb(...)` 的 `CallExpression`、`new Database(...)` 的 `NewExpression`；
- **模板字面量仍然数**：worker 源码经常以模板串写在用例里再落盘执行
  （`e2e-sqlite-fixture-lock-contention.test.ts` 的 `HOLDER_SOURCE`），那是货真价实的单引擎构造，
  只是推迟到子进程；不数它等于给「把单引擎测试搬进字符串」开一个后门；
- 守卫的**自我豁免退役**（`EXEMPT` 账本 2 → 1，只剩 harness 自己的家 `helpers/eachProvider.ts`）。

代价：2103 个文件全 AST 解析一遍实测 ~1.5s，落在守卫既有的 30s 预算里还有充足余量
（`typescript` 的 `createSourceFile` 本来就是本仓守卫的既有写法，见 `census.ts` / `rfc317-*`）。

账本随之 528 → 527（净减 1 个文件条目 / 4 个调用点，全是上面三处误计）。

## 5bx. 批量迁移的工具化：两次「文本替换」翻车，最后落在全 AST 变换上

92 个文件是「同一个形状」的单引擎用例（单一顶层 `describe` + `const MIGRATIONS` + `createInMemoryDb(MIGRATIONS)`），
手迁一个 5 分钟、92 个就是大半天，所以写了个变换器。**前两版都翻车，值得记下来**：

**第一版（纯正则）**：把 `createInMemoryDb(MIGRATIONS)` 全文替换成 `harness.db`，`describe(` 换成
`describeEachProvider(`。23 个文件跑出 56 fail，两类系统性错：

1. `beforeEach` 在**模块作用域**（不在那个 `describe` 里）——替换后 `harness is not defined`；
2. 库在 **describe 体里**直接建（`const db = createInMemoryDb(...)` 挨着 `describe` 的第一行）——
   harness 有显式守卫：`ProviderHarness 只能在 test 体内读取（beforeEach 之后才有库）`。

**第二版（正则 + AST 选文件）**：用 AST 判「每个构造点都在顶层 describe 的体内、且都在
`beforeEach` / `test` 回调里」，选出 43 个安全文件——但变换本身仍是文本替换，于是
`\bDbClient\b → ProviderNeutralDatabase` 这条**把源码断言里的字符串也改了**：
`rfc349-collaboration-runtime-mechanics.test.ts` 的
`expect(contract).not.toContain('DbClient')` 变成了 `not.toContain('ProviderNeutralDatabase')`，
判据当场反转（那份合同**必须**含 `ProviderNeutralDatabase`）。同一个文件还被塞进了重复 import——
它本来就 import 过 `ProviderNeutralDatabase` 和 `describeEachProvider`。

**与 §5bw 是同一条教训的两面**：判据（数债）和变换（改代码）都不能把「文本里出现某个名字」
当成「代码里用了某个符号」。

**第三版（全 AST）**：
- 改名只打在 `TypeReferenceNode` 的 `DbClient` 上，字符串与注释一概不碰；
- `ReturnType<typeof createInMemoryDb>` 整个类型引用换成 `ProviderNeutralDatabase`；
- 先读一遍现有 import，已经有 `ProviderNeutralDatabase` / `describeEachProvider` 的就不再插入；
- 所有改动收成 `{start, end, text}` 编辑列表、按位置**倒序**施加，避免位移串位；
- 收尾才用正则清 `describe` / `resolve` 这两个变成死的 import（它们是纯 import 行，文本安全）。

## 5by. `bun test` 不做类型检查——2230fe977 双引擎全绿，tsc 是红的

27 个迁移里 **11 个过不了 typecheck**：它们把 `harness.db`（`ProviderNeutralDatabase`）传给了形参
仍写死 `DbClient` / `LegacySqliteTaskDatabase` 的既有函数。运行时不报，因为被调用的那些函数体
恰好只用中立 API（`bun test` 两个引擎都跑绿）；**编译期报**，因为形参类型没放宽。

于是 main 红在 `Lint + Typecheck + Format` 这一格，而我本地只跑了「改过的文件的 eslint + prettier
+ 那几个测试」。**验证清单里从此必须有 `bun run typecheck`**——它是唯一能看见这类问题的门。

卡住的 callee（按错误数）：

| callee                                   | 定义处                                                              | 形参                        |
| ---------------------------------------- | ------------------------------------------------------------------- | --------------------------- |
| `healScheduledLaunchPayloads` 等 scheduled-tasks 一族 | `services/scheduledTasks.ts`                             | `DbClient`                  |
| `assertWorkflowLaunchable` / `buildStartTaskDeps`     | `services/taskLaunchGate.ts` / `services/startTaskDeps.ts` | `LegacySqliteTaskDatabase` |
| `createEmployeeReactionRoundQueries`      | `modules/digital-employee/composition.ts`                           | `DbClient`（另有 PG 孪生）  |
| `inspectDigitalEmployeeHumanReviewState`  | `modules/task-execution/composition/digitalEmployeeExecution.ts`    | `DbClient`                  |
| `transitionTaskStatusByEvent`             | `platform/persistence/sqlite/taskLifecycle.ts`                      | `DbClient`                  |
| `importWorkflowYaml`                      | `modules/resource-catalog/infrastructure/legacy/workflow.yaml.ts`   | `DbClient`                  |

**实测过一次「一刀放宽」**：`LegacySqliteTaskDatabase = DbClient` 改成 `= ProviderNeutralDatabase`
后 src 只剩 4 个错（`scheduleLaunch.ts` 3 + `startTaskDeps.ts` 1），但**只消掉 5 个测试侧错误**；
再把 `legacySqliteTransportMechanisms.ts` 里那条独立的 `export type { DbClient as
LegacySqliteTaskDatabase }` 一起统一，`services/task.ts` 立刻炸出 34 个——它的函数体真的在用
SQLite 同步面。所以这不是一个别名的事，是**一波按 callee 逐个放宽**的工作，单独立波次做。

本次处置：11 个退回单引擎、恢复 main 绿；账本 500 → 502（退回 +11、本批新迁 -9），
按机制走 `allowGrowth` 留一次有署名的记录，下一提退役。

本批**保住并新增**的双引擎迁移（都过 typecheck + 双引擎跑绿）：`rfc210-refresh-recency-self-renewal`
（顺带修掉一条**只在 SQLite 上成立**的判据：`db.all(sql\`SELECT last_fetched_at …\`)` 在 PG 上把
bigint 列取回成**字符串**，`toBe(number)` 当场失败——改成 drizzle 类型化 select）、
`runtime-session-lease`（36 处同步终结符）、`rfc199-workflow-revision` / `rfc225-workgroup-revision` /
`rfc329-workgroup-pending`（**嵌套 harness** 那一坑：文件里本来就有内层 `describeEachProvider`，
外层再套一层会开两套 PG 库，报 `cannot drop the currently open database`；正解是把内层降级成普通
`describe`，让单一外层 harness 覆盖整个文件——测试条数不变，外层用例多跑一个引擎）、
`rfc223-reverse-delete-races`（把 `skillDeleteOp` 的 `afterPhase` 测试钩子放宽到
`Promise<void> | void` 并在三个调用点 await——中立库面上「往库里写一行」是 await 的，钩子保持同步
等于逼着用例只能在 SQLite 的同步写上成立）、`rfc319-ssh-repo-access`、
`rfc321-repository-publication-transport`、`rfc345-resource-acl-revalidation`、`sessions`。

**两条不该迁、已确认留在账本上的**：

- `rfc349-task-execution-provider-adapters.test.ts` —— 它是**两个适配器的对拍**，用例名直接写着
  「SQLite aggregate …」/「PostgreSQL …」，内部自带假 PG runtime。整体套上 `describeEachProvider`
  会让 SQLite 那条用 PG 库跑 `createSqliteTaskExecutionPersistence`，语义当场错。
- `rfc282-d2-granted-ids-single-source.test.ts` —— 判据本身就是「**同步** in-tx 变体与异步变体逐字
  相等」，同步那份（`dbTxSync` + `sqliteResourceGrantRepository`）在 PG 上根本不存在。这条债会随
  那个 SQLite 专属同步原语退役而自然消失，不该靠改判据抹掉。

## 5bz. 按 callee 形参放宽——AC-6 卡住的从来不是测试，是被调用方

§5by 列的那张表逐个处置完，7 个文件重新接上双引擎（账本 502 → 495，`allowGrowth` 同批退役）。
**放宽的是形参，不是加 cast**——`as DbClient` 那种写法只会把「PG 上跑不通」推迟到运行时。

| 放宽的东西                                            | 位置                                        | 解锁                                                   |
| ----------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------ |
| `assertWorkflowLaunchable` / `assertWorkflowSnapshotLaunchable` | `services/taskLaunchGate.ts`       | `task-launch-gate` + 定时任务那三个（夹具要转交它）     |
| `resolveAgentImportRefs`                               | `…/legacy/importRefs.ts`                    | `rfc223-import-refs`                                    |
| `importWorkflowYaml` / `workflowDefinitionToSelectors` 等三处 | `…/legacy/workflow.yaml.ts`          | `rfc223-import-refs`、`rfc223-reference-write-fence`    |
| `tests/helpers/integrationTriggerResourceBinding.ts`（整份夹具） | 测试夹具                          | `scheduled-tasks-crud`、`rfc165-scheduled-heal`、`webhook-trigger-digital-employee-validation` |
| `tests/helpers/scheduledTaskScheduler.ts`              | 测试夹具                                    | `scheduled-task-scheduler`                              |

它们的函数体本来就中立（`getWorkflow` / `canViewResource` / `loadWorkflowValidationContext` /
`resolveImportRefs` 全是 `ProviderNeutralDatabase`），卡住的只是**写在形参上的那个类型**。
夹具那两份连装配也换成了中立的一份：`composeResourceCatalogFor` / `composeScheduledTaskRuntimeFor`
——`composeSqlite*` 本来就只是它们的装配别名，函数体逐字相同。

### 三条架构守卫的连锁反应，值得单独记

放宽形参会**动到守卫看得见的形状**，一次改动连着触发三条：

1. **`rfc349-provider-cutover`「业务面只持有 port、不持有 DB 机制」**：`services/*.ts` 里**不许出现
   `@/db/*` 的 import**——直接 `import type { ProviderNeutralDatabase } from '@/db/query'` 当场违规。
   正解是走 legacy transport 已有的中立别名
   `LegacyProviderNeutralDatabase`（`services/taskArchive.ts` 就是这么写的）。
2. **`rfc317-module-boundary` 的 inbound 边账本**：换 import 目标 = 换一条边。census 按
   `(from, to, specifier, 符号)` 的哈希认条目，符号一变旧条目就**被投影掉**，而守卫扫源码仍看得见
   这条边 ⇒ 必须把 `commons-debt.json` 里那条一起改指新目标（边数不增不减）。
   中途试过在 `legacySqliteTaskDatabase.ts` 里新开一个 `NeutralTaskDatabase` 别名，
   那会让 `rfc294-module-symbol-owners` 从 24942 涨到 24943 —— **新增一个导出符号也是涨账本**，
   要么背 `allowGrowth`，要么换个不新增符号的写法。最后选了后者。
3. **`rfc359-w5-provider-runtime-exercised`「组合根必须被测试真正构造过」**：夹具改装中立那份之后，
   `composeSqliteScheduledTaskRuntime` 在**测试面**上归零引用（生产面 `server.ts` / `cli/start.ts`
   还在用），立刻被记成「只装配不构造」。处置按守卫自己说的来——在
   `rfc359-w7-integration-composition-roots` 里给它补一次**真的构造 + 真的读**，
   与它的 PG 孪生并排跑同一组断言，而不是加一条 `toContain('composeSqlite…(')` 的文本锁。

### 仍未解、留给下一波的三处

- `buildStartTaskDeps` + `StartTaskDeps.db`（`services/startTaskDeps.ts`）—— 卡 `start-task-deps`；
- `taskRecoveryOperations` 夹具里的 `dbTxSync(db, …)`（SQLite 专属同步事务）—— 卡 `sqlite-concurrency-fuzz`；
- `transitionTaskStatusByEvent`（`platform/persistence/sqlite/taskLifecycle.ts`）—— 卡 `review-multidoc-inherit`。

以及那张表里未动的 `LegacySqliteTaskDatabase` 一刀放宽：`legacySqliteTransportMechanisms.ts` 那条
独立再导出一旦也统一，`services/task.ts` 会炸 34 个——它的函数体真在用 SQLite 同步面，
得先把那一片搬到中立事务口。

## 5ca. 多个顶层 `describe` 的那一批：只包**真的建库**的那几个

94 个文件有多个顶层 `describe`，此前被检测器整片拒掉。这一波把变换扩成「逐个顶层 `describe` 判定」：

- 一个顶层 `describe` 的子树里**出现 `createInMemoryDb(` 才**换成 `describeEachProvider`；
  不建库的（纯源码文本断言、纯函数判据）保持普通 `describe`。
- 这样一个文件只开它**真正需要**的那几套 PostgreSQL 库，而不是按顶层块数无脑翻倍。
  这条不是省时间，是避免 §5by 记过的那类 harness 打架。

42 个通过 AST 前置条件，跑完 typecheck + 双引擎后落地 **21 个**（账本 495 → 474，共 -21 文件 / -77 调用点）。

被挡下的两类，各自的原因都写在这里：

- **17 个仍卡在 callee 形参**（`commitResourcePackage`、`taskRecoveryOperations`、
  `installTaskLifecycleAfterCommitTestPump`、`createEmployeeReactionRoundQueries`、`cancelTask`、
  `dbTxSync`、`createSqliteTaskExecutionPersistence`，以及大量 `.all()` / `.get()` 同步读）——
  与 §5bz 是同一张待办表，按同样的办法逐个放宽。
- **3 个跑红，都是真发现，不是迁移手误**：
  - `rfc074-prc-cci-retirement` C9「被删掉的列不在实时 schema 里」——判据是 SQLite 迁移链的
    `PRAGMA table_info`，PG 侧的 schema 来自 drizzle 声明，这条按定义就只对 SQLite 成立；
  - `rfc223-pr6-injection-identity` 三条在 PG 上撞 SQL 编译器
    （`SQLITE_ONLY_STATEMENT` / `assertPostgresqlBusinessStatement`）；
  - `rfc232-owner-list`「null 与悬空 owner id 保持稳定、身份降级成 null」在 PG 上判据不成立。

  后两条要单独查，本波先原样退回、留在账本上，不靠改判据抹掉。

## 5cb. §5ca 那 3 条红逐条查完：两条是夹具写在 SQLite 专属面上，一条按定义就该单引擎

- **`rfc232-owner-list`** —— 「悬空 owner id」这条夹具用 `PRAGMA foreign_keys = OFF` 绕外键。
  查下来**两个引擎的外键不是一回事**：SQLite 的迁移链给 `tasks.owner_user_id` 加了
  `REFERENCES users(id) ON DELETE SET NULL`（`db/migrations/0020_rfc036_task_collab.sql:1`），
  而 drizzle 的表声明里**没有**这条（`ownerUserId: text('owner_user_id')`，不带 `.references()`）。
  PostgreSQL 的 schema 由 drizzle 声明生成 ⇒ 那边压根不存在这个约束，不用关也不能关。
  处置：provider 判别只落在**夹具**里，被测判据两个引擎逐字相同。
  **顺带照出一个守卫缺口**：`rfc359-w5-t19g-schema-contract-reconciliation` 对账的是
  CHECK / 索引 / UNIQUE / 触发器，**不含外键**——这条「SQLite 有、PG 没有」的外键因此从未被清点过。
  它正是那条守卫头注释说要消灭的形态（一个引擎有保护、另一个没有），且有用户可见后果：
  SQLite 上删用户会把任务的 owner 置空，PG 上不会。已记进 `docs/audit-backlog.md`。
- **`rfc223-pr6-injection-identity`** —— 三条都是夹具打在业务客户端上的 DDL / SQLite 专属语句：
  `DROP INDEX IF EXISTS …` 被 `postgresql-ddl-through-business-client` 拒（**守卫是对的**，
  DDL 就该走 migrator / 夹具面），`PRAGMA foreign_keys = OFF` 被 `sqlite-operation-on-postgresql` 拒。
  处置：DDL 改走 `harness.executeFixtureDdl`，改名从 `db.run(sql\`UPDATE …\`)` 改成 drizzle 类型化
  update，`PRAGMA` 那条按引擎判别。
- **`rfc074-prc-cci-retirement`** —— C9 判的是 `PRAGMA table_info(node_runs)`，即
  **SQLite 迁移链跑完后的实时 schema**，按定义只对 SQLite 成立（PG 的 schema 来自 drizzle 声明，
  两侧对账由 W5-T19g 独立负责）。C10 判的是**行为**（插入 / 取回不带那一列），与引擎无关。
  处置：把这个 describe 拆成两个——C9 留单引擎，C10 进双引擎块。

三个文件合计 24 pass / 0 fail（双引擎），账本 474 → 472。

## 5cc. 那 8 条外键补不进去——PostgreSQL 的升级机制**只认索引新增**（实测，已回退）

§5cb 清点出 8 条「SQLite 有、PostgreSQL 没有」的外键后，先按正解做了一遍：逐条按**实时**动作
取值（`PRAGMA foreign_key_list(<table>)`，不照着某一版迁移 SQL 抄——表重建过的列动作会变，
`tasks.owner_user_id` 在 0020 里是 `set null`、在后来的重建 DDL 里写成 `restrict`，实时值是 `set null`），
写进 `db/schema.ts` 的列声明（自引用四条走 drizzle 的 `(): AnySQLiteColumn => …` 回调式，
`workgroup_messages.trigger_message_id` / `tasks.parent_task_id` 早就是这个写法）。

**结果是对的**：重新清点 184 张表，**142 = 142，两个方向都归零**；typecheck 干净；
`rfc349-schema-contract` 与 `rfc359-w5-t19g` 在重生成 `schema-contract.{json,md}` 后都绿；
architecture 663 守卫全绿。

**但它上不了车**。PostgreSQL 侧有一套**不可变的 schema 历史**
（`db/postgresql-migrations/` + `meta/*.upgrade.json`，`platform/persistence/postgresqlMigrationSequence.ts`），
改动 drizzle 声明必须显式 append 一步。实跑
`bun run db:rfc349-postgresql-schema -- --append 0003_…` 报：

```
PostgresqlMigrationSequenceError: index-only upgrade changed a row, codec, key or disposition
  at logicalIndexAdditions (postgresqlMigrationSequence.ts:260)
```

查下来这**不是参数用法问题，是机制边界**：现有 append 只有一种步骤类型
`PostgresqlIndexUpgrade`，它硬性要求

1. `exact(rowContract(from), rowContract(to), …)` —— 行 / 编解码 / 键 / 处置**逐字不变**，
   外键属于其中的「键」，所以加外键必然触发；
2. `appendLogicalIndexes` 只接受**普通覆盖索引**（`!index.unique`）；
3. `requireSequence(to.sqliteMigrations.length > from.sqliteMigrations.length, 'index upgrade
   requires an appended SQLite migration')` —— 一步 PG 升级必须配一条**新增的 SQLite 迁移**，
   而这 8 条外键在 SQLite 侧本来就有，压根不会新增迁移。

所以补这 8 条要先给升级机制加一种新的步骤类型（约束新增），它与索引新增的不变量不同
（不配 SQLite 迁移、要改 rowContract、渲染 `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY …`），
还要想清楚存量库上加外键遇到既有悬空行怎么办（先清洗还是 `NOT VALID` 分两步）。
**本波把 schema 改动原样回退**，只留清点结果与这份取证；机制扩展单独立一步做。

**待办（已定形，不是模糊 backlog）**：
- T-FK1：给 `postgresqlMigrationSequence.ts` 加约束新增步骤类型，
  journal 形状与 `PostgresqlIndexUpgrade` 并列而不是改它（既有 3 步的 digest 不能动）；
- T-FK2：8 条外键补进 `db/schema.ts`，按 T-FK1 append 一步；
- T-FK3：把**外键**并入 `rfc359-w5-t19g` 的对账口径，让这一类从此可清点、只降不升。

## 5cd. 又两个小桶：「模块级 beforeEach」与「文件里已有 provider 块、还剩单引擎 describe」

- **模块级 `beforeEach` 桶**（8 个候选）：形状是 `let db; beforeEach(() => { db = createInMemoryDb(…) })`
  写在**任何 describe 之外**，所以 `harness` 不在作用域里。变换把那个 hook 原样搬进 describe 体内
  （文本先做替换再重排缩进，避免搬完还留一个 `createInMemoryDb`）。实际只有 1 个跑绿
  （`rfc349-postgresql-daemon-system-identity`），其余卡 callee 形参或真红，收益递减，不再追。
- **「已有 provider 块 + 残留单引擎 describe」桶**（12 个候选）：只转那些**真的建库**的顶层
  `describe`，落地 4 个（`rfc243-call-refs-yaml`、`rfc271-export-package`、
  `scheduler-audit-s05-fanout-inner-chain`，加上面那个）。

### 变换器补的第三条前置条件：不要包住已经含 provider 块的 describe

`task-file-content` / `rfc271-import-preview` 上撞到：一个顶层 `describe` 里面**已经**有
`describeEachProvider`，把外层也转掉就成了嵌套两套 harness，PG 上直接
`cannot drop the currently open database`。变换器现在扫子树，遇到 `describeEachProvider`
就跳过这个顶层块。

**顺带修掉我自己一个正则坑**（值得记）：「把嵌套块降级成普通 describe」那条正则写的是
`^(\s+)describeEachProvider\(`，而 `\s` **匹配换行**——于是它会从上一行的空行处起头，
把**顶层**（零缩进）那个也一起降级掉。表现是测试名里 `[sqlite]` / `[postgresql]` 后缀整个消失、
用例数对不上。判缩进要用 `^[ \t]+`，别用 `\s`。

账本 472 → 468。

## 5ce. 剩下 468 条的**真实构成**（按拦路石清点，不是按文件名猜）

| 桶                        | 文件 | 调用点 | 性质                                                                 |
| ------------------------- | ---- | ------ | -------------------------------------------------------------------- |
| `migration-*.test.ts`     | 80   | 149    | **按定义不该双引擎**：判的是 SQLite 迁移链本身；PG 的 schema 来自 drizzle 声明，两侧对账由 W5-T19g 独立负责 |
| `createTaskExecutionTestTopology` | 73 | 137 | 见下，需要一次设计                                                   |
| 裸 `$client` / raw SQL    | 78   | 169    | 逐文件中立化（`executeFixtureDdl` / drizzle 类型化写）                |
| HTTP 形状                 | 39   | 92     | 换 `describeEachProviderHttpApplication`                             |
| 残留                      | 198  | 426    | 绝大多数卡在 callee 形参，同 §5bz 那张表                             |

`new Database(` 那 45 个散在上面各桶里，其中**开真实文件**的 41 个（备份 / 还原 / VACUUM INTO /
外部 opencode store / worker 夹具）判的就是 **SQLite 文件本身的行为**，属于产品里真正的 SQLite 专属面，
不该也不能双引擎。

### `createTaskExecutionTestTopology` 这 73 个为什么需要一次设计

实测 203 个调用点里 **202 个只取 `schedulerDriver`**（1 个取整个 topology），
且 **201 个传 `driver: 'real'`**——即它们真的要那个由 db 装出来的调度驱动。

难点不在夹具，在**两个引擎的执行模型本来就不同**：SQLite 侧可以直接拿
`composeTaskExecutionTestRuntime(db).topology.schedulerDriver` 就 `drive`；PostgreSQL 侧的
`schedulerDriver.drive` 要在**已认领的 ownership + executionContext** 里跑——
`tests/helpers/providerTaskExecutionTestTopology.ts` 正是为此写的：它先 `submitContinuation`
拿 intent，再用 `DefaultTaskDriveCoordinator` + `createPostgresqlTaskDriverLifecyclePort`
走完 claim / attach / drive / release，所以它对外只给 `runTask`，**不给 `schedulerDriver`**。

所以这 73 个不是「换个 harness」能了的，要先决定：把这些用例从「拿驱动自己 drive」改写成
「提交 runTask」，还是在 provider 拓扑上补一个**自带认领**的 `schedulerDriver` 外观。
前者改动面大但语义正；后者省事但把 PG 的 ownership 语义藏进夹具。**留作独立一步，本 session 不动。**

## 5cf. HTTP 那 39 个：先分清「真该迁」和「已经论证过不该迁」

按「文件里有没有已经写好的双引擎块」把 39 个分两半：

- **已有双引擎块、只剩残留单引擎 describe 的 15 个**：残留往往是**有意保留**的。
  典型 `rfc221-login-policy-routes` —— 那条单引擎用例的文件内注释已经逐条论证过：
  被测状态（装配里没有 `secretBox` ⇒ `oidcProviders === null` ⇒ 两个 503）
  **在两个引擎的真实部署里都不存在**（`cli/start.ts` 在选 provider 之前就 `createSecretBox`），
  它不是「一个引擎好一个不好」，是两个组合根的**装配签名不对称**，正解是把 SQLite 根的
  `secretBox` 也收成必填（要改 47 个测试文件的 `createApp` 入参，见 §5bg）。这类不要动。
- **整份单引擎的 24 个**：才是真迁移面。

本波手迁两个**不走 `createApp`** 的（它们只是自己 `new Hono()` 挂路由，所以不需要 HTTP 作用域）：

- `rfc349-auth-caller-closure` —— 拆成两块：只读源码文本那条留普通 `describe`，
  两条真建库的进 `describeEachProvider` 并带上 `{ bootstrap: 'required' }`（它们要走 `completeBootstrap`）。
- `transition-cas-route-409` —— `seedNodeRun` 从「自己建库」改成收 `db` 形参，两个顶层 describe 各自转换。

**剩下走 `createApp` 的那些还缺覆盖口**：`rfc338-maintenance-status` 要
`maintenanceStatus` / `databaseTelemetry` 两个注入口，而 `ProviderHttpApplicationInput` 的
`Pick` 里目前只有 5 个（`buildScheduleLaunch` / `runtimeDiagnosticTestDependencies` /
`webhookDispatcher` / `mcpRuntimeTestDependencies` / `intentTestDependencies`）。
补第 6、7 个的姿势与前 5 个一样（先确认 PG 根也透传），连带要更新
`rfc359-w29-unstarted-application-composition` 的结构摘要——那条守卫在 98545e3f8 上推红过一次。

账本 468 → 466。

## 5cg. 把 `dbTxSync` 从测试夹具里拆掉——解锁 `sqlite-concurrency-fuzz`

`tests/helpers/taskRecoveryOperations.ts` 的 `repairRuntimeSessionLeaseAfterOrphanReap` 还在用
SQLite 专属的同步事务 `dbTxSync`，整个事务体是同步终结符（`.get()` / `.all()` / `.run()`）。
搬到中立事务口 `databaseSessionFor(db).transaction(async (tx) => …)`，体内逐条改成 await
（`.get()` → `(await …limit(1))[0]`，`.all()` / `.run()` → 直接 await；`.returning()` 本来就带回行）。
形参同批放宽到 `ProviderNeutralDatabase`。

**35 个消费文件 493 pass / 0 fail** —— 这个夹具是 recovery 那一簇的公共入口，改它必须把下游全跑一遍。

随之 `sqlite-concurrency-fuzz` 解锁（它的两个错就是 `taskRecoveryOperations(db)`）。
文件名带 sqlite 但它的头注释本来就写明 fuzz 锁的是**操作组合的不变量**、不是 SQLite 引擎并发，
所以双引擎跑是严格更强；名字暂不改（别的守卫按名引用）。

## 5ch. `rfc199-workflow-revision`：一条真的**装配签名不对称**，拆出去单跑

这个文件的 6 个调用点里，5 个随嵌套块降级 + 外层转换一起迁完，**只剩 1 条迁不了**：

```ts
await composeSqliteAgentLaunchResourceOperations(db).ensureHostWorkflow()
```

它的 PG 孪生 `composePostgresqlAgentLaunchResourceOperations` **入参形状不同**——还要
`agents` / `workflowValidation` 两个端口（SQLite 那份在内部自建）。这不是「形参写窄了」，
是两个组合根的装配签名真的不对称，和 §5cf 里 `rfc221` 的 `secretBox` 同类。
处置：把这一条 test 拆成文件末尾一个单引擎 `describe`、留在账本上，其余 21 条双引擎跑绿。

账本 466 → 465。

## 5ci. `setTaskStatus` / `transitionTaskStatusByEvent` 形参放宽——零外溢

`platform/persistence/sqlite/taskLifecycle.ts` 的这两个入口形参还写死 `DbClient`，卡住
`review-multidoc-inherit`。**它们的函数体本来就是中立的**：走
`databaseSessionFor(db).transaction(...)` + 中立异步 CAS，一条 bun:sqlite 同步游标都没有——
W8 把那条 `.get()` 预读改掉时就是为此（文件里 134 行那条注释）。

放宽后 **typecheck 零新增错误**（同文件另两处 `db: DbClient` 与 `DbClient | DbTxSync` 原样保留，
它们所在的函数体仍有同步终结符，属另一刀）。`rfc097-task-status-cas` /
`lifecycle-transitions-current` / `lifecycle-cas-race` / `review-multidoc-inherit` 合计
80 pass / 0 fail（双引擎）。

**没能一起解掉的两条**，都不是「形参写窄了」：

- `buildStartTaskDeps` —— 放宽它自己只剩 1 个错，但那个错在 `StartTaskDeps.db`
  （`services/task.ts:457`，也是 `LegacySqliteTaskDatabase`）。再往下就是 §5by 实测过的
  「`services/task.ts` 函数体真在用 SQLite 同步面」那一片，要先把那片搬到中立事务口。
- `inspectDigitalEmployeeHumanReviewState` / `createEmployeeReactionRoundQueries` ——
  卡 `execution-contract-platform`，同属 digital-employee 那一簇，留给下一波。

账本 465 → 464。

## 5cj. 一条**公共端口本身是同步的**——`inspectHumanReview`，PostgreSQL 上按签名就实现不了

迁 `execution-contract-platform` 时卡在 `inspectDigitalEmployeeHumanReviewState(db, ref)`。
它不是「形参写窄了」，是**返回类型就是同步的**：

```ts
// modules/task-execution/public/participants.ts:373
inspectHumanReview?(executionRef: string): DigitalEmployeeHumanReviewState | null
```

实现里靠 bun:sqlite 的同步游标（`db.select(...).where(...).get()`）当场取回行；消费方
`modules/digital-employee/application/runtimeService.ts:1289` 也按同步用
（`this.#execution.inspectHumanReview?.(round.executionRef) ?? null`）。

**这是一条真的架构缺口，不是测试问题**：PostgreSQL 上没有同步读，所以这个公共参与者端口
**按签名就无法在 PG 侧实现**。它今天没炸，只因为 PG 的执行参与者装配没提供 `inspectHumanReview`
（端口是可选的 `?`），于是 PG 部署上这条人审状态投影**直接缺失**——不是「两边行为不同」，
是「一边有、一边没有」，正是本 RFC 要消灭的形态。

处置（留作独立一步，本波只记录 + 把能放宽的放宽）：把端口改成
`Promise<DigitalEmployeeHumanReviewState | null>`，实现改 await，`runtimeService` 那一处跟着 await。
改动面小但穿过公共合同，要和 digital-employee 那条线一起定。

同簇里**能放宽的已经放宽**：`createEmployeeReactionRoundQueries` 的形参换成
`ProviderNeutralDatabase`（它与 PG 孪生的函数体逐字相同，都只是把 db 转交给中立的
`createReactionRoundQueries`），typecheck 零外溢，5 个消费文件 16 pass / 0 fail。

## 5ck. 迁移的第四类坑：**「一个 test 一个干净库」会打破「循环里每轮自己建库」的夹具**

双引擎 harness 的语义是「每个 `test` 开始时库是刚迁移完的状态」。迁移时有两类夹具会因此失效，
两条都是实撞：

1. **循环里每轮自己建库** —— `digital-employee-agent-template-reconcile` 的占位用例原来是
   `for (const squat of [...]) { const db = createInMemoryDb(...); … }`，每轮一个新库。
   换成 `harness.db` 后两轮共用同一个库，第一轮的占位活到第二轮，第二轮在**建立前提**那一步
   （`ensureDigitalEmployeeAgentTemplates`）就先抛了，判据变成空洞绿/红。
   **正解是把循环拆成多条 `test`**，一条一种输入，各自拿自己的干净库。
2. **模块级只建一次的外部夹具** —— `rfc310-employee-workspace-repository-freshness` 的
   `const root = mkdtempSync(...)` 是模块级、只建一次，用例里按**固定名字**在它下面建 git 仓库。
   双引擎把整个 body 跑两遍，第二个引擎踩到第一个引擎留下的仓库：
   `git remote add origin … failed: remote origin already exists`。
   **正解是目录名带唯一后缀**（`mkdtempSync(join(root, 'prefix-'))`）。

这两条与 §5bx 的「构造点必须在 lazy hook 里」是同一族：**双引擎 harness 改变的是「什么东西一个
test 一份」**，凡是原来靠「自己建、自己命名」拿到隔离的夹具都要重新过一遍。

账本 464 → 462。

## 5cl. 变换器的第四条前置条件（与一个自造 bug），以及两条「造违反完整性的行」的坑

**自造 bug**：§5cd 加的「不要包住已含 provider 块的 describe」只做了一半——那个顶层块被跳过了，
但 `visit()` 仍然把它体内的 `createInMemoryDb(...)` 换成了 `harness.db`，于是生成出
`Cannot find name 'harness'`。修法是记下被跳过的块的区间，`visit()` 遇到落在区间里的节点直接返回；
同时那种文件**不能**删 `db/client` 的 import 与 `MIGRATIONS` 常量（留着的那几个块还要用），
只能在 import 前**插入**新的两行。

**顺带照出一处存量假覆盖**：`rfc271-import-preview` 里两个**已经**是 `describeEachProvider` 的嵌套块，
body 却仍在 `createInMemoryDb(MIGRATIONS)`——它们名义上双引擎，实际两轮都跑 SQLite。
处置同 §5cb：把嵌套块降级成普通 `describe`，外层转成单一 provider 块覆盖整个文件。
42 pass / 0 fail（双引擎），调用点 11 → 0。

**两条确认单引擎的「造违反完整性的行」夹具**：

- `memory-distiller-source-context` 的孤儿 round（describe 名里就写着 SQLite orphan fixture）——
  `clarify_rounds.asking_node_run_id → node_runs.id` 这条 FK **两个引擎都有**，SQLite 靠
  `PRAGMA foreign_keys = OFF` 临时关掉再删桩；PostgreSQL 上没有夹具层面干净的等价做法：
  约束名是生成的（没法 `DROP CONSTRAINT`），`SET session_replication_role = replica` 是会话级、
  连接池下不可靠。
- `rfc248-readonly-dirty-visible` 的 `PRAGMA table_info(task_repos)` —— 同 §5cb 的 rfc074 C9，
  判的是 SQLite 迁移链跑完后的实时 schema。

两条都留在账本上并把理由写进文件；等「测试夹具怎么在 PG 上造违反完整性的行」有统一答案再迁。

账本 462 → 461。

## 5cm. `$client.close()` 不算「用了裸驱动」——放宽检测口径后再看这一桶

`$client` 一律拒收的口径太粗。实测：非 migration 的 194 个用 `$client` 的文件里，
**99 个唯一的用法就是 `close()`**——那只是「我自己建的库，用完关掉」的收尾，
而双引擎 harness 自己管库的生命周期，这类调用迁移时直接删掉即可，不构成阻塞。

检测口径改成「除 `close` 外还有别的 `$client.*` 才拒」，变换器同批学会删掉纯粹的
`$client.close()` 语句。两个坑：

- **正则要容换行**：`db.$client\n  .query(...)` 这种写法下 `/\$client\.([A-Za-z]+)/` 匹配不到，
  于是 `rfc312-presence-channel` 被误判成 close-only（它其实用 `$client.query` 塞原始 INSERT）。
  改成 `/\$client\s*\.\s*([A-Za-z]+)/`。
- **删掉 close 会留下空块**：`rfc349-integration-provider-adapters` 的 `try { … } finally { db.$client.close() }`
  删完剩一个空 `finally {}`，`no-empty` 当场红。这类要连 try/finally 一起去掉。

本波只有 `rfc349-integration-provider-adapters` 跑绿落地（14 pass / 0 fail）；
`rfc204-cold-clone-seal` / `rfc307-demo-seed` / `rfc312-presence-channel` /
`rfc349-execution-peripheral-provider` / `rfc243-list-child-count` 各自还卡 callee 形参、
原始 SQL 或嵌套 harness，原样退回。

**另有一处存量假覆盖已清零**：全树扫描「`describeEachProvider` 体内还在 `createInMemoryDb`」，
现在只剩 `rfc311-task-page-fastpath` 一处，而它是**有意**的——那条用例开头就
`if (harness.capabilities.provider !== 'sqlite') return`，随后跑 `EXPLAIN QUERY PLAN`，
是 SQLite 专属的查询计划断言。

账本 461 → 460。

## 5cn. 按「卡住多少个账本文件」给窄形参 callee 排了个序

不再逐个文件试错——直接静态扫：src 里**形参写 `DbClient` / `LegacySqliteTaskDatabase` 的导出函数
共 98 个**，再看账本上（去掉 migration 那 80 个）哪些文件引用了它们。前十二名：

| 卡住的账本文件数 | callee | 位置 |
| --- | --- | --- |
| 19 | `resumeTask` | `services/task.ts` |
| 14 | `retryNode` | `services/task.ts` |
| 11 | `dbTxSync` | `db/txSync.ts`（SQLite 专属同步事务原语，按定义不放宽） |
|  9 | `cancelTask` | `services/task.ts` |
|  9 | `createSqliteTaskExecutionPersistence` | `modules/task-execution/composition/taskExecutionPersistence.ts` |
|  9 | `startWorkgroupTask` | `…/legacy/workgroup/launch.ts` |
|  8 | `setTaskStatus` | ✅ 本波已放宽 |
|  8 | `composeSqliteWebhookDispatchCore` | `modules/integration/composition/webhookDispatch.ts` |
|  6 | `trySetTaskStatus` | ✅ 本提交放宽（零外溢） |
|  6 | `composeSqliteResourceCatalog` | 已有中立的 `composeResourceCatalogFor`，调用方换名即可 |
|  6 | `composeSqliteAgentLaunchResourceOperations` | §5ch 记的装配签名不对称 |
|  5 | `createTaskExecutionContext` | `modules/task-execution/composition/sqliteTaskExecutionContext.ts` |

**⚠️ 这张表按「卡住多少文件」排序，但排第一的那组是误报**——`resumeTask` / `retryNode` /
`cancelTask` 卡住的 42 个（连同整类 85 个）文件测的是 **SQLite 那台执行引擎**，而
`TaskRouteOperations` 这一对早已被本 plan 判为「不该合」、PG 生产也不走这条路径。
它们**按裁决就该单引擎**，不是待迁量。详见 §5co 的更正段。真正该按这张表推进的是它下面那几行。

`composeSqliteWebhookDispatchCore`（8）第二大：它自己只是转交，卡点在
`createSqliteWebhookRepositoryResolver` 体内两处 `.get()`；那个函数有 PG 孪生，
两边收敛后可以像 §5cb 的实时孪生一样合成一份。

`composeSqliteResourceCatalog`（6）最便宜：中立的 `composeResourceCatalogFor` 早就在，
调用方改个名字就行（§5bz 已在两个夹具上这么做过）。

## 5co. `services/task.ts` 这一刀有多大——实测，不是估的

§5cn 指出它是剩余 AC-6 最大的单点（`resumeTask` 19 + `retryNode` 14 + `cancelTask` 9 = 42 个账本文件）。
实测把 `resumeTask` / `retryNode` 两个形参放宽到中立客户端：

- **`resumeTask` / `retryNode` 自己的函数体零同步终结符**——放宽它们本身不需要改一行实现；
- 外溢只有 **9 个错，全在同文件内**，是一层浅的转交：
  `resumeKick` / `assertChildTaskDrivable` / `retryRepoPreparation` /
  `reapHeldRuntimeSessionOwnersForTask` / `cancelTask` / `reapRunBeforeWorktreeReset` /
  `rollbackNodeRunForResume`，外加 `deps: { ...opts.deps, db }`（即 `StartTaskDeps.db`）。

**真正的硬骨头是 `cancelTask` 里那条同步预检**（`services/task.ts:4136-4141`），它的注释写得很清楚：

> Bun SQLite can do this preflight **synchronously**, preserving the legacy rejected-Promise API
> while allowing the no-controller path to register its FIFO mutation slot **before this function
> first yields**.

也就是说这条同步读**是有意的**：它保住了「函数首次 yield 之前先把 FIFO 写槽注册上」这个顺序契约。
改成 await 会让函数提前让出，观察到的行为随之变化——这不是机械替换能了的，要先决定
「注册写槽」与「预检」谁先谁后，或者接受让出并把注册挪到前面。`cancelTask` 的另一处
（`:4223` 的 `await tx.select(...).get()`）本来就在 await 里，删掉 `.get()` 即可。

`services/task.ts` 全文共 34 处 `.get()` / `.all()` / `.run()`、22 处 `LegacySqliteTaskDatabase` 形参。
文件里已有两处注释（`:3317`、`:5877`）记着前几波是**分片**把事务边界从 `dbTxSync` 换到中立原语的，
这一刀按同样的方式分片做。

### ⚠️ 上面那段的**方向是错的**，就地更正（2026-09-13）

写完才回查本 plan 的既有裁决：`TaskRouteOperations` 这一对**早已被判为「不该合」**，
就记在 §「判定为**不该合**的对：从 3 对增到 7 对」里，理由逐字是——

> **两台执行引擎**：SQLite 侧带模块级可变全局 + 2 处 `dbTxSync` + 自驱进程内 scheduler，
> PG 侧一律委托端口 + serializable 事务 + 已提交事件出站。合一的前置是 `services/task.ts`
> 的调度耦合与同步事务面——正是本节记的结构性阻塞。

核对生产装配，这条裁决确实成立：**PostgreSQL 根**把取消接到
`taskExecutionProvider.cancellation.cancel({ taskId, cause })`
（`cli/postgresqlDaemonApplication.ts:1452 / 1460 / 1616`），而 `resumeTask` / `retryNode` 的
消费者**全在 `src/platform/persistence/sqlite/` 下面**。两侧的路由操作面同名同形
（`cancel` / `resume` / `retry` / `get` / `listItems` / `nodeRuns` / `events` / `diff` / `stdout` /
`delete` / `launchWorkflow` / `launchMultipart` / `syncWorkflow` / `repairOptions` / `applyRepair` /
`getMembers` / `replaceMembers` / … 逐个对得上），但**是两份实现**：
`sqliteTaskRouteOperations.ts`(276) 转发进 `services/task.ts`(7696)，对面是自足的
`postgresqlTaskRouteOperations.ts`(2563)。两个文件 23 / 54 条 import 只共享 13 条，
PG 那侧多出来的几乎全是 `application/ports/*` 与 `domain/*`——它才是朝 RFC-294 目标架构写的那一份。

**所以那 42 个（连同整类共 85 个）账本文件不是「还没迁」，是「按裁决就该单引擎」**：
它们测的是 SQLite 那台执行引擎，而 PG 生产根本不走它。把它们套上 `describeEachProvider`
等于**拿 PG 库去跑 SQLite 引擎**——那不是 parity 覆盖，是给一条 PG 上不存在的路径刷绿。
这一对的 parity 由它自己那份已登记的双引擎对拍负责（「『不合』不等于『不管』」那条）。

T-TASK1/2/3 作废。`cancelTask` 那条同步预检的取证仍然有效、也仍然是该对合一时要解的一格，
但它属于**那对的合一前置**，不是 AC-6 的迁移任务。

### AC-6 剩余 460 的正确分层（按「该不该迁」，不是按「能不能迁」）

| 类别 | 文件 | 该不该双引擎 |
| --- | --- | --- |
| `migration-*` | 97 | **不该**：判的是 SQLite 迁移链本身，PG 的 schema 来自 drizzle 声明，对账由 W5-T19g 负责 |
| 测 **SQLite 执行引擎**（`resumeTask` / `retryNode` / `cancelTask` / `startTask` / 执行拓扑） | 85 | **不该**：`TaskRouteOperations` 已登记为「不该合」，PG 生产不走这条路径 |
| 其余 | 278 | **该**，也是真正的迁移面 |

加上 41 个 `new Database(` 开**真实文件**（备份 / 还原 / VACUUM INTO / 外部 store）同样按定义单引擎，
**AC-6 真正的剩余工作量是那 278 个**，不是 460。这条分层此前没有写出来，导致 §5cn 把一个
已被裁决的结构性阻塞当成了「最大的单点」去排序。

## 5cp. 两个「中立版本早就在，只是没人用」的工厂

§5cn 那张表里排中游的两个，查下来都属于**中立实现已存在、调用方还指着 provider 别名**这一类，
换个名字就好，不需要动任何实现：

- **`createSqliteTaskExecutionPersistence` → `createTaskExecutionPersistence`**：后者是
  `taskExecutionPersistence.ts` 里按 `databaseSessionFor(db).engine.provider` 分派的中立工厂
  （RFC-359 T7b 建的，「task-execution 里看 provider 的唯一入口之一」）。7 个账本文件直接换名。
  ⚠️ 两份 provider 对拍（`rfc349-task-execution-provider-adapters` /
  `…-read-models-postgresql-adapter`）**保留显式的 sqlite 工厂**——它们判的就是「按品牌选出来的那一份」。
- **`createTaskExecutionContext`（`composition/sqliteTaskExecutionContext.ts`）形参放宽**：
  它只是把 db 原样别在 `legacyConnection` / `compatibility` 上给旧调用方取用，持久化那一格改用上面
  那个中立工厂后，**函数体零方言**。放宽后 typecheck 只剩 1 个错（同文件的接口声明），
  一并放宽即清零；14 个消费文件 244 pass / 0 fail。名字里的 Sqlite 暂留——它是
  `rfc349-provider-cutover` 账本里那条边的键，改名要连账本一起动。

这两步解锁了 `rfc328-codehost-attempt-ledger`（26 pass / 0 fail）：它的夹具原来自己建库，
改成收 `db` 形参后整条链走通。账本 460 → 459。

**顺带修正 §5co 的分层数字**：`createSqliteTaskExecutionPersistence` 不该算进「SQLite 执行引擎」
那一类——它有中立分派器，属于**已合一**的持久化层。去掉它之后那一类是 **80 个**（不是 85），
真正的迁移面是 **283 个**。

## 5cq. 周度 `postgresql-evidence` 红了一条，以及我的 CI 观察脚本有个缺陷

盯 `434060937`（**纯文档**提交）的 CI 时读到 `completed/failure`，查下去那条不是推送门，而是
**`postgresql-evidence` 的 `schedule` 运行**（`cron '30 3 * * 0'`，它 checkout 默认分支 HEAD，
所以 headSha 与刚推的提交一模一样）。同一个 SHA 上可以有多条 run，来自不同 workflow / 不同 event；
我的脚本只按 headSha 取第一条，于是把计划任务的红算到了推送门头上。判据要写全
（`.event=="push" and .name=="CI"`），已记进 `docs/dev-gotchas.md`。

**但那条红是真信号**：`RFC-349 real PostgreSQL target fault/resume matrix > disconnect, timeout,
deadlock, constraint and storage faults roll back row plus receipt before exact resume` 失败，
同 run 里的判据契约与 migration runner 各条都 pass，产物也没生成。它是 AC-7/AC-9 依赖的真 PG 证据面，
已连同「怎么二分」记进 `docs/audit-backlog.md`。

## 5cr. 资源目录换中立工厂 + intent 夹具整份放宽（459 → 458）

- **`composeSqliteResourceCatalog` → `composeResourceCatalogFor`**（7 个账本文件）：后者早就在，
  形参是 `ProviderNeutralDatabase`。换名不动实现，126 pass / 0 fail。
  **但账本一格没动**——那 7 个里有 6 个另外卡在 `createTaskExecutionTestTopology`（= §5co 那类
  「按裁决就该单引擎」）或 HTTP 应用上。收益是少一个 provider 命名依赖（AC-12 方向），不是 AC-6 数字。
  `composeSqliteResourceCatalog` 仍有 `helpers/realtimeRuntime` / `helpers/webhookTaskExecution`
  两个真消费者，不会变成「只装配不构造」的零引用根。
- **`tests/helpers/intentResourceCatalogBinding.ts` 整份放宽**：它的 5 个导出全把 db 转手给
  `createWorkflowValidationPort` / 资源目录 / intent 装配，而那些形参本来就是中立的。
  放宽后只剩一处真同步读（`db.select().from(workflows).all()`）要改 await；14 个消费文件
  218 pass / 0 fail。随之 `rfc349-intent-boot-resume-authority` 迁入（模块级 hook 那一类）。

## 5cs. webhook 仓库解析器那一对合一（AC-1），以及「合一时不要起第三个名字」

`createSqliteWebhookRepositoryResolver` 与 `createPostgresqlWebhookRepositoryResolver` 的函数体
**逐字相同，只差一个 `await`**：SQLite 的 `.get()` 是同步游标、PostgreSQL 的是 Promise，
而 `.get()` 两个客户端都有。按 PG 那份的异步形状收成一份即可——SQLite 上 `await` 一个非 Promise
是 no-op，行为一格不动。随之 `composeSqliteWebhookDispatchCore` 的形参也放宽（它转交的四件
——dispatch/delivery 持久化、仓库解析、启动准入——形参都已中立）。

**没有起第三个名字**（第一版起了 `createWebhookRepositoryResolver` 当正典、两个旧名做别名，
立刻被 `rfc317-ledger-highwater` 拦下）：**新增一个导出符号会让
`rfc294-module-symbol-owners` 24942 → 24943、`rfc294-mutation-entrypoints` 1729 → 1730
同时涨一格**，而这次合一本身并没有引入任何新东西——涨账本是纯记账噪声。
改成「正典沿用原来的 sqlite 名（形参已放宽）、PG 名变成指向它的别名」后，导出符号数不增不减。

**定式**：合并一对孪生体时，**把其中一个原名提升为正典、另一个做别名**；只有确实需要一个中性
新名字（例如两个旧名都要退役）时才新增符号，且要预期两本 census 账各涨一格。

12 个 webhook 相关套件 133 pass / 0 fail（双引擎）。

## 5ct. 「构造点本来就在 describe 体内」那一桶（458 → 439），以及跨引擎断言错误原因的正确姿势

这一批的形状最省事：`createInMemoryDb(MIGRATIONS)` 已经落在顶层 `describe` 的 `beforeEach`
或 `test` 体内，把顶层 `describe` 换成 `describeEachProvider(name, (harness) => …)` 之后
`harness` 天然在作用域里，构造点直接替换成 `harness.db` 即可。变换器（AST，非正则）另外做四件事：
句柄类型 `DbClient` → `ProviderNeutralDatabase`、退役 `MIGRATIONS`（含**被 import 进来**的那种）、
清掉因此失去唯一用途的 `resolve` / `describe` / `beforeEach` 等 import、以及把 bun:sqlite 独有的
同步终结子（`.all()` / `.get()` / `.run()`）换成 `await`。

**同步终结子的 `await` 会往外传播**，这是这一批最容易做半截的地方：一个原本同步的模块级
`seedTask()` 一旦内部要 `await`，它自己要变 `async`，文件内**每一个调用点**都要补 `await`，
而它的显式返回类型 `SeededTask` 还得包成 `Promise<SeededTask>`（否则 TS1064）。变换器把这条
传播做成不动点迭代——先收集「因终结子而必须 async」的函数，再按名字找文件内调用点补 `await`
并把调用者一并标成 async，反复到收敛。`rfc204-credential-sealing` 一个文件就退役 27 个终结子、
4 个函数转 async、20 个调用点补 `await`。

### 拦路石的分布（38 个候选实测）

按 typecheck 分成两类，**硬的就地回滚、软的就地修**：

- **硬（17 个）**：形参写死 `DbClient` / `BunSQLiteDatabase` 的下游 API——`runTask`、
  `createApp`、`$client` 仪器面。这些按 §5co 的裁决**本来就该单引擎**，回滚不留债。
- **软（8 个）**：只是自己还在用同步终结子。`termfix2` 一把修完。

### 两处**此前零覆盖**的真实跨引擎落差（迁移照出来的，不是顺手改的）

1. `rfc120-deferred-dispatch`「RFC-333 intent 故障回滚」的故障注入写死了 SQLite 的
   `CREATE TRIGGER … BEGIN SELECT RAISE(ABORT, 'rfc333-question-intent-fault'); END`。
   PostgreSQL 要一个 plpgsql 触发器函数才能抛出等价异常；而且这类 fixture DDL **只能走
   `harness.executeFixtureDdl`**，业务客户端会以 `postgresql-ddl-through-business-client` 拒绝。
2. `rfc349-auth-provider-contract` 把 `auth.provider` 写死断言成 `'sqlite'`，且它的
   `createInMemoryDb(MIGRATIONS, { bootstrap: 'required' })` 带了 bootstrap 语义——
   **变换器默认会把第二个实参吞掉**。`describeEachProvider` 的 bootstrap 是**第三个**形参
   （签名是 `(name, body, options)`，不是 `(name, options, body)`），传错位置会得到
   `body is not a function`。

**新工具：`tests/helpers/databaseFailure.ts`**。跨引擎断言「数据库这一层为什么失败」不能直接
`rejects.toThrow('…')`：两个 provider 把底层错误包到了不同深度——SQLite 上错误就是最外层那个，
PostgreSQL 上 drizzle 抛 `DrizzleQueryError`，最外层 message 被换成
`Failed query: <SQL>\nparams: …`，真正的 `RAISE EXCEPTION` 文案只在 `cause` 里
（实测 `cause` 是 postgres.js 的 `PostgresError`）。只看最外层的判据在 PG 上必然红，
而且红出来的还是一段与故障无关的 SQL 文本。`expectDatabaseFailure(run, expected)` 沿整条
`cause` 链找，两个引擎同一写法。

### 一条留在 SQLite 上的判据（登记，不是漏迁）

`rfc314-event-write-batching`「一批事件合并成远少于行数的 INSERT」靠 `$client.prepare` /
`$client.query` 的**调用计数**证明批量写，那是 bun:sqlite 句柄独有的仪器面。同文件其余判据
（内容 / 顺序 / id 单调性）两引擎都跑，只有这条计数判据加 `if (harness.capabilities.provider
!== 'sqlite') return`——与 `rfc311-task-page-fastpath` 的 `EXPLAIN QUERY PLAN` 守卫同一先例。

### 一个必须记住的变换器前置条件

**`createInMemoryDb` 的第二个实参不能吞**。这一批 4 个文件带了第二实参，其中
`{ bootstrap: 'ready' }` 与 harness 默认行为等价（`eachProvider.ts` 只在
`options.bootstrap === 'required'` 时**不**把 `auth_login_policy` 标成已 bootstrap），
可以安全丢弃；`{ bootstrap: 'required' }` 必须转成 describe 的 options。
变换器此后要么把选项转交过去、要么拒绝该文件，不允许静默丢。

## 5cu. 「模块级构造函数」那一桶 + 一条全树的**静默 PG 竞态**审计（439 → 430）

### 变换器第二形态：把构造函数改成构造**参数**

这一桶的构造点写在一个模块级 `function buildHarness() { const db = createInMemoryDb(MIGRATIONS) … }`
里，`describe` 体内只调用它。两步走：①给该函数加一个首位形参 `db: ProviderNeutralDatabase`、
删掉函数体里的构造语句、在**每一个调用点**补上 `harness.db`（调用点必须在某个顶层 describe 体内，
否则 `harness` 不在作用域）；②再走 §5ct 的标准 describe 变换。

**变换器踩到的自伤**：第一步插入 `harness.db` 之后，文件里出现了 `harness` 这个词，第二步
「文件里已绑定 harness 就跳过」的**文本**检查于是把整批全拒了。判据改成 AST：只有**绑定**
（变量声明 / 形参 / 函数声明 / import）才算冲突，**引用**不算。

### 一条比账本更要紧的发现：**已经双引擎的文件里还留着 bun:sqlite 的同步终结子**

`rfc349-task-transaction-participants` 迁完 typecheck 全绿、SQLite 全绿，PostgreSQL 上却以
外键冲突红了：夹具里 `db.insert(users)…run()` / `db.insert(tasks)…run()` 一串**都没 await**。
SQLite 上同步执行，顺序天然正确；PostgreSQL 上它们是 promise，池里多条连接并发发出去，
`task_collaborators` 先于 `tasks` 落库。**`.run()` 在中立类型上是合法的，所以 typecheck 不报，
`bun test` 的 SQLite 侧也全绿——只有真跑 PG 才看得见。**

按此写了一条全树审计（`termaudit2.ts`）：在**已经走 `describeEachProvider`** 的文件里找
**结果既没被 await 也没被返回**的 drizzle 同步终结子。初查 **39 处 / 15 个文件**，
本批修掉 36 处（剩 3 处：一个是 harness 自己，一个走 `dbTxSync`（SQLite 专属事务原语），
一个在数组回调里——见下）。

**变换器的第五条前置条件**：终结子若位于 `.map` / `.forEach` / `.filter` / `.some` 等**数组回调**
里，把回调改成 `async` 会静默改变契约——`.map` 开始产出 promise 数组，`.forEach` / `.filter`
直接把 promise 丢掉。这类文件一律拒绝，交给人工。

### 7 条判据登记为「靠 SQLite 专属注入面」（`docs/audit-backlog.md` 有条目）

`runner.test.ts` / `runtime-claude-capture` / `runtime-claude-e2e` 里 7 条「写失败会怎样」的判据
用一个包住 `db.insert` 的 Proxy 注入故障。统一事务原语在 SQLite 上**把事务句柄做成 db 对象本身**，
于是持久化里的 `tx.insert(...)` 穿过这个 Proxy；PostgreSQL 上 `tx` 是另一个对象，注入点**一次都不
触发**（计数器恒为 0）。生产代码两边都有错误分类器（SQLite 认 `SQLITE_BUSY*`，PG 认 40001 /
55P03），缺的是**测试驱动得到这些分支**的手段。正解是把注入点做进持久化本身
（`cancelTask` 的 `beforeStatusCas` 即先例），那要动生产接口，单独立一刀。

### 推红一次：PostgreSQL 上的 fixture DDL 会**跨用例污染**

§5ct 给 `rfc120-deferred-dispatch` 加的 RFC-333 故障触发器没删，把同文件的
「decision atomically stamps…」判据推红在 CI shard 5/8（`62c95e336`，已由 `2161d4789` 修）。
SQLite 每个用例拿全新内存库、DDL 随库消失；PostgreSQL 的库是**整个文件共用的真库**，
用例之间只清表数据、**不回滚 DDL**。
**本地整文件跑是绿的**——两个引擎的用例执行顺序不一样：SQLite 按文件顺序（decision 在 fault
之前），PostgreSQL 实测 fault 先跑，只有 PG 侧撞得上。教训：**不要用「本地这个文件全绿」证明
没有夹具污染**，注入 DDL 的用例一律 try/finally 清理（`rfc359-w17` / `rfc359-w28` 早有先例，
是这次漏看了）。`DROP TRIGGER` 语法两边不同：SQLite 触发器名是库级的，PostgreSQL 的挂在表上、
还要额外删触发器函数。

## 5cv. 第四批（430 → 423），以及把**静默 PG 竞态**审计清到零

### 变换器收了四条新前置条件（都由实撞出来）

1. **`ReturnType<typeof createInMemoryDb>` 也是句柄类型**。只按 `DbClient` 改名会把 import 删掉、
   把这种写法留成 `TS2304 Cannot find name`。现在它与 `DbClient` 一起换成 `ProviderNeutralDatabase`，
   「还有没有残留」的判据也从「有没有调用点」放宽到「有没有任何非 import 的标识符引用」。
2. **`harness` 绑定只有落在所有 provider 块之外才算冲突**。文件里已有的
   `describeEachProvider(name, (harness) => …)` 自带一个同名形参，按「文件里有 harness 就跳过」
   判会把整批都误拒。
3. **构造点在循环体里 = 每轮一个新库，不能合**。`skill-identity-migration` 的
   `for (const defect of ['non-current','wrong-path'])` 每轮 `createInMemoryDb` 一次；
   collapse 到一个 `harness.db` 之后第二轮看见第一轮的行，**SQLite 侧当场就红**
   （这次是好事：错误没等到 PG 才暴露）。「同一函数作用域建两次」的旧判据看不见循环，
   因为循环体不是函数作用域。
4. **`describe` 工厂可以整体包**。本仓有一种局部惯用法：
   `function describeNativeXxxCases(cases) { describe(name, () => { beforeEach(… createInMemoryDb …); cases() }) }`，
   把同一份用例体在几套夹具下各跑一遍。这种 `describe` 不在顶层，旧判据看不见；
   认掉之后 `rfc234-dump-builder` / `rfc248-repo-group-service` / `rfc291-call-edge-binding` 一次性迁完。

### `db.run(sql`…`)` —— 同一类竞态的另一种写法

`rfc248-repo-group-service` 用裸 SQL 循环插两行 `memories` 再读条数：SQLite 上 2，
PostgreSQL 上 **0**。终结子退役器此前只认 drizzle **构建器链**（`db.insert(…).values(…).run()`），
裸 SQL 的 `db.run(sql`…`)` 从它眼皮底下走了过去。两者在 bun:sqlite 上都是同步、在 PostgreSQL
上都是 promise，**不 await 就是发射后不管**。审计与退役器同批补上这一形状。

### 审计与退役器都必须**按 provider 块划范围**

一个文件常常同时装着 provider 块与**故意保留的单引擎 `describe`**。后者依赖 bun:sqlite 的同步
语义——`rfc359-w16` 的判据名就叫「legacy companion **is synchronous**」，退役器把那个 hook 改成
`async` 就把它推红了（两次）。但范围不能反过来划成「provider 块之内才算」：**模块级的 seed
helper 不在任何块里，却会被 provider 用例调用**，那才是真正的漏网之鱼。正确的排除口径是
**只排除「没有被任何 provider 块重叠的顶层 plain `describe`」**。

按这个口径重算，全树 **fire-and-forget 终结子从 39 降到 0 真命中**；报表里剩的 4 条是同一类误报
——用例自己建了一个**本地 SQLite 句柄**（`dbTxSync` 原语、`$client.close()`），按构造就是同步的。

### 这一批的拒绝项都是「本来就该单引擎」，不是漏迁

- `rfc317-cross-context-ports`：`readAuthorityFence` 是**同步** public 端口，PostgreSQL 上
  `readRowSync` 读不到、落到 `fenceCache`，用例没给缓存预热就是 `null`。与 `inspectHumanReview`
  同类（§5cj 已登记）。
- `rfc333-task-participants`：三处 `CREATE TRIGGER … RAISE(ABORT …)` 故障注入**加**一个循环。
  要按 §5ct 给 rfc120 的那套配方（plpgsql + finally 清理 + `expectDatabaseFailure`）逐条重做，
  单独一刀。
- `rfc304` / `rfc309` / `rfc311-repos-page` / `rfc189-wg-round`：`$client` 仪器面或形参写死
  `DbClient` 的 callee。

## 5cw. 拿窄形参 callee 开刀（这才是剩余迁移面的真正卡点）

§5cn 那张「卡住多少账本文件」的表按**原始计数**排序，会把人带偏：排前四的
`resumeTask`(19) / `retryNode`(14) / `dbTxSync`(11) / `cancelTask`(9) 合计卡住 53 个文件，
但那些文件**本来就被别的理由判成单引擎**（`runTask` / topology / `$client` / `new Database(`）。
把「已被其它理由 sanction 的文件」扣掉之后，净解锁量完全是另一张表：

| 净解锁 | callee | 处置 |
| --- | --- | --- |
| 4 | `composeSqliteWebhookIngressPersistence` | 形参放宽（函数体本来就中立） |
| 3 | `createCodeHostWebhookRoutingDirectory` / `…DeliveryConsumer` | 同上，同一文件 |
| 3 | `convergeResourceBundleApplies` | 体内有 `dbTxSync` / `$client`，留待单独一刀 |
| 3 | `convergeIntentApplyJournal` | 体内 3 个同步终结子 + `dbTxSync`，同上 |
| 2 | `composeSqliteAgentLaunchResourceOperations` | 形参放宽 |
| 1 | `startWorkgroupTask` | 形参放宽 |
| — | `resumeTask` / `retryNode` / `cancelTask` / `dbTxSync` | **净解锁 0**，按裁决就该单引擎 |

**排序口径本身是这一段的结论**：给「窄形参 callee」排优先级时，必须先扣掉那些**无论如何都不迁**
的文件，否则会把整个 sprint 花在解锁一批根本不打算迁的用例上。

### 本波放宽的（函数体早已中立，只有形参写窄）

`modules/integration/composition.ts`（两个 code-host webhook 装配）、
`modules/integration/composition/webhookIngress.ts`（ingress 持久化 + delivery runtime）、
`modules/task-execution/composition/agentLaunchResources.ts` 与它背后的
`infrastructure/agentLaunchResourceOperations.ts`（SQLite 那份孪生的函数体**逐字中立**——
`await db.insert(...)`、`getAgentById`、`canViewResource`，只有形参写了 `DbClient`）、
`legacy/workgroup/launch.ts`（`startWorkgroupTask` / `startWorkgroupTaskFromFrozen` /
`ensureWorkgroupHostWorkflow`）。另外两个测试夹具同批放宽：
`helpers/taskLifecycleCommittedEvents.ts`、`helpers/staticCachedRepositoryPreparation.ts`。

**一处早就备好的换名**：`launch.ts` 里三处 `composeSqliteResourceCatalog({ db })` 换成
`composeResourceCatalogFor({ db })`——后者形参本来就是 `ProviderNeutralDatabase`，
前者只是个转发壳（§5cn 已经点出「调用方改个名字就行」）。

### 两条没有硬啃的边界

- `startExecution` 的形参写的是 `StartTaskDeps['db']`，窄在**任务启动 deps 类型**上，不是一行能放宽的。
  `rfc243-executor-facade` 只往里传一个 `null` stub，于是把 stub 的类型对齐到形参类型即可。
- **`rfc310-digital-employee-system-mock-e2e` 卡的根本不是数据库**：它依赖一个 `beforeAll` 起的
  **共享 system-mock 套件**，里面的 project / repository id 是写死字面量
  （`rfc310/digital-employee-os-review`、`repo-system-mock-*`，全文 20+ 处，还有断言直接匹配这些
  字符串）。同一个用例体跑第二遍时 mock 直接回 500
  `gitlab project '…' is already seeded`。顺带还暴露了**模块级 `mkdtempSync` 根 + 固定子目录名**
  的老坑：第二遍的 `git add -A` 在已提交的树上找不到改动，`git commit` 失败，报出来的是一句与
  数据库毫无关系的 git 错误。要迁它得先让 mock 的 id 随用例唯一——单独一刀，不夹在这波里。

## 5cx. 把 AC-6 的账本切成「已裁决的单引擎」与「真·待办」——421 里真正的债是 **126**

### 为什么必须切

上一版账本只回答「有多少行」，回答不了接手的人真正要问的那句：**这一行是债，还是本来就这样？**
读到 421 的人只有两种反应，而且两种都错：要么以为还有 421 个待办（士气税，而且会把精力花在
一批根本不打算迁的用例上，见 §5cw 那张被原始计数带偏的表），要么反过来把所有行都当成
「反正都是历史包袱」——那时守卫就彻底失效了，因为新写的单引擎判据混进去也没人看得出来。

### 分类**故意是机械的**，不是人工标注

人工标注会立刻退化成「谁都能给自己新写的那条编一个理由」。所以判据全部落在**文件内容**上
（`SANCTIONED_SINGLE_ENGINE`）：

| 类别 | 数量 | 判据 | 为什么它就该单引擎 |
| --- | --- | --- | --- |
| `sqlite-execution-engine` | 124 | `runTask(` / 测试拓扑 / `import services/task` | `TaskRouteOperations` 这一对早已判为「不该合」，PG 生产走 `taskExecutionProvider.cancellation`，不经过这条路径 |
| `migration-chain` | 86 | 路径形如 `migration-<n>` | 判的是 **SQLite 迁移链本身**；PG 有自己的序列与对账守卫（`rfc359-w5-t19g`），两条链不共用用例 |
| `real-file-database` | 50 | `new Database(` | 被测物就是磁盘上的 SQLite 文件格式（备份 / 还原 / `VACUUM INTO` / 外部 store） |
| `sqlite-only-primitive` | 35 | `$client.` / `PRAGMA` / `dbTxSync(` | bun:sqlite 独有的面：语句计数、`EXPLAIN QUERY PLAN`、同步事务原语 |
| **`OPEN_MIGRATION_DEBT`** | **126** | 以上都不成立 | **这才是待办量，也是唯一需要往下压的数字** |

`OPEN_MIGRATION_DEBT` 逐文件列名、按字典序、只降不升，并在
`architecture/ledger-baselines.json` 里单独立了一条基线。总账 `TEST_ENGINE_HARDCODING_DEBT`
保持不变，继续当**逐文件调用点数**的棘轮。

### 两条新判据把「切开」本身钉死

1. **两张名单不重不漏**：账本里每一行要么落进某一类 sanctioned，要么在 open 名单里；
   既在两边、或两边都不在，都红。没有这条，分类判据松一松就能把债悄悄挪进 sanctioned。
2. **open 量与实测逐字相等**：新写一条**没有正当理由**的单引擎判据会让它变长。

### 还配了负 fixture（否则这套分类可以静默失效）

分类判据一旦失效（比如正则被改坏），上面两条会**全绿通过**——所有文件要么都被归进 open、
要么都被 sanction，「不重不漏」照样成立。所以另加一条把**伪造**文件内容喂给纯判据
`sanctionFor(rel, text)` 的负 fixture，四类理由各验一次、再验一条「没有理由」返回 `null`。
它一点真实语料都不碰——碰了就是在断言现状（那是规则），而不是在证明「决定过程还活着」。

**记账口径**：`guard-manifest.json` 里除 `rfc294-canonical-manifests` 外的条目**不由 census
重算**（census 只重算它自己那一条），所以这次把本守卫的 `assertsAbsence` / `negativeFixture`
从 `false` 改成 `true` 是手改的——改完要再跑一次 census 让 N1a 的内容寻址 provenance 重新对上。

## 5cy. 分类判据必须跑在**剥掉注释**的 token 流上（否则一句注释就能把债挪进 sanctioned）

§5cx 的分类判据第一版是裸文本扫描，立刻撞上两个问题，方向**都是让数字变好看**——这正是分类判据
最危险的失效模式：

1. **漏判**：`.$client` 的判据写成 `\$client\s*\.\s*(?!close)`，只认「`$client` 后面紧跟点号」。
   而 `rfc349-database-migration-coordinator` 是
   `const sqlite = (drizzle as unknown as { $client: Database }).$client` 换行之后再
   `sqlite.serialize()`——取的就是裸 bun:sqlite 句柄（把库序列化成文件，因为它测的是
   **SQLite → PostgreSQL 迁移**，源库按定义就是 SQLite），却没被认出来，于是被当成待办去迁，
   迁完在 PG 上以 `undefined is not an object (evaluating 'sqlite.serialize')` 红。
   判据放宽成 `\.\s*\$client\b(?!\s*\.\s*close\b)`：**取用**裸句柄都算，**只关它不算**
   （§5cm 的既有裁决：`$client.close()` 只是收尾）。
2. **误判**：放宽之后立刻有 11 个文件被判成 sanctioned，其中 `rfc305-architecture-lock`
   的 `.$client` 出现在**注释里**——那段注释恰好就是在解释「裸文本扫描会撞上自己」。
   把一条真待办因为一句解释性注释挪进 sanctioned，是这套分类最不该犯的错。

所以判据统一跑在 `codeOnly(text)`——用 TS scanner 以 `skipTrivia` 扫一遍、token 用空格拼回，
注释整体消失（所有判据随之写成容忍空白的形式：`new\s+Database\s*\(`、`from\s*'…services/task'`）。
负 fixture 同批加了一条：`sanctionFor('plain.test.ts', '// 这里解释 db.$client 与 PRAGMA …')`
必须返回 `null`。

**净效果**：总账 421 → **418**（迁了 3 个：`rfc212-revalidation-infrastructure` /
`rfc330-case-members-ws-gate` / `scheduled-tasks-ws`），open 待办 126 → **113**
（3 个真迁走 + 10 个是判据补洞后归位到 `sqlite-only-primitive`，其中不含 `rfc305`——它只是注释）。
**判据补洞导致的数字下降要单独说清楚**，否则下一个人会把它误读成迁移进度。

## 5cz. 剩下 113 条 open 的**下一个拦路石**分布（实测，不是估的）

对每个 open 文件探测「下一步会卡在哪」：

| 下一个拦路石 | 文件数 | 说明 |
| --- | --- | --- |
| 无（机械可迁） | 48 | 但**「探测不到」不等于可迁**——其中相当一部分是窄形参 callee 卡住的，文本探测看不见（`readAuthorityFence` 的同步端口、`DbClient` 形参的 deps） |
| 同步终结子 | 40 | `termfix2` 可批量处理 |
| `createApp` | 18 | 要换 `describeEachProviderHttpApplication`，而各文件传的 deps 不同（`maintenanceStatus` / `databaseTelemetry` …），逐个看 |
| 裸 SQL 终结子 | 5 | 同 §5cu |
| 共享 system-mock | 3 | 见 §5cw 的 `rfc310` 那条 |
| 组合 | ~12 | |

**排期口径**：机械那一桶已经被前几波刮到边际产出很低（第 7 波 31 个候选只survive 3 个），
真正的下一刀应该是 `createApp` 那 18 个——它们卡在同一个可复用的装配上，
而不是每个文件各自的坑。

## 5da. HTTP / WebSocket 那一桶：先给作用域开一个**按用例**的注入口（416 / open 111）

§5cz 判定的下一刀是 `createApp` 那 18 个。先做的不是迁文件，是**量清楚它们到底缺什么**：
把每个文件 `createApp({...})` 的实参 key 抽出来、减掉
`ProviderHttpApplicationInput` 已经支持的集合，得到的缺口出乎意料地小——

| 缺的 dep | 文件数 |
| --- | --- |
| （什么都不缺） | **15** |
| `secretBox` | 6（而且作用域本来就把**应用自己装配的那一份**当 `opened.secretBox` 交出来，正是这些用例真正需要的那一份） |
| `maintenanceStatus` / `databaseTelemetry` | 1 |
| `executionContracts` | 1 |
| 迁移协调器那一簇（`admission` / `sqlitePath` / …） | 1 |

也就是说这一桶**不是 18 个各自的坑，是一个共用装配**——这正是它比「机械那一桶」更值得做的原因
（第 7 波 31 个候选只活 3 个）。

### 作用域缺的唯一一件事：**按用例**覆盖注入值

`describeEachProviderHttpApplication` 的选项是 **describe 级**的，`open()` 此前只接受
`config` 覆盖。而真实用例里常有一两条要换一个注入值：`rfc135-runtimes-status` 同文件 25 条用
默认探测超时，只有「挂死的二进制要被逐行超时掉」那条要 2s。没有这个口子，这类文件只能整份
留在单引擎上。

所以把 `open()` 的形参放宽成 `{ config? } & Partial<Omit<Options,'tempPrefix'|'bootstrap'>>`，
实现里 `...applicationInput, ...perCase`。一行改动，解锁的是**整类**「大部分用例同一装配、
个别用例换一个注入」的文件。

### 两个先导迁移

- **`rfc135-runtimes-status`**（25 条判据，含探测超时 / 进程树收割）：`tmp` 目录只剩「放桩二进制」
  一个用途——它必须留在作用域之外，因为两个协议默认路径要在**装配之前**写进 config
  （`open({ config })` 就是这个口子），而 app home 是 `open()` 现建的。
  那条 2s 超时的用例改成**重开同一个作用域的应用**（库还是本用例那一个、内建运行时已 seed 过，
  只有注入值不同），而不是再建一个 harness——后者会在同一个库上把内建运行时 seed 两遍。
- **`ws.test.ts`**：真 `Bun.serve()` + 真 WebSocket 客户端那套 lifetime 本来就已经收进
  `describeEachProviderWebSocketApplication`（含**进程级**广播器单例的 afterEach 重置），
  本文件只是还没用它。14 条判据两引擎全绿。

### 两个**不该迁**、但机械判据看不见的形状（登记，不扩判据）

- `rfc349-daemon-provider-core`：它把 `composeSqliteDaemonProviderCore` 与
  `composePostgresqlDaemonProviderCore` **摆在一起对拍**，SQLite 那半按定义要建 SQLite 库
  （而且只 `$client.close()`，按 §5cm 的裁决不算「用了裸驱动面」）。harness 给的是**当前引擎**
  那一个库，喂不了「同一条用例里两个根都要在」。
- `rfc221-login-policy-routes` / `rfc257-webhook-error-codes`：用例注释里已经写清了单引擎理由
  （§5bg 的装配签名不对称）。全树只有这 2 个文件有这种「写在散文里的裁决」，**不值得为它们
  新增一类 marker 判据**——marker 判据的风险是「谁都能给自己编个理由」，而收益只有 2 条。
  它们留在 open 名单里，等 §5bg 那一刀连根消掉。

## 5db. HTTP 那一桶第二迁：`rfc104-builtin-readonly`（415 / open 110），以及两个**不该迁**的形状

`rfc104-builtin-readonly` 是这一桶里最典型的形状：一个模块级 `buildApp()` 建库 + 建应用，
**17 个用例各自调一次**，散在两个顶层 describe 里（另两个 describe 不碰库，不用包）。
迁法与 §5da 的先导一致：`buildApp(scope)` 里 `db` 取 `scope.harness.db`、`app` 取
`(await scope.open()).app`，两个用到它的 describe 各自包成 `describeEachProviderHttpApplication`。
顺带退役 28 个同步终结子（3 个函数转 async、6 个调用点补 `await`）。37 条判据两引擎全绿。

一个顺手的确认：`composeSqliteFusionPersistence` 其实**只是 `composeFusionPersistenceFor` 的别名**
（`modules/knowledge-evolution/composition/fusion.ts`），形参早就中立——名字里的 `Sqlite` 是纯
命名债，不是能力债。这类「名字吓人、签名已中立」的转发壳在 AC-12 的 provider-命名账本里还有，
迁移时不必绕开它们。

### 两个查明**不该迁**的（不是漏做）

- **`rfc310-pr3-journey`**：整份夹具建在 `beforeAll` 里（真 git 仓 + requirement provider mock +
  策略种子），5 个 describe 共用。作用域是**每用例**一个应用，迁过去等于把这套昂贵夹具按用例重建，
  改的是用例的代价结构而不只是库来源。要迁得先把夹具拆成「贵的一次性部分」与「按用例的部分」。
- **`rfc326-review-decision-batch`**：两个 builder 各自在自己的 tmp 下建 `appHome/doc_versions`，
  而作用域的 app home 是 `open()` 现建的——得像 `rfc294-route-gate-compat` 那样改成在
  `open()` 之后往**作用域的** appHome 里建目录。形状可迁，但两个 builder × 四个 describe，
  单独一刀更稳。


## 5dc. 推红一次：`describe` 体里读 `harness.db` 是**注册期**读取（本地可能绿，CI 必红）

`d50fc1ca5` 把 main 推红了，**四个分片同时挂**（ubuntu 3/8、6/8，macos 2/6、3/6），
全是同一条：`error: ProviderHarness 只能在 test 体内读取（beforeEach 之后才有库）`。

肇事的是两处 `const db = harness.db`——写在 `describeEachProvider(name, (harness) => { … })`
的**函数体顶层**。那段代码在**注册期**执行（bun 先跑一遍 describe 体把用例登记上），
那时 `beforeEach` 还没建库，惰性 getter 当场抛。

**为什么本地没抓到**：惰性 getter 抛不抛，取决于同进程里**前一个文件**是否刚好把 harness 状态
留成非空。单跑这两个文件时本地 25 pass 全绿；在 CI 分片里跟几十个文件一起跑就必红。
这与 §5ct 记的「PostgreSQL 上 fixture DDL 跨用例污染」是同一个教训的另一面：
**「本地这个文件全绿」不能证明没有跨文件耦合**。

### 变换器的第六条前置条件

`apply6` 判「构造点在哪个作用域」用的是**最近的函数式祖先**；对写在 describe 体顶层的
`const db = createInMemoryDb(...)`，那个祖先**就是 describe 自己的箭头函数**，于是它通过了
「同一作用域只建一次」的检查、被替换成 `harness.db`，正好落在注册期。现在显式拒绝这种位置。

### 上了守卫（这条不该靠 review 兜）

`rfc359-w5-t19f` 里新增「注册期读 harness」判据：扫整棵测试树，找 `describeEachProvider`
**体内直接求值**的 `harness.db` / `harness.session` / `harness.capabilities`。
判据只认**立即求值**——`const db = () => harness.db` 与 `test(...)` / `beforeEach(...)` 里的读取
都放过（回调晚于注册期）。同批配了负 fixture：立即读要抓到、推迟读与用例内读要放过，
否则判据被改坏时整条会静默变成永远绿。

## 5dd. `tasks.test.ts` 迁双引擎照出**两条真的路由行为分叉**（414 / open 109）

迁法与 §5da/§5db 同形：app home 与 `AGENT_WORKFLOW_HOME` 的接管/还原/删除全归作用域，
用例这边只剩「一个真 git 仓」和 after-commit pump（pump 必须**装配之前**装上——它挂的是进程级
投递口，应用 composed 之后再装会漏掉首批事件）。58 条判据里 **53 条两侧一致**，
**5 条不一致**——而这 5 条才是这次迁移真正的产出。

### ① retry 一个 `worktreePath` 为空的失败任务：SQLite 200 / PostgreSQL 410

SQLite 根直接重试并转 `pending`；PostgreSQL 根走 `assertWorktreePresentForResume`，
空路径 + 无墓碑 + 无 `__repo_prep__` 行 ⇒ `410 task-worktree-missing`，文案还写成
"likely reclaimed by worktree GC"。

**两侧都不完全对**：`worktreeResumePreflight.ts` 自己的注释就写明空路径有两种形态——
「被 GC 回收」与「从来没建出来」，后者该给 409 + 「重试准备仓库」而不是说成被回收。
所以要定的是**一个统一语义**，不是挑一边照抄。

### ② 启动一个源不是 git 仓的任务：SQLite 201 / PostgreSQL 400

SQLite 根**先接受**（201，任务行留下，准备在后台失败后转 `failed`）——这正是 RFC-287 G7
刻意设计并锁住的形态，前端靠 `__repo_prep__` 行分出「准备中 / 准备失败」第四态；
PostgreSQL 根**当场拒绝**（400），不留任务行。于是 PG 部署上 G7 的那条用户路径
（详情页看准备失败原因 → 点「重试准备」）**根本到不了**：没有任务行就没有详情页。
这一条不是「谁更严格」的口味问题，是 **G7 的能力在 PG 上缺失**。

### 处置

5 条按 `scope.harness.capabilities.provider !== 'sqlite'` 登记为单引擎，**用例注释里逐条写明
两侧各自返回什么、为什么**，并在 `docs/audit-backlog.md` 立项。没有在这一刀里改：
①要定空 worktree 的统一前置检查与错误归因，②要决定 G7 的「先接受、后台失败」是否在 PG 上也成立
——都是产品行为决策，不夹在测试迁移里做。

**这正是 AC-6 的价值所在**：把测试迁到双引擎不是为了让账本变小，是为了让这种分叉在**有人看的地方**
暴露出来。这两条在迁移之前，PostgreSQL 侧是零覆盖的。

## 5de. `rfc247-api-docs`：`secretBox` 那一组其实什么都不缺（413 / open 108）

§5da 统计里「缺 `secretBox`」的 6 个文件，其实**一个新 dep 都不用加**：作用域交出的
`opened.secretBox` 就是**应用自己装配的那一份**，而这些用例真正需要的正是那一份
（另建一个 box 去解同一批加密行会解成乱码——`providerHttpApplication.ts` 的注释早写了）。
它们自己 `createSecretBoxFromKey(randomBytes(32))` 只是因为没有作用域时无处可取。

`rfc247-api-docs` 迁完（44 条判据两引擎全绿），三件事值得记：

1. **配置覆盖必须走 `open({ config })`**。原用例有个 `configFile(overrides)` 助手，往自建 tmp
   目录写一份 `config.json` 再把路径塞给 `createApp`。作用域里应用读的是它**现建**的那个
   configPath，自写的那份会被整份绕开——迁的时候要把 `configFile({...})` 直接变成
   `open({ config: {...} })` 的实参，而不是保留那个助手。
2. **`beforeAll` 里不能碰 `harness`**。本文件原有一个 `beforeAll(() => realApp())`，用途只是
   **把生产路由表灌进共享注册表**（`buildApiDocs` 读那张表）。`beforeAll` 跑在 harness 建库
   **之前**，`scope.harness.db` 在那里会抛——必须改成 `beforeEach`。这是 §5dc 那条
   「注册期读 harness」的**近亲**：`beforeAll` 也早于 `beforeEach`。
3. `{ bootstrap: 'ready' }` 与 harness 默认等价（只有 `'required'` 才改行为），可以安全丢。


## 5df. Ubuntu backend 分片 8 → 12：AC-6 的双引擎迁移正在把 CI 的 job 预算吃满

连续两次 run 的 `Backend tests (ubuntu-latest shard 1/8)` 都被杀掉，而**其余 38 个作业全 success**：

| run | shard 1/8 | 判读 |
| --- | --- | --- |
| `bed6680c8` | 测试体跑完（3049 pass / 0 fail，851s）之后才 `The operation was canceled` | 超的是**整个 job**（装依赖 + 跑测 + 收尾），不是某条用例挂住 |
| `1a3ff5ebd` | `14:27:52 → 14:43:07` = **15:15** | 正好越过 `timeout-minutes: 15` |

GitHub 把 job 超时报成 `cancelled`，聚合 job `CI required` 随之判红——很容易被读成玄学。

run `34762730963` 实测八片：15.25 / 10.7 / 10.05 / 10.5 / 13.9 / 11.3 / 10.07 / 12.5 分钟，
合计 ~94 分钟、均值 11.8、最长片是均值的 **1.29 倍**、已贴到预算 **101%**（次长 93%）。
十片只能压到 ~12.2 分钟（81%），而 macOS 那次的教训正是 **88% 也不够**；
十二片压到 ~10.1 分钟（**67%**），与 macOS 定的「~10 分钟量级」同一目标。

**这笔账要算在 AC-6 头上**：`ci.yml` 的注释写着「Ubuntu now runs both providers」，
而本轮每迁一个文件到 `describeEachProvider`，Ubuntu 侧就多跑一遍。这正是那条注释里说的
「as the provider workload grows」，处置也照它自己立的规矩：**加 runner，不动预算、
不改单条用例的超时**（macOS 四片→六片是同一条规矩的上一次执行）。

**对后续波次的含义**：AC-6 还剩 108 条待办，继续迁会继续加 Ubuntu 侧的时长。
十二片留出的方差空间够下一批用，但**再迁一大批就要再量一次**——判据是「最长片 ≤ 预算 67%」。


## 5dg. 分片改动的**三个下游**：两个分片数守卫 + 一条被时序掩盖的真竞态

§5df 把 Ubuntu 从八片加到十二片，run `34763930487` 里五个作业红了。分开看是两件完全不同的事：

### 四个红是**守卫按设计拦住了我**（好事）

`root-test-entrypoint.test.ts` 与 `rfc349-postgresql-hosted-evidence.test.ts` 各自把 Ubuntu 矩阵
**逐字钉死**。前者的注释写明了为什么要钉死：「A denominator in the command is not enough:
accidentally shortening the matrix (for example, [1, 2, 3] with /4) makes CI green while one
quarter of the suite is never selected.」——只写分母不写分子，CI 会绿着跑掉四分之一的用例。
两个守卫都按设计工作，改分片就必须同步改它们（连同写清为什么扩片）。

### 第五个红是**一条一直存在、靠时序侥幸绿着的生产竞态**

`RFC-247 D8 … the owner reads their own through /api/auth/pats/audit [postgresql]`
以 `Expected: > 0, Received: 0` 失败，而同文件单跑 46 pass / 0 fail。

根因在 `src/server.ts` 的 `/api/*` 中间件：`void deps.core.tokenCallAudit.record(...)`。
`void` 是**刻意**的（RFC-247 F13/F14：「auditing never breaks the call」），但两个引擎的**保证**
因此不同——SQLite 上 `insertAudit` 同步执行，中间件返回时行已落库；PostgreSQL 上它是**真异步**
且无人 await，客户端紧接着读审计接口会读到空列表，滞后无上界。

**重新分片没有引入它，只是改变了同片文件组合与时序，把它撞了出来。** 这与 §5ct（PG 上 fixture DDL
跨用例污染）、§5dc（注册期读 harness）是同一族教训的第三例：**「本地绿」与「上次 CI 绿」都不能
证明没有时序耦合**，分片、文件顺序、并行度一变就翻脸。

处置：用例改成按「最终一致」语义有界等待并注明这是生产差异；**生产代码没动**——要不要在 PG 上
await（给每个 token 请求加一次写往返）还是改成带确认的后台队列，是**产品决策**，已在
`docs/audit-backlog.md` 立项。

## 5dh. HTTP 桶第四、五迁：逐例覆盖派发器，以及「别把故意保留的原生块一起包了」（412 / open 107）

### `rfc257-webhook-management`（26 条判据）：§5da 那个逐例覆盖口子的第一个真实用户

它的 `harness()` **每次调用**都新建一个 `dispatched: string[]` 与对应的 `WebhookDispatcher`，
13 个用例各调一次。派发器是 describe 级选项喂不了的——正好是 §5da 给 `open()` 开的
逐例覆盖：`await scope.open({ webhookDispatcher: dispatcher })`。

`secretBox` 也不必自建：本文件从不用它自己加解密，只是往 `createApp` 里塞，而作用域交出的
就是**应用自己装配的那一份**（§5de 已记）。模块级那个 `createSecretBoxFromKey(Buffer.alloc(32, 5))`
随之退役。

### `workflows.test.ts`（41 条判据）：只包 HTTP 那半，别碰故意保留的原生块

这个文件里**三种块并存**，账本里的两个调用点归属完全不同：

- `describe('workflow service') > describe('SQLite list compatibility')`：**故意**用原生 SQLite 库
  （`setupNativeServiceDb`）跑 list 兼容判据，旁边就是同一个 describe 里的
  `describeEachProvider('CRUD')`——一半原生一半双引擎是**设计**，不是漏迁。
- `describe('workflow HTTP routes')`：`buildHarness()` 建库 + 建应用，可迁。

只迁后者。**规律**：一个文件的账本条目数 > 1 时，先看它们是不是**归属不同的块**——
盲目把整文件包进作用域会把「故意保留的原生对照」也一起吃掉，那是把有意的单引擎对照删掉，
不是收敛。

## 5di. `rfc311-task-archive`：**别把嵌在里面的 provider 块一起包了**（411 / open 106）

这个文件一次干掉 5 个账本条目（手动归档入口那 5 条用例各建一次库），但踩了一个新坑，
与 §5dh「一个文件里多种块并存」是同一族、方向相反：

上一次是**别把故意保留的原生块包进来**；这一次是**别把已经双引擎的块包进来**——
`describe('RFC-311 T19 — 手动批量归档入口与审计行')` 体内**嵌着**一个
`describeEachProvider('ordinary sweep audit persistence')`。把外层整块包成
`describeEachProviderHttpApplication` 之后，那个内层块就成了 **provider 块套 provider 块**，
两套 harness / 两个 PG 库，直接炸（实测：内层用例在 `[postgresql] > application lifetime >
… [postgresql]` 这种双重身份下全挂）。

处置是把内层块**提到顶层**当兄弟。这又暴露出第二跳问题：它引用了定义在外层 describe 体里的
`auditRows` 助手——提出来之后作用域没了。把该助手**上提到模块级**即可（它本来就是一行中立查询）。

**定式**：包一个 describe 之前，先扫它的**整个子树**里有没有 `describeEachProvider`。
有就先把内层提到顶层、并把它用到的助手一并上提，再包外层。

配置覆盖同 §5de：那条「显式关掉自动归档、只留保留期」的用例原本往自建 home 写 `config.json`，
迁到作用域后改走 `open({ config: { taskArchive: { enabled: false, retentionDays: 90 } } })`
——应用读的是作用域现建的 configPath。而归档产物（`archive/tasks/<id>/manifest.json`）
仍要按作用域交出的 `opened.appHome` 去断言。

## 5dj. 从「这条测试迁不动」倒推出「它测的东西生产早就不用了」——merge_state 孪生退役（AC-1 / AC-6，410 → **409** / open **105**）

### 起点：一条迁不动的测试

`rfc172-dispatch-shard.test.ts`（18 个调用点，账本上最肥的几条之一）机械迁完之后 typecheck 只剩
两处红：`abandonSupersededMergeStates({ db, … })` 收的是 `DbClient | DbTxSync`，中立句柄塞不进去。
顺着它往回读 `platform/persistence/sqlite/taskLifecycle.ts`，才发现真正的问题不在测试：

```
$ grep -rn "abandonSupersededMergeStates" packages | grep -v node_modules
… 只有：定义本身、`services/lifecycle.ts` 的再导出、三个测试文件、以及若干注释
```

**零生产调用方**。同一段 supersede 闭包（前代 top-level + 其子行、`lt(id, 新行)`、按 shard 收口）
生产早已跑在 `modules/task-execution/infrastructure/nodeRunMintParticipant.ts` 的铸行程序里，
provider 中立的一份。同一次盘点里 `transitionMergeState` / `tryTransitionMergeState` /
`ConcurrentMergeStateTransition` / `MergeStateUpdateExtra` 同样零生产调用方——它们的现役对应物是
`infrastructure/mergeStateLifecyclePersistence.ts`（W4-B1 已合一，读 + CAS 写同一事务，
比孪生那份**更严**：孪生的 SELECT 在事务外）。

**这正是 AC-1 说的那种重复实现**：两份代码、同一语义、其中一份只有测试还在喂它活着。
按 `CLAUDE.md`「删除优于 deprecate」，整块（213 行）删除。

### 判据不能跟着一起删

三个文件的判据改打在**生产实现**上，顺带各自变成双引擎：

| 文件                                        | 原来打在                                | 现在打在                                                       |
| ------------------------------------------- | --------------------------------------- | -------------------------------------------------------------- |
| `rfc144-merge-state-cas.test.ts`            | 三个孪生函数                            | `DrizzleMergeStateLifecyclePersistence` + `nodeRunMintParticipant` |
| `rfc172-dispatch-shard.test.ts`（2 条）     | `abandonSupersededMergeStates(shardKey)` | 铸一行真的 `__wg_member__` run，断言 supersede 闭包的可观察结果 |
| `rfc359-w4-d28b-owned-mutation-gateway.test.ts` | `transitionMergeState`              | 同一个中立 persistence                                          |
| `rfc144-stale-replay-regression.test.ts`（4 处） | `transitionMergeState`             | `createTaskExecutionPersistence(db).mergeStates`                |

**一处判据被迁移改写（须知悉）**：原 CAS 竞态用例断言「竞争者赢」——旧孪生的 SELECT 在事务外、
竞争写也在事务外，所以竞争者那一笔留得住。中立实现把读—改—写收进**同一笔事务**，CAS miss 让整笔
回滚，注入的竞争写**随之一起回滚**。所以判据改成锁真正的不变量：**我方那条写没落库**
（`mergeState` 停在竞态前的值、`isoWorktreePath` 停在 null）。NULL-from 那格另加一句说明：
它与 happy path 的 `begin-isolation` **必须同时绿**才证明谓词走的是 `IS NULL`——
写成 `eq(col, null)` 时本例照样抛冲突，但正向迁移也永远做不成。

### 竞态怎么在两个引擎上都构造得出来

旧写法是「代理 `db.update`，在 UPDATE 前同步插一条竞争写」——那依赖 bun:sqlite 的同步单连接。
PostgreSQL 上第二条连接会撞行锁把自己锁死。新写法两点：

1. 竞争写走**同一笔事务的句柄**（不是第二个连接）；
2. 代理同时挂在 `update` 与 `transaction` 上——两个引擎的事务句柄来路不同：SQLite 的
   `DatabaseSession` 直接把**客户端句柄**当事务用（显式 `BEGIN IMMEDIATE`），PostgreSQL 走驱动的
   `db.transaction(cb)`。只挂一个就会在另一个引擎上静默不触发（实测：只挂 `update` 时 PG 全过、
   实际没插进去）。插入点用被代理 builder 的 `then`：drizzle 的 builder 是 PromiseLike，
   `await` 的那一刻才发语句，`then` 里先跑竞争写再放行，就是「读到写之间」。

**别把事务句柄交给 `databaseSessionFor`**（它自己的头注释就写着）：重入靠 AsyncLocalStorage 帧按
**客户端**识别，拿事务句柄开会话会在开着的事务里再发一次 BEGIN。第一版就是这么写的，八个用例全红。

### 守卫随之改口径

`rfc144-merge-state-blind-write-inventory` 的 allowlist 原本钉着
`platform/persistence/sqlite/taskLifecycle.ts: 2` 和一个**早已退役**的
`sqliteNodeRunMintParticipant.ts: 1`——后者是「allowlist 条目可以悄悄失效」的活样本：文件没了，
守卫照绿。现在两条：`nodeRunMintParticipant.ts: 1` + `mergeStateLifecyclePersistence.ts: 1`，
并且把「占用性」断言从「钉住某一个文件的计数」改成**逐条对齐整张表**——
退役文件留在表里会当场红。两个中立内核各补一条 `rfc144-allow-direct-merge-state-write` 标记注释。

`rfc328-architecture-guards` 的 `CANONICAL_MUTATION_SYMBOLS` 去掉同名的死条目。
`db/schema.ts` 与 `nodeMechanics.ts` 里指名道姓引用这三个函数的注释一并改写——
注释里点名一个不存在的函数，比没有注释更误导。

## 5dk. `810f71c52` 把主干推红了：一条 **0 fail 却退 1** 的红，根因是 `void <promise>` 没人接

`810f71c52` 的 CI（run `34768029441`）ubuntu 分片 2/12 红，但日志里 **`0 fail`、`Ran 1960 tests`**。
真正的失败长这样：

```
# Unhandled error between tests
error: Failed query: select "in_flight_turn_id" from "…"."mcp_runtime_test_sessions" …
PostgresError: Connection closed  code: "ERR_POSTGRES_CONNECTION_CLOSED"
  at async nextDeadline (…/mcpRuntimeTestPersistence.ts:2048:10)
```

`services/mcpRuntimeTest.ts` 的 `scheduleIdleTimer()`：

```ts
void this.deps.persistence.nextDeadline().then((earliest) => { … })   // 没有 .catch
```

**SQLite 上这条没有窗口**——`nextDeadline()` 里全是同步读，`void` 交出去时 promise 已经 settle。
**PostgreSQL 上它是一次真异步查询**：服务停掉 / 测试拆台把库关了，这个还在飞的 promise 以
`Connection closed` 拒绝，而当时既没有 `.catch` 也没有别的接住者 → 一条**无人处理的 rejection**，
bun 记成「Unhandled error between tests」，**全部用例通过、进程照样退 1**。

分片 8 → 12 只是改变了文件分组、把这个一直存在的窗口挪到了会撞上的位置；不是它引入的。

处置：`.catch` 落一条 warn（排期失败不致命，下一次事件会重新排期），内层
`void this.reconcile()` 同样补上。回归用例注入一个必然拒绝的 `nextDeadline`，
用 `process.on('unhandledRejection')` 当探针——**修复前红、修复后绿**（实测：先把生产改回原样跑一遍，
确认这条用例红，再改回来）。

### 这是一类，不是一处

全树扫「`void <promise>` 且链上没有 `.catch` / 双参 `.then`」得 **47 处**。它们的共同风险形状是
同一条：**SQLite 上同步、PG 上真异步**，于是「在 SQLite 上永远来不及出事」的写法在 PG 上是一个
真实的进程级窗口。已核过的几处里，`tokenCallAudit.record` 是安全的（`insertAudit` 在 try 里，
`writeDeleteSnapshot` 自己整体 try/catch 且连兜底的 `markSnapshotFailed` 也包了）。
其余尚未逐条核实——**这是本 RFC 的一条开放缺口**，记在 `docs/audit-backlog.md`，
正解是给它立一条与 AC-6 同形的账本：**被调函数体整体 try/catch 或链上有 `.catch` = 已接住**，
其余进「未接住」那一栏，逐条收。

### 5dk-b. 立守卫：`rfc359-w5-unattended-void-promise`

光修一处不够——§5dk 那条红的成因是一**类**形态。新守卫按 TypeChecker 扫整棵 `src`：

- **咬什么**：`void <expr>` 语句，且 `<expr>` 的类型是 thenable，且链上**没有**拒绝处理器。
  `.catch(…)` 与双参 `.then(ok, err)` 算接住；`.finally(…)` **不算**（它只转手，不消费拒绝）。
- **账本口径**：逐文件计数（不是行号——行号会被任何无关编辑冲掉）。当前 **19 个文件 / 47 处**。
- **负 fixture**：五条「必须咬住」+ 五条「必须放行」的内存源码变异，含 `void plain()`
  这条（非 thenable 不在管辖内）。

**为什么不按「被调函数有没有 try/catch」自动免责**：那个判据在本仓不可靠。
`maintenanceWorker.processQueue` 的 `try` 前面有二十多行前置赋值（按「函数体是单条 try」判会误判成
未接住）；反过来 `dispatchIntentTurn` 的 catch 与 finally **自己也在写库**——连接池一关，
兜底块自己就抛、异常**越过**它逃出来（那个函数的头注释记着 2026-09-12 同类事故，CI ubuntu shard 6/8）。
**能机械判准的只有调用点那一侧**，所以判据只看调用点，免责也只认调用点上的 `.catch`。

存量里已逐条核实为安全的三族写进了守卫头注释：`modules/intent/**` 的 13 条（都落到已兜住的
`dispatchIntentTurn`）、`maintenanceWorker.processQueue`、`tokenCallAudit.record`。其余未核。
退役一条的判据只有一个：在调用点补拒绝处理器，让扫描器不再数到它。

## 5dl. 三个大文件一批收掉（409 → **406** / open 105 → **102**；49 个调用点）

`rfc128-p5-d-autodispatch`（28）、`rfc333-task-participants`（14）、`rfc230-run-liveness`（6）。
三个各卡在一条不同的机械障碍上，都不是「这段逻辑没法双引擎」：

| 文件            | 障碍                                    | 处置                                                                                     |
| --------------- | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `rfc230`        | 同一模块被 `import type` 与 `import` 分两行引入，转换器只认一条 `db/client` import | 合成一行 `import { createInMemoryDb, type DbClient }`                                      |
| `rfc128`        | 一个模块级助手 `createProjectionDb()` 自己建库；另有一条用例在同一作用域建两个库 | 助手改成 `withProjection(db)`（库由外面给）；那条用例两半共用一个库——**隔离靠不同的 taskId，不是不同的库** |
| `rfc333`        | 一条用例 `for (const fault of …)` 三轮、每轮自建一个库 | 拆成 `test.each` 三条——双引擎 harness 本来就每个用例给一个干净的库                          |

### 故障注入触发器收成一份：`tests/helpers/faultTrigger.ts`

「某张表的写入必失败，验证整笔回滚」这类判据本仓有十来处，而两个引擎的 DDL 不同：SQLite 的触发器体
直接 `RAISE(ABORT, …)`，PostgreSQL 必须先建 plpgsql 触发器函数再挂触发器；`DROP` 也不同
（SQLite 触发器名是库级的，PG 的挂在表上、必须带 `ON <table>`）。抄第四遍时收成
`installAbortTrigger` / `dropAbortTrigger`，支持 `BEFORE INSERT` 与 `BEFORE UPDATE OF <cols>`。
头注释里钉着那条**必须配 try/finally** 的理由：PG 的库是整份测试共用的真库，用例之间只清表
**不回滚 DDL**，留下的触发器会让之后每个写那张表的用例全红（rfc120 上实撞，CI shard 5/8 才暴露）。

### 一条随机红：**铸行的 id 必须显式给 monotonic ulid**

§5dj 把 `rfc172-dispatch-shard` 的 supersede 判据改打在铸行程序上之后，macOS 分片 4/6 随机红一次
（本地五连跑全绿）。原因是 supersede 的谓词是 `lt(id, 新行 id)`，而 `buildNodeRunMintRecord` 默认取
**`ulid` 包的随机 ulid**；测试里前面的 seed 行用的是本文件的 **monotonic** 工厂。同毫秒内随机 ulid
可能排在那些 seed 行**之下** → 一条前代也不废。处置：铸行时显式 `id: ulid()`（本文件的 monotonic
工厂），与 seed 行同源、必然严格更大，判据从此与时序无关。

**定式**：凡是判据依赖「新行 id 比旧行大」的用例，id 必须来自同一个 monotonic 工厂——
不要让一半 id 出自 `monotonicFactory()`、另一半出自生产代码里的随机 `ulid()`。

## 5dm. 一条**用户可见**的引擎分叉：数字员工计划人审闸门在 PostgreSQL 上永远报不出 `waiting`

顺着 `execution-contract-platform.test.ts` 迁不动往回查，发现的不是测试问题：

```
DigitalEmployeeExecutionParticipant.inspectHumanReview?(ref): State | null   // ← **同步**、且可选
composeDigitalEmployeeExecution         → 实现了它（拿 db 同步查两张表）
composePostgresqlDigitalEmployeeExecution → **根本没有这个方法**
```

消费者 `runtimeService.#projectCaseDetail` 写的是
`this.#execution.inspectHumanReview?.(ref) ?? null`，取不到就按 round 状态推断
（`planning` / `approved` / `failed`）。**`waiting` 只有 `inspectHumanReview` 才给得出**。
于是同一个案子：SQLite 上显示「等待人审」，PostgreSQL 上显示「规划中」——用户可见、无声、
两个引擎一个好一个不好，正是本 RFC 的目标形态的反面。

**成因是那个 `?` 与那个「同步」**：端口是同步的，而 PG 侧的 composition 建在端口之上、手里没有可同步
查询的库；端口又是可选的，所以少实现一个方法**没有任何地方会红**。

### 处置：一份中立实现，两侧都装

1. `inspectDigitalEmployeeHumanReviewState` 改成 **async + `ProviderNeutralDatabase`**
   （它查的是 `tasks` + `nodeRuns`，本来就没有方言）。
2. `DigitalEmployeeExecutionParticipant.inspectHumanReview` 与 `ReactionExecutionPort` 同步改 async。
3. PG 侧 deps 新增 `humanReview` 端口（那份 deps 刻意不带 db，全是端口），
   PG daemon 装配处把**同一个**中立实现绑到 PG 客户端上。
4. 消费者那一跳原本在同步 `flatMap` 回调里，改成 `Promise.all(map(...)).flat()`
   ——各 work item 的闸门状态互不依赖，可以并发取。

### 判据：`rfc359-w12-digital-employee-human-review-parity.test.ts`

两件事各自锁死，**两个引擎各跑一遍**：①五个状态逐字相同（planning / waiting / approved /
failed / null，含五种失败态）；②**装配锁**——两侧 composition 都必须交出 `inspectHumanReview`，
再加一条「PG 侧的端口确实被转交」。实测：把 PG 侧那个方法删掉，②当场红 4 格（两个引擎各 2），
补回即绿——那个 `?` 造成的「少实现一个方法没人红」从此不成立。

### 顺带：`startEventsArchiver` 的 `db: DbClient` 是纯粹多余的收紧

它的函数体只把 db 转交给 `archiveEvents`，而后者**早就**收 `ProviderNeutralDatabase`。
放宽一行，`rfc311-maintenance-boot-tick` 的事件归档那半就整块双引擎了（4 条）。
文件另一半（WAL checkpoint 循环）按定义是 SQLite 专属——它开的是真文件库、断言 `-wal` 被
TRUNCATE 归零——保持原生 `describe`，两种块并存（§5dh 的定式）。

**账本**：405 / open 101。

### 本批的 `allowGrowth`（下一个不涨的 commit 上必须删掉）

`rfc294-cross-context-observed-imports` 5264 → 5266、`rfc294-architecture-exceptions` 4730 → 4732。
两条边都是上面这次合一的直接代价：①PG daemon 装配根多引一个符号
`inspectDigitalEmployeeHumanReviewState`（把中立实现装进 PG 泳道，正是装配根该做的事）；
②该 composition 文件多一条 `@/db/query` 的**类型**边（中立签名的必要条件）。
两条都随 W4-E1 的 public 用例切换一并退役。

## 5dn. 两块各 6–10 条（404 / open **99**），外加账本的第五条免责判据

### `rfc317-cross-context-ports`：10 → 3，剩下那 3 条**登记为按裁决单引擎**

DE-01（旧 Mission 排空视图）与 DE-02（反应轮次只读查询面）两块的端口本来就收
`ProviderNeutralDatabase`，迁移只卡在 seed 助手是同步的（`.run()` 不 await ⇒ PG 上外键链断）。
`termfix2` 一遍过：7 个终结符退役、5 个助手变 async、17 个调用点补 await。

TP-03（`readAuthorityFence`）**有意留在单引擎**，并为此给账本加了第五条免责判据
`sync-engine-capability`：那条读是 WS 发帧热路径上的**同步**读——帧要在当前 tick 内定夺，
改 async 会让判定落到下一个微任务、而帧那时已经发出去了。它建在
`EngineCapabilities.readRowSync` 上，而那一格**只有 bun:sqlite 给得出**（PG 侧返回 undefined，
围栏退回进程内的 `AuthorityFenceCache`——RFC-349 的单 daemon 世代前提下那份缓存**就是**围栏本身）。
本块断言的正是「直接改库之后同步读立刻看得见」，那条语义按定义只在 SQLite 上成立；
拿双引擎 harness 跑它等于要求 PG 具备一个它按设计就没有的能力。
于是 open 从 100 再降 1 到 **99**——这个数字重新恢复「只数真债」的含义。

### `rfc310-type-package-auto-upgrade`：6 → 0（2164 行，三跳）

1. **数组回调里的终结符**：两处 `.map(cb => { … .get() … })` 与一处
   `connections.forEach(… writeLegacyToolConnection …)`。前者改
   `await Promise.all(xs.map(async …))`（`Promise.all` 保序，断言逐行不动），
   后者改 `for…of xs.entries()` 顺序写（写有先后依赖，不能并发）。转换器**故意**不碰数组回调
   ——把回调变 async 会静默改变契约，必须人来定。
2. 剩下 54 个终结符 `termfix2` 一遍过。
3. **一个 test 里跑四个场景、每个场景自建一个库**：改共用 harness 的库之后先撞主键
   （`legacy-adapter-v1-1` 重插），给 id 前缀加场景号又撞**岗位模版名**的唯一键。
   正解不是继续给名字加后缀，而是**拆成四条 test**——双引擎 harness 本来就每个用例给一个干净的库，
   四组断言本来就互相独立。**定式**：「一个 test 里跑 N 个各自建库的场景」一律拆成 N 条 test。

### 本批删掉 §5dm 的一次性 `allowGrowth`

`rfc294-cross-context-observed-imports` / `rfc294-architecture-exceptions` 本批不涨，
守卫会把留着的 `allowGrowth` 判为过期，按规矩删掉。

## 5do. 尾巴的形状变了：剩下的 AC-6 债**大半卡在生产侧的成对引擎**（401 / open **95**）

这一批把批量转换器对着 open 名单里 78 个「只有一处构造」的文件扫了一遍，收成很低——
**不是转换器不行，是被转换的对象变了**。对 22 个候选实跑一遍的结果：

| 结果                              | 数量 | 说明                                                                     |
| --------------------------------- | ---- | ------------------------------------------------------------------------ |
| 迁成双引擎                        | 3    | `rfc251-product-boundary` / `rfc304-template-upstream` / `wg-readonly-claim-and-pause-reason` |
| 登记为按裁决单引擎                | 1    | `rfc274-workgroup-output-messages`（`pragma_table_info`）                 |
| **卡在 SQLite-only 的生产签名**   | 8    | 见下表                                                                    |

卡住的那 8 个，卡点全在**生产**侧，不在测试：

| 生产入口                                                  | 卡住的测试                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------- |
| `sqliteIntentApplyOperations` 的 `ApplyIntentDeps.db`      | `intent-agent-branch-ports` / `intent-mcp-oauth` / `intent-privileged-node-capability` / `rfc343-intent-apply-correctness` |
| `legacyResourcePackageCommit` 的 `BundleApplyDeps.db`      | `rfc271-import-commit`(25) / `rfc271-resource-package-hardening`(7) / `rfc271-import-http` / `rfc271-export-closure-authz` |
| `composeLegacySqliteResourceLimitOperations`（内含 `services/task` 的 `cancelTask`） | `rfc207-runtime-accounting` |
| `composeSqliteWebhookTerminalWorkspacePrunePolicy`          | `rfc300-terminal-workspace-policy`                                     |
| `composeSqliteDemoResourceCatalogSeedParticipant` 等        | `rfc307-demo-seed`                                                     |
| `composeSqliteCapabilityTemplateOperations`                 | `rfc309-template-upstream-wiring`                                      |

**结论**：AC-6 的剩余面从「测试没迁」变成了「**AC-1 的成对引擎没合**」。继续压这个数字的正解不再是
批量转换测试，而是**逐对收生产侧的引擎**——每收一对，它下游那一串测试自然跟着能迁。
资源包 apply 那一对（`legacyResourcePackageCommit` + `legacyResourcePackageBundleApply` 约 1450 行
vs `postgresqlResourcePackageAtomicApply` 约 976 行）是其中最大的一块，一次能解开 4 个文件 / 38 个调用点，
它自己的退役条件写在 `legacyResourcePackageBundleApply.ts` 的头注释里：**那批同步 `*InTx` 成员迁到中立事务**。

### 顺手收掉的两个「多余收紧」

- `setPauseReason(db: DbClient)` → `ProviderNeutralDatabase`：体内只有一条中立的 drizzle UPDATE。
- 迁移后的测试里那些 `db.$client.close()` 直接删掉——库的生命周期归 harness 了。

### 账本判据补一格

`pragma_table_info(...)` 是 `PRAGMA` 的**函数**形态（同一张 SQLite 独有的 schema 自省面；
PostgreSQL 对应的是 `information_schema`，形状与列名都不同），判据不该只认大写语句那一种写法。
补进 `sqlite-only-primitive` 之后 `rfc274` 从 open 里退出。

## 5dp. 最大的一处重复此前**不在任何账本里**：资源包 apply 引擎

§5do 查到「AC-6 压不动了，卡点在生产侧的成对引擎」之后，顺手核了一件事：那些卡点**在不在
AC-1 的账本里**。资源包 apply 那一对——本仓最大的一处重复——**不在**。

原因是 `rfc359-w5-provider-pair-conformance` 的判据是纯机械的「**同目录** + 去掉引擎前缀后**同名**」，
而这一对是**跨目录 + 改了名**：

| 侧       | 文件                                                                   | 行数 |
| -------- | ---------------------------------------------------------------------- | ---- |
| SQLite   | `platform/persistence/sqlite/legacyResourcePackageCommit.ts`            | ~796 |
|          | `platform/persistence/sqlite/legacyResourcePackageBundleApply.ts`       | ~652 |
| PostgreSQL | `platform/persistence/postgresqlResourcePackageAtomicApply.ts`        | ~976 |

同一件事（把一个资源包的决策落成库里的行 + 盘上的工件，失败要补偿），两台机器。那条规则挡得住
「再抄一份同名文件」，却完全看不见「抄一份、换个目录、再换个名字」——**最大的那处重复正好长这样**。

### 处置一：给那条守卫补一张手工登记表

`DECLARED_CROSS_DIRECTORY_PAIRS`，带两条断言：①登记的两侧文件必须真的在树上（退役了就把这一对
删掉，那正是合一完工的样子，别留死条目）；②**手工登记的对吃同一套状态位判据**（`witnessesPair`，
与机械那批逐字相同）——登记不等于免责。

### 处置二：补对拍（RFC 自己验证过的办法：合一之前先补对拍）

`rfc359-w13-resource-package-apply-conformance.test.ts`，在两个引擎上各跑一遍同一批用户可见判据，
覆盖三种资源类型 / 四条路径：

| # | 判据                                                                             |
| - | -------------------------------------------------------------------------------- |
| ① | **工作组新建** = 归导入者 + `private` + 零 grants（AC-21）+ journal 落 `committed` |
| ② | **重放**同一个 preview token = 回执逐字相同且**不产生第二行**                       |
| ③ | **缺人员映射** = 两个引擎同一个 `package-human-mapping-missing`，且什么都没写       |
| ④ | **映射指向不存在的用户** = 同样 422，且什么都没写                                   |
| ⑤ | **agent 新建**走同一套归属 / 可见性规则（第二种资源类型）                           |
| ⑥ | agent 的**重放**也是同一条路                                                       |
| ⑦ | **凭据真值**只写进实际落地的那一行（含 `finalName` 重命名），回执不记 skippedSecrets |
| ⑧ | **凭据留空** = 该字段整个省掉、**占位符绝不落库**、`skippedSecrets` 进耐久回执      |

**16 格全绿**——这几条路径上两台机器今天给用户的结果一致，这是它第一次被证明。
⑧ 那条尤其值：占位符落库 = 用户拿到一个跑不起来的 MCP，而这在此前只有 SQLite 上被断言过。

### 为什么它仍记 `unverified`（这是判据有意的低估，不是没有对拍）

见证判据只认**直接**值 import；`w13` 与 `w12` 都只直接 import 了 PG 那一侧，SQLite 那侧是经
`services/resourcePackage/executionAdapter.ts` / `helpers/resourcePackageProvider.ts` 传递进去的。
守卫头注释的政策是「宁可低估，不要抹平」，所以**不放宽判据**；想翻成 `verified`，正解是让对拍
直接调那两个 SQLite 侧入口。这条已写进登记表的注释里，避免下一个读者被 `unverified` 误导。

**`UNVERIFIED_PAIR_COUNT` 保持 0**：那个常量钉的是十条**机械**检出的对，手工表另有自己的断言，
两者不混算——新发现一对不该被记成「覆盖回退」。

## 5dq. 「可选 + 同步端口」这一**类**已经扫干净了

§5dm 那条分叉的成因是端口写成了 `inspectHumanReview?(…): State | null`——**同步**让手里没有可同步
查询的库的那一侧实现不了，**可选**让「少实现一个方法」不红。修完之后顺手把这一类整体扫了一遍：

```
端口 / 参与者接口（public/** + */ports/** + required-ports.ts）上的可选方法：全仓 9 个
```

除掉 `inspectHumanReview` 那两条（`task-execution/public/participants.ts` 与
`digital-employee/composition/required-ports.ts` 各一条，同一件事的两面），其余 7 条都是
**按功能可选**、不是按引擎可选：

| 可选方法                                                              | 为什么与引擎无关                         |
| --------------------------------------------------------------------- | ---------------------------------------- |
| `selectAutomatic`（required-ports）                                    | 连接目录可以没有自动选择能力             |
| `upgradeProgramSourceJson` / `resolveCompatibleRevisionJson` / `resolveExternalSubjectBindingsJson` | 员工类型包各自决定要不要提供 |
| `projectInput`（execution-contract）                                   | 契约可以不投影输入                       |
| `broadcastNodeStatus` / `getCanonicalFilesChanged`（task-execution）   | 工作组宿主能力，按宿主形态可选           |

也就是说：**「一侧 composition 悄悄少实现一个可选方法」这条路径，今天只有那一处，已经堵上了。**
判它的办法是**装配锁**（把两侧都构造出来、断言 `typeof participant.method === 'function'`，
其余依赖全给 `null as never`）——行为用例覆盖不到这种缺席，因为缺席的那一侧根本走不到行为断言。

## 5dr. 两个**函数体逐字相同**的孪生（400 / open **94**），以及一条按「重跑就过了」会被放过的红

### `composeSqlite/PostgresqlWebhookTerminalWorkspacePrunePolicy`：同一台机器抄了两遍名字

```ts
export function composeSqliteWebhookTerminalWorkspacePrunePolicy(input: { db: DbClient; … })
export function composePostgresqlWebhookTerminalWorkspacePrunePolicy(input: { db: PostgresqlDatabaseClient; … })
```

**函数体逐字相同**，唯一差别是形参上那个 `db` 的声明类型——而它转交给的
`createWebhookTerminalWorkspaceAttributionQueries` 本来就收 `ProviderNeutralDatabase`。
这不是「两台机器」，是同一台机器抄了两遍名字。收成一份
`composeWebhookTerminalWorkspacePrunePolicy`，五个调用点（两个装配根 + 三份测试）同步改名。
`rfc300-terminal-workspace-policy` 随之整块双引擎。

### 迁这一份时撞到的：**插队点必须走生产自带的注入口**

`rfc300` 那条 CAS 竞态用例原本从外面包一个 db 代理来插队。迁移后它在**两个引擎上都**变成
「期望 reject、实际 resolve」——因为 termfix 把代理里那条同步 `.run()` 竞争写改成了 `await`，
而代理的 `fire()` 不 await 它。

真正的处置不是把 await 补进代理，而是**换注入口**：`setTaskStatus` 早就带着一个
`beforeCas` 回调，头注释写得很清楚——「统一事务原语不走 drizzle 的 `db.transaction`、SQLite 上
事务句柄就是 db 对象本身，从外面包 db 代理的老办法在新原语下**一次都不触发**，用例照样绿却一个
并发场景都没验」。这次正是那句话的又一次复现。

顺带把 §5dj 写的那个「两个引擎都插得进去」的代理抽成共享助手
`tests/helpers/competingWriter.ts`（挂 `update` + `transaction` 两条来路、插入点用 builder 的
`then`，所以竞争写可以是异步的），供**没有**自带注入口的 CAS 判据用。

### 一条按「重跑就过了」会被放过的红

`bd476315a` 的 CI macOS 分片 1/6 红在 `rfc322-maintenance-cadence` 的
「真正吃 CPU 的语句 cpuMs 与 ms 同量级」：实测 `ms=119 / cpuMs=45`（占比 0.38），
而判据写死 `cpuMs >= ms / 2`。**红的不是生产判别力**——那 119ms 里进程被别人抢走了 74ms。
判据把「机器有没有被别人占着」混进了被测的那件事。

改成**相对**判据：同一次探针、同一台机器上，「真在算」那条的 CPU 占比必须远高于「在等」那条
（`busyRatio > max(0.1, idleRatio * 10)`）。负载会同时压低两者，所以两条曲线离得有多远与机器负载
无关，而那正是 `[db-slow]` 里那个 cpuMs 要让运维分辨的事。本机实测 idle 0.0033 / busy 1.0000，
CI 那次的 0.38 也照样过；真出回归（CPU-bound 语句记到 cpuMs≈0）仍然红。

## 5ds. 全树扫「**函数体逐字相同**的 provider 孪生」：14 → 10（本批退役 4 对）

§5dr 那一对不是孤例。把判据写成机械扫描——**同一个 base 名、一侧 sqlite 一侧 postgresql、
函数体去掉空白后逐字节相同**——全树 162 个 provider 命名的函数里扫出 **14 对**。
它们全都只是转交给一个已经存在的中立实现，多数文件里还留着一行注释写明退役条件：

> `/** RFC-359：旧名保留为装配别名，bootstrap 收敛后删除。 */`

本批还掉其中四对（都在 `modules/integration/composition/`，一次改完同一个模块的装配面）：

| base                        | 中立目标                                | 调用点 |
| --------------------------- | --------------------------------------- | ------ |
| `WebhookDeliveryRuntime`    | `composeWebhookDeliveryRuntimeFor`      | 2 根 + 1 守卫 |
| `WebhookIngressPersistence` | `composeWebhookIngressPersistenceFor`   | 2 根 + 4 测试 |
| `WebhookDeliveryPersistence`| `composeWebhookDeliveryPersistenceFor`  | 3 根 + 1 守卫 |
| `ScheduledTaskRuntime`      | `composeScheduledTaskRuntimeFor`        | 3 根 + 2 测试 |

八个别名连同那行「bootstrap 收敛后删除」的注释一起删掉；不再被引用的
`DbClient` / `PostgresqlDatabaseClient` 类型 import 随之退出这三个文件。
`rfc359-w5-provider-runtime-exercised` 的组合根下限 80 → 76 —— **降是对的方向**，
这个数随合一持续下降；那条断言照旧贴着当前值钉，每次退役都要在那里留一次有署名的记录。

**同批第二档**又还掉四对：`CollaborationRouteOperations`（中立那份原本是**私有函数**，别名才是公开面
——把它导出即可）/ `WorkspaceMaintenanceCommand` / `ResourceCatalog` /
`EventsArchiveStore`（后者的「中立实现」本就住在 `platform/persistence/eventsArchiveStore.ts`，
`sqlite/systemEventsArchive.ts` 里那个只是再导出一次；调用方改成从owner 模块 import）。

**剩下 6 对**（下一批继续）：`CapabilityTemplateOperations` / `CodeCapabilityDemoSeedParticipant` /
`DemoResourceCatalogSeedParticipant` / `LegacyCodeReadProviders` / `RealtimeRuntime` /
`WebhookEndpointServiceDependencies`。这 6 对与前 8 对形状不同：它们**没有**现成的中立函数，
两侧的相同函数体是**内联**的，所以下一批要先把那段体提成一份中立实现再收。

**语料下限跟着降的两处**（都按各自的规矩留了署名记录，只降不升）：
`rfc359-w5-provider-runtime-exercised` 的组合根 80 → 76 → **70**；
`rfc359-w5-adapter-production-consumer` 的适配器声明分母 150 → **145**
（该文件注释里本来就记着 242 → 203 → 188 这条收敛轨迹，这次续上一档）。

**扫描脚本的判据**（可复跑）：`compose|create|make|build` + `Sqlite|LegacySqlite|Postgresql` + 同一个
base；两侧函数体 `replace(/\s+/g, ' ').trim()` 后全等。这条判据挑不出「体不同但语义相同」的那些
（那类要靠 §5dp 的成对账本与对拍），但它挑出来的每一条都是**无可争辩**的纯名字重复。

### 5ds 收尾：**14 对全部还清，并留下一条常驻守卫**

最后六对（`CapabilityTemplateOperations` / `CodeCapabilityDemoSeedParticipant` /
`DemoResourceCatalogSeedParticipant` / `LegacyCodeReadProviders` / `RealtimeRuntime` /
`WebhookEndpointServiceDependencies`）与前八对形状不同：**没有**现成的中立函数，两侧相同的函数体是
**内联**的。处置是先把那段体提成一份中立实现（形参放宽到 `ProviderNeutralDatabase`），再让两个
装配根都装它。

**扫描结果：14 → 0。** provider 命名的函数从 162 降到 135。

归零之后判据留下来当守卫：`rfc359-w5-identical-provider-twins`（AST + 六条自变异 fixture，
含「函数体真的不同 ⇒ 放行」「独苗 ⇒ 放行」「动词不同 ⇒ 不是同一个 base」三条反向格）。
再写出一对当场红，错误信息里直接给处置：**把形参放宽到中立类型、收成一份、两个装配根都装它**；
并写明「若函数体相同却确有机制差异，那说明差异根本没写在代码里，更该合」。

三处语料下限跟着降到实测值（只降不升、各留署名记录）：组合根 80 → 76 → 70 → **58**；
适配器声明分母 150 → 145 → **133**；新守卫自己的 provider 函数分母钉 **120**。

## 5dt. `447f25661` 的 macOS 红：又一条「继续加时间就错了」的判据

`rfc210-subrepo-snapshot-rollback` 的
「`hasDirtySubmoduleContent` short-circuits when `.gitmodules` is absent」在 macOS 分片 3/6 超时。
它的历史注释已经记着一次同样的红（run 33587996629，5s → 30s），这次是在 **30s** 上又超时一次
（run 34782479990）。

**继续加时间是错的方向**。被测的短路发生在 `existsSync('.gitmodules')` 上——**根本走不到 git**，
而这条用例却为了跑到那句断言真去 `git init/add/commit` 造了一个仓。把那段准备整个拿掉、改成
一个空目录：运行时间从 30 秒级变成毫秒级，而且断得**更强**——连一个仓都不存在时它照样返回 false，
证明短路确实在任何 git 调用之前。

定式已进 `docs/dev-gotchas.md`：**测试被 CI 掐红时，先问「这条断言真的需要那段慢准备吗」，
再考虑加时间。**

## 5du. AC-12：退役唯一一条**零 src importer** 的 provider 门面

孪生清零之后顺手把 T17 那 49 个 provider 命名文件逐个查了一遍「src 里还有没有人 import 它」。
只有一条是真死的：

```ts
// services/bundle/postgresqlApply.ts —— 全文四行
// RFC-349 — compatibility export for callers that have not yet switched to
// the provider-owned PostgreSQL persistence entrypoint.
export * from '@/platform/persistence/postgresqlResourcePackageAtomicApply'
```

「还没切过来的调用方」一个都不剩了——全 src 零 importer，只有三处架构账本还按路径记着它。
删掉文件与那三条账本条目；两个高水位基线跟着降一格
（`rfc349-provider-specific-business-dependencies` 28 → 27、
`rfc359-w5-provider-named-file-location` 49 → 48），各自在 `why` 里留了署名记录。

**其余 48 个都还有生产消费者**，不是「忘了删」，而是真的在装配链上——它们的退役条件是各自那一对
合一（见 §5dp 的成对账本），不是靠删门面能收掉的。这条盘点本身就是结论：
**AC-12 的剩余面与 AC-1 的剩余面是同一件事。**

## 5dv. 两台 apply 引擎**合一**：生产侧不再有 SQLite 专属的资源包写入路径（AC-1 / AC-12）

§5dp 找到并登记了本仓最大的一处重复——资源包 apply 引擎（SQLite 侧约 1448 行 / PG 侧约 976 行），
并按 RFC 自己验证过的办法**先补了 16 格双引擎对拍**（§5dp 之后扩到 22 格，第三种资源类型见上一批）。
这一批把它收掉。

### 收掉之前先问一句：这两台真的做同一件事吗

不是纸面对账，是把**同一条判据喂给两台机器**：把 `rfc359-w13` 的 SQLite 那一泳道从
`composeSqliteResourcePackageCatalogForTest`（legacy `commitResourcePackage`）换成 PG 那台原子
apply 引擎，`db` 直接传 bun:sqlite 客户端。**22 格全绿，一格没改。**

它能绿不是巧合，是这台引擎本来就没有方言：

- `createPostgresqlResourcePackageAtomicApplyOperations` 全文只经由 `dependencies.db` 走 drizzle
  query builder 与 `databaseSessionFor(db).transaction(...)`——后者正是 RFC-359 立的中立事务原语；
- 它的七臂参与者（`postgresqlResourcePackageMutationParticipants.ts` 1405 行 +
  `postgresqlResourcePackageMutationArms.ts` 1572 行）**零处**出现 `PostgresqlDatabaseClient` /
  `DbClient` / `DbTxSync`——它们拿的是外层交下来的事务句柄；
- 唯一的品牌痕迹是三个形参类型标注 `readonly db: PostgresqlDatabaseClient`（原子 apply、
  provider 组合根、能力模板写入方），改成 `ProviderNeutralDatabase` 后 `tsc` 零报错。

也就是说：**这一对从来不是「两台机器」，是一台中立引擎加一条 SQLite 专属的老路。**

### 生产侧的两个装配口一起换

`main.ts`（`package` 子命令）与 `server.ts`（HTTP）各有一个
`provider === 'sqlite' ? 装 legacy : 装原子 apply` 的三元。两边都删成一条。
PG 分支原本就需要的四件依赖**本来就在分叉之外算好**（`authorityResolver` / `pluginInstaller` /
`box` / `mcpLifecycle`），所以合一没有把 PG 的装配负担摊给 SQLite。

两处新增的接线：

- **`services/resourcePackage/pluginInstallerAdapter.ts`（新）**——插件安装绑定此前有两份：
  `main.ts` 的 PG 分支内联一份，`services/bundle/legacyResourcePackageMutationDependencies.ts`
  里 legacy 一份，**底下调的是同两个函数**（`plannedGenerationDir` / `installPlugin`）。收成一份。
  端口形状按**结构**声明、不从 composition import 类型——为一个四字段端口新欠一条
  `rfc317-module-boundary` 的边不值得，真漂了在装配点就编译不过。
- **`server.ts` 的 `ResourcePackageRouteBinding`**——写会话在 `create()` 里把 `context.authority`
  解回 Actor 并与传入的 Actor 对照，所以**目录与「造 context 的那条路」必须同源**：路由另起一条
  造 context 的路，那次对照就认不出来。把两者绑成一个对象交给路由挂载，而不是给那个 19 参的
  `composeSqliteApiRouteMounts` 再加第 20 个位置参数。

### 一处**真实的功能回归**，在合一时被逼出来：维护 Worker 的「在跑哪些 apply」

`services/bundle/apply.ts` 的模块级 `ACTIVE_BUNDLE_APPLIES` 是维护 Worker 决定
「哪些 journal 行不能回收」的输入（RFC-338）。SQLite 一旦不再走 legacy 引擎，这个集合就**永远为空**，
而调用点还在——维护会把正在执行的 apply 当成孤儿。这不是合一引入的缺陷，是合一**照出**的耦合：
那个集合本来就属于 apply 引擎，不属于一个 `services/` 的模块级变量。

处置与 PostgreSQL 那台对齐（它一直是这么接的）：apply 引擎自己实现
`ResourcePackageApplyActivityQuery`，装配把它从 `composeSqliteApplicationDeps` 带出来，
`cli/start.ts` **晚绑定**给维护服务（引擎在维护服务之后才装出来，而 payload 每个 tick 才求值）。
维护 Worker 里那份 `activitySource` 同时改成空源并写明理由：**Worker 线程不跑 apply**，
正在执行的 id 一直是主线程随 payload 送进来的（`converge({ activeApplyIds })`），
那条查询面在 Worker 里从来没有消费者。

### 退役与账本

两个 SQLite 专属装配就此**零生产消费者**，守卫当场把它们点出来
（`rfc359-w5-adapter-production-consumer`）。按「面向代码最合理优于改动最小」直接删，不进账本：

- `composeSqliteResourcePackageProvider`（`resourcePackageOperations.ts`）
- `createSqliteResourcePackageExecutionAdapter` + `SqliteResourcePackageExecutionAdapterDependencies`
  （`services/resourcePackage/executionAdapter.ts`）

测试侧跟着收：`tests/helpers/resourcePackageProvider.ts` 的
`composeSqliteResourcePackageCatalogForTest` 改成装**生产装的那一条**；
`rfc359-w12-mcp` / `w12-plugin` / `w15` / `w28` / `w12-commit-provider` 五份对拍里
「SQLite 走这条、PG 走那条」的装配分叉一并删除（各 1 处，AC-6 的引擎硬编码同步减少）。

账本变动（各带署名注释）：

| 账本 | 变动 | 原因 |
| --- | --- | --- |
| `PROVIDER_BRANCH_DEBT` 的 `main.ts` | 4 → 3 | `package` 子命令的资源包三元没了 |
| `rfc359-w5-adapter-production-consumer` 语料下限 | 133 → 131 | 两个装配退役，分母变小 |
| `rfc359-w5-provider-runtime-exercised` 的 ROOTS 下限 | 58 → 57 | 同上 |
| `rfc294-facades` / `rfc294-module-symbol-owners` | 各 +1（`allowGrowth`） | 新增插件安装绑定文件；同批退役两个装配，净账收敛 |

`rfc271-cli` 的源码锁从「`main.ts` 里含 `composeResourcePackageOperations({`」改成
「含 `composePostgresqlResourcePackageCatalog({`」，并加一条**反向**断言：那里不得再出现
`provider.provider === 'sqlite' ? …ResourcePackage…` 形状的三元。

### 合一实测出的**两处用户可见差异**

**① 覆盖别人的资源，报的码变了**（`rfc271-overwrite-ownership` ①）。两道门一个没少——引擎的归属
检查（`bundle-overwrite-not-owned`）与工作组域服务的写门（`resource-read-only`）——但**顺序不同**：
legacy SQLite 引擎先走域服务写门，统一引擎先做归属检查。也就是说 PostgreSQL 部署上这条路径
**一直**报 `bundle-overwrite-not-owned`，SQLite 上报 `resource-read-only`；合一必须二选一，
取统一引擎那一个，SQLite 从此与 PostgreSQL 同码。拒绝这件事本身不变，变的只是先报哪条理由。
（那条用例的原注释预写了这个判断：「若这里变红且实际码是 `bundle-overwrite-not-owned`……
该去确认是有意重构还是回归」——这是有意重构。）

**② 落盘半成品工件的读回格式**（新守卫 `rfc359-w14-artifact-recovery-fallback`）。
这是一处**真被引入的功能缺陷，在同一笔里修掉**：两个引擎写出的半成品工件格式互不认识
（逐条 `opId` vs `operationId`，12 格矩阵钉在 `rfc359-w5-artifact-format-portability`），
而 SQLite 的维护读回侧装的是 legacy 那一份。生产写出侧一换，**合一前留在盘上的半成品**与
**合一后写出的新工件**里必有一种读不回来——那些 journal 行会永久卡住、半成品目录永远收不掉。

处置按那条守卫自己给的形状：`composeResourcePackageApplyArtifactRecoveryChain`——先按统一格式读，
**只在 `ZodError`**（= 格式不认识）时回落到 legacy 读回侧。判据成立的前提是两个读回侧都在
**任何副作用之前**整体解码（`parseArtifacts` / `parseReceipt` 是两个入口的第一件事），
所以回落时一个字节都没动过。其它错误（路径越界、缺文件、DB 失败）原样抛出——把它们当成
「换一个读回侧再试」，第二次会在同一个坏状态上再动一次手。

四条判据先红后绿实测：去掉 `instanceof ZodError` 那行 ⇒ ③ 红；去掉整个 `catch` ⇒ ②④ 红。

### 测试侧一并接到统一引擎

`commitResourcePackage` 的 **43 个测试调用点**全部改指
`tests/helpers/resourcePackageApply.ts::commitResourcePackageForTest`——它装的就是生产装的那一条，
形参与回执形状对齐旧签名，所以那 43 条判据是**改接线、不改判据**。唯一要改的断言是
`rfc271-import-commit` 里「回给调用方的 === 落进 journal 的」那一条：journal 持久化的是引擎内部
字段名 `operationId`，用户看到的回执文档把它翻成 `opId`（`resourcePackageReceiptDocument`），
助手做同一次翻译，于是这条断言改成**把持久化那份翻一次再比**，判据本身不变。

改完之后 `commitResourcePackage` 全仓**零调用方**（只剩注释里提到它）。

### 这一批**没有**做的，以及为什么

`commitResourcePackage` 与它下面那条 legacy 链（`legacyResourcePackageBundleApply` /
`legacyResourcePackageBundleLower` / `legacyResourcePackageMutationParticipants` /
`legacyResourcePackageMutationDependencies`，合计约 3300 行）**还在**，因为它还有
**43 个测试调用点**（`rfc271-import-commit` 26 / `rfc271-roundtrip` 8 /
`rfc271-resource-package-hardening` 5 / `rfc271-overwrite-ownership` 3 / `rfc271-cli` 1）。
生产已经一处都不用它了，所以它现在是**纯测试资产**——退役的代价是把那 43 条判据改指
统一引擎，那是下一批的事（也正是 AC-6 里「卡在 SQLite-only 生产签名上」的那一大簇的解开条件：
`legacyResourcePackageCommit.ts` 里的中立助手要先搬进 `services/resourcePackage/commit.ts`，
PG 侧今天正是从那个门面 import 它们的）。

**判据先行，实现随后**——这一批的顺序是：先让 22 格对拍在两台机器上跑同一条引擎（§5dp + 上一批），
再把生产切过去。切之前那 22 格在两台机器上各绿一次，切之后再绿一次；这就是「用实测差异代替纸面对账」。


## 5dw. 合一照出一条**PostgreSQL 上一直存在**的用户可见缺陷：导入的技能要等重启才可见

§5dv 把资源包 apply 切到统一引擎之后，`e2e/config-package-import.spec.ts` 的
「两项都选新建」当场红——而它此前一直是绿的。这不是合一引入的回归，是合一**把一条只在
PostgreSQL 上跑过的代码搬到了有 e2e 的那台机器上**，于是那条路径第一次被真实用户动作打到。

### 症状与定位

回执说技能建好了、新代理也确实指向那个新技能 id、库里那一行逐字健在（`reservation_state=ready`、
`version_state=snapshot-authoritative`、owner 与可见性都对、盘上 `skills/<id>/files/SKILL.md` 也在），
但 `GET /api/skills` **一条都不返回**、`GET /api/skills/:id` 回 404。

根因是 RFC-170 §invariant④ 的启动复核门：`isSkillAvailableThisBoot` 只放行**这一 boot 验过**的技能
（`bootVerifiedSet`）。一个刚在本进程里把内容发布到位并逐字节校验过的快照按定义就是验过的，
所以发布方必须打 `markSkillBootVerified`。legacy SQLite 那条路径经 `commitSkillVersion`
顺带打了（`legacy/skillVersion.ts:269`）；统一引擎自己写版本行，**一直漏打**。

也就是说：**PostgreSQL 部署上，导入包建出来的技能一直到 daemon 重启才可见**——
回执说成功、列表里没有。恢复路径上的同一标记倒是早就在（`postgresqlResourcePackageMaintenance.ts`
与 `sqliteResourcePackageMaintenance.ts` 的 roll-forward 各一处），偏偏正常提交路径上没有。

### 处置

`resourcePackageArtifacts.ts` 的技能工件 owner：`finalizeSkillPlan` 在 live 目录换好并校验过哈希之后
`markSkillBootVerified(skillId)`；补偿路径（未提交、live 目录已换回提交前内容）对称地
`unmarkSkillBootVerified(skillId)`——legacy 那条路径的补偿段本来就这么做。

### 判据

`rfc359-w14-imported-skill-boot-visibility.test.ts`（双引擎）：**把门打开**问
（`activateBootReverifyForTest`；门关着时判据恒真、零预言力），导出一个真技能再导入，断言
①`isSkillBootVerified(新 id)` 为真、②`listSkills` 当场列出两条、③`getSkillById` 非空。
先红后绿实测：去掉那一行 `markSkillBootVerified`，两个引擎同时红。

**这条缺陷本身就是 RFC-359 的论据**：一份实现只有一台机器跑得到用户面，另一台就会悄悄比它弱，
而弱在哪要等到合一那一刻才看得见。前面几批照出的是「PG 侧零行为覆盖」；这一批反过来——
**SQLite 侧那台有 e2e，PG 侧那台没有**，于是缺陷长在 PG 那一份上。方向不同，结论同一个。

### 同批修掉的两条 CI 红（都属于「账本 / 源码锁没跟着改」）

- `rfc349-provider-completeness` 的 `main.ts` 分叉计数 4 → 3（与 `PROVIDER_BRANCH_DEBT` 是**两份**
  独立登记，§5dv 只改了其中一份）；
- `rfc345-resource-acl-facade-retirement` 的源码锁里 `return composeResourcePackageProvider(deps)`
  ——那句随 `composeSqliteResourcePackageProvider` 一起退役，判据改成反向断言「不得再出现」。

### 顺带：`legacyResourcePackageCommit.ts` 退役

`commitResourcePackage` 的调用方在 §5dv 清零之后，这个文件里只剩**七个中立助手**还有人用
（统一引擎从 `services/resourcePackage/commit.ts` 那个门面 import 它们）。把它们搬进那个门面、
让它从此是真模块而不是转发（`rfc294-facades` 的 thin-facade 名单少一条），原文件与它唯一的消费者
`sqlitePackageResourceRows.ts`（四个同步 `*InTx` 只服务 legacy 提交路径）一起删掉。
`PROVIDER_NAMED_FILE_DEBT` 48 → 47；`asPackageResourceKind` 这个**公共面**窄化点随之零消费者，
一并删掉（同名的内部版本仍在 `domain/resourceKinds.ts`）——公共面不留没人跨的窄化点。

**还没删的**：`legacyResourcePackageBundleApply` / `-BundleLower` / `legacyResourcePackageMutationParticipants`
/ `legacyResourcePackageMutationDependencies`（约 2500 行）。它们生产零调用方，但仍被
`rfc271-bundle-engine` / `rfc271-bundle-recovery-hardening` / `rfc294-apply-replay-recovery-parity`
/ `rfc359-w7-sync-transaction-cutover` 当作**通用 bundle 引擎**在测。删它们之前要逐条确认那些判据
在统一引擎上还在——§5dv 后已补了 `rfc359-w14-unified-apply-journal-replay`（journal 三态重放 + 失败终态），
剩下的（收敛 CAS、record-before-act、插件补偿 oracle、技能版本前滚幂等）要同样对账。


## 5dx. 退役通用 bundle 引擎的**前置对账**：把它锁的判据逐条搬到统一引擎上

§5dw 结尾列了一条待办：那条**通用 bundle 引擎**（`services/bundle/apply.ts` 一族，约 2500 行）
生产零调用方，但仍被四份判据当作被测对象。删它之前要逐条确认这些判据在统一引擎上还在。
本节是那份对账，以及补齐缺口。

| `rfc271-bundle-engine` 的判据 | 统一引擎上的落点 |
| --- | --- |
| I2/I3 claim 与三态重放（committed / failed / 未结） | §5dw 的 `rfc359-w14-unified-apply-journal-replay` ①②③④ |
| pre-commit 失败 ⇒ 零可见 + journal failed | 同上 ⑤ |
| I13 big tx 原子性（事务内抛 ⇒ 资源与 journal 一起消失） | `rfc359-w11-atomic-apply-neutral-transaction-conformance` |
| T12 update 目标必须归 actor 所有 | `rfc271-overwrite-ownership`（§5dv 已接到统一引擎） |
| **I5 预铸 id 早于落库（同包引用能解析）** | **本批新增** `rfc359-w14-…-journal-replay` ⑥ |
| **I8 post-commit 绝不补偿** | **本批新增** 同上 ⑦ |
| I9 收敛（10 分钟下限 / active 跳过 / committed 只前滚） | `rfc349-resource-package-maintenance`（判据在中立的 converge 命令上） |
| I7 `finalizeInTx` / I1 `serializationKey` 源码锁 | **legacy 引擎自有的概念**，统一引擎没有对应物，随代码一起退役 |

`rfc271-bundle-recovery-hardening` 的两个主题同样有落点：插件安装失败的补偿 oracle →
`rfc359-w12-plugin-publication-conformance`（7 例，含「发布与创建一起回滚」）；
已提交技能版本尾巴的前滚幂等 → `rfc359-w9-resource-package-skill-recovery-conformance`（4 例，
含「账面更新后陈旧代际不得被换回去」「已删技能不得复活」）。

### 本批补的两条

**⑥ 预铸 id 早于落库**：同一个包里 agent A `dependsOn` agent B，两条都选 `new`——B 在库里还不存在，
A 的引用只能靠引擎在 prepare 之前铸好的 id（`session.request.ids.mintCreate`）解析。
判据断言 A 的 `dependsOn` 逐字等于**这次新建的** B 的 id，不是包内 slug、也不是别的同名行。

**⑦ post-commit 绝不补偿**：数据库事务已经提交之后才抛的那一段（`afterCommitted`），
此时回滚是**错的**——资源已经对用户可见、journal 也已经是 committed，补偿会把用户看得见的东西删掉。
判据把写会话包一层、让 `afterCommitted` 抛错，然后断言：错误原样抛出、journal 仍是 `committed`
且带回执、资源仍然在库里。（这条要拿到 `mutationSessionFactory` 才包得住会话，所以它自己装引擎，
不走 `commitResourcePackageForTest`。）

两条都是双引擎，各 2 格，全绿。

### 一条如实记下的本地观测（**不是** CI 红）

把 383 个文件塞进**同一个 bun 进程**跑（`rfc271-* + rfc294-* + rfc304-* + rfc310-* + rfc345-* +
rfc349-* + rfc359-w1*`）会稳定出 8 条红，全在 `rfc310-pr9-cutover` / `rfc310 pr7b` /
`rfc349-daemon-provider-core` 这些**本批没碰过**的文件里；它们单跑绿、两两组合绿、
`rfc310-*` 全家 819 条全绿、`rfc271-*` 全家 + 那两个文件 511 条全绿。
这正是 `docs/dev-gotchas.md` 记过的那一类进程级串扰（`mock.module` 是进程级、全局 registry 不按文件隔离），
判据也是那里写的定式：「新用例本文件绿、全量红，且红的是你没碰过的文件」。CI 分片（ubuntu 12 / macOS 6）
不会产生这个组合，历史上也一直绿。**记在这里是为了不把它当成「重跑就过了」**——它没被修，
只是被归类；哪天要真查，从「哪个更早的文件污染了全局 registry」入手。


## 5dy. 通用 bundle 引擎整条退役——**AC-1 的最后一对合一完工**

§5dx 把它锁的判据逐条对到统一引擎上并补齐了两条缺口。这一批把代码删掉。

### 删了什么（生产侧 0 调用方）

| 文件 | 行数量级 | 它是什么 |
| --- | --- | --- |
| `services/bundle/apply.ts` + `platform/persistence/sqlite/legacyResourcePackageBundleApply.ts` | ~650 | 通用 bundle apply 引擎（journal / claim / 补偿 / 收敛） |
| `services/bundle/lower.ts` + `…/legacyResourcePackageBundleLower.ts` | ~330 | 把 `local:` / `external:` / `builtin:` 引用降解成 id 的那一层 |
| `services/bundle/refs.ts` | ~200 | 上面那层用的引用解析原语 |
| `aggregateAdapters/legacyResourcePackageMutationParticipants.ts` | ~1275 | 七条臂的**同步事务**参与者 |
| `services/bundle/legacyResourcePackageMutationDependencies.ts` | ~220 | 上面那份的依赖表 |
| `application/participants/resourcePackageCapabilities.ts` 的后半 | ~120 | `*InTx` 参与者构造器 + `createResourcePackageApplyTx` |
| `code-capability/infrastructure` 的 `createSqliteCapabilityTemplatePackageCommitSync` | ~20 | 同步事务里的 SQLite 专属能力模板提交臂 |

**公共面**跟着清了一大块（AC-12）：七条 `*PackageMutationParticipantInTx`、七条
`*PackageMutationParticipant`、花名册 `ResourcePackageMutationParticipants`、
`ResourcePackageEventsInTx` / `ResourcePackageAuditInTx` / `ResourcePackageApplyScenarioTx` /
`ResourcePackageApplyTx` / `ResourcePackageApplyScenarioProvider` /
`ResourcePackageApplyScenarioPlan`——统一引擎一条都不跨（编排层自己持有事务，逐臂调用模块内部合同）。
**公共面不留没人跨的合同**；七条臂的闭集判据改钉在生产在用的
`PostgresqlResourcePackageTransactionParticipants` 上，名字换了、闭集逐字不变。

### 判据怎么处置的（一条都没有「就这么删了」）

- **退役**：`rfc271-bundle-engine`（461 行）/ `rfc271-bundle-recovery-hardening`（322 行）——
  它们测的是被删的引擎，八条不变量的落点逐条列在 §5dx 的表里。
- **改指统一引擎**：
  - `rfc294-apply-replay-recovery-parity` 的资源包那一半——收敛改走中立的 converge 命令、
    重放改**真的走一次 apply**（`importId` 等于 journal `key`，命中 duplicate lookup）；
  - `rfc359-w7-sync-transaction-cutover` 只留 I14 那条源码兜底，改指生产在用的参与者文件
    （其余三条在 w11 / w14 / maintenance 上各有落点）。**先红后绿实测**：把生产那三处
    `await …recordArtifact(...)` 改成 `void`，守卫当场红；
  - `rfc304-capability-package-roundtrip` 的 lowering 那条——从「lower 出来的 payload」
    改成**落库那一行**（真导一次包，断言 `agentBySlot` 解析成目的端 agent 的 id）。更强，
    而且走的是用户真会走的路；
  - `rfc345-resource-catalog-contracts` 的两条闭集断言改钉生产那一份。
- **重新表达**：`rfc271-builtin-resolve` 里依赖 `refs.ts` 的两组单测（9 条）——新写
  `rfc359-w14-package-reference-fail-closed.test.ts`，**双引擎**、走完整用户路径
  （parse → preview → commit），四例各断言错误码 + 零副作用。

### 这次重新表达顺手照出一件事：活着那条路**拦得比退役那层更早**

旧单测直接喂 `resolveIdentityRef`，看到的是 apply 期的码（`bundle-builtin-missing` /
`bundle-ref-invalid`）。走完整路径之后实测：

- 缺 built-in ⇒ **preview 期**就报 `package-builtin-missing`，连 apply 都进不去；
- `agent.skills` 里塞 `builtin:`、`local:` 指错类型 ⇒ **parse 期**的 bundle schema 直接拒
  （`package-invalid`），根本到不了引用解析层。

不变量不但还在，而且前移了一道门。新判据因此锁「**被哪一道门拦下**」这件事本身，
而不是锁某一层的内部码——后者会把「拦得更早」误判成回归。

### 落盘工件那张矩阵的形状也变了

`rfc359-w5-artifact-format-portability` 原本是「两个写出点 × 3 kind × 两个读回侧」的 12 格。
写出点现在**只剩一个**（另一个随引擎退役），于是：

- `WRITERS` 收成一条，锚点断言改问「唯一那个写出点还在写 `preparedArtifactsJson` 吗」；
- 12 格矩阵**留着**——`sqlite` 那一族样本现在代表的是「**合一之前留在盘上的存量工件**」，
  读回侧仍然必须认得；
- **新增一条**：`composeResourcePackageApplyArtifactRecoveryChain`（§5dw 加的回落链）
  必须把两种格式都读回来。那六格 `rejects` 的正解就是它，现在有判据钉着了。

### 账本

| 账本 | 变动 |
| --- | --- |
| `DECLARED_CROSS_DIRECTORY_PAIRS` | 1 → **0**（唯一那一对合一完工；表与判据留着给下一条跨目录对） |
| `rfc349-provider-specific-business-dependencies` | 27 → 25 |
| `rfc359-w5-test-engine-hardcoding` | 400 → **398** |
| `rfc359-w5-test-engine-open-migration-debt` | 94 → **92** |
| `rfc359-w8-unnormalized-unique-insert` | 18 → 17 |
| provider 适配器语料下限 | 131 → 130 |
| `rfc294-facades` thin-facade 名单 | 少两条（`services/bundle/apply.ts` / `lower.ts`） |
| `preparedPackageMutation` 白名单 | 两个消费者 → 一个（`forkedFrom` 保留两条历史路径） |

### 删掉两份判据文件之后，「验收条款覆盖棘轮」把账算了出来

`rfc271-ac-coverage` 要求文档里每条 AC 与每条引擎不变量都在某个测试文件里**被点名**
（它只保证可追溯，不保证断言质量——所以锚点必须落在真的测了那件事的文件上）。
退役那两份文件让 **6 条 AC + 6 条不变量**失去锚点。逐条重新锚：

| 编号 | 新锚点 | 说明 |
| --- | --- | --- |
| AC-24f / AC-20 / AC-20b、I2 / I3 / I7 / I8 / I13 | `rfc359-w14-unified-apply-journal-replay` | 三态重放 / 失败终态 / 提交前不可见 / post-commit 不补偿 |
| AC-15b | `rfc359-w14-package-reference-fail-closed` | 「服务端重算，客户端传来的只是意向」——四例都是客户端塞进一个解析不出来的引用 |
| I1 | `rfc359-w52-resource-package-apply-lock` | 串行键（`actor:previewToken`）与幂等 namespace（`('package', importId)`）是两个概念 |
| AC-B4b | `rfc345-resource-catalog-contracts` | 写入会话的事务钩子——统一引擎里是 `prestage` / `bindTransaction` / `rollForward` / `afterCommitted` / `compensate`，取代了 `claimInTx` / `revalidateInTx` / `finalizeInTx` |

（棘轮的语料判据是**文件名带 `rfc271`** 或**文件头写了 `覆盖验收条款：`**，所以 `rfc359-*` 的文件
必须显式加那一行锚点，不能只在正文里提编号。）

### `rfc271-impl-gate-fixes` 的四条源码锁一并改指

P1-5（收敛器真的前滚，不是只 +1）/ P1-6（补偿没做干净不许终态化 failed；技能版本工件记全代际）
/ P2-3（每个引用槽都被解析）/ 裸控制字符清单——全部从被删的文件改指统一那条链。
P1-5 那条**改了判据本体**：PG 侧的恢复没有 `publishStagedVersion` 这个名字（那是 SQLite 侧的），
它把发布内联在 `rollForwardSkillArtifact` 里，所以锚点改成「候选目录改名成版本目录 + 暂存换进 live +
逐字节校验哈希」这三句——它们才是「真的前滚」与「只记个数」的分界。

### 还有三条「按文件路径写死」的源码锁跟着改指

`rfc359-w12-mcp-mutation-conformance` / `rfc359-w12-plugin-publication-conformance` 里那条
「四份 legacy 文件的 commit 调用都必须 await」——其中**资源包那两份**（legacy 参与者 + 依赖表）
随引擎退役，它们名下的调用点一并消失，判据收成 intent apply 那两份（它们仍是 legacy 同步形态）。
资源包侧的同一条不变量现在由 `rfc359-w7-sync-transaction-cutover` 的 I14 源码兜底与
`rfc359-w5-unattended-void-promise` 一起盯着。
`rfc271-capability-removal` 的 C5（覆盖判据是 owner，不是 exact-id、也不是角色）改指生产在用的臂。

顺带一条账本：`rfc359-w5-t19d` 的覆盖对等里 `ResourcePackageMaintenance` 从 `postgresql 3/3`
变成 `4/3`——那是 P1-5 源码锁改指统一恢复链带来的。**倒挂没有加深**：弱侧 sqlite 那 3/2 现在是
「合一前存量格式的读回侧」，由那条 12 格矩阵与新增的回落链判据一起盯着，注释里写清了这一点。

架构守卫 **691 全绿**；typecheck / lint / prettier 干净。


## 5dz. 下一对：intent apply 引擎——**先证可移植，再改判据，最后才切生产**

§5dy 收完资源包那一对之后，`PROVIDER_PAIR_CONFORMANCE_LEDGER` 里还剩 10 对同目录共存。
逐对量一下两侧行数，**只有一对是两侧都厚的真重复**：

| 对 | SQLite | PostgreSQL | 形状 |
| --- | --- | --- | --- |
| `IntentApplyOperations` | 762 | 587 | **两侧都厚——真重复** |
| `IntentApplyArtifactLifecycle` | 178 | 443 | 同上那一对的工件侧 |
| `TaskRouteOperations` | 276 | 2563 | SQLite 侧薄，已是转交形态 |
| `TaskRouteLaunchOperations` | 92 | 1339 | 同上 |
| `ChildExecutionLaunchOperations` | 94 | 739 | 同上 |
| 其余五对 | — | — | 已在账本里逐条**判不合**（迁移器 / 落盘格式 / 运行时引擎 / journal 事务包装） |

也就是说 AC-1 的剩余面基本收敛到 **intent apply 这一对**——它正是资源包那一对的姐妹
（`rfc294-apply-replay-recovery-parity` 的存在理由就是「Intent Apply 与 BundleApply 仍是两台引擎」）。

### 这一批只做前三步（不切生产）

**① 证可移植**：PG 那台引擎全文只有**一处** `PostgresqlDatabaseClient`（`db` 形参）。
改成 `ProviderNeutralDatabase` 后 `tsc` 零报错；再把 `rfc359-w7-intent-apply-operations-conformance`
的 SQLite 泳道指向 PG 那台——**14 格共同子集一格没改就全绿**。与资源包那次同一个结论：
这一对也不是「两台机器」，是一台中立引擎加一条 SQLite 专属老路。

**② 补上合一必须带的兼容面**：收敛期的 `decodeRecoveryArtifacts` 只认裸数组，而**合一之前**
SQLite 那台写下的行是带版本号的信封 `{ version: 1, artifacts: [...] }`。只认裸数组的话，
一台在合一之前起过的 daemon 留下的未结 journal 行会被判成 `intent-journal-artifact-corrupt`
而**永不终态化**——收敛器每小时看它一次、每次都拒绝，行与半成品一起永久卡住。
加一次回落（工件生命周期那一侧本来就这么做，`postgresqlIntentApplyArtifactLifecycle.ts:95`，
收敛这一侧此前漏了）。新判据 ①b 直接喂一条带版本号的行，断言它被正常补偿、落 `failed`，
且**不**记 `intent-journal-artifact-corrupt`。

**③ 三条「实测分叉」逐条同解**（原文件里那一段的标题就叫「实测分叉」，现在改名为
「此前的实测分叉（合一后逐条同解）」）：

| 原分叉 | 合一前 | 合一后 |
| --- | --- | --- |
| ① journal 工件信封 | SQLite 带版本号 / PG 裸数组 | 两侧裸数组，**且**旧信封仍读得回来（①b） |
| ③ 资源会话的中止 / 提交后尾巴 | **只有 PG 有** | 两侧都有——强侧的行为给了两边 |
| ④ 收敛的解码宽严 | SQLite 判损坏、PG 照常补偿 | 两侧同解：按 `kind` 白名单收下并补偿 |

32 格全绿（两个引擎各 16）。

### 为什么**没有**接着切生产

切生产要先收 intent 的**资源绑定**那一对（`legacyIntentApplyResourceParticipants` vs
`postgresqlIntentApplyResourceParticipants`）——PG 那台引擎要的 `resources` /`artifacts` 两件依赖
今天各有 SQLite / PG 两份装配。那是下一批，形状与 §5dv 完全一样：
先把两份装配收成一份，再删 `provider === 'sqlite' ? …` 的三元，最后退役 SQLite 那台引擎
（`sqliteIntentApplyOperations.ts` 762 行 + `sqliteIntentApplyArtifactLifecycle.ts` 178 行）。

这一批停在「判据已经证明可移植、兼容面已经补好」这条边界上，是为了让那一步的 diff 只剩装配。

## 5ea. Intent apply 引擎整条退役——**两台 apply 引擎至此全部合一**（AC-1）

§5dz 停在「已证可移植 + 兼容面已补」。这一批把剩下的三步一次做完：收资源绑定、切两个
bootstrap 根、退役 SQLite 那台。净删 **1943 行**（src：+560 / −2503），生产侧从此只有一条 intent apply 路径。

### 退役清单

| 文件 | 行数 | 去处 |
| --- | ---: | --- |
| `modules/intent/infrastructure/sqliteIntentApplyOperations.ts` | 762 | `postgresqlIntentApplyOperations.ts`（已中立化） |
| `modules/intent/infrastructure/sqliteIntentApplyArtifactLifecycle.ts` | 178 | `postgresqlIntentApplyArtifactLifecycle.ts` + 旧词汇兼容面 |
| `modules/resource-catalog/infrastructure/aggregateAdapters/legacyIntentApplyResourceParticipants.ts` | 1062 | `postgresqlIntentApplyResourceParticipants.ts` + `…ResourcePorts.ts` |
| `modules/resource-catalog/composition/legacyIntentApplyResourceDependencies.ts` | 141 | ports 工厂闭包 |
| `modules/resource-catalog/application/participants/intentApplyResourceParticipant.ts` | 61 | 提交期句柄换成 `{participant, commitSucceeded}` 的 transaction attempt |

公共面同步缩：`public/participants.ts` 去掉 `IntentApplyResourceParticipantInTx`（唯一消费者
随 legacy 一起删了），`public/types.ts` 的 `IntentResourceChangesetReceipt` 搬进 RC 自己的
infrastructure（只在 RC 的提交臂与 intent 的编排之间流动，intent 拿到它是经
`PostgresqlIntentApplyResourceSession` 这个 infrastructure 合同，不是经 `public/`）。

装配也不再按 provider 命名：`composeIntentApplyOperations` / `composeIntentApplyArtifactLifecycle`
/ `composeIntentApplyConvergence` / `composeIntentMaintenanceCommandsForDatabase` /
`composeIntentMaintenanceSnapshotQueriesFor` 各一份，两个 bootstrap 根调同一个。

### 合一取的是**并集**，不是某一侧

工件生命周期那一对当初被判「不能合」，理由三条（`rfc359-w7-intent-apply-artifact-conformance`
文件头）。第三条「能力缺口双向」**已经不成立**：

- 现行机制取 PG 那套（`skills` / `skill_versions` 行 + 目录内容哈希重推，candidate→version 的
  rename、staged 的 swap-in、托管根包含性检查、逐工件错误隔离）；
- SQLite 独有的那条——重放 `skill_operations` 账（`phase` = db-committed / fs-published / done）
  与 `finishOperation` 收尾——**原样保留**，降级成只在读到旧词汇工件时才走的兼容面
  （`rollForwardLegacySkillArtifacts` + `composeLegacyIntentSkillArtifactCompat`）。

前两条（工件词汇互不可解、前滚事实源不同）**依然为真**，而且正是兼容面存在的理由：
journal 行比进程活得久。一台跑着合一之前引擎的 daemon 在 apply 的提交后阶段崩了，库里留着
一条 `committed` 的行、工件是旧词汇；升级之后收敛器仍然要把那条尾巴走完，否则技能版本
永远停在暂存态、那条 journal 行每小时被看一次每次都前滚不了。补偿那一侧本来就已经认旧词汇，
缺的只有前滚这一半——这一批补上。

### 合一照出**三处用户可见缺陷**，全部在 PostgreSQL 那一侧

这三条都是「SQLite 上是对的、PostgreSQL 上不对」，而判据长期只喂 SQLite 那一侧——正是
`rfc359-w5-t19d` 账本里 `IntentApplyOperations: sqlite 21/3 对 postgresql 7/5` 这条**本仓最深的
覆盖倒挂**预言的形状。

**① 名字域的 dangle 容忍被写反了。** `call-workflow` / `call-workgroup` 按**名字**选目标，
而名字域的规则是 dangle-tolerant：解析不到任何行不是 ACL 违规，是启动期的问题
（`infrastructure/legacy/resourceRefs.ts` 的 `matched === undefined ⇒ continue // dangling until launch`
才是这条规则的正身）。PG 的 `assertNamedReferencesVisible` 在 `rows.length === 0` 时抛
`resource-reference-not-found`（422）。后果：**「先建调用方、后建被调方」「被调方在另一台机器上」
这两类正常用法在 PostgreSQL 上整个被堵死**，同一份 changeset 在 SQLite 上正常落库。
判据：`rfc234-apply-changeset` 的「an unresolvable name stays dangle-tolerant」。

**② 特权节点的回填整段没有。** 无 `scripts:author` / `code-host-calls:author` 的作者**看到的就是
打码后的定义**（遮蔽是 permission-blind 的），所以他原样送回来的那份里 `script` / `env` /
`dependencies`（以及 code-host 的 `params` / `request`）装的是 `INTENT_REDACTED` 占位符。
保存路径一直先按库里的现值回填再比敏感投影（`workflowPersistenceSemantics.canonicalizeUpdate`），
PG 的 intent 提交臂**直接拿用户送来的那份去比**。后果：**普通用户改不动任何含脚本节点的工作流**
——连改个描述、挪个无关节点、删个普通节点都当场 403 `script-author-forbidden`；更糟的是若放行，
占位符会被当成正文写进库，脚本正文静默丢失。修法：提交臂先 `rehydratePrivilegedNodes`，
回填后的那份既过门也写库。判据：`intent-privileged-node-capability` 的 boundary / normal 两组。

**③ in-place 改名在 SQLite 上没挡住。** v1 的产品契约是「rename 经 finalName / copy，
**in-place rename 一律拒绝**」（`design/RFC-234-intent-driven-builder/plan.md:142`；RFC-319 做 e2e 时
又独立撞出同一条并记进 `plan.md:199` ②）。PG 那台对五类资源逐个挡住；SQLite 那台**只挡了
agent 一类**，于是工作流 / 工作组 / MCP 的 in-place 改名在 SQLite 部署上一直静默生效。
这一条方向相反——**强侧是 PG**，合一取 PG。`intent-privileged-node-capability` 里那条
「普通用户可以给含脚本节点的工作流改名」正是那个缺口的化石，本批改成按契约断言拒绝，
并加一格「有 `scripts:author` 也一样拒」证明拒的是 rename 那条门、不是脚本门。

### 顺带修的一处**合一会引入**的回归

PG 引擎的 session 串行锁此前是 `createPostgresqlIntentApplyOperations` 的**局部变量**，
SQLite 那台是模块级。生产上各只装配一次，差别看不见。合一之后装配点变多了（兼容门面
`applyIntentChangeset` 每次调用现装一台），局部变量意味着**同一个 session 的两笔并发 apply
各自拿到一把自己的锁**——串行保证当场消失。改成模块级，与被退役的那台同形。
判据：`rfc343-intent-apply-correctness`。

### 「本进程在跑哪些 apply」取强侧

`composeSqliteIntentMaintenanceSnapshotQueries(db)` 读的是引擎的**模块级**集合，
`composePostgresqlIntentMaintenanceSnapshotQueries({db, activity})` 要求把**选中的那台引擎**
注进来。后者才是对的——在飞集合是进程内的围栏，不是能从 journal 行反推的东西。合一取强侧，
`server.ts` 因此多暴露一个 `intentApplyActivity`，`cli/start.ts` 晚绑定给维护服务（形状与
§5dv 的 `resourcePackageApplyActivity` 逐字相同）。

### 账本

| 账本 | 前 | 后 |
| --- | ---: | ---: |
| `PROVIDER_PAIR_CONFORMANCE_LEDGER` | 10 | **8** |
| `COVERAGE_PARITY_LEDGER` | 10 | **8** |
| `INVERTED_PAIRS` | 7 | **5** |
| `PROVIDER_NAMED_FILE_DEBT` | 47 | **44** |
| `rfc359-w8-unnormalized-unique-insert` | 17 | **16** |
| provider 命名组合根语料下限 | 57 | **48** |
| provider 适配器声明语料下限 | 130 | **120** |

### 判据的搬迁（八处按路径写死的源码锁）

合一删文件时 `tsc` 与 import 级 grep **都看不见**按路径 `readFileSync(<写死路径>)` 的锁——
§5dy 已经被这件事咬过一次（`13a72be52` 的主干红）。这一批一次性把它们全部找出来并逐条搬到
生产在用的那一份上：`rfc345-resource-catalog-contracts`(T4b 次序 + authority 同一性)、
`rfc271-mcp-owner-fence`、`rfc271-intent-skill-plugin-update`(四条)、
`rfc359-w12-mcp-mutation-conformance`、`rfc359-w12-plugin-publication-conformance`、
`rfc359-w47-intent-skill-document`、`rfc359-w9-intent-apply-sync-transaction-cutover`(I14)、
`rfc355-intent-provider-parity`。搬迁时**锁的东西一条没放宽**，只是锚点换到活的那份上；
其中 `rfc271-mcp-owner-fence` 的围栏形态确实变了（legacy 带 owner 快照进提交期比对 →
现行在事务里自己重读），注释里写清了两者挡的是同一件事。

### 留下的债

- `mcpPersistence.ts` 的 `commitLegacyMcp{Create,Update}InTx` / `prepareLegacyMcpCreate` /
  `loadLegacyMcpById` 与 `pluginPersistence.ts` 的 `commitLegacyPlugin{Create,Publish}InTx`
  **生产零消费者**了（只剩两个 conformance 用例把它们当行为夹具驱动）。删它们要先把那两个
  用例改成驱动活的提交臂，是独立的一步，不并进这一批。

### 判据搬迁顺带撞出的一条边界

`rehydratePrivilegedNodes` 要的镜头此前住在后端的 `services/privilegedNodeLens.ts`，而
`rfc349-resource-catalog-intent-apply-postgresql` 有一条边界守卫：intent 的提交臂
（`postgresqlIntentApplyResourcePorts.ts`）**不得深取 `@/services/`**。镜头与
`rehydratePrivilegedNodes` / `PRIVILEGED_LENS_TRANSPARENT` 本来就是一套东西，却隔着一层
`services/` 门面——搬进 `@agent-workflow/shared` 的 `privilegedNodeRedaction.ts`（正身旁边），
七个调用点一起受益，后端那个文件删除。入参从 `Actor` 放宽成
`{ permissions: ReadonlySet<Permission> }`——它本来就只读这一个字段。

### 双引擎判据

新增 `rfc359-w41-intent-apply-provider-parity.test.ts`（`describeEachProvider`，3 格 × 2 引擎）：
① 按名字调用一个**还不存在**的工作流 ⇒ 提交通过、定义原样落库；
①b 按名字调用一个**别人私有**的工作流 ⇒ 仍然拒（`acl-missing-refs`）、整包零落库
——这一格是 ① 的对照：容忍的只有「不存在」，不是「看不见」；
② 无 `scripts:author` 的作者省掉三个被遮蔽字段送回 ⇒ 改得动，且脚本正文 / env 按库里现值回填。

**先红后绿已实测**：把两处修复逐条回退，① 与 ② 当场红、①b 照旧绿（证明修复没有放宽可见性判据）；
恢复后 SQLite 3/3、真 PostgreSQL 3/3。

## 5eb. AC-6 的第一批**因合一而解锁**的迁移：四个 intent 用例转双引擎

§5ea 之后立刻做的事。AC-6 的账本此前卡在一个明确的理由上（plan §5do）：
「剩下的 95 个文件里……**8 个卡在 SQLite-only 的生产签名上**（intent apply / 资源包 apply /
资源上限 / 几个 `composeSqlite*` 参与者）。**继续压这个数字的正解不再是转换测试，而是逐对收
生产侧的引擎（AC-1）**——每收一对，下游那一串测试自然跟着能迁。」

intent apply 那台收完，它下游这批就能迁了。本批迁四个：

| 文件 | 行数 | 迁后 |
| --- | ---: | --- |
| `rfc343-intent-apply-correctness` | 330 | 8 → **16** 格（两引擎各 8） |
| `rfc294-apply-replay-recovery-parity` | 354 | 3 → **6** 格 |
| `intent-agent-branch-ports` | 327 | 5 → **10** 格 |
| `intent-mcp-oauth` | 289 | 4 → **8** 格 |

全部在真 PostgreSQL 上实跑通过。账本：`TEST_ENGINE_HARDCODING_DEBT` 398 → **394**、
`OPEN_MIGRATION_DEBT` 92 → **88**。

### 迁移当场照出一个**只在 PostgreSQL 上会坏**的测试助手

`intent-agent-branch-ports` / `intent-mcp-oauth` 的 `installDraft` 用的是 `.run()`——
bun:sqlite 的同步执行面。在 PostgreSQL 上 `.run()` 交出的是一个**没人 await 的 Promise**，
于是草稿行在 `applyIntentChangeset` 读它的时候还没落库，整批用例以 `intent-draft-superseded`
收场。改成 `await` 两句写之后两个引擎各自全绿。

这正是 AC-6 存在的理由的活样本：一个**看上去与引擎无关**的助手，实际只在一个引擎上成立；
不把它喂到另一个引擎上，这件事永远不会被发现。drizzle 的查询构建器是惰性 `QueryPromise`，
两个引擎上都只有 `.run()` 或 `await` 才真的执行——本仓的既有教训（`docs/dev-gotchas.md`）在
生产代码里记过，测试助手这一侧是第一次撞到。

## 5ec. AC-6 第二批：`rfc358` / `rfc293` 转双引擎（392 / open **86**）

同 §5eb 的形状，两个更大的文件：

| 文件 | 行数 | 迁后 | 备注 |
| --- | ---: | --- | --- |
| `rfc358-intent-graph-validation` | 887 | 23 → **46** 格 | 顺带修了三处 `.run()` / `.all()`（见下） |
| `rfc293-intent-state` | 608 | 7 → **13** 格 | 两个 SQLite 专属 describe 各有各的病 |

### `rfc358`：同一个 `.run()` 陷阱，第二次撞到

`installDraft` 的两句写、以及一条下游工作流的 insert 用的都是 `.run()`。同 §5eb：
在 PostgreSQL 上那是个没人 await 的 Promise。另有两处 `db.select().from(x).all().length`
——`.all()` 同样是 bun:sqlite 的同步面，中立客户端上返回的是 `Result<…>` 而不是数组，
`tsc` 当场就报（这一类比 `.run()` 好办，编译期就拦住了）。

### `rfc293`：两个 SQLite 专属 describe，病因不同

- 「native compatibility」那一格**只读一个提示词常量、压根不碰库**，却挂着一个建库的
  `beforeEach`，于是整份文件被算进「钉死在单引擎上」的账。夹具删掉即可——这一类是**账本
  虚高**，不是真债。
- 「Intent working state」的 boot 恢复那一格是真在吃库，而且与同文件里**已经是双引擎**的
  那个 `describeEachProvider` 块判据同源，只是自建了 `createInMemoryDb`。搬进去即可。

两类都值得记：前者说明 `OPEN_MIGRATION_DEBT` 里混着一部分**根本不需要迁**的文件（只要把无用
夹具删掉），后者说明同一个文件里可能**一半已迁一半没迁**——按文件计数的账本看不出这件事。

## 5ed. AC-6 第三批：两份最大的 intent 用例转双引擎（390 / open **84**）

| 文件 | 行数 | 迁后 |
| --- | ---: | --- |
| `rfc234-apply-changeset` | 1570 | 35 → **70** 格 |
| `intent-privileged-node-capability` | 1102 | 52 → **104** 格 |

这两份是 §5ea 那三处缺陷的**主判据所在**：`rfc234` 的 call-ref 那一组先红照出了「名字域
dangle 容忍写反」，`intent-privileged-node-capability` 的 boundary / normal 两组照出了
「特权节点回填整段没有」。合一当天它们只能在一个引擎上跑；现在两个引擎各跑一遍，
真 PostgreSQL 上 174/174。

### `.run()` / `.all()` / `.get()` 三件套，一次收齐

`rfc234` 里有 27 处 bun:sqlite 的同步执行面。三者的危险程度完全不同，值得分开记：

- **`.get()`（22 处）**：中立客户端上返回 `Promise`，漏 `await` 时下游取字段当场是
  `undefined`，`tsc` 基本都能拦（`'pending' is possibly 'undefined'` 之类）。
- **`.all()`（2 处）**：返回 `Result<…>` 而不是数组，`.length` 一取就编译错。**最安全**。
- **`.run()`（6 处）**：**最毒**。它返回一个没人 await 的 Promise，类型上完全合法、
  `tsc` 一声不吭，运行时那句写**根本没发生**。§5eb / §5ec / 本批连撞三次，全是这一种。

⇒ 迁移时的顺序应当是：先全文搜 `.run()`（编译器帮不上忙的那一类），再让 `tsc` 去扫其余两种。

## 5ee. AC-11：在 `948d9b5fb` 上跑了一次 `scale=full`，两条老红已清，只剩 `overview` 一条

`gh workflow run postgresql-evidence.yml -f scale=full -f evidence_suite=http-performance`
（run `34816698143`，exact `948d9b5fb`）。九个端点的实测：

| 端点 | SQLite p95 | PG p95 | PG 不劣于 | 绝对预算 | PG 在预算内 |
| --- | ---: | ---: | :---: | ---: | :---: |
| tasks-first | 137.533 | 74.761 | ✅ | 150 | ✅ |
| tasks-second | 52.688 | 49.217 | ✅ | 150 | ✅ |
| tasks-running | 86.458 | 46.823 | ✅ | 150 | ✅ |
| repos-first | 4.486 | 7.707 | ❌ | 100 | ✅ |
| repos-referenced | 8.127 | 7.394 | ✅ | 100 | ✅ |
| reviews-pending | 1.697 | 7.101 | ❌ | 10 | ✅ |
| clarify-pending | 1.503 | 2.946 | ❌ | 10 | ✅ |
| workgroup-pending | 5.488 | 4.957 | ✅ | 10 | ✅ |
| **overview** | 6.012 | **11.003** | ❌ | 10 | **❌** |

**W52 记的两条绝对失败都已清**：SQLite `tasks-first` 150.616 → **137.533**（预算 150）；
PG `workgroup-pending` 此前 max 11.571 超 10，本轮 p95 **4.957**、`pgOK` 为真。
⇒ plan 里「第一嫌疑是 `pendingRows` 的两条 `inArray`」那条**已经不成立**，那一格现在是绿的。

**只剩一条绝对失败：`overview` 在 PG 上 11.003ms > 10ms 预算**（另外三条 `repos-first` /
`reviews-pending` / `clarify-pending` 只是没过「PG 不得慢于 SQLite」这条**相对**判据，
三者的绝对预算都还有很大余量）。

### 根因不是查询代价，是**语句条数**（EXPLAIN 实测，不是猜）

`postgresql-query-profile.json` 里 `overview` 的四条任务计数**全部走
`Index Only Scan / idx_tasks_overview_counts`**，`Actual Total Time` 分别是
**0.014 / 0.017 / 0.025 / 1.571 ms**——库里真正干的活合计不到 1.6ms。而同样这四条语句的
`wallMs` 是 **7.0–7.6ms**。差出来的约 6ms/条是**客户端侧**：连接获取、编译绑定、往返、解码。

再看横向对比：`overview` 是九个端点里**语句最多的一个（22 条）**，也是唯一一个绝对预算失败的。

| 端点 | 语句数 | wall |
| --- | ---: | ---: |
| overview | **22** | 15.463ms |
| tasks-first | 21 | 118.781ms |
| tasks-running | 20 | 86.124ms |
| repos-first | 13 | 20.009ms |
| reviews-pending | 8 | 8.299ms |

（`tasks-*` 语句也多但预算宽 15 倍，所以不失败。）

### 因此下一步的方向是**减少语句条数**，不是优化 SQL

两处可收，都在共享实现里、两个 provider 同时受益：

1. **四条任务计数收成一条**（`taskOverviewQuery.ts`）。四条的 where 只差状态谓词，共享
   `visibility AND parent_task_id IS NULL AND catalog_visibility='public'`。
   用 `sum(case when … then 1 else 0 end)` 的条件聚合（`FILTER` 是 PG 语法，SQLite 3.30+
   才有，条件求和两边都稳）一次扫完 ⇒ **-3 条**。
2. **六张资源表的可见计数**（`resourceCatalogOverview.ts` 的 `countVisible` 逐类调用）
   可以收成一条 `UNION ALL` ⇒ **-5 条**。

22 → 约 14。**但这必须实测验证**：本仓规矩是「数字都是跑出来的，不是估的」，而上面这段本身
就是一次「先猜错、再被 EXPLAIN 纠正」的记录——我最初的假设是「PG 上 count 慢」，plan 数据
证明恰恰相反。改完要在新 SHA 上再跑一次 `scale=full` 才算数。

## 5ef. AC-11：`overview` 的六条资源计数收成一条 `UNION ALL`（22 → 17 条语句）

§5ee 把根因钉死在**语句条数**上。本批先收其中确定能收的那一半。

### 为什么先收资源计数、不动任务计数

两处都能收，但代价完全不同：

- **资源目录那六条**（`resourceCatalogOverview.ts` 的 `countVisible` 逐维度调用）的判据
  （`rfc359-w4-b2b-adapters`）是**行为判据**——测的是可见性阶梯（bypass / private / 仅 public），
  不测语句形状。收成一条 `UNION ALL` 不动它一个字节。
- **任务那四条**（`taskOverviewQuery.ts`）被 `rfc359-w21-task-overview-prepared-counts` 的
  **冻结 SQL 预言**盯着：`statementContract(actual) === statementContract(original)`，
  拿当前实现与一份 pre-W21 的原始实现逐句比形状。W21 当初立这条就是为了保证「模板复用这个
  性能改动**不改变可观测的语句行为**」。收四条计数会**永久废掉**那条预言，值不值得要等
  本批实测之后再判——如果 -5 条已经够把 11.003ms 压到 10ms 以下，就不必付这个代价。

### 改法

`ResourceCatalogOverviewCountPort` 加一个 `countVisibleMany`，用 `unionAll` 把六个分支拼成一条；
**每个分支的 where 逐字复用**原来那条单表路径的 `visibleRowsCondition` + `builtinCondition`，
所以可见性阶梯一个字节没变。应用层按权限先过滤维度再一次问完——**无权限的维度依旧不进查询、
依旧回 `null`**（与计数 0 是两件事，前端据此隐藏整格）。

### 判据（`rfc359-w5ef-overview-count-batching`，双引擎 3×2）

锁两件事，缺一不可：

① **数值与逐表路径逐个相等**——只锁条数不锁数值，把谓词写错也能「优化成功」；
② **六个维度只发一条语句**——只锁数值不锁条数，有人改回逐表循环、数值照样对，
   而这条判据存在的唯一理由（AC-11 那 1ms）就悄悄没了。

**变异验证已做**：把实现改回逐表循环，②当场红（`Expected: 1, Received: 6`），改回来即绿。

### 账本

`rfc294-module-symbol-owners` 24736 → 24737（新增的那个端口方法），已按规矩写上一次性
`allowGrowth` 并点名本节——**这是「加一个符号换掉五次往返」，不是加豁免**。

### 还没有的东西：实测

条数从 22 降到 17 是**数出来的**，但「因此 p95 落到 10ms 以下」还是**推算**
（墙钟 ≈ 条数 ÷ 并发度 × 均值）。按本仓规矩，这一条要在新 SHA 上再跑一次
`scale=full` 才算数。没跑之前 AC-11 仍然记为未闭合。

## 5eg. `OPEN_MIGRATION_DEBT` 这个数字的**校准**：它按文件计数，因此系统性高估

推进 AC-6 时连续撞到三类「账上是债、实际不是待办」的文件。记下来，免得下一个人把 84 当成
84 个待办：

**① 建了库但从不查库**（db 只是个不透明的构造参数）。`start-task-deps` 断言的是
`expect(withCmd.db).toBe(db)` 的**透传身份**；`rfc305-architecture-lock` /
`rfc329-mcp-surface-guard` 把 db 交给 `createApp` 只为把路由元数据注册表灌满，随后断言的是
`allRouteMeta()`。这类文件迁到双引擎是**纯粹的重复执行**，零信息量。

**② 已经是双引擎，只剩一个结构性单引擎块**。`rfc257-webhook-error-codes` 的三个 describe 全在
`describeEachProviderHttpApplication` 上，只有一个 `harness({omitDispatcher})` 还建 SQLite 库
——而它测的状态（应用composed 时**没有** webhookDispatcher）在 PostgreSQL 上**不可能存在**，
因为 `composePostgresqlApplication` 总是自己构造一个。账本看到 `createInMemoryDb` 就计一条，
看不出这个文件其实没有剩余待办。

**③ 卡在生产签名上，与测试写法无关**。`rfc268-webhook-scratch-launch` / `limits` /
`start-task-deps` 都最终落到 `StartTaskDeps['db'] = LegacySqliteTaskDatabase = DbClient`
（`services/task.ts:457`）。这类**不是**测试债，是 AC-1 的剩余面——收掉那条生产签名，
下游一串自然解锁（§5eb 已经用 intent apply 验过一次这个规律）。

### 为什么**不**给这些加豁免类目

本文件的豁免类目是**故意机械可判**的，头注释写得很清楚：人工标注会退化成「谁都能给自己新写
的那条编一个理由」。而上面三类里：①「建了库但不查」用「文件内没有 `.select(`」判会**误伤**
一大批经 `createApp` 走 HTTP 路由、内部查得很凶的用例；②「那个状态在另一个 provider 上不存在」
根本不是机械可判的命题。**放松判据的方向恰好是让数字变好看的方向**——宁可让数字偏高，
也不能让守卫失效。

⇒ 结论：这个数字**只降不升**的棘轮语义依然有效（新写一条无理由的单引擎判据仍然会让它变长），
但它的绝对值**系统性高于**真实待办量。驱动它归零的人应当按上面三类先分诊，而不是逐个硬迁。

## 5eh. AC-12 的一个被低估的收益：provider 前缀的**别名**会制造「幻觉阻塞」

并行推进 AC-6 时一个 agent 撞到并报回来的：它以为
`SQLiteRepositoryTransportCredentialRepository` 把用例钉死在 SQLite 上，查下去发现
（`modules/source-control/composition.ts:65-69`）：

```ts
export {
  DrizzleRepositoryTransportCredentialRepository,
  DrizzleRepositoryTransportCredentialRepository as SQLiteRepositoryTransportCredentialRepository,
  DrizzleRepositoryTransportCredentialRepository as PostgresqlRepositoryTransportCredentialRepository,
} from './infrastructure/repositoryTransportCredentialRepository'
```

**同一个类，构造函数收 `ProviderNeutralDatabase`，套了两个 provider 前缀的别名再导出。**
`composeSqlite|PostgresqlRepositoryWorkspaceStore` 同理，都指向 `composeRepositoryWorkspaceStore`。

全仓实测这类别名共 **39 处**（4 处类 / 仓库 + 35 处 `compose|create` 函数，集中在
`modules/collaboration/composition.ts`、`modules/memory/composition.ts`、
`modules/source-control/composition.ts`）。

### 为什么这比「命名不好看」严重

AC-6 的迁移者看到 `Sqlite` 前缀的第一反应是「这条路被钉死了，我被阻塞了」——而实际上那就是
中立实现。**一个误导性的名字会让一次本该成功的迁移被错误放弃**，而且放弃得毫无痕迹
（不会有任何守卫红）。本轮就真实发生了一次，只是那个 agent 多查了一层才没上当。

⇒ AC-12 的「provider 命名文件/符号归零」不是洁癖，它在**给 AC-6 清障**。这 39 处是其中最廉价
的一批：删掉别名、把调用方指到中立名即可，零行为改动。

（**注意区分**：`composePostgresqlAgentLaunchResourceOperations` 这类**签名真的不同**的不在此列
——它收 `PostgresqlDatabaseClient` 且要注入 catalog participant，与 `composeSqlite…` 是两个
不同的入口，不能一并删。判据是「别名指向同一个符号」，不是「名字里有 provider」。）

## 5ei. AC-6 第四批：四路并行迁移 13 个文件（378 / open **72**）

用四个并行 agent 按互不重叠的文件集推进（webhook / 资源包 / 任务执行 / provider 适配器四族）。
账本 `TEST_ENGINE_HARDCODING_DEBT` 390 → **378**、`OPEN_MIGRATION_DEBT` 84 → **72**。
十四个文件合跑真 PostgreSQL **188/188**。

| 结果 | 文件 |
| --- | --- |
| 迁移完成（13） | `rfc259-webhook-github-e2e` `webhook-trigger-validation-acl-order` `rfc201-plugin-exact-operation` `rfc271-export-fence-http` `rfc271-import-http` `rfc271-overwrite-ownership` `rfc349-frozen-source-request-writes` `rfc285-b3-inherited-actor` `rfc269-code-host-wiring-2026-08-10` `rfc207-runtime-accounting`(7/9 格) `rfc258-file-symbols` `task-file-content` `worktree-files-proxy` |
| 本来就已双引擎 | `rfc257-webhook-error-codes`（见 §5eg 第②类） |
| 卡生产签名 | `rfc268-webhook-scratch-launch` ⇒ `StartTaskDeps['db'] = LegacySqliteTaskDatabase`；`rfc207` 剩下那 2 格 ⇒ `composeLegacySqliteResourceLimitOperations` → `cancelTask(db: LegacySqliteTaskDatabase)` |
| 判不适用 | `rfc349-execution-peripheral-provider`——它的**被测物就是两个 provider 各自的适配器**（一个收裸 db、一个收 `PostgresqlDatabaseClient` + 注入的 catalog 参与者），不是同一入口的两种跑法 |

### 并行的几条纪律（有效，值得复用）

文件集**互不重叠**；agent 只改自己那几个测试文件，**不碰账本、不碰 `architecture/**`、不碰
`src/`、一律不跑 git 写命令**（共享 index 会被并发 `git add` 搅乱）、**不跑全量套件**（会把彼此
的时序判据压垮）。账本与提交由主 agent 统一收口。撞到生产签名就**原样还原那个文件**并报回
签名全路径——不许改 `src/` 绕过。

### 这一批带回来的三个发现

**① 迁移者会被 provider 前缀的别名骗**——已单独落 §5eh（39 处别名指向中立实现，制造「幻觉阻塞」）。

**② 直接写 `tasks` 的测试夹具必须自己填 lineage 两列**，因为 SQLite 的
`rfc328_tasks_lineage_after_insert` 触发器**在 PostgreSQL 上按设计不存在**。这**不是缺陷**：
`application/buildNodeRunMintRecord.ts` 的注释写清了裁决——「触发器天生属于一个方言，DDL 投影
里再造一份 plpgsql 只会让『同一条规则两处写』从一个引擎变成两个」，所以推导搬进应用层纯函数、
由架构守卫要求每个插入点显式写两列，**守卫对两个引擎同时生效，触发器不能**。
迁移直接写 `tasks` 的夹具时照做即可。

**③ 一个文件里可能一半已迁一半没迁**：本批四个文件中有三个早前批次已经加过
`describeEachProvider('provider cases 1', …)` 块、旁边还留着原生 describe。按文件计数的账本
看不出这件事（§5eg 第②类的另一种形态）。`worktree-files-proxy` 甚至有**五个**同名 describe
注册点（3 provider + 2 native），合并成一个之后 13 格 → 26 格而总耗时不变——每个注册点都要
付一次 `CREATE DATABASE` + 全量迁移的开销。

## §5ej —— AC-6 第二波并行（4 agent × 4 文件）与 AC-11 的真正根因

### AC-6 第二波结果

| 结果 | 文件 |
| --- | --- |
| 迁移完成（9 文件 / 15 调用点） | `rfc257-webhook-ingress` `rfc294-background-worker-boundary` `terminal-maintenance-watermark-coverage` `rfc165-workspace-gc` `rfc307-demo-seed` `rfc238-mcp-runtime-test-real-e2e` `rfc271-export-closure-authz` `rfc291-commit-auto-mount` `rfc291-commit-then-update` |
| 部分迁移（其余判据有据留单引擎） | `rfc291-closure-call-edges`（AC-14 对拍锁的是 `freezeCallClosure(db: DbClient)` 这个**具体函数**，换成中立替身等于换掉被测物）；`rfc291-unavailable-mount`（两条是 bun:sqlite **同步** client Proxy 故障注入，PG 上 `.run()` 不定序，判据会退化成掷骰子） |
| 本来就已双引擎 | `rfc311-task-page-fastpath` `rfc189-wg-round` `rfc359-w7-catalog-composition-roots` |
| 卡生产签名 | `rfc269-webhook-code-host-context-e2e` ⇒ `buildStartTaskDeps(db: LegacySqliteTaskDatabase)` / `startExecution(db: StartTaskDeps['db'])` |
| 判不适用 | `rfc349-websocket-provider`——同 §5ei 的 `rfc349-execution-peripheral-provider`，被测物是两个 provider **各自的 client**，真引擎等价性已由 `rfc359-w7-realtime-store-conformance` 双引擎覆盖 |

账本：`TEST_ENGINE_HARDCODING_DEBT` 378 → 369，`OPEN_MIGRATION_DEBT` 72 → 63。

**这一波抓到一条真的假绿**：`rfc271-export-closure-authz` 的「导出中途注入写」Proxy 在
PostgreSQL 上**从来没触发过**——读口在 `databaseSessionFor(db).serializable()` 里发查询，
SQLite 的 `createSqliteDatabaseSession` 用 `const tx = db`（Proxy 顺带进事务），PG 的
`db.transaction()` 交回的是**另一个对象**，钩子被整个绕开；而 6 处注入写又都是 `.run()`
（PG 上是没 await 的 Promise）。四条「必须成功」的用例本会在 PG 上静静变绿。修法是拦
`transaction` 并重包 tx 句柄 + 让被拦读的 builder 的 `then` 先 await 那笔写，并补一个
`fired()` 计数器把「seam 真的触发了」本身变成判据。

### AC-11：恒定 +6 的根因，以及它不在 SQL 里

`scale=full` 实测（run `34816698143`，`948d9b5fb`）的验收判据是
`scripts/perf-compare.ts:347` 的 `postgresqlNoSlower: right.p95 <= left.p95`——**零容差**，
九个端点逐个都要 PG 不慢于进程内 SQLite。九格里四格红：`repos-first`、`reviews-pending`、
`clarify-pending`、`overview`。

按端点数语句（口径同 `perf-query-profile.ts`）后，根因与「某条 SQL 慢」无关：

| 端点 | SQLite | PostgreSQL（修前） | PostgreSQL（修后） |
| --- | --- | --- | --- |
| tasks-first | 17 | 22 | 18 |
| tasks-second | 8 | 14 | 10 |
| tasks-running | 17 | 23 | 19 |
| repos-first | 10 | 16 | 12 |
| repos-referenced | 8 | 14 | 10 |
| reviews-pending | 5 | 11 | 7 |
| clarify-pending | 5 | 11 | 7 |
| workgroup-pending | 7 | 14 | 10 |
| overview | 14 | 20 | 16 |

PG 在**每个**端点上恒定多 6 条，来源钉死：`postgresqlDatabaseClient.ts` 的 `withWriteFence`
给每笔**非事务写**都要 `BEGIN` + 世代围栏 `SELECT` + 写 + `COMMIT` 四个往返，而每个认证请求
固定带两笔这样的写——`token_audit` 插入与 PAT 的 `last_used_at` 更新。2 × 3 = 6。
于是 `reviews-pending` 这种只读端点 11 条语句里 **8 条是认证记账**，真业务查询只有 1 条。

**其中一笔是可以直接摘掉的缺陷**：`d275618a5`（2026-08-28，"bound session activity writes"）
给**会话**解析加了 `SESSION_LAST_USED_WRITE_INTERVAL_MS` 窗口，那一刀**只改了会话**，
PAT 侧没跟上——同一个文件 `auth/infrastructure/authPersistence.ts` 里两条同构路径就此分叉：
`resolveSessionByHash` 带窗口，`resolvePatByHash` 每请求无条件写。性能语料正是用 PAT 认证的，
所以九个端点全都在付这笔钱。

修法是把 PAT 纳入同一条窗口（常量随之改名 `AUTH_LAST_USED_WRITE_INTERVAL_MS`，它不再只管会话），
**两个引擎同时受益**：PG 每端点 −4 条、SQLite −1 条。

**一个必须单独放行的空值**：PAT 的 `last_used_at` 可空（`schema.ts` 无 `.notNull()`，会话侧不是）。
照抄会话侧的 `now - lastUsedAt >= interval` 会算出 `NaN`，`NaN >= 1000` 恒假，
**从未使用过的 PAT 将永远记不下首次使用**。`rfc359-ac11-pat-touch-throttle` 的第 ① 条就锁这个。

**剩下的结构性事实**（未再动刀，留给后续裁决）：另一笔 `token_audit` 插入仍是每请求一笔
写事务（4 个往返）。而即便把它也摘掉，`reviews-pending` 这类端点的 PG 绝对值仍难压到
进程内 SQLite 的 1.5–1.7ms 之下——库里真正干的活不到 0.02ms，差额全是进程外引擎的往返本身。
`right.p95 <= left.p95` 这条零容差判据对这类**微端点**是否是正确的验收口径，需要单独裁决；
真实负载的三个重端点（`tasks-first` 137→75ms、`tasks-running` 86→47ms）PG 是**快约一倍**的。

## §5ek —— AC-6 第三波并行（4 agent × 3 文件）与 AC-12 的 intent apply 改名

### AC-6 第三波结果

| 结果 | 文件 |
| --- | --- |
| 迁移完成（10 文件 / 25 调用点） | `rfc244-task-operations` `lifecycle-wrapper-nested` `commit-push-runner` `rfc257-webhook-e2e` `reviews-comment-patch` `rfc311-repos-page` `clarify-baseline-rest-ws` `rfc309-template-upstream-wiring` `rfc310-pr9-cutover` `skill-zip-commit` `rfc271-resource-package-hardening` |
| 部分迁移 | `workflows`——两条 `SQLite validation compatibility` 卡 `legacy/workflow.validator.ts:430` 的 `validateWorkflowById(db: DbClient)`；**它底下调的全是中立的**（`getWorkflow` / `loadWorkflowValidationContext(db: ProviderNeutralDatabase)`），整个阻塞就是那一行标注 |

账本：`TEST_ENGINE_HARDCODING_DEBT` 369 → 359，`OPEN_MIGRATION_DEBT` 63 → 53。三条「语料非空」
门槛随之下调并各记一次实测值（116 / 47 / 114）——**它们掉到门槛以下不是判据坏了，是分母在收敛**。

**第二条真的假绿，而且三种模式全中**：`rfc271-resource-package-hardening` 的两个手写
`Proxy`-over-`db` 故障注入 seam 在 PG 上都被事务绕开（模式③），注入写用的是 `.run()`（模式①），
还有一处断言拿没 await 的 `.get()` 去 `toBe`（模式②）。改完做了**变异验证**：只停掉 `transaction`
那一支拦截，两条围栏用例在 PG 上立刻变成 `Received: undefined`（注入没发生、导出成功、没有错误码）
——证明 tx 重包是承重的，且新加的 `fired()` 计数器确实能把回归抓成红而不是放过去。
同一族的 `rfc271-export-closure-authz` 上一波刚修过同样的病，说明**这是族群性缺陷，不是个例**。

### 两条 harness 语义差异（迁移时必踩，已进 `docs/dev-gotchas.md`）

① **`createInMemoryDb` 每次调用给一个全新库，harness 给的是同一个库 + 用例间 TRUNCATE。**
所以「一个 test body 里 seed 两次」的用例在 harness 下会撞主键（`reviews-comment-patch` 两处）。
处置是给每次 seed 一组带序号后缀的 id，而不是去动判据。

② **后台轮询器必须在 `afterEach` 里兜底停掉。** 原来的写法把 `stop()` 放在 test body 最后一句，
用例一旦失败就会有个 `setInterval` 活着跑进下一个用例的整库 TRUNCATE（harness 头注释里记的
40P01 场景）。`stop()` 本身幂等，加兜底不影响原有调用。

### AC-12：intent apply 五个文件改名去 provider 前缀

§5ea 合一时 legacy 侧整条退役（`legacyIntentApplyResourceParticipants` 1062 行 +
`legacyIntentApplyResourceDependencies` 141 行 + 两个 `sqliteIntentApply*` 共 940 行），
PG 侧那几个文件因此成为**两个 provider 唯一的实现**——provider 前缀就此名不副实，
正是 AC-12 修订第三款要消灭的第②类。本刀改名（51 文件 / 278 处标识符）：

| 旧 | 新 |
| --- | --- |
| `infrastructure/postgresqlIntentApplyOperations.ts` | `infrastructure/intentApplyEngine.ts` |
| `infrastructure/postgresqlIntentApplyArtifactLifecycle.ts` | `infrastructure/intentApplyArtifactLifecycle.ts` |
| `aggregateAdapters/postgresqlIntentApplyResourceParticipants.ts` | `aggregateAdapters/intentApplyResourceParticipants.ts` |
| `aggregateAdapters/postgresqlIntentApplyResourcePorts.ts` | `aggregateAdapters/intentApplyResourcePorts.ts` |
| `aggregateAdapters/postgresqlIntentApplyArtifactOwners.ts` | `aggregateAdapters/intentApplyArtifactOwners.ts` |

`PostgresqlIntentApplyOperations` 去前缀会与既有端口 `IntentApplyOperations` 撞名，故改叫
**`IntentApplyEngine`**（连同 `…EngineRequest` / `…EngineDependencies`）——它本来就是端口之上多带
`converge` / `activeJournalIds` 的那台引擎，名字比「又一个 Operations」更准。

改名顺带销掉一处**重复类型声明**：`IntentApplyRecoveryArtifact` 在引擎文件里是本地 `type`、
在 lifecycle 文件里是导出 `type`，两处定义逐字相同。现在引擎文件导出它、lifecycle 改为 import
再 re-export，单一事实源。

账本：`PROVIDER_NAMED_FILE_DEBT` 44 → 39。T17 里那段把 intent apply 判成「真分叉、孪生顶着
`legacy*`、体量 2397 : 2761」的裁决注释**已经过期**，一并改写成销账记录——留着它会让下一个人
按早就不存在的 legacy 侧行数去推导一次已经做完的合一。

## §5em —— AC-11 的第二刀：单行 INSERT 的世代围栏内联；AC-6 第五波

### AC-11：`fire-and-forget 所以不要紧` 是错的

§5ek 收尾时我判断「`token_audit` 插入是 `void` 派发的、不在关键路径上，不值得动」。**这个判断是错的**，
而且是被实测推翻的（本机 Docker PG，`/api/reviews/pending-count`，40 次取 p95）：

| | 带审计写 | 关掉审计写 |
| --- | --- | --- |
| SQLite p95 | 3.76ms | 3.06ms（−19%） |
| PostgreSQL p95 | **18.11ms** | **5.57ms（−69%）** |

`void` 派发让它**不占延迟**，但它**占并发度**——那笔写 reserve 出一条池连接跑四个往返
（`BEGIN` / 围栏 `SELECT` / 写 / `COMMIT`），把后面的请求挡在池外。而同一笔写在 SQLite 上只有
一条语句，所以这个开销是 PG 独有的四倍差。

**处置：把围栏折进 INSERT 自己**，于是非事务单语句写从四个往返降到一个：

```sql
insert into T (列…) select $1, null, $2, … 
where exists (select 1 from "agent_workflow_meta"."database_generations"
              where generation_id = $n+1 and state = 'active')
```

语义逐字不变：单语句本身原子，围栏活跃则插 1 行、不活跃则插 0 行，而普通单行 INSERT
**必然影响 1 行**，所以 `changes === 0` 与围栏失败一一对应，不需要显式事务。

**只吃最窄的一类**：整条命中 `insert into T (列…) values (…)`、单行、每个值是裸 `$k` 或
drizzle 为未赋值列内联的字面 `null`、无 `on conflict`、无 `returning`、无子查询。凡有一条不符
就回到原来的四往返路径——不猜、不改写复杂 SQL。另外三个前置：非事务、`run`、本进程已给这一代
记过首次写（否则 `markFirstGenerationWrite` 仍要与写同事务）。

**实测结果**：

| | 折叠前 | 折叠后 |
| --- | --- | --- |
| PG 每请求语句数（awaited） | 7 | **3** |
| PG p95 | 18.11ms | **4.96ms（−73%）** |
| PG / SQLite 比 | 4.8× | **1.69×** |

判据 `rfc359-ac11-insert-fence-fold` 锁四件事：① 写照样落库、两引擎同结果；② PG 上这笔写只发
**一条**语句；③ 不该折的形状（`on conflict` / `returning`）原路走且行为不变；
④ **世代被退休后，走快路径的那笔写照样被拒**——并断言那次拒绝发生在**折叠后的那一条**上
（`toHaveLength(1)`），否则证明的是老路径还在、不是新路径安全。

### AC-6 第五波（4 agent）

5 个文件转双引擎：`rfc234-turn-engine` `rfc328-durable-ownership`
`rfc310-employee-workspace-delivery` `rfc310-pr3-journey`
`rfc310-digital-employee-conflict-system-mock-e2e`。账本 351 → 346 / 45 → 40。

**`rfc234-turn-engine` 的 seam 是双重失效的**：它 `db.run = …` 直接改客户端，而 PG 客户端本身
是个带 `get` trap 的 `Proxy`（`postgresqlDatabaseClient.ts`），赋值被静默遮蔽；就算不遮蔽，
`createPostgresqlDatabaseSession` 走 `db.transaction(...)`，客户端的 `run` 在那笔事务里**根本不会
被调用**（SQLite 侧则是在客户端上 `db.run(sql.raw('BEGIN IMMEDIATE'))`，所以一直有效）。

**一条方法论**（已进 `docs/dev-gotchas.md`）：变异验证要挑**读点**，别挑写点。去掉某个
`INSERT` 的 `await`，PG 道可能照样绿——那个没人等的 promise 在后续若干个 `await` 掉的
git / 文件系统操作期间自己 settle 完了。可靠探针是去掉断言前那次**读**的 `await`。

### AC-6 的剩余面（45 → 40 之后逐条核过）

| 类别 | 数 | 说明 |
| --- | --- | --- |
| 还能迁 | 2 | `rfc310-digital-employee-authoring`(3400 行) `rfc310-digital-employee-system-mock-e2e`(2485 行) |
| 卡生产签名 | 4 | `limits` `rfc097-task-status-cas` `rfc207-runtime-accounting` `rfc349-task-execution-provider-adapters` |
| 已裁决（有据单引擎 / 本就双引擎） | 16 | |
| 不查库 / helper | 18 | |

那 4 条全部卡在同一处：`LegacySqliteTaskDatabase = DbClient`，而它的实质是
**`src/services/task.ts`——7696 行、45 个导出函数、34 个 bun:sqlite 同步执行点**。
这不是前面几刀那种「一行标注放宽」，是一次真的 sync → async 迁移，会动任务生命周期的时序，
**应当单独立一刀**，不在本波顺手做。

## §5en —— AC-6 第六～八波；以及最后那道阻塞的**真实尺寸**

### 第六～八波结果

| 波次 | 文件 | 结果 |
| --- | --- | --- |
| 六 | `rfc310-digital-employee-authoring`(3400 行) | 25 → 50 格 |
| 六 | `rfc310-digital-employee-system-mock-e2e`(2485 行) | 1 → 2 格 |
| 七 | `rfc210-commitpush-{subrepo,nested-precommitted,untouched-subrepo}` | 各转双引擎 |
| 七 | `rfc310-pr6-pipeline-adapter` / `skills-import-zip-http` | 转双引擎 |
| 七 | `rfc338-maintenance-status` | 2 → 4 格（注入口经作用域补上） |
| 七 | `rfc323-platform-pipeline-collection` | 18 格（**一个字没改**，见下） |
| 八 | `rfc321-repository-publication-system-mock-e2e` | 1 → 2 格 |
| 八 | `rfc349-digital-employee-platform-tools-wiring` | 判不适用（被测物是 SQLite 根的可选注入点本身） |

账本 346 → **336** / open 40 → **30**。

### 一次**错误归因**的完整复盘（值得记，因为它骗过了我）

`rfc323` 与 `rfc338` 都报了一格 `(unnamed)` 的
`PostgresError: Connection closed`。我据此做了一次「三步隔离、每步只改一个变量」，得出
「覆盖 `provider.telemetry` 会泄连接」的结论，写进了 `docs/audit-backlog.md` 并推了上去。

**结论是错的**。真相是 `aw-rfc359-pg` 容器**磁盘写满**、正在 PANIC 重启：

```
ERROR:  could not extend file "base/…": No space left on device
   STATEMENT: truncate table "agent_workflow"…   ← harness 的 beforeEach
PANIC:  could not write to file "pg_logical/replorigin_checkpoint.tmp"
LOG:  checkpointer process was terminated by signal 6: Aborted
```

服务器恢复后把**一模一样**的改动再跑一遍：全绿、零 `(unnamed)`。`rfc323` 则是**本来就对的**，
我白白把一个健康文件隔离了。

**为什么隔离法会骗人**：它的前提是混杂因素**恒定**，而当时的混杂因素（服务器反复崩溃重启）
是**非平稳**的，于是不同变体之间的差异全是噪声，被读成了因果。
**定式：动手隔离之前先确认环境健康，隔离之后再把基线复测一遍。**

**低成本判别**：单跑 PG 道（`AW_TEST_PROVIDERS=postgresql`）。得到 `0 pass / 1 fail` ⇒
一个用例体都没跑 ⇒ 只可能是 `beforeAll` 失败 ⇒ 环境问题。真是「漏了 await、promise 在池关掉后
reject」的话，前面的用例会正常跑过、计数不会是 0。这两条都已落 `docs/audit-backlog.md`。

### 最后那道阻塞：`LegacySqliteTaskDatabase`，尺寸比我先前说的小得多，但**不是**机械改动

我先前把它描述成「`src/services/task.ts` 7696 行 / 34 个同步点」——**那个框定太悲观**。
按函数归位之后：

| 同步点 | 函数 |
| --- | --- |
| 17 | `startTaskImpl`（启动路径，真正的硬骨头） |
| 5 | `runDeferredRepoPreparation` |
| 2 | `cancelTask`（其中一处**本来就 await 了**，实际只有 1） |
| 0 | `resumeTask` / `retryNode`（**纯标注阻塞**） |

`enforceLimits` 根本不在 `task.ts`（在 `services/limits.ts`，且该文件**零** `DbClient`）；
`startTaskDeps.ts` 同步点也是零。

**实测探了一刀**：把 `cancelTask` / `resumeTask` / `retryNode` 三个签名放宽，`tsc` 只报 6 条，
其中 3 条只是名字没对上——该文件早就 import 了 `LegacyProviderNeutralDatabase`（它就是
`ProviderNeutralDatabase` 的别名再导出，`getTask` 已经在用）。换成这个名字后 `src` 全清。

**而这恰恰是陷阱**。`cancelTask` 剩的那处同步读是 `.all()[0]`，在中立句柄上**照样编译通过**、
在 PG 上返回 Promise ⇒ `[0]` 是 undefined ⇒ 任何取消都报 `task-not-found`。正是模式①。
更关键的是它旁边的注释写明了那是**故意的**：

> Bun SQLite can do this preflight synchronously, preserving the legacy rejected-Promise API
> while allowing the no-controller path to register its FIFO mutation slot before this function
> first yields.

同步预检是**承重**的：它让 `cancelTask` 在第一次 yield 之前就同步拒绝，并让无控制器路径抢到
FIFO 变更槽。改成 `await` 就改变了「函数何时第一次让出」，也就改了那条排序契约。

**所以这一刀已探明但没有做**：它不是放宽一行标注，是要先把 FIFO 排序契约弄清楚再动——
应当单独立一刀、带自己的并发判据。探测改动已原样还原。

## §5eo —— 最后那道阻塞：**实测证伪了我自己的两次判断**，现在有确切的红

§5en 里我写「`cancelTask` 的同步预检承重，应当单独立一刀」。随后我又反过来怀疑那条注释**已经过期**，
理由看起来很硬：RFC-359 自己把 `reviewMutationCoordinator` 统一成了两个引擎同一条**异步**入队路径，
它的注释白纸黑字写着「此前 SQLite 有一条同步 `findTaskIdSync` 入队捷径，PostgreSQL 从来没有」；
而「cancel 赢」的合同（`rfc097-cancel-wins` 合同 1）明写是靠 **CAS 的 from-集互斥 + 调度器的
`signal?.aborted` 终检**，不是靠入队顺序。

**照这个推理改了，然后被测试打脸。** 把预检改成 `await` 之后：

```
(fail) review mutation vs task cancellation linearization
       > cancel first makes a queued comment update leave comment rows untouched
       > cancel first makes a queued comment delete leave comment rows untouched
       > cancel first makes a queued selection leave both selection fields untouched
8 fail
```

**为什么我错了**：CAS 互斥管的是 **cancel vs done**；`review-cancel-concurrency` 锁的是
**cancel vs 评审变更**——那一组的「谁先」**只能**由入队顺序决定。而
`withTaskReviewMutationLock` 开头那句 `if (inflightScopeLookups.size > 0) await …`
恰恰在「有评审请求正在异步解析作用域」时为真，也就是这组用例的场景：
此刻 cancel 能不能抢在前面，取决于它到 `enterTaskQueue` 之前**有没有让出**。
同步预检就是让它不让出的那一步。注释是准的，过期的是我的推理。

**另一处我也说小了**：§5en 说 `resumeTask` / `retryNode` 是「纯标注阻塞、零同步点」。
那是**按函数体**数的，**传递闭包不是**——`resumeTask` 转手 `resumeKick(db, …)`、
`retryNode` 转手 `assertChildTaskDrivable(db, …)`，两者仍要 `DbClient`。放宽签名后 `tsc` 立刻指出这两处。

### 结论（现在有实证，不再是判断）

这道阻塞**不是**放宽一行标注，是要**重新设计 cancel 与评审变更的线性化点**，让
「先发出者先入队」不依赖调用方同步。按本仓 T28 的纪律，这一刀必须
**先写双引擎并发用例把错的结果演出来（红）、再改（绿）**——上面那三条红正好就是那份红，
现成的，`tests/review-cancel-concurrency.test.ts` 里。

探测改动已全部原样还原（`git checkout -- src/services/task.ts`），
相关五个套件复跑 **123 格全绿**。

## §5ep —— 那道阻塞**不是方向决策**：取号与入队解耦，`cancelTask` 转中立句柄

§5eo 结尾我写「需要重新设计线性化点……语义方向由用户定」。**那个框定是错的。**
被保留的语义（「先发出者先入队」）**一个字都不用改**——要改的只是「顺序信息从哪里取」。

### 原来的机制为什么只在 SQLite 上对

两条入口本来就不对称：

· **评审侧**（`withReviewNodeMutationLock`）**同步登记**自己的位置——
  `inflightScopeLookups.add(tracked)` 发生在 `lookup` 之前，与它随后 await 多久无关；
· **取消侧**（`withTaskReviewMutationLock`）没有等价物，它的顺序**只能靠调用方
  在到达本函数之前一次都不让出**来保证——而那恰恰**只有 bun:sqlite 同步读做得到**。

所以 `cancelTask` 的同步预检不是「取消自己的优化」，是**整条排队规则的隐式前提**。
这正是 RFC-359 要消灭的形态：同一段代码在一个引擎上对、另一个上错。

### 改法：把「取号」从「入队」里拆出来

`reserveTaskReviewMutationSlot(taskId)` 在**调用的那一刻**同步定下排队位置，返回「轮到我时跑 fn」：

| 取号时的事实（**同步可判**） | 处置 |
| --- | --- |
| 没有在途的评审作用域解析 | 我是当前最先发出者 ⇒ `claimTaskQueueSlot` **同步占住队尾**，后来者都排我后面 |
| 有在途解析 | 那些评审**比我先发出** ⇒ 等它们落队，我再登记 |

`claimTaskQueueSlot` 是原 `enterTaskQueue` 的**同一份**逻辑，只把「登记队尾」与「等前一位」拆成两步；
`enterTaskQueue` 现在就是「登记后立刻等」，同步调用方的行为逐字不变。

`cancelTask` 于是变成：**先取号 → 再 await 前置读 → 用号入队**，签名放宽到中立句柄。

### 两次「先红后绿」

① **改之前**（只把预检 await、不拆取号）：`review-cancel-concurrency` 三条 `cancel first …` 全红——
   这就是 §5eo 记的那份红，证明顺序契约是真的。拆出取号之后 **20 格全绿**。

② **改之后的变异验证**：把 `cancelTask` 的那个 `await` 去掉、**保留**取号，
   `rfc207` 的 PG 道立刻红（`accumulated running time over maxDurationMs makes enforceLimits cancel`），
   SQLite 道照绿——正是「在 SQLite 上绿、在 PG 上什么都没测」的签名。说明新判据确实咬住了这个缺陷。

### ~~顺带销掉的真缺陷~~ —— **这句我写错了，撤回（当天核实）**

上一版在这里写「在这一刀之前 **PostgreSQL 上的资源限额取消是坏的**」。**不成立。**
PG 守护进程走的是 `composePostgresqlResourceLimitOperations`
（`cli/postgresqlDaemonApplication.ts:2324`，它有自己的取消实现），**从不经过**
`composeLegacySqliteResourceLimitOperations` → `cancelTask`；后者的调用点
`cli/start.ts:2784` 旁边就写着「this is the SQLite side of that symmetry」。
而 `cancelTask` 当时的签名是 `DbClient`，按类型也不可能拿到 PG 句柄。**所以没有线上缺陷。**

**真正成立的是**：那处同步 `.all()[0]` 使 `cancelTask` **无法**被放宽到中立句柄——
一放宽就会在 PG 上恒报 `task-not-found`，而且照样编译通过。变异验证（去掉 await ⇒
`rfc207` 的 PG 道红、SQLite 道绿）证明的是**新判据咬得住这个陷阱**，
不是「修好了一条线上故障」。这一刀的价值是**拆掉阻塞、让 `cancelTask` 真正成为引擎中立的**，
账本 336 → 335 / 30 → 29。

（记这一条是因为它是同一个毛病第四次：**先下结论、后核实**。核实成本极低——
`grep enforceLimits src/` 两行就看得出 PG 走的是另一条组合根。）

### 留下的（真的还没做）

`resumeTask` / `retryNode` 仍钉在 `DbClient` 上——**不是标注问题**，是传递闭包：
`resumeKick` / `assertChildTaskDrivable` 仍要同步句柄（§5en 说它们「零同步点」是按函数体数的，说小了）。
`startTaskImpl` 的 17 个同步点是最后的硬骨头。

### §5ep 续 —— `limits` 随同一刀销账，以及 `resumeTask` / `retryNode` 闭包的实测尺寸

`enforceLimits` 的入口放宽之后，`limits.test.ts` 只需要它一个，于是直接转双引擎（5 → 10 格）。
账本 335 → 334 / 29 → 28。

**下一刀的尺寸（用编译器量的，不是估的）**：把 `resumeTask` / `retryNode` 及其直接被调方
一起放宽，`tsc` 报 **12 条**，全部在 `services/task.ts` 内：

| 被调方 | 自身同步点 |
| --- | --- |
| `rollbackNodeRunForResume` | **0** |
| `retryRepoPreparation` | **0** |
| `reapHeldRuntimeSessionOwnersForTask` | 3 |
| `reapRunBeforeWorktreeReset` | 3 |

11 条是这四个 helper 的签名，第 12 条是 `retryNode` 里的
`deps: { ...opts.deps, db }`（`task.ts:6433`）——它撞的是 `StartTaskDeps['db']`，
也就是**启动路径**那堵墙（`startTaskImpl` 17 个同步点）。

所以：**`resumeTask` 这一支是够得着的**（6 个同步点，全在两个 `reap*` 里）；
**`retryNode` 够不着**，它经 `createTaskDriveCoordinator` 连上 `StartTaskDeps`。
而 `rfc097-task-status-cas` 三个都要，所以它要等启动路径那一刀。

探测改动已原样还原。

### §5ep 续二 —— `resumeTask` 整条闭包转中立句柄

按 §5ep 量出的尺寸做完了 `resumeTask` 这一支。闭包比第一次估的深一层，逐层由编译器指出：

`resumeTask` → `resumeKick` → `rollbackNodeRunForResume` / `reapRunBeforeWorktreeReset` /
`reapHeldRuntimeSessionOwnersForTask` / `assertChildTaskDrivable` →
`escalateLiveChildSurvived` / `escalateSnapshotLost`

共 7 个签名放宽 + **3 处同步读改 await**（`runtimeSessionLeases` 的租约读、
`leaseNodeRunId` 的 `.all().flatMap`、`nodeRuns` 的逐项读）。

**这三处与 `cancelTask` 那处的区别**（这是本刀唯一需要判断的地方）：它们都是**普通读**，
没有注释声明任何排序契约，其中一处的结果在下一行才被 `await` 掉的调用消费——
改成 await 不改变任何可观察顺序。`cancelTask` 那处则相反，注释写明了 FIFO 前提，
所以那一刀必须先拆取号。**看同步的理由，不是看同步的个数。**

`retryRepoPreparation` 探到一半退回去了：它只被 `retryNode` 调用（`task.ts:6093`），
不在 `resumeTask` 路径上，widen 了反而会把 `StartTaskDeps` 的墙提前拖进来。

**没有销账**：`rfc097-task-status-cas` 三个入口都要，`retryNode` 仍卡
`deps: { ...opts.deps, db }` → `StartTaskDeps['db']` → `startTaskImpl` 的 17 个同步点。
所以这一刀**只拆阻塞、不动账本数字**——`resumeTask` 在生产里目前也只被 SQLite 侧的
`taskLifecycleRepair` 调用，不存在线上 PG 缺陷（这次先核实了再写）。

相关套件在两个引擎上复跑 **316 格全绿**。

## §5eq —— 「`startTaskImpl` 17 个同步点」这堵墙**不存在**；真正的边界是 `StartTaskDeps` 本来就属于 SQLite 那一侧

我在 §5en / §5eo / §5ep 里反复说「最后卡在 `startTaskImpl` 的 17 个同步点」。
**那个数字是错的，那堵墙也不是那个形状。**

### 17 是怎么数出来的（三重高估）

按正则数 `.run()|.all()|.get()` 得 17，其中：

· **4 条是注释**——RFC-359 W10 自己留的那段说明里就写着 `.run()` 三个字；
· **绝大多数是已经 `await` 了的链**，比如 `await tx.insert(tasks).values({…}).run()`
  ——那条链从 3506 行一直写到 3630 行、横跨 **125 行**，正则只看见结尾的 `.run()`；
· 按缩进回溯到语句头再判，`startTaskImpl` 体内**真正没 await 的同步点是 0 个**。

根因是 **W10 早就把这里的事务边界换成中立的 `withTaskExecutionWrite`**
（`databaseSessionFor(db).transaction`），它的注释还特意写明「体内每一条语句都必须 await」。
**这件事早就做完了，是我没去读。**

### 那么真正拦住的是什么

把 `StartTaskDeps.db` 放宽，编译器给出的是一条**完全不同**的清单——同步读全在
`deps.db` 的那几个 helper 里，不在 `startTaskImpl`：

| helper | 实况 |
| --- | --- |
| `assertLaunchSourceSchemeSync` | 名字里的 `Sync` 指**请求的同步段**（必须在 201 之前拒），不是同步读；函数本来就是 `async`，2 处读可以直接 await |
| `createPersistedRepositoryPreparationStep` | 2 处读，都在 `async read()` 里 |
| `loadFrozenSpaceLayout` | 端口签名本来就是 `=> Promise<…>`，两个调用点也早包在 `async` 里，实现改 async 与契约相容 |
| `reclaimStalePrepArtifacts` | 1 处读 |

**这些我全部改通了**，`src` 侧一路推到只剩一条错——然后撞上真正的边界：

```
taskDriverLifecycle.ts:123  persistence: createSqliteTaskExecutionPersistence(db)
```

`src/modules/task-execution/infrastructure/` 下**同时存在** `taskDriverLifecycle.ts` 与
`postgresqlTaskDriverLifecycle.ts`，而 PG 守护进程用的是自己那套
（`cli/postgresqlDaemonApplication.ts:119 / :853` —— `createPostgresqlTaskDriverLifecyclePort`
+ `createPostgresqlTaskExecutionPersistence`）。

**结论：`StartTaskDeps` 是一对已登记的机制分叉里 SQLite 那一侧的依赖包，不是「还没迁的债」。**
把它放宽在架构上就是错的——那等于让 SQLite 的启动装配去喂 PG 的句柄，而 PG 有自己完整的启动路径。

### 对账本的影响（需要裁决，不自行改）

卡在 `StartTaskDeps` / `buildStartTaskDeps` 上的那几个文件（`start-task-deps`、
`rfc097-task-status-cas` 经 `retryNode`、`rfc268-webhook-scratch-launch`、
`rfc269-webhook-code-host-context-e2e` …）测的是**SQLite 启动路径**，而它有 PG 对应物。
按 AC-1 修订后的口径，这与 `rfc349-websocket-provider` 属于**同一类**——
「被测物就是某一侧的适配器」，应当判**不适用**，而不是挂在 `OPEN_MIGRATION_DEBT` 上当待办。

**没有自行改账本**：这会让 open 债从 28 掉到 ~22，是一次**分类裁决**而不是迁移，
按 §5eg 立下的规矩（「放松判据的方向恰好是让数字变好看的方向」）应当由用户拍板。
探测改动已全部还原（`git checkout -- task.ts taskDriverLifecycle.ts`），
`rfc287-t13-deferred-prep` + `rfc097-cancel-wins` 复跑 62 格全绿。

## §5er —— 取号解耦的 PostgreSQL 侧补上判据；以及这份覆盖**锁住了多少、没锁住多少**

§5ep 改了 `reviewMutationCoordinator` 的排队原语，但它的预言机
`review-cancel-concurrency` 是**单引擎**的——也就是说那一刀在 PG 上一直没被直接测过。
而 PG 恰恰是最该测的一侧：那里的前置读是一次真网络往返，racing 的评审变更窗口比 bun:sqlite 宽得多。

**现在补上了**：11 条 `settleInOrder` 线性化用例转双引擎（SQLite 20 格 / 111 断言**逐字不变**，
双引擎 31 格 / 195 断言）。9 条留原生并写清两条理由：
① `delayArchiveSelect` / `observeDbSelect` / `loseFirstCancelCas` 是 `db` 上的 Proxy，
PG 在 `databaseSessionFor(db).serializable(...)` 里会绕开它，注入不触发、判据静默退化成「没有并发」；
② `starveTaskCancelCas` 与 WS 监听快照用的是 bun:sqlite 同步面，在同步回调里 PG 没有等价物。

### 变异验证：PG 道确实会红

把 `reserveTaskReviewMutationSlot` 改回拆分前的形态（删掉同步取号那一支，先 await 再入队）：

· `[postgresql] > cancel first makes queued stale-source dispatch perform zero refresh writes` — **红**
· PG 单跑 **18 pass / 2 fail**——是真用例体失败，不是 `0 pass / 1 fail` 那种环境签名。

所以这份覆盖是真的咬住了契约，不是白绿。

### 但要诚实记下它**没**锁住的部分

同一个变异下，其余几条 `cancel first …`（decision ×3 / comment ×3 / selection）在 PG 上**照样绿**。
原因：它们的竞争者经 `withReviewNodeMutationLock` 进入，那条路的 `findTaskId` 往返是在
cancel 的前置读**之后**才发出的，于是 cancel 靠发出顺序侥幸仍然赢。

**真正承重的是 dispatch 那一条**——`dispatchReviewNode` 零前置 await 直接进 task 键队列，
所以一个取号晚了的 cancel 会被它确定性地超过。

**结论**：PG 侧的契约目前由**一条**用例承重，不是 11 条。要把评审键那几条也在 PG 上锁死，
得让竞争者的作用域查询强制排在 cancel 的前置读之前——那是另一件事，本刀没做。
记在这里，免得下一个人从「11 条双跑」推出「11 条都在 PG 上有预言力」。

## §5es —— AC-6 的机械面到此为止：剩下 27 行**逐行核过**，没有一行是「还能迁但没迁」

`rfc357-task-list-authorization` 转双引擎（4 → 8 格，SQLite 侧 4 格 / 9 断言逐字不变）。
它的被测物是列表页那两个谓词构造器，搬家时已放宽成 provider 中立；而它锁的正是
**SQL 三值逻辑那个坑**——`ne(owner_user_id, me)` 在 `owner_user_id IS NULL` 上是 NULL 不是真，
无主但共享给我的任务会静默消失。两个引擎对 NULL 比较的渲染本就不同
（PG 侧等价写法是 `IS DISTINCT FROM`），所以这条判据**尤其**该双跑。账本 334 → 333 / 28 → 27。

### 剩下 27 行的逐行分类

| 类别 | 数 | 说明 |
| --- | --- | --- |
| 已双跑，只剩一个**有据**的单引擎块 | 10 | `execution-contract-platform` / `rfc189-wg-round` / `rfc221-login-policy-routes` / `rfc257-webhook-error-codes` / `rfc291-unavailable-mount` / `rfc291-closure-call-edges` / `rfc310-pr7b-handover` / `rfc311-repos-page` / `rfc311-task-page-fastpath` / `rfc359-w7-catalog-composition-roots` |
| 卡生产签名 | 5 | 全部经 `StartTaskDeps` / `freezeCallClosure` / `createSqliteTaskExecutionPersistence` |
| 被测物就是某一侧的适配器 | 7 | `rfc349-*` 那一族（websocket / execution-peripheral / daemon-provider-core / dual-provider-oracle / 两个 `*-postgresql-adapter` / platform-tools-wiring） |
| 架构守卫 / helper / 迁移链 | 5 | `architecture/rfc329-mcp-surface-guard`、`rfc305-architecture-lock`、`helpers/rfc310Pr3Fixture.ts`、两个 `rfc359-t19h-*` |

**没有一行属于「机械上能迁、只是还没动」。** AC-6 的机械面到此为止。

### 为什么这 27 不该靠「重新分类」变小

后三类里有 12 行，按裁决本该判「不适用」。**但不能把它们挪进 `SANCTIONED_SINGLE_ENGINE`**：
那张表的五个类目（`migration-chain` / `sqlite-execution-engine` / `real-file-database` /
`sync-engine-capability` / `sqlite-only-primitive`）**全部是机械可判的**，而
「被测物就是某一侧的适配器」是一句关于「这条判据在测什么」的**判断**，机械判不出来。

本文件自己的话：`OPEN_MIGRATION_DEBT` 是「**没有任何机械理由**留在单引擎上的文件」。
§5eg 也已经两次拒绝过为好看而加类目：「**放松判据的方向恰好是让数字变好看的方向**」。

**所以 27 这个数偏大是设计使然，不是账没销干净**——账本宁可多记，也不让一句判断悄悄把数字抹小。
我先前把「28 → ~22 的重新分类」写成一个待用户拍板的选项，**那个框定也是错的**：
按账本自己的规矩，这件事的答案是**不做**。

## §5et —— AC-11 的收束：查询融合**在数学上就关不上**这道口子，能关上的只有「不读库」

我先前把 AC-11 的最后一步写成两条可选路径（融合查询 / 缓存授权快照），并说「二选一由用户定」。
**第一条是错的**——把实测数字代进去就知道它根本关不上。

### 算一遍

后折叠实测（run `34836852462`，`clarify-pending`，两侧都是 **3 次 awaited 读**）：

```
sqlite 1.355ms   pg 1.410ms   gap 0.055ms
每读之差 (X_pg − Y_sqlite) = 0.055 / 3 = 0.0184ms
```

融合掉 N 次读（两个引擎同时少读），残余差 = `(3 − N) × 0.0184`：

| 融合掉 | 残余 gap | 判定 |
| --- | --- | --- |
| 1 次（PAT 查询并入 grants join） | 0.0368ms | **仍红** |
| 2 次 | 0.0184ms | **仍红** |
| 3 次（一次库都不读） | 0 | 绿 |

### ~~为什么这是结构性的~~ —— **这一段的推导是错的，撤回**

上一版在这里写：两侧发同样多次读时 `gap = N × (X_pg − Y_sqlite)`，于是
「任何查询优化都只能按比例缩小它，不能让它变号」。**那个等式漏了一项。**

SQLite 在这条路径上**多一次同步写**（`token_audit` 插入是同步的、在路径上），
PostgreSQL 那一笔是 `void` 派发的、不在路径上。所以真实关系是：

```
gap = 3·X_pg − (3·Y_sqlite + Y_write)
```

于是 `X_pg − Y_sqlite = (gap + Y_write) / 3`，而 `Y_write` 我**没有单独测过**。
融合掉一次读后残余 `gap − (X_pg − Y_sqlite)`，这个值是正是负**取决于我没测的那一项**。
所以「查询优化关不上」这个结论**不成立**——它可能关得上，我不知道。

顺带记一个别用错的数：本机 Docker PG 实测单次索引读 p50 **0.669ms**、SQLite **0.108ms**，
差 0.561ms。但托管 CI 上三次读的总差只有 0.055ms ⇒ 那边每读之差约 0.02ms。
**本机数字不能外推到 CI**（CI 的 PG 往返便宜一个量级），拿它推 CI 的结论会错得离谱。

这也正好解释了为什么三个重端点是绿的：那里**查询复杂度**主导而不是读次数，
PG 的查询引擎赢下来（`tasks-first` 128.97 → 56.24，`tasks-running` 87.72 → 41.61，约两倍）。

### 于是 AC-11 只剩一条技术路径，而它动的是 ACL 语义

要让 N → 0，只能把授权读从稳态请求路径上**拿掉**，也就是缓存授权快照。
而当前设计是**刻意不缓存**的：`userAccessPersistence.ts` 的头注写明进程缓存只服务
WS 发帧那条**同步**围栏，请求路径每次重读，于是「改权限下一个请求即生效」。
缓存它就是拿这条性质去换那 0.055ms。

**缓存这条路不是我可以自行决定的**——本仓硬规则写着访问控制只按显式功能需求与用户可见行为
验收，不由跑测试的人评价或调整其语义。

**但「工程面已经走到头」这句是我说早了。** 按上面更正后的算式，把两次认证读融成一次
（auth 的 PAT 查询与 identity-access 的 grants join 合并）**有可能**把那 0.055ms 抹平，
也可能不够——要知道只有一条路：真去实现，然后在 CI 上量。那一步涉及模块边界归属
（谁拥有那条查询），按 RFC-294 该走 `public/queries` 的显式合同，属于需要拍板的设计动作；
但它是**工程上可能成立的选项**，不该像我上一版那样被算掉。

## §5eu —— AC-11 的真因找到了：不是往返次数，是 **generic plan 把一条探针变成了全表扫**

§5et 收在「融合认证读**可能**关得上那 0.055ms，要知道只有实现了去 CI 上量」。
往那个方向走之前我先回头看了一眼**原始样本**，于是这件事整个翻过来了。

### 先说方法上的错：我一直在读 P95，而 P95 在这里几乎没有信息

`scripts/perf-run.ts` 是 `rounds: 20`。**20 个样本的 P95 就是第 20 名，也就是最大值**。
拿两次**同 SHA**的 run（`34827977388` / `34831180498`，代码逐字相同）当对照，
每端点 gap 的摆动是 0.2–3.7ms：

| 端点 | 同 SHA run A | 同 SHA run B | 摆动 |
| --- | --- | --- | --- |
| tasks-second | +1.978 | +5.504 | 3.526 |
| repos-first | +2.134 | +4.235 | 2.101 |
| overview | +2.368 | +1.038 | 1.330 |

我此前反复推敲的 0.055 / 0.397 / 0.885 / 0.972ms，**全部落在这个摆动之内**。
围绕它们做的所有算术（含 §5et 那版）都是在给噪声建模。

### 再说一条我漏报的事实

§5et 说 run `34836852462` 之后「四个剩余的红都在亚毫秒级」。**那是错的**：
该 run 的 `comparison.json` 里 `postgresqlNoSlower: false` 的是 **6 个**端点，
而且其中 `workgroup-pending` 是 **29.35ms vs 4.86ms**，同时把 `max < 10ms` 的原始预算
也撑爆了（`postgresqlPassed: false`）。我当时只盯着自己改过的那几条，没通读那份对照。

### 真因：按测量顺序排开的样本里有一个**台阶**

```
workgroup-pending / PostgreSQL（按测量顺序）
2.66  2.16  2.29  2.50 | 24.86  26.81  29.35  24.32  23.86  23.94 …
```

前 4 个正常，**从第 5 个起全部 23ms 以上并再不回落**。这不是噪声、不是离群点，
是状态变了：1 次 warmup + 4 个采样 = 5 次执行，第 5 个采样正好是**第 6 次执行**——
PostgreSQL 从第 6 次起才可能把 custom plan 换成 generic plan。

在真库上复现（10 万行、`workgroup_id` 全 NULL，与语料同形）：

```
执行 1..5 : 0.79 / 0.27 / 0.26 / 0.16 / 0.23 ms     custom plan
执行 6..8 : 6.02 / 4.55 / 4.33 ms                   generic plan
```

两份计划：

```
custom : Limit → Index Only Scan using idx_tasks_workgroup   Index Cond: workgroup_id >= ''
generic: Limit → Seq Scan on tasks                            Filter: workgroup_id >= $1
                                                              Rows Removed by Filter: 100000
```

肇事的是 `workgroupTaskRoomTaskParticipant.ts` 的空工作组探针
`WHERE ${tasks.workgroupId} >= ${''} LIMIT 1`——那个 `''` 是**源码常量**，drizzle 把它编成 `$1`。
generic plan 看不见它，按默认选择率估成命中很多行、又有 `LIMIT 1`，于是判定
「顺序扫一下马上凑够一行」；实际一行都凑不到，把整张表读完。

**改法**：`>= ${''}` → `IS NOT NULL`。语义等价（text 列里任何非 NULL 值都 `>= ''`），
但它是常量谓词，两份计划都回到 `Index Only Scan`；SQLite 侧 `EXPLAIN QUERY PLAN` 逐字不变
（都是 `SEARCH tasks USING COVERING INDEX idx_tasks_workgroup`）。

**这条探针是 `072c8f575` 为 AC-11 加的优化**（「没有工作组就别扫 tasks」）。方向没错，
代价是它引入了一个绑定参数——于是优化本身成了回归的载体。

### 守卫：把「generic plan」补进计划审计

`rfc359-w6-t26-postgresql-plan-audit` 本该抓到它，没抓到，原因是**结构性的**：
它对每条语句 `EXPLAIN (ANALYZE, BUFFERS)` 一次、而且**带着实参**——量到的永远是 custom plan。
带实参的 `EXPLAIN` 在结构上就看不见这类缺陷。

补上的判据用 `EXPLAIN (GENERIC_PLAN)`（PG 16+，只规划不执行，不吃语料规模也不吃机器负载，
与该文件「不用墙钟毫秒」的原则一致），并且**不只看形状**：

> generic plan 把某个关系的索引扫换成顺序扫，**且** generic 自己的估算代价不高于 custom。

第二条是 PostgreSQL 自己的采纳规则（`plan_cache_mode=auto`）。少了它会过度报警——实测
`/api/overview` 的计数就是 generic 形状更差（Seq Scan）但估算 458.58 vs custom 8.62，
**PG 根本不会换**，报出来只会逼人往账本里塞无害条目。而 workgroup 探针是 generic 估 **8.47**、
custom 估 12.63 —— 估得更便宜所以被采纳，而那 8.47 建立在「`LIMIT 1` 扫几行就够」的错误假设上。
**「估错了所以才被采纳」正是危险的定义**，判据取两条的合取就只报这一类。

账本 `GENERIC_PLAN_GAPS` 建成即空。红→绿实证：把探针改回 `>= ${''}` 这条判据立刻报
`/api/workgroup-tasks/pending-count — 空工作组短路探针::tasks`，改回 `IS NOT NULL` 转绿。

### 其余端点：独立扫过，没有第二处

另起一个 agent 用同样方法（含一条正向对照：workgroup 探针 0.018ms → 19.557ms，约 1086×，
`pg_prepared_statements` 从 `generic=0/custom=1` 走到 `generic=1/custom=5`）把
`repos-first` / `repos-referenced` / `reviews-pending` / `clarify-pending` / `overview`
的 12 条语句逐条过了 `PREPARE` → 5×`EXECUTE` → 第 6 次 `EXPLAIN (ANALYZE)`，外加
`force_generic_plan` 一组：**五个端点一条悬崖都没有**，计划在阈值两侧逐节点相同。

它同时从 CI 原始样本独立印证了同一件事：只有 `workgroup-pending` 有台阶；另外几个的 P95
要么是 warmup（`reviews-pending` 单调下降，P95 就是第 1 个样本），要么是孤立尖峰
（`repos-first` 的 10.36 落在第 9 个样本，左右邻居 3.20 / 3.00）。

### 于是 AC-11 的账重新算

- **真缺陷 1 个**，已修、已带守卫：workgroup 探针的 generic plan 全表扫。
- **其余 gap 有一部分是每语句一次往返的固定成本**：PG 出进程走 TCP、SQLite 在进程内，
  每条语句的 parse/bind/execute 差是结构性的。

  **更正一处数**：我此前照抄协作 agent 的说法写成「`clarify-pending` 两个引擎跑同样 **3** 条
  语句」。查 `*-query-profile.json` 实际是 **4 条**（PAT 查询 / users+grants 查询 / 端点自己的
  body 查询 / `token_audit` 写），两个引擎都是 4 条。`overview` 更是**两边各 13 条**，不是 5 条。

  **量级只按 CI 自己的数算**：`clarify-pending` 的中位数差 +0.385ms ÷ 4 条 ≈ **0.096ms/语句**。
  （协作 agent 在本机 Docker PG 上量到约 0.62ms/语句——**本机数不能外推到 CI**，差约 6 倍。
  §5et 已经为同一件事记过一次教训，这里不再犯：凡涉及 CI 上的量级，只引 CI artifact。）

  按这个单价，`overview` 的 13 条语句里 body 占 10 条，往返最多解释约 1ms，
  而它的中位数差是 +2.5ms——**剩下的是查询本身的代价**，也就是下面这一节要处理的。
- `/api/overview` 的常量绑参（`catalog_visibility = $1`、`status in ($2,$3)`）我一度改成了
  字面量，**又改回去了**：实测 PG 不会采纳那份 generic plan（估算差 53 倍），
  改动无法用数据支持，留着就是一处未经测量的「优化」。

**还没做的**：这一刀之后的 CI 复测（已按 HEAD 派发 `postgresql-evidence` 的
`http-performance`）。在拿到新的 `comparison.json` 之前，不宣称任何端点因此转绿。

## §5ev —— 剩下的 PG 慢不是查询写法，是**语料装载后没 VACUUM**：基准在拿 PG 的瞬时状态比 SQLite 的稳态

§5eu 修掉 workgroup 探针之后，我把手上 5 个 run 的 `comparison.json` 按端点拉平，问一个此前没问过的
问题：**哪些端点是次次红、哪些是来回翻**。

| 端点 | 948d9b5f | 602264d5 | 602264d5 | dfb49eb8 | 56713f37 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| tasks-first / tasks-running | . | . | . | . | . | 次次绿（PG 快一半以上） |
| tasks-second | . | X | X | . | . | 翻（2/5 红） |
| reviews-pending | X | X | X | X | . | 翻（4/5 红） |
| clarify-pending | X | X | X | X | . | 翻（4/5 红） |
| workgroup-pending | . | X | X | **B** | **B** | §5eu 那条，已修 |
| **repos-first** | X | X | X | X | X | **次次红** |
| **overview** | **B** | X | X | X | X | **次次红** |

（`.` 通过，`X` 未通过 `postgresqlNoSlower`，`B` 连 `max<10ms` 的原始绝对预算也撑爆。）

**这张表我一开始读错了一半，先更正。** 翻来翻去的是 **P95 的判定**（20 个样本的 P95 就是最大值，
一个离群点就能定生死），**不是底下的差本身**。把同样 6 个 run 换成**中位数**看，结论完全变样：

| 端点 | 948d9b5f | 602264d5 | 602264d5 | dfb49eb8 | 56713f37 | 7f51454f2 |
| --- | --- | --- | --- | --- | --- | --- |
| tasks-first | −70.3 | −71.9 | −69.3 | −75.5 | −66.0 | −75.9 |
| tasks-second | −2.8 | −2.9 | −3.7 | −4.3 | −4.6 | −4.9 |
| tasks-running | −40.8 | −44.1 | −40.0 | −46.2 | −28.6 | −42.1 |
| repos-first | +2.1 | +2.7 | +2.9 | +0.7 | +1.4 | +0.9 |
| repos-referenced | +2.3 | +1.9 | +2.3 | +0.7 | +1.1 | +1.4 |
| reviews-pending | +1.7 | +1.6 | +2.0 | +0.4 | +0.5 | +0.6 |
| clarify-pending | +1.3 | +1.2 | +1.1 | +0.3 | +0.8 | +0.4 |
| workgroup-pending | +2.5 | +1.7 | +1.5 | **+23.8** | **+24.9** | **+1.2** |
| overview | +2.9 | +2.0 | +1.6 | +2.1 | +2.9 | +2.5 |

（中位数差，PG − SQLite，毫秒；负 = PG 更快。）

中位数几乎不抖，于是两件事一眼可见：

1. **`workgroup-pending` 的修复被证实**：+23.8 / +24.9 → **+1.2**，回到它出 bug 之前
   （1.5–2.5）那条带上。台阶也确实没了——按测量顺序是
   `2.89 2.68 2.63 2.61 2.64 2.49 … 2.24 2.45 2.39`，平的，绝对预算一并转绿。
2. **「翻的那几个是噪声」这句我说错了。** 六个轻端点的**中位数差在每一个 run 上都是正的**
   （+0.3 ~ +2.9ms）——PG 在轻端点上**系统性地慢**，这是真的、不是噪声。噪声只决定
   「这一次 P95 抓不抓得到它」。三个重端点则是 PG 稳定大胜（−2.8 ~ −76ms）。

顺带也看得出 §5ej / §5ek 那两刀（PAT 写节流 + 世代围栏内联）**确实有效**：
`repos-first` 2.9 → 0.7、`reviews-pending` 2.0 → 0.4，都发生在 602264d5 → dfb49eb8 之间。

下面这一节讲的是其中**最大也最稳**的那条（`overview`，每个 run 都 +1.6~+2.9）：

```
overview      PG 中位数 5.4–6.5ms   vs  SQLite 3.0–3.3ms      （4 个 run 都这样）
repos-first   PG 中位数 4.4ms       vs  SQLite 2.9ms
PG raw: 6.48 6.17 6.02 5.85 6.46 5.50 5.77 …   ← 平的，没有台阶也没有尖峰
```

### 根因（**`overview` 已实证；`repos-first` 只是同因推测，未验**）：`scripts/perf-run.ts` 只 `ANALYZE`，从不 `VACUUM`

先划清证据边界，免得把推测读成结论：下面这组 1.682ms → 0.557ms 是对着
**`/api/overview` 那条计数的形状**量的。`repos-first` 的重语句（`tasks` 按 `cached_repo_id`
分组计数 + `NOT IN` 子查询）**我没能在本机验到**——plan-audit 的语料与 RFC-311 性能语料的
`cached_repo_id` 取值不同源，本机跑那条语句 `actual rows=0`，量不出东西来。
把它和 `overview` 归成同一个因，理由只是「同样是 `tasks` 上的分组计数、同样吃 index-only scan」，
**这是推测**。它到底是不是同一个因，以 CI 复测为准。

PostgreSQL 的 **index-only scan 要成立，得靠 visibility map** 证明「这一页全部可见」，
而 VM 只由 VACUUM 维护。刚批量灌完的表 VM 是空的，于是 index-only scan 不成立，planner 退回
`Bitmap Heap Scan`。实测（10 万行，`/api/overview` 那条计数）：

```
只 ANALYZE  : Bitmap Heap Scan                    1.682ms   Heap Blocks: exact=345
VACUUM 之后 : Index Only Scan, Heap Fetches: 0    0.557ms   ← 3.0×
```

生产里 autovacuum 一直在跑、VM 常态是新的。**只 `ANALYZE` 等于拿 PG 一个它从不持续停留的
瞬时状态，去和 SQLite 的稳态比**——而 SQLite 没有 MVCC 可见性这回事，本来就拿得到最好的计划。
缺这一步只有 PG 被罚，这正是本 RFC 要消灭的「同一件事两个引擎一个好一个不好」。

### 处置：判准是「**生产里这个引擎实际有什么**」，不是「两边跑同样的命令」

- PostgreSQL：`ANALYZE` → **`VACUUM ANALYZE`**。它默认开着 autovacuum，VM 常态是新的。
- SQLite：**维持 `ANALYZE`**。它没有后台 vacuum，绝大多数部署也从不手工 `VACUUM`——
  那本来就是它的生产状态。

**一度我给 SQLite 也加了 `VACUUM`**（实测确实再快约 8%：p50 0.4336 → 0.3979ms），
**又去掉了**，两个理由：① 那是生产拿不到的收益，加上去就不是在量生产；② 全量语料是
1000 万行事件，SQLite 的 `VACUUM` 要整文件重写、另需约一倍空闲盘，而这个 job 的盘是掐着
25 GiB 给的、还要同时装下两套语料——很可能把 CI 撑爆。

**这不是给 PG 放水**：两边各自对齐**自己的**生产稳态。缺这一步被罚的只有 PG，
因为只有它的 index-only scan 依赖 VM。`rfc359-w6-t26-postgresql-plan-audit` 的语料装载
同步改成 `vacuum analyze`——审计与基准必须看同一个库状态，否则这里判绿的计划在那边量出来是另一个。

### 判据

新增「装载后维护到位：热计数走 index-only scan 且 Heap Fetches 为 0」。判据取的是
**可见性本身**（`Heap Fetches: 0`）而不是耗时——与机器负载无关，和该文件其余判据同一原则。
红→绿实证：把 `vacuum analyze` 改回 `analyze`，它立刻报
`Bitmap Heap Scan on tasks … Heap Blocks: exact=345`（1.206ms / 349 buffers）。

### 顺手排除掉的一条歧路：`IN ($1…$50)` 的规划开销

`repos-first` 的重语句带 **50 个绑定参数**（`cached_repo_id IN ($1…$50)`），实测它的
`Planning Time` 是 **0.681ms**，而 `Execution Time` 只有 0.042ms——规划比执行贵 16 倍。
换成 `= ANY($1::text[])`（**1 个参数**）后规划掉到 **0.056ms，12×**，计划形状逐字不变
（都是 `Index Only Scan using idx_tasks_cached_repo`）。看上去是个现成的大杠杆。

**但它不成立**，因为那笔开销不是每请求都付。查 `pg_prepared_statements`：跑 8 次之后是
`custom_plans=5 / generic_plans=3`——PostgreSQL 在第 6 次执行**换到了 generic plan**，
此后不再重新规划。基准是 1 warmup + 20 采样 = 21 次执行，所以规划开销只落在**前 4 个采样**上，
稳态（第 5–20 个采样）一分钱不付。而 `repos-first` 慢的恰恰是稳态。

排除掉它还省了一件事：drizzle 的 `inArray()` 生成的就是 `IN ($1…$n)`，要改成 `= ANY(array)`
得走 PG 专属语法（SQLite 不认），按 AC-10 只能经 `EngineCapabilities` 表达——为一个**不影响
稳态**的开销去新增一条引擎能力分叉，不划算。

### 还没证的事

这一刀之后 `overview` / `repos-first` 会不会真的转绿，**要等 CI 复测**。本机 10 万行上的 3.0×
不能外推到 CI（§5et 的教训），只能说方向和量级都对得上那 2.85ms 的稳态差。
在拿到新的 `comparison.json` 之前不宣称任何端点转绿。

## §5ew —— **撤回 §5ev 的根因判定**：VACUUM 不是 `overview` 慢的原因，CI 的语料本来就是好的

§5ev 给自己设了一条可证伪的预期：「如果 VACUUM 是对的，`overview` 应该从 +2.5ms 掉到 +1ms 上下」。
CI 复测回来了，**掉不下去**。

### 实测（四个 run 的中位数差，PG − SQLite，毫秒）

| 端点 | 56713f37 | 7f51454f2 | 6b964e174 | 4099bb1e0 |
| --- | --- | --- | --- | --- |
| | 无 VACUUM | 无 VACUUM | **PG+SQLite VACUUM** | **仅 PG VACUUM** |
| repos-first | +1.435 | +0.931 | +1.033 | +1.021 |
| repos-referenced | +1.147 | +1.398 | +1.395 | +1.386 |
| reviews-pending | +0.499 | +0.551 | +0.326 | +0.539 |
| clarify-pending | +0.786 | +0.385 | +0.418 | +0.585 |
| **overview** | **+2.850** | **+2.498** | **+2.580** | **+2.300** |
| workgroup-pending | +24.914 | **+1.243** | **+1.345** | **+1.015** |

**加 VACUUM 前后没有任何变化。**

### 为什么错了：CI 的 PostgreSQL 开着 autovacuum，我的本机复现不成立

直接查 `*-query-profile.json` 的计划节点，**加 VACUUM 之前**：

```
select count(*) from tasks where …   Index Only Scan  rel=tasks  Heap Fetches=0   t=0.020ms
select count(*) from tasks where …   Index Only Scan  rel=tasks  Heap Fetches=0   t=1.086ms
select count(*) from tasks where …   Index Only Scan  rel=tasks  Heap Fetches=0   t=0.018ms
select count(*) from tasks where …   Index Only Scan  rel=tasks  Heap Fetches=0   t=0.019ms
```

**本来就是 index-only scan、本来就 `Heap Fetches: 0`**；加 VACUUM 之后逐节点一模一样。
也就是说 visibility map 从来没有缺过——CI 的 PostgreSQL 服务容器默认开着 autovacuum，
灌完语料到开测之间它已经把 VM 建好了。

我本机那组 1.682ms → 0.557ms（3.0×）是**真的**，但它复现的不是 CI 的状态：我建完表**立刻**查，
autovacuum 还没来得及跑。拿那个状态去推断 CI，正是 §5et 记过的同一个错——**本机数不能外推**——
我这次犯的是它的变体：**本机构造的「状态」也不能外推**。

### 保留与不保留

- **`VACUUM ANALYZE` 保留**，但理由换掉：不是「修掉 3 倍惩罚」，而是**让被测状态由代码决定、
  不靠 autovacuum 的时序碰运气**。CI 上的实测效果：**没有**。代价有界，收益是可复现。
- **判据保留，而且它恰恰证明了自己有用**：「热计数走 index-only scan 且 `Heap Fetches` 为 0」
  正是靠它我才能证明「这个状态本来就对」，而不是继续假设它不对。
- **`docs/dev-gotchas.md` 那条同步更正**：机制本身没写错（没 VACUUM 又没 autovacuum 就会退回
  `Bitmap Heap Scan`），但必须补上「**先查 `Heap Fetches` 再下结论**——跑着 autovacuum 的真实
  部署上，这个坑很可能根本不存在」。

### 结论：`overview` 的 +2.5ms 目前**没有归因**

四个 run 稳定在 +2.3 ~ +2.9ms，不是噪声、不是计划问题、不是 visibility map。
`overview` 两个引擎各跑 **13 条语句**，按 `clarify-pending` 推出的往返单价（≈0.096ms/语句）
最多解释约 1ms，剩下约 1.5ms 没有着落。**不再猜**——下一步要么拿到每条语句的稳态耗时
（现有 query-profile 是单次冷请求，PG 侧 36.8ms vs SQLite 1.4ms，全是首次解析/规划开销，
不能用来归因稳态），要么就把它如实记为未决。

### 同时被证实的：workgroup 那一刀是对的

+24.914 → **+1.243 / +1.345 / +1.015**，三个独立 run 一致，回到出 bug 之前那条带，
绝对预算也一并转绿。§5eu 站得住。

## §5ex —— `overview` 的归因拿到了：**六个轻端点分成两类，只有一类还有工程余地**

§5ew 把 `overview` 记成「没有归因」。拿 query-profile 里**每条语句的计划执行时间**（不是
wallMs——那是单次冷请求，含首次解析/规划，不能用）逐条摊开之后，归因出来了，而且六个轻端点
干净地分成两类。

### A 类：PG 在「数很多行」上结构性地慢

`overview` 的 10 条语句里，**一条占了 88%**：

```
count(*) from tasks where catalog_visibility='public' and status='running'
  PG    : Index Only Scan  idx_tasks_overview_counts  rows=12856  扫 0.93ms / 合计 1.507ms
  SQLite: SEARCH tasks USING COVERING INDEX idx_tasks_overview_counts (status=? AND parent_task_id=? AND catalog_visibility=?)
          整条语句 wallMs ≈ 0.04ms
```

**两个引擎走的是同一条索引、数的是同一批 12856 行。** 差别纯粹是每行的代价：
PG 约 72ns/行（可见性检查 + tuple deform + 聚合 transition），SQLite 的覆盖索引计数是一段
紧凑字节码循环，约 3ns/行。这不是我们代码的缺陷，是引擎特性。

同类还有两条：

| 端点 | 最重语句 | 扫描行数 | PG 计划耗时 |
| --- | --- | --- | --- |
| `overview` | `count(*) … status='running'` | 12 856 | 1.507ms |
| `repos-referenced` | `tasks GROUP BY cached_repo_id` | 10 000 | 2.044ms |
| `repos-first` | 五子查询 facet 面板 | — | 3.844ms |

**这一类没有查询改写的余地**：同索引、同行数、结果必须精确。要更快只能改**产品**
（维护计数器 / 近似计数 / 给计数设上限），而语料是 RFC-311 原版、AC-11 明写不许动。

### B 类：查询本身几乎不花时间，差的全是**每条语句一次往返**

| 端点 | PG 全部语句的计划执行时间合计 | 端点中位数差 |
| --- | --- | --- |
| `reviews-pending` | **0.032ms** | +0.33 ~ +0.55ms |
| `clarify-pending` | **0.033ms** | +0.39 ~ +0.79ms |
| `workgroup-pending` | **0.054ms** | +1.02 ~ +1.35ms |

PG 真正在数据库里干的活是 **0.03~0.05ms**，而端点差是它的 **10~25 倍**。
也就是说这三个端点的差**几乎全部**不是查询，是出进程往返 + 协议开销。每个请求 4 条语句
（PAT 查询 / users+grants 查询 / body 查询 / `token_audit` 写），摊下来约 **0.1~0.35ms/语句**。

**这一类唯一的杠杆是「少发几条语句」**，而且确实有两条可减：

1. **两笔认证读可以合一**。第 0 条已经是 `user_pats ⋈ users`，第 1 条是
   `users ⋈ user_permission_grants`——它们在 `users` 上重叠，合成一条
   `user_pats ⋈ users ⋈ user_permission_grants` 是可行的。**但它跨模块**：PAT 查询归 auth，
   grants 归 identity-access，按 RFC-294 得走显式 `public/queries` 合同。
2. **`token_audit` 写可以离开请求路径**（目前 `void` 派发但仍占一条语句/一次往返）。
   代价是改变审计记录的落库时机。

按 0.1~0.35ms/语句估，4 条减到 2 条能砍掉约一半的 B 类差距；`clarify-pending`（+0.39~0.79）
有希望真的抹平，`workgroup-pending`（+1.02~1.35）未必够。**这是估算，不是结论**——
真要知道只能实现了去 CI 上量。

### 于是 AC-11 的收口是一道**判据问题**，不是实现问题

- **B 类**：有明确的工程路径（减往返），但第 1 条要新增跨模块合同，属于设计决策。
- **A 类**：在 AC-11 自己的约束内（语料不变、结果精确）**没有工程解**。
  PG 在 10k~13k 行的精确计数上就是比进程内的 SQLite 慢，与我们怎么写 SQL 无关。

呈用户裁决。在拿到裁决前不动 A 类，也不擅自新增跨模块合同。

## §5ey —— AC-11 收口：判据从「P95 不慢于 SQLite」换成「中位数差不超过登记值」

用户 2026-09-15 裁决：**A 类承认为引擎特性并改判据；B 类两条减往返都不做**。
据此把 AC-11 的第二款落成可执行的判据（`proposal.md` 的修订块是权威文本，这里记实现与验证）。

### 换了什么

`scripts/perf-compare.ts`：

- 每个场景新增 `medianAllowanceMs`（exact 清单，三个重端点为 **0**，六个轻端点按实测加余量）；
- 报告新增 `sqliteP50Ms` / `postgresqlP50Ms` / `medianGapMs` / `medianAllowanceMs` /
  `postgresqlWithinAllowance`；
- **闸门**：`acceptancePassed = fullAcceptance && every(postgresqlWithinAllowance)`。

`postgresqlNoSlower`、两个 P95、以及 RFC-311 的原始绝对预算**继续逐条记录**，只是不再是闸门。

### 为什么这不是放水——拿历史 run 回放验证

把八个真实 run 的原始样本按新判据重算：

| run | sha | 新判据 |
| --- | --- | --- |
| 34816698143 | 948d9b5f | FAIL（repos-first +2.13 / repos-referenced +2.25 / reviews +1.68 / workgroup +2.47） |
| 34827977388 | 602264d5 | FAIL（repos-first +2.73 / reviews +1.59） |
| 34831180498 | 602264d5 | FAIL（repos-first +2.95 / repos-referenced +2.29 / reviews +2.08） |
| 34836852462 | dfb49eb8 | **FAIL —— 只红在 `workgroup-pending` +23.87** |
| 34883382647 | 56713f37 | **FAIL —— 只红在 `workgroup-pending` +24.93** |
| 34886209256 | 7f51454f2 | **PASS** |
| 34887363759 | 6b964e174 | **PASS** |
| 34887767993 | 4099bb1e0 | **PASS** |

两件事同时成立：

1. **真回归被单独抓住**。§5eu 那个 generic-plan 全表扫在新判据下**单独**红在
   `workgroup-pending` 上——而它当时在 P95 判据下淹在 4~6 个翻号的假红里，没人看得出哪个是真的。
2. **修复后三个 run 全绿**，且前四个更早的 run 该红照红（那时 §5ej / §5ek 还没落地，
   `repos-first` / `reviews-pending` 确实更慢）。判据是一条**「不许比今天更差」的棘轮**，
   不是一条永远为真的空判据。

### 判据自身的判据

`rfc359-w12-performance-comparison.test.ts` 加四条（共 36 格全绿）：

- 中位数差超过登记值即红，且**红的就是超出的那一个**；
- 差在登记值以内是绿的（闸门卡在登记值上，不是卡在零）；
- **只把第 20 个样本推到 1000ms**：`postgresqlNoSlower` 全线翻红、中位数差全为 0、闸门仍绿
  ——这正是换判据的理由，也是实撞过的形态（`workgroup-pending` 修好后中位数 2.39ms，
  却被一个 5.59ms 的尾样本判红）；
- 登记值是 **exact 清单**（逐条钉死，改一个数就红）。

### 留在账上的事实

- **A 类没有工程解**（语料不变 + 结果精确）：PG 在 1 万~1.3 万行的精确计数上就是慢于进程内的
  SQLite。要更快只能改产品（维护计数器 / 近似计数），不在本 RFC 范围。
- **B 类有工程解但本轮不做**：4 条语句减到 2 条（合并两笔认证读、审计写离开请求路径），
  按实测单价估能砍掉约一半差距。登记值因此按**今天的**实测设，将来真去减往返时应当**下调**它。

## §5ez —— 新判据上线第一跑就红了，而红的是**我自己的登记值**：`tasks-second` 的差随机器档次变号

`070af2205` 的验收 run（`34909856404`）`acceptancePassed: false`，**只红一条**：
`tasks-second` 中位数差 **+3.778ms**，登记值 **0**。

### 先排除「是不是真回归」

`git diff --name-only 4099bb1e0 070af2205 -- packages/*/src/` **是空的**——上一次量到
`tasks-second −4.135ms` 到这一次之间，我**一行应用代码都没改**（三提分别是 W26 判据修复、
撤回文档、以及比较器自己）。所以这不可能是代码回归。

### 真因：这一跑抽到了一台快得多的机器，而 SQLite 从中获益远大于 PG

| | SQLite 中位数 | PG 中位数 | 差 |
| --- | --- | --- | --- |
| 前 8 个 run（EPYC 7763 / 9V74 / Xeon） | 39.3 ~ 48.5ms | 35.0 ~ 45.5ms | **−2.8 ~ −5.4ms** |
| `070af2205`（EPYC **9V45 96 核**） | **27.8ms** | **31.8ms** | **+4.0ms** |

同一份代码，SQLite 从 ~48ms 掉到 27.8ms（**−42%**），PG 只从 ~44ms 掉到 31.8ms（**−28%**）——
差因此**由负转正**。这是一条约 45ms 的重查询，SQLite 那一侧更吃 CPU，机器一快它赢得更多。

### 我的登记值错在**单位**，不是错在数值

把 9 个 run 的两种单位摊开比稳定性：

| 端点 | 毫秒差跨度 | 比值跨度 |
| --- | --- | --- |
| tasks-first | 34.44 | **0.116** |
| tasks-second | 9.35 | **0.262** |
| tasks-running | 17.54 | **0.152** |
| reviews-pending | **1.89** | 1.340 |
| clarify-pending | **1.10** | 0.860 |
| repos-first | **2.63** | 0.866 |

**重端点该用比例，轻端点该用毫秒**——两边正好相反。我给三个重端点一律登记「毫秒 0」，
是拿错了单位；前 8 个 run 碰巧都在较慢的机器上，才一直没现形。

### 改法：加一个**比例项**，而且只给真正需要它的那一条

判据改成 `medianGapMs <= medianAllowanceMs + medianAllowanceRatio × SQLite中位数`。

- `tasks-second`：`medianAllowanceRatio: 0.20`（实测上界 +0.143 加约 40% 余量），毫秒项仍为 0；
- `tasks-first`（−0.643 ~ −0.527）与 `tasks-running`（−0.560 ~ −0.408）**9 个 run 全负**，
  比例项保持 **0**——它们不需要放宽，保持紧判据；
- 六个轻端点比例项全 0，继续只用毫秒（比值在小绝对值上抖得厉害，见上表）。

**这不是把数字调到能过。** 判断依据是单位选错了（毫秒跨度 9.35 vs 比值跨度 0.262），
而且换单位之后**该红的照样红**——九个 run 回放：

```
948d9b5f / 602264d5 ×2   FAIL（repos-first / reviews-pending，§5ej·§5ek 之前确实更慢）
dfb49eb8 / 56713f37      FAIL —— 仍然只红在 workgroup-pending +23.87 / +24.93
7f51454f2 / 6b964e174 / 4099bb1e0 / 070af2205   PASS（含这台最快的机器）
```

### 值得记住的是判据**自己抓到了自己的毛病**

第一跑就把一条我校准错的登记值顶出来了，而且顶得很干净：单独一条、附中位数与登记值、
一眼能查。换成旧的 P95 判据，这一跑会有 3~4 条翻号的红，`tasks-second` 淹在里面。

新增判据一条，锁比例项的语义：语料放大 1 倍时 `tasks-second` 预算 2.2ms（5ms 的差判红）、
放大 4 倍时预算 8.8ms（同样 5ms 判绿），而毫秒项为 0 的 `tasks-first` 两种机器下预算都是 0。

## §5fa —— AC-10 第一波：品牌分叉 26 → 19，全是**可证无行为变化**的那一类

用户裁决 AC-11 收口之后，RFC 剩下的硬缺口里 AC-10 最明确：业务代码里 `provider === '<literal>'`
要为零，账上还有 14 个文件 / **26 处**。切了一个只读 agent 把 26 处逐条分类（按能力提问 /
收进组合根 / 可辨识联合 / 搬进白名单），本波只做**第一类**：证得出「改完行为逐字不变」的那些。

### 这一波做掉的 7 处（另加 1 处搬家债）

| 处置 | 站点 | 依据 |
| --- | --- | --- |
| **删死码** | `postgresqlProviderBackup.ts` 的 `options.runtime.provider !== 'postgresql'` | `options.runtime` 是 `PostgresqlDatabaseRuntime`，其 `provider` 是**字面量类型** `'postgresql'`（`postgresqlRuntime.ts:41`），该比较**恒假**，一行都跑不到 |
| **删死码** | `db/providerSchema.ts` 的 `concreteDatabaseColumn` | **全仓没有任何调用方**（只有自己的定义）。孪生的 `concreteDatabaseTable` 是活的（`schemaContract.ts` 在用），保留 |
| **删摆设标签** | `main.ts` 的 `provider === 'sqlite' ? {provider:'sqlite',db} : {provider:'postgresql',db}` | `FrameBackfillDatabase` 联合的两个成员**结构逐字相同**，而 `runFrameBackfillOnBoot` **从不读** `database.provider`（只用 `database.db`）——W4-B1 存储合一后它就只是个摆设，却逼着调用方写这条三元。标签一删，分叉自然消失 |
| **问能力** ×4 | `databaseMigrationCoordinator.ts:315`、`databaseMigrationDaemonAdmission.ts:243/:284`、`postgresqlProviderBackup.ts:80` | 全部换成 `databaseProviderTraits(...).migrationRole`（`sqlite ⇒ source` / `postgresql ⇒ target`）。**三个文件都已有同名判据的在文先例**——coordinator 的 `:719` / `:729` 早就用 `migrationRole === 'target'` 抛同一个错误码，admission 的 `:237` 早就问 `migrationRole === 'source'`；这几处是最后的手写孪生 |
| **类型层** | `server.ts` 的 `TProvider extends 'postgresql' ? Pg… : …` | 换成按 provider 索引的表。`extends Record<DatabaseProvider, …>` 这条约束**就是** forcing function：往 `DatabaseProvider` 加成员，接口立刻编译不过 |

账本：`PROVIDER_BRANCH_DEBT` 14 → 10 条（26 → 19 处），
`PROVIDER_BRANCH_RELOCATION_DEBT` **1 → 0（清空）**，
`PROVIDER_FORK_LEDGER` 的 `db/providerSchema.ts` 条目退役、`main.ts` 3 → 2。

### 一条守卫替我挡住了漏改

`rfc359-w29-unstarted-application-composition` 对 `composePostgresqlApplication` 的**函数体**做
sha256 内容锁。改完 frameBackfill 调用它立刻红——而且红得恰到好处：
**语句数仍是 160、顺序未变**，只有摘要变了，正说明改的是一个实参而不是结构。
摘要随之更新并写明原因（判据继续锁住「结构没动」这一半）。

### 顺带记一条 census 的连带涨

`postgresqlProviderBackup.ts` 新增一条 `providerTraits` 的 import，于是
`rfc294-cross-context-observed-imports` 与 `rfc294-architecture-exceptions` 各 +1。
按守卫要求写了 `allowGrowth` 并点名本波：涨的是一条边，换掉的是一处品牌分叉，
而且同域两个文件早有同一条 import，**边的形状是既有先例，不是新开的耦合**。

### 第二波（同一提）：再销 3 处，`cli/database.ts` 清零

新增两个 traits 字段，把两处**调用方现场拼的品牌三元**收回到「各引擎各声明一次」：

| 新字段 | 原写法 | 含义 |
| --- | --- | --- |
| `serverVersionFallback` | `provider === 'sqlite' ? 'embedded SQLite' : 'unavailable'` | `db info` 取不到服务端版本时显示什么 |
| `failureRecoveryHint` | `storage === 'embedded-file' ? ' — recover: …' : ''` | provider 自检失败时给用户的下一步（没有就是 `null`） |

外加 `cli/database.ts` 的 `--to`：原来直接比 `flag(argv,'--to') !== 'postgresql'`，
现在先把它解析成 `DatabaseProvider`、再问 `migrationRole === 'target'`。差别不只是形状——
**原来第三个 provider 会被一句写死 PostgreSQL 的话拒绝掉**（「--to postgresql is required」），
而不是被「这个 provider 不能当迁移目标」拒绝。

`PROVIDER_BRANCH_DEBT` 再 → 9 条（19 → 16 处），`cli/database.ts` 在两份账本里都清零退役。

**这三处原本一处覆盖都没有**（agent 扫出来的：那句拒绝语全仓只出现在它自己的定义处，
`db info` 的 `server:` 行也从没被断言过）。所以补了三条判据：
`--to` 认不出的值 / 不能当目标的值都要被拒**且拒在任何 operations 调用与取锁之前**；
`sqlite` 被拒时**不得**再出现「SQLite remains the default provider」那句话——
这一条同时锁住「判的是能力不是名字」；以及 `server:` 行确实走 traits 的兜底。

顺带一条测试写法的坑：那条兜底断言不能塞进现成的 status 用例——多跑一次 `databaseCommand`
就多记一次 `overview`，把同一用例后面的调用序列断言打乱。单独用例 + 单独 fixture 才干净。

### 第三波（同一提）：`storage` 这一档也不算终点

`cli/dbCompact.ts:55` 与 `cli/doctor.ts:136` 早已不问品牌名了，问的是
`databaseProviderTraits(...).storage === 'embedded-file'`——**但它们仍然在账上**，因为
`storage` 的两个取值也在 `PROVIDER_VOCABULARY` 里。守卫的头注把理由写得很清楚：
它比品牌名好一档（问的是能力而非名字），但在本仓它的值域恰好只有两个成员、与品牌一一对应，
**今天仍是同一张真值表的另一种拼法**，第三个 provider 照样只能落进其中一边。

终点是「**字段本身就是答案**」，不是「换一个两值枚举再比一次」：

| 新字段 | 原写法 | 为什么这是答案 |
| --- | --- | --- |
| `offlineCompaction` | `storage !== 'embedded-file'` + 调用方写死「PostgreSQL」文案 | 能压缩就是 `{supported:true}`；不能就连**要对用户说的那句话**一起给（`explain(generationId)`），逐字保留原文案 |
| `absentLocalStoreMessage` | `storage === 'embedded-file' && !existsSync(...)`，且那句话写死「SQLite」 | `null` 直接表达「这个引擎没有本地库文件这回事」，调用方连 `existsSync` 都不必做——**判据与文案是同一件事**，一起声明 |

`PROVIDER_BRANCH_DEBT` 9 → 8 条（16 → 14 处），`cli/dbCompact.ts` 清零。

### 死适配器账本清零：最后一条是「**伪装成 provider 对等**」的典型

`DEAD_PROVIDER_ADAPTER_DEBT` 最后一条 `server.ts::composeSqliteProviderAppDeps` ——
全仓**零引用**（连测试都没有）的同义包装：PG bootstrap 走并列的 `composePostgresqlAppDeps`，
SQLite bootstrap 走的是**另一个**函数 `composeSqliteAppDeps`，从不经过它。
名字并排摆着，看上去两个 provider 各有一份入口，实际只有一侧在跑——这条判据抓的就是这个。
（W8 清理批当时跳过它的唯一原因是 `server.ts` 正被并发改动持有。）

删掉之后两条**扫描下界**跟着降，都按各自注释里写的规矩办（只降不升 + 记实测值）：
`adapter-production-consumer` 114 → 113、`identical-provider-twins` 116 → 115。

**顺带一个我自己踩的坑**：删函数时把它上面那行 JSDoc 一起删了，而那行
`/** Named production entry points … */` 是 `rfc349-daemon-provider-core` 用来切片源码的
**区段标记**（`source.indexOf('/** Named production entry points', composeStart)`），
删掉后那条判据拿到 `-1` 直接红。它描述的是「具名生产入口」这一段、而不是被删的那一个函数，
所以正确处置是把它移到仍然存活的 `composePostgresqlAppDeps` 上方，不是连它一起删。
**删死代码时，附近的注释未必属于它**。

### 剩下 14 处：两件必须先问过用户的事

1. ~~**两份守卫互相矛盾**~~ —— **这条我说错了，撤回。** 再读一遍两边的原文就不矛盾：

   · `rfc349-provider-completeness.test.ts:77-80` 禁的是**一条具体路线**——
     「do not **'simplify' these into traits lookups**」。它的理由是这三处的字面量同时在
     收窄一个 provider-keyed 的可辨识联合，**调用方**构造不出第三个 provider 就编译不过；
     换成运行期 traits 查表反而把这条强围栏**削弱**了。同一段开头还写着
     「A fork is not automatically a bug」。
   · `W5-T19` 的头注给的销账方式是**两条**：「把分叉改成按能力提问，**或收进组合根装配一次**」。

   也就是说：被禁的是 traits 那条，而**组合根那条没被禁**——两份账本可以同时满足。
   我把「禁其中一条路线」读成了「两条判据打架」，不该把它当成需要用户裁决的事推给用户。

   **实际结论没变，但理由要换成真的那个**：这三处该走**组合根**路线（把 store /
   payloadSources / supervisor / init 消息的选择上提到 `cli/start.ts` 与
   `cli/postgresqlDaemonApplication.ts` 两个 bootstrap，让 `MaintenanceServiceOptions`
   退化成单一形状）。不在本轮做的原因是**覆盖面**：`startMaintenanceService` **零运行时覆盖**
   （没有任何测试 import 它，`MaintenanceServiceOptions` 两个变体都没被测试构造过），
   唯一的网是 `rfc338-maintenance-architecture` 对 `cli/start.ts` 的一条正则。
   在那上面做组合根上提是无网作业——先补网。
### `main.ts` 清零：那条分叉里藏着一次**算完就丢**的求值

`main.ts` 的两支看着是「PG 不用传参、SQLite 要传 `migrationsFolder`」，于是 SQLite 那支写了
`openClient({ migrationsFolder: await resolveMigrationsFolder() })`。**但那次求值的结果直接被丢弃**：

`prepareDatabaseProviderForBoot` 在 `openDb({ ...options.sqliteOptions, path })` 这一步**已经
用同一个值把库打开**，并把 client 一路 adopt 进 runtime（`composeSqliteProviderRuntime` 的
`let client = initialClient`）。所以 `openClient(input)` 里 `client ??= openDb(...)` 的左侧非空，
**`input` 根本不看**。也就是说这条分叉不仅是品牌分叉，还让启动路径多做了一次
`resolveMigrationsFolder()`（在单二进制形态下那是可能要**解压迁移目录**的操作）。

处置与上一刀同一个形状：由 `prepareDatabaseProviderForBoot`（白名单层、品牌已知处）交出
`openBootstrapClient()`，调用方连「哪个 provider 要传什么」都不必知道。两支合一。

连带一处**围栏的喂法**要改：收窄的对象不再是可辨识联合了，所以两处
`unhandledDatabaseProvider(provider)` 改成喂 `provider.provider`——那个值排除两个字面量之后
才是 `never`。这不是将就，是把围栏喂给**真正在分类的那个量**。

`PROVIDER_BRANCH_DEBT` 7 → 6 条（13 → 11 处），`main.ts` 在两份账本里都清零。

### WAL checkpoint 那道闸：顺带把一条**层间依赖**也拆了

`maintenanceService.ts:601` 原来写的是
`options.provider !== 'postgresql' && isDbSnapshotInProgress()`——除了品牌分叉，它还让这个
**中立的后台服务**直接 import 了 `platform/persistence/sqlite/systemProviderBackup`。

问题其实是「此刻是否正在对这个库做**文件级**快照」（正在做就别发 WAL checkpoint，两者抢同一份
文件）。答案由**装配方**给：SQLite 侧给 `isDbSnapshotInProgress`，外部服务器侧给 `() => false`
——它的存储在服务端，根本没有「本地文件快照」这回事。**与原行为逐字一致**：PG 原本就从不因此
跳过（原式里 `provider !== 'postgresql'` 为假，整个条件恒假）。

顺带 `maintenanceService.ts` 不再 import 任何 sqlite 专属模块。

这一条**不减账本条目数**（那一行的站点数 3 → 2），但它减的是 11 → 10 处。
余下那 2 处是 provider-keyed 可辨识联合的收窄，销账走组合根上提（不是 traits 查表），
要连同注入接缝一起做——`startMaintenanceService` 直接 `import` 了 supervisor、没有接缝，
这正是它零覆盖的原因，**加接缝和消分叉本来就是同一件事**。

### 顺手清掉一处**守卫看不见**的「落进 else」

`MaintenanceServiceOptions` 的 SQLite 变体原本是 `provider?: 'sqlite'`（**可选**），
消费端写成 `databaseProviderTraits(options.provider ?? 'sqlite')`。这**不被 W5-T19 计债**
（它数的是等值比较 / switch / 条件类型，`??` 不在其内），但它正是本 RFC 要消灭的那个形状——
「没写就静默当成 SQLite」，只不过穿的是 `??` 而不是 `if`。

改成**必填**之后，编译器当场把唯一依赖那个默认的调用点顶了出来
（`cli/start.ts:2633`，`Property 'provider' is missing`）——forcing function 立刻生效。
配置层的零配置默认不受影响（`config.json` 不写 database 仍然是 sqlite，那是 zod 的
`.default()`）；这里是**内部装配选项**，而装配方本来就知道自己在装哪个 provider。

**账本计数不变**（本来就没计它），但这正说明账本只是**下界**：
账面清零不等于品牌分叉清零，`??` / 默认参数 / 可选字段这类「静默继承」守卫都看不见。

2. **`taskExecutionPersistence.ts:216/:218`(2 处)——两个分支行为并不等价。**
   SQLite 侧 `interruptBootOrphanTask` 走 `trySetTaskStatus` 的**宽**判据，PG 侧走
   `taskLifecycle.trySetWithGuard`；源码 `:115-119` 明写这条不对称，且
   `rfc359-w17-boot-orphan-terminalization` 的 skip-intent / skip-record 两条**正是在锁它**。
   合并它等于裁掉「开机孤儿终态化用哪条判据」，是用户可见行为决策，应当单独立项。

其余 14 处（cli/doctor·dbCompact·migrate·database、main.ts 余下 2、start.ts、composition.ts、
maintenanceService.ts:601）是可做的工程，按难度分波，其中 6 处**当前零测试覆盖**，
要先补测试再动——这一波刻意没碰它们。

## §5fb —— AC-10 第六波：`taskExecutionPersistence` 的 2 处，**本 RFC 第一条真正改了用户可见行为的合一**

§5fa 收尾时把这条明确挂起了，原话是「合并它等于裁掉『开机孤儿终态化用哪条判据』，
是用户可见行为决策，应当单独立项」。这一波不再等——用户对本 RFC 的立项原话就是判据本身：
**「我要的是，数据库统一抽象，以后不允许再出现两种数据库一个好一个不好的分支」**。
「哪条判据」这个问题，在「两条判据里有一条更弱」的前提下不需要再问一次。

### 先把差异数清楚：不是 1 条，是 3 条，而且**方向相反**

账本记的是 `createTaskExecutionPersistence` 里那道分派三元（2 处等值比较）。但分派存在的**理由**
是两份 persistence 聚合不同，而两份聚合的**唯一**差别是恢复管理面
（`create{Sqlite,Postgresql}RecoveryAdministration`）。这两个工厂各有四个方法，
`interruptNodeRun` / `interruptPeriodicTaskIfIdle` 逐字相同，另外两个各不相同：

| 方法 | SQLite | PostgreSQL | 谁更弱 |
| --- | --- | --- | --- |
| `interruptBootOrphanTask` 的**判据** | `'unchecked'`：终态化的 UPDATE 写没写进去都当成功 | `'require-returned-rows'`：写回行数对不上就 `task-continuation-stale` 整笔回滚 | **SQLite** |
| `interruptBootOrphanTask` 的**时钟** | 漏传 `now`，落到 `args.now ?? Date.now()` 的兜底 | 显式传 `now: input.now` | **SQLite** |
| `interruptBootOrphanTask` 的**次序** | companion 写在任务行**之后** | companion 写在任务行**之前** | 无优劣，但必须一致 |
| `repairRuntimeSessionLeaseAfterOrphanReap` | 走共享 lease 原语，每笔 release / discard 都过 `fenceTaskWrite` 归属闸 | 走一份**手抄**的事务内联版，抄的时候把闸漏了 | **PostgreSQL** |

也就是说这不是「PG 严、SQLite 松」这么简单——**每个引擎各有一处比对方弱**，
正好是用户那句话描述的病灶本身。

时钟那条尤其不像设计决策：SQLite 分支把 `input.now` 传给了 `finishedAt`，却**没有**传给
`trySetTaskStatus` 的 `now`，于是同一行里 `finishedAt` 记调用方时钟、`runningMs` 记墙上时钟，
两个瞬间对不上。这是漏传，不是取舍。

### 收敛：各自取强的一侧，两份聚合随之逐字相同

- 判据取严 —— 两个引擎都走 `terminalizeTaskExecutionIntentsInTx`（`'require-returned-rows'`）。
  强判据在 SQLite 上**早就被证明可跑**：同一个文件里
  `rfc359-w17` 的「异步 companion 保持严判据」两条本来就是双引擎跑的，SQLite 侧一直绿。
- 时钟取调用方 —— 统一走 `taskLifecycle.trySetWithGuard` 并显式传 `now: input.now`。
- 次序随之统一为 companion 先写（`trySetWithGuard` 的 `guard?.(tx)` 在任务行写入之前）。
- 归属闸两边都过 —— 统一走共享的 `runtimeSessionLeaseOperations.repairAfterOrphanReap`，
  手抄件 `repairRuntimeSessionLeaseAfterOrphanReapTx`（75 行）删除，它的**唯一**生产调用方
  就是被收掉的那条 PG 分支。

四个方法于是一个 provider 名都不问，`createRecoveryAdministration` 收成一份中立实现；
两份聚合逐字相同，分派三元与那道 `unhandledDatabaseProvider` 穷尽性围栏一并消失。

### 守卫当场咬住了中间形态，处方也是它给的

第一版改完把 `create{Sqlite,Postgresql}TaskExecutionPersistence` 留成了两个薄别名——
函数体逐字相同、只有形参类型不同。`rfc359-w5-identical-provider-twins` 立刻红：

> 有一对 provider 命名的函数，函数体**逐字节相同**——那不是两台机器，是同一台机器抄了两遍名字。
> 把形参放宽到 `ProviderNeutralDatabase`、收成一份，两个装配根都装它。

照办：收成一份 `createTaskExecutionPersistence(db: ProviderNeutralDatabase)`，十四个调用点改名。
**这条守卫是自己写的账本第一次反过来改我的设计**，值得记一笔——它挡住的正是
「账面清零、形状还在」这种假销账。

### 判据变化都落在测试里，不是悄悄改的

`rfc359-w17-boot-orphan-terminalization` 此前的标题叫「keeps its own accounting clock,
companion phase and post-commit publication」——它**就是**这三条不对称的纪念碑，
三处断言都写着 `harness.capabilities.isolation === 'exclusive' ? A : B`。现在三处全部去掉分支：

- 时钟：`Date.now()` 仍被 mock 成 `WALL_NOW`，而 `runningMs` / 事件时间戳必须是 `INPUT_NOW`。
  这个 spy 从「记录差异」变成了**证据**——证明调用方传入的 `now` 真的被用上。
- 次序：触发器看到的 `tasks.status` 两个引擎都是 `running`。
- 判据：原来那条 `'%s retains the existing returned-row branch'` 改名为
  `'a swallowed %s write fails the whole boot recovery on both engines'`——
  被触发器吞掉写入时两个引擎都 `task-continuation-stale` 整笔回滚。
  **改判据前 SQLite 侧的行为是**：任务落到 `interrupted`、intent 却还留在 `pending`、事件照发，
  且调用方收到 `true`。这是一条真实的用户可见缺陷，只是它一直被写成「既有行为」锁着。

`rfc359-w4-b1-batch2e-adapters` 里四处对手抄件的调用改指共享原语，
四条断言（复用 ⇒ 1 / 作废 ⇒ 1 / 未终态 ⇒ 0 / 无租约 ⇒ 0）一条没改，两个引擎各跑一遍。

### 账本

`PROVIDER_BRANCH_DEBT` 6 → 5 条目 / 10 → 8 处；`ledger-baselines.json` 的
`rfc359-w5-provider-branch` 基线 6 → 5。provider 命名函数语料一次退四个
（两个恢复管理面工厂 + 两个带品牌的聚合入口）：
`rfc359-w5-identical-provider-twins` 115 → **111**、
`rfc359-w5-adapter-production-consumer` 113 → **111**，两处都按只降不升记下实测值。

## §5fc —— AC-10 第七波：`maintenanceService` 的 2 处，**消分叉与补覆盖是同一件事**

§5fa 收尾时对这两处的判断是「provider-keyed 可辨识联合的收窄，销账走组合根上提，不是 traits
查表」，并且指出 `startMaintenanceService` 直接 `import` 监工、没有接缝，**这正是它零覆盖的
原因**。这一波把这句话当施工图用。

### 判别联合这个辩护，只对了一半

源码里原本写着一段辩护：这两处 `options.provider === 'postgresql'` 是故意的，因为
`MaintenanceServiceOptions` 是按该字面量判别的联合，比较同时把 `store` / `database` /
`generationId` 收窄出来；第三个 provider 不加自己的变体就到不了这里，**这比 traits 查表更强，
不是更弱**。

作为**类型**论证这是对的。但它回答错了问题：「谁来装」本来就该由**装配方**回答一次，而不是
把两套装配参数一起塞进选项、让服务自己挑一套。而且两个调用点（`cli/start.ts` 的 :512 与
:2637）**本来就各自知道自己在装哪个 provider**——答案在调用点是已知的，却被打包成联合
运过来，在服务体内又问了两遍。

### 改成交答案：两个工厂

```
openAdmissionStore: (config) => { store, close? }
startSupervisor:    (config, { onDelta, onEvent }) => MaintenanceWorkerSupervisor
```

- SQLite 侧：`openAdmissionStore` 开那条**短等待**准入连接（`journalMode: 'preserve'`、
  `busyTimeoutMs: 5`，绝不借用前台请求连接）并交出 `close`；`startSupervisor` 起带
  `dbPath` / `migrationsFolder` / `sqlite{…}` 的监工。
- 外部服务器侧：`openAdmissionStore` 直接给已验证代上组好的 store，**没有本地连接可关**，
  `close` 整个省略；`startSupervisor` 起带 `generationId` / `database` 的监工。
- `provider` 字段保留，但只作 traits 查表用（`databaseProviderTraits(...).classifyRetryable`），
  **不再有任何分支读它**。
- 两个工厂都收 live config，服务传的是**同一个对象**（不是「值相等的另一次读取」）——
  否则 config 在两次读取之间被改写时，准入连接和 Worker 会按不同参数跑。

`ADMISSION_BUSY_TIMEOUT_MS` 跟着连接搬到 `cli/start.ts`：只有本地库文件形态才有「忙等」
这回事，它住在中立服务里本身就是错位。

### 接缝落地当天就把零覆盖补上了

新增 `rfc359-ac10-maintenance-service-seam.test.ts`，锁的都是**穿过接缝的功能接线**：

| 判据 | 变异验证 |
| --- | --- |
| 两个工厂各调一次、拿到**同一个** live config | 把 `startSupervisor(currentConfig, …)` 改成 `startSupervisor(options.loadConfig(), …)` ⇒ 红 |
| 准入真的落在装配方交出的 store 上（`runSoon` → `enqueue`） | — |
| 监工的 delta / event 真的接回服务回调 | — |
| `stop()` 关准入连接、停监工；**省略 `close` 的形态照样停得下来** | 删掉 `admissionStore.close?.()` ⇒ 红 2 格 |
| `stop()` 幂等 | 同上 |

第一条一开始写成 `toEqual`（深比较），**变异跑下来没红**——`loadConfig()` 重读一次也会得到
值相等的对象，而那正是这条要挡的形状。改成 `toBe` 才咬得动。**判据写完要拿变异验一遍**，
不然「绿」只说明它没坏，不说明它有预言力。

另有一条既有判据跟着连接搬家：`rfc338-maintenance-architecture` 原本断言
`service` 里含 `journalMode: 'preserve'`，现在改成断言 service 里**没有**它、而
`start.ts` 的 `openAdmissionStore` 里有——锁的东西没变（准入连接绝不改日志模式），
只是跟到它现在所在的文件。

### 账本

`PROVIDER_BRANCH_DEBT` 5 → 4 条目 / 8 → 6 处；`ledger-baselines.json` 的
`rfc359-w5-provider-branch` 基线 5 → 4；`rfc349-provider-completeness` 的
`PROVIDER_FORK_LEDGER` 里 `maintenanceService.ts: { forks: 2 }` 整条退役。

余下 6 处：`cli/start.ts` 2、`modules/system-operations/composition.ts` 2、`cli/doctor.ts` 1、
`platform/background/maintenanceWorkerSupervisor.ts` 1。其中监工那一处的形状与本波同类
（判别联合 + 两套 Worker `init` 帧），但它拼的是**协议线格式**（`MaintenanceWorkerInitSchema`
是 strict 联合），收敛要连帧的装配一起上提，单独一波做。

## §5fd —— AC-10 第八波：`cli/start.ts` 清零，两处用了**两条不同的处方**

余下站点里这两处挨在同一个文件，但它们不是同一类问题，硬套同一条处方都会走偏。

### 一、预打开的暂存恢复：traits 放答案，不放机械

原来写成：

```
if (databaseProviderTraits(bootGenerationPayload.provider).storage === 'embedded-file') {
  const applied = await applyPendingRestoreIfAny({ …, postOpenRecovery: composeSqlitePostRestoreRecovery() })
}
```

`storage` 比品牌名好一档，但它仍是**两值枚举**——同一张真值表的另一种拼法，第三个 provider
照样只能落进其中一边。前几波对付这种形状的处方是「把答案声明进 traits」
（`offlineCompaction` / `absentLocalStoreMessage`），**但这一处套不上**：
答案不是一句话，是一段 SQLite 恢复机械（`applyPendingRestoreIfAny` + `composeSqlitePostRestoreRecovery`），
而 traits 表里放的是**答案**，不是**机械**。把机械塞进 traits 只会让那张表开始 import 引擎实现。

走另一条既有处方：**按 provider 查表**。`start.ts` 里紧挨着就有同一个形状的先例
（`composeDaemonProviderSession` 的 `composers` 表），照抄它：

```
const PRE_OPEN_STAGED_RESTORE = {
  sqlite: async (input) => await applyPendingRestoreIfAny({ …, postOpenRecovery: composeSqlitePostRestoreRecovery() }),
  postgresql: async () => false,   // 存储在服务端，没有「库文件旁边暂存一个目录」这回事
} satisfies Record<DatabaseProvider, (input: …) => Promise<boolean>>
```

`satisfies Record<DatabaseProvider, …>` 就是 forcing function：少一个 provider 编译不过。
PG 侧恒为「什么都没应用」，与原来「不进这个分支」逐字同义。

这一步**必须跑在库被打开之前**，所以它不能等到会话装配之后再做——这也是它当初只能写在
共享启动路径上、而不是各自会话里的原因。

### 二、配置收窄：判定没问题，住错了地方

`requirePostgresqlConfig`（`config.database.provider !== 'postgresql'` 就抛）表达的不变量是对的
——运行时选了 PG，配置也必须是 PG 那一支。问题在于它手写在 **daemon 入口**里，
而 `platform/persistence/` 里**紧挨着的 `requireDatabaseProviderRuntime` 早就是同一个形状**
（重载 + 品牌不符就抛）。这属于账本里「搬家」那一类：销账方式不是重写判据，是把它搬到
它本该在的那一层。

搬成 `requireDatabaseConfig` 的重载孪生之后，两条收窄同一个名字家族、同一种错误文案，
入口只剩一次调用。

### 账本

`PROVIDER_BRANCH_DEBT` 4 → 3 条目 / 6 → 4 处；`ledger-baselines` 的
`rfc359-w5-provider-branch` 基线 4 → 3。

余下 4 处：`modules/system-operations/composition.ts` 2（两套完整模块装配，组合根上提）、
`cli/doctor.ts` 1（按 provider 选体检项清单）、
`platform/background/maintenanceWorkerSupervisor.ts` 1（判别联合 + 两套 Worker `init` **线格式**帧，
`MaintenanceWorkerInitSchema` 是 strict 联合，收敛要连帧的装配一起上提）。

### §5fd 续：`system-operations/composition.ts` 2 → 1，以及两条守卫账本的连带归零

搬家过的 `requireDatabaseConfig` 落地当天就有了第二个消费者：
`modules/system-operations/composition.ts` 里同一形状的内层收窄
（`if (databaseConfig.provider !== 'postgresql') throw`）改成调它。余下 1 处是外层的组合根
选择（两套完整模块装配），销账走组合根上提，不在本波。

本波顺带让另外两条守卫账本归零 / 下调，两条都是**账本自己写好的退役条件**兑现：

- `rfc359-w5-t19c` 的 `PROVIDER_EXECUTION_BRANCH_DEBT` **归零**。那条唯一记账
  （`storage === 'embedded-file'` 的冷恢复）旁边写着正解：「一个中立的 boot-restore 端口 +
  两个适配器，由中立序列调用一次；届时这条记账连同 `if` 一起删掉，账本改成空表」。
  `PRE_OPEN_STAGED_RESTORE` 就是那张表，照做即退役。
- 同文件的**真语料存活下限** 2 → 1（实测 1）。原话是「这个文件里至少有两处『拒绝装配』的
  provider 收窄」——那两处正是本波销掉的。今天剩下的唯一一处是
  `databaseProviderTraits(lifecycleInput.provider).migrationRole !== 'target'`。
  下调时写清了一件要紧事：**判据存活的主证据不是它**，是文件末尾那组负向 fixture
  （喂伪造源码，不随生产代码收敛而失效）；真语料这条只是二次确认，可以跟着生产代码往下走，
  但**不许走到 0**——走到 0 就该换一份真语料，而不是默默接受假绿。

搬家带来的一条新 import 边（`composition.ts` → `databaseProviderRuntime`）在
`rfc294-cross-context-observed-imports` / `rfc294-architecture-exceptions` /
`rfc294-module-symbol-owners` 上按规矩写了 `allowGrowth` 并点名本 RFC。

## §5fe —— AC-10 第九波：`cli/doctor.ts` 清零，账本降到 **2 处**

原来是：

```
if (resolved.provider === 'sqlite') return [providerCheck, checkLifecycleHealth(), checkSealedCredentials()]
if (resolved.provider !== 'postgresql') return unhandledDatabaseProvider(resolved)   // 穷尽性围栏
return [providerCheck, await checkPostgresqlLifecycleHealth(resolved.runtime), …]
```

「这个引擎要体检哪几项」本来就该由**引擎各自声明一次**，而不是让 `doctor` 现场按品牌拐一下。
改成 `ENGINE_HEALTH_CHECKS` 查表，形状与本波前两处（`PRE_OPEN_STAGED_RESTORE` /
`composeDaemonProviderSession`）一致：

```
const ENGINE_HEALTH_CHECKS = {
  sqlite: async () => [checkLifecycleHealth(), checkSealedCredentials()],
  postgresql: async (resolved) => { const runtime = requireDatabaseProviderRuntime(resolved, 'postgresql').runtime; … },
} satisfies Record<DatabaseProvider, (resolved: ResolvedDatabaseProviderRuntime) => Promise<readonly CheckResult[]>>

return [providerCheck, ...(await ENGINE_HEALTH_CHECKS[resolved.provider](resolved))]
```

值得单记一笔的是**那道手写的 never 汇也跟着消失了**。原注释写「a third variant on
`ResolvedDatabaseProviderRuntime` widens this residual and stops compiling」——它确实是个
forcing function，但它是**手写**的一条 residual；换成 `satisfies Record<DatabaseProvider, …>`
之后，forcing function 由类型系统自带（少一格编译不过），手写围栏就成了冗余。
句柄收窄交给白名单层的 `requireDatabaseProviderRuntime`（与 `cli/start.ts` 同一个名字家族）。

也就是说：**穷尽性围栏按形状豁免不计债，但「不需要围栏」比「有围栏」更进一步**——
查表把「少一个 provider」从运行时抛错提前成了编译错。

### 账本

`PROVIDER_BRANCH_DEBT` 3 → 2 条目 / 3 → 2 处；`ledger-baselines` 的
`rfc359-w5-provider-branch` 3 → 2；`rfc349-provider-completeness` 的 `PROVIDER_FORK_LEDGER` 里
`cli/doctor.ts` 整条退役（fork 清零，围栏声明跟着删——没有 fork 就不该再声明围栏）。

**余下 2 处，都不是「按品牌拐一下」那一类，各自需要单独一波：**

1. `modules/system-operations/composition.ts` 1 —— 外层的**组合根选择**：
   `provider.provider === 'postgresql'` 之下是两套**完整的模块装配**
   （PG 侧 `composePostgresqlSystemOperations` 一次装好；SQLite 侧是一条带 `resolveDatabase()` /
   `resolveRestoreMigrations()` 的惰性装配）。这正是账本开账时归的「组合根装配」那一堆——
   「装配期按 provider 选一次实现」本该只发生一次，而这里就是那一次。销账要把两套装配各自
   收成一个组合根、由更外层选一次，不是在这里查表。
2. `platform/background/maintenanceWorkerSupervisor.ts` 1 —— 判别联合 + 两套 Worker `init`
   **线格式**帧。`MaintenanceWorkerInitSchema` 是 protocol 里的 strict 联合，两种帧字段互不相同；
   收敛要把「帧的连库那一半」交回装配方（监工只补协议头），连带十个调用点（2 生产 / 8 测试）
   一起改。形状与 §5fc 的维护服务同类，但它拼的是**进程间协议**，不是本进程装配，
   所以单独一波做、并且要连 `rfc338-maintenance-worker*` 的对拍一起走。

## §5ff —— AC-10 第十波：`system-operations/composition.ts` 清零，账本只剩 **1 处**

这一处是账本开账时归的「**组合根装配**」那一堆——账本原话：「『装配期按 provider 选一次实现』
本该只发生一次，今天迁移子命令的入参校验、doctor 的体检分支、backfill 的重打包各问了一遍」。
`composeLocalSystemOperations` 里这个 `if (provider.provider === 'postgresql') … else …`
**就是那合法的一次**，所以处方既不是「把答案声明进 traits」，也不是在原地查表判品牌——
那两条都只会把同一个分叉换个写法。正解是**把两支各自收成一个组合根**，由一张按
`DatabaseProvider` 穷举的表选一次：

```
const LOCAL_SYSTEM_OPERATIONS_COMPOSERS = {
  postgresql: composePostgresqlLocalSystemOperations,
  sqlite: composeSqliteLocalSystemOperations,
} satisfies Record<DatabaseProvider, (input: …) => ComposedLocalSystemOperations>

const { module, prepareRestoreArtifact } =
  LOCAL_SYSTEM_OPERATIONS_COMPOSERS[provider.provider]({ provider, databaseConfig, appHome, contract, … })
```

**两支的形状本来就不同，而且不该被抹平**——这是这一波唯一需要想清楚的事：

- 外部服务器侧**一次装好**：开客户端、组 workspace store、`composePostgresqlSystemOperations`。
- 本地库文件侧是**惰性**装配：`resolveDatabase()` / `resolveRestoreMigrations()` 到用时才开库、
  才解析迁移目录，`repositoryBackupPreparation` 也包成一层到调用时才 compose 的 facade。
  原因是 `doctor` / `restore` 这类路径**可能在库还不存在时就调到它**。

收成两个组合根之后这个差异仍然在，只是各自待在自己的函数里、不再靠一个 `if` 把两套装配
挤在同一个函数体内。顺带一件事：原来靠 `if` 隐式 narrow 出来的句柄，现在各自显式走
`requireDatabaseProviderRuntime(provider, '…')`——这也是它多出两条 import 边、
在 cross-context / exceptions 两本账上按规矩写 `allowGrowth` 的原因。

### 账本

`PROVIDER_BRANCH_DEBT` 2 → 1 条目 / 2 → 1 处；`ledger-baselines` 的
`rfc359-w5-provider-branch` 2 → 1；`rfc349-provider-completeness` 的 `PROVIDER_FORK_LEDGER` 里
该文件整条退役。

**余下 1 处：`platform/background/maintenanceWorkerSupervisor.ts`。**
它是两套 Worker `init` **线格式**帧——`MaintenanceWorkerInitSchema` 是 protocol 里的 strict
联合，两种帧字段互不相同。收敛的形状与 §5fc 的维护服务同类（把「帧的连库那一半」交回装配方，
监工只补协议头 `type` / `version` / `catalogDigest` / `appHome`），但它拼的是**进程间协议**
而不是本进程装配，改动面也大一档：十个调用点（2 生产 / 8 测试）加 `rfc338-maintenance-worker*`
的对拍。留作下一波。

## §5fg —— AC-10 第十一波：**品牌分叉账本清零**（开账 31 处 / 16 个文件 → 0）

最后一处是 `maintenanceWorkerSupervisor.ts`，也是十一波里**唯一一处拼的是进程间线格式**、
而不是本进程装配的。监工原来按 `options.provider === 'postgresql'` 决定发哪一种 Worker `init`
帧，而两种帧字段互不相同（`MaintenanceWorkerInitSchema` 是 protocol 里的 **strict** 联合）。

所以前几波的处方都套不上：它不是「能力差异」（做不成 traits），也不是「选实现」（不是查表
挑一段代码跑），它就是**两种线格式**。处方与 §5fc 的维护服务同类——**交答案**：

```
export type MaintenanceWorkerDatabaseInit =
  | Readonly<{ dbPath; migrationsFolder; sqlite: { synchronous; pageCacheMib; mmapMib; busyTimeoutMs } }>
  | Readonly<{ provider: 'postgresql'; generationId; database: {…} }>

post({ type: 'init', version, catalogDigest, appHome: options.appHome, ...options.databaseInit })
```

装配方把帧的**连库那一半**交出来，监工只补协议头（`type` / `version` / `catalogDigest` /
`appHome`）——协议头是监工的身份，不该让装配方拼。于是监工体内一个 provider 名都不问。

顺带 `sqlite.busyTimeoutMs` 从 `options.sqlite.busyTimeoutMs ?? 50` 的**静默默认**改成必填：
那正是本 RFC 一直在消灭的「落进 else 继承 SQLite 行为」，只不过它穿的是 `??` 而不是 `if`。
装配方本来就知道自己要多少，写出来。十个调用点（2 生产 / 8 测试）由编译器逐个顶出来。

### 一条差点被偷换的判据

批量改调用点时，正则把 `rfc349-system-maintenance-provider` 里**期望的 init 帧**也一起嵌套了
（它和调用点长得一样）。测试当场红——而这一红很要紧：`databaseInit` 是**装配方交给监工的入参
名**，帧本身仍然是 protocol 里那个扁平的 strict 联合。如果那条期望跟着改成嵌套，就等于把一次
**内部装配接缝**偷偷变成了一次**协议变更**。已恢复扁平，并在断言上方写明它锁的是帧、不是入参。

### 账本

`PROVIDER_BRANCH_DEBT` **清空**（1 → 0 条目 / 1 → 0 处）；`ledger-baselines` 的
`rfc359-w5-provider-branch` 基线 1 → **0**；`rfc349-provider-completeness` 的
`PROVIDER_FORK_LEDGER` 里该文件整条退役。

**AC-10 的判据是「业务 provider literal 分支为零」——账本至此逐字为零。**
（白名单目录 `platform/persistence/` 下的翻译层不计，那是设计上就该知道品牌的地方；
穷尽性围栏按形状本来就豁免，而本波之后连围栏都不剩几处——查表把「少一个 provider」
从运行时抛错提前成了编译错。）

## §5fh —— AC-1 的「完工线」有两份互相矛盾的定义，先对账、不擅自判定

清完 AC-10 之后顺手核了一遍 AC-1 的实测面，发现**判据本身自相矛盾**，记下来供下一刀（或用户）裁决。

### 实测（2026-09-15，`rfc359-w5-provider-pair-conformance` 12 pass / 0 fail）

- `DECLARED_CROSS_DIRECTORY_PAIRS` = **[]** —— 跨目录 + 改名那一类手工登记的对，已空
  （最后一对资源包 apply 引擎在 §5dv → §5dw → §5dy 收完）。
- `UNVERIFIED_PAIR_COUNT` = **0** —— 没有任何一对「连一份双引擎对拍都没有」。
- `PROVIDER_PAIR_COUNT` = **8** —— 仍成对共存的 provider 适配器对数。

八对逐条都**判过「不合」**并附了机制理由，且每对都有双引擎对拍：
`Migrator`（一侧把编号 SQL 文件逐条喂给 bun:sqlite，另一侧是生成代——硬合一等于把一侧的机制
塞进另一侧）、`ResourcePackageMaintenance`（`ArtifactRecovery` 那半边是两套**落盘工件格式**）、
`TaskExecutionRuntimeParticipants`（两台 children 引擎 + 两个 registry）、
`LogicalSource` / `SourceTerminationParticipant` / `ChildExecutionLaunchOperations` /
`TaskRouteOperations` / `TaskRouteLaunchOperations`（后几对已是薄转交或已合共同流程）。

### 矛盾在哪

- **AC-1 的判据原文**是「**已登记的机制差异保留对拍**，其余重复实现合一」。
  按这句话读：八对都是已登记的机制差异、都保留了对拍、跨目录缺口已空、未验证数为 0
  ⇒ **判据已满足**。
- 但 `PROVIDER_PAIR_COUNT` 的注释写的是「**只降不升**——降到 **0** 就是 RFC-359 的合一完工线」。
  按这句话读：还差 8 对 ⇒ **远未完工**。

这两句话对「什么叫做完」给的是两个答案。**不擅自选一个**——它直接决定 RFC 还剩多少工作量，
也决定那八对（含两套落盘格式、两台迁移器）要不要强行合一。需要的裁决是：

1. 采「判据原文」：八对是**永久性**的机制差异，`PROVIDER_PAIR_COUNT` 的注释应改成
   「降到**已登记机制差异的条数**即完工」，AC-1 随即可判 ✅；或
2. 采「注释」：八对里至少一部分仍要合，那就逐对给出**合一后机制怎么办**的方案
   （例如两套落盘工件格式如何统一、两台迁移器如何共用一条路径），再排波次。

在裁决前 AC-1 保持「进行中」，本节只做对账，不动任何判据数字。

### 补一条把冲突查实的证据（2026-09-15）

`PROVIDER_PAIR_COUNT` 到底在数什么，是可以查实的：守卫里它被断言等于
**`SCANNED_ROWS.length`**——机械扫描出的**全部**成对适配器，**不排除**已判「不合」的那几对。

所以「降到 0 是完工线」这句话，字面意思就是**连两台迁移器、两套落盘工件格式也要合掉**——
而这几对**恰恰是同一个文件里逐条写明「判不合」并给了机制理由的**。

于是三处记载里：**AC-1 判据原文**（已登记机制差异保留对拍）与**本文件的逐对裁决**（判不合）
**彼此一致**，只有 `PROVIDER_PAIR_COUNT` 的那句**总结性注释**与它们不一致。

**仍然没有擅自改任何一边**——把一个 AC 从「进行中」翻成 ✅ 是对**验收标准本身**的裁量，
那是用户的判断，不是我的。已做的是：把这个冲突**写到守卫的使用现场**
（`PROVIDER_PAIR_COUNT` 的注释上），让读这个数的人当场知道它**不是**「还欠多少合一」，
而是「还有多少对共存、其中含有意保留的几对」——此前这个冲突只在 plan 里可见，
在守卫现场是看不到的。

## §5fi —— AC-12 剩余占位的实测分类：判据**两个方向都不准**，数字暂时不是可信度量

同样是清完 AC-10 之后顺手核的。

**先更正一处我自己的清点错误**：`COMPOSITION_ROOT_PLACEHOLDER_DEBT` 今天是 **5 条**
（`cli/postgresqlDaemonApplication.ts` / `cli/start.ts` / `commandContext.ts` /
`taskEngineApplication.ts` / `server.ts`），不是 3 条——我先前只看了账本的一个窗口就报了 3。
逐条看下来**没有一条是「以后再补的装配槽」**：

### 一、两条 `marker` 是误报：它们是 token 注册表不变量，不是装配槽

`cli/start.ts:3155` 与 `cli/postgresqlDaemonApplication.ts:1765`，两处**逐字相同**：

```
const intentCatalogActors = new WeakMap<object, Actor>()
const intentResourceCatalogFor = composeIntentResourceCatalogFor({
  query: resourceCatalog.createQuery({
    resolveActor(context) {
      const actor = intentCatalogActors.get(context)
      if (actor === undefined) throw new Error('intent-resource-catalog-context-not-bound')
      return actor
    },
  }),
  contextFor(actor) { const context = …; intentCatalogActors.set(context, actor); return context },
  …
})
```

`contextFor` **铸出** context 并登记，`resolveActor` 读回——两者在**同一个对象字面量、同一个
作用域**里，没有任何东西是「以后再 bind」的。这一句 throw 守的是「传进来一个不是我们铸的
context」，是**不透明 token 的运行期不变量**，不是跨阶段装配缺口。

判据把它算进来，是因为 `marker` 形态只看错误码里有没有 `not-bound`。**处置不该是改名**——
账本自己写了这条判据存在的理由就是「**防改名逃逸**」，改名等于把守卫骗过去。正解是按**形状**
豁免（同 `unhandledDatabaseProvider` 的形状豁免）：`X.get(k)` 取不到就抛、而同一个字面量里
有兄弟方法做 `X.set(k, …)`。

**本轮没有动判据**：放宽一条守卫比修一处问题便宜，而这正是账本会失控的方向（账本自己的原话）。
加豁免要单独一刀、带负向 fixture（证明豁免不会把真的装配槽一起放过），不该夹在 AC-10 的尾巴里做。

顺带记一笔：这两处是**两个组合根里逐字相同的一段**，属于 AC-1 口径下的重复，只是它在组合根里、
不在成对适配器的机械检出面上。

### 二、`commandContext.ts` 的 prose=5 是**能力参数化**，不是缺装配

五句 `is not composed` 对应五个可选依赖（`artifacts` / `reviewDecisions` / `questionDispatches` /
`clarifyDecisions` / `taskExecutionReadModels`）。它们**确实是可选的**：
`infrastructure/review.ts:1078` 与 `:1598` 就只传 `{ db, appHome }`，造出的 context 本来就没有
那几个命令口。文件里的 `CollaborationContextCapability` / `Required<Pick<…>>` 那套类型机器，
正是为了表达「这个 context 带哪些能力」。

所以 ledger 注释里给的通用处方（「改必填，让缺口在类型层不可表达」）**在这一条上不适用**——
改必填会逼那两个只要读模型的调用点去现造五个命令口。真正的正解是把**能力**带进类型：
让「没有能力 C 的 context」在类型上就问不出 C，而不是运行期抛。那是一次 API 形状变更
（受影响面是 `CollaborationCommandContext<C>` 的全部调用方），**需要先定方向再动手**，
不是机械改写。

### 三、判据**另一个方向**也不准：已知有逃逸

账本自己记着一条盲点（`server.ts` 条目上方）：`server.ts:2525` 有一处与 PG 根
`digitalEmployee.runtime === null` **逐字同构**的兜底，只因文案写成
`'task catalog requires the digital employee runtime'`、不带 `not-bound|not-composed`，
**marker 与 prose 两条判据都咬不到它**。原话：「改名逃逸不是假想。」

### 结论：先别动这个数字

把两个方向合起来看：判据**既高估**（WeakMap token 注册表被算成占位）**又低估**
（同构的兜底因为文案不同而漏掉）。所以**占位计数现在不是一个可信的完工度量**。

更要紧的是：上面这些**前面的 session 已经逐条分析过并写进账本注释了**，而他们
**明知是误报也选择留着不豁免**。那是一个有意的保守决定，理由就写在账本的总则里——
「加一条豁免比修一处问题便宜，这正是账本会失控的方向」。在已经承认存在逃逸的前提下再加豁免，
等于把已知的盲区继续扩大。

**所以本轮不动判据、不加豁免、不改名、不改必填**，只把分类与取证落档。真要推进 AC-12，
需要的是一次**方向裁决**：
1. 是否接受「按形状豁免 token 注册表」，并同时**补上 `server.ts:2525` 那类文案逃逸**
   （两件事一起做才不会让账本更不准）；还是
2. 先做 `CollaborationCommandContext<C>` 的能力入类型（API 形状变更，影响全部调用方），
   把 prose=5 真正消掉，marker 那几条留作已知误报并在账本里显式标注。

## §5fj —— AC-6 尾巴的抽样取证：**四个候选，四种不同的真阻塞**，都通向生产侧

§5fh/§5fi 更正了 AC-6 的数字（真债 95 → **实测 27**）。这一节回答下一个问题：
**这 27 条是「还没动手」还是「动不了」？** 按体量从小到大抽了四条，逐条查根因——
结论是 plan 早前那句「继续压这个数字的正解不再是转换测试，而是逐对收生产侧的引擎（AC-1）」
**被抽样证实**，不是推测。

| 候选 | 体量 | 真阻塞 |
| --- | --- | --- |
| `start-task-deps.test.ts` | 62 行 / 2 例 | **生产签名是 SQLite 品牌**：`buildStartTaskDeps(db: LegacySqliteTaskDatabase, …)`。测试本身连库都没查（只断言 `deps.db` 恒等透传 + config 每次重读），**换 harness 一分钟的事**——但换完形参类型就不对。要先把 `StartTaskDeps.db` 那条链收中立。 |
| `rfc349-task-execution-read-models-postgresql-adapter.test.ts` | 192 行 / 4 例 | **它的「PG 覆盖」是脚本化假池**：`fixture(responses)` 造一个回放罐头行的 `PostgresqlPool`，断言的是**发出去的 SQL 文本**。迁到真 PG 不是换 harness，是**重写**——而且正是本 RFC 在别处批评过的那种「全部覆盖是脚本化 SQL 抄本」。 |
| `rfc221-login-policy-routes.test.ts` | 226 行 / 4 例 | **已经迁了大半**：文件第 19 行就是 `describeEachProviderHttpApplication`。只剩一例自己 `createInMemoryDb` + `createApp`，因为 `createApp` 的入参还是 SQLite 形状——源码里已写明「独立一刀，见 plan §5bg」。 |
| `rfc097-task-status-cas.test.ts` | 612 行 / 16 例 | 被测 helper（`setTaskStatus` / `trySetTaskStatus`）**是中立的、可迁**，但 CAS 竞态用例的做法是「在 helper 的 SELECT 与 UPDATE 之间插入竞争写者」——迁过去要**重新对齐两个引擎的并发语义**，是真工作。 |

四条里**没有一条是「转换器跑一下就行」**：三条卡在生产侧（品牌签名 / `createApp` 入参 /
假池本身就该换成真库），一条卡在并发语义。这与 plan 早前对 22 个候选实跑的结论一致
（只有 3 个能迁、8 个卡在 SQLite-only 生产签名上）。

**所以 AC-6 的销账节奏是被 AC-1 决定的**：每收一对生产侧引擎，下游那一串测试才跟着能迁。
在 §5fh 那个「完工线」裁决出来之前，硬压这个数字只会逼出两种坏做法——
要么给单个文件量身定做 sanctioned 豁免（账本明令禁止），要么把假池抄本当成「双引擎覆盖」。


## §5fk —— AC-6 第一条真迁：`rfc097-task-status-cas` 上双引擎，靠的是**换判据的造法**而不是换 harness

§5fj 把这条列为「可迁，但 CAS 竞态要重对齐两个引擎的并发语义——是真工作」。这一节把它做完了，
并且做法值得单记：**卡住的不是 harness，是「竞态怎么造」**。

### 原来的造法为什么在 PG 上会静默失效

旧版造竞态靠一个 db 代理：在 `transaction` / `run`（统一原语开事务发的第一条 `BEGIN IMMEDIATE`）
被调用的瞬间，**同步**插入竞争写者，再放行事务。文件头注释自己写明了前提：
「bun:sqlite 全同步（`.run()` 立即落库），时序 100% 确定」。

这个前提**只对 SQLite 成立**。PostgreSQL 驱动是异步的：同一个代理会在竞争写者**还在飞**的时候
就放行事务，CAS 的 `WHERE status = from` 照样命中、helper 照常成功——判据于是**静默退化成
「没有并发」**，而且是绿的。这正是本 RFC 一直在防的那种假绿：测试还在，预言力没了。

### 换成 helper 自己的注入点

`setTaskStatus` 里本来就有 `await args.beforeCas?.()`，位置在 SELECT + 双闸校验之后、
CAS 事务之前——**正是「SELECT 与 UPDATE 之间」**，而且**被 await**，所以两个引擎上都是确定时序。
改用它之后代理整个删掉，竞态由一行 `beforeCas: async () => { await …update… }` 造出来。

顺带给 `trySetTaskStatus` 的入参**补上 `beforeCas` 的类型声明**：它本来就把 `args` 原样转交给
`setTaskStatus`，运行时一直是通的，只是类型上没写——这是一处纯声明补全，零行为变化。

### 判据没有被稀释（变异验证）

把生产里那句 `await args.beforeCas?.()` 删掉重跑：**两个引擎的竞态用例共 4 格红**
（sqlite / postgresql × setTaskStatus / trySetTaskStatus）。说明新造法在**两个引擎上都真的咬**，
不是靠 SQLite 那半边撑着。

36 例 → 两引擎各 36 例，72 pass / 0 fail。

### 账本

`TEST_ENGINE_HARDCODING_DEBT` 333 → **332**（那处 `createInMemoryDb` 消失）；
`OPEN_MIGRATION_DEBT` 27 → **26**。

**这条给 AC-6 剩下 26 条提供了一个可复用的判据**：迁移前先问「这个测试的判据依赖哪个引擎的
执行模型？」——依赖同步落库、依赖 `.get()` 立即返回、依赖代理拦同步调用的，都不能直接换 harness，
要先找到一个**两个引擎都被 await 的注入点**；找不到就得先在生产侧开一个（像这次补 `beforeCas`
声明那样），而不是把判据降级。


## §5fl —— AC-6 第二条：卡住它的是一个**残留的品牌标注**，删掉即解（27 → 25）

`rfc291-closure-call-edges.test.ts` 此前是**半迁**状态：文件里已经有 `describeEachProvider`，
八条用例跑双引擎，但「freeze / dump 同解」两条被留在一个手写的 `registerNativeCases` 单引擎块里。

查下去发现，钉住它们的不是并发语义、也不是假池，而是一个**标注**：

```
export async function freezeCallClosure(db: DbClient, …)
```

而这个模块里 `DbClient` 只出现两次——`import` 和这一处形参标注；全模块**零** `.get()` /
`.run()` / `dbTxSync`。也就是说**函数体本来就是中立的**，`DbClient` 是个残留品牌。
形参放宽到 `ProviderNeutralDatabase` 之后 typecheck 直接过，**零生产调用点需要改**
（`DbClient` 是它的子类型，放宽向后兼容）。

两条用例随即移进 `registerProviderCases`，判据一条没改（freeze 侧与 dump 侧必须选出同一行）。
`registerNativeCases` 连同它那组模块级可变夹具槽成了死代码，一起删除——最后那个「复杂度与收口」
块是纯源码文本断言、一行库都不读，此前挂在 native 上是在**白建一个内存库**。

实测 **9 例 → 17 例**（8 条 × 2 引擎 + 1 条源码文本断言只跑一次），17 pass / 0 fail。

### 这条与 §5fk 合起来给出 AC-6 的两种阻塞形态

| 形态 | 例子 | 处置 |
| --- | --- | --- |
| **判据依赖某引擎的执行模型** | §5fk 的 CAS 竞态（靠 bun:sqlite 同步落库） | 找一个**两个引擎都被 await** 的注入点；没有就去生产侧开一个；**必须变异验证** |
| **生产签名上的残留品牌标注** | 本条 `freezeCallClosure(db: DbClient)` | 确认函数体中立（零 `.get()`/`.run()`/`dbTxSync`）后**直接放宽**，向后兼容、零调用点改动 |

第二种是**便宜的**——先扫一遍剩下 25 条里有多少属于它，能一次收掉一批。
判据：`grep -c "DbClient" <生产文件>` 若只等于「import + 形参」两处，且模块内零同步游标，基本就是它。

### 账本

`TEST_ENGINE_HARDCODING_DEBT` 332 → **331**；`OPEN_MIGRATION_DEBT` 26 → **25**。


## §5fm —— AC-6 剩余 25 条的**完整分类**：三种阻塞，各自的处置不同

做完 §5fk / §5fl 两条之后，把剩下 25 条一次扫完分了类——**不再逐条现查**。
判据是机械的：文件里有没有 `.get()` / `.run()` / `setTimeout` / `createPostgresqlDatabaseClient`
/ `describeEachProvider`，以及 `createInMemoryDb` 的个数。

### 甲类：**已半迁**（9 条）——文件里已有 `describeEachProvider`，只剩一两处残留

`execution-contract-platform` / `rfc189-wg-round` / `rfc221-login-policy-routes` /
`rfc257-webhook-error-codes` / `rfc291-unavailable-mount` / `rfc310-pr7b-handover` /
`rfc311-repos-page` / `rfc311-task-page-fastpath` / `rfc359-w7-catalog-composition-roots`。

**但「半迁」不等于「差一步」**——逐个看残留的**用途**，又分成两支：

- **残留是真·待迁**：`rfc291-closure-call-edges`（§5fl 已收）就是这一支，被一个残留品牌标注钉住。
- **残留是有意为之**：
  - `rfc311-repos-page:336` 的注释直接写着「**而不是把这两条改成双引擎**」——它断言的是
    **SQLite 查询计划**；
  - `rfc359-w7-catalog-composition-roots:387` 显式 `selectDatabaseSchemaProvider('sqlite')`
    再建库——它测的**就是 SQLite 组合根**；
  - `rfc189-wg-round:108` 用 `partialMigrationsDir()`——**部分迁移集**，迁移 DDL 本就只对 SQLite 有意义。

这三条**不该迁**。但账本的规矩是「要么真迁、要么证明落进 sanctioned 类」，而 sanctioned
**必须是通用判据**（账本明令「不要为了让数字好看而加一条只为某个文件量身定做的判据」）。
所以它们今天卡在一个**规则缺口**上：理由正当、却没有一条通用判据能接住。
补判据要一次性想清楚形态（例如「断言查询计划的」「显式 pin provider 的」「喂部分迁移集的」），
**属于改判据、需要单独一刀**，不在本波。

### 乙类：**生产侧仍有同步游标**（`start-task-deps` 等）——AC-1 territory

`start-task-deps.test.ts` 看起来极便宜（62 行 / 2 例、连库都没查），但它拿到的
`StartTaskDeps.db` 类型是 `LegacySqliteTaskDatabase`（= `DbClient`），而消费它的
**`services/task.ts` 里有 12 处 `.get()` / `dbTxSync`**。只放宽 `buildStartTaskDeps` 的形参
是**说谎**——返回的 deps 会喂给一个真正需要同步游标的消费者。

**这一支的销账节奏由 AC-1 决定**，与 §5fj 的结论一致，只是现在有了确数（12）而不是推测。

### 丙类：**「PG 覆盖」是脚本化假池**（7 条 `rfc349-*` + oracle）

`rfc349-execution-contract-postgresql-adapter` / `…-peripheral-provider` /
`…-read-models-postgresql-adapter` / `…-task-execution-provider-adapters` /
`…-websocket-provider` / `…-daemon-provider-core` / `rfc349-dual-provider-behavior-oracle`。
它们都 import 了 `createPostgresqlDatabaseClient`，但喂的是回放罐头行的假池、断言发出去的 SQL 文本。
迁到真库**不是换 harness 是重写**（§5fj 已记）。

### 结论

25 条里真正「换个 harness 就行」的**已经没有了**——§5fk / §5fl 收的正是最后两条那类。
剩下的分别卡在：**判据缺口**（甲类里有意单引擎的几条）、**AC-1 的生产侧收敛**（乙类）、
**重写假池**（丙类）。三者都不是「再努力一点」能解决的，各自需要一次单独的决定或一次大改。


## §5fn —— **`PROVIDER_PAIR_COUNT` 有结构性盲区：只看得见「文件级」的对，同文件内的对一个都数不到**

这是 §5fm 往下追 AC-6 丙类时撞出来的，直接关系到 §5fh 那个「完工线」裁决——
**那个被争论的数字本身不完整。**

### 判据只认文件名

`providerPairs()` 的 `classify(path)` 取的是**文件名 stem**：

```
const PROVIDER_PREFIX = /^(legacySqlite|legacyPostgresql|sqlite|postgresql)(?=[A-Z])/
… const stem = base.slice(0, -'.ts'.length); const matched = PROVIDER_PREFIX.exec(stem)
```

所以「一对」的定义是**两个文件**：同目录下的 `sqliteX.ts` + `postgresqlX.ts`。
两份实现若写在**同一个文件里**（文件名不带 provider 前缀），`classify` 直接返回 `null`，
**连被考虑的机会都没有**。

### 实测：同文件对有 25 处（24 个文件），账面是 8

按「同一文件里同时存在 `create|compose Sqlite<X>` 与 `create|compose Postgresql<X>`」扫描，
得 **25 处 / 24 个文件**。逐条判性质（**不是 25 处都该合**）：

- **多数是合法的组合根选择**：`composeSqlite/PostgresqlAppDeps`（`server.ts`）、
  `compose…ProviderSession`（`cli/start.ts`）、以及 `platform/persistence/` 白名单层里的
  `createSqlite/PostgresqlDatabaseSession`、`…Capabilities`、`…DatabaseOperationalAdapter` 等。
  这些是「装配期选一次」，与 AC-10 第十波收的 `LOCAL_SYSTEM_OPERATIONS_COMPOSERS` 同类。
- **但有 3 处落在 `infrastructure/` 里**，也就是账本本来在数的那个**存储适配器**类别：
  `modules/integration/infrastructure/developmentToolConnectionStore.ts :: DevelopmentToolConnectionStore`
  `modules/integration/infrastructure/webhookRepositoryResolver.ts :: WebhookRepositoryResolver`
  `modules/task-execution/infrastructure/agentLaunchResourceOperations.ts :: AgentLaunchResourceOperations`

### 抽一条看实质：确实是「同一台机器抄了两遍」

`developmentToolConnectionStore.ts`（125 行）里两份实现逐方法对照，差别只有 `await` 位置与
`.limit(1)`：

```
SQLite:  db.select()…get()                 ← 同步游标，不 await
PG:      await db.select()…limit(1).get()  ← 异步
```

也就是说，**两份实现存在的唯一理由就是同步 / 异步这条缝**——而这正是本 RFC 的统一事务原语
要消掉的那条缝。它同时还是一处活的 `.get()` 同步游标（AC-6 乙类那个阻塞的同族）。

### 为什么这条要单独记

§5fh 的争论是「`PROVIDER_PAIR_COUNT` 降到 0 才算完工」还是「已登记的机制差异保留对拍即满足」。
**现在多了第三个事实：这个数本身漏计。** 它今天报 8，而同文件形态至少还有 3 处属于它本该数的
那个类别（其余 22 处需逐条判，多数是合法组合根）。所以：

- 拿「8」当完工进度**偏乐观**；
- 但也**不能**简单把它改成 33 就完事——25 处里大部分是合法的组合根选择，
  一股脑计入会把判据变成噪声（那就成了「文件数」而不是「还剩多少份重复实现」）。

**本轮没有动判据、没有合任何一对。** 要动它，需要的是一次**连带的裁决**：
①判据是否扩到同文件对；②若扩，如何把「合法组合根选择」与「重复的存储适配器」分开
（可能的判据：只计 `infrastructure/` 下、且两侧都直接发 SQL 的那些）；
③扩完之后 §5fh 的完工线按新口径怎么定。三件事必须一起定，否则数字会在两个口径之间横跳。

**可直接动手的那一条**：上面 3 处 `infrastructure/` 对里，`DevelopmentToolConnectionStore`
已确认只差同步 / 异步一条缝，属于「可以合、且合了就少一份实现」的明确目标——
但它该不该合、以及合了算不算 AC-1 销账，仍取决于 §5fh 的裁决口径。


## §5fo —— 更正 §5fm 的丙类：「用了假池」**不等于**「是一对要合的实现」（27 → 24）

§5fm 把 7 条 `rfc349-*` 一股脑归成丙类「PG 覆盖是脚本化假池 ⇒ 迁真库是重写」。
做 `rfc349-websocket-provider.test.ts` 时发现**这个归类不够细，至少对它是错的**。

### 它根本不是一对适配器

那条「假池」用例和它上面那条「真 SQLite」用例，构造的是**同一个类**：

```
test A: new DrizzleRealtimeStore(createInMemoryDb(...))   ← 真 SQLite
test B: new DrizzleRealtimeStore(fake.db)                 ← 回放罐头行的假池
```

而 `DrizzleRealtimeStore` 的构造形参本来就是 `ProviderNeutralDatabase`——**一份实现**。
两条用例只是给同一份实现喂了两种库，其中一种是假的。这跟 AC-1 的「成对适配器」完全是两回事，
**不需要任何生产侧合一**，直接合成一条双引擎即可：同一份真数据、同一组断言、两个引擎各跑一遍。

### 丢掉的 SQL 文本断言是净赚

假池那条断言 `fake.executions` 的 SQL 文本含 `"agent_workflow"."<表>"`，用来证明 PG 投影带
schema 限定名。合并后这组断言没了——**但这是净赚**：在**真 PostgreSQL 上跑通**是对同一件事
强得多的证明（限定名写错，查询当场报错，而不是靠比对字符串）。
`sqlRows` / `postgresqlFixture` 两个假池 helper 随之删除（45 行）。

实测 **5 例 → 7 例**（2 条 × 2 引擎 + 3 条源码文本断言只跑一次），7 pass / 0 fail；
realtime / ws 半径 15 文件以 `--isolate` 跑 169 pass / 0 fail。

### 丙类要重新分

所以「文件里出现 `createPostgresqlDatabaseClient`」这个机械信号**只说明用了假池**，
不说明「有两份实现」。丙类里要再分一刀：

- **假池 + 一份中立实现**（本条）——**直接可迁**，把假池换成真库即可，不欠 AC-1 任何东西；
- **假池 + 真的两份实现**（如 `rfc349-execution-peripheral-provider` 的
  `composeSqlite/PostgresqlAgentLaunchResourceOperations`，两者形参不同、一个要注入协作者）
  ——那才是 AC-1 territory。

判据：看那条用例 `new`/`compose` 出来的**是不是同一个符号**。是，就只是喂了两种库；
不是，才是两份实现。

### 账本

`TEST_ENGINE_HARDCODING_DEBT` 331 → **330**；`OPEN_MIGRATION_DEBT` 25 → **24**。

## §5fp —— AC-1 第一条真合一：执行合同资源读取，两份实现合成一份（并修掉它藏着的两处行为差）

§5fo 给丙类立了判据「看 `new`/`compose` 的是不是同一个符号」。拿它去扫剩下 6 个假池文件，
第一个被判成「真的两份实现」的是 `rfc349-execution-contract-postgresql-adapter`：

```
createExecutionContractResourceAdapter(db: ProviderNeutralDatabase)          ← 中立
createPostgresqlExecutionContractResourceAdapter(db: PostgresqlDatabaseClient) ← 品牌
```

两份都落到同一个 `createExecutionContractResourceAdapterFromLookup`，只是**怎么把行读出来**
各写各的：中立那份 `getAgentById` / `getWorkflow`（整行 `select()` + 整行解码），
PostgreSQL 那份自己窄投影 4 / 3 列再就地 `JSON.parse`。

### 先量：同一个真 PostgreSQL 库、同一批行，两条路给出两种结果

不是推演，是把两份适配器**接到同一个 `harness.db` 上**跑出来的（临时用例，红拿到后即删）：

| | 中立那份 | PostgreSQL 那份 |
|---|---|---|
| A. 交给 `implicitAgentDeclarations` 的 `frontmatterExtra` 键 | `["digitalEmployeeTemplate"]` | `["digitalEmployeeTemplate","role"]` |
| B. `definition` 存成坏 JSON 时抛什么 | `ValidationError/workflow-definition-corrupt` | `SyntaxError/-` |

**A 是 sidecar 泄漏**。`outputKinds` / `role` / `outputWrapperPortNames` / `branchPorts` 这四个键
已被持久化层提升成 `Agent` 的一等字段，`Agent.frontmatterExtra` 按定义看不到它们
（`agentPersistence.ts` 的 `frontmatterSidecars(...).exposed` 负责剥）。窄投影那条路自己
`JSON.parse`，于是**没剥**。今天两个消费者读的都不是 sidecar 键（`executionContracts` /
`digitalEmployeeTemplate`），所以这一处是**潜伏**的、还没咬到人——但它是「同一行数据在两种
数据库上形状不同」，正是 AC-1 要消灭的那类。

**B 不是潜伏的，是活的**。同一个坏掉的 workflow definition：SQLite 上调用方收到带
`workflowId` 与 zod issues 的结构化错误码，PostgreSQL 上收到一个裸 `SyntaxError`
——**用户看到的错误取决于管理员选了哪种数据库**。

### 再合：各取更强的一半

合成的一份 `createExecutionContractResourceAdapter(db: ProviderNeutralDatabase)`：

- **投影取 PostgreSQL 那半**——窄投影（agent 4 列 / workflow 3 列），SQLite 侧顺带也不再整行搬；
- **解码取中立那半**——但把它抽成两个独立导出，让窄投影也能用同一个口：
  - `exposedFrontmatterExtra(storedJson)`（`agentPersistence.ts`）
  - `decodeStoredWorkflowDefinition(workflowId, storedJson)`（`workflowPersistence.ts`，
    `workflowFromPersistenceRow` 自己也改成调它，于是整行路径与窄投影路径**共用同一段解码**，
    不可能再漂）；
- **`.limit(1)` + `rows[0]` 而不是 `.get()`**：`ProviderNeutralDatabase` 是
  `BaseSQLiteDatabase<'sync' | 'async'>`，`await` 之后两边一致的正是这种写法。

`createPostgresqlExecutionContractResourceAdapter` 删除，5 个调用点改名
（`cli/postgresqlDaemonApplication.ts`、`modules/execution-contract/composition.ts` 的再导出、
`tests/helpers/productionPerformanceApplication.ts`、`rfc359-w12-digital-employee-execution`、
以及本文件）。

### 测试：文件更名 + 两条真红转成常驻判据

`rfc349-execution-contract-postgresql-adapter.test.ts` →
`rfc359-execution-contract-resource-adapter.test.ts`（旧名指着一个已经不存在的东西）。
三条投影用例从假池搬到真库并转双引擎，另加上面 A / B 两条（当时的红），再加一条
**窄投影**判据——用 `harness.recordStatements()` 断言两次读各只发一条 `SELECT`、
各只取回 1 行、且 SQL 里不出现 `body_md` / `permission` / `depends_on` / `schema_version`。
这条替代了合一前那组「发出的 SQL 含 `"agent_workflow"."agents"`」字符串断言：跑在真 PG 上
本来就证明了 schema 限定名对（写错当场报错），而它还额外锁住了投影宽度。

变异验证（三条各自单独咬，且**两个引擎都咬**）：

| 变异 | 红 |
|---|---|
| `exposedFrontmatterExtra(...)` → 裸 `JSON.parse` | A，sqlite + postgresql 共 2 格 |
| `decodeStoredWorkflowDefinition(...)` → 裸 `JSON.parse` | B，共 2 格 |
| agent 窄投影改回 `.select()` | 窄投影判据，共 2 格 |

**5 例 → 14 例**（6 条 × 2 引擎 + 2 条 SQLite 组合根用例）。

### 留下的债

文件里还剩 1 处 `createInMemoryDb`：「HTTP bootstrap 保留注入进来的组合根」那条,
被测物就是 `createApp`（SQLite 组合根，形参写死 `DbClient`）。它属于甲类
（「被测物本身就是 SQLite 组合根」）——与 `execution-contract-platform` 的那 2 格同因,
仍等一条**通用**的 sanctioned 判据，不逐文件开豁免。因此两份账本数字**不动**
（`TEST_ENGINE_HARDCODING_DEBT` 仍 330、`OPEN_MIGRATION_DEBT` 仍 24），只改条目名。

census 自动下修三条 RFC-294 账本：`rfc294-mutation-entrypoints` 1697 → 1696、
`rfc294-cross-context-observed-imports` 5117 → 5115、`rfc294-architecture-exceptions` 4604 → 4602
——都是删掉那份品牌适配器带走的。

### 邻接观察（不折进本 RFC）

`grep -rn "JSON.parse(.*frontmatterExtra)" src/` 还能扫出三处
（`modules/collaboration/infrastructure/review.ts` 的 4320 / 4598 / 4745），形状与上面 A 同类
——自己 parse、没剥 sidecar，于是它们看到的 `frontmatterExtra` 与 `Agent.frontmatterExtra` 不同。
**但它们各自只有一份实现**，不构成「换个数据库结果不一样」，因此不属 RFC-359 的口径，
这里只记一笔，不折进本 RFC 的任务面。

## §5fq —— AC-1 的完成线：一条可以逐对套用的判据

§5fp 之后 AC-1 不再是「还剩几对」的清点题，而是「哪一对**该**留」的判断题。
前几段一直把这条线挂着等确认；这里把它写成一条**可以自己套**的判据，不再逐对反问。

> **一对 provider 孪生必须合一，除非它们的差异源于引擎本身。**
> 「源于引擎本身」只有三种：
>
> 1. **只有一个引擎有的原语**——advisory lock、`PRAGMA`、`$client`、
>    `dbTxSync`、PostgreSQL 的 `read only repeatable read` 快照；
> 2. **只有一个引擎有的资源形态**——SQLite 是**一个文件**（能 copy、能 `VACUUM INTO`、
>    磁盘占用可直接 stat），PostgreSQL 是**一台服务器**（要连、要 role、要 `pg_dump`）；
> 3. **驱动强加的线上差异**——参数占位符、类型编解码。
>
> 不属于这三种的差异——投影宽度不同、错误包装不同、选了不同的 helper、
> 一边多 `await` 一边少 `await`——**一律是漂移**，处方是「各取更强的一半，合成一份」。

按这条判据，§5fp 的那一对没有任何一项成立（两份都是 `select` + 解码），于是必须合；
而 `composeSqlite/PostgresqlDaemonProviderCore` 内含的 6 个子对里，
`systemOperations`（备份 / 恢复：文件 copy vs `pg_dump`）与 `maintenanceDisk`
（磁盘占用：stat 文件 vs 问服务器）命中第 2 条，**确实该分**——那两对不是债。

判据的**好处是可反驳**：任何一对想留下，得指出它命中哪一条；指不出来就得合。
这比「还剩 8 对」这种数字有用得多——数字不告诉你下一步该干什么。

## §5fr —— 「品牌别名」不是适配器：四个具名工厂原地退役，一条测试跟着从假池迁到真库

§5fo 的判据（看用例 `new`/`compose` 的是不是同一个符号）拿去扫第二个假池文件
`rfc349-task-execution-read-models-postgresql-adapter`，结果比 §5fo 那条还极端——
它导入的 `composePostgresqlTaskExecutionReadModels` **根本不是一个实现**：

```ts
// taskExecutionRuntime.ts，W4-B1 留下的过渡绑定
export {
  createTaskExecutionReadModels as composeTaskExecutionReadModels,
  createTaskExecutionReadModels as composeSqliteTaskExecutionReadModels,
  createTaskExecutionReadModels as composePostgresqlTaskExecutionReadModels,
} from '../infrastructure/taskExecutionReadModels'
```

一个函数，三个名字。旁边的注释自己写着「读模型只有一份实现；两个具名工厂只做绑定
（**bootstrap 收敛后一并删**）」——bootstrap 早就收敛了，别名却留着。

**留着的代价不是几行代码，是它把一条测试的意图带偏了**：那条测试叫
「PostgreSQL task-execution read-model adapter」，读起来像在验一个 PG 专属适配器，
实际上验的是同一份中立实现被喂了一个假池。**名字撒的谎比代码多。**

### 处置

四个别名一起退役（同文件那条 catalog source 的 `createPostgresqlTaskExecutionCatalogSourceFactory`
是同一个毛病——唯一作用是让 PG 组合根那一行读起来「对称」，而那是**假的对称**）：

| 别名 | 消费者 | 处置 |
| --- | --- | --- |
| `composeTaskExecutionReadModels` | 0 | 删 |
| `composeSqliteTaskExecutionReadModels` | 0 | 删 |
| `composePostgresqlTaskExecutionReadModels` | 1 条测试 | 测试改用本名后删 |
| `createPostgresqlTaskExecutionCatalogSourceFactory` | 1 处 PG 组合根 | 改用本名后删 |

测试更名为 `rfc359-task-execution-read-models.test.ts` 并转双引擎：三条投影判据从
「假池回放罐头行 + 断言发出的 SQL 文本」改成**真库真行**，另加一条「未知 id 一律 null」。
两条 SQLite 组合根用例（runtime 身份透传、`start.ts` 源码文本）保持不变。

丢掉的 SQL 文本断言（`order by "agent_workflow"."task_repos"."repo_index"` /
`inner join "agent_workflow"."tasks"`）换成 `harness.recordStatements()` 的**形状**判据：
四个投影恰好五条 SELECT、多仓那条必须带 `ORDER BY` 且取回 2 行。
变异验证：删掉 `orderBy(asc(taskRepos.repoIndex))` ⇒ **两个引擎各红一格**。

实测 4 例 → **8 例**；`AW_TEST_PROVIDERS=sqlite` 对照 5 例，证明多出来的 3 例是真 PG 泳道。
账本只改条目名（新文件同样留 1 处 `createInMemoryDb`，被测物是 SQLite 组合根，属甲类）。

## §5fs —— AC-1 的另一半：同文件孪生此前**一个都没被数到**，补一份账本 + 守卫

§5fq 给 AC-1 定了完成线（指名命中哪一条，否则必须合）。拿它去逐对套用时撞上一个更基本的问题：
**「还剩几对」这个数本身是错的。**

`rfc359-w5-provider-pair-conformance` 是本仓数对数的地方，它的 `classify(path)` 按**文件名词干**
配对（`sqliteFoo.ts` ↔ `postgresqlFoo.ts`）。于是**同一个文件里的一对**它一个也看不见：

```ts
// 一个文件里
export function composeSqliteFoo(db: DbClient) { … }
export function composePostgresqlFoo(db: PostgresqlDatabaseClient) { … }
```

§5fp 合掉的 `create{,Postgresql}ExecutionContractResourceAdapter` 正是这个形状——
**合掉一对真孪生，`PROVIDER_PAIR_COUNT` 一动不动。** 这不是账本记错了数，是它**按定义看不见**
这一类。

### 实测：48 对 / 42 个文件

判据认两种成对形态（只看**导出**的声明——没导出的东西不可能被两个组合根分别选用）：

- **双品牌**：`composeSqliteFoo` + `composePostgresqlFoo`；
- **中立名 + 品牌名同处一文件**：`composeFoo` + `composePostgresqlFoo`。
  这种更隐蔽——中立那份看起来「已经合一了」，其实旁边还挂着一份品牌实现。

扫出 **48 对 / 42 个文件**（跨文件对账本记的是 8）。所以 AC-1 的真实规模此前只被数到一小半，
而且被数到的恰好是**最显眼**的那一小半。

一个粗筛（按函数体里有没有 `$client` / `PRAGMA` / `dbTxSync` / `pg_dump` / `providerPool` /
`dbPath` 这类只有一个引擎有的东西）给出 **7 命中 / 41 零信号**。
**这个粗筛只是排序用，不是裁决**：它只看函数体自己的文本，看不见差异藏在被调用方里
（`composeSqliteDaemonProviderCore` 命中靠的是它自己那几行，不是它调的那六个子对）。
所以「41 条零信号」是**漂移的上界**，不是漂移的证明——每一条仍要按 §5fq 逐条指名。

### 守卫

新增 `packages/backend/tests/architecture/rfc359-w5-same-file-provider-pairs.test.ts`：

- 逐条与源码相等（增了是新开的分叉，减了是合一，都要改账本）；
- **每一条必须带 §5fq 裁决标记**（`①` 原语 / `②` 资源形态 / `③` 驱动线上差异 / `漂移待合`）
  ——想让一对留下来，得指名它命中哪一条；指不出来就只能挂着 `漂移待合` 等人来合；
- 语料下限 + 判别式非空（扫成 0 = 假绿）；
- 四例合成 fixture 锁住分类边界：双品牌算、中立+品牌算、**只有一侧**不算（那归跨文件判据管）、
  **没导出的**不算。

两条断言分开（身份一条、裁决一条），红的时候一眼知道是「多了一对」还是「少了个理由」。

变异验证：往 `util/hash.ts` 塞一对 `create{Sqlite,Postgresql}MutationProbe` ⇒ 身份那条红并点名新增行；
抽掉任意一条的裁决标记 ⇒ 裁决那条红。两条各自单独咬。

已开账 48，注册进 `architecture/ledger-baselines.json`（只降不升）与 `guard-manifest.json`。
本轮**先只裁决我读过源码、能指名理由的 5 条**（`maintenanceDisk` / `system-operations/composition`
/ `capabilities` / `databaseTransaction` / `migrationsFolder` 命中 ① 或 ②），其余 43 条一律标
`漂移待合`——**不给没读过的条目编理由**。

## §5ft —— 第一条按新账本销账：唯一「真的按 provider 分叉」的那一处，其实也是漂移

§5fs 开账 48 对，其中 43 条标 `漂移待合`。第一条动它的：Integration context 的**工具连接目录**。

挑它是因为它**看起来最不像漂移**——仓里有一段专门写给它的注释，解释它为什么必须分叉：

> `composeSqliteDevelopmentToolConnectionCatalog` 装的是 `createSqliteDevelopmentToolConnectionStore`
> ——它用 bun:sqlite 的**同步** `.get()` / `.all()`，在 PostgreSQL 客户端上这两个返回 Promise，
> `row === undefined` 恒为 false，投影会拿到 Promise 而不是行。所以这个别名只在 SQLite 引擎上成立。

**那段观察完全正确，但结论下反了。** 同步写法在 PG 上确实会错得无声无息；可那不是
「引擎逼出来的分叉」，是「**其中一份是照着同步 API 写的**」。按 §5fq 的三条判据逐条问：
不是独有原语（`select` 而已）、不是独有资源形态（都是查表）、不是驱动强加的线上差异。
**一条都不命中 ⇒ 漂移 ⇒ 该合。**

两份函数体逐行对应，差别只有两处：`await` 的位置、以及 PG 那份多一个 `.limit(1)`。
合一取「`await` + `.limit(1)` + 取第 0 行」这一半——**它在两个引擎上都成立，而同步那半
只在一个引擎上成立**。这正是 §5fq「各取更强的一半」的字面含义。

### 分叉的真实成本：PostgreSQL 侧此前零覆盖

`rfc359-w7-integration-composition-roots` 里那条双引擎用例，开头写着：

```ts
if (harness.capabilities.provider !== 'sqlite') {
  // PostgreSQL 侧走 composePostgresqlDevelopmentToolConnectionCatalog（同步 store 不适用）。
  return
}
```

**那条 skip 就是分叉的账单。** 目录的解析 / 自动挑选逻辑在 PostgreSQL 上**一次都没被跑过**
（PG 侧唯一的覆盖是另一个文件里对着假池的一条）。合一之后 skip 删掉，同一组判据两个引擎各跑一遍。
实测该文件 12 例（SQLite 单跑）→ 23 例（双跑）。

### 连带

- `rfc349-development-integration-composition` 的「每个 PG 装配都得指名自己的适配器、不许别名
  SQLite」清单里移除该文件——它现在是**一份中立入口，没有 provider 分支可命名**，比清单要求的更进一步
  （同一清单里已有两条同样理由的先例）。
- 三条语料下限跟着降：identical-twins 111 → 108、adapter-production-consumer 111 → 107、
  provider-runtime-exercised 47 → 45（退出分母的是 store 两个 + catalog 两个，共四个 provider 命名的函数）。
- 同文件孪生账本 **48 → 46**。

## §5fu —— 一次退役 14 对纯装配别名：账本 46 → 32

§5fs 开账后，先给剩下的 41 条 `漂移待合` 做了一次机械分类：把「品牌名是不是
`export const <brand> = <一个中立目标>`」当判据扫一遍，**14 对全中**。

它们的源码里自己写着结论：

```ts
/** 旧名保留为装配别名，bootstrap 收敛后删除。 */
export const composeSqliteApprovalGatewayRunner = composeApprovalGatewayRunnerFor
export const composePostgresqlApprovalGatewayRunner = composeApprovalGatewayRunnerFor
```

**一个函数，三个名字。** 与 §5fr 那一条是同一个毛病，只是这次一次找齐了。

留着的唯一效果是**让账本、让读代码的人、也让测试以为这里有两份 provider 实现**——
`rfc359-w5-provider-runtime-exercised` 的「provider 组合根」正是按名字派生的，
于是它在**同一个组合根**上数了两遍（这条判据的语料下限因此一次从 45 掉到 31：
掉的是重复计数，不是覆盖）。

20 个别名（14 对，有几对只有单侧）全部删除，62 处消费者改用本名。

### 两处需要手工收尾的

- `capabilityTemplateOperations.ts` 的中立名是**从别处 import 进来的**，两个别名是它的再导出；
  删掉别名后要补一句 `export { createCapabilityTemplatePersistence }`，
  否则消费者得改 import 路径——**改名不该顺带改导入路径**。
- `rfc349-digital-development-provider-boundary` 有一条**源码文本断言**
  `expect(digital).toContain('composePostgresqlDigitalEmployeeMaintenanceCommands')`。
  判据的意图不变（「维护命令这条路在装配面上出得来」），改成断言本名。

### 一次工具性事故（记在这里提醒后来人）

批量改名时用正则做「同一 import 语句里去重」，那个正则 `\{([^}]*)\}` 配 `re.S`
**匹配到了字符串字面量里的一段 import**（一条负 fixture 的内容就是一段 import 源码文本），
把引号拆断、整个文件语法错。已 `git checkout` 该文件并改用手工收尾。
**教训：批量重写只对 import / export 语句本身安全，不能对「长得像语句的字符串」下手。**

## §5fv —— 把剩下 24 条从「还没做」变成「挡在哪」：AC-1 的余量全在 infrastructure 层

§5fu 之后账本剩 32 条。逐条问「它为什么还在」，得到一张比数字有用得多的图。

### 先补 3 条裁决（它们本来就不该合）

机械分类把 3 条判成「无下层品牌依赖、可直接合」，读源码发现**判反了**——它们各自命中 §5fq ②：

| 条目 | 为什么是 ② |
| --- | --- |
| `cli/doctor.ts::checkSealedCredentials` | doctor 要在**守护进程没起来**时也能查：SQLite 直接 `new Database(<文件>, {readonly:true})`，PostgreSQL 必须问一台**服务器**要连接池 |
| `embed.ts::countEmbeddedSqlMigrations` | 两条迁移链是**两套各自落盘的工件**，与 `util/migrationsFolder.ts` 同一条理由 |
| `embed.ts::extractMigrationsTo` | 同上 |

**这是「机械信号只排序、不裁决」那句话的又一次兑现**（§5fs 已写过一次）：
粗筛说「没有下层品牌依赖」，可真正的差异在**它自己那几行**里——`new Database(文件)`。

### 剩下 24 条：没有一条是「composition 层自己的问题」

逐条扫函数体里调用的品牌符号，**24 条全部**至少调一个下层的
`create/composePostgresql*` 或 `create/composeSqlite*`：

| 挡住它的下层 | 条目数 |
| --- | --- |
| infrastructure 层的成对适配器（`…Participant` / `…Operations` / `…Store` / `…Runtime`） | 20 |
| 另加还挂在 `services/task` SQLite 专属启动面上的 | 4（`actionExecutionEnvironment` / `digitalEmployeeExecution` / `server.ts` 两条） |

**结论：AC-1 在 composition 层已经基本做完了，余量全部沉在 infrastructure 层。**
这 24 条不是 24 件独立的工作——它们是 20 来个 infrastructure 孪生**向上冒出来的影子**，
下层合一，这一层会自己塌成一份。所以账本里每条的理由都改写成「挡在下层的哪个符号上」，
下一个人看一眼就知道该去动谁，而不是从头再推一遍。

典型链条：`actionExecutionEnvironment` ← `scriptActionExecution` + `agentActionExecution`
（动一个下层，两条同时销）；而 `actionExecutionEnvironment` 自己挡在更下面——
SQLite 那半走 `services/task` 的 `startTask`（legacy、12 处同步游标），
PG 那半走 `PostgresqlRootTaskLaunchKernel`，**是两套启动架构**，
不是一个引擎差异。那是 AC-6 乙类一直挂着的同一个 blocker。

### §5fv 附：那 24 条挡在谁身上（下一波的施工图）

把 24 条的品牌被调用者去重，得到 **56 个下层符号**。按所在文件归拢后，形状很清楚：

**第一层（composition 互相挡）**——这些本身也在 32 条账本里，会随下层一起塌：
`actionExecutionEnvironment` / `agentActionExecution` / `scriptActionExecution` /
`agentLaunchResources` / `sourceTermination` / `triggerExecution` / `providerRuntime` /
`digitalEmployeeExecution` / `webhookDispatch` / `resourcePackageMaintenance` /
`maintenanceDisk` / `system-operations/composition`。

**第二层（真正的 infrastructure 孪生，AC-1 的余量在这里）**：

| 孪生 | 备注 |
| --- | --- |
| `sqliteTaskRouteOperations` ↔ `postgresqlTaskRouteOperations` | 两千行级 |
| `sqliteTaskRouteLaunchOperations` ↔ `postgresqlTaskRouteLaunchOperations` | 含 `RootTaskLaunchKernel` |
| `sqliteTaskExecutionRuntimeParticipants` ↔ `postgresqlTaskExecutionRuntimeParticipants` | |
| `fusionEngineTaskOperations` ↔ `postgresqlFusionEngineTaskOperations` | |
| `sqliteSourceTerminationParticipant` ↔ `postgresqlSourceTerminationParticipant` | PG 侧多收一个 runtimeRegistry |
| `webhookRepositoryResolver` / `webhookTriggerValidation` | integration 侧 |
| `databaseOperationalAdapter` | 已判 ① 的近邻，待逐条确认 |

**第三层（架构级 blocker，不是一个孪生能解决的）**：
`actionExecutionEnvironment` 的 SQLite 半走 `services/task` 的 `startTask`
（legacy，12 处同步游标），PG 半走 `PostgresqlRootTaskLaunchKernel`——
**两套启动架构**。这与 AC-6 乙类（`start-task-deps`）挂着的是同一个 blocker，
要先有一次「启动面合一」的波次，上面一串才有得合。

所以下一波的入口不是「再挑几条漂移待合」，而是**从第二层挑一个孪生做掉，
看它一次带塌几条 composition**——`sourceTermination`（两个参与者、PG 多一个可选形参）
体量最小，是验证这条链路的合适起点。

## §5fw —— 一份中立实现顶着 `Sqlite` 的名字：`webhookRepositoryResolver` 收名

账本里 `webhookRepositoryResolver` 记着「还有一对没合」，可翻开源码它**早就只有一份实现**了：

```ts
export function createSqliteWebhookRepositoryResolver(db: ProviderNeutralDatabase, …) { … }
export const createPostgresqlWebhookRepositoryResolver = createSqliteWebhookRepositoryResolver
```

合一那一轮的注释写明了为什么留着这个名字：

> **没有起第三个名字**：正典就用原来的 `createSqliteWebhookRepositoryResolver`（形参已放宽），
> PG 那个名字变成指向它的别名。这样导出符号数不增不减——新增一个导出符号会让
> `rfc294-module-symbol-owners` / `rfc294-mutation-entrypoints` 两本账同时涨一格（实测）。

**那个顾虑是对的，但它解错了方程**：怕的是「**新增**一个符号」，而把正典改名成中立名
是**改名不是新增**——两个品牌导出变成一个中立导出，符号数 2 → 1，那两本账**只降不升**。

代价是真实存在的：一份 provider 中立的函数顶着 `Sqlite` 的名字，**读代码的人、账本、
和按名字派生组合根的那条判据都会以为这里有两份实现**。这正是 §5fu 那 14 对别名的同一个毛病，
只是它藏在「已经合过一次」的外壳下面。

改名 + 删别名，两个调用点改用本名。账本 32 → **31**；identical-twins 与
adapter-production-consumer 两条语料下限各降 1。

## §5fx —— 删掉一整层「只转交、还不碰数据库」的 provider 命名文件

`modules/integration/infrastructure/sqliteWebhookTriggerValidation.ts`（34 行）两个导出：

```ts
export async function assertSqliteWebhookTriggerSaveable(…5 个实参) {
  await assertWebhookTriggerSaveable(…同样 5 个实参)      // 原样转交
}
export function createSqliteWebhookTriggerValidation(operations, configPath) {
  return composeWebhookTriggerValidation(operations, configPath)   // 原样转交
}
```

**两个函数都不收数据库句柄**，名字里的 `sqlite` 因此连「说明它跑在哪个引擎上」都谈不上——
纯噪音。整个文件删除，三个消费者（一个装配 + 两条测试）改用
`composition/webhookAdmission` 里的本体。

两本账同时降：`PROVIDER_NAMED_FILE_DEBT` 39 → **38**（这一条记的正是
「还落在 `platform/persistence/` 之外的 provider 命名文件」），
identical-twins 107 → 106、adapter-production-consumer 106 → 105。
同文件孪生账本里 `webhookDispatch` 那条的 blocker 清单也少掉一个。

**这一条的普遍教训**：`§5fs` 的判别式扫的是「导出名带不带品牌」，
于是它既扫得出「两份真实现」，也扫得出这种「**一层多余的转交**」。
后者的修法不是合一，是**删层**——转交层被删掉之后，那两个品牌名自然一起消失。

## §5fy —— 「谁提供 taskTermination」不是引擎差异：MR 终端控制收成一份

`webhookTerminalControl.ts` 里本来就已经有一份中立的 `composeMrTerminalControlWithPorts`，
两个品牌入口只是它的两种喂法：

```ts
composeMrTerminalControl(db: DbClient)                     // 自己 composeTaskSourceTermination(db)
composePostgresqlMrTerminalControl({ db, taskTermination }) // 要求调用方注入
```

两个持久化端口（`createMrLaunchGuardPersistence` / `createMrTerminalEffectPersistence`）
**本来就是中立的**，都只吃一个 `db`。所以整对的差别只有一处：**谁来提供 `taskTermination`。**

「自己造」与「让人注入」不是引擎差异，是**装配责任放在了不同的地方**——按 §5fq 三条判据
一条都不命中。处方就是 AC-10 用过的那条「**装配者提供答案**」：两边都由调用方注入。

**值得记的一点：这一条不必等下层先合。** `sourceTermination` 那对孪生
（§5fv 判过：锁边界与谁做终态清理**确有语义差异**，且 SQLite 那半还挂在 `services/task` 上）
仍然开着——但这一层只是把 participant **原样转交**给 worker，
它不关心那个 participant 是怎么造出来的。所以「挡在下层」这个标注**不总是真的挡住**：
要看这一层是**消费**下层的差异，还是只是**搬运**它。搬运的那种，把搬运责任上提即可当场合一。

SQLite bootstrap（`cli/start.ts`）与那条 e2e 用例于是各自先调一次
`composeTaskSourceTermination(db)` 再传进来，与 PostgreSQL bootstrap 现在是同一个姿势。

账本 31 → **30**；identical-twins 106 → 105、adapter-production-consumer 105 → 104。

## §5fz —— 「中立名 + 品牌名」这一半，`identical-provider-twins` 按定义看不见

`composeEventCenter` 与 `composePostgresqlEventCenter` 的函数体**逐字节相同**：

```ts
const { db, ...shared } = options
return await composeEventCenterWithPorts({
  ...shared,
  persistence: {
    events: createEventStore(db),
    customSources: createCustomEventSourceStore(db),
    responseRules: createEventResponseRuleStore(db),
    committedEvents: createCommittedEventDeliveryPersistence(db),
  },
})
```

唯一差别是形参上那个更窄的 `db: PostgresqlDatabaseClient` 标注——而
`ComposeEventCenterOptions.db` **本来就是** `ProviderNeutralDatabase`，四个 store 也早就中立。
**纯编译期的品牌标注，零运行期含义**（与 §5fl 的 `freezeCallClosure(db: DbClient)` 同形）。

### 为什么本仓的「零孪生」守卫一直没咬住它

`rfc359-w5-identical-provider-twins` 的判据是「**两个 provider 命名的函数**体逐字相同」。
这一对里有一个叫 `composeEventCenter`——**不带品牌名**，于是那条判据根本不把它们配成一对。

**这正是 §5fs 那份同文件账本要补的另一半**：一个「逐字节相同」的孪生，
在「零孪生」守卫下安然活了很久，因为它的另一半已经改成中立名了。
「已经有一个中立名」看起来像合一完成的标志，实际上可能只是**合了一半**——
把品牌那份留在旁边，比两个都带品牌更难发现。

删掉 PG 那份，四个调用点改用本名。连带两处测试里的 `provider === 'sqlite' ? … : …` 三元
（两臂只差一个 cast）与四个 cast 一起消失。

账本 30 → **29**；identical-twins 105 → 104、adapter-production-consumer 104 → 103。

## §5ga —— 把 §5fz 的判别式拿去扫一遍：又两对「体逐字节相同」的中立 + 品牌

§5fz 发现的形状——**中立名 + 品牌名、函数体逐字节相同、只差形参标注**——不是孤例。
把它写成判别式（两个成员的体归一化后相等）扫剩下的 `漂移待合`，又中两条：

| 条目 | 品牌那份的全部内容 |
| --- | --- |
| `createPostgresqlCollaborationCommandContext` | 与中立那份逐字节相同；只差它收 `PostgresqlCollaborationCommandContextInput`（= 把 `db` 收窄成 `PostgresqlDatabaseClient`）。而 PG 客户端本来就可赋值给 `ProviderNeutralDatabase` |
| `createPostgresqlEmployeeReactionRoundQueries` | 体就是一行 `return createReactionRoundQueries(db)`，与中立那份一字不差 |

两条一并退役，消费者改用本名；连带两处 `provider === 'sqlite' ? … : …` 三元
（两臂只差 cast）与四个 cast 消失。

**这三条（§5fz + 本节两条）合起来说明一件事**：本仓「零孪生」守卫
（`rfc359-w5-identical-provider-twins`）按定义只配**两个都带品牌名**的函数，
于是「合了一半」——把一份改成中立名、另一份留着品牌名——的那种，
**它一个都看不见**，而这种恰恰比两个都带品牌更难用肉眼发现：
读的人看见一个中立名，会以为这里已经收干净了。

账本 29 → **27**；identical-twins 104 → 102、adapter-production-consumer 103 → 100。

## §5gb —— webhookDispatch 的两对：一对是 §5fy 同形，另一对根本不是「一对」

`webhookDispatch.ts` 在账本里占两条，拆开看是两件不同的事。

**第一对（`composeWebhookTriggerServiceDependencies` 一族）** 与 §5fy 的 MR 终端控制逐字同形：
两份的 `administration` / `dispatchPersistence` 用的是**同两个中立构造器**，差别只有
**谁提供 `validateSaveable`**——SQLite 那份自己
`composeWebhookTriggerValidation(scheduledTasks, configPath)`，PG 那份要求注入。
按「装配者提供答案」收成一份，SQLite bootstrap（`server.ts`）自己先造一次再传进来。

**第二对（`composeWebhookDispatchPersistence` 一族）根本不是一对 provider 实现**：

```ts
export function composeWebhookDispatchPersistence(p: WebhookDispatchPersistencePort) {
  return p                                   // ← 恒等函数，收端口、原样返回
}
export function composePostgresqlWebhookDispatchPersistence(db: PostgresqlDatabaseClient) {
  return composeWebhookDispatchPersistence(createWebhookDispatchPersistence(db))
}
```

一个收**端口**、一个收**数据库**——它们是同一族的**两层**，不是同一层的两个 provider 版本。
账本把它们配成一对，是因为判别式只看「名字去掉品牌后是否相同」。
处方不是「合一」，是给造端口那一层一个**不带品牌的名字**（`…For`），
于是「中立层 + 造层」两个名字各归各位。

**这一条给判别式补了一个已知限度**（写进 §5fs 的账本注释）：
名字相同 ≠ 同一层。判别式负责**把可疑的对捞出来**，是不是真的一对仍要人读一眼。

连带：`rfc359-w7` 里那条「两个别名装出的东西都能读写」的用例——它的判据本来是
「两个别名装出来的是同一个东西」，合一后**那个判据自然消失**，改成单份的读写闭环；
「两个 provider 装出来的一致」由 `describeEachProvider` 两个引擎各跑一遍来证明，
比原来的互相对读更强。组合根清单 19 → 18。

账本 27 → **25**；identical-twins 102 → 99、adapter-production-consumer 100 → 97。

## §5gc —— 同一件事写了两遍：code-host webhook 的两条装配

`modules/integration/composition.ts` 在账本里占两条，形状一样：

```ts
// 中立那份：把三行抄在自己体内
export function createCodeHostWebhookDeliveryConsumer(db: ProviderNeutralDatabase, …) {
  return createCodeHostEventDeliveryAdapter(createCodeHostEventResponseDirectory(db), {…}, cont)
}
// PG 那份：走已有的那层
export function createPostgresqlCodeHostWebhookDeliveryConsumer(db: PostgresqlDatabaseClient, …) {
  return createCodeHostWebhookDeliveryConsumerWithPersistence(
    createCodeHostEventResponseDirectory(db), dispatcher, cont)
}
```

而 `…WithPersistence` 的函数体**正是中立那份抄的那三行**。所以这一对不是「两种 provider 行为」，
是**同一件事在同一个文件里写了两遍**，其中一遍顺手挂了个 provider 名字。

处方：中立那份也改走 `…WithPersistence` 那层（一处实现），PG 那份退役。
路由目录那一条完全同形，一并处理。

**这一条与 §5gb 的第二对互为镜像**，值得并排记：
- §5gb：两个名字是同一族的**两层**（一个收端口、一个收 db）——判别式**误配**；
- §5gc：两个名字确实是同一层，但**其中一个把下层的实现抄了一遍**——判别式**配对配得对**，
  而修法不是「二选一」，是让抄的那份改去调它抄的东西。

账本 25 → **23**；identical-twins 99 → 97、adapter-production-consumer 97 → 95。

## §5gd —— AC-6 的第一条**通用** sanctioned 判据：按 call shape 认，不按文件名认

AC-6 的 24 条 `OPEN_MIGRATION_DEBT` 一直卡在一个问题上：其中几条**有**正当理由，
只是写在注释里、而 `SANCTIONED_SINGLE_ENGINE` 的机械判据认不出来。
前几段一直说「要一条**通用**判据、不逐文件开豁免」——这是第一条。

逐条读那 24 个文件，`rfc189-wg-round.test.ts` 的那一格是这样的：

```ts
const partial = partialMigrationsDir()   // 把 journal 截断到 0095 之前
const db = createInMemoryDb(partial)     // 「0095 尚未应用」的库
```

它测的是**迁移 0095 自己的回填口径**（「0095 之前的行，回填之后该长什么样」），
所以必须把库停在那条迁移**之前**。迁移链是两套各自落盘的工件（§5fq ②，
与 `util/migrationsFolder.ts` / `embed.ts` 同一条理由），SQLite 那条链上的第 N 条回填，
**按定义只能在 SQLite 的链上验**。

### 为什么原来的判据漏了它

`migration-chain` 判据按**文件名**匹配：`/(^|\/)migration-\d/` 或 `/rfc\d+-migration-\d/`。
而这个文件叫 `rfc189-wg-round.test.ts`——**它做的是迁移回填对账，名字里却没有 `migration`**。

**按文件名分类，分到的是「谁起的名字好」，不是「它在测什么」。**

### 新判据

`frozen-migration-revision`：建库时喂的**不是那份规范迁移目录**，而是一份被截断 / 冻结过的副本
（`partialMigrationsDir` / `createInMemoryDb(partial…` / 体内出现 `_journal.json`）。
这是 call shape，不是命名习惯。

实测只有这一个文件命中（其余 23 个都是 `createInMemoryDb(MIGRATIONS)`），
所以它**没有顺手把别的文件也洗白**——`OPEN_MIGRATION_DEBT` 24 → **23**，
而 `TEST_ENGINE_HARDCODING_DEBT` 仍是 330：那一格**没有消失**，只是从「债」挪到了「有理由」。
两个数字的差别正是这份账本当初拆成两条的意义。

## §5ge —— 「自己造 vs 让人注入」的第三次，这次用**缺省实参**收口

`agentLaunchResourceOperations`（infrastructure）与 `agentLaunchResources`（composition）
在账本里各占一条，是同一件事的两层。拆开看，三件事里两件是老形状：

| | SQLite 那份 | PostgreSQL 那份 |
| --- | --- | --- |
| `loadVisibleAgent` | 体内 `getAgentById` + `canViewResource` | 转交注入的 `input.agents.get` |
| `validateHostWorkflow` | 体内 `validateWorkflowDef(def, await loadWorkflowValidationContext(db))` | 转交注入的 `input.workflowValidation.validate` |
| `ensureHostWorkflow` | 同一条 upsert | 同一条 upsert，**只多写了个 `.run()`** |

第三行那个 `.run()` 是 §5ft 的老朋友：中立句柄上 `await` 就够，两个引擎都成立。

前两行又是 §5fy / §5gb 的「装配责任放在了不同的地方」。但这一次没有照搬「两边都由调用方注入」
——那会让 SQLite 的两个 bootstrap 调用点都得凭空写两个适配器。改用**可选实参**：

```ts
createAgentLaunchResourceOperations({ db, agents?, workflowValidation? })
// 不给 ⇒ 用建立在 db 上的缺省实现（原 SQLite 体内那两段）
```

于是 SQLite 侧调用点只从 `f(db)` 变成 `f({ db })`，语义一格不动；
PG 侧照旧把自己的两份传进来。**同一条处方有两种收口姿势，挑哪种看「谁的调用点更多」。**

账本 23 → **21**；identical-twins 97 → 93、adapter-production-consumer 95 → 91。

（本节验证时 `rfc165-agent-launch` 等三格红，追下去是 `helpers/gitHttpRemote.ts` 起真 git 远端
——本机 git 被 Xcode 许可门卡住所致，与本次改动无关。）

## §5gf —— 转交式**函数**别名：§5fu 的判别式漏掉的另一半

§5fu 一次退役 14 对纯装配别名，判别式是 `export const <brand> = <neutral>`。
可同一件事还有另一种写法：

```ts
export function createPostgresqlIdentityAccessRuntime(
  input: CreateIdentityAccessRuntimeInput,
): IdentityAccessRuntime {
  return createIdentityAccessRuntime(input)      // ← 函数体只有这一行
}
```

`export const` 认得出，`export function ... { return 中立那份(input) }` 认不出——
**同一件事、两种语法，判别式只写了一种。** 补上之后扫出三处，其中两处是真别名
（identity-access 运行时、digital-employee 装配），一并退役。

第三处是 `server.ts` 的 `composeSqlite/PostgresqlAppDeps`——它**不是**别名：
两臂转交给的是**不同的**目标（`composeProviderAppDeps` vs `composeSqliteApplicationDeps`），
是真的两套装配，留着。**判别式捞出来的仍然只是嫌疑，是不是别名要看转交目标一不一样。**

账本 21 → **19**。

### 一次自伤，记在这里

退役 `composePostgresqlDigitalEmployee` 时做了全仓裸 `str.replace`，而
`composePostgresqlDigitalEmployee` **是** `composePostgresqlDigitalEmployeeExecution` 的前缀，
于是后者被一起改名、撞上同文件已有的 `composeDigitalEmployeeExecution`。
typecheck 当场咬住了代码那部分；**但它还把账本里那一行的文本也改坏了**
（账本记的就是符号名，自然在替换范围内），而那一行 typecheck 看不见——
是 `rfc359-w5-same-file-provider-pairs` 的逐条相等判据把它揪出来的。
批量改名一律走词边界正则，已落 `docs/dev-gotchas.md`。

## §5gg —— 两条「不该由本轮顺手定」的，把 blocker 写准

继续扫剩下的 drift，两条确认**不是**能顺手合的：

- `triggerExecution`：SQLite 那份自己拼 `StartExecutionRequest` 再走
  `startExecution(db, actor, …)`（legacy 启动路径），PG 那份转交注入的
  `launches.launch(request)`（kernel 启动路径）。**又是那两套启动架构**，
  与 `actionExecutionEnvironment` / `digitalEmployeeExecution` 同一个第三层 blocker。
- `resourcePackageMaintenance`：`db` 两边都已中立，差别有二——「谁提供 activity 登记表」
  （§5fy 老形状，可用缺省实参收口）；以及 **legacy 工件回收链**：SQLite 那份串了
  「当前格式 → 旧格式」两级回收，PG 那份只读当前格式。
  **第二点不是引擎差异，是版本兼容尾巴**——它绑的是「这台机器升级前跑过旧版本」，
  不是「这台机器用哪种数据库」。合一之前得先回答「那条回落还要留多久、能不能改成一次性迁移」，
  **这个问题不该由本轮顺手定**，所以留在账本里，把理由写准。

## §5gh —— AC-6 的甲类量出来了：23 条里 7 条是同一个根因，而我**没有**给它开通用判据

§5gd 立了第一条通用 sanctioned 判据（`frozen-migration-revision`，按 call shape 认）。
顺手把剩下 23 条按同样方式量了一遍，发现**7 条共用一个形状**：

| | |
| --- | --- |
| `architecture/rfc329-mcp-surface-guard` · `rfc221-login-policy-routes` · `rfc257-webhook-error-codes` · `rfc305-architecture-lock` · `rfc310-pr7b-handover` · `rfc349-daemon-provider-core` · `rfc359-execution-contract-resource-adapter` | 那处 `createInMemoryDb` 是喂给 `createApp`（或 `composeSqlite*` 组合根）的 |

写一条「被测物是 SQLite 组合根」的判据很容易，**一次就能把 23 压到 16**。我没有写，理由是：

**那条判据分不出「组合根就是被测物」与「组合根只是顺手的脚手架」。**
`rfc329-mcp-surface-guard` 数的是**那个根挂了哪些路由**——根确实是被测物；
可 `rfc257-webhook-error-codes` 断言的是 webhook 的错误码，那是**与 provider 无关的行为**，
`createApp` 只是它借来起应用的架子。前者 sanctioned 是对的，后者 sanctioned 就是
**把一处真实的覆盖缺口洗成绿数字**——而这正是本 RFC 存在的理由。

两者的差别**没法机械判**（都长成 `createApp({ …, db })`）。所以这 7 条留在债里，
并在这里记清它们是**一簇、一个根因**：

> `createApp` 的 `db` 形参写死 `DbClient`，而 `cli/start.ts` 在**选 provider 之前**
> 就把 secretBox 等都备齐了——两个组合根的**装配签名不对称**，不是「PG 缺了 SQLite 有的能力」。
> 正解是把 SQLite 根的签名与 PG 根对齐（`rfc221` 的注释早就指到 plan §5bg），
> 那之后这 7 条里「根就是被测物」的几条会自然消失，剩下的才是真正该转双引擎的。

**记这一条的意义**：AC-6 剩下的 23 不是 23 件事，是「7 条等根合一 + 16 条各自的事」。
把它写出来，下一个人不用再把这 7 条挨个读一遍才发现它们是同一件事——
也不会因为「一条判据能压 7 条」就顺手把它写了。


## §5gi —— 更正 §5gh：那 7 条**不是一簇**，而且「挡在组合根签名」这个判断是错的

§5gh 说 AC-6 剩下 23 条里有 7 条共用一个根因（`createInMemoryDb` 喂给 `createApp`），
并推断它们挡在「两个组合根的装配签名不对称」上、要等 §5bg 的签名对齐。
**这两句都得改。**

### 错在哪（一）：`createApp` 不是「一个可以放宽的形参」，是 SQLite 组合根的大门

```ts
export function createApp(deps: AppDeps | ComposedAppDeps): Hono {
  return createComposedApp('apiRoutes' in deps ? deps : composeSqliteAppDeps(deps))
}
```

给它一个裸 `db`，它就去跑 `composeSqliteAppDeps` 整棵树。所以「把 `db` 放宽成中立句柄」
根本不是这条路——PostgreSQL 侧的对应物是 `composePostgresqlApplication`，
**入参形状完全不同**（要 runtime、schema 合同、generation 指针）。
「组合根签名对齐」因此不是一次放宽，是**两套应用装配的合并**，比 §5gh 写的重得多。

### 错在哪（二）：双引擎应用 harness 早就存在，而且 113 个文件在用

`describeEachProviderHttpApplication` / `createProviderHttpApplication` 按所选 provider
装一个**真应用**。全仓 **113** 个测试文件已经在用它。
所以「测试要拿到双引擎的 app」这件事**不需要等任何签名对齐**。

### 那 7 条到底是什么

逐个读下来，它们**不是一簇**：

| 条目 | 实情 |
| --- | --- |
| `rfc257-webhook-error-codes` | **已正确裁决**：文件里写着「缺 dispatcher 是**测试独有**的装配形态」——SQLite 根把它当可选依赖、PG 根自建、生产两侧必有；注释还特意提醒塞进 provider 作用域会在 `[postgresql]` 那遍炸。而且该文件**主体早就在用双引擎 harness**，只有这一格是单引擎 |
| `rfc221-login-policy-routes` | 同类：无 secretBox 的装配在**两个引擎的生产部署里都不存在**，已详细写明 |
| `rfc359-execution-contract-resource-adapter` | 本轮自己写的，被测物就是 `createApp` 这个 SQLite 组合根 |
| `rfc310-pr7b-handover` | 文件里**已有 4 处 `describeEachProvider`**，那一格 `createApp` 是残留 |
| `rfc329-mcp-surface-guard` / `rfc305-architecture-lock` / `rfc349-daemon-provider-core` | 没有就近说明，得逐个读 |

**教训**：§5gh 是靠一条机械信号（`createInMemoryDb` 喂给 `createApp`）聚出来的「簇」，
而**「共用一个语法形状」不等于「共用一个根因」**——这跟 §5gb / §5gc / §5gf 三次判别式失误
是同一个毛病，只是这次栽在我自己新造的那条信号上。
§5gh 拒绝为这 7 条写通用 sanctioned 判据是**对的**（理由也仍然成立：分不出
「组合根是被测物」与「组合根只是脚手架」）；错的是把它们说成一簇、并给了一个错误的 blocker。

**修正后的待办**：这 7 条里 3 条已裁决、1 条是残留可直接迁、3 条待读。
与「两个应用装配合并」那件大事**没有依赖关系**。

---

## §5gj　AC-6：把 §5gi 认出的那一条残留真迁掉（`rfc310-pr7b-handover`）

§5gi 把 §5gh 的「7 条一簇 + 一个共同 blocker」修正成「3 条已裁决、1 条残留、3 条待读」。
这一节把其中**残留**那条做完——它是四类里唯一「不需要任何判断、直接迁」的。

### 做了什么

`rfc310-pr7b-handover.test.ts` 的 HTTP 面原来是 `createApp({ db: createInMemoryDb(MIGRATIONS) })`。
`createApp` 不是「形参放宽就能双跑」的入口（§5gi 的修正要点：它就是 SQLite 组合根的大门），
但仓里**早有**现成答案：`describeEachProviderHttpApplication`——两个引擎各装一个**真应用**，
全仓 113 个文件在用。改用它即可，零生产改动。

同文件上半部**本来就有 4 处 `describeEachProvider`**，所以这一格从来不是「被根挡住」，
是**迁移时漏掉的一格**。4 例 → 8 例（`[sqlite]` / `[postgresql]` 各一遍，junit 两条 classname 均在）。

账本同步：`rfc359-w5-t19f` 的两张名单各退役一行（逐文件调用点数 330 → 329、
`OPEN_MIGRATION_DEBT` 23 → 22），`architecture/ledger-baselines.json` 的两条高水位一并改小。

### 迁完立刻显出来的东西：一条只在 PostgreSQL 上出现的告警

迁完第一次跑，PG 那遍冒出 SQLite 那遍**零次**的告警：

```
WARN [development-missions] mission drive after route mutation failed
err="Failed query: select … from "agent_workflow"."development_feedback_ledger" where …"
```

查证过程与结论：

1. **不是 schema 漂移**——`development_feedback_ledger` 在 `postgresql-migrations/0000_rfc349_baseline.sql`
   与 `src/db/schema.ts` 里都是同样 12 列，逐列对齐。
2. **表名每次还不一样**（这次 `development_feedback_ledger`、下次 `development_effects`），
   指向生命周期竞态而不是某张表的定义问题。
3. 临时把 `error.cause` 链打出来，真因是 **`PostgresError: Connection closed`**。
4. 代码形状对上了：`missionOperations.ts` 的 `fireReconcile` 是 **fire-and-forget**
   （`void automation.drive(missionId).then(...).catch(...)`），路由不 await 它。
   SQLite 驱动是**同步**的，这条链不让出事件循环就跑完了；PG 要真的走 I/O，
   于是可能在应用关闭、连接池随之关掉之后才回来。

**裁决：不是产品缺陷，也不是本次迁移引入的**——`fireReconcile` 不被 await 是既有设计，
告警本来就在 `catch` 里、被降级成 warn，两个引擎 8 例全绿。它是**测试生命周期**的噪声。

但有一件事值得记下来，因为它对后来人是真的坑：**在 PG 那遍，不要写依赖「后台 drive 已经跑完」
的断言**——SQLite 那遍因为驱动同步会稳定通过，PG 那遍则取决于连接池什么时候关。
这类断言是「两个引擎同一份判据、结论却不同」的隐蔽来源。已落 `docs/dev-gotchas.md`。

### 顺带挡下的一次双 OS 红

迁移删掉了最后一处 `createApp` / `createInMemoryDb` 用法，于是 `Hono` / `DbClient` /
`createApp` / `createInMemoryDb` / `MIGRATIONS` / `resolve` **6 个符号全成了死导入**。
本地那条秒级自查（只对改动文件跑 `bunx eslint --max-warnings 0`）当场报 5 条 warning——
按 RFC-140 的老账，这会在两个 OS 上各红一格。删干净后 eslint exit=0。
**记一笔**：凡「迁移 = 把某个构造方式换掉」的改动，删完调用点必定留死导入，
这条自查不是可选的。

---

## §5gk　AC-6：给「两个组合根的路由面」立一条判据（新守卫 + 三条裁决）

§5gi 留下三个没就近说明的 AC-6 文件（`rfc329-mcp-surface-guard` / `rfc305-architecture-lock` /
`rfc349-daemon-provider-core`）。逐个读完发现前两个是**同一个形状**，而要判它们得先回答一个
此前**没有任何判据回答过**的问题。

### 那个问题

`rfc329` 与 `rfc305` 都是「装一个应用**只为了**拿到路由 → 权限那张声明表，然后审这张表」。
它们装的是 `createApp`——**SQLite 组合根**。于是它们审的其实是**一个引擎的**路由面，
却当成「框架的路由面」在用。

读源码能论证两侧应该一样：两个根都汇进同一个 `createComposedApp` → 同一个 `mountApiRoutes`，
而后者里唯一条件挂载的一组是 `routes.databaseMigration?.(app)`（`AppRouteMount` 里唯一带 `?` 的字段）。
**但「论证过」和「钉住了」是两件事**：今天只要有人给某个根多挂一组路由、或给同一条路由在两个根上
配不同权限，这批守卫**一格都不会红**。

### 新守卫：`rfc359-w5-composition-root-route-surface`

不写账本、不列 470 条路由（那会让此后每个加路由的 RFC 都欠一笔维护），而是**把两个根都装出来直接比**：
两条 lane 各把自己量到的面记进模块级 map，末尾的 describe 做逐字比对，失败时打印对称差。
比的不只是路径，还带 `tokenAccess` 与**权限集合**——「两侧挂了同一批路径、但某条在一侧要的权限更松」
正是本 RFC 要挡的那种「一个好一个不好」，只比 key 看不见它。

**结论：两个根挂出来的面逐字相等。** `rfc329` / `rfc305` 的那个隐含前提，从此有判据钉着。

变异验证（两条都真红过）：①把 SQLite 那侧的面砍掉一条 ⇒ 对称差里出现该条；
②把 SQLite 那侧某条的 `token=` 改掉 ⇒ 差异里出现 `MUTANT`。

### 写这条守卫时自己踩的两个坑（都是真红，值得记）

**坑一：第一次跑就假红了一次。** 差异是 `POST /webhooks/:provider/:urlToken` 只在 PG 侧挂上。
差点当成产品缺陷——**不是**：`mountWebhookIngressRoutes` 在缺 `webhookDispatcher` /
`digitalEmployeeEventCenter` 时会**自我跳过**，而这一组正是两个根**所有权不同**的那一处
（PG 根自己构造、SQLite 根当依赖收，`ProviderHttpApplicationInput` 的注释与 plan §5bi 已写明）。
生产里 SQLite 侧由 `cli/start.ts:2806-2808` 注入，两侧**是**一样的。夹具补一个最小 dispatcher
（只需带 `dispatchSubscription` 以过 `supportsEventCenterCodeHostDelivery`）后逐字相等。
**教训**：守卫报出的「两个根不一样」，先分清是**根**不一样还是**夹具喂的东西**不一样——
判前必须去看生产装配点。

**坑二：`bun test` 多个文件跑在同一个进程里，而路由注册表是模块级的。**
本守卫刚加上，`bun test tests/architecture/` 里 `rfc329-mcp-surface-guard` 就红了一格
`uncovered`——多出来的正是本文件挂上去的 webhook 入站路由（它**单独跑是绿的**）。
按 `rfc305-architecture-lock` 的既有做法前后各 `resetRouteMetaRegistry()` 一次即解。

### 顺带查明的一处**既有**脆弱（不是本次引入，也不在本次改动里）

`tests/rfc099-acl-endpoints-matrix` 之后紧跟 `tests/rfc305-architecture-lock` 跑，后者必红：

```
system-operations.get-database-runtime.v1: declared operation has no mounted binding
  at assertOperationCatalogClosed (src/platform/operations/catalog.ts:729)
```

成因同属「模块级全局态跨文件泄漏」，但泄漏的是**操作目录**而不是路由注册表：
rfc099 装的应用带 `databaseMigration`，把那条操作声明留在了目录里；rfc305 装的应用**不带**，
于是 `routes.databaseMigration?.(app)` 整组跳过，声明有、绑定无，闭合校验当场抛。
rfc305 只清了路由注册表、没清操作目录，所以清不掉这个。

两个文件单独跑都绿，合起来才红——**CI 现在是绿的，说明分片没把它俩排到一起**，
是一颗埋着的雷而不是当前的红。处置随下一节 AC-6 的三条裁决一起做（rfc305 补上
`databaseMigration` 即可，同 `rfc329` 的做法；它的断言是全称量化的「每条路由都没有 `identity`」，
多挂几组只会更强）。

---

## §5gl　AC-6：§5gi 留下的三条逐个裁决（22 → 19），外加拆掉那颗雷

有了 §5gk 的新守卫做底，三条都能判了。**都走新加的通用判据，没有一条是量身定做的豁免。**

| 文件 | 判据 | 为什么 |
| --- | --- | --- |
| `architecture/rfc329-mcp-surface-guard` | `provider-independent-route-registry` | 装应用只为拿 `allRouteMeta()` 那张「路由 → 权限」表，库是脚手架；那张表与引擎无关这件事现在有 §5gk 的守卫钉着 |
| `rfc305-architecture-lock` | 同上 | 同形状 |
| `rfc349-daemon-provider-core` | `provider-pair-covered-by-name` | 一条用例驱动 `composeSqliteDaemonProviderCore`、紧挨着一条驱动 `composePostgresqlDaemonProviderCore`——**两个引擎都验了** |

### 为什么 `rfc349` 不该迁成 `describeEachProvider`

它的两半断言的是**不同的事**（谁拥有客户端生命周期：SQLite 侧自己 `db.$client.close()`，
PG 侧把生命周期交给外层会话）。塞进同一个 harness 只会逼着用 `capabilities` 再分叉回去——
那是把「两条各自清楚的用例」换成「一条带 if 的用例」，更差。

判据按**配对**认：同一个 X 上 `composeSqliteX(` 与 `composePostgresqlX(` 都出现。
今天只命中这一个文件，但认的是**结构**，此后任何「一对 provider 组合根各验各的」都自动落进来。

**特意没有放宽**成「文件里出现任意 `composeSqlite*(`」：那样一口气能划掉 6 个债务文件，
可其中只有这一个真的两半都覆盖了（其余几个的 `composeSqlite*` 是被测物的**上游装配**，不是被测物）。
§5gi 刚纠正过同一个毛病——「共用一个语法形状」不等于「共用一个根因」，这次没有再犯。

### 顺手拆掉 §5gk 记下的那颗雷

`rfc305-architecture-lock` 装应用时不给 `databaseMigration`，于是：

1. `mountApiRoutes` 里 `routes.databaseMigration?.(app)` 整组跳过，它量到的面**比生产小一圈**
   （RFC-329 的守卫当年正是这么读成 440 条而不是 470 条）；
2. 更要紧的是，操作目录是模块级全局态——`rfc099-acl-endpoints-matrix` 先跑过会把
   `system-operations.get-database-runtime.v1` 的**声明**留在目录里，而本文件不挂它的绑定，
   `assertOperationCatalogClosed` 当场抛 `declared operation has no mounted binding`。
   两个文件单独跑都绿，**排到同一个分片里才红**。

按 `rfc329` 的既有做法补上这一组，两件事一起解决：`rfc099 + rfc305` 从 1 红变 0 红，
而它的断言是全称量化的「每条路由都没有 `identity`」，多挂几组只会更强。

### 账本

`OPEN_MIGRATION_DEBT` 22 → 19（`ledger-baselines.json` 同步改小）。
总账 `TEST_ENGINE_HARDCODING_DEBT` **不动**——这三个文件仍然各有一处直建 SQLite 库，
只是那处从「还没迁的债」重判成「按裁决就该单引擎」。这正是那两张名单要分开数的理由。

---

## §5gm　AC-6：把「文件里已写明理由、只是没判据认领」的三条收进判据（19 → 16）

§5gl 之后剩 19 条。挨个读下去发现有一批的共同点是：**文件里早就有一段写得很清楚的理由**，
说明它为什么该留在单引擎，但 `SANCTIONED_SINGLE_ENGINE` 里没有任何一条判据认领它，
于是它一直被记成「还没迁的债」。这不是迁移量，是**分类没跟上**。

| 文件 | 新判据 | 它自己写的理由 |
| --- | --- | --- |
| `rfc311-repos-page` | `sqlite-plan-vocabulary` | 判据文本是 `EXPLAIN QUERY PLAN` 的 detail 列（`TEMP B-TREE` / 索引名）＋ SQLite 的 `?` 占位符 |
| `rfc311-task-page-fastpath` | 同上 | 同上（它甚至已经写了 `if (harness.capabilities.provider !== 'sqlite') return`） |
| `rfc291-unavailable-mount` | `sync-client-fault-injection` | 被测代码中立、双引擎格已各跑一遍；单引擎的是**注入机制**——`Proxy` 包客户端在同步 `select` 拦截器里当场改库 |

两条判据都按 §5fq 归位：前者是 ③「驱动线上差异」（两个引擎的计划词汇本就不同，
要给 PG 补同类守卫该走 `harness.explain()`，那本来就是另一条判据，不是把这条改成双引擎）；
后者是 ①「引擎独有原语」的一个变体——**独有的不是被测物，是注入机制**：
PG 上 `.run()` 只返回一个没人 await 的 Promise，改库与随后那次读之间没有任何定序，
判据会退化成掷骰子。

### 写判据时踩到判据自己的坑（值得记）

`sanctionFor` 喂给判据的不是原文，是 `codeOnly(text)`：用 TS scanner 把文件重新 tokenize，
**token 之间一律补一个空格**再拼回去。于是源码里的 `allRouteMeta()` 到了判据眼里是
`allRouteMeta ( )`。

后果很隐蔽：`code.includes('allRouteMeta(')` **仍然返回 true**——但命中的是**字符串字面量**
里的那一份（源码层断言的文本原样保留在一个 token 里），真正的调用点反而漏掉。
也就是说判据「通过了」，却是**因为错误的理由**通过的；换一个没写源码层断言的同类文件就会漏判。
`new Proxy(` 那条就没这么走运，直接不匹配，测试当场红——这一红才把上面那条的假通过也暴露出来。

**定式**：往这张表加判据，一律写成带 `\s*` 的正则（`/allRouteMeta\s*\(/`），
不要用 `includes('xxx(')`。既有判据本来就全是这么写的（`/new\s+Database\s*\(/`、
`/dbTxSync\s*\(/`），只是没人写下**为什么**必须这样。

### 顺手修掉新守卫里的一处绕路

§5gk 的守卫原来靠 `capabilities.isolation === 'exclusive'` 反推 provider——
其实 `EngineCapabilities` 上就有 `provider`（`src/platform/persistence/capabilities.ts:74`），
`rfc311-task-page-fastpath` 早就在直接用它。改成直读。

### 剩下的 16 条是什么

不再是「分类没跟上」，是**真的迁移量或真的被别的波次挡着**。已确认的一例：
`start-task-deps.test.ts` 测的 `buildStartTaskDeps` 形参类型是 `LegacySqliteTaskDatabase`
（`= DbClient`，注释自称「provider-private alias for shrinking the legacy SQLite compatibility tail」），
它属于 **legacy 启动路径**那一刀（`services/task` 的 `startExecution` vs `PostgresqlRootTaskLaunchKernel`），
不是一次测试迁移能解决的——**留在债里是对的**，不给它造判据。

---

## §5gn　最大的一处「一个好一个不好」：**17 个文件手搓假 PostgreSQL**

§5gm 把 AC-6 剩下的债说成「真迁移量」。往下挖第一铲就挖到了本 RFC 迄今最集中的一处不对称——
而且它**不在 AC-6 的账本上**，因为账本数的是「直建 SQLite 库的调用点」，
数不到「PostgreSQL 那半根本没连真库」。

### 先纠正我自己上一节的一句话

§5gl 判 `rfc349-daemon-provider-core` 用的理由写成了「两个引擎**都**验了」。
**这句话说过头了**：它 PG 那半跑的是本地手搓的 `postgresqlFixture()`——一个记录 SQL 文本、
回罐头行的**假池**，不是真库。裁决本身仍然成立（那个直建 SQLite 库的调用点，被测物是
`composeSqliteDaemonProviderCore` 这个只存在于 SQLite 的组合函数，换引擎没有这个东西可测），
但理由要写准：判据认的是「SQLite 那个调用点该不该留」，**不保证另一半跑的是真 PostgreSQL**。
判据注释已改。两件事分开记，这一节记的就是后者。

### 清点

按 `function postgresqlFixture` 扫全量测试目录：**17 个文件、5445 行、30 处假池调用**。

| | 文件数 | 行数 |
| --- | --- | --- |
| **A. PG 覆盖全靠假池**（文件里零 `describeEachProvider`） | 8 | 3100 |
| **B. 混合**（既有假池、也有真双引擎格） | 9 | 2345 |

A 组（按行数降序）：`rfc349-task-route-launch-postgresql-adapter`(971) ·
`rfc349-repository-preparation-postgresql-adapter`(392) · `rfc349-task-execution-provider-adapters`(386) ·
`rfc349-child-execution-launch-postgresql-adapter`(350) · `rfc349-source-control-provider-adapters`(350) ·
`rfc349-daemon-provider-core`(257) · `rfc349-resource-limit-provider`(204) ·
`rfc349-execution-peripheral-provider`(190)。

### 假池弱在哪（不是「弱一点」，是量级差别）

假池的 `unsafe` 把 SQL 收进数组、回一组罐头行。于是它**照单全收**：列名写错、少个 schema 限定、
类型不对、真约束冲突、迁移链没建那张表——一律照过。断言只能落在「发出的 SQL 文本里有没有某个子串」，
那是在验**我们自己拼的字符串**，不是验数据库。

### 第一刀：`rfc349-execution-peripheral-provider`（190 行，A 组最小的一个）

迁之前那两格是标准的**一真一假**：

| | SQLite 格 | PostgreSQL 格 |
| --- | --- | --- |
| 库 | 真的内存库 | 假池 |
| `ensureHostWorkflow()` | 调**两次**，验幂等 | 调一次 |
| 断言 | 读回行，验 `id` / `name` / `builtin` | 「某条 SQL 里出现过 workflows 的 schema 限定名」 |

两个 composer（`composeAgentLaunchResourceOperations` / `composeDynamicWorkflowPersistence`）的 `db`
形参**本来就是** `ProviderNeutralDatabase`，所以合一是**零生产改动**：一个
`describeEachProvider`，两个引擎各跑一遍**同一组**断言（真库、读回行、幂等、外部依赖注入）。

丢掉的只有那条 SQL 文本断言——**净赚**，同 §5gd 对 `rfc349-websocket-provider` 的处置：
真 PG 上跑通，是对「投影带 schema 限定名」强得多的证明（写错当场报错，假池照单全收）。

**变异验证（这才是这一刀的价值证据）**：把期望的 `name` 改错 ⇒ **两个引擎各红一格**。
迁移前同一处变异**只会红 SQLite 一格**——PG 那格压根没看 `name`。

账本：总账 329 → 328、`OPEN_MIGRATION_DEBT` 16 → 15（这个文件连 `createInMemoryDb` 也一起没了）。

### 剩下 7 个 A 组文件的处置原则

不是所有假池都能换成真库。判据同 §5fq：
- 断言的是**引擎独有原语的调用形态**（advisory lock、`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
  这类）——真库上要改用 `harness.recordStatements()` 断言**实际执行过**的语句，比假池的字符串匹配更强，
  能迁；
- 被测物是 `composePostgresqlX` 这类 **PG 专属组合根**且需要真连接才能装起来——按需评估；
- 断言的是**错误路径**（连接失败、池耗尽）——假池可能仍是唯一造得出该状态的手段，那是正当的。

逐个过，不一刀切；每迁一个都要求给出**变异验证**（迁移前只红一格、迁移后两格都红），
否则只是把假池换成了真库而没有换来覆盖。

---

## §5go　第二刀：把一处 PostgreSQL 目录查询从「假池 + 字符串匹配」换成真库

§5gn 留了处置原则：不一刀切，逐个判。这一节是按那条原则做的第二刀，也顺带量清了
**组合根层**到底还欠多少。

### 先把「欠多少」量准

§5gn 的 17 个文件是按 `function postgresqlFixture` 数的**文件**。换个更有意义的口径
——按 `src/**/composition*` 下的 `composePostgresql*` **组合根**数，用
`rfc359-w5-provider-runtime-exercised` 同一套 AST 判据（值级 import 绑定 + callee 位置调用）
统计每个根被哪些测试构造、那些测试是不是真库：

| | 个数 |
| --- | --- |
| `composePostgresql*` 组合根总数 | 13 |
| 跑过真 PostgreSQL | 10 |
| 只在假池文件里构造 | 2 |
| 从未构造 | 0 |

（第一版量出 3 个，其中 `composePostgresqlTaskExecutionProviderRuntime` 是**误判**：
它在 `helpers/eachProviderTaskExecution.ts` 里被构造，那个 helper 收的就是 `ProviderHarness`，
只是写成 `const { db } = harness` 解构，我那条「文本里有没有 `harness.db`」的启发式没认出来。
量之前先验样本，别信一条没校准过的启发式。）

**所以组合根这一层基本还完了**（`rfc359-w5-provider-runtime-exercised` 的账本已经是空的）。
§5gn 那 17 个文件欠的是**更下面一层**：端口 / 适配器上的假池。两件事不要混为一谈。

### 这一刀：`rfc349-maintenance-disk-provider`

PostgreSQL 那格原来喂假池，回一组罐头的 `{ database_bytes: '4096', reclaimable_bytes: '512' }`，
然后断言「发出的 SQL 文本里出现过 `pg_stat_user_tables`」。

改成在真库上跑：`harness.applicationBinding` 在 PG 那侧**直接交出真的**
`InstrumentedPostgresqlDatabaseRuntime`，正是 `composePostgresqlMaintenanceDiskOperations` 要的入参。

**没有**把 SQLite 那格并进来：两侧**资源形态**不同（§5fq ②）——SQLite 的 freelist / 文件字节数
要一个真文件库才有意义（那格用的就是 `new Database(<file>)`，本来就落在 `real-file-database` 判据里），
PostgreSQL 问的是服务端目录统计。同一个被测面在两个引擎上问的是两件不同的事，
不该硬塞进一组断言。断言也跟着换形态：字节数随实例而变，能钉的是「**真的问出来了**」
——是有限数、非负、`dbFileBytes > 0`。

**变异验证（这一刀的价值证据，也是最能说明假池问题的一个例子）**：
把生产里的 `pg_catalog.pg_stat_user_tables` 改成 `pg_stat_user_tables_MUTANT` ⇒
新用例红在 `PostgresError: relation "pg_catalog.pg_stat_user_tables_mutant" does not exist`。
**而原来那条断言会照过**——`toContain('pg_stat_user_tables')` 在
`pg_stat_user_tables_MUTANT` 上是 true。假池不只是「弱一点」：
它在这个具体例子里对「表名写错」这类错误是**完全失明**的。

### 顺手又踩一个坑：改测试标题会撞到按名字钉死的账本

`tests/helpers/rfc349FunctionalEvidence.ts` 给每条验收组挂 `{ testFile, testName }`，
守卫拿 `testName` 去目标文件里 `toContain("test('<名字>'")`。于是**只改标题**就会红，
而且红在**另一个文件**上，报错里看不出是重命名干的。
跟「按文件名钉死的 digest 守卫」同一个家族：跨文件、按字符串做外键、编译器管不着。
已落 `docs/dev-gotchas.md`（定式：改了标题就 grep 一遍提到这个文件名的测试，一起跑）。

---

## §5gp　给「手搓假 PostgreSQL」上判据（新守卫，高水位只降不升）

§5gn / §5go 一个一个迁，管的是**存量**。这一节管**增量**——用户明确要的那条：
「新增功能天然要验证到两种数据库能力」。存量迁得再多，只要没人拦着，下一个 RFC
照样能再手搓一个假池，债又长回来。

### 为什么隔壁那条守不到这里

`rfc359-w5-provider-runtime-exercised` 守的是「provider 组合根有没有被测试**构造**过」，
它的账本**已经清零**。但「构造过」与「在真 PostgreSQL 上跑过」是两件事——
**那条守卫自己的头注释就把这件事列为已查实的危害 ③**：
「确实构造了适配器，但喂的是假 pool——它证明的是接线，不是 PostgreSQL 行为。」
危害写在那儿，判据却没跟上。本守卫补的就是这一层。

### 判据

一个**对象字面量**被直接安上 provider 运行时类型：`PostgresqlPool` /
`PostgresqlReservedConnection` / `PostgresqlDatabaseRuntime`，注解或断言都算。
用 AST 不用正则——注释与字符串字面量里出现同样的字不该算数，而剥注释的正则迟早吃掉真代码。
账本 `<相对 tests 的路径>: <个数>`，逐字相等，两个方向都红。

**落地时 69 个文件、183 处。**

### 写这条判据时它自己漏了一次（这次是负 fixture 抓到的）

第一版只认「对象字面量**直接**挂类型」。我拿 `{ … } as unknown as PostgresqlPool` 去探——
**探针没红**。`as unknown` 那一跳（写它就是为了绕开类型检查）把字面量藏在了两层断言底下。
真语料里确实躺着一处（`rfc359-w6-t26-postgresql-plan-audit`），第一版账本因此少记了它。

**一个探不出新增的高水位守卫等于没写**——它全部的价值就是挡住新增。
修法是剥掉中间的断言 / 括号再看底下是不是字面量，并把这个写法补成一条负 fixture。

顺带修掉剥壳引入的**重复计数**：`const p: PostgresqlPool = { … } as unknown as PostgresqlPool`
会同时命中「带注解的声明」与「外层断言」两条，那是同一个假池把类型写了两遍。
改成数**不同的对象字面量**（`Set<ObjectLiteralExpression>`）而不是数命中的节点。

### 刻意**不**做分类

清单里混着两类，而本守卫不分：

- **正当的**：被测物就是驱动 / 编译器本身，真库反而看不到要验的东西。
  `rfc359-w22-postgresql-compile-reuse` 拿假池当**编译探针**——收下编译出来的 SQL 然后
  `throw` 在驱动执行之前，验的是 `?` → `$1` 那套翻译；
  `rfc349-resource-limit-provider` 数的是**连接 reserve 次数**与单行 INSERT 的围栏折叠形态，
  真池给不出这个观测点。
- **该还的债**：被测物是业务行为，却拿罐头行代替数据库（§5gn 的 A 组）。

不分类是**有意的**：分类必须逐个读源码，而按语法形状聚类正是本 RFC 反复栽跟头的地方
（§5gh → §5gi）。与其造一个分不准的判据把债洗成绿数字，不如让这个数字保持"混着"、
**在降它的时候由人指名是哪一类**。长期目标不是 0（正当的那类会留下来），是债那部分清零。


---

## §5gq　自查清单上补两条（都是这一段自己踩出来的）

### 一、`--randomize` 下不能依赖用例先后（§5gk 的守卫被这条推红过一次）

`rfc359-w5-composition-root-route-surface` 第一版把「两条 lane 各记一格」与「比对」拆成两个
`describe`，比对那个注册在后面。默认顺序下它确实后跑，**本地怎么跑都绿**；
CI 跑的是 `bun test --isolate --randomize`（`.github/workflows/ci.yml:228`，
那个 flag 存在的理由就写在旁边：expose any remaining within-file order dependency），
随机序下比对先执行、读到空 map，`Backend tests (macos-latest shard 2/6)` 当场红。

这条规矩 `docs/dev-gotchas.md` 早就写着（RFC-310 的 journey 测试撞过），
**我没认出来是因为形状变了**：那次是「第一个 test 建、第二个 test 断言」，
这次是「两条 harness lane 生产、另一个 describe 消费」。共享可变状态的两端换了张脸，规矩没变。

改法：把比对并进 lane 用例本身——记完自己的面就地判断「两条都到齐了吗」，**谁后跑谁负责比对**。
只有一个引擎在跑时如实跳过，而不是假装比过了。

### 二、后台 watcher 静默失效：`set -- $VAR` 在 zsh 下不分词

本段我一连起了 5 个「推完盯 CI」的后台循环，核心是：

```bash
RUN=$(gh api … --jq '"\(.id) \(.status) \(.conclusion)"')
set -- $RUN
if [ "$2" = "completed" ]; then …
```

zsh 不对未加引号的变量分词，于是 `$1` 是整串、`$2` **恒为空**，条件永不成立。
**5 个 watcher 一个都没工作过**——只能靠跑满轮次超时退出。
更糟的是后台任务「没有输出」与「还在跑」长得一模一样，所以它失效了 40 分钟我都以为在盯着。

这条 `docs/dev-gotchas.md` 也早写着（`git add $FILES` 那一族，已经是第五次），
但前四次都会**炸出报错**，这次是**静默**的——而它守的恰恰是「推红了要立刻知道」。
真正的 CI 结论一直是我在前台直接 `gh api` 查的，所以本段报出去的绿 / 红都没错；
错的是「我以为有人替我盯着」。

**补进自查清单的一条**：写完「条件满足才动作」的循环，先拿一个**已知满足条件**的输入试跑一遍。
这 5 个里任何一个，只要拿一个早已 completed 的 SHA 试一次，就会当场暴露。

---

## §5gr　AC-6 剩余 15 条里，两条的 blocker 现在有名字了

§5gm 说剩下的「是真迁移量或真被别的波次挡着」。逐个读时把**挡在哪**落实到具体行，
这样下一波开工时不用重新推一遍。

### `rfc349-digital-employee-platform-tools-wiring`：卡在**同步 SQLite 根 vs 异步 PG 根**

这个文件是回归防护，锁的是一个真出过的产品事故：`/work-items/:ref/tools` 在 SQLite daemon 上
恒返回 `{"items":[]}`，岗位模版编辑器里「选择默认工具」整个下拉不存在，零配置上手流程断掉。

查下来两个根拿同一份平台工具目录的**方式不同**：

| | 怎么拿到 `platformTools` |
| --- | --- |
| PostgreSQL 根 | `postgresqlDaemonApplication.ts:1503` **就地 `await` 构造**，不可能缺 |
| SQLite 根 | `server.ts:2527` 的**可选注入**——`deps.digitalEmployeePlatformTools` 没给就条件展开成空 |

**事故正是后者的必然结果**：`cli/start.ts` 当时只把目录交给了自己那份 `employeeOs`，
忘了交给 `createComposedApp`，而那是个可选参数，于是**静默**少了一整个面。
这个测试文件存在的唯一理由，就是拿一条源码文本断言（grep `start.ts` 里有没有把它传进
`composeSqliteAppDeps`）替那个可选参数把关。

按 §5fq 这是**漂移**不是引擎固有差异，处方也是现成的（§5fy / §5ge 的「装配者提供答案」：
让弱的那半也自己造）。**但它现在做不了**，原因很具体：

- `composeDigitalEmployeeBuiltinToolCatalog` 是 **async**（`digitalEmployeeBuiltinToolCatalog.ts:91`）；
- `composeSqliteAppDeps` 是 **sync**（`server.ts:1813`，`createApp` 一路同步返回）。

同步的根 `await` 不了异步的目录，所以只能退化成「让调用方先 await 好再注入」——
可选注入与那条源码文本断言都是这个形状逼出来的。PG 根因为本来就在异步装配路径上，就地 await 即可。

**所以这一条不是「忘了迁」，是压在「组合根签名对齐 / 合一」那一波下面**——而且它给那一波提供了
一个比「签名不对称」具体得多的理由：**不对称的不只是签名，是同步性**，
而同步性差异正在制造真实的产品事故（上面那条）与只能靠 grep 源码兜底的测试。

### `start-task-deps`：卡在 legacy 启动路径

同 §5gm 已记：`buildStartTaskDeps` 的形参类型是 `LegacySqliteTaskDatabase`
（`= DbClient`，注释自称「provider-private alias for shrinking the legacy SQLite compatibility tail」），
属于 `services/task` 的 `startExecution` vs `PostgresqlRootTaskLaunchKernel` 那一刀。

### 一次差点报错的假警报，记下来当判据

查这条时我先 grep `digitalEmployeePlatformTools`，PG daemon **零命中**，差点当成
「PG 侧根本没接平台工具目录」的产品缺口报出去。实际 PG 侧接了，只是**没有用那个中间变量名**
（直接 `platformTools: await composeDigitalEmployeeBuiltinToolCatalog({…})`）。
**按变量名找「另一侧有没有做同一件事」是坏判据**——两个根本来就不共享局部变量命名。
正确的问法是「同一个**消费点**（这里是 `composeDigitalEmployee({ platformTools })`）
两侧是不是都喂到了」。

---

## §5gs　AC-1 命名债：`composeSqliteWebhookDispatchCore` 改名（无孪生，前缀纯属历史）

`proposal.md` AC-1 第三款把 provider 命名文件 / 符号分成两类：**死代码**（删）与**命名债**
（provider 命名、但根本没有孪生实现——它就是那件事的唯一实现，前缀是历史遗留，处方是**改名**）。
这一条是后者，而且是个干净的样本。

### 认定

`composeSqliteWebhookDispatchCore`：

- 形参**早就是** `ProviderNeutralDatabase`（函数上方注释写着是哪一轮放宽的，但名字没跟上）；
- 全仓**没有** `composePostgresqlWebhookDispatchCore`，也没有任何别的孪生；
- 它转交的四件（dispatch / delivery 持久化、仓库解析、启动准入）形参全部中立。

也就是说它是**唯一实现**，`Sqlite` 前缀不指向任何区分。

### 留着的实际代价（不是不好看）

全仓有好几处判据按 `composeSqlite*` 这个**形状**找「provider 专属实现」。一个没有孪生的中立函数
顶着这个前缀，会让那些判据把它数成「还有一份 SQLite 专属实现」。§5gl 里我拒绝把
`provider-pair-covered-by-name` 放宽成「出现任意 `composeSqlite*(`」，理由之一正是这个——
那条放宽会一口气划掉 6 个债务文件，而其中多数的 `composeSqlite*` 是**上游装配**、不是被测物。
名字修干净，这类误判的来源就少一个。

### 改动

21 处（10 个文件：1 个生产 `cli/start.ts`、1 个定义处、8 个测试）。
**词边界正则**——§5gf 的教训：`composePostgresqlDigitalEmployee` 是 `…Execution` 的前缀，
当时一次 blanket replace 把两个符号一起改坏、连账本文本都改坏了。这次先查前缀碰撞（无），再改。

### 三条「语料非空」下限各减一

`rfc359-w5-identical-provider-twins`（91 → 90）、`rfc359-w5-adapter-production-consumer`（87 → 86）、
`rfc359-w5-provider-runtime-exercised`（19 → 18）。三条都按**名字**派生分母，改名即退出分母——
**退的是命名债，不是覆盖**。三处各留了署名理由（与它们此前几次下调同一格式）。

### 验证

`tsc` / `eslint --max-warnings 0` / prettier 干净；`tests/architecture/` 706 全绿；
改动触及的 8 个 webhook / e2e 测试两批跑完 64 + 36 全绿。

### 顺带澄清一件不是我干的事

改完跑 prettier 时，`git diff` 里冒出 `packages/system-mocks/src/cli.ts` 的一处 **mode change**
（644 → 755，内容零差异）。那是别人的在制品文件，我先怀疑是自己的 `prettier --write` 带的。
**实测排除**：拿一个 644 的临时文件跑 `prettier --write`（改写与「unchanged」两种路径都试），
mode 一动不动。所以那是并发 session 自己 chmod 的（给 CLI 入口加可执行位很合理），
按多人协作规矩**原样留着、不进暂存区**。

---

## §5gt　AC-1：`AppDeps.secretBox` 收成必填——删掉 11 处生产上到不了的容忍分支

§5gr 把「SQLite 根可选注入 vs PG 根自建」记成了压在组合根合一之下的 blocker。
逐项查下去发现**其中一项是可以单独摘出来做的**，而且它是这类不对称里最纯粹的一个。

### 先把「生产上到不了」证实，而不是推断

`server.ts` 里有 **11 处** `deps.secretBox === undefined ? … : …`，撑起下游一串可空值
（`oidcProviders` / `codeHostConnections` / `webhookEndpointService` / `resourcePackageBinding` /
`repositoryTransport`）。判断它们是不是死代码，靠的不是「看起来不会发生」：

- `cli/start.ts:1480` 在**选 provider 之前**无条件 `createSecretBox(Paths.secretKeyFile)`，
  源码注释原话是 "Provider-independent bootstrap secrets are needed by either selected composition"；
- PG 根（`postgresqlDaemonApplication.ts`）的 `secretBox` 本来就是必填入参；
- **决定性的一步是类型层 dry run**：把 `secretBox?:` 改成 `secretBox:` 再跑 `tsc`，
  **23 条错误全部落在 16 个测试文件，`src/` 零错误**。
  也就是说「省略 secretBox」这件事**只有测试在做**，生产两个引擎都不可能走到那些分支。

可选性唯一的服务对象是「省事不传的测试」，代价却是一处纯粹的装配签名不对称。

### 做了什么

1. `AppDeps.secretBox` 改必填（原 doc 注释写着「Tests that do not exercise OIDC can omit it」，
   那句话正是这笔债的自述）；
2. 删掉 11 处容忍分支：5 处条件展开 `...(x === undefined ? {} : { secretBox: x })` 收成普通字段，
   6 处 `x === undefined ? null : construct(…)` 收成直接构造；
3. `OidcAuthRouteBindings.providers` 的 `| null` 一并去掉——**两个根都无条件构造它**
   （`server.ts` 与 `postgresqlDaemonApplication.ts:683` 同一句），于是它撑起的两条 503
   （`oidc-not-configured`）也是死的；
4. 16 个测试文件补上 `secretBox`。

### 一格测试连同它锁的分支一起退役

`rfc221-login-policy-routes` 有一格 `no-secret deployment`，**故意不传 secretBox**，
断言退化后的那两条 503。改完之后**被测状态不复存在**——实测那两条断言从 `503` 变 `404`
（路由现在真的走进服务，只是没有名叫 `corp` 的 provider）。

这不是「测试碍事就删」：该文件的注释**当年就写明**「正解是把 SQLite 根的 secretBox 收成必填、
删掉 null 分支与那两个 503，那样这条用例连同本文件最后一条账本残留一起消失——但那要改 47 个
测试文件的 createApp 入参并动生产路由分支，独立一刀」。现在正是那一刀，而实测代价是
**16 个文件而不是 47 个**（那个估数偏大）。文件其余部分本来就在双引擎作用域上跑。

账本：总账 328 → 327、`OPEN_MIGRATION_DEBT` 15 → 14。

### 顺带查实的一处**既有**雷（非本次引入，本次不修）

跑批验证时 `rfc107-url-upload-multipart` 在 8 文件批里红 13 格，单跑 13 全绿。
二分下来是 `rfc165-agent-launch` 或 `rfc165-scheduled-kinds` 任一与它同批即红。

**它不是我改出来的**：把 `server.ts` / `oidc-auth.ts` / 这两个测试文件一起 `git checkout` 回 HEAD
再跑同一对，**照样 13 红**。属于与 §5gk 记的 `rfc099 → rfc305` 同一类的跨文件全局态泄漏，
CI 现在是绿的说明分片没把它们排到一起——又一颗埋着的雷，单独记账，不折进本节。

**方法论上值得记一笔**：怀疑「是不是我改红的」时，最快的判法不是读代码推断，
而是**把涉及的文件整组 checkout 回 HEAD 跑一遍**——几十秒给出是非题的答案。
（这一步不能用 `git stash`，本仓禁用；用 `cp` 备份 + `git checkout --` + 还原即可。）

---

## §5gu　把 main 推红一次：摘要守卫的半径，我自己记过又用窄了

§5gt 推上去后 `02408ca5a` 两个后端分片红，红的是**同一条**判据：
`rfc359-w29-unstarted-application-composition` 里对 `composeSqliteApplicationDeps` /
`composeSqliteApiRouteMounts` 函数体的 **SHA-256 摘要**。改了函数体，摘要当然变。

### 为什么半径没罩住它

本 session 早先就记过这条教训（摘要守卫里**一个符号名都没有**，按符号名找依赖必然漏），
处置也写过：**按「改动的源文件名」找依赖**——而仓库里正好有一条现成命令干这件事
（`scripts/tests-referencing.sh`，见下）。

这次我做的是 `bun test packages/backend/tests/architecture/` ——**把「架构守卫」默认等同于
「`tests/architecture/` 目录」**。而这条摘要守卫在 `tests/`，不在那个目录下。
判据放在哪个目录是**历史**，不是分类；按目录猜半径，等于把「我以为守卫都在哪」当成了事实。

正确的半径命令**仓库里早就有**，这才是这一条真正的教训：

```bash
scripts/tests-referencing.sh server.ts oidc-auth.ts        # 列出按文本引用了这些路径/符号的后端测试
bun test $(cat list.txt)                                    # zsh 下必须 $(cat …) 或 ${=VAR}，裸 $VAR 不分词
```

`scripts/tests-referencing.sh` 的头注释写着它就是为这件事存在的：
「改文件名 / 删文件的刀，本地批次要按这个清单选，而不是按 RFC 号」，
后面还记着两次因为不按它选而漏掉账本的事故（2026-09-05 D18 / D19a）。

**实测它能罩住这次的红**：`scripts/tests-referencing.sh server.ts oidc-auth.ts` 交出 **68** 个文件，
`rfc359-w29-unstarted-application-composition` 就在里面。跑完 **728 例全绿**。

所以这条不是「半径该怎么算」——仓库已经给出答案了。是**我没用仓库的工具，自己手搓了一个更窄的**
（先手写 `readFileSync` 过滤拿到 50 个，再把它窄成 `tests/architecture/` 一个目录）。
`docs/dev-gotchas.md` 里那条「本地自查要跑**仓库自己的脚本**，别手搓文件清单（2026-09-14 连撞两次）」
说的就是这件事，这是第三次。

### 同一条命令里又踩了一次 zsh 分词

第一次跑这个半径时写的是 `FILES=$(python3 …); bun test $FILES` ——
zsh 不分词，50 个路径被当成**一个过滤串**，bun 回「10443 files were searched」然后 0 例。
**这是我在上一笔（§5gq）刚写进 gotchas 的那条坑，隔了不到一小时又踩**；
区别只是上次是 `set -- $VAR`、这次是 `bun test $FILES`（而后者正是 gotchas 里**原本就写着的**那个例子）。

两条教训合起来指向同一件事：**文档里写着不等于用上了**。gotchas 第四次复发那条的结语
（「一份很长的踩坑文档，只有在动手前真的去查才有用」）在这里第二次被兑现。
可操作的收敛：**改了 `src/` 下任何文件，提交前固定跑一次上面那个 `readFileSync` 半径**，
别按目录猜、也别用裸变量传路径。

---

## §5gv　给最后一道波次做实地勘察：启动面合一，比账本上看起来近得多

AC-1 的同文件孪生还剩 19 条，其中挂 `漂移待合` 的 10 条里 **9 条的理由是同一句**：
「挡在下层——下层仍是品牌实现」，而且多数还补了一句「且这条路还挂在 `services/task` 的
SQLite 专属启动面上」。AC-6 剩下的 14 条里 `start-task-deps` 也指着同一处。

**也就是说：RFC 剩下的硬缺口基本收敛成一道波次——启动面合一。** 这一节把它勘察清楚，
让下一步是「动手」而不是「再研究一遍」。

### 差异的真身

`actionExecutionEnvironment.ts` 里那一对把问题摆得最清楚：

| | 怎么启动一个 host task |
| --- | --- |
| `createSqliteActionExecutionEnvironment` | `await startTask(startInput, { ...deps.startDeps, … })` —— **legacy 启动面** |
| `createPostgresqlActionExecutionEnvironment` | `await deps.launch.launch({ actor, resourceAuthority, invoker, task, subject, internal })` —— **启动内核** |

这不是「同一件事写了两遍」，是**两套启动机制**。所以这一层合不了——得先让两边走同一条启动路。

### 勘察结果一：内核几乎已经是中立的

`postgresqlTaskRouteLaunchOperations.ts`（1339 行）里 PG 独有原语的计数：
`$client` / `unsafe(` / `providerPool` / `pg_` / `RETURNING` / `ON CONFLICT` / advisory lock /
`REPEATABLE READ` / `dbTxSync` —— **全部为 0**。

把 `PostgresqlRootTaskLaunchDependencies.db` 从 `PostgresqlDatabaseClient` 改成
`ProviderNeutralDatabase` 做类型层 dry run：**整棵树只剩 2 条错误**，而且都在这个文件里。
也就是说那个品牌标注**基本是编译期的**，与 §5fz / §5ga 合掉的那几对同一形状。

（dry run 已还原，本节不含生产改动。）

### 勘察结果二：唯一那条真耦合，仓库里**已经有中立替身**

2 条错误里实质的那条在第 732 行：`withPostgresqlSerializableTaskExecution(dependencies.db, …)`
——PG 的可串行化事务包装（带序列化失败重试）。这是 §5fq ① 的真原语，不能硬套。

但 `platform/persistence/databaseTransaction.ts` 里**早就有**中立的 `DatabaseSession.serializable(body)`：
- 它的注释直说「蓝本：`postgresqlTaskLifecycleTransaction.ts` 的 `withPostgresqlSerializableTaskExecution`」；
- PG 侧渲染 `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` + 序列化失败重试；
- **SQLite 侧已实现**：`serializable: transaction`，注释写明「`BEGIN IMMEDIATE` 下整个库独占，
  已是最强隔离；serializable 与 transaction 是同一条路」。

**这道波次看起来最硬的一块（事务语义跨引擎等价），其实已经做完了**，只是内核还在用旧的品牌 helper。

### 于是这道波次的实际形状

1. 内核换用 `DatabaseSession.serializable` + `db` 放宽到中立句柄 —— **小**（1 个调用点 + 2 条类型错）；
2. `PostgresqlTaskRouteWorkspaceParticipant` 中立化 —— 待测；
3. **把 SQLite 侧的调用方从 legacy `startTask` 迁到内核** —— **这才是大头**；
4. 退役 `services/task` 的 legacy 启动面。

第 3 步是产品行为面上的真改动（两条启动路的准入、资源授权、事件发布顺序都要对齐），
不是一次放宽形参能解决的；它也正是 AC-1 那 9 条与 AC-6 的 `start-task-deps` 共同的解锁点。

**本节只做勘察、不含生产改动**：这一刀要退役一整条启动路，属于该由用户点头的方向性决定，
而勘察做完之后那个决定的成本已经很低——上面四步各自的大小都在这里写着了。

---

## §5gw　AC-1 命名债：可串行化事务包装的两个品牌名退役（**只改名，不预支放宽**）

§5gv 勘察出「启动面合一」的第 ① 步是「内核换用中立 session + `db` 放宽」。这一节做掉其中
**与启动面无关、可独立验证**的那半：两个纯品牌名。

### 认定

`postgresqlTaskLifecycleTransaction.ts` 里：

- `withPostgresqlSerializableTaskExecution` —— 函数体就是
  `return await databaseSessionFor(db).serializable(body)`，**一层转交**；
  而 `databaseSessionFor` 按引擎派发，**两个引擎早就都实现了 `serializable`**
  （PG 渲染 `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` + 序列化失败重放；
  SQLite 是 `serializable: transaction`，因为 `BEGIN IMMEDIATE` 下整库独占已是最强隔离）。
- `PostgresqlTaskExecutionTransaction` —— `export type … = DatabaseTransaction`，**纯类型别名**。

两个都没有孪生，前缀不指向任何区分：AC-1 第三款的「命名债」。
改名 45 + 13 处、21 个文件（词边界正则，先查前缀碰撞——无）。

### 特意**没有**顺手把形参放宽（这是本节的主要判断）

放宽 `db: PostgresqlDatabaseClient → ProviderNeutralDatabase` 本身**零成本**：实测 0 条类型错。
但它要新引一条 `@/db/query` 的**跨 context import**，于是
`rfc294-cross-context-observed-imports`（5100 → 5101）与
`rfc294-architecture-exceptions`（4587 → 4588）各涨一条，`rfc317-ledger-highwater` 当场红，
要挂 `allowGrowth` 才能过。

而 `allowGrowth` 的语义是「**在下一个不涨的 commit 上被判为过期、强制清理**」——
也就是说我挂上它，下一个提交的人就会莫名其妙红一格。
为一个**现在没有任何调用方需要**的放宽，去加一条跨域耦合、再给下一个人埋一次必红，不划算。

所以：**改名落地，放宽留给启动面合一那一刀**。到那时 SQLite 侧真要传中立句柄进来，
这条 import 是被需求逼出来的，不是预支的。理由写在函数的 doc 注释里，下一个人不用重新推一遍。

（顺带一提，这个取舍本身是 `rfc317-ledger-highwater` 这条守卫**起作用**的样子：
它把「顺手放宽一个形参」的真实代价——一条跨域耦合 + 一次给别人埋雷——摆到了台面上。）

### 半径这次用对了工具

按 §5gu 的教训，用 `scripts/tests-referencing.sh` 而不是手搓清单。它交出 51 个文件，
**咬出两条按名字/行号钉死的账本**，都不是我会想到的地方：

- `rfc359-w11-dialect-ledger-conformance`：断言该文件的导出名清单，而清单是 `.sort()` 之后比的
  ——改名把**字典序**也改了（`withPostgresql…` 现在排在 `withSerializable…` 前面）；
- `rfc359-w7-task-insert-lineage-completeness`：按 **`文件:行号`** 登记 `insert(tasks)` 站点。
  改名让符号变短、prettier 把 import 块重排，站点从 739 变 737。

**第三种「按位置钉死」的账本形态**（前两种是按符号名、按测试名）。它们的共同点还是那句：
跨文件、按字符串做外键、编译器管不着。半径跑对了就都能捞到。

验证：`tsc` / `eslint --max-warnings 0` / prettier 干净；半径 51 文件 585 例全绿；
`tests/architecture/` 706 全绿；census 重跑后 highwater 无增长。

---

## §5gx　更正 §5gv 的第 ② 步：那批 `Postgresql*` 名**不该现在改**

§5gv 把启动面合一拆成四步，第 ② 步写的是「`PostgresqlTaskRouteWorkspaceParticipant` 中立化（待测）」。
测完了，**结论是反的：不该做。**

### 测了什么

那一带是一整族名字，全部零 SQLite 孪生：

| 符号 | 带 `Postgresql` 的文件数 | 带 `Sqlite` 的 |
| --- | --- | --- |
| `…TaskRouteWorkspaceParticipant` | 6 | **0** |
| `…TaskRouteWorkspaceRepository` | 4 | **0** |
| `…WorkgroupRouteLaunchResources` | 2 | **0** |
| `…TaskWorkspaceMaterializer` | 5 | **0** |
| `…TaskWorkspacePreparation` | 3 | **0** |
| `…TaskRouteWorkspaceDependencies` | 4 | **0** |

按 §5gw 那条「无孪生 ⇒ 命名债 ⇒ 改名」的判据，六个都该改。**但那条判据在这里用错了地方。**

### 为什么不该改：`proposal.md` AC-1 第三款自己划了这条线

第三款把 provider 命名分成两类，处方不同——而且明确写了**哪一类要保留前缀**：

> **登记在册的真分叉保留其 provider 名**，因为改成中立名反而会掩盖
> 「这份实现只服务一个引擎」这个必须一眼可见的事实。

`withPostgresqlSerializableTaskExecution`（§5gw 改掉的那个）属于**命名债**：
它的函数体就是转交给一个**两个引擎都实现了**的中立能力，前缀不指向任何区分。

这一族不是。它们是**启动内核那条路的类型面**，而那条路**今天确实只有 PostgreSQL 在走**
（SQLite 侧走 legacy `startTask`，见 §5gv 的对照表）。把 `Postgresql` 去掉，
读代码的人就再也看不出「这条启动路只服务一个引擎」——**那正是本 RFC 最想让人一眼看见的事实**。

### 所以第 ② 步作废，四步变三步

启动面合一的实际形状修正为：

1. 内核换用 `DatabaseSession.serializable` + `db` 放宽（§5gw 已做完前半的改名；放宽等到真有调用方需要）；
2. ~~workspace participant 中立化~~ —— **取消**：它的前缀是准确的，等第 3 步之后再谈；
3. 把 SQLite 侧调用方从 legacy `startTask` 迁到内核（**大头**，产品行为面的真改动）；
4. 退役 `services/task` 的 legacy 启动面。

**改名这件事的次序是：先合实现，再改名。** 反过来做，中间那段时间里名字在撒谎。

### 记一条判据使用规则

「无孪生 ⇒ 命名债 ⇒ 改名」这条判据**只在被测物本身是中立实现时成立**。
被测物真的只服务一个引擎时，同样的「无孪生」指向的是相反的处方——**保留前缀**。
判据给的是嫌疑，不是裁决；这已经是本 RFC 第 N 次在同一件事上摔跤（§5gb / §5gc / §5gf / §5gh → §5gi）。

---

## §5gy　启动面合一的第一份**用户可见**证据：同一个失败，两条路的文案不一样

§5gv / §5gx 把启动面合一的理由写成了「AC-1 的 9 条挂在这里」——那是**账本视角**的理由。
这一节补上一条**用户视角**的：同一个失败原因，换个数据库跑，用户读到的话不同。

### 怎么撞上的（含一次我判错的过程，照实记）

放宽 `PostgresqlTaskRouteWorkspaceDependencies.db` 时 `tsc` 指到一处调用，顺着看见
`services/task.ts` 的 `loadFrozenSpaceLayout` 是**同步**函数、用 `.all()`。
本轮 probe 实测：同一句 `.all()` 在 SQLite 上交回**数组**、在 PostgreSQL 上交回 **Promise**
（`length` 为 `undefined`）。据此我判断 PG 上那条「源任务没有冻结快照」的校验会被跳过、
随后 `rows.filter(...)` 抛 TypeError——一个真缺陷。

**判断是错的，写了用例才发现**：`postgresqlTaskRouteWorkspaceParticipant.ts` 有**自己的**
`async loadFrozenSpaceLayout`（同文件第 66 行），压根没用 `services/task.ts` 那份。两个引擎跑下来
都是同一个 `source-task-not-replayable`。**幸亏是先写用例再下结论**——这条要是照着推断报出去，
就是一个凭空的「PostgreSQL 缺陷」。

### 真正的发现

同一段逻辑**写了两遍**，而两遍的用户可见文案不同：

| 走哪条启动路 | 源任务的仓缺 cached mirror id 时，用户读到 |
| --- | --- |
| legacy（`services/task.ts`，**SQLite 在用**） | `has N repo(s) with no cached mirror id; … (relaunch by picking a repo or repo group instead)` —— 报计数，并告诉你改用「挑一个仓 / 仓库组」 |
| 内核（PG participant 自带那份，**PostgreSQL 在用**） | `has a repo with no cached mirror id; …` —— 没有计数，也没有那句指引 |

两份还各有各的写法：legacy 先 `filter` 再一次性报总数，内核在循环里遇到第一个就抛。
**同一个失败原因，换个数据库跑，用户得到的帮助不一样**——SQLite 上那句「改用挑仓或仓库组」
是可操作的指引，PostgreSQL 上没有。

这是 AC-8（用户可见行为逐字不变）意义上的**真差异**，也是启动面合一第一条不靠账本、
直接对着用户说得清的理由。

### 顺带补了一条这条路此前没有的覆盖

`rfc359-w5-frozen-space-layout-provider-parity`：两个引擎各跑一遍「重放一个没有冻结仓快照的源任务」，
断言拒绝的**种类**一致（并显式挡住 `is not a function` 那种把 Promise 当数组用的结局）。

为什么此前没有：这条路唯一的 PostgreSQL 覆盖
（`rfc349-repository-preparation-postgresql-adapter`）用的是**手搓假池**，而且喂 `scratch: true`
的任务——那条路径走不到 `loadFrozenSpaceLayout`。**假池 + 绕开的路径**，正是 §5gn 清点的那类缺口，
这里又见到一个实例。

### 对波次的影响

合一时**必须挑一份文案留下**，而不是让两份各自活着：按「取强的那半」（§5fq 的一贯处方），
留 legacy 那份带计数与指引的措辞。这条要写进迁移清单——否则合一会悄悄把用户的帮助文案降级。

---

## §5gz　启动面合一 Step A：整叠启动内核放宽到中立句柄（0 条类型错）

§5gv 把波次拆成三步，第 ① 步是「内核换中立 session + `db` 放宽」。§5gw 做掉了前半（改名），
并**刻意没做**后半（放宽），理由写得很清楚：「现在没有调用方需要，为预支的放宽加一条跨域耦合不划算」。

**现在有调用方了**——Step ③ 要让 SQLite 侧把自己的库传进同一台启动内核。于是后半在这里落地。

### 改了什么

三处 `db: PostgresqlDatabaseClient` → `ProviderNeutralDatabase`：

- `postgresqlTaskRouteLaunchOperations.ts`（启动内核，1339 行）
- `postgresqlTaskRouteWorkspaceParticipant.ts`（工作区物化，232 行）
- `withSerializableTaskExecution`（§5gw 刚改过名的那层薄包装）

**实测 0 条类型错**。这不是运气：那一叠里 PostgreSQL 独有原语（`$client` / `unsafe(` /
`providerPool` / `pg_` / `RETURNING` / `ON CONFLICT` / advisory lock / `REPEATABLE READ` / `dbTxSync`）
**计数全为 0**（§5gv 已量过），品牌标注基本是编译期的。

### 代价与它的还款计划

三条新的 `@/db/query` 跨 context import，`rfc294-cross-context-observed-imports` 5100 → 5103、
`rfc294-architecture-exceptions` 4587 → 4590，两本账都挂了 `allowGrowth` 并点名本 RFC。

**这三条会随波次收尾一起还**：legacy 启动面退役后，那一叠只剩一个中立实现，
品牌名与多余的装配层一并消失。`allowGrowth` 的「下一个不涨的 commit 判过期」语义在这里是**对的**
——它逼着这笔债在很短的窗口里被处理，而不是长期挂着。

### 两条操作教训

**一、`PostgresqlDatabaseClient` 的 import 会变成死导入。** 放宽形参之后那个类型在文件里
就没人用了，`tsc` 不管，`eslint --max-warnings 0` 当场红。改完形参就得回头看 import——
这是本 session 第四次撞同一类（迁移/放宽 ⇒ 死导入），已经成定式了：**改完跑一次改动文件的 eslint**。

**二、按 `文件:行号` 钉死的账本要在**所有编辑落定之后**再更新。**
`rfc359-w7-task-insert-lineage-completeness` 按行号登记 `insert(tasks)` 站点。我先把它改成 738，
接着删掉那条死导入、行号又退回 737，于是白红一轮。这类账本的更新必须是**最后一步**，
别在编辑中途「顺手」改。

### 验证

`tsc` 0 错；`eslint --max-warnings 0` 干净；`tests/architecture/` 706 全绿；
`scripts/tests-referencing.sh` 半径 21 文件 244 例全绿。

---

## §5ha　启动面合一 Step B 的**确切**卡点：协调器锁在 legacy 单体里

Step A（§5gz）把内核那一叠放宽到中立句柄之后，Step B 是「让 SQLite 组合根造出这台内核」。
把它需要的东西逐项对到两个 daemon 上，卡点收敛成**一件**。

### 根内核只要四样（比路由级那套小得多）

`createPostgresqlRootTaskLaunchKernel` 的 `PostgresqlRootTaskLaunchDependencies`：

| 依赖 | PostgreSQL daemon 怎么给 | SQLite daemon（`cli/start.ts`）现状 |
| --- | --- | --- |
| `db` | 自己的库 | ✅ 有（Step A 后形参已中立） |
| `gitCommitIdentity` | `identityAccess.getUserGitCommitIdentity`（`postgresqlDaemonApplication.ts:994`） | ✅ **可得**——那是 `modules/identity-access/composition/legacyUserService.ts` 的中立导出，与 provider 无关 |
| `workspace` | `createPostgresqlTaskRouteWorkspaceParticipant({ db, appHome, … })` | ✅ **可得**——Step A 之后它收中立句柄，`appHome` / `secretBox` start.ts 都有 |
| `coordinator` | `taskDriveCoordinator`（`postgresqlDaemonApplication.ts:953`，就地 `Object.freeze({…})` 造） | ❌ **没有** |

（注意：路由级的 `PostgresqlTaskRouteLaunchDependencies` 还要 `configPath` / `resourceAuthorityFor` /
`agent.{resources,integrity}` / `workgroup`——但 `actionExecutionEnvironment` 这类**只要根内核**，
所以先做根内核这条窄路，不必一上来就补齐路由级那一整套。）

### 卡点：SQLite 侧的协调器是 legacy 单体的私有物

`services/task.ts:1507` 有 `createTaskDriveCoordinator`，但它：

- **不导出**（模块私有），只在 `services/task.ts` 内部 4 处构造（3821 / 4394 / 4807 / 5442）；
- 入参是 **`StartTaskDeps`**——legacy 启动路的那个大依赖包，而不是几件可独立提供的参与者。

PostgreSQL 侧则是在 daemon 里**就地**造一个 `TaskDriveCoordinator`（953 行），与 `StartTaskDeps` 无关。

所以 Step B 的真实内容是：**把「造协调器」这件事从 legacy 单体里解出来**，
让它不再以 `StartTaskDeps` 为入参、可由任一 daemon 独立装配。
这是对 5000+ 行 legacy 文件的一次结构改动，不是接线。

### 排序建议（给下一刀）

1. **先解协调器**：把 `createTaskDriveCoordinator` 的入参从 `StartTaskDeps` 收成它真正用到的那几件
   （看 1507 起的函数体：`appHome` / `binaryOverride` / `configPath` / `subagentLiveCapture` /
   `runtimeConfigOpts(deps)` + 几个步骤钩子），导出它。**这一步零行为变更、可独立验证。**
2. 再让 `cli/start.ts` 用它造一个协调器 + 一个工作区参与者 + 那个中立的 git identity，
   装出一台**根内核**。
3. 然后 `createSqliteActionExecutionEnvironment` 改走 `launch.launch(...)`，
   与 PG 那份合一——AC-1 那 9 条里最底下的一块。
4. 逐层往上合（agentActionExecution / scriptActionExecution / digitalEmployeeExecution /
   providerRuntime / sourceTermination / triggerExecution），最后退役 legacy 启动面。

**第 1 步是下一刀的起点**，它的好处是：不碰启动语义、不动用户可见行为，
却能把「协调器只属于 legacy」这个卡点拆掉。

### 合一时必须一起处理的行为差异（持续登记）

- §5gy：源任务缺 cached mirror id 时，legacy 报计数 + 指引、内核只报一句——**留 legacy 那份措辞**。
（这张清单在迁移过程中继续加；每条都要在合一的 PR 里点名处置，不能让合一悄悄降级用户可见行为。）

---

## §5hb　Step B 第 ① 步落地：协调器工厂从 legacy 单体里解出来（零行为改动）

§5ha 把 Step B 的卡点定在一件事上：SQLite 侧唯一能造 `TaskDriveCoordinator` 的地方
（`services/task.ts:1507` 的 `createTaskDriveCoordinator`）**不导出**，且入参是 `StartTaskDeps`
——legacy 启动路那个大依赖包。于是 `cli/start.ts` 造不出启动内核。

### 做法：按函数体实际读到的字段收窄，然后导出

新增 `TaskDriveCoordinatorDependencies`，**不是拍脑袋收窄**，是逐字段对着函数体列的：

```ts
export type TaskDriveCoordinatorDependencies = Parameters<typeof runtimeConfigOpts>[0] &
  Pick<StartTaskDeps,
    'db' | 'schedulerDriver' | 'binaryOverride' | 'configPath'
    | 'subagentLiveCapture' | 'memoryDistillEnqueuer'>
```

`runtimeConfigOpts` 那一组本来就已经是 `Pick<StartTaskDeps, …>`，直接复用它的参数类型，
不重抄一遍字段名——抄一遍就会和它漂移。

**`StartTaskDeps` 仍然满足这个类型**，所以本文件内四处既有构造点（3821 / 4394 / 4807 / 5442）
一个字都不用改。`tsc` 0 错即为佐证：这是一次**纯类型收窄 + 导出**，零行为改动。

### 账本连动：三处，其中一处是上一刀埋的

1. `rfc294-module-symbol-owners` 24708 → 24709（多了个导出），挂 `allowGrowth` 并写明还款条件：
   legacy 启动面退役后这个工厂搬去 task-execution 模块、不再从 `services/` 导出。
2. **§5gz 挂的那两条 `allowGrowth` 到期了**，必须在本 commit 删除——
   守卫原话：「`allowGrowth` 是**一次性**的：它授权的那次上涨完成后必须立刻删掉。
   留着等于给这份账本发了长期上涨许可」。
   §5gz 里我写过「这个过期语义在这里是**对的**，它逼着这笔债在很短的窗口里被处理」——
   **下一个 commit 就兑现了**，而且兑现方式正是让我自己回来清理。
3. `rfc359-w7-task-insert-lineage-completeness` 按行号登记的 `services/task.ts` 站点
   3506 → 3530（我在它上面插了 24 行类型与注释）。按 §5gz 的教训，这一处**最后才改**。

### 验证

`tsc` 0 错；`eslint --max-warnings 0` / prettier 干净；`tests/architecture/` 706 全绿；
`scripts/tests-referencing.sh` 半径 61 个文件——去掉那个**既有**的 `rfc107 ↔ rfc165` 冲突后
726 例全绿（rfc107 单跑 13/13，且 10 条失败全在它；该冲突已于 §5gt 用「整组 checkout 回 HEAD」实证非本轮引入）。

### 下一步（Step B 第 ② 步）

`cli/start.ts` 用它造一台协调器 + 一个工作区参与者 + 那个中立的 git identity，装出**根内核**。
四件入参现在**全部可得**了。

---

## §5hc　`c014df60e` 推红一次：不是断言失败，是一条漏写超时的重扫描用例撞穿默认 5s

Step B①（§5hb）推上去后 `Backend tests (macos-latest shard 4/6)` 红一格：
`rfc305-architecture-lock > module composition and public contracts have only the reviewed consumers`。

### 归因过程（这次的判法值得记）

先怀疑是自己那个新导出改了什么。三步排掉：

1. **单跑绿**：`rfc305-architecture-lock` 本地 15 pass / 0 fail。
2. **按 CI 原样跑**：`bun test --isolate --randomize --seed=43294 --shard=4/6`（连 `AW_TEST_PROVIDERS=sqlite`
   一起对齐）——2630 pass / 0 fail。但这次**复现不算数**：本地 shard 4/6 里**根本没有这个文件**。
   bun 的分片按文件发现顺序切，不同机器上同一个 `--shard=N/M` 装的不是同一批文件——
   「我跑了同一个 shard」并不等于「我跑了同一批用例」。
3. **看时长**：CI 那格 **6762ms**，而它的邻居都是 70ms 级。翻到源码：
   这条用例**没有超时实参**（用 bun 的 5s 默认），而同文件另外 **6 条**同样扫全量源码的用例
   全都写着 `}, 20_000)`。

**结论：撞穿默认超时，不是断言失败。** 它扫整棵 `packages/backend/src` 并逐文件解析字符串字面量，
耗时随仓库增长；macOS runner 上过了 5s 线。

### 处置

给它补上 `}, 20_000)`，与同文件其余 6 条一致——**照搬文件自己的惯例，不是新发明一个数**。

顺手把同类风险扫了一遍（脚本逐个 `test(` 配对到它的收尾，看「函数体里有没有全量扫描」与
「有没有超时实参」两件事）：**全文件只有这一条漏网**，补完为零。

### 记一条判法

「同一个 `--shard=N/M` 就是同一批用例」是**错的**。要复现某个分片的红，不能只对齐 shard 号与 seed；
可靠的做法是**直接跑那个文件**（或从 CI 日志里取出该分片实际装载的文件列表）。
本轮正是靠「时长 6762ms vs 邻居 70ms」这条线索定位的，而不是靠复现——
**当复现不出来时，先看那一格的耗时**。

---

## §5hd　`d60907e24` 再红一次：`allowGrowth` 的过期节奏，我自己写过还是踩了

§5hc 那笔修超时推上去后又红，这次两个分片都是同一条：
`RFC-317 T17 > allowGrowth 无过期条目（这个 commit 没涨就必须删掉它）`。

### 什么事

§5hb 给 `rfc294-module-symbol-owners` 挂了 `allowGrowth`（新导出一个符号，账本 +1）。
`allowGrowth` 授权的是**那一次**上涨；**下一个没让它继续涨的 commit** 就判过期。
而 §5hc 那笔只是补了个测试超时——它当然没让符号表继续涨，于是 §5hb 的声明过期、红。

**这件事我在 §5hb 里刚写过**：「§5gz 挂的那两条 allowGrowth 到期了，必须在本 commit 删除」，
还专门夸了一句这个过期语义「是对的，它逼着这笔债在很短的窗口里被处理」。
夸完，下一笔就忘了带上清理动作。

### 为什么容易踩

节奏是反直觉的：**让你红的那个 commit 可以和账本毫无关系**。

```
commit A：真涨了 → 加 allowGrowth → 绿
commit B：修个超时 / 改个文档 → A 的 allowGrowth 过期 → 红
```

B 不需要碰账本、不需要碰代码，只要「没继续涨」就会红。

### 定式（已落 docs/dev-gotchas.md）

- 加过 `allowGrowth` 就把「下一个 commit 删掉它」挂成待办；
- 更省事：**尽量在同一个 commit 里把涨的那件事做完**，别让 `allowGrowth` 跨 commit 存活；
- push 前问一句：「上一个 commit 有没有留 allowGrowth？」——有就先删。

---

## §5he　Step C 的**硬前置**：两条启动路没有可对拍的面，合并前必须先建 e2e 对拍

Step B① 之后四件入参齐了，我本想直接做 Step C（把 `createSqliteActionExecutionEnvironment`
切到内核、合掉 AC-1 最底下那一对）。查覆盖时撞上两条硬事实，**结论是这一刀不能这么做**。

### 事实一：那一对唯一的差异点，现有测试把它**桩掉**了

`rfc359-t3-action-execution-runners` 是这条路上唯一的双引擎用例（4 处 `describeEachProvider`），
但它在第 96 行自己实现了一个 `async launchHostTask(input) { … }` 桩——
也就是说它测的是**runner**（校验 → 宿主快照合成 → 终态观察），
而两份环境实现**唯一真正不同的那个方法**（`launchHostTask`：SQLite 走 `startTask`、
PG 走 `launch.launch`）**没有任何行为覆盖**。

往一条零覆盖的路径上做行为变更，正是本 RFC 反复强调不许做的事。

### 事实二：上一波已经评估过，这一对「驱不动」

`rfc359-w7-task-route-conformance` 的 C 段注释写着（原文）：

> 这一对的 `launch` **驱不动**：它两侧各自要一整台启动机器（SQLite = `startExecution` →
> `startTask` / `startAgentTask` / `startWorkgroupTask` 加工作区物化 + git worktree；
> PG = `createPostgresqlRootTaskLaunchKernel` 的 `createRootLaunch`），落到磁盘和 git 上，
> **不是一个对拍能覆盖的面**。端口上判据型的两个方法可以，而它们恰好就是这一对唯一自带判据的部分。

所以「用端口级 oracle 证明两条启动路等价」这条路**上一波就试过并否掉了**。

### 还有一处机制差异，不是接线能抹平的

两侧「借用一个已存在的工作区」用的**不是同一种机制**：

- SQLite：`startTask(..., { internalSource: { kind: 'local-path', repoPath, baseBranch },
  preCreatedWorktree: { taskId, … } })`
- PG：`launch.launch(..., { internal: { workspace: borrowedPostgresqlWorkspace({ workspacePath,
  baselineSha }) } })` —— 一个带 `commit()` / `rollback()` 的**租约对象**

合并意味着 SQLite 侧改用租约语义。那是**产品行为面**的改动（工作区归属、回滚时谁清理），
必须逐条验，不能靠类型对齐糊过去。

### 于是 Step C 的前置被显式加进波次

原计划：①内核中立化（已完成）→ ②（已取消，§5gx）→ ③迁调用方 → ④退役 legacy。

**修正为**：

- **③a（新增，硬前置）**：给启动面建**真 e2e 对拍**——真磁盘、真 git worktree，
  两个引擎各跑一遍同一组启动场景（普通启动 / 借用工作区 / 回滚 / 取消），
  断言用户可见结果与落库行一致。这是上一波说「驱不动」的那一面，
  现在它是合并的**前置条件**而不是可选项。
- ③b：有了对拍再切调用方；每切一层用对拍证明等价。
- ④：legacy 退役。

### 为什么写下来而不是硬做

我在这条线上连续三次把 main 推红（§5gu 摘要守卫 / §5hc 超时 / §5hd allowGrowth），
三次都是**收尾检查**出的问题，不是判断错。但接下来这一步不一样：
它是**零覆盖路径上的产品行为变更**，红不红要等到有人在真机上跑数字员工才知道。
这种改动没有对拍就动手，是拿用户的运行时换我的进度条。

**③a 本身是一件可独立交付的事**（建 e2e 对拍、把「驱不动」那面覆盖上），
它不改任何生产行为，却把 ③b/④ 从「赌」变成「可验证」。下一刀从它开始。

---

## §5hf　更正 §5he：那个「必须先建」的 e2e 对拍**已经存在**，就在 helper 里

§5he 判「两条启动路没有可对拍的面，Step C 前必须先建 e2e 对拍（③a）」。
再查一层，**这个结论下重了**。③a 的绝大部分已经有人做完了。

### 已经存在的东西

`tests/helpers/eachProviderTaskExecution.ts` 里**两条启动机制各有一个分支**，
而且藏在同一个引擎无关的 `launch(task, workspace)` 后面：

| 引擎 | 它实际调什么 |
| --- | --- |
| SQLite（第 228 行） | `startTask(task, { …, internalSource: { kind: 'local-path', … }, preCreatedWorktree: { …, cleanup: { kind: 'borrowed' } } })` |
| PostgreSQL（第 375 行） | `routeLaunch.workflow.launch({ …, internal: { workspace: borrowedPostgresqlWorkspace(workspace) } })` |

**这正是 §5he 说「合并意味着 SQLite 侧改用租约语义、必须逐条验」的那两件东西**——
它们已经被同一个 API 包起来，由同一批断言在两个引擎上各跑一遍。

消费它的四个文件（`rfc359-w5-t21b-execution-chain` / `rfc359-w12-digital-employee-execution` /
`rfc359-w8-runtime-participants-conformance` / `rfc359-w14-legacy-mission-execution`）
本轮实跑：**21 例、两个引擎、全绿**。

另外 `tasks.test.ts` 用 `describeEachProviderHttpApplication` 做真 `POST /api/tasks`，
两个引擎各一遍、58 例全绿——**HTTP 层的端到端启动对拍也早就在**
（PG 那侧正是经 `createPostgresqlRootTaskLaunchKernel`，见
`postgresqlTaskRouteLaunchOperations.ts:944 / 1228`）。

### 那 §5he 引的那句「驱不动」错了吗

没错，只是**范围比我读到的窄**。`rfc359-w7-task-route-conformance` C 段说的是
「**这一对端口**的 `launch` 不能靠端口级 oracle 对拍」——那是对的，它指的是
「拿两个 `TaskRouteLaunchOperations` 实现直接比返回值」这种做法。
但「**经各自的生产路径跑真启动、再比可观察结果**」是另一回事，而那件事仓库里已经有了。

**我把「端口级 oracle 不可行」读成了「任何对拍都不可行」。** 判据的适用范围要连着它的原文一起读。

### 于是 ③a 缩成一件小事

不必新建 e2e 对拍。剩下的缺口只有一处：
`rfc359-t3-action-execution-runners` 把 `launchHostTask` 桩掉了，
所以**两份环境实现自己**（`createSqlite/PostgresqlActionExecutionEnvironment`）没有直接的行为用例
——虽然它们各自调用的那两条启动机制已经被上面那套覆盖了。

补一条针对这两份实现的双引擎用例即可，而不是造一整套 e2e。

### Step C 的风险重估

原判「零覆盖路径上的产品行为变更」**不成立**：两条机制的等价性已由 21 例双引擎测试在跑。
Step C 回到正常难度——仍需 Step B②（`cli/start.ts` 造出根内核）先落地，
因为生产 SQLite 侧目前没有内核可用；但那是接线，不是赌。

---

## §5hg　Step C 实做了一遍，卡在一个**具体**的地方：`内核 + SQLite 库`这个组合零覆盖

不再只做分析——这一节记的是**实际改了一遍、又退回来**的过程与它买到的确定性。

### 改到了哪一步（全部已回退，工作树干净）

1. `actionExecutionEnvironment.ts`：两份合成一份 `createActionExecutionEnvironment`，
   `db` 收中立句柄；`actor` 收成**惰性** `resolveActor: () => Promise<Actor>`
   ——因为 `server.ts` 的 `composeFallbackDevelopmentAutomation` 是**同步**函数，
   拿不到 `await admitDaemonIdentity(...)`，而两个根都只在 `launchHostTask` 里用到 actor。
   （这一步是真正的「取强的那半」：惰性在两侧都成立。）
2. `agentActionExecution.ts` / `scriptActionExecution.ts`：各自两份装配面合成一份。
3. `cli/postgresqlDaemonApplication.ts`：改用合并后的名字，`actor: systemActor` →
   `resolveActor: async () => systemActor`。

改完 `tsc` 只剩 6 处：两个 SQLite 生产调用点（`cli/start.ts` ×2、`server.ts` ×2）与 4 处测试。
**也就是说这三对的合并本身是通的**，差的只是 SQLite 侧要造出一台内核。

### 卡在哪：`内核 + SQLite 库` 这个组合**目前零覆盖**

合并取的是内核那半，于是合并后**生产 SQLite 会改走内核**。而查下来：

| 组合 | 谁在跑 |
| --- | --- |
| 内核 + PostgreSQL 库 | PG daemon（生产）、`tasks.test.ts` 的 PG lane、`eachProviderTaskExecution` 的 PG 分支 |
| `startTask` + SQLite 库 | SQLite daemon（生产）、`tasks.test.ts` 的 SQLite lane、helper 的 SQLite 分支 |
| **内核 + SQLite 库** | **没有任何地方** |

§5hf 说「等价性已由 21 例双引擎用例跑着」——那句话**对，但不够**：
它证明的是「两条机制各自在自己的引擎上都对」，**不是**「内核这条机制在 SQLite 库上也对」。
合并要做的恰恰是后者。**这两句话的差别，是我这一轮最该记住的东西。**

已探的一步：内核在两个引擎上都能**构造**出来（probe 实测 `kernel.launch` 都是 function）。
但构造 ≠ 能跑——`launch()` 里有事务、插行、工作区物化与 git。

### 于是 ③a 的范围被钉死了（这次是真的小而具体）

**写一条「用启动内核在两个引擎上各真启动一次」的用例**：真库、真工作区租约，
断言任务行落库、返回 id 与查询一致、回滚路径干净。它一旦绿，
上面那三对的合并就只剩把 60 行内核装配从 PG daemon 抄进 `cli/start.ts` 与 `server.ts`。

### 为什么退回来而不是硬推

合并后**默认部署（SQLite）的数字员工启动路会换一条机制**，而那条组合今天没有任何用例跑过。
这不是「谨慎」，是它确实没被验证过——真出问题的形态会是「数字员工动作卡住不失败」，
要等有人在真机上跑才发现。先把 ③a 那条用例写出来，合并就从赌变成接线。

---

## §5hh　③a 落地：启动内核在两个引擎上各真启动一次（合并的前置条件已满足）

§5hg 把 Step C 的卡点钉成一句话：**「内核 + SQLite 库」这个组合零覆盖**。这一节把它补上。

### 做了什么

1. `tests/helpers/eachProviderTaskExecution.ts` 的**共享段**（分叉之前）新增 `launchViaKernel`：
   无论当前引擎是谁，都用 `createPostgresqlRootTaskLaunchKernel` 真启动一次
   （借用工作区租约 + 记录式协调器桩），两个分支都把它透出去。
   放在共享段是关键——下面那两个分支各走各的机制，正是「内核 + SQLite」没人跑的原因。
2. 新用例 `rfc359-w5-kernel-launch-provider-parity`：真 git 仓、真库、真租约，
   两个引擎各跑一遍，断言 **task 行落库、返回 id 与库内一致、驱动请求交到协调器**。

协调器用桩是有意的：这条用例要证的是**启动事务本身**在这个引擎上成立
（开事务 → 插行 → 租约 commit → 返回 id → 提交驱动）。
「任务被真正驱动到 done」由 `rfc359-w5-t21b-execution-chain` 在两个引擎上覆盖，不重复。

### 结果

**两个引擎都绿。** 也就是说启动内核在 SQLite 库上**能跑**——
§5hg 里那个空格子被填上了，三对 action 执行装配面的合并从「赌」变成「接线」。

变异验证：把桩协调器的 `submit` 改成不记录 ⇒ **两个引擎各红一格**（0 pass / 2 fail），
说明这条用例真的在验「提交之后那一段」，不是走个过场。

### 账本连动一处，值得解释

`rfc359-w5-t19d-coverage-parity` 红了：`postgresql 5/1 → 6/2`。
账本按**符号名**归边，而这台内核顶着 `Postgresql` 前缀（它只服务一条启动路，
按 `proposal.md` AC-1 第三款**应当**保留前缀，见 §5gx）。
于是这笔**两个引擎都在跑**的覆盖被记到了 postgresql 一侧，看起来像「倒挂加深」。

**实际是覆盖变好了**——此前那个组合零覆盖。已按实测改小账本并把这段理由写在行上，
避免下一个人把它读成「PG 侧又多吃了一份覆盖」。等启动面合一收尾、这一对塌成一份，这两行一起消失。

### 下一刀

三对合并（§5hg 已实做验证过：改完只剩 6 处类型错，全在两个 SQLite 调用点与 4 处测试）
＋ 把约 60 行内核装配从 PG daemon 抄进 `cli/start.ts` 与 `server.ts`。
前置条件到此满足。

## §5hi —— 三对 action 执行装配面合一：SQLite 也走启动内核

### 做了什么

数字员工的动作执行（agent / script）此前在**同一个文件里**各有两份：

| 文件 | SQLite 那份 | PostgreSQL 那份 |
| --- | --- | --- |
| `composition/actionExecutionEnvironment.ts` | `createSqliteActionExecutionEnvironment` | `createPostgresqlActionExecutionEnvironment` |
| `composition/agentActionExecution.ts` | `composeAgentActionExecution` | `composePostgresqlAgentActionExecution` |
| `composition/scriptActionExecution.ts` | `composeScriptActionExecution` | `composePostgresqlScriptActionExecution` |

差别只有一处：**宿主任务怎么启动**。SQLite 那份走 `startTask` + `preCreatedWorktree`
（只服务 SQLite），PG 那份走启动内核 + `borrowedPostgresqlWorkspace` 租约。

合并取**内核**那半，三对塌成三个中立实现。合并后：

- `ActionExecutionEnvironmentDependencies` 把 `db` 收成 `ProviderNeutralDatabase`，
  并把 `actor` 换成**惰性**的 `resolveActor: () => Promise<Actor>`——
  `server.ts` 的 `composeFallbackDevelopmentAutomation` 是同步函数，
  取不到 `await admitDaemonIdentity(...)`；惰性是两侧都成立的那半。
- 新增模块的组合入口 `composition/hostTaskLaunch.ts::composeHostTaskLaunchKernel`。
  PG daemon 从自己的 provider runtime 取内核（`routeLaunch.workflow`），
  另外两个根没有 provider runtime 可取，从这个入口装。
  **组合根因此不必深挖 `infrastructure/`**——否则 `rfc331-task-execution-topology`
  的分层判据会红（实撞过：两条新 deep import 被它逐字抓出来）。
- `cli/start.ts` 与 `server.ts` 各装一次内核：`createTaskDriveCoordinator`
  （§5hb 导出的那个工厂）+ 逐条对齐 PG daemon 的 `failureReporter`
  （trySet failed + `intentTerminalization.terminalize`）。漏了这半，
  驱动崩掉会表现成「动作卡住不失败」。

### 证据

- `rfc359-w14-legacy-mission-execution`（`describeEachProvider`，真子进程、驱到终态）
  **两个引擎各 2 条全绿**——SQLite 这一侧现在跑的就是合并后的 composer + 内核。
- `rfc310-pr4-execution-host`（真子进程执行链，8 条）改走内核后全绿。
- 源码锁 `rfc359-t3-action-execution-runners` 扩成**三个组合根**同时锁：
  三者都得接合并后的那对 composer、都得先造出内核、都不许再出现 `composePostgresql*ActionExecution`。
  变异验证：把 `server.ts` 的内核装配换回 `createPostgresqlRootTaskLaunchKernel`（绕开组合入口）⇒ **红**。

### 一处真实行为差异，测试是对的

`rfc310-pr4` 锁着「宿主任务的 `gitUserName` 为 NULL」。改走内核后第一版红了——
因为我的 fixture 自己播了个普通用户。**生产不是这样**：三个组合根都用
`admitDaemonIdentity` admit `__system__`，而内核对系统用户不冻结 git identity
（`postgresqlTaskRouteLaunchOperations.ts` 的 `input.actor.user.id === SYSTEM_USER_ID ? null : …`）。
fixture 改成和组合根同一条取身份路径后即绿——**改的是 fixture，不是那条断言**。

### 账本连动

- `rfc359-w5-same-file-provider-pairs`：19 → **16**（三行一起删）。
- `rfc317-ledger-highwater` 基线同步改小到 16。
- 三条「语料非空」下限各减 4（退役了四个 provider 命名的导出）：
  `identical-provider-twins` 90 → 86、`provider-runtime-exercised` 18 → 16、
  `adapter-production-consumer` 86 → 82。**是合一不是删覆盖**。
- `rfc359-w5-t19d-coverage-parity`：`TaskRouteLaunchOperations` 的
  `postgresql 6/2 → 7/3`。同 §5hh：账本按符号名归边，这台**两个引擎共用**的内核
  顶着 `Postgresql` 前缀，两边的覆盖全记在 postgresql 一侧——**倒挂数字变大 = 覆盖变好**。
- `rfc359-w29` daemon 相的摘要随两处被调用者改名 + 一处实参改名更新；
  **语句数仍是 160、顺序未变**（那条断言没红，正是用来分开这两种情况的闸）。

### 留下的债（下一刀）

**§5hj —— `createPostgresqlRootTaskLaunchKernel` 的命名债。**
这台内核现在**两个引擎共用**，已经没有 provider 语义了，按 `proposal.md` AC-1
第三款该改成中立名。没有顺手做，是因为它所在的
`infrastructure/postgresqlTaskRouteLaunchOperations.ts` 同文件里还装着路由级的
PG 专属类型（`PostgresqlTaskRouteLaunchDependencies` 等），
而旁边确实存在真孪生 `sqliteTaskRouteLaunchOperations.ts`（账本记 `sqlite 2/1`）——
改名要连着「哪些是内核、哪些是路由级 PG」一起拆，单独立一批做。

**§5hk —— SQLite 的 `routeLaunch.workflow` 仍是空的。**
`providerRuntime.ts` 的基类把它写成 `workflow?: PostgresqlRootTaskLaunchKernel`，
只有 PG 那支收窄成必填——类型本身就在说「一个引擎有、另一个没有」。
本刀没动它：`composeSqliteTaskExecutionProviderRuntime` 要造内核就得先拿到协调器，
而协调器又要 `provider.runtime.schedulerDriver`（PG 用同作用域 `const` 转发面破环，
SQLite 可照抄）。做完这一刀，两个 SQLite 组合根就能和 PG 一样直接读
`taskExecutionProvider.routeLaunch.workflow`，`hostTaskLaunch.ts` 这个入口也可以退役。

## §5hl —— 数字员工执行合一：端口 + 内核，两份 ~350 行塌成一份

§5hi 之后，`digitalEmployeeExecution.ts` 那一对的「漂移待合」理由整句失效了——
账本上写的是「**挡在下层**：下层仍是品牌实现；且这条路还挂在 `services/task` 的
SQLite 专属启动面上」，而 §5hi 正好把这两个前提一起拿掉。所以这一刀是**按账本当初写的那样**
把它塌掉，不是新开一个判断。

### 两份的差别是同一个故事，讲了两遍

| | SQLite 那份 | PostgreSQL 那份 |
| --- | --- | --- |
| 启动 | `startTask` + `internalSource` + `preCreatedWorktree` | 启动内核 + `borrowedPostgresqlWorkspace` |
| 读库 | 函数体里直接 `deps.db.select(...).get()` | 端口（`tasks` / `readModels` / `agents` / `workflows` / …） |
| 计划人审 | 直接拿 db 调中立实现 | `humanReview` 端口 |

合并取**端口 + 内核**那半。直接读库那半按定义只服务一个引擎——`.get()` 在 PG 上返回
Promise、在 SQLite 上返回值，这是本 RFC 反复撞到的那条分界。

端口化不该让每个组合根各抄一遍同样的库读，所以新增
`composeDatabaseDigitalEmployeeExecutionPorts(db)`：`tasks` / `readModels` /
`resourceUsage` / `executionMetadata` / `humanReview` 五个端口的**库内缺省实现**，
三个组合根都装它，确有更好来源时（PG daemon 的 `resourceLimitOperations`、
两个根的真 `routes.tasks`）就地覆盖。

`actor` 同 §5hi 收成惰性的 `resolveActor`——`server.ts` 的
`composeSqliteApiRouteMounts` 是同步函数，取不到 `await admitDaemonIdentity(...)`。

### 合并顺带消掉的两处真差异

1. `deps.workspace === undefined` 时，SQLite 那份给 `{ kind: 'unmanaged' }`、PG 那份给
   `{ kind: 'scratch' }`。两者后续走同一个 `sourceFields` 分支，差别只在谁物化工作区；
   合一后统一由内核的工作区参与者物化。
2. 取 `analysis-plan` 输出时 PG 那份带 `candidate.active` 过滤，SQLite 那份（SQL join）
   **没有**。合一后两个引擎都带上。

### 证据

- `rfc359-w12-digital-employee-execution`（`describeEachProvider`，真执行）**两个引擎全绿**。
  它的 `compose()` 此前是 `if (provider === 'sqlite') {...} else {...}` 两段，
  现在是**一段**——两个引擎只剩两处差别，且都不是 composer 的：
  `executionContracts` 的资源面，与启动内核从哪来（PG 的 provider runtime 自带、
  SQLite 这条测试用 `createTestHostTaskLaunchKernel` 装一台同形的）。
- `rfc310-digital-employee-human-review-system-mock-e2e`（真子进程 + 人审多轮）绿。
  它**真的要物化工作区**，于是揭出测试助手里那个「工作区参与者用不到」的假设是错的——
  助手改成**转调生产那个组合入口** `composeHostTaskLaunchKernel`，
  「测试装的内核」与「生产装的内核」从此按构造同一台。
- `rfc359-w12-digital-employee-human-review-parity` 的装配锁改写：两份变一份后
  「两侧都要交出 `inspectHumanReview`」退化成一句废话，改成锁
  **库内缺省端口读出来的答案与中立实现逐字相同**，并把用例种到 `waiting` 那一格
  ——正是 PG 侧当年报不出来的那一格，桩答不出它。

### 账本连动

同文件孪生 16 → **15**；`identical-provider-twins` 下限 86 → 85、
`provider-runtime-exercised` 18 → 15（两刀累计）、`adapter-production-consumer` 82 → 81；
`t19d` 的 `TaskRouteLaunchOperations` drive 3 → 2（测试助手改走组合入口，不再直呼品牌名——
**收敛，不是覆盖变少**）；`rfc359-w29` 两相摘要都更新，其中 **SQLite 相的装配图是真的变了**
（这一层不再自己读库），已在行上写明。三份普查账本各 +1（多一条 import、多一个导出符号），
按 `allowGrowth` 显式声明并写清净账是减。

### 这一刀推红过一次，值得记

`rfc301` 的「受审 `startTask` 调用点」exact 账本记着
`actionExecutionEnvironment.ts: 1`，而 §5hi 把那唯一一次 `startTask` 换成了内核。
`scripts/tests-referencing.sh` 交出的 12 个文件里**没有它**——那条守卫既不 import
被改的文件、也不提它的符号，它拿**文件路径字符串**当账本键。已补进
`docs/dev-gotchas.md`：跑完脚本半径后，再按改动文件的**相对路径字符串**grep 一遍测试树。
本刀按这条新定式做了，当场多捞出 rfc301（又 2 条）、`rfc345-resource-acl-facade-retirement`、
`rfc310-pr4-profile-identity`、`rfc294-review-offered-edge-dag` 等一批路径键守卫。

### 留下的债

**§5hm —— 协调器的驱动生命周期端口仍是 SQLite 专属。**
`createTaskDriveCoordinator` 里装的是 `createTaskDriverLifecyclePort`，它要 `DbClient`；
PG 有自己的 `createPostgresqlTaskDriverLifecyclePort`。这是 §5ha 排序里的第 ① 步
「内核换中立 session」的剩余部分，也是 `TaskDriveCoordinatorDependencies.db`
至今不能收成 `ProviderNeutralDatabase` 的原因。

**§5hn —— `wakeHumanGateContinuation` 等人审继续驱动的 API 仍吃 `StartTaskDeps`。**
属于 §5ha 第 ④ 步「退役 legacy 启动面」。

## §5hm　勘察：驱动生命周期端口那一对，以及它里面一处**真的**「一个引擎有、另一个没有」

§5hl 收尾时撞到 `TaskDriveCoordinatorDependencies.db` 收不成 `ProviderNeutralDatabase`——
根因是协调器里装的 `createTaskDriverLifecyclePort` 要 `DbClient`，而 PG 有自己那份
`createPostgresqlTaskDriverLifecyclePort`。这一节是**只读勘察**，把这对的形状量清楚，
下一刀照着做；本节零生产改动。

### 逐项对账

| | `taskDriverLifecycle.ts`（SQLite） | `postgresqlTaskDriverLifecycle.ts` |
| --- | --- | --- |
| 认领 | `taskExecutionModule.claim({ db, intentId })`（**进程级单例**） | `options.module.claimPersisted({ intentId })`（实例） |
| 执行上下文 | `composition/sqliteTaskExecutionContext` | `application/taskExecutionContext` |
| 心跳 | `startOwnerHeartbeat(db, …)` | `options.persistence.ownership.heartbeat` |
| 状态读 | `.limit(1).all()[0]`（同步） | `await …limit(1)` 后取 `rows[0]` |
| **评审变更锁** | **整个 attach 包在 `withTaskReviewMutationLock` 里** | **没有** |

前四项都是同一个故事的第五、第六遍：**同步读 vs await**、**进程单例 vs 实例**。
而且大半已经是中立的了——`claim` 与 `claimPersisted` 的函数体**逐字相同**，
只差 ownership 从哪来（`this.ownershipFor(input.db)` vs `this.persistence.ownership`），
且 `claim` 的 `db` 形参**早就是 `ProviderNeutralDatabase`**；
`sqliteTaskExecutionContext.createTaskExecutionContext` 也只是中立那份的一层薄包装
（补 `persistence: createTaskExecutionPersistence(db)` 与 `legacyConnection`）。
合并的形状因此比较清楚：端口收一个 `claim: (intentId) => Promise<ClaimedTaskExecution>`
闭包 + `persistence` + `runtimeRegistry`，装配方各自绑定。

### 第五项是真差异，且方向是「PG 更弱」

`withTaskReviewMutationLock` 是**按 task 排队的进程内 FIFO**，用途见
`services/reviewMutationCoordinator.ts:1-7`：评审决策会改动兄弟评审行，任务取消会经生命周期
终态钩子封掉所有未决评审行，**两者共用一个临界区**。SQLite 的 `attachTaskDriver` 整个包在
里面，PostgreSQL 那份**一句都没有**——也就是说 PG 上 attach 可以与「取消正在封评审行」交错，
而 SQLite 上不会。这是本 RFC 定义的那种缺口：同一件事，一侧有判据、另一侧没有。

**不能直接把锁加到 PG 那份上就算完**，有一条已知的反向风险写在同一个文件的注释里
（`reviewMutationCoordinator.ts:5-7`）：这个锁**不可重入**，「把每个 `setTaskStatus` 都包起来
会让评审路径在 resume 任务时重入自己的锁」。attach 是从协调器 `submit` 进来的，
而 `submit` 有从人审放行继续驱动那条路进来的可能——**先证明那条路上没人已经持锁，再加**。

### 下一刀的做法（按依赖顺序）

1. **先量重入面**：把 PG 的 `submit → attach` 全部调用路径列出来，逐条确认是否已在锁内。
   这一步是只读的，结论要写进本节。
2. 两份 attach 合一：端口收 `claim` 闭包 + `persistence` + `runtimeRegistry`，
   `createTaskExecutionContext` 用中立那份、`legacyConnection` 由装配方按引擎给。
3. 评审锁按第 1 步的结论**要么两侧都加、要么两侧都不加**——不接受「SQLite 加、PG 不加」
   这个现状延续。两侧都加时必须补一条双引擎用例：attach 与 cancel 并发，评审行状态一致。
4. 合完之后 `TaskDriveCoordinatorDependencies.db` 就能收成 `ProviderNeutralDatabase`
   （这是 §5ha 排序里第 ① 步「内核换中立 session」的最后一块），
   `providerRuntime.ts` 基类上那个 `executionModule: TaskExecutionModule` 也能一并收成
   `ProviderTaskExecutionModule`——类型层现在还写着「SQLite 那支可能没装持久化」。

### §5hm 第 1 步的结论：重入面是空的，锁可以两侧都加

按上面第 1 步逐条量过，**没有任何一条生产 `submit` 路径在持有评审锁时进入 attach**：

- **最强的那条证据是 SQLite 自己**：`attachTaskDriver` 早就整个包在锁里，而两个引擎**共用**的
  那批 submit 调用点（`services/task.ts` 的五处、`approvalGateway`）在 SQLite 上天天跑。
  这些路上若有谁已持锁，SQLite 现在就会死锁。**共用路径已被现役实现证伪。**
- **人审放行继续驱动**（注释里点名的那条重入风险）不持锁：它由后台 worker
  `humanGateContinuationWorker.runCycle` 直接调 `drive(continuation)`，
  worker 循环自身不进临界区。
- **评审决策落地后的 resume 在锁外**：`review.ts:22-23` 写明
  「`resumeTask` is invoked by REST decision handlers to re-enter the scheduler
  **after a decision lands**」——`dispatchReviewNode` 持锁的范围到
  `dispatchReviewNodeUnlocked` 返回为止，resume 是它返回之后由 REST handler 发起的。
- **六条 PG 专属路径**（`postgresqlChildExecutionLaunchOperations` /
  `postgresqlFusionEngineTaskOperations` / `postgresqlChildTaskLifecycleParticipant` /
  `postgresqlRepositoryPreparationRetryCommand` / `postgresqlTaskRouteLaunchOperations` /
  `postgresqlDaemonApplication`）与 `approvalGateway`：`ReviewMutationLock` 出现次数**全为 0**。

**裁决**：合并时锁**两侧都加**（即 PG 补上），不接受「SQLite 加、PG 不加」延续。
按 §5fq 三条判据，这处差异一条都不命中——它不是引擎原语差异，是 PG 那份当初照抄时漏了。
合并 PR 必须带一条**双引擎**用例：attach 与 cancel 并发，评审行状态在两个引擎上一致；
先让它在 PG 上红（证明缺口真实存在），再合。

## §5hm 落地　驱动生命周期端口合一 —— 顺手关掉 PG 上一个**真的**功能缺口

按上一节勘察的做法做完了。

### 先红后绿：缺口是被照出来的，不是推断的

新用例 `rfc359-w5hm-attach-review-lock-parity`（`describeEachProvider`）。判据走 attach 的
**提前返回**那条路（任务已终态 ⇒ `not-attached`）：它在 SQLite 上位于锁内、在 PG 上位于锁外，
所以不必真认领任务就能把顺序差异照出来。

合一**之前**实测：

```
[sqlite]     绿
[postgresql] 红 —— 实际顺序：review-enter → attach → review-released → review-exit
```

也就是说 attach 确实插进了评审临界区。合一之后两个引擎都绿。

判据不靠 sleep 赛跑：那 200ms 只用来给 attach **充分**机会跑完、让违规交错可被观察；
合规那一侧由锁本身保证，等多久都不会变。断言的是顺序（`attach` 必须在 `review-exit` 之后），
不是时长。

### 合一后的形状

`taskDriverLifecycle.ts` 是唯一实现，`postgresqlTaskDriverLifecycle.ts` **删除**。
端口依赖里唯一按引擎不同的是**认领方式**，由装配方交一个闭包决定：

- PG：`claim: (intentId) => module.claimPersisted({ intentId })`
- SQLite：`claim: (intentId) => taskExecutionModule.claim({ db, intentId })`

两者函数体本来就逐字相同，只差归属持久化从哪来（`this.persistence.ownership`
vs `this.ownershipFor(db)`，而后者的体就是 `new DrizzleTaskOwnershipPersistence(db)`）。

其余四项差异按中立那半收口：状态读改成 `(await db.select(…).limit(1))[0]`
（`.all()` 那种「一边是数组、一边是 Promise」的写法只服务一个引擎）；
心跳走 `persistence.ownership`；执行上下文用 `application/taskExecutionContext` 那份中立实现，
SQLite 的 `legacyConnection` / `compatibility.db` 由装配方按需要交进来
（那是 `services/task` 启动路未退役的残留，见 §5hn）。

便利构造 `createDatabaseTaskDriverLifecyclePort(db, log, finalizeWorkspace)` 留给
`services/task` 那条只有 `db`、拿不到模块实例的老路；它随 §5hn 一起消失。

### 顺带兑现：协调器的 `db` 收成中立句柄

`TaskDriveCoordinatorDependencies.db` 此前是从 `StartTaskDeps` Pick 来的
`LegacySqliteTaskDatabase`——**不是因为协调器真要 SQLite**，而是它装的生命周期端口
当年只有 SQLite 一份。端口合一后这个约束没了：协调器这一路上读 `db` 的三处
（生命周期端口、闸门继续前置、工作区清理）全是中立实现，于是收成
`LegacyProviderNeutralDatabase`。`StartTaskDeps` 仍满足这个更宽的类型，
既有构造点一个字都不用改。**这是 §5ha 排序里第 ① 步「内核换中立 session」的最后一块。**

可见的兑付：`rfc359-w12-digital-employee-execution` 里那个
`db: harness.db as unknown as DbClient` 的 cast 删掉了。

## §5hn 勘察　`services/task` 那条 legacy 启动面还剩多少

「启动面合一」这道波次的 ④ 步。本节只读勘察，落地另立一刀。

### 现状：`startTask` 的生产调用点还有 9 处、分三类

| 类 | 调用点 | 说明 |
| --- | --- | --- |
| **A 已有内核对照** | `services/agentLaunch.ts` ×3、`services/execution/executor.ts` | PG 侧同一件事走的是启动内核（`routeLaunch.agent` / `.workflow`）。这一类是**真正要迁的**。 |
| **D 只服务测试** | `services/task.ts:2711` `startTaskWithLocalRepo` | 实测：`src/` 侧**零生产消费者**（唯一一处出现是注释），`tests/` 侧 21 个文件在用。源码注释也自己写着「NOT reachable from any route」。**它随 legacy 启动面一起退役，但不是迁移对象**——迁的是那 21 个 fixture 的启动方式。 |
| **B 尚无内核对照** | `modules/resource-catalog/infrastructure/legacy/workgroup/launch.ts` ×2 | 工作组启动；PG 侧有 `routeLaunch.workgroup`，但形状与 SQLite 这条差得多，要单独对账。 |
| **C 机制面** | `modules/task-execution/infrastructure/fusionEngineTaskOperations.ts` | Fusion 引擎的任务启动；PG 侧是 `postgresqlFusionEngineTaskOperations`，仍是一对孪生。 |

`services/task.ts` 现在 7732 行，退役它是**整条现役启动路**的迁移，两套启动语义要逐项对齐——
不是一刀能做完的，必须按上表分批，每批各自带双引擎用例。

### 已登记的行为差异（迁移时必须逐条处置，不得静默降级）

- §5gy：源任务缺 cached mirror id 时，legacy 报**计数 + 指引**、内核只报一句——**留 legacy 那份措辞**。
- §5hl 实测的两处（`unmanaged` vs `scratch`、`analysis-plan` 的 `active` 过滤）已在数字员工那一刀
  处置完毕，形状可作后续批次的范例：**合并取判据更强的那半，并在 plan 里点名**。

### 先做哪一批

**更正（实测后）**：原先想从 `services/task.ts:2711` 起，理由是「本文件内自调用、半径最小」——
查下来那是 `startTaskWithLocalRepo`，**只服务测试**（src 零消费者，21 个测试文件在用）。
它不是迁移对象，而是**迁移的产物**：等 fixture 都改走内核，它自然没人用了。

改从 **`services/agentLaunch.ts` 那三处**起：PG 侧 `routeLaunch.agent` 是成熟对照，
两条路的入参已经很接近，且它是真正的生产启动路——迁完就能真正减少一条 legacy 面。
`services/execution/executor.ts` 紧随其后。
B / C 两类各自先补一条**双引擎**对照用例，证明两条路当前行为一致，再动实现。

### §5hn 批次一（`agentLaunch`）的先行对账：**重复的是编排，不是判据**

动手前把两侧的前置链逐项点了一遍（只读）：

| 步骤 | `services/agentLaunch.ts` | PG `launchAgent` |
| --- | --- | --- |
| `acquireAgentLaunch` / release | ✓ | ✓ |
| `assertNotBuiltin` | ✓ | ✓ |
| `expectedAgentId` 不符即冲突 | ✓（`:309`） | ✓ |
| 删除竞态 recheck | ✓ | ✓ |
| `integrity.assertUsable` | ✓ | ✓ |
| `ensureHostWorkflow` | ✓ | ✓ |
| `validateAgentLaunchShape` | ✓ | ✓ |
| 冻结宿主快照 | `buildAgentHostSnapshot` + `migrate(parse(…))` | **同一个** `buildAgentHostSnapshot` + 同两行（包了个 `frozenAgentSnapshot`） |
| `validateHostWorkflow` + error 过滤 | ✓ | ✓ |
| `applySpaceFields` | ✓ | ✓ |
| 上传三步（buffer / validatePlan / applyToWorktree） | ✓ | ✓ |
| **落库** | `startTask` + `materializeSpace` | 启动内核 |

**结论：这一对没有 §5hl 那样的判据差异**——十二步里十一步逐项对得上，
连快照构造用的都是**同一个函数**（PG 从 `services/agentLaunch` import `buildAgentHostSnapshot`，
`frozenAgentSnapshot` 只是它外面包的两行）。唯一的差别还是那一处：**最后怎么落库**。

也就是说 PG 这份约 200 行是把 SQLite 那份的编排**照抄了一遍**，只为了把结尾从
`startTask` 换成内核。做法因此与 §5hi / §5hl 同一个配方：
**把前置链抽成一份中立编排，终端那一步（落库）作为参数注入**，
两个装配方各自绑自己的终端——而这一刀的终端**两侧都已经是内核**（§5hi 起 SQLite 也有内核），
所以它比前两刀更简单：连注入都可以省掉，直接两侧共用内核。

**开工前仍要补的一件事**：本对账是按「函数名出现与否」点的，
**不能证明两侧传给同一个函数的实参也一样**。落地前先补一条双引擎用例，
断言同一份 launch 输入在两个引擎上落出**逐字相同的 task 行 + 快照**，
再动实现——同 §5hm 的「先红后绿」。

### §5hn 批次一的基线用例：**当场又照出一处用户可见差异**

`rfc359-w5hn-agent-launch-provider-parity`（`describeEachProviderHttpApplication`）：
同一份 `POST /api/agents/:id/tasks` 请求打到同一条路由，比对两个引擎落出的 task 行。

**第一次跑就红。** 差的是这一格：

```
snapshotEveryNodePositioned:  sqlite=true  postgresql=false
```

**定位**：内置宿主快照的**规范排版**，SQLite 是**写时冻结**的——
`services/task.ts:3060` 对 `workflow.builtin === true` 走 `layoutBuiltinWorkflowSnapshotJson`，
落库那一行就带坐标；而启动内核直接
`workflowSnapshot: JSON.stringify(input.subject.workflowSnapshot)`
（`postgresqlTaskRouteLaunchOperations.ts:741`），靠**读时**投影补排版
（`postgresqlTaskRouteOperations.ts:413` 的 `projectWorkflowSnapshotForRead`）。

于是**启动响应体**与**库里那一行**在两个引擎上不同。这不是纯内部差异：
启动响应是用户可见的 wire 输出（AC-8 的管辖面），而且「读时补」补不到别的消费者
——导出、直接读库的下游、以及任何不经那条读投影的路径拿到的都是没有几何的快照。

**处置（下一刀）**：合并两份编排时，内核也改成**写时冻结**——与 SQLite 对齐，
取判据更强的那半（自描述的行 > 靠读端补）。**不改成「SQLite 也不冻结」**：
那是把两边一起降到弱的那一档，与本 RFC 的方向相反。

### 这条用例的形状：相等面 + 反向钉住的已知差异

已知差异**不进相等面**——混进去只会让整条红成一团、盖住别的漂移。
它单独用一条**反向**断言钉住**今天的**状态（sqlite=true / postgresql=false），
合并把它关掉时这条会红并要求改成相等断言——**那正是销账的时刻**。

其余十一步的实参**已实测逐字相同**（status / workflowId / spaceKind / inputs / scratch /
catalogVisibility / 快照节点 id 与种类 / 边数），也就是 §5hn 那份「按函数名点的对账」
补上了「实参也一样」这一格——**除了排版这一处**。

变异实证：把 PG 侧 `taskInputs[AGENT_HOST_INPUT_KEY]` 后面缀一个 `_MUTANT` ⇒ 当场红。
语料下限也钉了（节点 > 1、边 > 0），避免比较面塌成空壳时与「两引擎一致」同形。

**顺带补上一个 AC-6 缺口**：`rfc165-agent-launch.test.ts` 是 SQLite 单引擎的
（`createInMemoryDb`），PG 侧那份约 200 行的 `launchAgent` 编排此前**零行为用例**。

### §5hn 批次一（下）：那处排版差异**已关闭**——并且第一版修法是错的

按上面定的方向做完了：**内核也在写时冻结**。

`PostgresqlRootTaskLaunchSubject` 新增 **必填** 的 `builtin: boolean`。
故意必填而非可选：可选会让「装配漏了一步」编译通过，而漏掉的后果是那条任务
从此存着一份没有几何的快照。必填之后 tsc 当场把**全部 6 个 subject 生产者**列了出来，
逐个按事实填：

| 生产者 | 值 | 依据 |
| --- | --- | --- |
| 数字员工宿主（`actionExecutionEnvironment` / `digitalEmployeeExecution`） | `true` | 平台合成宿主 |
| 数字员工选定的既有工作流 | `false` | 用户工作流，保留作者几何 |
| 单代理宿主 / 工作组宿主 | `true` | 平台合成宿主 |
| 工作流启动面（路由 + launch participant） | `false` | **这条路按定义拿不到内置工作流**——冻结资源快照那一步就 `assertNotBuiltin` 挡住了（`taskExecutionResourceSnapshots.ts:142`） |

### 第一版修法制造了一个更糟的不一致，测试没抓住、我自己抓住的

第一版只改了 **insert**：`workflowSnapshot: subject.builtin ? layout(...) : ...`。
跑出来测试**照绿**——因为返回给 HTTP 的 `Task` 投影用的是
`input.subject.workflowSnapshot` **原值**（`postgresqlTaskRouteLaunchOperations.ts:507`），
根本不经过 insert。于是那一版把「两个引擎不一致」换成了
**「同一个引擎里，库里那行与启动响应体不一致」**——更糟，而且更难发现。

正解是**在入口规范化一次**：`createRootLaunch` 进门按 `subject.builtin` 把 subject
整体换成排好版的那份，之后落库与返回投影用的是**同一份**。
「同一个值算两遍」这种形状本身就是 bug 温床，规范化点只能有一个。

### 判据随之从「反向钉住」回到相等面

用例里那条反向断言（sqlite=true / postgresql=false）在修完之后**当场变红**——
正是它被设计成要红的时刻。改成两侧共同的正向判据
（`every(node => node.position !== undefined)` 必须为 true），
并把这一格放回相等面。**先红后绿闭环**：
缺口 → 反向钉住 → 修 → 反向断言红 → 转正向 → 绿。
