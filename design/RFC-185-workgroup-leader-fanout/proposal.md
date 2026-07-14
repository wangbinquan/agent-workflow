# RFC-185 — 工作组 leader 动态多实例派单（fan-out）

状态：Draft（待用户批准进入实现）
模式范围：`leader_worker`
关联：RFC-164（工作组核心）、RFC-166（能力卡）、RFC-167（动态工作流——对比参照）、RFC-172（成员反问 shardKey 隔离）、RFC-182（房间执行体验/runHistory）

## 1. 背景

工作组（RFC-164）的 `leader_worker` 模式里，leader 通过 `wg_assignments` 端口给花名册成员派单。当前的产品心智是「每个 agent 一个实体、一人一单」：leader 把目标拆成若干任务，分别派给**不同**成员。

但大量真实工作是**同质可分片**的——per-file 审计、per-module 重构、同一问题的多方案并行探索。这类工作最自然的形态是：leader 从花名册里挑**一个**合适的 agent，**并发启动 N 个相同 agent 的实例**，给每个实例分配**不同**的任务分片，全部完成后统一验收聚合。

与现有两个机制的对比：

- **静态成员**：所有 agent 成员默认在场、每个 agent 一个实体，靠聊天室交互。要 N 路并行只能预先把同一 agent 以不同 displayName 加 N 次成员——而 schema 明确约束「同一 agent 每组最多一行」（`packages/backend/src/db/schema.ts:521`），此路不通，也不该通（花名册是角色表，不是进程表）。
- **动态工作流**（RFC-167，`mode='dynamic_workflow'`）：orchestrator 在**生成期**从池里一次性产出一张静态 DAG → 人工确认 → 交给标准 DAG 引擎执行。计划一旦确认就固定了。
- **本 RFC**：leader 在**运行期**、每一轮，根据实时进展决定「这轮对哪个 agent 起几个实例、各干什么」——比动态工作流更动态：编排决策发生在执行过程中，而非执行之前。

### 1.1 关键事实：引擎能力已存在，缺的是「解锁」与「呈现」

调研确认（详见 design.md §1），运行期同成员多实例并发在引擎层**今天已经成立**：

- 派单解析不拒绝同一成员出现多条（`packages/shared/src/schemas/workgroupRuntime.ts:294-308`）；
- 唤醒派生对所有 dispatched 派单无 per-member busy 检查，全部并发启动（`packages/backend/src/services/workgroupWake.ts:136-146`）；
- 每单独立 node_run + 独立隔离 worktree，互不干扰（`workgroupRunner.ts:1162-1171`）；
- leader 要等**全部**派单终态才被再次唤醒——天然形成 fan-out → barrier → 聚合的结构（`workgroupWake.ts:167-172`）。

真正的缺口只有两个：

1. **协议面从未告诉 leader 可以这么做**——协议块只说 `member = an AGENT displayName from the roster`（`workgroupContext.ts:314-315`），模型默认「一人一单」自我设限；
2. **前端对同成员并发完全不可见**——花名册每成员只投影一个 currentRun（`workgroupRoom.ts:130-136`），3 路并发时 presence 只显示一个「执行中」，无计数。

因此本 RFC 是一个「解锁 + 呈现」型改动：不加新表、不加新状态机、不改引擎控制流。

## 2. 目标

- G1 leader 可在任意一轮，对花名册中**任一 agent 成员**并发派发多个 assignment（同轮 ≤16，`WG_MAX_ASSIGNMENTS_PER_TURN` 现有上限），每单成为该 agent 的一个独立并发实例；跨轮可继续追加，实例总量不受单轮上限约束。
- G2 实例遵循「雇佣-交付-退场」短生命周期：assignment 终态即实例结束，无常驻实体、无花名册变更。
- G3 免人工确认：派单即生效；每单照常落 dispatch 消息 @成员 + DispatchCard，聊天室天然公示。
- G4 human 在房间内能一眼看清某成员当前有几路并发实例在途（花名册在途计数徽标），并能逐一打开每个实例的 session（经 DispatchCard / 执行记录，现有能力）。
- G5 协议、并发语义（上下文切片、写合并、失败独立性、聚合时机）在 design.md 记档成文，作为后续演进的基线。

## 3. 非目标

- **不做**实例实体化：实例不进花名册、无独立 displayName（如 coder#2）、不可被单独 @、无独立 presence 行。（用户拍板：轻量并发派单路线。）
- **不做**花名册外选人：leader 只能对已在花名册的 agent 成员起实例；引入新 agent 仍是 human 经任务配置加成员的动作。（用户拍板：花名册即池；ACL 启动闭包不被打破。）
- **不做**确认门：不新增 awaiting_review 泊车点。（用户拍板：免确认。）
- **不做**实例间通信/共享上下文：实例零共享，靠自包含 brief 工作；实例间协调由 leader 在聚合轮完成。
- **不做** `free_collab` / `dynamic_workflow` 模式的对应能力（fc 无 leader；dw 走 DAG 引擎）。
- **不改**单轮 16 上限、不加 per-member 并发上限（全局并发已由调度器信号量约束）。

## 4. 用户故事

- **US1（审计分片）**：goal 是「审计本仓 12 个 service 文件」。leader 第 1 轮对成员 `auditor` 一次派 12 单（每单一个文件），12 个 auditor 实例并发各审各的；全部交付后 leader 被唤醒，验收 12 份结果并汇总，wg_decision done。全程无人工介入。
- **US2（多方案探索）**：goal 是「给 X 问题找最优方案」。leader 对 `architect` 派 3 单：方案 A/B/C 各一。3 个实例并发产出后 leader 对比择优，再对 `coder` 派实现单。
- **US3（运行期增兵）**：第 2 轮 leader 发现某分片远大于预期，当轮对同一成员再补 4 单细分——无需人工、无需改花名册。
- **US4（human 旁观）**：human 打开房间，花名册里看到 `@auditor 执行中 ×12`，消息流里 12 张 DispatchCard 各自实时更新状态；点任一卡/执行记录行可进入该实例的 session。

## 5. 验收标准

- A1 leader 单轮对同一成员派 N 单（2≤N≤16）：产生 N 行 assignment、N 条 dispatch 消息、N 个并发 member run（互不同 shardKey），全部并发执行。
- A2 全部 N 单到达终态前 leader 不会被再次唤醒；全部终态后 leader 唤醒，ledger 逐单呈现结果（含 failed 单）。
- A3 任一实例失败/反问不影响兄弟实例继续执行。
- A4 单轮超过 16 条被协议校验拒绝并进入既有 malformed-retry 流程（现有行为，锁测试）。
- A5 leader 协议块含 fan-out 指引（同成员可多条、brief 须自包含、聚合时机、单轮上限）；文本有源码层锁定测试。
- A6 花名册成员行在该成员有 ≥2 路在途 run 时显示在途计数徽标；单路/空闲不显示（避免噪音）。
- A7 ~~无 schema 迁移~~（修订：+1 纯增量迁移，见 A8）、无新 REST 端点、无 wire 类型破坏性变更；现有全套测试保持绿。
- A8（修订，2026-07-14 用户验收反馈「这是新增功能，不能修改原有的固定 agent 模式」）：fan-out 为 **opt-in 开关**（工作组资源字段 `fanOut`，默认 **false**；migration 0094 纯增量）。默认/关闭状态下 leader 协议块**不含** FAN-OUT 段——原有「每 agent 一实体、一人一单」固定模式逐字节不变（回归锁测试）；开启后才注入；任务运行期可经配置对话框中途切换（对齐 autonomous 先例）。
