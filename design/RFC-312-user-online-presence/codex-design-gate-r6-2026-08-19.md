# RFC-312 设计门第六轮记录（Codex，2026-08-19）

- 评审对象：**v6 整份重写**（独立 `/ws/presence` 通道）
- 本轮专设视角：**重写有没有丢东西**（拿五份记录逐条比对"仍在 / 丢了 / 不再适用"）
- 执行：pin 到 `f8b2a3a8` 的分离 worktree + `codex exec --sandbox read-only < /dev/null`，session `01a018b6`
- 结论：重写**未丢失**已修好的结论（F1-F14 多为"仍在"，F3/F9/F10 判"新架构下不再适用"）；
  新增 **V6-1…V6-8**（7×P1 + 1×P2），仍判不可进入实现

---

## ① 重写丢失清单

### 第一轮 F1–F15

| 编号 | 判定 | v6 状态 |
|---|---|---|
| F1 | 仍在 | fence DB 成本已如实计账，并要求真实 SQL spy。`design.md:295` |
| F2 | 仍在 | 显式 grant、admin 例外、user/manager backfill 均保留；但测试文本又出现 admin 矛盾，见 V6-1。 |
| F3 | 新架构下不再适用 | 同一 authority socket 上的 presence grant/revoke 重同步协议已删除；但“授予后前端如何可靠得知”形成新 V6-2。 |
| F4 | 仍在 | `{hydrated, onlineIds}` 与 `undefined/true/false` 三态完整保留。`design.md:320` |
| F5 | 仍在 | 60s 从服务端确认关闭起算、120s WS idle、硬断 180s 均保留。 |
| F6 | 仍在 | epoch 后重跑完整 `checkUpgradeGate`、失败永不登记已保留。`design.md:185` |
| F7 | 仍在 | 真 daemon、双浏览器上下文、最终 DOM 的 e2e 保留。 |
| F8 | 仍在 | grace/batch 两个独立 port、`pending`、双空才零 timer 均保留。 |
| F9 | 新架构下不再适用 | presence 通道无 `frameGate`，不再可能连坐过滤 authority 控制帧。 |
| F10 | 新架构下不再适用 | 原结论要求不要造假 `/ws/presence`；v6 现在真新增通道，并明确更新双射/onOpenExtra 锁。`design.md:128` |
| F11 | 仍在 | `graceUntil` 明确为单调刻度，双时钟测试保留。 |
| F12 | 仍在 | 全平台名单与 lookup/轨迹暴露面完整披露，属用户接受风险。 |
| F13 | 仍在 | 定义已收窄到 AppShell，`/auth` 离线。 |
| F14 | 仍在 | 重启为未知/无点，三态合同一致。 |
| F15 | 仍在 | `TaskMembersPanel` 两分支和真实 `UserPicker` 渲染点均保留。 |

### 第二轮 N1–N7

| 编号 | 判定 | v6 状态 |
|---|---|---|
| N1 | 仍在 | admin 天然持有、无默认 grant/backfill 的真值表仍在。 |
| N2 | 仍在 | HTTP/CLI、OIDC、bootstrap 统一 provisioning seam 保留。 |
| N3 | 新架构下不再适用 | `presenceGranted` 边沿缓存已消失；通用 actor 单调责任另由 §5.3 承担。 |
| N4 | 新架构下不再适用 | `presence.revoked` 与 fenced direct 出口全部删除。 |
| N5 | 仍在 | 单调 lifecycle、install-or-release、close-before-install 对消完整保留。 |
| N6 | 仍在 | auth revision、transport close、最后订阅者 release 的 reset 保留。 |
| N7 | 仍在 | `idleTimeout:120`、`sendPings:true`、嵌套配置断言保留。 |

### 第三轮 R3-1–R3-7

