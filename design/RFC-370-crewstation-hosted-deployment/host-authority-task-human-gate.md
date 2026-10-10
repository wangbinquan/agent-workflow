# RFC-370 C2-W2-H：Task 人工门的具名写视图

本设计接续已经封存的[生命周期切面](host-authority-task-runtime-lifecycle.md)，落实原 L16。生命周期 SOURCE18-R2 和配套门是独立候选；在其配套检视期间不改任何冻结源码。本片先完成独立功能设计门，生命周期发布及其新 exact-SHA 总 CI 全绿后才实施。

## 现有合同和真实调用者

Task 自有 `HumanGateTaskLifecycle` 已有三个 Promise 原子：`parkPrepared`、`settleManualQuestionParks` 和 `trySetWhenNoManualQuestionParks`，不需要重新抽取人工门业务合同。基础实现 `DatabaseHumanGateTaskLifecyclePersistence` 对两个 provider 共用；前两个原子用原 `withTaskExecutionSerializable`，最后一个调用原 runtime lifecycle 的私有 `trySetWithGuard`。

`parkPrepared` 在同一事务消费 Collaboration prepared operation、投影 gate／Node、变更 Task 和追加事件；返回后发布事件。`settleManualQuestionParks` 消费已持久化的 manual-question park obligations，按原 outstanding 结果决定 Task 停靠；空操作保留其原返回。`trySetWhenNoManualQuestionParks` 的原 guard 在同一 runtime lifecycle 写事务检查 outstanding obligation，保留 `manual-question-pending` 与原 `settled/won` 区别。不得把整个私有 guard helper 统一套为 ACK：boot recovery 也消费同一 helper，却没有这些人工门结果事实。

本片的真实生产选择如下；目的由调用点指定，不从目标状态或异常推断。

| 编号 | 原调用点                                                                                 | 写目的与事实                                                                                                          |
| ---- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| H01  | `taskEngineApplication.ts`，claim 后 `initialManualPark`                                 | `issuedResults`：消费之前已持久化的人工问题 obligation；后续 Node 派发仍各自经过 preparation。                        |
| H02  | 同文件，scope 返回后的 `manualPark`                                                      | `issuedResults`：记录该原 scope 的人工等待，取消优先级不变。                                                          |
| H03  | 同文件，`active-clarify-released-before-review`                                          | `issuedResults`：原 scope 已返回 awaiting-review，先修正 canonical running 状态，再停靠；本次 CAS 不启动下一次 Node。 |
| H04  | 同文件，`scope-awaiting-review`                                                          | `issuedResults`：原 review outcome 的停靠。                                                                           |
| H05  | 同文件，review while-loop 的 `manualPark`                                                | `issuedResults`：消费造成当前结果让路的原 obligation。                                                                |
| H06  | 同文件，`active-human-gate-released-before-complete`                                     | `issuedResults`：原 scope 已算出 done，running 是原完整终态序列中的中间状态。                                         |
| H07  | 同文件，`task-done`                                                                      | `issuedResults`：原 Task outcome 的终态 CAS。                                                                         |
| H08  | 同文件，completion while-loop 的 `manualPark`                                            | `issuedResults`：原 done settle 与人工问题交错的既有投影。                                                            |
| H09  | `collaboration/infrastructure/review.ts`，prepared review 的 `parkPreparedHumanGate`     | `preparation`：为本次新 Review Node 开门和建立人工审查投影；失权时不再受理新门。                                      |
| H10  | `collaboration/infrastructure/clarify/service.ts`，runner 结果的 `parkPreparedHumanGate` | `issuedResults`：保存同一已发出 Agent 结果所携带的 clarify；不启动其 rerun 或下一次执行。                             |

上表只签这些实际操作；`prepareReviewGateOpen`／`prepareClarifyGateOpen` 自身的 Collaboration 持久业务、人工 decision、manual-question 创建和后继 continuation／repair 仍由其真实 owner 继续分类。不能把 prepared operation 一概视为宿主执行受理回执，也不能借本片开放下一次派发。

## 中立选择、装配和原事务

在 Task application 增加 `HumanGateTaskWritePurposes`，包含 `preparation` 与 `issuedResults` 两个完整 `HumanGateTaskLifecycle` 视图，及对应纯 selector。`TaskExecutionPersistence` 增加可选的 selected 标记／视图；native 两项都未选择时返回同一原 instance，已选择却缺少目的视图时明确报告装配错误，不落回 native。

