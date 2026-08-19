# RFC-312 设计门记录（Codex，2026-08-19）

- 评审对象：RFC-312 三件套 v1
- 执行方式：pin 到 `09ed0259` 的分离 worktree + `codex exec --sandbox read-only`，
  model `gpt-5.6-sol`，reasoning effort max，session `01a017e7`
- 结论：**不可进入实现**；15 条 finding（F1-F7 P1，F8-F15 P2）
- 处置对照见 `design.md §11`；v2 三件套已按此重写
- 注：原始输出里的 file:line 是 markdown 链接，按 CLAUDE.md 强制规则已转为纯文本

---

## 第一步：9 项事实断言

1. **成立，但仅限成功 session 升级的通用认证段。**  
   `resolveActor` 在 `ws/server.ts:134` 调用：session 查询两次 SELECT、一次 `last_used_at` UPDATE（`sessionStore.ts:139-152`），再由 `buildCurrentActor` 做一次权限快照 SELECT（`actor.ts:122`、`sqliteUserAccessRepository.ts:84-90`）。`buildWsCredential` 在 `server.ts:200` 又重复两次 SELECT、一次 UPDATE（`session.ts:102-113`），合计 5 读 2 写。  
   但它不是“所有升级尝试/完整建连”的总成本：失败凭据会提前返回，带 `upgradeGate` 的通道还有额外读取，发送 hello/product frame 也有额外读取，见 F1。

2. **成立，但“约 3 读”指 session/PAT 的 `reresolveActor` 段。**  
   session/PAT 都是凭据行 SELECT + 用户行 SELECT（`sessionStore.ts:139-147` / `patStore.ts:145-153`）+ 当前权限快照 SELECT（`actor.ts:122`），并显式 `touch:false`（`session.ts:171-192`），所以 3 读 0 写；daemon/失效凭据可能更少。循环确为 `for...of` 内串行 `await reresolveActor`，之后某些通道还会串行 `await checkUpgradeGate`，见 `connections.ts:147-213`。

3. **不成立：无 target 的全量复核写点是 7 个，不是 6 个。**  
   RFC 列出的 6 个都存在：`resourceAcl.ts:750`、`sessionStore.ts:175,189`、`patStore.ts:184`、`userIdentities.ts:316`、`loginPolicy.ts:264`。遗漏的是任务成员写入提交后的 `await triggerRevalidationAndWait(db, 'task-members-changed')`，见 `taskCollab.ts:252-255`。该入口同样不传 target（`revalidationHook.ts:56-59`）。

4. **成立。**  
   `authorityBroadcaster` 目前只有定义和注册表订阅，没有生产侧 `.broadcast`；源码注释也明确它是 silent channel，见 `broadcaster.ts:155-158`、`registry.ts:514-527`。`authority.changed` 当前由复核循环逐 socket 直接 `ws.send`，见 `connections.ts:183-226`。presence 会是已接好订阅路径的第一个生产者。

5. **不成立，断言过度绝对化。**  
   普通认证路由确实由 `AppShell` 常驻调用 `useAuthoritySync()`（`AppShell.tsx:64-66`），但根路由对 `/auth`、`/setup/admin` 无条件使用 `BareShell`，即使 token 仍存在也不挂 `AppShell`，见 `__root.tsx:90-115`。所以只能说“所有 AppShell 认证页面”，不能说“每个登录后的页面”。

6. **成立，指正常的 server-initiated close 生命周期。**  
   `closeConnection` 同步 `untrackConnection`（`connections.ts:103-125`），Bun close 回调又调用一次（`server.ts:244-252`）；当前 `Set.delete` 幂等（`connections.ts:73-80`）。

7. **成立。**  
   `users:read` 明确在 `MANAGER_PRESET_MISSING_PERMISSIONS`（`permission.ts:1224-1235`）；manager 只是 `USER_BASELINE + MANAGER_EXTRA`，而 `USER_BASELINE` 含 `users:search`（`permission.ts:997-1062`）。`resolveTokenPermissions` 最终逐项删除全部 `SYSTEM_DOMAIN_POINTS`，见 `permission.ts:1251-1276`。

8. **成立。**  
   `WorkgroupMemberSchema` 有 `memberType` 与 nullable `userId`（`workgroup.ts:107-132`）；输入 schema 强制 human 必须携带 `userId`，且禁止 `agentId`，见 `workgroup.ts:135-160`。

