# RFC-215 — free_collab 双轨调度与批量认领（proposal）

- 状态：Draft（2026-07-21）
- 来源：用户生产环境定位——自由工作组任务清单持续堆积无人处理
- 关联：RFC-164（工作组内核，本 RFC 修订其 §4.2/§6.3 的 fc 调度语义）、RFC-209（回合账本，预算口径沿用）

## 1. 背景与问题

用户在生产环境观察到：free_collab 工作组里 agent 热衷讨论时，讨论中创建的任务卡
（`wg_tasks_add`）无人认领、越积越多，最终任务以清单剩一堆 open 卡收场。

对本仓代码用纯函数探针（直接驱动 `deriveWakeSet`，`workgroupWake.ts:158`）实证了三个
互相叠加的机制，确认这是 RFC-164 设计层就存在的结构性问题，不是实现走样：

1. **空闲状态共用，消息回合排他占用成员。** fc 唤醒派发里，消息回合（step 2）与任务
   认领配对（step 4fc）共用同一个 `busyMemberIds`（`workgroupWake.ts:146`），其中
   in-flight 消息回合的成员算 busy。实测：全员在跑消息回合时，3 张 open 卡的认领派发
   数为 **0**，outcome 恒 `running`。讨论热（每回合输出又 @ 出新消息、re-arm 下一个
   消息回合）时成员几乎永远被消息轨占住，认领窗口极窄。
2. **回合预算共池且消息回合先占格。** fc 的 `roundsUsed` = 成员 run 总行数（**含**消息
   回合，`workgroupRounds.ts:117`），与认领共享同一个 `maxRounds` 预算，且 wake 派发
   按 push 顺序逐格检查——消息回合在前。实测：预算剩 2 格、3 条未读 @ 消息 + 2 张
   open 卡 → 2 格全被消息回合吃掉，认领 0、`capExceeded=true`，随后任务以
   `failed (max-rounds)` 收场，清单剩一堆 open。
3. **认领粒度 1 卡 1 run，消化速度结构性落后生产速度。** 每张卡独立烧一格预算 + 一次
   完整 opencode 进程启动；而讨论侧一个消息回合最多可 `wg_tasks_add` 32 张卡
   （`WG_MAX_TASKS_ADD_PER_TURN`）且消息回合本身也在烧预算。生产快、消化慢、预算被
   双向挤压。

附带实锤一个真 bug（**同 pass 双重占用**）：step 2 刚派到消息回合的成员没有进入
step 4fc 的 busy 集合，同一成员会在同一个 wake pass 里同时拿到 `message_turn` +
`fc_claim` 两个并发 run（探针 S1 实测），违反设计"空闲成员代领"的判定意图，且两个
run 结束时会竞争推进同一个成员游标（`advanceMemberCursor`）。

## 2. 目标

- **G1 双轨并行互不占用**：消息轨（消息回合）与任务轨（认领/执行）各自独立判定成员
  占用——讨论不再阻塞认领，认领也不再阻塞回复。同轨内保持互斥（一成员同轨至多一个
  in-flight run）。
- **G2 批量认领**：空闲（任务轨）成员一次领走一批 open 卡——open 清单按创建序均分给
  全部空闲成员，每批上限 5 张；一批一个 run、一格 `maxRounds` 预算、逐卡汇报结果。
  任务消化速度从"每 pass 每空闲成员 1 张"提升到"× 批大小"，预算消耗除以批大小。
- **G3 游标单一归属**：双轨并发下，成员消息游标只由消息轨推进；任务 run 不再兼职消费
  @ 消息（防双推进竞态与同一批消息被两个 run 重复回复）。
- **G4 预算末端保任务**：fc 唤醒派发顺序改为认领批先入、消息回合后入——预算只剩最后
  几格时优先花在承诺的工作上，而不是又一轮讨论。
- **G5 零涟漪边界**：卡状态机（`open→dispatched→running→done/failed→open`）、fc 收敛
  与 fc-deadlock 判定、`deriveRoundsUsed` 口径、leader_worker 全链路、dynamic_workflow
  一律不变。

## 3. 非目标

- **生产端阻尼**（open 卡数阈值 prompt 提示 / 硬顶拒收 `wg_tasks_add`）——用户拍板
  不做，先观察调度修复后的实际堆积情况。