| 编号 | 判定 | v6 状态 |
|---|---|---|
| R3-1 | **丢了/弱化** | 文档声称冻结丢帧会置 dirty，但唯一置位规则只覆盖 `send()` 结果；真实冻结分支在 send 前直接 return。见 V6-4。 |
| R3-2 | 新架构下不再适用 | actor 边沿状态与客户端 delivery revision 已删除；普通 fence/drop 恢复改由 dirty 负责。 |
| R3-3 | 仍在 | epoch 后完整通道 gate 保留。 |
| R3-4 | 仍在 | client close 与 server `closeConnection` 都推进终态，单次释放句柄保留。 |
| R3-5 | **丢了/弱化** | §6.1 真值表正确，但 shared/plan 又要求“不进任何 ROLE_PERMISSIONS”，与动态 admin baseline 冲突。见 V6-1。 |
| R3-6 | **丢了/弱化** | “grant/audit/view 同源”文字仍在，但默认权限与操作者显式权限先 union，缺逐 permission provenance。见 V6-1。 |
| R3-7 | 仍在 | reset 明确归物理连接生命周期，并有双订阅者反例。 |

### 第四轮 V4-1–V4-6

| 编号 | 判定 | v6 状态 |
|---|---|---|
| V4-1 | **丢了/弱化** | `send()===0` 虽置 dirty，但 0 不保证未来有 drain，仍可永久陈旧。 |
| V4-2 | 仍在但未闭合 | revision 守卫与 per-socket worker 写回，但 `triggerRevalidationAndWait` 尾随等待、全通道语义仍缺。见 V6-7。 |
| V4-3 | 新架构下不再适用 | 撤权不再靠客户端收到控制帧后自清；服务端关独立 presence socket。授予侧另见 V6-2。 |
| V4-4 | 仍在 | bootstrap 闭包捕获 command/query、replace/reset 语义保留。 |
| V4-5 | 新架构下不再适用 | “每 pass 给所有连接发全量快照”的放大路径删除；新连接/复核成本预算另有错误，见 V6-5。 |
| V4-6 | 新架构下不再适用 | 旧 revoked/三帧/flush 冲突已清掉；新权限文本仍有另一处互斥合同。 |

### 第五轮 W5-1–W5-7

| 编号 | 判定 | v6 状态 |
|---|---|---|
| W5-1 | **丢了/弱化** | 最新 epoch owner 解冻写回，但“awaited trigger 必须等对应 tail pass”没有保留。 |
| W5-2 | 新架构下不再适用 | 撤权数据泄漏不再依赖 `authority.changed`；授予仍依赖它，形成新问题。 |
| W5-3 | **丢了/弱化** | dirty/drain 方向写回，但 dirty 入口与无 drain 的失败出口都未闭合。 |
| W5-4 | 仍在 | `(generation, validUntil)` 与截止前物化到期状态完整保留。 |
| W5-5 | 新架构下不再适用 | no-op 复核不再触发 3000 份快照；仍有全连接 DB 复核，源头修法本身有新竞态。 |
| W5-6 | 新架构下不再适用 | 旧三件套冲突通过整份重写消失。 |
| W5-7 | **丢了/弱化** | AC-26 只覆盖中间计数，仍不能定位 grant/admission/client hydration 段。 |

合计：**仍在 23、丢失/弱化 7、新架构不再适用 12。**

用户特别点名的短合同中：

- 已完整保留：单调时钟、install-or-release、单次释放句柄、零参 query、两 timer 不共用回调、缓冲初末态、快照同步临界区、sentinel 返回 `undefined`、按可达角色矩阵、e2e stderr。
- 部分保留：测试正向控制、审计同源。
- `stderr` 捕获其实当前基线已经具备，不是待实现能力：`e2e/harness.ts:328`。

## ② 新 findings

### V6-1 — P1：权限唯一真值表再次被测试合同推翻，默认/显式 grant 也没有可执行 provenance

**结论**

不重新质疑 admin 天然持有；问题是 v6 同时要求：

1. admin 因 `ROLE_PERMISSIONS.admin=[...PERMISSIONS]` 持有；
2. `users:presence` “不进任何 ROLE_PERMISSIONS 预设”；
3. 默认 presence 与操作者显式 grant 先 union 成一个数组，却又要求逐项归因可区分。

三者不能同时实现。

**证据**

- 正确真值表：`design.md:225`。
- 冲突文本：`design.md:247`、`design.md:385`。
- 实际 admin 定义：`permission.ts:1058`。
- 当前 create command 对整枚数组使用同一 `grantedByUserId`：`createManagedUser.ts:73`。

**具体失败时序**

管理员创建普通 user，同时显式授予 `scripts:author`：

