# RFC-432 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`。以 RFC-431 落库后的源码（`90e1d0974`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：`bootstrap/`（部署合同、两个 profile、应用装配与模块组）。
- **模块侧**：
  - 只在 `composition` 入口导出本地构造函数；
  - 系统运维的 PostgreSQL 组合入口把「备份协调器」参数从值改为工厂，因为它的依赖在组合内部。
- **承担的演进**：S2c 第 1 项第三步。部署合同里的依赖会话图的缺省全部转为两侧都给的工厂。完成后合同只剩第四步的 7 项可选。
- **不新增**跨 context 内部 import、facade，也不新增 `routes/` / `services/` 耦合。

## 1. 工厂的签名

`S/bootstrap/deploymentProfile.ts` 新增会话存储参数类型：

```ts
/** RFC-432: what a session-scoped selection is built from in a standalone session. */
export interface DeploymentSessionStorage {
  readonly db: PersistenceDb
  readonly appHome: string
}
```

十项改为必填工厂。签名取本地实现的构造函数，托管给忽略参数的闭包：

| 选择项                                      | 类型（参数 → 值）                                                             | 单机值                                                                              | 调用处                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `contentStore`                              | `DeploymentSessionStorage → ContentStore`                                     | `({ db, appHome }) => createLocalRuntimeContent(db, appHome)`                       | 应用装配，会话开始处                                 |
| `skillContent`                              | `DeploymentSessionStorage → SkillContentBinding`                              | `({ db, appHome }) => createFileSkillContentBinding(db, appHome)`                   | 应用装配                                             |
| `reviewArtifacts`                           | `DeploymentSessionStorage & { content } → ReviewArtifactSelection`            | `createLocalReviewArtifacts`                                                        | 应用装配，内容存储之后                               |
| `resourcePackageSkillArtifacts`             | `DeploymentSessionStorage → ResourcePackageSkillArtifactOwner`                | `createFileResourcePackageSkillArtifactOwner`                                       | 应用装配，交给 HTTP 选择项包                         |
| `intentArtifacts`                           | `DeploymentSessionStorage → IntentArtifactSelection`                          | `composeLocalIntentArtifacts`（新，intent composition）                             | 应用装配，交给意图组                                 |
| `databaseBackup`                            | `PostgresqlBackupCoordinatorDependencies → AdminBackupCoordinatorPort`        | `createPostgresqlAdminBackupCoordinator`（system-operations 导出）                  | 系统运维 PostgreSQL 组合内部（只在 PostgreSQL 会话） |
| `repositoryPublicationTransport`            | `RepositoryPublicationTransportDependencies → RepositoryPublicationTransport` | `createRepositoryPublicationTransport`                                              | 仓库凭据组，端点发现之后                             |
| `developmentWorkspaceRepositoryPreparation` | `typeof createDevelopmentWorkspaceRepositoryPreparation`                      | `createDevelopmentWorkspaceRepositoryPreparation`                                   | 仓库凭据组                                           |
| `repositoryPreparationEffects`              | `RepositoryPreparationInput → RepositoryPreparationEffectFactory`             | `composeLocalRepositoryPreparationEffects`（新，从模块内联缺省提取）                | 任务执行组，准备输入组好之后                         |
| `scratchWorkspaceEffects`                   | `RepositoryPreparationInput → ScratchWorkspaceEffects`                        | `composeLocalScratchWorkspaceEffects`（新，即 `createFileScratchWorkspaceEffects`） | 任务执行组                                           |

- 只有评审产物依赖另一项，它要用已选的内容存储，由参数显式传入。
- 托管的十个闭包返回今天就在 profile 里建好的那几个对象，仍只建一次：
  - 意图产物与备份先在 profile 里算好再被闭包引用；
  - 工作区四项从 `workspace.bind()` 的结果里取出后包成闭包；
  - 资源包技能产物从 `resourceArtifacts.selections` 里单独取出。

## 2. 消费点

