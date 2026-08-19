# RFC-312 技术设计：用户在线状态（presence）

- 状态：**Draft v7**——经设计门**六轮**（50 条 finding）；v6 改独立通道并整份重写，v7 收 V6-1…V6-8
- 前置：`proposal.md`；五轮记录见同目录 `codex-design-gate*.md`

> **v6 为什么是重写而不是补丁**：v1-v5 把 presence 帧挂在既有 `/ws/authority` 上以省一条连接，
> 代价是必须自建一套"权限变更 → 重同步"的协议。五轮门里 **F3 / N3 / N4 / V4-3 / W5-2 / W5-5**
> 六条 P1 全部长在这条协议上，且最后一条是**普通用户可触发的全网放大**。
> 独立通道让这套协议**整体消失**：权限变更由既有 RFC-212 `rerunUpgradeGate` 关连接、
> 客户端自然重订阅即可。代价是每标签页 +1 连接（§8 有账）。
> 同时 W5-6「三件套互斥合同」连续三轮被判不一致，根因是补丁叠补丁——故本版重写。

## 0. 与 RFC-294 的对齐

后台落在既有 bounded context `modules/identity-access/`。

| 层 | 文件 | 职责 |
| --- | --- | --- |
| domain | `domain/userPresence.ts` | 纯函数状态机：连接计数 + 宽限期 → 在线态；零 I/O、零时钟 |
| ports | `application/ports/userPresenceStore.ts` | 存储口（含 `pending` 索引语义与 `generation`） |
| ports | `application/ports/presenceGraceTimer.ts` | 宽限到期定时口 |
| ports | `application/ports/presenceBatchScheduler.ts` | 合并窗口定时口（与 grace **分开**） |
| ports | `application/ports/monotonicClock.ts` | 单调时钟口 |
| ports | `application/ports/userPresenceObserver.ts` | 变更出口（批量 `changes[]`） |
| commands | `application/commands/trackUserPresence.ts` | `opened` / `closed` / `flushBatch` / `reapExpired` |
| queries | `application/queries/getUserPresence.ts` | `snapshot()` / `stateOf()`（**零参**，内部持时钟） |
| infrastructure | 四个适配器 | 进程内 Map / `setTimeout().unref()` ×2 / `performance.now()` |
| public | `public/{commands,queries,types}.ts` | 只暴露 `TrackUserPresence` / `GetUserPresence` / `UserOnlineState` |
| composition | `composition.ts` | 唯一装配点；WS adapter 只接受 public 实例，**不接受 `db` 后自行 compose** |

`services/` 与 `routes/` 不加文件（本 RFC 无新 REST 端点）。

## 1. 判定口径与领域状态机

**在线 ⟺ 该用户名下存在至少一条活的、由 session 凭据建立、且已通过完整通道授权的
`/ws/presence` 连接；或最后一条断开还不足 `PRESENCE_GRACE_MS`。**

只认 `WsCredential.kind === 'session'`（`ws/registry.ts:176-188`）；PAT / daemon 不计。

```ts
export const PRESENCE_GRACE_MS = 60_000
export interface PresenceEntry {
  readonly connections: number       // 永不为负
  readonly graceUntil: number | null // **单调时钟刻度**；connections > 0 时为 null
}
export type UserOnlineState = 'online' | 'offline'
export function connectionOpened(e: PresenceEntry | undefined): PresenceEntry
export function connectionClosed(e: PresenceEntry | undefined, now: number, graceMs: number): PresenceEntry
export function stateOf(e: PresenceEntry | undefined, now: number): UserOnlineState
export function isReapable(e: PresenceEntry, now: number): boolean
```

`graceUntil` **必须是单调刻度**：用墙钟的话，NTP/管理员回拨 5 分钟会让条目反复重新 arm，
用户被显示在线约 6 分钟。宽限期是进程内、不持久化的，用单调源零副作用。

| 输入 | connections | graceUntil | `stateOf(now)` |
| --- | ---: | --- | --- |
| 未知用户 | – | – | offline |
| 第 1 条连接 | 1 | null | online |
| 第 2 条 | 2 | null | online |
| 关掉 1 条（剩 1） | 1 | null | online |
| 关掉最后 1 条（t=T） | 0 | T+grace | online（T ≤ now < T+grace） |
| 宽限到期（now = T+grace） | 0 | T+grace | **offline** |
| 宽限内又建连 | 1 | null | online（**无翻转、不发帧**） |

`connectionClosed` 对 `connections === 0` 幂等 no-op，不会扣成负数。

## 2. 应用层

### 2.1 `TrackUserPresence`

`opened(userId)` / `closed(userId)`：读 store → 算旧态 → 应用领域函数 → 写 store → 算新态 →
**仅当派生态翻转**时投进合并窗口。每次写入 store 时 **bump `generation`**（单调计数）。

**两枚独立定时器，各自的回调不共用**：

- `presenceGraceTimer` → `reapExpired()`：只保留一枚，指向 `pending` 集合里最早的 `graceUntil`；
  触发后回收到期项、投入合并窗口、有剩余则重新 arm，否则 clear。
