# RFC-207 —— design

> 读法：本文只写「改什么、为什么这么改、哪里会炸」。现状事实全部带 `file:line`，实现时以源码为准。

## 1. 单一事实源

### 1.1 新增判据（shared）

`packages/shared/src/schemas/workgroup.ts`，紧邻 `workgroupLaunchReadiness`：

```ts
/**
 * RFC-207 —— 唯一判据：这个组的花名册里有没有人工成员。
 * 「要不要人参与」由花名册单独表达，不再有第二个开关（RFC-180/181 的
 * `autonomous` 已删）。反问启用、完工确认门是否生效，全部由它派生。
 * 只看 memberType='human' 的花名册成员：任务级 collaboratorUserIds 是权限
 * 名单，agent 在花名册里看不到他们、也无别名可寻址（D5）。
 */
export function workgroupHasHumanMember(
  members: ReadonlyArray<{ memberType: WorkgroupMemberType }>,
): boolean {
  return members.some((m) => m.memberType === 'human')
}
```

全仓现有 9 处 inline `.some/.filter(m => m.memberType === 'human')` 一并收编到它：`workgroup.ts:213`（dw 保存门）、`workgroupLaunch.ts:148`（协作者并集，语义是取 userId 集合，保留 filter 但注释指向本判据）、`workgroups.ts:341/377`、`workgroupTasks.ts:262/504/983/1004`、`workgroup-form.ts:119/271`。

### 1.2 两个 resolve 的改造（**故意做成破坏性签名变更**）

现状（`schemas/workgroup.ts:327-337`）：

```ts
export function resolveCompletionGate(autonomous: boolean, storedGate: boolean): boolean {
  return autonomous ? false : storedGate
}
export function resolveClarifyEnabled(autonomous: boolean): boolean {
  return !autonomous
}
```

**危险面**：新判据与 `autonomous` 布尔位置相同、真值**恰好相反**。若只改函数体、不改签名，任何漏改的调用点都能通过 typecheck 而行为反转（反问该关的开、该开的关）。因此：

- **`resolveClarifyEnabled` 直接删除**。它在新语义下退化为恒等函数（`clarifyEnabled === hasHumanMember`），保留只是多一层。4 个调用点（`workgroupContext.ts:457`、`workgroupRunner.ts:1520/1813/1989`）改写为 `workgroupHasHumanMember(config.members)`；符号消失 ⇒ 漏改点必在 typecheck 红。
- **`resolveCompletionGate` 参数类型从 `boolean` 换成成员数组**，同样让漏改点在 typecheck 红：

```ts
export function resolveCompletionGate(
  members: ReadonlyArray<{ memberType: WorkgroupMemberType }>,
  storedGate: boolean,
): boolean {
  return workgroupHasHumanMember(members) ? storedGate : false
}
```

- **`WG_AUTONOMOUS_NUDGE_LIMIT` → `WG_LEADER_IDLE_NUDGE_LIMIT`**（值仍 3，`workgroup.ts:340`）：G4 之后它不再与 autonomous 绑定。

### 1.3 后端活判据（引擎/hook 侧）

`services/workgroupLifecycle.ts:166-181` 的 `isTaskAutonomous(db, taskId)` 替换为：

```ts
/**
 * RFC-207 —— 这个任务的**冻结花名册**里已无人工成员 ⇒ 反问压制。
 * 读 tasks.workgroup_config_json（引擎与中途 PATCH 的共同事实源），
 * 每次调用当场求值，故中途增删成员下一次判定即生效（D9）。
 * 快照缺失 / 不可解析 ⇒ false（不压制），与旧 isTaskAutonomous 的兜底同向：
 * 异常态下让人来看是安全阀，不是打扰（D12）。
 */
export async function isTaskClarifySuppressed(db: Db, taskId: string): Promise<boolean>
```

