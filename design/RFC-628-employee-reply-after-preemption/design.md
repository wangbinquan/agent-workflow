# RFC-628 技术设计

路径约定：源码相对 `packages/backend/src/`，测试相对 `packages/backend/`，`e2e/`、`packages/frontend/`、`design/` 从仓库根写起；行号以提交 `1dab46cd7` 为准。文中「台账」指检视处理台账上下文 `development.review-resolution`，「下一步指针」指 `employee_cases.current_work_item_ref`。

## 1. 落位（RFC-294 对齐）

- **bounded context**：全部业务改动落在 `development-automation`。按 RFC-294 的 owner 表，MR 生命周期归它，员工类型、案件、反应调度归 `digital-employee`（`design/RFC-294-backend-layered-target-architecture/proposal.md:146`、`:149`）。本 RFC 只改开发员工类型包的描述符、编解码与平台工作项，**不改** `modules/digital-employee` 的通用调度，也不加表结构。
- **分层**：
  - `domain/`：新增修订号判断函数（`domain/mergeRequestLifecycle.ts`），新增纯函数文件 `domain/reviewResolutionFollowUp.ts`，承载「台账处于什么状态时该续办哪一步」这条规则。它只接收普通值，不依赖任何框架或端口。
  - `application/`：`application/employeeTypePackage.ts`（描述符、结算、输出校验）、`application/employeePlatformWorkItems.ts`（平台工作项）、`application/graph-development/{deliveryLifecycle,builtinCatalog,deliveryJobs}.ts`（图研发修订号与内置目录、内置岗位）。
  - `bootstrap/daemonModules/digitalEmployee.ts`：组合后的平台工具目录多一处委托，把升级映射也交给图研发目录回答，与该对象已有的 `listJson` / `getRevisionJson` / `isPlatformTool` 委托同形（`:205-225`），不承载业务判断。
  - 前端只改一处链接，不新增组件。前端只把后继关系写进屏幕阅读器文本与无障碍标签（`packages/frontend/src/components/digital-employees/ResponsibilityFlowDisplay.tsx:125`、`EmployeeCapabilityPanorama.tsx:1366`），按「只有一个后继」判断的两处（`EmployeeCapabilityPanorama.tsx:179`、`:772`）只作用于入口直接指向的工作项，不涉及 `observe-mr` 与 `observe-approval`，所以视觉基线不受影响。
- **承担的演进一步**：新增的续办规则放进 `domain/` 的纯函数，结算与平台工作项只调用它，而不是继续把判断堆进 5400 多行的 `application/employeeTypePackage.ts`。这符合 G1「业务规则判定在 application / domain，infrastructure 只实现端口」（RFC-294 `proposal.md:128-130`）。
- **留下的债**：结算与输出校验主体仍在 `application/employeeTypePackage.ts`（RFC-494 说明它们要对编解码合同定型，所以留在 application，`employeeTypePackage.ts:5-9`）；按修订号分支的开关继续累积（`domain/mergeRequestLifecycle.ts` 再多一个）；图研发直接复用研发描述符（`employeeTypePackage.ts:3098-3127`），改研发的 MR 看护就要同时给图研发升号；内置岗位按「标识 + 内容」播种、名称在同一归属与类型修订号下唯一，内容随修订号变化时标识和名称都得换（§3.6）。
- **偏离项**：无。不绕过运行内核，不新增临时 facade，不新增跨 context 的内部 import。

## 2. 现状机制

### 2.1 抢占与下一步指针

- 规划时取收件箱里优先级最高的待处理事件（`modules/digital-employee/application/runtimeService.ts:3026-3028`），下一步指针对应的工作项作为续接（`:3029-3035`）。规则声明 `preemptsContinuation` 时放弃续接、改跑规则指向的工作项（`:3042-3047`）；建轮时收件箱那条记为已领取（`modules/digital-employee/infrastructure/runtimeStore.ts:1411-1416`），下一步指针被改写成这一轮的工作项（`:1417-1430`，`:1421`）。
- 续接轮次的事件内容只是 `{ kind: 'work-item-continuation', … }`（`runtimeService.ts:3247-3253`），拿到案件的全部上下文（`:3053-3056`）；事件轮次只拿规则声明的必需与可选上下文（`:3057-3060`）。
- 结算时平台把案件当前的全部上下文和这一工作项在**冻结描述符**里允许的后继交给类型包（`runtimeService.ts:1507-1521`），返回的下一步不在允许集合里就报 `employee-continuation-invalid`（`:1535-1543`）；有下一步时案件必须是 active（`:1544-1548`）。落库时，正常完成写成结算给出的下一步，阻塞时保留当前工作项（`runtimeStore.ts:2064-2068`）。
- 研发类型的六条反应规则在 `application/employeeTypePackage.ts:2950-3026`，其中检视、冲突、生命周期、审批四条声明抢占；前三条落到 `observe-mr`，审批落到 `observe-approval`。生命周期规则属于主干泳道，优先级固定最高（`modules/digital-employee/domain/model.ts:1709-1711`）。

### 2.2 台账与回复

- 台账结构在 `employeeTypePackage.ts:3426-3511`：`status` 为 `collected`/`acknowledged`/`prepared`/`replied`，另有 `sourceHeadSha`、`publishedHeadSha`、`commitSha` 和逐线程行（确认回执、处理结论、回复正文、最终回复回执）。约束：线程为空时必须是 `collected` 且两个提交都为空（`:3455-3465`）；`prepared`/`replied` 时每行都要有处理结论与正文（`:3484-3493`）；`replied` 时两个提交都不能为空（`:3502-3510`）。**`prepared` 状态下 `publishedHeadSha` 可以非空，结构不禁止。**
- 汇总（`classify-feedback`，`application/employeePlatformWorkItems.ts:968-1067`）新建 `collected` 台账，把上一份台账的全部行原样带过来（`:1040-1042`），并把 `publishedHeadSha` 置空（`:1038`）；已记过的线程版本不进本轮问题集合（`:988-998`）。
- 确认（`acknowledge-feedback`）保留已有确认回执的行（`:1132-1136`），线程不空时保留 `publishedHeadSha`（`:1184-1190`）。
- 修复（`repair-feedback`）的输出校验分两段：第一段把 Agent 的逐线程说明写进台账、状态变为 `prepared`，`publishedHeadSha` 固定写空（`employeeTypePackage.ts:4743-4771`）；其中不在本轮回复里、又没有最终回执的行一律删掉（`:4760`）。第二段复核：期望行 = 有最终回执的行 + 本轮选中的行（`:4936-4940`），且 `publishedHeadSha` 必须为空（`:4952`）。输出校验在 `:4635-4638` 判断「只回复、不改代码」（直接结果里没有提交信息），这时不要求交付内容（`:4639-4653`），投影也不生成交付内容（`application/digitalEmployeeToolContractProjectionV2.ts:440-445`）。结算并不读这个判断，而是看输出里有没有交付内容：最小工具合同的修订号下没有 `deliveryContent` 就去回复，否则去冻结提交（`employeeTypePackage.ts:5223-5226`）；两种判断在最小工具合同下结果一致。
- 发布（`publish-mr`，`employeePlatformWorkItems.ts:1640-1860`）提交、推送、确保 MR，输出只改修改候选、MR 和流水线上下文（`:1838-1859`）；结算看台账是 `prepared` 就去回复（`employeeTypePackage.ts:5227-5231`）。
- 回复（`reply-feedback`，`employeePlatformWorkItems.ts:1224-1321`）要求台账是 `prepared`（`:1241-1247`），先刷新线程（`:1248-1258`），对每条没有最终回执的行：幂等标记由案件、线程、线程版本和 **MR 上下文当前的头提交**算出（`:1268-1274`，算法 `:407-425`），线程里已有同一标记就直接记回执（`:1275-1284`），否则发出「已在提交 <头提交前 12 位> 中处理」（`:1285-1288`）；任何一条发送失败就整轮阻塞且不写台账（`:1295-1300`）。全部完成后写 `replied`，两个提交都写 MR 当前头提交（`:1310-1316`）。它**不检查**线程是否还存在、是否已解决、版本是否变化：线程已解决或版本已变时照常发送；线程已被删除时，回复调用会因讨论不存在而失败、整轮阻塞（这一步是推断，代码平台对不存在讨论的响应没有在仓内验证）。回复接口只有一个笼统失败码（`modules/integration/application/mrFacts.ts:546-548`、`:573-575`），只回复、绝不 resolve（`application/ports/reconcilerPorts.ts:673-674`）。
- 线程版本只计非平台消息（`mrFacts.ts:29-43`、`:174-185`），所以平台自己的回复不会产生新的检视事件；观察程序按事实摘要去重，内容没变就不发事件（`modules/integration/application/developmentEventObservers.ts:188-193`）。

### 2.3 `observe-mr` 的结算

`employeeTypePackage.ts:5342-5416`：MR 已合入或已关闭 → 终止（`:5346-5349`）；否则依次判断「触发事件是检视更新、检视能力启用、有台账里没记过的未解决线程」→ `classify-feedback`（`:5390-5395`），「触发事件是冲突更新、冲突能力启用、确有冲突」→ `repair-conflict`（`:5396-5401`），其余 → `prepare-approval` 或 `evaluate-ready`（`:5402-5411`）。前两支以触发事件类型为条件，触发事件类型从本轮输入的事件里解析（`:5113-5120`）；续接轮次的事件内容是 `{ kind: 'work-item-continuation', … }`（`runtimeService.ts:3247-3253`），没有事件类型，解析结果为空，只会走第三支。允许的后继在 `:2298-2304`，不含 `reply-feedback` 与 `prepare-change`。

