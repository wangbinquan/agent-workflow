# RFC-370 C2-W2-N2：Node 实际调用者接线

继续已批准的 Stage A/H7。N1 的两个目的视图已经上库；本批将真实业务动作接入，保持 native 默认形态、原状态机、原参数和原执行顺序。完整阶段 A 验收后再编写各层 CS adapter，M0 先实际部署，然后逐项接入 M1～M4。

## 继续门槛和真实边界

40a0d70518f31d18321ae7680bf946a733b74d91 的主 CI 37872131154 全部 72/72 作业成功，Windows 37873022203 成功并通过 Typecheck。本次 Windows 是对原 main workflow 的普通手动 dispatch，因为仅 RFC303 测试 helper 变化不命中原路径过滤；实际 run 的 headSha 是同一 40a0d705。两 run 和全部 73 terminal jobs 已完整读取。原 Git 夹具两个案例在 macOS/Ubuntu 各通过一次，全部原断言和 5000ms 预算保持，CI 修复已闭合。旧失败和 INVALID 回执保留。

N1 原 49 个案例在 8768599ad6137ee3d962f289a42d52deb8393271 的 Ubuntu SQLite/PostgreSQL、macOS SQLite、Windows SQLite 共 196 个真实案例通过；该提交自己的主/Windows 总 CI 成功。40a0d705 包含该提交，四生产、原回归及直接合同的完整 Git blob 保持，故复用同一候选验收；并另取得当前 main 总绿。没有本机 AW tests/typecheck/build/services/E2E 或第二次 census。

## 从原源码得到的业务动作

六源文件历史有限 AST 清单的完整字节与 40a0d705 相同。85 条记录中，3 条仅是 setRunStatus/transitionRunStatus/mintRun 的定义，2 条是既有 W2-P 写入；80 条真实直接/helper Node 调用位于五个模块。第六个 taskEngineApplication 没有直接 Node 写，但有 dynamicWorkflow 端口转交。本批进一步读取转交的实际消费者，不能把原有限语法清单当成完整调用人口。

| 调用模块                           | preparation | issuedResults | 原业务动作                                                                                                        |
| ---------------------------------- | ----------: | ------------: | ----------------------------------------------------------------------------------------------------------------- |
| application/taskAgentRun.ts        |           4 |            15 | 初始 memory/prompt、mark-running、派发前 session reset 为准备；真实事件、inventory、epoch、输出、失败和终态为结果 |
| composition/nodeMechanics.ts       |          16 |            27 | mint、重试说明、恢复派发、child 初始绑定为准备；child 失败清空、进度、输出、已观测失败及终态为结果                |
| composition/wrapperMechanics.ts    |           5 |             5 | shard/aggregator resume、hash、mint 为准备；progress、已消费事实、输出及实际注入失败为结果                        |
| composition/wrapperRunLifecycle.ts |           3 |             3 | 新 generation、resume、mark-running 为准备；终结、interrupted、park 为结果                                        |
| infrastructure/isolatedAgentRun.ts |           0 |             2 | 实际 merge conflict 后的单仓/多仓 pendingSubResolves 两条结果写                                                   |

按真实动作分类，不从方法名、状态值、字段或新行初始状态推断。skip 的新 mint 仍是准备，之后记录已作出的 skip 决定为结果；出生即 done/failed 的虚拟/守卫行仍是新 mint，不能借 ACK 创建。childTaskId 的设置与清空、同一 injectedMemoriesJson 的前后写入明确分开。原语法清单及完整原输入作为本批证据保留，实施后双向逐点核对，无漏点、重复点或输入变化。

## 转交端口和已有登记者

1. nodeMechanics 四次 resolveSchedulerRunRow 的实际消费者有三笔写：终结旧 superseded pending 行是 issuedResults，采纳待派发行的 patch 和 mint 是 preparation。该 application helper 增加可选 supersededLifecycle（只需 transition），原 native 独立调用省略时继续原 lifecycle；本批四个选中调用必须显式传 preparation lifecycle/projections 和 issuedResults supersededLifecycle。不得把整个混合 helper 套成一个目的。原 preResolve 短路、CAS 错误、继承参数、广播和上下文保持。
2. recordClarifyInlineEvent 有三个业务入口：两条派发前的 resume/fallback 决策是 preparation，实际执行后 session-not-found 是 issuedResults。由入口传已经选择的 NodeExecutionPersistence；helper 原 appendEvent 正文保持。
3. agent recordTaskReceipt 与 script recordUnownedStart 只在原 processEffect 为 undefined 的分支使用，转交 issuedResults。原 managed 分支仍交给 ProcessEffectAttemptObserver 与原 effects/projection，不套第二个 Node 视图，不增加第二次 host 消费。所有实际 receipt、参数、上下文、错误和分支条件保持。
4. taskEngineApplication 的 dynamicWorkflowArgs 转交 preparation.nodeRuns：原消费者 mint orchestrator、mint confirm gate 和 set 新 gate 为 awaiting_review，均属于新动作。原 loadEnvelopeNonce 是纯读。其他 dynamicWorkflow 状态写入、workgroup/child/control/boot 和真实启动根继续按各自合同收口，本批不据此签完整 H7。
5. 其余转交在本批实际读取的消费者中只读 node 行/输出/历史，保留原完整 native 读端口；不因接线而增加 admission 或写事务。