| 位置                                                            | 改动                                                                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `S/bootstrap/daemonApplication.ts`                              | 内容存储、技能内容、评审产物按会话调用工厂；资源包技能产物与意图产物调用后把值交给 HTTP 选择项包与意图组                                                |
| `S/bootstrap/daemonModules/repositoryCredentials.ts`            | 发布传输与开发工作区仓库准备调用工厂，删去两处 `??`                                                                                                     |
| `S/bootstrap/daemonModules/taskExecution.ts`                    | 组好准备输入后调用两个工厂，把值交给 `composeRepositoryPreparation`                                                                                     |
| `S/bootstrap/daemonModules/intent.ts`                           | 适配器改必填，删去 `?.`                                                                                                                                 |
| `S/bootstrap/daemonSessionAdapters.ts`                          | PostgreSQL 会话把备份工厂交给系统运维组合（文本不变，`backup: input.databaseBackup` 的类型随合同变为工厂）                                              |
| `S/bootstrap/crewstation.ts`                                    | 十项改为闭包                                                                                                                                            |
| `S/modules/system-operations/composition.ts`                    | `composePostgresqlSystemOperations` 的 `backup` 参数改为工厂：`(deps.backup ?? createPostgresqlAdminBackupCoordinator)(依赖)`，其他调用方照旧取本地实现 |
| `S/modules/source-control/composition/repositoryPreparation.ts` | 内联的本地准备效果提取为 `composeLocalRepositoryPreparationEffects(input)`，模块缺省改用它                                                              |
| `S/modules/intent/composition/apply.ts`                         | 新增 `composeLocalIntentArtifacts({ db, appHome })`，三个成员与今天各自的缺省同一构造                                                                   |

模块组合入口对其他调用方保留的缺省照旧（维护 Worker、模块级用例、CLI），列入 §4 债务。

## 3. 守卫与测试锁

- **RFC-431 结构锁**：分区清单把十项移入必填组（49 + 6 + 7）。新增两条检查：
  - 单机 profile 对十项的值不是调用表达式，即给的是构造函数或箭头函数本身，不在 profile 时构造；
  - 托管 profile 对十项的值是箭头函数。
- **`T/helpers/deploymentSelectionPartition.ts`**：新增 `SESSION_FACTORY_SELECTIONS`（十项，属必填组）。`OPTIONAL_SELECTIONS` 只剩第四步。
- **RFC-394 行为用例**：单机 profile 的键集合加十项；托管十项是函数，调用后返回 profile 里那几个对象。
- **接线锁**：断言旧缺省的用例改为断言工厂调用，例如：
  - `rfc370-skill-content-root-wiring` 锁住应用装配的技能内容一行；
  - `rfc321-repository-publication-ratchet` 锁住发布传输的 `??`；
  - `rfc370-port-artifact-bindings` 锁住评审产物。
- **guard-manifest**：刷新改动过的锁的行数。

## 4. 留下的债务

模块组合入口对非装配层调用方的缺省保留，全部是每个会话现建同一本地实现：

- `composeRepositoryPreparation` 的准备 / 暂存缺省；
- `composePostgresqlResourcePackageProvider` 的技能产物缺省；
- `composeIntentApplyOperations` 与 `composeIntentApplyArtifactLifecycle` 的三项缺省；
- `composePostgresqlSystemOperations` 的备份缺省；
- 评审读取器、协作命令上下文、评审决定命令里永远走不到的潜在缺省。

## 5. 失败模式

- 托管闭包误在调用时新建对象：托管用例断言两次调用返回同一对象。
- 单机工厂在 profile 时被调用：结构锁第一条报出。
- 迁移后重组的会话没有换数据库：行为用例对两个不同数据库调用同一单机工厂，断言实例不同、各自落在自己的数据库上。

## 6. 测试策略

- **结构锁**：分区、单机值形状与托管闭包，各带负例。
- **单机工厂行为**（`T/rfc432-session-selection-factories.test.ts`，`describeEachProvider` 双库，两个引擎都跑）：
  - 对同一引擎的两个独立数据库各调用一次内容存储、技能内容、资源包技能产物、意图产物工厂，实例不同；
  - 内容写入落在各自的数据库（内容目录行数只在写入方的库里增加）；
  - 评审产物工厂按会话构造，内容存储由参数显式传入，两会话实例不同。
- **回归**：涉及十项的根绑定与模块用例（内容存储、技能内容、评审、资源包、意图、备份、仓库发布 / 准备 / 暂存），以及部署 profile、
  接线锁、全部架构测试。
- **集中验证**：全部实现与用例写完后一次进行，内容如下：
  - 静态检查；
  - 针对性验证集，SQLite + PostgreSQL；
  - 在导出仓库里跑按已提交源码出报告的用例；
  - P0 变异 lane。