四个调用点全部要负向语义，故只导出这一个负向函数，避免调用点散落 `!`：
`scheduler.ts:864`（`clarifySuppressed` 回调）、`scheduler.ts:936`（late-suppress）、`scheduler.ts:990`（`createClarifySession` 后的 TOCTOU 补偿）、`workgroupRunner.ts:977-989`（引擎重入不变式重申）。

`dismissOpenClarifyParksForAutonomous` → **`dismissOpenClarifyParks`**（`workgroupLifecycle.ts:208+`）。事务内容不变：clarify_sessions + clarify_rounds 双表 canceled、中介 park run canceled、assignment `awaiting_human→dispatched/open` 重排队（`WORKGROUP_ASSIGNMENT_TRANSITIONS` 的两条 A2 边保留）。

## 2. 判据接线点全表

| # | 位置 | 现状 | 改为 |
|---|---|---|---|
| 1 | `workgroupContext.ts:457` | `if (resolveClarifyEnabled(config.autonomous ?? false))` push 邀请块 | `if (workgroupHasHumanMember(config.members))` |
| 2 | `workgroupRunner.ts:1520` leader turn | `clarifyEnabled: resolveClarifyEnabled(config.autonomous ?? false)` | `clarifyEnabled: workgroupHasHumanMember(config.members)` |
| 3 | `workgroupRunner.ts:1813` assignment turn | 同上 | 同上 |
| 4 | `workgroupRunner.ts:1989` message turn | 同上 | 同上 |
| 5 | `scheduler.ts:863-865` | `clarifySuppressed: () => isTaskAutonomous(db, taskId)` | `clarifySuppressed: () => isTaskClarifySuppressed(db, taskId)`（`req.clarifyEnabled !== undefined` 的 wiring 条件不变——它只是「这是 wg host run」的标记） |
| 6 | `scheduler.ts:936-937` late-suppress | `await isTaskAutonomous(...)` | `await isTaskClarifySuppressed(...)` |
| 7 | `scheduler.ts:990-999` TOCTOU 补偿 | 同上 + `dismissOpenClarifyParksForAutonomous` | 同上 + `dismissOpenClarifyParks` |
| 8 | `workgroupWake.ts:308-311` 完工门 | `resolveCompletionGate(input.config.autonomous ?? false, input.config.completionGate)` | `resolveCompletionGate(input.config.members, input.config.completionGate)` |
| 9 | `workgroupRunner.ts:1121` done 分支复检 | 同上 | 同上 |
| 10 | `workgroupWake.ts:315-322` leader 空转 | `if (autonomous) { nudge<LIMIT ⇒ leader-nudge }` 否则直接 park | **删条件**：恒 `nudges < WG_LEADER_IDLE_NUDGE_LIMIT ⇒ leader-nudge`，否则 park `leader-idle` |
| 11 | `workgroupRunner.ts:977-989` 重入不变式 | `(rec.config.autonomous ?? false) && mode !== 'dynamic_workflow' && 有 open session ⇒ dismiss` | `(await isTaskClarifySuppressed(db, taskId)) && mode !== 'dynamic_workflow' && 有 open session ⇒ dismiss` |
| 12 | `runner.ts:1266-1278` 硬压制文案 | `clarify-forbidden: ask-back is OFF in this autonomous group; …` | 文案改「本组没有人工成员」，语义不变（详见 §3.2） |
| 13 | `workgroupRunner.ts:1536-1544` / `:1828-1833` 重提示 | `Ask-back is OFF in this autonomous group…` | 同上改文案；**drop-and-continue / assignment failed 的收场逻辑一律不动** |

**不变的部分（务必别顺手改）**：`clarifyChannel: { kind:'self', directive:'delegated', injectStopNotice:false }`（`scheduler.ts:862`，RFC-183 对称性锁）、`WG_PROTOCOL_RETRIES`、`followupForFailure` / `wgFollowupNotice` 表、`deriveLeaderClarifyPark`（`workgroupRunner.ts:734`）、RFC-172 的 shardKey 隔离全链。

## 3. 语义细则

### 3.1 有人工成员时的反问面

