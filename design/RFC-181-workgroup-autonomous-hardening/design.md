# RFC-181 工作组「全自动」硬化 —— design

## 0. 范围

三件事，全部围绕已落地的 `autonomous` 开关（RFC-180 `30bd6760`）：
- **A**：`autonomous` 进 per-task `ConfigPatchSchema`（中途可切换，对称 on/off，下一引擎 pass 即生效，房间加 `Switch`）。
- **C**：clarify 关闭时 host run 的自愿 `<workflow-clarify>` 被软驳回（hook 短路不建 session → runner 重提示重发 → 耗尽 drop-and-continue，绝不 park / 绝不因反问杀任务）。
- **D**：新建工作组 `autonomous` 默认 `true`（schema + 表单），已有组不动、**零 migration**。

不含 B（worker 反问不计 `max_rounds`）。零答题权 / free_collab 语义 / dynamic 改动。

## 1. 现状锚点（已核对源码，Read 逐行确认）

| 事项                                                         | 出处                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `autonomous` 启动冻结进任务 runtime config                   | `services/workgroupLaunch.ts:84-108`（`buildWorkgroupRuntimeConfig`，`:96` 透传 autonomous） |
| per-task 可 patch 字段集（**无 autonomous**）                | `routes/workgroupTasks.ts:91-103`（`ConfigPatchSchema`）                |
| patch 写任务 config + 落 system 变更消息                     | `routes/workgroupTasks.ts:861-884`（`nextConfig`→`workgroupConfigJson`）|
| 引擎主循环每轮重载 state（含 config）                        | `services/workgroupRunner.ts:514`（`for(;;)`）+ `:526`（`loadDbState`） |
| `resolveClarifyEnabled` 唯一使用点（只控 prompt 邀请注入）   | `services/workgroupContext.ts`（`renderWgProtocolBlock`）              |
| host run 三处调用（leader/worker/message-turn）              | `workgroupRunner.ts:962` / `:1149` / `:1290`                            |
| hook：clarify envelope → 建 session → 返回 `awaiting`        | `services/scheduler.ts:798-848`（`createClarifySession` 在 `:831`）     |
| hook：无 clarify 通道 → 返回 `failed:clarify-no-channel`     | `services/scheduler.ts:806-809`（dynamic 先例 `dynamicWorkflowRunner.ts:315-317`）|
| leader 失败分支：`clarify-questions-` 可重试、否则 `throw`   | `workgroupRunner.ts:971-990`（重试 `:982`，`throw` `:989`）             |
| worker 失败分支：立即标记 assignment failed（无重试）        | `workgroupRunner.ts:1167-1194`                                          |
| worker 协议违规（缺 wg_result）重试→耗尽 failed              | `workgroupRunner.ts:1210-1224`                                          |
| message-turn：非 done 即 return（天然 drop）                 | `workgroupRunner.ts:1297`                                               |
| gate/clarify resolve 纯函数（RFC-180）                       | `shared/schemas/workgroup.ts`（`resolveCompletionGate`/`resolveClarifyEnabled`）|
| `autonomous` 默认（现 false）                                | `shared/schemas/workgroup.ts`（`workgroupConfigFields.autonomous`）     |

## 2. 接口契约

### 2.1 A —— per-task 中途切换（`routes/workgroupTasks.ts`）

`ConfigPatchSchema`（`:91-103`）加：

```ts
autonomous: z.boolean().optional(),
```

`nextConfig`（`:861-867`）加透传 + `changes` 文案：

```ts
...(patch.autonomous !== undefined ? { autonomous: patch.autonomous } : {}),
// changes.push(`autonomous → ${patch.autonomous}`)
```

- ACL 不变（沿用该 PATCH 端点现有 task-member 校验）。
- 写 `tasks.workgroupConfigJson`（`:874-877`）→ 引擎下一轮 `loadDbState`（`workgroupRunner.ts:526`）读到新值：`renderWgProtocolBlock`（每轮 `:967/1154/1295` 用当轮 config）不再 push `WG_CLARIFY_BLOCK`、`resolveCompletionGate` 视 gate 为关、C 的 `clarifyEnabled` 变 false —— **中途即时生效，无需重启 daemon**。
- 对称：翻 off 恢复 clarify 邀请 + gate（resolve 纯函数已覆盖，无需新逻辑）。
- 落一条 system 变更消息（现有 `:878+` 已做，autonomous 复用）→ 该消息本身重新唤醒引擎。

