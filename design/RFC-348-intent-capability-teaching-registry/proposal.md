# RFC-348 Intent 能力全景注册表：INTENT.md 从注册表派生、新增能力强制完成意图登记

状态：**Approved r12（2026-08-30 用户批准 D1～D12 并授权实现 + 提交推送；三项另裁已按用户选择折入本稿，见 §4 ★ 与 §8）**——current-source 审计与三件套已完成；设计门 r1（Codex 12 条 + Claude
子代理 11 条）、r2（9 条）、r3（6 条）、r4（4 条）、r5（5 条）、r6（5 条）、r7（4 条）、r8（3 条）、r9（3 条）、r10（4 条，0 P1）、
r11（2 条 P3，已清）均只审功能、已全部核实折入本稿；核心类型机制（与 design §1.1 逐字相同，覆盖全部 8 种 strict kind）已用 `tsc` 对仓内真实 schema 编译验证
（八个负例、五处变异自检，`type-probe.md`）。等待用户批准 D1～D12 后进入实现，批准前不改生产代码。

## 0. 一句话

意图构建（Intent Builder，RFC-234/235）给模型的唯一规格 `INTENT.md` 目前是一份 500 行的手写模板字符串：
平台有 15 类 ACL 资源它只知道 6 类、14 种 NodeKind（13 种可创作 + 1 种平台合成）里已有 6 处字段级漂移、用户在创建器里选的
资源类型从未到达模型、新增能力时没有任何编译期或运行期机制逼作者回来登记。本 RFC 把「平台有什么能力、模型能怎么用」收成
**三张 `satisfies Record<…>` 编译期穷尽的注册表**（节点形态 / 资源类型 / 15 类 ACL 平台能力地图，含嵌套 schema 与
discriminatedUnion 各变体的子表），`INTENT.md` 改为这些注册表的**投影**，补齐已漂移的字段与「请求的资源类型」数据流，
修一个既有的 `branchPorts` 丢失 bug，并给字段级漂移加上会变红的门（编译期常驻负例 + 路径级对账 + AST 反向扫描）。

## 1. 背景：current-source 审计（2026-08-30，按 `main` 当前源码；设计门 r1/r2 逐条复核后修正锚点）

用户反馈「意图构建里 Agent 总是不满足需求，感觉 AI 没有看到能力全景」。逐项对照源码，症状有四层：

### 1.1 模型看到的只有六类资源，平台有 15 类

- ACL 资源 15 类：`packages/shared/src/schemas/resourceAcl.ts:23-60`（agent / skill / mcp / plugin / workflow /
  workgroup / capability_template / action_template / verification_profile / digital_employee / automation_policy /
  development_adapter / employee_definition / employee_tool / employee_job_template）。
- Intent 固定六类：`resourceAcl.ts:112-119`（`INTENT_RESOURCE_TYPES`）；catalog selector 直接等于它
  （`packages/backend/src/modules/resource-catalog/domain/resourceKinds.ts` `CATALOG_SELECTOR_KINDS = INTENT_RESOURCE_TYPES`，
  `infrastructure/sqliteCatalogQuery.ts:296`）。
- 因此其余 9 类**既不可创建也不可见**：`INTENT.md` 只说 "Six resource types"（`services/intent/intentDoc.ts:266`），
  inventory 只有六个文件（`services/intent/dumpBuilder.ts:467-474`）。「不可创建」是 RFC-304 T17a 有意的
  （`packages/shared/src/schemas/intentChangeset.ts:507-510`：`intent_provenance` 存不下模版类型），但它把「不可见」也一起捆掉了——
  模型连「这个要去 X 页配置」都说不出来，只能拿六类硬凑。
- inventory 里的 agent 只有 `name` + description 首行（`dumpBuilder.ts:812-826` `summarizeInventoryRow`），**端口名不在其中**；
  而 doc 又告诉模型 "an agent's out-ports = its `outputs`"（`intentDoc.ts:427`）。「用我现有的 auditor 建一条流水线」只能猜端口名
  或多花一轮 `requests` 挂载（一轮 = 一次真实模型进程）。

### 1.2 已有类型的字段在漂移（守卫只到 kind 级）

| 能力 | 来源 | 现状 |
| --- | --- | --- |
| `wrapper-loop.continueOnMaxIterations` | RFC-236（2026-07-30，`bad82fe42`）；`packages/shared/src/loopPolicy.ts` | `intentDoc.ts:418` 只教 `maxIterations/exitCondition/outputBindings` |
| 退出条件 `kind:'port-inactive'` | RFC-306；`modules/task-execution/domain/loopExitCondition.ts:19-24`，合法性判定 `modules/task-execution/public/queries.ts:30` `isValidLoopExitCondition` | `intentDoc.ts:418` 只列四种；**编辑器同样漂移**：`packages/frontend/src/components/canvas/inspector/WrapperGitLoopEdit.tsx:163-168` 下拉只有四种，帮助文案 `i18n/en-US.ts:6307` / `zh-CN.ts:12550` 亦只列四种 |
| script `outputs[].branch` | RFC-306；`packages/shared/src/schemas/workflow.ts:937-950` | `intentDoc.ts:197` 教 `outputs?:[{name,kind?}]`，无 `branch`（嵌套 schema 字段，顶层 key 守卫抓不到） |
| mcp `config.timeoutMs` | `intentChangeset.ts:236,260`（local / remote 两变体都有） | `intentDoc.ts:399` 教 `config:{command, env?}` / `{url, headers?}`，无 `timeoutMs`（变体子字段） |
| agent `branchPorts` | RFC-306；`packages/shared/src/schemas/agent.ts:353`，落库在 `frontmatter_extra.branchPorts`（`services/agent.ts:253`），读出时提升为顶层并从暴露的 `frontmatterExtra` 删除（`services/agent.ts:1190-1201`） | `IntentAgentPayloadSchema`（strict，`intentChangeset.ts:123-165`）没有该字段；dump 未传顶层字段（`dumpBuilder.ts:511-539`）⇒ **dump 里完全没有 `branchPorts`**；doc 不教。**且存在数据丢失 bug**：intent 的 agent update 总是发 `frontmatterExtra`（`resolveChangeset.ts:563` `p.frontmatterExtra ?? {}`），`prepareAgentUpdate` 因此走「显式 patch」分支、跳过 sidecar 保留（`services/agent.ts:496-523`），`branchPorts` 未出现在 patch 里就不再写回（`:538-545`）⇒ 任何经 intent 更新的带分支端口 agent 都会被清掉分支端口 |
| agent `permission` | `intentChangeset.ts:152`（`z.record(z.string(), z.unknown())`，opencode 权限词表原样透传；词表在 `services/runtime/opencode/boundary.ts:152` `OPENCODE_PERMISSION_KEYS`，顶层 `'*'` 展开于 `:127-139`；claude 侧映射、`'*'` 基线与 headless `ask`⇒`deny` 见 `services/runtime/claudeCode/permissionMap.ts:1-27,103-126`） | schema 有、doc 不教（`intentDoc.ts:397`）；教了也没有语法可依 |
| agent `runtime` | `intentChangeset.ts:149-151`（runtime profile **名字**，resolve 时校验存在） | doc 提了字段却从不给取值清单，模型只能猜或抄挂载的 agent |
| clarify / clarify-cross-agent 固定端口 | `packages/shared/src/schemas/workflow.ts:682-687, 755-757`（`questions` / `answers` / `__clarify__` / `__clarify_response__` / `to_designer` / `to_questioner`） | 形态行（`intentDoc.ts:421-422`）只有 `title?,description?,sessionMode?…`，端口一个都没教；模型发出的 clarify 节点悬空或接错 |
| agent-single `overrides?` | RFC-115 已删（`packages/frontend/src/components/canvas/inspector/AgentSingleEdit.tsx:169-171`；validator / task-execution 零读点） | doc 仍教一个**死字段**（`intentDoc.ts:415`） |

