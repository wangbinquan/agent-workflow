# RFC-292 — 统一触发上下文命名空间

> 产品视角。技术设计见 [`design.md`](./design.md)，任务分解见 [`plan.md`](./plan.md)，设计门见
> [`design-gate-2026-08-12.md`](./design-gate-2026-08-12.md)。

## 1. 背景

用户在一个由 Intent Builder 创建、再由 webhook 启动的工作流里，把
`{{trigger.comment_text}}` 写进了 agent 的 `promptTemplate`。任务启动时 webhook 上下文已经正确写入
`tasks.trigger_context_json`，但 agent 收到的仍是字面量 `{{trigger.comment_text}}`。

继续追查发现这不是一个孤立的漏替换，而是平台同时存在三套互不一致的触发变量规则：

| 使用面                                                                       | 当前语法                         | 当前行为                                                   |
| ---------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------- |
| Webhook 触发器的 workflow input mapping / agent description / workgroup goal | `{{mr_iid}}`、`{{comment_text}}` | 变量直接铺在模板根命名空间                                 |
| `code-host-call` 参数                                                        | `{{trigger.mr_iid}}`             | 只有该节点解析                                             |
| agent `promptTemplate` / `call-workgroup.goalTemplate`                       | 无                               | 带点的引用不被 prompt 正则识别，原样进入模型或子工作组目标 |

对应源码事实：

- `packages/shared/src/webhookTemplate.ts` 的变量正则只认扁平 `[a-z_]+`；
- `packages/shared/src/codeHost/template.ts` 私有定义 `trigger.` 前缀与一层字段；
- `packages/shared/src/prompt.ts` 与 `workflow.validator.ts` 只认 `\w+`，不认任何命名空间；
- RFC-269 Q10 / D16 还明确要求 trigger 只对 `code-host-call` 可见；
- `trigger_context_json` 当前直接保存 webhook 字段字典，没有 `trigger.webhook` 两层结构。

这导致两个产品问题：

1. **同一个 webhook 字段因使用面不同而有两种写法，Intent 与人都容易写错。**
2. **Webhook 的 30 个字段污染模板根变量集合。** 将来再增加 schedule、manual、message 等触发来源时，
   字段会继续堆在根上，并产生 `branch`、`author_id` 之类的名字碰撞。

用户 2026-08-12 明确拍板：代码平台调用逻辑也一起改，trigger 全系统统一；不能把 trigger 参数铺平到
workflow 根 inputs 或模板根变量集合。

## 2. 统一后的产品契约

唯一规范语法：

```text
{{trigger.webhook.mr_iid}}
{{trigger.webhook.comment_text}}
{{trigger.webhook.event_json}}
```

三段含义固定：

1. `trigger`：平台级触发上下文根命名空间；
2. `webhook`：触发来源；
3. `<field>`：该来源的字段，字段集合来自 webhook 变量表的单一事实源。

`trigger` 不是 workflow input，也不会生成 30 个同名 input。工作流声明的 `inputs[]` 继续只表示作者显式
设计的业务输入；触发上下文是任务启动事实，独立保存在任务快照中。

运行期与持久化也遵守同一个形状，而不是只把模板字符串改个名字：

```json
{
  "trigger": {
    "webhook": {
      "mr_iid": "42",
      "comment_text": "please fix"
    }
  }
}
```

`event_type` 是每份 webhook context 的必需 discriminator；其它实际为空的字段可以省略并按空串渲染。
因此 NULL 精确表示“没有 trigger source”，合法的 webhook context 不能是没有 `event_type` 的空壳。

模板里的其它两类引用不改语义：`{{port_name}}` 仍是当前节点的显式 inbound port，
`{{__task_id__}}` 等仍是平台 builtin。它们不是 webhook 字段；只有触发数据必须进入
`trigger.webhook`，因此不会与业务 input 或 builtin 撞名。

### 2.1 全量模板面清单

“全部支持”以**所有现有、明确声明为模板的字符串面**为边界。任何一处解析 `{{...}}`，都必须使用同一
parser、同一 TriggerContext 和同一 trigger 字段表：

