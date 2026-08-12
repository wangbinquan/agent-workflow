# RFC-292 任务分解 — 统一触发上下文命名空间

> 产品视角见 [`proposal.md`](./proposal.md)，技术设计见 [`design.md`](./design.md)，设计门见
> [`design-gate-2026-08-12.md`](./design-gate-2026-08-12.md)。

## 状态

已完成（2026-08-12）。设计门与实现门均已通过；验证范围、并发机器上的 backend 全量分片例外及逐项归因见
[`implementation-gate-2026-08-12.md`](./implementation-gate-2026-08-12.md)。

## 用户拍板记录（2026-08-12）

| #   | 决策                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------- |
| P1  | Agent prompt、workgroup goal、code-host-call、Webhook launch 模板与 Intent 全部支持同一 trigger 语义 |
| P2  | 唯一规范路径是 `trigger.webhook.<field>`，不是 `trigger.<field>`                                     |
| P3  | 代码平台现有 trigger 逻辑也迁移，不保留一套 code-host 私有正式语法                                   |
| P4  | Trigger 字段不得铺平到 workflow root inputs 或模板根变量集合                                         |
| P5  | Intent 原生生成 namespaced trigger ref，不生成搬运 30 个字段的合成 inputs                            |

## 任务

### T1 — Shared trigger 模型与统一 parser

- 文件：`packages/shared/src/triggerContext.ts`（新增中立权威模块）、`webhookTriggerContext.ts`（source adapter）、
  `templateRef.ts`、`workflowTemplateSurfaces.ts`、`schemas/webhook.ts`、`packages/shared/src/index.ts`；删除旧
  `packages/shared/src/codeHost/triggerContext.ts` 的生产所有权并迁移全部 import。
- 内容：
  - `TriggerContext = {trigger:{webhook:{...}}}`；字段集合直接派生 `WEBHOOK_TEMPLATE_VARS`，纳入
    `event_json`，`event_type` 必填且有类型，删除 code-host 手抄字段子集；
  - schema 与 JSON decoder 由中立模块导出；`webhookTriggerContextOf(event)` 由 source adapter 组合完整根对象；
    code-host 只是消费者，不保留 compatibility 变量表、prefix 或私有 parse 入口；
  - segment scanner + `extractTemplateRefs` / `webhookTriggerRef` / `webhookTriggerToken` / callback renderer，
    保留 span 并支持统一 `{{!ref}}` 字面转义；
  - legacy/unknown/malformed/unclosed trigger ref 不得因 regex 未匹配而漏成字面量；保留 code-host 既有双段
    dotted local port，统一 `{{!body}}`/`{{!!body}}` 字面转义；
  - `parseTriggerContextJson` 返回 none / ok / invalid 三态，支持完整根形态与历史 flat storage decoder，损坏
    JSON fail-closed；
  - `collectWorkflowTemplateSurfaces` / `mapWorkflowTemplateSurfaces` 唯一枚举 agent prompt、workgroup goal、review
    comment injection、code-host preset/custom 全部模板字段，并携带 sink/ref-domain 分类。
  - `collectTriggerDependencies` / `evaluateTriggerDependencies` 只返回结构化 issue，不含 DB/HTTP 副作用，供所有
    backend launch source 由同一编排入口调用。
- 测试：新增 `packages/shared/tests/rfc292-trigger-namespace.test.ts`，覆盖 design §14.1。
- 依赖：无。

### T2 — Workflow schema v5 与迁移

- 文件：`packages/shared/src/schemas/workflow.ts`、`packages/shared/src/workflow-canonical.ts`、
  `packages/backend/src/services/workflow.ts`、scheduler snapshot/closure parse 入口、YAML/bundle/resource-package
  import/export 入口。