三角色（leader / worker / fc_member）**全部**恢复邀请，与今天 `autonomous=false` 时完全一致（`workgroupContext.ts:451-456`，RFC-172 route 2 已让邀请对成员通用）。答题权边界不动：owner + collaborator + admin（`taskCollab.ts:67-76`）；人类成员在启动时（`workgroupLaunch.ts:143-151`）与中途加入时（`workgroupTasks.ts:1091-1107`）都会进 `task_collaborators`，所以「花名册里有他」⇒「他答得了」这条链是闭合的。

### 3.2 无人工成员时的硬压制（RFC-181 C 原样保留，只换判据与文案）

envelope 到达时短路 ⇒ `failed` / `failureCode='clarify-forbidden'` ⇒ leader 重提示后 **drop-and-continue**（滑入 idle→nudge→到限泊人的安全阀）、worker 该轮 `failed` 浮出。**绝不建 session、绝不 park、绝不因反问杀任务。**

文案（`runner.ts:1278`、`workgroupRunner.ts:1539`）改为不再提「autonomous group」，改述事实：本组没有人工成员，无人可答，请自行决断并 emit `<workflow-output>`。**注意 `rfc183-clarify-invite-accept-symmetry.test.ts:229` 是逐字节断言，必须同步改。**

### 3.3 leader 空转催办统一（G4）

`WG_NUDGE_BODY`（`workgroupWake.ts:100-106`）首句 `Autonomous mode: you ended a round without…` 要改（不再有 autonomous 概念）。

**已知升级影响**：`countTrailingNudges`（`workgroupWake.ts:108-117`）按 `bodyMd === WG_NUDGE_BODY` **逐字精确匹配**计数。改文案后，在途任务里已发出的旧催办消息不再被计入，计数从 0 重来 ⇒ 单个在途任务最多多催 3 轮。不会死循环（恒受 `max_rounds` 约束，且 leader 必须真的跑一轮才可能再催，`workgroupRunner.ts:1151-1154`）。可接受，记录在案。

### 3.4 中途成员增删的转移语义（G5 / D7 / D10）

`PUT /api/workgroup-tasks/:taskId/config` 已支持成员增删（`workgroupTasks.ts:947-1033`）。本 RFC 在同一 handler 里加转移判定：

```
hadHuman  = workgroupHasHumanMember(<入口快照 members>)
willHave  = workgroupHasHumanMember(<写入的 nextConfig.members>)
```

- `!hadHuman && willHave`（加入第一个人）：无补偿动作。下一轮引擎 `loadDbState` 即注入邀请块。**已因压制而 failed 的 assignment 不会自动重跑**——沿用 RFC-181 的 drop-and-continue 语义，本 RFC 不扩范围。
- `hadHuman && !willHave`（移除最后一人，D7）：与配置写入**同一把锁 / 同一事务**内 `dismissOpenClarifyParks(db, taskId, mode)`，随后 `kickIfParked` 解卡 + resume。完全复用 RFC-181 A2 的编排（含：与答案提交串行化 ⇒ 陈旧答案 409 / 幂等拒绝；`dynamic_workflow` 免疫；遣散后新鲜状态复读 kick + 2.5s 延迟二次 kick 防搁浅）。`changes[]` 追加人类可读行。
- 其余组合 no-op。**完工确认门的 park 不被遣散**（gate park 与 clarify park 分开，同 RFC-181）。

替换掉现有的 `patch.autonomous === true && stored !== true` 触发条件（`workgroupTasks.ts:1212-1222`）。

### 3.5 `persistGate` 的 reload-merge 必须覆盖 members（风险点）

`workgroupRunner.ts:583-600` 的 reload-and-merge 事务，当初是为了「引擎写整份 JSON 时不要覆盖掉并发的 `autonomous` PATCH」。`autonomous` 删了，但**判据载体变成了 `members`**——同一类竞态照样存在（引擎写 gate 的同时用户在删人）。实现时**必须核实该 merge 的字段清单包含 `members`**（以及 `switches`/`maxRounds`/`completionGate`/`fanOut`），否则一次 gate 持久化就能把用户刚做的成员变更抹掉，且表现为「删了人却还在问」。这是本 RFC 最容易静默回归的一处，列为设计门重点。

