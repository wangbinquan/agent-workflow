# RFC-480 task-execution 与 collaboration 的 public 收口：未消费符号清零与 `public/operations` 退役（RFC-294 S9 第一步）

- **状态**：In Progress（2026-11-10）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审
  功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S9（public 合同收敛）。S9 按 context 对拆成多个
  RFC，先做 task-execution ↔ collaboration；这一对再拆两步：本 RFC 做第 1 项（`public/operations` 收口）在 task-execution 上的部分与第 3 项
  （未消费 public 符号清零）在这两个模块上的部分；第 2、4、5 项（类型污染、collaboration 拼 task-execution 的 SQL 片段、反向越 DAG 类型边）
  由下一步 RFC-481 做。
- **前序**：[RFC-478](../RFC-478-task-service-retirement/proposal.md)（`services/task.ts` 退役，task-execution `public/operations` 的兼容写原子
  失去最后一个模块外使用方）、[RFC-479](../RFC-479-governance-gap-fill/proposal.md)（未消费 public 符号入减速带，上限 = 实测）。

## 1. 背景

1. **未被消费的 public 符号**：减速带实测 322 个，task-execution 181 个、collaboration 24 个，合计 205 个（HEAD `673b1b53b`）。RFC-294 design
   §3 常驻规则 12：没有模块外生产消费方的符号不进 public。这 205 个里 136 个是转出（`export { x } from '../…'`），69 个直接声明在 public
   文件里；118 个没有任何引用方，44 个只被用例经 public 取用，43 个只被**本模块自己**的生产文件经 public 取用（collaboration 17 个文件、
   task-execution 32 个文件）。collaboration 的 `public/commands.ts` / `public/queries.ts` 里有 17 个用例函数（`submitReviewDecision`、
   `dispatchTaskQuestions`、`resolveReviewAccess` 等）直接声明在 public 文件里、只被本模块的 composition / infrastructure 调用——它们是
   collaboration 的内部用例，不是合同。
2. **task-execution `public/operations` 只剩三处模块外使用**：RFC-478 后，它的 31 个导出里 25 个模块外零消费（兼容写原子、所有权写入
   边界、平台输入路径常量等），3 个只被同一文件里其他导出的签名引用（`NodeRunStatusUpdateExtra`、`TaskStatusUpdateExtra`、
   `TerminalWorkspacePruneDecision`），剩下 3 个有模块外使用方：bootstrap 取 `registerTerminalWorkspacePrunePolicy`、integration 取
   `TerminalWorkspacePrunePolicy` 类型、collaboration 的 `review.ts` 取 `assertNodeRunSourceTerminationAdmission`（定义在
   `platform/persistence/nodeRunLifecycleCore.ts`，task-execution 只是转出）。design §3.2 定义 `public/operations` 只放操作描述及其句柄
   合同，task-execution 这份不符合。
3. **总量减速带看不出一个模块的回长**：RFC-479 把未消费符号作为一项总数入带；一个模块多一个、另一个模块少一个，总数不变、门不红。

## 2. 目标

- **G1 两个模块的未消费 public 符号清零**：转出直接撤；直接声明在 public 的按内容（RFC-294 C10）挪进模块内部对应的层，或在没有任何
  使用方时删除；经 public 取用这些符号的本模块文件与用例改取定义处。
- **G2 task-execution `public/operations` 退役**：25 个零消费导出撤出；`assertNodeRunSourceTerminationAdmission` 由 collaboration 直接取平台
  定义处；`TerminalWorkspacePrunePolicy`（integration 实现的 consumer-owned 合同）换到 `public/types`；
  `registerTerminalWorkspacePrunePolicy` 由 task-execution 的 `composition.ts` 交给 bootstrap；文件删除。
- **G3 未消费符号按 context 分项入带**：`unconsumed-public-symbols` 一项拆成每个有 public 面的 context 一项
  `unconsumed-public-symbols-<context>`，task-execution 与 collaboration 两项上限为 0。
- **G4 锁**：新增 RFC-480 用例——`public/operations.ts` 不在、被撤符号不在两个模块的 public 面、挪走的声明在新位置；分项计数由 RFC-479
  的「上限 = 实测」门守住。

## 3. 非目标

- 类型污染（`PUBLIC_SURFACE_DEBT`）里仍有消费方的条目、collaboration 拼接 task-execution 的 SQL 片段（`nodeRunStatusCondition`、
  `taskGateOpenCondition`、`taskGateVisibleCondition`）、task-execution → collaboration 的越 DAG 类型边：RFC-481。
- 其他模块的未消费符号与其他模块的 `public/operations`（identity-access、source-control、knowledge-evolution）：S9 后续 RFC。
- 终态工作区回收策略的进程级注册表改为装配期注入（模块级可变状态）：S12。
- 不改任何行为；不改仍有模块外消费方的 public 符号。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：task-execution 与 collaboration 的未消费 public 符号为 0（架构报告与减速带两处一致）；被撤的符号不再出现在两个模块的 public
  面；直接声明在 public 的那些按内容落到模块内部的层（落位表在 design）。
- **AC-2**：`modules/task-execution/public/operations.ts` 不在、零引用；三处模块外使用改取新位置。
- **AC-3**：减速带的未消费符号按 context 分项、上限 = 实测，两个模块为 0；其余计数按实测变化并收紧（C13）。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **S9 这一对拆两步**：未消费符号与 `public/operations` 是纯收口（没有行为、不碰合同形状），先做能把面缩到「真在用的那些」，下一步
   RFC-481 再处理仍在用的合同（SQL 片段、类型污染、反向边）时目标更清楚。
2. **collaboration 声明在 public 的 17 个用例函数挪进内部，不转成合同**：它们没有模块外消费方，按规则 12 不进 public；按函数体取的依赖定层
   （取 infrastructure 的不能进 application，原样进 infrastructure 并在 design 写明理由），不在本 RFC 里做端口化。
3. **未消费符号按 context 分项**：与 RFC-479 的 composition 控制流按模块分项同一理由——总数会让一个模块的回长被另一个模块的减少抵掉。
4. **`registerTerminalWorkspacePrunePolicy` 的进程级注册表原样保留**，只把入口从 public 挪到 composition：改成装配期注入是 S12 的范围。
