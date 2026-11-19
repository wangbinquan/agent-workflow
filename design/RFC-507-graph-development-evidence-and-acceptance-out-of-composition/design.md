# RFC-507 设计：开发自动化的图开发执行端口、证据与验收迁出 composition

## 1. 现状（HEAD `0e8d143b9`，源码实读）

development-automation 组合层控制流（F13 口径，按语法树计数）133 行；`graphDevelopment.ts` 占 14 行：第 114 行 `for`、115 行 `if`、
120 行 `throw`（材料核对），250 行 `try`、258 行 `if`（当前证据目标），324、333 行 `for` 与 325、335 行 `if`（证据投影），404、412、
429 行 `if` 与 411、422 行 `throw`（人工验收）。该文件不在 `composition-forbidden-import-files` 里。

**`composition/graphDevelopment.ts`，485 行**：

- 第 1～53 行 import，第 55～59 行从 application 转出五个名字；第 61～484 行 `composeGraphDevelopment(input)`，第 485 行
  `GraphDevelopment` 类型。
- 第 94～96 行建 store、产物与验证档案持久化（`createVerificationProfilePersistence(input.db)`）。
- 第 97～139 行 `execution: GraphDesignExecutionPort`：
  - `committedArtifacts`：`input.executions.read(request)` 的产物映射为 `{ taskId, nodeRunId, outputPort, digest, content }`，读不到给空数组；
  - `humanSources` / `reviewReceipt`：转给第 142 行才建的执行消费；
  - `assertMaterialsReadable`（第 112～121 行）：取产物文件，`basis.files` 里任一项找不到同路径且 `graphDigest` 相同的文件就抛
    `graph-material-unreadable:<path>`；
  - `resolveRepositoryBaseline`（第 122～135 行）：用 zod 解析 `input.readCase(caseId)` 的投影，取 `GRAPH_CONTEXT_TYPE` 上下文的
    `request.targetBranch`（没有就 null），交给第 149 行才建的员工工作区的 `resolveBaseline`，取 `.baseline.contentBaseline!`；
  - `resolveImplementationBaseline`（第 136～138 行）：第 200 行才建的交付桥的续作工作区的 `baseline`，没有就 null。
- 第 140～222 行装配：命令、执行消费、员工工作区（其中第 157～171 行的 `verificationProfiles` 列出已发布、未归档的档案并带上解析后的内容，
  第 172 行转发续作工作区）、查询、规划、验证、交付桥（第 200～212 行，字段由 RFC-498 用例钉住）、平台工作项。
- 第 223～237 行 `latestVerification(id)`：store 记录里最近一次 `kind === 'verification'`、`status === 'completed'` 的载荷，没有就 null。
- 第 238～260 行 `currentEvidenceTarget(id)`：续作工作区或员工工作区的当前状态；按它暂存候选；`try` 里返回候选树、续作的远端头与环境摘要，
  `finally` 里候选暂存成功就清理。
- 第 261～294 行 `detailProjection`：员工案例详情投影（不在本步）。
- 第 295～482 行交出的 `graph` 对象：`mountRoutes`、`commands` 到 `recover` 九个装配成员，以及
  - `basis`（第 311～315 行）：依据与过期读集；
  - `evidence`（第 316～364 行）：最近验证、最后一条交付链接的提交、档案摘要表（已发布档案按 `id` 与 `id@修订` 两种键；证据链接钉住的
    `profileRef` 按原修订）、当前证据目标（失败时为 null），交给 `queries.evidence`，再在候选树相同且读集未过期时给出可验收的候选；
  - `verificationProfiles`（第 365～379 行）：已发布、未归档的档案摘要；
  - `reviewLimitations`（第 380～388 行）：`createGraphLimitationReview`，交入 `latestVerification` 与 `currentEvidenceTarget`；
  - `accept`（第 389～465 行）：最近验证与依据摘要、候选树、当前证据目标或读集任一不符就抛 `graph-acceptance-candidate-mismatch`；义务为空、
    不在依据里或不是人工义务就抛 `graph-acceptance-obligation-invalid`；`beginRecord` 已完成就返回原载荷；否则写 `acceptance.json`、按
    `GraphEvidenceBindingSchema` 建证据、写链接、`finishRecord`，通知 `changed`；
  - `requestVerification`（第 466～478 行）：写请求产物，经 `input.cases.requestWork` 发起验证工作；
  - `exportBasis`（第 479～481 行）：依据的文件。
- 使用方：bootstrap `daemonModules/digitalEmployee.ts` 调 `composeGraphDevelopment`；`infrastructure/http/graphDesignRoutes.ts` 取
  `GraphDevelopment` 类型；用例 `rfc396-current-evidence`、`rfc396-current-evidence-git` 经装配入口走证据与验收，RFC-498 用例读本文件的
  交付桥字段。

## 2. 机制与落位

### D1 用例落 application

执行端口、证据与验收只经本模块的端口（store、产物、命令、查询、验证档案持久化、案例端口）、source-control 的 public 候选参与者与验证
命令 effects 工作，是 graph-development 的用例，落 `application/graph-development/`；不需要新的 infrastructure。档案持久化在 application
里以既有端口类型 `VerificationProfilePersistence`（`application/ports/configResourceStore`）出现，实例仍由组合层建。

