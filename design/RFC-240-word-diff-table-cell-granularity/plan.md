# RFC-240 — 任务分解

单 PR 交付;commit 前缀 `feat(review): RFC-240 词档表格 cell 级细化`。

## 子任务

- **RFC-240-T1 配对层与占位符管道**
  `pretreatWordAtoms` 内新增 `pairTables`:结构键 + 同键序数配对;
  paired-and-different 双侧共享单占位符,lookup 挂 mergedTable(pad=true);
  其余路径逐字节保持现状。依赖:无。

- **RFC-240-T2 intraTableDiff**
  行级 LCS(`diffArrays`)→ 变更 run 相似度配对(Dice ≥0.3,贪心,平分取
  位置差最小)→ 配对行 cell zip + cell 内词级 diff(局部 allocator 原子化
  inline code、函数内还原、无嵌套占位符断言 + fail-safe 回退)→ 未配对行
  `wrapTableRowCells` 整行 DEL/INS。依赖:T1。

- **RFC-240-T3 测试**
  新增 `markdown-diff-table-cell.test.tsx`(渲染级,design §测试策略 1-10)
  - `markdown-diff-table-word.test.ts` 补 merged 字符串层锁 + 11 的源码层
    防误伤锁。依赖:T2。

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

- [ ] design §测试策略 11 项全部落地且绿。
- [ ] 既有 diff 相关测试:除上节列明的**同键 word 档**断言按新语义有意
      更新外,其余(结构变化 / 行块档 / 正文 / identical / 兜底)零改动
      零回归。
- [ ] identical 逐字节还原不变量全档保持。
- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check`
      全绿;push 后按 exact-SHA 查 CI。
- [ ] Codex 实现门跑净(0 open P0/P1;P2 修复或书面取舍)。
