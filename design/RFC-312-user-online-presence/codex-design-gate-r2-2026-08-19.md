# RFC-312 设计门第二轮记录（Codex，2026-08-19）

- 评审对象：RFC-312 三件套 v2（按第一轮 15 条 finding 重写后）
- 任务：①逐条核验 15 条是否**真**修好；②专审**修复本身引入的新问题**
- 执行：pin 到 `09ed0259` 的分离 worktree + `codex exec --sandbox read-only < /dev/null`，
  model `gpt-5.6-sol`，effort max，session `01a01838`
- 结论：**NOT-CLEAN，仍不可进入实现**——8 条真修好、5 条表面修好、2 条用户已接受；
  **新增 7 条 P1（N1-N7）**，其中 N5 / N6 是 v2 修复动作自身引入的
- 注：原始输出的 file:line 是 markdown 链接，按 CLAUDE.md 规则已转纯文本

---

## 15 条核验表

| 编号 | 判定 | 一句话理由 |
|---|---|---|
| F1 | **表面修好但实质仍在（用户已接受）** | v2 已如实承认每帧×每订阅者一次 DB fence，但高峰同步点查和延迟场景没有消失，只被记为已接受成本，见 design §8.2。 |
| F2 | **表面修好但实质仍在** | `admin: [...PERMISSIONS]` 会自动吸收新点，admin 仍无法显式授予或撤销；其 backfill grant 还会被判为冗余。 |
| F3 | **表面修好但实质仍在** | 新钩子只拿 fresh actor、依赖无 revision 的可变缓存位；并且撤权帧与新 frameGate 的发送路径互相矛盾。 |
| F4 | **真修好** | `{ hydrated, onlineIds }` 能区分离线与未知，快照前增量丢弃、撤权/断连清空也已写入契约；另有新生命周期问题 N6。 |
| F5 | **表面修好但实质仍在** | 仍未给出具体 WS idleTimeout 数值；建议照搬的现有测试会先匹配 HTTP 的 `idleTimeout: 255`，实现前即可恒绿。 |
| F6 | **真修好** | 原来“epoch 复核失败仍先登记”的假上线已被消除；但新落点产生 close-before-registration 竞态，见 N5。 |
| F7 | **真修好** | design §9.18/§9.19 已明确真实 adapter、真实 `useAuthoritySync`、确定性 timer 到 `PresenceDot` 的全链验收。 |
| F8 | **真修好** | grace/batch 两个独立 port、`pending` 维护和“deadline、buffer 均空才零 timer”已经一致。 |
| F9 | **真修好** | 对原始 `authority.changed` 连坐问题，按帧类型放行控制帧确实有效；`presence.revoked` 是新问题 N4。 |
| F10 | **真修好** | 已删除假 `WS_PATHS.presence`，并明确更新既有 `onOpenExtra` 穷举锁而保持通道/路径数不变。 |
| F11 | **真修好** | deadline 改为 `performance.now()` 同域的单调刻度，且状态不持久化，进程重启不存在跨 clock-origin 比较。 |
| F12 | **未修（用户已明确接受）** | 持权用户仍能通过全量 snapshot/delta 和 lookup 重建全平台上下线轨迹；v2 是披露并接受，不是消除。 |
| F13 | **未修** | 停在 `/auth` 仍会显示离线，只是定义收窄为 AppShell；而 proposal §7 的四项拍板并未记录这项范围收缩。 |
| F14 | **真修好** | proposal、design、plan、store 和组件契约已统一为“未知/无点”，不再互相冲突。 |
| F15 | **真修好** | `TaskMembersPanel` 只读分支和 `UserPicker` 可管理分支均已列入接线与测试范围。 |

## 六项源码事实核对

1. **旧权限 vs 新权限：不成立。**  
   现有循环先覆盖 `ws.data.actor`，见 `packages/backend/src/ws/connections.ts:175-180`；v2 钩子只传 `freshActor`，旧值靠 `presenceGranted` 猜，见 design §3.4。复核触发是 fire-and-forget、没有 per-socket 队列，见 `ws/revalidationHook.ts:63-72`、`ws/connections.ts:235-251`；源码自己也承认 concurrent rescan，见 `ws/connections.ts:169`。

2. **每个角色都可显式授予/撤销：不成立。**  
   admin baseline 是全部 `PERMISSIONS`，见 `permission.ts:1058-1063`；normalizer 拒绝 baseline grant，见 `:1092-1118`；`grantableAdditionalPermissions` 也排除 baseline，见 `:1181-1187`。user/manager/guest 可授予，admin 不可。

3. **`createManagedUser` 是唯一建用户入口：不成立。**  
   OIDC 自助建号走 `createUserWithIdentity → insertInitialUserAccessInTransaction`，见 `services/userIdentities.ts:134-184`；该入口当前只插 user/audit、没有 grants，见 `sqliteUserAccessRepository.ts:141-164`。OIDC 默认角色允许 `user`，所以这是可达绕过路径。首个 bootstrap admin 也走同一 participant，见 `auth/loginPolicy.ts:184-248`。

