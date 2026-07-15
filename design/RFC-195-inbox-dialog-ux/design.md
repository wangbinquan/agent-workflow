# RFC-195 — 技术设计

## 1. 当前实现与不变量

### 1.1 当前文件

| 面           | 当前实现                                                                                | 本 RFC 约束                                   |
| ------------ | --------------------------------------------------------------------------------------- | --------------------------------------------- |
| 入口         | `components/shell/InboxFooterButton.tsx`                                                | 三源 count failure-soft 语义不变              |
| 浮层         | `components/shell/InboxDrawer.tsx` 自建 portal / ESC / outside click                    | 业务组件保留文件名，chrome 改走共享 `Dialog`  |
| open state   | `stores/inbox.ts` module store                                                          | 不持久化、不换状态库                          |
| root wiring  | `routes/__root.tsx`                                                                     | 增 trigger ref；auth / nav 结构不动           |
| UI primitive | `Dialog` / `Segmented` / `EmptyState` / `LoadingState` / `ErrorBanner` / `RelativeTime` | 必须复用                                      |
| CSS          | `styles.css` `.inbox-drawer__*`                                                         | 原地重写业务样式，不新造 overlay/panel chrome |
| i18n         | `nav.inbox.*` zh/en                                                                     | 对称增键，既有 key 能复用则复用               |
| tests        | `inbox-drawer.test.tsx`、`inbox-footer-button.test.tsx`、nav e2e                        | 行为测试随改动同步                            |

### 1.2 必须保持的不变量

- review query：`['reviews','inbox','pending']`；clarify query：
  `['clarify','inbox','pending']`；workgroup query：`['workgroup-tasks','pending-count']`。
- 三个 query 仅在 `open` 时 enabled，15 秒轮询。
- review route `/reviews/$nodeRunId`、clarify route `/clarify/$nodeRunId`、workgroup 汇总 route
  `/tasks` 不变。
- clarify `rowKey=c.id`、导航 id=`intermediaryNodeRunId` 的 RFC-058/RFC-051 契约不变。
- memory / fusion 完全不回流；FooterButton 的三源计数与 Drawer 的三源内容保持同域。
- query error failure-soft；任一 feed 失败不移除其他 feed 的可见内容。

## 2. 组件结构

```text
RootComponent
├─ InboxFooterButton ref={inboxTriggerRef}
└─ InboxDrawer triggerRef={inboxTriggerRef}
   └─ Dialog
      ├─ shared header (title + close)
      ├─ InboxSummary
      ├─ Segmented<InboxTab>
      ├─ InboxFeedErrors (ErrorBanner × failed visible feed)
      ├─ LoadingState | EmptyState | InboxItemList
      │  ├─ WorkgroupSummaryRow (all only)
      │  └─ InboxItemRow × N
      └─ shared footer
         ├─ all reviews
         └─ all clarify
```

`InboxDrawer` 名称暂不改，避免无价值的文件/测试/导入 churn；对用户呈现统一称“收件箱弹窗”。

## 3. Dialog 接线

```tsx
<Dialog
  open={open}
  onClose={onClose}
  title={t('nav.inbox.label')}
  triggerRef={triggerRef}
  initialFocusRef={selectedOptionRef}
  panelClassName="inbox-dialog"
  data-testid="inbox-drawer"
  footer={<InboxFooter />}
>
  {/* business body */}
</Dialog>
```

### 3.1 trigger ref

`InboxFooterButton` 改为 `forwardRef<HTMLButtonElement, Props>`；`RootComponent` 用一个
`useRef<HTMLButtonElement>(null)` 同时传给 button 与 drawer。首页入口打开收件箱时，关闭后同样
回到全局收件箱按钮，这是合理且稳定的 fallback。

### 3.2 selected option 初始焦点

共享 `Segmented` 当前不暴露 option ref。做向后兼容最小扩展：

```ts
interface SegmentedProps<V extends string> {
  activeOptionRef?: RefObject<HTMLButtonElement | null>
}
```

仅把 ref 挂到 `active` option；InboxDrawer 把该 ref 传给 Dialog 的 `initialFocusRef`，解决“选中
clarify、焦点却落 all”的现有错位。实现门同时补齐共享 radio group 的 roving `tabIndex` 与
方向键/Home/End 选择模型；鼠标点击与 active reselect 既有语义保持不变。

## 4. 响应式视觉

业务 panel class 只覆盖布局，不重写 shared chrome：

```css
.inbox-dialog.dialog__panel {
  position: fixed;
  left: calc(220px + var(--space-3));
  top: 50%;
  width: min(420px, calc(100vw - 220px - 2 * var(--space-3)));
  height: auto;
  max-height: min(680px, calc(100dvh - 2 * var(--space-4)));
  transform: translateY(-50%);
}

@media (max-width: 720px) {
  .inbox-dialog.dialog__panel {
    inset: 0;
    width: 100vw;
    height: 100dvh;
    transform: none;
    border: 0;
    border-radius: 0;
    padding-bottom: max(var(--space-4), env(safe-area-inset-bottom));
  }
}
```

