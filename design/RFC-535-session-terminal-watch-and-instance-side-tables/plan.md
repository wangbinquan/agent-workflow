# RFC-535 实施计划

依赖：RFC-534。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-535-T1 终态看门**：`executionWatch.ts` 改为 `createTaskTerminalWatch()`；运行期选项、动作执行依赖加必填的看门；daemon 的
  task-execution 装配建一份交给运行期参与者、`hostTasks` 与模块集合，会话的已提交事件消费者调它（design D1）。
- **RFC-535-T2 参与者**：`agentExecutionEffect.ts` 的参与者改为带私有字段的实例，删去模块级表（design D2）。
- **RFC-535-T3 对照范围**：`scope.ts` 把范围盖在快照的行数组上，删去模块级表（design D3）。
- **RFC-535-T4 工作区读取**：`workspaceRead.ts` 的能力登记表归每个读取作用域（design D4）。
- **RFC-535-T5 材料引用**：`createNativeAgentMaterialReferences()`；每份材料定义一张、交给它建的编译器，遗留编译自建一张；删去模块级表、
  `bindNativeAgentMaterialReference` 与别名（design D5）。
- **RFC-535-T6 用例与锁**：新增 RFC-535 用例并登记 guard-manifest；读旧形状的用例与测试拓扑随改（design D6）。
- **RFC-535-T7 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、读被改文件源码的用例（按路径主干、不带目录的文件名与删去的名字）、
  直接导入被改文件与其在 `src/` 里调用方的用例、经 `tests/` 内 import 传递到被改测试助手的用例、逐个扫 `tests/` 的语料守卫、全部
  `tests/architecture/`，红的与 HEAD 同时 A/B；架构报告对照。
- **RFC-535-T8 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第三步。

## 验收清单

- [x] AC-1 `executionWatch.ts` 没有模块级状态与 reset；看门每会话一份，子调用节点、动作执行与已提交事件消费者用同一份
- [x] AC-2 参与者、对照范围、工作区读取与材料引用不再有进程级侧表；解读与判定不变
- [x] AC-3 模块级可变单例 66 → 61、计数不升；锁随改；新增 RFC-535 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；1 分钟负载约 26～44，另有会话在跑）。验证在候选导出仓库里跑（HEAD `bc4b011e5` 加本 RFC 的 40 个路径，核对与工作树
逐字相同）；对照导出仓库与 `bc4b011e5` 的树相同。集中验证没有查出本人缺陷：

- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 39 个 TS 文件无告警，改动的 18 个生产文件另过
  promises 配置；prettier：改动的 TS、guard-manifest 与本 RFC 的三件套通过。
- **选择**：按 RFC-533 的口径（改动的用例、全部 `tests/architecture/`、按路径主干与不带目录的文件名读被改文件源码的用例、直接导入被改文件
  及其在 `src/` 里调用方的用例、经 `tests/` 内的 import 传递到被改测试助手的用例、逐个扫 `tests/` 的语料守卫）选出 937 个文件，另按被改与
  删去的名字的字符串形态（RFC-534 那条教训）补 2 个，共 939 个，全部跑；再按分段拼出的路径（`'oracle', 'scope.ts'` 一类）搜一遍，没有漏选。
- **首轮**（60 秒；候选 6 个 worker）：939 个文件。改过的 17 个用例文件全过（RFC-535 用例 9 / 9、`test-suite-policy` 12 / 12、`rfc404` 5 / 5、
  `rfc243-executor-facade` 25 / 25、`rfc243-call-workflow` 13 / 13）；红的 28 个，见下面的 A/B。
- **伪造的依赖**：全仓搜以 `as unknown as` / `as never` 伪造的运行期状态与动作执行依赖（RFC-533、RFC-486 的教训）：`rfc404-port-bindings` 补上
  看门并加一条子调用端口经会话看门等待的断言；`rfc395-a2-subject-call-closure`、`rfc359-w7-runtime-composition-roots`、`rfc415-port-bindings` 与
  `rfc419-port-bindings` 的伪造走不到看门（停在第一次持久化调用或只读状态、结果），未改。
- **变异验证**：在候选导出仓库里把看门的表挪回模块级，RFC-535 用例红两条——真实语料认出 `module-level collection:executionWatch.ts:watchers`，
  “两份看门互不唤醒”收到另一份看门的 `failed`（Expected `done`）；复原后与工作树逐字相同。