- `presenceBatchScheduler` → `flushBatch()`：500ms 合并窗口；缓冲保存**窗口初态与末态**
  （只存末态判不出"净零变化"）；同 userId 取末态；净零不发；出口调 `observer.presenceChanged(changes)` 一次。
- 二者都可注入、生产实现 `unref()`。**无 deadline 且缓冲为空 ⇒ 两枚都不存在。**
- `observer` 抛错 ⇒ **先清缓冲再抛**，避免同一批重复发。

### 2.2 `GetUserPresence`

**零参** `snapshot()` / `stateOf(userId)`——clock 由 query 内部持有，杜绝调用方传 `Date.now()`
造成与 `graceUntil` 不同域（那会让宽限中的用户在快照里立刻变离线）。
`snapshot()` 同步纯内存读，规模 = 在线人数。

### 2.3 快照序列化缓存

缓存键是 **`(generation, validUntil)`**，其中 `validUntil = min(所有 pending 项的 graceUntil)`。
`now >= validUntil` 时**先物化到期状态并 bump generation**，再取快照——
只按 generation 缓存会发出"跨过宽限截止时间"的过期快照（五轮 W5-4）。
一次广播内所有连接复用同一份序列化结果（把 N 次序列化降到 1 次，§7.1）。

## 3. 通道 `/ws/presence`

### 3.1 注册表条目

shared 侧新增 `WS_PATHS.presence = '/ws/presence'` 与帧 schema；backend 侧在 RFC-152 注册表新增 kind
（三张类型表 `ChannelParamsByKind` / `ChannelMessageByKind` / `ChannelBroadcastContextByKind`(`never`) 同步）：

```ts
presence: {
  kind: 'presence',
  revalidation: {
    refreshActor: true,
    cache: { kind: 'none', why: 'no frameGate — whole-connection permission gate at upgrade' },
    rerunUpgradeGate: true,          // 权限被收回 ⇒ 关连接
  },
  helloName: () => 'presence',
  pathRe: /^\/ws\/presence$/,
  parse: () => ({ kind: 'presence' }),
  broadcaster: presenceBroadcaster,
  channelKeyOf: () => PRESENCE_CHANNEL,
  upgradeGate: async (_db, actor) =>
    actor.permissions.has('users:presence')
      ? true
      : { code: 'permission-required', message: 'presence channel requires users:presence' },
  onOpenExtra: async (ws) => { /* 同步取快照并发送，见 §3.3 */ },
}
```

**没有 `frameGate`**——整条连接在升级时就被权限门挡住了。这直接消除了 v1-v5 那条
"frameGate 会连坐过滤控制帧 / 会吃掉撤权帧"的问题类。

`rfc152-ws-paths-interlock.test.ts` 锁的是 WS_PATHS 与通道集的**双射**，新增一个通道 + 一条路径
保持双射成立；`rfc152-ws-channel-registry.test.ts:206-209` 的 `onOpenExtra` 穷举锁（当前只允许 task）
需**有意更新**为 task + presence。

### 3.2 权限变更：没有协议

| 方向 | 机制 | 说明 |
| --- | --- | --- |
| 被收回 | 既有 RFC-212 复核 `rerunUpgradeGate` ⇒ `closeConnection(4403)` | 前端 `usePermission('users:presence')` 随 `authority.changed` 翻转为 false ⇒ **不再重订阅**；store 因 transport close 清成"未知" |
| 被授予 | 前端 `usePermission` 翻转为 true ⇒ 订阅 hook 挂载 ⇒ 新连接 ⇒ `onOpenExtra` 发快照 | 服务端**零参与**，但"前端如何得知"必须有上界，见下 |

**授予方向的收敛必须有上界**（六轮 V6-2）：前端得知自己被授权，依赖的是 `authority.changed` 这条
**可能丢失**的控制帧（`sendJson` 的背压/fence 丢帧对控制帧同样适用）。若它丢了，用户直到下次
刷新页面才会订阅 presence。两条补丁把这个窗口封死：

1. **authority 控制帧的非正 send 结果 ⇒ 关闭该 authority socket**，用物理重连强制一次
   `/me` reconciliation。控制帧丢失本来就意味着"这条连接的权限视图已不可信"，关掉比留着强。
2. **presence 连接收到 4403 时，前端同步 invalidate `/me`**，并在刷新成功前**暂停该路径的重连**
   （避免拿着旧权限视图空转重连）。

这两条同时也修好了撤权方向的对称问题：无论哪个方向，前端权限视图的收敛都不再依赖单帧不丢。

**这就是独立通道最大的价值**：v1-v5 需要 `onActorRefreshed` / `previousActor` / revision CAS /
`presence.revoked` / `sendFencedDirect` / 每 pass 重发快照来模拟这两件事，全部不再需要。
连带地，`authority.changed` 帧丢失也不再影响 presence 正确性（W5-2 消失）——
最坏情况是前端晚一点知道自己失权，而**服务端已经把连接关了**。

### 3.3 observer → WS 的唯一接线（六轮 V6-3）

application 的 `userPresenceObserver` 与 WS 出站之间只允许一条接线，由 bootstrap 注入：

