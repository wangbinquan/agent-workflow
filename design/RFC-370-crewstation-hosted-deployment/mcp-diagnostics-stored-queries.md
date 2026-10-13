# MCP 诊断：独立持久查询面

## 2026-10-13 生命周期接续实现

同一 application 已继续增加 host 生命周期候选，详见 [H7 最新进度](host-execution-root-assembly.md)。host 装配自动选取三个 stored queries，并拒绝显式要求 native 查询启动的矛盾选择。资源 CRUD 的事务仍记录原清理意图；没有执行 lifetime 时不启动 reconcile／进程／timer，删除的真实清理屏障仍拒绝未完成清理的会话。

`runtimeDiagnosticsExecution.ts` 捕获原 current receiver 和完整操作尾部；`runtimeDiagnostics.ts` 保留 native 入口，新增 host 启动、失权、正常 pause 和处置路径。尚未发出运行时请求的原 queued 意图可以由下一 lifetime 接续，已发请求必须结算其原结果。`deferUnspawnedTurn` 不改写真实执行收据，`claimPending` 不夺取另一测试或仍在持有的 lease。新增用例覆盖两种模式的公开查询、真实目录变更及应用重建、boot／runtime read／claim 时失权、capture／verification／release／通知排空、异步 timer、普通取消及不确定执行拒绝 ACK。所有用例尚未运行；此更新不关闭实际三根接线及 RFC 验收。下面有限冷读设计和旧逐片门记录保留为历史。

## 2026-10-13 实施进度

用户要求恢复 RFC 实施后，已按下述合同新增 `runtimeDiagnosticsQueries.ts`，同一 application 的 `storedQueries` 与原三个 native 入口共用 private 读取 helper；composition 的显式选择只返回该实例自己的完整查询对象，不另建应用或后台生命周期。`queryMode: 'stored'` 一次选择三个持久查询并保留原 request context、可见资源查询和 coordinator；未指定选择继续原 native 路径。既有 caller 类型从原模块继续导出，原消费者不需改动。

已编写双 provider 回归，覆盖 queued／capture live 和 complete 的真实存储、转录内容及 cursor、读取前后四张原表保持、缺失记录错误，以及 native 原 start／reconcile 顺序；公共操作回归使用同一真实 identity runtime、catalog、coordinator 与存储。用例尚未执行，查询面还未替代真实托管根的操作装配。后续按现行硬规则完成整个宿主候选及用例后集中验证；下方旧逐片门禁安排不再作为执行流程。本记录不关闭 MCP owner、十九个 owner、三根、A-G 或 CS 部署验收。

## 原设计记录

状态：有限设计候选，尚未通过设计门、实施或发布。本片承接 [H7 启动根设计](host-execution-root-assembly.md) 中的 MCP resource-only 查询要求；先抽出完整的持久查询面，后续再接同一 application 的 selected 执行生命周期。本片不能代签 MCP owner 排空、十九个 owner、三启动根、A-T7／A-G、CS adapter、M0～M4 或 RFC 完成。

## 当前行为与问题

`packages/backend/src/modules/resource-catalog/application/mcps/runtimeDiagnostics.ts:469-533` 中，`latest` 和 `get` 先等待 `start`、再等待 `reconcile`；`sessionView` 先等待 `start`。原 `start` 会执行 `bootRecover`、`reconcileCore` 并安装后台 timer。用户在 selected resource-only 状态读取旧测试记录，不能因为这些查询而执行恢复、写会话状态或启动后台工作。

原查询随后使用同一 `McpRuntimeTestPersistence` 读取 session、turns、事件及 cursor，并运行原 DTO／session-tree 投影。该事实读取与投影已经存在，所缺的是能独立选择的 application 查询合同。原 native 查询的隐式启动、对账和原错误传播继续保持。

`composition/mcpDiagnostics.ts` 当前将同一 application 交给 `createMcpDiagnosticsOperations`，后者已经以 `Pick` 接受三条查询和四条命令，再保留原 contexts、coordinator 与 visible-resource 解析。现有 local composition 对 configuration 的热读、effects 的 receiver 和 application callback receiver 也已经显式配对；本片不改这些装配。

## 独立合同与单份查询实现

在 resource-catalog 的 application/mcps 层定义完整 `McpDiagnosticsStoredQueries`，只包含 `latest(actor, mcpId)`、`get(actor, mcpId, sessionId)` 和 `sessionView(actor, mcpId, sessionId)`。参数及 Promise 结果沿现有三方法的原类型。接口不出现 DB、进程、CS DTO、租约或网络对象。

