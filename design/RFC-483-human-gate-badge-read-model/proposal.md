# RFC-483 评审与澄清徽标的联合投影归 collaboration 读模型：task-execution 的三个 SQL 条件片段撤出 public（RFC-294 S9 第五步）

- **状态**：In Progress（2026-11-11）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（偏离与取舍见 design §7，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径
  限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S9 第 2 项（类型污染清单里的 SQL 条件片段
  `nodeRunStatusCondition`、`taskGateOpenCondition`、`taskGateVisibleCondition`）与第 4 项（collaboration 不再把 task-execution 的 SQL 片段拼进
  自己的查询，牵动的用例按 D14 迁入 application），task-execution ↔ collaboration 这一对的第五步，也是这一对的最后一步。
- **前序**：[RFC-480](../RFC-480-te-collaboration-public-unconsumed-sweep/proposal.md)、[RFC-481](../RFC-481-te-owned-human-gate-ports/proposal.md)、
  [RFC-482](../RFC-482-te-participant-bindings-small-families/proposal.md)、[RFC-485](../RFC-485-te-row-query-bindings/proposal.md)（均 Done）。
  RFC-481 落档时已写明：这三个片段服务的待评审 / 待澄清计数由 RFC-359 AC-11 压成单条语句，往返数由双引擎用例钉住，换成业务查询不能退回
  多次往返，需要单独设计——本 RFC 就是那份设计。

## 1. 背景

1. **三个 SQL 条件片段经 public 流出**：task-execution 的 `public/queries` 交出 `nodeRunStatusCondition`、`taskGateOpenCondition`、
   `taskGateVisibleCondition`，签名带 `PersistenceDb` 与 drizzle 的 `SQL` / `AnyColumn`（`PUBLIC_SURFACE_DEBT` 的 8 条）。RFC-294 design §3.2
   把「返回 drizzle `SQL` / 列条件、供调用方拼进自己查询的函数」列为不属于合同的构件。
2. **使用点只有两条徽标计数**（HEAD `1fa9be87c`，源码实读）：collaboration 的 `countPendingReviews`（评审徽标，`review.ts`）与
   `countAwaitingClarifyRounds`（澄清徽标，`clarifyRounds.ts`），共 7 处；模块外没有其他使用方。壳层每 15 秒、每个打开的标签页各轮询一次。
3. **它们必须是单条语句**：RFC-359 AC-11 把这两条计数从「先捞列表、再问可见性、在 JS 里计数」的三段式压成一条语句（PostgreSQL 上每段
   是一次真实往返，实测差值约等于往返次数 × RTT），往返数由 `rfc359-w56-badge-round-trip-budget`、`rfc359-w57-clarify-badge-round-trip-budget`
   双引擎钉住（恒发一条语句），数字由 `rfc311-badge-counts` 对拍。改成返回 DTO 的业务查询就要退回多次往返。
4. **联合投影是真实需要**：计数的行（评审版本、澄清轮次、评审指派）归 collaboration，过滤条件（任务未终结、任务对查看者可见、评审节点
   在等评审）归 task-execution。RFC-294 design §3.3 的持久化 schema 条写明：跨 context 不 import 对方的表做 join，需要联合投影时由读模型
   adapter 明确拥有。可见性判据此前刻意与 task-execution 的 `visibleTaskIds` 共用同一段代码，两条路不会漂。

## 2. 目标

- **G1 片段撤出 public**：task-execution 的 `public/queries` 不再导出这三个片段，改由 composition 转出；`PUBLIC_SURFACE_DEBT` 销 8 条，
  collaboration 消费的 task-execution 类型污染清零。
- **G2 联合投影由 collaboration 的徽标读模型明确拥有**：两条计数仍是各自的一条语句，属于 collaboration infrastructure 的徽标读模型；它需要的
  三个 task 范围谓词由 task-execution 实现，经 consumer 自有的装配期绑定（RFC-400 的 `TaskExecutionParticipantBindings`）交入，不再经 public。
  collaboration 不引用 task-execution 的表，task-execution 也不引用 collaboration 的表。
- **G3 用例的规则判定迁入 application（D14）**：「哪些查看者看全部任务的人工门、其余人按任务成员（评审另加节点指派）计」这条判定移到
  collaboration 的 application；读模型端口只收 DTO 形态的查看者。路由操作经 application 的两个徽标用例计数。
- **G4 锁与账本**：新增 RFC-483 用例；减速带收紧到实测。

## 3. 非目标

- 其他 context 对的片段与类型污染：integration 取 task-execution 的 `nonTerminalTaskExists`、resource-catalog 交出的 `workflowNameExpression`
  等（S9 后续）。
- 列表查询（`listReviewSummaries`、`listClarifyRoundSummaries`）：它们已经经 task-execution 的业务查询读可见性，不拼片段。
- 计数的 SQL、语义、往返数与索引；schema；评审 / 提问用例的整体归位（RFC-294 review §9 待用户决定）。

## 4. 用户可见变化

无。两个徽标的数字、轮询端点与错误码不变。

## 5. 验收标准

- **AC-1**：task-execution 的 public 文件不导出三个片段；collaboration 的生产文件不从 task-execution 的任何入口取它们；徽标读模型经绑定取得，
  bootstrap 的绑定取自 task-execution 的 composition。
- **AC-2**：查看者判定在 collaboration 的 application，读模型端口只有 DTO 形态的签名；两个路由操作经 application 的徽标用例计数。
- **AC-3**：`public-surface-deviations` 65 → 57（task-execution 与 collaboration 两个模块的 public 上 19 → 11，余下 11 条的消费方都在其他
  context）并收紧到实测；跨 context 内部文件对、越 DAG 的 offered 文件对与表归属账本不变。
- **AC-4**：两条徽标仍各发一条语句（w56、w57 不改判据）、`rfc311-badge-counts` 对拍通过；受影响用例全部通过；推送后 exact SHA 的
  GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
