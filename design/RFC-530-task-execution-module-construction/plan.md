# RFC-530 实施计划

依赖：RFC-529。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-530-T1 绑定时构造**：`composeProcessTaskExecutionBinding({ db, daemonGeneration })` 构造执行模块；bootstrap 的 SQLite 一支交入
  `DAEMON_GENERATION`；`composition.ts` 删去单例与 `createTaskExecutionTestModule`（design D1）。
- **RFC-530-T2 只服务用例的入口**：驱动生命周期里读单例的 5 个导出函数与 `createTaskExecutionTestModule` 移进测试助手，`clearTaskDriverLifecycleForTesting`
  只清心跳；删去被覆盖的 `tasks` 与 `composeTaskCancellation`；源终止参与者的登记表必填（design D2）。
- **RFC-530-T3 用例与锁**：测试助手持有测试用的执行模块；直接取单例的用例与靠源终止回落的用例随改；rfc385 / rfc388 / rfc359-w8 / rfc526 的锁随改；
  新增 RFC-530 用例并登记 guard-manifest（design D3）。
- **RFC-530-T4 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、读被改文件源码的用例、直接导入被改文件与被改文件在 `src/` 里的调用方的
  用例、经测试助手取执行模块的用例与全部 `tests/architecture/`，与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-530-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 3 项达成。

## 验收清单

- [x] AC-1 不在 import 期构造执行模块；组合层不导出单例；SQLite 绑定在绑定时构造、每个会话一份
- [x] AC-2 同一会话里认领、驱动、停止与后台共用同一份；源终止照旧用会话的登记表
- [x] AC-3 只服务用例的入口不在生产代码里；计数不升
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿（实现提交有一格本 RFC 的问题〔`rfc514`〕，由补正 `998ecb1b3` 修复后通过；补正提交另有两格
      环境性红格——外链 503 与 PostgreSQL 用例在负载下撞 5 秒时限——都不是本 RFC 的改动，未重跑；见 §CI）

## 集中验证

本机全程高负载（10 核；1 分钟负载约 35～64）。验证在候选导出仓库里跑（HEAD `e031a55dd`，其后只多了只改文档的 `c0237b3ce`，加本 RFC 的
路径，核对与工作树逐字相同）；对照导出仓库与 HEAD 的树相同。集中验证查出本人两处缺陷，修正并复验；另补一条回归用例：

- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 59 个 TS 文件无告警，改动的 8 个生产文件另过
  promises 配置；prettier：改动的 TS、guard-manifest 与本 RFC 的三件套通过。开发期的静态自查查出批量补的一处 import 落进了 `rfc310` 用例里
  一段 mock 脚本源码（模板字符串），已移到顶层；按 TypeScript 语法树核对过，改动文件里新补的 import 都不在模板字面量里（经验记入
  `docs/dev-gotchas.md`）。
- **首批**（60 秒；候选 5 个 worker）：463 个文件——改动的用例、全部 142 个 `tests/architecture/`、读被改文件源码的用例与直接导入被改文件
  （生产 7 个、测试助手 12 个）的用例。在 `tests/` 内按 import 求传递闭包会到 1,719 个文件（组合根在 `src/` 里有 25 个调用方），即全量语料，
  交给 CI 的 backend 分片。候选 455 个文件通过，红的 8 个：
  - 本人缺陷两处：① `rfc526-task-execution-required-selections-boundary` 钉着本 RFC 删去的参数与文件（数字员工执行端口的签名、
    `composition/taskCancellation.ts` 里任务取消组合的签名、daemon 的实参），三条红——改钉端口只取数据库、该文件不在、daemon 只交数据库；
    ② `rfc383-daemon-employee-automation-bundles` 的 SQLite 一支「former provider host environment: cancellation stops the same running
    token」：用例把移进测试助手的取消组合用在已装配的 daemon 会话上，助手缺省停的是测试模块的登记表、不是会话自己的，驱动收不到中止——助手
    加一个可选的登记表参数（缺省照旧是测试模块的），该用例交入会话的登记表。修正后这两个文件 14 / 14、24 / 24。
  - 另 6 个与 HEAD 同时 A/B（各 3 个 worker）：`rfc363-workspace-content` 两边都过；其余 5 个两边失败的用例逐条相同（`lifecycle-property`
    3 条撞 15 秒时限、`rfc167-dynamic-workflow-engine` 2 条断言、`rfc311-perf-guards` 2 条断言与 2 条撞 180 秒时限、`rfc359-w6-t26` 撞钩子
    时限、`rfc359-w9` 2 条撞 10 秒时限），属本机负载（1 分钟负载 45～56）。
