# RFC-180 工作组「全自动」模式——单一总开关（关反问邀请 + gate 默认关 + leader 空转自动 nudge） —— proposal

## 1. 背景与问题

用户 2026-07-13/14 走查时问：

> 「在工作组里没有添加人类成员的时候，为什么会产生问题需要人回答？」

澄清后（详见根因 §1.1）用户拍板：要一个「全自动组」总开关，让纯 agent 工作组**尽量不打扰发起人**。

### 1.1 根因链（均带出处，已核对源码）

「工作组有没有 human 成员」与「谁来回答 / 确认」是**两个解耦概念**：

- **回答 / 确认权边界 = 任务成员（owner + collaborator）**，落 `task_collaborators` 表，判据单一出口 `requireTaskMember`（`services/taskCollab.ts:67-76`、schema 注释 `db/schema.ts:1822-1826`）。工作组任务 owner 恒等于**发起人**（点启动的人）；human 成员只是启动时被 `resolveWorkgroupCollaborators`（`services/workgroupLaunch.ts:134-142`）塞进 collaborator 的一种来源。
- 推论：**即使 human 成员为 0，发起人（owner）永远在回答边界内**——「零 human 成员」≠「没人可问」。

在此前提上，纯 agent 工作组仍会被泊成需人介入，有三条**与 human 成员无关**的路径：

1. **agent 主动反问（clarify / `<workflow-clarify>`）**：每个 role 的协议块**无条件**注入「可向人反问」邀请（`services/workgroupContext.ts:353`，`WG_CLARIFY_BLOCK`；RFC-172 恒开、三 role 均 push）。
2. **完工确认门 completionGate（默认开）**：leader 宣告 done 即泊 `awaiting_review` 等人确认——默认值 `shared/schemas/workgroup.ts:153`（2026-07-13 用户拍板默认 ON）、判定 `services/workgroupWake.ts:223`、确认端点 `routes/workgroupTasks.ts:439`。
3. **leader-idle 泊住**：leader 跑完一轮既没派活也没宣告 done → `awaiting_human/'leader-idle'`（`services/workgroupWake.ts:226-229`）。

这三条**不是 bug，是有意设计**（让 agent 卡住时能向发起人升级而非瞎猜）。但用户想要「纯自动、别打扰我」的组时**缺一个关闭入口**：completionGate 能在组定义里关（默认却开），而 clarify 反问邀请是硬编码恒开、无关闭入口，leader-idle 也总泊人。

## 2. 目标

- **G1 单一「全自动」总开关（D1）**：组定义新增 `autonomous: boolean`（默认 false）。一个开关表达「别打扰我」。
- **G2 开启即关两条主动打扰**：`autonomous=true` 时——① 协议块**不注入** clarify 反问邀请（`renderWgProtocolBlock` 不 push `WG_CLARIFY_BLOCK`）；② completionGate **视为关**（leader done 直接 finish，不泊 `awaiting_review`）。
- **G3 leader 空转自动 nudge 重试（D2）**：`autonomous=true` 时，leader-idle 不直接泊人，而是向 leader 追加一条 nudge（「按目标继续派活或宣告完成」）重跑；**连续 N 轮无进展**（无新派单 / 无消息 / 未宣告）再泊 `awaiting_human`（防死循环 / 防跑飞）。
- **G4 单一 resolve 事实源（D3）**：`autonomous` 覆盖 `completionGate`（`autonomous ? gate=off`）与 clarify（`autonomous ? clarify=off`），用 resolve 纯函数收敛（类比 `resolveWorkgroupSwitches` `shared/schemas/workgroup.ts:257-265`），存储值 + 派生视图分离。
- **G5 前端最小接入**：`WorkgroupForm` 加一个「全自动」`Switch`（复用公共 `Switch`，落既有 `sectionSwitches` 分区），开启时把 completionGate 开关置灰 + 说明（mode/flag-conditional，同 fc all-on 的 UI 处理）；房间/详情可加「全自动」徽标。
- **G6 零回归 + prompt 隔离不破**：升级已有组 `autonomous` 默认 false、行为不变；autonomous 只是 UI/引擎控流，绝不入 agent prompt 归属信息。

## 3. 非目标