9. **“新增 frameGate 会让既有测试变红”不成立；“既有测试无一需要改”也不成立。**  
   `rfc152-ws-channel-registry.test.ts`：

   - 正向锁定现有 7 个 `frameGate`，但没有断言 `authority.frameGate` 必须为 `undefined`（`168-204`），所以**只新增 authority frameGate 不会红**。
   - 锁定 authority 的现有断言是 `upgradeGate === undefined`（`:191`）与 `aclBypassShortCircuit !== true`（`:204`）。
   - `:359` 的“无 frameGate 全转发”确实使用合成 probe，不针对 authority。
   - 但 `:205-209` 穷举断言 **onOpenExtra 只有 task 有**；RFC 计划给 authority 加 `onOpenExtra`，该测试必红。
   - design §9 还要求 `WS_PATHS.presence`，而 `rfc152-ws-paths-interlock.test.ts:17-33` 将 key 集锁死为现有 11 条；新增该假路径也会红。

## Findings

### F1 [P1] presence 经现有统一发送出口会产生每订阅者一次同步 DB 读，“全链路零 DB”结论不成立

- **证据**：`gatedSubscribe` 在 frameGate 通过后调用 `sendJson`（`ws/registry.ts:940-980`）；`sendJson` 无条件调用 `authorityRevisionCurrent`，后者执行 `SELECT status, access_revision FROM users`（`registry.ts:1010-1056`）。与 design §3.1、§8.1、proposal AC-13 冲突。
- **具体失败场景**：200 人在一个批次内上线，向 300 个 authority 订阅者发送一帧；合并虽把 60,000 次 socket send 降到 300 次，但仍产生 300 次同步 SQLite SELECT。高峰下唯一连接被连续占用，用户的 HTTP/WS 操作出现延迟。每次新建连接下发 snapshot 也会再付一次读取，除非绕开现有安全发送出口。
- **建议**：先设计一个不破坏 RFC-305 revision fence 的零 DB 发送依据，例如由 identity-access 单写者同步维护内存 revision/status authority；或者承认每帧 DB 读并重写 G3、成本表和 AC-13。必须用真实 `gatedSubscribe → sendJson` 的 SQL spy 验收，不能只 spy presence 模块。
- **归类**：**设计方向**。

### F2 [P1] “默认全员且管理员可对具体账号收回”在现有 additive-only 权限模型中不可表达

- **证据**：有效权限只做 `ROLE_PERMISSIONS ∪ additionalPermissions`（`permission.ts:1172-1179`）；baseline 权限在 UI 中不可编辑（`user-permissions.ts:57-75,91-97`），写入规范化也拒绝将 baseline 点作为附加项（`permission.ts:1092-1118`）。`catalogEntry` 默认又是 `account-additive`（`permission.ts:347-360`）。
- **具体失败场景**：将 `users:presence` 放进 `USER_BASELINE` 后，管理员打开普通 user/manager 的权限面板，presence 行是只读 baseline，API 也没有 deny 集合，无法单独收回；该用户继续收到完整快照。反方向上，guest 虽不在 baseline，却会把该点显示为可附加，管理员可以授予它，违反“guest 不持有”的绝对表述。
- **建议**：用户须选择：引入显式 subtractive deny；或不放 baseline、通过创建/迁移规则形成可撤销的显式 grant；或删除“按账号收回”与“guest 永不持有”的承诺。
- **归类**：**设计方向**。

### F3 [P1] 同一 authority 连接上的权限授予/收回没有快照重同步协议

- **证据**：权限变更只刷新 `ws.data.actor` 并发送 `authority.changed`（`connections.ts:175-188`）；`onOpenExtra` 只在物理 open 时执行一次（`registry.ts:996-1007`）。design §6.1 只定义“断连清空”，§7 甚至写成“收回后等下次重连清空”。
- **具体失败场景**：
  - 无权限用户已连着 authority，管理员授予 presence：actor 刷新后增量帧开始放行，但不会补 snapshot；当前已在线者永远缺失，直到各自再翻转。
  - 已有权限用户被收回：后续帧被 gate 丢弃，但前端保留此前名单，authority 又按设计不断连；用户可能无限期继续看到在线点。
- **建议**：定义显式权限转换协议：刷新后服务端重发或撤销 snapshot，或让客户端在新 actor 落地后清空/请求重同步；至少覆盖 revoke→grant、grant→revoke、无关权限 revision 三条同 socket 测试。
- **归类**：**设计方向**。

### F4 [P1] 前端 store 缺少“已获得权威快照”状态，无法同时表达离线与未知

