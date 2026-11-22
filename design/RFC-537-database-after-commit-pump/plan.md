# RFC-537 实施计划

依赖：RFC-536。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-537-T1 句柄上下文的槽与挂接**：`DatabaseHandleContext` 加 `afterCommit` 槽；`runtime.ts` 改为 `attachAfterCommitEventPump(handle, pump)` 与
  `publishCommittedEventsAfterCommit(handle, eventRefs)`，删去模块级变量与两个登记函数（design D1）。
- **RFC-537-T2 写方**：25 处调用补上提交所用的句柄（design D2）。
- **RFC-537-T3 daemon 会话**：`after-commit-event-pump` 句柄挂在会话自己的库 `db` 上、停止时摘除（design D3）。
- **RFC-537-T4 用例与锁**：新增 RFC-537 用例并登记 guard-manifest；测试助手与读旧形状的用例随改（design D4）。
- **RFC-537-T5 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径与被改名字的字符串形态选用例、按分段拼出的路径补搜，红的与 HEAD
  同时 A/B（长扫描用例在两边副本里放大时限跑到底）；架构报告对照；变异验证。
- **RFC-537-T6 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第五步。

## 验收清单

- [x] AC-1 `runtime.ts` 没有模块级状态与登记函数；泵挂在句柄上下文上，daemon 会话挂在自己的库上、停止时摘下
- [x] AC-2 25 处写方按提交所用的句柄投递；两个库各投各的、事务句柄取到客户端的泵；空批次 / 无泵 / 抛错的结局不变
- [x] AC-3 模块级可变单例 58 → 56、计数不升；锁随改；新增 RFC-537 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；1 分钟负载约 16～23，另有会话在跑）。验证在候选导出仓库里跑（HEAD `d5ae97859` 加本 RFC 的 41 个路径，核对与
工作树逐字相同），对照是同一 HEAD 的另一份导出。集中验证查出一处本人缺陷，已修复并复验：

- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 39 个 TS 文件无告警，改动的 20 个生产文件另过
  promises 配置；prettier：本 RFC 的 41 个路径与三件套通过。
- **选择**：按 RFC-533 的口径从 2,982 个用例文件里选出 1,899 个，绝大多数只经 import 闭包或名字的宽匹配入选（`sessionTables.ts` 几乎每个用例都
  间接导入，只经它入选的 101 个；两个被改的测试助手与写方的调用方又各带进上千个）。先跑语义相关的一层 499 个：改动的 15 个用例、全部
  `tests/architecture/`（142 个）、语料守卫、直接导入 19 个被改生产文件或其 39 个直接调用方的 346 个、按名字提到挂泵 / 投递 / 泵句柄的 40 个、
  经测试助手到达组装 daemon 会话的源文件的 7 个。集中验证中又补了一层：经测试助手读被改文件源码的用例（`readDaemonGraphSource()`、
  `deploymentSelectionSource`、`census.ts`、`architectureReport.ts` 与 `rfc359-p0-mutations.ts` 读 daemon 会话、`clarify/seal.ts` 等文件的源码，
  用例文本里既没有路径也没有名字），共 113 个，其中 101 个不在语义层里、57 个连 RFC-533 的口径也没选到，在最终的候选上跑。其余 1,356 个只经
  import 闭包或名字的宽匹配入选，交给 CI 的全量分片。
- **缺陷**：语义层里 `rfc359-w8-t29` 红两条。RFC-395 已复核串行化插入点的调用方摘要锁（`tests/fixtures/rfc395-serialized-insert-source-locks.json`）
  钉着 `clarify/seal.ts` 的全文摘要，本 RFC 改了它提交后投递的实参，摘要失配，三处已复核的插入点落回未归一的账本。补上新摘要与复核说明（只改
  了提交后投递的实参，轮次锁、调用方事务与答案的插入顺序不变）后两边 13 / 13。选用例的脚本跳过了 `tests/fixtures/`，按名字与路径都没筛到这份
  锁，是 `rfc359-w8-t29` 自己（在 `tests/architecture/` 里）认出的。
- **语义层**（60 秒；候选 5 个 worker）：499 个文件 490 个通过；改过的用例文件全过（RFC-537 用例 9 / 9、`rfc128` 71 / 71、`rfc359-w12` 50 / 50、
  `rfc359-w16` 23 / 23、`rfc326-review-decision-batch` 22 / 22 等）；红的 9 个：上面的 `rfc359-w8-t29` 与 8 个撞时限的（见 A/B）。
- **改名与复跑**：候选的架构报告比对照多一条公开面消费边——daemon 会话里摘除函数的局部名 `release` 与 knowledge-evolution 一个公开方法同名，
  报告按整词匹配把会话记成那个公开面的消费者；改名为 `detachPump` 后与对照相同。改名与补上摘要锁之后，在候选上复跑红的 9 个与读 daemon 会话
  源码、全部 `tests/architecture/`、语料守卫等 173 个（3 个 worker）：174 个通过，红的是同样 8 个撞时限的。
