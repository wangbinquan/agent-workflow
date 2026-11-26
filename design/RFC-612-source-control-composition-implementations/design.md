# RFC-612 技术设计

记号：`S/` = `packages/backend/src/`，`SC/` = `S/modules/source-control/`，`T/` = `packages/backend/tests/`。数字取 HEAD `0fdb118d8`。生产行为不变。

## 0. 架构落位与裁定（RFC-294 第 8 条）

- **落位**：`SC/infrastructure/cachedRepositoryOperations.ts`、`SC/infrastructure/repositoryUrlImport.ts`。
- **裁定一：缓存仓库操作是端口实现**。它实现 application 的 `CachedRepositoryOperations`，调用本机镜像缓存与批量导入（都在 `infrastructure/local/`）
  和镜像端口。原样迁入 infrastructure，名字不变（与 RFC-499 / RFC-518 原样迁移的做法一致，infrastructure 里已有二十个 `compose*`）。
- **裁定二：URL 导入的选择归 infrastructure，用例绑定留在组合层**。
  - `composeRepositoryGroups` 把 application 的仓库组用例绑到存储上，这是装配。
  - 写入时用哪种 URL 导入取决于所选镜像的实现（远端登记还是本机镜像缓存），属于 infrastructure。
  - 选择函数 `repositoryUrlImportFor` 在构造时按镜像登记方式选一次。此前每次写入都检查一次，但登记方式在装配时就已固定（原来也是装配时读一次
    `input.mirrors.registration`），两者等价。单机每次写入照旧读一次克隆预算。
- **偏离项**：无。

## 1. 改动

| 位置                                              | 改动                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `SC/infrastructure/cachedRepositoryOperations.ts` | 新增：自 `composition/cachedRepositoryOperations.ts` 原样迁来（只改两条 import 的相对路径） |
| `SC/composition/cachedRepositoryOperations.ts`    | 删去                                                                                        |
| `SC/infrastructure/repositoryUrlImport.ts`        | 新增：`localRepositoryUrlImport`（自组合层迁来）与 `repositoryUrlImportFor`                 |
| `SC/composition/repositoryGroups.ts`              | `writeDeps` 改调 `repositoryUrlImportFor`，不再有分支、不再 import 本机镜像缓存             |
| `SC/composition.ts`                               | 两处转出改取 infrastructure                                                                 |
| `architecture/counts.json`                        | `composition-control-flow-source-control` 6 → 4                                             |

## 2. 用例

- 新增 `T/rfc612-source-control-composition-implementations-boundary.test.ts`，登记 guard-manifest：
  1. **落位**：组合层没有缓存仓库操作的文件；`composition/repositoryGroups.ts` 没有控制流、不 import 本机镜像缓存；模块根的两处转出取自 infrastructure。
  2. **行为**：远端登记时 URL 导入走 `register`、不读克隆预算；本机镜像缓存时每次写入读一次克隆预算。
  3. **范围**：候选与提交两个绑定之外，source-control 的组合层没有控制流（“范围之外为空”的写法，后继收掉那 4 行时不用改这条）。
  4. **负对照**：判据认得出伪造组合文件里的一个分支。
- 原用例照旧覆盖行为：`rfc447`（仓库组的创建与替换）、`rfc451` 与 `rfc527`（缓存仓库操作的刷新与批量导入）、`rfc602`、`module-contract-source-control`。

## 3. 失败模式

- **有人把实现放回组合层**：计数超过 max，结构门红；RFC-612 用例 ①③ 红。
- **URL 导入选错一支**：RFC-612 用例 ② 红，`rfc447` 的创建用例红。

## 4. 对 RFC-294 刷新后规则的对账

- **C1**：组合层只构造与注入。**C12**：RFC-612 用例跑选择函数并读组合层源码。**C13**：计数降、不升。
