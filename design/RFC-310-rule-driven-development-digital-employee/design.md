# RFC-310 · 规则驱动的研发数字员工技术设计

> 产品视角见 [proposal.md](./proposal.md)，任务分解见 [plan.md](./plan.md)。
>
> 状态：**Done（2026-08-19 交付完成）**。PR-0..PR-10 全部落地并推 main；`gate:local` 全绿、
> hosted CI 本 RFC 面全绿。**首版不含（如实登记，见 plan.md §13a）**：evidence retention GC 与
> GB 级 nightly、浏览器级 visual regression、verification/review 结果升 catalog fact、
> cutover preflight 的 per-repo dry probe；mission 列表分页与 `/code` work-items 翻页已移交
> RFC-311。2026-08-20 补齐：out-of-order webhook 矩阵（T82）、conflict repair 的 Agent
> 执行面（T78）。
>
> **2026-08-21 数字员工操作系统实现（待 hosted 验证）**：§0A 定义“数字员工操作系统”目标架构，并优先于
> 后文与其冲突的 Mission-local step/wake/poll/child 模型。后文继续保留已交付实现的源码合同和迁移证据；不得把
> 保留文本理解为新 OS 目标仍选择有序步骤作为主抽象。数字员工分类、工作项合同、分类节点工具箱、最小业务配置、
> Event Center、Context/Reaction/Channel 与通用 UI 已落生产代码；RFC-294 owner/exact dependency 专项账本已同步，
> 完整 `gate:local` 已于 2026-08-21 全绿，当前仅剩 exact-SHA hosted CI 的发布验证。
>
> **2026-08-21 PR-19（待 hosted 验证）**：新增平台 `execution-contract` context，统一 Agent/Workflow/Program 的
> 输入输出指南、兼容校验、fixture 与运行结算；AuthoringManifest 新增通用职责泳道，固定职责图按主干、支线和外侧回路呈现。
> Manifest 与真实后继关系作为冻结类型合同发布在 `development@2`；升级只追加新 revision，不原地改写 `development@1`
> descriptor/digest，也不需要 schema migration。Agent 契约选择与端口编辑同页；契约托管的 `agent-result` 随声明原子增删，
> UI 与所有保存入口均禁止单独改写。

## 0A. 数字员工操作系统目标架构

### 0A.1 分层与依赖裁决

新目标在 RFC-294 feature-first 分层上增加两个公共 bounded context，并把现有 `development-automation` 收缩为首个
员工类型包：

```text
external webhook / scheduled observation / internal domain event
                           │
                           ▼
                     event-center
          catalog → subscription → observation
                 → event record → delivery
                           │
                           ▼
                    digital-employee
        context graph → attention reconcile → case queue
                 → reaction rule → reaction round
                 → invocation/channel/join
                           │
                           ▼
                   execution-contract
       schema guide → executor compatibility → exact receipt
                           │
                           ▼
                     task-execution
       TaskEngine → WrapperRuntime → NodeExecutor → Kernel
                │             │              │
                ▼             ▼              ▼
             Agent          Script     platform participants
                                             │
                         source-control / integration
```

目标 owner 与跨 context 合同：

| Context                  | 唯一拥有                                                                                                                                                                                                         | 只通过                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `digital-employee`       | employee type/job template/definition revision、WorkItem tool registration/ProgramTool spec、EmployeeCase、ContextRecord/Link、AttentionRule、CaseInboxItem、ReactionRule/Round、EmployeeInvocation/Channel/Join | `public/{commands,queries,participants,events,types}`    |
| `event-center`           | EventType/Source catalog、Subscription、ObserverActivation、EventRecord、transport Delivery 与 observation cursor/lease                                                                                          | `public/{commands,queries,participants,events,types}`    |
| `execution-contract`     | executor-neutral schema guide、输入 transport、exact 输出规则、Agent/Workflow/Program 兼容校验与 fixture receipt                                                                                                 | `public/types.ts` participant；机制不认识员工类型        |
| `development-automation` | 代码员工类型包、代码领域 context/event schema、两类职责、问题分类/处理与默认 attention/reaction/invocation contract                                                                                              | `digital-employee` 的 type-package registration contract |
| `task-execution`         | 已有 Task/NodeRun、Workflow/Agent/Script 执行与恢复                                                                                                                                                              | exact execution participant；OS 不直接 spawn             |
| `resource-catalog`       | Agent/Workflow 等已发布资源的 ACL/ref/revision                                                                                                                                                                   | exact resource refs/queries                              |
| `integration`            | Webhook/provider、代码平台与自建系统调用、Connection/Token 解封                                                                                                                                                  | Event Source adapter 与 typed platform call participant  |
| `source-control`         | workspace、candidate、diff、commit、CAS push                                                                                                                                                                     | 既有 path-free participants                              |
| `platform`               | tx/outbox/clock/job/process/lease/durable-queue kernel                                                                                                                                                           | 中性机制；不拥有员工/Event业务规则                       |

`digital-employee`、`event-center` 和 `execution-contract` 不得读取 `development-automation` 内部表或 import 代码员工 domain。
类型包只能通过注册合同提供 schema、pure rule/compiler、execution guide 与 tool requirements；bootstrap 只装配，不按员工类型写 `if`。

产品“工具箱”是按“数字员工分类 + 工作项 + 工作合同”建立的注册与聚合 read model：Agent/Workflow 工具引用
resource-catalog 资源；ProgramTool 的版本化程序规范属于该工作项注册并复用现有 Script executor；外部 Adapter/Connection
只引用 integration 资源。工具箱不取得底层资源写模型或 secret ownership。其他数字员工通过 EmployeeInvocation/Channel
协作，不作为普通工具注册。

### 0A.2 三层定义与运行模型

```ts
interface EmployeeTypePackageV1 {
  readonly typeId: string
  readonly version: number
  readonly authoringManifestRef: VersionedResourceRef
  readonly workScopeContractRef: VersionedResourceRef
  readonly contextTypes: readonly ContextTypeRegistration[]
  readonly eventTypes: readonly EmployeeEventRegistration[]
  readonly workItems: readonly WorkItemDefinition[]
  readonly workContracts: readonly WorkContractDefinition[]
  readonly attentionRules: readonly AttentionRuleDefinition[]
  readonly reactionRules: readonly ReactionRuleDefinition[]
  readonly invocationContracts: readonly InvocationContractDefinition[]
  readonly resultContracts: readonly ResultContractDefinition[]
  readonly supportedExecutionPolicyContract: VersionedResourceRef
}

interface EmployeeJobTemplateRevision {
  readonly jobTemplateRef: VersionedResourceRef
  readonly typePackageRef: VersionedResourceRef
  readonly displayNameKey: string
  readonly defaultToolBindings: readonly WorkItemToolBinding[]
}

interface EmployeeWorkScopeRevision {
  readonly workScopeRef: VersionedResourceRef
  readonly employeeTypeRef: VersionedResourceRef
  readonly scopeContractRef: VersionedResourceRef
  readonly displaySummary: string
  readonly encodedScopeRef: ArtifactRef // 由 type-package exact codec 铸造，不是开放 JSON
}

interface DigitalEmployeeDefinitionRevision {
  readonly employeeRef: VersionedResourceRef
  readonly typePackageRef: VersionedResourceRef
  readonly jobTemplateRef: VersionedResourceRef
  readonly displayName: string
  readonly enabled: boolean
  readonly workScopeRef: VersionedResourceRef
  readonly exactToolBindings: readonly WorkItemToolBinding[]
  readonly compiledClosureDigest: string
}

interface EmployeeCase {
  readonly caseId: string
  readonly employeeRef: VersionedResourceRef
  readonly primaryContextRef: ContextRef
  readonly executionPolicyRef: VersionedResourceRef
  readonly revision: number
  readonly state: 'active' | 'waiting' | 'blocked' | 'terminal'
  readonly terminalKind: string | null
}
```

类型包由代码发布并提供闭集 schema/编译器；岗位模板只预选该分类工作项已注册的工具；员工 definition 由业务用户通过
UI/API 配置并冻结 exact tool registrations。EmployeeCase 是运行实例，并 pin 从“设置 → 限额”物化的内部执行快照 revision。
definition 或 Limits 更新只影响新 Case；若技术运维显式把在途 Case 升到另一已物化 revision，必须 preview/apply 并重新计算
Context、Attention、pending Delivery、execution 与 invocation 失效面。

`workScopeContractRef` 同时提供 strict codec、业务表单 manifest、assignment overlap/priority validator 与显示摘要生成器。
研发类型把它实现为仓库/仓库组，设计/测试类型可使用其他 scope；`digital-employee` core 只持有 opaque exact revision，不能出现
`repositoryId` 类型分支。EmployeeInvocation 同样传 `targetWorkScopeRef`，由目标类型包验证，而不是通用 core 强制目标是仓库。

### 0A.3 Context Graph

```ts
interface ContextRecordV1 {
  readonly contextId: string
  readonly caseId: string
  readonly typeId: string
  readonly schemaVersion: number
  readonly revision: number
  readonly state: unknown // 由 type-package exact codec 铸造，不开放 Record<string, unknown>
  readonly artifactRefs: readonly ArtifactRef[]
  readonly createdAt: string
  readonly updatedAt: string
}

interface ContextLinkV1 {
  readonly caseId: string
  readonly from: ContextRef
  readonly relation:
    | 'derived-from'
    | 'handles'
    | 'delivers'
    | 'tracks'
    | 'delegates-to'
    | 'supersedes'
  readonly to: ContextRef
}

interface ExternalContextBindingV1 {
  readonly subjectType: string
  readonly subjectRef: string
  readonly caseRef: EmployeeCaseRef
  readonly contextRef: ContextRef
  readonly bindingRevision: number
}
```

Context 是当前权威状态，不采用“必须从全量 Event log 重建”的 Event Sourcing。Context 间只存 typed link；大文件只存
artifact ref。Agent Input Envelope 由 type package 的 Context Assembler 从 pinned Context revisions 物化，不能直接把
开放 JSON 当 prompt。

MR 描述/commit trailer 只携带最小可恢复 envelope：

```text
Agent-Workflow-Case: <EmployeeCaseRef>
Agent-Workflow-Context: <IssueHandlingContextRef>
Agent-Workflow-Schema: issue-handling.v1
Work-Item: <external subject ref>
```

权威 lookup 顺序为 `ExternalContextBinding(subject) → Context store`；外部消息仅用于 adoption/recovery。squash、rebase、
编辑描述或截断消息不得改变平台已绑定的 Context identity。

### 0A.4 AttentionRule 与订阅对账

```ts
interface AttentionRuleDefinition {
  readonly ruleId: string
  readonly when: {
    readonly contextTypeId: string
    readonly predicates: readonly TypedContextPredicate[]
  }
  readonly subscriptions: readonly {
    readonly eventTypeId: string
    readonly subjectFrom: TypedContextProjection
    readonly sourceProfileRef: VersionedResourceRef | null
    readonly deliveryClass: string
  }[]
}

interface DesiredSubscriptionV1 {
  readonly caseRef: EmployeeCaseRef
  readonly attentionRuleRef: VersionedRuleRef
  readonly sourceContextRef: ContextRevisionRef
  readonly eventTypeRef: EventTypeRef
  readonly subjectRef: string
  readonly sourceProfileRef: VersionedResourceRef | null
  readonly deliveryClass: string
}
```

每次 Context transaction 提交 `ContextChanged` outbox event。Attention reconciler 以 employee revision + ContextGraph 纯计算
完整 desired set，再与 Event Center actual set 幂等 diff。subscription identity 至少绑定
`case + rule revision + source context + event type + subject`，重复 reconcile 不产生重复订阅；Context terminal/解绑或规则
不再匹配时取消。不能把订阅创建写成某个 Reaction 的不可恢复尾调用。

新订阅创建成功只表示 durable desired/actual state 已落库；ObserverActivation 异步启动。首次 baseline observation 是
订阅合同的一部分，保证创建订阅前丢失的 Webhook 不造成永久漏看。

### 0A.5 Event Center contracts

```ts
interface EventTypeDefinitionV1 {
  readonly eventTypeId: string
  readonly version: number
  readonly subjectTypeId: string
  readonly payloadSchemaId: string
  readonly displayNameKey: string
  readonly descriptionKey: string
  readonly localizationBundleRef: VersionedResourceRef
}

interface EventSourceDefinitionV1 {
  readonly sourceRef: VersionedResourceRef
  readonly eventTypeRefs: readonly EventTypeRef[]
  readonly mode: 'push' | 'poll' | 'hybrid' | 'stream'
  readonly observerScriptRef: VersionedResourceRef | null
  readonly observationProfiles: readonly VersionedResourceRef[]
  readonly supportsBatchSubjects: boolean
}

type EventSubscriptionV1 = ExactEventSubscriptionV1 | FilteredEventSubscriptionV1

interface ExactEventSubscriptionV1 {
  readonly subscriptionId: string
  readonly mode: 'exact'
  readonly subscriberRef: EventSubscriberRef
  readonly eventTypeRef: EventTypeRef
  readonly subjectRef: string
  readonly subscriptionCauseRef: string
  readonly state: 'active' | 'cancelled'
  readonly activationEpoch: number
}

interface FilteredEventSubscriptionV1 {
  readonly subscriptionId: string
  readonly mode: 'filtered'
  readonly subscriberRef: EventSubscriberRef
  readonly eventTypeRefs: readonly EventTypeRef[]
  readonly selectorRef: VersionedSelectorRef
  readonly subscriptionCauseRef: string
  readonly state: 'active' | 'paused' | 'invalid'
  readonly definitionRevision: string
}

interface EventRecordV1 {
  readonly eventId: string
  readonly eventTypeRef: EventTypeRef
  readonly subjectRef: string
  readonly sourceRef: VersionedResourceRef
  readonly sourceEventKey: string
  readonly sourceRevision: string
  readonly occurredAt: string
  readonly observedAt: string
  readonly payloadRef: ArtifactRef | null
  readonly summary: unknown // exact event codec
}

interface EventDeliveryV1 {
  readonly deliveryId: string
  readonly eventRef: EventRef
  readonly subscriptionRef: EventSubscriptionRef
  readonly subscriberRef: EventSubscriberRef
  readonly state: 'pending' | 'claimed' | 'accepted' | 'dead-letter'
  readonly deliveryClass: string
  readonly createdAt: string
}
```

EventRecord 没有也不得增加全局 `consumed` 状态。一次 Event publish 在同一事务中为每个命中的 Subscription 创建一条
`(eventId, subscriptionId)` 唯一的 Delivery；两个订阅者可以同时看到同一个 `eventId`，但必须拥有不同的 `deliveryId`。
claim、ACK、lease 过期、重试和死信只更新该 `deliveryId`，任何消费者都无权删除 EventRecord 或结算其他 Subscription 的
Delivery。EventRecord 与已结算 Delivery 作为审计事实按统一保留策略清理，不能因“第一个消费者处理完了”即时丢弃。

`sourceEventKey + sourceRevision` 在同一 source/subject/type 下唯一，使 Webhook 重放与 hybrid poll 去重。Event Center 只做
schema validation、identity、dedupe、subscription fan-out 与 delivery lifecycle，不解释“review 比 pipeline 优先”等员工
业务语义。

`EventSubscriberRef` 与 `subscriptionCauseRef` 是 Event Center 铸造的 opaque string refs；Event Center 不 import
`EmployeeCaseRef` 或 `ContextRevisionRef`。digital-employee adapter 把 Case/Attention 来源编码为 opaque subscriber/cause，
并在自己的 owner 内保存可逆绑定。

transport Delivery 提交后通过 outbox 至少一次发布。digital-employee 以 `deliveryId` 为唯一键幂等接收，创建自己的
`CaseInboxItem` 后回 ack；Event Center 的 Delivery 只记录传输是否被订阅者接收，不承担员工优先级、coalesce、obsolete
或 Reaction settle 语义。

`exact` 订阅的 subject 可枚举，因此同时参与 ObserverActivation 引用计数；`filtered` 订阅只在 Publisher 已提交 Event 后由
注册的 strict selector codec 匹配，不凭通配符臆造轮询 subjects。selector 只能读取该 Event Type 暴露的 bounded routing facts，
不能执行脚本、访问网络或选择动作。匹配与 EventRecord/Delivery 创建在同一事务边界内完成；subscriber adapter 以 durable
Delivery 驱动，WebSocket 只发 revision invalidation，不能替代业务投递。

代码平台只注册一个逻辑来源 `code-host.activity@1`，`observationMode=hybrid`。Webhook ingress 完成验签、provider normalize 与
原始审计行后调用 Event Center publish；主动 Observer 在 exact Attention 存在时补齐权威 MR 状态。两者观察到同一业务事实时
发布同一公开 Event Type，并用 provider revision/事实 digest 去重，不能把 transport 名写进公开类型体系。现有 trigger 行通过
integration-owned directory 投影为 filtered Subscription，稳定 trigger id 保持不变；它依赖的历史 normalized occurrence matrix
注册为 `catalogVisibility=compatibility`，仍可路由但不出现在公共目录或标准响应规则。命中后 `automation` subscriber adapter
复用现有 fire 实现；Event Center 不 import webhook 表、provider payload 或任务启动服务。

公开代码平台类型使用 `code-host.branch.* / merge-request.* / pipeline.* / issue.*` 的业务事实命名，并声明
`trigger.code_host.*` 输入合同；每次已验签推送同时发布一条 public business fact 与一条仅供存量 selector 的 compatibility
occurrence。数字员工主动观察器产生的 review/lifecycle/conflict snapshot 与周期性 gate recheck 是已有 Case 的 attention signal，
注册为 `catalogVisibility=internal`。`public`、`internal`、`compatibility` 三者都能在 Event Center 内部路由，但只有 public 且
声明 TriggerParameterContract 的类型进入事件总目录和新增响应规则，避免把“MR 状态观察”误当成用户可配置的第二种 Webhook。

`0198` 同时承担存量收敛：把已登记的 `development.work-received@1`、MR snapshot、协同和审批 wake-up 标为 internal；
将活跃 MR exact Subscription、Attention binding 和 ObserverActivation 迁到 `code-host.activity` 及新 exact event revision。
旧协同/审批 revision 保持不可变并继续服务已冻结 Case；owner 旁路发布新的
`platform.employee-invocation.result-returned@1`、`approval.status.changed@1` public fact。Catalog 在过滤 public Event Type 后
反向过滤 Source，因此内部历史来源不会显示为空目录。迁移和启动注册分别有回归，禁止通过放宽 immutable digest 偷换修订内容。

原 `WebhookDelivery.status` 降级为 ingress/routing audit：至少产生一条 EventDelivery 或接收一个 MR terminal control effect 时为
`matched`，没有任何响应时为 `ignored`；它不再表示某个消费者的成功或失败。每条规则的传输状态只看 EventDelivery，业务结果继续
看 `WebhookTriggerFire`。subscriber adapter 禁止修改共享 WebhookDelivery，否则一个失败规则会污染同一 Event 的其他规则。
Webhook Event identity 优先使用 `endpointId + provider delivery UUID`，没有 UUID 时才回退原始行 ID；显式平台 replay 清空 UUID，
因此仍形成新 occurrence。Event Center publish 失败必须把原始行置为 `failed` 以释放 UUID；publish 已提交但 HTTP 响应丢失时，
重投只会重新观察同一 Event 并唤醒未结算 Delivery，不会再次启动已接受的工作。

内部可订阅事件通过拥有者的 committed domain event/outbox 接入，不要求 Observer。不是所有模块私有事件都自动注册；
只有 type package 或公共 owner 显式发布的稳定 Event Type 才进入 Event Center。

automation Delivery 进入统一 `WorkStart` participant。其目标是 `orchestration | digital-employee` 的封闭联合：前者继续走既有
Workflow/Agent/Workgroup Task execution，后者按已发布员工的 `WorkIntakeContract` 创建 EmployeeCase。两者都冻结
`eventSubscriptionId + eventDeliveryId + TriggerContext`，并以 `eventDeliveryId` 幂等；Event Center 不根据 event name 猜目标，
也不 import 两个运行时。Task 状态和 EmployeeCase 状态由各自 owner 在状态事务中写 publication outbox，再由 worker 发布为
稳定 lifecycle Event；员工拉起另一个员工、等待子任务或审批时只订阅这些公开事实，不持有进程等待和不调用内存回调。

Event Type publish 必须验证产品支持 locale 的显示名与说明均可解析，并定义 fallback locale。`eventTypeId` 只用于合同、日志检索和
技术详情；业务画布、任务活动和队列默认只显示本地化名称与说明。Event 文案回答“已经发生了什么”，工作项文案回答“员工接下来做什么”。
`WorkStart`/“受理工作”属于命令，不注册 `work.accept` 或“收到新工作”事件；类型包通过 `workStartWorkItemRef` 直接确定首个工作项。

### 0A.6 ObserverActivation 与短执行 Script

```ts
interface ObserverActivationV1 {
  readonly activationId: string
  readonly sourceRef: VersionedResourceRef
  readonly connectionRef: VersionedResourceRef
  readonly observationScopeKey: string
  readonly observationProfileRef: VersionedResourceRef
  readonly leaseEpoch: number
  readonly cursorRef: ArtifactRef | null
  readonly nextRunAt: string | null
  readonly state: 'active' | 'draining' | 'stopped' | 'degraded'
}

interface ObserverInputEnvelopeV1 {
  readonly activationRef: ObserverActivationRef
  readonly subjects: readonly string[]
  readonly cursorRef: ArtifactRef | null
  readonly connectionRef: VersionedResourceRef
  readonly deadlineAt: string
  readonly artifactDirectory: string
}

interface ObserverOutputEnvelopeV1 {
  readonly observations: readonly ObservationEnvelopeV1[]
  readonly nextCursorRef: ArtifactRef | null
  readonly sourceWatermark: string | null
  readonly observedAt: string
}
```

Activation key 为 `source + connection + observation scope + profile`，有效 subscriptions 引用数从实际订阅推导而非作为
第二事实源。0→1 激活；1→0 进入 draining 并停止未来调度。默认执行模型是通过现有 Script NodeExecutor 启动一次短
Run，而非长驻进程：Run 结束后按仍有效订阅和 backoff 计算 nextRunAt。服务重启按 durable lease/cursor 恢复；迟到输出
必须以 activation epoch 和当前 subscription state 重新校验后再 fan-out。

Observer 只产 Observation，不修改 Context、不启动 Agent、不选择 Reaction、不做 Git/代码平台副作用。流水线完整日志
等大材料由 evidence collector materialize 到 `.agent-workflow/pipeline/<bundleId>`；Observer 可返回 artifact ref，但不得
把大正文塞入 Event summary。

#### 0A.6.1 全局自定义 Event Source authoring

Event Center 是独立 bounded context 和全局产品入口，不归属任何 Employee Type。它的消费者可以是
`employee-case | employee-invocation | system`，后续可以追加 workflow/webhook 等 subscriber codec，而不修改 Event Source。
数字员工配置页不得承载来源创作，只展示由 Attention 产生的订阅投影并跳转到全局 `/events`；来源目录、草稿、发布、退役、
订阅和观察器健康都在“运行与仓库 → 事件中心”。HTTP 权限使用 `event-sources:*`，不能借用 `digital-employees:*`。

```ts
interface CustomEventSourceDraftV1 {
  readonly schemaVersion: 1
  readonly displayName: LocalizedText
  readonly description: LocalizedText
  readonly pollIntervalMs: number
  readonly batchSize: number
  readonly ingestionMode: 'state-change' | 'occurrence'
  readonly program: {
    readonly language: 'bash' | 'node' | 'python'
    readonly source: string
    readonly timeoutMs: number
  }
  readonly eventTypes: readonly {
    readonly eventKey: MachineId
    readonly subjectTypeId: MachineId
    readonly payloadSchemaId: MachineId
    readonly displayName: LocalizedText
    readonly description: LocalizedText
    readonly deliveryClass: MachineId
  }[]
  readonly fixture: {
    readonly subjects: readonly {
      readonly typeId: MachineId
      readonly subjectRef: string
    }[]
    readonly cursorJson: string | null
  }
}

interface CustomObserverInputEnvelopeV1 {
  readonly protocol: 'aw-event-observer@1'
  readonly sourceRef: VersionedResourceRef
  readonly subjects: readonly { readonly typeId: MachineId; readonly subjectRef: string }[]
  readonly cursor: unknown | null
  readonly deadlineAt: string
}

interface CustomObserverOutputEnvelopeV1 {
  readonly protocol: 'aw-event-observer@1'
  readonly cursor: unknown | null
  readonly observations: readonly {
    readonly eventKey: MachineId
    readonly subjectRef: string
    readonly occurredAt: string
    readonly sourceEventKey: string
    readonly sourceEventRevision: string
    readonly summary: string
    readonly payloadArtifactRef?: string | null
  }[]
}
```

平台把 input envelope 写入 `AW_EVENT_INPUT_FILE` 指向的临时只读文件；stdout 必须只含一个 strict JSON output envelope，stderr
仅作为诊断现场。Script 不接收数据库句柄、订阅者、Event Type exact ref 或写入 API。平台按当前 source revision 的
`eventKey → exact EventTypeRef` 闭集映射补全 source/type/subject type：未知 event key、batch 外 subject、超预算输出、非法 cursor
或跨来源声明均视为 contract violation，并由 Case pin 的限额快照决定重试。`state-change` 使用
`eventKey + subject + sourceEventKey + sourceEventRevision` 去重；`occurrence` 语义要求 `sourceEventRevision` 为来源侧稳定 occurrence id，
同一 occurrence 重放仍只入库一次。两种模式都由 Event Center 生成最终 dedupe key，Script 无权自报数据库 identity。

稳定 authoring identity 是 `sourceId`，每次发布形成 immutable `{sourceId, revision}`，并为当次 event key 生成 exact
`{eventTypeId, revision}`。发布原子地冻结 Script/合同/fixture receipt 并注册 Source/Event Types；编辑只更新同一 sourceId 的
草稿，不能在校验失败后 POST 出第二个同名资源。发布校验必须执行与生产相同的 Script adapter、同一 input/output codec；
只做静态 JSON 校验不构成可发布 receipt。退役阻止新订阅和新 revision，但历史 exact refs、运行记录与已 pin 订阅仍可审计，
在最后一个订阅取消前不能物理删除。

### 0A.7 EmployeeCase queue 与 ReactionRound

```ts
interface CaseInboxItemV1 {
  readonly caseId: string
  readonly deliveryRef: EventDeliveryRef
  readonly eventRef: EventRef
  readonly deliveryClass: string
  readonly state: 'pending' | 'claimed' | 'settled' | 'coalesced' | 'obsolete'
  readonly acceptedAt: string
}

interface ReactionRuleDefinition {
  readonly ruleId: string
  readonly eventTypeRef: EventTypeRef
  readonly requiredContextTypes: readonly string[]
  readonly predicates: readonly TypedFactPredicate[]
  readonly workItemRef: WorkItemRef
  readonly workContractRef: WorkContractRef
  readonly toolBindingSlotRef: ToolBindingSlotRef
  readonly allowedEffectKinds: readonly string[]
  readonly priority: number
  readonly preemptsContinuation: boolean
}

interface ReactionRoundV1 {
  readonly roundId: string
  readonly caseRef: EmployeeCaseRevisionRef
  readonly deliveryRef: EventDeliveryRef
  readonly employeeRef: VersionedResourceRef
  readonly ruleRef: VersionedRuleRef
  readonly workItemRef: WorkItemRef
  readonly selectedToolRegistrationRef: VersionedResourceRef
  readonly executionPolicyRef: VersionedResourceRef
  readonly inputContextRefs: readonly ContextRevisionRef[]
  readonly state: 'planned' | 'running' | 'settling' | 'completed' | 'failed' | 'obsolete'
  readonly executionRef: TaskExecutionRef | null
  readonly outputContextRefs: readonly ContextRevisionRef[]
}
```

首版每 Case 单 active round；cross-case 并行受员工/平台额度控制。同一输入快照在 Round 内不可变，新 Delivery 只进入下一轮。
队列排序由 pinned type package 的事件优先级规则纯计算，稳定 tie-breaker 至少含业务 priority、occurredAt、eventId。业务用户
不能在员工实例中重排规则。普通事件不抢占已运行
Round；merged/closed 等 terminal observation 在任何新写 Effect dispatch 前由事实刷新建立 transition fence。

队列在每次 pending/coalesced/obsolete/claimed/settled commit 后发布 revision-only invalidation，任务页重取统一 projection，展示
当前 Round 与重新排序后的后续待办。新高优先级 Delivery 只影响下一次 claim，不修改 active Round 的 frozen input；terminal
delivery 通过 transition fence 在下一次外部写前优先结算，而不是粗暴杀死结果未知的 Effect。

Event 是“为什么醒来”，不是当前事实。Reaction planner 必须先按 type package collector 取得同一 logical snapshot，再用
typed rules 判断 Event 是否仍适用；过时 delivery 标 obsolete，不把 stale webhook payload 当事实。

### 0A.8 EmployeeInvocation、Channel 与 Join

```ts
interface EmployeeInvocationV1 {
  readonly invocationId: string
  readonly parentCaseRef: EmployeeCaseRef
  readonly parentRoundRef: ReactionRoundRef
  readonly targetEmployeeRef: VersionedResourceRef
  readonly targetWorkScopeRef: EmployeeWorkScopeRef
  readonly inputEnvelopeRef: ArtifactRef
  readonly inputDigest: string
  readonly completionContractRef: VersionedResourceRef
  readonly deadlineAt: string
  readonly childCaseRef: EmployeeCaseRef | null
  readonly state: 'requested' | 'accepted' | 'waiting' | 'satisfied' | 'failed' | 'detached'
}

interface EmployeeChannelV1 {
  readonly channelId: string
  readonly invocationRef: EmployeeInvocationRef
  readonly parentCaseRef: EmployeeCaseRef
  readonly childCaseRef: EmployeeCaseRef
  readonly correlationRef: string
  readonly resultContractRef: VersionedResourceRef
}

interface EmployeeResultEnvelopeV1 {
  readonly invocationRef: EmployeeInvocationRef
  readonly childCaseRef: EmployeeCaseRef
  readonly milestoneType: string
  readonly childContextRefs: readonly ContextRevisionRef[]
  readonly artifactRefs: readonly ArtifactRef[]
  readonly externalReceiptRefs: readonly ArtifactRef[]
}
```

