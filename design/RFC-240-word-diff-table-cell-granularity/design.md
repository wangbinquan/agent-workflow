# RFC-240 — 技术设计

## 接口契约

零公开接口变化。`buildMergedMarkdown(left, right, 'word')` 签名与语义外壳
不变;改动全部收敛在 `packages/frontend/src/lib/review/markdownDiff.ts` 的
word 预处理路径内部。line / block 路径与 `remarkDiffMarkers` 不动。

## 数据流

现状(RFC-012 方案 A):

```
pretreatWordAtoms:  每侧独立 findTableBlocks → alloc('table', content)
                    内容寻址 → 同内容同占位符(unchanged)/异内容异占位符
                    (jsdiff 视为 del+ins → 整表红 + 整表绿)
```

本 RFC(C′):在两侧 `alloc('table', ...)` 之前插入**配对层**:

```
pairTables(leftTables, rightTables):
  键 = tableStructureKey(content)   // 表头行 + 分隔符行,逐字节
  按 (键, 同键序数) 配对:左侧第 k 张键 K 的表 ↔ 右侧第 k 张键 K 的表
  ├─ 配对成功且内容相同 → 走现路径(内容寻址 → context)
  ├─ 配对成功且内容不同 → mergedTable = intraTableDiff(L, R)
  │     两侧替换为**同一个**占位符 ph(键: 'tablepair\0' + L + '\0' + R)
  │     lookup[ph] = { content: mergedTable, pad: true }
  │     → jsdiff 视为同一 token → context change
  │     → restoreAtoms 在 context 中原样还原 mergedTable(自带 marker)
  └─ 未配对(对侧无同键表)→ 走现路径(整表 del/ins)
```

关键点:配对成功的表在 jsdiff 眼中**是 context**,merged 表文本(内含
PUA marker)不经过 `wrapLines`(context 值原样直拼),marker 直达渲染层。

## intraTableDiff 算法

输入:同结构键的左右两份表文本(行数组)。输出:单份含 marker 的表文本。

1. **表头 + 分隔符**:结构键相同 ⇒ 两行逐字节一致,原样输出。
2. **body 行对齐**:`diffArrays<string>` 精确 LCS。unchanged 行原样输出。
3. **变更 run 内相似度配对**(用户拍板"按相似度",非按位置):
   - 对 run 内每对 (removed, added) 行计算相似度:双方 cell 文本
     (`tokenizeForWordDiff` 后的 token 多重集)的 Dice 系数。
   - 贪心取当前最高分且 ≥ 0.3 的对子;平分时取行位置差最小者(确定性,
     无随机);配对行进入第 4 步。
   - 剩余未配对行:整行 DEL / INS,复用 `wrapTableRowCells` 逐 cell 包
     marker(与行档语义一致);输出顺序 = 先全部 DEL 行、后全部 INS 行,
     行间不插空行(同表内相邻行)。
4. **配对行的 cell 级 diff**:
   - 与 `wrapTableRowCells` 同款切分:未转义 `|`(`/(?<!\\)\|/`)。
   - cell 按位置 zip;cell 数不等时短侧补空 cell(GFM 对超列截断、缺列
     补空,positional zip 与渲染语义一致)。
   - 每对 cell:逐字节相等 → 原样;不等 → lead/tail 空白外置(与
     `wrapTableRowCells` 同规则),inner 做词级 diff:
     `tokenizeForWordDiff` + `diffArrays` + `trimCommonAffixes`,
     del 段包 DEL marker、ins 段包 INS marker、context 原样,拼回单串。
   - **cell 内 inline code 局部原子化**:cell inner 先用局部
     `PlaceholderAllocator`(seed = 左右两份表全文,避让文档自带 PUA)对
     `INLINE_CODE_RE` 命中的 span 原子化,词级 diff 后**在函数内立即还原**。
     硬约束:全局 lookup 里的 mergedTable **不得含任何占位符字符**——
     `restoreAtoms` 是单趟 `String.replace`,替换文本不会被再扫描,嵌套
     占位符会以 PUA 裸字符漏到输出(RFC-012 勘误三轮 P1 的同型教训)。
     实现时对 mergedTable 做 `HAS_PLACEHOLDER_RE` 断言(违反即回退整表
     del/ins 路径,fail-safe)。
   - marker 永不跨越 `|`:所有 marker 都在单 cell 的 inner 内生成,复用
     RFC-012 "marker 不跨 cell 边界"不变量。

