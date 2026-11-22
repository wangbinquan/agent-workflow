# RFC-533 实施计划

依赖：RFC-532。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-533-T1 会话预算**：`childBudget.ts` 删去模块级状态与 setter / reset，导出 `createChildTaskBudgetRuntime`（design D1）。
- **RFC-533-T2 交入与读取**：daemon 的 task-execution 装配构造一份并经运行期选项交给子调用节点；会话的生命周期放行与配置热应用调这一份，
  热应用一并推深度（design D2）。
- **RFC-533-T3 用例与锁**：新增 RFC-533 用例（含深度热应用的回归用例）并登记 guard-manifest；读旧形状的用例与锁随改（design D3）。
- **RFC-533-T4 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、读被改文件源码的用例（按路径主干与删去的名字）、直接导入被改文件与
  其在 `src/` 里调用方的用例与全部 `tests/architecture/`，红的与 HEAD 同时 A/B；回归用例在 HEAD 上红、在候选上过；架构报告对照。
- **RFC-533-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第一步。

## 验收清单

- [x] AC-1 `childBudget.ts` 没有模块级可变状态与导出的 setter / reset；预算每会话一份
- [x] AC-2 容量热应用、懒建与放行不变；深度保存后立即生效（回归用例）
- [x] AC-3 模块级可变单例 79 → 71、计数不升；锁随改；新增 RFC-533 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；1 分钟负载约 17～27）。验证在候选导出仓库里跑（HEAD 加本 RFC 的路径，核对与工作树逐字相同）：首批的候选以 `6a911ae34`
为底，修正后的候选以 `e86211755` 为底（两者只差只改文档的 `e86211755`）；对照导出仓库与 `e86211755` 的树相同。集中验证查出本人一处缺陷，修正
并复验：

- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 19 个 TS 文件无告警，改动的 8 个生产文件另过
  promises 配置；prettier：改动的 TS、guard-manifest 与本 RFC 的三件套通过。
- **回归用例识别原缺陷**：`rfc266` 的深度回归用例用的是新接口，在 HEAD 上无从运行；把它的断言按 HEAD 的接口写成临时探针在对照
  （`6a911ae34`）上跑——经 `PUT /api/config` 保存 `maxInvocationDepth: 5` 后，深度判据 `currentMaxInvocationDepth(3)` 在两个 provider 上都得 3
  （Expected 5，Received 3），缺陷属实；候选上该回归用例通过。探针已删。
- **首批**（60 秒；候选 5 个 worker）：729 个文件——改动的用例、全部 `tests/architecture/`、读被改文件源码的用例（按路径主干与删去的名字）、
  直接导入被改文件及其在 `src/` 里调用方的用例、经 `tests/` 内的 import 传递到被改测试助手的用例。红的 22 个：
  - 本人缺陷一处：`rfc404-port-bindings` 以 `raw as unknown as TaskMechanicsState` 伪造状态，运行期选项里没有会话的预算，`tsc` 看不到，
    `budget.maxInvocationDepth()` 抛 `TypeError`。`docs/dev-gotchas.md` 已有这条教训（RFC-527、RFC-486：给运行期选项或依赖加必填成员后全仓搜
    对被改类型的伪造），本 RFC 开发时没照做。夹具补上会话的预算，并加一条热应用后深度取实时值的断言；随后全仓搜伪造
    `TaskMechanicsState`、伪造 `taskExecutionModules` 与手搭运行期选项的用例，都在首批里，没有别处因此红。
  - 其余 21 个见下面的 A/B。
- **次批**（候选 5 个 worker）：其余 179 个文件，另加修正后的 `rfc404-port-bindings` 与此前没选到、提到被改字段或文件的
  `rfc349-config-route-provider-boundary`、`rfc473`：182 个，红的 10 个，见 A/B（`rfc404-port-bindings` 4 / 4）。
- **补跑**（候选 3 个 worker）：按不带目录的文件名再搜一遍，又找到前两批没选到的 10 个——`rfc524`、`rfc527` 与
  `scheduler-wrapper-fanout-routing` 以 `at('bootstrap', 'daemonSession.ts')` 这样分段拼出的路径读被改文件的源码（`rfc473` 也是这样漏的：它写成
  模块内的相对路径），其余 7 个只在注释或伪造的消费者端口里出现被改文件的名字：10 个都过。`docs/dev-gotchas.md` 在 RFC-530 那条教训后补一句。
- **A/B**（候选与对照同时、各 3 个 worker、各用各的库）：两批红的 31 个，另加两个调子调用端口的用例（`rfc420-port-bindings`、
  `node-kind-behavior-table`），共 33 个。两边红的是同样的 16 个文件，其余 17 个两边都过；按用例名 578 过 / 34 红对 579 过 / 33 红。
  名字不同的只在 PostgreSQL 一支撞时限或 5 秒内等不到上游起跑（`scheduler-wrapper-scope-dependencies` 两边都红在同一处
  `waitForFile(count-upstream, 5_000)`，该用例没有调用节点；SQLite 一支两边全过）；其余同名同错——`tasks` 的 `GET /:id/diff`
  （“repository preparation did not settle”）、`rfc167`（Expected `failed`，Received `running`）、`rfc321` 只因导出仓库没有真实的 git 历史，
  `rfc376-report`、`rfc294-architecture-preflight`、`rfc359-w6-t26` 与各 `scheduler-*`、`lifecycle-property` 撞时限。
