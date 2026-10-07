# H1 / A-T7 Task 启动配置调用者收口

本增量属于已批准 RFC-370 的阶段 A。目标是让三个实际装配根及其 Task、恢复、Fusion 和后台调用者消费所选配置 query；不开始 CS adapter，不改变原本地配置策略，也不宣告 H7 或 A-G 完成。设计门另记，本文不自签 PASS。

## 当前缺口与范围

Task 已有 `TaskLaunchConfigurationQueries` 和公共异步投影。`services/task.ts` 的 `createTaskDriveCoordinator` 接受该 query，且每次 submit 等待 runtime 三次读取、随后 subagent 一次读取。当前三个根没有传入它，仍调用本地兼容函数；只增加低层端口不能使所选远端配置成为生产事实源。

固定 e56198b39737cf83a2c158a13abb60af539e09b3 的 AST 普查，实际调用为 `resolveLaunchRuntimeConfig` 23 处、`buildStartTaskDeps` 5 处、`resolveSubagentLiveCapture` 1 处，另有两处已存在异步 query 调用。完整候选源码和各实际 call expression 保存在私有 caller audit；只在这些配置调用及其功能消费者内作语义分析，其余完整源码作为 opaque 字节保留。

| owner / 根                           | 需接线的实际消费者                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli/start.ts`                       | Task 起始 deps、Fusion deps、路由 workspace、root resume、准备重试、长驻路由 coordinator、延后准备、digital employee host launch、人工等待 continuation |
| `cli/postgresqlDaemonApplication.ts` | 初始 workspace 参数、每次 drive 的 `currentRunConfig`、root resume、延后准备及两个仓库参数                                                              |
| `server.ts`                          | host launch、resume、准备重试、digital employee、Task 路由 / trigger coordinator、延后准备、Fusion                                                      |
| Task 兼容装配                        | `services/startTaskDeps.ts`、`services/task.ts` 的 workgroup room continuation、所有使用 `StartTaskDeps` 的短命 coordinator                             |
| knowledge-evolution                  | `inbound/fusionRoutes.ts` 的 create / reject 请求配置及 Task 引擎交接；不让 route 继续读取本地文件作为 selected 路径的来源                              |

`services/codeHost/connections.ts` 和 `fusionOrchestration.ts` 中同名文本是注释，不作为新调用数量。实现复核同时检查实际表达式和下游消费者；文本 grep 数量不作为接线完成证据。

## 所选源与原本地形态

复用 Task-owned 现有 query，不新造 CS DTO、通用配置服务或跨 owner 内部依赖。bootstrap 将显式选择的 application configuration query 交给 Task 的装配入口；二者 `read()` 的 Config 事实在类型上兼容。若用户显式传入 query 或 application configuration binding，Task 的所选路径必须使用同一 query。无显式选择的 standalone 路径继续使用原 file query 和同步兼容入口。

Task composition 区分本地同步和显式 selected 两种绑定。选择阶段只验证完整 `read` 函数存在，不读取配置、不创建 Task、不操作 workspace；缺失函数立即返回原样可识别的装配错误。selected 对象的方法保持 receiver。所有读取失败仍交现有共同投影的独立 fallback 处理；不能以 source 故障为由改读本地文件。

保留 `resolveLaunchRuntimeConfig(configPath)`、`resolveSubagentLiveCapture(configPath)` 和 `buildStartTaskDeps(...)` 的既有同步返回、原文件缓存、读取位置、次数及 fallback；不将这些兼容函数改成 Promise，也不把所选 query 塞进同步函数后强行类型断言。新增 selected 装配只处理中立配置事实，db、scheduler、repository workspace、runtime lease 和身份等由原根装配，不在 Task application 新增 SC / IA composition 依赖。

新增共同 `resolveTaskStartLaunchConfiguration` 投影供 selected 起始 deps 使用：先 subagent 一次读取，再 runtime 三次独立读取。它沿用现有两个投影；不合并为一次 Config 快照，不把一项读取失败扩大成整组缺省。长驻 coordinator 继续原 runtime 三次、subagent 一次的顺序。upload 的现有独立一次读取不并入启动四次。

初始 object / coordinator 的构造保持同步。selected 路径不调用本地 resolver 制造初始 scalar；运行旋钮在已有异步业务入口或 coordinator runtime getter 内等待所选投影后交出。bootstrap 的本地分支继续在原位置生成初始 scalar，保留原读取次数。`createApp`、`createComposedApp` 及原 SQLite HTTP composition 继续同步返回 Hono。

## 逐入口等待与配置热更新

Task 将 query 显式带到 `StartTaskDeps` 的可选兼容接线及短命 coordinator。`createTaskDriveCoordinator` 优先采用显式 query，其次采用 deps 携带的同一 query，最后才是原本地 refresher / frozen 形态。现有非配置 participant、binary override、failure reporter、cleanup owner 与业务请求参数保持；不能通过 spread 将 Promise 当作 runtime、deps 或 DTO。

起始配置读取在所选入口实际使用其参数的 workspace 准备或新派发之前完成；原 Task admission / intent 事务的先后关系保持，不额外增加一笔配置事务。multipart / Fusion 已交来的 workspace 仍先建立原 cleanup ownership，然后在既有 try/finally 内等待配置；配置异常不能使交接资源丢失 cleanup owner。共同投影原有可恢复读取失败继续按原缺省执行，不新增失败政策。

root resume 的 producer 改为 `ChildResumeRuntime | Promise<ChildResumeRuntime>`；两个 provider 的 resume consumer 和 `taskRouteOperations` 的实际 resume producer 先 await，再调用原 `children.resume`。原 sibling / auto resume 路径也必须经过同一等待；不得将 Promise 放入 `request.runtime`。Task 的原 epoch / revision / write transaction 合同不因配置读取变化而改写。

准备重试的 selected deps 在原异步 retry 方法内等待投影，再交原 `retryRepositoryPreparation`。工作组房间及 human-gate continuation 显式携带 selected query；原事务、决策顺序、同步 companion rows 和驱动 ACK 继续由旧 owner 控制。默认 local continuation 继续走原同步读取。

仓库的 `cloneTimeoutMs` 和延后准备的 `gitBaselineSyncWindowMs` 也是热配置的实际消费者，不能只接 scheduler runtime。所选路径在每次实际准备开始前等待共同 runtime 投影，再将两个标量交原 SC / Task 准备实现。

SC composition 增加可选的中立准备配置 query，`read()` 只返回 `{ cloneTimeoutMs?: number }` 或其 Promise。bootstrap 在 selected 分支将 Task 的 runtime 投影映射成这一事实；SC 不读取 Task 内部或 Config 文件。`effect` 等待该 query 后，将标量放入既有 `RepositoryPreparationEffectFactory.create` request，实际 local factory 必须消费该 request 字段。`legacy.prepare` 也等待同一 query，继续保持原 request 显式标量优先于配置标量的规则。没有 query 的本地分支不增加读取，保持原 captured scalar。持久 operation 的 journal / 清理 / 重试顺序及原 selected effect family 保持。

Task 的延后准备 composition 显式携带 selected Task query，在实际 `prepare` 入口等待 runtime 投影，将两个标量交原准备调用；构造阶段不读取它。已有 task / workspace ready 或 terminal-won 判定仍先按原规则完成，不为这些无效果路径增加读取。没有 selected query 的本地分支保留原构造位置和已有标量。

Fusion route 通过根传入所选启动 query，保持只投影原四个 runtime / retry / timeout 字段，在 create / reject 原业务调用前等待；原请求参数解析、既有失败与所需读取位置保持。下游 SQLite / PostgreSQL Task launch 同时取得同一 selected query，不能由另一份文件 refresher 覆盖。在各原入口，用户原来可显式指定的 runtime / binary / task 参数仍按原优先级；仅替换来自配置快照的旋钮，不覆盖用户显式输入。

## 实施批次与功能证据

先交付并复核 Task 原共同投影、selected / local composition 和真实 query 合同回归；不公开零消费者的接口。随后在同一源码候选内接完三个根、两个 resume consumer、准备及 continuation、Fusion，生成实际调用者对拍。只有完整入口接线才能记本增量完成；第一批工具或库不作为三个根已适配。

功能回归包括：同步 legacy 原返回与四次读取顺序；异步 selected 三个独立 fallback、receiver、热更新和无本地文件读取；非法完整 family 在效果前拒绝；双数据库真实 Task / route / trigger / Fusion / resume / retry / continuation 的配置等待；所选 clone budget 与 baseline window 在真实准备消费者生效；已交 workspace 的等待 / 失败 cleanup ACK；HTTP 同步构造且首次 request 取值；所有原业务参数、断言、fixture budgets 保留。

实现前固定现存 CFG-45、Task launch、Fusion、resume / retry 和延后准备 oracle 的完整字节。只补新的功能用例，不重写原断言来适配候选。源码门需核对实际所有 producer / consumer 和逐入口配置读数；架构清单由原规则对最终候选生成一次，按实际数量投影，不为异步接口放宽扫描范围或判断规则。只审功能；安全相关一律不扫描、不分析、不验证、不提问、不提 findings、不提建议、不转成任务，也不得影响门检视结论。

本机只运行 scoped format / lint 和纯源码 AST / 字节 / JSON 证明；AW test / typecheck / build / service 的权威结果仍是发布后的 exact-SHA GitHub CI。原失败保留，有限源码 PASS 与正式 CI、A-G、M0 部署分别记载。之后仍须完成 H7 三根及执行权 / 恢复接线，再按 M0 必须 adapter 先部署、M1–M4 逐项接管的原顺序推进，RFC 保持 In Progress。

## 实施候选 SOURCE19-R1 的实际边界

D1 有效稳定设计 PASS 已由 root 完整消费；原 D1 正文逐字保留，不据本节自签实现 PASS。候选包括16 production、2新增 regression、本文，共19个自有路径；三个共享启动根和 providerRuntime 保留并行 RFC-371 的所有 native usage 输出。当前实现仍需独立源码门、按最终可发布内容生成一次配套清单、精确上库及 hosted CI，不能记三个根已发布或整仓绿色。

application configuration 的默认 file binding 显式保留同一同步 query；selected persistence或显式 query override不获得同步描述。三根的 Task selection 保持同步构造且选择时零读取。Task start按 subagent→commit→runtime→child读取，drive按commit→runtime→child→subagent；每次调用独立fallback且receiver保持。selected start显式清空旧注入标量，短命coordinator优先显式query、随后deps query，原本地refresh只在无selection时消费。Fusion显式四项命令参数保留优先级。

完整现存服务和 native helper仍保留原同步API；原 CFG-45 getter文字与全部旧测试/断言/预算保持。准备、延后准备的selected query在实际效果前读取；延后准备清空旧clone/baseline值，SC实际factory消费request的clone值，selected值缺失时不恢复构造期旧值。工作组continuation把同一query交到实际短命coordinator，并沿用原intent认领，不另建intent。三个rootResume producer和三个实际children.resume consumer全部等待runtime，不spread Promise；完整旧业务事务、参数与收尾责任保留。

新增回归实际覆盖同步/selected选择及独立失败、配置ACK/receiver/热更新、旧文件保持、双provider HTTP手动/定时启动和resume、延后准备及重试、真实Fusion读取/创建/工作区/engine配置交接、SC journal/factory clone预算、工作组原intent/short coordinator、已交工作区等待和失败后的cleanup ACK。Fusion family明确拒绝Agent效果，故该用例只验实际Task配置交接，不声称Agent业务完成；工作组的scheduler是明确记录请求的port，真实数据库认领/intent和coordinator读取仍实际运行。原功能控制全文保持，测试只写好，未在本机运行。

纯 AST inventory读取所有实际配置call expression与ancestor/await信息，共44个调用：legacy runtime22、native builder5、native subagent1、异步runtime7、异步subagent3、start projection3、root selector3；原D1的PG初始legacy调用由共用initialRuntime替代，其local分支保留原三次读取。数字仅描述原始调用库存，完整producer/consumer与guard策略需源码门复核，不据数字自动关闭切面。18 TS全部仅纯syntax parse，不执行typecheck或测试。

此前root准备工具因并行输出前进，在任何源码写入前停止；完整错误与旧snapshot保留，正常向前编辑从三个根的当时全文开始。对并行native依赖尚未上库的状态另行协调短发布临界区，不删减共享根里的任何输出、不打包无关WIP，不用分支/worktree/stash/reset等规避。只有所有依赖成为可发布内容才能发布共享根；普通开发持续。

本增量不接H7执行权或改变Task owner/epoch/revision事务。完整H7实际三根/提前恢复/十九handles/named admissions/Task上下文、A-T7和A-G仍开放；之后按独立CS adapters→M0先实际部署→M1至M4原顺序继续，当前AW尚未部署CS，RFC未完成。

## SOURCE19-R1 的配置源与类型合同修正

SOURCE19-R1 是有效稳定 FAIL，包含两项 P2。原 71 项首末全文、正式回执及 root 完整绑定保持；两份实际 tsconfig 与 providerHttpApplication fixture 的三项额外合同也已首末全文核对，未计入旧 FP、未重签旧门。

F01 的修正只让根自己创建的默认文件选择保留原 legacy 路径。显式 applicationConfiguration（包括另一份文件 binding）始终使用它的同一个 queries。CLI 在 startCommand 的原配置选择点确定 Task binding，再沿同一 sessionInput 送到 SQLite 和 PG；PG 复用该完整 binding，避免把 CLI 的默认选择误判为外部选择。Standalone HTTP/PG 的显式文件选择也走其原 query，不绕回 deps/input 的默认 configPath。新增真实双 provider HTTP 回归以两份不同文件验证两次启动的 runtime、并发、重试和 subagent 热配置，并确认根默认文件完整不变。

F02 使用 Record<keyof TaskLaunchRuntimeConfiguration, undefined> 声明同一十八项清空值；运行时字段、值和三次 runtime 读取及一次 subagent 读取均保持。实际 strict:true、exactOptionalPropertyTypes:false 合同与原类型问题一起保存，没有本机 typecheck。

本段只记录修正后的待复核候选，不代表源码门、配套清单、远端 CI、完整 H7/A-G 或 CS 部署通过。原 native helpers、完整控制分支、旧测试断言/预算以及并行 native 输出继续保持。后续仍按 M0 先部署、M1–M4 逐项接管。
