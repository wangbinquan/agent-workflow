# H7：真实启动根与 owner 生命周期接线

## 2026-10-13 三根选型、激活边界及状态接线续推

两 daemon 根已写入完整十九项选型，嵌入式 HTTP 新入口复用其原 Task/MCP 所有权。实际原 boot recovery、冷 owner 初始化和资源生命周期接线保留；统一激活通知等待全部 start ACK，维护子 Worker 额外关闭原预存队列直至 activate。普通 pause 的新准入、原取消/结算与写入退役分开，构造失败等待原清理；PG webhook 收尾使用本根 Task registry。

中立执行状态 API 读取同一控制器，前端复用原提示/表单与中英文资源。首批执行路由分组、Task 创建和 MCP 启动限制已写入候选，其余入口和全部功能仍需收口。新 root、控制、真实 Worker、shared/UI 回归均只编写；44 份 TS/TSX 静态语法零错误、限定格式/diff 自查不代签功能或 CI。无本机验证、逐片门、新发布/部署或跨 session 消息。完整 A-T7/A-G、不确定恢复、CS adapters、先 M0 后 M1～M4 仍开放，见 [本轮实现与剩余清单](root-activation-and-availability.md)。以下历史快照和并发输出保持。

## 2026-10-13 十九项 owner 绑定候选已写齐

最新补齐 memory distill、development wake、digital employee、event center、fusion 与 observation report；根侧十九项绑定代码已具备，仍需接入 SQLite daemon、PostgreSQL daemon 与 embedded HTTP 的实际构造、恢复和关闭路径。

业务循环在实际候选读取后/下一项前使用捕获的准入函数。已受理的 memory bundle、mission wake 及 fusion reconcile 保留原业务结果；`fireWake` ACK 后失权会持久保留后续 drive hint，未回收的 memory runtime 仍使排空失败。公共轮询 owner 的调度关闭和实际排空分别确认，本轮关闭也参与逐项判断。报告 host 模式提供冷查询、明确构建受理、同 ID 未发 claim 归还和已发构建的原结果/清理排空；未确认的写入仅重试原结算。增量统计和存储维护保留并发业务实现，增加独立 loss quiesce/drain 接线，正常 stop 保持原业务取消。

新增双 provider 实际报告缓存、snapshot/spool、领取与结算用例，以及业务循环/worker 生命周期用例均尚未执行。十五份业务 TS 与十一份报告 TS 语法解析零错误，格式/diff 静态自查不代签功能、实现门或 CI。三个根、执行状态 API/UI、不确定运行时恢复、A-T7/A-G、CS 独立 adapter、M0 首次实际部署及 M1～M4 仍未完成；新候选未提交/推送/部署。继续完整开发后集中验证，不逐片跑功能门，不发送跨 session 信息。以下历史快照与并发输出保持。

## 2026-10-13 定时 owner 续推

已写入 scheduled backup、submodule refresh、batch import GC、resource limits 与 idle timeout 五个独立根侧绑定，现合计十三项绑定代码，仍未表示三个根已完成真实选择。配置读取后和下一业务项之前使用同一捕获 lifetime；备份失权后不再发起新 prune wake，原请求仍排空；刷新只标记实际尝试的仓库，不把未发出的镜像错误标成已刷新。GC 是同步内存清理，停 ticker 后确无异步业务尾部；不能将此结论套到备份或刷新。

额度清理等待原已发取消的原因及审计写回，失权后不取消下一任务。idle timeout 按原任务树准入，已受理树完成原 kill/cascade/audit，停止下一棵树；未受理候选不因失权落失败。新增同一 Task 取消绑定的中立 resource limit 装配入口，避免 selected SQLite 回退到旧进程默认取消器。双 provider 实际存储、受控定时器/配置通知/原调用 ACK、原真实 Git 刷新及 idle tree 用例已同步编写，全部未执行。十一份本批 TS 静态解析零错误，格式/diff 自查完成，不代表功能或 CI 通过。

剩余 memory distill、development wake、digital employee、event center、fusion、report，三根整体接线及根关闭、状态 API/UI、A-T7/A-G 与 CS M0～M4 继续开发；不逐片执行功能门，不发送跨 session 信息。

