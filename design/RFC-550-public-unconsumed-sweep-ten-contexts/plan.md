# RFC-550 实施计划

依赖：RFC-549。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-550-T1 撤出**：按 design §1 的规则逐 context 撤出，挪进内部的按 §2 落位；迭代复采到十个 context 为 0。
- **RFC-550-T2 门与用例**：`architecture/counts.json` 的上限随之降低；逐名清单 fixture；新增 RFC-550 用例并登记 guard-manifest；随改经 public
  取这些名字的用例。
- **RFC-550-T3 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径、被改名字的字符串形态、读被改源码的测试助手、子进程夹具与两跳的
  测试助手与 `tests/fixtures/` 里的摘要锁选用例；红的与 HEAD 同时 A/B；架构报告对照（含公开面）；变异验证。
- **RFC-550-T4 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S9 第六步。

## 验收清单

- [x] AC-1 十个 context 的未消费 public 符号为 0；撤出的名字不再从它们的 public 导出
- [x] AC-2 行为不变
- [x] AC-3 减速带上限随之降低；新增 RFC-550 用例并登记；读旧位置的用例随改
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机 Docker 仍未起（本地没有 PostgreSQL）：本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。用例在主树里跑（工作树里
只有本 RFC 的改动，共享 index 为空）；架构报告与变异在候选导出仓库里跑（HEAD `fe1db6768` 加本 RFC 的路径，核对与工作树逐字相同），对照是同一
HEAD 的另一份导出。集中验证查出一类本人缺陷（四条源码锁没有随改），已改并复验。

- **撤出的实际结果**（以 `85c36f1c0` 的导出为基准，逐名清单进 `tests/fixtures/rfc550-withdrawn-public-symbols.json`）：十个 context 的 public 少了
  118 个名字——普查的 71 个，加上三轮“撤出 → 复采 → 再撤”连锁变成未消费的 47 个（只被已挪走的声明的签名引用：code-capability 的查询结果形状、
  event-center 的投递与审计文档、integration 的受保护启动守卫、resource-catalog 的探测记录与资源包的逐类变更、system-operations 的恢复状态查询与
  取消暂存命令等）。其中 83 个按内容挪进模块内部、4 个是 domain 已有声明的复本而删去（`StageGraph` 一族）、4 个只有用例在用或谁都不用而删除、27 个转出删掉；三个 public 文件撤空后整个删除（code-capability
  `public/queries`、event-center `public/commands` 与 `public/queries`）。
- **落位与 design §2 不同的几处**（按实际依赖与使用方核对）：
  - code-capability：`StageGraph` 一族在 public 里是 `domain/stageGraph.ts` 的复本、只有一个用例拿两者比对，删去复本（用例只留 domain 那份）；
    `CodeRepairAction` 是 domain 的修复表返回的形状，落在 `domain/repairActions.ts`（落在 application 会让 domain 取 application），查询端口从
    domain 取它；`public/queries` 的“为什么查询带修复动作”说明随端口挪进 `application/ports/codeQueries.ts`；commons 内核清单的
    `code-capability-public-queries` 改指这个文件（沿用 RFC-375 / RFC-468 的做法，id 不变）。
  - digital-employee：`WORKSPACE_FAILURE_CLASSES` 只有一个用例在用，删去常量，`WorkspaceFailureClass` 改成同样三个成员的闭合联合，用例自带
    穷尽清单（`satisfies` 加穷尽检查）；没有使用方的 `EmployeeCaseProjectionInvalidated` 删除。
  - resource-catalog：两个技能迁移回执谁都不用，删除；`preparedPackageMutation` 一族连同逐类的变更与已准备类型、它们共用的品牌常量一起进
    `application/package/preparedMutations.ts`；探测端口与它们带的度量、记录、写入形状进已有的 `application/mcps/ports.ts`。
  - system-operations：两个描述工厂与它们和旧 HTTP 别名共用的操作 id 表进 `application/operationDescriptors.ts`；描述合同
    （`SystemOperationDescriptors`、`DatabaseMigrationOperationDescriptors`）、维护盘操作端口与别名表仍声明在 `public/operations`（别名表从
    application 取 id 表）。十个 zod 合同连同只有它们用的三个私有子 schema 进 `application/systemOperationContracts.ts`，public 的 DTO 类型照旧
    由它们推导（type-only import）。命令 / 查询端口进 `application/systemOperationPorts.ts`。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 109 个 TS 文件（78 个生产文件、31 个用例与测试助手）
  无告警，生产文件另过 promises 配置；prettier：改动的代码、三个 architecture 清单、OS 架构清单与三件套通过。改写 import 的脚本在删去整条 import
  的地方留下的空行（35 个文件）已清掉。