1. 默认集产生 `users:presence`。
2. 调用方显式集含 `scripts:author`。
3. C7 要求先 union。
4. 若统一使用 admin id，presence 被错误记录为管理员手工授予。
5. 若统一使用 null，`scripts:author` 丢失真实授权人。
6. shared 测试若 literal 断言“任何 preset 都不含 presence”，又必与 admin 全集测试互相打红。

**建议**

- 文本改成：“不进入 user/manager/guest 静态 preset；admin 由全量动态 baseline 自动包含。”
- provisioning 输入保留两份集合或直接使用 `InitialGrantSpec[] { permission, origin, grantedByUserId }`；只有 view/audit 的权限集合可取 union。
- 增加“一次创建同时含默认 presence + 显式 scripts”归因测试。

**性质**：实现/验收合同缺陷，不改变 admin 裁决。

---

### V6-2 — P1：独立通道只闭合了撤权，授予仍依赖无上界的 lossy authority 收敛

**结论**

“服务端零参与、前端自然重订阅”不是完整机制。前端只有收到 `authority.changed` 或 authority socket 重连，才会重新取 `/me`；两者都没有最终收敛保证。

**证据**

- v6 的授予假设：`design.md:132`。
- `sendAuthorityChanged` 只处理 throw，忽略 `send()==0/-1`：`connections.ts:220`。
- 前端只在收到帧时 invalidate：`useWebSocket.ts:172`；物理 authority open 才做补偿：`useAuthoritySync.ts:20`。
- `/me` 只有一次 retry，且不随 window focus 自动重取：`query-client.ts:43`。
- 4403 不停止重连；只有 4401 清 token：`useWebSocket.ts:201`。
- C2 的“完整 pass 顺序”甚至漏写现存的 `authority.changed` 发送：`design.md:372`。

**具体失败时序**

1. 用户原本无 `users:presence`。
2. 管理员授予；DB 与 server actor 已更新。
3. authority socket 上 `send()` 返回 0，连接保持打开。
4. `/me` cache 不失效，`usePermission` 永远仍为 false。
5. presence hook 永不启用、socket 永不建立，直到用户偶然重连或换账号。

即使帧成功，若随后 `/me` 的一次刷新与一次 retry 都失败，结果同样无时间上界。

撤权方向不会继续泄漏名单，但若 authority 帧丢失，旧 `usePermission=true` 会让前端在 4403 后持续重连并反复收到 403/异常关闭。

**建议**

- authority 控制帧非正 send 结果必须关 authority socket，以物理重连触发 `/me` reconciliation。
- presence 收到 4403 时同步 invalidate `/me`，并在刷新成功前暂停该路径重连。
- 对已收到 authority revision 的 `/me` 刷新保持有界退避重试直到成功或 session 失效。
- AC-9 增加：grant 控制帧返回 0、第一次 `/me` 失败、revoke 控制帧丢失三条贯穿测试。

**性质**：新架构的收敛协议缺口；不是否定独立通道方向。

---

### V6-3 — P1：application observer 与 WS 出站/fence/序列化缓存之间没有唯一接线

**结论**

v6 定义了 `UserPresenceObserver` port，却只列四个基础设施适配器；plan 创建 `presenceBroadcaster`，但没有规定谁把 `observer.presenceChanged` 接到它。与此同时，“全局只序列化一次”无法穿过现有 `sendJson`。

**证据**

- 五个 port 与“四个适配器”：`design.md:17`。
- plan T4/T5 没有 observer bridge：`plan.md:38`。
- broadcaster 传对象给每个 listener：`broadcaster.ts:46`。
- `sendJson` 每条连接重新 `JSON.stringify`，且 fence 藏在该函数内：`registry.ts:1010`。

**具体失败时序**

- 按 T4 完成 composition，但 observer 没有 WS adapter：open snapshot 正常，用户后续上下线只改 store，不产生 delta，其他客户端永久停在旧状态。
- 若实现者为复用缓存字节直接 `ws.send(serialized)`，会绕过 RFC-305 fence。
- 若仍走 `presenceBroadcaster → sendJson`，安全正确，但 3000 条连接会做 3000 次 stringify，§2.3/§7.1 的预算不成立。

**建议**

明确一个 bootstrap 注入的 `PresenceWsObserverAdapter`，以及 `sendPreparedJson(ws, encoded, db)` 合同：