## 2026-10-13 webhook terminal control 续推

已补 webhook terminal control 的显式冷宿主生命周期、第八个独立 owner 绑定与双 provider 用例。原 claim 在未发出任务终止前失权时归还为 pending；已经发出的操作等待原 receipt 写入，精确 CAS 结算领取，单调保留 claim attempt。数据库 ACK 未确认时保留原写入重试，不再次调用任务终止。原启动 guard 的 reservation、结果写回与 release 都计入同一 lifetime；失权不 abort，普通 pause 保留 abort，旧尾部未确认不得换代。额外补齐 webhook 准备阶段异常的 guard 收尾，避免新排空边界暴露永久等待。

原 native 用例、完整端口和失败证据保留；新增九项双 provider 宿主/领取/启动/事务用例及原真实 dispatcher 的准备异常用例均只写入、未执行。十一份 TS 的语法解析零错误，必要格式与 diff 静态自查完成，不等同于功能验收。三个真实根与完整十九项仍待接线，报告、其余后台 owner、状态 API/UI、A-T7/A-G 和 CS adapter、M0～M4 仍开放；本候选尚未发布或部署，无跨 session 信息。

## 2026-10-13 续推：MCP、continuation 与已提交事件

继续完成生产候选与用例，未进入集中功能验证。本次新增 MCP 的显式 `executionMode: 'host'` 和完整 `start / quiesce / awaitDrained / pause` 生命周期；同一 application 的冷查询、资源修改及清理意图保留原存储，公开 host 装配使用 stored queries。执行请求、boot／reconcile、队列、通知、异步 deadline 查询和原运行时结算均归捕获的 lifetime。失权不会走原 shutdown；正常 pause 仍走原取消政策，并等待实际在途尾部。

MCP 在尚未调用 `effects.runTurn` 前失权，将同一未执行 turn 恢复为 queued，保留 request／turn ID；原已发调用继续等待 capture、verification、lease release 和结果落库。首轮 `claimPending` 只重领本测试本轮未执行且已释放的原 lease。发生真实 spawn 收据、失权与用户 cancel／end 并发时，不覆盖实际执行或业务取消。未回收的 execution 或不能证明释放的 lease 保留实际诊断结果，并使 drain 失败；不能凭超时或日志替根确认释放。新的 lifetime 在旧尾部未确认前被拒绝，资源读取继续可用。失败结算的恢复与三个根的完整退役行为仍需在整体接线中收口。

`human-gate-continuation` 已增加明确支持执行 lifetime 的 definition：配置／候选读取后再次判断，失权停止下一项，已发出的 drive 原样完成。`committed-event-dispatcher` 新增独立 authority dispatcher 与原数据库的 `deferUnissued` 结算；只对尚未调用 durable consumer 的原 claim 归还领取，不计失败、不消耗重试预算，保留事件与单调 lease epoch。已经调用的 consumer 仍使用原 accept／reject，不能把其真实失败改为失权延后。返回 ACK 的原事务、重复 ACK 和旧 epoch 无权释放新领取都有双 provider 用例。

根侧独立绑定代码现为 Task、Intent、Maintenance、after-commit、MCP、human continuation、committed event 七项；这不是生产根已接入七项。三个真实根仍未选择完整十九项，report、其它 owner、状态 API／UI、A-T6／A-T7／A-G 及 CS adapter、M0～M4 继续开放。新增 MCP／事件真实存储用例和 continuation owner 用例均已编写，未执行。当前静态语法、格式自查与候选代码不等于 CI／RFC 验收。

## 2026-10-13 恢复完整实现

用户最新指示“先继续推进 RFC”后恢复生产开发；旧总绿等待记录保留为历史，不再阻止本次实现。仍按完整实现、接线和测试用例写完后集中验证的规则推进，不逐片执行功能门。

