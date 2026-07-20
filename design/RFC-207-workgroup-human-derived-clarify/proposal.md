# RFC-207 工作组反问改由「花名册是否含人工成员」派生——删除「全自动」开关 —— proposal

状态：**Draft**（待设计门 → 用户批准 → 实现）
立项日期：2026-07-20
承接：RFC-180（`autonomous` 单一总开关，已落地 `30bd6760`）· RFC-181（新建默认全自动 + 中途可切 + 反问硬压制）· RFC-172（成员反问 shardKey 隔离）

## 1. 背景与问题

用户 2026-07-20 走查后拍板：

> 「删除工作组里反问功能，也就是去除全自动的开关，默认全自动无需人工介入，只有在工作组里加入了人工之后，才会出现需要人工回答的问题。」

### 1.1 根因：`autonomous` 是一个多余的中间层

RFC-180 引入 `autonomous` 总开关（关反问邀请 + 完工确认门视为关 + leader 空转自动催办），RFC-181 把它硬化（新建默认 ON、中途可切换、反问硬压制）。两轮迭代之后暴露出的不是实现缺陷，而是**建模冗余**：

「这个组要不要人参与」，用户已经用一个更直接、更不可能记错的动作表达过了——**往花名册里放不放人类成员**（`memberType='human'`，`schemas/workgroup.ts:39-41`）。`autonomous` 要求把同一个意图**再表达一遍**，于是必然产生两组不自洽的组合：

| 花名册 | `autonomous` | 现状行为 | 判定 |
|---|---|---|---|
| 无人工成员 | `true`（RFC-181 新建默认） | 不打扰发起人 | ✅ 符合预期 |
| 无人工成员 | `false`（老组 / 手动关） | agent 反问 → 任务泊住等**发起人**回答 | ❌ 正是用户 2026-07-14 投诉的「组里没人，为什么要我答问题」 |
| 有人工成员 | `false` | 可反问，人在房间答 | ✅ |
| 有人工成员 | `true` | 组里明明站着人，反问却被硬压制 | ❌ 加人的动作被开关否决 |

两个 ❌ 都不是 bug，是「两个事实源表达同一意图」的必然产物。RFC-180 §1.1 当年把根因记为「答题 / 确认权边界 = 任务成员（owner=发起人）≠ human 成员」（`taskCollab.ts:67-76`），于是补了一个开关来盖住它；**本 RFC 走另一条路：让 human 成员成为唯一判据，把开关删掉。**

### 1.2 现状事实（已核对源码）

- `autonomous` 落 `workgroups.autonomous` 列（`db/schema.ts:496`，migration `0093`），启动时冻结进任务快照 `tasks.workgroup_config_json`（`workgroupLaunch.ts:98`），引擎只读快照。
- 它控四件事：① 反问邀请块是否注入（`workgroupContext.ts:457`）② 完工确认门是否生效（`workgroupWake.ts:309`、`workgroupRunner.ts:1121`）③ leader 空转是否自动催办（`workgroupWake.ts:318-322`）④ RFC-181 反问硬压制（`runner.ts:1266`，活判据 `isTaskAutonomous`，`workgroupLifecycle.ts:166-181`）。
- **判据所需的数据已经在手**：任务快照里就带着完整花名册（`WorkgroupRuntimeMemberSchema.memberType`，`workgroupRuntime.ts:24-34`），中途增删成员也会原地改写这份快照（`routes/workgroupTasks.ts:947-1033`），**加人还会同事务写 `task_collaborators`**（`workgroupTasks.ts:1091-1107`）——所以「有没有人工」在引擎侧完全可派生，**不需要任何新列**。
- 全仓**没有**任何 `hasHumanMember` 之类的公共判据，9 处调用各写各的 `.some(m => m.memberType === 'human')`（`workgroup.ts:213`、`workgroupLaunch.ts:148`、`workgroups.ts:341/377`、`workgroupTasks.ts:262/504/983/1004`、`workgroup-form.ts:119/271`）。

## 2. 目标

