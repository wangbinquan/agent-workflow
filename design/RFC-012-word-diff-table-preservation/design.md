# RFC-012 — 技术设计

## 总览

本 RFC 修改 `packages/frontend/src/lib/review/markdownDiff.ts` 的 **word 路径**——在 `computeChanges` 调 `diffWordsWithSpace` **之前**插入一个"结构性保护"步骤：把每张 markdown 表格识别为一段连续的"表格块"，用一个 **1-codepoint PUA 占位符**替换整段表格块（占位符独占一行，前后保留原 `\n` 行边界），让 jsdiff 把每张表格当成单个原子 token 对齐。diff 算完之后，遍历 changes，**把占位符还原成原始表格块文本**：

- 占位符出现在 `c.added` change 里 → 还原为右侧原表，整体走 wrapLines INS 包裹。
- 占位符出现在 `c.removed` change 里 → 还原为左侧原表，wrapLines DEL 包裹。
- 占位符出现在 `unchanged` change 里 → 还原为原表（左右内容字节相等才会落到这一档），不包 marker。

`wrapLines` 需要两处增量（落地实现里同步加好，测试已锁）：

1. **table 分隔符行直接 passthrough**：`|---|---|` 类的行携带任何 PUA marker 会让 GFM 表分隔符正则匹配失败，整张表降级为 `<p>`。整张表已是单一 ins/del/unchanged change，分隔符不带 marker 不会丢 diff 语义（颜色由 header/body 行 cell 内的 marker 提供）。
2. **table header / body 行按 cell 逐个包 marker**：一行内 open/close 不能跨 `|`——markdown 把 `|` 当 cell 边界，跨界的 open 与 close 落在不同 `<td>` 里、各自变成孤儿 marker，被 remarkDiffMarkers 吞掉，diff 颜色丢失。按未转义 `|` 切 cell、对每个非空 cell 包一对 open/close 即可。

**关键不变量两条**：(a) jsdiff 不在 `|---|---|` 内部塞 ins/del 边界；(b) marker 不跨 cell 边界。

实现策略选择见 §备选方案对比，选定方案是 **A（占位符法 + wrapLines 表格感知）**。

## 数据流（word 路径）

```
left, right
  ↓
pretreatTablesForWordDiff(left, right) →
  { lTokens, rTokens, lookup: Map<placeholderChar, tableContent> }
  ↓ splitForWordDiff (RFC-010 既有 CJK ZWSP 注入；占位符是单 PUA 字符，
    splitForWordDiff 看到的非表内容才会被分词)
  ↓
diffWordsWithSpace(L_tokens, R_tokens) → Change[]
  ↓
restoreTablePlaceholders(changes, lookup) → Change[]
  ↓
buildMergedMarkdown 余下流程（wrapLines + 拼接 + 剥 ZWSP）保持不变；
wrapLines 内含 RFC-012 表格感知：分隔符行 passthrough、header / body 行按 cell 包 marker
```

`line` / `block` 路径完全不走这条新管线——它们已经按行 / 按块切，表格行各自原子。

## 占位符设计

- 占位符使用 PUA 区间 **U+E010-U+EFFF**（4080 个 codepoint），与 INS/DEL marker `U+E000-U+E003` 之间留 12 字隔离带防漂移。
- **每张表分配一个唯一 codepoint**——不用 "PUA + decimal-ASCII ID 后缀" 那种编码：数字 `0-9` 是 jsdiff word 分词的 `\w` 单词字符，PUA + 数字会被拆成两个 token，"整张表 = 1 atom" 的不变量丢失。每个 codepoint 单独当 ID 用即可。
- **左右映射策略**：按位置 + 内容相等性分配。左侧第 i 块与右侧第 i 块**内容字节完全相等**时分配同一 codepoint（jsdiff 把它们识别为 unchanged）；否则两侧各分配独立 codepoint（jsdiff emit removed + added，渲染成两张表）。位置错位（左 3 块、右 4 块、中间插入）会让对齐位偏移，结果是更多 del/ins 噪声但不会渲染崩，可接受。
- 极端兜底：表数超过 4080 张时退回原 word-diff 路径（不抛错，行为退回 RFC-010 现状）。
- 占位符在 token 串里独占一行（替换原 N 行表为 1 行 placeholder），周边 `\n` 行边界保持不变；jsdiff 看到的就是"占位符位于原段落边界"。还原阶段再补 `\n\n` 防止 del/ins 相邻表挤到同一物理行（见 §还原阶段）。

