# RFC-411 实施计划

**前置**：RFC-410 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-411-T1 | 端口与纯函数：`application/ports/workgroupTurns.ts`、`domain/workgroup/{turnTransitions,protocol,systemMessages,turnContext}.ts`；`resolveMessageTurnTriggerId` 并入任务房投影；`AgentExecutionQueries.readMany` | design §1 |
| RFC-411-T2 | 驱动与提示词迁入 `engine/task/workgroup/`（原样迁移，只改 import） | design §1、§3 |
| RFC-411-T3 | 适配器与提交队列迁入 `infrastructure/`，宿主账本在本模块内构造、代理经 public 读取；`composition/workgroupTurns.ts`；bootstrap 与测试拓扑改接；任务房投影改从 shared 取节点常量；删除 RC 下的轮次文件 | design §1、§2 |
| RFC-411-T4 | 守卫与用例：新结构锁（含负例）、端口绑定用例；design §4 所列守卫改指与销账；Windows 两份 `paths:` 与 suite；全仓（`packages/`、`e2e/`、`scripts/`）grep 旧路径 | design §4、§5 |
| RFC-411-T5 | 集中验证：静态检查、针对性验证集（全部架构测试与 workgroup / 任务房 / 澄清 / 恢复行为用例）、复跑、P0 变异 lane；实现门（本会话自审，只审功能）；推送后跟 CI | design §3 |

## 实施记录

T1～T5 完成（本会话实施）。与落档设计的偏差与实施中的取舍：

1. **`resolveMessageTurnTriggerId` 留在 resource-catalog**：实施时发现它只被任务房投影调用（轮次驱动与上下文都不用），于是随唯一调用方
   并入 `RC/application/workgroups/workgroupRoomProjection.ts`，不进 shared；节点常量改从 shared 直接取。
2. **ULID 经 application 文件进入 engine**：RFC-408 的锁只许 `engine/task/**` import 本模块各层、shared 与 node 内建，驱动里 13 处
   `ulid()` / `monotonicFactory` 改从 `application/workgroup/turnIds.ts`（只做再导出）取，调用点不变；`nodeRunAttemptIndex` 改取
   `domain/nodeRunAttempt`；SPI 类型改取 `application/ports/workgroupTurnsOperations`（补上宿主账本的 7 个类型）。
3. **组合入口两个**：bootstrap 用 `composeWorkgroupTurnsOperations(db, hostLedgerFactory, clarifyAskGate)`，套件沿用的对象参数入口
   `createWorkgroupTurnsPersistenceOperations` 一并落在 `composition/workgroupTurns.ts`（适配器不再 import engine）。
4. **轮次上下文的协议再导出删除**：`turnContext` 原为 legacy 调用方再导出协议块渲染器，调用方（用例）改从 `domain/workgroup/protocol` 取。
5. **适配器里的函数改名**：`applyResourceCatalogOperation` → `applyWorkgroupTurnOperation`（不再属于 resource-catalog）。
6. **`readMany` 的解码**：沿用轮次快照一直使用的批量（normalized）解码；单条 `read` 用 stored-json，二者对规范行结果相同。

守卫与用例（T4）：31 个用例 / helper / fixture 的 import 按符号改指（类型 → ports，转移表 → domain，节点常量 → shared，其余 → engine /
domain / infrastructure / composition）；26 个按路径或路径段读源码的锁改读新 owner（含 P0 变异夹具的 mock 目标与 `scripts/rfc359-p0-mutations.ts`
的源文件清单），`rfc359-t7e` 的 import 文本锚点、`workgroup-message-turn-ascii-directive` 的目录 helper 手改；RFC-217 G5 棘轮把迁走的两个
文件按新路径继续记账（17 / 3 不变）；`rfc294Gates.ts` 与 `rfc294-review-offered-edge-dag` 的 exact required SPI binding 删去
`workgroup-turns-provider` / `workgroup-host-ledger-provider` 两类条目（review 的正负 fixture 改用仍在的任务房 binding），RFC-376 的
offered-edge fixture 同样改用任务房 binding；RFC-395 模块表归属债删去 RC 适配器访问 TE 表的 4 条；新结构锁
`rfc411-workgroup-turns-engine`（owner 唯一、8 个已删文件不复活不被引用、engine / domain 的 import 层级、适配器只经 RC public、RC 不再
import 轮次 SPI，均带纯伪造输入的负例）与端口绑定用例 `rfc411-port-bindings`（组合与适配器源码锚点；`readMany` 两 provider 对拍）；
Windows 两份 `paths:` 与 suite、guard-manifest 新增一条并同步三个守卫的行数。

