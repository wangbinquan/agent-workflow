# RFC-292 技术设计 — 统一触发上下文命名空间

> 产品视角见 [`proposal.md`](./proposal.md)，任务分解见 [`plan.md`](./plan.md)，设计门见
> [`design-gate-2026-08-12.md`](./design-gate-2026-08-12.md)。

## 1. 现状数据流与断点

Webhook fire 的触发快照链已经存在：

```text
CodeHostEvent
  └─ triggerContextOf(event)                  shared/codeHost/triggerContext.ts
       └─ ExecutionInvoker.webhook             execution/types.ts
            └─ depsForInvoker                  execution/executor.ts
                 └─ StartTaskDeps.triggerContext
                      └─ tasks.trigger_context_json (initial INSERT)
                           └─ scheduler task snapshot
```

2026-08-10 已修正过一次关键竞态：`startTask()` 在返回前就启动 scheduler，因此 trigger context 必须进入
初始 INSERT，不能在 launch 后 UPDATE。本 RFC 不改变这一发布边界，只改变快照形状与消费者。

当前断点在 INSERT 之后：

- `runCodeHostCallNode` 自己解析 JSON，并只交给 `executeCodeHostCall`；
- agent dispatch、fanout shard、aggregator 的 `runNode` 参数没有 trigger context；
- `renderCallGoal` 是 scheduler 内第三套模板替换器；
- child task 的 `buildChildDeps` 不继承 parent trigger context；
- webhook launch payload 则绕过 task context，使用另一套扁平 `renderTemplate`。

全面盘点还发现六类容易在“改了 renderer”后继续漂移的旁路：

- `signalPromptGuard.ts`、frontend `promptRefs.tsx` 与 workflow validator 各有自己的 `{{ref}}` regex；
- code-host custom query/body 和 preset 可选参数不会像必填参数一样报告 missing context，可能带空值继续发 HTTP；
- scheduler 六个生产 `runNode` 家族里，只有普通/fanout/aggregator 是作者模板；workgroup/dynamic host、
  commit-message agent、merge-conflict agent 是框架已组合的数据，统一 parser 若无边界会把 diff/goal 里的字面 token
  二次展开；
- 动态工作流 orchestrator 是 Intent 之外的第二个 workflow 生成面，仍写 schema v4，也没有 trigger vocabulary；
- `review.commentInjectTemplate` 已在 strict schema、Inspector 和双语文案中声明为作者模板，但生产 runtime 没有
  读取它；若 workflow inventory 只列常见三种节点，它会继续成为一块既不执行、也不统一校验的死配置；
- `syncTaskWorkflow` 能把最新 definition 原子换进一个已存在 task 后立即 resume；若只在“新建 task”入口 preflight，
  非 webhook task 可通过 sync 中途换入 trigger dependency，直到后续节点才失败。

## 2. 权威模型

### 2.1 完整根类型，不再混叫

```ts
export type WebhookTriggerFields = Readonly<
  { event_type: CodeHostEventType } &
    Partial<Record<Exclude<WebhookTemplateVar, 'event_type'>, string>>
>

export interface TriggerContext {
  readonly trigger: {
    readonly webhook: WebhookTriggerFields
  }
}
```

- 权威类型/schema/decoder 落在中立的 `packages/shared/src/triggerContext.ts`，Webhook event→context 的 source
  adapter 落 `packages/shared/src/webhookTriggerContext.ts`；不继续由 `shared/codeHost/triggerContext.ts` 反向拥有
  平台契约。旧 code-host 模块删除，中立符号统一从 shared index 导出；
- `WebhookTemplateVar` / `WEBHOOK_TEMPLATE_VARS` 继续是 30 个**字段名**的单一事实源；
- `WebhookTriggerFieldsSchema` 由同一常量派生为 strict object：`event_type` 必填、其余键可选、unknown key 拒绝；
- `TriggerContext` 从对象根就携带 `trigger`，当前只有 `webhook` source；模板 resolver 不再临时拼一个虚拟根；
- `event_type` 是 source discriminator，必须存在且通过 `CodeHostEventTypeSchema`；其余空字段可省略，读取缺键与
  显式空串都渲染为空串；
- 新 webhook task 必有 `{trigger:{webhook:{...}}}`；非 webhook task 的 DB 值仍是 NULL，而不是 `{}`。

删除 `TRIGGER_CONTEXT_EXCLUDED_VARS` 的独立集合，`event_json` 与其余 29 项统一。`eventVarsOf` 已把它截断
到 32 KiB；`webhookTriggerContextOf` 只投影这 30 个标准字段，不复制 endpoint secret、headers 或 raw request。

### 2.2 持久化形状

`tasks.trigger_context_json` 不改列名、不新增 30 个列，值从：

```json
{ "event_type": "note", "mr_iid": "42", "comment_text": "please fix" }
```

改为：

```json
{
  "trigger": {
    "webhook": {
      "event_type": "note",
      "mr_iid": "42",
      "comment_text": "please fix"
    }
  }
}
```

这是 trigger 类型层，不是 workflow input。`tasks.inputs`、workflow `inputs[]`、input nodes 与 edges 均不改变。
`StartTask` / `StartAgentTask` / `StartWorkgroupTask` 的外部 wire schema 也不新增 `triggerContext`：只有内部
`ExecutionInvoker.webhook` 能从已验签、已归一化的 `CodeHostEvent` 创建根 context，node child 只能继承，普通
HTTP/multipart/schedule caller 不能伪造 webhook source。

### 2.3 一次解析，多处消费

新增 pure decoder，返回可判定结果而不是把损坏数据伪装成“不是 webhook”：