- 内容：
  - `WORKFLOW_SCHEMA_VERSION` 4→5；
  - 把 latest migration 收口为 shared pure helper，backend CRUD、closure freezer/parser、scheduler、YAML 共用，
    避免 closure→workflow service import cycle；
  - v4→v5 纯迁移覆盖 agent prompt、call-workgroup goal、code-host params/custom request；
  - v4 task snapshot 与历史 ref closure 内每个 child definition 运行前内存迁移；live closure 冻结前逐层迁移，
    新 task 的 root snapshot/ref closure 一律是 v5；
  - v5 validator 不接受 legacy ref；v4 旧 renderer 原本把 `{{!ref}}` 当字面，因此 migration 加一层 `!` 保持
    输出，不把同名根级 inbound port 猜成 trigger；
  - v4→v5 纯迁移同时覆盖 review `commentInjectTemplate`；
  - workflow GET/start、Intent resolve/apply、BundleApply、resource-package/YAML import/export、closure freeze/parse、
    task snapshot/sync、dynamic generated definition 全部共用 shared latest helper；
  - agent/workgroup host、dynamic generator、fusion、frontend quick-create/starter/autosave/画布临时 definition、validator
    临时 definition 等所有生产构造点改用 `WORKFLOW_SCHEMA_VERSION`，仅 migration/兼容 fixture 保留旧版本；
  - definition boundary ratchet 枚举生产 parse/safeParse/serialize 写点，逐项标为 latest-helper、canonical-only 或
    immutable historical view，防新增 ingress/recovery/export 绕过迁移；
  - sink-aware migration 保留 code-host `{{foo.bar}}` local ref，并把旧 renderer 原本当字面的其它 brace 表达式
    自动 escape；除已披露的 known-trigger 激活与 invalid-trigger fail-closed 外保持可观察输出。
- 测试：`packages/backend/tests/rfc292-workflow-v5-migration.test.ts`，覆盖同名 inbound port 不误改与幂等。
- 依赖：T1。

### T3 — Webhook launch 模板 v2

- 文件：`packages/shared/src/webhookTemplate.ts`、`packages/backend/src/services/webhook/webhookDispatch.ts`、
  `packages/backend/src/services/webhook/triggerValidation.ts`、execution invoker/executor、webhook trigger CRUD/service、
  schema + 当前暂定 migration `0150_rfc292_trigger_namespace.sql`（0149 已由 RFC-291 批①提交；实施前按 live
  journal 重新确认编号）。
- 内容：
  - 三 launch kind 只接受 `trigger.webhook.*`；
  - 唯一 collector 覆盖 workflow text mapping、agent description/`inputs.*`、workgroup goal 和三类
    `workingBranch`；后者渲染后仍过 branch gate；
  - `template_syntax_version` 1→2 迁移，读取/fire 前事务写回；已知 trigger ref 规范化，旧 literal（包括
    `{{!x}}`）自动加一层 escape 保持输出；unknown/malformed trigger-looking ref 不得被 literal 兼容分支掩盖；
  - 新 trigger context 初始 INSERT 写完整 `{trigger:{webhook:{...}}}` 根，从 30-field 闭集投影；`event_type` 必有、
    其它空值键可省略，保持 launch 前原子落库；
  - SQLite JSON1 backfill 合法历史扁平 context，runtime decoder 继续兜底，损坏行保留并 fail-closed；
  - 保持事件矩阵可用集与运行期全量 launch validation，save/fire 对 root + call closure 做字段适用性对账。
- 测试：shared schema、backend management/dispatch、migration 三层；旧 payload 迁移、unknown fail-closed、
  `workingBranch`、`event_json` 32 KiB、NULL/缺 event_type/损坏 context 区分。
- 依赖：T1。
- 并发：RFC-284 后续批可能继续改 webhook service 边界；动手前重读 live plan/status，按最新 service 落点接线。

### T4 — Prompt renderer + workflow validator

- 文件：`packages/shared/src/prompt.ts`、`packages/backend/src/services/runner.ts`、
  `packages/backend/src/services/workflow.validator.ts`、`packages/shared/src/signalPromptGuard.ts`。