## 表格块识别

最小可行的"markdown 表格块"识别：

- **起点**：一行匹配 `TABLE_ROW_RE`（行首 0-3 空格 + `|`），且**下一行**匹配 `TABLE_SEP_RE`（GFM 表分隔符）。
- **延续**：从起点往下，所有连续以 `|` 开头的行（含 leading 0-3 空格）。
- **终止**：碰到空行 / 非 `|` 开头行 / EOF。
- 不识别"loose pipe table"（无分隔符的伪表）——commonmark + remark-gfm 都不会把它渲染成表，无需保护。
- 不识别 indented（4 空格缩进）的"表"——它们会被 commonmark 当代码块，本就不渲染成表。

落到内部 helper：

```ts
const TABLE_ROW_RE = /^ {0,3}\|/
const TABLE_SEP_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

function findTableBlocks(text: string): Array<{ start: number; end: number; content: string }>
function pretreatTablesForWordDiff(
  left: string,
  right: string,
): { lTokens: string; rTokens: string; lookup: Map<string, string> }
function restoreTablePlaceholders(changes: Change[], lookup: Map<string, string>): Change[]
```

`pretreatTablesForWordDiff` 内含位置 + 内容相等性的对齐策略（见 §占位符设计）；`lookup` 把每个 placeholder codepoint 映射回它代表的原表文本，左右共用同一 placeholder 时只存一份。

## 还原阶段

`computeChanges` 内 word 路径变为：

```ts
const pre = pretreatTablesForWordDiff(left, right)
const raw = diffWordsWithSpace(splitForWordDiff(pre.lTokens), splitForWordDiff(pre.rTokens))
return restoreTablePlaceholders(raw, pre.lookup)
```

`restoreTablePlaceholders` 行为：

- 遍历 changes；对每条 `Change`，把 `value` 里所有 PUA placeholder 字符通过 `lookup` 替换回原表文本。
- **替换时在表前后强制补 `\n\n`**：当 jsdiff emit 相邻的 removed + added 两条 change 时，word 模式 `buildMergedMarkdown` 用 `separator=''` 把它们拼到同一物理行——会得到 `| 文档状态 | 初稿 |[DEL_CLOSE]| 项目 | 内容 |[INS_CLOSE]` 这种"上一段表的最后一行紧接下一段表的第一行"，markdown 把它们当一张表的多行解析，分隔符就错位了。补 `\n\n` 保证每张表独立成段；wrapLines 看到的空白行原样保留，不会插入 marker。
- 替换路径对所有 PUA placeholder 字符都生效；left / right 共用 codepoint 的 unchanged 表 → 还原成 lookup 里那一份内容（与 left/right 任一份字节相等）。

## 与 wrapLines 的交互

`wrapLines` 既有逻辑（RFC-010）：

1. fence 跳过 ✓
2. 空行不包 ✓
3. 行首结构前缀保留（`| `、`# `、`- ` 等）✓

**RFC-012 在 wrapLines 加两条增量**：

1. **分隔符行（TABLE_SEP_RE 匹配）整行 passthrough**：不抽前缀、不包 marker，原样 push。否则 marker 落进 `:?-+:?` 字符之间、GFM 表分隔符正则失配。
2. **表格 header / body 行（TABLE_ROW_RE 匹配且非 separator）走 `wrapTableRowCells`**：按未转义 `|` 切成 cells，对每个非空 cell 包一对 open/close（leading / trailing 空白保留在 marker 外侧）。这样每个 cell 在渲染态各自得到 `<span class="diff-ins/del">`，且 marker 不跨 cell 边界。前后哑 cell（leading / trailing `|` 之外的空 segment）不包。

未命中表格的行回到 RFC-010 原始 `prefix + open + body + close` 路径不变。

## 备选方案对比

