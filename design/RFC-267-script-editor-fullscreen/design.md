# RFC-267 · 技术设计

## 1. 当前实现锚点

| 事实                | 当前源码                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 脚本正文唯一编辑面  | `packages/frontend/src/components/canvas/inspector/ScriptEdit.tsx` 的 `scriptInspector.body` `<Field>`           |
| 公共代码编辑原语    | `packages/frontend/src/components/CodeEditor.tsx`                                                                |
| 桌面 Inspector 宽度 | `packages/frontend/src/styles.css` 的 `.editor-layout--wide/--medium.editor-layout--with-inspector`（360–420px） |
| 公共全屏层          | `packages/frontend/src/components/Dialog.tsx` + `.dialog--full`                                                  |
| 当前写入语义        | `continuousNodeInspectorChange(node.id, 'script', ...)` → workflow history → 既有 autosave                       |
| 权限判定            | `ScriptEdit.tsx` 的 `usePermission('scripts:author')`                                                            |

## 2. 组件结构

```text
ScriptEdit
└─ Field「脚本正文」
   ├─ toolbar
   │  └─ btn--xs btn--ghost「全屏编辑 / 全屏查看」
   ├─ CodeEditor（既有内嵌实例）
   └─ Dialog(size="full", panelClassName="script-code-editor-dialog")
      └─ CodeEditor(fill, 同 value / language / readOnly / onChange)
```

`Dialog` 仍由 `ScriptEdit` 本地组合，而不是新建一个只有单调用方的伪通用组件。Dialog chrome、代码编辑 chrome 与按钮样式全部复用公共原语；本 RFC 的 CSS 只负责布局尺寸。

## 3. 状态与数据流

```text
node.script ───────────────┬─► inline CodeEditor
                           └─► fullscreen CodeEditor

fullscreen onChange(next)
  └─► update({script: next}, continuousNodeInspectorChange(...))
      └─► NodeInspector.onChange
          └─► workflow definition state
              └─► existing debounced autosave
```

- 唯一新增本地状态是 `fullscreenOpen: boolean`，它不进入 workflow definition。
- 不建立 `draft` 副本；否则关闭语义会与现有即时编辑冲突，并引入 Save/Cancel 分叉。
- 两个 CodeEditor 都读取父级的 `body`。全屏修改后父级 definition 重渲染，两处值收敛；关闭时不需要复制或提交。

## 4. `CodeEditor` 最小扩展

新增向后兼容 prop：

```ts
interface CodeEditorProps {
  // existing props...
  fill?: boolean
}
```

- 缺省 `false`，现有 `minLines` / `maxLines` 行为逐字保持。
- `fill=true` 时宿主、`.cm-editor` 与 `.cm-scroller` 使用 `height: 100%` / `min-height: 0` / `max-height: none`，让 CodeMirror 接管 Dialog body 的剩余空间。
- 不以 `maxLines={1000}` 伪造全高：那会制造超长内容盒，再让 Dialog body 滚动，行号/光标与编辑器内部滚动契约都会变差。

## 5. `ScriptEdit` 改动

- `useState(false)` 管全屏开合；`useRef<HTMLButtonElement>` 交给 `Dialog.triggerRef`，保证关闭后的焦点恢复。
- 正文 `<Field>` 内增加一行右对齐 action；按钮包含内联、装饰性的 expand SVG 和完整文字，不做只有图标且靠 tooltip 的隐藏入口。
- Dialog：
  - `size="full"`；
  - `title` / 按钮按 `canAuthor` 选择「全屏编辑」或「全屏查看」；
  - `triggerRef` 指向入口；
  - 子 CodeEditor 的 `value`、`language`、`readOnly`、`onChange` 与内嵌实例同源；
  - 使用独立 test id，避免测试把内嵌与全屏实例混为一谈。
- Dialog 关闭不调用 `onHistoryBoundary`，因为它没有改变定义；正文输入仍由既有连续事务决定合并边界。

## 6. CSS 与响应式

新增布局类，不新增颜色、边框、阴影或 overlay：

- `.script-code-editor__actions`：`display:flex; justify-content:flex-end`，使用既有 spacing token。
- `.script-code-editor-dialog .dialog__body`：`overflow:hidden; min-height:0`，让 CodeEditor 自己滚动。
- `.script-code-editor-dialog__editor`：`flex:1; min-width:0; min-height:0`。
- ≤720px：只对该 panel 把 margin / border-radius 收到 0，宽高设为 `100vw / 100dvh`，padding 合并 `env(safe-area-inset-*)`。不改变其它 `dialog--full` 调用方。

桌面继续沿用公共 `.dialog--full` 的 24px 安全边距，避免浏览器边缘与关闭按钮贴死；这仍是仓内既有「全屏」定义。

## 7. 可访问性与失败模式

- 公共 Dialog 已提供 `aria-modal`、标题关联、focus trap、Esc、遮罩点击、body scroll lock 与嵌套层栈；本 RFC 不重写这些能力。
- Dialog 初始焦点按公共原语的既有策略落在 panel；点击 / 键盘进入 CodeMirror 后焦点保持在 trap 内。关闭后由 `triggerRef` 把焦点恢复到全屏入口，不私自改写公共 Dialog 的初始焦点策略。
- 无权限时 CodeMirror 同时设置 `EditorState.readOnly` 与 `EditorView.editable(false)`；全屏入口仍可用以阅读。
- 选择节点或离开页面会卸载 `ScriptEdit` 与 Dialog，本地 open 状态自然清理，不存在跨节点串稿。

## 8. 测试策略

### 单元 / 组件

新增 `packages/frontend/tests/rfc267-script-editor-fullscreen.test.tsx`：

1. 只有正文出现一枚入口，样例不出现；
2. 点击后存在 full Dialog 与 full-height CodeEditor，value / language 正确；
3. 直接驱动真实 CodeMirror `EditorView`，断言 `onPatch` 只触发一次、收到新 script 与 `continuous` history meta，并锁住双编辑器受控值同步不会回声成第二次历史写入；
4. 关闭后内容由父级定义保持，Esc 后焦点回 trigger；
5. `scripts:author=false` 时文案改为查看且两实例 `readOnly`；
6. CSS 源码锁住 Dialog body 的 flex/min-height/overflow 与 390px full-viewport 规则；
7. RFC-198 overlay 双向清单登记该公共 Dialog 调用面。

### 真实浏览器

- 1536×960：选中脚本节点 → 打开全屏 → 输入长行 → 截图，确认可用宽高、关闭按钮、主题与不溢出。
- 390×844：打开全屏 → 检查 panel bounding box 等于 visual viewport、横向无页面滚动、触控目标 ≥36px。
- 键盘：进入编辑器 → Esc → trigger focus restore。

### 门禁

- 定向 frontend test；
- `bun run typecheck` / `bun run lint` / `bun run format:check`；
- 完整 `bun run gate:local` 在实现收口时执行。