- **变异验证**（候选导出仓库里，只跑 RFC-537 用例，复原后与工作树逐字相同）：把泵挪回模块级、忽略句柄，红五条——真实语料、两个库各投各的、
  没有句柄上下文的对象不能挂泵，以及两个引擎上的真库；派生句柄另建一格空槽，红两条——派生句柄取到客户端挂的泵、PostgreSQL 真事务句柄与
  客户端共用同一格（SQLite 的事务句柄经原生会话的客户端取到同一份上下文、不经派生，不受这条变异影响）。
- **A/B**（候选与对照同时、各用各的库）：红的 8 个文件，6 个两边同名同错、都是撞时限（`review-detail-render-rfc158`、
  `rfc300-webhook-workspace-cleanup-e2e`、`rfc395-gate-open-v2`、`scheduler-clarify-inline`、`scheduler-clarify-multiround-aging`、
  `scheduler-rfc040-wrapper-await`）；`tasks` 与 `lifecycle-property` 在候选上各多一条同类超时（`tasks` 的 SQLite 一支等仓库准备落定的 5 秒，
  `lifecycle-property` 写死的 15 秒）。按 RFC-535 的教训，在两边的副本里临时放大写死的时限跑到底：`tasks` 与 `lifecycle-property` 两边都全过
  （58 / 58、6 / 6）；6 个里挂了泵的只有 `rfc300-webhook-workspace-cleanup-e2e`（其余 5 个没有泵，两边走同一条“没有泵”的路径），放大它的默认
  时限后两边都 2 / 2。没有只在候选上红的用例。
- **补选的读源码用例**（最终的候选，4 个 worker）：113 个里 111 个通过（1,005 条用例）。红的 2 个：`rfc321-repository-publication-ratchet` 只因导出
  仓库没有真实的 git 历史（账本记下的提交不是导出仓库 HEAD 的祖先），在工作树里 10 / 10；`rfc294-architecture-preflight` 的能力伪造门撞 180 秒
  时限，按 RFC-535 的教训在两边的副本里放大它写死的时限、同时跑到底：两边都 14 / 14（伪造门候选 848 秒、对照 598 秒，都在高负载下）。
- **架构报告**（候选与对照各出一份）：模块级可变单例 58 → 56（删去的正是 `runtime.ts` 的模块级变量与登记函数）；计数、门、指标与公开面没有
  变化；模块符号属主 32,470 → 32,470（删去三个名字、新增三个）；写入入口清单 2,391 → 2,392（挂接函数一条）。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **投递的结局不变**：`publishCommittedEventsAfterCommit(handle, eventRefs)` 从该句柄上下文的槽取泵，其余逐字不变——空批次返回是否挂着泵，
  没有泵返回 `false`，`publishNow` 抛错只记告警（照旧带事件 id）并返回 `true`，持久投递照样兜底。
- **挂接与摘除**：`attachAfterCommitEventPump(handle, pump)` 把泵放进句柄上下文的槽，返回的摘除函数只在槽里还是这个泵时清空（与此前的
  `releaseAfterCommitEventPump` 同义）；没有句柄上下文的对象抛 `after-commit-event-pump-handle-unbound`——provider 构造的库都带上下文，只有用例
  手搭的对象会碰到。
- **daemon 会话**：泵句柄的 `start()` 把本会话的泵挂在会话自己经 `adapter.open(…)` 打开的库 `db` 上，`stop()` 摘除（重复调用无副作用），
  `drain()` 不变（停止前调用照旧抛 `after-commit-event-pump-drain-before-stop`）。此前 `stop()` 登记 `null`，会把同一进程里另一份会话后登记的泵
  也清掉；现在只摘自己挂的。
- **写方**：25 处逐处补上提交所用的库——23 处按语法树核对实参就是同一函数里开事务的那个库，`clarify/autoDispatch`（经
  `prepareClarifyDecision({ db: args.db })` 开事务）与 `sourceTerminationParticipant`（经 `applySourceTerminationTarget(db, …)`）读码核对。事务句柄
  与原生会话共用客户端的上下文，在事务里或提交后用哪一个都取到同一个泵。生产里主线程只有会话这一个库；维护 Worker 与 CrewStation 的客户端
  在 Worker 里，那里此前就没有泵，结局不变。
- **用例与锁**：两个测试助手的泵改为挂在用例自己的库上、卸载即摘除；直接登记的 6 个用例改用挂接函数、用例结束时摘除，
  `rfc349-task-route-launch-postgresql-adapter` 删去兜底清空；7 个源码文本锁改钉新的调用原文；RFC-395 的调用方摘要锁记下 `clarify/seal.ts` 的
  新摘要与本次复核；`tasks` 与 `rfc326-review-decision-batch` 里把泵说成进程级登记的注释随改；guard-manifest 登记 RFC-537 用例，`rfc486` 条目行数
  随改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-537 已提交事件的即时投递泵随数据库句柄走（RFC-294 S12 第十八步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
