# RFC-532 实施计划

依赖：RFC-531。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-532-T1 安装选择**：system-operations `composition/daemonDatabaseInstallation.ts`（`DaemonDatabaseInstallation`、本机与按端口的两个组合函数，
  只装配）与 `application/epochBootAdmission.ts`（本机 epoch 路径的判断原样搬入，effect 交入）；`composition/daemonDatabase.ts` 导出准备输入与结果的类型（design D1 / D2）。
- **RFC-532-T2 合同、profile 与 daemon**：合同的槽位必填；单机交本机安装（交入 `runAutoUpgradeChild`），托管交按端口的安装；`daemonStart.ts`
  调 `admit` / `prepare`，删去两处 `null` 判断与对应导入（design D2 / D3）。
- **RFC-532-T3 用例与锁**：新增 RFC-532 用例并登记 guard-manifest；选择分组与钉住旧形状的锁随改（design D4）。
- **RFC-532-T4 集中验证**：backend `tsc`、eslint、prettier；改动文件的用例、读被改文件源码的用例（按路径主干与被移走的名字）、直接导入被改文件与
  其在 `src/` 里调用方的用例与全部 `tests/architecture/`，红的与 HEAD 同时 A/B；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-532-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 1 项在 daemon 侧的余项收完。

## 验收清单

- [x] AC-1 `databaseInstallation` 必填、类型是 `DaemonDatabaseInstallation`；两个 profile 各给一份
- [x] AC-2 daemon 不按 `null` 分支、不取本机 epoch 路径；两种 profile 的启动行为与此前相同
- [x] AC-3 计数不升；锁随改；新增 RFC-532 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；1 分钟负载约 30～40）。验证在候选导出仓库里跑（HEAD `ac9ebf7ba` 加本 RFC 的路径，核对与工作树逐字相同；其后只多了
只改文档的 `2b8f8dfad`）；对照导出仓库与 `ac9ebf7ba` 的树相同。集中验证查出本人五处缺陷，都在锁里，修正并复验：

- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 17 个 TS 文件无告警，改动的 7 个生产文件另过
  promises 配置；prettier：改动的 TS、guard-manifest 与本 RFC 的三件套通过。开发期的静态自查查出准备输入的配置读取类型窄了
  （`read()` 可同步返回），已放宽。
- **首批**（60 秒；候选 5 个 worker）：239 个文件——改动的用例、全部 `tests/architecture/`、读被改文件源码的用例（按路径主干与被移走的
  名字）、直接导入被改文件及其在 `src/` 里调用方的用例、经 `tests/` 内的 import 传递到被改测试助手的用例。红的 14 个：
  - 本人缺陷四处：① 本机 epoch 路径原样搬进了组合文件——`composition-control-flow-system-operations` 2 → 11、`rfc515`（组合层不许 `throw`）与
    `rfc521`（组合层回落位置的 `??`）红；判断改进 system-operations 的 application（`admitLocalEpochInstallation`，读事实、升级子进程、重读
    配置、待定恢复与升级日志器作 effect 交入），组合文件只装配。② `rfc359-w5-t19f` 的单引擎账本：RFC-532 用例里造 epoch-1 安装的那一处
    `new Database(` 开的是磁盘上的真库，按 `real-file-database` 登记。③ `rfc431` 的“新加一个可选选择”负对照以合同的最后一个成员为锚点，
    新槽位挪到 `executionAuthority` 之前。④ `rfc213-dev-startup-root-inverse` 按缩进逐字认 daemon 启动程序里准备调用的开发叠加片段，链式的
    `.prepare(...).catch(...)` 被 prettier 多缩进两格；准备与拒绝处理拆成两句（拒绝处理仍在同一个同步片段里挂上）。
  - 另 8 个与对照（`ac9ebf7ba`）同时 A/B（各 2 个 worker）：`rfc359-w5-composition-root-route-surface` 两边都过；其余 7 个两边失败的用例同名
    （`rfc370-mission-input-capture-roots` 对照多红一条）——`rfc321-repository-publication-ratchet` 只因导出仓库没有真实的 git 历史，
    `rfc370-m3-hosted-database-restore`、`rfc370-evidence-artifact-root-bindings`、`rfc400`、`rfc370-committed-architecture-source` 与
    `rfc376-report` 都是 PostgreSQL 一支或整文件撞时限。
