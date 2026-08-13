# RFC-295 技术设计

## 1. 现状与权威边界

### 1.1 persisted inventory、active projection 与 stable sink family

两份 shared collector 是“持久化字符串可能含 template”的权威 inventory：

| inventory              | 真值位置                                                 | 已声明 persisted surface                                                                                                                            |
| ---------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow definition    | `packages/shared/src/workflowTemplateSurfaces.ts:42-103` | Agent `promptTemplate`；CallWorkgroup `goalTemplate`；Review `commentInjectTemplate`；CodeHost 全部存量 `params.*` 与 request path/query value/body |
| Webhook launch payload | `packages/shared/src/webhookTemplate.ts:146-180`         | workflow text mapping + `workingBranch`；agent `description` + `inputs.*` + `workingBranch`；workgroup `goal` + `workingBranch`                     |

它们不等于任何时刻的可见 UI 控件数：CodeHost schema 会保留旧 action/provider 的 `params`/`request`，
而 inspector 只显示当前 action。因此本 RFC 明确分为两层：

1. **persisted inventory**：继续用于 workflow migration/diff，保证非 active 值不丢失且旧 token 仍能迁移；
2. **active projection**：新增 shared 纯函数，根据 node kind + CodeHost action/provider/action registry 得出当前
   真正可编辑/会执行的 target。frontend target builder、workflow validator、Intent authoring validation、trigger
   dependency/preflight 与 direct executor defense 共用这一 projection。

Workflow 已有稳定 `WorkflowTemplateSink` union。Webhook 补等价 `WebhookTemplateSink`（workflow-input-text、
working-branch、agent-description、agent-input、workgroup-goal）并写入每个 surface。权威对账 key 为
`(domain, launchKind?, sink)`，不用 dynamic pointer/实例数。frontend adapter registry 对该 union 使用
`satisfies Record<AuthorityKey, TargetAdapterFactory>`，且实际 target builder 必须通过 registry 生成，不再有可与
shared 一起漂移的第三份手写 allowlist。

CodeHost active projection 是 total discriminated result，不是只处理 happy-path 的数组：

```text
valid-preset   = registry 中该 action/provider 支持的 params；request 全 inactive
valid-custom   = request.path/query-values/body；全部 params（包括 registry 的 PROJECT）inactive
unsupported    = structured unsupported error；active=[]
invalid-action = structured invalid-action error；active=[]
```

它遍历完整 `CODE_HOST_ACTIONS × provider`，先判 action/provider，再收集 active refs。workflow validator、Intent
authoring validation、trigger dependency/preflight、frontend builder 与 direct `executeCodeHostCall` defense path 共用
相同判别顺序；invalid/unsupported 首先报告 action 错，不能被隐藏 token 抢成 `trigger-context-missing`。migration/diff
与 Intent diff preview 仍使用 persisted inventory。CodeHost 切 action/provider 不自动删非 active 值；inspector 会列出
非 active 存量 path 与“当前不执行”说明，允许显式清理或切回修改；它们不获得 picker，也不再引发当前 action 的
template validation/trigger preflight。

两份 inventory 与 active projection 不包含 CodeHost query key、Script body、Clarify/Review 普通描述、
git/enum/files/upload workflow mapping 等字面或语义输入。棘轮以 stable authority family + canonical fixtures 为输入，
不以 `rg '{{'` 或 dynamic pointer exact equality 为准。

### 1.2 当前实现的结构性缺口

| 现状                                                        | 位置 / 后果                                                                                               |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `TemplateVarChips` 把每个 token 渲染为常驻 button，组全展开 | `packages/frontend/src/components/TemplateVarChips.tsx:90-194`；原始 token 是唯一可见名，解释只在 `title` |
| `eventTypes === undefined` 会列出所有 Webhook 变量          | `TemplateVarChips.tsx:31-49,115-147`；workflow inspector 因此平铺 30 项                                   |
| Agent 无条件渲染 Webhook chips                              | `AgentSingleEdit.tsx:103-126`；本地入边 `PortRefList` 还排在长列表之后                                    |
| Review 平铺两套变量                                         | `ReviewEdit.tsx:484-522`；builtin 与 Webhook 没有共同分类/搜索                                            |
| CodeHost 有三个 token writer                                | `CodeHostCallEdit.tsx:404-496,692-802`；select target 不注册 ref/focus，Advanced chips 无法写入           |
| Webhook workflow mapping 猜测目标                           | `TriggersPanel.tsx:746-769,1106-1183`；未聚焦时静默写第一个 text mapping                                  |
| Webhook Agent `inputs.*` 只保留不编辑                       | `TriggersPanel.tsx:107-113,143-210`；与 shared webhook inventory 不对称                                   |

### 1.3 现有可保留的底层能力

- `insertAtCursor` 与 `applyTemplateVarInsertion`
  (`TemplateVarChips.tsx:20-88`) 已处理选区替换、commit 后 `requestAnimationFrame` 恢复光标，并在焦点
  已进入其它 `input`/`textarea` 时让位。公共 text target adapter 保留这些光标机制，同时把“用户已有新意图”
  扩展到任意其它 focusable/control/contenteditable，不随 chip UI 删除，也不沿用旧 helper 的窄焦点判定。
- `Select` 已有 portal、search、description/group、keyboard、IME 和 nested Escape 的实现先例；新组件复用其
  行为/CSS 抽象，但不使用 `value=""` 伪装成持久 Select。
- `ManagedLiveRegion` 已在 workflow editor 树上可用；公共 picker 通过注入的 announce callback 与不在该树上的
  Webhook 表单复用等价 live region。
- `WEBHOOK_TEMPLATE_VARS`、`WEBHOOK_VAR_GROUPS` 与 event availability 保持唯一 Webhook 字段/分组真值；
  新 catalog 只做结构包装与本地化展示。
- `BUILTIN_VARS` 是 Agent prompt 认可的内置 token 集，但 CallWorkgroup 的实际 producer 只是其中子集，
  当前可用性分散在 renderer 的对象字面量中。实施时把名称/分类/surface producer 合为 shared typed descriptor，
  `BUILTIN_VARS` 与 CallWorkgroup producer key set 从它派生/做编译期穷尽，不在 frontend 复制第三份名单。

## 2. 目录模型

### 2.1 稳定结构与本地化分离

在 frontend 建立纯数据目录模型；它不做 runtime parsing/rendering：

