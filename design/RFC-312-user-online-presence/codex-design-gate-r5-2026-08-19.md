# RFC-312 设计门第五轮记录（Codex，2026-08-19）

- 评审对象：v5；新增视角：**敌手视角 / 运维可观测性 / 跨 RFC 交互**（前四轮未用过）
- 执行：worktree 重新 pin 到 `f8b2a3a8` + `codex exec --sandbox read-only < /dev/null`，session `01a01898`
- 结论：**仍不可进入实现**——V4-2/V4-4 真修好，V4-1/3/5 表面修好，**V4-6 未修**；新增 W5-1…W5-7（5×P1 + 2×P2）
- **本轮最重**：W5-5——普通用户重放一次自己有权做的 no-op 写（相同成员集 PUT），
  即可触发一次全网复核 ⇒ 约 3000 次 WS send / 72MB / 21k DB 读，可循环执行。
  该放大正是 v4「每次复核给每条持权连接重发快照」这条简化引入的。

---

## ① V4-1…V4-6 核验

| 编号 | 判定 | 核验结论 |
|---|---|---|
| V4-1 | **表面修好** | 增加了 `drain`，但 `send()===0` 与“之后一定触发 drain”并不等价：Bun 只保证曾进入背压后会 drain；修复快照自身也可能再次返回 0，而设计仍不检查结果。原来的永久陈旧仍可发生。`design.md:156` `serve.d.ts:3` |
| V4-2 | **真修好** | 在单独职责上，写 actor 前拒绝较低 `authorityRevision`，确实阻止了“旧 pass 晚完成后覆盖新 actor”。但它与 pass 合并、freeze 所有权组合后产生新的 W5-1，不推翻本项结论。`design.md:202` |
| V4-3 | **表面修好** | “收到 `authority.changed` 即同步 reset”是可执行状态机，但触发它的控制帧本身可静默丢失；撤权后规则 2/3 又不再给该连接发 presence 帧，因此客户端可永远不 reset。另外 plan T7 同时写了“reset”与“忽略 authority.changed”。`design.md:164` `plan.md:79` |
| V4-4 | **真修好** | I1 已给出唯一生产装配路径：bootstrap 闭包捕获 presence command/query，经 adapter deps 传入，并规定测试 replace/reset。对当前单 daemon 形态足够确定。`design.md:634` |
| V4-5 | **表面修好** | 72MB/3000 fence 的数量级已算对，但只消除了重复序列化，没有限制发送量；“重叠 pass 合并”没有算法；AC-28 也没有可判定的 DB 时间/字节上限。容量失败仍会发生。`design.md:442` |
| V4-6 | **未修** | 活跃 plan 仍要求三变体/`revoked`、`flush`、PR 后端收 `revoked`；T7 一行要求消费 `authority.changed`、下一行又要求忽略；验收清单止于 AC-26，漏 AC-27/28/29。设计正文 §6.1 也仍有 `presence.revoked`。`plan.md:19` `plan.md:131` |

## ② 新 findings

### W5-1 — P1：pass 合并与低 revision 放弃没有共同的所有权模型

- **结论**：会吞掉本应发生的尾随复核/解冻，导致永久 `revalidating=true`；AC-29 当前反而要求低 pass 不解冻，却没有证明谁负责解冻。
- **证据**：设计只写“重叠则合并”，没有 `requestedGeneration/processedGeneration` 或 dirty-tail；现状只有共享布尔值，由 trigger 置 true、任意 pass 清 false。`design.md:453` `connections.ts:239`
- **具体失败时序**：

  1. A 在 revision 10 开始，读到旧 actor，停在 gate。
  2. revision 11 提交，B 触发并再次 freeze；按“重叠合并”被并入 A，没有真正启动尾随 pass。
  3. A 继续以 revision 10 完成；它并不低于当前已写最大值，清 freeze 后发快照。
  4. 出站 fence 读到 DB revision 11，丢快照、重新置 `revalidating=true` 并触发 C。
  5. C 在 A 尚未返回时也被“合并”；A 返回后没有尾随 worker，socket 永久冻结、actor 仍旧。

  即使两个 pass 都实际运行，**相同 authority revision** 的 task-members 复核也无法由 revision 守卫排序，早 pass 可在晚 pass 仍运行时错误解冻。
