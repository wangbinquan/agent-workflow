# RFC-489 task-execution 的运行族不再取 runtime-management 内部（RFC-294 §4.7 运行时驱动一族第三步）

- **状态**：In Progress（2026-11-12）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径
  限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.7（运行时驱动一族归 runtime-management
  infrastructure；整族迁入之前先重画 task-execution ↔ runtime-management 的驱动接缝）、§4.6 第 5 项（task-execution → runtime-management
  的 18 个跨 context 内部文件对随运行时驱动一族清偿）与 design §3.1（context DAG、consumer 自有端口、bootstrap 唯一装配）。
- **前序**：[RFC-487](../RFC-487-runtime-family-forbidden-consumers/proposal.md)、[RFC-488](../RFC-488-local-mcp-diagnostic-execution-port/proposal.md)
  （Done）——DAG 外四个 context 对运行时驱动一族的 import 已归零。

## 1. 背景

task-execution → runtime-management 在 DAG 上是允许的方向，但只能经 runtime-management 的 `public/` 合同，或经 task-execution 自有、由
bootstrap 绑定的端口；跨模块的装配只归 bootstrap。现在有 18 个 task-execution 文件对直接取 runtime-management 的 `composition/` 或
`infrastructure/`（架构报告的 `temporary-internal-debt`，`rfc328`、`rfc376`、`rfc294-architecture-preflight` 三份精确账本逐对登记）：

- **六个运行族的根**（`composition/` 下，共 15 对）：
  - 把 task-execution 的运行入口（`infrastructure/{local,crewstation}/*RunFamily.ts`）与 runtime-management 的提供者（材料定义、材料工作区、
    协议绑定、系统代理的运行时绑定与留存内容、任务代理的运行时绑定、托管内容）配起来；
  - 本机与托管两个「运行时管理」根还替 runtime-management 装它自己的效果与应用（诊断目标、效果、`bindRuntimeManagement`）。
- **本机调用的两个 infrastructure 文件**（3 对）：`local/agentInvocation.ts` 直取 runtime-management 的材料引用与运行证据实现；只供契约用例
  使用的 `local/nativeTaskAgentRun.ts` 直取协议绑定。

本机任务代理的根另有 3 对指向 resource-catalog 与 source-control 的 composition（材料引用、工作区内容、git 观测），性质相同。

task-execution 自己的运行入口早已按提供者类型接收这些实现（`infrastructure/local/nativeRunFamilyProviders.ts`），这些根只是在
task-execution 的 composition 里替 bootstrap 做了绑定。运行时驱动一族整族迁入 runtime-management 之前，先把这层接缝画对。

## 2. 目标

- **G1 运行时管理归 runtime-management 自己装配**：本机与托管的「运行时管理」装配（诊断目标、效果、应用与绑定）迁入 runtime-management 的
  composition；task-execution 的探测运行族经 runtime-management 效果自有的探测端口注入，由 bootstrap 配对。
- **G2 探测运行族与另两族一致**：协议与运行证据取自它已经在用的材料定义，不再自己取驱动、另做协议绑定。
- **G3 运行族的根只装 task-execution 自己的部分**：系统代理（本机、托管）、任务代理（本机）与探测（本机、托管）的根保留各自的
  task-execution 逻辑（绑定适配、配置冻结、产出校验、夹具选择），其他模块的实现作为带类型的提供者由 bootstrap 从各模块的 composition
  交入。
- **G4 本机调用不取 runtime-management 内部**：材料引用与运行证据由材料定义提供（runtime-management 实现）；只供契约用例的本机任务运行与
  一族里的两个运行器各自交入。
- **G5 账本与锁**：三份精确账本销去 21 对；新增 RFC-489 用例。

## 3. 非目标

- task-execution 对运行时驱动一族（`services/`）的其余使用、一族指回 task-execution 的两条边：另立（下一步）。
- 运行时驱动一族整族迁入 runtime-management infrastructure：另立。
- 其余跨 context 内部文件对（intent → resource-catalog 等）。
- 托管形态与本机形态的任何行为变化；接口、错误码与界面。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：task-execution 的生产文件对 runtime-management 只取 `public/`；上述 21 个跨 context 内部文件对销账。运行族的提供者与运行时管理的
  装配由 bootstrap 绑定。
- **AC-2**：同样输入下行为与此前一致：本机与托管的运行时管理（含探测回执钩子的恢复）、探测运行族的协议与运行证据、系统代理与任务代理
  运行族拿到的提供者、本机调用的材料引用与运行证据、各处夹具（用例对拍）。
- **AC-3**：跨 context 内部文件对 43 → 22；越 DAG 的值边与 offered 文件对不升；public surface 不增；减速带不升、触及的收紧到实测。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
