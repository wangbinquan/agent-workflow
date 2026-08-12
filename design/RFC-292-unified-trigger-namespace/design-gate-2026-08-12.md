# RFC-292 设计门（2026-08-12）

## 结论

**初版不通过（FAIL）；修订后通过（PASS），待用户显式批准后进入实现。**

本轮不是只检查最初的 agent prompt 症状，而是从生产源码反向枚举 trigger 的定义、存储、生成、校验、渲染、
传播、恢复、同步、预览和迁移边界。初版共发现 27 个会导致“某一路仍有私有语法 / 私有上下文 / 私有失败语义”
的缺口；全部已经折入 [`proposal.md`](./proposal.md)、[`design.md`](./design.md) 与
[`plan.md`](./plan.md)。修订版形成一份可执行的全链契约，当前没有遗留方向题。

本次采用当前 Codex 会话的**单路、源码取证式对抗复核**，没有把同一会话包装成“双路独立评审”。初始生产源码
pin 为 `a4854d1d5c3f0d7113165b37fb9a0fddb19139ac`；门禁收尾时共享 `main` 前进到
`ac5ba6d9cc9b7444232b5971bebcc07fab9f9911`（RFC-291 批①）。已对两个 pin 做增量复核：新提交只修改 Intent
auto-mount/handle watermark 链与 migration 0149，没有改变本文列出的 trigger parser/context/template/IntentDoc/
workflow-schema 事实；最终结论以 `ac5ba6d9` 为当前 pin。收尾时仍未提交的 RFC-291 后续 Intent WIP
（`dumpBuilder.ts` / `intentDoc.ts` / `turnEngine.ts`）也已只读检查 diff：改动是 unavailable-mount/提示链，未触及
trigger vocabulary 或 workflow schema 段；它们排除在本门范围之外并保持不动。本门只修改 RFC-292 文档与 RFC
索引/状态文字，**尚未修改任何生产代码**。

## 修订后唯一契约

| 维度 | 唯一规则 |
| --- | --- |
| 作者语法 | Webhook 字段只写 `{{trigger.webhook.<field>}}`；不保留根级 `{{field}}` 或正式的 `{{trigger.<field>}}` |
| 任务快照 | `tasks.trigger_context_json` 为 `{trigger:{webhook:{event_type,...}}}`；NULL 只表示没有 source |
| 字段集合 | 30 项全部派生自 `WEBHOOK_TEMPLATE_VARS`，包含 32 KiB 截断的 `event_json`；`event_type` 必填 |
| 词法 | shared segment scanner 统一识别 local / trigger / invalid / literal-ref，并保留 span；各层不再私写 regex |
| Workflow 模板面 | agent prompt、call-workgroup goal、review comment injection、code-host preset/custom 全部由一个 inventory 枚举 |
| Webhook payload 面 | workflow mapping、agent description/inputs、workgroup goal、三类 `workingBranch` 由另一个同源 inventory 枚举 |
| 模型注入 | Agent/review replacement 分别 fence；workgroup 的完整 goal 由 host fence 一次；框架已组合 prompt 不展开 |
| 子任务 | workflow/workgroup/孙任务只继承父 task 的冻结 context，并与 child row 初始 INSERT 原子落库 |
| 启动对账 | root + 冻结 call closure 在各来源最早副作用前统一检查 source、context 结构与 event/field 可用性 |
| Code-host | preset required/optional 与 custom path/query/body 共用 parser/context/preflight；HTTP 位置编码规则不变 |
| Intent | 公共 workflow vocabulary 原生教授 canonical ref，不受 code-host author 权限控制，不生成 30 个合成 inputs |
| 动态生成 | 只给生成器 source presence、event type 和可用字段名，不给实际 comment/`event_json` 值 |
| 迁移 | workflow v4→v5、webhook payload v1→v2、扁平 task context 与冻结 root/closure 都有版本化、幂等迁移 |
| 非模板字段 | provider/action、limits、agent body、script/env、MCP/runtime、repo source/ref 等保持字面，不扩大插值面 |
| 暴露边界 | context 不自动进入公开启动参数、task API、资源导出或 runtime env/config；显式 sink 继续按该 sink 保留/审计 |

## 源码锚点复核