```ts
export type ParsedTriggerContext =
  | { kind: 'none' }
  | { kind: 'ok'; value: TriggerContext; migratedFromFlat: boolean }
  | { kind: 'invalid'; reason: string }

export function parseTriggerContextJson(raw: string | null): ParsedTriggerContext
```

语义：

- NULL → `{kind:'none'}`；
- 新嵌套形态 → schema parse 后返回；
- 历史扁平字符串字典且含合法 `event_type` → `{trigger:{webhook:old}}`（仅 storage migration decoder）；
- 结构损坏 → `{kind:'invalid'}`，启动/恢复报 `trigger-context-invalid`；绝不降级成 none/missing。

`runTaskInner` 读取 task row 后只解析一次，`ok.value` 放进 `SchedulerState.triggerContext`；none 映射为 null。
code-host、agent、fanout、aggregator、call goal 和 child deps 全部读这个字段，删除
`runCodeHostCallNode` 的私有 JSON.parse。`ExecutionInvoker.webhook`、`StartTaskDeps.triggerContext` 和测试 fixture
也都只接受完整根形态，内部不再出现另一种 `{webhook:...}` 半截对象。

Resume/retry/workflow-sync preview/POST 是彼此独立的权威操作，会在各自 TOCTOU 边界重新读取 task row 并调用同一
decoder；“一次解析”指一次 scheduler execution 内只由装载点解析，所有节点消费者共享 typed state，不是跨请求缓存
历史 JSON。

## 3. 统一模板引用语法

### 3.1 shared parser

新增 shared 模块（建议 `packages/shared/src/templateRef.ts`），提供唯一词法与语义解析：

```ts
export type TemplateRef =
  | { kind: 'local'; name: string }
  | { kind: 'trigger'; source: 'webhook'; field: WebhookTemplateVar }
  | { kind: 'invalid'; raw: string; reason: TemplateRefIssue }

export function extractTemplateRefs(text: string): TemplateRef[]
export function webhookTriggerRef(
  field: WebhookTemplateVar,
): `trigger.webhook.${WebhookTemplateVar}`
export function webhookTriggerToken(
  field: WebhookTemplateVar,
): `{{trigger.webhook.${WebhookTemplateVar}}}`
```

不能只把 regex 放宽为 dotted identifier：那仍会让 `{{trigger..x}}`、未闭合 trigger token 等错误因“没匹配”
漏成字面量。shared 模块必须扫描每一对 `{{` / `}}`，保留 source span，并把内部文本分类；未闭合且以
`trigger`/`!trigger` 开头的 token 明确 invalid，其它普通文本里的孤立 `{{` 保持字面，避免把代码示例误判成 ref：

```ts
export type TemplateSegment =
  | { kind: 'text'; value: string }
  | { kind: 'ref'; ref: Exclude<TemplateRef, { kind: 'invalid' }> }
  | { kind: 'literal-ref'; value: string }
  | { kind: 'invalid'; raw: string; reason: TemplateRefIssue }

export function parseTemplate(text: string): TemplateSegment[]
```

语义判定：

| raw                                       | 结果                                               |
| ----------------------------------------- | -------------------------------------------------- |
| `port_name` / `__task_id__`               | local ref，由具体使用面判 inbound/builtin          |
| `foo.bar`                                 | local ref；兼容既有 code-host dotted inbound port  |
| `foo.bar.baz`                             | invalid: malformed-local-ref                       |
| `trigger.webhook.mr_iid`                  | trigger ref                                        |
| `trigger.webhook.nope`                    | invalid: unknown-field                             |
| `trigger.other.x`                         | invalid: unknown-source                            |
| `trigger.webhook` / `trigger.webhook.a.b` | invalid: malformed-trigger-path                    |
| `trigger.mr_iid`                          | invalid: legacy-trigger-ref                        |
| `!trigger.webhook.mr_iid`                 | literal-ref；输出 `{{trigger.webhook.mr_iid}}`     |
| `!foo.bar.baz`                            | literal-ref；输出 `{{foo.bar.baz}}`，不做语义校验  |

local grammar 取既有两个运行面能力的并集：单段 `\w+`（prompt）或双段 `\w+.\w+`（code-host），但
`trigger.` 前缀始终保留给平台命名空间。各 sink 再按 inbound port 精确匹配；因此统一 trigger 不会顺手收缩
code-host 的 dotted local-port 能力。

关键点：旧/错误 trigger ref **必须被 parser 看见并报错**，不能因为正则只认 `\w+` 而从 validator 与 renderer
之间漏过去成为字面量。`{{!<body>}}` 是所有模板面的唯一字面转义：它去掉一个 `!` 后输出完整
`{{<body>}}`，不对 body 做 ref 语义校验；`{{!!x}}` 因此输出 `{{!x}}`。escape 只关闭插值，不绕过 HTTP
位置编码、branch/launch schema 或 JSON body 结构校验。空 escape、嵌套 `{{`、body 中再含 brace/control char
均是 invalid；scanner 左到右、非递归，替换进去的值即使自身含 canonical token 也绝不进行第二轮展开。

shared 同时提供 callback renderer；parser 决定“这是什么 ref”，sink 决定值如何处理：model sink fence、HTTP
sink 按位置编码、webhook launch sink 写入 typed launch payload。这样统一 grammar/context 不会抹掉不同 sink 必须
保留的安全边界。

### 3.2 各使用面的域

- Webhook launch payload：只允许 `kind:'trigger'`，任何 local ref（包括旧 `{{branch}}`）拒绝；
- agent prompt / call-workgroup goal：允许 builtin、inbound local port、trigger ref；
- code-host-call：允许 inbound local port、trigger ref；不允许 prompt builtins；
- framework-composed prompt（`expandPromptTemplate:false`）：不调用 parser，保持全字面量。