- 内容：
  - `RenderPromptInput` / `RunNodeOptions` 加严格两态 `TriggerContext | null`；preview 另传显式 sample context，
    不发明 undefined-preserve-token 运行语义；
  - trigger 值按字段走 `fenceUntrusted`；inline same-session clarify 不重注，fresh/isolated rerun 重注；
  - 兑现既有 `review.commentInjectTemplate`：只允许 review builtin + trigger，静态作者文本保留，comments/trigger
    分别 fence，以 raw/pre-rendered ADT 防双围栏；仅 iterate 消费，首次/reject 保持既有语义；
  - validator 把 trigger 从 inbound port 域分离，并拒绝所有 invalid dotted ref；signal guard 复用 shared parser，
    只检查 local port 且修复 whitespace 语义漂移；
  - 新增通用 `trigger-context-missing` / `trigger-context-invalid` / `trigger-field-unavailable` failure code；旧
    code-host 专有码仅历史读取，生产路径不再发射。
- 测试：shared renderer（含恶意 closing tag）、validator、runner pre-spawn failure。
- 依赖：T1、T2。

### T5 — Scheduler 全 dispatch + call tree

- 文件：`packages/backend/src/services/scheduler.ts`、`task.ts`、`lifecycle.ts`、`scheduledTasks.ts`、
  `scheduleLaunch.ts`、`agentLaunch.ts`、`workgroup/launch.ts`、execution closure/child launch deps、
  新增 `packages/backend/src/services/execution/triggerPreflight.ts`、`packages/backend/src/routes/tasks.ts`、
  `routes/scheduledTasks.ts`、shared workflow-sync preview schema。
- 内容：
  - task context parse once → `SchedulerState.triggerContext`；
  - shared pure dependency evaluator + backend 唯一 `triggerPreflight` 编排入口；schedule/webhook/task/sync 不得各写
    missing/event-matrix 判据；
  - 抽出 shared launch preparation，在手动 JSON/multipart/relaunch、scheduled create/update/run-now/fire、webhook
    save/fire/replay、root/child start、task workflow-sync、historical resume/retry 与 dynamic confirm 的最早可判定点扫描 root + frozen
    call-workflow closure；公开 launch 在 repo/upload materialize、task INSERT 与首个节点副作用前失败；
  - workflow-sync 按 candidate v5 root 重冻 call closure，以 task row context preflight，再把 root/version/closure/status
    同一 ownership CAS 写入；preview 用同一 preparation 返回 blocking trigger issue，POST 权威重做；失败保持旧
    root/closure/status，不复用与新 root 不匹配的旧 closure；
  - ordinary agent、fanout shard、aggregator 三类作者模板传 context 且展开；workgroup/dynamic host、commit-message、
    merge-conflict 三类框架 prompt 显式 `expandPromptTemplate:false`，即使内容含 canonical token 也不展开；
  - `renderCallGoal` 改共享 parser，缺 context 在 child INSERT 前失败；
  - `buildChildDeps` 原子继承 context，覆盖 workflow/workgroup/孙任务；
  - production `triggerContext:` producer allowlist 只允许 webhook normalized-event projector 与 child inheritance；
    route/schedule/resume/sync 新增写点由源码 ratchet 拒绝；
  - retry/resume 使用冻结 task 值，不重读 webhook delivery；“restart as new task”是新 root，不暗中继承旧 context。
- 测试：`packages/backend/tests/rfc292-trigger-scheduler.test.ts` + child propagation 集成；三处生产
  正向 dispatch、三类 framework prompt 负向 literal lock、全部生产 `runNode` 调用 inventory。
- 依赖：T4。

### T6 — Code-host 私有 trigger 逻辑收口

- 文件：`packages/shared/src/codeHost/template.ts`、`packages/backend/src/services/codeHost/call.ts`、
  `packages/backend/src/services/workflow.validator.ts`、CodeHostCall Inspector（含 custom query value editor）。
