# RFC-238 · MCP 运行时多轮测试对话框

- 状态：Done（2026-07-30；实现、验证与实现门均已完成）
- 日期：2026-07-30
- 关联：RFC-028（MCP 管理）、RFC-030（MCP 接口探测）、RFC-111/112/113/143/154
  （RuntimeDriver 与运行时 profile）、RFC-224/227/233（执行身份与 containment）、
  RFC-235（共享 Session 执行过程渲染）、RFC-237（Claude Code 窄权限 profile，进行中）

## 1. 背景

当前 MCP 详情页的“工具与探测”页签只能做配置态探测：

- daemon 直接连接单个 MCP，读取 tools/resources/prompts/capabilities；
- 展示 tool description 与 `inputSchema`；
- 用 `operationConfigHash` 区分已保存版本与脏草稿，并提供“保存并探测 / 使用已保存版本”。

它能回答“这个 MCP 是否连得上、暴露了什么”，但不能回答真实使用问题：

- 模型能否理解这些 tools，并选择正确的工具；
- 模型构造的参数是否满足 schema；
- 多个工具是否能按上下文连续协作；
- MCP 返回结果能否被模型正确解释；
- 第二轮追问能否复用第一轮上下文。

RFC-030 明确把“调用 tool 试一下”留给后续 MCP-Tool-Playground。本文补上这条链路，并按用户
确认采用**多轮逻辑测试会话**，而不是一次性单轮运行。

## 2. 产品目标

1. 在 MCP 详情页“工具与探测”页签增加“使用运行时测试”入口。
2. 入口打开系统公共 `Dialog`；用户选择一个支持该能力且已启用的 runtime profile，
   输入自然语言消息并启动测试。
3. 每个测试只挂载当前这一条已保存 MCP；不继承仓库、其它 MCP、Skill、Plugin、
   dependsOn Agent 或运行时内置文件/命令/网络工具。
4. 对话是多轮的：后续消息恢复同一个 runtime-native session，保留上文与工具调用上下文。
5. 执行过程直接复用系统现有
   `SessionConversationPanel → ConversationFlow/SubagentBlock` 与
   `SessionViewResponseSchema`，不新增一套 MCP 专用消息/工具卡片。
6. 会话在闲置 10 分钟后自动结束；用户始终可以“取消当前轮次”或“立即结束测试”。
7. 关闭 Dialog、切换页签或刷新页面只隐藏界面，不取消当前轮次，也不立即结束逻辑会话。
8. 保存版本、权限、运行时身份、进程回收与敏感信息边界可审计且失败关闭。

## 3. 已确认的产品决策

### D1. 多轮逻辑会话，不是单轮任务

一次 MCP 测试由一个逻辑会话和多条 turn 组成：

```text
创建会话 + 第 1 条消息
  → 启动当轮 runtime 进程
  → 挂载当前 MCP
  → runtime-native session 建立
  → 回复完成，当轮进程退出
  → 会话进入 idle
  → 第 2 条消息
  → 新进程用同一 runtime-native session id 恢复
  → …
```

“回复完成”只结束当轮进程，不结束逻辑会话。每轮重新挂载同一 MCP、复用同一私有 session
store，并通过 runtime 原生 resume 能力延续上下文；不得只把上一轮 assistant 文本拼进新 prompt
来伪装恢复。

### D2. 闲置 10 分钟自动结束

- `idleDeadlineAt` 从一轮进入终态并清空 in-flight slot 后开始计算，固定为 10 分钟。
- queued/running 期间不计算闲置时间。
- 服务端成功接纳下一条消息后清空 deadline；该轮结束时重新生成 10 分钟 deadline。
- 仅打开 Dialog、保持页面可见、移动焦点或在输入框打字都不续期；只有服务端接纳消息才续期。
- 关闭 Dialog、切换路由、浏览器刷新或客户端断线不立即结束，也不续期。
- deadline 与新消息竞态由服务端事务 CAS 决定：到期之后到达的消息不能复活旧会话。
- 自动结束会清理可恢复 runtime store 与临时目录，但保留最新会话的标准化执行记录供查看；
  下一条消息创建新会话。

