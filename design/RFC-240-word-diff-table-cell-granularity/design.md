# RFC-240 — 技术设计（v3，设计门二轮修订后）

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
  阶段 1(纯内容寻址,零显式配对):内容在对侧存在(多重集意义)的表
    → 完全沿用现路径 alloc('table', content):同内容 → 同占位符,
      由全局 LCS 自由对齐(今天 identical / 移动 / 重复表的全部行为
      逐字节保留)。
  阶段 2(同键剩余序数):两侧都"内容无对应"的剩余表,按
    (结构键, 剩余序数) 配对
    → mergedTable = intraTableDiff(L, R)
    → 两侧替换为同一占位符 ph
    → pairLookup[ph] = { merged, left: L原文, right: R原文 }
  仍未配对:走现路径(整表 del / ins,现行为)。
```

阶段 1 **不做任何显式配对**是设计门二轮 P1 的修订:内容重复的表
(左 `[A,A]`、右 `[X,A]`)若按"内容相等 FIFO 配对"会产生跨位置交叉
(左₁A↔右₂A),两个共享占位符在序列里交叉、LCS 只能保一个,连未变的
表也被打成 DEL+INS。改为纯内容寻址后,三个 A 共用同一占位符,LCS 自然
对齐出「首 A 删、X 增、次 A context」——与今天完全一致。一轮场景
左 `[A,B]`、右 `[X,A,B]` 同样由内容寻址天然成立(X 剩余、无左侧剩余
同伴 → 整绿)。

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
   相似度配对**严格限定在单个连续变更 run 内**;重复行场景(如某表两行
   同文、其一被改写)会被精确 LCS 拆到 context 两侧、分属不同 run,此时
   **有意呈现为整行 DEL + 整行 INS**(合法渲染,变化可见),不做跨
   context 配对(设计门二轮 P1 以规范闭合;测试锁定该形态)。
4. **变更 run 内相似度配对**:
   - 行相似度 = 两行**内容 token 多重集**的 Dice 系数。token 取法:
     每 cell 内容 `trim()` 后 `tokenizeForWordDiff`,丢弃空白 token
     (`/^\s*$/`)**与纯标点/符号 token**(`/^[\p{P}\p{S}]+$/u`)后
     合并。任一侧内容 token 数为 0 → 该行不可配对(相似度恒 0)。
     ——空白会让排版空格支配分数(一轮 P1);markdown 标点同理:
     `**甲**` vs `**乙**` 若计入四个共同 `*`,Dice=0.8 会把无关行硬配
     (二轮 P1)。cell 内原子化产生的占位符 token(PUA,Unicode Co 类)
     不属 `\p{P}\p{S}`,按内容计入——相同 code span/链接提升相似度是
     期望行为。
   - 候选序:全部 (i=removed 序, j=added 序) 按
     `(score 降序, |i-j| 升序, i 升序, j 升序)` 排序,贪心取 score≥0.5
     且双方未被消费的对子。阈值取 0.5(非空白 token 后语义为"至少一半
     内容相同"),tie-break 到 (i,j) 为止完全确定。
   - **输出顺序**(闭合设计门一轮 P1 的歧义):先输出全部未配对 removed
     行(按旧序,整行 DEL);再按**新侧顺序**输出配对行(merged 行)与
     未配对 added 行(整行 INS)。
5. **配对行的 cell 级 diff**:
   - cell 切分用共享 `splitTableCells`(§共享原语);两侧按位置 zip,
     短侧补空 cell。**合并行骨架 = max(旧侧, 新侧) cell 数**:每个
     zip 出的 cell 都在输出行占一格(短侧缺格以单空格占位),被删的
     尾列内容不丢、新增尾列可见(设计门二轮 P2 的骨架规范)。
   - 每对 cell:逐字节相等 → 原样;不等 → lead/tail 空白外置,inner
     词级 diff(`tokenizeForWordDiff` + `diffArrays` +
     `trimCommonAffixes`),del/ins 段分别包 marker,context 原样。
   - **cell 内 inline code 与行内链接局部原子化**:inner 先以局部
     `PlaceholderAllocator`(seed = 左右两份表全文)对升级后的
     `INLINE_CODE_RE` 命中 span 以及行内链接
     `\[label\](url)`(保守单行正则,label 无 `]`、url 无 `)`)原子化;
     词级 diff 后**函数内立即还原**。链接原子化是设计门二轮 P1 的修订:
     URL-only 变化若让 marker 落进 url,`remarkDiffMarkers.stripNodeStrings`
     会解析成单侧 URL、零可见高亮;原子化后 URL 变化呈现为旧链接整红 +
     新链接整绿。残留断言只检查**本局部 allocator 实际发放过的码点集合**,
     不做 E010–EFFF 范围级判断(一轮 P2);断言失败 → 整对放弃细化
     (fail-safe 同 §2)。fail-safe 分支经 `_internal` 注入桩 allocator
     测试(公共输入构造不出真残留——全局/局部 allocator 都避让文档自带
     PUA,设计门二轮 P2)。
6. **整行 DEL / INS 的空 cell 可见性与骨架**:`wrapTableRowCells` 对空
   inner 不产 marker,全空行的增删会完全隐身(设计门一轮 P1)。修订:仅
   在 intraTableDiff 输出的**增删行**里,空 cell 写为
   `lead + open + ' ' + close + tail`(单空格 marker 色块占位);增删行
   保持**自身源码骨架**(cell 数少于声明列数时,GFM 渲染的隐式补齐列无
   marker——那是渲染属性,marker 只覆盖源码中存在的 cell,设计门二轮
   P2 文档化)。context 行照旧不动,identical 不变量不受影响(identical
   表在阶段 1 即 context,不进本函数)。

## 共享原语(顺带修正的既有缺陷,全局受益;**有意的全局行为增量**)

以下两项是既有缺陷修复,按仓库「面向代码最合理」准则**全局生效**,不为
本 RFC 单独 fork 一份 cell 专用变体。它们构成对「结构变化保持现行为 /
正文一字不改」的**显式例外**(proposal §非目标同步收窄,设计门二轮 P1
的矛盾以此闭合),影响面与定向回归:

- `splitTableCells`:仅影响含「偶数反斜杠 + `|`」(如 `\\|`)的表格行
  的 cell 边界(所有表格 wrap 路径统一受益);
- `INLINE_CODE_RE` 升级:仅影响「多反引号定界、内容含反引号」的 code
  span 在全 word 路径的原子化(此前不原子化 → marker 落进 code、单侧
  渲染;升级后整 span del/ins,高亮可见)。

1. **`splitTableCells(line)`**:以"前导反斜杠**奇偶**"判定 `|` 是否转义
   (奇=字面、偶=边界),替换 `wrapTableRowCells` 与本 RFC 的
   `(?<!\\)\|` 切分——旧正则把 `\\|`(转义反斜杠+真边界)误判为 cell
   内容,zip 错列(设计门一轮 P1)。行为变化仅影响含 `\\|` 的表,补
   定向回归。
2. **`INLINE_CODE_RE` 升级**:现正则内容段禁一切反引号,匹配不了
   「双反引号定界、内容含单反引号」的合法 code span(设计门一轮 P2)。
   升级为「开定界为反引号 run(其后非反引号)+ 惰性内容 + 等长闭定界
   (前后均非反引号)」,单行内匹配;全局 word 路径与 cell 局部原子化
   共用,补定向回归。(本段刻意用文字描述而非字面量:嵌套反引号示例会
   被格式化工具破坏——design/ 目录禁跑 prettier,见 dev-gotchas。)

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

## 测试策略(必写 case,共 16 项;plan.md 验收按本编号引用)

渲染级断言为主,新文件 `markdown-diff-table-cell.test.tsx` +
`markdown-diff-table-word.test.ts` 修订:

1. 单 cell 修改 → 恰 1 张表;变更 cell 同含 `.diff-del`+`.diff-ins`;
   其余 cell 零 span;无裸 `|`。
2. 多 cell / 多行修改互不串扰;CJK cell;inline code cell(含「双反引
   号定界、内容有单反引号」的多反引号形态,code span 结构完整)。
3. 行增/删 → 单表内整行绿/红(源码中存在的 cell 全包 marker);**全空
   cell 行**增删 → 色块占位可见;**短行**(cell 数少于声明列)增删 →
   存在的 cell 绿/红,隐式补齐列无 marker(骨架语义锁定)。
4. 相似度配对:编辑行与原行配对;无关行不硬配——含纯标点包装
   (`**甲**` vs `**乙**`)与空白支配两个反例(阈值 0.5 用内容 token
   复算锁定);重排+编辑 run 的输出顺序锁定(先 DEL 后新序)。
5. 超列行 → 整对回退现行为(两张表)。
6. 同键表前插同键新表(左 `[A,B]` 右 `[X,A,B]`)→ A、B 保持 context,
   仅 X 整绿(阶段 1 内容寻址保障)。
7. **内容重复表**(左 `[A,A]` 右 `[X,A]`,X 与 A 同键)→ 首 A 整红、
   X 整绿、次 A context——无交叉配对(设计门二轮 P1 场景锁定)。
8. **正文跨表移动** → 表以现行为呈现(两张干净整表),无双重 marker、
   无 `|  |  |` 指纹。
9. C′ 单表后接字面 `| --- | --- |` body 行 → 单表不被兜底重建拆开。
10. **URL-only cell 变化**(`[API](old)` → `[API](new)`)→ 旧链接红 +
    新链接绿,`.diff-del`/`.diff-ins` 均可见(链接原子化锁定)。
11. **表内重复行改写**(`[A,A]` 行 → `[X,A]` 行)→ 整行 DEL + 整行
    INS(run 边界语义锁定)。
12. 合并行骨架:配对行 cell 数 2→3 → 三格输出,尾列 ins 可见;3→2 →
    被删尾列内容红标可见。
13. `\\|` cell 切分定向回归(splitTableCells 前后行为,含非细化路径)。
14. 局部残留 fail-safe:经 `_internal` 注入桩 allocator 伪造残留 →
    回退整表;正常路径含文档自带 U+E010 的 cell → 仍细化(不误判)。
15. identical 输入逐字节还原(全档,含配对表混排文档)。
16. 源码层锁:line / block 路径关键段零改动(防误伤)。

## 设计门记录

- 二轮(2026-07-31,exec 直驱,`NEEDS_REVISION`,0 P0 / 6 P1 / 2 P2):
  全部折入本 v3——plan 未同步 v2(→ T1/T2 重写 + 编号对齐)、内容重复
  表交叉配对(→ 阶段 1 改纯内容寻址、零显式配对)、URL-only cell 隐身
  (→ cell 内链接原子化)、全局原语与「一字不改」矛盾(→ 显式例外 +
  影响面列举)、标点支配 Dice(→ 内容 token 再排除 `\p{P}\p{S}`)、
  重复行跨 run(→ 规范闭合为整行呈现 + 测试)、短行/变列骨架
  (→ max-cell 骨架 + 隐式列语义)、fail-safe 不可测(→ `_internal`
  注入桩)。
- 一轮(2026-07-31,exec 直驱,`NEEDS_REVISION`,0 P0 / 8 P1 / 2 P2):
  全部折入本 v2——共享占位符 context 不保证(→ 三视图 + 还原时机拆分)、
  兜底重建拆 C′ 单表(→ context-ph 最后还原)、Dice 空白支配(→ 非空白
  token + 阈值 0.5)、同键序数破坏内容寻址(→ 两阶段配对)、空行/超列
  隐身(→ 色块占位 + 整对回退)、`\\|` 切分与首 pipe 边界(→
  splitTableCells + 边界明示)、tie-break 与输出顺序(→ 完全确定化)、
  测试验收自相矛盾(→ plan.md 列明有意更新的既有断言)、多反引号 code
  span(→ INLINE_CODE_RE 升级)、PUA 残留误判(→ 按发放集合断言)。