### D2 新位置

- **`application/graph-development/designExecution.ts`**（新）：`createGraphDesignExecution(deps): GraphDesignExecutionPort`。
  - `deps`：`executions: GraphExecutionFacts`；`readCase(caseId)`；`artifacts: GraphDesignArtifacts`；转发函数 `humanSources(caseId, sources)`、
    `reviewReceipt(request)`、`resolveBaseline(repositoryId, targetBranch)`（返回带 `baseline.contentBaseline` 的结构类型）与
    `continuationWorkspace(designId)`（返回带 `baseline` 的结构类型或 null）。
  - 六个方法是原第 98～138 行逐字，只把 `input.executions` / `input.readCase` / `artifacts` 换成 `deps` 上的同名依赖，把对执行消费、员工工作区
    与交付桥的调用换成对应的转发函数。
- **`application/graph-development/evidenceAcceptance.ts`**（新）：
  - `listGraphVerificationProfileContents(profiles)`：原第 158～171 行逐字（带内容的列表，交给员工工作区）。
  - `createGraphEvidenceAcceptance(deps)`：交出 `latestVerification`、`currentEvidenceTarget`、`basis`、`evidence`、`verificationProfiles`、
    `accept`、`requestVerification`、`exportBasis`，函数体是原第 223～260、311～379、389～481 行逐字，`input.*` 换成 `deps.*`；
  - `deps`：`store`、`artifacts`、`commands`、`queries`、`profiles`、`cases`、`candidates`、`verification`（`VerificationCommandEffectsFactory`）、
    `continuationWorkspace(designId)`、`workspaceState(designId)`、`changed?`。续作与当前状态用 application 既有的 `GraphVerificationWorkspace`
    表达（续作另带 `remoteHeadSha`）。

### D3 composition 只装配

- `composeGraphDevelopment(input)` 的签名与返回对象的字段名不变：
  - `execution = createGraphDesignExecution({ executions: input.executions, readCase: input.readCase, artifacts, humanSources: (caseId, sources) => consumption.humanSources(caseId, sources), reviewReceipt: (request) => consumption.reviewReceipt(request), resolveBaseline: (repositoryId, targetBranch) => workspace.resolveBaseline(repositoryId, targetBranch), continuationWorkspace: (designId) => care.continuationWorkspace(designId) })`，
    仍在命令之前建、仍交给命令、执行消费与交付桥；转发函数在调用时才取后建的对象，与原来闭包里的取法相同；
  - 员工工作区的 `verificationProfiles: () => listGraphVerificationProfileContents(profiles)`；
  - 交付桥与平台工作项之后建 `acceptance = createGraphEvidenceAcceptance({ … })`，`graph` 的 `basis`、`evidence`、`verificationProfiles`、
    `accept`、`requestVerification`、`exportBasis` 取它的同名成员，`reviewLimitations` 交入它的 `latestVerification` 与 `currentEvidenceTarget`。
- 不再用到的 import 删去：`zod`、`GraphEvidenceBindingSchema`、`repositoryMaterializationCommit`、`GraphImplementationBasis`、
  `GraphDesignExecutionPort`、`graphDigest` 与 `staleGraphReads`。`detailProjection` 仍用的 `canonicalJson`、`GraphEmployeeContextSchema` 与
  `GRAPH_CONTEXT_TYPE` 保留。

### D4 锁与账本

- `architecture/counts.json`：`composition-control-flow-development-automation` 133 → 实测（预计 119）。`guard-manifest.json` 登记
  RFC-507 用例。
- RFC-498 用例钉的交付桥字段（`execution` 等 10 个加默认时钟）不变，不改该用例。
- 不改：使用方与其余的锁（装配入口与它交出的对象不变）；`design/` 里的历史记述。

## 3. 清单（退出门）

| 新位置（`packages/backend/src/modules/development-automation/` 下） | 声明并交出                                                                                                     | 只声明不交出 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------ |
| `application/graph-development/designExecution.ts`（新）            | `GraphDesignExecutionDependencies`、`createGraphDesignExecution`                                               | —            |
| `application/graph-development/evidenceAcceptance.ts`（新）         | `GraphEvidenceAcceptanceDependencies`、`createGraphEvidenceAcceptance`、`listGraphVerificationProfileContents` | —            |

允许的形状：`graphDevelopment.ts` 没有 if / for / while / do / switch / try / throw 语句，从新位置取实现；`composeGraphDevelopment` 与
`GraphDevelopment` 仍在原文件声明并导出，五个转出名字不变。

## 4. 用例

新增 `packages/backend/tests/rfc507-graph-development-evidence-acceptance-out-of-composition-boundary.test.ts`（文件名带 `boundary`），
登记 guard-manifest：

- ① 清单里交出的名字在全部生产文件（下限 3,000）、用例（下限 2,500）与 e2e 里只在各自的新位置声明；两个新文件恰好声明、交出清单列的名字；
  `graphDevelopment.ts` 只声明并导出原有的装配入口与类型，转出的五个名字不变。
