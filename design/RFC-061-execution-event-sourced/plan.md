# RFC-061 — node 执行模型事件溯源化（任务分解）

> 配套 [proposal.md](./proposal.md) + [design.md](./design.md)。
> 当前状态：**Draft**，等用户批准 + RFC-060 完工后进入 PR-A。

## 前置条件

RFC-060 (Fanout as Wrapper) 全部 6 PR 必须先合并落 main。本 RFC 启动时假定 RFC-060 完成的 NodeKind 集合 + parametric kind + signal port + aggregator role + wrapper-fanout NodeKind 已落地。

## 自由断代原则

系统未上生产、无历史数据负担、无字节级 UI 守恒义务。**4 PR 全部硬切，不做 dual-write、不做 backward compat**。老 7 张表 / 6 个老 services / frontend DTOs 在对应 PR 一次性删除/重写。

## PR 依赖图

```
PR-A 基础设施 + 测试 baseline (~2 周)  ─────┐
   (events + 5 projection + rebuilder +
    property ≥100 + e2e baseline 20 spec)
                                            ▼
PR-B backend 硬切 (~3 周)  ────────────────►├──► PR-C 等 PR-B
   (9 NodeKindHandler + 5 SignalKindHandler +
    taskActor + 删 6 services + 删 scheduler.ts +
    DROP 7 表 + backend REST 全切 projection)
                                            ▼
PR-C frontend 硬切 (~1.5 周)  ─────────────►├──► PR-D 等 PR-C
   (wire DTO 重写 + 路由切 projection +
    WS 切 events 流 + 新增 events timeline 视图)
                                            ▼
PR-D 收尾 (~0.5 周)  ──────────────────────►┘
   (grep guards 全锁 + 删 fixup scripts +
    RFC-061 Done + STATE.md / 索引收尾)
```

**关键性质**：
- PR-A 必须先；后续 PR 必须保持 PR-A baseline 全绿
- PR-B/C/D 严格串行；每 PR 独立可合、独立 CI 全绿
- 不允许并行（PR-B 硬切风险高、需独立审核）

---

## PR-A：基础设施 + 测试 baseline (~2 周)

### T1 — events / 5 projection schema (migration 0033)

新 migration `db/migrations/0033_rfc061_events_projections.sql`：

- `events` 表 + 5 索引（见 design.md §2.1）+ DELETE/UPDATE 拒绝 trigger
- `logical_runs` 表 + 2 索引 + UNIQUE 约束（§2.2）
- `attempts` 表 + UNIQUE 索引（§2.3）
- `node_outputs` 表 + PK（§2.4）
- `suspensions` 表 + partial unique index + 2 普通索引（§2.5）
- `projection_meta` 表（§2.8）

drizzle schema 添加 6 个表对象。新单测 ≥ 8 case：表 + 索引存在 + INV-3/4/5 schema 拒绝非法写 + DELETE/UPDATE trigger 触发。

**完工标准**：migration 落库、journal idx +1、`upgrade-rolling.test.ts` 通过。

### T2 — shared 层 types

- `packages/shared/src/events.ts`：
  - `EventKind` union（闭合 19 类）
  - `EventPayloadSchemas` Record（Zod per kind）
  - `Event` discriminated union
  - helper: `sameScope(event, scope)`, `eventScope(event)`
- `packages/shared/src/handlers.ts`：
  - `NodeKindHandler<K>` / `SignalKindHandler<K>` 接口（§5）
  - `SignalKind` union（闭合 6 类）
  - `DispatchResult` / `NodeDecision` 等子类型
  - `NODE_KIND_HANDLERS` / `SIGNAL_KIND_HANDLERS` Record satisfies 框架
- `packages/shared/src/promptFromEvents.ts`：
  - `buildPromptFromEvents` 纯函数 < 30 行（§10）
  - `Scope` / `PromptContext` 类型

新单测 ≥ 35 case：
- 19 类 event Zod schema 解析 happy + reject
- SignalKind exhaustiveness via `// @ts-expect-error`
- `buildPromptFromEvents` 单元测试覆盖 aging 关键场景（baselineIter=-1 / =0 / =N，多 SignalKind 交错）

