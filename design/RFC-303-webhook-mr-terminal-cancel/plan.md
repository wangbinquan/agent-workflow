# RFC-303 Webhook MR/PR 终态联动取消 — 实施计划

状态：**Done（2026-08-14；T1-T24、验收标准、实现门与完整本地门禁已完成）**

## 1. 前置门

- [x] 读取 live `CLAUDE.md`、`STATE.md`，确认新产品行为必须先落 RFC，production/test/migration 尚不可改。
- [x] 核对 shared Webhook schema、GitLab/GitHub adapter、matching/dispatch/supersede、task cancel/child cascade、
      managed process 与 RFC-300 owner-release cleanup 的当前事实。
- [x] 用户确认：GitLab/GitHub 共用、工作区遵循 RFC-300 全局开关、保护策略随 task launch 冻结，并采用其余
      推荐 terminal-control/reopen/merged/release 语义。
- [x] 读取 RFC-294 摘要/目标/技术设计，确定 integration→task-execution 窄 participant、module 落位与存量
      adapter 债务。
- [x] RFC-303 proposal/design/plan 初稿落档；只修改 RFC/索引/STATE 文档。
- [x] 请批前设计门复核 D1-D8、C1-C6、A1-A5、所有 production writer/launch/revival seam、迁移/回滚与
      adjacent miss，处置全部 P1/P2。
- [x] 用户在本 RFC 完整写成后显式批准 D1-D8、C1-C6、A1-A5，可进入 implementation。
- [x] 开工时重新读 live 指引、同步已进入 `origin/main` 的 RFC-300、检查共享树并从最新 journal 分配 migration。

## 2. 实施批次

### 批 A — Shared contract、持久化与纯 domain

| #          | 任务                                                                                         | 验证                               |
| ---------- | -------------------------------------------------------------------------------------------- | ---------------------------------- |
| RFC-303-T1 | shared Trigger create/update/read 增 `cancelOnMrTerminal`，落唯一组合校验与稳定错误码        | schema 正反/omit/preserve/mutation |
| RFC-303-T2 | 分配最新 migration：trigger/delivery/task 列、stream/guard/effect/target 表、CHECK/index     | fresh/upgrade/rolling schema       |
| RFC-303-T3 | integration domain 落 identity/binding、revision、状态转移、protected-launch decision        | GitLab/GitHub/转移/吸收态纯测试    |
| RFC-303-T4 | task-execution domain 落 source snapshot/fence、target cutoff、TaskStopCause 与 receipt 归约 | fence monotonic/cause parity       |

退出门：旧 trigger/task 全部安全默认；没有历史猜测/backfill；domain 零 I/O、零 provider/task internals 反向依赖。

### 批 B — Verified ingress、stream revision 与 launch guard

| #          | 任务                                                                                                       | 验证                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| RFC-303-T5 | verified ingress 用 UUID/body fact key 去重，原子分配 revision、更新 state、插 close/merge/reopen effect   | ACK 原子性/dedupe/CAS/crash seam          |
| RFC-303-T6 | protected match 建 guard；双 gate；terminal durable revoke + signal/kill launch owner并清 handed-off space | slow clone/materialize race/reap/cleanup  |
| RFC-303-T7 | Webhook execution invoker携 internal snapshot，root INSERT 原子写入；guard 在 task 后完成                  | task/fire/guard ordering + crash recovery |
| RFC-303-T8 | 关闭/合入 control-only；closed/merged update skip；legacy option=false terminal launch 不变                | fire outcome/circuit/supersede matrix     |
| RFC-303-T9 | terminal replay复用原 revision/effect；boot reconcile 修复 reserved guard 与半完成 effect                  | duplicate/replay/restart idempotency      |

退出门：任何 terminal 前开始的 protected launch 要么在 commit 前被挡并清理，要么 task 出现后必被 durable effect 扫到；
terminal 不创建受保护新 task。

### 批 C — Task source termination participant 与资源 settlement

