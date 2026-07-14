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
  单一加锁事务（与答案提交串行化）：
  1. 遣散该任务所有 open clarify session：clarify_sessions + clarify_rounds 双表
     同事务标记 canceled（CAS on session status——并发答案提交撞 canceled →
     409/幂等拒绝，杜绝陈旧答案回流 round-trip / 遣散半途 mint 重跑）。
  2. 终态化 park 载体 run（设计门勘误：合法 clarify 的「asking host run」已落
     done，park 在**中介 clarify run**〔createClarifySession 产生的
     clarifyNodeRunId〕上）：该 awaiting_human run 经 lifecycle 合法 CAS →
     canceled。实现期核对 leaderParked（`workgroupRunner.ts:570`）实际检测的
     run 载体，遣散后断言 leaderParked/humanPending 清零。
  3. 重排队 assignment：awaiting_human → dispatched（lw 原成员重派）/ open
     （fc 回收）。此二边在 WORKGROUP_ASSIGNMENT_TRANSITIONS
     （workgroupLifecycle.ts:21-34）中**现不合法**（awaiting_human 仅可 →
     running/failed/canceled）——本 RFC 显式扩表新增 A2 requeue 两边 + oracle
     表测（设计门 P1，不得绕 casAssignmentStatus 直写）。
  4. 事务提交后 resume 引擎（PATCH 现有 resume + system 消息重新唤醒）→ 重派
     agent 以 clarify 压制态重跑 → 必产 wg_result/wg_decision → 不再 park。
