# H7：真实启动根与 owner 生命周期接线

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