```ts
export type RuntimeParameterBranchKind = 'scope' | 'type' | 'source' | 'functional-group'

export type RuntimeParameterBranch =
  | {
      kind: 'branch'
      branchKind: 'source'
      id: string
      label: string
      description: string
      children: RuntimeParameterNode[]
    }
  | {
      kind: 'branch'
      branchKind: Exclude<RuntimeParameterBranchKind, 'source'>
      id: string
      label: string
      description?: string
      children: RuntimeParameterNode[]
    }

export type RuntimeParameterLeaf =
  | {
      kind: 'parameter'
      id: string
      token: string
      rawName: string
      label: string
      description: string
      aliases: string[]
      availability: 'available'
    }
  | {
      kind: 'parameter'
      id: string
      token?: string
      rawName: string
      label: string
      description: string
      aliases: string[]
      availability: 'unavailable'
      unavailableReason: string
    }

export type RuntimeParameterNode = RuntimeParameterBranch | RuntimeParameterLeaf
```

稳定 id/path 使用不本地化字符串：

```text
global/trigger/webhook/context/comment_text
global/trigger/webhook/api/project_id
global/runtime/task/repository/__repo_path__
global/runtime/task/identity/__task_id__
local/input/upstream/ports/artifact
local/context/review/iteration/__review_comments__
```

组件只消费树，不写死 `webhook` 或固定层数的 JSX。公共 builder 校验：

- sibling id/path 唯一；
- available leaf `token`、所有 leaf 的 `label`/`description` 非空；
- static/global provider 的同一 catalog canonical token 不重复；
- unavailable leaf 必须有可见原因；
- `source` branch 必须有本地化非空 description，中英与假 scheduler provider 也不例外；
- branch 不能直接携带 token。

平台内置 global provider 的重复 path/空文案/非 canonical token 是程序错误，可以 fail 该 source。
用户数据派生的 local provider 必须逐项隔离：一个无法转成 template ref 的端口不能让其它 local leaf
或全部 Webhook source 消失。

### 2.2 全局 Webhook provider

`buildWebhookRuntimeParameterSource({ eventTypes, t })` 必须：

1. 从 `WEBHOOK_VAR_GROUPS` 生成 `context` / `api` leaf，不复制 30 字段列表；为延续旧作者面的快速发现，
   `context` 内仅在展示排序中把 `event_json` 置顶，字段归属、availability 与 canonical set 仍完全来自 shared；
2. `eventTypes` 未提供时生成全量，用于 workflow resource 作者面；
3. `eventTypes` 已提供时按 shared availability 交集过滤，用于 Webhook rule 表单；
4. 从 i18n 取 source/group/field 可读名与解释，canonical token 仍由 shared helper 生成；
5. source description 明示“仅由 Webhook 启动时提供”，每个 event-specific leaf 的解释包含其可用事件类型。

`zh-CN` / `en-US` 增加 typed `label` map，保留已有 typed description map。完整性测试对两种语言同时与
`WEBHOOK_TEMPLATE_VARS` 做 exact set equality，防止新字段回退到 raw id/tooltip-only。

### 2.3 全局 runtime/task builtin provider

新增 shared typed `RuntimeBuiltinParameterSpec`（准确命名可随现有 shared 风格调整），至少声明 stable name、
functional group、合法 surface，以及 **per-surface** semantic description/format key。共同语义可以复用 base 文案，
但 Agent prompt 与 CallWorkgroup goal 的 workspace/identity/格式不同必须显式 override。`BUILTIN_VARS` 从 Agent-prompt descriptors 派生；
CallWorkgroup goal 的 producer key 使用 descriptors 派生的封闭 union + `satisfies Record`，防止 catalog 声称有值、
runtime 却永远落空。provider 规则：

- Agent prompt 提供 renderer 认可的非 deprecated builtins，按 repository / identity / iteration / review /
  clarify 分组；review/clarify 条目说明“仅对应迭代/续问上下文有值，否则为空”，不伪装成恒有值；
- CallWorkgroup goal 只提供 runtime 实际构造的 repository / identity / iteration 子集，不因 validator 今天接受
  `BUILTIN_VARS` 就展示没有 producer 的 review/clarify 项；文案明确 repo path 指向 child iso workspace、task/node
  identity 指向 caller，`__repos__` 是 `- name: isoPath` 列表、`__repo_names__` 是 comma + `(root)` 格式；
- Agent 对应文案明确 `__repos__` 是 newline worktree paths、`__repo_names__` 是 newline mount paths，并逐项说明
  review/clarify 条件上下文；不能复用 CallWorkgroup 的格式文案；
- Review comment injection 继续只通过 local review-context provider 提供 `__review_comments__`；CodeHost 和
  Webhook launch payload 不注册 runtime/task source；
- retired `DEPRECATED_PROMPT_TOKENS` 永不进入 picker；存量 token 的兼容/警告行为不变。

每个 builtin leaf 同样具有本地化 label、canonical token、常显 description 与 source description。目录路径固定为
`global/runtime/task/<functional-group>/<field>`；新增 builtin 未补 descriptor/i18n/surface policy 时 exact-set 测试变红。

### 2.4 surface-local provider

局部条目不注册成全局 parameter type：

- Agent/CallWorkgroup/CodeHostCall：从当前可达入边端口生成 `local/input/upstream/ports/*`，可读名使用端口名，
  解释包含上游节点/端口、数据类型和已有 description；
- Review：只注册 `local/context/review/iteration/__review_comments__`，不枚举其它 `BUILTIN_VARS`；
- Webhook rule：没有节点入边 local provider，只提供经 eventTypes 过滤的 global Webhook source。

动态入边的细则：

- 同一 target port 有多条入边时合并为一个 leaf，source 列表合并进 description，不触发 token 重复错误；
- `review-body`、三段 dotted name、伪装 `trigger.webhook.*`/保留 namespace 等不能形成 local ref 的端口可作为
  focusable `aria-disabled` leaf 显示“端口名不能作为模板参数”，但不提供 insertion action；
- 一个坏 local leaf + 一个正常 leaf + Webhook source 的组合必须仍能打开/搜索/插入后两者。

所有 local leaf 也逻辑上完整经过 `type -> source -> functional group -> field`；singleton compression 只减少点击，
不省略 breadcrumb/稳定 path。这样未来出现第二类 local source 时无需重塑目录。

