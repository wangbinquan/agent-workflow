# RFC-303 Webhook MR/PR 终态联动取消

状态：**Done（2026-08-14；D1-D8、C1-C6、A1-A5 已批准，实现与完整本地门禁已完成）**

## 1. 背景

Webhook 触发规则已经能把 GitLab Merge Request 与 GitHub Pull Request 的打开、更新、关闭、合入事件
归一成 `mr_opened / mr_updated / mr_closed / mr_merged`，并可按 `(trigger, MR/PR stream)` 用新事件
supersede 旧任务。

但 supersede 只在事件先命中规则的 `eventTypes` 后发生。一个只订阅 `mr_opened` 的规则在任务运行期间
收到 `mr_closed` 或 `mr_merged` 时会直接忽略该 delivery，已经运行的任务继续占用 runtime、子进程、并发
slot 与工作区。反过来，如果用户把终态事件也加入 `eventTypes`，当前行为会先取消旧任务、再为关闭/合入
事件启动一个新任务，也不符合“终态只负责止损”的需求。

本 RFC 在触发规则上增加一个默认关闭的保护选项：由 MR/PR 打开规则启动的任务冻结该保护策略；同一
MR/PR 后续收到关闭或合入事件时，不等待当前节点自然结束，立即请求停止整棵任务树，并在执行所有权真正
释放后复用 RFC-300 的全局策略决定是否清理磁盘工作区。

## 2. 需求澄清阶段已确认的产品规则

以下 D1-D8 是用户在 RFC 落档前对推荐方案的确认；完整设计、能力影响清单与 A1-A5
也已获显式批准，实现按该批准边界完成。

### D1. 规则级、默认关闭、GitLab/GitHub 共用

Webhook 触发规则新增“MR/PR 关闭或合入时停止运行中的任务”选项，默认 `false`。它使用归一后的
MR/PR 事件语义，同时覆盖 GitLab 与 GitHub，不新增 provider 私有开关。

选项只对包含 `mr_opened` 且不包含 `mr_closed`/`mr_merged` 的规则开放；编辑器也只在这个组合下显示开关。
规则还可以订阅 `mr_updated` 或其它非终态事件；只有带稳定 MR/PR 标识的 launch 才冻结保护绑定，push/tag/
pipeline 等同规则内的其它 launch 保持原行为。

### D2. 终态事件是控制事实，不再为该规则启动终态任务

开启选项后，`mr_closed` 与 `mr_merged` 对该规则是 control-only：它们用于封锁 stream、停止已启动任务和
记录审计，不创建新的 terminal-event task。为消除一条规则内的双义性，开启选项时不得同时把
`mr_closed`/`mr_merged` 放进该规则的 launch `eventTypes`。shared/backend 对直接 API 输入继续 fail closed；编辑器
在组合不适用时隐藏开关并把草稿值原子归 `false`，不保留隐藏的非法值，也不以红色 blocker 打断事件选择。

未开启选项的既有规则完全兼容：如果它显式订阅终态事件，仍可按当前行为启动任务。

### D3. 保护策略随任务启动冻结

受保护 launch 创建 durable guard 时冻结“受哪个 endpoint + MR/PR stream 的终态保护”，task initial INSERT 再把
同一值原子写成 task-owned 快照；不在终态到来时回读 live trigger 决定。之后禁用、编辑或删除触发规则，都不能
撤销已经 reserved/启动任务的保护；只影响之后才开始的新 launch。

### D4. 精确作用域与整棵任务树

终态控制只命中同一 Webhook endpoint、同一平台 project/repository ID、同一 MR/PR IID/number 的冻结绑定，
不能跨 endpoint、跨仓库或跨 MR/PR 误杀；代码库改名/转移但平台 project ID 不变时仍是同一 stream。开启保护的
MR-family launch 缺 `projectId` 或 `mrIid` 时必须以明确原因 fail closed，不能偷偷启动一个无法终态联动的任务；
同规则的非 MR 事件不受这条要求影响。若多个受保护规则为同一 stream 启动了不同根任务，全部命中；每个根任务
再沿现有 parent/child 关系递归取消正在运行或等待中的 call-workflow/call-workgroup 子任务。

