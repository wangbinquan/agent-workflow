# RFC-452 任务恢复与诊断家族归 task-execution（RFC-294 W4 B / D 第十七步）

- **状态**：Done（2026-11-05，`4f0ede4c5`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.1 W4 B / D
- **前序**：[RFC-451](../RFC-451-repository-mirror-cache-into-source-control/proposal.md)（`cached-repos` 不再 import `services/`）。
- **落位**：task-execution 的 `application/recovery`、`application/lifecycleAlerts`、`application`（运行时会话租约）、`infrastructure`
  （孤儿收割、死运行对账、会话树 / 运行时清单 / 启动验证三个读端）、`application/ports` 与 `public/types`（诊断合同）、`composition`；
  shared 的诊断响应 schema；路由、装配根与 HTTP 装配。

## 1. 背景

RFC-451 之后只剩 `routes/tasks.ts` 还 import `services/`，共 14 处，分两族：

- **任务诊断与恢复（7 处）**：`lifecycleInvariants`（诊断扫描）、`taskAlerts`（未关闭的生命周期告警）、`recovery`（恢复审计）、
  `recoveryBreaker`（自动恢复熔断）、`sessionView`（会话树）、`execution/inventoryRead`（运行时清单）、`execution/startupVerificationRead`
  （启动验证）。
- **workspace-insight（7 处）**：`structuralDiff/*`、`codeIntel/*`、`worktreeFileContent`、`changeNarrative`——RFC-294 E5 的
  `modules/workspace-insight`，留给下一个 RFC。

第一族连同它们在 legacy 里的闭包（自动恢复的几个循环、孤儿收割与死运行对账、优雅关停、卡死任务检测、运行时会话租约）一共 17 个
`services/` 文件，全部是 task-execution 自己的实现：它们只依赖 task-execution 的端口与 shared，消费方只有 task-execution 的
composition / infrastructure、两个装配根与 `tasks` 路由。它们挂在 legacy，于是账本里 legacy → 模块内部（`R1`）有 18 条边出自这些文件，
task-execution 的 `application/taskAgentRun.ts` 还反向 import 了 `services/runtimeSessionLease`（`R2` 2 条）。

## 2. 目标

- **G1 家族迁入 task-execution**：17 个文件原样迁入（只改 import 与同模块内的取法），按职责分层：只经端口做决策的进 `application`，
  直接碰进程或文件的进 `infrastructure`；`services/` 删除这 17 个文件，不留 facade。会话树读端改从平台取归档读端后，
  `services/eventsArchive`（`export *` 兼容转出）在生产里再无消费者，一并删除，余下的脚本与用例改取平台文件。
- **G2 路由只经 public 合同**：`tasks` 路由的告警、恢复审计、清除熔断、诊断、会话树、运行时清单、启动验证 7 个端点改用
  task-execution 的 `TaskDiagnostics`（`public/types`）；路由里的两段编排（恢复审计与熔断态并发读、诊断的「实时扫描 + 合并扫描产不出的
  卡死规则行」）迁入 task-execution 的 `application/taskDiagnostics`，装配只做绑定。
- **G3 合同类型闭合**：告警、恢复审计、诊断三种响应在 shared 里有 zod schema，合同返回它们的推导类型；诊断的告警通知走带方法签名的
  接收者接口，不新增 public surface 债。
- **G4 行为不变**：各端点的 HTTP 形状、错误码与权限门、诊断时的 WS 广播、自动恢复 / 自动修复 / 心跳收割 / 孤儿收割 / 死运行对账 /
  优雅关停的语义、维护任务的调度全部不变。

## 3. 非目标

- workspace-insight 一族（下一个 RFC）；`services/daemonCadence`（平台与多个模块共用的节拍常量）；`services/runtime`（运行时驱动，W5）；
- 恢复循环本身的重新设计（拆端口、换调度）——本 RFC 只换位置；
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：17 个旧文件不存在、`src/` 与用例零引用；`tasks` 路由不再 import 这 7 个诊断 / 恢复模块；平台 → 模块仍为 0。
- **AC-2**：计数按实测更新：`services/` 文件 205 → 187（17 个家族文件与无人消费的 `eventsArchive` 兼容转出）；`R1` 166 → 148、`R2` 35 → 33（`taskAgentRun` 那两条清偿）、public surface 不新增债；
  模块里 import `services/` 的文件按实测记录；import `services/` 的路由仍为 1（`tasks` 余 workspace-insight 一族）。
- **AC-3**：自动恢复、自动修复、心跳收割、孤儿收割、死运行对账、优雅关停、生命周期不变量与卡死检测、告警 / 诊断 / 修复、会话树、
  运行时清单、启动验证、运行时会话租约的既有用例全部通过；新增 RFC-452 用例。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **一次迁整个闭包**：只迁路由用到的 7 个文件会让它们的 legacy 消费方（自动恢复循环）反过来深引模块内部，`R1` 不降反升；闭包里的
   文件除彼此之外只被 task-execution 与装配根用，一起迁移后没有 legacy 消费方。
2. **诊断响应进 shared schema**：告警详情是自由形状的 JSON，直接写进 public 合同会是开放类型；shared schema 推导的类型是本仓的
   既有写法（`NodeRunEventsResponseSchema` 先例），也让前端今后可以复用。
3. **路由保留 WS 广播的接线**：诊断与修复两处的告警通知都由路由接到 `tasksListBroadcaster`，合同只收一个带方法的接收者，与
   `applyRepair` 一致。