现有守卫 `packages/backend/tests/rfc234-intent-doc.test.ts:196-218` 只断言 `{id,kind:'x'` 锚点**存在**（注释自称
deliberately shallow）：新 kind 漏教会红，已有 kind 加字段绿着漂移。历史已经两次证明：RFC-243/253/269 三种 kind 漏教
数月才补（`rfc234-intent-doc.test.ts:180-190`），补完守卫后 RFC-236/306 的字段级又漏了四处。

### 1.3 用户选的资源类型从没到过模型

前端创建器把 `hint`（agent/skill/…/workgroup）发给后端（`packages/frontend/src/components/intent/IntentCreateComposer.tsx:82`），
后端塞进首轮 turn 的 `contentJson`（`services/intent/session.ts:306`），渲染进 `INTENT.md` 时 `turnDisplayText()` 只取
`message`（`services/intent/turnEngine.ts:149-153`）。RFC-235 design §0.2.1（`design.md:450`）早已点名「ChoiceCard 因而是
no-op」并以 D33/T2.8a 计划修复（语义：**受信弱偏好、用户明确目标优先**，`design.md:578`、`proposal.md:697`），但 v22 收口
验收项里没有它（`proposal.md:41-60`），`plan.md:264` T2.8a 仍是 `[ ]`，代码里 `artifact_hint` / `requestedArtifactHint` 零命中。
「自动判断」与「工作流」两个选项对模型完全等价。

### 1.4 手拼而非派生；新增能力不会被架构逼着登记

- 派生的只有两处：code-host 动作目录 `renderCodeHostActionCatalog()`（`intentDoc.ts:160-184`，注释 `:148-158` 写明
  手抄会静默过期）与 webhook token 目录（`:49,391`）；权限镜头 `privilegedNodeLensFor` 与写门同源。
- 手抄的：六类清单、六类 payload 字段（`:397-428`）、13 种可创作节点形态（`:409-424`）、input kinds、退出条件 kinds、workgroup
  字段——全是字面量。同一份「六类」在 `manifest.ts` fence union、`dumpBuilder.ts` 三条 if-else 链（`:281-289, 425-433,
  812-826`）、`resolveChangeset.ts:542-651`、`applyChangeset.ts:536-723`、`intentChangeset.ts:534-541`、前端
  `IntentCreateComposer.tsx:23`（手打 union，未 import shared 的 `INTENT_RESOURCE_TYPES`）、`IntentMountDialog.tsx:14`、
  `IntentOpPreview.tsx:121-138`、`IntentEntryButton.tsx:16-19`、`routes/intent.tsx:27-36,76-78`（search 解析会**静默丢弃**
  第七类 hint/mountType）、`IntentProvenanceBadge.tsx:17` 各复制一份。
- NodeKind 侧仓内有 8 处 `satisfies Record<NodeKind,…>` 编译期穷尽点（`docs/dev-gotchas.md:1000`），`intentDoc` 不在其中——
  `dev-gotchas.md:1007` 自述「第 9 处穷尽点不受编译器保护」。资源类型侧 `satisfies Record<AclResourceType|IntentResourceType,…>`
  全仓 **0 命中**。
- `IntentWorkflowNodeSchema` 是 `kind: z.string()` + passthrough（`intentChangeset.ts:287-301`），`definition.inputs[] / edges[] /
  outputs` 是 `unknown`（`:303-311`）；平台自身 5 种 kind（agent-single / input / output / wrapper-git / wrapper-loop）没有独立
  zod schema，字段合同散在 `workflow.validator.ts`（`read{String,Number,StringArray,Bindings}(node, '<field>')`，`:3261-3285`）
  与运行时（`loopPolicy.ts` 注释：kind-specific fields intentionally stay passthrough）。

### 1.5 精炼度

全权限 `INTENT.md` 约 18 KB（守卫上限 32 KB，`rfc234-intent-doc.test.ts:684`），其中约四成是历次 live-run 教训堆出的
反例句（"There is NO `systemPrompt`…"、JSON 闭合检查、redaction 省略规则），散落在各节。可收，但不是主要矛盾；设计门指出
**字段旁的反例句必须留在字段旁**（它们正是为那个字段的 live-run 失败而加），只把跨字段的反例收成一节。

## 2. 目标 / 非目标

### 目标

1. **能力全景**：模型每轮看到平台全部 15 类资源的存在与立场（六类可创建 / 九类只读点名 + 真实管理入口），看到全部可创作节点
   形态与其**全部**当前字段（含嵌套 / 变体字段与 RFC-236/306 已漂移项、clarify 固定端口），看到 inventory 里每个 agent 的端口名，
   看到 runtime profile 的真实取值清单（含有效默认）与 `permission` 语法，看到用户在创建器请求的资源类型。
2. **派生而非手拼**：`INTENT.md` 的「平台模型 / 平台能力地图 / 请求的资源类型 / 节点形态 / 资源 payload 字段 / 常见错误」
   六节全部由注册表渲染；prose 只能写在注册表条目里。
3. **架构引导登记**：新增 `NodeKind` / `IntentResourceType` / `AclResourceType` 时**编译失败**直到作者在注册表里声明其意图
   立场；给有 strict schema 的 kind / 资源 payload（含嵌套对象 schema 与 discriminatedUnion 各变体）新增字段时编译失败直到
   写下教学条目；平台 create schema 与 intent payload 的字段差异必须逐项带理由登记，否则测试红；validator 经 `read*` helper
   对 passthrough kind 新读的字段未登记即测试红。
4. **修复功能缺口与 bug**：`branchPorts` 进 intent payload / dump / doc 并修掉 update 清空 bug；`hint` 进 doc；死字段
   `overrides` 停教；编辑器与 doc 同步补 `port-inactive`。
5. **精炼**：跨字段反例收成「Common mistakes」一节，字段旁反例保留在字段旁，契约测试锁住的句子逐字保留。

### 非目标

- 让其余 9 类 ACL 资源变为 intent 可创建 / 可挂载（RFC-304 T17a 的裁决不动）。
- 让那 9 类资源可被 changeset / requests 引用或挂载（它们只以只读清单出现，见 D3）。
- 为 5 种 passthrough kind 建立独立 zod schema 或改动 `workflow.validator.ts` 的校验语义 / 错误码。
- 扩 RFC-345 的 `ResourceSummary` / selector 合同（端口投影与九类只读清单都在 intent 侧完成，见 D5c / D3）。
- 迁移 Intent apply 到 AtomicApply（RFC-294 W6）；改动 resolve/apply 的业务语义（只加穷尽守卫与 `branchPorts` 透传 / 保留）。
- 交互式 OAuth 授权流程（intent 只写入 oauth 配置对象，与 `/mcps` 表单同权）。
- 任何安全类检视与加固（用户 2026-08-26 明令）。

## 3. 用户故事

- **US-1** 我在创建器里选了「工作流」，输入目标后，模型第一轮就产出工作流（而不是先造一个 agent 再问我要不要工作流）；
  我在后面某轮明确说「现在把它包进一个工作流」时，模型直接照做，不因首轮选的是 agent 而反问。
- **US-2** 我要一个「循环到没有可修项就停」的流程，模型能写出 `exitCondition:{kind:'port-inactive'}` 与
  `continueOnMaxIterations`，编辑器里也能选到 `port-inactive`。
- **US-3** 我说「给这个审计 agent 加一个分支端口，没有问题时跳过修复」，模型能在 agent 上写 `branchPorts`，提交后工作流
  画布里能看到分支；我后来再经意图构建改这个 agent 的提示词，分支端口不会被清掉。
