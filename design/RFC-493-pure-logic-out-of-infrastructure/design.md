# RFC-493 技术设计

## 1. 现状（HEAD `e021a9e1e`，源码实读）

**resource-catalog `infrastructure/legacy/workflow.validator.ts`（3,540 行）**：

- 第 187～452 行是读库组装校验上下文的加载器：`loadWorkflowValidationContext`（异步，读代理、技能、插件、MCP、调用闭包）、它的别名
  `buildWorkflowValidationContext`、`validateWorkflowById`（读工作流再校验），以及只服务于加载的辅助（`FROZEN_ROOT_PLACEHOLDER`、
  `closureFromFrozen`、`loadCallWorkgroupNames`、`loadCallWorkflowClosure`）。这一段里夹着的 `pickCallWorkflowRow`、`resolverOverClosure`
  只有校验本体用（按选择器在调用闭包里取子工作流），归纯函数部分（§6 细化 4）。文件里取
  `drizzle-orm`、`tablesOf`、`PersistenceDb`、`listAgents`、`listSkills`、`getWorkflow`、`createPluginRepository`、
  `workflowCatalogPredicate`、`workflowReferenceFromPersistenceRow` 与 `NotFoundError` 的地方都在这一段（第 1870 行的 `listAgents` 是注释）。
- 其余是同步纯函数，没有 `await`，不取库、文件系统与进程：
  - 输入与上下文的类型：`ValidatorWorkflowRef`、`WorkflowValidationCandidate`（第 133～186 行）、`ValidatorPluginResource`、
    `ValidatorMcpResource`、`ValidatorContext`；
  - 候选覆盖层：`WorkflowValidationOverlayError`、`withValidationOverlays`（含 `PENDING_AGENT_TEMPLATE`、`mergedAgentRow`）；
  - 上下文投影与哈希：`WORKFLOW_VALIDATION_CONTEXT_DOMAIN_V1`、`projectWorkflowValidationContext`、`workflowValidationContextHashOf`、
    `workflowDefinitionCandidateHashOf`（`compareResourceIdentity`）；
  - 校验本体：`validateWorkflowDefinition`、`validateWorkflowDef`（第 845～3308 行）与它的辅助（`WorkflowValidationTargets`、
    `createWorkflowValidationTargets`、`readString`、`readNumber`、`readStringArray`、`buildLoopMembership`、`collectReachableUpstream`、
    `hasCycle`），`extractTemplateVars`、`validateAgentClarifyMultiplicity`。
  - 这一部分只取 shared、本模块的 domain（`callClosure`、`disabledResourcePolicy`）、本模块 `public/types` 的覆盖层类型与 `@/util/hash`。
- 使用方：生产 5 个（`composition/workflowOperations.ts`、`composition/workgroupTaskRoom.ts`、`infrastructure/workflowValidation.ts`、
  `infrastructure/agentLaunchResourceOperations.ts`、`infrastructure/workflowSnapshotLaunchGate.ts`），用例 46 个；取的名字里
  `validateWorkflowDef` 41 处、`loadWorkflowValidationContext` 7 处、`ValidatorContext` 7 处、`validateWorkflowDefinition` 6 处，其余 9 个名字
  各 1～3 处。

**collaboration `infrastructure/review.ts`（5,218 行）**里夹着三块纯规则：

- 锚点规范化（第 228～480 行，源码注释即写着 “Anchor — pure functions”）：`OccurrenceRecomputeResult`、`AnchorValidationError`（继承
  `@/util/errors` 的 `ValidationError`）、`recomputeOccurrenceIndex`、`canonicalizeAnchor`、`anchorResolutionError`、
  `assertResolvedAnchorConsistent` 与只在这一段用的 `contextMatchesAt`、`commonPrefixLength`、`commonSuffixLength`、`truncate`；另有
  `resolveCommentAnchor`（第 2704 行，按评论的锚点在文档上解析）。这一段还转出 shared 的 `findAllOccurrences`（“让既有 import 处不变”）。
