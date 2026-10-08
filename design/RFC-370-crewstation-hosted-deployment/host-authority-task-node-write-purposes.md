# RFC-370 C2-W2-N：Node 写入目的与独立原生适配

本批继续已批准的 Stage A/H7。W2-P 在 2675701af71c7905ab75dce1a41e8cefe1c34393 发布，d5cc90f4 补 Windows 接线并退役已消费 growth，39393abbdd0d9d9d33efbf8dd5bdab39bc926245 修复两个实际 TypeScript matcher 错误。该最终 SHA 的 main 37834573995 全部 72 作业成功、Windows 37834574026 成功；原新用例在 Ubuntu SQLite/PostgreSQL 各 21 例、macOS/Windows SQLite 各 21 例通过，Typecheck 和 Static scans 通过。总绿门槛已按实际完整 API 和功能日志消费；旧失败记录保留。本批先设计 Node 的独立目的端口与 adapter，再接真实调用者；工厂支持不代表实际启动根闭合。

## 已核对的入口

六个现有源文件的有限 AST 清单共有 85 个记录，其中 3 个只是 nodeMechanics 的 setRunStatus/transitionRunStatus/mintRun 转发定义，2 个属于 W2-P 已处理的 profile/clearReuseDisabled。余下 80 个为这一组源文件中的 Node 调用点：14 patch、28 set、9 transition、11 mint、9 appendEvent、3 appendEvents、1 retagSessionEpochs、5 upsertOutputs。这是有限调用清单，不能代表整个 TaskExecution/Collaboration 的完整操作人口；同一业务操作可包含多笔写。

| 原业务动作                                                                                              | 写入目的与边界                                                                          |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 初始 injected memories、prompt、mark-running、后继 retry mint/事件                                      | 下一次执行的准备，new-work；已有 runtime 选型与冻结同属准备。                           |
| runtime-session-reset 事件后准备新会话                                                                  | new-work；它发生在新会话派发之前，不能因为方法叫 appendEvent 就视作结果。               |
| 已收到 stdout/stderr、span/usage observation、实际 runtime inventory、epoch 收编、声明输出、runner 终态 | 原已受理工作的 issued-ACK；同一原 token/work/capture 贯穿落账。                         |
| wrapper 新 generation、fanout retry/aggregator、call-workflow child 启动绑定                            | 新一代工作准备，new-work；mint 的 born-done/failed 状态本身不能使新行成为旧工作的 ACK。 |
| wrapper 进度、已消费上游记录、child 完成后的输出或失败清理                                              | 按真实动作分别记录结果；不能将 wrapperMechanics 的 patch 方法整体套 ACK。               |
| isolation pendingSubResolves 的失败/实际解决回执                                                        | 需由原 isolation 调用顺序分别确定；不以同一 patch 字段推断全部用途。                    |

runNode 的早期 injectedMemoriesJson 和末尾同列 runtime 事实属于不同目的；call-workflow 的 childTaskId 设置与失败后的清空也不能合并为同一个目的。后续调用者批次为每个入口保存原参数、条件与对应回归，并做源码到清单/清单到源码双向核对。资源控制、人工回答、boot/recovery 与三个启动根仍按各自原合同另行接入。

## Task 内部端口与 adapter

保留原 NodeExecutionPersistence 和 NodeRunLifecyclePersistence 的完整方法及 native 两 provider 实现。新增 application/ports/taskNodeWritePurposes.ts 的 TaskNodeWritePurposes 内部端口，提供 preparation 与 issuedResults 两组明确依赖。两组各有 nodeRuns 和 nodeExecution；preparation.nodeRuns 使用原完整生命周期端口，issuedResults.nodeRuns 使用 Omit<NodeRunLifecyclePersistence, 'mint'>，实际对象也不提供 mint。两组 nodeExecution 保留原完整读写方法，不复制原输入或输出类型。原纯读仍可沿同一个原实例调用。

两个目的视图不是公共平台 API，不携带 CS DTO、SO 内部类或 provider 名称。独立 infrastructure/taskHostNodeWritePurposes.ts 的 createSelectedTaskNodeWritePurposes 保存同一 db、binding、两个完整 native persistence 实例及原 method ref/receiver。原 TaskExecutionPersistence 增加可选 nodeWritePurposes；createTaskExecutionPersistence 只在显式 hostWrites 下创建该成员，两个 native Node 实例各创建一次，并同时保留在原 nodeRuns/nodeExecution 成员中。未选择 hostWrites 时不增加该成员，原默认 native 方法和原恢复管理面保持；N1 不把未分类的原 aggregate 成员暗换成某个目的。后续 N2 按实际 caller 明确选择依赖，selected caller 缺所需视图时不得补 native。工厂支持与真实调用者选择分开验收，其余未分类入口仍开放。

