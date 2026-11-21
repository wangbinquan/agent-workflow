# RFC-525 实施计划

依赖：RFC-524。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-525-T1 技能内容**：绑定的两项必填、选择助手只收绑定、技能目录与可用性与版本推进的选项必填（design D1）。
- **RFC-525-T2 资源包**：包 provider、工件属主与维护场景的选项必填；本机实现经组合层交出（design D2）。
- **RFC-525-T3 插件与 MCP 探测**：安装器与探测执行器必填；进程内执行器（design D3）。
- **RFC-525-T4 bootstrap**：资源包命令、维护 worker、单机 MCP 诊断与 daemon 资源目录装配显式给出（design D2、D3）。
- **RFC-525-T5 用例与测试助手**：测试助手；tsc 列出的调用逐处改；钉旧形状与回落原文的锁随改（design D4）。
- **RFC-525-T6 门与账本**：RFC-521 门删 16 条登记、`SUCCESSORS` 删 resource-catalog；计数降的收紧到实测；新增 RFC-525 用例并登记 guard-manifest。
- **RFC-525-T7 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、按被删的名字、选项与回落原文扫出的用例、经改动的测试助手传入被改项的用例
  与全部 `tests/architecture/`，按 CI 的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-525-T8 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 16 处回落不再存在；RFC-521 门的实测与登记逐条相等，适配器回落 35 条
- [x] AC-2 daemon、资源包命令、维护 worker 与 MCP 探测得到的对象不变；用例给出的选择与此前缺省相同
- [x] AC-3 bootstrap 不深取 resource-catalog 的 infrastructure；public surface 不升；计数不升
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；采样到的 1 分钟负载约 33～44，主要是本机其他进程）。验证在候选导出仓库里跑，核对与工作树逐字相同；对照导出仓库与
HEAD（`0d7412d52`）的树相同。开发期按 `tsc` 列出的调用逐处改为显式给出（28 个用例文件用 AST 脚本改，其余手改）。集中验证查出本人两处缺陷（两
条不写回落原文的锁），在候选 2 修正并复验：

- **静态**：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 17 个生产文件（另过 promises 配置）与 46 个用例和测试助手无告
  警，候选 2 改的两个用例另过一次；prettier：改动的 TS、guard-manifest、`counts.json` 与本 RFC 的三件套通过。
- **首批**（候选 1 = `0d7412d52` 的树加本 RFC 的 65 个代码路径；按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 3 个
  worker）：242 个文件——`tests/architecture/` 全部 142 个、改动过的用例、经改动的测试助手传入被改项的全部 65 个用例、按改动的名字扫出的用例与
  preflight。候选 2,680 条通过、59 条红，对照 2,670 条通过、58 条红（对照没有本 RFC 用例的 11 条）；红的除 3 条外都是时限。
  `rfc376-structural-guards` 两边 221 / 221、RFC-521 门 2 / 2，本 RFC 用例 11 / 11（只在候选一边）。逐文件比失败名，候选多出的断言失败在两个
  文件：
  - `rfc370-plugin-installer-roots` 按 AST 数插件目录组合层里 `createLocalPluginInstaller` 的调用（要求恰 1 次、父节点是 `??`、左侧是
    `input.installer`）；
  - `rfc349-postgresql-resource-package-bootstrap`（两种 provider 各 1 条）把两个本机工件属主列进 PostgreSQL 资源包组合层“源码必须含
    `X(`”的清单。

  本人缺陷：按名字与回落原文片段扫描都扫不到这类不写原文的锁。候选 2 随改：插件目录组合层不调用本机安装器、把调用方的 `input.installer` 原样交
  给应用；PostgreSQL 资源包组合层只转出两个本机属主、不调用，资源包命令的源码含三项本机实现的调用。候选多出的其余红都是默认 5 秒的时限，在 6
  个文件（`rfc317-transition-table-oracle`、`rfc425-execution-authority-deployment` 的负对照、`rfc370-v20-skill-tree-versions`、
  `rfc385-daemon-execution-generation`、`rfc386-task-drive-coordinator-factory` 与 `rfc387-continuation-semantics`）；对照一边也有 7 个文件多出
  时限红。