规则目标是边界不溢出，不依赖 JS viewport 判断。shared overlay 继续覆盖整个 viewport；panel 内只有
`.dialog__body` 滚动，header/footer 固定可达。

## 5. 纯派生模型

新建 `packages/frontend/src/lib/inbox-view.ts`，把排序、计数与状态判断从 JSX 抽出。

```ts
export type InboxTab = 'all' | 'reviews' | 'clarify'

export interface InboxFeedSnapshot<T> {
  data: readonly T[] | undefined
  isInitialLoading: boolean
  error: unknown | null
}

export interface InboxViewModel {
  items: readonly InboxItem[]
  workgroupTotal: number
  counts: {
    all?: number
    reviews?: number
    clarify?: number
  }
  state: 'loading' | 'error' | 'empty' | 'content'
  partial: boolean
}
```

`deriveInboxViewModel` 输入 tab + 三 feed snapshot，输出：

- `items`：只含当前 tab 的 review/clarify，按 `createdAt desc`；
- `workgroupTotal`：仅 `all` 可见；
- `counts`：只有对应 feed 成功拿到 data 时才定义，避免 error 显示 0；
- `loading`：当前可见 feed 中至少一个首次加载，且没有任何可展示内容；
- `error`：当前可见 feed 全失败且没有缓存内容；
- `empty`：所有当前可见 feed settled、零错误、零内容；
- `content`：至少有一个 item/workgroup action；此时 error 通过 `partial=true` 叠加提示。

### 5.1 真值表

| 可见内容 | initial loading | error                   | 结果                    |
| -------- | --------------- | ----------------------- | ----------------------- |
| 0        | 是              | 否                      | loading                 |
| 0        | 否              | 全部                    | error                   |
| 0        | 否              | 部分                    | error（不是 empty）     |
| 0        | 否              | 无                      | empty                   |
| >0       | 任意            | 部分/全部 refetch error | content + partial error |
| >0       | 任意            | 无                      | content                 |

workgroup feed 只在 `all` 进入判定；`reviews` / `clarify` tab 不因隐藏 feed 的 loading/error 改变状态。

## 6. Item view model 与渲染

```ts
interface InboxItem {
  kind: 'review' | 'clarify'
  rowKey: string
  navigationId: string
  taskId: string
  taskName: string
  title: string
  context: string
  createdAt: number
}
```

- review `context=workflowName`；
- clarify `context=asking agent + shard/iteration`；
- task name 单独作为 source；task id 放 source element `title`；
- `<RelativeTime ts={createdAt}>` 复用 RFC-191 的相对/绝对双口径；
- title CSS 用两行 clamp，source/context 用单行 ellipsis，任何 128 字符 fixture 不撑宽 panel；
- button 保留原 testid 命名，并让类型、title、taskName、relative time 与 context 共同形成自然
  accessible name，避免整行 `aria-label` 覆盖后代信息。

workgroup summary 没有时间戳，不伪造时间；它固定出现在 all 列表顶部，下面才是按时间排序的两类行。

## 7. 错误、空态与加载

### 7.1 ErrorBanner 最小扩展

`ErrorBanner` 增可选 `message?: string`、`action?: ReactNode`：

- `message` 提供 feed-specific i18n；未传时现有 error 解析完全不变；
- `action` 在右侧承载 `.btn .btn--xs` 重试；未传时现有 DOM 与视觉不变；
- 根节点补 `role="alert"`，新增 `.error-banner--with-action` 只在有 action 时 flex 布局。

Inbox 每个失败 feed 单独一个 banner，单独 `refetch()`；不造 `ErrorRow` 私有 primitive。

### 7.2 EmptyState

`<EmptyState size="compact">`：

- title：`nav.inbox.empty`；
- description：`nav.inbox.emptyHint`；
- icon：复用 inbox 线性 SVG（抽成 `InboxIcon` export 或同文件纯图标，不复制 path）。

### 7.3 LoadingState

`<LoadingState size="compact" label={t('nav.inbox.loading')}>`。已存在缓存数据的后台 refetch 不切回
loading，避免 15 秒一次的布局闪烁。

## 8. 导航与关闭顺序

统一 helper：

```ts
function navigateAndClose(target: NavigateOptions): void {
  onClose()
  void navigate(target)
}
```

先同步 close，再发起 SPA navigation，避免新路由 mount 时 Dialog focus trap 抢焦点。review、clarify、
workgroup、两个 footer 入口全部走同一 helper。导航目标与参数不改。

## 9. i18n

