# RFC-212 设计门对抗审查记录（2026-07-21）

> Codex 配额耗尽（到 2026-07-25），按 RFC-206/211 的先例改跑 4 视角对抗自审 + 一名裁决者逐条复核。
> 裁决结论：**不能进入实现，必须先改 RFC**。本文件是原始记录，修订后的 RFC 见同目录三件套。

---

## 裁决（逐条复核后）

以下逐条裁决，所有锚点均已亲自复核。

---

# 一、确认成立的阻断项（按严重度）

## B1 — §2 五步从不写回 `ws.data.actor`，AC-2 结构性不可达
**复核**：`registry.ts:587` 每帧现读 `ws.data.actor.user.role`；`registry.ts:598` 每帧把 `ws.data.actor` 传进 frameGate ctx；`registry.ts:499` scheduled-tasks 读 `ctx.actor.permissions`；`registry.ts:126` 注释写死「Resolved actor pinned at upgrade」。`design.md:22-26` 的五步（resolveActor → close → 清 cache → 重跑 upgradeGate → 写 epoch）**无一步赋值 actor**，`design.md:48-57` 的 ConnectionData 也只加 token/epoch。三位审查者独立命中，成立。

附带纠错：AC-2（`proposal.md:62`）把 `tasks-list` 写成「不再享有 admin 短路」是错的——`registry.ts:369-372` 明说 tasks-list **没有** `adminShortCircuit`，其 admin 行为来自 `canViewTask` 内部短路（`taskCollab.ts:35` `if (actor.permissions.has('tasks:read:all')) return true`）。tasks-list 的陈旧点是 **actor.permissions + 缓存里存的 `true`** 两处，不是短路。

**改 RFC**：`design.md` §2 在步骤 ② 与 ③ 之间插入显式一步 `ws.data.actor = freshActor`；§3.2 的 ConnectionData 注释把 `actor` 标为「复核时整体替换的可变字段，唯一写入点是复核」（并同步改掉 `registry.ts:126` 那句 pinned 注释的说法）。AC-2 改写为「降级后 `ws.data.actor.user.role`/`permissions` 已替换」的白盒断言 + 行为断言双锁，且分列 workflows/memories（短路）与 tasks-list/scheduled-tasks（permissions 集合）两类。

## B2 — 把 async 复核塞进同步投递管道；`design.md:119` 的推理反了，并会撞红两条现有同步锁
**复核**：`broadcaster.ts:46-59` `broadcast()` 同步 for-of；`registry.ts:586` listener 是同步回调；`registry.ts:587-590`（admin 短路）与 `registry.ts:591-594`（task / repo-import / memory-distill-jobs 无 frameGate）都是**同步 `sendJson`**。复核第①步 `resolveActor` 必然异步（`sessionStore.ts:89/95/100` = 2 SELECT + 1 UPDATE）。

`design.md:119` 用「投递本身是同步的」来消化盲区——插入 await 之后这句话就不成立了，它反而是本方案的主失效模式。

更硬的证据：`tests/rfc152-ws-channel-registry.test.ts:277`（`no frameGate ⇒ every frame forwards`）和 `:290`（`adminShortCircuit sends synchronously`，注释直写「Synchronous — visible before any await」）都是 `probe.fire()` 后**不 await** 直接 `expect(sent).toEqual([...])`。任何在 listener 里无条件插 await 的实现立刻红两条。

RFC 全文未定义：复核期间到达的帧是排队还是丢弃、同一 tick 内 N 帧是否复用同一次复核、`ws.close()` 到 `handleClose`（`server.ts:159-167`）之间在途帧如何短路。

**改 RFC**：`design.md` §2 之前新增一节「投递管道契约」，写死三条可测不变量：(a) **epoch 相等时投递路径必须保持完全同步、不引入任何微任务**（并把 `rfc152-ws-channel-registry.test.ts:277/:290` 列为 T5 的回归锚点）；(b) ConnectionData 加 `revalidating: Promise<void> | null`，同一 epoch 变化在单连接上最多一次 `resolveActor`，复核期间到达的帧按原序排队后投递、不得丢弃；(c) 加 `closing: boolean`，决定 4401/4403 时同步置位并同步 `unsubscribe()`。§7 补两条用例：bump 后一次 broadcast 打 N 帧 → `resolveActor` 恰好 1 次、close 恰好 1 次、帧序不变。

## B3 — 选型表把方案 B 稻草人化，真正更简单的「进程级连接集合 + 撤销时全量重扫」没进候选
**复核**：`design.md:10` 否掉 B 的理由是「需要多张反向索引，且每类撤销各自维护」——这只对**精确定位**版本成立。粗粒度等价物是一张平表 `Set<ServerWebSocket>`，零反向索引。而落地钩子已全部就位：`server.ts:150-157` handleOpen / `server.ts:159-167` handleClose（已在做 unsubscribe）；复核入口 `checkUpgradeGate` 已是导出的、通道无关的（`registry.ts:558-566`）；`registry.ts:587/598` 是**帧到达时**才读 `ws.data.actor`，所以就地替换 actor 立即生效、不需要重订阅。

这条决定 T1–T7 全部形状：走 D 则复核跑在撤销方的 async 上下文里，帧路径一行不改 → B2 整条消解、AC-6 由构造成立、B8 的空闲连接也能真关。

**改 RFC**：`design.md` §1 增加方案 D 并按同一口径重比。若仍选 C，必须写明 C 相对 D 的**具体**优势（唯一站得住的是「连接从不收帧就零成本」），并承认 D 在同步管道这一维上更优。

## B4 — §4 撤销写入点表有事实错误 + 三处遗漏，而 §6 棘轮的粒度粗于漏洞粒度
**复核**（六个锚点逐一核对**全部正确**：`sessionStore.ts:115` / `patStore.ts:107` / `userIdentities.ts:77` / `users.ts:132` / `taskCollab.ts:130` / `resourceAcl.ts:313`），错的是第五行：

1. **`updateUser` 在 `services/users.ts` 里根本不存在**。真实函数是 `patchUser`（`users.ts:180`），且 `users.ts:230-231` 同时写 `role` 与 `status` —— 它既是角色降级路径**也是**第二条停用路径（`users.ts:161-165` 注释自认「The web UI re-enables via PATCH {status:'active'} (patchUser)」）。而 `patchUser` **不**调 `revokeAllSessionsForUser`（对比 `disableUser` 在 `users.ts:156` 调了），所以 Web UI 上最常见的两个收窄动作全部不 bump。
2. **`revokeAllSessionsForUser`（`sessionStore.ts:123`）不在表内**，而它是改密（`routes/auth.ts:119`）与重置密码（`users.ts:106`）的唯一吊销入口——正是 `proposal.md:40` 卖的「凭据泄漏」应急流程。
3. `deleteIdentity`（`userIdentities.ts:77`）只 `db.delete(userIdentities)`，不触碰 session/PAT，是表里唯一对 WS 无实质影响的条目。

棘轮（`design.md:100`）断言「函数体含 `bumpAuthEpoch(`」——`patchUser` 的 role 分支有调用、status 分支漏掉时它照样绿；新增撤销路径它更是完全看不见。

**改 RFC**：§4 表把「角色更新 / `updateUser`」改为 **`patchUser`（`users.ts:180`）无条件 bump，覆盖 role 与 status 两条分支**；补 `revokeAllSessionsForUser`；`deleteIdentity` 保留但注明「不影响已发放凭据，bump 仅为保守」。§6 棘轮改成**写入面级**（表级，符合 [feedback_grep_locks_before_push]）：凡 `db.update(users|userSessions|userPats)` 且 set 含 `role|status|revokedAt`、以及一切写 `taskCollaborators` / `resource_grants` 的语句，其所在函数必须调用 `bumpAuthEpoch(` —— 新增撤销路径默认变红。

## B5 — bump 与撤销事务的先后未约束；写在提交前 = **永久**漏检，而棘轮会给它开绿灯
**复核**：`taskCollab.ts:145` `const rows = await db.select(...)`、`:165` `await listCollaborators(...)` 都在真正写库（`:179 dbTxSync(db, (tx) => {`）**之前**让出事件循环；`resourceAcl.ts:321 await requireResourceOwner(...)` → `:335 dbTxSync<AclRow>(...)` 同型。bump 落在函数开头（最自然、也是棘轮唯一要求的写法）时序即：bump → await 让出 → 帧触发复核 → 读到**未提交的旧成员表**判定仍可见 → 写 `ws.data.epoch = current` → 事务才提交。**此后再无 bump，该连接永久保留已撤销的访问权**。且这条洞用「先撤销、后发帧」的自然用例几乎不可能复现。

**改 RFC**：§4 表加一列「bump 位置」，硬性规定 **bump 必须在写入提交之后**（抛错路径不 bump 无害，多余 bump 只是多复核一次）；棘轮升级为顺序断言（`bumpAuthEpoch(` 必须出现在该函数最后一个 `dbTxSync(` / `db.update(` 之后），或直接收进 `commitAndBump(db, reason, fn)` 包装器让「先提交后 bump」成为唯一可写法。§7 补一条「撤销 await 点上人为 yield 时投递帧」的用例。

## B6 — upgrade 时的 epoch 快照点 TOCTOU，而 plan T4 的验收恰好把错误写法锁死
**复核**：`server.ts:116 await resolveActor` → `server.ts:131 await checkUpgradeGate`（task 通道含 tasks 查询 + canViewTask 成员查询）→ `server.ts:135-142` 才构造 `data`。若按 `plan.md:10` 的字面验收「upgrade 后 `epoch === currentAuthEpoch()`」在 :135 处取值，则发生在 116~135 窗口内的撤销被写进初始 epoch → 该连接对这次撤销**永久免疫**。同一窗口也覆盖 `?since` 回放：`registry.ts:358-360` 的 onOpenExtra → `registry.ts:288-324` `replayTaskEvents` 在 `:322` 逐条裸 `sendJson`，是 task 通道 `node.event`（agent 完整 stdout）的第二条无门发送路径。

**改 RFC**：`design.md` §2/§3.2 写明「epoch 必须在第一次 await 之前快照（`const seen = currentAuthEpoch()` 于 `resolveActor` 调用前），构造 ConnectionData 时用该快照值；复核完成后写回的也是复核**开始前**捕获的值，不得重读 `currentAuthEpoch()`」——否则复核窗口内的 bump 被吞、该次撤销永久漏检。`plan.md` T4 验收反向改写：「upgrade 期间人为 bump 一次，断言连接 epoch < currentAuthEpoch() 且首帧触发复核」。§7「已知盲区」里补登 open/replay 路径。

## B7 — proposal §1.1 把 memories / scheduled-tasks 写成「缓存永不失效」，两者根本没有缓存 → AC-4 与 §7 用例 5 是空断言
**复核**：`registry.ts:433-471` memories 每帧重查行，`registry.ts:436-437` 注释「no cache: … RFC-045 edits can move rows between scopes」，实现里一次 `ctx.cache` 都不碰；`registry.ts:498-499` scheduled-tasks 是纯内存判断（`ctx.actor.permissions` + `msg.ownerUserId`），同样不碰 cache；`registry.ts:133-134` 的 ConnectionData 注释已写死「memories deliberately does NOT cache」。全仓真正持有 per-connection 缓存的只有 tasks-list（裸 taskId）与 workflows（`wf:` 前缀）。

后果：`proposal.md:25` 与 `:27` 两行事实错误；AC-4（`proposal.md:64`）与 `design.md:114` 用例 5 要求断言「memories 通道缓存失效」——**没有缓存可失效**，只能写成恒绿；`design.md:69` 的 `cacheKeyPrefixes` 对 5/7 通道恒为 `[]`，作为 28 格载体几乎不携带信息，还制造「每通道都有缓存要清」的错觉。

**改 RFC**：按源码更正 `proposal.md:25/:27`（memories = 每帧重查行、无缓存，陈旧点是冻结 actor；scheduled-tasks = 纯内存判断、无缓存，陈旧点是冻结 permissions）。AC-4 拆成 AC-4a（tasks-list / workflows：缓存失效）与 AC-4b（memories / scheduled-tasks / workflows 短路：actor 刷新后按新权限判定）。`design.md:67-69` 的 `onEpochChange` 三值枚举改成能表达真实动作的集合（`{ refreshActor: true; clearCache: 'all'|'none'|string[]; rerunUpgradeGate: boolean }`），`cacheKeyPrefixes` 改成判别联合 `{ kind:'no-cache', why } | { kind:'prefixes', prefixes }`，让「本通道没有缓存」变成一次显式表态。

