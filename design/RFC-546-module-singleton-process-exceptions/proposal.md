# RFC-546 模块级可变单例的进程级例外清单与 §14 口径修订（RFC-294 S12 第 4 项）

- **状态**：Done（2026-11-26，落地 `03008a73a`）。2026-11-23 落档为 Draft、待用户确认 Q1～Q3。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批，不要每个RFC就停下来，你要持续推进」
  答复的是上一条消息里待定的四件事，第 3 件即本 RFC 的 Q1～Q3；裁定由本会话按最优架构给出（§5）。设计门免、不派 Codex（用户 2026-10-31）；
  实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S12 第 4 项；design §3 常驻规则 5、§14“模块级可变单例
  （生产态，bootstrap 外）0”。
- **前序**：RFC-532～545 把这类单例从报告口径的 79 条（S12 立项时）降到 46 条（RFC-545 之后），其中 RFC-543 查明句柄上下文登记表须保留；
  落档之后，可迁移的 9 条由 RFC-547、RFC-548、RFC-549 拆完（46 → 37）。

## 1. 背景

S12 第 4 项的退出门是“模块级可变单例按 design §14 该行（或经确认修订后）的口径为 0”。HEAD `a3def727e` 上架构报告列 37 条，逐条读源码后分两类：

- **凭据 / 访问 / 完整性相邻（9 条）**：WebSocket 的三处登记（6 条）、遗留测试库标记（1 条）、技能启动复核（2 条）。
- **进程级（28 条）**：见 §3。
  - 它们记的是进程一生不变或只增不减的事实（主机探测、只告警一次、唯一名计数），或者是只能按身份记的表（冻结对象），或者是进程唯一的输出端
    （stdout 日志）。
  - 收进实例要么换不来什么（每个实例重复探测同一台主机），要么根本做不到（冻结对象记不了属性）。

没有任何守卫钉住这 37 条：新增一条不会红，删掉一条也不会提醒更新口径。

## 2. 目标

- **G1 例外清单**：§3 的 28 条作为“进程级例外”保留，登记进 `architecture/module-singleton-exceptions.json`（文件、符号、种类、类别、理由）。
- **G2 待迁清单**：凭据 / 访问 / 完整性相邻的 9 条登记在同一文件的 `pending` 里（文件、符号、种类、一族、理由），只减不增。
- **G3 守卫**：判据在真实语料上的结果必须等于两份清单之和，两份互不重叠。清单外出现新的模块级可变单例即红；清单里的条目在源码里消失也红，
  防止过期。两份的条数不高于落地时的值。
- **G4 §14 口径**：RFC-294 design §14 该行改为“模块级可变单例（生产态，bootstrap 外，**不计登记的进程级例外**）0”，并指向清单文件。

## 3. 进程级例外（28 条）

位置按 HEAD `a3def727e`；落档后迁过文件的 6 处（`util/archive.ts`、`util/windowsJobObject.ts`、`services/gitSubmodule.ts`、`util/git.ts`、
`util/process.ts`、`util/log.ts`）按新位置列。

