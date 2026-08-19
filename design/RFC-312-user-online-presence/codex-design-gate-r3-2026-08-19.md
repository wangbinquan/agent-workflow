# RFC-312 设计门第三轮记录（Codex，2026-08-19）

- 评审对象：v3；本轮新增视角：实现者视角「必须猜的事项」+ AC×测试双向矩阵
- 执行：pin 到 `09ed0259` 的分离 worktree + `codex exec --sandbox read-only < /dev/null`，session `01a01854`
- 结论：**NOT-CLEAN**——N1/N2/N3/N5/N6/N7 真修好，N4 表面修好；**新增 R3-1…R3-7**（6×P1 + 1×P2）
- 注：file:line 已按 CLAUDE.md 规则转纯文本

---

## ① N1–N7 核验

| 编号 | 判定 | 结论 |
|---|---|---|
| N1 | **真修好（按用户裁决闭合）** | admin 恒有、默认 grant/backfill 跳过 admin 的产品结论已经统一。只是测试文本仍互相矛盾，另见 R3-5；这不是重新质疑 admin 裁决。 |
| N2 | **真修好（功能路径）** | v3 已要求 `createManagedUser`、OIDC 自助建号、bootstrap 共用 provisioning seam，并有 §9.17c。原来的 OIDC 漏授予不再被允许；但 seam 的审计合同没闭合，见 R3-6。 |
| N3 | **真修好** | `{previousActor,freshActor}` 加 per-socket revision 单调 CAS，且低 revision 整个 pass 丢弃，能阻止 rev1 晚到覆盖 rev2。 |
| N4 | **表面修好** | 已有合法的 fenced direct 出口，也避免 broadcaster 自己拦截 revoked；但“权限边沿已接受”与“重同步帧已成功交付”仍是两个状态，一次 fence 丢弃即可永久漏同步，见 R3-2。 |
| N5 | **真修好（对原始 client-close 时序）** | `handleClose` 先留下 tombstone，再 install-or-release，能消除原描述的永久幽灵；但 server-initiated `closeConnection` 尚未纳入同一终态，见 R3-4。 |
| N6 | **真修好（对 A→B 泄漏）** | auth revision、transport close、hook cleanup 三处同步 reset 能消除上一账号名单进入下一账号首帧的问题；多订阅者下的 cleanup 新回归见 R3-7。 |
| N7 | **真修好** | 值、`sendPings`、180s 口径和嵌套配置断言均已钉死；未再把用户已拍板事项当待决问题。 |

## ② v3 新 findings

### R3-1 [P1] revalidation 冻结期丢掉 `presence.changed`，同权限刷新后没有任何补偿

- **证据**：v3 规定无关权限变化“不动” (`design.md:161-167`)；真实触发器会在异步复核前把 socket 设为 `revalidating=true`（`packages/backend/src/ws/connections.ts:235-251`），而 broadcaster listener 对该状态直接丢帧（`packages/backend/src/ws/registry.ts:940-951`）。pass 完成后只清 flag（`connections.ts:210-212`）。
- **失败时序**：

  1. 观察者已水化，持续持有 `users:presence`。
  2. 任一无 target 的全量复核开始，或观察者发生无关权限修改；socket 被同步冻结。
  3. 复核 await 期间，另一用户下线，500ms batch 广播 `presence.changed`。
  4. listener 因 `revalidating` 直接 return。
  5. fresh actor 仍有 presence，`有→有` 被归为“无关变更，不动”；随后解冻。
  6. 前端永久保留旧在线态，直到该用户再次翻转或物理重连。

- **建议**：引入每 socket 的 presence delivery cursor/dirty 位；冻结期丢过任何 delta 后，最新 pass 必须在解冻前补 snapshot。更简单但成本稍高的方案是：任何成功刷新且 fresh actor 仍持权，都 fenced 重发 snapshot。
- **归类**：**设计方向**。当前协议只有权限边沿，没有丢帧后的恢复协议。

### R3-2 [P1] CAS 提交的是 actor 状态，不是客户端同步状态；一次 direct fence miss 后边沿不会重试