## 4. 数据与迁移

| 项 | 处理 |
|---|---|
| `workgroups.autonomous` 列（`db/schema.ts:496`，migration `0093`） | **DROP COLUMN**（先例：`0072_rfc130_drop_agent_readonly.sql` 等 10 个）。Drizzle schema 同步删字段 |
| `tasks.workgroup_config_json` 里存量快照带的 `autonomous` 键 | **不迁移**。`WorkgroupRuntimeConfigSchema` 删字段后，zod 非 strict 对象会**剥离**未知键 ⇒ 旧快照照常 parse。**实现时须确认该 schema 未加 `.strict()`**（`workgroupRuntime.ts`） |
| `node_runs.error_message = 'wg-autonomous-dismissed'`（`workgroupLifecycle.ts:262`；经 `clarifyRounds.ts:251` 派生成前端 `sealedCause`） | 改写为 `'wg-clarify-disabled'` + migration 回填历史行，保持单一取值（D11） |
| `_journal.json` | 98 → 99 条；`upgrade-rolling.test.ts` 的 journal-count 断言 +1（标题 + 断言 + 注释三处） |

迁移 SQL（编号实现时复核——另有一个计划中的 `0099` drop `cached_repos.url`，若已被占用则顺延）：

```sql
-- RFC-207: autonomous 开关删除，反问/完工门改由花名册是否含人工成员派生
ALTER TABLE workgroups DROP COLUMN autonomous;
--> statement-breakpoint
UPDATE node_runs SET error_message = 'wg-clarify-disabled'
  WHERE error_message = 'wg-autonomous-dismissed';
```

`--> statement-breakpoint` 必须有，否则只有第一条语句会被执行（静默）。

**升级期行为变化（D8 已接受，须在 STATE.md / release note 写明）**：
- 老的「非全自动 + 无人工成员」组 ⇒ 反问被关掉（本 RFC 的目的）。
- 老的「全自动 + 有人工成员」组 ⇒ 反问重新打开、完工确认门恢复其存储值（多数为默认 `true`）。

## 5. API / wire 变更

- `POST/PUT /api/workgroups`：body 不再接受 `autonomous`（zod 非 strict ⇒ 旧客户端多传会被**静默忽略**，不报错，可接受）；响应体不再返回该字段（`workgroups.ts:422` `rowToWorkgroup`）。
- `PUT /api/workgroup-tasks/:taskId/config`：`ConfigPatchSchema` 删 `autonomous`（`workgroupTasks.ts:119`）、changes 文案（`:1038`）、nextConfig 合并（`:1084`）。
- `GET /api/workgroup-tasks/:taskId/room`：返回的 `config` 不再含 `autonomous`（`workgroupTasks.ts:363`）。
- 无 WS 载荷变化（`autonomous` 从未进 WS 消息；配置变更仍以 `wg.message.created` 的 system 行体现）。
- **e2e 提醒**：`e2e/` 在 workspace typecheck 之外（见 per-user memory）。`e2e/task-wizard.spec.ts:145-200` 创建工作组时本就不传 `autonomous`，但它建的是**纯 agent 组**——改造后行为与今天（新建默认全自动）一致，理论零影响；仍须实跑确认。

## 6. 前端

