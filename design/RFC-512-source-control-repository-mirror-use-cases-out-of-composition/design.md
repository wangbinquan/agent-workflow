# RFC-512 设计：源码控制的已登记仓库读取与远端登记用例迁出 composition

## 1. 现状（HEAD，源码实读）

`modules/source-control/composition/repositoryMirrors.ts`（122 行）只有一个导出 `composeRepositoryMirrors(input)`，被
`bootstrap/daemonHttpComposition.ts`、`tests/helpers/productionPerformanceApplication.ts` 与两个用例（`rfc370-v4-repository-mirrors`、
`rfc446-repository-reads-into-source-control`）经 `modules/source-control/composition.ts` 取用。装配入口里内联的用例（行号是 HEAD 的这个文件）：

| 行      | 内容                                                                                                                                                                                                           |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 35～40  | `registered(id)`：按 id 读已登记仓库，`null` 抛 `NotFoundError('cached-repo-not-found', …)`                                                                                                                    |
| 41～62  | 单机（`remote === undefined`）：`local(id, read)` 在镜像目录上读，`DomainError` 改写成按仓库 id 命名的同码错误，其他错误原样抛；`refs` / `files` / `local`                                                     |
| 63～74  | 托管：`now`；`remoteOf(row)` 拆出远端地址，拆不开抛 `DomainError('repo-url-unavailable', …, 409, { url: row.urlRedacted })`                                                                                    |
| 75～79  | `recordVerified(id, defaultBranch)`：记默认分支与抓取时间，作废仓库切面缓存                                                                                                                                    |
| 80～121 | `refs` / `files` 走远端；`remoteRegistration.register(url)`（地址不合法抛 `ValidationError('repo-url-invalid', …)`，先核验远端、再查旧行、记身份行与核验结果）与 `refresh(id)`（再核验一次，返回刷新后的投影） |

F13 口径的 11 行：第 37、38、42、45、50、51、52、66、67、86、87 行（6 个分支、5 个 `throw`）。它直接调用的 effect：仓库存储
（`ports/repositoryWorkspaceStore`）、`@/services/repoCredentials` 的 `unsealRepoUrl`、镜像缓存的 `ensureCachedRepoIdentity` /
`invalidateRepoFacetsCache` / `rowToCached`（`infrastructure/local/repositoryMirrorCache`）、镜像目录上的 `getRepoRefs` / `getRepoFiles` 与已登记
目录的 `createKnownPathRepositoryReads`（`infrastructure/local/repositoryIntrospection`）。

## 2. 机制与落位

### D1 用例归 application

- **`application/repositoryMirrors.ts`**（新）：
  - `readRegisteredRepository(store, id)`：HEAD 第 36～39 行逐字（`input.store` 改为参数 `store`）。
  - `createLocalRepositoryMirrors({ store, reads, local })`：HEAD 第 43～61 行；`registered` 改为本工厂内的同名闭包（调
    `readRegisteredRepository`），镜像目录的读取改走 `reads.refs(path)` / `reads.files(path)`，`local` 原样交出装配给的已登记目录读取。
  - `createRemoteRepositoryMirrors({ store, remote, cache, now })`：HEAD 第 64～120 行；替换只有四处，都是 effect 改走端口：
    `unsealRepoUrl(row, input.secretBox, input.store)` → `input.cache.unsealUrl(row)`；`invalidateRepoFacetsCache(input.store)` →
    `input.cache.invalidateFacets()`；`ensureCachedRepoIdentity({ store, appHome?, secretBox?, now }, { url })` → `input.cache.ensureIdentity(url)`；
    `rowToCached(` → `input.cache.project(`。判据、错误、详情与次序逐字不变（注释同迁）。
- **`application/ports/repositoryMirrors.ts`**（增）：`RepositoryDirectoryReads`（= `NonNullable<RepositoryMirrors['local']>`，不改
  `RepositoryMirrors` 本身）与 `RepositoryMirrorCache`（`unsealUrl` / `ensureIdentity` / `invalidateFacets` / `project` 四个操作）。
- 依赖面：`@agent-workflow/shared`（`gitUrlCacheKeyWith`、`parseGitUrl`）、`@/util/errors`、`@/util/hash`、本模块的 `ports/repositoryWorkspaceStore`
  与 `application/ports/repositoryMirrors`；不取 infrastructure、`@/services`、`@/auth`，时钟由装配注入。

### D2 composition 只装配