- 仍执行 `authorityRevisionCurrent`；
- 返回明确 send status；
- 不二次 stringify；
- 只有该出口可写 `presenceDirty`。

测试须同时断言：observer 真产帧、一次 stringify、N 次 fence、N 次 send。

**性质**：实现/装配合同，核心链 P1。

---

### V6-4 — P1：`presenceDirty + drain` 在入口和出口两端都未闭合

**结论**

当前合同不能实现 AC-20 的“丢帧必修复”。

**证据**

- 唯一明确的 dirty 置位条件仅为 `send()` 返回 0/-1/throw：`design.md:164`。
- 真实冻结路径在 send 之前直接 return：`registry.ts:940`。
- Bun 只承诺“曾处于 backpressure 后恢复”才调用 drain：`serve.d.ts:394`；0 明确表示 dropped，不等于曾进入 backpressure：`serve.d.ts:3`。

**具体失败时序 A：冻结丢帧**

1. presence socket 因无关权限变更进入 `revalidating=true`。
2. 另一用户下线，batch 广播 delta。
3. listener 在 line 951 return，根本没有 send status。
4. dirty 仍为 false。
5. pass 清 freeze，因 dirty=false 不发修复快照。
6. 客户端永久陈旧。

**具体失败时序 B：0/throw**

1. 正常 delta 的 send 返回 0，置 dirty。
2. 连接没有进入 Bun backpressure，之后不触发 drain。
3. 系统长期没有新复核。
4. dirty 永远无人处理。

修复快照再次返回 0 时，“有限重试”同样没有下一次调度来源。

**建议**

- presence 帧因 `revalidating` 被短路时必须同步置 dirty。
- `0` 与 throw 直接关闭连接，或启动独立有界 retry；不能等待 drain。
- `-1` 才等待 drain；第一次 repair 非正结果即按明确的 N/时限关闭。
- 测试必须证明“0 后完全不调用 drain”仍能收敛，而不是人工调用一个运行时不会产生的 drain。

**性质**：协议/失败恢复设计合同。

---

### V6-5 — P1：配额不能放进可重跑的 `upgradeGate`，并且没有原子准入、数值或速率预算

**结论**

当前 §7.3 的配额机制按现有 registry 接口无法同时满足“首次准入”和“复核既有连接”。

**证据**

- 设计只说在 permission gate 后追加配额检查：`design.md:268`。
- `upgradeGate` 没有 socket/lease 参数，复核时会原样重跑：`registry.ts:284`。
- 首次 gate 在 `server.upgrade` 和 `handleOpen/trackConnection` 之前执行：`server.ts:183`、`server.ts:216`。
- 配额 Q 完全没有数值。
- AC-25 要求全量复核额外 DB 读 ≤ `connections×1`，但 §8.1 自己确认新增 presence 连接每条复核要 3 读。`proposal.md:172`、`design.md:287`。

**具体失败时序**

1. 配额 Q 条连接已经存在。
2. 无关 ACL 写触发复核。
3. 每条既有连接重跑 upgradeGate。
4. 若准入规则为 `count < Q`，所有既有连接在 count=Q 时失败并被 4403 关闭。
5. 若改成 `count <= Q`，第 Q+1 条首次连接又会被放行。

并发首次建连也可旁路：攻击者同时发 K 个 handshake，每个在 `handleOpen` 计数前都看到相同旧值，全部通过。

即使补原子配额，顺序开关连接仍不受限制。按文档 900 在线、24KB 快照：

- 每成功重连约 5 读 + 2 写 + 1 fence 读 + 24KB；
- 100 次/秒约 600 reads/s、200 writes/s、2.4MB/s；
- T0 后仍约 400 reads/s、100 writes/s、2.4MB/s。

**建议**

- 配额从 rerunnable authorization gate 中拆出，建立独立 `PresenceAdmissionLease`。
- 在 handshake 期间原子 reserve pending+open；upgrade 失败、close、close-before-install 均单次释放。
- rerunUpgradeGate 只复核 permission，不重新占配额。
- 明确 Q 及多标签页产品上限，并加入每用户连接建立 token bucket。
- AC-25 分开写：clean full pass=`3×P reads, 0 frames`；delta=`P fence reads + P sends`；dirty repair=`D snapshot sends`；给出真实 p95 数值。
- 测试覆盖 Q+N 并发握手、满配额复核、已有连接不受影响、顺序 churn。

