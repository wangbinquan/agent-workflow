# RFC-140 任务分解

单 PR（直接 push main），commit 前缀 `feat(clarify): RFC-140 批量下发一次点击全下发`。
如按 workstream 拆 commit：W1 塌缩、W2 自动补发（含 migration）、W3 前端可各自成 commit,
同 PR 交付。

## 子任务

### RFC-140-T1 对称塌缩（W1）

- `reassignTaskQuestion` 新分支（紧邻 RFC-138 分支）：cross questioner 行 + 目标 ==
  `round.targetConsumerNodeId` ⇒ `collapseQuestionerEntryToDesigner`。
- 塌缩 tx：CAS(dispatched_at NULL) → 两表 scope 翻转 lockstep → 删 questioner 行 →
  designer 行 insert-if-missing + seal 归一化 + staged_at 继承 → echo 行物化（幂等键）。
- `ReassignTaskQuestionAction` 增 `'collapsed-to-designer'`；路由响应透传。
- 测试：design §5.1-5.5（含 golden-lock + 409 + QMGP5 形态 9 条全发）。
- 依赖：无。

### RFC-140-T2 deferred 登记 + tick 自动补发（W2）

- migration：`task_questions` ADD COLUMN `auto_dispatch_deferred_at INTEGER`；**bump
  `upgrade-rolling.test.ts` journal 计数断言**（标题 + 断言 + 注释）。
- `dispatchTaskQuestions`：stamp tx 内对 deferredEntries 盖列。
- scheduler runTask tick 顶（deriveFrontier 前）：读登记集 → 非空则
  `dispatchTaskQuestions(db, taskId, deferredIds, SYSTEM_ACTOR)`，ConflictError → debug log
  + continue（幂等重试）。抽出可测入口（如 `autoDispatchDeferredQuestions(db, taskId)`），
  tick 内调用。
- 测试：design §5.6-5.10 + §5.13（migration journal）。
- 依赖：无（与 T1 并行；验收 1 的端到端 case 需要 T1）。

### RFC-140-T3 前端知会（W3）

- 看板条目：`auto_dispatch_deferred_at && !dispatched_at` → 等待徽标（文案含目标节点，
  复用既有 StatusChip / muted 行模式，禁自写 chrome）。
- 塌缩知会：`collapsed-to-designer` → notice（镜像 RFC-138 `tq-collapse-notice` +
  ClarifyQuestionHandler muted 行）。
- i18n zh/en；前端 vitest（design §5.11-5.12）。
- 依赖：T1（action 值）、T2（列）。

### RFC-140-T4 收口

- `design/plan.md` 索引 Draft → Done；`STATE.md` 摘要。
- 门禁：typecheck ×3 / `bun run test` / 前端 vitest / format / `bun run build:binary` smoke；
  push 后查 CI。
- Codex 实现门评审，findings 修完。
- 本机验收：QMGP5 现场——retry 14 done 后（a）designer 5 条按新机制自动补发（部署时机若已
  手动补发则构造等价场景）；（b）后续轮次重演改派 → 塌缩 → 一次全发。
- 依赖：T1-T3。

## 验收清单

- [ ] q1 形态改派 → `collapsed-to-designer`，批量下发 `deferredEntryCount=0` 一次全发
- [ ] 塌缩 golden-lock（第三节点 override 不变）+ 409 边界 + designer 行补建 + echo 物化
- [ ] 真异类混批：deferred 盖列 → 续跑 done 后 tick 自动补发（`__system__`），嵌套 defer 收敛
- [ ] stage 未点发不被自动下发
- [ ] daemon 重启后补发不丢；409 自愈
- [ ] 看板 deferred 徽标 + 塌缩知会 + i18n
- [ ] migration journal 计数 bump；三门禁 + binary smoke + CI 绿
