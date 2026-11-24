# RFC-571 技术设计

记号：`S/` = `packages/backend/src/`，`P/` = `S/platform/`。落在 platform（接收八个文件）与它们的读者（只改 import）。另改架构报告的归属表、
`architecture/counts.json`、钉着旧路径的用例与两处文档，新增一个 RFC-571 用例。数字取 HEAD `b872c6ca1`。不改行为。

## 1. 文件去向

| 原位置                       | 新位置                            | 说明                                                                |
| ---------------------------- | --------------------------------- | ------------------------------------------------------------------- |
| `S/util/semver.ts`           | `P/contracts/semver.ts`           | 纯函数，零 import                                                   |
| `S/util/time.ts`             | `P/contracts/monotonicNow.ts`     | 文件名改成它唯一的导出；零 import                                   |
| `S/util/keyedSerialQueue.ts` | `P/contracts/keyedSerialQueue.ts` | 并发原语，与同目录的 `semaphore.ts` 同类                            |
| `S/util/jsonDocument.ts`     | `P/http/jsonDocument.ts`          | 读者都是 HTTP 入站                                                  |
| `S/util/zodJsonSchema.ts`    | `P/operations/zodJsonSchema.ts`   | 入参合同的 schema 输出，与操作目录的 `apiDocs.ts`、`codecs.ts` 同类 |
| `S/util/frontmatter.ts`      | `P/content/frontmatter.ts`        | 文档内容的解析（依赖 `yaml`）                                       |
| `S/util/zip.ts`              | `P/content/zip.ts`                | 导出内容的编码（依赖 `fflate`）                                     |
| `S/util/version.ts`          | `P/execution/version.ts`          | 二进制版本标识，与同目录的 `daemonGeneration.ts` 同类               |

文件内容原样；只有文件头注释里写着自身旧路径的地方随改。

## 2. 读者改指

用解析器式的改写：对 `packages/backend` 的 `src/`、`tests/`、`scripts/` 与仓库根 `scripts/` 里每个 import / export / 动态 import 的说明符，解析成文件
路径后与旧路径比对；命中的按原来的写法改写（别名的仍用 `@/platform/...`，相对路径的重算相对路径）。`main.ts` 取版本的那一处与
`architecture/rfc427-entry-root` 的入口白名单同步。

## 3. 门、用例与文档

- 架构报告的 `LEGACY_BACKEND_FILE_OWNERS` 删去其中登记过的七行（`zodJsonSchema` 原本不在表里；迁入 platform 后按路径前缀就是 platform）。
- `counts.json` 的 `legacy-horizontal-files` 上限 125 → 115。
- 钉着旧路径的用例随改（`rfc284-microhelpers` 的 monotonic 公式唯一出处、`rfc143` 的 semver 单份、`zip-fixed-mtime-timezone` 读的模块路径等）。
- `docs/env-flags.md` 两行与 `scripts/build-binary.ts` 的一处注释改成新路径。`docs/dev-gotchas.md` 里提到旧路径的是事故记录，不改。
- 新增 `tests/rfc571-util-primitives-into-platform-boundary.test.ts`，登记 guard-manifest：① 八个旧路径不存在，`src` / `tests` / `scripts` 的全部
  说明符不再解析到它们（带负对照）；② 新位置的八个文件存在，不取模块、不取 `util/`、不取文件系统与进程；③ 导出的名字与搬迁前相同（清单钉住）。

## 4. 取舍（可推翻）

1. **都进 platform，不按“目前只有一个模块在用”归模块**：架构报告的归属表与 design §2 对这些文件给的去向就是 platform；它们是与业务无关的原语，
   今天只有一个读者不改变这一点。
2. **`time.ts` 改名 `monotonicNow.ts`**：platform 下一个叫 `time` 的文件会招来不相干的东西；它只有这一个导出。
3. **不留转出**：与 RFC-457 一致，读者一次改完；`services/` 的一跳转出曾经是专门清理过的债。

## 5. 失败模式

- **有人在旧路径重建文件或重新取它**：RFC-571 用例 ① 红。
- **新位置的文件开始取模块或 `util/`**：用例 ② 红（既有的 `platform-to-modules-file-pairs` 门也红）。

## 6. 对 RFC-294 刷新后规则的对账

- **C10**：八个原语进 platform 的对应目录。**C11**：不涉及 public。**C12**：RFC-571 用例覆盖 `src` / `tests` / `scripts` 的全部说明符与八个新文件。
  **C13**：`legacy-horizontal-files` 123 → 115，其余计数不升。
- **本 RFC 承担的演进**：W9-D 里 `util/` 通用原语迁入 platform 的第一批。
- **留下的债**：`util/` 余 27 个（proposal 非目标一节）。

## 7. 补迁（2026-11-24）：`inFlight` 与 `sqlChunk`

本 RFC 动手前把这两个文件留在了 `util/`（proposal 非目标一节）：它们自己没有任何 import，但读者里有两个身份认证文件与任务授权文件。RFC-572 迁进程 /
执行一族时遇到同样的情形（读者里有凭据与工作区边界的文件），做法是这类读者只改 import 说明符那一行、别的不动。按同样的做法把这两个补上。数字取
HEAD `9507dea6e`。

| 原位置               | 新位置                      | 说明                                                                                                                                   |
| -------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `S/util/inFlight.ts` | `P/contracts/inFlight.ts`   | 并发原语（同一个键上重叠的调用合并成一次），与同目录的 `keyedSerialQueue.ts`、`semaphore.ts` 同类；零 import                           |
| `S/util/sqlChunk.ts` | `P/persistence/sqlChunk.ts` | 按绑定参数上限分块执行查询；读者是三个模块 infrastructure 里的查询与同目录的 `capabilities.ts`，`batchInsert.ts` 的注释引它；零 import |

- **读者**：15 个生产文件、3 个用例文件与 1 个测试助手各改一行 import 说明符（解析器式改写，同 §2）。两个身份认证文件（`httpAuthentication.ts`、
  `crewStationAuthentication.ts`）只有这一行；`taskAuthorization.ts` 除这一行外另有一行注释写着旧路径，随改。另外三处注释里的旧路径
  （`capabilities.ts`、`batchInsert.ts`、`taskArchiveContentCoordinator.ts`）同样只改路径。两个文件自身逐字节不变。
- **门与用例**：架构报告的归属表删去这两行；`counts.json` 的 `legacy-horizontal-files` 上限 109 → 107。不另立用例文件——RFC-571 用例的迁移清单从
  八个扩到十个，三条判据与负对照一并覆盖这两个。
- **动手前的检索**：按 RFC-572 记进 `docs/dev-gotchas.md` 的清单查了旧路径的文本提及、分段拼出的路径、已提交的 JSON 账本、工作流与
  dependency-cruiser 配置和文档；除 import 之外只有归属表的两行与上面四处注释。
- **留下的债**：`util/` 余 19 个。
