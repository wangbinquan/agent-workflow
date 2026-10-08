# RFC-370 C2-W2-P：Task 执行准备与具名结果投影

本批继续已批准 Stage A/H7。W2-R 执行租约切面先发布，本批在其后实施；不修改已冻结的 W2-R 源码或 matching 候选。这里仅确定四类既有 Task persistence 的执行用途，保留原生实现和未选择 host adapter 时的全部行为。完整业务分类、实际启动根、恢复管理面、H7/A-T7/A-G 和 CS 部署仍需后续验收。

## 原调用者与目的

| 原 port／方法                                           | 已核对的真实调用顺序                                                                                                           | 消费目的   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| TaskEngineApplicationPersistence.updateWorkspaceProfile | taskEngineApplication.ts 的 drive 在 workspaceExcludeProfiles.ensure 返回实际 version/digest 后记录回执                        | issued-ACK |
| WrapperRunPersistence.clearReuseDisabled                | wrapperRunLifecycle.ts 只在原 wrapper 终态结算成功，或确认为 canceled/interrupted 的 superseded 清理后调用                     | issued-ACK |
| RuntimeSessionCapturePersistence.appendEvents           | OpenCode post-run/live capture 和 Claude capture 已读取实际 transcript 后落库；原 capture-failed marker 同属已发运行结果       | issued-ACK |
| NodeRunRuntimePersistence.withSelection／freeze         | nodeRunMint.ts 的 resolveFrozenRuntimeWith 在 compile/spawn 前，用 callback 读取、选型并冻结，或复用已有冻结内容用于下一次准备 | new-work   |

这里的 withSelection 是派发准备事务。它完整包住原 callback，包括已经冻结时的早返回；原独立 load/findBySessionId 仍是纯读取。callback 只处理原数据库选择、冻结和纯配置转换，没有进程或远端派发。不能把选型当成已执行的结果，也不能按方法名把混合用途的 nodeRuns.set/patch、Task intents 或 terminal recovery 一并变成 ACK。

Runtime capture 的空 events 保留原零写入早返回：调用原方法、不要求 Task context、不消费 host、不增加事务。原各 capture caller 的去重、part-id 标记、失败 marker、吞错／重抛和 BFS 顺序保持。其他三个 adapter 的全部读取也只转发原方法。

## 分层、选择和事务

复用四份既有 application/ports，不增加 CS DTO 或跨域 port。Task infrastructure 增加 Task-only 的原工作捕获助手、三个具名结果投影 adapter 和 runtime 准备 adapter；捕获助手只保存上下文，不决定写入用途、不访问数据库。用途由上述具体方法固定选择。

装配保存同一 db、完整原 persistence 实例、各原 method ref/receiver 和 TaskHostWriteBinding。每个非空写方法在首个 await 前同步取得完整原 TaskExecutionContext、其 OwnershipToken 关联的同一 TaskHostAdmittedWork、原 capture 和 binding。updateWorkspaceProfile 和 clearReuseDisabled 保留原显式 executionContext > ambient 顺序：输入有 executionContext 时，使用同步 runWithTaskExecutionContext(originalInputContext, () => currentTaskExecutionContext()) 取得同一个完整原对象，再从它的原 token 捕获 work；不构造或复制上下文。显式输入在无 ALS 或处于另一个 Task 的 ALS 时仍优先，原方法继续接收原 input 和显式 context。没有显式输入才选 ambient；带 taskId 的方法按该 Task 取得 ambient context，node-runtime 的两方法沿其原无显式参数合同使用当前完整 Task context。原 node/task 查询和 owner fence 仍由原 native 方法决定。原 Task 调用者和节点归属须在实际根接线验收；不能在 SQL await 后反查并重建 context/work，也不 acquire、complete 或替换 token。

三个实际结果方法使用已有 withTaskHostIssuedAck；两个准备方法使用 withTaskHostNewWork，隔离档均为原 write。原方法通过 runWithTaskExecutionContext(originalContext, ...) 和保存的原 receiver 调用，原内层事务复用同一 DatabaseSession AsyncLocalStorage frame。新 wrapper 的 outer write 与原 SQL、owner revision、RM offered selection participant 和 host 消费共享一次真实 COMMIT。先执行原业务体，再按目的消费 host，保留原业务错误优先级和返回值；消费失败则全部回滚。draining 可以记录原已发工作的结果，不能开始下一次 runtime 准备。