- ② `graphDevelopment.ts` 没有控制流语句，也不再出现迁走的代码要的 `GraphEvidenceBindingSchema`、`staleGraphReads`、
  `repositoryMaterializationCommit`、`graphDigest` 与 zod；`createGraphDesignExecution`、`createGraphEvidenceAcceptance` 与
  `listGraphVerificationProfileContents` 在生产代码里都只在该文件调用一次，实参逐字钉住（晚建的对象以转发函数交入）；交出的 `graph` 对象
  成员与次序不变，迁走的六个成员取自证据验收用例；带负对照。
- ③ 新代码的依赖面是闭集：两个新文件只取 shared、zod、本模块的 domain、application 与 `application/ports`、source-control 的 public 类型，
  不用进程全局；带负对照。
- ④ 行为（直接调用新位置，端口用内存替身）：
  - 执行端口：材料全部可读时不抛，缺文件或摘要不符时抛 `graph-material-unreadable:<path>`；目标分支取自图上下文、没有上下文时为 null；
    续作基线没有时为 null；
  - 证据：档案摘要表含已发布档案的两种键与证据钉住的修订，归档与未发布的档案不进表；当前证据目标读失败时证据仍给出投影；
  - 验收：候选不符与义务无效各抛原错误；同一请求已完成时返回原载荷、不写产物与链接；成功时写产物、链接，结束记录并通知 `changed`；
  - 当前证据目标：候选暂存成功时清理一次，读环境摘要抛错时也清理；暂存失败不清理。

行为另由现有用例对拍：`rfc396-current-evidence`、`rfc396-current-evidence-git` 经装配入口走证据与验收；图设计路由与员工工作区的用例走执行
端口与档案列表。

## 5. 失败模式

- **用例走样**：函数体逐字迁移，只换依赖的取法；`evidence` 里对当前证据目标的 `.catch(() => null)`、`accept` 的判断次序与错误串、
  `currentEvidenceTarget` 的 `try` / `finally` 都原样保留。
- **晚绑定**：执行端口在执行消费、员工工作区与交付桥之前建，原来靠闭包在调用时取它们；改为转发函数后取法与时机不变（转发函数在调用时才读
  这几个常量）。
- **对象字段走样**：路由按 `GraphDevelopment` 的字段调用；`graph` 的字段名与签名逐个保留，由 `tsc` 与路由用例覆盖。
- **遗留引用**：装配入口不变，使用方不改；迁移后按名字、路径片段与代码里的字符串字面量全仓再扫，另按全部文件类型扫一遍。
- **按原始文本扫的锁误计**：新文件的注释不写组合文件的路径（RFC-506 的教训）。
- **账本漏标**：guard-manifest 的 `assertsAbsence` 要与用例实际是否断言“不存在”一致，`rfc317-guard-negative-fixture` 按
  `tests/architecture/census.ts` 的判据逐条比对。本 RFC 用例断言清单里的名字不在别处声明、组合文件没有控制流，属于断言“不存在”，
  条目须标 `assertsAbsence: true`（RFC-505、506 的条目都标了）。集中验证第一轮因漏标红过，已补（见 plan）。

## 6. 取舍（可推翻）

1. **一个文件一步**：`graphDevelopment.ts` 的 14 行占非 RFC-370 余项的四分之一，且含三处循环与一处 `try`；同文件的 `detailProjection` 依赖
   另两个组合文件，与它们一并留给后继，避免一次改动跨四个组合文件。
2. **执行端口与证据验收分两个文件**：前者是交给命令与执行消费的端口实现，后者是交给路由的查询与命令；两者依赖面不同。
3. **晚绑定用转发函数**：不引入可变的延迟绑定对象；转发函数与现有的 `continuationWorkspace` 转发同形。
4. **档案列表的带内容版本单列为函数**：员工工作区在交付桥之前建，带内容的列表只依赖档案持久化，单列后不必为它提前建证据验收用例。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是两组用例，都落 application；`graphDevelopment.ts` 只装配、没有控制流；不新增用例入口。
- **C11**：public 不变；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-507 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明，另读 `graphDevelopment.ts` 与两个新位置；只对这些范围宣告退出门。
- **C13**：`composition-control-flow-development-automation` 收紧到实测；其余触及的计数不升。

## 8. 本步承担的演进与留下的债

- **承担**：S10 在 development-automation 的第六步：图开发的执行端口、证据与验收离开 `composition/`；组合层余下的循环只剩
  `pipelineEvidence.ts` 一处。
- **留下**：`detailProjection` 与 `employeeCaseDetailProjection.ts`、`digitalEmployeeWorkspace.ts`；`pipelineEvidence.ts`、`developmentDelivery.ts`、
  `evidenceStaging.ts`、`graphDeliveryJob.ts`、`activityOperations.ts`、`graphDeliveryLifecycle.ts`、`executionTerminalObserver.ts` 与
  `repositoryFactsScanner.ts` 的余项由后继承接；`crewstation*` / `taskImage*` 待 RFC-370 余项；task-execution、source-control 与 resource-catalog 的
  余项与 S10 收口另立。
