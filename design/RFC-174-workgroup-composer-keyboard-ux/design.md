# RFC-174 — 技术设计

> Codex 设计门（对抗评审）一轮：4 P1 + 3 P2 + 1 P3 全部折入本文（§2 修饰键守卫 / 优先级、§3 状态机与 a11y、§6 测试契约）。仓内 `Select.tsx` 早前经同一评审修好等价问题（其 `select-searchable.test.tsx` 的 `S5`/`S6` 用例即标注「Codex P1/P2」），本设计镜像其成熟解法。

## 1. 改动面总览

纯前端，无后端 / 无 migration。四个文件：

| 文件                                                           | 改动                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/frontend/src/lib/workgroup-room.ts`                  | 新增纯键盘 oracle `resolveComposerKey`（含修饰键守卫）+ 平台修饰键标签 `sendChordModLabel`。                                                                                                                                                                 |
| `packages/frontend/src/components/workgroup/WorkgroupRoom.tsx` | composer wire：`activeIndexRaw` / `dismissed` / `composerFocused` state、textarea `onKeyDown`/`onFocus`/`onBlur`、a11y 属性、候选 `<li role="option">` 化 + 高亮、pending-caret layout effect、发送后焦点恢复、可见提示；快速回复框同款 `onKeyDown` + 提示。 |
| `packages/frontend/src/styles.css`                             | `.workgroup-room__mentions li` 选项样式 + `.is-active` 高亮（镜像 `.select__option--active`）+ `.workgroup-room__composer-hint` 间距。                                                                                                                       |
| `packages/frontend/src/i18n/zh-CN.ts` + `en-US.ts`             | `workgroups.room.composerShortcutHint`（带 `{{mod}}`）+ `deliverShortcutHint` + `mentionsAria`（已有）。                                                                                                                                                     |

## 2. 纯键盘 oracle（单一可断言面）

沿用本仓既有先例 `lib/review/multiDocHotkeys.ts`：把「键 → 动作」映射抽成纯函数，测试不渲染组件。**关键：像 `multiDocHotkeyAction` 一样对修饰键严格设防**——绝不吞掉 `Shift+Arrow`（选区）、`Ctrl+Tab`（切标签）、`Shift+Tab`（回退焦点）、`Cmd+Arrow`（行首尾）等原生 / 系统组合。

```ts
export type ComposerKeyAction =
  | { type: 'send' } // Cmd/Ctrl+Enter（仅下拉关闭时）— 发送
  | { type: 'mention-move'; index: number } // ↑/↓（无修饰键）— 新高亮索引
  | { type: 'mention-commit'; index: number } // Enter/Tab — 选中该候选
  | { type: 'mention-close' } // Esc — 关下拉
  | { type: 'default' } // 交给 textarea 默认（Enter=换行等）

export interface ComposerKeyState {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing: boolean // 组件传 e.nativeEvent.isComposing || keyCode===229
  mentionOpen: boolean // 下拉当前是否可见（已含焦点/可用态/未 dismiss，见 §3.1）
  candidateCount: number
  activeIndex: number // 组件已 clamp 到 [0, count)
}

