# RFC-303 Webhook MR/PR 终态联动取消 — 技术设计

状态：**In Progress（2026-08-14；D1-D8、C1-C6、A1-A5 已获用户批准，实施中）**

## 1. 当前事实与缺口

| 能力                         | 当前源码锚点                                                                                          | 缺口                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 归一事件与 Trigger wire      | `packages/shared/src/schemas/webhook.ts`                                                              | 已有 `mr_closed/mr_merged`，规则没有 terminal-control 选项                           |
| GitLab/GitHub 事件适配       | `packages/backend/src/services/webhook/gitlabAdapter.ts`、`githubAdapter.ts`                          | open/reopen 已同归 `mr_opened`，可由持久 stream 前态区分 reopen                      |
| 规则匹配与 stream key        | `packages/backend/src/services/webhook/matching.ts`                                                   | `eventTypes` 在任何取消逻辑前拦掉 terminal event                                     |
| delivery/trigger dispatch    | `packages/backend/src/services/webhook/webhookDispatch.ts`                                            | 队列键是 `triggerId + streamKey`；terminal 只能走“匹配→supersede→再 launch”          |
| execution 入口               | `packages/backend/src/services/execution/executor.ts`                                                 | 只暴露按 task id 的通用取消，没有 source-bound terminal participant                  |
| task 状态与 active driver    | `packages/backend/src/services/task.ts`、`packages/backend/src/services/lifecycle.ts`                 | Abort reason 默认等同 user；5 秒 fallback 不等于 driver/process 已 settle            |
| 子进程终止                   | `packages/backend/src/services/execution/managedProcess.ts`                                           | 已有 SIGTERM→默认 10 秒→SIGKILL/unkillable 语义，但 terminal control 尚未接入        |
| Webhook 终态工作区清理       | RFC-300；`packages/backend/src/services/gc.ts`、`lifecycle.ts`、`webhook/terminalWorkspaceCleanup.ts` | 已能在 done/canceled 时 durable claim、owner release 后清理；本 RFC 必须复用而非直删 |
| Trigger 编辑面与 delivery UI | `packages/frontend/src/components/webhooks/TriggersPanel.tsx`、`DeliveriesPanel.tsx`                  | 无选项、冲突诊断、terminal-control audit                                             |

### 1.1 为什么“把 closed/merged 加进 eventTypes”不是方案

当前 `dispatchOne` 只对匹配后的 fire 做 supersede。用户把 terminal 类型加入规则后，旧 task 的确可能被取消，
但同一条路径随后继续解析目标并启动一个新 task。它还存在四个结构性问题：

1. terminal 是否能取消取决于 live trigger 是否仍 enabled/存在，违反启动快照；
2. 多个规则的同 MR 任务互相不可见，队列也不是 endpoint+MR 的统一线性化点；
3. daemon 在 delivery 与 `cancelExecution` 之间崩溃没有 durable stop intent；
4. 原因被写成 user cancel，状态变 canceled 后也没有“driver/process 已释放”的可靠 receipt。

因此本 RFC 把 terminal 当成 integration-owned 控制事实，不把它伪装成一种特殊 launch fire。

## 2. RFC-294 目标架构落位

### 2.1 Bounded context 与依赖方向

| 责任                                      | Owner / layer                                                       | 公开交互                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| MR stream identity、状态机、revision      | `integration/domain`                                                | integration 内部 value object/event decision                                |
| verified delivery 线性化、launch guard    | `integration/application` + `integration/infrastructure`            | 向 task launch 交付只读 termination snapshot                                |
| terminal/reopen durable effect worker     | `integration/application` + managed background job                  | 调 `task-execution/public/participants` 的窄 source-termination participant |
| task fence、cancel lifecycle、child sweep | `task-execution/domain/application`                                 | task-execution 自己的 canonical writer                                      |
| driver stop/reap                          | `task-execution/ports` + 当前 active-driver/managed-process adapter | `requestStop` / `awaitStopped`                                              |
| workspace prune                           | RFC-300 task-execution/source-control 既有链                        | canceled CAS claim + driver finally；integration 不接触 Git/FS              |

依赖方向固定为 `integration -> task-execution public participant`。integration 只能传 opaque binding、stream
revision 与 closed terminal cause，不能传任意 task id 或调用通用 cancel；task-execution 自己按 binding 选择和
控制 task。task-execution 不反向查询 trigger/stream 表，所有必须持续生效的事实都落在 task-owned snapshot/fence。

### 2.2 本 RFC 承担的架构演进

新增生产逻辑按 RFC-294 直接落在：

```text
packages/backend/src/modules/integration/
  domain/                 # stream state/revision/binding/纯决策
  application/            # ingress linearizer、launch guard、control worker
  infrastructure/         # SQLite stores/lease claims
  composition/            # required task participant/clock/wakeup ports

packages/backend/src/modules/task-execution/
  domain/                 # source fence、TaskStopCause、receipt 归约
  application/            # applySourceTerminationEffect
  ports/                   # TaskDriverSupervisor
  public/participants.ts  # 唯一跨 context surface
```

现有 `services/webhook/*` 只保留 HTTP/legacy dispatch adapter，转交 integration application，不再新增 task/GC
直调；现有 `services/task.ts` 的 canonical lifecycle 与 active controller 先作为 task-execution 内部 adapter 被收编，
不得形成从 integration 到 legacy service 的新 facade。

### 2.3 显式过渡债务与零新增偏离

