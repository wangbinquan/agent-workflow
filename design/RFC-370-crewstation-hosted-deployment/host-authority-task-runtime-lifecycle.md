# RFC-370 C2-W2-L：Task 运行状态的开始与原工作结果

继续已批准的阶段 A/H7。动态状态 SOURCE9-R2、MATCHING16-R1 已实际消费并精确发布 `331f30aaf75500487b38910da08df946648664e9`，原测试配套与 Windows 接线随后精确发布。后继 `0c63e52d3d36c3abce4f799c245c45bd4f52a3a6` 的主流水线 72/72 与完整 Windows 均为成功终态；原动态八 TS 内容不变，Ubuntu 53／macOS 27／Windows 27 共107个实际用例及全部73个作业元数据已完整核对。L 的修正设计门 R2 有效稳定 PASS 已消费，原37项输入在编码前再次逐项核对不变。本文件记录该平台中立切面的实施候选；新源码门、配套及 hosted CI 另验，H7、A-T7、A-G 与 CS 部署保持开放。

## 1. 原生产事实与 21 个调用点

`application/ports/taskRuntimeLifecyclePersistence.ts` 只有 `trySet`，输入保留 `taskId/to/allowedFrom/allowTerminal/extra/executionContext/now/reason`。原 `DrizzleTaskRuntimeLifecyclePersistence` 先加载 Task，处理终态、复活、来源结束和工作区存在性，再在原写事务中按原 Task owner 条件、私有 guard、共享生命周期序列进行 CAS 和 committed event；事务返回后发布事件。`ConflictError`、`NotFoundError` 返回 `false`，其它原错误继续抛出。复活时发现已丢工作区还有独立的 tombstone 事务，成功后抛原 `workspace-pruned` 410；它不能遗漏宿主写入目的。

11 个调用者文件的纯 AST 清单有 21 个实际 `trySet/trySetWithGuard` 调用表达式，不等于 21 个全部已改完的操作。原 Task 状态和调用目的必须分开：`failed` 可以来自已附着工作的结果，也可以来自人工控制；开始 `running` 是允许引擎继续派发的准备。分类使用下面的具名入口与真实原受理上下文，不按状态字符串自动推断。

