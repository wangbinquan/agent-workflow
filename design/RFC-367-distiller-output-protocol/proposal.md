# RFC-367 — 记忆蒸馏输出协议归一（事件流取数 + 严格协议 + 同会话补问）

状态：Done（2026-09-21 实现落地、CI 验绿并收口记账；能力影响清单 C1–C4 已于同日呈用户逐项确认）
作者：本次会话
日期：2026-09-21

## 1. 背景

用户报障：「记忆候选落库不走 capture，走的是 stdout 解析，失败仅 warn。并且 distiller 的系统提示词
没有给 port 的字面语法导致模型输出格式错误。」

本机 daemon 库（`~/.agent-workflow/db.sqlite`，只读查询）实测，问题比报障更严重——**记忆蒸馏器已经
静默失效一个多月**：

| 事实                                    | 数据                                          |
| --------------------------------------- | --------------------------------------------- |
| `memory_distill_jobs` status=done       | 176，其中 **76 个零候选**                     |
| 有会话捕获（`memory_distill_events`）的 | 10 个（2026-08-23 ~ 08-25），**10/10 零候选** |
| 这 10 个的捕获里含 envelope 文本        | **10/10**                                     |
| 这 10 个的捕获里含 `<port name=…>`      | **0/10**                                      |
| 最后一条真正落库的候选                  | 2026-07-17 22:17                              |
| 当前蒸馏模型                            | `memoryDistillModel: alibaba-cn/glm-5.1`      |

从捕获里取出的三种**真实**畸形输出（每一种都携带着完整、可用的候选 JSON，全部被丢弃）：