### 2.5 未来 source 扩展门

中央 provider registry 接受 surface source-policy：workflow inspector 请求“当前已实现且对该 sink 合法”，
Webhook rule 显式请求仅 `trigger/webhook`。测试 fixture 注册第二个 `trigger/scheduler` source，
锁定树导航、搜索、breadcrumb 与现有 workflow inspector 零修改，同时断言 Webhook policy 下 scheduler 不可见。
生产 catalog 在以下合同全部存在前不得注册 scheduler：

- shared `TriggerContextSchema` 允许 `trigger.scheduler`；
- template-ref parser/valid union 认可 source/field；
- trigger dependency collector/evaluator 保留 source identity，preflight/error metadata 不再假定所有 trigger 都是 Webhook；
- 任务启动原子写入、resume/replay/preflight 与 renderer 具有对称生命周期；
- 可用字段、文字语义和隐私/导出边界有独立批准。

## 3. 公共选择器

### 3.1 交互结构

`RuntimeParameterPicker` 由一个字段旁触发 button 和 portal popover 组成：

1. 打开后默认显示根分类（例如“当前节点”、“全局参数”），不直接展开 30 个 Webhook leaf；
2. 逐级进入 type/source/group，顶部显示 back action 和 breadcrumb；连续 singleton branch 可自动压缩点击，
   但 breadcrumb 仍展示完整分类，当未来出现 scheduler sibling 时 source 层自然恢复可选；
3. 搜索不受当前层级限制，返回叶节结果，每行带完整 breadcrumb；
4. leaf row 展示 label、token、description；若 provider **显式返回** unavailable leaf，该行禁用并
   显示 reason，不静默消失。Webhook `eventTypes` provider 保持既有交集过滤语义，不可用事件字段不进入
   可选 catalog，并由 source/empty state 说明当前事件过滤；
5. 执行 leaf action 后关闭，下次打开回到根层和空搜索，避免上次 Webhook 导航状态继续干扰下一字段。

这是 action picker，没有受控 `value`/selected checkmark。trigger 声明 `aria-haspopup="dialog"`、
`aria-expanded`、`aria-controls={popoverRootId}`；portal root 就是该 id，使用 `role="dialog"`、
`aria-modal="false"` 和“向 <target> 插入参数”的可访问名。这一 ownership 使外层 `Dialog` 的 focus trap
能把 body portal 视为子层。

trigger 使用 `aria-haspopup=listbox`；弹层内搜索框声明有独立 label、`controls` 与 active descendant 的
combobox，分类和 leaf 都是同一 listbox 内的 action option。Arrow/Home/End 按稳定 path 移动 active option。
每行 accessible name 是 breadcrumb + localized label，可见 token/description 通过 `aria-describedby` 关联；
不把整段说明重复塞入 name。

当 async provider/eventTypes 让 catalog 重排时，active row 按稳定 path 重解析，不保存数组 index。
当前 path 消失时回退到最近仍存在的祖先/首个可用行，旧 Enter 事件不得提交移到该 index 的另一 token。

### 3.2 搜索标准化

纯函数将查询和条目转换为 NFKC + locale-aware lowercase，并对 token 同时索引完整形式、去掉
`{{ }}` 形式和 dotted path。搜索字段：

- localized label；
- raw field/source/type/group id；
- canonical token；
- description 与 aliases；
- 完整 localized/raw breadcrumb。

空结果显示“没有匹配的运行期参数”及当前过滤条件；Webhook eventTypes 为空时明示先选择事件类型，
不渲染一个无解释的空弹层。

### 3.3 target adapter

业务调用面不向 picker 暴露任意 DOM 写入，而是提供封闭 adapter：

```ts
export interface RuntimeParameterTargetSnapshot {
  targetId: string
  revision: string | number
  value: string
  selection: { start: number; end: number; direction: 'forward' | 'backward' | 'none' } | null
}

export interface RuntimeParameterTarget {
  mode: 'insert-at-caret' | 'replace-whole-value'
  targetId: string
  targetLabel: string
  capture(): RuntimeParameterTargetSnapshot
  readCurrent(): {
    targetId: string
    revision: string | number
    value: string
    element?: HTMLElement
  } | null
  validateNext?(nextValue: string, snapshot: RuntimeParameterTargetSnapshot): string | null
  commitIfCurrent(
    snapshot: RuntimeParameterTargetSnapshot,
    nextValue: string,
  ): { ok: true } | { ok: false; reason: 'stale' | 'unmounted' | 'invalid'; message: string }
}
```

`insert-at-caret` 的 selection 不相信“从未聚焦的 input 默认 0”。target field 在 focus/select/blur 时维护
最后有效选区；pointerdown、keyboard open 或 screen-reader synthetic click 都通过 `capture()` 取同一快照。
没有该 target 的有效历史选区时才追加到末尾。`replace-whole-value` 用于 CodeHost 业务 Select，
完整 token 直接替换当前值；触发器旁 hint 与 target banner 都说明影响。

执行 leaf 前先按 `targetId + revision + value` 重读。undo/redo、远端同步、异步保存回流、CodeHost row 删除/
重排、Webhook target/eventTypes 切换或 unmount 使快照变 stale 时，不计算/不提交新值，保持弹层并显示
“目标已变更，请重新打开”。一次成功参数写入产生一个 atomic history/undo boundary；Escape/outside/Tab/
失败都是 0 value patch、0 history/autosave。

history owner 由调用域明确提供：Workflow inspector 的 picker commit 以 `atomicNodeInspectorChange` 进入既有 canvas
history，现有 Undo/Redo 按钮与快捷键回退/重做整次 token 插入。Webhook Dialog 没有 canvas history，因此整个
controlled draft 只允许 **一个** history owner：dialog-session draft transaction stack。表单内可见 Undo/Redo actions、
`Cmd/Ctrl-Z`、`Cmd/Ctrl-Shift-Z`/平台 Redo，以及文本控件发出的 `beforeinput[inputType=historyUndo|historyRedo]`
只在 **已注册的 Webhook draft target** 上路由到该 stack 并 `preventDefault`；不得再让浏览器原生 text history 与
dialog stack 同时改同一份 rule draft。picker searchbox、Select typeahead/filter、临时 rename search 等 ephemeral editor
不注册为 draft target，其 Undo/Redo 只改本地临时值并阻止冒泡到外层 shortcut handler，不能撤销被弹层遮住的 rule
draft；关闭 picker 后，焦点回到外层 draft/非 ephemeral 区域时 shortcut 才操作 dialog stack。reducer 应用 history
snapshot 时带 reentrancy guard，不把 Undo/Redo 自身重新记成 transaction。

