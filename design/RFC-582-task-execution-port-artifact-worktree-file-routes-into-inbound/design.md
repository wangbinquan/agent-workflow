# RFC-582 技术设计

记号：`S/` = `packages/backend/src/`，`TE/` = task-execution 的模块目录。数字取 HEAD `2f5dcbe3f`。不改行为。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：task-execution 的 `inbound/http`（`inbound/` 已有 `directTaskInitiator.ts`，绑定放进新建的 `http/` 子目录，与别的模块一致）；
  挂载函数经 `TE/composition.ts` 转出。
- **承担的演进**：`routes/` → 模块 `inbound/` 的第七批。
- **不新增** DAG 之外的边：工作树文件路由取 source-control 的 `public/types`（DAG 有 task-execution → source-control 的 offered-consumption）；端口产物
  路由只取本模块 public。
- **留下的债**：绑定仍用 `routes/registry` 与 `@/auth/actor`；task-execution 的另三个路由。
- **偏离项**：无。

## 1. 文件去向与连接

| 原文件                       | 新位置                                   |
| ---------------------------- | ---------------------------------------- |
| `S/routes/port-artifacts.ts` | `TE/inbound/http/portArtifactRoutes.ts`  |
| `S/routes/worktree-files.ts` | `TE/inbound/http/worktreeFilesRoutes.ts` |

- 文件名取挂载函数名去掉 `mount`。两个绑定只用别名 import，迁移前后逐字节相同；撤回 0 个 public 符号（它们取的本模块 public 别处也在用）。
- `TE/composition.ts` 转出两个挂载函数；`server.ts` 的两条 import 合为一条从那里取，挂载调用与顺序不变。

## 2. 门、用例与文档

- 架构报告的 `LEGACY_BACKEND_FILE_OWNERS` 删去两行；`counts.json` 的 `legacy-horizontal-files` 上限 71 → 69。
- 钉着旧路径的用例随改：按路径读源码或列清单的 `rfc193-port-artifacts-api`、`rfc287-t14-empty-root-containment`、`rfc349-port-artifact-provider`、
  `rfc349-repository-workspace-provider` 与 `rfc526`；直接 import 旧路径的用例由搬迁脚本改说明符。
- 不改：描述过往迁移的注释（含两个工作树文件用例开头的说明）；e2e 注释里的源码行号锚点（同 RFC-579 design §2）。
- 新增 `tests/rfc582-task-execution-port-artifact-worktree-file-routes-into-inbound-boundary.test.ts`，登记 guard-manifest：① 两个旧路径不存在，
  `src` / `tests` / `scripts` 的全部说明符不再解析到它们（带负对照）；② 两个绑定对模块的 import 只取本模块 public 与登记过的别的模块 public（工作树文件
  路由：source-control `public/types`），不取 `@/db` 与 `services/`（带负对照）；③ `server.ts` 从 composition 取两个挂载函数。

## 3. 检索与推算

同 RFC-578 design §3；推算在 `2f5dcbe3f` 的报告上逐个路由做，边的角色一起核对。检索按 RFC-579 的教训：不截断、跨行匹配、包括前端与 shared 的用例。

## 4. 失败模式

- **有人在旧路径重建文件或重新取它**：RFC-582 用例 ① 红，`legacy-horizontal-files` 也红。
- **绑定多取别的模块**：用例 ② 红；取 DAG 之外的 offered public 时 `rfc294-review-offered-edge-dag` 也红。
- **`server.ts` 又从 `@/routes/` 取这些绑定**：用例 ③ 红。

## 5. 取舍（可推翻）

1. **只迁两个干净的**：另三个的边要先定，不在本 RFC 里补 DAG 或改端口。
2. **绑定放 `inbound/http/`**：与别的模块一致；已有的 `inbound/directTaskInitiator.ts` 不是 HTTP 绑定，不动。

## 6. 对 RFC-294 刷新后规则的对账

- **C10**：入站绑定进 owner 模块的 `inbound/http`，装配根经 composition 取。**C11**：public 面不变（撤回 0 个）。**C12**：RFC-582 用例 ① 覆盖 `src` /
  `tests` / `scripts` 的全部说明符；② ③ 只读相关文件。**C13**：`legacy-horizontal-files` 71 → 69，其余计数不升。
- **留下的债**：`routes/` 余 21 个；路由传输工具归位；等用户定的五个路由；identity-access 与凭据相邻的路由；task-catalog。