- **不改 clarify 底层机制 / 答题权边界**：`requireTaskMember` / task_collaborators 不动；autonomous 只是**不邀请** agent 反问，不改「谁能答」。
- **不改 free_collab 协作语义 / 三开关**：autonomous 与 shareOutputs/directMessages/blackboard 正交。
- **不作用于 dynamic_workflow**：该模式无聊天室回合引擎（编排 agent 生成→确认→执行），无 leader/gate/clarify 回合概念——autonomous 对它 mode-conditional 无效（同 free_collab 对 leader 字段的处理）。
- **不引入「全自动＝完全无人值守到结束」的强承诺**：真失败 / 连续空转到上限仍泊 `awaiting_human`（G3 兜底），autonomous 是「尽量不打扰」，非「永不泊人」。

## 4. 用户故事

- 作为用户，我建一个纯 agent 工作组、勾上「全自动」，启动后 agent 遇到小决策不会弹问题给我、leader 宣告完成直接收尾，我不用点确认。
- 作为用户，全自动组的 leader 万一空转，平台会自动催它一轮「继续或收尾」，而不是立刻停下等我；只有它连着几轮真的推不动，才泊住叫我看一眼。
- 作为用户，我把一个已有工作组打开，看到「全自动」默认没勾、行为和以前完全一样——不勾就是现状。
- 作为用户，勾了「全自动」后，完工确认门开关自动置灰并提示「全自动模式下不适用」，我不用再纠结两个开关的组合。

## 5. 决策记录（2026-07-13/14，用户拍板）

- **D1 单一总开关**：一个「全自动」= 关 clarify 反问邀请 + gate 默认关。不拆成多开关。
- **D2 leader 空转＝自动 nudge 重试**：leader-idle 时自动催一轮，连续 N 轮无进展再泊人。

由设计推导、随本 RFC 定稿的从属决策（详见 `design.md`，设计门可挑战）：

- **D3 autonomous 覆盖式 resolve**：`resolveCompletionGate(mode, autonomous, stored)` = `autonomous ? false : stored`；`resolveClarifyEnabled(autonomous)` = `!autonomous`。存储 `completionGate` 值保留（关闭 autonomous 即恢复），派生视图单源。
- **D4 nudge 上限 + 双兜底**：连续无进展 nudge 上限 `WG_AUTONOMOUS_NUDGE_LIMIT`（默认 3，待设计门定），且恒受 `max_rounds` 约束；到上限泊 `awaiting_human`（reason 复用/新增 `leader-idle`）。有进展（新派单/新消息/宣告）即重置计数。
- **D5 nudge 消息形态**：向房间发一条定向 leader 的 system 消息（对齐 RFC-176 kickoff 形态 `workgroupRunner.ts` 播种），既给 leader「新活动」触发、又在房间可见「平台已自动催办」。
- **D6 mode 适用面**：autonomous 仅 `leader_worker`/`free_collab` 生效（free_collab 无 leader → 只关 clarify 邀请 + gate；无 leader-idle nudge）；`dynamic_workflow` 无效。

## 6. 验收标准

- schema 新增 `autonomous`（默认 false）；migration ×1 加列；升级不回归（旧组 autonomous=false、行为不变）。
- `resolveCompletionGate` / `resolveClarifyEnabled` 纯函数 table 覆盖 autonomous on/off × mode × storedGate。
- `autonomous=true`：`renderWgProtocolBlock`（leader/worker/fc_member 三 role）输出**不含** `WG_CLARIFY_BLOCK`；`autonomous=false` 含（不回归 RFC-172）。
- `autonomous=true` 且 leader 宣告 done：任务直接 `done`（不 `awaiting_review`、不 mint gate run）。
- `autonomous=true` 且 leader 空转：落一条 nudge system 消息、leader 重跑；连续无进展到 `WG_AUTONOMOUS_NUDGE_LIMIT` → 泊 `awaiting_human`；中途有进展→计数重置（引擎测试）。
- `autonomous=false`：三条路径全维持现状（clarify 邀请在、gate 按存储值、leader-idle 直接泊）——回归锁死。
- 前端：`WorkgroupForm` 有「全自动」Switch；开启时 completionGate 开关置灰 + 提示；i18n zh/en 对称。
- 门禁：`bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；单二进制 build smoke（migration 计数锁同步）；Codex 设计门 findings 全折。
