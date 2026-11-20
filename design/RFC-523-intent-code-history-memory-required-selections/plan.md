# RFC-523 实施计划

依赖：RFC-522。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-523-T1 intent apply**：依赖收窄、工件生命周期的两项必填、单机工件内容选择，`applyIntentChangeset` 移到测试助手（design D1）。
- **RFC-523-T2 daemon 与维护 worker**：daemon 显式构造资源会话绑定与工件生命周期；恢复场景与维护命令的选项必填、单机草稿区选择，worker 显式
  给出（design D2、D3）。
- **RFC-523-T3 code-capability 与 memory**：两项必填（design D4）。
- **RFC-523-T4 用例**：测试助手与全部受影响的用例调用（tsc 列出）。
- **RFC-523-T5 门与锁**：RFC-521 门的登记、总数与后继；钉旧形状的锁；新增 RFC-523 用例并登记 guard-manifest（design D5、§4）。
- **RFC-523-T6 集中验证**：backend `tsc`、eslint、prettier；直接取改动文件的用例、按名字与原文扫出的用例与全部 `tests/architecture/`，按 CI
  的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照（含不可达文件）。全量语料交给 CI 的 backend 分片。
- **RFC-523-T7 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 11 处回落不再存在，选项必填、只为回落存在的选项删去，门的实测与登记相等、适配器回落 67 条
- [x] AC-2 daemon 与维护 worker 得到的对象不变，用例显式给出的选择与此前缺省相同
- [x] AC-3 bootstrap 不深取模块的 infrastructure；public surface 与计数不升
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；1 分钟负载大多在 30～60，主要是本机其他进程）。验证在候选导出仓库里跑，核对与工作树逐字相同；对照导出仓库与
HEAD（`fe2628450`）的树相同。集中验证没有查出本 RFC 的缺陷；开发期按 `tsc` 列出全部 83 处选项缺失或删去选项的调用（32 个用例文件），逐处改为
显式给出：

- **静态**：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 7 个生产文件（另过 promises 配置；另删去 1 个）与 39 个用例和
  测试助手无告警；prettier：改动的 TS、guard-manifest、`counts.json` 与本 RFC 的三件套通过。
- **首批**（候选 1 = `fe2628450` 的树加本 RFC 的 48 个代码路径；按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 3 个
  worker；与对照同时、同样跑法）：253 个文件——`tests/architecture/` 全部 142 个、按改动的名字、文件与测试助手扫出的用例（含 35 个改动过的用
  例）与 preflight。两边都跑完：候选 2,908 条通过、48 条红，对照 2,891 条通过、58 条红；候选的红全部是时限（默认 5 秒 48 条，其余撞各自的
  15～300 秒），没有断言失败。
- **复验**（默认时限放宽到 60 秒、与对照同时，各 3 个 worker）：首批里候选多出红的 13 个文件。候选 189 条全过；对照 188 条通过、1 条红
  （`runtime-claude-e2e` 的一条，只在对照一边）。
- **上限收紧后的复验**（候选 2 = 候选 1 加 `counts.json`）：`rfc376-structural-guards` 221 / 221（减速带按新上限 18 判过），本 RFC 用例
  7 / 7，RFC-521 门 2 / 2，RFC-513 用例 9 / 9，读 guard-manifest 的 3 个账本用例全过。
- **架构报告**（`scripts/architecture-report.ts`，候选与对照各出一份）：60 项实测里只有 `cross-context-internal-file-pairs` 21 → 18（intent
  组合层不再取 resource-catalog 的两个 infrastructure 文件与一个端口类型），与新上限相等；`unreachable-production-files` 不变（未绑定读取器
  连同它的文件移进测试助手）；生产文件 4,142 → 4,141；public surface 不变。
- **旧位置全仓扫描**（工作树；全部包、`e2e`、`scripts`、`architecture/` 与 `docs/`，按词边界）：`applyIntentChangeset`、`ApplyIntentDeps` 与
  `createUnboundCodeHistoryReader` 只在测试助手与用例里；`composeIntentMaintenanceCommandsForAppHome` 与 `scratchDirectoryName` 选项在生产代
  码里不再出现。
- **收口文档**：plan、design 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例文件，全过（40 / 40）。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **daemon 得到的对象不变**：`bootstrap/daemonModules/intent.ts` 显式构造的工件生命周期（工件内容取部署选择，旧版兼容绑定取
  `composeLegacyIntentSkillArtifactCompat()`）与资源会话绑定（两个工件属主取部署选择、ACL 归属读面取 resource-catalog 的持久化、MCP 事务生命
  周期在这份装配里新建一个），与此前回落造的对象逐项相同；`composeIntentApplyOperations` 交出的引擎不变。
- **维护 worker 得到的对象不变**：托管效果在时取托管的；单机时草稿区取 `composeLocalIntentScratch({ appHome })`（同一工厂、目录名仍是
  `INTENT_SCRATCH_DIRNAME`），工件内容取 `composeLocalIntentArtifactContent`（同一工厂、同一组参数），工件生命周期带同一个旧版兼容绑定。
- **用例的选择与此前缺省相同**：`composeStandaloneIntentApply` 只在用例没给时逐项构造单机实现（与此前逐项回落一致，托管工件属主照旧不触本机
  目录）；`applyIntentChangeset` 原样移进测试助手；未绑定的代码历史读取器原样移进测试助手，错误文案不变；记忆的注入查询用同一个
  `taskNodeRuns` 构造。
- **账本与锁**：RFC-521 门删去 11 条登记，适配器回落 78 → 67；preflight 与 `rfc376-structural-guards` 的跨 context 内部文件对各删
  3 条，`counts.json` 的 `cross-context-internal-file-pairs` 上限按实测 21 → 18；RFC-513 用例里锁未绑定读取器位置、调用与依赖的几处删去（行
  为经测试助手照旧）；guard-manifest 登记新用例、改动过的条目行数按实测随改（preflight 一条原本就与文件差 17 行，按实测改准）。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-523 意图、代码历史与记忆的适配器回落改为必填注入（RFC-294 S12 第四步）`。走私有 index、按路径清单提交，在共享发布锁
下 fetch / ff / push。推送后按 exact SHA 跟 CI。