| #           | 任务                                                                                                           | 验证                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| RFC-303-T10 | 建 target-architecture `TaskSourceTerminationParticipant` + branded effect capability；零任意 task-id API      | architecture/forge/negative source lock  |
| RFC-303-T11 | task snapshot/fence 在 child INSERT 继承；canonical CAS 应用 close/merge/reopen；所有 revival seam fail closed | root/child/status/revival matrix         |
| RFC-303-T12 | 抽 `TaskDriverSupervisor`：三条 tryAttach 与 terminal 共锁，commit 后 stop/await；移除“5 秒=释放”假设          | attach race/no-owner/released/unreaped   |
| RFC-303-T13 | scheduler/fallback 共用 typed cause；child 保留 parent marker；dispatch checkpoint 认 task fence               | error/broadcast/node dispatch regression |
| RFC-303-T14 | control worker 先 stop 可见 task、再等 guard barrier并 fixed-point sweep；lease/backoff/alert/boot recovery    | close-reopen order/concurrency/crash     |
| RFC-303-T15 | 复用 RFC-300 canceled CAS/finalizer，分别呈现 runtime release 与 workspace pruning                             | cleanup on/off/failure/owner defer       |

退出门：task status、driver/process、child、pool/lease 与 workspace 的 owner/receipt 各自准确；无 integration→GC/task
internal import，无“task canceled 就谎称资源已释放”。

### 批 D — Trigger UX、Delivery audit 与权限

| #           | 任务                                                                                                      | 验证                              |
| ----------- | --------------------------------------------------------------------------------------------------------- | --------------------------------- |
| RFC-303-T16 | Events step 按合法组合显示公共 Switch、失配时原子归 false、Review/card/read-only 状态、draft history/i18n | frontend unit/a11y/dirty/reset    |
| RFC-303-T17 | Delivery read model/API 加 control effect/targets/workspace 分离状态；Trigger fire 加 skip outcomes       | shared/backend contract/ACL       |
| RFC-303-T18 | DeliveriesPanel 响应式 control 区、task ACL 链接、trigger deleted 降级、pending→released 实时刷新         | frontend/browser/390px/light/dark |
| RFC-303-T19 | retention 跳过非 succeeded effect/guard，日志/错误 redaction，control ledger 不受 trigger cascade         | retention/security/source ratchet |

退出门：用户能在配置时理解互斥语义，在 delivery 中区分“已接受控制 / task canceled / runtime released / workspace
pruned”；无越权 task 数据和敏感 payload 泄漏。

### 批 E — 系统 E2E、回滚与门禁

| #           | 任务                                                                                               | 验证                                 |
| ----------- | -------------------------------------------------------------------------------------------------- | ------------------------------------ |
| RFC-303-T20 | GitLab close/merge 与 GitHub closed merged false/true 的签名 payload→真实 daemon→mock long runtime | provider-neutral system E2E          |
| RFC-303-T21 | 多 root/多层 child、慢 launch、close/update/reopen/merge、decision/retry 与 daemon crash E2E       | 并发/恢复 E2E                        |
| RFC-303-T22 | 真进程 SIGTERM→SIGKILL/reap、slot/lease 归零；RFC-300 worktree off/on/delete-failure E2E           | process/FS/system tests              |
| RFC-303-T23 | 浏览器创建/编辑/只读/delivery audit，desktop/390px/light/dark/a11y                                 | Playwright + visual                  |
| RFC-303-T24 | mixed-version/代码回滚 fixture、架构棘轮、实现门固定 SHA 复核、定向测试与 `bun run gate:local`     | rolling/full gate/0 unresolved P1-P2 |

退出门：Proposal 全部 AC 有自动化证据；实现门无未处置 P1/P2；完整门禁绿后才能更新 RFC/STATE/索引为 Done。

### 完成记录（2026-08-14）