**性质**：安全/容量设计方向。

---

### V6-6 — P1：任务成员“集合相同”没有定义语义，且“事务外直接返回”会改变并发写语义

**结论**

no-op 修复方向正确，但“成员集”不能只比较 userId 并集，也不能在事务外完成最终判定。

**证据**

- v6 要求“先比较成员集，未变直接返回，不进事务”：`design.md:270`。
- PUT 同时支持 `ownerUserId` 与 `userIds`，且都可省略：`taskCollab.ts:164`、`taskCollab schema:33`。
- 当前 owner 转移、旧 owner 自动保留、去重和 owner 排除都在同一事务中规范化：`taskCollab.ts:195`。

**具体失败时序 A：角色变更被误判 no-op**

当前 owner=A、collaborator=B；请求改为 owner=B、collaborator=A。总 userId 集仍是 `{A,B}`，但授权角色发生真实转移。按“成员集相同”提前返回会静默吞掉 owner 转移。

**具体失败时序 B：并发**

1. 请求 X 事务外读到状态 S，body 也是 S，准备 no-op。
2. 请求 Y 提交 S′。
3. X 返回 200 而不写 S。
4. 对 full-replace PUT 而言，X 本应成为后提交者并恢复 S；优化后却静默让 Y 胜出。

**建议**

在同一 `dbTxSync` 中构造规范态：

```text
(ownerUserId, sorted unique collaboratorIds after owner-transfer rules)
```

只在该规范态完全相等时跳过 DELETE/INSERT；可以“零 mutation”，但不能“不进事务”。事务结果再决定是否触发复核和 broadcast。增加 owner 交换但 union 不变、顺序/重复、字段省略、并发写和“真实变化恰触发一次”正控。

**性质**：授权写路径实现合同。

---

### V6-7 — P1：per-socket epoch 改造仍缺 awaited-tail、等 revision gate 与全通道合同

**结论**

§5.3 写出了 worker/epoch 名词，但没有给出可实现的 queue、waiter 和并发模型；它修改的是所有通道共享的 RFC-212 actor writer，不只是 presence。

**证据**

- v6 只规定 requested/processed 与最新 owner 解冻：`design.md:210`。
- W5-1 原要求 `triggerRevalidationAndWait` 等到对应 commit 后的 tail pass：`r5 gate:25`。
- 当前 awaited API 就是等待注册 impl 返回的 promise：`revalidationHook.ts:56`。
- 当前 pass 是跨 socket 串行循环；“每 socket 一个 worker”若直接展开会改变该成本模型：`connections.ts:147`。

**具体失败时序**

1. socket 的 worker 正在处理 epoch A。
2. 任务成员移除提交，`triggerRevalidationAndWait` 请求 epoch B。
3. 常见 coalesce 实现返回现有 worker A 的 promise。
4. A 完成后 HTTP PUT 继续 broadcast/返回 200；B 的 task gate 尚未执行。
5. 如果实现同时以 `authorityRevision` 作为 processed 判据，任务成员变更并不增加该 revision，B 还可能被当作重复工作吞掉。

另一个实现若为几千个 socket 同时启动 worker，会把文档假设的串行 3-read 循环改成高并发 DB storm。

**建议**

明确每 socket 的状态：

- `requestedEpoch/processedEpoch/running`;
- 每个 epoch 保存 reason/target 与 waiter 集；
- equal authority revision 仍必须执行 channel gate/cache invalidation；
- `triggerRevalidationAndWait` 等到本次选中 sockets 全部 processed≥its epoch 或已关闭；
- 全局保持串行或给出明确并发上限；
- resolver/gate 失败保持现有 fail-close。

测试矩阵至少覆盖 task upgradeGate、frameGate cache、无 gate 通道、targeted/global、equal revision、反向完成、异常 fail-close、awaited tail。

**性质**：跨通道 RFC-212 设计方向；不能只作为 presence 实现细节。

---

### V6-8 — P2：AC-26 仍不能定位“在线但显示离线”

**结论**

AC-26 只有服务端中段 aggregate/计数，缺少 grant、admission、per-socket correlation 和客户端 hydration 证据。