- **证据**：CAS 先接受 fresh actor，再按 `previousActor/freshActor` 决定仅发一次 snapshot/revoked（`design.md:154-174`）；真实 fence 在 revision 不一致时丢帧并另触发复核（`registry.ts:1034-1057`）。下一 pass 若权限布尔未变化，迁移表要求“不动”。
- **可确定性复现的时序**：

  1. rev1 为无权→有权；pass 接受 rev1，并把 socket actor/max revision 推进。
  2. 实现者按目前未钉签名的 async hook 先 `await snapshot()`；期间无关权限修改提交 rev2。
  3. `sendFencedDirect` 读取到 DB rev2，正确丢弃 rev1 snapshot，并触发 rev2 pass。
  4. rev2 比较得到有→有，因此不再发 snapshot；客户端从未水化。
  5. 撤权方向同理：revoked 被丢后，rev2 是无→无，旧名单永久残留。

- **建议**：把“客户端已同步到哪一 revision/generation”独立于 actor CAS；`sendFencedDirect` 返回明确的 `sent | stale | closed | failed`，只有 `sent` 才提交 delivery 状态，`stale` 必须由后续最新 pass 重发 snapshot/revoked。若设计依赖“CAS→取快照→fence→send 全程同步无 await”，必须把它写成接口硬约束并用 deferred-query 反例锁定。
- **归类**：**设计方向**。

### R3-3 [P1] “epoch 复核后登记”仍不等于“通过完整通道授权”

- **证据**：presence 定义要求“已通过 `handleOpen` 完整授权”（`design.md:34-39`），但当前升级期 epoch 变化后只调用 `reresolveActor`（`packages/backend/src/ws/server.ts:230-237`）；真正的 channel `checkUpgradeGate` 只在更早的 `tryUpgrade` 调过一次（`:183-192`），`openWsChannel` 不会重跑。
- **失败时序**：

  1. 用户对 `/ws/tasks/:id` 的初始 `checkUpgradeGate` 通过。
  2. `server.upgrade` 完成前，该用户被移出任务；复核快照中尚无这条 socket，epoch 增加。
  3. `handleOpen` 只重建 account actor；任务成员关系不是 actor 权限，fresh actor 仍非 null。
  4. v3 把该 socket 登记为 online，并订阅 task 通道。
  5. 一个已不具备该通道访问权的连接同时制造在线信号，并继续收到 task 帧。

- **建议**：epoch 不一致时，在 presence 登记前用 fresh actor 重跑该 channel 的完整 `checkUpgradeGate`；失败则 close 且永不登记。AC-18 增加 `task-members-changed` 的 gated-channel 变体，不能只测 session 解析为 null。
- **归类**：**实现细节**，但涉及既有通道授权，属 P1。

### R3-4 [P1] tombstone 只覆盖 `handleClose`，没有覆盖已进入 `closeConnection` 的 socket

- **证据**：v3 只要求 `handleClose` 写 `closed=true`（`design.md:194-202`）；当前 server-initiated close 会先设 `closing=true`、untrack、调用 `ws.close`，close callback 稍后才到（`packages/backend/src/ws/connections.ts:103-126`）。
- **失败时序**：

  1. `handleOpen` 正在 epoch await。
  2. 另一个并发 revalidation pass 判 gate 失败，调用 `closeConnection`；此时 `closing=true`，但 `closed` 尚未由 Bun callback 写入。
  3. 本地 await 返回；install-or-release 只检查 `closed`，于是仍调用 `opened()` 并安装 release。
  4. close callback 随后释放，用户至少被假报在线一个 60s 宽限；若 callback 异常缺失，则退化成永久幽灵。

- **建议**：不要维护两个含义重叠的布尔。定义单调 lifecycle `open → closing → closed`，`closeConnection` 与 `handleClose` 都先推进终态；install helper 只允许状态仍为 `open`。测试同时覆盖 client close 和 server close。
- **归类**：**实现细节**。

### R3-5 [P1] 权限与验收文本仍没有一套可同时满足的真值表

- **证据一**：AC-8 说无权限者“不发任何 presence 帧”（`proposal.md:139-140`），AC-9/AC-23 又要求 actor 已失权后 direct 发送一次 `presence.revoked`（`:141-143,174-176`）。
- **证据二**：design §9.1 要求“不在任何 `ROLE_PERMISSIONS` 且每个角色都 grantable”（`design.md:387-388`），§9.17b 又要求 admin 恒有且不在 grantable 列表（`:421-422`）。源码中 admin 动态等于全部 `PERMISSIONS`，因此后者才可能成立（`permission.ts:1058-1063,1181-1187`）。
- **证据三**：AC-21/§9.17c 把 bootstrap admin 列为“默认授予覆盖路径”，但 §5 和 plan migration 又要求 admin 不插 grant（`design.md:244-254`；`plan.md:100-104`）。
- **具体结果**：

  - literal AC-8 测试会拒绝 AC-9 必须发送的 revoked；
  - §9.1 与 §9.17b 不可能同时绿；
  - 实现者可能给 bootstrap admin 插一条必被 normalizer 丢弃的冗余 grant。