可取消状态保持现有闭集：`pending / running / awaiting_review / awaiting_human`。已经完成、失败、取消或中断
的任务不伪装成“被取消”，但会保存 terminal fence，使关闭/合入期间不能通过 resume/retry 重新开始执行。

### D5. Stream fence、reopen 与 merged 的终局语义

- `mr_closed`：stream 进入 `closed`，停止并 fence 受保护任务；之后到达的旧 `mr_updated`，以及仍带同一 MR
  identity 的 note/pipeline 等非 reopen 事件，都不再为 protected rule 启动任务；
- 显式 `mr_opened`/reopened：仅当当前状态为 `closed` 时把 stream 恢复为 `open`，允许未来事件再次启动；
  它不自动复活此前被取消的任务，只解除 `closed` fence，后续人工操作仍受任务原有生命周期规则约束；
- `mr_merged`：stream 进入吸收态 `merged`，后续 `mr_updated` 或伪造/乱序 `mr_opened` 都不能重新启动或解除
  task fence；
- close/merge/reopen/update 的竞争按同一 stream 的持久 revision 串行化，明确以系统接收并线性化的事件顺序
  为准，而不是按 payload 内可缺失或不可信的时间戳重排。

### D6. “立即停止”与“资源已释放”必须如实区分

收到并验证终态 delivery 后不做 debounce、不等待当前节点完成：先持久化终态控制意图，再在同一处理轮向
active task driver 发 abort。运行时子进程沿统一 managed-process 协议先收 `SIGTERM`，默认 10 秒后仍未退出
则进程组 `SIGKILL`；调度器、fan-out/script/code-host 并发 slot、runtime session lease、临时/隔离工作区与
子任务按现有 owner/finally 链释放。

代码平台 HTTP 响应只等待 delivery + control intent 的短事务，不等待进程退出；因此“立即”指 commit 后无人工
确认/定时轮询/自然完成等待地唤醒 stop worker，不承诺在 webhook 2xx 返回前已经完成 SIGKILL 与全部资源回收。

Task 状态可以先进入 `canceled`，但审计不得在 active driver 与受管子进程真正 settle/reap 前声称“资源已
释放”。若操作系统层面出现 unreaped/unkillable 进程，必须记录明确失败并进入恢复/重试，不能用成功状态掩盖。

取消原因必须是结构化的 `webhook-mr-closed` 或 `webhook-mr-merged`，scheduler 与无 driver fallback 结果一致，
不能继续写成“canceled by user”。子任务保留 parent-cascade provenance，并关联根终态原因。

### D7. 磁盘工作区继续由 RFC-300 全局策略决定

本选项只发起 canonical task cancellation，不直接执行 `git worktree remove` 或 `rm`。任务进入 `canceled` 后：

- `webhookTaskWorkspaceAutoCleanup=true` 且空间为受管 remote/scratch 时，RFC-300 在终态 CAS 内落 durable
  `webhook-terminal` prune claim，并在 active driver 释放后即时删除；
- 全局开关为 `false`，或空间不是 RFC-300 候选时，canonical 工作区保留；
- 已经落下的 prune claim 继续按 RFC-300 的 crash-recovery/幂等语义完成，后续关开关或删 trigger 不撤销。

因此“释放运行资源”是本 RFC 的无条件目标，“是否回收磁盘工作区”仍是用户已选定的全局磁盘策略。

### D8. 终态控制是耐久、幂等且可审计的关键效果

终态 stream state 与 control intent 必须在执行副作用前持久化。daemon 若在“认领终态”与“发 abort”之间
崩溃，启动恢复/后台 worker 会续做；同 UUID 重投与 terminal delivery 的手工 replay 复用原 effect/linearization
point，只唤醒或补齐未完成效果，不把旧 close 当成 reopen 后的一次新 close。MR-associated delivery 缺 provider UUID
时，以 normalized event type + 原始 body bytes 的 hash 作为降级 fact key，完全相同的重投仍幂等。代码平台后来
发送的**不同 fact** 才获得新 revision并按当时 stream 状态再次 close/merge。所有路径都不能重复清理。

Webhook delivery 详情必须能看到 terminal kind、目标 task、取消/已终态/未能 reap 等结果；审计不能依赖
live trigger 外键，因为 D3 允许 trigger 后续被删除。

## 3. 目标

