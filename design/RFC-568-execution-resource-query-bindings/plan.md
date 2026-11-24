# RFC-568 实施计划

依赖：RFC-567。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-568-T1 owner 一侧**：两个工厂撤出 resource-catalog 的 public，装配根交出（design §1）。
- **RFC-568-T2 消费方与 bootstrap**：task-execution 的七处、intent 与 knowledge-evolution 各一处从入参拿工厂引用；读任务详情的一串函数改收
  `WorkflowReadSource`；动作执行环境多一个读；各装配文件转交；bootstrap 七个文件从 resource-catalog 的装配根取工厂交入（design §2、§3）。
- **RFC-568-T3 门与用例**：`PUBLIC_SURFACE_DEBT` 与 `counts.json` 降低；钉着旧位置的用例随改；构造这些消费方的用例与助手补入参；新增测试助手
  `tests/helpers/taskDetailRead.ts`；新增 RFC-568 用例并登记 guard-manifest。
- **RFC-568-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-568-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 两个工厂不再从任何 `public/*` 导出；全部模块的源码不从 resource-catalog 取它们；装配根交出
- [x] AC-2 行为不变；消费方的入参与 owner 的工厂对得上，由编译器检查；事务里的读仍用事务句柄
- [x] AC-3 `PUBLIC_SURFACE_DEBT` 删去 2 条，`public-surface-deviations` 42 → 40；新增 RFC-568 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 的一个 macOS e2e 分片没有分到 runner、windows-platform 的 push 运行被同一提交的定时运行顶替（环境性），已归因、未重跑（见下）

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。用例在主树里跑（工作树里只有本会话的改动，共享 index 为空）；
读已提交源码的用例、架构报告与变异在候选导出仓库里跑（HEAD `f8dc493ec` 加本 RFC 的 166 个路径，用本地提交固化，树哈希与“HEAD 加这些路径”的树哈希
相同），对照是同一 HEAD 的另一份导出。

- **本人缺陷两处（已修复并复验）**：① 漏查一处钉着源码文本的用例：`rfc292-trigger-source-locks` 钉着任务详情读里的
  `createTaskDetailQueries(db).read(id)`，本 RFC 给这个调用多交了一个工厂，选集运行里红。它锁的是“详情读只经这一个查询、冻结的触发 JSON 只在那里折成
  派生链接”，这一点没变；把钉住的文本改成新的调用并写明原因。随后按旧调用形态在全部用例的字符串字面量里搜了一遍，没有别的钉点。② 给
  `bootstrap/daemonModules/intent.ts` 写的一行注释里用了单词 read：架构报告按“消费方文件的全文里有没有这个成员名”给 public 类型的方法登记消费方，
  于是不相干的 `ApplicationConfigurationQueries.read` 多了一条来自这个文件的消费边。改写注释后，报告里 public 面这一节与对照只差本 RFC 预期的那几条。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 153 个 TS 文件（35 个生产文件、103 个用例文件、15 个测试
  助手）无告警，生产文件另过 promises 配置；prettier：改动的代码、两份 JSON 与三件套通过。
