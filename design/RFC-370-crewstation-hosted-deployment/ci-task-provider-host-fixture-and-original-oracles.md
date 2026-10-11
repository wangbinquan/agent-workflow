# RFC-370 Task provider 装配：真实 CI 夹具及原判据修复

本片仅修复 `ca6f8417e3c4903966e72d21f89264b7756b6586` 的实际 CI 失败。原 Task provider 装配及并行 RFC-371 缓存已于 `4037254b`、紧邻七项许可退役 `ca6f8417e` 发布；后继主 CI `38171413992` 与完整 Windows `38171413874` 暴露以下问题。原 SOURCE／MATCHING PASS、原失败、原生成历史和所有并行输出分别保留，不代签本片。

## 实际问题及修复范围

1. Windows `114564630142` 与 Ubuntu shard 5 `114564631204` 的 29 项新 SQLite provider case 在装配前即失败。`providerGraph` 把 `routeWorkspace` 仅放在 PostgreSQL 接收的顶层，而 SQLite 的 `SqliteTaskRouteLaunchDependencies` 从 `routeLaunch.routeWorkspace` 接收它，最终 `taskRouteWorkspaceParticipant.ts:200` 读取 `repositoryPreparation.legacy.reclaim` 时缺少依赖。现在同一份完整工作区输入按两种 provider 的真实合同分别传入；所有外部协作者有完整类型，未涉及的操作一旦实际执行仍抛出原 “outside provider assembly test” 错误。删除对整份 provider dependencies 的两次 `as unknown as`，保留刻意构造不完整宿主／不兼容输入的原负向用例。原 DB、module、persistence、认领、controller、实际 driver ACK 和全部行为断言保持。

2. Windows 同作业、Ubuntu shard 31 `114564631304` 和 macOS shard 7 `114564631265` 的原 Task lifecycle 源码判据不能还原新增 provider 装配片段。仅在原 `inverseHumanGateTaskSelections` 之前调用已经检视的完整 `inverseTaskProviderHostAssembly`；该 helper 先还原并行 RFC-371 的两个 CLI 根的四个原生 hook，再还原本片 11 份原文件的 177 个有限片段。原 21 个调用、15 个 purpose selection、参数、全源码 bytes／SHA、负向变异及原人数全部保持，不把新源码摘要替换成旧判据的期望。

3. macOS shard 9 `114564631353` 的原 RFC-103 配置透传源码 case 使用固定 `slice(..., ... + 1400)` 窗口；新增 driver binding 片段把原热读配置文本推到了窗口之外。只对该 case 的 `server.ts` 输入调用同一完整 assembly inverse，原 1,400 个 UTF-16 code unit 窗口、起始锚点和全部配置透传断言保持，不扩大窗口。

4. macOS shard 2 `114564631260` 的原账本数量 case 发现 `rfc359-w5-test-engine-hardcoding` 的实际条目数为 342、配套基线仍为 340。联合发布已登记两份 RFC-371 外部 OpenCode 固定 SQLite 文件夹具：`helpers/rfc371PersistentNativeFactFixture.ts: 1` 与 `rfc371-native-source-version.test.ts: 1`。仅以原 `ledgerEntryCount` 取得本份已命名字面量账本数量，同步这一行基线和理由，保留全部原条目、分类、规则及其他行。为本次基线增量显式记录一项短暂 `allowGrowth`，并准备紧邻普通退役提交；原 `ca6f8417e` 的失败记录不补造为通过。使用原 `withArtifactProvenance` 纯函数更新该数据的摘要，不执行新的 census。

5. 主 CI `114564630892` 的唯一 Format check warning 是 `packages/backend/db/migrations/meta/0244_snapshot.json`。该文件已有单独有效、稳定 PASS／零 findings 及根消费记录。完整 JSON 值、31,199 个字符串字面量与 509,642 byte 的非字符串外空白 token 流均保持，仅减少 24,635 个字符串外空白字节。此片复用该格式修复，不重新检视数据库算法。

## 保持与门检视

新 provider fixture 的原 `selected` 及后续全部 case 文本保持；三份测试的原 `expect(...)` 表达式逐项保持。两个旧测试分别通过限定逆变换恢复其完整原 bytes／SHA；新增输入层不执行产品或测试。原 P12 继续验证 11 份完整生产源码的还原、无关 suffix 保留和已引入片段变异拒绝。不得把 source preservation 声明为实际 Task 行为通过。

本片不改生产行为、原测试人数、断言、超时预算、Windows 登记、生成规则、原架构清单或扫描器。只有测试输入、精确配套基线、上述格式及本说明属于本片候选。原 Task 29 provider＋一个 source 的三平台预期 119 次仍需修复后 GitHub Actions 的实际具名日志验收；此前真实失败保留。所有 AW 本机 test／typecheck／build／测试服务／E2E 均未执行，只做限定格式／lint、纯语法与完整内容保持检查。