| ID     | 原位置／具名入口                                                                        | 本批目的及事实                                                                                                                                                                                                              |
| ------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L01    | `composition/taskEngineApplication.ts`，`runTask-start`                                 | `preparation`：原从 pending 到 running 的 CAS，成功后才进入 manual park、Node 和 scope 运行；没有新工作准入就不能借状态写入继续派发。                                                                                       |
| L02    | 同文件，`failRuntimeTask`                                                               | `issuedResults`：原已认领 Task 的驱动结果。前置资源、工作区或快照失败也属于已附着 Task 的结果，不声称已经启动 Agent。原错误与失败日志保持。                                                                                 |
| L03    | 同文件，`cancelTaskRow-shutdown`                                                        | `issuedResults`：原 driver 观察到实际 shutdown abort 后提交 interrupted，保持原原因、时钟与 review mutation lock。不是“失去宿主执行权便批量 interrupted”。                                                                  |
| L04    | 同文件，`cancelTaskRow`                                                                 | `issuedResults`：原 driver 观察到实际用户／父任务／webhook 停止后提交 canceled，保持全部结构化原因与 winner 处理。                                                                                                          |
| L05    | 同文件，`scope-awaiting-human`                                                          | `issuedResults`：原 scope 已得到 awaiting_human；保持原 CAS 与已经原子停靠时的查询／日志。                                                                                                                                  |
| L06    | `cli/postgresqlDaemonApplication.ts`，原 `failureReporter.report`                       | `issuedResults`：只由原 coordinator 的 attached execution 回报，保持原 intent 终态化顺序。                                                                                                                                  |
| L07–08 | `cli/start.ts`，两处原 `failureReporter.report`                                         | 同 L06；两个真实构造点分别接线，不能只改一个 bootstrap。                                                                                                                                                                    |
| L09–11 | `server.ts`，三处原 `failureReporter.report`                                            | 同 L06；三个真实构造点分别接线，不能用一个报告 helper 代替全文件覆盖。                                                                                                                                                      |
| L12    | `infrastructure/childTaskLifecycleParticipant.ts`，resume 的原 `failureReporter.report` | `issuedResults`：原 resume coordinator 已 attached，保存它传入的 execution。                                                                                                                                                |
| L13    | 同文件，`markUnsafeResume`                                                              | `issuedResults`：仅从 `rollbackForResume/reapRun` 到达，而唯一 rollback 调用在原 coordinator 的 `admittedContinuation.run(context)` 内，显式传原 `context.execution`。保留先状态、后恢复记录、最后原 ConflictError 的顺序。 |
| L14    | `infrastructure/postgresqlFusionEngineTaskOperations.ts`，原 `failureReporter.report`   | `issuedResults`：原已附着的 fusion Task 结果，不替换该任务 owner 或 intent。                                                                                                                                                |
| L15    | `infrastructure/childExecutionLaunchOperations.ts`，原 `failureReporter.report`         | `issuedResults`：原已附着的 child Task 结果，保留原发生时钟和 claimedOwnerEpoch。                                                                                                                                           |
| L16    | `humanGateTaskLifecyclePersistence.ts`，私有 `trySetWithGuard`                          | 本批不选择：此公共 human-gate 方法同时服务释放到 running 与停靠／done，须连同 park、manual obligation、decision 和原事务参与者另行逐操作分类。不能将所有 guard 调用统一算 ACK。                                             |
| L17–18 | `composition/taskExecutionPersistence.ts`，boot orphan／periodic interrupt              | 本批不选择：必须使用原 preparing recovery 事实，不能凭 active Task 工作或新 grant 伪装旧恢复。                                                                                                                              |
| L19    | `taskRouteOperations.ts`，`escalateUnsafeContinuation`                                  | 本批不选择：原人工 retry 控制面的拒绝记录，没有上述已 attached execution。                                                                                                                                                  |
| L20    | 同文件，`retry-child-cancel-failed`                                                     | 本批不选择：原控制命令中的 child cancel 结果，原 Task 此时 interrupted；它要保留该控制命令和 child receipt 的真实边界。                                                                                                     |
| L21    | `taskRouteRepairOperations.ts`，`setTask`                                               | 本批不选择：原人工修复控制面。不能因宿主停止新执行而关闭资源诊断／修复，也不能借它自动重新派发。                                                                                                                            |

`DefaultTaskDriveCoordinator.reportFailure` 在 attach 成功后才拿原 attachment execution 调报告，包括 runtime 配置解析、admitted continuation、gate pre-drive 与 drive 失败。未 attached 直接返回，不调用这些 reporter。这是 L06–L15 的原受理依据；L13 的五个 helper 分支仍只是同一个原具名写操作。engine 的直接无主旧 fixture 沿 native 完整入口保留；selected 必须持有原 Task 工作，不给 ownerless fixture 编造 capture。

## 2. 各层独立落位

- Task application 在现聚合合同增加可选的 `runtimeLifecycleWriteMode: 'host-selected'` 和 `runtimeLifecycleWritePurposes`；两个中立视图只有现 `trySet` 合同：`preparation`、`issuedResults`，不增加 SQL callback、provider client、宿主 DTO 或调用方任意字符串。
- 新 `application/taskRuntimeLifecycleWriteSelection.ts` 明确选择。两个可选字段都未选择时，返回原 `runtimeLifecycle` 实例；已经选择但缺少所需视图明确拒绝 `task-runtime-lifecycle-write-purposes-not-composed`，不回退 native。
- 独立 `infrastructure/taskHostRuntimeLifecycleWritePurposes.ts` 保存原 Drizzle lifecycle 实例、具名方法和 receiver，提供两个只写视图。Task composition 仅在原 `hostWrites` 明确注入时装配；原 `createTaskRuntimeLifecyclePersistence` 和无参数 aggregate 路径保持，human gate／recovery／人工控制继续使用原 native 实例，直到其自己的设计与接线完成。
- 原 Drizzle adapter 增加 provider-private 的 selected 具名调用入口。它在首个 load／工作区 await 前捕获同一原 Task work、context、receipt 和 binding，保留原持久化方法 receiver。selected 输入显式携带保存的原 executionContext，其余输入值按调用时保存；native `trySet` 与 `trySetWithGuard` 的原返回／错误处理完整保持。
- 该入口将同一原 work 交给原两处实际写事务；主 CAS／event 和 revival tombstone 各用明确的 `withTaskHostNewWork` 或 `withTaskHostIssuedAck`。原 SQL／Task owner 条件／guard 先执行，实际业务成功后在该真实事务消费原 receipt。PG 消费的必须是实际 transaction，不能把 root client 当作 transaction；原 async context贯穿读取、等待和写入，不在 await 后重新选当前 grant。
- L01–L15 在原调用点选择具名视图，所有原输入表达式、次数、时钟、reason、allowedFrom、allowTerminal、error 与后续行为保持。三份 bootstrap 经 Task 的 `public/participants.ts` 选择中立视图，不加入 SO/CS 的业务判断；模块内调用者使用同一 application selector。