| 当前锚点 | 核实结果 |
| --- | --- |
| `packages/shared/src/webhookTemplate.ts:45-60,125-129` | Webhook renderer 只认扁平 `[a-z_]+`，并接收根级 vars map |
| `packages/shared/src/codeHost/template.ts:15-53,90-113` | Code-host 私有 `trigger.` 前缀、私有一层 dotted regex 与私有 context 形状 |
| `packages/shared/src/codeHost/triggerContext.ts:17-54` | 独立排除 `event_json`，只投影 29 项，快照是松散 `Record<string,string>` |
| `packages/shared/src/prompt.ts:254-378,380-385,520-524` | Prompt input 无 TriggerContext；运行 renderer 只认 `\w+` |
| `packages/backend/src/services/workflow.validator.ts:3093-3132` | Agent/workgroup 校验走独立 ref collector，并把引用域等同于 builtin/inbound port |
| `packages/shared/src/signalPromptGuard.ts:18-66` | Signal guard 另有不容空白的私有 regex |
| `packages/frontend/src/components/canvas/inspector/promptRefs.tsx:19-34` | Frontend missing-ref 又复制一份 `\w+` regex |
| `packages/backend/src/services/webhook/webhookDispatch.ts:230-327` | description/inputs/goal 会渲染；三类 `workingBranch` 直接透传模板字面量 |
| `packages/backend/src/services/webhook/webhookDispatch.ts:607-622` | Webhook context 已在 launch 前产生并进入 invoker；必须保持 initial INSERT 边界 |
| `packages/backend/src/services/task.ts:2255-2256` | `StartTaskDeps.triggerContext` 当前与 task row 同一次 INSERT 持久化 |
| `packages/backend/src/services/scheduler.ts:3710-3765` | `buildChildDeps` 没有转发 trigger context，child call tree 会丢 source |
| `packages/backend/src/services/scheduler.ts:3906-3942` | `renderCallGoal` 是另一份私有 `\w+` renderer，只读取 builtin/local inputs |
| `packages/backend/src/services/scheduler.ts:1010,1957,2868,5914,7771,8201` | 六个生产 `runNode` 调用分属三类作者模板与三类框架 prompt，不能统一成无条件展开 |
| `packages/backend/src/services/scheduler.ts:4228-4240` | 只有 code-host 节点私自解析 task JSON；损坏 JSON 被降级为 null |
| `packages/backend/src/services/codeHost/call.ts:262-271,345-396` | required preset 才识别 missing source；optional/custom path/query/body 可空值继续组装请求 |
| `packages/shared/src/schemas/workflow.ts:921-947` | 上限只约束模板源码；替换后 path/param/query/body 可能膨胀越界 |
| `packages/frontend/src/components/canvas/inspector/CodeHostCallEdit.tsx:189-237` | Custom UI 只枚举 path/body，schema/runtime 已有的 query 没有作者入口 |
| `packages/backend/src/services/intent/intentDoc.ts:173-190,372` | Trigger 只在 code-host 权限分支教授，仍写 `{{trigger.<var>}}` 和 workflow schema v4 |
| `packages/shared/src/dynamicWorkflow.ts:273-275` | 第二个 workflow 生成面仍硬编码 v4，且没有 trigger source 规则 |
| `packages/shared/src/schemas/review.ts:117-123` + backend 全域反查 | `commentInjectTemplate` 已公开入 schema/UI，但 runtime 没有任何生产读取 |
| `packages/backend/src/services/task.ts:3161-3296` | workflow-sync 只换 root snapshot/version；既不 preflight task context，也不换 matching `refClosureJson` |
| `packages/backend/src/services/execution/closure.ts:238-330` | closure 冻结直接消费 child definition；v5 migration 必须进入每层 parse/freeze 边界 |
| `packages/backend/src/services/workflow.ts:1050-1069` | latest migration 仍是 backend-only v1→v4 helper，不能被 shared/import/closure 全链共用 |
| 全仓 `$schema_version: 1/4` 反查 | agent/workgroup host、dynamic、fusion、validator、workflow quick-create/canvas 与 frontend 构造器都可能继续生产旧版本 |