当前新增 `cli/daemonHostExecutionBootstrap.ts`：同一 provider／generation 创建原 SO write context、write lifecycle、Task write adapter 与 admission，等待实际 factory 完成；真实 recovery／runtime 两个 family 通过同一 scope 一次安装后才交出 authority lifecycle。安装捕获原方法和 receiver，缺失或错误 scope／kind 在安装前拒绝。`installDaemonHostExecutionSession` 消费实际 session 的 host runtime，先等待资源 resume，再调用原 authority start。`start.ts` 的共同 session 组合入口已能转交完整 `hostExecutionRuntime` 选择。

新增 `cli/daemonHostExecutionOwners.ts` 已实现 Task、Intent queued resumption、Maintenance 和 after-commit pump 四个 owner 的绑定代码：转交原 grant、原 callback 与实际 drain promise，普通关闭和失权分别调用各 owner 现有政策。after-commit 注销只释放同一 pump。它们还未替代三个真实启动入口中的十九个 native owner，不能把四个绑定或共同入口透传写成完整 H7 已接通。

MCP 实例已补独立 `storedQueries` 合同及同一份 private 持久读取／投影，原 native 查询仍保留先 start／reconcile 的顺序。绑定、双 provider 写上下文与冷读回归已随实现编写；尚未执行。MCP 完整失权生命周期、报告构建受理／排空、其余 owner、三个根的实际选择、执行状态 API／UI、A-T7／A-G 和 CS M0～M4 继续开放。当前仅完成必要格式、语法与差异静态自查，未运行产品测试、typecheck、build、服务、E2E 或实现门，也未将新代码发布或部署。

## 2026-10-13 当前基础与完整构造次序

本节是在等待总 CI 修绿期间对已有合同的设计核对，不继续生产实施、不执行功能门，也不把下面的构造方案记为已实现。先前快照中的 Task provider 缺口已有发布产出：两个 provider 创建 persistence 时已转交同一 `host.writes`，selected SQLite 使用独立的 `HostTaskExecutionModule`，两侧均形成同一 module／persistence／driverLifecycle 的 drive binding；SQLite 的旧 launch／resume／cancel／fusion 消费者也已具备传递并消费这份 binding 的独立接线。当前工作应复用它们，完成真正启动根的选型和生命周期装配。

源码依据为 `packages/backend/src/modules/task-execution/composition/providerRuntime.ts:295-319,535-571`、`packages/backend/src/modules/task-execution/composition/taskDriveBinding.ts:9-53` 和 `packages/backend/src/modules/task-execution/infrastructure/fusionEngineTaskOperations.ts:18-25,122-124`。原 native 分支仍按未指定选择保留。三个真实启动入口、十九个实际 handle、owner 的完整冷构造／失权排空、状态读面与完整 A-G 尚未完成；下方旧缺口是当时的设计快照，不是要求重新抽取已经发布的 Task 切面。

真实构造有一个需要明确解决的依赖环：SO binding 要先收到 recovery／runtime family，Task provider 又要先收到该 binding 的 admission 与写入适配，session 的实际 runtime family 则要等 provider 图和十九个真实 handle 构造完成后才存在。不能用半份 selection、进程级 native 单例或立即成功的空 family 来填这个环。根内部使用延后转交的完整方法合同：构造时声明同一 provider／generation 的 family，实际回调在完整 owner 安装前不能执行；安装后只委托同一个真实对象、原方法和 receiver，等待其原结果，不另外生成 ACK。根只在安装完成后交出完整应用与启动控制，不能把尚未构造完的 lifecycle 暴露给外部启动。该转交只属于 bootstrap 构造，不新增业务状态机或跨模块 facade。

完整 selected 根按以下顺序形成一份候选：