parser 负责语法与 trigger 闭集；各 validator 只负责自身 local ref 域，避免把 code-host 的 HTTP 编码语义
硬塞进通用 prompt renderer。

### 3.3 Workflow 模板面 inventory

新增 `collectWorkflowTemplateSurfaces` / `mapWorkflowTemplateSurfaces`，唯一枚举：

- `agent-single.promptTemplate`；
- `call-workgroup.goalTemplate`；
- `review.commentInjectTemplate`；
- `code-host-call.params[*]`；
- `code-host-call.request.path/query[*]/body`。

每项携带 `nodeId`、JSON pointer、sink kind 与 text。`review.commentInjectTemplate` 的域只有 review builtin
`__review_comments__` 与 trigger ref，不把被评审 agent 的 inbound port 冒充 review 节点输入。workflow validator、
v4→v5 migration、trigger dependency preflight、Intent draft scan 共用它。`signalPromptGuard` 和 frontend missing-ref
直接消费 shared parser 的 local refs，
不另列模板面。contract test 用一个含所有字段的 definition 断言 inventory 完整，后续新增模板字段漏登记即红。

## 4. Webhook 触发器模板

### 4.1 保存期与运行期

`packages/shared/src/webhookTemplate.ts` 改用 shared parser：

- `extractTemplateVars` 返回 bare `WebhookTemplateVar[]` 供事件矩阵判断，但输入 token 必须是
  `trigger.webhook.<field>`；
- `availableVarsFor(eventTypes)` 不变；
- `templateVarIssues` 继续区分 unknown 与 unavailable，message 展示完整 token；
- `renderTemplate(text, triggerContext)` 从 `context.trigger.webhook[field]` 取值；不接收扁平 vars map。

三种 launch kind 的白名单字符串遍历升级为 `collectWebhookTemplateSurfaces` /
`mapWebhookTemplateSurfaces`，每项带 launch kind、JSON pointer 与 text，覆盖 workflow mapping、agent
description/inputs、workgroup goal，以及 `CommonTemplateFields.workingBranch`。同一 inventory/mapper 同时驱动保存
校验、v1→v2 migration 和 runtime render；`workingBranch` 渲染后再过 `StartTaskSchema` 的 branch gate。contract
test 构造三种 payload 的所有模板字段，新增字符串字段却漏登记时立即失败。

### 4.2 存量 launch payload 版本

`webhook_triggers` 新增 `template_syntax_version INTEGER NOT NULL DEFAULT 1`：

- 存量行为 1；新建/更新写 2；
- v1 读取或 fire 时先用纯函数 `migrateWebhookLaunchPayloadV1ToV2(kind, payload)` 深入既有白名单模板字段，
  按 v1 的实际 grammar 做 sink-aware 迁移：已知 `{{field}}` 与已知两段/三段 trigger ref 都规范化成
  `{{trigger.webhook.field}}`；任何 unknown/malformed `trigger...` 形态都 fail-closed，不得被“保留旧字面量”分支
  escape 掩盖；旧 renderer 原本当字面量的其它非 trigger 完整 `{{body}}` 自动加一层 `!` 以保持输出字节，包括
  旧文本 `{{!x}}` 迁成 `{{!!x}}`；v1 本来就不可能合法保存的 unknown flat root token 同样 fail-closed；
- 迁移在同一事务写回 `launch_payload` + `template_syntax_version=2`，再继续触发；失败则 fire
  `launch-failed(payload-invalid)`，不以旧 renderer 兜底；
- GET/list 对合法行只返回迁移后的 v2 payload，前端不会继续编辑旧语法；损坏行沿用现有容错读形，返回
  `launchPayload:null + migrationError`，不让一条坏行炸整页，也不伪称已经迁移。

这是一条**版本化数据迁移**，不是第二套长期模板语义。v2 renderer 本身不接受根级旧 token。

## 5. Workflow schema v5

模板语义变化会影响已保存 definition 与冻结 task snapshot，故 `WORKFLOW_SCHEMA_VERSION` 从 4 升 5。

现有 backend-only `migrateDefinitionToLatest` 下沉/委托给 shared 的
`migrateWorkflowDefinitionToLatest`，新增 v4→v5 纯迁移并通过 §3.3 inventory 只处理真实模板字段。这样 workflow
CRUD、closure freezer/parser、scheduler、YAML 与 frontend/import helpers 不会各复制迁移，也避免 closure 反向
import workflow service 形成环。

迁移按 §3.3 的 sink kind 和旧 grammar 分类，而不是对 JSON 全局 replace：

- 已知 `{{trigger.<field>}}` 与已知 canonical 三段 ref 都激活/规范化为
  `{{trigger.webhook.<field>}}`，支持外层空白；这会修复 Intent 曾生成但旧 prompt renderer 留成字面量的定义；
- 不改根级 `{{mr_iid}}`，因为在 workflow prompt 里它可能是合法 inbound port，不能猜成 webhook 字段；
- code-host 既有 `{{foo.bar}}` local ref 保持 local，不误转成 namespace；
- 旧 sink 原本当字面量的其它完整 `{{body}}` 自动加一层 `!`，避免 v5 严格 scanner 把升级前合法的代码示例
  变成 blocking issue；已有新 escape 同样加一层以保持旧字面输出；
- unknown trigger field/source 不伪装成 literal，迁移后由 v5 validator fail-closed。

迁移具有以下接线：

- workflow GET：既有 heal-on-edit 路径返回 v5 canonical definition；下一次 PUT 写回；
- startTask：拿到 workflow definition 后以 v5 快照创建新 task；
- `freezeCallClosure`：每个 live child definition 先迁到 v5，再收集下一层 call ref；新 task 的
  `ref_closure_json` 因而只冻结 v5；
