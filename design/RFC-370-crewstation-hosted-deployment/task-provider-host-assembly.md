# Task provider：同一宿主实例的完整装配

状态：2026-10-12 有限设计 R2 已由独立门有效、稳定 PASS／零功能 findings，根已完整消费；当前为实施候选，SOURCE／MATCHING、新 SHA 全 CI 尚待验收。属于阶段 A 的实际根接线前置，不包含 CS adapter。SO write lifecycle 的 SOURCE／MATCHING、发布与确切 `0d43da993` 全部主 CI／默认完整 Windows、637 次实际目标案例已由根验收，详见[总绿验收](ci-so-write-lifecycle-total-green-closeout.md)。旧 R1 冻结包因两个 evidence basename 碰撞而 INVALID，历史完整保留；R2 使用独立编号冻结路径另行审查。原三根／十九 owner 的完整范围见[根装配图](host-execution-root-assembly.md)，本片不代签 H7／A-T7／A-G 或 M0。

## 当前源码与问题

SQLite 的 providerRuntime.ts 在 287 行新建 persistence，没有转交已有 hostWrites；307～320 行构造原进程级 driver lifecycle，activity／stop、390 行 background 和 405 行返回 module 也沿原单例。PostgreSQL 在 507、513 行分别接受 persistence／executionModule 的可选覆盖，缺省时各自新建，同样未转交完整宿主选择。已有 TaskExecutionModule 在 composition.ts:100～120 接受 admission 与 writes，createProviderTaskExecutionModule 也已有 host 输入，缺口是实际装配。

直接换 provider 返回的 module 仍不能闭合。services/task.ts:1235 的 createTaskDriveCoordinator 在 1315 行再次调用原 createDatabaseTaskDriverLifecyclePort；后者 infrastructure/taskDriverLifecycle.ts:384 固定用全局 taskExecutionModule。SQLite 原 claim(db) 与 legacyConnection 的部署语义必须保留，不借 PostgreSQL 的 claimPersisted 冒充等价。

同一 services/task.ts 有四个实际短生命周期构造点：2827 的 start、3126 的 wakeHumanGateContinuation、3564 的 resume／retry、4036 的 repository-preparation retry。人工继续的 owner idle 等待及 continuation 的 controller 读取／失败信号也直接使用全局查询。只给 coordinator 一个新 lifecycle，会留下查询另一实例的路径。

fusionEngineTaskOperations.ts 的 SQLite launch 调用原 startTask，cancel 保留八次终态查询后调用 composeTaskCancellation(db)。taskCancellation.ts 新建 native persistence 并取全局 stop registry。selected 必须将实际同一 cancellation 配对转交这些调用，不改变原终态查询次数、忽略单次取消错误和业务结果政策。

cli/start.ts:2143 的 SQLite provider graph 先构造，2339 的实际 root launch coordinator 后构造，已有 routeLaunch.coordinator 用词法闭包转交该实例。SQLite agent、workgroup 和 workflow 启动已共用原 RootTaskLaunchKernel，不恢复已删除的旧路由启动分支。PostgreSQL 和 embedded 根也各有自己的原 coordinator／模块语义；本片抽出可完整转交的绑定，三根选择与全 owner 生命周期另验。

## 完整选择与配对

两种 provider 增加可选的平台中立完整宿主输入：`daemonGeneration: string`、Task admission 和已有 Task write binding。`daemonGeneration` 是这个 Task 模块的进程身份，必须非空；它与 SO 每次 grant 的 generation 各有用途。SO grant 的原 generation／reference 必须继续由 admission 的实际 lease 传给现有 write adapter，不能拿进程身份构造 receipt。根使用一个 SO write context 的同一个 Task adapter 作为 writes，并使用同一 SO authority binding 产生 admission；共同层不读取 CS DTO、平台 URL 或平台令牌。

无此输入时，原分支的 module、默认构造、预装实例覆盖、原配置热读时点与返回面保持。显式输入缺 daemonGeneration、admission.acquire、writes.port 的 capture／consumeNewWork／consumeRecovery／consumeIssuedAck 或 transactionFor 时，在创建执行 module／参与者、调用其他装配回调、claim 或任何业务效果前拒绝。入口固定 admission.acquire 与 writes.transactionFor 的原函数及各自 receiver，并保留 writes.port 的原对象。不得把 port 包装成另一对象：现有 admission adapter 内的 capture 与业务事务按原 port 身份配对。四个 port 回调与原 receipt 继续由现有 captureTaskHostWriteContext 在每次真实 admission 中同步捕获，先于原 claim 的 SQL 等待；resource-only 构造不预取 receipt。选择对象／port 指针替换不会更换已经固定的绑定，已受理工作的消费回调不会被后续方法替换改写。module、persistence 和 admission adapter 仍使用同一个原 port；现有 opaque receipt／transaction 配对判据保持，不补半份 native 默认值。