**证据**

- AC-26：`proposal.md:176`。
- design 同时声称“不新增 REST endpoint”：`design.md:31`，却没有说明“受保护诊断入口”落在哪里。
- 当前 `/health` 是公开 aggregate，只暴露 identity-access 计数：`health.ts:54`。
- 帧 schema 没有 generation/correlation id：`design.md:144`。

**具体失败结果**

运维只能看到 `refcount=1`、`send success+1`，仍无法区分：

- grant 控制帧丢了；
- `/me` refetch 失败；
- quota 拒绝；
- snapshot 没发/被丢；
- 客户端忽略快照、store 被 reset；
- `PresenceDot` 根本未接线。

**建议**

补受保护的按用户/连接诊断，至少包含：

- current permission/access revision；
- connection id、actor revision、lifecycle、quota/admission result；
- requested/processed epoch、dirty、repair attempts、最后 close/send reason；
- 客户端 support snapshot：authority/presence connection epoch、最后 close code、hydrated、最后 snapshot generation、reset reason。

普通日志和公开 health 仍只保留聚合，不记录 roster。

**性质**：运维设计合同。

## ③ 敌手视角

| 能力 | 可执行步骤 | v6 下的倍数/结果 |
|---|---|---|
| 名单枚举 | 默认获权普通 user 开 `/ws/presence`，取 snapshot，分批调用 `/api/users/lookup` | 900 在线 = 1 快照 + 5 次 lookup；用户已接受，不作为阻断。 |
| 活动轨迹 | 长期记录 `presence.changed` | 约 500ms 上线粒度、正常离线约 60.5s，可推断作息与集中活动；属已接受 roster 暴露。 |
| 并发绕过配额 | 同一 session 同时发 K 条 handshake，使所有 gate 在 `handleOpen` 计数前完成 | 若无 reservation，配额形同虚设；K=1000 初始快照约 24MB，之后每次 delta 增加 1000 fence+send，全量复核增加约 3000 reads。 |
| 配额内连接抖动 | 始终不超过 Q：关闭一条立刻开一条 | 每次约 6 reads + 2 writes + 24KB；100 次/s 约 600 reads/s、200 writes/s、2.4MB/s。当前无连接速率限制。 |
| no-op 复核 | 循环 PUT 自己任务的同一 members body | 干净 pass 不再发 72MB 快照，但 3000 条新增 presence 连接本身仍带来约 9000 次复核读；总成本约 `3×全部 live sockets`。 |
| 慢读修复放大 | 开满 Q 条连接后停止读，等 delta 进入背压，再恢复 | 小 delta 可转成 `Q×24KB` 修复快照；Q 与 retry N 都未定义，设计无法给出上界。 |

敌手结论：v6 消除了旧的“单次 no-op → 72MB 全网快照”，但**配额旁路、连接 churn 和全连接 DB 复核仍是普通用户可执行的放大面**。

## ④ 可观测性判断

AC-26 **不足**。

| 环节 | AC-26 当前覆盖 | 仍缺 |
|---|---|---|
| 授权获知 | 无 | authority frame send status、`/me` refetch success/failure、客户端 effective revision |
| 准入 | 无 | quota 值、reservation、拒绝原因、重连次数 |
| presence store | 部分 | per-user refcount/grace/generation 有写，但入口/权限未定义 |
| 复核 | 部分 | passId/reason/coalesced/freezeDuration 有写；缺 requested/processed epoch、tail waiter、per-socket结果 |
| 发送修复 | 部分 | aggregate send/drop/drain/repair；缺 connection correlation、dirty age、repair attempt |
| 浏览器水化/渲染 | 无 | hydrated、snapshot generation、reset reason、最后 close code、渲染接线 |

因此它能回答“系统总体最近有无 backpressure”，不能回答“用户 U 的点为什么是离线”。

## ⑤ AC × 测试矩阵

design §12 的测试总表见 `design.md:383`。

