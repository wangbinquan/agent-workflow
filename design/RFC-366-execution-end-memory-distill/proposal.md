# RFC-366 — 执行结束记忆提炼（agent 运行结束 / 任务结束）+ 任务来源准入门

状态：Draft
作者：用户口述需求 + Claude 落档
日期：2026-09-21

## 1. 背景

平台的长期记忆（RFC-041）今天**只有三个信号源**会触发提炼任务，源码对账如下：

| 源         | 触发时机                                   | 锚点                                                                               |
| ---------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `clarify`  | self 轮快速通道答复整轮 seal 成功后        | `modules/collaboration/infrastructure/clarify/autoDispatch.ts:385-400`             |
| `review`   | 人审决定提交（approved/rejected/iterated） | `modules/collaboration/application/collaborationCommittedEventConsumers.ts:96-114` |
| `feedback` | 任务留言插入后                             | `modules/collaboration/application/taskFeedback.ts:45-49`                          |

这三条全部是**人类介入点**。而平台绝大多数产出来自 agent 自己跑完的那一段——会话里踩的坑、
被环境拒绝的路径、最后怎么收敛的——这些今天**一条都不会进记忆库**。一个从头到尾没有人审、
没有澄清、没人留言的任务（正是「跑得顺」的任务）在记忆系统里等于没发生过。

同时，`memory_distill_jobs` 今天**不区分任务来源**：一个每 5 分钟跑一次的定时任务，只要中途
有人审一次，就会照常入队一次蒸馏（一次 LLM 调用）。定时 / webhook / 事件触发的任务往往是
高频、同质、低信息量的，它们产生的候选记忆会淹没人审队列。

## 2. 目标

- **G1**：agent 运行结束（node_run 达终态）产生一类新的提炼信号源 `agent-run`。
- **G2**：任务执行结束（task 达终态）产生一类新的提炼信号源 `task-run`。
- **G3**：引入**任务来源准入门**——按 `tasks.launch_origin` 白名单决定该任务的事件是否提炼，
  默认只放行 `manual`（手工创建的任务）。
- **G4**：引入**逐源开关**——五类源各一个布尔，默认全开；与 G3 的来源轴正交。
- **G5**：新配置一律**热读**（即改即生效，不需要重启 daemon）。
- **G6**：设置页可配；蒸馏任务列表可按新源筛选。

## 3. 非目标

- 不改记忆的**注入**面（RFC-046 / RFC-352 的 injection 链路零改动）。
- 不改人审队列的审批语义、不改 scope 权限模型（RFC-099/231）。
- 不做提炼结果的自动批准——新源产出的一样是 `status='candidate'`，走既有人审。
- 不做 per-agent / per-workflow 级别的提炼开关（本轮只到全局配置粒度）。
- 不碰安全面（按 `CLAUDE.md` §工作准则「任何门检视只审功能、禁止碰安全」）。

## 4. 用户故事

1. 作为平台管理员，我手工起了一个任务，里面 3 个 agent 跑完，**不需要我做任何事**，
   记忆库里就出现了这几个 agent 的候选记忆（踩坑、约束、收敛方式），我在 `/memory`
   审批队列里逐条过一遍。
2. 作为平台管理员，我的定时任务每小时跑一次同一个工作流。我**不希望**它们产出记忆——
   它们是同质重复的。默认配置下它们一条都不产出；哪天我想让定时任务也提炼，去设置页
   把 `scheduled` 勾上即可。
3. 作为平台管理员，我只想要人审沉淀、不想要 agent 过程沉淀（成本考虑）。我去设置页把
   `agentRun` / `taskRun` 两个开关关掉，`clarify` / `review` / `feedback` 保持开。
4. 作为平台管理员，我在 `/memory` 的「蒸馏任务」分区里能按来源类型筛出 `agent-run` 的
   job，看它到底喂了什么进去、产出了什么候选。

## 5. 决策记录（用户 2026-09-21 逐条拍板）