幂等键至少包含 `parent case + parent round/rule + target employee revision + target work scope + input digest`。父 Case 的
DelegationContext、invocation、channel intent 与 waiting transition 同事务提交；child creation 由 outbox 后置并按 key
create/adopt，不能出现父已等待但无可恢复 invocation。

目标员工可以 exact 指定，或由目标分类的 WorkScope assignment 规则解析；进入 invocation 前必须冻结唯一 revision，
无匹配/多匹配阻断。子 Case 接收 `employee.work.assigned` Event 并独立运行；父 Case 通过 AttentionRule 订阅 child 的公开
milestone/completed/blocked/failed Event。Result Envelope 校验 invocation、schema、child context revision 与 completion
predicate 后形成 receipt，再唤醒父 Case。

`ready-to-merge` 等可回退 milestone 的 receipt 必须绑定 exact child context revision/MR head，父执行外部 Effect 前重验；
`merged` 等单调终态可直接满足终态 completion contract。多 child join 由 OS 通用支持 `all | any | quorum(n)`、deadline、
partial/rejected/expired 分支。父 cancel/handoff 默认 detach，不擅自关闭 child MR；只有显式 propagation policy 才请求取消。

### 0A.9 执行与 Effect 边界

数字员工 OS 只生成并提交闭合 `ReactionExecutionPlan`，不实现 executor：

```ts
interface ReactionExecutionPlanV1 {
  readonly roundRef: ReactionRoundRef
  readonly inputContextRefs: readonly ContextRevisionRef[]
  readonly triggeringEventRef: EventRef
  readonly workItemRef: WorkItemRef
  readonly workContractRef: WorkContractRef
  readonly toolRegistrationRef: VersionedResourceRef
  readonly implementationRef: VersionedResourceRef // Agent/Workflow ref；Program 使用 registration revision 本身
  readonly inputSchemaId: string // copied from exact WorkContract revision
  readonly outputSchemaId: string // copied from exact WorkContract revision
  readonly semanticValidatorId: string // copied from exact WorkContract revision
  readonly executionPolicyRef: VersionedResourceRef // global policy pinned by Case
  readonly allowedEffectKinds: readonly string[]
}
```

- Agent 与 Script 都经现有 Envelope、nonce/schema/semantic validator、same-scene/fresh-scene ledger 和唯一
  TaskEngine→WrapperRuntime→NodeExecutor→ExecutionKernel 路径；
- Agent 可编辑合同允许的业务文件但不得修改 Git、commit/push、调用代码平台、调用员工或选择下一动作；
- Script 也必须输出 exact Envelope；Observer/collector/validator/确定性 handler 都是 Script 的受限用途；
- Workflow 只是现有节点组合；OS 不复制 Workflow executor；
- workspace diff/candidate/commit/CAS push 走 `source-control`；
- MR/pipeline/comment 等读写形成 closed `CodeHostCallIntent`，由 `integration` 使用已有 repository binding、Connection 与
  Token registry 执行并返回 idempotent Receipt。Token 不进入 Context、Event 或 Agent/Script Envelope；
- `merge`/`approve` 即使存在于底层平台，也不进入代码员工 allowed effect closure。

模型输出不承诺字节确定；系统承诺 tool selection、input snapshot、output contract、validator、retry/fallback 与外部
Effect closure 由 frozen type rule + exact tool registration + Case execution policy 唯一决定。Agent/Script 产出的 Context patch/effect suggestion 在 owner validator 铸成 receipt
前均不是事实，也不能直接修改 Context。

### 0A.10 事务、恢复与投影不变量

1. Context mutation、case revision、domain event 与 attention-reconcile outbox 同事务提交；
2. Event Record 与 fan-out delivery 同一 owner transaction，重复 observation 不重复 delivery；
3. committed Delivery 至少一次送达；digital-employee 按 deliveryId 幂等创建 CaseInboxItem，再在本 owner transaction 内
   claim inbox item + 创建 ReactionRound，并用 expected case revision/lease epoch 保证同 Case 单 active round；
4. execution settle、validated receipt、Context patch intent 与 Effect intent 先持久化，外部调用在事务外执行并可查询 adopt；
5. Effect receipt 回写后才更新 Context；崩溃恢复不凭“本地未确认”推断“外部未发生”；
6. subscription/activation/channel 都是 durable aggregate，服务重启不依赖内存 Map；
7. WS/UI 只消费 committed projection：员工当前 Context、正在关注什么、Event Queue、Reaction Round、child channel 与
   下一步必须同页可见；
8. terminal fence 先停止新写，再结算已 dispatch Effect，最后取消关注、释放 workspace/claim；代码员工永不自动 merge。

### 0A.11 从当前 RFC-310 实现迁移

当前已交付实现是迁移输入，不是删除后重写：

| 当前实现                                                                | 迁移目标                                                                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `DevelopmentMission`                                                    | 映射/迁移为 code employee `EmployeeCase` + typed Context Graph；保留外部 identity/provenance     |
| `development_wake_hints`                                                | 迁入 EventRecord/Subscription/Delivery；不再只消费 count                                         |
| `resumeAt`、approval/step `pollIntervalMs`                              | 迁入 Event Source + ObserverActivation；Mission 不驱动专用轮询                                   |
| `EmployeePlaybookContentV1.steps/onSuccess`                             | 编译/迁移成 fixed lifecycle background 上的 AttentionRule/ReactionRule；无法机械映射显式 blocked |
| `ChildMissionIntent/Receipt`、mission link/join                         | 提升为 OS 级 EmployeeInvocation/Channel/Join，并保留 idempotency/provenance                      |
| `mrCareChain`、pipeline evidence、feedback ledger                       | 保留为代码员工 collectors/reaction handlers，改由标准 Event Delivery 唤醒                        |
| AgentAttempt、script executor、candidate/commit/publish、code-host call | 原样复用执行与 Effect 底座，不造第二套 runtime/Token/Git                                         |

迁移必须先双读验证/影子投影，再按 Case writer generation 单切；不能让旧 Mission reconciler 与新 Reaction Engine 同时写
同一 MR。RFC-294 的 bounded-context 清单、依赖棘轮和 composition inventory 必须先更新并获批，之后才能实现生产代码。

### 0A.12 Authoring manifest 与运行投影

Employee Type Package 还必须注册一个只描述业务布局、不承载执行决定的 `EmployeeAuthoringManifestV1`：

```ts
interface ToolRoleGroupV1 {
  readonly roleRef: ToolRoleRef
  readonly labelKey: string
  readonly descriptionKey: string
  readonly order: number
  readonly bindingSlots: readonly {
    readonly slotRef: ToolBindingSlotRef
    readonly labelKey: string
    readonly required: boolean
    readonly cardinality: 'exactly-one' | 'zero-or-one'
  }[]
}

interface EmployeeAuthoringManifestV1 {
  readonly lifecycleRegions: readonly {
    readonly regionId: string
    readonly labelKey: string
    readonly descriptionKey: string
    readonly order: number
    readonly responsibilityLanes: readonly {
      readonly laneId: string
      readonly labelKey: string
      readonly descriptionKey: string
      readonly order: number
      readonly kind: 'spine' | 'branch'
    }[]
  }[]
  readonly workItems: readonly {
    readonly workItemRef: WorkItemRef
    readonly regionId: string
    readonly responsibilityLaneId: string | null
    readonly order: number
    readonly labelKey: string
    readonly descriptionKey: string
    readonly workContractRef: WorkContractRef
    readonly materialSummaryKey: string
    readonly completionStandardKey: string
    readonly nodeKind: 'business-tool' | 'system' | 'collaboration'
    readonly toolRoleGroups: readonly ToolRoleGroupV1[]
    readonly nextWorkItemRefs: readonly WorkItemRef[]
  }[]
}
```

画布拓扑从 manifest + employee definition 纯投影：生命周期 region 固定、工作项位置固定、全量展开，不提供 edge drag、
stage selector 或任意 topology mutation。阶段只作为背景 region；每个 region 可声明一条 `spine` 主干与多条 `branch` 职责泳道，
泳道 identity/order 在类型包发布时冻结。有泳道的 region 中，每个工作项必须且只能引用该 region 的一个 lane；重复 lane、缺失归属、
跨 region 引用或未知 `nextWorkItemRefs` 均阻断发布。工作项是唯一可点击配置节点。业务工具节点只允许从当前分类、
当前工作项、exact WorkContract 下的已发布工具注册中选择；系统节点只读，协作节点进入 EmployeeInvocation 配置。Event、closed
predicate、Context mapping、Effect 与 failure/retry policy 都由类型包编译，不出现在员工实例编辑器。前端通用组件不得按
`development` 类型分支，类型差异只能来自 manifest 和注册的业务文案/codec。

布局算法同样属于通用 manifest 投影，不属于研发页面特例：`spine` 节点在内容区居中；每条 `branch` 独占一行或多行，节点按
`order` 从左到右展开；`nextWorkItemRefs` 的同泳道前向边直接连接，事件主干到多条支线先汇入一条共享分发干线再短接各支线，其他
跨泳道或跨 region 的前向边走右侧过渡通道；指向更早工作项或更早 region 的边统一进入右侧 gutter 并以虚线表示回路，同节点回路从卡片上方
回入，表达“按固定优先级继续处理下一类型”。画布给定显式 width/height/viewBox，桌面默认全量展开，窄屏只由外壳横向滚动，
不得为了适配宽度把支线重新平铺成一个无法辨认前后关系的序列。

运行投影至少提供：

```ts
interface EmployeeCaseRuntimeProjectionV1 {
  readonly caseRef: EmployeeCaseRevisionRef
  readonly contexts: readonly ContextSummary[]
  readonly attention: readonly SubscriptionSummary[]
  readonly inbox: readonly CaseInboxSummary[]
  readonly activeRound: ReactionRoundSummary | null
  readonly observerHealth: readonly ObserverHealthSummary[]
  readonly channels: readonly EmployeeChannelSummary[]
  readonly deliverables: readonly DeliverableSummary[]
  readonly nextAction: JourneyNextAction | null
}
```

`/tasks` 统一承载 Case/Reaction 的实际运行；员工定义页只负责能力构建。所有状态和下一动作同页可见，不使用机械返回按钮。
Event Center 另提供 event catalog/source/subscription/observer health 投影；业务 author 看到事件业务名和主动/被动/混合观察
方式，只有具备技术权限者能展开 Script/Connection/provider revision。

### 0A.13 分类工具箱、工作合同与共享限额快照

产品层级固定为：`数字员工 → 数字员工分类 → 工作项 → 工具`。技术对象如下：

```ts
interface WorkContractV1 {
  readonly workContractId: string
  readonly version: number
  readonly inputSchemaId: string
  readonly outputSchemaId: string
  readonly materialSummaryKey: string
  readonly completionStandardKey: string
  readonly allowedToolKinds: readonly ('agent' | 'workflow' | 'program')[]
  readonly allowedEffectKinds: readonly string[]
  readonly semanticValidatorId: string
  readonly fixtureSuiteRef: VersionedResourceRef
}

interface TypeToolRegistrationV1 {
  readonly registrationRef: VersionedResourceRef
  readonly employeeTypeRef: VersionedResourceRef
  readonly workItemRef: WorkItemRef
  readonly workContractRef: WorkContractRef
  readonly roleRef: ToolRoleRef // 类型包闭集定义，例如研发类型的 recognizer / repairer
  readonly displayName: string
  readonly description: string
  readonly implementation:
    | { readonly kind: 'agent'; readonly agentRef: VersionedResourceRef }
    | { readonly kind: 'workflow'; readonly workflowRef: VersionedResourceRef }
    | {
        readonly kind: 'program'
        readonly runtimeKind: 'shell' | 'node' | 'python'
        readonly executableArtifactRef: ArtifactRef
        readonly executableDigest: string
        readonly parameterValuesRef: ArtifactRef | null
        readonly runtimeProfileRef: VersionedResourceRef
      }
  readonly connectionRef: VersionedResourceRef | null
  readonly validationReceiptRef: ArtifactRef
  readonly state: 'draft' | 'published' | 'retired'
}

interface WorkItemToolBinding {
  readonly workItemRef: WorkItemRef
  readonly slotRef: ToolBindingSlotRef
  readonly registrationRef: VersionedResourceRef
}

interface ExecutionPolicyRevisionV1 {
  readonly policyRef: VersionedResourceRef
  readonly sameSceneAttempts: number
  readonly freshSceneAttempts: number
  readonly limitsDigest: string
  readonly platformContractVersion: number
}
```

`digital-employee` 拥有 `TypeToolRegistration`、ProgramTool 程序规范和员工工具绑定；Agent/Workflow 的 definition、ACL 与
revision 继续由 resource-catalog typed owner 拥有，Adapter/Connection/Token 继续由 integration 拥有。Agent/Workflow 注册发布
时通过 required port 读取 exact resource projection；ProgramTool 发布 executable/参数字段额外要求 `scripts:author`，程序内容
进入 immutable artifact 并只由既有 Script executor 消费。三种工具都运行 WorkContract fixture 并持久化 validation receipt；
底层资源更新不会原地改变注册，必须新建 registration revision。一个实现注册到不同工作项时分别验证。

验证器按工具种类展开真实执行闭包：Agent 必须支持 exact envelope/runtime profile；Workflow 的所有可达节点、输出口和 effect
必须被 WorkContract closure 覆盖，不能只看工作流名称；ProgramTool 必须在 Script executor fixture 上产出 exact envelope。验证失败
返回工作项、role、slot、资源 revision 和不相容原因，UI 直接显示在节点工具列表，不能等首个 Case 才暴露。

工具箱查询以 `(employeeTypeRef, workItemRef, workContractRef)` 为必填闭合键，禁止无工作项的全局查询作为员工选择器后端。
建议 public API：

```text
GET  /api/digital-employee-types
GET  /api/digital-employee-types/:typeRef/authoring-manifest
GET  /api/digital-employee-types/:typeRef/work-items/:workItemRef/tools
POST /api/digital-employee-types/:typeRef/work-items/:workItemRef/tools
POST /api/digital-employee-types/:typeRef/work-items/:workItemRef/tools/:registrationRef/validate
POST /api/digital-employee-types/:typeRef/work-items/:workItemRef/tools/:registrationRef/publish
GET  /api/settings/config                  # existing Limits owner
```

创建工具注册的 URL 已提供 type/work item，服务端从 manifest 解析 exact WorkContract；请求体重复提交不同的 type、work item 或
contract 一律拒绝，避免前端隐藏字段漂移。工作项为 `system` 时 POST 固定返回 typed 4xx。员工发布编译器只接受当前分类下
`published` 且合同相容的 registration；岗位模板和员工覆盖都引用 registration revision，不直接引用底层 executor。

`roleRef` 与 `slotRef` 均是类型包闭集：工具注册必须选择当前工作项存在的 role；岗位模板/员工绑定必须选择该 role 下存在的 slot。
普通工作项通常只有一个 `primary/default` slot；研发“处理流水线”可在“问题识别”role 下声明识别 slot，并在“问题修复”role 下按
compile/unit-test/static-analysis 等问题类型声明多个业务化 slot。ReactionRule 直接引用 slot，用户只为槽位选工具，不编写
`problem type → tool` predicate。required slot 缺失、同 slot 多绑定或 registration role 不符均在 publish 拒绝。

重试次数不新增数字员工设置入口。Case admission 从现有 Limits 读取 `defaultNodeRetries` 与 `sessionRestartBudget`，按内容 digest
幂等取得内部 `ExecutionPolicyRevision` 并 pin；Reaction、tool registration、job template 和 employee definition 都没有 retry
字段。固定 backoff/deadline 属于平台合同，不形成第二份可编辑策略；管理员修改 Limits 也不能静默改变正在看护 MR 的 Case。

版本与退役规则固定如下：Type Package 或 WorkContract 升版不会继承旧 registration 的兼容性；新分类 revision 必须生成新的
registration validation receipt，再发布对应岗位模板/员工 revision。`retired` registration 不出现在 picker，也阻断引用它的新
员工发布和新 Case admission；已经 active 的 Case 保留 frozen registration，在底层 exact resource 仍可解析且 authority 有效时继续，
不可用则进入具名 dependency block，禁止自动换同名工具。Agent/Workflow archive、ACL/Connection 变化在 readiness/admission 与每轮
freeze 重验；任何替换都经 employee/Case upgrade preview/apply，不做名字匹配 fallback。

### 0A.14 平台执行契约

`WorkContract` 属于员工类型的业务职责合同；`ExecutionContract` 是所有上层能力复用的执行器中立机制。后者由独立
`execution-contract` bounded context 唯一实现，`digital-employee` 只 pin/调用 exact contract participant，
`development-automation` 只注册研发 schema guide，不复制输入注入、输出解析或 executor 探测代码。
`DigitalEmployeeAuthoringService`、`DigitalEmployeeRuntimeService` 与 TaskExecution reaction host 的 production composition
都必须注入该 participant；不存在 optional participant、按类型回退或旧 resource/fixture 校验旁路。测试替身也只能实现同一
participant，而不能触发另一套生产算法。

```ts
interface ExecutionContractGuideV1 {
  readonly schemaVersion: 1
  readonly contractRef: { readonly contractId: string; readonly version: number }
  readonly displayName: LocalizedText
  readonly description: LocalizedText
  readonly input: ExecutionContractSchemaGuide
  readonly output: ExecutionContractSchemaGuide
  readonly allowedExecutorKinds: readonly ('agent' | 'workflow' | 'program')[]
  readonly transports: {
    readonly agent: ExecutionTransportGuide | null
    readonly workflow: ExecutionTransportGuide | null
    readonly program: ExecutionTransportGuide | null
  }
}

interface ExecutionContractValidationReceiptV1 {
  readonly schemaVersion: 1
  readonly contractRef: ExecutionContractRef
  readonly status: 'valid' | 'invalid'
  readonly checks: readonly {
    readonly code: string
    readonly ok: boolean
    readonly detail: string
  }[]
}
```

完整 `ExecutionContractGuideV1` 是 `execution-contract` 内部注册/校验模型，不作为跨 context mega DTO 展开。类型包注册
`{contractRef, guideJson}`，平台先 strict parse 并对拍 ref；公共 participant 的 list/get 只返回小型
`ExecutionContractRuntimeView`（显示摘要、schema id、允许执行器、输出字段闭集及只读 `guideJson`）。列表 API 返回摘要，exact
guide API 直接返回平台已校验的序列化指南；运行消费者只取得构造 prompt 所需的最小投影。这样既保持字段指南完整，又满足
RFC-294 的公共合同叶字段上限，调用方不能把内部 guide 当业务写模型传播。

`ExecutionContractSchemaGuide` 固定 schema id、业务化字段说明、字段来源、required/condition、top-level field 闭集和 JSON 示例。
它是可读指南和机械校验合同，不是开放 JSON Schema 编辑器；业务用户不能在工具表单改写。平台 API 提供 list/exact guide，Agent
候选查询对当前可见 exact revision 批量返回 validation receipt，前端据此禁用不兼容项而不是硬编码研发 Agent 名称。

三种 executor 的发布门固定为：

1. **Agent**：exact revision 必须存在、可用、声明实现 exact `ExecutionContractRef`，并有固定 `agent-result` 输出口。契约选择器
   与输入/输出端口同页；只要存在声明，保存层就把该端口规范化为唯一、无 kind/wrapper/branch sidecar 的契约托管端口，UI 不提供
   编辑/删除动作。取消最后一个声明时同一写入删除该端口及 sidecar；create/update/bundle/intent 都进入同一规整命令。兼容期内置
   Agent 的隐式声明只能由对应类型包提供 migration callback，通用模块不得出现 `development` literal；新建 Agent 直接保存显式声明。
2. **Workflow**：必须有平台规定的文本输入、无额外 required input、只包含合同允许的节点种类，并能闭合输出 `agent-result`；代码平台
   Effect 等越出合同 closure 的节点在发布前拒绝。
3. **Program**：平台以真实 Script runner、runtime profile、exact executable digest 和参数 artifact 运行合同示例；只有 stdout
   产生合法 exact output 才得到 valid receipt。编辑器提供 Bash/Node/Python 起始代码，但保留 `TODO_IMPLEMENT_CONTRACT` 时禁止加入工具箱。

运行输入统一为完整 envelope，其中 `roundRef`、`executionNonce`、`workItemRef`、`toolSlotRef`、schema ids、Context/Event/artifact refs
和业务 `contractInput` 都是一级确定字段。外部需求/问题 ID 直接投影到 `contractInput.workRequest.externalId`；流水线合同直接给 MR
head/connection 和 `.agent-workflow/pipeline/<bundleId>` artifact ref。Agent prompt 由平台构造并在末尾放完整 JSON；Program 的小输入
注入 `AW_PORT_CONTRACT_INPUT`，超过 Script port 阈值时由既有 runner spill 后只注入 `AW_PORT_FILE_CONTRACT_INPUT`。

类型包组装输入后、冻结 ReactionPlan 前，平台先校验 input top-level 闭集、每个 top-level 字段都有可读字段指南、required/path/valueType
以及 `schemaVersion/roundRef/executionNonce`；失败时该轮不得进入执行器。输出只能是一个无 Markdown、无前后正文的 JSON object，
top-level keys 必须与 guide 完全相等，字段类型必须匹配，并逐轮对拍 `schemaVersion=1`、
`roundRef`、`executionNonce`、closed status 与非空 summary。平台 exact 校验通过后，再由员工类型包 semantic validator 检查
`contextPatches/effectSuggestions/artifactRefs` 的业务语义；两层均通过才可形成事实或 Effect intent。编辑发布 fixture 和运行结算调用
同一 participant 的 `validateEnvelope(input | output)`，错误原文进入同现场重试提示；重试次数仍只来自 Case pin 的限额快照。

## 0. 设计裁决与事实基线

### 0.1 一句话

新增并最终以 `development-automation` 取代 `code-capability` 上层业务模型：它拥有一条跨需求、实现、
MR 看护到外部合入的 `DevelopmentMission`，由 typed policy 解释器决定下一动作；Agent 只能在
TaskEngine 的受限执行环境中产生 envelope 和业务文件差异，Git、代码托管和流水线副作用仍由各自
bounded context 的确定性 participant 执行。

### 0.2 本设计钉住的基线

本轮源码核对钉在 `2bdfbd51d2e309e05088da958e835724cf904065`。实现前必须重新取锚；下表描述的是
设计输入，不是允许通过兼容层长期保留的目标形状。

| 当前事实                                                             | 源码锚点                                                              | 本 RFC 的处理                                                                      |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 五个固定 capability，其中 `mr-monitor` 也是 capability               | `modules/code-capability/domain/stageContract.ts:25-43`               | 用 Mission reconciler 取代 monitor capability，动作改为新的 closed catalog         |
| `StageDef` 允许任意 script 与可注入 hook                             | `stageContract.ts:72-155`                                             | stage graph 仍由代码固定，但业务决策脚本和任意写 hook 被收缩为 typed adapter point |
| envelope 已支持同会话与 fresh-session 两级尝试                       | `application/determinismGuard.ts:122-193`                             | 保留台账语义，并补 whole-workspace baseline 恢复与边界违规快退                     |
| MR collect 只有单 gate、`rawLogRef` 与 head                          | `domain/monitorContracts.ts:49-75`                                    | 改为 exact-head、多 gate、完整性明确的 evidence bundle                             |
| `arbitrate`/`select` 脚本可决定能力与 Agent                          | `domain/monitorContracts.ts:93-169`                                   | 删除脚本的业务决策权，由 typed first-match policy 唯一决定                         |
| requirement 文档正文直接进入 JSON                                    | `domain/requirementInput.ts:28-70`                                    | 改为 immutable multi-file bundle ref，不把大正文放入 DB/event/prompt               |
| code-host port 是 `action: string + Record<string,string>`           | `ports/codeHostPort.ts:22-37`                                         | 改为 closed development action union，类型层排除 merge/approve/resolve/custom      |
| source-control 已提供 path-free candidate/commit/publish participant | `modules/source-control/public/participants.ts:10-47`                 | 直接复用，不另造 Git 实现，也不把路径泄露给 Mission                                |
| Claude runtime 当前可写 Git metadata 且继承 daemon 环境              | `services/runtime/claudeCode/boundary.ts:107-115`、`spawn.ts:279-305` | digital-employee profile：不注入 Git identity/凭据，违规靠快照检测+回退（见 §7.6） |
| `.agent-workflow` 只有 `inputs/runs/fusion` 官方子目录               | `packages/shared/src/workspaceConvention.ts:5-18`                     | 增加 `pipeline`；需求固定在 `inputs/requirements`，两者都受 RFC-308 排除策略保护   |

### 0.3 不可协商的不变量

1. 同一 Mission/MR 同时最多一个拥有 workspace 写权的 `ActionRun`。
2. 同一 fact snapshot + policy revision 的规则结果 byte-identical；Agent 不参与调度或模板选择。
3. Agent 不持有代码托管/流水线凭据、不能直接产生外部副作用；对 Git metadata / evidence / 受保护路径的任何写入
   都是 boundary violation——首版靠前后快照检测并整树回退（非 OS 阻断），绝不进入 candidate。
4. Agent 的输出只是待验证声明；真实 diff、测试、head、gate、评论与 mergeability 均由程序采集。
5. `ready-to-merge` 可回退，`merged` 只能由外部事实观察产生；平台不存在 merge/approve action。
6. 跨 bounded context 只走 RFC-294 的 exact `public/*` 或 consumer-owned `required-ports`。
7. TaskEngine → WrapperRuntime → NodeExecutor → ExecutionKernel 是唯一 Agent 执行链。
8. 迁移不允许 legacy work-item writer 与 Mission writer 同时管理同一个 MR。
9. 直接上传文件的仓库目标路径、上传 digest 与基线前提一经 admission 即冻结；只有平台能把它加入业务改动，
   且非 `already-present` 的上传必须进入最终 ChangeCandidate/commit，不能退化成只读附件。

## 1. RFC-294 落位

本节以 [RFC-294 目标架构](../RFC-294-backend-layered-target-architecture/design.md) 为约束，不把 RFC-310 当成绕过现有
bounded context 的新总控层。

### 1.1 bounded context 职责

| Context                              | 唯一拥有                                                                                                                                                     | 明确不拥有                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `development-automation`             | Mission/ActionRun 状态机、数字员工 playbook/问题类型/规则编译、CapabilityDefinition、内部执行实现 revision、规则解释、readiness、反馈处理台账、effect intent | Git 实现、Agent/script spawn、code-host HTTP、pipeline provider 协议、credential、绝对路径 |
| `task-execution`                     | AgentAttempt/ScriptAttempt 的 Task/NodeRun 执行、session/runtime/取消、受限 workspace mount、唯一四级执行链                                                  | Mission 下一步、生产者/处理者选择、MR readiness、Git commit/push                           |
| `source-control`                     | repository/workspace、immutable snapshot、ChangeCandidate、exclude policy、commit、exact-head publish、conflict workspace 准备                               | 需求语义、review 规则、MR API、Agent session                                               |
| `integration`                        | requirement/pipeline/code-host provider 协议、连接与 credential、webhook ingress、outbound adapter execution                                                 | Mission 状态、policy 决策、Agent 选择、Git mutation                                        |
| `resource-catalog` / identity-access | 资源可见性、owner/ACL、request/effect authority                                                                                                              | 数字员工业务字段、Mission 状态转移                                                         |
| `platform/contracts`                 | clock/id/transaction/outbox/job/evidence-store 等中性机制                                                                                                    | 任何 Mission、MR、policy 或 capability DTO                                                 |

`development-automation` 是 RFC-304 `code-capability` 的语义替代和最终改名，不并存为第十五个 mega-context。
迁移期间可以保留一个只做调用转发的 legacy facade，但不得有状态、业务分支或第二套 writer，并在同一 cutover
wave 删除。

### 1.2 目标目录

```text
packages/backend/src/modules/development-automation/
  domain/
    mission.ts                  # aggregate + transition table
    actionRun.ts
    capabilityDefinition.ts
    actionTemplate.ts
    digitalEmployee.ts
    automationPolicy.ts
    facts.ts
    decision.ts
    readiness.ts
    agentProtocol.ts
    evidence.ts
  application/
    commands/
    queries/
    missionReconciler.ts
    decisionService.ts
    actionCoordinator.ts
    effectCoordinator.ts
  engine/
    policy/
      compilePolicy.ts
      evaluatePolicy.ts
      canonicalTrace.ts
    action/
      actionCatalog.ts
      capabilityPlans.ts
      semanticValidators.ts
  ports/                       # module-internal repository/clock/outbox ports
  infrastructure/
    sqlite/
    jobs/
    inbound/
  public/
    commands.ts
    queries.ts
    participants.ts
    events.ts
    types.ts
  composition/
    required-ports.ts          # consumer-owned external SPI
  composition.ts              # only bootstrap imports this entrypoint
```

`public/*` 只在出现真实跨 context consumer 时导出 symbol；不能为了“以后可能用”预放通用 CRUD。
HTTP/MCP/worker 都是 inbound adapter，调用同一 application command/query，不直接查询 Mission 表。

### 1.3 依赖方向

```mermaid
flowchart LR
  DA["development-automation application/engine"] --> IA["identity-access public participants"]
  DA --> RC["resource-catalog public participants"]
  DA --> SC["source-control public participants"]
  TEA["task-execution provider adapter"] --> RP["development-automation composition/required-ports"]
  INA["integration provider adapters"] --> RP
  COMP["development-automation composition.ts"] --> RP
  COMP --> DA
  IN["integration ingress adapter"] --> PUB["development-automation public participants/events/types"]
  PUB --> DA
  BOOT["bootstrap"] --> COMP
```

图中箭头表示源码依赖。关键点：

- `development-automation` 可以消费 source-control 已有的 offered participants，因为它们本来就是
  path-free candidate/commit/publish 合同。
- 需求系统、流水线系统、MR facts/effects 与 AgentAttempt 是本 context 的专用需求，因此接口由
  `development-automation/composition/required-ports.ts` 拥有；只有 exact module composition、bootstrap 与登记的
  provider adapter 可以 import，普通 application/engine 不直接 import 这条 entrypoint。
- integration adapter 只做 DTO 翻译和协议调用，不 import Mission domain；task-execution adapter 只把
  `AgentActionExecutionRequest` 转成现有 task execution intent，不解释 capability 业务。
- bootstrap 只实例化、注入、注册 worker；不写 `if capability === ...`、不查 DB、不做 DTO 翻译。

