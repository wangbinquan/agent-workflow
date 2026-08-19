# RFC-312：用户在线状态（presence）

- 状态：**Draft v7（待批）**——经 Codex 设计门**六轮**（累计 50 条 finding）。v6 改独立 `/ws/presence`
  通道并整份重写，v7 收 V6-1…V6-8（真值表措辞 / 授予方向上界 / 唯一接线 / dirty 两端 / 独立配额租约 /
  事务内规范化比较 / worker 完整合同 / 诊断字段）
- 日期：2026-08-19
- 设计门记录：同目录 `codex-design-gate*.md` 五份
- 相关：RFC-036（用户/会话/PAT）、RFC-152（WS 通道注册表）、RFC-212（WS 授权复核）、
  RFC-305（权限模型 + 出站 authority fence）、RFC-182（工作组花名册 presence，**同名不同义**）、
  RFC-311（数据库性能治理）

## 1. 背景

平台对"人"只记录一个时间戳：`users.last_login_at`，且只在登录仪式里写一次
（密码登录 `auth/loginPolicy.ts:329`；OIDC 走 `auth/sessionStore.ts:98-104`）。
之后用户挂着页面工作一整天，这个值都不动（前台渲染见 `components/users/UserDirectory.tsx:189-196`）。
于是"谁此刻在线"在产品里**结构上无法回答**——指派任务、@ 人回答反问、评审等人拍板时只能猜。

## 2. 判据与既有信号

| 信号 | 位置 | 写入时机 | 能否回答"此刻在线" |
| --- | --- | --- | --- |
| `users.last_login_at` | `db/schema.ts:2415`（行号以 `f8b2a3a8` 为准） | 仅登录仪式 | **否** |
| `user_sessions.last_used_at` | `db/schema.ts:2491`，写在 `auth/sessionStore.ts:150-152` | 每次 session 鉴权请求 | 可近似，但密度取决于前台请求频率，而 RFC-311 正在裁剪它们 |
| **WS 长连接** | `ws/connections.ts:36` 进程级 live set | 连接建立 / 断开 | **能**，且不依赖轮询 |

**口径**：在线 ⟺ 该用户名下存在至少一条**活的、由 session 凭据建立、且已通过完整通道授权**的
`/ws/presence` 连接；或最后一条这样的连接断开还不足 60s（宽限期）。

两条边界（设计门 F13 / 五轮实测）：

- 前台的载体是 `AppShell`（`routes/__root.tsx:114`）。`/auth` 与 `/setup/admin` 在判断 token **之前**
  就返回 `BareShell`（`__root.tsx:99-115`），所以**已登录但停在登录页 = 显示离线**。这被接受为正确行为。
- daemon 是**单进程**（单实例锁是 `util/lock.ts:1-4` 的原子 PID 文件，源码明写 "no kernel-level flock
  dependency"）。presence 状态放进程内存即可，不需要跨进程设施。

## 3. 目标

- **G1**：四处界面显示某个真实用户此刻是否在线（§5）。
- **G2**：二态（在线 / 离线），不猜"离开"。
- **G3**：**不新增轮询、不新增表/列/周期查询**；presence 模块自身零 DB。
  新增成本是**每标签页一条 `/ws/presence` 连接**与**每帧每订阅者一次既有出站 fence 读**，
  两者都有量化预算与上限断言（design §8）。
- **G4**：秒级实时，前台不轮询。
- **G5**：可见性显式受控且**可按账号收回**（`users:presence`，走显式 grant 而非 baseline）。
- **G6**：在线状态**绝不进入任何 agent prompt**。
- **G7**：**普通用户不得借 presence 放大出全网工作量**（五轮 W5-5 的直接产物，见 §6）。

## 4. 非目标

- 不做"离开 / idle"第三态；不用 `last_used_at` 做判据；不改「最后登录」列的语义与排序。
- 不做隐身开关（§6 已把可见面显式化）。
- PAT / daemon token 的连接不计入在线。
- 不做跨进程 presence、不做历史 presence 统计。
- **不做 authority fence 的内存镜像化**——收益覆盖所有通道但属横切改造，已交接 RFC-311 登记为后续项
  （判据 `ws/registry.ts:1015-1035`）。

