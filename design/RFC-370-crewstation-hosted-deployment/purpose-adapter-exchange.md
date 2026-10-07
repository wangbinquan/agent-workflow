# RFC-370 集成九操作与 staging 交换切面 D1 候选

本片完成 A6 中 requirement-source、pipeline-gate、approval-gateway 的九个执行效果及配套内容交换切面。D1 独立设计门已经通过，当前实现候选正在补齐功能回归与源码完整性核对；实现门、源码派生匹配和 hosted exact-SHA CI 尚未验收。沿用已批准的顺序：完成完整阶段 A／A-G 后编写各 owner 的 CS adapter，M0首先部署编辑耐久闭环，随后在 M2／M3接管这些目的能力。M0期间尚未适配的目的效果保持未就绪，依赖它们的worker等待接管。

## 当前真实链路

Integration 的 `developmentAdapterRunner.ts` 接收原 published adapter内容、九操作输入和物理stagedRoot，生成本机程序调用、执行并返回运行结果；九个 `run*` 函数分别解析原 envelope。`developmentRequirementSourceAdapter.ts`、`developmentPipelineAdapter.ts`、`developmentApprovalAdapter.ts` 负责解析绑定、核对目的和支持操作，并保留原失败结果。三个 composition 函数分别选择本机 runner，SQLite daemon／PG daemon／standalone HTTP及其各业务子装配有多处消费者。

DA 的 requirementMaterializer 先创建 sink，再 acquire／问题发布／答案采集；成功收集的文件经 EvidenceArtifactPort.importStagedTree 收编，最后清理。direct submission亦先写文件再收编。pipelineEvidenceChain调用ports.pipelineEvidence.collect，取得collected.stagedRoot及collected.cleanup，核对原head／target fence后交给importer，并在finally调用cleanup。临时sink实际由services/developmentDeliveryDeps.ts中的buildDevelopmentPipelineDeps为collect／trigger／rerun创建；digitalEmployeePlatformWorkItems中的另一消费链也使用该结果并清理。importer另存放原canonical manifest正文。approval先解析绑定，然后创建临时sink、执行，再清理。这些实际内容与执行使用同一staging后端，是本片必须整体接线的关系。

## 所有权与合同

Integration application拥有九操作的纯业务参数、原failure vocabulary、program opaque引用，以及三个独立完整目的效果family。DA application拥有Evidence staging引用与完整factory／lease合同，并通过已有public入口公开结构类型；Integration只消费该public类型。程序、文件系统、CS执行DTO和实际对象存储定位分别放在各owner的native／CS adapter包及它们的composition。原Mission、case、pipeline fence、approval receipt／digest和证据台账政策保持。

程序配置通过composition层 `configurationFor` 生成新opaque引用；它只在解析本次published revision成功后调用，每次操作获得本次配置。native bridge保存原完整published配置与原装配输入receiver，selected root可生成自己的配置引用。application效果合同只传configuration／program引用和业务参数。原宿主配置解释及初始化时点由native bridge保留，既有数据库发布／revision接口和历史配置继续可用。

```ts
interface AdapterConfigurationReference {
  readonly kind: 'development-adapter-configuration'
  readonly reference: object
}
interface AdapterProgramReference {
  readonly kind: 'development-adapter-program'
  readonly reference: object
}
interface EvidenceStagingNamespace {
  readonly kind: 'evidence-staging-namespace'
  readonly reference: object
}
interface EvidenceStagingReference {
  readonly kind: 'evidence-staging'
  readonly namespace: EvidenceStagingNamespace
  readonly reference: object
}
type AdapterProcessObservation =
  | { readonly kind: 'completed'; readonly stdout: string; readonly exitCode: number }
  | { readonly kind: 'expired' }
  | { readonly kind: 'unavailable' }
```

每个目的效果family包含namespace、programs.bind(configuration)及三个明确操作，全部成员必须提供。requirement为acquire／questionsWriteback／answersCollect；pipeline为collect／trigger／rerun；approval为submit／lookup／observe。各操作接收同一family的program、EvidenceStagingReference及该操作的原业务参数，返回AdapterProcessObservation。program绑定允许同步或Promise；native同步分支保持原调用时点，selected异步分支等待ACK。全程保留programs与效果对象的method receiver。