- scheduler：历史 task 的 v4 `workflow_snapshot` 与历史 `ref_closure_json` 内每个 child definition 都在内存中
  迁移后校验/执行，DB 中冻结历史原文不改；`parseCallClosure` 的 v1/v2 closure-key 兼容保持不变；
- YAML import/export：import 先迁移再校验，export 只产 v5；
- Intent resolve/apply、BundleApply、resource-package import/export：进入 canonical save/export 前都调用同一 helper，
  不能因为这些路径直接 `WorkflowDefinitionSchema.parse` 或直读 DB 而保存/导出 v4；
- task workflow-sync：candidate definition 先迁移，并按当前 actor/既有 sync 授权重新冻结与 candidate root 匹配的
  call closure；随后用 task 行冻结的 context 对 candidate root + candidate closure preflight，成功时才把
  `workflow_snapshot`、`workflow_version`、`ref_closure_json` 与 status 同一 CAS 换入；不能继续沿用旧 closure；
- Intent resolve：新 changeset 必须产 v5；历史不可变 draft 不改 hash，旧 token 进入 repair feedback 后重生成。

所有生产 definition construction site（agent/workgroup host、dynamic generate snapshot/生成 DAG、fusion、
workflow quick-create/starter/autosave/画布临时 definition、validator 内部临时 definition、Intent 文档）改为
`WORKFLOW_SCHEMA_VERSION`，不继续在新对象里写 1/4。源码 ratchet 枚举 production `$schema_version:` 写点；只有
v1→v4→v5 migration 分支和明确的兼容 fixture 可以硬编码旧版本。

另设 definition boundary ratchet，枚举所有会直接 `WorkflowDefinitionSchema.parse/safeParse` 或序列化 definition 的
生产位置；每个位置必须被归类为“先调用 latest helper”“只读取已经 canonical 的 typed value”或“历史审计展示、不得
改写”。这样新增 bundle/import/recovery 路径不能绕过 v5 migration，也不会把 task 详情里的历史 snapshot 擅自改写。

v5 validator 不接受 `{{trigger.<field>}}`。旧定义能运行靠 v4→v5 migration，不靠 v5 parser 的 alias。

## 6. Agent prompt 渲染

### 6.1 RenderPromptInput

`RenderPromptInput` 与 `RunNodeOptions` 新增：

```ts
triggerContext: TriggerContext | null
```

生产调用只有两态：object = 真实 webhook task，null = 非 webhook。引用 trigger 且为 null 在 task-level
preflight 已拒绝，runner 仍保留 pre-spawn defense-in-depth。编辑器 preview 必须显式传
`sampleWebhookTriggerContext()`（值如 `<trigger.webhook.comment_text>`），不引入“undefined 就保留 token”的第三套
运行语义。为减少一次性测试迁移，纯函数参数可在 TypeScript 入口暂时 optional，但内部默认严格等价于 null；任何
含 trigger ref 的调用都不能静默保留字面量。

### 6.2 渲染与围栏

agent trigger 值是外部不可信文本，替换必须走：

```ts
fenceUntrusted(`trigger-webhook-${field}`, value, envelopeNonce)
```

不得直接 `return value`。这与 inbound port、review comments、sibling outputs 的现有处理同档。

- context 存在但 field 缺失：围栏空串（与 webhook 模板的运行期宽松语义一致）；
- context 为 null：不进入渲染，runner 返回 `trigger-context-missing`；
- inline clarify rerun：原始首轮 prompt 已在 resumed session，中途不重新注入 trigger，行为与 inbound port
  的 RFC-026 去重规则一致；fresh/isolated rerun 重新渲染同一 task snapshot。

`referenced` 集合继续只记录 local port/builtin 名字；trigger ref 不会让同名 input section 被误判已消费。

### 6.3 Review comment injection

`review.commentInjectTemplate` 是现有 schema/UI 已公开的作者模板，不能继续只存不执行。把它纳入 §3.3 inventory，
并在 review 驱动的 iterate rerun 组装阶段使用同一 parser：

- 允许 `{{__review_comments__}}` 与 canonical trigger ref；其它 local ref 在保存期拒绝，因为 review 节点没有对应的
  通用 inbound-port 域；
- 模板静态文本保持作者文本；review comments 与每个 trigger replacement 分别经 `fenceUntrusted`，不能把整个
  作者模板围栏成纯数据，也不能把评论/trigger 裸拼；
- `ReviewPromptContext` 用显式 raw/pre-rendered 判别承载结果，`renderUserPrompt` 遇到 pre-rendered 片段不再二次围栏；
  默认空模板继续走现有 comments markdown + 单次围栏，字节语义不变；
- 读取当前 task 的冻结 TriggerContext，不查询 webhook delivery；首次运行与 reject rerun 不使用该 comments 模板，
  reject 继续走 `__review_rejection__` 既有语义，只有真实 iterate rerun 消费。

这同时修复该字段当前“schema + Inspector 可编辑、runtime 零读取”的死配置。迁移与 validator 仍覆盖它，即便某条
执行没有发生 review rerun，也能在 task 首个副作用前发现缺失 trigger source。

### 6.4 六个 runNode 家族的展开边界

Scheduler 的六个生产 `runNode` 家族必须逐项分类：

| 调用家族                              | `expandPromptTemplate` | trigger context                         |
| ------------------------------------- | ---------------------- | --------------------------------------- |
| 普通 `agent-single`（review/retry）   | true                   | 传 `state.triggerContext`               |
| wrapper-fanout shard                  | true                   | 传 `state.triggerContext`               |
| wrapper-fanout aggregator             | true                   | 传 `state.triggerContext`               |
| workgroup / dynamic orchestrator host | false（既有）          | 可传但绝不解析                          |
| commit-message synthetic agent        | false（本 RFC 补齐）   | 不解析，防 diff 中 token 被展开         |
| merge-conflict synthetic agent        | false（本 RFC 补齐）   | 不解析，防 manifest/content 二次展开    |