export function resolveComposerKey(s: ComposerKeyState): ComposerKeyAction {
  // (1) IME 守卫：组字期间任何键都交给输入法，绝不拦截（G5 / AC5）。
  if (s.isComposing) return { type: 'default' }
  const noMods = !s.metaKey && !s.ctrlKey && !s.altKey && !s.shiftKey
  // (2) 下拉打开时：mention UI 拥有它的按键（含发送和弦）——所以 Cmd/Ctrl+Enter
  //     在打开时只“提交候选”，绝不把未提交的 "@query" 发出去（P1-2 / AC4）。
  if (s.mentionOpen && s.candidateCount > 0) {
    if (s.key === 'ArrowDown' && noMods)
      return { type: 'mention-move', index: (s.activeIndex + 1) % s.candidateCount }
    if (s.key === 'ArrowUp' && noMods)
      return {
        type: 'mention-move',
        index: (s.activeIndex - 1 + s.candidateCount) % s.candidateCount,
      }
    if (s.key === 'Escape' && noMods) return { type: 'mention-close' }
    if (s.key === 'Tab' && noMods) return { type: 'mention-commit', index: s.activeIndex }
    // Enter 提交：plain Enter 或发送和弦（Cmd/Ctrl+Enter）都提交；Shift/Alt+Enter
    // 落到 default（换行），不提交。
    if (s.key === 'Enter' && !s.shiftKey && !s.altKey)
      return { type: 'mention-commit', index: s.activeIndex }
    return { type: 'default' } // 其余键：继续打字 / 收窄 query
  }
  // (3) 下拉关闭：发送和弦 = Enter + 恰好 Cmd/Ctrl（无 Shift/Alt）。
  if (s.key === 'Enter' && (s.metaKey || s.ctrlKey) && !s.shiftKey && !s.altKey)
    return { type: 'send' }
  // (4) 其余（含 plain Enter = 换行）。
  return { type: 'default' }
}
```

**优先级即代码顺序**：`IME 守卫 ＞ 下拉打开时 mention 按键（含把 Cmd/Ctrl+Enter 当提交）＞ 下拉关闭时发送和弦 ＞ 默认换行`。这条链同时消除：误发（plain Enter 永不发送、下拉开时 Cmd/Ctrl+Enter 提交而非发送）、误吞编辑键（修饰键守卫）、发出未提交 `@query`（P1-2）。

`sendChordModLabel(): '⌘' | 'Ctrl'`——`typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)` 判 mac 返 `'⌘'`，否则（含 SSR / jsdom / 非 mac）返 `'Ctrl'`。

## 3. 组件 wire（`WorkgroupRoom`）

### 3.1 state 与下拉可见性（含 dismiss token-session、焦点/可用态门）

新增 state：`activeIndexRaw`（默认 0）、`dismissed: MentionContext | null`（Esc 关闭的 token 会话，默认 null）、`composerFocused: boolean`。

```ts
const mentionCtx = mentionQueryAt(draft, caret)
const rawSuggestions =
  mentionCtx === null || room.data === undefined
    ? []
    : mentionCandidates(room.data.config, mentionCtx.query)

// dismiss 绑定「被关的那个 token 会话」= 同 start 且同 query（P1-3）。
// → 继续打字 query 变 ⇒ 重新弹出（AC3）；移到别的 token（start 变）⇒ 不受影响。
const isDismissed =
  mentionCtx !== null &&
  dismissed !== null &&
  dismissed.start === mentionCtx.start &&
  dismissed.query === mentionCtx.query

// 下拉可见还需：composer 有焦点、任务可发帖、无发送在途（P1-3）。
const mentionOpen =
  rawSuggestions.length > 0 && !isDismissed && composerFocused && canPost && !send.isPending
const suggestions = mentionOpen ? rawSuggestions : []

// 派生 clamp：stale index 永不越界 deref（P1-3）。
const activeIndex =
  suggestions.length === 0 ? 0 : Math.min(Math.max(activeIndexRaw, 0), suggestions.length - 1)