## B8 — AC-3 与惰性复核口径自相矛盾：空闲连接永远不会被关
**复核**：`proposal.md:47` 目标是「在**下一帧之前**复核」（惰性），`proposal.md:63` AC-3 却写「该凭据建立的**所有** WS 连接被关闭」（即时）。惰性复核只在帧到来时触发，而 `proposal.md:40` 那条「人员离职 / 凭据泄漏，对方已经打开的页面」最典型的形态恰恰是没有帧的连接（任务已 done、`repo-import` 批次已结束——该通道 `registry.ts:415-424` 无门无 frameGate，批次结束后即无帧）。`design.md:113` 用例 4 只有先推一帧才会绿，与 AC 文字不符，合并时按 AC 打勾就是自欺。

**改 RFC**：二选一并写死。要么 AC-3 改成「该凭据建立的所有 WS 连接在**下一帧投递之前**被关闭；无帧期间保持静默不构成违反」，并把「已吊销凭据的空闲 socket 可长期存活」登记为已知限制；要么承认需要即时关闭 → 走 B3 的方案 D。不要保留两个口径。

---

# 二、必改但不阻断实现（可在 T1 前一并修文）

| # | 事项 | 复核锚点 |
| --- | --- | --- |
| M1 | §3.2 保留**明文 token** 的理由与源码不符：`sessionStore.ts:88-89` 与 `patStore.ts:78-79` 本来就是 `where(tokenHash = hash)`，`sessionStore.ts:30` 的 `hashToken` 已导出；存 `sha256(token)+kind` 走**同一条查询**、零额外成本，且 `sessionStore.ts:97` / `patStore.ts:87` 已含「用户被停用」判定。所以「替代方案要各写一条查询、拿不到统一答案」是错的。且「不写日志」无强制：`util/log.ts:141-148` `formatVal` 对任意对象无条件 `JSON.stringify`、全仓无脱敏。**改**：`token: string` → `credential: { kind: 'session'\|'pat'\|'daemon'; hash?: string }`，删掉那段与源码不符的评估，改配一条「`WsConnectionData` 上不得存在任何原始凭据字段」的源码锁 | 已核对 |
| M2 | 复核路径**含写**：`sessionStore.ts:100` / `patStore.ts:89` 每次成功 lookup 都 `UPDATE lastUsedAt`。单写者 sqlite 上是写放大，且污染 `account.tsx:388/:651` 展示的 last_used_at（socket 挂着就显得「刚用过」）。触发面是普通用户级（`resourceAcl.ts:321 requireResourceOwner` 只要 owner），全仓 `rg rateLimit` **零命中**。**改**：抽只读复核入口（不写 lastUsedAt），并在 §3.1 写死「复核路径禁止产生写」；plan §风险 2 的代价按「连接数 × bump 频率」重算 | 已核对 |
| M3 | 复核点**拿不到 `daemonTokenBuf`**：`server.ts:83` 是 `buildWebSocketAdapter` 的闭包私有值，而 `gatedSubscribe`（`registry.ts:578-583`）/ `openWsChannel`（`registry.ts:617-621`）签名只有 `db`；`session.ts:62-67` 的第三参必填。§3.2 未列。**改**：明确随 ConnectionData 下发，并说明 `__system__` 连接的复核语义 | 已核对 |
| M4 | AC-6 无可执行落点：`db/client.ts:35` `drizzle(sqlite, { schema })` 未开 logger；全仓仅 `rfc120-manual-questions.test.ts:769` / `rfc120-deferred-dispatch.test.ts` 两处一次性 Proxy，且 `if (prop !== 'select') return orig` —— 照抄会**漏计复核路径里的 UPDATE**。**改**：AC-6 明确「额外 = 相对现状的增量」，落一个共享 `countingDb`（拦 select/insert/update/delete）并给每通道 golden 计数；补对称的一半「bump 之后必须恰好观察到 N 次（或去重后 1 次）resolveActor」，否则 `design.md:102` 那行防护是空的 | 已核对 |
| M5 | AC-5 机制自相矛盾：`proposal.md:65` 写 `as const satisfies Record<…>`，`design.md:73` 写 `WsChannelRegistry` mapped type（`registry.ts:330-332` 本来就是 mapped type，已具穷尽性）——两套做法，实现者二选一各留洞；且「删一格 tsc 失败」无法在 bun:test 里表达。仓内已有现成范式（`rfc080-parametric-runtime-migration.test.ts:132`、`rfc080-output-kind-ui.test.ts:77` 的 `@ts-expect-error` 反向锁）未被采用。**改**：统一到「ChannelSpec 加必填字段 + mapped type」，并把可执行形式写死为一条 `@ts-expect-error` 反向锁 | 已核对 |
| M6 | AC-7 依赖不存在的基建：`design/test-guard-audit-2026-07-21/00-SYNTHESIS.md:240` 里 G6（变异测试基建）本身还是待建项；`plan.md:13` 的验收「三条变异逐一记录在 PR 说明里」正是审计自己命名的逃逸机制「散文充当契约载体」，却被列进合并前打勾清单。**改**：从验收清单移出，标注「非 CI 门」，或把 G6 最小基建立为前置 T0 | 已核对 |
| M7 | 前端：`useWebSocket.ts:186` 的 close 监听器**连 event 参数都不接**，关闭码今天读不到；4401 后 `getToken()`（`:137-143`）仍返回死 token → 永久每 30s 一次无效重连（`:202-204` 封顶 30s），界面零提示（`api/client.ts:218` 只在 HTTP 401 才 `clearToken`）。`proposal.md:55`「前端只需保证关闭码可读」把要求说反了；`plan.md:12` T6 担心的「快速重试风暴」不成立，照做会得出「已有指数退避、无需改动」的**错误结论**。**改**：T6 改写为两条具体验收——读 `e.code`；4401 → `clearToken()` + 登出提示；并配前端行为锁 | 已核对（见下 F1） |
| M8 | `proposal.md:11` 事实错误：`ctx.cache.delete` 是**两处**（`registry.ts:398` acl.updated、`registry.ts:403` deleted），不是一处。`design.md:68`「epoch 变化时整表清空」与 `registry.ts:23-29` 头注释记录的「两种消息需要相反的缓存读写顺序」相抵触。**改**：修正事实描述；清缓存交给通道自己表态（并入 B7 的 `onEpochChange` 动作集合） | 已核对 |
| M9 | 自然过期（`sessionStore.ts:93`、`patStore.ts:83`）是纯时间判定、无写入点 → epoch 永不变 → WS 上凭据 TTL 形同虚设。**改**：ConnectionData 记 `credentialExpiresAt`，投递前一次纯内存 `now > expiresAt → close(4401)`（零查询，不破 AC-6）；不做就写进非目标 | 已核对 |
| M10 | `repo-import`（`registry.ts:415-424`）无门无缓存，28 格里整列近乎空（只受凭据有效性约束，而 batchId 是可传播的 bearer 串）。**改**：AC-5 矩阵显式填 `{na: '…RFC-152 D4 遗留'}` 并在非目标里点名，避免「28 格已覆盖」的表述掩盖它 | 已核对 |

---

# 三、被证伪的条目

**F1 — security「4401/4403 → 500ms 定频重连风暴」：证伪。**
重连要触发 `open`（从而在 `useWebSocket.ts:178` 重置退避），`tryUpgrade` 必须成功。4401 场景下重连会在 `server.ts:116` 的 `resolveActor` 处失败 → `server.ts:122-124` 返回 401 → 浏览器不触发 `open` → `:200-204` 指数退避正常涨到 30s。4403 只在通道**有** upgradeGate 时产生（`design.md:25`「若有」），重连会在 `server.ts:131` 撞同一个门 → 同样不 `open`。security 的核心前提「4/7 无 upgradeGate 通道重连必然握手成功然后再被复核关闭」自相矛盾：那 4 个通道在 §2 里根本不会因步骤 ④ 关闭，只会因步骤 ② 凭据失效关闭，而凭据失效的重连握手必失败。正确的表述是 correctness / devil 的版本（见 M7）。

**F2 — security「§3.3 整表清空会让 owner 前端永远显示已删除的工作流」：后果夸大。**
事实描述（两处 `ctx.cache.delete`）成立，但生产唯一的 `workflow.deleted` 广播点 `services/workflow.ts:346-372` **恒带** `workflow.deleted-audience` context，`registry.ts:404-409` 优先用它；旧缓存只是 `registry.ts:392-395` 注释里点名保留的 legacy/test 无 context 回退。降级为 M8。

**F3 — perf「AC-6 的『零』对 4/7 通道不可表达」：部分证伪。**
AC-6 原文（`proposal.md:66`）是「不产生任何**额外** DB 查询」，「额外」= 相对现状的增量，对所有通道都可表达。成立的只有另一半：无计数原语、且 select-only Proxy 会漏计复核路径的 UPDATE（已并入 M4）。

**F4 — perf「`scheduled-tasks-ws.test.ts:31` 用 `as unknown as` 造假 spec」：锚点错误。**
该行是 `const spec = WS_CHANNELS['scheduled-tasks']`（真实 registry 取值），`:32` 是 `const gate = spec.frameGate!`。结论（给 ChannelSpec 加必填字段不会红这个文件）仍成立，依据错了。

**F5 — security「`hashToken` 已是导出的纯函数，两种凭据可直接复用」：部分证伪。**
`sessionStore.ts:30` 确为 `export function hashToken`，但 `patStore.ts:31` 是**私有** `function hashToken`。结论（存 hash 可走完全相同的查询）仍成立，只是需要额外导出一个符号。M1 的改法不受影响。

另附：security 的「§2 第⑤步重读 `currentAuthEpoch()` 会吞掉窗口内 bump」成立，已并入 B6。四位审查者对 §4 表里 `revokeSession` / `revokePat` / `deleteIdentity` / `disableUser` / `updateTaskMembers` / `updateResourceAcl` 六个 file:line 的复核我逐个验证，**全部准确**——唯一错的就是 `updateUser`（B4）。

---

# 四、总体裁决

**不能进入实现——必须先改 RFC。** 三件事是结构性的、改代码救不回来：AC-2 在 `design.md:22-26` 的五步里没有实现路径（B1）；把异步复核插进 `registry.ts:586-594` 的同步投递管道这件事 RFC 一字未提、且会撞红 `rfc152-ws-channel-registry.test.ts:277/:290` 两条既有行为锁（B2）；以及 `design.md:10` 排除了唯一能同时消解 B2/B8 的候选方案（B3）。另有 B4/B5/B6 三条会让「实现完了、棘轮全绿、洞还在」的永久漏检以已验收姿态出厂。B7/B8 是文档级事实错误，改起来最便宜但必须在写第一行代码前改掉，否则 AC-4 会以空断言收场。

---

## 四个视角的原始结论


### 安全视角 — verdict: `block`

#### [阻断] 复核窗口不是「竞态」而是确定性泄漏：广播 listener 是同步的，复核是异步的，AC-1「下一帧之前关闭」在现有管道里不可达

