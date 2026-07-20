# RFC-212 — 技术设计

## 1. 机制选型

三种候选：

| 方案 | 代价 | 问题 |
| --- | --- | --- |
| A. 每帧重新 `resolveActor` + 重跑门 | 每帧 ≥1 次 DB 查询，广播扇出下不可接受 | 直接推翻 RFC-054 W2-4 的性能取舍 |
| B. 撤销时精确定位受影响连接并逐个处理 | 需要「用户 → 连接」「任务 → 连接」多张反向索引，且每类撤销要各自维护 | 正是审计说的「28 格靠人记得」，新增撤销类别必漏 |
| **C. 全局 auth epoch + 惰性复核**（选定） | 正常路径只多一次整数比较 | 复核粒度粗（任一撤销让所有连接复核一次），但复核本身很便宜且不影响正确性 |

选 C：**正确性不依赖于「撤销方记得通知哪些连接」**，只依赖「撤销方记得 bump 一个计数器」，而这一点可以用源码棘轮强制（见 §6）。

## 2. 数据流

```
HTTP 撤销写入点  ──bumpAuthEpoch()──►  authEpoch(进程内单调计数)
                                            │
WS 帧投递前  ──ws.data.epoch !== current?──┘
                       │ 否 → 直接走原有 frameGate（零额外开销）
                       └ 是 → ① 用连接持有的 token 重新 resolveActor
                              ② 解析不出 / 账号停用 → close(4401)
                              ③ 清空 visibilityCache
                              ④ 重跑该通道的 upgradeGate（若有）→ 不过则 close(4403)
                              ⑤ ws.data.epoch = current，继续走 frameGate
```

## 3. 接口契约

### 3.1 `src/auth/authEpoch.ts`（新）

```ts
/** 单调递增的进程内计数器。任何使已发放凭据/授权变窄的写入都必须 bump。 */
export function bumpAuthEpoch(reason: AuthEpochReason): void
export function currentAuthEpoch(): number
export type AuthEpochReason =
  | 'session-revoked' | 'pat-revoked' | 'identity-deleted'
  | 'user-disabled' | 'user-role-changed'
  | 'task-members-changed' | 'resource-acl-changed'
```

`reason` 只用于日志与测试断言，不参与逻辑——但它让「新增一类撤销」变成一次显式的类型扩展。

### 3.2 `ConnectionData` 扩展（`ws/server.ts`）

```ts
interface ConnectionData {
  channel: ChannelParams
  actor: Actor
  /** upgrade 时使用的原始 token，仅用于 epoch 变化后重新 resolveActor。 */
  token: string
  /** 上次复核时的 epoch。 */
  epoch: number
  unsubscribe: () => void
  visibilityCache: Map<string, boolean>
}
```

> **安全评估**：token 已经存在于同一进程的内存中（`resolveActor` 的入参），保留一个引用不扩大攻击面；它不写日志、不进 DB、不出进程。替代方案是保存 `sessionId`/`patId` 再按 id 复核，但那要给两种凭据各写一条查询，且拿不到「凭据被删」与「用户被停用」的统一答案。

### 3.3 `ChannelSpec` 增加**必填**复核维度（AC-5 的载体）

```ts
export interface ChannelRevalidation {
  /** epoch 变化后是否重跑 upgradeGate。无 upgradeGate 的通道填 'n/a' 并写明理由。 */
  readonly onEpochChange: 'rerun-upgrade-gate' | 'clear-cache-only' | { na: string }
  /** 该通道的可见性缓存键前缀；epoch 变化时整表清空，此处仅作文档与测试遍历用。 */
  readonly cacheKeyPrefixes: readonly string[]
}
```

挂在 `WS_CHANNELS` 上后，`WsChannelRegistry` 的 mapped type 会强制**每个通道都表态**；新增通道不填即编译失败。

## 4. 撤销写入点接线

| 写入点 | 文件 | reason |
| --- | --- | --- |
| `revokeSession` | `auth/sessionStore.ts:115` | `session-revoked` |
| `revokePat` | `auth/patStore.ts:107` | `pat-revoked` |
| `deleteIdentity` | `services/userIdentities.ts:77` | `identity-deleted` |
| `disableUser` | `services/users.ts:132` | `user-disabled` |
| 角色更新 | `services/users.ts`（`updateUser` 的 role 分支） | `user-role-changed` |
| `updateTaskMembers` | `services/taskCollab.ts:130` | `task-members-changed` |
| `updateResourceAcl` | `services/resourceAcl.ts:313` | `resource-acl-changed` |

**只在语义为「收窄」时 bump 也可以，但本设计选择无条件 bump**：判断「这次修改是否收窄了某人的权限」本身就是一个容易出错的分支，而多余的 bump 只造成一次惰性复核。

## 5. 关闭语义

- 凭据已失效 → `ws.close(4401, 'auth-revoked')`
- 凭据有效但该通道不再可见 → `ws.close(4403, 'not-visible')`

4401/4403 落在 WebSocket 私有关闭码区间（4000-4999）。前端现有重连逻辑会重试，upgrade 时拿到 HTTP 401/403，与首次访问该资源的表现一致；不需要前端改动，但前端的重连退避需要确认不会对 4401 做无限快速重试（见 plan T6）。

## 6. 失败模式与防护

| 失败模式 | 防护 |
| --- | --- |
| 新增一类撤销却忘了 bump | 源码棘轮：对 §4 表里的每个函数断言其函数体含 `bumpAuthEpoch(`；新增到 `AuthEpochReason` 却无调用点也报错 |
| 新增通道忘了声明复核策略 | `satisfies Record<WsChannelKind, …>` 编译期强制（AC-5） |
| 复核逻辑本身写错方向（epoch 变了却不复核 / 恒复核） | AC-6 的「零额外查询」计数断言 + AC-7 变异实证 |
| 复核时 `resolveActor` 抛异常 | 视为失效并关闭（fail closed），与 upgrade 时的 `catch → 401` 一致 |
| epoch 溢出 | `Number.MAX_SAFE_INTEGER` 以内不可能达到；断言即可 |

## 7. 测试策略

**必写用例**（对应 AC）：

1. `ws-revocation-matrix.test.ts` — 表驱动遍历 `WS_CHANNELS` × 四类撤销：建连 → 触发撤销 → 断言「连接被关闭且关闭码正确」或「后续帧被过滤」。每个通道至少一条。
2. `task` 通道：成员被移除后收不到帧（AC-1）；**同时**断言移除前收得到（正向对照，防止整条链退化成「谁都收不到」）。
3. 角色降级：`tasks-list` 在降级后不再收到他人任务的帧（AC-2）。
4. 会话/PAT 吊销、账号停用：连接被 4401 关闭（AC-3）。
5. 资源 ACL 收回：`workflows` / `memories` 通道缓存失效（AC-4）。
6. **零开销断言**（AC-6）：在无撤销的连续 N 帧上统计 DB 查询次数为 0。
7. **源码棘轮**：§4 七个写入点必须含 `bumpAuthEpoch(`。
8. **变异实证**（AC-7）：分别去掉 epoch 比较、去掉 cache 清空、去掉 upgradeGate 重跑，各自必须让对应用例变红。

**已知盲区**：本设计不覆盖「撤销发生在同一帧投递过程中」的竞态（复核在投递前，投递本身是同步的），也不覆盖多进程部署（本平台单进程）。两条都写进 §16 遗留。
