# RFC-185 — 任务分解

状态：Draft（待用户批准）
PR 策略：**单 PR**，commit 前缀 `feat(workgroup): RFC-185 …`。改动面小（一处协议文案 + 一个前端纯函数/徽标 + 测试群），无拆分必要。

## 任务

### RFC-185-T1 — leader 协议块 fan-out 指引 + 协议锁测试（backend）

- `packages/backend/src/services/workgroupContext.ts`：`renderWgProtocolBlock` leader 分支的 `wg_assignments` port 说明扩为 design.md §D1 文案。
- 新增 `packages/backend/tests/rfc185-leader-fanout.test.ts`（文件头注明锁定意图，链接本 RFC）：
  - leader 协议含 `FAN-OUT` 关键句；worker / fc_member 不含；
  - 文案上限数字与 `WG_MAX_ASSIGNMENTS_PER_TURN` 一致性断言。
- 依赖：无。

### RFC-185-T2 — 解析 / 唤醒 fan-out 行为锁（backend）

- 同文件追加：
  - `parseWgAssignmentsPort` 同成员 3 条保序放行、17 条拒绝；
  - `deriveWakeSet` fan-out 专项：3 dispatched 全唤醒 / 部分在途 leader 不醒 / 全终态 leader 醒 / awaiting_human 不阻塞 barrier（design §D3-3）。
- 纯锁定现状行为，不改生产代码。
- 依赖：无（与 T1 同文件，先后皆可）。

### RFC-185-T3 — 引擎 fan-out 集成测试（backend）

- fake-hooks 风格（参照 `rfc164-workgroup-engine.test.ts`）：同成员 3 单并发驱动 → shardKey 互异、dispatch 消息×3；全 done 后 leader 聚合轮 ledger 3 行；1 failed + 2 done 混合终态场景。
- 依赖：T1（leader 轮 fixture 里的协议渲染走新文案，但断言不依赖它——弱依赖，可并行）。

### RFC-185-T4 — 花名册在途计数徽标（frontend）

- `packages/frontend/src/lib/workgroup-room.ts`：新增 `countMemberActiveRuns`（design §D2）。
- `packages/frontend/src/components/workgroup/WorkgroupRoom.tsx`：花名册行 presence chip 后条件渲染 `.chip.chip--tight` 徽标（≥2 才显示），复用公共 chip 样式，零新 CSS。
- i18n：`workgroups.room.activeRunsBadge`（zh `×{{count}} 在途` / en `×{{count}} active`）双语齐。
- 测试：`workgroup-room-lib.test.ts` 表测 + `workgroup-room.test.tsx` 渲染断言（×3 显示 / 单路不显示）。
- 依赖：无。

### RFC-185-T5 — 收尾

- `design/plan.md` RFC 索引：RFC-185 状态 → Done。
- `STATE.md`：顶部进行中 RFC 行移除，已完成表加一行。
- 推送后按惯例查 CI（按本人 sha 精确查询）。

## 验收清单（对照 proposal §5）

- [ ] A1 同成员 N 单并发（T3）
- [ ] A2 barrier 聚合 + ledger 逐单（T2/T3）
- [ ] A3 失败独立（T3）
- [ ] A4 >16 拒绝（T2）
- [ ] A5 协议指引 + 源码锁（T1）
- [ ] A6 在途徽标（T4）
- [ ] A7 无迁移/无 wire 变更/全套绿（T5 前置门）

## 运行门槛

`bun run typecheck && bun run lint && bun run test && bun run format:check`，frontend 改动另跑 vitest；push 后查 GitHub Actions（按本人 commit sha）。