#### 2.1a A2 —— autonomous 开启即遣散在途反问 park（**设计门 P0**）

**问题（Codex 设计门确认，已自证）**：只对"未来轮"设 `clarifyEnabled` **不足以解开一个当前正卡在反问上的任务**。一个 host run 发过 `<workflow-clarify>` 后：clarify session 处于 open、源 host run + assignment 停在 `awaiting_human`。此时 PATCH 翻 autonomous on 虽会 resume 引擎，但——

- leader park：`leaderParked = hostRuns.some(status==='awaiting_human')`（`workgroupRunner.ts:570`）→ `leaderRunning: ...||leaderParked`（`:579`）→ 引擎视 leader 仍在跑 → 下一 pass **重新 park**（`decideWorkgroupOutcome` running-with-empty-inflight → `awaiting_human` `:608-612`）。
- worker park：assignment 停 `awaiting_human` → `humanPending` → `awaiting_human`（`workgroupWake.ts:240-253`）→ 重新 park。

即：**翻 autonomous on 对"已经在反问 ping-pong 的任务"无效**——而这正是用户"反问停不下来→拨全自动"要解决的场景。故 A 必须在 false→true 转移时**遣散在途 clarify park**：

```
PATCH autonomous false→true  且  该任务存在 open clarify park：
  1. 遣散该任务所有 open clarify session（复用既有 clarify 取消/supersede 机制 →
     标记 canceled，杜绝陈旧答案回流 round-trip）。
  2. 解 park 被卡的 host run + assignment：
       worker/member：assignment awaiting_human → dispatched（原成员重派）/ open（fc 回收）；
                      parked host run 收终态（canceled）。
       leader：parked leader host run（awaiting_human）→ canceled → leaderParked 清零。
  3. resume 引擎（PATCH 现有 resume + system 消息重新唤醒）→ 重派的 agent 以
     clarifyEnabled=false 重跑 → 必产 wg_result/wg_decision → 任务推进，不再 park。
```

- 仅 false→true 触发（true→true / 无 open park 均 no-op）。off→on 之外的 patch 不动 clarify。
- **复用既有遣散路径**（勿新造 cancel）：与 task-cancel / RFC-058 round 被 supersede 时取消 clarify session 同源——实现时定位可复用的 abandon 调用（`clarifyRerunLedger`/`clarifyRounds` 的 review-superseded canceled 语义、或 task-cancel 的 clarify 清理）。
- 语义 = A2 是"对在途 park 的追溯式 C"（C 压新反问，A2 遣散旧反问 park），二者同一"别打扰我"意图。
- 时序：route 侧先遣散 + 解 park **再** resume（parked 态下引擎循环已退出，无并发 pass，route 变更安全，同现有 config-patch resume 模式）。

**前端**：`WorkgroupRoom` 配置区（已有的 per-task patch 通道，同 completionGate/maxRounds/switches）加一个「全自动」`<Switch>`（复用公共 `Switch`），拨动 → PATCH `{autonomous}`。i18n zh/en。

### 2.2 C —— clarify 硬压制（`workgroupRunner.ts` + `scheduler.ts`）

**请求契约**：`WorkgroupHostRunRequest` 加 `clarifyEnabled?: boolean`（缺省 = 现状 = 允许）。runner 三处调用点传 `resolveClarifyEnabled(config.autonomous ?? false)`：

```ts
// workgroupRunner.ts:962 / :1149 / :1290
clarifyEnabled: resolveClarifyEnabled(config.autonomous ?? false),
```

**hook 短路**（`scheduler.ts:798`，`createClarifySession` 之前）：

