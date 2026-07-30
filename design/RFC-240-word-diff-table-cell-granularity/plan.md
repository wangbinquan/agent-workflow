# RFC-240 — 任务分解

单 PR 交付;commit 前缀 `feat(review): RFC-240 词档表格 cell 级细化`。

## 子任务

- **RFC-240-T1 配对层与三视图还原管道**(v3)
  `pretreatWordAtoms` 内新增配对层:阶段 1 纯内容寻址(内容在对侧存在
  的表走现路径,零显式配对);阶段 2 两侧内容无对应的剩余表按
  (结构键, 剩余序数) 配对,双侧共享单占位符,`pairLookup[ph] =
  { merged, left, right }`。`restoreAtoms` 扩展:removed→left、
  added→right(早期还原、pad=true,优雅降级现行为),context 跳过;
  `buildMergedMarkdown` 在 `repairBrokenLinePrefixes` 之后新增
  `restorePairedTables` 单趟替换 context-ph → merged。依赖:无。

- **RFC-240-T2 intraTableDiff + 共享原语**(v4)
  §0 cell 计数/规范骨架(含来源侧缩进、无首/尾 pipe 端不剥哑段、零
  cell 行合成色块)→ §2 GFM 等价守卫(表头≠分隔符 cell 数、超列 →
  整对回退)→ §2b 进场逐 cell 原子化(**code→转义对→image→link→math**,code opener 奇偶,
  允许嵌套)→ 行级精确 LCS → 单 run 内相似度配对(Dice **≥0.5**,基于
  原子化后内容 token = trim 后丢空白与纯标点/符号;候选序
  `(score↓, |i-j|↑, i, j)` 贪心;输出 = 先未配对 DEL(旧序)后新序)→
  配对行 cell zip(max-cell 规范骨架,短侧空格占位)+ cell 内词级 diff
  (**结构性白名单:残留含 `` ` ``/`[`/`]`/`<`/`>`/`$`/`&` 或变更
  token 含 `*`/`_`/`~` → 整 cell 旧红+新绿降级;非空↔空 cell 空侧单
  空格色块**)→ **循环还原至不动点**(嵌套原子解开;残留 =
  真 bug → fail-safe 整对回退,`_internal` 注入桩可测)→ 未配对行整行
  DEL/INS(空 cell 色块占位)。
  pair-ph 按「左内容+右内容」内容寻址保证唯一。共享原语:
  `splitTableCells`(反斜杠奇偶)替换两处 cell 切分;`INLINE_CODE_RE`
  多反引号升级(全局生效,proposal 已列显式例外)。依赖:T1。

- **RFC-240-T3 测试**
  新增 `markdown-diff-table-cell.test.tsx`(渲染级,design §测试策略
  1-15)+ `markdown-diff-table-word.test.ts` 修订(同键 word 断言按新
  语义更新)+ 第 16 项 line/block 源码层防误伤锁。依赖:T2。

- **RFC-240-T4 文档同步**
  RFC-012 design.md 勘误区追加"C′ 落地"交叉引用(方案 A 的整表退化取舍
  自此仅适用于结构变化);`design/plan.md` 索引状态更新;STATE.md 记录。
  依赖:T3。

## 既有断言的有意更新(设计门一轮 P1:与新行为不可同时满足)

行为变更即本 RFC 的目的,以下既有断言**按新语义更新**(其余全部保持):

- `markdown-diff-table-render.test.tsx`「word:旧表整表 DEL + 新表整表
  INS」等**同结构键** word 档 case → 改为单表 + cell 级断言;
- `markdown-diff-table-word.test.ts` 中"异内容表产生两个占位符 / 整表
  DEL+INS"的**同键**merged 字符串断言 → 改为配对占位符 + merged 表断言;
- 结构键不同、line/block 档、identical、兜底重建等其余断言零改动。

## 验收清单

- [ ] design §测试策略 16 项全部落地且绿。
- [ ] 既有 diff 相关测试:除上节列明的**同键 word 档**断言按新语义有意
      更新外,其余(结构变化 / 行块档 / 正文 / identical / 兜底)零改动
      零回归。
- [ ] identical 不变量按 design §测试策略 #15 的既有同形语义保持
      (word/line 逐字节于换行结尾输入;block 规范化等价)。
- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check`
      全绿;push 后按 exact-SHA 查 CI。
- [ ] Codex 实现门跑净(0 open P0/P1;P2 修复或书面取舍)。