受控文本编辑使用明确的 focus-session transaction：focus/首个 `beforeinput` 捕获字段 baseline；同一字段同一 focus
session 内连续 input、paste 与 IME composition 只更新一个 pending transaction 的 working snapshot；
`compositionend` 只收口 working snapshot，不另建 entry。blur 到其它字段/控件、打开 picker、执行 repair、点击可见
Undo/Redo 或发起 Save 前先提交 pending entry；快捷键 Undo 遇 pending entry 时先提交再整项撤销。picker 插入与批量
repair 各自始终是 atomic boundary，不能与相邻 typing transaction 合并；打开 picker 时先保留当前 selection、收口
pending typing，再用收口后的 `targetId + revision + value` 创建 insertion snapshot。Undo 后首次接受的新用户 mutation
立即截断 Redo；Save 失败保留 stack，Save 成功才以 saved snapshot 重置，Cancel/unmount 丢弃，切 rule/target 经 D7
确认后建立新 session boundary。composition 尚未结束时 history shortcut 只被拦截并给出 live 提示，不提交半个字。

因此 `bulk repair -> 在 rule name 连续输入 BC -> Undo -> Undo` 必须先把整次 name focus-session 恢复到输入前，
再恢复 repair 的 exact target payload；两次 Redo 对称。可见 actions、快捷键与文本内触发路径观察到同一栈和同一结果。

`validateNext` 用于 sink-specific 预检：CodeHost JSON body 在插入前对 next value 运行
`codeHostJsonBodyIssue`。光标在空 body、object key 或非字符串位置时保持 picker 打开，说明“先把光标放入
JSON 字符串值”，不制造立即无法保存的 definition。

禁用态包括权限不足、保存中、目标不支持、或业务表单未满足必要前置。禁用触发器必须有可见 hint/
`aria-describedby`，不依赖 disabled button tooltip。长期 unavailable 项使用 focusable `aria-disabled="true"` + action guard，
让键盘/读屏用户能读原因；仅 saving/权限等硬 pending 态使用 native disabled，原因在按钮外按顺序可读。

### 3.4 Field action 布局

`Field` 新增向后兼容 `action` + `controlId` 路径：使用时 wrapper 是 `<div>`/group，标题行内独立
`<label htmlFor={controlId}>` 和 action slot，不再用默认外层 `<label>` 包住 input + button。每个目标 input/textarea/select
有唯一 id，picker 触发器名为“向 <Field label> 插入参数”，同页多 mapping 不产生一串无法区分的
“插入参数”按钮。

### 3.5 键盘、IME 与 focus

- Enter/Space 在 trigger 上打开；打开后搜索框取得焦点；
- Arrow/Home/End 在当前 action options 间移动，跳过 heading/description；Enter 进入分类或执行 leaf；
- Escape 仅关闭 picker，`preventDefault`/事件屏蔽与外层 Dialog 合同对齐，焦点返回 trigger；
- Tab/Shift+Tab 阻止 body portal 的原生顺序，关闭后以 trigger 在所属 Dialog/document 的逻辑 tabbable
  位置为锚，显式聚焦后一/前一个外层控件；不建立第二个 focus trap；
- composition 期间 Enter/arrows 不执行 picker action。composition Escape 允许 IME 取消候选，但子层必须
  `stopPropagation`，外层 `Dialog` 也防御性忽略 `isComposing` Escape，picker/dialog/draft 都保持；
- 成功写入宣告“已将 <参数名> 插入到 <目标名>”，失败不静默关闭。

光标恢复只在 `document.activeElement` 仍为 picker 内元素、trigger、`body` 或原 target 时执行。
任何其它 input/select/button/contenteditable 已取得焦点都表示用户有新意图，不抢回。点外部关闭时不
`preventDefault`，保留该次点击的焦点/动作。target/trigger unmount、catalog fatal error 或进入 hard-disabled/saving
时立即关闭，只将焦点交给仍 connected/enabled 的安全目标，不聚焦 disabled/unmounted trigger。

### 3.6 定位与响应式

将 `usePopoverPosition` 增强为向后兼容的 viewport-aware API，或提取共享 positioning primitive：

- hook/primitive 接受 trigger ref + popover ref，用 `ResizeObserver` 观测实际内容高宽；测量 visual viewport
  `offsetLeft/offsetTop/width/height`，优先下方，下方不足时 flip 到上方；
- left/right clamp 不超 viewport safe-area margin，宽度为
  `min(max(triggerWidth, preferredWidth), availableWidth)`，不把长解释压成按钮宽的窄柱；
- max-height 使用 visual viewport / `100dvh` 剩余空间，搜索/breadcrumb sticky，参数列表内滚；
- window/ancestor scroll、resize、orientation、visualViewport resize/scroll/offset 与内容 ResizeObserver 变化时重新定位；
- z-index 高于所属 Dialog panel 但不超越更高的 modal/toast 层级；
- pointer coarse 的所有行最小 44px，中英长描述换行不产生水平滚动。

## 4. 调用面迁移

### 4.1 Workflow Agent / CallWorkgroup

- 在 `promptTemplate` / `goalTemplate` 字段后放一个 picker；
- catalog = 当前入边 local provider + 本 surface 的 global runtime/task provider + 全量 global Webhook provider；
- `MissingRefList` 保留并放在参数选择器后，它是已保存 token 的诊断，不是发现入口；
- 删除 `WebhookTriggerVarChips` 与只展示 `PortRefList` 的分裂交互。

### 4.2 Review

- `commentInjectTemplate` 旁只保留一个 picker；
- catalog = `__review_comments__` local leaf + 全量 global Webhook provider；不注册 runtime/task source；
- 不提供 prompt-only builtin，不改 iterate renderer 或 missing-ref 检测。

### 4.3 CodeHostCall

目标由 shared action/provider-aware active projection 决定：

