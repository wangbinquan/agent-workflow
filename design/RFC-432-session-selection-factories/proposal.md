# RFC-432 需要会话图的部署选择项改为两侧都给的工厂（RFC-294 S2c）

- **状态**：In Progress（2026-11-03 落档）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、设计、
  实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2c 余项第 1 项的第三步
  （[RFC-428 盘点](../RFC-428-dead-deployment-selections/inventory.md)「后继分步」第 3 条）
- **前序**：[RFC-431](../RFC-431-standalone-selection-defaults/proposal.md)（单机默认值集中到单机 profile）
- **落位**：`bootstrap/`（部署 profile 合同、单机 / 托管 profile、应用装配与模块组）；各模块只导出本地构造函数，并让组合入口接受工厂。

## 1. 背景

RFC-431 之后，`DeploymentSelections` 还有 17 项可选。其中 10 项的单机值离不开会话图：

| 选择项                                                    | 单机值要用的会话对象                           |
| --------------------------------------------------------- | ---------------------------------------------- |
| `contentStore`、`skillContent`                            | 会话的数据库、应用目录                         |
| `reviewArtifacts`                                         | 数据库、应用目录、已选内容存储                 |
| `resourcePackageSkillArtifacts`                           | 数据库、应用目录                               |
| `intentArtifacts`                                         | 数据库、应用目录                               |
| `databaseBackup`                                          | PostgreSQL 会话的运行时与数据库、仓库备份准备  |
| `repositoryPublicationTransport`                          | 仓库传输凭据库、密钥盒、端点发现               |
| `developmentWorkspaceRepositoryPreparation`               | 仓库工作区存储、密钥盒                         |
| `repositoryPreparationEffects`、`scratchWorkspaceEffects` | 数据库、任务端口、密钥盒、启动配置里的克隆超时 |

单机 profile 在启动锁之前、数据库打开之前构造。SQLite → PostgreSQL 迁移后，单机还会在新数据库上重组会话。所以这些值不能在
profile 里一次建好，今天只能由消费点在缺省时现建。

托管 profile 在 profile 里就有数据库，10 项都是预先建好的对象。

## 2. 目标

- **G1 工厂型选择项**：10 项改为必填的工厂，签名就是本地实现的构造函数，形如 `(会话依赖) => 值`。
  - 单机 profile 直接给本地构造函数；
  - 托管 profile 给忽略参数、返回已建对象的闭包；
  - 消费点在会话依赖就绪处调用一次。
    `credentials` 选择项已是这个形状，本 RFC 把它推广到这 10 项。
- **G2 装配层不再补缺省**：`bootstrap/` 对这 10 项不再出现 `??`、`?.`、与 `undefined` 比较。RFC-431 结构锁把它们从可选组移到必填组：
  - 三分区变为 49 必填 + 6 必填可空 + 7 可选；
  - 剩下的 7 可选全部是第四步的部署开关或有无分支。
- **G3 模块只导出本地构造函数**：各模块从 `composition` 入口导出本地实现。组合入口在装配层路径上接受工厂；还有其他调用方
  （模块级用例、维护 Worker、CLI）的缺省照旧保留，并列为债务。
- **G4 行为不变**：
  - 两种部署每个会话得到的实现、根目录与构造时机都与今天一致；
  - 单机迁移后重组的会话照旧在新数据库上构造自己的实例。

## 3. 非目标

- 第四步的 7 项：`databaseInstallation`、`secretBox`、`repositoryRemote`、`crewStationEvents`、`executionAuthority`、
  `repositoryCandidateEffects`、`conflictMergeWorkspaceEffects`。
- 模块内部还有其他调用方的缺省（列为债务）。
- 维护 Worker 线程按效果族的单机缺省。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 三分区**：`DeploymentSelections` 62 项 = 49 必填 + 6 必填可空 + 7 可选。RFC-431 结构锁逐项对账，并锁住 10 项是函数类型（含负例）。
- **AC-2 单机 / 托管**：
  - 单机 profile 给出 55 项，其中 10 项是本地构造函数；
  - 托管 10 项是闭包，返回的仍是今天那几个对象；
  - 行为用例覆盖：同一单机工厂对两个会话构造两套实例，各自落在自己的数据库上。
- **AC-3 装配层无缺省**：`bootstrap/` 对 10 项没有 `??` / `?.` / `undefined` 比较，结构锁含负例。
- **AC-4 回归**：内容存储、技能内容、评审产物、资源包、意图、备份、仓库发布 / 准备 / 暂存用例，以及部署 profile、接线锁全部通过。
- **AC-5 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **每项一个工厂，不建统一的「会话选择构造器」**：
   - 10 项需要的会话对象各不相同，有的在会话一开始就有（数据库），有的要等 core 或任务执行组装配完；
   - 统一构造器会把装配顺序与应用内部对象拉进部署合同，所以按项给工厂，在依赖就绪处调用；
   - 唯一的构造依赖（评审产物要用内容存储）由参数显式传入。
2. **工厂签名取本地构造函数**：单机值就是模块已有的本地构造函数，托管是一行闭包。今天 `credentials` 已是这个形状，不再另造类型层。
3. **`databaseBackup` 只在 PostgreSQL 会话调用**：SQLite 会话的系统运维走旧的平台恢复适配，没有这个位置。
   这与今天「SQLite 不读这一项」一致，工厂在 SQLite 会话里不会被调用。