Integration原运行结果政策把expired／unavailable／completed映射到现有结果，保留原顺序和闭合失败文案；completed继续使用原末行JSON解析及九个完整envelope schema。native程序准备、进程、流、计时和回收效果放在独立native implementation。completed只能在原输出读取及退出确认完成后返回；expired只能在原退出确认、流读取和原回收步骤完成后返回；unavailable对应原启动失败，没有待回收的执行。selected实现同样必须在其执行终态、输出传输与对应回收ACK完成后交回观察值，common随后才按原政策解释结果和继续内容收编或清理。选中效果抛出的原Error继续传播，无本机补齐。原代码的其它内容按完整正文机械保留，不扩展本片功能审查范围。

## 内容交换与清理

Evidence staging factory提供namespace与create()，结果可以同步或Promise。lease包含reference、writeText({relativeName,text})、importTree(budget)、putDocument(text)和close()。前两类写入的名称是原业务相对名称；importTree返回原EvidenceBundleRecord，putDocument返回原blob的sha256／bytes。所有操作使用创建lease的同一receiver、原选定EvidenceArtifactPort和同一namespace，业务收编仍读取原证据记录。

native requirement staging保留join(root,ulid)／mkdir的原机制；approval保留原mkdtemp前缀；pipeline保留buildDevelopmentPipelineDeps原三个mkdtemp前缀及其对应清理分支；临时目录效果移到DA独立native包，原legacy builder保留为public组合的兼容转接。分别装配这些完整factory，同时共享本次内容后端的namespace及私有解析器。native program adapter经composition收到私有stage解析能力，实际目录只在native包内恢复。CS的DA staging adapter与Integration program adapter使用同一CS stage transport实例，由adapter包解释平台引用；公共application合同保持opaque。

putDocument保留pipeline manifest的独立临时写入／原blob收编／清理机制，等到原manifest校验成功才调用。direct submission、question document的完整原生成／digest规则保持，所选write／import／put的ACK完成后才发布各自原收据。每个原finally与原失败清理分支逐次等待对应close ACK；native同步close保持原时点。清理错误继续遵循原finally的异常优先级。原操作未到达stage的分支不新增stage，原成功、失败及抛错分支的执行／清理顺序逐一保留。

根选择是目的family与其staging绑定的完整一对。三目的可以分别选择，选定的这一对必须namespace一致，完整缺成员或引用不一致在第一个效果前失败。Integration效果与DA importer拿到同一lease reference；没有程序写入之后再另建一个内容接收端的路径。lease创建后交给同一目的family，其import／put／close仅由原owner协调器安排。

## 真实接线与兼容

三个actual roots选择三个目的完整family及DA staging factories，把同一选择透传所有现有业务子composition，包括server里多个DA／DE／approval装配点。启动session重组、HTTP effective dependencies和测试actual-root helper也透传同一选择。默认只在bootstrap／owner composition创建native完整pair。旧物理输入导出留在独立legacy bridge，原测试与已有调用继续通过该入口；新的common目的消费者只接收opaque引用。

buildDevelopmentPipelineDeps产生的collection staging与cleanup更新为同一选定lease面，pipelineEvidenceChain及digitalEmployeePlatformWorkItems两条消费者均等待该cleanup ACK，importer消费同一lease；原head前后核对、迟到／失败判断、artifact与manifest编制政策保持。requirementMaterializer的source窄依赖与Integration公开合同同形更新为staging reference，sink生命周期通过完整factory选择；direct路径复用同一内容能力。requirementMaterializer目前内部的deps.documentCommands ?? createFileEvidenceDocumentCommands默认选择移到DA owner composition；该composition一次选定documentCommands、EvidenceArtifactPort与staging factory。common不再补native writer，显式choice缺documentCommands直接判配置不完整；默认兼容入口仍选择完整native组合，避免selected staging与本机document writer混用。approval仍先解析绑定，再create，最后执行／close。九操作之外的执行权准入／早期恢复由H7切面完成，本门不关闭H7。

