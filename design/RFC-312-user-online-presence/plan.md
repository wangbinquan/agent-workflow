# RFC-312 任务分解：用户在线状态（presence）

- 状态：**Draft v7**（设计门六轮；v6 整份重写 + 独立通道，v7 收 V6-1…V6-8）
- 前置：`proposal.md`（AC-1…AC-27）、`design.md`（§11 实现合同、§12 测试策略）

## 1. 子任务

依赖：`T0` 独立；`T1 → T2 → T3 → T4 → T5 → T6`（后端主链）；`T7 → T9`、`T8 → T9`（前端链）；
`T10`（权限发放与运行时钉子）与 `T11`（容量与滥用收敛）可并行；`T12` 贯穿链；`T13` 收尾。

### T0 —— WS 升级路径去重（既有浪费，可摘）

`ws/server.ts:200` 的 `buildWsCredential` 对同一 token 重跑 `lookupActiveSession`。改为复用
`resolveActor` 已解析的 session ⇒ 每次升级 **5 读 2 写 → 3 读 1 写**，对所有 WS 连接生效（design §8.3）。
测试：db spy 计数，修复前先跑出 2 写的红；口径写成"成功 session 的 `tryUpgrade` 认证段"（AC-27）。

### T1 —— shared 契约

- `permission.ts`：`PERMISSIONS` 加点 + `catalogEntry(group:'platform', token:'never')` +
  `SYSTEM_DOMAIN_POINTS`；**不进任何 `ROLE_PERMISSIONS` 预设**。
- `ws.ts`：`PresenceWsMessageSchema`（snapshot / changed 两变体）+ **`WS_PATHS.presence`**。
- `i18n/permissionCatalog.ts` 的 `EN_ACTIONS`/`ZH_ACTIONS` 加 `presence` + catalog 文案（zh/en）。
- 测试：design §12 的 ①②③。

### T2 —— domain 状态机（单调时钟）

`modules/identity-access/domain/userPresence.ts`；`graceUntil` 是单调刻度，类型注释写明。
测试：④⑤。

### T3 —— application（五个 port + command + query）

ports：`userPresenceStore`（含 `pending` 与 `generation`）、`presenceGraceTimer`、
`presenceBatchScheduler`、`monotonicClock`、`userPresenceObserver`。
`trackUserPresence`：`opened/closed/flushBatch/reapExpired`（**两枚 timer 两个回调，不共用**）。
`getUserPresence`：**零参** `snapshot()`/`stateOf()`；快照序列化缓存键 `(generation, validUntil)`。
测试：⑥⑦⑧⑨⑩。

### T4 —— infrastructure + composition

四个适配器（两枚 timer 均 `unref()`）；`composition.ts` 装配并**在 bootstrap 调
`registerRevalidationTrigger` 闭包捕获** presence 实例（design §11 C1），提供
`resetRevalidationTriggerForTest()`；WS adapter deps 只收 public 实例。

### T5 —— 通道 `/ws/presence`

`ws/broadcaster.ts` 加 `PRESENCE_CHANNEL` + `presenceBroadcaster`；`ws/registry.ts` 加 kind
（三张类型表）+ spec（`upgradeGate: users:presence`、`rerunUpgradeGate: true`、**无 frameGate**、
`onOpenExtra` 同步取快照并发、`drain` 修复钩子）。
新增发送出口 **`sendPreparedJson(ws, encoded, db)`**（过 fence、不重复序列化、返回原始 send 结果）
与 bootstrap 注入的唯一 **`PresenceWsObserverAdapter`**（design §3.3 / V6-3）。
**有意更新**既有 `onOpenExtra` 穷举锁（task → task + presence）。测试：⑪⑫⑬⑳。

### T6 —— 连接层接线

