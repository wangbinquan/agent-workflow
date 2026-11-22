# RFC-531 部署选择合同的槽位改为语义类型、镜像与子仓刷新由 profile 选择（RFC-294 S12 第十二步）

- **状态**：In Progress（2026-11-21）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S12（装配余项）第 6 项与第 1 项余项的一半；
  design §9.3（选择点）的现状偏差。
- **前序**：[RFC-530](../RFC-530-task-execution-module-construction/proposal.md)（S12 第十一步）。

## 1. 背景

部署选择合同 `DeploymentSelections`（`bootstrap/deploymentProfile.ts`）是 bootstrap 里唯一的选择点：单机 profile（`bootstrap/standalone.ts`）
与托管 profile（`bootstrap/crewstation.ts`）各给一份，daemon 的会话据此装配。合同里有 7 个槽位的类型取自本地工厂的签名
（`typeof composeLocal… / create…`）：运行时管理、System Agent 运行族、MCP 诊断与 source-control 的 4 个（发布传输、开发工作区仓库准备、
仓库准备与草稿工作区）。托管实现因此要对齐本地工厂的参数表，托管模块里的工厂也照着写成 `typeof composeLocalMcpDiagnostics`、
`ReturnType<typeof composeLocalSystemAgentRunFamily>`——合同说的是“像本地工厂那样”，而不是“这个模块要什么”。

另外，托管专有的 `repositoryRemote` 是可空的：单机给 `null`，daemon 在两处按它是否为 `null` 选本机实现——HTTP 装配据此选本机镜像或托管
远端读取，子仓刷新的运行期句柄据此决定跑本机的刷新循环还是什么都不做。选择因此有一半发生在 daemon 里，而不在 profile 里。

## 2. 目标

- **G1 语义类型**：7 个槽位改为各拥有方模块导出的具名选择类型（输入是会话交给选择的东西，输出是模块的端口或装配），单机与托管的实现都按
  这个类型定型；托管模块里的工厂与 daemon 的观察装配不再按本地工厂的签名定型。
- **G2 镜像与子仓刷新由 profile 选择**：可空的 `repositoryRemote` 换成两个必填的选择——仓库镜像与镜像刷新；单机给本机镜像与刷新循环，
  托管给远端读取与什么都不做的刷新。daemon 的两处 `null` 分支删去。
- **G3 门与用例**：新增 RFC-531 用例（选择合同里没有类型查询定型的槽位、托管实现与 daemon 装配不按本地工厂的签名定型、daemon 不再按
  `repositoryRemote` 分支、两个 profile 都给出新的两个选择，带负对照）；钉住旧形状的锁随改。

## 3. 非目标

- daemon 启动时按 `databaseInstallation` 是否为 `null` 跑本机 epoch 安装路径的分支（S12 第 1 项余项的另一半，另立后继：本机安装路径要整体
  收成单机 profile 给出的安装端口，改动面与本 RFC 不重叠）。
- 把 62 个键的扁平合同按模块分组为适配器集合（design §9.3 的终态；本 RFC 先让每个槽位有语义类型，分组另立后继，见 design §6）。
- 模块级可变单例（S12 第 4 项）；任何用户可见的行为、接口与界面变化。

## 4. 用户可见变化

无。唯一的内部差别：托管 daemon 的子仓刷新句柄此前直接返回空句柄，现在调托管 profile 给的“什么都不做”的刷新，并照单机的写法登记一个
配置变更监听（调到的 `reconfigure` 什么都不做）。

## 5. 验收标准

- **AC-1**：`DeploymentSelections` 里没有以 `typeof` 定型的槽位；7 个槽位的类型是拥有方模块导出的具名选择类型；托管模块里的工厂与 daemon
  的观察装配不按本地工厂的签名定型。
- **AC-2**：`repositoryRemote` 换成必填的仓库镜像与镜像刷新两个选择；daemon 不再按部署能力是否为 `null` 选镜像与刷新；单机与托管得到的镜像与
  刷新与此前相同。
- **AC-3**：计数不升；钉住旧形状的锁随改，新增 RFC-531 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