// query 变化把高亮复位到最佳匹配（主流 @ 行为）。
useEffect(() => {
  setActiveIndexRaw(0)
}, [mentionCtx?.query])
```

`onChange` 无需再手动清 dismiss——`isDismissed` 按 `{start,query}` 派生，query 一变即自然失配重开。

### 3.2 textarea `onKeyDown` / `onFocus` / `onBlur`

```ts
onFocus={() => setComposerFocused(true)}
onBlur={() => setComposerFocused(false)} // onMouseDown preventDefault 保证点候选不先 blur
onKeyDown={(e) => {
  const action = resolveComposerKey({
    key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey,
    isComposing: e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229,
    mentionOpen, candidateCount: suggestions.length, activeIndex,
  })
  switch (action.type) {
    case 'send':
      e.preventDefault() // 无条件（P2-1：即便空草稿也别插换行）
      if (canPost && !send.isPending && draft.trim().length > 0) {
        sendFromKbdRef.current = true // settle 后恢复焦点（P2-2）
        send.mutate(draft.trim())
      }
      break
    case 'mention-move': e.preventDefault(); setActiveIndexRaw(action.index); break
    case 'mention-commit': {
      e.preventDefault()
      const target = suggestions[action.index] ?? suggestions[0] // 判空（P1-3）
      if (target) commitMention(target.displayName)
      break
    }
    case 'mention-close': e.preventDefault(); setDismissed(mentionCtx); break
    case 'default': break // Enter=换行 等原生
  }
}}
```

- 发送后焦点：`send` mutation 的 `onSettled` 里 `if (sendFromKbdRef.current) { sendFromKbdRef.current = false; inputRef.current?.focus() }`（textarea pending 时 disabled 会丢焦点，P2-2）。
- `commitMention` 改用 pending-caret：`applyMention` 算出的新 caret 存入 `pendingCaretRef`，用 `useLayoutEffect(() => { if (pendingCaretRef.current!=null && inputRef.current){ inputRef.current.setSelectionRange(pendingCaretRef.current, pendingCaretRef.current); pendingCaretRef.current=null } }, [draft])`——在 controlled value 落 DOM 后再设 selection（P2-2，取代当前同步 setSelectionRange 的时序隐患）。提交后 `setActiveIndexRaw(0)`。

### 3.3 a11y（textbox + active-descendant，非 combobox）

多行 `<textarea>` 不能是 combobox（combobox 仅单行），故**保持隐式 `textbox` 角色、不加 `aria-expanded`**（P1-4：`aria-expanded` 非 textbox 合法状态）。用 active-descendant 关系把弹层挂上去：

- textarea：`aria-autocomplete="list"`、`aria-controls={listboxId}`、`aria-activedescendant={mentionOpen ? optionId(activeIndex) : undefined}`（关闭时不指向 stale id，F8）。
- `<ul role="listbox" id={listboxId} aria-label={t('workgroups.room.mentionsAria')}>`（已有 role/label，补 `id`）。
- 每个候选**改为 `<li>` 直接承担 option**（镜像 `Select.tsx:243`，去掉内层 `<button>`——active-descendant 模型下弹层子项不应进 Tab 序列，P1-4）：
  ```tsx
  <li
    role="option"
    id={optionId(i)}
    aria-selected={i === activeIndex}
    className={`workgroup-room__mention${i === activeIndex ? ' is-active' : ''}`}
    onMouseEnter={() => setActiveIndexRaw(i)}
    onMouseDown={(e) => e.preventDefault()} // 保持 textarea 焦点
    onClick={() => commitMention(m.displayName)}
    data-testid={`wg-mention-${m.displayName}`}
  >
    @{m.displayName}
    {m.roleDesc !== '' && <span className="muted"> · {m.roleDesc}</span>}
  </li>
  ```
  `data-testid` 留在 `<li>`，既有 `fireEvent.click(getByTestId('wg-mention-Worker'))` 点选测试零改动（AC9）。`optionId(i) = \`${listboxId}-opt-${i}\``，`listboxId = useId()`。

### 3.4 可见快捷键提示（G3 / AC7）

composer-row 下方（仅可发帖时），**复用既有 `form-field__hint`**（`color: var(--muted); font-size: 12px`，与终态 `terminalNotice` 同款，UI 一致性）：

```tsx
{
  canPost && (
    <div
      className="form-field__hint workgroup-room__composer-hint"
      data-testid="workgroup-room-shortcut-hint"
    >
      {t('workgroups.room.composerShortcutHint', { mod: sendChordModLabel() })}
    </div>
  )
}
```

文案（镜像既有 `shortcutHint: '↑/↓ 切换文件 · Q 采纳 · W 不采纳'` 的 `·` 分隔约定）：

- zh：`'{{mod}}+Enter 发送 · Enter 换行 · @ 提及成员'`
- en：`'{{mod}}+Enter to send · Enter for newline · @ to mention'`

终态任务分支仍走既有 `terminalNotice`（互斥，`!canPost` 时不显示快捷键提示）。

### 3.5 快速回复框（G4 / AC8）

`DispatchCard` 的快速回复 `<textarea>`（`wg-card-quick-input-*`）加 `onKeyDown`，复用 `resolveComposerKey` 但 `mentionOpen:false`（该框无 `@` 补全），故只会返回 `send` 或 `default`：