「检视能力启用」在这里是 `capabilityEnabled('classify-feedback')`（启用清单为空时视为全部启用，`:5143-5144`）。`classify-feedback`、`acknowledge-feedback`、`repair-feedback`、`reply-feedback` 同属可选的检视泳道 `care-review`（`:2061-2067`），员工的启用清单按泳道整体展开（`modules/digital-employee/application/authoringService.ts:2344-2378`），所以这四项同时启用或同时不启用；`prepare-change` 属于交付主线（`:2033-2037`，不是可选泳道），恒为启用。续接指向未启用的工作项时，规划报 `employee-continuation-capability-disabled`（`runtimeService.ts:3081-3097`），所以结算只能把下一步指向已启用的工作项。

`observe-approval` 只有一个后继 `observe-mr`（`:2572`），结算靠「只有一个后继就取它」的默认（`:5164-5165`）；审批仍在进行中时平台工作项输出 `needs-input`（`employeePlatformWorkItems.ts:1522-1523`，代码平台暂时观察不到时同样，`:1492-1501`），结算统一变为等待、下一步为空（`employeeTypePackage.ts:5177-5179`）。

### 2.4 工作区何时被重建

`observe-mr` 在 MR 仍开着、源分支头与工作区记录不一致时取回远端并重建工作区（`employeePlatformWorkItems.ts:2050-2052`、`:2077-2104`）；遇到冲突只取回目标分支（`:2062-2076`），不重建。发布冲突修复后按 merge commit 重建（`:1964-1974`）。重建是按新头提交重新克隆，只把平台目录复制过去，业务文件的未提交修改全部丢弃（`modules/source-control/application/employeeCaseWorkspace.ts:142-171`）。头提交不变时不重建。`prepare-change` 从员工工作区导出修改候选（`employeePlatformWorkItems.ts:1569-1577`），它在正常流程里紧接修复执行，所以修复执行完时改动已经在工作区里；重跑 `prepare-change` 时，写入候选记录遇到同一引用不重复写（`infrastructure/employeePlatformWorkItemPersistence.ts:116-126`），不会因为已经导出过而失败。

### 2.5 类型修订号

- 研发类型手写在 `employeeTypePackage.ts:104`（现为 11）；图研发 `@1` 在 `application/graph-development/employeeType.ts:4`，`@2` 在 `application/graph-development/deliveryLifecycle.ts:51`。`@2` 由图研发核心加研发的 MR 看护部分组合而成（`deliveryLifecycle.ts:108-138`），后者取自研发描述符（`employeeTypePackage.ts:3098-3127`）。
- 启动时逐个登记（`bootstrap/daemonModules/digitalEmployee.ts:158-169`），同一修订号摘要不同即报 `employee-type-revision-drift`、守护进程启动失败（`modules/digital-employee/infrastructure/authoringStore.ts:465-484`；摘要对整个描述符计算，`modules/digital-employee/domain/model.ts:1638-1640`）。
- 员工、岗位启动时自动升到最新修订号（`modules/digital-employee/application/authoringService.ts:345-384`、`:502-582`）；工作契约不变时沿用原校验回执（`:754-771`）。平台内置工具要由目录给出新修订号下的后继，给不出就报 `platform-tool-successor-missing`（`:699-711`），员工留在旧修订号，不能再发起新工作（`runtimeService.ts:593-601`）。
- 交办创建时钉住员工当时的修订号（`runtimeService.ts:1036`），之后按它从库里取冻结描述符（`:614-623`）。编解码按类型标识登记、所有修订号共用（`bootstrap/daemonModules/digitalEmployee.ts:166-169`），每次调用带上案件钉住的修订号（`runtimeService.ts:1513`）。

## 3. 改动

### 3.1 domain：判断函数与续办规则

`domain/mergeRequestLifecycle.ts` 新增：

```ts
/** RFC-628: replies prepared before a preemption are delivered from observe-mr. */
export function usesPreemptionSafeReviewReplies(typeRef: MergeRequestLifecycleTypeRef | null | undefined): boolean
// development ≥ 12 或 graph-development ≥ 3
```

新文件 `domain/reviewResolutionFollowUp.ts`，一个纯函数：

```ts
type LedgerStatus = 'collected' | 'acknowledged' | 'prepared' | 'replied'

/** 台账要求的续办：已发布 → 回复；未发布且工作区未被重建 → 重新冻结提交；其余 → 无。 */
export function pendingReviewFollowUp(input: {
  readonly ledger: { status: LedgerStatus; publishedHeadSha: string | null; sourceHeadSha: string } | null
  readonly mergeRequestHeadSha: string
}): 'reply-feedback' | 'prepare-change' | null
// ledger?.status !== 'prepared'                              → null
// ledger.publishedHeadSha !== null                           → 'reply-feedback'
// ledger.sourceHeadSha === mergeRequestHeadSha               → 'prepare-change'
// 其余                                                        → null
```

「MR 头提交仍等于台账的源头提交」用来判断修复还在工作区：源头提交是汇总时的 MR 头提交（汇总校验要求两者相等，`employeeTypePackage.ts:5036-5043`），工作区只在头提交变化或发布冲突修复时重建（§2.4），两者都会改变 MR 头提交。

原设计里的 `carriedPublishedHeadSha`、`retainsCarriedReply`（把上一轮没发出的回复带进新一轮）删除，理由见 §8 的 P1-1、P1-2。

### 3.2 描述符（`application/employeeTypePackage.ts`）

| 位置 | 现状 | 改为 |
| --- | --- | --- |
| `:104` | `revision: 11` | `revision: 12` |
| `:2298-2304` `observe-mr` | `classify-feedback, collect-pipeline, repair-conflict, prepare-approval, evaluate-ready` | 末尾追加 `reply-feedback, prepare-change` |
| `:2572` `observe-approval` | `observe-mr` | `observe-mr, reply-feedback, prepare-change` |

工作项数量（20）、工作契约、反应规则、上下文类型都不变，所以自动升级沿用原校验回执（`authoringService.ts:754-771`），四条抢占规则的守卫（`tests/rfc310-digital-employee-authoring.test.ts:1471-1480`）不动。图研发经共享描述符自动得到同样的后继（`employeeTypePackage.ts:3098-3127` → `graph-development/deliveryLifecycle.ts:115-137`）。

### 3.3 结算（`resolveReactionSettlementJson`）

所有新分支都以「冻结清单允许这条后继」为条件（`request.allowedNextWorkItemRefs.includes(...)`，同 `graph-development/deliveryLifecycle.ts:231-235`），并以目标工作项已启用为条件；旧修订号的清单里没有这些后继，结算结果与现在逐条相同。

