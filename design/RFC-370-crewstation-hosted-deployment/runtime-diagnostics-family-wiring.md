# A-T5：Runtime 管理诊断完整能力接线

沿用已批准的 RFC-370 两阶段顺序和 [smoke 共同核心](./runtime-smoke-common-core.md)。本批关闭 Runtime 管理的普通 probe／smoke／model discovery 调用与双 provider HTTP 根；不包含 MCP 测试台、doctor、脚本、H7、完整 A-G 或 CS adapter。

## 1. 原行为与边界

以已提交 `388b4d9230e67f2c2bdfea5d50e224c641d33484` 为原行为来源。`runtime-management/application/runtimeManagement.ts` 的 create／update／enable／remove／list／status／probe／models 算法、配置读取次数与等待位置、能力验证顺序、原错误和 registry receipt fencing 全部保持。正常 composition 当前自动创建本机 effects；drivers 与 modelDiscovery 在普通端口传递解释为可执行程序的 binary 字符串，这一位置需要选择完整目标与执行能力。

`services/runtimeSmoke.ts` 的原生公开 API、三份声明、buildSmokePlan 和前置 logger／timeout／driver／nonce／workspace 读取顺序保留；已有完整 `runRuntimeSmokeCore` 是唯一 stream／分类／deadline／释放算法。旧 native API 继续用于原直接子进程用例。新增正常族不经旧 native facade，但调用同一个 core 和同一个已迁出的 native material builder。

## 2. RM 目标与普通端口

RM application-owned `RuntimeDiagnosticTarget` 提供 protocol、展示 label、receiptKey 和不透明 runtimeBinding。label 只投影到既有 API 的 binary 字段；receiptKey 只进入既有 probe receipt 比较与 registry 存储。业务层不把二者用作执行程序或文件路径。完整 target 对象转交所选 status／smoke／models 能力；不按 label 反查目标，也没有本机 fallback。

普通 drivers 的 resolve 返回上述 target，capture 接收 unsaved profile 的 authored binaryPath 并由所选能力解释；probeStatus 接收 target。普通 smoke request 用 target 替代可执行 binaryPath，保留当期 authored config 快照、model、extraArgs 和 isSandbox。modelDiscovery 的 resolve 返回同一 dialect 的 target，list 接收 target。原接口响应与 profile schema／row／registry probe 结构不变，原生 adapter 的 label／receiptKey 等于原实际 resolved binary，故本机 receipt 和 UI 行为逐项保持。

native targets 的 WeakMap 私有保存实际 binary，仅选中的 native material／probe／model adapter 可以读取。resolve 继续在原调用位置运行原 defaultBinary 判定；model resolve 继续先 getRuntimeDriver，且仍在原 try 外。unsaved capture 不查 driver、不访问配置、不创建 workspace；它保留原输入值，driver 仍在原 smoke 调用处读取。所有转发保持真实 receiver，不通过展开 class 实例丢失方法／getter。

## 3. TE 完整 smoke 族

TE 增加必需的 `RuntimeSmokeRunFamily` 和 `RuntimeSmokeInvocationFamily`。正常 run 先读取原 logger 与 timeout，再 open 所选 invocation（本机在这里解析原 driver），再生成原 nonce，最后 materialize 选中 workspace／preparation；appHome 仍由本机根提供 lazy `Paths.root`，在原 nonce 之后读取。prepared intent 保留原 persona、prompt、有序 profile、optional extraArgs、freshAgentRun=false、runtimeBinding 和 nodeRunId。

所选 native definition 使用既有原生 material builder；workspace prepare、一次 compile／bind、evidence、process effect 和 executor cleanup 由同一 preparation 提供。编译、迟绑定、prepare、discard、unreaped、cleanup-failed、session reset 与错误分类继续处于原 core 的边界。普通接口不带 cmd、PID、env 或物理 workspace，native 解释只在 local infrastructure／composition 内。

现有 `runPreparedRuntimeSmoke` 保持公开合同。其完整材料 intent 提取为同一个纯构造 helper，现有入口和新正常族在原调用位置共享它，不复制 smoke 业务算法。不能因共享 helper 提前读取 request 或 preparation getter。

## 4. 显式选择和 fixture