4. **backfill 与迁移约定：无法完整核实，方案本身可兼容。**  
   当前末条是 `0184`、journal 共 184 条，见 `meta/_journal.json:1286-1292`、`upgrade-rolling.test.ts:460-462`；正常下一号应为 `0185`、journal count 185。实际 SQL 尚不存在，因此无法核实是否补齐 `granted_at`、journal、rolling-upgrade 与冲突处理。Drizzle 的“一次应用、完整前缀校验”机制见 `db/client.ts:174-196`、`schemaAdmission.ts:109-136`。

5. **Bun 配置位置成立；现有测试可照搬不成立。**  
   WS 值位于嵌套 `websocket.idleTimeout`，默认 120 秒，`sendPings` 默认 true，见 `bun-types/serve.d.ts:448-468`；顶层 HTTP `idleTimeout` 是另一字段，见 `:760-766`。当前仓只设了顶层 255，见 `cli/start.ts:727-751`。现有测试的无作用域 regex 见 `cli-start-idle-timeout.test.ts:31-45`，不能原样复用。

6. **产品帧与 `authority.changed` 可共存成立，但必须显式分流。**  
   `useWebSocket` 先处理 `authority.changed`，随后仍把同一帧交给所有 listeners，见 `useWebSocket.ts:160-189`；因此新 dispatcher 同时会收到 `hello`、`authority.changed` 和 presence 帧。按 discriminant 忽略控制帧即可，不会破坏现有 invalidation；直接拿 `PresenceWsMessageSchema.parse` 处理所有帧则不成立。

八项新增机制中：1/2 对应 N3、N4；3 对应 N1、N2；4 对应 N6；5 对应 N5；8 对应 N7。两枚定时器/`pending`/batch 的设计目前没有发现独立、可复现的新故障，但 batch buffer 必须保存“窗口初态+末态”，不能只存末态。单调时钟与进程内易失模型相容；仓库实际是原子 PID 文件单实例锁，不是 proposal 所称的 kernel `flock`，见 `util/lock.ts:1-4`，但单进程前提仍成立。

## 新 findings

### N1 [P1] 显式 grant 方案与 admin 的动态全量 baseline 不可同时成立

- 证据：design §5、§9.1；`permission.ts:1058-1063,1092-1118,1181-1187`；`frontend/src/lib/user-permissions.ts:57-75`。
- 具体失败时序：把 `users:presence` 加入 `PERMISSIONS` → admin 自动获得 baseline 权限 → migration 又给 admin 插入同名 grant →读取时该行被判 `user-permission-redundant` 并丢弃 → UI 行是不可编辑 baseline → 删除 grant 也不影响有效权限，admin 永远无法按账号撤权。
- 建议：在不引入 deny 的既定选择下，必须重定义 admin preset，使 `users:presence` 不在 baseline，再通过默认 grant/backfill 发放；补四角色“授予→有效→撤销→失效”测试及存量 admin 迁移测试。
- 归类：**设计方向**。

### N2 [P1] 默认 grant 只落 `createManagedUser` 会漏掉 OIDC `user` 自助建号

- 证据：plan T10 只点名 `createManagedUser`；`services/userIdentities.ts:134-184`；`sqliteUserAccessRepository.ts:141-164`；`shared/src/schemas/auth.ts:11-12`。
- 具体失败时序：管理员把 OIDC 默认角色设成 `user` → 新身份首次登录 → `createUserWithIdentity` 直接调用 initial-access participant → 新账号为 active user、但无 `users:presence` grant → 打开 AppShell 后服务端不发 snapshot，违背“新建非 guest 默认授予”。
- 建议：把默认授权策略放入 identity-access 的统一 provisioning seam，并让 HTTP/CLI、OIDC user/guest、bootstrap 都走同一策略；测试必须覆盖 OIDC default=`user` 与 `guest`。
- 归类：**实现细节**。

### N3 [P1] `onActorRefreshed` 的缓存位不是可靠的权限边沿，重叠复核可倒序覆盖

- 证据：design §3.4 只传 fresh actor 并依赖 `ws.data.presenceGranted`；`connections.ts:155-180,210-212`；`revalidationHook.ts:63-72`。现有代码既无串行队列，也无“只接受不低于当前 revision”的 CAS。
- 具体失败时序：grant revision 1 的 pass A 尚在 await；随后 revoke revision 2 的 pass B 先完成并发送 `presence.revoked`、置缓存 false；A 后完成，把旧 actor/缓存重新写成 true并补 snapshot。最终数据库已撤权，前端却重新水化全量名单。反向完成顺序则会让最终已获权用户被错误清成未知。
- 建议：去掉独立布尔真相源；在覆盖前捕获 `previousActor`，按 `authorityRevision` 做 per-socket 单调 CAS或串行队列，再把 `{previousActor,freshActor}` 交给钩子。增加两个 pass 反向完成的确定性测试。
- 归类：**设计方向**。

### N4 [P1] `presence.revoked` 在新 actor 已失权后没有明确的合法发送出口