- preset text/textarea：`insert-at-caret`；
- preset select：`replace-whole-value`；业务 option 只保留 action registry 定义的枚举值。当 current value
  不在 options 且含 template ref 时，`Select`/field adapter 在关闭态显示独立的“当前运行期值”
  badge + 完整值，而不把它加回可选 option。打开业务 Select 只显示字面枚举，选择任一值将
  明示替换 template；非 template 的未知 literal 继续显示 validator error，不伪装成运行期参数；
- custom path/query value/body：`insert-at-caret`；query key 不接 picker；
- 每个目标的 catalog = 当前 CodeHost 入边 local provider + 全量 global Webhook provider。
- 每个 target 继续展示其 sink 限制的 `Field.hint`。custom JSON body 明示 token 只能放在 JSON
  字符串值内；picker 不绕过 `codeHostJsonBodyIssue`/工作流保存校验，裸 token 或放在 key/非字符串位置依旧
  fail closed。

删除集中 Advanced variables 区、active target/ref registry 及入边反向 target Select 写入。入边状态区可通过扫描权威
template target value 继续展示“未引用/已引用到 <target>”和移除引用动作，但“添加引用”只走 target-adjacent picker。

删除 query row 或 preset target 时不再维护可变 ref map/active target，从根本上消除 stale target 写错字段风险。
target snapshot 的 row identity/revision 仍会在提交前复核，以覆盖打开 picker 后删除/重排的异步窗口。

persisted 非 active values 单列为“已保留、当前 action 不执行”诊断，显示 path（值按现有编辑权限可见）、
切回 action 与显式清理动作。provider/action 切换本身不删值，undo 可恢复显式清理；active projection 使
这些隐藏值不参与当前 action 的 validator/trigger dependency/preflight，切回后才重新生效。

### 4.4 Webhook common/workflow/workgroup

- `workingBranch`、每个 workflow text mapping、workgroup `goal` 旁都放具体 target picker；
- catalog 只含按 `draft.eventTypes` 交集过滤的 global Webhook provider；
- 删除 shared chip stack 与 `lastFocusedWorkflowInputKey`/first-text fallback；
- git/enum/files/upload mapping 保持当前语义 UI，不获得 picker；
- mutation pending 期间字段和 picker 一起禁用，避免请求飞行期继续改 draft 产生返回状态歧义。

### 4.5 Webhook Agent

Agent list 只用于 target picker；选中 id 后单独读取有权限的 Agent detail，不用“列表里没有 inputs”猜 zero-port。
状态使用两层 ADT，不把 definition resolution、launch shape、compatibility 与 repair 混成一个互斥枚举；所有异步
detail result 带 `(agentId, requestGeneration, detailRevision=Agent.updatedAt)`：

```text
resolution = no-target | initial-loading | query-error | target-missing | resolved | refreshing
resolved   = { targetId, requestGeneration, detailRevision,
               shape: zero | ported, blockers: Blocker[], repairs: RepairIssue[] }
refreshing = { previousResolved: resolved, requestGeneration }
pendingReconcile = { agentId, requestGeneration, pendingResultSeq,
                     detailRevision?, resultKind, structureSignature, result }
```

- `initial-loading`：不渲染 description/inputs、不取得 target-specific payload 所有权，picker/save 禁用，内存 raw payload
  不变；加载完成前不闪现 zero-port 表单；
- `refreshing(previousResolved)`：后台 freshness check、drift refetch 或 retry 不卸载已经渲染的字段；保持相同 DOM key、
  draft、焦点、selection 与进行中的 IME composition，并显示“正在重新验证 Agent 参数”。刷新期间 Save 与 picker commit
  暂停，字段内尚未提交的本地文字编辑仍可留在 draft。返回结果先计算结构签名（zero/ported shape + 声明 port
  key/kind/presentation/required 等会改变作者控件/serializer 的字段）；签名相同则原位更新 detailRevision/metadata，绝不
  remount 当前控件。签名变化、404 或 query error 在任一 Agent target field 仍聚焦、存在 pending focus-session 或正在
  composition 时，只存为 `pendingReconcile` 并常显“Agent 定义已变化，完成当前编辑后应用”banner，继续 fence
  Save/picker；不得在两次普通按键、paste 与 blur 之间卸载字段。blur/离开 target field 时先提交本次 typing transaction，
  再一次应用 pending result；用户也可通过“应用最新定义”显式结束当前 focus-session 后执行。新 definition 按新 shape
  生成 blockers/repairs，404/error 转入下面的 opaque 状态，整个过程不丢 raw/per-Agent draft。pending entry 自身携带
  `agentId + requestGeneration + pendingResultSeq + detailRevision? + resultKind + structureSignature`。reducer 对每个被接受
  的新 result 分配单调递增 `pendingResultSeq`，包括没有 `detailRevision` 的 query-error/404；切 target 或发起新 generation
  时立即清除旧 pending，同一当前 generation 收到更新结果时 latest-wins 替换 pending，不保留队列。blur/显式 Apply
  handler 捕获上述 **完整 pending identity**，真正执行前与 reducer 当前 pending 做全等 CAS；只有仍为 current 的 entry
  才能 consume、改变 resolution/remount/patch 或解除 fence。失配时产生 0 resolution change/0 remount/0 payload patch/
  0 history，继续显示/等待当前 pending 或最新 request；只有通过完整 CAS 的最新结果完成 reconcile 后才解除
  Save/picker fence；
- `query-error/target-missing`：同样不取得 target-specific 所有权，但提供 retry 与 **common-only preserve-opaque**
  保存路径。只有 target id、raw `description`/`inputs` 与其原始 revision/bytes 完全未变时才能提交；serializer 从原始
  payload 逐字节带回 target-specific keys，只合并 name/eventTypes 等 common draft。不能切 Agent 或编辑 target-specific
  字段；backend 若因真正定义漂移拒绝，展示原错误并保留 draft。该状态必须常显 warning banner、Retry、目标
  name/id，以及不泄漏值的保留摘要（`description` 是否存在、input key 列表/数量）；文案明确“当前未验证 Agent 参数”。
  preserve-opaque 可用时主动作改名为“仅保存通用设置”，并以 `aria-describedby` 说明“Agent 参数原样保留”；若
  target-specific draft 已相对 raw 改动，则该动作禁用并说明需重试或先撤销这些改动，不能用普通“保存”制造已验证错觉；