1. 固定 provider、generation、mode 和完整宿主选择；复用已准备的资源数据库与配置，不运行 Task 执行恢复，也不启动任何执行 factory。
2. 创建 SO write context／participant 与原 write lifecycle；为实际 recovery／runtime 声明上述延后转交合同，保持显式 recovery kind，并在安装实际 family 时核对同一 kind 和根归属。
3. 等待完整 SO binding 构造完成，再从同一 context／participant 创建唯一 Task write adapter；用该 adapter 的 port 和 binding.admission 构造 Task admission。两者都只捕获原合同，此时不 acquire 或生成 receipt。
4. 将这一份完整 Task host selection 交给 providerRuntime，创建该 provider 自己的 module／persistence／driverLifecycle 和全部真实调用者；实际 root-resume、human continuation、fusion、后台与 routes 共用其返回对象。
5. 冷构造所有 owner，以真实十九个 ID 和原顺序形成完整 handle selection，转交到 `_createComposedDaemonProviderRuntimeSession`；七个关闭参与者、HTTP／WS 和实际 session 生命周期仍由同一根拥有。
6. 将同一 Task 图的实际 recovery family 和该 session 的实际 hostExecutionRuntime 一次性安装到第 2 步的转交合同。不能混入另一 provider／generation，也不能在旧 lifetime 未结算时替换目标。
7. 先通过 session 的资源 `resume` 等待 HTTP／WS admission ACK，使 selected session 进入 running，而执行仍为 disabled；然后才调用 SO authority 的 start。不能用 `execution.resume` 代替资源 resume，也不能在 session 仍 frozen 时直接启动 host runtime。

第 7 步有现成的明确行为依据：`packages/backend/src/cli/daemonProviderRuntimeSession.ts:194-224,668-705` 在完整 selection 下初始关闭 execution，资源 resume 只在 enabled 时启动 handles，随后打开 HTTP／WS；`:481-496` 的 host runtime.start 要求 phase 已为 running。`packages/backend/src/modules/system-operations/application/hostExecutionAuthority.ts:330-375` 继续拥有原 write prepare → recovery prepare → driver activate → write activate → runtime start 的 ACK 顺序，全部完成后才发布 active／readyGroups；`:483-486` 在 resource-only 下不启动执行权流程。根只按原方法接线，不能提前宣称执行可用。

完整用例需随根实现一起编写：构造期零 claim／恢复／执行、尚未安装 owner 时不返回假 ACK、所有 callback／receiver 和绑定身份一致、资源 resume 先于执行激活、resource-only 的真实编辑／保存／重建回读，以及原失败／失权／关闭各自的 cleanup 与 ACK。三根和十九个 owner 的全部实现、接线和用例齐备后再集中验证；不为上述构造步骤另开小批实现门。当前只做必要读码与本文格式自查，CI、A-G、CS adapter 和 M0～M4 的实际验收仍分别待完成。

## 先前设计快照（保留）

本实施图沿已批准的 [执行权设计](host-execution-authority.md)，以当前真实调用者为依据。它不把已有端口、十九个测试 handle 或 Task 写入切面的有限 PASS 当成完整 H7／A-G 通过。Task 资源恢复片仍先完成自己的配套门、发布及精确 SHA 的 GitHub 验收；本文件是后续接线的设计候选，尚未实施。

## 已核对的实际缺口

`cli/start.ts` 的 `_createComposedDaemonProviderRuntimeSession` 已转交两个原 factory 数组、七个关闭参与者和 HTTP／WS 生命周期，但没有转交已有 `hostExecutionRuntime` 完整选择。SQLite 和 PostgreSQL 两个 provider root 仍走 native handles，fixture 中十九个匿名 handle 不证明这些生产 owner 已接入。

`task-execution/composition/providerRuntime.ts` 的两个 provider 创建 persistence 时均未转交已有 `hostWrites`。Task claim、业务写入和资源恢复的独立端口虽然已存在，实际根还没有把同一 SO write context、Task adapter、admission 和执行模块配成同一个实例。PG 的执行模块／persistence 可选输入也不能用两个来源拼出一份不匹配的宿主选择。

`cli/start.ts` 的 SQLite boot 与 `cli/postgresqlDaemonApplication.ts` 的 daemon phase 当前直接运行四步 Task boot recovery。后者的 unstarted phase用于原显式未启动应用，不能替代托管 resource-only 生命周期。`server.ts` 的 embedded HTTP 根也必须保持自己的原进程／Task 所有权事实；它不能宣称已取得全局 PID 锁。