1. **`observe-mr`**（`:5390-5411`）：原则是「被抢占后先把上一轮做完，再处理新的」。MR 仍开着时的判断链改为：

   | 步 | 条件 | 下一步 |
   | --- | --- | --- |
   | 1 | MR 已合入 / 已关闭（`:5346-5349`，不变） | 终止 |
   | 2 | 台账「已准备、未发布、MR 头提交仍等于台账的源头提交」（修复还在工作区），清单允许 `prepare-change`，检视泳道启用 | `prepare-change` |
   | 3 | 触发事件是冲突更新、冲突能力启用、确有冲突（`:5396-5401`，条件不变） | `repair-conflict` |
   | 4 | 台账「已准备、已发布」，清单允许 `reply-feedback`，检视泳道启用 | `reply-feedback` |
   | 5 | 检视能力启用、有台账里没记过的未解决线程，且（触发事件是检视更新，**或者**清单允许 `reply-feedback`，即新修订号——新修订号下这一步不看触发事件类型） | `classify-feedback` |
   | 6 | 其余 | 原兜底（`:5402-5411`）：`prepare-approval` 或 `evaluate-ready` |

   ```ts
   const allowed = (ref: string) => request.allowedNextWorkItemRefs.includes(ref)
   const reviewLaneEnabled = capabilityEnabled('reply-feedback') // 与 classify-feedback 同一泳道，§2.3
   const followUp = pendingReviewFollowUp({ ledger: priorReviewResolution, mergeRequestHeadSha: mergeRequest.headSha })
   if (followUp === 'prepare-change' && allowed('prepare-change') && reviewLaneEnabled)
     nextWorkItemRef = 'prepare-change'                                   // 第 2 步
   else if (triggeringEventTypeId === 'development.conflict-updated' &&
            capabilityEnabled('repair-conflict') && mergeRequest.mergeableState === 'conflict')
     nextWorkItemRef = 'repair-conflict'                                  // 第 3 步
   else if (followUp === 'reply-feedback' && allowed('reply-feedback') && reviewLaneEnabled)
     nextWorkItemRef = 'reply-feedback'                                   // 第 4 步
   else if (capabilityEnabled('classify-feedback') && hasNewReviewFeedback &&
            (triggeringEventTypeId === 'development.review-updated' || allowed('reply-feedback')))
     nextWorkItemRef = 'classify-feedback'                                // 第 5 步
   else /* 第 6 步：原兜底 */
   ```

   `priorReviewResolution` 复用 `:5356-5358` 已解析的值（含本轮输出里的补丁）；`mergeRequest.headSha` 是本轮刷新后的头提交（`employeePlatformWorkItems.ts:2106-2114`）。旧清单下第 2、4 步与第 5 步里新修订号的那一半都不成立，剩下的第 3 步与第 5 步以触发事件类型互斥，与原来「检视分支在冲突分支之前」的结果相同。

   **为什么这样排**（对着源码确认的推理）：

   - **第 2 步排在第 3 步之前。** 修冲突会重建工作区（`publish-conflict` 按 merge commit 重建，`employeePlatformWorkItems.ts:1964-1974`），未提交的修复随之丢失；先提交推送修复不受冲突影响（推送的是源分支，`:1735-1744`）。第 2 步占用了冲突事件触发的那一轮之后，冲突由推送后的新冲突事件接手：冲突事实的内容含头提交与目标分支提交（`modules/integration/application/developmentEventObservers.ts:80-92`，内容在 `:85-89`），观察程序按内容摘要去重（`:188-193`），摘要变了就以新序号再发一条（`:194-208`）。推送后头提交变了，冲突若仍在，就会再有一条冲突事件；代码平台一时算不出可合入状态时冲突事实暂缺、游标记为空（`:184-186`），算出冲突后摘要与空值不同，照样会发。
   - **第 4 步排在第 3 步之后。** 只回复不改头提交，冲突事实的内容不变，不会有第二条冲突事件（`developmentEventObservers.ts:188-193`）；回复也不产生检视事件，因为线程版本与正文只计非平台消息（`modules/integration/application/mrFacts.ts:174-185`）。所以冲突事件触发的那一轮若先去回复，冲突就再没有机会被处理；先修冲突则不丢回复：`publish-conflict` 唯一的后继是 `observe-mr`（`employeeTypePackage.ts:2498`），那一轮经第 4 步去回复。
   - **第 3 步不放开到续接轮次。** `publish-conflict` 之后的 `observe-mr` 是续接轮次，它刷新事实后取代码平台报告的可合入状态（`employeePlatformWorkItems.ts:2120`）。冲突若没修好（或目标分支又前进），放开会让它直接回到 `repair-conflict`，修冲突的 Agent 在没有新事件的情况下反复运行。保持以冲突事件为条件，冲突仍在时由内容变化后的下一条冲突事件触发。
   - **第 5 步在新修订号下不看触发事件类型，也不会绕圈。** 汇总把所有「未解决、非自身、台账里没记过」的线程版本写进台账（`employeePlatformWorkItems.ts:989-998`、`:1040-1050`），结算判断「没记过」用的是同一标准（`employeeTypePackage.ts:5359-5369`），汇总找不到这样的线程时直接等待（`employeePlatformWorkItems.ts:999-1004`）。一轮检视处理走完之后，这些线程都已记进台账，续接轮次再到第 5 步时不再满足。台账的写入方现有汇总、确认、清理过期检视、修复校验与回复五处（`employeePlatformWorkItems.ts:360-370`、`:1060-1064`、`:1199-1203`、`:1306-1317`，`employeeTypePackage.ts:4762-4771`），本 RFC 新增的发布补丁只写 `publishedHeadSha`（§3.5 第 1 条）；线程离开台账只有四种情况：确认时已不再待处理（已解决或出了新版本，`employeePlatformWorkItems.ts:1137-1141`）、清理过期检视（`:353-358`）、修复校验删掉不属于本轮的未完成行（`employeeTypePackage.ts:4760`）、回复时线程已删除（§3.5）。出了新版本是真正的新意见；被修复校验删掉的行重新汇总一次后即被记下（§3.8）；其余几种线程已不是待处理状态。放开的原因：触发这一轮的检视事件被第 2 步或第 4 步占用后已被领取（`modules/digital-employee/infrastructure/runtimeStore.ts:1411-1416`），检视事实内容不变时观察程序不会再发（`developmentEventObservers.ts:188-193`），续办之后的 `observe-mr` 是续接轮次（`reply-feedback` 唯一的后继是 `observe-mr`，`employeeTypePackage.ts:2379`），要由它接手被占用的新意见。只放开到续接轮次还不够：这次续接若在执行之前被一条生命周期事件抢占（提交待执行被检视更新抢占时，这条往往就是员工自己推送引起的；未配置 Webhook 时观察程序每 30 秒轮询一次，`employeeTypePackage.ts:2743`），那一轮的触发事件是生命周期更新，新意见又没人接手。所以新修订号下任何一轮 `observe-mr` 都做这一步；结算拿到的是案件当前的全部上下文（`runtimeService.ts:1507-1521`），不依赖这一轮是由什么触发的。同一批线程若还有一条检视事件留在收件箱里，它之后触发的那一轮发现线程都已记过，落到原兜底。

2. **`observe-approval`**：
   - 在 `needs-input` 分支（`:5177-5179`）内：工作项是 `observe-approval`、检视泳道启用、`pendingReviewFollowUp(...)` 为 `reply-feedback` 或 `prepare-change` 且清单允许这条后继时，`caseState = 'active'`、`nextWorkItemRef` 取这条续办；否则照旧等待。审批仍在进行中（`employeePlatformWorkItems.ts:1522-1523`）与暂时观察不到（`:1492-1501`）都走这里。台账与 MR 上下文取自结算拿到的案件全部上下文（`runtimeService.ts:1507-1521`），不受这条规则只声明审批上下文（`employeeTypePackage.ts:3017-3026`）的影响。这里的 MR 头提交是上一次观察到的值（`observe-approval` 不刷新 MR）；源分支在那之后被别人推进时工作区还没重建、修复仍在，冻结照常，推送因远端前进而失败、阻塞（§5「重新冻结提交后推送因远端前进而失败」一行）。
   - 新增显式分支 `request.workItemRef === 'observe-approval'`（输出 `ok`）→ `observe-mr`。清单变成三个后继后，「只有一个后继就取它」的默认（`:5164-5165`）不再生效，没有这一支会落到 `:5420-5423` 抛错；旧清单下这一支给出的结果与默认相同。审批通过后的续办由这次 `observe-mr` 的第 2、4 步完成。
   - 输出 `blocked`（驳回、过期、不可用）照旧阻塞。

   不会重复提交审批：续办只回复线程或提交推送；之后的 `observe-mr` 是续接轮次，审批判断与正常发布后的路径相同——当前头提交已有审批（进行中也算）就不再准备审批（`:5386-5388`、`:5403-5410`），头提交变了才为新头提交准备审批。回复不改头提交，所以「回复待执行」时同一头提交的审批照常等待；「提交待执行」时推送改变了头提交，流水线就绪后为新头提交准备审批，与「发布修复 → 回复 → 关注 MR 状态」的正常路径一致。审批上下文仍是进行中，审批事件照常订阅（`employeeTypePackage.ts:4175-4184`）。

3. **`publish-mr`**（`:5227-5231`）：新修订号（`usesPreemptionSafeReviewReplies(request.employeeTypeRef)`，后继集合没变，只能按修订号区分）下，只有台账为 `prepared` 且（含本轮补丁后）`publishedHeadSha` 非空才去 `reply-feedback`，否则 `observe-mr`。配合 §3.5 第 1 条：本次发布不包含那次检视修复时不再误称「已在提交中处理」。旧修订号照旧只看 `prepared`。

### 3.4 修复的输出校验（`validateReactionOutputJson`，`repair-feedback`）

以 `usesPreemptionSafeReviewReplies(request.employeeTypeRef)` 为条件（下称「新修订号」）。

- 第一段（`:4743-4771`）：保留与删除的规则不变（不属于本轮、没有最终回执的行照旧删除，`:4760`）。写台账时 `publishedHeadSha` 改为：新修订号且只回复（`replyOnlyReviewResult`，`:4635-4638`）→ 输入里 MR 上下文的 `headSha`（缺 MR 上下文时为空）；其余 → 空。`commitSha` 照旧为空。
- 第二段（`:4911-4970`）：期望行不变（`:4936-4940`）；`proposed.publishedHeadSha !== null`（`:4952`）改为「不等于上面算出的期望值」。

新修订号下，新一轮修复开始时台账里不会有「已准备、已发布」的旧行：第 4 步排在第 5 步之前，这样的台账总是先被回复。会被删掉的旧行只有两类：工作区重建后丢了修复的「已准备、未发布、头提交已变」的行，以及更早被抢占而中断的一轮留下的行（proposal §7 已知限制）。它们的去向见 §3.8。

### 3.5 平台工作项（`application/employeePlatformWorkItems.ts`）

新增 `function usesPreemptionSafeReplies(plan)`（同 `:252-254` 的写法），以下改动都以它为条件。

汇总（`:1034-1051`）与清理过期检视（`reconcileStaleReviewSelection`，`:316-383`）不改：新修订号下，新一轮汇总只会在台账既不是「已准备、已发布」也不是「已准备、未发布、头提交未变」时发生（第 2、4 步排在第 5 步之前），汇总把 `publishedHeadSha` 置空（`:1038`）不会丢掉有效的发布记录；台账为「已准备」时问题集合已被修复的结算标为已解决（`employeeTypePackage.ts:5204-5222`），清理只在问题集合仍是进行中时动手（`:330`），碰不到已准备的台账。原设计在这两处带过 `publishedHeadSha` 的改动删除。

