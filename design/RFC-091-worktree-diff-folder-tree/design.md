# RFC-091 — 技术设计

## 1. 现状与复用面

- `WorktreeDiffPanel`（`packages/frontend/src/components/WorktreeDiffPanel.tsx`）：
  - `splitByRepo(diff)` → `RepoGroup[]`（`{ repo: string|null, blocks: FileBlock[] }`，来自
    `DiffViewer.tsx:104`）。
  - 扁平展开成 `items: Item[]`（`selKey` = `${gi}:${bi}::${header}` 全局唯一；`viewedKey` 单仓为
    裸 header、多仓为 `repo::header`；`repo`；`block`）。当前左栏直接 `items.map()` 渲染，每个
    `item` 一行：`<input checkbox>` + `<button role="tab">{block.header}</button>`（完整路径）。
  - 键盘 `onTablistKeyDown` 按 `items` 数组顺序 ↑/↓/Home/End；Space 切「已看」。
  - `focusFilePath` effect：`items.find(it => it.block.header.includes(focusFilePath))` → 设 `selectedKey`。
  - self-heal effect：diff 串变化后选中项不存在则回落首个。
- `StructuralDiffView`（`components/structure/StructuralDiffView.tsx:485-595`）：**已落地的树范式**，
  本 RFC 照搬其形态：
  - `const rows = useMemo(() => fileTreeRows(files), [files])`。
  - `fileOrder = rows.flatMap(r => r.fileIndex === undefined ? [] : [r.fileIndex])`（**视觉**文件顺序）。
  - 键盘按 `fileOrder` 步进（跳过目录行）。
  - 渲染：目录行 `<div className="structure__tree-dir" style={{paddingLeft: 8 + depth*14}}>`，
    文件行 `<button role="tab" style={indent}><span className="structure__file-name">{row.name}</span></button>`，
    `title={f.filePath}`，roving `tabIndex`。
- 纯函数 `fileTreeRows(files: ReadonlyArray<{ filePath: string }>): FileTreeRow[]`
  （`lib/structureView.ts:85`）：构建嵌套目录树 → 压缩单子目录链 → 扁平成渲染行
  `{ depth, name, fileIndex? }`（`fileIndex` 仅叶子有，指向**输入数组**下标）。已被
  `structure-view.test.tsx:140` 单测覆盖。

## 2. 关键设计：复用 `fileTreeRows`，把它升格为共享原语

为避免在通用 diff 组件里 `import { fileTreeRows } from '@/lib/structureView'`（让 diff 面板耦合
「结构」域模块），**把树构建逻辑抽到中性模块** `packages/frontend/src/lib/fileTree.ts`：

- 迁移：`FileTreeRow`、内部 `TreeNode`、`fileTreeRows` 三者从 `structureView.ts` 移入 `fileTree.ts`。
- 向后兼容：`structureView.ts` 改为 `export { fileTreeRows, type FileTreeRow } from './fileTree'`
  —— `StructuralDiffView.tsx` 与 `structure-view.test.tsx` 的现有 import 路径**不变、不破**。
- 单测：`fileTreeRows` 的纯函数测试迁到（或新增于）`tests/file-tree.test.ts`；结构视图测试里
  对 `fileTreeRows` 的现有断言通过 re-export 仍然有效（亦可保留，二者不冲突）。

> 替代方案（更小改动）：`WorktreeDiffPanel` 直接从 `structureView` import。可行，但与仓内「让复用
> 的 helper 成为公共原语」的强制原则相悖。**采用抽取方案**。

`fileTreeRows` 本身**零改动**——它已满足需求（目录分组 + 单子目录压缩 + 字典序）。

## 3. `WorktreeDiffPanel` 渲染改造

保持 `items` 模型与所有 effect（选择 / 已看 / focus / self-heal）**完全不变**——它们是 diff 面板的
状态真相源。只改**左栏 DOM 结构**与**键盘顺序**。

### 3.1 每仓建树

