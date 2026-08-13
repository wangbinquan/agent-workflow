# RFC-299 设置界面统一卡片化 — 技术设计

状态：**In Progress（2026-08-13 用户已批准完整实现并提交上库）**

## 1. 当前结构与改动边界

### 1.1 现有单一基准

`packages/frontend/src/routes/settings.tsx` 的 `AgentCard()` 已经给出用户指定的基准：

```tsx
<Card
  className="system-agent-card"
  title={title}
  header={<p className="settings-hint settings-hint--tight">{hint}</p>}
>
  <div className="form-section__body">{children}</div>
</Card>
```

它复用 `packages/frontend/src/components/Card.tsx` 与 `.card*` token，字段节奏由
`.form-section__body` 的 16px gap 提供。RFC-299 把这段提升为设置域共享组件，而不是从视觉稿
重新发明另一套样式。

### 1.2 当前不一致 seam

| 文件/组件                         | 当前形态                                     | 目标                                          |
| --------------------------------- | -------------------------------------------- | --------------------------------------------- |
| `routes/settings.tsx` config tabs | 多数 `SectionForm > .form-grid > Field` 平铺 | `SectionForm > .form-grid > SettingsCard`     |
| `RuntimeList.tsx`                 | 私有 header/subtitle + `page__section`       | 一张 SettingsCard，Add 进入 actions slot      |
| `CodeHostsSection.tsx`            | `page__section` + 裸 h3                      | 每 provider 一张 SettingsCard                 |
| `AuthenticationTab` providers     | 私有 `auth-tab__header` + table              | title/hint/action/table 同属一张 SettingsCard |
| `OidcProviderDialog`              | 四个私有 `oidc-form__group` fieldset chrome  | 四个 fieldset SettingsCard                    |
| `RuntimeFormDialog`               | Dialog body 内全部字段平铺                   | 两张 SettingsCard                             |
| `BackupCard`                      | 直接 `<Card>`，header 结构与系统 Agent 不同  | 使用 SettingsCard                             |

## 2. 共享原语

新增 `packages/frontend/src/components/settings/SettingsCard.tsx`：

```tsx
interface SettingsCardProps {
  title: ReactNode
  hint?: ReactNode
  actions?: ReactNode
  children: ReactNode
  as?: 'section' | 'fieldset'
  disabled?: boolean
  className?: string
  'data-testid'?: string
}

export function SettingsCard(props: SettingsCardProps) {
  const titleId = useId()
  return (
    <Card
      as={props.as ?? 'section'}
      disabled={props.as === 'fieldset' ? props.disabled : undefined}
      aria-labelledby={titleId}
      className={join('settings-card', props.className)}
      title={<span id={titleId}>{props.title}</span>}
      actions={props.actions}
      header={
        props.hint == null ? undefined : (
          <p className="settings-hint settings-hint--tight">{props.hint}</p>
        )
      }
      data-testid={props['data-testid']}
    >
      <div className="form-section__body">{props.children}</div>
    </Card>
  )
}
```

最终实现可让 `Card` 直接接收 title id，而不是包一层 span；承重契约是：标题仍是共享 Card 的
`h3.card__title`，root 由 visible heading 命名，hint 与 body 结构逐字统一。

### 2.1 Card 的最小扩展

`CardProps.as` 从 `'div' | 'section'` 扩为 `'div' | 'section' | 'fieldset'`，新增可选
`disabled`，只在 root 为 fieldset 时透传。既有调用方默认仍是 div，DOM 不变。

这样 OIDC 可以同时满足：

- 原生 fieldset 的批量 disabled；
- `aria-labelledby` 指向可见 h3；
- 与系统 Agent 完全相同的 `.card/.card__header/.card__body` chrome；
- 不保留一套 `oidc-form__group` 私有背景、边框、padding、radius。

新增 `SettingsCard` 组件测试，并扩 `card.test.tsx` 锁 fieldset/disabled/accessible name。

## 3. 主分区组合