```ts
// infrastructure（bootstrap 注入，唯一实现）
class PresenceWsObserverAdapter implements UserPresenceObserver {
  presenceChanged(changes) {
    const encoded = JSON.stringify({ type: 'presence.changed', changes })   // 全局只序列化一次
    presenceBroadcaster.broadcast(PRESENCE_CHANNEL, { kind: 'prepared', encoded })
  }
}
// registry 侧：presence 通道的 listener 走 sendPreparedJson(ws, encoded, db)
//   —— 与 sendJson 同样先过 authorityRevisionCurrent fence，但**不重复序列化**
```

`sendPreparedJson(ws, encoded, db)` 是本 RFC 新增的发送出口，合同是：
**过 fence、不过 frameGate（本通道没有）、不重复序列化、返回 `send()` 的原始结果**供 §4 判 dirty。
快照走同一出口（§2.3 的缓存产出 `encoded`）。

### 3.4 帧

```ts
export const PresenceWsMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('presence.snapshot'), online: z.array(z.string()) }).strict(),
  z.object({ type: z.literal('presence.changed'), changes: z.array(
      z.object({ userId: z.string(), online: z.boolean() }).strict()).nonempty() }).strict(),
])
```

- `presence.snapshot`：`onOpenExtra` 里发一次。**取快照到 send 之间禁止 `await`**（同步临界区），
  这样前端"丢弃首个快照之前的 delta"才安全。须有一条 deferred-snapshot 反例测试锁死该约束。
- `presence.changed`：合并窗口出口广播。

## 4. 丢帧修复：dirty + drain

Bun 的 `ws.send()` **不抛错**——按 `bun-types@1.3.14 serve.d.ts:976` 返回
「**0 = 消息被丢弃**、-1 = 施加了背压、其余 = 字节数」，而 `sendJson` 忽略返回值
（`ws/registry.ts:1016-1023`）。于是背压丢帧是一条**既不抛错、不触发复核、也不关连接**的静默路径。

修复链（**只在真的失败时才动**，因此不构成放大）：

**入口**（哪些情况置 dirty，六轮 V6-4）：

- `sendPreparedJson` 返回 `-1`（背压）⇒ 置 dirty，等 `drain` 修复。
- 返回 `0`（消息被丢弃）或**抛错** ⇒ **不能等 drain**（这两种未必伴随背压，drain 可能永不触发）：
  直接 `closeConnection`，靠客户端重连拿新快照。
- 帧因 `ws.data.revalidating` 被短路丢弃时（`ws/registry.ts:940-951`）⇒ **同步置 dirty**。
  这条最容易漏：帧根本没走到发送出口，出口检查看不到它。

**出口**（何时修复）：

- `drain` 回调（注册在 **presence 通道 spec** 上，不是 server 通用旁路）；
- 该连接的下一次复核 pass 结束时若 dirty。

修复动作 = 重发当前快照并清位；**修复帧再失败** ⇒ 有限重试（上限 **3 次**，钉死在常量里）后
`closeConnection`。

丢帧路径与治愈对照：

| 丢帧原因 | 治愈 |
| --- | --- |
| 复核冻结（`ws.data.revalidating`）丢帧（`ws/registry.ts:940-951`） | 该 pass 结束时若 dirty ⇒ 重发 |
| 出站 revision fence 丢帧 | fence 丢帧会触发复核（`ws/registry.ts:1054-1056`）⇒ 同上 |
| 背压丢帧（send 返回 0/-1） | `drain` ⇒ 重发 |
| 连接断开 | 重连 ⇒ `onOpenExtra` 快照 |

**与 v4/v5 的关键差别**：修复由 **dirty 位**驱动，而不是"每次复核给每条连接无条件重发"。
后者正是 W5-5 放大的来源——一次 no-op 复核会给 3000 条连接各推 24KB。

## 5. 连接层接线

### 5.1 登记时机

`handleOpen` 既有顺序：`trackConnection` → 检查 epoch → 变了则 `reresolveActor`。
presence 登记须在 **epoch 复核通过 _且_ 用 fresh actor 重跑完整 `checkUpgradeGate` 之后**——
epoch 分支只重解析 actor，不重跑通道门；对本通道（有权限门）意味着授权可能已经失效。
失败 ⇒ close 且**永不登记**。

### 5.2 单调 lifecycle + 原子 install-or-release

同一连接的释放路径今天就会被调用两次：`closeConnection` 同步 untrack（`ws/connections.ts:120`）+
Bun close 回调里的 `handleClose`（`ws/server.ts:245`）。且客户端可能在 §5.1 的 `await` 期间就关闭，
此时 `handleClose` 先跑、句柄还不存在，await 返回后再登记就**永远不会被释放**。

```
open ──► closing ──► closed        （单调，只进不退；既有 ws.data.closing 并入）
```

- `closeConnection` 与 `handleClose` **都先推进终态**。
- `installPresence(ws, userId)` **只在状态仍为 `open`** 时装句柄，否则立即对消。
- 释放走**单次句柄**：`const r = ws.data.releasePresence; ws.data.releasePresence = undefined; r?.()`
  （先清后调，任何重入顺序下只执行一次）。