独立实现门只审功能正确性、完整性与回归；完整 receipt 的分析、每个 owned 结论和全部实际 EOF 身份由根消费后，才进入短暂 shared-main 发布。格式片的独立 PASS 按完整内容复用。精确文件暂存、共享 index／双方 publication lock、提交路径／真实 co-author、紧邻许可退役与 push 前后同步分别验证。

## 仍待验收

RFC-371 的原生页／原报告 Worker 失败、原迁移头 243／244 差额与 `HistoricalNativeVersionObserver` 的 public consumer 归属已交给「设计运行观测统计全景」会话；不在此片接管缓存实现。共同修复或相继精确发布后，新确切 SHA 的完整主流水线、默认完整 Windows 和全部 Task 新旧具名案例必须实际成功，才恢复后续 RFC 生产实施。

完整 H7／十九 owner／三个生产启动根、A-T7／A-G、各层独立 CS adapter、先 M0 实际部署再 M1～M4逐步适配，以及 RFC 完成仍开放。AW 尚未部署到 CS。

## SOURCE-R1 实际失败与后继候选

有限 SOURCE-R1 为有效、稳定 FAIL／一项 P2，根已完整消费正式回执中的九项功能分析、五项 owned 结论、38 项材料三轮 EOF 及 manifest／四份具名材料。该门发现新 typed fixture 的 PostgreSQL 装配遗漏原必填 `workgroupTaskRoom.collaboration`；真实工厂在返回 graph 前无条件读取这一格。现只在 PostgreSQL 实参恢复原 throw-on-use collaboration 槽，原 required 类型、真实 DB／module／driver 和全部旧 case／断言／预算保持。原 R1 失败材料与回执不改写，新增 R2 单独验收。

主流水线最后完成的原 W7／W8 失败另见[活跃度与站点设计](ci-legacy-activity-and-lineage-design.md)：原插入点上方文本增加导致唯一行号登记 2504→2537，SQLite 原活跃度端口直接暴露新增可选参数导致 `.length` 1→2。这两项有限修复保持原判据，按独立设计及后继源码门验收，不折入已冻结的 R1。

该有限 DESIGN-R1 为有效、稳定 PASS／零 findings，十项功能分析与八材料三轮 EOF 已由根消费。已在既有 legacy 装配点落实一参数同步委托，原 await 回调和冻结形状不动；W7 仅更新真实行号和理由，原六个 `expect`、四个 case、完整 AST matcher 与预算逐字保持。纯原 matcher 只解析四份已命名源码字符串，确认四站点三列与新登记完全一致；不是原测试执行或新 census。全部十一份生产 preimage 仍还原到各自完整原 bytes／SHA，新增夹具的原 97、生命周期 170、配置 56 个 `expect` 表达式均保持。R2 实现门及 hosted 行为另验。

本片自身三测试／数量／格式修复没有新生产 census。联合候选另含经独立检视的原活跃度装配修复及缓存会话的真实 public consumer 装配修复，因此双方源码冻结后共同执行一次必要的原 scoped census，并单独检视配套；不得用此前 342 字面量数量纯检查或旧联合发布的生成结果代签新生产输入。maintenance 并行候选完整排除。新确切 SHA 的完整主 CI／完整 Windows 总绿及真实目标执行仍待验，原预算和过去失败继续保留。

## 1752f02e 的真实 Windows 结果及两项 Task 后继修复

上述联合修复已以源码提交 `8624aaf44161cf602991c6b193f1b0d7fc2bc3f6`、紧邻普通许可退役 `1752f02e868ff58ea443ed89efc1af0bb9381075` 发布。双方 SOURCE、唯一原 scoped census 及 MATCHING 分别验收；推送后共享 index 为空、main 与 origin/main 为 0／0，maintenance 候选完整保留。原正式检视不代签 GitHub 结果。

最终 SHA 的完整 Windows `38178251326`／作业 `114585119210` 已终态 failure，失败步骤 `RFC-254 platform suites` 为 1,393 pass／3 skip／9 fail。Task 的全部 30 次预期执行实际出现，29 pass／1 fail，没有缺失或额外案例；原 lifecycle 完整源码判据另失败一次。RFC-371 原生 provider 用例已通过；七项原生页 Worker 失败已交接给原会话。主 CI `38178251313` 已终态 failure，72 作业为 64 success／8 failure，含 Typecheck、六个 backend 分片和汇总作业。44 份完整 backend 分片、完整 Lint 与 Windows 日志均已取得；Task 的 119 次预期执行为 116 pass／3 fail（各平台 SQLite P08），无缺失、额外或重复。主流水线的 25 项真实测试失败均归到上述两项 Task 判据或 RFC-371 Worker，不能将部分通过宣称总绿。

