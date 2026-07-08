# RFC-155 · 技术设计

## 1. 新公共组件 `<FormSection>`（`components/FormSection.tsx`）

共享库里目前没有"表单分节"原语（`.page__section` 是裸 class 约定、`.form-details` 是
raw body 专用的小字折叠），按 CLAUDE.md「新增公共组件」条款落一个：

```tsx
export interface FormSectionProps {
  title: string
  /** 折叠形态（details/summary）。false/缺省 = 静态分节（section + h2）。 */
  collapsible?: boolean
  /** 受控展开态（collapsible 时可选；与 onToggle 成对）。 */
  open?: boolean
  onToggle?: (open: boolean) => void
  /** 非受控初始展开态，默认 false（仅 collapsible 且未传 open 时生效）。 */
  defaultOpen?: boolean
  children: ReactNode
  'data-testid'?: string
}
```

- 非折叠：`<section className="form-section"><h2>{title}</h2><div className="form-section__body">{children}</div></section>`。
- 折叠：`<details className="form-section form-section--collapsible" open={openState} onToggle={…}><summary><h2>{title}</h2></summary><div className="form-section__body">{children}</div></details>`。
  - `summary > h2` 是 MDN 认可的合法结构，heading outline 保留，axe（e2e a11y 门）无违例。
  - **React `<details open>` 受控坑**：直接把布尔 prop 写死会在用户点击后被下一次渲染
    强制复位。实现为内部 `useState`（非受控）或透传受控 `open`，两种模式都必须在
    `onToggle` 事件里同步状态（`e.currentTarget.open`），保证渲染不与原生开合打架。
    受控 + 非受控双模式与 `<details>` 语义一一对应，单测锁两种模式。
- 样式 `.form-section` 命名空间（styles.css）：h2 字号 16px / margin 对齐
  `.page__section > h2`；`details.form-section` 带 `var(--border)` 边框 + 圆角容器，
  summary 行 `cursor: pointer`；展开后 body 顶部留 12px。dark/light 只用既有 token，
  不引新色。

## 2. `AgentForm` 分节重排

### 2.1 归属表（字段 → 节）

| 节（i18n key）                            | 形态   | 内容（组件不变，仅挪位）                                                                 |
| ----------------------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| 基本信息 `agentForm.sectionBasics`         | 可见   | name（nameLocked 逻辑不变）、description、runtime（`showRuntime` 条件渲染逻辑整体照搬）   |
| 提示词 `agentForm.sectionPrompt`           | 可见   | bodyMd `<MarkdownEditor>`；**删除** raw body `<details className="form-details">` 块      |
| 输出 `agentForm.sectionOutputs`            | 可见   | `<OutputsEditor>`（outputs + outputKinds 双字段 onChange 不变）                           |
| 依赖关系图 `agentForm.sectionDependencyGraph` | 可见| `<DependencyTreePreview>`（去掉外层 `<Field label=fieldDependencyTree>` 壳，节标题即标签）|
| 资源与依赖引用 `agentForm.sectionResources` | 折叠  | SkillsPicker、McpsPicker、PluginsPicker、AgentDependsPicker、DependencyAutodetectButton   |
| 高级设置 `agentForm.sectionAdvanced`        | 折叠  | syncOutputsOnIterate Switch、role Select、outputWrapperPortNames（role=aggregator 条件不变）、permission JsonField、frontmatterExtra JsonField |

顺序即上表。依赖关系图紧邻资源折叠节，展开编辑 dependsOn 时图在旁边即时反馈；两个折叠节
收尾，页面呈"重要 → 次要"梯度。

### 2.2 折叠节展开态（AgentForm 内部 state，受控喂给 FormSection）