每个非空写在首个 await 前同步保存原完整 TaskExecutionContext、OwnershipToken 关联的 TaskHostAdmittedWork、capture 和 binding。复用 W2-P 的 captureTaskHostExecutionWrite；所有带 executionContext 的原输入继续显式 context 优先，取同一个完整原对象。没有显式输入时才用原 ambient，不通过 node 查询后再重建原工作。原输入、回调、对象身份、now、返回值和异常保持，缺所选完整工作时明确报装配错误，不补 native，也不 acquire/complete admission。

preparation 视图通过 withTaskHostNewWork，issuedResults 通过 withTaskHostIssuedAck；在原 write 隔离下调用保存的原方法和 receiver，通过 runWithTaskExecutionContext 恢复原完整对象。outer write 与原 native inner write 共享同一 DatabaseSession frame、owner fence、aggregate lock、完整 SQL 及一次 COMMIT。先运行原业务体，再消费同一 capture；原业务异常保持优先，host 消费失败则整笔原 SQL 回滚。draining 下可记录原工作真实结果，不能准备下一次 node/generation。transition/set 的合法状态、source-terminal 条件、mint participant 和所有原错误由原实现决定，adapter 不再写一套状态机。

纯 read/list/listOutputs/countAgentTextEvents/readStderr/loadEnvelopeNonce 不增加 Task admission、host 消费或事务。upsertOutputs 的空 outputs、appendEvents 的 events 与 observations 同时为空、retagSessionEpochs 的空 supersededSessionIds 保留原早返回，调用原方法，不捕获工作或增加事务。只有 observations 的 appendEvents 仍写数据库，必须按所选目的消费。replaceOutputs 的空 outputs 仍删除旧输出，不能改成零写入；patch 也不增加空 values 早返回。appendEvent 必须调用保存的原 native appendEvent，保留它以原 receiver 调用 native appendEvents 的关系，不递归穿过所选视图或消费两次。其余完整写调用仍按所选目的记账，不额外查询行是否存在，也不根据 false/undefined 猜测用途；原 missing/no-op 返回值原样保留，原 NotFound/状态/归属异常在 host 消费前重抛。

## 实施与回归

N1 的源码范围为新 taskNodeWritePurposes.ts、taskHostNodeWritePurposes.ts，现有 application/ports/taskExecutionPersistence.ts、composition/taskExecutionPersistence.ts，以及新 tests/rfc370-task-host-node-write-purposes.test.ts。先实现目的视图端口、独立 infrastructure adapter 与 composition 显式选择，新增真实双 provider 回归。N1 不改上述六个真实调用者，不声称它们已经接入。N2 在 N1 发布并取得 hosted 功能证据后，按这份目的表补齐真实 caller 依赖：每个原调用只能选明确 preparation 或 issuedResults；转发 helper 由调用者明确传入用途，不能按方法名、状态字符串或字段值自动猜测。原控制面/recovery 不借 ACK 发新工作。N2 单独设计并核对完整入口清单、实际依赖传递及回归，再实施。

N1 使用真实共享 installation、两个真实 Task 和原 claim/token/work，覆盖两组完整原方法/receiver/参数/返回；new-work 在 draining 后拒绝，issued-ACK 在 draining 下成功；host 消费失败时 node 行、outputs/events/observation 与 owner revision 同笔回滚，可用同一原 work 重试。mint 的 initial outputs 与 node 行必须原子提交；transition/set 的原错误优先级及 source-terminal 条件保持。覆盖显式 context 无 ALS、另一 Task ambient 交错、跨 await 原方法与完整 context/token 不变、纯读和三个真正空输入零额外事务、observation-only 非空、replaceOutputs([]) 真实删除、appendEvent 恰好一次 host 消费、原缺失节点的 false/no-op/NotFound 行为。既有所有 native/provider 案例、断言和预算保留，不以 fake SQL 或假行代替数据库事实。

先独立有限功能设计门并由 root 实际消费，再实现门；新 source candidate 只做一次原 scoped census，配套门、精确发布、Windows 新测试先上 main 后登记、新 SHA 主/Windows CI 分别验收。本机不运行 AW tests/typecheck/build/services/E2E。完整 H7、十九 capability owners、三个启动根、A-T7/A-G 与 CS M0～M4 均保持开放；完整阶段 A 验收后按各层独立 CS adapter 实施，M0 先真实部署，再逐步接入后续能力。

## N1 源码候选与实际验收边界

DESIGN4-R1 的 39 项（4 owned/25 control/10 evidence）独立功能门有效稳定 PASS、0 findings；root 已完整消费首末实际 EOF 绑定与全部 14 个功能分析字段，FP e61a63564d81db18eeab33e256db1e4e737db4621f228ab31991d7f5a0f42418。原正式回执 483758 bytes、SHA256 e02ac76d2878771574e564208735a0bb8739ca33a2a4125a0288212ba641b421 保留。期间 main 正常推进至 1c624ba2，仅 RFC-371 验收文档变化，原 39 项候选字节全部保持，不重跑同一门。

五个源码候选已落位：TaskNodeWritePurposes 使用原完整 15/14 方法合同；独立 adapter 保存同一完整 native 两实例及全部原方法和 receiver，以显式 preparation/issuedResults 选择同原 write frame。原 aggregate 可选成员只在 hostWrites 下创建，原完整 nodeRuns/nodeExecution 及默认 native/恢复正文保持；两个既有文件按精确逆向可重建全部原 bytes。六个实际 caller 和所有其余 native/provider 回归字节保持，N2 未实施。

