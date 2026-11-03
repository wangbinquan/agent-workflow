# RFC-433 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`。以 RFC-432 落库后的源码（`b4b24cff1`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：`bootstrap/`（部署合同、两个 profile、启动、会话、应用装配、HTTP 组合与模块组）。
- **模块侧**：不改。各组合入口的可选参数照旧，装配层把可空项的 `null` 换成 `undefined` 传入。
- **承担的演进**：S2c 第 1 项第四步，也是最后一步。部署合同的 62 项全部由两种 profile 显式给出，装配层不再按「有没有给」分叉。
- **不新增**跨 context 内部 import、facade，也不新增 `routes/` / `services/` 耦合。

## 1. 合同

`S/bootstrap/deploymentProfile.ts` 删去「Optional」一组，7 项分别移入必填与必填可空：

| 选择项                          | 新类型                                      | 单机值                                                | 托管值（与今天同一对象）           |
| ------------------------------- | ------------------------------------------- | ----------------------------------------------------- | ---------------------------------- |
| `executionAuthority`            | `ExecutionAuthorityPort`                    | `composeLocalExecutionAuthority()`（无 IO，冻结常量） | `initialized.authority`            |
| `secretBox`                     | `() => SecretBox`                           | `() => createSecretBox(join(appHome, 'secret.key'))`  | `() => system.secretBox`           |
| `databaseInstallation`          | `DaemonDatabaseInstallationPort \| null`    | `null`                                                | `system.databaseInstallation`      |
| `repositoryRemote`              | `RepositoryRemoteEffects \| null`           | `null`                                                | 工作区 `bind()` 的同名成员         |
| `crewStationEvents`             | `CrewStationEventIngress \| null`           | `null`                                                | `composeCrewStationEventIngress()` |
| `repositoryCandidateEffects`    | `RepositoryCandidateEffectsFactory \| null` | `null`                                                | 工作区 `bind()` 的同名成员         |
| `conflictMergeWorkspaceEffects` | `ConflictMergeWorkspaceEffects \| null`     | `null`                                                | 工作区 `bind()` 的同名成员         |

- `secretBox` 是启动锁之后调用一次的工厂，不按会话；单机 `join(appHome, 'secret.key')` 即今天的 `Paths.secretKeyFile`。
- 会话输入与应用输入今天 `extends DeploymentSelections` 并把 `secretBox` 收窄为已解析的盒子。工厂类型与盒子不兼容，所以两处改为
  `extends Omit<DeploymentSelections, 'secretBox'>`，再声明 `secretBox: SecretBox`。

## 2. 消费点

| 位置                                                                       | 改动                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `S/bootstrap/daemonStart.ts`                                               | 先取 `installation`；`installation === null` 时依次跑本地 epoch 安装流程与待定恢复（两段原样合并进同一分支）；`secretBox()` 在原位置调用，日志字段改为 `deployment: profile.kind`（入口不按部署种类分叉，RFC-394）；`executionAuthority.onLost` 直接订阅；准备数据库时 `null` 换成 `undefined` |
| `S/bootstrap/daemonSessionInput.ts`、`daemonApplication.ts`                | 输入改为 `Omit<DeploymentSelections, 'secretBox'>`；应用装配直接用 `input.executionAuthority`；运行时组合的 `crewStationEvents` 改为 `CrewStationEventIngress \| null`                                                                                                                         |
| `S/bootstrap/daemonSession.ts`                                             | `executionActivationOf` 不再判断有无：权威总在，已 active 时门控原样返回工厂；事件中心循环以 `!== null` 判定 CrewStation 事件；子模块刷新以 `repositoryRemote !== null` 判定托管                                                                                                               |
| `S/bootstrap/daemonHttpComposition.ts`                                     | 镜像组合的 `remote`、Webhook 入口的 `crewStationEvents` 以 `=== null` 判定后传入                                                                                                                                                                                                               |
| `S/bootstrap/daemonModules/integration.ts`                                 | 适配器的 `crewStationEvents` 改为必填可空                                                                                                                                                                                                                                                      |
| `S/bootstrap/daemonModules/developmentAutomation.ts`、`digitalEmployee.ts` | 候选与冲突合并效果改为必填可空，传给 source-control 参与方时 `null` 换成 `undefined`                                                                                                                                                                                                           |
| `S/bootstrap/standalone.ts`                                                | 给出 7 项                                                                                                                                                                                                                                                                                      |
| `S/bootstrap/crewstation.ts`                                               | `secretBox` 改为闭包；其余六项今天已给出                                                                                                                                                                                                                                                       |

### 执行权威等价论证

