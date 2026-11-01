# RFC-410 实施计划

**前置**：RFC-409 落库。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-410-T1 | 端口 `TE/application/ports/dynamicWorkflowGenerate.ts`；resource-catalog composition 的 `composeDynamicWorkflowLayerOneValidation`；参与者与运行选项字段改为 `validation`，bootstrap 与测试拓扑接线 | design §1.2、§1.3 |
| RFC-410-T2 | 第二层校验迁入 shared；`OA` 其余部分迁入 `domain/dynamicWorkflowOrchestrator.ts`；`DWR` 的常量与纯函数迁入 `domain/dynamicWorkflowGeneration.ts`（第一层校验以函数注入）；改指全部调用方；删除 `OA` | design §1.1、§1.5 |
| RFC-410-T3 | 生成 pass 迁入 `engine/task/dynamicWorkflowGenerate.ts`，只做端口替换；`dw-generate` 绑定；任务控制面去掉编排节点常量端口；删除 `DWR` | design §1.1、§1.4、§2 |
| RFC-410-T4 | 守卫与用例：新结构锁 `rfc410-dynamic-workflow-engine`（含负例）、端口绑定用例；design §3 所列守卫改指与清单补齐；Windows 两份 `paths:` 与 suite；账本按 T5 实测填值 | design §3、§4 |
| RFC-410-T5 | 集中验证：静态检查、针对性验证集（含全部架构测试与动态工作流 / 工作组任务房 / 任务控制面行为用例）、复跑、P0 变异 lane；按实测更新账本；实现门（本会话自审，只审功能）；推送后跟 CI | design §2 |

## 实施记录

T1～T5 完成（本会话实施）。与落档设计的偏差与实施中的取舍：

1. **编排节点常量端口去掉后 runTask 直接 import domain**：`TaskRunPorts.rules` 只剩 `triggerPreflightIssue`，RFC-408 的端口绑定用例
   改为断言 `rules` 的键集合。
2. **测试夹具的库存载入抽成函数**：`T/helpers/eachProviderTaskExecution.ts` 新增 `loadTestDynamicWorkflowInventory`，
   `createTestDynamicWorkflowOperations` 的 `validation` 由它与校验器构成；RFC-359 W8 一致性用例改对库存载入断言，并补校验器按当次
   库存判定的两条断言（夹具代理可解析、缺失代理报 `agent-not-found`）。
3. **端口绑定用例走双引擎 harness**：校验端口用例原用 `createInMemoryDb()`，被 RFC-359 W5-T19f「测试不得写死引擎」锁拦下
   （集中验证第一轮），改为 `describeEachProvider`，两个 provider 各跑一次。
4. **注释里的旧路径**：e2e `rfc319-workgroup-dynamic-and-calls.spec.ts` 的判据引用、shared `schemas/task.ts` 与 `nodePorts.ts` 的注释
   改指新 owner（只改注释）。
5. **账本**：commons-debt 删去 `services/dynamicWorkflowRunner.ts` 的 4 条 R1 边（220 → 216，note 记一行）；RFC-345 门面账本删去
   该消费方的一条边；`architectureReport.ts` 删去两个已删文件的 legacy 归属；Windows 两份 `paths:` 把已删文件换成新文件并加入两个新用例，
   suite 同步；guard-manifest 新增 `rfc410-dynamic-workflow-engine`，同步三个改动过的守卫的行数。

守卫与用例（T4）：读旧文件的锁改指新 owner（RFC-200 source lock 读 engine、retry-budget 读 domain 生成判定、RFC-243 call 节点前置锁
读 domain 且锚点改为 `validateLayerOne(def)`、RFC-167 编排点锚点改为 `runDynamicWorkflowGenerate(dynamicWorkflowPorts(), {`、RFC-292
读 domain 编排代理、RFC-349 execution peripheral 把引擎文件加入「保留断言、只换落点」的模块清单、RFC-395 任务定义读取侧站点改指 engine）；
动态工作流引擎、token、e2e、编排代理与夹具用例改 import；新结构锁 `rfc410-dynamic-workflow-engine`（owner 唯一、shared 校验器无 backend
副本、两个已删文件不复活不被引用、绑定不得重获生成 pass、任务控制面不得再有编排节点常量端口、生成路径不得出现 resource-catalog 库存类型、
engine 与 domain 的 import 层级，均带纯伪造输入的负例）；端口绑定用例 `rfc410-port-bindings`（检查点读取与缺失时的失败、停泊重入经
任务 node-run persistence 补铸确认门且不重新生成、规则与宿主线绑定、校验端口与校验器结果一致）。

