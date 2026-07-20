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
 * RFC-207 —— 这个提问方现在**能不能**反问。三条件串联（§3.7.2）：
 *   ① 冻结花名册里有人工成员（§1.1 判据）
 *   ② 该提问方的反问次数未用满（§3.6，按 clarify_sessions 真实提问记录计数）
 *   ③ 该提问方没有被人喊停（§3.7，task_node_clarify_directives 的 asker-key 行）
 * asker key 由 wgClarifyAskerKey(nodeId, shardKey) 归一化（§3.6.3）。
 * 读 tasks.workgroup_config_json（引擎与中途 PATCH 的共同事实源），每次调用
 * 当场求值，故中途增删成员 / 改预算 / 喊停，下一次判定即生效（D9）。
 * 快照缺失 / 不可解析 ⇒ 视为允许（不压制），与旧 isTaskAutonomous 的兜底同向：
 * 异常态下让人来看是安全阀，不是打扰（D12）。
 */
export async function resolveWgClarifyAllowed(
  db: Db,
  taskId: string,
  nodeId: string,
  shardKey: string | null,
): Promise<boolean>
```

**这是全仓唯一的求值出口**，派发期与 envelope 期都走它——不是两处各自算一遍再祈祷一致（二轮设计门 P1 的教训）：

| 时点 | 调用方 | 用途 |
|---|---|---|
| 派发期 | `workgroupRunner.ts` 三个 turn（`:1518-1520` / `:1807-1813` / `:1987-1989`） | 算一次，**同时**喂给 `renderWgProtocolBlock(..., clarifyAllowed)` 与 `clarifyEnabled` |
| envelope 期 | `scheduler.ts:863-865` `clarifySuppressed` | 取反，**并叠加 §3.4a 的派发期地板** |
| envelope 后补偿 | `scheduler.ts:936`（late-suppress）、`:990`（TOCTOU 补偿） | 同上 |
| 引擎重入 | `workgroupRunner.ts:977-989` 不变式重申 | 只关心「花名册已无人」这一维（遣散只针对成员归零，不因预算/停止而遣散在途 park） |

> **注意最后一行的差异**：预算耗尽 / 被喊停**只影响新反问**，不遣散已经开着的 park——人已经被问了，答案还是要收。只有「花名册里最后一个人被移走」才遣散（D7），因为那时确实没人能答了。

`dismissOpenClarifyParksForAutonomous` → **`dismissOpenClarifyParks`**（`workgroupLifecycle.ts:208+`）。事务内容不变：clarify_sessions + clarify_rounds 双表 canceled、中介 park run canceled、assignment `awaiting_human→dispatched/open` 重排队（`WORKGROUP_ASSIGNMENT_TRANSITIONS` 的两条 A2 边保留）。

## 2. 判据接线点全表

| # | 位置 | 现状 | 改为 |
|---|---|---|---|
| 1 | `workgroupContext.ts:457` | `if (resolveClarifyEnabled(config.autonomous ?? false))` push 邀请块 | **改为使用调用方传入的 `clarifyAllowed`**（`renderWgProtocolBlock` 新增该参数），不再自行从 config 推导——§3.7.2 二轮设计门 P1 |
| 2 | `workgroupRunner.ts:1518-1520` leader turn | `renderWgProtocolBlock('leader', config, nonce)` + `clarifyEnabled: resolveClarifyEnabled(...)` | 先算一次 `clarifyAllowed`（花名册 ∧ 预算 ∧ 未被停），**同时**喂给 renderer 与 `clarifyEnabled` |
| 3 | `workgroupRunner.ts:1807-1813` assignment turn | 同上 | 同上（asker key = `asg:<assignmentId>`） |
| 4 | `workgroupRunner.ts:1987-1989` message turn | 同上 | 同上（asker key = `mem:<memberId>`，§3.6.3） |
| 5 | `scheduler.ts:863-865` | `clarifySuppressed: () => isTaskAutonomous(db, taskId)` | `clarifySuppressed: () => req.clarifyEnabled === false ? true : !(await resolveWgClarifyAllowed(db, taskId, req.nodeId, runShardKey))`——**派发期 false 是压制地板**，见 §3.4a（`req.clarifyEnabled !== undefined` 的 wiring 条件不变，它只是「这是 wg host run」的标记；`runShardKey` 已在 `:797-804` 查出） |
| 6 | `scheduler.ts:936-937` late-suppress | `await isTaskAutonomous(...)` | 同 5 的取反式 |
| 7 | `scheduler.ts:990-999` TOCTOU 补偿 | 同上 + `dismissOpenClarifyParksForAutonomous` | 同上 + `dismissOpenClarifyParks` |
| 8 | `workgroupWake.ts:308-311` 完工门 | `resolveCompletionGate(input.config.autonomous ?? false, input.config.completionGate)` | `resolveCompletionGate(input.config.members, input.config.completionGate)` |
| 9 | `workgroupRunner.ts:1121` done 分支复检 | 同上 | 同上 |
| 10 | `workgroupWake.ts:315-322` leader 空转 | `if (autonomous) { nudge<LIMIT ⇒ leader-nudge }` 否则直接 park | **删条件**：恒 `nudges < WG_LEADER_IDLE_NUDGE_LIMIT ⇒ leader-nudge`，否则 park `leader-idle` |
| 11 | `workgroupRunner.ts:977-989` 重入不变式 | `(rec.config.autonomous ?? false) && mode !== 'dynamic_workflow' && 有 open session ⇒ dismiss` | `!workgroupHasHumanMember(rec.config.members) && mode !== 'dynamic_workflow' && 有 open session ⇒ dismiss`——**只看花名册这一维**，预算耗尽 / 被喊停不遣散在途 park（人已经被问了，答案还是要收，§1.3 表末注） |
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
- `hadHuman && !willHave`（移除最后一人，D7）：`dismissOpenClarifyParks(db, taskId, mode)` + `kickIfParked` 解卡 + resume，复用 RFC-181 A2 的编排（`dynamic_workflow` 免疫；遣散后新鲜状态复读 kick + 2.5s 延迟二次 kick 防搁浅）。`changes[]` 追加人类可读行。

  **⚠️ 二轮设计门 P1——「同一事务」在现状里是假的。** 已核实：配置 `dbTxSync` 在 `workgroupTasks.ts:1197` 就提交了，遣散在 `:1217` 才调用，而 `dismissOpenClarifyParksForAutonomous` **自己另开** `dbTxSync`。RFC-181 A2 声称的「与答案提交串行化 ⇒ 陈旧答案 409 / 不 mint 重跑」在这个缝里并不成立：若答案恰好在两者之间提交，它会把 round 置 `answered` 并 mint continuation，随后遣散已看不到 `awaiting_human` 行。只换触发条件会把这个缺陷一并继承，**AC5 的保证是空头支票**。

  处置：让「配置写入 + 遣散」整体持有**答案提交侧同一把锁**——`getTaskQuestionWriteSem(taskId)`（`services/taskWriteLocks.ts:61`；答案路径经 `clarifySeal.ts:458` 持有它）。注意两点：① 它是**非重入** `Semaphore(1)`，遣散原语内部不得再次获取（`clarifyAutoDispatch.ts:17` 已记录 `sealRoundQuestions` 是「获取后即释放」的模式）；② 模块文档规定的锁序是 A(`getTaskWriteSem`) ≻ B(本锁)，本处只取 B、不持 A，不构成环。备选方案是把遣散改造成 tx-aware（接受外部 tx），但那要改 RFC-181 的既有原语签名，**优先取加锁方案**。
- 其余组合 no-op。**完工确认门的 park 不被遣散**（gate park 与 clarify park 分开，同 RFC-181）。

替换掉现有的 `patch.autonomous === true && stored !== true` 触发条件（`workgroupTasks.ts:1212-1222`）。

### 3.4a 派发期地板：加人不得让「本轮没被邀请」的 turn 反问（**Codex 设计门 P1**）

活判据（`resolveWgClarifyAllowed`）单独用会破坏 invite/accept 对称性：一个在**不允许反问**时起跑的 turn，其 prompt 里根本没有邀请块；若此时状态翻转（加入第一个人工成员、调大预算、撤销喊停），活判据立刻返回「允许」，而 `scheduler.ts` 只按 `req.clarifyEnabled !== undefined` 决定要不要接线——于是**这个从未被邀请的 turn 硬发的 `<workflow-clarify>` 会被接受并建 session、把任务泊住**。这既违反 §3.4 声明的「下一轮起生效」，也正是 RFC-183 要守的「邀请⟺接受」对称契约。

因此两个方向必须分别由不同的时点判定：

| 方向 | 判定时点 | 理由 |
|---|---|---|
| **允许 → 不允许**（人被移走 / 预算被调小 / 被喊停） | envelope 到达时的**活 DB 读** | 起跑时能问、落地时不能了 ⇒ 必须当场压住（RFC-181 C 的 TOCTOU 论证原样成立） |
| **不允许 → 允许**（加入第一个人 / 调大预算 / 撤销喊停） | **派发期快照**（`req.clarifyEnabled`）为地板 | 该轮 prompt 没有邀请块，它就不该问；状态翻转从**下一轮**起才让 agent 被邀请 |

即：`suppressed = (dispatchClarifyEnabled === false) || liveSuppressed`。派发期地板与活读合围，才把两个方向都关严。测试须显式覆盖「无人工起跑 → 中途加人 → 该 turn 硬发 clarify 仍被驳回、任务不 park；下一轮才拿到邀请块」。

### 3.5 `persistGate` 的并发覆盖面（**已核实，无需改动**）

`workgroupRunner.ts:583-607` 的 reload-and-merge 事务当初是为了「引擎写整份 JSON 时别覆盖掉并发的 `autonomous` PATCH」。`autonomous` 删了之后，判据载体变成 `members`，同一类竞态（引擎写 gate 的同时用户在删人）看似照样存在——**但已核实不成立**：该事务重读整行 JSON 作 `base`，只覆盖 `gate` 一个键（`:605` `JSON.stringify({ ...base, gate })`），**没有字段白名单**，故 `members` 天然被保留。

全仓 `workgroup_config_json` 的写入口只有四处：`task.ts:1666`（启动插入）、`workgroupRunner.ts:605`（本节，reload-merge）、`routes/workgroupTasks.ts:1088`（配置 PATCH，同样 reload-merge）、`task.ts:2118`（dynamic_workflow 的 phase swap，本 RFC 不涉及）。**无需改代码**，但要补一条并发回归测试锁住「整份 merge」这个性质——防止未来有人把它优化成字段白名单而静默丢掉成员变更（表现为「删了人却还在问」）。

### 3.6 反问预算（G8 / D14 / D16）

#### 3.6.1 取证：今天为什么真的会无限

| 路径 | 现有天花板 | 出处 |
|---|---|---|
| lw · **worker** 反问 ping-pong | **零**。asking run 与 clarify-answer 续跑都是 `__wg_member__` 行，lw 的 `countRoundsUsed` 只数 `__wg_leader__`；且 parked worker 进 `busyMemberIds` ⇒ leader 不被唤醒 ⇒ 全任务轮数冻结 | `workgroupRunner.ts:673`、`workgroupWake.ts:150-152/201-205` |
| lw · **leader** 反问 | 有界：一次问答吃 2 轮（asking + 续跑），但 `maxRounds` 默认/上限均 1000 | `workgroupRunner.ts:676-677/1463-1468`、`schemas/workgroup.ts:106-107` |
| fc · 成员反问 | 有界（续跑计入 COUNT） | `workgroupRunner.ts:684-689` |
| 代际上限 | **全仓不存在**（`MAX_CLARIFY*` / `CLARIFY_*_LIMIT` 零命中；`createClarifySession`、`priorDoneGenerationsForRun` 均为纯计数） | `clarify.ts:120-230`、`scheduler.ts:6713-6739` |
| `maxDurationMs` | **反向有害**：park 期不可见（只扫 `running`），`startedAt` 不重置 ⇒ 人答完首个 tick 秒杀 | `limits.ts:34/76-83`、`task.ts:1010-1018`、`tests/scheduler-audit-gap1-limits-resume-startedat.test.ts:183-217` |
| 「停止反问」 | 工作组内 **no-op**：directive 行写得进去，host 路径写死 `delegated` 且从不读表 | `clarifySeal.ts:467-474` vs `scheduler.ts:862`（唯一读取点 `scheduler.ts:3190` 只服务普通节点） |

#### 3.6.2 计数载体（**二轮设计门 P1 返工**：不能复用 `askingGeneration`）

初稿想直接复用 `scheduler.ts:960-970` 已经算好的
`askingGeneration = priorDoneGenerationsForRun(...).length`。**这是错的**——已核实
`priorDoneGenerationsForRun`（`scheduler.ts:6713-6735`）统计的是同一
`(taskId, nodeId, iteration, shardKey)` 下**所有** `done` 顶层 run，不是「问过几次」：

- **assignment 侧**大致等价（一张派单内每个 done run 基本对应一次提问），巧合而已；
- **leader 侧完全错位**——leader 每个正常回合都是一行 `__wg_leader__` / shardKey `null` 的 done run。预算取 3 时，leader 只要先跑完 3 个**根本没反问**的正常回合，它的**第一次**反问就会被判为「预算已耗尽」。

因此预算必须按**真实提问记录**计数：`clarify_sessions`（每次 `createClarifySession` 一行，带
`sourceAgentNodeId` + `sourceShardKey`）。计数发生在建 session 之前，天然不含本次。

#### 3.6.3 提问方键（asker key）——预算与「停止」共用的稳定身份

shardKey 直接当身份会漏一条路：**message turn 也能反问**，而它的 shardKey 是
`msg:${memberId}:${maxMessageId}`（`workgroupRunner.ts:1951`）——**每被新消息唤醒一次就是一个新 shardKey**，预算永远从 0 开始；而在 `leader_worker` 下这些 member run 又不计入 `maxRounds`，等于留了一条可持续反问的旁路（二轮设计门 P2）。

故定义一个纯函数做归一化，**预算计数与 stop directive 共用同一个键**：

```ts
/** RFC-207 —— 反问的「提问方」稳定身份；预算与停止指令共用。 */
export function wgClarifyAskerKey(nodeId: string, shardKey: string | null): string {
  if (nodeId === WG_LEADER_NODE_ID) return 'leader'          // 单例，跨整个任务
  if (shardKey === null) return 'leader'                      // 防御：host 侧不该出现
  if (shardKey.startsWith('msg:')) return `mem:${shardKey.split(':')[1]}` // 成员级，堵旁路
  return `asg:${shardKey}`                                    // 派单级，换派单即重置
}
```

（`msg:` 前缀与 `split(':')[1]` 取 memberId 的约定源码里已在用：`workgroupRunner.ts:1036/1042/1404-1406`。）

| 提问方 | 键 | 计数范围 / 重置 |
|---|---|---|
| leader | `leader` | 整个任务累计，不重置 |
| 某张派单 | `asg:<assignmentId>` | 该派单内累计；**换一张派单自动从 0** |
| 成员的消息轮 | `mem:<memberId>` | 该成员累计，**不随消息 id 重置**（这是修掉的旁路） |

预算检查：`countClarifySessions(taskId, askerKey) >= clarifyBudget` ⇒ 走压制。位置在
`createClarifySession` **之前**，与 §3.4a 的派发期地板、活判据同一处短路点，保证「不建 session、不 park」。

> **语义说明**：派单侧靠换派单天然重置；leader / 成员消息轮是累计不重置——问满就不能再问了。这比「连续 N 次无进展则截断」可预测得多，也无需定义什么算「进展」。觉得紧就把组定义的数字调大（D16）。

#### 3.6.3 到限行为

复用 RFC-181 C 的软驳回通道，**不新增失败模式**：驳回 → 重提示（文案改述为「反问次数已用尽，请自行决断并 emit `<workflow-output>`」）→ `WG_PROTOCOL_RETRIES` 耗尽后 leader `drop-and-continue`、worker 该轮 `failed`。**绝不 park、绝不因反问杀任务。**

#### 3.6.4 组定义字段

`workgroupConfigFields` 新增 `clarifyBudget: z.number().int().min(0).max(50).default(3)`，随 `WorkgroupSchema` / `WorkgroupRuntimeConfig` 一同落库与冻结快照。

- `0` = 即使有人工成员也完全不许反问（与「无人工成员」同效，但语义是显式选择）。
- 与「有无人工成员」判据是**串联**关系：先看有没有人（无人 ⇒ 恒关），再看预算（有人但问满 ⇒ 关）。
- 与 `autonomous` 不同，它**不是**「要不要人参与」的第二事实源，而是「人参与时能被打扰多少次」的量——不违反本 RFC 删开关的初衷。
- 默认值走 `.default(3)` 还是 handler 侧 coalesce，须遵循 `autonomous` 踩过的坑（RFC-181 设计门 P1）：该字段对象被 Create **和** full-replace Update 共用，schema 默认会让「省略该字段的 PUT」静默改写既有组。**因此照抄 `fanOut` / 旧 `autonomous` 的做法：schema 里 optional 不给 default，create 侧 `?? 3`、update 侧 `?? existing`。**
- 中途可调：进 per-task `ConfigPatchSchema`（与 `maxRounds` 同类），下一轮引擎 `loadDbState` 生效。

#### 3.6.5 旧任务快照的回退（**二轮设计门 P1**）

存量 `tasks.workgroup_config_json` 里**没有** `clarifyBudget`（migration 只给 `workgroups` 表加列，不改快照）。两个陷阱：

- 若 `WorkgroupRuntimeConfigSchema` 把它设成 **required**，升级后所有在途任务的 `loadDbState` 解析当场失败——比 autonomous 那次严重得多。
- 若只设 optional 而各读取点各自 `?? 3`，则**派发期与 envelope 期可能取到不同值**（有人漏写），重演本 RFC 一直在防的不对称。

处置：runtime schema 里 optional，并**只提供一个回退出口**——

```ts
export const WG_CLARIFY_BUDGET_DEFAULT = 3
export function resolveClarifyBudget(config: { clarifyBudget?: number }): number {
  return config.clarifyBudget ?? WG_CLARIFY_BUDGET_DEFAULT
}
```

所有读取点（派发期、envelope 期、房间展示）一律走它，禁止裸 `?? 3`。必配测试：**缺该字段的旧快照**能正常解析、且行为等同 budget=3。

### 3.7 打通「停止反问」（G9 / D15）+ 派单级粒度（用户 2026-07-20 拍板）

#### 3.7.1 现状：线already铺到门口，就差一个读取点

- 表 `task_node_clarify_directives`（`db/schema.ts:1660-1680`，migration `0064`）：PK `(task_id, node_id)`，取值 `'continue' | 'stop'`。
- 写入方：答题时勾「提交并停止反问」⇒ `clarifySeal.ts:467-474` `setNodeClarifyDirective(..., askingNodeId, 'stop', ...)`；画布节点开关 ⇒ `routes/taskClarifyDirective.ts:46-77`。
- **路由守卫已经放行工作组节点**：`isAskingNodeInSnapshot` → `agentHasClarifyChannel` 只问「这个节点有没有 clarify 出边」，而 `buildWorkgroupHostSnapshot` 给 `__wg_leader__` **和** `__wg_member__` 都接了（`workgroupLaunch.ts:78-79`）。所以**今天从公开 API 就能给工作组写进一行 stop**——只是 host 路径从不读它（唯一读取点 `scheduler.ts:3189-3191` 只服务普通节点），写了等于没写。
- host 路径读它几乎零成本：`runShardKey` 已在 `scheduler.ts:797-804` 查出并用于 clarify 队列。

#### 3.7.2 接法：走 `clarifySuppressed`，不碰 `clarifyChannel`

**不要**把工作组的 `directive:'delegated'` 改成 `'stopped'`。`clarifyDispositionFor` 把 `'stopped'` 映射为 `'reject'`（`prompt.ts:210-226`），会让共享 runner 接管「拒绝」的措辞与判定，撞上 RFC-183 的对称性锁，也违背 `'delegated'` 的本意（邀请与判定归工作组协议块所有，`scheduler.ts:848-861`）。

正确接法是把「停止」并入**已有的三元压制条件**，两侧对称：

```
clarifyAllowed(asker) = hasHumanMember           // §1 判据
                     && askingGeneration < clarifyBudget   // §3.6 预算
                     && directiveOf(asker) !== 'stop'      // §3.7 人工喊停
