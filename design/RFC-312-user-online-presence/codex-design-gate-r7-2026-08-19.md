# RFC-312 设计门第七轮记录（Codex，2026-08-19）

- 评审对象：v7（收 V6-1…V6-8 后）
- 结论：**仍不可进入实现**——V6-3/V6-4/V6-6 真修好，V6-1/2/5/7 表面修好，V6-8 未修；新增 R7-1…R7-9
- **本轮最有价值的是收敛判断**（评审自述）：
  「架构方向比前六轮明显收敛，但**失败模式总量并未收敛到"只剩编码细节"**；关键 seam 仍需要设计决定。
   缺的主要仍是**设计合同**，不是实现代码；另有**两项需要外部实证输入**：
   Q 的设备/标签页支持包络，以及 AC-25 的 p95 基准环境与阈值。」

---

## ① V6-1…V6-8 核验

| 编号 | 判定 | 核验结论 |
|---|---|---|
| V6-1 | **表面修好** | 新增了 `InitialGrantSpec`，但 grant 表没有 `origin`、audit port 仍只收 `Permission[]`，C7 仍写“默认与显式取并集”；shared/plan 也仍错误断言“不进任何 preset”。原来的逐 permission 归因失败仍会发生。 |
| V6-2 | **表面修好** | 增加了关闭 authority socket 与 presence 4403 刷新 `/me`，但 C2 精确 pass 顺序漏掉 `authority.changed`；`/me` 首次请求及一次 retry 都失败后仍无再次收敛上界。新关闭规则还引入 R7-2 的连坐风暴。 |
| V6-3 | **真修好** | `PresenceWsObserverAdapter → presenceBroadcaster → sendPreparedJson` 已成为明确唯一接线，且 fence、一次序列化、原始 send 结果均有合同。其新增的 fence-result 缺口另列 R7-3。 |
| V6-4 | **真修好（原失败）** | 原来的四条失败路径已逐项闭合：`-1` dirty、`0`/throw 关连接、revalidating 前置短路同步 dirty、repair 最多 3 次。v7 新增出口产生的“第五条 fence/no-send 路径”是新失败，不倒扣旧项。 |
| V6-5 | **表面修好** | lease、原子 reserve、Q=8、30/min、三条释放路径已补；但拒绝后的客户端行为、Q 的合法用户重连包络、限速位置及 AC-25 的 `1×`/`3×` 矛盾仍未闭合。 |
| V6-6 | **真修好** | 已明确同一 `dbTxSync` 内比较 `(owner, sorted-dedup collaborators)`，owner 转移算变化，并保留并发用例。与同步事务及提交后 awaited trigger 相容。 |
| V6-7 | **表面修好** | seven-contract 文字基本补齐，但三字段状态不足以保存 reason/target/waiter，低 revision 与解冻规则矛盾，全局并发模型仍缺。原 awaited-tail/全通道失败仍可发生。 |
| V6-8 | **未修** | C11 扩写了字段，却仍没有诊断入口、鉴权、schema、保留期、前后端 correlation。AC-26 自己写“只列字段不算完成”，v7 实际仍停在字段清单。 |

## ② 新 findings

### R7-1 — P1：`InitialGrantSpec` 没有可持久化的 provenance

**结论：** 类型加了，数据模型没有跟上；同时 preset 文本仍自相矛盾。

**证据：**

- v7 要求 grant/audit 全程保留 spec：`design.md:288`。
- grant 表只有 `permission/grantedBy/grantedAt`，没有 `origin`：`schema.ts:2432`。
- audit port 仍是 `ReadonlyArray<Permission>`：`userAccessAuditRepository.ts:3`。
- C7 又允许默认与显式权限取并集，而 §12-①、plan T1 仍断言“不在任何 preset”：`design.md:457`、`plan.md:17`。

**失败时序：**

1. CLI 创建普通 user：默认 `users:presence`，显式 `scripts:author`。
2. CLI 路径两者的 `grantedByUserId` 都是 `null`。
3. grant 行无 origin，audit 又序列化 union 后的字符串数组。
4. 落库后无法判断哪一项是 system-default、哪一项是 CLI explicit。
5. literal preset 测试又会与动态 `admin:[...PERMISSIONS]` 同时打红。

