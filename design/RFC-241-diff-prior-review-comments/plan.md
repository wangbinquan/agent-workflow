# RFC-241 — 任务分解

单 PR;commit 前缀 `feat(review): RFC-241 对比模式只读显示上一版检视意见`。

- **RFC-241-T1 组件与布局**:`PriorCommentsSidebar`(Props 含 body /
  versionIndex;comment-bubble 静态流覆盖;role=complementary)+
  `commentOrder.ts` 比较器抽取(ReviewDocPane 同步改用)+
  `.review-diff-layout` 两栏与 ≤720px 堆叠 + 渲染条件(diff on ∧ prior
  ∧ 非 historical)+ i18n(zh/en)。
- **RFC-241-T2 测试**:design §测试策略 6 项渲染级用例(含 historical 互斥与 within 作用域只读断言)。
- **RFC-241-T3 文档**:索引 / STATE 登记与收口。

## 验收清单

- [ ] proposal 验收标准全绿;既有 reviews.detail / ReviewDocPane 测试零
      回归。
- [ ] `bun run typecheck && lint && test && format:check` 全绿,push 后
      exact-SHA CI。
- [ ] Codex 设计门 + 实现门。