- **架构报告**（候选与对照各出一份）：模块级可变单例 79 → 71（删去的正是 `childBudget.ts` 的 8 条）；计数、门与指标没有变化；跨上下文导入
  7,530 → 7,530（daemon 会话对两个预算钩子的值导入删去，HTTP 装配的值导入改为类型导入，task-execution 的 daemon 装配多导入工厂）；模块符号
  属主 32,484 → 32,475；写入入口清单 2,388 → 2,387（`childBudget.ts` 的条目随删去的 setter 与新工厂增减）。
- **收口文档**：plan、design 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例文件，见提交说明。

## CI（AC-4）

- `4d938230a`（实现，父提交是 `e86211755`）：exact SHA 主 CI run 45000827878 的 70 个 job 里，后端分片 44/44 红在 `test-suite-policy` 的
  “provider HTTP tests do not sleep to wait for a write”——本 RFC 在 `rfc266` 新加的回归用例里一处 30ms 直线式睡眠（第 131 行；本人缺陷，集中验证
  没选到逐个扫 `tests/` 的这条守卫），`CI required` 随之红，其余 68 个通过；同一提交触发的 windows-platform（run 45000827886）与
  maintenance-soak-nightly（run 45000827958）通过。未重跑。
- `b9d0486f5`（补正：该用例改用因果屏障——预算的 `acquire` 同步判定，一次微任务即可——并做变异验证；`docs/dev-gotchas.md` 记一条）：主 CI
  run 45003962438 的 70 个 job 第 1 次全部通过。
- 本 RFC 的落档提交 `e86211755`（只改文档；同一提交记下 RFC-532 转 Done）：主 CI run 44984036715 的 70 个 job 第 1 次全部通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **预算语义不变**：`ensure` 照旧在实时容量为空时以第一个调用者的容量播种、第一次用到才建预算并从库重建（预算先赋值再重建，重建期间并发的
  调用者与生命周期放行看到的是同一份，与此前相同）；`notifyStatus` 在预算未建时什么都不做，已知的子任务不读库，未知的读一次 `isChildTask`
  后缓存，读失败照旧吞掉等下一次转移；`registerKnownChild` 就是此前的 `registerKnownChildTask`；`applyLimits` 写实时容量并当场重扫等待队列
  （与此前的 `setChildTaskBudgetCapacity` 相同），另写实时深度；深度判据仍是 `实时值 ?? 冻结值 ?? 3`、只在派生子任务的那一刻读。
- **一份运行期只服务一个查询对象**：此前单例在换了查询对象时重建（并行用不同库的用例串扰的防线）；现在每个会话装配时以本会话的
  `persistence.childBudget` 建一份，换库时整个 task-execution 装配连同它一起重建，串扰在构造上不可能。会话重建后实时值从空开始，新任务以
  启动时读到的配置播种——保存设置时配置文件已写入，取到的就是保存的值，用户看到的行为不变。
- **同一份对象**：`composeDaemonTaskExecutionModules` 在持久化建好之后构造，同一个对象进运行期选项（`BoundRunTaskOptions.childTaskBudget`，
  子调用节点的 `budget` 端口读它）、模块集合（daemon 会话的已提交事件消费者 `notifyChildBudget` 调它）与 provider（HTTP 装配的热应用调它）；
  `daemonApplication.ts` 交给 HTTP 装配的 `taskExecution` 就是会话的 `taskExecutionModules`。子任务是同一会话里的任务，取到的是同一份。
- **深度热应用恢复**：热应用的输入一直带 `maxInvocationDepth`（system-operations 的保存用例照常交出），现在与容量一起推给会话的预算；设置页
  “调用链最大深度，保存后立即生效”的文案重新属实。已在跑的子任务不受影响（判据只在派生时读）。
- **用例与锁**：读旧形状的用例改用会话的运行期（`rfc287-t14` 改写并加两份互不相通的一条、`rfc359-w8`、`rfc456`、`rfc390`、`rfc266` 加经
  `PUT /api/config` 的深度回归用例）；测试拓扑与 provider 用例助手按查询对象各给一份（`tests/helpers/childTaskBudget.ts`）；以
  `as unknown as TaskMechanicsState` 伪造状态的 `rfc404-port-bindings` 补上会话的预算并加一条热应用后深度取实时值的断言；guard-manifest 登记
  RFC-533 用例，改动过的条目行数随改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-532 转 Done）；实现与验证后再提交
`refactor(backend): RFC-533 子任务预算由会话构造、调用链深度的热应用恢复（RFC-294 S12 第十四步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
