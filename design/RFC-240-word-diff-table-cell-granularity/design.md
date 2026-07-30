# RFC-240 — 技术设计（v2，设计门一轮修订后）

## 接口契约

零公开接口变化。`buildMergedMarkdown(left, right, 'word')` 签名与语义外壳
不变;改动收敛在 `packages/frontend/src/lib/review/markdownDiff.ts` 的
word 预处理路径内部,外加两处**共享原语修正**(cell 切分、inline code
正则,见 §共享原语)。line / block 路径与 `remarkDiffMarkers` 不动。

## 数据流

现状(RFC-012 方案 A):每侧独立 `findTableBlocks` → 内容寻址
`alloc('table', content)` → 同内容同占位符(context)/异内容异占位符
(del+ins → 整表红 + 整表绿)。

本 RFC(C′)在 word 路径的表格原子化处引入**配对层**与**三视图条目**:

```
pairTables(leftTables, rightTables):
  阶段 1(内容寻址,保现有保障):内容逐字节相等的表按序配对
    → 走现路径(同占位符 → context → 原样还原)。
  阶段 2(同键序数):剩余表按 (结构键, 同键剩余序数) 配对
    → mergedTable = intraTableDiff(L, R)
    → 两侧替换为同一占位符 ph
    → pairLookup[ph] = { merged, left: L原文, right: R原文 }
  未配对:走现路径(整表 del / ins,现行为)。
```

阶段 1 在前是设计门一轮 P1 的修订:右侧在同键表**前面插入**新表时
(左 `[A,B]`、右 `[X,A,B]`),先让 A↔A、B↔B 以内容相等配对成 context,
X 走未配对整绿——否则序数配对会把两张未变的表伪造成修改。

### 还原时机(设计门一轮 P1 修订的核心)

共享占位符**不保证**被 jsdiff 判为 context:未变正文跨表移动时,全局
LCS 可能保正文弃 ph,ph 落进 removed + added 两条 change。因此配对条目
按 change 类型走**不同视图与不同时机**:

| ph 所在 change | 还原视图                     | 时机                                                                                     |
| -------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| removed        | `left` 原文(干净、无 marker) | 现有 `restoreAtoms`(早期,pad=true),随后 `wrapLines` 正常整表包 DEL——**优雅降级为现行为** |
| added          | `right` 原文                 | 同上,包 INS                                                                              |
| context        | `merged`(自带 marker)        | **最后一步**:`repairBrokenLinePrefixes` 之后新增 `restorePairedTables(merged)` 单趟替换  |

context-ph 以单字符行的形态穿过 wrapLines(context 不包)、空 marker 对
清理(ph 无 marker)、`repairMergedTableRuns`(ph 行不匹配
`TABLE_ROW_RE`,整段不成表段)与 `repairBrokenLinePrefixes`(无 marker
行直接跳过)——因此**兜底重建与行首修复永远看不到 C′ 单表**,设计门一轮
"marker 行紧邻字面 `| --- |` body 行会被重建拆表"的 P1 从机制上消除。
merged 表内嵌 marker 不会被二次包裹:唯一触碰它的 pass 是最后的单趟
替换。

`restoreAtoms` 对 pairLookup 条目的处理:removed/added 取 left/right,
context **跳过**(保留 ph 到最后);现有普通条目行为不变。

## intraTableDiff 算法

输入:同结构键的左右两份表文本。输出:单份含 marker 的表文本(merged)。

1. **表头 + 分隔符**:结构键相同 ⇒ 逐字节一致,原样输出。
2. **列数上限守卫**:任一侧任一 body 行的 cell 数超过分隔符声明列数时,
   **整对放弃细化**(返回 null → 调用方走未配对整表路径)。GFM 会截断
   超列 cell,任何单表内 marker 都不可见(设计门一轮 P1);整表红/绿呈现
   至少让行数与全表差异可见。