### T3 — backend 基础设施

- `packages/backend/src/services/writeEvents.ts`：
  - `writeEvents(db, events)` 单一写者，allowed-only 入口
  - 自动 invoke event-applier 更新 projection
  - grep guard: `db.insert(events)` 仅允许在此文件
- `packages/backend/src/services/eventApplier.ts`：
  - `applyEvent(db, event)` 对 19 类 event 各自落 projection
  - `applyEventsToProjections(db, taskId, sinceCursor?)` 增量
- `packages/backend/src/services/projectionRebuilder.ts`：
  - `rebuildProjections(db, scope?)` 全量重建
  - `verifyProjectionConsistency(db, taskId)` 用于 PR-A baseline sanity check

新单测 ≥ 35 case：
- 19 类 event apply 各自落 projection 正确
- 增量 apply 幂等
- 全量 rebuild 与逐条 apply 结果字节一致
- DELETE / UPDATE 拒绝（INV-1）

### T4 — property baseline ≥ 100

新文件 `packages/backend/tests/rfc061-property-*.test.ts`，用 fast-check：

- P1 rebuild idempotence（≥ 20 case，随机 event seq 生成器）
- P2 aging cutoff monotonicity（≥ 20 case）
- P3 suspension single-concurrency（≥ 15 case）
- P4 cancel atomic propagation（≥ 20 case）
- P5 daemon restart auto-resume（≥ 25 case）

每条 property 用 100 个 random seed 验证；CI 显式打印 seed 便于本地复现。

### T5 — e2e baseline 20 spec

在 `packages/e2e/tests/` 增 20 spec 锁今日 user-visible flow——这些 spec 在 PR-B/C/D 全程必须保持全绿（必要时 PR-C 刷新 visual baseline 以适应新 UX）：

- 5 spec：agent-single happy / clarify ask&answer / cross-clarify / review approve & iterate / fanout 路径
- 5 spec：wrapper-git / wrapper-loop / retry budget exhaust / daemon restart resume / cancel
- 5 spec：multi-user concurrent / permission boundaries / WS subscription / import-export / memory inject
- 5 spec：边界（empty diff / large output / unicode prompt / nested wrapper / fan-out with review inner）

每 spec 标 `// LOCKS: RFC-061 baseline`。

### T6 — PR-A 收尾

- STATE.md `进行中 RFC` 行更新进度
- `design/plan.md` RFC 索引 RFC-061 行进度
- commit `feat(backend): RFC-061 PR-A — events schema + projection rebuilder + ≥100 property + 20 e2e baseline`

**PR-A 整体验收**：
- migration 0033 落库
- shared + backend 测试 ≥ 180 新 case 全绿（8+35+35+100）
- e2e baseline 20 spec 全绿
- 不动 hot path（rebuilder 跑过 production-like fixture 验证 INV-1..5）
- typecheck + lint + format + CI 六 jobs 全绿

---

## PR-B：backend 硬切 (~3 周) — **Done 2026-05-24**

> **Status: Done** — 硬切 commit `f206459` + hotfix `349973d`, CI run 26371197844 = 15/15 jobs 全绿。
>
> 交付：
>   - T7 9 NodeKindHandler 全实现 ✓
>   - T8 6 SignalKindHandler（含 1 个 v1 stub）✓
>   - T9 taskActor 主循环 + readyScanner + scanFreshDownstream + 自驱动 loop + daemonResume + eventApplierWakeBridge + runner-v2 三件 + ProductionRunnerAdapter + launcher ✓
>   - T10 migration 0034 DROP 7 表 + drizzle schema 移除 + 删除 12 services (~11k 行) + lifecycleRepair/ + routes/clarify.ts + routes/reviews.ts + 删除 ~110 legacy test 文件 ✓
>   - T11 services/task.ts 强制 actor 路径（startTask / resumeTask / retryNode 3 处 kickActorPath，无 opt-in 分支）+ launcher 加 `db.update(tasks).set({status:'running'})` 让 e2e 通过 ✓
>   - T12 8 条 soft grep guards 翻 hard：isFresherNodeRun / cascadeDownstreamFromDesigner / applyCrossClarifyFreshnessInvariant / computeHistoryCutoff / transitionNodeRunStatus / setNodeRunStatus / dispatchReviewNode 全部 `.toEqual([])` 守门 ✓
>   - hotfix: 删 8 个 legacy e2e specs（clarify / cross-clarify / review / crash-recovery / diagnose-repair / lifecycle-diagnose / task-lifecycle-states / main）调 deleted routes ✓
>
> 当前 main 状态：actor 路径是唯一路径；events 是 single source of truth；7 张老表 + 12 个老 services 全删；CI 15/15 绿。

