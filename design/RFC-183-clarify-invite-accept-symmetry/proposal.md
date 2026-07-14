# RFC-183 反问「邀请 ⟺ 接受」对称收口——suppressed 轮拒绝自愿反问 + host 轮语义显式化

- 状态：Done（2026-07-14 用户批准〔AskUserQuestion「批准，开始实现」〕；同日实现落地，
  Codex 设计门两轮 4P2 全折 + 实现门跑毕〔P1=文档状态滞后即本行修正；P2 落在并发
  RFC-184 在途 hunk，非本 RFC 范围〕）
- 日期：2026-07-14
- 前置：RFC-023（clarify 信封）/ RFC-100（mandatory ask-back）/ RFC-122（stop oracle）/ RFC-123（stop 强制）/ RFC-148（ClarifyChannel ADT）/ RFC-165（optional 模式）/ RFC-172（工作组全角色反问）/ RFC-180 + RFC-181（全自动关邀请 + 硬压制）

## 1. 背景

用户 2026-07-14 提出原则：**「在不需要反问的时候，就不应该给 agent 注入反问的样例，反之同理」**——即
prompt 里的反问样例注入（`CLARIFY_FORMAT_EXAMPLE` 及邀请文案）必须与执行面对
`<workflow-clarify>` 的接受与否**双向一致**：

- 不接受反问的轮次 → prompt 零反问字节；
- 接受反问的轮次 → prompt 必须带格式样例（RFC-172 事故 #1 的教训：邀请与 schema 分离
  ⇒ agent 裸发自然语言 ⇒ `clarify-questions-malformed` 浪费轮次甚至杀任务，见
  `workgroupContext.ts:261-279` 注释）。

### 1.1 全仓审计矩阵（2026-07-14，现役树）

样例注入点全仓仅两处，且均已条件化：

1. 普通画布节点 `packages/shared/src/prompt.ts` renderUserPrompt：`mandatory` 轮注
   「仅反问」协议（连 output 格式一并撤下）、`optional` 轮（RFC-165）注双信封；
   `none` / `stopped` / `suppressed` 轮零反问字节。
2. 工作组 `workgroupContext.ts:356`：`WG_CLARIFY_BLOCK` 仅非全自动注入（RFC-180），
   全自动另有信封时刻硬拒兜底（RFC-181 C，`runner.ts:1199`）。

执行面逐轮核对：

| 场景 | prompt 样例 | 反问接受 | 一致 |
| --- | --- | --- | --- |
| 未接线 clarify 节点 | 无 | 拒（`clarify-no-channel`，`scheduler.ts:3603-3610`） | ✓ |
| mandatory / optional 轮 | 有 | 接受 | ✓ |
| stop 轮 | 无 + STOP 指令 | 拒（`clarify-forbidden`，RFC-123） | ✓ |
| 工作组非全自动（每角色） | 有 | 接受 → park | ✓ |
| 工作组全自动 | 无 | 拒 + 重提示（RFC-181 C） | ✓ |
| **canvas `suppressed` 轮**（评审驳回 / iterate 重产出 × mandatory 接线） | **无（零字节）** | **接受 → 建 session → park 等人** | **✗ 唯一豁口** |

`suppressed` 的产生条件由 RFC-122 oracle 精确限定（`clarifyRounds.ts:48-65`）：接线 clarify
（self 或 cross）、无 stop 指令、`reviewActive && !isClarifyRerun`——即**只有** mandatory
模式接线在评审驳回 / iterate 重产出轮才会落到这一档；optional 模式在评审轮保持
`optional`（优先级 stopped > optional > mandatory/suppressed，`prompt.ts:156-157`），样例
照注、反问照收，不受本 RFC 影响。

### 1.2 用户拍板（2026-07-14 反问确认）

- **suppressed 轮收口方向 = 改为拒绝**（不是补样例、不是维持现状）：重产出轮定性为
  「不需要反问」，零样例 ⇒ 零接受；agent 硬发 `<workflow-clarify>` 被软驳回 + 同 session
  重索 `<workflow-output>`，重试耗尽硬失败——与 RFC-181 全自动组处置同构。评审意见真不
  清楚时的出路：agent 在产出里说明假设，人下一轮驳回时补充说明，闭环存在。
- **触发场景 = 用户实际见过「多余样例」**。审计结论：现役树无「不该注却注」的活路径；
  所见最可能是 RFC-180 之前的历史行为（`WG_CLARIFY_BLOCK` 曾无条件注入每个角色——
  `workgroupContext.ts:262` "(former) scoping" 佐证）或 RFC-181 已拍板接受的在途轮竞态
  （派发后中途切全自动，该在途轮 prompt 字节冻结）。因此本 RFC 除封豁口外，还要把原则
  **固化为类型层结构保证 + 测试锁**，防止未来新注入面 / 新执行分支再漂移。

### 1.3 附带的语义债

工作组 host 轮今天以 `directive: 'suppressed'` 派发（`scheduler.ts:782`），但它的「邀请」
在 `workgroupProtocolBlock`（WG 块）里、「接受权」在 RFC-181 的信封时刻回调 + 
`clarify-no-channel` 检查里——同一个 `'suppressed'` 字面量承载了两种互斥语义
（canvas＝不邀请不该收；host＝邀请与接受权都外置）。一旦按字面量收紧拒绝，就会误伤
非全自动工作组的反问。必须先把这两种语义在类型上拆开。

## 2. 目标

1. **G1 封豁口**：canvas `suppressed` 轮拒绝自愿 `<workflow-clarify>`（self 与 cross 一视
   同仁）：不建 clarify/cross session、任务不 park；失败带 `clarify-forbidden` 前缀走既有
   followup 机制重索 output，重试耗尽硬失败。
