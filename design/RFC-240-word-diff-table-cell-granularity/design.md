# RFC-240 — 技术设计（v13,设计门十二轮修订后）

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
  阶段 1(纯内容寻址,零显式配对):判定用 **set 语义**——某表内容在
    对侧内容集合中存在(不消费、不计次)即走现路径
    alloc('table', content):同内容 → 同占位符,由全局 LCS 自由对齐
    (今天 identical / 移动 / 重复表的全部行为逐字节保留)。
  阶段 2(同键剩余序数):**两侧都**"内容不在对侧集合"的剩余表,按
    (结构键, 剩余序数) 配对
    → mergedTable = intraTableDiff(L, R)
    → 两侧替换为同一占位符 ph;ph 按
      'tablepair\0'+左内容字符长度+'\0'+左内容+右内容 **内容寻址**
      (长度前缀保证键单射——表内容可含 NUL,裸 '\0' 分隔符会让
      (P, Q\0R) 与 (P\0Q, R) 碰撞、pairLookup 串表,设计门八轮 P2;
      两对同键修改表内容必不同 → ph 必不同;完全相同的一对出现两次
      共享 ph 且还原目标一致,正确)
    → pairLookup[ph] = { merged, left: L原文, right: R原文 }
  仍未配对:走现路径(整表 del / ins,现行为)。