selected SQLite 创建独立 TaskExecutionModule，使用原 claim(db)、原 provider persistence 与 legacyConnection；selected PostgreSQL 创建同一 persistence 对应的 ProviderTaskExecutionModule，使用原 claimPersisted。两者 persistence 都明确传递同一 hostWrites。activity、stop、background、recovery、driver 和返回 module 使用这一实际实例。不得通过类名、变量名、generation 相等或“都是 registry”猜测对象配对。

为避免 PG 现有两个独立默认槽拼出不匹配的 selected 组合，本片显式宿主分支由 provider composition 创建 module 和 persistence；同时提供旧 runtime.persistence 或 runtime.executionModule 覆盖时拒绝。PG 原 runtime.daemonGeneration 必须等于显式 daemonGeneration，避免两个进程身份互相覆盖。未指定宿主的原预装覆盖仍保持。未来若需要 selected 预装实例，以完整可验证的配对另行设计，不放宽为半份默认。

selected composition 输出一份完整 drive binding，保存同一 executionModule、persistence 和 driverLifecycle；native 返回面保持。它是 Task 组合层的实例绑定，不是网络 DTO，也不拥有业务状态机。原 module／persistence 的归属与 business transaction 不搬进 system-operations。供旧服务调用的类型沿已有 Task 公共导出／中立端口，应用层不向上依赖 composition 实现。

## 实际启动、查询与取消转交

createTaskDriveCoordinator 和 StartTaskDeps 增加可选完整 drive binding。显式绑定时仅消费这一 binding 的 lifecycle／persistence；原 input.persistence 若另行给出，必须是同一实例，否则在启动效果前拒绝。缺字段的显式绑定拒绝；未指定时保持原便利构造。启动、人工继续、resume／retry 与 repository-preparation retry 的四处构造都沿同一 StartTaskDeps 转交，不能只接长驻 root coordinator。这四个业务入口在各自首次任务／intent／工作区效果之前捕获并检验完整绑定，不能等到任务已经创建之后的 coordinator 构造才发现绑定缺失；运行配置刷新仍保持原时点。

原 activeTaskDriverController、awaitTaskDriverIdle、awaitTaskDriverReleasedSettled 等查询保留缺省 native API，并可显式选择同一 executionModule。controller 与 signal 的原精确对象比较、原 owner release／unreaped 错误保持，不能把未找到全局 controller 当成 selected owner 已结束。人工继续 handoff 的 selected 去重按实际模块 lifetime 隔离；native 原 taskId／continuationRef key 与行为保持。失权不补写取消／失败，不重复创建 continuation intent。

composeTaskCancellation 保留原单参数 native 调用；显式 drive binding 使用它的 persistence 和该 executionModule 的 Task stop registry。SQLite fusion 同时转交这份 binding 给原 startTask 与 cancellation。原八次终态读取、原每轮错误政策及已终态早退保持，不能把 runtime 档案 registry 当作 Task stop registry。

各实际 root 的 taskStartDepsFor、长驻 coordinator、人工继续／准备重试和 fusion 都必须转交这份 provider graph 的同一 drive binding。配置刷新只能更新原运行配置，不替换绑定；actor、launchProvenance、workspace、repo preparation、精确 continuationRef、completionMode、TaskEngine legacyConnection 及原 failureReporter 行为保持。

## 功能判据与范围

后续实现必须提供以下实际功能证明，登记数等测试落地后由源 AST 计算，不把本表当作已运行用例：