- **A/B**（候选与对照同时、各 3 个 worker、各用各的库）：首轮红的 28 个文件。两边都红的 23 个、都过的 3 个（`rfc384-daemon-intent-bundle`、
  `rfc395-q1-clarify-history`、`scheduler-audit-s02-multirepo-retry-rollback-noop`），只在对照上红的 2 个（`rfc238-mcp-runtime-test-service`、
  `scheduler-audit-s05-fanout-inner-chain`），没有只在候选上红的文件；按用例名 358 过 / 58 红对 356 过 / 60 红。名字不同的：PostgreSQL 一支撞
  时限的若干条（`scheduler-clarify-dispatch`、`scheduler-wrapper-scope-dependencies`、`scheduler-rfc040-wrapper-await`、`scheduler-audit-s05`、
  `rfc238`），`rfc294-architecture-preflight` 的一条语料扫描撞 60 秒时限，以及 `tasks` 的 SQLite 一支一条 “GET /:id/diff includes untracked
  files”——报的是与两边 PostgreSQL 一支相同的 “repository preparation did not settle”，前面有 SQLite 的 `BEGIN IMMEDIATE` 失败与 3.5 秒的重新
  克隆；首轮里候选的 SQLite 一支这条通过，本 RFC 不碰仓库准备。其余同名同错：`rfc167`（Expected `failed`，Received `running`）、`rfc321` 只因
  导出仓库没有真实的 git 历史、`tasks` 的 PostgreSQL 一支 diff，`rfc376-report`、`rfc400`、`rfc311`、`rfc310`、`rfc359-w6-t26`、`rfc359-w9`、各
  `rfc395-*`、各 `scheduler-*`、`lifecycle-property` 与 `review-detail-render-rfc158` 撞时限（`rfc395-a3-oracle-evidence` 与 `rfc359-w9` 的 SQLite
  一支两边全过）。
- **架构报告**（候选与对照各出一份）：模块级可变单例 66 → 61（删去的正是五个文件各 1 条）；计数、门与指标没有变化；后台作业 35 → 35（看门的
  轮询计时器随函数改名换了 id）；跨上下文导入 7,532 → 7,532（daemon 会话对 `notifyTaskTerminal` 的值导入删去，task-execution 的 daemon 装配
  多一条对看门工厂的值导入）；模块符号属主 32,472 → 32,470；写入入口清单 2,386 → 2,388（`agentMaterialCompiler.ts` 与 `executionWatch.ts` 各
  多一条）。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **看门语义不变**：`createTaskTerminalWatch()` 的 `notify` / `watch` 就是此前三个函数逐字搬进闭包——先读、登记、再读（关上“订阅期间刚好转终态”的
  窗口），平台定时原语轮询兜底（缺省 20 秒），中止给 `aborted`、行被删给 `missing`，`notify` 只认四个终态、取出即删、单个等待者抛错不影响别的；
  不同的只是表归实例：一份看门的 `notify` 只结算登记在它那张表上的等待者。
- **同一份看门**：daemon 的 task-execution 装配建一份，同一个对象进运行期参与者（`BoundRunTaskOptions.terminalWatch`，子调用节点的
  `watchTerminal` 读它）、`hostTasks`（开发自动化的智能体与脚本动作执行经展开取到，`awaitTerminal` 读它）与模块集合（daemon 会话的已提交事件
  消费者 `notifyExecutionWatch` 调它）。运行期在装配里只组一次（`rfc388` 钉死），会话里全部任务的子调用节点用的是这一份；维护 Worker 不跑子调用
  节点与动作执行，不建看门。
- **参与者解读不变**：签发出的仍是冻结的不透明对象，只有 `agentExecutionEffect.ts` 能从私有字段取回本机持久化、节点执行与只读判定；副本、
  伪造对象照旧抛 `agent-execution-task-participant-unavailable`，没给参与者照旧得 `undefined`。
- **对照范围不变**：快照给自己建的每个任务行数组（含按需补建的空数组）盖一次范围，两个 `require*` 从数组本身读；没盖范围的数组照旧按完整任务，
  `node` 范围的逐行校验与不全时的拒绝逐字不变。属性不可枚举，数组的内容与相等性不变。
- **工作区读取不变**：能力只在本作用域里发、记进本作用域的登记表，`close()` 时作废并把 `live` 置假，判定照旧三项都看（补正后；初版删了
  登记表，见 CI 一节）。
- **材料引用不变**：引用表归每份材料定义，它建的编译器编出计划时记进去、`materialReference` 从里面查；生产里每次运行只取一份定义、编译与查引用
  都走它（任务代理运行族、系统代理运行、冒烟与系统代理运行族），取值规则（记过的、源计划的、否则新发并记下）逐字不变。走旧 `buildSpawn` 的
  系统代理运行：遗留编译自建的表只用于它交出计划，此后的引用由本次运行的定义发、同一计划同一引用——此前那张进程表里遗留编译记下的引用没有
  别的持有者。
- **用例与锁**：读旧形状的用例改用看门实例（`rfc243-call-workflow` 的事件泵、`rfc243-executor-facade` 的看门单测、`rfc359-w8-task-route-capability-parity`
  的消费者、`rfc359-t3-action-execution-runners`、`rfc310-pr4-execution-host`、`rfc359-w8-runtime-participants-conformance` 与
  `tests/helpers/executionTerminal.ts`），测试拓扑按库各给一份（`tests/helpers/taskTerminalWatch.ts`）；`rfc404-port-bindings` 的伪造状态补上看门并
  加一条子调用端口经会话看门等待的断言；材料引用的用例（`rfc370-*`、`rfc489`、`rfc491`、`tests/helpers/nativeRuntimeSmoke.ts`）改用定义或引用表，
  跨定义相等的断言改为同一份定义内相等、两份定义互不相通；guard-manifest 登记 RFC-535 用例，改动过的条目行数随改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-534 转 Done）；实现与验证后再提交
`refactor(backend): RFC-535 终态看门由会话构造、按对象挂的侧表归各自实例（RFC-294 S12 第十六步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