源码层 inventory/test 锁定所有生产 `runNode({` 调用的分类。不能用“所有调用都塞 context + 默认展开”这种看似
统一的做法；那会把框架 prompt 中的用户数据当模板执行。

## 7. `call-workgroup` 与子任务传播

### 7.1 goalTemplate

删除 scheduler 私有 `renderCallGoal` 的 `\w+` regex，改为复用 shared resolver：

- local/builtin 语义保持现状；
- trigger 从 `state.triggerContext` 读取；
- context null 且模板引用 trigger → 在创建 child task 前令 call node 失败
  `trigger-context-missing`；
- 渲染后的 goal 作为**字面数据**交给 `startWorkgroupTaskFromFrozen`；工作组 host 层继续
  `expandPromptTemplate:false` 并用既有 goal fence，不做第二次 trigger 展开。

### 7.2 call tree 继承

`buildChildDeps(state)` 增加完整根对象：

```ts
...(state.triggerContext !== null ? { triggerContext: state.triggerContext } : {})
```

对 `call-workflow` 与 frozen `call-workgroup` 两条 child launch 都生效。`startTask` / workgroup launch 继续把它与
`parentTaskId`、`parentNodeRunId`、`invocationDepth` 一起写进 child 初始 INSERT；不允许创建后补写。

继承的是**根 webhook event 快照**，不是父节点渲染后的字符串，也不重新读取 webhook delivery。于是 retry、
resume、孙任务全都使用同一冻结输入。

## 8. Code-host 收口

`packages/shared/src/codeHost/template.ts` 保留 HTTP 位置编码职责，但删除自己的 trigger grammar：

- `CodeHostVarRef` 改为/复用 shared `TemplateRef`；
- `CodeHostTemplateContext.triggerContext` 类型改为统一 `TriggerContext | null`；
- `extractCodeHostVars` 可保留兼容导出名，但内部调用唯一 parser；后续可在同 RFC 内直接改调用方后删除；
- resolve 路径固定为 `ctx.triggerContext.trigger.webhook[field]`；
- custom JSON body sentinel 逻辑使用同一个 token matcher，所以三段 token 在字符串位置检查、转义与
  `var-in-key` 判定里完整工作。

错误语义统一：

- 新运行缺 context → `trigger-context-missing`；
- `code-host-trigger-context-missing` 留在 shared task error schema 中只为历史 node run/API 反序列化，不再产出；
- required field 渲染为空但 context 存在 → 仍是 `code-host-param-missing`；
- unknown field/source → 保存期 issue，不发 HTTP。

missing 判据在组装 request 前对**所有** refs 一次完成，不再只从 preset required-field loop 顺带发现。
custom path/query/body、preset optional params 只要引用 trigger 且 context 不满足，也必须在 fetch 前失败；不能把空串
带进 URL/body 后继续请求。

schema 的长度上限约束模板源码，不足以约束展开结果；`event_json` 虽单值最多 32 KiB，同一模板仍可重复引用。
request assembly 因而在编码/序列化后、fetch 前再执行同一组上限：final encoded relative path ≤
`CODE_HOST_PATH_MAX`、每个最终 assembled param/query value（含 transform 后、URLSearchParams 编码前）≤
`CODE_HOST_PARAM_MAX`、任何 preset/custom JSON body 的最终序列化值 ≤
`CODE_HOST_BODY_MAX`。超限 fail-closed，不截断（截断会改变 API 定位/body 语义），错误详情只点名 field/location 和
limit，不回显值；测试锁定 fetch 0 calls。

原有 credential、redirect、retry、path escape、JSON encoding、response 上限全部不变。

## 9. Validator 与失败顺序

### 9.1 Workflow 保存期

agent prompt / call-workgroup goal 的 validator：

1. shared parser 提取全部 refs；
2. trigger ref 验证 source + known field 后直接通过，不查 inbound；
3. local ref 继续按 `BUILTIN_VARS` / deprecated tokens / inbound ports 判定；
4. invalid dotted ref 输出指向 node prompt field 的 blocking issue。

code-host validator 使用同一 trigger 判定 + 自身 inbound port / JSON/path 规则。

仍不校验 workflow 是否已绑定 webhook trigger（RFC-269 D24 的正确部分保留）。

### 9.2 执行上下文 preflight

Shared 提供 pure `collectTriggerDependencies` / `evaluateTriggerDependencies`，由 §3.3 inventory 提取字段集合并
产出结构化 issue；backend 唯一编排入口放在
`packages/backend/src/services/execution/triggerPreflight.ts`，负责 root/closure source、错误映射与最早调用时点。
preflight 的 source 输入只有三种：`none`、本次真实 `TriggerContext`、保存期 `eventTypes` 集合；不得让各调用方
自己发明 missing 判据。判定顺序固定：

1. 非 NULL context JSON 解码损坏或缺少合法 `event_type` → `trigger-context-invalid`；
2. definition/closure 无 trigger ref → 不要求 source；
3. 有 ref、source 为 none → `trigger-context-missing`；
4. 根据真实 `context.trigger.webhook.event_type` 或保存期 eventTypes 交集与 `WEBHOOK_EVENT_VAR_MATRIX`，引用字段
   结构上不适用 →
   `trigger-field-unavailable`；
5. 字段适用但值缺失/空 → 合法空串。

失败详情最多包含 source、field、`event_type` 与 definition pointer，不回显 context value、`event_json` 或损坏 JSON
原文；日志、node run 与 API 共享这一 redaction 规则。

权威调用矩阵是：

