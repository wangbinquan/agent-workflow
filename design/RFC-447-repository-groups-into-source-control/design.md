# RFC-447 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`，`SC` = `S/modules/source-control`。以 RFC-446 落地后的源码
（`5bb075d31`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：source-control 的 `application`（用例）、`application/ports`（路由用的操作合同）、`composition`（装配）、
  `public`（合同类型与查询转出）。
- **承担的演进**：W4 B / D 第十三步，import `services/` 的路由 6 → 5；`services/` 文件 217 → 216；模块里 import `services/` 的文件
  143 → 142。
- **不新增** DAG 之外的边：
  - application 文件只 import 共享合同、`ulid`、`@/util/errors` 与同模块端口；
  - 新 composition 文件对 `services/gitRepoCache` 的依赖原本在路由里（composition 不在 R2 的受限层内）；
  - 路由对 source-control 只经 `public/types`；`services/task.ts` 经 `public/queries`。
- **留下的债**：`routes/cached-repos.ts` 与 `services/gitRepoCache`、`services/repoBatchImport`；source-control 内部对
  `services/gitRepoCache`、`services/repoCredentials` 的依赖；其余 5 个路由。
- **偏离项**：无。

## 1. 文件去向

| 原位置                                                                                        | 新位置                                           | 说明                                                                           |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `S/services/repoGroup.ts` 的七个用例、`resolveRepoGroupLayout`、`RepoGroupHasReferencesError` | `SC/application/repositoryGroups.ts`（新）       | 函数体原样；`RepoGroupDeps` 的 `cache` / `register` 合成 `importRepositoryUrl` |
| 同上：`DeleteRepoGroupResult` 与预览返回形状                                                  | `SC/application/ports/repositoryGroups.ts`（新） | 与 `RepositoryGroups` 合同同处，application 取用                               |
| 同上：`groupsReferencingRepo`、`detachRepoFromAllGroups`                                      | 删除                                             | 生产无调用方；用例改调存储端口同名方法                                         |
| `S/routes/repoGroups.ts` 里拼 URL 导入依赖的部分（`cacheDeps`、`registration`）               | `SC/composition/repositoryGroups.ts`（新）       | 按部署形态选择导入方式；等待上限由装配根传入                                   |
| `S/services/repoGroup.ts`                                                                     | 删除                                             | —                                                                              |

`materializeNodes` 里 URL 节点的分支改为：

- 节点已带 `cachedRepoId`：照旧核对它已登记，否则 `repo-group-member-not-found`；
- 节点只带 URL：`importRepositoryUrl` 不在即 `repo-group-url-import-unavailable`（码、消息、`details` 不变），在则取它返回的 id。

## 2. 连接

- **合同** `SC/application/ports/repositoryGroups.ts`：
  - `RepositoryGroups`：`list()`、`get(id)`、`layout(id)`、`preview(draft)`、`create(group, actorUserId)`、
    `update(id, group, expectedVersion?)`、`remove(id, { force })`；
  - `RepositoryGroupDeletion`（删除结果）、`RepositoryGroupPreview`（草稿展平结果）；
  - 经 `SC/public/types` 转出三者。
- **装配** `SC/composition/repositoryGroups.ts`：
  - `composeRepositoryGroups({ store, mirrors, cloneTimeoutMs })`：
    - `mirrors.remoteRegistration` 在（托管）时导入为 `register(url)` 的 `cachedRepoId`；
    - 否则（单机）每次新建 / 替换先取一次 `cloneTimeoutMs()`，导入为镜像缓存的 `resolveCachedRepo`（真值时带上限，与原路由
      `cfg.gitCloneTimeoutMs ? { cloneTimeoutMs } : {}` 同口径）；
  - `localRepositoryUrlImport(cacheDeps)`：单机导入函数本身，供装配与用例共用；
  - 经 `SC/composition.ts` 转出。
- **装配根** `S/bootstrap/daemonHttpComposition.ts`：mirrors 提成局部常量，`repositories.groups` 由
  `composeRepositoryGroups({ store: core.repositoryWorkspaceStore, mirrors, cloneTimeoutMs })` 装配，`cloneTimeoutMs` 读
  `configuration.read()` 的 `gitCloneTimeoutMs`。
- **路由** `S/routes/repoGroups.ts`：`mountRepoGroupRoutes(app, groups: RepositoryGroups)`；HTTP 层的事保持原样（三个 schema 校验、
  `members` 退役拒绝、PAT 删除具名确认、`force` 解析）；`RepoGroupRouteDependencies` 删除。