`items` 已按 `(group, blockIndex)` 顺序排列，且每个 `item` 带 `repo`。按 `repo` 把 `items` 切成
连续段（多仓即每仓一段，单仓一段 `repo===null`），对每段：

```
filePathOf(block) =                       // 叶子归位用的路径
  block.header.includes(' → ')            // 重命名 header 形如 "old → new"
    ? block.header.split(' → ')[1]!.trim()//  → 用重命名后路径定位
    : block.header
rows = fileTreeRows(segItems.map(it => ({ filePath: filePathOf(it.block) })))
```

`rows` 里叶子的 `fileIndex` 是**段内**下标 → 映射回该段的 `item`（取其 `selKey`/`viewedKey`/`block`）。

### 3.2 渲染顺序与 DOM

左栏 `nav[role=tablist]` 内，按 `items` 的仓顺序逐段输出：

- 段首（多仓且换仓时）：保留既有 `.worktree-diff__repo` 表头（逻辑沿用 `showRepo`）。
- 段内 `rows.map`：
  - 目录行（`fileIndex===undefined`）：`<div className="worktree-diff__tree-dir" style={indent}>{row.name}</div>`
    （非交互，不是 tab、无 checkbox）。
  - 文件行（叶子）：沿用既有 `.worktree-diff__file-row`（checkbox + `button[role=tab]`），但：
    - tab 文本 = `row.name`（**basename**），不再是完整 `block.header`。
    - `title={block.header}`、`aria-label` 仍用**完整路径**（`diffMarkViewed` 的 `file` 变量传完整
      路径，无障碍不退化）。
    - `style={{ paddingLeft: 8 + row.depth*14 }}` 缩进（与结构视图同公式）。
    - checkbox 不缩进（贴行首），缩进只作用在 tab 上——或整行缩进，二选一以视觉对齐为准（实现时
      取与结构视图最接近者：tab 缩进、checkbox 固定列）。

`indent` 公式、目录行类名、basename 文本均**照抄结构视图**，确保两页签视觉一致。

### 3.3 键盘顺序：改用 `fileOrder`

目录分组会让**视觉顺序 ≠ `items` 数组顺序**（`fileTreeRows` 按目录重排 + 字典序）。照搬结构视图：

- 构造 `fileOrder: string[]`（按视觉自上而下的**文件** `selKey` 序）——把每段 `rows` 的叶子按
  渲染顺序映射成 `selKey` 后拼接。
- `onTablistKeyDown` 的 ↑/↓/Home/End 改为在 `fileOrder` 上步进（`indexOf(selectedKey)` → 夹紧 ±1 /
  端点），跳过目录行天然成立（`fileOrder` 只含文件）。
- **Space**（标记已看，diff 面板特有）保持作用于「当前选中 item」：由 `selectedKey` 取 `item.viewedKey`
  → `markViewed`。checkbox 来源的 Space 仍短路（`e.target.tagName==='INPUT'` 放行，避免双切）。
- roving `tabIndex`（仅 active 文件 tab = 0）、`selectFile` 焦点跟随、修饰键 bail-out、
  `onKeyDown={onTablistKeyDown}`（**非** window 监听）全部保留。

### 3.4 不变量（effect 不动）

- `focusFilePath` effect 命中仍靠 `block.header.includes(...)` → 与渲染无关，互跳照常。
- self-heal / 选中回落 / 截断 banner / 空状态：均基于 `items`，不受树渲染影响。

## 4. CSS

新增 `.worktree-diff__tree-dir`，**镜像** `.structure__tree-dir`（`styles.css:10243`）：