| 入口                                           | source                            | 最迟时点                                                                 |
| ---------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| 手动 JSON / multipart / relaunch-as-new        | none                              | 冻结 closure 后、任何 repo/upload materialization 前                     |
| scheduled create/update/run-now/fire           | none                              | `assertScheduledTargetUsable`，保存/每次 fire 均对账                      |
| webhook trigger create/update                  | selected eventTypes               | 保存事务前，对当前 root + 可见 call closure 彩排                          |
| webhook delivery / replay fire                 | 本次真实 event context            | render/launch 前；随后 `startTask` 对同一冻结 closure 再做权威检查         |
| root/child `startTask`                          | deps 中 none 或继承的完整 context | closure freeze 后、task INSERT 前；由自身物化的路径也在 materialize 前    |
| historical task resume/retry                   | row 中冻结 context                | lifecycle/status CAS 与 scheduler attach 前，对内存迁移后的 snapshot + frozen closure |
| task workflow-sync                             | row 中冻结 context                | candidate v5 root + 重冻 closure 后、snapshot/version/closure/status CAS 与 scheduler kick 前 |
| dynamic-workflow generated DAG                 | 当前 task context                 | 进入 human confirm 前，并在 confirm 后执行前保留同一检查                  |

source 的所有权不可互换：新 root 只接受受信 `ExecutionInvoker.webhook` 生成的 context；child 只接受 parent
`SchedulerState` 继承值；resume/retry/workflow-sync/dynamic confirm 必须重新解码 task row，忽略调用这些操作时
`StartTaskDeps` 上任何新塞入的 context。否则“恢复”会变成替换历史触发事实的隐蔽公开入口。

源码 producer ratchet 将生产 `triggerContext:` 写点锁为两类：webhook invoker 的 normalized-event projector 与
`buildChildDeps` 的 parent inheritance。Route wire、schedule、resume/retry/sync/dynamic confirm 不在 allowlist；新增第三个
生产写点必须先扩展 trigger source RFC，不能借 `StartTaskDeps` 的内部字段偷渡。

`workflow-sync-preview` 也调用同一 candidate preparation，并把 trigger missing/invalid/unavailable 作为 blocking
reason/issue 返回，不能先显示“可同步”再在确认 POST 才突然失败；POST 仍重新冻结、重新对账并以版本 + task ownership
CAS 作为权威 TOCTOU 门。

当前 workflow multipart 路由和 agent upload 路径存在 `materializedSpace` handoff：工作区可能在进入 `startTask`
前已经创建。因此把“冻结 definition/closure + static validation + trigger preflight”抽成可复用 launch preparation，
公开 workflow multipart 路径必须在物化前调用；`startTask` 再做一次 defense-in-depth。child iso 已由父 scheduler
创建，但父 root closure preflight 必须在父任务第一个节点前覆盖其 child definition。内部 fusion/agent/workgroup host
不含作者 trigger 模板，仍由 production-definition ratchet 锁住。

runner、call-workgroup 与 code-host 仍各保留 sink 前 defense-in-depth，但不能依赖它们作为主门：否则 DAG 前半段
可能已经有模型/脚本/HTTP 副作用，后半段才发现 trigger 不存在。

## 10. Intent Builder

`intentDoc.ts` 更新为 workflow schema v5，并明确：

- agent `promptTemplate`、`call-workgroup.goalTemplate`、`review.commentInjectTemplate`、`code-host-call` 全部可用
  `{{trigger.webhook.<field>}}`；
- 列出/派生全部 30 个字段，说明 `event_json` 32 KiB；
- 使用 trigger 不需要 workflow input/input node/edge；
- 只有用户明确要求“把事件值暴露成可手动填写的业务输入、让同一工作流脱离 webhook 也能复用”时，才设计
  workflow input；不能把所有 trigger 字段机械铺平；
- 旧 `{{field}}` 与 `{{trigger.field}}` 禁止生成。

这段 trigger vocabulary 是 workflow 全局能力，必须在 Intent 文档的公共 workflow 章节中无条件出现；不能继续
藏在 `code-host-calls:author` 权限控制的 code-host 节点说明里。权限只决定模型能否生成该 NodeKind，不决定 agent /
workgroup prompt 能否知道 canonical trigger 语法。Intent apply 只是保存资源，不要求当时已有 webhook rule；真正
执行仍由 §9.2 source preflight 负责。

Intent 草稿 gate 在 canonical workflow validation 前扫描 invalid/legacy trigger ref，把精确修复提示喂回下一轮；
已生成的 v5 canonical ref 正常通过，不再阻断。

`resolveChangeset.validateDraftChangeset` 使用 §3.3 inventory + shared parser；Intent preview 的 workflow 映射和
prompt diff 不自写 trigger 规则。`intentDoc` 的字段目录从 `WEBHOOK_TEMPLATE_VARS` / canonical helper 派生，避免
code-host 一份、agent 一份。

动态工作流 orchestrator 也更新为 v5 vocabulary：build prompt 明确携带“本 task 是否有 webhook context”及其
`event_type` 对应的可用**字段名**，不携带 comment/event_json 等实际值。没有 context 时禁止生成 trigger ref；有
context 时只能生成 canonical ref。生成结果仍走同一 workflow validator + context preflight，不因它是运行期生成就旁路。

## 11. Frontend 与文档

### 11.1 UI

- `TemplateVarChips` 仍接收字符串 name，但 webhook 展示 helper 传入
  `trigger.webhook.${field}`，按钮/插入内容自然是完整 token；
- Webhook Trigger 面板三种 payload 编辑器全部更新，包含三类 `workingBranch` 输入框；
- CodeHostCall Inspector trigger chips 更新；
- CodeHost custom request 补齐现有 schema 已支持但 UI 缺失的 query key/value 编辑面：key 保持结构化字面量，只有
  value 是 template target，每个 value 都能插入同一 trigger/local chips；
