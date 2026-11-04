# RFC-438 定时任务归入 integration，task-execution 不再依赖定时任务（RFC-294 W4 B / D 第四步）

- **状态**：In Progress（2026-11-03）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、设计、
  实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.1 W4 B / D，以及 design §2「`services/` 按 owner
  迁入模块后删除」
- **前序**：[RFC-437](../RFC-437-integration-webhook-family/proposal.md)（Webhook 家族归入 integration）
- **落位**：integration 的 `application`、`application/ports`、`infrastructure` 与 `inbound/http`；task-execution 只改依赖方向；
  composition、`server.ts` 与 bootstrap 只改连接。

## 1. 背景

定时任务是 integration 的触发器能力（与 Webhook 触发器共用触发器资源合同），实现却在 legacy 层：

- `services/scheduledTasks.ts`（1258 行）：定时任务的创建、更新、授权、ACL、触发、立即运行与旧 payload 修复；
- `services/scheduledTaskScheduler.ts`：轮询认领与触发；
- `routes/scheduledTasks.ts`：管理面路由，深引 `integration/composition/scheduledTasks`，是 RFC-437 之后余下的 3 个深引路由之一。

依赖方向还有两处倒挂：

- **task-execution 依赖定时任务**：
  - 后台循环里的定时任务节拍由 task-execution 的 composition 直接调用 `runDueSchedulesOnce`；
  - 定时启动闭包（`createBuildScheduleLaunch`）的类型来自 `services/scheduledTasks`。
    定时任务一旦迁入 integration，这两处就成了 task-execution → integration 的依赖，而 design §3.1 的 DAG 只允许 integration → task-execution。
- **服务直接用他域的 legacy 机制**：资源 ACL 判定、WS 广播、工作流启动入参与触发预检、文件系统与 git（旧 payload 修复）。

## 2. 目标

- **G1 定时任务整体归入 integration**：
  - 服务与节拍迁入 `application`，旧 payload 修复（文件系统与 git）进 `infrastructure`；
  - 路由迁入 `inbound/http`，只依赖本模块与传输工具；
  - 原文件删除，不留 facade。
- **G2 task-execution 不再依赖定时任务**：
  - 后台循环的定时任务节拍只收一个 `runDue` 端口，由 bootstrap 用 integration 的节拍装配；
  - 定时启动闭包仍由 task-execution 实现（它启动的是本域任务），类型改为 task-execution 自有的合同，经 public 导出；
    integration 以结构同形的端口消费它，bootstrap 连接。
- **G3 他域机制改走端口或 owner 合同**：
  - 资源访问档位判定取 owner 的精确入口；
  - 工作流启动入参与触发预检并入已有的触发器校验端口，由 composition 连接 legacy 实现；
  - 变更广播改为 integration 的通知端口，由 composition 连接 WS 广播。
- **G4 行为不变**：路由、方法、权限点、令牌访问、请求解析、响应字节、错误码、广播事件、节拍节奏与并发上限、自动停用与失败计数全部不变。

## 3. 非目标

- `services/scheduledTaskRefs.ts`（纯叶子函数，被 resource-catalog 的删除守卫使用）：resource-catalog → integration 不在 DAG 内，
  需要 resource-catalog 定义所需端口后由 integration 实现，另立 RFC；本 RFC 只去掉迁移后服务对它的转出。
- 删除确认与令牌审计这两个 HTTP 传输助手（`services/deleteConfirm`、`services/tokenAudit`，十余个路由共用）的归位。
- 定时任务语义与调度节奏的任何变化；安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`services/scheduledTasks.ts`、`services/scheduledTaskScheduler.ts`、`routes/scheduledTasks.ts` 不再存在；迁入的文件不 import
  legacy `services/`（transport 助手除外，见 design §4）；task-execution 的源码不再 import 定时任务的任何文件。
- **AC-2**：定时任务节拍经 `runDue` 端口运行，节奏、并发上限、自动停用与开关判定不变；定时启动闭包由 bootstrap 连接。
- **AC-3**：账本按实测更新：`R1-inbound-module-internals` 178 → 176；深引模块内部的路由 3 → 2；import `services/` 的路由 24 → 23；
  其余结构门不回退，不新增 DAG 外的边。
- **AC-4**：定时任务的创建、更新、ACL、触发、立即运行、修复、节拍与 Webhook 触发器校验的用例全部通过。
- **AC-5**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **方向倒转与迁移同一 RFC**：先迁移会让 task-execution 立即深引 integration 内部；先倒转则倒转本身无处落位（类型仍在 legacy 服务里）。
   两者是同一个闭包。
2. **节拍循环留在 task-execution 的后台**：它随 provider 会话暂停与恢复，属于 task-execution 的后台生命周期；integration 只提供
   「跑一轮」的实现。这与 RFC-418 已经抽出的 `runDue` 端口一致。
3. **启动闭包留在 task-execution**：闭包把定时 payload 解析成 task-execution 的启动目标并调用本域参与者，是 task-execution 的能力；
   integration 只消费结构同形的端口，不让 task-execution 认识 integration 的类型。
4. **旧 payload 修复进 infrastructure**：它读文件系统并调用 git，属于适配层；application 不直接执行这类效果（RFC-294 层规则）。
