# RFC-212 — 技术设计（v2，按设计门裁决重写）

> v1 的选型（全局 epoch + 帧投递前惰性复核）被设计门判定为**不可实现**：它要把一次异步复核塞进同步的广播扇出。
> 完整裁决见 [`design-gate-review.md`](design-gate-review.md)。本文是据此重写的版本；v1 的取舍记录保留在 §9。

## 1. 机制选型

| 方案 | 触发时机 | 帧路径改动 | 结论 |
| --- | --- | --- | --- |
| A. 每帧重新 `resolveActor` + 重跑门 | 每帧 | 大 | 否：每帧 ≥2 SELECT + 1 UPDATE，推翻 RFC-054 W2-4 的性能前提 |
| B. 撤销时按「用户→连接」「任务→连接」反向索引精确定位 | 撤销时 | 无 | 否：每类撤销各自维护索引，正是「28 格靠人记得」 |
| C. 全局 epoch + 帧投递前惰性复核 | 下一帧 | **大** | **否**（v1 选它，设计门推翻）：`broadcaster.ts:46-59` 是同步 for-of，`registry.ts:586` listener 是同步回调，`registry.ts:587-594` 的 admin 短路与无 frameGate 通道是**同步 send**；插入异步复核会改变投递语义并直接撞红 `tests/rfc152-ws-channel-registry.test.ts:277`（`no frameGate ⇒ every frame forwards`）与 `:290`（`adminShortCircuit sends synchronously`，注释写明「Synchronous — visible before any await」）。且它无法关闭**静默连接**（见 §2 的 AC-3 口径问题） |
| **D. 进程级连接集合 + 撤销时异步全量重扫**（选定） | 撤销时 | **零** | 是：复核跑在撤销方自己的 async 上下文里，帧路径一行不改 ⇒ 同步投递语义完全保持、AC-6「无撤销时零额外查询」由构造成立、静默连接也能被真正关闭 |

**为什么 D 不是 B**：B 的成本来自「精确定位」——要知道哪条连接受哪次撤销影响。D 和 C 一样是**粗粒度**的（任一撤销让所有连接各复核一次），因此只需要**一张平表**，零反向索引、零按撤销类别的分支。撤销方的负担与 C 完全相同（C 是 `bumpAuthEpoch()`，D 是 `revalidateAllConnections(reason)`）。

**落地钩子已全部就位**（设计门逐条复核）：

- `ws/server.ts:150-157` `handleOpen` / `:159-167` `handleClose` —— 增删连接集合的两个钩子已存在，`handleClose` 里已经在做 `unsubscribe()`
- `ws/registry.ts:558-566` `checkUpgradeGate(db, actor, params)` —— 已经是导出的、**通道无关**的复核入口
- `ws/registry.ts:587` / `:598` —— listener 在**帧到达时**才读 `ws.data.actor`，所以就地替换 actor 立即生效，不需要重新订阅

## 2. 数据流

```
HTTP 撤销写入点（事务提交之后）
  └─ await revalidateAllConnections(reason)      ← 跑在撤销方的 async 上下文里
        对每条连接并发（有上限）执行：
          ① lookupByCredential(ws.data.credential)     只读，不写 last_used_at
          ② null / user.status !== 'active' → close(4401) 并 return
          ③ ws.data.actor = freshActor                 ← 让 admin 短路与 permissions 重新生效
          ④ ws.data.visibilityCache.clear()            ← 仅对真正有缓存的通道有意义
          ⑤ 该通道声明 rerunUpgradeGate 时 → checkUpgradeGate；不过则 close(4403)
广播路径：一行不改（同步 for-of + 同步 send 全部保持）
```

**关闭前必须同步置位并退订**：`closing = true` + `ws.data.unsubscribe()` 在调用 `ws.close()` **之前**同步执行。`broadcaster.broadcast` 是同步 for-of（`broadcaster.ts:46-59`），而 `handleClose` 是异步到达的；不先同步退订，close 与 close 回调之间到达的帧仍会被投递（设计门 correctness 视角）。

## 3. 接口契约

### 3.1 `src/ws/connections.ts`（新）

