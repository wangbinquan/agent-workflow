# RFC-174 — 任务分解

单 PR（纯前端）。commit 前缀 `feat(frontend): RFC-174 …`。

## 子任务

| ID             | 任务                           | 依赖        | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------- | ------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **RFC-174-T1** | 纯键盘 oracle（含修饰键守卫）  | —           | `lib/workgroup-room.ts` 新增 `resolveComposerKey`（state 含 `altKey`；优先级 IME＞下拉开 mention 按键＞下拉关发送和弦＞默认；导航/Tab/Esc 仅 `noMods`、发送仅 `Enter+(Cmd\|Ctrl)` 无 Shift/Alt）+ `sendChordModLabel`；在 `workgroup-room-lib.test.ts` 加 `describe('resolveComposerKey')` 全矩阵（§6 纯 oracle 清单，**修饰键矩阵为重点**）。**先红后绿**。                                                                                                                                                                                                                                                                   |
| **RFC-174-T2** | composer 键盘 wire + a11y      | T1          | `WorkgroupRoom` 加 `activeIndexRaw`/`dismissed(MentionContext)`/`composerFocused` state、textarea `onKeyDown`/`onFocus`/`onBlur` 分派、派生 `mentionOpen`（focus+canPost+!pending+token-session dismiss）+ 派生 clamp `activeIndex`；`aria-autocomplete`/`aria-controls`/`aria-activedescendant`（**不加 `aria-expanded`**，textbox 合法性）；候选 `<li role="option">` 化（去内层 button，`id`/`aria-selected`/`is-active`/`onMouseEnter`/`onMouseDown` preventDefault/`onClick`/`data-testid` 留 li）；query 变复位 activeIndex；`pendingCaretRef` + `useLayoutEffect` 提交 caret；`sendFromKbdRef` 发送 settle 后恢复焦点。 |
| **RFC-174-T3** | 可见快捷键提示 + i18n          | T2          | composer-hint 复用 `form-field__hint`（`composerShortcutHint` 带 `{{mod}}`）；`i18n/zh-CN.ts` + `en-US.ts` 加 key（含类型声明）+ `deliverShortcutHint`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **RFC-174-T4** | 快速回复框同款                 | T1          | `DispatchCard` 快速回复 `<textarea>` 加 `onKeyDown`（`mentionOpen:false`，send 无条件 `preventDefault`、门＝`!delivering && 非空`，成功后焦点回 toggle 按钮）+ `deliverShortcutHint` 提示。                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **RFC-174-T5** | CSS                            | T2          | `styles.css`：候选 `button`→`li` 重定位样式 + `.workgroup-room__mentions li.is-active`/`:hover` 高亮（镜像 `.select__option--active`）+ `.workgroup-room__composer-hint` 间距；明暗双主题走变量。                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **RFC-174-T6** | 组件测试 + 门禁 + Codex 实现门 | T2,T3,T4,T5 | `workgroup-room.test.tsx` 加**逐 AC 硬断言**（§6 组件清单：AC1 controls/有效 active id/多候选移动、AC2 Tab+修饰键放行、AC3 保留+重开、AC4 plain Enter `defaultPrevented===false`、AC5 IME 照 `select-searchable.test.tsx:64` 写死、AC6 空/pending、AC7 平台 stub ⌘/Ctrl/fallback、AC8 快速回复）；跑 typecheck/lint/test/format + build smoke；Codex impl gate 折 findings；推后查 CI。                                                                                                                                                                                                                                        |

## PR 拆分建议

单 PR 交付 T1–T6。理由：纯前端、改动集中在 `WorkgroupRoom` + 其纯逻辑层，oracle 与 wire 强耦合，拆开无收益。

## 验收清单（= proposal AC1–AC9）

- [ ] AC1 `@` 导航 + `aria-selected`/`aria-activedescendant`/`aria-controls`/视觉高亮（textbox，无 `aria-expanded`）
- [ ] AC2 Enter/Tab 选中（不发送不换行）+ 修饰键组合放行（Shift+↑↓/Ctrl+Tab/Shift+Tab/Cmd+↑↓）
- [ ] AC3 Esc 关闭、保留文本、同 token 打字重开、跨 token 不受影响
- [ ] AC4 下拉关 Cmd/Ctrl+Enter 发送、Enter 换行；下拉开 Cmd/Ctrl+Enter 只提交不发送
- [ ] AC5 IME 组字 Enter（含 Cmd/Ctrl+Enter）不误发不误选
- [ ] AC6 主输入框终态 / 发送中 / 空草稿 不发送
- [ ] AC7 可见提示随平台显示 ⌘/Ctrl（fallback Ctrl）
- [ ] AC8 快速回复框一致（发送 + 换行 + IME + 提示 + 同按钮判据 + 焦点回归）
- [ ] AC9 回归：鼠标点选 / 发送按钮 / 终态禁用 / outline-clip 全绿
- [ ] 门禁：typecheck + lint + test + format:check + build smoke + CI 绿

## 落地记录

（实现后回填 commit sha + CI 状态）
