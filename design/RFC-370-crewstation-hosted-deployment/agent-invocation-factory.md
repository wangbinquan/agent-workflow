# A-T5：选中工厂与实际入口接线

状态：实施细化候选；沿用已批准的 [H4／H5 实施设计](./execution-material-implementation.md)，不改变 A→A-G→M0→M1～M4 的顺序。三入口同材料 binding 已发布，不等于选中工厂、真根或 A-T5 已完成。本文件固定下一单元的接线，完成后再逐项处理脚本、执行权／恢复及 A-G。

## 1. 组合归属

协议、完整材料输入、编译、内容生命周期和取证仍由 runtime-management 拥有；执行意图、effect、receipt 和尝试身份由 task-execution 拥有。跨 owner 的完整 invocation 合同放到 task-execution application 的执行需求端口，跨实现的配对放到 composition。RM 的正常 offered 合同不再引用 TE 的执行 participant。新跨 owner 类型从各自 exact public 入口消费，已有实际消费者才导出。

这同时清偿同材料 binding 的两条 RM→TE offered 债：删除 RM application/local 内的联合工厂职责和实际边，再删除两条债与匹配基线。不能仅换导入地址后销账，也不能把移到另一个 RM 文件的同一边算清偿。原协议、双 runtime 材料计算、单一进程机制、effect 身份和持久回执不改变。

## 2. 两阶段准备

准备能力绑定一次调用的协议、H6 内容、工作区、编译器、取证、执行和 receipt 实现。调用者提供完整 `AgentMaterialIntent`：原最终文本、完整 root/dependents 声明及有序 profile、资源内容引用、workspace/run-content/mount/runtime 引用、config 的省略状态、session/fresh/Git identity 和关联身份。工作区引用由实际 owner 装配，不由业务入口拼成本机地址。

正常准备端口分为两步：

1. `compile(intent)` 在原材料准备 catch 内完成一次真实编译，返回 compiled material handle、同次计算的 declared manifest 和 capabilities。handle 只指向这次编译，不含 plan、argv/env、物理路径、RuntimeDriver 或 CS DTO。
2. compiled handle 的 `bind()` 在原 invocation binding 位置取得同一次材料的联合 participant。它只使用根已选定的实现；不会再次编译、读取全局 registry／Paths 或按引用重新选择 target。随后在原 effect 创建前，沿现有 `bindExecution(participants)` 绑定 owner 的真实执行／receipt 能力。

两步保留原错误和读取边界：Task 的 cmd/env snapshot 留在 native 私有准备中，取证仍看到原 plan 的 late env；System 的 base declared 在 wrap 前保留，prepare 失败仍按原分支分类；native binding 的惰性 optional getter、callback receiver 和 cleanup receiver 保持。一个 material 的重复执行仍由原一次绑定规则拒绝，不新增恢复或重试算法。

本机编译器直接使用现有完整双协议材料实现。它不能先通过 legacy `buildSpawn` 编译，再给同一 plan 重新套一次 material 编译／新引用。raw `binaryOverride`、`boundaryHostProbe`、`testPlanOverride` 及 getter fixture 进入显式 native compatibility 装配，保留原 API、读时点和 receiver；正常选择不把这些字段作为 fallback。

## 3. 三个实际入口

| 入口          | 正常输入与准备                                                                                                                                 | 原规则的保持点                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task Agent    | 最终 prompt／memory／完整 resolved profiles 已形成后，编译完整业务 intent；workspace、mounts、资源与 runtime 引用沿 owner-selected H6 能力提供 | 原 gated receipt、readonly Git control、observation admission、effect fingerprint、输出与结算；必要的 readonly Git control 由 SC purpose participant 提供 |
| System Agent  | Persona／MCP 的完整 intent、seed 内容及逻辑 scratch scope；共用原单一结果算法                                                                  | 原 prepare catch、direct receipt、辅助 sink 降级／terminal 重试、authoritative fatal、capture 后 cleanup、失败／unreaped／retainScratch 的区别            |
| Runtime smoke | 选中 runtime binding、原 nonce 文本与完整 profile／extraArgs；共用编译与执行机制                                                               | 原 try 外 workspace prepare、ownerless direct 执行、stderr／terminal 分类、原预算、cleanup/reap 与现场保留                                                |

正常 System 结果持有 workspace 的 `retainedRef`。现有 `scratchDir` 物理字段只在显式 native compatibility result projection 产生；GC／重试／MCP 会话持久记录由对应 owner 的 retention participant 解释引用。迁移实际 reader 和 cleanup consumer 与 producer 一起完成，不把不透明引用塞入仍按路径解释的旧 reader。原 standalone DB/UI 物理投影保持，正常核心不调用 native projection。

Task/System/Smoke 的原整个业务结果和 lifecycle 算法留在共同核心，native API 为显式装配／结果投影；不复制另一套 stream、timer、cancel 或 classify 算法。首次增量源码提交可以拆小，但三入口及以下实际根全覆盖前不能记最小 Agent 单元完成。

## 4. 真根贯穿

