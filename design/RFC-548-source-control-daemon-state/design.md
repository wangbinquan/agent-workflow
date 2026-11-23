# RFC-548 技术设计

## 1. 现状（HEAD `e4adb5996`，源码实读）

- `infrastructure/local/repositoryBatchImport.ts`：模块级批次表 `batches`、`let globalConcurrency`、`let globalInFlight`、等待队列 `globalWaiters` 与
  `__resetBatchImportForTests()`。读写它们的导出函数：`startBatchImport`、`getBatchSnapshot`、`retryBatchRow`、`gcBatches`、`batchOwnerUserId`、
  `startBatchImportGc`。装配点三处：`bootstrap/daemonHttpComposition.ts` 经 `composeCachedRepositoryOperations` 用前三个；
  `bootstrap/daemonApplication.ts` 把 `batchOwnerUserId` 交给实时策略的 `repoImportOwnerUserId`；`bootstrap/daemonSession.ts` 的 `batch-import-gc`
  运行期句柄调 `startBatchImportGc`。三处在一个 daemon 里各调一次，靠同一份模块状态碰面。
- `ports/repositoryWorkspaceStore.ts`：`let repositoryFacetCacheEpoch` 与 `currentRepositoryFacetCacheEpoch()`、`invalidateRepositoryWorkspaceFacetCaches()`
  （后者经 `public/operations.ts` 再导出，只有用例用）。`infrastructure/repositoryWorkspaceSqlStore.ts` 的切面缓存是实例字段（5 秒有效期），
  命中还要代次相等；实例的 `invalidateCachedRepoFacets()` 清自己的缓存并给全进程代次加一，插入、更新、upsert 与“删除并解绑分组”四个写方法
  各自调它。
- `infrastructure/local/repositoryMirrorCache.ts`：`let repoPageFlights = new WeakMap<object, InFlightCoalescer>()`，按 `store.runtimeIdentity`（即
  数据库句柄）合并在途页读取；`invalidateRepoFacetsCache(store?)` 带存储时删掉该句柄的合并器并调存储的失效，不带时整表换新并加代次（只有
  用例这么调）。`ensureCachedRepoIdentity`、`resolveCachedRepo`、`refreshCachedRepo`、`deleteCachedRepo` 四条写路径与镜像组合
  （`composition/repositoryMirrors.ts` 的 `invalidateFacets`）调它。
- 存储实例在十来处按需构造（`composeRepositoryWorkspaceStore(db, taskPorts)`：核心存储一份，任务准备、启动快照、公开源封存、托管准备等各自
  现建），都在同一个库或它的事务上；读页面的只有核心存储（`composeCachedRepositoryOperations` 的 `page`）。所以失效信号必须跨实例，但按
  数据库就够了。
- platform 的句柄上下文（`platform/persistence/sessionTables.ts`）已经承载按数据库的运行期状态：RFC-537 的已提交事件泵槽与 RFC-539 的文件快照
  计数器，客户端、事务（`inheritDatabaseHandle`）与原生会话共用一份。

## 2. 机制与落位

落在 source-control（composition、infrastructure 原地）与 platform/persistence（句柄上下文）；bootstrap 只多构造一份批量导入并交出去。不新增
跨上下文依赖；source-control 的 public 少一个只有用例用的再导出。

### D1 批量导入归实例

- 新增 `RepositoryBatchImports`（批次表，与信号量 `{ limit, inFlight, waiters }`）与 `createRepositoryBatchImports()`；删去模块级状态与重置函数。
- `startBatchImport`、`getBatchSnapshot`、`retryBatchRow`、`gcBatches`、`batchOwnerUserId`、`startBatchImportGc` 的第一个参数收下这份实例；
  内部的信号量函数与泵收下其中的信号量。
- `composeCachedRepositoryOperations` 多必填的 `batchImports`；`ProviderAppOwnerInput` 多必填的 `repositoryBatchImports`。
- `composeDaemonApplication` 在实时策略之前构造一份：实时策略的 `repoImportOwnerUserId` 查这一份，HTTP 组合收下这一份，
  `DaemonApplicationRuntime` 多 `repositoryBatchImports` 把它交给会话；`composeDaemonSession` 的回收计时器用它。

### D2 读缓存状态归数据库

- platform：句柄上下文多一格 `states`；新增 `databaseStateKey(create)` 与 `databaseStateOf(handle, key)`——键由使用方模块持有（不导出就只有它
  自己取得到），状态在首次取用时按键构造，随句柄上下文由客户端、事务与原生会话共用；没有 provider 绑定过的对象照旧报
  “no session table set”。
