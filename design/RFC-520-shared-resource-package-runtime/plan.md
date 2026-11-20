# RFC-520 实施计划

依赖：RFC-519（S10 关闭）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-520-T1 授权登记归 application**：新增 `resource-catalog/application/participants/resourceAuthorityRegistry.ts`（design D1）。
- **RFC-520-T2 模块工厂**：`postgresqlResourcePackageCatalog.ts` 新增 `composeResourcePackageRuntime`（design D2）。
- **RFC-520-T3 bootstrap 共用**：`commandBootstraps.ts` 与 `daemonHttpComposition.ts` 改调新工厂（design D3）。
- **RFC-520-T4 锁与用例**：`rfc349-postgresql-resource-package-bootstrap` 改钉新位置；新增 RFC-520 用例并登记 guard-manifest（design
  D4、§4）。
- **RFC-520-T5 集中验证**：backend `tsc`、eslint、prettier；直接取改动文件的用例、资源包命令 / 路由 / apply 的用例与全部
  `tests/architecture/`，按 CI 的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-520-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 两处 bootstrap 改调 `composeResourcePackageRuntime`、不再调四个资源包工厂
- [x] AC-2 catalog、原子 apply 与授权解析的行为和此前一致
- [x] AC-3 授权登记落 application、组合层只装配；public surface 与计数不升
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；1 分钟负载大多在 28～35，主要是本机其他进程）。验证在候选导出仓库里跑，核对与工作树逐字相同；对照导出仓库与
HEAD（`6de9f6302`）的树相同。集中验证查出本 RFC 的缺陷都已修正并复验：

- **查出的缺陷**：①首批里两条钉旧装配原文的锁漏改：`rfc271-cli` 断言包命令根里有
  `composePostgresqlResourcePackageCatalog({`，`rfc370-storage-and-worker-root-bindings` 按名字找 daemon 里
  `composePostgresqlResourcePackageProvider` 的那次调用再核对工件属主；两条改钉 `composeResourcePackageRuntime`，核对的属主与断言不变。设计
  时按被删的调用全仓搜过，但命中清单被 `head` 截断、18 个文件只看了 6 个（design §1、D4 与 §5 已改准，`docs/dev-gotchas.md` 补一
  条）。②guard-manifest 里本 RFC 用例的 `assertsAbsence` 写成了 true：RFC-317 T14 按字面形态认“断言不存在”，本用例的断言都是与非空清单相等，
  改为 false。③本 RFC 用例比较 `foreign-resource-package-authority` 出处清单时依赖语料遍历的次序（遍历不排序，Linux 上随文件系统），改为排序
  后比较；“登记是这条错误唯一的出处”的说法改准：变更会话自己的行为人核对也抛同一个错误（既有代码，不动）。④design §4 写了“交给执行适配器的就
  是交出的原子 apply”，用例里没有：补上模块工厂各工厂实参的钉住，另补一条用桩依赖装两次模块工厂、经 provider 的变更会话工厂核对登记的行为用
  例；比较实参时去掉换行与尾逗号。
- **静态**：backend `tsc` 退出码 0、无输出（修正后重跑）；eslint `--max-warnings 0`：4 个生产文件（另过 promises 配置）与 4 个改动的用例无告
  警（开发期自查时删去了复制来的、本用例用不到的辅助函数与一处不再用到的 `Actor` 类型 import）；prettier：改动的 TS 与本 RFC 的三件套通过。
- **首批**（候选 1 = `6de9f6302` 的树加本 RFC 的 7 个代码路径；按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 3 个
  worker；与对照同时、同样跑法）：234 个文件。其中 `tests/architecture/` 全部 141 个，另 93 个：按 4 个资源包工厂、两处 bootstrap 文件与装配
  函数、错误串、包命令与资源包路由扫出的用例，`rfc294-architecture-preflight` 与本 RFC 用例。
  - 两边都跑完：候选 2,491 条通过、36 条红，对照 2,497 条通过、27 条红。逐文件比失败名，候选多出的红是上面 ①～③ 的 4 个文件，加上
    `rfc395-session-table-imports`、`rfc425-execution-authority-deployment`、`rfc271-roundtrip` 与
    `rfc359-w15-workgroup-row-values-conformance` 的 PostgreSQL 一半撞 5 秒、`rfc401-atomic-apply-lease` 的续租一条在负载下丢了租约
    （`cas-lost:lease`）；两边都红的是默认 5 秒、`rfc376-report` 自带的 300 秒、preflight 自带 60 秒与 180 秒的两条，以及 4 个 RFC-395 用例
    PostgreSQL 一半的 90 秒钩子。
- **复验**（候选 2 = 修正 ①～③ 后的 9 个代码路径；默认时限放宽到 60 秒、与对照同时，各 3 个 worker）：首批里任一边有红的 22 个文件。候选
  233 条通过、9 条红，对照 232 条通过、7 条红（对照没有本 RFC 用例）。①～③ 修正后全过（本 RFC 用例 3 / 3、`rfc317-guard-negative-fixture`
  17 / 17、`rfc271-cli` 10 / 10、`rfc370-storage-and-worker-root-bindings` 10 / 10）；`rfc401` 28 / 28，两个守卫、往返与工作组用例两边全过。
  两边都红的是 `rfc359-w5-composition-root-route-surface` 的 PostgreSQL 钩子、`rfc376-report` 自带的 300 秒、preflight 自带 180 秒的一条与
  4 个 RFC-395 用例 PostgreSQL 一半的 90 秒钩子；候选另红 preflight 自带 60 秒的一条（首批两边都红，本机两边都跑不进，交给 CI）与
  `rfc395-v2-integration-restart` SQLite 一半自带 35 秒的一条——这条单独再跑一次，候选 21 秒通过、对照 35.5 秒超时，属两边都会出现的时限。
