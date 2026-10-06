# RFC-370 MCP 诊断完整 effects 与原生装配

这是阶段 A 的 MCP 完整族源码候选。DESIGN-D1 已有效独立 PASS（25 项，指纹 860a5bcb13ed143c15e46ab0ee19ff294113e48534fb84652c5070dacd200dd5），源码已接线，尚待独立实现门和 hosted CI。普通入口已有完整 McpDiagnosticsEffects；保留同一个 McpDiagnosticsApplication、诊断 operations、context resolver、coordinator 和 persistence／lease，不新建一套 MCP 执行引擎。正式部署和 CS adapter 留阶段 B。

## 必经入口与 owner

resource-catalog/application/mcps 拥有 MCP 测试台业务、queue／receipt／capture、恢复及返回状态；composition/mcpDiagnostics 接收必需的完整 effects，不再继承 native-only configuration／home／runFn／process callbacks 或自动创建本机 effects。resource-catalog/infrastructure/local/mcpDiagnosticsEffects 保留原完整 native 实现；compatibility infrastructure 文件仅转发同一个 local 工厂。新增 composition/localMcpDiagnostics 明确选择该族。迁移三个真正的根：server 的 SQLite HTTP／unstarted slot、postgresqlDaemonApplication 的 daemon／unstarted slot、cli/start 的 SQLite daemon slot。requestBinding、provider persistence、loadMcp、coordinator、工厂生命周期和原控制流不变，显式 native fixture factory 仍使用原参数词汇。现 service／HTTP／real-e2e/lifecycle tests 选择同一 local 工厂；不让 normal 接口带可选 native fallback。

## 所选执行与持久边界

原应用中三个 PID 有无分支改调用 effects.hasExecution(turn)。native 判据逐项仍为原 turn.pid !== null，调用在原判断位置，包含 queued／running 短路；普通 app 不自己解释物理执行字段。原 reap 的调用点、now 读取及 options 保持，改为 reapTurn(turn, readNow)，native 在对应调用处生成完全相同的 pid／startedAt／spawnBinaryPath 参数调用原 process function。reap 的原结果词汇由 resource-catalog 自有闭合合同定义，值和 DB recovery 判定不变，application 不导入 util/process 类型。

quarantined 恢复中原 expectedPid 的解释也留在所选族。effects.recoverReapedTurn({session, turn, readNow}) 是 purpose-specific receipt-qualification 操作；native 内部把同一 turn.id／pid 和同一 now 传入原 persistence.recoverQuarantined。结果、lease repair、广播和 cleanup 仍在原 application 顺序。原 persistence API／native PID columns／DTO 不迁表，adapter 不把 CS UUID 填入 PID；阶段 B 的选定族负责自己的持久执行 binding。

原 runTurn.onSpawned(native receipt) 改为 owner-owned 不透明 turnStart participant。application 在原 execution try 内由完整 effects.captureTurnStart 取得 participant，仅提供 sessionId／turnId 和在回调时读取原 now 的闭包，再传给同一 effects.runTurn。capture 只绑定输入，不读取 clock／driver、不写 DB、不分配 workspace。native owner 私下解码 participant，在原 System run onSpawned 时间点读取 now 并调用原 recordSpawn 的全部字段；false 仍抛同一 mcp-test-spawn-canceled-before-prompt。assertSpawnAllowed 保留原独立业务闭包和全部查询，capture barrier、startup verification、异常／结束状态／cleanup 原样保持。normal fake 或阶段 B adapter 使用同一 participant 身份完成自己的执行登记，不接收 PID callback。

ResolvedTestRuntime 的执行物由 native binary 字符串改为所选 owner target；只保留原 row、display label、snapshotJson。native target 使用 issuer 私有 object-reference→binary 绑定，不从 label 查 executable，也不导出 driver／spawn plan。native resolveRuntime 的配置 await、defaultRuntime、row load、eligibility、driver.defaultBinary、错误顺序与 snapshotJson 全字段／stableJson 字节保持。native 工厂的兼容返回类型可保留原 binary 字段，普通合同和 application 不消费它；原直接 native configuration 测试继续断言同一 binary／snapshot，另加 label／target 的等价断言。application 在原 runtimeBinaryPath snapshot 字段位置投影 label；runTurn 在原 runtime.binary 读取位置用 target 获取本机 binary，包括 fixture override 和原 buildCtx。workspaceReference 已被应用仅持久化／传递，不在应用 join，保留现有不透明引用与 legacy 列名。