- **US-4** 我让模型「配一个数字员工」，它明确告诉我这在 `/code/config/employees` 配置、意图构建不能创建，并提出它能做的
  部分（agent / 工作流），而不是硬凑一个同名 agent。
- **US-5** 我说「用我现有的 auditor 建一条流水线」，模型从 inventory 直接看到 auditor 的输入 / 输出端口名，一轮接好线。
- **US-6**（开发者）我给 `ReviewNodeSchema`、`ScriptOutputPortSchema` 或 workgroup member 的 agent 变体加一个字段，
  `bun run typecheck` 立刻在 `modules/intent/domain/teaching/` 报错，逼我写下教学条目；给 `ACL_RESOURCE_TYPES` 加第 16 类，同样红。

## 4. 裁决清单（D1～D12，2026-08-30 已获用户批准；r12 按用户三项另裁的变更以 ★ 标出，r2～r11 变更保留 ☆）

- **D1 节点形态注册表 `INTENT_NODE_TEACHING`**：☆ `satisfies { [K in NodeKind]: NodeTeachingOf<K> }`（由 schema 派生的
  mapped type，不是手写 `Record`；14 项：13 种可创作 + `code-round` synthesized-only，★ 后者**没有** `fields` 属性——
  `Record<never,never>` 等于 `{}` 挡不住多余键）；每种可创作 kind 声明 `availability`、`fields`、`notes`、`mistakes`。有独立 zod
  schema 的 8 种 kind 其 `fields` 类型 = `Omit<TeachingFieldsOf<Schema>, 基础键>`（★ `Omit` 作用在派生出的字段表上）：schema 新增
  顶层字段即编译红；对象 / 对象数组 / 变体字段**强制**带 schema 键控的 `nested`（新增对象字段只登记父字段也红）；★ passthrough
  kind 的 `fieldSources` 必须恰好覆盖每个声明字段、strict kind 不得携带（编译期）。以上类型已用 `tsc 5.9.3` + 仓内 `zod 3.25.76`
  对真实 schema 编译验证（design §1.1；探针见 `type-probe.md`）。
  - **D1c 嵌套与变体子表**（☆）：嵌套对象 / 数组元素 schema 各建子表（`ScriptOutputPortSchema`、
    `CodeHostCustomRequestSchema`、`WrapperFanoutPortSchema`、`PortRefSchema`、`limits` 等），以子 schema 的键键控；
    discriminatedUnion **一律按变体各建一张**子表——因为 TypeScript 对对象联合做 `keyof` 得到的是**交集**，并集 `KeysOf`
    只能证明「顶层没漏」，variant-only 字段必须靠变体子表才会编译红；☆ 变体表 ★ `IntentVariantTeaching<typeof Schema>` 的
    `variants` 键来自 `VariantValues<Schema>`，新增一个变体未建表同样编译红（design §1.1）。
  - ☆ 5 种 passthrough kind 的 `fields` 以注册表内声明的字面量键控，每个字段带 `readPoint{file, identifier}` 或 `intentOnly`；
    正向 / 反向检查都用 **TypeScript AST**（注释天然不命中）：反向遍历 `workflow.validator.ts` 里
    `read{String,Number,StringArray,Bindings}` 调用第二实参子树内的**全部**字符串字面量（覆盖条件字面量），每个字面量必须属于
    某 kind（strict 或 passthrough）的教学键 ∪ `WORKFLOW_INPUT_TEACHING` 键 ∪ 显式 allowlist（`agentName` / `agentId`：平台身份
    缓存字段，intent 以 `agentRef` 表达）；当前源码的完整初始集合（r3 已由 Codex 逐行核对）作为基线夹具常驻（design §1.2）。裸读
    `(node as Record<…>).x` 不在扫描语法内（残债，design §10）。
- **D1b 退出条件 kinds 下沉 shared**：新增 `LOOP_EXIT_CONDITION_KINDS`（`packages/shared/src/schemas/workflow.ts`）；
  消费者五处：`modules/task-execution/domain/loopExitCondition.ts`（union 与 parse，逐 variant 字段校验保持）、
  `modules/task-execution/public/queries.ts` `isValidLoopExitCondition`、`services/workflow.validator.ts`（`readExitConditionKind`
  只服务 `port-inactive` 特例，合法性仍由 `isValidLoopExitCondition` 判）、intent 教学、前端 `WrapperGitLoopEdit.tsx` 下拉 + 两份
  i18n 帮助文案（补 `port-inactive` 及其说明，配组件测试）。
