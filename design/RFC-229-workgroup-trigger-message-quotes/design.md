# RFC-229 工作组聊天室触发消息引用 UX — design

状态：Implemented（2026-07-26；用户批准后完成实现；实现门 3 项发现均已修复，0 open）。

## 1. 当前事实与约束

### 1.1 已有权威关系

- `driveMessageTurn` 为 fresh run 铸
  `buildMsgShardKey(memberId, maxMessageId(state.messages))`；clarify/resume 复用已落库
  shardKey。
- `deriveWorkgroupRunHistory` 已从同一个 shardKey 解析 `triggerMessageId`，但该字段属于
  `WorkgroupRunEntry`，只驱动执行卡与“执行中”pill。
- `WorkgroupMessageSchema` / `workgroup_messages` 当前没有父消息字段；`postMessage` 与
  `persistWgMessages` 落出的成员消息因此无法保留关系。
- `composeMemberPrompt` 的 addressed-message slice 与 wake 判据都排除 self-authored mention。
  新的持久关系必须使用同一极性，不能继续沿用 room resolver 当前未排除 self-author 的近似。

### 1.2 不能后验推断

不允许用以下规则推导引用：

- “同作者的上一条消息”——回复作者与触发作者不同；
- “输出之前最近一条消息”——并发回合完成顺序与触发顺序不同；
- “同一 createdAt/round”——一条父消息可 fan-out 到多个 agent，多条输出也可同毫秒落库；
- “runHistory 附近的消息”——消息行没有 `createdByRunId`，无法做无歧义 join。

所以关系必须在 message-turn 产出持久化时写入。

## 2. 数据模型与 migration

### 2.1 字段

`workgroup_messages` 增加：

```ts
triggerMessageId: text('trigger_message_id').references(
  (): AnySQLiteColumn => workgroupMessages.id,
  { onDelete: 'set null' },
)
```

共享 schema 增加 `triggerMessageId: z.string().nullable().default(null)`。default 只服务旧 fixture /
旧 JSON 输入兼容；服务端 DTO 和 room 输出始终显式返回 `string | null`。

字段语义：

- 非 null：这条消息是一个 message-turn 的产出，值为唤醒该回合的直接父消息；
- null：没有权威单一父消息、旧数据，或安全降级；
- 不等价于 assignment id、node run id 或通用 thread id。

外键只保证消息存在；生产写入点保证同 task。客户端 API 不接收该字段，不能伪造跨任务引用。
room 渲染也只从当前已授权 payload 的 message map 取正文，绝不按 id 另发详情请求；因此即使
数据库被手工污染为跨任务 id，也只会显示“原消息不可用”。

### 2.2 migration

实现时先重读共享树 journal；当前 next 为
`0122_rfc229_workgroup_message_trigger.sql`：

```sql
ALTER TABLE workgroup_messages
ADD COLUMN trigger_message_id text
REFERENCES workgroup_messages(id) ON DELETE SET NULL;
```

不建索引：room 本就按 task 一次读取全量消息，前端一次建 map；后端没有
`WHERE trigger_message_id = ?` 查询。旧行由 nullable 语义自然为 null，禁止模糊 backfill。

迁移测试覆盖旧数据库升级、链式消息与任务级 cascade；实现前若并发 RFC 占用 0122，按实际
journal 顺延编号，绝不改写他人 migration。

## 3. 单一触发解析器

把 `services/workgroup/room.ts` 私有的 `resolveTriggerMessageId` 下沉到
`services/workgroup/context.ts`，命名为：

```ts
resolveMessageTurnTriggerId(
  memberId: string,
  maxMsgId: string | null,
  messages: readonly Pick<
    WorkgroupMessage,
    'id' | 'authorMemberId' | 'mentionMemberIds'
  >[],
): string | null
```

算法固定为：

1. `maxMsgId` 为 null、空串或 `'0'` → null；
2. 只看 `id <= maxMsgId`；
3. 必须 `mentionMemberIds.includes(memberId)`；
4. 必须 `authorMemberId !== memberId`（与 `hasUnconsumedMention` /
   `selectMemberSlices` 一致）；
5. 返回 id 最大者，否则 null。

`deriveWorkgroupRunHistory` 与消息持久化共用该函数。room 聚合的 `messagesLite` 补
`authorMemberId`，消除“执行卡指向 self-mention、实际回合由另一条消息唤醒”的漂移。

解析器不需要额外接收 cursor：fresh message-turn 只有在 cursor 之后至少存在一条有效 mention
时才会铸出，因此“全量 `<= maxMsgId` 中最新有效 mention”必然也位于 cursor 之后；adopted run
则以已持久化 shard max 为边界，不能再读已经推进的 cursor。这个证明用“旧 mention 已消费 +
新 mention 未消费 + 更晚 self-mention”组合测试锁住。