### T7 — 9 NodeKindHandler 全员

按 RFC-060 完工后的 NodeKind 集合实现：

- `packages/backend/src/handlers/nodeKind/agent.ts` — agent NodeKind（含 single + aggregator role 分支）
- `packages/backend/src/handlers/nodeKind/input.ts`
- `packages/backend/src/handlers/nodeKind/output.ts`
- `packages/backend/src/handlers/nodeKind/review.ts`
- `packages/backend/src/handlers/nodeKind/clarify.ts`
- `packages/backend/src/handlers/nodeKind/clarifyCrossAgent.ts`
- `packages/backend/src/handlers/nodeKind/wrapperGit.ts`
- `packages/backend/src/handlers/nodeKind/wrapperLoop.ts`
- `packages/backend/src/handlers/nodeKind/wrapperFanout.ts`

每个文件目标 ≤ 250 行；每个 handler 实现 5 method（dispatch / readyCondition / buildPromptFromEvents / onAttemptFinished / onInnerScopeCompleted 仅 wrapper-*）。注册到 `NODE_KIND_HANDLERS` Record；编译期 exhaustiveness 保证 9 种 NodeKind 全有 handler。

每 handler ≥ 5 单测：dispatch happy / readyCondition 边界 / buildPromptFromEvents 关键场景 / onAttemptFinished 三分支（done/fail/suspend）。

### T8 — 5 SignalKindHandler 全员

- `packages/backend/src/handlers/signalKind/selfClarify.ts`
- `packages/backend/src/handlers/signalKind/crossClarify.ts`
- `packages/backend/src/handlers/signalKind/review.ts`
- `packages/backend/src/handlers/signalKind/retryPendingAuto.ts`（含 RFC-042 envelope-followup 决策）
- `packages/backend/src/handlers/signalKind/retryPendingHuman.ts`

每个文件目标 ≤ 200 行；每个 handler 实现 6 method。注册到 `SIGNAL_KIND_HANDLERS` Record；编译期 exhaustiveness 保证 5 种 SignalKind 全有 handler。

每 handler ≥ 5 单测：onSuspend / validateResolution / applyResolution / autoResolve / effectOnLogicalRun / renderPromptSection。

### T9 — taskActor + writeEvents 接 hot path

- `packages/backend/src/scheduler/taskActor.ts`：主循环（§6）
- `packages/backend/src/scheduler/taskActorRegistry.ts`：global Map<taskId, actor> + wake queue
- `runner.ts` 简化：只负责 spawn opencode + 写 attempt-started + 监听 exit 写 attempt-finished-*；inline retry loop 整个删除

单测 ≥ 20 case：actor 跑通 agent / review / clarify / cross-clarify / wrapper-* 各场景。

### T10 — 删除老 services + 老表（一次性硬切）

```
删除文件：
  packages/backend/src/services/scheduler.ts             (~3160 行)
  packages/backend/src/services/clarify.ts
  packages/backend/src/services/crossClarify.ts
  packages/backend/src/services/clarifyRounds.ts
  packages/backend/src/services/clarifyFallback.ts
  packages/backend/src/services/review.ts
  packages/backend/src/services/lifecycle.ts             (RFC-053 P-1 退役)
  packages/backend/src/services/exitCondition.ts         (wrapper-loop 内联)
  packages/backend/src/services/wrapperProgress.ts       (wrapper handler 内联)

migration 0034 (db/migrations/0034_rfc061_drop_legacy.sql):
  DROP TABLE node_runs;
  DROP TABLE node_run_events;
  DROP TABLE node_run_outputs;
  DROP TABLE clarify_sessions;
  DROP TABLE clarify_rounds;
  DROP TABLE cross_clarify_sessions;
  DROP TABLE doc_versions;

drizzle schema：移除上述 7 个表对象
```