- RFC-294 W3 完成前，task status 的物理 writer 仍是 `services/lifecycle.ts`，active controller 的物理 registry
  仍在 `services/task.ts`。本 RFC 抽出 `TaskDriverSupervisor` 和 task-execution application owner，但不复制状态机；
  W3 后删除 adapter，participant contract 保持。
- RFC-294 W4 完成前，Webhook HTTP route/验签/adapter 仍在 `services/webhook`。本 RFC 把新增 domain、持久
  control 与 worker 全部放进 integration module，旧 dispatcher 仅装配/转发；W4 后删除转发壳。
- managed job 使用 RFC-294 的 instance-owned job contract，由 bootstrap 注入并在 shutdown await；不新增 ambient
  singleton 或 `registerX` 全局可变 seam。

除以上对存量物理位置的受控 adapter 外，本 RFC 不新增 cross-context internal import、god port、通用 cancel
capability、route→DB 或 webhook→Git/FS 偏离。

## 3. Shared contract 与 Trigger 规则

### 3.1 Wire 字段

`WebhookTrigger`、create 与 update schema 增加：

```ts
cancelOnMrTerminal: boolean
```

- create omitted → `false`；
- update omitted → 保留旧值；
- read 总是返回显式 boolean；
- 字段进入 draft history、dirty/reset、复制/编辑、只读投影和导入导出（若当前 Trigger contract 支持）同一
  shared schema，不能只在前端本地保存。

DB 在 `webhook_triggers` 增加 `cancel_on_mr_terminal INTEGER NOT NULL DEFAULT 0` 与 boolean CHECK。旧 writer
省略列时自然得到 false。

### 3.2 组合校验

唯一合法谓词：

```text
cancelOnMrTerminal = false
OR (
  eventTypes contains mr_opened
  AND eventTypes contains neither mr_closed nor mr_merged
)
```

create/update 的 shared/application 校验都使用同一个纯函数，冲突返回稳定 422：

```text
webhook-trigger-terminal-policy-conflict
```

SQLite CHECK 只能锁 boolean，不能可靠跨列解析 `event_types` JSON，因此 dispatcher 每次读取 fresh trigger 后也调用
同一 validator。raw SQL/旧坏数据形成冲突时，该 trigger 的新 launch 记 `skipped-trigger-invalid` 并 fail closed；
已有 task snapshot 的 terminal effect 仍独立执行，不能因 live row 损坏而失去保护。

前端 Events step 复用公共 `<Switch>`，放在事件 checkbox 之后：

- 没选 `mr_opened` 时提示“先选择 MR/PR 打开”，不暗改 eventTypes；
- 已选 terminal launch type 时显示冲突并阻止 Next/Save，不静默取消用户已选事件；
- Review step、Trigger card/read-only view 显示“终态自动停止”状态；
- 默认 draft 目前已有 `mr_opened + mr_updated`，新建规则无需额外操作即可开启；
- 不新增 CSS 私有 switch，不改变现有 Trigger update 权限、owner、revision 或 enable toggle。

### 3.3 开关适用范围

一个合法规则可同时订阅 MR 与非 MR 事件。`mr_*`，以及携 `projectId + mrIid` 的 note/MR-pipeline，都属于
MR-associated launch并创建 termination snapshot；不带 MR identity 的 push/tag/branch-pipeline/note 不带 binding，
不被本功能命中。event type 表明它必属 MR，或 payload 已出现 `mrIid`，却缺完整稳定 identity 时按 §4.1 fail
closed，不能降级成 unprotected task。

`cancelOnMrTerminal=false` 的规则继续使用当前匹配语义，包括显式订阅 closed/merged 后启动 task。terminal
stream state 不得在默认关闭时静默改变这类 legacy launch。

## 4. MR stream identity、revision 与状态机

### 4.1 Identity 与 opaque binding

现有 launch/circuit stream key 是：

```text
streamKey = `${repoPath}|mr:${mrIid}`
```

它保留给既有 per-trigger fire/circuit 兼容，但不能作为终态 identity：project/repository 改名或 namespace 转移会改变
`repoPath`，使 opened task 与 close/merge 失配。RFC-263 已在 normalized event 软提取 GitLab `project.id` / GitHub
`repository.id` 为 `projectId`；两平台 MR/PR number 都由 `mrIid` 承载。因此本 RFC 的稳定 identity 是：

```text
mrStreamKey = JSON.stringify(["mr-stream-v1", projectId, mrIid])
identity    = (endpointId, mrStreamKey)
```

开启保护的 MR-family launch 必须同时有 non-empty `projectId` 与 `mrIid`；缺任一项就记录
`skipped-mr-stream-identity-missing` 并停止 launch，不能降级为 repoPath 绑定。terminal event 缺 identity 时按现有
“平台侧决定不处理”返回语义记录明确 delivery reason/lifecycle alert，不能猜测目标或谎称已取消。option=false 的
legacy launch 与非 MR 事件保持当前宽松 contract。

endpoint 已绑定 provider/credentials，project ID + IID/number 在 endpoint 内稳定唯一；repo rename/transfer 不改变
identity。task 不解析或拼接该结构；integration 用无歧义 canonical tuple 生成 opaque binding：

```text
canonical = JSON.stringify(["code-host-change-v1", endpointId, projectId, mrIid])
binding   = "st1:" + sha256(canonical).hex()
```

binding 不是 secret，也不是授权 token；hash 只防止 task-execution 反向依赖 integration 的 repo/MR 字段。外部请求
不能提交 binding，Task API wire 也不暴露它。

### 4.2 持久 stream state

integration-owned `webhook_mr_stream_states`：