- 会话把 `{ authority, onActivationFailure }` 交给生命周期程序（`S/bootstrap/daemonLifecycleProgram.ts:348`）。
- 程序对每个运行时与后台工厂调用 `startOnExecutionActive`。它在包装时读 `authority.current()`，已是 `active` 就原样返回工厂
  （`S/bootstrap/executionActivation.ts:18`）。本地权威恒为 `active`，所以单机的工厂与今天完全相同。
- `resource-reverify` 步骤 `await authority?.whenActive()`：今天单机是 `await undefined`，改后是已兑现的 promise，都是一次微任务。
- `onLost` 对本地权威是空订阅；`close()` 是空操作。

## 3. 守卫与测试锁

- **RFC-431 结构锁**：
  - 分区清单把 7 项移入必填与必填可空（51 + 11 + 0）；
  - 合同没有可选成员：任何带 `?` 的成员都对不上它应在的组（负例：前 presence 项改回可选、新增一个可选项）；
  - `secretBox` 归入工厂组：单机值不是调用表达式，托管值是箭头函数（各一条负例）；
  - 装配层规则不变，7 项自然纳入（`?.`、`??`、`undefined` 比较报错，可空项允许 `null` 判定）；新增负例：
    远端以 `undefined` 判定、执行权威的可选链、对必填执行权威的 `null` 判定。
- **RFC-394 结构锁**：会话输入与应用输入改为继承 `DeploymentSessionSelections`；新增检查：该别名必须恰为
  `Omit<DeploymentSelections, 'secretBox'> & { readonly secretBox: SecretBox }`（负例：多 Omit 一项）。原有「入口不按部署种类分叉」规则
  对本 RFC 同样生效——启动日志因此记录 `profile.kind`，不按种类分支。
- **`T/helpers/deploymentSelectionPartition.ts`**：删去可选组；新增 `PROCESS_FACTORY_SELECTIONS = ['secretBox']`。
- **`T/helpers/deploymentSelectionSource.ts`**（逐项接线预言）：选择项一律不带 `?`；两个输入继承 `DeploymentSessionSelections`。
- **RFC-394 行为用例**：单机 profile 的键集合即全部 62 项；托管 `secretBox` 是闭包，调用返回 profile 里的盒子。
- **接线锁**：断言旧写法的用例改为断言新写法：
  - `T/rfc394-start-sequence`：会话收到 profile 给的本地权威（不再断言没有权威）；
  - `T/rfc370-v4-repository-mirrors`：子模块刷新以 `!== null` 判定；
  - `T/rfc370-candidate-publication-bindings`、`T/rfc370-conflict-workspace-bindings`：两个模块组先把 `null` 换成本地缺省，再交给参与方。
- **测试入口**（`T/helpers/providerHttpApplication.ts`、模块组夹具）：用例给的值按新类型传入，没给的取单机值。
- **guard-manifest**：刷新改动过的锁的行数。

## 4. 留下的债务

- 单机的本地 epoch 安装流程（自动升级判定、子进程升级、待定恢复）仍写在启动里，以 `installation === null` 分支表达。把它做成
  `DatabaseInstallationPort` 的本地实现、让启动只调用端口，是 system-operations 的后续演进。
- 模块组合入口的可选参数（镜像的 `remote`、Webhook 入口的 `crewStationEvents`、候选与冲突合并的效果）照旧，供模块级用例使用。

## 5. 失败模式

- 单机误给了某个托管独有能力：结构锁要求单机可空项是 `null`。
- 托管漏给 `secretBox` 闭包而直接给盒子：类型检查与结构锁都会报出。
- 单机执行权威不是 active：门控会推迟后台集启动。行为用例断言本地权威 `current().kind === 'active'`，且 `startOnExecutionActive` 原样返回工厂。
- 构造 profile 时就创建了 `secret.key`：行为用例断言构造后应用目录为空，调用工厂后才有 `secret.key`。

## 6. 测试策略

- **结构锁**：分区、无可选成员、单机值与托管闭包，各带负例。
- **行为用例**（`T/rfc433-explicit-presence-selections.test.ts`）：
  - 单机 profile 的五个可空项是 `null`；
  - 本地执行权威：`current()` 为 `active`，`whenActive()` 已兑现，`startOnExecutionActive` 原样返回传入的工厂；
  - `secretBox` 工厂：构造 profile 不写文件，调用后创建 `appHome/secret.key`，两次调用读同一把密钥（互相能解封）。
- **回归**：启动序列、执行权威、仓库镜像、CrewStation 事件、候选与冲突合并、部署 profile、接线锁、全部架构测试。
- **集中验证**：全部实现与用例写完后一次进行：静态检查；针对性验证集（SQLite + PostgreSQL）；导出仓库里按已提交源码出报告的用例；
  P0 变异 lane。