- **次批**（同样设置）：85 个文件——经 `tests/` 内的 import 传递取到 12 个被改测试助手、而不在首批里的 51 个用例（含组合真实 daemon 的
  `rfc383-daemon-actor`、`rfc384-daemon-intent-bundle` 与 `rfc396` 的三个），与读被改文件源码而不在首批里的 34 个用例（含 `rfc517`）。候选
  78 个文件通过；红的 7 个都是 `scheduler-*` 的 PostgreSQL 一支撞用例自带的时限。与 HEAD 同时 A/B（各 4 个 worker）：两边每个文件失败的条数
  相同、都在 PostgreSQL 一支（有两个文件两边撞时限的具体用例各差一条）；SQLite 一支的 27 条在候选上全过，本 RFC 只改 SQLite 一支的构造。
- **回归用例与收尾**：实现门自审时确认单例有一处可观察的缺陷（见实现门第二条），本 RFC 顺带消除；按“bug 修复先写回归用例”补进 RFC-530 用例：
  关停一个会话只封存它自己的模块，之后的绑定拿到未封存的闸门。另去掉 daemon 集成装配里登记表字段多余的 `NonNullable`；guard-manifest 随两处
  用例的行数改。最终的树上全部 142 个 `tests/architecture/` 与 RFC-530、RFC-526 用例：144 个文件里 143 个通过，红的 `rfc376-report` 一条撞用例自带的 300 秒时限、对照里同一条同样撞时限（RFC-529 时也是两边都撞）。把 RFC-530 用例放进对照（HEAD）的导出仓库
  跑：RFC-530 用例的 ② 两条红（第二次绑定拿到的是同一份，关停之后它已封存），① 红（单例与删去的名字都在），③ 负对照过，即它认得出原缺陷；对照里 `rfc317` 的三个文件随之红，只因拷进去的用例不在对照的 guard-manifest 里。
- **架构报告**（候选与 HEAD 各出一份；候选在最后那处只改类型写法的修改之前生成，那处不涉及导入与符号）：跨上下文导入 7,530 → 7,522，删去的
  8 条都出自本 RFC 删改的文件（数字员工执行端口、任务取消组合、驱动生命周期、组合层取代次、daemon 的数字员工装配），没有新增；生产文件 −1；
  各模块符号属主删 11、加 1（`createProcessTaskExecutionModule`）；写入入口清单里驱动生命周期一行随移走的导出去掉；`source-control` 工作区
  存在性查询的使用方 8 → 7；计数没有变化。
- **收口文档**：plan、design 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例文件，全过（40 / 40）。

## CI（AC-4）

- `2bd4c9959`（实现，父提交是 `c0237b3ce`）：exact SHA 主 CI run 44949576401 的 70 个 job 第 1 次运行 68 个通过；红的是 backend 分片 42/44 的
  `rfc514-task-execution-composition-try-throw-out-boundary` 一条（按名字钉 `cancelAndReadTask` 在生产里只被数字员工执行端口调用一次，本 RFC
  删去那处调用后它在生产里没有调用方）与随之红的 `CI required`。**本人缺陷**：集中验证按带 `.ts` 的路径筛读被改文件源码的用例，漏掉了把文件写成
  不带扩展名的 `rfc514`。同一提交触发的 windows-platform（run 44949576394）通过。未重跑。
