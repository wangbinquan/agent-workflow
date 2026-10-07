# RFC-370 C2-W2-E：具名 effect 准备与原结果落账

本批沿已经批准的 Stage A／H7／C1／C2 推进，先完成一组可以单独验收的 TaskExecution 原 effect 持久合同。C2-W1 修正 SOURCE23-R2 仍在独立复核；其冻结文件不得在门运行时修改。本设计通过且 C2-W1 正式发布后才改这些文件。

## 当前入口事实与边界

先前 58 文件／124 个候选只查了部分事务 helper；它没有覆盖 `withSerializableTaskExecution`，也未纳入 `services/task.ts`。2026-10-08 的另一次纯源码 AST 清单扫描 574 份 TaskExecution／Collaboration TypeScript 和两个 legacy service，找到 102 份有候选的文件；324 mutation-candidate、59 transaction-candidate、78 named-transaction、23 nested-owner-fence 仍包含非 SQL 成员调用、嵌套 helper 与同一业务操作的多笔写，不能当成完成的业务分类或架构 census。原清单、失败回执与候选均保留。

本批只实现 `DrizzleTaskExecutionEffectPersistence` 下列 6 个已有合同。实际根启动／续接、node／wrapper、runtime session、workspace、Collaboration、恢复／终态控制继续按具名操作逐批推进。此处不签整个 C2-W2、十九个 owner、三个根、状态 UI、A-G、CS adapter 或部署。实际外部派发入口及跨 DB→效果的窗口由后续调用者批次验收，不能用本批持久层消费冒充外部派发已接入。

| 原具名合同                 | 本批目的   | 原业务条件／结果                                                                                                                                                                                 |
| -------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| prepareAndAcquire          | new-work   | 精确 owner、claimed intent／epoch、不可变 effect 身份、generation／replay decision、原 attempt 单调序号、资源占用和两笔 CAS；产生一个新 acting attempt，包括按原 retryAuthority 开下一次 attempt |
| settle                     | issued-ACK | 原 owner、effect／attempt／epoch、原 state transition、actual application evidence、receipt 与 aggregate outcome；retry-authorized 是原尝试结果，下一次 prepare 仍是 new-work                    |
| settleGateRollback         | issued-ACK | 已发出的 workspace rollback 结果及同一原子投影；threw 沿原 settle 写 recovery-required，不重新派发 rollback                                                                                      |
| settleCodeHostNode         | issued-ACK | 同一原 code-host effect settlement 与原 node/output 投影，不发下一次网络请求                                                                                                                     |
| settleWorkspacePreparation | issued-ACK | 原已发 workspace preparation 结果与原 Task/repos/space 投影，不启动新物化                                                                                                                        |
| recordProcessSpawn         | issued-ACK | 原 acting attempt／effect／epoch 与真实 spawn 回执，原 nodeRun 的 PID／binary／nonce／params 投影；不以它启动子进程                                                                              |

readLineage、nextOperationGeneration、planCodeHostAttempt、unresolvedEffectIds、unreapedProcessCode 是原读取；保留。原 exact-stop 清算仍走已实施 C2-W1；successor-daemon／其他 recovery 及 actor replay 控制不在本批新增消费，继续明确待验。不能给整个 withTaskExecutionSerializable／withTaskExecutionWrite 或整个 effect 模块统一套 ACK。

## 独立 Task binding 与原事务

继续使用当前 Task 自有 `hostWrites` constructor 选择，沿原 createTaskExecutionPersistence 装配；不引入 CS DTO、SO 内部类、provider 名分派或跨 owner DB callback。application 的 effect 输入／输出合同不改，也不新增 npm 包。适配实现仍在 Task infrastructure，既有 native 功能完整保留。

每次调用在首个持久 await 前从输入的原 OwnershipToken 取 C2-W1 TaskHostAdmittedWork，并保存其原 capture／所选 binding。没有选择 hostWrites 且没有关联 work 时，逐字执行原 withTaskExecutionSerializable(db, originalBody)；native 模式碰到 selected work 或 selected 装配缺 binding／原 token work 属于完整装配错误，明确拒绝，不补 native。已经选定的 work 不能在 await 后以当前 Task id、当前 grant 或当前绑定重新构造。

准备方法使用明确具名的 new preparation 事务；五个结果方法使用明确具名的 issued receipt 事务。它们分别委托 C1 `withTaskHostNewWork`／`withTaskHostIssuedAck`，isolation 保持原 serializable，body 仍是完整原 SQL／CAS／返回值。原业务体完成后在同一事务、COMMIT 前消费同一 capture；original body 抛错时保留原异常，host 消费拒绝时整笔原业务 SQL 回滚。invalid input／不可变身份／owner／intent／retryAuthority／唯一占用冲突的原优先级和错误码不变。原私有 settleTx、投影原语和自动序列化重试不改。

本批不 acquire 新 admission，也不 complete 原 work；它们属于原 driver／failed-claim 寿命。draining／失权后只允许该原 work 的真实结果 ACK，prepare 新 attempt 必须拒绝并回滚。即使旧 receipt ACK 写入 retry-authorized，也不能通过 ACK 入口再 prepare／dispatch；新准备继续消费 new-work。方法成功只表示其原事务真实 ACK，未知结果仍由原调用者和 C2-W1 收尾机制保留，不伪造完成。

