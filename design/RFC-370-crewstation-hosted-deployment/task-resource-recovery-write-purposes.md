# RFC-370 Task 启动恢复与周期恢复的宿主写入用途

本片继续 A-T6/H7 的 Task 持久化接线。前置 CI 已在精确提交 `ca947c2431cd710bdaa63af3bae4903c1ace03b4` 满足：主流水线 72/72 作业成功，完整默认 Windows 26/26 步骤成功，四工作区两组类型检查成功，398 次既有 HumanGate/lifecycle 实际案例成功。详见 [CI 总绿回顾](ci-human-gate-total-green-closeout.md)。当前共享 main 已同步到 `ef91b49e15412d3908b0911e1f773229a41a38f1`；其新增内容是 RFC-371 观测报告批量计数，不改变本片的原 Task 源码。该 CI 结论用于解除此前的暂停门槛，不替代本片新生产候选的源码门和精确 SHA CI。

## 已确认的调用与事务边界

启动恢复调用 `runTaskExecutionBootRecovery`，由同一 family 顺序执行 prepare → reap → repair → finalize。两个 CLI 根在 HTTP 监听和自动续跑前执行该序列。它没有已受理 Task work，不能借用 Task 派发的 `captureTaskHostExecutionWrite`，不能构造假的 Task token 或通过缩减上下文类型获得写入。

周期清理来自 `providerBackground.ts` 的 orphan-reconcile loop，使用真实选定 lifetime 的 current 与 canDispatch。它探测旧 run，再逐项中断 run、修复其 session lease，最后按原条件中断没有活跃 run 的 Task。每次清理是新的 active 恢复工作；它不能使用在 draining 仍允许旧结果落账的 issued-ACK 用途。人工资源读写和 L19–L21 控制入口保持原操作；它们随后派发新 Task 时仍走既有受理入口。

| 原写入                          | 原边界                                                                                             | 本片选定写入                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 旧 owner revoke                 | `revokeExactOwnerInTx(this.db, input)` 的单条 CAS；native 原来没有外围事务                         | native 保持原 CAS；仅选定启动恢复为该 CAS 增加一笔事务，在同笔事务消费 recovery                     |
| Task boot interrupt             | 原 Task lifecycle 写事务，同笔 terminalize intents 与 replay decisions，提交后发布 committed event | 在原 lifecycle 内部写钩子消费 recovery；保留 guard、返回 false 的错误集合和提交后发布位置           |
| Node interrupt                  | 原 node transition 写事务；原 recovery administration 捕获异常并返回 false                         | 外围选定写入参加同一原事务，保留 transition 全部条件、原 receiver 及原 catch/false                  |
| Runtime session lease repair    | 先读候选，再逐项调用原 release/discard；每项独立 serializable 事务                                 | 只在这两项原事务内消费选定用途，不把读取和整个循环纳入一笔大事务                                    |
| Managed-process effect recovery | 原 successor 分支事务                                                                              | 同笔 owner/effect/watermark 写入消费 recovery；exact-stop 的原 Task issued-ACK 接线保持             |
| Code-host effect recovery       | 网络探针在事务外；探针后独立事务写 attempt/effect/watermark/node                                   | 保留三段顺序和原事务，在落账事务消费 recovery                                                       |
| Outcome-unknown closure         | 原 closure/intent/replay/owner 事务                                                                | 同笔事务消费 recovery，任何失败使该笔完整回滚                                                       |
| Recovered owner release         | 原 serializable 事务内检查未决 effects，关闭 intents/replay，再 CAS release                        | 保留 serializable 与全部业务条件，同笔消费 recovery                                                 |
| Recovery event                  | 原独立 insert；服务先加计数，await insert，捕获异常并记日志                                        | native 保持原 insert；选定目的为原 insert 增加一笔同写入许可事务，保留原 best-effort 错误与计数政策 |
| Periodic Task interrupt         | 原无活跃 node 查询，再调用原 lifecycle trySet                                                      | 保留原读取与 CAS 边界，在 lifecycle 原事务消费 active new-work；不改为空返回与竞态政策              |

原事务内检查失败或宿主消费失败时，仅该事务回滚；已经提交的前面项目继续保留。适配层不提高原循环的原子范围、不把网络探针放入事务，也不把业务失败改成成功。Task lifecycle 的提交事件必须在宿主消费和原业务事务成功提交后发布。

## 中立接口与独立实现

新增 Task-owned `TaskResourceRecoveryGrant`，仅含原 host `generation` 与 opaque `reference`。新增 `TaskRecoveryWritePurposes`，闭合提供 `boot(grant)` 与 `periodic(grant)` 两个用途。boot 返回 prepare/finalize persistence、boot orphan operations 和仅含 `repairAfterOrphanReap` 的 lease 修复端口；periodic 只返回该循环实际需要的查询、中断、lease 修复与事件记录端口。用 Pick 定义具名能力片，服务依赖缩到实际使用的方法，不暴露其他 Task 控制写手。

