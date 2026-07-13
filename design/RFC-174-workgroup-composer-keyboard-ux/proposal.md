# RFC-174 — 工作组聊天室输入框键盘易用性（@ 补全键盘导航 + 发送快捷键 + 可见提示）

- 状态：Draft
- 提出：2026-07-13
- 归属层级：前端 UX（RFC-164 工作组聊天室 `WorkgroupRoom` 的补强）
- 依赖：RFC-164（工作组聊天室已落地）

## 背景

工作组聊天室（RFC-164 `components/workgroup/WorkgroupRoom.tsx`）是**组任务的主视图**——用户拍板「派单 = `@` 提及成员」，执行在房间里实时观测。当前输入框（composer）有两个明显偏离主流聊天/协作软件易用性的缺口：

1. **`@` 补全下拉无键盘导航**。打 `@` 后弹出的花名册候选列表（`workgroup-room-mentions`）**只能用鼠标点选**——textarea 上没有 `onKeyDown`，没有 `activeIndex` 高亮态、没有 `aria-activedescendant`/`role="option"`/`aria-selected`。任何一款有 `@` 提及的软件（Slack / Discord / GitHub / 飞书 / 钉钉）都支持 `↑/↓` 移动 + `Enter`/`Tab` 选中 + `Esc` 关闭，本房间独缺。

2. **输入框无发送快捷键、也无换行约定**。textarea 只有 `onChange`/`onSelect`，没有 `onKeyDown`——**必须用鼠标点「发送」按钮**才能发消息，键盘用户无从下手，且没有明确的「换行」与「发送」分工。

3. **快捷键在页面上无任何提示**。即便加了快捷键，用户也无从得知——违反可发现性。

用户原话：「敲了 @ 之后不能按上下键加回车键选择 @某个 agent，这个功能要符合常见软件 @ 的易用性逻辑。还有回车发送信息还是 ctrl+回车发送信息，这个快捷键也要有啊」+「发送、换行快捷键要明确在页面提示」。

## 目标

- **G1**：`@` 补全下拉支持标准键盘导航——`↑`/`↓` 循环移动高亮、`Enter`/`Tab` 选中高亮成员、`Esc` 关闭下拉，符合主流 `@` 提及交互；配套完整 a11y（`aria-activedescendant` / `role="option"` / `aria-selected` / `aria-autocomplete` / `aria-expanded`）与视觉高亮。
- **G2**：输入框支持发送快捷键——**`Cmd/Ctrl+Enter` 发送、`Enter` 换行**（用户 2026-07-13 拍板）。
- **G3**：发送 / 换行快捷键在页面上**明确可见提示**（随平台显示 `⌘` 或 `Ctrl`）（用户 2026-07-13 追加要求）。
- **G4**：同一发送约定应用到卡片下「快速回复」内联输入框（人类成员交付，用户拍板范围）。
- **G5**：全程 IME 安全——中文（及日/韩）输入法联想组字时按 `Enter` 是「选词 / 换行」，**绝不误触发发送、也不误提交 mention**。

## 非目标

- **不改后端**、无 migration、无协议变更（`@` 解析、派单、消息 wire shape 全不动）。
- **不改弹窗表单**（驳回意见 `Dialog`、结构化交付 `DeliverFormDialog`）的提交方式——它们是模态表单，保持既有按钮提交语义。
- **不做快捷键自定义 / 设置项**——v1 固定 `Cmd/Ctrl+Enter` 发送约定（未来若要「Enter 发送」偏好切换，另立 RFC）。
- **不改 `@` 补全的候选算法**（`mentionCandidates` 前缀优先 + 子串的排序、`limit=8`、token 字符集 `[^\s@,]` 保持不变）。
- 不引入新的第三方组件；不改 `.workgroup-room` 整体布局。

## 用户故事