## 5. 用户故事与显示位置

1. 管理员在 `/users` 一眼看出哪些账号此刻在线。
2. 任务 owner 在成员面板看到某协作者在线，直接 @ 他回答反问。
3. 评审 / 反问页的署名 chip 带在线点。
4. 工作组房间花名册里的**人类成员**（`memberType='human'`，`shared/src/schemas/workgroup.ts:126-127` 带 `userId`）
   除既有执行态 chip 外还能看出是否在线。
5. 刷新、切路由、短暂断网重连**不会**让别人看到状态闪烁。

**与 RFC-182 的区分**：`deriveMemberPresence`（`lib/workgroup-room.ts:256-278`）产出的
`working/awaiting/queued/idle` 是**成员（含 agent）的执行态**，数据源是 run/assignment；
本 RFC 是**人的连接态**。两者同屏并存，类型与文案分开：`UserOnlineState`（在线/离线）
vs `WorkgroupMemberPresence`（忙碌/空闲）。

## 6. 隐私、可见性与滥用面

- **持 `users:presence` = 可见全平台实时在线名单**（设计门 F12，用户明确接受）。
  订阅时下发的 `presence.snapshot` 是**当前在线 userId 全集**；持有者配合既有
  `POST /api/users/lookup`（`routes/users.ts:78-99`，一次 200 个 id）可还原姓名，
  并通过持续记录增量重建**全平台上下线轨迹**（五轮实测：900 在线只需 1 个快照 + 5 次 lookup）。
  这是真实暴露面，不是"界面上的小圆点"。
- 暴露的信息**只有二态布尔**：不含连接数、设备、IP、UA、最后活跃时刻、在线时长。
- **发放方式**：`users:presence` **不进 user/manager/guest 的 baseline**——RFC-305 的有效权限是
  `role ∪ additional` 且**无 deny 集**（`shared/src/schemas/permission.ts:1172-1179`），
  baseline 点在写入侧被 `user-permission-redundant` 拒绝（`:1113-1115`），等于永不可按账号收回。
  改为**显式 grant**（新建默认授予 + 存量 backfill）。
  **admin 例外且不处理**（用户拍板）：`ROLE_PERMISSIONS.admin = [...PERMISSIONS]`（`:1059`）天然吸收，
  全权角色无"单独收回"可言；默认授予与 backfill **跳过 admin**。
- 落在 `SYSTEM_DOMAIN_POINTS` ⇒ **PAT / MCP 永远拿不到**（`:1251-1276` 逐项剔除）。
- **滥用面（G7）**：presence 是本 RFC 里唯一"普通用户动作能触发全网工作"的机制。五轮敌手视角实测：
  `services/taskCollab.ts:255` 的 `triggerRevalidationAndWait('task-members-changed')` **不带 target**，
  任何能改自己任务成员的用户**重放一次 no-op 写**即可触发全量复核。本 RFC 因此承担两条**源头收敛**
  （见 design §7.3）：①成员集未变的写**不触发复核**；②**每用户 `/ws/presence` 连接配额**。
- 在线状态**不入任何 prompt**（G6）。

## 7. 用户拍板记录（2026-08-19）

| 议题 | 结论 |
| --- | --- |
| 显示位置 | 四处：`/users`、全站署名 chip、工作组花名册、任务成员区 |
| 判定口径 | WS 长连接 + 宽限期（二态） |
| 可见范围 | 新增 `users:presence`，默认全员（初答"仅 `users:read`"经核实为 admin-only 后改） |
| 实时性 | WS 推送，秒级 |
| F1 每帧 fence 读 | **接受**；镜像化另立 RFC |
| F2 权限可收回性 | 显式 grant + backfill |
| F5 硬断时延 | 显式钉死 `websocket.idleTimeout` |
| F12 全平台名单 | **接受**，§6 明文化 |
| N1 admin | 天然持有，不做特殊处理 |
| N7 idleTimeout | **120**（= Bun 当前默认，零行为变更，只为钉住不漂移） |
| F13 / F14 | `/auth` 显示离线；重启期显示"未知" |
| **五轮后的通道选型** | **改独立 `/ws/presence`**——五轮证据表明"挂 authority 省一条连接"是坏交易：省下的是可计算有上界的连接成本，换来五轮未收敛的协议复杂度 + W5-5 放大面 |
| **文档维护方式** | **整份重写**，不再打补丁（W5-6 连续三轮被判不一致，根因是补丁叠补丁） |

