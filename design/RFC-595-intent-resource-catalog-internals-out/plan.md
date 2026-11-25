# RFC-595 实施计划

依赖：RFC-594。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-595-T1 装配对**：intent 三个装配函数改收入参、resource-catalog 新增本机一族的装配、bootstrap 四处交入（design §0 / §1）。
- **RFC-595-T2 会话对**：intent 的会话端口、引擎改取它（design §0 / §1）。
- **RFC-595-T3 门、用例与文档**：已知清单、`counts.json`、调这三个函数与钉调用参数的用例；新增 RFC-595 用例并登记（design §2）。
- **RFC-595-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-595-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 intent 只经 resource-catalog 的 `public/*` 取它；resource-catalog 的 `composition/intentApply` 在生产代码里只有 bootstrap 取
- [x] AC-2 本机工件一族、维护 worker 的工件内容与两处工件生命周期的构造与原来逐一相同；相关用例通过
- [x] AC-3 `cross-context-internal-file-pairs` 上限 6 → 4；其余计数不升；新增 RFC-595 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 的两格红已归因（见「CI」）

## 集中验证

基于 `7dfc0423e`；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：backend `tsc` 0 错（含 bootstrap 绑定处与 RFC-595 用例里的两条编译期断言）；eslint 与 promises 配置无告警；改动的 TS 与 RFC 文档 prettier
  通过。
- **构造对照**（读码）：本机一族的三件与原来逐一同参——插件属主 `join(appHome, 'plugins')`、技能属主 `{ appHome, db }`、补偿原语无参；工件内容仍以
  `appHome/plugins` 与同一个补偿原语构造；两处工件生命周期的内容定位查询与原来一样建在传给它的同一个库句柄上（守护进程 `db`、维护 worker `client`）。
  补偿原语每次调用都返回一份无状态的冻结对象，由内部调用改为外部调用一次不改变行为。
- **选出的用例**（候选导出）：按改动路径与迁动的名字选出，再加上所有读 intent apply、两个装配文件、两个测试 helper、standalone / 维护 worker / 守护进程
  intent 装配的用例，以及架构报告、结构守卫、DAG、分层、组合层只装配与读 guard-manifest 的全部用例，共 315 个用例文件、3050 条，红 2 条——都是本人
  遗漏：两本账（`rfc294-architecture-preflight` 的跨 context 内部文件对白名单、`rfc355` 的 intent 深取账本）还留着本 RFC 销掉的两行，棘轮按设计报“陈旧”。
  删掉这两行（各留一句销账说明）后复跑这两个与读 guard-manifest 的全部用例（24 个文件）全部通过；`rfc321`（要 git 历史）在主树里 10 / 10；读 STATE /
  RFC 索引 / RFC 文档的用例 46 / 46。另核对了点到会话文件名与 `composeLocalIntentArtifacts` 的全部用例，都在所选之内（两个 helper 经引用它们的用例覆盖）。
- **变异**（候选导出里逐个施加、跑指定用例、复原）：四种都被认出——intent 的装配文件重新自己造内容定位查询（RFC-595 用例与 `rfc376-structural-guards`
  都红）；apply 引擎重新从 resource-catalog 的 infrastructure 取会话类型（同上两处都红）；bootstrap 以外的生产文件取 resource-catalog 的 intent 装配根；
  本机一族的插件属主换了目录。另做一种端口漂移的 typecheck 变异（端口里 `copyOnlyTargets` 的值类型改成 `number`）：候选导出的 `tsc`
  报 21 处错，含守护进程 bootstrap 的绑定处、引擎、RFC-595 用例的编译期断言与 15 个装配会话的用例 / helper。复原后导出无残留。
- **架构报告**（候选对照 `7dfc0423e`）：60 个计数里只有 `cross-context-internal-file-pairs` 变了（6 → 4，余下四对见 design §4）；未消费 public 符号 0；
  public 面 804 不变；public 类型偏差 27 不变。跨 context import 7602 → 7607：去掉 5 条（intent 装配文件取 resource-catalog 装配根的 4 条值级取用、引擎取
  resource-catalog infrastructure 的 1 条类型取用），加上 10 条（bootstrap 四处取 resource-catalog 装配根的构造、intent 端口取 resource-catalog public 的三个类型与
  平台事务类型、两个装配文件各取一个平台类型）——都是 bootstrap 装配、exact public 或 platform 一类的边，不是内部文件对。

## CI（AC-4）

- `6f05a750b`（实现）：主 CI run 45684699951 70 个 job 里 67 个成功。后端第 16/44 片同上（RFC-593 引入的 force-push 扫描误报，已由 `4e03ecce4` 修）。
  macOS Playwright e2e 第 3/4 片到 job 的 20 分钟上限被取消：141 条里已跑完的 139 条全部通过、没有失败，归因环境性（macOS runner 慢，单条 RFC-396
  通知旅程跑了 5.3 分钟）。后继证据：`4e03ecce4`（以本提交为祖先、本提交的内容原样保留）的 run 45685757907 70 / 70 全绿，含 macOS e2e 第 3/4 片与后端
  第 16/44 片。没有改测试、没有重跑。2026-11-25 转 Done。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **构造不变**：本机一族、维护 worker 的工件内容与两处工件生命周期用的是原来的构造与参数（见集中验证的构造对照）；托管一族不动。
2. **会话只改类型**：引擎调用会话的七个方法与传的值一字未改；端口只写这些调用，resource-catalog 的实现不改、在绑定处由编译器核对。
3. **装配位置**：resource-catalog 的东西只在 bootstrap 的四个装配点取；intent 的三个装配函数不再有回落到 resource-catalog 构造的路径（入参都是必填）。
4. **测试 helper 与用例**：两个 helper 与调用方按 bootstrap 的方式交入同样的构造，夹具行为不变；`rfc432` 的同一对象断言换成按会话的行为断言（原用例里
   已有）与 RFC-595 用例对装配的锁。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
