# RFC-077 — 任务分解

> 配套：`proposal.md` / `design.md`。
>
> 本 RFC 是**评估型**：`T0` 是决策门，未通过则不进入实现。推荐落地范围 = Option B（见 `design.md §6`）。

## 决策门

### RFC-077-T0 — 方向裁决（依赖：无）

用户在三选一中拍板：
- **A 不做**：仅补 `distillSessionCapture.ts` 头注释结论 → 本 RFC 收为 `Done(评估:不实施)`。后续 T1+ 取消。
- **B 抽遍历核心（推荐）**：执行 T1–T5。
- **C B + sink 接口**：执行 T1–T5 后另起 follow-up PR 评估 T6。

> 在 T0 未裁决前**不写任何实现代码**（遵循仓库 RFC 流程第 3 条）。

---

## 实现任务（仅当 T0=B 或 C）

### RFC-077-T1 — 新建遍历核心 + 单测（依赖：T0）

- 新建 `packages/backend/src/services/opencodeSessionWalk.ts`：导出 `OpencodeSessionRow/MessageRow/PartRow`、`WalkedSession`、`walkOpencodeSessions(db, root, {includeRoot})`。
- 新建 `packages/backend/tests/opencode-session-walk.test.ts`，覆盖 `design.md §7.2` 五条 + 顶部回归注释。
- **此步不改任何调用方**——核心先独立存在并测绿。

### RFC-077-T2 — 接入 ① `sessionCapture.ts`（依赖：T1）

- `captureChildSessions` 的 BFS+逐 session SELECT 改调 `walkOpencodeSessions(opencodeDb, rootSessionId, {includeRoot:false})`；删本地 `OpencodeSessionRow/MessageRow/PartRow`。
- 保留：open/close、sibling skip、`alreadyInsertedPartIds` 过滤、row 形状、返回结构、marker。
- 跑 `session-capture-sqlite` / `routes-session` / `sessions` / `runner-session-id-persist` 全绿（断言不变）。

### RFC-077-T3 — 接入 ② `distillSessionCapture.ts`（依赖：T1）

- `captureDistillJobSession` 改调 `walkOpencodeSessions(opencodeDb, rootSessionId, {includeRoot:true})`；删本地行接口。
- 保留：root 纳入、`attemptIndex` 行形状、`DISTILL_CAPTURE_FAILED_KIND`、open/close、永不抛。
- 跑 `distill-session-capture` / `memory-distiller-capture-rfc043` 全绿（断言不变）。

### RFC-077-T4 — 接入 ③ `subagentLiveCapture.ts`（依赖：T1）

- 仅替换 tick 内那段 BFS+SELECT 为 `walkOpencodeSessions(opencodeDb, root, {includeRoot:false})`；删本地行接口。
- **编排零改动**：跨 tick 句柄复用、重入保护、auto-disable、`onInsert`、`stats()`、partId memo（含 transcode 丢空标记已见）、sibling skip 全部原样。
- 跑 `subagent-live-capture` / `subagent-live-capture-source` / `runner-subagent-live-capture` / `scheduler-subagent-live-capture-passthrough` 全绿（断言不变）。

### RFC-077-T5 —（可选）`writeCaptureFailedMarker` 收敛 + 收尾（依赖：T2,T3）

- 若采纳 `design.md §3.3`：把 ①② 的 `markCaptureFailed` 收敛为按 insert 回调参数化的 `writeCaptureFailedMarker`；否则跳过此步、各自保留。
- 全量门禁：`bun run typecheck && bun run test && bun run format:check` + CI（build smoke + Playwright e2e）。
- 更新 `STATE.md`（进行中→已完成）、`design/plan.md` RFC 索引 Draft→Done。

### RFC-077-T6 —（仅 T0=C）落库 sink follow-up（依赖：T2–T5，另起 PR + 另评估）

- 引入 `CaptureSink` + `captureOnce`，把 ①② 的 insert 循环也统一。单独 PR，单独跑等价预言机。
- 若 review 认为重新引入了 RFC-043 担心的耦合 → 否决并保留 B 形态。

---

## PR 拆分建议

- **默认单 PR**：T1–T5 是一次行为保持的重构，彼此强耦合（核心 + 三接入 + 收尾），合在一个 PR 里最易整体证等价、避免中间态半接入。commit 前缀：`refactor(backend): RFC-077 统一 opencode session 捕获遍历核心`。
- **T6** 若执行，**必须**独立 PR（前缀 `refactor(backend): RFC-077 T6 capture sink`），与 B 解耦，便于单独否决。

## 验收清单

- [ ] T0 已裁决并记录于 `STATE.md`。
- [ ] `walkOpencodeSessions` 单测覆盖 root-inclusion / BFS 顺序 / self-loop / 排序 / root 缺失五分支。
- [ ] 三站点本地行接口已删，统一 import 自 `opencodeSessionWalk.ts`。
- [ ] §2 差异矩阵每一行在改动后仍成立（root 纳入、表/行形状、marker kind、两种 dedup、句柄生命周期、编排）。
- [ ] `design.md §8` 耦合点清单逐条勾掉。
- [ ] 全部等价性预言机测试绿且**断言无改动**；新增遍历核心测试绿。
- [ ] `typecheck + test + format:check` 三绿；push 后按 [feedback_post_commit_ci_check] 查 CI。
- [ ] `STATE.md` + `design/plan.md` RFC 索引同步。