`handleOpen`：epoch 复核 **且完整 `checkUpgradeGate`** 通过后才登记（design §5.1）。
lifecycle 单调三态 + 原子 install-or-release + 单次释放句柄（§5.2）。
actor revision 守卫 + **per-socket epoch 所有权**（§5.3，含"解冻不被吞"）。
丢帧修复**两端**（V6-4）：`-1` ⇒ dirty 等 drain；`0` 与抛错 ⇒ **直接关连接**；
帧被 `revalidating` 短路 ⇒ **同步置 dirty**；修复重试上限 **3 次**后关连接。
per-socket worker 按 design §5.3 表实现**全部七项**（含 equal-revision 照常应用、
awaited-tail、解冻所有权、**非 presence 通道回归**）。测试：⑭⑮⑯⑰⑱⑲。

### T7 —— 前端 store 与订阅

`hooks/usePresence.ts`：`{hydrated, onlineIds}` + `useSyncExternalStore`；
`usePresenceSubscription()`（`usePermission` 门 + `useWebSocket(WS_PATHS.presence)`）挂在 AppShell；
reset 归属 **auth revision + 物理连接生命周期**（不挂 hook cleanup）；sentinel id 返回 `undefined`。
测试：㉘㉙。

### T8 —— 公共组件 `PresenceDot`

`components/PresenceDot.tsx`（`undefined → null`、`role="img"` + `aria-label`）+ `.presence-dot` 样式
+ i18n。测试：㉗。

### T9 —— 五处界面接线

`UserDirectory` / `AttributionChip` / `TaskMembersPanel` 只读分支 / **`UserPicker` 可管理分支**
（加可选 adornment render prop）/ `RoomSideCards` 人类成员行。测试：㉚㉛㉜。

### T10 —— 权限发放与运行时钉子

- **统一 provisioning seam**：`initialGrants(role): InitialGrantSpec[]`（带 `origin` 与 `grantedByUserId`，
  V6-1）由 design §6.1 真值表驱动；grant 行与 audit 都用它，**只有最终权限集合才压成 union**；
  覆盖 `createManagedUser`、**OIDC 自助建号**、bootstrap admin。
- **迁移**：为 `role IN ('user','manager')` 且 `id != '__system__'` 的存量用户 backfill 一条
  `user_permission_grants('users:presence')`，`INSERT OR IGNORE` 幂等。

  > **开工前必须查 journal**：`db/migrations/meta/_journal.json` 是共享索引文件。
  > 2026-08-19 实测：工作树 186 条（末条 `0186_rfc310_task_platform_inputs`），主干 185 条，
  > 而 `0186_*.sql` **未追踪**——此刻提 journal = 提一条指向不存在 .sql 的条目，**daemon 起不来**。
  > 定式：①`git status packages/backend/db/migrations/` 确认 journal 与所有 .sql 同步；
  > ②编号取**届时主干末条 +1**（用 `jq '.entries|length'` 本地 vs `git show HEAD:…` 对比，不照抄本地末条）；
  > ③journal 与自己的 .sql **同一笔提**，不裹进他人未落地条目。
- `cli/start.ts` 的 `Bun.serve`：websocket handler tree 显式写 **`idleTimeout: 120` + `sendPings: true`**；
  测试**断言嵌套配置**，**不得**照搬 `cli-start-idle-timeout.test.ts:33` 的无作用域 regex。
- 测试：㉔ + AC-2。

### T11 —— 容量与滥用收敛（G7）

- `services/taskCollab.ts`：在**同一 `dbTxSync` 内**比较规范化的 `(ownerUserId, 排序去重 collaborator 集)`，
  相同则不写不触发复核；**owner 转移算变更**（V6-6——事务外比较是 TOCTOU）。
- **`PresenceAdmissionLease`**（独立于升级门，V6-5）：握手期原子 reserve，三条路径各释放一次；
  **Q = 8 条/用户**、**升级速率 30 次/分钟**；复核重跑**不得**踢掉已在线连接。
- 容量数字断言（AC-25）。测试：㉑㉒㉓。