部分效果早于 runtime session 接管：`platform/background/maintenanceService.ts` 的 `startMaintenanceService` 会直接调用 `startSupervisor`；MCP 的 `pause` 会先 `await this.start()`，而该 start执行 boot recovery／reconcile；完整 observation report 的 worker stop会 abort原报告 job。因此显式选定宿主时，不能用“先启动再 pause”制造零执行，也不能把所有原 normal stop直接充作 authority-loss。

## 保留原 native 分支，完整组装 selected 分支

原未指定选择的 daemon／embedded 行为保持，包含本地锁、原 boot 时点、配置热读、十九个 factory 的顺序以及七个 close participant 的顺序。原 local authority只借用已经取得的 startup lease，不增加 acquire／release，不提前释放 PID。

显式 selected 选择先固定完整 factory、mode、provider／generation、SO write context与 owner 配对；缺少任何必要方法或配对时在效果前拒绝。不存在用遗漏字段补 native 的路径。共同层只看中立端口，CS DTO、网络和平台租约留在阶段 B 的所属模块 adapter内。

同一根把 SO write context交给 Task 的现成 `createTaskHostWriteContextAdapter`，再把这一个 Task adapter同时交给 persistence、`composeTaskHostExecutionAdmission` 和执行模块。所有 Task route／scheduler／human continuation／后台消费者捕获这份模块和 persistence；SQLite selected 也使用独立的完整模块实例，不能把宿主写入绑定交给原进程级 native 单例。

SQLite 的闭合还包括原直接调用者：`services/task.ts:1235` 的 `createTaskDriveCoordinator` 会在 `:1315` 再调用原 `createDatabaseTaskDriverLifecyclePort`，该便利装配固定使用进程级模块。`task-execution/infrastructure/fusionEngineTaskOperations.ts` 的 launch沿原 `startTask`，cancel沿 `composeTaskCancellation`；后者同样新建 native persistence并使用全局 stop registry。因此仅替换 providerRuntime 的返回 module不够。selected 必须将同一 provider 的具名 drive lifecycle／persistence 与 cancellation带到这些实际 launch、resume、retry、human continuation和 fusion路径；未指定选择保留原便利装配。TaskEngine 的原 native legacyConnection以及 claim／release业务语义保持，不把 SQLite选中模式改称 PostgreSQL部署形态。

Task boot preparation使用同一实际 grant下的 preparing receipt和已有恢复 closed views；原 prepare／reap／lease repair／finalize顺序、原四个独立层次的写入原子及报告保持。执行组只有在实际 preparation、driver activate和 owner start全部 ACK后才就绪。周期恢复只在 active grant下使用现有 periodic views。write-context控制发生在业务事务外，业务消费仍加入各自原事务。

resource-only不 claim、不运行执行 boot recovery、不创建执行 supervisor或派发后台效果；资源 HTTP／WS、资源保存与 dispose／rebuild后的回读仍可用。明确保留资源初始化与执行恢复的职责，不能把资源可编辑当作 execution active。三根及所有子根共享同一 binding的实例和 generation，不通过名称相同猜配对。

## 启动前构造、排空与状态读面的具体边界

选定 Task provider 输入以一份完整宿主选择为装配单位，包含 Task admission 与同一 SO context／participant 适配出的 write binding。两个 provider 都在创建 persistence 时转交这一份 write binding，再创建该 persistence 对应的 execution module。SQLite 显式选择使用该模块的 claim／runtime registry／stop／background；原未选择分支保持原进程级单例、legacy connection 和原 native launch。PG 显式选择不接受来自另一 persistence 的可选 module；不通过补一半默认值配对。

Maintenance 的冷分支只建立资源状态读面及关闭所有权，不能调用原 `startSupervisor`、安装执行 ticker、排入 boot admission。激活后建立实际原 supervisor 和同一 admission／schedule 实例。原 `maintenanceWorkerSupervisor.ts:434` 的普通 pause 用 10 秒预算排空，超时会 terminate 并 resolve；这个原 native 政策保持，但不能用该返回值冒称 authority-loss 的实际在途 ACK。选定 loss 必须提供独立停止新 admission／worker claim 的生命周期，等待实际 drain ACK；超时应保留未结算状态和失败，不能重新派发同一批旧工作。