Task infrastructure 使用原 `captureTaskHostWriteContext`，在用途创建的同步阶段保存原 port 四方法、receiver 和原 receipt；同时保存原 binding 的 `transactionFor` 函数与 receiver。创建后不因输入对象的方法被更换而改绑其他交易。所有写入保留同一捕获、同一 SO participant 与原事务身份；不借用 ALS 中的 Task work，不重新解释 CS 数据。

SO 既有用途保持：recovery 只接受 preparing 且仍 current/未到期；new-work 只接受 active 且仍 current/未到期；issued-ACK 保持已有 active/draining 语义，本片不使用或修改它。选定 boot 使用 recovery；选定 periodic 使用 new-work。用途工厂只装配原 Task adapters，不复制业务 SQL、状态机或恢复判断。

`TaskExecutionPersistence` 增加 `recoveryWriteMode: 'host-selected'` 与 `recoveryWritePurposes`，仅在原 composition 已选 `hostWrites` 时提供。默认 native 聚合保持原值。Local boot factory 在任何 await 前选择完整 boot 用途；选择了 host 模式却缺 grant、factory 或任何必需方法时直接报告装配不完整，不能补 native。默认 native boot 继续使用调用方原 persistence 和 runtimeSessionLeases，保持四步和报告。

Task provider background 从同一 persistence 接收 mode/factory。`startAuthority` 的原 authority 输入可携带该 lifetime 的 `recoveryGrant`；选定 host 模式在创建 lifetime 的任何 await 前捕获 periodic 用途，以原 current/receiver 检查和 canDispatch 控制新 tick。整个 lifetime 使用该原 capture，下一次 grant 必须在前 lifetime drain 后创建新的用途。默认 native start/startAuthority 的配置热更新、计时和 drain 行为保持。两个 Task provider runtime composition 共同传递 mode/factory，不按数据库分叉。

本片不把 local-startup 算法当成 CS durable-intent 恢复。它保留原有效 daemon lock proof 和 native orphan/process 政策；CS 后续选独立 durable-intent family。本片也不宣称完成三个 bootstrap 根、十九 owner、提前 boot writer、H7、A-T7 或 A-G 的全部接线。CS adapter 仍在 A-G 后编写；部署仍依原计划先 M0，再 M1–M4 逐项接入。

## 实施顺序与验证

1. 新增中立具名能力片、用途 factory 和 provider-private 原事务钩子；保留原 native 方法及 SQL。
2. 将 local boot、periodic lifetime 和两个 Task provider runtime composition 接到完整用途；手动控制保留原面。
3. 增加独立回归文件，使用原 SQLite/PostgreSQL fixture，并由 GitHub 执行：真实 SO prepare/activate/loss、原 grant 与事务身份、没有 Task work 的 boot/periodic、事务内回滚与原事件发布顺序、逐项 lease 保留、原 catch/false、缺绑定拒绝与 lifetime 的原配置/drain。旧 HumanGate/lifecycle/recovery 原 case、assert 和预算不删减。
4. 新增生产候选只做 owned 格式/lint、纯 AST/字节/JSON 与一次原 scoped census；不在本机运行 AW test/typecheck/build/service。实现后由独立 Codex 做功能门检视，再按精确文件清单发布，消费新 SHA 的完整 GitHub 总绿和完整默认 Windows。
5. 完成本片后继续其余 H7/A-T7 与 A-G；通过 A-G 后先实际完成 CS M0 安装部署和耐久读回，再逐项接入执行、runtime、事件及运维能力。不得把本片或 CI 成功记为 RFC 完成。

设计门只审功能；安全相关一律不扫描、不分析、不验证、不提问、不提 findings、不提建议、不转成任务，也不得影响门检视结论。

## 本片实施候选与待验收项

独立功能设计门 PASS／零 findings 已实际消费，来源为同步的 `ef91b49e15412d3908b0911e1f773229a41a38f1`。候选在 Task application 端口提供 boot／periodic 两个中立用途，在原 infrastructure 内核增加原事务钩子，并由原 persistence 与两个 provider runtime 装配。boot 使用 preparing 的 recovery；periodic 使用 active 的 new-work；两者不创建 Task work 或借用 issued-ACK。Native 四步恢复、逐项租约 release／discard、两次 Task lifecycle 的原输入与 guard、Node 原 catch/false、事件最佳努力计数和提交后发布保持。