### D3. 手动动作始终保留且语义分离

- **取消当前轮次**：只终止 queued/running turn；逻辑会话仍为 active，若 runtime session
  完整可恢复，用户可以继续发送下一条消息。若首轮在 native session 建立前被取消/失败，
  没有可原生 resume 的上下文，旧逻辑会话会结束而不是用 prompt 拼接伪造继续。
- **立即结束测试**：始终可用。若 turn 仍 queued，先封住 spawn；若已经 running，先请求
  终止并回收该进程；随后把逻辑会话收敛为 ended 并清理可恢复状态。若当前 idle，直接结束。
  结束后不能继续，只能新建测试会话。
- Dialog 的普通关闭按钮只隐藏 Dialog，绝不映射到上述两个破坏性动作。

### D4. 运行时选择与冻结

- 新会话可从所有“已启用且显式声明支持 MCP 测试 profile”的 runtime 中选择；
  全局默认 runtime 的实际解析结果满足该 profile 时默认选中；不满足时明确提示用户选择，
  不静默换到另一 provider/runtime。
- model/variant/temperature/steps 等来自选中的 runtime profile，不在 Dialog 另做第二套配置。
- 第一条消息被接纳后，runtime 名称、协议、解析后的 binary/config-dir/profile 指纹均冻结；
  续聊时不允许切换 runtime。
- 首轮在模型请求前还要持久化实际 runtime binary digest 与 MCP execution digest；续轮重新
  构造 plan 后必须精确匹配。仅“路径/配置字符串没变”不足以证明同一个运行时与本地 MCP。
- local stdio MCP 必须通过受控、可验证的执行材料启动；remote MCP 配置也只写入 daemon-private
  `0600` 文件。MCP env/header/oauth 与 provider credential 不得进入 argv、process title、
  receipt 或日志；无法证明执行材料与首轮一致时不得 resume。
- runtime profile 普通修改或实际指纹漂移后，当前 in-flight turn 继续使用已冻结的 spawn
  材料；若当前 idle 则立即结束旧逻辑会话，若正在运行则在该 turn reap 后结束。runtime
  disabled/delete 属于显式停用，立即请求取消。下一条消息都创建新会话，不静默混用新配置。

### D5. 只运行已保存 MCP 版本

- 新会话绑定 MCP stable id 与精确 `operationConfigHash`。
- 当前表单有脏草稿时，Dialog 明确提供“保存并开始”与“使用已保存版本”两条路径；
  草稿不会被偷偷写入 runtime。
- MCP 保存配置、enabled 状态或身份发生变化后，已启动 turn 使用其启动前冻结材料完成；
  普通配置变化在该 turn 完成后结束旧会话（disabled/delete 则立即请求取消）；下一轮只能
  新建会话。
- MCP 的 env/header/oauth 等 secret-bearing 配置不复制进新业务表、不返回前端、不写日志；
  每轮只在 hash 仍一致时从当前受保护 MCP 行重新装载并立即构造受控 spawn。

### D6. MCP-only 能力边界

测试运行时只能看到：

- 一个合成的测试 Agent persona；
- 当前 runtime profile；
- 当前已保存且 enabled 的 MCP；
- 一个 session-scoped 空目录；
- 该 runtime 自身完成模型请求与 MCP transport 所必需的凭据/网络。

明确排除：

- repo/worktree 内容、`AGENTS.md`、`CLAUDE.md` 与 project/user settings；
- Read/Edit/Write/Bash/Web/Question/Task/subagent 等 runtime 内置工具；
- 其它 MCP、Skill、Plugin、Agent dependency、memory、inventory plugin；
- daemon 配置、MCP secret、用户身份与 ACL 信息进入 model prompt。