- 证据：design §3.2 将 `presence.revoked` 纳入需 `users:presence` 的 frameGate；§3.4 又要求覆盖成无权限 actor 后发送。真实 broadcaster 路径按新 actor gate，见 `registry.ts:973-980`；直接 `ws.send` 又绕过 `sendJson` 的 DB/current fence，见 `registry.ts:1010-1057`。
- 具体失败时序：管理员撤权 → actor 替换为无 presence 权限 → 若钩子走 broadcaster，revoked 被 frameGate 丢弃，旧名单永久残留；若照现有 `authority.changed` 方式裸 `ws.send`，则重叠 revision 下可能发送由旧 actor 产生的过期 snapshot/revoke。
- 建议：定义一个只面向当前 socket 的 `sendFencedDirect`，明确 snapshot/revoked 不走 broadcaster frameGate、但必须走 revision/status fence；将 broadcaster 类型收窄为真正可广播的 `presence.changed`，并用真实发送路径验证撤权。
- 归类：**实现细节**。

### N5 [P1] epoch `await` 期间先 close、随后再登记，会永久漏掉 release

- 证据：当前 `handleOpen` 在 `trackConnection` 后可能 await `reresolveActor`，见 `server.ts:223-241`；`handleClose` 只 untrack/unsubscribe，见 `:244-252`；v2 要在 await 后登记并把 release 放到 `ws.data`，见 design §4.1–§4.2。
- 具体失败时序：epoch 已变化 → `handleOpen` 开始 await → 客户端关闭，`handleClose` 先运行，此时 `releasePresence` 尚不存在 → await 返回后 `opened(userId)` 将计数加一并安装 release → 不会再有第二次 close 回调，该用户永久在线且没有 grace timer可回收。对 Bun 1.3.13 的 0.5 秒实测顺序为 `open:start → client:open → server:close → open:end`，证明该交错真实可达。
- 建议：`handleClose` 必须留下 closed tombstone；每个 await 后检查，再通过原子的 install-or-release helper 安装句柄——若 close 已发生则不得登记或须立即对消。加 deferred-reresolve 的回归测试。
- 归类：**实现细节**。

### N6 [P1] 全局 presence store 仅依赖 React 的断连状态，账户切换时可把上一账号名单带进下一账号首帧

- 证据：design §6.1 仅规定 revoked/断连清空；连接池卸载时先删除 state listener、再 `markDisconnected`，见 `useWebSocket.ts:127-139`；认证变化会同步 force reconnect，见 `:75-90`；仓库已有专门的 `authSessionRevision`，见 `stores/auth.ts:20-29,69-89`。
- 具体失败时序：账号 A 已水化全量名单 → logout/token 切换使 AppShell 同时卸载 → connection listener 已被移除，断连状态无法再驱动 reset → 模块级 store 保持 hydrated → 无 `users:presence` 的账号 B 登录时，子组件首个 render 读取 A 的名单；至少会泄漏一个 paint，若实现没有 mount-time reset则持续到下一次快照。
- 建议：store 必须绑定 auth/baseUrl/connection generation；认证 revision 变化、transport close、hook cleanup 都应同步 reset，不能只靠 passive effect。增加 A有权→退出→B无权及 daemon切换测试。
- 归类：**设计方向**。

### N7 [P1] idleTimeout 修复尚无可执行参数，且计划中的测试会被现有 HTTP 配置误命中

- 证据：design §7、plan T10 未给具体数值；当前 `cli/start.ts:727-751` 只有 HTTP `idleTimeout:255`；WS 与 HTTP 配置分别见 Bun types `serve.d.ts:448-468,760-766`；现有测试 regex 见 `cli-start-idle-timeout.test.ts:31-45`。
- 具体失败时序：实现者照现有测试写 `/idleTimeout:\s*(\d+)/` → 在完全没改 `websocket: ws.handlers` 时测试已读到 255 并通过 → 生产继续继承 WS 默认 120 秒，所谓“显式钉死”和硬断总上界均未实现。反过来随意选一个更短值，又会统一改变所有 authority/task/workflow 等 WS，设计没有锁定 `sendPings` 或存量通道存活回归。
- 建议：先拍板具体秒数与总 SLA；在唯一 handler tree 上显式设置 `idleTimeout` 和 `sendPings:true`。测试应直接断言嵌套 handler 配置或运行时行为，不能做无作用域源码 regex，并至少覆盖一个 presence-independent 的既有 WS 通道。
- 归类：**设计方向**。

## 整体判断

**NOT-CLEAN，v2 仍不可进入实现。**

必须先解决的新问题：**N1–N7**。其中 N1/N2 使 F2 未闭合，N3/N4 使 F3 未闭合，N7 使 F5 未闭合；N5、N6 是修复动作新引入的独立 P1。

另外：

- F1、F12 是用户明确接受的残余风险，可以不作为阻断，但不能记成“技术上已修复”。
- F13 的行为仍存在，且不在 proposal §7 的四项拍板中；若没有会话外批准，需要补用户确认。
- F14 技术上一致，但其“未知”选择同样未列入四项拍板；若四项记录是完整记录，也应补确认。

本轮保持只读；未修改、暂存、提交或推送任何文件。最终工作树仍只有原先未追踪的 `design/RFC-312-user-online-presence/`。