- **建议**：落一张唯一真值表：

  | 角色/状态 | 新建默认 grant | backfill | 有效权限 | 可编辑附加项 |
  |---|---:|---:|---:|---:|
  | user / manager | 是 | 是 | 是 | 是 |
  | guest | 否 | 否 | 否；可另授 | 是 |
  | admin | 否 | 否 | 天然有 | 否 |
  | PAT/daemon token | 不适用 | 不适用 | 永不有 | 否 |

  同时把 AC-8 改成：“稳态无权时无 snapshot/changed；有→无边沿允许且必须恰发一次 revoked，此后不再发。”
- **归类**：**实现细节/验收合同**，不改变用户已拍板方向。

### R3-6 [P1] provisioning seam 没把默认 grant 与权限审计绑定为同一份事实

- **证据**：v3 只写“统一 provisioning seam”（`design.md:249-254`），没有接口或审计语义。现有 OIDC/bootstrap participant 的输入没有 permissions，并把 `addedPermissions` 固定为 `[]`（`sqliteUserAccessRepository.ts:116-165`）；相对地，`CreateManagedUser` 用同一 canonical 数组同时插 grant、写 audit、发 observer（`createManagedUser.ts:40-103`）。
- **失败时序**：

  1. OIDC 创建默认 `user`。
  2. 实现者在 `insertInitialUserAccessInTransaction` 中补一条 presence grant，功能测试通过。
  3. 现有 audit 仍落 `addedPermissions: []`。
  4. 该用户已获得全平台在线名单能力，但 identity-access 审计明确记录“未增加权限”。

  若反过来只在 `CreateManagedUser` 加默认项以保持审计正确，则 N2 的 OIDC 绕过原样复发。

- **建议**：定义单一纯策略 `initialAdditionalPermissions(role)`；扩展 `InitialUserAccessProvision` 携带 canonical permissions，同一数组驱动 grant 行、audit、返回 view/observer。§9.17c 除有效权限外，必须断言 grant 行与 audit `addedPermissions` 一致。
- **归类**：**实现细节**。

### R3-7 [P2] “hook cleanup 同步 reset”会破坏 `useWebSocket` 的多订阅者共享合同

- **证据**：v3 要求 hook cleanup reset 全局 store（`design.md:286-291`）；现有 `/ws/authority` 连接按 path 共享，并且只有最后一个 subscriber release 才关闭物理 socket（`useWebSocket.ts:93-139`）。
- **失败时序**：

  1. 两个消费者共享同一 authority socket，store 已水化。
  2. 消费者 A 卸载，B 仍存在，故物理 socket不重连。
  3. A 的 cleanup 无条件清空模块级 store。
  4. B 继续在线，但不会再收到 on-open snapshot，页面持续显示“未知”，直到下一次物理重连。

- **建议**：reset 归属 auth generation 和**物理连接生命周期/最后一个 release**，不能归属任一 React hook 实例。增加“两订阅者，卸载一个”的测试。
- **归类**：**实现细节**。

七项新增机制中，合并缓冲保存“窗口初态+末态”本身未发现独立反例；前提是首个翻转前保存初态、正向 200 人用例与净零用例在同一测试中共同锁定。其剩余接口歧义见 I6。

## ③ 实现者视角：仍然必须猜的事项

按危害排序：

1. **I1：presence 依赖如何进入全局 revalidation。**  
   `buildWebSocketAdapter` 可注入 command/query，但 `revalidateAllConnections` 当前只有 `{db,log}`，注册器又在模块加载时全局安装；`onActorRefreshed(..., deps)` 的 `deps` 类型完全未定义。实现者必须猜是把 query 放 `WsConnectionData`、扩 `RevalidateDeps`、设全局 runtime，还是从 registry 反向 compose。放错会让 open snapshot 有线、grant snapshot 无线，或制造模块环。证据：`design.md:26-28,151-172`；`connections.ts:60-63,235-251`。

2. **I2：CAS 与发送的完整调用顺序。**  
   文档只说“CAS 后调 hook”，没有钉：max revision 初始化值、equal revision 是否执行 hook、何时覆盖 actor、`authority.changed` 与 presence direct 的先后、何时清 `revalidating`、hook/fence 失败是否回滚 delivery 状态。R3-1/R3-2 就来自这些空白。