- 补正 `998ecb1b3`：任务路由操作的 `cancel` 一直内联着同样的取消、读回与 404，改调 `cancelAndReadTask`（生产里只剩这一份实现，行为不变），
  `rfc514` 的调用方清单改钉任务路由操作；`docs/dev-gotchas.md` 记一条教训（筛读源码的用例按路径主干匹配，删去生产调用时再按被调函数名搜）。
  exact SHA 主 CI run 44956094443 的 70 个 job 第 1 次运行 67 个通过：Markdown 链接检查红在 RFC-371 文档里一个 GitHub 提交链接回
  503（外部服务，本提交未改那份文档）；backend 分片 43/44 红在 `scheduler-wrapper-fanout-e2e` 的「2. every nested wrapper kind fails closed」
  [postgresql] 一条撞 5 秒时限（这条用例不经路由取消；它的 sqlite 变体 190 ms 通过，父提交 `2bd4c9959` 上它通过，本机在补正的树上 12 / 12
  通过），都归为环境；`CI required` 随之红。未重跑。
- 本 RFC 的落档提交 `c0237b3ce`（只改文档；同一提交记下 RFC-529 转 Done）：主 CI run 44940851018 的 70 个 job 第 1 次全部通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **一个会话里的用法不变**：SQLite 的执行绑定此前交出进程级单例（它本来就用 `DAEMON_GENERATION` 构造），现在按 bootstrap 交入的同一个
  `DAEMON_GENERATION` 在绑定时构造一份；任务执行装配每个会话调一次绑定，驱动生命周期、活动、停止、后台、源终止与会话关停照旧经注入取这一份，
  认领、驱动与停止共用同一个闸门与登记表。PostgreSQL 一支不变（本来就每会话一份）。
- **唯一可观察的差别是单例缺陷的消除**：会话关停（`close` → `dispose()`）一次性封存执行模块的闸门；换供应方成功、恢复写入时会关停原会话。此前
  SQLite 的绑定把进程级单例交给每个会话，同一进程里此后由会话工厂新建的 SQLite 会话（迁移把组合换回 SQLite，或重建到另一代次）拿到的是同一份：
  旧会话已关停则它已封存、认领一律被拒，旧会话之后才关停则封存的也是新会话的闸门。现在每个会话一份；RFC-530 用例补了回归用例。只有一个会话的
  进程里没有差别。
- **删去的都没有生产使用方**：被覆盖的 `tasks` 与只为它存在的三个参数（数字员工装配随之只交数据库）、`composeTaskCancellation`、驱动生命周期里读
  单例的 5 个导出、`createTaskExecutionTestModule`（改为生产的构造入口）；源终止参与者此前“没给登记表就用单例”的回落生产从不走（唯一的装配交
  会话的登记表），现在必填。
- **CLI 命令与维护 worker**：此前导入组合层就各造一份不用的模块，现在不造；构造本身此前也不做 IO、不起计时。
- **用例的语义不变**：测试助手持有一份共享的测试模块（按文件照旧重置），直接组合运行期的助手（含 SQLite 的执行绑定）驱动与观察同一份；组合真实
  daemon 的用例改取会话自己的模块（`rfc222`），把测试助手里的取消组合用在已装配会话上的用例显式交入会话的登记表（`rfc383`）；靠源终止回落的
  7 处用例显式给登记表。
- **账本与锁**：`rfc385` 改钉 bootstrap 两支交同一个 `DAEMON_GENERATION`、组合层不在 import 期构造、绑定按交入的代次构造；`rfc388` 改钉两种部署
  每次装配一份；`rfc359-w8` 改钉绑定经自己的模块认领；`rfc526` 的三处随删去的参数与文件改；guard-manifest 登记新用例，改动过的条目行数按各条原有的
  计法随改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-529 转 Done）；实现与验证后再提交
`refactor(backend): RFC-530 任务执行模块不在 import 期构造（RFC-294 S12 第十一步）`。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。
推送后按 exact SHA 跟 CI。