1. **发布**（`publish-mr`，`:1838-1859`）：成功后若台账存在、为 `prepared`、`publishedHeadSha` 为空，**且本次候选的基线等于台账的 `sourceHeadSha`**（`candidate.baselineSha`，`:1679`、`:1692`），追加一条台账补丁，`publishedHeadSha = committed.commitSha`，生命周期沿用原值。基线相等说明自汇总那一刻起工作区没有被重建（重建会推进基线，`:2098-2103`），检视修复一定在这次候选里；不相等说明修复可能已随重建丢掉，不标记，§3.3 第 3 条随之不去回复。平台工作项跨契约补台账已有先例（`observe-mr` 的清理补丁，`:2156-2165`、`:2183`）。`publishedHeadSha` 已经非空（只回复的一轮之后又因流水线修复发布）时不改，回复仍引用当初判断时的提交。头提交被强推回原值时这个判据会误判，见 §5。
2. **回复**（`reply-feedback`，`:1224-1321`）：
   - 刷新线程快照（`:1248-1258`）之后先看 MR 是否仍开着（快照带 `state`，`employeePlatformWorkItems.ts:506-515`；确认步骤已有同样的判断，`:1114`）。已合入或已关闭时：不发任何回复、不改台账，输出 `ok`、没有上下文补丁、没有副作用建议，摘要为「MR 已合入（或已关闭），不再回复修复结果」。结算按唯一后继走到 `observe-mr`（`employeeTypePackage.ts:2379`、`:5164-5165`），那一轮是续接轮次，刷新后由 §3.3 第 1 条的第 1 步终止交办。
   - 回复正文与幂等标记引用的提交改为 `resolution.publishedHeadSha ?? mergeRequest.headSha`（`:1273`、`:1287`），写 `replied` 时两个提交也写这个值（`:1313-1314`）。这样从 `observe-mr` 回来补发时，即使头提交已被别人推进，重试仍算出同一个标记，已发的线程只补记回执（`:1275-1284`），不重复发。
   - 对每一条还没有最终回执的行（不再区分本轮行与旧行）：线程在刚刷新的快照里已不存在 → 不发，从台账移除，记入「未回复」，继续下一条。发送失败照旧整轮阻塞、不写台账（`:1295-1300`）：回复接口只有一个笼统失败码（`mrFacts.ts:546-548`），分不出暂时与永久失败，阻塞后恢复能安全重试。
   - 全部行都被移除 → 写空台账：`status: 'collected'`、两个提交为空（满足 `employeeTypePackage.ts:3455-3465`）、`lifecycleState: 'terminal'`（与写 `replied` 时相同，`:1309`；这一步已结束、没有待办，之后的汇总写回 `active`，`:274`、`:1060-1064`）；否则照旧写 `replied`。
   - 有行被移除时摘要追加「另有 N 条线程已删除，未回复：<线程引用>」，截断到原摘要上限内。被移除的行仍保留在上下文修订历史里。
   - 线程已解决、版本已变化时照旧发送：回复只针对台账记录的那个版本，平台只回复、不 resolve；版本已变的新意见由第 5 步处理。

### 3.6 graph-development@3

| 位置 | 改动 |
| --- | --- |
| `graph-development/deliveryLifecycle.ts:51` | `revision: 3`；新增 `GRAPH_MR_DELIVERY_FIRST_REVISION = 2` |
| `deliveryLifecycle.ts:178-182`、`:275` | 与常量比较改为与 `GRAPH_MR_DELIVERY_FIRST_REVISION` 比较；否则 `@2` 的请求会被当成旧版本、失去 MR 交付模式 |
| `graph-development/builtinCatalog.ts:140-151` | 在 `type-v2:` 记录之外再生成同实现的 `type-v3:` 记录（`typeRevision: 3`） |
| `builtinCatalog.ts:158` | `[1, 2]` → `[1, 2, 3]` |
| `builtinCatalog.ts:188-190` | 实现 `resolveCompatibleRevisionJson`：目标为 `graph-development@3`、来源标识以 `${prefix}type-v2:` 开头且工作项相同 → 返回把前缀换成 `type-v3:` 的当前记录（形状同 `getRevisionJson`），找不到返回空 |
| `bootstrap/daemonModules/digitalEmployee.ts:223-225` | 先问图研发目录，再问原目录 |
| `graph-development/deliveryJobs.ts:6-7` | 内置岗位标识改为 `platform:graph-development:job:mr-v2`、`…:mr-ci-v2`（内容随修订号变化，按原标识播种会报内容冲突，`modules/digital-employee/application/builtinEmployeeJobs.ts:22-31`、`:48-55`） |
| `deliveryJobs.ts:135`、`:144` | 内置岗位名称也换，改为「图驱动研发 · MR 交付与看护（v2）」「图驱动研发 · 完整 MR 看护（v2，配置流水线连接）」。理由见表后 |
| `deliveryJobs.ts:125` | 配置链接由已导入的 `GRAPH_DELIVERY_EMPLOYEE_TYPE` 拼出（`${typeId}@${revision}`），不再写死 `graph-development@2`；不新增 import 与顶层声明（`tests/rfc509-development-automation-composition-remainder-boundary.test.ts:94-103`、`:293-297` 逐名钉住） |
| `composition/graphDeliveryLifecycle.ts` 注释 | 「graph@2」改为不带修订号的说法 |
| `packages/frontend/src/features/development-automation/graph-development/GraphDesignDelivery.tsx:49` | 链接改为 `graph-development%403` 与 `mr-ci-v2` |

不用改：`employeePlatformWorkItems.ts:742-751`、`domain/mergeRequestLifecycle.ts:43`、`:52`、`packages/frontend/src/routes/employee-cases.$caseId.tsx:917` 都是「≥ 2」，对 3 同样成立；`bootstrap/daemonModules/digitalEmployee.ts:428-460` 播种的是 `@1` 的内置岗位，不受影响。图研发 MR 看护里的业务工具（检视修复、冲突修复、流水线分类与修复）由原内置目录按类型描述符生成并解析后继（`modules/digital-employee/application/builtinToolCatalog.ts:142-249`、`:282-300`），`@3` 描述符登记后自动具备，无需改动。

不做第 3 行到第 6 行的后果：`@2` 的员工与岗位绑着 `type-v2:` 内置工具，升级时找不到后继（`authoringService.ts:699-711`），留在 `@2`，不能再发起新工作；不做第 7 行则启动时 `initializeGraph` 播种内置岗位即抛错（`bootstrap/daemonModules/digitalEmployee.ts:461-466`）。

为什么名称也要换（设计门之后读码补的一处）：启动时先自动升级、再播种图研发内置岗位（`bootstrap/daemonApplication.ts:870-872`、`:949-950`）。系统发布的旧内置岗位只要还有员工引用，就会在 `@3` 下生成后继（`authoringService.ts:524-532`）；`@3` 下还没有同名岗位时后继沿用原名、归属同为空（`:1156-1219`）。随后播种的新内置岗位若仍用原名，就撞上「归属 + 类型 + 修订号 + 名称」的唯一索引（`modules/digital-employee/infrastructure/persistence/schema.ts:793-807`），报 `employee-job-template-name-conflict`（`modules/digital-employee/infrastructure/authoringStore.ts:724-729`），守护进程启动失败。流水线岗位草稿只要被用户发布过，后继总会生成（`authoringService.ts:524-530`），同样会撞名。换名后两份并存：迁移过来的副本沿用原名，供已升级的员工继续使用；新的内置岗位用新标识与新名称（proposal §7）。

### 3.7 数据形状变化汇总

不加表、不加列、不改上下文的 JSON 结构。只是 `publishedHeadSha` 的取值范围变宽（新修订号）：

| 台账状态 | 现状 | 新修订号 |
| --- | --- | --- |
| `collected` / `acknowledged` | 恒为空 | 不变（恒为空；回复时线程全部被移除写成的空台账也是 `collected`、为空） |
| `prepared` | 恒为空 | 只回复：判断时的 MR 头提交；改了代码：发布前为空，发布成功且候选基线等于源头提交时为发布提交 |
| `replied` | MR 当前头提交 | 发布提交（未记录时取 MR 当前头提交） |

### 3.8 被抢占情形逐一走查

「回复待执行」：下一步是 `reply-feedback`，台账「已准备、已发布」（改了代码且已推送，或只回复）。「提交待执行」：下一步是 `prepare-change` 或 `publish-mr`，台账「已准备、未发布」，MR 头提交等于台账的源头提交。抢占时下一步指针被改写成抢占轮次的工作项（`runtimeStore.ts:1421`）。下文「续接 `observe-mr`」指续办之后那次没有触发事件的 `observe-mr`，「步」指 §3.3 第 1 条的判断链。