| 资源/节点                     | 纳入统一 trigger 的字段                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| Webhook → workflow            | text input mapping、`workingBranch`                                                              |
| Webhook → agent               | `description`、声明端口的 `inputs.*`、`workingBranch`                                            |
| Webhook → workgroup           | `goal`、`workingBranch`                                                                          |
| `agent-single`                | `promptTemplate`（普通、fanout shard、aggregator 三条 dispatch）                                  |
| `call-workgroup`              | `goalTemplate`                                                                                   |
| `review`                      | `commentInjectTemplate`（评审 iterate rerun 的作者模板）                                         |
| `code-host-call` preset       | 全部 `params.*`                                                                                  |
| `code-host-call` custom       | `request.path`、`request.query.*`、`request.body`                                                 |
| 动态工作流生成器              | 生成出的 agent `promptTemplate`，仅当当前 task 确有 webhook context                              |

结构字段和非模板载体仍保持字面语义：provider/action、布尔/数字 limits、agent `bodyMd`、script body/secret
env、MCP/runtime config、repo source/ref 等不会因为“统一 trigger”而偷偷开始插值。这样“统一”指同一数据在
所有模板面只有一种路径，而不是把任意字符串都变成可执行模板。

## 3. 目标

- **G1 — 唯一语法**：Webhook launch 模板、agent prompt、`call-workgroup` 目标、`code-host-call` 参数、
  Intent 生成与 UI 插入全部使用 `{{trigger.webhook.<field>}}`。
- **G2 — 全面可用**：Webhook 触发的任务中，agent 节点、fanout shard、aggregator、工作组调用目标、
  review 驱动的 agent rerun、子工作流以及代码平台调用节点都能读取同一份触发快照。
- **G3 — 不污染 inputs**：使用 trigger 字段不要求、也不自动创建 workflow root input / input node / edge /
  webhook input mapping。
- **G4 — 单一变量表**：30 个字段（包含 `event_json`）全部派生自 `WEBHOOK_TEMPLATE_VARS`，不存在
  webhook-launch 一份、code-host 一份、prompt 又一份的手抄集合。
- **G5 — 安全注入**：进入模型上下文的 trigger 值走既有 RFC-200 `fenceUntrusted` 边界；进入 HTTP path /
  query / JSON body 的值继续按 RFC-269 的位置编码规则处理。
- **G6 — 可迁移**：存量 webhook trigger 模板、v4 workflow 定义、冻结 task snapshot 和扁平 task trigger
  快照有确定迁移路径；迁移后对外只呈现新语法。
- **G7 — Intent 原生生成**：Intent Builder 在需要 webhook 上下文时直接生成 namespaced ref，不再生成
  30 个代理 input，也不再错误地产出旧的 `{{trigger.<field>}}`。
- **G8 — 全链单一入口**：词法扫描、字段闭集、模板面枚举、task context 解析和缺失判据各自只有一个
  shared 入口；frontend diagnostics、signal guard、Intent gate、validator 与 renderer 不再各写 regex。
- **G9 — 启动前完整对账**：根 workflow 与冻结 call-workflow closure 只要引用 trigger，就必须在 task
  INSERT、公开 launch 的 repo/upload materialize 和首个节点副作用之前确认 source 存在、字段适用于本次
  event；不能等到 DAG 中段才失败。

## 4. 非目标

- **不在本 RFC 新增第二种触发来源。** `trigger.schedule.*`、`trigger.manual.*` 等只预留层级，不定义字段。
- **不允许任意对象路径。** 只有 `trigger.webhook.<known-field>` 合法；`trigger.foo.x`、
  `trigger.webhook.unknown`、`trigger.webhook.mr.iid` 都在保存期拒绝。
- **不把 trigger 暴露成 agent 进程环境变量。** 它只参与宿主模板渲染，不进入 runtime env / config。
- **不把 trigger context 加进公开启动参数。** 普通 API/multipart/schedule caller 不能自称 webhook；只有平台验签
  后的 webhook invoker 创建 context，child task 只能继承。