- **G1 单一判据（D1/D5）**：新增唯一事实源纯函数 `workgroupHasHumanMember(members)`（shared），全仓所有「这个组有没有人工」的问题都走它，取代散落的 9 处 inline filter。
- **G2 反问按判据派生（D1）**：`resolveClarifyEnabled(hasHumanMember)`。无人工成员 ⇒ 邀请块不注入 **且** 沿用 RFC-181 硬压制（agent 硬发 `<workflow-clarify>` 也被软驳回 + 重提示 + 耗尽丢弃，**绝不建 session、绝不泊任务**）；有人工成员 ⇒ 邀请恢复，三角色（leader / worker / fc_member）均可反问，人在房间 / 问题板作答。**反问机制本身不删。**
- **G3 完工确认门同判据（D2）**：`resolveCompletionGate(hasHumanMember, storedGate)` = 无人工恒关（leader 宣告完成直接收尾）；有人工用组内存储值（现默认开）。表单里无人工成员时开关置灰 + 提示。
- **G4 leader 空转催办统一（D6）**：删掉「只有全自动组才催」的分支——**所有组**都先自动催办至多 `WG_LEADER_IDLE_NUDGE_LIMIT`（3）轮，仍无进展再泊 `awaiting_human`。
- **G5 中途增删人工成员即时生效（D7）**：per-task 成员增删已存在（`ConfigPatchSchema.addMembers/removeMemberIds`），本 RFC 让它同时翻转反问 / 确认门语义；**移除最后一个人工成员时，若任务正卡在反问 park 上，复用 RFC-181 A2 的单事务遣散**（撤销反问轮 + 取消中介 park run + 重排队卡片 + resume），agent 以压制态重跑推进。
- **G6 彻底删除 `autonomous`（D8）**：drop 列（migration）+ 删 `WorkgroupSchema` / `workgroupConfigFields` / `WorkgroupRuntimeConfig` 字段 + 删组表单 Switch + 删房间中途配置 Switch + 删列表页「全自动」chip + 删 4 条 i18n key。**不做双轨、不留兼容开关。**
- **G7 零溢出**：非工作组 clarify（普通节点 / 跨节点 / 问题板）行为零变化；`requireTaskMember` 答题权边界不动；prompt 隔离不破（RFC-099——归属信息绝不进 agent prompt，人类成员在 prompt 里恒以 `displayName` 别名出现）。

## 3. 非目标

- **不删反问机制**：`<workflow-clarify>` 通道、clarify session / round、shardKey 隔离（RFC-172）、问题板与集中回答面板全部保留，只换启用判据。
- **不改答题权边界**：`requireTaskMember` / `task_collaborators` / `resolveWorkgroupCollaborators` 语义不动。谁**能**答不变（owner + 协作者 + admin），只改**会不会产生要答的东西**。
- **不动 dynamic_workflow（D4）**：该模式 schema 层就禁止人类成员（`workgroup.ts:213-218`），且「生成 DAG → 人工确认 → 执行」是它的核心产品语义，不是反问；本 RFC 对它恒 mode-inert（同 RFC-180/181）。
- **不引入「永不泊人」强承诺（D3）**：leader 连催到上限仍空转、或触顶 `max_rounds` 但已有产出，仍泊 `awaiting_human` 让发起人看一眼——这是「平台停下来了」而非「agent 在问你问题」，产出还在、可继续可取消。
- **不改 free_collab 三开关 / `fanOut` / `maxRounds`**：与本 RFC 正交。
- **不把「协作者」并入判据（D5）**：启动时勾选的 `collaboratorUserIds` 只是权限名单，agent 在花名册里看不到他们、也无别名可寻址；判据只看花名册。

## 4. 用户故事

- 作为用户，我建一个纯 agent 工作组（花名册里只有 agent），启动后**不会有任何问题弹给我**——agent 遇到小决策自行决断，leader 宣告完成直接收尾。我不用去找、也不用记得勾任何开关。
- 作为用户，我往组里加了一个人类成员，从下一轮起 agent 就可以向人反问了，问题出现在房间和问题板里——**加人这个动作本身就是开关**。
- 作为用户，一个任务已经在反复问我、我不想再答了，我把那个人类成员从任务里移除，在途的反问立刻被撤销、任务当场解卡继续跑——不必取消重启。
- 作为用户，我打开一个老组，看不到「全自动」开关了；它的行为完全由「花名册里有没有人」决定，和我在成员卡片上看到的一致，不会再出现「明明没加人却要我答题」或「明明加了人却问不出来」。
- 作为用户，纯 agent 组的 leader 万一空转，平台会自动催它几轮；实在推不动才停下来叫我看一眼，任务列表里能看到已经做出来的东西。

## 5. 决策记录

### 5.1 用户拍板（2026-07-20）