| 位置 | 改动 |
|---|---|
| `components/workgroup/WorkgroupForm.tsx:150-157` | 删「全自动」`Switch` |
| `components/workgroup/WorkgroupForm.tsx:138-148` | 完工确认门 `disabled` 由 `value.autonomous` 改为 `!hasHumanMember`；hint 换 `workgroups.fieldCompletionGateNoHumanHint`。组件新增 prop `hasHumanMember: boolean`，由 `routes/workgroups.detail.tsx:956-963` 从 group.members 计算传入 |
| `components/workgroup/WorkgroupTaskConfigDialog.tsx:181-203` | 同上；该弹窗**自带成员增删暂存**，`hasHumanMember` 必须随暂存的增删**实时**重算（勾了「移除最后一个人」时确认门当场置灰），否则用户看到的与提交后的语义不一致 |
| `lib/workgroup-form.ts:89/102/136/287/324/508` | 删 draft 字段与 payload 分支 |
| `lib/workgroup-room.ts:617/630/637/654/671` | 删 task config draft 字段与 patch diff |
| `routes/workgroups.tsx:114/141-143` | 「全自动」chip ⇒ **「含人工」chip**（仅当组含 human 成员时显示），i18n key `workgroups.humanMemberChip`；搜索文本同步。**设计取舍**：信号不能消失——用户需要在列表一眼看出「哪些组会来找我」，只是语义翻转。实现时须确认列表 API 的 `rowToWorkgroup` 带 `members`（若不带则改用现成的成员计数字段或补齐） |
| `routes/clarify.detail.tsx:819-820` | `sealedCause === 'wg-autonomous-dismissed'` ⇒ `'wg-clarify-disabled'`；文案 key 改名 |
| `components/workgroup/WorkgroupRoom.tsx:1050-1054` | 「反问已压制」回合卡标注保留；仅 i18n 文案改述为「本组无人工成员」 |
| i18n（`i18n/zh-CN.ts` + `en-US.ts` + 类型声明三处） | **删**：`workgroups.autonomousChip` / `fieldAutonomous` / `fieldAutonomousHint` / `fieldCompletionGateAutonomousHint`。**加**：`workgroups.humanMemberChip` / `workgroups.fieldCompletionGateNoHumanHint`。**改名**：`clarify.roundDismissedByAutonomous` → `clarify.roundDismissedNoHuman`。`i18n-keys-symmetry.test.ts:28-32` 会抓单边遗漏 |

前端**不新增任何自写组件 / CSS**：全部复用现成 `Switch` / `chip` / `Field`（CLAUDE.md 前台风格统一原则）。

## 7. 失败模式与边界

| # | 场景 | 处置 |
|---|---|---|
| F1 | 判据漏改导致语义反转 | §1.2 的破坏性签名变更（删 `resolveClarifyEnabled`、`resolveCompletionGate` 换参数类型）让所有调用点在 typecheck 阶段红，不依赖人眼 |
| F2 | 花名册里的人类成员指向**已停用 / 已删除**用户 | 「有人工」为真但实际无人能答。既有行为：启动时 `buildLaunchCollabRows` 抛 `invalid-collaborator`（`taskCollab.ts:232-236`）⇒ 启动直接失败；`workgroup_members.user_id` 无 FK（`db/schema.ts:537`）。**本 RFC 不扩范围修**，记录为已知边界；若要修属独立 RFC（加就绪校验 / 加 FK） |
| F3 | 移除最后一人与答案提交并发 | 复用 RFC-181 A2：单事务 + 与答案提交串行化 ⇒ 陈旧答案 409 / 幂等拒绝，不 mint 重跑 |
| F4 | 崩溃窗（配置事务已提交、遣散未执行） | 引擎重入不变式（表 §2 #11）在下次 (re)entry 重申并补做遣散，同 RFC-181 P1-7 |
| F5 | `dynamic_workflow` 被误伤 | 遣散扫描保留 `mode !== 'dynamic_workflow'` 守卫（别扫掉生成图普通节点的 clarify park）；该模式 schema 层禁人类成员 ⇒ 判据恒 false ⇒ 完工门恒关、邀请恒不注入，与今天（dw 不渲染 wg 协议块，`workgroupRunner.ts:111-114`）一致 |
| F6 | 快照损坏 | fail-open（不压制）⇒ 极端下可能泊人。异常态安全阀，D12 |
| F7 | 催办计数因文案变更重置 | §3.3，最多多催 3 轮，受 `max_rounds` 约束 |
| F8 | `persistGate` merge 漏 members | §3.5，设计门重点 |