不变量：**每个 `opened()` 恰好对应一次 `closed()`**——既不双扣，也不永不释放。
userId 在登记时**捕获进闭包**，不在释放时从可变的 `ws.data.actor` 重读。

### 5.3 actor 单调性（最小守卫）

`revalidateAllConnections` 是 fire-and-forget、无 per-socket 队列（`ws/connections.ts:169` 自承
concurrent rescan），较早开始较晚完成的 pass 会把 `ws.data.actor` 覆盖回旧权限。
**这是既有 RFC-212 缺口**（所有通道的门都读这个可变 actor），但本通道的 `rerunUpgradeGate` 直接依赖它，
故本 RFC 承担一条最小守卫：**pass 在覆盖 actor 前比较 `authorityRevision`，低于已写入最大值则整个放弃**
（不覆盖 actor、不清 cache、不解冻、不调钩子）。

> 五轮 W5-1 指出：只写"低的放弃"会吞掉本该发生的解冻，socket 可能永久 `revalidating=true`。
> 因此守卫的完整形态是 **per-socket 单 worker + `requestedEpoch` / `processedEpoch`**。
> 六轮 V6-7 要求把它的合同写全，缺一条都会留洞：
>
> | 项 | 定论 |
> | --- | --- |
> | 状态 | 每 socket 持 `{ requestedEpoch, processedEpoch, running }`；触发只 bump `requestedEpoch` |
> | 循环 | worker 跑到 `processedEpoch === requestedEpoch` 才退出（dirty loop），**低结果只丢弃结果、不丢弃 pending 工作** |
> | 解冻所有权 | 只有处理到**最新** requested epoch 的那一轮负责清 `revalidating`；中途轮次不清 |
> | equal revision | `freshActor.authorityRevision` **等于**已处理最大值时**照常应用**（同一 revision 的重复 pass 是幂等的，丢弃会漏掉 `rerunUpgradeGate`） |
> | awaited-tail | `triggerRevalidationAndWait` 必须等到**该 commit 之后启动**的那一轮完成——不能被一个更早开始的 in-flight 轮次冒领，否则调用方以为"复核已完成"而实际读的是旧成员集 |
> | 全通道合同 | 该 worker 对**所有通道**生效（它改的是 `revalidateAllConnections` 本身）；须有一条非 presence 通道（如 task）的回归测试证明其复核语义不变 |
>
> 这一条落在 `ws/connections.ts`，属于对既有复核机制的加固——**呈用户确认为本 RFC 的承担范围**。

## 6. 权限点 `users:presence`

### 6.1 唯一真值表（文档 / AC / 测试一律引用本表）

| 角色 | 新建默认授予 | 可被授予 | 可被收回 | 默认可见在线点 |
| --- | :---: | :---: | :---: | :---: |
| `admin` | 否（**由全量动态 baseline `admin: [...PERMISSIONS]` 自动包含**） | 否（grantable 排除 baseline） | 否 | **是** |
| `manager` | **是** | 是 | 是 | 是 |
| `user` | **是** | 是 | 是 | 是 |
| `guest` | 否 | 是（显式授予） | 是 | 否 |

存量 backfill 行集 = `role IN ('user','manager')` 且 `id != '__system__'`。

### 6.2 发放与审计同源

纯策略 `initialGrants(role): InitialGrantSpec[]` 由上表驱动，其中

```ts
interface InitialGrantSpec { permission: Permission; origin: 'system-default' | 'explicit'; grantedByUserId: string | null }
```

**provisioning 全程携带这个带 provenance 的列表**（六轮 V6-1：只传一个 permission 数组，
系统默认与操作者显式授予在落库那一刻就不可区分了）。写 grant 行、写
`user_access_audit.added_permissions_json` 都用它；**只有 view / observer 需要的"最终权限集合"
才允许把它压成 union**。

**必须覆盖所有建号入口**：`createManagedUser` **不是唯一入口**——OIDC 自助建号走
`services/userIdentities.ts:134-184` 的 `createUserWithIdentity → insertInitialUserAccessInTransaction`
（当前只插 user/audit、不插 grants，`sqliteUserAccessRepository.ts:141-164`），bootstrap admin 同一 participant。
故策略落在 identity-access 的**统一 provisioning seam**，三条路径共用。

### 6.3 权限点登记

`PERMISSIONS` 闭集 + `catalogEntry('users:presence', { group: 'platform', token: 'never' })`
+ `SYSTEM_DOMAIN_POINTS`（PAT 永不持有）。措辞必须精确（六轮 V6-1）：
**不进入 `user` / `manager` / `guest` 的静态 preset；`admin` 由全量动态 baseline
`admin: [...PERMISSIONS]`（`permission.ts:1059`）自动包含**——写成"不进任何预设"是错的，
会被 admin 那一格当场推翻，也正是测试合同反复与真值表打架的根源。
前台 i18n：`permissionCatalog.ts` 的 `EN_ACTIONS`/`ZH_ACTIONS` 新增 action `presence`（两表都
`satisfies Record<PermissionAction, string>`，漏一处编译红）+ catalog label/description。