- **补充批**（候选 2 / 3，两者生产代码相同；CI 的跑法、4 个 worker，只跑候选一边，红的再与对照同时复验）：133 个文件——首批没扫到的遍历
  `bootstrap/` 的用例、RFC-294 各步遍历语料的守卫（`rfc35x`～`rfc519`）、两个读 `resourceCatalogModules` 的 daemon 用例与按组合文件名扫出的
  用例。候选 1,479 条通过、39 条红（20 个文件），都是时限（默认 5 秒，自带的 20 / 30 / 90 / 120 / 300 秒，PostgreSQL 的 90 秒钩子），另有
  `rfc321-repository-publication-ratchet` 的一条：它核对账本记下的提交是 HEAD 的祖先，导出仓库的历史是合成的、没有那个提交（主仓库里是祖
  先）。这 20 个文件放宽到 60 秒、与对照同时复验：候选 268 条通过、17 条红，对照 273 条通过、15 条红；13 个文件两边全过，余下的红两边都有
  （`rfc321` 同一条，RFC-395 / RFC-398 的 PostgreSQL 钩子与自带时限），只有 `rfc370-evidence-artifact-root-bindings` 候选多红两条自带 20 秒
  的——单独再跑一次，两边 9 / 9 全过、耗时相近。
- **④ 的复验**（候选 3 = 修正 ④ 后的 9 个代码路径；CI 的跑法，2 个 worker）：24 个文件 234 条全过：本 RFC 用例 5 / 5，读 guard-manifest 的
  21 个用例（不含 preflight）与 W5-T19d 的两个账本用例，其中 `rfc317-guard-negative-fixture` 17 / 17、`rfc359-w5-t19d-coverage-parity`
  8 / 8。
- **架构报告**（`scripts/architecture-report.ts`，候选 2 与对照各出一份；候选 3 只改用例）：60 项实测与对照逐项相同（status 只差来源与时
  间）；生产文件 4,142 → 4,143（新的登记文件）；跨 context import 7,517 → 7,512：两处 bootstrap 对四个资源包工厂的 8 条取用合成 2 条
  `composeResourcePackageRuntime`，登记文件新增 1 条对 `@/auth` 的类型 import；模块符号归属 32,474 → 32,479（登记文件 2 个、组合文件
  3 个）；mutation 入口 2,388 → 2,389：登记的 `register`（授权表的写入由 bootstrap 移进 application，这份清单只盘点模块）；public
  surface、required ports 与 facade 不变。
- **旧位置全仓扫描**（工作树；全部包、`e2e`、`scripts`、`architecture/`、`design/`、`docs/` 与 `STATE.md`，按词边界）：删去的
  `actorsByAuthority` / `packageActorsByAuthority` 只剩登记文件里同名的局部变量与本 RFC 的 design；新名字只出现在新位置、两处 bootstrap、改
  钉的三条锁、本 RFC 用例、本 RFC 的三件套、RFC 索引与 `STATE.md` 里（`registerAuthority` 另是 identity-access `operationContext.ts` 里既有
  的、无关的同名方法）。
- **收口文档**：plan、design 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例，全过（33 / 33）。

## CI（AC-4）

- 【待补：实现提交】
- 本 RFC 的落档提交 `6de9f6302`（只改文档）：主 CI run 44699102929 的 70 个 job 第 1 次运行 68 个通过；红的是 design/ 的链接检查——GitHub 对
  RFC-371 文档（`design/RFC-371-run-observability/native-real-validation-20261007.md`，`6825e230c` 加入）里一条既有的提交链接答 503，外部原
  因、不是本 RFC 的文件，`CI required` 只因它红；未重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **同一张图**：`composeResourcePackageRuntime` 依次装 provider、原子 apply 与 catalog（执行适配器取同一个原子 apply），与 HEAD daemon 侧的
  次序相同；CLI 侧此前在执行适配器的入参里新建原子 apply，几个工厂都只存入参、构造时不做 effect，次序差别不影响行为。两处传给 provider 的入
  参与 HEAD 逐项相同（CLI：本机 MCP 事务生命周期、能力模板变更属主、本机插件安装器；daemon：模块的 MCP 事务生命周期、能力模板变更属主、部署
  选择的技能 / 插件工件属主与技能内容读取器），多出的 `box` 由原子 apply 与执行适配器使用（随展开也进了 provider 的入参，provider 不读它）。
- **授权登记**：解析逻辑与 HEAD 两处逐字相同（参数类型写成端口类型 `ResourceRequestContext`，与 CLI 侧 HEAD 推导出的类型同一）；每次装配一张
  弱引用表；CLI 仍在交出命令 / 查询上下文时登记本地行为人，daemon 仍在 `commandContextFor` 交出 HTTP 命令上下文时登记。错误类型与错误串不
  变。
- **交出的对象**：`composePackageCommandBootstrap` 返回的 `{ identity, catalog, shutdown }` 与 `composeResourcePackageBinding` 返回的
  `{ applyActivity, catalog, commandContextFor }` 形状不变，`applyActivity` 仍是 catalog 所用的同一个原子 apply。
- **账本与锁**：三条钉旧装配原文的锁改钉新工厂（核对的属主与断言不变）；guard-manifest 登记新用例；`counts.json` 不变。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-520 资源包装配共用一个模块工厂（RFC-294 S12 第一步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