- **证据**：wire snapshot 只列 `online: string[]`（design §3.1）；前端设计只有 `Map<userId, boolean>`，并要求 `usePresenceOf` 返回 `boolean | undefined`、`undefined` 隐藏组件（design §6.1–§6.2）。
- **具体失败场景**：授权观察者收到 `online: []` 后查询离线用户 Bob。若 Map 缺键返回 `undefined`，Bob 的离线点完全不显示；若缺键返回 `false`，则在快照尚未到达、断线或无权限时也会显示“离线”，违反 AC-8/AC-15。
- **建议**：store 必须显式建模 `{ hydrated, onlineIds }`；只有 `hydrated=true` 时缺集合的 ID 才是 offline，断连/撤权重置为 unknown。增量在首个 snapshot 前的处理顺序也需写入契约。
- **归类**：**实现细节**。

### F5 [P1] AC-2 对断网承诺的 60 秒上界与“无 heartbeat”方案不可同时成立

- **证据**：proposal AC-2 把“关闭标签页 / 断网”都写成 60s 左右；design §7 已承认 abrupt loss 要先等 Bun 回收半开 TCP，再加 60s，且检测窗口尚未钉住。生产 `Bun.serve` 只有 HTTP `idleTimeout:255`，没有应用层 WS heartbeat，见 `cli/start.ts:727-751`。
- **具体失败场景**：笔记本断电或 Wi‑Fi 单向中断，没有 FIN/close callback；服务端继续计数至运行时判死，之后才开始 60s 宽限。其他用户看到其在线远超 1 分钟。
- **建议**：要么增加可量化 heartbeat/idle 判死并给出总 SLA，要么把 AC-2 改成“服务端确认连接关闭后 60s”，并明确 abrupt loss 的最坏窗口。不能把尚待实测的运行时默认值当成已验收上界。
- **归类**：**设计方向**。

### F6 [P1] 在 epoch 复核前登记 presence 会让已在升级途中被撤销的连接制造一次假上线

- **证据**：现有 `handleOpen` 必须先 `trackConnection(ws)`，再检查升级期间变化的 epoch 并 `reresolveActor`（`server.ts:216-241`）。RFC design §4.1/plan T6 却把 `presence.opened` 直接塞进这个 `trackConnection`。
- **具体失败场景**：session 在 `resolveActor` 后、Bun open 前被撤销。open 回调先把用户计为 online，再复核发现失效并关闭；close 只进入 60s 宽限，不产生即时 offline。500ms 后观察者看到这个根本未通过最终授权的用户上线，并保持约一分钟。
- **建议**：把 live-set 登记与 presence 登记拆开：先加入 RFC-212 live set并通过 epoch 复核，再获得 presence release handle；复核失败的连接不得进入宽限。
- **归类**：**实现细节**。

### F7 [P1] 测试清单没有强制穿过真实生产链，核心功能断线仍可能全绿

- **证据**：当前生产消费点仍是 `ignoreProductFrame`（`useAuthoritySync.ts:7-19`）。design §9 将 backend、store、组件分开测试，没有点名一条穿过 `handleOpen → tracker → composition → authorityBroadcaster → frameGate → useAuthoritySync → store → PresenceDot` 的测试。
- **具体失败场景**：后台 tracker、store 与四个组件测试均通过，但实现者忘记替换 `ignoreProductFrame`，或 composition 没接 broadcaster；组件测试直接 seed store 仍绿，真实用户一个在线点都看不到。AC-17 若只断言“O(订阅者)”，丢弃全部变化的 0 次发送同样满足该表述。
- **建议**：增加至少一条生产链集成：两个 session actor、真实 WS adapter、确定性 timer、真实 authority consumer；精确断言每个订阅者收到 1 帧且载荷含 200 个最终变化。AC-12/13 的源码守卫须配 mutation 或真实副作用断言，AC-18 保留现有明确的 2 写红→1 写绿。
- **归类**：**实现细节**。

### F8 [P2] 500ms 合并窗口及 pending 索引没有形成 RFC-294 的显式应用层 port，并与 AC-14 自相矛盾