```

- **派发期**（控「邀不邀请」）：`workgroupRunner.ts:1520/1813/1989` 的 `clarifyEnabled` 由该式求值。
- **envelope 期**（控「接不接受」）：`scheduler.ts:863-865` 的 `clarifySuppressed` 取该式取反，并保留 §3.4a 的派发期地板。

**⚠️ 二轮设计门 P1：光改 `clarifyEnabled` 不够。** 协议块由
`renderWgProtocolBlock(role, config, envelopeNonce)` 构造（`workgroupRunner.ts:1518`），而它内部
（`workgroupContext.ts:457`）只看 `config`——`clarifyEnabled` **根本不参与渲染**。若不一并改，
`budget=0` / 预算耗尽 / 该 shard 已被喊停时，**prompt 仍在明确邀请 agent 反问，随后 envelope 又把它驳回**，白白烧掉 `WG_PROTOCOL_RETRIES` 次重试，member 侧还会把该派单打成 failed。

因此把判据**显式传进 renderer**：`renderWgProtocolBlock(role, config, envelopeNonce, clarifyAllowed)`，
`workgroupContext.ts:457` 改成直接用传入值、不再自己从 config 推导。这样邀请与接受**同一个来源、同一次求值**，
对称性由构造保证而非靠两处各自算对。（连带：`rfc200-source-lock.test.ts:67` 锁的是
`renderWgProtocolBlock('leader', config, envelopeNonce)` 字面量，必须同步改。）

两侧同源 ⇒ invite⟺accept 对称不破；到限/被停后的收场完全复用 RFC-181 软驳回通道（文案分三种：无人可问 / 次数用尽 / 已被喊停）。

#### 3.7.3 shard 维度（表重建）

工作组所有成员派单共用一个 `__wg_member__` 节点 id，仅靠 `node_runs.shard_key` 区分。要做到「只停发问的那张派单」，`task_node_clarify_directives` 必须加 shard 维度。SQLite 改不了主键 ⇒ **重建式 migration**：

```sql
CREATE TABLE task_node_clarify_directives_new (
  task_id    TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  node_id    TEXT    NOT NULL,
  shard_key  TEXT    NOT NULL DEFAULT '',        -- '' = 节点级（非分片提问方）
  directive  TEXT    NOT NULL,
  set_by     TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (task_id, node_id, shard_key)
);
--> statement-breakpoint
INSERT INTO task_node_clarify_directives_new (task_id, node_id, shard_key, directive, set_by, updated_at)
  SELECT task_id, node_id, '', directive, set_by, updated_at FROM task_node_clarify_directives;
