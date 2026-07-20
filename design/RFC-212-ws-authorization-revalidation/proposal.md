# RFC-212 — WebSocket 授权撤销的逐帧复核

> 状态：Draft v2（设计门已跑，待用户批准后进入实现）
> 设计门：Codex 配额耗尽 → 4 视角对抗自审 + 裁决，结论**「不能按 v1 实现」**，选型与 8 条阻断项已在 v2 修订。记录见 [`design-gate-review.md`](design-gate-review.md)。
> 来源：`design/test-guard-audit-2026-07-21` 跨域 Top-6（`D-ws-revocation`），用户 2026-07-21 指定为下一批加固的第一优先项。

## 1. 背景

HTTP 侧每个请求都会重新解析 actor 并重跑权限门。**WebSocket 侧不会**：

- `packages/backend/src/ws/server.ts:114-142` 在 upgrade 时解析一次 actor，把它连同一个空的 `visibilityCache` 一起塞进 `ws.data`，此后**在连接的整个生命周期内再也不复核**。
- 七个通道里，只有 `workflows` 有两处 `ctx.cache.delete(...)`（`registry.ts:398` / `:403`，分别针对 `workflow.acl.updated` 与 `workflow.deleted`）；其余六个通道从不失效任何东西。

于是「取消授权」这件事在 WS 上是**不生效的**：撤销发生在 HTTP 侧，而已经建立的 socket 拿着一个冻结的 actor 继续推。

### 1.1 组合空间

审计把它归为逃逸机制①「组合空间无归属」：**7 个通道 × 4 类撤销 = 28 格，目前只实现了 1 格**。

| 通道 | 现有门 | 复核 |
| --- | --- | --- |
| `task` | `upgradeGate`（`taskVisibleTo`） | 仅 upgrade 一次；此后每帧无门 |
| `tasks-list` | `frameGate`（`cachedTaskVisible`） | 每帧走缓存，缓存永不失效；`canViewTask` 内部按 `tasks:read:all` 短路，故 actor 冻结也是陈旧源 |
| `workflows` | `frameGate` + `adminShortCircuit` | 仅 `workflow.acl.updated` / `workflow.deleted` 两处 bust 缓存（`registry.ts:398`/`:403`）；`adminShortCircuit` 读冻结 actor |
| `repo-import` | **无门** | — |
| `memories` | `frameGate` + `adminShortCircuit` | **无缓存**（`registry.ts:436-437` 刻意不缓存：RFC-045 的编辑会让行跨 scope 移动）——陈旧源是**冻结的 actor** |
| `memory-distill-jobs` | `upgradeGate`（admin-only） | 仅 upgrade 一次 |
| `scheduled-tasks` | `frameGate` | **无缓存**（纯内存判断 `actor.permissions` + `ownerUserId`）——陈旧源是**冻结的 permissions** |

**五类**撤销事件（前四类有明确写入点，第五类是纯时间判定）：

1. **会话 / PAT / 身份被吊销** — `auth/sessionStore.ts:115` `revokeSession`、**`auth/sessionStore.ts:123` `revokeAllSessionsForUser`**（改密与重置密码的唯一入口）、`auth/patStore.ts:107` `revokePat`、`services/userIdentities.ts:77` `deleteIdentity`
2. **账号被停用** — `services/users.ts:132` `disableUser`
3. **角色降级 / Web UI 停用** — `services/users.ts:180` `patchUser`（同时写 `role` 与 `status`，且不像 `disableUser` 那样顺带吊销会话）
4. **任务成员被移除 / 资源 ACL 被收回** — `services/taskCollab.ts:130` `updateTaskMembers`、`services/resourceAcl.ts:313` `updateResourceAcl`
5. **凭据自然过期** — `sessionStore.ts:93` / `patStore.ts:83` 的纯时间判定（**无写入点可挂钩**，靠连接上记录的 `expiresAt` 做本地比较）

## 2. 用户故事 / 影响