| 编号 | 必须证明的行为                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------ |
| P01  | native SQLite 单例、PG 原覆盖、配置读取时点和原返回面保持；原用例／断言／预算全部保留                              |
| P02  | 两个真实 provider 的 selected persistence／module／driver／activity／stop／background 捕获同一 writes 与 admission |
| P03  | selected SQLite claim 使用实际 SQLite 原事务与 legacyConnection；模块独立于全局 native 实例                        |
| P04  | 完整输入的每个缺失字段、PG selected 半份覆盖及不匹配 persistence 在效果前明确拒绝                                  |
| P05  | resource-only 构造／资源读取零 claim／零执行写／零执行 start；资源业务编辑仍可提交                                 |
| P06  | 实际 driver attach／release／finalization 使用同一 selected module／persistence；全局 native registry 不受影响     |
| P07  | 长驻 root 与四个短生命周期 coordinator 都消费同一 binding；原配置热读、工作区准备与业务错误保持                    |
| P08  | 人工继续等待 selected 原 owner ACK 后认领原 continuationRef；不读取另一 module 的 idle 或 controller               |
| P09  | resume／retry 的精确 controller 与 failure signal 来自同一实例；原 not-attached、terminal-won 与 unreaped 结果保持 |
| P10  | SQLite fusion launch 与 cancel 消费同一完整绑定，原八次终态查询及取消错误政策保持                                  |
| P11  | 实际 authority loss／旧 admission ACK 时序仍由现有 SO／Task 生命周期承担，不新增批量取消或伪造 closed              |
| P12  | 所有原 native source oracle 采用有限可核对 inverse 保留完整原结构；新 owner／public／依赖差异按原生成规则登记      |

本片的实例配对通过不等于三个 production roots 已进入 selected 模式。冷 maintenance／MCP／report、after-commit pump 的真实 ACK、十九实际 owner 的完整选择、boot preparation、资源就绪 API／UI 和关闭顺序继续按根装配图完成。完整 A-T7／A-G 之后才实现各层 CS adapter；阶段 B 仍先 M0 实际部署，再 M1～M4。跨进程旧 durable intent／receipt 接管在 M1 前另验。

独立设计门仅审本有限功能设计。实现后分别完成有限实现门、唯一受影响候选的原 scoped census／配套核对、精确上库与新 SHA 全主 CI／默认完整 Windows。遵守主树共享 main；不创建 branch／worktree／clone，不运行本机 AW tests／typecheck／build／service／E2E，不用已有 CI 总绿或登记数量代签新候选。

## 2026-10-12 实施候选与验证边界

两种 provider 现可显式创建同一 module／persistence／driver binding；SQLite 保持 claim(db) 与 legacyConnection，PG 保持 claimPersisted。旧服务的长驻与四处短 coordinator、人工继续查询／模块 lifetime 去重、取消与 fusion 沿同一绑定转交；配置热读只刷新原旋钮。三个根已补转交槽，但完整 production host 选择与十九 owner 仍另验。原 native 未选择时的默认实例／PG 预装槽和业务错误政策保持。

新增 29 个双 provider 行为登记及一个完整源码 inverse 登记，预期 Ubuntu 59／macOS 30／Windows 30，共 119 次 hosted 执行；这只是源码登记，尚未运行。使用真实 provider 工厂、数据库、Task claim／driver／ACK，范围外的 launch/resource collaborators 在调用时抛错。有限 inverse 保留十一份原完整生产源码的字节与 SHA；原 root/native 用例、断言、预算和负向判据继续保留。只做限定格式／lint、纯字节及语法解析，无本机 AW tests／typecheck／build／服务／E2E。

设计正式回执 `/tmp/aw-rfc370-task-provider-host-design-r2/receipt.json` 为 257033 bytes／SHA256 `089fe63e60c8f3226366e95ea48ba73ffd3c3bf058f40bb97f1e54cefa4e8aa9`，47 项有序 FP `316f72f0a4c6e386db2f530f75ba8fdd9eee97096509a12b8274a2f51fd62a5c`；根消费回执为 20259 bytes／SHA256 `93806caa5250972cd8789c0a3df0b0976a741fe9a2cd2b7e2e68d386ab41a604`。原 R1 INVALID 历史保持。当前不签完整 H7／A-T7／A-G、跨进程接管、CS adapter、M0 部署或 RFC 完成。

## 2026-10-12 SOURCE-R1 与测试修正

独立实现 SOURCE-R1 正式有效、稳定 FAIL，只有新测试的两个 P2：F01 在同一数据库重复 prepare 尚 active 的宿主 installation，P06 因而在模块隔离断言前失败；F02 把较宽的中立 DB 类型传给原要求 DbClient 的 SQLite fusion 工厂，形成夹具类型错误。原生产签名与业务行为保持，不以预期运行时拒绝掩盖类型错误。

