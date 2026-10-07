# RFC-371：显式原生采集与完整基线后台读取

本片已获独立 DESIGN v3 PASS；下面保留获准设计与计划。源码候选包括严格安装选择、原组合根接线、真实后台读取和整个根集合的一次回调。发布、确切 SHA CI、真实模型执行和性能退出项分别验收，当前不据源码或模拟原生文件宣布 RFC 完成。

# RFC-371 R03：原 Task 根的显式验证采集接线

`createNativeUsageInvocationPersistence` 和 root-set v3 已存在，但 SQLite/PG 的实际 Task persistence 创建点都未传入 nativeUsage。当前 default OFF 是源码事实，不能以原语或旧回归通过冒充生产完整采集。本片只使明确验证的 OpenCode 注册项修订进入原持久分页来源，为真实多根/恢复验收提供正式入口；全局默认资格仍按原计划分项审验。

保留全部旧调用、v1/v2合同、原唯一数值账本和已知四桶/CNY。新的安装选择只作用于真实新 invocation 中已冻结的运行时注册项和修订，不成为历史统计过滤器；无注册项/旧修订/Claude/托管权威继续当前原路径，不造新 claim、owner、价格、完整零或降级本地平台账本。

本片完成后仍需真实独立模型任务、多根与恢复、原完整规模和 CS 托管联合验收。实际 100000/10000000 人口、原预算和全部断言保持，禁止提前结束两个 RFC。

# 原生产根接线设计候选

## 冻结选择与旧行为

由原 platform/daemon bootstrap 解析可选 `AW_NATIVE_OBSERVATION_ADMISSIONS`，严格 JSON 数组，每项 registrationId/configurationRevision，修订必须是合法正整数，注册项使用原 key 合同；空/缺省关闭、重复/额外/非法拒绝，不设置数组人口上限。新验证运行时使用真实已注册的新修订，避免使旧 pending/dispatched 记录被当前开关重新选择。配置只选择新采集，不参与任务、调用、原页、数值报告筛选。验收运行时名称与人民币费率明确验证性质。

扩展原 NativeUsageInvocationPersistence.forInvocation 的可选冻结 runtime 参数，来源是同一次 TaskAgentRun 的 runtimeObservationIdentity 与实际 protocol。参数不是新的数值、claim 或执行权。原 factory 的既有直接调用（未传 selection）保持原行为；生产组合根总是传入已解析的完整选择快照。匹配的 OpenCode 调用才返回原 Task 上下文的持久 participant，rootSets=true；未匹配返回 undefined，原无持久 participant 行为保持。没有原 currentTaskExecutionContext 时仍不能新造上下文。

只读选择决定发生在原 invocation 创建、实际租约和 material 之前；不读取当前可变目录补齐旧 runtime。新主配置或安装变化不能改变已开始的 invocation owner/key、已固定费率或历史 reportId。实际 authority 仍由原 observationInvocations.accept 决定；托管不能借这个本机选择创建本地数字账本或价格。

## 双 provider 与实际装配

复用现有 TaskExecutionPersistenceDependencies.nativeUsage，由原 bootstrap 构造 participant，统一传入 SQLite 默认任务/宿主任务、PG 主 persistence 与直接 provider-runtime 构造点。已有自定义 persistence 保持其完整对象，不覆盖 caller 输出；显式选择却未装配必须清楚报告能力尚未就绪，不能假定已经采集。

数据库/生成代次来源是原已解析 provider binding，不能回退 SQLite、猜文件或另建数据库。独立原 baseline snapshot 使用 platform 现有 ReportSnapshotSession：SQLite 是原 live WAL 文件与真实 generation，PG 是同一 provider runtime 的实际独立保留连接。PG poolMax=1 维持原逐页严格核验，不能持有唯一只读连接同时等待写入。不能用内存 DB 的第二连接假装原快照。

完整性和响应性分别验收：当前 SQLite report file snapshot 直接同步读取，不能未经验证宣称长 baseline 在后台。接线前补齐实际原只读 Worker/通道，使大范围 baseline 验证不在 daemon 请求线程扫描；不能为速度裁减旧 baseline、根、parent 或步骤人口。复用现有原 worker 和 snapshot primitives，新增 worker 只持有原 read-only binding，不接管业务写事务。

## 原 baseline 与整个根集合

原 root-set freeze 先提交真实切换水位；final 的原 baseline read reservation 在冻结后建立，覆盖同一调用的全部根扫描并在回调后关闭。当前 nativePageCapture 的 withFinalOwner 是逐根调用，接线前需要在整个 final traversal 外层保留一次原 callback，避免 A→B→A 每个根重复扫描完整 baseline。初始 resume A 的全部旧页面/ACK/parent/step归属一次严格核对后，原索引供本次所有 final packet 使用；B/reset 的真实 birth 和 generation 判据继续，不能用 A 的 baseline 替 B 造空基线。