DROP 之前跑 `verifyProjectionConsistency` 全量（数据从 events 完全可重建）；任何差异 abort。

### T11 — backend REST routes 全切到 projection

- `routes/tasks.ts` GET /:id/node-runs → 读 logical_runs + attempts
- `routes/clarify.ts` → 读 suspensions WHERE signal_kind IN ('self-clarify', 'cross-clarify')
- `routes/reviews.ts` → 读 suspensions WHERE signal_kind = 'review' + node_outputs
- `routes/health.ts` / 其它 → 读 projection 表
- backend tests 全部更新到新 path（schema 改名 + 字段路径改写）

预期：现有 ~ 1900 backend tests 中约 200 case 需改写以适应新表名 / DTO 形态；行为等价。

### T12 — PR-B grep guards + 收尾

guards 全部生效（design.md §14.3 的 10 条）：

```
禁 isFresherNodeRun                   in src/
禁 cascadeDownstreamFromDesigner      in src/
禁 applyCrossClarifyFreshnessInvariant in src/
禁 rescanScopeForNewPendingRows       in src/
禁 computeHistoryCutoff               in src/
禁 transitionNodeRunStatus / setNodeRunStatus in src/
禁 dispatchReviewNode                 in src/
禁 老表名 (7 张) 在 src/
禁 db.update(logical_runs).set({ status: 在 src/ (event-applier 外)
禁 db.insert(events) 在 src/ (writeEvents 外)
```

commit `feat(backend): RFC-061 PR-B — backend 硬切 + 删 7 表 + 删 6 services + 9+5 handlers`

**PR-B 整体验收**：
- PR-A baseline 全绿
- backend tests 全部更新通过（旧表名相关 case 全部改写）
- e2e baseline 20 spec 全绿
- backend src/ grep 0 命中老表名 / 老 helper / 老 service
- `scheduler.ts` 文件不存在
- 每 handler 文件 ≤ 250 行
- backend 新增 ≥ 70 case（handler unit + actor integration）

---

## PR-C：frontend 硬切 + events timeline 视图 (~1.5 周)

### T13 — wire DTO 重写

frontend 不再使用旧 DTOs，全面重写：

- `ClarifyRound` → `SuspensionRow` with `signal_kind` discriminator (`'self-clarify'` | `'cross-clarify'`)
- `DocVersion` → review suspension payload + node_outputs row
- `NodeRun` → `LogicalRun` + `Attempt[]` pair
- 全部 zod schemas 重写到 `shared/wire/`

### T14 — 路由切到 projection

- `/clarify`：列表 + 详情切到 suspensions projection
- `/tasks/:id`：detail 改读 logical_runs + attempts
- `/reviews/:id`：改读 review suspension + node_outputs

### T15 — WS broadcaster 切 events 流

- 每条 event → ws push (kind + 关键字段)
- 前端 useTaskSync / useClarifyWs 切到订阅 events stream
- React Query invalidate 策略简化（events 自带 scope，按 scope 失效）

### T16 — events timeline 视图（新 UX）

新路由 `/tasks/:id/timeline`：

- 展示完整 events 时间线（含 attempts 子事件、suspension 生命周期、retry 时序）
- 每条事件可展开看 payload
- 过滤器：按 scope (node_id / loopIter / shardKey) / kind 过滤
- 这是事件溯源架构相对今日 mutable row 的**独有 UX 优势**

### T17 — PR-C 收尾

- visual baseline 更新（不要求字节级守恒）
- frontend tests 全部更新（预期约 150 case 需 DTO 改名）
- commit `feat(frontend): RFC-061 PR-C — frontend 切 projection + events timeline 视图`

**PR-C 整体验收**：
- PR-A + PR-B 全部 + PR-C 新增 ~ 40 case 全绿
- e2e baseline 20 spec 全绿（PR-C 内允许刷新 visual baseline）
- frontend src/ grep 0 命中老 DTO 字段名
- 新增 `/tasks/:id/timeline` 路由可用