## 8. 验收标准

### 功能

- **AC-1**：打开任意 AppShell 页面 → 其他持权者看到在线，**端到端 ≤1s**（含 500ms 合并窗口）。
  验收走 **e2e 真链**（真 daemon + 两个浏览器上下文），不接受 seed store 的组件测试。
- **AC-2**：服务端确认连接关闭后 60s ± 一个合并窗口内转离线。**硬断**（无 FIN）最坏
  = `websocket.idleTimeout`(120s) + 宽限期(60s) = **180s**；该值显式写死并**断言嵌套 handler 配置**
  （不得用 `cli-start-idle-timeout.test.ts:33` 那种无作用域 regex——它会先命中 HTTP 的 255）。
- **AC-3**：页面跳转 / 刷新 / 宽限内重连 → 观察者收不到翻转帧。含**真实 transport 重连**，
  并配**正向控制**（真下线时确实发帧）。
- **AC-4**：多标签页引用计数正确；关到最后一条才进入宽限。
- **AC-5**：`/users` 行显示在线点，且「最后登录」文案与**排序**不变（须断言）。
- **AC-6**：五处接线使用同一 `PresenceDot`（`/users`、署名 chip、任务成员面板**只读分支**、
  同面板 `canManage` 分支的 `UserPicker`、花名册人类成员行），含 `aria-label`。
- **AC-7**：花名册在线点与执行态 chip 并存不互斥。

### 权限与隔离

- **AC-8**：无 `users:presence` ⇒ `/ws/presence` **升级被拒**（`permission-required`），界面无点；
  其它通道（含 `/ws/authority`）**不受影响**。
- **AC-9**：运行中收回权限 ⇒ `rerunUpgradeGate` 关闭 presence 连接（4403），前端**同步 invalidate `/me`**
  且刷新成功前不重连。**授予**权限 ⇒ 前端 `usePermission` 翻转后自动订阅并拿到快照。
  **两个方向的收敛都不得依赖单帧不丢**：authority 控制帧的非正 send 结果 ⇒ 关闭该 authority socket，
  由物理重连强制 `/me` reconciliation（六轮 V6-2）。两方向 + 控制帧丢失各一测。
- **AC-10**：PAT / daemon 连接不计入在线；`users:presence` 不可授予任何 token。
- **AC-11**：账号禁用 与 session 撤销 **各一条独立 case**，均先断言观察者已看到在线，再断言转离线。
- **AC-12**：prompt 隔离——关键字扫描 **+ forbidden-import 断言**（presence 模块不得被任何
  `compose*Prompt` 链 import）。
- **AC-13**：presence 模块自身零 DB（spy + import 面双向）；**连接数变化可量化**——
  一个标签页产生的服务端 live 连接数**恰好 +1**（读 `liveConnectionCount()`，断言具体数值而非
  `before===after`）。

### 稳健

- **AC-14**：无 grace deadline **且**合并缓冲为空 ⇒ 零 presence 定时器（负向）；
  **正向控制**：有待到期项 ⇒ 恰一枚 grace timer；有缓冲 ⇒ 有 batch timer；两个生产 adapter 各断言 `unref()`。
- **AC-15**：daemon 重启期间前台显示**"未知"（不渲染点）**，不是"离线"；三件套 / 组件契约 / i18n 统一。
- **AC-16**：连接 lifecycle 单调三态 `open → closing → closed`；**客户端关闭**与**服务端
  `closeConnection`** 两路径各一测；正向控制须**先断言 open 后 `connections===1`**，再断言 close 后归零。
