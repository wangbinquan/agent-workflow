# RFC-181 工作组「全自动」硬化——新建默认全自动 + 中途可切换 + 反问硬压制 —— proposal

## 1. 背景与问题

RFC-180 落地了单一「全自动」开关（`autonomous`）：开启即关 clarify 反问邀请 + completionGate 视为关 + leader 空转自动 nudge（已提交 `30bd6760`）。用户 2026-07-14 继续走查，暴露出 RFC-180 的三处不足：

### 1.1 三处根因（均已核对源码）

1. **缺口 A：`autonomous` 无法中途切换。** 它在启动时被冻结进任务私有 runtime config（`services/workgroupLaunch.ts:96` `buildWorkgroupRuntimeConfig` —— "Freeze the resource-level group into the task-owned runtime config copy"），且**不在 per-task PATCH 白名单**里（`ConfigPatchSchema` 只含 `switches`/`maxRounds`/`completionGate`/成员增删，`routes/workgroupTasks.ts:91-103`）。而 `completionGate`/`maxRounds` 却能中途 patch。后果：一个**启动时没勾全自动、已经在反问 ping-pong 的任务无法就地静音**，只能取消 + 重启。这是不对称的能力缺失。

2. **缺口 C：`autonomous` 只是"不注入邀请"，不是硬保证。** `resolveClarifyEnabled(autonomous)` 全仓唯一使用点是 `services/workgroupContext.ts` 决定要不要 push `WG_CLARIFY_BLOCK`；运行器/hook **不因 autonomous 拦截 clarify envelope 的 park**（`scheduler.ts:798-848`：agent 发 `<workflow-clarify>` → `result.clarify !== undefined` → `createClarifySession` → 返回 `status:'awaiting'` → 任务 park，全程与 `autonomous` 无关）。后果：即便开了全自动，一个**倔强的 agent 硬发 `<workflow-clarify>` 仍会把任务泊住等人**——"别打扰我"是软劝阻不是硬保证。

3. **缺口 D：新建工作组默认非全自动。** `workgroupConfigFields.autonomous` 默认 `false`（RFC-180 G6 为"零回归"有意设 false）。用户希望**新建的纯 agent 工作组默认就别打扰我**，而不是每次手动勾。

### 1.2 用户已拍板的处理范围（2026-07-14，本次澄清）

- **修 A + C，不修 B**（B = "worker 反问 ping-pong 不计入 `max_rounds`" 的硬上限缺口，`countRoundsUsed` 在 leader_worker 只数 leader 轮 `workgroupRunner.ts:360-364`）—— 用户明确只选 A、C。
- **新增 D**：新建工作组默认全自动。
- **C 的语义 = 软驳回 + 重提示**：全自动组里 agent 仍硬发 `<workflow-clarify>` 时，不建 session、不 park，回一条可重试的协议提示让它自行决断并重发；连试到 `WG_PROTOCOL_RETRIES` 仍只反问 → 丢弃该问、按本轮无有效产出收场（**绝不 park、绝不因反问杀任务**）。

### 1.3 归属与跨 RFC 协同（2026-07-14 接管修订）

本 RFC 转由聊天室执行体验重设计（RFC-182）的同一 owner 接管实现，两 RFC 统筹排期：**RFC-181 先行单 PR 落地，RFC-182 随后**。重叠面仅 `WorkgroupRoom.tsx`——本 RFC 的 Switch 落在 mid-run 配置弹窗（`WorkgroupTaskConfigDialog`），RFC-182 不触碰该弹窗，顺序落地零 rebase 冲突。协同点：

- C 的软驳回 / 耗尽 drop 与 A2 的遣散，在本 RFC 内**不新增任何房间可视化**；其留下的 failed / canceled host run 行由 RFC-182 的回合卡与「执行记录」呈现（含「反问已压制」标注——由 182 在后端把 `clarify-suppressed:*` errorMessage 前缀派生为展示字段 `note`，前端不解析协议串）。
- 因此 `clarify-suppressed` 前缀是**跨 RFC 协议锚点**：本 RFC 的前缀契约测试与 182 的 note 派生测试互为回归防护（改前缀两处同红）。
- message-turn 被压制后 drop（cursor 已推进、无重试，用户拍板语义）在现状下房间**无痕**；182 落地后该轮以 failed 回合卡可见——"静默丢弃"升级为"可见但不打扰"。

## 2. 目标