- [x] T1-T4：shared contract、migration 0157、stream/binding domain 与 task source fence 已实现并有 schema/migration/domain 回归。
- [x] T5-T9：verified ingress、fact dedupe/revision、protected launch guard、control-only dispatch、replay 与 boot reconcile 已实现，GitLab/GitHub 真实签名 delivery E2E 已通过。
- [x] T10-T15：窄 participant/capability、child fence 继承、全 revival seam、driver supervisor、typed cause、terminal worker 与 RFC-300 finalizer 已实现，真长进程 stop/reap 及 worktree 回收 E2E 已通过。
- [x] T16-T19：Trigger Switch 按事件组合显隐并归一非法草稿、review/card、Delivery audit + task ACL、中英文、retention 保护与 architecture/source ratchet 已实现。
- [x] T20-T24：provider-neutral/control 并发/崩溃边界、进程/工作区、390px 真浏览器、rolling/migration/架构锁与完整 `bun run gate:local` 已通过。
- [x] 实现系列 `66f56b05` / `b614f437` / `5545cdd7`；最终本地门禁 shared 2097、frontend 6427、backend 10150 pass / 35 skip / 0 fail，0 条未处置 P1/P2。

## 3. 用例矩阵

### 3.1 Trigger contract 与 launch 组合

| option                    | eventTypes                    | 预期                                            |
| ------------------------- | ----------------------------- | ----------------------------------------------- |
| omitted/false             | 任意既有非空组合              | 兼容当前行为                                    |
| false                     | `mr_closed` / `mr_merged`     | terminal 仍可 launch task                       |
| true                      | `mr_opened`                   | 合法；opened task冻结 binding                   |
| true                      | `mr_opened + mr_updated`      | 合法；两类 MR launch 都冻结 binding             |
| true                      | `mr_opened + push`            | MR task有 binding，push task无 binding          |
| true                      | 无 `mr_opened`                | API 422；前端隐藏开关并归 `false`               |
| true                      | 含 `mr_closed` 或 `mr_merged` | API 422；前端保留事件选择、隐藏开关并归 `false` |
| true→false/delete/disable | 已有 running task             | 已有 task仍保护，未来 launch 不再冻结/不再发生  |

### 3.2 Provider 与 stream 状态

- GitLab `open/reopen/update/close/merge` 与 GitHub `opened/reopened/synchronize/closed` merged true/false；
- absent/open/closed/merged × opened/updated/closed/merged 全转移；
- same IID 不同 endpoint、same endpoint 不同 projectId、same project 不同 IID 互不影响；repoPath rename/namespace
  transfer 但 projectId 不变时仍命中；protected MR event 缺 projectId/mrIid 时明确 skip/fail，不建半保护 task；
- close→late update/note/MR-pipeline skip、close→reopen→update launch、merge→reopen/所有 MR-associated launch 永久 skip；
- protected 与 unprotected 规则同 delivery 并存：control/skip 与 legacy launch 各走自己的语义；
- event UUID duplicate不推进 revision；UUID 缺失时 exact normalized type+raw body hash 也幂等；terminal manual replay
  复用原 effect，不能关闭 reopen 后的新 task；不同 provider fact 才获得新 revision；payload timestamp 反序、并发
  HTTP 到达仍只按持久 revision 线性化。

### 3.3 Task lifecycle、任务树与 revival

- `pending/running/awaiting_review/awaiting_human` × close/merge → canceled + exact cause/fence；
- `done/failed/canceled/interrupted` → status 不改、receipt already-terminal、fence 落下；
- workflow child、workgroup child、grandchild、并发 sibling、异常 root 已终态但 child 活跃；
- terminal 与 child initial INSERT 两侧 race；task snapshot/fence/revision 继承不可伪造；
- close fence 下 resume/retry/sync/review/clarify/repair/auto-resume/child launch 全拒绝；reopen 只清 closed；
- merged fence 永不清；manual relaunch 是独立 task，不绕过 protected Webhook replay gate；
- normal done 与 terminal CAS、user cancel 与 terminal、supersede 与 terminal 竞争都只有一个 task status winner。

### 3.4 Launch guard 与崩溃恢复

- terminal 在 guard 前、首次 gate 后、materialization 中、二次 gate 后、task INSERT 后、controller attach 前后、
  `task-committed→launch-settled` 前各一 seam；
- 被挡的 handed-off remote/scratch space 由 launch ownership cleanup 回收，不遗留 worktree/ref；
- active repo clone/fetch/materialize 收 guard abort并 kill/reap 进程组；共享 cache ownership 不被误删；短原子 FS 操作
  完成后再清理，effect 在 launch resource settle 前保持 waiting；