| 列                        | 语义                                            |
| ------------------------- | ----------------------------------------------- |
| `endpoint_id, stream_key` | 复合主键                                        |
| `state`                   | `open \| closed \| merged`                      |
| `revision`                | 每个去重后的 MR-family delivery 线性化时严格 +1 |
| `last_terminal_revision`  | 最近一次 close/merge revision；reopen 后也保留  |
| `last_delivery_id`        | 审计 soft link                                  |
| `updated_at`              | 运维时间，不参与事件重排                        |

不存在的行等价于 open/revision 0。revision 在代码平台新 delivery 的 verified ingress 事务内分配；不按 provider
timestamp、HTTP 完成顺序或 worker 完成顺序重排。SQLite 当前单 daemon 由短事务给出唯一顺序，未来多 worker
仍以条件 UPDATE/CAS 分配同一 revision。管理 API 对 terminal delivery 的手工 replay 不是新的代码平台事实：它
沿 `replayed_from_delivery_id` 解析原始 root delivery，复用原 revision/effect并只 wake/retry，不推进 stream。

`webhook_deliveries` 增加 nullable `mr_fact_key / mr_stream_key / mr_stream_revision / mr_state_after`，让
dispatch/replay 使用当次已线性化事实而不是事后猜 live state。MR fact key 取：

```text
provider eventUuid 存在："id:" + provider + ":" + eventUuid
否则："body:v1:" + sha256(provider + "\0" + normalizedEventType + "\0" + rawBodyBytes)
```

以 `(endpoint_id, mr_fact_key)` partial unique 去重，WHERE 与既有 provider-ingress 接受态语义一致，并排除
`replayed_from_delivery_id IS NOT NULL`；hash 在 1 MiB ingress 原始字节上计算，不用已截断的 audit body。terminal
replay audit row 可复制 root fact/revision，但因 replay lineage 不参与唯一索引。完全相同且无 UUID 的代理重投因此
仍复用原 revision/effect；无法区分的 exact-body 新事实宁可按同一事实处理，避免旧 close 在 reopen 后误杀。非
MR delivery 四列全 NULL，继续沿现有 nullable UUID 降级语义。

### 4.3 状态转移

| 当前状态    | `mr_opened`                | `mr_updated`/其它 MR-associated | `mr_closed`                | `mr_merged`                |
| ----------- | -------------------------- | ------------------------------- | -------------------------- | -------------------------- |
| absent/open | 保持 open；正常 opened     | 保持 open                       | closed + close effect      | merged + merge effect      |
| closed      | open + reopen-clear effect | 保持 closed                     | closed + 幂等 close effect | merged + merge effect      |
| merged      | 保持 merged；absorbed      | 保持 merged；absorbed           | merged + 幂等 merge effect | merged + 幂等 merge effect |

每个去重后的新 provider 事件仍获得新 revision；terminal 管理 replay 按 §4.2 例外复用原 revision。`merged` 是
吸收态；任何 opened/reopened 都不能降级。closed→opened 由“前态 closed + normalized mr_opened”判定，不要求
adapter 暴露 GitLab `reopen`/GitHub `reopened` 私有 action。

对于开启保护的规则：closed/merged 下所有 MR-associated 非 reopen launch 都记录
`skipped-mr-stream-closed/merged`；closed→open 后的 opened/update/note/MR-pipeline 可以 launch。未开启保护的
规则不应用这道 launch gate。

## 5. 启动快照与 terminal-race barrier

### 5.1 为什么只在 launch 前读一次 stream state 不够

Webhook launch 可能在 clone、worktree materialization 或目标解析中停留。若流程在 terminal 到达前读到 open，
terminal worker 又在 task row 出现前扫描到零目标，之后旧 launch 才落 task，就会形成“终态已处理但任务仍启动”
的漏停窗口。因此需要 durable launch guard，而不是 sleep/重复扫几次。

### 5.2 Launch guard

integration-owned `webhook_mr_launch_guards` 每个受保护的匹配 fire 一行：

| 列                 | 语义                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `id / fire_id`     | 稳定 ID；与最终 fire/task attribution 对接                                                                     |
| `delivery_id`      | soft link                                                                                                      |
| `trigger_id`       | soft snapshot；不设 cascade FK                                                                                 |
| `trigger_name`     | guard 创建时的受控显示快照；trigger 删除后仍可解释来源                                                         |
| `binding`          | opaque stream binding                                                                                          |
| `stream_revision`  | 产生 launch 的事件 revision                                                                                    |
| `status`           | `reserved \| launching \| revoking-terminal \| task-committed \| launch-settled \| aborted-terminal \| failed` |
| `task_id`          | task initial INSERT 成功后填写                                                                                 |
| `updated_at/error` | redacted audit/recovery                                                                                        |

规则 match 且通过 fresh-trigger/circuit 纯门后就创建 guard；它必须早于 auto-register、repo clone/fetch、workspace
materialization 与任何外部 launch 副作用。owner/target 等只读 preflight 可以在 guard 前后执行，但所有失败都必须把
guard 收为 `failed`。launch 在 repo/空间物化前与 initial task INSERT 前各检查：

guard commit 是本次 launch 对 `cancelOnMrTerminal` 的配置线性化点：之后 trigger toggle/edit/delete 不撤销该
guard；task INSERT 必须逐字携带 guard 已冻结的 binding/revision，不能再按 live trigger 重算。

```text
stream.state permits protected launch
AND stream.last_terminal_revision <= guard.stream_revision
AND guard is still reserved/launching
```

