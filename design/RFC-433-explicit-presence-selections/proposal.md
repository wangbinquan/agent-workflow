# RFC-433 按有无区分部署的选择项改为显式（RFC-294 S2c）

- **状态**：In Progress（2026-11-03 落档）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、设计、
  实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2c 余项第 1 项的第四步，也是最后一步
  （[RFC-428 盘点](../RFC-428-dead-deployment-selections/inventory.md)「后继分步」第 4 条）
- **前序**：[RFC-432](../RFC-432-session-selection-factories/proposal.md)（需要会话图的选择项改为工厂）
- **落位**：`bootstrap/`（部署 profile 合同、单机 / 托管 profile、启动、会话、应用装配、HTTP 组合与模块组）；模块组合入口不变。

## 1. 背景

RFC-432 之后，`DeploymentSelections` 还剩 7 项可选。它们都靠「有没有给」区分两种部署：

| 选择项                          | 今天的有无语义                                                     | 消费点                    |
| ------------------------------- | ------------------------------------------------------------------ | ------------------------- |
| `databaseInstallation`          | 没给 = 单机的本地 epoch 安装流程（自动升级、待定恢复、文件库准备） | 启动三处                  |
| `secretBox`                     | 没给 = 启动锁之后在应用目录读取或创建 `secret.key`                 | 启动                      |
| `executionAuthority`            | 没给 = 单机：后台集不门控，HTTP 现建本地权威                       | 启动、会话、应用装配      |
| `repositoryRemote`              | 给了 = 托管：远端读在系统卷里，不保留镜像，也不刷新子模块镜像      | HTTP 组合、会话、应用装配 |
| `crewStationEvents`             | 给了 = 托管的 CrewStation 事件入口                                 | 集成组、会话、HTTP 组合   |
| `repositoryCandidateEffects`    | 给了 = 托管远端卷执行；没给 = 模块的本地逐请求实现                 | 开发自动化组、数字员工组  |
| `conflictMergeWorkspaceEffects` | 同上                                                               | 开发自动化组、数字员工组  |

部署开关藏在「可选」里有两个问题：

- 读合同看不出哪一项是托管独有、哪一项单机另有实现；
- 装配层只能用 `?.`、`??`、与 `undefined` 比较来分叉。

## 2. 目标

- **G1 合同里没有可选项**：`DeploymentSelections` 62 项全部必填，51 必填 + 11 必填可空。
  - 两项单机有真实的值：
    - `executionAuthority`：单机给本地权威（始终 active、永不丢失、构造无 IO）；
    - `secretBox`：改为启动锁之后调用一次的工厂。单机读取或创建 `appHome/secret.key`，托管返回平台给的盒子。
  - 五项是托管独有能力，单机 `null`：`databaseInstallation`、`repositoryRemote`、`crewStationEvents`、`repositoryCandidateEffects`、
    `conflictMergeWorkspaceEffects`。
- **G2 显式判定**：`bootstrap/` 对这 7 项不再出现 `??`、`?.`、与 `undefined` 比较。可空项只用 `=== null` / `!== null` 判定，
  这是 RFC-431 结构锁已经允许的写法。
- **G3 行为不变**：
  - 单机执行权威改走会话的门控路径，但对已 active 的权威门控原样返回工厂（`bootstrap/executionActivation.ts:18`）；
  - 资源复核等待的是已兑现的 `whenActive()`，与今天的 `await undefined` 同为一次微任务；
  - 其余各项的实现、构造时机与今天一致。
  - 唯一可观察的差别在启动日志：`secret box ready` 的字段从 `keyFile` 改为 `deployment`。单机密钥仍固定在 `appHome/secret.key`。
- **G4 S2c 第 1 项完成**：部署合同不再有按有无区分部署的隐式缺省。

## 3. 非目标

- 模块组合入口自己的可选参数：它们照旧给其他调用方留本地缺省，装配层把 `null` 换成 `undefined` 传入（与 RFC-431 的可空项同一做法）。
- 把单机的本地 epoch 安装流程做成 `databaseInstallation` 的本地端口实现（列为债务，见 design §4）。
- 维护 Worker 线程按效果族的单机缺省。
- 安全相关改动。

## 4. 用户可见变化

无。运维可见的只有启动日志一个字段（见 G3）。

## 5. 验收标准

- **AC-1 三分区**：`DeploymentSelections` 62 项 = 51 必填 + 11 必填可空 + 0 可选。RFC-431 结构锁逐项对账，并锁住合同里没有可选成员（含负例）。
- **AC-2 单机 / 托管**：
  - 单机 profile 给出全部 62 项：五项 `null`，`executionAuthority` 是本地权威，`secretBox` 是工厂；
  - 构造单机 profile 不创建 `secret.key`，调用工厂才创建；
  - 托管 `secretBox` 是返回平台盒子的闭包，其余六项与今天同一对象。
- **AC-3 装配层显式判定**：`bootstrap/` 对 7 项没有 `??` / `?.` / `undefined` 比较，结构锁含负例。
- **AC-4 回归**：启动序列、执行权威、仓库镜像、CrewStation 事件、候选与冲突合并、部署 profile、接线锁全部通过。
- **AC-5 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **`executionAuthority` 取值，不取 `null`**：本地权威就是单机真实的执行权威。会话门控遇到已 active 的权威原样返回工厂，所以不需要
   「有没有权威」这个开关；HTTP 的状态与门控也直接用它。改前每个会话现建一份，改后每个进程一份，本地权威是冻结常量，共享无影响。
2. **`secretBox` 取工厂**：`secret.key` 必须在启动锁之后才能创建，profile 在锁之前构造。形状与 RFC-432 的工厂相同，但它只在启动时调用一次，
   不按会话。
   - 启动入口不得按部署种类分叉（RFC-394 结构锁禁止在 `daemonStart` 里拿 `'standalone'` 做比较），所以日志不再区分来源。
   - 日志改为记录 `profile.kind`。
3. **五项取 `null`，不给单机本地值**：
   - `repositoryRemote`：没有远端时，镜像模块是另一种形状（守护进程自己的镜像克隆），不是换一个远端实现。会话据 `null` 判定是否刷新子模块镜像。
   - 候选与冲突合并效果：单机路径按请求选择实现（尊重请求里的 `runGit`，推送时用本地 fixture 会话），一个固定值表达不了。
   - `databaseInstallation`：单机路径是启动里的本地 epoch 安装流程，做成端口实现属于 system-operations 的后续演进。
   - `crewStationEvents`：托管独有。