- `resolved.shape=zero`：只渲染 `description` + picker，保存必须非空且 <=65,536；
- `resolved.shape=ported`：渲染已声明 text inputs。普通 text 与 `presentation: chips` 都使用模板 TextArea；
  chips 的 hint 说明一行一项/newline wire，参数渲染结果含换行时将自然形成多项。必填/可选、
  trim 与 65,536 上限和 backend launch-form 一致；
- `blockers[]`：任一 upload/path/signal/invalid blocker 显示端口名、kind 与原因，非空即禁止 resolved serializer。
  不对 upload 做 base64/string 降级；backend 要求 multipart 的端口在 Webhook JSON 端不可用；
- `repairs[]`：与 blockers 正交。一个已存 text input 后来改为 path/signal/invalid 时，同时拥有“不兼容端口”
  blocker 与“仍保留旧值”repair issue；移除旧值只清 repair，端口仍不兼容，保存继续阻断，直到 Agent 定义恢复兼容
  或改选兼容 Agent。

reducer 只接收仍匹配当前 `agentId + requestGeneration` 的结果；A-slow -> B-fast -> A-late 的 A 结果最多进入 A query
cache，不得改当前 B resolution/draft。resolved serializer 保存前对 Agent `updatedAt` 做 freshness fence；definition
rename、text->path/signal、delete 等后端 shape/404/422 错误触发 query invalidation/refetch，提升 generation，同时保留
raw/per-Agent draft。refetch 经过 `refreshing(previousResolved)` 转成新 blockers/repairs、query-error 或 target-missing；
旧 resolved shape 不再保持 Save enabled，但刷新过程也不卸载正在编辑的字段。

#### 4.5.1 payload 所有权与 XOR serializer

`draftFromRow` 把 `description` 和整个 `inputs` 从 `commonPayloadBase` 拆出，保留 raw target payload 直到 Agent detail
解析完成。`commonPayloadBase` 仍原样保留 `allowClarify`、limits、workingBranch 等本表单不拥有的键。

对每个 Agent id 保持 dialog-session `draftByAgentId`；切换目标时若当前 target-specific payload 非空/已改，
先确认“保存将以新 Agent 的启动参数取代旧值”。A -> B 不携带任何同名/异名端口值，
但未保存前 B -> A 恢复 A 的 session draft；取消确认时 target/value 均不变。

resolved serializer 只在 `blockers.length === 0 && repairs.length === 0` 时运行：

- zero-port：从 common base 删 `inputs`，写入非空 `description`；
- ported：从 common base 删 `description`，写入仅声明 keys 的 `inputs`；
- 两者都不允许 `description + inputs` 并存。

#### 4.5.2 definition drift / orphan repair

加载后若 raw payload 与当前 shape 不符，生成一个或多个 `repairs[]`：

- zero-port 下存在 raw `inputs`，ported 下存在 raw `description`，都作为 XOR conflict 展示；
- `inputs` 中未声明/已改名 key 进 `orphanInputs`，显示 key、值与“当前 Agent 未声明”原因；
- 已存 key 改为 path/signal/invalid 时同时显示存量值与 target 不兼容原因；
- resolved 状态下修改其它 rule 字段不自动删这些值，resolved serializer 保持禁用。用户可逐项移除
  orphan/conflict，或执行有明确删除摘要的“按当前端口修复”；该动作可取消、可 undo，不迁移同名值到其它 Agent。
  query-error/target-missing 的 preserve-opaque 路径不“修复”也不删除这些不可解析值。

## 5. 数据保存与兼容

- workflow definition 字段、Webhook payload schema/version、canonical token 和 renderer 不改；不需要 wire/data migration。
- shared 的行为变更只是 CodeHost active projection：migration/diff 与 Intent diff preview 仍扫全部 persisted strings；
  workflow validator、Intent confirm authoring validation、trigger dependency/preflight 与 direct executor defense 都只看
  active action/provider fields，并先报告 invalid/unsupported action。非 active 值不删除，切回后恢复校验/执行。
- 旧资源中已存 token 继续以原文回读；picker 不会自动重写、删除或 normalize 存量 template。
- Webhook eventTypes 过滤只影响可选 leaf，已存但当前不可用的 token 由既有 validation/preflight 诊断；picker 不静默清理。
- Webhook Agent 的 `commonPayloadBase` 不丢未知合法共通键；`description`/`inputs` 由 target-specific
  draft/XOR serializer 拥有。未解析/漂移/orphan 值保留在 repair state，不回塞 common base 规避校验。
- query-error/target-missing 的 common-only serializer 是独立 preserve-opaque 路径，必须对 target id +
  `description`/`inputs` 做 byte/revision fence；它不冒充 resolved/XOR serializer，也不承诺后端一定接受已漂移资源。
- 选择器不保存 catalog path/label，只保存 token，因此本地化或分类重命名不是 wire migration。

## 6. 测试与防漂移

### 6.1 shared authority、active projection 与目录纯函数测试

- Workflow/Webhook stable sink union、canonical family fixture 与被实际 target builder 消费的 adapter registry 双向
  exact 对账；断言的是 `(domain, launchKind?, sink)` family，不拿动态 pointer/实例数量制造假相等；
- CodeHost persisted inventory 始终保留全部旧值；遍历完整 `CODE_HOST_ACTIONS × provider`：preset=registry params、
  custom=request only/all params inactive、unsupported/invalid=structured error + empty active。workflow validator、Intent
  confirm、dependency/preflight、frontend builder 与 direct executor defense 同序，切回 action 后 active family 对称恢复；
- 未传 `eventTypes` 的 Webhook provider leaf exact set = `WEBHOOK_TEMPLATE_VARS`；已传时的子集、token/group/eventTypes
  availability 与 shared 真值一致；`event_json` 只在 context 展示顺序置顶，不改变 group/set；
- zh/en 的 type/source/group/field label + description exact completeness，无空值、无 raw-id fallback；source
  description 也逐语言必填；
- runtime builtin descriptor 与 Agent `BUILTIN_VARS` exact set；CallWorkgroup producer object 对其 surface subset
  编译期穷尽；每个 exposed leaf 的 Agent/CallWorkgroup producer value golden 与 per-surface description/format key 对应，
  child-vs-caller identity、newline/bullet/comma 格式不可混淆；context-only 文案齐全，deprecated/无 producer surface 不出现；
- path/id/token 唯一，类型/source/group 顺序稳定；一个非法/保留 namespace 的 local port 只生成带原因的
  unavailable leaf，不影响正常 local leaf 与 Webhook source；重复入边按 port 合并来源解释；