- 内容：
  - 删除私有 `trigger.` grammar/变量表，复用 T1 parser/context；
  - preset required/optional + custom path/query/body 全三段化，并在 request assembly/fetch 前一次 preflight
    全部 trigger refs；
  - 对 final encoded path、每个最终 assembled param/query value（含 transform 后）、preset/custom serialized JSON
    body 重跑既有上限；超限 fail-closed、不截断、不回显值；
  - 保持位置编码、安全 body、redirect、retry、redaction；
  - 新执行产通用错误码，旧专有码只读；任一使用面缺/坏/unavailable 时 fetch stub 必须 0 calls。
- 测试：改造 RFC-269 shared/backend/frontend tests；添加旧两段 ref 拒绝、新三段 exact request、preset
  optional/custom query/body 无旁路断言，以及重复 `event_json` 造成 post-render 超限时 fetch 0 calls。
- 依赖：T1、T4、T5。

### T7 — Intent Builder 与动态工作流生成契约

- 文件：`packages/backend/src/services/intent/intentDoc.ts`、changeset validation/resolve、
  `packages/shared/src/dynamicWorkflow.ts`、`packages/backend/src/services/orchestratorAgent.ts`、Intent contract tests。
- 内容：
  - 教授 workflow schema v5、canonical trigger、30 字段、no synthetic inputs；
  - agent prompt / call-workgroup goal / review comment injection / code-host params 都可直接生成；
  - legacy/unknown ref 进入 repair feedback，canonical ref 正常 confirm/apply；
  - Intent preview/changeset scan 由统一 template-surface inventory 驱动，不再只看 agent prompt；
  - trigger vocabulary 进入公共 workflow 文档段，不受 `code-host-calls:author` 权限分支影响；
  - dynamic orchestrator prompt 明示当前 task 有无 webhook context、event type 与可用字段名，但不注入实际 trigger
    值；无 context 禁止生成 ref，有 context仍过共同 validator + closure preflight；
  - immutable historical draft 不改 hash。
- 测试：`intent-doc-validator-contract.test.ts`、`rfc234-resolve-bundle.test.ts` 与一条
  Intent-generated workflow→webhook E2E；动态生成有/无 context 两态。
- 依赖：T2、T4、T6。
- 并发：RFC-291 批①已进入 `main`，后续批仍可能修改 Intent dump/resolve 邻域；实施前重读其终态，按符号接线并
  保留 auto-mount/manifest 事务语义，不覆盖或 broad-stage 共享改动。

### T8 — Frontend authoring 面

- 文件：`TemplateVarChips.tsx` 的既有 helper/callers、`TriggersPanel.tsx`、CodeHostCall Inspector、
  Agent/CallWorkgroup/Review inspector、`promptRefs.tsx`、agent/goal preview、IntentOpPreview、双语 i18n。
- 内容：所有 chips 插入完整 `{{trigger.webhook.field}}` 并纳入 `event_json`；agent/workgroup inspector 复用同一
  分组；Review comment injection 同组展示 trigger chips + 唯一 review builtin；Webhook 三类 `workingBranch` 和
  CodeHost custom query value 都是可聚焦插入目标；missing-ref diagnostic
  用 shared parser 区分 local/trigger/invalid；agent prompt 与 call-workgroup goal preview 用确定性 sample
  context，review preview 另加 deterministic sample comments + 同一 context；三者都可显式预览 none-context 失败，
  不以保留 token 充当运行结果；Intent preview 覆盖全部模板面。
- 测试：webhook insert caret、code-host inspector、agent/workgroup inspector、missing/invalid diagnostic、
  deterministic preview/a11y。
- 依赖：T1、T4、T6。
- 并发：当前 frontend 有 RFC-290/其它 session WIP，实施时按确切文件/hunk 保留并发改动，不 broad-stage。

### T9 — 文档、supersession 与端到端门禁