`composeRepositoryMirrors` 的名字、入参与返回类型不变，只做一次选择：没有托管远端时调 `createLocalRepositoryMirrors`（`reads` 是
`{ refs: (path) => getRepoRefs(path), files: getRepoFiles }`，`local` 是 HEAD 原样的 `createKnownPathRepositoryReads(…)`）；否则按 HEAD 原样取
`now = input.now ?? Date.now`，调 `createRemoteRepositoryMirrors`，`cache` 的四个操作是 HEAD 原调用的闭包（`ensureCachedRepoIdentity` 的依赖对象
逐字搬到这里）。`rfc446` 钉的“镜像目录读取只被这个组合文件取用”不变。

### D3 锁与账本

- `architecture/counts.json`：`composition-control-flow-source-control` 120 → 实测（预计 110）。`guard-manifest.json` 登记 RFC-512 用例
  （`assertsAbsence: true`，“不存在”写成 `toEqual([])` 的字面形态）。
- 迁移前按路径扫用例里的 `readFileSync` 与按语料计数的账本：读这个组合文件原文或数它的控制流的只有 `rfc446`（镜像目录读取的取用方）与 F13
  计数本身；source-control 没有类似 `rfc423` 的 throw 账本。

## 3. 清单（退出门）

| 位置（`packages/backend/src/modules/source-control/` 下） | 声明并交出                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `application/repositoryMirrors.ts`（新）                  | `readRegisteredRepository`、`createLocalRepositoryMirrors`、`createRemoteRepositoryMirrors` |
| `application/ports/repositoryMirrors.ts`（增）            | `RepositoryDirectoryReads`、`RepositoryMirrorCache`                                         |

允许的形状：`composition/repositoryMirrors.ts` 只声明 `composeRepositoryMirrors`，只有一处选择（`remote === undefined`），没有 `try` / `throw`，
不再从 `@agent-workflow/shared`、`@/util/errors`、`@/util/hash` 取东西。

## 4. 用例

新增 `packages/backend/tests/rfc512-source-control-repository-mirror-use-cases-out-of-composition-boundary.test.ts`，登记 guard-manifest：

- ① 清单里的名字在全部生产文件（下限 3,000）、用例（下限 2,500）与 e2e 里只在各自的位置声明；新文件恰好声明、交出清单列的名字；组合文件只
  声明 `composeRepositoryMirrors`。
- ② 组合文件的控制流只剩一处 `if`、没有错误的构造；两个工厂各被它调用一次，不再从共享包与 `@/util` 取东西；带负对照。
- ③ 新文件的依赖面是闭集（import 逐条钉住），不用进程全局；带负对照。
- ④ 行为（直接调用两个工厂，effect 用记录调用的替身）：单机的未知 id、读失败的错误改写（码、状态、文案不带路径）、非领域错误原样抛、读的是镜像
  目录；托管的地址拆不开（409、详情）、登记的地址不合法（不核验）、登记与刷新的 effect 次序、`created` 两种取值、刷新投影的缺省值。

行为另由现有用例经装配入口对拍（`rfc370-v4-repository-mirrors` 的托管登记、刷新与选择器，`rfc446` 的单机已登记目录读取）。

## 5. 失败模式

- **用例走样**：函数体按 HEAD 原行切片生成，四处 effect 替换与 `registered` 闭包之外逐字；次序与错误原样保留，用词法单元比对复核。
- **时钟与缓存作废的绑定**：`now` 仍在装配时按 HEAD 原样取一次、同一个值交给核验记录与身份行；作废仍以同一个仓库存储为键。
- **读原文的锁与按语料计数的账本**：已预查（D3）。
- **账本漏标**：`assertsAbsence: true`，断言用字面形态。

## 6. 取舍（可推翻）

1. **单机与托管各一个工厂，选择留在组合层**：两种装配交出的形状不同（单机有 `local`、托管有 `remoteRegistration`），选择本身是装配。
2. **镜像缓存的四个操作合成一个端口**：它们都来自镜像缓存与 URL 拆封，按“用例要什么”声明，基础设施的形状不漏进 application。
3. **`RepositoryDirectoryReads` 取自 `RepositoryMirrors['local']`**：不改既有公开类型，避免 public surface 的摘要变动。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是用例，落 application；组合文件只做选择与注入。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-512 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明，另读组合文件与新位置。
- **C13**：`composition-control-flow-source-control` 收紧到实测；其余触及的计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S10 在 source-control 的第三步：组合层里最后一个非 RFC-370 的用例离开 `composition/`。
- **留下**：source-control 组合层余下的装配期选择（8 行，加上本 RFC 留下的 1 行）按 S10 的分支上限处理；`crewstation*` / `taskImage*` 待
  RFC-370 余项；其余模块的 throw 余项（code-capability、resource-catalog、task-execution）与 S10 的全模块门另立。