每个原 root/pass/page 仍逐页持久、ACK、投影、历史修订、seal，A只采一次；某根失败继续保留其他根的已知四桶与人民币，同时保留不完整状态。原 actual PID/launch/spawn/reap/drain 与逻辑结果严格区分。原 context、owner、generation、key、watermark和ACK均不由调用方数组/数量证明。

## 范围与保护

本片不改变统计页、价格配置或发布 API；原数组长度/页大小只约束传输和调度，不限制总体统计人口。原 v1/v2/旧 factory tests/已保存报告保持。新增控制锁住缺选择、不匹配修订、非 OpenCode、缺原上下文、托管权威、PG单连接和实际旧新版本回放。保持原租约回滚、真正2501 baseline、1001+2 WAL、41根/A→B→A、全部原四桶/CNY、100K/10M预算及断言。

实施前独立 DESIGN PASS；实施后 SOURCE 独立有限 PASS，精确文件 format/lint/纯AST；原官方matching只对完整源码候选生成一次。AW 不运行本地 tests/typecheck/build/E2E/新服务，功能和规模由确切 SHA hosted CI 决定。不得覆盖其它 session、动态追逐无关 SHA、联系不相关会话或涉及安全分析。

## 实际后台 before 读取生命周期

新增专用 `nativeUsageBaselineWorker` 协议/host，复用原 `originalSqliteFileReportSnapshot`、`originalPostgresqlReportSnapshot`、原只读通道客户端及 `withNativeUsageBaselineSnapshot` 的严格完整验证。原 report/native-history Worker 的一阶段结果/关闭协议不被改成长驻假会话；已有读取、报告及历史修复行为保持。

SQLite 的 Worker 只接收 bootstrap 冻结的原 filename/generation 和原 binding/completion，小引用不能变成整个 baseline 人口。Worker 自己建立原 WAL read-only snapshot，在原严格 `verifyNativeUsagePass` 全页/全部成员/父归属/累计 ACK EOF 验证之后回复 ready，原读事务保留到整个 callback 结束。host 暴露同一 `NativeUsageBaselineReadView`，每次只发送原 final transport packet 的 stepIds，原 `members` 查询仍来自该实际快照；不传缓存索引/聚合数组。主请求线程不打开同步 SQLite before 连接、不遍历原 baseline 页面。

PG 由原 runtime 预留独立连接并建立实际 repeatable-read 原 snapshot，Worker 的只读 RPC 经原 `OriginalReportReadChannel` 执行，schema/provider 与原 report path 保持。同一个 reservation 到整个 callback 及所有已开始 SQL RPC 完成之后才释放，既不把 URL/pool 发送到 Worker，也不重新猜一个数据库。poolMax=1 或实际 SQLite 内存部署不使用额外 reservation/Worker，保留原逐页完整验证；这一配置能完整核验，但不能以该控制用例宣称大 baseline 响应性已达标。生产资格仍由真实规模与响应时间验收决定。

接口以额外可选 `NativeUsageBaselineReadSession` participant 提供原 binding/original/run，既有 factory `baselineSnapshots` 与缺省旧调用保持。生产组合根根据真实 provider binding 和原配置的 poolMax 选择该 participant，不从当前 DB 临时状态推测连接数。

Worker 只允许一个 open、一个待完成 membership 请求、单调 requestId 和严格对应回复；ready 必须保留原 snapshotId/generation/original completion。空成员集合不等于空 baseline；`hasPopulationIssues` 只允许原 nullable view，使旧 A 数字保持 unavailable，不伪造新消费。验证异常拒绝进入 callback；未知成员严格返回实际集合，坏绑定/EOF/generation 不能降级。close/cancel/error/异常 callback 都结束原快照，关闭后的 view 不能读取；host 等真实 Worker close 事件和全部开始的 PG SQL RPC 后才回收原 reader。任务逻辑取消本身不取消 final 采集，原物理 reap/drain 后仍核对已知数字。

## 整个集合 callback 的原类型约束

保留已有 `withFinalOwner` 的原 pass-ACK 返回合同。全根 traversal 的 callback 保存并返回最后一个实际成功 pass 的原 ACK；该值只满足原回调返回类型，不作为整集合完整性证明。根 population/切换 watermark/每个 pass EOF 和 completion 仍来自原 frozen root collection 及原 completion owner。没有实际 ACK 或任一根失败时保留第一失败，继续其他已准入根，最后抛出失败并 seal 原 partial proof。非 root-set 的原 v2 callback 次数及单根 resume 防护保持。