## receiver、读取顺序与兼容性

normal constructor 在原位置一次读取 effects.now 与 effects.reapTurn，调用时保持所选 effects 的 class receiver；capacity getter 和其余字段读取位置不移动。native fixture 原 now／reap 回调此前以实际 application 为 receiver：local bootstrap 提供惰性 applicationReceiver，冷构造后指向同一实际 instance，由 local callback projection 使用。原 native createApplication 的完整 spread snapshot、native factory getter/error 顺序及默认 clock/process 函数保持。普通接口不含这个 native 兼容选项。所有 effects 的其他方法保持其 receiver；无以对象 spread 丢失 prototype 的 normal adapter。

## 等价验证与发布边界

保留全部原 service/HTTP/lifecycle/configuration/real-e2e 用例正文、断言、预算和 worker/lease 行为。新增双 provider 真库的 normal prototype family、非本机 target／turnStart identity、callback/read-order、恢复与原 native recordSpawn/capture/startup-verification 证据。必要 fixture 仅迁工厂/signature；不删除旧 case。W29 与 RFC364 源码锁使用三个实际根的严格完整 slot inverse，还原原 callee 后全部原 root body 摘要／语句数量保持。Windows 新路径和用例 push／PR 对称追加，原命令与断言保留。

实现后先有限 SOURCE 功能门，再一次原 scoped census 和13matching＋STATE有限门；原 authored debt／库存顺序／why、SPI／targets／Task effects／SCC和原规则不改。实际新增 native bridge 逐条绑定而不是放宽一般规则，A-T7 明确退役；不以“新增 adapter”消除未完成 debt。仅 owned format/lint、纯 AST/字节/JSON和静态生成，不运行本机 AW tests/typecheck/build/service。正式功能结果取确切SHA hosted Linux/macOS/Windows与双 provider CI。后续 command／doctor／脚本、H7背景与全根、A-T7／A-G仍需闭合；通过 A-G 后实施 CS M0 必须能力与首次部署，再逐项 M1～M4。

## 实施接口记录

原生 receipt 字段的 getter／错误必须先于 clock 读取，reapTurn 与 recoverReapedTurn 接收一次性 readNow 闭包，在 local projection 的原字段读取后求值。turnStart 同样捕获 session／turn 引用，不提前读取原回调中的 id；原登记时再读取。D1 的目的、生命周期和原判断保持，这些具体签名避免复制 ID 或时间造成读取时序变化。原三个根分别是 composeSqliteApplicationDeps、composePostgresqlApplication 与 composeSqliteProviderSession；完整原根 body 和参数的逆向摘要作为回归，不改原 W29 常量。

## 有限源码核对

17 组显式 app／port 差额对原全文的 AST 投影通过；原 native effects 完整逆变换、整个原 admission 回调及全部 runtime graph／生命周期语句保持。三个真实根的原参数、完整 body 摘要和语句数量通过严格逆向核对，W29 原 phase 摘要逐项与原候选一致；七份原测试／helper 和完整 Windows 配置的逆变换通过，原所有用例／断言／预算保持。原证明工具第一轮只漏识别 PG 的 conditional callee，未进入功能门；原错误留证，改为原唯一 identifier 的精确逆变换后通过。

这几项仅为纯 AST／字节证明，不运行 AW tests／typecheck／build／services，不代替源码门或 hosted CI。前一 Runtime CI 修复已发布098481069d318c4d08c7515cf612afe2c4f85f4f，Windows37424916827已终态success，主CI37424916817尚未结束。本批 SOURCE／matching／新 exact-SHA CI 分别留证，完整 A-G 与 CS首次部署仍未通过。

新增 selected-family 用例在各自 test callback 的 finally 内 dispose 实际 application，然后才让原 provider harness 恢复 binding。没有改变原 harness、生命周期 API 或业务时间预算；这避免把残留 service 的 DB 调用留到 provider cleanup 之后。该修正只触及新增用例，原七份测试／helper 的完整逆变换仍成立。