MCP 选定 resource-only 不能通过原 pause／shutdown 去关闭一个尚未启动的应用：这两者先执行 start，进而调用 bootRecover 和 reconcile。复用已有冷 dispose，并为 selected start／loss 分别绑定原 application 实例、current callback 与实际 running-turn ACK。普通 stop／pause 的既有取消职责保持；失权时不能将停止新测试受理解释成主动取消已有测试。

MCP 原 `latest`／`get`／`sessionView` 也先 `await this.start()`（resource-catalog/application/mcps/runtimeDiagnostics.ts:473、484、500）。因此仅改启动 handle 仍不满足资源模式：selected 查询必须读取原持久状态和会话页，而不通过查询隐式执行 bootRecover／reconcile／安装 timer。这个差异明确在所属 application／composition 的独立生命周期选择内实现；原未指定选择的查询仍保持原启动语义。资源修改造成的原配置失效、会话投影与实际执行取消也要分别保持业务职责，不能将整个 resource-catalog 管理面停掉。

完整 report 的原 `worker.stop` 会 abort 已有 report job，且原冷 service 仍接受 request。选定分支必须分别提供“可查询旧报告”“能否受理／claim 新构建”“等待已受理构建收据”三个面，按同一 observation grant 开闭受理；loss 不调用普通 abort stop 代替 drain。after-commit pump 同样需要暴露其真实 projection tail 并登记／解除同一 pump，不能以原空 drain 代签已排空。

原 report `status` 读取也会对非 failed旧报告调用 claim并 schedule（run-observability/application/completeObservationReportService.ts:175），所以冷分支必须让它读取实际持久状态，不能靠只挡 request漏掉查询引发的新构建。原 native failed读面仍只展示失败、显式 request才重试；正常关闭继续原 abort政策。

SO write context 的 durable prepare／activate／renew／drain／retire 必须在真实根接成同一生命周期，不能只有 Task 消费侧而没有控制侧。控制调用保持在业务事务之外；prepare 使用实际宿主绑定提供的 holder／expiresAt 和原 opaque grant，根不解析 CS DTO，也不猜测平台租约到期时间。退役必须等旧 runtime、recovery 和全部 admitted ACK 结算；原 SO `recovery.drain` 早于 admitted ACK 等待，不能在其中提前 retire write receipt。失败保留控制进度和未 ACK 的原对象。重新构建 provider 时必须验证既有 durable context 如何闭合与接管，不把进程内 WeakMap 的不存在当成旧 context 已关闭。

控制侧先按 [SO写上下文生命周期设计](host-write-lifecycle-control.md) 完成独立中立接线，再和 provider实例、十九个 owner及三根配对。该片保留未结算 predecessor的明确拒绝；M1前实际 durable-intent接管和跨进程旧收据对账仍需独立验收，不能因控制方法已存在而跳过。

现有 `HostExecutionAvailabilityQueries.snapshot` 已提供 phase／generation／readyGroups／reason，但三个生产根尚未暴露这一查询；现有 `/api/daemon` 仍只返回有效 host／port／URL。新增面使用中立执行状态合同并消费根的同一查询，保持既有 daemon 地址查询语义。任务启动、续跑、人工继续、系统测试和各组新执行请求在受理前返回明确的未就绪状态；资源编辑、保存、读取和已有收据展示保留。前端沿现有 query／公共按钮与提示组件消费分组状态，并补 zh／en 文案；禁用只反映当前组尚未就绪，不能把“编辑成功”当成派发成功。

## 十九个实际 owner 的绑定库存

以下是当前 `cli/start.ts` 的真实 factory ID，组别按业务职责列出；现有匿名 fixture的组别向量不代替此库存。每个 selected handle必须保留 owner的原实例、callback及 receiver，在 start之前固定当前 grant，区分 normal stop与 authority-loss，并等待同一个 lifetime的实际 drain ACK。