**建议：** 明确 durable representation：给 grant 增加 origin，或定义等价且能处理 CLI explicit 的持久化编码；同步升级 audit schema/port。C7 改为“仅 view/observer union”，并修正 §12-①、T1。补“默认 presence + HTTP/CLI 显式 scripts 同次创建”测试。

**性质：** 实现数据合同，但当前缺口必须先在设计中定案；不改变 admin 裁决。

---

### R7-2 — P1：authority 的非正发送关闭规则会连坐，且 `/me` 仍无最终收敛

**结论：** 用户特别质疑的关闭风暴确实成立。它不是全平台单次广播，但会连坐该账号的所有目标 socket；若批量改多个账号则线性扩张。

**证据：**

- C2 的精确 pass 顺序没有 `authority.changed` 发送：`design.md:451`。
- 当前实现对目标用户的**每条 socket**发送控制帧，不限 authority channel：`connections.ts:183`；现有测试甚至用 `workflows` socket 接收它：`rfc212-revalidation-behavior.test.ts:226`。
- Bun `-1` 只表示 backpressure，不表示消息已丢：`serve.d.ts:3`。
- 当前 4401 会清 token，所有其它 close 都重连；open 又立刻把 backoff 重置为 500ms：`useWebSocket.ts:191`。
- `/me` 只有一次 retry，且不随 focus 重取：`query-client.ts:43`。

**失败时序：**

1. 若按 C2 实现，grant pass 根本不发控制帧，非正结果补丁不会运行，前端永远不知道 grant。
2. 若直接改现有 `sendAuthorityChanged`：账号 U 有 N 条正常业务/authority socket；背压高峰均返回 `-1`，N 条全部被关闭。
3. 若复用当前 4401 helper，第一条 close 就清 token，临时背压变成强制登出。
4. 即使只关 authority socket，重连后 `/me` 的请求和一次 retry 都失败；authority socket随后保持打开，不再产生 open 事件，`usePermission=false` 可无限期保持。

关闭 N 条 socket 后，按 T0 成本至少再产生约 `3N reads + N writes` 的升级工作。

**建议：**

- C2 明列 authority notification 的位置。
- 只允许 `/ws/authority` 承担该补偿；业务 socket 不发送或不因该帧关闭。
- `0` 可使用新的“authority-desynced” close code；不得复用 4401。
- `-1` 先进入 drain/短期限状态，超时才只关闭该 authority socket，避免高峰立即雪崩。
- `/me` 建立独立有界退避，直到成功或确认 session 失效；测试首轮失败后仍收敛。
- 前端不要仅因一次 `open` 就清零失败 backoff；至少等 hello/稳定窗口。

**性质：** 选定独立通道后的恢复协议设计，不否定通道方向。

---

### R7-3 — P1：`sendPreparedJson` 的“原始结果”无法表示 fence/no-send，dirty 其实有第五入口

**结论：** 原 V6-4 四条路径修好了，但新出口自己产生了一条未定义路径。

**证据：**

- 合同要求“先 fence，返回 `send()` 原始结果”：`design.md:171`。
- 实际 fence revision mismatch 会置 `revalidating`、触发复核并在**没有调用 send**时返回 false：`registry.ts:1034`。
- design 又声称 fence drop 会走同一 repair：`design.md:213`。

**失败时序：**

1. listener 初始看到 `revalidating=false`，进入 `sendPreparedJson`。
2. 内部 fence 发现 revision 变化，置 `revalidating=true` 并 return。
3. 没有 raw send status，也没有命中“前置 revalidating 短路”。
4. `presenceDirty` 仍为 false。
5. pass 成功后清 freeze，但不补 snapshot，客户端永久漏掉该 delta。

“两种入口同时命中”的准确答案是：同一次 send 不会同时得到 raw status 和前置短路；但不同异步阶段可以留下 `dirty + closing`。例如先因冻结置 dirty，随后 gate 失败关闭，C2 若仍执行“清 freeze → dirty repair”，就会向终态 socket 重发并再次 close/release。

C9 按 `(connection,generation)` 合并也可能让每个新 generation 重置 retry；慢连接持续遇到新 delta 时永远达不到“3 次”。

**建议：** 返回显式 union，如 `sent | backpressured | dropped | fenced | closed | threw`；`fenced` 同步 dirty。规定 `closing/closed` 绝对优先并清 dirty/retry；repair 先检查 lifecycle。重试上限按一次连续 dirty episode 计数，不能由 generation 无限刷新。