### 1.4 public surface 上限

```ts
// public/types.ts — 全部 opaque、JSON-safe、exact-key；owner decoder/factory 是唯一铸造点。
declare const developmentMissionRefBrand: unique symbol
export interface DevelopmentMissionRef {
  readonly [developmentMissionRefBrand]: 'development-mission-ref'
  readonly missionId: string
}

declare const missionRevisionRefBrand: unique symbol
export interface MissionRevisionRef extends DevelopmentMissionRef {
  readonly [missionRevisionRefBrand]: 'mission-revision-ref'
  readonly revision: number
}

export interface DevelopmentMissionSummary {
  readonly ref: MissionRevisionRef
  readonly status: MissionStatus
  readonly automationMode: 'active' | 'tracking-only'
  readonly repositoryRef: RepositoryRef
  readonly sourceSummary: { readonly kind: 'direct' | 'external'; readonly label: string }
  readonly repositoryUploads: null | {
    readonly entries: number
    readonly pending: number
    readonly fulfillment: 'pending' | 'satisfied' | 'unfulfilled'
  }
  readonly mergeRequest: null | { readonly iid: string; readonly headSha: string }
  readonly readiness: MissionReadinessView
  readonly blockedReason: null | MissionBlockView
  readonly updatedAt: string
}
```

`public/commands.ts` 最多包含实际 inbound 需要的 typed command：

```ts
export type DevelopmentMissionCommand =
  | LaunchDevelopmentMission
  | SelectMissionRequirementSource
  | SubmitMissionAnswers
  | CancelDevelopmentMission
  | HandoffDevelopmentMission
  | ResumeDevelopmentMissionAutomation
  | AttachMergeRequestToMission
  | RetryBlockedMission
  | RequestMissionConfigurationUpgrade

export interface LaunchDevelopmentMission {
  readonly authority: RequestAuthority
  readonly idempotencyKey: ValidatedIdempotencyKey
  readonly repositoryRef: RepositoryRef
  readonly submission: RequirementSubmission
  readonly delivery: MissionDeliveryTarget
  readonly requestedEmployeeRef?: VersionedResourceRef
  readonly requestedPolicyRef?: VersionedResourceRef
}

export interface SelectMissionRequirementSource {
  readonly authority: RequestAuthority
  readonly missionRef: MissionRevisionRef
  readonly sourceKey: string
}
```

`RepoRelativePath` 是 public DTO 唯一允许的 path-shaped 业务值：它由 owner codec 规范化并保证只表示仓库内逻辑文件，
不携带 checkout、upload temp 或 host absolute path。后续所谓 path-free participant 指“不暴露 host/workspace path”，
不禁止这个由用户明确给出的仓库目标值。

`public/queries.ts` 只提供 authority-filtered 的 `GetDevelopmentMissionView`、
`ListDevelopmentMissionSummaries`、`PreviewEmployeeSelection`、`PreviewPolicyDecision` 与配置资源的 typed
查询。资源写命令分别命名，不提供 `MutateAutomationResource { kind, payload }`。

`public/participants.ts` 只在真实跨域需要时提供：

```ts
export interface DevelopmentSignalParticipantInTx {
  recordWakeHint(input: {
    readonly missionRef: DevelopmentMissionRef
    readonly source: 'code-host' | 'pipeline' | 'timer' | 'manual'
    readonly deliveryKey: string
  }): Promise<{ readonly accepted: boolean }>
}

export interface DevelopmentMissionTerminalQuery {
  getTerminalState(
    ref: DevelopmentMissionRef,
  ): Promise<'active' | 'merged' | 'closed-unmerged' | 'completed-no-change' | 'canceled'>
}
```

`recordWakeHint` 只记“可能变了”；它不能携带 raw webhook body，也不能直接推进状态。reconciler 必须通过
required port 主动采集 authoritative snapshot。

`public/events.ts` 只发 committed facts，例如 `DevelopmentMissionStateCommitted { missionId, revision }`、
`DevelopmentMissionInvalidated { missionId, revision }`；不发 raw log、prompt、diff、内部 continuation 或
absolute path。

### 1.5 consumer-owned required ports

```ts
// composition/required-ports.ts — 仅 bootstrap 与登记的 provider adapter 可 import。
export interface RequirementAcquisitionPort {
  acquire(input: RequirementAcquireIntent): Promise<RequirementAcquisitionReceipt>
}

export interface RequirementInteractionPort {
  publishQuestions(
    input: RequirementQuestionEffectIntent,
  ): Promise<RequirementQuestionEffectReceipt>
  collectAnswers(input: RequirementAnswerCollectIntent): Promise<RequirementAnswerCollectReceipt>
}

export interface MergeRequestFactsPort {
  collect(input: MergeRequestCollectIntent): Promise<MergeRequestSnapshotReceipt>
}

export interface PipelineEvidencePort {
  collect(input: PipelineCollectIntent): Promise<PipelineEvidenceReceipt>
  trigger(input: PipelineTriggerIntent): Promise<PipelineTriggerReceipt>
  rerun(input: PipelineRerunIntent): Promise<PipelineRerunReceipt>
}

export interface DevelopmentCodeHostEffectsPort {
  execute(input: DevelopmentCodeHostEffect): Promise<DevelopmentCodeHostEffectReceipt>
}

export interface AgentActionExecutionPort {
  launch(input: AgentActionExecutionIntent): Promise<AgentActionLaunchReceipt>
  cancel(input: AgentActionCancelIntent): Promise<AgentActionCancelReceipt>
}

export interface RepositoryUploadPlacementPort {
  place(input: RepositoryUploadPlacementIntent): Promise<RepositoryUploadPlacementReceipt>
}

export interface ChildMissionPort {
  createOrAdopt(input: ChildMissionIntent): Promise<ChildMissionReceipt>
  observe(input: ChildMissionObserveIntent): Promise<ChildMissionReceipt>
}

export interface ApprovalGatewayPort {
  submit(input: ApprovalSubmitIntent): Promise<ApprovalReceipt>
  lookupByIdempotencyKey(input: ApprovalLookupIntent): Promise<ApprovalReceipt | null>
  observe(input: ApprovalObserveIntent): Promise<ApprovalObservationReceipt>
}
```

这些 port 的 DTO 只能含 opaque ref、closed union、digest、revision、budget 和 authority capability；禁止
credential、URL、header、DbClient、AbortSignal、runtime handle、session id、绝对路径、raw body/log 或
`Record<string, unknown>`。

`RepositoryUploadPlacementPort` 是 `development-automation` 消费、由 composition 中的 source-control + evidence
provider adapter 实现的内部程序端口：它读取 opaque upload blob ref，按冻结的 repository snapshot 和规范化相对路径
生成平台拥有的 `SeedChangeRef`。DTO 不携带浏览器临时路径或 host workspace path；source-control 仍是唯一能创建业务
workspace、推导 candidate 和接触 Git 的 owner。
application 从自己的 immutable plan 构造 exact placement intent（plan/digest、snapshot ref、按序 entry/blob ref/逻辑
target/expected state/mode/content policy）；provider adapter 不反向查询 development DB，也不只拿 planRef 后跨 owner 偷读表。
evidence/source-control 的组合只发生在 bootstrap 登记的 adapter 内，业务分支仍由 consumer 决定。

`ChildMissionPort` 是同一 bounded context 的 application-to-application exact participant：它只能消费验证后的 child intent，
内部仍调用标准 Mission admission command，不能直接插行或复制父 workspace。`ApprovalGatewayPort` 由 integration provider
adapter 实现；DTO 只有 opaque ref、closed status、revision 与 digest，不携带 provider URL/token/header 或审批正文。

`DevelopmentCodeHostEffect` 是闭集：

```ts
export type DevelopmentCodeHostEffect =
  | { readonly kind: 'mr.ensure'; readonly intentRef: string }
  | { readonly kind: 'mr.comment.create'; readonly intentRef: string }
  | { readonly kind: 'mr.comment.update'; readonly intentRef: string }
  | { readonly kind: 'mr.feedback.reply'; readonly intentRef: string }
  | { readonly kind: 'mr.labels.reconcile'; readonly intentRef: string }
```

该联合**没有** `merge`、`approve`、`thread.resolve`、generic `custom`。即使 integration 的通用 action
catalog 有这些能力，数字员工 provider adapter 也没有可表达它们的输入类型。

## 2. Mission 聚合与生命周期

### 2.1 聚合根

```ts
interface DevelopmentMission {
  readonly id: DevelopmentMissionId
  readonly revision: number
  readonly epoch: number
  readonly status: MissionStatus
  readonly automationMode: 'active' | 'tracking-only'
  readonly repositoryRef: RepositoryRef
  readonly sourceIdentity: MissionSourceIdentity
  readonly resolvedRequirementSource: ResolvedRequirementSource | null
  readonly repositoryUploadPlanRef: RepositoryUploadPlanRef | null
  readonly repositoryUploadPlacementRef: RepositoryUploadPlacementReceiptRef | null
  readonly repositoryUploadPublicationRef: RepositoryUploadPublicationReceiptRef | null
  readonly delivery: MissionDelivery
  readonly admissionAssignmentRef: MissionAdmissionAssignmentRef | null
  readonly selectionPolicy: PinnedAutomationPolicy | null
  readonly requirementBundleRef: RequirementBundleRef | null
  readonly repositoryFactsRef: RepositoryFactSnapshotRef | null
  readonly employee: PinnedDigitalEmployee | null
  readonly employeeSelectionReceiptRef: EmployeeSelectionReceiptRef | null
  readonly policy: PinnedAutomationPolicy | null
  readonly mergeRequest: MergeRequestBinding | null
  readonly currentActionRunRef: ActionRunRef | null
  readonly latestFacts: MissionFactRefs
  readonly readiness: MissionReadiness
  readonly budgets: MissionBudgetLedger
  readonly block: MissionBlock | null
  readonly terminalResult: MissionTerminalResult | null
  readonly terminalAt: string | null
}

type MissionStatus =
  | 'admitting'
  | 'awaiting-information'
  | 'working'
  | 'publishing'
  | 'watching'
  | 'waiting-committer'
  | 'ready-to-merge'
  | 'blocked'
  | 'merged'
  | 'closed-unmerged'
  | 'completed-no-change'
  | 'canceled'

type MissionTerminalResult =
  | {
      readonly kind: 'merged' | 'closed-unmerged'
      readonly uploadFulfillment: 'not-applicable' | 'satisfied' | 'unfulfilled'
      readonly unsatisfiedReasonRefs: readonly string[]
    }
  | { readonly kind: 'completed-no-change' | 'canceled' }
```

状态名表达用户可见阶段，不承担全部调度信息；“下一步做什么”只存在于 committed `DecisionReceipt`，
不能靠 `status` 推测。`merged/closed-unmerged/completed-no-change/canceled` 是终态，其他状态都可在新事实下重算。

`merged` 描述外部事实，不自动等于需求成功交付；若 committer 在 upload fulfillment 前合入，terminal result 必须显示
`uploadFulfillment = unfulfilled` 及缺失路径/原因 ref，平台停止写并通知人工，不能把它伪装成成功或再开补丁。

`automationMode` 与 status 正交。`tracking-only` 仍主动 collect MR/pipeline、计算 machine/human holds、发布平台内
read model 并观察 terminal，但不启动 Agent、Git/代码托管写 effect 或 pipeline trigger/rerun。handoff 可由 policy
或授权用户触发；resume bump epoch、重采 facts、重新决策，不从 handoff 前 workspace 接着写。

`sourceIdentity` 是 closed union：

```ts
type MissionSourceIdentity =
  | {
      readonly kind: 'direct'
      readonly submissionId: string
      readonly contentDigest: string
    }
  | {
      readonly kind: 'external'
      readonly requestedSourceKey: string | null
      readonly externalId: string
    }

interface ResolvedRequirementSource {
  readonly sourceKey: string
  readonly adapterRef: VersionedResourceRef
  readonly bindingDigest: string
}
```

`sourceIdentity` 是提交时即稳定的去重身份，不假装 `sourceKey` 已解析。选定 employee 后，application 按 assignment
default、employee 唯一 default 或显式 requested key 解析并 pin `resolvedRequirementSource`；source revision 只在
RequirementBundle/source receipt 中递增。省略 sourceKey 的 active-duplicate/reuse 判断必须等 binding 解析后使用
`(repository, adapter revision, externalId)`，不能仅按 externalId 把两个来源误认成同一 Mission。

direct `contentDigest` 覆盖规范化 title/body、按 ordinal 排序的 upload content digest、稳定显示名、仓库目标路径和显式
mode/content/collision 选择，不包含临时 uploadRef/path。HTTP 重试仍以 idempotency key 找回原 Mission；业务层 active
duplicate/reuse 还必须连同 resolved employee/policy revision 与 delivery identity 对拍，不能因正文相同而复用一条采用旧
upload 默认策略或不同目标分支的 Mission。

delivery 也是 closed union：

```ts
type MissionDelivery =
  | {
      readonly kind: 'create-merge-request'
      readonly targetRef: RepositoryRefName
      readonly sourceBranchPolicyRef: VersionedResourceRef
      readonly draft: boolean
    }
  | {
      readonly kind: 'adopt-merge-request'
      readonly mergeRequestRef: MergeRequestRef
      readonly observedHeadSha: string
      readonly observedTargetSha: string
    }
```

入口可以省略 create 模式的 target，application 用 pinned DeliveryPolicy 解析仓库默认目标分支后才构造
`MissionDelivery`；domain 不保存“以后再看默认分支”的空值。adopt 模式 admission 先主动读取 MR、确认 repo/claim/
权限，再以当前 head 建 baseline，不能信用户提交的 sha。

admission 幂等键与 source identity 分开：同一个 HTTP retry 返回同一 Mission；同一 external ID 是否复用
active Mission、开新 generation 或拒绝，由 admission policy 明确配置并留下 receipt，不能靠 Agent/路由猜。

### 2.2 业务状态图

```mermaid
stateDiagram-v2
  [*] --> admitting
  admitting --> awaiting-information: requirement needs answer
  admitting --> working: bundle + employee + policy pinned
  awaiting-information --> working: answer revision committed
  working --> publishing: candidate verified
  working --> awaiting-information: QuestionSet publication confirmed
  working --> blocked: budget or deterministic refusal
  working --> completed-no-change: program proof or human confirmation
  publishing --> watching: exact-head push and MR bound
  publishing --> working: remote head changed / effect invalidated
  watching --> working: feedback / failing gate / conflict action
  watching --> waiting-committer: automation done, human hold remains
  watching --> ready-to-merge: all host prerequisites pass
  waiting-committer --> working: new machine work
  waiting-committer --> ready-to-merge: human hold cleared
  ready-to-merge --> working: head / thread / gate / target changed
  blocked --> working: authorized retry or configuration repair
  admitting --> canceled
  awaiting-information --> canceled
  working --> canceled
  publishing --> canceled
  watching --> canceled
  waiting-committer --> canceled
  ready-to-merge --> canceled
  blocked --> canceled
  completed-no-change --> [*]
  watching --> merged
  waiting-committer --> merged
  ready-to-merge --> merged
  watching --> closed-unmerged
  waiting-committer --> closed-unmerged
  ready-to-merge --> closed-unmerged
```

外部 MR 在平台还处于 `working/publishing` 时被关闭或合入，固定 terminal guard 优先于图中普通 action，
先取消当前 task、作废未执行 effect，再进入终态。不能因为图里没画一条边就继续 push。

### 2.3 聚合不变量与 authority

- 每次 mutation 都要求 `(missionId, expectedRevision, epoch)`；lease 丢失或 epoch 过期返回 typed conflict。
- `currentActionRunRef != null` 时不得 claim 第二个可写 action；只读分析也必须绑定 immutable snapshot。
- MR 绑定后，在 `(codeHostEndpointRef, stableProjectRef, mrIid)` 上持有唯一 active claim；绑定冲突会阻断，
  不能开第二个数字员工竞争写同一 MR。
- internal continuation 使用 mission-family effect capability；不构造 `SystemActor`，不复用原用户的过期 session。
- 人工 retry、cancel、configuration upgrade、handoff/attach/resume 每次按当前 actor 重新授权；历史 initiator 不等于永续权限。
- terminal guard、head freshness、credential scope、no-merge 不可被 policy 覆盖。

`cancel` 命令先 bump epoch 并写 cancel fence：禁止产生任何新写，撤销尚未 dispatch 的 intent并终止 Agent。已经
dispatch 或结果未知的 commit/push/MR/comment/pipeline effect 必须先按外部真相 reconcile；全部 settle 后才把 Mission
置为 `canceled` 并释放 claim。API/read model 在此期间显示 `cancel-pending` transition receipt，不能提前宣称外部没有
发生。cancel 不关闭已有 MR、不删 source branch、不 revert 或 reset 已发布 commit。用户若只想暂停自动修改而继续
跟踪，必须用 handoff/tracking-only，不把 cancel 当暂停。

### 2.4 readiness

```ts
interface MissionReadiness {
  readonly evaluatedForHead: string | null
  readonly factDigest: string
  readonly automationReady: boolean
  readonly hostMergeable: 'yes' | 'no' | 'unknown'
  readonly machineHolds: readonly MachineHold[]
  readonly humanHolds: readonly HumanHold[]
  readonly status: 'working' | 'waiting-committer' | 'ready-to-merge'
}
```

固定算法：

1. 有 active action、unconfirmed effect、未处理 feedback revision、conflict、required gate 非 pass、facts
   不完整、head 不一致或 created/replaced upload 尚无 fulfillment receipt ⇒ `automationReady=false`。
2. 自动化事项清零但还有 approval、人工 thread resolve、committer-only policy hold ⇒
   `waiting-committer`；平台继续监听，绝不替人解除。
3. `automationReady=true`、human holds 为空、code host 明确 `mergeable=yes` ⇒ `ready-to-merge`。
4. `unknown/partial/unavailable` 永不折算为 pass；“最后一次曾经绿色”不适用于新 head。
5. readiness receipt 绑定 head、target head、MR snapshot digest、pipeline evidence digest 与 policy revision；任一
   revision 改变立即失效。

### 2.5 ActionRun

```ts
interface ActionRun {
  readonly id: ActionRunId
  readonly missionRef: MissionRevisionRef
  readonly decisionRef: DecisionReceiptRef
  readonly capability: CapabilityId
  readonly workSetRef: WorkSelectionReceiptRef | null
  readonly capabilityContractVersion: number
  readonly implementation: ActionImplementationRef
  readonly inputFactDigest: string
  readonly baseline: ActionBaselineRef
  readonly status:
    | 'claimed'
    | 'materializing'
    | 'running'
    | 'validating'
    | 'awaiting-effect'
    | 'settled'
    | 'invalidated'
    | 'failed'
    | 'canceled'
  readonly resultRef: ActionResultRef | null
}
```

`ActionRun` 固定 capability、实现 revision、policy decision、facts 和 baseline。运行中配置更新不改变它；
外部 head 改变也不是“拿新 head 接着跑”，而是使旧 run/candidate invalidated，再由 reconciler 基于新 facts
产生新 action。

### 2.6 唤醒、主动采集与 reconcile

webhook、pipeline callback、timer 与人工按钮都只写入带 dedupe key 的 `MissionWakeHint`。worker 的单次循环：

```text
claim mission lease + epoch
  → terminal facts first
  → collect missing/stale authoritative facts
  → verify all refs/digests/head bindings
  → fixed safety guards
  → evaluate pinned policy once
  → commit DecisionReceipt + ActionIntent/effect intent in one transaction
  → outbox dispatch
  → release/renew lease
```

事件风暴只合并 wake hint，不能合并不同 feedback revision 或不同 pipeline run 的事实。定时 reconcile 是
webhook 丢失的恢复通道；它也必须走同一采集和决策路径，不能有“定时器专用逻辑”。

## 3. 能力与配置资源

> **Legacy implementation record（非目标 authoring 模型）**：§3.1-§3.8 记录 2026-08-19 已交付 Mission/EmployeePlaybook
> 实现，供迁移、兼容 API 和 cutover 对照。新数字员工 OS 的规范性定义以 §0A.2、§0A.12、§0A.13 为准：不得继续把
> `EmployeePlaybook.steps`、`ActionTemplate`、`VerificationProfile`、`AutomationPolicy` 或节点 retry 暴露为业务配置。

### 3.1 一个业务 authoring aggregate，内部资源仍按 owner 分开

| 定义                           | owner                       | 是否用户可新建                        | 能改变什么                                                                                               |
| ------------------------------ | --------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `CapabilityDefinition`         | development-automation 代码 | 否；随产品/RFC 升 contract version    | 输入/输出 schema、固定阶段、workspace mode、权限、validator、可产生的 effect intent                      |
| `IntegrationAdapterDefinition` | integration                 | 是，需对应资源权限与 `scripts:author` | 外部程序、参数 schema、secret projection、provider codec、bundle budget                                  |
| `VerificationProfile`          | development-automation      | 是；改 executable 需 `scripts:author` | build/test program refs、隔离/网络/超时、程序化 pass 判据与 evidence 选择                                |
| `ActionTemplate`               | development-automation      | 是                                    | 指定 capability 的 agent/workgroup revision、prompt supplement、只读知识、验证 profile、规则可选择的标签 |
| `DigitalEmployeeTemplate`      | development-automation      | 是                                    | 多 capability route、adapter binding、默认 policy 与适用仓库 facts                                       |
| `AutomationPolicy`             | development-automation      | 是                                    | admission、first-match action、feedback/pipeline/conflict/retry/readiness/notification/retention         |

产品的唯一 authoring aggregate 是 `EmployeePlaybook`。页面不再把表中四种内部资源做成并列业务导航；它读取和保存
“员工负责范围 + 有序步骤 + 问题类型 + producer/handler + 失败处理”。`development-automation` application command
把这份业务草稿编译为 closed policy/capability route，并在发布时一次验证完整引用闭包。adapter 的程序、credential 与连接
仍由 integration 拥有，员工只 pin 一个已发布引用；前端不得通过多次独立 PUT 假装一次原子保存。

```ts
interface EmployeePlaybookContentV1 {
  readonly schemaVersion: 1
  readonly description: string
  readonly supportedRepositoryFacts: readonly FactPredicate[]
  readonly steps: readonly EmployeeStepDefinition[]
  readonly problemTypes: readonly ProblemTypeDefinition[]
  readonly problemProducers: readonly ProblemProducerDefinition[]
  readonly problemHandlers: readonly ProblemHandlingRule[]
  // 内部编译依赖；业务页只显示已解析的业务名称
  readonly capabilityRoutes: readonly CapabilityRoute[]
  readonly requirementSources: readonly RequirementSourceBinding[]
  readonly pipelineProviders: readonly PipelineProviderBinding[]
  readonly defaultPolicyRef: VersionedResourceRef
}

interface EmployeeStepDefinition {
  readonly stepId: string
  readonly displayName: string
  readonly description: string
  readonly when: readonly FactPredicate[]
  readonly producer: StepProducerRef
  readonly input: StepInputMapping
  readonly onSuccess: StepTarget
  readonly join: StepJoinRule | null
  readonly onFailure: StepFailureRule
}

type StepProducerRef =
  | { readonly kind: 'platform'; readonly capabilityId: CapabilityId }
  | { readonly kind: 'agent'; readonly implementationRef: VersionedResourceRef }
  | { readonly kind: 'script'; readonly implementationRef: VersionedResourceRef }
  | {
      readonly kind: 'digital-employee'
      readonly employeeRef: VersionedResourceRef
      readonly repository: TargetRepositoryRule
      readonly completion: 'automation-ready' | 'ready-to-merge' | 'merged' | 'completed'
      readonly deadlineMs: number
    }
  | {
      readonly kind: 'approval-prepare'
      readonly executor: 'agent' | 'script'
      readonly implementationRef: VersionedResourceRef
      readonly approvalType: string
    }
  | {
      readonly kind: 'approval-submit'
      readonly adapterRef: VersionedResourceRef
    }
  | {
      readonly kind: 'approval-observe'
      readonly adapterRef: VersionedResourceRef
      readonly pollIntervalMs: number
      readonly deadlineMs: number
      readonly webhookSourceKey: string | null
    }

type StepInputMapping =
  | { readonly kind: 'mission-requirement' }
  | { readonly kind: 'selected-problems' }
  | { readonly kind: 'step-output'; readonly stepId: string }
  | {
      readonly kind: 'compose'
      readonly sources: readonly { readonly name: string; readonly stepId: string }[]
    }

type StepTarget = NextStepRef | 'reconcile' | 'complete' | 'block' | 'handoff'

interface StepJoinRule {
  readonly groupId: string
  readonly mode: 'all' | 'any' | 'quorum'
  readonly quorum: number | null
  readonly memberStepIds: readonly string[]
  readonly deadlineMs: number
  readonly onDeadline: StepTarget
  readonly onPartial: StepTarget
}

type TargetRepositoryRule =
  | { readonly kind: 'fixed'; readonly repositoryId: string }
  | { readonly kind: 'fact'; readonly factId: TargetRepositoryFactId }

interface StepFailureRule {
  readonly retry: { readonly sameScene: number; readonly freshScene: number }
  readonly onExhausted: StepTarget
  readonly onRejected: StepTarget | null
  readonly onExpired: StepTarget | null
}
```

同一纯编译器供发布、预演和运行使用：`compileEmployeePlaybook(playbook, resolvedRefs) → CompiledEmployeeClosure`。
编译结果含有 exact employee/policy/implementation/connection revision、规范化规则和 digest；Mission 只 pin 编译结果，
不会在运行时再次把多份草稿拼起来。对旧表的兼容 API 只供高级管理员和迁移工具使用，业务页面调用
`/api/code/digital-employees/:id/playbook` 聚合投影与 application command。

编译器必须把每个业务步骤展开为 closed `StepExecutionPlan`，并验证 step id 唯一、所有跳转存在、成功/失败分支闭合、
输入来源先于消费者、join 成员同组且无重复、quorum 合法、fallback 无环且同 problem type、所有 wait 有
deadline 与 wake source。被 `onSuccess/onFailure/join/verify` 引用的步骤只能沿对应边进入；没有被引用的步骤是独立入口，
用于“首次开发”或“有新检视意见/红门禁时响应”这类事实触发职责。运行时绝不能因为数组顺序把成功步骤落入失败
恢复步骤；也不得在生产者已结算后隐式换用下一个生产者。静态可见的调用环直接拒绝；目标仓库来自 fact 时只能使用
catalog 中标记为 `repository-ref` 的闭集 fact。技术资源 revision、capability ID、adapter purpose 和脚本权限仍在编译结果中，
但不会回显为业务表单的必填术语。

### 3.2 CapabilityDefinition

```ts
interface CapabilityDefinition {
  readonly id: CapabilityId
  readonly contractVersion: number
  readonly executionKind: 'program' | 'adapter' | 'agent' | 'platform-effect'
  readonly inputSchemaId: string
  readonly outputSchemaId: string
  readonly workspaceMode: 'none' | 'read-only' | 'edit-business-files' | 'edit-conflicts'
  readonly stages: readonly CapabilityStage[]
  readonly semanticValidatorId: string
  readonly allowedEffectKinds: readonly DevelopmentEffectKind[]
}
```

首版 catalog 与 proposal §5 一致，并额外把平台内部动作分组。用户不能增加 capability ID，也不能改阶段图；
否则“规则可静态验证”和“Agent 边界由平台锁死”都会失真。扩展能力必须发新 RFC/contract version，旧在途
ActionRun 继续按旧 validator 结算。

### 3.3 IntegrationAdapterDefinition

```ts
interface IntegrationAdapterDefinition {
  readonly id: string
  readonly revision: number
  readonly purpose:
    | 'requirement-source'
    | 'pipeline-gate'
    | 'pipeline-classifier'
    | 'approval-gateway'
  readonly operations: readonly AdapterOperation[]
  readonly contractVersion: number
  readonly executableRef: string
  readonly parameterSchemaRef: string
  readonly parameterValuesDigest: string
  readonly connectionRef: string | null
  readonly secretProjection: readonly string[]
  readonly outputBudget: AdapterOutputBudget
  readonly timeoutMs: number
  readonly ownerRef: string
  readonly aclRevision: number
}
```

`AdapterOperation` 也是 closed union，并与 purpose 对拍：requirement source 可声明 `acquire`，以及可选的
`questions.writeback + answers.collect` 配对；pipeline gate 可声明 `collect` 和可选 `trigger/rerun`；classifier
只有 `classify`；approval gateway 必须成对声明 `submit + lookup-by-idempotency-key`，并可声明 `observe` 与 webhook
correlation codec。只有 writeback、没有 answer collection 的 adapter 不能被发布为“原渠道澄清可用”；没有声明的
写操作不会因为 executable 实际支持就变得可达。

`secretProjection` 是 integration owner 校验过的 secret key 闭集，保存时拒绝未知项；worker 运行 adapter 时
从**空环境**加入固定基础变量和这份 projection，不继承 daemon env。adapter 只得到一次性 staged bundle sink，
不得得到 repository/Mission 数据库、真实 worktree 或 code-host generic client。

adapter 的网络也按 connectionRef 解析出的 provider allowlist 收缩；`scripts:author` 是高风险写权，不代表程序可带着
投影 secret 访问任意地址。probe 必须记录 executable digest、connection revision、sandbox profile 与 contract receipt。

adapter 的 stdout 也使用 contract envelope；它可以报告 provider status/source revision/file descriptors，不能
返回 `nextAction`、`agentId`、`merge`、`ready`。平台重新 walk 输出目录并计算真实 digest，adapter 自报 digest
不作最终事实。

### 3.4 ActionTemplate

```ts
interface ActionTemplate {
  readonly id: string
  readonly revision: number
  readonly capabilityId: AgentCapabilityId
  readonly capabilityContractVersion: number
  readonly labels: readonly string[]
  readonly compatibility: TemplateCompatibility
  readonly executor:
    | { readonly kind: 'agent'; readonly agentRef: VersionedResourceRef }
    | { readonly kind: 'workgroup'; readonly workgroupRef: VersionedResourceRef }
    | {
        readonly kind: 'script'
        readonly language: 'python' | 'bash' | 'node'
        readonly scriptRef: VersionedResourceRef
      }
  readonly runtimeProfileRef: VersionedResourceRef
  readonly promptSupplement: string
  readonly skillRefs: readonly VersionedResourceRef[]
  readonly mcpRefs: readonly VersionedResourceRef[]
  readonly readOnlyResourceRefs: readonly VersionedResourceRef[]
  readonly contextProfileRef: VersionedResourceRef
  readonly writablePathPolicyRef: VersionedResourceRef | null
  readonly additionalProtectedPathClasses: readonly PathClass[]
  readonly verificationProfileRef: VersionedResourceRef
  readonly retryDefaults: AgentRetryBudget
  readonly ownerRef: string
  readonly aclRevision: number
}
```