这些锚点支持的不是“未来可能发生”的猜测，而是当前即可定位的分叉。实施时行号若因并行提交漂移，以表中的符号和
行为为准，并重新 pin live tree。

## Findings 与处置

### A. 命名空间、字段与 parser

#### F1（P1）— 只改 token、未改持久化根，会继续存在半截 TriggerContext

初版容易把 renderer 的入参误写成 `{webhook:{...}}` 或扁平 map；这样 scheduler、code-host 与 child deps 仍可各持
不同形状。**处置**：类型从对象根固定为 `{trigger:{webhook:WebhookTriggerFields}}`；外部 StartTask wire 不开放该
字段，只有可信 webhook invoker 创建根、child 继承。

#### F2（P1）— `event_type` 与 `event_json` 没有全量进入同一字段契约

没有必需 `event_type` 就无法判断 `comment_text` 对 push 是否结构可用；沿用 29 项 code-host 投影又会让“全部字段”
名不副实。**处置**：30 项同源；`event_type` 必填并严格校验，`event_json` 沿用 32 KiB 截断，其余缺键渲染空串。

#### F3（P1）— 放宽 regex 仍会让 malformed trigger 逃成字面量

`trigger..x`、未知 source/field、未闭合 trigger token 若只靠成功匹配 regex，会绕过 validator。**处置**：改为
segment scanner，显式产出 invalid segment、source span 与错误原因；trigger-looking 错误一律 fail-closed。

#### F4（P2）— literal escape 与非递归语义未统一会造成二次解释

各 sink 若各自发明 escape，迁移后的代码示例和 replacement 中自带 token 都可能被再次展开。**处置**：全域唯一
`{{!body}}`，`{{!!x}} → {{!x}}`；左到右单轮渲染，replacement 永不二次扫描。

#### F5（P1）— 迁移若全局 replace 会污染合法 root input 和 code-host dotted local port

Workflow 中 `{{mr_iid}}` 可能真是 inbound port；code-host 的 `{{foo.bar}}` 是既有 local 能力。**处置**：migration
按 sink 旧 grammar 分类，只激活已知 trigger ref；根 inbound 不猜、双段 dotted local 保留，其它旧字面 brace 自动
escape，unknown/malformed trigger 不得被 escape 隐藏。

### B. Webhook payload、agent 注入与任务生命周期

#### F6（P1）— 三类 `workingBranch` 是已声明字段，但当前不渲染

只改 description/inputs/goal 会留下同一 launch payload 内部差异。**处置**：Webhook payload inventory 同时覆盖
workflow/agent/workgroup 的 `workingBranch`；渲染后仍过完整 Start* schema 与 branch gate。

#### F7（P1）— Scheduler 六个 `runNode` 家族不能无差别展开

普通 agent、fanout shard、aggregator 是作者模板；workgroup/dynamic host、commit-message、merge-conflict 是框架已组合
prompt。后三个框架调用家族中的 diff/评论字面 token 若二次展开会泄漏 context 或删除用户文本。**处置**：前三类
正向传 context；后三类家族显式 `expandPromptTemplate:false`，并用调用点 inventory 锁新增 dispatch。

#### F8（P1）— Child launch 丢 trigger，父子语义不统一

`buildChildDeps` 当前不转发 context。**处置**：parent→workflow/workgroup child→grandchild 继承同一冻结对象，并把
context 与 child linkage 一起写入初始 INSERT；不得 launch 后 UPDATE。

#### F9（P1）— 只在最终 renderer 检查会产生半任务副作用

根前置节点可能已经跑完，trigger-dependent 子 workflow 才失败。**处置**：扫描 candidate root + 完整 frozen
call-workflow closure，在 task INSERT、首节点及 repo/upload materialize 前完成 source/field/event preflight。

#### F10（P1）— 启动来源的“有/无/继承”若不穷举，必留旁路

**处置**：明确 manual JSON/multipart/relaunch、schedule create/update/run-now/fire 为 none；webhook save 用 eventTypes
彩排、delivery/replay 用实际 event；root/child 只读内部 deps；resume/retry/workflow-sync/dynamic confirm 只重新解码 task
row。调用这些操作时新传的 deps context 一律忽略。

#### F11（P1）— Multipart 与 schedule 会在公共 `startTask` 防线之前产生副作用

