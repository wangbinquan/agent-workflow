# RFC-241 — 任务分解

单 PR;commit 前缀 `feat(review): RFC-241 对比模式只读显示上一版检视意见`。

- **RFC-241-T1 组件与布局**:`PriorCommentsSidebar` + `.prior-comments`
  样式 + `reviews.detail.tsx` diff 分支两栏布局与条件渲染 + i18n(zh/en)。
- **RFC-241-T2 测试**:design §测试策略 5 项渲染级用例。
- **RFC-241-T3 文档**:索引 / STATE 登记与收口。

## 验收清单

- [ ] proposal 验收标准全绿;既有 reviews.detail / ReviewDocPane 测试零
      回归。
- [ ] `bun run typecheck && lint && test && format:check` 全绿,push 后
      exact-SHA CI。
- [ ] Codex 设计门 + 实现门。