- 文件：`docs/webhook-triggers.md`、`docs/code-host-calls.md`、`docs/workflow-yaml.md`、`docs/dev-gotchas.md`、
  RFC-257/RFC-269 supersession 注记、相关源码注释。
- 内容：旧示例全部 canonical；RFC-269 Q10/D16 及“agent 保留字面量”源码锁由 RFC-292 正向能力锁取代；
  scoped ratchet 只扫描登记的 workflow/webhook 模板生产器与帮助面，不误伤 i18next `{{provider}}`/`{{branch}}`
  等其它插值语言；production import ratchet 禁止旧 `shared/codeHost/triggerContext` 路径复生。
- E2E：
  1. webhook→nested INSERT→ordinary agent prompt；
  2. webhook→parent→child agent/workgroup；
  3. webhook→code-host HTTP stub；
  4. Intent 生成 workflow→webhook→agent prompt，复现并锁住原始问题；
  5. 断言 workflow definition/inputs 未新增 30 个根字段，task API/resource export/runtime env 未自动扩散原始
     trigger context；显式渲染到既有 sink 的值按该 sink 契约断言；
  6. webhook/schedule save+fire、public start、workflow-sync、resume/retry、dynamic confirm 各 preflight 点无 task
     snapshot/lifecycle CAS、scheduler attach、首节点、模型、脚本或 HTTP 副作用；
  7. review iterate rerun 中 comment template + trigger 正确单次围栏，首次/reject 不注入。
- 验证：精确测试 → 三包 typecheck/lint/format/depcheck → `bun run gate:local` → Codex 实现门。
- 依赖：T1–T8。

## 建议实施提交

本 RFC 跨 shared/backend/frontend 与数据迁移，按依赖拆为三个连续、可独立验证的主干提交：

1. **提交 ①（模型 + migration）**：T1 + T2 + T3；
2. **提交 ②（运行时全链）**：T4 + T5 + T6；
3. **提交 ③（Intent + UI + docs + E2E）**：T7 + T8 + T9。

不允许先把 code-host 改成三段、随后再补 agent；提交 ① 尚未落齐迁移时不得让任何生产入口写 v2/v5 数据。

## 验收清单

- [x] AC-1～AC-3：唯一命名空间与闭集 parser
- [x] AC-4～AC-6：Webhook launch 模板 v2
- [x] AC-7/7a～AC-11/11a：agent/workgroup/review/child 全链
- [x] AC-12/12a～AC-13：Code-host 收口
- [x] AC-14～AC-15：Intent 原生生成
- [x] AC-16～AC-18：嵌套持久化与历史迁移
- [x] AC-19～AC-20：真实 webhook 全链 E2E + 完整门禁（backend 分片机器争用例外已逐项归因）
- [x] AC-21：唯一 workflow template-surface inventory
- [x] AC-22：六类生产 prompt 展开边界
- [x] AC-23：preview / missing-ref / signal guard 同一 parser
- [x] AC-24：task API、资源导出与 runtime 配置无 trigger context 扩散
- [x] `design/plan.md` / `STATE.md` 更新 Done

## 登记不做

| #   | 项                                        | 理由                                                                  |
| --- | ----------------------------------------- | --------------------------------------------------------------------- |
| N1  | `trigger.schedule.*` / `trigger.manual.*` | 本 RFC 只建立层级与 webhook source；其它来源需要各自字段/生命周期设计 |
| N2  | 任意 JSONPath / 深层 webhook raw 查询     | 破坏闭集与可用集校验；标准字段 + 截断 event_json 已覆盖现有需求       |
| N3  | Trigger 值进入 agent env                  | 会扩大凭据/外部数据传播面，且模板渲染已满足目标                       |
| N4  | 保存期绑定某一 webhook trigger            | trigger 是独立资源，可后建/删除；保存期绑定会制造假红                 |
| N5  | 改写历史 `node_runs.prompt_text`          | 审计事实必须保持当时真实发出的 prompt                                 |