R2 修正只调整这两个夹具：P06 复用同一真实宿主票据与 adapter 创建不同 Task module，沿原 controller／idle 等待并补一条原 driver 完成 ACK；P04 的 SQLite 工厂冲突断言只在真实 SQLite applicationBinding 分支消费该分支的 DbClient。两个 provider 的原 coordinator／persistence 冲突判据、全部旧案例／预算及生产全文保持。定向格式／lint和纯语法／字节检查通过，没有运行本机 AW test／typecheck／build／service／E2E。29 个 provider＋1 个 source 登记保持，源码直接 expect 为 103；预期三平台 119 次仍未实际运行。

SOURCE-R1 正式回执 `/tmp/aw-rfc370-task-provider-host-source-r1/receipt.json` 为 475535 bytes／SHA256 `169111947ead513750d4812919c03b3556ad168b203b21c9c5547a2c11df86f1`；70 项实际 EOF 共 7149402 bytes／FP `d040adfdb14cb334b5c305ba249db93174851121cf101a24b6a75526b421b5d1`，7 项直接合同补充另计 152941 bytes。根已实际消费全部功能分析、案例与身份，并独立核对十一份完整原源码／177 片段。根消费回执为 44977 bytes／SHA256 `114af378c6b5c084aed06e9f2294ece77ef1dcc44282d91b8a4b11aa08663bf5`。原 FAIL 保留，不倒写为 PASS。

两份 CLI 的并行累计使用量持久化输出完整保留，已作最小必要发布协调；冻结 Task 候选不代签这些 live 差异、其依赖或合并后的 inverse。R2 独立复核通过后，双方源码真正 READY 才共同收口完整共享根与一次原生成；当前 d8c3a457 的架构摘要 CI 修复不夹带双方源码。共享候选／MATCHING、精确发布与新 SHA 全主 CI／默认完整 Windows另验；完整 H7／十九 owner／三根、A-T7／A-G及 CS M0～M4仍开放，AW未部署CS、RFC未完成。

## 2026-10-12 联合生成阻挡与装配边界修正设计

Task SOURCE-R2、共享 CLI 配对和双方 69 文件的联合 SOURCE 均已独立有效、稳定 PASS，并由根完整消费。以确切 `77033f619e9c6839c6de9f23e791ed81ae99a577` 为其余源码基线的原 scoped census R1 在写出任何架构产物前失败：`public surface opaque type allowlist mismatch`。原失败、启动记录和全部原生成规则完整保留；没有生成成功记录，没有修改共享索引或十三份仓库清单。

使用同一原公开形状解析器的定向静态投影只比较公开类型，未再次调用完整 census。新增的 `$depth-limit` 与 `AbortController` 都来自 `captureTaskDriveBinding`、`composeTaskDriveActivityParticipant`、`TaskDriveBinding` 三个公开符号；它们递归暴露整个 Task module、runtime registry、persistence 与 driver。绑定是 provider 根的装配输入，实际跨模块消费者不需要这份内部对象；`services/task.ts` 已通过原 `taskDriveLegacy` composition 命名空间消费，只有允许装配的 bootstrap `server.ts` 从新增公开转出口读取。

修正仅将上述三个符号及同一新增块里的 `TaskExecutionProviderHostSelection` 留在原 `composition/taskDriveBinding.ts`，由 `server.ts` 直接从该 composition 入口导入。公开 participants 移除这份新增转出口，留下说明装配归属的注释；此前全部公开声明和行为保持。原函数、完整 binding、同一 module／persistence／driver、callback receiver、短入口与人工继续、两个共享 CLI 根及缓存依赖均不改变，不新增 legacy 私有入站边，也不修改公开类型白名单、解析深度、守卫、账本政策或测试预算。

十一份原源码 inverse 仍逐份还原相同完整原字节与 SHA。夹具只调整公开入口和 server 两份的明确新增片段、锚点及准确 UTF-16 位置；保留原十一份人口、全部原 preimage、其余九份变化声明、原 P12 测试全文与断言。新增公开注释属于这份修正，P12 继续对其不相关修改报错，不能把该文件从原结构判据中排除。

本有限修正先独立检视设计，再实施并独立消费 SOURCE 修正回执。原 R1 为一次未完成生成；修正后的 R2 可执行一次完整原生成，真实记录两次尝试、一次未完成与一次成功，不将 R1 倒写成功或声称整个联合发布从未失败。生成后的完整配套 MATCHING、精确共同发布与新 SHA 全主 CI／默认完整 Windows另验。新维护模块在制品及其他未检视源码继续排除；当前四个原生成规则和双方 Windows／两个 CLI 根的冻结内容保持。