## 7. 容量与滥用收敛（G7）

### 7.1 快照放大预算

一次广播的成本 = `订阅连接数 × (1 次 fence 读 + 1 次 send)`，序列化按 §2.3 缓存后全局只做一次。
1000 在线 / 3000 标签页、每人一条 presence 连接：单份快照约 900×27B ≈ 24KB，
一次全量快照广播 ≈ 3000 × (1 读 + 24KB) ≈ 72MB。**因此 v6 不做"每次复核无条件重发"**——
快照只在 ①连接建立 ②dirty 修复 两种情况下发送，二者都不是普通用户可高频触发的。

### 7.2 稳态帧量

翻转率按每人每天 20 次估：1000 人 / 3000 连接 ⇒ 约 0.23 次/秒 × 3000 ≈ **700 次 send/秒**
（每次 = 1 次 fence 读 + 小 JSON），合并窗口把突发压平。100 人 / 300 连接 ⇒ 约 7 次/秒。

### 7.3 两条源头收敛（五轮 W5-5）

1. **成员集未变的写不触发复核**：`services/taskCollab.ts:255` 的
   `triggerRevalidationAndWait('task-members-changed')` 当前**无 target**，
   任何能改自己任务成员的用户重放 no-op 写即可触发全量复核。

   修法必须在**同一个 `dbTxSync` 内**比较（六轮 V6-6）：在事务外先读一遍再决定要不要进事务，
   是个 TOCTOU——并发写可能在比较与返回之间改掉成员集，于是**该发的复核被跳过**。
   且"集合相同"必须定义规范化语义：比较对象是 **`(ownerUserId, 排序去重后的 collaborator id 集合)`**，
   **owner 转移算变更**。事务内比较相同 ⇒ 不写、不触发复核；不同 ⇒ 照常写并触发。
   （AC-23 红→绿：修复前 no-op 写会触发复核。）
2. **每用户 `/ws/presence` 连接配额**：单账号脚本化开 K 条 socket 会线性放大所有广播成本
   （K=1000 时初始快照约 24MB）。

   > **配额不能塞进 `upgradeGate`**（六轮 V6-5）：该门是 `rerunUpgradeGate: true` 的，
   > 复核时会**对已建立的连接重跑**——用它做配额意味着"复核一次就重新数一次名额"，
   > 已经在线的连接会因为自己占着名额而被自己的门踢掉。
   >
   > 正解是独立的 **`PresenceAdmissionLease`**：握手期间**原子 reserve**（pending + open 一起算），
   > 并在三条路径上**各释放一次且只释放一次**——升级失败、连接关闭、以及 §5.2 的
   > close-before-install。租约与 §5.2 的 lifecycle 三态共用同一个状态机，不另立第二套真相源。
   >
   > 具体数值：**每用户上限 Q = 8 条**（够一个重度用户开多标签页 + 少量陈旧连接），
   > 外加**每用户升级速率 30 次/分钟**。超限拒绝且**不影响既有连接**。
   > 两个数字都写进常量并由 AC-24 断言，不做成配置项（可配置只会让容量预算失去意义）。

> **未纳入本 RFC**：把 `task-members-changed` 改成 targeted 复核、以及对复核触发做 per-actor 限速。
> 两者都是 RFC-212 机制的改造、收益覆盖全部通道，建议独立 RFC；本 RFC 只做上面两条**源头**收敛
> 并把连接账写清（§8）。

## 8. 成本核算

### 8.1 连接账（本方案的净增量）

| 事件 | 既有开销 | 出处 |
| --- | --- | --- |
| 一次 WS 升级（成功 session 的 `tryUpgrade` 认证段） | **5 读 + 2 写** | `resolveActor`（`ws/server.ts:134`）2 读 + 1 写 + 权限快照 1 读；`buildWsCredential`（`:200`）对同一 token **再来** 2 读 + 1 写 |
| 全量复核，**每条** live 连接 | **3 读**，串行 | `reresolveActor`（`ws/connections.ts:159`，`touch:false`） |
| 复核触发点 | **7 个** | `resourceAcl.ts:750`、`sessionStore.ts:175/189`、`patStore.ts:184`、`userIdentities.ts:316`、`loginPolicy.ts:264`、**`taskCollab.ts:255`** |

**净增量**（100 人 × 3 标签页 = 300 连接）：建连一次性 +1500 读 +600 写；每次全量复核 +900 读（串行）。
这是选独立通道**明知要付**的账——用它换掉了五轮未收敛的协议复杂度与 W5-5 放大面。
§8.3 的 T0 可把升级成本降到 3 读 1 写，使净增量减半。

### 8.2 帧账（既有出站 fence）

`gatedSubscribe` 通过后走 `sendJson`，它**无条件**先跑 `authorityRevisionCurrent` ——
一次同步 `SELECT status, access_revision FROM users WHERE id = ? LIMIT 1`（`ws/registry.ts:1015-1035`）。
这是 RFC-305 的出站权威 fence，**不能绕过**。于是 presence 的 DB 成本 = **每帧每订阅者一次主键点查**
（量级见 §7.2）。用户已明确接受该成本；镜像化另立 RFC。