### T12 —— 贯穿链与可观测性

- **e2e**（真 daemon + 两个浏览器上下文）：AC-1 点出现/消失 + ≤1s；起 daemon 时
  `waitForReady` **同时捕获 stderr**。
- 撤销全链：禁用账号 / 撤销 session 各一条，先在线后离线。
- 可观测性（AC-26 / V6-8）：字段清单见 design §11 C11（权限/登记/交付/复核/客户端五侧）；
  验收是**构造四种成因各一次**（未登记 / 帧被丢 / store 未水化 / 权限）并断言诊断面能唯一区分，
  **只列字段不算完成**；普通日志不含完整 roster。测试：㉕㉖㉞。

### T13 —— 索引与收尾

`design/plan.md` 索引状态流转；`STATE.md`（**不跑 prettier**——该文件不在 format 门内，
跑了只会重排他人段落）；通用坑进 `docs/dev-gotchas.md`。

## 2. PR 拆分

**默认单 PR**（`feat(identity-access): RFC-312 用户在线状态`），顺序 T0→T13。
如需拆：**PR-1 = T0…T6 + T10 + T11**（后端可独立验收：能连、能收快照与增量、权限门与配额生效），
**PR-2 = T7…T9 + T12**。

## 3. 验收清单

功能：AC-1（e2e ≤1s）/ AC-2（180s 上界 + 嵌套配置断言）/ AC-3（真实重连 + 正控）/ AC-4 / AC-5（排序不变）/
AC-6（五处 + aria-label）/ AC-7

权限：AC-8（升级被拒且不影响其它通道）/ AC-9（收回关连接、授予自动订阅，**无服务端边沿协议**）/
AC-10 / AC-11（两 case，先在线后离线）/ AC-12（关键字 + forbidden-import）/ AC-13（连接数恰 +1）

稳健：AC-14（timer 正反 + `unref()`）/ AC-15（未知非离线）/ AC-16（三态 + `connections===1` 正控）/
AC-17（精确帧数 + 初末态）/ AC-18（完整 gate + 正控）/ AC-19（双时钟）/
AC-20（0/-1/抛错三测 + 修复再失败关连接）/ AC-21（缓存 `validUntil`）

发放：AC-22（按可达角色矩阵 + 审计同源 + 归因可区分）

容量与滥用：AC-23（no-op 不触发复核，红→绿）/ AC-24（连接配额）/ AC-25（数字上限）

可观测性：AC-26；可摘：AC-27（T0）

门禁：

- [ ] `bun run gate:local` 全绿
- [ ] Codex **设计门第七轮**（v7）findings 处置完毕 —— 或用户判定收手
- [ ] Codex **实现门**（declare done 前）findings 处置完毕
- [ ] 推送后按 exact SHA 查 CI 绿

---

## 4. 交付注记（2026-08-19，`bb2beece` + 后续）

### 4.1 范围裁决：七轮门之后砍回核心

设计门跑了**七轮、累计约 59 条 finding**，且第二轮起每轮稳定 6–9 条、**没有收敛趋势**。
把 finding 按来源归类后事情就清楚了：

| 来源 | 占比 | 例子 |
| --- | --- | --- |
| presence 核心逻辑本身 | ~10% | 引用计数双重释放、宽限期该用单调时钟 |
| **接进本仓既有机制** | ~40% | RFC-305 出站 fence 每帧一次同步查询、RFC-212 复核冻结与无排序保证、权限模型无 deny 集、OIDC 建号绕过、迁移 journal 是共享文件 |
| **为回应前一轮 finding 而新加的机制** | ~30% | 配额→租约→线性化→拒绝协议→重连包络；per-socket worker；dirty 协议 |
| 文档措辞与 AC 可证伪性 | ~20% | 真值表与测试文本打架、AC 允许空实现通过 |

第三类是**自造的**：每消一条 finding 就加一个机制，那个机制随即开始生自己的 finding。
用户据此拍板：**只做核心 + 有源码实证支撑的护栏**，其余砍掉。本注记是那次裁决的落账。