- **理由**：design.md §2 的流程图假设「帧投递前插一个 if」，design.md:119 更直接写「复核在投递前，投递本身是同步的」——这对现有管道的判断是错的。registry.ts:586 注册的 broadcaster listener 是**同步回调**：admin 短路走 registry.ts:587-590 `sendJson` 同步发；无 frameGate 的通道（task / repo-import / memory-distill-jobs）走 registry.ts:591-594 同步发。而 §2 的复核第①步 `resolveActor` 必然是异步（sessionStore.ts:89/95/100 三次 DB 往返）。于是只有两种落地方式：(a) 保持同步发 → epoch 变化后的**第一帧照发**，攻击者不需要抢，泄漏是必然的；对 task 通道那一帧正是 proposal §2 点名的 `node.event`（agent 完整 stdout）；(b) 把发送改成异步 → 整条投递链路语义变更（与 gatedSubscribe 同步 hello、onOpenExtra 同步 replay 的相对顺序、以及 RFC-152 声称「bit-identical」的行为锁全部受影响），而 RFC 对此一字未提。此外 §2 第⑤步「ws.data.epoch = current」若在 await 之后重读 currentAuthEpoch()，复核窗口内到达的新 bump 会被吞掉 → 该次撤销**永久**漏检。
- **证据**：packages/backend/src/ws/registry.ts:586 `ws.data.unsubscribe = erased.broadcaster.subscribe(channelKey, (msg, context) => {` —— 同步回调; packages/backend/src/ws/registry.ts:587-590 admin 短路 `sendJson(ws, msg); return` —— 先于任何 gate 同步发出; packages/backend/src/ws/registry.ts:591-594 `if (erased.frameGate === undefined) { sendJson(ws, msg); return }` —— task/repo-import/memory-distill-jobs 三个通道的全部帧; packages/backend/src/auth/sessionStore.ts:89,95,100 —— resolveActor 路径含 2 次 SELECT + 1 次 UPDATE，不可能同步完成; design/RFC-212-ws-authorization-revalidation/design.md:119 「复核在投递前，投递本身是同步的」
- **改法**：在 design.md §2 之前先补一节「投递管道改造」：明确 gatedSubscribe 的 listener 改为「复核 Promise 链 → 再决定 send」，并显式说明三类通道（admin 短路 / 无 frameGate / 有 frameGate）各自的新顺序；同时声明 epoch 必须在复核**开始前**捕获（`const seen = currentAuthEpoch()`），完成后写 `ws.data.epoch = seen` 而非重读，否则窗口内的 bump 被吞。AC-1 的断言要加「epoch bump 后到达的第一帧也不得送达」，否则用例会被 (a) 型实现骗过。

#### [阻断] AC-2（角色降级失去 admin 短路）在设计里没有任何实现路径：actor 从不写回，且 §3.3 的三个枚举值无一覆盖「重算短路」

- **理由**：registry.ts:587 的 admin 短路每帧读的是 `ws.data.actor.user.role`，frameGate 每帧读 `ws.data.actor`（registry.ts:598），scheduled-tasks 读 `ctx.actor.permissions`（registry.ts:499）——也就是说降级要生效，唯一机制是**把新 actor 写回 ws.data.actor**。但 design §2 的五步（①resolveActor ②close ③清缓存 ④重跑 upgradeGate ⑤写 epoch）**没有任何一步赋值 actor**，§3.2 的 ConnectionData 也只新增 token/epoch、对 actor 只字未改。更糟的是 §3.3 定义的 `onEpochChange: 'rerun-upgrade-gate' | 'clear-cache-only' | {na}` 三个取值里没有一个能表达 workflows/memories 需要的「重算 adminShortCircuit」——这两个通道按矩阵只会填 'clear-cache-only'，而清缓存对 registry.ts:587 完全无效。AC-2 会以「矩阵已填、编译通过」的姿态交付，实际零效果。
- **证据**：packages/backend/src/ws/registry.ts:587 `if (erased.adminShortCircuit === true && ws.data.actor.user.role === 'admin')`; packages/backend/src/ws/registry.ts:598 `.frameGate({ db, actor: ws.data.actor, cache: ws.data.visibilityCache }, ...)`; packages/backend/src/ws/registry.ts:499 `ctx.actor.permissions.has('tasks:read:all')`; design/RFC-212-ws-authorization-revalidation/design.md:47-57（ConnectionData 未提 actor 可变）与 design.md:22-26（五步流程无 actor 赋值）
- **改法**：§2 第①步后显式加「`ws.data.actor = freshActor`」，并在 §3.2 的 ConnectionData 注释里写明 actor 是**可变**字段、其唯一写入点是复核。AC-2 的用例必须覆盖 workflows/memories（adminShortCircuit=true）与 scheduled-tasks（读 permissions 集合）三条，且断言的是「短路不再触发」而不仅仅是「缓存被清」。

#### [阻断] 四类撤销事件枚举不全，源码棘轮反而把「不全」固化成了绿灯

