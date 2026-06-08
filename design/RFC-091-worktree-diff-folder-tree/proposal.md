# RFC-091 — 工作目录 diff 文件列表按文件夹树呈现（对齐结构视图）

状态：Done

## 背景

任务详情页的「工作目录」diff（`WorktreeDiffPanel`，RFC-021）左栏目前是一个**扁平**的
逐文件列表：每个文件一行，显示**完整路径**（`diff --git` 推导出的 header，如
`src/main/java/com/wbq/snake/GameFrame.java`），多仓任务下仅按仓（RFC-066）分组。

实战中一个任务常改动几十、上百个文件，扁平列表有两个问题：

1. **难以按模块扫读**——同一目录下的文件散落在长列表里，看不出「这次主要动了哪个包/目录」。
2. **完整路径互相挤压**——深路径在 280px 窄栏里被 ellipsis 截断，公共前缀（`src/main/java/...`）
   重复占位，真正区分文件的 basename 反而被截掉。

与此同时，仓内**「结构」视图**（`StructuralDiffView`，RFC-083/088）的同一份变更文件清单**早已
按文件夹树呈现**：纯函数 `fileTreeRows()`（`lib/structureView.ts`）把扁平路径折成嵌套目录树、
单子目录链压缩（VS-Code 风格 `src/components/…`），文件以 basename 缩进列在目录表头行下。

用户诉求（2026-06-08）：**「工作目录 diff 要按照结构->树的呈现形式，按文件夹呈现」**——即把
工作目录 diff 的文件列表，改成与「结构」视图一致的文件夹树形态。

## 目标

- `WorktreeDiffPanel` 左栏从扁平逐文件列表，改为**按目录分组的缩进树**：
  - 文件夹作为**非交互表头行**（不可点击、不参与 Tab/选择），文件以 **basename** 缩进列在其下。
  - **单子目录链压缩**为一行（`src/main/java/com/wbq/snake`），避免深包过度缩进。
  - 复用「结构」视图同款纯函数 `fileTreeRows()`，呈现风格、缩进、排序与结构视图**视觉一致**。
- 保留 `WorktreeDiffPanel` 现有的**全部既有能力**，零回退：
  - 多仓（RFC-066）按仓分组 + 同名跨仓文件互不串台（选择键 / 已看键仍按仓限定）。
  - 逐文件「已看」勾选 + `N/M viewed` 进度（RFC-021 Q5）。
  - 键盘导航 ↑/↓/Home/End 切文件、Space 标记已看（RFC-021）；roving tabIndex、焦点跟随、
    list-scoped handler、修饰键放行全部保留。
  - 文本↔结构互跳（`focusFilePath`，RFC-083）。
  - diff 串变化时的选择 self-heal、截断 banner、空状态。
- 右栏单文件 diff body（`DiffFileBody`）**完全不变**。

## 非目标

- **不做文件夹折叠/展开**。用户明确选择「不可折叠缩进树（仿结构视图）」形态；折叠态作为将来
  可能的独立 RFC，不在本 RFC 范围。
- **不动**另一个「工作目录」**文件**页签（`WorktreeFilesPanel`，RFC-065）——它本就是懒加载的
  可折叠文件树，呈现的是文件**内容**而非 diff，与本 RFC 无关。
- **不动**「结构」视图（`StructuralDiffView`）——它已是树。
- 无后端改动、无 schema 变更、无 API 变更、无新增 i18n 文案逻辑（见 design.md）。
- 不改变右栏 diff body 的渲染、滚动、截断逻辑。

## 用户故事

- 作为审阅者，我打开一个改了 60 个文件、横跨 8 个目录的任务 diff，左栏按目录把文件归拢，我
  一眼看出「主要动了 `src/engine/` 和 `tests/`」，并能折叠注意力到某个包。
- 作为审阅者，我用 ↑/↓ 顺着**视觉从上到下**的顺序逐个过文件、Space 勾「已看」，目录表头被自动
  跳过，体验与「结构」视图完全一致——两个页签肌肉记忆统一。
- 作为审阅者，深路径文件现在显示 basename（`GameFrame.java`）而非被截断的完整路径，鼠标悬停
  仍能从 `title` 看到完整路径；多仓下每个仓各自成树、各自的 `src/` 表头互不混淆。

## 验收标准

1. 工作目录 diff 左栏渲染为缩进树：目录表头行（`.worktree-diff__tree-dir`）+ basename 文件行；
   单子目录链压缩；排序与 `fileTreeRows` 一致（目录在前、同层字典序）。
2. 文件行数（`role="tab"` 数量）= 变更文件数，**与改造前一致**（目录表头不是 tab）。
3. 文件 tab 可见文本 = **basename**；`title` / 无障碍标签仍携带完整路径。
4. 键盘 ↑/↓/Home/End 按**树的视觉顺序**在文件行间移动、跳过目录行、夹紧不循环；Space 标记当前
   文件已看；roving tabIndex、焦点跟随、list-scoped、修饰键放行均保留。
5. 多仓：每个仓一个表头 + 各自的目录树；同名跨仓文件仍是两个独立 tab、各自「已看」。
6. 已看勾选 / `N/M` 进度 / 持久化（`storageKey`）、文本↔结构互跳（`focusFilePath`）、diff 串变化
   self-heal、截断 banner、空状态：行为全部不变。
7. 100 文件 diff 渲染仍在性能预算内（沿用既有 perf smoke）。
8. `bun run typecheck && bun run test && bun run format:check` 全绿；单二进制 build smoke 通过；
   CI（含 Playwright e2e）绿。
