# RFC-546 模块级可变单例的进程级例外清单与 §14 口径修订（RFC-294 S12 第 4 项，待用户确认）

- **状态**：Draft（2026-11-23）——**待用户确认**。RFC-294 plan §3 S12 第 4 项写明“确属进程级缓存、需要保留的，由后继 design 提出并经用户确认后
  修订 design §14 该行的口径”；本 RFC 就是那份后继 design。用户的推进授权（2026-11-02 起「过程中你以最优架构进行自行判断不用提交给我审批」）
  不覆盖这一条，所以本 RFC 只落档、不实施，等用户逐项确认。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S12 第 4 项；design §3 常驻规则 5、§14“模块级可变单例
  （生产态，bootstrap 外）0”。
- **前序**：RFC-532～545 已把这类单例从报告口径的 79 条（S12 立项时）降到 46 条（RFC-545 之后）；其中 RFC-543 查明句柄上下文登记表须保留。

## 1. 背景

S12 第 4 项的退出门是“模块级可变单例按 design §14 该行（或经确认修订后）的口径为 0”。架构报告在 RFC-545 之后还列 46 条，逐条读源码后分三类：

- **可迁移（9 条，继续拆，不在本 RFC）**：schema 历史运行时的登记（2 条）；守护进程级的服务状态（7 条：SCIP 索引缓存的单例与重置、仓库批量导入的
  全局并发信号量、镜像缓存的在途页合并表、仓库切面缓存的代次计数、变更叙述的在途生成状态），都能收进由组合根构造、注入的实例。
- **凭据 / 访问 / 完整性相邻（9 条，只审功能地单独处理，不在本 RFC）**：WebSocket 的三处登记（6 条）、遗留测试库标记（1 条）、技能启动复核
  （2 条）。
- **进程级（28 条，本 RFC 提议作为例外保留）**：见 §3。它们记的是进程一生不变或只增不减的事实（主机探测、只告警一次、唯一名计数），或者
  是只能按身份记的表（冻结对象），或者是进程唯一的输出端（stdout 日志）；收进实例要么换不来什么（每个实例重复探测同一台主机），要么根本
  做不到（冻结对象记不了属性）。

## 2. 提议（待确认）

1. **例外清单**：§3 的 28 条作为“进程级例外”保留，登记进一份清单（文件、符号、种类、类别、理由），由守卫钉住——清单之外出现新的模块级
   可变单例即红，清单里的条目消失也红（防止过期）。
2. **§14 口径**：design §14 该行改为“模块级可变单例（生产态，bootstrap 外，**不计登记的进程级例外**）0”，例外清单随之列在 design 或单独的
   清单文件里。
3. **其余两类不变**：可迁移的 9 条继续由后继 RFC 拆到 0；凭据 / 访问 / 完整性相邻的 9 条由用户另定处理方式（只审功能地重构，或同样登记为
   例外）。

## 3. 进程级例外（28 条）

| 类别                         | 位置（`packages/backend/src/…`）                                                | 符号                                                                                    | 理由                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 主机 / 工具探测（一生不变）  | `modules/resource-catalog/infrastructure/local/filePluginInstallation.ts`       | `npmProbeCache`、`resetNpmProbeCacheForTests`                                           | 本机 npm 是否可用，带 5 分钟有效期                                   |
|                              | `modules/runtime-management/infrastructure/drivers/opencode/versionRegistry.ts` | `resetOpencodeBinaryVersionsForTests`                                                   | opencode 可执行文件的版本探测结果                                    |
|                              | `platform/workspace/local/gitVersion.ts`                                        | `cached`                                                                                | 本机 git 的版本与能力                                                |
|                              | `util/archive.ts`                                                               | `tarProbe`、`resetTarProbeForTests`                                                     | 本机 tar 是否可用                                                    |
|                              | `util/win32Acl.ts`                                                              | `cachedUserSid`                                                                         | 当前 Windows 用户的 SID                                              |
|                              | `util/windowsJobObject.ts`                                                      | `kernel32`、`resetKernel32CacheForTests`                                                | kernel32 的 FFI 句柄                                                 |
| 运行库初始化（一次）         | `modules/workspace-insight/engine/lang/grammars.ts`                             | `_grammarsDir`、`_runtimeWasm`                                                          | tree-sitter 语法目录与运行库 WASM 的位置                             |
|                              | `modules/workspace-insight/engine/lang/parser.ts`                               | `_initPromise`                                                                          | tree-sitter 运行库只初始化一次                                       |
| 不变数据的备忘               | `platform/persistence/capabilities.ts`                                          | `sqliteCapabilities`、`postgresqlCapabilities`                                          | 两种引擎的能力表（冻结、按需建一次）                                 |
|                              | `platform/persistence/migration/legacy/postgresqlMigrationHistory.ts`           | `runtimeHistory`、`runtimeHeadContract`                                                 | 嵌入二进制的迁移历史校验一次约 2 秒 CPU，源码注明一进程一份          |
| 唯一名计数 / 随机数          | `services/gitSubmodule.ts`                                                      | `gitlinkIdxCounter`                                                                     | 临时 gitlink 名的进程内唯一序号                                      |
|                              | `util/git.ts`                                                                   | `isoTmpIndexCounter`、`subsnapNonce`                                                    | 临时 index 路径与快照 pin ref 的进程内唯一序号                       |
|                              | `util/win32Acl.ts`                                                              | `sinkCounter`                                                                           | 临时输出文件的进程内唯一序号                                         |
| 只告警一次                   | `util/process.ts`                                                               | `ownershipDegradationWarned`                                                            | 进程所有权降级的提示只打一次                                         |
| 进程唯一的输出端             | `util/log.ts`                                                                   | `configureLogger`、`resetLoggerForTest`、`setLoggerStdoutWriterForTest`、`stdoutWriter` | 日志级别与 stdout 写入端；全仓数百处 `createLogger` 在模块求值时取用 |
| 只能按身份记（对象不可扩展） | `platform/persistence/sessionTables.ts`                                         | `bindDatabaseHandle`（写 `contexts`）                                                   | RFC-395 T18 X1：冻结的句柄与客户端也要带上下文（RFC-543 查明）       |
|                              | `platform/persistence/postgresqlDatabaseClient.ts`                              | `resetPostgresqlGenerationWriteCache`（写 `markedGenerations`）                         | PostgreSQL 运行期是冻结对象，代次已标记的记录只能按身份记            |
| 动态作用域的性能缓存         | `platform/persistence/schema/canonical.ts`                                      | `activeFragments`                                                                       | 只在一次同步回放期间生效、结束即复原；输出与不缓存逐字相同           |

## 4. 能力影响

无（只落档；确认后的实施只加清单与守卫、改 design §14 的一行文字）。

## 5. 需要用户确认

- **Q1**：§3 的 28 条是否作为进程级例外保留（可以逐条否决，否决的转入“可迁移”由后继 RFC 拆）？
- **Q2**：design §14 该行改为“模块级可变单例（生产态，bootstrap 外，不计登记的进程级例外）0”是否可以？
- **Q3**：凭据 / 访问 / 完整性相邻的 9 条：只审功能地重构到 0，还是同样登记为例外？