根选择一个相容的实现家族，再按各 owner 的 typed scope 开 invocation：Task run、System turn、smoke probe。三个 purpose capability 共用材料／执行机制，保持各自 scope；不新增带任意 payload 的总包或把 probe/model discovery 装进 Task engine。

- `cli/start.ts`、`cli/postgresqlDaemonApplication.ts` 与 `server.ts` 的 startup、provider session/recompose、completed HTTP deps 传递同一选择。已选择实现时缺少成员报告原可归因的不可用，不回落 local。
- `task-execution/composition/nodeMechanics.ts` 的三处真实 `runNode`（工作组 host/member、merge resolution、正常 iteration）都传递准备能力；child launch、fan-out 和恢复 options 沿现 owner 装配继续传播。
- Intent turnEngine 的所有 turn／resume，Memory composition→schedule/distill 的所有轮次，Narrative 的真实 owner 都消费正常 System purpose capability。保留现 `runFn` fixture 的存在性语义，生产选择使用独立字段。
- Resource Catalog 的 MCP diagnostics 把生产 buildCtx 转成完整中立 intent：实际每轮 run-content 子引用、完整 profile/MCP/config、native session 策略、receipt/admission、cleanup 和 post-capture verify 同批迁移。不能注入 `runFn` 字段冒充生产选择；该字段目前会跳过真实物化和验证。startup observation 仍读实际该 turn 的取证来源，不用父目录或假 complete。
- RM composition→management effects→smoke 使用正常 purpose capability。保留 `runtimeDiagnosticTestDependencies.smokeRuntime` fixture，probe/models 的其余 purpose port 按后续 A6 处理。

`mcpTestSessionReference`／`createMcpTestNativeSessionId` 等实际使用的纯协议策略从协议 participant 获取；runtime binary、目录和数据库属于所选实现。所选非本机 fixture 通过上述真实根和三个实际入口，证明无 native registry／Paths、材料／取证／进程或路径 cleanup 回落；不能只测一个未被根消费的假 factory。

## 5. 提交与验收

实施顺序：联合合同和两阶段准备归位 → 三入口共同核心／显式 native compatibility → 各 owner 资源与 retention reader → 双 provider／真根贯穿 → 完整 Agent 单元有限功能门和新 exact-SHA hosted CI。每个源码增量保持旧 golden／predicate／预算，新增对实际选择的功能证明，按其冻结候选更新原 canonical／owner／public／SPI／SCC；无关 HEAD 前进不重跑不变候选。

保持 H4／H5 主设计的所有行为矩阵：双 runtime、完整注入、config 省略、fresh/resume、gated/direct ACK、stdout/chunk 串行确认、辅助 sink 与 authoritative 的不同失败规则、usage/span/session/startup、取消／timeout／drain／unreaped、真实 receipt、捕获后释放与保留目录。门检视仅审功能；正式 AW test／typecheck／build／service 只交 GitHub，不在本机执行。

本单元不引入 CS 生产 adapter，也不替代脚本／专用 command、authority／恢复、全部 A-T7／AC00／A-G。完整 A-G 后先交付 M0 必须 adapters 和首次实际部署，再在已部署实例上逐项 M1～M4。当前尚无 AW-in-CS 部署或完整 RFC 验收。

## 6. 联合合同归位增量

设计 R1 的有限独立功能检视通过。首个源码增量仅实施组合归属：联合合同迁到 TE application 的 `agentInvocation.ts`，整个 native 配对迁到 TE composition 的同名文件；RM application/local 只保留独立 `agentProtocol.ts` 及既有材料／取证／工作区实现。Task、System、smoke 和原 binding 回归跟随实际地址迁移，原两个 native 函数、两个完整合同、三个调用者及所有原测试正文按 AST 对拍保持。

两条 RM→TE offered 边随联合职责和文件真正删除，原37条 offered 债及完整 classifier／断言／fixture／预算保持。原 TE 两个仅为这两条边导出的类型不再有实际外部消费者，移除 public re-export，内部合同和实现完整保留；RM 的三个成员及 TE 联合合同均只为现有实际消费者提供 exact offered 类型。

本增量没有完成两阶段工厂、正常实现选择或启动根贯穿；不以合同归位关闭 A-T5、完整 Agent 单元、A-G 或部署。源码有限检视、匹配原 canonical／owner／public／SPI／SCC 和确切 SHA hosted CI 各自留证，后续继续原实施顺序。

原 SOURCE13-DOC1 R1 有限 PASS 保留。首轮原静态生成在 opaque type allowlist 验核发现正常取证面暴露 mutable `Map`，未输出 matching 产物，明确为失败；原分类器／allowlist 不改。后继正常 live handle 只声明原三个方法和只读 stats，live 去重及 post-run 输入使用 `ReadonlyMap<string, ReadonlySet<string>>`。原 native poller 仍独占 Map／Set 的更新，正常调用只读取和原样转交；不复制、冻结、替换原对象或修改 capture 算法。新增回归确认原 handle／Map 身份、owner 后续更新及两个 part 的实际转交；旧测试／预算保持。纯类型投影和新 exact-SHA hosted CI另行验证，R1 与首生成失败均不改写为后继通过。