- **D2 资源类型注册表 `INTENT_RESOURCE_TEACHING`**：☆ `satisfies { [K in IntentResourceType]: IntentResourceTeaching<ResourceFieldsOf<IntentPayloadSchemaOf[K]>> }`
  ——六类**每一类**的 `fields` 都由其 payload schema 派生（★ mcp 根是 discriminatedUnion ⇒ `fields` 直接是按 `type` 变体的
  `IntentVariantTeaching`，与 doc 今日的两形态写法一致；workgroup 的 `superRefine` 由 `Unwrap` 剥离；`KeysOf` 终止分支只让
  ZodObject 贡献键，避免 `keyof never` 退化为 `string`）；☆ 变体子表：mcp `config[type=local]`（command / env / timeoutMs）与 `config[type=remote]`（url / headers / timeoutMs）、
  workgroup `members[memberType=agent|human]`；嵌套子表：agent `inputs[]`、★ agent `skills[]` 的 project 对象 option、
  ★ skill `files[]` 元素、workgroup `switches`、workflow `definition`（r6 P1：后两者此前绕过编译穷尽门）。
  ☆ intent 侧 `definition.inputs[] / nodes[] / edges[] / outputs` 是 `unknown` / passthrough，教学与对账**委托**给
  `teaching/workflowParts.ts`：☆ `WORKFLOW_INPUT_TEACHING`（`satisfies Record<WorkflowInputKind, …>`）每种 kind 都有
  `base`（`WorkflowInputSchema` 五个键）+ `extra` 扩展字段表——`upload` 以 `UploadInputSchema` 键控，`text{multiline,maxLength}` /
  `files{minCount,maxCount,accept}` / `enum{choices,multiSelect,allowOther}` / `git{gitKind}` 四种是 passthrough 字段（现有
  doc `intentDoc.ts:401-405` 在教、`services/workflowLaunchInputs.ts` 与前端 pickers 在读），以字面量键控并带读点；
  ☆ 另设 `INPUT_FIELD_OWNERSHIP`（字段 → 拥有它的 kind 列表 + `authorable` 标记，`minCount:[files,upload]` 等；前端派生的
  `presentation:[text]` / ☆ `agentKind:[text,upload]` 以 `authorable:false` 登记、不教但纳入扫描；★ 前端扫描文件清单 = 创作面
  `InputEdit.tsx` + 启动面 `launch/{DynamicInput,FilesPicker,EnumPicker,GitPicker,UploadPicker}.tsx` / `webhookAgentAuthoring.ts` /
  `routes/tasks.new.tsx` / `lib/task-wizard.ts`（测试常量，每文件 ≥1 命中、总集非空））与教学表三向互锁，反向 AST 扫描
  `workflowLaunchInputs.ts` 的 `numberField/stringField` 字面量与 `(def as Record<…>).x` 属性名（基线为实际可扫出的七个
  passthrough 名）；`WORKFLOW_EDGE_TEACHING` / `WORKFLOW_OUTPUT_TEACHING` / ★ `WORKFLOW_PORT_REF_TEACHING`（review
  `inputSource`、边 `source/target`、output `bind` 三处共用一张）以平台 schema 键控；`nodes[]` 引用 D1 的节点表。
  另设**平台字段对账表**（★ r5 改为「逐层键比较 + 对象级覆盖棘轮」，design §1.4）：r3/r4 证明「递归路径集合双向包含」在今日
  源码上对不齐——intent 用 handle 表达平台的 id 字符串（`dependsOn[] / mcp[] / plugins[] / skills / members[].agentId`）、
  `$schema_version` 一侧是 literal 联合一侧是 number，这些都是**叶子类型**差异，属于 resolve seam 而非漂移。新模型：一张
  `ReconciliationEntry[]`，每条把平台 create schema 树里的**一个对象节点**（含 discriminatedUnion 某变体、数组元素）与 intent 侧
  对应对象或教学表**只按一层键名**对账（entry 两侧都带显式 `paths` 与键视图；`renamed`：plugin `options→optionsJson`、
  workgroup agent 变体 `agentId→agentRef`；`excluded{why}`：agent `network`、workgroup 两变体各自的 `userId` / `agentId`、
  workflow 基础节点的 `position/title`；★ **mcp remote `config.oauth` 改为 intent 可创作**（用户另裁 ②）：intent remote config 增
  `oauth?: {clientId?, clientSecret?: '‹secret›' | '', scope?, redirectUri?} | false`（与平台 `McpOAuthConfigSchema` 同键），
  `clientSecret` 是密钥载体——`findNonSentinelSecretCarriers` 增 `/payload/config/oauth/clientSecret`、`deriveIntentSlots` 为其发
  `secret` 槽、resolve 按 pointer 回填；语义：create 省略 = 平台默认（auto discovery）、`false` = 禁用、对象 = 显式客户端；
  update 省略 = 保留既有（`applyChangeset.ts:646-653` 今日已这样做）；dump 投影为 `false` 或 `{clientId, clientSecret: ‹redacted›,
  scope, redirectUri}`（今日整体 ‹redacted›）；对账表由「排除 oauth」改为新增 entry `mcp.remote.config.oauth`；`intentOnly{why}`：skill `files`、节点的 `workflowRef/workgroupRef`——
  ★ strict kind 条目的教学键视图相应剔除这三个通用引用键；★ 平台 workgroup member 单对象 ⇔ intent 两变体以 `variants`
  逐变体映射）；再加**覆盖棘轮**：遍历六个平台 create schema 的对象节点（★ 今日 24 个，含 `nodes[].position` 的 XY 对象），
  每个必须**恰好**满足一种：被恰一条 entry 覆盖 / 落在 `excluded` 子树 / 列在带理由的 `RECONCILIATION_UNCOVERED_PLATFORM_OBJECTS`
  （★ 今日只有 `agent.skills[]<managed>`：intent 用裸 handle 表达；`config.oauth`、`nodes[].position` 已由 excluded 子树覆盖，不再重复
  列入）；intent 侧对称（今日 **18** 个，含 r12 新增的 `<remote>.config.oauth`；`skill.files[]` 由 intentOnly 子树覆盖，uncovered 表为空）。★ entry 共 **29** 条（含 8 条 strict kind 与 upload 共 9 条树外配对；r12 因 oauth 可创作 +1）。平台
  新增嵌套对象或任一已登记对象增键 ⇒ 红；**T1.2 把 `branchPorts` 加进 intent payload 之后**恰好为绿是 T2.5 的退出门（r5
  设计门已逐节点 walk 确认归属）。
- **D3 平台能力地图 `INTENT_PLATFORM_RESOURCE_MAP`**：`satisfies Record<AclResourceType, …>`；六类 `intent-creatable`，
  九类 `platform-only{purpose, managedAt}`；测试断言两集合与 `INTENT_RESOURCE_TYPES` 严格互补。渲染为一节
  （名称 + 用途一句话 + 管理入口）；★ **并按用户另裁 ③ 列出九类的真实行**：`inventory/platform/<type>.md` 每类一个文件，行为
  `- <name> — <description 首行>`（**无 handle**，明示不可在 changeset / requests 里引用；每类 ≤ 200 行，截断标注），数据由
  intent 侧的只读加载器表 `PLATFORM_ONLY_INVENTORY_LOADERS satisfies Record<Exclude<AclResourceType, IntentResourceType>, …>`
  提供——每个加载器调用该类型**既有**的行加载（`listTemplateRows` / dev-automation 的 `templateStore.list()`、`profileStore.list()`、
  `listDigitalEmployees`、`listAutomationPolicies` / integration adapter store / digital-employee 模块的 employees、按 type 迭代的
  tools 与 job templates）再经 resource-catalog 公共 `filterVisibleRows(db, actor, type, rows)` 过滤（与各自 REST 列表同一判据）；
  **不扩** RFC-345 的 `ResourceSummary` / selector 合同（其 D1「禁止 roster 扩散」不变），加载器归 `services/intent/`（过渡层），
  记为待 RFC-345 落地后折入 catalog 的债；第 16 类 ACL 资源必须同时在能力地图声明立场**并**登记加载器（或带理由的
  `inventory: 'none'`），否则编译红。`managedAt` 必须是真实入口并由测试对照前端路由表校验：
  `digital_employee` → `/code/config/employees`；`action_template` → `/code/config/action-templates`；
  `verification_profile` → `/code/config/verification-profiles`；`automation_policy` → `/code/policies`；
  `development_adapter` / `employee_definition` / `employee_tool` / `employee_job_template` → `/digital-employees`
  （`/code/config/adapters` 已重定向至此，`code.config.tsx:108-110`）；`capability_template` 当前**没有专属页面**
  （仅 `/api/capability-templates` 与 code mission 消费），如实登记 "no dedicated page; created by code missions" 而不虚构路径。
- **D4 请求的资源类型进 doc**：`turnEngine` 从首轮 user turn 的 `contentJson.hint` 读取（该 turn 不可变、已 durable），经
  `z.enum(INTENT_RESOURCE_TYPES).safeParse` 收窄（★ 接受 unknown：存量自由文本 / 非字符串 ⇒ null；`asIntentResourceType` 只接受
  `AclResourceType`，不适用）后作为 `IntentDocInput.requestedArtifactType` 渲染为「## Requested artifact type」一节。
  语义按 RFC-235 D33：**受信弱偏好、用户明确目标优先**——目标契合时优先该类型；用户在任一轮明确要求别的类型时直接照做，
  不因与预选不符而反问。**不新增 `intent_sessions.artifact_hint` 列**（取代 RFC-235 D33 的列方案：首轮 turn 已是不可变
  durable 源，加列是双写）。Auto / 省略时渲染一句「No type requested (Auto): choose the resource mix yourself from the goal.」。
- **D4b hint wire 收紧**：`CreateIntentSessionSchema.hint` 由 `z.string().max(200)` 改为 `z.enum(INTENT_RESOURCE_TYPES)`
  （RFC-235 D33 原设计）；前端与 e2e 本来只发六类（`IntentCreateComposer.tsx:82`；CLI / MCP 不发）；历史存量自由文本 hint
  读取时收窄失败即忽略。
- **D5 字段缺口修复**：`IntentAgentPayloadSchema` 增 `branchPorts`（复用 `AgentBranchPortsSchema`），resolve 透传，
  dump 以顶层 `branchPorts` 输出（`serializeAgentMarkdown` 已支持）；**intent apply 的 agent update 改为 presence-aware**：
  模型省略 `branchPorts` ⇒ 在 `UpdateAgentSchema.parse` 前填入 `existing.branchPorts`（`prepareAgentUpdate` 随后按
  `services/agent.ts:538-545` 写回），发 `[]` ⇒ 清除；`prepareAgentUpdate` 不动。`wrapper-loop` 教 `continueOnMaxIterations`；
  退出条件教 `port-inactive`；script outputs 教 `branch`；mcp 教 `config.timeoutMs`；agent-single **停教** `overrides`。
  ★ 用户另裁 ①：`outputKinds / role / outputWrapperPortNames` 三个 sidecar 在 intent update 里**同样改为「省略即保留」**
  （apply seam 与 `branchPorts` 同法从 `existing` 回填；清除语义：`outputKinds: {}` / `role: 'normal'` / `outputWrapperPortNames: {}`）；
  doc 的三条教学句相应改写；`prepareAgentUpdate` 仍不动。