## 3. 原事务、错误和事件边界

主状态 CAS 的原 `changed === null` 在事务内抛原 `ConcurrentTaskTransition`，因此不会消费 host，外层仍按原 ConflictError 返回 `false`。Task 不存在、前置终态／from 冲突、原工作区或 owner 拒绝保持原类型与顺序。不能把 `false` 当成成功 ACK 后再尝试第二次状态覆盖。

revival 的原工作区缺失事务原本在事务返回后检查 `changed.length === 0`。selected 仅为保持同一原 CAS 拒绝优先于 host 消费，在该原 body 内对同一返回数组的零行结果抛同一 `ConcurrentTaskTransition`；不增加查询、不修改 SQL 条件、不追加第二次验证。native 原 body 与事务后检查保持。真正成功的 tombstone 和对应 host 消费在同一原事务提交，之后继续抛原 410；host 拒绝则两者都回滚。没有成功 tombstone，不消费 receipt。

original committed event 的追加仍在主 Task 事务；`publishCommittedEventsAfterCommit` 仍在该实际事务成功返回之后。不能从外面将整个 native `trySet` 包进另一个 host 事务，让原“提交后发布”跑在外层 COMMIT 前。主 SQL／guard／事件追加／host 消费任一失败，原状态、计时、revision 与 event 同事务回滚；原工作结果可按同一原 work 重试，成功前不能虚报完成。原 pump 的 `publishNow` 提交后拒绝由该 helper 捕获、记录 warning 并保留 durable delivery retry，helper 仍返回 `true`，原 `trySet` 继续成功；pump 缺席的原返回值与 lifecycle 的原处理也保持。不得把已提交状态误报失败或要求 publisher 错误继续抛出。

draining 允许原已附着工作的 issuedResults；L01 的新 running 准备仍按原 active 新工作口拒绝。原失败／shutdown／cancel／human 结果不能为了回报而申请新 Task work。ordinary shutdown/cancel 与 host authority loss 分开，失权本身不新增取消或状态终态写。新的 Node／scope continuation 仍沿各自 preparation 口，不因这次结果写成功自动放行。

## 4. 原行为回归与功能验收

使用现 eachProvider 和 taskHostExecution fixture 的真实 SQLite／PG Task、owner、host row、生命周期事件和 actual transaction。必须覆盖：

