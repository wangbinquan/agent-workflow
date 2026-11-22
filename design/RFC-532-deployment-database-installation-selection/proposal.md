# RFC-532 数据库安装由部署选择给出（RFC-294 S12 第十三步）

- **状态**：In Progress（2026-11-21）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S12（装配余项）第 1 项余项的另一半；design §9.3
  （选择点）的现状偏差。
- **前序**：[RFC-531](../RFC-531-deployment-selection-semantic-slots/proposal.md)（S12 第十二步：镜像与子仓刷新由 profile 选择）。

## 1. 背景

部署选择合同里的 `databaseInstallation` 是可空的：托管 profile 给出 release 安装的 `DatabaseInstallationPort`，单机给 `null`。daemon 的启动程序
（`bootstrap/daemonStart.ts`）按它是否为 `null` 选两段本机行为：

1. 打开密钥箱之前，`null` 时跑本机的 epoch 安装路径——读安装事实、按策略在子进程里自动升级（之后重读配置与事实、核对升级会话收尾）、记升级
   回执、按安装分类给出指引或拒绝、应用暂存的待定恢复；
2. 准备数据库时，`null` 时走本机文件准备（`kind: 'file'`），否则把托管的安装端口交给准备（`kind: 'selected'`）。

单机的默认行为因此写在 daemon 里，而不在单机 profile 里；这是 S12 第 1 项（单机默认值只留在单机 profile）在 daemon 侧剩下的最后一处按部署
能力 `null` 的分支（镜像与子仓刷新两处已由 RFC-531 收走）。

## 2. 目标

- **G1 必填的安装选择**：`databaseInstallation` 改为必填，类型是 system-operations 导出的具名选择 `DaemonDatabaseInstallation`——启动程序问它两件
  事：打开密钥箱之前把安装带到本版本能服务的状态（`admit`），与为启动准备选中的数据库（`prepare`）。
- **G2 两个 profile 各给一份**：单机给本机安装（自动升级、回执、指引与待定恢复原样搬入，升级子进程由单机 profile 交入；准备走本机文件准备）；
  托管给按 release 安装端口的安装（`admit` 什么都不做，准备交出安装端口）。
- **G3 daemon 不再分支**：启动程序只调这两个方法，删去两处 `null` 判断与本机 epoch 路径的导入。
- **G4 门与用例**：新增 RFC-532 用例（daemon 不按安装是否为 `null` 分支、不取本机 epoch 路径的函数，合同的槽位必填且是具名类型，两个 profile
  都给出，托管的 `admit` 不碰安装端口、单机在全新的家目录上不起升级子进程；带负对照）；钉住旧形状的锁随改。

## 3. 非目标

- CLI 的 `migrate` / `db migration` 命令自己的 epoch 判定（`bootstrap/migrate.ts`、`bootstrap/epochMigration.ts`）；它们不读部署选择。
- 把扁平合同按模块分组为适配器集合（design §9.3 的终态，另立后继）；S12 第 4 项（模块级可变单例）。
- 任何用户可见的行为、接口、日志与界面变化：自动升级、回执日志、拒绝与指引的文案、待定恢复与两种准备的顺序与实参都不变。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`databaseInstallation` 必填、类型是 `DaemonDatabaseInstallation`；单机给本机安装，托管给按安装端口的安装。
- **AC-2**：`bootstrap/daemonStart.ts`（与其余 `bootstrap/daemon*.ts`）不按 `databaseInstallation` 是否为 `null` 分支，不取本机 epoch 路径的函数与
  升级子进程；两种 profile 的启动行为与此前相同。
- **AC-3**：计数不升；钉住旧形状的锁随改，新增 RFC-532 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