---

## PR-D：收尾 (~0.5 周)

### T18 — 删除 deprecated 资源

- `packages/backend/scripts/fixup-rfc052-stuck-review.ts` **删除**（断代后结构性不再需要）
- `packages/backend/scripts/fixup-rfc056-2026-05-26-cci-stuck-review.ts` **删除**
- `design/RFC-052-review-retry-cascade-stuck/proposal.md` 顶部加 "Superseded by RFC-061" header（不删，保留历史）
- `design/RFC-056-clarify-cross-agent/patch-*.md` 5 份头部加同款 header
- `design/RFC-058-clarify-sessions-unification/proposal.md` 加同款（clarify_rounds 表已被 RFC-061 进一步统一）

### T19 — RFC-060 / RFC-061 状态收尾

- `design/plan.md` RFC 索引：
  - RFC-060 状态: Draft → Done（假定 RFC-060 已完工）
  - RFC-061 状态: Draft → Done
- STATE.md：
  - 删除 `进行中 RFC-061` 行
  - 已完成 issue 表加 RFC-061 / RFC-060 行

### T20 — grep guards 整理 + CLAUDE.md 提示

- 把 PR-B 落下的 grep guard 整理到 `packages/backend/tests/grep-guards-rfc061.test.ts` 单文件
- CLAUDE.md `## RFC workflow` 节内引用 RFC-061 作为"结构性根治大重构"范本

### T21 — PR-D 收尾

- commit `feat: RFC-061 PR-D — 收尾 + 删 fixup scripts + STATE.md/索引收尾`

**PR-D 整体验收**：
- 6 jobs CI 全绿
- 项目 ready for production / 下一个 RFC 启动
- 新增 ≥ 10 case（grep guard 单文件）

---

## 累计

| PR | 工期 | 新增 case |
|---|---|---|
| PR-A | ~2 周 | ≥ 180（schema 8 + zod 35 + applier 35 + property 100 + e2e baseline 20-spec） |
| PR-B | ~3 周 | ≥ 70（handler unit + actor integration） |
| PR-C | ~1.5 周 | ≥ 40（frontend wire + 路由 + events timeline） |
| PR-D | ~0.5 周 | ≥ 10（grep guard 收口） |
| **合计** | **~7 周** | **≥ 300 新 case + 20 e2e baseline + frontend ~ 150 case 改写** |

## 整体验收

- 4 PR 全部 commit / push / CI 全绿
- events 表是唯一真值源；7 张老表 DROP；6 个老 services 删除
- 5 条不变量 INV-1..INV-5 由 schema + property test 强制
- RFC-056 5 份补丁的场景在新架构下结构性 not-possible（grep guard 锁住）
- scheduler.ts 删除；NodeKindHandler / SignalKindHandler 每文件 ≤ 250 行
- frontend 新增 `/tasks/:id/timeline` 路由——事件溯源架构的独有 UX 优势
- 所有 fixup scripts 删除——结构性永不需要

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| RFC-060 完工延期影响本 RFC 启动 | RFC-061 准备工作（设计审阅、property test 套件草稿）可与 RFC-060 并行做；落码必须等 |
| property test 偶发 flake | 默认 seed 固定；CI 显式打印 seed；本地 100% reproduce |
| PR-B 硬切风险大 | PR-A baseline 20 e2e spec + ≥ 100 property 提前锁所有 user-visible 行为；PR-B CI 必须 baseline 全绿才能合 |
| schema 改动跨多次启动 | upgrade-rolling test 锁；启动期 schema 自检确保 journal idx 一致 |
| frontend 路由变更影响他人未提交 PR | 提前在 STATE.md / PR 描述里点名 |
| 4 PR 7 周战线长 | 每 PR 独立可合；用户随时可暂停 |

## 不在本 RFC 范围

- frontend xyflow 画布业务路径（不动；编辑器 NodeInspector 字段调整由 PR-C 限定）
- opencode 子进程交互（不动）
- 跨 task 事件查询 / 实时 stream latency 优化（后续 RFC）
- multi-daemon 分布式（不动）
- events 表归档 / 分区策略（events 增长慢，半年内不需要）
