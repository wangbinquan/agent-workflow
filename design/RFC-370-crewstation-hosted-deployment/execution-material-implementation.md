# H4／H5 执行与材料实施设计

状态：实施设计候选，2026-10-05；尚未实现或通过 A-T5／A-G。沿用已批准的主设计 §5 和 A→A-G→B/M0～M4 顺序。本设计补足 [实际调用者清单](./execution-material-callers.md)，不引入 CS 生产实现，不改变 standalone 的协议、结果、执行权或恢复规则。

AW 原行为基准为 `6521ab0ffc20df0f5dbbb08ca92ebab451d614ac`，相关执行源码与清单基准 `bba36c896` 相同。CS 合同只读其已提交 `d2b9356953b82391924f79518a890f71fd6b27d9`：`packages/contracts/api/business/requests.ts`、`packages/contracts/taskrunner/businessExecution.ts`；私有逐文件摘要见 `aw-rfc370-execution-material-cs-committed-evidence.json`。这些事实用于防止提前设计成 raw command 转发，不代表 B1／B2 已验收。

## 1. 交付单元和职责

本批 Agent 的最小完整交付单元同时覆盖 runner、systemAgentRun、runtimeSmoke 的材料、执行和取证调用。业务节点、工作组 host/member、fan-out、merge 等沿原节点执行链进入 runner；系统路径覆盖 Intent、distill/schedule、change narrative、MCP 测试台及其 diagnostics。只替换主 runner 不能通过本单元。脚本和专用 command 随后以各自 owner 的材料需求接入同一执行机制，未完成前不关闭整个 A-T5。

| 职责                 | owner 和落位                                                                   | 允许持有的事实                                                                                       |
| -------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 协议和 profile       | runtime-management domain/application；exact public types/participants         | 双协议静态能力、纯事件解析、native session 策略、冻结的完整 profile                                  |
| Agent 材料           | runtime-management application/ports 与 infrastructure/local                   | 中立编译请求和材料引用；本机实现内部才持有目录、binary、env、argv、stdin 和物化文件                  |
| 执行意图和结果       | task-execution application/ports；原 NodeExecutor/ExecutionKernel 协作         | aw 执行身份、材料/工作区引用、attempt/generation、取消理由、原结果规则                               |
| 本机进程机制         | platform/execution/local                                                       | 原 managedProcess 的 gated/direct 分支、PID/nonce、stream pump、TERM/KILL/reap；没有 Task 业务状态机 |
| effect 与 receipt    | task-execution 原 application/persistence；本机投影在本域 infrastructure/local | 原认领/代数/资源占用/结算；适配器把本机 receipt 投影到原持久格式                                     |
| 会话/usage/span 取证 | runtime-management 的独立 evidence port 与 local 实现                          | 实际来源、捕获完整性与规范事件；业务调用者不直接读本机 transcript/database                           |

composition 选定材料、执行、取证和 receipt participant 的相容组合，再传给业务入口。未知组合在物化/创建 effect 前返回原可归因的准备失败；选中非本机组合不重新从全局 registry 或 Paths 获得 native 实现。协议种类和目标种类保持正交。可替换接口不包含 RuntimeDriver 整对象、CS DTO 或任意 JSON execution payload。

## 2. 冻结材料输入

`AgentMaterialIntent` 是 AW 拥有的完整请求；它不直接复用带路径和函数的旧 AgentSpawnContext。逐项输入映射如下：

| 原输入                     | 中立请求                                                  | 本机等价要求                                                                                   |
| -------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| injection.agent/dependents | 根和完整依赖闭包的冻结声明，保持 BFS 顺序                 | 原 renderer 看到同一 root 和所有 dependents，不仅一个模型                                      |
| resolvedParamsByAgent      | 有序、只读的 name/profile 条目；保持根与依赖、null 与缺省 | 在 local 内恢复原只读 Map 输入；禁止重新读 mutable registry                                    |
| MCP/plugins/skills         | 完整声明、配置及 owner-owned 内容引用/版本                | 由所选 H6 读取；技能 sourcePath/readContentVersion 留 local 解释，保留原版本读取时点和失败分类 |
| prompt/systemPrompt/memory | 原最终文本及明确的 omitted/null 状态                      | memory weave、stdin 或 argv 交付沿各协议原计算                                                 |
| cwd/runRoot/taskMounts     | workspaceRef、runContentRef、完整 mount references        | 仅 local 解析为原路径；区分 taskMounts 缺省和显式列表，保留业务/系统原分支                     |
| configDir                  | 可选的冻结 profile，区分省略和显式值                      | 系统省略仍使用旧默认；不擅自补 DEFAULT_CONFIG_DIR_PROFILE                                      |
| runtimeBinary/extraArgs    | 冻结 runtime binding 和已有合法参数                       | local binding 保持原 binary；不在恢复时重新选择 runtime                                        |
| fresh/nativeSession/resume | 三项独立事实                                              | 原 fresh 物化策略、首轮 session 与 resume 的互斥/错误保持                                      |
| Git identity               | 原冻结用户名/邮件事实                                     | 仍由 local 形成原 child env，不借当前仓库 ambient identity                                     |
| nodeRunId/log              | aw 关联身份和日志接口                                     | 不改变原消息、节点身份和诊断分类                                                               |