```ts
if (result.clarify !== undefined) {
  if (req.clarifyEnabled === false) {                      // NEW —— C 软驳回
    return {
      status: 'failed',
      outputs: {},
      errorMessage: `clarify-suppressed:${result.clarify.questions.length}`,
    }
  }
  const clarifyNodeId = findClarifyNodeForAgent(definition, req.nodeId)
  ...                                                       // 现状不变
}
```

> 用**独立前缀 `clarify-suppressed`**（不复用 `clarify-questions-`）—— 后者在 leader 耗尽时 `throw`（致命），而 C 要 drop-and-continue，二者收场不同，必须区分。dynamic（不传 `clarifyEnabled`）→ undefined → 现状 `clarify-no-channel` 不受影响。

**leader runner**（`workgroupRunner.ts:971-990`，失败分支加 `clarify-suppressed` 前置分支）：

```ts
if (msg.startsWith('clarify-suppressed')) {
  if (attempt < WG_PROTOCOL_RETRIES) {
    errorNotice =
      '- Ask-back is OFF in this autonomous group. Do NOT emit <workflow-clarify>.\n' +
      '  Proceed with your best judgment and emit wg_decision / wg_assignments as usual.'
    continue                                               // 重提示重发
  }
  return                                                   // 耗尽 → drop-and-continue（不 throw）
}                                                          // 该轮无派单/无宣告 → 下一 pass 走 idle→nudge 安全阀
if (msg.startsWith('clarify-questions-') && attempt < WG_PROTOCOL_RETRIES) { ... }  // 现状 malformed 不变
throw new Error(msg)
```

**worker runner**（`workgroupRunner.ts:1167`，`result.status === 'failed'` 分支内前置）：

```ts
if (result.status === 'failed') {
  const msg = result.errorMessage ?? 'run failed'
  if (msg.startsWith('clarify-suppressed') && attempt < WG_PROTOCOL_RETRIES) {
    errorNotice =
      '- Ask-back is OFF in this autonomous group. Do NOT emit <workflow-clarify>.\n' +
      '  Proceed and emit wg_result.'
    continue                                               // 重提示重发（worker 循环已有 attempt/errorNotice）
  }
  // 耗尽或其它 failed → 现状：标记 assignment failed + system 消息（drop-and-continue，不 park）
  await casAssignmentStatus(db, assignment.id, 'running', 'failed')
  ...
}
```

**message-turn**（`workgroupRunner.ts:1297`）：**无需改动**——hook 短路返回 `failed` → `if (result.status !== 'done') return` 天然 drop（fc DM 回复 best-effort，成员会被下一条相关内容重新唤醒）。

**净效果**：`clarifyEnabled=false` 时 clarify **绝不 park**；leader 滑入 idle→nudge→（到限）`awaiting_human` 安全阀；worker 该轮 assignment failed 浮出（fc 有界重开 `:1176-1191`）。`clarifyEnabled` 缺省 / true → 全路径现状不变（RFC-172/RFC-023 round-trip 不回归）。

### 2.3 D —— 新建默认全自动（`shared/schemas/workgroup.ts` + 表单）

`workgroupConfigFields.autonomous` 默认 `false → true`。

- 新建（form/API 缺省字段）→ autonomous=true。
- 前端新建表单「全自动」`Switch` 初值 ON（若表单 draft 默认派生自 schema 缺省则自动跟随；否则显式把 create-draft 初值置 true——实现时核对 `lib/workgroup-form.ts` 的 draft 初始化来源）。
- 编辑已有组：表单显示该组**存储值**（老组仍 false）。
- **已有组零回归**：不回改任何已存在行；DB 列默认保持 `0`（RFC-180 migration 0093）作为兜底——create 走 schema 缺省 true、DB 列默认仅在极端 omit 时命中（可接受的轻微不一致，不值一个 rebuild-table migration）。
- **无新 migration**：列已存在，D 只改应用层缺省 → `upgrade-rolling` journal 计数不变。

## 3. 数据流

