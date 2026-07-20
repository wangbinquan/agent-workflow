# RFC-212 — WebSocket 授权撤销的逐帧复核

> 状态：Draft（待用户批准后进入实现）
> 来源：`design/test-guard-audit-2026-07-21` 跨域 Top-6（`D-ws-revocation`），用户 2026-07-21 指定为下一批加固的第一优先项。

## 1. 背景

HTTP 侧每个请求都会重新解析 actor 并重跑权限门。**WebSocket 侧不会**：

- `packages/backend/src/ws/server.ts:114-142` 在 upgrade 时解析一次 actor，把它连同一个空的 `visibilityCache` 一起塞进 `ws.data`，此后**在连接的整个生命周期内再也不复核**。
- 七个通道里，只有 `workflows` 有一处 `ctx.cache.delete(...)`（`registry.ts:396-400`，且只针对 `workflow.acl.updated` 这一种消息）。

于是「取消授权」这件事在 WS 上是**不生效的**：撤销发生在 HTTP 侧，而已经建立的 socket 拿着一个冻结的 actor 继续推。

### 1.1 组合空间

审计把它归为逃逸机制①「组合空间无归属」：**7 个通道 × 4 类撤销 = 28 格，目前只实现了 1 格**。

| 通道 | 现有门 | 复核 |
| --- | --- | --- |
| `task` | `upgradeGate`（`taskVisibleTo`） | 仅 upgrade 一次；此后每帧无门 |
| `tasks-list` | `frameGate`（`cachedTaskVisible`） | 每帧走缓存，缓存永不失效 |
| `workflows` | `frameGate` + `adminShortCircuit` | 仅 `workflow.acl.updated` 会 bust 缓存 |
| `repo-import` | **无门** | — |
| `memories` | `frameGate` + `adminShortCircuit` | 缓存永不失效 |
| `memory-distill-jobs` | `upgradeGate`（admin-only） | 仅 upgrade 一次 |
| `scheduled-tasks` | `frameGate` | 缓存永不失效 |

四类撤销事件（都有明确写入点）：

1. **会话 / PAT / 身份被吊销** — `auth/sessionStore.ts:115` `revokeSession`、`auth/patStore.ts:107` `revokePat`、`services/userIdentities.ts:77` `deleteIdentity`
2. **账号被停用** — `services/users.ts:132` `disableUser`
3. **角色降级**（admin → user，影响所有 `adminShortCircuit` 通道与 `tasks:read:all`）— `services/users.ts` 的角色更新路径
4. **任务成员被移除 / 资源 ACL 被收回** — `services/taskCollab.ts:130` `updateTaskMembers`、`services/resourceAcl.ts:313` `updateResourceAcl`

## 2. 用户故事 / 影响

- **管理员把某人从任务成员里移除**，对方浏览器上开着的任务详情页继续实时收到该任务的 `node_run_events`——**包含 agent 的完整 stdout**（prompt、被读文件内容、命令输出）。
- **管理员把某人降级为普通用户**，对方开着的 `/tasks` 列表页继续按 admin 的 `tasks:read:all` 收到全站任务变更。
- **管理员吊销某人的会话或 PAT**（典型场景：人员离职、凭据泄漏），HTTP 立刻失效，但对方已经打开的页面继续实时接收数据，直到主动关闭标签页。
- **私有资源被收回授权**后，被收回者的 `/workflows`、`/memory` 页面继续收到该资源的更新。

这四条都不需要攻击者做任何事——只要**不关闭已经打开的页面**。

## 3. 目标

1. 任一撤销事件发生后，**所有**受影响的已建立 WS 连接在**下一帧之前**重新走一遍它自己的门；不再有效的连接被关闭。
2. 「哪个通道在哪类撤销下如何复核」这张 28 格表由**机器持有**（编译期强制），新增通道或新增撤销类别时不表态即编译失败——不再依赖任何人记得。
3. 复核的代价不能压垮广播路径（正常情况下零额外 DB 查询）。

## 4. 非目标

- 不改 HTTP 侧的鉴权（那里每请求已复核）。
- 不引入分布式的会话失效广播（本平台是单进程 daemon；`ws/server.ts` 与撤销写入点在同一进程内）。
- 不改前端：连接被关闭后，现有的重连逻辑会尝试重连并在 upgrade 时拿到 401/403，这正是期望行为。前端只需保证关闭码可读（见 design §5）。

## 5. 验收标准

| # | 标准 |
| --- | --- |
| AC-1 | 任务成员被移除后，该成员已建立的 `task` 通道连接在下一帧前被关闭，且不再收到任何该任务的帧 |
| AC-2 | 用户被降级为 `user` 后，其 `tasks-list` / `workflows` / `memories` 连接不再享有 admin 短路，按普通用户的可见性过滤 |
| AC-3 | 会话 / PAT 被吊销、或账号被停用后，该凭据建立的所有 WS 连接被关闭 |
| AC-4 | 资源 ACL 被收回后，对应通道的 per-connection 可见性缓存失效，被收回者不再收到该资源的帧 |
| AC-5 | 七个通道 × 四类撤销的矩阵以 `as const satisfies Record<WsChannelKind, …>` 落地；新增通道不表态即**编译失败**；配一条遍历矩阵的表驱动测试，每格至少一条行为断言 |
| AC-6 | 无撤销发生时，广播路径不产生任何额外 DB 查询（用计数断言锁定） |
| AC-7 | 每条 AC 都有变异实证：去掉复核 / 去掉某一格的 bust，对应用例必红 |

## 6. 与既有设计的关系

- RFC-054 W2-4 定下「`task` 通道 upgrade 时一次性门控」的取舍，当时的理由是每帧查 DB 太贵。本 RFC 不推翻它——用 epoch 比较让**没有发生撤销时的代价为零**，只在 epoch 变化后复核一次。
- RFC-099 的资源 ACL 与任务成员制是撤销事件的来源；本 RFC 只在其写入点上加一次 `bumpAuthEpoch()`。
- 审计报告 §3 结构守卫 G4「分叉维度矩阵化」的第一张表就是本 RFC 的 AC-5。