| 实际 ID                      | 就绪组           | 接线要求                                                                          |
| ---------------------------- | ---------------- | --------------------------------------------------------------------------------- |
| `intent-queued-resumption`   | intent           | 复用 `startAuthority`，停止新批次，保留尚未准入的 queued IDs，等待原 batch        |
| `task-execution`             | task             | 复用完整 `startAuthority`，转交同 grant的资源恢复选择，使用原 loss quiesce／drain |
| `maintenance`                | maintenance      | 选定模式冷构造；激活后才创建 supervisor；loss和原 provider pause分开              |
| `mcp-runtime-tests`          | diagnostics      | 冷状态资源查询／关闭不得隐式 start；手动测试和 reconcile同属该 owner              |
| `observation-reports`        | observation      | 原报告查询保留；新报告受理和已有 job的停止／ACK按 owner生命周期接线               |
| `webhook-terminal-control`   | event-dispatch   | 复用已有独立 `quiesceAuthorityLoss`／`drainAuthorityLoss`，不借 `abortAll`        |
| `after-commit-event-pump`    | event-dispatch   | 注册／解除原 pump实例；停止派发后等待实际在途回调，不冒称空 drain为已结算         |
| `human-gate-continuation`    | task             | 继续驱动已有 continuation，保留实际 context／写入 views；loss只停止新驱动         |
| `committed-event-dispatcher` | event-dispatch   | 原 claim／投递／projection ACK，停新批次并等待原在途消费者                        |
| `memory-distill`             | memory           | 同一原 distill worker；停止新处理和观察，保留已发效果及实际收据                   |
| `development-wake`           | development      | 同一原 automation worker；候选读后仍检查同 grant，保留原 ACK和错误策略            |
| `digital-employee-os`        | digital-employee | 同一原 cycle及 bounded step policy；旧在途 cycle排空后才允许新代                  |
| `event-center`               | event-dispatch   | 同一原 event cycle和实际 Task／Reaction入口，保持持久投递与去重                   |
| `fusion-reconcile`           | knowledge        | 同一原 reconcile动作，不把失权改成业务失败或取消                                  |
| `resource-limits`            | maintenance      | 原额度治理动作与逐项写入保持，新 tick受当前 grant约束                             |
| `task-idle-timeout`          | task             | 原热读设置、候选扫描和精确终止对象；loss不得变成批量终止                          |
| `scheduled-backup`           | maintenance      | 首次启动等待原配置，停 ticker后等待原 `awaitIdle`；配置通知寿命匹配               |
| `submodule-refresh`          | maintenance      | 原配置／通知和原刷新实例；停后等待同一 ticker，不取消别人的工作                   |
| `batch-import-gc`            | maintenance      | 原逐 start retention热读、同一原 GC lifetime和 drain                              |

两组 factory数组仍保留原顺序，不通过统一循环重新推导各 owner政策。普通 polling可复用已存在的 authority polling binding；涉及执行、远程请求、原停止会取消业务的 owner必须提供自己的 loss面。不能靠一个通用 normal pause包装器宣称全部十九个 owner已完成。

## 必须取得的实际证据

新回归使用两个真实 provider和真实 production roots／owner callbacks，分别核对 native原序列、selected resource-only零执行、preparation／activate／start ACK顺序、同一 write-context实例、全部十九个 ID和实际组别、所有子根及 embedded的原所有权语义。

在真实配置读、claim、start、投递和业务写入等待处触发 loss，验证先关闭新派发再排空、资源编辑保持、原 Task／continuation和收据不被批量取消；旧 lifetime全部 ACK之前不能建立新代。正常 pause／handoff／shutdown继续原取消和关闭职责。各阶段失败保留原对象、各自进度与可重试边界，不重发已确认效果。

所有原 native案例、断言和预算保留；根的源码 oracle若需适应新增 selected分支，使用有限、可核对的完整原结构恢复，不把原判断改成更弱的包含检查。新公共合同、实际 owner和依赖差异随原生成规则记录，阶段 A功能门及精确 SHA CI独立验收后，才开始各层 CS adapter。B保持 M0先实际部署、再逐项 M1～M4，完整目标与验收范围不缩小。