新增真实双 provider 套件有 15 个定义，按 2×(8×2+4)+9 展开为每 provider 49 个案例；162 个静态 expect 调用。覆盖八种原写两目的的真实行/owner revision/COMMIT、消费失败回滚和同工作重试、完整方法/input/receiver、各写原显式 context 在无 ALS/另一个真实 Task ambient 下优先、跨 await、原业务错误对象/状态/缺行、mint 初始输出同笔、draining、六读/三空早返回、observation-only、replace[] 删除及 appendEvent 单消费。仅三个新增多操作案例使用显式 15_000 预算，未改任何旧案例/断言/预算。这里只记录源码和纯 AST 展开，尚未运行这些案例。

目标格式/ESLint/纯 syntax AST/整文件逆向和字节保持分别记录；本机未运行 AW tests/typecheck/build/services/E2E，尚未做新 census。SOURCE9 独立功能门、一次原 scoped census、matching 门、精确上库、普通 growth 退役与发布后 Windows 新测试登记、新 SHA hosted main/Windows 仍须逐项验收；本节不将设计 PASS 或静态证据换算为实现运行成功。完整 H7/A-T7/A-G、十九 owners/三 roots、CS M0～M4 继续开放。

## N1 SOURCE9-R1 功能失败与最小夹具修正

独立 SOURCE9-R1 首末实际 EOF 的 50 项有效稳定 FAIL 已由 root 完整消费全部 16 个功能分析字段；原正式回执 526619 bytes、SHA256 74e09fdadd6621472108f9eb8c8cb37a9e6fb1229a9a4a279413fe91b001614e 保留。唯一 N1-P2-001：同库 draining 用例逐轮重复 prepare 原单一 installation，第二轮在原非 closed 拒绝处失败，后七项 Node 写入断言不可达。另列两个原 prepare 合同的 10285 bytes 首末实际 EOF 已核对，原 50 人口/FP 保持。

修正复用一次真实受理的 fixture，先 lose，再循环原八写；每轮清零同一消费计数，真实 SQL 全行 before/after、BEGIN/ROLLBACK、原 work/lease 断言逐轮保持。其余测试全文精确逆向复原原候选，全部 15 定义、49 案例每 provider、162 静态 expects 和三个新增 15000 预算保持；四 production 和原 controls 不变。三个文档只追加，全部共享历史保留。SOURCE9-R2 独立重审、唯一原 census、配套门和 exact-SHA 全仓 main/Windows CI 仍待验收；尚未本机执行 AW 或新 census，N2/H7/A-G/CS 部署未签。

## N1 原生成、配套增量与发布边界

SOURCE9-R2 独立有效稳定 PASS、0 findings 已由 root 实际消费全部 56 项首末 EOF 绑定和完整 9 个功能分析字段；原 SOURCE9-R1 的唯一夹具 P2、正式 FAIL 及其消费记录保留。15 个定义/每 provider 49 个案例/162 静态 expects 和全部预算保持，新用例仍须 hosted 执行。四生产文件及六实际 caller、所有旧 Node/provider 回归保持。

唯一一次原 scoped census 固定 2b1e93de995870076b160198e26eb845271711af，使用 5 个冻结 TS 输入（4 production）和 6786 个非本批已提交 source blob；四原规则逐字保持，13 完整原始输出保留，sourceDigest sha256:58fa16d2d8fc8b91f284758859b5bc2b22ae5d6adb555cefcdd4ea95b2469d5d。两新增 Task application/infrastructure 文件实测增加 5 owner、1 factory 和 1 个 erased database-adapter type import；四实际生产输入 classic inbound/outbound 均为 0→0，原全仓 SCC/边界、356 条 authored debt、所有旧 why 与完整业务 payload 保持。

129 项有序账本仅配套四项实测增长：rfc294-mutation-entrypoints 1981→1982, rfc294-cross-context-observed-imports 6888→6889, rfc294-architecture-exceptions 6032→6033, rfc294-module-symbol-owners 27697→27702。原四个纯治理/JSON emission 先完整复现原始输出，再给四项一次性声明；源码发布消费后以普通后继退役。全部八份 canonical 和另三份治理的完整原输出保持，status 使用原 renderer 的完整 9215 bytes，不作全文件格式归一；本批真实指标变化同步于原始渲染。

配套 MATCHING16 门、精确 22 路径发布、普通声明退役与已上库测试的 Windows 三处登记、新 exact-SHA main/Windows 全绿逐项验收。没有新增整仓 census 或本机 AW tests/typecheck/build/services/E2E。N2 实际 Node caller、其余 Task/child/boot 分类、十九 owners/三 roots、完整 H7/A-T7/A-G 与 CS M0～M4 继续开放，AW 尚未部署 CS。三个文档只追加，全部共享和并行内容保留。