## 8. 测试策略（哪些必写）

**纯函数预言（shared）**
- `workgroupHasHumanMember` 真值表：空数组 / 全 agent / 含 1 human / 全 human。
- `resolveCompletionGate(members, stored)` 四象限：`(无人工, true)→false`、`(无人工, false)→false`、`(有人工, true)→true`、`(有人工, false)→false`。
- `resolveClarifyEnabled` **不再存在**：加一条源码级断言（符号在 `packages/shared/src` 零命中），防止有人「善意」把它加回来。

**协议块（backend）**
- 三角色 × 有/无人工成员：无人工 ⇒ `not.toContain('<workflow-clarify>')`；有人工 ⇒ `toContain`。**这条直接改写 `rfc180-workgroup-autonomous.test.ts:103-115` 与 `rfc164-workgroup-core.test.ts:384-408/804-813`**（后者现在断言「默认配置下三角色都有邀请」，其 fixture 花名册无人工成员 ⇒ 改造后必须翻成「都没有」，并另加一条有人工成员的正向用例）。
- `wgHostRolePorts` ⇄ `renderWgProtocolBlock` 的 mirror lock（`workgroup-host-output-isolation.test.ts:100-105`）保持绿——其 fixture 用 `autonomous:true` 来避开邀请块，改为「花名册无人工成员」。

**引擎（backend）**
- 无人工组：leader 硬发反问 → 驳回 → 重提示 → 耗尽 drop-and-continue → 收敛 done；worker 同路径 → assignment failed；**全程任务不进 `awaiting_human`**。
- 有人工组：leader 反问 → `awaiting_human` reason=`leader-clarify` → 答 → 续跑 → done，且 `__wg_leader__` run 数 = 1（不膨胀，沿用 `rfc187-workgroup-e2e.test.ts:151-209`）。
- 完工门：无人工 + `completionGate=true` ⇒ `{kind:'done'}`；有人工 + `true` ⇒ `{kind:'awaiting_gate'}`。
- 催办统一：**有人工成员**的 leader_worker 组空转 ⇒ 也走 `{kind:'leader-nudge'}`（这是 G4 的新行为，`rfc187-continue-no-dispatch.test.ts:91/96` 现锁的是「非自治立刻 park」，必须改）；到 `WG_LEADER_IDLE_NUDGE_LIMIT` ⇒ `awaiting_human` reason=`leader-idle`。
- 兜底：触顶 `max_rounds` 且有产出 ⇒ `max-rounds-wrapup` park（D3，`rfc187-maxrounds-wrapup.test.ts` 保持绿，fixture 换判据）。

**中途转移（backend，路由级）**
- 加入第一个人工成员 ⇒ 下一轮 `clarifyEnabled=true`（可用 fake hook 断请求参数）。
- 移除最后一个人工成员且任务卡在 clarify park ⇒ 单事务遣散（session/round canceled、中介 run canceled + `error_message='wg-clarify-disabled'`、assignment 重排队、resume）；仍有其他人工成员时 ⇒ no-op；gate park 不被误遣散；`dynamic_workflow` 免疫。
- 并发陈旧答案提交 ⇒ 409 / 幂等，不 mint 重跑。
- `ConfigPatchSchema` 拒绝 `autonomous` 字段（rejects unknown / 忽略且不落库，按实现取其一并锁死）。

**迁移（backend）**
- `0099`（或顺延号）replay：列已消失、历史 `wg-autonomous-dismissed` 行已回填。
- **改 migration 后必须跑完整 backend `bun test`**，不能只跑 migration 子集（journal↔files 不匹配会级联几千条 DB 测试红——见 per-user memory）。