--> statement-breakpoint
DROP TABLE task_node_clarify_directives;
--> statement-breakpoint
ALTER TABLE task_node_clarify_directives_new RENAME TO task_node_clarify_directives;
--> statement-breakpoint
CREATE INDEX idx_task_node_clarify_directives_task ON task_node_clarify_directives(task_id);
```

- **用 `''` 哨兵而非 NULL**：SQLite 的 PRIMARY KEY 列在普通（有 rowid）表里**不隐含 NOT NULL**，用 NULL 会允许多行重复，主键形同虚设。列保持 `NOT NULL DEFAULT ''`，在 service 边界做 `shardKey ?? ''`（写）/ `'' → null`（读）转换，对外仍是全仓通行的 `string | null` 约定。
- **读取解析顺序**：先查该 shard 行，无则回落节点级（`''`）行。这让「停某一张派单」与「停这个节点全部」可以共存。
- **节点级 `continue` 必须清除该节点的 shard 行（二轮设计门 P2）**：否则出现无法恢复的死角——普通 fan-out 的某个 shard 在答题时被写入 stop 后，用户在画布上点「继续反问」只会写节点级 `continue`，而读取规则让 shard 行优先，于是**看着是继续、实际仍被停**。规则定为：写入节点级 `continue` 时，同事务 `DELETE` 掉该 `(task_id, node_id)` 下所有 shard 行（语义：节点级操作是「一键归位」）。写入节点级 `stop` 不必删（shard 行本就更严或同向）。工作组侧另有 §3.7.5 的 per-shard 恢复入口。
- 受影响的 service：`taskClarifyDirective.ts` 的 `getNodeClarifyDirectiveRow` / `getNodeClarifyDirective` / `setNodeClarifyDirective`（`onConflictDoUpdate.target` 加 `shardKey`）/ `listNodeClarifyDirectives`。三个生产读取点：`scheduler.ts:3189-3191`、`crossClarify.ts:500`、`clarifyMigration.ts:179`。
- **两条源码文本锁必然变红**、必须同步改：`rfc122-clarify-directive-dispatch.test.ts:547/569`（断言 `'getNodeClarifyDirectiveRow(db, taskId, node.id)'` 字面量）、`rfc123-clarify-directive-single-source.test.ts:394/405-407`（断言 `setNodeClarifyDirective(...)` 的确切调用形状）。

#### 3.7.4 写入侧规则与对普通任务的**已披露**影响

统一规则：**`clarifySeal` 按轮的 `askingShardKey` 写行**（`clarify_rounds.askingShardKey`，`schema.ts:1580`，今天被 `clarifySeal.ts:467-474` 丢弃），并经**同一个键函数**归一化后落库——预算与停止共用 §3.6.3 的 `wgClarifyAskerKey`，对非工作组节点是恒等（`shardKey ?? ''`）。逐场景：

| 提问方 | `askingShardKey` | 落哪一行 | 与今天相比 |
|---|---|---|---|
| 普通非分片节点 | `null` | 节点级 `''` | **不变** |
| 工作组 leader | `null` | `leader` | 新能力 |
| 工作组成员派单 | assignment id | `asg:<id>` | 新能力，满足「只停发问的那张」 |
| 工作组成员消息轮 | `msg:<mem>:<msgId>` | `mem:<mem>`（归一化） | 新能力；**不归一化就会每条消息换一个键**，停了等于没停（同 §3.6.3 的预算旁路） |
| **普通任务的 fan-out 分片节点** | shard key | 该 shard 行 | **有变化**：今天点 stop 会停掉该节点**全部**分片，改后只停这一片 |

最后一行是对 §2 目标 G7（非工作组零变化）的**一处有意让步**：它本质是个 bug 修复（停 shard 3 的问题不该顺带静音 shard 7），但确实是行为变化，**显式披露并配测试**，不藏在实现里。

画布节点开关维持节点级语义（读写 `''` 行），`listNodeClarifyDirectives` 仍返回 `Record<nodeId, directive>` 的节点级视图——避免动到普通任务画布的既有契约。

#### 3.7.5 恢复入口（用户拍板）

停止是**可撤销状态**，不是单向门。房间信息区显示「反问已停止」并给恢复按钮：

- 后端：房间响应（`routes/workgroupTasks.ts:363`）增补 `clarifyStops` —— **按 asker key 全量返回**（`leader` + 每张在途派单 `asg:*` + **每个成员 `mem:*`**）。只列 leader 与在途派单会漏掉消息轮的 `mem:*` 停止态，用户看不到也就撤不回（二轮设计门 P2）。`SetDirectiveBodySchema`（`routes/taskClarifyDirective.ts:28`）加可选 `shardKey`，复用同一路由写 `'continue'`。
- 前端：`WorkgroupRoom` 的信息区 / 对应派单卡片上显示状态 chip + 复用既有 `.btn--xs` 恢复按钮。**不新增配置开关**——它呈现的是当前状态，不是组的固有属性。

### 3.8 park 期间不计入 `maxDurationMs`（G10 / D17）

#### 3.8.1 现状取证

`tasks.startedAt` 全仓**只有一处写入**——建任务时 `task.ts:1654`；`resumeTask` / 调度器置 running / park 全都不碰它（`startedAt` 甚至不在 `TaskStatusUpdateExtra` 白名单里，`lifecycle.ts:290-300`，所以按 RFC-097 的守卫根本写不进去）。而 `limits.ts:77` 直接 `now - t.startedAt`。同时 `enforceLimits` 只扫 `status='running'`（`limits.ts:34`）。合起来：**park 期间不检查，但 park 时长被追溯计费**，人一答完的下一个 tick 就可能 `task-time-limit-exceeded`。

另外确认：**没有任何可查询的状态转移时间戳**——无 `task_events` 表；`recoveryEvents`（`schema.ts:2106`）只记系统动作，用户 resume / park 不写；`lifecycleAlerts` / `lifecycleRepairAudit` 都不是转移日志。所以 park 区间**无法从现有数据反推**，修复必须落列。

#### 3.8.2 取「累计运行时长」而非「平移 startedAt」

`tasks` 新增两列：

```
running_ms     INTEGER NOT NULL DEFAULT 0   -- 已累计的真实运行时长
running_since  INTEGER                       -- 本段 running 的起点；非 running 时为 NULL
```

写入**集中落在 `lifecycle.ts` 的 `writeStatus`**（`:411-423`，全仓唯一被允许直写任务状态的地方）——进入 `running` 时 `running_since = now`；离开 `running` 时 `running_ms += now - running_since`、`running_since = null`。放在这里而不是各调用点，是因为 `setTaskStatus`/`trySetTaskStatus` 有约 25 个调用点（`scheduler.ts:422/636/652…`、`task.ts:1925/1968/2045/2708`、9 个 `lifecycleRepair/options-*.ts`、`fusion.ts:1352`、`orphanReconcile.ts:108`、`shutdown.ts:46`、`routes/workgroupTasks.ts:808`），逐点改必漏。`running_ms | running_since` 需加进 `TaskStatusUpdateExtra` 白名单。

读取只改一处：`limits.ts:77` ⇒ `elapsed = running_ms + (running_since === null ? 0 : now - running_since)`。

**为什么不用「resume 时把 startedAt 往后平移」**：① `awaiting_human` 的 park **不写 `finishedAt`**，最常见的那种 park 根本没有可减的区间；② `startedAt` 还被 8 处按「任务何时开始」语义消费（任务列表排序 `task.ts:3060`、DTO `task.ts:1786/3612/3706`、GC 最小年龄 `gc.ts:139`、stuck 检测 `stuckTaskDetector.ts:272/309`、不变式扫描窗口 `lifecycleInvariants.ts:169`、两个复合索引 `schema.ts:833-834`），平移会静默污染全部。

#### 3.8.3 迁移与测试影响

- migration 追加两列（additive），并把**当前处于 `running` 的行**回填 `running_since = started_at`，否则它们平白获得一次赦免。
- `tests/scheduler-audit-gap1-limits-resume-startedat.test.ts:170-217`「恢复后的任务被立刻杀掉」**必须翻红并改写**——它锁的正是本次要修掉的 bug（该文件头部注释已预告了各修法会翻哪些断言）。`:143-168`（`startedAt` 保持不变）在本修法下**保持绿**，正是选它的理由之一。
- **最容易漏的一条**：`tests/limits.test.ts:74-81` 只 seed 了 `{ maxDurationMs, startedAt }`，改后 `running_ms=0` ⇒ 该用例不再触发取消。必须同步更新 seed 助手（`rfc097-cancel-wins.test.ts` 亦驱动 `enforceLimits`，同查）。

## 4. 数据与迁移

| 项 | 处理 |
|---|---|
| `workgroups.autonomous` 列（`db/schema.ts:496`，migration `0093`） | **DROP COLUMN**（先例：`0072_rfc130_drop_agent_readonly.sql` 等 10 个）。Drizzle schema 同步删字段 |
| `tasks.workgroup_config_json` 里存量快照带的 `autonomous` 键 | **不迁移**。**已核实** `WorkgroupRuntimeConfigSchema` 为裸 `z.object`（`workgroupRuntime.ts:40`，无 `.strict()`）⇒ 删字段后旧快照照常 parse、多余键被剥离。仍补一条「旧快照可 parse」测试 |
| `node_runs.error_message = 'wg-autonomous-dismissed'`（`workgroupLifecycle.ts:262`；经 `clarifyRounds.ts:251` 派生成前端 `sealedCause`） | 改写为 `'wg-clarify-disabled'` + migration 回填历史行，保持单一取值（D11） |
| `_journal.json` | 98 → 99 条；`upgrade-rolling.test.ts` 的 journal-count 断言 +1（标题 + 断言 + 注释三处） |

迁移 SQL（编号实现时复核——另有一个计划中的 `0099` drop `cached_repos.url`，若已被占用则顺延）：

单个 migration 文件，五段（**每段之间必须有 `--> statement-breakpoint`**，否则只有第一条被执行且静默）：

```sql
-- RFC-207 §1: autonomous 开关删除（判据改由花名册派生）
ALTER TABLE workgroups DROP COLUMN autonomous;
--> statement-breakpoint
-- RFC-207 §3.6: 反问预算
ALTER TABLE workgroups ADD COLUMN clarify_budget integer DEFAULT 3 NOT NULL;
--> statement-breakpoint
-- RFC-207 §3.8: 累计运行时长（park 期不计入 maxDurationMs）
ALTER TABLE tasks ADD COLUMN running_ms integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN running_since integer;
--> statement-breakpoint
UPDATE tasks SET running_since = started_at WHERE status = 'running';
--> statement-breakpoint
-- RFC-207 §D11: 遣散留痕字面量改名
UPDATE node_runs SET error_message = 'wg-clarify-disabled'
  WHERE error_message = 'wg-autonomous-dismissed';