- terminal worker 先停 active task，不因旧 guard 长 clone 延迟；barrier 清空后最后重扫；
- daemon 在 delivery/state/effect 事务前后、effect claim 后、task cancel 后、driver settle 前后崩溃；
- lease expiry/双 consumer/重复 wake/无限 backoff alert 均幂等，不能把 pending 标 success；
- close effect 未完成时 reopen effect 不越过；reopen 后更高 revision task 不被旧 close 误杀。

### 3.5 Process、资源与磁盘

- 正常 process 收 SIGTERM 退出；忽略 SIGTERM 的 parent+child 进程组 10 秒后 SIGKILL；
- unkillable/unreaped seam：task canceled、release receipt 失败、control retry/alert；
- Agent/Script/CodeHost/Fanout permits、runtime session lease、review/human wait、active task/child registries 归零；
- terminal commit 后不再 dispatch 新 node/retry/external call；已 in-flight side effect 明确不承诺回滚；
- RFC-300 off：runtime released但 workspace available；on：remote/scratch owner release 后 pruning→pruned；
- internal/inherited 排除、delete failure claim 保留、boot retry、reopen 不清 claim/不恢复磁盘。

### 3.6 UI、ACL 与安全负空间

- 新建/编辑/复制/只读、Switch 条件显隐与原子归 false、Stepper Next/Save、undo/redo/draft dirty/reset；
- Trigger card/Review 与 delivery target status 中英文 1:1、键盘/focus/screen reader；
- pending/waiting/retryable/released/unreaped、零目标、trigger deleted、task soft deleted；
- delivery viewer 无 task ACL 时只得到聚合计数/受控结果，不返回 target task id/name/link；有 task 可见权时才投影
  task link，打开后仍由 task 自身 ACL 复核；
- create/update/task API 带 binding/fence/capability/terminal cause 同名字段不能控制内部值；
- log/DB read model 不包含 secret header、token、credential URL、无限 raw payload。

## 4. 验收映射

| Proposal 验收面                          | 实施任务           |
| ---------------------------------------- | ------------------ |
| Trigger option、校验、默认兼容           | T1-T3、T8、T16     |
| Provider-neutral terminal control        | T3、T5、T8、T20    |
| frozen snapshot、trigger mutation        | T2、T7、T11、T21   |
| stream fence/reopen/merged               | T3、T5、T8-T9、T14 |
| 慢 launch 与 crash 不漏停                | T5-T9、T14、T21    |
| task/child/revival/cause                 | T4、T10-T14、T21   |
| process/slot/lease honest release        | T12-T15、T22       |
| RFC-300 工作区组合                       | T15、T22           |
| delivery audit/ACL/i18n/responsive       | T17-T19、T23       |
| migration/rolling/architecture/full gate | T2、T19、T24       |

## 5. 提交建议

用户批准后在共享 `main` 按 owned paths/hunks 精确提交，不建分支、不 stash/rebase/broad-stage，并让每个生产提交
携对应测试：

1. `feat(webhook): RFC-303 持久化 MR 终态策略与 stream control`
2. `feat(execution): RFC-303 冻结来源终止策略并联动停止任务树`
3. `feat(webhook): RFC-303 接入 launch guard 与可恢复 terminal worker`
4. `feat(webhooks): RFC-303 增加终态停止配置与投递审计`
5. `test(e2e): RFC-303 锁定终态取消、进程释放与工作区策略`

migration/schema/domain 不拆成任一中间 commit 无法启动的状态。提交前重新核对共享树，仅暂存本人路径/hunk；若
本 Codex session 对 commit 有实质贡献，按 live `AGENTS.md` 使用真实模型/provider co-author trailer，并在 push 前
运行 `git show -s --format=%B HEAD` 核验。

## 6. 发布、监控与回滚门

1. migration 先完成，确认新 daemon 是唯一 Webhook consumer，再开放 HTTP listener；
2. 默认 false 发布，先用测试 endpoint/trigger 打开，观测 terminal intent→stop signal→driver released 延迟；
3. 关键指标：effect pending/retryable age、waiting guard age、targets canceled/already-terminal/unreaped、driver stop
   latency、RFC-300 prune pending/failure；