第二次失败时用既有 materialization ownership cleanup 回收尚未提交的工作区，guard 记
`aborted-terminal`，fire 记 `skipped-mr-stream-terminal`，不建 task。

terminal 线性化时把更早的 `reserved/launching` guard durable 标为 `revoking-terminal`，commit 后经一个窄的
WebhookLaunchSupervisor 向 process-local launch owner 发 abort。Webhook 路径的 repo clone/fetch、auto-register 与
materialization 所用长进程必须接该 signal并按 source-control/managed-process 的进程组协议 kill+reap；共享 cache
只按既有 ownership/lock 清理半成品，不能直接递归删。极短、不可中断的原子 FS 调用可完成后再命中第二道 gate，
但 effect 保持 `waiting-launches`，在 guard/进程/临时空间 settle 前不能声称资源已释放。

若 terminal 恰好在第二次检查后、task INSERT 前到达，terminal effect 不能完成：它等待所有
`binding 相同且 guard.revision < terminal.revision` 的 guard 进入最终态，并在等待期间持续/被通知重扫 task binding。
task INSERT 后 guard 先记 `task-committed`；只有 §8.2 的 owner attach 线性化完成（driver 已 attach，或因 fence/status
拒绝且确认无 owner）才记 `launch-settled`。`task-committed` 仍是 barrier-open 中间态，不能当 launch 完成。这样
terminal 落在“task row 已有、controller 尚未注册”的窗口时，要么 attach 先赢并被 stop，要么 fence 先赢使 attach
失败，绝不会先报 no-active-owner/released 后又挂上 driver。

task INSERT 一定先于 guard `task-committed`，owner attach/refusal 一定先于 `launch-settled`；所以 barrier 清空后的
最后一次 task/owner sweep 不可能漏掉旧 launch。daemon 若在任一 guard update 间崩溃，boot reconcile 以
`tasks.webhook_fire_id` + binding、task status/fence 与 orphan-owner 结果修复 guard，再续做 terminal effect。

### 5.3 Task-owned snapshot

内部 Webhook `ExecutionInvoker` 增加不可由 route/body 构造的：

```ts
type TaskSourceTerminationSnapshot = {
  kind: 'code-host-change-v1'
  binding: string
  launchRevision: number
}
```

task initial INSERT 原子写：

| tasks 列                        | 规则                                              |
| ------------------------------- | ------------------------------------------------- |
| `source_termination_binding`    | nullable opaque binding                           |
| `source_termination_launch_rev` | binding 非空时必为正整数                          |
| `source_termination_fence`      | nullable `closed \| merged`                       |
| `source_termination_effect_rev` | 最近应用 task effect revision；无 snapshot 时为 0 |

DB CHECK 锁定 nullability/value 组合，索引 `(source_termination_binding, source_termination_launch_rev,
status)` 支持 effect target sweep。字段是内部执行约束，不进入 `Task/TaskSummary` 或 create/update wire。

call-workflow/call-workgroup child 在读取 parent 的同一 initial INSERT 事务内继承四列，调用方不能覆盖。这既让
terminal participant 能发现异常孤儿 child，也让任何 child revival gate 不必跨 context 查询根或 live trigger。

## 6. Durable control effect

### 6.1 Ingress 原子边界

验签、payload size/schema 与 endpoint 校验通过后，新 MR-family provider delivery 在返回 2xx 前用一个短事务：

1. 按 event UUID / MR fact-key fallback 去重插入 delivery；
2. 锁定/更新 stream state 并分配 revision；
3. 对 close/merge/reopen 插入 `webhook_mr_control_effects`；
4. commit 后唤醒对应 stream worker。

事务失败就不返回已接受成功，不允许留下“delivery 已 ACK、terminal intent 不存在”的窗口。task stop/process wait
不在 HTTP 事务或响应路径内执行，避免代码平台 webhook timeout。

UUID/fact-key duplicate 复用原 delivery/revision并增加既有 attempt count；若原行有关联 control effect，duplicate 路径
也 wake 该 effect，而不是像普通已完成 launch 一样直接返回后完全不触碰 worker。

terminal replay route 在自己的新 audit delivery 事务内解析原始 root delivery/effect，复用其 stream revision，增加
attempt/replay 关联并 wake 原 effect；如果 lineage/原 effect 损坏则 fail closed，不把旧 payload 重新线性化成当前
stream 的新 close/merge。非 terminal replay 继续按现有“新 delivery、重新评估规则”语义，并获得自己的 revision。

### 6.2 Effect 与 target ledger

`webhook_mr_control_effects`：

- identity：`id, delivery_id, endpoint_id, stream_key, binding, stream_revision, observed_event_type`；
- kind：`fence-closed | fence-merged | clear-closed`；
- status：`pending | leased | waiting-launches | retryable | succeeded`；
- claim：`claim_epoch, lease_until, next_attempt_at, attempt_count`；
- result：目标/取消/released/unreaped 计数、redacted `last_error_code/message`、时间戳；
- unique `(endpoint_id, stream_key, stream_revision)`，重复 fact/replay 只能读取或推进同一 effect。

不设 trigger FK。delivery retention 只允许删除 `succeeded` effect 的明细；pending/retryable/waiting effect 与其
delivery 不进入 retention。失败采用有上限 backoff 的无限续做并在阈值后产生 lifecycle alert，不把 effect
自动变成“永久失败且不再尝试”。

`webhook_mr_control_targets` 以 `(effect_id, task_id)` 唯一，保存：

- `prior_status`；
- `fence_outcome = applied | cleared | already-newer | no-op`；
- `cancel_outcome = canceled | already-terminal | not-required | failed`；
- `release_outcome = no-active-owner | released | pending | unreaped | not-required`；
- 安全错误码、尝试次数与更新时间。