| 方案                                                                                    | 优点                                                                                                                | 缺点                                                                                                         | 决定       |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------- |
| **A. 占位符法 + wrapLines 表格感知（本 RFC 选定）**                                     | 改动局部、复杂度集中在 pre/post + wrapLines 两条增量上；表内 cell 级 word-diff 退化为 "整表 del + 整表 ins"，可接受 | wrapLines 增加两条分支；TABLE_SEP_RE / TABLE_ROW_RE 需要与 GFM 保持一致                                      | ✅ 选      |
| B. 仅 wrapLines 内识别分隔符行并跳过包 marker                                           | 实现最简                                                                                                            | 只解决"分隔符行被打 marker"一个症状；不解决"jsdiff 跨行对齐导致单元格内容碎裂"的根因；列数变化时仍渲染为段落 | ❌         |
| C. 把每张表拆成 N 行，用 line-diff 算单独子结果再合并                                   | 能保留 cell 级别细粒度高亮                                                                                          | 需要在 word 主路径里嵌一个 line-diff，复杂度高；列数不一致时 cell 对齐仍是难题，常退化成整行 ins/del         | ❌         |
| D. 整体改 word 模式为"先 line-diff 找差异块，再在差异块内做 word-diff"（参考 git diff） | 理论最优                                                                                                            | 重写整个 word 路径，超出"补 RFC-010 盲点"的范围；适合下一个大 RFC                                            | ❌（推迟） |

## 性能

- `findTableBlocks` 是单次 O(lines) 扫描；`pretreatTablesForWordDiff` 在 `findTableBlocks` 基础上做 O(min(L,R)) 的位置 + 内容相等性对齐；`restoreTablePlaceholders` 是 O(changes) 扫描 + 每条 change 内一次 regex replace。整体复杂度增量与 jsdiff word 主调用相比可忽略。
- 占位符让 jsdiff 输入显著缩短（每张表压缩为 1 codepoint），实际还能轻微加快 word-diff（O(n·m)）。
- `wrapTableRowCells` 每个表格行做一次 `split(/(?<!\\)\|/)` + cell-wise wrap，常数级开销。

## 失败模式

- **没识别出某张表**（例如缺分隔符行的伪表）：placeholder 不会替换，走原 word-diff 路径——回归到 RFC-010 现状，不会变得比现在更糟。
- **占位符冲突**：input 自身就含 U+E010-U+EFFF 区间的字面量（PUA Use Area，几乎不可能在 markdown 文档里出现）——若出现，会被当作正常字符 word-diff；表格保护对该输入失效但渲染不会崩。已在测试里加一条 fixture 锁这个边界。
- **wrap 后的表落进 `<span>`**：react-markdown 把 PUA marker 在 mdast 阶段转为 `diffMark` 节点（hName=span）；GFM 表解析在 mdast 阶段，cell 内 text 节点里的 PUA 才会被 remarkDiffMarkers 切成 `<span>`；wrapLines 已经把 marker 限制在 cell **内部**，所以最终 mdast 看到的是 `<th>` / `<td>` 内含 marker 的 text 节点 → 转 `<span>` 后落在 cell 内，不破坏 `<table>` 结构。happy-dom 集成测试锁住。
- **左右表位置错位**：左 3 张表 vs 右 4 张表（中间插了一张）——位置对齐法会让从插入点起的所有表都被判为"内容不等"，emit 成 del + ins 双张。视觉上比"识别到插入"略噪一些，但渲染不崩，PR 接受。
- **大表数超过 4080**：哑兜底（不抛错），走原 word-diff 路径。日常 review 文档不会触发。

## 测试策略

### 单测（`packages/frontend/tests/markdown-diff-table-word.test.ts`）

1. **identical table**：左右两份相同的简单表 → 输出无 marker，merged markdown 含一张完整表。
2. **header rename, same column count**：`| 项目名称 | 坦克大战游戏 |` vs `| 项目 | 内容 |`，下面 separator 同宽——分隔符行无任何 marker（关键不变量）；header / body 行带 ins/del。
3. **column count change**：左 2 列 vs 右 3 列、分隔符宽度不同（本 RFC 背景的真实样本）——分隔符行无 marker；两张表中间有 `\n\n` 段落边界。
4. **table ↔ paragraph 互转**：左纯段落、右是表（反之亦然）——段落 / 表分别落在 del / ins change 里。
5. **连续两张表 + 中间段落**：占位符 ID 对齐正确（左侧表 0 → 左表 / 右侧表 0 → 右表）。
6. **placeholder 字符碰撞**：input 自身含 `U+E010` 字面量——表格保护对该输入不命中，但不抛错；输出含字面量。
7. **fence + 表混排**：fence 仍正确跳过、表正确还原。