1. 未选择返回原实例、完整 native trySet／guard 行为；两个 distinct frozen selected 视图；已选择缺项明确拒绝；capture 缺失拒绝。
2. 真正 pending→running preparation 成功；首个 DB await 或 workspace await 期间 loss 后新准备失败并回滚；原 admitted work 和 context／receiver在等待后保持。
3. 原 failed／interrupted／canceled／awaiting_human 结果在 active 与 draining 下真正提交；原 finishedAt、error、runningMs、lifecycleEventRevision 与 committed event 对齐。保留原 owner fence 一次 `revision +1` 与 `updatedAt` 原时钟更新，不新增 owner 更新；原 lease/source fence 字段语义保持，失败时原事务增量一并回滚。
4. missing Task、from 冲突、原 owner 冲突、guard reject、主 CAS 零行和 SQL／event 失败保留原布尔／错误；host 拒绝时主 Task/event 全回滚，同一原 receipt 真正重试成功。
5. 真实 revival 工作区等待、tombstone 成功后原 410、零行优先与 host 拒绝回滚；原 workspace source 行及其它 Task 不改变。
6. 真正 COMMIT 后才 publish，host await 未返回时实际事务仍活跃、原操作未成功返回且事件未发布；提交后 publisher 拒绝保留原 catch/log/durable-retry 与 `trySet` 成功结果，已提交状态／事件保持。PG actual transaction 与 root 不混淆；不运行模拟 typechecker。此有限回归不代签独立连接的提交可见性或三个启动根的完整验收。
7. 原 engine 的开始、失败、shutdown／用户取消及 awaiting_human 通过真正 SQL 与 selector；9 个 reporter 的真实 coordinator 只在 attached 后回报，not-attached 不回报；resume 的原 unsafe 分支保持 recordEvent 与原 ConflictError。
8. 双向源码/AST 锁住 21 原调用点、15 个显式选择及剩余6原调用，整文件移除这15处选择与 import 后恢复原全文；现 RFC-202 abort 源码断言只随新的明确 selector 形状调整，所有原因／checkpoint 判据保持。原 transition-table oracle 按方法名 `trySet` 识别 property access，nested selector不改变其原语料与判据。

设计门与前置 `0c63e52d` 的主／完整 Windows 总 CI 已通过，L 源码及回归现为未发布候选；并行后继提交的 CI、源码门、唯一原 scoped census 与配套门、精确提交／远端同步和本片新 SHA 主／Windows 总 CI 与实际 case消费分别验收。每次新候选只运行其一次原 census，排除全部并行在制输入；不为无关 HEAD 移动重跑。Windows 在源测试存在 main 后登记实际路径、原 bun 命令和两个过滤器，保持已有运行预算。

## 5. 本片边界和下一步

本片候选为 L01–L15 的 runtime lifecycle 切面，14个生产路径、原 RFC-202 配套和新双 provider 回归／21调用的冻结 fixture，尚未通过源码门或发布验收。回归使用原真实 Task／owner／host／event 事务，并从三个完整 bootstrap 及其它原调用者的当前 AST 提取九个原 reporter 方法体，逐一交真实 coordinator／driver lifecycle 执行，避免启动完整服务；原 engine 私有方法及两个具名状态表达式同样以原源码执行。全文件逆向核对和所有原输入是独立判据，不用这些有限入口代签整条启动根。L16–L21 连同原 human-gate、多表控制／续接、早期恢复继续。此前 dynamic state、Node 与 runtime lease 的有限通过只复用其对应内容，不代签这些状态操作或真实三个 roots 的完整执行权。

H7 所有 19 owner、三个实际启动根、Task 所有具名写入／效果、提前恢复与状态 UI、A-T7／A-G 仍需完成。随后才编写各 owner 内独立 CS adapter；按 M0 必须能力先完成真实可用部署，再 M1～M4 逐项接入。AW 尚未部署 CS；RFC 保持 In Progress。

## 6. 独立首轮检视与修正

DESIGN1-R1 对 33 项（1 owned/31 control/1 evidence）、三个包装及完整 21 调用/15 选择/6 待接入口做首末 EOF 绑定，有限结果为有效稳定 FAIL；114378-byte 回执 sha256:6a631122a977db5e78831e12f6b08b352f2cbf625cb1f86de5554d41468b1433 已实际完整消费，原回执保留。两项 P2 分别要求保留原 publisher 吞错/耐久重投/成功返回和原 fence 的一次 revision 增量。本修正文档仅对齐这些原功能合同，并明确实施未开始及总绿门槛；原调用表、分类、独立切面、事务和其它回归要求保持。修正后 DESIGN1-R2 另验，不用未来实现或 CI 代签设计通过。

## 7. 2026-10-10 源码候选与原调用核对