## 集中验证（T5）

- **静态**：后端 typecheck（含 tests，6 GiB heap）rc=0（验证中改过端口绑定用例后复跑仍为 0）；shared typecheck rc=0；改动的 TS 文件 eslint
  `--max-warnings 0` 0 error / 0 warning；prettier 通过（含 e2e 注释与 Windows workflow）。
- **实现门**（本会话自审，只审功能）：生成 pass 与原 `runDynamicWorkflowGenerate` 逐段 diff，只有 6 处端口替换（签名拆为 `ports` / `args`、
  解构、校验函数载入、宿主运行、两层评估的第三个参数、触发器预检）；生成判定、编排代理、第二层校验与原文逐字一致，差异只在注释、被删的
  无人使用再导出和第一层校验的注入形状；绑定一侧保留 `dynamic-workflow-operations-not-composed` 检查且先于宿主钩子构造。PASS。
- **针对性验证集**（5 worker，20 分钟，负载约 12～27）：全部架构测试与守卫命名的测试、读动态工作流 / 编排代理 / 任务控制面 / 启动与参与者
  装配源码或行为的用例、使用测试拓扑与 each-provider 夹具的用例，共 511 个；6 个失败。1 个是本 RFC 引入的真实失败——RFC-359 W5-T19f
  「测试不得写死引擎」拦下端口绑定用例里的 `createInMemoryDb()`（见实施记录第 3 条），已修；其余 5 个均为 PG 超时。shared 的两个 RFC-167 用例
  另跑通过（28 个）。
- **第二轮**（3 worker）：这 6 个加本 RFC 的两个新用例共 8 个，4 个通过（含修后的 W5-T19f 与两个新用例）；`rfc359-w26`、
  `scheduler-boundary-presnapshot-rollback-skip`、`scheduler-clarify-dispatch`、`scheduler-wrapper-fanout-e2e` 仍只以 PG 超时失败。
- **第三轮**（负载降到 16 以下，单进程，候选与 RFC-410 基线 `a06fcae26` 的导出各跑一次）：4 个两侧全部通过，耗时一致——`rfc359-w26`
  20 s / 20 s、`presnapshot-rollback-skip` 8 s / 9 s、`scheduler-clarify-dispatch` 49 s / 49 s、`scheduler-wrapper-fanout-e2e` 26 s / 25 s；判为
  负载超时，与本 RFC 无关（三个 scheduler 用例走 DAG 引擎，本 RFC 未改该路径）。无需第四轮。
- **P0 变异 lane**（SQLite + PostgreSQL）：passed，34 个阶段、0 失败，127 个源文件指纹前后一致。

## 冲突面

- `TE/composition/{taskEngineApplication,taskEngineRuntimeOptions}.ts`、`TE/infrastructure/{taskExecutionRuntimeParticipants,taskRouteLaunchOperations,childExecutionLaunchOperations}.ts`、
  `TE/engine/task/runTask.ts`、`TE/application/ports/taskRun.ts`、`S/bootstrap/daemonModules/taskExecution.ts`、resource-catalog
  `composition/{workflowOperations,workgroupTaskRoom}.ts`、`packages/shared/src/dynamicWorkflow.ts`；
- 守卫与账本：见 design §3。

实施前与提交前按路径核对工作树，尤其是并发会话可能触及的共享守卫文件。

## CI（AC-6）

- **`6bf98a67c`**：windows-platform `41325244492` success。主 CI `41325244491`：68 success；Markdown link check (design/) 失败——
  `design/RFC-370-crewstation-hosted-deployment/host-authority-task-dynamic-state.md` 第 7 行链到本 RFC 删除的 `services/dynamicWorkflowRunner.ts`
  （属本 RFC 引入：改名半径没有扫 `design/` 的相对链接），已由 `15cca7442` 改指迁移后的生成引擎，link check 在其主 CI `41340001369` 上通过；
  `CI required` 随之失败。
- **后继证据**：`0ae7901c8`（本 RFC 提交是它的祖先；其后对本 RFC 代码文件的改动只来自本会话的后继提交，内容保留）的主 CI `41342269352` 70 个 job 全部 success；windows-platform 在包含本 RFC 的 `76a8db35d` 上 `41334034610` success。AC-6 关闭。

## 验收清单

- [x] proposal AC-1～AC-5（本地集中验证，见上）
- [x] 推送后 CI 全绿（AC-6，以后继证据关闭，见「CI（AC-6）」）