**前端（vitest）**
- `WorkgroupForm`：无「全自动」Switch；无人工成员时完工门 Switch `disabled` 且 hint 为新 key；有人工成员时可点。
- `WorkgroupTaskConfigDialog`：暂存「移除最后一个人工成员」后完工门当场置灰；PUT body 不含 `autonomous`。
- 列表页：含人工成员的组显示「含人工」chip，纯 agent 组不显示。
- i18n：4 个旧 key 全仓零引用；新 key 双 bundle 对称（`i18n-keys-symmetry.test.ts` 自动覆盖）。
- `clarify.detail` banner：`sealedCause='wg-clarify-disabled'` ⇒ 新文案。

**源码锁（brittle，必须同步改，一处不改就红）**
`rfc181-autonomous-hardening.test.ts:345-395`（4 组）、`rfc187-clarify-continuation-revival.test.ts:176-181`、`rfc187-continue-no-dispatch.test.ts:106-111`、`rfc183-clarify-invite-accept-symmetry.test.ts:229/332-355`、`rfc186-envelope-followup-parity.test.ts:105-137`、`rfc164-workgroup-engine.test.ts:758-849`、`rfc200-source-lock.test.ts:67`、`rfc202-source-locks.test.ts:52-70`（含 i18n key 名）、`rfc187-zero-delta-done.test.ts:30-58`。

**回归防护命名**：新测试文件 `rfc206-human-derived-clarify.test.ts`（backend）/ `workgroup-human-derived-clarify.test.tsx`（frontend），文件顶端注释写明「锁 RFC-207：反问 / 完工门唯一判据 = 花名册是否含人工成员；`autonomous` 已删，任何把它加回来或让判据反转的改动应当在此红」。

## 9. 影响面清单（实现时对照勾选）

**shared**：`schemas/workgroup.ts`（判据 + 两个 resolve + 常量改名 + 删字段 ×2）、`schemas/workgroupRuntime.ts:52`、`prompt.ts:152/308-309/873`（注释）、`schemas/clarify.ts:459`（注释 + 值）。

**backend**：`db/schema.ts:496`、新 migration + `_journal.json`、`services/workgroups.ts:123/178/422`、`services/workgroupLaunch.ts:98`、`services/workgroupContext.ts:457`、`services/workgroupRunner.ts:583-600/977-989/1121/1520/1536-1544/1813/1828-1833/1989`、`services/workgroupWake.ts:100-117/308-311/315-322`、`services/workgroupLifecycle.ts:166-181/208+/262`、`services/scheduler.ts:863-865/936-937/990-999`、`services/runner.ts:1266-1278`、`routes/workgroupTasks.ts:119/1038/1084/1212-1222`、`services/terminalSweep.ts:25-28`（注释）。

**frontend**：见 §6 表。

**docs**：`design/plan.md` RFC 索引加一行；`STATE.md` 顶部「进行中 RFC」→ 完工后转 Done + 已完成表加行。RFC-180 / RFC-181 索引行状态标注为被本 RFC **Superseded**（其 autonomous 开关部分；RFC-181 的硬压制机制被本 RFC 继承保留，措辞要区分清楚）。

## 10. 风险

| 风险 | 级别 | 缓解 |
|---|---|---|
| R1 判据漏改静默反转 | **高** | §1.2 破坏性签名变更（typecheck 强制） |
| R2 `persistGate` merge 漏 members ⇒ 成员变更被引擎覆盖 | **高** | §3.5，设计门重点核实 + 并发测试 |
| R3 源码锁一次性大面积改动（9 个文件）漏改 | 中 | 逐条对照 §8 清单；`bun run test` 全量跑 |
| R4 migration + journal 计数级联红 | 中 | 全量 backend `bun test`，不只跑子集 |
| R5 旧快照 `autonomous` 键导致 parse 失败 | 中 | 确认 `WorkgroupRuntimeConfigSchema` 非 strict；补一条「旧快照可 parse」测试 |
| R6 催办文案改动使在途任务计数重置 | 低 | §3.3 已界定，受 `max_rounds` 约束 |
| R7 列表 API 不返回 members ⇒ chip 无数据 | 低 | §6 实现时核实，必要时补字段 |