每个 runtime driver 必须用闭集能力声明和行为资格证明上述 profile；不能证明的 runtime
不出现在 picker 中，后端创建门再次失败关闭。不得用 protocol 字符串白名单绕过 driver 能力。

### D7. 权限与隐私

- 能查看/使用当前 MCP 的登录用户都可以创建自己的测试会话。
- 会话、prompt、MCP 返回内容与标准化 events 默认仅创建者可读；system admin 可按精确 id
  审计。MCP owner/manager 不能因为管理 MCP 就读取其他用户的测试内容。
- 每次 GET、message、cancel、end 都重验 actor；无权限与不存在同形为 404。
- 权限/visibility/disable 撤销事务必须在同一 DB commit 中把受影响 session 先写为 ending，
  因而提交后绝不再接受新消息；提交成功后同步触发 in-memory abort，周期复核与重启恢复负责
  补偿 abort 通知遗漏。
- MCP tool 可能对外部系统产生真实副作用。Dialog 必须显示持续可见的 warning：
  “测试会调用真实 MCP；请勿要求模型执行未确认的写操作。”

### D8. 会话记录与限额

- 每位用户对同一 MCP 同时最多一个 active/ending 会话和一个 in-flight turn。
- 最新 ended 会话及其标准化 Session 记录保留到用户开始下一次测试；开始新会话时只清理
  `cleanup=complete` 的旧 ended 记录。仍 pending/quarantined 的 row 与 process/store
  identity 必须留给 recovery，不能为了 UI“只留一条”而删除证据。
- create 使用独立、无 prompt/secret 的 durable idempotency receipt；即使旧 transcript 已清理，
  同一个 `clientCreateId` 在 24 小时保证窗内也只能得到原 `sessionId/acceptedTurnId`，不能
  再触发一次模型或 MCP side effect。前端只为用户明确点击“开始新测试”生成新 token。
- 单条消息上限 64 KiB；单会话最多 32 个 turns、20,000 条 events、16 MiB event payload。
- 单轮 hard deadline 从服务端接纳消息起计算 10 分钟，包含排队与执行；queued turn 到期、
  cancel 或 end 后都必须在 spawn 前重验 durable 状态。它与“turn 终态后 10 分钟 idle TTL”
  是两个独立计时器。
- raw frame、单 event payload 与 stderr tail 均有更小的有界上限；超限后继续有界 drain
  子进程但把 capture 标为 truncated/incomplete，不能让一个 MCP result 无界占用 daemon 内存。
- 达到 turn/event 限额时不截断后继续伪装完整上下文：当前业务回复可结束，Session 显示
  truncated warning，逻辑会话随后要求结束并新建。
- stderr、异常和日志经过现有 credential masking；MCP tool result 属于用户私有会话内容，
  不因“可能含敏感数据”而擅自删改其业务正文。

## 4. 用户体验

### 4.1 首次启动

用户在“工具与探测”页签点击“使用运行时测试”：

1. Dialog 打开，并查询该用户在当前 MCP 下的最新测试会话。
2. 若没有 active 会话，显示 runtime picker、保存版本依据、风险提示、消息输入框。
3. 用户发送第一条消息后，runtime picker 与配置依据锁定，Dialog 进入执行态。
4. 后端返回 `202` 后立即显示用户消息与 Session 执行过程；运行中可取消当前轮次。

### 4.2 继续对话

当轮终态后：

- 输入框重新启用；
- 显示“闲置后自动结束”的绝对时间与剩余时间；
- 发送下一条消息会恢复同一 session；
- `SessionConversationPanel` 展示所有轮次的 user/assistant/reasoning/tool use/tool result，
  而不是每轮一个互不相干的卡片。

### 4.3 关闭与恢复

