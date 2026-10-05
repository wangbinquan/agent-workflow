# A-T5：完整 Task Agent 共同核心与选中实现

本单元沿用已批准的 `agent-invocation-factory.md`，承接 System／smoke 共同核心、Task Git 观测及输出内容校验切面。目标是使完整原 `runNode` 算法接受已选中的材料、执行和内容能力，并保留独立的 native compatibility 入口。当前正常 Task 尚未接线，不能据此前的有限切面关闭 A-T5、A-G 或部署。

## 1. 完整算法只保留一份

将 `services/runner.ts` 的整个 Task 业务过程迁入 task-execution application。包括 prompt／memory、dependent profile 的有序解析、runtime session lease、observation admission、串行 stdout／stderr 和 chunk 确认、startup/session/usage/span、Git 前后观测、envelope／clarify／branch、eager 输出校验和归档、取消／timeout／drain／unreaped、失败归属、terminal CAS、effect settle 及 cleanup。原 catch、finally、错误文本、优先级、预算、默认值、回调 receiver 与读取时点保持。没有另一套 normal stream、timer、重试或结算算法。

原 options／result 的完整声明、成员、注释及 legacy 出口保持。正常 `TaskAgentRunPolicy` 只包含业务输入；appHome、物理 workspace/runtime binary、raw plan、argv/env、native fixture、技能 reader 和插件 locator 留在显式 native 配置。用于模板的 repo/worktree 文本仍是原业务数据，核心只交给原 renderer，不将它解释为内容地址。正常实际资源使用各 owner 的内容引用。

原纯 tail、Git diff-fields、archive-error 等 helper 跟随真实使用者归位，legacy 保留准确出口。原 plugin-load 识别规则整体保留；物理 file locator 到资源名字的投影留给选中材料实现，不能让正常核心解释 native locator，也不能删除原 stderr 事件或其错误分类。已有 runtime protocol、usage 归一化、startup verification 和 inventory 的真实原函数继续共用。

## 2. 每次 Task 的必选 purpose

根选择相容实现家族，再按 taskId／nodeRunId／workspace scope 打开 Task purpose。正常 purpose 必须完整提供 node prompt、port archive、output validation、readonly Git observation、材料准备和执行 receipt owner；缺少能力报告可归因的 unavailable，不按成员回落 native。purpose 构造不做内容读写、编译或执行。

工作区、run-content、task mounts、技能／插件内容、runtime binding 由原 owner 给出完整有序引用。Task 在原准备位置形成完整业务材料声明，包含原最终 prompt、memory、agent/dependents/MCP、root profile、完整有序 resolved profiles、config 的省略状态、fresh/resume、Git identity、nodeRunId 和 log。选中 Task preparation 将这份声明与该次 purpose 的资源引用组合为完整 `AgentMaterialIntent`，调用同一已选编译器一次。它不能通过 legacy `buildSpawn` 先编译，再为同一材料重建 plan 或第二次 compile。

挂载参数读取与计算保持在原 try/catch 之外：原 cwd、templateMeta.repos 及各 repo.worktreePath getter／resolveBoundaryMounts 拒绝继续以原错误身份向调用者传播，不新增 lease 释放、failed 写入或材料清理。选中 preparation 在这个原位置完成其 owner 的 mount 引用准备，Task 核心不解释 native 地址。其余材料／资源参数读取与真实 compile 保持在原材料准备 catch 内，继续走原 spawn-failed、lease 释放与 failed 写入。正常实现提供已选引用；native compatibility 保留原两个独立位置、晚到 opts、getter/reader 的存在性和 receiver。无 IO 的构造与旧入口的原 log/invocationId/workspace/protocol 初始化顺序分别对拍，不能把原 nonce await 之后的 driver lookup 提前到 await 之前。

编译返回该次 compiled handle、同次 declared/capabilities，以及 Task 所需的封闭材料事实。`bind()` 在原 invocation binding 位置调用一次，不重新选择实现。Task 的日志所需 binary/workspace 标签、原 diagnostics 和实际 declared MCP names 来自同次材料的 selected projection；它们保留原读取时点及 optional/getter 行为，不暴露可执行命令、env、plan 或 host 路径操作。native adapter 保留原 `const { cmd, env } = plan` 的执行 snapshot，同时取证仍读取该 plan 的 late env。normal labels 可为实现的诊断标识，业务核心不解释它们。

正常合同使用以下封闭成员，不增加 `Record<string, unknown>` 的任意实现总包：

