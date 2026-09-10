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
| AC-1  | 已登记的机制差异保留对拍，其余重复实现合一        | 同目录153→9对已登记；W55将两个读取owner的三对完整资源快照投影共享，保原7调用及完整冻结/返回合同。三个SQLite原语的落位单独记为T17 59→56，不计业务合一。跨目录/内联真实重复缺口仍开；按用户要求W55后停止新RFC批次。                                                                                        | 进行中 |
| AC-2  | 一个 boot 序列，无 provider literal 执行分支      | `servePostgresqlDaemon` 已删除，入口 provider literal 分支为 0                                                                                                                                                                                                                                           | ✅     |
| AC-3  | 双引擎原子性对拍；裸驱动事务归零                  | 按 TypeScript 接收者类型扫描，裸驱动事务账本为 0；生成器 runner 的 27 次中立事务不误计                                                                                                                                                                                                                   | ✅     |
| AC-4  | 方言 exact 清单，每项真实双引擎执行               | `RAW_DIALECT_DEBT` 与 `UNSHIMMED_FUNCTION_DEBT` 都为 0；`greatest` 的 NULL 前提有显式断言                                                                                                                                                                                                                | ✅     |
| AC-5  | 守卫锁住新增分叉                                  | T17/T18/T19/T19b–g/T20 已落；W12 补全 T18 接收者变异与守卫元数据                                                                                                                                                                                                                                         | ✅     |
| AC-6  | 全量 backend 行为套件在真 PostgreSQL 上进 push CI | 当前1968测试文件、573构库文件/1131调用、483无harness/547有harness；W55新迁14旧文件51个DB声明/278 matcher，保65原声明/339 matcher、14原单次及全部预算。新增2文件9pure；真实新双库行为待托管，入口数不等于待迁普通业务量。                                                                                 | 进行中 |
| AC-7  | 12 条 P0 消失且有回归证明                         | exact `67e2cf8c9a756ca3831a083aa4455cc03c2e2287` 独立真 PG job `102039466503` 成功；Bun1.4 两库各17阶段/89次执行，67 pass+22指定历史失败/827 expect，99源码与34原始日志摘要已核                                                                                                                          | ✅     |
| AC-8  | 用户可见行为逐字不变                              | W54主2368身份全出现、2353过15新PG红，原2227全过；新43PG中28过15红，15红已定位澄清executionContext转交缺口。W55补两生产文件，纯字段转交回归6/60通过，原15测试及预算不变，真实修复待新SHA；全量双库覆盖仍未闭合。                                                                                          | 进行中 |
| AC-9  | 含全部 RFC 改动的 exact-SHA CI 全绿               | W54 exact3fad84efa451b5e0747aff8b8d7428a013cb2808 Main34433766182终态34/6，13后端10/3；主2353/15、原2227全过，独立2/2及hook18/18、原RFC259两OS、两个原Playwright身份两OS通过。W55最终39core编译、metadata63/111与canonical13/55通过且候选稳定，首轮缺import失败保留；完整新SHA待托管，发布后仅修流水线。 | 待办   |
| AC-10 | 业务 provider literal 分支为零                    | 当前精确账本为 0                                                                                                                                                                                                                                                                                         | ✅     |
| AC-11 | 两引擎 P95 基线，PG 各端点不劣于 SQLite           | 最新已核W52 full34427756137的360样本/18组P95仍有两绝对失败：SQLite tasks-first 150.616ms未低于150ms、PG workgroup-pending 11.571ms未低于10ms；其余16项通过，六PG端点相对较慢。W54 full34433823331仍由唯一watcher跟踪，原语料/判据不变，不以诊断代替性能结果。                                            | 进行中 |
| AC-12 | 全量装配，无晚绑定占位，退役未豁免 provider 文件  | 当前占位文本32→9、未构造根0保持；provider文件88→56，其中W55的59→56来自三个真实SQLite原语归位platform/persistence，原body和导出保持。三份资源快照投影共享不改变调用装配；新增双库行为和澄清上下文转交修复待新SHA托管。                                                                                    | 进行中 |

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
