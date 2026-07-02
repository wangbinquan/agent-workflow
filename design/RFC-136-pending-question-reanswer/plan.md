# RFC-136 — 任务分解

- 状态：Done（2026-07-02 用户批准〔D1–D6 + 实现期 D7 allowReseal 质询后确认〕，全 4 task 交付）
- 单 PR（commit 前缀 `feat(clarify): RFC-136 …`）；T1→T2→T3 有依赖，T4 随各任务同 commit。

| 任务 | 内容 | 依赖 |
| --- | --- | --- |
| RFC-136-T1 | 后端 seal 原语重 seal 支持：`sealRoundQuestions` 逐题三分类（fresh/reseal/rejected）+ 写入语义（answers 覆盖、sealed/staged 戳更新、answered 轮副作用抑制、scope 忽略、`resealedQuestionIds` 返回）；`rfc136-reanswer.test.ts` 后端 case 1–7 | — |
| RFC-136-T2 | AC-8 注入集成断言（重答→stage→dispatch prompt 含新答案）；归入 T1 测试文件 case 8 | T1 |
| RFC-136-T3 | 前端：`groupAnswerableQuestions` 更名+纳入 sealed pending+`resubmitQuestionIds`；RoundAnswerBlock seed 基线/resubmit 提示/scope 只读；提交聚合过滤 scope；入口按钮显隐放宽；i18n key（zh+en）；前端 vitest case 1–5 | T1（联调需后端放宽） |
| RFC-136-T4 | 收口：`design/plan.md` RFC 索引置 Done、`STATE.md` 已完成表加行、门禁三件套 + Codex 实现门评审 | T1–T3 |

验收清单（交付时逐项勾）：

- [x] proposal.md AC-1 … AC-8 全绿（后端 rfc136-reanswer 12 case + 前端 pane 6 case + 入口 1 case）
- [x] golden-lock：既有 seal/面板/看板测试全绿；三处按新契约的有意改写——rfc128-p1「同题不可
      重复 seal」→「staged 后不可重 seal」、pane「空池」fixture 换 past-pending、pane oracle
      更名 + resubmitQuestionIds（均注明推翻缘由）
- [x] `bun run typecheck && bun test && bun run format:check` + 前端 vitest 2933 + 单二进制 smoke 全绿
- [x] Codex 设计门（落档后、批准前，无阻断）+ 实现门（声明完成前）两轮评审发现全部处理
