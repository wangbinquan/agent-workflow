# RFC-521 实施计划

依赖：RFC-520。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-521-T1 门**：新增 `tests/architecture/rfc521-composition-adapter-fallbacks.test.ts`（design D1、D2 与 §3 的登记表，§4 的用例）。
- **RFC-521-T2 账本**：guard-manifest 登记新用例（design D4）。
- **RFC-521-T3 集中验证**：backend `tsc`、eslint、prettier；新用例与全部 `tests/architecture/`，按 CI 的跑法；红的按时限放宽复核。不改生产代
  码，架构报告只核对没有变化。全量语料交给 CI 的 backend 分片。
- **RFC-521-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 门覆盖全部模块的组合层，实测与登记表逐条相等，适配器回落 83 条、各模块指定后继
- [x] AC-2 每种回落写法都有会红的负对照，不构造的回落与组合层以外的文件不判
- [x] AC-3 生产代码不变；public surface 与计数不升
- [x] AC-4 受影响用例全部通过；exact SHA CI 各 68 / 70，红格逐格归因为环境（见下文）

## 集中验证

本机全程高负载（10 核；1 分钟负载大多在 35～42，主要是本机其他进程）。验证在候选导出仓库里跑，核对与工作树逐字相同；对照导出仓库与
HEAD（`e095916d2`）的树相同。集中验证没有查出本 RFC 的缺陷；实现门自审查出一处（见下文）：

- **静态**：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：新用例无告警；prettier：新用例、guard-manifest 与本 RFC 的三件套通
  过。
- **清单的一致性**：登记表由与门相同的检测核心生成后逐条归类；用脚本把门里的登记表、design §3 的表与生成结果三方逐条比对，59 个文件全部相同
  （补正后重比）。
- **首批**（候选 = `e095916d2` 的树加本 RFC 的 2 个路径；按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 3 个 worker；与对
  照同时、同样跑法）：160 个文件——`tests/architecture/` 全部 142 个（含本 RFC 用例）、读 guard-manifest 的 17 个用例与
  `rfc294-architecture-preflight`。
  - 两边都跑完：候选 1,514 条通过、10 条红，对照 1,512 条通过、10 条红；本 RFC 用例 2 / 2（只在候选一边），`rfc317-guard-negative-fixture`
    17 / 17、`rfc317-architecture-ledgers` 15 / 15、`rfc317-guard-corpus-floor` 24 / 24。两边的红都是时限（默认 5 秒、`rfc376-report` 自带的
    300 秒、preflight 自带 60 秒与 180 秒的两条）；候选另红 `rfc400-collaboration-task-participants` 自带 30 秒的一条（33.1 秒），对照另红
    preflight 默认 5 秒的一条。
- **复验**：`rfc400-collaboration-task-participants` 单独再跑一次，候选 6 / 6 通过（那一条 27.2 秒），对照这次红了同文件另一条默认 5 秒
  的——两边都会出现的时限。
- **架构报告**（`scripts/architecture-report.ts`，候选与对照各出一份）：除来源与时间外逐项相同——本 RFC 不改生产代码。
- **实现门查出的缺陷**：design §4 写了“真值条件不判”，负对照里没有这一条；补上 `x ? x : create…()` 一条（候选 2，只改这一处字符串与
  guard-manifest 的行数），在候选 2 上重跑本 RFC 用例与读 guard-manifest 的 3 个账本用例
  （`rfc317-guard-negative-fixture`、`rfc317-architecture-ledgers`、`rfc317-guard-corpus-floor`），全过
  （2 / 2、17 / 17、15 / 15、24 / 24）。
- **门的补正（实现提交 `bf0eb6971` 之后）**：起草 S12 第 1 项第二步时，在 source-control `repositoryCandidate.ts` 读到
  `selectFactory`：`if (selected !== undefined) return selected` 之后才造本机文件实现——第一版的 D1 不认这种守卫返回。据此复核全部写法，补进
  守卫返回、条件回落（`x ?? (p === undefined ? undefined : createFile…(p))`）与多语句的缺失块，按正则另扫真值条件、`typeof` 与展开覆盖的默认
  值（没有回落构造）。实测 99 → 114 处、51 → 59 个文件：新增 11 处适配器回落（source-control 5、resource-catalog 2、system-operations
  2、task-execution 2）与 4 处中性默认（惰性构造 2、注入形态 1、开关选路径 1），适配器回落 72 → 83；“开关选路径”一类的定义随之写准。design
  §1 原先手写的按写法分项（54 / 41 / 1）没有实测依据、也加不到总数，换成脚本实测的分项。补正后 backend `tsc` 退出码 0、无输出，在候选上重跑
  本 RFC 用例与读 guard-manifest 的 3 个账本用例全过（2 / 2、17 / 17、15 / 15、24 / 24），三方清单比对 59 个文件全部相同。
- **收口文档**：plan、design 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例，全过（33 / 33）。

## CI（AC-4）

- `bf0eb6971`（实现，父提交是 `e095916d2`）：exact SHA 主 CI run 44721357999 的 70 个 job 第 1 次运行 68 个通过，未重跑；红的是 design/ 的链
  接检查——GitHub 对 RFC-371 文档（`design/RFC-371-run-observability/native-real-validation-20261007.md`）里一条既有的提交链接答 503，外部原
  因，`CI required` 只因它红。
- `9afd1539d`（门的补正，父提交是 `bf0eb6971`）：主 CI run 44723998058 的 70 个 job 第 1 次运行 68 个通过，未重跑；红的 backend 分片
  20/44 是 `rfc363-task-preparation-admission` 的 SQLite 一条（Git 补偿）撞它自带的 60 秒——补正只改架构门用例、guard-manifest 与文档，同一份
  生产代码在 `bf0eb6971` 上全部 backend 分片通过，属 runner 时限；`CI required` 只因它红。
- 本 RFC 的落档提交 `e095916d2`（只改文档）：主 CI run 44717193463 的 70 个 job 第 1 次运行 68 个通过，红的同样是 design/ 链接检查的外部
  503 与随之红的 `CI required`；未重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。查出负对照少了真值条件一条（已补并复验，见上文），其余逐项核对未发现问题，结论 PASS：

- **检测**：D1 的四类回落位置与“构造”的判定逐条对照负对照：每种写法只认出那一个被调用者；字面量、已有对象、惰性函数与真值条件不判；组合层以
  外的文件（application、名叫 `composition.ts` 的 infrastructure 文件、bootstrap）不判。
- **判定**：按文件逐条比，同名多处各算一条；清单外与陈旧两向都报；登记的文件存在、是组合文件、按序排列，每个文件的条目按序排列；类别封闭；适
  配器回落 83 条，有回落的模块与门里指定的后继逐个相等。
- **确定性**：检测结果与判定输出都排序、逐文件比较，不依赖语料遍历的次序（Linux 上目录次序随文件系统）；路径一律用正斜杠。
- **账本**：guard-manifest 登记新用例（`assertsAbsence: true`，“不存在”写成 `toEqual([])` 的字面形态，带负对照）；`counts.json` 不变；生产代
  码不变。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`test(architecture): RFC-521 组合层适配器回落的全模块门与清单（RFC-294 S12 第二步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
