# RFC-091 — 任务分解

单 PR（RFC 默认）。commit 前缀：`feat(frontend): RFC-091 工作目录 diff 文件列表按文件夹树呈现`。

## 子任务

### RFC-091-T1 — 抽 `fileTreeRows` 为共享原语
- 新建 `packages/frontend/src/lib/fileTree.ts`，迁入 `FileTreeRow`、`TreeNode`、`fileTreeRows`
  （从 `lib/structureView.ts` 原样搬，逻辑零改）。
- `lib/structureView.ts` 改为 `export { fileTreeRows, type FileTreeRow } from './fileTree'`；
  保留其余导出不动（`StructuralDiffView` / `structure-view.test.tsx` import 路径不变）。
- 新建 `tests/file-tree.test.ts`：迁移/扩展纯函数测试（分组+压缩+basename+depth；新增仓根 depth0、
  `(preamble)` 叶子；一条 re-export smoke）。
- 依赖：无。可独立先行、独立绿。

### RFC-091-T2 — `WorktreeDiffPanel` 改树渲染 + `fileOrder` 键盘
- 引入 `fileTreeRows`（from `@/lib/fileTree`）。
- 按 `repo` 把 `items` 切段 → 每段 `filePathOf(block)`（重命名取 ` → ` 后段）→ `fileTreeRows`。
- 左栏渲染：仓表头（沿用 `showRepo`）+ 目录行 `.worktree-diff__tree-dir`（非交互）+ basename 文件行
  （checkbox + `button[role=tab]`，`title`/aria 用完整路径，`paddingLeft = 8 + depth*14`）。
- 键盘：构 `fileOrder`（视觉文件 `selKey` 序），↑/↓/Home/End 在其上步进；Space 标记当前 item 已看；
  roving tabIndex / 焦点跟随 / list-scoped / 修饰键放行保留。
- effect（focus / self-heal / 已看 / 进度）不动。
- `styles.css` 加 `.worktree-diff__tree-dir`（镜像 `.structure__tree-dir`）。
- 依赖：T1。

### RFC-091-T3 — 测试更新 + 树锁定
- `tests/worktree-diff-panel.test.tsx`：按 design §7.2 更新（basename 标签、目录行断言、键盘期望值），
  被改测试顶部注释 RFC-091 意图；新增嵌套树锁定测（目录行 + depth + 键盘视觉序）；保留源码兜底。
- 新增源码锚点：`WorktreeDiffPanel.tsx` 引用 `fileTreeRows`。
- 依赖：T2。

## 验收清单

- [ ] 左栏为缩进文件夹树：目录表头行 + basename 文件行 + 单子目录压缩；与结构视图视觉一致。
- [ ] `role="tab"` 数量 = 文件数（不变）；tab 文本 = basename；`title`/aria = 完整路径。
- [ ] 键盘 ↑/↓/Home/End 按树视觉序切文件、跳目录、夹紧；Space 标已看；roving/focus/list-scoped/修饰键保留。
- [ ] 多仓：每仓表头 + 各自树；同名跨仓两 tab、各自已看。
- [ ] 已看进度/持久化、`focusFilePath` 互跳、self-heal、截断 banner、空状态：不变。
- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿。
- [ ] `bun run build:binary` smoke 通过（共享导出有动，按 [reference_binary_build_module_cycle]）。
- [ ] push 后查 GitHub Actions（typecheck/test/format + build smoke + Playwright e2e）绿。

## PR

单 PR；T1→T2→T3 顺序提交或单 commit 均可（单 commit 时 message 覆盖三者范围）。完工后 RFC 状态
→ Done，`STATE.md` 已完成表加一行。
