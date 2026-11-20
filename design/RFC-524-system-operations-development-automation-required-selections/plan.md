# RFC-524 实施计划

依赖：RFC-523。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-524-T1 system-operations**：命令与迁移入口、daemon 的数据库准备、宿主生命周期与运行期查询（design D1、D2）。
- **RFC-524-T2 development-automation**：开发自动化、开发交付、平台工作项与任务输入上传（design D3）；删去没有使用方的旧版流水线证据桥与懒建证
  据库。
- **RFC-524-T3 bootstrap**：daemon 启动、开发重载、会话、应用与 HTTP 装配、两个命令根、`migrate` 与 daemon 的开发自动化装配显式给出（design D1～D3）。
- **RFC-524-T4 用例与测试助手**：两个测试助手；tsc 列出的调用逐处改；钉旧形状的锁随改（design D4、D5）。
- **RFC-524-T5 门与账本**：RFC-521 门删 16 条登记、`SUCCESSORS` 删两个模块；删除的旧版证据桥在两个账本里的条目随删；计数降的收紧到实测；新增
  RFC-524 用例并登记 guard-manifest。
- **RFC-524-T6 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、按被删的名字、选项与路径扫出的用例与全部 `tests/architecture/`，按 CI
  的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-524-T7 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 16 处回落不再存在；RFC-521 门的实测与登记逐条相等，适配器回落 51 条
- [x] AC-2 daemon、CLI 命令与维护入口得到的对象不变；用例给出的选择与此前缺省相同
- [x] AC-3 bootstrap 不深取两个模块的 infrastructure；public surface 不升；计数不升
- [x] AC-4 受影响用例全部通过；exact SHA CI 实现提交 66 / 70 与补正：本人缺陷一格已补正，其余逐格归因为环境（见下文）

## 集中验证

本机全程高负载（10 核；采样到的 1 分钟负载约 28～40，主要是本机其他进程）。验证在候选导出仓库里跑，核对与工作树逐字相同；对照导出仓库与
HEAD（`590435e2f`）的树相同。开发期按 `tsc` 列出的 52 处调用（30 个文件）逐处改为显式给出。集中验证查出本人的三处缺陷，在候选 2、3 修正并复
验：

- **静态**：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 21 个生产文件（另过 promises 配置；另删去 2 个）与 47 个用例和
  测试助手无告警；prettier：改动的 TS、guard-manifest、`counts.json` 与本 RFC 的三件套通过。
- **首批**（候选 1 = `590435e2f` 的树加本 RFC 的 66 个代码路径；按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 3 个
  worker）：227 个文件——`tests/architecture/` 全部 142 个、改动过的用例、按改动的名字与测试助手扫出的用例与 preflight，另从用到改动过的
  HTTP / 契约测试助手的 202 个用例里每 10 个取 1 个（加 `daemon-info-route`）。对照的文件单起初含了对照里不存在的本 RFC 用例，没有起跑，去掉
  后补跑（候选跑到约三分之二时开始）。两边都跑完：候选 2,144 条通过、161 条红，对照 2,144 条通过、149 条红；红的绝大多数是时限（两边的钩子超
  时 90 / 89 条、默认 5 秒 104 / 100 条）。逐文件比失败名，候选多出的红在 10 个文件，其中两个文件是断言：
  - `rfc376-structural-guards` 的计数减速带与不可达生产文件基线：`unreachable-production-files` 15 → 16（打开前恢复的 application 用例只被移
    走的入口调用，成了不可达文件）、`unconsumed-public-symbols-integration` 8 → 9（删除的旧版证据桥是 integration public 里
    `PipelineEvidenceExecution` 唯一的使用方），另有两项计数下降未收紧。本人缺陷：候选 2 把用例一并移进测试助手、删去 integration 那条只有它
    用的类型转出，候选 3 按实测收紧两项上限。
  - `rfc370-evidence-artifact-root-bindings` 按原文钉住开发自动化组合层的回落（`deps.evidenceArtifacts ?? new EvidenceStore(…)`）。本人缺
    陷：只按名字扫描，漏了按原文钉住的锁；随改，再按被删的原文片段全仓扫描，另扫出 `rfc349-development-admission-postgresql-adapter` 同样按
    原文钉住准入查询的回落，随改。
  - 其余 8 个文件是时限；两个 RFC-310 系统 mock E2E 里 `rfc310-digital-employee-system-mock-e2e` 两边都撞自带的 180 秒（同一组失败名），交给
    CI 的 backend 分片。
- **复验**（候选 3 = 候选 1 加上述修正与 `counts.json`；同样跑法、与对照同时）：158 个文件——`tests/architecture/` 全部、首批候选多出红的文
  件、修正触及的用例、读 integration public 的用例与 preflight。两边各 17 条红、全部是时限，没有断言失败；`rfc376-structural-guards`
  221 / 221、RFC-521 门 2 / 2，本 RFC 用例 12 / 12（只在候选一边）。候选多出红的 3 个文件、preflight 与两边都撞默认 5 秒的
  `rfc310-mission-driver`、`rfc317-transition-table-oracle` 放宽到 60 秒（各 2 个 worker）：候选 80 条通过、1 条红，对照 79 条通过、2 条红；
  两边剩下的同一条是 preflight 的“模块能力归属不可伪造”撞它自带的 180 秒（443.7 / 358.6 秒），对照另有 `rfc400` 的一条撞自带的 30 秒。直接取
  用 daemon 运行期查询的 `daemon-info-route` 与 `rfc391-neutral-daemon-graph` 首批两边都撞钩子超时，放宽到 60 秒、单个 worker 后两边
  19 / 19 全过。