- **D5b runtime 取值清单**：dump 新增 `inventory/runtimes.md`（`listRuntimes` 的 `name` + `protocol` + `enabled=false` 标 disabled；
  不含 binaryPath / configDir / extraArgs）。☆ **有效默认**用 agent 启动时的同一解析语义 `resolveAgentRuntime(db, null, cfg.defaultRuntime)`（= `resolveRuntimeByName(db, cfg.defaultRuntime ?? 'opencode')`，
  `runtimeRegistry.ts:421-455,472-480`：有行取行、内建名无行取内建、未知名回退 opencode；实现门 r1 勘正）算出并写在清单 header
  （`Effective default: <name> (<protocol>)`）；默认名有行则标 `(default)`，无行则追加一行 `(built-in, no profile row) (default)`
  ——与任务启动时的默认一致，不拿配置字符串直比。★ 传递路径：`resolveIntentTurnConfig` 已拿到 `cfg.defaultRuntime`
  （`turnEngine.ts:889-908`），在此解析并放进 `IntentTurnConfig.effectiveDefaultRuntime`（与 Intent Builder 自用的 `runtime`
  并列），`dispatcher.ts:82-83` 原样透传，`runIntentTurn` 注入 dump（`listRuntimes(db)` 与无值时的回退 `resolveRuntimeByName(db, null)` 在 `dumpBuilder` 内部读）；agent `runtime` 教学指向该文件。★ 文件头与教学句都明说
  「新建 / 改绑只能选 enabled 行；(disabled) 行仅供识别既有 pin」（`validateRuntimeReference` 的 `runtime-disabled`，
  `services/agent.ts:987-1009`）。
- ☆ **D5c inventory 的 agent 行带端口名**：`inventory/agents.md` 每行追加 `inputs:[…] outputs:[…]`（名字）。★ 投影在
  `buildIntentDump` **内部**对排序、截断后的 `kept` agent id 执行（它才持有可见 catalog，`dumpBuilder.ts:190-221,728-756`），
  默认投影 `loadAgentPortsFromDb` 就在 `dumpBuilder.ts` 内（一次 `agents.inputs / agents.outputs` 两列窄投影，`db/schema.ts:32,36`，
  ≤ `INTENT_INVENTORY_CAP` 个 id），`IntentDumpInput.loadAgentPorts` 为可注入 seam（测试用 spy 锁「恰一次、只收截断后 id」；实现门 r1/r2 勘正：不再有独立的
  `agentPortsProjection.ts`，`turnEngine` 也不注入）；RFC-345 的
  `ResourceSummary` 合同**不扩字段**；workflow / workgroup 行不变（call-workflow 仍要求挂载读端口）。
- ☆ **D5d opencode 权限词表下沉 shared 并教 `permission` 语法**：`OPENCODE_PERMISSION_KEYS` / `OPENCODE_PERMISSION_ACTIONS`
  ★ / `OPENCODE_PERMISSION_WILDCARD_KEY = '*'` 从 `services/runtime/opencode/boundary.ts:152` 移到
  `packages/shared/src/schemas/agent.ts`（消费者：boundary、`claudeCode/permissionMap.ts`、intent 教学）；教学句由常量派生：
  key 为 `'*'`（全键基线，`boundary.ts:127-139` 展开、`permissionMap.ts:103-126` 基线）或已知键之一，值为
  `'allow'|'deny'|'ask'` 或 `{pattern: action}`，headless 下 `ask` 视同 `deny`，未知 key 不放行。
- ☆ **D5e clarify 固定端口进教学**：clarify / clarify-cross-agent 的 `notes` 由 shared 端口常量派生
  （`CLARIFY_INPUT_PORT_NAME` / `CLARIFY_OUTPUT_PORT_NAME` / `CLARIFY_SOURCE_PORT_NAME` / `CLARIFY_RESPONSE_TARGET_PORT_NAME` /
  `CROSS_CLARIFY_*`），并说明 ask-back 边的接法。
- **D6 前端派生**：六处——`IntentCreateComposer`（选项 + 图标表）、`IntentMountDialog.MOUNT_TYPES`、`IntentOpPreview`
  渲染表、`IntentEntryButton` props 类型、`routes/intent.tsx` search 解析（`ARTIFACT_TYPES`）、`IntentProvenanceBadge` props
  类型——全部改为 `IntentResourceType` / `INTENT_RESOURCE_TYPES` 并 `satisfies Record<IntentResourceType, …>`；删除手打 union。
- **D7 后端表驱动与 RFC-345 并发规避（分档）**：
  - **必做且不可跳过**：`resolveChangeset.ts` agent case 的 `branchPorts` 透传 + `applyChangeset.ts` agent update 的
    presence-aware 保留（D5）。这两个文件在 RFC-345 T4b/T7 cohort（其 §4 预计范围含 `services/intent/**`、
    `intent/dumpBuilder.ts`）：实现前 `git status --porcelain` 与 `git log` 核对；若有他人未提交改动，**停下问用户协调**，
    不得跳过、不得单方面覆盖，AC-4 未落地不得标 Done。
  - **可跳过并记债**：`dumpBuilder.ts` 三条三目链与 `summarizeInventoryRow`、`manifest.ts` fence 构造改
    `satisfies Record<IntentResourceType, …>` 表；`resolveChangeset.ts` / `applyChangeset.ts` 的 `switch` 加
    `const _exhaustive: never = op` 守卫（仓内既有 idiom，`shared/src/lifecycle.ts:151`）。撞上在制品即跳过并在实现报告记债。
- **D8 doc 结构**：新增「Platform capability map」「Requested artifact type」「Common mistakes」三节；字段旁反例
  （plugin `optionsJson` 的 "never `options`"、★ agent `bodyMd` 的 "There is NO `systemPrompt`…"）挂在**字段条目**的 `mistake`
  上渲染在其字段行内，只有跨字段反例进「Common mistakes」，测试断言两者位置；★ `form` 的规则：**外层字段名不预带 `?`**
  （渲染器按 `required` 插入），片段内部描述子字段的 `?` 原样输出，并断言输出不含 `??`；其余节标题与契约测试锁住的句子逐字保留
  （★ 四个契约文件 218 条 `toContain/toMatch`，加 `docs-node-kind-coverage.test.ts` 共五文件 222 条，见 design §2）；32 KB 守卫
  不变，实现报告记录新旧字节数。