```
【A 中途切换】房间 Switch → PATCH {autonomous} → tasks.workgroupConfigJson
   → 下一 for(;;) pass loadDbState 读新值
   → prompt(不 push clarify 邀请) + gate(resolveCompletionGate=off) + C(clarifyEnabled=false) 全生效

【C 硬压制】host run 发 <workflow-clarify> + clarifyEnabled=false
   → hook 短路(不 createClarifySession) 返回 failed:clarify-suppressed
   → leader/worker runner 重提示重发 →(耗尽) leader drop-and-continue→idle→nudge / worker assignment failed
   → 绝不 awaiting_human(park)

【D 新建默认】新建组缺省 autonomous=true → 启动 buildWorkgroupRuntimeConfig 冻结 true
   → 全程 clarify 邀请不注入 + gate 视为关 + C 硬压制 + leader-idle 自动 nudge
```

## 4. 与现有模块耦合点

| 模块                                            | 改动                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `routes/workgroupTasks.ts`                      | `ConfigPatchSchema` +`autonomous` + `nextConfig` 透传 + changes 文案（A）；false→true 时遣散 open clarify park + 解 park + resume（A2）|
| clarify 遣散复用（`clarifyRerunLedger`/`clarifyRounds`/task-cancel 清理）| A2 复用既有 clarify session 取消 + host run/assignment 解 park，不新造 cancel |
| `shared/schemas/workgroupRuntime.ts` 无需改      | `autonomous` 已在 runtime config（RFC-180）——A 只是让它可被 patch 覆盖       |
| `services/workgroupRunner.ts`                   | 3 调用点传 `clarifyEnabled` + leader/worker 失败分支加 `clarify-suppressed`（C）|
| `WorkgroupHostRunRequest` 类型                  | +`clarifyEnabled?: boolean`（C，缺省=允许）                                   |
| `services/scheduler.ts`                         | `runHostNode` `:798` 短路（C）                                                |
| `shared/schemas/workgroup.ts`                   | `workgroupConfigFields.autonomous` 默认 true（D）                            |
| `components/workgroup/WorkgroupRoom.tsx`（配置区）| +「全自动」`Switch`（A）                                                      |
| `lib/workgroup-form.ts` / `WorkgroupForm.tsx`   | 新建 draft autonomous 初值 true（D，核对 draft 初始化来源）                   |
| i18n（zh/en）                                    | 房间全自动开关 label/hint + patch 变更文案                                    |

## 5. 失败模式

- **中途 on 但任务已卡在 clarify park（A2 覆盖，设计门 P0）**：见 §2.1a——false→true 必遣散 open clarify session + 解 park + resume，否则翻 on 对"正在反问的任务"无效（重新 park）。测试锁"翻 on 遣散在途 park、任务解卡推进、无陈旧答案回流"。
- **中途 on 但 leader 已 declaredDone 泊在 awaiting_review**：A 翻 on 后 `resolveCompletionGate` 变 false，但任务已 `awaiting_review`（gate holder run 已 mint）。设计取舍：**A 不追溯已开的 gate**（翻 on 只影响后续判定）；用户仍可用 gate 确认端点放行（现状），或翻 on 前先确认。测试锁"翻 on 不误改已 park 的 gate 状态"。gate park 与 clarify park 区分处理（A2 只遣散 clarify，不碰 gate）。
- **C 短路丢失同轮 wg_result**：协议一个 envelope 非 clarify 即 output，agent 不会同时产 clarify + wg_result；短路返回 `outputs:{}` 无损（测试锁"纯 clarify envelope"）。
- **C leader 耗尽 drop 后 leader run 行状态**：leader host run 行已 mint（`:944`），drop-and-continue 前**必须**把该 run 收成**终态 `failed`**（非 fatal——不 `throw`、不 reportFatal；带 clarify-suppressed 说明），否则残留 `pending`/`running`/`awaiting_human` 会让下一 pass 误判 leaderRunning/leaderParked 卡死。终态 failed 仍被 `countRoundsUsed` 计入（非 canceled、非 wg-gate）→ 该轮照常计入 `max_rounds`，随后 outcome pass 走 leader-idle→nudge。**这是 C 实现的关键守卫**，专测：耗尽后 leader run=failed、引擎继续到 idle→nudge，不 hot-loop、不僵死、不 park。
- **D re-import 老组 YAML（无 autonomous 字段）**：按新缺省 true 落地（视为"现在新建一个组"，符合 D 意图）；文档记明。
- **dynamic_workflow**：不传 `clarifyEnabled`（undefined）→ hook 现状 `clarify-no-channel` 不变；D 的 autonomous 缺省对 dynamic 无副作用。
- **prompt 隔离**：`clarifyEnabled` / autonomous 只入控流 / hook / UI，绝不进 `compose*Prompt` 归属信息。

