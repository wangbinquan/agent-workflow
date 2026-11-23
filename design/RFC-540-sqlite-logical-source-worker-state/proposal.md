# RFC-540 SQLite 逻辑源 Worker 的状态归每个 Worker 的处理器（RFC-294 S12 第二十一步）

- **状态**：Done（2026-11-22，落地 `2f685c9e4`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S12（装配余项）第 4 项（模块级可变单例）的第八步；
  design §3 常驻规则 5、§14“模块级可变单例（生产态，bootstrap 外）0”。
- **前序**：[RFC-539](../RFC-539-database-file-snapshots/proposal.md)（S12 第二十步：SQLite 文件快照的在途计数随数据库句柄走）。

## 1. 背景

数据库迁移从 SQLite 读出源数据时，完整性扫描、逐表计数与分块读取都在一个专用 Worker 里跑（`platform/persistence/sqliteLogicalSourceWorker.ts`，
单二进制的显式入口之一），不占 daemon 处理请求的事件循环。Worker 收 `init` / `metadata` / `preflight` / `assert-unchanged` / `read-chunk` /
`close` 六种请求，打开的逻辑源、校验过的 schema 契约与“正在初始化”的标志放在三个模块级 `let` 里。每个 Worker 线程各加载一份模块，所以运行时
不会串；但请求处理与这三份状态绑在入口模块上，只能起一个真 Worker 才测得到。架构报告的模块级可变单例清单里这一文件 3 条（全仓 54 条）。

## 2. 目标

- **G1 状态归处理器**：请求处理搬进 `createSqliteLogicalSourceWorkerHandler(io)`，三份状态放在它的闭包里；Worker 入口只建一个处理器、把
  `onmessage` 交给它，回传与关闭经交进来的 `io`。
- **G2 结局不变**：六种请求的校验、回传的事件、错误码与消息截断、重复初始化与未初始化的拒绝、关闭后的状态与此前逐字相同。
- **G3 门与用例**：新增 RFC-540 用例（入口与处理器文件没有模块级状态；入口只建一个处理器；两个处理器互不相通；带负对照）；读旧形状的锁
  随改；模块级可变单例清单 54 → 51。

## 3. 非目标

- 其余 51 条模块级可变单例（Worker 初始化时登记 schema 历史运行时的那一处属平台持久化的 schema 绑定，另立）。
- Worker 的协议、监工（`sqliteLogicalSourceWorkerSupervisor.ts`）与单二进制的入口清单不变。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：Worker 入口与处理器文件没有模块级状态；入口只建一个处理器并把 `onmessage` 交给它。
- **AC-2**：六种请求的结局不变；两个处理器各自初始化、互不相通。
- **AC-3**：模块级可变单例清单 54 → 51，计数不升；钉住旧形状的锁随改，新增 RFC-540 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