## 4. message-turn 写入链

### 4.1 固化 maxMsgId

`driveMessageTurn` 在执行前只解析一次该回合的 `maxMsgId`：

- fresh run：捕获 `turnMaxMsgId = maxMessageId(state.messages)`，铸 shardKey 与解析父消息都用
  同一个值；
- adopted run：从 `state.hostRuns` 中按 `adoptedRunId` 找到持久 row，解析其真实
  `msg:<memberId>:<maxMsgId>`；不得改用当前 room 最大消息，因为 clarify 期间可能又新增 `@`。
- shardKey 损坏或找不到父消息：null，禁止猜测。

在 `advanceMemberCursor` 前得到 `triggerMessageId`；因此 fresh/adopted 两条路径不受 cursor
已经推进影响。

### 4.2 传播

扩展内部写入参数：

```ts
interface PostMessageArgs {
  // ...
  triggerMessageId?: string | null
}
```

`PostMessageArgs` 的省略语义是普通消息写 null；`postMessage` 必须把
`m.triggerMessageId ?? null` 显式传进唯一行构造器。与 RFC-209 的 round 完整性闸口同形，
`RoomMessageRowArgs.triggerMessageId` 必须是**必填** `string | null`，不能依赖 nullable 列把
遗漏静默变成 null；路由中的所有裸构造路径显式传 null，并用源码锁覆盖构造点。

`persistWgMessages` 的 options 增加**必填** `triggerMessageId: string | null` provenance：
message-turn 传解析值，其它 leader/assignment/batch 调用显式传 null。函数只把它传播给获准
落库的 member chat；dropped-message 系统说明始终显式写 null。合法 `wg_result` 的独立
`postMessage` 调用也必须显式传解析值，避免可选参数在关键路径上造成静默丢关系。

message-turn `outcome.kind === 'done'` 时：

- `wg_messages` 中每个获准落库的 member chat 都继承 `triggerMessageId`；
- 合法 `wg_result` 转成的 member chat 也继承；
- dropped-message 系统说明、failed/protocol/system 消息不继承；
- 初始 free-collab planning 没有有效 mention → 自然为 null。

agent A 的 child message 若带 `mentionMemberIds=[B]`，后续 B 的 resolver 会把该 child 选为
直接父级；已有 `triggerMessageId` 不参与下一跳判定，不会递归复制祖先。

### 4.3 room wire 与 prompt 隔离

- `rowToMessage`、engine state load、room response mapper 显式带出 `triggerMessageId`；
- `WorkgroupRoomMessage` 通过 shared DTO 自动得到字段；
- `renderMessagesBlock` / prompt renderer 不读该字段，引用原文只在已授权的人类 UI 中展示；
- `wg.message.created` WS 帧仍只负责 invalidation，不增加正文或父消息数据。

用同一条 message fixture 分别设置 null / 非 null，断言 prompt 输出逐字节相同。

## 5. 前端组件与交互

### 5.1 公共引用原语

新增 `components/MessageReference.tsx`，作为可复用的消息引用原语，而不是在
`RoomTimeline` 内手写一次性 button chrome。接口承载：

- `author`；
- `body`；
- `unavailable`；
- `onActivate`（可用引用时必传）；
- `aria-label` / `data-testid`。

组件渲染真实 `<button type="button">`（不可用时为非交互容器），样式命名空间
`.message-reference`：

- 使用现有颜色 token / radius，不复制消息 bubble；
- 左侧细强调线、作者小标题、正文两行 clamp；
- `width:100%; min-width:0; overflow:hidden; overflow-wrap:anywhere`；
- `text-align:left`，保证右对齐 human bubble 内仍按阅读方向排版；
- hover 有轻量背景反馈，`:focus-visible` 使用 inset ring，符合 RFC-206 的 scroll-clip 合同。

### 5.2 消息索引与作者

`RoomTimeline` 对 `data.messages` 一次 `useMemo` 建
`Map<messageId, WorkgroupRoomMessage>`，避免每条消息 O(n) 查父级。当前消息与引用消息共用同一
`messageAuthorLabel` 解析器：

- system → 本地化“系统”；
- member → roster displayName，成员已移除时沿用现有 `@?` tombstone；
- human → `useUserLookup` 的 displayName / username / id fallback。

有 pointer 且 map 命中时在正文前渲染作者 + 两行 body；pointer 非 null 但 map 未命中时渲染
本地化不可用占位，不提供激活回调。引用块不递归渲染父级的引用。

### 5.3 跳转与高亮

`RoomTimeline` 继续拥有 log ref 与滚动状态，并新增：