- **建议**：每 socket 单 worker + `requestedEpoch/processedEpoch` + dirty loop；只有处理到最新 requested epoch 的 owner 才能解冻和发一次快照。低结果只能丢弃结果，不能丢弃 pending 工作。`triggerRevalidationAndWait` 必须等待对应 commit 之后启动的 pass 完成。
- **性质**：**设计方向**。

### W5-2 — P1：`authority.changed` 丢失会让撤权客户端永久保留旧名单

- **结论**：这是 V4-3 的直接残余失败，也是信息泄漏。
- **证据**：当前 `sendAuthorityChanged` 与 `sendJson` 一样忽略 `ws.send()` 数值结果；规则 2/3 又都要求 fresh actor 仍持有 `users:presence`。`connections.ts:220` `design.md:156`
- **具体失败时序**：

  1. 客户端已水化并持有全平台名单。
  2. 管理员撤销 `users:presence`。
  3. pass 刷新 actor 后发送 `authority.changed`，但 `send()` 返回 0；不抛错、不关连接。
  4. fresh actor 已失权，因此规则 2 不发 snapshot；以后 drain 时规则 3也不发。
  5. AC-8 又要求 authority socket 保持连接。客户端从未收到 reset 信号，旧 roster 可保留到下一次权限变更或重连，时间无上界。

- **建议**：控制帧必须检查 send status。最小可靠方案是 `authority.changed` 返回 0 时直接关闭连接，利用 transport reset；另一方案是独立于 presence 权限维护 control-dirty，并在 drain 重发当前 authority revision。必须新增“撤权 + authority.changed 返回 0”的贯穿测试。
- **性质**：**协议设计方向**。

### W5-3 — P1：`drain` 修复链不闭合，而且与 pass 重发并非容量幂等

- **结论**：整体替换只保证内容幂等，不保证交付和资源幂等。
- **具体失败时序**：

  1. `authority.changed` 成功，客户端同步 reset。
  2. 随后的 snapshot 返回 0，客户端停在未水化。
  3. drain 触发后修复 snapshot 再次返回 0；设计不检查结果，也没有 dirty bit、重试上限或 fail-close。
  4. 若之后没有新的背压解除、复核或重连，永久未水化。

  并发时，规则 2 与 drain 可各发送一份全量快照。按 v5 规模，两路同时覆盖 3000 socket，可形成约 **144MB + 6000 次 fence**，不是“无害”。

  还有通道边界缺口：I11 只说在 `server.ts` 的通用 handler 加 drain 并检查 actor 权限；当前 handler 接收所有 channel。按字面实现会向持权用户的 task/workflow socket发送 presence schema。`server.ts:79`
- **建议**：把 recovery 做成 authority registry 的显式 `onDrain`，不是 server 通用旁路；仅当某次 presence send 失败时标记 `presenceDirty`；按 connection+generation 合并；检查修复 send 结果，有限重试后关闭。AC-27 增加“修复帧再次失败”“非 authority drain”“drain 与 pass 同时发生”。
- **性质**：**设计合同 + 实现细节**。

### W5-4 — P2：generation-only 缓存可跨过 grace 截止时间

- **结论**：与“快照反映最新真值”冲突。
- **具体失败时序**：

  1. 用户最后连接关闭，`graceUntil=T`；generation 为 g，缓存快照仍包含该用户。
  2. 到 T 后事件循环繁忙，`reapExpired()` timer 已到期但尚未执行。
  3. drain/复核先执行并命中 generation g 的缓存。
  4. 实时 `snapshot()` 按当前单调时钟本应判离线，缓存却仍发送在线。