DESIGN1-R2 的 37 项及三个包装已独立有效稳定 PASS、零 findings，完整功能分析、21 个调用及全部 EOF 回执已实际消费。14 个生产路径、原 RFC-202 源码锁、新回归和冻结原调用 fixture 现为 SOURCE 候选。原 21 个输入逐表达式一致，15 处选择为 1 preparation／14 issuedResults，另外 6 处原 callee 保持；移除新增 selector、import 和两项 composition 字段后，11 个调用文件的全部 bytes／SHA256 与冻结原文相等。私有 R1 逆变换因移除属性时留下一个空行而失败，修正完整行边界后的 R2 原文核对通过；失败及诊断保留，没有修改原调用或判据去配合校验。

回归覆盖实际双 provider SQL／Task owner／event 事务、同一原工作重试、真实 native claim 缺少 admitted work、首个原 Task 读取及工作区等待前保存输入／context、draining 结果、tombstone 与零行边界、提交后事件泵失败保留成功，以及九个原 reporter 的实际 attached／not-attached coordinator 和原 engine／unsafe resume 方法。host 等待用例验证真实事务仍活跃、操作仍 pending 与事件尚未发布，不声称已通过独立连接可见性或整个 bootstrap 的验收。新测试尚未执行，SOURCE／一次原 scoped census／配套门和新 SHA hosted 总 CI 继续分别验收；无本机 AW tests、typecheck、build、services、E2E 或新 census。并行 e801e54e 的观测发布没有修改本片生产内容，不因无关 HEAD 前进重跑已经通过的动态状态 census 或门。

## 8. SOURCE18-R1 功能失败与三个测试修正

首轮源码门实际读取 64 项（18 owned／43 control／3 evidence）、三个包装，first／closing／last 均稳定为 2,116,041 bytes、FP `343d2349b117eeafc4750c546b6df1aca9d8bf1b36ddb2ed33d6ed14eb838cf7`。独立结果为有效稳定 FAIL，三个 P2 全在新回归测试；293,690-byte 回执 sha256:`6ab7be37b8ca9fee0dd65a35cd3f886152def9053a4d24d88c1536c2a93e9954` 的完整功能分析、18项结论、21原参数、11全文逆向、5原 native／旧锁逆向及52/provider＋1 global标题／预算已经实际消费。根会话再次逐项比较全部64正文、三个包装与三轮实际 EOF／hash，保存首轮18 owned整份失败正文后才修改候选；稳定绑定不是功能通过。

1. `L-SOURCE-P2-001`：工作区等待期间的第二个 Task 改用原 `additionalTaskHostFixture`，复用第一个真实 installation／module／admission，真实 claim 另一个 Task 并从原 token／work 构造它的 execution context。分别读取两 Task 的真实行与 owner，保留原输入修改、跨 context 释放等待和不改变第二个 Task 的断言；不重复 prepare 尚 active 的 installation。
2. `L-SOURCE-P2-002`：删除 binding 内无条件要求 `tx !== db` 的错误断言，保留实际 active frame、原 receiver和原 `transactionFor` 委托。原同事务成功用例按 `harness.capabilities.isolation` 验证真实身份：exclusive 复用原 client，read-committed 使用独立 actual transaction；数据库、事务实现与原回滚要求保持。
3. `L-SOURCE-P2-003`：`publishNow` 回调只保存实际 refs、frame 活跃状态、真实 Task／event 读取和 intentional rejection 已到达的标记。所有关键断言在 `await pending` 后、原 publisher catch 外严格执行；保留原 intentional publisher rejection、warning／durable retry及成功返回，避免断言异常被当作正常发布失败吞掉。

14个生产文件及原 RFC-202／21调用 fixture 内容保持首轮值；测试修正不增删用例或改变名称／预算，仍须在 hosted CI 真正验收 Ubuntu105／macOS53／完整Windows53，共211个展开用例。源码 R2 另验，原 scoped census 尚未执行。并行 `e801e54e` 的类型、前端与键盘交互 CI 失败分别保留原日志；其所有者已发布后继 `4cb2acc5`，新主流水线仍待完成，不能复用前置绿或 Windows 单独成功来代签总绿。
