# RFC-446 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`，`SC` = `S/modules/source-control`。以 RFC-445 落地后的源码
（`16465e382`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：source-control 的 `infrastructure/local`（本机镜像目录上的 git 读取）与 `composition`（装配）。
- **承担的演进**：W4 B / D 第十二步，import `services/` 的路由 7 → 6；`services/` 文件 218 → 217。
- **不新增** DAG 之外的边：
  - 新文件只 import `node:path`、共享合同的类型、`@/util/git`、`@/util/errors` 与同模块端口类型；
  - composition → infrastructure 是模块内允许方向；
  - 路由只经 source-control `public/types` 取 `RepositoryMirrors`。
- **留下的债**：source-control 的 `repoGroups`、`cached-repos` 两个路由（`services/repoGroup`、`services/gitRepoCache`、
  `services/repoBatchImport`）；`composition/repositoryMirrors.ts` 对 `services/gitRepoCache`、`services/repoCredentials` 的依赖；
  其余 5 个路由。
- **偏离项**：无。

## 1. 文件去向

| 原位置                                                                                   | 新位置                                                                        | 说明                       |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------- |
| `S/services/repo.ts`：`isKnownRepoPath`、`getRepoRefs`、`getRepoFiles`                   | `SC/infrastructure/local/repositoryIntrospection.ts`（新）                    | 原样                       |
| `S/routes/repos.ts`：`requireKnownPath`（取已登记目录 → 判定 → 422 `repo-path-unknown`） | 同上文件的 `createKnownPathRepositoryReads(knownPaths)`：先判定，再调对应读取 | 错误码、消息与判定顺序不变 |
| `S/services/repo.ts`                                                                     | 删除                                                                          | —                          |

`createKnownPathRepositoryReads` 收 `() => Promise<readonly string[]>`（已登记镜像目录），返回
`NonNullable<RepositoryMirrors['local']>`：

- `refs(path)`、`files(path)` 先取已登记目录，`isKnownRepoPath` 不成立即抛
  `ValidationError('repo-path-unknown', 'path is not a known cached repository')`；
- 成立才调 `getRepoRefs(path)` / `getRepoFiles(path)`。

## 2. 连接

- **`SC/composition/repositoryMirrors.ts`**：
  - 两个读取改取 `../infrastructure/local/repositoryIntrospection`；
  - 单机分支的 `local` 改为 `createKnownPathRepositoryReads(() => input.store.listKnownRepositoryPaths())`；
  - 按 id 读的两项不变（仍经 `registered` 取行、错误消息只带 id）。
- **`SC/application/ports/repositoryMirrors.ts`**：`local` 的文档补一句：只读已登记镜像目录之内的路径，否则 `repo-path-unknown`。
- **`S/routes/repos.ts`**：
  - 删去 `services/repo` 与 `RepositoryWorkspaceStore` 的 import、`store` 参数与 `requireKnownPath`；
  - `read()` 在 `mirrors.local === undefined` 的判定之后直接调 `local.refs(path)` / `local.files(path)`；
  - RFC-099 那段说明随判定移到新文件。
- **`S/server.ts`**：
  - `repositories.store` 的类型改为 `Parameters<typeof mountCachedRepoRoutes>[2]`（`cached-repos` 路由仍收它）；
  - `repos` 的挂载不再传 store。

  装配层（`bootstrap/daemonHttpComposition.ts`）给 mirrors 与路由的是同一个 `core.repositoryWorkspaceStore`，所以判定读到的
  已登记目录与原先相同。

## 3. 守卫与用例

- **架构报告**：legacy 归属表删去 `services/repo.ts` 一行；新文件在模块内按位置归属。
- **账本**：`commons-debt.json`、`commons-manifest.json`、`guard-manifest.json`、`counts.json` 不变（`services/repo.ts` 没有账本边，
  也不在公共内核清单与守卫清单里；计数只降）。
- **路由错误码棘轮**（`T/route-error-code-coverage.test.ts`）：`repo-path-unknown` 是客户端可达的错误码，随判定离开 `routes/`；
  按 RFC-437 的先例把新文件加进扫描语料，该码继续受「必须有用例点名」约束（`repos-path-allowlist` 已点名）。
- **改 import 的用例**：
  - `repos-path-allowlist`：`isKnownRepoPath` 改取新文件；
  - `rfc370-v4-repository-mirrors`：`mountRepoRoutes` 改为两个参数。
- **注释**：`e2e/rfc319-repo-mirrors-and-launch.spec.ts` 判据源码位置里的两行改指新位置。
- **新用例** `T/rfc446-repository-reads-into-source-control.test.ts`：
  - **位置**：`services/repo.ts` 不存在、新文件就位；源码里没有文件 import 旧路径（census 的 AST 提取，带负对照）；
    `routes/repos.ts` 不 import `services/`、不 import 仓库存储类型；
  - **判定只在一处**：`isKnownRepoPath` 只在新文件声明，`repo-path-unknown` 只在新文件抛出；
  - **行为**：
    - 未登记目录：`refs` / `files` 抛 `repo-path-unknown`，且不触碰文件系统（目录不存在也是这个码，而不是 git 读取的
      `repo-path-missing`）；
    - 已登记目录及其子目录：判定通过、进入读取（目录不存在时得到读取自己的 `repo-path-missing`）；
    - 兄弟前缀与 `..` 越出：判定不通过；
    - 已登记目录的列表每次读取时现取。
- **行为由既有用例覆盖**：`repos-path-allowlist`（判定纯函数与经完整装配的 HTTP 两引擎）、`rfc370-v4-repository-mirrors`
  （单机 / 托管的 mirrors 与路由）、RFC-110 的 URL 模式选择器、API 合同与路由注册。

## 4. 失败模式

- **漏改消费者**：`tsc` 全量检查兜底；新用例对旧路径的零引用断言带负对照。
- **判定顺序改变**：路由仍先判缺参与部署不持有本机镜像，再进入 `local`；`local` 先判定再读；新用例与 `repos-path-allowlist`
  的 HTTP 用例分别锁定。
- **两处存储不一致**：装配层给 mirrors 与路由的是同一个存储实例（§2），判定的数据源不变。

## 5. 测试策略

全部实现与用例写完后集中验证一次：

- 静态检查；
- 全量 SQLite；
- 导出仓库（含 PostgreSQL 真库）跑全部架构测试与受影响用例；
- P0 变异 lane。