- **管理员把某人从任务成员里移除**，对方浏览器上开着的任务详情页继续实时收到该任务的 `node_run_events`——**包含 agent 的完整 stdout**（prompt、被读文件内容、命令输出）。
- **管理员把某人降级为普通用户**，对方开着的 `/tasks` 列表页继续按 admin 的 `tasks:read:all` 收到全站任务变更。
- **管理员吊销某人的会话或 PAT**（典型场景：人员离职、凭据泄漏），HTTP 立刻失效，但对方已经打开的页面继续实时接收数据，直到主动关闭标签页。
- **私有资源被收回授权**后，被收回者的 `/workflows`、`/memory` 页面继续收到该资源的更新。

这四条都不需要攻击者做任何事——只要**不关闭已经打开的页面**。

## 3. 目标

1. 任一撤销事件发生后，**所有**已建立的 WS 连接立即重新走一遍它自己的门（不依赖是否有帧到达——静默连接同样被复核）；不再有效的连接被关闭。
2. 「哪个通道在哪类撤销下如何复核」这张 28 格表由**机器持有**（编译期强制），新增通道或新增撤销类别时不表态即编译失败——不再依赖任何人记得。
3. 广播路径**一行不改**：无撤销发生时零额外开销，且现有的同步投递语义（`registry.ts:587-594`）必须保持。

## 4. 非目标

- 不改 HTTP 侧的鉴权（那里每请求已复核）。
- 不引入分布式的会话失效广播（本平台是单进程 daemon；`ws/server.ts` 与撤销写入点在同一进程内）。
- ~~不改前端~~ —— **设计门更正**：`hooks/useWebSocket.ts:186` 的 close 监听器不接 event 参数，关闭码**今天读不到**；4401 后仍持死 token 每 30s 静默重连、界面零提示。前端必须改两点（读 `e.code`、4401 清 token 并提示），已并入 AC-9。
- 不给 `repo-import` 通道补门（`registry.ts:415-424` 无任何 gate）——属 RFC-152 D4 遗留，本 RFC 只让它受凭据有效性约束。

## 5. 验收标准

| # | 标准 |
| --- | --- |
| AC-1 | 任务成员被移除后，该成员已建立的 `task` 通道连接在下一帧前被关闭，且不再收到任何该任务的帧 |
| AC-2 | 用户被降级为 `user` 后：`workflows` / `memories`（`adminShortCircuit`）不再短路；`tasks-list` / `scheduled-tasks`（读 `actor.permissions`，**没有** adminShortCircuit）按新权限集合过滤。含白盒断言「`ws.data.actor` 已被替换」 |
| AC-3 | 会话 / PAT 被吊销、或账号被停用后，该凭据建立的所有 WS 连接被关闭 |
| AC-4a | 资源 ACL 被收回后，**有缓存的通道**（`tasks-list` / `workflows`）的 per-connection 缓存失效 |
| AC-4b | **无缓存的通道**（`memories` / `scheduled-tasks` 及所有 `adminShortCircuit`）在 actor 刷新后按新权限判定 |
| AC-5 | 复核策略矩阵落成 `ChannelSpec` 的**必填**字段（`registry.ts:330-332` 已是 mapped type，天然穷尽）；新增通道不表态即**编译失败**，可执行形式为一条 `@ts-expect-error` 反向锁；配一条遍历矩阵的表驱动行为测试 |
| AC-6 | 无撤销发生时，广播路径不产生任何额外 DB 查询（用计数断言锁定） |
| AC-7 | 变异清单（去掉 actor 写回 / 去掉缓存清空 / 去掉 upgradeGate 重跑 / 把重扫移到事务提交前）各自必红。**不作为合并门**——变异基建（审计 G6）尚未建成，本 RFC 的清单作为其首批输入 |
| AC-8 | 复核路径**不产生任何写**（不得触碰 `last_used_at`）|
| AC-9 | 前端读得到关闭码，`4401 → clearToken() + 重新登录提示` |

## 6. 与既有设计的关系

- RFC-054 W2-4 定下「`task` 通道 upgrade 时一次性门控」的取舍，理由是每帧查 DB 太贵。本 RFC 不推翻它——复核跑在**撤销方**的上下文里，帧路径一行不改。
- RFC-099 的资源 ACL 与任务成员制是撤销事件的来源；本 RFC 在其写入点的**事务提交之后**触发一次全量重扫。
- 审计报告 §3 结构守卫 G4「分叉维度矩阵化」的第一张表就是本 RFC 的 AC-5。