### 集成测（`packages/frontend/tests/markdown-diff-view.test.tsx` 扩展）

8. **render 集成（word）**：用样本 3 的 left / right 渲染 `<MarkdownDiffView>`，断言：
   - `getAllByRole('table')` 长度 ≥ 2
   - 不存在 `<p>` 节点其 textContent 包含 `|---` 子串
   - 至少一个 table 的 cell 含 `class="diff-del"`，至少一个含 `class="diff-ins"`
9. **段落 → 表互转的 word 模式渲染**：渲染含一个 `<table>` + 一个段落，且段落 / 表各自带 del / ins。
10. **render 集成（line / block）**：用样本 3 的同一对 left / right 切到 line / block，断言现有行为不变（表格仍渲染、无 `|---` 漏出）。

### 源码层断言（`packages/frontend/tests/markdown-diff-build.test.ts` 扩展）

11. `markdownDiff.ts` 必须 export `_internal.findTableBlocks` / `_internal.pretreatTablesForWordDiff` / `_internal.restoreTablePlaceholders` / `_internal.TABLE_SEP_RE` / `_internal.TABLE_PLACEHOLDER_BASE`；并断言 PUA placeholder 区间与 MARKERS 不重叠。

### 回归矩阵

| 模式  | RFC-010 现有用例 | 本 RFC 新增                                       |
| ----- | ---------------- | ------------------------------------------------- |
| word  | 全部保持绿       | + 12 个新用例（7 主用例 + 5 内部 helper）         |
| line  | 全部保持绿       | + 1 个回归（样本 3 line 模式表现）                |
| block | 全部保持绿       | + 1 个回归（样本 3 block 模式表现）               |
| 集成  | 全部保持绿       | + 2 个集成（word 渲染 `<table>` + 段落 / 表互转） |

## 不做的事

- 不动 `remarkDiffMarkers.ts`（与本 RFC 无关）。
- 不动 `MarkdownDiffView.tsx`（管线入口不变）。
- 不动 `DiffView.tsx`（公共 prop 不变）。
- 不引入新 css class（已有 `diff-ins` / `diff-del` 足够）。
- 不为 cell 级 word-diff 留接口（参考 §备选 C / D；未来若需要，再立 RFC）。

## 勘误：repairBrokenLinePrefixes 误拆表格行（2026-07-30 修复）

本 RFC 落地后，RFC-010 管线在 2026-07-16 新增了 `repairBrokenLinePrefixes`
（行首结构前缀被 marker 打断时把行拆成 DEL 行 + INS 行）。该修复对
`wrapTableRowCells` 产出的表格行存在系统性误报：整行 DEL/INS 的表格行的
"空侧视图"（如 `|  |  |`）经 `LEADING_BLOCK_PREFIX_RE` 的 `\|\s*` 分支得到
比 marker 前物理前缀（`| `）更长的前缀，`isPrefixInterrupted` 因此把每个带
marker 的表格行判为"被打断"，拆成"原行 + 空行 + `|  |  |`"三段——表格被
空行撕碎、`|---|` 与空 cell 行重组成两列空表、其余行降级为带裸 `|` 的段落。
word / line / block 三档全部命中；本 RFC 的 merged 字符串层断言（`includes`
形式）锁不住该回归，浏览器实测才暴露。

修复（`markdownDiff.ts`）：

1. `repairBrokenLinePrefixes` 跳过表格行（剥 blockquote 前缀后按
   `TABLE_ROW_RE` 判定）——表格行的 marker 由 `wrapTableRowCells` 严格放在
   cell 内部，行首 `|` 骨架不可能被真正打断，修复在此类行上只会造成破坏。
2. `wrapLines` 的结构行 skip（表分隔符 / thematic break）改为剥引用前缀后
   判定，blockquote 内表格 / hr 获得与顶层同等保护；新增 setext `===`
   下划线 skip（marker 落入会让标题降级、裸 `===` 可见）。