- **理由**：§4 的七个写入点漏了三条真实的收窄路径：(1) `revokeAllSessionsForUser`（sessionStore.ts:123）——改密码/「登出其它会话」走的就是它（routes/auth.ts:119、users.ts:106 setPassword），这是「凭据泄漏后改密码」这个最典型的应急流程，按 §4 表它**不 bump**，攻击者已开的 WS 全部存活；(2) RFC 写的 `updateUser` 在源码里**不存在**，真实函数是 `patchUser`（users.ts:180），且它同时处理 role（:230）和 status（:231）——PATCH{status:'disabled'} 是与 `disableUser` 并列的第二条停用路径，且它**不**顺带 revokeAllSessions，只靠 users.status 判定，漏 bump 即 AC-3 直接破；(3) 时间到期（session `expiresAt`、PAT `expiresAt`）根本不产生任何事件，epoch 永不变化 → 一条空闲的 WS 连接可以无限期活过 7 天会话 TTL，等于给 WS 单独开了一条「凭据永不过期」的通道。而 §6 的棘轮只断言「§4 表里的函数体含 bumpAuthEpoch(」——它检测不出**新增/遗漏的撤销路径**，正是 proposal §1.1 自称要消灭的「靠人记得」。
- **证据**：packages/backend/src/auth/sessionStore.ts:123 `revokeAllSessionsForUser`；调用点 packages/backend/src/routes/auth.ts:119、packages/backend/src/services/users.ts:106（setPassword）; packages/backend/src/services/users.ts:180 `patchUser`（RFC 写的 `updateUser` 不存在）；:230-231 同时写 role 与 status; packages/backend/src/services/users.ts:155-156 disableUser 才调 revokeAllSessions，patchUser 不调; packages/backend/src/auth/sessionStore.ts:93 `if (session.expiresAt < now) return null` / patStore.ts:83 —— 到期是时间驱动，无写入点可挂 bump; design/RFC-212-ws-authorization-revalidation/design.md:77-87 §4 表
- **改法**：§4 表补 `revokeAllSessionsForUser` 与 `patchUser`（并把 `updateUser` 更正为 `patchUser`，说明 role 与 status 两个分支都要 bump）。棘轮反过来写：不是「这七个函数含 bump」，而是**所有写 `userSessions.revokedAt` / `userPats.revokedAt` / `users.status` / `users.role` / `taskCollaborators` / `resource_grants` 的语句所在函数必须含 bump**（表级源码锁，符合 [feedback_grep_locks_before_push] 的表级而非文件级原则），这样新增撤销路径会自动变红。到期问题另立一条：ConnectionData 记下凭据的 `expiresAt`，投递前做一次纯内存的 `now > expiresAt → close(4401)`（零查询，不破 AC-6）。

#### [阻断] bump 与撤销事务的先后完全未约束，写在提交前会造成**永久**漏检，而棘轮会给它开绿灯

- **理由**：这是本方案唯一的正确性支点，却只在 proposal §6 写了一句「在其写入点上加一次 bumpAuthEpoch()」。真实写入点有让出点：`updateTaskMembers` 在进入同步事务前有 `await db.select(...)`（taskCollab.ts:145）和 `await listCollaborators(...)`（:165），实际写库在 taskCollab.ts:179 的 `dbTxSync`。若 bump 落在函数开头（最自然的写法，也是棘轮唯一要求的「函数体内含调用」），时序就是：bump → await 让出 → 待投递帧触发复核 → 复核读到**尚未提交的旧成员表** → 判定仍可见 → 写 `ws.data.epoch = current` → 事务提交完成撤销 → **此后再无 bump，该连接永久保留已撤销的访问权**。这比「漏一帧」严重得多，是永久性洞，且用例（先撤销、后建连或后发帧）几乎不可能自然复现，会一路绿到生产。
- **证据**：packages/backend/src/services/taskCollab.ts:145 `const rows = await db.select(...)`、:165 `await listCollaborators(...)` —— 事务前的异步让出点; packages/backend/src/services/taskCollab.ts:179 `dbTxSync(db, (tx) => {` —— 真正的写入在这里; packages/backend/src/services/resourceAcl.ts:335 `dbTxSync<AclRow>(db, (tx) => {` —— 同型，前有 :321 `await requireResourceOwner(...)`; design/RFC-212-ws-authorization-revalidation/design.md:100 棘轮只要求「函数体含 bumpAuthEpoch(」
- **改法**：§4 表加一列「bump 位置」，硬性规定 **bump 必须在写入提交之后**（dbTxSync 返回后、抛错路径不 bump 也无害因为多余 bump 只是多复核一次）。棘轮升级为顺序断言：源码层断言 `bumpAuthEpoch(` 出现在该函数最后一个 `dbTxSync(` / `db.update(` 之后；或者更稳妥地把 bump 收进一个 `commitAndBump(db, reason, fn)` 包装器，让「先提交后 bump」成为唯一可写法。§7 必须补一条「撤销写入过程中投递帧」的用例（在 await 点上人为 yield）。

#### [阻断] 原始 token 驻留 ConnectionData 既无必要也无强制防护；§3.2 的取舍理由与源码不符

- **理由**：§3.2 的论证是「替代方案是保存 sessionId/patId 再按 id 复核，但那要给两种凭据各写一条查询」——源码不支持这个说法：`lookupActiveSession` 的查询本来就是 `where(eq(userSessions.tokenHash, hash))`（sessionStore.ts:89），`lookupActivePat` 同理（patStore.ts:79），而 `hashToken` 已经是导出的纯函数（sessionStore.ts:30）。也就是说存 **sha256(token) + 凭据种类** 就能走**完全相同的一条查询**完成复核，零额外查询、零额外分支，并且天然覆盖「用户被停用」（两条 lookup 都在 :97/:87 检查 `user.status !== 'active'`）。RFC 因此是在没有收益的前提下把明文长期凭据（session token / PAT / 甚至 daemon token —— 后者是进程级 admin 主密钥）挂到每个连接对象上。而「不写日志」这一保证是纯口头的：logger 的 `formatVal` 对任意对象无条件 `JSON.stringify`、全仓无脱敏白名单（util/redact.ts 只用于 git URL），server.ts:152 已经在 log `ws.data` 的子对象，任何一次「调试时打个 ws.data」就把明文 token 写进会轮转保留 5 份的 daemon 日志。
- **证据**：packages/backend/src/auth/sessionStore.ts:89 `.where(eq(userSessions.tokenHash, hash))`；:30 `export function hashToken`; packages/backend/src/auth/patStore.ts:79 `.where(eq(userPats.tokenHash, hash))`; packages/backend/src/auth/sessionStore.ts:97 / patStore.ts:87 `if (!user || user.status !== 'active') return null` —— 停用判定已含在同一条路径里; packages/backend/src/util/log.ts:141-148 `formatVal` → `return JSON.stringify(v)`（无脱敏）；packages/backend/src/ws/server.ts:152 `log.debug('open', { channel: ch })`; design/RFC-212-ws-authorization-revalidation/design.md:60 「替代方案是保存 sessionId/patId 再按 id 复核，但那要给两种凭据各写一条查询」
- **改法**：把 §3.2 的 `token: string` 换成 `credential: { kind: 'session' | 'pat' | 'daemon'; hash?: string }`，并从 sessionStore/patStore 各抽一个 `lookupActiveSessionByHash` / `lookupActivePatByHash`（现有函数拆出 hash 计算即可，查询体不变，daemon 分支不需要任何存储）。同时删掉 §3.2 里那段与源码不符的安全评估，改为一条**强制测试锁**：断言 `WsConnectionData` 类型上不存在任何原始凭据字段（源码层文本锁），否则这条保证没有任何执行力。

#### [阻断] 「不改前端」的结论建立在对重连退避的误读上：`open` 会重置退避，而 RFC-212 的每一次关闭都发生在 open 之后 → 500ms 定频重连风暴

- **理由**：§4 非目标与 §5 都断言「前端现有重连逻辑会重试…不需要前端改动」。实际实现里指数退避只对**握手失败**有效：`open` 事件一到就把 `conn.backoff` 重置回 500ms（useWebSocket.ts:178）。而 RFC-212 的 4401/4403 全部是**连接建立后**的服务端主动关闭 —— 对四个没有 upgradeGate 的通道（tasks-list / workflows / memories / scheduled-tasks，checkUpgradeGate 在 registry.ts:564 直接 return true），重连会**成功握手**（触发 open → 退避归零）然后再被复核关闭，形成稳定的 500ms 循环；每一轮都要跑一次完整 resolveActor（2 SELECT + 1 UPDATE，sessionStore.ts:89/95/100）。close 处理器（useWebSocket.ts:186-194）从头到尾**不读 `e.code`**，所以前端既区分不出 4401 与网络抖动，也不会 clearToken、不会给用户任何「会话已失效」提示（HTTP 侧 api/client.ts:216 才会 clearToken）。plan T6 只要求「确认退避不会退化成快速重试风暴」——按现有代码逐行读会得出「已有指数退避、无需改动」的**错误结论**。
- **证据**：packages/frontend/src/hooks/useWebSocket.ts:176-185 `ws.addEventListener('open', ...)` → `conn.backoff = BASE_BACKOFF_MS`; packages/frontend/src/hooks/useWebSocket.ts:186-194 close 处理器完全不读 `e.code`; packages/frontend/src/hooks/useWebSocket.ts:200-205 `scheduleReconnect` 的退避只在 open 之外增长; packages/backend/src/ws/registry.ts:564 `if (spec.upgradeGate === undefined) return true` —— 4/7 通道重连必然握手成功; packages/frontend/src/api/client.ts:216 HTTP 401 才 clearToken
- **改法**：把「不改前端」从非目标里去掉。T6 改为具体改动：close 处理器读 `e.code`，4401 → `clearToken()` + 停止该 path 的重连（`stopped`）；4403 → 不重置退避、按独立的更长退避重试；并把「open 不再无条件重置退避」改成「仅在存活超过 N 秒后才重置」。配一条行为锁用例：mock 服务端在 open 后立即 close(4403)，断言 5 次重连的间隔是递增的而不是恒定 500ms。

#### [阻断] §3.3 要求 epoch 变化时「整表清空 visibilityCache」，会打掉 workflows `workflow.deleted` 分支赖以工作的旧缓存值

- **理由**：registry.ts 的头注释（:26-30）明确记录：workflows 的两种消息需要**相反**的缓存读写顺序，`workflow.deleted` 必须先读旧缓存值再清（registry.ts:401-411），因为行已经被删、无法重新解析可见性；在没有 `deliveryContext` 的直接广播路径（注释 :393-395 显式保留的 legacy/test 回退）上，旧缓存值是唯一判据。RFC §3.3 规定「epoch 变化时整表清空」，于是任何撤销 bump 之后到达的第一条 `workflow.deleted` 会命中 `cached === undefined` → `return cached === true` → false → 帧被丢弃，owner 的前端永远显示一个已删除的工作流。附带证据：proposal §1 声称「只有 workflows 有一处 ctx.cache.delete(...)（registry.ts:396-400，且只针对 workflow.acl.updated 这一种消息）」——实际有**两处**（:398 与 :403），作者显然没看到第二处，也就没意识到它依赖旧值。这正是 RFC-152 设计门当年拒绝「单一声明式 cacheBust 槽」的原因，本 RFC 又把它加了回来。
- **证据**：packages/backend/src/ws/registry.ts:26-30 头注释「the workflows frameGate needs OPPOSITE cache orderings for two message types」; packages/backend/src/ws/registry.ts:401-411 `const cached = ctx.cache.get(...)` → 清除 → `return cached === true`; packages/backend/src/ws/registry.ts:398 与 :403 两处 `ctx.cache.delete(...)`; design/RFC-212-ws-authorization-revalidation/design.md:68-69 「epoch 变化时整表清空」；proposal.md:11 「只有 workflows 有一处 ctx.cache.delete(...)…只针对 workflow.acl.updated 这一种消息」
- **改法**：修正 proposal §1 的事实描述（两处 bust，且第二处依赖旧值）。§3.3 不要规定「整表清空」这种跨通道统一动作：把清缓存也交给通道自己表态（例如 `onEpochChange` 增加 `{ custom: (ctx) => void }`，workflows 的实现保留 `wf:` 条目直到该帧读过），或者最低限度在矩阵里给 workflows 单列一条例外并配一条回归用例：「bump 之后紧接一条无 deliveryContext 的 workflow.deleted，owner 连接仍收到」。

- **[关注] 「无条件 bump」+ 全仓零限速 = 任意登录用户可触发全局写放大**：复核路径不只是读：resolveActor 每次都会 UPDATE lastUsedAt（sessionStore.ts:100 / patStore.ts:89），在单写者 sqlite 上这是写放大而非读放大。触发面是普通用户级：updateResourceAcl 只要求 owner（resourceAcl.ts:321 requireResourceOwner，路由 routes/resourceAcl.ts:77），任何用户对自己的工作流反复 PUT /acl 即可让全部在线连接各跑一遍 3 次查询（其中 1 次写）+ 各通道 upgradeGate（task 通道另加 taskVisibleTo 的 1~2 次查询，registry.ts:202-210）。全仓 `rg rateLimit` 无命中。design.md §risk-2 只从「连接数量级小」角度否掉了风险，没有看到写放大这一面。建议：复核结果按 (credentialHash, epoch) 在进程内做一次去重缓存，同一 epoch 内 N 个连接只 resolve 一次；或把 lastUsedAt 的更新排除在复核路径之外。

- **[关注] 复核会刷新 lastUsedAt，等于让 WS 流量为会话「续命」**：当前 lastUsedAt 只用于展示（listActiveSessionsForUser，sessionStore.ts:147-167），expiresAt 才决定过期，所以今天无害。但一旦将来加空闲超时（这是 auth 演进的常见下一步），一个开着页面的 WS 连接会把会话永久刷活。建议复核走一条不写 lastUsedAt 的 lookup 变体，并在 design 里把这条约束写死。

- **[关注] 4403 关闭对四个无 upgradeGate 的通道语义为空**：tasks-list / workflows / memories / scheduled-tasks 的可见性完全是逐帧的，checkUpgradeGate 直接 return true（registry.ts:564）。对它们「close(4403)」既拦不住什么（重连必然成功），又制造了上面 B6 的循环。这四个通道的正确复核动作应当只是「换 actor + 清缓存」，不应产生关闭。§3.3 的枚举需要能表达「本通道永不因复核关闭」。

- **[关注] AC-6「零额外 DB 查询」的计数断言容易被 (a) 型实现骗过**：无撤销时本来就不复核，任何实现都能过；这条断言对「复核逻辑写错方向」的检出力其实来自它的反面（epoch 变化时**必须**产生查询）。建议 AC-6 补上对称的一半：bump 之后的第一帧必须观察到恰好一次 resolveActor，且 N 个连接产生 N 次（或去重后 1 次，取决于上面那条 concern 的取舍）——否则 §6 表格里「复核逻辑写错方向」这一行的防护是空的。

- **[关注] §7「已知盲区」低估了自己**：design.md:119 把「撤销发生在同一帧投递过程中」列为盲区并以「投递本身是同步的」自我安慰。结合 B1/B5，这条盲区实际是本方案的主要失效模式，而不是边角。建议改写为一节正式的「时序契约」，把 epoch 捕获点、bump 相对事务的位置、复核期间到达帧的处理三件事都写成可测断言。


### 正确性 / 时序视角 — verdict: `block`

#### [阻断] §2 五步从不写回 ws.data.actor —— AC-2（角色降级失去 admin 短路）按此设计必然不成立

- **理由**：帧投递路径每一帧都现读 `ws.data.actor`：`gatedSubscribe` 的 admin 短路读 `ws.data.actor.user.role`（registry.ts:587），frameGate 的 ctx 也传 `actor: ws.data.actor`（registry.ts:598）。design §2 的五步是「① 重新 resolveActor ② 失效则 close ③ 清 cache ④ 重跑 upgradeGate ⑤ 写 epoch」——没有任何一步把新解析出的 actor 赋回 ws.data.actor；§3.2 的 ConnectionData 也把 `actor: Actor` 原样列着、只新增 token/epoch。照字面实现的结果是：降级用户的连接照样命中 `role === 'admin'` 短路（workflows / memories 两个通道直接同步全量投递，连 frameGate 都不进），`tasks-list` 的 `cachedTaskVisible` 也仍拿旧 actor 的 `tasks:read:all` 权限集去问 canViewTask。AC-2 三个通道全部落空，而 AC-3（凭据吊销）却是绿的——测试矩阵会呈现「一半格子过、一半格子红」的假象。
- **证据**：packages/backend/src/ws/registry.ts:587 —— `if (erased.adminShortCircuit === true && ws.data.actor.user.role === 'admin') { sendJson(ws, msg); return }`; packages/backend/src/ws/registry.ts:598 —— `.frameGate({ db, actor: ws.data.actor, cache: ws.data.visibilityCache }, msg, context)`; packages/backend/src/ws/registry.ts:124-136 —— WsConnectionData.actor 注释「Resolved actor pinned at upgrade — no per-frame token re-resolution」; design/RFC-212-ws-authorization-revalidation/design.md:20-26 —— 五步流程无 actor 赋值；design.md:48-57 的 ConnectionData 同样没说明 actor 会被替换
- **改法**：design §2 在步骤 ② 与 ③ 之间显式插入「`ws.data.actor = freshActor`」，并在 §3.2 把 `actor` 标注为「复核时整体替换」；AC-2 的用例必须断言 `ws.data.actor.user.role` / `permissions` 已变化，而不是只断言收不到帧（否则实现者用 close 代替替换也能骗过测试）。

#### [阻断] upgrade 时的 epoch 快照点存在 TOCTOU，而 plan T4 的验收断言恰好把错误写法锁死

- **理由**：`tryUpgrade` 里从解析 token 到构造 `data` 之间横跨两个 await：`await resolveActor`（server.ts:116）与 `await checkUpgradeGate`（server.ts:131），随后才在 server.ts:135-142 构造 ConnectionData。如果按 T4 的字面验收「upgrade 后 `epoch === currentAuthEpoch()`」在 135 处取 `currentAuthEpoch()`，那么发生在 116~135 窗口内的撤销（bump 已完成、但门是拿撤销前的数据判的）会被写进连接的初始 epoch —— 这条连接对这次撤销永久免疫，因为它此后再也看不到 epoch 不等。窗口不是理论值：`checkUpgradeGate` 对 task 通道要做一次 tasks 查询 + canViewTask 的成员查询。
- **证据**：packages/backend/src/ws/server.ts:114-124 —— `actor = await resolveActor(deps.db, queryToken, daemonTokenBuf)`; packages/backend/src/ws/server.ts:131 —— `const verdict = await checkUpgradeGate(deps.db, actor, channel)`; packages/backend/src/ws/server.ts:135-142 —— `const data: ConnectionData = { channel, actor, unsubscribe, visibilityCache }`; design/RFC-212-ws-authorization-revalidation/plan.md:10 —— T4 验收「一条断言 upgrade 后 `epoch === currentAuthEpoch()`」
- **改法**：design §2/§3.2 明确规定「epoch 必须在第一次 await 之前（resolveActor 调用之前）快照，构造 ConnectionData 时使用该快照值」；plan T4 的验收改成「upgrade 期间人为 bump 一次，断言连接 epoch 小于 currentAuthEpoch() 且首帧触发复核」——反向锁 TOCTOU，而不是锁相等。

#### [阻断] 复核是 async、投递是同步：同一连接会并发起多次复核，且 close() 之后仍有在途帧继续触发复核

- **理由**：帧投递路径完全同步：`TypedBroadcaster.broadcast` 同步遍历 listener（broadcaster.ts:46-59），listener 里 task / repo-import / memory-distill-jobs 三个无 frameGate 的通道是同步 `sendJson`（registry.ts:591-594），admin 短路也是同步（registry.ts:587-590）。design §2 把一段异步复核（resolveActor + checkUpgradeGate，各含 DB 往返）插进这条同步路径，却没有任何 in-flight 去重或 closing 标记：epoch 只在步骤 ⑤ 复核完成后才写回，因此 bump 之后同一 tick 内到达的 N 帧各自看到 stale epoch、各自起一次完整复核。更糟的是 `ws.close(4401)` 之后 `ws.data.unsubscribe()` 只在 Bun 的 close 回调里执行（server.ts:159-167），在那之前订阅表里仍挂着这个 listener，后续帧继续进来、继续看到 stale epoch、继续复核、继续 close。代价也不是「多一次整数比较」：session token 的 resolveActor 走 lookupActiveSession，每次都会 UPDATE userSessions.lastUsedAt（sessionStore.ts:100），即一次 SQLite 写事务——一次 ACL 保存（§4 选择无条件 bump）就能让 N 条连接 × M 帧退化成 N×M 次写事务在单写者上串行排队，正是 design §1 用来否掉方案 A 的那个理由。
- **证据**：packages/backend/src/ws/broadcaster.ts:46-59 —— broadcast 同步 for 循环调用每个 listener; packages/backend/src/ws/registry.ts:586-608 —— listener 内 admin 短路 / 无 frameGate 分支均为同步 sendJson，仅 frameGate 分支是 fire-and-forget; packages/backend/src/ws/server.ts:159-167 —— handleClose 才调用 `ws.data.unsubscribe()`（Bun close 回调，异步于 ws.close()）; packages/backend/src/auth/sessionStore.ts:100 —— `await db.update(userSessions).set({ lastUsedAt: now })`，每次 resolveActor 一次写; design/RFC-212-ws-authorization-revalidation/design.md:20-26 —— epoch 仅在最后一步写回，无 in-flight promise 复用、无 closing 标记
- **改法**：design §2 增加两条每连接状态：(a) `revalidating: Promise<void> | null`，所有看到 stale epoch 的帧 await 同一个 promise（顺带保证按 .then 注册顺序 FIFO 投递）；(b) `closing: boolean`，一旦决定 4401/4403 就同步置位并同步调用 `ws.data.unsubscribe()`，此后所有帧直接丢弃、不再复核。§7 补一条用例：bump 后一次 broadcast 打 100 帧，断言 resolveActor 只被调用 1 次、close 只发生 1 次。

#### [阻断] §4「七个撤销写入点」与真实代码不符：`updateUser` 不存在，真正的降级/停用路径 `patchUser` 缺席，重置密码与 revoke-all 也不在表里

- **理由**：逐个核对：revokeSession(sessionStore.ts:115)、revokePat(patStore.ts:107)、deleteIdentity(userIdentities.ts:77)、disableUser(users.ts:132)、updateTaskMembers(taskCollab.ts:130)、updateResourceAcl(resourceAcl.ts:313) 六条行号全对；但第五行「services/users.ts 的 `updateUser` 的 role 分支」在 users.ts 里根本没有这个符号——角色变更走的是 `patchUser`（users.ts:180），即 `PATCH /api/users/:id`（routes/users.ts:79），而且它同时承载 `status:'disabled'` 的停用路径（users.ts:216-223 的 last-admin 保护就写在 status 分支上；users.ts:161-165 注释明说「The web UI re-enables via PATCH {status:'active'} (patchUser)」）。于是 Web UI 上最常见的降级和停用两个操作都不会 bump。另有两个真实撤销点也不在表里：`resetPassword`（users.ts:85，内部 revokeAllSessionsForUser——正是 proposal §2「凭据泄漏」场景的标准响应）与 `routes/auth.ts:119` 的 revoke-all。反过来 `deleteIdentity` 并不使已发放的 session/PAT 失效（只删 user_identities 行），是表里唯一对 WS 无实质影响的条目。plan T2 的源码棘轮若照表实现，会去断言一个不存在的函数（写不出来，只能悄悄换符号，棘轮语义随之失真），同时把真正的洞留在外面。
- **证据**：packages/backend/src/services/users.ts:180 —— `export async function patchUser(db, id, patch, now, actorId)`；users.ts:224-236 统一写入 role/status；全文件无 `updateUser`; packages/backend/src/routes/users.ts:79 —— `const updated = await patchUser(`（PATCH /api/users/:id）；routes/users.ts:90 才是 disableUser; packages/backend/src/services/users.ts:85-107 —— resetPassword 末尾 `await revokeAllSessionsForUser(db, id, now)`; packages/backend/src/auth/sessionStore.ts:123-132 —— revokeAllSessionsForUser；调用方 routes/auth.ts:119、users.ts:106、users.ts:155; packages/backend/src/services/userIdentities.ts:77-88 —— deleteIdentity 只 `db.delete(userIdentities)`，不触碰 user_sessions / user_pats
- **改法**：把 §4 重写为「凭据层原语 + 授权层原语」两类，bump 下沉到原语而非调用点：`revokeSession` / `revokeAllSessionsForUser` / `revokePat`（三条覆盖 resetPassword、disableUser、logout-all 的全部转发路径）+ `patchUser` 的 role/status 分支 + `updateTaskMembers` + `updateResourceAcl`；`deleteIdentity` 保留但注明「不影响已发放凭据，bump 仅为保守」。plan T2 的源码棘轮改成对这 6 个真实符号做函数体断言，并加一条反向锁：users.ts 中任何写 `users.role` / `users.status` 的语句所在函数必须含 `bumpAuthEpoch(`。

#### [阻断] `replayTaskEvents` 与 hello 走的是绕过复核挂点的另外两条 sendJson 路径，AC-7 的变异实证也测不到

- **理由**：registry.ts 里有三处 sendJson 调用点：gatedSubscribe 的 listener（586-608，唯一会被 design §2 挂钩的一处）、hello 帧（609-613）、以及 replayTaskEvents 的循环体（322）。`?since=N` 回放由 onOpenExtra 在 openWsChannel 里触发（registry.ts:625-627），既不经过 broadcaster 也不经过 frameGate——task 通道本来就没有 frameGate，回放内容是该任务全部 node_run_events（含 agent stdout：prompt、被读文件内容、命令输出），正是 proposal §2 第一条用户故事点名的泄漏面。而 tryUpgrade 与 handleOpen 之间隔着完整 WS 握手（Bun 握手完成后才调度 open），撤销落在这个窗口内时 upgradeGate 拿的是撤销前的判定，回放照发。design §2 只定义了「帧投递前」一个挂点，§7 的「已知盲区」只承认「撤销发生在同一帧投递过程中」和多进程，没提 open 路径；AC-7 的三条变异全部作用在 gatedSubscribe 上，怎么劣化都不会让回放路径变红。
- **证据**：packages/backend/src/ws/registry.ts:288-324 —— replayTaskEvents 内 `sendJson(ws, msg)`（第 322 行）逐条直发，无任何 gate; packages/backend/src/ws/registry.ts:617-628 —— openWsChannel：先 gatedSubscribe，再 `await erased.onOpenExtra(ws, params, db)`; packages/backend/src/ws/registry.ts:358-360 —— task 的 onOpenExtra：`if (p.since !== undefined) await replayTaskEvents(db, p.taskId, p.since, ws)`; packages/backend/src/ws/server.ts:150-157 —— handleOpen 只调 openWsChannel，upgrade 与 open 之间无二次校验; design/RFC-212-ws-authorization-revalidation/design.md:119 —— 「已知盲区」两条中不含 open / replay 路径
- **改法**：把复核挂点从「gatedSubscribe 的 listener」下沉到 `sendJson` 本身（或在 openWsChannel 入口先做一次同步 epoch 检查、stale 则先 await 复核再决定是否回放），使三条发送路径共享同一个门；AC-7 增加第四条变异「去掉 open 路径的复核 → `?since=0` 回放用例必红」。

- **[关注] repo-import 通道在这套机制下对「凭据吊销以外的一切撤销」永久免疫，RFC 全文未表态**：registry.ts:415-424 该通道既无 upgradeGate 也无 frameGate，注释明写「Batch-ownership validation is a registered leftover (RFC-152 D4), NOT silently added here」。§2 步骤 ④「重跑该通道的 upgradeGate（若有）」对它是空操作，§3.3 只能填 `{na: ...}`。结果是 proposal 宣称的 28 格里，repo-import × {角色降级, ACL 收回, 任务成员移除} 三格恒为空——只有凭据吊销（步骤 ①②）对它有效，而 batchId 是可传播的 bearer 串。建议 AC-5 的矩阵为 repo-import 显式填 `{na: '无授权门，仅受凭据有效性约束；batch-ownership 校验是 RFC-152 D4 遗留'}`，并在 proposal §4 非目标里点名登记，避免「28 格已覆盖」的表述掩盖 D4。

- **[关注] 复核点拿不到 daemonTokenBuf —— 接线缺口，design §3.2 未列**：`resolveActor(db, token, daemonTokenBuf)`（server.ts:116）第三参在 server.ts:83 由 `deps.daemonToken` 预分配。但复核发生在 registry 侧，`gatedSubscribe(ws, spec, params, db)`（registry.ts:578-583）与 `openWsChannel(ws, params, db)`（registry.ts:617-621）签名里只有 db。§3.2 的 ConnectionData 只加了 token / epoch，没有 daemonToken；不补进去就得改这两个公共签名，波及 rfc152-ws-* 全套测试。建议在 §3.2 明确「daemonTokenBuf 随 ConnectionData 下发（或做成模块级 provider）」，并说明 `__system__` 连接的复核语义（daemon token 恒有效、复核恒过）。

- **[关注] AC-3「连接被关闭」与惰性机制自相矛盾：空闲连接永远不会被关**：惰性复核只在有帧到来时触发。proposal §2 第三条故事（人员离职 / 凭据泄漏，「对方已经打开的页面」）最典型的形态恰恰是一条没有帧的连接：任务已 done、workflows 无人改动。此时 AC-3 字面要求的「被关闭」不会发生。数据面确实不泄漏（无帧可发），但 AC 写成「被关闭」会逼实现者引入定时扫描，与 AC-6「零额外查询」直接冲突。建议 AC-3 改写为「该凭据建立的所有 WS 连接在下一帧投递之前被关闭；无帧期间保持静默不构成违反」，并在 §7 用例里显式断言这一点。

- **[关注] §3.3 的 `cacheKeyPrefixes` 前缀语义对 tasks-list 不成立**：visibilityCache 的 key 空间是混的：tasks-list 用裸 taskId（registry.ts:213-219，注释「raw taskId cache key」），workflows 用 `wf:` 前缀（registry.ts:222-224），memories 刻意不缓存（registry.ts:130-135）。因此 tasks-list 的 cacheKeyPrefixes 只能填 `['']`，前缀遍历/断言退化为空约束。既然 §2 步骤 ③ 已是「整表清空」，该字段实际价值只剩文档；建议要么删掉，要么改成 `cacheKeys: 'raw-task-id' | 'wf-prefixed' | 'none'` 这种能被测试消费的判别式。另：proposal §1 说 workflows「只有一处 ctx.cache.delete」，实际是两处（registry.ts:398 与 403，workflow.deleted 分支也 bust），不影响结论但描述不准。

- **[关注] 「无条件 bump」会让 RFC-054 W2-4 的可见性缓存在活跃系统里长期处于清空态**：§4 明确选择无条件 bump（含每次 ACL 保存、每次成员编辑），§2 步骤 ③ 又是整表清空 visibilityCache。在有人持续编辑 ACL/成员的实例上，tasks-list 与 workflows 的每条连接会被反复清缓存，随后每帧回落到 taskVisibleTo / cachedWorkflowVisible 的 DB 查询（registry.ts:202-239）。AC-6 的「零额外 DB 查询」只覆盖 epoch 未变的稳态，没覆盖「bump 之后缓存重建」的成本。建议 §7 补一条：bump 一次后连续 N 帧，断言 DB 查询次数为 O(去重后的资源数) 而非 O(N)；并把 plan §风险 2 的「个位数到几十条连接」写成可验证的容量前提。

- **[关注] 前端 4401/4403 的实际表现：有退避但会永久 30s 轮询，plan T6 的前提描述需修正**：useWebSocket.ts:200-205 的 scheduleReconnect 确有指数退避（500ms 起、上限 30s），且 backoff 只在物理 open 成功时重置（:176-185）——upgrade 被 401/403 拒时浏览器不会触发 open，所以不会退化成风暴，T6 的「若无退避则补」并不成立。真实待办是另外两件：(a) 凭据已吊销时 `getToken()` 仍返回旧 token（:137-143），页面空闲无 HTTP 请求时不会触发登出，会永久每 30s 重连一次；(b) close 事件处理器完全忽略 `event.code`（:186-194），无法区分 4401/4403 与网络断开，前端也就无法给出「你已失去访问权限」的提示。建议把 T6 改写成这两条具体验收。


### 性能与可测性视角 — verdict: `block`

#### [阻断] 复核路径的真实代价被当成「便宜」——resolveActor 每次是 2 SELECT + 1 UPDATE（写），且无 in-flight 去重

- **理由**：design §1 选 C 的整个论证建立在「复核本身很便宜」上，但 resolveActor 走的两条凭据路径都会写库：session 分支 2 次 select 后 `await db.update(userSessions).set({ lastUsedAt: now })`；PAT 分支同形。于是每次 epoch 变化，每条连接的复核 = 2 读 + 1 写，而且 §2 步骤⑤ 把 `ws.data.epoch = current` 放在 await 之后、复核又挂在 gatedSubscribe 的 fire-and-forget listener 上（registry.ts:586-608），同一 tick 内到达的 N 帧会各自触发一次完整 resolveActor（没有任何 in-flight Promise 去重）。AC-6 只给「无撤销」路径立了预算，撤销后路径**一条预算都没有**——恰好是唯一会花钱的那条。附带损害：WS 复核会把 last_used_at 刷成「刚用过」，而这个字段是要展示给用户看的（packages/frontend/src/routes/account.tsx:651 的会话列表 / :388 的 PAT 列表），一条挂着的 socket 会让已经闲置的会话永远显示活跃。
- **证据**：packages/backend/src/auth/sessionStore.ts:88-100 —— lookupActiveSession：select userSessions → select users → `await db.update(userSessions).set({ lastUsedAt: now })`（注释自称 Rolling renewal）; packages/backend/src/auth/patStore.ts:79-89 —— lookupActivePat 同形：2 select + `db.update(userPats).set({ lastUsedAt: now })`; packages/backend/src/auth/session.ts:62-92 —— resolveActor 直接委派上述两个函数，无只读变体; packages/backend/src/ws/registry.ts:586-608 —— broadcaster listener 是同步回调 + fire-and-forget 异步门，没有任何 per-connection 串行化/去重槽位; packages/frontend/src/routes/account.tsx:651 —— 会话列表把 lastUsedAt 呈现给用户
- **改法**：1) 新增只读复核入口（如 `resolveActorForRevalidation` / `lookupActiveSessionReadonly`），显式不 touch lastUsedAt，并在 design §3.1 写明「复核路径禁止产生写」；2) §2 增加步骤⓪：per-connection `revalidating: Promise<void> | null`，epoch 变化时若已有在途复核则复用同一 Promise，保证「每连接每次 epoch 变化最多 1 次 resolveActor」；3) 新增 AC-6b 为这条不变量立断言（计数器同时统计 update，见另一条阻断项）。