--> statement-breakpoint
-- RFC-207 §3.7.3: directive 表加 shard 维度（SQLite 改不了主键 ⇒ 重建）
--   …CREATE _new / INSERT SELECT / DROP / RENAME / CREATE INDEX 五段，见 §3.7.3
```

**⚠️ 新增 `tasks` 列的连带影响（本仓踩过）**：drizzle 的 INSERT 会带上 HEAD 的**全部**列，因此任何「把 DB 冻结在旧 migration 上」的测试都会报 `no column named running_ms`。这类 fixture 必须改成显式列名的裸 SQL。`workgroups` 的两处列变更同理需排查。

**新增列的连带影响**：`tasks` 表加列会让「冻结在旧 migration 的 DB」测试红（drizzle INSERT 会带上 HEAD 的全部列）；本次加的是 `workgroups` 列，须确认没有测试在旧迁移点插 `workgroups` 行，若有则改成显式列名的裸 SQL fixture。

`--> statement-breakpoint` 必须有，否则只有第一条语句会被执行（静默）。

**升级期行为变化（D8 已接受，须在 STATE.md / release note 写明）**：
- 老的「非全自动 + 无人工成员」组 ⇒ 反问被关掉（本 RFC 的目的）。
- 老的「全自动 + 有人工成员」组 ⇒ 反问重新打开、完工确认门恢复其存储值（多数为默认 `true`）。

## 5. API / wire 变更

- `POST/PUT /api/workgroups`：body 不再接受 `autonomous`（zod 非 strict ⇒ 旧客户端多传会被**静默忽略**，不报错，可接受）；响应体不再返回该字段（`workgroups.ts:422` `rowToWorkgroup`）。
- `PUT /api/workgroup-tasks/:taskId/config`：`ConfigPatchSchema` 删 `autonomous`（`workgroupTasks.ts:119`）、changes 文案（`:1038`）、nextConfig 合并（`:1084`）。
- `GET /api/workgroup-tasks/:taskId/room`：返回的 `config` 不再含 `autonomous`（`workgroupTasks.ts:363`）。
- 无 WS 载荷变化（`autonomous` 从未进 WS 消息；配置变更仍以 `wg.message.created` 的 system 行体现）。

**升级窗口：已加载的旧前端会误报保存失败（Codex 设计门 P2）。** `reconcileWorkgroupSaveResponse`（`lib/workgroup-form.ts:310-327`）逐字段比对「提交的 payload」与「响应」，其中有一行 `(response.autonomous ?? false) !== (payload.autonomous ?? false)`。daemon 升级后、浏览器仍持旧 bundle 时：旧客户端照旧提交 `autonomous:true`（RFC-181 起新建组默认值），新服务端静默丢弃且响应不含该字段 ⇒ `false !== true` ⇒ 返回 `config-mismatch`。**保存其实成功了**，但界面报错、草稿不落定，刷新即恢复。这不是本 RFC 特有的问题，而是**任何 wire 字段删除的通用窗口**（本仓此前无版本偏移强制刷新机制）。

两个可选处置，**默认取 A**：
- **A（默认）**：不做过渡兼容。新 bundle 删掉该比较行；把这一次性窗口记录在案，并在实现时确认 `config-mismatch` 在 UI 上有可操作文案（提示「服务端已升级，请刷新页面」而非干瘪的失败）。理由：自托管单二进制、用户自己升级 daemon，刷新是自然动作；留一个死字段在 wire 上一个 release 更可能被永久遗忘。
- **B**：过渡期服务端**原样回显**客户端提交的 `autonomous`（不落库、不参与任何判定），下个 release 再删。零窗口，代价是 wire 上多留一个死字段 + 一个必须被记住的清理任务。

（真正的通用解是 build-version 偏移强制刷新，属独立 RFC，不在本范围。）
- **e2e 提醒**：`e2e/` 在 workspace typecheck 之外（见 per-user memory）。`e2e/task-wizard.spec.ts:145-200` 创建工作组时本就不传 `autonomous`，但它建的是**纯 agent 组**——改造后行为与今天（新建默认全自动）一致，理论零影响；仍须实跑确认。

## 6. 前端

| 位置 | 改动 |
|---|---|
| `components/workgroup/WorkgroupForm.tsx:150-157` | 删「全自动」`Switch` |
| `components/workgroup/WorkgroupForm.tsx:138-148` | 完工确认门 `disabled` 由 `value.autonomous` 改为 `!hasHumanMember`；hint 换 `workgroups.fieldCompletionGateNoHumanHint`。组件新增 prop `hasHumanMember: boolean`。**判据取 draft 花名册、不取 `group.members`（Codex 设计门 P2）**：该表单经 `WorkgroupContextPanel` 渲染，那里已有 `members.state.draft`，而 `group.members` 只是上一次服务端回执——加人/删人在途或保存失败时，用回执会让开关与「下一次保存要提交的花名册」相反。由 panel 把 draft 花名册透传下来 |
| `components/workgroup/WorkgroupTaskConfigDialog.tsx:181-203` | 同上；该弹窗**自带成员增删暂存**，`hasHumanMember` 必须随暂存的增删**实时**重算（勾了「移除最后一个人」时确认门当场置灰），否则用户看到的与提交后的语义不一致 |
| `components/workgroup/WorkgroupForm.tsx`（`maxRounds` 邻位） | **新增**「反问次数上限」`NumberInput`（复用既有 `<Field>`/`<NumberInput>`，与 `maxRounds` 同一分区同一风格），无人工成员时同样置灰 + 提示「本组没有人工成员，不会产生反问」 |
| `lib/workgroup-form.ts:89/102/136/287/324/508` | 删 `autonomous` draft 字段与 payload 分支；**加** `clarifyBudget`（同时补进 `reconcileWorkgroupSaveResponse` 的逐字段比对，否则新字段的保存回执校验有洞） |
| `lib/workgroup-room.ts:617/630/637/654/671` | 删 task config draft 字段与 patch diff |
| `routes/workgroups.tsx:114/141-143` | 「全自动」chip ⇒ **「含人工」chip**（仅当组含 human 成员时显示），i18n key `workgroups.humanMemberChip`；搜索文本同步。**设计取舍**：信号不能消失——用户需要在列表一眼看出「哪些组会来找我」，只是语义翻转。数据源**已核实**：`rowToWorkgroup`（`workgroups.ts:410-430`）返回 `members`，列表页直接可判 |
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

**反问预算（G8，backend）**
- `wgClarifyAskerKey` 真值表：leader / `asg:*` / `mem:*`（`msg:` 归一化）/ 防御分支。
- 计数边界：budget=3 ⇒ 前 3 次放行、第 4 次驳回；budget=0 ⇒ 首问即驳回。
- **二轮设计门 P1 的回归锁（必写）**：leader 先跑 **N 个不反问的正常回合**（N > budget），随后**第一次**反问**必须放行**——这条正是初稿「复用 `priorDoneGenerationsForRun`」会挂掉的用例。
- **二轮设计门 P2 的回归锁（必写）**：同一成员被**多条不同消息**依次唤醒，反问计数**不随消息 id 重置**（`mem:` 键生效）。
- **邀请⟺接受同源（二轮设计门 P1）**：budget=0 / 预算耗尽 / 已被喊停时，协议块里**不得**出现 `<workflow-clarify>`（否则就是「邀请了又拒绝」白烧重试、还会把派单打成 failed）。
- **旧快照回退**：缺 `clarifyBudget` 的 `workgroup_config_json` 能正常解析、行为等同 budget=3；全仓无裸 `?? 3`（源码锁）。
- leader / 派单 / 成员消息轮**各自独立计数**：leader 问满后，一张新派单仍可从 0 开始问。
- **新派单重置**：同一 worker 的第二张派单（新 assignment id）预算从 0 起算。
- 到限行为：驳回 → 重提示 → `WG_PROTOCOL_RETRIES` 耗尽 ⇒ leader drop-and-continue / worker 该轮 failed；**全程任务不进 `awaiting_human`**。
- 组定义字段：省略该字段的 full-replace PUT **不得**改写既有组的值（照抄 `fanOut` 的 optional-not-default 契约测试）；per-task PATCH 可中途调整且下一轮生效。

**停止反问（G9，backend + frontend）**
- 派单级：停 `asg:A` 后 `asg:B` 仍可反问；停 leader 不影响派单。
- 归一化：在成员消息轮上点停 ⇒ 写 `mem:<id>`，该成员后续**任何**消息轮都被停。
- **节点级 continue 清 shard 行（二轮设计门 P2）**：先在某 shard 上 stop、再走节点级 `continue`，断言该 shard **确实恢复**——不写这条就会留下「看着是继续、实际仍被停」的不可恢复死角。
- 普通任务：非分片节点 stop/continue 行为**逐字节不变**；fan-out 分片节点 stop 收窄为单片（§3.7.4 已披露的变化，配专测）。
- 恢复入口：房间 `clarifyStops` 覆盖 leader / `asg:*` / `mem:*` 三类；点恢复后下一轮可正常反问。

**移除最后一人 × 答案提交的竞态（G5，二轮设计门 P1）**
- 并发用例：遣散与答案提交同时发起 ⇒ 要么答案先落、要么被 409 拒绝；**绝不出现「答案已 mint continuation 而遣散扫不到 `awaiting_human` 行」**的中间态——这正是现状两段事务留下的缝，AC5 的保证靠这条测试兑现。

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

**回归防护命名**：新测试文件 `rfc207-human-derived-clarify.test.ts`（backend）/ `workgroup-human-derived-clarify.test.tsx`（frontend），文件顶端注释写明「锁 RFC-207：反问 / 完工门唯一判据 = 花名册是否含人工成员；`autonomous` 已删，任何把它加回来或让判据反转的改动应当在此红」。

## 9. 影响面清单（实现时对照勾选）

**shared**：`schemas/workgroup.ts`（判据 + 两个 resolve + 常量改名 + 删字段 ×2）、`schemas/workgroupRuntime.ts:52`、`prompt.ts:152/308-309/873`（注释）、`schemas/clarify.ts:459`（注释 + 值）。

**backend**：`db/schema.ts:496`、新 migration + `_journal.json`、`services/workgroups.ts:123/178/422`、`services/workgroupLaunch.ts:98`、`services/workgroupContext.ts:457`、`services/workgroupRunner.ts:583-600/977-989/1121/1520/1536-1544/1813/1828-1833/1989`、`services/workgroupWake.ts:100-117/308-311/315-322`、`services/workgroupLifecycle.ts:166-181/208+/262`、`services/scheduler.ts:863-865/936-937/990-999`、`services/runner.ts:1266-1278`、`routes/workgroupTasks.ts:119/1038/1084/1212-1222`、`services/terminalSweep.ts:25-28`（注释）。

**frontend**：见 §6 表。

**docs**：`design/plan.md` RFC 索引加一行；`STATE.md` 顶部「进行中 RFC」→ 完工后转 Done + 已完成表加行。RFC-180 / RFC-181 索引行状态标注为被本 RFC **Superseded**（其 autonomous 开关部分；RFC-181 的硬压制机制被本 RFC 继承保留，措辞要区分清楚）。

## 10. 风险

| 风险 | 级别 | 缓解 |
|---|---|---|
| R1 判据漏改静默反转 | **高** | §1.2 破坏性签名变更（typecheck 强制） |
| R2 `persistGate` merge 丢 members ⇒ 成员变更被引擎覆盖 | ~~高~~ **已核实不成立** | §3.5——整份 reload-merge、无字段白名单，`members` 天然保留；仅补一条性质回归测试 |
| R3 源码锁一次性大面积改动（9 个文件）漏改 | 中 | 逐条对照 §8 清单；`bun run test` 全量跑 |
| R4 migration + journal 计数级联红 | 中 | 全量 backend `bun test`，不只跑子集 |
| R5 旧快照 `autonomous` 键导致 parse 失败 | ~~中~~ **已核实不成立** | `WorkgroupRuntimeConfigSchema` 为裸 `z.object`（非 strict），未知键被剥离；仍补一条回归测试 |
| R6 催办文案改动使在途任务计数重置 | 低 | §3.3 已界定，受 `max_rounds` 约束 |
| R7 列表 API 不返回 members ⇒ chip 无数据 | ~~低~~ **已核实不成立** | `rowToWorkgroup` 返回 `members` |
| R8 预算计数器选错 ⇒ leader 首次反问即被误拒 | **高（二轮设计门 P1，已改设计）** | §3.6.2 改按 `clarify_sessions` 真实提问记录计数；配「N 个正常回合后首问必须放行」回归锁 |
| R9 邀请与接受不同源 ⇒ 邀请了又拒绝、白烧重试并打挂派单 | **高（二轮设计门 P1，已改设计）** | §3.7.2 把 `clarifyAllowed` 显式传进 `renderWgProtocolBlock`，构造上同源 |
| R10 遣散与答案提交跨两个事务 ⇒ AC5 的 409/不 mint 是空头支票 | **高（二轮设计门 P1，已改设计）** | §3.4 整体纳入 `getTaskQuestionWriteSem`；配并发测试 |
| R11 旧快照缺 `clarifyBudget` ⇒ 在途任务解析失败或两侧取值不一致 | **中（二轮设计门 P1，已改设计）** | §3.6.5 runtime schema optional + 唯一回退出口 `resolveClarifyBudget`，禁裸 `?? 3` |
| R12 消息轮 shardKey 每次都变 ⇒ 预算与停止双双失效的旁路 | **中（二轮设计门 P2，已改设计）** | §3.6.3 `wgClarifyAskerKey` 归一化到 `mem:<memberId>` |
| R13 shard 级 stop 无法被节点级 continue 清除 ⇒ 不可恢复死角 | **中（二轮设计门 P2，已改设计）** | §3.7.3 节点级 continue 同事务删该节点全部 shard 行 |
| R14 directive 表重建式 migration 出错 ⇒ 丢历史指令 | 中 | 五段各带 `--> statement-breakpoint`；INSERT SELECT 全量搬；配 replay 测试 |