- **选择与语义层**（SQLite；60 秒；主树 4 个 worker）：按 RFC-533 的口径与 RFC-550 的选法选出 1286 个用例文件（语义层 778、经夹具与测试助手补 508；
  这次没有按“只改导出行”缩小任何一个生产文件的读者）。首轮 1285 个通过，1 个红就是上面 ①。首轮运行期间按实现门的阅读对三个生产文件做了只涉及
  类型与注释的改动（见下节），所以首轮结束后在最终的树上重跑了点名这三个文件、`rfc292` 那个用例与 guard-manifest 的 124 个用例文件，全部通过；
  ② 的注释改写之后又重跑了点名 bootstrap daemon 模块的 113 个用例文件，全部通过。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`tests/architecture/` 的全部 142 个用例文件、`rfc317-*` / `rfc294-*` 与钉着本次改动位置的 9 个
  边界用例，共 166 个文件、1570 条全部通过。其中 `rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221、RFC-568 用例 9 / 9、
  `rfc294-architecture-preflight` 15 / 15、`rfc294-review-offered-edge-dag` 8 / 8、`rfc317-guard-corpus-floor` 24 / 24、
  `rfc317-guard-negative-fixture` 17 / 17、`rfc317-table-ownership` 19 / 19、`rfc292-trigger-source-locks` 8 / 8、
  `rfc482-te-participant-bindings-boundary` 9 / 9、`rfc483-human-gate-badge-read-model-boundary` 7 / 7、`rfc485-te-row-query-bindings-boundary` 7 / 7、
  `rfc551-public-unconsumed-sweep-lock` 11 / 11、RFC-565 用例 9 / 9、RFC-566 用例 8 / 8、RFC-567 用例 7 / 7。
- **变异验证**（候选导出仓库里，每种变异复原后导出仓库无改动、树哈希不变）：十九种变异都被认出。
  - 结构：resource-catalog 的 public 重新交出两个工厂中的任一个（RFC-568 用例 ① 与 `rfc294-architecture-preflight` 同红）；task-execution 的文件
    从 resource-catalog 的装配根取代理工厂、knowledge-evolution 的文件从它的 infrastructure 取工作流工厂（用例 ②）；子任务铸造的锚点检查与工作组
    快照读各自改到事务外（用例 ③ 的整行文本）；bootstrap 用别的工厂绑定任务主体查询（用例 ③ 与 `rfc482` 同红）。
  - 动作执行：环境的脚本定义读不再只取目录里的工作流、取不到时回空串而不是 null（RFC-568 用例的行为断言）；执行器放过取不到的定义
    （`rfc359-t3-action-execution-runners` 红）。
  - 九处消费方各自“不再向 owner 读”：任务主体查询的工作流名（`rfc395-a2-task-subject` 红）、Intent 的代理端口名（`rfc234-dump-builder` 红）、
    动态工作流的规划代理（`rfc359-w4-b1-batch2a-adapters` 红）、任务路由的工作流身份（`rfc359-w7-task-route-conformance` 红）、工作流同步的版本
    复检（`rfc395-a2-task-definition` 红）、融合任务铸造的工作流文档（`fusion-engine` 与 `rfc387-continuation-semantics` 红）、子任务铸造的锚点
    （`rfc243-call-workflow` 红）、工作组快照的成员代理（`rfc359-w4-d19c-adapters` 红）、融合持久化的内置工作流（`fusion-engine` 红）。
  - 变异脚本自身的一处疏漏：任务路由那一种起初只配了 RFC-568 用例，而它不钉被改的那一行，首轮漏报；Intent 与动态工作流那两种起初只由整行文本
    认出。改配走那条路径的行为用例，并补上后五种，让九处消费方各有一种行为层的变异。
  - 类型层：给 owner 的两个工厂各加一个必填入参，候选导出里 `tsc` 报 200 处、104 个文件——bootstrap 的七个交接文件（12 处）、owner 自己的两处
    使用、84 个用例文件与 11 个测试助手的交接处，其中 RFC-568 用例里取 owner 工厂类型的十条编译期断言全部报错（第十一条比的是绑定后的任务主体
    查询，与工厂的入参无关）；task-execution、intent 与 knowledge-evolution 的源码一处不报（它们只声明自己的入参类型）。
- **架构报告**（候选与对照各出一份）：60 个计数里只有 `public-surface-deviations` 变了，42 → 40（删去的正是清单里那 2 条）；public 面 991 → 989，
  两个闭合读类型（`AgentExecutionQueries`、`WorkflowExecutionQueries`）的消费方从“经工厂”变成 intent、knowledge-evolution 与 task-execution 的直接
  类型引用，它们引用的另两个类型只是少了工厂这一个引用方，未消费的 public 符号仍为 0；变更入口普查
  2394 → 2393（装配文件里的 `createTaskSubjectQueries` 改名为 `bindTaskSubjectQueries` 后不再匹配普查的名字模式，其余逐条相同）；跨 context import
  7529 → 7532，其中模块之间的 6289 → 6285，bootstrap 取 resource-catalog 的 208 → 215（交接处）；生产文件多 1 个（`executionResourceReads.ts`）；
  目标边（111）、DAG 外 offered 边（2）、跨 context 内部文件对（6）与其余各节不变（任务执行权限、任务自有效果、事务外效果三节只有行号后移）。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 7 个用例文件，46 / 46 通过。

## CI（AC-4）

- `0a1069435`（实现，父提交是 `f8dc493ec`）：exact SHA 主 CI run 45451751255 的 70 个 job 里 68 个成功——全部后端分片、前端、三个平台的构建与
  检查、ubuntu 与 windows 的全部 e2e 分片、macOS 的另三个 e2e 分片（1/4、2/4、3/4）通过；`Playwright e2e (macos-latest shard 4/4)`
  （job 138658353003）被取消，汇总格 `CI required` 随之不通过。同一提交触发的 git-protocols-e2e（run 45451751445）通过；windows-platform 的 push
  运行（run 45451751345）被取消。
- **归因**：都不在本 RFC。① macOS 那个分片没有分到 runner、没有任何步骤，注记是
  `The job was not acquired by Runner of type hosted even after multiple attempts`（附 macOS arm64 容量提示），与当天前三个提交同一形态。
  ② windows-platform 的 push 运行跑到 `Typecheck` 一步时被工作流的并发组取消，注记是
  `Canceling since a higher priority waiting request for windows-platform-refs/heads/main exists`：同一个工作流的定时运行（run 45452927828，
  `schedule` 事件）在 17:50（UTC）对**同一个提交** `0a1069435` 启动，顶替了它；那次定时运行全部通过，是这个提交在 windows-platform 上的结果。
  两处都未重跑，`docs/audit-backlog.md` 的 macOS runner 容量一节一并补记。
- **macOS e2e 4/4**：自 `4f1dcae66`（RFC-564）之后的四个提交（RFC-565～RFC-568）都没有这一格的结果；同一套 e2e 在 ubuntu 的三个分片与 windows 的
  四个分片上每次都通过。要看更后面的提交。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS（阅读中改了四处，都只涉及类型与注释）：

- **每次读用的还是原来的句柄**：九处调用点逐一核对——任务路由两处传 `source.db` / `dependencies.db`，融合任务铸造传 `dependencies.db`，子任务铸造
  传事务句柄 `tx`，任务主体查询传构造时收到的句柄，工作组快照传快照读事务句柄，动态工作流持久化传 `this.db`，Intent 传 runner 当前的句柄，融合
  持久化传入参里的 `db`；动作执行环境在自己的 `db` 上读。交入的工厂就是原来各处 import 的同一个函数，所以语句与条数不变。
- **每条路径都拿到了 owner 的工厂**：provider runtime 的 `createWorkflowExecutionQueries` 交给任务路由操作、融合任务铸造与（经运行期参与者）子任务
  铸造；延后的仓库准备、工作组轮次、动态工作流持久化、两个动作执行器、Intent 的持久化与两个维护装配、融合操作各由 bootstrap 交入；
  `crossContextClosure` 用 `bindTaskSubjectQueries` 造出 collaboration 的绑定里那一格。入参全部必填。
- **任务主体查询的形状没变**：`bindTaskSubjectQueries(factory)` 返回的仍是 `(db) => TaskSubjectQueries`，collaboration 的调用点照旧传自己手里的句柄。
- **脚本动作的判定没变**：执行器原来读目录里的工作流文档、取第一行的 `definition`，没有行或摘要不符就以 `de-script-revision-unavailable` 失败；现在
  经环境的 `catalogWorkflowDefinition` 取到同一个字符串或 null，判定与随后的 `JSON.parse` 用的是同一个值。
- **阅读中的四处改动**：`TaskDetailReadSource` 与 `TaskDetailSource` 是同一个形状的两个类型，合成 `executionResourceReads.ts` 里的
  `WorkflowReadSource`；新类型原先插在 `workflowIdentities` 与它的说明注释之间，挪到注释上方；两处注释把工作流同步读的东西写成了“文档”，实际读的
  是版本，已改正。
- **用例一侧**：构造处补上的都是 resource-catalog 的实现本身（取自它的 infrastructure），与 bootstrap 交的是同一个函数；`tests/helpers/taskDetailRead.ts`
  只是把 owner 的工厂绑到 `getTask` 上。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交；RFC-566 与 RFC-567 的转 Done（两次主 CI 的 macOS
作业都没有分到 runner，已归因，`docs/audit-backlog.md` 补记）同批。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按
exact SHA 跟 CI。
