# RFC-572 技术设计

记号：`S/` = `packages/backend/src/`，`P/` = `S/platform/`。落在 platform（接收六个文件）与它们的读者（只改 import）。另改架构报告的归属表、
`architecture/counts.json`、`windows-platform.yml` 的路径过滤、钉着旧路径的用例与文档，新增一个 RFC-572 用例。数字取 HEAD `7c9c778d4`。不改行为。

## 1. 文件去向

| 原位置                       | 新位置                                  | 说明                                                    |
| ---------------------------- | --------------------------------------- | ------------------------------------------------------- |
| `S/util/platformExec.ts`     | `P/execution/local/platformExec.ts`     | 不取内部文件（只取 `node:path`）                        |
| `S/util/windowsJobObject.ts` | `P/execution/local/windowsJobObject.ts` | 不取内部文件（只取 `bun:ffi`）                          |
| `S/util/process.ts`          | `P/execution/local/process.ts`          | 取同目录的两个与 `util/log`                             |
| `S/util/lock.ts`             | `P/execution/local/daemonLock.ts`       | 文件名改成它管的东西；取同目录的 `process`              |
| `S/util/spawnDiagnostics.ts` | `P/execution/local/spawnDiagnostics.ts` | 只取 node 的 fs / path                                  |
| `S/util/archive.ts`          | `P/persistence/archive.ts`              | 读者都是备份与还原；取 `P/execution/local/platformExec` |

文件的可执行内容原样；只有这六个文件之间互相引用的说明符按新位置重算，提到旧路径的三处注释随改。

## 2. 读者改指

与 RFC-571 同一个解析器式的改写，另处理“被迁文件自己的说明符”：按文件的旧位置解析、按新位置写回。读者分布：infrastructure 为主，另有
bootstrap、`cli/`、两个组合文件、三个 application 文件（两处值引用、一处类型引用）与 `util/git.ts`。

## 3. 门、工作流、用例与文档

- 架构报告的 `LEGACY_BACKEND_FILE_OWNERS` 删去登记过的六行；`counts.json` 的 `legacy-horizontal-files` 上限 115 → 109；公共内核清单
  `commons-manifest.json` 的两个文件路径与 `commons-debt.json` 的三个行号锚点改指新位置。
- `.github/workflows/windows-platform.yml`：push 与 pull_request 两份路径清单里的 `util/platformExec.ts`、`util/process.ts`、`util/windowsJobObject.ts`
  三行删去——两份清单里早就有 `packages/backend/src/platform/execution/local/**`，迁入后由它覆盖；两份清单保持逐行相同。
- 钉着旧路径的用例与源码注释随改；`rfc377` 的 `util/git` 叶子锁放行执行目录里的两个叶子（`platformExec`、`process`）；`docs/` 里的事故记录不改。
- 新增 `tests/rfc572-util-process-family-into-platform-boundary.test.ts`，登记 guard-manifest：① 六个旧路径不存在，`src` / `tests` / `scripts` 的全部
  说明符不再解析到它们（带负对照）；② 新位置的六个文件只取登记过的依赖（彼此、`util/log`、node 内置模块与 `bun:ffi`），不取模块；③ 导出的名字与搬迁前
  相同；④ Windows 工作流的两份路径清单都含执行目录的通配、都不含三个旧路径。

## 4. 取舍（可推翻）

1. **进 `platform/execution/local/`**：这里已经是本机进程执行机制的位置，读者里既有各模块的 `infrastructure/local/`，也有普通的 infrastructure 与
   application（现状就有这样的 import），没有门把这个目录限定给单机部署。
2. **`lock.ts` 改名 `daemonLock.ts`**：执行目录下一个叫 `lock` 的文件说不清锁的是什么；它只管 daemon 的单实例 PID 锁。
3. **`archive.ts` 进 `platform/persistence/`**：九个生产读者里八个是备份、还原与迁移的持久化代码。
4. **平台文件仍取 `util/log`**：`process.ts` 的日志依赖随 `log` 自己的迁移（读者数百处，另立）；RFC-457 之后平台取 `util/` 本就是容许的过渡。

## 5. 失败模式

- **有人在旧路径重建文件或重新取它**：RFC-572 用例 ① 红。
- **Windows 工作流的路径清单漏掉执行目录**：用例 ④ 红；两份清单不一致由既有的工作流守卫报出。

## 6. 对 RFC-294 刷新后规则的对账

- **C10**：进程 / 执行机制进 platform 的执行目录，tar 封装进持久化目录。**C11**：不涉及 public。**C12**：RFC-572 用例覆盖 `src` / `tests` / `scripts`
  的全部说明符、六个新文件与工作流的两份路径清单。**C13**：`legacy-horizontal-files` 115 → 109，其余计数不升。
- **本 RFC 承担的演进**：W9-D 里 `util/` 迁入 platform 的第二批。
- **留下的债**：`util/` 余 21 个（proposal 非目标一节）。