`ActionTemplate` 是内部执行实现 revision；产品只显示 `displayName`（“Java 修改实现”“C++ 编译修复程序”）。script
implementation 与 Agent implementation 走同一 capability 输入/输出 schema、workspace mode、pre/post snapshot 和
candidate 验证。script 由 TaskEngine 合成 script node 执行，不能从 Mission reconciler 直接 spawn；它的 stdout 也必须是
nonce/inputDigest 绑定的唯一 outcome envelope，不能 commit/push 或返回下一步。

模板不保存 raw filesystem path、credential 或 runtime object。`promptSupplement` 被放在平台不可覆盖的 protocol
block **之前**，并经过明确分隔；里面出现“忽略 envelope / 自己提交 / 自己选下一步”不会改变运行合同。

`runtimeProfileRef` 必须声明并通过 digital-employee 检测/回退 probe（§7.6）；`skillRefs/mcpRefs` 只能引用 capability manifest
标记为本地或只读、无外部副作用的资源，不能因此重新取得 requirement/pipeline/code-host connector。context profile
只能从 CapabilityDefinition 允许的 evidence class 中做子集选择。`writablePathPolicyRef` 只能**收窄** capability 的
workspace mode，`additionalProtectedPathClasses` 只能增加保护项，二者都不能打开 Git/evidence/platform roots。

write capability 若使用 workgroup，发布校验要求 `maxConcurrentWriters=1`；其他成员只能在 immutable snapshot 上
只读分析，不能让多个 member 共享可写 overlay 后再自动融合。

`compatibility` 是无顺序、只会拒绝不兼容选择的 typed constraint，不参与“选哪份模板”。唯一 selector 是
DigitalEmployee 的 `CapabilityRoute.rules`；route 发布时必须证明每个 rule 的 when 蕴含目标 template compatibility。
否则两处 predicate 会变成两个可能意见不同的选择器。compatibility 不能内嵌脚本、正则执行器或自然语言路由。

### 3.5 VerificationProfile

本地 build/test 也是可执行配置，不能藏在 prompt 或普通 policy string 里：

```ts
interface VerificationProfile {
  readonly id: string
  readonly revision: number
  readonly steps: readonly {
    readonly stepId: string
    readonly programRef: VersionedResourceRef
    readonly argsRef: VersionedResourceRef | null
    readonly timeoutMs: number
    readonly networkProfileRef: VersionedResourceRef
    readonly successExitCodes: readonly number[]
    readonly evidenceSelectors: readonly VerificationEvidenceSelector[]
  }[]
  readonly stopPolicy: 'first-failure' | 'collect-all'
  readonly maxParallel: number
  readonly ownerRef: string
  readonly aclRevision: number
}
```

新增/修改 `programRef/argsRef` 额外要求 `scripts:author`。verification 在 candidate 的**一次性 disposable workspace**
执行：可以产生编译产物，但这些写入绝不回流 publication candidate；Git metadata 只读，环境/credential/network 按
profile 收缩。平台从 exit code、timeout 和自己收集的 reports/logs 生成 `VerificationReceipt`，程序 stdout 里的
“passed/ready”不是事实。日志进入 bounded verification evidence，不进入 policy/prompt；repair Agent 只读失败 receipt
和按 contract 选中的 evidence。

### 3.6 DigitalEmployeeTemplate

```ts
interface DigitalEmployeeTemplate {
  readonly id: string
  readonly revision: number
  readonly name: string
  readonly supportedRepositoryFacts: readonly FactPredicate[]
  readonly capabilityRoutes: readonly CapabilityRoute[]
  readonly requirementSources: readonly AdapterPurposeBinding[]
  readonly pipelineProviders: readonly AdapterPurposeBinding[]
  readonly defaultPolicyRef: VersionedResourceRef
  readonly ownerRef: string
  readonly aclRevision: number
}

interface CapabilityRoute {
  readonly capabilityId: AgentCapabilityId
  readonly rules: readonly {
    readonly ruleId: string
    readonly when: readonly FactPredicate[]
    readonly templateRef: VersionedResourceRef
  }[]
  readonly fallbackTemplateRef: VersionedResourceRef | null
}
```

员工 revision 发布前做闭包检查：

- policy 可能产出的每个 Agent capability 都有 route；
- route 引用的 template capability/contract version 匹配；
- agent/workgroup/runtime/verification 资源对发布者可见并可被 Mission actor 使用；
- requirement/pipeline source scope 不重叠或有唯一优先级；
- 每个 requirement `sourceKey` 与 required pipeline `gateKey` 都解析到唯一 adapter operation；
- Java/C++/polyglot 路由对声明支持的 repository fact fixtures 不出现双义/无结果；
- adapter purpose、contract version、connection 与 secret projection 可用。

发布产生 immutable revision。编辑已发布资源实际创建新 revision；删除只做 archive，不破坏在途 Mission pin。

员工 readiness 是依赖投影，不是一个保存后永远为绿的布尔值：

```ts
type DigitalEmployeeReadiness =
  | { readonly status: 'ready'; readonly dependencyDigest: string; readonly probedAt: string }
  | {
      readonly status: 'degraded' | 'blocked'
      readonly dependencyDigest: string
      readonly reasons: readonly EmployeeReadinessReason[]
    }
```

依赖包括 routes/templates、agent/workgroup/runtime、verification、source/gate adapters、connections 与最近 probes。
publish compiler 先按 execution policy 求出整条生命周期可达能力闭包；新 Mission admission 只接受该闭包
`ready`，不能因为“当前第一步用不到 pipeline adapter”把未来必卡的员工放行。`degraded` 只描述已在途 Mission 的
临时 dependency/probe 退化，按 retry/handoff policy 等待；依赖 revision 改变会使 readiness stale 并重算。每个
ActionRun freeze 前仍验证实际依赖，不偷偷换另一名员工。

### 3.7 AutomationPolicy

policy 是多个**各自有 closed schema 的 rule group**，不是一个可执行 DSL 文件：

```ts
interface AutomationPolicy {
  readonly id: string
  readonly revision: number
  readonly admission: AdmissionPolicy
  readonly requirement: RequirementLifecyclePolicy
  readonly employeeSelection: OrderedRuleSet<EmployeeDecision>
  readonly actionPriority: OrderedRuleSet<ActionDecision>
  readonly feedback: FeedbackPolicy
  readonly pipeline: PipelinePolicy
  readonly conflict: ConflictPolicy
  readonly delivery: DeliveryPolicy
  readonly verification: VerificationPolicy
  readonly retry: RetryPolicy
  readonly readiness: ReadinessPolicy
  readonly notification: NotificationPolicy
  readonly retention: RetentionPolicy
}
```

`RequirementLifecyclePolicy` 固定枚举 source refresh mode
`manual | auto-before-first-push | auto`、澄清通道优先级/轮数/超时、no-change confirmation，以及下列 direct upload 策略：

```ts
interface RepositoryUploadPolicy {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
  readonly allowedTargetPrefixes: readonly RepoRelativeDirectory[]
  readonly defaultCollisionMode: 'create-only' | 'replace-existing'
  readonly allowedCollisionModes: readonly ('create-only' | 'replace-existing')[]
  readonly defaultContentPolicy: 'preserve-upload' | 'agent-editable'
  readonly allowedContentPolicies: readonly ('preserve-upload' | 'agent-editable')[]
  readonly allowExecutableFileMode: boolean
  readonly targetChangedDisposition: 'block' | 'handoff'
}
```

空 `allowedTargetPrefixes` 表示所有普通业务路径，但产品固定保护的 `.git`、`.agent-workflow`、credential/runtime roots、
submodule 与 repository instruction 指定的不可写路径始终不能放开。请求没填 mode 时采用 policy default；请求显式值只有
位于 allowed closed set 才生效，否则 admission 返回字段级错误。新文件默认 regular；替换文件未显式指定时保留原
mode，显式 executable 还要求 policy 允许。由此“覆盖已有文件”“允许 Agent 改上传内容”“设置可执行位”都是
可预演的业务策略或显式用户选择，不是 Agent 判断。
`agent-editable` 只取消该 entry 的内容保持约束，不扩张 ActionTemplate/CapabilityDefinition 的业务写路径；实际可写集是
两者交集。若当前 action template 不允许该 path，文件仍可由平台原样提交，但 Agent 不能借 upload policy 越权修改。

`DeliveryPolicy` 固定目标分支解析、source branch 命名/碰撞、new/adopt MR、draft 与 remote human push 后的
`restart-action-from-new-head | handoff`。restart 会**废弃旧 ActionRun 并从新 head 重建业务动作**，绝不执行 Git
rebase 或自动套用未发布 patch。

每个预算都有产品硬上限。例如 same-session retry、fresh-session rerun、ActionRun 次数、pipeline rerun、总
commit 数、Mission wall time 与 token 均不能配置为无限。`0` 是显式禁用，空值采用已版本化默认值。

运行时不做“员工默认 + repo override + 请求 override”的逐字段动态 merge。配置界面可以从上游复制/派生，
但 publish 必须产出一份完整 immutable policy revision。Mission admission 将 explicit/assignment/employee default
解析为唯一 execution policy 后，保存 exact ref/digest；这保证规则顺序、预算与 replay 只有一个事实源。

每个 ActionRun 的 `EffectiveActionBudget` 在 decision 时一次解析：CapabilityDefinition product hard cap > execution
policy exact value；policy 可显式写 `inherit-template-default`，此时读取已 pin ActionTemplate default，再冻结为数字。
运行中不重新读取默认值，也不把“失败后自动多试几次”留给 runtime 自行决定。

### 3.8 选择顺序

员工带默认执行 policy，但不能用“尚未选出的员工”反过来选择自己。先按 repository scope 解析一份唯一 admission
assignment：

```ts
interface MissionAdmissionAssignment {
  readonly scope: 'repository' | 'repository-group' | 'global-default'
  readonly selectionPolicyRef: VersionedResourceRef | null
  readonly employeeRef: VersionedResourceRef | null
  readonly executionPolicyRef: VersionedResourceRef | null
  readonly defaultRequirementSourceKey: string | null
}
```

scope 优先级是 exact repository > repository-group > global default；每一级最多一份。assignment 是可选上下文，
不是显式选择的前置条件：请求已给 authorized employee revision 时，即使没有 assignment 也能继续；没有显式员工时，
则必须由 assignment 的 employeeRef 或 selectionPolicyRef 产生唯一员工。defaults-only assignment 可以只提供执行策略/
requirement source，但不能在没有显式员工时单独完成 admission。然后分两步：

```text
employee:
  explicit employee revision
  > assignment employee revision
  > assignment.selectionPolicy employeeSelection first-match (when present)
  > explicit fallback
  > blocked(no-employee-match)

execution policy:
  explicit authorized policy revision
  > assignment.executionPolicyRef
  > selected employee.defaultPolicyRef
```

这一步只读取 admission 已知的 `repositoryRef`、可选 `sourceKey`/submission kind 与程序化
`RepositoryFactSnapshot`，不依赖尚未获取的需求
正文。员工选定后才解析其 `sourceKey → requirement adapter` binding；否则 adapter 在员工里、员工又依赖 adapter
输出，会形成启动死锁。

selection policy 只有在实际用于选人时才 pin revision；显式/assignment-direct 选择的 receipt 记录
`selectionMode = explicit | assignment` 且 matched rule 为空。规则选择则记录 exact selection policy 与 matched rule。
`EmployeeSelectionReceipt` 始终包含 assignment nullable ref、repository facts digest 与 employee revision；execution policy
才供 Mission action/readiness/retry 决策。每一级必须 0 或 1 个结果；同级多个 assignment 不是“随便取第一个”，而是
配置错误。

选定员工后，ActionTemplate 只能在该员工的 capability route 内 first-match。混合仓跨模块改动必须命中显式
polyglot template；不得把 Java 与 C++ 两个可写 action 并发后再让 Agent/平台猜怎么合并。

route 可读取 closed prior-action failure category/attempt budget，因此管理员可以显式写“primary runtime unavailable
后用 fallback template”；平台不会在模板失败时自行换 Agent。fallback 仍必须属于同一 pinned employee revision，
并在 DecisionTrace 中给出 ruleId。

为避免混合仓出现“必须先理解需求才能选语言模板、但先选模板才能理解需求”的循环：

- 单语言 repo 可由 repository facts 直接选 Java/C++ employee；
- 多语言 repo 必须被 assignment/selection policy 选到覆盖这些语言的 polyglot employee，否则 admission block；
- polyglot employee 为 `requirement.analyze` 配一份通用只读模板；它输出 closed `affectedModuleRefs` 与
  `scopeDisposition`，平台逐个对拍 repository module catalog；
- 后续 `change.implement` route 只读取这些已验证 module/language facts，first-match Java/C++/polyglot template。

Agent 提供的是“需求影响哪些已知模块”的认知结果，不是 template id；不存在模块、跨语言集合或无法确定时分别
进入 semantic retry、polyglot route 或 `needs-information`。

预演 API 与真实运行调用同一个 pure evaluator，区别只在前者不 claim lease、不写 DecisionReceipt。

## 4. typed facts 与规则解释器

### 4.1 FactSnapshot

规则不能直接读数据库行、文件内容或 provider JSON。每轮 reconcile 先把各 owner 的 receipt 投影成一个
exact `MissionFactSnapshot`：

```ts
interface MissionFactSnapshot {
  readonly schemaVersion: 1
  readonly missionRevision: number
  readonly capturedAt: string
  readonly repository: RepositoryFacts
  readonly requirement: RequirementFacts
  readonly mergeRequest: MergeRequestFacts | null
  readonly pipeline: PipelineFacts | null
  readonly feedback: FeedbackFacts
  readonly verification: VerificationFacts | null
  readonly budgets: BudgetFacts
  readonly priorActions: PriorActionFacts
  readonly refs: MissionFactRefs
  readonly digest: string
}
```

所有 nested object strict/exact，数组先按领域稳定键排序再 canonical JSON hash。时间判断不在 evaluator 内调用
`Date.now()`；`capturedAt` 和 deadline fact 由 Clock port 注入，因此 replay 不漂移。

每个可被规则读取的 leaf 都有 availability，而不是用 `null` 同时表示五件事：

```ts
type FactCell<T> =
  | { readonly state: 'known'; readonly value: T; readonly sourceRevision: string }
  | { readonly state: 'not-applicable'; readonly reason: string }
  | { readonly state: 'unknown'; readonly reason: string; readonly collectable: boolean }
  | { readonly state: 'stale'; readonly previousRevision: string; readonly collectable: boolean }
```

predicate 只对 `known/not-applicable` 得到 true/false；读到 unknown/stale 得到 `indeterminate`。**前一条规则
indeterminate 时不能跳到后续 fallback**，否则 provider outage 会改变动作优先级；fixed guard 先 collect，无法取得时
按 policy wait/block。publish compiler 还按 decision phase 限制可读 facts，例如 admission selection 不能引用 pipeline。

FactCatalog 的每个 leaf 还声明 `provenanceClass = program | external-authoritative | human-confirmed | agent-validated` 与
`allowedDecisionPhases`。Agent outcome 只有经过 capability semantic validator 才能投影为 `agent-validated` fact；它可以
影响规则预先允许的 action route（例如已验证 affected module set），但不能直接形成 ActionTemplate/effect/ready fact。
policy publish 若在未授权 phase 读取该 provenance class 直接失败。由此确定性边界是 frozen FactSnapshot 到
DecisionReceipt；原始自然语言推理和代码内容不被虚称为 byte-deterministic。

Fact 目录是 code-owned closed catalog，首版至少包括：

| 组          | typed facts                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| repository  | languages、language-by-module、build systems、module ids、changed-path classes、target/source head       |
| requirement | source kind/key、source revision、bundle completeness、document roles、clarification state               |
| MR          | exists、head/target sha、draft、conflict、mergeability、approval holds、thread revisions、terminal state |
| pipeline    | required gate keys、completeness、status、failure categories、run/head、retryability                     |
| action      | pending kind、last outcome、attempt count、candidate/verification/effect state                           |
| budget      | remaining action/Agent/pipeline/commit/token/wall-time budgets                                           |

正文、评论全文、日志和 diff 不进 FactSnapshot；规则只需要分类、revision、计数和 ref。自然语言是否可修等
认知结论若来自 Agent，必须作为某个已验证 capability outcome 的 closed enum 进入 `priorActions`，不能把 Agent
自由文本变成 predicate。

### 4.2 Predicate AST

不使用 JavaScript、CEL、JQ、正则代码片段或 `${expression}`。配置文件只能表达 schema 已登记的 closed
predicate：

```ts
type FactPredicate =
  | { readonly kind: 'enum-equals'; readonly fact: EnumFactId; readonly value: string }
  | { readonly kind: 'enum-in'; readonly fact: EnumFactId; readonly values: readonly string[] }
  | {
      readonly kind: 'set-contains-any'
      readonly fact: StringSetFactId
      readonly values: readonly string[]
    }
  | {
      readonly kind: 'set-contains-all'
      readonly fact: StringSetFactId
      readonly values: readonly string[]
    }
  | {
      readonly kind: 'number-compare'
      readonly fact: NumberFactId
      readonly op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte'
      readonly value: number
    }
  | { readonly kind: 'boolean-is'; readonly fact: BooleanFactId; readonly value: boolean }
  | { readonly kind: 'path-class-any'; readonly values: readonly PathClass[] }
  | { readonly kind: 'all'; readonly predicates: readonly FactPredicate[] }
  | { readonly kind: 'any'; readonly predicates: readonly FactPredicate[] }
  | { readonly kind: 'not'; readonly predicate: FactPredicate }
```

每个 `FactId` 在 catalog 登记类型、敏感级别、允许出现的 rule group 和 owner。policy publish 时拒绝：

- 在 employee selection 中读取尚未存在的 pipeline fact；
- enum value 不在 fact 的 closed vocabulary；
- 空 `any`、过深 AST、过多节点、重复 ruleId；
- 一个规则同时要求互斥值；
- 同一 assignment/rule order 不唯一；
- 使用未知 key 或未来 schema 字段。

路径匹配先由 repository inspector 归类成 `PathClass`/module fact。glob 只允许配置在 inspector profile 中，
发布时编译并受复杂度限制；policy evaluator 不对任意仓库路径执行用户正则。

### 4.3 固定 guard 优先级

policy 不是最高权力。每次 decision 按固定顺序：

1. **terminal guard**：MR merged/closed 或 Mission 已进入任一 terminal status ⇒ 终止，取消在途动作；
2. **lease/epoch guard**：非当前 writer ⇒ 不做事；
3. **active-effect/transition guard**：已有 claimed ActionRun/effect 或 cancel/handoff fence ⇒ 只终止本地执行并
   reconcile 已 dispatch effect，不产生新业务写；
4. **fact-integrity guard**：digest、bundle、snapshot、codec、head binding 不完整 ⇒ collect 或 block；
5. **freshness guard**：MR/source/target head 与 action baseline 不一致 ⇒ invalidate stale work；
6. **authority guard**：当前 effect capability/资源可见性/connection scope 不成立 ⇒ block；
7. **budget guard**：硬上限耗尽 ⇒ block/escalate；
8. **safety guard**：禁止 merge/approve/resolve/force push、unknown-as-pass、并行 writer；
9. **automation-mode guard**：tracking-only 只允许 collect/readiness/terminal，拒绝所有 write decision；
10. **upload-fulfillment guard**：active 且计划尚未 placement ⇒ 固定先 `seed-repository-uploads`；已有 seed 允许进入
    分析/实现/验证/发布，但 created/replaced 尚未 fulfillment 时禁止 ready、no-change 或跳过 candidate；tracking-only 只
    collect 外部 tree fulfillment；
11. **policy first-match**：只在上述均通过后选择唯一业务动作；
12. **fallback guard**：无匹配 ⇒ `blocked(no-policy-match)`，绝不问 Agent 怎么办。

fixed guard 也产生 trace node，界面能解释“为什么没有进入你的第一条规则”。

### 4.4 WorkSelectionReceipt

action rule 只选择 capability，平台随后用该 capability 的固定 selector 和 policy 参数生成精确 work set：

```ts
interface WorkSelectionReceipt {
  readonly ref: WorkSelectionReceiptRef
  readonly capabilityId: AgentCapabilityId
  readonly inputFactDigest: string
  readonly orderingRuleId: string
  readonly itemRefs: readonly string[]
  readonly digest: string
}
```

feedback 按 author class/created revision/thread ref，pipeline 按 required/失败类别/gate key，verification 按 step/failure
ref 做稳定排序并应用 batch limit。selector 不读正文，不调用 Agent。空 work set 不启动 Agent；回到 evaluator 产生
wait/ready/下一动作。ActionRun、input manifest 和 semantic validator都绑定同一 work-set digest，Agent 不能自行挑掉
难处理的评论或错误。

### 4.5 Decision 联合

```ts
type NextDecision =
  | { readonly kind: 'materialize-direct-requirement'; readonly submissionRef: string }
  | { readonly kind: 'collect-external-requirement'; readonly adapterBindingRef: string }
  | { readonly kind: 'seed-repository-uploads'; readonly uploadPlanRef: RepositoryUploadPlanRef }
  | {
      readonly kind: 'publish-requirement-questions'
      readonly questionSetRef: string
      readonly channel: 'platform' | 'requirement-source'
    }
  | {
      readonly kind: 'collect-requirement-answers'
      readonly questionSetRef: string
      readonly adapterBindingRef: string
    }
  | { readonly kind: 'collect-repository-facts' }
  | { readonly kind: 'collect-mr-facts' }
  | { readonly kind: 'collect-pipeline-evidence'; readonly gateKeys: readonly string[] }
  | {
      readonly kind: 'run-agent-action'
      readonly capabilityId: AgentCapabilityId
      readonly templateRef: VersionedResourceRef
      readonly workSetRef: WorkSelectionReceiptRef
    }
  | { readonly kind: 'run-verification'; readonly profileRef: string }
  | { readonly kind: 'request-human-decision'; readonly gate: 'no-change-confirmation' }
  | { readonly kind: 'prepare-change-candidate' }
  | {
      readonly kind: 'commit-and-publish-candidate'
      readonly publicationMode: 'new-branch' | 'fast-forward'
    }
  | { readonly kind: 'ensure-merge-request' }
  | { readonly kind: 'reply-feedback'; readonly feedbackReceiptRef: string }
  | { readonly kind: 'trigger-pipeline'; readonly gateKeys: readonly string[] }
  | { readonly kind: 'rerun-pipeline'; readonly gateKey: string; readonly runRef: string }
  | { readonly kind: 'publish-readiness' }
  | {
      readonly kind: 'wait'
      readonly reason: WaitReason
      readonly resumeAt: string | null
      readonly wakeSources: readonly ('webhook' | 'pipeline' | 'requirement' | 'timer' | 'manual')[]
      readonly attemptOrdinal: number
    }
  | { readonly kind: 'handoff'; readonly reason: HandoffReason }
  | { readonly kind: 'mark-ready-to-merge' }
  | {
      readonly kind: 'mark-terminal'
      readonly terminal: 'merged' | 'closed-unmerged' | 'completed-no-change' | 'canceled'
    }
  | { readonly kind: 'block'; readonly reason: MissionBlockCode }
```

这里没有“执行任意 capability”“执行任意 code-host action”或“运行某段脚本”。每个 decision arm 在
`actionCatalog.ts` 映射到一个固定 handler，并有 exhaustiveness test；新增 arm 必须同步 authority、状态转移、
effect、恢复和测试。

`commit-and-publish-candidate` 在业务上是一个 decision，在机制上拆成 prepare/commit/push 三份 durable effect
receipt；不能把网络 push 放进 DB transaction。

### 4.6 DecisionReceipt 与可回放性

```ts
interface DecisionReceipt {
  readonly id: string
  readonly missionRef: MissionRevisionRef
  readonly policyRef: VersionedResourceRef
  readonly employeeRef: VersionedResourceRef
  readonly factSnapshotRef: MissionFactSnapshotRef
  readonly factDigest: string
  readonly workSetRef: WorkSelectionReceiptRef | null
  readonly guardTrace: readonly GuardTraceNode[]
  readonly ruleTrace: readonly RuleTraceNode[]
  readonly selected: NextDecision
  readonly canonicalDigest: string
  readonly decidedAt: string
}
```

`canonicalDigest` 只覆盖 policy/employee/facts/work-set/guard trace/rule trace/selected decision 的 canonical core；
receipt id 与 `decidedAt` 不参与。replay oracle 比较这个 core 的 bytes，避免把时钟/数据库 id 混进确定性结论。

trace 记录每条被评估 rule 的 `ruleId/matched/firstFailedPredicateId`，不复制敏感事实正文。规则顺序是配置
的一部分；保存时 canonicalize，重放测试对 canonical bytes 而非对象深相等。

Decision commit 与 ActionIntent/effect intent 在一个 DB transaction 中完成，随后 outbox worker 执行。worker
以 decision id 派生 idempotency key；重启不会重新做已 receipt 的副作用。

### 4.7 默认 MR care 顺序

默认 policy（不是硬编码唯一策略）在 fixed guards 后按以下 first-match：

1. 新的可处理 feedback revision；
2. conflict（按 `repair`/`report-only` policy）；
3. required gate fail：先程序判定可安全 rerun，再选择 repair；
4. candidate 尚未本地验证；
5. candidate 已验证但未发布；
6. MR facts/pipeline evidence 过期；
7. machine holds 清零：发布 readiness；
8. human holds：wait committer；
9. host mergeable：ready-to-merge。

组织可以调整 feedback/conflict/CI 的相对顺序和分类规则，但不能把 stale、terminal、no-merge 等 fixed guard
放到后面。

### 4.8 失败分类、durable wait 与 handoff

这里必须区分两件事：**业务问题**（MR 为什么需要处理）和**执行故障**（某次 Agent/script/adapter 为什么没跑成）。
前者由员工可配置 producer 产出并进入处理规则；后者使用平台 closed taxonomy 决定重试/阻断，不能混成一个字符串。

#### 4.8.1 MR 业务问题、producer 与 handler

```ts
interface ProblemTypeDefinition {
  readonly typeId: string
  readonly displayName: string
  readonly evidenceDomain: 'pipeline' | 'verification' | 'feedback' | 'conflict' | 'mr'
  readonly repairable: boolean
  readonly priority: number
  readonly unknownFallback: boolean
}

interface ProblemProducerDefinition {
  readonly producerId: string
  readonly displayName: string
  readonly kind: 'agent' | 'script'
  readonly implementationRef: VersionedResourceRef
  readonly evidenceDomains: readonly ProblemTypeDefinition['evidenceDomain'][]
  readonly allowedTypeIds: readonly string[]
  readonly when: readonly FactPredicate[]
  readonly retry: { readonly sameScene: number; readonly freshScene: number }
  readonly fallbackProducerId: string | null
}

interface ProblemHandlingRule {
  readonly ruleId: string
  readonly typeId: string
  readonly when: readonly FactPredicate[]
  readonly handler:
    | { readonly kind: 'agent'; readonly implementationRef: VersionedResourceRef }
    | { readonly kind: 'script'; readonly implementationRef: VersionedResourceRef }
  readonly verifyStepIds: readonly string[]
  readonly retry: { readonly sameScene: number; readonly freshScene: number }
  readonly fallbackRuleId: string | null
}
```

producer 输入不是 provider JSON、评论全文或命令行参数，而是 exact-head 的只读 evidence descriptor + 本 employee revision
的 `allowedTypeIds`。Agent producer 使用 read-only workspace；script producer 使用 readonly script node。两者输出同一个
小 envelope：

```ts
interface ProblemSetEnvelopeV1 {
  readonly protocolVersion: 1
  readonly nonce: string
  readonly actionRunRef: string
  readonly inputDigest: string
  readonly producerId: string
  readonly evidenceDigest: string
  readonly headSha: string
  readonly complete: boolean
  readonly problems: readonly {
    readonly problemRef: string
    readonly typeId: string
    readonly subjectRefs: readonly string[]
    readonly summary: string
  }[]
}
```

semantic validator 必须证明：header 与 frozen input 一致；`typeId` 属于 producer allowlist 和员工 problem catalog；
`subjectRefs` 属于 pipeline gate / verification failure / feedback revision / conflict hunk 的输入闭集；required subject 全覆盖或
`complete=false`；`problemRef` 唯一且 canonical digest 可重放。只有通过后才投影 `problem.typeIds`、`problem.refsByType`
等 typed facts。自由 summary 只用于诊断，不参与规则。

规则解释器按 `(type priority, subjectRef, problemRef)` 生成 `ProblemWorkSelectionReceipt`，再按有序 handling rules 选唯一
handler。script/Agent handler 都只得到选中的 problem refs、exact evidence 和 capability envelope；不允许自己扩展工作集、
选下一个 handler 或宣称验证通过。真实 workspace delta 经 source-control participant 推导，程序化 verification 后重采 MR/
pipeline 证据。unknown/no-match 固定 block/handoff；只有发布时已验证的 fallback producer/rule 才可切换。

#### 4.8.2 子数字员工、跨仓库与外部审批 saga

跨仓修复和外部审批不是 Agent tool call，而是 `DevelopmentMission` 拥有的持久化 saga。父 Mission 只创建 intent、读取
receipt 和按员工说明书汇合；子员工继续走完整的 admission → TaskEngine → source-control → MR care 链，审批程序继续走
integration required port。任何一步都不能共享父 Mission 的可写 workspace、Agent session、Git branch 或 MR claim。