**性质：** 实现状态机合同，但直接决定数据是否永久陈旧，必须设计先闭合。

---

### R7-4 — P1：AdmissionLease 可做到无泄漏，但 Q=8、拒绝恢复、限速位置和容量数字未闭合

**结论：**

- reserve→install 窗口**可以**无泄漏，但 v7 没有钉出足以证明它的线性化顺序。
- Q=8 对多设备、多标签页与旧连接存活重叠不够。
- 超限后当前前端会无限期重试。
- “30 次/分”无法限制放在完整认证之后的 DB 攻击面。

**证据：**

- lease/Q/rate 合同：`design.md:341`。
- 当前升级在多次 await 后才调用 `server.upgrade`：`server.ts:183`。
- 客户端无法区分普通升级拒绝，所有非 4401 close 均走通用重连：`useWebSocket.ts:201`。
- AC-25 要求 `≤1×connections`，设计成本表却确认每连接复核为 3 读：`proposal.md:184`、`design.md:364`。

**失败时序：**

1. 合法用户两设备×三标签页，共 6 条连接。
2. 硬断后服务端旧 6 条最多存活 120s，客户端新网络立即建立替换 6 条。
3. `pending+open=12`，Q=8 导致 4 条合法替换被拒。
4. 六个标签页按 0、0.5、1.5、3.5、7.5、15.5、31.5 秒重试，首分钟合计 42 次，超过 30/min；八标签页则 56 次。
5. 若为了传递 close code 先接受再关闭，`open` 每次把 backoff 重置到 500ms，可达到约 120 次/分钟/标签页。

若 rate check 位于 T0 后的完整 actor 解析之后，攻击者即使始终被 30/min 拒绝，100 次握手/秒仍可造成约 `300 reads + 100 writes/s`。

**建议：**

- 精确顺序：最后一个 await 之后原子 reserve；release closure 先写入本地 `data`；`server.upgrade` false/throw 走同一幂等终态；`closeConnection`/`handleClose` 共同调用一次 terminal helper；随后 `installPresence` 仅在 open 状态装句柄。
- Q 必须来自“支持的设备×标签页×旧新连接重叠”包络，至少覆盖 2×正常并发，或引入稳定 tab/client id 淘汰 superseded lease。
- 定义 sliding/token bucket、burst、失败是否消费、单调时钟和 Retry-After。
- 设计客户端可观察的 admission close code，并在该状态停止自动重连。
- 在昂贵 actor 解析前增加 credential/IP 粗限速，或至少在最小 session lookup 后、touch/write 前执行 per-user limit。
- AC-25 改为分别断言：clean pass=`3×P reads`；普通 delta=`P fence reads + P sends`；dirty repair=`D snapshot sends + D fence reads`。p95 必须给 workload、机器和数值阈值。

**性质：** 产品容量与恢复设计；lease 的 once-release 是实现细节，Q/拒绝行为/预算不是。

---

### R7-5 — P1：per-socket worker 的“七项合同”仍不能形成一个算法

**结论：** 文档同时要求单 worker、反向完成、低结果不解冻和最新轮解冻，却没有定义 reason/target/waiter 与全局并发。

**证据：**

- 低 revision “整个放弃、不解冻”：`design.md:252`。
- 状态只有 `{requestedEpoch, processedEpoch, running}`，但又要求 awaited-tail：`design.md:264`。
- 当前 reason 决定是否发 `authority.changed`，当前扫描是跨 socket 串行：`connections.ts:147`。

**失败时序：**

1. A=`authority-changed(target U)` 已运行；B=`task-members-changed(global)` 在其间到达。
2. 三字段状态不能保存两个 reason、target revision 或各自 waiter。
3. 覆盖为 B 会吞掉 A 的 control notification；保留 A 会丢 B 的 awaited-tail 语义。
4. 若 B 返回已有 A promise，任务 PUT 可在 B 的 gate 尚未读取提交后成员集时继续。
5. 若“每 socket worker”被实现为数千个 socket 并行 resolver，原来的串行成本变成 DB storm。
6. stale lower-revision 若是最新请求：标记 processed 会永久冻结；不标记则 dirty loop 永不退出。

另外，真正串行执行 resolver 的 single worker 不会出现“同 socket 两 pass 反向完成”；§12-⑰要求该测试，说明文档尚未选择“串行整个 pass”还是“只串行 writeback”。