`nav.inbox` zh/en 对称新增：

- `subtitle`
- `partial`
- `loading`
- `emptyHint`
- `total`
- `openReviewsShort`
- `openClarifyShort`
- `itemAria`
- `workgroupItemAria`

现有 `openReviews/openClarify` 若最终文案可直接缩短则原 key 原地改值，避免同义死键；实现时以
最少新增为准。`sourceTask` 保留给其他调用方/tooltip，是否可删除先全仓 grep 后决定。

## 10. 文件变更

| 文件                                     | 改动                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `components/shell/InboxDrawer.tsx`       | 迁共享 Dialog/Segmented/三态/新行/统一导航                            |
| `components/shell/InboxFooterButton.tsx` | forwardRef；InboxIcon 可复用导出                                      |
| `components/Dialog.tsx`                  | 不改                                                                  |
| `components/Segmented.tsx`               | 可选 activeOptionRef 最小扩展                                         |
| `components/ErrorBanner.tsx`             | 可选 message/action + alert 语义                                      |
| `routes/__root.tsx`                      | trigger ref 接线                                                      |
| `lib/inbox-view.ts`                      | 新增纯派生模型                                                        |
| `styles.css`                             | 原地重写 `.inbox-drawer__*` 业务样式 + responsive；不造 overlay/panel |
| `i18n/{zh-CN,en-US}.ts`                  | 对称文案                                                              |
| `tests/inbox-view.test.ts`               | 新增状态/排序/count 表测                                              |
| `tests/inbox-drawer.test.tsx`            | 更新交互/a11y/导航/三态测试                                           |
| `tests/segmented.test.tsx`               | activeOptionRef 契约                                                  |
| `tests/error-banner.test.tsx`            | message/action/旧路径                                                 |
| `e2e/nav-redesign.spec.ts`               | empty dialog + ESC + focus restore + 390px 边界                       |
| `e2e/visual-regression.spec.ts`          | 新增 inbox empty/populated desktop baseline（nightly）                |

## 11. 测试策略

### 11.1 纯函数

- review/clarify 混排按时间 desc；同 timestamp 保持稳定顺序；
- all/reviews/clarify 三 filter；
- counts 成功才定义，workgroup 只计 all；
- §5.1 六行状态真值表；
- partial error 不吞 items；workgroup loading/error 只影响 all；
- 128 字符数据不在模型层截断（完整文案留给 tooltip/a11y，CSS 负责视觉截断）。

### 11.2 组件

- `open=false` 零 DOM；`open=true` 有 heading、`aria-modal=true`、close button；
- 当前 selected segmented option 获初始焦点；ESC/outside 关闭并恢复 trigger；
- filter/count、workgroup summary、RelativeTime、task name/context 渲染；
- review/clarify/workgroup/footer 五类导航均先 close；
- loading / partial error / all error / empty / content；feed retry 只 refetch 对应源；
- RFC-121 fusion/memory 零请求零 DOM；clarify duplicate nodeRunId 仍以 session id 唯一；
- 长标题/长 task name test fixture + class contract；
- 不再出现 `createPortal` / document-level ESC / `.inbox-drawer` 自建 role dialog 的源码锁。

### 11.3 e2e / visual / a11y

- clean daemon empty inbox：打开、标题/空态、ESC、focus restore；
- 390×844：`left>=0 && right<=viewport && width<=viewport`，footer 可见；
- Playwright route fulfill 三 feed 造 populated screenshot：light desktop + dark desktop；
- axe 在 opened dialog 上零 critical/serious；
- visual nightly 增 `inbox-empty` / `inbox-populated` 两基线，Linux 基线按仓库 Option B artifact 回填。

## 12. 风险与处置

| 风险                                   | 处置                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Dialog modal trap 与路由导航抢焦点     | close 同步先于 navigate；组件测试锁顺序                                                        |
| 首页入口不是 footer trigger            | triggerRef 恒指向全局 footer button，关闭回落稳定                                              |
| 共享 Segmented 扩展影响其他调用方      | optional ref + 标准 radio 方向键/roving tabindex；既有 suite 全跑                              |
| partial error 被误报 empty             | 纯函数真值表，不在 JSX 临时拼条件                                                              |
| workgroup 一个 summary row 代表 N 件事 | 数量徽标 + breakdown + aria 明示，all count 用 actionable total                                |
| 当前多人修改 `styles.css` / i18n       | inbox CSS 位于约 1520 行、并行 gallery hunks 位于文件尾；只做局部 apply_patch，提交前复核 diff |
| visual baseline 平台漂移               | darwin 本地生成；linux 走已确立的 CI artifact 回填，不伪造                                     |

## 13. 回滚

单 PR、零数据迁移。回滚该 commit 即恢复旧 Drawer；query keys、routes、store、API 均未变，不需要数据或
配置回滚。
