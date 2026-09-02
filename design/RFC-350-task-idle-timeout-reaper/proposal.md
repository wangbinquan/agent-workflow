# RFC-350：任务不活跃超时收割（僵尸任务）与 interrupted 树归档补齐 —— proposal

- 状态：**Approved / In Progress**（用户 2026-09-02 批准 D1–D14 与能力影响清单 I-1～I-5，并授权完整实现、commit 与 push；明示跳过设计门）
- 落档：2026-09-02
- 触发：用户「现在配置里有个终态任务自动归档，也需要有个任务超时自动归档等功能，也就是任务在
  最后一次没有动作之后多久，就会当作僵尸任务自动归档」
- 相关：RFC-311 T19（终态任务树归档出库）、RFC-053 P-6（卡死检测 S1–S6）、RFC-108（自动恢复闭环）、
  P-4-04（资源上限强制）、RFC-349（双 provider）、RFC-338（维护 Worker）

---

## 1. 背景：三套机制都存在，但「不活跃 → 收割」这条链一条都不接

上手前按源码逐条对账（不靠记忆，锚点均为本仓 `file:line`）：

| 机制           | 位置                                                                     | 现在做什么                                                                                                                                                     | 为什么答不了本次需求                                                                                             |
| -------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 终态任务树归档 | `packages/backend/src/services/taskArchive.ts:436` `findArchivableTrees` | hourly sweep：**整棵树全终态**且 `max(finishedAt)` 超 `retentionDays` → 导出到 `~/.agent-workflow/archive/tasks/{root}/` 并**从库删除**，前台 404 与不存在同形 | 判据要求整树终态。一个卡在 `running` / `awaiting_human` 的任务**永远**不满足，于是永远不出库                     |
| 卡死检测       | `packages/backend/src/services/stuckTaskDetector.ts:1-28`                | S1–S6 六条规则，5 分钟一扫，判据即「静默超阈值 + 缺少对应证据」                                                                                                | 模块头注释写死了「**Non-goal**: this module does not "fix" stuck tasks」——只写 `lifecycle_alerts`，等人来点      |
| 自动修复       | `packages/backend/src/services/autoRepair.ts:1-15`（默认关）             | 对开启的规则，**恰好只有一个** auto-apply 选项时才动手                                                                                                         | `S3.mark-task-failed`、`S4.cancel-task` 都不是 `autoApplyEligible`（只有 `S4.kick-task` 是），永远不会被自动应用 |
| 资源上限       | `packages/backend/src/services/limits.ts:1-14`                           | 1Hz 扫 `running`，超 `max_duration_ms` / token 上限就 `cancelTask` + 覆盖专用原因文案                                                                          | 判据是**总运行时长**，不是**多久没动静**。一个 5 分钟就哑掉、再没配上限的任务它一辈子不看                        |

结论：**「任务最后一次动作之后 N 小时 → 判僵尸 → 终结 → 出库」这条链今天完全不存在**，必须新做。

### 1.1 顺带查出的既有缺口：`interrupted` 任务树永远不会被归档

`packages/shared/src/lifecycle.ts:203-208` 的 `TERMINAL_TASK_STATUSES` 含 `interrupted`（daemon 重启时
orphan reaper 把在跑的任务翻成它，并**写了 `finished_at`**，见
`packages/backend/src/modules/task-execution/composition/taskExecutionPersistence.ts:64-84`）；
而 `packages/backend/src/services/taskArchive.ts:95` 归档器自己那份

```ts
const TERMINAL = ['done', 'failed', 'canceled'] as const
```

**不含 `interrupted`**。两处对「终态」的定义不一致，后果是：**每次 daemon 重启残留的那批
`interrupted` 任务，既不会被自动归档（归档器不认），也不能被取消**（`cancel` 事件的 allowed-from 是
`pending|running|awaiting_*`，见 `packages/shared/src/lifecycle.ts:444-446`）——它们是最典型的僵尸，却是
库里唯一一类**永久不删**的任务。本 RFC 一并修。

---

## 2. 目标 / 非目标

### 目标

- G1：任务树在**最后一次动作**之后超过配置的不活跃阈值时，被判定为僵尸并**自动终结**（`canceled`），
  终结前先尽力杀掉仍活着的 runtime 子进程树。
- G2：被收割的任务在**任务详情页**能看到可读的中文原因（静默了多久、阈值多少），不是泛泛的
  「canceled by user」。
- G3：每次收割都留**持久审计**，可追溯「哪棵树、静默多久、进程杀没杀掉」。
- G4：收割后的任务作为普通终态任务，由**既有** `taskArchive` 保留期出库——两道闸各管一段，
  组合起来才是用户口中的「超时自动归档」。