- 点击 Dialog ×、按 Esc、点遮罩或离开页面：Dialog 关闭，后端不收到 cancel/end。
- 重新打开或刷新后，加载当前用户最新会话；若 turn 仍在运行，继续 WS locator +
  1.5 秒 polling fallback；若 idle，继续显示倒计时与输入框。
- deadline 到期后，Dialog 显示“已因闲置 10 分钟结束”，历史执行过程仍可查看；
  主操作变为“开始新测试”。

### 4.4 手动终止

- “取消当前轮次”只在 queued/running 时显示。
- “立即结束测试”在 active 会话中始终显示；运行中点击需用公共 `ConfirmDialog`
  说明当前回复会被中止。
- queued 时立即结束会先把 session 写为 ending；worker 即使随后拿到 semaphore，也只能
  收敛该 turn，不能 spawn。running 时则先 durable end，再 TERM→KILL→reap。
- end 请求提交后锁住重复 end/send，但普通 Dialog 关闭仍只隐藏；重开可看到 ending
  到 ended 的收敛过程。

## 5. 运行与停止语义

| 条件                     | 当轮进程                                     | 逻辑会话                                    | 后续消息         |
| ------------------------ | -------------------------------------------- | ------------------------------------------- | ---------------- |
| assistant 正常回复完成   | 退出并回收                                   | active + 10 分钟 idle deadline              | 原生 resume      |
| 用户取消当前轮次         | TERM→KILL→reap                               | session 完整则 active + 新 deadline         | 可继续           |
| 接纳后单轮硬超时 10 分钟 | queued 不再 spawn；running TERM→KILL→reap    | session 完整则 active + 新 deadline         | 可继续，否则新建 |
| 闲置 10 分钟             | 此时无进程                                   | ending→ended，清理 store/scratch            | 必须新建         |
| 用户立即结束             | queued 禁止迟到 spawn；running 先取消并 reap | ending→ended，清理 store/scratch            | 必须新建         |
| MCP/runtime 配置漂移     | 已启动 turn 不热切                           | idle 立即 ending；running 在 reap 后 ending | 清理后新建       |
| daemon graceful shutdown | 终止在跑进程                                 | 可恢复则 active，重启后按 deadline 收敛     | deadline 内可续  |
| daemon crash/restart     | boot identity-reap 后标 interrupted          | store 完整则 active，否则 ended             | 视恢复证明       |
| 子进程无法证明已退出     | 不删除其目录                                 | ended/failed + cleanup quarantined          | 新建不复用旧目录 |

MCP 自身 `timeoutMs` 仍只控制单次 MCP request；它不替代单轮 10 分钟 hard timeout，也不替代
逻辑会话 10 分钟 idle TTL。

## 6. 非目标

- 不做直接编辑 tool name + JSON args 的低层 RPC console；v1 是模型驱动的自然语言测试。
- 不把测试会话变成 Task、Workflow、NodeRun，也不进入任务列表、任务指标或自动恢复语义。
- 不让测试 Agent 访问仓库或写文件来验证“组合开发”场景。
- 不为一次会话挂载多个 MCP。
- 不共享、导出或长期归档测试会话。
- 不因关闭 Dialog 自动取消。
- 不承诺撤销已经被 MCP 接收的外部副作用；cancel/end 只能终止本地进程与后续调用。
- 不在本 RFC 修改 MCP probe 的 list/health 语义。

## 7. 验收标准

1. MCP 详情“工具与探测”页签出现“使用运行时测试”入口，使用公共 `Dialog`、
   `RuntimeSelect`、Form primitives、`ConfirmDialog`、`NoticeBanner`。
2. 脏草稿提供“保存并开始 / 使用已保存版本”，session 绑定精确 stable id +
   `operationConfigHash`，无 secret 进入 DTO/日志/新表。
3. 至少连续两轮真实测试：第二轮由 runtime 原生 resume 继承第一轮上下文，并再次只挂载
   同一 MCP。