1. 让 MR/PR 打开规则可以显式选择“终态即停”，并保持默认行为完全兼容。
2. 同一 MR/PR 的关闭/合入事件能尽快停止所有受保护执行，不创建终态新任务。
3. 把配置意图冻结到任务，使触发规则后续修改、禁用或删除不产生保护 TOCTOU。
4. 用 stream fence 处理终态后的乱序 update、显式 reopen 与 merged 吸收态。
5. 取消原因、task lifecycle、process reap、child cascade、lease/slot 释放与工作区清理边界都可验证、可恢复。
6. 按 RFC-294 把 integration 的终态事实与 task-execution 的控制所有权通过窄 public participant 连接，
   不再给 webhook dispatcher 增加跨域直调 `services/task.ts` 的旁路。

## 4. 非目标

- 不轮询 GitHub/GitLab 当前状态，也不在 delivery 缺失时主动回查代码平台。
- 不把删除/重建 Webhook endpoint 视为同一 ingress identity；删除后尚未收到的未来事件无法联动，删除前已持久化的
  pending control 仍必须完成。
- 不追溯取消开启选项前已启动、但没有冻结保护绑定的历史任务。
- 不取消手动、Scheduled、API 或其它 endpoint/MR stream 的任务。
- 不回滚任务已经提交、推送、发评论、审批或调用外部 API 产生的副作用。
- 不保证第三方/操作系统不受控进程一定能被杀死；保证的是立即请求停止、升级 kill、准确暴露 unreaped 结果。
- 不把“终态即停”等同于无条件删除工作区；磁盘删除不复制 RFC-300 的策略或实现。
- 不自动恢复被 close 取消的旧任务；reopen 只解除 fence 并允许未来 launch/既有生命周期操作重新判定。
- 不改变未开启选项时显式订阅 `mr_closed`/`mr_merged` 并启动任务的既有能力。

## 5. 用户故事

1. **评审任务及时止损**：MR 打开后启动长时间代码审查；作者关闭 MR，任务立即停下，不继续消耗模型与
   子进程资源。
2. **合入后不做过期工作**：MR 已合入时，正在跑的修复/复核任务停止，稍后到达的旧 update 不会再启动。
3. **关闭后重新打开**：MR close 使旧任务停止；显式 reopen 后，新的 opened/update 可以按规则启动新任务，
   旧 canceled task 不会自动复活。
4. **规则已删除仍受保护**：管理员在任务运行期间删除触发规则，随后 MR 合入；任务仍依据启动时快照停止。
5. **磁盘策略独立**：管理员关闭全局 Webhook 工作区自动清理时，终态仍释放进程/slot/lease，但 worktree
   留作调查；打开全局开关时则等 driver 退出后按 RFC-300 删除。
6. **故障后补停**：daemon 在终态 delivery 入库后崩溃，重启后从 durable control 续做，不让旧任务永久漏停。

## 6. 验收标准

- [x] Trigger create/update/read contract 与编辑 UI 增加默认关闭的 `cancelOnMrTerminal`，中英文、a11y、review
      summary 与 dirty/reset 行为完整。
- [x] 选项只在包含 `mr_opened` 且不包含 `mr_closed/mr_merged` 时显示；事件组合离开适用域即把草稿值归
      `false`。shared/backend 对直接 API 非法组合返回同一稳定错误码，旧规则 `false/omitted` 继续兼容。
- [x] GitLab close/merge 与 GitHub closed(unmerged/merged) 都命中同一 provider-neutral control path；terminal
      delivery 不为受保护规则创建新 task/fire。
- [x] 受保护的 MR-family root 在 initial task INSERT 内冻结 opaque binding；push/tag/pipeline 等无 MR 标识的
      launch 不冻结；trigger disable/edit/delete 不改变已落任务。
- [x] 同一 endpoint+projectId+MR stream 的多规则根任务和全部活跃后代被取消；repo rename/transfer 不漏停，邻接
      endpoint/project/MR、手动/定时/API 任务不受影响；protected MR payload 缺稳定 identity 时不启动半保护任务。
- [x] running/pending/awaiting_review/awaiting_human 正常取消；already done/failed/canceled/interrupted 只记录精确
      receipt/fence，不伪造 canceled；terminal fence 期间 resume/retry fail closed。