3. 顺带修复同类格式问题：GFM task list checkbox（`[x]`/`[ ]`）在 word 路径
   原子化并并入 `LEADING_BLOCK_PREFIX_RE`（勾选态切换此前因"del `x` + 空白
   ins 不包 marker"退化为 `[x ]` 字面量），切换现呈现为两条完整 task 行。

回归锁定：`packages/frontend/tests/markdown-diff-table-render.test.tsx`
（渲染级——以 `<table>`/`<input type=checkbox>`/`<h1>` 等渲染产物 + 无裸
`|` 泄漏为准，替代字符串 `includes` 断言的盲区）。

### 实现门跟进（同日）

Codex 实现门抓到 2 个 P1，均已修复并锁渲染级回归：

1. **结构行判定作用于 word 片段**：`wrapLines` 在 word 模式收到的是 diff
   片段而非完整物理行，新增的 setext `=` skip（以及既有的 hr / 表分隔符
   skip）会把 `a=b`→`a==b` 这类普通等号增删当成结构行跳过——不包 marker、
   删除侧以 context 形态残留旧文本。修复：`buildMergedMarkdown` 计算每个
   change 首 / 末行是否与物理行边界对齐并传入 `wrapLines`，结构行判定
   （fence / 表分隔符 / hr / setext / 表格行）只作用于两端完整的行。
2. **前缀即变更本体时高亮隐身**：checkbox 并入前缀正则后，`foo`→`- [x] foo`
   的 ins 片段恰为 `- [x] `，前缀外置 + 空 body + 空 marker 对清理让整行
   无任何高亮。修复：body 为空时整行入 marker，交给
   `repairBrokenLinePrefixes` 拆成完整 DEL 行 + INS 行（红旧段落 + 绿新
   task 项）；普通 `- ` 列表化的同形旧洞一并修复。

### 实现门二轮跟进（同日）

二轮复核再抓 3 P1 + 1 P2，均已修复：

1. **line 模式表结构变化撕表 / 丢列**：表头改名或列数变化时 diffLines 的
   DEL/INS 行留在同一 GFM 表里——第二行不是分隔符则整表降级段落；旧分隔符
   打头则新表头被当 body 行、超出旧列数的 cell 被 GFM 丢弃。新增
   `repairMergedTableRuns`：merged 中带 marker 且分隔符数量 / 位置不合法的
   顶层表段按单侧视图重建为"旧表 DEL + 新表 INS"（与 word/block 一致）；
   合法段（普通行级增删改）与无 marker 段原样保留。
2. **仅加删 setext 下划线的结构变化隐身**：`B`→`B\n===` 只 emit 下划线一行
   change、被结构 skip 放行，标题化全无高亮。word/line 路径把 setext 标题
   块（题行 + `=` 下划线）整块原子化，呈现为旧段落 DEL + 新标题 INS；
   题行不吸收占位符行防嵌套原子。
3. **引用空续行 `>` 被前缀本体规则误包**：完整出现的纯 blockquote 前缀行
   保持裸行（包 marker 会渲染字面绿 `>` 并撕开引用段落）；不完整 `> `
   片段（引用化）仍整行入 marker 由拆行修复呈现。
4. **checkbox 原子化误伤缩进代码块**（P2）：行首 ≥4 空格 / 含 tab 且上一
   条非空行不是列表行时按缩进代码处理、不原子化；嵌套 task 正常。

已知限制：缩进代码块本身从未原子化（自 RFC-010 起），其内部 word diff 的
marker 仍靠 remarkDiffMarkers 的 value 剥离兜底渲染单侧；如需与 fence 同
级的保护，另立 issue。

### 实现门三轮跟进（同日）

三轮复核再抓 3 P1 + 2 P2，核心教训：**merged 层面的表段重建不可行**——
分隔符行不携带 marker，"归属哪一侧"的信息在合并时已经丢失（对齐变化丢新
分隔符、全空 cell 行与字面 `| --- |` body 行被吞）。修复：