- 作为组任务参与者，我打 `@wo` 后能按 `↓` 高亮到 `Worker`、按 `Enter` 选中补全为 `@Worker `，全程不碰鼠标。
- 我写完一句话按 `Cmd/Ctrl+Enter` 直接发送；需要多行时按 `Enter` 换行。
- 我一眼能在输入框下方看到「`⌘+Enter` 发送 · `Enter` 换行」提示，不必猜。
- 我用中文输入法打字，联想框里按 `Enter` 选词，消息**不会被误发**、`@` 候选**不会被误选**。
- 作为人类成员，我在待办卡片的「快速回复」框里也能用同样的 `Cmd/Ctrl+Enter` 交付。

## 验收标准

- **AC1**（`@` 导航 + a11y）：打 `@` + 部分名字，下拉出现；`↓`/`↑` 循环移动高亮（到底/到顶回环）；高亮项有视觉区分且 `aria-selected="true"`；textarea 的 `aria-activedescendant` 指向高亮项的元素 id、`aria-controls` 指向 listbox（textarea 保持 textbox 角色，不用 `aria-expanded`）。
- **AC2**（选中 + 修饰键放行）：下拉打开时按 `Enter`（无 Shift/Alt）或 `Tab`（无修饰键）把在写的 `@query` 提交为 `@displayName `，下拉关闭，**既不发送也不换行**；带修饰键的编辑 / 系统组合（`Shift+↑↓` 选区、`Ctrl+Tab` 切标签、`Shift+Tab` 回退焦点、`Cmd+↑↓` 行首尾）**不被拦截**、保持原生行为。
- **AC3**（关闭）：下拉打开时按 `Esc` 关闭下拉、保留已输入文本、不发送；此后在**同一 token 继续输入**可重新弹出、移到别的 `@` token 不受影响。
- **AC4**（发送 / 换行 / 打开时不误发）：下拉**关闭**时（或输入中无 `@` token）——`Cmd/Ctrl+Enter` 发送并清空草稿、`Enter` 换行（不发送）；下拉**打开**时 `Cmd/Ctrl+Enter` 只**提交高亮候选、不发送**（mention UI 拥有其按键，杜绝把未提交的 `@query` 原样发出）。
- **AC5**（IME 安全）：输入法组字中（`isComposing` / `keyCode===229`）按 `Enter`（含 `Cmd/Ctrl+Enter`）——既不发送也不提交 mention（交给输入法处理）。
- **AC6**（禁用态，主输入框）：终态任务 / 发送中 / 空草稿——主输入框 `Cmd/Ctrl+Enter` 不发送（沿用发送按钮既有的 `!canPost || send.isPending || draft.trim()===''` 门）。快速回复框归属见 AC8。
- **AC7**（可见提示）：输入框下方有可见快捷键提示，随平台显示 `⌘` 或 `Ctrl`（`navigator` 不可用时回退 `Ctrl`）；可发帖时展示发送 / 换行约定（终态任务仍显示既有 `terminalNotice`）。
- **AC8**（快速回复一致）：卡片「快速回复」内联框——`Cmd/Ctrl+Enter` 交付、`Enter` 换行、IME 安全，并有同款提示；快捷键与其既有交付按钮**同一判据**（`!delivering && 非空`，不新增终态逻辑），交付成功后焦点回到其触发按钮。
- **AC9**（回归防护）：既有鼠标点选补全路径（`onClick` commit + `data-testid`）、发送按钮、终态禁用、outline-clip CSS（`workgroup-room-composer-outline-clip.test.ts`）全部不变绿。

## 影响面 / 交付

- 纯前端；单 PR；commit 前缀 `feat(frontend): RFC-174 …`。
- 触及文件：`lib/workgroup-room.ts`（新增纯键盘 oracle）、`components/workgroup/WorkgroupRoom.tsx`（wire）、`styles.css`（高亮 + 提示样式）、`i18n/zh-CN.ts` + `i18n/en-US.ts`（提示 / a11y label 文案）。测试：`workgroup-room-lib.test.ts`（纯 oracle 矩阵）+ `workgroup-room.test.tsx`（组件键盘路径）。
- 技术设计见 `design.md`，任务分解见 `plan.md`。