## 5.1 与 RFC-182 的协同（2026-07-14 接管修订）

- **排期**：本 RFC 先行单 PR；RFC-182（回合卡 / 会话历史 / presence）三 PR 随后。共享文件 `WorkgroupRoom.tsx` 触点错开：本 RFC 只动 mid-run 配置弹窗（`WorkgroupTaskConfigDialog`，T3 Switch）；182 动消息流 / 花名册 / aside / drawer 接线，不碰弹窗。
- **可视化分工**：本 RFC 的 C / A2 只保证引擎收场与 run 行终态正确（failed / canceled + `clarify-suppressed:*` errorMessage、leader 耗尽 run 终态化守卫 §5）；「用户看得见」由 182 承接——runHistory 后端派生 `note:'clarify-suppressed'`、回合卡 / 执行记录展示「反问已压制」辅注、`awaiting_human`（clarify park）在 presence / 回合卡显示「等待回答」、A2 遣散后的 canceled run 以历史卡留痕。本 RFC 除 T3 Switch 外零新 UI。
- **前缀契约共享锁**：`clarify-suppressed` 前缀测试在本 RFC（hook 短路 / leader / worker 收场）与 182（note 派生）各有一条，注释互链，改前缀两处同红。

## 6. 测试策略（§测试策略）

必写 case：

1. **A schema/patch**：`ConfigPatchSchema` 接受 `autonomous`；PATCH 后 `workgroupConfigJson.autonomous` 更新 + 落 system 变更消息 + changes 文案；对称 on/off。
2. **A 引擎即时生效**：任务运行中 patch autonomous on → 下一 pass `renderWgProtocolBlock` 无 `WG_CLARIFY_BLOCK` + gate resolve=off + `clarifyEnabled=false`；patch off → 全恢复。
2a. **A2 遣散在途 park（设计门 P0）**：任务卡在 clarify park（leader 与 worker 两态各一例）时 patch autonomous false→true → open clarify session 被 canceled + parked host run/assignment 解 park + resume → agent 以 clarifyEnabled=false 重跑推进、任务不再 `awaiting_human`；陈旧 clarify 答案回流被拒（session 已 canceled）；无 open park 时 A2 no-op；true→true no-op；gate park 不被 A2 误遣散。
3. **C hook 短路**：`clarifyEnabled=false` + host run 产 clarify → `runHostNode` 返回 `failed:clarify-suppressed:*`、**不** `createClarifySession`；`clarifyEnabled` 缺省/true → 现状 `awaiting` + 建 session（不回归）。
4. **C leader 收场**：suppressed → 重提示重发；耗尽 → drop-and-continue（run 收终态、不 `throw`、不 park）→ 下一 pass idle→nudge；malformed `clarify-questions-` 仍 `throw`（不误伤）。
5. **C worker 收场**：suppressed → 重提示重发；耗尽 → assignment failed（不 park）；fc 有界重开仍生效。
6. **C message-turn**：suppressed → turn 被 drop（`!==done→return`），不建 session、不 park。
7. **C 三 role 覆盖 + 非全自动不回归**：leader/worker/fc_member 全路径；`clarifyEnabled=true` 下 RFC-172 member-clarify round-trip 正常。
8. **D 默认**：`workgroupConfigFields` parse 缺省 autonomous=true；新建组 autonomous=true；**已有组（显式 false）行为不变**（回归锁）；前端新建表单 Switch 默认 ON、编辑老组显存储值。
9. **D 无 migration**：`upgrade-rolling` journal 计数不变（不新增迁移）。
10. **前端**：房间「全自动」`Switch` patch 往返 + i18n 对称；新建表单默认 ON。

Codex 设计门：批准前跑，findings 全折再请用户批准。