同一 `McpDiagnosticsApplication` 提供只读、冻结的 `storedQueries` 对象。三个回调固定该 application 实例，委托三个所属 private 读取 helper；创建对象只构造闭包，不调用 persistence、effects、start、reconcile 或 timer。每个 application 拥有自己的对象，不能借用进程级单例或另一 provider 的查询面。

原三个 public 方法保持原 `await start`／`await reconcile` 的顺序，然后委托同一读取 helper。把原查询在启动后的完整正文移入 helper，保留原 persistence 方法、读取顺序、参数、实际 receiver、session ownership 判定、错误类型／消息、DTO 和 session-tree 投影。`project`、`requireSession` 及各实际持久方法继续使用该 application 的原依赖；不能提前读取或固定 native 原本在调用时获取的 getter，也不复制出第二套投影规则。

composition 提供一个明确的完整查询面导出，返回这一个 application 的 `storedQueries`，不创建第二个 application、effects 或 coordinator。普通 `createMcpDiagnosticsApplication`／`composeMcpDiagnostics`／`bindMcpDiagnosticsRuntime` 的结果和调用顺序继续保持；本片不把新读面偷偷装进原 native operations。后续 selected 装配必须一次性选择完整三方法，而不是让遗漏方法回退 native 查询。

持久查询读的是原实际存储状态：旧 queued／running／ending、capture 状态、sessionVersion、错误和 event cursor 都如实投影。它不执行写入式恢复，也不另外推断一个新的“应当已经结束”状态。真正取得执行权后的原恢复仍负责对账。两条读取面的数据规则共享；启动和对账时点由各自明确入口负责。

## 有限实施与验证

生产改动只涉及新 application 查询合同、`runtimeDiagnostics.ts` 的三个读取 helper／实例查询对象，以及所属 composition 的明确导出。保持所有其它命令、普通 pause／resume／stop／shutdown／dispose、boot recovery、lease、queue、executeTurn 和定时策略的原完整内容。现有 public 基接口及 native 调用者不能被要求传一个新的可选 CS 字段。

新增有实际行为区分的查询回归：在原两个真实 provider 中存入原有效 session／queued turn／capture event 数据，再从从未启动的同一 application 读取 latest、get、sessionView；核对实际 DTO、树、cursor，以及读取前后完整持久事实一致。把 boot／reconcile／timer／execution 入口设为意外调用即失败，证明查询没有借隐式启动完成。另覆盖未找到记录的原错误、同一 application 的查询实例和原 native 查询仍先启动／对账的实际序列。不要使用空 DTO 或同一实现输出当期望值来代替原持久事实。

原 RFC-238／RFC-359／RFC-370 MCP 用例的正文、断言、预算及 provider 分派保留；涉及源码 oracle 的差异必须能完整逆回原三个查询正文，不弱化为包含判断。新增套件按真实定义统计预计运行数，保持所有原预算；只在发布后的 GitHub 精确 SHA 主 CI、默认完整 Windows 及适用 provider 作业中取得实际运行证据。本机不运行 AW 产品、测试、typecheck、build、服务或 E2E。

设计门通过后才实施；实现门通过后使用原生成规则建立只包含本片已批准生产／测试 TS 的候选来源闭包，取得一次原 census 和有限 MATCHING 结论。实际增量仅据生成结果声明、普通提交退役。共享 STATE、Windows 与架构配套按当前并行内容和短发布窗口处理，不覆盖累计使用量缓存、脑图或其它会话的产物。

## 后续 selected owner 仍需完成

本片只解决独立读取原持久状态。命令在 resource-only 状态的明确未就绪返回、同一 application／current callback 的 selected start、失权后停止新测试与 reconcile／timer、实际 ACK、普通业务取消，以及真实根接线都仍需独立设计、实施和验收，不能用本片的查询 PASS 宣称这些已经可用。

后续实际 ACK 至少包含已发出的命令持久写入、启动恢复／对账、队列执行、事件 sink／广播、`nextDeadline` 的异步查询、验证、原 lease release、settleTurn 和 cleanup 尾部。失权不调用原 shutdown／pause 的持久取消来假装排空；新代必须等实际旧尾部结算。超时保留原对象和未 ACK 状态。原 `recoverBootSession` 会按既有 daemon-restarted 规则处理旧未终态 turn，本片不将该行为改成自动重发测试。