- **D9 守卫矩阵**：编译期四处 `satisfies Record` + 嵌套 / 变体子表；☆ AC-7 以普通测试文件
  `packages/backend/tests/intent-teaching-exhaustive.test.ts` 里的**八个** `// @ts-expect-error — <说明>` 夹具常驻
  `bun run typecheck`（`tsconfig` 已含 `tests/**/*`；仓内先例 `tests/rfc148-adt-contracts.test.ts:30-46`；★ 一律写成
  `const _x = … satisfies …` 声明并在 `test()` 里引用——`tseslint.configs.recommended` 的 `no-unused-expressions` 会拒绝裸
  `satisfies` 语句）：缺 kind / 缺 IntentResourceType / 缺 AclResourceType 三向 + 顶层扩字段（`ReviewNodeSchema.extend`）/
  嵌套扩字段（`ScriptOutputPortSchema.extend`）/ variant-only 扩字段（workgroup member agent 变体）三向 + 新增变体（mcp 第三个
  option）一向 + ★ 新增对象字段只登记父字段（`ReviewNodeSchema.extend({policy: z.object(…)})`）一向；运行期：字段覆盖（每个非 omit 字段名出现在该 kind/类型的渲染形态里）、passthrough
  AST 正反向扫描（含反向自检样本与初始集合基线）、★ 平台-intent 对账（逐层键比较 + 24/18 对象节点覆盖棘轮 + 三类反向自检）、
  能力地图互补 + 管理入口对照路由表、
  hint 三态（含第二轮仍在）、branchPorts 往返（落库 / 省略保留 / `[]` 清除 / 挂载后下一轮 dump 顶层）、`overrides` 负断言、
  runtimes 清单（header 有效默认与 `resolveRuntimeByName` 一致、无行合成、不含 binaryPath）、inventory 端口名、尺寸守卫、
  前端六处派生。
- **D10 落位**：新代码全部为 `modules/intent/domain/teaching/**` 纯域（只 import shared / zod 类型，无 DB / fs / actor），
  `services/intent/intentDoc.ts` 收成渲染装配层；不新建 `modules/intent/application`（避免半截迁移，与 RFC-294 W 波次
  对齐见 §7）。
- **D11 文档**：`docs/dev-gotchas.md` §新增 NodeKind 的「第 9 处不受编译器保护」改写为「第 9 处已由
  `INTENT_NODE_TEACHING` 编译器保护、字段级由 `intent-teaching-*` 测试保护」，并补「新增 ACL 资源类型要在 `platformMap.ts`
  声明立场」「validator 读 passthrough kind 字段一律走 `read*` helper，裸读不在反向扫描内」。
- **D12 门禁与交付**：设计门 r1～r11 已跑并收口（Codex + Claude 子代理，只审功能；r11 无 P1/P2）→ 用户批准 → 实现 →
  实现门 → 精确 pathspec 提交推送 → exact-SHA CI 绿后标 Done。

## 5. 能力影响清单（§RFC workflow 第 7 条）

本 RFC 不以安全为由收缩能力；以下为**功能**层面的既有行为变化，逐项呈用户确认：

| 项 | 既有行为 | 新行为 | 受影响面 |
| --- | --- | --- | --- |
| agent-single `overrides?` | `INTENT.md` 教该字段，模型可能输出；validator 与运行时都不读（RFC-115 已删） | 停教；模型不再输出。存量 workflow 定义里的 `overrides` 键不受影响（passthrough） | 无用户可见行为变化 |
| `POST /api/intent-sessions` 的 `hint` | 任意 ≤200 字符字符串，接受后静默丢弃 | 只接受六类枚举，其他值 422 | 前端 / e2e 只发六类，CLI / MCP 不发；外部 API 调用方若传自由文本会开始收到 422 |
| intent 更新带 `branchPorts` 的 agent | 分支端口被清空（bug） | 省略即保留，`[]` 才清除 | 用户可见：分支不再丢失 |
| 每轮 dump | 不读 runtime 注册表 | 每轮多一次 `listRuntimes` + `resolveRuntimeByName` 读与一次 agent 端口窄投影；读失败与其他 dump 查询同级 ⇒ 该轮 durable error turn | 运行期依赖多两项 |
| `inventory/agents.md` 行 | `handle name — description` | 追加 `inputs:[…] outputs:[…]` | doc 字节数上升（500 行上限内，仍受 32 KB 守卫） |
| 工作流编辑器 wrapper-loop 退出条件 | 下拉四种 | 五种（补 `port-inactive`）+ 帮助文案 | 用户可见：新增可选项 |
| ★ intent 更新 agent 的 `outputKinds / role / outputWrapperPortNames` | 显式 `frontmatterExtra` 时省略即删除 | 省略即保留；`{}` / `'normal'` / `{}` 才清除 | 模型历来回显这三项，行为面基本不变 |
| ★ intent 创建 / 更新 remote MCP 的 `oauth` | 不可写；update 强制沿用既有 | 可写（`clientSecret` 走 ‹secret› 槽）；update 省略仍沿用既有 | 用户可见：意图构建可配 OAuth 客户端 |
| ★ 每轮 dump | 只读六类 | 追加九类 platform-only 的只读清单（各自既有行加载 + `filterVisibleRows`） | 每轮多 ≤ 9 次读；读失败与其他 dump 查询同级 |

## 6. 验收标准

- **AC-1** 全权限 `INTENT.md` 对 `NODE_KIND` 中每个非 synthesized kind 含 `{id,kind:'<kind>'` 形态，形态文本包含该 kind
  注册表（含嵌套 / 变体子表）里每个非 omit 字段名；clarify / clarify-cross-agent 的 notes 含全部固定端口名；`code-round` 仍被
  点名为 withheld 而不被教。
- **AC-2** `INTENT.md` 含「Platform capability map」，逐条列出 `ACL_RESOURCE_TYPES − INTENT_RESOURCE_TYPES` 的九类
  （名称、用途、管理入口），并明示不可由 changeset 创建或引用；每个 `route` 型入口都能在前端路由表里找到匹配路由（测试）。
- **AC-3** 首轮 `hint='workflow'` 的会话，第 1 轮**与第 2 轮**的 `INTENT.md` 都含「Requested artifact type」一节且写明
  `workflow`；`hint` 省略时含 Auto 提示句；存量非枚举 hint 不渲染、不报错；段落含「follow the message」语义句（锁文本）。
- **AC-4** 通过 intent 创建带 `branchPorts` 的 agent 后，持久化的 `frontmatter_extra.branchPorts`（读出为
  `agent.branchPorts`）与提交一致；挂载该 agent 的**下一轮** dump 顶层含 `branchPorts`；不带 `branchPorts` 的 update 保留既有值；
  `branchPorts:[]` 清除；`branchPorts ⊄ outputs` 在 draft 校验期报错。
- **AC-5** `INTENT.md` 的 wrapper-loop 形态含 `continueOnMaxIterations` 与 `kind:'port-inactive'`，script 形态含 `branch`，
  mcp 行含 `timeoutMs`，agent payload 含 `permission`（带语法句，含 `'*'`）与 `branchPorts`；不含 `overrides`。
- **AC-6** `inventory/runtimes.md` header 写明有效默认（与 agent 启动同一语义 `resolveAgentRuntime(db, null, config.defaultRuntime)` 一致，格式 `Effective default: <name> (<protocol>)`；测试覆盖
  Intent Builder runtime ≠ 全局默认、默认名无 profile 行两种情形）与「只选 enabled 行」一句（锁文本），列出全部 profile 的
  name / protocol / disabled 标记，恰有一行标 `(default)`，不含 binaryPath。
- **AC-7** `packages/backend/tests/intent-teaching-exhaustive.test.ts` 里八个 `// @ts-expect-error` 夹具常驻
  `bun run typecheck`（缺 kind / 缺 IntentResourceType / 缺 AclResourceType；顶层扩字段 / 嵌套扩字段 / variant-only 扩字段 /
  新增变体 / 新增对象字段只登记父字段）；实现报告按 T7 程序附一次真实红屏（临时去掉一条指令或临时扩一个真实 schema）与恢复后的绿。
- **AC-8** 向六个平台 create schema 树中任一已登记对象（含 `McpRemoteConfigSchema`、`WorkflowInputSchema` 家族、各 strict node
  schema）追加一个未登记键，或新增一个未登记的嵌套对象 ⇒ `intent-teaching-reconciliation.test.ts` 红；T1.2 之后的源码下
  该测试绿（`oauth` / 裸 handle skills / `nodes[].position` 等既有差异均已登记）。