`SectionForm` 本体不改。它当前先渲染 `.form-grid` children，再渲染 Save 与所有写入状态；因此
只需要把每组既有字段放入 SettingsCard，Save 会自然继续落在所有卡片下方。

### 3.1 限额

- `limitsBudgets`：`defaultPerTaskMaxDurationMs`、`defaultPerTaskMaxTotalTokens`、
  `defaultPerNodeTimeoutMs`、`defaultNodeRetries`、`largeOutputThresholdBytes`；
- `limitsConcurrency`：六个现有并发/子任务/调用深度字段，保留双列 grid；
- `limitsLogging`：`logLevel`。

### 3.2 恢复

- `recoveryAutomation`：三个现有 Switch；
- `recoverySafety`：heartbeat、窗口恢复次数、窗口时长、周期 orphan reconcile。

### 3.3 Git

- `gitCheckout`：递归模式、jobs、remote；
- `gitRefresh`：enabled、interval、recent days。

### 3.4 GC

- `gcWorktrees`：enabled、olderThanDays、onlyMerged；
- `gcEvents`：per-node/global archive thresholds；
- `gcWebhooks`：body/row retention；
- `BackupCard` 内部换为 `SettingsCard`，现有确认与 async state 原样保留。

### 3.5 网络、外观、渲染

- Network：listener 卡含 host/port/effective-port action；external surface 卡含 MCP Switch 与 docs link；
- Appearance：theme/language 同属 display preferences 卡；
- Rendering：endpoint/auth/test/result 同属 diagram service 卡。

### 3.6 系统 Agent

删除本地 `AgentCard`，六处直接改用 `SettingsCard`。不改 `SystemAgentsTab` 的双资源保存时序、
fusion revision fence、dirty 合并与卡片顺序。`system-agent-card` 若无行为性消费者则删除；测试从
feature class 改锁共享 `settings-card/card__title`。

## 4. 独立资源配置面

### 4.1 RuntimeList

`RuntimeList` 自己拥有列表 query、Add action、删除 focus fallback，因此由它直接组合
`SettingsCard(title=runtimes.title, hint=runtimes.subtitle, actions=Add)`：

- 删除外层 `.page__section` 与 inline margin；
- runtime rows、probe/error/loading、Dialog/ConfirmDialog 保持原逻辑；
- 删除目标失焦时仍回到可见 card heading 或调用方提供的 section heading；若 Card 现有 title 槽
  不暴露 ref，最小增加 `titleRef`，不能退回 `document.querySelector`；
- Settings route 不再以 `showHeading={false}` 制造 actions-only 私有 header。

### 4.2 CodeHostsSection

`ConnectionCard` 改用 `SettingsCard`：provider 名为 title，新增 provider-specific 一行说明，错误、
字段、actions 与 test result 留在 body。外层使用统一卡片栈 gap，删除 `page__section` 32px margin。
保存/测试/删除仍各发原 endpoint 与精确 body。

### 4.3 AuthenticationTab

- 既有 login methods `<Card>` 换 SettingsCard，内容/即时 mutation 不变；
- provider 标题、hint、Add action、loading/error/empty/table 合入第二张 SettingsCard；
- 删除 `auth-tab__header/title` 私有 chrome，保留 provider table 的 `TableViewport`；
- focus fallback map 与 ConfirmDialog trigger/fallback 不改。

## 5. 二级配置 Dialog

### 5.1 RuntimeFormDialog

Dialog footer仍是 Test binary / Cancel / Save。body 拆成：

1. `runtimeLaunch`：name、protocol、binary path、config dir env/name；
2. `runtimeProfile`：model、Claude compatibility/extra args，或 opencode variant/temperature/steps。

probe success/error 与 save error跟随第二卡之后显示，仍属于 Dialog body 的反馈，不再额外包无标题卡。
字段的条件渲染、numeric gate、profileBody 与 request body不得改写。

### 5.2 OidcProviderDialog