- callback ref 维护的 `Map<messageId, HTMLElement>` 与目标 `tabIndex={-1}`；
- `highlightedMessageId` + 单个 timeout ref；
- `jumpToMessage(id)`：只从该 ref map 取当前 log 的目标，根据目标与 log 的
  `getBoundingClientRect()` 计算容器内居中 `scrollTop`，解除 tail-follow 后只调用
  `log.scrollTo({top, behavior})`，随后 `focus({preventScroll:true})` 并置高亮；
- 平滑跳转期间用 ref 暂停 tail-follow 的“仍在底部”判定，避免第一个微小 scroll event 把
  聊天室重新拉回末尾；滚轮/触摸可立即取消该程序化滚动状态；
- `prefers-reduced-motion: reduce` 时 behavior=`auto`，否则 `smooth`；
- 约 1.6s 后移除高亮；重复点击重置计时；unmount 清理高亮与滚动 timer。

不用字符串拼 CSS selector：shared/历史 fixture 的 message id 只保证 `string`，不能把“生产
通常是 ULID”误当成 DOM selector 安全合同；callback ref 同时天然把查找限制在当前 room。

高亮类使用静态颜色/box-shadow，不做脉冲动画。原消息仍保留自己的 leader/agent/human/system
语义，highlight 只叠加短暂 outline/tint。

## 6. i18n

中英对称新增：

- `workgroups.room.replyingTo`；
- `workgroups.room.openReferencedMessage`；
- `workgroups.room.referencedMessageUnavailable`。

测试走 key symmetry，并断言 aria-label 使用本地化文本而非只靠 title。

## 7. 测试策略

### 7.1 shared / migration

- `WorkgroupMessageSchema`：缺字段与 null 均解析为 null；合法 ULID/string 保留；
- migration：旧行升级后为 null；parent→child→grandchild 插入可用；删除 parent 时 child
  `SET NULL`；删除 task 不被自 FK 阻断。

### 7.2 backend 纯函数

`resolveMessageTurnTriggerId` table：

- human→agent、agent→agent；
- 一条消息 @ 两个成员；
- 多条 mention 取 `<= maxMsgId` 最新；
- cursor 后有新 mention 时，全量查找仍命中新 mention；其后 self-mention 不得覆盖；
- self-mention 排除；
- max 之后排除；
- null/空/0/无命中返回 null。

`deriveWorkgroupRunHistory` 与持久解析器对同一 fixture 必须得到同一 id。

### 7.3 backend 行为

- message-turn 返回多条 `wg_messages` + `wg_result`：所有 member rows 指向同一 parent；
- agent A `@B` 与 human `@B` 两条路径各一例；
- 同一 snapshot 的一条消息 `@A @B`，两次 run 输出相同 parent；
- 成员忙碌并在下一 snapshot 累积两条 `@` 时，固定 parent 是该 snapshot 内更新的一条；
- A 回复 `@C` 后，C 回复指向 A child 而非祖先；
- adopted run：shard max 固定在旧消息，clarify 期间新增 mention 不偷换；
- fc initial、leader、assignment、system/failure 为 null；
- room aggregate wire 带字段；
- prompt null/non-null byte-identical。

### 7.4 frontend

- 有 parent 显示 `回复 author` + body；无 parent 不渲染；坏 parent 显示不可用；
- parent 本身带 parent 时，child 引用块只渲染一层；
- 点击与 Enter/Space 激活调用 log-scoped `scrollTo`，目标获得焦点和 highlight；timer 清除；
- reduced motion 使用 `auto`；
- 一父多子和长文本/长单词 DOM 回归；
- `MessageReference` role/focus/testid 与 i18n 对称。

### 7.5 真浏览器

以真实 daemon + fixture-backed 工作组房间检查 UI seam；关系语义由 7.2/7.3 后端测试负责：

- desktop light：agent→agent 长正文引用、鼠标跳转、容器居中、程序化焦点与高亮；
- 390px dark：两行 clamp、引用/消息无水平溢出，quote subtree 无 critical/serious axe；
- reduced-motion：真实媒体偏好下用键盘 Enter 激活并同步落到目标附近；
- callback-ref fixture 使用包含 `:` 的非 CSS-selector-safe message id，证明跳转不依赖 selector
  转义。

## 8. 失败模式与回滚

- **adopted run 误绑新 mention**：只读持久 shardKey max，行为测试锁住。
- **runHistory 与消息引用漂移**：二者共用 resolver，禁止前后端各复制一份。
- **跨任务内容泄露**：前端只查当前 payload map，坏 id 不发请求。
- **prompt 污染**：golden 证明 metadata 不进 prompt。
- **焦点环/长文本裁剪**：inset ring + 两层真实窄屏检查。
- **migration 并发编号冲突**：实现前重读 journal，精确保留共享树其它 RFC。

单 PR 交付。回滚代码时保留 nullable DB 列无害；若整体回滚 migration，先回滚所有读取该列的
代码。发布不需要历史回填。
