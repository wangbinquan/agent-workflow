# RFC-229 设计门（2026-07-26）

结论：**APPROVED（2 个 P1、1 个 P2 已全部折入设计；用户随后已批准并完成实施）**。

审查由当前 Codex 会话在本地只读完成，没有调用外部子进程或委派 agent。审查逐项重读
RFC-229 三件套与 live source 的 message wake、fresh/adopted mint、clarify frontier、消息写入、
room aggregate、prompt renderer、timeline scroll/focus 和 migration journal。

## Findings

| 级别 | 问题                                                                                                                                                                                    | 裁决 / 修正                                                                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | 初版让 `buildRoomMessageRow` 缺省写 null。该列 nullable，五处裸构造器与未来写点即使漏传也能通过 typecheck，会把“忘记传播 parent”静默伪装成合法无父消息，重演 RFC-209 的 omission 风险。 | `RoomMessageRowArgs.triggerMessageId` 改为必填 `string \| null`；所有裸构造点显式传 null，`postMessage` 统一归一化并传入，源码锁覆盖构造点。                                                            |
| P1   | 初版只说 `persistWgMessages` “增加参数”，仍可能让 message-turn 的多消息或独立 `wg_result` 调用遗漏 parent；dropped system note 也可能被一刀切误继承。                                   | `persistWgMessages` options 的 provenance 改为必填；message-turn 显式传解析值，其它调用显式传 null；只传播 member chat，dropped system note 固定 null；`wg_result` 的 `postMessage` 单独显式传 parent。 |
| P2   | 初版跳转方案依赖“DOM id 由 ULID 组成”。shared 合同只保证任意 string，历史/fixture/损坏 id 可能让 CSS selector 失效或越界，且 document 级查找不天然限定当前 room。                       | `RoomTimeline` 改用 callback ref 维护 `Map<messageId, HTMLElement>`；跳转只从当前 log 的 map 取目标，不拼 selector。                                                                                    |

## 已核实的不变量

- fresh message-turn 的 shard max 与 parent 解析来自同一不可变 state snapshot；
- RFC-172 `buildFrontierMintPlan` 对 member shard 做同 shard 继承并显式覆写 `shardKey`，
  adopted/clarify continuation 可从 `state.hostRuns` 取回原 `msg:<memberId>:<maxMsgId>`；
- wake 只有在 cursor 后存在非 self 的有效 mention 时才铸 run，因此解析全量
  `<= maxMsgId` 的最新有效 mention 不会退回已消费旧消息；adopted 路径不依赖已推进 cursor；
- `renderMessagesBlock` 只读 author/body，新增 metadata 可保持 prompt byte-identical；
- 当前 room 一次返回全量已授权消息，前端 map miss 可安全显示不可用，不需要按 parent id
  追加跨任务查询；
- SQLite 本地探针验证 nullable self-FK 的 `ON DELETE SET NULL` 与 task `ON DELETE CASCADE`
  可以共存；实现时仍以正式 migration 测试锁住。

## 范围裁决

- human→agent 与 agent→agent 完全同合同；
- 同一 snapshot 的一父多 agent 得到相同 parent；
- 若成员忙碌并累积多条未消费 `@`，其单父引用取固定 snapshot 内最新有效 `@`，不伪造多父
  thread；
- leader/assignment/system、旧行与坏 shard 无唯一父级时保持 null；
- 本 RFC 不增加手动 reply composer。