Trigger 删除不会删 action/target；delivery 详情可在 task 软删除或 trigger 删除后继续解释发生过什么。

### 6.3 Stream worker 顺序与低延迟

每个 `(endpointId, streamKey)` 的 control effect 按 revision 应用；不同 stream 并行。terminal effect 被唤醒后先
立即对当前可见 task 发 stop，再等待更早 launch guard barrier，不能为了一个仍在 clone 的旧 launch 推迟停止
已经 active 的任务。barrier 期间 guard/task commit 会主动 wake，后台 lease scan 仅作 crash recovery，不做高频
poll。

close→reopen 必须先完成 close 的 cancellation/fence，再应用 reopen clear；因此旧任务一定经历过停止，不会因
worker 调度反序漏停。reopen 后的新 task 带更高 launch revision，close effect 的 target 条件
`launchRevision < closeRevision` 不会误杀它。

## 7. Task-execution public participant

### 7.1 窄 capability，而不是 generic cancel

task-execution 暴露：

```ts
interface TaskSourceTerminationParticipant {
  apply(
    capability: SourceTerminationEffectCapability,
    input: {
      effectId: string
      binding: string
      streamRevision: number
      kind: 'fence-closed' | 'fence-merged' | 'clear-closed'
      deliveryId: string
    },
  ): Promise<readonly TaskSourceTerminationReceipt[]>
}
```

capability 由 bootstrap 只注入 integration 的已持久认领 effect consumer，并绑定 exact effect id/binding/revision；
route、MCP、trigger owner 或普通 daemon actor 都不能 forge。participant 不接受 caller 提供的 task id，不暴露
resume/retry/delete，也不读取 integration 表。

task-execution 先校验 capability 与 input 一致，再查询自己的 snapshot index。目标限定：

```text
source_termination_binding = effect.binding
AND source_termination_launch_rev < effect.streamRevision
```

closed/merged 对所有命中行单调写 task fence；reopen 只清 `closed`，绝不能清 `merged`。同一 task 的
`source_termination_effect_rev` CAS 防止迟到的旧 effect 覆盖较新结果。

### 7.2 Canonical 状态写与 child fixed point

对 close/merge，participant 在 task-execution owner 内完成：

1. 用 task review/cancel coordinator 与 lifecycle CAS 写 fence/revision；
2. `pending/running/awaiting_review/awaiting_human` 转 `canceled`，同一 CAS 继续触发 RFC-300 policy；
3. 提交后发 classified `TaskStopRequested`，再 signal driver；
4. 从 binding 任务树的最上层 target 开始走 canonical child cascade；
5. 重扫 binding，直到没有可取消 task、没有正在创建且继承旧 revision 的 child；
6. 等所有命中的 active owner settle，返回 per-task receipt。

child initial INSERT 必须在 parent lifecycle/fence 读取事务内继承；若 parent 已 fenced/canceled，launch admission
fail closed。这样 terminal 与 call child create 竞争只有两种结果：child 先提交后被 sweep/cascade，或 parent
fence 先赢导致 child 根本不启动。

already done/failed/canceled/interrupted 行仍写 fence/revision并返回 `already-terminal`，不改终态；但“already
terminal”不是 owner-release 证明，若 active driver 仍注册，participant 仍 requestStop/awaitStopped 后才给 release
receipt。它们在 fence 存在期间的所有 driver-attaching 入口统一 409：

```text
task-source-terminal-closed
task-source-terminal-merged
```

覆盖 resume、retryNode、sync-and-resume、review/clarify continuation、lifecycle repair revival、boot auto-resume 与
child launch。relaunch 创建独立新 task，仍按它自己的来源/stream admission 判断。

### 7.3 Reopen

`clear-closed` 只把 revision 更旧且 fence=`closed` 的 task 置 NULL；不改 status、node-run、错误、workspace claim
或已释放资源。canceled task 仍受既有 lifecycle 限制；failed/interrupted 等本来可 revival 的任务重新通过其原有
校验。merged fence 永不清除。

## 8. 取消原因与 driver/process settlement

### 8.1 Closed abort reason

task-execution domain 定义 closed union，兼容现有 daemon shutdown/user/cascade：

```ts
type TaskStopCause =
  | { kind: 'user' }
  | { kind: 'daemon-shutdown' }
  | { kind: 'parent-cascade'; parentTaskId: string; rootCause?: WebhookTerminalCause }
  | {
      kind: 'webhook-terminal'
      terminal: 'closed' | 'merged'
      deliveryId: string
      streamRevision: number
    }
```

`AbortController.abort(cause)`、scheduler abort checkpoints 与无-controller fallback 使用同一个纯投影：

| cause  | root task `errorSummary` | stable detail/code                            |
| ------ | ------------------------ | --------------------------------------------- |
| closed | MR/PR 已关闭，任务已停止 | `webhook-mr-closed` + safe delivery reference |
| merged | MR/PR 已合入，任务已停止 | `webhook-mr-merged` + safe delivery reference |

不得回落到 `canceled by user`。child 继续保留现有 `canceled-by-parent-cascade` marker，另由 control target ledger
关联 root cause，避免破坏 call-node crash recovery 的既有判据。原始 webhook payload、URL credential、token 不进入
task error 或 log。

### 8.2 TaskDriverSupervisor

从当前 `activeTasks` owner 抽取 task-execution port：