| 起点 | 抢占事件 | 走向 | 被占用的那件事由谁接手 |
| --- | --- | --- | --- |
| 回复待执行 | 生命周期 | 已合入 / 已关闭 → 第 1 步终止，不回复；否则第 4 步 → 回复 → 续接 `observe-mr` | 终态结算与事实刷新在这一轮已完成；原本的去向（审批或可合入判断）由续接 `observe-mr` 的第 6 步走到 |
| 回复待执行 | 检视（无新意见） | 第 4 步 → 回复 → 续接 `observe-mr` → 第 6 步 | 无事可接 |
| 回复待执行 | 检视（有新意见） | 第 4 步 → 回复 → 续接 `observe-mr` → 第 5 步 → 汇总 | 续接 `observe-mr` 经第 5 步接手（例外见 §5 末行） |
| 回复待执行 | 冲突（确有冲突） | 第 3 步 → 修冲突 → 提交冲突修复 → 续接 `observe-mr` → 第 4 步 → 回复 | 没有被占用的事，回复延后一段；修复早已推送，提交冲突修复重建工作区不影响它 |
| 回复待执行 | 冲突（已消失） | 第 4 步 → 回复 | 无事可接 |
| 回复待执行 | 审批（进行中或暂时观察不到） | `observe-approval` → 回复 → 续接 `observe-mr` → 第 6 步：同一头提交已有审批 → 可合入判断 | 新的审批状态已在这一轮记入审批上下文；审批仍在订阅，后续审批事件照常处理 |
| 回复待执行 | 审批（通过） | `observe-approval` → 续接 `observe-mr` → 第 4 步 → 回复 → 续接 `observe-mr` → 第 6 步 | 同上 |
| 提交待执行 | 生命周期 | 已合入 / 已关闭 → 终止（修复没推送，不回复）；头提交变了 → 这一轮已重建工作区，第 2 步不成立 → 第 6 步（proposal §7 已知限制）；头提交没变 → 第 2 步 → 冻结 → 发布并标记 → 回复 | 同「回复待执行 × 生命周期」 |
| 提交待执行 | 检视（有或无新意见） | 第 2 步 → 冻结 → 发布并标记 → 回复 → 续接 `observe-mr` → 第 5 步（有新意见时）或第 6 步 | 新意见由续接 `observe-mr` 经第 5 步接手。推送引起的生命周期事件在回复之前到达时抢占回复 → 第 4 步 → 回复，不受影响；在回复之后、续接之前到达时，由它触发的那一轮 `observe-mr` 经第 5 步接手 |
| 提交待执行 | 冲突（确有冲突） | 第 2 步（排在第 3 步之前）→ 冻结 → 发布并标记 → 回复 | 推送改变了头提交，冲突仍在时观察程序再发一条冲突事件（§3.3 第 1 条），由它触发第 3 步 |
| 提交待执行 | 审批（进行中或暂时观察不到） | `observe-approval` → 冻结 → 发布并标记 → 回复 → 续接 `observe-mr` → 第 6 步：旧审批不属于新头提交，流水线就绪后为新头提交准备审批 | 同「回复待执行 × 审批」 |
| 提交待执行 | 审批（通过） | `observe-approval` → 续接 `observe-mr` → 第 2 步 → 冻结 → 发布并标记 → 回复 | 同上 |
| 任一 | 审批（驳回、过期、不可用） | 阻塞在 `observe-approval` | 见 proposal §7 |

阻塞后恢复：阻塞时下一步保留（`runtimeStore.ts:2064-2068`），台账不变（阻塞输出不带补丁，如 `employeePlatformWorkItems.ts:1295-1300`）；恢复后若被攒下的事件抢占，按上表对应的行走。

工作区重建后丢了修复的旧行：台账「已准备、未发布、头提交已变」时第 2、4 步都不成立，台账停在「已准备」。之后若经第 5 步开始新一轮，汇总把这些行原样带进新台账（`employeePlatformWorkItems.ts:1040-1042`），确认保留有确认回执的行（`:1133-1136`），修复校验把不属于本轮、没有最终回执的行删掉（`employeeTypePackage.ts:4760`）。被删之后线程若仍未解决，就成了「没记过的未解决线程」，本轮回复之后的续接 `observe-mr` 经第 5 步重新汇总、重新修复；「已收到」的标记只由案件、线程与线程版本算出（`employeePlatformWorkItems.ts:1142-1147`），重新确认时认出已发的那条，不重复发（`:1148-1157`）。没有新意见触发新一轮时，台账停在「已准备」（proposal §7）。

## 4. 修订号与同步清单

**随 `development@12` 必改**（锁着修订号字面量）：

- `tests/digital-employee-type-package-drift.test.ts:116`、`:130`、`:135`、`:138`、`:139`、`:160`（11 → 12、10 → 11）。
- `tests/rfc310-digital-employee-authoring.test.ts:178`、`:849`、`:867`、`:884`、`:927`、`:1262`、`:1285`、`:1301`、`:1456`、`:3261`、`:3291`、`:3335`、`:3388`。
- `tests/rfc318-minimal-digital-employee-tool-contracts.test.ts:246`（`:242` 标题里的 `development@10` 一并改正）。
- `tests/digital-employee-builtin-tool-catalog-cache.test.ts:60`。
- `tests/rfc396-mr-lifecycle.test.ts:219-222`。
- `tests/rfc330-case-list-membership-scope.test.ts:59-60`：直接插入的案件写死 `typeRevision: 11`（注释写明取的是全新安装登记的当前内置包），改为 12。上一次升号后它曾单独补改（提交 `655181228`）。
- `e2e/visual-regression.spec.ts:1203`、`:1561`、`:1763`：改用 `e2e/development-type-ref.ts` 的 `DEVELOPMENT_TYPE_PATH`。它们以 `/digital-employees/development%4011` 出现，现有扫描只认引号紧挨 `development` 的写法（`tests/e2e-development-type-ref.test.ts:44-49`），所以没被拦下。扫描**只**补认 `/digital-employees/development%40<数字>` 这一种写法，并在 `:72-88` 的自检里加一例；`e2e/rfc310-zero-config-onboarding.spec.ts:215` 故意保留的 `/digital-employee-types/development@4`（断言不再请求旧修订号）不算违规，自检里既有的反例（`tests/e2e-development-type-ref.test.ts:79`）与期望（`:87`）不变。`:1638`、`:1667` 是模拟数据，顺手改为 12。

**随本次改动必改**：`tests/rfc310-digital-employee-authoring.test.ts:284-290`（`observe-mr` 后继），并新增 `observe-approval` 后继的断言；`tests/rfc396-mr-lifecycle.test.ts:405-407` 用当前的图研发修订号（`@3`）断言「台账已准备 → 回复」，新修订号下台账要带上 `publishedHeadSha` 才成立，改用已标记的台账并补一例「未标记 → `observe-mr`」。工作项数量（`:179`、`:1463`、`e2e/visual-regression.spec.ts:1206`）与抢占规则清单（`:1471-1480`）不变。

**不用改**：`e2e/development-type-ref.ts` 从描述符取值；`tests/rfc616-process-kinds.test.ts` 里的 `development@11` 是自成一体的假数据；显式写 `revision: 10` 的夹具（如 `tests/rfc310-approval-pipeline-order.test.ts:46`）测的就是旧修订号。

**随 `graph-development@3` 必改**：

- `tests/rfc383-daemon-employee-automation-bundles.test.ts:133-145`（`graph-development@2` → `@3`）。
- `tests/rfc396-registration.test.ts:200-232`（列岗位的修订号、两个内置岗位标识、`listJson` 的修订号）。
- `tests/rfc396-mr-job.test.ts:39`（假目录只认修订号 2）、`:89`、`:145`。
- `tests/rfc396-case-intake.test.ts:30`（`typeRef` 写死 `graph-development@2`；升号后当前构建只执行 `@3`，`@2` 在全新的测试库里不登记，按它取岗位、建员工都会失败，`authoringService.ts:451-469`；改用 `GRAPH_DELIVERY_EMPLOYEE_TYPE`）与 `:32`、`tests/rfc396-mr-runtime-wiring.test.ts:403`（内置岗位标识改用 `GRAPH_MR_JOB_ID` 常量）。
- `tests/rfc509-development-automation-composition-remainder-boundary.test.ts`：`:74-86` 逐名列出 `graph-development/deliveryLifecycle.ts` 的全部顶层声明，`:587-598` 要求实际声明与之完全相同；新增的 `GRAPH_MR_DELIVERY_FIRST_REVISION` 要登记进去，`:581` 的名字总数 27 随之改为 28；若导出，还要加进 `:87-92` 的交出清单。同一文件 `:286-297` 逐条钉住 `deliveryLifecycle.ts` 与 `deliveryJobs.ts` 的 import，`:94-103` 逐名钉住 `deliveryJobs.ts` 的声明，本 RFC 在这两个文件里不新增 import 与顶层声明。
- `packages/frontend/tests/rfc396-graph-workspace.test.tsx:736`。
- `e2e/rfc396-graph-care-repair.spec.ts:34`、`:324`、`:678`，`e2e/rfc396-graph-development.spec.ts:24`、`:78`、`:704`、`:757`：改为从后端常量取类型引用与岗位标识（仿 `e2e/development-type-ref.ts` 新建 `e2e/graph-development-type-ref.ts`）。

**不用改**：`tests/rfc396-mr-bridge.test.ts:83`、`tests/rfc396-h6-reimplementation.test.ts:71`、`tests/rfc396-verification.test.ts:782` 把 `@2` 作为平台工作项计划里的夹具，测的是 `@2` 的冻结行为，应当保持。

**仓库账本**（不属于本 RFC 起草范围，由实现方在提交时同步）：`design/plan.md` 的 RFC 索引登记、`STATE.md` 顶部的进行中条目、`design/RFC-616-process-metrics/plan.md:311-312` 的「待单独立项」改为指向本 RFC。

## 5. 失败模式