四个现有 fieldset 一一替换为 `SettingsCard as="fieldset" disabled={busy}`：

1. Provider
2. Manual endpoints
3. Credentials
4. Behavior

每组原 title/hint 直接进入 SettingsCard；所有 row/Field/Segmented/Switch 及条件字段顺序不变。
删除旧 `.oidc-form__group*` chrome，只保留 `.oidc-form__row*` 布局与 test result 样式。

## 6. CSS 与响应式

优先零新增视觉 token。允许的 settings 专属 CSS 只负责 HTML/布局约束：

```css
.settings-card[disabled] {
  /* 不设 opacity；由控件原生 disabled 表达 */
}
.settings-card:is(fieldset) {
  min-inline-size: 0;
  margin: 0;
}
```

实际若不需要第一条则不落。背景、border、radius、padding、title font、hint color 全由 `.card*`、
`.settings-hint`、`.form-section__body` 提供。禁止新增 `settings-card--limits` 等视觉变体。

现有 `.form-grid--cols-2` 在仓库移动端断点已降为单列；Card title/action row 可 wrap。新增 E2E 锁：

- 390px 页面 `scrollWidth <= clientWidth`；
- card bounding box 不越 viewport；
- OIDC Dialog 内 fieldset cards 与 footer actions 可达；
- table 横向滚动留在 `.table-viewport__scroller`。

## 7. i18n

在 `settings.cardGroups` 下新增主分区卡片 title/hint；运行时 Dialog 的两组键放在 `runtimes`，
代码平台 provider hint 放在 `codeHostSettings`。OIDC 四组与系统 Agent 已有 title/hint 直接复用。

zh-CN 的 `Resources` interface 明确声明新键；en-US 与 zh-CN 对象保持 1:1。标题使用业务语言，
不暴露字段名或内部 RFC 编号。

## 8. 测试策略

### 8.1 共享 primitive

- `SettingsCard` 默认 section、visible h3、hint、actions、body rhythm；
- fieldset root、disabled 透传、`aria-labelledby` 正确；
- null hint/actions 不生成空 slot；className/testid 透传。

### 8.2 全覆盖棘轮

新增 `settings-card-surfaces.test.tsx` 或等价 source/render 组合锁：

- 11 个 `SettingsTab` 均映射到至少一张 SettingsCard；
- 分组计数/标题与 proposal 表一致；
- `AgentCard`、`page__section` code-host card、`auth-tab__header`、`oidc-form__group-title/hint`
  不得复辟；
- `SectionForm` 仍只出现一份且 Save 在 cards 后；
- runtime/OIDC Dialog 均渲染预期卡片数，OIDC busy 时 descendants disabled。

### 8.3 行为回归

继续运行并按纯 DOM 包装最小更新：

- settings drafts/system-agent/network/appearance/recovery/retention/backup tests；
- runtime list/profile/Claude tests；
- code-host settings request-body tests；
- OIDC login policy/provider/confirm/focus tests。

任何既有 request body、保存次数、mutation 顺序、revision fence 或 disabled assertion变化都视为回归，
不能以“DOM 重构”名义改判。

### 8.4 浏览器与视觉

- 现有 `settings.png`：桌面 Runtime 卡 + row nesting；
- 现有 `mobile-settings-network.png`：390px 双卡 + Save/提示；
- 新增 desktop System Agents reference：共享 primitive 必须保持基准；
- 新增 mobile OIDC dialog：fieldset cards、内部 table/dialog overflow 与 footer；
- `ux-consistency.spec.ts` 全 tab 卡片存在性、页面无 overflow；
- `a11y.spec.ts` 继续覆盖 settings 与 390 dark OIDC dialog。

## 9. 回滚

本 RFC 无 wire、DB 或持久数据变化。前端提交可整体回滚，配置值与服务端状态无需修复。不得留下
一半 shared SettingsCard、一半私有 chrome 的中间态进入 main；批次提交必须各自保持编译与测试绿。