`binaryOverride`、`boundaryHostProbe`、`testPlanOverride` 仅存在于本机测试 fixture 装配，不能成为生产中立请求的逃逸字段。原生产 buildCtx 转成中立材料输入的定制，MCP 每轮 run root 使用逻辑子引用；wrapPlan 转成 only admission/cleanup 的 lifecycle participant。实际 MCP 行为必须先固定再迁移，不能删除现 hook。

编译输出 `PreparedAgentMaterial` 包含不透明 materialRef、同一计算产生的 declared manifest、实际支持的 evidence capabilities，以及运行/取证生命周期所需的中立 participant。cmd/env/stdin/物理路径不回到业务层。声明失败的原 degrade 和真正物化失败的原 fatal 路径仍分别保留；不允许为声明单独再算一份与注入不同的材料。

## 3. 中立执行合同和本机实现

保持主设计拟议 `ExecutionEffectPort.submit / inspect / readEvents / sendMessage / cancel`。冻结请求包含 aw owner/run、逻辑 execution identity、材料/工作区引用、当前业务 attempt/generation、timeout 与 capture 要求；引用由 adapter binding 解析，任何一层都不能把 CS UUID 当 aw ULID，或把远端 execution ID 写入 PID。

执行引用绑定整次尝试，不允许 inspect/cancel/readEvents 在每次调用重新选择 target。能力没有实现时按 typed unsupported 报告；本机一次性 stdin 不伪造 interactive sendMessage 成功。新增 public 方法须有实际消费者，不能为后续 CS 先导出未消费合同。

本机 submit 仍复用原 managedProcess，没有第二套计时器或 kill 算法。local binding 明确保留原两条启动路径；`requireSpawnReceipt` 的原值是本机装配事实，不升级为所有执行的共同要求。

| 原路径                                        | 原执行顺序与 receipt 来源                                                                                                                                                                      | 适配后的等价约束                                                                                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task Agent（及后续 Task script）的 gated 路径 | 原 beforeSpawn 完成 effect prepare/acquire 与 observation admission/baseline；`requireSpawnReceipt=true` 创建 launcher/nonce；等待原 recordProcessSpawn 后才激活 target、投递 stdin 和读取输出 | 保留原 launcher PID/binary/nonce 及 required callback；拒绝沿原 activation failure、abort/reap 和结果分类；不增加另一层 launcher                                                 |
| system Agent/MCP 的 direct 路径               | 原 beforeSpawn 后直接启动真实 target；可选 onSpawned 收到原 target PID/binary，等原 owner receipt/admission 回调返回后才投递 stdin 和读取输出                                                  | target 在 receipt ACK 前已创建并可运行，不能宣称尚未激活；不增加 nonce、launcher 或合成 receipt；原 Agent 回调失败记 receiptFailed 并 abort，system/MCP 保留原 spawn-failed 分类 |
| ownerless runtimeSmoke 的 direct 路径         | 沿原 beforeSpawn/cleanup 直接启动 target；原本没有 onSpawned，也没有 required receipt                                                                                                          | 继续允许缺省 callback；不要求新的 admission 或伪造持久成功，保留原诊断、退出和 cleanup 分类                                                                                      |