### 8.3 顺手修既有浪费（T0，可摘）

`buildWsCredential` 对同一 token 重跑 `lookupActiveSession`（`ws/server.ts:196-200` 的注释自己写着
"Computed from the same token resolveActor just consumed"）。复用已解析的 session 后
**每次升级 5 读 2 写 → 3 读 1 写**，对所有 WS 连接生效。与 RFC-311 无重叠。

## 9. 前端

### 9.1 订阅与 store

```
AppShell（routes/__root.tsx:114）
  └── usePresenceSubscription()          // 仅当 usePermission('users:presence')
        └── useWebSocket({ path: WS_PATHS.presence })
              └── module-level store { hydrated, onlineIds }
                    └── useSyncExternalStore → usePresenceOf(userId)
```

- `usePresenceOf` 返回 `boolean | undefined`：`!hydrated ⇒ undefined`（未知，不渲染点）；
  `hydrated && has ⇒ true`；`hydrated && !has ⇒ false`（**确定的离线**）。
  没有 `hydrated` 这一维就无法同时表达"离线"与"未知"。
- `presence.snapshot` ⇒ `hydrated=true` 并整体替换；`presence.changed` ⇒ 增量；
  **首个快照之前的增量丢弃**。
- **reset 的归属**：`authSessionRevision` 变化（`stores/auth.ts:20-29,69-89`）与**物理连接生命周期**
  （transport close / **最后一个订阅者 release**）。**不挂任一 hook 实例的 cleanup**——
  `useWebSocket` 是多订阅者共享同一物理连接的（`hooks/useWebSocket.ts:127-139`），
  按 hook 卸载 reset 会清掉别人还在用的 store。
- 帧解析按 discriminant 分流；`hello` 忽略。**不得**对所有帧无脑 `PresenceWsMessageSchema.parse`。
- `usePresenceOf` 对 `null` / `undefined` / `'local'` / `'__system__'` 及未解析 id **返回 `undefined`**，
  与 `hooks/useUserLookup.ts` 的 `SENTINELS` 共用同一常量集——否则水化后历史值会显示成"离线"。

### 9.2 唯一渲染原语 `components/PresenceDot.tsx`

`online === undefined ⇒ 渲染 null`（无权限 / 未水化时界面与今天逐字节一致）；
`role="img"` + `aria-label`；`.presence-dot` 命名空间，圆点尺寸对齐 `StatusChip withDot`。

### 9.3 五处接线

| 界面 | 文件 |
| --- | --- |
| 用户管理页 | `components/users/UserDirectory.tsx:181-198`（最后登录那一格前；**文案与排序不变**） |
| 全站署名 chip | `components/AttributionChip.tsx:25-50` |
| 任务成员面板（只读分支） | `components/tasks/TaskMembersPanel.tsx:244-253` |
| 任务成员面板（可管理分支） | `components/UserPicker.tsx:187-224`——加可选 adornment render prop（最小扩展） |
| 工作组花名册 | `components/workgroup/room/RoomSideCards.tsx:70-115`，仅 `memberType==='human'` 且有 `userId` |

**明确不接线**：`components/OwnerLabel.tsx`（列表行 owner 列，视觉噪声且与虚拟化叠加收益最低）。

## 10. 失败模式

| 场景 | 行为 | 依据 |
| --- | --- | --- |
| 刷新 / 跳转 / 宽限内重连 | 无帧、无闪烁 | §1 状态表末行 |
| 短暂断网 | 退避重连（500ms→30s，`hooks/useWebSocket.ts:47-48`），宽限内重连观察者无感 | — |
| 硬断（无 FIN） | 判死后进宽限 | `websocket.idleTimeout: 120` + `sendPings: true` 显式写死（= Bun 当前默认 `serve.d.ts:447-466`，零行为变更）；总上界 180s |
| 停在 `/auth` / `/setup/admin` | 显示离线 | 走 BareShell，无 AppShell 无连接 |
| daemon 重启 | 显示**未知（无点）**，重连后快照重建 | §9.1 |
| 权限被收回 | `rerunUpgradeGate` 关连接（4403），前端不再重订阅 | §3.2 |
| 权限被授予 | 前端 `usePermission` 翻转 ⇒ 订阅 ⇒ 快照 | §3.2 |
| 背压 / fence / 冻结丢帧 | dirty + drain / 下一 pass 修复；修复再失败 ⇒ 关连接 | §4 |
| 同连接双重释放 / 释放前先关 | 单调 lifecycle + 原子 install-or-release | §5.2 |
| 系统时钟回拨 | 无影响 | §1 单调时钟 |
| 普通用户重放 no-op 成员写 | 不再触发复核 | §7.3 |
| 单账号大量开连接 | 超配额拒绝 | §7.3 |
| 在线名单进 prompt | 禁止 | AC-12 双锁 |

## 11. 实现合同（歧义按本节解释）