1. `<workflow-output nonce="8b4ab56c15f84022">` + ```` ```json ```` 围栏包住 `{"candidates":[…]}`，
   **无 `<port>` 包裹**（3 条完整候选被丢）；
2. `<wflow-output nonce="3a3946b9c5a852a7">` —— 标签名被模型写残；
3. `<wf-output nonce="440bddc4c465f1da">` —— 另一种写残。

### 1.1 两条根因

**根因 A：提示词从头到尾没有给出完整字面语法。**
`domain/distillPrompt.ts` 的系统提示词里 envelope / port **一个尖括号都没有**，只写
"Output exactly one workflow-output envelope using the exact opening tag … specified at the end of
the user prompt. It contains a single port \"candidates\""；用户提示词
（`application/distill/memoryDistiller.ts` 的 `buildDistillerUserPrompt`）也只给了 open tag 一处，
**`<port name="candidates">…</port>` 与 `</workflow-output>` 从未出现在任何提示词里**。
而仓内早有标准件 `buildProtocolBlock()`（`packages/shared/src/prompt.ts`）专门渲染带 `Format:`
示例的完整协议块，worker 节点全部走它——蒸馏器自己手搓了一句话。

**根因 B：解析失败只 warn，任务照样 done。**
`parseDistillerOutput` 的三条失败路径（无 envelope / 无 candidates port / JSON 非法）全是
`log.warn` + `return []`；`runDistill` 于是返回 0 候选，调度器 `markDone`。结果与「确实没有可蒸馏
内容」**完全同形**：UI 绿、`last_error` 空、不退避、不重试。这正是根因 A 能潜伏一个月的原因。

### 1.2 取数口径问题（用户报障的第一句）

候选解析读的是 `result.stdout`（`run.rawStdout.slice(-256KB)` 尾巴，单行还受 1MiB 截断），而会话
页读的是另一条路径——RFC-043 事后走查 opencode SQLite 落到 `memory_distill_events`。**同一段模型
输出有两个互不相同的 reader**，历史上已经因此出过一次同型事故（`memory-distiller.test.ts` 里
RFC-117 回归用例的注释原文："production stdout always parsed as 'no envelope' and every candidate
batch was silently dropped … detail page showed 'No candidates emitted' while the conversation tab
clearly displayed the envelope"）。本次 10/10 是同一现象的第二次复发。

需要说明的是：**改走同源事件流并不能修复本次的数据丢失**（捕获里存的是同一段畸形文本，照样解析
不出）。它解决的是另外两件事：①永久消灭双 reader 漂移；②保真度（不再有 256KB 尾巴 / 1MiB 行截断）。
真正的止血是根因 A + B。

## 2. 目标

- **G1** 蒸馏候选的取数与会话记录**同源于一条规范化事件流**：蒸馏器迁到仓内既有的系统代理运行
  原语 `runSystemAgent`，业务输出取其 `eventText`，会话记录由同一条流经 `SystemAgentEventSinkV1`
  落库。退役自建 spawn + 256KB stdout 尾巴 + opencode-only 的事后 SQLite 走查。
- **G2** 协议失败必须显性且可自愈：无 envelope / 无 port / port 未闭合 / JSON 非法 / candidates 非
  数组，一律判**协议失败**，先在**同一会话内补问**（复用 worker 节点那套
  `renderEnvelopeFollowupPrompt` + runtime resume），预算用尽才让 job `failed` + `last_error` +
  指数退避重试。UI 侧 `lastError` 已有展示（`MemoryDistillJobsTable` / `FailureDiagnostics`），
  无需新前端工作。
- **G3** 提示词给出完整字面语法：系统提示词内嵌 envelope→port→JSON 的三层嵌套字面示例并明示
  「JSON 直接放在 port 里、不要代码围栏」「open tag 逐字节照抄、不要缩写」；用户提示词尾部改用
  公共件 `buildProtocolBlock(['candidates'], …, nonce)`。
- **G4** 「无可蒸馏内容」仍是成功路径：`{"candidates": []}` → done、0 候选、无 last_error，与协议
  失败严格区分。

## 3. 非目标

- **不回收历史数据**（用户 2026-09-21 裁决）：76 个零候选的 done 任务保持 done，不重跑、不回填。
- **不做畸形格式容错**（用户裁决）：不认 `<wf-output>` 之类残标签，不认无 port 包裹的裸 JSON，不剥
  代码围栏。纠偏只靠提示词 + 补问。
- **不改 worker 节点的既有 followup 行为**：本 RFC 只向共享渲染域**新增**一个 reason 取值，不动
  `FollowupFailureCode` / `FOLLOWUP_POLICY`（节点侧生产域），节点行为零变更。
- **不做任何安全类加固**（CLAUDE.md §工作准则 2026-08-26 明令）：本 RFC 只审功能正确性。
- 不动 RFC-366（并发 session 正在起草的「执行结束记忆提炼」新增信号源）——两者正交：它增加蒸馏
  输入源，本 RFC 修输出路径。它先落或后落都不影响本 RFC 的设计。

## 4. 能力影响清单（§RFC workflow 第 7 条）

本 RFC 以「归一取数口径」为由退役既有路径，逐条列出被关闭的能力，请用户逐项确认：

| #      | 被关闭 / 变化的能力                                                                                  | 影响评估                                                                                                                                                                                        | 处置                                                      |
| ------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **C1** | 退役 RFC-043 事后 SQLite 走查（`captureDistillJobSession` / `driver.captureDistillSession`）。**更正（设计门 P3-8）**：初稿把它写成「失去子会话事后捕获」是错的——`runSystemAgent` 每次跑完都会调 `driver.captureSessionsToSink`（`systemAgentRun.ts:762-775` → opencode `driver.ts:482`），子会话走查**照常发生**。真实差异只有一条：root 会话的 parts 不再被事后重读一遍（实时流已经有了，新路径 `includeRoot:false`） | 无能力损失；重复读消失，且不再有「实时流 + 事后走查」双写同一 root 的风险 | 退役事后 root 重读，子会话清扫继承自 `runSystemAgent` |
| **C2** | 会话页不再有「用户消息」part 行（事后走查会把 user message 的 parts 一并捕获，实时流只有子进程 stdout） | 详情页本就单独展示 `user_prompt_md`；本 RFC 另把该字段作为 `promptText` 注入 `parseSessionTree`，会话树里的首个 user turn 得以保留。补问轮的后续 user turn 不落库（只在 `last_error` 与日志可见） | 以 `promptText` 注入补偿；补问轮 user turn 不落库，记为残债 |
| **C3** | 退役 `spawnFn` 测试缝（`DistillerSpawnFn` / `DistillerSpawnInput` / `DistillerSpawnResult` / `defaultDistillerSpawn`） | 纯内部测试缝，非产品能力；改为与 intent / change-narrative 同构的 `runFn` 缝                                                                                                                    | 退役并迁移全部既有用例                                     |
| **C4** | **新增**能力：claude-code 运行时首次获得蒸馏会话捕获；stderr 行进入会话页（`sessionView` 已支持渲染） | 纯增益                                                                                                                                                                                          | 保留                                                       |

## 5. 用户故事

- 作为管理员，当蒸馏模型把格式写错时，我希望平台**当场纠正它**（同会话补问），而不是把我的
  clarify / review 事件默默烧掉。
- 作为管理员，当纠正也失败时，我希望在 `/memory → 蒸馏任务` 里**看到红的失败任务和原因**，而不是
  一个绿的「0 条候选」。
- 作为管理员，我希望会话页显示的内容和候选解析看到的内容**必然一致**——页面上能看到 envelope，就
  不可能解析不出候选。

## 6. 验收标准

- **AC-1** 系统提示词含 `<workflow-output` → `<port name="candidates">` → `</port>` → `</workflow-output>`
  的完整嵌套字面示例；用户提示词尾部由 `buildProtocolBlock` 渲染。两者由 grep 守卫锁定。
- **AC-2** 模型输出「有 envelope、无 candidates port」→ 判协议失败，**不再** `markDone`。
- **AC-3** 协议失败在有 session id 时触发同会话补问：resume 同一 session、prompt 为
  `renderEnvelopeFollowupPrompt` 文案，最多 `DEFAULT_PROTOCOL_RETRY_BUDGET`(=3) 次。
- **AC-4** 补问后模型给出合规 envelope → 候选正常落库、job `done`、`last_error` 为空。
- **AC-5** 补问预算用尽 → job `failed`，`last_error` 含失败码与已试轮次，按既有指数退避重试；达
  `DISTILL_MAX_ATTEMPTS` 后终态 failed。
- **AC-6** `{"candidates": []}` → `done`、0 候选、无 `last_error`、不补问。
- **AC-7** 候选解析的输入与会话页渲染的 assistant 文本**同源于一条规范化事件流**；两者只在一个
  被显式标注的边界上可能不同：`eventText` 有 8MB 保留上限而 sink 无上限，超限时
  `outputEvidence.eventTextCapHit` 为真且 `last_error` 必须点名它（AC-13）。除该边界外，不存在
  「页面有 envelope 但候选为 0 且无解释」的情形。（设计门 P2-1 纠正了初稿「结构上不可能」的过强
  表述。）
- **AC-8** claude-code 作为蒸馏 runtime 时，`memory_distill_events` 有该次运行的事件行。
- **AC-9** 运行结束仍未取得 session id → 不补问、直接判失败并记录原因（不得静默 done）。
- **AC-10** 历史 done 任务与既有 `memories` 行不被本 RFC 的任何代码路径改写。
- **AC-11** 三种真实畸形形态（无 port / 残标签 / 围栏 JSON）各有一条回归用例，均断言「协议失败 →
  补问 → 用尽后 failed」，且注释写明其来自 2026-09-21 的生产取证。
- **AC-13** 协议失败的 `last_error` 携带缺失原因分类（模型格式错 vs 输出超保留上限被截断），
  取自 `SystemAgentOutputEvidence`（见 design §2.8）。
- **AC-12** 补问链结束后 scratch 归属正确（design §3.1）：`ok` / `timeout` / `aborted` /
  `exit-nonzero` / `result-error` 释放；`unreaped` / `spawn-failed` 保留（子进程可能仍持有文件，
  交给 24h orphan GC）。链进行中不得释放——否则 claude-code 的 `--resume` 会落空。
- **AC-14** 模型格式正确但**全部**候选 zod 校验失败（解析出 N>0、落库 0）时，job 判 `failed` 并在
  `last_error` 写明条数与首条拒因；部分失败仍按现状保留其余（用户 2026-09-21 裁决）。
