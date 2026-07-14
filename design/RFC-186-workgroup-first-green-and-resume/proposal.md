# RFC-186 工作组「到第一次绿 + 别再永久死」——信封重试对齐 + 中断恢复 + 真实 e2e

> 产品视角。技术设计见 [`design.md`](./design.md)，任务分解见 [`plan.md`](./plan.md)。
> 依据：[`design/workgroup-e2e-audit.md`](../workgroup-e2e-audit.md)（本 RFC 落实其 §8 Phase 0 + Phase 1）。

## 背景

工作组（`leader_worker` / `free_collab`）自 RFC-164 落地以来 **10 个任务、0 个 done、没有一个 worker 真正执行过**。全仓审计（`design/workgroup-e2e-audit.md`）定位出**两个 P0 联合解释「0 done」**，以及一个让它们带病上线的 **meta 根因**：

- **P0-A｜leader/member 首轮死于任何信封/协议手滑（round 0）**：协议块无 `<workflow-output>` 完整范例（模型瞎猜外壳→`<wg-output>`）× `envelope-missing`/畸形输出**零重试直接 `throw` fatal**（普通节点会重试 3 次）× 失败按 `errorMessage` 字符串前缀反推、结构化 `failureCode` 在 hook 边界被丢。
- **P0-B｜任意 daemon 重启中途 = 永久死亡**：`interrupted` 的 turn-engine 工作组**零恢复路径**（`autoResume` 过滤 + 诊断修复拒绝 + 手动 resume 撞 builtin-403，且一条测试锁死该排除）；`running` assignment + 终态 node_run 无对账、还算 blocking 冻住 leader；cursor 在 turn **执行前**推进使崩掉的 turn 在 resume 后被静默丢。3/10 任务即死于此、永不恢复。
- **Meta｜真实运行路径零 e2e 覆盖**：所有工作组引擎测试 stub 掉 `runHostNode`，真 `buildWorkgroupHooks.runHostNode` 在多轮循环语境下从未被任何测试执行 → 两 P0 带病上线、每任务串行发现新集成 bug。

审计 §3 已实证：**只要 leader/member 轮修好，回合循环+聚合+收尾机械上能到 done**。所以这不是架构问题，是一条从未被真实执行过的链上积了两个 P0。

> **进度勘误（2026-07-14，并发 session）**：commit `9874fffd`（RFC-185 端到端实测）已**部分修 P0-A 并拿到史上第一次绿**（工作组任务 `01K…1GWAWY` → `done`）：`envelope-missing` 现已重试（leader `workgroupRunner.ts:1079`、member `:1287`，走结构化 `failureCode`）+ 协议块补了 `<workflow-output>` 字面示例（`workgroupContext.ts:266-271`）+ `@` 前缀宽容 + `WorkgroupHostRunResult.failureCode` 已贯穿 hook。**但**：① 那是**手测**（真 daemon+glm-5.2），CI 里的自动测试**仍全是 stub-hook**——真实运行路径**仍零自动覆盖**、首绿未被回归锁；② 修法是**最小补丁**（`failureCode==='envelope-missing'` 特判 + 残留 `startsWith('clarify-questions-')` 字符串链混用、`WG_PROTOCOL_RETRIES` 仍=1），与普通节点的两套逻辑**未消除**；③ **P0-B 完全未动**（`autoResume.ts:77` 仍排除工作组、cursor 仍前置推进）。**本 RFC 承接这三个真空**，不重复已做的部分。

## 目标

1. **P0-A 深化（承接 9874fffd 最小补丁）**：把已有的 `failureCode==='envelope-missing'` 特判 + 残留字符串前缀链，**统一升级为全量复用普通节点机制**——`FOLLOWUP_POLICY` 单表分派 + `renderEnvelopeFollowupPrompt` 重提示 + `WG_PROTOCOL_RETRIES` 提到普通默认量级 + `driveMessageTurn` 非-done 也重试。彻底消除「工作组另写一套」的不对称。（基础 envelope-missing 重试 + 协议范例已由 9874fffd 完成，不重复。）
2. **P0-B 别再永久死（全新）**：一个中途被 daemon 重启打断（`interrupted`）的工作组任务能**恢复并最终完成**，且 resume 不丢任何已排队但未执行的 turn。
3. **真实覆盖（全新，焊死首绿）**：新增走真实子进程（`buildWorkgroupHooks` 那条缝）的**自动** e2e——正向到 done、信封重试恢复、重启→恢复——把「测试绿而生产死」的缝焊死、把 9874fffd 的手测首绿锁进 CI。