3. **body 行对齐**:`diffArrays<string>` 精确 LCS,unchanged 行原样输出。
4. **变更 run 内相似度配对**:
   - 行相似度 = 两行**非空白 token 多重集**的 Dice 系数。token 取法:
     每 cell 内容 `trim()` 后 `tokenizeForWordDiff`,丢弃 `/^\s*$/`
     token 后合并。任一侧非空白 token 数为 0 → 该行不可配对(相似度
     恒 0)。——空白 token 参与计算会让排版空格支配分数(设计门一轮
     P1:`| 甲 | 乙 |` vs `| 丙 | 丁 |` 含空白 Dice≈0.67)。
   - 候选序:全部 (i=removed 序, j=added 序) 按
     `(score 降序, |i-j| 升序, i 升序, j 升序)` 排序,贪心取 score≥0.5
     且双方未被消费的对子。阈值取 0.5(非空白 token 后语义为"至少一半
     内容相同"),tie-break 到 (i,j) 为止完全确定。
   - **输出顺序**(闭合设计门一轮 P1 的歧义):先输出全部未配对 removed
     行(按旧序,整行 DEL);再按**新侧顺序**输出配对行(merged 行)与
     未配对 added 行(整行 INS)。
5. **配对行的 cell 级 diff**:
   - cell 切分用共享 `splitTableCells`(§共享原语);两侧按位置 zip,
     短侧补空 cell。
   - 每对 cell:逐字节相等 → 原样;不等 → lead/tail 空白外置,inner
     词级 diff(`tokenizeForWordDiff` + `diffArrays` +
     `trimCommonAffixes`),del/ins 段分别包 marker,context 原样。
   - **cell 内 inline code 局部原子化**:inner 先以局部
     `PlaceholderAllocator`(seed = 左右两份表全文)对升级后的
     `INLINE_CODE_RE` 命中 span 原子化;词级 diff 后**函数内立即还原**。
     残留断言只检查**本局部 allocator 实际发放过的码点集合**,不做
     E010–EFFF 范围级判断——范围级会把用户文档自带的 PUA 误判为残留
     (设计门一轮 P2)。断言失败 → 整对放弃细化(fail-safe 同 §2)。
6. **整行 DEL / INS 的空 cell 可见性**:`wrapTableRowCells` 对空 inner
   不产 marker,全空行的增删会完全隐身(设计门一轮 P1)。修订:仅在
   intraTableDiff 输出的**增删行**里,空 cell 写为
   `lead + open + ' ' + close + tail`(单空格 marker 色块占位);
   context 行照旧不动,identical 不变量不受影响(identical 表在阶段 1
   即 context,不进本函数)。

## 共享原语(顺带修正的既有缺陷,全局受益)

1. **`splitTableCells(line)`**:以"前导反斜杠**奇偶**"判定 `|` 是否转义
   (奇=字面、偶=边界),替换 `wrapTableRowCells` 与本 RFC 的
   `(?<!\\)\|` 切分——旧正则把 `\\|`(转义反斜杠+真边界)误判为 cell
   内容,zip 错列(设计门一轮 P1)。行为变化仅影响含 `\\|` 的表,补
   定向回归。
2. **`INLINE_CODE_RE` 升级**:现正则内容段 `[^`\n]+?`禁一切反引号,
匹配不了 `` ``a`b` `(双反引号定界、内容含单反引号)的合法 code
   span(设计门一轮 P2)。升级为"开定界 `` `+ ``(后无 `` ` ``)+ 惰性
   内容 + 等长闭定界(前非 `` ` ``、后非 `` ` ``)",单行内匹配;全局
   word 路径与 cell 局部原子化共用,补定向回归。

## 明示的继承边界(非目标)

- **仅首 `|` 风格表**:`findTableBlocks` / `TABLE_ROW_RE` 自 RFC-012 起
  只识别行首 `|` 的表;无首 pipe 的 GFM 表(`a | b`)从未进入任何表格
  保护,本 RFC 不扩大也不缩小该边界(设计门一轮 P1 按边界明示处理)。
- 引用内表格、行/块档、正文词 diff:零改动。

## 与现有模块的耦合点