- **建议**：缓存键除 generation 外必须有 `validUntil=min(graceUntil)`；`now>=validUntil` 时先物化到期状态并 bump generation，或绕过缓存。增加“延迟 reaper、截止时间后先取快照”的测试。
- **性质**：**实现细节，但必须进入设计合同**。

### W5-5 — P1：普通用户可把小请求放大为全网复核风暴

- **结论**：AC-28 没有覆盖可调用频率、no-op 写、连接配额，也没有真正的数值预算。
- **证据**：普通 user baseline 持 `tasks:update`；任务 owner 可 PUT members。即使 body 与原值相同，代码仍 delete/insert 并无条件等待全量 `task-members-changed` 复核。`taskCollab.ts:164` `taskCollab.ts:252`
- **具体滥用时序**：

  1. 攻击者创建/拥有一个任务。
  2. 读取当前成员列表。
  3. 对 `/api/tasks/:id/members` 循环 PUT 完全相同的 body。
  4. 每次等待 200 后再发下一次，绕开“重叠 pass 合并”。

  按 v5 的 1000 人/3000 authority 连接，且沿其现有约 2 WS/tab 推算 `L≈6000`：

  - 全量复核：`3×L≈18,000` 次串行读；
  - snapshot fence：再加 3000 次同步读；
  - 出站：约 72MB、3000 个 WS send。

  即**一个约 1KB HTTP 请求 → 约 72,000 倍出站字节、约 21,000 次 DB 读**。
- **建议**：相同成员集直接 no-op 且不触发复核；task 变更只 target 受影响用户；按 actor/task 限速；按用户/session 限制 authority 连接数；设置每轮复核最大连接、最大出站字节及 p95 时间。AC-28 必须写具体上限，现在“落在预算内”没有可判定数字。
- **性质**：**安全与容量设计方向**。

### W5-6 — P1：v5 三件套仍给出互斥实现合同

除 V4 表中的 plan 残留外，design §6.1 仍要求 `presence.revoked`，测试清单仍写三变体；而 §3.3 明确只有两变体。`design.md:136` `design.md:355`

建议全局机械归一，并把 AC-27/28/29、actor 守卫、drain、缓存与 pass worker 明列为任务和验收项。性质：**实现细节/文档合同**。

### W5-7 — P2：核心链路没有可定位的可观测性

现有 revalidation 只有关连接时才写汇总日志；`send()===0` 没日志；公开 health 只有 identity-access 汇总计数，没有 presence 登记、交付或水化信号。`connections.ts:214` `health.ts:54`

性质：**运维设计方向**，详见下节。

## ③ 敌手视角

| 能力 | 可执行步骤 | 放大/结果 |
|---|---|---|
| 名单枚举 | 建 authority 连接，取 snapshot 中全部 ID；每 200 个调用一次 `/api/users/lookup` | 900 在线用户只需 **1 个快照 + 5 个 lookup** 即还原姓名/角色。属于用户已接受的 F12，不作为待决，但应审计。 |
| 活动模式推断 | 长期记录 `presence.changed` | 上线约 0.5–1s 粒度；正常离线约 60.5s，硬断最坏约 180.5s。可推断作息、会议、集中上线等。 |
| no-op 复核攻击 | 重放自己任务的相同 members PUT | 每请求约 **3000 WS send、72MB、21k DB reads**；可顺序执行，不受 overlap 合并保护。 |
| 连接喷洒 | 同一 session 脚本化打开 K 条 authority socket | `K=1000` 初始快照约 **24MB**；以后每个批次增加 1000 次 fence/send，每次全量复核再增加约 4000 读和 24MB。设计没有 per-user connection quota。 |
| 连接抖动 | 最后一条连接断开并等过 60s，再重连 | 引用计数和 grace 能挡住快速抖动；要制造两次全网翻转需约 60.5s。P=3000 时约 `2P=6000` 次 send/fence，即长期约 **99 次/秒**，不是最便宜攻击。 |
| 慢读/drain | 打开 K 条 socket 停止读取，并结合复核攻击堆积队列；恢复读取触发 drain | 900 人快照约 24KB，默认 16MB 缓冲约需 683 份快照；每次 drain 又增加 `K×24KB + K fence`。单独不如 no-op PUT，但组合后形成反馈放大。 |

