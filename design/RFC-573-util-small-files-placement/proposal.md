# RFC-573 `util/` 的四个余下小文件归位（RFC-294 W9-D 后继）

- **状态**：Done（2026-11-25，落地 `3a9a99e64`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §5，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §2（“`util/` 中的通用原语归 `platform/`”）与 plan §4.6 W9-D；
  前两批见 [RFC-571](../RFC-571-util-primitives-into-platform-1/proposal.md)（含补迁）与
  [RFC-572](../RFC-572-util-process-family-into-platform/proposal.md)，做法沿用 [RFC-457](../RFC-457-services-platform-mechanisms/proposal.md)。

## 1. 背景

`util/` 还剩 19 个文件。扣掉读者数百处的五个（`errors`、`hash`、`log`、`paths`、`http`）和 git、凭据、文件信任、Windows ACL、OIDC、脱敏与安全路径
一族的十个，余下四个：

| 文件                       | 内容                                                  | 内部依赖                                       | 生产读者                                                                                        |
| -------------------------- | ----------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `util/timeoutSignal.ts`    | 带 ref 定时器的超时信号（代替 `AbortSignal.timeout`） | 无                                             | platform 五个、integration 一个、`auth/oidc/` 三个                                              |
| `util/fsReclaim.ts`        | 带退避的目录树删除（回收工作区目录）                  | `util/log`                                     | `platform/workspace/local/isolation.ts`、source-control 与 task-execution 各一个、`util/git.ts` |
| `util/migrationsFolder.ts` | 编号迁移目录的唯一解析入口（单二进制里先解包）        | `embed`、`util/paths`                          | `platform/persistence/migration/` 下两个                                                        |
| `util/daemonInfo.ts`       | 读 daemon 的运行信息文件                              | system-operations 的 public 类型、`util/paths` | `cli/status.ts`、system-operations 的 `infrastructure/local/fileDaemonRuntimeQueries.ts`        |

前三个是平台机制，读者已经在它们该去的目录里或者紧挨着。

第四个不一样。它的返回类型是 system-operations 的 `DaemonRuntimeInfo`；system-operations 早就有“daemon 运行信息”的查询端口
（`DaemonRuntimeQueries`）和这个端口的文件实现（`createFileDaemonRuntimeQueries`，现在只是把 `readDaemonInfo` 包了一层）。也就是说这个读取函数
本来就是那个文件实现的内容，只是住在 `util/`；`agent-workflow status` 绕过端口直接取它。架构报告的归属表把它记给 platform，但 platform 不能取模块
的类型，它去不了那里。

## 2. 目标

- **G1**：`timeoutSignal` 进 `platform/contracts/`，`fsReclaim` 进 `platform/workspace/local/`，`migrationsFolder` 进
  `platform/persistence/migration/`；原样迁移、读者改指、旧位置不留转出。
- **G2**：`daemonInfo` 的读取并入 system-operations 的 `infrastructure/local/fileDaemonRuntimeQueries.ts`；`status` 命令改经
  `DaemonRuntimeQueries` 端口读运行信息，文件实现由 bootstrap 交入。
- **G3**：`legacy-horizontal-files` 107 → 103；其余计数不升；行为不变。`windows-platform.yml` 两份路径清单里 `fsReclaim` 那一行改指新位置。

## 3. 非目标

- `util/` 余下的 15 个：`errors` / `hash` / `log` / `paths` / `http` 另立；git、凭据、文件信任、Windows ACL、OIDC、脱敏与安全路径一族不动。
- 不改 `status` 命令的输出与退出码，不改 `GET /api/daemon`。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：四个旧路径不存在，全部源码、用例与脚本不再取它们；迁入 platform 的三个文件内容与原文件相同。
- **AC-2**：行为不变。`status` 命令三种状态的结果与输出不变；`cli/status.ts` 不取任何模块的 infrastructure，运行信息经端口读；运行信息文件
  缺失或损坏时仍然得到“没有运行信息”而不是报错。
- **AC-3**：`legacy-horizontal-files` 上限 107 → 103；架构报告的归属表删去四行；Windows 工作流两份路径清单同步；新增 RFC-573 用例并登记
  guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
