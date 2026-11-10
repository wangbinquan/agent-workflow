# RFC-480 技术设计

落在 task-execution 与 collaboration 两个 bounded context 的 `public/` 面及其内部各层；另改 bootstrap 一处 import、integration 两处 type
import、架构守卫（未消费符号按 context 分项）与 `architecture/counts.json`。数字取 HEAD `673b1b53b`（架构报告：task-execution 181、
collaboration 24 个未消费 public 符号）。不改行为。

## 1. 撤出规则

对两个模块里架构报告判为「未消费」的每个 public 符号（`unconsumedPublicSymbols`：没有模块外生产 import、没有模块外生产消费方、没有被
其他 public 符号的签名引用）：

| 情形                                           | 个数 | 做法                                                                            |
| ---------------------------------------------- | ---- | ------------------------------------------------------------------------------- |
| 转出（`export { x } from '../…'`）             | 136  | 删掉转出；经 public 取用它的本模块文件与用例改取定义处                          |
| 直接声明在 public 文件里、没有任何使用方       | 31   | 删除声明（同一 public 文件里还被别的导出用到的，按下一行处理）                  |
| 直接声明在 public 文件里、只有本模块或用例在用 | 38   | 按函数体 / 类型的内容（C10）挪进模块内部对应的层，使用方改取新位置；落位表见 §2 |

撤出会让「只被同一文件其他导出的签名引用」的符号变成未消费（例如 `public/operations` 里的 `TaskStatusUpdateExtra` 只被 `trySetTaskStatus`
的签名引用）。实施按「撤出 → 复采 → 再撤」迭代到两个模块的未消费计数为 0（RFC-478 集中验证第 2 处是同一现象）。

只被用例经 public 取用的符号，按定义处的性质改：生产代码（只是没有模块外生产消费方）留在模块内部、用例改取定义处；只为用例存在的辅助
挪到 `tests/helpers/`。命名空间形式取 public 的用例（`import * as … from '…/public/…'`，用来断言某个名字已撤出）照旧可用；
`public/operations.ts` 删除后，取它的命名空间断言改为断言文件不在。

## 2. 直接声明在 public 的落位（按内容）

- **collaboration**（17 个有本模块使用方）：`public/commands.ts` 的 `createManualQuestionOpen`、`dispatchTaskQuestions`、
  `finalizeCommittedHumanGate`、`prepareClarifyGateOpen`、`prepareReviewGateOpen`、`replaceReviewNodeReviewers`、
  `setCollaborationClarifyDirective`、`submitClarifyDecision`、`submitReviewDecision` 与 `public/queries.ts` 的
  `collaborationQuestionTaskId`、`filterReviewSummariesForActor`、`getReviewNodeReviewerConfig`、`listCollaborationClarifyDirectives`、
  `resolveCollaborationClarifyTaskAccess`、`resolveCollaborationNodeRunTaskAccess`、`resolveReviewAccess`、`visibleCollaborationTaskIds`。
  它们是 collaboration 的用例与读取，按函数体取的依赖定层：只取 domain / 端口的进 `application/`；取 infrastructure（`review.ts`、
  `clarify/service.ts`、`taskQuestions.ts` 等）的原样进 `infrastructure/`，同一主题合并进既有文件或新建一个按主题命名的文件。实施时逐个
  列进本节的落位表。另 2 个（`readCollaborationHumanInputs`、`readCollaborationReviewDecision`）没有任何使用方，删除。
- **task-execution**（21 个有使用方：15 个本模块生产文件在用、6 个只被用例取用）：工作组主机账本的类型（`WorkgroupHostLedger*`、`WorkgroupTurnsOperations`）是
  `application/ports/workgroupTurnsOperations.ts` 用的端口类型，进 `application/ports/`；`TaskCancellationCommand`、`TaskExecutionError`、
  `WorkerIdentity`、`SchedulerRuntimeTopology`、`WrapperExecutionScopeReadModel`、`TaskSessionEventSource`、`EmployeeExecutionArtifactQueries`、
  `WorkgroupTaskRoomHostRunSnapshot`、`taskLifecycleObservation`、`wrapperInnerDescendantIds` 按各自内容进 domain / application / application
  `ports/`（实施时逐个列表）。其余直接声明且没有使用方的（`requireSchedulerDriver`、`runTaskAgentWithFamily`、`currentTaskExecutionContext`
  等）删除。