```ts
interface TaskDriverSupervisor {
  tryAttach(
    taskId: string,
    controller: AbortController,
  ): Promise<'attached' | 'rejected-status-or-source-fence'>
  requestStop(taskId: string, cause: TaskStopCause): Promise<StopTicket | 'no-active-owner'>
  awaitStopped(
    ticket: StopTicket,
  ): Promise<{ kind: 'released' } | { kind: 'unreaped'; code: string }>
}
```

- `tryAttach` 与 terminal fence/status CAS 使用同一 task ownership coordinator；start、resume、retryNode 三条
  `activeTasks.set + runTask` 路径全部收编，不能在 preflight 后裸注册 controller；
- attach 先赢：terminal commit 后能看到 exact controller并 stop；fence/status 先赢：attach 返回 rejected，调用方
  不启动 scheduler并收口对应 launch guard；
- `requestStop` 在 canceled/fence commit 后立即调用，不能等待当前 node 自然结束；
- managed process 收 abort 后按既有统一协议 SIGTERM，默认 10 秒后进程组 SIGKILL；
- `awaitStopped` 等 scheduler finally、pool permits、runtime leases、child driver 与 managed process registry settle；
- 不复用当前 5 秒“看 task status”轮询作为 released 证明；task canceled 与 driver released 是两个状态；
- no active owner 的 pending/awaiting task 可立即 receipt `no-active-owner`；
- unreaped/unkillable 返回具体内部 code，control effect 保持 retryable/alert，不写 released。

daemon crash 后 boot 顺序固定为：单实例锁 → orphan process/session lease repair → TaskDriverSupervisor ready →
terminal effect reconcile → HTTP listener/auto-resume。旧 daemon 已死时，orphan repair 是 released 证明来源。

### 8.3 Commit fence 与无法撤回的副作用

canceled lifecycle CAS 使后续 task terminal CAS 失败；scheduler 在 node dispatch、retry、review/clarify continuation
与外部 call 前继续检查 signal + task fence/status，不再派发新工作。已经进入第三方系统或内核、无法原子撤回的
commit/push/comment/approve/API 调用可能完成，本 RFC 只记录它在 terminal 前已 in-flight，不伪造回滚保证。

## 9. 与 supersede、circuit、trigger mutation 的组合

1. **普通 opened/update**：先按 stream state gate，再走现有 trigger match、circuit 与 per-trigger supersede；保护
   开启时创建 guard/snapshot。
2. **terminal**：ingress control 与 live trigger 匹配解耦。trigger disabled/edited/deleted 不妨碍 binding target；
   开启保护的规则不建 terminal fire/task。已验签 terminal 对 frozen binding 的控制不再重跑 live repoScope、
   branchFilter、ignoreUsernames、owner status 或 circuit；否则这些后续可变条件会撤销 D3 的启动快照。
3. **legacy terminal launch**：保护关闭且显式订阅 terminal 的规则照旧 launch，且该 terminal task 不带 binding，
   不会被同一 control effect 自杀。
4. **circuit**：terminal control 永远不受 launch circuit 阻挡；它也不增加 consecutive fire 计数。reopen/open 的
   新 launch 仍按既有 circuit。
5. **superseded task**：如果早已被 update supersede 为 canceled，terminal effect 只补 fence/receipt；不改成第二种
   canceled 状态。
6. **live toggle**：`false→true` 只让未来 task 冻结 binding，不追溯旧任务；`true→false` 不清旧 snapshot。若
   stream 当前 closed/merged，新开启保护的 trigger 仍受 stream gate，直到合法 reopen（merged 无解锁）。

## 10. RFC-300 工作区清理交互

本 RFC 唯一调用点是 canonical transition `to: canceled`。RFC-300 继续在同一 lifecycle CAS 按**当时全局配置**、
`webhook_trigger_id`、space kind 与 tombstone 判断是否写：

```text
workspace_pruning_at = now
workspace_prune_cause = 'webhook-terminal'
```

之后：

- active driver 存在：只 claim；driver finally identity-delete owner 后调用 claimed finalizer；
- no active driver：post-commit effect/专用 recovery 可立即 finalizer；
- 全局开关 off、internal/inherited：不 claim，workspace 保留；
- 删除失败：task cancellation/control 的 runtime release 可成功，workspace 维持 pruning claim 并由 RFC-300 重试；
- reopen 不清 prune claim、不恢复已删磁盘；已经 canceled 的旧 task 也不自动 revival。

integration 不 import `gc.ts`、不读 config、不接受路径、不声称 workspace 已删。delivery detail 分别显示 runtime
release receipt 与 task 当前 `workspaceState`，避免把两类结果混成一个 success。

## 11. Delivery、Fire 与 UI 读模型

### 11.1 Delivery status

- delivery + durable control intent commit 后可以结束 HTTP 请求；
- 每个 close/merge/reopen 都创建 effect，零目标 effect 也会幂等 succeeded，避免用 live trigger/task 查询决定是否
  持久化关键事实；
- delivery 的业务 outcome 与内部 effect 存在性分开：命中 frozen target、使旧 launch guard 失效或有 legacy
  launch match 时记 matched/control-accepted；零 target、零 guard impact 且无 legacy match 时仍可记 ignored；
- effect 的 pending/waiting/retryable/released/unreaped 是独立异步状态，不能把 delivery matched 解释为资源已释放。
- terminal control 已 durable accepted 后，旁路 legacy launch/fire 的失败只能记在对应 fire，不得把 delivery 降成
  可被 dedupe 当作“从未处理”的 failed；control effect 自己按 lease/retry 状态暴露失败。

### 11.2 Fire outcome