Multipart 可先 materialize repo/upload；schedule 若保存时不拒绝，会永久制造必失败任务。**处置**：抽 shared launch
preparation 并前移到 materialize 前；schedule create/update/run-now/fire 使用同一 none-source 判据，`startTask` 再做
defense-in-depth。

#### F12（P1）— workflow-sync 可绕过新建任务 preflight，且 root/closure 会失配

当前 sync 换 root/version 后立即 resume，却保留旧 `refClosureJson`。**处置**：candidate definition 先迁 v5、重新冻结
matching closure，再以 task row context 对 root+closure preflight；root/version/closure/status 在同一 ownership CAS 换入。
Preview 走同一 candidate preparation，POST 再做权威 TOCTOU 复核；失败保持旧四项且 scheduler attach 为 0。

### C. Code-host 全面收口

#### F13（P1）— Required preset 与 optional/custom 的 missing 语义不同

当前只有 required loop 把 `triggerMissing` 转成错误；optional/query/body 会把空串继续发 HTTP。**处置**：先扫描并
preflight preset required/optional + custom path/query/body 的全部 trigger refs，任一 missing/invalid/unavailable 都在
request assembly/fetch 前发通用码，fetch 0 calls。

#### F14（P1）— 只限制模板源码，替换后的请求可越界

一个 32 KiB `event_json` 可多次替换，把 path、单个 param/query 或 JSON body 扩到既有上限之外。**处置**：在 fetch 前
复查 final relative path ≤ `CODE_HOST_PATH_MAX`、每个 rendered param/query ≤ `CODE_HOST_PARAM_MAX`、最终序列化 body ≤
`CODE_HOST_BODY_MAX`；不截断、不回显值。

#### F15（P2）— Code-host 私有 grammar/字段集/错误码会继续成为第二事实源

**处置**：删除生产 `CODE_HOST_TRIGGER_PREFIX`、29 项投影与私有 parser；只消费 shared TriggerContext/ref parser。
旧 `code-host-trigger-context-missing` 仅为历史 node run 反序列化保留，新运行只产通用 trigger failure code。

#### F16（P2）— Runtime/schema 支持 custom query，Inspector 却没有完整作者入口

“后端全支持”但 UI 无法编辑/插入仍是产品差异。**处置**：CodeHost Inspector 补 custom query value 编辑和 canonical
chips；query key 是结构字段，保持不可插值。

### D. Intent、动态生成、review 与 frontend

#### F17（P1）— Intent 的 trigger vocabulary 被错误绑在 code-host author 权限分支

无 code-host 权限的用户仍可合法创建 webhook-aware agent/workgroup workflow。**处置**：30 字段和 canonical 语法移到
公共 workflow 章节；code-host 权限只控制该节点 form，不控制 trigger 能力。Intent 禁止为直取字段创建合成 inputs。

#### F18（P1）— 动态 orchestrator 是第二个生成面，仍可产 v4 或无 source 的 ref

**处置**：动态生成使用 `WORKFLOW_SCHEMA_VERSION`；有 context 时只告诉模型 event type/可用字段名，无 context 时禁止
生成 trigger ref，实际外部值永不进入 orchestrator prompt；输出仍走共同 validator/preflight。

#### F19（P1）— `review.commentInjectTemplate` 是公开死配置

只把常见 agent/workgroup/code-host 纳入 inventory 会永久漏掉 review。**处置**：使该模板真正参与 iterate rerun；域只
允许 `__review_comments__` + canonical trigger。静态作者文字保留，comments/trigger 分别 fence，并用 raw/pre-rendered
ADT 防双围栏；首次/reject 不消费，reject 保持 `__review_rejection__`。

#### F20（P2）— UI diagnostics、signal guard 与 preview 会继续各自漂移

**处置**：frontend missing-ref、signal guard、validator 与 preview 共用 shared parser。Agent/goal/review 三种 preview
显式传确定 sample context，并可切 none-context 查看 blocking error；不用“undefined 保留 token”伪造运行语义。

### E. Schema、迁移、恢复与边界 ratchet

#### F21（P1）— 只迁 root workflow 会让冻结 child closure 继续是 v4