## 与现有模块的耦合点

| 模块                                    | 关系                                                         |
| --------------------------------------- | ------------------------------------------------------------ |
| `findTableBlocks` / `tableStructureKey` | 复用,零改动(顶层表边界不变)                                  |
| `PlaceholderAllocator`                  | 复用两处:全局(配对占位符)+ intraTableDiff 局部(cell 内 code) |
| `restoreAtoms`                          | 零改动;依赖其"context 原样还原"语义                          |
| `wrapLines` / `wrapTableRowCells`       | 未配对行包 marker 复用;merged 表不经过 wrapLines             |
| `repairBrokenLinePrefixes`              | 表行跳过(既有),merged 表安全通过                             |
| `repairMergedTableRuns`                 | merged 表 run 形态 = 单 sep 于第 2 行 → 判定 clean,不触碰    |
| line / block 路径                       | 零改动                                                       |

## 失败模式

- **同键多表序数错位**(左 2 张键 K、右 1 张):按序数配对,多出的表走
  现路径整删/整增——与 RFC-012 "位置错位噪音可接受"同款取舍。
- **占位符区间耗尽 / merged 表含残留占位符**:回退现路径(整表 del/ins),
  渲染不崩;断言路径有测试锁定。
- **表内行数悬殊**(如 1 行 vs 200 行):LCS + 相似度配对复杂度
  O(m·n·cell tokens),m/n 为**变更 run 内**行数;评审文档量级(<10³ 行)
  下可忽略,与 jsdiff 主调用同阶。
- **cell 内含未闭合反引号 / 转义竖线**:`INLINE_CODE_RE` 与
  `/(?<!\\)\|/` 与既有实现同一正则,行为一致;marker 落进裸反引号文本时
  由 `remarkDiffMarkers` 的 value 剥离兜底(既有最后防线)。
- **identical 输入**:内容相同 ⇒ 不进 intraTableDiff ⇒ 逐字节还原不变量
  与现状同一路径,零风险。

## 测试策略(必写 case)

渲染级断言为主(`docs/dev-gotchas.md` §前端:字符串断言盲区教训),文件
`markdown-diff-table-cell.test.tsx` + `markdown-diff-table-word.test.ts`
扩展:

1. 单 cell 修改 → 恰 1 张表;变更 cell 同含 `.diff-del`+`.diff-ins`;
   其余 cell 零 span;无裸 `|`。
2. 多 cell / 多行修改 → 各自 cell 内高亮,互不串扰。
3. 行新增 / 删除 → 单表内整行绿 / 红(逐 cell)。
4. 相似度配对:改 1 个 cell 的行与其原行配对;同 run 中完全无关的增删行
   不硬配(整行呈现)。
5. CJK cell、inline code cell(`` `id` `` → `` `uid` ``:code span 结构
   完整,marker 在 span 内/外语义正确)。
6. cell 数不齐的行(缺列/超列)不崩、补空 cell 语义。
7. 结构键不同(表头改名/列数/对齐)→ 现行为,与既有 44 条回归共同锁定。
8. 同键双表(序数配对)。
9. identical 输入逐字节还原(全档);含配对表 + 正文混排文档。
10. 兜底断言:merged 表无占位符残留;`|  |  |` 指纹不出现。
11. 源码层锁:line / block 路径文件段零 diff(防误伤)。
