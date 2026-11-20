# RFC-519 实施计划

依赖：RFC-518。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-519-T1 托管实现归 infrastructure**：五个新文件（design D1），由脚本按 HEAD 原文生成。
- **RFC-519-T2 组合层只装配**：4 个组合文件只留装配函数、照旧转出迁走的名字（design D2）。
- **RFC-519-T3 锁与计数**：RFC-515 门的例外清单清空、负对照改用伪造清单；RFC-518 用例的清单断言随改；跨 context 文件对账本两处改名；读原文的
  锁按实测核对；`counts.json` 收紧；guard-manifest 登记新用例（design D3）。
- **RFC-519-T4 用例**：新增 RFC-519 用例（design §4）。
- **RFC-519-T5 集中验证**：backend `tsc`、eslint、prettier；直接取改动文件的用例、按名字与原文扫出的用例、记组合文件消费方的用例与全部
  `tests/architecture/`，按 CI 的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-519-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在新位置声明；4 个组合文件不再有循环、`try` 与 `throw`；门的例外清单为空且仍绿
- [x] AC-2 迁移的代码逐字不变，组合文件导出的名字与 HEAD 相同、转出的是同一对象
- [x] AC-3 新位置不取组合层；账本只改名不增；计数收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；1 分钟负载大多在 20 以上，主要是本机其他进程）。验证在候选导出仓库里跑，核对与工作树逐字相同；对照导出仓库与
HEAD（`bfb7a4a10`）的树相同。集中验证查出本 RFC 的缺陷都已修正并复验：

- **查出的缺陷**：第一次 backend `tsc` 报 RFC-518 用例里 3 处 TS2304——改写那条用例的例外清单断言时，删掉了 `for` 循环头、留下了它单行的循环
  体；删掉后 `tsc` 退出码 0、无输出。另把 design §4 ④ 里“迁移安装在种子失败时关闭运行时并重抛”由新用例覆盖的说法改准：迁移安装的准备体逐字迁
  移，由既有的托管 PostgreSQL 集成用例覆盖。
- **静态**：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：9 个生产文件与 5 个改动的用例无告警（两处只作类型用的 import 用
  eslint 的修正改成类型 import）；prettier：改动的 TS、`counts.json`、guard-manifest 与本 RFC 的三件套通过。
- **首批**（候选 = `bfb7a4a10` 的树加本 RFC 的代码路径；按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 3 个 worker；与对照
  同时、同样跑法）：173 个文件。其中 `tests/architecture/` 全部 141 个，另 32 个：按 4 个组合文件、迁走的名字与错误串扫出的用
  例，`rfc310-architecture-lock`、`rfc487` 与 `rfc294-architecture-preflight`，RFC-518 与本 RFC 用例。
  - 两边都跑完：候选 1,678 条通过、19 条红，对照 1,674 条通过、14 条红；本 RFC 用例 9 / 9（只在候选一边），RFC-518 用例 6 / 6。候选多出的
    红：`rfc317-transition-table-oracle`、`rfc371-v2-observation-boundaries`、`runtime-session-lease` 与 preflight 的跨 context 一条撞
    5 秒；`rfc370-v3-hosted-write-window.integration` 的并发写入一条在 31 秒里没等到完成；`rfc238-mcp-runtime-test-service` 与
    `rfc370-mcp-diagnostics-family` 的 PostgreSQL 一半两边各红不同的子集。
- **复验**（默认时限放宽到 60 秒、与对照同时，各 2 个 worker）：12 个文件——首批里候选多出红的文件、两个 MCP 用例、RFC-518 与本 RFC 用例和
  3 个守卫普查。候选 201 条通过、6 条红，对照 194 条通过、4 条红（对照没有本 RFC 用例）。写入窗口、时限类与守卫普查两边全过，preflight 的跨
  context 一条在候选上通过；两边都红的是 preflight 自带 60 秒与 180 秒时限的两条（本机两边都跑不进，交给 CI）与
  `rfc238-mcp-runtime-test-service` 的 PostgreSQL 一半（两边各红不同的子集）；候选上 `rfc370-mcp-diagnostics-family` 红的那一条，首批时恰在
  对照上红过，属两边都会出现的不稳定。
- **架构报告**（`scripts/architecture-report.ts`，候选与对照各出一份）：60 项实测里只有本 RFC 收紧的 4 项变化，数值与 `counts.json` 写入的新
  上限逐项相等（intent 3 → 0、resource-catalog 28 → 3、runtime-management 11 → 0、system-operations 14 → 2）；生产文件 4,137 → 4,142（5 个新
  文件）；跨 context import 7,512 → 7,517：新增的 1 条是 intent 新文件对 resource-catalog public 的类型 import（offered-consumption，组合文
  件仍各自取），4 条是 system-operations 拆开后两个新文件各自取的 platform / util（legacy-outbound），其余随路径改名；public surface
  1,195、required ports 66、facade 6 个不变；mutation 入口 2,386 → 2,388（新导出的函数被计入）；门的结果只在上述
  4 项、`direct-setinterval-sites` 与 `off-dag-offered-file-context-pairs` 的改名上不同。
- **旧位置全仓扫描**：本 RFC 用例的 ① 在全部生产文件、用例与 e2e 里按语法树找同名声明，迁走的名字只在新位置；按原文全仓搜过的锁
  （`rfc370-hosted-mcp-probe`、`rfc489`）读的是留下的装配，原样通过。
- **收口文档**：plan、design 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例，全过（33 / 33）。

## CI（AC-4）

- 【待补：实现提交】
- 本 RFC 的落档提交 `bfb7a4a10`（只改文档）：主 CI run 44684504417 的 70 个 job 第 1 次全部通过（含 design/ 的链接检查与 `CI required`），未
  重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **逐字迁移**：由脚本按 HEAD 原行切片生成，再用脚本按词法单元比对（注释也比，只忽略换行与缩进）：20 段都在新位置或留下的组合文件里连续出
  现、逐个相同；只有列明的替换——resource-catalog 的输入类型名换成同形的交集，备用实例收敛与写入围栏两处闭包变量（`input.fence` / `runtime`、
  外层的 `contract` / `environment` / `env` / `normalization`）改为参数。
- **时机与次序**：技能工件的引用校验仍在每次发布 / 丢弃时做；备用实例仍先看围栏、不在手就跳过；迁移安装仍先恢复、再准备、再写种子，种子失败
  时关闭运行时并重抛；写入围栏仍在每次取用时看执行权，失效时抛原错误；托管运行时管理与 MCP 诊断的 effect 工厂逐字未动。错误类型、错误串与次
  序不变。
- **入口与交出的对象**：4 个组合文件导出的名字与 HEAD 逐个相同，转出的就是新位置的同一个对象（本 RFC 用例逐名比对）；bootstrap 与用例的
  import 不改。
- **账本与锁**：RFC-515 门的例外清单清空、`gate` 可传入伪造清单做负对照；RFC-518 用例的清单断言改为“不含 23 个已迁走的文
  件”；`rfc376-structural-guards` 与 `rfc294-review-offered-edge-dag` 随路径改名；`counts.json` 4 项收紧到实测；guard-manifest 登记新用例、
  改动过的条目行数按实测随改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-519 托管实现迁出组合层（二）（RFC-294 S10 第二十六步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