## 回归与验收

使用真实双 provider、C2-W1 原 selected Task fixture、原 claim／token 和实际 effect 行。逐个验证上述五个 ACK 合同在 draining 下成功且原 attempt／node／Task/repos/space 投影保持；验证 prepare 成功形状与原资源字段，host 在原 SQL body 之后失权导致全部 SQL／owner revision／replay decision 回滚且调用者没有取得 dispatch 准备结果。原 attempt retry-authorized 落账可用，而失权下后继 attempt 不得产生。

覆盖 selected 缺原 work、native 原无 work、原业务错误与 host unavailable 交错、原方法输入／返回／错误及 original work 不被完成。effect ID／attempt ID／resource keys／generation／nonce 等断言来自真实持久事实，不以 fake rows 冒充双 provider。既有全部 effect／driver／recovery 案例和原预算保持；新增独立套件明确自己的预算并进入原 CI／Windows 触发范围。

先独立功能设计门并由 root 实际消费，再候选实现与独立 SOURCE 门；然后一次原 scoped census、配套 matching／元数据门、精确路径发布和 exact-SHA hosted CI。只有这些各自通过才记本批完成。其余 C2-W2／Stage A 与 M0～M4 继续，不因此改变“Stage A 验收后、M0 先部署、后续能力逐步接入”的已批准顺序。

## 本批实施候选

C2-W1 已实际发布 290f4d26a26385818edc4ed227c37dab92ad3991 后开始这六个方法的实现；原 DESIGN1-R1 稳定有限 PASS 已由 root 消费。三个私有 helper 同步保存原 token 的 work/capture/binding，唯一新准备走 new-work，五个原结果走 issued-ACK。原六个 serializable callback、全部其余方法、private settleTx/SQL/CAS/返回和错误优先级保持；没有 acquire/complete 或下一次 dispatch。独立真实双 provider 套件及 Windows 配对注册随本批提交。此前全体原回归保持；本机无 AW tests/typecheck/build/service/E2E。源码门、一次原静态生成/配套门、精确发布和 hosted CI 分别验收，完整 H7/A-G/CS 部署仍开放。

## W2-E SOURCE4 与精确 Task CI 修复配套

W2-E SOURCE4-R1 正式稳定有限 PASS 已实际消费，49项/三个包装全部 EOF，FP `5d97f4d413623d5cc193b89f20212c05e634dc380af4a7091609559b28851efd`，6个方法完整原 callback/SQL/业务条件/错误顺序保持，仅区分新 effect 准备与已发出 effect 回执；14个真实双 provider 用例及原完整回归交 hosted CI。CI SOURCE7-R2 正式稳定有限 PASS 已实际消费，37项/三个包装 EOF，FP `b40721deba7015b9bec6c65d7a978ddf8673ad43aaeeb6b7eda190b921cc1809`；两 production 与三真实测试完整 runtime 逆向保持，只补原类型、原 factory 装配与 PG schema recorder 匹配。R2 design 原 .db 断言问题为实际 FAIL，R3 按原独立 .db 读取修正 PASS；旧失败保留。两原真实 PG COMMIT/ROLLBACK Driver completion probes 按原明确分类登记，68旧库存/全部 classifier/断言/预算保持，70新实测人口，没有 canned成功SQL行或新增镜像测试。

原 W2-E census 基于完整 committed290f 与冻结1 production/1 test，只运行一次，四原规则完整保持，13原输出全部私有保留，原 sourceDigest `sha256:dc8b8be7d484d9b225785d156c4877ed403f812194ae151ed116180b06d86070`，16条 effect Task写入记录只移动实际源码行（+7/+36），全部字段/人口保持。并行 e28aafe910e6a2d2c866be77b8c2b9bbb57fee1b exact16已上库，实际 SOURCE3和matching13 PASS/23+68原EOF及16 committed/live绑定已由根核验，9旧已消费许可已普通退役。以这批已发布完整源和两项实际 CI production 差额，使用完整原 helper与原九aggregate表达式做3文件有限投影，先完整逆向复现原8 canonical对象；不重复 census或buildCanonicalArtifacts。最终 sourceDigest `sha256:9ec5258c2f09c3c3b2a9e03c4c5c7911f5722cd0e65adae13a2ad46fa9c5e649`。13 matching 保留全部旧 authored debts/129有序库存及并行内容，仅 W5 已漏记原探针人口68→70与说明一项实际许可，普通后继退役；所有失败/私有工具错误保留。

290f4d26精确主CI37683909758已终态failure，Windows37683909763终态cancelled，均不记通过。新精确SHA hosted CI另外验收；有限源码/匹配门与format/lint/纯AST字节JSON不能替代整仓CI。本机无AW tests/typecheck/build/services/E2E。H7其余Task/Node写入、恢复、19 capability owners与三个执行roots、A-T7/A-G仍未完成；runtime lease设计PASS与私有source/14-case草稿不算已实施。本片实际发布后继续runtime lease。AW尚未部署到CS；M0先完成首次实际部署，再逐项M1～M4，RFC仍阶段A。
