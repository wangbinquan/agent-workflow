# RFC-522 实施计划

依赖：RFC-521。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-522-T1 数字员工**：三项选项必填，删去回落与 `writerInstallation` 选项（design D1）。
- **RFC-522-T2 事件中心**：两项选项必填，删去 `selectLocalCustomObserverProgramFactory`，兼容入口改调 application（design D2）。
- **RFC-522-T3 用例**：两个测试助手与全部受影响的用例调用（design D3）。
- **RFC-522-T4 门与锁**：RFC-521 门的登记、总数与后继标签（design D4）；新增 RFC-522 用例并登记 guard-manifest（design §4）。
- **RFC-522-T5 集中验证**：backend `tsc`、eslint、prettier；直接取改动文件的用例、按名字与原文扫出的用例与全部 `tests/architecture/`，按 CI
  的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-522-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 5 处回落不再存在，选项必填，门的实测与登记相等、适配器回落 78 条
- [x] AC-2 daemon 得到的对象不变，用例显式给出的选择与此前缺省相同
- [x] AC-3 event-center 的 infrastructure 不取组合层的值；public surface 与计数不升
- [x] AC-4 受影响用例全部通过；exact SHA CI 67 / 70 与补正 68 / 70：本人缺陷一格已补正，其余逐格归因为环境（见下文）

## 集中验证

本机全程高负载（10 核；1 分钟负载大多在 30～40，主要是本机其他进程）。验证在候选导出仓库里跑，核对与工作树逐字相同；对照导出仓库与
HEAD（`568fda4f6`）的树相同。集中验证查出本 RFC 的缺陷都已修正并复验：

- **查出的缺陷**：架构报告与 `rfc376-structural-guards` 查出 `event-center/application/unavailableObserverProgram.ts` 成了不可达的生产文件
  （`unreachable-production-files` 15 → 16，`counts.json` 不许增长）——回落删除后，缺省观察者的空实现只剩用例在用。改为原样移进
  `tests/helpers/eventCenter.ts`、删去生产文件；RFC-516 用例里锁它的位置、调用、依赖与行为的几处随之删去（行为的两种情形挪进 RFC-522 用
  例）；design D2、§3 与 §4 补记。
- **静态**：backend `tsc` 退出码 0、无输出（修正前后各跑一次）；eslint `--max-warnings 0`：4 个改动的生产文件、27 个改动的用例与测试助手无告
  警；prettier：改动的 TS、guard-manifest 与本 RFC 的三件套通过。开发期由 `tsc` 列出全部 56 处选项缺失的调用（22 个文件），逐处补上测试助
  手。
- **首批**（候选 1 = `568fda4f6` 的树加本 RFC 的 32 个代码路径；按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 3 个
  worker；与对照同时、同样跑法）：223 个文件——`tests/architecture/` 全部 142 个（含 RFC-521 门）、按改动的名字、文件与测试助手扫出的用例（含
  两个改动过的 RFC-310 系统 mock e2e）与 preflight。
  - 两边都跑完：候选 2,266 条通过、75 条红，对照 2,264 条通过、71 条红。候选多出的断言红只有 `rfc376-structural-guards` 的两条（即上面的缺
    陷），其余候选多出的红都是时限（默认 5 秒与自带的 20 秒）；两边都红的是时限与 PostgreSQL 钩子。
- **复验**（候选 2 = 修正后的 33 个代码路径；默认时限放宽到 60 秒、与对照同时，各 3 个 worker）：178 个文件——`tests/architecture/` 全部
  142 个、取用事件中心测试助手的用例、RFC-516 / RFC-522 用例、preflight 与首批里任一边有红的文件。候选 1,901 条通过、9 条红，对照 1,895 条通
  过、10 条红；本 RFC 用例 6 / 6，RFC-516 用例 10 / 10，RFC-521 门 2 / 2，`rfc376-structural-guards` 221 / 221。逐文件比失败名，候选的红两边
  都有（`rfc376-report` 自带的 300 秒、preflight 自带 60 秒与 180 秒的两条、`rfc400` 自带的 30 秒、两个 RFC-310 用例与
  `rfc370-employee-program-root-bindings` 自带的时限、`rfc395-retired-runtime-shapes` PostgreSQL 一半的 90 秒钩子）；对照另红
  `rfc257-webhook-ingress` 的一条。
