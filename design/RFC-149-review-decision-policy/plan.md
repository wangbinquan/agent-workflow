# RFC-149 · review 决策策略表 + 前端历史视图收敛（plan）

> 2 PR（backend / frontend 零耦合，调研证实可独立落）。授权语境：G3-G10 批量授权。

## RFC-149-T1 backend 策略表（PR-1）

- REVIEW_DECISION_POLICY + REVIEW_PROMPT_CTX_BUILDERS 两表 satisfies；
  submitReviewDecision/buildReviewPromptContext 分支查表化（骨架 if 保留）。
- resolveReviewRoundMode helper 收 decision 侧 4 判定；shared 端口常量补齐 +
  发布口/approval_meta 改引；SYSTEM_DECIDER/LOCAL_DECIDER + isSystemDecision
  替换 4 写 3 读。
- 测试：表值锁/轮模式格/决策分支棘轮/行为锁群零改动/形态锁随迁。
- **commit**：`refactor(review): RFC-149 PR-1 决策策略表——13 维散装分支查表化`

## RFC-149-T2 前端 mode variant（PR-2）

- resolveRoundView + pickViewedVersion + ReviewPaneMode 三原语（readonly.ts）；
  reviews.detail 12 三元+11 守卫收敛；MultiDocReviewView sentinel 链替换 +
  'decided' 态补齐；ReviewDocPane 单 mode prop；3 处内联枚举改 shared 导入。
- 测试：resolve-round-view 新单测、readonly-source 锁改写、multidoc decided 新格、
  DOM 锁群零改动。
- **commit**：`refactor(frontend): RFC-149 PR-2 review 视图 mode variant——布尔对与 sentinel 链收敛`

## 门禁节奏

每 PR：typecheck×3 + lint + format + 定向套件；PR-2 后前后端全量 + binary smoke
（shared 常量导出面变更）→ push → CI conclusion 直查 → Codex 实现门（与 RFC-148
兼容修复复审并批）循环至收敛。

## 验收清单

- [ ] 两表 satisfies + 决策分支棘轮；行为锁群零改动
- [ ] resolveReviewRoundMode 单源 + decidedBy 字面量清零 + 端口 oracle 常量
- [ ] 前端 mode 三态（多文档 decided 补齐）+ viewedVersion + resolver 同形对
- [ ] 门禁 + CI + Codex 双门