| 情形 | 结果 |
| --- | --- |
| 新分支给出的后继不在冻结清单里 | 不会发生：每条新分支都先查清单；万一出现，类型包与平台各有一道拒绝（`employeeTypePackage.ts:5425-5429`、`runtimeService.ts:1535-1543`），平台工作项重试用尽后案件阻塞 |
| 回复步骤刷新线程失败 | 照旧阻塞（`employeePlatformWorkItems.ts:1253-1258`）；恢复后无论续接还是被抢占，都会再次进入回复 |
| 回复部分发送后失败 | 照旧阻塞，台账不写；重试时（含恢复后被抢占、经第 4 步回来的补发）提交取 `publishedHeadSha`，标记不变，已发的线程只补记回执 |
| 回复时线程已删除 | 从台账移除并写明，不阻塞；删除的讨论不会再出现在 MR 事实里，这一行不会回来 |
| 回复时线程列表没有读全（代码平台的响应被截断，或解析不出线程数组） | 读取仍算成功、线程列表为空，无从判断哪些线程已被删除。新修订号此时不做「不在列表里即已删除」的移除，也不写空台账，对每条尚未回复的行照常发出回复并记为已回复，与旧修订号对这些行的处理相同；摘要写明没有读全、本轮没有核对线程是否已被删除或已有回复。列表读全时仍按上一行处理（§9 P2-1） |
| 回复时发送被拒 | 照旧阻塞（笼统失败码分不出暂时与永久失败） |
| 回复时 MR 已合入或已关闭 | 不发、不改台账、照常完成，下一步 `observe-mr` 终止交办（§3.5 第 2 条） |
| 推送成功、MR 创建或绑定失败 | 阻塞在 `publish-mr`：推送在前、确保 MR 在后（`employeePlatformWorkItems.ts:1735-1774`），失败输出不带补丁，台账没有标记发布，工作区记录也没更新（`:1791` 未执行）。推送本身引起一条生命周期事件，恢复时它抢占 `publish-mr`，`observe-mr` 见源分支头与工作区记录不一致而重建工作区（`:2050-2052`），台账「已准备、未发布、头提交已变」，第 2、4 步都不成立：修复已在远端，回复不发（proposal §7） |
| 头提交被强推回原值 | `observe-mr` 先看到中间值时已按它重建工作区、丢掉修复，再看到原值时又重建回来；此时 MR 头提交与工作区基线都等于台账的源头提交，第 2 步与 `publish-mr` 的标记都会误判修复还在：重新冻结时工作区里没有那次修复（没有任何改动时导出报 `candidate-empty`，`modules/source-control/application/changeCandidate.ts:312`，冻结步骤随之阻塞，`employeePlatformWorkItems.ts:1578-1583`）；别的流程（例如修流水线）发布时会被标记为已发布，随后回复仍称「已在提交中处理」（proposal §7）。两次观察之间完成的强推不触发重建，修复仍在工作区，不受影响 |
| 只回复的一轮在回复前头提交被别人推进 | 回复引用判断时的提交，与修复前（引用回复时的头提交）不同，内容更准确 |
| 重新冻结提交时工作区里没有改动 | 按 §2.4 的判据只有头提交未变才会走到这里；万一如此，由 `prepare-change` 既有的导出与提交逻辑处理（导出失败即阻塞，`employeePlatformWorkItems.ts:1578-1583`），本 RFC 不改这部分 |
| 工作区已被重建，之后别的流程（例如修流水线）发布了一次 | 候选基线不等于台账源头提交，不标记发布，`publish-mr` 结算不去回复；台账停在「已准备」，落入已知限制 |
| 重新冻结提交后推送因远端前进而失败 | 照旧阻塞在 `publish-mr`；恢复时若被生命周期事件抢占，`observe-mr` 会重建工作区，修复丢失，落入已知限制 |
| 循环 | 不会：第 2 步之后的发布改变头提交，第 2 步不再满足；第 4 步之后回复写回 `replied` 或空台账（`employeePlatformWorkItems.ts:1303-1320`），第 4 步不再满足；第 5 步之后线程记进台账（§3.3 第 1 条）；第 3 步只由冲突事件触发。假平台工作项不按真实实现写回台账时会循环，见 §6 的夹具提示 |
| 被续办占用的新意见，回复之后又来一条生命周期事件 | 续接被它抢占，由这条生命周期事件触发的 `observe-mr` 经第 5 步接手（新修订号下第 5 步不看触发事件类型） |

## 6. 测试策略

仓库规则：先写完全部实现与全部用例，再集中验证。新测试文件顶端写明锁的是哪次缺陷（2026-11-27 GitLab 现场、提交 `033f5fafe` 修的前一半、本 RFC），写法照 `tests/development-mr-facts-recollect.test.ts:1-11`。

| 编号 | 锁的内容 | 位置 / 照着写 |
| --- | --- | --- |
| A1 | `usesPreemptionSafeReviewReplies`：研发 11 否、12 是；图研发 2 否、3 是；其他类型否 | `tests/rfc396-mr-lifecycle.test.ts:230-243` 旁 |
| A2 | `pendingReviewFollowUp` 的全部分支：没有台账、`collected` / `acknowledged` / `replied`、已准备已发布、已准备未发布且头提交未变、已准备未发布且头提交已变 | 新文件 `tests/rfc628-review-follow-up.test.ts` |
| B1 | `observe-mr` 新清单、台账已准备已发布：触发为生命周期、无新意见的检视、有新意见的检视、无冲突的冲突更新、续接 → `reply-feedback`；确有冲突的冲突更新 → `repair-conflict`（第 3 步先于第 4 步） | 新文件 `tests/rfc628-reply-after-preemption-settlement.test.ts`，照 `tests/rfc310-approval-pipeline-order.test.ts:18-70`，上下文构造借 `tests/rfc396-mr-lifecycle.test.ts:84-156`。续接轮次的输入按真实形状给 `work-item-continuation` 事件（`runtimeService.ts:3247-3253`），不要沿用 `tests/rfc396-mr-lifecycle.test.ts:168-200` 里的 `'manual'` 触发 |
| B2 | 新清单、台账已准备未发布且头提交未变：生命周期、有或无新意见的检视、确有冲突的冲突更新、续接 → `prepare-change`（第 2 步先于第 3 步）；头提交已变 → 不续办，按其余步走 | 同上 |
| B3 | MR 已合入 / 已关闭 → 终止（两种台账都一样） | 同上 |
| B4 | 第 5 步：台账 `replied`、有没记过的未解决线程，触发为续接、生命周期、无冲突的冲突更新各一例 → `classify-feedback`；线程都已记过 → 原兜底（不绕圈）；续接轮次、确有冲突、没有待续办 → 原兜底（第 3 步不放开） | 同上 |
| B5 | 旧清单（`development@11` 的后继列表、修订号 11）用 B1～B4 的输入 → 与修复前逐条相同（含续接轮次 + 没记过的线程 → 原兜底） | 同上 |
| B6 | 检视泳道未启用（启用清单不含 `care-review` 的工作项）→ 第 2、4、5 步都不成立 | 同上 |
| B7 | `observe-approval`：进行中 × 回复待执行 → active / `reply-feedback`；进行中 × 提交待执行 → active / `prepare-change`；暂时观察不到同样；进行中、没有待续办 → 等待；旧清单 → 等待；`ok` 新旧清单都 → `observe-mr`；`blocked` 照旧 | 同上 |
| B8 | `publish-mr`：新修订号下台账已准备但未标记发布 → `observe-mr`，已标记（含本轮补丁）→ `reply-feedback`；修订号 11 只看已准备 | 同上；也可并入 `tests/rfc396-mr-lifecycle.test.ts:405-408` |
| C1 | 图研发 `@3` 上 B1、B2、B4、B7 同样成立；同样输入给 `@2`（旧清单、修订号 2）结果与修复前相同 | `tests/rfc396-mr-lifecycle.test.ts:168-200` 的 `settlement`（升号后代码里不再有 `@2` 的描述符，`@2` 的旧后继清单在用例里显式写出） |
| D1 | 修复校验新修订号：只回复写入 MR 头提交；改代码写空；不属于本轮、没有最终回执的旧行照旧删除；平台补丁里 `publishedHeadSha` 与期望值不符被拒 | `tests/rfc396-mr-lifecycle.test.ts:360-409` 的调法 |
| D2 | 修复校验修订号 11：同样输入 `publishedHeadSha` 为空 | 同上 |
| E2 | 发布成功、候选基线等于台账源头提交时补写 `publishedHeadSha`；基线不等时不补；`publishedHeadSha` 已非空时不改；修订号 11 不补 | `tests/rfc310-employee-workspace-delivery.test.ts`（真实 git，`plan(...)` 显式传 `development@12`；默认空修订号即旧行为） |
| E3 | 回复用 `publishedHeadSha` 作正文与标记；头提交已被推进、上一次已发同标记时回复计数不增加 | 同上，回复计数 `:1036-1120` |
| E4 | 线程已删除的行被移除、摘要写明、其余照发、不阻塞；发送失败照旧阻塞、台账不变；全部移除时写空台账（`collected`、两个提交为空、`lifecycleState: 'terminal'`） | 同上 |
| E5 | 修订号 11：线程已删除照旧阻塞，正文用 MR 头提交，不看 MR 是否已合入 | 同上 |
| E6 | 新修订号下回复时 MR 已合入 / 已关闭：不发任何回复、不改台账、输出 `ok`、摘要写明；结算下一步 `observe-mr`，它终止交办 | 同上；结算部分并入 B 组 |
| F1 | 运行时、回复待执行：分别注入生命周期、无新意见的检视、确有冲突的冲突更新、进行中的审批事件，各自推进到空闲，断言「回复修复结果」执行了一次、台账为 `replied`。冲突那一例走完「修冲突 → 提交冲突修复 → 续接 `observe-mr` → 回复」整条链 | 新文件 `tests/rfc628-reply-after-preemption-runtime.test.ts`，`describeEachProvider` 双库，照 `tests/rfc396-case-intake.test.ts:61-107` 直接改库摆出起点，事件注入与推进照 `tests/rfc310-employee-case-runtime.test.ts:2170-2261` |
| F2 | 回复阻塞 → 恢复 → 恢复时被生命周期事件抢占 → 回复执行、台账 `replied` | 同上 |
| F3 | 生命周期事件显示已合入 → 终止，不再进入回复 | 同上 |
| F4 | 运行时、提交待执行：被有新意见的检视更新抢占 → 冻结、发布、回复旧线程 → 续接 `observe-mr` 汇总新线程；被确有冲突的冲突更新抢占 → 冻结、发布、回复，再注入推送后的新冲突事件 → 修冲突 | 同上 |
| F5 | 运行时、审批进行中 × 两种续办：回复待执行 → 回复；提交待执行 → 冻结、发布、回复；之后都回到 `observe-mr` | 同上 |
| F6 | 续接轮次发现没记过的未解决线程 → 汇总并走完一轮；推进到空闲后汇总只执行了一次（不绕圈）。另一例：回复之后、续接执行之前注入一条生命周期事件，由它触发的那一轮同样汇总新线程 | 同上 |
| G1 | 系统级：真实 GitLab 模拟的检视闭环里，推送修复后、回复前注入一条生命周期事件，最终线程里恰好一条修复结果回复、台账为 `replied`；另一例在修复执行完、提交之前注入一条带新评论的检视事件，断言修复被提交推送、旧线程收到修复结果回复、新线程随后收到「已收到」 | `tests/rfc310-digital-employee-system-mock-e2e.test.ts:2444-2624`，加一个「推进到下一步指针为指定工作项为止」的步进辅助 |
| H1 | 描述符守卫：`observe-mr`、`observe-approval` 的后继；修订号 12 | `tests/rfc310-digital-employee-authoring.test.ts:284-290` 等（§4） |
| J1 | 图研发内置目录：`@3` 列出 `type-v3:` 工具；`type-v2:` → `type-v3:` 后继解析；组合目录先问图研发 | 新增用例放 `tests/rfc396-registration.test.ts` |
| J2 | `@2` 的图研发员工（用 `@2` 内置岗位创建）启动后自动升到 `@3` 并能发起新工作；启动不报 `employee-job-template-name-conflict`，`@3` 的岗位列表同时有迁移副本（原名）与新内置岗位（新标识、新名称） | 照 `tests/rfc310-type-package-auto-upgrade.test.ts:2098`（平台工具经目录给出的后继迁移）与 `:1671`（工具 → 岗位 → 员工逐级升级）的写法 |
| J3 | `buildInitialCaseJson` / `buildInvokedCaseJson`：修订号 2 与 3 都进入 MR 交付模式，1 不进入 | `tests/rfc396-mr-lifecycle.test.ts:245` 起的同组用例旁 |
| K1 | e2e 修订号扫描认出 `/digital-employees/development%40<数字>`；`/digital-employee-types/development@4` 这条反例仍不算违规 | `tests/e2e-development-type-ref.test.ts:72-88`，`:79`、`:87` 不变 |