同一已验证 A 的 before view 只用于原 `emitNativeUsagePage` 的 resume-A 分支；新 B/reset 必须继续原真实 birth-after-spawn 判据，不能因得到 A 的 view 被当成已验证 baseline。新 interface 参数中的 runtime 只用于显式匹配，原 owner binding 继续仅含实际 invocationId/taskId/nodeRunId/executionContext，不能把安装选择或协议字段混成 owner 身份。

## 原回归和新增验收清单

原 baseline tests 的2501成员、完整原页读取次数、唯一COUNT证明、关闭后拒绝，以及真实SQLite WAL1001旧+2新全部保留；原41根/A→B→A、812最终行、所有四桶/人民币与丢页/未知输出/物理未settle/代次替换/ACK丢失控制不减小、不修改原预算。新增真正file-Worker重复membership和同时final commit/live旧成员缺失、关闭/坏generation/错误回复/取消等待SQL的控制；PG实际两连接原reservation及max1无nestedreservation对照。新增 root-set callback仅一次且真的两个root EOF，两根已知数据和partial来源分别保留；不凭spy或标题声称完整性。

新增装配验证覆盖SQLite主Task、宿主Task、PG主Task和直接provider fallback，控制缺省/空选择/旧修订/Claude/无原context/自定义persistence/hosted authority。原任意配置revision=0不新选，原旧接口直接factory测试保持。测试只能提交后由确切SHA hosted CI运行，本机不执行AW测试、typecheck、build、E2E或规模用例。

# 本片计划

1. 固定原启动根、原 factory、原 worker/snapshot、原协议、原租约和历史核验源码，以有限完整 EOF/HASH 设计门核对实际缺口，不通过文字自证接线。
2. 先落原全根 baseline callback 和实际后台原读通道，新增严格数据及关闭/取消/错误恢复回归；PG poolMax=1 原路径保留。
3. 落严格安装选择、原 invocation runtime 快照、双 provider 的实际组合根装配与旧默认控制；不改并行产物或现有身份/价目表。
4. 有限 SOURCE 后精确提交、原 matching/census 增量、确切 SHA 全部功能与定时 CI。旧失败和首轮 flaky 保留；扫描只核允许的元数据。
5. 用原获准验证身份/资源和明确 CNY 费率创建新的验证修订，真实单/并行/resume/reset/多根/失败任务；对拍原 source/ACK/数值/费用/完整报告/UI。只读页面验收身份不能用于写入。
6. 运行原规模/性能退出项，记录真实 EOF、每桶精确字符串、价格与已知部分、响应时间；不减少原人口、预算或 assertions。完成本片仍不自动关闭 R03～R12、托管联合或两个 RFC。

7. 专用原 before Worker、一次全根 callback 和双 provider 正式装配作为同一完整候选评审；正式启用前保留真实 Worker/连接回收与原所有数据控制的 hosted 证据。新增任务不得以精简人口、只读 spy、旧报告或模拟模型代替真实生产任务核对。


## 2026-10-07 源码准备发布与页面实录

35 个本会话核心/登记路径已提交并推送 `86c28e48624b7c0e23803bf92b825c282b2d1c81`。SOURCE v3 有效 PASS（P1/P2=0），明确保存 ready 后取消/异常退出的首个失败；真实 Worker abort/exit、回调屏障、物理 close 和原快照再次打开的新增回归已提交，尚待 hosted 执行。META13-v2 有效 PASS，原官方生成与保留的完整库存一致。下一普通无源码增长提交仅退役本批六项实测许可并固定原 provenance，原129有序库存/why/数值不变，不重复 census。

四共享启动/provider 文件仍保留本会话原生装配与 Task 配置会话的全部输出，由原配置 owner 发布其完整依赖；独立 `rfc371-native-selected-root-bindings.test.ts` 随该依赖就绪后接续。本文核心发布不证明生产根已经远端接通，安装选择仍 OFF。原 SQLite 后端启动修复已经实际恢复原7456进程，正式全时间页面实录425任务，已知四桶96095/21120/0/6023合计123238及验收人民币¥0.16583，历史缺口保持；柱状下钻显示8个真实验证任务，包括已知部分 Token 和人民币。

本机没有执行 AW tests/typecheck/build/E2E。新确切 SHA CI、安装新验证修订后的真实模型/多根/恢复、CS真实原生采集及部署、原规模和两RFC关闭继续验收，未据本片标完成。