- agent prompt 与 call-workgroup goal Inspector 增加同一组 webhook trigger chips（复用组件、分组与文案，
  不新建私有 UI）；
- Review Inspector 的 `commentInjectTemplate` 增加同一组 trigger chips，并同时展示唯一合法 review builtin；
- frontend `extractMissingRefs` 通过 shared parser 只检查 local refs；合法 trigger 不显示成 missing port，invalid ref
  单列 blocking diagnostic；shared `signalPromptGuard` 同理只检查 local ref 且修复现有 whitespace regex 漂移；
- agent PromptPreview 与 call-workgroup goal preview 都传确定性 sample TriggerContext，并显示“真实运行由 webhook
  填充”；可切换 none 预览缺 context 诊断，但 renderer 自身没有 preview-only 保留 token 语义；goal preview
  复用 parent-side shared resolver，并标明真实 child host 会把整个渲染结果围栏一次；
- review comment injection preview 使用确定性 sample comments + 同一 sample TriggerContext，展示静态文本与两类
  replacement 的实际单次围栏；none-context 同样显示 blocking 诊断；
- Intent workflow preview/差异识别 agent prompt、call-workgroup goal、review comment injection、code-host template
  inventory，不只看 `promptTemplate`。

### 11.2 文档与历史 RFC

实施时同步更新：

- `docs/webhook-triggers.md`；
- `docs/code-host-calls.md`；
- `docs/workflow-yaml.md`；
- RFC-257 的扁平模板章节加 RFC-292 superseded 横幅并改现行示例；
- RFC-269 Q10 / D16 / 双层源码锁标为被 RFC-292 取代，示例全部三段化；
- workflow/webhook 模板生产器、对应双语帮助文本与现行文档中的旧 token 只允许出现在 migration fixture、历史错误码
  说明和 supersession 叙述；ratchet 按已登记的模板/帮助表面做语义扫描，不能用全仓裸 grep 误伤 i18next 自身的
  `{{provider}}` / `{{branch}}` 插值或普通代码示例；
- source ratchet 禁止 `TRIGGER_CONTEXT_VARS` / `TRIGGER_CONTEXT_EXCLUDED_VARS` /
  `CODE_HOST_TRIGGER_PREFIX` 重新成为生产事实源，并禁止生产 import 重新指向已删除的
  `shared/codeHost/triggerContext` 深路径。

## 12. 数据迁移

### 12.1 DB migration（当前暂定 0150）

2026-08-12 RFC-291 批①已提交并使用 0149；RFC-292 不触碰/复用该号，当前暂定 0150。实施前仍必须按 live
`_journal.json` 重新取下一号；若其它 migration 先落，不抢占同号。

- `webhook_triggers.template_syntax_version`：存量默认 1；服务迁移后写 2；
- 不给 workflows 加额外列，definition 自带 `$schema_version`；
- 不给 tasks 加额外列；migration 用 SQLite JSON1 将合法历史扁平字典一次性包成
  `{trigger:{webhook:...}}`，runtime decoder 仍保留兼容防线供漏网/导入旧库使用；损坏行原样保留并 fail-closed。

### 12.2 存量对象矩阵

| 对象                           | 迁移                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| webhook trigger launch payload | v1→v2 纯函数，读取/fire 前事务写回                                                 |
| workflow row v4 definition     | shared latest helper 返回 v5，heal-on-edit 写回；bundle/resource-package/YAML export 只出 v5 |
| 新 task snapshot               | launch 前即为 v5                                                                   |
| 历史 v4 task snapshot          | scheduler 内存迁移，不改冻结审计原文                                               |
| 新 task trigger context        | 写含合法 `event_type` 的 `{trigger:{webhook:{…}}}`                                 |
| 历史扁平 task context          | DB backfill + decoder 包成 `{trigger:{webhook:old}}`；无从恢复的 event_json 缺键    |
| immutable Intent draft         | 不改 `changeset_json` / hash；下一 turn 的 repair feedback 生成 v5 canonical draft |
| 已落 `node_runs.prompt_text`   | 不改历史审计文本                                                                   |

所有 migration pure helpers 都需幂等测试；v2/v5 数据再次迁移逐字节不变。

## 13. 失败模式

| #   | 场景                                                              | 行为                                                                           |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| F1  | 非 webhook task 使用 trigger                                      | public launch materialize/task INSERT 前 `trigger-context-missing`             |
| F2  | context JSON 损坏                                                 | `trigger-context-invalid`；不降级成 missing、不把任意对象强转                  |
| F2a | context 有 webhook 根但无合法 `event_type`                        | `trigger-context-invalid`；不能跳过事件矩阵对账                                |
| F3  | 字段适用于 event 但本次没有值                                     | 渲染空串；code-host required field 再报 `code-host-param-missing`              |
| F3a | 字段不适用于当前 `event_type`                                     | save/fire/start preflight `trigger-field-unavailable`                          |
| F4  | v1 webhook payload 含 unknown root token                          | 视为损坏行，v2 validator 拒绝并标具体 token                                    |
| F5  | v4 workflow 同时有 inbound `{{mr_iid}}` 与旧 `{{trigger.mr_iid}}` | 只迁移后者；前者仍是端口，不猜来源                                             |
| F5a | v4 code-host 使用 local `{{foo.bar}}`                             | 保持 local ref；统一 parser 不把它误判为 namespace                             |
| F5b | 旧模板用 `{{foo.bar.baz}}` 作为字面代码示例                       | sink-aware migration 自动变 `{{!foo.bar.baz}}`，渲染字节不变                   |
| F6  | trigger 文本包含 `</aw-input>` / prompt injection                 | `fenceUntrusted` nonce + escaping 隔离，测试用恶意值验证                       |
| F7  | `event_json` 超长                                                 | 沿用 32 KiB 截断；不让 task 行无限膨胀                                         |
| F8  | child task launch 中途失败                                        | trigger 与 child row 同一 INSERT；不存在 child 已启动但 context 后补失败的竞态 |
| F9  | framework-composed goal 里有字面 trigger token                    | `expandPromptTemplate:false` 保留字面，不二次展开                              |
| F10 | 作者确需字面 canonical token                                      | `{{!trigger.webhook.x}}` 输出 `{{trigger.webhook.x}}`                          |
| F11 | manual “restart as new task” 一个 trigger-dependent workflow       | 视为新 root invocation，不继承旧 context；launch preflight 明确拒绝            |
| F12 | schedule 指向 trigger-dependent workflow                          | create/update/run-now/fire 都以 none source 拒绝，不持续制造必失败任务          |
| F13 | custom query/optional param 缺 context                             | request assembly 前通用失败码；fetch 0 calls                                   |
| F14 | 非 webhook task workflow-sync 到 trigger-dependent definition      | root/closure/status CAS 与 scheduler kick 前 `trigger-context-missing`；旧 root/closure 不变 |
| F15 | review comment template 引 trigger                                | task preflight 对账；iterate rerun 时静态字面保留、comments/trigger 分别 fence  |