4. UI 的执行过程只通过共享 `SessionConversationPanel` 与 strict
   `SessionViewResponseSchema` 渲染；不出现 MCP 私有 renderer。
5. 运行中关闭/刷新 Dialog 不取消；重开能恢复相同逻辑会话、当前状态与事件 cursor。
6. turn 完成后精确生成 10 分钟 `idleDeadlineAt`；打开/打字/关闭不续期，接纳新消息才续期；
   到期与 message 竞态由一个服务端 CAS 决胜。
7. “取消当前轮次”与“立即结束测试”均存在且语义不同；end 在 queued/running/idle 三态都能
   最终收敛并清理。
8. enabled runtime picker 默认全局 runtime；首条消息后锁定；MCP/runtime 漂移阻止后续
   resume；runtime binary digest 与 MCP execution digest 也必须跨轮精确相等，不静默改用
   同路径下的新字节。
9. runtime 最终有效工具面只有当前 MCP；repo/其它 MCP/Skill/Plugin/subagent/内置工具均
   不可用，并由 driver capability + 后端负向测试证明。
10. owner/system-admin ACL、其他可见用户隔离、同事务权限撤销、MCP restrict-delete、
    并发 send/end/cancel、create/message response-loss idempotency（含 transcript 清理后
    create token 重放）均有测试。
11. 每轮进程具备 TERM→KILL→reap、PID/command identity、graceful shutdown 与 boot recovery；
    queued end/cancel/timeout 不迟到 spawn；未证明退出时不删除仍可能被写入的目录。
12. Session event 去重、跨轮顺序、capture complete/truncated/incomplete、WS locator +
    polling fallback、raw frame/单 event/32 turns/20k rows/16 MiB 限额有回归。
13. 中英文、desktop light/dark、390px、键盘 focus trap/restore、axe 与真实 daemon
    两轮 MCP fixture E2E 通过。
14. 设计门、实现门及仓库 typecheck/lint/test/format/depcheck/binary gates 全部通过。

## 8. 交付结果

- MCP 详情“工具与探测”页签已提供“使用运行时测试”Dialog；Claude Code 与 OpenCode
  均可在自身 enabled runtime profile 声明 `mcp-test-v1` 时出现在选择器中。前后端均按
  driver capability 失败关闭，不按 protocol 字符串猜测支持情况。
- 两种 runtime 都只挂载当前已保存 MCP，并使用 runtime-native new/resume 延续多轮上下文；
  OpenCode 使用独立 verified owner/lease/control-ACK plan，Claude Code 使用预分配 session id
  与严格 one-MCP config。运行记录统一由 `SessionConversationPanel` 渲染。
- 会话在 turn 终态后闲置 10 分钟自动结束；单轮另有从接纳起计算的 10 分钟 hard deadline。
  “取消当前轮次”“立即结束测试”和普通关闭 Dialog 三种动作保持独立。
- durable session/turn/event/create receipt、owner/admin 私有 ACL、create/message 幂等、
  single-flight/idle CAS、private WS locator + polling fallback、graceful shutdown、boot recovery、
  periodic reconciliation/cleanup/receipt GC、capture limits 与 quarantine 均已接通。
- 本地交付门：Backend `7696 pass / 26 skip / 0 fail`（938 files，26403 expects）；
  Shared `1531 pass / 0 fail`（146 files，3994 expects）；Frontend `5375 pass / 0 fail`
  （661 files）。typecheck、lint、format、depcheck、双 binary build/version smoke 均通过。
- 真实进程 Claude Code + stateful fixture MCP 两轮原生 resume E2E 通过；浏览器 E2E 覆盖
  Claude Code/OpenCode 双选择、失败态、desktop/dark、390px、focus trap/restore 与 axe。
  OpenCode 的 one-MCP、owner/lease/control ACK、new/resume 与身份一致性由 driver/service
  集成测试覆盖。Codex 实现门为 `P0=0 / P1=0 / P2=0`。