- **复验**（候选 2 = 候选 1 加上述两处修正；放宽到 60 秒、各 3 个 worker，与对照同时）：158 个文件——再按被改的 18 个文件的路径（与
  `readDaemonGraphSource`）筛出、首批没跑的 132 个读其源码或导入它的用例，加首批任一边红过的 26 个文件。候选 1,823 条通过、11 条红，对照
  1,813 条通过、13 条红（对照 `skill-identity-migration` 的钩子超时连带少跑 9 条）；没有候选独有的红——候选红的 8 个文件在对照一边是同一组失败名，对照另多 2 条（`rfc370-mcp-diagnostics-family` 一条、`skill-identity-migration`
  的钩子超时）。两边相同的红都是环境：用例自带的时限（`rfc376-report` 的 300 秒、preflight 的 180 秒与 60 秒各一条、
  `rfc370-committed-architecture-source` 的 150 秒、`rfc370-plugin-installer-roots` 两条 PostgreSQL 应用生命周期用例的 20 秒、`rfc384` 的
  15 秒），与本机环境（`rfc370-mcp-diagnostics-family` 两条“MCP selected family did not settle”、`rfc167-dynamic-workflow-engine` 一条、
  `rfc321-repository-publication-ratchet` 要可达的 git 历史，导出仓库没有）；这些用例在 HEAD 的 CI 上都通过。首批修正的两个文件在候选一边通
  过（`rfc349-postgresql-resource-package-bootstrap` 10 / 10，`rfc370-plugin-installer-roots` 的 AST 锁通过；它的两条应用生命周期用例在首批
  的候选一边通过）。首批两边撞默认 5 秒的文件放宽到 60 秒后全部通过（daemon 模块装配一族 `rfc380`～`rfc391` 与 `rfc385`～`rfc387`、`rfc425`、
  `rfc370-v20-skill-tree-versions`、`rfc101`、`rfc104`、`rfc271` 等，两边逐条相同）。两边都红的四个环境类文件再以单个 worker（两边同时）各跑一次：`rfc370-mcp-diagnostics-family` 候选 18 / 18（对照 17 / 18，
  剩下一条同一报错）、`rfc370-plugin-installer-roots` 两边 5 / 5；`rfc384-daemon-intent-bundle` 两边仍是同一条撞自带的 15 秒、
  `rfc167-dynamic-workflow-engine` 两边仍是同一条本机环境的断言。
- **架构报告**（`scripts/architecture-report.ts`，候选 1 与对照各出一份；候选 2 只改两个用例）：60 项实测里只有
  `composition-control-flow-resource-catalog` 3 → 1（`skillContentBinding.ts` 与 `skillVersionCommit.ts` 两处“没给就造”的分支），已按实测收紧
  上限；不可达生产文件与各模块的未消费符号不变，生产文件数与 public surface 不变；跨上下文导入只多了 bootstrap 取 resource-catalog 组合层的 6 条
  （资源包命令的三项本机实现与维护 worker 的三个名字）。
- **旧位置全仓扫描**（工作树；全部包、`e2e`、`scripts`、`architecture/` 与 `docs/`，按词边界）：`skillContentRoot` 不再出现；
  `recoveryEffectsFactory` 只在维护 worker 的选择处、application 层的冲突检查本身与新增的本机工件恢复里；两个资源包 provider 文件不再有
  `pluginInstaller` / `pluginsDir`；backend 以外的包与脚本不调用本 RFC 改动的入口。
- **收口文档**：plan、design 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例文件，全过（40 / 40）。

## CI（AC-4）

- 【待补：实现提交】
- 本 RFC 的落档提交 `0d7412d52`（只改文档；同一提交记下 RFC-524 转 Done）：主 CI run 44821010955 的 70 个 job 第 1 次全部通过（含 design/ 的链接
  检查与 `CI required`）；未重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **资源包命令得到的对象不变**：此前 PostgreSQL 资源包 provider 的回落用命令交入的 `appHome`（`Paths.root`）与数据库（`provider.db`）造技能工
  件属主与包内容读取（单参数），插件属主的目录是 `<appHome>/plugins`、安装器是命令交入的 `createResourcePackagePluginInstaller()`；现在命令在
  同一处用同一组参数显式构造这三项。三个构造函数在构造时不做 IO，构造次序的前后不影响行为。
- **维护 worker 得到的对象不变**：托管部署给的工件恢复原样交入；单机（`null`）走与此前回落相同的本机版本化恢复，选定的恢复内容效果照旧经
  `selectedResourcePackageRecoveryEffects` 取，`null` 与 `undefined` 一样视为没给；两项都给仍报同一个冲突错误。第二处调用的日志器与此前一样由恢
  复与维护场景共用；第一处此前没给日志器，现在两边各自造同名的日志器，输出不变。
- **单机 MCP 诊断不变**：进程内执行器每次探测时读测试接缝再调 `probeMcp`，与此前“没给执行器”一支相同；托管部署照旧交托管探测。
- **daemon 不变**：资源目录、版本推进与内容可用性此前就取部署选择的内容绑定（`DeploymentSelections.skillContent` 必填），删去的
  `skillContentRoot` 在给了绑定时本来不用；插件安装器与 HTTP 装配的包内容读取此前就总是给出。
- **用例的选择与此前缺省相同**：测试助手只在用例没给时逐项构造，工厂与参数与此前回落相同（技能目录的六项是单参数的本机存储）；四处 daemon 模块
  装配的用例改给单机部署的生产绑定（design D4 的取舍）。
- **账本与锁**：RFC-521 门删去 16 条登记，适配器回落 51 → 35，`SUCCESSORS` 删去 resource-catalog，中立登记随实测改（PostgreSQL 资源包
  provider 的 `join` 删去、维护场景多一条日志器）；`counts.json` 一项按实测收紧（resource-catalog 组合层控制流 3 → 1）；钉旧形状的锁随改（按被删
  的名字、选项与回落原文片段扫描，再按被改文件的路径筛出读取其源码的用例）；guard-manifest 登记新用例，改动过的条目行数按实测随改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-524 转 Done）；实现与验证后再提交
`refactor(backend): RFC-525 资源目录的适配器回落改为必填注入（RFC-294 S12 第六步）`。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。
推送后按 exact SHA 跟 CI。
