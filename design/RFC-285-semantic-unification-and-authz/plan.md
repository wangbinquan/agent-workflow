# RFC-285 — 任务分解（plan）

> 前置：RFC-284 批 C 已落（共享 helper 地基）；开放项 Q1/Q2（proposal §5）
> 在实现前先问用户拍板。

## 批次

- T1 B4 前置排查：存量 REST query-token 用法清单（rg 报告落本文件附录）→ 拍板迁移面。
- T2 B1 404 统一（含 oracle 消除测试 + ~4 份测试改判 + 前端文案）。
- T3 B3 InheritedActor + call-owner-inactive（含 grep 锁）。
- T4 B4 token 双入口拆分 + 存量迁移。
- T5 B2 删除中档统一（E2 放宽 + E3 收紧各红→绿对；Q2 现网检查先行）。
- T6 B5 stale 码归一（按 Q1 兼容形态；前端同批）。
- T7 B6① review 作者校验 + ② ws/repo-imports gate。
- T8 B6③ 导入 visibility private（三路回归锁）。
- T9 B7 memory 模型（后端读/管理面 + B6④ distill 门 + 前端谓词三点 + AC-7 矩阵）。
- T10 实现门（独立子代理）+ findings 处置 + audit-backlog 销账
  （backlog:95 review 冒名、:81 ws 无 gate、:98 导入 visibility、:99 memory 谓词、
  :456-463 distill 反向洞、P3 选摘中 403/404 口径条）+ STATE/索引收尾。

## 依赖

- T2/T3/T4 互独立可并行小步；T5 依赖 Q2、T6 依赖 Q1；T9 是最大批单独走。
- 全程不碰 `routes/webhookTriggers.ts`/`webhookEndpoints.ts`（RFC-283 在途）。

## 验收清单

- [ ] AC-1…AC-8（见 proposal §6）逐项勾选
- [ ] E1-E10 之外零行为差异（对拍）
- [ ] backlog 六条销账 + 相关注释修正（taskQuestions.ts:41-44）
