# RFC-590 技术设计

记号：`S/` = `packages/backend/src/`，`TC/` = `S/modules/task-catalog/`。数字取 HEAD `24d4e0a9f`。不改行为。

## 0. 结构裁定：只被装配的模块可以没有 public 面

RFC-294 规定跨 bounded context 只走 exact public 合同、装配只在 bootstrap。public 面因此就是“别的模块消费的东西”——一个只经自己的入站绑定对外、由
装配根经 composition 取用的模块，没有别的模块消费它，public 面为空是这个规定的直接结果，不是债。R3 现在把它一律当债，理由是“对外不可用，或者消费者
在走内部路径”：后一种由 R1（legacy 与 bootstrap 之外的非模块文件不得取模块内部或 composition）与跨 context 的规则拦住；前一种就是“装配根也不取它”，
可以直接判。所以 R3 的判据改为：**public 面为空的模块，要么在 `MODULES_WITHOUT_PUBLIC` 账本里（债，写清理由与波次），要么至少有一个装配根文件
（`BOOTSTRAP_FILES`）取它的 composition**。账本照旧为空。

task-catalog 的 required port（`composition/required-ports.ts` 的 `TaskCatalogSource`）照旧由 task-execution 与 digital-employee 实现——那是
RFC-556 指定的 required-implementation 入口，不经 public，本 RFC 不动它；task-catalog 只是不再“提供”任何东西给别的模块消费。

- **bounded context / 层**：绑定进 `TC/inbound/http`，挂载函数经 `TC/composition.ts` 转出。
- **偏离项**：无。改动的是 R3 一条判据（改准，不放宽：死模块照旧报红，绕路取用照旧由 R1 报红）。

## 1. 搬迁、撤回与连接

- **`TC/inbound/http/taskCatalogRoutes.ts`**：`routes/taskCatalog.ts` 逐字迁入；`TaskCatalogQueries` 改从 `../../application/ports/taskCatalogQueries` 取。
- **撤回**：`TaskCatalogViewer`、`TaskCatalogListQuery` 的定义从 `public/types.ts` 移进 `application/ports/taskCatalogQueries.ts`（它们本来就是这个查询
  合同的参数）；`public/queries.ts` 对 `TaskCatalogQueries` 的转出删掉；两个文件随之变空，连同 `public/` 目录删掉；模块内的读者改指新位置。
- **`server.ts`**：`mountTaskCatalogRoutes` 改从 `@/modules/task-catalog/composition` 取；`taskCatalog` 一步不变。

## 2. 门、用例与文档

- 架构报告归属表删一行；`counts.json` 的 `legacy-horizontal-files` 上限 56 → 55，`unconsumed-public-symbols-task-catalog` 删去（报告按“有 public 面的
  context”逐个生成这项计数，task-catalog 不再有）。
- `rfc317-module-boundary` 的 R3：新判据与负对照（design §0）。
- 非空下限：`rfc376-report`（有 public 面的 context 数）、`rfc479` / `rfc480` / `rfc551`（`unconsumed-public-symbols-*` 计数个数）由 19 改为 18。
- 钉着旧路径的用例改指新位置；直接 import 旧路径的由搬迁脚本改写。
- 新增 `T/rfc590-task-catalog-route-into-inbound-boundary.test.ts`，登记 guard-manifest：① 旧路径不存在，全部说明符不再解析到它（带负对照）；② 绑定只取
  本模块；③ task-catalog 没有 `public/`，装配根经 composition 取用它；④ `server.ts` 从 task-catalog 的 composition 取挂载函数。

## 3. 失败模式

- **有模块的 public 面空了、装配根也不取它**：新 R3 判据报红（死模块或被绕路取用）。
- **有别的模块绕过 composition 取 task-catalog 的内部**：R1 / 跨 context 的规则报红（与改动前相同）。

## 4. 对 RFC-294 刷新后规则的对账

- **C10**：入站绑定进 owner 模块。**C11**：task-catalog 的 public 面收窄到空。**C12**：RFC-590 用例 ① 覆盖全部说明符，② ～ ④ 只读相关文件。
  **C13**：`legacy-horizontal-files` 56 → 55。
- **留下的债**：`routes/` 余 9 个，全是暂缓的那一组（路由传输工具 `registry` / `operationRoute`、identity-access 的路由、
  `accountRepositoryTransportCredentials`、`resourceAcl`）。