```ts
/** 进程级活跃连接集合。handleOpen 加入，handleClose 移除。 */
export function trackConnection(ws: ServerWebSocket<WsConnectionData>): void
export function untrackConnection(ws: ServerWebSocket<WsConnectionData>): void
/** 撤销发生后重扫全部连接。并发有上限，失败的单条连接以 fail-closed 关闭。 */
export async function revalidateAllConnections(deps: RevalidateDeps, reason: RevocationReason): Promise<RevalidateStats>
export type RevocationReason =
  | 'session-revoked' | 'sessions-revoked-bulk' | 'pat-revoked' | 'identity-deleted'
  | 'user-patched' | 'user-disabled'
  | 'task-members-changed' | 'resource-acl-changed'
```

`reason` 只进日志与测试断言，不参与逻辑——但它让「新增一类撤销」成为一次显式的类型扩展。

### 3.2 `WsConnectionData` 扩展

```ts
interface WsConnectionData {
  channel: ChannelParams
  /** 可变：唯一写入点是 revalidateAllConnections 的步骤③。 */
  actor: Actor
  /** 复核用的凭据指纹。**绝不保存原始 token**。 */
  credential:
    | { kind: 'session' | 'pat'; hash: string; expiresAt: number | null }
    | { kind: 'daemon' }
  /** 置位后 listener 立即短路，防 close 在途帧。 */
  closing: boolean
  unsubscribe: () => void
  visibilityCache: Map<string, boolean>
}
```

> **v1 的错误**：v1 打算保存原始 token，理由是「按 id 复核要给两种凭据各写一条查询」。设计门证伪：`sessionStore.ts:88-89` 与 `patStore.ts:78-79` 本来就是 `where(tokenHash = …)`，存 hash 走的是**同一条查询**；而 `util/log.ts:141-148` 的 `formatVal` 对任意对象无条件 `JSON.stringify` 且全仓无脱敏白名单，任何一次「调试打印 ws.data」都会把明文长期凭据写进日志。改存 hash 后配一条源码锁：`WsConnectionData` 上不得出现任何原始凭据字段。

**自然过期**（`sessionStore.ts:93` / `patStore.ts:83` 是纯时间判定、没有写入点可挂钩）：把 `expiresAt` 记在 `credential` 上，投递前做一次**纯内存**比较即可关闭——零查询，不破坏 AC-6。

### 3.3 只读复核入口

复核**不得产生写**。现有 `lookupActiveSession` / `lookupActivePat` 在成功后各写一行 `lastUsedAt`（`sessionStore.ts:100` / `patStore.ts:89`）；粗粒度重扫下这会变成「任一次 ACL 编辑 → 全部连接各写一行」的写放大，并污染 `/account` 页展示的 last-used 审计信号。抽 `lookupActiveSessionByHash(db, hash, { touch: false })` / `lookupActivePatByHash(...)`（查询体不变，仅跳过 UPDATE；`patStore.ts:31` 的 `hashToken` 需导出）。

### 3.4 `ChannelSpec` 增加**必填**复核维度

```ts
export interface ChannelRevalidation {
  /** 恒为 true —— actor 替换是所有通道生效的前提，写成必填常量而非可选，防止漏填。 */
  readonly refreshActor: true
  /** 该通道是否真的持有 per-connection 缓存，以及清哪些前缀。 */
  readonly cache:
    | { readonly kind: 'none'; readonly why: string }
    | { readonly kind: 'prefixes'; readonly prefixes: readonly string[] }
  /** epoch 变化后是否重跑 upgradeGate。无门的通道必须写明理由。 */
  readonly rerunUpgradeGate: boolean | { readonly na: string }
}
```

挂到 `WS_CHANNELS`（`registry.ts:330-332` 本就是 mapped type，已具穷尽性）后，新增通道不表态即**编译失败**；可执行形式用一条 `@ts-expect-error` 反向锁（仓内已有范式：`rfc080-parametric-runtime-migration.test.ts:132`、`rfc080-output-kind-ui.test.ts:77`）。

**七个通道的实际取值**（设计门逐条核对源码后更正——v1 的 proposal §1 表把 `memories` / `scheduled-tasks` 写成「缓存永不失效」是**事实错误**，它们根本没有缓存）：

