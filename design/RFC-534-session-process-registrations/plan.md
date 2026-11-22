# RFC-534 实施计划

依赖：RFC-533。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-534-T1 回收策略**：`terminalWorkspacePrune.ts` 删去模块级状态与登记函数，判定显式收策略，导出 `neverPruneTerminalWorkspaces`；持久化依赖、
  源终止输入、遗留写者与延迟仓库准备的依赖加必填字段；daemon 组合一次交给 task-execution 与 integration，维护 Worker 交从不回收（design D1）。
- **RFC-534-T2 蒸馏策略**：`schedule.ts` 删去模块级状态、setter 与 reset，`enqueueDistillJob` 显式收策略；memory 组合输入加必填字段，daemon 交
  原来登记的读取器（design D2）。
- **RFC-534-T3 登记步**：删去 `process-registrations` 启动步、它的实现与 `beforeResume`（design D3）。
- **RFC-534-T4 用例与锁**：新增 RFC-534 用例并登记 guard-manifest；登记 / 设置策略的用例改为交进装配；构造这些依赖与输入的用例补字段；
  钉启动步的锁随改（design D4）。
- **RFC-534-T5 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、读被改文件源码的用例（按路径主干、不带目录的文件名与删去的名字）、
  直接导入被改文件与其在 `src/` 里调用方的用例、全部 `tests/architecture/`，红的与 HEAD 同时 A/B；架构报告对照。
- **RFC-534-T6 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第二步。

## 验收清单

- [x] AC-1 两个文件没有模块级可变状态与导出的登记函数；策略每会话一份；维护 Worker 交从不回收
- [x] AC-2 登记步与 `beforeResume` 删去；回收与蒸馏准入不变
- [x] AC-3 模块级可变单例 71 → 66、计数不升；锁随改；新增 RFC-534 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；1 分钟负载约 21～46，另有会话在跑）。验证在候选导出仓库里跑（HEAD 加本 RFC 的路径，核对与工作树逐字相同）：首批的
候选以 `b9d0486f5` 为底，修正后的候选以 `0087aa491` 为底（两者只差只改文档的 `0087aa491`）；对照导出仓库与 `0087aa491` 的树相同。集中验证
查出本人五处缺陷（都是钉旧形状的用例没随改），修正并复验：

- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 174 个 TS 文件无告警，改动的 26 个生产文件另过
  promises 配置；prettier：改动的 TS、guard-manifest 与本 RFC 的三件套通过。
- **选择**：按 RFC-533 的口径（改动的用例、全部 `tests/architecture/`、按路径主干与不带目录的文件名读被改文件源码的用例、直接导入被改文件
  及其在 `src/` 里调用方的用例、经 `tests/` 内的 import 传递到被改测试助手的用例、逐个扫 `tests/` 的语料守卫）选出 1,989 个文件。本 RFC 改了
  127 个用例文件与 21 个测试助手（其中 119 个只按语法树补字段与 import），经助手的 import 闭包入选的很多。先跑语义相关的一层：上面的
  前三类与语料守卫，加上提到回收 / 蒸馏 / 启动程序 / 源终止 / 取消 / 人工关口停靠与被改装配名字的用例、直接导入语义上改了的文件的用例，
  共 1,164 个（其中 15 个只按关键字入选）。其余 840 个只经测试助手补的字段入选，那些字段的取值与此前未登记时等价（从不回收；出厂蒸馏策略——`resolveDistillPolicy` 对
  缺省配置给出的值与 `DEFAULT_DISTILL_POLICY` 相同），交给 CI 的全量分片。
- **语义层**（60 秒；候选 6 个 worker）：1,164 个文件，红的 33 个：
  - 本人缺陷五处，都是钉旧形状的用例没随改（design D4 写了随改，开发时漏了这几处）：
    1. `rfc359-w5-t19f`：新用例里一条持久化同一性的断言直接 `createInMemoryDb`，账本按文件记这类调用点、只降不升。改为 `describeEachProvider`
       取 `harness.db`，两个 provider 各跑一遍。
    2. `rfc379-daemon-lifecycle`：把“恢复时重跑登记步”改成“每步只跑一次”时，判据数了全部事件，而运行期作业的起停事件本来就会重复
       （Expected 92，Received 75）。改为只看启动步的 id。
    3. `rfc395-epoch2-boot-step-contract`：写死的步数 28 没改为 27。
    4. `rfc395-w0-history-contracts`：正则钉 daemon 交给 task-execution 装配的前三个字段相邻（`db`、`content`、`historyRestrictions`），新字段插在
       `db` 之后打断了它。新字段挪到 `historyRestrictions` 之后，正则不改。
    5. `rfc526-task-execution-required-selections-boundary`：按语法树钉 `composeCrossContextClosure`（task-execution 的 daemon 装配与维护 Worker）与
       `composeTaskExecutionParticipantBindings`（daemon 会话与 HTTP 装配）的整份实参清单。清单补上新实参（daemon 交会话的回收策略，维护 Worker 交
       `neverPruneTerminalWorkspaces`）。
  - 修正后全仓搜被改函数与删去名字的字符串形态：语义层之外只在测试助手与注释里出现，没有别的用例钉这些形状。`docs/dev-gotchas.md` 记两条。
  - 其余 28 个见下面的 A/B。