- **`S/server.ts`**：`repositories.groups` 的类型随 `Parameters<typeof mountRepoGroupRoutes>[1]` 变为 `RepositoryGroups`；挂载只传 groups。
- **展平函数**：`SC/infrastructure/workspaceMaterializer.ts`、`SC/infrastructure/legacyWorkspaceRecovery.ts`、
  `SC/composition/repositoryPreparation.ts` 改取 `../application/repositoryGroups`；`S/services/task.ts` 改取
  `@/modules/source-control/public/queries`（新增转出）。
  - 它的存储参数收窄为 `RepositoryGroupSnapshotReader`（只有 `readRepositoryGroupSnapshot()`，函数本来也只用这一个读）：
    参数若仍是整个 `RepositoryWorkspaceStore`，public 转出会让存储接口里的 `Partial` 补丁类型与 `object` 字段成为新的
    public 面偏差（RFC-294 预检的符号根白名单）；调用方传入的完整存储照旧可赋值。

## 3. 守卫与用例

- **架构报告**：legacy 归属表删去 `services/repoGroup.ts`。
- **账本**：`commons-debt.json`、`commons-manifest.json`、`guard-manifest.json`、`counts.json` 不变（`services/repoGroup.ts` 没有账本边，
  不在两份清单里；计数只降）。
- **改 import / 改锚的用例与辅助**：
  - `rfc248-materialize-group`、`rfc248-preview-layout`、`rfc248-delete-group-schedules`、`rfc248-repo-group-service`、
    `rfc199-start-task-workflow-race`、`rfc370-v4-repository-mirrors`、辅助 `repoGroupFixture`、`singleMemberWorkspaceFixture`：
    改取新文件；`cache: {...}` 改为 `importRepositoryUrl: localRepositoryUrlImport({...})`，`register` 改为返回 id 的同一函数；
  - `rfc248-repo-group-service` 的 D13 用例改调存储端口的 `groupsReferencingRepo` / `detachRepoFromAllGroups`；
  - `rfc279-database-redundancy-cleanup`、`rfc349-repository-workspace-provider` 两个「生产文件不含某机制」扫描的清单改锚到新文件；
  - `rfc359-w8-t29-unique-insert-conflict` 与 `workspaceMaterializer.ts` 里指向旧路径的注释改指新位置。
- **e2e 注释**：`rfc319-repo-groups-and-hosts.spec.ts`、`repo-governance.spec.ts` 判据源码位置改指新文件与行号。
- **新用例** `T/rfc447-repository-groups-into-source-control.test.ts`：
  - **位置与引用**：旧文件不存在、三个新文件就位；源码里没有文件 import 旧路径（census AST，带负对照）；路由不 import `services/`、
    对 source-control 只经 `public/types`；application 文件不 import legacy、infrastructure 与 composition；`services/task.ts` 经 `public/queries`；
  - **死转手已删**：application 文件不再导出 `groupsReferencingRepo`、`detachRepoFromAllGroups`；
  - **导入选择**：托管装配把 URL 节点交给 `register` 并用其 id；单机装配每次新建取一次等待上限、经镜像缓存导入（非法 URL 以
    `repo-url-invalid` 拒绝，证明走的是镜像缓存）；不给导入函数时 URL 节点以 `repo-group-url-import-unavailable` 拒绝；
  - **合同转发**：七个操作分别落到对应用例（列表、详情、展平、预览、新建、替换带 `expectedVersion`、删除带 `force`）。
- **行为由既有用例覆盖**：RFC-248 / RFC-249 仓库组管理面、预览、删除摘引用与定时任务、物化；RFC-370 V17 托管登记；RFC-199 启动竞态。

## 4. 失败模式

- **漏改消费者**：`tsc` 全量检查兜底；新用例对旧路径的零引用断言带负对照。
- **导入优先级改变**：装配层按 `remoteRegistration` 是否存在二选一，与原「`register` 优先」相同；新用例分别锁定两种装配。
- **等待上限读取时机改变**：原路由每次新建 / 替换先读一次配置；装配层同样每次新建 / 替换读一次（只在单机分支）。

## 5. 测试策略

全部实现与用例写完后集中验证一次：

- 静态检查；
- 全量 SQLite（候选导出仓库）；
- 导出仓库接 PostgreSQL 真库跑全部架构测试与受影响用例；
- P0 变异 lane。