既有用例里锁着「生命周期事件使修复续接失效」的一条（`tests/rfc310-employee-case-runtime.test.ts:2224-2232`）在新修订号下仍应通过：那时台账是 `acknowledged`，第 2、4 步不满足，触发为生命周期，第 5 步也不满足。

夹具注意：有些用例的假平台工作项对 `reply-feedback` 只返回成功、不写台账（例如 `tests/rfc310-employee-case-runtime.test.ts:962-972` 对非 `publish-mr` 一律如此）。这类用例升到新修订号后，如果流程走到「台账已准备且已发布」，会在 `observe-mr` 与 `reply-feedback` 之间反复往返。同样，新修订号下不写 `publishedHeadSha` 的假 `publish-mr`（同一文件 `:973-1026` 只写 MR 与流水线上下文、头提交不变）会让流程在 `prepare-change` → `publish-mr` → `observe-mr` 之间循环：发布后台账未标记，结算回到 `observe-mr`，头提交仍等于源头提交，第 2 步又成立。集中验证时遇到，应让假实现与真实实现一致地写回台账，不要改生产分支。

## 7. 裁决

起草方代为裁决，用户可随时改判。

- **D1 总体做法**：照做。抢占照常发生，`observe-mr` 结算时按台账续办；只改开发员工类型包与平台工作项，不改通用调度，不加表结构。依据见 §2.1、§2.3。
- **D2「修复已发布」的判据**：照做，并补了几处。结构允许 `prepared` 下 `publishedHeadSha` 非空（`employeeTypePackage.ts:3455-3511`），只回复的一轮在修复校验时写入、改代码的一轮在发布成功后补写（§3.4、§3.5 第 1 条）；补写还要求本次候选的基线等于台账的源头提交，否则发布并不包含那次修复，`publish-mr` 的结算也随之不去回复（§3.3 第 3 条），避免现状里「别的流程顺带发布时误称已处理」。回复的正文、幂等标记与 `replied` 记录改用它，避免从 `observe-mr` 回来补发时因头提交变化而重复发送（§3.5 第 2 条）。（设计门后删除：原先由汇总与清理过期检视把这个值带进新一轮，见 D4。）
- **D3 结算先后**（设计门后改写）：「被抢占后先把上一轮做完，再处理新的」。顺序为终态 → 重新冻结提交 → 修冲突 → 回复 → 汇总新意见 → 原兜底（§3.3 第 1 条）。重新冻结提交排在修冲突之前，因为修冲突会重建工作区、丢掉未提交的修复；回复排在修冲突之后，因为只回复不改头提交、不会有第二条冲突事件，而提交推送会改变头提交、冲突仍在时观察程序会再发一条。汇总新意见在新修订号下不再看触发事件类型，被续办占用的新意见由之后任何一轮 `observe-mr` 接手；修冲突不放开，避免修冲突的 Agent 反复运行。每一种被抢占的情形走查见 §3.8。
- **D4 新一轮与上一轮的回复**（设计门后改写）：删除跨轮携带。原设计让新意见排在回复之前，再把上一轮没发出的回复带进新一轮；设计门指出这在「修复改了代码还没提交」和「多轮连续到来」时都不成立（§8 P1-1、P1-2）。改为续办排在汇总之前，新一轮开始时上一轮已经回复完毕，台账照现状只留有最终回执的行与本轮的行（§3.4）。「发不出去」只按一种事实判断：刷新后的快照里线程已不存在，对所有尚未回复的行生效，移除并写明、不阻塞；发送失败一律照旧阻塞，因为回复接口只有一个笼统失败码，分不出暂时与永久失败（`mrFacts.ts:546-548`），阻塞后恢复能安全重试。全部移除时写空台账（`collected`、两个提交为空、`lifecycleState: 'terminal'`），以满足结构约束（`employeeTypePackage.ts:3455-3465`）。
- **D5 审批那一支**：照做，后继加上 `reply-feedback` 与 `prepare-change`（设计门后补后者，§3.3 第 2 条）。审批仍在进行中时，两种续办都先做。读码确认续办不触碰审批，之后的 `observe-mr` 审批判断与正常发布后的路径相同，不会重复提交审批（`employeeTypePackage.ts:5386-5388`、`:5403-5410`）。另需显式写出「审批通过 → `observe-mr`」，否则多个后继会让默认取值失效（`:5164-5165`、`:5420-5423`）。
- **D6 发布之前的窗口**（设计门后改写）：纳入，限定条件不变：「台账已准备、未发布、MR 头提交仍等于台账的源头提交」时修改仍在工作区（工作区只在头提交变化或发布冲突修复时重建，`employeePlatformWorkItems.ts:2050-2052`、`:2077-2104`、`:1964-1974`）。这一步在 `observe-mr` 里排在修冲突与回复之前，在 `observe-approval` 进行中时也先做；被有新意见的检视更新或确有冲突的冲突更新抢占时同样先提交推送并回复，再处理新意见或冲突。头提交已变时无法判断，不纳入，列入已知限制；头提交被强推回原值时会误判，同样列入已知限制（§5）。
- **D7 修订号**：照做，`development` 升 12、`graph-development` 升 3，新行为以清单或修订号判断函数为条件（§3.3、§3.4、§3.5）。读码发现原方向没列到的必做事：图研发内置目录要生成 `type-v3:` 工具并给出后继、组合目录要把升级映射交给图研发目录、内置 MR 岗位要换标识，名称也要换（设计门后补，§3.6）；不做的话 `@2` 员工升不上去、无法发起新工作，或守护进程启动播种时报错。
- **D8 进行中的交办**：照做，不迁移，写入 proposal 非目标与已知限制。
- **D9 测试策略**：照做，见 §6；设计门后删去携带相关的用例，补齐四种抢占端到端走到「已回复」、提交前被抢占的整条链、续接轮次汇总不绕圈、审批进行中 × 两种续办、回复时 MR 已合入等用例。
- **D10 编号**：原定 RFC-627 已被并发会话占用，顺延为 RFC-628。
- **D11 设计门处置里按源码改了做法的两处**：一是 P2-9 只要求在 proposal 写明「升级后岗位列表并列出现两份 MR 岗位」，读码发现只换标识、不换名称时，仍有员工引用旧内置岗位的部署会在启动时撞名、启动失败，所以新内置岗位同时换名（§3.6），两份并列才成立。二是第 5 步原处置只放开到续接轮次；走查时发现，被续办占用的新意见若在回复之后、续接 `observe-mr` 之前又遇到一条生命周期事件，续接被它抢占，新意见要等下一条检视事件。主控据此改判：新修订号下第 5 步不看触发事件类型（§3.3 第 1 条），这个缺口不再存在。