1. 删除 `repairMergedTableRuns`，line 模式改在 **diff 层**按结构键（表头 +
   分隔符两行）做**选择性整表折叠**：对侧不存在同键表的表整块折叠成占位
   符 → 表头改名 / 列数 / 对齐变化呈现"旧表 DEL + 新表 INS"，各带自己的
   分隔符、所有行原样保留；同键表不折叠，保持单表内行级增删改；identical
   输入两侧键全等 → 零折叠 → 逐字节还原不变量保持。
2. 孤立 `===` 行（文档开头 / 空行之后）是普通段落文本而非 setext 下划线，
   wrapLines 仅在 value 内上一行非空时才放行不包（setext 原子化保证真下
   划线总与题行同 value）。
3. `findSetextBlocks` 的占位符成员判定改用非 global 正则：`/g` 正则的
   `.test()` 会残留 `lastIndex`，左右两侧扫描互相污染，identical 输入也
   可能把占位符行误吸进题行 run、造成嵌套原子与 PUA 泄漏。

### 实现门四轮跟进（同日）

范围限定复核（base 固定到本工作独立父提交）再抓 2 P2，已修：

1. **结构键折叠的重排盲区**：两张表在一次编辑中互换结构键时两侧键集合相
   等、零折叠，畸形段照旧漏出。重建机制以**兜底**形态回归（主路径仍是
   diff 层折叠）：只处理折叠漏网的畸形段，归边规则修掉三轮否决的信息丢
   失——无 marker 行（context / 全空 cell / 字面 `| --- |` body 行）进两
   侧，裸分隔符行仅在"某侧恰积累 1 行（紧跟该侧表头）"时作该侧结构分隔
   符；畸形判定改为"run[1] 非分隔符形状，或存在紧跟 marker 行之后的额外
   分隔符形状行"，不再误伤含字面 `| --- |` body 行的合法单表；任一侧拼不
   出「表头+分隔符」最小结构则放弃重建。
2. **blockquote 内 setext**：`findSetextBlocks` 剥引用前缀后识别题行 +
   下划线（要求逐字相同前缀），`> Title` → `> Title\n> ===` 呈现为红引用
   段落 + 绿引用 H1；line 模式 setext 原子 pad 与 word 对齐（块间空行）。

### 实现门五轮跟进（同日，收敛）

1. **引用内 fence 与 setext 互斥**：`findSetextBlocks` 自带剥引用前缀的
   fence 状态机——引用内 fence（`> ~~~`）不受顶层 fence 原子化保护，此前
   code 里的 `foo\n===` 会被原子化渲染出赝品 `<h1>`。fence 内容里的
   marker 仍由 remarkDiffMarkers 的 value 剥离兜底（与缩进代码同级，
   引用内 fence 的整块原子化留作已知限制）。
2. **兜底重建判据的显式取舍**（Codex 认定分隔符归属在 merged 层不可安全
   推断）：保留"紧跟 marker 行的额外分隔符 → 畸形"判据。代价：紧邻字面
   `| --- |` body 行的单行编辑被放大为整表 DEL+INS（合法渲染、只是啰
   嗦）；收益：整表搬移 / 互换不退化成裸 `|` 段落汤。两侧行为均有渲染级
   测试锁定（`markdown-diff-table-render.test.tsx` 共 42 用例）。

### 实现门六轮跟进（同日，尾声）

六轮 findings 仅剩五轮新增 fence 状态机自身的 CommonMark 保真度（2 P2，
已修）：闭合 fence 只允许尾随空白（`~~~js` 是内容不是闭合）；引用容器结
束（空行或引用深度回落）时未闭合 fence 隐式关闭。两者失真都会让其后的
setext 化失去原子化、漏出字面 `===`。自四轮起 findings 严格收敛于上一轮
自身的修复面，实现门在此收口；遗留的已知限制（缩进代码块 / 引用内 fence
不做整块原子化，靠 remarkDiffMarkers value 剥离兜底渲染单侧）已在上文
与源码注释登记。


### C′ 落地交叉引用（2026-07-31）

RFC-240 已实现词档表格 cell 级细化：同结构键表格配对后单表呈现、变化
cell 内联红旧绿新。本 RFC 方案 A 的「整表 del + 整表 ins」退化自此仅
适用于**结构变化**（表头/分隔符/列数不同）与配对失败回退路径。
