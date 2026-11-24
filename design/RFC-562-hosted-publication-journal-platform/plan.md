# RFC-562 实施计划

依赖：RFC-561。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-562-T1**：发布日志（合同与实现）迁入 platform/content，新增恢复归一用的闭合释放操作；system-operations、五个 owner context 与 bootstrap 改从
  平台取（design §1）。
- **RFC-562-T2**：恢复归一参与者改为 system-operations 的 required 端口；task-execution 经指定 adapter 取类型、经装配根交出实现；目标 DAG 与 design 的
  Mermaid 同批登记。
- **RFC-562-T3 门与用例**：DAG 外边、表归属、public 类型偏差三处的精确清单与减速带随之更新；按路径登记的两处与 15 个用例的 import 随迁；新增
  RFC-562 的边界用例（登记 guard-manifest）与行为用例。
- **RFC-562-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；读已提交源码的用例在候选导出里跑；选用例；架构报告对照；变异验证。
- **RFC-562-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 业务模块取 system-operations 的只剩 task-execution 的指定 adapter；发布日志的合同与实现在 platform/content，旧位置不存在
- [x] AC-2 行为不变；恢复归一释放遗留发布的闭合操作有用例覆盖
- [x] AC-3 DAG 外 offered 边 26 → 11、表归属债 120 → 117、public 类型偏差 59 → 56；清单、减速带与目标 DAG / Mermaid 随之更新；新增 RFC-562 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准（新增的行为用例走两种数据库的夹具，PostgreSQL 一半在 CI 上跑）。
用例在主树里跑（工作树里只有本 RFC 的改动，共享 index 为空）；读已提交源码的用例、架构报告与变异在候选导出仓库里跑（HEAD `7e5b37e36` 加本 RFC 的
路径，用本地提交固化，核对与工作树逐字相同），对照是同一 HEAD 的另一份导出。

- **本人缺陷一处（已修复并复验）**：新增行为用例的夹具写了两个同时在构建的备份，而 `hosted_database_backups` 只允许一个（构建中的备份独占
  `active_slot`，表上有形状约束与唯一约束），插入就被拒。改成快照里只有一个在构建的备份、且它不是恢复来源（来源自己的行由恢复归一写入）；修完
  3 / 3。生产代码没有因集中验证改动。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 60 个 TS 文件（35 个生产文件、25 个用例与架构文件）无告警，
  生产文件另过 promises 配置；prettier：改动的代码、表归属夹具与三件套通过（RFC-294 design 只按精确替换加一行）。
- **选择与语义层**（SQLite；60 秒；主树 5 个 worker）：按 RFC-533 的口径与 RFC-550 的选法选出 1184 个（语义层 614、经夹具与测试助手补 570——改动
  碰到了 task-execution 的装配根与 public，被大量用例与助手引用）。首轮 1182 个通过，2 个红：上面那处夹具缺陷，以及
  `rfc167-dynamic-workflow-engine` 的 `settleTask` 在 5 秒结算期限处到点——与 `docs/audit-backlog.md` 记过的三次同形，本机仍有一台虚拟机占着约三个半核，
  同文件单独再跑 3 次都通过（29 / 29），记为第四次；本 RFC 不碰动态工作流。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221；RFC-562 的边界用例 8 / 8 与行为用例
  3 / 3、`rfc294-review-offered-edge-dag` 8 / 8、`rfc317-guard-corpus-floor` 24 / 24、`rfc317-table-ownership` 19 / 19、`rfc294-architecture-preflight`
  15 / 15、`rfc294-design-parity` 4 / 4。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：十种变异都被认出。边界七种各自让 RFC-562 的边界用例红——owner 适配重新取 system-operations
  的 public（`rfc376-structural-guards` 与 `rfc294-review-offered-edge-dag` 同红）、平台里的日志取了某个模块（`rfc376-structural-guards` 的 platform → modules
  同红）、system-operations 的 public 重新转出日志合同（未消费计数同红）、恢复归一实现绕过指定 adapter（跨 context 内部文件对同红）、task-execution 的
  public 重新交出恢复归一实现（`rfc294-architecture-preflight` 与 `rfc376-structural-guards` 同红）、恢复归一又去直接读发布表（`rfc317-table-ownership`
  同红）、目标 DAG 删去这条边（`rfc294-design-parity` 同红）。行为三种各自让行为用例红——闭合操作连已释放的行也动、不清封存的源（撞表上的形状
  约束）、恢复归一什么都不释放。
- **架构报告**（候选与对照各出一份）：`off-dag-offered-file-context-pairs` 26 → 11；`public-surface-deviations` 59 → 56（正好是销去的三条，没有换名留下
  的）；public 面 1010 → 1000（system-operations 九个、task-execution 一个）；`targetEdges` 110 → 111；跨 context import 7554 → 7550；生产文件数不变（三个
  文件搬家）；未消费的 public 符号仍为 0；其余门与计数不变。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- `b3850ff9a`（实现，父提交是 `7e5b37e36`）：exact SHA 主 CI run 45401036761 70 / 70 通过；同一提交触发的 windows-platform（run 45401037131）
  通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **日志原样搬家**：合同与 812 行实现逐字迁入 platform/content，只改了文件头注释与一处相对 import；装配仍由 system-operations 的
  `composeCrewStationObjectPublications` 完成，备份释放水位照旧由它实现并注入，bootstrap 的两个调用点与交给各 owner 的 `publications` 对象不变。
- **闭合释放操作等价于原来那段代码**：同一张表、同样的 SET 字段与 WHERE 条件（owner、pending / ready、`(owner, key)` 的发布 id），空列表时不发语句
  （原来是 `if (abandoned.length > 0)`）；调用点传的是同一个 owner 与同一批备份 id。新增用例覆盖了点名范围、状态过滤、清封存源与经恢复归一的整条
  路径。
- **恢复归一参与者只换了声明处与取法**：接口一字未动；task-execution 的实现从 adapter 取类型，bootstrap 从它的装配根取同一个工厂；
  `composeCrewStationRestoreNormalization()` 返回的仍是同一个参与者。
- **14 个 owner 文件只换了类型的出处**：全部是 `import type`。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交；RFC-561 的转 Done（CI 已全绿）同批。走私有 index、按路径
清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