```ts
interface ChildMissionIntent {
  readonly parentMissionRef: MissionRevisionRef
  readonly parentStepRunRef: StepRunRef
  readonly targetRepositoryRef: RepositoryRef
  readonly targetEmployeeRef: VersionedResourceRef
  readonly inputEnvelopeRef: TypedArtifactRef
  readonly completion: 'automation-ready' | 'ready-to-merge' | 'merged' | 'completed'
  readonly deadlineAt: string
  readonly idempotencyKey: string
  readonly ancestry: readonly DevelopmentMissionRef[]
}

interface ChildMissionReceipt {
  readonly intentDigest: string
  readonly childMissionRef: DevelopmentMissionRef
  readonly childRevision: number
  readonly observedStatus: MissionStatus
  readonly completionSatisfied: boolean
  readonly outputEnvelopeRef: TypedArtifactRef | null
  readonly observedAt: string
}

interface ApprovalRequestDraftEnvelopeV1 {
  readonly protocol: 'aw-approval-request-draft@1'
  readonly nonce: string
  readonly stepRunRef: StepRunRef
  readonly inputDigest: string
  readonly approvalType: string
  readonly title: string
  readonly bodyArtifactRef: TypedArtifactRef
  readonly evidenceRefs: readonly TypedArtifactRef[]
  readonly requestedScopes: readonly string[]
}

interface ApprovalSubmitIntent {
  readonly stepRunRef: StepRunRef
  readonly adapterRef: VersionedResourceRef
  readonly validatedDraftRef: TypedArtifactRef
  readonly deadlineAt: string
  readonly idempotencyKey: string
}

interface ApprovalReceipt {
  readonly intentDigest: string
  readonly correlationRef: string
  readonly externalRequestRef: string
  readonly submittedRevision: string
  readonly submittedAt: string
}

interface ApprovalObservationReceipt {
  readonly correlationRef: string
  readonly observedRevision: string
  readonly status: 'pending' | 'approved' | 'rejected' | 'expired' | 'unavailable'
  readonly evidenceRef: TypedArtifactRef | null
  readonly observedAt: string
}
```

父子 Mission 的幂等键固定为
`digest(parentMissionId, parentEpoch, stepId, stepAttempt, targetRepositoryRef, employeeRevision, inputDigest)`。重放先按键查询
既有 child，绝不再次 launch。创建 child 时同时写 `development_mission_links` 与 child admission intent；两者必须同事务
提交。目标 employee/repository/policy 权限、目标仓可写性和调用预算在创建前全部重验。`ancestry` 只存 opaque mission ref；
静态调用图检查之外，运行时拒绝 ancestry 重复、超过最大深度或超过父 Mission 的总 child 数/总 wall-time 预算。

child 达到配置的 completion 只产生一个 observation receipt，不把 child diff 合并进父 workspace。若 child 在另一仓产生
MR，父任务最多引用其 MR/receipt；该 MR 仍由其 committer 审核合入。父任务取消或 handoff 时只 fence 新 child intent，
已经创建的 child 默认转 tracking-only 并继续观测；只有员工说明书显式声明且调用方拥有 child cancel 权时才能发送独立
cancel 命令，绝不因父状态变化删除 child branch/MR。

审批固定拆成三步：

1. `approval.prepare` 是 Agent 或 script 的只读/有限写动作，只能产出 `ApprovalRequestDraftEnvelopeV1`；semantic validator
   对拍 nonce、input digest、evidence allowlist 和 approval type，Agent 无 credential，无法提交。
2. `approval.submit` 是 integration effect。adapter purpose 必须为 `approval-gateway` 且声明 `submit + lookup-by-idempotency-key`；
   响应丢失先 lookup/adopt，只有能证明未提交才能重发。
3. `approval.observe` 是一次短调用，adapter 必须声明 `observe`。返回 `pending` 时保存 receipt 后 arm durable wake，释放
   script/Agent/工作区；webhook 只记 correlation wake hint，reconcile 后重新 observe 权威状态。没有 webhook 时按配置的
   `resumeAt` 周期短调用，绝不保持长驻进程。

`approved` 只满足这一审批步骤，不等于 MR approval，也不解锁平台的 merge/approve 能力；`rejected/expired/unavailable`
按 `StepFailureRule` 精确分支。多 child/审批汇合由 `development_step_joins` 保存每个成员的 exact receipt revision，按
`all | any | quorum(n)` 纯函数求值。`any/quorum` 达成后剩余成员不被伪造为成功；它们转 observation-only，最终状态仍进入
任务详情。deadline 到达时只执行已发布的 `onDeadline/onPartial`，缺失分支固定 block。

RFC-294 落位：

- `development-automation/domain` 拥有 step/child/join/saga 状态机与纯编译器；application 拥有 create/adopt/observe intent；
- `task-execution` 仍是 Agent/script 的唯一执行链，不知道“审批”或“父子任务”的业务语义；
- `integration` 拥有 `ApprovalGatewayPort` 的 provider adapter、connection、credential 与 provider codec；
- `source-control` 分别管理父子仓各自 workspace/candidate/MR，不提供跨仓可写 workspace；
- bootstrap 只注入 `ChildMissionPort`/`ApprovalGatewayPort`，不得写按 step kind 分支的业务代码。

#### 4.8.3 平台执行故障

所有 program/adapter/task/source-control/effect 失败先映射到 closed receipt：

```ts
type OperationFailureCategory =
  | 'transient'
  | 'stale-input'
  | 'configuration'
  | 'permission'
  | 'invalid-user-input'
  | 'business-failure'
  | 'contract-violation'

interface OperationFailureReceipt {
  readonly category: OperationFailureCategory
  readonly code: string
  readonly retryability: 'same-input' | 'after-refresh' | 'after-configuration' | 'never'
  readonly attemptOrdinal: number
  readonly remediation: RemediationCode
  readonly evidenceRef: string | null
}
```

规则只读这些 closed fields：transient 可按 durable backoff 重试；stale 先 refresh；configuration/permission/input
进入带明确 remediation 的 block 或 tracking-only；business failure 可选 repair；contract violation 隔离对应
template/adapter revision。provider/Agent 的自由错误文字不决定 retry。

`wait` 必须有 `resumeAt` 或至少一个真实外部 wake source；两者都没有的 decision 在 policy publish 时拒绝。等待写
`development_deferred_wakes` 并进入 managed job registry，daemon 重启不重置 ordinal/deadline。到 deadline 后 policy
只能继续有界 retry、block 或 handoff，不能再产一个无限 wait。

handoff 命令先 bump epoch、写 transition fence并终止 Agent/未 dispatch intent；已经 dispatch 或结果未知的外部 effect
必须先查询并结算，期间 UI 显示 `handoff-pending`。确认不会遗失 push/comment/pipeline run 后才把
`automationMode` 改为 tracking-only并保留 MR claim。人工 push 会像其他 external head 一样被采集，但不会自动恢复
写；授权 resume 先刷新全部 facts/budgets，再 bump epoch并重新决策。
若 handoff 时尚无 MR，Mission 显示 `waiting-for-mr-attachment`，用户完成手工实现后可提交
`AttachMergeRequestToMission`；平台主动校验 repo/source/target/current head 与唯一 claim 后转为 adopt delivery并继续
tracking。若所挂 MR 已 merged/closed，命令在同一 reconciliation 中记录 binding 与 authoritative terminal receipt，
不要求 source branch 仍可写，也不启动任何 action。不能在已有 publish/MR intent 未结算时绑定另一个 MR。

## 5. RequirementBundle 与 RepositoryUploadPlan：直接输入、外部 ID 和仓库落点

### 5.1 入口合同

```ts
type RequirementSubmission =
  | {
      readonly kind: 'direct'
      readonly title: string
      readonly body: string | null
      readonly uploads: readonly DirectRepositoryUpload[]
    }
  | {
      readonly kind: 'external-reference'
      readonly sourceKey?: string
      readonly externalId: string
    }

interface DirectRepositoryUpload {
  readonly uploadRef: UploadedArtifactRef
  readonly repositoryTargetPath: RepoRelativePath
  readonly collisionMode?: 'create-only' | 'replace-existing'
  readonly contentPolicy?: 'preserve-upload' | 'agent-editable'
  readonly fileMode?: 'regular' | 'executable'
}
```

`direct` 的 cross-field validator 要求 `body.trim()` 非空或 `uploads.length > 0`；因此正文-only、文件-only、正文+文件
都是合法首版入口。每个上传项必须带最终仓库相对目标路径，不接受只有文件名后再让 Agent 决定放哪里。上传临时
artifact 在 Mission admission 事务中被 claim，失败/放弃的 upload session 按 TTL 回收，业务合同只保存 immutable blob
ref/digest，不保存浏览器临时路径。
同一 submission 的 uploadRef 与规范化 target path 都必须唯一；底层相同内容可按 digest 去重，但一个上传 ownership
receipt 不隐式展开成多个目标。直接上传始终按单个 regular file 原样处理，不自动解压 archive；要提交多文件就逐文件
上传并逐项指定目标，不能让平台或 Agent 猜压缩包内部落点。

`LaunchDevelopmentMission.repositoryRef` 是独立且必填的任务 scope；“只给 external ID”表示在已选仓库下无需再粘贴正文/
附件，不表示由 Agent 猜仓库。若未来要支持全局 ID 自动定位仓库，必须新增 integration-owned locator contract，返回
可验证的 stable repository keys，再由唯一 mapping rule 解析；0/多结果都交人。本 RFC 首版不把该循环藏进
requirement.analyze 或 employee selection。

`sourceKey` 只用于在已 pin 的员工与 policy 范围内解析唯一 `AdapterDefinitionRef`；省略时使用 exact repository
assignment default，再使用员工中唯一标记的 default source。0 个结果是
`blocked(requirement-source-unresolved)` 配置问题；多个合法结果进入 `awaiting-information`，read model 只展示 actor
可见的 sourceKey/label，用户用 `SelectMissionRequirementSource` 选择 key。命令只能从该 Mission pinned employee 的
候选集中解析 adapter revision，不能提交 executable path、adapter ref、command 或 secret；OCC 成功后写
`ResolvedRequirementSource` receipt并恢复 acquisition。重复选择同 key 幂等，不同 key 必须显式 refresh/upgrade，不能
在下载中途偷换来源。
externalId 通过解析后 adapter 的专用 codec 校验长度/字符/租户 scope，再进入程序。

### 5.2 取得流程

直接输入不经过 IntegrationAdapter。初始 Mission transaction 只原子 claim upload blobs 并保存 immutable submission；
等 repository.inspect、employee selection、完整 policy closure 和 delivery baseline 都已 pin 后，application 才解析默认/
允许的 upload modes、规范化正文并一次性产生同源的
`RequirementBundleRef` 与可选 `RepositoryUploadPlanRef`：

```text
DirectRequirementSubmission
  → validate body-or-files + claim upload session
  → normalize body as generated requirement.md
  → import body/upload blobs into immutable evidence
  → inspect target paths against frozen repository baseline
  → commit RequirementBundle + RepositoryUploadPlan atomically
```

正文只生成 evidence 中的 `files/requirement.md`，默认**不**写进业务仓库；若用户也希望仓库保存该正文，必须把它作为
一个显式上传文件并指定目标路径。上传文件在 bundle 中使用稳定的
`files/uploads/<ordinal>/<normalized-original-name>`，不直接镜像 repository target，以免两个命名域的碰撞/保留路径规则
互相污染；真实落点只来自 manifest 的 `repositoryPlacement` 与 RepositoryUploadPlan。

外部 ID 才走 requirement adapter：

```mermaid
sequenceDiagram
  participant M as Mission
  participant I as Integration adapter runner
  participant S as One-shot bundle sink
  participant E as Evidence store
  participant T as Task workspace materializer
  M->>I: RequirementAcquireIntent(adapter revision, external id, sink capability)
  I->>S: write staged files + adapter envelope
  I-->>M: source revision + declared descriptors
  S->>E: close, safe-walk, redact, hash, atomically import
  E-->>M: RequirementBundleRef + manifest digest
  M->>T: materialize opaque ref for ActionRun
  T-->>M: workspace mount receipt
```

adapter 进程只能写 one-shot staged root；sink close 后 token 失效。Evidence store 重新 safe-walk，不相信 adapter
声明的 file count/size/digest。成功 import 后 staged root 删除；失败则 quarantine 到受限诊断区并按 TTL 清理，
不会留在业务 worktree。

直接输入的正文和上传文件也必须经过同一 EvidenceStore importer、预算与 manifest digest，不允许 HTTP route 把
browser temp path 直接传给 ActionRun。区别只是 producer 是受信 application materializer，而不是外部 adapter。
RepositoryUploadPlan 永远引用原始 immutable upload blob/digest；RequirementBundle 若按 evidence policy 生成 redacted
派生副本，manifest 必须保留到原 fileId 的 lineage。平台不得把 redacted/转码/换行归一后的派生内容悄悄提交到仓库；
仓库内容策略不接受原字节时只能在 seed 前 block 并给出诊断。

### 5.3 manifest

物化到 Agent action workspace：

```text
.agent-workflow/inputs/requirements/<bundleId>/
  manifest.json
  files/<normalized-relative-path>...
```

```ts
interface RequirementBundleManifestV1 {
  readonly schemaVersion: 1
  readonly bundleId: string
  readonly source:
    | { readonly kind: 'direct'; readonly submissionId: string }
    | {
        readonly kind: 'external'
        readonly sourceKey: string
        readonly externalId: string
        readonly sourceRevision: string
      }
  readonly title: string
  readonly fetchedAt: string
  readonly complete: boolean
  readonly files: readonly {
    readonly fileId: string
    readonly ordinal: number
    readonly relativePath: string
    readonly role: string
    readonly mediaType: string
    readonly bytes: number
    readonly sha256: string
    readonly redaction: 'none' | 'applied' | 'failed'
    readonly repositoryPlacement: {
      readonly targetPath: RepoRelativePath
      readonly contentPolicy: 'preserve-upload' | 'agent-editable'
    } | null
  }[]
  readonly totals: { readonly files: number; readonly bytes: number }
  readonly writebackRef: string | null
  readonly manifestDigest: string
}
```

Manifest 由平台生成，按 `ordinal,fileId` 稳定排序。`manifestDigest` 的计算不包含自身字段。Agent prompt 只给
workspace-relative manifest path、digest、信任边界和按需读取说明，不拼接文件正文。

`writebackRef` 是 opaque integration ref；Agent 只能返回问题，不能使用它。平台根据 policy 把 questions 交给
collaboration/platform，或经 `RequirementInteractionPort` 发回声明了 `questions.writeback` operation 的内建需求
系统。该 effect 同样有 intent/idempotency/receipt/reconcile，Agent 不得到 adapter 或 writeback capability。

澄清使用不可变 question/answer set，而不是把评论正文随手拼回 prompt：

```ts
interface RequirementQuestionSet {
  readonly questionSetRef: string
  readonly missionRevision: number
  readonly inputDigest: string
  readonly questions: readonly { readonly questionId: string; readonly text: string }[]
  readonly channel: 'platform' | 'requirement-source'
}

interface RequirementAnswerSet {
  readonly questionSetRef: string
  readonly answerRevision: string
  readonly answers: readonly { readonly questionId: string; readonly answer: string }[]
  readonly complete: boolean
  readonly digest: string
}
```

原渠道 writeback 带 machine correlation；webhook/poll 仍只唤醒，`collectAnswers` 主动取得 exact answer revision。
answer 必须覆盖当前 question ids，未知/旧 set/重复 revision 不恢复 Mission。平台回答走同一 AnswerSet codec。
答案 commit 后产生新 input digest，旧 analysis/action invalidated，再由规则决定继续分析还是实现；澄清轮数/超时由
policy 限制。

Agent 的 `needs-information` 只形成待发布 QuestionSet，不直接改变 Mission 状态。evaluator 必须先提交
`publish-requirement-questions` decision；平台 channel 在本地事务确认，原渠道则等幂等 effect receipt，之后才进入
`awaiting-information`。平台答案由 `SubmitMissionAnswers` 写入；原渠道 wake 产生
`collect-requirement-answers` decision。这样 question publish/answer collect 的崩溃重放与其他外部 effect 使用同一
intent/receipt 语义，不存在 port 已定义但状态机无法选择它的旁路。

### 5.4 RepositoryUploadPlan 与仓库落点

直接上传文件有两份用途不同但同源的不可变投影：`RequirementBundle` 是给 Agent 读取的需求证据，
`RepositoryUploadPlan` 是平台必须落实到仓库改动的写入计划。Agent 不负责从 evidence 目录复制文件，也不能改变目标路径。

```ts
interface RepositoryUploadPlan {
  readonly planRef: RepositoryUploadPlanRef
  readonly missionRevision: number
  readonly repositoryRef: RepositoryRef
  readonly baselineSnapshotRef: RepositorySnapshotRef
  readonly baselineSha: string
  readonly entries: readonly RepositoryUploadPlanEntry[]
  readonly planDigest: string
}

interface RepositoryUploadPlanEntry {
  readonly ordinal: number
  readonly fileId: string
  readonly uploadBlobRef: OpaqueBlobRef
  readonly uploadSha256: string
  readonly repositoryTargetPath: RepoRelativePath
  readonly contentPolicy: 'preserve-upload' | 'agent-editable'
  readonly targetFileMode: 'regular' | 'executable'
  readonly expectedTarget:
    | { readonly kind: 'absent' }
    | {
        readonly kind: 'exact-file'
        readonly sha256: string
        readonly fileMode: 'regular' | 'executable'
      }
    | {
        readonly kind: 'already-present'
        readonly sha256: string
        readonly fileMode: 'regular' | 'executable'
      }
}

interface RepositoryUploadPlacementReceipt {
  readonly planRef: RepositoryUploadPlanRef
  readonly planDigest: string
  readonly baselineSnapshotRef: RepositorySnapshotRef
  readonly seedChangeRef: SeedChangeRef | null
  readonly seedTreeDigest: string
  readonly entries: readonly {
    readonly fileId: string
    readonly repositoryTargetPath: RepoRelativePath
    readonly disposition: 'created' | 'replaced' | 'already-present'
    readonly beforeSha256: string | null
    readonly seededSha256: string
    readonly seededFileMode: 'regular' | 'executable'
  }[]
}

interface RepositoryUploadPublicationReceipt {
  readonly planRef: RepositoryUploadPlanRef
  readonly placementReceiptRef: RepositoryUploadPlacementReceiptRef | null
  readonly fulfillment:
    | { readonly kind: 'platform-publish'; readonly publishReceiptRef: SourcePublishReceiptRef }
    | {
        readonly kind: 'baseline-observed'
        readonly observationReceiptRef: SourceTreeObservationRef
      }
    | {
        readonly kind: 'external-observed'
        readonly observationReceiptRef: SourceTreeObservationRef
      }
  readonly commitSha: string
  readonly entries: readonly {
    readonly fileId: string
    readonly repositoryTargetPath: RepoRelativePath
    readonly publishedSha256: string
    readonly publishedFileMode: 'regular' | 'executable'
    readonly repositoryBlobId: string
  }[]
  readonly digest: string
}
```

用户提交的 `collisionMode` 在 admission 对冻结 baseline 解析为 `expectedTarget`：

- `create-only`：目标缺失时冻结为 `absent`；目标内容和 mode 都与有效输入相同时冻结为 `already-present`；已存在且
  内容/mode 不同、目录、symlink 或 submodule 都阻断。
- `replace-existing`：只接受已存在的普通文件，并冻结其原 digest 为 `exact-file`；原内容与上传相同则归一为
  `already-present`（mode 也必须等于有效 mode）。未指定 fileMode 时保留 baseline mode；发布者不能用“replace”盲盖
  后续的人类内容或 mode 修改。
- 每个规范化目标在计划内唯一，且任意两项不能形成 file/descendant 前缀冲突（如 `a` 与 `a/b`）。绝对路径、空路径、
  `.`/`..`、平台保留路径、checkout 文件系统上的 Unicode/case-fold collision，以及父目录被普通文件、symlink/submodule
  占用都在 Agent 启动前拒绝；缺失的普通父目录由平台确定性创建但不作为独立 Git 内容。

source-control preflight 还要冻结该路径的 Git 语义：普通 `.gitignore` 不能让用户明确上传的 entry 消失，candidate
以计划中的 exact path 显式纳入；RFC-308 hard exclude、平台保留路径和 submodule 边界仍固定拒绝。sparse checkout 必须由
平台在内部 workspace 扩到该 path 或 admission block，不能假装 seed 成功。首版对 LFS/external clean filter、
`working-tree-encoding` 等无法在本地证明 byte round-trip 的目标 fail closed；未来只有 source-control 新增 typed
filter capability、对象上传 receipt 与 round-trip validator 后才能开放。

`uploadSha256` 定义为用户上传/业务 workspace 的字节 digest。对 `preserve-upload`，source-control 在 candidate prepare
后用 disposable materialization 验证“commit tree → checkout”的目标字节与 mode 仍等于上传计划，并在 receipt 同时记录
repository blob id 与 checkout SHA-256；因此 EOL/filter 转换不能让界面显示“已保留”而 Git 中实际不可还原。

`planDigest` 覆盖 repository、baseline、entry 顺序、blob digest、目标路径、expectedTarget、targetFileMode 与 contentPolicy。计划成功提交后
不可修改；首版若要改文件、路径或策略，必须 cancel 当前 Mission 并从 preview 重新 launch。未来即使增加 amend command，
也只能生成新的 Mission revision/plan 并显式展示会失效的 analysis/action/candidate，不能原地改 entry。

`change.seed-uploads(program)` 调用 `RepositoryUploadPlacementPort`，在 source-control 管理的业务 overlay 中应用计划并生成
`SeedChangeRef`。后续 Action workspace 都从 `baselineSnapshotRef + optional SeedChangeRef` 物化；fresh-session 重跑也必须重建同一
组合并对拍 `seedTreeDigest`，而不是依赖上一次临时目录残留。该动作不创建 commit/ref、不修改 publication workspace 的
持久 index，也不经过 Agent；source-control 可在自己的隔离 scratch 中使用临时 Git mechanics，但只向上返回 opaque receipt。
若全部 entry 都是 `already-present`，receipt 的 `seedChangeRef=null`，并从 baseline tree 写
`baseline-observed` fulfillment；不能为了让类型好看生成一份伪 change。
DecisionReceipt + placement ActionIntent 先在 DB transaction 提交，文件系统调用在事务外执行；回写时对拍 mission
epoch/plan/baseline。cancel/handoff fence 后未 dispatch 的 placement 作废，已 dispatch 的先按 seed digest settle/revoke，
不能把一个结果未知的业务 overlay 留给后续 Action 继续用。

placement 对相同 `planDigest + baselineSnapshotRef` 幂等：重复 dispatch 必须返回同一 seed digest，或在无法证明复用时从
baseline 重建后得到 byte-identical 结果。它不能在既有临时 workspace 上叠加第二遍。最终 workspace validator 再执行
内容策略：

- `preserve-upload`：目标从 Agent write allowlist 中扣除，且目标必须存在、digest 仍等于 `uploadSha256`；文件 API
  修改/删除被 workspace boundary 拒绝，退出后的独立 validator 再对拍一次；
- `agent-editable`：目标必须仍存在于 candidate，允许最终 digest 改变，但 receipt 同时记录上传与最终 digest；
- 两种 content policy 都要求最终 Git mode 等于 `targetFileMode`；内容可编辑不等于 Agent 可自行改 executable bit。
- `already-present` 不产生伪 diff；如果所有 entry 都是 already-present 且没有其他改动，只能走程序证明的
  `completed-no-change`，不能制造空 commit；只要任一 entry 为 created/replaced，就禁止以 no-change 结束。

在**首次确认 publish 前**，placement、candidate prepare 和 publish 都重新对拍 Mission 的 exact baseline/head 与每个
`expectedTarget`。human push 或新 baseline 会让旧 `SeedChangeRef`/ActionRun/candidate 失效；reconciler 在新 baseline 上
重新解析整份计划。目标仍满足时生成新 plan revision/seed receipt；不满足则按 policy
`blocked(repository-upload-target-changed)` 或 handoff，绝不静默覆盖或自动套用旧 overlay。

平台首次 CAS push 成功后，在确认 publish receipt 的同一 Mission transition 中写
`RepositoryUploadPublicationReceipt`：seed 自此已经被该 commit 吸收到 source head，后续 feedback/CI/conflict action 以
新 source head 为 baseline，**不得再次应用 create/replace 计划**。若 push 已成功但 DB receipt 丢失，恢复先按 remote
commit/tree、candidate digest 与 machine marker 对拍并补 publication receipt，不能因目标现在“已存在”而误判冲突或重复提交。
`platform-publish` receipt 的 placement ref 必填；只有经 authoritative tree 验证的 `baseline-observed`/
`external-observed` 才允许为 null。

publication 后保留的是 path/content lineage：`preserve-upload` 的自动化 candidate 仍必须保持上传 digest；
`agent-editable` 可沿后续动作演进但目标不得删除。若人类 push 改了 preserve 文件或删除 editable 目标，平台承认外部 head
为事实，但自动写转为 block/handoff，不把旧上传静默写回。这样平台自己的正常 head 前进不会错误触发 plan CAS，外部修改
又不会绕过用户指定的落点合同。

handoff/tracking-only 后平台不再自动 placement/publish，但 upload plan 仍是 Mission 的交付约束。人工 push 或 attach MR
时，source-control 主动读取 authoritative commit tree；逐项满足 preserve/editable path+mode 合同时可写
`external-observed` fulfillment receipt，之后与平台发布相同地只跟踪 lineage。未满足时保持
`waiting-for-upload-fulfillment`/blocked，不能因为 MR 存在甚至已合入就把上传要求静默丢掉。

Requirement manifest 中每个直接上传文件额外携带只读的 `repositoryPlacement = { targetPath, contentPolicy }`，让 Agent
理解该文件在业务 workspace 中的正式位置和保持规则；碰撞前提与 baseline digest 不放进 prompt，由平台 validator 掌握。

### 5.5 安全与预算

固定拒绝：absolute path、`..`、NUL/control char、Unicode normalization collision、symlink、hardlink escape、
device/socket/FIFO、nested archive bomb、未知 compression codec、manifest/file mismatch。预算至少包括：

- 文件数、单文件字节、总字节、路径长度、目录深度；
- 解压比例、archive nesting、文本探测上限；
- adapter wall time、stdout/envelope 字节；
- redaction failure policy（默认整个 bundle blocked，不静默漏文件）。

二进制材料可以保留并在 manifest 标注，但只有模板显式允许的媒体类型会挂给 Agent。所有 requirement roots
在 Agent namespace 中只读；任何写入都属于 boundary violation。

### 5.6 refresh 与失效

外部 source revision 改变不会覆盖原目录。`requirement.acquire` 产生新 immutable bundle revision；refresh 先生成
失效面：旧分析、clarification answer、未发布 candidate、verification、ActionRun 与 readiness。mode 为：

- `manual`：显示新 revision，等待授权 refresh；
- `auto-before-first-push`：尚无外部 commit/effect 时自动 refresh，已有 MR 后交人；
- `auto`：按规则 refresh 并从新 input digest 重跑，但从不改写已发布历史。

requirement-source webhook/轮询只提供 revision wake，平台主动 collect 后才认新 revision。source 被撤回/关闭也只是
typed fact；policy 可 cancel/handoff，不能让 adapter 直接终止 Mission。

同一 fresh-session rerun 必须重新物化**相同 bundle ref/digest**，不能顺手 refresh。否则所谓重跑不是相同现场。

## 6. PipelineEvidenceBundle：自建门禁与大日志

### 6.1 Provider 合同

DigitalEmployee/Policy 按 repository scope 绑定一个或多个 `pipeline-gate` adapter。adapter 负责调用自建程序并把
provider 语义翻译成 closed gate facts；它不能决定“修”“重跑”“忽略”或“ready”。

```ts
interface PipelineCollectIntent {
  readonly adapterRef: VersionedResourceRef
  readonly repositoryRef: RepositoryRef
  readonly mergeRequestRef: MergeRequestRef
  readonly expectedHeadSha: string
  readonly expectedTargetSha: string
  readonly requiredGateKeys: readonly string[]
  readonly evidenceSink: PipelineEvidenceSinkCapability
}
```

required port 不携带 provider URL/token/path。integration adapter 从自身 connectionRef 解析这些信息，并以最小
secret projection 启动程序。

### 6.2 两次 head fence

收集不是一次“下载日志”调用：

```text
collect code-host MR head/target H1/T1
  → call provider and stream files into staged sink
  → parse adapter envelope + safe import
  → collect code-host MR head/target H2/T2
  → require H1=H2=providerHead=expectedHead and T1=T2
  → otherwise discard snapshot and schedule recollect
```

provider 不能提供 head 绑定时，receipt 是 `completeness='partial'`，绝不判 pass。target head 改变会让 conflict/
mergeability 与 readiness 失效；即使 source head 没变也要重采。

### 6.3 manifest 与目录

```text
.agent-workflow/pipeline/<bundleId>/
  manifest.json
  logs/<gate-or-job>/...
  reports/...
  artifacts/...
```

```ts
type GateStatus =
  | 'queued'
  | 'running'
  | 'pass'
  | 'fail'
  | 'canceled'
  | 'skipped'
  | 'unknown'
  | 'unavailable'

interface PipelineEvidenceManifestV1 {
  readonly schemaVersion: 1
  readonly bundleId: string
  readonly providerKey: string
  readonly headSha: string
  readonly targetSha: string
  readonly completeness: 'complete' | 'partial'
  readonly gates: readonly {
    readonly gateKey: string
    readonly required: boolean
    readonly status: GateStatus
    readonly runRef: string
    readonly attempt: number
    readonly finishedAt: string | null
    readonly retryability: 'safe' | 'unsafe' | 'unknown'
    readonly failureCategories: readonly PipelineFailureCategory[]
    readonly evidenceFileIds: readonly string[]
  }[]
  readonly files: readonly EvidenceFileDescriptor[]
  readonly totals: { readonly files: number; readonly bytes: number }
  readonly redaction: 'complete' | 'failed'
  readonly manifestDigest: string
}
```

`failureCategories` 是 provider 能权威给出时的原始分类；它必须映射到员工 revision 的 ProblemType catalog。provider
不能分类或只给 `unknown` 时，规则选择一个 script/只读 Agent ProblemProducer 读取同一 bundle，产出经 §4.8.1 校验的
`ProblemSetEnvelope`。例如可定义 `compile`、`link`、`unit-test`、`integration-test`、`static-analysis`、
`infrastructure-transient`、`policy`；分类只是 fact，ProblemHandlingRule 再决定安全 rerun、选哪位 Agent/程序修复或交人。
不得由 pipeline repair Agent 一边读日志一边自行发明类型和选择处理策略。

### 6.4 大结果处理

