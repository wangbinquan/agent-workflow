# RFC-010 — Markdown 渲染态内联 Diff（替换 review word 模式）

## 背景

`packages/frontend/src/components/review/DiffView.tsx`（RFC-005 PR-E T34）当前对 `word` / `line` / `block` 三种粒度都用同一种方式渲染：左右两栏、源码原文 + 红绿底色。这对于代码 / 配置文件类纯文本是合适的，但 review 评审的对象是 **markdown 文档**——标题、列表、强调、表格、引用块、代码块，一旦红绿底色压在源码上，作者眼中"成稿后的样子"就完全丢失了。

社区项目 [`netj/markdown-diff`](https://github.com/netj/markdown-diff) 给出了一个简洁有效的范式：把 word-diff 的添加 / 删除标记内联到 markdown 文本里，再用 markdown 渲染器渲染成"成稿样式 + 内联高亮"。本 RFC 把这个范式引进来，但绕开 `<del>` / `<ins>` 内联 HTML（RFC-008 的 `Prose.tsx` 出于 XSS 安全刻意禁用了 `rehype-raw`）。

## 目标 / 非目标

### 目标

- 把 `DiffView` 的 **word / line / block 三种模式**全部改造为：单栏 prose 视图，整段渲染成最终样式，新增段（词 / 行 / 块）高亮绿底，删除段带删除线红底。
- 实现路径：jsdiff 算改动（word→`diffWordsWithSpace`、line→`diffLines`、block→按空行切再 line diff）→ `buildMergedMarkdown` 拼成"含 PUA marker 的 merged markdown" → 自定义 **remark 插件** 把 PUA marker 转成带 className 的 hast `<span>`，全程不依赖 `rehype-raw`。
- 复用 `Prose.tsx` 现有的 remark / rehype 插件链（gfm + slug + autolink-headings + external-links + katex），保证渲染样式与正常文档一致。
- 复用现有 `splitForWordDiff` 的 CJK Intl.Segmenter 处理（仅 word 模式有用），保证中英混排粒度合理。
- 三种粒度共用同一份"merged markdown + remark 插件"管线，差异仅在 jsdiff 入参；不再保留旧的左右源码红绿块视图。

### 非目标

- 不做 side-by-side 渲染态视图（单栏 inline 已足够覆盖 review 的 doc_version 对比场景；如未来需要可再立 RFC）。
- 不做 fenced code block **内部**的 word-level diff（见 design.md §代码块策略）。
- 不做 cross-file 聚合、PR-style 文件分组（review 评审本来就是单文档单 doc_version 对比）。
- 不再保留旧的"左右两栏 + 源码红绿块"实现作为 fallback：那种实现已无 prose 渲染意义，留在仓里是死代码（CLAUDE.md "Avoid backwards-compatibility hacks" 原则）。

## 用户故事

- **U1（同稿小修，word）**：作者把上一版的 `订单状态枚举` 改成 `订单状态字段`，reviewer 切到 word 模式，正文以正常排版呈现，只看到 `枚举` 划掉、`字段` 高亮，确认改动后留评。
- **U2（中英混排，word）**：原文 `部署到 staging 环境`，新文 `部署到 production 环境`，word 模式仅标 `staging`→`production` 一段，不会把整个中文短语糊在一起。
- **U3（结构性新增，line / block）**：新版本插入了一个新的 `### 兼容性` 小节，line 模式中整行作为新增高亮，但仍以正常 `<h3>` + 段落 prose 渲染；block 模式下整段（标题 + 段落）作为一整块绿底显示，比 line 更聚合。
- **U4（整段重写，block）**：原段被整段删除并由新段替换，block 模式渲染：删除段以删除线红底整段呈现、紧跟新段以绿底整段呈现，结构（列表、代码块）保持。

## 验收标准

1. 在 review 详情页打开两份 doc_version，三种模式（word / line / block）切换时，渲染区均使用 `Prose` 风格（标题、列表、code、引用、表格、KaTeX 都正确渲染），不出现源码原文、不出现旧的左右两栏。
2. 新增段的 `<span>` 带 class `diff-ins`，删除段带 class `diff-del`；CSS 让两者在浅色 / 暗色背景下都肉眼可分。
3. fixtures 测试覆盖每种粒度的代表场景，至少：
   - **word**：① 段内改字 ② CJK 词级差异 ③ 不变（无标记）
   - **line**：① 单行改字 ② 整行新增 ③ 整行删除
   - **block**：① 整段重写 ② 整段新增（多行）③ 块结构变化（段→列表）
   - 三模式共享：标题、列表、加粗、表格 cell 改字时不会破坏块结构。
4. 安全回归：左右任一侧含 `<script>alert(1)</script>` 字面量时，渲染输出不含 `<script>` 元素（react-markdown 默认转义），保留 RFC-008 的 XSS-safe 不变量。
5. 老的 `DiffView` 内部源码 pane / scroll-sync 实现完全删除，仓内不留死代码；现有 `reviews.detail.tsx` 调用方无需改动（接口保持，行为升级）。
6. CI 三件套（`bun run typecheck` + `bun run test` + `bun run format:check`）+ 各 package lint 全绿。

## 与现有 RFC 的关系

- **依赖** RFC-005（review feature 与 DiffView 入口）、RFC-008（Prose 渲染管线）。
- **不影响** RFC-009（评论侧栏）：本 RFC 只换右侧 body 渲染方式，侧栏 / 锚定 / 滚动跟随完全无关。
- **不影响** RFC-007（canvas 拖拽）。