- **D1 反问通道保留，改由判据派生**：不删 `<workflow-clarify>`；无人工成员 ⇒ 关（含硬压制），有人工成员 ⇒ 开。
- **D2 完工确认门同判据派生**：无人工恒关；有人工用存储开关值（默认开），表单无人工时置灰提示。
- **D3 兜底仍可泊人**：无人工成员的组遇到 leader 催满仍空转 / 触顶 `max_rounds` 但有产出，仍泊 `awaiting_human`。
- **D4 dynamic_workflow 的人工确认不在范围**。
- **D5 判据只看花名册**：`memberType='human'` 的成员；启动时勾选的任务协作者不算。
- **D6 leader 空转催办统一到所有组**：先自动催 3 轮再泊人，删掉有无人工的分支。
- **D7 移除最后一个人工成员即遣散在途反问**：解卡继续跑。
- **D8 存量组全部按新规则**：drop 列、删开关，不做双轨。承认并接受两类行为变化：① 老的「非全自动 + 无人工」组反问被关掉（正是本 RFC 的目的）；② 老的「全自动 + 有人工」组反问被重新打开、且确认门恢复存储值（从新语义看这才是对的）。

### 5.2 由设计推导、随本 RFC 定稿（设计门可挑战，详见 `design.md`）

- **D9 判据求值时点 = 每轮以最新快照为准**：引擎主循环每轮 `loadDbState` 重载 `workgroup_config_json`，判据在每个使用点当场求值；envelope 到达时的硬压制判据走活 DB 读（沿用 RFC-181 C 的 `clarifySuppressed` 回调），杜绝「起跑时有人、落地时没人」的 TOCTOU。
- **D10 遣散触发条件 = 人工成员数 `>0 → 0` 的转移**：只在这条边触发（对齐 RFC-181 A2 的 `false→true`）；仍有人工成员时 no-op；不碰完工确认门的 park（gate park 与 clarify park 分开处理，同 RFC-181）。引擎重入时的不变式重申同步改判据（`workgroupRunner.ts:977-989`）。
- **D11 持久化字面量改名 + backfill**：遣散留痕 `node_runs.error_message='wg-autonomous-dismissed'`（`workgroupLifecycle.ts:262`，经 `clarifyRounds.ts:251` 派生为 `sealedCause` 供前端 banner）改为语义正确的新值，并用 migration 回填历史行——保持单一取值，不留「新旧两种值都要认」的分叉。
- **D12 快照不可解析时 fail-open**：`workgroup_config_json` 缺失 / 损坏时判据取「有人工」（＝不压制反问、允许泊人），与今天 `isTaskAutonomous` 的 `false` 兜底同向——异常态下让人来看是安全阀，不是打扰。
- **D13 `WG_AUTONOMOUS_NUDGE_LIMIT` 随 G4 改名**为 `WG_LEADER_IDLE_NUDGE_LIMIT`（不再与 autonomous 绑定），值仍为 3。

## 6. 验收标准

1. 花名册无人工成员的组：三角色 prompt 均**不含** `<workflow-clarify>`；agent 硬发被驳回、重提示、耗尽丢弃，任务**永不**因反问进入 `awaiting_human`。
2. 花名册含人工成员的组：三角色 prompt **含**邀请块；agent 反问正常建 session、任务 `awaiting_human`（reason `leader-clarify` / `clarify-or-delivery`）、人答完继续跑到 done。
3. 完工确认门：无人工 ⇒ leader 宣告完成直接 `done`；有人工 + 存储开 ⇒ `awaiting_review` 等确认。
4. leader 空转：**任意**组都先发至多 3 条催办、仍无进展才 `awaiting_human` reason=`leader-idle`。
5. 中途加人：下一轮起可反问。中途移除最后一人且正卡在反问上：单事务遣散 + 解卡 + resume；并发的陈旧答案提交被拒（409 / 幂等），不 mint 重跑。
6. `rg -n "autonomous" packages/` 在 `packages/**/src` 下**零命中**（除 `home.cap.workgroups.desc` 的营销文案）；`workgroups` 表无 `autonomous` 列；per-task PATCH 拒绝该字段。
7. 非工作组 clarify 全套测试零回归；`requireTaskMember` 边界与 prompt 隔离测试（rfc099-prompt-isolation）保持绿。
8. 门禁：`bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿 + 单二进制 build smoke + Playwright e2e。