**建议：** 每次 trigger 生成 ticket，保存 cause set、target、开始 epoch 与 Deferred；worker 启动时捕获 `workEpoch`，只允许启动后读取的 pass 完成该 ticket；close 解析 waiter；异常保持现有 fail-close。再规定进程级并发为 1 或明确上限。测试补 targeted/global coalesce、reason 保留、异常、close-mid-worker、全局并发上限。

**性质：** 所有 WS 通道共享的设计方向，不能留给 presence 实现者猜。

---

### R7-6 — P1：G7 仍为假；no-op 可能继续广播，真实成员切换仍触发全网复核

**证据：**

- G7 要求普通用户不能借 presence 放大全网工作：`proposal.md:37`。
- v7 明确把 targeted revalidation/per-actor 限速留到以后：`design.md:330`。
- 普通 owner 可 PUT members：`routes/tasks.ts:396`。
- 当前函数在 awaited 全量复核之后还会广播：`taskCollab.ts:252`。

**失败时序：**

- **no-op：** 若实现只遵守“相同则不写、不触发复核”，却继续走当前 broadcast 尾部，一次 no-op 仍遍历全部 tasks-list 订阅者。它甚至更快，因为不再等待全量复核。
- **真实切换：** owner 依次 PUT `{"userIds":[]}`、`{"userIds":["B"]}`。两次都是合法真实变化，no-op 保护不生效；每次 un-targeted rescan 对全部 live socket 做约 3 读。仅 3000 条新增 presence 连接就是约 9000 reads/PUT，来回一次约 18000 reads。Q 和 presence 握手限速完全不约束该 HTTP 路径。

**建议：** no-op 必须短路**所有** side effect，包括 broadcaster。真实成员变化必须在本 RFC 内加 per-actor/task 限速、合并，或做 task/resource targeted revalidation；否则删掉 G7 的强保证。测试断言 no-op `writes=0/revalidation=0/broadcast=0`，真实变化三者各恰一次，并加入连续切换的成本上界。

**事务兼容性：** `dbTxSync` 没有问题：事务内同步重读当前 owner/collaborators、规范化比较并写，返回 `{changed,before,after}`；提交后才 `await triggerRevalidationAndWait`。不得在事务内 await。这里是实现细节，真正未闭合的是 R7-5 的 awaited-tail。

**性质：** 滥用/容量设计，不要求拆分既定范围。

---

### R7-7 — P1：C1 的字面装配路径会重新制造已知 module cycle

**结论：** identity-access `composition.ts` 无法在不增加新 inversion seam 的情况下直接注册捕获 presence 的真实 revalidator。

**证据：**

- C1/T4 要 `composition.ts` 调 `registerRevalidationTrigger`：`design.md:451`、`plan.md:38`。
- `actor.ts` 已经反向 import identity composition：`actor.ts:14`。
- `connections.ts` import `auth/session`；轻量 hook 的注释明确说明单 binary 对这种环敏感：`revalidationHook.ts:1`。

**失败时序：**

`identity-access/composition → ws/connections → auth/session → auth/actor → identity-access/composition`。字面实现可能在模块尚未初始化时读取导出。若保留 connections 的模块加载注册，再让 composition replace，则最终 owner 依赖 import 顺序；测试 reset 后命中 WeakMap cache 又可能不重新注册。

**建议：** identity composition 只创建并返回 public presence command/query；由 `cli/start.ts` 或专门的 root WS composition 在两侧实例都存在后注册，返回 registration disposer/token。移除模块加载时隐式抢占，测试两个 adapter/两个 DB 的 replace、reset、dispose。

**性质：** 装配实现合同，但当前 C1 指向错误，必须先改设计。

---

### R7-8 — P2：C11 仍不是可操作的诊断面

**结论：** 没有入口、鉴权、schema、retention 和跨端 correlation，仍无法实际执行 AC-26。

**证据：**

- design 明说无新 REST endpoint：`design.md:31`。
- C11 只有字段清单：`design.md:460`。
- 当前 `/health` 是公开 aggregate，不能承载 roster/per-connection 数据：`health.ts:25`。
- presence 帧没有 server generation/connection correlation 字段：`design.md:175`。

