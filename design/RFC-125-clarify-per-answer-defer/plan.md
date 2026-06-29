# RFC-125 — 任务分解（v3 Pivot：默认延迟，移除开关）

单 PR。commit 前缀：`feat(rfc): RFC-125 任务问题延迟下发改为默认开启（移除 launch 开关）`。
**规模**：小（复用既有延迟模型，**零调度器/投递/migration**）——v1/v2 的大改方案经 gate 否决后 pivot。

## 子任务

| ID | 任务 | 文件 |
|----|------|------|
| RFC-125-T1 | 创建服务：新任务 `deferredQuestionDispatch` 未显式给值时**默认 true**（`?? true`）；DB 列默认不动 | `services/task.ts` |
| RFC-125-T2 | 移除 launch「是否延迟下发」开关（state/payload/`<Switch>`）；`StartTaskSchema` 字段保留 optional（仅前端不发） | `routes/workflows.launch.tsx`（+ `shared/schemas/task.ts` 不删字段） |
| RFC-125-T3 | i18n：删 `launch.deferredDispatch.label/hint`（zh/en 对称） | `i18n/zh-CN.ts`, `i18n/en-US.ts` |
| RFC-125-T4 | 测试：创建默认 true 单测 + launch 无开关 source-lock + `launch-deferred-dispatch` 收口；确认 `rfc120-deferred-dispatch`/`rfc120-manual-questions`/`question-author-form` 既有锁不改判定即绿 | `packages/backend/tests/*`, `packages/frontend/tests/*` |
| RFC-125-T5 | 索引/状态：`design/plan.md` RFC-125 行改 pivot + 标 Done；`STATE.md` 收尾（标明"设计者答案默认延迟"的行为变更） | `design/plan.md`, `STATE.md` |

## 验收清单

- [ ] 新任务默认延迟；launch 页无开关；看板 `新增问题`/`批量下发` 在新任务可见。
- [ ] 调度器/队列投递/批量下发/不变量/stuck **代码逐字未改**；老任务行为不变。
- [ ] 既有 deferred-dispatch / manual-questions / author-form 测试不改判定即绿；新增创建默认 + launch source-lock。
- [ ] `typecheck + 前端 vitest + 后端 bun test + format` 全绿；Codex 设计 gate（pivot）+ impl gate fold；CI 全绿。
- [ ] release note / STATE 标明行为变更：设计者域反问答案默认进看板、需手动批量下发（老任务不受影响）。

## 非目标 / 后续

- per-answer 逐条选 / 同一任务混合立即+延迟（经 2 轮 gate 证实调度器高发区大改，**放弃**；如将来确需，另立 RFC 并按 v2 design 的 provenance/逐条目标记/级联/migration 全套硬化）。
- self-clarify 延迟、stop+defer 组合（范围外）。
- 翻转/迁移已存在的老任务（不做）。