- **证据**：design §0 的 port 表只有 grace timer；§2.1 又让 store 隐式维护 `pending` 子集；§3.2 要求另一枚 500ms 合并计时器。AC-14 却断言“无人在宽限期时不存在 presence 定时器”。
- **具体失败场景**：第一个用户上线时无人处于宽限期，但为了 500ms 批处理必须存在计时器。若遵守 AC-14 不设 timer，变化无法按期刷新；若复用唯一 grace timer，合并 flush 与另一个用户的 60s deadline 会互相覆盖；若直接裸 `setTimeout`，测试无法确定性驱动且可能拖住退出。
- **建议**：新增独立、可注入且生产实现 `unref()` 的 batch scheduler port；明确 pending 索引在 open/reopen/reap 时的维护和重排；AC-14 改成“无 grace deadline 且 batch buffer 为空时无 timer”。WS adapter应接收 public command/query，而不是只拿 `db` 后自行 compose。
- **归类**：**实现细节**。

### F9 [P2] 当前 direct control path 不受影响，但拟议 frameGate 会错误过滤注册表合同内的控制帧

- **证据**：authority 的声明消息类型当前是 `WsControlMessage`（`registry.ts:126-138`）；`gatedSubscribe` 对 broadcaster 的每一帧统一执行 frameGate（`registry.ts:932-980`）。当前 `authority.changed` 因直接 `ws.send` 才绕过它（`connections.ts:220-226`）。
- **具体失败场景**：任何生产者按注册表的正式 broadcaster 合同发送 `{type:'authority.changed'}`，无 `users:presence` 用户会被简单的 `permissions.has` gate 拦截，actor 查询和导航保持旧权限。
- **建议**：frameGate 必须按消息类型判定：所有 control frame 放行，只对 `presence.*` 检查权限；增加“无 presence 权限仍通过 broadcaster 收到 authority.changed”的回归测试。
- **归类**：**实现细节**。

### F10 [P2] RFC 对 RFC-152 既有测试的判断与自身 wire 测试清单互相冲突

- **证据**：`rfc152-ws-channel-registry.test.ts:205-209` 锁 `onOpenExtra` 仅 task；`rfc152-ws-paths-interlock.test.ts:17-33` 锁 WS_PATHS 与 11 通道双射。design §9.2 却要求 `WS_PATHS.presence`，§9.13 又声称既有测试无一需改。
- **具体失败场景**：照正文“不新增路径”实现，新增测试因 `WS_PATHS.presence` 不存在而红；为迎合测试添加假 key，则既有双射锁红，且该路径访问只会得到 404。给 authority 加 snapshot hook 时，另一个既有测试也必红。
- **建议**：删除 `WS_PATHS.presence` 断言；有意识地更新 onOpenExtra 穷举锁和测试文件顶部的 frameGate 合同说明，同时保留通道数/路径数不变。
- **归类**：**实现细节**。

### F11 [P2] 使用 `Date.now()` 绝对 deadline 会让系统时钟回拨直接延长在线状态

- **证据**：design §1.2 把 `graceUntil` 定义为墙钟时间戳，§2.3 明确生产注入 `Date.now`。
- **具体失败场景**：最后连接关闭后，系统时钟被 NTP/管理员回拨 5 分钟。真实 60 秒后 timer 触发，但 `now < graceUntil`，条目不可回收并重新 arm；用户会被显示在线约 6 分钟。
- **建议**：进程内、不持久化的宽限期使用单调时钟；至少为前跳、后跳、精确边界各加确定性测试。
- **归类**：**实现细节**。

### F12 [P2] `online: string[]` 实际暴露的是全平台实时在线花名册，不只是四处 UI 的局部布尔

- **证据**：design §3.2 向每个有权限者发送全部在线 userId；普通 user 又默认持 `users:search`。`POST /api/users/lookup` 每次可把最多 200 个已知 ID 映射为用户名/显示名，见 `routes/users.ts:78-99`。
- **具体失败场景**：普通用户无需与其他人共享任务或工作组，只需在 DevTools 记录 snapshot/delta，再分批 lookup，即可持续还原全平台人员上下线轨迹。
- **建议**：把“全局实时 roster”作为独立隐私影响呈用户确认；若只批准 inline indicators，需要设计按当前可见身份集合订阅/查询的收窄方案，而不是全量广播。
- **归类**：**设计方向**。

### F13 [P2] “任意登录页面必有 authority 连接”的产品前提有可复现例外

- **证据**：`RootShell` 对 `/auth`、`/setup/admin` 在 token 判断前直接返回 `BareShell`（`__root.tsx:99-115`）；`AuthPage` 不会因已有普通 session token 自动离开该页面。
- **具体失败场景**：已登录用户手动访问 `/auth` 并停留；AppShell 卸载、authority socket 关闭，60s 后别人看到其离线，尽管浏览器仍打开平台页面。
- **建议**：用户选择将定义收窄为“打开任一 AppShell 页面”，并修改 proposal §2/AC-1；或把 authority/presence 订阅提升到 token-aware root、只排除 daemon bootstrap。
- **归类**：**设计方向**。