### 未核实清楚的地方

- 没有运行任何用例或服务，以上全部是读码结论。
- 图研发自己的四条用户请求规则也声明抢占（`application/graph-development/employeeType.ts:318-333`），它们之后的路径是否都会回到 `observe-mr` 没有逐条展开；本 RFC 只保证经过 `observe-mr` 与 `observe-approval` 的路径。
- 发布升级矩阵（RFC-398）在已发布版本的库上启动当前守护进程时，`development@12`、`graph-development@3` 的追加登记与自动升级是否全部顺利，留待 CI 证明。
- 视觉基线不受影响是按代码判断的（§1），没有实际截图比对。
- 平台账号无法验证时，平台自己的回复会被算作外部消息（`mrFacts.ts:148-172`），可能触发新的检视事件；这是现状，本 RFC 没有改变它，但新增的补发路径会让它更常出现。
- 「推送后冲突仍在时观察程序会再发一条冲突事件」依赖代码平台对新头提交报告冲突；平台对新头提交长期报告「未知」时不会有这条事件。仓内没有核实各代码平台重新计算可合入状态的时延。
- 「线程在刷新后的快照里不存在即已删除」依赖快照列出 MR 的全部讨论；采集程序的分页与过滤没有逐行核对。
- 架构普查类用例（`tests/architecture/`）对新增 domain 文件的要求没有逐个核对；新文件由 application 引用、可达，按现有做法不需要登记。

## 8. 设计门处置

检视由本会话派生的 subagent 执行，只审功能，结论为不通过：没有 P0，3 项 P1、12 项 P2。下表每一项全部采纳；按仓库规则，设计门跑一次并修本人 findings，修订后不再复核。部分条目在处置说明里合并给出，表中照此合并列出。

| 编号 | 问题 | 处置 |
| --- | --- | --- |
| P1-1 | 原设计让新检视意见与冲突排在续办之前、靠跨轮携带补救；修复改了代码还没提交时，修复被下一轮顺带提交而线程只有「已收到」，冲突一支连修复本身都被工作区重建丢掉 | 改为续办排在前面：重新冻结提交排在修冲突之前，回复排在修冲突之后（§3.3 第 1 条，D3） |
| P1-2 | 多轮连续到来时跨轮携带不成立：台账只有一个 `publishedHeadSha`，新一轮改代码时写空，带过来的旧行失去依据 | 删除跨轮携带（`carriedPublishedHeadSha`、`retainsCarriedReply`、汇总与清理过期检视带过发布提交、修复校验保留旧行、旧行发送失败即移除），新一轮开始前上一轮已回复完毕（§3.1、§3.4、§3.5，D4） |
| P1-3 | 同步清单漏了三处：插入案件写死修订号 11、逐名比较 `deliveryLifecycle.ts` 顶层声明、案件接收用例的 `typeRef` 写死 `@2` | 补进 §4；按同样思路再扫，补上同一逐名用例的名字总数与 import 钉住两处 |
| P2-1 | e2e 修订号扫描「补斜杠开头的写法」会把故意保留的 `/digital-employee-types/development@4` 也当成违规 | 只补认 `/digital-employees/development%40<数字>`，既有反例与期望不变（§4，K1） |
| P2-2 | 审批进行中时只续办回复，提交待执行的修复仍搁浅 | `observe-approval` 的后继再加 `prepare-change`，两种续办都先做（§3.2、§3.3 第 2 条，B7、F5） |
| P2-3 | 从 `observe-mr` 回到回复时 MR 可能已合入或关闭，回复步骤照发 | 新修订号下回复刷新线程后先看 MR 是否仍开着，已合入或已关闭时不发、不改台账、照常完成，由下一次 `observe-mr` 终止（§3.5 第 2 条，E6） |
| P2-4、P2-5 | 跨轮携带下，线程已删除被移除的行会不会回来、幂等标记跨轮变化导致重复 | 携带删除后前提不存在；proposal §7 写明被移除的行不会回来、标记在一轮之内（含补发）稳定 |
| P2-6 | 推送成功而 MR 创建或绑定失败后被抢占，修复已在远端却不回复 | 列入已知限制并写明依据（§5，proposal §7） |
| P2-7、P2-8 | 测试策略缺端到端「已回复」、冲突与提交前抢占的整条链、续接汇总不绕圈、审批 × 两种续办、MR 已合入、`publishedHeadSha` 已非空、图研发 `@2` 不变，夹具提示不全 | §6 逐项补齐（B4、C1、E2、E6、F1～F6、G1），夹具提示补上假 `publish-mr` 的循环 |
| P2-9 | 升级后图研发 `@3` 岗位列表会并列出现迁移来的旧内置岗位副本与新内置岗位，proposal 没写 | 写进 proposal §7；读码发现不换名称会撞名、启动失败，新内置岗位同时换名（§3.6，D11） |
| P2-10、P2-11 | 五处表述与源码或彼此不一致：审批驳回后的恢复行为；全部移除时台账的 `lifecycleState`；「检视能力启用」指哪个工作项；「线程已删除即移除」对所有行生效而 proposal 目标 5 的说法不同；§2.2 里结算依据的行号 | 逐处改正：proposal §7 改写驳回后的恢复；空台账写 `terminal`（§3.5 第 2 条）；§2.3 写明同一泳道、判断目标工作项；目标 5 改为对所有尚未回复的行；§2.2 改为结算按交付内容判断（`:5223-5226`） |
| P2-12 | 「候选基线等于源头提交」在头提交被强推回原值时会误判 | 写进 §5 与 proposal §7 |

## 9. 实现门处置

全部实现与用例写完、集中验证通过之后，由本会话派生的 subagent 做了一次只审功能的独立检视（只读，按路径限定在本 RFC 的 37 个文件）。结论：**通过**，没有 P0 与 P1，2 项 P2，均已处置。检视者逐项核对了 §3.3 的六步顺序与判据、`observe-approval` 的两条新后继、`publishedHeadSha` 的写入与校验、回复步骤对提交引用 / 已删除线程 / 终态的处理；扫过历史上出现过的全部后继清单，确认旧修订号的行为不变；对照 §3.8 的 13 种情形确认都能把上一轮回复完、没有会循环或卡死的状态；并实际运行了 7 个新用例文件、13 个同步改过的既有文件与 2 个可能受影响的文件。

| 编号 | 问题 | 处置 |
| --- | --- | --- |
| P2-1 | 代码平台的讨论列表响应超过读取上限被截断、或正文解析不出线程数组时，读取仍算成功、线程列表为空（`modules/integration/application/mrFacts.ts` 的 `collectThreads`）。新修订号的「回复修复结果」把「线程不在刷新后的列表里」当作已删除，于是一条回复都不发、把这些行从台账删掉、摘要写成「线程已删除」；旧修订号在同样条件下会正常回复 | 采集处增量标出线程列表是否完整：结果旁边加 `threadsIncomplete`（不放进快照，旧的对账路径对整个快照取摘要并落库，放进去会改变旧路径的摘要），经 `createDevelopmentMrFacts` 映射为快照上的 `reviewThreadsIncomplete`；读全时形状一字不变。回复步骤在新修订号且列表不完整时，不做移除、不写空台账，照常回复每条尚未回复的行（与旧修订号一致），摘要写明没有读全。**没有采用「等到列表读全再回复」**：等待要靠下一份 MR 事实才重试，MR 没有新动静时这一轮回复一直发不出去，列表持续超限的 MR 则永远不回复——正是本 RFC 要消除的现象，也比旧修订号差。确认步骤与 `observe-mr` 的「清理过期检视」保持不变：它们碰不到「已准备」的行，列表读全后第 5 步会重新汇总，改成等待反而让行以「已汇总」留在台账里不再被处理（§5） |
| P2-2 | 用例缺口：proposal §6 第 1、2 条的两种情形只有结算层的用例，没有运行时端到端用例；E4 缺「已有最终回复的行与已删除的行并存」与「线程列表为空」 | 补齐：`tests/rfc628-reply-after-preemption-runtime.test.ts` 加「回复待执行 × 有新意见的检视更新」「提交待执行 × 生命周期更新（头提交未变）」两例；`tests/rfc628-platform-work-items.test.ts` 加并存、列表不完整（新旧修订号在同样输入下发帖记录与台账逐字相同；读全后重试不重复回复）、标记经 `createDevelopmentMrFacts` 传到平台工作项三组；`tests/rfc310-pr7-mr-facts.test.ts` 加 GitLab 与 GitHub 各一例（非 JSON、`null`、超限被截断三种正文都标为不完整，其余字段不变） |

按仓库规则实现门只跑一次；上述修订后复验了相关范围（RFC-628 的 7 个新用例文件、`rfc310-pr7-mr-facts` 与 18 个引用 MR 事实的既有文件，全部通过），没有再做第二次检视。
