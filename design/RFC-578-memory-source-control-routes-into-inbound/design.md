# RFC-578 技术设计

记号：`S/` = `packages/backend/src/`，`MEM/`、`SC/` 分别是 memory、source-control 的模块目录。数字取 HEAD `f21fd1ced`。不改行为。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：两个模块各自的 `inbound/http`；挂载函数经各模块的 `composition.ts` 转出（RFC-577 的做法）。
- **承担的演进**：`routes/` → 模块 `inbound/` 的第三批；两个模块的 public 面撤回只被路由用的转出。
- **不新增** DAG 之外的边：memory 绑定对别的模块的依赖只有 resource-catalog `public/types` 的 `hasResourceAclBypass`（DAG 有 memory →
  resource-catalog 的 offered-consumption）与 identity-access `public/participants` 的两个类型（authority-type-only）；source-control 的三个绑定
  只取本模块。`server.ts` 指向 composition 属装配根例外。
- **留下的债**：绑定仍用 `routes/registry`、`routes/operationAuthority` 与 `@/auth/actor`，随传输工具归位另立。
- **偏离项**：无。

## 1. 文件去向与连接

| 原文件                          | 新位置                                       | 改动                                                                                   |
| ------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| `S/routes/memories.ts`          | `MEM/inbound/http/memoryRoutes.ts`           | 候选收窄判据改取 `../../domain/candidateVisibility`                                    |
| `S/routes/memoryDistillJobs.ts` | `MEM/inbound/http/memoryDistillJobRoutes.ts` | 无                                                                                     |
| `S/routes/repos.ts`             | `SC/inbound/http/repoRoutes.ts`              | `RepositoryMirrors` 改取 `../../application/ports/repositoryMirrors`                   |
| `S/routes/repoGroups.ts`        | `SC/inbound/http/repoGroupRoutes.ts`         | `RepositoryGroups` 改取 `../../application/ports/repositoryGroups`                     |
| `S/routes/cached-repos.ts`      | `SC/inbound/http/cachedRepoRoutes.ts`        | `CachedRepositoryOperations` 改取 `../../application/ports/cachedRepositoryOperations` |

- 文件名取挂载函数名去掉 `mount`（同 RFC-577）。两个模块的 `composition.ts` 各加对应的转出；`server.ts` 的 memory 两条 import 合成一条从
  `@/modules/memory/composition` 取，source-control 三条并进已有的 `@/modules/source-control/composition` import（它已经取 `type RepositoryMirrors`）。
  挂载调用与顺序不变。
- public 撤回（按架构报告的消费者表与 public 类型引用算到不动点，见 §3）：
  - `MEM/public/types.ts`：删去 `isMemoryHiddenCandidate`、`narrowCandidateRows`（第一层）与 `CandidateNarrowable`、`CandidateVisibilityOptions`
    （第二层）的转出，定义本来就在 `domain/candidateVisibility`；文件头里“路由层是它的生产 consumer”那段随改。
  - `SC/public/types.ts`：删去三组转出——`RepositoryMirrors`、`RepositoryRefresh`、`RepositoryRegistration`；`CachedRepositoryOperations`、
    `CachedRepositoryRefresh`；`RepositoryGroups`、`RepositoryGroupDeletion`、`RepositoryGroupDraft`、`RepositoryGroupPreview`。定义都在
    `application/ports/`；本模块里经 public 取它们的读者改取声明处。

## 2. 门、用例与文档

- 架构报告的 `LEGACY_BACKEND_FILE_OWNERS` 删去五行；`counts.json` 的 `legacy-horizontal-files` 上限 89 → 84。
- 钉着旧路径的用例随改：读源码的 `rfc349-memory-provider-boundary`、`rfc345-resource-catalog-contracts`、`rfc352-memory-candidate-visibility`、
  `rfc446-repository-reads-into-source-control`、`rfc447-repository-groups-into-source-control`、`rfc451-repository-mirror-cache-into-source-control`、
  `rfc349-repository-workspace-provider` 与 `redact-url-leak`；`rfc305` 的 identity-access 消费者账本一条；直接 import 旧路径的用例与辅助文件由搬迁
  脚本改说明符。`rfc352` 断言路由经 memory public 取候选收窄判据：判据不变、只是来源换成 domain，断言按它的意图（路由不手写收窄、经同一份判据）改。