- [x] close 后 update 被挡，显式 reopen 解除 closed fence 且不自动复活，merged 永不 reopen；close/update/reopen/
      merge 竞争、重复 delivery 与 replay 都有确定结果。
- [x] control intent 先持久化再发 stop；daemon crash、claim lease 过期、重复 consumer 可恢复且幂等，无“delivery
      已处理但 task 永远漏停”的窗口。
- [x] terminal 会 revoke 更早的 precommit launch guard并中止受管 clone/fetch/materialization；不可中断的短 FS 操作
      完成后仍被二次 gate 拦截，guard/临时资源 settle 前不声称 released。
- [x] task 与 node-run 错误原因准确区分 close/merge/user/parent-cascade；广播、delivery audit 与日志不含凭证或
      原始 payload 泄漏。
- [x] active managed process 收到即时 abort，默认 10 秒 grace 后升级进程组 kill；只有 driver/process settle 后
      control receipt 才能声称 released，unkillable/unreaped 明确失败并可续做。
- [x] fan-out/script/code-host pool、runtime session lease、review/human wait 与 child task owner 均释放；终态 commit
      后不再 dispatch 新节点、retry 或外部调用，已经 in-flight 的不可撤回副作用按能力影响清单准确说明。
- [x] RFC-300 全局开关 off 时工作区保留，on 时 remote/scratch 在 owner release 后即时清理；internal/inherited、
      failed/interrupted 与 claim/recovery 既有边界不回归。
- [x] migration/rolling upgrade、正常/异常/并发/崩溃恢复、真实 GitLab/GitHub webhook daemon E2E 与浏览器配置流
      均有自动化防护，最终 `bun run gate:local` 全绿且实现门无未处置 P1/P2。

## 7. 能力影响清单

### C1. 终态 launch 与终态控制互斥

开启本选项的规则不能再同时把 `mr_closed`/`mr_merged` 当作 launch event。这是该规则的显式 opt-in 能力收缩：
终态只停止任务，不启动新任务。需要终态自动化的用户可保留另一条未开启本选项的独立规则；所有存量规则
默认 `false`，升级不会静默改变行为。开启后，MR-family payload 若缺稳定 `projectId + mrIid` 也会明确 skip，
而不是启动一个无法保证终态取消的半保护任务；未开启规则与非 MR 事件不受这条收缩影响。

### C2. 运行与后续 revival 会被终态 fence 阻止

close/merge 到达后，受保护根任务及活跃后代不再继续输出；closed 期间、merged 永久禁止同一冻结任务的
resume/retry。显式 reopen 只解除 closed fence，不恢复旧 canceled 状态或自动补跑。已经发生的外部副作用不回滚。

### C3. Trigger 后续操作不能撤销既有任务保护

关闭开关、禁用、编辑或删除 trigger 只影响以后创建的 task。已经冻结 binding 的 task 仍会被同一 stream 的
终态控制命中。这是用户确认的防 TOCTOU 语义；若确需让一个运行中任务继续，只能在终态事件到达前通过现有
任务控制明确处置，不能靠删规则暗中绕过。

### C4. 子任务与等待态一起取消

parent/child 整棵执行树是一个资源单元。call 子任务、awaiting_review、awaiting_human 都会随根任务关闭；未提交
的人工决策/回答不能再让任务继续执行。已落库的历史记录仍可读。

### C5. 工作区可能按另一个已启用全局策略被删除

本 RFC 不新增删除开关，但 cancellation 会触发 RFC-300 已存在的终态判据。若管理员已经打开
`webhookTaskWorkspaceAutoCleanup`，受管 remote/scratch 工作区会在 driver 释放后删除，diff/retry/sync 等依赖
工作区的能力随 RFC-300 进入 pruning/pruned 状态；关闭全局开关时仍保留。

### C6. 混合版本与回滚窗口

新 schema 是 additive，旧 binary 可继续读写，但旧 daemon 不理解新选项、stream fence 与 control worker，混合
版本窗口内由旧 binary 接收的 terminal delivery 可能不执行联动取消。部署必须先完成 migration，再让新 daemon
成为唯一 Webhook consumer。代码回滚不删除新表/列；已经 canceled、merged-fenced 或已被 RFC-300 删除的工作区
不可恢复，pending control 由恢复到新版本后续做。

以上 C1-C6 已在实现开始前随 D1-D8 一并获得显式批准。