#### [阻断] §2 的五步流程从未把新解析出的 actor 写回 ws.data.actor —— AC-2 在设计层面就不可能通过

- **理由**：AC-2 要求「降级为 user 后失去 admin 短路」。但 admin 短路读的是 `ws.data.actor.user.role`（registry.ts:587），frameGate 的 ctx 也是 `actor: ws.data.actor`（registry.ts:598）。design §2 的五步是：①重新 resolveActor ②失效则 close ③清 visibilityCache ④重跑 upgradeGate ⑤写回 epoch —— 唯独没有「把 ① 的结果赋给 ws.data.actor」。按字面实现，复核只会「确认凭据还有效」，然后继续用 upgrade 时冻结的旧 actor（旧 role、旧 permissions）投递。AC-2 涉及的三个通道（tasks-list / workflows / memories）全部依赖 actor 本身而非缓存，AC-4 里 memories 也一样（它压根没有缓存，见下一条），于是这些格子会「实现完了测试还是红的、或者测试被写成绕过 actor 的空断言」。这是整个 RFC 里最容易在实现时漏掉、且漏掉后所有 admin 相关格子静默失效的一步。
- **证据**：packages/backend/src/ws/registry.ts:587 —— `if (erased.adminShortCircuit === true && ws.data.actor.user.role === 'admin') { sendJson(ws, msg); return }`; packages/backend/src/ws/registry.ts:598 —— frameGate ctx 构造：`{ db, actor: ws.data.actor, cache: ws.data.visibilityCache }`; packages/backend/src/ws/registry.ts:126-127 —— WsConnectionData.actor 的注释「Resolved actor pinned at upgrade — no per-frame token re-resolution」; design/RFC-212-ws-authorization-revalidation/design.md:22-26 —— §2 五步，无 actor 写回
- **改法**：§2 数据流补一步「② 之后：`ws.data.actor = 复核得到的新 actor`」，并在 plan T5 的验收里单列一条：「降级后同一条 socket 上 `ws.data.actor.user.role === 'user'`」——用直接读 ws.data 的白盒断言 + AC-2 的行为断言双锁，避免只有行为断言时被 admin 短路以外的路径蒙混过去。