```ts
const hasResourceContent = (v: CreateAgent) =>
  [v.skills, v.mcp, v.plugins, v.dependsOn].some((a) => (a ?? []).length > 0)
const hasAdvancedContent = (v: CreateAgent) =>
  v.syncOutputsOnIterate === false ||
  (v.role !== undefined && v.role !== 'normal') ||
  Object.keys(v.outputWrapperPortNames ?? {}).length > 0 ||
  Object.keys(v.permission ?? {}).length > 0 ||
  Object.keys(v.frontmatterExtra ?? {}).length > 0
```

- 初值：`useState(() => hasXxxContent(value))`。
- **上升沿自动展开**：`useEffect` 里用 ref 存上一帧 `hasXxxContent`，`false → true` 边沿
  `setOpen(true)`；同值渲染与 `true → true` 不动，用户手动收起后不会被反复弹开。
  该机制同时覆盖三条注入路径，无需分别处理：
  1. `/agents/$name` 编辑页首帧空 draft → useQuery 到达后 `setDraft`（agents.detail.tsx:37
     的 loaded-effect 现状保留，不需要早退改造）；
  2. 新建页 `AgentImportDialog.onApply` merge；
  3. `DependencyAutodetectButton.onApply` merge（按钮在资源节内部，点击时节必已展开，
     effect 只是兜底）。
- 折叠 ≠ 卸载：`<details>` 收起时 children 仍挂载，JsonField 等内部草稿态不丢。
- **随行修真 bug（Codex 设计门 high）**：`agents.detail.tsx` 的 `agentToDraft` 漏拷贝
  `Agent.role` 与 `Agent.outputWrapperPortNames`（两者是真实 GET 响应字段——DB 折
  frontmatter_extra 存储、`rowToAgent` 投影回 top-level，services/agent.ts:65-67；schema
  见 shared/schemas/agent.ts）。现状：编辑既有 aggregator agent 时表单误显示 role=normal、
  重命名 map 消失（数据不丢——updateAgent 对 `patch.role === undefined` 保留 fresh 值，
  agent.ts:186-187——纯 UI 谎报）。若不修，本 RFC 的 `hasAdvancedContent` 对这类 agent
  永远 false、高级节不自动展开，谎报被折叠进一步放大。修法：`agentToDraft` 补拷两字段
  （对齐 runtime 的 RFC-115 同型修复），回归测试锁「异步载入 aggregator draft → 高级节
  初始展开 + map 值在表单中可见」。
- **导入协议边界（Codex 设计门 medium）**：agent-md 导入解析器 `KNOWN_KEYS`
  （shared/agent-md.ts:31-53）为 name/description/permission/tools/dependsOn/mcp/plugins/
  runtime——**不含 skills**；YAML 里的 `skills:` 会按未知键落入 frontmatterExtra（触发的是
  高级节 autoOpen，不是资源节）。这是既存导入协议行为，本 RFC 不扩它；上升沿展开对
  dependsOn / mcp / plugins 导入成立。用户故事、验收措辞随此对齐。

### 2.3 消费方

`AgentForm` 仅 `/agents/new` 与 `/agents/$name` 两个消费方，均整页透传 value/onChange，
分节属 AgentForm 内部重排；消费方唯一改动 = 上述 `agentToDraft` 补拷两字段
（agents.new 的 import 按钮、detail 的 Save/Delete/ACL header 均不动）。

## 3. 页头解释小字移除

判定标准：位于页头（`page__header`）`<h1>` 之下、内容为**静态 i18n 解释文案**（讲系统
机制 / 页面用途）的段落 → 删；插值动态数据 / 运行状态 / 资源元数据 → 留。盘点口径
（Codex 设计门 medium 补漏）：`page__hint` 全仓 grep **加** `page__header` 块内静态
`muted` 段全量扫描——后者只命中 memory 一处，一并列入。

### 3.1 删除清单（22 处；i18n key 同步从 zh-CN.ts + en-US.ts 值与类型声明删除）