**失败结果：** 运维即使看到 `refcount=1`、`sent+1`，也拿不到某浏览器的 hydration/reset 证据；客户端的本地 snapshot generation 又无法与服务端哪一帧对应。quota 拒绝也未进入 C11。

**建议：** 定义受保护 endpoint、CLI support bundle 或明确浏览器导出协议；写出权限、响应 schema、连接/stream generation、保留期与红action。四种故障测试必须通过真实入口取得不同结果。

**性质：** 运维设计合同；不阻断核心数据面编码，但阻断“AC-26 已完成”。

---

### R7-9 — P2：测试计划仍有孤儿 AC 与可空实现条目

**结论：** §12 的数字和字段不少，但仍不能双向证明 proposal。具体见下一节；其中 AC-3、AC-27 是孤儿，AC-25/26 不可执行，AC-20/23/24 存在空实现路径。

**建议：** 将矩阵中所有 △/× 变成带生产入口、正向控制、负向控制及量化 oracle 的测试；不要只在 plan 验收摘要复述 AC。

**性质：** 实现计划/验收缺陷。

## ③ 敌手视角

| 能力 | 可执行步骤 | 倍数/结果 | 判断 |
|---|---|---|---|
| 名单枚举 | 默认获权用户连一条 presence，取 snapshot，再调用 lookup | 900 在线 = 1 snapshot + 5 次 lookup | 用户已接受 F12，不作 finding |
| 活动轨迹 | 长期保存 changed 帧 | 上线约 500ms 粒度，正常离线约 60.5s | 已接受暴露 |
| 配额内 fanout | 开满 8 条慢连接 | 每个全网 delta 增加 8 fence + 8 send；每轮 full repair 约 `8×24KB=192KB` | Q 只把放大从无界降到 8× |
| repair 放大 | 8 条 socket 制造 backpressure，反复 drain | “3 次总尝试”为 576KB；若语义是“初次+3 retry”则 768KB。文档未区分 | 可执行，且 generation 可重置计数 |
| 连接缓冲 | 自定义客户端慢读但维持心跳 | Bun 默认 buffer 16MB、`closeOnBackpressureLimit=false`；8 条理论达 128MB | v7 无 drain deadline |
| admission DB flood | 用有效 session 高频发握手，全部被 30/min 拒绝 | 若限速在 T0 认证之后，100/s 仍约 300 reads +100 writes/s | rate 只限成功准入，不限认证成本 |
| no-op 干扰 | 重放相同 members PUT | 若只跳复核，仍有 `O(tasks-list subscribers)` listener traversal/部分客户端 invalidate | AC-23 未禁止 broadcast |
| 真实变更放大 | 在 `[]` 与 `[B]` 间交替 | 每 PUT 至少 `3×3000=9000` presence 复核读；一来一回约 18000 | 直接违反 G7；Q/30 不适用 |
| 定向干扰 | 反复移除/加入协作者 B | B 的 task socket 被关闭、tasks query 反复失效，同时触发全网扫描 | 普通 task owner 可执行 |

## ④ AC × §12 测试矩阵

`✅` 可证伪；`△` 部分覆盖；`❌` 孤儿、矛盾或不可执行。