- **AC-9** `rfc234-intent-doc.test.ts`、`intent-doc-validator-contract.test.ts`、`intent-privileged-node-capability.test.ts`、
  `rfc291-unavailable-mount.test.ts`、`docs-node-kind-coverage.test.ts` 不修改既有断言即保持绿（新增断言除外）。
- **AC-10** 前端创建器选项数 = `INTENT_RESOURCE_TYPES.length + 1`（Auto）；六处（D6）不再含手打六类 union / 数组；
  `/intent?hint=<第七类>` 解析走 roster（测试以 roster 派生的夹具覆盖）。
- **AC-11** `INTENT.md` 全权限字节数 ≤ 32 KB（守卫不变），实现报告记录新旧字节数。
- **AC-12** exact-SHA Main CI 全绿。
- **AC-13** `inventory/agents.md` 每行含该 agent 的 `inputs` / `outputs` 名；无端口的 agent 渲染 `outputs:[]`；端口投影恰对
  截断后的 id 集合执行一次。
- **AC-14** validator 临时新增一处 `readNumber(node, 'zzzFake')`（含放在条件表达式里）或 `workflowLaunchInputs.ts` 临时新增一处
  `numberField(def, 'zzzFake')` ⇒ `intent-teaching-registry.test.ts` 反向扫描红；反向自检样本常驻。
- **AC-15** 编辑器 wrapper-loop 退出条件下拉含 `port-inactive`，帮助文案含其说明（组件测试）。
- ★ **AC-16** `inventory/platform/<type>.md` 九个文件存在，只含 actor 可见的行（与对应 REST 列表同一判据，测试以两个 actor 对照），
  无 handle，超 200 行截断标注；模型对这些行发 `requests` / op 仍被六类枚举拒绝。
- ★ **AC-17** 通过 intent 创建带 `oauth:{clientId, clientSecret:'‹secret›', scope}` 的 remote MCP：确认 UI 出现 `clientSecret` 槽，
  落库值为槽里填的真值；非哨兵字面量被拒（沿用既有诊断 `intent-secret-value-forbidden`，r12 P3 校正）；`oauth:false` 落库为 `false`；update 省略 `oauth` 保留既有；
  dump 投影 `clientSecret` 为 ‹redacted› 且其余 oauth 字段可见。
- ★ **AC-18** intent 更新省略 `outputKinds / role / outputWrapperPortNames` 时三者保留既有值；显式 `{}` / `'normal'` 清除。

## 7. 与 RFC-294 的关系

- bounded context：`intent`（RFC-294 design §2 物理结构 `modules/intent/`，当前状态「pure domain seed」1 文件）。
- 本 RFC 承担的演进：把「意图教学知识」从 `services/intent/intentDoc.ts` 的字面量抽成 `modules/intent/domain/teaching/**`
  纯域注册表（domain 层：不 import `@/db` / `node:fs` / `@/routes` / `@/ws`，符合
  `tests/architecture/rfc294-review-module-layer-rules.test.ts` 的 domain 禁令）；`services/intent/intentDoc.ts` 退化为
  渲染装配（services 过渡层），`turnEngine.ts` 只增加 hint 读取与 runtimes / 端口投影函数注入。
- 与 RFC-345（W4-C，In Progress）的重叠：其 §4 预计范围含 `services/intent/**`、`intent/dumpBuilder.ts`、
  `modules/task-execution/**`；本 RFC 对这些文件的改动按 D7 分「必做需协调」与「可跳过」两档，T1 / T2 / T6 不与之重叠可先行。
- 留下的债：intent application / engine 层仍未成形（RFC-294 W 波次未授权），`turnEngine` 仍在 `services/`；5 种
  passthrough kind 无 typed schema。均记入 design §10，不倒签任何 W 波次。

## 8. 设计门记录

- **r1（2026-08-30）**：Codex `codex exec --sandbox read-only`（12 条：7 P1 / 4 P2 / 1 P3）+ Claude 子代理（11 条：1 P1 /
  5 P2 / 5 P3），prompt 均限定只审功能。逐条对源码核实后：22 条属实并折入 r2（含 1 条既有数据丢失 bug、3 处错误锚点、
  1 处错误路径、3 处漏列前端手抄点、hint 语义与 D33 相反、嵌套字段守卫缺口、zod 类型 helper 缺口、AC 证据矩阵缺口）；
  1 条部分不成立（「dump 经 `frontmatterExtra` 间接带出 branchPorts」——实为完全不带，已改写）。
- **r2（2026-08-30）**：Codex 复核 r1 闭合（11 项 resolved、8 项「闭合方式有误」）+ 9 条新 findings（4 P1 / 4 P2 / 1 P3）。
  全部核实属实并折入 r3：`keyof` 联合取交集（→ 分配式 `KeysOf` + 按变体子表 + 三向扩字段夹具）、workflow `unknown`/passthrough
  与 workgroup member 结构差异（→ 路径级对账 + `delegated` 部件表 + 逐路径映射）、端口投影数据路径（→ 投影移入 dumpBuilder、
  注入函数）、AC-7 负例不持久与 T7 不在依赖链（→ 六个常驻夹具、T7 进链）、默认 runtime 解析语义（→ `resolveRuntimeByName`）、
  反向扫描语法（→ AST + 初始集合基线 + allowlist）、`'*'` 通配键、`systemPrompt` 反例归位、计数 218/222 与 `form` 规则措辞。
- **r3（2026-08-30）**：Codex 复核 r2 闭合（7 项 resolved、2 项「闭合方式有误」）+ 6 条新 findings（3 P1 / 2 P2 / 1 P3）。
  全部核实属实并折入 r4：workflow input 四种 passthrough kind 的扩展字段面（→ `WORKFLOW_INPUT_TEACHING` 的 `base + extra` 表 +
  launch / picker 读点 + AST 反向扫描）、对账路径代数无法表达 agent `skills` 联合 / 平台 workgroup member 单对象 / `outputs`
  通配根（→ 路径代数定义 + `adapters` + `normalizePlatform` + `outputs*` 根）、mcp remote `oauth` 未登记（→ 排除项 + doc 提示句）、
  变体表不穷尽（→ `VariantValues` 键控 + 新增变体夹具）、默认 runtime 的传递路径（→ `IntentTurnConfig.effectiveDefaultRuntime`
  经 dispatcher 透传）、T7 红屏程序与依赖图（→ 去指令 / 扩 schema 取证、`T2/T3 → T7` 边）。
- **r4（2026-08-30）**：Codex 复核 r3 闭合（4 项 resolved、2 项「闭合方式有误」）+ 4 条新 findings（1 P1 / 2 P2 / 1 P3）。
  全部核实属实并折入 r5：路径集合对账在今日源码上仍对不齐（→ 改为逐层键比较 + 对象级覆盖棘轮，叶子类型差异明确归 resolve
  seam）、input 反向扫描无法证明字段归属（→ `INPUT_FIELD_OWNERSHIP` 三向互锁，基线只含七个可扫出的名字）、裸 `satisfies`
  夹具会被 `no-unused-expressions` 拒绝（→ 声明式写法）、AC-7 计数与红屏诊断措辞（→ 七个；去指令 vs TS2578 分述）。
- **r5（2026-08-30）**：Codex 复核 r4 闭合（2 项 resolved、2 项「闭合方式有误」）+ 对 24 个平台 / 17 个 intent 对象节点逐一
  walk + 5 条新 findings（2 P1 / 2 P2 / 1 P3）。全部核实属实并折入 r6：entry 缺 intent 路径与键视图、workgroup 需按变体映射、
  call 节点的 `workflowRef/workgroupRef` 需登记 intentOnly（→ entry 形状重定义、`variants`、strict 视图剔除通用引用键、
  `WORKFLOW_PORT_REF_TEACHING`）；`presentation/agentKind` 两个前端派生字段（→ 归属表 `authorable:false`）；D9 / §9 / T2.8
  残留 r4 算法文案（→ 全部改写）；计数与基线（→ 24 / 17 / 9 / 28，`nodes[].position` 入基线，「T1.2 之后为绿」）。
