# RFC-488 resource-catalog 本机 MCP 诊断的运行时工作改经自有端口（RFC-294 §4.7 运行时驱动一族第二步）

- **状态**：In Progress（2026-11-12）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径
  限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.7（运行时驱动一族归 runtime-management
  infrastructure：先把经 `services/` 取驱动的其他 context 换成端口或装配，再整族迁入）与 design §3.1（context DAG 与 consumer 自有端口的
  虚线）。
- **前序**：[RFC-487](../RFC-487-runtime-family-forbidden-consumers/proposal.md)（Done，`76fcd805a`）把 memory、resource-catalog、
  source-control、system-operations 的其余使用改到各自 owner 的合同上，只留下本 RFC 这一处（三条边逐条钉住）。

## 1. 背景

resource-catalog 的本机 MCP 诊断执行体（`modules/resource-catalog/infrastructure/local/mcpDiagnosticsEffects.ts`，425 行）是 DAG 外四个
context 里最后一处 import 运行时驱动一族的生产文件：取驱动（`getRuntimeDriver`）、取启动上下文与启动计划的类型、调一族的
`runSystemAgent` 跑一轮诊断。按 RFC-294 design §3.1，resource-catalog 不消费 runtime-management；一族迁入 runtime-management 之后，这三条
import 会成为越 DAG 的值边。

这个文件把两类工作写在一起（design §1 逐条给出处）：

- **resource-catalog 自己的工作**：会话与轮次的租约、按 pid 的启动回执与回收、工作区目录布局与清理、界面事件、诊断用的计时器。
- **运行时相关的工作**：驱动是否支持跨轮会话、原生会话号、按协议的默认可执行文件、一轮诊断的启动上下文组装与包裹、内存里的假运行
  （测试夹具）、原生系统代理的运行、启动观测与校验。

托管（CrewStation）形态早已分开：resource-catalog 声明自有端口 `McpDiagnosticExecution`，task-execution 的
`createCrewStationMcpDiagnosticRunner` 实现，bootstrap 绑定（RFC-416；design §3.1 的虚线「TE implements McpDiagnosticExecution」）。本机
形态还没有这一层。

## 2. 目标

- **G1 resource-catalog 声明本机执行端口**：`application/ports/localMcpDiagnosticExecution.ts` 声明 `LocalMcpDiagnosticExecution`，收下
  运行时相关的工作——跨轮会话支持、原生会话号、可执行文件的解析、一轮诊断的运行（含启动校验）；经 `composition/required-ports.ts` 转出。
  本机执行体只保留 resource-catalog 自己的工作，运行时相关的一律调端口。
- **G2 task-execution 实现端口**：本机实现放 `infrastructure/local/mcpDiagnosticRunner.ts`（与托管形态的
  `infrastructure/crewstation/mcpDiagnosticSessions.ts` 对称），由 `composition/localMcpDiagnosticRunner.ts` 交出。测试夹具（内存里的假运行）
  随之移到实现的输入里。
- **G3 bootstrap 绑定**：守护进程的观测模块建出本机实现（给了测试夹具就带上），交给 resource-catalog 的诊断装配；给了测试夹具时由
  bootstrap 选本机装配，CrewStation 的诊断装配不再按夹具分支。
- **G4 登记与锁**：RFC-294 design §3.1 与 `rfc294Target.ts` 登记新虚线「TE implements LocalMcpDiagnosticExecution」；RFC-487 用例的例外清单
  收到空；新增 RFC-488 用例。

## 3. 非目标

- task-execution 对一族的其余使用与 task-execution → runtime-management 的 18 个跨 context 内部文件对：另立。
- 整族迁入 runtime-management，含 `services/systemAgentRun.ts` 的去向（它在本 RFC 后只剩 task-execution 一个值使用方）：另立。
- 托管形态的任何改动；本机诊断的界面、接口与错误码。
- 任何行为变化。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：resource-catalog 的生产文件不再 import 运行时驱动一族；RFC-487 用例的例外清单为空，四个 context 都是零。本机执行体不再含
  驱动、启动上下文、假运行与启动校验的逻辑。
- **AC-2**：本机 MCP 诊断在同样输入下与此前一致：启动上下文的字段、包裹（轮次结束删 `mcp-config.json`、启动前过闸）、假运行的计划、
  观测与续会话的条件、启动校验（含声明清单缺失时报错、假运行不校验）、四种运行时错误（未登记、已停用、不支持、没有可执行文件）（用例对拍）。
- **AC-3**：越 DAG 的值边与 offered 文件对不升；public surface 不增；consumer 自有端口只增本 RFC 声明的一个；减速带 60 项不升、触及的
  收紧到实测。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