| # | 定论 |
| --- | --- |
| C1 | presence 依赖进入全局复核：由 `composition.ts` 在 bootstrap 调 `registerRevalidationTrigger`，**闭包捕获** presence command/query；`RevalidateDeps` 同步扩为 `{db, log, presence}`。**不**塞 `WsConnectionData`、**不**设模块级全局单例。测试重复构建 adapter 时注册是 **replace 语义**并提供 `resetRevalidationTriggerForTest()` |
| C2 | 复核 pass 顺序：`reresolveActor` → **revision 守卫**（§5.3）→ 覆盖 actor → 清 cache → `rerunUpgradeGate` → 清 `revalidating` → 若 `presenceDirty` 则重发快照 |
| C3 | 取快照到 send 之间**禁止 `await`**（同步临界区）；`snapshot()` 同步纯内存读；须有 deferred 反例测试 |
| C4 | `opened()` **同步**返回 release 句柄；`installPresence` 同步且只在 lifecycle 为 `open` 时装；helper 落在 `ws/connections.ts` |
| C5 | 时钟由 query 内部持有，对外零参；domain 仍以 `now` 入参保持可测 |
| C6 | 两枚 timer 对应 `flushBatch()` 与 `reapExpired()` **两个不同回调**；batch buffer 持于 `TrackUserPresence` 实例；observer 抛错先清缓冲再抛 |
| C7 | provisioning 见 §6.2；migration 用 `INSERT OR IGNORE` 幂等；调用方显式传入的 additionalPermissions 与默认取**并集** |
| C8 | 前端 store 唯一喂帧者是 AppShell 的 owner hook；reset 源见 §9.1；`getSnapshot` 返回稳定引用 |
| C9 | `drain` 注册在 **presence 通道的 spec** 上（不是 server 通用旁路）；修复按 `connection+generation` 合并；修复失败有限重试后关连接 |
| C11 | **可观测性字段**（六轮 V6-8）：受保护的按用户/连接诊断至少含——权限侧 `effectivePermissions` / `socket actor revision` / `最近 authority revision`；登记侧 `presence refcount` / `graceUntil` / `generation` / open·close·reap 计数与最后原因；交付侧按帧类型的 `sent/dropped(0)/backpressured(-1)/threw/drain/repair{ok,fail}` 计数；复核侧 `passId/reason/requestedEpoch/processedEpoch/coalesced/freezeDuration`；客户端侧支持包含 `authGeneration/socketState/lastControlRevision/lastSnapshotGeneration/lastResetReason`。**普通日志只记连接 id 与计数，完整 roster 只出现在受保护诊断入口** |
| C12 | **`PresenceAdmissionLease` 与 lifecycle 共用同一状态机**（§7.3）：reserve 发生在 handshake，释放挂在 `open → closing → closed` 的终态推进上，**不另立第二套真相源**；三条释放路径（升级失败 / 关闭 / close-before-install）各释放一次且只一次 |
| C10 | 贯穿链测试用 **e2e**（`e2e/` 既有 Playwright + 真 daemon）：两个浏览器上下文、两个用户，断言点出现/消失。**不得**拆成两个 mock-heavy suite。起真 daemon 时 `waitForReady` 须同时捕获 **stderr**（既有实现只读 stdout，崩溃原因会被吞掉） |

## 12. 测试策略

**shared**：①`users:presence` 在闭集、有 catalog、`token:'never'`、**不在任何预设**；
`grantableAdditionalPermissions` 对 user/manager/guest 含它、对 **admin 不含**。
②帧 schema 两变体正反例；③`WS_PATHS.presence` 与通道双射（interlock 测试自动覆盖）。

**domain**：④§1 状态表逐行 + `now===graceUntil` 边界 + 零计数重复 close 幂等；
⑤单调时钟——**同时注入 wall 与 monotonic**，wall 前跳/后跳行为不变，只有单调推进才到期。

**application**：⑥仅翻转才入窗口；⑦合并窗口**精确帧数与载荷** + 499/500ms 边界 + 净零不发 + 初末态缓冲；
⑧两枚 timer 正反向 + 各自 `unref()` 断言；⑨`pending` 索引在 open/reopen/reap 后一致；
⑩快照缓存键含 `validUntil`——延迟 reaper、截止后先取快照必须先物化到期状态。

**WS**：⑪无权限升级被拒（`permission-required`）且不影响其它通道；
⑪b 授予方向闭合（V6-2）：authority 控制帧非正 send 结果 ⇒ 关 authority socket；
presence 收 4403 ⇒ 前端同步 invalidate `/me` 且刷新成功前不重连；⑫有权限 ⇒ hello 后立即收快照；
⑬收回权限 ⇒ `rerunUpgradeGate` 关连接（4403）；⑭PAT / daemon 不计入在线；
⑮lifecycle 三态两条关闭路径 + 正向控制（open 后 `connections===1`，close 后归零）；
⑯epoch + 完整 gate 后才登记 + 正向控制；⑰per-socket worker 合同（§5.3 表逐行）：两 pass 反向完成、**解冻只由最新轮次负责**、
**equal revision 照常应用**、`triggerRevalidationAndWait` 等到该 commit 之后启动的轮次、
**外加一条非 presence 通道（task）的复核语义不变回归**；
⑱丢帧修复两端：入口——`-1` ⇒ dirty 等 drain、`0` 与抛错 ⇒ **直接关连接**（不等 drain）、
帧被 `revalidating` 短路 ⇒ **同步置 dirty**；出口——`drain` 与下一 pass 各修复一次、
**修复帧再失败 ⇒ 重试上限 3 次后关连接**；
⑲零 DB：模块 import 面 + spy 双向，并用真实 `gatedSubscribe → sendJson` 的 SQL spy 断言
fence 读次数 = 帧数 × 订阅者数；⑳既有测试的**有意更新**：`onOpenExtra` 穷举锁扩为 task + presence。