新增回归包含十六个 provider case 和一个有限源码全量 case，覆盖原四步恢复、全部原子回滚、提交发布顺序、逐项租约、原绑定捕获、缺装配拒绝、代码宿主事务外探针、outcome-unknown／replay、恢复 release、事件计数，以及真实后台启动等待／授权丢失／drain。新用例尚未在本机或 GitHub 执行；预计 GitHub Ubuntu 双 provider 33 次、macOS 17 次、Windows 17 次，另保留原 HumanGate／lifecycle 的 398 次人口。语法 expect 计数不当作实际执行证据。

三个重叠源文件的有限 UTF-16 逆变换先恢复本片前完整字节，再执行原 HumanGate inverse；原 HumanGate／lifecycle 源码、fixture、断言及预算不改。纯语法／字节核对和本片格式／lint已通过，不代签行为验证。Windows 仅补缺少的精确路径过滤及新文件登记，原命令／预算／并行输出可完整恢复。独立实现源码门、唯一原 scoped census、配套功能门、精确发布及新 SHA 完整 GitHub 主 CI＋默认 Windows 仍待消费。完整 H7、A-T7、A-G、CS adapters 与 M0～M4 均未在本片签完。

## 原公共类型的等价兼容修正

SOURCE R1 功能门发现新 R14 的 periodic 消费断言少计一次，原成功流程的 Node transition／run event／Task lifecycle／Task event 是四个原独立写原子。只补第四个期待值及两处格式，原生产事件政策保持。修正版 SOURCE R2 PASS／零 findings 已由根核对全部八十项完整身份及十二项功能分析；R1 正式 FAIL 保留。这些结论仅签源码，不把 465 次登记人口当作执行验收。

对 R2 的首次原 scoped census 在 canonical validation 退出，原因是新公共恢复视图展开原 `TaskExecutionProcessRecoveryEvidence extends Readonly<Record<string, unknown>>` 时出现未登记的 `extends:Readonly`。这次为一项未完成尝试、零成功生成，没有清单写入主树；原失败日志及 R2 SOURCE PASS 分别保留。原四规则及 opaque allowlist 完整不改。

修正仅把该原 interface 的继承展开成 `readonly [key: string]: unknown`，仍保留只读任意字符串字段与原 `readonly orphanReaperCompleted: true`。原 prepare／finalize 输入、端口和全部运行函数完整字节保持；不隐藏公共恢复方法。Windows 再增加此原模块的两条精确过滤，原命令／case／预算保持。针对七个新公共类型复用原二十份纯 AST 声明：方法及字段人口逐项不变，额外 opaque ref 从 `extends:Readonly` 变为空。没有执行 AW 模块、测试、类型检查或构建，也没有第二次 whole census。

最终 R3 仍须独立源码复核并由根实际消费；只有候选确已改变且通过后，才能对该新候选执行一次完整原清单生成并做 matching 复核，随后精确发布及新 SHA 主 CI／完整 Windows／465 次实际案例验收。完整 H7／A-T7／A-G、各层 CS adapter 和 M0～M4 部署仍开放。

## 配套 R1 失败与 public 类型引用修正

上述 R3 后续已完成：独立 SOURCE R3 PASS／零 findings 的 93 份完整材料、16 条功能分析及 17 个案例结论已由根实际消费；改变后的 R3 候选执行一次原 scoped census 成功，13 份输出只保存在私有候选。累计两次生成尝试是一项 R2 中止与一项 R3 成功，均保留。R3 源码通过和成功生成不等于清单配套通过。

配套 MATCHING R1 正式 FAIL／一项 P1 已实际消费。原 classic 规则观察到 312 条 inbound，而投影的 commons-debt 保留 309 条：`orphanReconcile.ts`、`orphans.ts`、`runtimeSessionLease.ts` 新增的三条恢复视图类型引用指向 Task application 内部。原 `rfc317-module-boundary.test.ts:92–98` 对实测边与登记键逐条相等；canonical 分类不能替代该原断言。这是源码与清单确定不匹配，尚不是执行后的 CI 结果。原 FAIL、114 份冻结身份、完整分析与成功生成保留，R3 发布候选不予提交。

修正版 R4 仅将这三条 type-only import 的 module specifier 改为已经导出同一类型的 exact `@/modules/task-execution/public/participants`。没有新增 classic debt、facade 或绕开原规则；三个服务的方法体完整保持，七份类型的声明与 public export 保持。新回归源、旧 HumanGate／lifecycle 判据、fixture、Windows 命令和预算均保持 R3 完整字节。

R4 源码须独立有限复核三条 import、既有 public export 与完整逆变换，并复用其余 R3 已审材料的完整身份。通过并由根实际消费后，才能对实际改变的 R4 源码执行一次原 scoped census 和新的配套复核；不重跑 R3 或抹去其结果。新候选的清单计数按实际输出记录，不预用 R3 六项增长。新 SHA 总绿、默认完整 Windows、465 次实际案例及剩余 H7／A-T7／A-G／CS 部署仍待验收。