- **G-A 中途可切换（缺口 A）**：`autonomous` 进 per-task `ConfigPatchSchema`，对称 on/off。中途翻 on 即关反问邀请 + gate 视为关；翻 off 即恢复。写任务 `workgroupConfigJson`，引擎下一轮 `loadDbState`（`workgroupRunner.ts:526`，主循环 `for(;;)` 每轮重载）即生效，**无需重启 daemon**。房间配置区加一个「全自动」`Switch`（复用 completionGate 现成的 per-task patch 通道 + 公共 `Switch`）。
- **G-A2 翻 on 遣散在途反问 park（设计门 P0）**：`autonomous` false→true 转移时，若任务**当前正卡在 clarify park**（`awaiting_human`），必须遣散 open clarify session + 解 park + resume，让被卡的 agent 以 clarifyEnabled=false 重跑推进——否则翻 on 对"正在反问 ping-pong 的任务"无效（引擎重新 park），也就没解决用户"反问停不下来→拨全自动"的原始诉求。A2 = 对在途 park 的追溯式 C。**Codex 设计门确认、已自证**（`leaderParked`→`leaderRunning`重 park，`workgroupRunner.ts:570/579`；worker `humanPending`→`awaiting_human`，`workgroupWake.ts:240-253`）。
- **G-C 反问硬压制（缺口 C）**：clarify 关闭（`autonomous=true`）时，host run 的自愿 `<workflow-clarify>` 被**软驳回**——`runHostNode` 在 `createClarifySession` 之前按 `clarifyEnabled` 短路，返回可重试的协议错误；leader/worker runner 重提示"全自动已关反问，请用 `wg_result` 自行决断"，重发；到 `WG_PROTOCOL_RETRIES` 仍反问 → **drop-and-continue**（leader 自然滑入 idle→nudge→到限泊人的安全阀；worker 该轮标记 failed 浮出，绝不 park）。"别打扰我"成硬保证。
- **G-D 新建默认全自动（缺口 D）**：`workgroupConfigFields.autonomous` 默认 `false → true`（schema 层），新建表单「全自动」`Switch` 默认 ON。**已有组零回归**（存储值不变、无 migration、DB 列默认保持 0 作为兜底）。
- **G-E 零回归 + prompt 隔离不破**：已有组 autonomous 值不变、行为不变；A 的中途切换/C 的压制/D 的默认都只入引擎控流 / hook / UI，绝不进 agent prompt 归属信息（守 RFC-099 prompt 隔离）。

## 3. 非目标

- **不修缺口 B**：worker 反问 ping-pong 不计入 `max_rounds` 的硬上限缺口，用户明确不选，本 RFC 不动 `countRoundsUsed`。
- **不改答题权边界 / free_collab 三开关 / dynamic_workflow**：`requireTaskMember` / `task_collaborators` 不动；autonomous 与 shareOutputs/directMessages/blackboard 正交；dynamic_workflow 无聊天室回合引擎，autonomous 对它 mode-conditional 无效（同 RFC-180）。
- **不引入 blocking-clarify 窄通道**：保持"单一开关"简洁（RFC-180 D1 精神）——不给 agent 一个"仅阻塞性求助仍能 park"的旁路。真卡住的安全阀是 leader-idle→nudge→`awaiting_human` 与真失败浮出，不是反问。
- **不改已有组默认**：D 只反转**新建**默认，不回改任何已存在的组（无回归）。

## 4. 用户故事

- 作为用户，我新建一个纯 agent 工作组，「全自动」默认已勾——我不用每次手动开，也不会再被小决策弹问题打扰。
- 作为用户，我启动时忘了勾全自动、任务已经在反复反问我，我在房间里直接把「全自动」开关一拨，下一轮它就不再问我了——不必取消重启。
- 作为用户，全自动组里万一有个 agent 死活要问我，平台会驳回它、让它自己决断；它连着几次还只会问，那一轮就当它没干出活（该派单卡片标记失败 / leader 被自动催办），而**绝不会把任务泊住等我**。
- 作为用户，我把一个 RFC-180 之前 / 之后建的老组打开，「全自动」还是它当初存的值、行为和以前完全一样。

## 5. 决策记录（2026-07-14，用户拍板）

