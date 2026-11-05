# RFC-451 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`，`SC` = `S/modules/source-control`，`L` = `S/services`。
以 RFC-450 落地后的源码（`52d08e929`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：source-control 的 `infrastructure/local`、`application/ports`、`public/types`、`composition`；
  `platform/workspace/local`（子模块参数解析）。
- **承担的演进**：W4 B / D 第十六步（`cached-repos` 路由不再 import `services/`），并收掉 W5 记着的 repo / cache owner 余项里的镜像缓存。
- **跨 context 边**：无新增。`platform/workspace/local/submoduleParams.ts` 只取 `@/config`、`@/util/*` 与 `L/gitVersion`、`L/gitSubmodule`
  （平台 → legacy 不在账本内；平台 → 模块仍为 0）。
- **留下的债**：`tasks` 路由；`L/gitVersion`、`L/gitSubmodule`（W5）；`L/developmentDeliveryDeps` 其余部分（W4-E）。迁入的家族仍取
  legacy 的 `gitSubmodule`、`daemonCadence`、`maintenanceTicker`、`repoCredentials`，所以模块里 import `services/` 的文件实测 138 → 139
  （新增 4 个迁入文件，减去 source-control 里原来只为取镜像缓存而 import legacy 的 3 个）；这是 W5 余项的如实暴露，不是新增耦合。
- **偏离项**：无。

## 1. 文件落位（函数体原样，只改 import）

| 原位置                                                                                               | 去向                                                                   |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `L/gitRepoCache.ts` 的 `resolveSubmoduleParams` 与 `submoduleConfigFromDisk`                         | `S/platform/workspace/local/submoduleParams.ts`                        |
| `L/gitRepoCache.ts` 其余                                                                             | `SC/infrastructure/local/repositoryMirrorCache.ts`                     |
| `L/repoBatchImport.ts`                                                                               | `SC/infrastructure/local/repositoryBatchImport.ts`                     |
| `L/submoduleRefresh.ts`                                                                              | `SC/infrastructure/local/repositoryMirrorAutoRefresh.ts`               |
| `L/developmentDeliveryDeps.ts` 的开发工作区仓库准备（接口、`assert…Freshness`、`build…`、`create…`） | `SC/infrastructure/local/developmentWorkspaceRepositoryPreparation.ts` |

`L/gitRepoCache.ts`、`L/repoBatchImport.ts`、`L/submoduleRefresh.ts` 删除，不留 facade；`L/developmentDeliveryDeps.ts` 只删去迁走的那段。

## 2. 路由合同

- `SC/application/ports/cachedRepositoryOperations.ts`：`CachedRepositoryOperations`——
  - `list()`、`page(query)`（原 `listCachedRepos` / `listCachedReposPage`，store 由装配绑定）；
  - `refresh(id)`（原路由的分支：托管时走 `mirrors.remoteRegistration.refresh`，否则读配置取 `gitCloneTimeoutMs` 后本地刷新）；
  - `remove(id, { force })`（原 `deleteCachedRepo`；引用守卫抛 `CachedRepoHasReferencesError` 不变）；
  - `startBatchImport(request, initiator)`、`batchSnapshot(batchId)`、`retryBatchRow(batchId, rowId, request)`（原 `repoBatchImport`
    三个函数，配置的并发与保留期、托管登记由装配绑定）。
- `SC/public/types.ts` 导出该合同、它的参数 / 返回类型与 `CachedRepoHasReferencesError`（同文件已有 `RepositoryTransportCredentialError` 先例）。
- `SC/composition/cachedRepositoryOperations.ts`：`composeCachedRepositoryOperations({ store, mirrors, configuration, appHome?, secretBox? })`。
- `S/routes/cached-repos.ts`：`mountCachedRepoRoutes(app, operations)`；查询参数解析、PAT 删除确认（经 `operations.list()` 取行）、
  删除快照留在路由；不再 import `services/`。`S/server.ts` 与 `S/bootstrap/daemonHttpComposition.ts` 随之改。

## 3. 其余接线

- 平台：`platform/workspace/local/isolation.ts` 取本目录的 `submoduleParams`；`SC/infrastructure/workspaceMaterializer.ts`、
  `journaledWorktreeMaterializer.ts` 与镜像缓存从平台取。
- source-control 内部 7 个文件改取 `infrastructure/local/repositoryMirrorCache`（composition / infrastructure 层，分层门不受影响）。
- 装配根：`bootstrap/daemonApplication.ts`、`bootstrap/daemonSession.ts`（批量导入的清理 / 恢复与后台保鲜）、`bootstrap/standalone.ts` 与
  `bootstrap/deploymentProfile.ts`（开发工作区仓库准备）改从 source-control composition 取。

## 4. 守卫、账本与用例

- **新用例** `T/rfc451-repository-mirror-cache-into-source-control.test.ts`：三个旧文件不存在、`S` 下零引用（census AST，带负对照）；路由不 import
  `services/`；平台 → 模块仍为 0；合同的 `refresh` 在有托管登记时走远端、否则本地；`remove` 的引用守卫原样透出。
- **账本**：`architecture/repository-publication-call-sites.json` 的 fetch 调用点与 `excludedReadPaths` 改指新文件；架构报告归属表删三条
  legacy 登记；`guard-manifest.json` 刷新受影响守卫的行数。
- **随迁的文本锁**：按路径段（`gitRepoCache` / `repoBatchImport` / `submoduleRefresh` / `developmentDeliveryDeps`）扫全部用例、e2e 与脚本，
  逐个改指新位置（RFC-450 的教训：逐段拼接的旧路径不会被整串搜索搜到）；`test-suite-policy` 的「模块级读取的源码路径都存在」兜底。
- **用例的 import**：约 70 个用例文件改从新位置取。
- **workflow 触发清单**（集中验证时查出）：`git-protocols-e2e.yml` 的 push / pull_request `paths` 仍列着两个旧文件——漏改不报红，
  git 协议套件只是从此不再随镜像缓存的改动触发。改指 `repositoryMirrorCache.ts` / `repositoryBatchImport.ts`，并登记平台的
  `submoduleParams.ts`（原在 `gitRepoCache.ts` 里，镜像克隆仍取它）；新增 `T/ci-workflow-path-filters.test.ts` 锁住所有 workflow 的
  `paths` / `paths-ignore` 字面条目存在、glob 的目录前缀存在（带负对照）。

## 5. 失败模式

- 漏改的文本锁：集中验证全量跑，`test-suite-policy` 兜底读不到的路径；
- 平台反向边：新用例与 RFC-399 的 `platform-to-modules-file-pairs = 0` 同时锁；
- 发布账本：RFC-321 的调用点账本在工作树里复跑（导出仓库只有候选提交，该用例在导出里恒红）；
- workflow 触发清单指向已删除的文件：不报红、只是不再触发，由 `ci-workflow-path-filters` 锁。

## 6. 测试策略

全部实现与用例写完后集中验证一次：静态检查；全量 SQLite（候选导出仓库）；导出仓库接 PostgreSQL 跑全部架构测试与受影响用例；P0 变异 lane；
RFC-321 发布账本在工作树复跑。