- 搜索命中 label/raw id/token/去 braces/description/alias/localized+raw breadcrumb；NFKC/CJK/IME 输入不污染值；
- 假 scheduler source 在 workflow policy 下出现且无需 inspector/component 分支，在 Webhook policy 下不可见；未注册时
  生产 catalog 不出现 scheduler。

### 6.2 公共组件测试

- non-modal popover 与 trigger `haspopup/expanded/controls` ownership；combobox + listbox/action options
  action buttons 不产生 selected/option 语义，二次打开回根层；
- 根分类 -> type -> source -> group -> field 的键盘/指针导航、singleton compression、breadcrumb/back；异步
  catalog 重排按 stable path 保持或安全回退，旧 Enter 不执行同 index 的新 token；
- 叶节行常显 label/token/description，accessible name 与 `aria-describedby` 分工正确；分类标题不进入 action 次序；
  `Field action` 不嵌套多控件 `<label>`，同页按钮各自带 target-specific 可访问名；
- text 光标/selection replace/append；从未聚焦时追加；focus/select/blur 历史以及 pointer、keyboard、screen-reader
  synthetic click 都取得同一有效 snapshot；打开后 search 获焦仍按快照写入；
- `targetId + revision + value` 条件提交：undo/redo、远端回流、row 删除/重排、eventTypes/target 切换、unmount
  都 fail closed；成功只形成一个 history/undo boundary，Escape/outside/Tab/失败形成零 patch/零 autosave；
- Workflow insert -> canvas Undo -> Redo exact value；Webhook insert -> dialog Undo/Redo；Webhook draft target 的可见
  action、快捷键与 `beforeinput historyUndo/historyRedo` 只有一个 stack owner。bulk repair -> 同字段连续多字符/粘贴/IME
  common edit -> 两次 Undo/两次 Redo exact payload；draft-target native-history event 后 blur 再走可见 Undo/Redo 结果
  相同；picker search 输入后 Undo 只还原 search、不改 rule draft，关闭 picker 后外层 shortcut 才操作 dialog stack；
  redo truncation、save success reset/save failure preserve、Cancel discard 与 rule/target boundary；
- replace-whole-value 与明示提示；`validateNext` 的 CodeHost JSON string-value 正向及空 body/key/非字符串/裸 token
  负向；disabled/empty/unavailable 原因；
- Enter/Space/Arrow/Home/End/Escape 与 logical Tab/Shift+Tab；CJK composition Enter/Escape 不执行也不关闭外层
  Dialog；outside click 保留原动作，hard pending/unmount 不聚焦失效 trigger；
- live announcement；用户主动聚焦任何其它 input/select/button/contenteditable 时不抢回；
- viewport 上/下 flip、左/右 clamp、visual viewport offset/resize/scroll、内容 ResizeObserver、390px 无水平溢出。

### 6.3 集成测试矩阵

| surface                  | 必须锁定的关键路径                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent                    | 默认只显示一个按钮；正常/非法 local leaf 隔离；本地入边/runtime-task/Webhook 按光标插入；context-only builtin 有说明；missing refs 保留                                                                                                                                                                                                                                                              |
| CallWorkgroup            | goal 选区替换；只出现有真实 producer 的 runtime-task 子集；无常驻 Webhook chips                                                                                                                                                                                                                                                                                                                      |
| Review                   | builtin + Webhook 同一 picker；其它 builtin 不出现                                                                                                                                                                                                                                                                                                                                                   |
| CodeHost preset          | text/textarea 插入；select token 整值替换并保存/重载；关闭态显示存量 template，业务列表只有字面 option，选择字面值可替换；unknown literal 仍报错                                                                                                                                                                                                                                                     |
| CodeHost active/inactive | provider/action 切换保留非 active 值并显示诊断；隐藏 token 不参与 validator/preflight；切回恢复；显式清理可取消/undo                                                                                                                                                                                                                                                                                 |
| CodeHost custom          | path/query value/body 切换无错写；query key 无 picker；JSON body 字符串值正向及空 body/key/非字符串/裸 token 负向；删除/重排 row 使旧 snapshot fail closed                                                                                                                                                                                                                                           |
| Webhook common/workflow  | workingBranch 插入；每个 mapping 显式目标；eventTypes 交集/空集；无 first-field fallback                                                                                                                                                                                                                                                                                                             |
| Webhook Agent            | initial loading 不闪 zero-port；refreshing 保字段/焦点/普通输入/paste/IME；pending reconcile 携完整 identity + 单调 seq、latest-wins，blur/Apply 全 identity CAS 且 fence Save；error/missing 有 banner/摘要/Retry/“仅保存通用设置”；zero/ported XOR；blocker+repair 正交；A-slow/B-fast/late fence；跨 generation 与同 generation A→B→stale Apply；drift/delete/422 refetch；draft undo；共通键保留 |
| Webhook Workgroup        | goal 选区替换；saving disabled                                                                                                                                                                                                                                                                                                                                                                       |

### 6.4 source ratchet

新增源码级棘轮：

1. 生产 JSX 中 `TemplateVarChips` / `WebhookTriggerVarChips` 使用数必须为 0；旧 CSS/test-id 前缀必须为 0；
2. CodeHost 业务 Select 不得将 `{{...}}` 动态 token 混入 option，不得保留反向 target writer；
3. Webhook workflow mapping 不得保留 last-focused/first-text insertion fallback；
4. shared 导出稳定 sink family/active projection；frontend registry 使用 `satisfies Record<AuthorityKey, ...>`，且
   生产 target builder 只能从 registry 取 adapter。canonical fixtures 双向断言“每个 active authority family 有且仅有
   一个可达 writer”，不对 optional/dynamic pointer 做实例 exact equality；
5. adjacent-miss allowlist 明确锁定 Script body、Clarify/Review description、CodeHost query key 等不能因反向扫描被误纳入。
6. runtime builtin descriptor 是 Agent/CallWorkgroup producer keys、per-surface format 文案与 frontend provider 的唯一
   路径；mutation 改 backend producer key、绕 descriptor 手写 key、漏 surface override 或泄漏到 CodeHost/Webhook launch 必红。

棘轮扫描使用 AST/import/call/DOM 行为的精确范围，不用会误伤文档/i18n 的全仓 token 文本计数。scanner 自带
sentinel/self-test；mutation 证明恢复旧 writer、绕开 registry 或新增 stable sink 未接 adapter 都会变红。