逐行/chunk 仍串行等待原回调完成其既有处理，失败政策由原调用者保持。Task 的原 fatal capture、effect receipt，以及 MCP authoritative root/receipt 失败继续终止原执行；不能丢弃原首错。普通 system Agent 的辅助 eventSink.append 失败则沿原 failSink 标记 incomplete，保留有效 eventText、session 与业务结果。markTerminal 写入失败保留原 complete/incomplete 意图、日志和 finally 重试；失败本身不置 sinkFailed 或改变意图，只有原 failSink/unreaped 等 incomplete 原因才升级为 incomplete。因此正常 complete 首写失败、重试成功仍为 complete；append 失败后的 incomplete 重试成功仍为 incomplete。两者均不将有效 Intent/Memory envelope 改成执行失败。原 managedProcess 的可选 receipt best-effort 与 Agent wrapper 的 abort 处理也不合并为一条新政策。

readEvents 的消费确认覆盖原 line/chunk await。continuation 在原回调完成既有 fatal/degrade 处理后推进：fatal 拒绝不 ACK，辅助取证失败经原处理后可继续，但不得宣称 capture complete。不能先 ACK 再异步调用原回调；ACK 不等于所有辅助证据均持久成功。本机背压继续由原 bounded pump 实现，CS 后继 durable transport 的 ACK 另按阶段 B 合同证明，不反向改写本机失败规则。

真实退出但 drainTimedOut 的尾流缺失仍与 child-unkillable/unreaped 区分，保留原 exitCode、完整性事实和业务结果域规则。按各入口既有顺序捕获 native 证据、停止 live capture 和释放材料；未 reap 仍留现场。不能仅因流结束或 submit 成功合成 terminal success。

local-process receipt 对业务暴露 aw reference 和原结果事实。PID/binary/nonce 的兼容 DB/UI/恢复投影只由本机 participant 读写；已有非本机实现尚不存在，此时不新增 hosted 表、remote worker 或恢复算法。

## 4. 原 effect 身份保持

`processEffectObserver` 原 application 保留 readLineage、slotPath/fallback、managed-agent/script stableActionOrdinal、nextOperationGeneration、资源排队、token 和 settle 规则。改为接收所选实现提供的中立 request fingerprint/资源占用描述，不在 application 构造 argv/cwd 或 native receipt。

本机 participant 从其真实材料计算原 `requestHash({v:1, processKind, argv, cwd})`，保持字节/身份；writer workspace key 仍由原物理 workspace 值生成，read-only 保持原并发。原 recoveryClass/classifier/transportPolicyVersion 和 receipt JSON 通过 local 投影保持，不能以抽端口为由给历史过程换身份或允许新重试。对照须用相同真实材料，不能只检查 hash 长度。

Task-owned receipt 必须走原 effect/attempt/node 的同一持久路径。ownerless 系统 fixture 保留原形态；生产系统 owner 的 receipt/admission 不能由 fixture 分支接管。持久接口、业务意图和真实恢复 reader 的接线属于同一候选验收，不能只隐藏输入类型后仍由业务层读取 PID。

## 5. RuntimeDriver 拆分范围

纯 parseEvent、observeSystemEvent、parseTerminalResultError、detectSessionNotFound、session 策略和静态 capabilities 保持协议职责。getRuntimeDriver 的现 singleton identity、未知协议抛错、tryGetRuntimeDriver 的显示降级暂留兼容入口；新增正常执行链不从它选 physical target。

buildSpawn 的完整双协议物化进入 runtime-management local 材料实现。两条 persona/business 原体和 renderer/spawnCtx 的省略语义保留；不是把 buildSpawn 单函数委托另起一个包装后便记完成。

prepareUsageNormalizer、prepareNativeUsageCapture、prepareSpanCapture、readInventory、drainFinalEvents、captureSessions、captureSessionsToSink 和 startLiveCapture 全部从 selected material/evidence binding 取得。env、runRoot、native database/transcript path 留 local；业务侧继续消费原规范 usage/span/session/startup 事实和完整性声明。缺省能力仍缺省，不新增假 empty/complete。probe/models/cache eviction 在 A6 按 runtime-management 自己的 purpose port 接线，不装入 Task 业务引擎。

本地材料释放不会早于原 native capture。系统成功保留 scratch、测试台每轮文件与会话目录保留、失败/未 reap/quarantine 的原政策分别固定，不使用一个统一“finally 全删”替代。

## 6. 真根与全消费者接线