- 决定策略表（第 3076～3141 行）：`ReviewRerunPolicy`、`ReviewDecisionPolicyBase`、`ReviewDecisionPolicyOf`、`ReviewDecisionPolicy`、
  `REVIEW_DECISION_POLICY`——每种决定是否递增轮次、关闭评审行的生命周期事件、决定理由的来源、重跑与回滚的配置键、取代标记、新铸行的
  起因与级联规则。
- 轮次：`resolveReviewRoundMode`（第 1817 行）与 `groupDocVersionRounds`（第 2469 行，按轮分组，`RoundGroupRow`、`DocVersionRound`）。
- 使用方：生产代码只在 `review.ts` 内部用；用例 5 个（`rfc326-anchor-canonicalize`、`review-anchor-disambiguation`、
  `review-prompt-rendering-edge`、`rfc142-review-rounds`、`rfc149-decision-policy`）。

## 2. 机制与落位

### D1 工作流静态校验 → resource-catalog `domain/workflowValidator.ts`

第 133～186 行的两个类型与第 453 行起的全部内容原样迁入新文件（函数体与注释逐字不变，只改 import：`../../domain/*` → `./*`，
`../../public/types` → `../public/types`）。`legacy/workflow.validator.ts` 只留加载器一段，从 `../../domain/workflowValidator` 取它用到的
类型与 `validateWorkflowDef`。文件名保留（它仍承载 `validateWorkflowById`），头注写明校验本体的新位置。

domain 取 `../public/types` 与 `@/util/hash` 都有先例（runtime-management、source-control、task-execution 的 domain 取本模块
`public/types`；collaboration、code-capability 的 domain 取 `@/util/hash`），不触 RFC-294 的模块分层门（domain 不取 fs / 进程、
hono / drizzle / sqlite、`src/{db,ws,routes,server}` 与任何 infrastructure）。

### D2 评审的锚点规范化 → collaboration `domain/reviewCommentAnchor.ts`

锚点一段与 `resolveCommentAnchor` 原样迁入。`findAllOccurrences` 不再转出：用例改从 `@agent-workflow/shared` 取（shared 才是它的定义处）。
`review.ts` 从 `../domain/reviewCommentAnchor` 取它用到的函数与错误类。（落位的文件名见 §6 细化 1。）

### D3 决定策略表 → collaboration `domain/reviewDecisionPolicy.ts`

四个类型与 `REVIEW_DECISION_POLICY` 原样迁入。已有的 `domain/reviewDecision.ts` 放的是决定清单与回执的编解码（人工门操作日志的形状），
关注点不同，不合并。

### D4 轮次规则 → collaboration `domain/reviewRounds.ts`

`resolveReviewRoundMode`、`groupDocVersionRounds` 与两个类型原样迁入。

### D5 使用方

生产与用例里从旧位置取这些名字的 import 逐个改到新位置；同时取加载器与校验本体的拆成两条 import。用例里读这两个文件源码文本做断言的
（源码锁），断言对象随内容改指新文件，断言意图不变。

## 3. 清单（退出门）

迁出后旧位置不声明、不转出这些名字：

- resource-catalog `domain/workflowValidator.ts`：`ValidatorWorkflowRef`、`WorkflowValidationCandidate`、`ValidatorPluginResource`、
  `ValidatorMcpResource`、`ValidatorContext`、`WorkflowValidationOverlayError`、`withValidationOverlays`、`WORKFLOW_VALIDATION_CONTEXT_DOMAIN_V1`、
  `projectWorkflowValidationContext`、`workflowValidationContextHashOf`、`workflowDefinitionCandidateHashOf`、`validateWorkflowDefinition`、
  `validateWorkflowDef`、`extractTemplateVars`、`validateAgentClarifyMultiplicity`（15 个）。
- collaboration `domain/reviewCommentAnchor.ts`：`OccurrenceRecomputeResult`、`AnchorValidationError`、`recomputeOccurrenceIndex`、
  `canonicalizeAnchor`、`anchorResolutionError`、`assertResolvedAnchorConsistent`、`resolveCommentAnchor`（7 个）。