- G5：补齐 §1.1 —— `interrupted` 树纳入既有归档器的终态集，不再永久占库。

### 非目标（本 RFC 明确不做）

- N1：**不做**手动入口 / dry-run 预览（用户拍板：既有 `POST /api/tasks/archive` 的手动+预览形态不复制到本功能）。
- N2：**不做**「先告警、宽限期到了再收」的两段式（用户拍板：一段式直接收）。
- N3：**不改** `worktreeAutoGc` 的默认值（今天默认 `{enabled:false}`，
  `packages/shared/src/schemas/config.ts:778`）。收割不删 worktree，磁盘回收仍归它管；只在设置页给一句提示。
- N4：**不做**任何安全/加固类工作（`CLAUDE.md` §工作准则 2026-08-26 硬规则）。
- N5：**不改**既有归档的导出格式、保留期语义、手动入口与权限点。
- N6：**不动** stuck detector 的 S1–S6 判据、阈值与豁免；本 RFC 的判定是独立的一套（理由见 design §3.4）。

---

## 3. 用户故事

- US-1 平台管理员：我把「不活跃超时」按出厂默认打开（7 天）。某个任务的 agent 在周一凌晨哑掉、进程还在
  但不再产出，一周后它被自动取消，详情页写着「因长时间无任何活动被平台自动终结（静默 7.2 天）」，
  而不是留一行永远转圈的 `running`。
- US-2 平台管理员：一个评审停在 `awaiting_review` 没人管。过了阈值它被收走；我在任务详情页的「恢复」区
  看到一条收割记录，知道是平台干的、什么时候、因为静默多久。
- US-3 平台管理员：我同时开了「不活跃超时（7 天）」和「终态任务自动归档（90 天）」。僵尸先在 7 天后变
  `canceled`，90 天后随普通终态任务一起出库删除。我随时可以只开前者（只收不删）。
- US-4 平台管理员：daemon 崩过几次，库里堆了一批 `interrupted`。开启终态归档后它们和别的终态任务一样
  会在保留期后出库，不再是永久居民。
- US-5 平台管理员：一个僵尸任务的子进程连 SIGKILL 都没收掉。任务照样被判 `canceled`，审计里明确写着
  进程未能终止（`kill-failed` / `window-expired`），我知道要去机器上看一眼。

---

## 4. 决策记录（用户 2026-09-02 四轮逐条拍板）

| #   | 决策                 | 取值                                                              | 备注                                                                               |
| --- | -------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| D1  | 处置终点             | **先判终态，再走既有保留期**                                      | 收割只负责判 `canceled`；出库仍由 `taskArchive` 完成                               |
| D2  | 「最后一次动作」口径 | **agent 事件 + 人类推进动作**                                     | 不只看 `node_run_events`                                                           |
| D3  | 纳入状态             | **全部非终态，单一阈值**                                          | `pending` / `running` / `awaiting_review` / `awaiting_human`                       |
| D4  | 活进程               | **照判：先杀进程树再终态**                                        | 复用 `killStaleRunProcessTree` 的 PID 复用窗口 + 身份门                            |
| D5  | 判定单位             | **整棵树聚合**                                                    | 树内任一任务有动作 = 整棵树算活                                                    |
| D6  | 人类动作范围         | **只算推进任务的动作**                                            | 评审决策 / 反问答复 / 问题派发决策 / 手动 resume·retry；评论、协作者变更、草稿不算 |
| D7  | 阈值                 | **小时粒度，默认 168 小时（7 天）**                               | 开关默认关                                                                         |
| D8  | 手动入口与可见性     | **只做审计行 + 详情页原因文案**；不做手动入口 / 预览 / 宽限期告警 | 见 N1/N2                                                                           |
| D9  | 终态取值             | **`canceled`**                                                    | 与资源上限先例同路（`limits.ts` 也是 cancel + 覆盖原因）                           |
| D10 | 开关关系             | **独立开关，两道各管一段**                                        | 新增 `taskIdleTimeout{enabled,idleHours}`，与 `taskArchive` 正交                   |
| D11 | 杀不掉进程           | **照常判终态，记异常**                                            | 审计与日志写明 outcome                                                             |
| D12 | worktree             | **交给既有 `worktreeAutoGc`**，设置页提示                         | 见 N3                                                                              |
| D13 | `interrupted`        | **纳入既有归档器的终态集**                                        | 见 §1.1 与下面能力影响清单 I-4                                                     |
| D14 | 执行位置             | 主线程可暂停后台写手（不进维护 Worker）                           | 技术裁决，理由见 design §3.5                                                       |

---