- **不把原始 webhook secret、header 或未归一化 payload 放入 trigger。** `event_json` 仍是既有规范化事件的
  32 KiB 截断值，不包含 webhook endpoint secret。
- **不在保存工作流时要求已经存在 webhook trigger。** 触发规则是独立资源，可在工作流之后创建；但真正
  启动 task 时会在 task INSERT、公开 launch 的 materialize 和节点副作用之前做 context preflight。
- **不把框架已经组合并围栏的 workgroup / dynamic-workflow host prompt 再展开一次。**
  `expandPromptTemplate:false` 的字面保护保持不变，避免把用户数据中的 `{{...}}` 当模板二次解释。

## 5. 用户故事

- **US-1（Intent + agent）**：我让 Intent Builder 创建一个“收到 MR 评论后分析诉求”的工作流。它在
  agent prompt 里写 `{{trigger.webhook.comment_text}}`，无需额外 workflow input；评论正文被围栏后交给模型。
- **US-2（代码平台调用）**：同一工作流最后用 `code-host-call` 回帖，project、MR、thread 分别写
  `{{trigger.webhook.project_id}}`、`{{trigger.webhook.mr_iid}}`、
  `{{trigger.webhook.comment_thread_id}}`，与 agent 使用完全相同的命名规则。
- **US-3（工作组）**：`call-workgroup.goalTemplate` 写“审查 MR
  `{{trigger.webhook.mr_iid}}` 的评论 `{{trigger.webhook.comment_text}}`”，子工作组收到已经渲染并围栏的目标。
- **US-4（子工作流）**：Webhook 启动父工作流，父工作流调用子工作流；子工作流里的 agent 仍能读取
  `trigger.webhook.*`，因为触发快照沿 call tree 原子继承。
- **US-5（手动启动）**：手动启动一个引用 trigger 的工作流，平台在创建/materialize task 之前明确报
  `trigger-context-missing`，而不是先运行前置节点、给模型字面 token、静默空串或向代码平台发空定位参数。
- **US-6（触发器配置）**：Webhook 规则的 input mapping 也插入
  `{{trigger.webhook.branch}}`，不再出现与 workflow 输入端口同形的根级 `{{branch}}`。
- **US-7（事件类型对账）**：工作流引用 `trigger.webhook.comment_text` 时，选择 `push` 的 webhook rule
  在保存彩排或 fire preflight 明确报 `trigger-field-unavailable`；`note` 事件里字段合法但实际值为空时仍按
  空串处理。
- **US-8（字面 token）**：确实要把 token 本身写给模型/HTTP 的作者使用
  `{{!trigger.webhook.comment_text}}`；所有模板面一致输出字面 `{{trigger.webhook.comment_text}}`。
- **US-9（评审重跑）**：`review.commentInjectTemplate` 用
  `{{trigger.webhook.mr_iid}}` 组织评审意见时，iterate 后的 agent rerun 继续读取本 task 冻结的同一事件；
  评审意见和 trigger 值分别按 model sink 围栏，模板静态文字不会被误当成不可信值整体吞进围栏。

## 6. 能力影响清单与用户可观察的行为变化

本 RFC 整体新增 agent/workgroup/review 读取 trigger 的能力，但也会关闭旧正式语法、静默空值 HTTP 和无 source
继续执行等既有路径。为避免把“统一”包装成无 breaking change，以下项目按能力收缩门槛逐项披露，并随本 RFC
成文契约一并请求用户批准：