```

阶段 1 **不做任何显式配对**是设计门二轮 P1 的修订;三轮进一步把成员
判定钉死为 **set 语义(不消费)**:左 `[A,A]`、右 `[X,A]` 中,左侧两个
A 的内容都在右侧集合里 → 全部走内容寻址(三个 A 共用同一占位符),X
不在左侧集合 → 剩余,但左侧无剩余同伴 → X 走未配对整绿;LCS 自然对齐
出「首 A 删、X 增、次 A context」——与今天完全一致(测试 #7 的唯一
解)。多重集消费语义(匹配一个 A、剩一个进阶段 2 与 X 配对)被显式
否决。一轮场景左 `[A,B]`、右 `[X,A,B]` 同样天然成立。

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

输入:同结构键的左右两份表文本。输出:单份含 marker 的表文本(merged),
或 null(放弃细化,调用方走未配对整表路径)。

0. **cell 计数与骨架定义**(设计门三轮 P1,四轮 P1 补缩进):cell 列表 =
   `splitTableCells(row)` 的 parts **剥去首哑段**(行首缩进 + `|` 之前
   的空白段)**与尾哑段**(行以未转义 `|` 结尾时其后的空白段)。哑段剥除
   **仅当该端存在未转义 pipe**:行(尤其分隔符行)允许无首/尾 pipe
   (`---|---` 是 GFM 与 `TABLE_SEP_RE` 都接受的合法分隔行),此时该端
   首/尾 part 是真实 cell,不得剥除(设计门五轮 P2);声明列数按同规则
   计数。`TABLE_ROW_RE` 允许 0–3 空格缩进。变更行(merged / 整行 DEL / 整行 INS)以
   **规范骨架**输出:`indent + | cell₁ | cell₂ | … |`(首尾 pipe 齐全,
   cell 之间单 `|`),其中 **indent = 该行来源侧的原始行首空白**
   (merged / INS 行取新侧、DEL 行取旧侧)——列表容器内 2–3 空格缩进的
   表,变更行若被规范到 0 列会脱离容器、解析成裸管道段落(四轮 P1)。
   **奇偶安全边界**(设计门十一轮 P1):任一 cell 的输出内容以**奇数个
   反斜杠结尾**时,在其后、闭合 `|` 之前垫一个空格——否则重组出的
   `\|` 被判为转义 pipe,末 cell 内容被改写(`path\` 渲染成 `path|`);
   垫片空格属 cell 尾空白,GFM 渲染时 trim 掉,内容保真。
   cell 内自身的 lead/tail 空白保留,补位 cell 为单空格。**零 cell 行**
   (裸 `|`,首尾哑段剥后为空)在 DEL/INS 时合成单个「空格 + marker
   色块」cell(`| {M} {m} |` 形态),保证增删可见(四轮 P2)。
   context 行永远原样,不规范化。
1. **表头 + 分隔符**:结构键相同 ⇒ 逐字节一致,原样输出。
2. **GFM 等价、列数与规模守卫**:(a) 表头 cell 数 ≠ 分隔符 cell 数时整
   对放弃——remark-gfm 根本不会把它解析成表,细化无意义(设计门三轮
   P1);(b) 任一侧任一 body 行 cell 数超过声明列数时整对放弃——GFM 截
   断超列 cell,单表内 marker 不可见(一轮 P1);(c) **行数守卫,先于
   任何行级 LCS**(设计门九轮 P1):max(两侧 body 行数) > 500 时整对
   放弃——`diffArrays` 全改写场景是 O((m+n)·D) 的同步计算,5,000 行级
   别的行 LCS 本身就会冻结主线程,候选上限(§4)拦不住它;今日整表路径
   对这种表只花 O(1) token。放弃 = 返回 null,现行为呈现。
2b. **进场即原子化**(设计门三轮 P1 时机闭合):对两侧每个 body cell 的
   inner,先以局部 allocator 依次原子化:**inline code 最先**(升级版
   `INLINE_CODE_RE`,其 opening 反引号 run 单独做前导反斜杠奇偶判定
   ——code span **内部**反斜杠是 CommonMark 字面量,不做转义处理;若让
   转义对先行,内容以 `\` 结尾的合法 code span 的闭合反引号会被吞进
   转义原子、span 原子化失败,marker 落进 `inlineCode.value` 被单侧化,
   设计门七轮 P1);**随后转义对**(`\` + CommonMark 可转义标点,单
   原子——六轮 P1:marker 落在 `\` 与 `|` 之间会让转义失效、列数爆炸;
   转义对成原子后 diff 永不拆散它,且 image/link/math 的 opener 不再
   需要奇偶判定——被转义的 opener 已被吞进转义原子);再**行内图片**(`![label](url)`,约束同链接;
   设计门五轮 P1:图片若被 link 正则从 `[` 处劈开会还原成字面 `!` +
   链接,排除又会让 marker 落进 `image.url` 被单侧化;独立原子类按整体
   del/ins 呈现)、行内链接、行内数学式(`$...$`,单行、内容无 `$`,
   两端非空白;数学式纳保护集是三轮 P1:marker 落入 `inlineMath.value`
   会被 `resolveMarkedString` 单侧化,零可见高亮)。三类 opener 的转义
   判定统一用**反斜杠奇偶**(与 `splitTableCells` 同规则,四轮 P1):
   奇数个前导反斜杠 = 字面文本不原子化(`\$x$`、`\[x](u)`),偶数个 =
   有效定界(`\\` 后的 code span 照常原子化)。**行相似度与 cell
   diff 都在原子化后的文本上进行**;原子 token(PUA,Co 类)按内容
   token 计入 Dice——相同 code/链接/公式提升相似度是期望行为,变更的
   原子两侧 ph 不同、贡献 0。
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
     **规模上限**(设计门八轮 P1,九轮定位为第二道):行数守卫
     (§2(c))已在行 LCS 之前拦掉巨表;本条兜 run 级——单 run 候选数
     removed×added > 2,500(50×50)时,该 run 跳过相似度配对、直接
     整行 DEL(旧序)+ 整行 INS(新序)呈现。上限内复杂度
     O(候选 × cell token) 与 jsdiff 主调用同阶。
   - **输出顺序**(闭合设计门一轮 P1 的歧义):先输出全部未配对 removed
     行(按旧序,整行 DEL);再按**新侧顺序**输出配对行(merged 行)与
     未配对 added 行(整行 INS)。
5. **配对行的 cell 级 diff**:
   - cell 切分与计数按 §0;两侧按位置 zip,短侧补空 cell。**合并行
     骨架 = max(旧侧, 新侧) cell 数**、按 §0 规范骨架输出:每个 zip 出
     的 cell 占一格,被删的尾列内容不丢、新增尾列可见(二轮 P2 +
     三轮 P1 的骨架规范)。
   - 每对 cell:逐字节相等 → 原样;不等 → lead/tail 空白外置,inner
     词级 diff(`tokenizeForWordDiff` + `diffArrays` +
     `trimCommonAffixes`),del/ins 段分别包 marker,context 原样。
     **非空 ↔ 空 cell**(设计门六轮 P1):一侧 inner 为空时,空侧以单
     空格 marker 色块呈现(`{D}old{d}{I} {i}` / `{D} {d}{I}new{i}`),
     保证红旧绿新两侧都可见——否则空侧零 token、`remarkDiffMarkers`
     还会丢弃无 children 的 marker,只剩单侧高亮。
     **整 cell 降级的两条结构性规则**(四轮/五轮 P1,七轮 P1 收束为
     终态白名单):词级细化只允许发生在「纯文本 + 受保护原子」的 cell
     上,否则整 cell 降级为「旧 inner 整红 + 新 inner 整绿」(marker 包
     完整 span,一切行内结构与高亮保留;与今日整表呈现同粒度,永不劣于
     现状):
     (a) **残留语法降级**:原子化后的任一侧残留文本仍含
     `` ` ``/`[`/`]`/`<`/`>`/`$`/`&` 之一(未被消费的 code/链接/图片/
     尖括号 autolink/HTML/数学/实体语法征兆),**或匹配 GFM 字面
     autolink 模式**(`https?://`、`www.`、email 形态 `x@y.z`——字符级
     白名单覆盖不了 `.`/`@`,八轮 P1)→ 整 cell 降级。
     **降级段的双侧词法隔离垫片**(设计门九/十/十一轮迭代定型):降级
     输出的每个 marker 段做**双侧**空格垫片——open marker 之后与 close
     marker 之前各垫一个空格(`{D} old {d}{I} new {i}` 形态,垫片在
     着色 span 内,渲染为无害的着色空白)。close 垫片防「文本后随
     URL」的 close marker 被 linkify 吸收拼接(九轮 P1);open 垫片给
     `_` emphasis(左翼规则需要前邻空白/标点,PUA 紧邻会字面化,十一轮
     P2)与字面 autolink(previousWww/previousProtocol 需要边界)恢复
     干净左边界。**呈现契约**:降级 cell 的每侧独立完成行内解析——
     `*`/`_` emphasis、字面 autolink 的 link 节点逐侧生成且整体着色,
     href 两侧各自精确、禁止拼接/单侧 href。检测模式**大小写不敏感**
     (`/https?:\/\//i`、`/www\./i`、email 同——micromark 宽容大小写,
     敏感检测会被 `HTTPS://` 绕过降级,十轮 P2)。cell 前后空白本就在
     marker 外,GFM cell trim 语义不受影响。这把「保护集外
     语法继承现状」从枚举承诺变成结构保证——marker 不可能落进任何
     remark 节点 value(七轮 P1:html.value / 嵌套括号 link.url 在
     cell 细化下会被单侧化,是相对现状的新回归,枚举式保护集堵不完)。
     (b) **定界符触碰降级**:diff 的任一 del/ins token 含 emphasis/
     删除线定界字符(`*`/`_`/`~`)→ 整 cell 降级(仅 token 级包 marker
     会被 remark 拆散进空子树:轻则零高亮 `**same**`→`*same*`,重则
     格式碎裂 `**old**`→`*new*`)。
     代价:cell 含字面语法字符时粒度变粗为整 cell——合法渲染,可接受。
   - **原子化在 §2b 已完成**(code → 转义对 → image → link → math 顺序;
     link 的 label / math 的内容里含先前原子的 ph 时允许嵌套)。词级 diff 后**函数内
     循环还原至不动点**:反复替换已发放码点直到 merged 无任何已发放
     码点或达迭代上限(= 发放数);嵌套原子(如 label 含 code span 的
     链接)由循环自然解开——这是设计门三轮 P1 的修订,单趟还原会把
     嵌套 ph 漏成残留、误触发回退。链接原子化是二轮 P1(URL-only 变化
     否则被 `stripNodeStrings` 单侧化);正则保守(label 无 `]`、url 无
     `)`、math 内容无 `$`);**保护集外的行内语法不再有"继承现状"残余
     类**——§5(a)/(b) 的结构性降级保证此类 cell 一律整 cell 红绿,
     marker 不落入任何节点 value(八轮 P1 消除三轮遗留的矛盾表述)。循环后仍有已发放码点残留(真 bug)→ 整对放弃细化
     (fail-safe 同 §2);该分支经 `_internal` 注入桩 allocator 测试。
6. **整行 DEL / INS 的空 cell 可见性与骨架**:`wrapTableRowCells` 对空
   inner 不产 marker,全空行的增删会完全隐身(设计门一轮 P1)。修订:仅
   在 intraTableDiff 输出的**增删行**里,空 cell 写为
   `lead + open + ' ' + close + tail`(单空格 marker 色块占位);增删行
   保持**自身源码骨架**(cell 数少于声明列数时,GFM 渲染的隐式补齐列无
   marker——那是渲染属性,marker 只覆盖源码中存在的 cell,设计门二轮
   P2 文档化)。context 行照旧不动,identical 不变量不受影响(identical
   表在阶段 1 即 context,不进本函数)。

## 共享原语(顺带修正的既有缺陷,全局受益;**有意的全局行为增量**)

0. **`trimCommonAffixes` 字素簇安全回退**(设计门十二轮 P1):现实现的
   公共前后缀提取只保护 surrogate pair;边界落在「基字 + 变体选择符
   (U+FE00–FE0F / U+E0100–E01EF)/ ZWJ(U+200D)/ 组合标记
   (`\p{M}`)」之间时会把基字提成 context、把选择符单独放进红绿
   span——选择符不能跨元素作用,`葛󠄀`→`葛󠄁` 这类变更两侧字形与有效
   高亮全丢。修法:前缀在分歧点、后缀在边界点若紧邻上述 extend 类
   字符则整字素回退。该缺陷今日正文词 diff 同样命中,修复全局受益;
   补 IVS 与 ZWJ emoji 定向回归(cell 内 + 正文各一)。

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
   号定界、内容有单反引号」形态与「内容以 `\` 结尾」形态,code span
   结构完整、高亮可见——七轮 P1 顺序锁定);**残留语法降级**:含
   raw HTML span / 嵌套括号 URL / 实体的 cell 变更 → 整 cell 旧红+新绿
   (七轮 P1 白名单锁定);转义原子:`\\` 后 code span 原子化生效、`\$x$`/`\[x](u)` 字面文本不被
   误原子化(四轮 P1,v7 起由转义对原子化承担);**cell 含 `\|` 时的
   变更** → 转义对不被 marker 劈开、列数不变、高亮可见(六轮 P1);
   **非空↔空 cell 配对变更** → 红旧 + 绿色块两侧可见(六轮 P1);**定界符-only 与混合变更**(`**same**`→`*same*`
   与 `**old**`→`*new*`)→ cell 整体旧红+新绿、emphasis 结构两侧都
   保留(四轮 + 五轮 P1);**图片 cell**(`![x](old.png)`→
   `![x](new.png)`)→ 旧图红 + 新图绿、image 结构完整(五轮 P1);
   **列表容器内缩进表**cell 修改 → 单表保持在容器内、无裸 `|`
   (四轮 P1);**无首 pipe 分隔行**的表 → cell 计数正确、仍走细化
   (五轮 P2)。
3. 行增/删 → 单表内整行绿/红(源码中存在的 cell 全包 marker);**全空
   cell 行**增删 → 色块占位可见;**零 cell 裸 `|` 行**增删 → 合成色块
   cell 可见(四轮 P2);**短行**(cell 数少于声明列)增删 → 存在的
   cell 绿/红,隐式补齐列无 marker(骨架语义锁定)。
4. 相似度配对:编辑行与原行配对;无关行不硬配——含纯标点包装
   (`**甲**` vs `**乙**`)与空白支配两个反例(阈值 0.5 用内容 token
   复算锁定);重排+编辑 run 的输出顺序锁定(先 DEL 后新序);
   **单 cell 行仅 URL 变化**(原子化后 Dice=0)→ 整行红/绿呈现锁定
   (原子化时机语义,三轮 P1);**超限 run**(候选 > 50×50)→ 整行
   DEL+INS、渲染合法且耗时有界(八轮 P1);**行数守卫**(>500 行)→
   行 LCS 之前整对回退(九轮 P1,用行数构造锁定不做真 5000 行压测);
   **字面 autolink cell**(email、`https://`、`www.`、大写变体
   `HTTPS://`,含「文本后随 URL」形态)→ 每侧独立 link 节点、整体
   红/绿着色、href 各自精确,**DOM 中不存在拼接 href / 红旧文本指向新
   href**(双侧垫片契约);**`_` emphasis 降级 cell** → 两侧 `<em>`
   保留且着色(十一轮 P2);**单 cell 超长**(>500 token)与**累计预算
   超限** → 整 cell 降级、耗时有界(十一轮 P1);**尾反斜杠 cell 的
   奇偶安全序列化**(`path\` 重组后仍渲染 `path\`,十一轮 P1);
   **行数守卫源码序锁**(守卫先于 `diffArrays`,十轮 P1);**pair 键
   单射**:构造含 NUL 的同键表组不串表(八轮 P2)。
5. 超列行 → 整对回退现行为(两张表)。
6. 同键表前插同键新表(左 `[A,B]` 右 `[X,A,B]`)→ A、B 保持 context,
   仅 X 整绿(阶段 1 内容寻址保障)。
7. **内容重复表**(左 `[A,A]` 右 `[X,A]`,X 与 A 同键)→ 首 A 整红、
   X 整绿、次 A context——无交叉配对(设计门二轮 P1 场景锁定)。
8. **正文跨表移动** → 表以现行为呈现(两张干净整表),无双重 marker、
   无 `|  |  |` 指纹。
9. C′ 单表后接字面 `| --- | --- |` body 行 → 单表不被兜底重建拆开。
10. **URL-only cell 变化**(多列表,其它 cell 提供相似度)→ 配对行内
    旧链接红 + 新链接绿;**数学式 cell**(`$x+1$` → `$x-1$`)→ 旧式红 +
    新式绿(math 原子化,三轮 P1);**嵌套原子**(label 含 code span 的
    链接变更)→ 循环还原无残留、高亮可见。
11. **表内重复行改写**(`[A,A]` 行 → `[X,A]` 行)→ 整行 DEL + 整行
    INS(run 边界语义锁定)。
12. 合并行骨架:配对行 cell 数 2→3 → 三格输出,尾列 ins 可见;3→2 →
    被删尾列内容红标可见。
13. `\\|` cell 切分定向回归(splitTableCells 前后行为,含非细化路径);
    首尾哑段剥除与「无尾 pipe 行」计数、规范骨架输出锁定;
    「表头≠分隔符 cell 数」→ 整对回退锁定(三轮 P1)。
14. 局部残留 fail-safe:经 `_internal` 注入桩 allocator 伪造残留 →
    回退整表;正常路径含文档自带 U+E010 的 cell → 仍细化(不误判);
    **两张同键表同时进入阶段 2** → 各自还原为各自的 merged 表
    (pair-ph 内容寻址唯一性,三轮 P2)。
15. identical 不变量与既有锁定测试同形(含配对表混排文档):word/line
    对「以换行结尾、不含 U+E000–U+E00F」的输入逐字节还原;block 段落
    规范化后等价。(line 的尾换行补齐、block 的空行折叠、入口 sanitize
    是既有全档语义,非本 RFC 引入——设计门三轮 P1 对齐措辞。)
16. 源码层锁:line / block 路径关键段零改动(防误伤)。

## 设计门记录

- 十二轮(2026-07-31,exec 直驱,`NEEDS_REVISION`,0 P0 / 3 P1):折入本
  v13——`trimCommonAffixes` 字素簇安全回退(IVS/ZWJ/组合标记,既有
  共享原语真 bug、全局受益);累计预算钉死可执行语义(原子化后 token、
  §5 执行前逐 cell 消费、Dice 不计入且论证有界、配对不受预算影响、
  消费顺序 = 输出顺序);plan.md 垫片描述与 design 双侧垫片同步。
- 十一轮(2026-07-31,exec 直驱,`NEEDS_REVISION`,0 P0 / 2 P1 / 1 P2):
  折入本 v12——cell 级 token 守卫(>500)+ 整对累计预算 10⁶(单 cell
  巨量 token 绕过行数/候选守卫、实测 5.4s 冻结);奇偶安全序列化(尾
  奇数反斜杠 cell 垫空格再闭合 pipe,防 `\|` 改写内容);降级段垫片
  升级为**双侧**(open 侧垫片恢复 `_` emphasis 与 autolink 左边界,
  每侧独立解析、整体着色,呈现契约随之增强而非降格)。
- 十轮(2026-07-31,exec 直驱,`NEEDS_REVISION`,0 P0 / 2 P1 / 1 P2;
  **零机制级新缺陷**,三条均为测试契约/措辞精度):折入本 v11——字面
  autolink 呈现契约改为「红旧+绿新纯文本、禁止拼接/单侧 href,link
  节点不保证」(open marker 相邻使两侧都不 linkify,与今日整表路径
  一致;垫片保留用于「文本后随 URL」形态防拼接);检测大小写不敏感;
  行数守卫「先于 LCS」以仓库惯例的源码序锁固定。
- 九轮(2026-07-31,exec 直驱,`NEEDS_REVISION`,0 P0 / 2 P1;其余全部
  类别零新 finding):折入本 v10——降级段 close marker 内垫空格阻断
  GFM autolink 词法吸收(否则裸 URL 拼接进同一 href、红标丢失);行数
  守卫(>500)前置到行 LCS 之前(候选上限拦不住 LCS 本身的同步开销),
  候选 50×50 降为第二道。
- 八轮(2026-07-31,exec 直驱,`NEEDS_REVISION`,0 P0 / 2 P1 / 1 P2;主链
  第五轮零新 finding):折入本 v9——字面 autolink 以**模式级降级**兜住
  (字符白名单管不了 `.`/`@`)并删除与结构保证矛盾的"继承现状"表述;
  相似度候选加 50×50 硬上限(超限 run 整行 DEL+INS,防同步主线程
  冻结);pair-ph 键加长度前缀保单射(表内容可含 NUL)。
- 七轮(2026-07-31,exec 直驱,`NEEDS_REVISION`,0 P0 / 2 P1;主链与全部
  机制参数连续多轮零新 finding,余项收敛于 cell 内保护边界):折入本
  v8——原子化顺序改为 code 最先(code 内反斜杠是字面量,转义对先行会吞
  合法 code span 的闭合反引号)、code opener 单独奇偶;「保护集外继承
  现状」修正为**结构性白名单**:残留语法字符(`` ` ``/`[`/`]`/`<`/`>`/
  `$`/`&`)或变更 token 含 `*`/`_`/`~` → 整 cell 旧红+新绿降级,词级
  细化仅限纯文本+受保护原子的 cell,marker 从结构上不可能落进 remark
  节点 value,枚举式打地鼠就此终结。