- **批次间 session 续接**（同成员下一批复用上一批的 opencode session 以省启动开销）
  —— deferred，平台已有 session 续接原语（RFC-164 §4.5），另立 RFC。
- **leader_worker 的消息/任务并轨调整**——lw 由 leader 派单驱动，无认领饥饿问题。
- 批大小的工作组级配置项——v1 固定常数 5，需要时后续升级为配置。

## 4. 用户故事

- **US-1**：作为工作组的使用者，我让一个 5 人自由组去完成一个可拆解的目标；成员们
  在黑板上讨论拆解出 12 张任务卡。我期望讨论进行的同时任务卡就被并行消化掉，而不是
  等讨论烧完全部回合预算后任务原封不动。
- **US-2**：作为使用者，我看到成员 A 一次领走了 4 张相关的卡并在一个 run 里逐张给出
  结果——而不是 4 次进程启动、4 格预算。
- **US-3**：作为使用者，成员 B 正在执行任务批时被 @ 了一个协调问题；B 的消息回合照常
  被唤起回复，任务批不中断。
- **US-4**：作为使用者，批 run 中途失败（超时/进程崩）后,批内的卡回到清单被其他成员
  重新领走，重试次数有上限，不会无限循环。

## 5. 验收标准

- **AC-1（两轨互不占用）**：全部 agent 成员均有 in-flight 消息回合时，存在 open 卡
  ⇒ `deriveWakeSet` 仍派发认领批；反向：成员有 in-flight 任务批时收到新 @ 消息 ⇒
  消息回合照常派发。同轨互斥保持：任务轨 busy 成员不再配批，消息轨 in-flight 成员
  不重复派消息回合。
- **AC-2（批量均分 + 上限）**：N 张 open 卡、K 个空闲成员 ⇒ 按创建序连续切片均分，
  每批 `min(5, ceil(N/K))` 张，超出部分留在清单等下一波；一批 mint 一个 run，占一格
  预算。
- **AC-3（逐卡汇报）**：批 run 通过新端口逐卡回报（按批内序号），每张卡独立落
  result 消息与 `done`/`failed` 状态；漏报卡经协议重试仍缺 ⇒ 缺的卡回 `open`。
- **AC-4（失败语义）**：批 run 整体失败（超时/崩溃/协议耗尽）⇒ 整批回 `open`；单卡
  重试预算沿用 `DEFAULT_PROTOCOL_RETRY_BUDGET`（按卡计数,不因批量而放大或丢失），
  达预算的卡留 `failed`。
- **AC-5（游标归属）**：fc 任务批 run 结束**不**推进成员游标、prompt 不注入
  「Messages addressed to you」切片；消息回合照旧消费 @ 消息并推进游标。lw worker
  的 assignment run 行为不变（回归锁）。
- **AC-6（预算末端保任务）**：预算仅剩 1 格且同时存在可配批与可派消息回合 ⇒ 批占格,
  消息回合被 `capExceeded` 抑制。
- **AC-7（崩溃恢复）**：daemon 重启后——`dispatched` 失驱卡（无 in-flight run）按
  assignee 重新集结成批驱动；host 行被 boot reaper 打成 `interrupted` 的 `running` 卡
  经 `reconcileRunningAssignments`（按卡上 `nodeRunId` 直查，批适配）打回重配；host
  行已 `done` 而逐卡落库中断的卡逐卡收 `done` **不重跑**已完成工作。
- **AC-8（lw 零变化）**：leader_worker 的唤醒、busy 判定、单卡协议、游标推进与现状
  逐位一致（既有测试全绿 + 新增回归锁）。
- **AC-9（收敛不变）**：fc 收敛（清单 drained ⇒ done 汇总消息）、fc-deadlock、
  max-rounds/wrap-up 语义与现状一致。
- **AC-10（前端与房间可见性）**：任务卡列表能看出"同批"关系（同 run 分组徽记），逐卡
  结果展示照旧；批 run 在房间 runHistory / 成员 presence / clarify 泊车投影中正常可见
  （`workgroupRoom.ts` 分类器批适配，不得隐形）；复用既有公共组件/样式，i18n 双语。
- **AC-11（反问预算跨批稳定）**：fc 任务批 run 的 clarify askerKey 按成员稳定
  （`asg:batch:{memberId}`）——卡回 open 重组批次不重置反问预算、人类 stop 指令跨批
  仍命中。