## 集中验证（T5）

- **静态**：后端 typecheck（含 tests，6 GiB heap）rc=0；改动的 TS 文件 eslint `--max-warnings 0` 0 error / 0 warning；prettier 通过（含 Windows
  workflow）。
- **实现门**（本会话自审，只审功能）：轮次驱动按行号切分后逐段 diff——engine 主体、端口类型、转移表与原文逐字一致（只差一个空行）；
  提示词 / 协议 / 系统消息 / 轮次上下文只差文件头与 import 路径（轮次上下文另删去协议再导出与迁走的 `resolveMessageTurnTriggerId`）；
  适配器只差 import、事务类型别名、一处函数改名与成员代理改经 `readMany`。PASS。
- **针对性验证集**（6 worker，21 分钟，负载约 6～20）：全部架构测试与守卫命名的测试、提到 workgroup / 轮次 / 任务房 / 代理执行查询 / 测试拓扑
  与 each-provider 夹具的用例，共 674 个；9 个失败。2 个是本 RFC 引入的锚点失败——`rfc209-round-ledger` 读 `WorkgroupTurnMessageDraft` 的
  文件随类型迁到 ports、`rfc345-workgroup-turns-provider-neutral` 的 import 来源 / 账本字面量 / 代理读取方式三处锚点——已改；其余 7 个均为
  PG 超时。
- **第二轮**（3 worker）：这 9 个里 7 个通过（含修后的两个）；`rfc359-w26`、`rfc374-node-run-sequence` 仍只以 PG 超时失败。
- **第三轮**（负载降到 16 以下，单进程，候选与 RFC-411 基线 `95090f7a6` 的导出各跑一次）：两个都在两侧通过，耗时一致——`rfc359-w26`
  21 s / 21 s、`rfc374-node-run-sequence` 9 s / 8 s；判为负载超时，与本 RFC 无关。无需第四轮。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致（P0 夹具改指的协议块 mock 目标生效）。

## 冲突面

- `RC/application/workgroups/*`、`RC/infrastructure/{workgroupTurnsOperations,workgroupCommitQueue}.ts`、`RC/composition/workgroupTurns.ts`、
  `RC/application/ports/executionResourceQueries.ts`、`RC/infrastructure/executionResourceQueries.ts`、`TE/engine/task/workgroup/*`、
  `TE/domain/workgroup/*`、`TE/application/ports/workgroupTurns.ts`、`TE/infrastructure/workgroupTurnsPersistence.ts`、
  `TE/composition/workgroupTurns.ts`、`S/bootstrap/daemonModules/taskExecution.ts`、`T/helpers/taskExecutionTestTopology.ts`、shared 工作组模块；
- 守卫与账本：见 design §4。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## CI（AC-6）

- **`1a33014e2`**：windows-platform `41329959336` success。主 CI `41329959342`：68 success；唯一的失败是继承自 RFC-410 的 Markdown link check
  （同一处 `dynamicWorkflowRunner.ts` 链接，`15cca7442` 已修）与随之失败的 `CI required`；全部 backend / shared / frontend 分片通过，无本 RFC 引入的失败。
- **后继证据**：`0ae7901c8`（本 RFC 提交是它的祖先；其后对本 RFC 代码文件的改动只来自本会话的后继提交，内容保留）的主 CI `41342269352` 70 个 job 全部 success；windows-platform 在包含本 RFC 的 `76a8db35d` 上 `41334034610` success。AC-6 关闭。

## 验收清单

- [x] proposal AC-1～AC-5（本地集中验证，见上）
- [x] 推送后 CI 全绿（AC-6，以后继证据关闭，见「CI（AC-6）」）