- collaboration `domain/reviewDecisionPolicy.ts`：`ReviewRerunPolicy`、`ReviewDecisionPolicyBase`、`ReviewDecisionPolicyOf`、
  `ReviewDecisionPolicy`、`REVIEW_DECISION_POLICY`（5 个）。
- collaboration `domain/reviewRounds.ts`：`resolveReviewRoundMode`、`RoundGroupRow`、`DocVersionRound`、`groupDocVersionRounds`（4 个）。

另：`review.ts` 不再转出 `findAllOccurrences`。

## 4. 用例

新增 `rfc493-pure-logic-out-of-infrastructure-boundary`（AST，带负对照，登记 guard-manifest）：

- ① 清单里每个名字在全部生产文件里只在表里的新文件声明（resource-catalog 的 application 端口里早有一个同名的不同类型
  `WorkflowValidationCandidate`，逐个钉住）。
- ② `legacy/workflow.validator.ts` 与 `review.ts` 不声明、不转出这些名字，`review.ts` 不转出 `findAllOccurrences`；`legacy/workflow.validator.ts`
  只声明三个加载器入口与它们的辅助。
- ③ 全部生产文件与用例都不从旧位置取这些名字（import 与 re-export、type-only 都认，带负对照）。
- ④ 四个新文件不取任何 infrastructure、IO 包与进程全局；函数没有 `async`（纯的、同步的）。

另外依赖现有用例：工作流校验（`workflow-validator`、`rfc199-*`、`rfc271-*` 等）、锚点（`rfc326-anchor-canonicalize`、
`review-anchor-disambiguation`）、决定策略（`rfc149-decision-policy`）与轮次（`rfc142-review-rounds`）的用例原样跑，作为逐字迁移的对拍；
RFC-294 的模块分层门（`rfc294-review-module-layer-rules`）覆盖新文件。

## 5. 看过但不进清单的项与理由

扫描 `modules/*/infrastructure/**`（不含 `crewstation`、`migration`、`drivers`、`local`、`hosted` 这些适配器子目录）里同步、不取库 / 文件
系统 / 进程的顶层声明，共 904 个、约 1.45 万行；按 D14 的判据（规则 / 校验 / 策略，整块）筛：

- **适配器的本分，留在 infrastructure**：持久化行映射与 schema 贡献（`agentPersistence`、`workgroupPersistence`、`intentSqlPersistence`、
  各模块 `persistence/schema.ts` 等）、外部协议与载荷的编解码（代码托管调用的拼装、`clarifyAnswerCodec`、`skillIdentityPaths`、
  `humanGateOpenParticipant` 的清单解码等）、读模型的投影与行形状（`nodeRunSnapshot`、`rootTaskAdmission` 的投影、`taskDetailQueries`
  的行映射等）、请求体与查询串解析（`workgroupTaskSubmission`、`taskListPage/filters`）、错误翻译（`mcpProbe.classifyProbeError`、
  `uniqueConstraintViolation`）、兼容入口与装配接线。
- **依赖 infrastructure 自有的类型或机制，整块迁出要连带迁走它们**：`legacy/skillOpRecovery.ts`（类型在 `legacy/skillOperations.ts`）、
  `runtime-management` 的 `mcpTestEligibility.ts`（读驱动）、`resourcePackageMaintenancePaths.ts`（`node:path`，domain 禁用）。
- **与异步编排交织的局部规则**：`taskQuestionDispatch.selectDispatchBatch`、`taskRouteRepairOperations.OPTION_DEFINITIONS`、
  `taskRouteOperations.retryNodeIds`、`resourcePackageAtomicApply` 的三段判定、`clarify/autoDispatch.mergeDurableDispatchResult` 等——各自
  只服务同文件的异步用例，迁出等于拆用例，按 D14 随 S9 与触及它们的功能 RFC 归位。

## 6. 取舍（可推翻）

1. **逐字迁移，不拆 `validateWorkflowDef`**：2,460 行的单个函数照原样进 domain；拆分是可读性重构，不是本后继的目标，且会让“行为一致”
   失去逐字对拍的证据。