```css
.worktree-diff__tree-dir {
  flex-shrink: 0;
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

缩进走内联 `paddingLeft`（与结构视图一致），不新增缩进类。其余 `.worktree-diff__*` 类不动。

## 5. i18n

无新增运行逻辑文案。`diffMarkViewed`（`{{file}}`）继续传**完整路径**。目录表头行是纯文本（结构
视图亦无 aria），不引入新 key。`zh-CN`/`en-US` 均无需改动。

## 6. 失败模式 / 边界

| 场景 | 行为 |
| --- | --- |
| 重命名 `old → new` | 归入 `new` 的目录；叶子文本 = `new` 的 basename；`title` 保留完整 `old → new` header |
| 仓根文件（无 `/`） | depth=0 叶子，无目录表头（同结构视图） |
| `(preamble)` 伪块 | 当作 depth=0 叶子名 `(preamble)`，不崩 |
| 同 basename 不同目录 | 不同父目录下的两个叶子；`selKey` 本就唯一 |
| 多仓同路径 | 每仓各自建树；`selKey`/`viewedKey` 已按仓限定，互不串台 |
| 100 文件单目录 | `src/` 表头 + 100 叶子；`fileTreeRows` O(n)；perf smoke 内 |
| 空 diff | 维持既有 `diff--empty` 空状态分支，提前 return |

## 7. 测试策略（§必写）

> 本面板被 `tests/worktree-diff-panel.test.tsx` 重度锁定。改造**有意**改变两类断言：tab 可见文本
> 由完整路径变为 basename、键盘标签随之变 basename。这是用户明确要求的呈现变更，**更新**相关断言
> （不删测试），并在被改测试顶部注释指明「RFC-091：扁平→文件夹树」与本 RFC 链接。

1. **纯函数**（`tests/file-tree.test.ts`，迁移/扩展自 structure-view）：
   - 既有：按目录分组 + 单子目录链压缩 + 叶子 basename + 顶层文件 depth 0（沿用）。
   - 新增：重命名后路径定位由调用方传入（在面板测试侧验证）；仓根文件 depth 0；`(preamble)` 叶子。
   - 锁 re-export：`import { fileTreeRows } from '@/lib/structureView'` 仍可用（一条 smoke）。
2. **`worktree-diff-panel.test.tsx`**（更新 + 扩展）：
   - `renders one tab per file`：tab **数量**仍 = 文件数；可见文本断言改 basename（`a.ts`/`b.ts`/`c.ts`）；
     新增断言存在 `.worktree-diff__tree-dir` 且含 `src`。
   - 键盘组（ArrowDown/Up、Home/End、clamp、roving、focus、Space×3、modifier）：`selectedTabLabel()`
     期望值改 basename；THREE_FILE_DIFF（`src/a|b|c.ts`）树后顺序仍 a→b→c。
   - 多仓组：tab 文本改 basename `index.ts`；仓表头仍 `['repo-a','repo-b']`；两仓各一个 `src` 目录行；
     同路径仍两 tab、各自已看。
   - viewed / 持久化 / self-heal / truncated / empty / perf：保留，涉及完整路径标签处改 basename。
   - **新增树锁定测**：嵌套 diff（`src/components/Foo.tsx`、`src/lib/util.ts`、`README.md`）→ 渲染目录
     表头行（`src`、压缩后的 `components`/`lib`）+ basename 叶子按 depth 递增；文件 tab 仍 3；**键盘视觉
     顺序跟随树**（目录字典序，证明 `fileOrder` 而非 `items` 序驱动导航）。
   - 保留源码兜底：`onKeyDown={onTablistKeyDown}` 存在、无 `addEventListener('keydown'`。
3. **源码锚点**：断言 `WorktreeDiffPanel.tsx` 引用 `fileTreeRows`（锁住「复用结构视图树、不回退扁平」）。

## 8. 风险

- **改动既有锁定测试**：最大风险点。逐条**更新**而非删除，注释写清意图与 RFC 链接；保留全部键盘 /
  已看 / 多仓 / self-heal 覆盖面，仅替换「完整路径→basename」与新增树断言。符合仓「测试随改动落地」
  与「不为过 CI 删别人代码」原则（这是有意的呈现变更，非掩盖红）。
- **多人并发树**：仅触 `WorktreeDiffPanel.tsx`、`lib/fileTree.ts`（新）、`lib/structureView.ts`
  （改为 re-export）、`styles.css`（加一类）、两个测试文件。按路径精确 `git add`。