| 文件（routes/）        | key(s)                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| tasks.tsx              | `tasks.hint`                                                                                  |
| agents.tsx             | `agents.hint`                                                                                 |
| workflows.tsx          | `workflows.hint`                                                                              |
| plugins.tsx            | `plugins.hint`                                                                                |
| repos.tsx              | `repos.hint`                                                                                  |
| reviews.tsx            | `reviews.hint`                                                                                |
| mcps.tsx               | `mcps.hint`                                                                                   |
| clarify.tsx            | `clarify.list.hint`                                                                           |
| users.tsx              | `users.hint`                                                                                  |
| skills.tsx             | `skills.hintBefore/hintManaged/hintMid/hintManagedPath/hintBetween/hintExternal/hintAfter`（整段 7 key） |
| agents.new.tsx         | `agents.newHint`                                                                              |
| mcps.new.tsx           | `mcps.newHint`                                                                                |
| plugins.new.tsx        | `plugins.newHint`                                                                             |
| skills.new.tsx         | `skills.newHintBefore/newHintManaged/newHintMid/newHintExternal/newHintAfter` 同段全部        |
| agents.detail.tsx      | `agents.detailHint`                                                                           |
| mcps.detail.tsx        | `mcps.detailHint`                                                                             |
| plugins.detail.tsx     | `plugins.detailHint`                                                                          |
| settings.tsx           | `settings.hintBacked/hintPatched/hintRestart`（含内联 `<code>` 常量文本整段 3 key）           |
| memory.tsx             | `memory.hint`（形态为 `<p className="muted">`，非 page__hint——盘点口径见 §3 开头）            |
| account.tsx            | `account.subtitle`                                                                            |
| workflows.edit.tsx:120 | `editor.newHint`（新建工作流分支的页头）                                                      |
| workflows.launch.tsx   | `launch.hintBefore/hintCode/hintAfter` 整段                                                   |

删除方式：整个 `<p className="page__hint">…</p>` 连同外层只剩 `<h1>` 的空 `<div>` 包裹
（如有）一并简化；key 从两 bundle 的值对象 + zh-CN.ts 顶部的类型声明结构同步删除。
每个 key 删除前 grep 全仓确认无第二引用点。

### 3.2 保留清单（明确不动，防误伤）

| 位置                                   | 理由                                                                 |
| -------------------------------------- | -------------------------------------------------------------------- |
| workflows.edit.tsx:357 页头第二形态    | `id · v{version} · 保存状态`——动态状态栏                              |
| skills.detail.tsx:93                   | 来源 chip（managed/external）+ 实际路径——资源元数据                   |
| fusions.detail.tsx:100                 | skill 链接 + 状态 chip——数据                                          |
| reviews.detail.tsx:457 / 476           | `summary.description` 动态 + `reviews.detailHint`（iteration/decision 插值；`reviews-detail-title-description.test.ts:48` 源码锁要求保留） |
| clarify.detail.tsx:726 / 846           | 动态上下文卡片 / 提交人（带 data-testid）                             |
| AclPanel / TaskMembersPanel / Onboarding / ReviewDecisionInfo | 面板、对话框、引导流内部，非页头                |
| auth.tsx `auth-page__hint`             | 登录 landing 副标题，非应用内页头模式（proposal §非目标）             |

## 4. 耦合点与失败模式

- **测试环境对 closed `<details>` 的查询行为**：前端跑 happy-dom（非 jsdom）。实现期实测：
  happy-dom 不对 closed details 内容做 a11y 过滤，`getByRole` 直接穿透——因此
  `agent-form-role.test.tsx` 等 6 个存量锁**零适配全绿**（它们锁字段存在与 wiring，与
  折叠正交）；折叠开合语义由新的 `agent-form-sections.test.tsx` 专锁（以 `details.open`
  DOM 属性断言，不依赖可见性过滤）。原设计预期的"先展开再断言"适配未发生（勘误）。
- **wiring 锁**：`plugins-page-wiring.test.ts:109-113`、`mcps-page-wiring.test.ts:90-91`
  断言 bundle 里存在 `hint/newHint/detailHint` key——随 key 删除同步收缩列表。