### 6.5 视觉与真实浏览器

- 更新现有五张 selected Agent inspector Linux baseline：1536 light、1280 light/dark、1179 light、390 light，
  锁定默认态只剩一个紧凑入口且本地字段/诊断优先；
- 新增两个**独立 full visual scene**：桌面打开 picker（层级、长中英解释、token、scroll）与 390px Webhook
  配置打开 picker（外层 Dialog、viewport flip/clamp、事件过滤）。同步把 visual scene guard `31 -> 33`、README
  总 pixel baseline `45 -> 47`，并更新 `e2e-visual-infrastructure` 断言；
- Darwin 本地截图只报告布局诊断；Linux hosted baseline 才是权威像素结果，两者分开陈述；
- 至少两条 Playwright 真 E2E 使用 live daemon、不得 route mock：一条 Workflow inspector、一条 Webhook rule，
  都执行字段旁打开/搜索/插入 -> 真实 POST/PUT 保存 -> 浏览器刷新回读；Webhook 路径还经过真实 Agent detail/
  XOR 保存门。另锁 Escape 只关 picker与 stale/no-op 不产生保存。

## 7. 错误、空状态与可观测性

- 平台内置 global source 构建失败（重复 path、空 description、非 canonical token）在开发/测试中抛错；生产只
  fail 该 source 并显示“<source> 参数不可用”，不把其它已验证 source/local leaf 一起清空。用户数据派生的坏
  local entry 始终逐项降级为带原因的 unavailable leaf，不升级为 catalog fatal error。
- adapter validation/conditional commit 返回 stale、unmounted、invalid 或抛错时保持 popover 打开、宣告精确原因，
  不清空搜索、不覆盖新值、不谎报成功。
- eventTypes 空、无 local inputs、搜索无结果是三种不同空态，文案分别说明“先选事件”、“当前无节点输入”、
  “无搜索匹配”。
- 选择器不上报 token/value 到日志；可选的产品埋点若后续新增，只能记录稳定 catalog id 与 surface id，不记录输入内容。

## 8. 回滚

本 RFC 不改 wire/schema 版本，但包含 shared CodeHost active projection 与 Webhook Agent 前端所有权变更，不能描述成
纯前端回退。回滚单位是“shared active projection + frontend/Workflow/Intent/launch/direct 全部 active consumer 接线 +
全部 authoring UI”：

- 已经保存的 token 继续由旧 renderer 解析；
- CodeHost 非 active 值从未删除，但 RFC 版会允许保存“active projection 合法、legacy 全量 projection 会失败”的
  新资源，因此“没有数据迁移”不等于“可无条件降级”。交付一个复用 legacy collector/validator/dependency 逻辑的
  downgrade dry-run，扫描当前 workflow revisions、可 resume/live task 的 root/frozen closure snapshots，报告
  workflow/revision/task/node/pointer/ref 与 legacy issue；非空时自动阻断版本回退。操作者必须在 RFC 版 UI 中显式
  清理 inactive 值、切回使其 active 并修复，或放弃回退继续 roll-forward；不提供忽略清单的 silent override；
- 若回退 active projection，必须同时回退对应 UI 诊断/清理入口，并同时用 pre-RFC 旧 fixture、RFC 上线后新建的
  inactive-invalid/inactive-trigger fixture 与 frozen closure 证明 dry-run 会拦、清理后 validator/preflight 行为一致；
- Webhook Agent `inputs.*`/`description` wire 未变，旧前端可恢复为 payloadBase 原样保留；回滚前后的保存/取消都
  不得删除 orphan 或 target-specific draft；
- `resolveChangeset` authoring validation 与 `codeHost/call` direct defense 是同一协调发布/回退单元；Intent diff
  preview/migration 继续 persisted，不随 active consumer 回退而改写资源；
- 不回滚 RFC-292 canonical namespace/runtime contract；
- migration/diff 继续使用 persisted inventory，回滚前后同一旧 workflow/Webhook fixture 的持久化字符串字节不变；
- 若只回退一部分 surface，将重建多套 writer 并破坏棘轮，因此 production/UI 与 shared active-projection 行为必须
  作为同一个协调发布/回退单元。

## 9. 实现落点预计

| 作用                                             | 落点                                                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| stable Webhook sink / CodeHost active projection | `packages/shared/src/webhookTemplate.ts`、`workflowTemplateSurfaces.ts` 或其相邻 shared 纯模块                                          |
| runtime builtin descriptor / producer keys       | `packages/shared/src/prompt.ts`、`callGoalTemplate.ts` 与 CallWorkgroup runtime producer 相邻纯模块                                     |
| 全 active consumer 共用 projection               | workflow validator、Intent `resolveChangeset` authoring validation、backend trigger preflight、scheduler/direct `codeHost/call` defense |
| 目录类型/provider registry/builder/search        | `packages/frontend/src/lib/runtime-parameter-catalog.ts`                                                                                |
| authority adapter registry/target adapter        | `packages/frontend/src/lib/runtime-parameter-target.ts`                                                                                 |
| 公共选择器                                       | `packages/frontend/src/components/RuntimeParameterPicker.tsx`                                                                           |
| Field / Dialog / popover 合同                    | `Form.tsx`、`Dialog.tsx`、`usePopoverPosition.ts` 的向后兼容扩展/共享 primitive                                                         |
| 字段可读名/解释                                  | `packages/frontend/src/i18n/{zh-CN,en-US}.ts` typed maps                                                                                |
| workflow inspector adapters                      | `AgentSingleEdit.tsx`、`CallWorkgroupEdit.tsx`、`ReviewEdit.tsx`、`CodeHostCallEdit.tsx`                                                |
| Webhook adapters/Agent inputs                    | `packages/frontend/src/components/webhooks/TriggersPanel.tsx`                                                                           |
| 旧 chip 移除                                     | `packages/frontend/src/components/TemplateVarChips.tsx` 在 helper 下沉后删除                                                            |

shared 必须直接导出 stable sink metadata 与 active projection；frontend 的 `AuthorityKey` 由该导出类型派生，registry
用 `satisfies Record` 穷尽并由生产 target builder 实际消费。禁止以“测试时无法对账”为由再复制 allowlist 或把 ledger 留到实施期猜测。
