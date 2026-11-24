# RFC-572 `util/` 的进程 / 执行一族归 platform（RFC-294 W9-D 后继）

- **状态**：Done（2026-11-24，落地 `cbbcf4692`，修正 `9507dea6e`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §4，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §2（“`util/` 中的通用原语归 `platform/`”）与 plan §4.6 W9-D；
  第一批见 [RFC-571](../RFC-571-util-primitives-into-platform-1/proposal.md)，做法沿用 [RFC-457](../RFC-457-services-platform-mechanisms/proposal.md)。

## 1. 背景

`util/` 还剩 27 个文件。其中六个是一个闭合的依赖集——彼此引用，对外只取 `util/log`：

| 文件                       | 内容                                       | 内部依赖                                  |
| -------------------------- | ------------------------------------------ | ----------------------------------------- |
| `util/platformExec.ts`     | 跨平台的可执行文件解析、路径与 shell 语法  | 无                                        |
| `util/windowsJobObject.ts` | Windows 作业对象（进程树归组）             | 无                                        |
| `util/process.ts`          | 进程存活、进程树终止、有界的子进程探测     | `platformExec`、`windowsJobObject`、`log` |
| `util/lock.ts`             | daemon 单实例 PID 锁                       | `process`                                 |
| `util/spawnDiagnostics.ts` | spawn 失败的诊断（缺的是命令还是工作目录） | 无                                        |
| `util/archive.ts`          | 备份与还原共用的 tar.gz 封装               | `platformExec`                            |

`platform/execution/local/` 已经是本机进程执行机制的家（受管进程、代理进程、脚本解释器），Windows 的 CI 也按这个目录的通配触发。

## 2. 目标

- **G1**：六个文件原样迁入 platform——五个进 `platform/execution/local/`（`lock.ts` 改名 `daemonLock.ts`），`archive.ts` 进 `platform/persistence/`；
  读者改指，旧位置不留转出。
- **G2**：`legacy-horizontal-files` 115 → 109；其余计数不升；行为不变。`windows-platform.yml` 的路径过滤同步（三个文件此后由既有的目录通配覆盖）。

## 3. 非目标

- `util/` 余下的 21 个：`errors` / `hash` / `log` / `paths` / `http` 读者数百处的另立；git、凭据、文件信任、Windows ACL、OIDC、脱敏与安全路径一族；
  `fsReclaim`、`migrationsFolder`、`daemonInfo` 随各自的依赖；`timeoutSignal`、`inFlight`、`sqlChunk` 见 RFC-571。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：六个旧路径不存在，全部源码、用例与脚本不再取它们；文件的可执行内容与原文件相同（只有文件之间互相引用的说明符随新位置重算，
  提到旧路径的三处注释随改）。
- **AC-2**：行为不变；Windows 平台工作流照常由这次提交触发并通过。
- **AC-3**：`legacy-horizontal-files` 上限 115 → 109；架构报告的归属表删去登记过的行；新增 RFC-572 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