3. **I3：snapshot 与 delta 的线性化点。**  
   当前顺序是 subscribe 后 await `onOpenExtra`（`registry.ts:996-1007`），前端又丢弃首个 snapshot 前的 delta（`design.md:283-284`）。必须明确“取 snapshot→send”是否禁止 await，或者给帧加 process-local revision/cursor；否则 deferred snapshot 可产生“delta 先到被丢、旧 snapshot 后到”的永久陈旧。

4. **I4：连接终态和错误路径。**  
   `opened()` 是同步还是 Promise、何时返回 release、`opened` 部分成功后抛错如何补偿、`openWsChannel/onOpenExtra` 抛错时 socket 是关闭还是保留、`closeConnection` 和 `handleClose` 谁先写终态，都没有合同。install-or-release helper 放 `server.ts`、`connections.ts` 还是 registry 也未唯一确定。

5. **I5：单调时钟由谁持有。**  
   §0 把 clock 定为 application port，§2.2 又写 `snapshot(now)`，而 WS adapter 只拿 query。实现者若自然传 `Date.now()`，它与 `performance.now()` 形成的 `graceUntil` 不同域，宽限中的用户会在 snapshot 中立即被判 offline。应改为 query 注入 clock 并暴露零参 `snapshot()/stateOf()`，或用 branded `MonotonicTick` 明确参数来源。

6. **I6：两枚 timer 对应哪两个 command。**  
   plan T3 只有一个 `flush`，但 grace timer 与 batch scheduler 需要不同回调。若共用 flush，grace 到期可能提前冲掉尚不足 500ms 的 batch。还未说明 batch buffer 持于 `TrackUserPresence` 实例还是 store、重 arm/cancel 语义、observer 抛错时先清还是后清。

7. **I7：provisioning 精确策略。**  
   必须明文钉住 user/manager 默认是、guest/admin 默认否；调用者传入 `additionalPermissions` 时是 union 还是可显式取消默认；OIDC 的 `grantedByUserId/grantedAt`、初始 `accessRevision` 和 audit 如何生成；migration 的冲突/idempotency 语义。当前 AC-21 只点路径，没有写期望结果。

8. **I8：frontend store 的 owner 与帧解析。**  
   `authSessionRevision` 是 state 字段还是 getter fence、谁订阅 `subscribeAuth`、baseUrl 变化如何处理、多个 hook 谁有权 reset、`useSyncExternalStore.getSnapshot` 如何保持引用稳定都没写。`useAuthoritySync` 会同时收到 hello、`authority.changed` 和 presence 帧；必须按 discriminant 忽略控制帧，不能对所有消息直接 `PresenceWsMessageSchema.parse`。

9. **I9：署名 chip 的非真实用户。**  
   `AttributionChip` 明确支持 `null/undefined/'local'` 和已删除、无法解析的 userId（`AttributionChip.tsx:16-28`）。若直接调用 `usePresenceOf`，水化后这些值会显示“离线”。应规定 legacy/unresolved 返回 `undefined`，并补测试。

10. **I10：贯穿链测试落位。**  
    §9.18 同时要求真实 backend adapter、React hook、确定性 timer 和最终 DOM，但 plan 没有指定 Playwright、jsdom fake WebSocket 还是既有 system-mock harness，也没给测试文件。若分成两个 mock-heavy suite，F7 会悄悄复发。

## ④ AC × 测试双向矩阵

下表的 `Tn` 指 design §9 的测试编号。