## 中立选择与装配

新增 application/taskNodeWriteSelection.ts，只依赖本模块 application ports，不含 provider、CS DTO、数据库或宿主实现。提供 selectTaskNodeRunWrites 的 preparation/issuedResults 两个 overload，后者没有 mint；selectTaskNodeExecutionWrites 使用原完整 NodeExecutionPersistence。选择函数返回原 native 实例或 N1 已创建的原目的视图，不包装方法，不改变 receiver、参数或返回值。

TaskExecutionPersistence 增加可选 nodeWriteMode: 'host-selected'；composition 仅在显式 hostWrites 时同时给出该标记和 N1 nodeWritePurposes。未选择时不新增这两个成员，原默认完整 native 实例和恢复管理面保持。显式视图自身也代表选择；只要有选择标记或显式视图，就必须使用所需视图。选中装配缺失视图时同步抛 task-node-write-purposes-not-composed，禁止补 native。nativeUsage 与该选择独立，不借它猜测模式。

IsolatedAgentRunBinding 的 Pick 同时携带 nodeWriteMode/nodeWritePurposes，继续转交同一原 persistence 和 executionContext，不重建工作或上下文。三种 nodeMechanics lifecycle helper 新增显式 purpose 参数；mint 只接受 preparation，每个调用点给出原业务目的。其他写入在原调用点选择所需端口，所有原输入、显式 context 优先级、异步回调和 Date.now 位置保持。普通读不经过选择。

N1 保存的原完整 context/token/work/capture、同一 outer/inner write frame、先业务后消费、原错误优先和整笔回滚继续使用，不在选择层重复实现。此阶段仍没有 CS 生产 adapter，三 roots/十九 owner 的实际装配另验。

## 测试与交付

新增独立真实双 provider 回归，不改原 N1 49 个案例/断言/预算。覆盖 native 两目的返回原实例、selected 返回原视图、selected 缺视图明确失败且零 native 写、issuedResults 无 mint；真实 wrapper open/resume 是准备、draining 拒绝新 generation，而原结果/park/interrupted 可登记；真实 run-row helper 的 superseded 收尾与随后准备分别登记，采纳/mint 原参数、原广播及原错误保持，host 消费失败原行/owner 回滚。补有限源码合同：从实际源码枚举这 80 点、四个 mixed helper 转交、三个 clarify 入口、两个 unowned receipt 和 dynamicWorkflow 转交，与已分类清单双向核对；真实 managed receipt 继续走原 effects，避免重复登记。不得用只测 selector、假 SQL 或放宽原断言代替实际业务回归。

先独立限定功能设计门并完整消费，再实现与功能实现门；生产候选只跑一次原 scoped census，保留原规则/完整原输出/已提交非本批输入。共享架构 WIP 由原会话持有，在配套确实交叉时仅作必要发布协调，不覆盖。源码与配套按精确路径上库，新测试上库后再登记原 Windows workflow；全仓 main/Windows 的 exact-SHA 总绿与实际案例逐项验收。当前只签本批有限设计，N2 实现、完整 H7/A-T7/A-G/十九 owner/三 roots/CS M0～M4 均待完成；AW 尚未部署 CS。

## N2 实现候选与验收边界

独立设计门 N2-DESIGN5-R1 有效 PASS，80 个原动作及全部转交写点的实际分析已逐项消费。实现只在原调用者选择目的，增加 application 中立选择与 selected-only 标记；原 SQL、方法接收者、上下文、参数、异步顺序、Date.now 和广播正文保持。6 个原 caller 的接线逆补丁逐字恢复完整原文件，格式化后完整 TypeScript AST 另核对；其余三个既有生产文件只加装配标记或 supersededLifecycle 参数。