| 通道 | cache | rerunUpgradeGate | 陈旧点 |
| --- | --- | --- | --- |
| `task` | `none`（无 frameGate） | `true`（`taskVisibleTo`） | upgrade 时的一次性门 |
| `tasks-list` | `prefixes: ['']`（裸 taskId 键） | `false`（无门） | 缓存里存的 `true` + `actor.permissions` |
| `workflows` | `prefixes: ['wf:']` | `false` | 缓存 + `adminShortCircuit` 读的 `actor.user.role` |
| `repo-import` | `none` | `{ na: 'RFC-152 D4 遗留：本通道无任何门' }` | 仅受凭据有效性约束（batchId 是可传播的 bearer 串） |
| `memories` | `none`（`registry.ts:436-437` 注释：RFC-045 的编辑会让行跨 scope 移动，故**刻意不缓存**） | `false` | **冻结的 actor**（`adminShortCircuit`） |
| `memory-distill-jobs` | `none` | `true`（admin-only 门） | upgrade 时的一次性门 |
| `scheduled-tasks` | `none`（纯内存判断） | `false` | **冻结的 `actor.permissions`** |

## 4. 撤销写入点接线（设计门更正后）

| 写入点 | 文件:行 | reason | 备注 |
| --- | --- | --- | --- |
| `revokeSession` | `auth/sessionStore.ts:115` | `session-revoked` | |
| **`revokeAllSessionsForUser`** | `auth/sessionStore.ts:123` | `sessions-revoked-bulk` | **v1 漏了**。改密（`routes/auth.ts:119`）与重置密码（`users.ts:106`）只走它，不经过 `revokeSession` —— 正是 proposal §2 卖的「凭据泄漏」应急流程 |
| `revokePat` | `auth/patStore.ts:107` | `pat-revoked` | |
| `deleteIdentity` | `services/userIdentities.ts:77` | `identity-deleted` | 不触碰 session/PAT，bump 仅为保守 |
| **`patchUser`** | `services/users.ts:180` | `user-patched` | **v1 写的 `updateUser` 在仓里不存在**。`users.ts:230-231` 同时写 `role` 与 `status`，是角色降级**与** Web UI 停用的共同路径，且它不像 `disableUser` 那样顺带吊销会话 ⇒ 必须**无条件**接线，不能只挂 role 分支 |
| `disableUser` | `services/users.ts:132` | `user-disabled` | |
| `updateTaskMembers` | `services/taskCollab.ts:130` | `task-members-changed` | |
| `updateResourceAcl` | `services/resourceAcl.ts:313` | `resource-acl-changed` | |

**位置硬约束：必须在写入提交之后。** `updateTaskMembers` 在真正写库（`taskCollab.ts:179` `dbTxSync`）之前有两个 `await` 让出点（`:145` / `:165`），`updateResourceAcl` 同型（`:321` await → `:335` dbTxSync）。若在函数开头触发重扫，复核会读到**尚未提交的旧数据**、判定仍可见，此后再无触发 ⇒ **永久漏检**，且自然用例几乎不可能复现。

落地方式选**包装器**而非纪律：`await commitAndRevalidate(db, reason, () => dbTxSync(...))`，让「先提交后重扫」成为唯一可写法。

## 5. 关闭语义与前端

- 凭据失效 / 过期 → `close(4401, 'auth-revoked')`
- 凭据有效但该通道不再可见 → `close(4403, 'not-visible')`

**v1 说「不需要前端改动」是错的**：`hooks/useWebSocket.ts:186` 的 close 监听器签名是 `ws.addEventListener('close', () => {…})`，**不接 event 参数，关闭码今天读不到**；`getToken()`（`:137-143`）在 4401 后仍返回死 token，界面零提示（`api/client.ts:218` 只在 HTTP 401 才 `clearToken`），结果是每 30s 一次静默无效重连。

（v1 担心的「4401 触发 500ms 定频重连风暴」被设计门证伪：重连要 `open` 才会重置退避，而失效凭据的重连在 `server.ts:116` 就 401、不会 `open`，退避正常涨到 30s 封顶。真正要改的是**用户可见性**，不是退避。）

因此前端必须改两点：读 `e.code`；`4401 → clearToken() + 提示重新登录`。

## 6. 失败模式与防护