| 编号 | 议题                      | 决定                                                                                          |
| ---- | ------------------------- | --------------------------------------------------------------------------------------------- |
| D1   | agent 触发粒度            | **每个 agent node_run 达终态各触发一次**（含 loop 每轮、fanout 每分片、每次重试）             |
| D2   | 任务类型门的轴与形态      | **`launchOrigin` 多选白名单**，默认只 `['manual']`                                            |
| D3   | 门的覆盖面                | **统一管五类源**——现有 clarify / review / feedback 也受白名单约束（见 §6 能力影响清单）       |
| D4   | 终态范围                  | **`done` + `failed`**；`canceled` / `interrupted`（agent 另含 `exhausted` / `skipped`）不提炼 |
| D5   | agent 源喂什么            | **会话全文 transcript + 输出端口 + 本次运行的已注入记忆快照**                                 |
| D6   | task 源喂什么             | **任务级摘要 + 最终输出**（不重复搬运 agent 源已喂过的 transcript）                           |
| D7   | 子任务 / 内部任务         | **排除平台内部任务**；普通子任务继承父任务来源，照常提炼                                      |
| D8   | 成本护栏                  | **agent 源用更长的去抖窗口**，默认 60s，可配；其余四类仍 5s                                   |
| D9   | 开关粒度                  | **五类源各一个布尔开关**，默认全 `true`                                                       |
| D10  | 配置生效方式              | **热读**（沿 RFC-050 ambient provider 先例），即改即生效                                      |
| D11  | agent 源的 scope 归属     | **收窄到本次结束的那个 agent** + workflow + repo + global                                     |
| D12  | 前端范围                  | **设置页配置 + 蒸馏队列按源筛选**（不做任务详情页入口）                                       |
| D13  | agent 入队的可靠性档位    | **participant 直调 best-effort**（同 clarify 先例），异常 swallow                             |
| D14  | 蒸馏器 system prompt 改法 | **补专门提炼指引**——枚举扩容 + 针对新两类源的提炼侧重段落                                     |

## 6. 能力影响清单（CLAUDE.md §RFC workflow 第 7 条）

D3 选择「统一管」，意味着本 RFC **关闭了一部分既有能力**。按第 7 条逐项列出，作为
breaking change 呈用户确认：

| #   | 被关闭的既有能力                                                                                       | 今天的行为                                                                        | 本 RFC 后的行为                                                          | 受影响部署形态                            |
| --- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| C1  | **定时任务（`launchOrigin='scheduled'`）里的人审决定进蒸馏队列**                                       | 任一 review 决定提交 → 无条件入队                                                 | 默认**不入队**；需把 `scheduled` 加进白名单才恢复                        | 用 RFC-159 定时任务 + 人审节点的部署      |
| C2  | **定时任务里的澄清答复进蒸馏队列**                                                                     | self 轮答复 → 无条件入队                                                          | 同上                                                                     | 同上                                      |
| C3  | **定时任务里的任务留言进蒸馏队列**                                                                     | 每条留言 → 无条件入队，`task_feedback.distill_job_id` 写值、UI 显示「已交付提炼」 | 同上；被拒时 `distilled=false` / `distillJobId=null`，UI 不再显示该 chip | 同上                                      |
| C4  | **Webhook 触发任务（`launchOrigin='webhook'`）的上述三类事件进蒸馏队列**                               | 无条件入队                                                                        | 默认不入队；需把 `webhook` 加进白名单                                    | RFC-257 webhook 触发 / RFC-304 代码能力轮 |
| C5  | **事件中心触发任务（`launchOrigin='event'`）的上述三类事件进蒸馏队列**                                 | 无条件入队                                                                        | 默认不入队；需把 `event` 加进白名单                                      | RFC-310 事件订阅驱动的部署                |
| C6  | **API/令牌启动任务（`launchOrigin='api'`）的上述三类事件进蒸馏队列**                                   | 无条件入队                                                                        | 默认不入队；需把 `api` 加进白名单                                        | 用 token 从外部系统起任务的部署           |
| C7  | **平台内部任务（`catalog_visibility='internal'` 或 `space_kind='internal'`）的上述三类事件进蒸馏队列** | 无条件入队                                                                        | **一律不入队**，且**无配置可恢复**（见下方说明）                         | 数字员工 / 动作执行 / 融合内部启动        |

关于 C7：内部任务是平台自己拉起的执行（`modules/task-execution/composition/actionExecutionEnvironment.ts`、
`digitalEmployeeExecution.ts` 写 `catalogVisibility: 'internal'`；融合走 `internalSource` → `spaceKind='internal'`），
用户在任务列表里根本看不到它们。给它们开一个白名单等于给一个用户无法验证结果的开关。
若你要求可配置，我改成第六个白名单条目 `internal`（默认关）——这一项请明确回复。

**不受影响**：已经落库的历史候选记忆、已批准记忆、注入链路、人审队列语义，全部零改动。
本 RFC 只改「以后还往队列里放什么」。

## 7. 验收标准

### 功能验收

- **AC-1**：手工任务（`launchOrigin='manual'`）中，一个 agent 节点跑完（`done`）后，
  `memory_distill_jobs` 出现一行 `source_kind='agent-run'`，`source_event_id` 等于该
  node_run id，`task_id` 等于任务 id。