`freezeCallClosure` 会逐层读取 child definition；历史 task 又含 root snapshot + closure 两份冻结图。**处置**：shared pure
latest helper 在 root、每个 live closure child、历史 root/closure 内存 parse 全部运行；新冻结对象只存 v5，历史审计原文
不改。

#### F22（P1）— 生产构造器硬编码 v1/v4 会不断制造“刚创建就要迁”的定义

**处置**：agent/workgroup host、dynamic、fusion、validator 临时定义、Intent 文档与 frontend quick-create/starter/
autosave/canvas 临时定义全部引用 `WORKFLOW_SCHEMA_VERSION`；源码 ratchet 只允许 migration/兼容 fixture 写旧版本。

#### F23（P1）— 只改 workflow CRUD 会漏 Intent、bundle、resource package、YAML 与 recovery ingress

**处置**：definition boundary inventory 覆盖 workflow GET/PUT/start、Intent resolve/apply、BundleApply、resource-package/
YAML import/export、closure freeze/parse、task snapshot/sync、dynamic generated definition 和历史只读 view；每个 parse/
serialize 点必须归类为 latest-helper、canonical-only 或 immutable historical。

#### F24（P1）— 损坏 JSON 降级成 none 会误报 missing 并掩盖数据损坏

**处置**：decoder 返回 none/ok/invalid 三态。NULL 才是 none；flat 且含合法 `event_type` 可迁移；缺 discriminator、
unknown key 或损坏 JSON 都是 invalid。Scheduler 每 task parse once，其余消费者只接 typed value。

#### F25（P2）— Migration 0149 已被 RFC-291 占用并提交

**处置**：RFC-292 当前暂定 `0150_rfc292_trigger_namespace.sql`，不触碰已提交的 0149；实施前以 live
`_journal.json` 重新取得下一号，若其它 migration 已先落则继续后移。

#### F26（P2）— 全仓裸 grep 会误伤别的插值语言，“零暴露”表述也不准确

**处置**：旧 token ratchet 只扫描登记的 workflow/webhook 模板生产器、帮助面和现行文档，不误伤 i18next
`{{provider}}`/`{{branch}}`。Trigger context 不**自动**扩散到 API/export/env；作者显式渲染到 input/prompt/HTTP 的值
继续按该 sink 的审计与保留契约处理，不宣称显式值永远不可见。

#### F27（P2）— 权威 TriggerContext 若仍放在 `shared/codeHost/`，模块所有权仍是第二套

把字段扩成 30 项、shape 改成三层，但继续让 `codeHost/triggerContext.ts` 定义平台根类型，会让 agent/Intent/webhook
反向依赖 code-host 子域，并给后续维护者错误信号：code-host 仍是 trigger 的 owner。**处置**：新建中立
`packages/shared/src/triggerContext.ts` 承载类型/schema/decoder，`packages/shared/src/webhookTriggerContext.ts` 承载
Webhook source adapter；删除旧 code-host 模块的生产所有权并迁移全部 import。中立符号从 shared index 导出，
code-host 只消费，不提供 compatibility 字段表或 parser。

## 门后实施要求

- 只有用户明确批准这份修订契约后，才允许从 T1 开始修改生产代码。
- 实现必须按 T1→T9 的依赖推进；不允许先只改 code-host 或只改 prompt，制造过渡期第四套语义。
- 每个 surface inventory、launch source matrix、`runNode` family、definition boundary 都必须有枚举型 ratchet；仅靠 happy
  path E2E 不算“全部统一”。
- 实现完成后再跑 Codex 实现门、精确测试、三包 quality gates 与 `bun run gate:local`；本次文档门不冒充实现验证。
- 实施前重新 pin live tree、重读 RFC-291/RFC-284 等并行状态，并重新分配 migration 序号。

## 最终判定

修订版已经把 Intent、动态生成、Webhook 三类 launch、agent/fanout/aggregator、workgroup/child、review、code-host、
手动/计划/回放/恢复/sync 与 UI/迁移都纳入同一 TriggerContext 和 parser 契约；同时明确了不应插值的框架 prompt 与
结构字段边界。**设计门 PASS；状态仍是待用户逐项接受 proposal §6 能力影响并批准，生产实现为 0。**