- adapter stdout 只有小 envelope；日志用 stream 写 sink，不经 DB、event、WS、prompt 或进程 argv。
- Agent 只读 manifest，按 gate/job/fileId 选择文件；平台不主动把 2 GB 日志塞进 context。
- 单个 Agent read 有字节/行数预算，超限返回可定位的截断 receipt；它可继续按 offset 读，不伪装完整。
- 压缩文件由 evidence importer 安全展开或登记为不可直接读；Agent 不执行 bundle 内脚本、binary 或 hyperlink。
- terminal TTL 到期由 evidence owner GC；active Mission、blocked diagnosis 与 unresolved ActionRun 的 ref 禁止回收。
- `.agent-workflow/pipeline` 永远命中 RFC-308 exclude profile；source-control candidate preview 若见其 staged/tracked
  历史，固定拒绝发布并给出迁移诊断。

### 6.5 rerun、问题生产与 repair

required gate 没有任何 run 时不是 `rerun`。PipelinePolicy 为每个 gate 配
`observe-only | trigger-if-missing`：前者按 deadline wait/handoff，后者调用 `trigger(expectedHead,target,gateKeys,
idempotencyKey)`。adapter 必须声明 trigger operation；receipt 绑定新 run ref 与 exact head。trigger 已成功但响应丢失
时先按 idempotency/head 查询 adopt，不能再造第二个 run。

`pipeline.rerun` 只接受已有 `runRef + gateKey + expectedHead + idempotencyKey`，且 adapter 返回 provider receipt。
固定拒绝：unknown retryability、非当前 head、超过 budget、policy gate、已 running、provider 没有幂等保证。

不满足安全 rerun 的 gate 进入问题生产阶段：优先使用 provider 的可信类型映射；否则按员工规则选择唯一 producer。
同一 evidence digest 已有合法 ProblemSetReceipt 时直接复用。handler 修改并经验证后必须重新 collect 新 head 的 pipeline
bundle；旧 ProblemSetReceipt 只保留审计，不得跨 head 复用。一个 bundle 同时含多类问题时，work selection 按员工优先级
稳定分批，后一批必须在前一批发布并重采后重新判断，不能把陈旧的全部问题一次塞给 Agent。

trigger 与 rerun 有独立预算、backoff 和 failure receipt；pipeline 一直 queued/running 到 deadline 后进入 wait/handoff，
不会把“还没跑完”交给 repair Agent。

repair Agent 读取被 pin 的 bundle；完成后平台生成 candidate、验证并发布。新 commit 产生新 head 后，旧 evidence
立即变 stale，必须重新 collect；不能因为“修的是同一错误”沿用旧绿项。

## 7. AgentAttempt：输入、输出与 no-Git 执行边界

### 7.1 职责拆分

`development-automation` 拥有业务层 `AgentAttempt`：属于哪个 ActionRun、输入 digest、协议拒绝、两级预算与
最终 outcome。`task-execution` 拥有机制层 execution attempt：Task/NodeRun、session/runtime、进程、取消、stdout
artifact 和 ownership。两边只用 opaque `AgentExecutionRef` 关联，不复制 session id 或 runtime handle。

```ts
interface AgentAttempt {
  readonly id: string
  readonly actionRunRef: ActionRunRef
  readonly rerunSeq: number
  readonly attemptSeq: number
  readonly executionRef: AgentExecutionRef
  readonly baselineRef: AgentAttemptBaselineRef
  readonly nonceDigest: string
  readonly inputDigest: string
  readonly status: 'claimed' | 'running' | 'rejected' | 'validated' | 'interrupted' | 'discarded'
  readonly rejection: AgentProtocolRejection | null
  readonly outcomeRef: AgentOutcomeRef | null
}
```

`nonce` 明文只在一次 attempt protocol block 与 parser 内存中存在，台账持 digest；重放页面不显示可复用 nonce。

### 7.2 path-free 启动合同

```ts
interface AgentActionExecutionIntent {
  readonly actionRunRef: ActionRunRef
  readonly capabilityRef: CapabilityContractRef
  readonly actionTemplateRef: VersionedResourceRef
  readonly executionResourceSnapshotRef: string
  readonly baselineRef: AgentAttemptBaselineRef
  readonly inputManifestRef: AgentInputManifestRef
  readonly workspacePolicyRef: AgentWorkspacePolicyRef
  readonly protocolRef: AgentProtocolRef
  readonly budget: { readonly wallTimeMs: number; readonly outputBytes: number }
}

type AgentActionExecutionResult =
  | {
      readonly kind: 'frame-received'
      readonly executionRef: AgentExecutionRef
      readonly continuationRef: AgentContinuationRef
      readonly frame: AgentOutcomeEnvelopeCandidate
    }
  | {
      readonly kind: 'protocol-missing'
      readonly executionRef: AgentExecutionRef
      readonly continuationRef: AgentContinuationRef | null
    }
  | {
      readonly kind: 'boundary-violation'
      readonly executionRef: AgentExecutionRef
      readonly code: AgentBoundaryViolationCode
    }
  | {
      readonly kind: 'runtime-failure'
      readonly executionRef: AgentExecutionRef
      readonly retryability: 'same-session' | 'fresh-session' | 'never'
      readonly code: string
    }
  | { readonly kind: 'canceled'; readonly executionRef: AgentExecutionRef }
```

`AgentContinuationRef` 由 task-execution factory 铸造、deep-frozen、绑定 execution/action/epoch，不能 JSON durable
serialize 或由对象字面量伪造。daemon 重启后由 durable `AgentExecutionRef` 请求 task owner 重新铸 continuation；
Mission 不能保存第三方 session id。

`AgentAttemptBaselineRef` 不是总等于 Git head：它精确表示
`repository snapshot + pending SeedChangeRef + prior validated business change sets`。Agent 的“本次有没有改动”只相对这个
action baseline 判断；最终 ChangeCandidate 则始终相对发布用 repository snapshot 计算。两者分开，才能让文件-only 输入中
Agent 合法返回 action-level `no-change`，同时 Mission 仍把 seed 作为真实 diff 验证并提交。

### 7.3 输入 manifest

Agent 不接收一个开放 `context: Record<string,unknown>`。每项能力有 exact input schema，公共头如下：

```ts
interface AgentInputManifestV1 {
  readonly schemaVersion: 1
  readonly actionRunRef: string
  readonly capabilityId: AgentCapabilityId
  readonly capabilityContractVersion: number
  readonly templateRevision: number
  readonly missionRevision: number
  readonly baseHeadSha: string
  readonly inputDigest: string
  readonly requirementBundle: ReadonlyMountDescriptor | null
  readonly repositoryUploads: RepositoryUploadConstraintDescriptor | null
  readonly pipelineBundle: ReadonlyMountDescriptor | null
  readonly feedbackSnapshot: FeedbackSnapshotDescriptor | null
  readonly verificationEvidence: VerificationEvidenceDescriptor | null
  readonly writablePathClasses: readonly PathClass[]
  readonly protectedRoots: readonly LogicalRoot[]
  readonly protocol: {
    readonly nonce: string
    readonly port: 'agent-result'
    readonly outcomeSchemaId: string
  }
}
```

`RepositoryUploadConstraintDescriptor` 只含 plan/placement digest，以及按 ordinal 排序的 target path、content policy、
effective file mode 与 original evidence fileId；不含 expected baseline digest 或 host path。它与 `workspacePolicyRef`、
`baselineRef` 一起进入 input digest：preserve path 从 write allowlist 扣除，editable path 明确允许但不可删除/改 mode。
Agent 可据此理解已有 seed，不会把 requirement evidence 副本再次复制到另一路径；平台仍以自己的 plan/receipt 做最终验证。

`ReadonlyMountDescriptor` 在跨 context DTO 中只有 opaque bundle ref/digest。task-execution materialize 后生成给
Agent 看的 workspace-relative `.agent-workflow/.../manifest.json`；主机绝对路径不进入 prompt、DB 或 event。

prompt 按固定顺序组装：平台任务说明 → typed facts 摘要 → template supplement → evidence manifest index →
**最后的不可覆盖 protocol block**。数据文件前后有 untrusted-data delimiter，需求/评论/日志里出现“执行命令、
忽略规则”只被当材料。

### 7.4 输出 envelope

Agent 可以产生日志，但唯一结果必须是 named port 上恰好一个 nonce-bound frame：

```ts
interface AgentEnvelopeHeader {
  readonly protocolVersion: 1
  readonly nonce: string
  readonly port: 'agent-result'
  readonly actionRunRef: string
  readonly inputDigest: string
  readonly capabilityId: AgentCapabilityId
}

type AgentOutcomeEnvelopeCandidate = AgentEnvelopeHeader &
  (
    | {
        readonly outcome: 'changed'
        readonly result: AgentChangedResult
      }
    | {
        readonly outcome: 'no-change'
        readonly result: { readonly reason: NoChangeReason; readonly summary: string }
      }
    | {
        readonly outcome: 'needs-information'
        readonly result: {
          readonly questions: readonly {
            readonly questionId: string
            readonly text: string
            readonly rationale: string
          }[]
        }
      }
    | {
        readonly outcome: 'blocked'
        readonly result: { readonly code: AgentBlockCode; readonly explanation: string }
      }
  )
```

`AgentChangedResult` 再按 capability 做 closed discriminated union，例如：

```ts
type AgentChangedResult =
  | {
      readonly capabilityId: 'change.implement'
      readonly summary: string
      readonly requirementCoverage: readonly {
        readonly itemRef: string
        readonly disposition: 'implemented' | 'not-applicable'
      }[]
    }
  | {
      readonly capabilityId: 'mr.feedback.apply'
      readonly summary: string
      readonly feedback: readonly {
        readonly threadRef: string
        readonly revision: string
        readonly disposition: 'addressed' | 'needs-human'
      }[]
    }
  | {
      readonly capabilityId: 'pipeline.repair'
      readonly summary: string
      readonly issueRefs: readonly string[]
    }
  | {
      readonly capabilityId: 'verification.repair'
      readonly summary: string
      readonly failureRefs: readonly string[]
    }
  | {
      readonly capabilityId: 'conflict.repair'
      readonly summary: string
      readonly conflictRefs: readonly string[]
    }
```

只读能力有自己的 outcome union，不得使用 `changed`。Envelope 不接受 `changedPaths`、`commitSha`、`pushed`、
`testsPassed`、`mergeable` 等冒充平台事实的字段；strict schema 会把它们作为 unknown key 拒绝。

### 7.5 验证流水线

```text
transport parser
  1. exactly one frame + expected named port
  2. nonce/actionRun/inputDigest/capability exact match
  3. strict schema + unknown-key rejection
  4. capability semantic validator
workspace validator
  5. Git metadata/evidence/protected roots unchanged
  6. no traversal/symlink/hardlink escape; budgets satisfied
  7. outcome versus real overlay consistency
source-control
  8. derive immutable ChangeCandidate from baseline + real overlay
```

语义示例：

- `changed` 必须相对 `AgentAttemptBaselineRef` 有非空、允许路径内的真实 delta；
  `no-change/needs-information/blocked` 必须相对该 action baseline 为 clean。它们不表示相对 Git head 没有 pending seed；
- feedback 输入的每个 `(threadRef,revision)` 必须恰好有一个 disposition，不能处理未输入或旧 revision；
- pipeline/verification repair 的 issue/failure ref 必须是当前 bundle 中的闭集；
- conflict repair 只能改平台标记的 conflict path，且 marker/semantic check 通过；
- requirement analysis 的 coverage ref 集必须和当前 requirement index 对拍；
- read-only capability 任意业务文件变化都是 boundary violation，不是普通 schema retry。

只有第 8 步成功后才产生 `ChangeCandidateRef`。Agent 的 envelope 验证成功但 workspace 验证失败，整个 attempt
仍失败，不存在“格式对了就算成功”。

### 7.6 no-Git/no-code-host 的强制层（2026-08-18 用户裁决修订）

用户在实现批准时裁决：**首版不引入 OS 沙箱、只读 Git view、command broker、环境 allowlist 重构或任何网络管控**；
no-Git 以「提示词禁止 + 事后校验 + 违规回退」强制。digital-employee execution profile 首版启用：

1. **分离真实 writer**：Agent action workspace 是 baseline 的可写业务 workspace；source-control 的真实 publication
   workspace 与 candidate/commit/push 机制不进入 Agent 路径。Agent 即使在自己的 workspace 里做出 commit，也只是
   将被检测丢弃的本地垃圾，不是发布链上的任何输入。
2. **零凭据/零身份注入**：不注入 Git author/committer identity（收掉现有 `assembleClaudeEnv` 的注入分支）、不提供
   SSH agent、provider token、pipeline token 或 code-host endpoint secret；integration connection secret 只存在于
   daemon/adapter 一侧。环境沿用现状继承方式，不做成 allowlist 重构（后续增强）。
3. **无外部能力挂载**：Agent 不配 integration adapter/MR/pipeline MCP connector；skills/MCP 只能引用模板声明的
   本地只读资源。不做 OS 级 outbound network 管控（用户裁决：不做网络相关安全动作）。
4. **prompt protocol block**：不可覆盖的协议块明确禁止 `git add/commit/push/merge/rebase/reset/checkout`、
   凭据探测与代码托管调用；这是行为约定层，不宣称是安全边界。
5. **前后快照对拍**：Agent 启动前平台 hash Git metadata（HEAD/refs/index digest）、protected roots、evidence
   manifests；退出后逐项对拍。任何差异 ⇒ boundary violation ⇒ 按 §7.7 立即作废 attempt、整树废弃重建、fresh-session
   重跑；violation 现场绝不产生 ChangeCandidate。
6. **独立 diff**：candidate 不信任 Agent 运行的 `git status` 或自报 changed paths，由 source-control 以 pinned
   baseline 和真实 overlay 自己计算；`.agent-workflow`、受保护路径出现在 candidate 中固定阻断。

负向测试锁「检测 + 回退」而非「OS 阻断」：Agent 进程执行 `git commit`/写 index/refs/config、修改 evidence、写受
保护路径后，快照对拍必须稳定捕获、violation receipt 分类正确、workspace 从 exact baseline byte-identical 重建、无
candidate/commit/push 发生。凭据负向测试仍然成立：daemon 侧 connection secret 与 Git identity 不出现在 Agent env/
文件/MCP 中。

**后续增强（不在本 RFC 首版）**：OS 级文件系统写边界（Claude Code 自带 sandbox 收紧 / OpenCode 外包 sandbox-exec
与 bwrap）、只读 `.git` view、outbound network 管控。若引入须另立 RFC 并按能力影响清单呈批。

### 7.7 两级重试与 whole-workspace 回退

`sameScene` 是业务概念：平台钉住同一份 frozen input、baseline、evidence 和一个 disposable workspace，
把上一次验证错误作为结构化反馈再执行一次。机制上每次都启动新的 host Task/Agent 进程、使用新 nonce 并留下独立 receipt；
不依赖 runtime 的隐式会话 continuation。`freshScene` 则丢弃整个现场，从 exact baseline 重建。

```text
fresh scene 0 / exact baseline B / evidence E / template T / nonce N0
  ├─ same-scene attempt 0 → protocol/semantic error → exact structured feedback
  ├─ same-scene attempt 1 → new host task + same workspace/input + new nonce
  └─ same-scene budget exhausted
       → terminate the current host task
       → revoke all mount/output capabilities
       → discard WHOLE action workspace (not git reset)
       → rematerialize exact B + E + T
       → preflight hashes
       → fresh scene 1 / new nonce N1 / no old feedback
```

分类：

| 失败                                                         | 同现场新 host task               | 全新现场           | 现场                                      |
| ------------------------------------------------------------ | -------------------------------- | ------------------ | ----------------------------------------- |
| missing/multiple envelope、schema、semantic mismatch         | 允许，给 exact JSON pointer/code | N 次耗尽后允许     | 同现场保留；fresh 时 whole-workspace 重建 |
| runtime transient 且 sandbox receipt 完整                    | 按 runtime classifier            | 允许               | 不确定完整性时按 fresh 处理               |
| Git/protected/evidence 写入等 boundary violation（快照检出） | 禁止                             | 允许但计入安全预算 | 立即 kill、revoke、整树废弃               |
| baseline/evidence digest 不可重建                            | 禁止                             | 禁止               | Mission `blocked(evidence-unavailable)`   |
| cancel、terminal MR、epoch lost                              | 禁止                             | 禁止               | cancel + discard，不产生 candidate        |

反馈不是自由文本：`{code,jsonPointer,expected,observedSummary,retryOrdinal}`，且不会包含 secret/raw log。全新
现场不继承旧现场反馈，避免把不存在的上下文变成新指令。

fresh-scene 预算耗尽后 ActionRun 失败，再按步骤已发布的 `onFailure.onExhausted` 继续；只有目标是 `block`
才进入具名阻断。平台不 commit/push
半成品。daemon 启动恢复先把失去 task ownership 的 attempt 结算 `interrupted`，确认旧进程死亡和 workspace
capability 已 revoke 后才能重建。

## 8. 固定能力计划

### 8.1 能力阶段不是用户编排图

用户配置的是能力实现和策略，不是任意连线。每个 capability 的阶段由 `CapabilityDefinition` 固定：

```text
typed input freeze
  → materialize exact baseline/evidence
  → Agent or program execution
  → protocol + semantic + workspace validation
  → typed result receipt
```

只读/可写、allowed paths、evidence mounts、输出 schema、重试类别与可产生的下一类 intent 都是合同字段，模板
不能覆盖。界面可以投影阶段图帮助理解，但不提供增删/重连。

### 8.2 首次实现链

```text
repository.inspect(program)
  → employee.select(admission assignment + selection policy)
  → requirement.materialize(direct) | requirement.acquire(selected employee adapter)
  → [change.seed-uploads(program, RepositoryUploadPlan)]
  → requirement.analyze(agent/read-only)
  → [publish QuestionSet → await → submit/collect exact AnswerSet → invalidate analysis]*
  → change.implement(agent/write)
  → verification.run(program)
  → [verification.repair(agent/write) → verification.run]*
  → change.review(agent/read-only snapshot)
  → prepare ChangeCandidate(source-control)
  → commit + exact-head push(source-control)
  → mr.ensure(integration)
  → MR care reconciler
```

`change.review` 的 findings 不能让 Agent 自己决定“通过”。程序按 closed severity/disposition validator 与 policy
决定返回 implement/repair、允许发布或 block。若 review template 只输出自由结论而没有覆盖 candidate digest，
结果拒绝。

`requirement.analyze` 输出 `RequirementAnalysisResult`：需求条目覆盖、经 repository catalog 校验的
`affectedModuleRefs`、`scopeDisposition = ready | needs-information | already-satisfied-candidate`。它不输出
employee/template id。`already-satisfied-candidate` 只是规则 fact：平台按 policy 运行专门的 no-change verification
profile 或打开 `no-change-confirmation` human gate；只有 receipt 才能在**尚未创建/接管 MR**时进入
`completed-no-change`。已有 MR 的某个 feedback/repair action 返回 no-change 只结算该动作，Mission 继续 watching。
若 `RepositoryUploadPlan` 有 created/replaced entry，analysis 的 `already-satisfied-candidate` 和 Agent 的 `no-change` 都不能
跳过上传改动；规则至少要把 `SeedChangeRef` 送入 verification/review/candidate。所有 entry 均为 `already-present` 时，才可
与其他需求一样在没有真实 diff 的前提下走 no-change proof。

### 8.3 Feedback 链

```text
mr.collect exact snapshot
  → select unhandled (threadRef, revision) by policy
  → mr.feedback.apply(agent/write)
  → verification.run(program)
  → candidate/commit/CAS push(platform)
  → mr.feedback.reply(platform, idempotent)
  → recollect MR + pipeline
```

同一 thread 新 revision 是新事实；旧 ActionRun 不许回复“已处理”到新 revision。平台回复可以引用 commit receipt，
但不调用 resolve。对建议、问题或超出 scope 的意见，Agent 可输出 `needs-information/needs-human`，policy 决定
回帖还是 block。

### 8.4 Pipeline repair 链

```text
pipeline.collect exact-head bundle
  → fixed rerunability guard
  → policy: safe rerun OR pipeline.repair template OR block
  → [Agent repair]
  → verification.run
  → candidate/commit/CAS push
  → collect new-head evidence
```

“基础设施瞬态”是否可 rerun 由 adapter typed classification + policy white-list 决定，不由 Agent看日志猜。

### 8.5 Conflict repair 链

旧 policy 默认 `report-only`。启用 `repair` 时：

1. source-control freeze `sourceHead S`、`targetHead T`，准备“merge target into source”的 conflict intent；
2. 平台执行 merge mechanics，产生 conflict set 与不可变 pre-merge receipt；
3. task-execution 给 Agent 一个只允许编辑 conflict paths 的 no-Git overlay；
4. Agent 输出 conflict envelope；平台检查所有 conflict resolved、只改 allowed paths、无 marker/escape；
5. source-control 使用自己的 index 完成 merge commit，CAS push against S；
6. 任一时刻 S/T 改变则废弃现场重采。

禁止 rebase、force push、把源分支 merge 到目标分支、自动接受 ours/theirs、修改非冲突文件和直接完成 merge。
超预算或语义无法解冲突就 `blocked(conflict-needs-committer)`。

### 8.6 外部 MR review

`mr.review.external` 是可选只读能力：Agent 对 exact diff snapshot 输出 structured findings，平台验证行锚、candidate
digest、severity 和去重 fingerprint 后，policy 才能选择发布。它不等于 code-host approve，不改变 approval state；
发布 finding 仍走 closed platform effect。

## 9. ChangeCandidate、Git 与发布

### 9.0 delivery 与分支解析

create 模式在 admission 时把仓库默认/显式 target 解析为 exact target ref + sha，并按 DeliveryPolicy 从 Mission id、
source identity 和受限命名模板生成 source ref。碰撞处理是 closed policy：

- ref 带相同 Mission marker 且 repository/source/target 一致 ⇒ 幂等 adopt；
- 普通同名 ref ⇒ deterministic suffix 或 `blocked(source-branch-collision)`；
- 已存在 MR 指向该 source ⇒ 只有 identity/target 一致才 adopt；
- 不允许 Agent 返回 branch name，也不允许覆盖/删除未知 ref。

adopt 模式不建 source branch/MR；它先读取外部 MR。若 MR 已 merged/closed，则建立 history binding 并直接记录对应
terminal Mission，不 claim writer、不要求 source ref 仍存在或可写。active MR 才 claim，并以采集到的 current
source/target head 建 baseline，再由 source-control/integration 程序化 probe source repository/ref 的 fetch+push
authority。自动模式要求 pushable；fork/权限不足只能 admission block 或由用户明确选择 tracking-only，不能等 Agent
改完才发现推不上去。draft、目标分支与 source branch 的后续外部修改都成为新 facts，并按 policy 重算。

direct upload 与 terminal adopt 还有额外 gate：平台读取 terminal/merge commit tree，所有 entry 已满足时可生成
`external-observed` upload fulfillment 后记录终态；任一目标不满足就拒绝把该 MR 作为此 Mission 的交付结果，并提示改用
新的 create delivery 或挂接真正包含这些文件的 MR。terminal guard 绝不能为了补上传而向已关闭/已合入分支写 commit。

### 9.1 candidate 形成

Agent workspace freeze 后，Mission 通过 composition-bound source-control participant：

```text
resolve baseline + optional RepositoryUploadPlacementReceipt
  → materialize baseline + SeedChangeRef + later Agent overlays
  → ensure exclude profile
  → prepare candidate from pinned baseline
  → preview independently
  → verify no platform/evidence/protected path and no forbidden history
  → attach verification/review receipts
  → commitPrepared(platform-owned message/identity)
  → publish(baseSha, tipSha, non-force mode)
```

直接复用 RFC-308 的 `WorkspaceExcludeParticipant`、`RepositoryCommitCandidateParticipant` 与
`RepositoryCommitPublicationParticipant`。若现有 `publish` 还不能表达 expected remote-head CAS，扩展 source-control
offered contract，而不是在 Mission 里执行 `git push`。

candidate receipt 至少绑定：baseline snapshot、tree digest、changed path summary、exclude policy digest、submodule
summary、verification receipts、Agent outcome ref，以及可选的 upload plan/placement/seed/publication-lineage digests。文件-only 输入即使 Agent
没有产生额外改动，seed 也必须经过同一 workspace validator、verification policy、candidate、commit 与 publish 临界区，
不能由 HTTP upload route 直接写 Git。绝对路径只在 source-control internal adapter 中存在。

prepare 前平台逐项验证 RepositoryUploadPlan：created/replaced entry 必须真实出现在相对 baseline 的 diff 中；
`preserve-upload` 的 candidate blob 必须等于上传 digest；`agent-editable` 的目标必须存在并记录最终 digest；
`already-present` 不得伪装为 changed path。任一不满足都作废整个 candidate，不允许只漏掉上传文件继续发布。

### 9.2 commit 与 push

- commit message/author policy 由平台 template 生成并校验，Agent 只能提供 summary source，不给完整命令或 identity。
- source-control 在 commit 前重新 preview；prepare 后 workspace 改变则 digest mismatch，整个 candidate 作废。
- commit 的 tree 必须与 candidate receipt 的 upload placement 集合完全一致；非 `already-present` 上传不得因 ignore、
  sparse checkout 或 Agent 输出漏项而消失。
- push 只允许新分支或 fast-forward/CAS 更新当前 Mission source branch；`--force`/force-with-lease 都不在 union。
- remote head 与 expected base 不同返回 typed `remote-head-changed`，Mission 重新采集/决策，不能自动覆盖。
- 若 remote head 是人类/其他 bot 的合法新提交，旧 ActionRun/candidate 全部 invalidated；
  `restart-action-from-new-head` 从新 remote snapshot、相同有效需求/feedback facts 重新运行，不能 Git rebase、force
  或自动套用旧 workspace patch。policy 也可选择 handoff。
- push receipt 必须含 remote ref、old/new sha、provider correlation id；MR effect 只消费 confirmed receipt。
- `.agent-workflow`、credential、runtime output 或超出 template path policy 的文件一旦出现在 candidate，固定阻断。

### 9.3 MR ensure 与绑定

`mr.ensure` 是幂等 effect：先按 Mission marker/source branch 查询，存在则验证 repository/source/target 匹配并绑定；
不存在才创建。创建 body 中带 machine marker，但不把 secret、host path、raw policy JSON 或日志放进去。

绑定与 active-MR claim 在一个 transaction 中提交。发现另一个 Mission 已 claim 同一 MR 时，新 Mission
`blocked(mr-owned-by-another-mission)`；不靠“哪个 worker 先 push”解决。

### 9.4 发布临界区

```text
DB tx: DecisionReceipt + PublishIntent(expected mission/head/candidate)
  → outbox claim with mission epoch
  → source-control commit receipt (local durable)
  → remote CAS publish (external idempotency/correlation)
  → DB tx: confirm publish receipt + advance Mission
  → code-host MR/comment effects
```

外部调用不在 DB transaction。崩溃恢复先 query/reconcile provider/local Git truth，再决定 confirm/retry；不得因为
本地 receipt 缺失就盲目重推。每个 effect 有 `prepared → dispatched → confirmed | invalidated | failed` 状态和唯一
idempotency key。

effect failure 也走 §4.8：网络/限流可 durable retry，remote-head-changed 先 refresh，permission/protected-branch/
invalid connection 进入配置 remediation 或 handoff。commit hook/program failure 产生 verification-style evidence，可由
规则选择 repair；平台生成的 branch/message contract 错误直接 block，不把同一输入无限重试。

## 10. MR 生命周期看护

### 10.1 事实优先于事件

webhook payload 只提供 mission lookup/dedupe/wake hint。reconciler 主动取得同一个 logical snapshot：MR head/target、
draft/terminal/mergeability、approval holds、threads revisions，再取得与该 head 绑定的 pipeline evidence。三个调用若
跨越 head 变化，整组丢弃重来。

### 10.2 feedback 台账

```ts
interface FeedbackLedgerItem {
  readonly missionId: string
  readonly threadRef: string
  readonly revision: string
  readonly headSha: string
  readonly fingerprint: string
  readonly authorClass: 'human' | 'bot' | 'self'
  readonly state: 'observed' | 'selected' | 'addressed' | 'needs-human' | 'obsolete'
  readonly actionRunRef: string | null
  readonly replyEffectRef: string | null
}
```

唯一键含 thread revision 和 head；同一 webhook 重放不重复起 action。bot/self feedback 是否处理由 policy 决定，
默认忽略自身 marker 防循环。thread 被外部 resolve 只更新事实，不反向伪造平台曾处理。

### 10.3 readiness publication

平台 activity/read model 的 readiness 更新是内部 committed projection，tracking-only 也允许。若 policy 还配置了 MR
总览评论，则它是独立的 active-mode code-host effect；tracking-only 只记录 `suppressed-by-automation-mode`，不能借
`publish-readiness` 绕过写禁令。总览评论复用一条，使用 `missionId + readinessRevision` idempotency key；新事实让旧
update obsolete，避免每次 poll 新增通知。信息至少区分：

- 正在自动处理什么；
- machine holds；
- waiting committer 的 human holds；
- exact head 和最近完整门禁采集时间；
- blocked 的确定原因与人工动作；
- 平台永不自动 merge 的说明。

### 10.4 终态

MR `merged` 是 authoritative code-host fact，记录 merge commit、mergedAt、actor summary ref 后进入终态；不要求
该 actor 是平台，也不把观察动作当 merge effect。MR `closed` 且未 merged 进入 `closed-unmerged`；后续 reopen 不让
terminal aggregate 逆转，而是由 admission policy 建立链接的新 Mission generation、重新 claim 当前 MR/head。
terminal transition 同时在 authoritative terminal tree 上结算 upload fulfillment；已满足写 external observation receipt，
未满足仍进入外部事实对应的终态，但 `terminalResult.uploadFulfillment=unfulfilled` 并列出 machine-readable reason refs。
这种 Mission 不是 ready/success，只是生命周期已被外部合入/关闭截断。
`completed-no-change` 记录 confirmation receipt，且没有空 commit/MR。进入任何终态前，transition fence 先禁止新写；
已 dispatch/结果未知的 effect 必须查询 authoritative truth，成功者补 confirm receipt，确定未发生者才 invalidated。
不能把“本地尚未确认”当成“外部未发生”。全部 settle 后执行：

