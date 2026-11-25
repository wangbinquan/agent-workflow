# RFC-577 技术设计

记号：`S/` = `packages/backend/src/`，`EC/`、`INT/` 分别是 execution-contract、integration 的模块目录。数字取 HEAD `23bd6b03a`。不改行为。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：两个模块各自的 `inbound/http`；挂载函数经各模块的 `composition.ts` 转出（integration 与 event-center 已经这样做）。
- **承担的演进**：`routes/` → 模块 `inbound/` 的第二批；两个模块的 public 面撤回只被路由用的转出。
- **不新增** DAG 之外的边：两个绑定对模块的依赖只有本模块（public 或内部定义）；`server.ts` 指向 composition 属装配根例外。
- **留下的债**：绑定仍用 `routes/registry` 与 `@/auth/actor`，随传输工具归位另立；task-catalog 的路由（proposal §1）。
- **偏离项**：无。

## 1. 文件去向与连接

| 原文件                           | 新位置                                       | 改动                                                                                  |
| -------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `S/routes/executionContracts.ts` | `EC/inbound/http/executionContractRoutes.ts` | `parseExecutionContractRef` 改取 `../../domain/model`                                 |
| `S/routes/codeHosts.ts`          | `INT/inbound/http/codeHostRoutes.ts`         | `CodeHostConnectionAdministration` 改取 `../../application/ports/codeHostConnections` |

- 两个模块的 `composition.ts` 各加一条 `export { mount…Routes } from './inbound/http/…'`；`server.ts` 的两条 import 改从这两个 composition 取
  （integration 那条并进已有的 import）。挂载调用与顺序不变。
- public 撤回：`EC/public/types.ts` 删去 `parseExecutionContractRef` 的转出；`INT/public/types.ts` 删去 `CodeHostConnectionAdministration` 与它连带的
  三个端口类型的转出（集中验证里第二次出报告时查出），只剩 `CodeHostConnectionCredential`、`CodeHostConnectionProbe`。

## 2. 门、用例与文档

- 架构报告的 `LEGACY_BACKEND_FILE_OWNERS` 删去两行；`counts.json` 的 `legacy-horizontal-files` 上限 91 → 89。
- 钉着旧路径的地方随改：读源码的用例（`rfc450-code-host-family-into-integration`、`rfc349-source-control-promise-contract`）与 e2e 的一处指针；描述
  过往迁移的注释与账本说明不改。
- `design/RFC-310-…/os-architecture-manifest.json`（`rfc310-digital-employee-os-architecture` 读它）：execution-contract 的顶层目录多了 `inbound`，
  它的模块外依赖里 `routes/executionContracts.ts -> public/types` 换成 `server.ts -> composition`。
- `rfc317-table-ownership` 的“非模块源文件多于 600 个”这条下限改成 500：W9-D 把 legacy 文件迁进模块，这份语料按设计在缩小（本 RFC 之后 599）。它只
  证明扫描不是空的；这个守卫记在 guard-manifest 里的下限（`units.length > 700`，`minCorpusFiles` 701）不变。
- 新增 `tests/rfc577-single-route-families-into-inbound-boundary.test.ts`，登记 guard-manifest：① 两个旧路径不存在，`src` / `tests` / `scripts` 的
  全部说明符不再解析到它们（带负对照）；② 两个绑定对模块的 import 只取本模块（别名只到本模块 public，相对路径只到本模块 application / domain /
  public），不取 `@/db`、`services/` 与别的模块（带负对照）；③ 两个 public 入口不再转出被撤回的符号；④ `server.ts` 从两个模块的 composition 取两个
  挂载函数。

## 3. 检索

按 `docs/dev-gotchas.md`“挪文件前的检索”：路径文本（含 `e2e/`、`design/` 的 Markdown 链接、账本）、分段与正则写法、泛化放行、源码摘要锁、按目录名
判的规则；另按 RFC-576 的教训先算“只被这些路由用的 public 符号”，并在出报告时看连带。

## 4. 失败模式

- **有人在旧路径重建文件或重新取它**：RFC-577 用例 ① 红。
- **撤回的符号又从 public 转出**：用例 ③ 红，`unconsumed-public-symbols-*` 门也红。
- **`server.ts` 又从 `@/routes/` 取这些绑定**：用例 ④ 红。

## 5. 取舍（可推翻）

1. **两族一个 RFC**：每族一个文件、几处 public 转出，做法与验证相同。
2. **task-catalog 先不动**：它的路由一进模块，task-catalog 就没有 public 面了，要在 `rfc317-module-boundary` 的 R3 账本里入账（理由与清偿波次），连带
   好几处“有 public 面的 context 至少 19 个”的下限。这是“一个模块可不可以只有入站绑定、没有 public 合同”的结构决定，留给单独的 RFC。

## 6. 对 RFC-294 刷新后规则的对账

- **C10**：入站绑定进 owner 模块的 `inbound/http`，装配根经 composition 取。**C11**：两个 public 面收窄只被本模块用的转出（共五个）。**C12**：RFC-577
  用例 ① 覆盖 `src` / `tests` / `scripts` 的全部说明符；② ③ ④ 只读相关文件。**C13**：`legacy-horizontal-files` 91 → 89，其余计数不升。
- **留下的债**：`routes/` 余 41 个；路由传输工具归位；task-catalog 的路由。
