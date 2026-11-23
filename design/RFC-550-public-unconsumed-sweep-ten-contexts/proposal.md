# RFC-550 十个 context 的未消费 public 符号清零（RFC-294 S9 第六步）

- **状态**：In Progress（2026-11-23）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §5，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S9（public 合同收敛）第 3 项“未消费 public 符号
  清零”；design §14“未消费 public 符号 → 0”。
- **前序**：[RFC-480](../RFC-480-te-collaboration-public-unconsumed-sweep/proposal.md)（S9 第一步：task-execution 与 collaboration 清零，本 RFC
  沿用它的撤出规则）。

## 1. 背景

S9 的退出门要求未消费 public 符号为 0。HEAD `85c36f1c0` 的架构报告还列 88 个、分布在 12 个 context。本 RFC 处理其中 10 个 context 的
71 个：system-operations 17、digital-employee 13、resource-catalog 12、integration 8、development-automation 6、code-capability 5、
event-center 4、memory 3、execution-contract 2、runtime-management 1。identity-access（9）与 source-control（8）的大多是凭据与身份面的
端口，另立后继。

这些符号没有任何别的模块在生产代码里取用，也不被别的 public 符号的签名引用：有的只是转出、谁都不用；有的是本模块自己的端口或用例，
却放在 public 面上，于是本模块的文件与用例都经 public 取它。

## 2. 目标

- **G1 撤出**：按 RFC-480 的规则逐个处理——转出的删掉转出、使用方改取定义处；直接声明在 public、谁都不用的删除；直接声明在 public、只有
  本模块或用例在用的按内容挪进模块内部对应的层，使用方改取新位置。撤出会让别的 public 符号变成未消费，按“撤出 → 复采 → 再撤”迭代到 0。
- **G2 结局不变**：只挪位置与改 import，不改行为。
- **G3 门与用例**：十个 context 的未消费计数减速带上限降到 0，source-control 的上限按 RFC-548 之后的实测降到 8；新增 RFC-550 用例（撤出的
  名字不再从这十个 context 的 public 导出、十个 context 的未消费计数为 0），逐名清单进 fixture。

## 3. 非目标

- identity-access 与 source-control 的未消费符号（另立后继）；public 类型污染清单与跨 context 内部文件对（S9 的其他项）。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：十个 context 的未消费 public 符号为 0；撤出的名字不再从它们的 public 导出。
- **AC-2**：行为不变（只挪位置、改 import）。
- **AC-3**：减速带上限随之降低；新增 RFC-550 用例并登记 guard-manifest；读旧位置的用例随改。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