1. revoke current ActionRun/Agent continuation；
2. invalidate 仅尚未 dispatch 或经查询确认未发生的 effect；
3. settle Mission terminal event/outbox；
4. 释放 MR claim 与 workspace lease；
5. 按 retention policy 保留 evidence/receipts，之后由 owner GC；
6. 后续 webhook 只更新 delivery dedupe，不再启动动作。

如果合入发生在 publish/comment effect 临界区，terminal guard 优先；worker 先查询外部真相，已发生的 push/comment
补 receipt，尚未发生且已不合法的 effect 才 invalidated，不向已合入 MR 追加“正在修复”评论。

## 11. 持久化、事务与恢复

### 11.1 表与 owner

下表是逻辑模型；实现时按现有 migration 序号取名，不能提前假定编号。

| 表                                       | 关键列/约束                                                                                                                                    | 不存什么                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `development_missions`                   | id、revision、epoch、status、repository/source refs、pinned employee/policy、current action、readiness digest、terminal                        | raw requirement/log/diff、path、credential |
| `development_mission_sources`            | mission、source identity、source revision、bundle ref/digest；external identity generation unique                                              | 文档正文                                   |
| `development_repository_upload_plans`    | mission/revision、repository/baseline ref、canonical plan digest；entry 子表保存 ordinal/blob digest/规范化目标/expected target/content policy | upload bytes、浏览器/host 临时路径         |
| `development_repository_upload_receipts` | plan/baseline、placement seed/tree digest、publish/candidate/commit refs、逐 entry before/seeded/published digests                             | workspace path、Git object bytes           |
| `development_mr_claims`                  | endpoint/project/mr iid unique active claim、mission、epoch、head                                                                              | code-host connection secret                |
| `development_wake_hints`                 | mission、source、delivery key unique、observed/consumed timestamps                                                                             | webhook body                               |
| `development_deferred_wakes`             | mission/decision unique、resumeAt、wake sources、attempt ordinal、backoff digest、state                                                        | in-memory timer                            |
| `development_fact_snapshots`             | schema version、canonical small JSON、digest、all owner refs/revisions、capturedAt                                                             | large evidence                             |
| `development_decisions`                  | mission revision、policy/employee refs、fact digest、canonical trace、decision、digest unique                                                  | arbitrary executable expression            |
| `development_action_runs`                | decision unique、capability/contract/template、baseline/input digest、state/result ref                                                         | workspace path、session id                 |
| `development_agent_attempts`             | action、rerun/attempt ordinal unique、execution ref、nonce digest、rejection/outcome refs                                                      | raw stdout/prompt/token                    |
| `development_effects`                    | effect kind、intent digest、idempotency key unique、epoch、state、receipt ref                                                                  | open action params、credential             |
| `development_feedback_ledger`            | mission/thread/revision/head unique、fingerprint/state/action/reply refs                                                                       | 未裁剪全文；正文留 integration evidence    |
| `development_step_runs`                  | mission/employee revision/step/attempt/input digest unique、kind/state、deadline、output/failure ref                                           | Agent session、workspace path、审批正文    |
| `development_mission_links`              | parent step run + target repo/employee/input digest unique、child mission、completion condition、latest observation                            | child workspace/diff                       |
| `development_approval_sagas`             | step run、adapter/draft/submit intent digest、idempotency key unique、correlation/external refs、latest authoritative status/revision          | credential、审批正文/provider response     |
| `development_step_joins`                 | mission/group/member step unique、all/any/quorum/deadline、member receipt revision、settled result                                             | in-memory promise/barrier                  |
| `development_bundle_refs`                | purpose、evidence ref、manifest digest、bytes/count、retention state                                                                           | 文件内容、host path                        |
| `action_template_revisions`              | immutable semantic config + ACL/resource refs                                                                                                  | executable adapter/secret                  |
| `digital_employee_revisions`             | immutable capability routes + adapter refs + policy ref                                                                                        | adapter program body                       |
| `automation_policy_revisions`            | strict versioned policy JSON、canonical digest、publish status                                                                                 | script/eval expression                     |
| `legacy_code_work_item_links`            | mission ↔ legacy work item/round refs、cutover receipt                                                                                         | legacy row复制                             |

IntegrationAdapterDefinition 的表仍归 integration module；runtime/agent/workgroup/verification profile 的真实资源仍归
各 owner。`development-automation` 只保存 frozen versioned refs 与 admission receipt。

### 11.2 不变量与索引

- `(mission_id, revision)` 单调；所有 command 用 OCC update `WHERE revision = expected`。
- `(upload_plan_id, normalized_target_path)` 唯一；plan/entry 只追加不可更新，blob ref 与 target precondition 一起进入
  canonical digest。placement receipt 只引用 plan/seed ref，不复制 upload bytes。
- `(upload_plan_id, baseline_snapshot_ref, receipt_kind)` 唯一；publication receipt 只能引用已确认的 exact
  candidate/publish，后续 source head 以它判定 seed 已吸收，不能再次 placement。
- `(mission_id) WHERE action status in writable-active` 唯一；SQLite 用 claim table/transaction invariant 实现部分唯一
  语义，不靠进程 Map。
- active MR claim 唯一；只有 terminal 后显式 release receipt，tracking-only 仍保留 claim，避免另一 Mission 接管并写。
- `(action_run_id, rerun_seq, attempt_seq)` 唯一，ordinal 只在 transaction 中分配。
- `(mission_id, decision_input_digest)` 可去重同一 snapshot 的重复 reconcile；新 policy/head/fact ref 必须改变 digest。
- `(mission_id, decision_id)` deferred wake 唯一；新外部 wake 可提前唤醒但不清零 attempt/backoff，settle 后才关闭。
- `(mission_id, employee_revision, step_id, attempt_ordinal, input_digest)` step run 唯一；同一输入重放只能 adopt，不能再起执行者。
- `(parent_step_run_id, target_repository_ref, target_employee_revision, input_digest)` child link 唯一；child id 创建后不可替换。
- approval submit idempotency key 全局唯一；correlation ref 可换 revision 不能换业务申请，observe 只接受 revision 前进。
- `(mission_id, join_group_id, member_step_id)` join member 唯一；settled join 不因迟到 receipt 逆转，迟到结果仅追加审计。
- effect idempotency key 由 `mission/action/effect-kind/intent-digest` canonical derive，provider receipt 另存。
- policy/employee/template revision immutable；所有引用都有 FK/restrict 或 owner-provided blocker participant，不能删悬挂。

### 11.3 transaction 边界

一个 transaction 内允许：读取 aggregate + authority/lease、写状态转移、DecisionReceipt、Action/effect intent、audit、
outbox。禁止在 transaction 内：spawn Agent、读/写 filesystem、Git、HTTP、pipeline program、WS broadcast。

外部结果回写时必须再次验证 mission epoch、expected action/effect state 与 input digest；过期 receipt 作为审计保存，
不推进 aggregate。

### 11.4 恢复矩阵

| 崩溃点                               | authoritative truth                             | 恢复动作                                                                                         |
| ------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| decision commit 前                   | Mission DB                                      | 无 intent，重新 evaluate 相同 snapshot                                                           |
| decision + outbox 后、dispatch 前    | outbox                                          | claim 同一 idempotency key 并执行                                                                |
| durable wait 期间 daemon 重启        | deferred wake + managed job registry            | 按原 resumeAt/ordinal 恢复；已过期立即 wake，不重置 backoff                                      |
| child create/observe 响应丢失        | mission link idempotency key + child Mission DB | 先按 key adopt；已有 child 只重采状态，不再 launch                                               |
| approval submit 响应丢失             | approval saga key + provider lookup             | lookup/adopt receipt；仅权威证明不存在时才按原 intent 重发                                       |
| approval pending 期间重启            | approval saga + deferred wake + correlation     | 释放执行资源；按 webhook/timer wake 后短 observe，保留原 deadline/ordinal                        |
| upload placement 中断/回执丢失       | plan + baseline + source-control seed digest    | 废弃未知临时 workspace；从 exact baseline 幂等重建，绝不叠加写                                   |
| Agent running                        | task ownership + process/session registry       | 先终止/确认已死，settle interrupted，revoke capability，再按预算恢复                             |
| frame valid、workspace validate 前   | action workspace snapshot                       | ownership 仍有效才重新 validate；不重新问 Agent                                                  |
| candidate prepared、commit 前        | source-control candidate receipt                | digest 对拍后幂等 commit，否则 invalidate                                                        |
| local commit 后、DB confirm 前       | local commit marker + candidate digest          | 查询并补 confirm，不重复 commit                                                                  |
| remote push 后、DB/upload confirm 前 | remote ref/head + candidate/plan marker         | 查询 remote tree；exact tip 已存在则补 publish + upload publication receipt，否则按 CAS 结果分类 |
| MR create/comment 后、confirm 前     | machine marker/idempotency key + provider query | find/adopt exact effect，禁止重复评论                                                            |
| readiness publish 后                 | current facts + existing summary marker         | 新 revision update；旧 effect obsolete                                                           |
| MR terminal 与任一 effect 并发       | code-host terminal snapshot                     | terminal guard；invalidate 不再合法 effect，绝不继续写                                           |

恢复测试必须在每一行的“外部调用已成功但本地未确认”位置注入 crash；只测调用前失败无法证明幂等。

### 11.5 evidence 生命周期

Evidence store 是中性 blob/manifest 机制，Requirement/Pipeline bundle 的业务完整性仍由各 adapter contract 和 Mission
validator 拥有。reference count 至少覆盖 active Mission、ActionRun、blocked diagnosis、audit retention。GC 先 mark，
再经 owner blocker query 确认，无引用才 sweep；文件缺失时不能从 DB 中的摘要伪造一个可重放 bundle。
被 RepositoryUploadPlan 引用的 blob 在 publication/cancel/terminal 结算和相应审计保留期结束前同样是 blocker；bundle
副本与 plan 指向同一内容寻址 blob 时只增 refcount，不复制字节。未 claim upload session TTL 到期不影响已经 claim 的 plan。

## 12. API、权限与产品界面

### 12.1 Mission API

已交付研发 Mission 的 HTTP 路由在迁移期继续使用 `/api/code/missions`；新公共能力构建页面使用
`/digital-employees`，不能把通用 OS 永久锁进代码专用 `/code`。typed Mission HTTP 入口：

```text
POST   /api/code/mission-input-uploads
DELETE /api/code/mission-input-uploads/:uploadRef
POST   /api/code/missions
POST   /api/code/missions/direct-input/preview
GET    /api/code/missions
GET    /api/code/missions/:id
POST   /api/code/missions/:id/answers
POST   /api/code/missions/:id/requirement-source
POST   /api/code/missions/:id/cancel
POST   /api/code/missions/:id/retry
POST   /api/code/missions/:id/handoff
POST   /api/code/missions/:id/resume-automation
POST   /api/code/missions/:id/attach-merge-request
POST   /api/code/missions/:id/configuration-upgrade/preview
POST   /api/code/missions/:id/configuration-upgrade
GET    /api/code/missions/:id/decision-trace
GET    /api/code/missions/:id/evidence
```

launch body 是 `direct | external-reference` discriminated union + `create | adopt` delivery；外部 ID 路径没有
`documents/body` 假字段。mutation 返回 `{missionRef, status, automationMode, receiptRef}`，不能只返回“已接受”却
没有可追踪对象。

`direct` launch 引用已完成上传的 immutable artifact，并为每个 artifact 提交 exact repository target path；HTTP 层不能
把 multipart 临时路径当业务字段。preview 在当前仓库快照上返回每项规范化目标、有效 collision/content policy、
`create | replace | already-present | blocked` disposition 与诊断；launch 必须重新读取 authoritative head、冻结 baseline 并
重验，不能信 preview 的旧结果。preview 不写业务 workspace、不创建 Mission，也不承诺随后一定能 admission。
preview 必须先运行与 launch 同一套 repository facts → employee → full policy 选择器，并回传所用 selection/policy revision
与 digest；选择不唯一时直接返回配置阻断，不能用产品全局默认替代尚未选出的员工策略。
preview 请求还必须带与 launch 相同的 delivery：create 用解析后的 target head，adopt 用 active MR source head；不能拿
默认分支预览结果去覆盖已有 MR 分支。terminal adopt 按 §9.0 只做 tree fulfillment 检查，不返回可写 disposition。

upload 入口以 bounded stream/multipart 接收单个文件，返回
`{uploadRef, originalName, bytes, sha256, expiresAt}`；originalName 只作 UI 提示，不能自动成为仓库目标。未 claim artifact
按 TTL 回收，DELETE 只释放当前 actor 尚未 claim 的临时上传。preview/launch 都校验 upload owner、完整状态、digest、TTL
和 policy budget；launch 的 Mission transaction 原子 claim 全部 upload refs，任一失败则一个都不消费。上传 bytes 进入
EvidenceStore，不进 DB/event；客户端断线重试使用 upload idempotency key，不得产生一组无法辨认的重复 blob。
每个 uploadRef 最多由一个 Mission claim；同一 launch idempotency key 重放返回原 Mission，不重复 claim，另一 Mission
复用相同 ref 返回 `upload-already-claimed`。内容寻址底层可以共享 blob bytes，但业务 ownership receipt 不共享。

cancel/handoff 若需结算已 dispatch effect，返回的 receipt 明确是 `cancel-pending | handoff-pending`；客户端跟随
Mission revision 直到 `canceled | tracking-only`，不能把 command HTTP 成功等同于 transition 已完成。

configuration upgrade 可选择新的 employee/policy revision，并由其闭包重新解析 ActionTemplate、verification 与
adapter refs；不能单独把一个 transitive ref 偷换掉。preview 列出被 invalidated 的未发布 ActionRun/candidate/
evidence/decision、资源可见性与新 selection trace。active writable ActionRun 必须先 cancel/settle；已 push 的 commit/MR
历史不回滚。apply 后一次性 pin 新 closure 并 bump Mission epoch，旧 worker receipt 全部过期。

evidence list 只返回 manifest descriptors 与 logical file ids。正文读取走 owner 的 bounded streaming endpoint，做
authority、range、redaction 与字节上限；绝不返回 host path。WS 只广播 mission revision/invalidation，页面再按权限 query。

### 12.2 配置 API

```text
/api/digital-employee-types
/api/digital-employee-types/:typeRef/authoring-manifest
/api/digital-employee-types/:typeRef/job-templates  typed create/revise/validate/publish/archive
/api/digital-employee-types/:typeRef/work-items/:workItemRef/tools
/api/digital-employee-types/:typeRef/work-items/:workItemRef/tools/:registrationRef/validate
/api/digital-employee-types/:typeRef/work-items/:workItemRef/tools/:registrationRef/publish
/api/digital-employees                    typed create/revise/validate/publish/archive
/api/digital-employees/:employeeRef/tool-bindings
/api/digital-employee-assignments         typed type-defined work-scope employee assignment
/api/settings/config                         existing Limits owner; no employee policy endpoint
/api/integrations/development-adapters    typed adapter lifecycle (integration owns)
```

工具注册 create/validate/publish 必须从 URL 和已发布 manifest 解析 type/work item/WorkContract；请求体不能覆盖这些归属。
员工 revise 是一次 application command，原子保存名称/启停、岗位模板、负责范围和 exact tool bindings；不能让浏览器逐资源 PUT
后留下半套定义。`simulate` 只用于技术预览，接受受限 fixture/ref，返回工作项、注册、ruleId、facts digest 与 unmatched reason，
不执行工具。

配置导入/导出保留 immutable revision/upstream provenance；unknown contract version 只能 preview/refuse，不能降级忽略字段。
旧 `/api/code/action-templates`、`verification-profiles`、`automation-policies` 和 `digital-employees/:id/playbook` 在迁移期只读或供迁移
工具调用；业务前端不得调用，完成 cutover 后删除 writer。

### 12.3 权限

建议新增/归一的 permission：

```text
development-missions:launch/read/interact/cancel/retry/handoff/attach/resume/upgrade
digital-employee-types:read/publish
digital-employee-toolboxes:read/create/update/publish/archive
digital-employee-job-templates:read/create/update/publish/archive
digital-employees:read/create/update/archive
adapter-definitions:read/create/update/archive
digital-employee-assignments:read/update
digital-employee-technical-resources:read/update
development-approvals:submit/observe
development-child-missions:launch/read
```

语义补充：

- publish/revise executable adapter 同时要求 integration 资源写权与 `scripts:author`；更新普通员工 route 不因此获得
  daemon code execution 权。
- type/tool/employee preview 仍按 actor 过滤 employee/registration/implementation/adapter；不能通过 trace 探测不可见资源。
- launch 时校验 Mission actor 对 repo、employee/type/tool/global-policy closure、所有 transitive refs 可用；每个 ActionRun freeze 前重验当前
  effect authority和 connection scope，但执行仍用已 pin revision。
- 临时 upload/preview 沿用 `development-missions:launch` 且绑定 actor + repository scope；uploadRef 不是 bearer capability，
  另一个用户即使得到 ref 也不能读取、preview、claim 或删除。
- worker 使用 family-scoped internal effect capability；HTTP/PAT/WS/MCP 不能直接取得。
- child launch 与 approval submit/observe 只发给 Mission worker 的 scoped internal capability；普通业务用户配置步骤不自动
  获得目标仓库或审批连接权限，publish/admission 必须证明运行主体的 exact scope。
- `merged` 不是 permission；系统没有任何 endpoint 让上述权限间接调用 merge。

闭集 permission catalog、角色默认值、session/PAT/API/WS/frontend projection 必须同批闭环；不能只给表单加 checkbox。

### 12.4 页面信息架构

`/digital-employees` 采用与 `/repos`、`/webhooks` 相同的 `page--operations → operations-surface → PageHeader + 标准卡片/表格`
骨架，不保留 hero、旧活动拓扑图或独立视觉语言。新的确定性职责图是 authoring 主控件，不是运行活动装饰。

顶层信息架构按“定义与运行分开”固定为：

1. **数字员工**（位于“编排”和“运行与仓库”之间）只放能力构建。进入 `/digital-employees` 先看到数字员工分类；每个分类使用同一三个页签：
   - **员工** `/digital-employees/:typeId/employees`：创建和管理该分类的具体数字员工；同页次级“岗位模板”管理默认工具组合；
   - **工具箱** `/digital-employees/:typeId/toolbox`：按该分类职责图的工作项管理工具；
   - **适用范围** `/digital-employees/:typeId/assignments`：按该分类的 WorkScopeContract 绑定已发布员工；研发分类投影为仓库/仓库组。
2. **运行与仓库**收纳所有执行事实：
   - **任务** `/tasks`：数字员工 Mission 与普通编排任务统一管理，提供“数字员工”分类筛选；旧
     `/code/missions` 只做兼容跳转。数字员工任务可写正文、上传带仓库目标路径的文件或提交外部 ID，并跟踪到 MR terminal；
   - **成效** `/outcomes`：按员工和时间展示已交付/准备合入/阻断/平均恢复轮次，全部来自平台 receipt；
   - 定时任务、仓库和 Webhook 保持本组既有位置。

分类不是研发专用 hard-code。`/digital-employees` 从 Type Catalog 投影研发、设计、测试等分类卡片；进入分类后，页签、画布、
工作项、WorkScope 表单和文案全由 `EmployeeAuthoringManifestV1`/WorkScopeContract 驱动。旧 `/code` 兼容跳转到研发分类员工页，
旧 `/code/executors` 跳到研发分类工具箱，旧 `/code/assignments` 跳到研发分类适用范围，不再渲染全局执行者列表。

任何数字员工、任务或成效页都不放“← 返回”这类机械导航按钮。用户通过稳定的左侧分类定位，并通过同页
`JourneyNextAction` 继续当前 User Case；不得用返回列表代替“下一步”。

#### 12.4.0 确定性职责图与分类工具箱

职责图始终全量展开。生命周期区域是固定、低对比度的视觉背景，工作项节点按 manifest 固定在区域中；不提供连线拖拽、节点新增、
阶段下拉、折叠分支或自由布局。节点卡只显示业务名称、材料摘要、产出/完成标准和工具状态，不显示 Event ID、Context、Effect、
retry 或内部 revision。

分类“工具箱”页是四层层级的实际落点：

```text
数字员工 / 研发数字员工 / 工具箱
┌ 需求开发与问题定位 ───────────────────────────────────────────┐
│ 交付主线       [准备材料] → [分析实现] → [修改候选] → [提交 MR] │
├ MR 看护与修绿 ────────────────────────────────────────────────┤
│ MR 事件入口                         [关注 MR 状态]              │
│ 检视意见       [识别检视] → [修复检视] ────────────────┐       │
│ 流水线门禁     [取得门禁] → [识别失败] → [修绿] ↺ 下一类型 ┤       │
│ 代码冲突       [修复冲突] → [发布冲突修复] ───────────┤→ 回入口│
│ 跨仓与审批     [协同] → [准备] → [提交] → [等待] ─────┤       │（由流水线外部依赖进入）
│ 合入判断       [判断就绪] → [等待 committer] ─────────┘       │
└───────────────────────────────────────────────────────────────┘
                         点击工作项
                              ↓
右侧：该工作项的输入｜输出｜完成标准｜工具列表｜[增加工具]
```

同一 `EmployeeAuthoringManifestV1` 画布有四个严格模式，不能复制成四套各自维护的图：

| 模式           | URL/页面              | 节点右侧唯一可写内容            | 只读内容                                        |
| -------------- | --------------------- | ------------------------------- | ----------------------------------------------- |
| `toolbox`      | 分类“工具箱”          | 注册/验证/发布当前工作项工具    | WorkContract、角色/槽位、已有工具状态           |
| `job-template` | 分类“员工 → 岗位模板” | 为 slot 选择默认 registration   | 职责、合同、可选工具兼容范围                    |
| `employee`     | 员工创建/详情         | 必要时覆盖模板默认 registration | 模板默认、职责、合同、发布诊断                  |
| `runtime`      | `/tasks/:caseRef`     | 无；动作来自 JourneyNextAction  | 当前/待办/完成节点、实际工具、事件原因、receipt |

四种模式共享 workItem key、几何布局、业务文案和选中态 URL codec；只替换 inspector codec。刷新、深链或从缺失工具返回草稿时，
必须回到同一 workItem。前端不得为岗位模板/员工/任务复制或重新排序节点。

- 点击节点即确定 `type + work item + contract`；工具列表查询不得省略这三个条件。
- “增加工具”可选择已有 Agent/Workflow，或直接定义当前节点的 ProgramTool；按工作项允许的角色分组，外部连接仅在工具需要时出现。
- 表单不允许再次选择阶段或工作项；不能在这里新建/改写底层 Agent 或 Workflow，ProgramTool 则只在这里定义并要求程序写权。
- 保存后先显示合同校验结果；通过后才能发布。系统节点只展示平台行为和 receipt，无“增加工具”。
- “处理流水线”一个工作项内可分“问题识别工具 / 问题修复工具”；问题类型路由由分类包固定，不把流程重新拆成自由连线图。
- 泳道标签回答“这是人的哪类职责”，节点回答“这一步做什么”；MR 事件入口是分发主干，不把检视、流水线、冲突、审批和合入判断
  误画成必须依次执行的一条长链。回入口/重新发布/重采边固定走外侧虚线，选择节点时仅高亮相关边。

员工创建/详情复用同一职责图，但配置更少：选分类和岗位模板后，只填写名称、启停、负责范围，并为有覆盖需要的工作项选择一个
已发布工具。节点右侧显示“当前工具 / 模板默认 / 可选兼容工具”和只读输入输出合同。缺少工具时动作跳到
`/digital-employees/:typeId/toolbox?workItem=:workItemRef&returnTo=:draftRef`；工具发布后返回草稿，不能在员工页弹出底层资源创建器。

“岗位模板”编辑器也复用职责图，但节点右侧只有“默认工具”；模板只保存名称/说明和 `WorkItemToolBinding[]`，不能改职责、合同、
事件或规则。已发布模板 revision 不原地修改；新模板 revision 不静默改写已有员工，员工显式采用新版时预览默认工具变化并保留/重算
自己的 override。

可以放一张小型运行摘要并链接到 `/outcomes?employee=...`，但完整成效统计只属于“运行与仓库”。业务选择器显示“Java 开发
Agent”“C++ 编译修复程序”等业务名称，不显示 `ActionTemplate`、`VerificationProfile`、`adapter/profile`、资源 ID/revision
或 JSON。其他员工和审批作为协作节点/通道呈现，不混进普通工具列表。高级管理员可以展开“技术实现”查看解析后的依赖和编译
receipt，但它不是业务配置的必经路径。

Mission 详情必须能回答：

- 当前 exact head、employee/policy/template revision；
- 哪个 wake 导致哪次采集，facts 是否完整；
- 哪个 fixed guard/ruleId 选了当前 action；
- automation mode、durable resumeAt/wake condition/attempt ordinal、pending transition，以及 handoff/attach/resume 动作；
- Agent 输入的 manifest/digest、attempt/retry/rollback（不显示 nonce/secret/raw prompt）；
- RepositoryUploadPlan 的目标路径、create/replace/already-present disposition、placement/candidate/最终 blob digest，
  以及 baseline 变化后为何阻断或重算；
- 平台看到的真实 diff/verification/commit/push receipt；
- machine holds 与 human holds；
- 为什么 waiting/blocked/ready，以及下一次自动 wake 条件。

“Agent 说完成了”不作为 UI 状态；只能显示“envelope validated”“workspace validated”“candidate prepared”等平台 receipt。

#### 12.4.1 服务端拥有的 JourneyProjection

页面不能用散落的 `if (status)` 各自猜下一步。application 层从 committed aggregate、配置 closure、assignment、MR claim、
step run、child link、approval saga、readiness 和 actor authority 生成同一投影：

```ts
interface JourneyProjectionV1 {
  readonly schemaVersion: 1
  readonly journey: 'employee-setup' | 'mission-delivery'
  readonly current: {
    readonly key: string
    readonly label: string
    readonly ordinal: number
    readonly total: number
    readonly detail: string
  }
  readonly next: {
    readonly kind:
      | 'navigate'
      | 'command'
      | 'form'
      | 'automatic-wake'
      | 'external-human'
      | 'complete'
    readonly label: string
    readonly detail: string
    readonly owner:
      | 'current-user'
      | 'committer'
      | 'platform'
      | 'digital-employee'
      | 'external-system'
    readonly href: string | null
    readonly command: string | null
    readonly available: boolean
    readonly unavailableReason: string | null
    readonly wake: {
      readonly source: 'webhook' | 'timer' | 'child-mission' | 'approval' | 'mr-facts' | null
      readonly resumeAt: number | null
      readonly deadlineAt: number | null
      readonly description: string | null
    }
  }
  readonly steps: readonly {
    readonly key: string
    readonly label: string
    readonly state: 'done' | 'current' | 'next' | 'pending' | 'blocked' | 'skipped'
    readonly owner: JourneyProjectionV1['next']['owner']
    readonly href: string | null
  }[]
  readonly reasonRefs: readonly string[]
  readonly projectionRevision: string
}
```

`projectionRevision` 覆盖所有输入 revision/digest；HTTP/WS 只传该投影，不传可被客户端重新解释的内部状态组合。command
必须来自 closed catalog 并在执行时重验 actor/aggregate revision；`href` 只能是平台路由或 code-host/approval owner 返回的
已校验业务 URL。没有权限时仍返回下一步语义，但 `available=false + unavailableReason`，不能把按钮静默藏掉让用户以为流程
结束。

#### 12.4.2 User Case 状态表

| Journey          | 当前判据                     | 当前页               | 下一步 owner/kind                                          | 同页动作或自动条件                                   |
| ---------------- | ---------------------------- | -------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| employee-setup   | 未选分类                     | `/digital-employees` | current-user/navigate                                      | “进入数字员工分类”                                   |
| employee-setup   | 分类所需工具缺失             | 分类工具箱           | current-user/form 或 command                               | 选中缺失工作项并“增加工具”                           |
| employee-setup   | 工具 draft/unpublished       | 分类工具箱           | current-user/command                                       | 显示合同结果后“发布工具”                             |
| employee-setup   | 无 employee                  | 分类员工页           | current-user/navigate                                      | “创建数字员工”                                       |
| employee-setup   | employee draft/unpublished   | 员工详情             | current-user/form 或 command                               | “填写名称与范围”或 validate 后“发布”                 |
| employee-setup   | published、无 assignment     | 员工详情             | current-user/navigate                                      | “设置使用范围”，带 employee 预选参数                 |
| employee-setup   | published、有 assignment     | 员工详情或分类页     | current-user/navigate                                      | “交给它第一项工作”                                   |
| mission-delivery | launch draft                 | 新建任务             | current-user/form                                          | Stepper 当前步；footer 始终显示后一步名称            |
| mission-delivery | requirement/source ambiguous | 任务详情             | current-user/form                                          | 来源选择/回答表单就在 NextAction 下                  |
| mission-delivery | runnable action              | 任务详情             | platform/automatic-wake                                    | 当前 executor + outbox/attempt；无需人工             |
| mission-delivery | child active                 | 父任务详情           | digital-employee/automatic-wake                            | child 链接、completion、deadline；可下钻但父页不丢链 |
| mission-delivery | approval pending             | 父任务详情           | external-system 或 committer/automatic-wake/external-human | 申请号、审批入口、observe resumeAt/deadline          |
| mission-delivery | blocked/retryable            | 任务详情             | current-user/command                                       | 确切 remediation；`retry` 同区块                     |
| mission-delivery | tracking-only、无 MR         | 任务详情             | current-user/form                                          | attach MR 表单同页打开                               |
| mission-delivery | ready/waiting committer      | 任务详情             | committer/external-human                                   | MR 入口、remaining human holds；不出现平台 merge     |
| mission-delivery | merged/terminal              | 任务详情             | platform/complete                                          | 终态 receipt + 查看成效/再发任务                     |

设置型流程每次成功 mutation 返回 `nextLocation` 与新的 projection revision；客户端优先按它导航，刷新后也能由 read projection
重建。Mission 状态 mutation 仍留在详情页并刷新投影，避免操作后跳走而看不到是否生效。

#### 12.4.3 页面组合

`JourneyNextAction` 是 `/digital-employees`、分类工具箱、员工详情、适用范围、新建任务和 Mission 详情共用的展示组件。它固定在 PageHeader 后、
长内容前，移动端仍在首屏；主按钮只允许一个，取消/handoff/高级动作保持次级。组件同时渲染简短步骤条，因此用户永远看见
“已完成什么、现在在哪里、后面还有什么”。