- **选择**：按 RFC-533 的口径从 2,993 个用例文件里选出语义层 534 个：改动的 26 个用例、全部 `tests/architecture/`（142 个）、在 import 之外以
  路径点名被改文件的 224 个、点名被撤出名字的 76 个、直接导入被改文件的 218 个、经 8 个读被改源码的测试助手的 154 个（层间有重叠）；另按
  `docs/dev-gotchas.md`（RFC-527 那条）补经子进程夹具与测试助手 import 到达运行期有变化的 33 个生产文件（值的挪动与值 import 的改写）的 240 个，
  合计 774 个；复跑时再加读 guard-manifest / commons-manifest / counts.json / OS 架构清单的 13 个，合计 787 个。`tests/fixtures/` 里没有钉被改
  文件的摘要锁。
- **语义层**（SQLite；60 秒；主树 5 个 worker）：首轮 774 个文件里 770 个通过。红的四个都是**本人遗漏**——源码锁钉着被挪走的东西：
  `rfc310-digital-employee-os-architecture`（OS 架构清单的 event-center public 文件清单与两条外部边）、`rfc346-system-operations-contracts`
  （恢复状态查询的签名改在 `application/systemOperationPorts.ts`）、`rfc448`（探测记录只剩一个 import 目标）、`rfc509`（组合根改从 application
  取操作类型）；已随改。复跑（最终的树，787 个文件）786 个通过：`rfc167-dynamic-workflow-engine` 的一例在 `settleTask` 的 5 秒结算期限处
  到点（任务仍是 running）。复跑期间本会话同时跑 tsc、eslint 与两份架构报告，1 分钟负载 19～24（10 核）；首轮同一文件通过，两轮之间生产代码
  只差 import 块里清掉的空行，单独再跑 3 次都通过（29 / 29）。记为本会话的负载造成的时序到点，与本 RFC 无关。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：八种变异各自让 RFC-550 用例红——public 文件重新转出一个撤出的类型（同时让
  `rfc376-structural-guards` 的计数门红）、把一个撤出的值放回 public 的运行时命名空间、撤空的 public 文件回来、生产文件重新 import 撤空的路径、
  挪走的声明重新声明在 public、删去的声明回来、domain 的修复表取 application、十个 context 之一的减速带上限回到 1。
- **架构报告**（候选与对照各出一份）：十个 context 的未消费 public 符号全部 → 0（全仓 88 → 17，余下的是 identity-access 9、source-control 8）；
  public 面少 118 个（正是撤出的名字）；public 类型偏差 54 → 53（运行时管理的 `JsonObject` 转出是用量计的开放 `JsonObject` 唯一的 public 根）；
  跨上下文 import 清单条数不变（只是起点从 public 文件换到挪入的内部文件）；后端生产文件净多 9 个（新增 12、删除 3）；其余门与计数全部不变。
  减速带随之降低：十个 context 的上限 → 0、source-control 9 → 8、public 类型偏差 54 → 53；`rfc294-architecture-preflight` 的偏差逐条清单、
  `rfc305` 的 identity-access 边清单、`rfc317-module-boundary` 的开放 Record 清单随之改。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **结局不变**：挪动的声明逐字搬（事件引用与观察构造、代码平台事件目录、资源包变更的类别判定、zod 合同、描述工厂与 id 表），使用方只改
  import；新的 public → application 值边，反向都只有 type-only import，运行期没有新的循环。别名表的四个 id 与原先相同（同一张 id 表），
  `server.ts` 登记的别名不变。`WorkspaceFailureClass` 的成员与原常量相同。被删的 `StageGraph` 复本只是类型。
- **没有模块外读者受影响**：撤出的每个名字在 `85c36f1c0` 都没有模块外生产消费方（架构报告），`tsc` 覆盖 backend 的 src、用例与脚本；e2e 与仓根
  脚本没有取这些名字（改写脚本走过这两处，没有改动）。public 的运行时命名空间只少了被撤出的值。
- **删除的声明**：`EmployeeCaseProjectionInvalidated` 与两个技能迁移回执全仓没有使用方；`WORKSPACE_FAILURE_CLASSES` 只有一个用例在用（用例
  改带自己的穷尽清单）；`StageGraph` 一族的 public 那份只是 domain 声明的类型复本。
- **分层**：挪入的声明落在 application / domain，domain 不取 application（`CodeRepairAction` 落在 domain 正是为此）；分层、DAG 与 public 边界的
  守卫照跑通过。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（与 RFC-549 转 Done 同一提交）；实现与验证后再提交
`refactor(backend): RFC-550 十个 context 的未消费 public 符号清零（RFC-294 S9 第六步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