### 4.2 已实现（`bb2beece`，50 文件、37 条新测试；`gate:local` 全绿）

- domain 状态机（引用计数 + 60s 宽限 + **单调时钟**）
- application：仅派生态翻转才广播、500ms 合并窗口（存**初态+末态**）、grace 与 batch **两枚独立定时器**、query 零参
- `/ws/presence` **独立通道**：`users:presence` 整连接级升级门 + `rerunUpgradeGate`、**无 frameGate**、
  `onOpenExtra` 登记 + 发全量快照
- 连接层：**单次释放句柄**、登记在 epoch 复核**且重跑完整升级门之后**
- 权限点 `users:presence`（不进静态 preset，admin 由动态 baseline 天然持有）+ 三条建号路径共用的默认授予策略
- 前端 store 三态 + `PresenceDot` + 接线 `/users` 与全站署名 chip
- 迁移 `0188_rfc312_users_presence_grant`：存量 user/manager 的 backfill

### 4.3 **明确不做**（v7 里有、本次刻意砍掉）

以下条目**不是遗漏，是裁决**。要恢复其中任何一条，请先说明它对应的真实故障，而不是引用某轮 finding 编号：

| v7 条目 | 砍掉的理由 |
| --- | --- |
| `PresenceAdmissionLease` 连接配额（Q=8、30/min） | 属于对既有 WS 层的加固，收益覆盖全部通道，不该由"显示小圆点"来扛；真要做应独立立 RFC |
| dirty + drain 丢帧修复链（含重试上限、四种入口） | 简化为：**presence 发送失败就关连接**，客户端重连自然拿新快照。少一套状态机 |
| per-socket worker 七项合同（requestedEpoch/processedEpoch/awaited-tail…） | 同上——那是 RFC-212 复核机制的加固 |
| `taskCollab` no-op 写不触发复核 | 真实缺口（普通用户可放大），但**属于既有仓的问题**，独立修更清楚 |
| 快照序列化缓存 + 容量预算（AC-25/28） | 当前规模下无实测诉求；等真有量级压力再按实测做 |
| 可观测性合同（AC-26 五侧字段） | 同上，先上线再按真实排障需要补 |
| T0：WS 升级路径去重（5 读 2 写 → 3 读 1 写） | 与 presence 无关的既有浪费；**已告知并发的 RFC-311 session 可自行取用** |
| 其余三处接线（任务成员面板只读分支 / `UserPicker` 可管理分支 / 花名册人类成员行） | 待前两处观感确认后再铺，避免五处一起返工 |

### 4.4 已按"有意更新"处理的既有锁（9 条）

WS_PATHS 双射 11→12、通道计数 11→12、`onOpenExtra` 穷举锁扩为 task+presence、
权限总数 108→109、user 预设差集 28→29、guest 可授予 101→102、前端权限目录 108→109、
迁移总数 187→188、RFC-305 架构锁登记 `ws/registry.ts -> identity-access/composition`，
以及五处因"新建用户默认多一条 grant"而更新的夹具期望。**没有一条是放宽判据或删除断言。**

### 4.5 实现过程中被既有防线抓到的两次

1. `rfc152-ws-task-channel` 的源级 ratchet 禁止 `server.ts` 出现任何 `.kind ===` 分支，
   我写的 `credential.kind === 'session'` 被拦。虽属正则误伤，但**没有放宽 ratchet**——
   把登记搬进 presence 通道自己的 spec（presence 本就只统计这一个通道的连接，那才是它该在的地方）。
2. 通道测试里快照发不出去，因为夹具只造了 Actor 对象、DB 里没有 users 行，
   **RFC-305 的出站 fence 查不到就丢帧**。这实证了 design §8.2 记的那笔账：
   presence 的 DB 成本 = 每帧每订阅者一次主键点查。