#### [阻断] AC-6「零额外 DB 查询」在现有测试基建里没有可执行落点：无查询计数原语，且「零」对 4/7 通道不可表达

- **理由**：我按要求把仓里能找到的计数手段全找了一遍：**没有**任何共享的查询计数 helper，drizzle client 也没开 logger（packages/backend/src/db/client.ts:35 `drizzle(sqlite, { schema })`，无 logger 选项）。唯一先例是两处一次性的 `new Proxy(db, { get })`，而且它们只拦 `select`、目的是注入竞态而非计数——按这个模子写 AC-6，会把复核路径里的 UPDATE（见第一条阻断项）**完全漏计**，正好放过最该被计的那次。更根本的问题是「零」这个数字只对 3 个通道成立：task / repo-import / memory-distill-jobs 没有 frameGate，稳态确实 0 次查询；但 tasks-list 缓存未命中要 select（registry.ts:213-219）、workflows 缓存未命中要 select（registry.ts:222-239）、memories **每帧必 select 且刻意不缓存**（registry.ts:443-463）。在这四个通道上「广播路径不产生任何额外 DB 查询」无法写成 `expect(count).toBe(0)`，而实现之后又没有「关掉本特性」的基线可做差分——AC 按字面根本落不了地。
- **证据**：packages/backend/src/db/client.ts:35 —— `const db = drizzle(sqlite, { schema })`，未启用 drizzle logger; packages/backend/tests/rfc120-manual-questions.test.ts:766-796 —— 全仓仅有的 db Proxy 先例之一，只拦 `select`，用途是注入状态翻转; packages/backend/tests/rfc120-deferred-dispatch.test.ts:900 —— 另一处同形 Proxy; packages/backend/src/ws/registry.ts:436-438 —— memories 注释：「no cache — RFC-045 edits can move rows between scopes」; packages/backend/src/ws/registry.ts:213-219 / 222-239 —— cachedTaskVisible / cachedWorkflowVisible 的未命中查询路径; packages/backend/tests/rfc152-ws-frame-gates.test.ts:83 —— `buildWebSocketAdapter({ daemonToken, db })`，db 可注入（计数 Proxy 有地方挂）
- **改法**：AC-6 重写为可执行形态：(a) 先在 tests/helpers 里落一个**共享**的 `countingDb(db)` 原语，同时拦 `select/insert/update/delete`（并覆盖 `db.query.*` 若被用到），把它当公共测试原语而不是第 3 份一次性 Proxy；(b) 把断言从「零」改成**每通道 golden 计数表**：task/repo-import/memory-distill-jobs 期望 0，tasks-list/workflows 期望「首帧 1、后续 0（缓存命中）」，memories 期望「每帧恰好 1，且与本 RFC 落地前的既有值相同」；(c) 单列一条 AC 断言「epoch 未变时计数增量为 0」——这才是本 RFC 真正要锁的东西。

#### [阻断] proposal §1.1 的动机表把 memories / scheduled-tasks 的机制写错，导致 AC-4 与 design §7 case 5 要求断言一个不存在的缓存

- **理由**：表里 memories 和 scheduled-tasks 两行都写「缓存永不失效」。源码里：memories 的 frameGate **明确不使用 per-connection 缓存**（注释与实现都是每帧重新查行），scheduled-tasks 的 frameGate 是纯内存判断（读 `ctx.actor.permissions` 与 `msg.ownerUserId`），连 ctx.cache 都不碰。七个通道里真正持有 per-connection 可见性缓存的只有两个：tasks-list（raw taskId 键）与 workflows（`wf:` 前缀）。后果有两层：(1) AC-4「资源 ACL 被收回后，对应通道的 per-connection 可见性缓存失效」和 design §7 必写用例 5「workflows / memories 通道缓存失效」，对 memories 是**空断言**——没有缓存可失效，memories 的真实修复点只有 actor 刷新（admin 短路 + canViewMemory 的 actor 入参）；写出来的测试要么恒绿要么被迫改成断言别的东西。(2) §3.3 的矩阵维度 `cacheKeyPrefixes` 对 5/7 通道恒为 `[]`，作为「28 格由机器持有」的载体几乎不携带信息，反而给人一种每个通道都有缓存要清的错觉。
- **证据**：packages/backend/src/ws/registry.ts:433-471 —— memories：adminShortCircuit + 每帧 `select ... from memories where id = msg.memoryId`，注释 :436-438「no cache」; packages/backend/src/ws/registry.ts:495-499 —— scheduled-tasks frameGate：`ctx.actor.permissions.has('tasks:read:all') || msg.ownerUserId === ctx.actor.user.id`，未触碰 ctx.cache; packages/backend/src/ws/registry.ts:213-219 / 221-239 —— 仅有的两个缓存使用者（tasks-list / workflows）; packages/backend/src/ws/registry.ts:129-135 —— visibilityCache 注释已写明「memories deliberately does NOT cache」; design/RFC-212-ws-authorization-revalidation/proposal.md:25,27 —— 两行错误的「缓存永不失效」; design/RFC-212-ws-authorization-revalidation/design.md:114 —— §7 用例 5「workflows / memories 通道缓存失效」
- **改法**：1) 按源码更正 §1.1 表：memories 行改「每帧重查行、无缓存；陈旧点是冻结的 actor（admin 短路 + canViewMemory 入参）」，scheduled-tasks 行改「纯内存判断、无缓存；陈旧点是冻结的 permissions」。2) AC-4 拆成两类可分别断言的东西：A「缓存失效」只针对 tasks-list / workflows；B「actor 刷新」针对 memories / scheduled-tasks / workflows 的 admin 短路。3) §3.3 把 `cacheKeyPrefixes: readonly string[]` 换成能表达空态的判别联合（如 `{ kind: 'no-cache', why: string } | { kind: 'prefixes', prefixes: readonly string[] }`），让 5/7 的「没有缓存」变成一次**显式表态**而不是空数组。

#### [阻断] AC-5 的「删一格即编译失败」措辞自相矛盾且未指定机制，AC-7 的「三条变异必红」依赖尚不存在的 G6 基建、验收落在 PR 说明里