- **D1 范围 = A + C + D，不含 B**：修"中途可切换"+"反问硬压制"+"新建默认全自动"；不修"worker 反问不计 max_rounds"。
- **D2 C 语义 = 软驳回 + 重提示**：suppressed clarify → 不建 session、不 park → 可重试协议提示 → 重发 → 耗尽 drop-and-continue（leader idle→nudge；worker 该轮 failed）。绝不 park、绝不因反问杀任务。
- **D3 D = 新建默认 true，已有组不动**：schema 默认翻 true + 表单默认 ON；已存在的组存储值与行为不变、无 migration。

由设计推导、随本 RFC 定稿的从属决策（详见 `design.md`，设计门可挑战）：

- **D4 A 对称 + 即时**：`autonomous` 进 `ConfigPatchSchema`，on/off 皆可；写 `workgroupConfigJson`，下一引擎 pass 生效；房间加 `Switch`（复用现有 patch 通道，落一条 system 变更消息，同 completionGate patch）。
- **D4a A2 翻 on 遣散在途 park（设计门 P0）**：false→true 时若有 open clarify park，复用既有 clarify 取消/supersede 机制遣散 session + 解 park（worker assignment→dispatched/open、leader parked run→canceled）+ resume；仅 false→true 触发、无 park 则 no-op、不碰 gate park。不新造 cancel 路径。
- **D5 C 注入点 = hook 短路 + runner 重提示**：`WorkgroupHostRunRequest` 带 `clarifyEnabled`（runner 用 `resolveClarifyEnabled(config.autonomous)` 算好透传）；`scheduler.ts:798` 在 `createClarifySession` 前短路返回**独立前缀** `clarify-suppressed:<n>`（**不复用** `clarify-questions-`——后者 leader 耗尽 `throw` 杀任务，与 C 的 drop-and-continue 收场冲突，必须区分）；leader runner 加 `clarify-suppressed` 重试分支、耗尽 drop-and-continue（不 `throw`，滑入 idle→nudge）；worker runner 在 failed 分支加同前缀重试、耗尽标记 assignment failed；message-turn 靠现有 `!==done→return` 天然 drop。
- **D6 mode 适用面**：同 RFC-180 —— A/C 仅 `leader_worker`/`free_collab` 生效（C 三 role 统一 leader/worker/fc_member）；`dynamic_workflow` 无效。D 的默认对所有 mode 的新组生效（dynamic 组 autonomous 无副作用，default true 无害）。

## 6. 验收标准

- **A**：`ConfigPatchSchema` 含 `autonomous`；PATCH 后 `workgroupConfigJson.autonomous` 更新、落一条 system 变更消息；引擎下一轮读到新值（中途 on 关反问邀请 + gate 视为关、off 恢复——引擎测试）；房间有「全自动」`Switch`、patch 往返正确、i18n zh/en 对称。
- **A2（设计门 P0）**：任务卡在 clarify park（leader/worker 各一）时 PATCH autonomous false→true → open clarify session canceled + 解 park + resume → agent clarifyEnabled=false 重跑推进、任务脱离 `awaiting_human`、陈旧答案回流被拒；无 park no-op、true→true no-op、gate park 不被误遣散。
- **C**：`clarifyEnabled=false` 且 host run 发 clarify → `runHostNode` 不 `createClarifySession`、返回 `clarify-suppressed:*`（勘误 2026-07-14：旧文误写 `clarify-questions-suppressed:*`，会撞上 leader 既有 `clarify-questions-` 重试分支的前缀匹配——独立前缀是 design D5 的硬约束）；leader/worker runner 重提示重发；耗尽后 leader drop-and-continue（滑入 idle→nudge，不 `throw`、不 park）、worker 标记 assignment failed（不 park）；`clarifyEnabled=true`（含非全自动）→ 现状不变（clarify 正常 park，不回归 RFC-172/RFC-023 round-trip）。
- **D**：`workgroupConfigFields.autonomous` 默认 true；新建组（form/API 缺省）autonomous=true；新建表单 `Switch` 默认 ON、编辑老组显示存储值；**已有组行为不变**（回归锁）；无新 migration（`upgrade-rolling` 计数不变）。
- **零回归**：非全自动路径三条（clarify 邀请在 + 正常 park、gate 按存储、leader-idle 直接泊）全维持现状；RFC-180 的 resolve/prompt/gate/nudge 全绿。
- **prompt 隔离**：autonomous（含中途切换值）绝不进 `compose*Prompt` 归属信息（rfc099 prompt 隔离测试不破）。
- **门禁**：`bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；单二进制 build smoke；Codex 设计门（批准前跑）+ 实现门 findings 全折。