- **r6（2026-08-30）**：Codex 复核 r5 闭合（4 项 resolved、1 项「闭合方式有误」）+ walk 复核（无未认领，3 处重复认领）+ 5 条
  新 findings（1 P1 / 2 P2 / 2 P3）。全部核实属实并折入 r7：agent `skills` project 对象与 skill `files[]` 元素缺编译子表（→ 补
  `KeysOf` 子表 + 渲染断言）；`asIntentResourceType` 不接受自由文本（→ `z.enum(...).safeParse`）；disabled runtime 被教成可选
  （→ 教学句 + 文件头 + 锁文本）；review `inputSource` 示例未复用统一 PortRef 表（→ `WORKFLOW_PORT_REF_TEACHING`）；键视图措辞
  （→ `agentRef` 归 renamed、`workflowRef/workgroupRef` 归 intentOnly）；`agentKind` 归属补 upload 并固定前端扫描文件清单；
  uncovered 表去掉重复认领。
- **r7（2026-08-30）**：Codex 复核 r6 闭合（5 项 resolved、2 项「闭合方式有误」）+ walk 干净 + 4 条新 findings（2 P1 / 1 P2 /
  1 P3）。全部核实属实并折入 r8：`keyof never` 退化（→ `KeysOf` 终止分支只让 ZodObject 贡献键）；`nested` 可选导致新增对象字段
  只登记父字段可过编译（→ `TeachingFieldsOf<S>` 按字段 zod 类型条件化、对象字段强制 `nested`，第八个夹具）；plugin / workflow /
  skill 根表未受 schema 约束（→ 两张注册表的 `satisfies` 目标改为由 schema 派生的 mapped type）；前端扫描清单漏 `InputEdit.tsx` /
  `tasks.new.tsx` 等（→ 创作面 + 启动面固定清单、每文件 ≥1 命中、总集非空、第三份基线）；「T1」→「T1.2」。
- **r8（2026-08-30）**：Codex 复核 r7 闭合（3 项 resolved、3 项「闭合方式有误」）+ walk 干净 + 3 条新 findings（2 P1 / 1 P2），
  全部指向 §1.1 类型草图能否编译（`IntentVariantTeaching` 参数个数、`Omit` 误作用在 schema 实例、`Record<never,never>` 挡不住
  多余键、mcp 根变体表）与前端扫描清单的旧文案。r9 不再改草图，而是**写真实探针用 `tsc 5.9.3` + `zod 3.25.76` 对仓内 schema
  编译**：零错误；八个 `@ts-expect-error` 负例均为真错误；三处变异（object 字段去 `nested` / 删 `optionsJson` / 删 remote
  `timeoutMs`）分别 TS2322 / TS2741 / TS2741（r10 增至五处，见 `type-probe.md`）。验证过的定义原文替换 design §1.1；mcp 根改按变体表；`code-round` 无 `fields`；
  前端扫描清单统一为九文件。
- **r9（2026-08-30）**：Codex 复核 r8 闭合（1 项 resolved、2 项「闭合方式有误」——design 里残留旧版 `IntentVariantTeaching<V>` 声明、
  `code-round` 的 `fields: {}` 旧示例与 §1.3 旧 `satisfies` 写法，与新 §1.1 矛盾）+ walk 干净 + 3 条新 findings（0 P1 / 2 P2 / 1 P3）：
  探针缺 `fieldSources` 合同、T1.6 的 `⊄ outputs` 测试早于 T5.4 的透传、r9 记录漏列附件。Codex 亦独立把探针扩到全部 8 种 strict
  kind + 两个 intent-only 引用 + 模拟 T1.2 后的 agent schema，编译干净。r10：旧声明与旧示例全部清除；`fieldSources` 合同写入
  §1.1 与探针（变异 D/E 均红）；`⊄ outputs` 测试移到 T5.6；记录列出四个文件。
- **r10（2026-08-30）**：Codex 复核 r9 六项全部 resolved + walk 干净 + 4 条新 findings（0 P1 / 2 P2 / 2 P3）：探针的 availability
  与 §1.1 不完全相同且只映射 3 种 strict kind、proposal / plan 残留旧类型词汇（`IntentVariantTeaching<VariantValues<…>>`、
  `IntentNodeTeaching`）、清单漏 `nodes[].position`、门史措辞。r11：探针扩到全部 8 种 strict kind 并与 §1.1 逐字一致
  （`AuthorableAvailability` 排除 synthesized-only），零错误、五处变异均红；词汇与清单修正。
- **r11（2026-08-30）**：Codex 复核 r10 四项（3 resolved、1 项因探针缺三个 `export` 与一处旧注释判「未逐字一致」）+ walk 干净 +
  2 条 P3（已清：探针补 `export`、注释改为「8 strict + 5 passthrough + code-round」，重编译零错误、五处变异仍红）。**结论：无
  P1/P2，可交用户批准。** 十一轮累计 58 条 findings 全部核实折入。
- **用户批准（2026-08-30）**：批准 D1～D12 并授权实现 + 精确 pathspec 提交推送；三项另裁均选非推荐项——① 三个 sidecar 也
  「省略即保留」；② mcp remote `oauth` 可创作；③ 九类也列真实行。r12 据此修订 D2 / D3 / D5、§5、AC-16～18 与 design / plan；
  修订部分再过一轮只审功能的 Codex 门（r12）后进入实现。
- **r12（2026-08-30，只审三项另裁修订）**：Codex 5 条（2 P1 / 2 P2 / 1 P3），全部为实现层与文案一致性问题、无方向性异议，已折入实现：
  ① `applyChangeset.ts` 的 oauth 沿用改为「仅 `oauth === undefined` 时沿用旧值」，显式 `false` / 对象替换（`tests/intent-mcp-oauth.test.ts` 三态往返）；
  ② employee_tool 清单：DB 注册工具按（类型包 authoring manifest 的 workItemRef）逐对 `listTools`，再合并 `composeDigitalEmployeeBuiltinToolCatalog`
  的平台内建工具（与 `server.ts` 同一组装）；bootstrap 注入的 `IntentPlatformInventory` 端口就位（见 design §10 第 3 条的债）；
  ③ 九类逐一投影器（capability_template 直接 name/description；digital_employee / automation_policy / action_template / verification_profile
  用 published/draft 状态、action_template 附 capability；development_adapter 用 purpose；employee_definition 用类型；job template 用
  draft.description；tool 用 content.displayName/description + workItemRef）；④ 文档计数统一 24/18/9/29、oauth 措辞、debts 3/5/6 改写、
  type-probe 标为历史附件；⑤ 诊断名沿用 `intent-secret-value-forbidden`。
- **实现门 r1（2026-08-30）**：Codex 6 条（0 P1 / 4 P2 / 2 P3）全部折入（runtimes 清单按 §4 格式 + protocol、loader 失败整轮 durable error、
  `clientSecret?` 可选、Reference rules 段迁入渲染器并类型化查表、hint 批准版文案、AC-16 九类表驱动 + 工具合并测试）；细节见
  `verification-report.md` §5。实现门 r2～r5 再折入 11 条（r2 draft 期 branchPorts 校验 + 端口投影调用锁；r3 根级 outputs 形态 + 文档同步 + never 守卫；r4 intentDoc 零字面量 +
  文档残留；r5 delivery-budget 迁渲染器 + 源码锁反转义 + 三处文档），**r6 0 findings，实现门通过**；六轮共 17 条，0 P1。