新 rfc370-task-host-node-callers.test.ts 定义每 provider 18 个真实数据库用例与两个有限源码合同：native 原实例、selected 原视图与缺失装配；pending 采纳与原 mint 参数；旧 superseded 结果的提交和新 successor 拒绝分别成事务；原 host 错误整笔回滚、无错误广播、原工作重试；wrapper 新代/同代恢复及 draining 下 interrupted、park、终态写回；managed/unowned Agent 回执与 managed script 原 runtime 参数。终态 clearReuseDisabled 是原独立 W2P 写事务，保留第二次登记，不能当重复 spawn receipt 删掉。Agent 使用既有 native test fixture 产生真实原 opaque receipt，数据库保持原实现；本批没有本机 OS 子进程、真实远端运行或 CS 部署验收。

原 N1 测试文件、49/provider 案例、全部旧断言/预算与目的视图实现保持。新源码功能门、唯一原生产 scoped census、共享架构配套、确切上库及 main/Windows 总绿和实际18/provider案例仍待验收。旧失败及各阶段证据独立保存；本候选不得签完整 H7/A-T7/A-G，也不代表三 roots、十九 owner 或 CS M0～M4 已完成。RFC 继续推进。

## N2 原生成与配套候选

独立 N2-SOURCE16-R1 有效稳定 PASS、0 findings 已由 root 完整消费正式45项（16/18/11）首末EOF、三个包装及80原动作实际分析；唯一授权8090-byte旧设计正文单列补充，原表格排版后全部语义保持，原四历史文件正文与1195-byte设计追加逐字保持。10 production、18/provider新真实数据库案例及两个源码合同均冻结；原N1的49/provider案例/162静态expects/原预算不变。新案例的运行验收仍由确切提交 hosted CI 完成。

唯一原 scoped census 固定 83c6b76f545fc26e314a0e98dd23ff1025d81eef，11冻结TS输入（10 production）及6789非本批已提交 source blobs；四原规则全文不变，13完整原输出保存，sourceDigest sha256:66c47ae246183e52845f71a32e3f7ac3ff2239e419f8cd38cd430f9d4d68f1d3。原classic本批 inbound 0→0、outbound 15→15逐条同一，无新增跨域import、全仓SCC/边界或authored debt；356原债务与129有序账本及每条why完整保留。新增中立application文件对应8个file/symbol owner；原规则按符号名额外收录RunSelection类型别名（erased type），保留该原输出，不据此增加SQL写入或修改扫描判据。

两个实测账本增长仅配套一次声明：mutation-entrypoints 1982→1983、module-symbol-owners 27720→27728，源码消费后普通后继退役。四个原纯治理/JSON emission先整字节复现原生成输出，八canonical及另三治理和原完整status渲染全文保持。配套16项功能门、最终29路径精确发布、上库后Windows原workflow新测试登记及new exact-SHA主/Windows总绿与真实18/provider案例依序验收。没有第二次census或本机AW tests/typecheck/build/services/E2E。其余Task/child/control/boot、十九owner、三roots、完整H7/A-T7/A-G与CS M0～M4继续；AW尚未部署CS，RFC继续。

## 2026-10-09 N2 源码与清单上库、Windows 接线及增长回执退役

cf50bc330dd0cb7d73095da26f8862dcb4db80ca 已将真实 Node caller 选择的29个文件正常提交并推送 main；独立 SOURCE16-R1 与 MATCHING16-R1 有效稳定 PASS 均已完整消费，远端0/0、空index及全部并行内容保留。18/provider 新回归和2个 source 案例已上库；正式行为仍须验收本后继新SHA main/Windows 总绿及实际案例，不将有限源码门当成 hosted 成功。

本普通后继只删除两个随源码消费的 allowGrowth，129有序库存/baseline/why、canonicalProjection/sourceDigest/原provenance锚点保持；用原五个纯JSON函数重算 contentDigest。Windows 原 push/PR 过滤及平台命令各登记一次已上库新测试，四个尚未监测的实际生产路径各加入两处过滤，其余六个生产路径已覆盖且保留。删除11个新增引用可恢复完整原workflow，所有旧命令、并行接线、断言和预算保持。三份文档只追加；其余25个已发布路径字节不变，无新 census 或本机 AW tests/typecheck/build/services/E2E。独立后继功能门、确切发布及总绿分别验收；完整 H7/A-T7/A-G、十九owner/三roots及独立CS adapter、M0首次部署至M4继续，AW尚未部署CS。