- **i18n 类型声明**：zh-CN.ts 顶部 interface 与值对象成对删除，en-US 靠既有类型约束自动
  对齐（typecheck 门兜底）。
- **visual-regression（e2e，`RUN_VISUAL_REGRESSION=1` opt-in）**：8 页基线全部含页头小字，
  删除后像素必 diff。默认 `bun run e2e` 跳过、CI 不阻塞；按其 README 流程重生成基线
  （平台后缀独立），无法在本机生成的平台基线在 PR 说明里标注过期、留待对应平台刷新。
- **多人树**：working tree 现有他人未提交改动（RFC-147 文档、workflow.validator.ts、
  nodePorts.ts 等），本 RFC 改动文件与之无交集；提交按精确路径 `git commit -- <paths>`。
- **删除即真删**（prefer-correct-over-minimal）：i18n key、`.form-details` 在 AgentForm 的
  用法、`agentForm.fieldDependencyTree`/`rawBodySummary` key 一律删除而非留空 deprecate。
  `.form-details` CSS class 若删后全仓无引用则连样式一起删；有其他引用则保留样式只删用法。

## 5. 测试策略（随改动落地，不后补）

新增：

1. `FormSection.test.tsx` — 非折叠形态渲染 `section>h2` + children；折叠形态默认收起 /
   `defaultOpen` 展开；点击 summary 开合（onToggle 回调值正确）；受控模式 open prop 驱动、
   点击后不被渲染复位（回归锁 React details 受控坑）。
2. `agent-form-sections.test.tsx` —
   - 空 draft：六节按序渲染，两折叠节 `details` 无 `open`；name/description/bodyMd/
     OutputsEditor/DependencyTreePreview 可见。
   - autoOpen 初值：带 skills 的 draft → 资源节 open；带 permission（或
     syncOutputsOnIterate=false / role=aggregator）的 draft → 高级节 open。
   - 上升沿：空 draft 首挂 → rerender 注入 skills → 资源节自动 open；手动收起后同值
     rerender 不重新弹开。
   - raw body 区已删：`queryByText(裸 markdown 文案)` 为 null + 源码断言
     `AgentForm.tsx` 不再含 `form-details` / `rawBodySummary`（文本兜底锁）。
3. `page-hint-removal.test.ts` — 表驱动（memory：banned 锁用表级）：
   - REMOVED_HINT_KEYS 常量表 × 两 bundle 源文本：断言 key 名不再出现（覆盖 memory.hint
     这类非 page__hint 形态——按 key 锁而非按 class 锁）；
   - 删除清单文件表：断言各 route 源码不再引用其被删 key；
   - 保留清单锚点：`workflows.edit.tsx` 状态行、`reviews.detailHint` 引用仍存在（防过删）。
4. `agentToDraft` 回归（随行修真 bug）：构造含 role='aggregator' + outputWrapperPortNames
   的 Agent 响应 → draft 携带两字段；结合 agent-form-sections 断言该 draft 首挂时高级节
   展开、map 字段可见。

适配：`agent-form-role.test.tsx` 加"展开高级设置节"步骤；两个 page-wiring 锁收缩 key
列表。

e2e 门（Codex 设计门 low）：
- `a11y.spec.ts` 新增 `/agents/new` case（FormSection 的 details/summary>h2 结构过 axe
  wcag2a critical+serious 门——现有 spec 只扫列表/设置页，不加则新 DOM 无 e2e a11y 覆盖）。
- visual-regression：**不**为 agent 表单页新增基线（8 页基线体系是 RFC-054 定的关键页
  集合，表单页从未在内；新增需双平台生成基线，收益低）。表单视觉以「人工截图对比
  （light+dark，T4）+ agent-form-sections 结构断言」为门，此为显式决策而非遗漏。
  既有 8 页基线因页头小字删除全部过期，按 README 流程重生成。

运行门槛：`bun run typecheck && bun run lint && bun run test && bun run format:check`
+ 前端 vitest 全绿后 push，随即查 GitHub Actions。