- **AC-17**：合并窗口断言**精确帧数与载荷**（200 人同窗口上线 ⇒ 每订阅者恰 1 帧、`changes` 含 200 条末态）
  + 499/500ms 边界；缓冲保存**窗口初态与末态**（只存末态判不出净零）。
- **AC-18**：presence 登记发生在 epoch 复核**且完整 `checkUpgradeGate` 之后**；**配正向控制**
  （正常连接确实登记成功，防"永不登记"空实现）。
- **AC-19**：宽限期用**单调时钟**；测试须区分两个时钟——wall clock 前跳/后跳时行为不变，
  只有单调时钟推进才到期。
- **AC-20**：**丢帧必被修复，且入口/出口都要闭合**（六轮 V6-4）。入口：`-1` ⇒ 置 `presenceDirty` 等 `drain`；
  `0` 与抛错 ⇒ **直接关连接**（这两种未必伴随背压，drain 可能永不触发）；帧因 `revalidating`
  被短路 ⇒ **同步置 dirty**（它根本没走到发送出口）。出口：`drain` 与下一 pass 各修一次；
  **修复帧再失败 ⇒ 重试上限 3 次后关连接**。四种入口 + 重试上限各一测。
- **AC-21**：快照缓存键为 `(generation, validUntil=min(graceUntil))`——`now >= validUntil` 时
  先物化到期状态并 bump generation，**不得发出跨过宽限截止的过期快照**。

### 权限发放

- **AC-22b**：provisioning 全程携带 `InitialGrantSpec { permission, origin, grantedByUserId }`——
  **系统默认授予与操作者显式授予在落库那一刻就可区分**；只有 view/observer 需要的最终权限集合
  才允许压成 union（六轮 V6-1）。
- **AC-22**：默认授予覆盖**每个入口实际可达的角色**（HTTP/CLI：四角色；OIDC 自助建号：其默认角色可达档；
  bootstrap：仅 admin），逐格对齐 design §6.1 真值表；断言 grant 行与
  `user_access_audit.added_permissions_json` **同源**，且**系统默认授予**（`grantedByUserId = null`）
  与**操作者显式授予**归因可区分。

### 容量与滥用

- **AC-23**（G7）：成员集**未变**的任务成员写**不触发复核**。比较必须在**同一事务内**、
  对象是规范化的 `(ownerUserId, 排序去重的 collaborator 集)`、**owner 转移算变更**（六轮 V6-6）。
  红→绿 + 一条"并发写不被错误跳过"的用例。
- **AC-24**（G7）：**每用户 `/ws/presence` 连接配额**由独立的 `PresenceAdmissionLease` 承担
  （**不得**放进 `rerunUpgradeGate: true` 的升级门——复核重跑会让在线连接被自己的门踢掉，六轮 V6-5）。
  数值钉死：**Q = 8 条 / 用户**、**升级速率 30 次/分钟 / 用户**。验收：超限拒绝且**不影响既有连接**、
  三条释放路径（升级失败 / 关闭 / close-before-install）各释放一次且只一次、
  **复核重跑不会踢掉已在线连接**。
- **AC-25**：容量上限**写成可判定数字**：1000 在线 / 3000 连接的合成场景下，
  一次全量复核引入的 presence 额外 DB 读 ≤ **连接数 × 1**、额外出站 ≤ **配额 × 单份快照字节**，
  且 p95 复核耗时增量有明确上限。

### 可观测性

- **AC-26**：线上"明明在线却显示离线"**可定位到段**，字段清单见 design §11 C11
  （权限 / 登记 / 交付 / 复核 / 客户端五侧）。验收方式是**构造四种成因各一次**
  （未登记 / 帧被丢 / store 未水化 / 权限），断言诊断面能**唯一区分**它们——
  只列字段不算完成（六轮 V6-8）。**普通日志不得记录完整 roster**。

### 可摘项

- **AC-27**（T0）：一次 WS 升级（成功 session 的 `tryUpgrade` 认证段）对 `user_sessions`
  的写 2→1、读 5→3。