withSelection 将完整原 callback 传给原方法，不重新包装或泄漏它的 selection session。原 active/fenced/session/node-mismatch、aggregate lock、finally 失活、冻结内容和 registry 独立读取保持；原 native 方法中没有外部效果，不在事务内增加网络调用。独立 freeze 同样为新准备。读取方法不增加 Task admission、host 消费或 SQL。

Task composition 的 createTaskExecutionPersistence 仅在显式 dependencies.hostWrites 被选择时，把原 drive/wrapperRuns/runtimeSessionCapture 三个实例交给结果 adapter；其他 aggregate 成员、原恢复工厂和默认 native 实例保持。composeNodeRunRuntimePersistence 增加可选 composition-only hostWrites 依赖，未选择仍返回同一原 native 实例。已有顶层 composition 出口足够，不新建 public 业务入口或修改三启动根。实际根选择留独立接线批次，不因工厂支持注入就签生产消费者闭合。

## 功能验收

原四份 native 文件、全部端口、原 callers 和既有 provider/capture/runtime-freeze 套件逐字保留。新增真实 SQLite/PostgreSQL 测试覆盖三种结果投影在 draining 下的实际行和 owner revision、原 missing/no-op/false 和业务错误、消费失败后同笔回滚及原工作重试、完整 context/token/method/receiver 在跨 await 后保持、空 transcript 和纯读没有 host 消费、显式选择缺原工作时不补 native。两个带 executionContext 输入的方法分别覆盖无 ALS 的合法显式调用和另一 Task ambient 下仍使用原显式对象/token/work，并断言实际行、owner revision、原对象身份和外部 ambient 恢复；runtime 与 transcript 沿原各自 ambient 合同验收，不静默新增公共参数。

runtime 准备使用原真实 NodeRun adapter 和原 selection callback，覆盖选型＋freeze、已冻结早返回、继承 snapshot、丢失 authority 后实际 SQL 全部回滚、原 callback 错误优先级和原 escaped-session 的 finally 行为。用真实 provider 事务确认没有额外 BEGIN/独立 COMMIT，原工作不被完成。保留现有 runtime-selection offered participant 的合同回归，不能用假返回值替代实际节点冻结证据。

实施前消费独立有限功能设计门；实施后独立源码门、一次新源码候选原 scoped census、配套门、精确发布和 hosted exact-SHA CI。新测试按双 provider 与 Windows 原平台命令注册，共享 Windows 在双方引用测试都已发布后才提交，不收编并行未追踪源码。本机不运行 AW tests/typecheck/build/services/E2E，静态格式/lint和纯 AST/字节/JSON核对不代签运行成功。完整阶段 A 验收后才进入各层独立 CS adapters，M0 先实际部署，再逐项 M1～M4。

## 有限设计门修订

DESIGN1-R1 的正式有效稳定 FAIL 已由 root 实际消费；唯一功能 P2 W2-P-DESIGN1-R1-F01 指出原两个具名方法的显式 context 优先级遗漏。原 R1 回执和完整29项快照保留。R2 明确捕获并恢复同一个显式原对象、token/work，再选择 ambient，并补实际双 provider 验收；必须取得并实际消费 R2 PASS 后才实施，不给尚未修改的源码或实际 roots 签信用。

## 源码候选

R2 设计的32项首末完整绑定有效稳定 PASS，原 F01 已闭合并由 root 实际消费。已增加三个 Task infrastructure 文件，仅在两处 composition 显式选择 hostWrites 时装配。原四份 native、四份 port、全部旧 callers 和旧套件保持；withSelection 保存原 bound generic 方法，不通过 Function.call 擦除返回类型。缺原 context/work 明确失败，空 capture 继续调用原零写入方法，读取不参与 admission。

新增真实双 provider 21例／每 provider，覆盖三种结果在 draining 下的实际行与 owner revision、同笔 ACK 失败回滚／重试、两显式输入在无 ALS／另一 Task ambient 下的完整对象身份与恢复、空写／读取零事务、false／missing／原错误优先级、跨 await 的原 method/receiver、实际 RM offered selection＋冻结／继承／冻结早返回的新准备、失权回滚三列及原 callback/session 行为。每个真实写录制一笔 BEGIN 和 COMMIT／ROLLBACK；本机仅做六路径格式／lint及纯 AST/字节核对，不运行这些 AW 用例。