- **理由**：AC-5：`WsChannelRegistry` 本来就是 mapped type（`{[K in WsChannelKind]: ChannelSpec<K, …>}`），给 ChannelSpec 加**必填** revalidation 即得编译期穷尽——这和 AC-5 / plan T3 写的 `as const satisfies Record<WsChannelKind, …>`（另起一张并行表）是两套不同做法，design §3.3 说的是前者、AC-5 说的是后者，实现者会二选一并各自留洞。更要命的是「删掉任一通道的声明必须 tsc 失败」这件事**无法在 bun test 里表达**——你不可能在测试里删掉生产注册表的一格。仓里其实有现成的正确姿势（`@ts-expect-error` 反向锁：字段一旦变成可选，指令未被使用 → tsc 报 unused directive），但 RFC 完全没提。AC-7：全仓没有任何变异测试基建，而 G6（变异测试基建）在审计报告里本身还只是**待建**的 W4 条目；plan T7 的验收写的是「三条变异逐一记录在 PR 说明里」——PR 说明是散文，没有编译器、没有 CI 会因为它变假而变红，正是这次审计自己命名的逃逸机制「散文与索引充当契约载体」。把它列进「合并前逐条打勾」的验收清单等于把一条不可执行项当成门。
- **证据**：packages/backend/src/ws/registry.ts:330-332 —— `export type WsChannelRegistry = { [K in WsChannelKind]: ChannelSpec<K, ChannelMessageByKind[K]> }`（已具穷尽性）; packages/shared/tests/rfc080-parametric-runtime-migration.test.ts:128-142 —— 仓内现成的编译期反向锁范式：`@ts-expect-error` + 「字段变可选 → 指令未使用 → typecheck 红」; packages/shared/tests/rfc080-output-kind-ui.test.ts:73-76 —— 同一范式的第二处先例; design/test-guard-audit-2026-07-21/00-SYNTHESIS.md:240 —— 「G6 | 变异测试基建 … | ci-gate | 中」，即基建尚未存在; design/RFC-212-ws-authorization-revalidation/plan.md:13 —— T7 验收：「三条变异逐一记录在 PR 说明里」; design/RFC-212-ws-authorization-revalidation/design.md:73 —— §3.3 用的是「挂在 WS_CHANNELS 上 → mapped type 强制」，与 AC-5 的 satisfies 表述不一致
- **改法**：AC-5：统一到「ChannelSpec 加必填字段 + WsChannelRegistry mapped type」这一条路径（删掉 `as const satisfies` 的表述），并把可执行形式写死为「新增一条 @ts-expect-error 反向锁：构造一个省略 revalidation 的 WsChannelRegistry 局部字面量，一旦该字段被改成可选，指令未使用即 typecheck 红」，仿 rfc080 两处先例。AC-7：从「合并前验收清单」里移出，改为二选一——要么降级成 PR 内一次性核对（明确标注「非 CI 门、不构成验收」），要么把 G6 的最小基建（守卫 id → 劣化补丁 → 期望变红的 test id 清单 + 一条驱动脚本）作为本 RFC 的前置任务 T0 先落，再让 T7 挂上去。

- **[关注] §4 表里的「角色更新 → updateUser」指向一个不存在的函数；实际是 patchUser，且它同时承载 role 与 status 两条收窄路径**：其余六个 file:line 我逐个核对**全部准确**：sessionStore.ts:115 revokeSession、patStore.ts:107 revokePat、userIdentities.ts:77 deleteIdentity、users.ts:132 disableUser、taskCollab.ts:130 updateTaskMembers、resourceAcl.ts:313 updateResourceAcl。但 services/users.ts 里没有 updateUser，角色写入点是 `patchUser`（users.ts:180），而且 users.ts:225-227 那三行 `if (patch.role !== undefined) updates.role = …` / `if (patch.status !== undefined) updates.status = …` 意味着 patchUser 既是角色降级路径**也是**停用路径——与单独列出的 disableUser 并存。T2 的源码棘轮如果照 §4 表按「七个函数」清点，会漏掉 patchUser（或者更糟：找不到 updateUser 而被人顺手把棘轮改宽）。§4 表应改成八个写入点，并在棘轮里对 patchUser 断言 role 与 status 两个分支都在 bump 覆盖范围内（无条件 bump 的话就是函数体含一次调用即可，但函数名必须写对）。

- **[关注] 「不改前端」的判断站不住：退避确实已有，真正缺的是 close code 从未被读取——4401 会退化成每 30s 一次的永久无效重试且用户无感知**：我读了 hooks/useWebSocket.ts：退避机制完整（:39-40 BASE 500ms / MAX 30s，:200-204 scheduleReconnect 指数退避，:177-178 open 时重置为 500ms），所以 T6「若无退避则补」这个假设是错的。真正的洞在 :186-194——close 监听器**连 event 参数都没有接**，`e.code` 从头到尾没被读过。于是 4401 之后：auth store 里的 token 没被清（:137 `getToken()` 照旧返回被吊销的 token）→ 每次重连在 tryUpgrade 拿 401（ws/server.ts:122-124）→ 浏览器不触发 open → 退避涨到 30s 封顶 → **永久每 30s 一次的无效重连**，而且界面上没有任何「你已被登出」的提示，用户看到的只是数据静默不更新。design §5「前端只需保证关闭码可读」把要求说反了：码是可读的，只是没人读。T6 应改写为「读取 close code：4401 → 清 auth store / 触发登出流；4403 → 停止该 path 的重连并给出不可见提示」，并配一条前端行为锁。

- **[关注] 现有 ws 测试不会大面积改写（只 1 个文件要动），但同一文件里有两条「同步投递」锁是 T5 的绊线**：我盘了全部 12 个 ws 相关测试文件（约 3166 行）。6 个通过真实 socket 走 buildWebSocketAdapter（ws.test.ts:41、ws-auth-multi-token.test.ts:43、ws-repo-imports.test.ts:36、rfc099-ws-acl-filter.test.ts:74、rfc152-ws-frame-gates.test.ts:83、rfc152-ws-task-channel.test.ts:96），它们本来就是异步等帧，加 token/epoch 字段完全不影响。唯一硬编码 `WsConnectionData` 字面量的是 rfc152-ws-channel-registry.test.ts:58-62（加两个必填字段要改这一处）；scheduled-tasks-ws.test.ts:31 和同文件的 makeProbeSpec 都用 `as unknown as` 造假 spec，新增必填字段也不会红。所以「大面积改写」不成立。但**真正的绊线**是同一文件的两条同步断言：:277「no frameGate ⇒ every frame forwards」与 :290「adminShortCircuit sends synchronously for admins」——两者都在 `probe.fire()` 之后**不 await**直接 `expect(sent).toEqual([...])`。只要 T5 把复核无条件塞进 listener（哪怕 epoch 相等只是多一个 await），这两条立刻变红。RFC 全文没有提到它们。应把「epoch 相等时投递路径必须保持完全同步、不引入任何微任务」写成显式不变量，并把这两条现有测试列进 T5 的验收清单当回归锚点。

- **[关注] plan 的 T3 依赖标注为「—」但实际是 T5 的前置，且 T3 的行为验收在 T5 落地前只能是空壳；T7 依赖不存在的基建；T8 声称的保护不成立**：T3（矩阵）标依赖「—」，可 §3.3 的 `onEpochChange` 取值域（rerun-upgrade-gate / clear-cache-only / na）直接决定 T5 的分支结构，实质是 T5 的前置；反过来 T3 验收里的「表驱动测试遍历矩阵」在 T5 之前只能断言**声明存在**、断不了任何行为，于是这条测试会先以空壳形态通过、再在 T5 之后被悄悄重写——「每格至少一条行为断言」（AC-5 后半句）在 T3 阶段不可达。建议 T3 只交类型 + @ts-expect-error 编译期锁，行为遍历整体并入 T5。T7 见阻断项。T8 写「索引与实现一致（受 docs-implementation-parity.test.ts 同类反向锁保护）」——该文件确实存在且正是本次审计 G11 的产物（tests/docs-implementation-parity.test.ts:1-27），但它是**逐条手写**的反向锁集合，不会自动覆盖 RFC-212 的索引条目；T8 必须显式新增一条锁，否则「受保护」是一句会误导下一个 session 的假话。另外 T1–T8 里没有任何一步覆盖 repo-import 通道（registry.ts:415-424 无门无缓存）在复核后的期望行为，而它在 AC-5 的 28 格里占一整列。

- **[关注] close 与 unsubscribe 之间的窗口没有短路，AC-1「不再收到任何该任务的帧」在高频通道上是概率性的**：broadcaster.broadcast 是同步 for-of（ws/broadcaster.ts:46-58），退订只发生在 Bun 的 close 回调里（ws/server.ts:159-167 handleClose → ws.data.unsubscribe()）。复核是异步的，`ws.close(4403)` 在 await 之后触发，close 回调再异步到达——这中间到达的帧仍会走进 listener 并 sendJson。task 通道虽然有节流（runner.ts 的 PARENT_BROADCAST_THROTTLE_MS = 500ms），但 clarify / review / scheduler 等十余处 taskBroadcaster.broadcast 不受该节流约束。建议 WsConnectionData 加一个 `closing: boolean`，在调用 ws.close 之前置位，listener 开头即短路；并把 AC-1 的断言从「关闭后收不到」加强为「触发撤销后到关闭完成之间也一帧不漏」，否则这条 AC 会是 flaky 的来源。


### 找致命伤 — verdict: `block`

#### [阻断] 选型表把方案 B 稻草人化：真正更简单的「全局连接集合 + 撤销时全量重扫」根本没进候选

- **理由**：design §1 用「需要『用户→连接』『任务→连接』多张反向索引，且每类撤销各自维护」否掉 B。但这只对**精确定位**版本成立。方案 C 本身就是粗粒度（任一撤销让所有连接复核），它的粗粒度等价物是：一个进程级 `Set<ServerWebSocket<WsConnectionData>>`，零反向索引、零按撤销类别的分支。撤销方的负担完全相同（epoch 是 `bumpAuthEpoch()`，它是 `revalidateSoon()`），但它避开了 C 的全部实现难点：复核在广播扇出之外的 async 上下文里跑（见 blocker 2）、帧路径一行不改（AC-6 由构造成立而不需要计数断言）、能真正关闭空闲连接（见 blocker 5）。而且复核入口 `checkUpgradeGate` 已经是导出的、channel-agnostic 的（registry.ts:558-566），直接可复用。选型结论决定了 T1–T7 全部七个任务的形状，这一条不重来，后面都是在错误骨架上加固。
- **证据**：packages/backend/src/ws/broadcaster.ts:25 `private subs = new Map<ChannelKey, Set<Listener<M, C>>>()` —— broadcaster 只持有闭包，确实没有连接句柄，所以 RFC「没有天然连接表」这半句对；但要补的是 **一张** 平表，不是「多张反向索引」; packages/backend/src/ws/server.ts:150-157 handleOpen / :159-167 handleClose —— 增删连接集合的两个钩子已经存在，close 里已经在做 unsubscribe; packages/backend/src/ws/registry.ts:558-566 `export async function checkUpgradeGate(db, actor, params)` —— 已经是通道无关的复核入口; packages/backend/src/ws/registry.ts:587,598 listener 在**帧到达时**才读 `ws.data.actor` —— 就地替换 actor 即刻生效，不需要重新订阅，即时重扫方案完全可行
- **改法**：在 design §1 增加方案 D「进程级连接集合 + 撤销时 async 全量重扫（re-resolveActor → 写回 ws.data.actor → 清 visibilityCache → 重跑 checkUpgradeGate → 失败则 close）」，并按同一口径重比三案。若仍选 C，必须说明 C 相对 D 的**具体**优势（唯一站得住的是 upgrade 与撤销写入并发时的 TOCTOU 窗口：epoch 可以在 resolveActor **之前**快照）——那正确答案是 D + upgrade 前快照 epoch 的混合，而不是纯 C。

#### [阻断] 惰性复核要把一次 async DB 调用塞进同步的广播扇出里，design §2 的五步流程完全没处理并发窗口