| AC | 对应测试 | 判定与缺口 |
|---|---|---|
| AC-1 | T6、T18 | **部分**：全链与 500ms 分开存在，但 T18 没明确断言“≤1s”。 |
| AC-2 | T3、T5、T6、T17g | **可证伪**：60s+batch 与用户拍板的嵌套 120/`sendPings` 均有断言；不再要求另拍数值。 |
| AC-3 | T5 | **部分**：只测应用层 close→open；没有实际页面跳转、刷新和 transport reconnect。单条 AC 可由“不发任何帧”空实现满足。 |
| AC-4 | T3、T13 | **可证伪**：有多连接正向计数与关一条控制。 |
| AC-5 | T24 | **可证伪**。 |
| AC-6 | T20、T22 | **可证伪**：五个实际渲染点含两个 Task 分支。 |
| AC-7 | T23 | **可证伪**。 |
| AC-8 | T9、T21b、T22 | **合同冲突**：与 revoked 边沿矛盾，见 R3-5。稳态 no-op presence 也能通过本 AC。 |
| AC-9 | T10、T21b | **部分**：三种静态边沿可测；未覆盖冻结期 delta 与 direct fence miss（R3-1/R3-2）。 |
| AC-10 | T1、T12 | **可证伪**，但 T12 应带 session 正向控制，避免 tracker 全 no-op。 |
| AC-11 | T19 | **部分**：“禁用 / 撤销”没有要求两个独立 case，且必须先断言观察者已看到 online，再断言转 offline。 |
| AC-12 | T16 | **可证伪**；单独看可由完全不存在 presence 实现满足，但 T18 提供全局正向锁。 |
| AC-13 | T14 | **缺一半**：模块零 DB 和 fence 次数有测；“物理 WS 连接数不变”在 §9 没有测试。 |
| AC-14 | T7 | **缺一半**：零 timer 可测；两个生产 adapter 确实调用 `unref()` 没有断言。零 timer 空实现也能过负面部分。 |
| AC-15 | T20、T21、T21b | **可证伪**，但测试必须先证明曾水化，避免 store 永远 unknown 的空实现。 |
| AC-16 | T13 | **可证伪**，已有两连接正向控制。 |
| AC-17 | T6 | **可证伪**：精确一帧、200 changes、499/500ms，已堵住 0-send 空洞。 |
| AC-18 | T11 | **部分**：能测 session 复核失败；没测 channel gate 在 epoch 期间失效，见 R3-3。永不登记也能通过负面 case，须加正常登记控制。 |
| AC-19 | T4 | **部分**：有测试名，但“注入前跳/后跳”未区分 wall clock 与 monotonic clock；按 I5 写错测试会测到不存在的语义。 |
| AC-20 | T17 | **可证伪**。 |
| AC-21 | T17b、T17c | **冲突/部分**：路径齐，但 user/guest/admin 的期望行、audit 与 grant 一致性未定义，且 bootstrap admin 文本冲突。 |
| AC-22 | T17d | **可证伪**：精确覆盖 rev1 晚于 rev2。 |
| AC-23 | T17e | **部分**：只验 direct 成功和类型拒绝；没有 fence mismatch 后必须重同步的 case。 |
| AC-24 | T17f | **部分**：原始 client close 可测；缺 server `closing` 变体和正常 install/release 正向控制。 |
| AC-25 | T21 | **部分**：A→B、transport close、cleanup 都点名；缺两个共享 subscriber 卸载一个的反例。必须先断言 A 已水化，防 always-empty store。 |
| AC-26 | T6 | **可证伪**：前提是净零与“200 人必须发一帧”在同一 suite，后者阻止 buffer 全 no-op。 |

反向检查中，以下测试没有干净对应到 proposal AC，或对应关系本身冲突：

| design §9 测试 | 问题 |
|---|---|
| T1 的“每个角色都 grantable / 不在任何 preset” | 没有可满足的 AC，并与 T17b、admin 动态 baseline 冲突。 |
| T15 的 RFC-152 onOpenExtra/path 数量锁 | 有价值的回归锁，但不是任何 AC；不能替代 AC-13 的真实物理连接计数。 |
| T17b 的 admin 恒有、冗余行清理 | 对应用户拍板，但 proposal 没有独立 AC；建议并入重写后的 AC-21 真值表。 |
| T17g 的“证明坏 regex 会误命中 255” | 是测试质量 meta-guard，不是产品 AC；可以保留。 |
| T20 的 `aria-label` | 对应 design §6.2，但 proposal 没有无障碍 AC；建议并入 AC-6。 |

整体不存在“AC-1…AC-26 中完全找不到任何测试编号”的孤儿 AC，但 AC-1/3/11/13/14/18/19/21/23/24/25 只覆盖了部分谓词或允许负向空操作。

## ⑤ 整体判断

**NOT-CLEAN，v3 仍不能进入实现。**

必须先解决：

- **R3-1～R3-6**；
- 把 I1～I7 写成唯一、可执行的接口和调用顺序；
- 补齐 AC-1、AC-3、AC-11、AC-13、AC-14、AC-19 的测试缺口；
- 为 AC-18/24/25 增加正向控制，防止“从不登记 / store 永远未知”的空操作通过。

R3-7 是 P2，不单独阻断，但建议随 v4 一并关闭。全程只读；未修改、暂存、提交、推送或 stash，最终工作树仍只有原先未跟踪的 RFC-312 目录。