- `/digital-employees` 只计算一项全局 setup action；分类卡显示员工数、工具合同满足度和适用范围，不混入运行活动。
- 分类工具箱以固定职责图为主内容；工作项选中态、右侧工具列表和下一步在刷新/深链后保持一致。
- 员工详情先显示最小定义和职责图工具绑定；技术 closure/JSON 仅 `digital-employee-technical-resources:read` 或兼容期
  `scripts:author` 可见的折叠区。
- 新建任务 Stepper 的“下一步”文案必须说出目标步骤，而不是通用“继续”；预检失败直接给回需修改的步骤。
- Mission 详情先展示 journey、问题/阻断表单、child/approval 协作；evidence、decision/effect/raw readiness 全部下沉到
  “运行证据”折叠区。
- MR ready 时主动作只有“打开 MR 供 committer 检视”；merged 时主动作是“查看成效”或“再交一项工作”，永不生成 merge。

### 12.5 配置的发布流程

三个发布边界互不混淆：

1. **分类包发布**：`compile → event i18n/contract/rule fixture → publish immutable type revision`。报告所有工作项合同、事件文案、
   rule shadowing/冲突/无 fallback、不可达 reaction、协作环和 required provider mapping。
2. **工作项工具发布**：`select implementation → validate exact WorkContract fixture → publish immutable registration`。报告底层资源
   ACL/revision、input/output/schema/semantic validation、no-Git 或 program probe、Connection scope 与 tool role compatibility。
3. **员工发布**：`select job template → bind tools/scope → compile closure → publish immutable employee revision`。报告每个业务工作项
   exact registration、缺失/多义、Java/C++/polyglot fixture、适用范围和从上一版变更影响。

数字员工不独立发布执行策略。“设置 → 限额”保存后，平台按限额内容 digest 幂等物化内部执行 revision；它不触发分类、工具或
员工 revision 重写，新 Case admission 时 pin。固定退避、总预算和 handoff 属平台合同版本。任何业务资源发布都返回 typed
validation receipt 与下一步位置。

## 13. RFC-304/309 迁移与 cutover

### 13.1 迁移原则

这不是在旧五能力旁增加 Mission 开关。终局只有一个 writer 与一套产品模型；历史事实保留只读。cutover 之前先
生成可审计迁移报告，任何脚本/模板无法机械映射都显式列出，不能让 AI 自动改写策略。

### 13.2 配置映射

| legacy                                              | 迁移产物                                                    | 自动程度                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `capability_templates` 的 agent/prompt/runtime 字段 | 研发分类对应工作项的 `TypeToolRegistration` draft           | 可复制底层 ref；必须通过新 WorkContract/no-Git fixture 后人工 publish        |
| `requirement` template                              | “准备工作材料”或“需求开发”工作项工具 draft                  | 按旧用途拆分；无法证明归属时标阻断                                           |
| `mr-comment-fix` template                           | “处理检视意见”工作项的 repairer registration draft          | 底层 ref 可迁，旧输出/路径权限不兼容                                         |
| `ci-fix` template                                   | “处理流水线”工作项的 recognizer/repairer registration draft | 必须明确角色并绑定 Pipeline source 与 evidence contract                      |
| `mr-review` template                                | “开发自检”或外部 review 工具 draft                          | 必须选择一个工作项，不能静默复制成两份 active                                |
| `mr-monitor` template/config                        | 类型包 Attention/Reaction 迁移输入                          | monitor 本身不产生工具注册                                                   |
| repo × capability matrix                            | 研发员工 draft + job template proposal + assignment         | 工作项闭包唯一时可生成；仍不自动发布                                         |
| fixed 3 CI campaigns                                | “设置 → 限额”的 fresh/same-scene 建议值                     | 只生成设置迁移建议，不写入节点、工具或员工，也不创建策略资源                 |
| entry/collect/classify scripts                      | typed adapter migration candidates                          | contract/probe 通过后才能发布                                                |
| arbitrate/select scripts                            | migration report 中的“必须人工改写规则”                     | 不执行脚本、不让 AI猜等价规则                                                |
| pre/post hooks                                      | 按用途分类的未迁移项                                        | 只允许映射到明确 adapter/prompt supplement；写树/中止/自由注入 hook 默认拒绝 |

原模板的 id、owner、visibility、ACL、upstream provenance 尽可能保留在 migration draft；但“保留身份”不等于
“旧 contract 继续能跑”。每项 draft 带 `migrationStatus/blockedReasons/sourceDigest`。

### 13.3 active 工作项接管

cutover runbook：

1. **preflight**：新员工/policy/adapters 对目标 repo 全部 published+ready；dry-run 从外部真相能算出唯一 decision。
2. **freeze admission**：旧 `/code/rounds` 与 webhook writer 停止接新工作，已有 webhook 只落 delivery backlog。
3. **quiesce**：等待可安全结束的旧 round；超时则 cancel，settle attempt interrupted，废弃旧 workspace，不采用未发布 diff。
4. **snapshot external truth**：按 requirement/MR/source head/pipeline/thread 重新 collect，不把旧 work package 当事实。
5. **create Mission**：写 `legacy_code_work_item_links`、claim MR、pin employee/policy；已发布 commit/MR 作为 baseline，
   未发布旧 workspace 不接管。
6. **flip writer generation**：全局 generation/feature admission 只允许 Mission worker；旧 worker 对该 generation 硬拒绝。
7. **replay backlog**：delivery 仅作为 wake hint，Mission 主动重采。
8. **verify/soak**：对每个 active MR 对拍 external head、claim、无 duplicate action/effect。
9. **retire**：旧 work-item/round 查询只读；删除旧 launch/monitor writer、arbitrate/select/hook 入口与生产 imports。

一个 MR 不能逐请求在 v1/v2 间摇摆。若某 repo preflight 不通过，它整体留在 freeze 前的旧批次，不能同时让两套
worker监听；正式全量 cutover 要等所有目标 repo 就绪。

### 13.4 rollback

- 在 Mission 尚未产生任何外部 side effect 前，可停止新 worker、删除未生效 claim/intent，恢复旧 admission generation。
- 一旦 Mission 已 push/comment/create MR，不能把数据库 flag 翻回去假装没发生。安全 rollback 是：停止所有 writer，
  查询 external truth，生成 reconciliation plan；选择由 Mission 继续收口或人工 handoff。旧 worker不能接管它不认识的
  commit/effect。
- schema migration 使用 expand → backfill/verify → cutover → contract；rollback 窗口内不 drop legacy read tables。contract
  只在 soak、backup/restore、migration verification 全绿后执行。

### 13.5 删除清单

终局负扫描必须为零：

- production `CODE_CAPABILITIES` 旧五联合和 `mr-monitor` stage contract；
- WorkPackage `arbitrate`、AgentPlan `select` 的生产调用；
- 通用 `CodeHostPort.call({action:string})` 在 development-automation 消费路径；
- 任意 stage hook 写工作树/自由 injection 的 Mission 路径；
- digital-employee 路径上的 Git identity 注入（daemon environment 继承按 2026-08-18 裁决保留，不在删除清单）；
- legacy round launch/monitor writer 和 repo × capability matrix write UI/API；
- cross-context `code-capability/internal|domain|infrastructure` imports。

只保留的 legacy surface 必须带 read-only history owner、删除时间与 source ratchet，不得动态 fallback。

## 14. 安全、审计与可观测性

### 14.1 threat model

| 威胁                                          | 边界                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| requirement/comment/log 中的 prompt injection | untrusted bundle、protocol block、无外部工具/凭据、规则不读正文                      |
| 恶意 adapter 输出路径/文件                    | one-shot sink、safe walk、budget、atomic import、平台重算 digest                     |
| Agent 尝试 Git/host/pipeline 副作用           | prompt 禁止、零凭据/零 identity、无 connector/MCP、closed effects、快照检测+整树回退 |
| stale head 上发布                             | baseline/head digest + remote CAS + post-effect reconcile                            |
| webhook 重放/乱序/缺失                        | delivery dedupe 只唤醒、主动采集、periodic reconcile                                 |
| policy 规则歧义或被篡改                       | immutable revision、strict AST、publish compile、canonical digest/trace              |
| worker 崩溃重复副作用                         | intent/outbox/idempotency/provider reconcile/epoch fencing                           |
| 大日志拖垮 DB/prompt/memory                   | streaming evidence store、ref-only DB、bounded ranged reads                          |
| 不可见资源通过 trace 泄露                     | authority-filtered preview/query、opaque refs、redacted trace                        |

### 14.2 audit

每个 mutation 记录 actor/effect family、authority ref、Mission revision、policy/employee/template revision、fact digest、
decision/effect id、结果 code。secret、nonce、raw prompt/log/body、host path 不进入 audit。

关键安全事件单独分类：boundary violation、credential access attempt、protected-root mutation、head-CAS failure、
unknown gate、rule no-match、adapter contract failure、recovery adoption。不能把它们都压成 `action-failed`。

### 14.3 metrics 与告警

- Mission：time-to-first-action、time-to-first-MR、ready latency、ready regression count、time-waiting-committer、terminal lead time；
- rule：no-match/shadow/conflict、decision replay mismatch（必须为 0）；
- Agent：same-session retry、fresh rerun、boundary violation、workspace discard、contract exhausted；
- evidence：acquire bytes/duration、partial/unknown、redaction fail、GC blocked、range-read bytes；
- effects：commit/push/MR/comment/rerun latency、CAS conflicts、reconcile adoption、duplicate prevented；
- lifecycle：wake backlog/age、lease contention、stale fact discard、terminal cancellation latency。

告警按确定原因聚合，避免同一红流水线每次 reconcile 都报警。notification policy 只能调频率/接收者，不能抑制
安全边界违规与持续 worker failure 的运维告警。

## 15. 测试与验收证据

### 15.1 domain/property tests

- Mission transition table：每个合法边、每个非法边、cancel/handoff pending fence、terminal absorbing、ready regression、
  MR terminal 优先；
- 单 writer/MR claim/epoch/OCC 的并发 property test；
- policy canonicalization/replay 100 次 byte-identical，规则顺序与 first-match；
- predicate exact codec/unknown key/type mismatch/AST budget/shadow/no-match；
- selection fixtures：显式员工且无 assignment、Java、C++、polyglot、同级冲突、无 fallback、跨模块阻断；
- RepositoryUploadPlan：路径 canonicalization/case-fold collision、create/replace/already-present 真值表、entry 顺序与
  plan digest 重放、file mode 默认/覆盖、baseline 变化失效、created/replaced 禁 no-change；
- EmployeePlaybook：step/jump/join 图闭合、静态/动态 child 环、all/any/quorum 真值表、deadline/partial 分支、同输入编译
  100 次 closure digest 一致；
- ProblemSet/handler：type/subject/head/evidence 闭集、complete 覆盖、稳定工作集排序、unknown/no-match/fallback；
- readiness truth table：pass/fail/running/unknown/unavailable/partial、human holds、head/target 变化。

### 15.2 contract/mutation tests

- 所有 public/required DTO exact-key round-trip，unknown key mutation 红；
- `DevelopmentCodeHostEffect` 编译期/源码负扫描无 merge/approve/resolve/custom；
- CapabilityDefinition 与 template 不允许覆盖 workspace/protocol/stage/effect；
- adapter stdout nextAction/agent/ready 字段拒绝；
- child/approval envelope unknown key、错误 ancestry/input digest、重复 idempotency key、observe revision 回退、pending 无
  wake/deadline、Agent draft 直接提交等越界全部拒绝；
- Agent envelope missing/multiple/wrong nonce/port/action/input/capability/extra key/outcome mismatch 全覆盖；
- source-selection/QuestionSet/AnswerSet 的 stale revision、错误 candidate key、重复 publish/collect 与 crash replay；
- direct body-only/files-only/body+files codec、upload artifact claim/TTL、preview 与 launch head race、placement receipt、
  preserve-upload/agent-editable semantic mutation、candidate 漏 entry、ignore/sparse/hard-exclude 与 filter round-trip；
- feedback/thread revision、pipeline issue ref、requirement coverage 的 semantic mutation；
- public DTO 出现 DbClient/host-or-absolute-path/credential/URL/header/AbortSignal/runtime/session/raw log/body 的
  architecture scan 失败；`RepoRelativePath` 只在声明的 target 字段白名单出现。

### 15.3 no-Git 检测/回退与 workspace tests（按 2026-08-18 裁决）

为每种支持的 Agent runtime 跑真实子进程，不用 mock command result；锁的是「检测 + 回退 + 发布链不受污染」，
不宣称 OS 阻断：

- `git status/diff/log` 等只读语义可用，正常路径下 Git metadata 前后 digest 不变；
- 进程内执行 `git commit`/直写 index/refs/config、修改 evidence、写受保护/非允许路径后，前后快照对拍稳定检出
  boundary violation，分类 receipt 正确；
- 平台管理的 connection secret、pipeline/code-host token 与 Git identity 不出现在 Agent env/files/MCP（daemon 环境
  按现状继承，不承诺全量净化）；
- 业务 allowlist 内正向写成功并进入真实 diff；violation 现场绝不派生 ChangeCandidate；
- 上传 seed 只能由平台 placement port 写入；Agent 改 `preserve-upload`、删除 `agent-editable` 目标或把 evidence
  临时文件冒充为仓库目标均在 workspace validation 拒绝，fresh rerun 能从 baseline + plan byte-identical 重建；
- invalid envelope 同 session 重试可修正；耗尽后旧 session/workspace 不可达，新现场 byte-identical；
- boundary violation 跳过 same-session，kill/revoke/discard 后 fresh；耗尽不产生 candidate/commit/push。

### 15.4 provider system mocks

新增 runnable、stateful 的 requirement/pipeline provider mock，而不是 test 内返回对象：

- requirement：external ID、多文件顺序、source 选择、revision refresh、QuestionSet writeback/AnswerSet collect、附件流、
  404/403/timeout、恶意 archive/path、redaction；
- pipeline：多 gate、大流式日志、partial、unknown、provider outage、missing run trigger/rerun idempotency、响应丢失、
  head race、target race；
- code-host：signed webhook 重放/乱序/丢失、threads revision、mergeability/approval/conflict/merged/closed；
- approval：submit 成功响应丢失后 lookup adopt、pending→approved/rejected/expired、webhook 重放/丢失、observe outage 与
  revision 乱序；
- effect：create/comment/push 已成功但响应丢失，reconcile 能 adopt 且不重复。

大日志 CI 不必每次落真实 2 GB，但要用流式 generator 证明峰值内存与 DB/prompt size 不随总日志线性增长；nightly/
soak 跑 GB 级 fixture，常规 gate 跑小尺寸同形 fixture并锁 chunk/range/backpressure。

### 15.5 end-to-end journeys

至少覆盖：

1. 只给外部 requirement ID → 多文件 bundle → Java employee → 实现 → 平台 commit/push/create MR → green →
   waiting committer/ready → 外部 merged；
2. C++/CMake repo 选择不同 employee/template，全程 decision trace 可解释；
3. mixed repo 无 polyglot route 明确 block，不让 Agent选；
4. review 新 revision → Agent fix → platform publish/reply、不 resolve；
5. 自建 pipeline 大日志 → repair → 新 head 重新采集；unknown/partial 不误绿；
6. ready 后新评论/红 gate/target conflict 回退并再次 ready；
7. no-Git 攻击 → whole-workspace rollback → fresh rerun，MR 无半成品；
8. push/comment/MR create 各临界点 crash → 恢复无重复 effect；
9. committer 在 action 中途 merge/close → terminal guard cancel，无后续写；
10. RFC-304 active work item cutover → external truth Mission、单 writer、历史可追溯。
11. 只给 ID 且多个 source 候选 → 用户选择 source → 原渠道问答往返 → exact answer revision 后恢复；
12. requirement 已满足 → program proof/人工确认 → `completed-no-change`；closed MR reopen 建新 generation；
13. required pipeline run 缺失 → trigger 响应丢失 → reconcile adopt 同一 run，不重复触发；
14. 未确认 push 时 handoff → 先 reconcile 再 tracking-only；无 MR 时 attach 人工创建/已合入 MR 并正确结算；
15. 未确认 MR/comment/pipeline effect 时 cancel → fence 新写、补真实 receipt、最终 canceled 且不动外部资产。
16. direct 正文-only → 分析/实现/MR；direct 文件-only/正文+文件 → 每项指定目标路径 → 平台 seed → Agent 可选其他改动 →
    candidate/commit 精确包含上传文件。
17. create/replace baseline race、mode/ignore/sparse/filter、`preserve-upload` 改删、`agent-editable` 删除目标均按合同结算；
    全项相同 digest+mode 不造空 commit，但任一 created/replaced 时绝不误进 `completed-no-change`。
18. upload plan 在 publish 前 handoff → 人工 commit/attach active 或 terminal MR → authoritative tree 满足时生成
    external fulfillment 并继续跟踪；目标缺失/错误时拒绝把 MR 当成交付，且不向 terminal MR 补写。
19. 当前仓 pipeline fail → 问题类型命中 → 调用另一仓数字员工 → child MR ready → Agent 准备审批草稿 → 程序提交审批 →
    daemon 重启后程序短 observe → approved → 原门禁重跑 → 父 MR ready；重复 reconcile/webhook 不复制 child/审批。

### 15.6 全仓门禁

实现完成前至少要求 focused tests、typecheck、lint、format、dependency/architecture ratchets、migration/backup/restore、
frontend tests、真实 runtime security probes、system-mock E2E 与完整 `bun run gate:local`。发布后 hosted CI 必须按 exact
SHA 终态验证；取消或被 successor 覆盖的 run 不能当 pass。

### 15.7 数字员工分类、工作合同与工具箱功能验收

1. Type Package contract tests：研发、设计、测试三个 fixture 的同一 `EmployeeAuthoringManifestV1` codec 均可渲染，且不需
   frontend type switch；缺工作项合同、事件 locale 文案或系统节点误声明工具能力时 publish 拒绝。
2. WorkContract tests：input/output/schema/semantic validator/allowed tool kind 任一不匹配时工具注册拒绝；底层资源新 revision
   不漂移旧 registration；同一实现注册到两个工作项分别产出 validation receipt。
3. Toolbox API tests：所有 list/create/validate/publish 都以 type + work item + contract 闭合；body 伪造归属拒绝，system node
   create 返回 typed 4xx，无工作项的全局工具查询不能用于员工 picker。
4. Employee compile tests：岗位模板默认工具和员工 override 只解析当前分类/工作项的 published registration；缺失、多主工具无
   rule、retired/invisible/incompatible registration 全部给出工作项级诊断。
5. Global policy tests：Reaction plan 的 same/fresh-scene/backoff/budget 只来自 Case pin revision；工具、分类、岗位模板和员工 DTO
   均无 retry 字段；发布新策略不改变 active Case，显式 upgrade 才生效。
6. Frontend component/E2E：从 `/digital-employees` 选分类 → 工具箱点工作项 → 注册已有 Agent/Workflow 或定义 ProgramTool → 合同校验并发布 → 创建员工
   → 选岗位模板/范围 → 发布。全程无阶段下拉、edge drag、Event/Context/effect/retry 和裸 ID；节点/列表/返回草稿深链可刷新恢复。
7. i18n tests：Event Catalog 的支持 locale 均能解析显示名/说明，fallback 稳定；业务活动只显示事件业务文案，技术权限展开后才见
   machine ID；事件“为何唤醒”与工作项“做什么”的文案字段分别渲染。
8. ExecutionContract tests：外部 ID 直接字段、小输入 env/大输入 file transport、Agent exact declaration/result port、Workflow
   structural closure、Program 真实 Script fixture、extra/missing/cross-round 输出均有正反向回归；编辑发布与运行调用同一 validator。
9. Responsibility lane component/E2E：type package 缺 lane/未知 lane 拒绝；事件入口节点居中，同一支线节点 x 单调、不同支线 y 分离，
   回边拥有独立 loop 样式；研发/设计/测试复用同一布局函数，窄屏滚动后仍可看到全景。

## 16. 被否决的方案

| 方案                                                                 | 否决原因                                                                               |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 在 RFC-304 五能力上继续加 `pipeline-download`/`requirement-download` | 仍然是孤立 WorkItem，没有一条到 MR terminal 的业务聚合                                 |
| 让 Agent 规划下一工具/能力/员工                                      | 相同输入不可重放，权限和重试边界无法静态证明，违背用户“全基于规则”                     |
| 让用户任意编辑 stage DAG                                             | 规则/能力合同、output validator、恢复与 authority 无法闭包验证；配置错误会变运行时事故 |
| 保留 arbitrate/select 脚本作为“高级模式”                             | 形成第二决策引擎，预演/trace/安全 guard 可被绕过                                       |
| 只在 prompt 写“不要 Git”                                             | Agent 仍能写 index/refs、拿 credential、调用绝对 binary；不是权限边界                  |
| 让 Agent commit，平台只 push                                         | commit 已修改 Git/object/ref，且作者/内容/排除/崩溃恢复不再由平台确定                  |
| 把需求/日志正文放 DB 或 prompt                                       | 大小、敏感性、重放和内存不可控；无法支持 GB 级流水线证据                               |
| 直接信 webhook/pipeline callback 状态                                | 乱序/重放/丢失和 head race 会产生从未存在过的组合 snapshot                             |
| `ready` 后停止看护                                                   | 新评论、head、target、gate 都会让 ready 失效；Mission 必须持续到 terminal              |
| 自动 resolve/approve/merge                                           | 越过 committer 审核责任；用户已明确平台只维持可合入并跟踪                              |
| v1/v2 双 writer 渐进运行同一 MR                                      | 产生重复 commit/comment、互相抢 head，无法通过幂等 key 修复业务竞争                    |
| generic adapter `{action, params}`                                   | 无法在类型层证明 merge/approve/custom 不可达，也会把 provider 细节泄入业务层           |
| 全局“执行者库”直接供所有员工节点选择                                 | 丢失分类、工作项和 WorkContract 归属，错误实现只能到运行时才暴露                       |
| 增加工具时再次选择阶段/工作项                                        | 当前节点已确定归属，重复选择会制造 UI 状态与真实合同不一致                             |
| 在员工/节点/工具上各自配置 retry                                     | 产生多层覆盖和在途漂移；无法解释某次 attempt 实际采用哪套策略                          |
| 在员工实例中配置 Event、Context、Effect 和流程边                     | 把程序化类型定义泄漏给业务用户，重新退化为任意工作流编辑器                             |

## 17. 本轮批准门

本设计将 proposal §15 的 D1–D27 具体化。新 OS 实现门批准前只允许继续评审/修订 RFC；不允许创建 migration、schema、
runtime profile、API/UI 或 worker 实现。批准后也按 [plan.md](./plan.md) 的切片逐批交付，第一批先建立架构/
安全 ratchet 和可运行 contract probe，不直接打开生产 Mission writer。

## 18. 三轮功能自审与用户补充复核记录（2026-08-18）

本轮按用户要求只审功能闭环、规则可执行性和失败恢复，不把安全方向作为审计范围。既有 no-Git、权限、evidence
边界仍是设计合同，但本表不宣称已对其做独立安全证明。

| 自审轮次           | 主要追问                                               | 发现的功能断点                                                                                                                                                                                                                                   | 已折入设计的闭环                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第一轮：端到端旅程 | 只给 ID 后是否真能一路走到可合入并持续跟踪             | 省略 sourceKey 时持久化身份过早要求已解析来源且多结果无回填命令；requirement 澄清 port 没有决策动作；新建/接管 MR 与分支合同不完整；polyglot 选择循环；no-change、human push、reopen 无合法语义                                                  | 稳定 submission identity + employee 后解析 binding + source-selection command；QuestionSet/AnswerSet closed decision；`MissionDeliveryTarget`；repo 先选 employee、模块 facts 再选 action；`completed-no-change`；human push 失效重算；reopen 新 generation |
| 第二轮：规则与配置 | 每个选择是否都能由已发布规则唯一算出                   | employee selection 与 employee 内 policy 循环；显式员工仍被强制依赖 assignment；只有 ID 时 adapter/default 不唯一；unknown/stale 被当 false；模板 compatibility 成了第二 selector；多评论由 Agent 挑；运行时 policy merge 会漂移                 | optional assignment + direct/rule selection receipt；唯一 requirement source 默认；四态 FactCell 与 indeterminate；employee route 唯一 selector；`WorkSelectionReceipt`；完整 immutable policy/closure pin 与原子 upgrade                                   |
| 第三轮：失败与恢复 | 外部系统、daemon、人工接管后是否还能推进而不丢生命周期 | required pipeline 缺 run 会永等；handoff 会停止跟踪；内存 timer 重启丢失；失败类型不可执行；cancel/handoff 会误作废结果未知的外部 effect；无 MR 时人工接管后无法续接                                                                             | `pipeline.trigger` 与独立预算；正交 `tracking-only`；durable wait/wake；closed failure taxonomy；transition fence 后先 reconcile；cancel 不动外部 MR/branch/commit；校验 `AttachMergeRequestToMission` 后继续 care                                          |
| 补充复核：直接输入 | 上传文件能否从 UI 一直成为正确且只提交一次的仓库改动   | `uploadRef` 无产生/claim/TTL；“public 无路径”误伤逻辑目标；action no-change 与 repo diff 混淆会吞 seed；首次 push 后旧 plan 会自撞/回执丢失会再 seed；already-present 会造空 seed；handoff/提前合入可丢上传；mode/filter/ignore 可使 commit 变样 | upload session + atomic claim；`RepoRelativePath` 例外；action/repo 双 baseline；null seed + baseline fulfillment；首次 publish seed-absorption/remote 补账；外部 fulfillment 与 unfulfilled terminal；mode/filter round-trip；body 仅 evidence             |

用户补充“首版可写正文/传文件”和“上传时指定仓库路径并随 Git 提交”后，额外从入口到 commit 做了一轮纵向复核。原设计只把
上传文件放入 RequirementBundle，会让它成为只读附件而没有进入候选改动的强保证。现已补成双投影：bundle 供 Agent 读取，
immutable RepositoryUploadPlan 由平台按 frozen baseline 生成 `SeedChangeRef`；create/replace CAS、preserve/editable、fresh
重建、首次 publish 后 seed 吸收、candidate 完整性、no-change、UI preview、持久化与 E2E 均有对应合同。Agent 仍不复制文件、
不选择路径、不执行 Git。

补充复核后的功能判定：目标模型已形成从 admission、资料获取、确定性选择、Agent action、平台发布、MR care、人工接管到
external terminal 的闭环；未发现仍需由 Agent 自行决定下一动作的合法路径。剩余不确定性属于实施期 contract probe、
provider 适配和真实 E2E 的可行性验证，由 plan PR-0 及对应批次设置停止条件，不能用实现期临时分支改写本设计。

## 19. 实现前用户裁决（2026-08-18，实现授权时）

用户批准 D1–D12 并授权实现，同时对实现范围做出四项裁决，本文件相关章节已按此修订：

| 裁决          | 内容                                                                                                                                                                            | 落点                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 设计门        | 跳过 Codex 设计门补跑，直接进入 PR-0；实现门照常在各批 declare done 前跑                                                                                                        | 流程                                         |
| 执行边界      | **不引入沙箱**：不做 OS sandbox、只读 Git view、command broker、env allowlist 重构；no-Git 以「提示词禁止 + 前后快照事后校验 + 违规整树回退」强制，凭据/Git identity 仍然零注入 | §0.2/§0.3/§7.6/§7.7/§14.1/§15.3、plan PR-0/4 |
| 网络          | **不做网络相关安全动作**：无 outbound deny、无 allowlist、无网络 fence；LLM 流量（含自定义网关）不受平台干预                                                                    | §7.6                                         |
| provider 范围 | 首版在既有 system mock 包里新增 requirement/pipeline provider mock 能力并实现完整用例防护；真实自研系统 adapter 由使用方自写，平台交付 adapter 框架 + 编写文档                  | §15.4、plan T6/T36/T70                       |

OS 级隔离与网络边界若未来引入，须另立 RFC 并按能力影响清单呈批；本 RFC 其余合同不因此裁决放松（envelope、
closed effect union、source-control 独占 Git、快照对拍、回退台账、决策确定性均不变）。

## 20. 数字员工 OS 配置设计三轮功能自审（2026-08-20）

本轮只审功能可用性、确定性和横向扩展，不宣称完成独立安全审计。

| 自审轮次                                 | 从哪个 User Case 反推                                                               | 发现的功能断点                                                                                                               | 已收口的设计                                                                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第一轮：从空分类到员工可发布             | 管理员如何给研发分类的“处理流水线”增加识别/修复工具，再建立 Java/C++ 岗位并创建员工 | 全局执行者列表无法表达工具属于哪个节点；增加工具再选阶段会漂移；Program/脚本没有明确的产品定义点；岗位模板能选却没有管理入口 | 唯一四层层级；工具 API 强制 type+work item+contract；Agent/Workflow 引用原库，ProgramTool 直接在节点工具箱定义并复用 Script executor；岗位模板在分类“员工”页次级管理             |
| 第二轮：Event 到 Reaction 再到下一次关注 | 评论与红门禁同时到达时，如何按优先级逐轮处理；工具失败、合同升版或退役时如何恢复    | Event 与工作项曾重复表达动作；节点 failure/retry 会与共享限额冲突；同名/retired 工具可能被运行时静默替换                     | Event 只说明唤醒原因且国际化；工作项说明职责动作；队列优先级由类型包冻结；Case pin 限额快照和 exact registration；退役/升版只能显式 upgrade，不按名称 fallback                   |
| 第三轮：设计/测试员工复用                | 把研发分类替换为设计或测试分类，通用 core/UI 是否仍成立                             | `repositoryScopeRef`、固定工具角色和 `/code` canonical route 把研发概念泄漏进公共 OS                                         | 改为 type-defined WorkScopeContract、opaque ToolRoleRef 和 `/digital-employees` canonical route；研发仓库范围仅是一个 type codec；三个 fixture 类型共用 manifest/画布/工具箱组件 |

三轮后，业务配置闭包为：分类包程序化定义职责、合同、事件和规则；分类工具箱为每个工作项准备合格工具；岗位模板预选默认
工具；具体员工只选择模板、名称/启停、适用范围和必要覆盖；运行 Case pin 员工/type/tool/limits-snapshot revision。任一层缺失都在
validate/publish/admission 给出工作项级诊断，不推迟到 Agent 运行时猜测。