- **架构报告**（`scripts/architecture-report.ts`，候选 2 与对照各出一份）：60 项实测里只有 `composition-control-flow-development-automation`
  2 → 1 与 `off-dag-offered-file-context-pairs` 45 → 44（删除的旧版证据桥的 development-automation → integration 一对），都按实测收紧了上
  限；`unreachable-production-files` 15、`unconsumed-public-symbols-integration` 8 不变；生产文件 4,141 → 4,139；public surface 1,195 →
  1,194（integration 删去的那条转出）。
- **旧位置全仓扫描**（工作树；全部包、`e2e`、`scripts`、`architecture/` 与 `docs/`，按词边界，另按被删的原文片段）：清单里删去的名字只在测试
  助手、本 RFC 用例与断言“不存在”的锁里；`daemonInfoPath` 在生产代码里不再出现。
- **收口文档**：plan、design 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例文件，全过（40 / 40）。

## CI（AC-4）

- `fa52dfdfc`（实现，父提交是 `590435e2f`）：exact SHA 主 CI run 44808988322 的 70 个 job 第 1 次运行 66 个通过，未重跑。红的四格：backend
  分片 21/44 是 `rfc370-daemon-runtime-query-bindings` 的 4 条（“query returned before read ACK”）——本人缺陷：测试助手
  `providerHttpApplication` 先展开用例给的选择、再显式写 `daemonRuntime`，盖掉了用例经 `scope.open({ daemonRuntime })` 自选的查询；首批只从
  用到助手的用例里抽样，没照到它。补正提交改为 `selections.daemonRuntime ?? 本机查询`。backend 分片 16/44 是 `rfc311-perf-guards` 的
  AC-11 塌方探测（runner 上 PostgreSQL 的 P95 5.7 秒、是 SQLite 的 79 倍），本 RFC 不碰它测的读路径，属 runner 性能；design/ 链接检查
  是 RFC-371 文档那条既有提交链接的外部 503；`CI required` 随之红。
- `8223581fc`（用例补正，父提交是 `fa52dfdfc`）：exact SHA 主 CI run 44815914976 的 70 个 job 第 1 次全部通过（含 design/ 的链接检查与
  `CI required`），backend 分片 21/44 通过；未重跑。
- 本 RFC 的落档提交 `590435e2f`（只改文档）：主 CI run 44786226871 的 70 个 job 第 1 次运行 67 个通过；红的是 design/ 链接检查的外部
  503（RFC-371 文档的既有提交链接，另有 `design/RFC-378-mindmap-decision-review/research.md` 里一条第三方链接）、backend 分片 1/44（用例步骤
  全部通过，job 在上传计时文件时撞 15 分钟上限被取消）与随之红的 `CI required`，都属环境；未重跑。
- RFC-523 转 Done 的文档提交 `86cba0814`（本 RFC 落档的父提交）：主 CI run 44783387418 的 70 个 job 第 1 次运行 66 个通过；红的除同一条外部
  503 与 `CI required`，还有 backend 分片 41/44 的 `rfc398-start-auto-upgrade-takeover` 一条进程级用例（“barrier/readiness timed
  out”，184.9 秒）与 Windows 前端分片 3/3 的 `rfc371-v2-run-observability` 一条找不到文本——这个提交不改代码，同一份代码在 `20fcbd1dc` 上这两
  格都通过，属环境；未重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **CLI 与迁移入口得到的对象不变**：`backup` / `restore` 命令根读的是同一个本机配置文件（`loadConfig(Paths.config).database` 即本机配置文件
  实现的 `read`），读取在原来回落发生的位置；`restore` 根把解析 provider 用的那次读取一并交入（此前组合层对同一个文件再读一次）。daemon 会话
  与 CLI 的迁移模块、`migrate` 命令的本机选项用的是同一个 `createFileDatabaseConfiguration(Paths.config)`；演示种子的完成标记仍在每次调用时
  取 `Paths.demoSeedMarker`。
- **daemon 得到的对象不变**：数据库准备按部署选择走与此前相同的一支（托管安装走安装准备，单机走本机文件准备，参数不变）；宿主生命周期仍是开
  发叠加层的或同一组参数的本机宿主；运行期查询仍是会话交入的 daemon 宿主（生产路径本来就总给）。
- **开发自动化**：daemon 本来就给了四项选择、平台工作项与任务输入上传的证据库，装配出的对象不变；需求物化器的内容核对与错误原文不变。
- **删去与移走的都没有生产使用方**：组合层的打开前恢复入口及其 application 用例、两个 `select*` 助手、旧版流水线证据桥（连同 integration
  public 里只有它用的类型转出）与懒建证据库；用例要用的原样移进测试助手。
- **用例的选择与此前缺省相同**：两个测试助手只在没给时逐项构造，构造时机（装配时 / 首次使用时）与此前相同；测试 HTTP 装配显式给的运行期查询
  与迁移配置就是此前回落造的对象。
- **账本与锁**：RFC-521 门删去 16 条登记，适配器回落 67 → 51；`counts.json` 两项按实测收紧（开发自动化组合层控制流 2 → 1、off-DAG offered 文
  件对 45 → 44）；删除的旧版证据桥在两个账本里的条目随删；钉旧形状的锁随改（按被删的名字、选项与原文片段全仓扫描，扫出
  `rfc349-development-admission-postgresql-adapter` 与 `rfc370-evidence-artifact-root-bindings` 两处按原文钉住的锁）；guard-manifest 登记新
  用例，改动过的条目行数按实测随改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-524 系统运维与开发自动化的适配器回落改为必填注入（RFC-294 S12 第五步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