- **修正后**（候选 3 个 worker）：其余 231 个文件里红的 2 个——`rfc370-plugin-installer-roots` 的 PostgreSQL 一支撞时限（RFC-531 的 A/B 里对照
  同样红）；本人缺陷⑤ `rfc395-v3-dormancy`：用例放进了 `application/epochSwitch/`，那是只给 CLI 的 V3 迁移面，daemon 不得够到——挪到
  `application/epochBootAdmission.ts`。再按路径敏感的范围复跑 171 个文件（全部 `tests/architecture/`、扫语料与读被改文件的用例、`rfc395-af1`、
  RFC-532 用例与启动序列用例）：红的 3 个都在上面的 A/B 里、与对照同名。
- **架构报告**（候选与对照各出一份）：计数没有变化（`composition-control-flow-system-operations` 仍是 2，两条只差行号）；跨上下文导入
  7,531 → 7,530（daemon 启动程序对 epoch 路径与准备的 6 条导入删去；两个 profile 导入两种安装、组合与 application 的新文件取 epoch 路径与准备）；
  生产文件 +2；各模块符号属主随新文件增减；写入入口清单多一行（`application/epochBootAdmission.ts`）。
- **收口文档**：plan、design 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例文件，见提交说明。

## CI（AC-4）

- `6a911ae34`（实现，父提交是 `2b8f8dfad`）：exact SHA 主 CI run 44980855435 的 70 个 job 第 1 次全部通过（含 design/ 的链接检查与
  `CI required`）；同一提交触发的 windows-platform（run 44980855404）与 maintenance-soak-nightly（run 44980855452）通过。未重跑。
- 本 RFC 的落档提交 `2b8f8dfad`（只改文档；同一提交记下 RFC-531 转 Done）：主 CI run 44975481866 的 70 个 job 第 1 次全部通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **启动顺序不变**：`admit` 在原位置被调（探测宿主之后、打开密钥箱与令牌之前），其后照旧重读配置；准备在原位置，实参（配置端口与
  本机文件的那组字段）逐字不变，损坏指引与 schema 漂移指引的 `.catch` 原样；`prepare(...)` 与 `.catch` 拆成两句后，拒绝处理在同一个同步
  片段里挂上，没有未处理拒绝的窗口。
- **单机的本机 epoch 路径原样**：判断（读事实、升级触发、`refuse` 抛出、起升级子进程后重读配置与事实、未升到 epoch-2 或仍有未收尾的会话则
  抛出、最近一次完成的会话有回执时以 `epoch-upgrade` 日志器记回执与限制、指引非空则抛出、最后应用待定恢复）逐行搬进 application（`application/epochBootAdmission.ts`）；读事实取
  `readEpochBootFactsForConfig({ appHome, database })`，单机 profile 交入的 `appHome` 就是此前的 `Paths.root`；升级子进程就是此前 daemon 调的
  `runAutoUpgradeChild`；待定恢复照旧是 `applyLocalEpoch2PendingRestore(logicalSchemaContract)`；日志器照旧只在有回执时创建。准备走 `kind: 'file'`，
  与此前 `null` 时相同。
- **托管原样**：此前 `databaseInstallation` 非空时跳过本机 epoch 路径、准备走 `kind: 'selected'` 并交出这份安装端口；现在 `admit` 什么都不做、
  `prepare` 以同一份端口（`system.databaseInstallation`）走 `kind: 'selected'`。
- **选择与会话**：单机在 `standaloneSelections` 里构造本机安装（只建闭包，不碰磁盘，锁前构造无副作用）；会话输入照旧展开全部选择，会话里没有
  读取它的地方。CLI 的迁移命令不读部署选择，不受影响。
- **账本与锁**：选择分组里安装从可空一组移到必填一组，读它的 `rfc394` / `rfc431` / `rfc433` 随改（`rfc431` 以它为靶的负对照换靶
  `crewStationEvents`）；钉 daemon 启动程序文本的 `rfc524`、`rfc395-af1`、`rfc130`、`rfc370-startup-lease-root-wiring` 改钉新的落位；
  `rfc359-w5-t19f` 的单引擎账本登记 RFC-532 用例里那一处真文件库（epoch-1 安装就是磁盘上的 `db.sqlite`）；guard-manifest 登记新用例，改动过的
  条目行数随改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-531 转 Done）；实现与验证后再提交
`refactor(backend): RFC-532 数据库安装由部署选择给出（RFC-294 S12 第十三步）`。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff /
push。推送后按 exact SHA 跟 CI。