- **架构报告**（`scripts/architecture-report.ts`，候选 1、候选 2 各与对照比）：候选 1 的 `unreachable-production-files` 15 → 16（即上面的缺
  陷）；候选 2 的 60 项实测与对照逐项相同（status 只差来源与时间）。其余差别都来自删除：生产文件 4,143 → 4,142，模块符号归属少 3 个（空观察
  者与 `select` 助手），mutation 入口少 1 个（空观察者的 `run`），import 边少 1 条（兼容入口不再以类型取 required-ports），两个 required
  port 各少一个取用方；public surface 不变。
- **旧位置全仓扫描**（工作树；全部包、`e2e`、`scripts`、`architecture/` 与 `docs/`，按词边界）：`selectLocalCustomObserverProgramFactory` 只
  剩 RFC-522 用例里的“不存在”断言；`createUnavailableEventObserverProgram` 只在测试助手与 RFC-522 用例里；`writerInstallation` 只剩
  bootstrap 自己的 daemon 输入与用例的安装端口模型，与组合函数的选项无关。
- **收口文档**：plan、design 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例，全过（33 / 33）。

## CI（AC-4）

- `83edbd8bf`（实现，父提交是 `5c55576aa`）：exact SHA 主 CI run 44741246089 的 70 个 job 第 1 次运行 67 个通过，未重跑。红的三格：backend
  分片 42/44 是本 RFC 用例的语料扫描一条撞默认 5 秒（6.3 秒）——本人缺陷：逐个解析全部生产文件，没先按名字文本筛、也没给语料用例时限
  （`docs/dev-gotchas.md` 早有这条），补正提交里补上文本预筛、读盘缓存与 30 秒时限，本机负载 64 下 1.3 秒；Windows 的 Playwright 分片 3/4 是
  `spawnSync git ETIMEDOUT` 起头的一串超时与连带（同一份 daemon 装配在其余 Windows 分片与 Linux / macOS 的 e2e 上通过），属 runner 环
  境；`CI required` 随之红。
- `fc2ca2ab2`（用例补正，父提交是 `83edbd8bf`）：主 CI run 44748298284 的 70 个 job 第 1 次运行 68 个通过，本 RFC 用例所在的 backend 分片
  42/44 通过；红的 backend 分片 16/44 是 `rfc311-perf-guards` 的 AC-11 塌方探测——runner 上 PostgreSQL 的 P95 5.8 秒、是 SQLite 的 125 倍；补
  正不改生产代码，同一份生产代码在 `83edbd8bf` 上这一分片通过，属 runner 性能；`CI required` 只因它红；未重跑。
- 本 RFC 的落档提交 `568fda4f6`（只改文档）：主 CI run 44725156096 的 70 个 job 第 1 次运行 68 个通过；红的是 design/ 链接检查对 RFC-371 文
  档（`design/RFC-371-run-observability/native-real-validation-20261007.md`）里一条既有提交链接的外部 503，`CI required` 只因它红；未重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **daemon 不变**：`bootstrap/daemonModules/digitalEmployee.ts` 与 `bootstrap/daemonModules/integration.ts` 照旧传入部署选择已给的输入工件
  库、程序工件库、写入切换、观察者与自定义观察者程序工厂；组合函数直接用这些对象，此前的回落在 daemon 侧本来就走不到。
- **用例的选择与此前缺省相同**：两个测试助手用此前回落里的同一组工厂与实参（RFC-522 用例按语法树钉住）；空观察者原样移进测试助手，错误文案不
  变（带与不带观察者程序引用两种情形）。一次装配里构造几次也与此前一致：`rfc359-w4-d6c` 的两个“独立会话”各自构造自己的选择。
- **兼容入口**：`createCustomEventObserverProgram`（infrastructure）改调 application 的同名函数，传入的 store getter、时钟与程序工厂与此前经
  组合层转调时相同；`programs` 必填后，唯一的调用方（契约用例）本来就传了它。
- **文档改准**：design 原先写“event-center 的 infrastructure 不取本模块的组合文件”，但另一个 infrastructure 文件本来就以类型取
  `composition/required-ports`；改为“不取组合层的值”，RFC-522 用例按这个判据锁。
- **账本与锁**：RFC-521 门删去 5 条登记，适配器回落 83 → 78，后继标签按 design D4 重排；RFC-516 用例的调用与位置表随改；guard-manifest 登记
  新用例、改动过的条目行数按实测随改；`counts.json` 不变（`unreachable-production-files` 仍是 15）。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-522 数字员工与事件中心的适配器回落改为必填注入（RFC-294 S12 第三步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