```ts
onKeyDown={(e) => {
  const a = resolveComposerKey({
    key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey,
    isComposing: e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229,
    mentionOpen: false, candidateCount: 0, activeIndex: 0,
  })
  if (a.type === 'send') {
    e.preventDefault() // 无条件（P2-1）
    if (!delivering && quickText.trim().length > 0) {
      void onDeliver(assignment.id, { kind: 'quick', body: quickText }).then(() => {
        setQuickOpen(false); setQuickText('')
        quickToggleRef.current?.focus() // 交付后 textarea 卸载，焦点回 toggle 按钮（P2-2）
      })
    }
  }
}}
```

快捷键门与既有「快速回复」提交按钮**同一判据**（`!delivering && quickText.trim()`）——快捷键不新增任何终态逻辑，其能力恰等于按钮（澄清 AC6 归属，见 proposal）。下方加 `form-field__hint` 变体 `deliverShortcutHint`（只含发送 / 换行，无 `@` 段）。

## 4. CSS

候选从 `button` 改 `li` 后重定位样式（去掉旧 `.workgroup-room__mentions button` 规则）：

```css
.workgroup-room__mentions li {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 8px;
  border-radius: 6px;
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
  list-style: none;
}
.workgroup-room__mentions li.is-active,
.workgroup-room__mentions li:hover {
  background: color-mix(in srgb, var(--accent) 12%, transparent); /* 同 .select__option--active */
}
.workgroup-room__composer-hint {
  margin-top: 4px;
} /* 配色/字号由复用的 .form-field__hint 提供 */
```

颜色走 `--accent`/`--muted`/`--text` 变量，明暗双主题自动适配，无需分支。

## 5. 失败模式 / 边界

| #   | 场景                                      | 处理                                                                                                                                                                                    |
| --- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | 中文输入法组字中按 Enter 误发 / 误选      | oracle 第 1 条 `isComposing` 守卫；组件读 `e.nativeEvent.isComposing \|\| keyCode===229`（旧浏览器 229 语义）。已由 `select-searchable.test.tsx:64` 证明 happy-dom 透传 `isComposing`。 |
| F2  | Enter 三义冲突（选中 / 换行 / 发送）      | oracle 优先级：下拉开=提交（含 Cmd/Ctrl+Enter）＞下拉关+Cmd/Ctrl=发送＞plain=换行。plain Enter 永不发送。                                                                               |
| F3  | 修饰键吞掉编辑 / 系统快捷键               | 导航 / Tab / Esc 仅 `noMods`；发送仅 `Enter+(Cmd\|Ctrl)` 且无 Shift/Alt；`Shift+Arrow`/`Ctrl+Tab`/`Shift+Tab`/`Cmd+Arrow` 一律放行（P1-1）。                                            |
| F4  | 候选变少后 activeIndex 越界               | 派生 clamp `Math.min(activeIndexRaw, count-1)`；query 变复位 0；commit 前 `?? suggestions[0]` 判空（P1-3）。                                                                            |
| F5  | Esc 关闭后想重新补全 / 跨 token           | dismiss 绑 `{start,query}`：同 token 继续打字 query 变即重开（AC3）；移到别 token（start 变）不受影响（P1-3）。                                                                         |
| F6  | 弹层未随焦点 / 可用态关闭                 | `mentionOpen` 且 `composerFocused && canPost && !send.isPending`；blur 关闭（P1-3）。                                                                                                   |
| F7  | 发送 pending 后焦点丢失 / 提交 caret 时序 | `sendFromKbdRef` settle 后恢复焦点；`pendingCaretRef` + `useLayoutEffect` 在 value 落 DOM 后设 selection（P2-2）。                                                                      |
| F8  | 屏幕阅读器指向 stale option               | `aria-activedescendant` 仅 `mentionOpen` 时设置；无 `aria-expanded`（textbox 合法性，P1-4）。                                                                                           |
| F9  | 鼠标点选路径回归                          | `<li>` 保留 `onMouseDown preventDefault` + `onClick commit` + `data-testid`；`onMouseEnter` 只更新高亮（AC9）。                                                                         |
| F10 | 平台修饰键显示错误                        | `sendChordModLabel` mac→⌘ 其余→Ctrl；`navigator` 不可用默认 Ctrl。                                                                                                                      |