### F14 [P2] daemon 重启期间到底显示“离线”还是“未知/无点”，三份文档没有单一产品结论

- **证据**：proposal AC-15 要求“显示离线”；design §6.1、§7 要求断连后 `undefined`、渲染 null；plan AC-15 又写“不可知”。
- **具体失败场景**：daemon 重启后，同一个实现若隐藏圆点符合 design/plan，却违反 proposal；若显示离线则把连接未知误报为用户离线，并违反 `undefined → null` 组件契约。
- **建议**：由用户明确选择 offline 或 unknown；三件套、i18n、组件状态和验收测试统一。
- **归类**：**设计方向**。

### F15 [P2] 任务成员面板的可管理分支并没有“成员行”，plan 漏掉真实渲染组件

- **证据**：只读分支在 `TaskMembersPanel.tsx:244-253` 自己渲染 chips；有管理权时则把成员交给 `UserPicker`（`:231-243`），实际 chip 位于 `UserPicker.tsx:187-224`。plan T9 只列 `TaskMembersPanel.tsx`。
- **具体失败场景**：普通成员打开面板能看到 collaborator 在线点；owner/manager 进入可编辑模式后，同一批人改由 UserPicker 渲染，在线点全部消失。
- **建议**：给 `UserPicker` 增加可选的用户 adornment/render hook，或明确另一套不重复的展示；测试必须覆盖 canManage=true/false、owner 与 collaborator。
- **归类**：**实现细节**。

## AC-1…AC-18 可证伪性核对

| AC | 判定 |
| --- | --- |
| AC-1 | **未闭合**：缺真实端到端链，且“任意页面”有 F13 反例。 |
| AC-2 | **按断网口径不可达**：见 F5；普通 FIN close 可测。 |
| AC-3 | **部分可测**：领域 close→open 可用假时钟；真实 refresh/reconnect 链未列出。 |
| AC-4 | **可执行**：引用计数表测 + 双释放集成可以证伪。 |
| AC-5 | **不完整**：测试清单只说出现点，未锁“最后登录文案与排序不变”。 |
| AC-6 | **不完整**：四处有清单，但任务成员管理态漏了 F15。 |
| AC-7 | **可执行**：design §9.21 的同一行双语义断言充分。 |
| AC-8 | **不闭合**：baseline 不可收回、guest 可附加、store 未清空，见 F2–F4。 |
| AC-9 | **仅后台半链**：控制帧 direct path仍送达，但前端继续显示旧名单，见 F3/F9。 |
| AC-10 | **可执行**：SYSTEM_DOMAIN/PAT 公式与 session-only tracker 均有正反断言面。 |
| AC-11 | **缺集成**：现有复核关闭与 presence 宽限分别可测，但清单没有 revoke/disable→close→offline 全链。 |
| AC-12 | **弱守卫**：关键字源码扫描在实现前就绿，也可被别名绕过；须配 forbidden dependency/import 与 prompt 快照。 |
| AC-13 | **当前不成立**：实际发送出口读 DB，且“没新增 useWebSocket 调用”不等于实际物理连接数不变。 |
| AC-14 | **与 AC-17 冲突**：任何 500ms batch 都需要临时 timer，见 F8。 |
| AC-15 | **语义冲突且缺重启链**：见 F14。 |
| AC-16 | **可执行**：明确的两连接/双释放回归足够。 |
| AC-17 | **表述不可直接断言**：单一规模上的 “O(订阅者)”允许 0 次发送；须断言准确帧数、载荷和 499/500ms 边界。 |
| AC-18 | **红→绿设计正确**：但必须把计数边界写成成功 session 的通用 `tryUpgrade` 认证段，不能声称完整建连总成本。 |

## 整体判断

RFC-312 **不可进入实现阶段**。

必须先解决：

- 核心阻断：**F1–F7**。
- 需要用户拍板的产品/隐私语义：**F2、F5、F12、F13、F14**。
- 作者可自行修正、但应在开工前写回设计与测试计划：**F8–F11、F15**。

本次只读完成；没有修改、暂存、提交或运行测试。工作树仍只有原先未跟踪的 `design/RFC-312-user-online-presence/`。