| AC | §12 测试 | 判定 |
|---|---|---|
| AC-1 | ㉕ | 覆盖；plan 明确真 daemon、双 context、≤1s。 |
| AC-2 | ④⑤；嵌套配置只在 plan T10 | **部分**：无硬断/idle close→grace 的运行链；§12 也漏嵌套 handler 断言。 |
| AC-3 | ⑥/㉙只覆盖应用/reset | **孤儿**：没有真实 transport reconnect + 真下线正控。 |
| AC-4 | ④⑮ | **部分**：领域双计数有，缺同 user 两条真实 socket 的 install/release。 |
| AC-5 | ㉜ | 覆盖。 |
| AC-6 | ㉗㉚ | 覆盖五处与 a11y。 |
| AC-7 | ㉛ | 覆盖。 |
| AC-8 | ①⑪㉗ | **部分**：拒绝与其它通道有测；“前端不建连/无点”未形成一条贯穿控制。 |
| AC-9 | ⑬㉘㉙ | **关键缺口**：只有收回 close；没有 grant→`/me`→enabled→新 socket，也没有丢帧/refetch failure。 |
| AC-10 | ①⑭ | 覆盖。 |
| AC-11 | ㉖ | 覆盖，且有先在线正控。 |
| AC-12 | ㉝+㉕正控 | 覆盖。 |
| AC-13 | ⑮⑲ | 基本覆盖。 |
| AC-14 | ⑧ | 覆盖 timer 正反与 unref。 |
| AC-15 | ㉗㉘㉙ | **部分**：store close→unknown 有；daemon restart 真链无。 |
| AC-16 | ⑮ | 覆盖，正控有效。 |
| AC-17 | ⑦ | 覆盖，精确帧数/载荷/边界/净零。 |
| AC-18 | ⑯ | 覆盖完整 gate 与正常登记正控。 |
| AC-19 | ⑤ | 覆盖双时钟。 |
| AC-20 | ⑱ | **错误模型**：若测试对 send=0 后人工触发 drain，会把生产中不存在的治愈条件测绿。 |
| AC-21 | ⑩ | 覆盖。 |
| AC-22 | ㉔ | **部分**：可达角色矩阵有；默认+显式同次创建的逐项 provenance 无。 |
| AC-23 | ㉑ | **空实现漏洞**：只有 no-op 不触发；缺真实变化必须持久化且恰触发一次，以及 owner 同集合换位。 |
| AC-24 | ㉒ | **部分**：缺具体 Q、并行准入、满配额复核、顺序 churn。 |
| AC-25 | ㉓ | **不可执行**：`1×connections` 与 §8.1 的 `3×connections` 冲突；p95 没数值。 |
| AC-26 | ㉞ | **空实现漏洞**：“计数/诊断面存在”可由全零 counters 通过；缺分段故障场景与客户端证据。 |
| AC-27 | 无 | **孤儿 AC**：只有 plan T0 写 db spy，design §12 未登记。 |

反向孤儿/弱项：

- §12-③ WS path 双射、⑨ pending 索引、⑳ onOpenExtra 穷举锁没有直接产品 AC，但属于合理结构回归锁。
- §12-⑰ 实际是全 RFC-212 行为改造，测试范围却没有覆盖所有通道、equal revision 与 awaited-tail。
- C1 的 replace/reset 注册语义、observer→broadcaster 接线、缓存“一次 stringify”没有对应测试编号。
- `waitForDaemonReady` 的 stderr 捕获已在当前源码存在；应改成“保留并回归锁”，而不是把它当新实现任务。

## ⑥ 整体判断

独立通道方向可以继续，**但 v6 不能进入实现**。

必须先解决：

1. **V6-1**：归一 admin preset 文本，并定义逐 permission provenance。
2. **V6-2**：闭合 grant 的 authority notification + `/me` 失败收敛，以及 4403 重连。
3. **V6-3**：点名 observer→broadcaster→fenced prepared-send 唯一接线。
4. **V6-4**：冻结时置 dirty；0/throw 不依赖 drain；钉死 repair 上限。
5. **V6-5**：配额从 rerunnable gate 拆出，原子 reservation、具体 Q、速率限制与正确容量预算。
6. **V6-6**：在事务内比较规范化 `(owner, collaborators)`，保住真实 owner 转移与并发语义。
7. **V6-7**：定义 per-socket worker 的 waiter、equal revision、并发和全通道合同。

同时必须把 AC-3、AC-9、AC-20、AC-23～AC-27 的测试矩阵补成可证伪合同；V6-8 虽为 P2，也必须在声称 AC-26 完成前落成可操作的诊断面。