- 集中验证里另查出的钉点（都已随改）：`rfc370-v4` / `rfc446` / `rfc447` 从 source-control public 取 `RepositoryMirrors` 类型（改取端口）；`rfc440` 按
  路由名拼路径读 `routes/memories.ts`（改成名到路径的表）；`rfc559` 的非空对照只数 `export { … }`，memory 的 `public/types.ts` 撤回之后只剩声明（改成
  连声明一起数）；`rfc550` 的正对照用的正是撤回的 `isMemoryHiddenCandidate`（换成仍在的 `MemoryScopeRef`）。
- 不改：描述过往迁移的注释；e2e 里三处指向 `routes/memories.ts` 的行号锚点——同一块里的 `services/memory.ts`、`services/overview.ts` 早已不存在，
  这些是写用例时的出处记录，没有东西读它们。
- `rfc317-table-ownership` 的非模块下限（RFC-577 改成 500）不变，本 RFC 之后 594。
- 架构报告的变更入口普查少两项：它的 HTTP 站点只扫 `routes/` / `mcp/` / `ws/` 目录下的 `.delete(` / `.patch(` 调用，记忆路由里那两处其实是调
  application 命令（`catalog.commands.patch` / `delete`），绑定迁进模块后不在扫描范围内。普查只出报告、不设门，不改它的口径。
- 新增 `tests/rfc578-memory-source-control-routes-into-inbound-boundary.test.ts`，登记 guard-manifest：① 五个旧路径不存在，`src` / `tests` /
  `scripts` 的全部说明符不再解析到它们（带负对照）；② 五个绑定对模块的 import 只取本模块（别名只到本模块 public，相对路径只到本模块 application /
  domain / public）与登记过的别的模块 public（memory 绑定：resource-catalog `public/types`、identity-access `public/participants`），不取 `@/db` 与
  `services/`（带负对照）；③ 两个 public 文件不再转出撤回的 13 个符号；④ `server.ts` 从两个模块的 composition 取五个挂载函数。
- `docs/dev-gotchas.md` 补 RFC-576 / RFC-577 的教训：撤回要算到不动点；模块可能因此整个没有 public 面；W9-D 让只数非模块文件的下限变小。

## 3. 检索与撤回的推算

按 `docs/dev-gotchas.md`“挪文件前的检索”：路径文本（含 `e2e/`、`design/` 的 Markdown 链接、账本）、分段与正则写法、泛化放行、源码摘要锁、按目录名
判的规则。撤回按架构报告的口径推算：一个 public 符号既没有模块外的生产消费者、也没有消费边、也没有别的 public 符号在类型里引用它，就算未消费；把
迁进模块的路由从消费者里去掉，逐层撤回、直到不动点。集中验证时以真实出的报告为准。

## 4. 失败模式

- **有人在旧路径重建文件或重新取它**：RFC-578 用例 ① 红，`legacy-horizontal-files` 也红。
- **撤回的符号又从 public 转出**：用例 ③ 红，`unconsumed-public-symbols-*` 门也红。
- **绑定多取别的模块**：用例 ② 红。
- **`server.ts` 又从 `@/routes/` 取这些绑定**：用例 ④ 红。

## 5. 取舍（可推翻）

1. **两族一个 RFC**：同 RFC-577——做法与验证相同，撤回都在两层以内。
2. **其余各族另立**（proposal §1 的表）：collaboration、development-automation 与 resource-catalog 的撤回要动大片 public 面；task-execution 的
   绑定对 memory、workspace-insight 的类型边不在 DAG 里，要先定。

## 6. 对 RFC-294 刷新后规则的对账

- **C10**：入站绑定进 owner 模块的 `inbound/http`，装配根经 composition 取。**C11**：两个 public 面收窄 13 个只被本模块用的转出。**C12**：RFC-578
  用例 ① 覆盖 `src` / `tests` / `scripts` 的全部说明符；② ③ ④ 只读相关文件。**C13**：`legacy-horizontal-files` 89 → 84，其余计数不升。
- **留下的债**：`routes/` 余 36 个；路由传输工具归位；proposal §1 表里的其余各族。