## 6. 测试策略

**纯 oracle（`workgroup-room-lib.test.ts` 增 `describe('resolveComposerKey')`）——权威锁**（修饰键矩阵是重点）：

- IME：`isComposing:true` + 任意键（Enter、Cmd+Enter、ArrowDown）→ `default`。
- 发送（下拉关）：`Enter+meta`→`send`、`Enter+ctrl`→`send`；`Enter+ctrl+shift`→`default`、`Enter+meta+alt`→`default`（修饰键守卫，P1-1）；plain `Enter`→`default`（换行，不发送，AC4）。
- 下拉开的发送和弦：`mentionOpen` + `Enter+ctrl`/`Enter+meta`→`mention-commit`（不发送，P1-2）。
- 导航：`ArrowDown`/`ArrowUp` 回环；带修饰键的 `Shift+ArrowDown`/`Cmd+ArrowUp`→`default`（不劫持选区/移动，P1-1）。
- 选中：下拉开 `Enter`(noMods)→`mention-commit`；`Tab`(noMods)→`mention-commit`；`Shift+Tab`→`default`、`Ctrl+Tab`→`default`（P1-1）；`Shift+Enter`/`Alt+Enter`→`default`。
- 关闭：`Escape`(noMods)→`mention-close`。
- `sendChordModLabel()` → `'⌘'` 或 `'Ctrl'`（jsdom/happy-dom 默认 `'Ctrl'`）。

**组件（`workgroup-room.test.tsx` 增 case）——逐 AC 硬断言**（不降级为源码断言；IME 照 `select-searchable.test.tsx:64` 写死）：

- AC1：`@Wo` 后 textarea `aria-controls` 指向 listbox、`aria-activedescendant` 指向有效 option id；两次 `ArrowDown` 实际移动高亮（`aria-selected`/`is-active` 落到正确项）。
- AC2：`ArrowDown`→`Enter` 提交为 `@Worker `；`Tab` 亦提交。
- AC3：`Escape` 关闭下拉、`draft` 保留；随后 `fireEvent.change` 继续打字下拉重开。
- AC4：`Cmd/Ctrl+Enter`（下拉关）触发 POST `/messages` 且清空草稿；**plain `Enter` 不触发 POST 且 `event.defaultPrevented===false`**（换行）。
- AC5：`fireEvent.keyDown(input,{key:'Enter',ctrlKey:true,isComposing:true})` 既不发送也不提交。
- AC6：空草稿 / `send.isPending` 时 `Cmd/Ctrl+Enter` 不发送。
- AC7：`workgroup-room-shortcut-hint` 含「发送」「换行」文案；stub `navigator.platform`（mac / 非 mac）断言 `⌘` / `Ctrl` 分支 + fallback。
- AC8：快速回复框 `Cmd/Ctrl+Enter` 触发 deliver、plain `Enter` 不触发；提示存在。

**回归防护**：既有「clicking a suggestion commits」「send POSTs {body}」「terminal disables」case 保持绿；`workgroup-room-composer-outline-clip.test.ts` 保持绿（提示是 composer 内新行，若断言受影响则同步更新）。

**门禁**：`bun run typecheck && bun run lint && bun run test`（前端 vitest）`&& bun run format:check` 全绿；`bun run build:binary` 冒烟；推后查 CI（feedback_post_commit_ci_check）。Codex 实现门（impl gate）跑一轮折 findings。

## 7. 与并发工作的边界

- RFC-173（`agent-resources-multiselect-redesign`，他人未追踪 WIP）与本 RFC **零交集**（不同页面、不同文件）；提交按精确 pathspec，绝不 `git add -A`。
- `WorkgroupRoom.tsx` / `lib/workgroup-room.ts` / `styles.css` / i18n 若届时有他人未提改动，按 feedback_mixed_file_cross_dep_commit 核对交叠 hunk 再精确提交。