| 链路               | 必须贯穿的装配                                                                                     | 有限单元退出证明                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 普通 Task/复杂节点 | 两 provider、serve/start、HTTP completed deps、Task options、各 childLaunch/workgroup/fan-out lane | 同一 selected binding 到 runNode；非本机 fixture 不触碰 local 材料/进程 |
| Intent             | composition→turnEngine→runSystemAgent 及各 turn/恢复入口                                           | 相同 reader/owner、预算和 cancel/session 行为                           |
| Memory             | composition→schedule/distill→runSystemAgent                                                        | schedule 不掉选中实现；原 stream/raw envelope/审批不变                  |
| Narrative          | 真 owner/composition→changeNarrative→runSystemAgent                                                | 原消息、scratch/session 取证和结果分类                                  |
| MCP                | RC composition→diagnostics→runSystemAgent                                                          | 全 buildCtx/wrapPlan/native receipt/admission/cleanup 的实际双协议链    |
| Runtime smoke      | RM probe routes/runtime selection→smokeRuntime                                                     | nonce、stderr/terminal error 分类、原目录/cleanup/reap 保持             |

StartOptions、provider session/recompose 与 effective completed HTTP deps 使用同一 binding，不能不同 leaf 各造默认 local。兼容服务调用可以保留 native 默认，但已提供 selected capability 时不能借缺少 optional 字段回落 native。所有 required public/SPI 需有实际 consumer、local provider 和 composition 三方 owner 登记。

## 7. 验收和批次

Agent 完整候选分成可评审的 source 小提交，但在完整材料、取证、三入口、receipt 和真根接线完成前，不把其中任一小提交记 A5 或 A-G PASS。实施设计门先复核本设计及实际输入/调用清单；源实现另做独立有限功能门。正式行为以新 exact-SHA GitHub CI 为准，不运行本机 AW test/typecheck/build/service。

首个 source 小批先迁移三份真实本机机制到 platform/execution/local，完整函数体保持，旧 Agent/managedProcess 路径仅显式转导相同 API。旧 launcher 路径除显式转导外保留 import.meta.main 的直接 CLI 委托，避免已有按文件启动的 Windows 用例失效；原 compiled launcher embed 入口同步指向新的实际机制。两个 spawn 站点、原 source oracle 的精确位置及计数照实迁移，launcher 兼容入口不虚记为纯薄 facade。该小批只归位 native mechanism，尚未交付中立材料/执行端口，不能据此关闭 H4/H5。

必须保持并补齐：双 runtime × 业务/系统/smoke；fresh/resume/session reset；根与依赖的完整 profile/MCP/plugins/skills；系统 configDir 缺省；材料/receipt/capture 的 sync/async、receiver、拒绝与原首错；Task gated receipt ACK 前零 target 激活/stdin/输出消费/成功结算；system/MCP direct 的真实 target PID、held/rejected receipt 与原 stdin/输出等待；smoke 无 callback 仍成功；辅助 append 失败保持 incomplete 与有效 Intent/Memory 结果，terminal 写失败保持原 complete/incomplete 意图重试，authoritative 失败仍原 fatal；line/chunk ACK；取消、timeout、callback failure、EOF/drainTimedOut/unreaped；native usage/span/startup 和完整 session tree；实际 Task/effect 与 MCP owner 的持久事实；cleanup/保留目录；完整真根 selected binding。原 golden/parity/预算/分类判据保留。

原 canonical 生成规则、语料、owner/public/required SPI/SCC 与 exact source oracle 按真实迁移更新。生成只纳入该已冻结 source 候选和已提交基线，排除并行 WIP；真实增长按原治理合同记录和后继退役。一次成功源候选/生成不因 unrelated HEAD 移动而重跑；冲突或本候选改变才重新验收。

CS agent submit 当前使用 agentProfileId/materialId/prompt/mode/resumeSessionId，command submit 是另一分支；runner frame 也不等于 AW 的 byte-exact raw line。阶段 B 必须分别证明完整材料与事件/取证等价，不能将 argv/cwd/env POST 到 agent 入口，也不能从 CS normalized frame 合成从未收到的 raw transcript。该验证保留 B1/B2，当期缺失按原 RFC 策略补配套合同；本设计不提前宣称平台 Gap 已关闭。

A6 脚本/专用命令、A7 执行权/恢复、A8 全部装配/AC00 继续；完整 A-G 后才编写 CS adapter，并按 M0 先部署、M1 任务闭环、M2/M3 逐项能力、M4 最终迁移验收推进。
