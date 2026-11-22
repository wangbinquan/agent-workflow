# RFC-531 实施计划

依赖：RFC-530。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-531-T1 语义选择类型**：runtime-management 的 `RuntimeManagementAssembly`、bootstrap 的 `RuntimeManagementSelection`、task-execution 端口里的
  System Agent 运行族选择类型、resource-catalog 的 `McpDiagnosticsSelection`、source-control `composition/deploymentSelections.ts` 的 4 个选择类型；
  `DeploymentSelections` 的 7 个槽位与 `HostProbeInput.log` 改用它们；托管工厂与 daemon 的 `mcpRuntimeTests` 随改（design D1）。
- **RFC-531-T2 镜像与镜像刷新**：`repositoryRemote` 换成 `repositoryMirrors` 与 `repositoryMirrorRefresh`；两个 profile 给出各自的实现；daemon 的
  HTTP 装配与子仓刷新句柄删去 `null` 分支；`DEPLOYMENT_SELECTION_KEYS` 随改（design D2）。
- **RFC-531-T3 用例与锁**：新增 RFC-531 用例并登记 guard-manifest；钉住旧形状的锁随改（design D3）。
- **RFC-531-T4 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、读被改文件源码的用例、直接导入被改文件与被改文件在 `src/` 里的调用方的
  用例与全部 `tests/architecture/`，与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-531-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 6 项的一半与第 1 项余项的镜像、子仓刷新两处达成。

## 验收清单

- [x] AC-1 合同里没有 `typeof` 定型的槽位；托管工厂与 daemon 装配不按本地工厂签名定型
- [x] AC-2 `repositoryRemote` 换成必填的镜像与镜像刷新；daemon 不再按 `null` 选；两种 profile 的镜像与刷新与此前相同
- [x] AC-3 计数不升；锁随改；新增 RFC-531 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；1 分钟负载约 30～146，其他会话的容器与本机三个挂起的 mock 进程常驻）。验证在候选导出仓库里跑（`998ecb1b3`
加本 RFC 的路径，最后一轮基于只多了文档提交的 `da7f0e1a5`，核对与工作树逐字相同）；对照导出仓库与 `998ecb1b3` 的树相同。集中验证查出本人
两处缺陷，都在锁里、修正并复验：

- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 33 个 TS 文件无告警，改动的 23 个生产文件另过
  promises 配置；prettier：改动的 TS、guard-manifest 与本 RFC 的三件套通过。
- **首批**（60 秒；候选 5 个 worker）：454 个文件——改动的用例、全部 142 个 `tests/architecture/`、读被改文件源码的用例（按路径主干与被改名字）
  与直接导入被改文件及其在 `src/` 里调用方的用例。红的 9 个：
  - 本人缺陷①：`rfc394-deployment-profile` 的两处键数（62 → 63）没随改，改后见下文。
  - `rfc321` 只因导出仓库没有真实的 git 历史（`merge-base --is-ancestor`），对照里同样红；另 7 个（`rfc238`、`rfc310` 数字员工 system-mock
    e2e、`rfc311-perf-guards`、`rfc359-w6-t26`、`rfc370-plugin-installer-roots`、`rfc384-daemon-intent-bundle`、`rfc376-report`）都是
    PostgreSQL 一支撞时限、断连或死锁，进 A/B。
- **次批**（同样设置）：407 个文件——经 `tests/` 内的 import 传递到被改文件而不在首批里的用例（两批合起来正好是这个传递闭包的全部 605 个
  用例）。红的 18 个（`scheduler-*` 13 个、`tasks`、`lifecycle-property`、`rfc167-dynamic-workflow-engine`、`rfc359-w9`）都是 PostgreSQL 一支
  撞时限，另有 `tasks` 的 `/:id/diff` 两条“repository preparation did not settle”，进 A/B。
- **补批**：只经 `src/` 里的 import 才到被改文件、不在两批里的 5 个用例（CLI、daemon 实时策略、维护 worker 图等）：3 个通过，`cli` 的 daemon
  启动等待与 `rfc389` 的 PostgreSQL 钩子撞时限，进 A/B。
- **A/B**（与对照同时跑、两边 worker 数相同）：两批的 25 个文件各 4 个 worker，跑完 22 个时本会话中断，余下 3 个与补批的 2 个另跑一轮（各
  2 个 worker）。22 个里 21 个两边结果相同、1 个候选通过而对照红；用例级的红两边都在 PostgreSQL 一支撞时限（候选 277 过 / 48 红，对照
  283 过 / 44 红，具体撞时限的用例各有出入），SQLite 一支只有 `tasks` 的 `/:id/diff` 两条与 `rfc167` 的一条，对照里同名同错。另一轮的 5 个：
  `cli` 与 `rfc389` 两边都过，另 3 个两边失败的用例同名、都撞时限。A/B 的文件都只装配单机会话，下一条的修正只动托管 profile 与用例，结论
  沿用。