2. **`legacy/workflow.validator.ts` 不改名**：它仍承载 `validateWorkflowById`，改名只增加使用方改动面；头注写明校验本体的位置。
3. **决定策略表单独成文件**：不并进 `domain/reviewDecision.ts`（那里是操作日志的编解码）。
4. **清单只收两处必含项及其同类纯规则**：§5 的项不进清单；它们是否另立波次整体归位由用户决定（RFC-294 review §9）。

实施中的细化（都在本 RFC 范围内）：

1. **锚点规范化落 `domain/reviewCommentAnchor.ts`**：collaboration 已有 `domain/reviewAnchor.ts`——RFC-326 的锚点解析器（引文 + 第几处 +
   章节 → 复合锚点），头注写明只取 shared 的原语。迁出的规范化建立在它之上（取 `buildReviewAnchorDocument`、`resolveReviewAnchor`），且
   `AnchorValidationError` 取 `@/util/errors`，并进去会改变那个文件的依赖面，所以另立文件，按它处理的对象（评论锚点）命名。
2. **源码锁与登记随内容改指新文件**：插件禁用码的发射点清单（resource-catalog `domain/disabledResourcePolicy.ts` 的
   `PLUGIN_DISABLED_SITES`，生产数据，RFC-470 用例逐个查文件在）改指 `domain/workflowValidator.ts`；读校验器源码的锁
   （`rfc199-workflow-validation-targets` 的发射点棘轮、`rfc199-workflow-validation-context-ratchet` 的编译入口与语义源清单、`rfc103` 的
   单源断言、`cross-clarify-validator-rules` 的规则码枚举、`multiplicity-prepass-singleton` 的单源 grep，以及前端
   `rfc203-validation-copy` 收集全部校验码的那一条）与 `rfc148` 的动态 import 改指新文件，断言意图不变；其中后三处是集中验证首批
   红了一条之后，按文件名本身（含 `'workflow.validator.ts'` 这种路径片段）全仓再扫查出的。全量又查出一处生产数据：intent 的教学
   登记（`intent/domain/teaching/nodeKinds.ts` 的 `VALIDATOR`）把校验器文件记为节点字段的读点，`intent-teaching-registry` 按它做 AST
   正反向核对，改指新文件（读点只供这条用例核对，不进任何提示词）。随后按代码里的字符串字面量（AST，排除注释）把全部包、`e2e`、
   `scripts` 再扫一遍，又查出两条迁移后会**静默变空**的否定锁——`rfc271-impl-gate-fixes`（校验器源码不含控制字符）与 shared 的
   `wrapper-kind-single-source`（校验器不再手写 wrapper 三联判断）——一并改指新文件（前者保留原文件）。`commons-manifest.json` 两段
   核验文字里的校验器行号改指新文件。
3. **`review.ts` 的分节标题**：随纯规则整段迁出的分节标题（“Anchor — pure functions.”、“Internal helpers”、RFC-149 的轮次判定）一起
   迁出；“Decision (approve / reject / iterate).”下面还有留在原处的决定事务代码，留在 `review.ts`。
4. **调用闭包的两个选择函数随校验迁入**：`pickCallWorkflowRow` 与 `resolverOverClosure` 写在加载器一段的中间，但只有
   `validateWorkflowDef` 调用（加载器不用）；按行号切分时它们留在了原文件，静态自查（eslint 报原文件里未使用、domain 里未声明）查出，
   连同注释原样移入 domain，紧跟在两个输入类型之后。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：迁出的是规则判定，落 domain；infrastructure 只留加载与读写；不新增用例入口。
- **C11**：public 不变（不新增、不撤下出口）；不导出 SQL 片段、行形状查询工厂或状态写原子。
- **C12**：RFC-493 用例覆盖全部生产文件与全部用例里的同名声明与 import（语料下限在 guard-manifest 写明），另读两个旧文件与四个新文件；
  只对这些范围宣告退出门。
- **C13**：触及的计数不升；本 RFC 不改任何 `counts.json` 的 `max`（若实测变化，按实测收紧）。