- **复跑**（候选 4 个 worker）：全部 `tests/architecture/`（`rfc376-report` 除外，它在 A/B 里）与改过的 6 个用例文件（含 `test-suite-policy`）共
  147 个，都过（`rfc379` 8 / 8、`rfc395-epoch2` 2 / 2、`rfc395-w0` 5 / 5、`rfc526` 14 / 14、RFC-534 用例 7 / 7、`rfc359-w5-t19f` 8 / 8）。
- **A/B**（候选与对照同时、各 3 个 worker、各用各的库；上一会话在两边各跑完 22 个时中断，余下 6 个两边同时重跑）：语义层红的其余 28 个
  文件。两边都红的 25 个、都过的 2 个（`clarify-review-combination-scenarios`、`rfc238-mcp-runtime-test-service`），`rfc395-v3-target-load` 候选过、
  对照红；按用例名 320 过 / 55 红对 320 过 / 56 红。名字不同的 6 个文件里，不同的都是 PostgreSQL 上撞时限的用例：候选独有 3 条——
  `review-detail-render-rfc158` 前一条超时后连接被关、下一条的钩子随之超时，`rfc395-v3-trace` 一条，`scheduler-clarify-dispatch` 的
  “agent-single emits clarify”（语义层里它在候选上 15.6 秒通过，这一轮对照也用了 31.4 秒）；对照独有 4 条。其余同名同错：`rfc167`（Expected
  `failed`，Received `running`）、`rfc321` 只因导出仓库没有真实的 git 历史，`rfc376-report`、`rfc311`、`rfc310`、`rfc359-w6-t26`、各 `rfc395-*`、
  各 `scheduler-*`、`lifecycle-property`、`epoch1-permission-text-backup` 与 `rfc257` 撞时限。
- **架构报告**（候选与对照各出一份）：模块级可变单例 71 → 66（删去的正是两个文件的 5 条）；计数、门与指标没有变化（task-execution 组合层控制流
  的 10 处里一处只是行号移动）；跨上下文导入 7,530 → 7,532（daemon 应用对两个登记函数的值导入删去；跨上下文闭包、task-execution 与
  integration 的 daemon 装配各多一条对 task-execution `public/types` 的类型导入，维护 Worker 多一条对 task-execution 组合的值导入）；模块符号
  属主 32,475 → 32,472；写入入口清单 2,387 → 2,386（`schedule.ts` 的条目随删去的 setter 去掉）；其余只有行号移动。
- **收口文档**：plan、`STATE.md` 与 `docs/dev-gotchas.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **回收判定不变**：此前策略为空或转移不是 `done` / `canceled` 时给不回收，策略抛错时记告警给不回收；现在策略是入参，非终态的短路与抛错时的
  告警逐字不变，“策略为空”由具名的 `neverPruneTerminalWorkspaces`（任何转移都给不回收）表达——维护 Worker 交它，与此前它那个 realm 里恒为空
  逐字等价（Worker 经恢复管理面只写 `interrupted`）。四个读者都仍在事务外算好判定再交进 CAS（源终止照旧在它自己的可串行化事务里算）。
- **同一份策略**：daemon 在装配 memory 与 task-execution 之前以本会话的库与配置组合一次 webhook 回收策略，同一个对象进 task-execution 的持久化
  依赖（运行期生命周期写者，聚合带着它给取消路径）、跨上下文闭包（人工关口的停靠）、延迟仓库准备与模块集合（daemon 会话与 HTTP 装配的
  参与者绑定从那里取），以及 integration 的源终止。`enabled` 照旧每次重读配置的 `webhookTaskWorkspaceAutoCleanup`。
- **蒸馏准入不变**：daemon 交给 memory 组合的读取器就是此前登记的那一个（每次重读配置、解析失败回落 `DEFAULT_DISTILL_POLICY`）；
  `enqueueDistillJob` 第一步照旧调它（此前读模块变量），准入、去抖与输出语言逐字不变。
- **登记步的删除**：此前 prepare 阶段跑一次、每次恢复执行前再跑一次（找回可能被同进程别的会话改写的登记）；现在两条策略随会话装配，从
  装配起就在，暂停 / 恢复之间没有可被改写的进程级状态，删去该步与只为它存在的 `beforeResume` 后，启动、暂停与恢复的其余顺序不变。
- **用例与锁**：登记 / 设置策略的用例改为把策略交进各自用的装配（`rfc300` 两个、`rfc359-w8` / `rfc359-w12` 源终止、`rfc370` 判定、`rfc381`
  集成束、`rfc366` / `rfc386` / 两个 `memory-distill-*` 蒸馏）；测试助手的缺省取从不回收与出厂蒸馏策略（与此前未登记时逐字等价），需要真实
  策略的用例显式交入；119 个构造持久化依赖、遗留写者入参与 memory 组合输入的用例与助手按语法树补字段；钉启动步与恢复时重登记的
  `rfc359-w3-t15`、`rfc395-epoch2-boot-step-contract`、`rfc379` 随改（恢复时不再重跑任何步，`rfc379` 只数启动步）；钉装配实参清单与字段相邻的
  `rfc526`、`rfc395-w0-history-contracts` 随改（实参清单补上新实参，新字段放在被钉的那几个字段之后）；`rfc480` 改钉维护 Worker 取具名的从不
  回收；guard-manifest 登记 RFC-534 用例，改动过的条目行数随改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-533 转 Done）；实现与验证后再提交
`refactor(backend): RFC-534 终态工作区回收策略与记忆蒸馏策略由会话交入（RFC-294 S12 第十五步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