- **本人缺陷②**（`rfc394` 改了键数复跑才露出来——同一个 test 前面的键数断言先红，后面的从没执行过）：RFC-432 要求托管的会话工厂每次交出
  同一个对象，而托管的镜像按调用它的会话的仓库存储构造、镜像刷新的闭包每次新建 Promise。修正：镜像刷新的选择可以直接交出句柄（`await`
  照常），托管交冻结的同一份；镜像单列“两种部署都按会话构造”的一组（`SESSION_BUILT_SELECTIONS`，`rfc431` 的工厂规则照旧覆盖它），`rfc394`
  加一条托管的镜像经调用它的会话的存储读取；`rfc370-v4` 的源码锁、design D2 / D3 随改，`docs/dev-gotchas.md` 记一条教训。修正后在新的
  候选上跑改动涉及的 28 个文件（`rfc394`、`rfc431`、`rfc432`、`rfc433`、`rfc370-v4`、RFC-531 用例、读托管 profile 与选择分组的用例、`cli`、
  `rfc389` 等）全过。
- **架构报告**（候选与对照各出一份）：跨上下文导入 7,522 → 7,531（删 10 加 19，都是 bootstrap 对具名选择类型的类型导入、两个 profile 导入
  镜像与刷新、source-control 的选择类型对 `auth/secretBox` 的类型导入）；各模块符号属主删 3、加 24；生产文件 +4；写入入口清单多两行
  （`runFamilyProviders.ts`、`runtimeManagement.ts`）；计数没有变化。缺陷②修正后的候选重出一份，与修正前逐项相同（只差生成时间与源码提交）。
- **收口文档**：plan、design 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例文件，见提交说明。

## CI（AC-4）

- `ac9ebf7ba`（实现，父提交是 `da7f0e1a5`）：exact SHA 主 CI run 44972624716 的 70 个 job 第 1 次全部通过（含 design/ 的链接检查与
  `CI required`）；同一提交触发的 windows-platform（run 44972624702）与 maintenance-soak-nightly（run 44972624697）通过。未重跑。
- 本 RFC 的落档提交 `da7f0e1a5`（只改文档；同一提交记下 RFC-530 转 Done）：主 CI run 44968990439 的 70 个 job 第 1 次全部通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **7 个槽位只改类型**：单机与托管交出的函数、调用处交入的实参都不变；`tsc` 校验两种实现与每个调用处都满足新的选择类型。随之只改类型的还有
  托管 MCP 诊断与托管 System Agent 运行族工厂的返回类型、daemon 的 `mcpRuntimeTests` 与未启动作用域的 `createMcpRuntimeTests`、运行族输入的改名、
  `DevelopmentWorkspaceRepositoryPreparation` 端口挪到 `application/ports/`、`HostProbeInput.log` 取 `Logger`。
- **单机的镜像与刷新原样**：HTTP 装配此前在远端为 `null` 时调 `composeLocalRepositoryMirrors({ store })`，现在调单机选择交出的同一个函数
  （它只取 `store`）；子仓刷新句柄此前调 `startConfiguredSubmoduleRefreshLoop(store, configuration, 缺省周期, Paths.root, secretBox)`，单机选择
  以同一组实参调它，配置变更监听、停止与排空照旧。
- **托管的镜像原样**：此前 daemon 在远端非空时调 `composeRemoteRepositoryMirrors({ store, remote, secretBox, appHome })`；托管 profile 的闭包以
  同一个远端（托管工作区 `bind()` 交出的那一份，此前经展开进选择）与会话交入的同一组字段调它——每个会话按自己的仓库存储构造一份，与此前
  daemon 在 HTTP 装配里构造的时机相同（每次装配一次）。
- **托管的子仓刷新**：此前句柄直接返回空的停止与排空；现在调托管选择拿到什么都不做的刷新（冻结的一份，每次交出同一个对象，`await` 一个
  非 Promise 的值照常得到它），并照单机的写法登记配置变更监听（调到的 `reconfigure` 什么都不做、停止时注销），排空前未停止会抛
  `submodule-refresh-drain-before-stop`——生命周期程序总是先停止再排空，单机一支一直如此。用户可见行为没有差别（proposal §4 记了这条内部差别）。
- **选择的转发**：`DEPLOYMENT_SELECTION_KEYS` 删 `repositoryRemote`、加两个新键，会话与应用输入照旧经 `deploymentSelectionsOf` 拿到；
  `submodule-refresh` 句柄两种 profile 照旧都登记，有序作业 id 不变。
- **账本与锁**：选择分组的清单与读它的 `rfc394` / `rfc431` / `rfc433` 随改——镜像刷新进 RFC-432 的会话工厂一组（托管交出同一个对象），镜像
  单列“两种部署都按会话构造”的一组（托管按调用它的会话的仓库存储构造），`rfc394` 加一条托管的镜像经会话的存储读取（`rfc431` 两条以
  `repositoryRemote` 为靶的负对照换靶）；RFC-527 的镜像
  选择锁、`rfc370-v4-repository-mirrors` 与 `rfc370-root-background-bindings` 改钉选择；`rfc422` 与 `rfc489` 随改名与合同的类型改；guard-manifest
  登记新用例，改动过的条目行数按各条原有的计法随改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-530 转 Done）；实现与验证后再提交
`refactor(backend): RFC-531 部署选择合同的槽位改为语义类型、镜像与子仓刷新由 profile 选择（RFC-294 S12 第十二步）`。走私有 index、按路径清单
提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