- **AC-2**：同一手工任务中，一个 agent 节点跑失败（`failed`）同样入队一行 `agent-run`。
- **AC-3**：同一手工任务中，agent 节点落 `canceled` / `interrupted` / `exhausted` / `skipped`
  **不**入队。
- **AC-4**：手工任务达 `done` 或 `failed` 后，出现一行 `source_kind='task-run'`，
  `source_event_id` 等于任务 id；落 `canceled` / `interrupted` 不入队。
- **AC-5**：定时任务（`launchOrigin='scheduled'`）在默认配置下，上述两类**以及**
  clarify / review / feedback **一律不入队**。
- **AC-6**：把 `scheduled` 加进 `memoryDistillLaunchOrigins` 后，**不重启 daemon**，
  下一次事件即入队（热读）。
- **AC-7**：把 `memoryDistillSources.agentRun` 置 `false` 后，agent 结束不入队，
  但 `taskRun` / `review` 等其余源照常。
- **AC-8**：内部任务（`catalogVisibility='internal'` 或 `spaceKind='internal'`）
  五类源全部不入队，且与白名单无关。
- **AC-9**：子任务（RFC-243 call 节点拉起）继承父任务的 `launchOrigin`；父任务是
  `manual` 时子任务的 agent/task 结束照常入队。
- **AC-10**：一个 loop（3 轮）包住的 agent 节点，三轮各产生一次入队；三次入队落在同一个
  去抖键下，60s 窗口内的会被合并成**一次**蒸馏运行。
- **AC-11**：fanout 分片（5 片）并发结束，5 次入队合并成一次蒸馏运行。
- **AC-12**：`agent-run` job 的 `scope_resolved_json.agentIds` **只含本次结束的那个
  agent 的 id**（可解析时）；workflow / repo / global 照常。
- **AC-13**：`agent-run` 的蒸馏 user prompt 里同时出现该 run 的 transcript 块、
  输出端口块、已注入记忆块，且各自按字节预算裁剪（超限带 `[truncated N bytes]` 标记）。
- **AC-14**：`task-run` 的 user prompt 里出现任务名/状态/耗时/失败节点/errorSummary/
  启动入参/各节点终态一览/output 节点最终输出，**不**含 transcript 全文。
- **AC-15**：定时任务里提交的任务留言，响应 `distillJobId` 为 `null`、`distilled` 为
  `false`，UI 不显示「已交付提炼」chip；留言本身正常保存与展示。
- **AC-16**：蒸馏器产出的候选记忆 `source_kind` 落 `agent-run` / `task-run`，
  `/memory` 审批队列与蒸馏任务表能正确渲染这两个来源的中英文标签。
- **AC-17**：`/memory` 蒸馏任务分区可按 `agent-run` / `task-run` 筛选。
- **AC-18**：设置页「记忆」卡片出现：来源白名单多选、五个源开关、agent 去抖窗口输入；
  全部复用既有公共组件（`Field` / `Switch` / `ChipsInput` 或 `.segmented` / `NumberInput`），
  不新写原生元素或自有 CSS。

### 回归防护

- **AC-19**：手工任务下 clarify / review / feedback 三类的入队行为与本 RFC 前**逐字节一致**
  （既有测试全绿，不许改断言）。
- **AC-20**：`memoryDistillerEnabled=false` 时，五类源仍照常入队（审计行照写），只是
  worker 不取——与 RFC-041 语义一致。
- **AC-21**：daemon 在 agent 结束入队的那一瞬崩溃，任务本身不受影响（best-effort，
  D13）；恢复后该 agent 的记忆丢失，但任务结束源仍会覆盖该任务（在 `task-run` 开启时）。

## 8. 风险

- **R1 成本**：D1 的逐 node_run 粒度会显著增加 LLM 调用量。缓解：默认只 `manual` 来源
  （D2）、60s 去抖窗口合并同任务内的 agent（D8）、逐源开关可整类关掉（D9）。
  RFC-041 §R7 已记录过同类风险，本 RFC 把它放大了一档，需要管理员知情。
- **R2 候选噪声**：agent 会话全文最容易被提成「今天干了什么」流水账。缓解：D14 的
  prompt 专项指引明确要求从 agent 会话里提 anti-pattern / 环境约束 / 工具踩坑，
  从任务收尾提 process / quality-bar。
- **R3 人审负担**：候选量上升。缓解：D12 的来源筛选让管理员能分批处理；不做自动批准。
- **R4 breaking change**：§6 的 C1–C7。缓解：逐项呈用户确认（本节即为确认材料），
  每条禁用分支必须有测试覆盖（第 7 条要求，见 `design.md` §测试策略）。
