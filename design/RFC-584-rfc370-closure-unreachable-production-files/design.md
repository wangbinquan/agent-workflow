# RFC-584 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`。数字取 HEAD `1e6e2a282`。不改生产行为。

## 0. 架构落位（RFC-294 第 8 条）

- **层 / 位置**：只供用例的兼容入口不属于任何生产层，迁入 `T/helpers/`（RFC-491 / RFC-492 / RFC-467 的做法）；一跳转出与过时副本删除（“删除优于
  deprecate”）。
- **承担的演进**：S11 的不可达生产文件计数与 design §3 的“application 不直接做文件系统 / 进程 / 网络效果”（`application-direct-effect-files` 清零）。
- **不新增**依赖：生产源码不 import `tests/`；迁走的文件只取模块的现有文件。
- **偏离项**：无。

## 1. 文件去向

| 原文件                                                                      | 去向                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------ |
| `S/modules/development-automation/infrastructure/actionWorkspace.ts`        | `T/helpers/developmentActionWorkspace.ts`        |
| `S/modules/development-automation/infrastructure/pipelineEvidenceImport.ts` | `T/helpers/developmentPipelineEvidenceImport.ts` |
| `S/modules/development-automation/infrastructure/verificationRunner.ts`     | `T/helpers/developmentVerificationRunner.ts`     |
| `S/modules/event-center/infrastructure/customEventObserverProgram.ts`       | `T/helpers/customEventObserverProgram.ts`        |
| `S/modules/task-execution/composition/systemAgentRun.ts`                    | `T/helpers/preparedSystemAgentRun.ts`            |
| `S/modules/resource-catalog/infrastructure/mcpDiagnosticsEffects.ts`        | 删除（一跳转出）                                 |
| `S/modules/intent/application/maintenance.ts`                               | 删除（过时副本）                                 |

- **迁走的五个**：内容逐字不变；原来的相对 import 改成指向同一文件的 `@/` 别名（文件离开了 `src`），头注加一行说明去向。用例的 import 由搬迁脚本改写
  （从用例到 `T/helpers/` 用相对路径）。
- **MCP 诊断的旧地址**：它只把 `local/mcpDiagnosticsEffects.ts` 的 `createLocalMcpDiagnosticsEffects` 改名转出。唯一的用例改从本机实现取（import 时
  起同样的别名）；`rfc282-c0c2-runtime-fence` 两处“消费方不再自己判断”的清单改指本机实现——检查落到真正的实现上，比查一个转出文件更强。
- **Intent 维护副本**：生产的维护由 RFC-503 的 `application/maintenanceCommands.ts` 实现（端口化：草稿目录经 `IntentScratchStore`，持久化另记清理
  水位），intent composition 交出 `composeIntentMaintenanceCommands` 与 `composeLocalIntentScratch`。副本是 RFC-503 之前直接读写文件系统的版本，只有
  `rfc234-turn-engine` 的四条维护用例在用。用例改为：`recovery.bootTurnIds()` 取启动快照、`recovery.recover({ recoverTurnIds })` 的 `orphanedTurns`
  对应原来的返回数、`scratch.sweep({ retentionHours })` 的 `removed` 对应原来的清理数；落库与目录上的断言不变。

## 2. 门、用例与文档

- `rfc376-structural-guards`：`unreachable-production-files` 基线删七行、`application-direct-effect-files` 基线删一行（各加销账注释）；后继表里
  “RFC-370 收口”的两组删去迁走与删除的文件（第二组只剩 `standbyExecutionAuthority.ts`）。
- `rfc521-composition-adapter-fallbacks` 的分类表删去 `task-execution/composition/systemAgentRun.ts`（文件离开了 composition）。
- `counts.json`：`unreachable-production-files` 15 → 8、`application-direct-effect-files` 1 → 0；另把 `legacy-service-implementations` 的上限 6 收紧到
  实测 4（RFC-544 迁走两个文件后一直是 4，按 C13 由后继收紧）；其余计数若随之下降一并收紧（以候选报告为准）。
- 新增 `T/rfc584-rfc370-closure-unreachable-production-files-boundary.test.ts`，登记 guard-manifest：① 七个旧路径不存在，`src` / `tests` / `scripts`
  的全部说明符不再解析到它们（带负对照）；② 五个迁走的文件在 `T/helpers/`，生产源码没有任何说明符解析到 `tests/`（带负对照）；③ `rfc234-turn-engine`
  的维护用例取 intent composition 的生产命令，不再出现副本的三个函数名。

## 3. 失败模式

- **有人把兼容入口加回生产树或又取旧路径**：RFC-584 用例 ① 红，不可达生产文件计数也红。
- **生产源码取了用例辅助文件**：用例 ② 红。
- **维护用例退回去测副本**：用例 ③ 红。

## 4. 测试策略

改取新位置的用例与 `rfc234` 的维护用例都在选用例里跑；读已提交源码的门（`rfc376`、`rfc521`、架构报告）在候选导出里跑；变异覆盖 §3 三条。

## 5. 取舍（可推翻）

1. **迁入 `tests/helpers` 而不是删除兼容入口**：这几个入口把 application 与本机效果拼在一起，用例经它们测的是生产的 application 逻辑；删掉就要在
   每个用例里重复同样的拼装。一跳转出没有这个价值，直接删。
2. **Intent 副本删除、用例改测生产命令，而不是迁入 `tests/helpers`**：副本是旧实现，留着等于让用例测一份生产不跑的代码；生产命令的业务结果与
   原断言一致（同一个 mtime 判据、同样跳过运行中的轮次）。
3. **`standbyExecutionAuthority.ts` 不动**：执行权一族按既有约定暂缓。

## 6. 对 RFC-294 刷新后规则的对账

- **C10**：只供用例的代码不留在生产层；application 不再直接做文件系统效果。**C11**：public 面不变。**C12**：RFC-584 用例 ① 覆盖 `src` / `tests` /
  `scripts` 的全部说明符，② 覆盖全部生产源码，③ 只读 `rfc234`。**C13**：`unreachable-production-files` 15 → 8、`application-direct-effect-files`
  1 → 0，其余计数不升。
- **留下的债**：不可达生产文件余 8 个（§非目标）。