| 合同                           | 必选成员与输入                                                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskAgentRunPolicy`           | 原完整业务 options；排除仅由 native compatibility 消费的字段，保留原业务可选性及注释                                                                                   |
| `TaskAgentRunPurpose`          | workspace、nodeRunPrompts、portArtifacts、outputValidation、gitControlObservation、材料准备与执行 owner；在原初始化和准备位置调用其成员                                |
| `TaskAgentMaterialDeclaration` | `AgentMaterialIntent` 的完整业务部分；workspace/runContent/taskMounts/runtimeBinding 和 injection.skills/plugins 由该次 purpose 的资源绑定补齐                         |
| `TaskAgentMaterialPreparation` | `compile(declaration)`，返回同次 compiled invocation；只使用已选择的 compiler/content/receipt 家族                                                                     |
| `TaskCompiledAgentInvocation`  | 原 `bind()`／declared／capabilities；`readDeclaredMcpServers()` 在原使用点读实际材料；`reportSpawn(log, { runtime, agentName, nodeRunId })` 在原日志点报告同次材料事实 |

`reportSpawn` 是材料诊断 participant 的单次报告，不执行编译、选择或 process，也不改变 Task 判据。native compatibility 在该 participant 内保留原整条 `log.info`、早期 cmd snapshot、晚读 cwd/diagnostics 以及 fixture 的任意原 diagnostics 字段；正常实现只提供自己的封闭材料事实。共同核心不接收原 raw diagnostics 对象。这个区别同时保留 native fixture 兼容性和正常合同的完整边界。

## 3. Receipt 与内容在原位置接线

执行 owner 在原 `bindExecution` 位置颁发 opaque Task participant，并与同次材料绑定。其 persistence、node execution、readonly 判据和可选原 process observation recorder 保持各自读取边界；native PID／argv／cwd、写资源指纹和 receipt 投影由 native owner 解释，hosted owner 使用自己的 dialect。正常执行 request/result 不新增这些 native 字段。现有 observation 的 native-process fact 是对应 capture 实现的可选事实，不是执行 payload，也不用于选择实现。

effect beforeStart、durable receipt 在 activation 之前、observation 接纳、usage/span baseline、串行确认、reset/lease rotation、清理和 unreaped 保留原顺序。Task 使用选中 owner 提供的真实 effect projection；不得生成假 local descriptor 或通过改名保留 native fallback。

在原 eager validation 位置等待必选 output validation purpose，以该次 workspace reference 校验原 content/kind/port。归档沿同一 workspace reference 和原 relative path 处理，原 inactive-port 跳过、failure payload、scalar/signal/list、force-include roster、归档失败和 settle 时序保持。native compatibility 继续同一 policy；不提前批量读取或将 path 字符串当 hosted reference。readonly Git capture 的前后条件和全部六字段仍是刚交付的原算法。

## 4. 五个实际调用点及真实根

Task 的真实调用点共五处：nodeMechanics 的工作组 host/member 入口、merge-resolution 入口及普通 iteration 入口，wrapperMechanics 的两个 wrapper Agent 入口。所有五处必须消费正常 Task purpose；child launch、fan-out、followup、retry、resume 和 workgroup scope 传递同一已选家族，不能只改 nodeMechanics 的三处。

SQLite/PG bootstrap、CLI start、PG daemon application、server startup/provider recompose/completed HTTP deps 显式贯穿完整选择。原 standalone 根选择 native 家族；选中的非本机家族不会读取 registry／Paths、native material/evidence/process 或路径 cleanup。native test command/getter fixture 由独立 compatibility API 承接，不以 fixture 字段替代生产选择。

核心、native compatibility、正常 composition 可以按冻结候选分批发布；正常 Task 的五处及真根完成前，完整 Task 单元一直开放。System 的所有实际 owner、retention producer/reader/GC，smoke 的管理根以及 RC/MCP 的真实 production materialization/verification 继续按原联合设计收口，不由本单元的 Task 局部 PASS 代替。

## 5. 验收与发布

先对拍完整原函数、全部原声明和其余不变语句／注释，只有实际 native preparation、binding、诊断、receipt participant 和 eager content 调用处允许替换为必选 purpose。保留原 runner golden、envelope、startup、Git、leases、effect/reap/receipt、双 runtime／双 provider、工作组、wrapper、clarify/resume、输出归档及失败测试的原断言与预算。

新增用例必须经过真实共同核心和正常 composition，验证完整 intent/有序 profiles、一次 compile/bind、opaque workspace/run-content/resources、config 省略、读取和错误边界、receipt-before-activation、选择 receiver、串行证据与 settle、readonly Git 以及 validation/archive 同引用。新增 native compatibility 用例锁住 cmd/env snapshot 与 late evidence、原 getter、可选方法及 cleanup receiver。五处真实调用点及全根的 selected family 另有集成证明，不能只测试未消费的 fake factory。

设计门、源码门、一次原 scoped census／matching metadata 门、hosted exact-SHA CI 分开留证。本机只做 owned format/lint 与纯源文／AST／JSON 验证，不运行 AW tests/typecheck/build/service。原失败、取消记录及并行输出保持。本单元完成后仍须脚本／purpose command、执行权与恢复、A-T7/AC00/A-G；随后各层独立 CS adapter，先 M0 实际部署，再逐项 M1～M4。当前尚无 AW-in-CS 部署，RFC 未完成。