正常 `composeRuntimeManagement` 必需接收完整 `effects`；不自动制造 native effects、不读取 configPath。SQLite `composeSqliteApiRouteMounts` 和 PG `composePostgresqlApplication` 在原唯一 management 装配位置显式选择完整 local Runtime diagnostics family，并传入原配置 reader、probe fence 和 MCP reconciliation participant。root statement 数、phase、构造／启动 lifetime、route 顺序和其他装配保持；只替换这一格，用有限 AST 逆变换恢复原整段。

TE local family 配对 RM target owner、native material／execution 与普通 RM effects；同一 instance 的 refs 贯穿 status／smoke／models。显式 root fixture 继续支持 `runtimeDiagnosticTestDependencies` 原三个字段、缺省和 getter／receiver 语义：smoke fixture 在 local projection 处收到原 native SmokeOptions；beforeProbeCache 和 timeout 原位置读取。普通 hook 保持所选 effects 实例的 receiver；纯 binding helper 只向显式 bootstrap 暴露当次 application deps。本机根在那里恢复原 beforeProbeCache callback field，使原 fixture 继续以实际 deps 为 this；普通 class effects 的 private-field hook 通过真实双 provider 用例单独锁定。没有在普通业务内部以可选 fixture 或 native runner 兜底。fixture 仅代替该次完整 smoke binding，正常族与 native owner 仍成套选定。

## 5. 回归和证据

原 RFC-360 双数据库全部行为断言、原 HTTP fixture、旧 native smoke 子进程用例和预算保留。RFC-360 fixture 只迁移 effects 签名，以单一显式 native compatibility projection 留住原 probes／models 观察值。新用例验证：普通 application 转交 target 身份而不解释 label；异步配置等待与 receiptKey 变化；prototype capability receiver；两个协议的完整 selected smoke intent／compile／bind／release；driver／nonce／home 先后；native missing executable 的真实完整材料及释放；显式 fixture 得到原 options；双 provider HTTP 实际 selected status／unsaved／registered／model 路径。

实际源码 reader 仅随真实入口迁移，旧业务判断、负例、assertion、计数与预算不放宽。W29 使用这一格的完整 AST inverse，不重写旧根摘要以覆盖未知变化。Windows push／PR 路径对称登记新地址及用例，保留原列表和其他用例。

设计／实现门只审 owned 正文和必要的完整合同／actual dependency 片段。源码有效 PASS 后只做一次原 scoped census：四条原规则、旧作者账本／why／order、原 SCC 和实际 counter 保留，如实匹配新增地址与一次性许可；不以 inventory 数量给 A-G 完成信用。本机只做 owned format／lint 和纯 AST／字节证明，不运行 AW tests／typecheck／build／services；正式功能结果由发布后的精确 SHA GitHub CI 验收。

本批发布后继续 MCP diagnostics、专用 Runtime command／doctor、脚本与 H7／全根／public 收口。只有完整 A-G 通过才开始 CS adapter；首个 M0 部署随后先行，M1～M4 按原批准策略增量接入。AW 尚未部署到 CS，RFC 保持 In Progress。

## 6. 首次 hosted CI 的测试配套修复

已发布 Runtime 候选 `2f3807d003c396b344ceddcb0c2278fe86ee90e0` 的主 CI 37420257477 检出功能失败；Windows 37420257425 已终态 failure，不能记整套通过。直接 job 日志定位到本批两个永远抛错 getter 的返回类型推断，以及三处测试配套：新正向 fixture 使用不接受 extraArgs 的协议和空 token；原 RFC-360 回滚 fixture 的 POSIX 路径在 Windows 提前被校验拒绝；原 RFC-135 源码锁仍读取迁移后的薄兼容出口。

本次只显式标注两个 getter 的 RuntimeRegistryOperations 返回类型，将正向 fixture 改为原 driver 支持的 Claude 协议及有效 flag／value，回滚 fixture 复用既有 canonicalBinaryPath，源码 reader 跟随实际 local owner。所有原测试名、断言、失败／回滚判据和时间预算保留，不更改生产校验或执行代码。有限独立功能门和 matching 清单随后记录；新确切 SHA 的 hosted 结果才是功能验收。

日志还存在并行 RFC-371 schema／retained-output 配套失败，以及原 SC iso cleanup 的 5000ms 超时；分别保持原日志，未纳入本次三个 Runtime 测试文件的修复，也不据此宣称整套 CI 通过。MCP 在制输出完整保留，本批不发布。完整阶段 A、A-G、CS adapters 和 M0～M4 继续，尚未部署 AW 到 CS。