`webhook_trigger_fires` 仍表示 delivery×trigger 的 launch 评估，不作为 terminal control ledger：

- terminal control-only 不插一条假 fire；
- protected launch 因 closed/merged 或 guard 二次检查失败时增加
  `skipped-mr-stream-closed | skipped-mr-stream-merged | skipped-mr-stream-terminal`；
- fresh trigger 的 option/eventTypes 组合损坏时记 `skipped-trigger-invalid`，不进入 launch/supersede；
- trigger FK cascade 的现有行为不影响 control/target audit。

### 11.3 Frontend

`DeliveriesPanel` 在 MR terminal/reopen delivery 展示可折叠“终态控制”区：

- terminal/reopen 类型与 stream state；
- pending/waiting/retrying/succeeded；
- target task link、prior status、cancel/fence/release 三列结果；
- workspace available/pruning/pruned 单独显示；
- trigger 已删时显示 frozen name/id（若快照存在）或“原规则已删除”，不隐藏 action。

delivery API 按当前 actor 对每个 target 再做 task 可见性投影：无 task 读权时只返回聚合计数/受控 outcome，不返回
task id/name/link；有权时才返回 link，打开后仍由 task 自身 ACL 复核。i18n 中英文 1:1，390px 使用现有响应式
表/stack，不引入页面横向 overflow。

## 12. 并发与失败矩阵

| 场景                                      | 预期结果                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| active task 与 close/merge                | intent 先落库，立即 stop；task canceled/fenced；driver settle 后 receipt released           |
| terminal 与 task 正常 done 竞争           | lifecycle CAS 单一赢家；done 先赢则 already-terminal+fenced，不能覆写成 canceled            |
| terminal 与 review/clarify decision       | coordinator + fence 单一赢家；terminal 先赢则 decision 409，decision 先赢仍由 stop 接管     |
| terminal 与 child create                  | child 先提交则 sweep/cascade；parent fence 先提交则 child admission fail                    |
| terminal 与慢 launch                      | guard 二次 gate 阻止；若临界点后 INSERT，effect 等 guard 并最终扫到，不会漏停               |
| terminal 与 clone/materialize             | durable revoke 后 signal launch owner并 kill/reap 长进程；guard settle 前 effect 不成功     |
| close→late update                         | protected trigger skip；legacy unprotected trigger保持当前行为                              |
| close→reopen                              | old task 先 stop/fence，再 clear closed；不自动复活；新 launch revision 不被旧 close 误杀   |
| reopen→close                              | reopen task revision 小于新 close revision，被新 close 正常取消                             |
| merge→opened/update/close                 | merged 吸收；protected launch/revival永久阻止                                               |
| close 与 merge 连续到达                   | revision 顺序应用；最终 merged，close cancellation 与 merge fence 都幂等                    |
| duplicate/terminal replay                 | UUID 或 raw-body fact key dedupe；管理 replay复用原 effect/revision，不关闭 reopen 新 task  |
| 不同 UUID 的新 close/merge                | 分配新 revision；按当前 state 是幂等重扫或一次真正的新终态                                  |
| trigger disable/edit/delete               | live rule 不参与 target；task snapshot继续命中                                              |
| daemon 在 intent commit 后崩溃            | boot 在 HTTP/auto-resume 前 claim effect并续做                                              |
| daemon 在 task INSERT/guard update 间崩溃 | guard reconcile 从 task webhook fire/binding补齐，然后 terminal worker取消                  |
| stop 后 process 10 秒不退                 | 进程组 SIGKILL；成功 reap 才 released                                                       |
| process unkillable/unreaped               | task 可为 canceled，但 effect/target 标 unreaped、重试并 alert，不谎报释放                  |
| workspace delete 失败                     | runtime control 可 succeeded；RFC-300 claim 保留并独立重试                                  |
| effect consumer 重复/lease 过期           | capability + task revision + target unique key 幂等；新 claim epoch 接管                    |
| trigger option true/false 并发更新        | task 以 guard 创建时 fresh trigger revision 冻结；旧 task 不变，未来 launch 观察完整新/旧值 |

## 13. 安全、权限与数据保留

- 只有验签成功、通过 endpoint provider schema 的 normalized event 能改变 stream state；replay 继续要求现有 delivery
  权限与审计，不提供任意 binding/terminal API。
- internal capability 不由 Actor permission 替代；普通 trigger owner 即使能编辑规则，也不能按任意 task id 调系统
  effect。
- binding/task 内部 fence 不进入公开 create/update/read wire，不给客户端制造取消他人 task 的 selector。
- task cancellation 本身是该任务启动时 owner 已选择的规则效果，不改变任务读取 ACL、trigger CRUD 权限或 endpoint
  secret 权限。
- error/audit 只存 provider、event type、delivery/task/trigger soft id、opaque binding 与稳定错误码；不复制 webhook
  secret、Authorization、raw headers、credential URL 或无限原始 body。
- delivery retention 删除 succeeded control detail 前保留任务自己的 fence/cause 投影；pending/retryable effect 与
  launch guard 不被 GC。endpoint/trigger/delivery/task id 在新 control/guard 表均为 soft reference，不以 cascade 删除
  未完成效果或审计。
- stream state 每个 MR 只保留一行 current state/revision，不保留无限事件明细；endpoint 存在期间不按 delivery
  retention 删除 merged/closed fence。endpoint 删除后，只有在无 task binding、guard 与 pending effect 时才可回收
  该 endpoint 的 stream rows。

## 14. Migration 与 rolling compatibility