敌手结论：隐私暴露本身已被拍板接受；当前真正未封闭的是**普通写能力可触发全局控制面工作**以及**单账号连接数可线性扩大所有广播成本**。

## ④ 运维可观测性缺口

线上出现“明明在线却显示离线”，目前**无法判断是哪一段**：

| 环节 | 当前缺口 | 最低需要 |
|---|---|---|
| 权限 | 有 grant/audit，但无法关联某条 socket 当时的 effective revision | 受保护诊断中显示用户当前 permission、socket actor revision、最近 authority revision |
| 登记 | 只有全局 live set，没有 per-user presence refcount/grace/generation | `presence_connections`、online/grace 数量、open/close/reap 计数及最后原因 |
| 帧交付 | 0/-1 无日志，drain 无指标 | 按 frame type 统计 send success/drop/backpressure、drain、repair success/failure |
| 复核 | 只有发生关闭时的汇总 | `passId/reason/requestedEpoch/processedEpoch/coalesced/tailRun/freezeDuration` |
| 客户端水化 | `hydrated=false` 可同时表示断线、撤权、reset 后丢 snapshot | 支持包中记录 auth generation、socket 状态、最后 control revision、最后 snapshot generation、最后 reset 原因 |

不要在普通日志记录完整 roster；用连接相关 ID、计数和受保护的按用户诊断即可。

## ⑤ 跨 RFC 交互

### RFC-311

- **真实负载叠加**：RFC-311 已明确把“每帧每订阅者同步 fence SELECT”留给后续；RFC-312 在常态广播之外新增 3000 点查/全量复核及可滥用快照风暴，会与 mission、任务查询争用同一 SQLite/事件循环。`RFC-311 plan.md:76`
- **backup 移出主线程是正向作用**，没有数据冲突；bounded archive sweeper 也没有所有权冲突，但每批同步工作仍会放大 grace timer 延迟，从而暴露 W5-4。
- **facets 缓存无直接冲突**；但不能照抄无过期 generation cache，因为 presence 真值随单调时间变化。
- **十万级列表交互真实存在**：RFC-311 把 `/users` 虚拟化列为后续项，而 RFC-312 会在每个 presence batch 更新模块级 store。若每个 `PresenceDot` 都因 store 新引用重渲染，未虚拟化的大用户列表会重新出现全列表渲染风暴。应采用按 userId selector/细粒度订阅，并给 `/users` 接 VirtualList 或明确规模上限。`RFC-311 plan.md:71`

### RFC-310

- **无领域事实、schema 或 writer 冲突**；presence 不应进入 Mission 聚合。
- 有**共享资源叠加**：mission 页面仍有 5s/10s/15s 轮询，复核风暴会延迟 mission 列表、详情和决策轨迹刷新。`code.missions.tsx:69`
- RFC-310/311 的 mission 分页与前端文件仍有协调账；RFC-312 不需要触碰这些文件。
- 新增权限会把当前 `PERMISSIONS.length=108` 改为 109，admin 长度同步变化；user baseline 长度仍应保持 82，因为 presence 是 additional grant。这是机械协同，不是设计冲突。`permission.test.ts:75`

## ⑥ 整体判断

**不可进入实现。**

硬阻断项：

- **W5-1**：定义单 socket 的 pass 排队、尾随执行与 freeze 所有权。
- **W5-2**：闭合撤权控制帧丢失。
- **W5-3**：闭合 drain 重试、限定 authority 通道并消除双路径容量反馈。
- **W5-5**：关闭普通用户 no-op 全量复核与连接喷洒放大。
- **W5-6**：归一 proposal/design/plan/AC 的活跃合同。

下一版门禁同时必须补齐 **W5-4、W5-7** 的验收合同；否则即使核心协议实现正确，也仍无法保证“快照是最新真值”或在线上定位失败段。