- 六轮(2026-07-31,exec 直驱,`NEEDS_REVISION`,0 P0 / 2 P1 / 1 P2;
  主链、阈值、tie-break、顺序、pad、末端还原全部再确认干净):折入本
  v7——转义对(`\X`)为 §2b 第 0 原子类(marker 不再劈开 `\|`,五轮的
  opener 奇偶规则整体简化掉)、非空↔空配对 cell 的空侧单空格色块、
  §5/T2 的原子顺序与定界符降级规则文本同步。
- 五轮(2026-07-31,exec 直驱,`NEEDS_REVISION`,0 P0 / 2 P1 / 2 P2;
  主链连续第三轮零新 finding):全部折入本 v6——定界符降级触发条件从
  「全部变更 token 为标点」扩为「任一变更 token 含 `*`/`_`/`~`」(混合
  变更不再碎裂 emphasis)、图片独立原子类(code→image→link→math)、
  哑段剥除限定「该端存在未转义 pipe」(无首 pipe 分隔行计数正确)、
  proposal/plan 的 identical 验收措辞与 design #15 对齐。
- 四轮(2026-07-31,exec 直驱,`NEEDS_REVISION`,0 P0 / 3 P1 / 1 P2;
  配对/占位符主链连续第二轮零新 finding):全部折入本 v5——规范骨架
  保留来源侧原始缩进(列表容器内表不脱容器)、三类原子 opener 统一
  反斜杠奇偶、定界符-only 变更整 cell 红绿降级(emphasis 不再被吞)、
  零 cell 裸 `|` 行合成色块 cell。
- 三轮(2026-07-31,exec 直驱,`NEEDS_REVISION`,0 P0 / 6 P1 / 1 P2;
  评审确认核心主链——tie-break / 输出顺序 / pad 时机 / context-ph 绕过
  后处理——已闭合):全部折入本 v4——identical 措辞对齐既有语义(#15)、
  阶段 1 判定钉死 set 语义、原子化时机前置到进场(§2b)且相似度基于
  原子化后 token、局部还原循环至不动点(嵌套原子解开)、math 纳入保护
  集 + 超出保护集语法显式继承现状、cell 计数/规范骨架/表头-分隔符等价
  守卫(§0 §2)、pair-ph 内容寻址唯一性(P2)。
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