实施时基于最新已提交 journal 分配下一个空闲 migration 编号，不在 Draft 中预占本地编号。migration 是 additive：

1. `webhook_triggers.cancel_on_mr_terminal`；
2. `webhook_deliveries` 四个 nullable MR fact/stream 列 + partial unique；
3. `webhook_mr_stream_states`；
4. `webhook_mr_launch_guards`；
5. `webhook_mr_control_effects` 与 targets；
6. `tasks` 四个 nullable/default source-termination 列与索引/CHECK。

不回填历史 task binding，不根据 trigger/fire/context 猜保护意图。旧 trigger 得到 false，旧 task 得到 NULL；历史
stream 从第一次新版本 delivery 开始建状态。

旧 binary 在新 schema 上可省略 additive 列并继续运行，但它不会创建 guard/snapshot、不会执行 control worker，
所以部署期间必须保证只有新 daemon 消费 Webhook。新 binary 启动时先跑 migration/guard/effect reconcile。代码回滚
保留新表/列与 fence；旧 binary 可能无法执行新保护，运维必须在回滚说明中明确能力降级，不能把已 canceled/
pruned 的状态伪装成可恢复。

## 15. 测试策略

### 15.1 Shared/domain

- option 默认、create/update preserve、合法/冲突 eventTypes 全矩阵与未知字段；
- GitLab/GitHub normalized terminal parity；
- binding canonicalization/分隔符/Unicode/邻接 endpoint-repo-IID mutation；
- stream 状态表全转移、merged 吸收、revision 单调、payload timestamp 不参与；
- task target cutoff、fence monotonic、reopen 只清 closed、merged 不清；
- TaskStopCause→signal/task projection 1:1，user/daemon/cascade 回归。

### 15.2 Backend integration

- 四个 cancelable task 状态 × close/merge；四个 already-terminal 状态；
- 多 trigger、多 root、多层 workflow/workgroup child、异常 orphan child fixed point；
- trigger disable/edit/delete、option toggle、无 MR identity launch、legacy terminal launch；
- close/update/reopen/merge/duplicate/replay 全顺序与竞态；
- slow launch 的 guard 前门/二次门/INSERT 后 crash seam；
- intent commit crash、effect lease takeover、target idempotency、boot reconcile；
- review/clarify decision、retry/resume/sync/repair/auto-resume 全 revival gate；
- scheduler/node dispatch fence 与已 in-flight 外部副作用边界。

### 15.3 Process 与 RFC-300

- 真实受管进程收到 SIGTERM 并正常退出；忽略 SIGTERM 后默认 10 秒进程组 SIGKILL；child/grandchild 不残留；
- unreaped seam 不返回 released，effect retry/alert；
- fan-out/script/code-host permits、runtime session lease、active driver registry 全部归零；
- RFC-300 开关 off 保留、on 删除 remote/scratch；active-owner defer、delete failure/boot retry、internal/inherited
  排除；control success 与 workspace pruning failure 分开呈现。

### 15.4 Frontend/E2E

- Events Switch、conflict blocker、Review summary、edit/copy/read-only/card、dirty/reset、中英文/a11y；
- DeliveriesPanel pending→waiting→released、unreaped、trigger deleted、task ACL、390px/light/dark；
- 真实 daemon endpoint 发送 GitLab close/merge 与 GitHub closed merged=false/true 签名 payload，mock long-running
  managed runtime 证明 stop；terminal 不建新 task；reopen 新 launch；merged 不 reopen；
- 至少一条 RFC-300 off 与一条 on 的真实 linked worktree/scratch E2E。

### 15.5 架构与回滚棘轮

- integration 不 import task internals/GC/paths，旧 dispatcher 不再直调 cancel；
- public participant 不出现任意 task id selector、generic retry/resume/delete；capability forge 测试；
- Task/Create wire 不出现 binding/fence，客户端同名字段不能控制；
- migration fresh/upgrade/rolling-old-writer，trigger/fire delete cascade 不删 control ledger；
- 定向测试、三包 typecheck/lint/format/depcheck、真实 E2E、`bun run gate:local`；实现门固定 SHA 复核并处置全部
  P1/P2 后才标 Done。

## 16. 回滚

产品级停用分两层：

1. 把 trigger 选项设 false：只影响未来 launch；既有 task snapshot 不撤销；
2. 把 RFC-300 全局 cleanup 设 false：只停止未来 workspace claim，不阻止 terminal cancellation，也不撤销已 claim。

代码回滚按 UI/read model → dispatcher/worker → participant 的逆序做，但 DB 列/表不 DROP。回滚前必须 drain 或明确
保留 pending effect；旧 binary 无法续做时应停止 Webhook consumer并恢复新版本，而不是手工把 effect 标 succeeded。
已经 canceled、已发 SIGKILL、已清 lease/slot 或已删除 worktree 都不可逆；external side effect 也不会回滚。

## 17. 待完整 RFC 请批的设计裁决

除 Proposal D1-D8/C1-C6 外，请同时确认以下实现边界：

- A1：引入 durable stream revision、launch guard 与 control effect，保证慢 launch/crash 不漏停；
- A2：task snapshot/fence 随 child 继承，close/merge 期间统一阻断所有 driver-attaching revival；
- A3：新增逻辑按 RFC-294 integration/task-execution 模块落位，现有 service 只作过渡 adapter；
- A4：runtime released 与 RFC-300 workspace pruned 分开记账，任一方失败不伪造另一方失败/成功；
- A5：终态到达后已 in-flight 且无法原子撤回的外部副作用不保证回滚，只禁止新的 dispatch 并准确审计。