## 3. task-execution `public/operations` 退役

- 25 个零消费导出与 3 个只被签名引用的类型随撤出规则撤掉。
- `assertNodeRunSourceTerminationAdmission`：collaboration `infrastructure/review.ts` 改取定义处 `@/platform/persistence/nodeRunLifecycleCore`
  （模块取 platform 是允许的方向；task-execution 的转出删掉）。
- `TerminalWorkspacePrunePolicy` / `TerminalWorkspacePruneDecision`：task-execution 要求外部实现的策略，声明进
  `composition/required-ports.ts`（与既有 required port 同处）；integration 的 `application/` 与 `composition/` 改取它（`import type`，
  required-implementation 方向）。
- `registerTerminalWorkspacePrunePolicy`：由 task-execution 的 `composition.ts` 交出，bootstrap 改取 composition（bootstrap 取模块 composition
  是装配方向）。进程级注册表原样保留（S12）。
- `public/operations.ts` 删除；census 的 exact public 入口清单里它仍是合法入口名（其他模块还在用），不改。

## 4. 未消费符号按 context 分项

`publicContractGateSets` 把 `unconsumed-public-symbols` 一项改成每个有 public 面的 context 一项 `unconsumed-public-symbols-<context>`
（含计数为 0 的 context），条目照旧是 public 条目 id；`architecture/counts.json` 删去总数一项、登记各项（上限 = 实测，RFC-479 的门要求
相等）。新增一个有 public 面的 context 会报 `missing count`。`public-surface-deviations` 仍是一项总数（S9 的类型污染清偿还没开始按模块推进）。

## 5. 用例与账本

- **新增 RFC-480 用例**：`modules/task-execution/public/operations.ts` 不在、src / 用例 / 脚本零 import；被撤的符号不在两个模块的 public
  导出里（逐名，带一个仍在的正对照）；§2 挪走的声明在新位置导出、不再在 public 声明；三处模块外使用取新位置。
- **用例改指**：经 public 取用被撤符号的用例改取定义处（codemod，按符号逐个解析定义处）；取 `public/operations` 命名空间的用例改为断言
  文件不在。
- **账本**：`counts.json` 的分项与收紧；public surface、未消费、偏差三个报告数随实测变化；guard-manifest 刷新改到的守卫行数。

## 6. 对 RFC-294 刷新后规则的对账

- **C10**：§2 的落位按内容；原样进 infrastructure 的在落位表写明理由（函数体取 infrastructure，端口化不在本 RFC）。
- **C11**：public 只撤不增（新增的只有 task-execution `composition/required-ports.ts` 里的一个 required port 与 composition 的一个转出，都不是
  `public/` 入口）。
- **C12**：RFC-480 用例的覆盖范围：文件不在与零 import 覆盖 backend 的 src / 用例 / 脚本；撤出断言覆盖两个模块的全部 public 文件；
  未消费符号的分项计数覆盖全部 context（全仓门）。
- **C13**：触及的减速带（未消费分项、`legacy-*` 若有变化）收紧到实测——RFC-479 起由门强制。

## 7. 失败模式

- **撤出连锁**：见 §1 的迭代。
- **命名空间断言失效**：`'x' in ns` 形式的断言在被撤符号上本来就该为 `false`，不受影响；只有取已删文件的命名空间 import 要改。
- **挪走的声明换层后越界**：挪进 `application/` 的取了 infrastructure 会被 `module-layer-violations` 与 RFC-294 的层规则报出——按依赖定层
  （§2）避免。

## 8. 测试策略

- 行为不变：两模块的既有用例（评审、反问、问题派发、工作组主机账本、取消、终态回收）改取新位置后照旧通过。
- RFC-480 用例见 §5；分项计数由减速带用例与 RFC-479 用例的口径断言守住；`rfc376-report` 的计数项数断言随分项改写（按结构）。