## 实施与功能证明

先抽取Integration原运行观察效果和opaque program binding，保留九schema／结果策略及native完整机制，完成默认兼容与selected效果回归。再接DA完整staging／manifest／direct内容面及Integration同一namespace，最后在三个actual roots完成全部子composition透传与重组。三个步骤都完成后才记本目的切面完成，完整A-G及CS部署单独验收。

回归使用实际provider与原公共消费者：九操作逐项覆盖完整family／namespace、配置每次解析、原receiver、原成功／失败结果；held program／execute／import／put／close ACK证明每个原依赖顺序；原Error身份及完整失败分支／finally语义；root重组后同一program／stage／import实例；新choice缺成员无默认补齐。requirement真正写出内容后从同一selected证据面读取，pipeline经原fence与manifest收编后回读原digest，approval真实submit／lookup／observe和重启读取回执。原本机程序fixtures、原用例／断言／预算、schema正文与policy／native正文的有限逆变换完整保留，正式行为交hosted exact-SHA CI。

拟改范围为Integration application ports、原runner及三adapter、native包、三个purpose composition／public facade；DA evidenceStaging合同、native包、requirementMaterializer、pipelineEvidenceChain／importer、digitalEmployeePlatformWorkItems及对应composition，services/developmentDeliveryDeps的原builder兼容转接；三个actual roots、完整重组和actual-root测试helper。以实际依赖确定有限SOURCE population，先设计门再写代码；最终源码候选只执行一次原scoped matching生成，原规则与其它并行内容保持，具名增长按原协议正常后继退役。没有全局fat CS adapter，也不把旧高层接口的可选回调当作本片闭合。


## 实现候选记录

Integration application 现有三个完整九操作效果 family、opaque configuration／program binding、原 schema 与结果政策；DA application 现有完整 staging factory／lease、原 requirement 物化与 pipeline manifest 政策。物理程序和目录机制放入各自 native 包，原公开 API 通过独立 legacy facade 保留。三个真实根及其 session／HTTP／event 子装配复用同一 purpose selection，HTTP adoption 仅选其原 MR participant。

新增九操作同步／异步 program ACK、原 raw Error、terminal vocabulary、staging allocation／finally cleanup ACK、真实已发布配置逐次解析、pipeline 实际日志／manifest 内容回读、approval gateway 重组以及双 provider 真实 HTTP 根重建后的 requirement 内容／source-refresh ACK 回归。旧九处根与子装配完整正文、三个原 MCP 正文摘要和四个 W29 正文通过精确有限逆变换核对；旧用例、断言、预算不删改。这里的纯 AST 核对没有执行 AW 应用或测试，不替代 CI。

目标文件格式／lint 单独记录；等待独立功能实现门及原单次 scoped census 的匹配数据，不先写完成结论。完整 H7、阶段 A／A-G、CS adapters 和 M0～M4 继续开放，尚未把 AW 部署到 CS。

SOURCE60-R1 的有效稳定 FAIL 与冻结正文完整保留：原生 stagedRoot 被提前解析导致 getter 错误顺序及两次读取的旧 catch 行为改变；九个旧 run API 的同步门面使原 Promise 拒绝变为同步抛错。后继恢复惰性 stagedRoot 解析与全部九个 async 兼容入口，补原 executable 优先级、第一／第二次 staging 读取及九入口 Promise 回归；全部在原 native spawn 前终止。原九 schema／结果政策、清理与 selected raw Error 合同保持，SOURCE60-R2 功能门和新 exact-SHA CI 另验。

SOURCE60-R2 已有效稳定 PASS；该候选的一次原生成因新增 legacy services helper 未登记 owner 而正式失败，原回执、日志、marker 保留，未写共享 matching。后继按独立 DESIGN1-D2 将同一完整 selector 放回 server bootstrap，并由 owner native／composition 创建默认内容，两个跨 owner helper 经 exact participants 转发。旧 WIP services 文件为本任务自有且未发布，全文留证后删除；最终源码／一次生成／CI 继续，完整 H7／A-G 与 CS 部署仍开放。