```

- 仅 false→true 触发（true→true / 无 open park 均 no-op）。off→on 之外的 patch 不动 clarify。
- **复用既有遣散原语但不复用其编排**：session 置 canceled 的语义与 task-cancel / RFC-058 supersede 同源（`clarifyRerunLedger`/`clarifyRounds`/`clarifySeal` 既有 canceled 通路）；A2 的新贡献是把「session 双表 + 中介 run + assignment 重排队」收进**一个**事务并与答案提交串行化（设计门 P1：防 crash 半态 / 防陈旧答案竞态 mint）。
- 语义 = A2 是"对在途 park 的追溯式 C"（C 压新反问，A2 遣散旧反问 park），二者同一"别打扰我"意图。
- 时序：route 侧先事务遣散 **再** resume（parked 态下引擎循环已退出，无并发 pass，route 变更安全，同现有 config-patch resume 模式）。

**前端**：`WorkgroupRoom` 配置区（已有的 per-task patch 通道，同 completionGate/maxRounds/switches）加一个「全自动」`<Switch>`（复用公共 `Switch`），拨动 → PATCH `{autonomous}`。i18n zh/en。

### 2.2 C —— clarify 硬压制（`workgroupRunner.ts` + `scheduler.ts`）

**请求契约（设计门修订）**：`WorkgroupHostRunRequest` 加 `clarifySuppressed?: () => Promise<boolean>`——runner 三处调用点（`:962/:1149/:1290`）注入"**即时判定器**"（重读任务当前 `workgroupConfigJson.autonomous` 再 `resolveClarifyEnabled`），**不传启动期快照布尔**。

> 设计门 P1-①（在途竞态）：run 在 autonomous=false 下起跑、用户中途翻 on 时，快照布尔仍是 true——A2 此刻无 park 可遣散（session 尚未建），随后该 run 发 clarify 仍会建 session 把任务泊住。判定必须发生在 **envelope 到达时**、以最新 config 为准；与 A2（遣散已建的 park）合围，才把"翻 on 即静音"关成硬保证。

**持久化语义（设计门 P1-②，本修订关键）**：合法 clarify 的现状收尾是 asking run 落 `done`、park 落在中介 clarify run 上——若只在 hook 层"内存改判 failed"，DB 里 asking run 仍是 done、无 errorMessage：RFC-182 的 note 派生无据、回合卡显示「完成」误导、广播的也是 done。因此压制分类**前移到 `runNode` 收尾期**（终态持久化之前）：

```ts
// runNode（runner.ts 收尾分类处，clarify envelope 分支；opts 新增可选判定器）：
if (result.clarify !== undefined && (await opts.clarifySuppressed?.()) === true) {
  status = 'failed'                                        // running→failed 合法转移
  errorMessage = `clarify-suppressed:${result.clarify.questions.length}`
  // 正常终态持久化 + 既有终态广播 lane；不建 session、不 mint 中介 clarify run、不 park
}
```

- `clarifySuppressed` 缺省（非 wg / dynamic）→ 不调用 → 现状不变（dynamic 仍走 `clarify-no-channel`）。
- hook（`scheduler.ts:798-848`）clarify 分支只在「未压制」时可达，`createClarifySession` 前**无需再加短路**——压制在 runNode 内已收掉，hook 拿到的就是 failed 结果，顺流进 leader/worker 失败分支。
- 宿主 run 行 = `failed` + `clarify-suppressed:*` 持久落库并广播——**这即 RFC-182 runHistory `note` 的派生依据**（前缀契约共享锁）。

> 用**独立前缀 `clarify-suppressed`**（不复用 `clarify-questions-`）—— 后者在 leader 耗尽时 `throw`（致命），而 C 要 drop-and-continue，二者收场不同，必须区分。

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

**净效果**：压制判定为真时 clarify **绝不 park**；leader 滑入 idle→nudge→（到限）`awaiting_human` 安全阀；worker 该轮 assignment failed 浮出（fc 有界重开 `:1176-1191`）。判定器缺省 / 判定为假 → 全路径现状不变（RFC-172/RFC-023 round-trip 不回归）。每次被压制尝试的宿主 run 都已以 failed 持久落库——RFC-182 回合卡对每次尝试都可见可回放。

### 2.3 D —— 新建默认全自动（`shared/schemas/workgroup.ts` + 表单）

`autonomous` 新建缺省 `false → true`，但**默认只作用于 create 路径**（设计门 P1）：

- `workgroupConfigFields` 同时被 `CreateWorkgroupSchema` 与 full-replace `UpdateWorkgroupSchema` 复用——若在共享字段上直接 `.default(true)`，一个**省略 autonomous 的老 PUT** 会把已有 false 组静默翻成 true，违背"已有组零回归"。因此：create schema 层 `.default(true)`；update 路径**省略＝保留现值**（服务层 merge 现存行值；顺带修掉现状 `.default(false)` 下"省略 PUT 把 true 组翻回 false"的同类潜在翻转，双向都加回归锁）。
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
| `routes/workgroupTasks.ts`                      | `ConfigPatchSchema` +`autonomous` + `nextConfig` 透传 + changes 文案（A）；false→true 单事务遣散 open clarify park（双表 canceled + 中介 run canceled + assignment requeue）再 resume（A2）|
| clarify 遣散原语（`clarifyRerunLedger`/`clarifyRounds`/`clarifySeal` canceled 通路）| A2 复用其 canceled 语义，但编排收进一个加锁事务并与答案提交串行化（陈旧答案 409） |
| `services/workgroupLifecycle.ts`                | `WORKGROUP_ASSIGNMENT_TRANSITIONS` 显式新增 A2 requeue 两边：`awaiting_human→dispatched`、`awaiting_human→open` + oracle 表测（设计门 P1） |
| `shared/schemas/workgroupRuntime.ts` 无需改      | `autonomous` 已在 runtime config（RFC-180）——A 只是让它可被 patch 覆盖       |
| `services/workgroupRunner.ts`                   | 3 调用点注入 `clarifySuppressed` 即时判定器 + leader/worker 失败分支加 `clarify-suppressed`（C）|
| `WorkgroupHostRunRequest` 类型                  | +`clarifySuppressed?: () => Promise<boolean>`（C，缺省=允许；判定器内重读最新 config）|
| `services/runner.ts`                            | `runNode` 收尾分类：clarify envelope + 判定为真 → 持久 `failed:clarify-suppressed:*` + 终态广播（设计门 P1，182 note 派生依据）|
| `services/scheduler.ts`                         | `runHostNode` clarify 分支仅未压制可达（无新短路）；透传判定器（C）           |
| `shared/schemas/workgroup.ts`                   | `autonomous` 缺省 true **仅 create 路径**；update 省略＝保留现值（D，设计门 P1）|
| `components/workgroup/WorkgroupRoom.tsx`（配置区）| +「全自动」`Switch`（A）                                                      |
| `lib/workgroup-form.ts` / `WorkgroupForm.tsx`   | 新建 draft autonomous 初值 true（D，核对 draft 初始化来源）                   |
| i18n（zh/en）                                    | 房间全自动开关 label/hint + patch 变更文案                                    |

## 5. 失败模式

- **中途 on 但任务已卡在 clarify park（A2 覆盖，设计门 P0）**：见 §2.1a——false→true 必遣散 open clarify session + 解 park + resume，否则翻 on 对"正在反问的任务"无效（重新 park）。测试锁"翻 on 遣散在途 park、任务解卡推进、无陈旧答案回流"。
- **中途 on 但 leader 已 declaredDone 泊在 awaiting_review**：A 翻 on 后 `resolveCompletionGate` 变 false，但任务已 `awaiting_review`（gate holder run 已 mint）。设计取舍：**A 不追溯已开的 gate**（翻 on 只影响后续判定）；用户仍可用 gate 确认端点放行（现状），或翻 on 前先确认。测试锁"翻 on 不误改已 park 的 gate 状态"。gate park 与 clarify park 区分处理（A2 只遣散 clarify，不碰 gate）。
- **C 压制丢失同轮 wg_result**：协议一个 envelope 非 clarify 即 output，agent 不会同时产 clarify + wg_result；收尾分类为 failed、`outputs:{}` 无损（测试锁"纯 clarify envelope"）。
- **C leader 耗尽 drop 后 leader run 行状态**：设计门修订后由 `runNode` 收尾持久化**天然满足**——每次被压制尝试的宿主 run 都已以 `failed:clarify-suppressed:*` 落库（running→failed 合法转移），不存在残留 `pending`/`running`/`awaiting_human` 误判 leaderRunning/leaderParked 的窗口。终态 failed 仍被 `countRoundsUsed` 计入（非 canceled、非 wg-gate）→ 该轮照常计入 `max_rounds`，随后 outcome pass 走 leader-idle→nudge。守卫测试保留：耗尽后全部尝试 run=failed、引擎继续到 idle→nudge，不 hot-loop、不僵死、不 park。
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
2a. **A2 遣散在途 park（设计门 P0）**：任务卡在 clarify park（leader 与 worker 两态各一例）时 patch autonomous false→true → **单事务**：clarify_sessions+clarify_rounds 双表 canceled + 中介 park run canceled + assignment `awaiting_human→dispatched/open`（新合法边） + resume → agent 以压制态重跑推进、任务不再 `awaiting_human`；**陈旧答案提交与遣散并发 → 409/幂等拒绝、不 mint 重跑**；无 open park 时 A2 no-op；true→true no-op；gate park 不被 A2 误遣散。
2b. **assignment 转移表 oracle**：`WORKGROUP_ASSIGNMENT_TRANSITIONS` 新增 `awaiting_human→dispatched` / `awaiting_human→open` 两边表测（其余非法边维持非法——全表穷举锁不回归）。
3. **C 收尾持久化**：压制判定为真 + host run 产 clarify → 宿主 run 行持久 `failed` + `errorMessage='clarify-suppressed:*'` + 终态广播、**不** `createClarifySession`、不 mint 中介 clarify run（DB 断言，非仅内存 result——RFC-182 note 派生依据）；判定器缺省/为假 → 现状 asking done + 建 session + park（不回归）。
3b. **C 在途竞态（设计门 P1）**：run 以 autonomous=false 起跑 → 运行中 PATCH 翻 on → 该 run 随后发 clarify → 判定器重读最新 config → 被压制（不建 session、不 park）；反向（true 起跑、中途翻 off）→ clarify 正常建 session。
4. **C leader 收场**：suppressed → 重提示重发；耗尽 → drop-and-continue（run 收终态、不 `throw`、不 park）→ 下一 pass idle→nudge；malformed `clarify-questions-` 仍 `throw`（不误伤）。
5. **C worker 收场**：suppressed → 重提示重发；耗尽 → assignment failed（不 park）；fc 有界重开仍生效。
6. **C message-turn**：suppressed → turn 被 drop（`!==done→return`），不建 session、不 park。
7. **C 三 role 覆盖 + 非全自动不回归**：leader/worker/fc_member 全路径；`clarifyEnabled=true` 下 RFC-172 member-clarify round-trip 正常。
8. **D 默认（create 作用域，设计门 P1）**：create schema parse 缺省 autonomous=true、新建组 autonomous=true；**update/PUT 省略 autonomous ＝ 保留现值**（false 组不被翻 on、true 组不被翻 off——双向回归锁）；前端新建表单 Switch 默认 ON、编辑老组显存储值。
9. **D 无 migration**：`upgrade-rolling` journal 计数不变（不新增迁移）。
10. **前端**：房间「全自动」`Switch` patch 往返 + i18n 对称；新建表单默认 ON。

Codex 设计门：批准前跑，findings 全折再请用户批准。