2. **G2 语义显式化**：`ClarifyChannel.directive` 增 `'delegated'`，host 轮改用之——prompt
   渲染与 `suppressed` 同支（零反问字节，邀请由 WG 块自带），执行面「接受权外置」（保持
   RFC-181 回调 + scheduler 层检查，逐字节不变）。此后 `'suppressed'` 唯一语义＝
   「不邀请 ⇒ 不接受」。
3. **G3 结构性锁**：注入与接受统一消费 shared 单源穷举分类器
   `clarifyDispositionFor`（invite-mandatory / invite-optional / reject / external，
   never 检查兜底）——新增 directive 不选处置即编译红、不补 golden 行即测试红；外加
   host 派发不得回退 `'suppressed'` 的源码文本锁。（Codex 设计门 P2#2 折入）
4. **G4 血统补丁**：clarify-answer / cross-questioner 血统的连续 process-retry
   **与 daemon 重启后的 revival 恢复轮**不得退化为 `suppressed`——oracle 输入改为
   **持久 run 祖先推导**（沿 `process-retry` / `revival` 技术性延续 cause 回溯至首个
   实质 cause），该重试/恢复轮维持 mandatory（样例在、反问收、用户 continue 指令被
   尊重）；这同时修正今天已存在的「中途反问却零样例」注入向疙瘩。（Codex 设计门
   P2#1 + 二轮 P2#4 折入）
5. **G5 未接线前置拒**：`kind:'none'` 派发的自愿 `<workflow-clarify>` 由 runner 前置
   拒绝（`clarify-no-channel`）——封掉分片子运行 / 聚合等直调方把「空 outputs 伪
   `done`」当成功甚至合并 worktree 的存量洞；主路径 scheduler 补拒保留作纵深防御。
   （Codex 设计门二轮 P2#3 折入）

## 3. 非目标

- 不改工作组邀请粒度（非全自动组每角色每轮邀请，RFC-172 route 2 维持）。
- 不动 `mandatory` / `optional` / `stopped` 三档语义与 prompt 字节。
- 不动 RFC-181 已拍板的在途轮竞态处理（prompt 字节派发时冻结、执行面信封时刻按最新
  config 双向实时）。
- 不为评审轮补反问样例（用户已否决 optional 化方向；需要评审轮可反问的用户应把
  clarify 节点设为 optional 模式——该路径今天已存在且一致）。
- 不动 RFC-098 的 mint 门：`isClarifyRerunCause` 集合与其既有调用方（inline-resume
  门、Q&A generation 推导）原样保留；血统感知只发生在 oracle 入参的组装处。
- 零 schema / 零 migration / 零前端改动 / 零新 UI。

## 4. 用户故事

- US1 我在评审面板驳回了产出并附意见。agent 这轮不该反过来问我问题——它要么按意见改，
  要么在产出里写明它做了什么假设。即便它硬发反问信封，框架也直接驳回并要求它产出，
  不会把任务泊在「等我回答」上。
- US2 我的工作组没开全自动，成员该问人时照样能问（样例在 prompt 里、答案回到它自己的
  分片）——本次收口对它零影响。
- US3 我把 clarify 节点设为 optional 模式，评审驳回轮 agent 仍然可以选择反问（双信封
  样例都在）——与今天行为一致。

## 5. 验收标准

- AC1 评审驳回 / iterate 重产出轮（mandatory 接线，self）agent 发 `<workflow-clarify>`：
  node_run `failed`、`failure_code='clarify-forbidden'`、errorMessage 带
  `clarify-forbidden` 前缀；**不**创建 clarify session、任务**不**进 `awaiting_human`；
  同 session followup 重索 `<workflow-output>`；重试耗尽后节点硬失败。
- AC2 同场景 cross 接线：同样拒绝，**不**创建 cross-clarify session、**不**触发 answerer。
- AC3 clarify-answer 续跑轮（`isClarifyRerun=true`，评审中途）不受影响：仍 `mandatory`、
  样例照注、反问照收。**AC3b**：该血统的进程级重试（连续 `process-retry`）同样维持
  `mandatory`，不退化 `suppressed`；对照——评审驳回重产出轮自身的 process-retry 维持
  `suppressed`（拒绝）。**AC3c**：daemon 重启后的 `revival` 恢复轮同 AC3b（血统按持久
  run 祖先推导，跨恢复边界语义一致）。
- AC2b `kind:'none'` 派发（分片子运行 / 聚合 / canvas 未接线）发合法
  `<workflow-clarify>`：runner 直接 `failed`（`clarify-no-channel` 消息、无 followup、
  无 session），直调方不再见到空 outputs 的伪 `done`。
- AC4 optional 模式评审轮不受影响（AC 断言 directive 仍为 `'optional'`、双信封样例在、
  反问被接受）。
- AC5 非全自动工作组成员 / leader / fc_member 反问照旧接受并 park（`'delegated'` 路径）；
  全自动组 RFC-181 行为（信封时刻拒 + 重提示 + drop-and-continue）逐字节不变。
- AC6 prompt 字节零漂移：RFC-148 golden matrix 中 `suppressed` 与新增 `'delegated'` 的
  渲染输出均为纯输出协议，与现状 `suppressed` 字节一致；mandatory / optional / stopped
  的字节不变。
- AC7 源码文本锁：host 派发点不得出现 `directive: 'suppressed'`（grep 锁测试）。
- AC8 门槛：`bun run typecheck && bun run lint && bun run test && bun run format:check`
  全绿 + `bun run build:binary` smoke 通过。
