# RFC-449 代码平台调用对 task-execution 与 development-automation 改为注入（RFC-294 W4 B / D 准备）

- **状态**：Done（2026-11-05；`2f8d491cd`，exact SHA 主 CI run 42037618561 与 windows-platform run 42037618568 首轮全绿）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.1 W4 B / D
- **前序**：[RFC-448](../RFC-448-mcp-probe-into-resource-catalog/proposal.md)；**后继**：RFC-450（代码平台连接与调用归 integration）。
- **落位**：task-execution 的 `application/ports/codeHostNodeExecution.ts`（连接解析端口）、`composition`（运行时选项与代码平台节点端口的装配）；
  development-automation 的 `infrastructure/developmentDeliveryProvider.ts`（本地连接端口）；装配根与测试拓扑。

## 1. 背景

RFC-448 之后 4 个路由仍 import `services/`，其中 `codeHosts`、`accountRepositoryTransportCredentials` 两个取 `services/codeHost/connections`。
`services/codeHost/` 五个文件（连接、调用、项目回退、恢复探测、URL）的目标 owner 是 integration（架构报告已登记），但不能直接搬：

- task-execution 的代码平台节点装配（`composition/codeHostNodeExecution.ts`）直接 import 调用、项目回退与恢复探测三个函数；
  task-execution 的运行时选项与参与者、development-automation 的交付 provider 以 `CodeHostConnectionsService` 类型收连接服务；
- RFC-294 的上下文 DAG（`tests/architecture/rfc294Target.ts` 的 `OFFERED_CONTEXT_EDGES`）只给 integration → task-execution、
  integration → development-automation，不给反向——这些引用一旦变成对 integration 的引用就越出 DAG。

task-execution 的端口其实已经是结构化的：`CodeHostRequestPort` 描述了三个函数的形状，`CodeHostNodeConnection` 描述了连接；只是装配处
把 legacy 函数硬接了进去，运行时选项又用 legacy 的服务类型收连接。

## 2. 目标

- **G1 task-execution 只认自己的端口**：
  - `application/ports/codeHostNodeExecution.ts` 新增 `CodeHostConnectionResolver`（`resolve(provider)`，返回 `CodeHostNodeConnection | null`）；
  - 运行时选项与参与者的 `codeHostConnections` 改为这个端口；新增 `codeHostRequests`（`CodeHostRequestPort`），与连接一起由装配点注入；
  - 代码平台节点的端口装配取注入的 `codeHostRequests`，不再 import `services/codeHost/*`。
- **G2 development-automation 只认本地端口**：交付 provider 的 `connections` 改为本地的结构化端口（只有它用到的 `resolve`）。
- **G3 装配点注入**：装配根把现有的连接服务与三个调用函数注入；测试拓扑同样注入（给了连接就给真实的三个函数）。
- **G4 行为不变**：代码平台节点的发送、回退、探测、未配置连接时的失败码，交付 provider 的绑定解析，全部不变。

## 3. 非目标

- 搬迁 `services/codeHost/*`、integration 的 MR 用例与两个路由（RFC-450）；
- 其余路由；安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：task-execution 与 development-automation 的源码不再 import `services/codeHost/*`；代码平台节点只经注入的 `codeHostRequests` 调用。
- **AC-2**：计数按实测更新：模块里 import `services/` 的文件 141 → 140（代码平台节点装配不再 import legacy；运行时选项、参与者与交付 provider 仍取其它 legacy 文件）；import `services/` 的路由仍 4；R1 / R2 不回退。
- **AC-3**：代码平台节点执行（发送、回退、恢复探测、尝试账本）、交付 provider 与相关装配用例全部通过。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **先注入、后搬迁（拆成 RFC-449 与 RFC-450）**：先让 task-execution 与 development-automation 只认自己的端口，搬迁时就不会产生越出 DAG 的边；
   两步各自可验证，搬迁那一步只剩 integration 内部与两个路由。
2. **注入点放运行时选项，与连接同路**：连接服务本来就经参与者与运行时选项进入执行面，调用函数与它同源、同生命周期。
3. **未注入时报「未配置」而不是隐式回退**：task-execution 不能再 import legacy 实现；生产装配根与测试拓扑都注入真实实现，缺失只可能出现在
   不跑代码平台节点的装配里，此时与「没有配置连接」同一个失败码。