## 14. 测试策略

### 14.1 Shared parser / context

- 三段合法引用、外层空白、去重、与 local ref 混排、span/render callback；
- nested/empty/control/unclosed 边界与 replacement value 含 token 的单轮非递归锁；
- legacy 两段、flat root、unknown source/field、层数错误、未闭合 trigger token 全部被识别为 invalid；
- local 单段/双段兼容、三段非 trigger local invalid；
- `{{!ref}}` / `{{!!ref}}` 跨 model/webhook/HTTP 三 sink 的字面输出及 sink 后续 encoding/schema gate；
- `TRIGGER_CONTEXT_FIELDS === WEBHOOK_TEMPLATE_VARS` 派生锁，含 `event_json`；
- 完整根 JSON parse、flat storage migration、NULL、损坏 JSON、缺失/非法 event_type；
- workflow surface inventory 同时覆盖 agent/goal/review/preset/custom 七类路径；
- migration helper 幂等。

### 14.2 Webhook template

- 三 launch kinds保存期 + 渲染，含 agent `inputs.*` 与 common `workingBranch`；
- 事件矩阵 unavailable 与 unknown；
- v1 payload 三种 shape 迁移到 v2、旧 literal/`!` 字节保持、损坏行容错、事务版本更新、重复迁移不变；
- frontend chips 在 payload 与 `workingBranch` 插入完整 token 并保持 caret。

### 14.3 Prompt renderer

- agent 值正确替换并带 RFC-200 fence；恶意 closing tag 不越界；
- missing field 空串与 missing context 失败分开；
- preview sample context；framework-composed false 不展开；
- inline clarify 不重复注入，isolated rerun重注入；
- ordinary/fanout shard/aggregator 三条正向行为；workgroup/dynamic/commit/merge 三条 literal negative lock。
- review comment template 默认/自定义、review builtin + trigger 混排、raw/pre-rendered 单次 fence，首次/reject 不消费。

### 14.4 Workgroup / child

- call-workgroup goal 渲染；非 webhook 在 child INSERT 前失败；
- goal 进入 host 后不二次展开；
- parent→child→grandchild `trigger_context_json` 嵌套值一致；
- call-workflow child agent 实际 prompt 读到根事件值。
- 根 + frozen call closure 在首个节点前 missing/unavailable fail；manual new-task restart 不继承；
- JSON、multipart、scheduled create/update/run-now/fire、webhook replay、historical resume/retry、dynamic confirm
  各自最早 preflight，失败时 task lifecycle/status CAS 与外部工作区/模型/脚本/HTTP side-effect spy 均为 0。
- task workflow-sync 先重冻 candidate closure；missing/unavailable/invalid context 在 root/version/closure/status CAS 前失败，
  原 root/closure/status 与 scheduler attach 次数不变；call target 变化的成功例断言新 closure 与新 root 原子对应。

### 14.5 Code-host

- preset、custom path/query/body 的三段 token；
- unknown/legacy 保存期拒绝；
- path/JSON escape 回归；
- preset required/optional 与 custom path/query/body missing context 全发通用码且 fetch stub 0 calls；历史码仍可反序列化；
- webhook dispatcher→initial INSERT→scheduler→HTTP stub E2E。
- Inspector custom query value 可编辑并插入 canonical token；query key 不被当模板。

### 14.6 Workflow / Intent migration

- v4→v5 覆盖七类模板字段，端口同名/双段 dotted local 不误改，旧 literal 自动 escape，幂等；
- workflow CRUD、Intent apply、BundleApply、resource-package/YAML import/export、closure freeze/parse、task snapshot/sync、
  dynamic generated definition 的 migration ingress inventory 锁；
- production workflow construction site 只用 `WORKFLOW_SCHEMA_VERSION` 的源码 ratchet；
- 冻结 v4 task resume 正常；
- Intent 文档包含 canonical token且明确 no synthetic inputs；
- Intent changeset 直接 trigger 通过，旧/未知 ref 进入 repair；
- dynamic orchestrator 有/无 context 两态生成规则；
- 完整 Intent-generated workflow → webhook fire → agent prompt 回归，锁用户报告原始缺陷；
- API/导出不自动暴露原始 trigger context，definition/task inputs 未被合成 30 个根字段；作者显式把 trigger
  渲染进 workflow input/prompt/HTTP 时，值按该既有 sink 的审计与保留语义处理，不把这种显式使用伪称成“零暴露”。