## 5. 能力影响清单（`CLAUDE.md` §RFC workflow 第 7 条）

本 RFC 既**新增**自动终结能力，又**扩张**既有归档的删除面。以下逐项列出用户可见的行为变化，
呈用户逐项确认后才实现：

| #   | 变化                                                                | 影响面                                  | 默认                                        | 可逆性                                                                 |
| --- | ------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| I-1 | 非终态任务会被平台**自动取消**（无人工确认、无宽限期）              | 所有部署                                | `taskIdleTimeout.enabled=false`，**默认关** | 任务仍可 resume / retry（`canceled` 属可 retry 集）；worktree 保留     |
| I-2 | 收割时会对该树里仍活着的 runtime 子进程树发 **TERM→KILL**           | 开启后所有部署                          | 同上                                        | 不可逆：进程被杀，未落盘的中间态丢失（未提交的 worktree 改动仍在盘上） |
| I-3 | `awaiting_review` / `awaiting_human` 这类**等人**的任务同样会被收割 | 开启后所有部署                          | 同上                                        | 人回来时任务已是 `canceled`，需 resume/retry                           |
| I-4 | **`interrupted` 任务树开始进入归档删除面**（今天永远不删）          | **开启了 `taskArchive.enabled` 的部署** | 随既有 `taskArchive` 开关；该开关本身默认关 | **不可逆**：出库后前台 404，与不存在同形，无在线回看                   |
| I-5 | 开启收割但未开 `worktreeAutoGc` 时，僵尸的 worktree 仍占盘          | 开启后所有部署                          | `worktreeAutoGc` 默认关                     | 无损失，只是磁盘不自动释放；设置页给提示                               |

> I-4 是本 RFC 唯一一条**扩张既有不可逆删除面**的改动，用户已就此单独确认（2026-09-02，选项「纳入既有
> 归档器的终态集」）。它只在 `taskArchive.enabled=true` 时生效，且仍受 `retentionDays` 保护。

---

## 6. 验收标准

功能（用户可见行为）：

- AC-1：`taskIdleTimeout.enabled=false`（默认）时，任何任务都不会因不活跃被终结；行为与今天逐字节一致。
- AC-2：开启且 `idleHours=H` 时，一棵**全部成员**都超过 H 小时无动作、且**至少有一个成员非终态**的任务树，
  会在下一次巡检时被收割：树内每个非终态任务变 `canceled`，`finished_at` 为收割时刻。
- AC-3：树内**任一**成员在 H 小时内有过动作（agent 事件 / 新 node_run / 评审决策 / 反问答复 / 问题派发决策
  落库）时，整棵树不被收割。
- AC-4：`pending` 任务的 `started_at` 计入活动时间——刚创建的任务绝不会被立刻收割。
- AC-5：收割前对树内非终态 node_run 的活进程执行 `killStaleRunProcessTree`；outcome 记入审计。
- AC-6：进程杀不掉（`kill-failed` / `window-expired` / `command-mismatch`）时任务**仍然**被判 `canceled`，
  审计与日志写明 outcome（AC-5 的补充，锁 D11）。
- AC-7：被收割任务的 `error_summary` 为 `task-idle-timeout`，`error_message` 含「静默多久 / 阈值多少」；
  任务详情页渲染**中文**原因文案与提示，不暴露英文机器 token。
- AC-8：每次收割写一条 `recovery_events`（kind=`idle-timeout-reap`），任务详情页「恢复」区可见；
  未收割任何东西的巡检**不写**空审计。
- AC-9：收割后的任务作为普通终态任务参与既有 `taskArchive`：`taskArchive.enabled=true` 且过了
  `retentionDays` 时正常出库。
- AC-10：`taskIdleTimeout.enabled=true` 而 `taskArchive.enabled=false` 时，僵尸只被终结、**不出库**、仍可查看。
- AC-11：一棵全 `interrupted` 的树，在 `taskArchive.enabled=true` 且过了 `retentionDays` 后会被正常归档出库
  （今天不会）。
- AC-12：`idleHours` 的可配范围为 1–8760 小时、出厂默认 168（7 天）；设置页与后端保存门同源校验，越界拒绝。
- AC-13：设置页新增卡片含开关 + 阈值；当 `worktreeAutoGc` 关着时给出「磁盘不会自动释放」提示并指向那张卡。
- AC-14：巡检对**已软删除**（`deleted_at` 非空）的任务不做任何处理。
- AC-15：SQLite 与 PostgreSQL 两个 provider 行为一致，且收割器注册为**可暂停**后台写手——数据库迁移冻结
  窗口内不写库（RFC-349 冻结不变量）。
- AC-16：配置改动**热生效**，不需要重启 daemon。