## 非目标（明确推给后续 Phase 2/3 单独 RFC）

- fan-out 重叠写逐路径救回、merge agent 移出 writeSem（审计 §4-2/3）。
- host 节点 clarify 老化失效（审计 §5 F4，RFC-184 遗留）——需独立的「是否留存已答 clarify」产品决策。
- 启动就绪缺 producer 护栏 TRAP-1、roster/协议 `@` 文案调和 TRAP-2、Playwright 收紧 TRAP-3（审计 §6）。
- leader `continue` 不派发处理、maxRounds 重试膨胀、monotonic ULID、adopted-dispatched CAS、conflict-human iso 保留等（审计 §3/§4 的 P1/P2）。
- 本 RFC **不**扩大工作组功能面，只做「让既有设计第一次真正跑通并可恢复」。

## 用户故事

- 作为发起人，我建一个有 producer 的 `leader_worker` 组、给个目标启动，leader 拆解派发、worker 干活、结果被聚合，任务**跑到 done**——而不是 round 0 秒挂。
- 作为发起人，leader/worker 偶尔把信封格式写错（模型概率性手滑），框架**重试并给出带范例的纠正**，而不是一次手滑杀整个多 agent 任务。
- 作为运维，daemon 因部署/崩溃/`bun dev` 热重启打断了一个工作组任务，它**自动（或一键）恢复**并继续跑完，而不是永久卡在 `interrupted`。
- 作为维护者，我改工作组代码时有**真实子进程 e2e** 立刻变红，而不是被 stub 掩盖到生产才炸。

## 验收标准

1. **正向到绿（真实 e2e）**：一个 `leader_worker` 组（leader + 1 producer worker）经 `startWorkgroupTask(..., {opencodeCmd, awaitScheduler:true})`、scenario-opencode 脚本化 leader 派发轮 / worker `wg_result` 轮 / leader `wg_decision done` 轮 → 任务 `status==='done'`，且存在 `__wg_member__` 真 run 到 `done`、worker 写的文件出现在任务累积 diff 里。
2. **信封重试恢复（真实 e2e）**：leader 首轮 `{skipEnvelope:true}`（→ `envelope-missing`）后次轮合法 → 任务仍到 `done`（不再 fatal）；断言中间 run 失败但被同一 turn 重试恢复。member 同理。
3. **重试对齐普通节点**：`WorkgroupHostRunResult` 带 `failureCode`；leader/member 失败分支按 `FOLLOWUP_POLICY`/`decideEnvelopeFollowup` 分派、重提示走 `renderEnvelopeFollowupPrompt`（理由化 + 分 kind 修复块）；`throw` 只留真致命码（iso/injection/merge/spawn/timeout）。源码文本锁 + 单测锁住「envelope-missing 走重试不 throw」。
4. **协议块有范例**：leader/worker/fc_member 的输出协议块含完整 `<workflow-output><port name="…">…</port></workflow-output>` 范例（共享常量，与 `buildProtocolBlock` 同源）。镜像/存在性单测。
5. **中断恢复（真实 e2e）**：一个工作组任务在成员轮 `{crash:true}` 后 → 任务 `interrupted` → 触发恢复 → **最终到 `done`**；断言 resume 未丢已排队 turn（cursor 修复生效）。
6. **重启对账**：引擎载入时把「node_run 终态但 assignment 仍 `running`」对账到正确态（done/重派/failed）；单测锁。
7. `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；CI 三项 + 单二进制 smoke + Playwright e2e 全绿；新真实 e2e 计入后端套件。
8. Codex 设计门（批准前）+ 实现门（declaring done 前）各跑并折入 findings。