| #      | 变化                                                                     | 影响                                                      | 处置                                                             |
| ------ | ------------------------------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------- |
| **B1** | Webhook launch 模板从 `{{field}}` 改为 `{{trigger.webhook.field}}`       | UI、API、文档、导出内容变化                               | 存量规则按模板版本迁移；新建/更新只接受新语法                    |
| **B2** | `code-host-call` 从 `{{trigger.field}}` 改为 `{{trigger.webhook.field}}` | 存量工作流需要迁移                                        | workflow v4→v5 迁移全部模板字段；冻结 v4 snapshot 运行前内存迁移 |
| **B3** | agent / call-workgroup / review 作者模板新增 trigger 直取              | 外部评论、标题等可不经 workflow input 直接进入模型/目标   | 模型面统一走 RFC-200 fence；validator 只允许闭集字段             |
| **B4** | task trigger 快照由扁平字典改为 `{trigger:{webhook:{…}}}`                | DB JSON 形状变化                                          | 新任务只写完整根形态；旧扁平行由版本化 decoder 迁移              |
| **B5** | `event_json` 进入 task trigger 快照                                      | 新 webhook task 最多多保留 32 KiB，与 task 同寿           | 沿用既有 32 KiB 截断；这是统一 30 字段集合的明确成本             |
| **B6** | 非 webhook task 引用 trigger 时统一失败                                  | 以前 agent 会收到字面量，code-host 只在部分必填字段上失败 | task 创建/恢复 preflight 报 `trigger-context-missing`            |
| **B7** | 旧模板中的已知两段/三段 trigger ref 会被激活为 canonical trigger         | 极少数把该形式当纯字面文本的模板会改变行为                | sink-aware migration 只激活已知字段；其它旧字面自动 escape      |
| **B8** | trigger 字段与 webhook rule 的事件类型做闭包级对账                       | 原先结构上不可用的字段会静默成空串                        | 保存彩排 + fire/start preflight 报 `trigger-field-unavailable`   |
| **B9** | schedule/manual relaunch 不能提供 webhook source                         | 指向 trigger-dependent workflow 的配置/启动将明确失败     | schedule 与手动 JSON/multipart launch 都做 none-source preflight |
| **B10** | task workflow-sync 不能改变既有 trigger source                           | 非 webhook task 不能 sync 成 trigger-dependent snapshot   | 重冻 candidate closure，root/version/closure/status CAS 前按 task 冻结 context preflight |
| **B11** | 非 NULL 但损坏/缺 discriminator 的 context 不再降级为“没有 source”       | 历史损坏 task 的恢复可能从 missing/旁路变为明确 invalid    | 三态 decoder；报 `trigger-context-invalid`，原始 JSON 不回显      |
| **B12** | code-host optional/custom 与渲染后尺寸也 fail-closed                     | 原先可能带空值或膨胀值发出的请求会在 fetch 前失败          | 全 ref preflight + final path/query/body 上限；fetch 0 calls      |
| **B13** | 已公开但 runtime 未读取的 review comment 模板开始实际执行                | 存量配置了该字段的 iterate rerun 会首次体现作者模板        | 只在 iterate 消费；comments/trigger 单独 fence，首次/reject 不变 |

B7 的激活只针对**已知**两段/三段 trigger ref（包括存量 webhook payload 中旧 renderer 曾当字面的形式），以修复
历史 Intent 产物；unknown/malformed `trigger...` 始终 fail-closed，不能靠兼容分支变成字面量。其它非 trigger、旧
renderer 原本当字面量的 `{{body}}` 由 sink-aware migration 自动加一层 `!`，保持输出字节。escape 只关闭插值，
不绕过 branch、launch、JSON 或 HTTP 位置编码规则。

## 7. 验收标准

### 命名空间与变量集合

- **AC-1**：平台对外唯一规范 token 是 `{{trigger.webhook.<field>}}`；生产 UI、Intent 文档、用户文档与
  新写定义中不再生成 `{{field}}` 或 `{{trigger.<field>}}` 作为 webhook 变量。
- **AC-2**：合法字段集合与 `WEBHOOK_TEMPLATE_VARS` 完全相等，共 30 项并包含 `event_json`；新增字段只需
  改该单一事实源即可被全部使用面看见。
- **AC-3**：`{{trigger.foo.x}}`、`{{trigger.webhook.nope}}`、路径层数错误、根级旧语法都在对应保存期
  validator 被明确拒绝，不得因正则未匹配而作为字面量漏过去；既有 code-host 双段 local port
  `{{foo.bar}}` 不被误判为 namespace，`{{!ref}}` 是唯一跨使用面的字面转义。