- source-control 的 SQL 存储定义自己的键：按库的 `{ generation, pages }`（切面代次与在途页读取合并器）。切面缓存仍是实例字段，命中条件里的
  全进程代次换成按库代次；`listCachedRepoPage` 经按库的合并器合并同一查询的在途读取（键与原先相同：去掉首尾空白的检索词、三个筛选、游标、
  条数）；`invalidateCachedRepoFacets()` 清自己的缓存、按库代次加一、换一个新的合并器。
- 删去 `repositoryFacetCacheEpoch` 与它的两个函数（连同 `public/operations.ts` 的再导出）、镜像缓存的 `repoPageFlights` 与
  `invalidateRepoFacetsCache`；四条写路径与镜像组合改调存储的 `invalidateCachedRepoFacets()`，`listCachedReposPage` 直接调存储。

### D3 用例与锁

- 新增 `tests/rfc548-source-control-daemon-state-boundary.test.ts`，登记 guard-manifest：① 三个文件顶层没有 `let`，模块级可变单例判据为空；
  删去的名字在生产代码里不出现；生产代码只在 daemon 应用的组合里构造批量导入（语料下限 3,000）；② 行为：两份批量导入互不相见；同一个库
  上的两个存储，一个失效、另一个的切面缓存随之作废；同一查询的并发页读取只查一次；另一个库的失效不作废这个库；`databaseStateOf` 对同一
  键在库与它的事务上取到同一份、不同键与不同库各自一份、未绑定的对象报错；③ 带负对照。
- 随改：批量导入的用例（每例现建一份实例，代替重置）、`ws-repo-imports`（种批次的那份实例交给 WebSocket 夹具的发起者查询）、
  `cached-repos-http-batch`（应用自建一份，去掉重置）；测试助手 `realtimeRuntime` 的发起者查询默认改为查不到，`providerHttpComposition` 与
  `productionPerformanceApplication` 交一份实例；`rfc451`、`rfc527` 的直接组合交一份实例；`rfc311`、`rfc349`、`rfc359` 的失效改调存储。

## 3. 清单（退出门）

| 名字                                                       | 之后                                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `globalConcurrency` / `globalInFlight`（批量导入的信号量） | 删去；`createRepositoryBatchImports()` 的实例持有，daemon 应用的组合构造一份 |
| `repositoryFacetCacheEpoch`（切面缓存代次）                | 删去；SQL 存储的按库状态 `generation`                                        |
| `repoPageFlights`（在途页读取合并表）                      | 删去；SQL 存储的按库状态 `pages`                                             |

## 4. 用例

- ① ～ ③ 见 D3；既有用例覆盖批量导入、`/repos` 页面与切面缓存的行为。

## 5. 失败模式

- **一个 daemon 里出现两份批量导入**：HTTP 起的批次在实时策略里查不到发起者、回收计时器扫不到。RFC-548 用例钉生产代码只在 daemon 应用的组合
  里构造一份，行为用例钉两份互不相见。
- **事务上的存储与根库的存储失效不互通**：按库状态挂在句柄上下文上，事务经 `inheritDatabaseHandle` 共用根库的上下文；RFC-548 用例钉事务与
  根库取到同一份。
- **写方法的失效范围变宽**：存储自己的写方法原先只清切面缓存、不换合并器（只有镜像缓存的写路径两件都做），现在两件都做——写后的读不再
  并入写前已在途的页读取，结果只会更新，不会更旧。
- **不同库互相作废**：原先全进程一个代次，一个库的写会作废另一个库的切面缓存（多算一次，结果不变）；现在按库，只作废自己的。

## 6. 取舍（可推翻）

1. **按库状态放在 platform 的句柄上下文，而不是 source-control 的模块级表**：句柄可能是冻结对象（RFC-543），按库的状态只能按身份记；句柄上下文
   就是那张按身份记的表，RFC-537 / RFC-539 已经把按库的运行期状态放在这里。泛化成“模块持有的键”，platform 就不必认识 source-control。
2. **切面缓存仍按实例、只把代次换成按库**：保持“新建的存储有自己的空缓存”，事务上的存储也不会把事务里看到的计数写进共享的缓存。
3. **批量导入在 daemon 应用的组合里构造**：实时策略与 HTTP 组合都在这里，会话经应用运行期拿到它启动回收计时器，与“会话持有计时器、应用组合
   参与者”的既有分工一致。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合构造批量导入并交给三处；按库状态由句柄上下文持有。**C11**：source-control 的 public 少一个只有用例用的再导出
  （`invalidateRepositoryWorkspaceFacetCaches`），其余不变。**C12**：RFC-548 用例覆盖。**C13**：计数不升，模块级可变单例 43 → 39。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 4 项第十四步（source-control 的 4 条）；句柄上下文的按键模块状态，后继按库的模块状态可以直接用。
- **留下**：schema 历史运行时的登记 2 条；RFC-546 的两类待用户确认。
