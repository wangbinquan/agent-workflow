# RFC-539 SQLite 文件快照的在途计数随数据库句柄走（RFC-294 S12 第二十步）

- **状态**：Done（2026-11-22，落地 `bf1ed4716`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S12（装配余项）第 4 项（模块级可变单例）的第七步；
  design §3 常驻规则 5、§14“模块级可变单例（生产态，bootstrap 外）0”。
- **前序**：[RFC-538](../RFC-538-mcp-probe-environment/proposal.md)（S12 第十九步：MCP 探测的选项与时钟随应用走）。

## 1. 背景

SQLite 的整库快照（备份的 `VACUUM INTO`、迁移安全备份的 `VACUUM INTO` 与 `quick_check`）会在库上持有长时间的只读快照；这期间 WAL
checkpoint（`wal_checkpoint(TRUNCATE)`）撞上活跃 reader 会阻塞满 `busy_timeout`，而它跑在 daemon 的同步主连接上，全站冻结。RFC-311 用一个
进程级计数器避开：快照开始时加一、结束时减一，维护服务的 checkpoint 时钟在计数非零时跳过这一拍（`platform/persistence/sqlite/
systemProviderBackup.ts` 的模块级 `activeDbSnapshots` 与 `isDbSnapshotInProgress()`）。计数与被快照的是哪个库无关：同一进程里两份会话的快照
互相挡对方的 checkpoint。架构报告的模块级可变单例清单里这一文件 1 条（全仓 55 条）。

## 2. 目标

- **G1 计数随数据库句柄走**：每个数据库句柄的会话上下文带一份文件快照的在途计数（客户端、事务与原生会话共用）；备份按它快照的库计数，
  daemon 会话把自己库的那一份交给迁移安全备份与维护服务的 checkpoint 门。
- **G2 结局不变**：快照期间 checkpoint 照旧跳过、快照结束后照旧执行；worker 起不来时的同线程回退、校验失败的报错与此前相同。
- **G3 门与用例**：新增 RFC-539 用例（运行时文件没有模块级状态；会话把自己库的计数交给两处；两个库的快照互不挡对方的 checkpoint；带负对照）；
  读旧形状的用例随改；模块级可变单例清单 55 → 54。

## 3. 非目标

- 其余 54 条模块级可变单例。
- 快照、校验与 checkpoint 本身的做法（worker、回退、`busy_timeout`）不变；PostgreSQL 一侧没有文件快照，照旧恒为“无在途”。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`systemProviderBackup.ts` 没有模块级计数；在途计数挂在数据库句柄的上下文上，daemon 会话把自己库的那一份交给迁移安全备份与维护服务。
- **AC-2**：快照期间 checkpoint 跳过、结束后执行；两个库的快照互不挡对方；worker 回退与校验失败的结局不变。
- **AC-3**：模块级可变单例清单 55 → 54，计数不升；钉住旧形状的锁随改，新增 RFC-539 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
