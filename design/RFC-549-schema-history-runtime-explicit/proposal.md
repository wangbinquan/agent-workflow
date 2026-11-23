# RFC-549 schema 历史运行时由组合根显式交给 platform（RFC-294 S12 第二十八步）

- **状态**：Done（2026-11-23，落地 `85c36f1c0`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S12（装配余项）第 4 项（模块级可变单例）的第十五步；
  design §3 常驻规则 5、§14“模块级可变单例（生产态，bootstrap 外）0”。
- **前序**：[RFC-545](../RFC-545-live-persistence-schema-explicit/proposal.md)（live 持久化 schema 由组合根显式交给 provider，本 RFC 走同一条路）、
  [RFC-548](../RFC-548-source-control-daemon-state/proposal.md)（第 4 项第十四步）。本 RFC 拆完 RFC-546 “可迁移”一类的最后 2 条。

## 1. 背景

二进制自带的 schema 历史（当前版本的 head、历代版本、PostgreSQL 目录缓存与 epoch-2 元数据表）由 bootstrap 组合，platform 不能 import
bootstrap，于是 bootstrap 在模块求值时调 `registerSchemaHistoryRuntime(...)` 把它写进 platform 的模块级变量
（`platform/persistence/schema/history/runtime.ts` 的 `binding`），platform、system-operations、SQLite 客户端与 daemon 启动的约 30 处再经
`schemaHistoryRuntime()` / `runtimeHistoryAdmission()` 读；SQLite 逻辑源 Worker 在初始化时另登记一份。哪条路径在 bootstrap 求值之前读，
就只能靠 import 顺序碰运气——RFC-540 的 Worker 用例不带历史初始化也能过，靠的正是同一进程里别处已经登记过。用例与 e2e 夹具则靠改写这份
全局登记来模拟“下一个版本”的二进制。架构报告的模块级可变单例清单里这个文件 2 条（全仓 39 条）。

## 2. 目标

- **G1 显式交入**：`RuntimeSchemaBinding`（RFC-545 的 live 绑定）多一项 `history`；删去 platform 的模块级登记与读取函数；读历史的函数都由
  调用方交入——已经收下 live 绑定的取其中的历史，bootstrap 与 SQLite 客户端取 bootstrap 的常量，其余沿调用链多一个参数；Worker 的初始化
  消息必须带元数据表。
- **G2 结局不变**：每处读到的 head、历代版本、目录缓存与元数据表与原先相同；迁移、恢复、备份、逻辑复制与启动准入的行为不变。
- **G3 下一版本的启动仍可演练**：e2e 用“下一个版本”启动真实 daemon 的夹具改用 bootstrap 的一处替换口（组合根之内，design §14 不计；生产
  代码不调用它）。
- **G4 门与用例**：新增 RFC-549 用例（platform 没有模块级状态、删去的名字不在；替换口只有夹具与用例调用；交入的历史决定读到的版本；带负
  对照）；读旧接口的用例改为显式交入；模块级可变单例 39 → 37。

## 3. 非目标

- 历史文件的读取与缓存（`bootstrap/persistenceHead.ts`）、版本计算、准入判定与迁移流程不变。
- RFC-546 的两类（凭据 / 访问 / 完整性相邻、进程级例外）仍待用户确认。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`schema/history/runtime.ts` 没有模块级状态；读历史的函数都由调用方显式交入；Worker 的初始化消息必须带元数据表。
- **AC-2**：各处读到的历史与原先相同，迁移 / 恢复 / 备份 / 逻辑复制 / 启动准入的结局不变。
- **AC-3**：模块级可变单例 39 → 37、计数不升；新增 RFC-549 用例并登记 guard-manifest；读旧接口的用例与 e2e 夹具随改。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
