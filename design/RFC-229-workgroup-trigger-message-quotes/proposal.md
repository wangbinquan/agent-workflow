# RFC-229 工作组聊天室触发消息引用 UX — proposal

状态：Done（2026-07-26；用户批准后已完成实现与本地验证；agent 之间的 `@` 与
human→agent 使用同一引用合同）。

## 1. 问题

工作组聊天室已经知道“哪个消息回合由哪条 `@` 消息唤醒”：

- message-turn 的 `node_runs.shard_key` 固化为 `msg:<memberId>:<maxMsgId>`；
- 房间聚合把它解析成 `runHistory[].triggerMessageId`；
- RFC-182 用这个字段把执行卡挂在触发消息下面。

但真实 `workgroup_messages` 行没有父消息字段。agent 完成回合后，产出的聊天消息只显示作者和正文，
不会引用唤醒它的消息。只看消息流时，用户无法判断这是在回应谁；agent A `@agent B` 后，B 的回复
尤其容易与并发讨论混在一起。

不能用作者、时间戳或相邻位置猜父消息：同一条消息可同时唤醒多个 agent，一个回合也可产出多条
消息，且不同 agent 回合可以并发完成。引用关系必须在消息落库时明确保存。

## 2. 目标

- 人类 `@agent` 与 agent A `@agent B` 使用完全相同的引用合同。
- 一条消息同时 `@` 多个 agent 时，每个 agent 的回复都引用同一条触发消息。
- 一个 message-turn 产出多条消息时，每条消息都引用该回合的同一触发消息。
- 引用块显示原作者和最多两行正文预览；点击后滚动到原消息并短暂高亮。
- 引用关系来自权威 message-turn 身份，不从 UI 顺序、时间戳或作者做模糊推断。
- 旧消息、无唯一触发消息的回合和损坏引用安全降级。

## 3. 产品合同

### 3.1 什么算“由消息触发”

本 RFC 的触发消息是：message-turn 持久 `shardKey` 所覆盖消息中，`id <= maxMsgId`、确实
`@` 目标成员、且不是该成员自己发送的最新一条消息。这与引擎唤醒 message-turn 的
`hasUnconsumedMention` 语义一致。

因此：

- 人类消息 `@reviewer` → reviewer 本回合产出的成员消息引用该人类消息；
- agent A 消息 `@reviewer` → reviewer 本回合产出的成员消息引用 agent A 的消息；
- 同一 room snapshot 中消息 `@A @B`、A/B 都可立即起 message-turn → A、B 的各自回复都
  引用它；
- A 的回复又 `@C` → C 的回复引用 A 的这条回复，形成逐层可追溯的消息链；
- 同一回合的 `wg_messages` 与合法 `wg_result` 摘要都带同一引用。

若某成员正忙而积累了不止一条未消费的 `@`，其下一次 message-turn 仍按既有语义消费这批快照，
直接父级取该快照内最新的有效 `@` 消息；不把一条单父引用伪装成多父 thread。

### 3.2 不强造单一父消息

以下消息不自动引用：

- free-collab 初始规划回合（没有 `@` 触发者）；
- leader 汇总回合（可能消费多条黑板/结果，没有唯一消息父级）；
- assignment / batch 结果（其权威父级是派单卡，继续使用现有卡片关系）；
- 系统诊断、门事件与失败说明；
- migration 前的历史消息（无法无损回填）。

本 RFC 不用“最近一条消息”填空；没有权威父级就显示普通消息。

### 3.3 引用呈现

有 `triggerMessageId` 的消息在正文上方显示紧凑引用块：

- 第一行：`回复 <原作者>`；
- 第二部分：原消息正文的最多两行预览，超出截断；
- 点击或键盘激活：把同一聊天室内的原消息滚动到视口中部、转移程序化焦点并短暂高亮；
- 一次只展开直接父消息，不在引用块内递归嵌套父消息；
- 指针存在但原消息不在当前 room payload 时，显示“原消息不可用”，不跨任务查询内容。

长作者名、长单词、多行正文与 390px 窄屏都不得制造水平溢出。引用控件使用可见键盘焦点，减少
动态效果偏好下不做平滑滚动。

## 4. 非目标

- 不增加手动“回复某条消息”的 composer 操作。
- 不把 assignment/result 卡片改造成聊天 reply。
- 不为 leader 回合发明多父引用或 thread UI。
- 不回填 migration 前消息的推测关系。
- 不改变 agent prompt、消息可见性开关、游标推进、回合预算或 WS 帧协议。

## 5. 验收标准

- **AC-1**：人类 `@B` 后，B 的每条 message-turn 成员消息引用该人类消息。
- **AC-2**：agent A `@B` 后，B 的每条 message-turn 成员消息引用 A 的消息。
- **AC-3**：同一 room snapshot 中一条消息同时 `@A @B` 且 A/B 都可起 message-turn 时，
  A/B 的回复拥有相同 `triggerMessageId`；成员忙碌并积累多条 `@` 时取其固定快照内最新有效
  `@`。
- **AC-4**：一个回合的多条 `wg_messages` 与合法 `wg_result` 摘要全部继承同一引用。
- **AC-5**：clarify 后 adopted message-turn 仍引用原 shardKey 固化的触发消息，不被期间新增
  的 `@` 消息偷换。
- **AC-6**：self-mention、`maxMsgId` 之后的消息、初始规划、leader/assignment/system 与历史
  null 行不产生虚假引用。
- **AC-7**：引用块显示原作者 + 两行预览；鼠标和键盘激活都能滚动、聚焦、高亮原消息。
- **AC-8**：坏指针只显示不可用占位，不查询或泄露其它任务消息。
- **AC-9**：引用元数据不进入 agent prompt，既有 prompt golden byte-identical。
- **AC-10**：明暗主题、桌面与 390px 真浏览器检查无裁剪、无水平溢出，焦点与 reduced-motion
  行为正确。
- **AC-11**：shared/backend/frontend 定向测试、typecheck、lint、format、全量相关测试与
  binary smoke 通过。

## 6. 兼容性

`workgroup_messages` 新增 nullable `trigger_message_id`。旧行统一为 null，不回填；room 响应新增
nullable `triggerMessageId`。写入字段只由服务端引擎生成，现有发消息 API 不接受客户端伪造
父级。删除整个任务仍级联清理所有消息；未来若支持单条消息删除，自引用外键以 `SET NULL`
安全降级。
