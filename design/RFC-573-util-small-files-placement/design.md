# RFC-573 技术设计

记号：`S/` = `packages/backend/src/`，`P/` = `S/platform/`，`SO/` = `S/modules/system-operations/`。落在 platform（接收三个文件）、system-operations 的
infrastructure（接收运行信息文件的读取）、bootstrap 与 `cli/status.ts`（`status` 命令的接线），以及这些文件的读者（只改 import）。另改架构报告的
归属表、`architecture/counts.json`、`windows-platform.yml` 的路径清单、钉着旧路径的用例与一处文档，新增一个 RFC-573 用例。数字取 HEAD
`1db8cc54f`。不改行为。

## 1. 迁入 platform 的三个文件

| 原位置                       | 新位置                                        | 说明                                                                              |
| ---------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| `S/util/timeoutSignal.ts`    | `P/contracts/timeoutSignal.ts`                | 零 import 的原语，与同目录的 `monotonicNow.ts`、`inFlight.ts` 同类                |
| `S/util/fsReclaim.ts`        | `P/workspace/local/fsReclaim.ts`              | 回收工作区目录；四个读者都是工作区的隔离、维护与准备。取 `util/log` 与 node 的 fs |
| `S/util/migrationsFolder.ts` | `P/persistence/migration/migrationsFolder.ts` | 两个生产读者都在这个目录下。取 `embed`、`util/paths` 与 node 的 fs / path         |

文件内容原样。

## 2. `daemonInfo` 归 system-operations

现状：`S/util/daemonInfo.ts` 导出 `readDaemonInfo(path = Paths.daemonInfo)` 与类型别名 `DaemonInfo = DaemonRuntimeInfo`。两个生产读者：

- `SO/infrastructure/local/fileDaemonRuntimeQueries.ts`：`createFileDaemonRuntimeQueries` 把它包成 `DaemonRuntimeQueries.readCurrent`；
- `S/cli/status.ts`：`statusCommand()` 直接调它。

改成：

- **读取并入文件实现**。`readDaemonInfo` 连同说明“为什么运行信息文件是唯一事实源”的那段注释迁入 `fileDaemonRuntimeQueries.ts`，改名
  `readDaemonInfoFile`（它读的是文件，与端口方法 `readCurrent` 区分开）；返回类型直接用本模块 domain 的 `DaemonRuntimeInfo`，别名 `DaemonInfo` 删去。
  函数体不变：文件不存在或解析失败都返回 `null`。
- **`status` 命令经端口读**。`statusCommand(daemonRuntime: DaemonRuntimeQueries)`：原来调 `readDaemonInfo()` 的那一处改成
  `await daemonRuntime.readCurrent()`；`StatusResult.info` 的类型改用 system-operations public 的 `DaemonRuntimeInfo`。`cli/status.ts` 对
  system-operations 只有这两处类型 import（`cli/` 的其他命令也是这样取端口类型的）。
- **bootstrap 交入文件实现**。`SO/composition/daemonHostLifecycle.ts` 多导出 `createFileDaemonRuntimeQueries`；
  `S/bootstrap/commandBootstraps.ts` 增 `composeStatusCommandDaemonRuntime()`，返回 `createFileDaemonRuntimeQueries()`（默认路径仍是
  `Paths.daemonInfo`）；`main.ts` 的 `status` 分支把它交给 `statusCommand`。`main.ts` 仍然只取 bootstrap 与 `cli/`。

`GET /api/daemon` 不变：它本来就经 `DaemonRuntimeQueries` 读。

## 3. 读者改指

与 RFC-571 / RFC-572 同一个解析器式的改写：前三个文件的 15 个生产读者、5 个用例文件与 1 个测试助手各改一行 import 说明符。读者里有三类只动
import 那一行与提到旧路径的注释、别的不动的文件：`auth/oidc/` 的三个（`timeoutSignal`）、`util/git.ts`（`fsReclaim`）与 source-control 的
`nodeWorkspaceMaintenanceFilesystem.ts`（`fsReclaim`）。

`daemonInfo` 的用例读者手工改：`daemon-info-route` 里测读取函数的三条与 `rfc398AutoUpgrade` 助手改取新位置的 `readDaemonInfoFile`；`cli.test` 的两处
`statusCommand()` 改成交入文件实现；`rfc370-daemon-host-root-wiring` 里“路由不直接取读取函数”的那条断言改成盯新位置。

## 4. 门、工作流、用例与文档