### Webhook 规则

- **AC-4**：workflow input mapping、agent description/inputs、workgroup goal 与三种 launch payload 的
  `workingBranch` 都按新语法静态校验和运行期渲染；事件类型可用集判据保持不变，渲染后仍过完整 launch
  schema/branch gate。
- **AC-5**：Webhook 配置 UI 的 chips 插入完整 namespaced token；光标、分组、title 与现有交互不回退。
- **AC-6**：存量 launch payload 在读取/触发前迁移成新语法；迁移完成后 API 返回新语法且后续持久化标为
  新模板版本。

### Workflow prompt / workgroup

- **AC-7**：普通 agent、fanout shard、fanout aggregator 的 `promptTemplate` 均能渲染 trigger 值，值通过
  `fenceUntrusted`，不会裸拼进 prompt；inline same-session clarify 不重复注入冻结 trigger，isolated rerun
  重新注入。
- **AC-7a**：author-facing `review.commentInjectTemplate` 不再是只存在于 schema/UI 的死配置；它使用同一 parser
  与 task TriggerContext，支持 review builtin + canonical trigger，静态模板文本保持作者语义，评论与 trigger 值各自
  围栏，iterate rerun 不另读 webhook delivery；reject 仍走独立的 `__review_rejection__` 既有语义。
- **AC-8**：`call-workgroup.goalTemplate` 能使用 trigger；工作组 host prompt 不二次展开目标内部的
  `{{...}}`。
- **AC-9**：Webhook 父任务通过 `call-workflow` / `call-workgroup` 启动子任务时，trigger context 与 parent
  linkage 一起进入子 task 的初始 INSERT；孙任务继续继承。
- **AC-10**：引用 trigger 不要求 workflow `inputs[]`、input node、edge 或 webhook input mapping；validator
  不把 `trigger.webhook.*` 当 inbound port。
- **AC-11**：根 workflow + 冻结 call-workflow closure 在公开 launch 的 repo/upload materialize 与 task INSERT
  前做统一 preflight；非 webhook 以 `trigger-context-missing` 失败，损坏快照以 `trigger-context-invalid` 失败，
  字段不适用于当前 `event_type` 以 `trigger-field-unavailable` 失败；字段适用但实际值为空仍渲染空串。手动
  JSON/multipart、
  schedule create/update/run-now/fire、webhook replay、task workflow-sync、historical resume/retry 与 dynamic confirm
  都走同一判据，并在各自最早可判定点执行。
- **AC-11a**：task workflow-sync 必须为 candidate root 重冻 matching call closure，并把 v5 root/version/closure/status
  在同一 ownership CAS 写入；context/closure 任一 preflight 失败时旧 root/closure/status 不变，不能用旧 closure 对账后
  执行新 root；workflow-sync preview 用同一 candidate preparation 提前显示 blocking trigger issue，POST 再权威复核。

### Code-host

- **AC-12**：preset params、custom path/query/body 全部使用新语法和共享 ref parser；原有 path encoding、
  JSON-string escaping、必填字段与 token redaction 规则不变；Inspector 补齐 custom query value 编辑/插入面，
  query key 保持结构字段而不插值。模板源码与渲染后 path/param/query/final JSON body 都受既有上限约束；超限不截断、
  不回显值且 fetch 为 0。
- **AC-12a**：code-host custom/preset 的**可选**字段引用 trigger 时也执行同一 context preflight；不得只有
  preset 必填参数报 missing，而 query/body 把缺失 source 静默渲染为空后继续发 HTTP。
- **AC-13**：`code-host-call` 不再拥有私有 `trigger.` 语法/变量表；它只消费统一 TriggerContext 与统一
  parser，旧 `code-host-trigger-context-missing` 只为读取历史 node run 保留，新运行发通用错误码。

### Intent