**容量与滥用**：㉑成员集未变的写**不触发复核**——比较在**事务内**、规范化为
`(ownerUserId, 排序去重的 collaborator 集)`、**owner 转移算变更**（红→绿 + 并发写不被跳过的用例）；
㉒`PresenceAdmissionLease`：Q=8 生效、超限拒绝**不影响既有连接**、三条释放路径各释放一次
（含 close-before-install）、复核重跑**不会**把已在线连接踢掉（这是 V6-5 的核心回归）、速率限制 30/min；
㉓容量数字断言（AC-25）。

**provisioning**：㉔按**每个入口实际可达的角色**列矩阵（不构造不可达格），逐格对齐 §6.1；
grant 行与 audit 同源；系统默认与显式授予归因可区分。

**贯穿链**：㉕e2e 真链（AC-1）；㉖撤销全链——禁用账号 与 撤销 session 各一条，均先断言在线再断言离线。

**前端**：㉗`PresenceDot` 三态 + `aria-label`；㉘store `hydrated` 四象限 + 快照前增量丢弃；
㉙reset 归属——**两订阅者卸载其一 store 不被清空**（反例）+ auth revision 变化 + transport close；
㉚五处接线各一条（含 `UserPicker` 可管理分支）；㉛花名册共存；㉜`/users` 出现点且最后登录文案与排序不变。

**隔离**：㉝prompt 关键字扫描 + forbidden-import 断言。

**可观测性**：㉞AC-26 的诊断面存在、字段齐全（见 §11 C11）且**普通日志不含完整 roster**；
构造"在线但显示离线"的四种成因各一次，断言诊断面能**唯一区分**它们。

## 13. 偏离项与债务

**偏离项（呈确认）**

- 新增一个 WS 通道（RFC-152 注册表的正常扩展）；**不改任何既有通道的声明**。
- 对既有复核机制加固：actor revision 守卫 + per-socket epoch 所有权（§5.3）——
  这是既有 RFC-212 缺口，本 RFC 因依赖它而承担最小修复。
- 修改 `services/taskCollab.ts` 的成员写路径（no-op 不触发复核，§7.3）。
- 显式钉死 `websocket.idleTimeout`（影响所有 WS 连接的判死行为，值 = 当前默认故零行为变更）。
- presence 状态进程内易失、不入库。

**债务**

1. authority fence 内存镜像化（已交接 RFC-311 登记）。
2. `task-members-changed` 改 targeted 复核 + 复核触发 per-actor 限速（独立 RFC）。
3. 隐身开关；4. 自定义 WS 心跳；5. `OwnerLabel` 列表行接线。

## 14. 五轮设计门与本版取舍

| 轮次 | findings | 本版处置 |
| --- | --- | --- |
| 一轮 | 15 条：核心是「零 DB」不成立、权限模型不可收回、AC 大面积不可证伪 | §8.2 如实记账；§6 显式 grant；proposal §8 全部 AC 带正向控制 |
| 二轮 | N1-N7：admin 例外、OIDC 建号绕过、边沿判定竞态、撤权帧被自己 gate 吃掉、假上线、账号切换泄漏、idleTimeout 无值 | §6.1/§6.2、§5.1/§5.2、§9.1、§10 |
| 三轮 | R3-1…R3-7 + I1-I10：冻结期丢帧、交付状态、完整通道授权、lifecycle、真值表、审计同源、reset 归属 | §4、§5.1、§5.2、§6.1、§6.2、§9.1、§11 |
| 四轮 | V4-1…V4-6：`send()===0` 静默丢帧、actor 单调性、客户端状态机、装配路径、容量低估、三件套互斥 | §4、§5.3、§3.2（协议消失）、§11 C1、§7.1、**本版重写** |
| 五轮 | W5-1…W5-7：解冻所有权、控制帧丢失、drain 链不闭合、缓存跨越 grace、**普通用户放大**、合同互斥、无可观测性 | §5.3、§3.2（不再依赖控制帧）、§4、§2.3、**§7.3**、**本版重写**、AC-26 |

**本版最重要的一条取舍**：五轮里有六条 P1（F3/N3/N4/V4-3/W5-2/W5-5）全部来自"把 presence 挂在
authority 通道上以省一条连接"。独立通道用一笔**可计算、有上界**的连接成本（§8.1）
换掉了这一整簇——**这是本 RFC 从五轮门里学到的主要东西**。