- 架构报告的 `LEGACY_BACKEND_FILE_OWNERS` 删去这四个文件的行；`counts.json` 的 `legacy-horizontal-files` 上限 107 → 103。
- `.github/workflows/windows-platform.yml`：push 与 pull_request 两份路径清单里的 `packages/backend/src/util/fsReclaim.ts` 各改成
  `packages/backend/src/platform/workspace/local/fsReclaim.ts`；两份清单保持逐行相同（`ci-workflow-path-filters` 另查“清单里的路径都存在”）。
- 钉着旧路径的地方随改：`rfc254-no-unref-deadline-guard` 里放行 `timeoutSignal` 自身的那条（路径是分段拼的）与注释；五处源码注释里的
  `util/timeoutSignal.ts`；`cli-embedded-migrations` 里放行解析器自身的那条；`rfc359-w5-same-file-provider-pairs` 账本里以路径为键的一行（账本
  要求有序，新键仍排在末尾）与 `rfc359-w5-t19f` 里的一处注释；`rfc377` 的 `util/git` 叶子锁按精确说明符放行 `fsReclaim` 的新位置（同目录的 `isolation` 仍然被拒，原有负对照
  保留）。
- `docs/dev-gotchas.md` 里“fetch 超时用 `util/timeoutSignal.ts`”那一句是现行指引，改成新路径；`docs/audit-backlog.md` 里的是事故记录，不改。
- 新增 `tests/rfc573-util-small-files-placement-boundary.test.ts`，登记 guard-manifest：① 四个旧路径不存在，`src` / `tests` / `scripts` 的全部说明符
  不再解析到它们（带负对照）；② 迁入 platform 的三个文件只取登记过的依赖，不取模块；③ 三个文件导出的名字与搬迁前相同；④ `cli/status.ts` 只取
  system-operations 的 public 类型、不取任何模块的 infrastructure 与 composition，`statusCommand` 经交入的端口读运行信息，bootstrap 交入的是
  system-operations 装配根给出的文件实现；⑤ Windows 工作流的两份路径清单都含 `fsReclaim` 的新路径、都不含旧路径。

## 5. 取舍（可推翻）

1. **`daemonInfo` 归 system-operations，不归 platform**：归属表写的是 platform，但这个文件的内容是 system-operations 一个端口的文件实现，返回类型
   是它的 domain 类型；放进 platform 要么让 platform 取模块（门不许），要么在 platform 复制一份类型。并入已有的文件实现后，`util/` 少一个文件，
   system-operations 少一条对 `util/` 的依赖。
2. **`status` 命令经端口读，不直接取 infrastructure**：`cli/` 的其他命令都是“类型取 public、实例由 bootstrap 交入”；`status` 是剩下的一个直接取
   实现的。
3. **读取函数改名 `readDaemonInfoFile`**：迁入后它与端口方法 `readCurrent` 同处一个文件，名字里写明读的是文件。
4. **`fsReclaim` 进 `platform/workspace/local/`**：它只用来回收工作区目录，四个读者都是工作区的隔离、维护与准备；这个目录现在就被 source-control
   与 task-execution 的 infrastructure 取用。
5. **`migrationsFolder` 进 `platform/persistence/migration/`**：两个生产读者都在这个目录下；它取 `embed`（归属表里的去向同样是 platform）。
6. **`util/git` 的叶子锁按精确说明符放行**：与 RFC-572 的做法一致，不整目录放行。

## 6. 失败模式

- **有人在旧路径重建文件或重新取它**：RFC-573 用例 ① 红。
- **`status` 命令又直接取读取函数**：用例 ④ 红。
- **Windows 工作流的路径清单漏改**：用例 ⑤ 红；`ci-workflow-path-filters` 的“路径都存在”也红。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：三个平台机制进 platform 的对应目录；运行信息文件的读取进它的 owner（system-operations 的 infrastructure），命令入口经端口取。
  **C11**：不改 public 的形状（`cli/status.ts` 新取两处已有的 public 类型）。**C12**：RFC-573 用例 ① 覆盖 `src` / `tests` / `scripts` 的全部
  说明符；② ③ 只读三个新文件；④ 只读 `cli/status.ts`、`bootstrap/commandBootstraps.ts`、`main.ts` 与 system-operations 的两个文件；⑤ 只读工作流
  文件。**C13**：`legacy-horizontal-files` 107 → 103，其余计数不升。
- **本 RFC 承担的演进**：W9-D 里 `util/` 的第三批；`status` 命令补上“经端口读”这一步。
- **留下的债**：`util/` 余 15 个（proposal 非目标一节）。