| AC | §12 | 判定 |
|---|---|---|
| AC-1 | ㉕ | ✅ 真 daemon、双 context、≤1s。 |
| AC-2 | ④⑤ | △ 只有领域时间；§12 没有真实硬断、nested `idleTimeout:120` 与 180s 链。 |
| AC-3 | ⑥㉙ | ❌ 没有真实 transport reconnect + 真下线正控。 |
| AC-4 | ④⑮ | △ 缺同一用户两条真实 socket 的 install/release。 |
| AC-5 | ㉜ | ✅ |
| AC-6 | ㉗㉚ | ✅ |
| AC-7 | ㉛ | ✅ |
| AC-8 | ①⑪㉗ | △ 后端拒绝有测；前端不建连且无点的贯穿链缺失。 |
| AC-9 | ⑪b⑬㉘㉙ | ❌ 未覆盖 C2 漏 send、非 authority 连坐、close code、首轮 `/me` 失败及重连上界。 |
| AC-10 | ①⑭ | ✅ |
| AC-11 | ㉖ | ✅ 两个 case 均有先在线正控。 |
| AC-12 | ㉝ | ✅ |
| AC-13 | ⑮⑲ | △ 零 DB/fence 有；服务端 live connection **恰好 +1** 未登记为测试。 |
| AC-14 | ⑧ | ✅ |
| AC-15 | ㉗㉘㉙ | △ store unknown 有；真 daemon restart 无。 |
| AC-16 | ⑮ | ✅ |
| AC-17 | ⑦ | ✅ |
| AC-18 | ⑯ | ✅ |
| AC-19 | ⑤ | ✅ |
| AC-20 | ⑱ | ❌ 未覆盖内部 fence/no-send、dirty+closing、generation 重置 retry。 |
| AC-21 | ⑩ | ✅ |
| AC-22b | ㉔ | ❌ 当前 grant/audit 模型无法持久化 origin；测试只能停在 fake/spec。 |
| AC-22 | ㉔ | △ 可达角色矩阵有，但与 ①“不进任何 preset”冲突，CLI 归因不成立。 |
| AC-23 | ㉑ | △ 未断言 no-op broadcast=0；真实 collaborator 变化持久化且各 side effect 恰一次不完整。 |
| AC-24 | ㉒ | ❌ 未覆盖并发 Q+N、旧新连接重叠、拒绝重试、rate 算法及认证前成本。 |
| AC-25 | ㉓ | ❌ `≤1×` 与设计 `3×` 矛盾；p95 没 workload、环境和数值。 |
| AC-26 | ㉞ | ❌ 没有实际诊断入口，无法构造真实四段结果。 |
| AC-27 | 无 | ❌ §12 孤儿；只有 plan T0 提到 DB spy。 |

反向检查：

- ② schema、③ path 双射、⑨ pending 索引、⑳ `onOpenExtra` 穷举没有直接产品 AC，但属于合理结构锁。
- ⑰ 是全 RFC-212 改造，却没有对应 proposal AC，且“single worker + 同 socket 反向完成”的测试模型自相矛盾。
- 没有编号测试锁 `PresenceWsObserverAdapter` 真产帧、一次 stringify、N fence、N send。
- 没有测试锁 C1 的无环装配、注册 owner、两个 adapter/DB 的 replace/reset。
- plan 验收摘要遗漏 AC-22b；AC-20 摘要也漏掉 revalidating 入口。
- ⑪b、㉒、㉓、㉞属于“写了数字/字段但缺失可观察 oracle”的典型条目。

## ⑤ 收敛判断

本轮不是单纯“同一批问题继续细分”，而是三类并存：

- **原问题仍未收敛：** R7-1 对应 V6-1；R7-2 的 `/me` 上界对应 V6-2；R7-5 对应 V6-7；R7-8 对应 V6-8。
- **旧问题真正修好：** V6-3 observer 接线、V6-4 原四条 dirty 路径、V6-6 事务内规范比较。
- **v7 修法新引入的失败：** `-1` 关闭风暴/4401 登出、prepared-send 的 fence/no-result、Q=8 的旧新连接重叠与拒绝重试、C1 装配循环。
- **W5/G7 的更细分解：** no-op 尾部广播和真实成员切换的 `3×全连接` 复核。

因此，架构方向比前六轮明显收敛，但**失败模式总量并未收敛到“只剩编码细节”**；关键 seam 仍需要设计决定。

## ⑥ 整体判断与必须先解决

**整体判断：不可进入实现。**

必须先解决的 P1：

1. **R7-1**：确定 origin 的持久化与 audit 格式，统一 preset 合同。
2. **R7-2**：明确 authority send 步骤、channel scope、close code、`-1` 策略和 `/me` 最终收敛。
3. **R7-3**：把 fence/no-send 纳入 typed outcome，定义 terminal/dirty/retry 优先级。
4. **R7-4**：钉死 lease 线性化、合法重连包络、admission 拒绝协议、rate 算法和正确容量账。
5. **R7-5**：给出可实现的 worker ticket/cause/waiter/并发/fail-close 算法。
6. **R7-6**：no-op 全副作用短路，并为真实成员变化建立可判定的 G7 上界。
7. **R7-7**：把注册移到无环的 root composition，明确注册所有权。

在声称验收完整前还必须解决 **R7-8、R7-9**。

缺的主要仍是**设计合同**，不是实现代码；另有两项需要外部实证输入：Q 的设备/标签页支持包络，以及 AC-25 的 p95 基准环境与阈值。无需重开独立通道、每标签页成本或不拆范围等已拍板方向。