| 失败模式 | 防护 |
| --- | --- |
| 新增撤销路径忘了接线 | **写入面级**源码棘轮（不是函数体级）：凡 `db.update(users\|userSessions\|userPats)` 且 set 含 `role\|status\|revokedAt`，以及一切写 `taskCollaborators` / `resource_grants` 的语句，其所在函数必须走 `commitAndRevalidate` —— 新增写入点默认变红。v1 的「函数体含调用」粒度**粗于漏洞粒度**（`patchUser` 只在 role 分支接线时照样绿） |
| 新增通道忘了声明复核策略 | `ChannelSpec` 必填字段 + mapped type 编译期强制 + `@ts-expect-error` 反向锁 |
| 复核在事务提交前触发 | `commitAndRevalidate` 包装器 + 一条「在 await 让出点人为 yield 时投递帧」的用例 |
| upgrade 与撤销并发（TOCTOU） | 连接在 `trackConnection` **之后**才开始收帧；`handleOpen`（`server.ts:150-157`）先 track 再 subscribe。若重扫在 track 之前完成，该连接的 actor 是刚解析的、必然新于本次撤销 |
| close 与退订之间的在途帧 | `closing` 标志同步置位 + 同步 `unsubscribe()`（§2） |
| 复核自身产生写 | AC：复核路径不得产生 `user_sessions` / `user_pats` 写入（计数断言） |
| 静默连接（AC-3 口径） | 方案 D 天然覆盖：重扫不依赖帧到达 |

## 7. 测试策略

**必写用例**：

1. `ws-revocation-matrix.test.ts` —— 表驱动遍历 `WS_CHANNELS` × 撤销类别：建连 → 撤销 → 断言关闭码 / 后续帧被过滤 / actor 已替换。每通道至少一条。
2. AC-1 任务成员移除：**移除前收得到**（正向对照）→ 移除后连接关闭且一帧不漏。
3. AC-2 角色降级：`workflows` / `memories`（`adminShortCircuit`）与 `tasks-list` / `scheduled-tasks`（`permissions` 集合）**分列**断言；含白盒断言「`ws.data.actor.user.role` 已替换」。
4. AC-3 会话 / PAT / 批量吊销 / 停用 / **过期** → 4401；其中**静默连接**（建连后一帧不发）也必须被关闭。
5. AC-4a 有缓存通道（`tasks-list` / `workflows`）缓存失效；AC-4b 无缓存通道按新 actor 判定。
6. AC-6 零额外查询：共享 `countingDb`（拦 select/insert/update/delete，**不能只拦 select**——那会漏计复核路径里的 UPDATE），无撤销时增量为 0；**对称的另一半**：一次撤销后 `lookupByHash` 恰好被调用 N 次（N = 连接数）、且零写入。
7. 同步管道回归锚点：`rfc152-ws-channel-registry.test.ts:277` / `:290` 必须保持绿（方案 D 下帧路径不变，天然成立——这两条正是判死方案 C 的证据）。
8. 写入面棘轮（§6 第一行）。
9. 变异实证：去掉 actor 写回 / 去掉缓存清空 / 去掉 upgradeGate 重跑 / 把重扫移到事务提交前，各自必须让对应用例变红。

**已知盲区（登记而非假装覆盖）**：

- `repo-import` 通道无任何门（`registry.ts:415-424`），本 RFC 只让它受凭据有效性约束；补门属 RFC-152 D4 遗留，另立。
- `replayTaskEvents`（`registry.ts:288-324`，`?since` 回放在 `:322` 逐条裸 `sendJson`）是 task 通道的第二条无门发送路径，发生在 upgrade 时、受 upgradeGate 保护，但不受本机制影响。
- 多进程部署（本平台单进程 daemon）。

## 8. 验收标准修订

- **AC-3 口径**：方案 D 下「所有连接被关闭」是可达的（不依赖帧到达），保留 proposal 原文。v1 的惰性口径与它自相矛盾，已随选型一并解决。
- **AC-5**：统一为「`ChannelSpec` 必填字段 + mapped type + `@ts-expect-error` 反向锁」，不再出现两套说法。
- **AC-6**：「额外 = 相对现状的增量」；方案 D 下帧路径零改动，该 AC 由构造成立，计数断言用于防回归。
- **AC-7 变异实证不进合并门**：审计报告的 G6（变异测试基建）尚未建成，把「记录在 PR 说明里」当验收就是散文充当契约。改为「本 RFC 的变异清单写进 G6 的首批输入」。

## 9. v1 取舍的保留记录

v1 选方案 C 的唯一站得住的优势是「从不收帧的连接零成本」。方案 D 下这类连接会在每次撤销时各被复核一次（一次只读查询）。按本平台的连接数量级（个位数到几十）与撤销频率，这个代价可忽略；若未来成为问题，可在 D 之上叠加「按 userId 分桶只重扫受影响用户」——那是 B 的优化版，接口不变。