| 类别                         | 位置（`packages/backend/src/…`）                                                | 符号                                                                                    | 理由                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 主机 / 工具探测（一生不变）  | `modules/resource-catalog/infrastructure/local/filePluginInstallation.ts`       | `npmProbeCache`、`resetNpmProbeCacheForTests`                                           | 本机 npm 是否可用，带 5 分钟有效期                                   |
|                              | `modules/runtime-management/infrastructure/drivers/opencode/versionRegistry.ts` | `resetOpencodeBinaryVersionsForTests`                                                   | opencode 可执行文件的版本探测结果                                    |
|                              | `platform/workspace/local/gitVersion.ts`                                        | `cached`                                                                                | 本机 git 的版本与能力                                                |
|                              | `platform/persistence/archive.ts`                                               | `tarProbe`、`resetTarProbeForTests`                                                     | 本机 tar 是否可用                                                    |
|                              | `util/win32Acl.ts`                                                              | `cachedUserSid`                                                                         | 当前 Windows 用户的 SID                                              |
|                              | `platform/execution/local/windowsJobObject.ts`                                  | `kernel32`、`resetKernel32CacheForTests`                                                | kernel32 的 FFI 句柄                                                 |
| 运行库初始化（一次）         | `modules/workspace-insight/engine/lang/grammars.ts`                             | `_grammarsDir`、`_runtimeWasm`                                                          | tree-sitter 语法目录与运行库 WASM 的位置                             |
|                              | `modules/workspace-insight/engine/lang/parser.ts`                               | `_initPromise`                                                                          | tree-sitter 运行库只初始化一次                                       |
| 不变数据的备忘               | `platform/persistence/capabilities.ts`                                          | `sqliteCapabilities`、`postgresqlCapabilities`                                          | 两种引擎的能力表（冻结、按需建一次）                                 |
|                              | `platform/persistence/migration/legacy/postgresqlMigrationHistory.ts`           | `runtimeHistory`、`runtimeHeadContract`                                                 | 嵌入二进制的迁移历史校验一次约 2 秒 CPU，源码注明一进程一份          |
| 唯一名计数 / 随机数          | `modules/source-control/infrastructure/local/gitSubmodule.ts`                   | `gitlinkIdxCounter`                                                                     | 临时 gitlink 名的进程内唯一序号                                      |
|                              | `modules/source-control/infrastructure/local/gitRepository.ts`                  | `isoTmpIndexCounter`、`subsnapNonce`                                                    | 临时 index 路径与快照 pin ref 的进程内唯一序号                       |
|                              | `util/win32Acl.ts`                                                              | `sinkCounter`                                                                           | 临时输出文件的进程内唯一序号                                         |
| 只告警一次                   | `platform/execution/local/process.ts`                                           | `ownershipDegradationWarned`                                                            | 进程所有权降级的提示只打一次                                         |
| 进程唯一的输出端             | `platform/logging/logger.ts`                                                    | `configureLogger`、`resetLoggerForTest`、`setLoggerStdoutWriterForTest`、`stdoutWriter` | 日志级别与 stdout 写入端；全仓数百处 `createLogger` 在模块求值时取用 |
| 只能按身份记（对象不可扩展） | `platform/persistence/sessionTables.ts`                                         | `bindDatabaseHandle`（写 `contexts`）                                                   | RFC-395 T18 X1：冻结的句柄与客户端也要带上下文（RFC-543 查明）       |
|                              | `platform/persistence/postgresqlDatabaseClient.ts`                              | `resetPostgresqlGenerationWriteCache`（写 `markedGenerations`）                         | PostgreSQL 运行期是冻结对象，代次已标记的记录只能按身份记            |
| 动态作用域的性能缓存         | `platform/persistence/schema/canonical.ts`                                      | `activeFragments`                                                                       | 只在一次同步回放期间生效、结束即复原；输出与不缓存逐字相同           |

## 4. 能力影响清单

无。只加清单与守卫、改 design §14 的一行文字；生产代码不改。

## 5. 裁定（2026-11-26，本会话）

- **Q1（§3 的 28 条是否作为进程级例外保留）**：全部保留。在 HEAD 上逐条读过源码，种类与理由都与落档时相同，只有 6 处换了文件。
- **Q2（design §14 该行的口径）**：改为“模块级可变单例（生产态，bootstrap 外，不计登记的进程级例外）0”，指向清单文件。
- **Q3（凭据 / 访问 / 完整性相邻的 9 条）**：不登记为例外。
  - 它们是守护进程的服务状态，不是进程级事实，终态是收进组合根构造的实例（与 RFC-547、RFC-548 同一做法），也就是“重构到 0”。
  - 它们都在延后处理的 `ws/` 与 legacy 一族里，随该族迁移时一并处理，本 RFC 不改这些文件。
  - 在此之前列在清单的 `pending` 里，只减不增；`pending` 清空时 S12 第 4 项的退出门达成。

## 6. 用户可见变化

无。

## 7. 验收标准

- **AC-1**：清单落地，28 条例外与 9 条待迁的位置、种类与判据结果逐条相等。
- **AC-2**：守卫在真实语料上为绿；负对照里清单外的单例、过期的条目、重复与缺字段都被认出。
- **AC-3**：design §14 该行改为修订后的口径并指向清单。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