- **AC-14**：Intent 文档与 dynamic-workflow 生成提示明确教授新语法、30 个字段和适用节点（含 review
  `commentInjectTemplate`）；生成 webhook-aware 工作流时不创建合成 workflow inputs 来搬运同名事件字段。
- **AC-15**：Intent 生成的 agent prompt、workgroup goal、review comment injection、code-host params/custom request
  经 resolve + canonical workflow validator 后可直接提交；旧/未知语法进入 repair feedback，而不是形成可确认草稿。

### 数据与迁移

- **AC-16**：新任务的 `trigger_context_json` 是含合法 `event_type` 的 `{trigger:{webhook:{…}}}`；NULL 仍
  精确表示“没有 trigger context”，缺 `event_type` 的空 webhook 对象与损坏 JSON 都是
  `trigger-context-invalid`，绝不降级成 NULL。
- **AC-17**：workflow schema v4→v5 的纯迁移覆盖 agent prompt、call-workgroup goal、review comment injection、
  code-host params 与 custom request path/query/body；保留双段 dotted local ref，旧字面 brace 自动 escape；迁移幂等
  且除 B7 明示的已知 trigger 激活/invalid trigger fail-closed 外不改可观察输出语义。CRUD、Intent/bundle/resource-package/YAML、closure、task sync/snapshot 与动态生成等
  definition ingress/read boundary 共用同一迁移 helper；所有生产 workflow definition 构造点只写
  `WORKFLOW_SCHEMA_VERSION`。
- **AC-18**：历史扁平 task context 与冻结 v4 task snapshot 在 resume/retry 时仍能执行；不可恢复的历史
  `event_json` 只为空，不伪造。

### 回归

- **AC-19**：完整 webhook dispatcher → task INSERT → scheduler → agent prompt 与 code-host call E2E 同时断言
  namespaced 值正确，且数据库没有新增同名 workflow root inputs。
- **AC-20**：前后端 typecheck、lint、format、depcheck、shared/backend/frontend tests 与
  `bun run gate:local` 全绿；实现门 findings 全部处置。
- **AC-21**：统一 workflow template-surface inventory（agent、call-workgroup、review、code-host）同时驱动
  validator、v4→v5 migration、trigger
  dependency preflight 与 Intent draft scan；新增模板字段却未登记时 contract test 失败。Intent 的 trigger
  vocabulary 位于公共 workflow 章节，不受 code-host author 权限开关影响。
- **AC-22**：普通 agent/fanout/aggregator 只展开作者模板；workgroup/dynamic host、commit-message agent、
  merge-conflict agent 等 framework-composed prompt 即使含 canonical token 也保持字面，不泄漏 trigger。
- **AC-23**：agent prompt、call-workgroup goal 与 review comment injection preview 使用显式的确定性 sample
  TriggerContext，不以
  “undefined 就保留 token”的私有运行语义冒充真实渲染；missing-ref diagnostics 与 signal-port guard 都通过
  shared parser 忽略合法 trigger ref、仍检查 local port。
- **AC-24**：task API/资源导出不自动新增原始 trigger context 字段，也不扩到 runtime env/config；作者显式
  把某字段渲染进 workflow input、prompt 或 HTTP 时，值继续遵循该既有 sink 的审计/保留语义，不能把这种显式
  使用误报成“从不出现在详情”。

## 8. 已拍板（2026-08-12）

- **P1**：trigger 全系统统一，代码平台调用逻辑也必须一起迁移，不能为 agent 留一套、code-host 留一套。
- **P2**：规范路径是 `trigger.webhook.<field>`，不把 webhook 字段铺在 `trigger` 根层。
- **P3**：trigger context 与 workflow root inputs 是两类数据；Intent 不得为直接 trigger 引用生成 30 个根输入。
- **P4**：所有使用面都改，Intent 也应原生生成该能力。
- **P5**：统一包含代码平台、agent 注入、工作组、子任务、Intent/动态生成、校验/预览/迁移全链；不能只
  改最终 renderer 后留下私有 regex 或不同 missing 语义。