本会话的两个修正仅落在测试层：

1. `rfc370-task-host-runtime-lifecycle.test.ts` 先还原 Task provider 与 HumanGate 后，再调用 `inverseTaskRuntimeLifecycleRootSelections`；后者重复还原 Task provider，导致 PostgreSQL 根的已还原片段再次被严格 helper 拒绝。把唯一原调用从 lifecycle helper 移到外层 `inverseTaskLaunchRootStatements`。原实际根仍按 Task provider → lifecycle → launch 的顺序还原；直接 lifecycle 判据只处理自身 selections。全部完整旧字节、根人数、调用输入、guard 与三类原负向变异判据保持。

2. P08 原 `awaitTaskDriverIdle` 等到 registry settle，而所选 Task 的 workspace finalize／host admission 完成 ACK 随后才结束。该测试在 idle 后立即读取 `completed`，实际得到 1。现继续等待同一 `graph.executionModule.host.finalizations.pendingForTask(taskId)`，随后保留原 `completed === 2` 与 successor intent completed 断言。原真实驱动、durable successor、等待及去重路径保持，未替换成延时或另一模块的等待。

两个候选的精确逆变换分别恢复完整旧 helper 与完整旧 provider test；原 97 个 `expect` 表达式、29 个展开 case、名称及预算保持。限定 lint／format、纯 AST 与完整字节检查通过，无本机 AW test／typecheck／build／服务／E2E。新的有限 SOURCE-R1 为有效、稳定 PASS／零 findings；八项功能分析、两项 owned 结论、31 份材料及 manifest 三轮实际 EOF 已由根完整消费，47 处证据引用与当前两文件的真实身份均核对。该门只检视上述两项，不授予 hosted 119 次通过、maintenance／完整 H7／三个根／CS adapter／部署或 RFC 完成信用。

本会话的测试后继候选没有生产源码变化；联合候选的架构生成影响按最终双方批准的实际发布路径核对。此前已完成的生成记录保留，不因 HEAD 移动或这些测试层修正再执行整仓生成。RFC-371 两文件 Worker 修正的 SOURCE v360 与新增类型修正的四文件 SOURCE v362 均已独立通过并由根完整消费；v362 的九项功能分析、四个完整原文件差异／精确逆变换、17 份实际 EOF 输入和 39 处证据引用与当前四文件身份均核对。该会话已正式交接这四个冻结候选，暂停其 AW Git 和共同生成文件写入，交由本会话完成必要生成及串行发布。累计使用量持久化仍由它负责；两份 `persistent-calculation` 设计资料尚未实施，不纳入本次修绿候选。

完整 Lint 作业 `114585119391` 的 Typecheck 还揭示测试声明问题。Task 测试现以仅位于测试内的断言委托执行原 `assertTaskExecutionContext`，把同一个受信实际对象收窄成内部 `TaskExecutionContext`；不扩大生产公共 `TaskExecutionContextRef`。旧 resume／retry 入口按实际原函数参数声明表达同一个数据库入参：不完整绑定路径仍先拒绝，保持零 SQL；P09 则保留原 `getTask` 只读查询和所选实例的 active-owner 拒绝，发生在 continuation 受理、SQL 写入及工作区回滚之前，不声称零 SQL 读取。负向 start 输入补齐必需的空 `inputs`。协调器输入按原函数入参类型声明，未触达的 fusion scheduler 补齐会抛错的 `cancelChild`／`resumeChild`。完整精确逆变换恢复类型修正前候选，再去掉已检视的 ACK 等待即恢复完整发布原文件。97 个断言、29 个展开 case、名称与预算保留；其中 95 个 `expect` 表达式逐字保持，另两处仅为旧数据库类型断言和 negative fusion 构造输入的两个必需未使用端口。限定 lint／format、纯 AST 与完整旧字节检查通过；新的有限 SOURCE-R2 为有效、稳定 PASS／零 findings，八项功能分析、一项 owned 结论、21 份材料、三轮实际身份及 44 处证据引用已由根消费；一处末行引用已由检视者写入独立更正回执，原回执保留，未重做功能门。RFC-371 的四项 page／Worker 类型错误已按实际日志交接；该会话对生产分页增加原接口类型声明；四文件 SOURCE v362 已 PASS／零 findings 并由本会话完整消费。双方五个 TypeScript 候选（一个生产文件、四个测试文件）、两份状态文档及 STATE 将共同冻结；只为该新生产输入执行一次原 scoped census 与配套检视，原历史失败和旧生成证据继续保留。