| 模块                                                 | 关系                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| `findTableBlocks` / `tableStructureKey`              | 复用,零改动                                                   |
| `PlaceholderAllocator`                               | 全局(配对 ph)+ intraTableDiff 局部(cell 内 code)              |
| `restoreAtoms`                                       | 扩展:pairLookup 条目按 change 类型选视图,context 跳过         |
| `buildMergedMarkdown`                                | 末尾新增 `restorePairedTables`(repairBrokenLinePrefixes 之后) |
| `wrapTableRowCells`                                  | 改用 `splitTableCells`;其余不变                               |
| `repairMergedTableRuns` / `repairBrokenLinePrefixes` | 零改动(context-ph 对其不可见)                                 |
| line / block 路径                                    | 零改动                                                        |

## 失败模式

- **正文跨表移动**:ph 落 del+ins → 还原 left/right 干净原文 → 现行为
  (整表红+绿),无双重 marker,无表段畸形。
- **列数溢出 / 局部占位符残留**:整对放弃细化 → 现行为。
- **同键多张已修改表**:阶段 2 序数配对;错配的代价是"两张都显示 cell
  级差异但配串了",不产生非法渲染;记录为已知噪音上限。
- **占位符区间耗尽**:配对层按现有 alloc 失败语义回退原文,不细化。
- **identical 输入**:阶段 1 全部内容相等 → 与现路径逐字节同一,零风险。

## 测试策略(必写 case)

渲染级断言为主,新文件 `markdown-diff-table-cell.test.tsx` +
`markdown-diff-table-word.test.ts` 修订:

1. 单 cell 修改 → 恰 1 张表;变更 cell 同含 `.diff-del`+`.diff-ins`;
   其余 cell 零 span;无裸 `|`。
2. 多 cell / 多行修改互不串扰;CJK cell;inline code cell(含
   ` `a `b` ` 多反引号形态,code span 结构完整)。
3. 行增/删 → 单表内整行绿/红;**全空 cell 行**增删 → 色块占位可见
   (`.diff-ins`/`.diff-del` 存在)。
4. 相似度配对:编辑行与原行配对;无关行不硬配(阈值 0.5 用非空白
   token 复算锁定);重排+编辑 run 的输出顺序锁定(先 DEL 后新序)。
5. 超列行 → 整对回退现行为(两张表)。
6. 同键表前插同键新表(左 `[A,B]` 右 `[X,A,B]`)→ A、B 保持 context,
   仅 X 整绿(阶段 1 保障)。
7. **正文跨表移动** → 表以现行为呈现(两张干净整表),无双重 marker、
   无 `|  |  |` 指纹(P1-1 场景锁定)。
8. C′ 单表后接字面 `| --- | --- |` body 行 → 单表不被兜底重建拆开
   (P1-2 场景锁定)。
9. `\\|` cell 切分定向回归(splitTableCells 前后行为)。
10. 局部残留断言:构造 cell 含文档自带 U+E010 字符 + 另一 cell 修改 →
    仍走细化(不误判残留);伪造残留 → 回退整表。
11. identical 输入逐字节还原(全档,含配对表混排文档)。
12. 源码层锁:line / block 路径关键段零改动(防误伤)。

## 设计门记录

- 一轮(2026-07-31,exec 直驱,`NEEDS_REVISION`,0 P0 / 8 P1 / 2 P2):
  全部折入本 v2——共享占位符 context 不保证(→ 三视图 + 还原时机拆分)、
  兜底重建拆 C′ 单表(→ context-ph 最后还原)、Dice 空白支配(→ 非空白
  token + 阈值 0.5)、同键序数破坏内容寻址(→ 两阶段配对)、空行/超列
  隐身(→ 色块占位 + 整对回退)、`\\|` 切分与首 pipe 边界(→
  splitTableCells + 边界明示)、tie-break 与输出顺序(→ 完全确定化)、
  测试验收自相矛盾(→ plan.md 列明有意更新的既有断言)、多反引号 code
  span(→ INLINE_CODE_RE 升级)、PUA 残留误判(→ 按发放集合断言)。