4. unreaped、effect 超过阈值、guard 长期 reserved 产生 lifecycle alert，不自动吞掉；
5. 回滚先关闭未来 trigger option/停止 Webhook ingress，再 drain effect；DB 不 downgrade、不手工伪造 succeeded；
6. 报告分别说明 DB migration、功能开关、runtime release、workspace prune、本地验证、hosted CI 与 live service
   状态，不能互相替代。

## 7. 完成定义

- 未获用户对 D1-D8、C1-C6、A1-A5 的明确批准前，只允许本三件套、`design/plan.md` 与 `STATE.md` 文档；
- T1-T24、Proposal AC、请批前/实现门 findings、定向/真实 E2E 与 `bun run gate:local` 全完成才可标 Done；
- 提交/推送/CI/部署是四个独立边界；只有用户另行要求“提交上库”时才执行并报告 exact SHA hosted CI；
- 任一 unreaped process、pending terminal effect、未解释的 guard、workspace claim 或 capability/ACL 漏洞都阻止
  declare done。

## 8. 请批前设计门记录

当前 Codex 会话以 local source `e998d99dcb1ffb4d6fed35e4d6259b08846ed6b7` 复核 Webhook/shared/task/process
现状，并以 `origin/main=f8d537c2a6fd70d14872515628e7ee54b07b3ed9` 核 RFC-300 最终实现
`835e5bda` 的 claim→owner release→prune 边界。没有向外部 companion 发送未提交源码；设计门直接逐项核 live
source、RFC-294 与 RFC-300。第一轮发现并已修订：

1. **P1-A，一次 task scan 会漏掉慢 launch**：open/update 已过 match、仍在 clone/materialize 且 task row 尚未出现
   时，terminal 扫零目标后若直接成功，旧 launch 会在终态后落 task。加入 durable launch guard、双 gate、terminal
   revoke/abort、旧 guard barrier 与最后 fixed-point sweep。
2. **P1-B，task row→controller attach 窗口会制造假 released**：terminal 可在 row 已提交但 `activeTasks.set` 前看到
   no owner，随后 launch 再挂 driver。guard 增 `task-committed→launch-settled` 中间态；三条 start/resume/retry
   attach 与 terminal fence 共用 ownership coordinator，attach/stop 只有一个线性赢家。
3. **P2-A，既有 repoPath stream key 会在仓库改名后漏停**：终态 identity 改用 endpoint + stable
   GitLab project.id/GitHub repository.id + MR IID；protected MR identity 缺失 fail closed，legacy option=false 不变。
4. **P2-B，手工 replay 旧 close 会误杀 reopen 后的新 task**：terminal replay 改为复用 root revision/effect并只
   wake；provider UUID 缺失时以 normalized type + verified raw body hash 做 MR fact-key fallback。
5. **P2-C，`status=canceled` 不等于进程/slot/lease 已释放**：新增 requestStop/awaitStopped receipt；10 秒
   SIGTERM grace、SIGKILL 与 final unreaped 结果如实传递，runtime release 与 RFC-300 workspace prune 分开记账。
6. **P2-D，control/read model 可泄无权 task id**：delivery target 按当前 actor 的 task ACL 单独投影；无权只返回
   聚合计数/受控 outcome，internal binding/fence/capability 全部不进 wire。
7. **P2-E，live trigger/replay 条件会撤销冻结策略**：terminal target 不重跑 repoScope/branch/ignore/owner/circuit；
   trigger 配置在 guard commit 冻结，raw-invalid row fail closed但不阻断既有 snapshot control。

相邻遗漏复核同时补齐 MR note/pipeline 的 stream gate、already-terminal 但 owner 尚活、child insert/attach、duplicate
fact、trigger/endpoint 删除边界与 RFC-300 开关 on/off。修订后设计门结论为 **0 条未处置 P1/P2**；实现期又以
架构棘轮、慢 launch/worktree abort、node revival fence、terminal worker 恢复与完整门禁做了第二道回归，结果仍为
**0 条未处置 P1/P2**。