Task composition 以原 `hostWrites` 选择两个视图；实现仍归 Task infrastructure，复用完整原 adapter、方法与 receiver，不引入 CS DTO、SystemOperations 内部实现或新的 npm 包。三个实际启动根随后沿原 persistence 装配继承这组视图，本片不倒签根的全部功能完成。

每个 selected 操作在首个持久 await 之前固定原 Task context、admitted work、capture、binding、目的和输入。保持显式 token 与原输入之间的关系，不能为了通过宿主消费把 ownerless 原输入补成 owned，也不能在 await 后从当前 Task ID 或新 grant 重建旧工作。prepared ref 保留原不透明引用身份；时钟、Task／operation ID、原允许来源和 extra 保持。

两个跨表原子的私有 purpose 入口只替换原事务选择：以 `withTaskHostNewWork`／`withTaskHostIssuedAck` 的 `isolation: 'serializable'` 承载完整原 callback，保留 SQLite BEGIN IMMEDIATE 和 PostgreSQL 原 40001 整笔重放。原 SQL／participant／Task owner increment／返回／异常顺序不变；完整原 body 成功后、COMMIT 前才消费同一 capture，host 拒绝则整笔回滚。不能在原事务外再包一层、让原方法提前发布事件。

带人工问题检查的 lifecycle CAS 复用原 `set` 序列，增加私有 purpose+guard 入口，保持现 `trySetWithGuard` 原生实现。原 guard、CAS miss、tombstone、原 false/error 分类和事件发布都与生命周期切面同一语义；宿主消费在原 body 成功后执行。`ManualQuestionPending` 仍只按原分支返回，不转成成功或新的派发机会。

public human-gate composition 需要接通真实 selected persistence，不能仅依赖两个 producer 当前未传入的 `hostWrites` 参数。在首个 await 前按原 explicit／ambient precedence 固定同一 Task context；Task composition 用现有 `taskOwnershipHostBinding` 取得该 context.persistence.ownership 的原绑定，调用者显式 `hostWrites` 仍按原 dependency 优先。用该原绑定、原显式数据库／workspace dependency 创建本次 purpose 视图，不丢弃调用者的依赖。context 已选择人工门视图或已关联 admitted work，却缺少原 binding 时明确报告装配错误；无宿主选择的原 context 则保留 native 工厂。不能用 ambient context 存在便假定 native 工厂已经接入宿主，也不建立新的全局 binding 注册表。

H09／H10 在真实 producer 显式传递目的；没有选择宿主的原公共调用仍执行完整 native 分支。public 路径的 existing explicit execution context 与 ambient precedence 保持，缺少原 work、已选择但目的不完整的实际调用明确失败；standalone 原 ownerless 行为保持。其他既有字段／错误和 source-lock 判据按实际新结构同步，不删除其行为断言或放宽预算。

## 功能验证与交付

使用真实 SQLite／PostgreSQL 的 Task、owner、Collaboration operation／gate／Node／manual obligation 与 committed events。逐个覆盖两个目的下三个原子：原业务 SQL 先于宿主消费、真实事务仍活跃、host 等待期间调用 pending 和无事件发布；host 拒绝的全表 rollback、同一原工作 retry、原 40001 重放和提交后 publisher 失败的既有结果。保留所有原输入错误、CAS false、manual pending、空 settle、ownerless 和缺少原 work 的区别。

真实调用者验证覆盖上表全部十个选择：H01～H08 通过实际 engine 方法／原 while-loop 验证原结果、取消优先级和没有额外 dispatch；H09／H10 验证 public composition 真正走原 selected binding，Review 新门在 draining 下回滚，原 Agent clarify 结果仍可落账，其后执行仍须 preparation。冻结原调用表达式、完整旧源码／source locks 与实测 SQL；逆向移除选择增量后恢复完整原 body，不以复制的伪业务实现替代调用者验收。

设计门通过后再实现与独立 SOURCE 门；只生成该新内容候选的一次原 census，配套清单／Windows 登记独立复核，精确发布并逐项核对新 SHA 的全部主 CI、默认完整 Windows 与新增案例。不运行本机 AW tests／typecheck／build／service／E2E。

本片不关闭完整 H7、十九 owner、三个启动根、A-T7／A-G 或 RFC；boot／周期协调、manual continuation／repair、其余 Collaboration 控制操作继续。阶段 A 全部验收后编写各层 CS 独立 adapter，M0 首先实际部署，再逐项 M1～M4。AW 尚未部署 CS。

## 2026-10-10 实现候选与前置总绿