- **理由**：广播是同步的，且 `task`（node.event 主通道）与 adminShortCircuit 通道走的是**同步 send** 分支——今天它们的帧严格保序。design §2 把 ① `resolveActor`（= 2 SELECT + 1 UPDATE）插到投递最前面，于是：(a) epoch 只在步骤 ⑤ 写回，bump 后到首次复核返回之间到达的每一帧都各自看到 mismatch → N 帧触发 N 次并发 resolveActor，完成顺序不定 → **task 通道 node.event 可能乱序**；(b) 复核在途时这些帧是排队还是丢弃，design 一个字没写——naive 写法 `if (stale) { revalidate(); return }` 会静默丢事件，而 task 事件丢了只有重连带 `?since` 才补得回；(c) 这个窗口 AC-6（只测无撤销时零额外查询）和 §7-8 的三条变异实证**都覆盖不到**，即测试网对该 RFC 最危险的那段代码是盲的。
- **证据**：packages/backend/src/ws/broadcaster.ts:46-59 `broadcast()` 同步遍历 listener; packages/backend/src/ws/registry.ts:586 subscribe 回调是同步函数；:587-590 adminShortCircuit 同步 send；:591-594 无 frameGate 通道（含 `task`）同步 send；只有 :597-607 的 frameGate 才是 fire-and-forget; packages/backend/src/auth/sessionStore.ts:85-113 lookupActiveSession = 2 次 select + 1 次 `update(userSessions).set({lastUsedAt})`；packages/backend/src/auth/patStore.ts:72-95 同构; design/RFC-212-ws-authorization-revalidation/design.md:20-27 五步流程按同步语义书写，无 in-flight 状态、无队列、无「复核期间帧如何处置」
- **改法**：要么改走方案 D（复核彻底移出扇出，帧路径不变）；要么在 `ConnectionData` 上显式加 `revalidating: Promise<void> | null` + 待发帧队列，并把两条新 AC 写死：「复核期间到达的帧必须排队后按原序投递，不得丢弃」「一次 epoch 变化在单连接上最多触发一次 resolveActor」，各配一条并发用例。

#### [阻断] §3.3 的复核矩阵三值枚举张不满真正的修复动作，memories / scheduled-tasks 两格可以「编译期全绿」而洞照留

- **理由**：让 AC-2（降级失去 admin 短路）生效的动作是**刷新 `ws.data.actor`**，但 design §2 的 ①–⑤ 从头到尾没有一步写「把新 actor 写回 ws.data.actor」，§3.3 的 `onEpochChange: 'rerun-upgrade-gate' | 'clear-cache-only' | { na }` 三个取值也没有一个表达这个动作。更硬的是：`memories` 的 frameGate **刻意不使用** visibilityCache，`scheduled-tasks` 的 frameGate 只读 `ctx.actor.permissions`，两者从不碰 `ctx.cache`。因此 (1) proposal §1 表里 memories / scheduled-tasks 两行「缓存永不失效」是事实错误——它们根本没有缓存；(2) AC-4 与测试策略 §7-5 要求断言「`memories` 通道缓存失效」，**没有缓存可失效**，这条写不出非空断言；(3) 实现者把 memories 填成 `'clear-cache-only'` + `cacheKeyPrefixes: []`，编译期矩阵绿、表驱动测试遍历得到、AC-5 打勾，而 memories 的 admin 短路在降级后**依旧生效**——正是本 RFC 声称要用矩阵消灭的那类洞，被矩阵盖章放行。
- **证据**：packages/backend/src/ws/registry.ts:135,214,217,224,237,398,402,403,598 —— `ctx.cache` 的全部访问点只在 cachedTaskVisible(tasks-list) / cachedWorkflowVisible(workflows) / workflows frameGate 内; packages/backend/src/ws/registry.ts:434-437 注释明写 memories「no cache: … RFC-045 edits can move a row between scopes」；:443-471 实现无一次 ctx.cache 访问; packages/backend/src/ws/registry.ts:498-499 scheduled-tasks frameGate `ctx.actor.permissions.has('tasks:read:all') || msg.ownerUserId === ctx.actor.user.id` —— 纯 actor 依赖; packages/backend/src/ws/registry.ts:432 memories `adminShortCircuit: true`；:587 短路判定读 `ws.data.actor.user.role`
- **改法**：把 `onEpochChange` 从三值枚举改成**动作集合**并让每格必须显式表态：`{ refreshActor: true, clearCache: 'all' | 'none' | string[], rerunUpgradeGate: boolean }`（`refreshActor` 对七格恒为 true，就写成矩阵里一列强制的 `true` 而不是可选）。同步把 proposal §1 表里 memories / scheduled-tasks 的「缓存永不失效」改成「无缓存，风险源是冻结的 actor」，把 AC-4 拆成 AC-4a（有缓存通道：缓存失效）与 AC-4b（无缓存通道：actor 刷新后 frameGate/短路按新权限判定）。

#### [阻断] §4 的七个撤销写入点漏了真实撤销路径，而 §6 的源码棘轮按函数体粒度断言，保证漏的这些永远不会被发现

- **理由**：三处具体遗漏：(1) `revokeAllSessionsForUser` 不在表里，而它才是批量吊销入口——改密（services/users.ts:106）和「登出其他所有设备」（routes/auth.ts:119）都只调它，**不经过 `revokeSession`**，于是两条最经典的撤销不 bump。(2)「角色更新 — `services/users.ts`（`updateUser` 的 role 分支）」：仓里**没有 `updateUser`**，实际是 `patchUser`；而 patchUser 同时承载 `patch.status === 'disabled'`，这是与 `disableUser` 并列的第二条停用路径（Web UI 走的正是 PATCH），按 RFC 字面只在 role 分支接线就会漏。(3) 自然过期完全没覆盖也没登记为非目标：会话/PAT 的 `expiresAt < now` 是纯时间判定、没有任何写入点，因此永远不会 bump，结果是 **WS 上凭据有效期形同虚设**——到期的 session/PAT 建立的连接可无限期继续收帧，而 HTTP 侧立刻 401。这直接打脸 proposal §2 卖的「人员离职、凭据泄漏」故事。最致命的是 §6 的防护：棘轮断言「函数体含 `bumpAuthEpoch(`」，只要 patchUser 的 role 分支里有一次调用，status 分支漏掉时棘轮照样绿——**棘轮粒度（函数体）粗于漏洞粒度（分支）**，它防不住它声称要防的那类遗漏。
- **证据**：packages/backend/src/auth/sessionStore.ts:123 `revokeAllSessionsForUser`（不在 §4 表内），调用方 packages/backend/src/services/users.ts:106（resetPassword）、packages/backend/src/routes/auth.ts:119（改密后吊销其余会话）、services/users.ts:156（disableUser）; packages/backend/src/services/users.ts:180 `export async function patchUser`（RFC 写的 `updateUser` 不存在）；:230-231 `updates.role` 与 `updates.status` 同在一个写入块；:216 的注释记录了历史上「只查 role 没查 status」导致 last-admin 漏网的同型事故; packages/backend/src/auth/sessionStore.ts:94 `if (session.expiresAt < now) return null`；packages/backend/src/auth/patStore.ts:83 `if (pat.expiresAt !== null && pat.expiresAt < now) return null` —— 纯时间判定，无写入点; design/RFC-212-ws-authorization-revalidation/design.md:100 棘轮定义为「断言其函数体含 `bumpAuthEpoch(`」
- **改法**：§4 表补 `revokeAllSessionsForUser`（或改为在 `revokeSession`/`revokeAllSessionsForUser` 两处都 bump），把「`updateUser` 的 role 分支」改成「`patchUser`（users.ts:180）无条件 bump，覆盖 role 与 status 两条分支」。棘轮改成按**写入面**而非函数体：断言「凡 `db.update(users|userSessions|userPats)` 且 set 里含 role/status/revokedAt 的语句，其所在函数必须调用 bumpAuthEpoch」，让新增写入点默认失败。自然过期另立一条：在 ConnectionData 上钉 `credentialExpiresAt`，帧前做一次 `now > expiresAt` 的**纯本地**比较（零 DB）后再走复核；不做就必须写进非目标并说明「WS 会话可超出其 TTL 存活」。

#### [阻断] AC-3 在方案 C 下不可能成立——proposal 目标 §3-1 与 AC-3 自相矛盾

- **理由**：AC-3 写的是「会话/PAT 被吊销、账号被停用后，该凭据建立的**所有** WS 连接被关闭」，而 §3-1 写的是「在**下一帧之前**复核」。惰性复核只在投递前触发，静默通道上的连接永远不会被复核、永远不会被关闭：一个 awaiting_human 的 task 通道、一个已完成批次的 repo-import、一个没人改 workflow 的 workflows 连接，可以带着被吊销的凭据挂到浏览器关闭为止。测试策略 §7-4「连接被 4401 关闭」只有先推一帧才会绿——那条用例实际测的是「下一帧时关闭」，与 AC 文字不符，合并时按 AC 打勾就是自欺。且一旦承认需要主动关闭空闲连接，就必须有一次主动扫描——而主动扫描就是 blocker 1 里的方案 D 本身，绕一圈回到起点。
- **证据**：design/RFC-212-ws-authorization-revalidation/proposal.md:47 目标 1「在下一帧之前重新走一遍它自己的门」（惰性口径）; design/RFC-212-ws-authorization-revalidation/proposal.md:63 AC-3「该凭据建立的所有 WS 连接被关闭」（即时口径）; packages/backend/src/ws/registry.ts:415-424 repo-import 无任何 gate、无 frameGate，批次结束后即无帧，惰性复核在该通道上永不触发; design/RFC-212-ws-authorization-revalidation/design.md:20 复核触发点定义为「WS 帧投递前」
- **改法**：二选一并在 proposal 里写死：要么把 AC-3 改写成「下一帧前关闭；空闲连接可继续持有 socket 直至有帧或断线」并把「已吊销凭据的空闲 socket 可长期存活」登记为已知限制；要么承认需要即时关闭，改走方案 D。不要保留两个口径的 AC。

- **[关注] 复核触发 resolveActor 的写副作用被漏算：每次复核都写一行 last_used_at**：sessionStore.ts:100 与 patStore.ts:90 在每次成功 lookup 后都执行 `UPDATE … SET last_used_at`。粗粒度 epoch 下，任何一次 ACL 编辑都会让**所有**连接在下一帧各写一次 user_sessions/user_pats——在单写者的 SQLite 上是写放大，且污染 last_used_at 这个审计信号（socket 只要挂着，别人改一次 ACL 就显得该凭据「刚被使用」）。design §3.2 的「安全评估」只论证了 token 驻留不扩大攻击面，完全没提复核本身的写副作用；plan §风险 2 的「个位数到几十连接可忽略」也是按连接数算的，没算「连接数 × bump 频率」。建议复核路径走一个 `readOnly: true` 变体的 resolveActor，或至少在 AC 里加一条「复核不得产生 user_sessions 写入」。

- **[关注] 「不改前端」把一件必须改的事写成了已满足**：proposal §4 称「前端只需保证关闭码可读」，但 packages/frontend/src/hooks/useWebSocket.ts:186 的监听器签名是 `ws.addEventListener('close', () => {…})`——不接 event 参数，关闭码今天**读不到**。退避本身没问题（:200-205，500ms 起、30s 封顶，且只有 open 才 reset 到 BASE，:178），所以 T6 担心的「快速重试风暴」实测不成立；真正的问题是用户侧体验：会话被吊销后页面只会静默地每 30s 拿一个死 token 重试，没有任何「登录已失效」提示。要么把 T6 改成「读取 close code 并在 4401 时清 auth store / 提示重新登录」，要么把这条从非目标里删掉。

- **[关注] 「无条件 bump」的取舍方向对，但代价量级算错了**：design §4「判断是否收窄本身容易出错，故无条件 bump」这个论证站得住。但结论写的是「多余的 bump 只造成一次惰性复核」——实际代价是「全部连接 × 各自一次 resolveActor（2 SELECT + 1 UPDATE）+ blocker 2 的并发窗口」。`updateResourceAcl` / `patchUser` 这类既可能放宽也可能收窄的接口，一次纯**放宽**操作也会把全站连接推进 async 复核路径。取舍可以保留，但代价描述必须改对，否则评审是在错误的成本估计上批准的。

- **[关注] 核对属实的部分 + 落地时要留意的既有源码棘轮**：以下锚点逐一核对无误：server.ts:114-142（upgrade 一次性解析 actor + 空 visibilityCache）、registry.ts:396-400（唯一一处 ctx.cache.delete，且仅 workflow.acl.updated）、sessionStore.ts:115 revokeSession、patStore.ts:107 revokePat、userIdentities.ts:77 deleteIdentity、users.ts:132 disableUser、taskCollab.ts:130 updateTaskMembers、resourceAcl.ts:313 updateResourceAcl。另外 packages/backend/src/ws/server.ts:20-21 声明了「There must be NO per-channel `kind === '…'` branch in this file」并由 tests/rfc152-ws-task-channel.test.ts 源码锁定——复核逻辑落 server.ts 时若按通道分叉会直接撞红，矩阵必须留在 registry 侧。