有限源码门、一次本新候选 scoped generation、配套门、精确上库和 hosted exact-SHA CI仍需验收。共享 Windows 登记在引用测试都已上库后单独提交。完整 Task/Node用途分类、实际 roots/provider/child选择、恢复管理面、H7/A-G和CS部署仍保持开放。

## 共享安装实例 fixture 修正后的源码候选

原 SOURCE7-R1 是当时冻结内容的有限 PASS。其后 GitHub 在 runtime lease 的跨 Task 用例中确认，同一数据库不能并存两个活跃 installation；本候选测试中同类 fixture 写法已一并修正。独立 FIXTURE4-R1 实际读完并复核 51 项，保留全部原用例、预算和原始 matcher 意图，同一安装实例现在创建两个真实 Task、两个独立 token/work 及恰好两条已接纳 lease，其他 Task 的原始行和上下文恢复断言完整保持。共享 helper 和 runtime lease 测试已在 c81fc950cdde2c478851c61cfd0abb45f593a413 的三路径修正中发布。

本候选五个生产 TS 和原有 21 个用例/provider 保持，修改后的投影测试与该追加记录需重新冻结并绑定当前有限 SOURCE7 候选；不会用旧 fingerprint 代签。StatementRecording 原合同在新三件套中直接列为 control。当前仅整理源码检视证据；实际源码配套发布仍等待 GitHub 总流水线全绿，完整 H7/A-G、CS adapter 及 AW 在 CS 的部署均开放。

## 原生成、真实增长与发布边界

共享安装 fixture 修正后的 SOURCE7-R2 独立正式有效稳定 PASS 已由 root 实际消费，45 项首末完整绑定、完整 functionalAnalysis 与 statementRecorder 原合同均核对。源码 fingerprint 为 7d361a069a6e23a97a4277eff0402adf184866700d2f95f1a6c72d4eb49a2e75。

CI 前置条件在 0319cc77b7e2e46d737b6926725ea90bd4079b36 实际完成：主流水线 37815498721 的 72 项与 Windows 37815498722 均 SUCCESS；原 c81fc950 与 976f590e 的失败仍保留，不追记成功。W2-P 的新测试有 14 个定义、每 provider 21 个实际展开用例，目前仍是待发布的测试源码，不能以租约回归的三平台成功替代其 hosted 执行结果。

本批使用上述基线和冻结的 6 个 TS 文件做且只做一次原 scoped census，四份原规则逐字保持，13 份原输出及未被收编的并行代码全部保留。生产源摘要为 sha256:221b5e177750b14afbe9984196bb60352b5578ef51296f188b320abea5d10fa9；3 个 Task infrastructure 文件带来 7 个 owner、2 个 factory 和 2 个 erased database-adapter type imports。canonical 的临时兼容角色与 classic R1/R2 分开核对：5 个实际生产输入的 classic inbound/outbound 均为 0→0，原 356 条 authored debt、79 项 findings、所有旧 why 与业务 payload 完整保留，无新增或退役 classic debt。

129 项有序账本只配套实测差额：mutation-entrypoints 1979→1981、cross-context-observed-imports 6886→6888、architecture-exceptions 6030→6032、module-symbol-owners 27690→27697。四项增长逐项说明 RFC-370 W2-P，在源码发布时消费，再以普通后继退役；不改变分类器、登记理由或检查预算。四个原纯 JSON 治理与 pretty/ascii 格式函数先逐字复现完整原输出，再投影增长声明及 contentDigest；8 份 canonical、3 份未变业务治理及 status 的原始完整输出保持，status 不作 Prettier 归一。

配套独立 MATCHING16 门、精确发布、Windows 新测试登记及新 SHA 整仓 CI 各自验收。实际 Task callers 和三个启动根、其余 Task/Node 分类、child/boot 恢复、19 owner/三 roots、H7/A-T7/A-G 与 CS M0～M4 继续开放；AW 尚未部署 CS。完整阶段 A 门通过后，按各层独立 CS adapter 推进，M0 首先实际部署，随后逐项接入后续能力。