前置精确 `801435f8d364d556fccd57f71505b799049d2256` 的主 CI `38028006155` 为 72/72 success，默认完整 Windows `38028075893` 为 1/1 success；四工作区在两条流水线的类型检查全部为零。原生命周期用例实际执行 Ubuntu105／macOS53／Windows53，合计211次，均通过。较早 `0562e658` 的两条完整流水线亦已成功；旧失败记录保留。这个门槛已满足，开始本片实现。

候选新增 Task 自有 purpose selector 和完整三方法视图。两个跨表原子保留完整原 callback，仅选择原 serializable 事务载体；带人工问题检查的 CAS 增加独立 purpose 入口，原 native boot guard、六个 runtime 方法及其业务序列保持。公共 composition 固定原 explicit／ambient context，沿 ownership 原绑定装配，并保留调用者 db／workspace／显式 host dependency。H01～H08 显式选择 issuedResults，H09 Review 选择 preparation，H10 Clarify 选择 issuedResults。

纯文本／AST 保持检查恢复九份完整原生产源码，核对十个真实调用的原输入和原 SQL callback／guard／输入判据；不执行 AW 业务。原生命周期52个provider case及全量原调用者case完整保持，H 的37段限定增量只在旧全文件逆变换之前去除，未扩展通用 source reader或改变原启动根 inverse。新测试覆盖真实 SQLite／PostgreSQL 三原子、两目的、事务内结果、全表回滚／同一工作重试、COMMIT后发布、40001整笔重放、首个 await前输入／context保存、空 settle／terminal／resolved obligation／false／pending／原错误，及两个真实 producer和原 engine收尾循环。

独立功能实现门、该新生产候选唯一原 census、配套 Windows／架构清单检视、精确发布与后继 hosted CI 均另验。未运行本机 AW tests／typecheck／build／services／E2E；新用例尚未执行，不以静态保持证明代替功能执行。完整H7／十九owner／三个启动根／A-T7／A-G仍开放；CS各层独立adapter及M0～M4继续，AW尚未部署CS，RFC未完成。

首轮独立 SOURCE1-R1 为正式 FAIL：新增显式依赖用例分配了新 port，破坏原 capture 的绑定身份；真实 Clarify producer 用例只提供 id／title，缺少其实际问题类型要求。原失败候选与两项 findings 保留。修正只触及新增测试：保留原 port，改在显式 transactionFor 上计数并断言 receiver；Clarify 使用 single、recommended 及两个完整 option。生产源码、十个目的选择、有限 inverse 和旧测试保持；修正后限定格式／lint 与原保持证明通过，新的 SOURCE1-R2 另做独立检视，尚不签署新用例执行或 hosted CI。


## 2026-10-10 SOURCE1-R2 通过与配套生成

SOURCE1-R2 独立功能门 PASS、零 findings，主会话已消费全部40份冻结材料及实际字节身份；R1 FAIL 和两项夹具修正保留。17份源码／测试与 R2 相同，本文只追加配套记录。新187次 HumanGate与原211次生命周期仍须新 SHA hosted 实际执行，静态人口不代签。

在同步的236c6dab基底唯一原 census 已成功生成全部13份产物，四份原规则不改，6818份非本片源码来自精确 Git blob。本片实际只新增1个 mutation、10个 owner；原条目／SCC／边／后台人口／130行ledger保持。原28个纯声明逐字复现全部13份产物，两个实际baseline增长登记一次性说明并准备紧邻普通退役提交；无额外census或本机AW运行。完整Windows候选只加12个缺失输入与三套测试，保留全部原配置和并行输出。独立配套检视、精确发布及新主CI／完整Windows另验，详见[配套清单与发布](host-authority-task-human-gate-publication.md)。完整H7／A-G和CS M0～M4继续开放，AW尚未部署CS，RFC未完成。


## 2026-10-10 精确 SHA CI 修复候选

源码 32679b0c 与紧邻退役 eb6a4884 已上库。旧源码／配套 PASS 与完整消费保留，新 CI 的六个 TS2339、冻结 Proxy H05/H08 和 T19b marker 失败另记。当前上下文解析沿用原完整实例入口，原绑定判断回到 application 选择层，夹具以三方法委托保留原 receiver；错误码、全部旧断言／预算及九原源码／37 编辑／十调用保持。新功能源码门、唯一原生成／配套门与新精确 SHA 总绿另验，见[CI 修复记录](ci-human-gate-context-and-frozen-fixture.md)。398 次仍为预期；完整 H7／A-G、各层 CS adapter、M0～M4 和 RFC 未完成，AW 尚未部署 CS。
